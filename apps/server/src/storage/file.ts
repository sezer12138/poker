import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {mkdir, open, readFile, readdir, rename, unlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {assertPersistedRoom, assertSession} from './storage.ts';
import type {PersistedRoom, Session, Storage} from './storage.ts';

/**
 * Snapshot boxes are AES-256-GCM: `base64(iv(12) || tag(16) || ciphertext)`.
 * The key never lives in the same place as the data in production.
 */
export function encryptBox(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptBox(key: Buffer, box: string): string {
  const raw = Buffer.from(box, 'base64');
  if (raw.length < 29) throw new Error('密文长度不足');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/**
 * tmp + fsync + rename: a reader never observes a half-written snapshot.
 * The scratch name is unique per call, so two writers racing for the same room
 * cannot pull the file out from under each other — the last rename wins.
 */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/**
 * Reads a 64-hex key from `keyPath`, creating one on first run so a fresh
 * checkout starts with zero configuration. Development only — production must
 * pass POKER_STORAGE_KEY explicitly.
 */
export async function loadOrCreateKey(keyPath: string, explicit: string | null): Promise<Buffer> {
  if (explicit) {
    if (!/^[0-9a-fA-F]{64}$/.test(explicit)) throw new Error('POKER_STORAGE_KEY 必须是 64 位十六进制字符串');
    return Buffer.from(explicit, 'hex');
  }
  if (existsSync(keyPath)) {
    const raw = (await readFile(keyPath, 'utf8')).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${keyPath} 内容不是 64 位十六进制密钥`);
    return Buffer.from(raw, 'hex');
  }
  const key = randomBytes(32);
  await mkdir(dirname(keyPath), {recursive: true});
  await writeFile(keyPath, `${key.toString('hex')}\n`, {mode: 0o600});
  return key;
}

export function createFileStorage(options: {dir: string; key: Buffer}): Storage {
  const {dir, key} = options;
  const roomsDir = join(dir, 'rooms');
  const sessionsPath = join(dir, 'sessions.json');
  const pathOf = (id: string) => join(roomsDir, `${id}.json`);

  return {
    async init() {
      await mkdir(roomsDir, {recursive: true});
    },

    async loadRoom(id) {
      try {
        const raw = await readFile(pathOf(id), 'utf8');
        const envelope = JSON.parse(raw) as {v?: unknown; box?: unknown};
        if (envelope.v !== 1 || typeof envelope.box !== 'string') throw new Error('快照信封格式非法');
        return assertPersistedRoom(JSON.parse(decryptBox(key, envelope.box)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        console.error(`[storage] 房间 ${id} 快照无法载入，已跳过`, error);
        return null;
      }
    },

    async saveRoom(room) {
      await writeAtomic(pathOf(room.id), JSON.stringify({v: 1, box: encryptBox(key, JSON.stringify(room))}));
    },

    async deleteRoom(id) {
      try {
        await unlink(pathOf(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    },

    /** Listing is a directory scan, so a lost index can never hide a room. */
    async loadRooms() {
      const entries = await readdir(roomsDir);
      const rooms: PersistedRoom[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const room = await this.loadRoom(entry.slice(0, -'.json'.length));
        if (room) rooms.push(room);
      }
      return rooms;
    },

    async loadSessions() {
      try {
        const raw = await readFile(sessionsPath, 'utf8');
        const envelope = JSON.parse(raw) as {v?: unknown; box?: unknown};
        if (envelope.v !== 1 || typeof envelope.box !== 'string') throw new Error('会话信封格式非法');
        const parsed = JSON.parse(decryptBox(key, envelope.box)) as Record<string, unknown>;
        const sessions: Record<string, Session> = {};
        for (const [token, value] of Object.entries(parsed)) {
          try {
            sessions[token] = assertSession(value);
          } catch (error) {
            console.error('[storage] 会话记录不合法，已跳过', error);
          }
        }
        return sessions;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        console.error('[storage] 会话表无法载入，已按空表启动', error);
        return {};
      }
    },

    async saveSessions(sessions) {
      await writeAtomic(sessionsPath, JSON.stringify({v: 1, box: encryptBox(key, JSON.stringify(sessions))}));
    },

    async close() {
      // Nothing held open: every write is already durable when it resolves.
    },
  };
}
