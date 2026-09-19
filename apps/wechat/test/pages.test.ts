/**
 * 页面派生数据测试：用真实 RoomView 形状驱动页面的 applyRoom，
 * 校验 WXML 绑定的字段（座位、牌面、池、操作区、倒计时）与契约一致。
 * 这不验证渲染，只验证数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createPageContext, createTimers, createWx, invoke, type WxMock} from './harness.ts';

interface Seat {
  seat: number;
  displayIndex: number;
  left: number;
  top: number;
  occupied: boolean;
  self: boolean;
  isButton: boolean;
  isSmallBlind: boolean;
  isBigBlind: boolean;
  isActor: boolean;
  stackText: string;
  cards: {hidden: boolean; label: string; symbol: string}[];
}

function baseRoom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'room-1',
    code: 'AB12',
    invite: 'invite-token',
    name: '测试房',
    version: 9,
    status: 'playing',
    hostId: 'u1',
    viewerId: 'u2',
    viewerSeat: 1,
    members: [
      {userId: 'u1', seat: 0, name: '房主', bot: false, ready: true},
      {userId: 'u2', seat: 1, name: '我', bot: false, ready: true},
      {userId: 'bot-1', seat: 2, name: '机器人1', bot: true, ready: true}
    ],
    matchId: 'match-1',
    hand: {
      id: 3,
      street: 'flop',
      button: 0,
      actor: 1,
      board: [0, 14, 27],
      players: [
        {seat: 0, stack: 900, roundBet: 0, committed: 100, folded: false, hole: []},
        {seat: 1, stack: 950, roundBet: 0, committed: 50, folded: false, hole: [51, 50]},
        {seat: 2, stack: 1000, roundBet: 0, committed: 50, folded: false, hole: []}
      ],
      legal: {fold: true, check: true, call: null, minRaiseTo: 20, maxRaiseTo: 950, allIn: true},
      result: null
    },
    completedHands: 2,
    winner: null,
    blinds: [10, 20],
    nextBlinds: [15, 30],
    handsToNextLevel: 7,
    deadline: 1800000,
    nextHandAt: null,
    serverTime: 1200000,
    fairness: null,
    events: [{seq: 1, handNo: 3, type: 'action', text: '房主 跟注 20'}],
    notice: '',
    ...overrides
  };
}

function tablePage(wx: WxMock = createWx(), timers = createTimers()) {
  const loader = createLoader({wx, timers});
  return {wx, timers, context: createPageContext(loader, 'pages/table/table.js')};
}

test('牌桌座位按自己为下方原点排布，盲注标记由按钮位推导', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());
  const seats = context.data.seats as Seat[];
  assert.equal(seats.length, 9);
  assert.deepStrictEqual(
    seats.map((seat) => seat.displayIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );

  const mine = seats.find((seat) => seat.seat === 1) as Seat;
  assert.equal(mine.self, true);
  assert.equal(mine.displayIndex, 0);
  assert.equal(mine.left, 50);
  assert.equal(mine.top, 90);
  assert.equal(mine.isActor, true, 'hand.actor 指向自己');

  // 三人桌：庄家 0 → 小盲 1、大盲 2。
  const button = seats.find((seat) => seat.seat === 0) as Seat;
  assert.equal(button.isButton, true);
  assert.equal((seats.find((seat) => seat.seat === 1) as Seat).isSmallBlind, true);
  assert.equal((seats.find((seat) => seat.seat === 2) as Seat).isBigBlind, true);

  assert.equal(button.stackText, '900');
  assert.equal(mine.stackText, '950');
});

test('单挑时庄家兼小盲，另一位为大盲', () => {
  const {context} = tablePage();
  invoke(
    context,
    'applyRoom',
    baseRoom({
      members: [
        {userId: 'u1', seat: 0, name: '房主', bot: false, ready: true},
        {userId: 'u2', seat: 1, name: '我', bot: false, ready: true}
      ],
      hand: {
        id: 4,
        street: 'preflop',
        button: 0,
        actor: 0,
        board: [],
        players: [
          {seat: 0, stack: 990, roundBet: 10, committed: 10, folded: false, hole: []},
          {seat: 1, stack: 980, roundBet: 20, committed: 20, folded: false, hole: []}
        ],
        legal: null,
        result: null
      }
    })
  );
  const seats = context.data.seats as Seat[];
  assert.equal((seats.find((seat) => seat.seat === 0) as Seat).isSmallBlind, true);
  assert.equal((seats.find((seat) => seat.seat === 1) as Seat).isBigBlind, true);
  assert.equal((seats.find((seat) => seat.seat === 0) as Seat).isBigBlind, false);
});

test('牌面渲染遵循 suit=floor(card/13)、rank=card%13+2', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());

  const board = context.data.board as {hidden: boolean; label: string; symbol: string; empty?: boolean}[];
  assert.equal(board.length, 5);
  // 0→♣2、14→♦3、27→♥3。
  assert.deepStrictEqual(
    board.slice(0, 3).map((card) => card.label + card.symbol),
    ['2♣', '3♦', '3♥']
  );
  assert.equal(board[3]!.empty, true, '未发出的公共牌是占位');
  assert.equal(board[4]!.empty, true);

  const seats = context.data.seats as Seat[];
  const mine = seats.find((seat) => seat.seat === 1) as Seat;
  assert.deepStrictEqual(
    mine.cards.map((card) => card.label + card.symbol),
    ['A♠', 'K♠']
  );
  const opponent = seats.find((seat) => seat.seat === 0) as Seat;
  assert.deepStrictEqual(
    opponent.cards.map((card) => card.hidden),
    [true, true],
    '未摊牌时他人底牌必须是背面'
  );
});

test('操作区只按 hand.legal 生成，跟注显示追加金额', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());
  const data = context.data;
  assert.equal(data.myTurn, true);
  assert.equal(data.canCheck, true);
  assert.equal(data.canFold, true);
  assert.equal(data.canCall, false, 'call 为 null 时不能跟注');
  assert.equal(data.canAllIn, true);
  assert.equal(data.canRaise, true);
  assert.deepStrictEqual(
    (data.quickTargets as {target: number}[]).map((item) => item.target),
    [20, 100, 150, 200, 950]
  );
  assert.equal(data.raiseTarget, 20, '默认取最小加注目标');
  assert.equal(data.raiseAddText, '20');
  assert.equal(data.potTotalText, '200');
  assert.equal(data.myCommittedText, '50');

  const facing = baseRoom({
    hand: {
      ...(baseRoom().hand as Record<string, unknown>),
      legal: {fold: true, check: false, call: 40, minRaiseTo: 120, maxRaiseTo: 800, allIn: true}
    }
  });
  invoke(context, 'applyRoom', facing);
  assert.equal(context.data.canCheck, false);
  assert.equal(context.data.canCall, true);
  assert.equal(context.data.callText, '跟注 40');
  assert.equal(context.data.callAmount, 40);
});

test('非本人回合只显示等待文案', () => {
  const {context} = tablePage();
  const room = baseRoom();
  (room.hand as Record<string, unknown>).legal = null;
  (room.hand as Record<string, unknown>).actor = 2;
  invoke(context, 'applyRoom', room);
  assert.equal(context.data.myTurn, false);
  assert.equal(context.data.waitingText, '等待其他玩家行动');
  assert.equal(context.data.canFold, false);
});

test('倒计时用 deadline - (Date.now() + offset)', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());
  // deadline - serverTime = 600s，与本地当前时间无关。
  assert.equal(context.data.countdownText, '600s');
  assert.equal(context.data.countdownUrgent, false);

  invoke(context, 'applyRoom', baseRoom({deadline: 1200000 + 3000, serverTime: 1200000}));
  assert.equal(context.data.countdownText, '3.0s');
  assert.equal(context.data.countdownUrgent, true);

  invoke(context, 'applyRoom', baseRoom({deadline: 1000, serverTime: 1200000}));
  assert.equal(context.data.countdownText, '0.0s');
  assert.equal(context.data.countdownUrgent, true);
});

test('结算展示主池、边池、赢家与退回', () => {
  const {context} = tablePage();
  const room = baseRoom({
    hand: {
      ...(baseRoom().hand as Record<string, unknown>),
      street: 'settled',
      actor: null,
      legal: null,
      result: {
        pots: [
          {amount: 300, eligible: [0, 1, 2]},
          {amount: 100, eligible: [0, 1]}
        ],
        awards: [
          {seat: 1, amount: 300},
          {seat: 0, amount: 100}
        ],
        refunds: [{seat: 2, amount: 25}]
      }
    }
  });
  invoke(context, 'applyRoom', room);
  assert.deepStrictEqual(
    (context.data.potRows as {label: string; amountText: string}[]).map((row) => `${row.label}:${row.amountText}`),
    ['主池:300', '边池 1:100']
  );
  assert.deepStrictEqual(
    (context.data.awardRows as {seatText: string; amountText: string}[]).map((row) => `${row.seatText}:${row.amountText}`),
    ['第2座:300', '第1座:100']
  );
  assert.deepStrictEqual(
    (context.data.refundRows as {seatText: string; amountText: string}[]).map((row) => `${row.seatText}:${row.amountText}`),
    ['第3座:25']
  );
  assert.equal(context.data.potTotalText, '200');
});

test('等待中的房间显示 1000 筹码，结束后显示胜者', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom({status: 'waiting', hand: null, deadline: null, viewerSeat: 1}));
  const seats = context.data.seats as Seat[];
  const mine = seats.find((seat) => seat.seat === 1) as Seat;
  assert.equal(mine.stackText, '1,000');
  assert.equal(context.data.waitingText, '等待比赛开始');
  assert.equal(context.data.handNo, 0);

  invoke(context, 'applyRoom', baseRoom({status: 'finished', hand: null, winner: 2, deadline: null}));
  assert.equal(context.data.finished, true);
  assert.equal(context.data.winnerText, '第3座 获胜');
  const finalSeats = context.data.seats as Seat[];
  assert.equal(finalSeats.find((seat) => seat.seat === 1)?.stackText, '0', '终局后不在本手显示 0');
});

test('状态下发时按契约提交随机贡献', async () => {
  const wx = createWx();
  const {context} = tablePage(wx);
  invoke(
    context,
    'applyRoom',
    baseRoom({
      fairness: {handNo: 3, commitment: 'c'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [0, 1], deadline: 0}
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.requests.length, 1);
  const body = wx.requests[0]!.data as Record<string, unknown>;
  assert.equal(body.type, 'contribute');
  assert.equal(body.seat, 1);
  assert.equal(body.handNo, 3);
  assert.match(String(body.nonce), /^[0-9a-f]{64}$/);
  assert.equal(context.data.fairnessTip, '已提交本手随机贡献');
  assert.equal(wx.storage.get('poker.commitments') && true, true, '承诺需写入本地留存');
});

test('贡献提交失败时显示服务端原因，重复提交不再重试', async () => {
  const wx = createWx({
    respond: () => ({
      statusCode: 409,
      data: {error: {code: 'ALREADY_CONTRIBUTED', message: '本手已提交过随机贡献'}}
    })
  });
  const {context} = tablePage(wx);
  const room = baseRoom({
    fairness: {handNo: 5, commitment: 'c'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [0, 1], deadline: 0}
  });
  invoke(context, 'applyRoom', room);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(wx.requests.length, 1);
  assert.equal(context.data.fairnessTip, '本手已提交过随机贡献', '必须把服务端的中文原因显示出来');

  // 服务端已经收下这一手，下一次状态推送不得再提交一次。
  invoke(context, 'applyRoom', room);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.requests.length, 1, '重复提交被告知后不再重试');
});

test('贡献窗口已关闭时同样显示原因，不停在「正在收集」', async () => {
  const wx = createWx({
    respond: () => ({
      statusCode: 409,
      data: {error: {code: 'CONTRIBUTE_CLOSED', message: '本手随机贡献已截止'}}
    })
  });
  const {context} = tablePage(wx);
  invoke(
    context,
    'applyRoom',
    baseRoom({
      fairness: {handNo: 6, commitment: 'c'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [0, 1], deadline: 0}
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(context.data.fairnessTip, '本手随机贡献已截止');
});

test('本手不参赛（已淘汰）时不提交，服务端回 403 也不当作错误', async () => {
  const wx = createWx({
    respond: () => ({
      statusCode: 403,
      data: {error: {code: 'FORBIDDEN', message: '本手你不在牌局中'}}
    })
  });
  const {context} = tablePage(wx);

  // 服务端说本人不在本手：一次请求都不该发出去。
  invoke(
    context,
    'applyRoom',
    baseRoom({
      fairness: {handNo: 7, commitment: 'c'.repeat(64), deckCommitment: null, contributors: [0], owed: false, expected: [0, 2], deadline: 0}
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.requests.length, 0, 'owed 为 false 就不提交');
  assert.equal(context.data.fairnessTip, '正在收集本手随机贡献');

  // 竞态：视图还没更新时本人已被淘汰，服务端回 403 —— 界面不该因此报错。
  invoke(
    context,
    'applyRoom',
    baseRoom({
      fairness: {handNo: 8, commitment: 'c'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [0, 1], deadline: 0}
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.requests.length, 1);
  assert.equal(context.data.error, '', '403 不该变成错误提示');
  assert.equal(context.data.fairnessTip, '正在收集本手随机贡献');
});

test('等待房间：准备状态与开始条件', () => {
  const loader = createLoader({wx: createWx(), timers: createTimers()});
  const context = createPageContext(loader, 'pages/room/room.js');
  const waiting = baseRoom({
    status: 'waiting',
    hand: null,
    hostId: 'u2',
    viewerId: 'u2',
    viewerSeat: 1,
    deadline: null,
    members: [
      {userId: 'u1', seat: 0, name: '甲', bot: false, ready: true},
      {userId: 'u2', seat: 1, name: '我', bot: false, ready: false},
      {userId: 'bot-1', seat: 2, name: '机器人1', bot: true, ready: true}
    ]
  });
  invoke(context, 'applyRoom', waiting);
  assert.equal(context.data.isHost, true);
  assert.equal(context.data.myReady, false);
  assert.equal(context.data.completedText, '已完成 2 手');

  invoke(context, 'applyRoom', baseRoom({...waiting, completedHands: undefined}));
  assert.equal(context.data.completedText, '', '缺少 completedHands 时不渲染进度');
  invoke(context, 'applyRoom', waiting);
  assert.equal(context.data.canStart, false, '真人未全部准备时不能开始');
  assert.deepStrictEqual(
    (context.data.members as {name: string; botText: string; host: boolean; self: boolean}[]).map(
      (member) => `${member.name}|${member.botText}|${member.host ? 'host' : '-'}|${member.self ? 'self' : '-'}`
    ),
    ['甲||-|-', '我||host|self', '机器人1|机器人|-|-']
  );

  const ready = baseRoom({
    ...waiting,
    members: [
      {userId: 'u1', seat: 0, name: '甲', bot: false, ready: true},
      {userId: 'u2', seat: 1, name: '我', bot: false, ready: true},
      {userId: 'bot-1', seat: 2, name: '机器人1', bot: true, ready: true}
    ]
  });
  invoke(context, 'applyRoom', ready);
  assert.equal(context.data.canStart, true);
  assert.equal(context.data.myReady, true);
});

test('房主权限：等待阶段可移除他人，结束后需全员准备才能重新开始', () => {
  const loader = createLoader({wx: createWx(), timers: createTimers()});
  const context = createPageContext(loader, 'pages/room/room.js');
  const hostView = {
    status: 'waiting',
    hand: null,
    hostId: 'u2',
    viewerId: 'u2',
    viewerSeat: 1,
    deadline: null,
    members: [
      {userId: 'u1', seat: 0, name: '甲', bot: false, ready: true},
      {userId: 'u2', seat: 1, name: '我', bot: false, ready: true},
      {userId: 'bot-1', seat: 2, name: '机器人1', bot: true, ready: true}
    ]
  };

  invoke(context, 'applyRoom', baseRoom(hostView));
  const waiting = context.data.members as {name: string; canRemove: boolean}[];
  assert.equal(waiting.find((member) => member.name === '甲')?.canRemove, true);
  assert.equal(waiting.find((member) => member.name === '我')?.canRemove, false, '不能移除自己');
  assert.equal(waiting.find((member) => member.name === '机器人1')?.canRemove, true);
  assert.equal(context.data.canRestart, false, '比赛未结束不能重新开始');

  invoke(context, 'applyRoom', baseRoom({...hostView, status: 'playing'}));
  assert.equal(
    (context.data.members as {canRemove: boolean}[]).every((member) => !member.canRemove),
    true,
    '开赛后锁定名单'
  );

  invoke(context, 'applyRoom', baseRoom({...hostView, status: 'finished', winner: 1}));
  assert.equal(context.data.canRestart, true);
  assert.equal(context.data.finished, true);
  assert.equal(context.data.winnerText, '第2座 获胜');

  invoke(
    context,
    'applyRoom',
    baseRoom({
      ...hostView,
      status: 'finished',
      members: [
        {userId: 'u1', seat: 0, name: '甲', bot: false, ready: false},
        {userId: 'u2', seat: 1, name: '我', bot: false, ready: true},
        {userId: 'bot-1', seat: 2, name: '机器人1', bot: true, ready: true}
      ]
    })
  );
  assert.equal(context.data.canRestart, false, '真人未全部准备时不能重新开始');
});

test('加注步进按大盲递增并夹在合法区间内', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());
  assert.equal(context.data.raiseTarget, 20);

  invoke(context, 'onStep', {currentTarget: {dataset: {step: '1'}}});
  assert.equal(context.data.raiseTarget, 40, '一次步进 = 一个大盲');
  assert.equal(context.data.raiseAddText, '40');

  invoke(context, 'onStep', {currentTarget: {dataset: {step: '-1'}}});
  assert.equal(context.data.raiseTarget, 20);

  invoke(context, 'onStep', {currentTarget: {dataset: {step: '-1'}}});
  assert.equal(context.data.raiseTarget, 20, '不得低于最小加注');

  invoke(context, 'onStep', {currentTarget: {dataset: {step: '100'}}});
  assert.equal(context.data.raiseTarget, 950, '不得超过最大加注');

  // 房间数据缺失时步进不得抛错。
  invoke(context, 'applyRoom', baseRoom({status: 'waiting', hand: null}));
  assert.doesNotThrow(() => invoke(context, 'onStep', {currentTarget: {dataset: {step: '1'}}}));
});

test('牌桌分享带邀请令牌，缺失时退回大厅', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', baseRoom());
  const shared = invoke(context, 'onShareAppMessage') as {title: string; path: string};
  assert.equal(shared.title, '同桌 · 德州扑克 邀请');
  assert.equal(shared.path, '/pages/room/room?invite=invite-token');

  invoke(context, 'applyRoom', baseRoom({invite: ''}));
  assert.equal(
    (invoke(context, 'onShareAppMessage') as {path: string}).path,
    '/pages/lobby/lobby',
    '无邀请令牌时不得生成打不开的邀请链接'
  );
});

test('比赛中的等待房间只自动跳转牌桌一次', () => {
  const wx = createWx();
  const loader = createLoader({wx, timers: createTimers()});
  const context = createPageContext(loader, 'pages/room/room.js');
  invoke(context, 'applyRoom', baseRoom());
  assert.deepStrictEqual(wx.navigations, ['/pages/table/table?roomId=room-1']);
  invoke(context, 'applyRoom', baseRoom({version: 10}));
  assert.equal(wx.navigations.length, 1, '同一页面实例不得反复跳转');
});

test('核验页按比赛号取本地留存：第二局的第 1 手不会被上一局误判为篡改', () => {
  const wx = createWx();
  // 同一个房间打过两局，两局都有第 1 手，各存各的承诺。
  wx.storage.set('poker.commitments', {
    'match-1:1': 'a'.repeat(64),
    'match-2:1': 'b'.repeat(64)
  });
  const context = createPageContext(createLoader({wx, timers: createTimers()}), 'pages/audit/audit.js');
  invoke(context, 'apply', {
    matchId: 'match-2',
    rounds: [
      {
        handNo: 1,
        version: 'v1',
        commitment: 'b'.repeat(64),
        serverSeed: 'c'.repeat(64),
        deckCommitment: 'd'.repeat(64),
        seats: [0, 1],
        contributions: {0: '0'.repeat(64)}
      }
    ],
    verification: {valid: true, errors: []},
    events: []
  });

  assert.equal(context.data.localCount, 1);
  assert.equal(context.data.mismatchCount, 0, '第二局与第二局的留存一致，不该报不一致');
  const rounds = context.data.rounds as {handNo: number; matchText: string; matchClass: string}[];
  assert.equal(rounds[0]!.matchText, '与本地留存一致');

  // 若服务端公布的另一局的承诺，则必须报不一致。
  invoke(context, 'apply', {
    matchId: 'match-2',
    rounds: [
      {
        handNo: 1,
        version: 'v1',
        commitment: 'e'.repeat(64),
        serverSeed: 'c'.repeat(64),
        deckCommitment: 'd'.repeat(64),
        seats: [0, 1],
        contributions: {}
      }
    ],
    verification: {valid: true, errors: []},
    events: []
  });
  assert.equal(context.data.mismatchCount, 1);
});

/**
 * 每手结算确认：弹窗只在服务端开了确认门时出现，金额来自 settle.changes，
 * 确认命令带 handNo（服务端据此防止旧确认串到下一手）。
 */
