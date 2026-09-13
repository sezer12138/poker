import {RuleError, type Action, type Hand, type Legal, type SeatId} from './types.ts';

function actingPlayer(h: Hand, seat: SeatId) {
  if (!Number.isSafeInteger(seat) || seat < 0 || seat > 8) {
    throw new RuleError('INVALID_INPUT', 'Invalid seat.');
  }
  if (h.street === 'settled' || h.result !== null) {
    throw new RuleError('HAND_FINISHED', 'Hand is finished.');
  }
  const p = h.players.find(p => p.seat === seat);
  if (!p) throw new RuleError('INVALID_INPUT', 'Unknown seat.');
  if (h.actor !== seat) throw new RuleError('NOT_YOUR_TURN', 'Not your turn.');
  if (p.folded || p.stack === 0) throw new RuleError('ILLEGAL_ACTION', 'Player cannot act.');
  return p;
}

/** Legal options for the current actor. Raise targets include existing round bets. */
export function legalActions(h: Hand, seat: SeatId): Legal {
  const p = actingPlayer(h, seat);
  const owed = h.currentBet - p.roundBet;
  const maxTo = p.roundBet + p.stack;
  const minimum = h.currentBet < h.bigBlind ? h.bigBlind : h.currentBet + h.lastFullRaise;
  const reopen = p.actedAt === null || h.currentBet - p.actedAt >= p.reopenBy;
  const responder = h.players.some(q => q.seat !== seat && !q.folded && q.stack > 0);
  const canRaise = reopen && responder && maxTo > h.currentBet;
  const fullRaise = canRaise && maxTo >= minimum;
  return {
    fold: true,
    check: owed === 0,
    call: owed > 0 ? Math.min(p.stack, owed) : null,
    minRaiseTo: fullRaise ? minimum : null,
    maxRaiseTo: fullRaise ? maxTo : null,
    allIn: maxTo <= h.currentBet || canRaise,
  };
}

/** Applies wagering only; street and actor sequencing belongs to the hand module. */
export function applyBet(h: Hand, seat: SeatId, a: Action): Hand {
  const legal = legalActions(h, seat);
  if (!a || typeof a !== 'object' || !['fold', 'check', 'call', 'allIn', 'raiseTo'].includes(a.type)) {
    throw new RuleError('INVALID_INPUT', 'Invalid action.');
  }
  const p = h.players.find(p => p.seat === seat)!;
  let target = p.roundBet;
  if (a.type === 'raiseTo') {
    if (!Number.isSafeInteger(a.amount) || a.amount < 0) {
      throw new RuleError('INVALID_INPUT', 'Invalid wager amount.');
    }
    target = a.amount;
    const full = legal.minRaiseTo !== null && target >= legal.minRaiseTo && target <= legal.maxRaiseTo!;
    const shortAllIn = legal.allIn && target === p.roundBet + p.stack && target > h.currentBet;
    if (!full && !shortAllIn) throw new RuleError('ILLEGAL_ACTION', 'Raise is not allowed.');
  } else if (a.type === 'call') {
    if (legal.call === null) throw new RuleError('ILLEGAL_ACTION', 'Nothing to call.');
    target += legal.call;
  } else if (a.type === 'check') {
    if (!legal.check) throw new RuleError('ILLEGAL_ACTION', 'Cannot check facing a bet.');
  } else if (a.type === 'allIn') {
    if (!legal.allIn) throw new RuleError('ILLEGAL_ACTION', 'All-in is not allowed.');
    target += p.stack;
  }
  const n = structuredClone(h);
  const next = n.players.find(p => p.seat === seat)!;
  const delta = target - next.roundBet;
  next.stack -= delta;
  next.roundBet = target;
  next.committed += delta;
  next.folded = a.type === 'fold';
  if (target > h.currentBet) {
    // Completing a short opening wager establishes the full opening bet size.
    const raise = h.currentBet < h.bigBlind ? target : target - h.currentBet;
    if (target >= h.bigBlind && raise >= h.lastFullRaise) n.lastFullRaise = raise;
    n.currentBet = target;
  }
  next.actedAt = n.currentBet;
  next.reopenBy = n.lastFullRaise;
  return n;
}

export function roundComplete(h: Hand): boolean {
  const live = h.players.filter(p => !p.folded);
  if (live.length <= 1) return true;
  return live.every(p => p.stack === 0 || (p.actedAt !== null && p.roundBet === h.currentBet));
}
