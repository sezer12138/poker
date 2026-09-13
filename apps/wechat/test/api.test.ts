/**
 * utils/api.js 契约测试：URL/请求头/请求体、错误码映射、requestId、命令不自动重试。
 * 依据 docs/product/contract.md「HTTP JSON 契约」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx, type RecordedRequest, type WxMock} from './harness.ts';

interface ApiFailure extends Error {
  code: string;
  status: number;
}

interface ApiModule {
  newRequestId(): string;
  health(): Promise<unknown>;
  authGuest(name: string): Promise<unknown>;
  authWechat(code: string, name: string): Promise<unknown>;
  me(): Promise<unknown>;
  createRoom(name: string, bots: number): Promise<unknown>;
  joinRoom(payload: {code?: string; invite?: string}): Promise<unknown>;
  getRoom(id: string): Promise<unknown>;
  command(id: string, payload: Record<string, unknown>): Promise<unknown>;
  audit(id: string): Promise<unknown>;
}

interface Context {
  wx: WxMock;
  api: ApiModule;
}

function setup(wx: WxMock = createWx()): Context {
  const loader = createLoader({wx, timers: createTimers()});
  return {wx, api: loader.load('utils/api.js') as ApiModule};
}

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  try {
    await promise;
  } catch (err) {
    return err as ApiFailure;
  }
  throw new Error('预期请求失败，但成功返回');
}

test('GET 请求使用 baseUrl，无令牌时不发送 Authorization', async () => {
  const wx = createWx({respond: () => ({statusCode: 200, data: {ok: true, mode: 'development', auth: 'guest'}})});
  const {api} = setup(wx);
  const health = await api.health();
  assert.deepStrictEqual(health, {ok: true, mode: 'development', auth: 'guest'});

  assert.equal(wx.requests.length, 1);
  const request = wx.requests[0]!;
  assert.equal(request.url, 'http://127.0.0.1:8787/api/health');
  assert.equal(request.method, 'GET');
  assert.equal(request.header['content-type'], 'application/json');
  assert.equal(request.header.Authorization, undefined);
});

test('有令牌时发送 Authorization: Bearer <token>', async () => {
  const wx = createWx({respond: () => ({statusCode: 200, data: {user: {id: 'u1', name: '甲'}, mode: 'development'}})});
  wx.storage.set('poker.token', 'token-abc');
  const {api} = setup(wx);
  await api.me();
  assert.equal(wx.requests[0]!.header.Authorization, 'Bearer token-abc');
});

test('登录与房间入口的 URL 与请求体符合契约', async () => {
  const wx = createWx();
  const {api} = setup(wx);

  await api.authGuest('甲');
  assert.equal(wx.requests[0]!.url, 'http://127.0.0.1:8787/api/auth/guest');
  assert.deepStrictEqual(wx.requests[0]!.data, {name: '甲'});

  await api.authWechat('CODE', '乙');
  assert.equal(wx.requests[1]!.url, 'http://127.0.0.1:8787/api/auth/wechat');
  assert.deepStrictEqual(wx.requests[1]!.data, {code: 'CODE', name: '乙'});

  await api.createRoom('', 2);
  assert.deepStrictEqual(wx.requests[2]!.data, {bots: 2});

  await api.createRoom('好友房', 0);
  assert.deepStrictEqual(wx.requests[3]!.data, {bots: 0, name: '好友房'});

  await api.joinRoom({code: 'ABC123'});
  assert.deepStrictEqual(wx.requests[4]!.data, {code: 'ABC123'});

  await api.joinRoom({invite: 'invite-token'});
  assert.deepStrictEqual(wx.requests[5]!.data, {invite: 'invite-token'});

  await api.getRoom('room-1');
  assert.equal(wx.requests[6]!.url, 'http://127.0.0.1:8787/api/rooms/room-1');
  assert.equal(wx.requests[6]!.method, 'GET');

  await api.audit('room-1');
  assert.equal(wx.requests[7]!.url, 'http://127.0.0.1:8787/api/rooms/room-1/audit');
});

test('命令体固定包含新 requestId 与 expectedVersion，可选字段按需出现', async () => {
  const wx = createWx();
  const {api} = setup(wx);

  await api.command('room-1', {type: 'action', expectedVersion: 7, action: {type: 'raiseTo', amount: 120}});
  const first = wx.requests[0]!;
  assert.equal(first.url, 'http://127.0.0.1:8787/api/rooms/room-1/command');
  assert.equal(first.method, 'POST');
  const actionBody = first.data as Record<string, unknown>;
  assert.equal(actionBody.type, 'action');
  assert.equal(actionBody.expectedVersion, 7);
  assert.deepStrictEqual(actionBody.action, {type: 'raiseTo', amount: 120});
  assert.equal('seat' in actionBody, false);
  assert.equal('nonce' in actionBody, false);
  assert.equal('ready' in actionBody, false);
  assert.match(String(actionBody.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  await api.command('room-1', {type: 'ready', expectedVersion: 8, ready: false});
  const readyBody = wx.requests[1]!.data as Record<string, unknown>;
  assert.equal(readyBody.ready, false, 'ready:false 必须显式发送');

  await api.command('room-1', {type: 'contribute', expectedVersion: 8, seat: 2, nonce: 'a'.repeat(64), handNo: 3});
  const contributeBody = wx.requests[2]!.data as Record<string, unknown>;
  assert.equal(contributeBody.seat, 2);
  assert.equal(contributeBody.nonce, 'a'.repeat(64));
  assert.equal(contributeBody.handNo, 3);

  const ids = wx.requests.map((request) => (request.data as Record<string, unknown>).requestId);
  assert.equal(new Set(ids).size, ids.length, 'requestId 每次都必须是新的');
});

test('错误响应映射为 {code,message} 并保留 HTTP 状态', async () => {
  const cases: {status: number; body: unknown; code: string; message?: string}[] = [
    {status: 401, body: {error: {code: 'UNAUTHORIZED', message: '登录已失效'}}, code: 'UNAUTHORIZED', message: '登录已失效'},
    {status: 403, body: {error: {code: 'AUDIT_LOCKED', message: '比赛结束后可核验'}}, code: 'AUDIT_LOCKED', message: '比赛结束后可核验'},
    {status: 409, body: {error: {code: 'VERSION_CONFLICT', message: '版本冲突'}}, code: 'VERSION_CONFLICT', message: '版本冲突'},
    {status: 423, body: {error: {code: 'ROOM_LOCKED', message: '房间已锁定'}}, code: 'ROOM_LOCKED', message: '房间已锁定'},
    {status: 429, body: {error: {code: 'RATE_LIMITED', message: '操作过于频繁'}}, code: 'RATE_LIMITED', message: '操作过于频繁'},
    {status: 501, body: {error: {code: 'WECHAT_NOT_CONFIGURED', message: '未配置微信登录'}}, code: 'WECHAT_NOT_CONFIGURED', message: '未配置微信登录'},
    {status: 404, body: {}, code: 'NOT_FOUND'},
    {status: 500, body: 'boom', code: 'HTTP_500'}
  ];

  for (const item of cases) {
    const wx = createWx({respond: () => ({statusCode: item.status, data: item.body})});
    const {api} = setup(wx);
    const failure = await failureOf(api.me());
    assert.equal(failure.code, item.code, `HTTP ${item.status} 的 code 映射`);
    assert.equal(failure.status, item.status);
    if (item.message) assert.equal(failure.message, item.message);
    else assert.ok(failure.message.length > 0, '缺少中文兜底文案');
  }
});

test('UNAUTHORIZED 会清除本地令牌，网络失败映射为 NETWORK', async () => {
  const wx = createWx({respond: () => ({statusCode: 401, data: {error: {code: 'UNAUTHORIZED', message: '登录已失效'}}})});
  wx.storage.set('poker.token', 'token-abc');
  const {api} = setup(wx);
  const failure = await failureOf(api.me());
  assert.equal(failure.code, 'UNAUTHORIZED');
  assert.equal(wx.storage.has('poker.token'), false, '401 后必须清除本地令牌');

  const offline = createWx();
  offline.request = (requestOptions) => {
    if (requestOptions.fail) requestOptions.fail({errMsg: 'request:fail'});
  };
  const offlineApi = setup(offline).api;
  const networkFailure = await failureOf(offlineApi.health());
  assert.equal(networkFailure.code, 'NETWORK');
  assert.equal(networkFailure.status, 0);
});

test('命令失败不自动重试，只发出一次请求', async () => {
  const wx = createWx({respond: () => ({statusCode: 500, data: {error: {code: 'INTERNAL', message: '服务端错误'}}})});
  const {api} = setup(wx);
  const failure = await failureOf(api.command('room-1', {type: 'action', expectedVersion: 3, action: {type: 'fold'}}));
  assert.equal(failure.code, 'INTERNAL');
  assert.equal(wx.requests.length, 1, '动作不得自动重试');
});

test('requestId 形状稳定且逐次不同', () => {
  const {api} = setup();
  const ids = new Set<string>();
  for (let index = 0; index < 200; index += 1) ids.add(api.newRequestId());
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
});

test('房间号经过 URL 编码，避免路径注入', async () => {
  const wx = createWx();
  const {api} = setup(wx);
  await api.getRoom('a/b c');
  assert.equal(wx.requests[0]!.url, 'http://127.0.0.1:8787/api/rooms/a%2Fb%20c');
});

test('请求记录保留超时配置', async () => {
  const wx = createWx();
  const {api} = setup(wx);
  await api.health();
  const request: RecordedRequest = wx.requests[0]!;
  assert.equal(typeof request.timeout, 'number');
});
