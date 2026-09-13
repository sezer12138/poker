import {RuleError, type Card} from './types.ts';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

export function cards(text: string): Card[] {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new RuleError('INVALID_INPUT', 'Cards must be a non-empty string');
  }

  return text.trim().split(/\s+/).map((token) => {
    if (!/^[2-9TJQKA][cdhs]$/.test(token)) {
      throw new RuleError('INVALID_INPUT', 'Invalid card encoding');
    }
    return SUITS.indexOf(token[1]!) * 13 + RANKS.indexOf(token[0]!);
  });
}

export function fullDeck(): Card[] {
  return Array.from({length: 52}, (_, card) => card);
}
