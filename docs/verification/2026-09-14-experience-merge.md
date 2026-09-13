# 从 codex/poker-play-experience 合并 UI / 教程 / 配色的验证报告

状态：四个提交全部落地，全量测试、穷举回归、类型检查与进程级冒烟通过。

本报告只记录真实跑过的命令与输出。**新版主题、椭圆毡面与弹窗教程都只做过逻辑层与静态检查：
没有在浏览器里点开看过，也没有真机截图**——本仓库没有可用的渲染环境，实测见上一份报告
（`2026-09-14-announcements.md` 开头：`node_modules` 里没有 playwright/puppeteer/jsdom，
`PATH` 里没有 chromium）。本节所有「渲染效果如何」的结论都必须自己开浏览器确认。

## 一、搬了什么，以及为什么不整分支合并

另一个 agent 在 `origin/codex/poker-play-experience` 上超出合并基点 `aac7489` 的全部成果
就是**一个提交** `f255f75`（30 个文件，+563/−162）。用户认为它的 UI、新手教程与整体色彩更好。

**没有采用整分支合并**，因为它的服务端确认模型与本仓库冲突：

| | 它 | 本仓库 |
|---|---|---|
| 确认命令 | `confirmHand` | `settleAck` |
| 结算字段 | `room.settlement` | `settle.required / acks / changes` |
| 下一手 | 全员确认才开，无兜底 | 全部确认或 **8 秒兜底**自动开 |

它重写的 `renderResultDialog` 读的是 `room.settlement`——在本仓库的服务端上这个字段不存在，
所以**照搬会静默失效**：不报错，但整个结算界面消失（`confirmHand` 在本仓库同样零处，
`rg -c confirmHand apps/server/src apps/web/static/js` → `confirmHand: 0 处`）。
我们自己的结算弹窗功能更全（净输赢 + 亮牌 + 牌型 + 剩余筹码 + 8 秒兜底），
所以只移植它的**视觉**。用户已确认三个范围决定：两端都换新配色、弹窗教程替换独立页、保持 8 秒兜底。

**明确不合并**（写在这里免得以后有人以为漏了）：它的 `confirmHand` / `room.settlement` /
`handStartingStacks` / nextHand 恒为 null 的确认模型、它的机器人节奏（3~7 秒锚定版）、
它的音乐实现、`docs/product/contract.md` 的相关修订。我们已有等价或更好的实现，
且用户只点了 UI / 教程 / 色彩。

引擎（`packages/poker-engine`）**冻结未改动**。

## 二、改了什么

四个提交（每个末尾 Co-Authored-By）：

| 提交 | 内容 |
|---|---|
| `191cc2b` | `style(web)`：浅灰底 + 低饱和绿主题（styles.css、5 个 HTML 的 theme-color 与 `?v=20260914` 缓存版本号、pages.test.ts） |
| `ace8e3e` | `feat(web)`：弹窗式新手教程（含跟注练习），替换独立教程页 |
| `55f815a` | `feat(web)`：结算弹窗加亮牌方式 eyebrow 与待确认名单（服务端零改动） |
| `3f3e86d` | `style(wechat)`：小程序调色板对齐 web 新主题 |

净改动 27 个文件，+736/−378。

### 1. 配色：把它的色值映射到我们的变量名上，两端一起改

它的分支里旧变量名（`--felt` / `--cream` / `--brass`）已经被改成新色值，但**没动小程序**。
本仓库的变量体系（`--bg/--surface/--ink/--accent/…`）两端共享且注释承诺「两端同一套色值」，
所以做法是**把色值搬到我们的变量名上，两端同步改**，并顺手补上它缺的跨端断言（见第四节）。

| 变量 | 旧值 | 新值 |
|---|---|---|
| `--bg` | `#F5F4F0` | `#F4F6F5` |
| `--surface-2` | `#F0EEE9` | `#EDF3EF` |
| `--line` / `--line-strong` | `#E6E3DC` / `#D5D1C7` | `#D9E3DD` / `#CDDDD3` |
| `--ink` / `--muted` | `#22252A` / `#6E737B` | `#243C32` / `#64756D` |
| `--accent` / `--accent-dark` / `--accent-soft` | `#2F6A50` / `#245741` / `#EAF2EE` | `#28694F` / `#256B50` / `#F0F7F2` |
| `--danger` / `--ok` | `#C0564F` / `#2F7A57` | `#B3261E` / `#287455` |
| `--felt` | 不存在 | **新增** `#E5EEE9` |
| `--card-back` | 硬编码 `#678778` | **新增变量**，两端各改一处 |
| `--brass` | `#A98A4E` | **删除**（它去掉了金色/铜色），用法全部改 `var(--accent)` |

