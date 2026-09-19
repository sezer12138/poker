# 本地可玩产品与微信工程契约

用户已确认总体设计并要求继续交付完整产品；当前没有 AppID/服务器，先交付本地可玩界面和微信工程。沿用原游戏规则与核验披露，不重复设计审批。并行任务仅编辑独立目录，共用以下契约。

## 技术与范围
Node 原生 TypeScript 服务端，HTTP+WebSocket，静态 HTML/CSS/JS 浏览器客户端；原生微信小程序工程（JS/WXML/WXSS），无 web-view 依赖。服务端唯一裁判。开发默认仅监听127.0.0.1:8787。本地加密文件持久化；生产提供 PostgreSQL 存储适配、Docker/反代配置，生产禁用游客且需真实微信配置。缺少微信账号时不能宣称真机微信登录/分享已验收。

界面品牌“同桌 · 德州扑克”，中文、简约浅色主题（暖白底、白色面板、墨色文字、单一品牌绿点缀，色值见 `apps/web/static/styles.css` 与 `apps/wechat/app.wxss` 的 `page` 变量）；移动优先。大厅、等待房间、牌桌、新手教程、规则、结果/公平核验须可操作。免费虚拟筹码/每人1000/2–9人/90秒行动/每10手升盲。机器人明确标记，机器人思考 2.5 秒起（含抖动），明显慢于人类节奏。等待房间可添加/移除机器人，真人必须准备接受赛后完整底牌核验披露；所有真人准备后房主开始。结束后重新准备再开赛。每手结束弹结算确认窗，列出各座位本手净输赢，**所有真人确认后立即开下一手，无人确认则由 8 秒兜底窗口自动开下一手**。每手发牌前承诺+最多5秒贡献窗口，贡献不得覆盖；机器人/缺席贡献为全零。贡献齐全可提前发牌。每手种子和牌序持久化后广播。

> 本次变更为产品需求的正式修订（原契约写的是「30秒行动 / 结算展示4秒」）：行动窗口 30→90 秒、结算兜底 4→8 秒、机器人思考 1000→2500 毫秒（并新增抖动），并新增 `actionTimeoutMs`、`settle` 两个只读字段与 `settleAck` 命令。既有字段一律不变，旧客户端仍可只读兼容。背景音乐为纯客户端行为（web 用 Web Audio、小程序用 `wx.createWebAudioContext`），不属于本契约。

> 追加修订（结算亮牌）：`settle.changes` 每项新增可选的 `cards`/`category` 两个字段，并第一次明确「赢家总是亮、弃牌者不亮」的亮牌口径。同样是纯增量——两个键在没亮牌时不出现，老客户端不读它们就完全不受影响；服务端升级前落盘的老快照 `changes` 仍为 `[]`，一样不亮牌。计算在 `apps/server/src/rooms/showdown.ts`，引擎（已冻结）不参与改动。

> 追加修订（行动播报）：`events` 每项新增可选的 `action`/`amount` 两个字段，并第一次在此列出 `type` 的六个取值。仍然是纯增量——只有 `action` 事件带这两个键，老客户端不读就完全不受影响；服务端升级前落盘的老事件没有它们，两端照旧只显示文字。字段由 `apps/server/src/rooms/commands.ts` 在写事件时附上，取的是引擎事件流里本来就有的 `Action`，客户端不解析文案、也不自行推断语气。

