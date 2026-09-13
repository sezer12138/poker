/**
 * 登录：wx.login 取 code → POST /api/auth/wechat。
 * 服务端未配置 AppID/AppSecret 时回复 501 WECHAT_NOT_CONFIGURED，此时必须回退到
 * 明确标注的游客模式（POST /api/auth/guest），界面提示处于「开发模式」。
 * 真实 AppID 配置后同一条代码路径即为正式登录，客户端无需改动。
 */
const api = require('./api.js');
const config = require('../config.js');

let inflight = null;

function readStored(key) {
  try {
    const value = wx.getStorageSync(key);
    return value === '' || value === undefined ? null : value;
  } catch (e) {
    return null;
  }
}

function writeStored(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    // 存储失败不影响内存中的会话使用。
  }
}

function removeStored(key) {
  try {
    wx.removeStorageSync(key);
  } catch (e) {
    // 忽略。
  }
}

function current() {
  const session = readStored(config.storage.session);
  return session && typeof session === 'object' ? session : null;
}

function getToken() {
  const token = readStored(config.storage.token);
  return typeof token === 'string' && token.length > 0 ? token : null;
}

function getUser() {
  const user = readStored(config.storage.user);
  return user && typeof user === 'object' ? user : null;
}

function isDevelopment() {
  const session = current();
  return !session || session.mode !== 'production';
}

// 微信不提供免授权的昵称，默认名只用于同桌区分；唯一性由服务端 userId 保证。
function defaultName() {
  const stamp = Date.now() % 10000;
  return '玩家' + String(stamp).padStart(4, '0');
}

function saveSession(res, flags) {
  const session = {
    token: res.token,
    user: res.user,
    mode: res.mode || 'development',
    wechat: flags.wechat === true,
    devFallback: flags.devFallback === true,
    reason: flags.reason || '',
    notice: flags.notice || '',
    at: Date.now()
  };
  writeStored(config.storage.token, session.token);
  writeStored(config.storage.user, session.user);
  writeStored(config.storage.session, session);
  return session;
}

function loginWithWechat(name) {
  return new Promise(function (resolve, reject) {
    if (typeof wx.login !== 'function') {
      reject({ code: 'WX_LOGIN_UNAVAILABLE', message: '当前环境不支持 wx.login' });
      return;
    }
    wx.login({
      success: function (res) {
        if (res && res.code) resolve(res.code);
        else reject({ code: 'WX_LOGIN_UNAVAILABLE', message: 'wx.login 未返回 code' });
      },
      fail: function (err) {
        reject({ code: 'WX_LOGIN_UNAVAILABLE', message: (err && err.errMsg) || 'wx.login 失败' });
      }
    });
  }).then(function (code) {
    return api.authWechat(code, name);
  });
}

function loginAsGuest(name, cause) {
  return api.authGuest(name).then(
    function (res) {
      return saveSession(res, {
        wechat: false,
        devFallback: true,
        reason: (cause && (cause.code || cause.message)) || 'WX_LOGIN_UNAVAILABLE',
        notice: config.notice.development
      });
    },
    function (err) {
      // 游客也被拒绝（例如生产环境禁用游客）：两次失败都暴露给页面，界面不得宣称已登录。
      const failure = new Error(err && err.message ? err.message : '登录失败');
      failure.code = err && err.code ? err.code : 'LOGIN_FAILED';
      failure.wechatCause = cause || null;
      throw failure;
    }
  );
}

/** 真实微信登录失败时一律回退游客，但回退结果必须带上开发模式标记。 */
function login(options) {
  const opts = options || {};
  const name = String(opts.name || '').trim() || defaultName();
  return loginWithWechat(name).then(
    function (res) {
      return saveSession(res, { wechat: true, devFallback: false });
    },
    function (err) {
      return loginAsGuest(name, err);
    }
  );
}

function refreshWithMe(session) {
  return api.me().then(
    function (res) {
      return saveSession(
        { token: session.token, user: res.user, mode: res.mode },
        { wechat: session.wechat, devFallback: session.devFallback, reason: session.reason, notice: session.notice }
      );
    },
    function (err) {
      if (err && err.code === 'UNAUTHORIZED') {
        clear();
        return null;
      }
      // 服务端不可达时保留本地令牌，由页面提示重试，不静默切换身份。
      return session;
    }
  );
}

/** 页面统一入口：有新鲜会话直接复用，否则校验或重新登录；并发调用共享同一请求。 */
function ensureLogin(options) {
  const session = current();
  if (session && session.token) {
    if (Date.now() - (session.at || 0) < config.sessionFreshMs) return Promise.resolve(session);
    return refreshWithMe(session).then(function (result) {
      if (result) return result;
      return ensureLogin(options);
    });
  }
  if (!inflight) {
    inflight = login(options).then(
      function (result) {
        inflight = null;
        return result;
      },
      function (err) {
        inflight = null;
        throw err;
      }
    );
  }
  return inflight;
}

function clear() {
  removeStored(config.storage.token);
  removeStored(config.storage.user);
  removeStored(config.storage.session);
}

module.exports = {
  login: login,
  ensureLogin: ensureLogin,
  current: current,
  getToken: getToken,
  getUser: getUser,
  isDevelopment: isDevelopment,
  defaultName: defaultName,
  clear: clear
};
