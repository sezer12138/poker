export type Card = number;
export type SeatId = number;
export type Action =
  | {type: 'fold' | 'check' | 'call' | 'allIn'}
  | {type: 'raiseTo'; amount: number};
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'settled';

export interface Player {
  seat: SeatId;
  stack: number;
  roundBet: number;
  committed: number;
  folded: boolean;
  hole: Card[];
  actedAt: number | null;
  reopenBy: number;
}

export interface Pot {amount: number; eligible: SeatId[]}
export interface Award {seat: SeatId; amount: number}
export interface Result {pots: Pot[]; awards: Award[]; refunds: Award[]}

export interface Hand {
  id: number;
  players: Player[];
  button: SeatId;
  bigBlindSeat: SeatId;
  smallBlind: number;
  bigBlind: number;
  street: Street;
  actor: SeatId | null;
  currentBet: number;
  lastFullRaise: number;
  deck: Card[];
  cursor: number;
  board: Card[];
  burned: Card[];
  result: Result | null;
}

export interface Legal {
  fold: boolean;
  check: boolean;
  call: number | null;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  allIn: boolean;
}

export interface Entry {seat: SeatId; stack: number}

export interface Tournament {
  entries: Entry[];
  completedHands: number;
  button: SeatId;
  previousBigBlind: SeatId | null;
  hand: Hand | null;
  winner: SeatId | null;
}

export type EngineEvent =
  | {type: 'action'; seat: SeatId; action: Action}
  | {type: 'street'; street: Street; board: Card[]}
  | {type: 'settled'; result: Result};

export interface Transition<T> {state: T; events: EngineEvent[]}

export type RuleErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_DECK'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_ACTION'
  | 'HAND_FINISHED'
  | 'MATCH_FINISHED';

export class RuleError extends Error {
  code: RuleErrorCode;

  constructor(code: RuleErrorCode, message: string) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}
