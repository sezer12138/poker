import {compare, evaluate, type Action, type Card} from '../../poker-engine/src/index.ts';
import type {ViewFacts} from './validate.ts';

/** Category strength for ranks 0 (high card) through 8 (straight flush). */
const CATEGORY_STRENGTH = [0.22, 0.45, 0.58, 0.72, 0.8, 0.86, 0.92, 0.97, 1];

function rankOf(card: Card): number {
  return (card % 13) + 2;
}

function suitOf(card: Card): number {
  return Math.floor(card / 13);
}

/** Best five-card rank out of the hole cards plus whatever board is dealt. */
function bestRank(hole: readonly Card[], board: readonly Card[]): number[] | null {
  if (board.length === 0) return null;
  const all = [...hole, ...board];
  if (all.length === 5 || all.length === 7) return evaluate(all);
  if (all.length !== 6) return null;
  // The turn exposes six cards; evaluate() accepts five or seven, so try each five.
  let best: number[] | null = null;
  for (let skip = 0; skip < 6; skip++) {
    const five = all.filter((_, index) => index !== skip);
    const rank = evaluate(five);
    if (best === null || compare(rank, best) > 0) best = rank;
  }
  return best;
}

/** Rough preflop strength in 0..1 from ranks, pairing, suitedness and connectedness. */
function preflopStrength(hole: readonly Card[]): number {
  const ranks = hole.map(rankOf).sort((a, b) => b - a);
  const high = ranks[0]!;
  const low = ranks[1]!;
  if (high === low) return Math.min(1, 0.5 + ((high - 2) / 12) * 0.5);

  let score = ((high + low) / 28) * 0.35;
  if (suitOf(hole[0]!) === suitOf(hole[1]!)) score += 0.06;
  const gap = high - low;
  if (gap === 1) score += 0.05;
  else if (gap === 2) score += 0.02;
  if (high === 14 && low >= 10) score += 0.05;
  return Math.min(score, 0.62);
}

export function estimateStrength(hole: readonly Card[], board: readonly Card[]): number {
  if (board.length === 0) return preflopStrength(hole);
  const rank = bestRank(hole, board);
  if (rank === null) return preflopStrength(hole);
  const kicker = Math.min(0.04, ((rank[1] ?? 0) / 14) * 0.04);
  return Math.min(1, CATEGORY_STRENGTH[rank[0]!]! + kicker);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Strength already accounts for made hands; the opponent count discounts it. */
export function estimateEquity(strength: number, opponents: number): number {
  return clamp(strength / (1 + 0.35 * Math.max(0, opponents - 1)), 0, 1);
}

function raiseAction(facts: ViewFacts, equity: number, random: () => number): Action {
  const min = facts.legal.minRaiseTo!;
  const max = facts.legal.maxRaiseTo!;
  if (facts.legal.allIn && equity > 0.9 && random() < 0.6) return {type: 'allIn'};
  const target = equity > 0.85 ? Math.min(max, min * 2) : min;
  return {type: 'raiseTo', amount: target};
}

/**
 * Basic strategy: check when free and weak, call when the price beats the equity,
 * raise with strong hands, and bluff occasionally. Every branch is gated by the
 * legal-action set the caller already validated.
 */
export function decide(facts: ViewFacts, random: () => number): Action {
  const equity = clamp(estimateEquity(estimateStrength(facts.hole, facts.board), facts.opponents), 0, 1);
  const {legal} = facts;
  const canRaise = legal.minRaiseTo !== null && legal.maxRaiseTo !== null;

  if (legal.call !== null) {
    const price = legal.call / (facts.pot + legal.call);
    if (equity <= price) return {type: 'fold'};
    if (canRaise && equity > 0.78 && random() < 0.7) return raiseAction(facts, equity, random);
    return {type: 'call'};
  }

  if (canRaise && (equity > 0.7 || random() < 0.12)) return raiseAction(facts, equity, random);
  return {type: 'check'};
}