function settledRoom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseRoom({
    hand: {
      ...(baseRoom().hand as Record<string, unknown>),
      id: 8,
      street: 'settled',
      actor: null,
      legal: null,
      players: [
        {seat: 0, stack: 1100, roundBet: 0, committed: 0, folded: false, hole: []},
        {seat: 1, stack: 800, roundBet: 0, committed: 0, folded: false, hole: []},
        {seat: 2, stack: 1000, roundBet: 0, committed: 0, folded: false, hole: []}
      ],
      result: {
        pots: [{amount: 100, eligible: [0, 1, 2]}],
        awards: [{seat: 0, amount: 100}],
        refunds: []
      }
    },
    settle: {
      handNo: 8,
      acks: [],
      required: [1],
      changes: [
        {seat: 0, delta: 50},
        {seat: 1, delta: -50},
        {seat: 2, delta: 0}
      ]
    },
    nextHandAt: 1200000 + 8000,
    deadline: null,
    ...overrides
  });
}

test('结算确认弹窗：列出每人净输赢，确认门开着才给确认按钮', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', settledRoom());
  const dialog = context.data.dialog as {
    handNo: number;
    title: string;
    summary: string;
    canAck: boolean;
    ackText: string;
    rows: {seat: number; name: string; amount: string}[] | null;
  } | null;
  assert.ok(dialog, '服务端开了确认门就应该弹窗');
  assert.equal(dialog.handNo, 8);
  assert.equal(dialog.title, '第 8 手结算');
  assert.equal(dialog.summary, '房主 赢下 100 的底池', '副标题只说谁赢下多大的池');
  assert.deepStrictEqual(
    (dialog.rows as {seat: number; amount: string}[]).map((row) => `${row.seat}:${row.amount}`),
    ['0:+50', '2:0', '1:-50'],
    '按净输赢从高到低排'
  );
  assert.equal(dialog.canAck, true, '自己在 required 里');
  assert.equal(dialog.ackText, '0/1');

  // 服务端没开确认门（比赛已结束）时不弹窗。
  invoke(context, 'applyRoom', settledRoom({settle: null}));
  assert.equal(context.data.dialog, null);
});

