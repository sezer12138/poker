/**
 * 全局唯一配置：后端地址只允许在这里出现，其他文件不得硬编码域名或端口。
 * 正式发布必须改为 https/wss，并在微信公众平台配置服务器域名白名单。
 */
module.exports = {
  baseUrl: 'http://127.0.0.1:8787',
  wsUrl: 'ws://127.0.0.1:8787/ws',

  requestTimeoutMs: 10000,

  // 前台保活心跳；服务端需按契约回复 {type:'pong'}。
  wsPingIntervalMs: 20000,
  // 断线自动重连次数上限，超限后交由页面在 onShow 重连。
  wsReconnectMaxAttempts: 5,
  wsReconnectBaseDelayMs: 1000,

  // 本地令牌在该时长内直接复用，不重复请求 /api/me。
  sessionFreshMs: 60000,

  storage: {
    token: 'poker.token',
    user: 'poker.user',
    session: 'poker.session',
    // 每手承诺留存：roomId:handNo -> commitment，供赛后核验对照。
    commitments: 'poker.commitments',
    // 是否看过新手教程：看过之后大厅不再显示引导条。
    tutorialSeen: 'poker.tutorialSeen',
    // 背景音乐开关偏好，与 web 端同名同值；只影响本机播放。
    music: 'poker.music'
  },

  notice: {
    development: '开发模式：服务端未配置微信登录，当前为游客身份；真实微信登录未经真机验证。',
    guestFallback: '微信登录不可用，已回退游客模式',
    randomUnavailable: '随机数不可用，本手使用公开默认贡献',
    auditAccepted: '比赛结束后本桌成员可核验完整历史牌序，准备即表示接受',
    firstVisit: '第一次玩？先看一遍新手教程，2 分钟学会建房、行动与结算确认。'
  },

  // 主题色（与 app.wxss 的 CSS 变量、web 端 styles.css 三处保持一致）。
  // 只作说明与配置用：小程序样式不能读 JS 常量，色值仍需写在 app.wxss 的 `page` 变量里。
  brand: {
    bg: '#F4F6F5',
    surface: '#FFFFFF',
    ink: '#243C32',
    muted: '#64756D',
    accent: '#28694F',
    accentSoft: '#F0F7F2',
    felt: '#E5EEE9',
    danger: '#B3261E'
  }
};
