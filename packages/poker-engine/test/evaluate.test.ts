import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RuleError,
  cards,
  compare,
  evaluate,
  fullDeck,
} from '../src/index.ts';

test('wheel and royal flush', () => {
  assert.deepEqual(evaluate(cards('As 2d 3c 4h 5s')), [4, 5]);
  assert.deepEqual(evaluate(cards('Ts Js Qs Ks As 2h 3d')), [8, 14]);
  assert.equal(
    compare(
      evaluate(cards('As Ad Kc Qh 9s')),
      evaluate(cards('Ah Ac Kd Qs 8c')),
    ),
    1,
  );
  assert.throws(() => evaluate(cards('As As Kc Qh 9s')));
});

test('recognizes all nine hand categories', () => {
  const examples: Array<[string, number[]]> = [
    ['As Kd 9c 7h 3s', [0, 14, 13, 9, 7, 3]],
    ['As Ad Kc Qh 9s', [1, 14, 13, 12, 9]],
    ['As Ad Kc Kh 9s', [2, 14, 13, 9]],
    ['As Ad Ac Kh 9s', [3, 14, 13, 9]],
    ['9s 8d 7c 6h 5s', [4, 9]],
    ['As Js 9s 7s 3s', [5, 14, 11, 9, 7, 3]],
    ['As Ad Ac Kh Ks', [6, 14, 13]],
    ['As Ad Ac Ah Ks', [7, 14, 13]],
    ['9s 8s 7s 6s 5s', [8, 9]],
  ];

  for (const [text, expected] of examples) {
    assert.deepEqual(evaluate(cards(text)), expected, text);
  }
});

test('chooses the best five cards from seven independent of input order', () => {
  assert.deepEqual(evaluate(cards('As Ad Ac Ks Kd Kh 2c')), [6, 14, 13]);
  assert.deepEqual(evaluate(cards('2c Kh Kd As Ac Ks Ad')), [6, 14, 13]);
  assert.deepEqual(evaluate(cards('As Ad Ks Kd Qs Qd 2c')), [2, 14, 13, 12]);
  assert.deepEqual(evaluate(cards('2c Qd Kd Ad Qs Ks As')), [2, 14, 13, 12]);
  assert.deepEqual(evaluate(cards('As Js 9s 7s 3s Kd Qh')), [5, 14, 11, 9, 7, 3]);
  assert.deepEqual(evaluate(cards('As Ks Qs Js Ts 2d 3h')), [8, 14]);
});

test('parses cards and creates a complete unique deck', () => {
  assert.deepEqual(cards('2c Ad Kh Qs'), [0, 25, 37, 49]);
  assert.deepEqual(cards('  As   Kd\nTc 2h '), [51, 24, 8, 26]);
  const deck = fullDeck();
  assert.deepEqual(deck, Array.from({length: 52}, (_, card) => card));
  assert.equal(new Set(deck).size, 52);
});

test('rejects illegal card text and invalid evaluator input', () => {
  for (const text of ['', '1s', '15s', 'Ax', 'Ass', 'as']) {
    assert.throws(() => cards(text), (error: unknown) =>
      error instanceof RuleError && error.code === 'INVALID_INPUT');
  }

  for (const hand of [cards('As Ks Qs Js'), cards('As Ks Qs Js Ts 9d'), [0, 1, 2, 3, 52], [0, 1, 2, 3, 3], [0, 1, 2, 3, 4.5]]) {
    assert.throws(() => evaluate(hand), (error: unknown) =>
      error instanceof RuleError && error.code === 'INVALID_INPUT');
  }
});

test('compares score vectors lexicographically', () => {
  assert.equal(compare([1, 14, 13], [1, 14, 12]), 1);
  assert.equal(compare([1, 14], [1, 14, 0]), 0);
  assert.equal(compare([0, 14], [1, 2]), -1);
});

for (const length of [5, 7]) {
  test(`rejects every missing position in a ${length}-card hand without mutating input`, () => {
    for (let missing = 0; missing < length; missing++) {
      const hand = Array.from({length}, (_, card) => card);
      delete hand[missing];
      const before = hand.slice();
      assert.throws(() => evaluate(hand), (error: unknown) =>
        error instanceof RuleError && error.code === 'INVALID_INPUT');
      assert.deepEqual(hand, before);
      assert.equal(missing in hand, false);
    }
  });
}