小程序额外做了：`.brass` 类改名 `.accent`（6 处引用，含 `audit.js` 的 `matchClass`）、
`.felt` 用 `var(--felt)`、`.mini-card.back` 改纯色、`pos.sb/bb` 与 `announce--big` 由铜改绿、
结算遮罩换成与 web 同一层墨绿、`app.json` 与 `config.js` 的 brand 说明表同步。

### 2. 弹窗教程替换独立页

- 六步：认识牌桌 → 一手牌怎样进行 → 轮到你时怎么选（90 秒）→ 用最好的五张牌比大小（`cardElement` 摆出五张公共牌）→ **练习一次跟注**（答对才放行）→ 看懂结算。
- 第五步的题面是「本轮你已经投入 10，对手把下注提到 30，想继续留在牌局里需要再投入多少？」，
  正解 20；答错给纠正提示且**不解锁下一步**，答对才给鼓励并解锁。这正是新手最容易把
  「累计目标」当成「追加量」算错的一步。
- 第六步按**我们的**服务端口径写：真人各点一次「确认，继续」，有人不点则 8 秒兜底自动开下一手。
- 首次进大厅自动弹一次（`body[data-tutorial-auto="true"]` + `localStorage` 里的 `poker_tutorial_seen`），
  五个页面顶栏的 `[data-tutorial]` 按钮随时能重看；关掉（含 Esc、跳过）都记「看过了」。
- 用原生 `<dialog>.showModal()`：弹层由浏览器放进 top layer，不必和结算弹窗（z-index 40）、
  播报横幅（45）抢层叠。
- 教程页的「常见问题」不是教程步骤，移到规则页（`RULES_FAQ`）；大厅一次性引导横幅
  `#tutorial-banner` 与 `.banner--tip` 样式随之删除。

### 3. 结算弹窗：eyebrow 与待确认名单（服务端零改动）

- eyebrow 说**亮牌方式**：只剩一个没弃牌的人 =「弃牌收池」，否则「摊牌比牌」。计划里这条本来
  写的是「第 N 手 · 结算」，但弹窗标题已经是「第 N 手结算」，照抄会连着两行都说第 7 手；
  改成说亮牌方式既保住了那条定位小标，又正好解释「为什么大半行写着未摊牌」。
- 待确认名单点名到人：`settle.required` 减去 `settle.acks`，名字取自现有 `room.members`，
  `online === false` 的标「（离线）」——断线的人确实还在等兜底倒计时，不标出来「已确认 1/3」
  看着像牌桌卡死了。老快照没有 `online` 字段时按在线处理，成员不在视图里就退化成座位号。
- 不发新命令、不改 `settleAck`，小程序这轮的结算弹窗不动。

## 三、验证矩阵（本次实测）

| 命令 | 结果 | 实测 |
|---|---|---|
| `npm test` | 退出码 0 | tests 521 / suites 25 / pass 521 / fail 0 / duration_ms 11312.967 |
| `npm run typecheck` | 退出码 0 | `tsc --noEmit` 无任何输出（日志 29 字节，全是 npm 自己的命令回显） |
| `npm run test:exhaustive` | 退出码 0 | tests 1 / pass 1 / fail 0（全部 2,598,960 种五张牌组合，3539.589833ms） |
| `npm run demo` | 退出码 0 | 三人固定牌序演示跑到 `settled`，最后胜者：座位 0，筹码 3000 |
| `npm run smoke` | 退出码 0 | 「全部 41 项通过」（上一份报告是 42 项，少的正是已删除的静态页 `/tutorial.html`） |
| `git diff --check` | 退出码 0 | 无空白错误 |

分目录实测（`node --test <dir>/*.test.ts`；括号内为 `2026-09-14-announcements.md` 记录的上次值）：

