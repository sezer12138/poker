# 部署

本文档给出两种跑法：**本机直接跑**（开发/试玩）与 **Docker Compose**（生产形态：
服务端 + Postgres + nginx 终止 TLS）。

> 交付状态说明：仓库里提供了完整的部署配置，但**没有在真实服务器上部署过**，
> 也没有真实域名、证书、微信 AppID。下面凡涉及真实凭据或真机的步骤都标注为
> 「需你在目标环境执行」，其结果是未经验证的。

---

## 一、本机直接跑（无需数据库）

```bash
npm start                       # http://127.0.0.1:8787
```

* 开发模式默认 `POKER_STORAGE=file`，房间快照写到 `./data`（`rooms/<id>.json` + `sessions.json`），
  全部 AES-256-GCM 加密，密钥首次运行自动生成到 `data/dev.key`（权限 0600）。
* 运行服务端**不需要** `node_modules`（生产依赖 `pg` 是惰性加载的）。要跑 `npm run typecheck`
  或测试才需要 `npm ci`。
* 只监听 `127.0.0.1`：要给别人访问必须走下面的反向代理，不要直接把开发模式暴露到公网——
  开发模式的游客登录等于「谁都能进来」。

## 二、Docker Compose（生产形态）

```bash
cp .env.example .env
# 1) 生成快照密钥：openssl rand -hex 32   → 填 POKER_STORAGE_KEY
# 2) 另取一个随机口令（不要和上面相同，只用字母数字）   → 填 POSTGRES_PASSWORD
# 3) 填 POKER_WECHAT_APPID / POKER_WECHAT_SECRET（不填则无人能登录，见下）
docker compose up -d --build
docker compose ps            # server 应为 healthy
curl -s http://127.0.0.1:8787/api/health
```

要点：

* 容器内以非 root（`node`）运行，`/app/data` 是卷，`EXPOSE 8787` 且只映射到
  `127.0.0.1:8787`，公网入口只经过 nginx。
* `POKER_STORAGE=postgres`：整个房间快照加密后存进 `rooms.payload` 单行，
  保存走带版本条件的 `UPDATE ... WHERE id=$n AND version < $m`，因此多进程不会互相覆盖；
  `sessions` 表只存随机 token 与用户 id。
* **`POKER_MODE=production` 时游客登录被禁用**，登录只能走微信。若此时没有配置微信凭据，
  服务端会正常启动但**没有人能登录**——`/api/auth/wechat` 返回 503 与中文提示。
* 配置不全时服务端**拒绝启动**（而不是悄悄降级）：生产模式缺少 `POKER_STORAGE_KEY`
  或缺少 `POKER_PG_URL` 都会直接退出，错误信息说明缺哪一个。
* 想先在本机用容器试玩，可以 `POKER_MODE=development docker compose up`，
  此时游客登录可用；试完请切回生产模式。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `POKER_MODE` | `development` | `production` 禁用游客登录、要求显式密钥 |
| `POKER_HOST` / `POKER_PORT` | `127.0.0.1` / `8787` | 监听地址；容器里用 `0.0.0.0` |
| `POKER_DATA_DIR` | `./data` | 文件存储目录；容器里是 `/app/data` |
| `POKER_STORAGE` | `file` | `file` 或 `postgres` |
| `POKER_STORAGE_KEY` | 自动生成 `data/dev.key` | 64 位十六进制；**生产必须显式设置，且不要和数据库放在一起** |
| `POKER_PG_URL` | — | `postgres://user:pass@host:5432/db` |
| `POKER_WECHAT_APPID` / `POKER_WECHAT_SECRET` | — | 微信登录凭据 |
| `POKER_SESSION_TTL_DAYS` | `7` | 登录态有效期 |
| `POKER_ALLOWED_ORIGINS` | 空（不校验） | WebSocket 的 `Origin` 白名单，逗号分隔；**公网部署建议填成你的域名** |
| `POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` | `600000` / `2500` | 自动化专用，**生产模式一律忽略**并打印一行提示 |

`POKER_SETTLE_MS` / `POKER_BOT_THINK_MS` 是给 `npm run smoke` 这类自动化用的（把结算展示与
机器人思考压到几十毫秒，一场牌局几秒打完）。它们只在 `POKER_MODE=development` 下生效：
生产模式不解析、不采纳，并在启动时用中文说明「已按设计忽略」——如果你在生产日志里看到这行，
说明环境变量里混进了本地调试的值，删掉即可，服务端行为不受影响。

关于 `POKER_ALLOWED_ORIGINS`：它挡的是「陌生网页借用访客浏览器发起 WebSocket 连接」，
属于纵深防御，不是认证——真正的门槛仍是 `subscribe` 消息里的令牌与成员身份校验
（令牌只走消息体、绝不进 URL，非成员订阅拿不到任何数据并收到 403）。
留空即不校验；微信小程序不发 `Origin` 头，因此无论怎么配都不受影响。
`Upgrade` 请求只接受 `GET`，其余方法返回 405。

