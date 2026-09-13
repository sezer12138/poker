# 产品交付验证报告（阶段 A–F：网站 + 微信小程序）

状态：产品代码完成，全量测试与端到端冒烟通过；**未在真实服务器部署**，**未做微信真机验收**。
本报告只记录真实跑过的命令与输出，没跑过的一律写进「未验证项」。

## 一、交付物

| 路径 | 内容 |
|---|---|
| `packages/fairness` | 承诺 / 贡献 / HMAC 洗牌 / 复算（纯函数，无 IO） |
| `packages/bot` | 机器人策略（只吃一份不含他人底牌的视图） |
| `apps/server` | HTTP + 手写 WebSocket 服务端、房间协调器、加密持久化、静态托管 |
| `apps/web` | 浏览器客户端（无构建，原生 ES 模块，由服务端托管） |
| `apps/wechat` | 微信小程序（原生，无 web-view） |
| `Dockerfile` / `docker-compose.yml` / `deploy/nginx.conf.example` | 部署物 |
| `README.md` / `docs/deploy.md` | 快速开始与上线文档 |

## 二、验证矩阵（本次实测）

| 命令 | 结果 | 实测 |
|---|---|---|
| `npm test` | 退出码 0 | tests 413 / suites 23 / pass 413 / fail 0 / 12113ms |
| `npm run typecheck` | 退出码 0 | `tsc --noEmit` 无任何输出 |
| `npm run test:engine` | 退出码 0 | tests 67 / pass 67 / fail 0 |
| `npm run test:exhaustive` | 退出码 0 | tests 1 / pass 1 / fail 0（全部 2,598,960 种五张牌组合） |
| `npm run demo` | 退出码 0 | 三人固定牌序演示跑到 `settled`，赢家座位 0、3000 筹码 |
| `npm run smoke` | 退出码 0 | **全部 40 项通过**（真起服务端进程，走 HTTP + WebSocket） |
| `npm run smoke` 连跑 10 次 | 10 次退出码均为 0 | 每轮 40 通过 / 0 失败，总耗时约 17s（修复第四节第 3 条后） |
| `git diff --check` | 退出码 0 | 无空白错误 |

分目录实测（`node --test <dir>/*.test.ts`）：

| 目录 | tests | pass | fail |
|---|---:|---:|---:|
| `apps/server/test` | 172 | 172 | 0 |
| `apps/web/test` | 65 | 65 | 0 |
| `apps/wechat/test` | 71 | 71 | 0 |
| `packages/fairness/test` | 24 | 24 | 0 |
| `packages/bot/test` | 14 | 14 | 0 |

（另有引擎 67 项，即 `npm run test:engine`；合计 413。）

冒烟脚本 `npm run smoke` 覆盖的 40 项是真实进程级端到端：静态页 200、游客登录、
建房直接返回裸 `RoomView`、开赛、贡献、人齐即发牌并公布牌序承诺、**视图里没有 `serverSeed`
也没有未公开牌序**、本人 2 张底牌而别人为 0 张、比赛打到结束、赛中核验 403
`AUDIT_LOCKED`、赛后核验 `valid=true`、非成员 403、未登录 401、WS 订阅/顶号 4001/
坏令牌 4001/不订阅 1008/离房 4003/应用层 ping-pong。一次实测的结尾：

```
✓ 发牌后 hand 出现
✓ 本人底牌 2 张、别人底牌为空（视图就是隐私边界） — 轮到自己 24 次，越界 0 次
✓ 行动倒计时可用（deadline − serverTime） — 30 秒
✓ 比赛能打到结束 — 31 手，赢家座位 1
...
全部 40 项通过
```

「轮到自己 24 次，越界 0 次」是修复第四节第 3 条后新加的计数器：隐私与倒计时不再靠抽一帧
断言，而是在整场对局里每一次「轮到我」的视图上累计检查（见下）。

## 三、独立审查的发现与修复

两个独立子代理全新通读实现后的结论，逐条修复并各配回归测试。

### 服务端（reviewer 1）

