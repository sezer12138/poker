import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFileStorage, decryptBox, encryptBox, loadOrCreateKey} from '../src/storage/file.ts';
import {assertPersistedRoom, assertSession} from '../src/storage/storage.ts';
import type {PersistedRoom, Session} from '../src/storage/storage.ts';

function makeRoom(id: string, overrides: Partial<PersistedRoom> = {}): PersistedRoom {
  return {
    v: 1,
    id,
    code: 'K7M2QD',
    invite: `invite-${id}`,
    name: '好友局',
    version: 2,
    status: 'waiting',
    hostId: 'u-host-4f2a91',
    members: [{userId: 'u-host-4f2a91', name: '房主', seat: 0, bot: false, ready: false, joinedAt: 1}],
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

function makeSession(name: string, createdAt = 100): Session {
  return {userId: `u-${name}`, name, createdAt, lastSeen: createdAt + 5};
}

describe('文件存储', () => {
  let dir: string;
  const key = randomBytes(32);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'poker-storage-'));
    await createFileStorage({dir, key}).init();
  });
  after(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  const storage = () => createFileStorage({dir, key});

  it('房间快照往返一致，落盘的不是明文', async () => {
    const room = makeRoom('room-roundtrip');
    await storage().saveRoom(room);
    assert.deepEqual(await storage().loadRoom(room.id), room);

    const raw = await readFile(join(dir, 'rooms', `${room.id}.json`), 'utf8');
    const envelope = JSON.parse(raw) as {v: number; box: string};
    assert.equal(envelope.v, 1);
    assert.equal(typeof envelope.box, 'string');
    // 密文是随机的：两个字符的针（例如「u1」）在 base64 里约每 4096 个位置就会偶然撞上
    // 一次，那不是泄漏、只是概率。所以这里只查足够长、不可能偶然出现的明文串。
    for (const secret of ['好友局', '房主', 'K7M2QD', 'u-host-4f2a91', room.id, `invite-${room.id}`]) {
      assert.equal(raw.includes(secret), false, `磁盘上不能出现「${secret}」明文`);
    }
    assert.deepEqual(JSON.parse(decryptBox(key, envelope.box)), room, '用密钥才能读出原样快照');
  });

  it('密钥不对就打不开', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const room = makeRoom('room-key');
    await storage().saveRoom(room);

    const other = createFileStorage({dir, key: randomBytes(32)});
    assert.equal(await other.loadRoom(room.id), null);
    assert.ok(logged.mock.callCount() >= 1, '打不开这件事必须留下日志');
  });

  it('被篡改的密文不会拖垮服务', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const room = makeRoom('room-tamper');
    await storage().saveRoom(room);

    const path = join(dir, 'rooms', `${room.id}.json`);
    const envelope = JSON.parse(await readFile(path, 'utf8')) as {v: number; box: string};
    const bytes = Buffer.from(envelope.box, 'base64');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    await writeFile(path, JSON.stringify({v: 1, box: bytes.toString('base64')}));

    assert.equal(await storage().loadRoom(room.id), null);
    assert.ok(logged.mock.callCount() >= 1);
  });

  it('形状不对的快照一律拒绝', async (t) => {
    t.mock.method(console, 'error', () => {});
    const cases: [string, unknown][] = [
      ['不是对象', 'nope'],
      ['版本不对', {...makeRoom('x'), v: 2}],
      ['缺字段', (() => {
        const {code: _code, ...rest} = makeRoom('x');
        return rest;
      })()],
      ['版本号非法', {...makeRoom('x'), version: 1.5}],
      ['状态非法', {...makeRoom('x'), status: 'paused'}],
      ['成员不是数组', {...makeRoom('x'), members: {}}],
      ['截止时间非法', {...makeRoom('x'), deadlines: null}],
    ];
    for (const [label, value] of cases) {
      assert.throws(() => assertPersistedRoom(value), /[^\s]/, label);
    }

    // A well-encrypted but invalid payload is skipped, not thrown at the caller.
    const path = join(dir, 'rooms', 'room-shape.json');
    await writeFile(path, JSON.stringify({v: 1, box: encryptBox(key, JSON.stringify({hello: 'world'}))}));
    assert.equal(await storage().loadRoom('room-shape'), null);

    // And a file that is not even an encrypted envelope.
    await writeFile(path, 'not json at all');
    assert.equal(await storage().loadRoom('room-shape'), null);
  });

  it('损坏的房间只影响自己，其他房间照常启动', async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    await storage().saveRoom(makeRoom('room-good-1'));
    await storage().saveRoom(makeRoom('room-broken'));
    await storage().saveRoom(makeRoom('room-good-2'));
    await writeFile(join(dir, 'rooms', 'room-broken.json'), '{"v":1,"box":"AAAA"}');

    const ids = (await storage().loadRooms()).map(room => room.id);
    assert.deepEqual(ids.includes('room-broken'), false, '坏快照不能被载入');
    assert.equal(ids.includes('room-good-1'), true);
    assert.equal(ids.includes('room-good-2'), true);
    assert.ok(logged.mock.callCount() >= 1, '跳过的房间要留下日志');
  });

  it('列表来自目录扫描，索引丢了也找得到房间', async () => {
    await storage().saveRoom(makeRoom('room-scan'));
    // Written by an older process with no index file at all: the scan still sees it.
    assert.deepEqual(await readdir(join(dir, 'rooms')).then(entries => entries.includes('room-scan.json')), true);
    const found = (await storage().loadRooms()).find(room => room.id === 'room-scan');
    assert.ok(found !== undefined);
    assert.deepEqual(found, makeRoom('room-scan'));
  });

  it('删除不存在的房间不报错', async () => {
    await storage().deleteRoom('room-never-existed');
    await storage().saveRoom(makeRoom('room-delete'));
    await storage().deleteRoom('room-delete');
    assert.equal(await storage().loadRoom('room-delete'), null);
    await storage().deleteRoom('room-delete');
  });

  it('写入是原子的：不留临时文件，覆盖写不会读到半截', async () => {
    const first = makeRoom('room-atomic', {version: 1, name: '第一版'});
    const second = makeRoom('room-atomic', {version: 2, name: '第二版'});
    await storage().saveRoom(first);
    const mid = await storage().loadRoom('room-atomic');
    assert.deepEqual(mid, first);

    await Promise.all([storage().saveRoom(second), storage().saveRoom(second)]);
    assert.deepEqual(await storage().loadRoom('room-atomic'), second);

    const leftover = (await readdir(join(dir, 'rooms'))).filter(entry => entry.endsWith('.tmp'));
    assert.deepEqual(leftover, [], '原子写不应留下 .tmp');
  });

  it('会话表往返，坏条目被跳过', async () => {
    const sessions = {tok1: makeSession('甲'), tok2: makeSession('乙')};
    await storage().saveSessions(sessions);
    assert.deepEqual(await storage().loadSessions(), sessions);

    // One good entry, one that is not a session: the good one still loads.
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({v: 1, box: encryptBox(key, JSON.stringify({tok1: makeSession('甲'), tok2: {userId: 1}}))}),
    );
    assert.deepEqual(await storage().loadSessions(), {tok1: makeSession('甲')});
  });

  it('会话表缺失或损坏时按空表启动', async (t) => {
    t.mock.method(console, 'error', () => {});
    const fresh = join(dir, 'fresh');
    await createFileStorage({dir: fresh, key}).init();
    assert.deepEqual(await createFileStorage({dir: fresh, key}).loadSessions(), {});

    await writeFile(join(fresh, 'sessions.json'), 'garbage');
    assert.deepEqual(await createFileStorage({dir: fresh, key}).loadSessions(), {});
  });

  it('会话记录形状不对的会被挑出来', () => {
    assert.deepEqual(assertSession({userId: 'u', name: 'n', createdAt: 1, lastSeen: 2}), {
      userId: 'u',
      name: 'n',
      createdAt: 1,
      lastSeen: 2,
    });
    assert.throws(() => assertSession({userId: 'u'}), /缺少用户/);
    assert.throws(() => assertSession({userId: 'u', name: 'n', createdAt: 'x', lastSeen: 2}), /时间非法/);
    assert.throws(() => assertSession(null), /必须是对象/);
  });
});

