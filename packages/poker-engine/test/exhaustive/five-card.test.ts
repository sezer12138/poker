import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../../src/index.ts';

test('all 2,598,960 five-card combinations have the standard category counts', () => {
  const counts = Array<number>(9).fill(0);
  for (let a = 0; a < 48; a++)
    for (let b = a + 1; b < 49; b++)
      for (let c = b + 1; c < 50; c++)
        for (let d = c + 1; d < 51; d++)
          for (let e = d + 1; e < 52; e++) counts[evaluate([a,b,c,d,e])[0]!]++;
  assert.deepEqual(counts, [1302540,1098240,123552,54912,10200,5108,3744,624,40]);
  assert.equal(counts.reduce((a,b) => a+b, 0), 2598960);
});
