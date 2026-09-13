# 德州扑克规则引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可独立运行和自动测试的淘汰赛规则引擎，验证合法行动、牌型、边池、盲注轮转及比赛终局。

**Architecture:** 引擎为不可变状态转换，不读取系统时间、网络、数据库或随机源。外部注入已经洗好的完整牌序及初始庄家，产生新状态；身份鉴权、随机承诺和广播由后续服务端阶段实现。

**Tech Stack:** TypeScript、Node.js 内置 node:test / node:assert/strict、npm；零生产依赖。当前开发机器 Node v26.3.1 / npm 11.16.0。执行时通过 npm 安装并精确锁定 TypeScript 和 @types/node；提交 lockfile，不把当前机器版本等同于最终部署环境。

**Spec:** `docs/superpowers/specs/2026-09-13-wechat-poker-design.md`（用户于 2026-09-13 确认）。

## Global Constraints

- 采用无前注的无限注德州扑克，2～9 人，默认每人 1,000 整数筹码。
- 第一版不开放自定义规则。
- 无中途补码、重购、比赛中新增参赛者。
- 规则引擎只接受状态和行动并产生下一状态及事件，不直接处理网络、时间、数据库或机器人策略。
- 下注和加注接口统一使用“本轮累计投入到多少”。
- 花色不参与比大小。
- 平局均分，多余的整数筹码从庄家左侧顺时针分配给该池并列赢家。
- 本计划只交付阶段一。微信界面、真实邀请、登录、WSS、持久化、计时调度、机器人策略及密码学洗牌核验均有后续阶段承接，不作为本阶段完成声明。

## 文件与接口约定

根目录新增 package.json、package-lock.json、tsconfig.json、.gitignore。`packages/poker-engine/src/` 下分别为 types.ts（模型）、cards.ts（牌编码）、evaluate.ts（牌型）、betting.ts（行动）、pots.ts（结算）、hand.ts（单手流程）、tournament.ts（比赛）、view.ts（可见信息）、index.ts（公共导出）。

对应测试位于 `packages/poker-engine/test/*.test.ts`；完整五张牌穷举位于 `test/exhaustive/five-card.test.ts`，独立七张牌参考实现位于 `test/reference.ts`。开发模拟入口为 `examples/simulate.ts`，说明为 `packages/poker-engine/README.md`。

统一模型（任务 1 建立；实现不得改名而不更新调用方）：

```ts
export type Card = number; // 0..51；suit=floor(c/13)，rank=c%13+2
export type SeatId = number; // 0..8，顺时针，比赛内不可变
export type Action = {type:'fold'|'check'|'call'|'allIn'} | {type:'raiseTo'; amount:number};
export type Street = 'preflop'|'flop'|'turn'|'river'|'settled';
export interface Player {
  seat:SeatId; stack:number; roundBet:number; committed:number;
  folded:boolean; hole:Card[];
  actedAt:number|null; // 最近一次行动后面对的本轮下注总额
  reopenBy:number; // 该次行动后重新开放加注需要的增加量
}
export interface Pot {amount:number; eligible:SeatId[]}
export interface Award {seat:SeatId; amount:number}
export interface Result {pots:Pot[]; awards:Award[]; refunds:Award[]}
export interface Hand {
  id:number; players:Player[]; button:SeatId; bigBlindSeat:SeatId;
  smallBlind:number; bigBlind:number; street:Street; actor:SeatId|null;
  currentBet:number; lastFullRaise:number; deck:Card[]; cursor:number;
  board:Card[]; burned:Card[]; result:Result|null;
}
export interface Legal {
  fold:boolean; check:boolean; call:number|null;
  minRaiseTo:number|null; maxRaiseTo:number|null; allIn:boolean;
}
export interface Entry {seat:SeatId; stack:number}
export interface Tournament {
  entries:Entry[]; completedHands:number; button:SeatId;
  previousBigBlind:SeatId|null; hand:Hand|null; winner:SeatId|null;
}
export type EngineEvent =
  | {type:'action'; seat:SeatId; action:Action}
  | {type:'street'; street:Street; board:Card[]}
  | {type:'settled'; result:Result};
export interface Transition<T> {state:T; events:EngineEvent[]}
```

