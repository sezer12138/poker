import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contribute,
  createRound,
  finalizeRound,
  FairnessError,
  reconstructDeck,
  sha256Hex,
  verifyRound,
  type FairRound,
} from '../src/index.ts';

const ZERO = '0'.repeat(64);
const SEED_A = '00'.repeat(32);
const SEED_B = '11'.repeat(32);
const NONCE_22 = '22'.repeat(32);
const NONCE_33 = '33'.repeat(32);

// Vectors generated independently with node:crypto (command recorded in packages/fairness/README.md).
const COMMITMENT_A = '788489f253963ea96d3f8f196f8599b38a597977f8de222787431f2984f36414';
const DECK_A = [
  42, 17, 26, 43, 6, 30, 50, 28, 15, 44, 32, 49, 7, 24, 47, 38, 41, 37, 9, 14, 16, 8, 22, 31, 33, 27,
  13, 1, 34, 45, 0, 21, 48, 36, 40, 11, 10, 3, 19, 25, 18, 46, 39, 2, 20, 23, 51, 5, 29, 4, 12, 35,
];
const DECK_A_COMMITMENT = '3a04fab60ba71a668404418cb282ac600064d56779dc24f6a16a55e4a098648b';
const DECK_B = [
  6, 37, 8, 0, 50, 12, 45, 34, 30, 10, 15, 32, 1, 44, 26, 5, 33, 29, 25, 51, 43, 36, 4, 20, 35, 42,
  19, 23, 48, 40, 27, 22, 24, 41, 11, 18, 3, 46, 9, 14, 38, 17, 16, 13, 28, 49, 21, 31, 7, 2, 39, 47,
];
const DECK_B_COMMITMENT = 'a3114c5623d0731323926dfda1a4b1448f9598ce1327e6d42e14cc92b82b4cd0';

function roundFor(matchId: string, handNo: number, serverSeed: string, contributions: Record<string, string>): FairRound {
  return {
    version: 'hmac-sha256-fy-v1',
    matchId,
    handNo,
    serverSeed,
    commitment: sha256Hex(JSON.stringify(['hmac-sha256-fy-v1', matchId, handNo, serverSeed])),
    contributions,
    seats: [],
    deckCommitment: null,
  };
}

test('createRound produces a fresh seed whose commitment binds match, hand and version', () => {
  const round = createRound('match-a', 1);
  assert.equal(round.version, 'hmac-sha256-fy-v1');
  assert.match(round.serverSeed, /^[0-9a-f]{64}$/);
  assert.deepEqual(round.contributions, {});
  assert.deepEqual(round.seats, []);
  assert.equal(round.deckCommitment, null);
  assert.match(round.commitment, /^[0-9a-f]{64}$/);
  assert.equal(verifyRound(round).valid, true);

  const other = createRound('match-a', 1);
  assert.notEqual(other.serverSeed, round.serverSeed);
  assert.notEqual(other.commitment, round.commitment);
});

test('createRound rejects malformed match ids and hand numbers', () => {
  assert.throws(() => createRound('', 1));
  assert.throws(() => createRound('x'.repeat(65), 1));
  assert.throws(() => createRound('match', 0));
  assert.throws(() => createRound('match', 1.5));
});

test('fixed vector: all-zero contributions reproduce the published deck and commitment', () => {
  const round = roundFor('match-a', 1, SEED_A, {'0': ZERO, '1': ZERO, '2': ZERO});
  assert.equal(round.commitment, COMMITMENT_A);
  const {round: finalized, deck} = finalizeRound(round, [0, 1, 2]);
  assert.deepEqual(deck, DECK_A);
  assert.equal(finalized.deckCommitment, DECK_A_COMMITMENT);
  assert.deepEqual(reconstructDeck(finalized), DECK_A);
  assert.deepEqual(verifyRound(finalized), {valid: true, errors: []});
});

test('fixed vector: real contributions change the deck', () => {
  const round = roundFor('match-b', 7, SEED_B, {'0': NONCE_22, '1': NONCE_33});
  const {round: finalized, deck} = finalizeRound(round, [0, 1, 2]);
  assert.deepEqual(deck, DECK_B);
  assert.equal(finalized.deckCommitment, DECK_B_COMMITMENT);
  assert.notDeepEqual(deck, DECK_A);
  assert.equal(finalized.contributions['2'], ZERO);
});

test('finalizeRound fills missing seats with the public zero nonce', () => {
  const {round} = finalizeRound(roundFor('match-fill', 3, SEED_A, {2: NONCE_33}), [0, 1, 2]);
  assert.deepEqual(round.contributions, {'0': ZERO, '1': ZERO, '2': NONCE_33});
  assert.deepEqual(round.seats, [0, 1, 2]);
});

