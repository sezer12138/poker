# 可验证公平模块(`hmac-sha256-fy-v1`)

每手发牌前公布服务器种子承诺,收集真人客户端的公开贡献,再按固定算法派生牌序。整场比赛结束后,任何参赛者都能用本模块重算每一手牌,核对该手实际发出的牌。

本模块是纯函数:不读取系统时间、网络或环境,唯一随机来源是 `node:crypto` 的 `randomBytes`(生成服务器种子)。

## 接口

```ts
type FairRound = {
  version:'hmac-sha256-fy-v1'; matchId:string; handNo:number;
  serverSeed:string; commitment:string;
  contributions:Record<string,string>; seats:number[]; deckCommitment:string|null;
};

createRound(matchId, handNo): FairRound
contribute(round, seat, nonce): FairRound            // 不可变;每席一次;重复/非法抛 FairnessError
finalizeRound(round, seats): {round, deck}           // 仅一次;缺位填全零;升序唯一座位
verifyRound(round): {valid, errors:string[]}         // 从不抛错;问题以中文描述返回
reconstructDeck(round): Card[]                       // 用公开记录重算牌序
```

`FairnessError.code`:`INVALID_INPUT`、`INVALID_SEAT`、`INVALID_NONCE`、`INVALID_SEATS`、`DUPLICATE_CONTRIBUTION`、`ALREADY_FINALIZED`。服务端按 code 映射 HTTP 状态,不直接展示英文消息。

## 算法(逐字定义)

1. **种子承诺**:`serverSeed = randomBytes(32)`;`commitment = SHA-256(JSON.stringify(["hmac-sha256-fy-v1", matchId, handNo, serverSeed]))`。用纯 JSON 数组绑定版本、比赛、手号与种子,没有对象键序歧义。发牌前先公布 `commitment`。
2. **贡献**:每位真人客户端提交 32 字节随机数的 64 位小写十六进制字符串。未提交者按规则使用公开的全零贡献(`'0'.repeat(64)`),机器人贡献固定为零,不能被运营方当作挑选结果的自由度。
3. **字节流**:记 `contribList = [[seat, nonce], ...]`(按座位升序),`context = JSON.stringify(["hmac-sha256-fy-v1", matchId, handNo, contribList])`。
   `block(i) = HMAC-SHA256(key = serverSeed, context ‖ counterBE32(i))`,`i = 0, 1, 2, ...`,逐字节消费。
4. **拒绝采样**:取一个字节 `b`,令 `k = floor(256 / r) * r`;若 `b < k` 返回 `b % r`,否则丢弃并取下一字节。区间 `r ≤ 52` 时接受率 ≥ 79.7%,结果精确均匀。
5. **洗牌**:Fisher–Yates,`for i in 0..50: j = i + uniform(52 - i)`,交换。
6. **牌序承诺**:`deckCommitment = SHA-256(canonicalJson(deck))`,牌与 `matchId`/`handNo`/`seats`/贡献一并落库后才发底牌。

## 测试向量(独立生成)

向量由 `node:crypto` 独立实现生成,不由本模块自算。生成命令(在仓库根目录执行):

```sh
node -e 'const{createHash,createHmac}=require("node:crypto");const V="hmac-sha256-fy-v1",Z="0".repeat(64);const sh=s=>createHash("sha256").update(s,"utf8").digest("hex");const deck=(m,h,seed,cl)=>{const k=Buffer.from(seed,"hex"),ctx=Buffer.from(JSON.stringify([V,m,h,cl]),"utf8");let b=Buffer.alloc(0),o=0,c=0;const nx=()=>{if(o>=b.length){const cb=Buffer.alloc(4);cb.writeUInt32BE(c++,0);b=createHmac("sha256",k).update(ctx).update(cb).digest();o=0}return b[o++]};const u=r=>{const L=Math.floor(256/r)*r;for(;;){const x=nx();if(x<L)return x%r}};const a=[...Array(52).keys()];for(let i=0;i<51;i++){const j=i+u(52-i);[a[i],a[j]]=[a[j],a[i]]}return a};const s="00".repeat(32);console.log(sh(JSON.stringify([V,"match-a",1,s])));const d=deck("match-a",1,s,[[0,Z],[1,Z],[2,Z]]);console.log(JSON.stringify(d.slice(0,10)),sh(JSON.stringify(d)))'
```

输出(与 `test/round.test.ts` 中的常量一致):

```text
788489f253963ea96d3f8f196f8599b38a597977f8de222787431f2984f36414
[42,17,26,43,6,30,50,28,15,44] 3a04fab60ba71a668404418cb282ac600064d56779dc24f6a16a55e4a098648b
```

第二组向量:`match-b` 第 7 手,种子 `11…11`,座位 0 贡献 `22…22`、座位 1 贡献 `33…33`、座位 2 全零,得牌序承诺 `a3114c5623d0731323926dfda1a4b1448f9598ce1327e6d42e14cc92b82b4cd0`。

## 能证明什么,不能证明什么

- 能发现:事后改动种子、贡献、牌序或承诺;缺少贡献未按全零处理;座位列表被改写;牌序不是 52 张唯一牌。
- 不能证明:运营方绝对诚实、没有选择性拒绝服务,也不能阻止玩家在外部通信中串通。分布测试(见 `test/distribution.test.ts`)只是补充检查,不能代替密码学正确性,也不构成第三方公平认证。
- 完整复算会暴露包括弃牌在内的历史底牌,所以只在整场比赛结束后向本场成员开放,开赛前必须向所有真人说明并取得同意。