错误使用 Error 子类 RuleError，具有 code：INVALID_INPUT、INVALID_DECK、NOT_YOUR_TURN、ILLEGAL_ACTION、HAND_FINISHED、MATCH_FINISHED。错误不能附带私密状态。参数必须运行时检查整数、范围和唯一性；测试确认失败时原对象未改变。

所有测试块使用 `import test from 'node:test'`、`import assert from 'node:assert/strict'`，按代码中的函数名称从 `../src/index.ts` 导入；嵌套穷举测试使用 `../../src/index.ts`。每任务实现后更新 index.ts 导出。

## Task 1：可执行骨架、牌编码及牌型比较

**Files:** 新增根配置、types.ts、cards.ts、evaluate.ts、index.ts、test/evaluate.test.ts。

**Interfaces:** `cards(text:string):Card[]` 接受 `As Kd Tc 2h`（花色按 c/d/h/s）；`fullDeck():Card[]` 返回 0..51；`evaluate(input:readonly Card[]):number[]` 接受 5 或 7 张唯一牌，返回 `[牌型等级0..8, ...踢脚牌]`；`compare(a:readonly number[],b:readonly number[]):number` 返回 -1/0/1。

- [x] 建立 package.json，scripts 定义如下；执行 `npm install --save-dev --save-exact typescript @types/node`，检查解析到的包版本并保留 lockfile。无自动下载生产依赖。

```json
{"private":true,"type":"module","scripts":{"test":"node --test packages/poker-engine/test/*.test.ts","test:exhaustive":"node --test packages/poker-engine/test/exhaustive/*.test.ts","typecheck":"tsc --noEmit","demo":"node examples/simulate.ts"}}
```

