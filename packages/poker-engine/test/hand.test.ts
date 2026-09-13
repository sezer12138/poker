import test from 'node:test';
import assert from 'node:assert/strict';
import {startHand, act, timeoutAction, fullDeck, type Hand} from '../src/index.ts';

const entries = [{seat: 0, stack: 1000}, {seat: 1, stack: 1000}];
function total(h: Hand) {
  return h.players.reduce((sum, p) => sum + p.stack + p.committed, 0);
}

test('heads-up fold pays winner without a board', () => {
  const h = startHand(entries, 0, [5, 10], fullDeck(), 1);
  assert.equal(h.actor, 0);
  const {state: n} = act(h, 0, {type: 'fold'});
  assert.equal(n.street, 'settled');
  assert.equal(n.board.length, 0);
  assert.deepEqual(n.players.map(p => p.stack), [995, 1005]);
  assert.throws(() => act(n, 1, {type: 'check'}));
});

test('three players deal clockwise and preserve the big blind option', () => {
  let h = startHand([...entries, {seat: 4, stack: 1000}], 0, [5, 10], fullDeck(), 1);
  assert.deepEqual(h.players.map(p => p.hole), [[2, 5], [0, 3], [1, 4]]);
  assert.equal(h.actor, 0);
  h = act(h, 0, {type: 'call'}).state;
  assert.equal(h.actor, 1);
  h = act(h, 1, {type: 'call'}).state;
  assert.equal(h.actor, 4);
  h = act(h, 4, {type: 'check'}).state;
  assert.equal(h.actor, 1);
  assert.equal(h.street, 'flop');
});

test('heads-up streets burn exact cards and river settles with conserved chips', () => {
  let h = startHand(entries, 0, [5, 10], fullDeck(), 1);
  assert.deepEqual(h.players.map(p => p.hole), [[1, 3], [0, 2]]);
  h = act(h, 0, {type: 'call'}).state;
  h = act(h, 1, {type: 'check'}).state;
  assert.equal(h.actor, 1);
  assert.deepEqual(h.board, [5, 6, 7]);
  while (h.actor !== null) {
    assert.equal(total(h), 2000);
    h = act(h, h.actor, {type: 'check'}).state;
  }
  assert.deepEqual(h.board, [5, 6, 7, 9, 11]);
  assert.deepEqual(h.burned, [4, 8, 10]);
  assert.equal(h.cursor, 12);
  assert.equal(total(h), 2000);
  assert.ok(h.players.every(p => p.committed === 0 && p.roundBet === 0));
});

test('all-in waits for an owed call then runs the board', () => {
  const h = startHand(entries, 0, [5, 10], fullDeck(), 1);
  const raised = act(h, 0, {type: 'allIn'}).state;
  assert.equal(raised.actor, 1);
  assert.equal(raised.board.length, 0);
  const n = act(raised, 1, {type: 'call'}).state;
  assert.equal(n.street, 'settled');
  assert.equal(n.board.length, 5);
  assert.equal(total(n), 2000);
});

test('blind all-ins normalize and nominal big blind remains owed', () => {
  const short = startHand([{seat: 0, stack: 100}, {seat: 1, stack: 7}], 0, [5, 10], fullDeck(), 1);
  assert.equal(short.currentBet, 10);
  assert.equal(short.actor, 0);
  const n = act(short, 0, {type: 'call'}).state;
  assert.equal(n.street, 'settled');
  assert.deepEqual(n.result!.refunds, [{seat: 0, amount: 3}]);
  assert.equal(total(n), 107);
  const both = startHand([{seat: 0, stack: 3}, {seat: 1, stack: 7}], 0, [5, 10], fullDeck(), 1);
  assert.equal(both.street, 'settled');
  assert.equal(total(both), 10);
  const noDebt = startHand([{seat: 0, stack: 3}, {seat: 1, stack: 100}], 0, [5, 10], fullDeck(), 1);
  assert.equal(noDebt.street, 'settled');
});

test('inputs, events and returned state do not alias', () => {
  const deck = fullDeck();
  const h = startHand(entries, 0, [5, 10], deck, 1);
  const before = structuredClone(h);
  const action = {type: 'fold'} as const;
  const transition = act(h, 0, action);
  assert.deepEqual(h, before);
  assert.equal(deck.length, 52);
  assert.deepEqual(entries.map(p => p.stack), [1000, 1000]);
  const snapshot = structuredClone(transition.state);
  for (const event of transition.events) {
    assert.ok(!('hole' in event) && !('deck' in event));
    if (event.type === 'settled') event.result.awards[0]!.amount = -1;
  }
  assert.deepEqual(transition.state, snapshot);
  assert.notEqual(transition.events[0]!.type === 'action' && transition.events[0]!.action, action);
  assert.throws(() => act(h, 0, {type: 'check'}));
  assert.deepEqual(h, before);
});

