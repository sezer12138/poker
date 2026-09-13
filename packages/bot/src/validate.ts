import type {Action, Card, HandView, Legal} from '../../poker-engine/src/index.ts';

export type BotErrorCode = 'INVALID_VIEW' | 'ILLEGAL_ACTION';

export class BotError extends Error {
  code: BotErrorCode;

  constructor(code: BotErrorCode, message: string) {
    super(message);
    this.name = 'BotError';
    this.code = code;
  }
}

export interface ViewFacts {
  /** The seat this view belongs to: the only player whose hole cards are visible. */
  seat: number;
  hole: Card[];
  /** Public community cards; never a hidden card. */
  board: Card[];
  legal: Legal;
  /** Live opponents still able to win the pot. */
  opponents: number;
  /** Every chip already committed to the pot this hand. */
  pot: number;
  /** Chips needed to call; zero when checking is free. */
  toCall: number;
  ownRoundBet: number;
  ownStack: number;
  /** Highest round bet at the table, equal to the engine's current bet. */
  maxRoundBet: number;
}

/**
 * Reads only the fields this bot is allowed to see. Others' hole cards are never
 * inspected, so a view with their cards removed behaves identically.
 */
export function readView(view: HandView): ViewFacts {
  if (view === null || typeof view !== 'object') throw new BotError('INVALID_VIEW', 'An action needs a hand view.');
  if (view.street === 'settled') throw new BotError('INVALID_VIEW', 'The hand is already settled.');
  if (view.legal === null) throw new BotError('INVALID_VIEW', 'A bot may only act for its own seat.');
  if (!Array.isArray(view.players) || view.players.length < 2) {
    throw new BotError('INVALID_VIEW', 'The view must list every player in the hand.');
  }

  const visible = view.players.filter(player => player.hole.length === 2);
  if (visible.length !== 1) {
    throw new BotError('INVALID_VIEW', 'Exactly one seat must be visible to the bot.');
  }
  const own = visible[0]!;
  if (own.folded) throw new BotError('INVALID_VIEW', 'A folded player cannot act.');
  for (const player of view.players) {
    if (player.hole.length !== 0 && player.hole.length !== 2) {
      throw new BotError('INVALID_VIEW', 'Visible hole cards must be a two-card hand.');
    }
  }

  let pot = 0;
  let maxRoundBet = 0;
  let opponents = 0;
  for (const player of view.players) {
    pot += player.committed;
    if (player.roundBet > maxRoundBet) maxRoundBet = player.roundBet;
    if (!player.folded && player.seat !== own.seat) opponents++;
  }

  return {
    seat: own.seat,
    hole: [...own.hole],
    board: [...view.board],
    legal: view.legal,
    opponents,
    pot,
    toCall: view.legal.call ?? 0,
    ownRoundBet: own.roundBet,
    ownStack: own.stack,
    maxRoundBet,
  };
}

/** Mirrors the engine's legality rules so a bot can never submit an illegal action. */
export function assertLegal(facts: ViewFacts, action: Action): void {
  const {legal} = facts;
  if (action === null || typeof action !== 'object') throw new BotError('ILLEGAL_ACTION', 'Action must be an object.');
  if (action.type === 'fold') {
    if (!legal.fold) throw new BotError('ILLEGAL_ACTION', 'Folding is not available.');
    return;
  }
  if (action.type === 'check') {
    if (!legal.check) throw new BotError('ILLEGAL_ACTION', 'Checking is not available.');
    return;
  }
  if (action.type === 'call') {
    if (legal.call === null) throw new BotError('ILLEGAL_ACTION', 'There is nothing to call.');
    return;
  }
  if (action.type === 'allIn') {
    if (!legal.allIn) throw new BotError('ILLEGAL_ACTION', 'All-in is not available.');
    return;
  }
  if (action.type === 'raiseTo') {
    const amount = action.amount;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new BotError('ILLEGAL_ACTION', 'Raise target must be a whole number.');
    const full = legal.minRaiseTo !== null && amount >= legal.minRaiseTo && amount <= legal.maxRaiseTo!;
    const shortAllIn = legal.allIn && amount === facts.ownRoundBet + facts.ownStack && amount > facts.maxRoundBet;
    if (!full && !shortAllIn) throw new BotError('ILLEGAL_ACTION', 'Raise target is outside the legal range.');
    return;
  }
  throw new BotError('ILLEGAL_ACTION', 'Unknown action type.');
}
