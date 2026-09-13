import {createPgStorage} from './pg.ts';
import type {Db} from './pg.ts';
import type {Storage} from './storage.ts';

interface PgPool {
  query(sql: string, params: unknown[]): Promise<{rows: Record<string, unknown>[]; rowCount: number | null}>;
  end(): Promise<void>;
}

/**
 * `pg` is the only production dependency and is imported lazily, so development
 * and the whole test suite run with no node_modules at all.
 */
export async function createPgStorageFromUrl(options: {url: string; key: Buffer}): Promise<Storage> {
  let module: Record<string, unknown>;
  try {
    module = (await import('pg')) as unknown as Record<string, unknown>;
  } catch {
    throw new Error('使用 postgres 存储需要安装依赖：npm install pg');
  }
  const exported = (module['default'] ?? module) as {Pool?: new (config: {connectionString: string; max: number}) => PgPool};
  const Pool = exported.Pool;
  if (!Pool) throw new Error('无法从 pg 模块取得 Pool 构造器');

  const pool = new Pool({connectionString: options.url, max: 8});
  const db: Db = {
    async query(sql, params) {
      const result = await pool.query(sql, params);
      return {rows: result.rows, rowCount: result.rowCount};
    },
    close: () => pool.end(),
  };
  await db.query('SELECT 1', []); // Fail fast with a clear message instead of at first command.
  return createPgStorage({db, key: options.key});
}
