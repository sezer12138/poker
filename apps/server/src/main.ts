import {createApp, createStorage} from './app.ts';
import {assertConfigUsable, loadConfig} from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  assertConfigUsable(config);
  // 存储建不起来（例如数据库连不上、密钥写不进去）时给一句中文原因再退出：
  // 运维看到的是「数据库连不上」，而不是一段英文堆栈。
  const storage = await createStorage(config).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[server] 启动失败：无法初始化存储（${config.storage}）：${reason}`);
    if (config.storage === 'postgres') {
      console.error('[server] 请检查 POKER_PG_URL 是否可达、库是否存在、账号口令是否正确');
    }
    process.exit(1);
  });
  const app = await createApp({config, storage});
  const {host, port} = await app.listen();

  console.log(`[server] 同桌 · 德州扑克 已启动 http://${host}:${port}`);
  console.log(`[server] 运行模式 ${config.mode}，存储 ${config.storage}`);
  if (config.mode === 'production' && (process.env['POKER_SETTLE_MS'] || process.env['POKER_BOT_THINK_MS'])) {
    // 静默忽略会让人以为改动生效了；说清楚是按设计忽略。
    console.error('[server] 生产模式忽略 POKER_SETTLE_MS / POKER_BOT_THINK_MS：节奏类时长只允许在开发模式下调整');
  }
  if (config.wechat === null) {
    const hint = '未配置微信登录：需要 POKER_WECHAT_APPID / POKER_WECHAT_SECRET';
    if (config.mode === 'production') {
      // 生产禁用游客登录，所以这条不是提醒而是故障：放它过去就没人能登录。
      console.error(`[server] 生产模式${hint}，当前所有登录都会失败`);
    } else {
      console.log(`[server] ${hint}；开发模式可用游客登录`);
    }
  }

  let closing = false;
  const stop = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[server] 收到 ${signal}，正在关闭…`);
    void app
      .close()
      .then(() => process.exit(0))
      .catch(error => {
        console.error('[server] 关闭时出错', error);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

await main();
