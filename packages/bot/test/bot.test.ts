import test from 'node:test';
import assert from 'node:assert/strict';
import {cards, type Action, type HandView} from '../../poker-engine/src/index.ts';
import {assertLegal, chooseAction, BotError, readView} from '../src/index.ts';
import {leakView, makeView, testRandom} from './helpers.ts';

const LEGAL_SETS: Partial<HandView['legal']>[] = [
  {check: true, call: null},
  {check: false, call: 20, minRaiseTo: 40, maxRaiseTo: 990, allIn: true},
  {check: false, call: 990, minRaiseTo: null, maxRaiseTo: null, allIn: false},
  {check: true, call: null, minRaiseTo: 20, maxRaiseTo: 990, allIn: true},
  {check: false, call: 5, minRaiseTo: 10, maxRaiseTo: 10, allIn: false},
];

function assertActionLegal(view: HandView, action: Action): void {
  assertLegal(readView(view), action);
}

test('every chosen action is legal across seeded views', () => {
  const random = testRandom(7);
  const boards = [[], cards('2c 7d 9h'), cards('2c 7d 9h Js'), cards('2c 7d 9h Js Qc')];
  for (let i = 0; i < 1000; i++) {
    const board = boards[i % boards.length]!;
    const pool = Array.from({length: 52}, (_, card) => card).filter(card => !board.includes(card));
    const first = Math.floor(random() * pool.length);
    let second = Math.floor(random() * pool.length);
    if (second === first) second = (second + 1) % pool.length;
    const view = makeView({
      hole: [pool[first]!, pool[second]!],
      board,
      legal: LEGAL_SETS[i % LEGAL_SETS.length]!,
      stack: 100 + (i % 7) * 130,
      roundBet: i % 5 === 0 ? 0 : 20,
      committed: 20 + (i % 3) * 40,
      opponents: 1 + (i % 4),
    });
    assertActionLegal(view, chooseAction(view, random));
  }
});

test('a view without legal actions is refused', () => {
  const view = makeView();
  assert.throws(() => chooseAction({...view, legal: null}), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');
});

test('a settled hand, a folded seat and a malformed hand are refused', () => {
  const view = makeView();
  assert.throws(() => readView({...view, street: 'settled'}), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');

  const folded = makeView();
  folded.players[0]!.folded = true;
  assert.throws(() => readView(folded), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');

  const noHole = makeView();
  noHole.players[0]!.hole = [];
  assert.throws(() => readView(noHole), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');

  assert.throws(() => readView(null as unknown as HandView), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');
  assert.throws(() => readView('nope' as unknown as HandView), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');
});

test('a leaky view carrying another seat hole cards is refused, never used', () => {
  const view = makeView();
  assert.throws(() => chooseAction(leakView(view), testRandom(1)), (error: unknown) =>
    error instanceof BotError && error.code === 'INVALID_VIEW');
});

test('the same view and random sequence produce the same action', () => {
  const view = makeView({legal: {check: false, call: 20, minRaiseTo: 40, maxRaiseTo: 990, allIn: true}});
  const first = Array.from({length: 25}, () => chooseAction(view, testRandom(99)));
  const second = Array.from({length: 25}, () => chooseAction(view, testRandom(99)));
  assert.deepEqual(first, second);
  assert.ok(first.every(action => action.type !== 'fold' || view.legal!.fold));
});

test('illegal actions are rejected by the guard', () => {
  const view = makeView({legal: {check: true, call: null}});
  const facts = readView(view);
  assert.throws(() => assertLegal(facts, {type: 'call'}));
  assert.throws(() => assertLegal(facts, {type: 'raiseTo', amount: 40}));
  assert.throws(() => assertLegal(facts, {type: 'allIn'}));
  assert.throws(() => assertLegal(facts, {type: 'bogus'} as unknown as Action));
  assert.throws(() => assertLegal(facts, null as unknown as Action));
  assertLegal(facts, {type: 'check'});
  assertLegal(facts, {type: 'fold'});

  const facing = makeView({legal: {check: false, call: 20, minRaiseTo: 40, maxRaiseTo: 100, allIn: true}, stack: 500, roundBet: 0});
  const facingFacts = readView(facing);
  assert.throws(() => assertLegal(facingFacts, {type: 'check'}));
  assert.throws(() => assertLegal(facingFacts, {type: 'raiseTo', amount: 39}));
  assert.throws(() => assertLegal(facingFacts, {type: 'raiseTo', amount: 101}));
  assertLegal(facingFacts, {type: 'call'});
  assertLegal(facingFacts, {type: 'raiseTo', amount: 40});
  assertLegal(facingFacts, {type: 'raiseTo', amount: 100});
  assertLegal(facingFacts, {type: 'allIn'});
});

test('a short all-in raise below the minimum is accepted only for the whole stack', () => {
  const view = makeView({
    stack: 30,
    roundBet: 10,
    legal: {check: false, call: 20, minRaiseTo: 60, maxRaiseTo: null, allIn: true},
  });
  const facts = readView(view);
  assertLegal(facts, {type: 'raiseTo', amount: 40});
  assert.throws(() => assertLegal(facts, {type: 'raiseTo', amount: 39}));
  assert.throws(() => assertLegal(facts, {type: 'raiseTo', amount: 41}));
});

test('the bot folds when the price is worse than its equity', () => {
  const weak = makeView({hole: cards('2c 7d'), legal: {check: false, call: 200, minRaiseTo: null, maxRaiseTo: null}});
  assert.deepEqual(chooseAction(weak, testRandom(3)), {type: 'fold'});
});

test('the bot calls or raises with a strong hand and never folds for free', () => {
  const strong = makeView({hole: cards('As Ad'), legal: {check: false, call: 20, minRaiseTo: 40, maxRaiseTo: 990, allIn: true}});
  const action = chooseAction(strong, testRandom(11));
  assert.ok(action.type === 'call' || action.type === 'raiseTo' || action.type === 'allIn');

  const free = makeView({hole: cards('2c 7d'), legal: {check: true, call: null}});
  assert.deepEqual(chooseAction(free, testRandom(5)), {type: 'check'});
});