- [x] tsconfig.json 使用 strict、noEmit、target esnext、module nodenext、allowImportingTsExtensions、erasableSyntaxOnly、verbatimModuleSyntax；include 为 packages 和 examples。忽略 node_modules、覆盖率及日志。原生运行 TS 不做类型检查，必须单独执行 typecheck（[Node 文档](https://nodejs.org/api/typescript.html)、[TypeScript 配置](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)）。
- [x] 先写并运行下面测试，预期缺少导出而失败。

```ts
test('wheel and royal flush', () => {
  assert.deepEqual(evaluate(cards('As 2d 3c 4h 5s')), [4,5]);
  assert.deepEqual(evaluate(cards('Ts Js Qs Ks As 2h 3d')), [8,14]);
  assert.equal(compare(evaluate(cards('As Ad Kc Qh 9s')),
    evaluate(cards('Ah Ac Kd Qs 8c'))), 1);
  assert.throws(() => evaluate(cards('As As Kc Qh 9s')));
});
```

- [x] 实现五张牌的点数计数、同花和顺子检测；按牌型优先级返回数字向量。七张牌遍历 21 个五张组合并取字典序最大值。组合枚举使用独立嵌套索引，不依赖牌输入顺序。

```ts
export function compare(a:readonly number[], b:readonly number[]):number {
  for (let i=0; i<Math.max(a.length,b.length); i++) {
    const d=(a[i]??0)-(b[i]??0);
    if(d) return Math.sign(d);
  }
  return 0;
}
```

- [x] 补充全部九种牌型、双三条组成葫芦、三对选择两对、同花踢脚牌、公共牌最佳和非法牌编码的输入表；运行 `npm test`、`npm run typecheck`，预期全绿。
- [x] 提交：`git add package.json package-lock.json tsconfig.json .gitignore packages/poker-engine` 后 `git commit -m 'feat: add poker card evaluator'`。

## Task 2：下注合法性与加注权

**Files:** 新增 betting.ts、test/betting.test.ts；更新 index.ts。

**Interfaces:** `legalActions(h:Hand,seat:SeatId):Legal`；`applyBet(h:Hand,seat:SeatId,a:Action):Hand` 仅扣筹码和更新本轮状态，不推进街道；`roundComplete(h:Hand):boolean`。消耗 Task 1 模型。

- [x] 在测试文件定义完整 fixture：三位玩家 stack=990、roundBet=10、committed=10、folded=false、hole=[]、actedAt=null、reopenBy=10，Hand 的 currentBet=10、lastFullRaise=10、actor=0、button=0、bigBlindSeat=2、smallBlind=5、bigBlind=10、street=preflop、deck=fullDeck()、cursor=0、board=[]、burned=[]、result=null、id=1。fixture 仅用于下注模块，不作为发牌状态模板。
- [x] 写出核心失败测试并执行 `node --test packages/poker-engine/test/betting.test.ts`。

```ts
test('full raise and rejected under-raise preserve original', () => {
  const h=fixture(); const before=structuredClone(h);
  assert.throws(()=>applyBet(h,0,{type:'raiseTo',amount:15}));
  assert.deepEqual(h,before);
  const n=applyBet(h,0,{type:'raiseTo',amount:30});
  assert.equal(n.players[0].stack,970);
  assert.equal(n.lastFullRaise,20);
  assert.equal(n.currentBet,30);
});
```

- [x] 实现计算：callCost=min(stack,currentBet-roundBet)；完整最小目标为 currentBet+lastFullRaise，尚无完整下注时至少 bigBlind；不足额只允许投入自己的全部筹码。全押也需校验加注权，不能借 allIn 绕过禁止加注。没有可回应的对手时禁用额外下注，只保留跟注/弃牌。

```ts
const canReopen = p.actedAt === null || h.currentBet-p.actedAt >= p.reopenBy;
const maxTo = p.roundBet+p.stack;
const delta = target-p.roundBet;
// 验证通过后才在副本上应用：
p.stack -= delta; p.roundBet=target; p.committed += delta;
```

- [x] 分别写测试：A 在 100 行动后 B 全押至 150 不重开，C 全押至 200 后 A 重开；A 在 150 跟注后再遇 200 不重开。完整加注后更新 lastFullRaise；每次行动保存 actedAt 和当时 reopenBy。补充短开注、短大盲、大盲未加注仍有行动机会、NaN/小数/负数/超筹码和越权行动。
- [x] roundComplete 要求每个未弃牌且非全押玩家已行动且匹配 currentBet；孤立非全押玩家仍欠跟注时不能结束。运行该测试及 `npm run typecheck`，通过后提交 `feat: enforce betting and reopening rules`。

## Task 3：边池、退回及平分结算

**Files:** 新增 pots.ts、test/pots.test.ts；更新 index.ts。

**Interfaces:** `buildPots(players:readonly Player[]):{pots:Pot[];refunds:Award[]}`；`distribute(pots:readonly Pot[],ranks:ReadonlyMap<SeatId,number[]>,button:SeatId):Award[]`；消耗 committed/folded，不依赖 hole。

- [x] 定义 test player 工厂 `player(seat,committed,folded=false)` 返回 stack=0、roundBet=0、hole=[]、actedAt=null、reopenBy=10 和传入字段的 Player。写下列测试并运行，预期失败。

```ts
test('three contribution levels return uncalled excess', () => {
  const r=buildPots([player(0,100),player(1,300),player(2,500)]);
  assert.deepEqual(r.pots,[{amount:300,eligible:[0,1,2]},
    {amount:400,eligible:[1,2]}]);
  assert.deepEqual(r.refunds,[{seat:2,amount:200}]);
});
test('odd chip starts left of button', () => {
  assert.deepEqual(distribute([{amount:5,eligible:[0,2]}],
    new Map([[0,[1,14,13,12,11]],[2,[1,14,13,12,11]]]),0),
    [{seat:0,amount:2},{seat:2,amount:3}]);
});
```

- [x] 对正 committed 的唯一值升序分层；每层金额为 `(level-previousLevel)*contributors.length`，只有一位贡献者时形成退款，其他层按未弃牌者建立 eligible。分配按 compare 选赢家，整数商均分，余数按庄家左侧环序；输出按 seat 排序并合并同席奖金。只有一名未弃牌玩家时单手协调器直接分配全部已匹配池，不读取其牌型。
- [x] 增加弃牌投入仍进池、多人全押平局、零投入、总退款加奖池等于投入的测试；不允许生成负池或没有合法赢家的静默丢筹码结果。运行 `node --test packages/poker-engine/test/pots.test.ts` 和 typecheck，通过后提交 `feat: settle main and side pots`。

## Task 4：单手发牌、轮转和自动跑牌

**Files:** 新增 hand.ts、test/hand.test.ts；更新 index.ts。

**Interfaces:** `startHand(entries:readonly Entry[],button:SeatId,blinds:readonly [number,number],deck:readonly Card[],id:number):Hand`；`act(h:Hand,seat:SeatId,a:Action):Transition<Hand>`；`timeoutAction(h:Hand):Action`。组合 Tasks 1～3。

- [x] 写并运行失败测试：

```ts
test('heads-up fold pays winner without a board', () => {
  const h=startHand([{seat:0,stack:1000},{seat:1,stack:1000}],0,[5,10],fullDeck(),1);
  assert.equal(h.actor,0);
  const {state:n}=act(h,0,{type:'fold'});
  assert.equal(n.street,'settled');
  assert.equal(n.board.length,0);
  assert.deepEqual(n.players.map(p=>p.stack),[995,1005]);
  assert.throws(()=>act(n,1,{type:'check'}));
});
```

- [x] startHand 校验 52 张唯一牌、有效正整数筹码和不同 seat；按庄家左侧起两轮各一张发底牌，heads-up 从大盲开始。扣小盲和大盲，currentBet 使用名义大盲，短码标记通过 stack=0 表示。自动推进逻辑也在发完初始牌后执行，覆盖盲注即全押。
- [x] act 首先 applyBet，再依次判断唯一未弃牌者、仍待响应者、本轮完成及街道推进；cursor 从牌序抽牌，烧一张后依次发 3/1/1；每轮重置 roundBet、actedAt、currentBet 和 lastFullRaise。保留 committed；settled 后退款及奖金入 stack，committed/roundBet 清零，result 保留历史结果。

```ts
export function timeoutAction(h:Hand):Action {
  if(h.actor===null) throw new RuleError('HAND_FINISHED');
  return legalActions(h,h.actor).check ? {type:'check'} : {type:'fold'};
}
```

- [x] 补充三人翻前顺序、heads-up 翻后顺序、准确烧牌位置、河牌结算、全押仍待跟注、全押自动跑牌、投入与 stack 守恒、输入对象不变。timeoutAction 只选择动作，不访问 Date 或设置定时器。事件仅包含已发生的公共行动、公共牌及结算，无底牌或 deck。
- [x] 运行 `npm test`、typecheck，通过后提交 `feat: drive complete poker hands`。

## Task 5：淘汰赛、盲注和隐私视图

**Files:** 新增 tournament.ts、view.ts、test/tournament.test.ts、test/view.test.ts；更新 index.ts。

**Interfaces:** `createTournament(seats:readonly SeatId[],button:SeatId):Tournament`；`blindLevel(completedHands:number):readonly [number,number]`；`nextHand(t:Tournament,deck:readonly Card[]):Tournament`；`actTournament(t:Tournament,seat:SeatId,a:Action):Transition<Tournament>`；`playerView(h:Hand,viewer:SeatId|null):HandView`。HandView 显式字段为 id、street、button、actor、board、players（seat/stack/roundBet/committed/folded/hole）、legal（Legal|null）、result；其他字段禁止透传。

- [x] 写测试并执行，预期失败：

```ts
test('equal stacks and blind boundaries', () => {
  assert.deepEqual(createTournament([0,1,2],0).entries.map(p=>p.stack),[1000,1000,1000]);
  assert.deepEqual(blindLevel(9),[5,10]);
  assert.deepEqual(blindLevel(10),[10,20]);
  assert.deepEqual(blindLevel(10000),[4500,9000]);
});
test('viewer receives no other hole cards', () => {
  const h=startHand([{seat:0,stack:1000},{seat:1,stack:1000}],0,[5,10],fullDeck(),1);
  const v=playerView(h,0);
  assert.deepEqual(v.players[0].hole,h.players[0].hole);
  assert.deepEqual(v.players[1].hole,[]);
  assert.equal('deck' in v,false);
  assert.equal('burned' in v,false);
});
```

- [x] 将设计中的 13 级盲注表设为只读常量，级别索引 `Math.min(Math.floor(completedHands/10),12)`。createTournament 固定发 1000，校验 2～9 个唯一座位及有效庄家。nextHand 只允许初始或上一手已结算；每次只为 stack>0 的 entries 开局。
- [x] actTournament 在首次结算时同步 entries、completedHands+1、previousBigBlind，剩一人即 winner；结束比赛后拒绝 nextHand。多转少时庄家取下一存活席；首次三人转两人按 previousBigBlind 选择下一存活席为大盲。两人之后庄家交替。禁止重复结算递增手数。
- [x] playerView 白名单构造所有嵌套字段并复制数组；自己的底牌可见，其他底牌仅在公共牌已发满且非弃牌摊牌结算时可见。弃牌直接获胜的手不强制显示。viewer=null 是公共观战，无合法行动；非 actor 的玩家也不返回可执行行动。对整个对象与事件递归检查私密字段，而非仅顶层检查。
- [x] 增加四人到三人、三人到两人、盲注双双全押、同手多人淘汰、淘汰者行动被拒、新建比赛全部恢复 1000 的测试。运行 npm test/typecheck，通过后提交 `feat: add elimination tournament and private views`。

## Task 6：独立验证、穷举与可运行演示

**Files:** 新增 test/reference.ts、test/exhaustive/five-card.test.ts、test/invariants.test.ts、examples/simulate.ts、packages/poker-engine/README.md。

**Interfaces:** 测试参考函数 `referenceSeven(input:readonly Card[]):number[]` 直接从七张牌的各点数和各花色集合判定，不调用 evaluate、compare 或其内部函数；与正式返回向量一致。演示仅消费 Task 5 API。

- [x] 写穷举测试：遍历 `0<=a<b<c<d<e<52`，执行 evaluate 并按 category 计数，断言如下。命令 `npm run test:exhaustive`，初次运行也必须检查实际结果，不能将运行中视作通过。

```ts
assert.deepEqual(counts,[1302540,1098240,123552,54912,10200,5108,3744,624,40]);
assert.equal(counts.reduce((a,b)=>a+b,0),2598960);
```

- [x] 独立七张牌参考实现使用点数集合查连续五张、按花色分别判同花顺、频数取四条/葫芦/三条/两对，其余按最大五张顺序比较；预设至少 10,000 个确定性牌样本与正式函数结果对照。不能将同一五张牌评估函数包装成所谓独立参考实现。
- [x] 测试专用可复现随机发生器和 Fisher–Yates 生成牌序及合法行动；明确只用于测试，不从生产 index.ts 导出：

```ts
let seed=20260913;
function sample(n:number):number {
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  return seed%n;
}
```

- [x] 对 2～9 人各运行至少 20 场混合合法行动模拟，逐动作检查 stack+committed 总量、牌唯一性、合法 actor、有限非负整数、原状态未变化；为非终止轨迹设置明确的 100,000 动作测试上限，达到上限是失败而非强制选胜者。另用持续全押行动确保完整淘汰赛终局及总奖金 1000×人数。
- [x] examples/simulate.ts 使用固定牌序轮换和合法行动驱动一场三人比赛，打印手号、公共动作及最后胜者。显著输出“开发演示，固定牌序，不用于真实对局”。不把它命名为公平随机或机器人策略实现。
- [x] README 写清 `npm ci`、`npm test`、`npm run typecheck`、`npm run test:exhaustive`、`npm run demo`，引擎输入可信边界、整数筹码规则、累计短全押说明及阶段二接入要求。
- [x] 依次执行上述检查，保存实际测试数、穷举数、模拟结果及耗时到 README 验证记录。运行 `git diff --check`，检查无运行时随机源/时间/网络依赖。通过后提交 `test: verify poker engine invariants and exhaustive rankings`。

## 自审与阶段覆盖

设计第 2 节由任务 1～5 覆盖；第 4 节仅纯超时动作由任务 4 覆盖，计时持久化属于阶段二；第 5 节引擎隔离及私密视图由任务 4～5 覆盖；第 9 节的牌型穷举、下注边界、淘汰与守恒由任务 1～6 覆盖。余下服务器、机器人、公平协议、微信功能和真实设备验收按设计第 10 节编写后续计划，不计入规则引擎完成率。

阶段一完成必须同时满足全部任务复选项、实际命令通过及代码审查；独立参考未完成或穷举未通过时不得宣称完整验证。代码审查关注加注权恢复、孤立非全押玩家、退回筹码、单挑盲位与私密信息，必要修复后重新跑受影响检查。

执行可选择子代理分任务实现并审查，或当前会话按任务逐项实现。不存在必须由用户提供账号才能编写规则引擎的阻塞。