| 问题 | 严重度 | 修复 | 证据 |
|---|---|---|---|
| **幂等回放跨用户泄漏底牌**：`idempotency` 只按 `requestId` 命中就返回首响，而响应是按人裁剪的视图（含本人底牌）。拿到别人 `requestId` 的人可以读到别人的牌 | 严重（唯一可实际利用的漏洞） | `IdempotentRecord` 增加 `userId`，回放必须同时匹配发起者；没有 `userId` 的老快照一律不回放 | `apps/server/test/idempotency.test.ts`：伪造者会拿到**自己**的视图（`viewerId` 是自己的、别人 `hole` 为 0 张、自己 2 张）。修复前临时回退该守卫，测试如期失败，确认这条测试确实钉住了漏洞 |
| 路径里 `%zz` 这类解不开的百分号编码会变成 500 | 中 | 解码失败抛 `INVALID_INPUT`（400） | `rooms.test.ts`：`/api/rooms/%zz` → 400；`/api/rooms/%41` 仍正常 404 |
| WS 升级不校验方法与来源 | 中 | 非 GET → 405（带 `Allow: GET`）；配置了 `POKER_ALLOWED_ORIGINS` 时，带陌生 `Origin` 的网页 → 403；不带 `Origin` 的客户端（小程序）不受影响 | `frame.test.ts`：POST → 405、陌生来源 403、白名单内 101、无 Origin 101 |
| 对不存在的房间发命令返回的口径与 GET 不一致 | 低 | 成员校验前先查房间，不存在 → 404 `NOT_FOUND` | `idempotency.test.ts` |
| `src/` 里出现 `Math.random`（机器人决策用） | 中 | 新增 `ids.ts: randomFloat()`（OS CSPRNG 取 `[0,1)` 均匀浮点），协调器可注入 | 红线扫描见第五节 |
| `hub.ts` 里 `connections` 表是死代码 | 低 | 删除，`remove()` 直接退订 | 全量测试保持绿 |
| 生产模式缺微信配置时静默（无人能登录却看不出来） | 中 | 启动时 `console.error` 明确中文警告说明需要 `POKER_WECHAT_APPID` / `POKER_WECHAT_SECRET` | `main.test.ts` |

### 客户端（reviewer 2）

| 问题 | 修复 | 证据 |
|---|---|---|
| 贡献提交由「本地推测自己是否参与本手」驱动，已淘汰的玩家每手仍会提交并吃一个 403 | 两个客户端一律只认服务端 `fairness.owed`（服务端算的就是「我在不在这一手」） | web `fairness.test.ts`（含缺 `owed` 的老服务端 → 不提交）、wechat `pages.test.ts`（`owed:false` → 0 次请求；服务端回 403 `FORBIDDEN` 不报错） |
| 同一房间重开一局后手号从头开始，去重键与本地留存只按房间/手号，第二局会被误判成「已提交」和「承诺被篡改」 | 去重键与留存一律带 `matchId`；核验页按 `data.matchId` 取本地记录 | web `fairness.test.ts`（`contributionKey`、`findStoredCommitment` 换场为空）、`verify.test.ts`（第二局同号不再误报篡改）、wechat `fairness.test.ts` + `pages.test.ts`（核验页第二局 `localCount=1`、`mismatchCount=0`） |
| 同一手重复广播会覆盖已留存的承诺（留存的意义就是对照「当时公布过什么」） | 首次写入胜出 | web `fairness.test.ts` |
| 短码全押被误判为合法加注（低于本轮既有下注） | 与引擎对齐：短全押必须正好推完筹码**且**高过既有下注 | 新文件 `apps/web/test/table.test.ts`（5 项） |
| `room-level` 被写成 `room-leve`；小程序筹码格式化在非法值上渲染 `NaN` | 修正 id；非法值统一显示 `—` | 全量测试 |

## 四、验证过程中新发现并修复的三个缺陷