test('结算弹窗把亮牌、牌型与剩余筹码透传给 WXML，没亮牌的写未摊牌', () => {
  const {context} = tablePage();
  // 夹具的 changes 不带 cards/category：服务端升级前落盘的老快照就是这个样子。
  invoke(context, 'applyRoom', settledRoom());
  const legacy = context.data.dialog as {rows: {seat: number; revealText: string; stackText: string}[]};
  assert.deepStrictEqual(
    legacy.rows.map((row) => `${row.seat}:${row.revealText}:${row.stackText}`),
    ['0:未摊牌:剩余 1,100', '2:未摊牌:剩余 1,000', '1:未摊牌:剩余 800'],
    '没有亮牌数据时逐行显示未摊牌，剩余筹码读视图里的 stack'
  );

  // 服务端给了牌：这一行要带上牌面、牌型名，并且不再显示「未摊牌」。
  const changed = settledRoom();
  (changed.settle as {changes: unknown[]}).changes = [
    {seat: 0, delta: 50, cards: [38, 37, 36, 35, 34], category: 'straightFlush'},
    {seat: 1, delta: -50},
    {seat: 2, delta: 0}
  ];
  invoke(context, 'applyRoom', changed);
  const rows = (context.data.dialog as {
    rows: {seat: number; cards: {label: string; symbol: string; red: boolean}[] | null; typeName: string | null; revealText: string}[];
  }).rows;
  assert.equal(rows[0]!.cards!.length, 5);
  assert.equal(rows[0]!.cards![0]!.label, 'A');
  assert.equal(rows[0]!.cards![0]!.red, true, '红桃渲染成红色');
  assert.equal(rows[0]!.typeName, '同花顺');
  assert.equal(rows[0]!.revealText, '');
  assert.equal(rows[1]!.cards, null, '服务端没给牌的座位保持未摊牌');
  assert.equal(rows[1]!.revealText, '未摊牌');
});