| 目录 | tests | pass | fail | 对比上次 |
|---|---:|---:|---:|---:|
| `apps/server/test` | 198 | 198 | 0 | 198（本次服务端零改动） |
| `apps/web/test` | 104 | 104 | 0 | 96（+8） |
| `apps/wechat/test` | 114 | 114 | 0 | 113（+1） |
| `packages/fairness/test` | 24 | 24 | 0 | 24 |
| `packages/bot/test` | 14 | 14 | 0 | 14 |
| `packages/poker-engine` | 67 | 67 | 0 | 67（引擎未被本次改动触碰） |
| 合计 | 521 | 521 | 0 | 512（+9） |

## 四、测试改动明细（+9）

| 文件 | 数量 | 覆盖 |
|---|---:|---|
| `apps/web/test/tutorial.test.ts`（重写） | 8 | 六步数据完整、口径（90 秒 / 8 秒兜底 / 虚拟筹码不可提现）、第四步牌值合法且公共牌自己就凑成一对 A、练习题正解与众数判分、`shouldAutoOpen` 四种情形、顶栏按钮打开弹窗、「答错不放行、答对才放行、走完记标记」全流程、跳过与回退 |
| `apps/web/test/pages.test.ts` | +2 | 五个页面都有 `[data-tutorial]` 入口与教程脚本、且不再指向已删除的 `tutorial.html`；`<dialog>` 关闭态的 `:not([open])` 覆盖规则存在 |
| `apps/web/test/table.test.ts` | +2 | eyebrow 的两种取值（弃牌收池 / 摊牌比牌）；待确认名单（点过的人去掉、离线标注、老快照不误标、成员离桌退化成座位号） |
| `apps/wechat/test/static.test.ts` | +1 | 两端调色板 15 个共用变量逐值比对 |

弹窗行为是用一个**极小的假 DOM** 驱动的（只实现 `append` / `replaceChildren` / `textContent` /
`showModal` / `close` / `addEventListener`），跑得起来「翻页、答错不放行、关掉记标记」这类状态机；
**它不能证明真实浏览器里的观感**——这一点见第八节。

跨端调色板断言是这次特意补的：两边的注释一直写着「改色要两端一起改」，但那只是注释。
现在 `app.wxss` 与 `styles.css` 的 15 个共用变量必须逐值相等，改一头不改另一头会直接失败。

那条 `<dialog>` 的覆盖规则同理：作者样式里的 `display:flex` 会压过 UA 的
`dialog:not([open]){display:none}`，少了它，按 Esc 关掉的教程会一直盖在页面上——
和上一份报告里 `[hidden]` 那个 bug 是**同一个坑**，所以同样用一条静态断言钉住。

## 五、服务端确实按预期分发（HTTP 实测）

起真服务端（`node apps/server/src/main.ts`，默认 127.0.0.1:8787），直接 curl：

```
$ curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:8787/tutorial.html
HTTP 404                     ← 独立教程页真的没了，不是只删了文件没重建索引

$ for p in /index.html /room.html /table.html /rules.html /audit.html; do curl -s -o /dev/null -w "$p HTTP %{http_code}\n" http://127.0.0.1:8787$p; done
/index.html    HTTP 200
/room.html     HTTP 200
/table.html    HTTP 200
/rules.html    HTTP 200
/audit.html    HTTP 200
```

`index.html` 从服务端拿回来的关键标记（`curl -s .../index.html | grep -o ...`）：

```
data-tutorial
data-tutorial-auto="true"
theme-color" content="#F4F6F5"
styles.css?v=20260914
tutorial.js?v=20260914
```

样式表确实带上了新变量与新规则（`curl -s .../static/styles.css?v=20260914 | grep -c` → `15` 行命中
`--felt: / .tutorial-dialog / .eyebrow`），且 `static/js/table.js` 从服务端取回的字节与磁盘一致：

```
$ curl -s http://127.0.0.1:8787/static/js/table.js?v=20260914 > /tmp/served-table.js
$ cmp -s /tmp/served-table.js apps/web/static/js/table.js && echo 一致
一致（34351 字节）
```

缓存版本号是可用的：`static.ts` 只按 `url.pathname` 找文件，`?v=` 不会破坏文件解析
（`GET /static/styles.css?v=20260914` → 200）。

## 六、红线扫描

