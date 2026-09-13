# 本地可玩产品与微信工程契约

用户已确认总体设计并要求继续交付完整产品；当前没有 AppID/服务器，先交付本地可玩界面和微信工程。沿用原游戏规则与核验披露，不重复设计审批。并行任务仅编辑独立目录，共用以下契约。

## 技术与范围
Node 原生 TypeScript 服务端，HTTP+WebSocket，静态 HTML/CSS/JS 浏览器客户端；原生微信小程序工程（JS/WXML/WXSS），无 web-view 依赖。服务端唯一裁判。开发默认仅监听127.0.0.1:8787。本地加密文件持久化；生产提供 PostgreSQL 存储适配、Docker/反代配置，生产禁用游客且需真实微信配置。缺少微信账号时不能宣称真机微信登录/分享已验收。

界面品牌“同桌 · 德州扑克”，中文、深绿牌桌、奶油色牌面与黄铜色点缀；移动优先。大厅、等待房间、牌桌、规则、结果/公平核验须可操作。免费虚拟筹码/每人1000/2–9人/30秒行动/每10手升盲。机器人明确标记。等待房间可添加/移除机器人，真人必须准备接受赛后完整底牌核验披露；所有真人准备后房主开始。结束后重新准备再开赛。结算展示4秒后自动下一手。每手发牌前承诺+最多5秒贡献窗口，贡献不得覆盖；机器人/缺席贡献为全零。贡献齐全可提前发牌。每手种子和牌序持久化后广播。

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
  type: ready/start/addBot/removeBot/action/contribute/restart/leave；removeBot也可由房主移除未开赛真人（不可自己）；ready:true表示接受披露。contribute只有本手真人可提交，绑定handNo且每席一次，忽略expectedVersion避免同时贡献竞争；其他命令版本冲突409，动作不自动重试。
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
 fairness:null|{handNo:number,commitment:string,deckCommitment:string|null,contributors:number[],deadline:number},
 events:[{seq:number,handNo:number,type:string,text:string}],
 notice:string
}
```
HandView与 packages/poker-engine/src/view.ts 一致。牌编码suit=floor(card/13)（♣♦♥♠），rank=card%13+2。未公开hole为空数组。筹码显示来自hand.players，淘汰成员不在本手时显示0，等待时1000。牌桌显示主池/边池结果、按钮合法状态、跟注金额、raiseTo累计目标及追加量。其他玩家/观众legal=null。status playing时fairness存在且deckCommitment=null代表正在收集随机贡献；浏览器用crypto.getRandomValues(32字节)，微信wx.getRandomValues；不可用则不提交、显示使用公开默认贡献，禁止Math.random替代。保留承诺到本地存储用于赛后对照。

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
