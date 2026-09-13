import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPots,
  distribute,
  RuleError,
  type Player,
  type SeatId,
} from '../src/index.ts';

function player(seat: SeatId, committed: number, folded = false): Player {
  return {
    seat,
    stack: 0,
    roundBet: 0,
    committed,
    folded,
    hole: [],
    actedAt: null,
    reopenBy: 10,
  };
}

test('three contribution levels return uncalled excess', () => {
  const result = buildPots([
    player(0, 100),
    player(1, 300),
    player(2, 500),
  ]);

  assert.deepEqual(result.pots, [
    {amount: 300, eligible: [0, 1, 2]},
    {amount: 400, eligible: [1, 2]},
  ]);
  assert.deepEqual(result.refunds, [{seat: 2, amount: 200}]);
});

test('odd chip starts left of button', () => {
  const awards = distribute(
    [{amount: 5, eligible: [0, 2]}],
    new Map([
      [0, [1, 14, 13, 12, 11]],
      [2, [1, 14, 13, 12, 11]],
    ]),
    0,
  );

  assert.deepEqual(awards, [
    {seat: 0, amount: 2},
    {seat: 2, amount: 3},
  ]);
});

test('folded contributions remain in pots but folded seats are ineligible', () => {
  const result = buildPots([
    player(0, 100),
    player(1, 100, true),
    player(2, 300),
  ]);

  assert.deepEqual(result, {
    pots: [{amount: 300, eligible: [0, 2]}],
    refunds: [{seat: 2, amount: 200}],
  });
});

test('multiple all-in ties split every side pot and aggregate awards', () => {
  const awards = distribute(
    [
      {amount: 303, eligible: [0, 1, 2]},
      {amount: 202, eligible: [1, 2]},
    ],
    new Map([
      [0, [0, 14, 10, 8, 6, 4]],
      [1, [1, 13, 12, 11, 9]],
      [2, [1, 13, 12, 11, 9]],
    ]),
    2,
  );

  assert.deepEqual(awards, [
    {seat: 1, amount: 253},
    {seat: 2, amount: 252},
  ]);
});

test('zero contributions produce no pots, refunds, or awards', () => {
  const result = buildPots([
    player(0, 0),
    player(1, 0, true),
  ]);

  assert.deepEqual(result, {pots: [], refunds: []});
  assert.deepEqual(distribute([], new Map(), 0), []);
});

test('pot and refund totals preserve every committed chip', () => {
  const players = [
    player(0, 40),
    player(1, 100, true),
    player(2, 250),
    player(3, 250),
  ];
  const result = buildPots(players);
  const awards = distribute(
    result.pots,
    new Map([
      [0, [0, 14]],
      [2, [2, 7, 5]],
      [3, [1, 14, 13]],
    ]),
    1,
  );
  const settledTotal = awards.reduce((sum, award) => sum + award.amount, 0)
    + result.refunds.reduce((sum, refund) => sum + refund.amount, 0);

  assert.deepEqual(result, {
    pots: [
      {amount: 160, eligible: [0, 2, 3]},
      {amount: 180, eligible: [2, 3]},
      {amount: 300, eligible: [2, 3]},
    ],
    refunds: [],
  });
  assert.deepEqual(awards, [{seat: 2, amount: 640}]);
  assert.equal(
    settledTotal,
    players.reduce((sum, current) => sum + current.committed, 0),
  );
});

test('malformed contributions reject without losing chips silently', () => {
  const invalidPlayers: Player[][] = [
    [player(0, -1)],
    [player(0, 1.5)],
    [player(0, Number.MAX_SAFE_INTEGER), player(1, Number.MAX_SAFE_INTEGER)],
    [player(0, 10), player(0, 10)],
    [player(9, 10)],
    [player(0, 10, true), player(1, 10, true)],
  ];

  for (const players of invalidPlayers) {
    assert.throws(
      () => buildPots(players),
      (error) => error instanceof RuleError && error.code === 'INVALID_INPUT',
    );
  }
});

test('malformed pots and ranks reject instead of dropping a pot', () => {
  const ranks = new Map<SeatId, number[]>([[0, [1, 14]]]);
  const invalidPots = [
    [{amount: 0, eligible: [0]}],
    [{amount: -1, eligible: [0]}],
    [{amount: 1.5, eligible: [0]}],
    [{amount: 1, eligible: []}],
    [{amount: 1, eligible: [0, 0]}],
    [{amount: 1, eligible: [9]}],
  ];

  for (const pots of invalidPots) {
    assert.throws(
      () => distribute(pots, ranks, 0),
      (error) => error instanceof RuleError && error.code === 'INVALID_INPUT',
    );
  }
  assert.throws(
    () => distribute([{amount: 10, eligible: [0, 1]}], ranks, 0),
    (error) => error instanceof RuleError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => distribute([{amount: 10, eligible: [0]}], new Map([[0, []]]), 0),
    (error) => error instanceof RuleError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => distribute([{amount: 10, eligible: [0]}], ranks, 9),
    (error) => error instanceof RuleError && error.code === 'INVALID_INPUT',
  );
});