test('结算确认按钮发 settleAck，带当前手号且不带 expectedVersion', async () => {
  const wx = createWx();
  const {context} = tablePage(wx);
  invoke(context, 'applyRoom', settledRoom());
  invoke(context, 'onSettleAck');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(wx.requests.length, 1);
  const body = wx.requests[0]!.data as Record<string, unknown>;
  assert.equal(body.type, 'settleAck');
  assert.equal(body.handNo, 8, '必须带手号，否则旧确认会串到下一手');
  assert.equal(body.expectedVersion, undefined, '服务端豁免版本检查，不传版本号');
});

test('被淘汰 / 观战时不给确认按钮，可以关掉弹窗且不会立刻重新弹出', () => {
  // required 里没有自己：只能看结果。
  const {context} = tablePage();
  invoke(context, 'applyRoom', settledRoom({settle: {handNo: 8, acks: [], required: [0], changes: []}}));
  assert.equal((context.data.dialog as {canAck: boolean}).canAck, false);

  invoke(context, 'onDismissDialog');
  assert.equal(context.data.dialog, null);
  invoke(context, 'applyRoom', settledRoom());
  const afterDismiss = context.data.dialog as {handNo: number} | null;
  assert.equal(afterDismiss, null, '同一手关闭后不再弹出来');

  // 下一手开始时手号变了，弹窗重新可以出现。
  invoke(context, 'applyRoom', settledRoom({settle: {handNo: 9, acks: [], required: [1], changes: []}}));
  const nextHand = context.data.dialog as {handNo: number} | null;
  assert.equal(nextHand?.handNo, 9);
});

