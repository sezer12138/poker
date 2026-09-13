/**
 * HTTP 封装：统一 baseUrl、Authorization、错误归一化与 requestId 生成。
 * 契约：成功直接返回对象；失败 {error:{code,message}} + HTTP 状态；
 * 动作命令不自动重试（requestId 每次新生成，服务端按 requestId 幂等）。
 */
const config = require('../config.js');

const DEFAULT_MESSAGES = {
  UNAUTHORIZED: '登录已失效，请重新登录',
  VERSION_CONFLICT: '房间状态已更新，请按最新状态重试',
  ROOM_LOCKED: '房间已锁定，无法执行该操作',
  AUDIT_LOCKED: '比赛结束后可核验',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  WECHAT_NOT_CONFIGURED: '服务端未配置微信登录',
  NOT_FOUND: '房间不存在或已关闭',
  FORBIDDEN: '没有权限执行该操作',
  INVALID_INPUT: '请求参数不合法',
  ILLEGAL_ACTION: '该操作当前不合法',
  NOT_YOUR_TURN: '还没轮到你行动',
  HAND_FINISHED: '本手已结束',
  MATCH_FINISHED: '比赛已结束',
  NETWORK: '网络连接失败，请确认服务端已启动'
};

const STATUS_CODES = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  429: 'RATE_LIMITED',
  501: 'WECHAT_NOT_CONFIGURED'
};

class ApiError extends Error {
  constructor(code, message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

function readToken() {
  try {
    const token = wx.getStorageSync(config.storage.token);
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (e) {
    return null;
  }
}

function clearToken() {
  try {
    wx.removeStorageSync(config.storage.token);
  } catch (e) {
    // 存储不可用时忽略：页面会因 UNAUTHORIZED 重新登录。
  }
}

function statusCodeOf(status) {
  return STATUS_CODES[status] || 'HTTP_' + status;
}

function toApiError(res) {
  const status = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
  const body = res ? res.data : null;
  const raw = body && typeof body === 'object' ? body.error : null;
  const code = (raw && raw.code) || statusCodeOf(status);
  const message = (raw && raw.message) || DEFAULT_MESSAGES[code] || '请求失败（HTTP ' + status + '）';
  if (code === 'UNAUTHORIZED') clearToken();
  return new ApiError(code, message, status, body);
}

function request(method, path, data) {
  return new Promise(function (resolve, reject) {
    const header = { 'content-type': 'application/json' };
    const token = readToken();
    if (token) header.Authorization = 'Bearer ' + token;
    wx.request({
      url: config.baseUrl + path,
      method: method,
      data: data,
      header: header,
      timeout: config.requestTimeoutMs,
      success: function (res) {
        const status = res && typeof res.statusCode === 'number' ? res.statusCode : 0;
        if (status >= 200 && status < 300) {
          resolve(res.data);
          return;
        }
        reject(toApiError(res));
      },
      fail: function (err) {
        reject(new ApiError('NETWORK', DEFAULT_MESSAGES.NETWORK, 0, err));
      }
    });
  });
}

// requestId 只要求「每次命令新 UUID」：时间戳 + 进程内序号即可，无需密码学随机。
let sequence = 0;

function newRequestId() {
  sequence = (sequence + 1) % 0xffff;
  const stamp = Date.now().toString(16).padStart(12, '0').slice(-12);
  const tail = sequence.toString(16).padStart(4, '0');
  const extra = (Date.now() % 0xffff).toString(16).padStart(4, '0');
  const raw = (stamp + tail + extra + stamp + tail).slice(0, 32);
  return raw.slice(0, 8) + '-' + raw.slice(8, 12) + '-' + raw.slice(12, 16) + '-' + raw.slice(16, 20) + '-' + raw.slice(20, 32);
}

function health() {
  return request('GET', '/api/health');
}

function authGuest(name) {
  return request('POST', '/api/auth/guest', { name: name });
}

function authWechat(code, name) {
  return request('POST', '/api/auth/wechat', { code: code, name: name });
}

function me() {
  return request('GET', '/api/me');
}

function createRoom(name, bots) {
  const body = { bots: bots };
  if (name) body.name = name;
  return request('POST', '/api/rooms', body);
}

function joinRoom(payload) {
  const source = payload || {};
  const body = {};
  if (source.code) body.code = source.code;
  if (source.invite) body.invite = source.invite;
  return request('POST', '/api/rooms/join', body);
}

function roomPath(roomId) {
  return '/api/rooms/' + encodeURIComponent(roomId);
}

function getRoom(roomId) {
  return request('GET', roomPath(roomId));
}

function audit(roomId) {
  return request('GET', roomPath(roomId) + '/audit');
}

/** 命令体固定包含新 requestId 与 expectedVersion；可选字段只在有值时出现。 */
function command(roomId, payload) {
  const source = payload || {};
  const body = {
    requestId: newRequestId(),
    expectedVersion: source.expectedVersion,
    type: source.type
  };
  ['ready', 'seat', 'action', 'nonce', 'handNo'].forEach(function (key) {
    if (source[key] !== undefined) body[key] = source[key];
  });
  return request('POST', roomPath(roomId) + '/command', body);
}

module.exports = {
  ApiError: ApiError,
  DEFAULT_MESSAGES: DEFAULT_MESSAGES,
  request: request,
  newRequestId: newRequestId,
  health: health,
  authGuest: authGuest,
  authWechat: authWechat,
  me: me,
  createRoom: createRoom,
  joinRoom: joinRoom,
  getRoom: getRoom,
  command: command,
  audit: audit
};
