import type {Card} from '../src/types.ts';

/** Independent seven-card oracle: rank occupancy and suit sets, no five-card evaluator. */
export function referenceSeven(input: readonly Card[]): number[] {
  const counts = Array<number>(15).fill(0);
  const suits = Array.from({length: 4}, () => new Set<number>());
  for (const card of input) {
    const rank = card % 13 + 2;
    counts[rank]++;
    suits[Math.floor(card / 13)]!.add(rank);
  }
  const ranks = Array.from({length: 13}, (_, i) => 14 - i).filter(r => counts[r]! > 0);
  function straight(set: Set<number>): number {
    for (let high = 14; high >= 5; high--) {
      if (Array.from({length: 5}, (_, i) => high - i).every(r => set.has(r === 1 ? 14 : r))) return high;
    }
    return 0;
  }
  const flush = suits.find(s => s.size >= 5);
  if (flush && straight(flush)) return [8, straight(flush)];
  const quads = ranks.find(r => counts[r] === 4);
  if (quads) return [7, quads, ranks.find(r => r !== quads)!];
  const trips = ranks.filter(r => counts[r]! >= 3);
  const pair = ranks.find(r => r !== trips[0] && counts[r]! >= 2);
  if (trips.length && pair) return [6, trips[0]!, pair];
  if (flush) return [5, ...[...flush].sort((a, b) => b - a).slice(0, 5)];
  const run = straight(new Set(ranks));
  if (run) return [4, run];
  if (trips.length) return [3, trips[0]!, ...ranks.filter(r => r !== trips[0]).slice(0, 2)];
  const pairs = ranks.filter(r => counts[r]! >= 2);
  if (pairs.length >= 2) return [2, ...pairs.slice(0, 2), ranks.find(r => !pairs.slice(0, 2).includes(r))!];
  if (pairs.length) return [1, pairs[0]!, ...ranks.filter(r => r !== pairs[0]).slice(0, 3)];
  return [0, ...ranks.slice(0, 5)];
}

/** Reproducible TEST ONLY generator. Not secure and not exported by production. */
export function testRandom(initialSeed = 20260913) {
  let seed = initialSeed;
  const sample = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };
  const deck = (): Card[] => {
    const cards = Array.from({length: 52}, (_, i) => i);
    for (let i = 51; i > 0; i--) {
      const j = sample(i + 1);
      [cards[i], cards[j]] = [cards[j]!, cards[i]!];
    }
    return cards;
  };
  return {sample, deck};
}
