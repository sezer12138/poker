import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResultDialog, isValidRaiseTarget, potTotal, quickRaiseTargets, seatPositions} from '../static/js/table.js';

/**
 * 牌桌的纯计算部分。加注目标的判定必须与引擎一致（packages/poker-engine/src/betting.ts）：
 * 完整加注落在 [minRaiseTo, maxRaiseTo]；短码全押必须正好推完筹码，且高过本轮既有下注。
 */
const legal = (overrides: Record<string, unknown> = {}) => ({
  fold: true,
  check: false,
  call: 20,
  minRaiseTo: 60,
  maxRaiseTo: 500,
  allIn: true,
  ...overrides,
});

test('完整加注只认 [最小加注, 上限] 区间', () => {
  assert.equal(isValidRaiseTarget(legal(), 60, 20, 480), true);
  assert.equal(isValidRaiseTarget(legal(), 500, 20, 480), true);
  assert.equal(isValidRaiseTarget(legal(), 59, 20, 480), false, '低于最小加注');
  assert.equal(isValidRaiseTarget(legal(), 501, 20, 480), false, '超过自己的筹码');
  assert.equal(isValidRaiseTarget(legal(), 60.5, 20, 480), false, '必须是整数');
  assert.equal(isValidRaiseTarget(null, 60, 20, 480), false);
  const noRaise = legal({minRaiseTo: null, maxRaiseTo: null, allIn: false});
  assert.equal(isValidRaiseTarget(noRaise, 60, 20, 480), false, '没有加注权时只能跟注或弃牌');
});

test('短码全押要正好推完筹码，且高过本轮既有下注', () => {
  // 本轮已投入 20、跟注额 40 → 既有下注 60。
  const short = legal({call: 40, minRaiseTo: null, maxRaiseTo: null});
  // 只剩 30，推完到 50 仍低于既有下注：那只是不够跟注，不是加注。
  assert.equal(isValidRaiseTarget(short, 50, 20, 30), false, '低于既有下注不算加注，服务端会拒绝');
  // 只剩 45，推完到 65，高过 60，是合法短全押。
  assert.equal(isValidRaiseTarget(short, 65, 20, 45), true);
  // 必须推完：留 1 个筹码就不是全押。
  assert.equal(isValidRaiseTarget(short, 64, 20, 45), false);
  assert.equal(isValidRaiseTarget(legal({allIn: false, minRaiseTo: null, maxRaiseTo: null}), 65, 20, 45), false);
  // 无需跟注（legal.call 为 null）时既有下注就是自己的本轮投入，
  // 推完筹码必然高于它，因此总是合法。
  const noCall = legal({call: null, check: true, minRaiseTo: null, maxRaiseTo: null});
  assert.equal(isValidRaiseTarget(noCall, 30, 20, 10), true);
  assert.equal(isValidRaiseTarget(noCall, 20, 20, 0), false, '没有筹码可推就谈不上全押');
});

test('快捷加注目标按“跟注后底池”换算并夹在合法区间', () => {
  const targets = quickRaiseTargets(legal(), 100, 20);
  assert.equal(targets.min, 60);
  assert.equal(targets.max, 500);
  // base = 底池 100 + 跟注 20 = 120；半池 → 20+20+60 = 100，一池 → 20+20+120 = 160。
  assert.equal(targets.half, 100);
  assert.equal(targets.pot, 160);
  // 底池很小、区间很高时，快捷值被抬到最小加注。
  const raised = quickRaiseTargets(legal({minRaiseTo: 300, maxRaiseTo: 320}), 0, 20);
  assert.equal(raised.half, 300, '低于最小加注时夹到最小加注');
  assert.equal(raised.pot, 300);
  // 底池很大时被夹到上限。
  const capped = quickRaiseTargets(legal({minRaiseTo: 300, maxRaiseTo: 320}), 1000, 20);
  assert.equal(capped.pot, 320, '超过上限时夹到上限');
});

test('底池口径：进行中按累计投入，结算后以 result.pots 为准', () => {
  assert.equal(potTotal(null), 0);
  assert.equal(
    potTotal({players: [{committed: 50}, {committed: 100}, {committed: 0}], result: null}),
    150,
  );
  assert.equal(
    potTotal({players: [{committed: 50}, {committed: 100}], result: {pots: [{amount: 90}, {amount: 60}]}}),
    150,
  );
});

