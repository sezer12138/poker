import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson, isHex64, sha256Hex, ZERO_NONCE} from '../src/index.ts';

test('canonical encoding sorts object keys at every depth', () => {
  assert.equal(canonicalJson({b: 1, a: 2}), '{"a":2,"b":1}');
  assert.equal(canonicalJson({z: {d: 1, c: [3, {f: 1, e: 2}]}}), '{"z":{"c":[3,{"e":2,"f":1}],"d":1}}');
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
});

test('canonical encoding is stable regardless of key insertion order', () => {
  const first = {alpha: 1, beta: {y: 2, x: 3}};
  const second = {beta: {x: 3, y: 2}, alpha: 1};
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('sha256 hex matches the published test vector', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('hex validation accepts only 64 lowercase hex characters', () => {
  assert.ok(isHex64(ZERO_NONCE));
  assert.ok(!isHex64('A'.repeat(64)));
  assert.ok(!isHex64('0'.repeat(63)));
  assert.ok(!isHex64('0'.repeat(65)));
  assert.ok(!isHex64(42));
  assert.ok(!isHex64(undefined));
});
