import {verifyRound} from '../../../packages/fairness/src/index.ts';
import type {FairRound} from '../../../packages/fairness/src/index.ts';
import type {Card} from '../../../packages/poker-engine/src/index.ts';
import type {PersistedRoom, PublicEvent, RoomStatus} from './storage/storage.ts';

export interface AuditHand {
  handNo: number;
  commitment: string;
  deckCommitment: string | null;
  contributions: [number, string][];
  serverSeed: string;
  seats: number[];
  button: number | null;
  board: Card[];
  burned: Card[];
  players: {seat: number; name: string; hole: Card[]}[];
  verification: {valid: boolean; errors: string[]};
  /** The cards actually dealt are the head of the committed deck, in deal order. */
  dealMatches: boolean;
  dealErrors: string[];
}

export interface AuditReport {
  matchId: string | null;
  roomName: string;
  status: RoomStatus;
  winner: number | null;
  completedHands: number;
  /**
   * 契约字段：每手的 FairRound 原样给出（浏览器/小程序拿它自己复算牌序）。
   * 形状必须和 packages/fairness 的 FairRound 一致，否则复算必然对不上。
   */
  rounds: FairRound[];
  /** 契约字段：整场汇总。逐手细节仍在 hands[].verification 里。 */
  verification: {valid: boolean; errors: string[]};
  /** 摊牌披露：谁在每手拿到了什么牌、发了什么公共牌。 */
  hands: AuditHand[];
  events: PublicEvent[];
  valid: boolean;
  /** Stated plainly so nobody reads more into the audit than it proves. */
  notes: string[];
}

function seatOrder(seats: readonly number[], button: number): number[] {
  const distance = (seat: number) => (seat - button + 9) % 9 || 9;
  return [...seats].sort((a, b) => distance(a) - distance(b));
}

/**
 * Replays the deal from the committed deck. This is the check that ties the
 * shuffle to the cards the players actually saw, which commitment checks alone
 * cannot do.
 */
function checkDeal(
  deck: readonly Card[],
  seats: readonly number[],
  button: number,
  holes: Record<string, Card[]>,
  board: readonly Card[],
  burned: readonly Card[],
): string[] {
  const errors: string[] = [];
  if (seats.length < 2) errors.push('座位数不足以发牌');
  if (board.length !== 0 && board.length !== 3 && board.length !== 4 && board.length !== 5) {
    errors.push('公共牌数量非法');
  }
  const order = seatOrder(seats, button);
  const expectedHoles = order.map(seat => holes[String(seat)] ?? []);
  if (expectedHoles.some(hole => hole.length !== 2)) errors.push('存在底牌数量不为 2 的座位');
  const burnedNeeded = board.length >= 5 ? 3 : board.length >= 4 ? 2 : board.length >= 3 ? 1 : 0;
  if (burned.length !== burnedNeeded) errors.push('烧牌数量与公共牌不符');
  if (errors.length > 0) return errors;

  // Rebuild the exact sequence the engine draws: two rounds of hole cards, then
  // a burn before each street that was actually dealt.
  const expected: Card[] = [];
  let cursor = 0;
  const take = (count: number): void => {
    for (let index = 0; index < count; index++) {
      const card = deck[cursor++];
      if (card === undefined) throw new RangeError('牌序长度不足');
      expected.push(card);
    }
  };
  for (let round = 0; round < 2; round++) for (const _ of order) take(1);
  let burnIndex = 0;
  if (board.length >= 3) {
    expected.push(burned[burnIndex++]!);
    for (let index = 0; index < 3; index++) expected.push(board[index]!);
  }
  if (board.length >= 4) {
    expected.push(burned[burnIndex++]!);
    expected.push(board[3]!);
  }
  if (board.length >= 5) {
    expected.push(burned[burnIndex++]!);
    expected.push(board[4]!);
  }

  // And the same sequence as it was actually recorded when the hand was dealt.
  const actual: Card[] = [];
  for (let round = 0; round < 2; round++) for (const seat of order) actual.push(holes[String(seat)]![round]!);
  burnIndex = 0;
  if (board.length >= 3) {
    actual.push(burned[burnIndex++]!);
    for (let index = 0; index < 3; index++) actual.push(board[index]!);
  }
  if (board.length >= 4) {
    actual.push(burned[burnIndex++]!);
    actual.push(board[3]!);
  }
  if (board.length >= 5) {
    actual.push(burned[burnIndex++]!);
    actual.push(board[4]!);
  }

  if (actual.length !== expected.length || actual.some((card, index) => card !== expected[index])) {
    errors.push('实际发出的牌与承诺牌序不一致');
  }
  return errors;
}

