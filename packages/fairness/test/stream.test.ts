import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createStream, uniform} from '../src/index.ts';

test('byte stream is deterministic for a fixed seed and context', () => {
  const seed = 'ab'.repeat(32);
  const first = createStream(seed, '["context"]');
  const second = createStream(seed, '["context"]');
  for (let i = 0; i < 200; i++) assert.equal(first.next(), second.next());
});

test('byte stream changes when the context changes', () => {
  const seed = 'ab'.repeat(32);
  const first = createStream(seed, '["a"]');
  const second = createStream(seed, '["b"]');
  const left = Array.from({length: 32}, () => first.next());
  const right = Array.from({length: 32}, () => second.next());
  assert.notDeepEqual(left, right);
});

test('counter mode keeps producing bytes past a block boundary', () => {
  const stream = createStream('cd'.repeat(32), '["block"]');
  const bytes = Array.from({length: 100}, () => stream.next());
  assert.equal(bytes.length, 100);
  assert.ok(bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255));
  assert.ok(new Set(bytes).size > 8);
});

test('uniform rejects ranges outside 1..256', () => {
  const stream = createStream('ef'.repeat(32), '["range"]');
  assert.throws(() => uniform(stream, 0));
  assert.throws(() => uniform(stream, 257));
  assert.throws(() => uniform(stream, 1.5));
});

test('uniform covers every value of a range and stays inside it', () => {
  const stream = createStream(randomBytes(32).toString('hex'), '["cover"]');
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const value = uniform(stream, 52);
    assert.ok(value >= 0 && value < 52);
    seen.add(value);
  }
  assert.equal(seen.size, 52);
});

test('rejection sampling stays uniform for every range a deck needs', () => {
  // Fixed seed keeps the check deterministic; bounds are six standard deviations,
  // which is tight enough to catch a biased modulo and wide enough to stay stable.
  const stream = createStream('5f'.repeat(32), '["uniform"]');
  const draws = 50000;
  for (let range = 2; range <= 52; range++) {
    const counts = Array<number>(range).fill(0);
    for (let i = 0; i < draws; i++) counts[uniform(stream, range)]!++;
    const expected = draws / range;
    const deviation = Math.sqrt(draws * (1 / range) * (1 - 1 / range));
    for (let value = 0; value < range; value++) {
      assert.ok(
        Math.abs(counts[value]! - expected) < deviation * 6,
        `range ${range} value ${value}: ${counts[value]} vs ${expected.toFixed(1)}`,
      );
    }
  }
});