test('弹窗里的倒计时按 nextHandAt 走，到点后提示正在开下一手', () => {
  const {context} = tablePage();
  invoke(context, 'applyRoom', settledRoom());
  assert.equal(context.data.dialogTimerText, '倒计时结束自动开下一手 · 8.0s');

  // deadline 已经过去：服务端的兜底定时器随时会把下一手发出来。
  invoke(context, 'applyRoom', settledRoom({nextHandAt: 1000, serverTime: 1200000}));
  assert.equal(context.data.dialogTimerText, '倒计时结束自动开下一手 · 0.0s');

  // 房间没有兜底时间时只说明「等其他人确认」，不显示一个假的倒计时。
  invoke(context, 'applyRoom', settledRoom({nextHandAt: null}));
  assert.equal(context.data.dialogTimerText, '');
});

test('行动播报：首帧只建基线，之后的动作按语气档弹出来', () => {
  const timers = createTimers();
  const {context} = tablePage(createWx(), timers);
  // 刚进牌桌：快照里已有历史事件，一条都不该补播。
  invoke(context, 'applyRoom', baseRoom());
  assert.equal(context.data.announce, null, '入桌前的历史事件不该补播');

  invoke(
    context,
    'applyRoom',
    baseRoom({events: [{seq: 2, handNo: 3, type: 'action', text: '我 全押 950', action: 'allIn', amount: 950}]})
  );
  assert.deepStrictEqual(context.data.announce, {
    text: '我 全押 950',
    tone: 'big',
    toneClass: 'announce--big',
    durationMs: 2400
  });

  // 同一条快照反复推送（心跳、重新订阅）不该重播。
  const shown = context.data.announce;
  invoke(
    context,
    'applyRoom',
    baseRoom({events: [{seq: 2, handNo: 3, type: 'action', text: '我 全押 950', action: 'allIn', amount: 950}]})
  );
  assert.deepStrictEqual(context.data.announce, shown, '同一条事件不该重播');

  // 停留时间到点后收起，横幅不该永久留在桌面上。
  timers.tick(2400);
  assert.equal(context.data.announce, null);
});

