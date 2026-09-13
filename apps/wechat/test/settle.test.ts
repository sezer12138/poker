/**
 * 结算确认弹窗的数据模型。金额来自服务端的 settle.changes（本手净输赢），
 * 名字来自成员列表；这里覆盖赢家/输家的金额、排序、确认按钮的三种状态，
 * 以及服务端没给金额（升级前的老快照）时的退化显示——绝不自己算一个可能错的数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx} from './harness.ts';

interface DialogRow {
  seat: number;
  name: string;
  delta: number | null;
  win: boolean;
  amount: string;
  amountClass: string;
  detail: string;
}

interface Dialog {
  handNo: number;
  title: string;
  summary: string;
  rows: DialogRow[];
  required: number[];
  acks: number[];
  canAck: boolean;
  ackText: string;
}

function load() {
  const loader = createLoader({wx: createWx(), timers: createTimers()});
  return loader.load('utils/settle.js') as {
    signedChips(value: number): string;
    buildResultDialog(hand: unknown, members?: unknown, settle?: unknown, viewerSeat?: unknown): Dialog | null;
  };
}

const HAND = {
  id: 7,
  street: 'settled',
  actor: null,
  players: [
    {seat: 0, stack: 1500, roundBet: 0, committed: 0, folded: false, hole: []},
    {seat: 1, stack: 500, roundBet: 0, committed: 0, folded: true, hole: []}
  ],
  result: {
    pots: [{amount: 500, eligible: [0, 1]}],
    awards: [{seat: 0, amount: 500}],
    refunds: []
  }
};

const MEMBERS = [
  {seat: 0, name: '甲'},
  {seat: 1, name: '乙'}
];

const gate = (overrides: Record<string, unknown> = {}) => ({
  handNo: 7,
  acks: [],
  required: [0, 1],
  changes: [
    {seat: 0, delta: 250},
    {seat: 1, delta: -250}
  ],
  ...overrides
});

test('带符号筹码：正数带加号，零不带，非法值显示破折号', () => {
  const settle = load();
  assert.equal(settle.signedChips(250), '+250');
  assert.equal(settle.signedChips(-250), '-250');
  assert.equal(settle.signedChips(0), '0');
  assert.equal(settle.signedChips(12345), '+12,345', '与 format.chips 一致地做千分位');
  assert.equal(settle.signedChips(Number.NaN), '—');
});

test('结算弹窗按座位列出输赢金额，赢家排在最前', () => {
  const dialog = load().buildResultDialog(HAND, MEMBERS, gate(), 0) as Dialog;
  assert.equal(dialog.title, '第 7 手结算');
  assert.equal(dialog.summary, '甲 赢下 500 的底池');
  assert.deepStrictEqual(
    dialog.rows.map((row) => [row.seat, row.name, row.amount, row.win, row.amountClass]),
    [
      [0, '甲', '+250', true, 'amount-win'],
      [1, '乙', '-250', false, 'amount-lose']
    ],
    '金额带符号，赢家在前'
  );
  assert.equal(dialog.rows[0].detail, '赢得底池 500', '还要说清底池有多少');
  assert.equal(dialog.rows[1].detail, '', '输家的钱进了底池，没有单独一行可写');
});

test('确认按钮的三种状态：待确认 / 已确认 / 无需确认', () => {
  const settle = load();
  assert.equal((settle.buildResultDialog(HAND, MEMBERS, gate(), 0) as Dialog).canAck, true);
  assert.equal((settle.buildResultDialog(HAND, MEMBERS, gate({acks: [0]}), 0) as Dialog).canAck, false, '已确认过不能再点');
  const out = settle.buildResultDialog(HAND, MEMBERS, gate({required: [1]}), 0) as Dialog;
  assert.equal(out.canAck, false, '不在 required 里就没有确认按钮');
  assert.equal(out.rows.length, 2, '但结果照常显示');
  assert.equal(settle.buildResultDialog(HAND, MEMBERS, gate(), null)?.canAck, false, '观战者不能确认');
  assert.equal((settle.buildResultDialog(HAND, MEMBERS, gate({acks: [0, 1]}), 0) as Dialog).ackText, '2/2');
});

test('服务端没给金额时只显示谁赢了，不编造数字', () => {
  const dialog = load().buildResultDialog(HAND, MEMBERS, gate({changes: []}), 0) as Dialog;
  assert.deepStrictEqual(
    dialog.rows.map((row) => [row.seat, row.amount, row.amountClass, row.win]),
    [
      [0, '—', 'amount-none', true],
      [1, '—', 'amount-none', false]
    ],
    '没有 changes 就显示占位符，赢家仍然排在最前'
  );
});

test('同一个座位拿到主池又拿到边池时金额先合并再显示', () => {
  const hand = {
    ...HAND,
    result: {
      pots: [
        {amount: 300, eligible: [0, 1]},
        {amount: 100, eligible: [0, 1]}
      ],
      awards: [
        {seat: 0, amount: 300},
        {seat: 0, amount: 100}
      ],
      refunds: [{seat: 1, amount: 20}]
    }
  };
  const dialog = load().buildResultDialog(hand, MEMBERS, gate(), 0) as Dialog;
  assert.equal(dialog.rows[0].detail, '赢得底池 400');
  assert.equal(dialog.rows[1].detail, '退回 20', '没赢到池但有退款时显示退款');
  assert.equal(dialog.summary, '甲 赢下 400 的底池');
});

test('没有结算结果或确认门未开时返回 null', () => {
  const settle = load();
  assert.equal(settle.buildResultDialog({...HAND, result: null}, MEMBERS, gate(), 0), null);
  assert.equal(settle.buildResultDialog(HAND, MEMBERS, null, 0), null, '比赛结束后不再弹确认框');
  assert.equal(settle.buildResultDialog(null, MEMBERS, gate(), 0), null);
  // 成员列表缺失时用座位号兜底，不把 undefined 渲染给玩家。
  const dialog = settle.buildResultDialog(HAND, undefined, gate(), 0) as Dialog;
  assert.equal(dialog.rows[0].name, '第1座');
});
