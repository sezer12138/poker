// HTTP 契约封装（见 docs/product/contract.md）。失败响应统一为 {error:{code,message}} + HTTP 状态。
// 模块顶层不访问 window/localStorage/fetch；令牌与网络实现都通过参数或函数体内取值。

import {NAME_KEY, newRequestId, storageGet, storageRemove, storageSet, TOKEN_KEY} from './util.js';

export const TOKEN_STORAGE_KEY = TOKEN_KEY;

/** 已知错误码的中文兜底文案；服务端返回的 message 优先。 */
export const CODE_MESSAGES = {
  UNAUTHORIZED: '登录已失效，请重新登录',
  FORBIDDEN: '没有权限执行该操作',
  NOT_FOUND: '房间不存在或已关闭',
  ROOM_LOCKED: '房间已锁定，开赛后无法加入或移除成员',
  AUDIT_LOCKED: '比赛结束后可核验',
  VERSION_CONFLICT: '房间状态已变化，请查看最新状态后再操作',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  WECHAT_NOT_CONFIGURED: '微信登录未配置，请使用游客登录',
  INVALID_INPUT: '提交的内容不合法',
  INVALID_DECK: '牌局数据异常',
  NOT_YOUR_TURN: '还没轮到你行动',
  ILLEGAL_ACTION: '当前操作不合法',
  HAND_FINISHED: '本手已结束',
  MATCH_FINISHED: '比赛已结束',
  NETWORK: '网络连接失败，请检查网络后重试',
  SERVER_ERROR: '服务器暂时不可用，请稍后重试',
};

const STATUS_CODES = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  429: 'RATE_LIMITED',
  500: 'SERVER_ERROR',
  502: 'SERVER_ERROR',
  503: 'SERVER_ERROR',
};

export class ApiError extends Error {
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.serverMessage = options.serverMessage ?? null;
    this.authFailed = options.authFailed === true;
  }
}

export function messageForCode(code, status) {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (status && STATUS_CODES[status] && CODE_MESSAGES[STATUS_CODES[status]]) return CODE_MESSAGES[STATUS_CODES[status]];
  return status ? `请求失败（HTTP ${status}）` : '请求失败';
}

/** 把失败响应规整为 ApiError：服务端 message 优先，缺失时按错误码给中文兜底。 */
export function mapError(status, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const error = body.error && typeof body.error === 'object' ? body.error : {};
  const code = typeof error.code === 'string' && error.code !== '' ? error.code : STATUS_CODES[status] ?? 'UNKNOWN';
  const serverMessage = typeof error.message === 'string' && error.message !== '' ? error.message : null;
  return new ApiError(code, status, serverMessage ?? messageForCode(code, status), {serverMessage, authFailed: status === 401});
}

export function readToken(storageImpl) {
  return storageGet(TOKEN_STORAGE_KEY, null, storageImpl);
}

export function saveToken(token, storageImpl) {
  return storageSet(TOKEN_STORAGE_KEY, token, storageImpl);
}

export function clearToken(storageImpl) {
  return storageRemove(TOKEN_STORAGE_KEY, storageImpl);
}

/** 接口基地址：默认与页面同源；可用 __POKER_API_BASE__ 覆盖（例如本地调试指向 8787 端口）。 */
export function defaultBaseUrl() {
  const override = globalThis.__POKER_API_BASE__;
  return typeof override === 'string' ? override.replace(/\/$/, '') : '';
}

/**
 * 创建接口客户端。fetchImpl/getToken 可注入，测试用桩替换。
 * 不自动重试任何命令：动作类命令重试可能造成重复下注，冲突交由页面提示玩家。
 */
export function createApi(options = {}) {
  const base = options.baseUrl ?? defaultBaseUrl();
  const fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const getToken = options.getToken ?? (() => readToken(options.storage));

  async function request(path, config = {}) {
    const {method = 'GET', body, auth = true, token} = config;
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const bearer = token ?? getToken();
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
    }
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError('NETWORK', 0, messageForCode('NETWORK'), {serverMessage: String(cause)});
    }
    const payload = await readPayload(response);
    if (!response.ok) throw mapError(response.status, payload);
    return payload;
  }

  return {
    baseUrl: base,
    request,
    health: () => request('/api/health', {auth: false}),
    guestLogin: (name) => request('/api/auth/guest', {method: 'POST', body: {name}, auth: false}),
    wechatLogin: (code, name) => request('/api/auth/wechat', {method: 'POST', body: {code, name}, auth: false}),
    me: (token) => request('/api/me', {token}),
    createRoom: (params) => request('/api/rooms', {method: 'POST', body: {name: params?.name, bots: params?.bots ?? 0}}),
    joinRoom: (params) => request('/api/rooms/join', {
      method: 'POST',
      body: params?.invite ? {invite: params.invite} : {code: params?.code},
    }),
    getRoom: (roomId) => request(`/api/rooms/${encodeURIComponent(roomId)}`),
    command: (roomId, body) => request(`/api/rooms/${encodeURIComponent(roomId)}/command`, {method: 'POST', body}),
    audit: (roomId) => request(`/api/rooms/${encodeURIComponent(roomId)}/audit`),
    clearToken: () => clearToken(options.storage),
  };
}

export async function readPayload(response) {
  if (response.status === 204) return null;
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** 普通命令：新 UUID + 当前版本。版本冲突不自动重试，必须回到页面由玩家决定。 */
export function buildCommand(type, expectedVersion, extra = {}) {
  return {requestId: newRequestId(), expectedVersion, type, ...extra};
}

/**
 * 贡献命令没有 expectedVersion：契约规定它绑定 handNo 且每席一次，
 * 忽略版本冲突以避免全员同时贡献时互相顶掉。
 */
export function buildContributeCommand({seat, nonce, handNo}) {
  return {requestId: newRequestId(), type: 'contribute', seat, nonce, handNo};
}

export function isUnauthorized(error) {
  return error instanceof ApiError && error.code === 'UNAUTHORIZED';
}

export function readName(storageImpl) {
  const stored = storageGet(NAME_KEY, '', storageImpl);
  return typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : '';
}

export function saveName(name, storageImpl) {
  return storageSet(NAME_KEY, name, storageImpl);
}

/**
 * 恢复登录：本地有令牌先用 /api/me 验证，失效或缺失时以游客身份登录。
 * 生产环境禁用游客登录，此时把服务端错误原样抛出由页面展示。
 */
export async function ensureSession(api, options = {}) {
  const stored = readName(options.storage);
  const name = options.name ?? (stored !== '' ? stored : '玩家');
  const token = options.token ?? readToken(options.storage);
  if (token) {
    try {
      const me = await api.me(token);
      return {token, user: me.user, mode: me.mode, created: false};
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }
  }
  const result = await api.guestLogin(name);
  saveToken(result.token, options.storage);
  saveName(result.user?.name ?? name, options.storage);
  return {token: result.token, user: result.user, mode: result.mode, created: true};
}
