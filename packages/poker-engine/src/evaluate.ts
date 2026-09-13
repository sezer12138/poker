import {RuleError, type Card} from './types.ts';

export function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function evaluateFive(hand: readonly Card[]): number[] {
  const ranks = hand.map((card) => card % 13 + 2);
  const suits = hand.map((card) => Math.floor(card / 13));
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);

  const distinctDescending = [...counts.keys()].sort((a, b) => b - a);
  let straightHigh = 0;
  if (distinctDescending.length === 5) {
    if (distinctDescending[0]! - distinctDescending[4]! === 4) {
      straightHigh = distinctDescending[0]!;
    } else if (distinctDescending.join(',') === '14,5,4,3,2') {
      straightHigh = 5;
    }
  }
  const flush = suits.every((suit) => suit === suits[0]);
  if (flush && straightHigh) return [8, straightHigh];

  const groups = [...counts.entries()].sort(
    ([rankA, countA], [rankB, countB]) => countB - countA || rankB - rankA,
  );
  if (groups[0]![1] === 4) return [7, groups[0]![0], groups[1]![0]];
  if (groups[0]![1] === 3 && groups[1]![1] === 2) {
    return [6, groups[0]![0], groups[1]![0]];
  }
  if (flush) return [5, ...distinctDescending];
  if (straightHigh) return [4, straightHigh];
  if (groups[0]![1] === 3) {
    return [3, groups[0]![0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)];
  }
  if (groups[0]![1] === 2 && groups[1]![1] === 2) {
    const pairs = groups.slice(0, 2).map(([rank]) => rank).sort((a, b) => b - a);
    return [2, ...pairs, groups[2]![0]];
  }
  if (groups[0]![1] === 2) {
    return [1, groups[0]![0], ...groups.slice(1).map(([rank]) => rank).sort((a, b) => b - a)];
  }
  return [0, ...distinctDescending];
}

export function evaluate(input: readonly Card[]): number[] {
  if (!Array.isArray(input) || (input.length !== 5 && input.length !== 7)) {
    throw new RuleError('INVALID_INPUT', 'A hand must contain five or seven cards');
  }
  if (input.some((card) => !Number.isInteger(card) || card < 0 || card > 51)) {
    throw new RuleError('INVALID_INPUT', 'Cards must be integers from 0 to 51');
  }
  if (new Set(input).size !== input.length) {
    throw new RuleError('INVALID_INPUT', 'Cards in a hand must be unique');
  }
  if (input.length === 5) return evaluateFive(input);

  let best: number[] | null = null;
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 4; b++) {
      for (let c = b + 1; c < 5; c++) {
        for (let d = c + 1; d < 6; d++) {
          for (let e = d + 1; e < 7; e++) {
            const score = evaluateFive([input[a]!, input[b]!, input[c]!, input[d]!, input[e]!]);
            if (best === null || compare(score, best) > 0) best = score;
          }
        }
      }
    }
  }
  return best!;
}
