# 同桌 · 德州扑克

一个可以真正开局的德州扑克（无限注、9 人桌、纯娱乐筹码）：一个 Node 服务端 + 浏览器网页 +
微信小程序客户端。规则引擎与发牌流程都可核验——每一手的牌序在开牌前先承诺、由全体玩家的
随机数共同决定，赛后可逐手复算。

- **网页版**：由服务端直接托管，`npm start` 打开 http://127.0.0.1:8787 即可。
- **微信小程序**：原生小程序工程在 `apps/wechat/`，用微信开发者工具导入即可预览
  （未填 AppID 时用测试号）。

> 诚实声明：本仓库**没有**在任何真实微信账号、真实服务器上验证过登录、分享与发布，
> 微信棋牌类目审核是否通过也不做承诺。已做与未做的验证都记在 `docs/verification/`。

## 快速开始

需要 Node 26 及以上（直接用 Node 的原生 TypeScript 支持跑 `.ts`，没有构建步骤）。

```bash
npm start                 # http://127.0.0.1:8787
```

开发模式下服务端零外部依赖：不用装 `node_modules`、不用数据库，房间快照写在 `data/`
目录里（AES-256-GCM 加密，首次运行自动生成 `data/dev.key`）。

想跑类型检查或完整测试才需要装依赖：

```bash
npm ci                    # 只装 typescript/@types/*/pg
npm test                  # 全仓库测试（引擎 + fairness + bot + 服务端 + 两个客户端）
npm run typecheck         # 唯一的类型检查入口（Node 的类型剥离不做类型检查）
```

玩起来：打开首页 → 起个名字进入大厅 → 「创建一个房间」（可以带 1–8 个机器人）
→ 进房后准备 → 房主点开始。房间里可以复制邀请链接给朋友，也可以扫小程序的码加入。

## 玩法

- 9 人桌无限注德州扑克，按钮位/小盲/大盲按规则轮转（含单挑时的庄家即小盲、翻牌前先行动）。
- 支持全押、边池（主池 + 多个边池）、短码全押不构成完整加注；平局均分，余下的零头按
  「按钮左侧最近的赢家」依次发放。
- 每次行动 90 秒，超时自动过牌或弃牌；开手前有 5 秒的公平贡献窗口。
- 每手结束弹出结算窗，逐座位列出本手净输赢：所有真人点「确认，继续」后立刻开下一手，
  有人没点则由 8 秒兜底窗口自动继续，不会把牌桌卡住。
- 筹码输光即淘汰，最后一人获胜，房主可以再来一局（上一场的核验数据随场次重置）。
- 机器人（`packages/bot`）按牌力与底池赔率决策，读不到任何人的底牌。

## 公平性

每一手开始前，服务端先公布 `serverSeed` 的承诺（SHA-256），此时谁都不知道牌序；
随后每位真人玩家提交自己的 64 位十六进制随机数（浏览器/小程序用系统 CSPRNG 生成）；
收齐后服务端把自己的种子公开，牌序 = Fisher–Yates(HMAC-SHA256 字节流)，
**玩家贡献只要有一个不同，发牌顺序就完全不同**。赛后可以在核验页逐手复算：
服务端的种子能不能对上承诺、牌序能不能对上最终的 `deckCommitment`、牌序是不是真的
被发到了桌上。算法细节与限制写在 `packages/fairness/README.md`。

限制要说清楚：服务端最后一个揭示种子，所以它理论上可以挑种子——但它挑的结果**必然**会被
你提交的随机数搅乱；也就是说服务端无法把牌序固定成自己想要的样子，但可以在你之后选择
「用哪一副随机牌序」。承诺一旦公布就不能改，核验页会把不一致的地方标红。

## 目录结构

```
packages/poker-engine   纯规则引擎（无 IO、无时钟、无随机），已被冻结不再改动
packages/fairness       承诺 / 贡献 / 洗牌 / 复算
packages/bot            机器人策略（只吃一份不泄漏他人底牌的视图）
apps/server             HTTP + WebSocket 服务端、房间协调、持久化、静态托管
apps/web                浏览器客户端（无构建，原生 ES 模块）
apps/wechat             微信小程序（原生，无 web-view）
examples                simulate.ts（命令行演示）与 smoke.ts（真起服务端的端到端冒烟）
docs/product            产品契约与实施计划
docs/deploy.md          上线部署（Docker / Postgres / nginx / 微信域名）
docs/verification       每一步真实跑过的命令与输出，含未验证清单
```

架构上只有一条红线：**所有对外视图都经过 `apps/server/src/rooms/roomview.ts`**，
别人的底牌在摊牌前不可能出现在任何响应里（服务端测试里有专门的隐私用例）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `POKER_MODE` | `development` | `production` 禁用游客登录并要求显式密钥 |
| `POKER_HOST` / `POKER_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `POKER_DATA_DIR` | `./data` | 文件存储目录 |
| `POKER_STORAGE` | `file` | `file` 或 `postgres` |
| `POKER_STORAGE_KEY` | 首次运行生成到 `data/dev.key` | 64 位十六进制 AES-256 密钥；**生产必须显式设置并与数据库分开保管** |
| `POKER_PG_URL` | — | `postgres://poker:secret@postgres:5432/poker` |
| `POKER_WECHAT_APPID` / `POKER_WECHAT_SECRET` | — | 微信登录；缺省时 `/api/auth/wechat` 返回明确的中文错误 |
| `POKER_SESSION_TTL_DAYS` | `7` | 登录态有效期 |
| `POKER_ALLOWED_ORIGINS` | 空（不校验） | WebSocket 的 `Origin` 白名单，逗号分隔；小程序不带 `Origin`，不受影响 |
| `POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` | `8000` / `2500` | **仅开发模式**：结算兜底窗口与机器人思考时长（毫秒）。生产模式一律忽略并打印提示，避免把对局压到玩家来不及反应 |

`POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` 只服务于自动化（`npm run smoke` 靠它们把一场牌局压进几秒），
不需要在正常开发或部署时设置。

## 部署

见 [`docs/deploy.md`](docs/deploy.md)：`Dockerfile` + `docker-compose.yml`（服务端 + Postgres）
+ `deploy/nginx.conf.example`（HTTPS/WSS 终结与微信域名要求）。

* 生产模式（`POKER_MODE=production`）下游客登录被禁用、必须显式提供 `POKER_STORAGE_KEY`，
  配置不全时服务端拒绝启动，而不是悄悄降级。
* 棋牌类小程序在微信平台的审核风险与所需材料见部署文档，本仓库不对过审做任何承诺。

## 测试

```bash
npm test              # 全部测试
npm run test:engine   # 只跑规则引擎
npm run test:exhaustive   # 引擎穷举回归（较慢）
npm run demo          # 命令行跑一整场机器人对局
npm run smoke         # 真起一个服务端，走完整 HTTP + WebSocket 流程（42 项检查）
```

`node --test` 自带用例筛选：

```bash
node --test apps/server/test/ws.test.ts
node --test --test-name-pattern '心跳' apps/server/test/ws.test.ts
```
