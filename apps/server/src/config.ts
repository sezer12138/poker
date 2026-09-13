export const ACTION_TIMEOUT_MS = 30000;
export const CONTRIBUTE_WINDOW_MS = 5000;
export const SETTLE_DELAY_MS = 4000;
export const BOT_THINK_MS = 1000;
export const MAX_MEMBERS = 9;
export const ROOM_IDLE_MS = 30 * 60 * 1000;
export const BODY_LIMIT_BYTES = 64 * 1024;
export const WS_MESSAGE_LIMIT_BYTES = 64 * 1024;
export const EVENTS_VIEW_CAP = 50;
/**
 * How many finished hands a room view carries. The stored history is complete and
 * the audit endpoint discloses all of it; only the live view is trimmed, so that a
 * long match does not make every response (and every cached response) grow.
 */
export const HISTORY_VIEW_CAP = 10;
export const IDEMPOTENCY_CAP = 200;
/**
 * Byte budget for the replay cache. The entry count alone does not bound a room:
 * 200 cached views of a big room would mean a megabyte rewritten on every command.
 */
export const IDEMPOTENCY_MAX_BYTES = 128 * 1024;
export const JOIN_CODE_MAX_FAILURES = 10;
export const JOIN_CODE_WINDOW_MS = 5 * 60 * 1000;
export const WS_SUBSCRIBE_TIMEOUT_MS = 10000;
export const WS_HEARTBEAT_MS = 30000;
export const WS_PONG_TIMEOUT_MS = 60000;
export const DEFAULT_SESSION_TTL_DAYS = 7;

export interface ServerConfig {
  mode: 'development' | 'production';
  host: string;
  port: number;
  dataDir: string;
  storage: 'file' | 'postgres';
  storageKey: string | null;
  pgUrl: string | null;
  wechat: {appId: string; secret: string} | null;
  sessionTtlMs: number;
  /** WebSocket 升级时允许的 Origin；空数组表示不校验（浏览器之外的客户端不会带）。 */
  allowedOrigins: string[];
}

function integer(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

/** Environment is read once at startup; anything missing falls back to a dev default. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  const mode = env['POKER_MODE'] === 'production' ? 'production' : 'development';
  const storage = env['POKER_STORAGE'] === 'postgres' ? 'postgres' : 'file';
  const appId = env['POKER_WECHAT_APPID']?.trim();
  const secret = env['POKER_WECHAT_SECRET']?.trim();
  const days = integer(env['POKER_SESSION_TTL_DAYS'], DEFAULT_SESSION_TTL_DAYS, 'POKER_SESSION_TTL_DAYS');
  return {
    mode,
    host: env['POKER_HOST']?.trim() || '127.0.0.1',
    port: integer(env['POKER_PORT'], 8787, 'POKER_PORT'),
    dataDir: env['POKER_DATA_DIR']?.trim() || 'data',
    storage,
    storageKey: env['POKER_STORAGE_KEY']?.trim() || null,
    pgUrl: env['POKER_PG_URL']?.trim() || null,
    wechat: appId && secret ? {appId, secret} : null,
    sessionTtlMs: days * 24 * 60 * 60 * 1000,
    allowedOrigins: (env['POKER_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(value => value !== ''),
  };
}

/** Production refuses to start half-configured: guests are off, so login must work. */
export function assertConfigUsable(config: ServerConfig): void {
  if (config.mode !== 'production') return;
  if (config.storage === 'postgres' && !config.pgUrl) {
    throw new Error('生产模式使用 postgres 存储时必须设置 POKER_PG_URL');
  }
  if (!config.storageKey) {
    throw new Error('生产模式必须显式设置 POKER_STORAGE_KEY（与数据库分离保管）');
  }
}
