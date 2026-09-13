/**
 * 应用入口：只负责登录态恢复与会话读取；房间数据一律由页面按需请求。
 */
const auth = require('./utils/auth.js');

App({
  globalData: {
    appName: '同桌 · 德州扑克'
  },

  onLaunch() {
    // 启动即尝试恢复登录；失败不阻塞页面渲染，页面会展示可重试提示。
    auth.ensureLogin().catch(function () {});
  },

  ensureLogin(options) {
    return auth.ensureLogin(options);
  },

  session() {
    return auth.current();
  }
});