仓库约定的扫描范围（比 CLAUDE.md 的要求广——规则要求的只是引擎 `src/`）：

```
$ rg -n "Math\.random|new Date\(|Date\.now\(|setTimeout\(|setInterval\(" \
     packages/fairness/src packages/bot/src apps/server/src
packages/bot/src/random.ts:2: * Default randomness: the platform CSPRNG, never Math.random. The server injects
packages/server/src/ids.ts:27: * 机器人决策需要「随机」，但 src/ 里禁止 Math.random，这里给一个可注入的替身。
packages/server/src/rooms/roomview.ts:204:    serverTime: options.now ?? Date.now(),
packages/server/src/rooms/timers.ts:13:      const handle = setTimeout(callback, Math.max(0, delayMs));
```

与上一份报告一致（两条注释、一条视图构造的兜底默认值、一条可注入的 `TimerApi`）。
**本次改动在这条扫描里零新增命中**：四个提交里服务端一个字都没动。

客户端的模块顶层约束另外扫一遍（本次改动的四个 JS 模块）：

```
$ rg -n "window|document|localStorage|\bwx\." \
     apps/web/static/js/tutorial.js apps/web/static/js/rules.js \
     apps/web/static/js/lobby.js apps/web/static/js/table.js
apps/web/static/js/lobby.js:2:// 模块顶层不访问 window/document/localStorage。
apps/web/static/js/lobby.js:177:if (typeof document !== 'undefined') {
apps/web/static/js/lobby.js:178:  document.addEventListener('DOMContentLoaded', () => {
apps/web/static/js/rules.js:2:// 内容以数据形式给出，再由 renderRules 渲染；模块顶层不访问 window/document。
apps/web/static/js/rules.js:184:if (typeof document !== 'undefined') {
apps/web/static/js/rules.js:185:  document.addEventListener('DOMContentLoaded', () => {
apps/web/static/js/tutorial.js:3:// 内容以数据形式给出、渲染只走 util/cards；模块顶层不碰 window/document，
apps/web/static/js/tutorial.js:89: * 浏览器里由页面自己调（见文件末尾），测试里注入假 document/存储。
apps/web/static/js/tutorial.js:92:  const doc = options.document ?? globalThis.document;
apps/web/static/js/tutorial.js:197:if (typeof document !== 'undefined') {
apps/web/static/js/tutorial.js:198:  document.addEventListener('DOMContentLoaded', () => initTutorial());
apps/web/static/js/table.js:1:// 牌桌页逻辑。约束：模块顶层不访问 window/document/localStorage，浏览器启动放在函数内。
apps/web/static/js/table.js:792:      document.addEventListener('click', () => music.start(), {once: true});
apps/web/static/js/table.js:803:  window.addEventListener('pagehide', () => music.stop());
apps/web/static/js/table.js:835:if (typeof document !== 'undefined') {
apps/web/static/js/table.js:836:  document.addEventListener('DOMContentLoaded', () => {
```

`tutorial.js` 的两处与 `rules.js` / `lobby.js` / `table.js` **完全相同**：一处是
`typeof document !== 'undefined'` 包住的启动钩子（Node 里 import 不会执行），一处是函数体内
注入假 DOM 的口子。`Math.random` / `Date` / `setInterval` 在本次改动的四个模块里零命中
（`rg` 在 `apps/web/static/js` 的命中全部来自本次未触碰的 `music.js`、`fairness.js`、
`format.js` 与 `table.js` 既有的时钟校正代码）。

## 七、与批准计划的偏离（逐条）

1. **`.actions` 保持 `position: sticky`**（计划写的是改回 `relative`）：移动端按钮够得着比
   「不悬浮」重要，且这一栏是带模糊背景的卡片，实测没有遮住底牌的场景。
2. **结算卡片用 `min(580px, 100%)` / `padding: 24px`**（计划抄的是 `calc(100% - 28px)` / `28px`）：
   那是原生 `<dialog>` 的写法，我们的遮罩本来就在 16px 内边距的 flex 覆盖层里，照抄会双重缩进。
3. **`.tutorial__tip` 底色用 `var(--surface-2)`**（计划写的是 `#F1F6F3`）：`--surface-2` 新值
   `#EDF3EF` 就是同一个色系，用变量比再硬编码一个十六进制好。
