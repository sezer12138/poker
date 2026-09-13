import test from 'node:test';
import assert from 'node:assert/strict';
import {createRound, finalizeRound} from '../src/index.ts';

// Supplementary check only: a passing distribution test shows the shuffle is not
// obviously biased. It is not a proof of fairness or of operator honesty.
test('20,000 decks are all permutations with a spread-out first card', () => {
  const samples = 20000;
  const firstCard = Array<number>(52).fill(0);
  for (let i = 0; i < samples; i++) {
    const {deck} = finalizeRound(createRound('match-dist', i + 1), [0, 1, 2]);
    assert.equal(deck.length, 52);
    assert.equal(new Set(deck).size, 52);
    let sum = 0;
    for (const card of deck) {
      assert.ok(Number.isInteger(card) && card >= 0 && card < 52);
      sum += card;
    }
    assert.equal(sum, (51 * 52) / 2, 'every deck must contain each card exactly once');
    firstCard[deck[0]!]!++;
  }

  const expected = samples / 52;
  const deviation = Math.sqrt(samples * (1 / 52) * (51 / 52));
  for (let card = 0; card < 52; card++) {
    assert.ok(
      Math.abs(firstCard[card]! - expected) < deviation * 6,
      `card ${card} led ${firstCard[card]} of ${samples} decks (expected about ${expected.toFixed(1)})`,
    );
  }
  assert.ok(firstCard.every(count => count > 0), 'every card must reach the top of the deck sometimes');
});
