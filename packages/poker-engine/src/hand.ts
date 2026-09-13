import {applyBet, legalActions} from './betting.ts';
import {evaluate} from './evaluate.ts';
import {buildPots, distribute} from './pots.ts';
import {RuleError, type Action, type Card, type EngineEvent, type Entry, type Hand, type SeatId, type Transition} from './types.ts';

function invalid(): never {
  throw new RuleError('INVALID_INPUT', 'Invalid hand configuration.');
}

function clockwise(seats: readonly SeatId[], after: SeatId): SeatId[] {
  const distance = (seat: SeatId) => (seat - after + 9) % 9 || 9;
  return [...seats].sort((a, b) => distance(a) - distance(b));
}

function settle(h: Hand, events: EngineEvent[]): void {
  const {pots, refunds} = buildPots(h.players);
  const live = h.players.filter(p => !p.folded);
  // A fold winner needs no board or hand evaluation.
  const ranks = new Map(live.map(p => [p.seat, live.length === 1 ? [0] : evaluate([...p.hole, ...h.board])]));
  const awards = distribute(pots, ranks, h.button);
  h.result = {pots, refunds, awards};
  for (const payment of [...refunds, ...awards]) {
    h.players.find(p => p.seat === payment.seat)!.stack += payment.amount;
  }
  for (const p of h.players) {
    p.committed = 0;
    p.roundBet = 0;
  }
  h.street = 'settled';
  h.actor = null;
  h.currentBet = 0;
  events.push({type: 'settled', result: structuredClone(h.result)});
}

/** Normalize after blinds or an action, including streets with no possible betting. */
function advance(h: Hand, after: SeatId, events: EngineEvent[]): void {
  for (;;) {
    const live = h.players.filter(p => !p.folded);
    if (live.length === 1) {
      settle(h, events);
      return;
    }
    const active = live.filter(p => p.stack > 0);
    // A lone player only owes actual wagers; the nominal blind cannot create a decision.
    const owedBet = active.length === 1 ? Math.max(...live.map(p => p.roundBet)) : h.currentBet;
    const pending = active.filter(p => p.roundBet < owedBet || (active.length > 1 && p.actedAt === null));
    if (pending.length > 0) {
      h.actor = clockwise(pending.map(p => p.seat), after)[0]!;
      return;
    }
    if (h.street === 'river') {
      settle(h, events);
      return;
    }
    h.street = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
    h.burned.push(h.deck[h.cursor++]!);
    const count = h.street === 'flop' ? 3 : 1;
    for (let i = 0; i < count; i++) h.board.push(h.deck[h.cursor++]!);
    h.currentBet = 0;
    h.lastFullRaise = h.bigBlind;
    for (const p of h.players) {
      p.roundBet = 0;
      p.actedAt = null;
      p.reopenBy = h.bigBlind;
    }
    events.push({type: 'street', street: h.street, board: [...h.board]});
    after = h.button;
  }
}

export function startHand(
  entries: readonly Entry[], button: SeatId, blinds: readonly [number, number],
  deck: readonly Card[], id: number,
): Hand {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 9) invalid();
  const seats = new Set<number>();
  let total = 0;
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.seat) || entry.seat < 0 || entry.seat > 8 || seats.has(entry.seat)) invalid();
    if (!Number.isSafeInteger(entry.stack) || entry.stack <= 0) invalid();
    seats.add(entry.seat);
    total += entry.stack;
    if (!Number.isSafeInteger(total)) invalid();
  }
  if (!Number.isSafeInteger(button) || !seats.has(button) || !Number.isSafeInteger(id) || id < 0) invalid();
  if (!Array.isArray(blinds) || blinds.length !== 2 || ![...blinds].every(n => Number.isSafeInteger(n) && n > 0) || blinds[0]! > blinds[1]!) invalid();
  if (!Array.isArray(deck) || deck.length !== 52 || new Set(deck).size !== 52 || ![...deck].every(c => Number.isInteger(c) && c >= 0 && c < 52)) {
    throw new RuleError('INVALID_DECK', 'Deck must contain every card exactly once.');
  }
  const order = clockwise([...seats], button);
  const smallBlindSeat = entries.length === 2 ? button : order[0]!;
  const bigBlindSeat = entries.length === 2 ? order[0]! : order[1]!;
  const h: Hand = {
    id, button, bigBlindSeat, smallBlind: blinds[0], bigBlind: blinds[1],
    players: [...entries].sort((a, b) => a.seat - b.seat).map(p => ({
      ...p, roundBet: 0, committed: 0, folded: false, hole: [], actedAt: null, reopenBy: blinds[1],
    })),
    street: 'preflop', actor: null, currentBet: blinds[1], lastFullRaise: blinds[1],
    deck: [...deck], cursor: 0, board: [], burned: [], result: null,
  };
  for (let round = 0; round < 2; round++) {
    for (const seat of order) h.players.find(p => p.seat === seat)!.hole.push(h.deck[h.cursor++]!);
  }
  for (const [seat, amount] of [[smallBlindSeat, blinds[0]], [bigBlindSeat, blinds[1]]] as const) {
    const p = h.players.find(p => p.seat === seat)!;
    const paid = Math.min(p.stack, amount);
    p.stack -= paid;
    p.roundBet = paid;
    p.committed = paid;
  }
  advance(h, bigBlindSeat, []);
  return h;
}

export function act(h: Hand, seat: SeatId, a: Action): Transition<Hand> {
  const state = applyBet(h, seat, a);
  const action: Action = a.type === 'raiseTo' ? {type: 'raiseTo', amount: a.amount} : {type: a.type};
  const events: EngineEvent[] = [{type: 'action', seat, action}];
  advance(state, seat, events);
  return {state, events};
}

export function timeoutAction(h: Hand): Action {
  if (h.actor === null) throw new RuleError('HAND_FINISHED', 'Hand is finished.');
  return legalActions(h, h.actor).check ? {type: 'check'} : {type: 'fold'};
}