1. **存储测试有约 15.7% 的假失败（flake）**。`storage.test.ts` 断言密文里不出现明文
   `'u1'`——两个字符的针在 base64 密文里几乎必然偶发命中。实测（2 万次加密）：

   ```
   密文长度（含外层 JSON）: 712 字节
   针「u1」(2 字符) 在 20000 次加密中命中 3140 次 → 15.70%
   针「K7M2QD」(6 字符) 在 20000 次加密中命中 0 次 → 0.00%
   针「好友局」(3 字符) 在 20000 次加密中命中 0 次 → 0.00%
   针「u-host-4f2a91」(13 字符) 在 20000 次加密中命中 0 次 → 0.00%
   ```

   修法：改查足够长、不可能偶然出现的明文（房间 id、邀请令牌、房间码、13 字符的用户 id），
   并在测试里写明为什么不用短针。修复后该文件连跑 5 次 15/15 全绿。
   这不是存储的问题，是断言写法的问题——但它在 `npm test` 里确实会产生随机红灯，
   不查掉就会让「全绿」这句话站不住。

2. **`apps/web/test/fairness.test.ts` 有类型错误**（TS2339：`owed` 不在 `Record<string, unknown> | null` 上）。
   类型收窄写法改掉后 `npm run typecheck` 无输出。

3. **`npm run smoke` 有约 25% 的假失败**。最初现象是 `✗ 比赛能打到结束 — 超时未结束`，
   连带 4 项下游失败。排查过程：在仓库外写了一个临时探针直接驱动真实服务端，并给协调器加了
   临时诊断日志逐手打印阶段迁移——`settle → nextHand 定时器 → collecting → dealing → playing
   → settled` 每一手都在推进；把墙钟放宽到 180 秒后同一场比赛 6 手打完。
   结论：**服务端没有卡住**，是一场比赛按生产节奏（每手之间 4 秒结算展示）本来就要跑很久。
   曾怀疑过的三个方向（串行队列被投毒、`winner` 判定、`closeRoom` 误触发）都读了代码逐条排除。
   临时诊断代码已全部撤除（`rg` 确认无残留）。

   修法分两半：

   - **节奏**：新增 `POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` 两个**仅开发模式**的覆盖值，
     生产模式不解析、不采纳，并在启动时打印中文提示说明「已按设计忽略」——
     静默忽略会让人以为改动生效了。口径由 `config.test.ts`（3 项）与 `main.test.ts` 新增用例钉住：
     开发读得进、非法值报错、生产连非法值都不解析。冒烟脚本以 40ms / 10ms 启动服务端；
     同时把循环上限从「最多 500 步」换成 60 秒墙钟 + 20 秒版本不动的停滞检测，
     真卡住时打印 `status/stage/hand/actor` 现场，而不是只说一句「超时未结束」。
     这两个值只影响自动化快慢，不改变任何被验证的行为。
   - **断言**：`✗ 行动倒计时可用 — -1789298247 秒` 的成因是 `roomView` 的 `deadline` 就是
     `room.deadlines.action`（没有待行动时为 `null`），而节奏压缩后固定抽样的那一帧很可能正好
     落在已经结算的一手（倒计时归零、摊牌后底牌也已公开）。这不是契约被违反，是抽样撞上了
     另一个同样合法的状态。改成**在整场对局里边打边采集**：每一次「轮到我」的视图都必须满足
     本人 2 张 / 别人 0 张、且 `deadline > serverTime`，跑完统一报告。实测那一次是
     「轮到自己 24 次，越界 0 次」——比原来抽一帧的断言覆盖面更大。

   修复后连跑 10 次：**10 轮各 40/40 通过，0 失败**（未修复前约 3/10 轮失败）。

## 五、红线扫描

```
$ rg -n "Math\.random|new Date\(|Date\.now\(|setTimeout\(|setInterval\(" packages/fairness/src packages/bot/src apps/server/src
packages/bot/src/random.ts:2: * Default randomness: the platform CSPRNG, never Math.random. ...
apps/server/src/ids.ts:27: * 机器人决策需要「随机」，但 src/ 里禁止 Math.random，这里给一个可注入的替身。
apps/server/src/rooms/roomview.ts:170:    serverTime: options.now ?? Date.now(),
```

- 前两条是注释。`packages/poker-engine/src`、`packages/fairness/src`、`packages/bot/src`
  三个纯函数层零命中（无时钟、无随机、无 IO）。
- `roomview.ts:170` 是服务端层视图构造里的兜底默认值：协调器每次调用都显式传
  `now`（注入时钟），这个 `?? Date.now()` 只在单独调用该函数时生效。它是服务端而非引擎层，
  不影响引擎纯度。

