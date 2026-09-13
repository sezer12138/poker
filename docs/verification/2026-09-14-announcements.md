# 行动播报横幅与 hidden 遮罩修复验证报告（两端）

状态：bug 修复与播报功能完成，全量测试、穷举回归与进程级冒烟通过。

本报告只记录真实跑过的命令与输出。**两端的横幅动画与配色只做过逻辑层与静态检查：
既没有在浏览器里点开看过，也没有真机截图**。本仓库里没有可用的渲染环境——实测如下：

```
$ ls node_modules | grep -iE "^(playwright|puppeteer|jsdom|happy-dom)"
（无匹配）
$ command -v chromium chrome google-chrome
（PATH 里没有）
```

所以第一节的 CSS 修复只能靠静态推理加一条回归测试证明「规则写对了」，
「屏幕上确实不卡了」必须自己开浏览器看一眼（用户报的就是浏览器里的现象）。

## 一、改了什么

用户报了两件事：① web 端开局后有个弹窗一直停在屏幕中间；② 对局中每位玩家（含机器人）
每次行动都要播报——弃牌、加注多少、全押等等，最好带感情。已确认播报取**纯视觉横幅**
（两端，不发声），范围含动作、发公共牌、每手开始/结算、比赛结束与暂停。

### 1. 弹窗不消失：`[hidden]` 被作者样式压住

`setHidden()`（`apps/web/static/js/util.ts:140`）设的是 `node.hidden` 属性。UA 样式表里
确实有 `[hidden]{display:none}`，但**作者样式一律压过 UA 样式**（与选择器权重无关），
styles.css 里凡是给这些元素写了 `display` 的地方都把它盖掉了。全仓库共三处：

| 元素 | 压住 `[hidden]` 的规则 | 行 | 症状 |
|---|---|---|---|
| `#result-dialog` | `.dialog{display:flex}` | `styles.css:810` | **结算遮罩永久罩住牌桌**（用户实测到的就是它，哪怕它只是张空卡片） |
| `#action-buttons` | `.actions__row{display:grid}` | `styles.css:755` | 观战时操作按钮藏不住 |
| `#tutorial-banner` | `.banner--tip{display:flex}` | `styles.css:364` | 大厅教程引导条点不掉 |

修法是一条全局覆盖（`styles.css:36`）：

```css
/* hidden 属性必须盖过作者样式：.dialog / .actions__row / .banner--tip 都写了 display，
   而作者样式一律压过 UA 的 [hidden]{display:none}——不 !important 的话，结算弹窗的
   遮罩会永久罩住牌桌（哪怕它只是空卡片），观战时的操作按钮也藏不住。
   将来若真要让某个元素在 hidden 下仍显示，先想清楚为什么。 */
[hidden] {
  display: none !important;
}
```

改之前已核对过：新增这条规则前 styles.css 里没有任何 `[hidden]` 选择器，
也没有元素**故意**在 hidden 时显示，所以全局覆盖不会误伤。

小程序端不受影响：wxml 全走 `wx:if`，根本不设 `hidden` 属性。

引擎（`packages/poker-engine`）**冻结未改动**。

### 2. 行动播报：服务端给结构化字段，两端各画一条横幅

| 需求 | 实现 | 位置 |
|---|---|---|
| 每个动作（含机器人）都播报 | 事件流本来就逐条动作进 `room.events`，机器人走同一个 `pushEvent` | `apps/server/src/rooms/commands.ts` |
| 播「做了什么、多少钱」 | `PublicEvent` 新增可选 `action`/`amount`，只有 `type:'action'` 的事件带 | `apps/server/src/storage/storage.ts` |
| 带感情 | 五档语气（big/medium/neutral/quiet/error），按事件与动作分档，两端同一套表 | web `static/js/announce.js:27`、小程序 `utils/announce.js` |
| 两端渲染 | 牌桌中央闪一条，绝对定位 + 百分比关键帧动画；内联 `animation-duration` 与播报器停留定时器同一个数 | web `styles.css`/`table.js:414`、小程序 `table.wxss`/`table.js:489` |

