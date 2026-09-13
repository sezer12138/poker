import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPgStorage} from '../src/storage/pg.ts';
import type {Db} from '../src/storage/pg.ts';
import {decryptBox, encryptBox} from '../src/storage/file.ts';
import type {PersistedRoom, Session} from '../src/storage/storage.ts';

interface Query {
  sql: string;
  params: unknown[];
}

/**
 * A stand-in for `pg`'s Pool: it answers the handful of statements the adapter
 * uses and records everything, so the SQL contract is testable without a server.
 */
class FakeDb implements Db {
  calls: Query[] = [];
  rooms = new Map<string, Record<string, unknown>>();
  sessions = new Map<string, Record<string, unknown>>();
  /** Makes the next statement matching the pattern fail, as a database would. */
  failOn: {match: RegExp; error: Error} | null = null;
  closed = false;

  async query(sql: string, params: unknown[]): Promise<{rows: Record<string, unknown>[]; rowCount: number | null}> {
    this.calls.push({sql, params});
    if (this.failOn !== null && this.failOn.match.test(sql)) {
      const {error} = this.failOn;
      this.failOn = null;
      throw error;
    }
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('CREATE')) return {rows: [], rowCount: null};
    if (text.startsWith('SELECT 1')) return {rows: [{'?column?': 1}], rowCount: 1};
    if (text.startsWith('SELECT payload FROM rooms WHERE id=$1')) {
      const row = this.rooms.get(String(params[0]));
      return {rows: row === undefined ? [] : [{payload: row['payload']}], rowCount: row === undefined ? 0 : 1};
    }
    if (text.startsWith('SELECT id, payload FROM rooms')) {
      return {rows: [...this.rooms.entries()].map(([id, row]) => ({id, payload: row['payload']})), rowCount: this.rooms.size};
    }
    if (text.startsWith('UPDATE rooms SET')) {
      const [payload, version, status, matchId, updatedAt, lastActivityAt, id] = params as [
        string,
        number,
        string,
        string | null,
        number,
        number,
        string,
      ];
      const row = this.rooms.get(id);
      const current = row === undefined ? -1 : Number(row['version']);
      if (row === undefined || current >= version) return {rows: [], rowCount: 0};
      this.rooms.set(id, {payload, version, status, match_id: matchId, updated_at: updatedAt, last_activity_at: lastActivityAt});
      return {rows: [], rowCount: 1};
    }
    if (text.startsWith('INSERT INTO rooms')) {
      const [id, code, invite] = params as string[];
      if (this.rooms.has(String(id))) return {rows: [], rowCount: 0};
      this.rooms.set(String(id), {
        code,
        invite,
        version: params[3],
        status: params[4],
        match_id: params[5],
        payload: params[6],
        updated_at: params[7],
        last_activity_at: params[8],
      });
      return {rows: [], rowCount: 1};
    }
    if (text.startsWith('DELETE FROM rooms')) {
      const existed = this.rooms.delete(String(params[0]));
      return {rows: [], rowCount: existed ? 1 : 0};
    }
    if (text === 'DELETE FROM sessions') {
      const size = this.sessions.size;
      this.sessions.clear();
      return {rows: [], rowCount: size};
    }
    if (text.startsWith('DELETE FROM sessions WHERE token NOT IN')) {
      const keep = new Set(params.map(String));
      let removed = 0;
      for (const token of [...this.sessions.keys()]) {
        if (!keep.has(token)) {
          this.sessions.delete(token);
          removed++;
        }
      }
      return {rows: [], rowCount: removed};
    }
    if (text.startsWith('INSERT INTO sessions')) {
      this.sessions.set(String(params[0]), {token: params[0], payload: params[1], updated_at: params[2]});
      return {rows: [], rowCount: 1};
    }
    if (text.startsWith('SELECT token, payload FROM sessions')) {
      return {rows: [...this.sessions.values()], rowCount: this.sessions.size};
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return {rows: [], rowCount: null};
    throw new Error(`假 Db 不认识这条语句：${text}`);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  saved(roomId: string): unknown {
    const row = this.rooms.get(roomId);
    return row === undefined ? null : row['payload'];
  }
}

const key = randomBytes(32);

function makeRoom(id: string, overrides: Partial<PersistedRoom> = {}): PersistedRoom {
  return {
    v: 1,
    id,
    code: 'K7M2QD',
    invite: `invite-${id}`,
    name: '好友局',
    version: 1,
    status: 'waiting',
    hostId: 'u1',
    members: [{userId: 'u1', name: '房主', seat: 0, bot: false, ready: false, joinedAt: 1}],
    matchId: null,
    tournament: null,
    fairnessStage: null,
    fairnessHistory: [],
    events: [],
    seq: 0,
    idempotency: [],
    deadlines: {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null},
    notice: '',
    lastActivityAt: 10,
    createdAt: 1,
    ...overrides,
  };
}

function makeSession(name: string): Session {
  return {userId: `u-${name}`, name, createdAt: 100, lastSeen: 105};
}

describe('Postgres 存储适配', () => {
  it('初始化建表与索引', async () => {
    const db = new FakeDb();
    await createPgStorage({db, key}).init();
    assert.equal(db.calls.length, 3);
    assert.match(db.calls[0]!.sql, /CREATE TABLE IF NOT EXISTS rooms/);
    assert.match(db.calls[0]!.sql, /payload text NOT NULL/, '整个房间快照存在一行里');
    assert.match(db.calls[1]!.sql, /CREATE INDEX IF NOT EXISTS rooms_code_idx/);
    assert.match(db.calls[2]!.sql, /CREATE TABLE IF NOT EXISTS sessions/);
    for (const call of db.calls) assert.deepEqual(call.params, []);
  });

  it('新房间先插入，payload 是加密盒', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key, now: () => 1234});
    const room = makeRoom('room-new');

    await storage.saveRoom(room);

    assert.equal(db.calls.length, 2);
    assert.match(db.calls[0]!.sql, /UPDATE rooms SET payload=\$1/);
    assert.match(db.calls[0]!.sql, /WHERE id=\$7 AND version < \$2/, '版本条件是并发保护的唯一来源');
    assert.match(db.calls[1]!.sql, /INSERT INTO rooms .* ON CONFLICT \(id\) DO NOTHING/);
    assert.equal(db.calls[1]!.params[0], 'room-new');

    const payload = db.saved('room-new');
    assert.equal(typeof payload, 'string');
    assert.equal((payload as string).includes('好友局'), false, '库里不能出现明文');
    assert.deepEqual(JSON.parse(decryptBox(key, payload as string)), room);
  });

  it('版本更新走条件 UPDATE，不写多余的行', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key, now: () => 2000});
    await storage.saveRoom(makeRoom('room-up', {version: 1}));
    db.calls.length = 0;

    const next = makeRoom('room-up', {version: 2, name: '第二版'});
    await storage.saveRoom(next);

    assert.equal(db.calls.length, 1, '更新成功就不需要再插一次');
    assert.match(db.calls[0]!.sql, /WHERE id=\$7 AND version < \$2/);
    assert.deepEqual(db.calls[0]!.params.slice(1, 3), [2, 'waiting']);
    assert.deepEqual(JSON.parse(decryptBox(key, db.saved('room-up') as string)), next);
  });

  it('库里的版本更新时保存被放弃并明确报错', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key});
    await storage.saveRoom(makeRoom('room-conflict', {version: 5}));

    await assert.rejects(
      storage.saveRoom(makeRoom('room-conflict', {version: 3})),
      (error: any) => {
        assert.equal(error.code, 'STORAGE_FAILED');
        assert.match(error.message, /房间状态已被其他进程更新/);
        return true;
      },
    );
    assert.equal(JSON.parse(decryptBox(key, db.saved('room-conflict') as string)).version, 5, '旧写入不能覆盖新状态');
  });

  it('载入会解密并校验，坏行不会拖垮服务', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const db = new FakeDb();
    const storage = createPgStorage({db, key});
    const room = makeRoom('room-load');
    await storage.saveRoom(room);
    assert.deepEqual(await storage.loadRoom('room-load'), room);
    assert.equal(await storage.loadRoom('missing'), null);

    // A row written with another key, and a row that is not a room at all.
    db.rooms.set('room-other-key', {payload: encryptBox(randomBytes(32), JSON.stringify(room))});
    db.rooms.set('room-junk', {payload: encryptBox(key, JSON.stringify({hello: 'world'}))});
    assert.equal(await storage.loadRoom('room-other-key'), null);

    const ids = (await storage.loadRooms()).map(item => item.id);
    assert.deepEqual(ids, ['room-load'], '只留下能读的房间');
    assert.ok(logged.mock.callCount() >= 2);
  });

  it('删除房间不报错', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key});
    await storage.saveRoom(makeRoom('room-del'));
    await storage.deleteRoom('room-del');
    assert.equal(await storage.loadRoom('room-del'), null);
    await storage.deleteRoom('room-del');
  });

  it('会话表在一个事务里按 token 覆盖', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key, now: () => 999});
    const sessions = {tok1: makeSession('甲'), tok2: makeSession('乙')};
    await storage.saveSessions(sessions);

    const sql = db.calls.map(call => call.sql.replace(/\s+/g, ' ').trim());
    assert.equal(sql[0], 'BEGIN');
    assert.match(sql[1]!, /DELETE FROM sessions WHERE token NOT IN \(\$1,\$2\)/);
    assert.deepEqual(db.calls[1]!.params, ['tok1', 'tok2']);
    assert.equal(sql.filter(text => text.startsWith('INSERT INTO sessions')).length, 2);
    assert.equal(sql.at(-1), 'COMMIT');

    assert.deepEqual(await storage.loadSessions(), sessions);

    db.calls.length = 0;
    await storage.saveSessions({});
    const drop = db.calls.map(call => call.sql.replace(/\s+/g, ' ').trim());
    assert.deepEqual(drop, ['BEGIN', 'DELETE FROM sessions', 'COMMIT'], '空表就是清空');
    assert.deepEqual(await storage.loadSessions(), {});
  });

  it('会话表写入失败会回滚并抛出', async () => {
    const db = new FakeDb();
    const storage = createPgStorage({db, key});
    db.failOn = {match: /INSERT INTO sessions/, error: new Error('连接断了')};

    await assert.rejects(storage.saveSessions({tok1: makeSession('甲')}), /连接断了/);
    const sql = db.calls.map(call => call.sql.trim());
    assert.equal(sql.at(-1), 'ROLLBACK');
  });

  it('载入会话会跳过读不出来的记录', async (t) => {
    t.mock.method(console, 'error', () => {});
    const db = new FakeDb();
    const storage = createPgStorage({db, key});
    await storage.saveSessions({tok1: makeSession('甲')});
    db.sessions.set('tok-bad', {token: 'tok-bad', payload: 'not-a-box', updated_at: 1});

    assert.deepEqual(await storage.loadSessions(), {tok1: makeSession('甲')});
  });

  it('关闭时释放连接池', async () => {
    const db = new FakeDb();
    await createPgStorage({db, key}).close();
    assert.equal(db.closed, true);
  });
});
