/**
 * utils/auth.js 契约测试：wx.login → POST /api/auth/wechat；
 * 服务端未配置 AppID（501 WECHAT_NOT_CONFIGURED）时回退到明确标注的游客模式。
 * 真机微信登录无法在此验证，这里只验证协议与回退分支。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx, type RecordedRequest, type WxMock} from './harness.ts';

interface Session {
  token: string;
  user: {id: string; name: string};
  mode: string;
  wechat: boolean;
  devFallback: boolean;
  reason: string;
  notice: string;
}

interface AuthModule {
  login(options?: {name?: string}): Promise<Session>;
  ensureLogin(options?: {name?: string}): Promise<Session>;
  current(): Session | null;
  getToken(): string | null;
  getUser(): {id: string; name: string} | null;
  isDevelopment(): boolean;
  defaultName(): string;
  clear(): void;
}

function setup(wx: WxMock): AuthModule {
  const loader = createLoader({wx, timers: createTimers()});
  return loader.load('utils/auth.js') as AuthModule;
}

function wechatOk(name: string) {
  return {statusCode: 200, data: {token: 'wechat-token', user: {id: 'wx-1', name}, mode: 'production'}};
}

function guestOk(name: string) {
  return {statusCode: 200, data: {token: 'guest-token', user: {id: 'guest-1', name}, mode: 'development'}};
}

test('真实微信登录成功时不回退游客', async () => {
  const wx = createWx({
    respond: (request: RecordedRequest) =>
      request.url.endsWith('/api/auth/wechat') ? wechatOk('甲') : {statusCode: 500, data: {}}
  });
  const auth = setup(wx);
  const session = await auth.login({name: '甲'});

  assert.equal(wx.loginCalls, 1, '必须先调用 wx.login');
  assert.equal(wx.requests.length, 1);
  assert.equal(wx.requests[0]!.url, 'http://127.0.0.1:8787/api/auth/wechat');
  assert.deepStrictEqual(wx.requests[0]!.data, {code: 'CODE_FROM_WX_LOGIN', name: '甲'});

  assert.equal(session.wechat, true);
  assert.equal(session.devFallback, false);
  assert.equal(session.mode, 'production');
  assert.equal(session.token, 'wechat-token');
  assert.equal(session.notice, '');
  assert.equal(wx.storage.get('poker.token'), 'wechat-token');
  assert.equal(wx.storage.get('poker.session') !== undefined, true);
  assert.equal(auth.isDevelopment(), false);
});

test('WECHAT_NOT_CONFIGURED 时回退游客并标注开发模式', async () => {
  const wx = createWx({
    respond: (request: RecordedRequest) =>
      request.url.endsWith('/api/auth/wechat')
        ? {statusCode: 501, data: {error: {code: 'WECHAT_NOT_CONFIGURED', message: '服务端未配置微信登录'}}}
        : guestOk('乙')
  });
  const auth = setup(wx);
  const session = await auth.login({name: '乙'});

  assert.equal(wx.requests.length, 2, '失败后必须再走一次游客登录');
  assert.equal(wx.requests[1]!.url, 'http://127.0.0.1:8787/api/auth/guest');
  assert.deepStrictEqual(wx.requests[1]!.data, {name: '乙'});

  assert.equal(session.wechat, false);
  assert.equal(session.devFallback, true);
  assert.equal(session.mode, 'development');
  assert.equal(session.reason, 'WECHAT_NOT_CONFIGURED');
  assert.match(session.notice, /开发模式/);
  assert.equal(session.token, 'guest-token');
  assert.equal(auth.isDevelopment(), true);
  assert.equal(auth.getToken(), 'guest-token');
  assert.deepStrictEqual(auth.getUser(), {id: 'guest-1', name: '乙'});
});

test('wx.login 不可用时直接进入游客模式', async () => {
  const wx = createWx({login: 'missing', respond: () => guestOk('丙')});
  const auth = setup(wx);
  assert.equal(typeof (wx as {login?: unknown}).login, 'undefined');

  const session = await auth.login({name: '丙'});
  assert.equal(wx.requests.length, 1, '不应请求 /api/auth/wechat');
  assert.equal(wx.requests[0]!.url, 'http://127.0.0.1:8787/api/auth/guest');
  assert.equal(session.devFallback, true);
  assert.equal(session.reason, 'WX_LOGIN_UNAVAILABLE');
  assert.match(session.notice, /开发模式/);
});

test('wx.login 回调失败时回退游客', async () => {
  const wx = createWx({login: 'fail', respond: () => guestOk('丁')});
  const auth = setup(wx);
  const session = await auth.login({name: '丁'});
  assert.equal(wx.requests[0]!.url, 'http://127.0.0.1:8787/api/auth/guest');
  assert.equal(session.devFallback, true);
});

test('服务端其他错误同样回退游客并保留原因', async () => {
  const wx = createWx({
    respond: (request: RecordedRequest) =>
      request.url.endsWith('/api/auth/wechat') ? {statusCode: 500, data: {error: {code: 'INTERNAL', message: '服务端错误'}}} : guestOk('戊')
  });
  const auth = setup(wx);
  const session = await auth.login({name: '戊'});
  assert.equal(session.devFallback, true);
  assert.equal(session.reason, 'INTERNAL');
});

test('生产环境拒绝游客登录时不得假装成功', async () => {
  const wx = createWx({
    respond: (request: RecordedRequest) =>
      request.url.endsWith('/api/auth/wechat')
        ? {statusCode: 501, data: {error: {code: 'WECHAT_NOT_CONFIGURED', message: '服务端未配置微信登录'}}}
        : {statusCode: 403, data: {error: {code: 'FORBIDDEN', message: '生产环境禁用游客登录'}}}
  });
  const auth = setup(wx);
  await assert.rejects(() => auth.login({name: '己'}), /生产环境禁用游客登录/);
  assert.equal(wx.storage.has('poker.token'), false, '失败后不得留下令牌');
  assert.equal(auth.current(), null);
});

test('ensureLogin 复用新鲜会话且并发只登录一次', async () => {
  const wx = createWx({respond: () => guestOk('庚')});
  const auth = setup(wx);
  await auth.login({name: '庚'});
  const before = wx.requests.length;

  const [first, second] = await Promise.all([auth.ensureLogin(), auth.ensureLogin()]);
  assert.equal(wx.requests.length, before, '新鲜会话不应触发额外请求');
  assert.equal(first.token, 'guest-token');
  assert.equal(second.token, 'guest-token');
});

test('令牌失效时清除会话并重新登录', async () => {
  let meCalls = 0;
  const wx = createWx({
    respond: (request: RecordedRequest) => {
      if (request.url.endsWith('/api/me')) {
        meCalls += 1;
        return {statusCode: 401, data: {error: {code: 'UNAUTHORIZED', message: '登录已失效'}}};
      }
      return guestOk('辛');
    }
  });
  const auth = setup(wx);
  await auth.login({name: '辛'});
  const session = auth.current() as Session;
  // 让会话过期，强制走 /api/me 校验。
  wx.storage.set('poker.session', {...session, at: 0});

  const renewed = await auth.ensureLogin();
  assert.equal(meCalls, 1, '过期会话必须经 /api/me 校验');
  assert.equal(renewed.token, 'guest-token');
  assert.equal(
    wx.requests.filter((request) => request.url.endsWith('/api/auth/wechat')).length,
    2,
    '401 后必须重新登录一次'
  );
  assert.equal(wx.storage.has('poker.token'), true);
});

test('默认昵称不含 Math.random 且带有前缀', () => {
  const wx = createWx();
  const auth = setup(wx);
  assert.match(auth.defaultName(), /^玩家\d{4}$/);
});