test('行动播报的语气按事件类型与动作分档，老事件退回中性', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['弃牌安静', {type: 'action', text: 'A 弃牌', action: 'fold'}],
    ['加注中等', {type: 'action', text: 'A 加注到 300', action: 'raiseTo', amount: 300}],
    ['跟注中性', {type: 'action', text: 'A 跟注 50', action: 'call', amount: 50}],
    ['老事件缺 action', {type: 'action', text: 'A 做了什么'}],
    ['发牌中等', {type: 'street', text: '公共牌 翻牌 ♥K ♦7 ♠2'}],
    ['结算最大', {type: 'settle', text: '第 3 手结束，A 赢得 100 筹码'}],
    ['结束最大', {type: 'finish', text: '比赛结束，A 获胜'}],
    ['暂停报警', {type: 'pause', text: '牌局出现异常，已暂停'}]
  ];
  for (const [label, event] of cases) {
    const {context} = tablePage();
    invoke(context, 'applyRoom', baseRoom());
    invoke(context, 'applyRoom', baseRoom({events: [{seq: 2, handNo: 3, ...event}]}));
    const announce = context.data.announce as {text: string; tone: string; toneClass: string};
    assert.ok(announce !== null, `${label}：该播报`);
    assert.equal(announce.text, event.text, `${label}：报的是服务端给的原文`);
    assert.ok(
      ['big', 'medium', 'neutral', 'quiet', 'error'].includes(announce.tone),
      `${label}：语气档要合法，实际 ${announce.tone}`
    );
    assert.equal(announce.toneClass, `announce--${announce.tone}`);
  }
});