test('a deck is always a permutation of all 52 cards', () => {
  const {deck} = finalizeRound(roundFor('match-perm', 9, SEED_B, {}), [0, 1]);
  assert.equal(deck.length, 52);
  assert.deepEqual([...deck].sort((a, b) => a - b), Array.from({length: 52}, (_, i) => i));
});

test('contribute is immutable and rejects duplicates, bad seats and bad nonces', () => {
  const round = createRound('match-c', 2);
  const before = structuredClone(round);
  const next = contribute(round, 1, NONCE_22);
  assert.deepEqual(round, before, 'the original round must not change');
  assert.deepEqual(next.contributions, {'1': NONCE_22});

  assert.throws(() => contribute(next, 1, NONCE_33), (error: unknown) =>
    error instanceof FairnessError && error.code === 'DUPLICATE_CONTRIBUTION');
  assert.throws(() => contribute(round, 9, NONCE_22), (error: unknown) =>
    error instanceof FairnessError && error.code === 'INVALID_SEAT');
  assert.throws(() => contribute(round, 0, 'A'.repeat(64)), (error: unknown) =>
    error instanceof FairnessError && error.code === 'INVALID_NONCE');
  assert.throws(() => contribute(round, 0, 'ab'), (error: unknown) =>
    error instanceof FairnessError && error.code === 'INVALID_NONCE');
});

test('finalizeRound runs exactly once and seals further contributions', () => {
  const round = createRound('match-d', 4);
  const {round: finalized} = finalizeRound(round, [0, 1]);
  assert.throws(() => finalizeRound(finalized, [0, 1]), (error: unknown) =>
    error instanceof FairnessError && error.code === 'ALREADY_FINALIZED');
  assert.throws(() => contribute(finalized, 0, ZERO), (error: unknown) =>
    error instanceof FairnessError && error.code === 'ALREADY_FINALIZED');
  assert.deepEqual(round.deckCommitment, null, 'the original round must stay unfinalized');
});

test('finalizeRound requires unique ascending seats inside the table', () => {
  const round = createRound('match-e', 5);
  for (const seats of [[], [1, 0], [0, 0], [0, 9], [0, -1], [0, 1, 1]]) {
    assert.throws(() => finalizeRound(round, seats), (error: unknown) =>
      error instanceof FairnessError && error.code === 'INVALID_SEATS', `seats ${seats}`);
  }
  assert.throws(() => finalizeRound(round, [0, 1, 2, 3, 4, 5, 6, 7, 8, 0] as number[]), (error: unknown) =>
    error instanceof FairnessError && error.code === 'INVALID_SEATS');
});

test('finalizeRound rejects contributions from seats outside the hand', () => {
  const round = contribute(createRound('match-f', 6), 5, ZERO);
  assert.throws(() => finalizeRound(round, [0, 1]), (error: unknown) =>
    error instanceof FairnessError && error.code === 'INVALID_SEATS');
});

test('tampering with the seed, a contribution or the commitment is detected', () => {
  const {round} = finalizeRound(roundFor('match-g', 8, SEED_A, {'0': NONCE_22}), [0, 1]);

  const seedTampered = {...round, serverSeed: '01' + round.serverSeed.slice(2)};
  assert.deepEqual(verifyRound(seedTampered).errors, ['种子承诺不匹配', '牌序承诺与重建牌序不符']);

  const contributionTampered = {...round, contributions: {'0': NONCE_33, '1': ZERO}};
  assert.deepEqual(verifyRound(contributionTampered).errors, ['牌序承诺与重建牌序不符']);

  const commitmentTampered = {...round, deckCommitment: 'ff'.repeat(32)};
  assert.deepEqual(verifyRound(commitmentTampered).errors, ['牌序承诺与重建牌序不符']);

  const badVersion = {...round, version: 'something-else'} as unknown as FairRound;
  assert.ok(verifyRound(badVersion).errors.includes('算法版本不受支持'));

  const badSeats = {...round, seats: [1, 0]};
  assert.ok(verifyRound(badSeats).errors.includes('座位列表必须升序且唯一'));

  assert.equal(verifyRound(round).valid, true);
});

test('verifyRound reports malformed records instead of throwing', () => {
  assert.equal(verifyRound(null as unknown as FairRound).valid, false);
  assert.equal(verifyRound('nope' as unknown as FairRound).valid, false);
  const broken = {...roundFor('match-h', 1, SEED_A, {}), serverSeed: 'zz', seats: [0]};
  const result = verifyRound(broken);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('服务器种子格式非法'));
});

test('verifyRound flags an unfinalized round whose seat list is empty', () => {
  const round = roundFor('match-i', 1, SEED_A, {});
  const result = verifyRound({...round, deckCommitment: 'aa'.repeat(32)});
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