test('timeout checks when free and folds when owing; finished hands reject it', () => {
  const h = startHand(entries, 0, [5, 10], fullDeck(), 1);
  assert.deepEqual(timeoutAction(h), {type: 'fold'});
  const n = act(h, 0, {type: 'call'}).state;
  assert.deepEqual(timeoutAction(n), {type: 'check'});
  assert.throws(() => timeoutAction(act(h, 0, {type: 'fold'}).state));
});

test('invalid entries, blinds, identity and decks are rejected', () => {
  for (const invalid of [[], [entries[0]!], [entries[0]!, entries[0]!], [{seat: 0, stack: 0}, entries[1]!], [{seat: 9, stack: 10}, entries[1]!]]) {
    assert.throws(() => startHand(invalid, 0, [5, 10], fullDeck(), 1));
  }
  assert.throws(() => startHand(entries, 3, [5, 10], fullDeck(), 1));
  assert.throws(() => startHand(entries, 0, [0, 10], fullDeck(), 1));
  assert.throws(() => startHand(entries, 0, [10, 5], fullDeck(), 1));
  assert.throws(() => startHand(entries, 0, [5, 10], fullDeck(), -1));
  for (const deck of [fullDeck().slice(1), Array(52).fill(0), [...fullDeck().slice(1), 52]]) {
    assert.throws(() => startHand(entries, 0, [5, 10], deck, 1));
  }
});

test('sparse decks and blind arrays cannot bypass validation', () => {
  const deck = fullDeck();
  delete deck[10];
  assert.throws(() => startHand(entries, 0, [5, 10], deck, 1));
  const blinds: [number, number] = [5, 10];
  delete (blinds as number[])[0];
  assert.throws(() => startHand(entries, 0, blinds, fullDeck(), 1));
});

test('runout events are independent public snapshots in street order', () => {
  let h = startHand(entries, 0, [5, 10], fullDeck(), 1);
  h = act(h, 0, {type: 'allIn'}).state;
  const {state, events} = act(h, 1, {type: 'call'});
  assert.deepEqual(events.map(e => e.type), ['action', 'street', 'street', 'street', 'settled']);
  const streets = events.filter(e => e.type === 'street');
  assert.deepEqual(streets.map(e => e.board.length), [3, 4, 5]);
  const snapshot = structuredClone(state);
  streets[0]!.board[0] = 51;
  assert.deepEqual(state, snapshot);
  assert.equal(streets[1]!.board[0], 5);
});

test('seat gaps, input order and multiple all-in layers preserve chips', () => {
  let h = startHand([{seat: 8, stack: 40}, {seat: 2, stack: 100}, {seat: 5, stack: 25}], 8, [5, 10], fullDeck(), 9);
  assert.equal(h.bigBlindSeat, 5);
  assert.equal(h.actor, 8);
  h = act(h, 8, {type: 'allIn'}).state;
  assert.equal(h.actor, 2);
  h = act(h, 2, {type: 'call'}).state;
  assert.equal(h.actor, 5);
  h = act(h, 5, {type: 'allIn'}).state;
  assert.equal(h.street, 'settled');
  assert.equal(total(h), 165);
  assert.deepEqual(h.result!.pots.map(p => p.amount), [75, 30]);
});

for (const [stack, refunds] of [[3, [{seat: 0, amount: 2}]], [5, []]] as const) {
  test(`blind all-in of ${stack} covered by small blind runs out without an actor`, () => {
    const h = startHand([{seat: 0, stack: 100}, {seat: 1, stack}], 0, [5, 10], fullDeck(), 1);
    assert.equal(h.street, 'settled');
    assert.equal(h.actor, null);
    assert.equal(h.board.length, 5);
    assert.deepEqual(h.result!.refunds, refunds);
    assert.equal(total(h), 100 + stack);
    assert.throws(() => timeoutAction(h));
  });
}

test('short big blind keeps nominal wager while multiple players can act', () => {
  const h = startHand([{seat: 0, stack: 100}, {seat: 1, stack: 100}, {seat: 2, stack: 3}], 0, [5, 10], fullDeck(), 1);
  assert.equal(h.currentBet, 10);
  assert.equal(h.actor, 0);
  assert.equal(h.board.length, 0);
});