密钥管理：`POKER_STORAGE_KEY` 丢了等于所有房间快照都打不开（服务端会记日志并跳过损坏快照，
不会崩，但那些房间就没了）。建议放进目标平台的密钥管理（Docker secret / KMS / 部署系统的
环境变量），不要写进镜像、不要进 git、不要和数据库备份放同一处。

## 三、反向代理（HTTPS + WSS）

`deploy/nginx.conf.example` 是一份可直接改用的示例：80 跳 443、TLS 终结、
`/ws` 单独配 `Upgrade`/`Connection` 与 300s 读超时（必须大于服务端 30s 心跳，
否则安静的房间会被 nginx 先掐断）、请求体上限与 `BODY_LIMIT_BYTES`（64KB）对齐。

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/poker.conf
# 改 server_name、证书路径
sudo nginx -t && sudo systemctl reload nginx
```

证书用 Let's Encrypt（certbot）即可；微信客户端不认自签证书，且证书过期会导致小程序
所有请求失败。

## 四、微信小程序上线（需你在目标环境执行）

1. **AppID / AppSecret**：微信公众平台 → 开发管理 → 开发设置。把两者填进 `.env`
   的 `POKER_WECHAT_APPID` / `POKER_WECHAT_SECRET`。服务端用
   `https://api.weixin.qq.com/sns/jscode2session` 把 `wx.login` 的 code 换成 openid，
   登录态是自己签发的 token，**不**把 code 或 openid 交给客户端。
2. **服务器域名**：开发管理 → 开发设置 → 服务器域名，添加
   `https://你的域名`（request 合法域名）与 `wss://你的域名`（socket 合法域名）。
   域名必须已 ICP 备案、不能带端口、不能用 IP、必须有受信任证书。
3. **小程序端配置**：改 `apps/wechat/config.js` 的 `baseUrl` / `wsUrl` 为正式域名
   （`https://` 与 `wss://`）。本地 `127.0.0.1` 只在开发者工具里勾选
   「不校验合法域名」时可用，真机不行。
4. **类目与材料**：提交审核时按「游戏」类目提交，需要相应资质与内容说明。
   **棋牌类目审核严格，本仓库不对能否过审做任何承诺**；免不免费、有无充值都不改变
   审核口径，请以实际审核结果为准。
5. **隐私协议**：小程序后台需填写用户信息收集说明（本产品只收集昵称，不收集手机号）。

填好 AppID 前，小程序工程用 `project.config.json` 里的测试号（`touristappid`）导入即可
预览界面，但 `wx.login` 拿不到真实 openid、分享也无法在真机验证。

## 五、运维清单

* **日志脱敏**：服务端只打印房间 id 级别的信息，不打印 token、`serverSeed`、牌序；
  上生产前请确认没有把 `Authorization` 头写进 nginx 访问日志。
* **备份**：Postgres 用 `pg_dump` 定期备份；**密钥要单独备份**，没有密钥的备份等于一堆
  打不开的密文。文件存储模式则是整个 `data/` 目录 + 密钥。
* **重启行为**：进程重启后房间从快照恢复，牌序与已发的底牌不会变（洗牌结果在发牌前就已
  持久化），但所有截止时间会**重置**并在房间里广播中文提示——停机时间不计入玩家时限。
* **空闲关房**：房间 30 分钟无操作会被回收；`waiting` 状态的房间在房主离开且没有其他
  在线真人时进入回收倒计时。
* **容量**：单机单进程即可（房间在内存里、命令串行入队）；要横向扩容需要多进程共用
  Postgres，目前只在单进程下验证过。
* **上线自检**：`npm run smoke` 会真起一个服务端进程，依次走登录 → 建房 → 开赛 → 贡献 →
  发牌 → 打到结束 → 赛后核验 → WebSocket 订阅/顶号/关闭码，共 42 项检查。
  在目标机器上跑一遍能覆盖绝大多数接线错误（静态页、存储、定时器、WS 握手）。

## 六、上线前必须自己确认的事（未验证项）

以下内容在本仓库中**没有**验证过，交付时请自行在目标环境确认：

1. 真实微信 AppID 下的 `wx.login` → 服务端换 openid → 进房全流程；
2. 真机分享（`onShareAppMessage`）与从分享卡片进入房间；
3. 真机 `wss://` 连通与弱网下的重连表现；
4. 真实 Postgres 的读写（本仓库的 PG 适配器只用假 Db 做过单元测试，
   没有连过真实数据库）；
5. nginx/证书/备案在真实域名上的效果；
6. 微信审核能否通过。

已做过的验证（真实命令与输出）记在 `docs/verification/`。
