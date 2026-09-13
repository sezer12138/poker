import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {BOT_THINK_MS, SETTLE_DELAY_MS, loadConfig} from '../src/config.ts';

/**
 * 节奏类时长（结算展示、机器人思考）只允许在开发模式下调整：冒烟脚本要在一场对局里
 * 压缩它们，生产环境则一律用默认值。这里把「开发生效、生产忽略」钉死，
 * 顺便确认生产模式不会因为环境里多了个非法值就启动失败。
 */
describe('节奏类配置', () => {
  it('开发模式读得进覆盖值', () => {
    const config = loadConfig({POKER_MODE: 'development', POKER_SETTLE_MS: '40', POKER_BOT_THINK_MS: '10'});
    assert.equal(config.settleDelayMs, 40);
    assert.equal(config.botThinkMs, 10);
  });

  it('开发模式没设时用默认值，非法值直接报错', () => {
    const fallback = loadConfig({POKER_MODE: 'development'});
    assert.equal(fallback.settleDelayMs, SETTLE_DELAY_MS);
    assert.equal(fallback.botThinkMs, BOT_THINK_MS);
    assert.throws(() => loadConfig({POKER_MODE: 'development', POKER_SETTLE_MS: 'abc'}), /POKER_SETTLE_MS/);
    assert.throws(() => loadConfig({POKER_MODE: 'development', POKER_BOT_THINK_MS: '-1'}), /POKER_BOT_THINK_MS/);
  });

  it('生产模式忽略这两个变量，连非法值也不解析', () => {
    const config = loadConfig({
      POKER_MODE: 'production',
      POKER_SETTLE_MS: '40',
      POKER_BOT_THINK_MS: 'abc',
    });
    assert.equal(config.settleDelayMs, SETTLE_DELAY_MS, '生产环境不许把结算展示压到 40 毫秒');
    assert.equal(config.botThinkMs, BOT_THINK_MS);
  });
});
