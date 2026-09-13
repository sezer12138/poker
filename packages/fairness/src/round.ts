import {randomBytes} from 'node:crypto';
import {fullDeck, type Card} from '../../poker-engine/src/index.ts';
import {canonicalJson, isHex64, sha256Hex, VERSION, ZERO_NONCE} from './encoding.ts';
import {shuffle} from './shuffle.ts';
import {createStream} from './stream.ts';

export type FairnessErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_SEAT'
  | 'INVALID_NONCE'
  | 'INVALID_SEATS'
  | 'DUPLICATE_CONTRIBUTION'
  | 'ALREADY_FINALIZED';

export class FairnessError extends Error {
  code: FairnessErrorCode;

  constructor(code: FairnessErrorCode, message: string) {
    super(message);
    this.name = 'FairnessError';
    this.code = code;
  }
}

export interface FairRound {
  version: 'hmac-sha256-fy-v1';
  matchId: string;
  handNo: number;
  serverSeed: string;
  commitment: string;
  contributions: Record<string, string>;
  seats: number[];
  deckCommitment: string | null;
}

function invalid(message: string): never {
  throw new FairnessError('INVALID_INPUT', message);
}

function validSeat(seat: unknown): seat is number {
  return Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) <= 8;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function seedCommitment(matchId: string, handNo: number, serverSeed: string): string {
  return sha256Hex(JSON.stringify([VERSION, matchId, handNo, serverSeed]));
}

/** Stream context binds the algorithm version, match, hand and every seat contribution. */
function streamContext(matchId: string, handNo: number, entries: readonly (readonly [number, string])[]): string {
  return JSON.stringify([VERSION, matchId, handNo, entries]);
}

function orderedContributions(round: FairRound): [number, string][] {
  return [...round.seats]
    .sort((a, b) => a - b)
    .map(seat => [seat, round.contributions[String(seat)] ?? ZERO_NONCE] as [number, string]);
}

export function createRound(matchId: string, handNo: number): FairRound {
  if (typeof matchId !== 'string' || matchId.trim() === '' || matchId.length > 64) {
    invalid('Match id must be a non-empty string of at most 64 characters.');
  }
  if (!Number.isSafeInteger(handNo) || handNo <= 0) invalid('Hand number must be a positive safe integer.');
  const serverSeed = randomBytes(32).toString('hex');
  return {
    version: VERSION,
    matchId,
    handNo,
    serverSeed,
    commitment: seedCommitment(matchId, handNo, serverSeed),
    contributions: {},
    seats: [],
    deckCommitment: null,
  };
}

/** Immutable: returns a new round and never mutates the argument. */
export function contribute(round: FairRound, seat: number, nonce: string): FairRound {
  if (!isObject(round)) invalid('Invalid round.');
  if (round.deckCommitment !== null) {
    throw new FairnessError('ALREADY_FINALIZED', 'This round is already finalized.');
  }
  if (!validSeat(seat)) throw new FairnessError('INVALID_SEAT', 'Seat must be an integer from 0 to 8.');
  if (!isHex64(nonce)) {
    throw new FairnessError('INVALID_NONCE', 'A contribution must be 64 lowercase hex characters.');
  }
  if (typeof round.contributions?.[String(seat)] === 'string') {
    throw new FairnessError('DUPLICATE_CONTRIBUTION', 'This seat already contributed to the round.');
  }
  return {...round, contributions: {...round.contributions, [String(seat)]: nonce}};
}

/**
 * Fills seats that did not contribute with the public all-zero nonce, derives the
 * deck, and records its commitment. Finalization happens exactly once.
 */
