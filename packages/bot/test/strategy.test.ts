import test from 'node:test';
import assert from 'node:assert/strict';
import {cards} from '../../poker-engine/src/index.ts';
import {estimateEquity, estimateStrength} from '../src/index.ts';

test('preflop strength orders pairs, big cards and suited connectors sensibly', () => {
  const aces = estimateStrength(cards('As Ad'), []);
  const kings = estimateStrength(cards('Ks Kd'), []);
  const twos = estimateStrength(cards('2s 2d'), []);
  const aceKing = estimateStrength(cards('As Kd'), []);
  const aceKingSuited = estimateStrength(cards('As Ks'), []);
  const sevenTwo = estimateStrength(cards('7s 2d'), []);

  assert.ok(aces > kings, 'aces must beat kings');
  assert.ok(kings > twos, 'kings must beat twos');
  assert.ok(aces > aceKingSuited, 'a pair must beat a suited big ace');
  assert.ok(twos > sevenTwo, 'a small pair must beat a weak offsuit hand');
  assert.ok(aceKingSuited > aceKing, 'suitedness must add value');
  assert.ok(sevenTwo < 0.3, 'the worst hand must stay weak');
  assert.ok(aces <= 1 && sevenTwo >= 0);
});

test('postflop strength follows the made hand', () => {
  const board = cards('2c 7d 9h');
  const highCard = estimateStrength(cards('As 4d'), board);
  const pair = estimateStrength(cards('9s 4d'), board);
  const twoPair = estimateStrength(cards('9s 7c'), board);
  const trips = estimateStrength(cards('9s 9c'), board);

  assert.ok(highCard < pair, 'a pair must beat a high card');
  assert.ok(pair < twoPair, 'two pair must beat a pair');
  assert.ok(twoPair < trips, 'trips must beat two pair');
});

test('the turn is evaluated by trying every five-card subset', () => {
  const turn = cards('5h 6s 8c 9d');
  const straight = estimateStrength(cards('7c 2d'), turn);
  const weakPair = estimateStrength(cards('2s 2h'), turn);
  assert.ok(straight >= 0.8, `a straight must score high, got ${straight}`);
  assert.ok(weakPair < straight, 'a pair must stay below a straight');
});

test('made hands on the river outrank weaker categories', () => {
  const river = cards('2c 7d 9h Js Qc');
  assert.ok(estimateStrength(cards('Qd Qh'), river) > estimateStrength(cards('Jd Qh'), river));
  assert.ok(estimateStrength(cards('Ts Kd'), river) > estimateStrength(cards('2s 7h'), river));
});

test('equity falls as opponents are added', () => {
  const strength = 0.9;
  assert.ok(estimateEquity(strength, 1) > estimateEquity(strength, 2));
  assert.ok(estimateEquity(strength, 2) > estimateEquity(strength, 5));
  assert.equal(estimateEquity(strength, 1), strength);
  assert.ok(estimateEquity(1, 9) > 0.25);
});
