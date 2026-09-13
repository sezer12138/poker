// WebSocket 客户端：订阅、心跳、断线重连与 GET 房间回退。
// 令牌只放在 subscribe 消息里，绝不进入 URL。模块顶层不访问 window/WebSocket。

export const PING_INTERVAL_MS = 20000;
export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 15000;

/**
 * 终止性关闭码：服务端明确表示这个身份不该再连了，重连只会被同样地关掉。
 * 4001 = 顶号或登录失效，4003 = 已不在该房间（被移出/已离开）。
 */
export const TERMINAL_CLOSE_CODES = [4001, 4003];

/**
 * 关闭码策略。服务端在关闭前会先发一条 error 消息，所以原因优先取它；
 * 没有错误消息时按关闭码给兜底中文文案，绝不把「正在重连」显示给已经被踢掉的玩家。
 */
export function closeDecision(code, error) {
  if (!TERMINAL_CLOSE_CODES.includes(code)) {
    return {
      terminal: false,
      code: error?.code ?? 'NETWORK',
      message: error?.message ?? '连接已断开，正在重连',
    };
  }
  if (error?.code && error?.message) return {terminal: true, code: error.code, message: error.message};
  if (code === 4001) return {terminal: true, code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'};
  return {terminal: true, code: 'FORBIDDEN', message: '您已不在该房间'};
}

/** 指数退避：1s、2s、4s…封顶 15s。 */
export function backoffDelay(attempt, options = {}) {
  const base = options.base ?? BASE_BACKOFF_MS;
  const max = options.max ?? MAX_BACKOFF_MS;
  const step = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(max, base * 2 ** step);
}

/** 版本单调：只接受 version >= 已应用版本的房间快照，防止乱序消息回退界面。 */
export function shouldApplyVersion(currentVersion, room) {
  if (!room || typeof room !== 'object') return false;
  if (!Number.isInteger(room.version)) return false;
  const current = Number.isInteger(currentVersion) ? currentVersion : -1;
  return room.version >= current;
}

export function parseSocketMessage(data) {
  if (typeof data !== 'string') return null;
  try {
    const parsed = JSON.parse(data);
    // 数组不是合法的协议消息，按无法解析处理。
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function defaultSocketUrl() {
  const loc = globalThis.location;
  if (!loc) throw new Error('缺少 location，无法推导 WebSocket 地址');
  const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${loc.host}/ws`;
}

/**
 * 房间连接。所有外部依赖（socket 工厂、定时器、回退请求）都可注入以便测试。
 * onState(room, source) 中的 source 为 'socket' | 'fallback' | 'manual'。
 * onClosed(decision) 只在终止性关闭（顶号、被移出房间）时回调，此时不再重连。
 */
export function createRoomSocket(options = {}) {
  const roomId = options.roomId;
  if (!roomId) throw new Error('缺少 roomId');
  const url = options.url ?? defaultSocketUrl();
  const token = options.token ?? null;
  const createSocket = options.createSocket ?? ((target) => new WebSocket(target));
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((id) => clearTimeout(id));
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const fetchRoom = options.fetchRoom ?? null;
  const onState = options.onState ?? (() => {});
  const onError = options.onError ?? (() => {});
  const onStatus = options.onStatus ?? (() => {});
  const onClosed = options.onClosed ?? (() => {});

  let socket = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let attempt = 0;
  let stopped = false;
  let status = 'idle';
  let version = -1;
  let room = null;
  // 本次连接的关闭原因：终止性关闭后页面靠它区分「等待重连」与「已被请出房间」。
  let closeReason = null;
  // 服务端关闭前发来的最后一条错误，用于给关闭帧配上中文原因。
  let lastError = null;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    onStatus(status);
  }

  function send(payload) {
    if (!socket || typeof socket.send !== 'function') return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function schedulePing() {
    if (stopped || pingIntervalMs <= 0) return;
    pingTimer = setTimer(() => {
      pingTimer = null;
      if (stopped) return;
      send({type: 'ping'});
      schedulePing();
    }, pingIntervalMs);
  }

  function clearPing() {
    if (pingTimer !== null) {
      clearTimer(pingTimer);
      pingTimer = null;
    }
  }

  function applyRoom(next, source) {
    if (!shouldApplyVersion(version, next)) return false;
    version = next.version;
    room = next;
    onState(next, source);
    return true;
  }

  /** 回退路径：socket 断开时用一次 GET 保证界面仍有最新状态。 */
  async function refresh() {
    if (!fetchRoom) return null;
    try {
      const next = await fetchRoom();
      if (next) applyRoom(next, 'fallback');
      return next;
    } catch (error) {
      onError({code: error?.code ?? 'NETWORK', message: error?.message ?? '获取房间状态失败'});
      return null;
    }
  }

  function handleMessage(data) {
    const message = parseSocketMessage(data);
    if (!message) return;
    if (message.type === 'state') {
      if (message.room) applyRoom(message.room, 'socket');
      return;
    }
    if (message.type === 'error') {
      lastError = message.error ?? {code: 'UNKNOWN', message: '连接返回未知错误'};
      onError(lastError);
      return;
    }
    // pong 等其余消息无需处理：收到即说明链路存活。
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffDelay(attempt);
    attempt += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    closeReason = null;
    lastError = null;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    let next;
    try {
      next = createSocket(url);
    } catch (error) {
      onError({code: 'NETWORK', message: `无法建立连接：${error?.message ?? error}`});
      scheduleReconnect();
      return;
    }
    socket = next;
    next.onopen = () => {
      attempt = 0;
      setStatus('open');
      send({type: 'subscribe', token, roomId});
      clearPing();
      schedulePing();
    };
    next.onmessage = (event) => handleMessage(event?.data);
    next.onerror = () => {
      onError({code: 'NETWORK', message: '连接异常，正在重试'});
    };
    next.onclose = (event) => {
      clearPing();
      if (stopped) return;
      const decision = closeDecision(event?.code, lastError);
      lastError = null;
      if (decision.terminal) {
        // 终止性关闭：不再重连、不再回退请求（房间接口同样会拒绝），原因交给页面显示。
        stopped = true;
        closeReason = decision;
        socket = null;
        setStatus('closed');
        onClosed(decision);
        return;
      }
      setStatus('offline');
      refresh();
      scheduleReconnect();
    };
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    /** 主动关闭：不再重连。 */
    stop() {
      stopped = true;
      closeReason = null;
      clearPing();
      if (reconnectTimer !== null) {
        clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        // 先摘掉回调：关闭中的旧连接不得再影响已停止的客户端状态。
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (typeof socket.close === 'function') socket.close();
      }
      socket = null;
      setStatus('closed');
    },
    send,
    applyRoom,
    refresh,
    get room() {
      return room;
    },
    get version() {
      return version;
    },
    get status() {
      return status;
    },
    get isOpen() {
      return status === 'open';
    },
    get attempts() {
      return attempt;
    },
    /** 终止性关闭的原因（未发生时是 null）。 */
    get closeReason() {
      return closeReason;
    },
    get isStopped() {
      return stopped;
    },
  };
}