4. **eyebrow 的内容**：见第二节第 3 条——计划写「第 N 手 · 结算」，实际改成亮牌方式（不重复标题）。
5. **`.banner--tip` 整块删掉**（计划说「若无人使用则删」）：删掉后 `[hidden]` 那条规则的注释里
   提到的三个「违规者」只剩两个，注释同步改了。
6. **新增 `--card-back` 变量**（计划没提）：小程序有一条既有测试禁止 `app.wxss` 之外的样式表出现
   十六进制色值，而 web 的 `.card--back` 本来就是硬编码——提到变量上后两端共用同一个名字，
   也进了一致性断言。
7. **两端结算文案出现一处差异**（计划里只说 web 打磨）：web 多了「还在等：甲、乙（离线）」这行，
   小程序的结算弹窗仍是「已确认 N/M」。原因是计划明确要求小程序这轮只换色，
   而要补齐得同时改 `settle.js` / `table.js` / `table.wxml` 与两份测试——留到小程序那轮再说。
8. **冒烟项数 42 → 41**：删掉 `/tutorial.html` 这一项后的自然结果，不是漏跑。

计划里其余部分（配色映射表、五个提交的拆分、明确不合并的清单）按原样执行。

## 八、未验证项（交付前必须自己确认）

1. **两端新版主题的人工走查**：椭圆毡面 `border-radius: 42% / 26%` 与座位百分比定位是否吻合、
   浅灰底上白色面板的层次、`--card-back` 的牌背观感——全部只做过静态推理与断言，
   **没有真的看过**。本仓库没有浏览器或 DOM 实现（见开头），做不了渲染级验证。
2. **弹窗教程在浏览器里的交互**：首访自动弹出、六步翻页、跟注练习答错后不放行、
   Esc / 点击遮罩关闭、`<dialog>` 在 top layer 里压过结算弹窗与播报横幅——逻辑层有假 DOM 测试，
   **真实浏览器行为没验证过**。移动端尤其要看：弹窗高度 84vh 与键盘弹出的相互作用。
3. **结算弹窗新增的两处**：eyebrow 与「还在等」在真实数据下的排版（名字多时会不会换行、
   离线标记是否醒目），以及它们与 8 秒兜底倒计时的视觉竞争。
4. **小程序真机渲染**：整轮换色后的对比度（尤其 `.accent` 文字与 `--felt` 上的白色小牌）、
   与 `app.json` 导航栏配色的衔接，都只在静态检查里验证过。
5. **老快照兼容只做了单侧检查**：`members[].online` 缺失时按在线处理有测试，
   但真实的老快照（服务端升级前落盘、经 GET 兜底下发）没有造过。
6. **跨端调色板断言只比 15 个共用变量**：web 还有 `--danger-soft` / `--radius` / `--shadow` 等
   小程序没有的变量，它们不在比对范围内。
7. 上一份报告（`2026-09-14-announcements.md`）、以及更早的 `2026-09-13-settle-cards.md` /
   `2026-09-13-ux-polish.md` 的未验证项依然全部有效：微信真机登录与分享、`wss` 真机连通、
   真实 Postgres、TLS/nginx/备案、微信审核、小程序背景音乐真机发声、公平性的真实对抗分析、
   两端横幅的人工走查——本次没有触碰这些路径。

## 九、结论

另一个 agent 分支上值得要的三件事——配色、弹窗教程、结算弹窗观感——都搬进来了，
服务端语义一行未动（`settleAck` + 8 秒兜底保持原样），它那套依赖 `room.settlement` 的实现
没有照搬（照搬会静默失效）。配色改成两端共用一套变量并加了逐值断言；教程从独立页收敛成
五页都能打开的弹窗，并给「跟注要补多少」加了一道答错不放行的练习题；结算弹窗补上亮牌方式
与待确认名单。

`npm test` 521/521（+9）、`typecheck` 干净、穷举回归 1/1、41 项进程级冒烟 0 失败、
服务端 HTTP 实测（`/tutorial.html` 404、五个页面 200、下发字节与磁盘一致）、
`git diff --check` 无空白错误。引擎冻结未动。

第八节列出的未验证项——尤其是两端新主题的人工走查与弹窗教程在真实浏览器里的交互——
交付前必须自己确认。
