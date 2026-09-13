/**
 * WebSocket 封装：令牌只通过 subscribe 消息发送，绝不放进 URL。
 * 状态按 version 单调应用；断线自动重连并重新订阅，页面在 onHide 关闭、onShow 重连。
 */
const config = require('../config.js');

function readToken() {
  try {
    const token = wx.getStorageSync(config.storage.token);
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (e) {
    return null;
  }
}

/**
 * 终止性关闭码：服务端明确表示这个身份不该再连了，重连只会被同样地关掉。
 * 4001 = 顶号或登录失效，4003 = 已不在该房间（被移出/已离开）。
 */
const TERMINAL_CLOSE_CODES = [4001, 4003];

/**
 * 关闭码策略。服务端在关闭前会先发一条 error 消息，原因优先取它；
 * 没有错误消息时按关闭码给兜底中文文案，绝不把「正在重连」显示给已被请出房间的玩家。
 */
function closeDecision(code, error) {
  if (TERMINAL_CLOSE_CODES.indexOf(code) < 0) {
    return {
      terminal: false,
      code: (error && error.code) || 'WS_ERROR',
      message: (error && error.message) || '连接已断开，正在重连'
    };
  }
  if (error && error.code && error.message) {
    return { terminal: true, code: error.code, message: error.message };
  }
  if (code === 4001) {
    return { terminal: true, code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间' };
  }
  return { terminal: true, code: 'FORBIDDEN', message: '您已不在该房间' };
}

function createClient(options) {
  const opts = options || {};
  const roomId = opts.roomId;

  let task = null;
  let opened = false;
  let manualClose = false;
  let attempts = 0;
  let pingTimer = null;
  let retryTimer = null;
  let lastAppliedVersion = -1;
  let messageSeq = 0;
  // 服务端关闭前发来的最后一条错误，用于给关闭帧配上中文原因。
  let lastError = null;

  function notify(name, payload) {
    const fn = opts[name];
    if (typeof fn === 'function') fn(payload);
  }

  function send(message) {
    if (!task || !opened) return false;
    try {
      task.send({ data: JSON.stringify(message) });
      return true;
    } catch (e) {
      return false;
    }
  }

  function subscribe() {
    const token = opts.token !== undefined ? opts.token : readToken();
    // 订阅消息是唯一携带令牌的通道。
    send({ type: 'subscribe', token: token, roomId: roomId });
    notify('onSubscribe');
  }

  function stopPing() {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      send({ type: 'ping' });
    }, config.wsPingIntervalMs);
  }

  function clearRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function handleMessage(data) {
    messageSeq += 1;
    let message = null;
    try {
      message = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'state') {
      const room = message.room;
      if (!room || typeof room.version !== 'number') return;
      // 契约：仅当 room.version >= lastAppliedVersion 时应用，乱序推送不回退界面。
      if (room.version < lastAppliedVersion) return;
      lastAppliedVersion = room.version;
      notify('onState', room);
      return;
    }
    if (message.type === 'error') {
      lastError = message.error || { code: 'WS_ERROR', message: '连接返回错误' };
      notify('onError', lastError);
      return;
    }
    if (message.type === 'pong') {
      notify('onPong');
    }
  }

  function cleanup() {
    opened = false;
    task = null;
    stopPing();
  }

  function scheduleReconnect() {
    if (manualClose) return;
    if (attempts >= config.wsReconnectMaxAttempts) {
      notify('onStatus', 'failed');
      return;
    }
    attempts += 1;
    const delay = config.wsReconnectBaseDelayMs * attempts;
    clearRetry();
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, delay);
    notify('onStatus', 'reconnecting');
  }

  function connect() {
    if (task) return;
    manualClose = false;
    lastError = null;
    notify('onStatus', 'connecting');
    let socket = null;
    try {
      // URL 只含服务地址，令牌在 open 后经 subscribe 发送。
      socket = wx.connectSocket({ url: config.wsUrl });
    } catch (e) {
      notify('onStatus', 'error');
      notify('onError', { code: 'WS_ERROR', message: '无法建立连接', detail: e });
      scheduleReconnect();
      return;
    }
    task = socket;
    task.onOpen(function () {
      opened = true;
      attempts = 0;
      notify('onStatus', 'open');
      subscribe();
      startPing();
      notify('onOpen');
    });
    task.onMessage(function (res) {
      handleMessage(res && res.data);
    });
    task.onError(function (err) {
      notify('onStatus', 'error');
      notify('onError', { code: 'WS_ERROR', message: '连接出错', detail: err });
    });
    task.onClose(function (res) {
      const decision = closeDecision(res && res.code, lastError);
      lastError = null;
      cleanup();
      notify('onStatus', 'closed');
      notify('onClose');
      if (decision.terminal) {
        // 终止性关闭：不再重连（重连也会被同样地关掉），原因交给页面显示。
        manualClose = true;
        notify('onClosed', decision);
        return;
      }
      scheduleReconnect();
    });
  }

  function close() {
    manualClose = true;
    clearRetry();
    stopPing();
    const current = task;
    cleanup();
    if (current) {
      try {
        current.close({ code: 1000 });
      } catch (e) {
        // 已断开的连接再次关闭会抛错，忽略。
      }
    }
  }

  return {
    connect: connect,
    close: close,
    send: send,
    handleMessage: handleMessage,
    isOpen: function () {
      return opened;
    },
    getVersion: function () {
      return lastAppliedVersion;
    },
    messageCount: function () {
      return messageSeq;
    }
  };
}

module.exports = {
  createClient: createClient
};