test('九个座位按自己为下方原点排布，坐标不重复', () => {
  const positions = seatPositions([0, 1, 2, 3, 4, 5, 6, 7, 8], 3);
  assert.equal(positions.size, 9);
  const mine = positions.get(3);
  assert.ok(Math.abs(mine.x - 50) < 0.001 && Math.abs(mine.y - 88) < 0.001, '自己总在下方正中');
  const keys = new Set([...positions.values()].map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`));
  assert.equal(keys.size, 9, '座位不能重叠');
  for (const point of positions.values()) {
    assert.ok(point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100, '坐标必须在 0–100 之间');
  }
  assert.equal(seatPositions([], 0).size, 0, '没人时不排座位');
});

/**
 * 结算弹窗的内容：金额来自服务端的 settle.changes（本手净输赢），名字来自成员列表。
 * 这里覆盖赢家/输家的金额与排序、已确认与待确认的按钮决策，以及服务端没给金额
 * （升级前的老快照）时的退化显示。
 */
const settledHand = {
  id: 7,
  street: 'settled',
  actor: null,
  players: [
    {seat: 0, stack: 1500, roundBet: 0, committed: 0, folded: false, hole: []},
    {seat: 1, stack: 500, roundBet: 0, committed: 0, folded: true, hole: []},
  ],
  result: {
    pots: [{amount: 500, eligible: [0, 1]}],
    awards: [{seat: 0, amount: 500}],
    refunds: [],
  },
};
const settledMembers = [
  {seat: 0, name: '甲'},
  {seat: 1, name: '乙'},
];
const gate = (overrides: Record<string, unknown> = {}) => ({
  handNo: 7,
  acks: [],
  required: [0, 1],
  changes: [
    {seat: 0, delta: 250},
    {seat: 1, delta: -250},
  ],
  ...overrides,
});

/** table.js 是 JS：默认值让 TS 把 settle/viewerSeat 推成 null，这里显式放宽成 any 再用。 */
const build = buildResultDialog as (hand: any, members?: any, settle?: any, viewerSeat?: any) => any;

test('结算弹窗按座位列出输赢金额，赢家排在最前', () => {
  const dialog = build(settledHand, settledMembers, gate(), 0);
  assert.equal(dialog.title, '第 7 手结算');
  assert.equal(dialog.summary, '甲 赢下 500 的底池');
  assert.deepEqual(
    dialog.rows.map((row: any) => [row.seat, row.name, row.amount, row.win]),
    [
      [0, '甲', '+250', true],
      [1, '乙', '-250', false],
    ],
    '金额带符号，赢家在前',
  );
  assert.equal(dialog.rows[0].detail, '赢得底池 500', '还要说清底池有多少');
});

test('确认按钮的三种状态：待确认 / 已确认 / 无需确认', () => {
  assert.equal(build(settledHand, settledMembers, gate(), 0).canAck, true);
  // 自己已经点过确认：按钮换成关闭，不能让人重复点。
  assert.equal(build(settledHand, settledMembers, gate({acks: [0]}), 0).canAck, false);
  // 被淘汰后观看别人打：只显示结果，不给确认按钮。
  const out = build(settledHand, settledMembers, gate({required: [1]}), 0);
  assert.equal(out.canAck, false, '不在 required 里就没有确认按钮');
  assert.equal(out.rows.length, 2, '但结果照常显示');
  assert.equal(build(settledHand, settledMembers, gate(), null).canAck, false, '观战者不能确认');
});

test('服务端没给金额时只显示谁赢了，不编造数字', () => {
  const dialog = build(settledHand, settledMembers, gate({changes: []}), 0);
  assert.deepEqual(
    dialog.rows.map((row: any) => [row.seat, row.amount, row.win]),
    [
      [0, '—', true],
      [1, '—', false],
    ],
    '没有 changes 就显示占位符，赢家仍然排在最前',
  );
});

test('没有结算结果或确认门未开时不弹窗', () => {
  assert.equal(build({...settledHand, result: null}, settledMembers, gate(), 0), null);
  assert.equal(build(settledHand, settledMembers, null, 0), null, '比赛结束后不再弹确认框');
  assert.equal(build(null, settledMembers, gate(), 0), null);
});