function memberName(room: PersistedRoom, seat: number): string {
  return room.members.find(member => member.seat === seat)?.name ?? `座位 ${seat}`;
}

/** Full post-match disclosure: seeds, contributions, decks and how they were dealt. */
export function buildAudit(room: PersistedRoom): AuditReport {
  const hands: AuditHand[] = [];
  for (const record of room.fairnessHistory) {
    const verification = verifyRound(record.round);
    const dealt = record.dealt;
    const errors = [...verification.errors];
    let dealErrors: string[] = [];
    if (dealt === null) {
      errors.push('缺少发牌记录');
    } else if (record.button === null) {
      errors.push('缺少庄家位记录');
    } else {
      try {
        dealErrors = checkDeal(record.deck, record.round.seats, record.button, dealt.holes, dealt.board, dealt.burned);
      } catch (error) {
        dealErrors = [`发牌复算失败：${error instanceof Error ? error.message : '未知错误'}`];
      }
      errors.push(...dealErrors);
    }
    hands.push({
      handNo: record.handNo,
      commitment: record.round.commitment,
      deckCommitment: record.round.deckCommitment,
      contributions: Object.entries(record.round.contributions)
        .map(([seat, nonce]): [number, string] => [Number(seat), nonce])
        .sort((a, b) => a[0] - b[0]),
      serverSeed: record.round.serverSeed,
      seats: [...record.round.seats],
      button: record.button,
      board: dealt === null ? [] : [...dealt.board],
      burned: dealt === null ? [] : [...dealt.burned],
      players: record.round.seats.map(seat => ({
        seat,
        name: memberName(room, seat),
        hole: dealt === null ? [] : [...(dealt.holes[String(seat)] ?? [])],
      })),
      verification: {valid: verification.valid, errors},
      dealMatches: dealErrors.length === 0 && dealt !== null,
      dealErrors,
    });
  }

  // 整场汇总：逐手错误都带上手号，客户端一句「哪几手对不上」就能定位。
  // 有效性判据与逐手一致（承诺/重建牌序 + 实际发牌），发牌错误已经在
  // hand.verification.errors 里，所以这里不会漏报。
  const valid = hands.every(hand => hand.verification.valid && hand.dealMatches);
  const errors: string[] = [];
  for (const hand of hands) {
    for (const message of hand.verification.errors) errors.push(`第 ${hand.handNo} 手：${message}`);
  }

  return {
    matchId: room.matchId,
    roomName: room.name,
    status: room.status,
    winner: room.tournament?.winner ?? null,
    completedHands: room.tournament?.completedHands ?? 0,
    rounds: room.fairnessHistory.map(record => record.round),
    verification: {valid, errors},
    hands,
    events: [...room.events],
    valid,
    notes: [
      '核验证明：服务器无法在公布种子承诺后更换随机种子，且实际发出的牌与承诺牌序逐张一致。',
      '核验不能证明：服务器没有在公布承诺之前挑选对自己有利的种子（承诺一经公布即不可更改）。',
      '随机贡献在每位玩家提交时立即固定，服务器种子对所有玩家保密，因此任何人都无法在已知他人贡献后再调整自己的贡献来影响牌序。',
    ],
  };
}
