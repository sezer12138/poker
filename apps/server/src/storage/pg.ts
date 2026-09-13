import {AppError} from '../errors.ts';
import {assertPersistedRoom, assertSession} from './storage.ts';
import type {PersistedRoom, Session, Storage} from './storage.ts';
import {decryptBox, encryptBox} from './file.ts';

/** Minimal surface of `pg`'s Pool that the adapter needs; keeps tests driver-free. */
export interface Db {
  query(sql: string, params: unknown[]): Promise<{rows: Record<string, unknown>[]; rowCount: number | null}>;
  close?(): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
     id text PRIMARY KEY,
     code text NOT NULL,
     invite text NOT NULL,
     version integer NOT NULL,
     status text NOT NULL,
     match_id text,
     payload text NOT NULL,
     updated_at bigint NOT NULL,
     last_activity_at bigint NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS rooms_code_idx ON rooms (code)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token text PRIMARY KEY,
     payload text NOT NULL,
     updated_at bigint NOT NULL
   )`,
];

const ROOM_COLUMNS = `(id, code, invite, version, status, match_id, payload, updated_at, last_activity_at)`;

function toStringColumn(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/**
 * Rooms live one-per-row with the whole snapshot (AES-256-GCM) in `payload`,
 * so a save is a single conditional UPDATE. The version predicate is what stops
 * a second server process from clobbering newer state.
 */
export function createPgStorage(options: {db: Db; key: Buffer; now?: () => number}): Storage {
  const {db, key} = options;
  const now = options.now ?? Date.now;

  async function insertRoom(room: PersistedRoom): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO rooms ${ROOM_COLUMNS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        room.id,
        room.code,
        room.invite,
        room.version,
        room.status,
        room.matchId,
        encryptBox(key, JSON.stringify(room)),
        now(),
        room.lastActivityAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  return {
    async init() {
      for (const statement of SCHEMA) await db.query(statement, []);
    },

    async loadRoom(id) {
      const result = await db.query('SELECT payload FROM rooms WHERE id=$1', [id]);
      const row = result.rows[0];
      if (!row) return null;
      try {
        return assertPersistedRoom(JSON.parse(decryptBox(key, toStringColumn(row['payload']))));
      } catch (error) {
        console.error(`[storage] 房间 ${id} 快照无法解密，已跳过`, error);
        return null;
      }
    },

    async saveRoom(room) {
      const result = await db.query(
        `UPDATE rooms SET payload=$1, version=$2, status=$3, match_id=$4, updated_at=$5, last_activity_at=$6
         WHERE id=$7 AND version < $2`,
        [
          encryptBox(key, JSON.stringify(room)),
          room.version,
          room.status,
          room.matchId,
          now(),
          room.lastActivityAt,
          room.id,
        ],
      );
      if ((result.rowCount ?? 0) > 0) return;
      if (await insertRoom(room)) return;
      throw new AppError('STORAGE_FAILED', '房间状态已被其他进程更新，本次保存已放弃');
    },

    async deleteRoom(id) {
      await db.query('DELETE FROM rooms WHERE id=$1', [id]);
    },

    async loadRooms() {
      const result = await db.query('SELECT id, payload FROM rooms', []);
      const rooms: PersistedRoom[] = [];
      for (const row of result.rows) {
        try {
          rooms.push(assertPersistedRoom(JSON.parse(decryptBox(key, toStringColumn(row['payload'])))));
        } catch (error) {
          console.error(`[storage] 房间 ${toStringColumn(row['id'])} 快照无法载入，已跳过`, error);
        }
      }
      return rooms;
    },

    async loadSessions() {
      const result = await db.query('SELECT token, payload FROM sessions', []);
      const sessions: Record<string, Session> = {};
      for (const row of result.rows) {
        try {
          sessions[toStringColumn(row['token'])] = assertSession(
            JSON.parse(decryptBox(key, toStringColumn(row['payload']))),
          );
        } catch (error) {
          console.error('[storage] 会话记录无法载入，已跳过', error);
        }
      }
      return sessions;
    },

    /** Sessions are namespaced by delete-then-insert inside one transaction. */
    async saveSessions(sessions) {
      const tokens = Object.keys(sessions);
      await db.query('BEGIN', []);
      try {
        if (tokens.length === 0) {
          await db.query('DELETE FROM sessions', []);
        } else {
          await db.query(`DELETE FROM sessions WHERE token NOT IN (${tokens.map((_, i) => `$${i + 1}`).join(',')})`, tokens);
        }
        const stamp = now();
        for (const token of tokens) {
          const session = sessions[token]!;
          await db.query(
            `INSERT INTO sessions (token, payload, updated_at) VALUES ($1,$2,$3)
             ON CONFLICT (token) DO UPDATE SET payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
            [token, encryptBox(key, JSON.stringify(session)), stamp],
          );
        }
        await db.query('COMMIT', []);
      } catch (error) {
        await db.query('ROLLBACK', []);
        throw error;
      }
    },

    async close() {
      await db.close?.();
    },
  };
}