让客户端从中文文案里正则抠动作太脆，所以服务端把引擎本来就有的动作类型直接附在事件上
（与 `settle.changes` 同一个纯增量先例：老快照、老客户端只读 `text` 即可）。

**语气与时长表**（两端一字不差）：

| 事件 | 档 | 停留 |
|---|---|---:|
| `action` 全押 | big（大字＋抖动＋铜色） | 2400ms |
| `action` 加注 | medium | 1800ms |
| `action` 跟注 / 过牌 | neutral | 1500ms |
| `action` 弃牌（含超时自动弃牌） | quiet | 1200ms |
| `action` 缺 `action` 字段（服务端升级前的老事件） | neutral | 1500ms |
| `street` 发公共牌 | medium | 1800ms |
| `handStart` 每手开始 | neutral | 1500ms |
| `settle` 结算 / `finish` 比赛结束 | big | 2400ms |
| `pause` 牌局暂停 | error（红） | 2200ms |
| 不认识的事件类型 | neutral | 1500ms |

**金额口径**（服务端算，客户端只显示文案）：`raiseTo` 报**本轮累计目标**（不是追加量）、
`allIn` 报全押后的本轮投入、`call` 报本次跟注额；弃牌、过牌与超时没有金额。

**队列语义**：按服务端单调递增的 `seq` 去重并按 seq 升序播；进桌首帧（含刷新、重连）
只建立基线不补播历史；一次涌入只播最近 6 条；`clear()` 清队列但**不重置** `lastSeq`
（重开房间后 seq 继续往上走，播过的不该重播）。两端模块顶层都不碰
`window`/`document`/`localStorage`/`wx`，计时器在函数体内取，因此测试能注入假时钟。

## 二、验证矩阵（本次实测）

| 命令 | 结果 | 实测 |
|---|---|---|
| `npm test` | 退出码 0 | tests 512 / suites 25 / pass 512 / fail 0 / duration_ms 11178.737167 |
| `npm run typecheck` | 退出码 0 | `tsc --noEmit` 无任何输出 |
| `npm run test:exhaustive` | 退出码 0 | tests 1 / pass 1 / fail 0（全部 2,598,960 种五张牌组合，3550.878042ms） |
| `npm run demo` | 退出码 0 | 三人固定牌序演示跑到 `settled`，最后胜者：座位 0，筹码 3000 |
| `npm run smoke` 连跑 3 次 | 3 次退出码均为 0 | 每轮结尾均为「全部 42 项通过」，real 15.92s / 16.11s / 16.26s |
| `git diff --check` | 退出码 0 | 无空白错误 |

分目录实测（`node --test <dir>/*.test.ts`；括号内为 `2026-09-13-settle-cards.md` 记录的上次值）：

| 目录 | tests | pass | fail | 对比上次 |
|---|---:|---:|---:|---:|
| `apps/server/test` | 198 | 198 | 0 | 198（断言补在既有用例里，不增条数） |
| `apps/web/test` | 96 | 96 | 0 | 86（+10） |
| `apps/wechat/test` | 113 | 113 | 0 | 103（+10） |
| `packages/fairness/test` | 24 | 24 | 0 | 24 |
| `packages/bot/test` | 14 | 14 | 0 | 14 |
| `packages/poker-engine` | 67 | 67 | 0 | 67（引擎未被本次改动触碰） |
| 合计 | 512 | 512 | 0 | 492（+20） |

## 三、服务端字段确实从 HTTP 响应里出来了

上一份报告为了证明亮牌字段真的下发，临时写了个探针。这次不用：新增断言读的就是
`result.body.events`——真起服务端、真发 HTTP 请求拿回来的响应体
（`apps/server/src/rooms/roomview.ts:190` 把 `room.events` 原样切片下发，不挑字段，
所以不存在「视图把这俩键漏了」的中间层）。涉及的四条既有用例实测全绿：

