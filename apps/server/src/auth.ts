import {AppError} from './errors.ts';
import {randomHex, uuid} from './ids.ts';
import type {Session, Storage} from './storage/storage.ts';

export interface AuthUser {
  id: string;
  name: string;
}

const MAX_SESSIONS = 10000;
const FLUSH_INTERVAL_MS = 60000;

/** Names are displayed at the table, so control characters and padding are dropped. */
export function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('INVALID_INPUT', '昵称必须是文本');
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 1 || cleaned.length > 16) {
    throw new AppError('INVALID_INPUT', '昵称长度需在 1 到 16 个字符之间');
  }
  return cleaned;
}

export class Auth {
  private sessions: Record<string, Session> = {};
  private storage: Storage;
  private ttlMs: number;
  private now: () => number;
  private lastFlush: number;

  constructor(options: {storage: Storage; ttlMs: number; now?: () => number}) {
    this.storage = options.storage;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.lastFlush = this.now();
  }

  async init(): Promise<void> {
    this.sessions = await this.storage.loadSessions();
    this.prune();
  }

  count(): number {
    return Object.keys(this.sessions).length;
  }

  async create(name: string, userId?: string): Promise<{token: string; user: AuthUser}> {
    const now = this.now();
    const id = userId ?? uuid();
    const session: Session = {userId: id, name, createdAt: now, lastSeen: now};
    const token = randomHex(32);
    this.sessions[token] = session;
    this.prune();
    await this.flush(true);
    return {token, user: {id, name}};
  }

  async resolve(token: string): Promise<AuthUser | null> {
    const session = this.sessions[token];
    if (!session) return null;
    if (this.now() - session.lastSeen > this.ttlMs) {
      delete this.sessions[token];
      await this.flush(true);
      return null;
    }
    session.lastSeen = this.now();
    const name = session.name;
    if (this.now() - this.lastFlush > FLUSH_INTERVAL_MS) await this.flush();
    return {id: session.userId, name};
  }

  /** Writes the session table; throttled unless `force` is set. */
  async flush(force = false): Promise<void> {
    if (!force && this.now() - this.lastFlush <= FLUSH_INTERVAL_MS) return;
    this.lastFlush = this.now();
    try {
      await this.storage.saveSessions(this.sessions);
    } catch (error) {
      console.error('[auth] 会话表保存失败', error);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [token, session] of Object.entries(this.sessions)) {
      if (now - session.lastSeen > this.ttlMs) delete this.sessions[token];
    }
    const entries = Object.entries(this.sessions);
    if (entries.length <= MAX_SESSIONS) return;
    entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [token] of entries.slice(0, entries.length - MAX_SESSIONS)) delete this.sessions[token];
  }
}
