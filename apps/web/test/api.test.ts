import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  CODE_MESSAGES,
  TOKEN_STORAGE_KEY,
  buildCommand,
  buildContributeCommand,
  clearToken,
  createApi,
  mapError,
  readToken,
  saveToken,
} from '../static/js/api.js';

type Call = {url: string; init: any};

function fetchStub(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = async (url: string, init: any) => {
    const call = {url, init};
    calls.push(call);
    return reply(call);
  };
  return {calls, impl};
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM = {id: 'r1', version: 7, status: 'waiting'};

/** 命令体是动态字段，测试里统一按普通对象读取，避免依赖推断出的窄类型。 */
function record(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

test('错误映射：401 未授权保留错误码并触发回到大厅', () => {
  const error = mapError(401, {error: {code: 'UNAUTHORIZED', message: '登录已失效，请重新登录'}});
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'UNAUTHORIZED');
  assert.equal(error.status, 401);
  assert.equal(error.message, '登录已失效，请重新登录');
  assert.equal(error.authFailed, true);
});

test('错误映射：409 版本冲突、429 限流、403 锁定与未配置微信', () => {
  const conflict = mapError(409, {error: {code: 'VERSION_CONFLICT', message: '房间版本已更新'}});
  assert.equal(conflict.code, 'VERSION_CONFLICT');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.authFailed, false);
  // 冲突语义是“重新拉取房间”，客户端不得自动重试命令。
  assert.match(conflict.message, /版本已更新/);

  const limited = mapError(429, {error: {code: 'RATE_LIMITED', message: '操作过于频繁'}});
  assert.equal(limited.code, 'RATE_LIMITED');
  assert.equal(limited.message, '操作过于频繁');

  const locked = mapError(403, {error: {code: 'ROOM_LOCKED', message: '房间已锁定'}});
  assert.equal(locked.code, 'ROOM_LOCKED');
  const auditLocked = mapError(403, {error: {code: 'AUDIT_LOCKED', message: '比赛结束后可核验'}});
  assert.equal(auditLocked.message, '比赛结束后可核验');

  const wechat = mapError(503, {error: {code: 'WECHAT_NOT_CONFIGURED', message: '微信登录未配置，请使用游客登录'}});
  assert.equal(wechat.code, 'WECHAT_NOT_CONFIGURED');
  assert.match(wechat.message, /游客登录/);
});

test('错误映射：缺少 error 体或返回 HTML 时按状态码兜底且文案为中文', () => {
  const bare = mapError(429, null);
  assert.equal(bare.code, 'RATE_LIMITED');
  assert.equal(bare.message, CODE_MESSAGES.RATE_LIMITED);
  const html = mapError(500, '<html>oops</html>');
  assert.equal(html.code, 'SERVER_ERROR');
  assert.match(html.message, /服务器/);
  const unknown = mapError(418, {});
  assert.equal(unknown.code, 'UNKNOWN');
  assert.match(unknown.message, /418/);
});

test('请求封装：成功解析 JSON，未授权接口不带 Authorization', async () => {
  const stub = fetchStub(() => json({ok: true, mode: 'development', auth: 'guest'}));
  const api = createApi({fetchImpl: stub.impl, getToken: () => 'token-123'});
  const health = await api.health();
  assert.deepEqual(health, {ok: true, mode: 'development', auth: 'guest'});
  assert.equal(stub.calls[0].url, '/api/health');
  assert.equal(stub.calls[0].init.method, 'GET');
  assert.equal(stub.calls[0].init.headers.Authorization, undefined);

  const login = fetchStub(() => json({token: 't', user: {id: 'u', name: '甲'}, mode: 'development'}));
  const loginApi = createApi({fetchImpl: login.impl, getToken: () => 'token-123'});
  await loginApi.guestLogin('甲');
  assert.equal(login.calls[0].url, '/api/auth/guest');
  assert.equal(login.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(login.calls[0].init.body), {name: '甲'});
});