```
$ node --test --test-reporter=spec apps/server/test/actions.test.ts
  ✔ 行动写入中文事件流，并且只有自己看得到底牌 (37.395417ms)
  ✔ 弃牌立即结束本手并结算 (38.8665ms)
  ✔ 跟注推进到翻牌并公开公共牌 (86.041875ms)
  ✔ 全押后本手在发牌时即结算，不会卡死 (45.17175ms)
  ✔ 行动对局外人不可见：越权读取一律 403 (37.634375ms)
（共 10 项，pass 10 / fail 0）
```

四条用例里补的断言分别是：

- 跟注：`action==='call'`、`amount===5`（本次投入）。
- 弃牌：`action==='fold'`、`amount===undefined`（**不编一个金额出来**）；同一条用例还断言结算事件
  身上 `'action' in event === false`、`'amount' in event === false`——非动作事件不出现这两个键。
- 发翻牌：`'action' in event === false`（街道事件既不是动作也没有金额）。
- 单挑全押：`action==='allIn'`、`amount===1000`（全押后的本轮投入）。

超时与机器人各一条（`apps/server/test/timeout.test.ts`、`apps/server/test/bots.test.ts`）：
超时自动弃牌 `action==='fold'` 且无金额；机器人兜底动作带 `action`，
即**客户端播报不看是谁下的**，真人与机器人同一套字段。

## 四、新增测试明细（20 项）

两个新测试文件（各 8 项，用例名一一对应，两端映射必须一致）：

| 文件 | 覆盖 |
|---|---|
| `apps/web/test/announce.test.ts`（新） | 语气映射（六类事件 × 五种动作 + 老事件缺 `action` + 未知类型退回中性）、每档时长为正且全押比弃牌停得久、首帧只建基线、乱序按 seq 升序播、顺序播放与播完收起、一次涌入只播最近 6 条、`clear` 不重播、缺省 display 与空输入无害 |
| `apps/wechat/test/announce.test.ts`（新） | 同上，用 harness 注入的假时钟驱动 `timers.tick(ms)` |

其余 4 项补在既有文件里：

| 文件 | 数量 | 覆盖 |
|---|---:|---|
| `apps/web/test/pages.test.ts` | 2 | `[hidden]` 覆盖规则存在（弹窗遮罩 bug 的回归钉）、`.announce` 基础样式/语气档/关键帧存在 |
| `apps/wechat/test/pages.test.ts` | 2 | 首帧 applyRoom 只建基线不播、之后新事件按语气档进 `data.announce` 并由定时器收回 |

`[hidden]` 那条回归测试是特意加的：这个 bug 的根因在 CSS 与 UA 样式的优先级关系上，
单看 `table.js` 完全正常，只有一条「styles.css 里必须有这条规则」的断言能防止将来有人
清理样式时把它删掉。

## 五、红线扫描

仓库约定的扫描范围（比 CLAUDE.md 的要求广——规则要求的只是引擎 `src/`）：

```
$ rg -n "Math\.random|new Date\(|Date\.now\(|setTimeout\(|setInterval\(" \
     packages/fairness/src packages/bot/src apps/server/src
packages/bot/src/random.ts:2: * Default randomness: the platform CSPRNG, never Math.random. ...
apps/server/src/ids.ts:27: * 机器人决策需要「随机」，但 src/ 里禁止 Math.random，这里给一个可注入的替身。
apps/server/src/rooms/roomview.ts:204:    serverTime: options.now ?? Date.now(),
apps/server/src/rooms/timers.ts:13:      const handle = setTimeout(callback, Math.max(0, delayMs));
```

