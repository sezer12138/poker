import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ChildProcess} from 'node:child_process';

/**
 * 入口进程的真实启动验收：这两条路径没有别的测试覆盖，
 * 而它们恰好是运维最先看到的东西（起不来时的中文原因、能不能优雅退出）。
 * 端口用 0 让系统分配，避免和本机其它进程抢端口。
 */
const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ENTRY = path.join(ROOT, 'apps/server/src/main.ts');

interface Running {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  exited: Promise<{code: number | null; signal: string | null}>;
  /** 等到 stdout 里出现某行，超时抛错。 */
  waitForText(text: string, budgetMs?: number): Promise<string>;
}

function start(env: Record<string, string>): Running {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {...process.env, POKER_HOST: '127.0.0.1', POKER_PORT: '0', ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = new Promise<{code: number | null; signal: string | null}>(resolve => {
    child.on('exit', (code, signal) => resolve({code, signal}));
  });
  return {
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    exited,
    async waitForText(text, budgetMs = 15000) {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        if (stdout.includes(text)) return stdout;
        if (child.exitCode !== null) throw new Error(`进程已退出（${child.exitCode}）：${stdout}${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`等待「${text}」超时：${stdout}${stderr}`);
    },
  };
}

describe('入口进程', () => {
  it('存储连不上时用中文说明原因并以 1 退出', async () => {
    const proc = start({
      POKER_STORAGE: 'postgres',
      POKER_PG_URL: 'postgres://poker:pw@127.0.0.1:1/poker',
    });
    try {
      const {code} = await proc.exited;
      assert.equal(code, 1, '启动失败必须以非零退出，容器编排才会重启或报警');
      assert.match(proc.stderr, /启动失败：无法初始化存储（postgres）/);
      assert.match(proc.stderr, /请检查 POKER_PG_URL/, '要告诉运维下一步查什么');
      assert.equal(proc.stdout.includes('已启动'), false, '存储没起来就不能说自己启动了');
    } finally {
      proc.child.kill('SIGKILL');
    }
  });

  it('正常启动后健康检查可用，收到 SIGTERM 优雅退出', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'poker-main-'));
    const proc = start({POKER_MODE: 'development', POKER_STORAGE: 'file', POKER_DATA_DIR: dataDir});
    try {
      const banner = await proc.waitForText('已启动');
      const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(banner)?.[1]);
      assert.equal(Number.isInteger(port) && port > 0, true, `日志里应给出真实端口：${banner.trim()}`);

      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      const body: any = await health.json();
      assert.equal(body.ok, true);
      assert.equal(body.mode, 'development');
      assert.equal(body.auth, 'guest');
      assert.equal(body.wechatConfigured, false);

      // 浏览器客户端由同一个进程托管：首页能取到，且页面里没有服务端密钥。
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);

      proc.child.kill('SIGTERM');
      const {code} = await proc.exited;
      assert.equal(code, 0, '优雅退出必须是 0');
      assert.match(proc.stdout, /收到 SIGTERM/);
      assert.equal(/[0-9a-f]{64}/.test(proc.stdout), false, '启动日志里不得出现 64 位十六进制密钥');
    } finally {
      proc.child.kill('SIGKILL');
      await rm(dataDir, {recursive: true, force: true});
    }
  });

  it('生产模式被误设了节奏类变量时会明说忽略，而不是悄悄生效', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'poker-main-'));
    const proc = start({
      POKER_MODE: 'production',
      POKER_STORAGE: 'file',
      POKER_STORAGE_KEY: 'ab'.repeat(32),
      POKER_DATA_DIR: dataDir,
      POKER_SETTLE_MS: '40',
      POKER_BOT_THINK_MS: '10',
    });
    try {
      await proc.waitForText('已启动');
      assert.match(proc.stderr, /生产模式忽略 POKER_SETTLE_MS \/ POKER_BOT_THINK_MS/);
    } finally {
      proc.child.kill('SIGKILL');
      await rm(dataDir, {recursive: true, force: true});
    }
  });
});