test('请求封装：带令牌调用、命令路径与命令体字段', async () => {
  const stub = fetchStub(() => json(ROOM));
  const api = createApi({fetchImpl: stub.impl, getToken: () => 'token-123', baseUrl: 'http://127.0.0.1:8787'});

  const room = await api.getRoom('r1');
  assert.equal(room.version, 7);
  assert.equal(stub.calls[0].url, 'http://127.0.0.1:8787/api/rooms/r1');
  assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer token-123');

  await api.command('r 1', buildCommand('ready', 7, {ready: true}));
  assert.equal(stub.calls[1].url, 'http://127.0.0.1:8787/api/rooms/r%201/command');
  const body = JSON.parse(stub.calls[1].init.body);
  assert.equal(body.type, 'ready');
  assert.equal(body.ready, true);
  assert.equal(body.expectedVersion, 7);
  assert.match(body.requestId, UUID_PATTERN);

  await api.audit('r1');
  assert.equal(stub.calls[2].url, 'http://127.0.0.1:8787/api/rooms/r1/audit');

  await api.joinRoom({invite: 'inv-9'});
  assert.equal(stub.calls[3].url, 'http://127.0.0.1:8787/api/rooms/join');
  assert.deepEqual(JSON.parse(stub.calls[3].init.body), {invite: 'inv-9'});
});

test('请求失败时抛出 ApiError，页面据此提示并返回大厅', async () => {
  const stub = fetchStub(() => json({error: {code: 'UNAUTHORIZED', message: '登录已失效，请重新登录'}}, 401));
  const api = createApi({fetchImpl: stub.impl, getToken: () => 'stale'});
  await assert.rejects(
    () => api.me(),
    (error: ApiError) => {
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.status, 401);
      assert.equal(error.message, '登录已失效，请重新登录');
      return true;
    },
  );

  const offline = createApi({
    fetchImpl: async () => {
      throw new Error('boom');
    },
    getToken: () => 'stale',
  });
  await assert.rejects(() => offline.health(), (error: ApiError) => error.code === 'NETWORK' && error.status === 0);

  const html = fetchStub(() => new Response('<html>502</html>', {status: 502}));
  const badGateway = createApi({fetchImpl: html.impl, getToken: () => null});
  await assert.rejects(() => badGateway.getRoom('r1'), (error: ApiError) => error.code === 'SERVER_ERROR');
});

test('命令体：普通命令带 expectedVersion，贡献命令不带且不复用 requestId', () => {
  const ready = buildCommand('ready', 3, {ready: true});
  assert.deepEqual(Object.keys(ready).sort(), ['expectedVersion', 'ready', 'requestId', 'type']);
  assert.match(ready.requestId, UUID_PATTERN);
  const again = buildCommand('ready', 3, {ready: true});
  assert.notEqual(again.requestId, ready.requestId);

  const removeBot = record(buildCommand('removeBot', 4, {seat: 2}));
  assert.equal(removeBot.seat, 2);

  const contribute = record(buildContributeCommand({seat: 1, nonce: 'a'.repeat(64), handNo: 5}));
  assert.equal(contribute.type, 'contribute');
  assert.equal(contribute.expectedVersion, undefined);
  assert.equal(contribute.handNo, 5);
  assert.equal('expectedVersion' in contribute, false);
  assert.match(String(contribute.requestId), UUID_PATTERN);
  assert.notEqual(buildContributeCommand({seat: 1, nonce: 'a'.repeat(64), handNo: 5}).requestId, contribute.requestId);
});

test('令牌读写走注入的存储实现', () => {
  const store = memoryStorage();
  assert.equal(readToken(store), null);
  assert.equal(saveToken('abc', store), true);
  assert.equal(store.getItem(TOKEN_STORAGE_KEY), 'abc');
  assert.equal(readToken(store), 'abc');
  const api = createApi({fetchImpl: async () => json({}), storage: store});
  assert.equal(api.clearToken(), true);
  assert.equal(readToken(store), null);
  // 重复清理不算失败：返回存储是否可用，而不是键此前是否存在。
  assert.equal(clearToken(store), true);
});