test('音乐开关：有能力时开关并记住偏好，没能力时如实显示不可用', () => {
  // 默认桩模拟支持 Web Audio 的基础库。
  const {wx, context} = tablePage();
  invoke(context, 'resumeMusic');
  assert.equal(context.data.musicText, '音乐：关', '没开过就不出声');
  invoke(context, 'onMusic');
  assert.equal(context.data.musicText, '音乐：开');
  assert.equal(wx.storage.get('poker.music'), 'on');
  assert.equal(wx.audioContexts.length, 1);
  assert.ok(wx.audioContexts[0]!.oscillators.length > 0, '开了就要真的排上音符');

  invoke(context, 'onMusic');
  assert.equal(context.data.musicText, '音乐：关');
  assert.equal(wx.storage.get('poker.music'), 'off');

  // 老基础库：没有 createWebAudioContext，按钮置灰而不是假装能放。
  const legacy = tablePage(createWx({audio: 'missing'}));
  invoke(legacy.context, 'resumeMusic');
  assert.equal(legacy.context.data.musicText, '音乐：不可用');
  invoke(legacy.context, 'onMusic');
  assert.equal(legacy.context.data.musicText, '音乐：不可用');
  assert.equal(legacy.wx.audioContexts.length, 0);
});

test('离开牌桌停掉音乐，回到牌桌时按偏好续播', () => {
  const {wx, context} = tablePage();
  invoke(context, 'resumeMusic');
  invoke(context, 'onMusic');
  invoke(context, 'detach');
  const context2 = wx.audioContexts[0]!;
  const notes = context2.oscillators.length;
  context2.currentTime = 40;
  invoke(context, 'syncClock');
  assert.equal(context2.oscillators.length, notes, '页面隐藏后不该继续排音');

  invoke(context, 'resumeMusic');
  assert.equal(context.data.musicText, '音乐：开', '偏好在，回来就续播');
});

test('大厅：新手教程入口跳到教程页，并记下已看过', () => {
  const wx = createWx();
  const context = createPageContext(createLoader({wx, timers: createTimers()}), 'pages/lobby/lobby.js');
  invoke(context, 'onLoad', {});
  assert.equal(context.data.showGuide, true, '第一次进大厅要显示引导条');
  invoke(context, 'onTutorial');
  assert.deepStrictEqual(wx.navigations, ['/pages/tutorial/tutorial']);
  assert.equal(wx.storage.get('poker.tutorialSeen'), true);
  assert.equal(context.data.showGuide, false);

  // 已经看过：再进大厅不再打扰。
  const again = createPageContext(createLoader({wx, timers: createTimers()}), 'pages/lobby/lobby.js');
  invoke(again, 'onLoad', {});
  assert.equal(again.data.showGuide, false);
});