## HTTP JSON 契约
所有成功响应直接返回对象；失败 `{error:{code,message}}` + HTTP状态。除auth、health外均需 `Authorization: Bearer <token>`。requestId须新UUID，不因重试改变。
- GET /api/health → {ok:true,mode:'development'|'production',auth:'guest'|'wechat'}
- POST /api/auth/guest {name} → {token,user:{id,name},mode:'development'}；生产拒绝。
- POST /api/auth/wechat {code,name} → {token,user:{id,name},mode:'production'}
- GET /api/me → {user:{id,name},mode}
- POST /api/rooms {name?,bots:number} → RoomView，创建者seat0，bots0..8。
- POST /api/rooms/join {code?:string,invite?:string} → RoomView；等待时分配座位，赛中只允许原参赛者重连。
- GET /api/rooms/:id → RoomView，仅房间成员。
- POST /api/rooms/:id/command {requestId,expectedVersion,type,ready?,seat?,action?,nonce?,handNo?} → RoomView。
  type: ready/start/addBot/removeBot/action/contribute/settleAck/restart/leave；removeBot也可由房主移除未开赛真人（不可自己）；ready:true表示接受披露。contribute只有本手真人可提交，绑定handNo且每席一次，忽略expectedVersion避免同时贡献竞争；其他命令版本冲突409，动作不自动重试。settleAck{handNo}表示确认本手结算：仅本手需要确认的真人可提交，绑定handNo且每席一次，同样忽略expectedVersion（多人几乎同时点确认时后到者不该吃409）；手号不是当前手、重复提交、比赛已结束或尚未结算时一律按无操作处理（返回当前视图，不报错）；真人都确认后在同一命令内直接开下一手，否则由兜底定时器到点自动继续。
- GET /api/rooms/:id/audit → {matchId,rounds:FairRound[],events:PublicEvent[],verification:{valid,errors:string[]}}，仅结束后本场成员可取；比赛中403。核验含历史弃牌，只在整场结束后公开。

WebSocket /ws：打开后发送 `{type:'subscribe',token,roomId}`（不在URL带令牌）；响应 `{type:'state',room:RoomView}`，错误 `{type:'error',error:{code,message}}`。断线后重连+重新订阅，GET房间为回退。HTTP登录令牌保存本地；刷新通过/api/me恢复。前台保持WS，微信onHide关闭onShow恢复。服务端定时器驱动机器人/超时，不依赖客户端。

## RoomView（只能使用这些字段，不接收完整内部状态）
```
{
 id, code, invite, name, version, status:'waiting'|'playing'|'finished',
 hostId, viewerId, viewerSeat:number|null,
 members:[{userId,seat,name,bot:boolean,ready:boolean}],
 matchId:string|null, hand:HandView|null,
 completedHands:number, winner:number|null,
 blinds:[number,number], nextBlinds:[number,number], handsToNextLevel:number,
 deadline:number|null, nextHandAt:number|null, serverTime:number,
 actionTimeoutMs:number,
 fairness:null|{handNo:number,commitment:string,deckCommitment:string|null,contributors:number[],owed:boolean,deadline:number},
 settle:null|{handNo:number,acks:number[],required:number[],changes:[{seat:number,delta:number,cards?:number[],category?:string|null}]},
 events:[{seq:number,handNo:number,type:string,text:string,action?:'fold'|'check'|'call'|'allIn'|'raiseTo',amount?:number}],
 notice:string
}
```
`actionTimeoutMs` 是当前行动窗口长度（毫秒），客户端画倒计时条只读它，不硬编码。`settle` 只在「一手已经结算、比赛仍在进行」的窗口内非空：`required` 是本手需要确认的真人座位（机器人不在内），`acks` 是已确认的座位，`changes` 是每座位本手净输赢（结算后的筹码减去带进本手的筹码，见服务端 `seatDeltas`）；比赛已结束时为 `null`（终局不再要求确认）。服务端升级前落盘的老快照没有这份快照数据时 `changes` 为 `[]`，客户端只显示谁赢了底池，不自行推算金额。`changes` 每项还可带 `cards`（该座位亮出的牌）与 `category`（牌型类别码）：亮牌口径是**赢家总是亮、弃牌者不亮**——公共牌发满五张且不止一人未弃牌（摊牌）时每位未弃牌者都亮「最佳五张 + 牌型」；弃牌结束时只有唯一赢家有，底牌不足五张时 `cards` 直接是底牌、`category` 为 `null`。**没亮的座位这两个键都不出现**（不是 null），客户端据「有没有 `cards`」区分亮牌与「未摊牌」。类别码是稳定契约，9 个取值：`straightFlush`/`quads`/`fullHouse`/`flush`/`straight`/`trips`/`twoPair`/`pair`/`highCard`；中文牌型名由客户端映射（web 端把 A-K-Q-J-10 的同花顺显示为「皇家同花顺」，小程序端归入「同花顺」，各自的规则页口径）。亮牌计算在服务端（`rooms/showdown.ts`，只调用引擎已导出的 `evaluate`/`compare`，引擎冻结不改）；`cards` 只包含该亮的座位，弃牌者的底牌不进任何响应。每个座位的剩余筹码客户端直接读 `hand.players[].stack`（引擎结算时已把奖池与退回写进 stack），不另发字段。
`events` 的 `type` 只有六个取值：`handStart`（每手开始）、`action`（某人行动）、`street`（发翻牌/转牌/河牌）、`settle`（一手结束）、`finish`（比赛结束）、`pause`（牌局异常暂停）。只有 `action` 事件带 `action` 与 `amount` 两个可选字段：`action` 是动作类型，`amount` 的口径是 `raiseTo` 取**本轮累计投入目标**（不是追加量）、`allIn` 取全押后的本轮投入、`call` 取本次跟注额，弃牌与过牌没有 `amount`。这两个字段是给客户端做行动播报用的语气依据（两端都按 `action` 分档，纯视觉不发声）；从 `text` 里正则抠动作太脆，所以由服务端直接给出。服务端升级前落盘的老事件没有这两个键（`undefined`，JSON 里不出现），客户端照旧只显示文字、不推断语气。
HandView与 packages/poker-engine/src/view.ts 一致。牌编码suit=floor(card/13)（♣♦♥♠），rank=card%13+2。未公开hole为空数组。筹码显示来自hand.players，淘汰成员不在本手时显示0，等待时1000。牌桌显示主池/边池结果、按钮合法状态、跟注金额、raiseTo累计目标及追加量。其他玩家/观众legal=null。status playing时fairness存在且deckCommitment=null代表正在收集随机贡献；`owed` 是服务端算出的「这一手要不要我贡献」（即我是否参加本手），客户端一律只认它，不自行推测自己该不该提交——已淘汰的座位不该每手吃一个403。浏览器用crypto.getRandomValues(32字节)，微信wx.getRandomValues；不可用则不提交、显示使用公开默认贡献，禁止Math.random替代。保留承诺到本地存储用于赛后对照。

