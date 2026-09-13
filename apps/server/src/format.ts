import type {Card} from '../../../packages/poker-engine/src/index.ts';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♣', '♦', '♥', '♠'];

export function cardText(card: Card): string {
  return `${RANKS[card % 13]!}${SUITS[Math.floor(card / 13)]!}`;
}

export function cardsText(cards: readonly Card[]): string {
  return cards.map(cardText).join(' ');
}