密钥 / 牌序的暴露面：

```
$ rg -n "serverSeed" apps/server/src
apps/server/src/audit.ts:11:  serverSeed: string;
apps/server/src/audit.ts:154:      serverSeed: record.round.serverSeed,
```

`serverSeed` 只出现在赛后核验响应里（核验必须公布种子才能复算承诺），且该路由有双重门控：
必须是房间成员，且 `room.status === 'finished'`，否则 403 `AUDIT_LOCKED`。视图路径里没有它。

所有对外 JSON 都经过同一个函数：

```
$ rg -n "roomView\(" apps/server/src
apps/server/src/rooms/coordinator.ts:101:    return roomView(room, userId, {online: ..., now: this.now()});
apps/server/src/rooms/coordinator.ts:215:      const body_ = JSON.stringify(roomView(draft, userId, ...));
apps/server/src/rooms/coordinator.ts:254:    this.hub.broadcast(roomId, conn => ({type: 'state', room: roomView(room, conn.userId, ...)}));
apps/server/src/rooms/roomview.ts:92:export function roomView(room: PersistedRoom, viewerId: string, ...): RoomView {
```

三个调用点（GET、命令响应、广播）全部按接收者生成视图；没有任何地方裸序列化
`Tournament` / `FairRound`。冒烟脚本用真实响应复验了这一点。

## 六、已知边界（评审提出、判定为设计取舍，未修改）

1. `expectedVersion` 在命令体里是可选的——契约要求客户端总是发送，服务端不强制。
   强制的收益是「版本冲突」更早暴露，代价是老客户端全部 400。
2. `data/sessions.json` 的并发写没有加锁；50/50 次并发登录未复现问题，但理论上存在
   后写覆盖前写的窗口。
3. `closeRoom` 删除失败时，房间会在下一次启动被重新加载（「复活」）。日志有记录。
4. `events` 在视图里截断到最后 50 条（`EVENTS_VIEW_CAP`），本地留存截断到最后 10 手
   （`HISTORY_VIEW_CAP = 10`）；**赛后核验不受这两个上限影响**——审计直接读完整的
   `fairnessHistory`，不是读视图里那份裁剪过的副本。这是有意为之：视图要小，核验要全。

## 七、未验证项（交付前必须自己确认）

以下内容本仓库**没有**验证过，文档与 README 中均已如实标注，不构成任何可用性承诺：

1. **微信真机**：`wx.login` → 服务端换 openid → 进房全流程、真机分享
   （`onShareAppMessage`）与从卡片进房、真机 `wss://` 连通与弱网重连。
   原因：目前**没有 AppID**。小程序工程用 `touristappid` 可导入预览界面，
   但拿不到真实 openid。已有的是 `node:vm` + 假 `wx` 的契约级测试，不是真机验证。
2. **真实 Postgres**：PG 适配器只用假 `Db` 做过单元测试（参数化查询、乐观版本冲突），
   没有连过真实数据库。`docker-compose.yml` 与 `Dockerfile` 也**没有在真实环境构建过**。
3. **TLS / nginx / 备案 / 证书**：`deploy/nginx.conf.example` 是示例配置，未在真实域名上跑过。
4. **浏览器人工走查**：本次未做人工点击走查；覆盖来自 65 项前端单元测试与 40 项
   进程级冒烟（冒烟只取静态页 200，不执行页面 JS 渲染）。
5. **微信审核**：棋牌类目审核口径严格，本仓库不对能否过审做任何承诺。
6. **公平性的真实对抗**：承诺协议（先承诺、后贡献、再定牌序）在测试里验证了复算一致与
   篡改可检出，但没有做「多人合谋选贡献」的博弈分析。

## 八、结论

代码与本地验收到此为止：`npm test` 413/413、`typecheck` 干净、穷举回归通过、
40 项进程级冒烟连跑 10 次 0 失败。部署配置已交付但未在真实服务器执行，
微信侧除契约测试外全部属于第七节的未验证项。

第四节记录的三处修复都发生在「验证」这一步本身：两处是测试写法（假失败与类型错误），
一处是新加的开发模式节奏开关。**产品代码本身没有因为这三处改动而改变对玩家的行为**——
`POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` 在生产模式恒为默认值。
