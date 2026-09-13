# 同桌 · 德州扑克 · 微信小程序端

原生微信小程序工程（JS / WXML / WXSS，无 web-view、无 npm 依赖、无构建步骤），
与浏览器端共用 `docs/product/contract.md` 的 HTTP + WebSocket 协议。

## 导入步骤（微信开发者工具）

1. 启动本地服务端（默认 `127.0.0.1:8787`），本工程 `project.config.json` 已关闭域名校验（`setting.urlCheck: false`），可直接访问 `http://127.0.0.1:8787`。
2. 打开微信开发者工具 → 导入项目 → 目录选择 **`apps/wechat`**（该目录本身就是小程序根目录）。
3. AppID 处可直接使用默认的 `touristappid`（游客模式 / 测试号可导入）。
4. 正式联调与发布前，必须把 `project.config.json` 的 `appid` 替换为真实 AppID，并在微信公众平台配置 `https` / `wss` 服务器域名白名单，同时把 `setting.urlCheck` 改回 `true`。
5. 后端地址只在 `config.js` 一处配置（`baseUrl` 与 `wsUrl`），其他文件不得硬编码域名或端口。

## 页面

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 大厅 | `pages/lobby/lobby` | 昵称、创建房间（0-8 机器人）、房间码加入、邀请进入（`?invite=`）、机器人练习、新手教程与规则入口；首次进入显示教程引导条 |
| 等待房间 | `pages/room/room` | 成员/座位/机器人标注、准备（附赛后完整牌序核验披露）、房主增删机器人、开始、邀请分享 |
| 牌桌 | `pages/table/table` | 座位与 D/小盲/大盲标记、行动倒计时、公共牌、自己的底牌、筹码与投入、主池边池、事件流、操作区、每手结算确认弹窗、背景音乐开关 |
| 新手教程 | `pages/tutorial/tutorial` | 六步走完「建房 → 准备 → 行动 → 公共牌 → 结算确认 → 核验」，每步附一条新手提示，另附常见问题 |
| 规则 | `pages/rules/rules` | 完整规则、牌型、最小加注、短码全押、边池、平局余数、单挑顺序、超时淘汰、每手结算确认 |
| 赛后核验 | `pages/audit/audit` | 每手承诺/贡献/牌序承诺，与本地留存承诺对照 |

主题：`app.wxss` 在 `page` 上定义一套 CSS 变量（暖白底 `#F5F4F0`、白色面板、墨色文字 `#22252A`、
单一品牌绿 `#2F6A50`，与浏览器端 `apps/web/static/styles.css` 同一套色值），页面样式一律用
`var(--x)`，`app.json` 的窗口配色同步。改配色只改这两处。

## 关键实现约定

- 令牌保存在 `wx.setStorageSync('poker.token')`，所有请求带 `Authorization: Bearer <token>`。
- WebSocket：打开后发送 `{type:'subscribe',token,roomId}`，**令牌绝不放进 URL**；只应用 `room.version >= 已应用版本` 的状态。
- 生命周期：`onHide` 关闭 socket，`onShow` 重连并重新订阅；socket 不可用时回退到 `GET /api/rooms/:id`。
- 命令：每次生成新的 `requestId`，携带 `expectedVersion`；**动作不自动重试**，`VERSION_CONFLICT` 只刷新状态。
- 随机贡献：`wx.getRandomValues` 取 32 字节 → 64 位小写十六进制；随机源不可用时不提交并显示「随机数不可用，本手使用公开默认贡献」。全部代码不使用 `Math.random`。
- 倒计时：`deadline - (Date.now() + offset)`，`offset = serverTime - Date.now()`；行动窗口长度读服务端下发的 `room.actionTimeoutMs`（当前 90 秒），不硬编码。
- 结算确认：`room.settle` 非空时弹结算窗（`utils/settle.js` 算出每座位净输赢），「确认，继续」发 `settleAck{handNo}`；服务端豁免版本检查，真人都确认即开下一手，否则由兜底倒计时自动继续。被淘汰/观战只显示结果，可手动关闭。
- 背景音乐：`utils/music.js` 用 `wx.createWebAudioContext` 实时合成（零音频文件），偏心存 `poker.music`；基础库没有该能力时开关显示「音乐：不可用」而不是假装在放。`onHide` 停止播放。
- 本地存储键统一在 `config.js` 的 `storage` 里：`poker.token` / `poker.user` / `poker.session` / `poker.commitments` / `poker.tutorialSeen` / `poker.music`。

## 登录与开发模式（无 AppID 约束）

`utils/auth.js` 先 `wx.login` 取 code，再 `POST /api/auth/wechat {code,name}`。
服务端未配置 AppID/AppSecret 时返回 `501 WECHAT_NOT_CONFIGURED`，客户端随后调用
`POST /api/auth/guest` 回退为**明确标注的游客模式**，界面显示「开发模式（游客）」。
配置真实 AppID 后同一条代码路径即为正式登录，客户端无需改动。
生产环境禁用游客（服务端拒绝），此时界面如实报错，不会假装登录成功。

## 测试

```sh
node --test apps/wechat/test/*.test.ts
npx tsc --noEmit   # 仓库根目录
```

小程序文件是 CommonJS 且带 `Page`/`App`/`wx` 全局，测试通过 `node:vm` 读取源码并注入假
`{wx, require, module, exports, getApp, Page, Component}` 与可控定时器后执行
（见 `test/harness.ts`），因此这些测试验证的是**协议与配置**，不是渲染或真机行为。

## 无 AppID / 开发者工具 / 真机时无法验证的清单

以下内容**均未验证**，本工程不声称任何一项已完成：

1. **真实 `wx.login` 登录**：需要真实 AppID/AppSecret 与可用服务端；当前只验证了 501 回退游客分支。
2. **真机分享**：`onShareAppMessage` 的返回结构在测试中断言，但分享卡片、群内打开、`?invite=` 的实际传递必须真机验证。
3. **`wss` 真机连通**：本地为 `ws://127.0.0.1:8787/ws`；真机要求 `wss` + 合法域名 + 证书，未验证。
4. **WXML/WXSS 渲染与真机交互**：所有页面布局、座位定位、按钮点击、滑动与输入均未在开发者工具或真机上运行过；浅色主题依赖的 WXSS CSS 变量（`page` 上的 `--accent` 等）也只在静态检查里验证过，**没有真机渲染截图**。
5. **背景音乐真机发声**：`wx.createWebAudioContext` 的调度逻辑只用假上下文验证（`test/music.test.ts`），真机是否出声、iOS 静音键与自动播放策略下的表现均未验证；不支持 Web Audio 的基础库上开关显示「音乐：不可用」。
6. 其他未验证项：真机基础库版本对 `wx.getRandomValues` 的支持、`onHide`/`onShow` 真机切换行为、多设备同房间重连、弱网与超时表现。

测试只覆盖：配置文件可解析、页面文件 1:1、所有 `.js` 语法有效且可装载、协议请求构造与错误映射、
登录回退分支、随机贡献编码与提交条件、结算弹窗金额与确认按钮决策、背景音乐调度与降级、
教程文案口径、WebSocket 消息分派与版本单调性。
