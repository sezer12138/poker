import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {startTestServer} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {sanitizeName} from '../src/auth.ts';

describe('认证与会话', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('游客登录返回 token 与用户信息', async () => {
    const result = await server.call('/api/auth/guest', {body: {name: '阿明'}});
    assert.equal(result.status, 200);
    assert.match(result.body.token, /^[0-9a-f]{64}$/);
    assert.equal(result.body.user.name, '阿明');
    assert.match(result.body.user.id, /^guest_[0-9a-f]{16}$/);
    assert.equal(result.body.mode, 'development');
  });

  it('昵称会被去空白并保留可见文本', async () => {
    const result = await server.call('/api/auth/guest', {body: {name: '  小 红  '}});
    assert.equal(result.status, 200);
    assert.equal(result.body.user.name, '小 红');
  });

  it('昵称为空或过长时拒绝', async () => {
    for (const name of ['', '   ', '一二三四五六七八九十一二三四五六七']) {
      const result = await server.call('/api/auth/guest', {body: {name}});
      assert.equal(result.status, 400, `昵称 ${JSON.stringify(name)} 应被拒绝`);
      assert.equal(result.body.error.code, 'INVALID_INPUT');
    }
  });

  it('昵称中的控制字符被剔除', () => {
    assert.equal(sanitizeName('\u0000阿\t明'), '阿明');
    assert.equal(sanitizeName('阿\n明'), '阿明');
    assert.equal(sanitizeName('阿   明'), '阿 明');
    assert.throws(() => sanitizeName('\u0001'), /昵称长度/);
  });

  it('/api/me 需要有效 token', async () => {
    const missing = await server.call('/api/me');
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'UNAUTHORIZED');

    const bad = await server.call('/api/me', {token: 'f'.repeat(64)});
    assert.equal(bad.status, 401);

    const short = await server.call('/api/me', {token: 'abc'});
    assert.equal(short.status, 401);
  });

  it('/api/me 返回当前用户', async () => {
    const session = await server.guest('阿明');
    const result = await server.call('/api/me', {token: session.token});
    assert.equal(result.status, 200);
    assert.equal(result.body.user.id, session.user.id);
    assert.equal(result.body.user.name, '阿明');
  });

  it('会话过期后失效', async () => {
    const shortLived = await startTestServer({sessionTtlMs: 60_000});
    try {
      const session = await shortLived.guest('短命');
      assert.equal((await shortLived.call('/api/me', {token: session.token})).status, 200);
      await shortLived.clock.advance(61_000);
      const after = await shortLived.call('/api/me', {token: session.token});
      assert.equal(after.status, 401);
    } finally {
      await shortLived.close();
    }
  });

  it('生产模式禁用游客登录', async () => {
    const production = await startTestServer({mode: 'production', storageKey: 'a'.repeat(64)});
    try {
      const health = await production.call('/api/health');
      assert.equal(health.body.auth, 'wechat');
      const result = await production.call('/api/auth/guest', {body: {name: '阿明'}});
      assert.equal(result.status, 403);
      assert.equal(result.body.error.code, 'GUEST_DISABLED');
    } finally {
      await production.close();
    }
  });

  it('未配置微信时给出明确错误而不是假装成功', async () => {
    const dev = await server.call('/api/auth/wechat', {body: {name: '微信玩家', code: 'test-code'}});
    assert.equal(dev.status, 501);
    assert.equal(dev.body.error.code, 'WECHAT_NOT_CONFIGURED');
    assert.match(dev.body.error.message, /微信登录未配置/);

    const production = await startTestServer({mode: 'production', storageKey: 'b'.repeat(64)});
    try {
      const result = await production.call('/api/auth/wechat', {body: {name: '微信玩家', code: 'test-code'}});
      assert.equal(result.status, 503);
      assert.equal(result.body.error.code, 'WECHAT_UNAVAILABLE');
    } finally {
      await production.close();
    }
  });

  it('缺少 code 时拒绝微信登录', async () => {
    const result = await server.call('/api/auth/wechat', {body: {name: '微信玩家'}});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_INPUT');
  });

  it('健康检查不泄漏内部配置', async () => {
    const result = await server.call('/api/health');
    assert.equal(result.status, 200);
    const text = JSON.stringify(result.body);
    assert.equal(text.includes('storageKey'), false);
    assert.equal(text.includes('POKER'), false);
  });

  it('请求体必须是 JSON 对象且有大小上限', async () => {
    const bad = await fetch(`${server.url}/api/auth/guest`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: 'not-json',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).error.code, 'INVALID_INPUT');

    const huge = await fetch(`${server.url}/api/auth/guest`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({name: 'x'.repeat(70 * 1024)}),
    });
    assert.equal(huge.status, 400);
  });
});
