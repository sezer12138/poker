import {compare} from './evaluate.ts';
import {RuleError, type Award, type Player, type Pot, type SeatId} from './types.ts';

const SEAT_COUNT = 9;

function invalid(message: string): never {
  throw new RuleError('INVALID_INPUT', message);
}

function validSeat(seat: unknown): seat is SeatId {
  return Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) < SEAT_COUNT;
}

function addAmount(current: number, amount: number): number {
  const total = current + amount;
  if (!Number.isSafeInteger(total)) invalid('Chip total exceeds the safe integer range.');
  return total;
}

export function buildPots(players: readonly Player[]): {pots: Pot[]; refunds: Award[]} {
  if (!Array.isArray(players)) invalid('Players must be an array.');

  const seats = new Set<SeatId>();
  for (const player of players) {
    if (player === null || typeof player !== 'object') invalid('Invalid player.');
    if (!validSeat(player.seat) || seats.has(player.seat)) invalid('Player seats must be unique seats from 0 to 8.');
    if (!Number.isSafeInteger(player.committed) || player.committed < 0) invalid('Committed chips must be a non-negative safe integer.');
    if (typeof player.folded !== 'boolean') invalid('Folded status must be boolean.');
    seats.add(player.seat);
  }

  const levels = [...new Set(players.map(({committed}) => committed).filter((amount) => amount > 0))]
    .sort((a, b) => a - b);
  const pots: Pot[] = [];
  const refunds: Award[] = [];
  let previousLevel = 0;
  let accounted = 0;

  for (const level of levels) {
    const contributors = players.filter(({committed}) => committed >= level);
    const layer = (level - previousLevel) * contributors.length;
    if (!Number.isSafeInteger(layer) || layer <= 0) invalid('Pot amount exceeds the safe integer range.');
    accounted = addAmount(accounted, layer);

    if (contributors.length === 1) {
      refunds.push({seat: contributors[0]!.seat, amount: layer});
    } else {
      const eligible = contributors
        .filter(({folded}) => !folded)
        .map(({seat}) => seat)
        .sort((a, b) => a - b);
      if (eligible.length === 0) invalid('A pot must have at least one eligible player.');
      pots.push({amount: layer, eligible});
    }
    previousLevel = level;
  }

  return {pots, refunds};
}

function validatePot(pot: Pot): void {
  if (pot === null || typeof pot !== 'object') invalid('Invalid pot.');
  if (!Number.isSafeInteger(pot.amount) || pot.amount <= 0) invalid('Pot amount must be a positive safe integer.');
  if (!Array.isArray(pot.eligible) || pot.eligible.length === 0) invalid('A pot must have eligible players.');
  if (pot.eligible.some((seat) => !validSeat(seat))) invalid('Eligible seats must be integers from 0 to 8.');
  if (new Set(pot.eligible).size !== pot.eligible.length) invalid('Eligible seats must be unique.');
}

function validateRank(rank: readonly number[] | undefined): asserts rank is readonly number[] {
  if (!Array.isArray(rank) || rank.length === 0) invalid('Every eligible player must have a rank.');
  if (rank.some((value) => !Number.isSafeInteger(value))) invalid('Ranks must contain safe integers.');
}

function clockwiseDistance(button: SeatId, seat: SeatId): number {
  const distance = (seat - button + SEAT_COUNT) % SEAT_COUNT;
  return distance === 0 ? SEAT_COUNT : distance;
}

export function distribute(
  pots: readonly Pot[],
  ranks: ReadonlyMap<SeatId, number[]>,
  button: SeatId,
): Award[] {
  if (!Array.isArray(pots)) invalid('Pots must be an array.');
  if (ranks === null || typeof ranks !== 'object' || typeof ranks.get !== 'function') {
    invalid('Ranks must be a map.');
  }
  if (!validSeat(button)) invalid('Button must be a seat from 0 to 8.');

  const totals = new Map<SeatId, number>();
  for (const pot of pots) {
    validatePot(pot);
    let bestRank: readonly number[] | null = null;
    let winners: SeatId[] = [];

    for (const seat of pot.eligible) {
      const rank = ranks.get(seat);
      validateRank(rank);
      const result = bestRank === null ? 1 : compare(rank, bestRank);
      if (result > 0) {
        bestRank = rank;
        winners = [seat];
      } else if (result === 0) {
        winners.push(seat);
      }
    }

    if (winners.length === 0) invalid('A pot must have a legal winner.');
    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount % winners.length;
    const oddChipOrder = [...winners].sort(
      (a, b) => clockwiseDistance(button, a) - clockwiseDistance(button, b),
    );

    for (const seat of winners) {
      totals.set(seat, addAmount(totals.get(seat) ?? 0, share));
    }
    for (let i = 0; i < remainder; i++) {
      const seat = oddChipOrder[i]!;
      totals.set(seat, addAmount(totals.get(seat) ?? 0, 1));
    }
  }

  return [...totals.entries()]
    .map(([seat, amount]) => ({seat, amount}))
    .sort((a, b) => a.seat - b.seat);
}