describe('存储密钥', () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'poker-key-'));
  });
  after(async () => {
    await rm(dir, {recursive: true, force: true});
  });

  it('首次运行自动生成，再次运行复用同一把', async () => {
    const path = join(dir, 'dev.key');
    const first = await loadOrCreateKey(path, null);
    assert.equal(first.length, 32);
    const written = (await readFile(path, 'utf8')).trim();
    assert.match(written, /^[0-9a-f]{64}$/);
    assert.equal(written, first.toString('hex'));

    const second = await loadOrCreateKey(path, null);
    assert.deepEqual(second, first);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, '密钥文件只能自己读写');
  });

  it('显式密钥优先，格式不对就拒绝', async () => {
    const explicit = 'ab'.repeat(32);
    const key = await loadOrCreateKey(join(dir, 'unused.key'), explicit);
    assert.equal(key.toString('hex'), explicit);
    assert.equal(await stat(join(dir, 'unused.key')).then(() => true).catch(() => false), false, '不落盘');

    await assert.rejects(loadOrCreateKey(join(dir, 'unused.key'), '短'), /64 位十六进制/);
    await assert.rejects(loadOrCreateKey(join(dir, 'unused.key'), 'zz'.repeat(32)), /64 位十六进制/);
  });

  it('密钥文件内容不对时明确报错', async () => {
    const path = join(dir, 'bad.key');
    await mkdir(dir, {recursive: true});
    await writeFile(path, 'not-a-key\n');
    await assert.rejects(loadOrCreateKey(path, null), /不是 64 位十六进制密钥/);
  });

  it('加密盒：同一明文两次加密不同，篡改一律失败', () => {
    const key = randomBytes(32);
    const first = encryptBox(key, '房间状态');
    const second = encryptBox(key, '房间状态');
    assert.notEqual(first, second, '每次都要换随机 iv');
    assert.equal(decryptBox(key, first), '房间状态');
    assert.equal(decryptBox(key, second), '房间状态');

    const tampered = Buffer.from(first, 'base64');
    tampered[20] = tampered[20]! ^ 0xff;
    assert.throws(() => decryptBox(key, tampered.toString('base64')));
    assert.throws(() => decryptBox(key, 'AAAA'), /密文长度不足/);
    assert.throws(() => decryptBox(randomBytes(32), first), '换密钥必须失败');
  });
});
