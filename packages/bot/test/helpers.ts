import {cards, type Card, type HandView, type Legal, type Street} from '../../poker-engine/src/index.ts';

/** Reproducible TEST ONLY generator. Not secure and not exported by production. */
export function testRandom(initialSeed = 20260913): () => number {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export interface ViewOptions {
  hole?: Card[];
  board?: Card[];
  legal?: Partial<Legal>;
  stack?: number;
  committed?: number;
  roundBet?: number;
  seat?: number;
  street?: Street;
  opponents?: number;
}

const DEFAULT_LEGAL: Legal = {
  fold: true,
  check: true,
  call: null,
  minRaiseTo: null,
  maxRaiseTo: null,
  allIn: false,
};

/** Builds a view from a seat's perspective; other seats stay hidden unless asked. */
export function makeView(options: ViewOptions = {}): HandView {
  const seat = options.seat ?? 0;
  const hole = options.hole ?? cards('As Kd');
  const board = options.board ?? [];
  const opponents = options.opponents ?? 1;
  const stack = options.stack ?? 990;
  const committed = options.committed ?? 10;
  const roundBet = options.roundBet ?? 10;

  const players = [{seat, stack, roundBet, committed, folded: false, hole: [...hole]}];
  for (let i = 0; i < opponents; i++) {
    players.push({seat: seat + 1 + i, stack, roundBet, committed, folded: false, hole: []});
  }

  return {
    id: 1,
    street: options.street ?? (board.length === 0 ? 'preflop' : board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : 'river'),
    button: 0,
    actor: seat,
    board: [...board],
    players,
    legal: {...DEFAULT_LEGAL, ...options.legal},
    result: null,
  };
}

/** A leaky view that hands the bot another seat's hole cards; it must be refused. */
export function leakView(view: HandView): HandView {
  return {
    ...view,
    players: view.players.map(player => (player.seat === view.actor ? player : {...player, hole: [51, 50]})),
  };
}