## Fairness 模块（packages/fairness/src/index.ts）
```
type FairRound={version:'hmac-sha256-fy-v1',matchId:string,handNo:number,serverSeed:string,commitment:string,contributions:Record<string,string>,seats:number[],deckCommitment:string|null};
createRound(matchId:string,handNo:number):FairRound;
contribute(round:FairRound,seat:number,nonce:string):FairRound; // immutable, 64hex, duplicate reject
finalizeRound(round:FairRound,seats:readonly number[]):{round:FairRound,deck:number[]}; // fill missing zeros, validate sorted seats unique, finalization once
verifyRound(round:FairRound):{valid:boolean,errors:string[]}; // validates seed commitment and reconstructed deck commitment
reconstructDeck(round:FairRound):number[];
```
承诺绑定version/matchId/handNo/seed，用规范JSON数组编码避免歧义。HMAC-SHA256计数器字节流、拒绝采样无偏Fisher–Yates。种子randomBytes(32)，禁止Math.random。文档和固定测试向量可核验。不得声称独立认证或绝对防串通。

## Bot 模块（packages/bot/src/index.ts）
`chooseAction(view:HandView,random?:()=>number):Action` 仅自身视图；默认安全随机，测试注入固定值。可简单评估底牌/公共牌、底池赔率、筹码来选择合法行动，不访问Hand/deck/数据库。只在其actor座位的视图调用，非法/null legal必须抛错，服务端最终再经引擎校验。思考延迟约1秒，超时仍同规则。

## 验收
真实本地HTTP/WS测试：游客创建+第二身份加入+准备+开始+贡献+操作、越权/过期/重放、机器人自动行动、重启恢复、超时、赛后核验及赛中拒绝泄密。浏览器实际点选从大厅进入机器人房、操作一手、规则和邀请。微信工程静态校验+接口契约测试，明确无开发工具/AppID时无法宣称真机验证。所有引擎回归与穷举保持通过。