export function finalizeRound(round: FairRound, seats: readonly number[]): {round: FairRound; deck: Card[]} {
  if (!isObject(round)) invalid('Invalid round.');
  if (round.deckCommitment !== null) {
    throw new FairnessError('ALREADY_FINALIZED', 'This round is already finalized.');
  }
  if (!Array.isArray(seats) || seats.length === 0 || seats.length > 9) {
    throw new FairnessError('INVALID_SEATS', 'Seats must list every player in the hand.');
  }
  const unique = new Set<number>();
  for (const seat of seats) {
    if (!validSeat(seat) || unique.has(seat)) {
      throw new FairnessError('INVALID_SEATS', 'Seats must be unique integers from 0 to 8.');
    }
    unique.add(seat);
  }
  for (let i = 1; i < seats.length; i++) {
    if (seats[i]! <= seats[i - 1]!) {
      throw new FairnessError('INVALID_SEATS', 'Seats must be sorted ascending.');
    }
  }
  const contributions = round.contributions ?? {};
  for (const key of Object.keys(contributions)) {
    const seat = Number(key);
    if (!validSeat(seat) || !unique.has(seat)) {
      throw new FairnessError('INVALID_SEATS', 'A contribution belongs to a seat outside this hand.');
    }
    if (!isHex64(contributions[key])) {
      throw new FairnessError('INVALID_NONCE', 'A contribution must be 64 lowercase hex characters.');
    }
  }
  const filled: Record<string, string> = {};
  for (const seat of seats) filled[String(seat)] = contributions[String(seat)] ?? ZERO_NONCE;

  const orderedSeats = [...seats];
  const context = streamContext(round.matchId, round.handNo, orderedSeats.map(seat => [seat, filled[String(seat)]!]));
  const deck = shuffle(fullDeck(), createStream(round.serverSeed, context));
  return {
    round: {...round, seats: orderedSeats, contributions: filled, deckCommitment: sha256Hex(canonicalJson(deck))},
    deck,
  };
}

/** Rebuilds the deck exactly as finalizeRound did, using only the public round record. */
export function reconstructDeck(round: FairRound): Card[] {
  if (!isObject(round)) invalid('Invalid round.');
  if (!Array.isArray(round.seats) || round.seats.length === 0) {
    throw new FairnessError('INVALID_SEATS', 'A finalized round must record its seats.');
  }
  const context = streamContext(round.matchId, round.handNo, orderedContributions(round));
  return shuffle(fullDeck(), createStream(round.serverSeed, context));
}

/** Audits a stored round. Never throws; every problem becomes an error string. */
export function verifyRound(round: FairRound): {valid: boolean; errors: string[]} {
  const errors: string[] = [];
  if (!isObject(round)) return {valid: false, errors: ['回合记录格式非法']};
  if (round.version !== VERSION) errors.push('算法版本不受支持');
  if (typeof round.matchId !== 'string' || round.matchId.trim() === '') errors.push('比赛标识缺失');
  if (!Number.isSafeInteger(round.handNo) || round.handNo <= 0) errors.push('手号非法');
  if (!isHex64(round.serverSeed)) errors.push('服务器种子格式非法');
  if (isHex64(round.serverSeed) && typeof round.matchId === 'string') {
    if (seedCommitment(round.matchId, round.handNo, round.serverSeed) !== round.commitment) {
      errors.push('种子承诺不匹配');
    }
  }

  const seats = Array.isArray(round.seats) ? round.seats : null;
  if (seats === null) {
    errors.push('座位列表格式非法');
  } else {
    const unique = new Set<number>();
    let sorted = true;
    for (let i = 0; i < seats.length; i++) {
      if (!validSeat(seats[i])) errors.push('座位必须是 0 到 8 的整数');
      if (unique.has(seats[i]!)) errors.push('座位列表必须唯一');
      unique.add(seats[i]!);
      if (i > 0 && seats[i]! <= seats[i - 1]!) sorted = false;
    }
    if (!sorted) errors.push('座位列表必须升序且唯一');
    const contributions = isObject(round.contributions) ? round.contributions : {};
    for (const key of Object.keys(contributions)) {
      if (!unique.has(Number(key))) errors.push('贡献所属座位不在本手座位列表中');
      if (!isHex64(contributions[key])) errors.push('贡献格式非法');
    }
  }

  if (round.deckCommitment !== null) {
    if (!isHex64(round.deckCommitment)) {
      errors.push('牌序承诺格式非法');
    } else {
      try {
        const deck = reconstructDeck(round);
        if (new Set(deck).size !== 52) errors.push('重建牌序不是 52 张唯一牌');
        if (sha256Hex(canonicalJson(deck)) !== round.deckCommitment) errors.push('牌序承诺与重建牌序不符');
      } catch {
        errors.push('重建牌序失败');
      }
    }
  }

  return {valid: errors.length === 0, errors};
}