**这里要更正上一份报告**：`2026-09-13-settle-cards.md` 把这段扫描的输出记成了 3 条命中、
没有 `timers.ts`。实测是 4 条——`timers.ts` 自 `a677b6c`（服务端那次提交）起就存在且从未修改过，
即上一份报告的那段输出是沿用更早一版、没有重跑。本次以实测为准，四条逐条都有正当理由：
两条注释、一条视图构造的兜底默认值（协调器每次都显式传注入时钟）、
一条是 `realTimers()`——服务端本来就需要行动超时，`setTimeout` 被包在一个可注入的
`TimerApi` 后面，测试注入假时钟。本次改动新增的代码（`commands.ts` 的 `pushEvent` 与
两端 `announce.js`）**在这条扫描里零命中**：它们不读时钟、不取随机、不碰 IO。

客户端的模块顶层约束另外扫一遍：

```
$ rg -n "window|document|localStorage|\bwx\." apps/web/static/js/announce.js apps/wechat/utils/announce.js
apps/web/static/js/announce.js:2:// 约束与 music.js 一致：模块顶层不碰 window/document，定时器在函数体内取，
```

唯一命中是一行注释。`Math.random`/`Date`/`setInterval` 在两个播报模块里同样零命中。

## 六、未验证项（交付前必须自己确认）

1. **两端横幅的人工走查**：动画观感、全押那一档的抖动幅度、big 档与结算弹窗同时在屏上时的
   压层（web `z-index:45` 盖过弹窗 40、小程序 101 盖过 100），都只做过逻辑层与静态检查，
   **没有真的看过**。本仓库没有浏览器或 DOM 实现（见开头实测），做不了渲染级验证。
2. **web `[hidden]` 修复本身**：规则写对了、有回归测试盯着，但「浏览器里空弹窗确实不再遮住牌桌」
   只有用户能确认。同一根因的另外两处（观战按钮、教程引导条）也要顺手看一眼。
3. **小程序 `prefers-reduced-motion` 支持**：WXSS 里写了这条媒体查询，小程序 webview 是否支持未验证；
   真机若不支持，动画照常播，关掉动画的降级只是不生效，不影响功能。
4. **断网兜底期间的层叠上下文**：`.table-surface.is-disconnected{opacity:0.75}`（`styles.css:472`）
   会生成层叠上下文，结算播报（z-index 45）可能落在那时的弹窗之下。只有走 GET 兜底那段时间可达，
   先记录不改。
5. **小程序真机渲染**：本工程第一处 `@keyframes`，连同内联 `animation-duration` 与
   `wx:if` 重建节点的组合，都只在静态检查里验证过，没有开发者工具或真机截图。
6. **冒烟不覆盖横幅**：42 项里没有一条读 `events[].action` 或检查 CSS，横幅的端到端表现
   不在进程级冒烟的覆盖范围内（服务端字段由第二节的 HTTP 断言覆盖）。
7. 上一份报告（`2026-09-13-settle-cards.md`）与 `2026-09-13-ux-polish.md` 的未验证项依然全部有效：
   微信真机登录与分享、`wss` 真机连通、真实 Postgres、TLS/nginx/备案、微信审核、
   小程序背景音乐真机发声、公平性的真实对抗分析——本次没有触碰这些路径。

## 七、结论

两个问题都落地了：web 端那个永久停留在中间的弹窗，根因是 `[hidden]` 被作者样式压住
（同一根因共三处，一次修完并加了回归测试）；行动播报做成了两端一致的纯视觉横幅——
服务端在事件流上附结构化 `action`/`amount`，两端按同一张五档语气表播放，
按 `seq` 去重、首帧只建基线、一次最多播 6 条。

`npm test` 512/512（+20）、`typecheck` 干净、穷举回归 1/1、42 项进程级冒烟连跑 3 次 0 失败、
`git diff --check` 无空白错误。引擎冻结未动，服务端字段是纯增量修订（契约里已补上
`type` 的六个取值与两个新字段的口径）。

第六节列出的未验证项——尤其是两端横幅的人工走查、web 弹窗修复的实际观感、
以及小程序真机上的首处 CSS 动画——交付前必须自己确认。
