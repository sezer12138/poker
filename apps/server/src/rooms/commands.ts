import {
  actTournament,
  blindLevel,
  createTournament,
  nextHand,
  timeoutAction,
} from '../../../../packages/poker-engine/src/index.ts';
import type {Action, Card, Hand, SeatId} from '../../../../packages/poker-engine/src/index.ts';
import {contribute, createRound, finalizeRound} from '../../../../packages/fairness/src/index.ts';
import {ACTION_TIMEOUT_MS, CONTRIBUTE_WINDOW_MS, MAX_MEMBERS, SETTLE_DELAY_MS} from '../config.ts';
import {AppError} from '../errors.ts';
import {cardsText} from '../format.ts';
import {uuid} from '../ids.ts';
import type {DealtCards, EventAction, Member, PersistedRoom} from '../storage/storage.ts';

export interface CommandContext {
  now: number;
  /** Who is currently connected; used when the host hands the room over. */
  online?: (userId: string) => boolean;
  /** Injected randomness for bot decisions so tests stay deterministic. */
  random?: () => number;
  log?: (message: string, error?: unknown) => void;
  /** 结算展示时长；只由开发模式覆盖（冒烟脚本要压缩一整场），默认 10 分钟。 */
  settleDelayMs?: number;
}

export type ParsedCommand =
  | {type: 'ready'; ready: boolean}
  | {type: 'start'}
  | {type: 'addBot'}
  | {type: 'removeBot'; seat: number}
  | {type: 'action'; action: Action}
  | {type: 'contribute'; nonce: string; handNo: number}
  | {type: 'settleAck'; handNo: number}
  | {type: 'restart'}
  | {type: 'leave'};

/** 集齐即推进的命令：与 contribute 一样豁免 expectedVersion（见 coordinator.command）。 */
export function skipsVersionCheck(command: ParsedCommand): boolean {
  return command.type === 'contribute' || command.type === 'settleAck';
}

export type TimerSpec =
  | {kind: 'contribute'; handNo: number}
  | {kind: 'action'; handNo: number; seat: SeatId}
  | {kind: 'nextHand'; completedHands: number};

const NONCE_PATTERN = /^[0-9a-f]{64}$/;

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', `${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

/** Turns a wire command into a typed one; every field is checked before use. */
export function parseCommand(raw: Record<string, unknown>): ParsedCommand {
  const type = raw['type'];
  switch (type) {
    case 'ready':
      return {type: 'ready', ready: raw['ready'] === true};
    case 'start':
      return {type: 'start'};
    case 'addBot':
      return {type: 'addBot'};
    case 'removeBot': {
      const seat = raw['seat'];
      if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) > 8) {
        throw new AppError('INVALID_INPUT', '座位号非法');
      }
      return {type: 'removeBot', seat: seat as number};
    }
    case 'action':
      return {type: 'action', action: parseAction(raw['action'])};
    case 'contribute': {
      const nonce = raw['nonce'];
      if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
        throw new AppError('INVALID_INPUT', '随机贡献必须是 64 位十六进制字符串');
      }
      const handNo = raw['handNo'];
      if (!Number.isSafeInteger(handNo) || (handNo as number) <= 0) {
        throw new AppError('INVALID_INPUT', '手号非法');
      }
      return {type: 'contribute', nonce, handNo: handNo as number};
    }
    case 'settleAck': {
      const handNo = raw['handNo'];
      if (!Number.isSafeInteger(handNo) || (handNo as number) <= 0) {
        throw new AppError('INVALID_INPUT', '手号非法');
      }
      return {type: 'settleAck', handNo: handNo as number};
    }
    case 'restart':
      return {type: 'restart'};
    case 'leave':
      return {type: 'leave'};
    default:
      throw new AppError('INVALID_INPUT', '未知的命令类型');
  }
}

function parseAction(value: unknown): Action {
  const raw = requireObject(value, 'action');
  switch (raw['type']) {
    case 'fold':
    case 'check':
    case 'call':
    case 'allIn':
      return {type: raw['type']};
    case 'raiseTo': {
      const amount = raw['amount'];
      if (!Number.isSafeInteger(amount) || (amount as number) <= 0) {
        throw new AppError('INVALID_INPUT', '加注金额非法');
      }
      return {type: 'raiseTo', amount: amount as number};
    }
    default:
      throw new AppError('INVALID_INPUT', '未知的行动类型');
  }
}

function requireMember(room: PersistedRoom, userId: string): Member {
  const member = room.members.find(item => item.userId === userId);
  if (!member) throw new AppError('FORBIDDEN', '你不是该房间成员');
  return member;
}

function requireHost(room: PersistedRoom, userId: string): Member {
  const member = requireMember(room, userId);
  if (room.hostId !== userId) throw new AppError('FORBIDDEN', '只有房主可以执行该操作');
  return member;
}

function requireWaiting(room: PersistedRoom): void {
  if (room.status !== 'waiting') throw new AppError('ROOM_LOCKED', '比赛已经开始');
}

function requirePlaying(room: PersistedRoom): void {
  if (room.status === 'waiting') throw new AppError('HAND_FINISHED', '比赛尚未开始');
  if (room.status === 'finished') throw new AppError('MATCH_FINISHED');
}

function activeHand(room: PersistedRoom): Hand {
  const hand = room.tournament?.hand ?? null;
  if (hand === null || hand.street === 'settled') throw new AppError('HAND_FINISHED');
  return hand;
}

function memberName(room: PersistedRoom, seat: SeatId): string {
  return room.members.find(member => member.seat === seat)?.name ?? `座位 ${seat}`;
}

/**
 * 事件流是客户端播报横幅的数据源。除固定的 seq/handNo/type/text 外，动作事件还带
 * 「做了什么、多少钱」的结构化字段，客户端据此决定语气——从 text 里正则抠动作太脆。
 */
function pushEvent(
  room: PersistedRoom,
  type: string,
  text: string,
  detail: {action?: EventAction; amount?: number} = {},
): void {
  room.seq += 1;
  room.events.push({seq: room.seq, handNo: room.fairnessStage?.handNo ?? 0, type, text, ...detail});
}

/** Cap the log so a long match cannot grow the snapshot without bound. */
const EVENT_CAP = 500;
function trimEvents(room: PersistedRoom): void {
  if (room.events.length > EVENT_CAP) room.events = room.events.slice(-EVENT_CAP);
}

function lowestFreeSeat(room: PersistedRoom): number {
  const taken = new Set(room.members.map(member => member.seat));
  for (let seat = 0; seat <= 8; seat++) if (!taken.has(seat)) return seat;
  throw new AppError('ROOM_FULL');
}

function liveSeats(room: PersistedRoom): number[] {
  const seats =
    room.tournament === null
      ? room.members.map(member => member.seat)
      : room.tournament.entries.filter(entry => entry.stack > 0).map(entry => entry.seat);
  return [...seats].sort((a, b) => a - b);
}

function humanSeatsInHand(room: PersistedRoom, seats: readonly number[]): number[] {
  return seats.filter(seat => room.members.some(member => member.seat === seat && !member.bot));
}

function dealtFrom(hand: Hand): DealtCards {
  const holes: Record<string, Card[]> = {};
  for (const player of hand.players) holes[String(player.seat)] = [...player.hole];
  return {holes, board: [...hand.board], burned: [...hand.burned]};
}

/** Exactly uniform over the seats, and derived from the committed deck so it is verifiable. */
function buttonFromDeck(deck: readonly Card[], seats: readonly number[]): SeatId {
  const count = seats.length;
  const limit = Math.floor(2704 / count) * count;
  for (let i = 0; i + 1 < deck.length; i += 2) {
    const value = deck[i]! * 52 + deck[i + 1]!;
    if (value < limit) return seats[value % count]!;
  }
  return seats[0]!;
}

function actionText(action: Action, paid: number, roundBet: number): string {
  switch (action.type) {
    case 'fold':
      return '弃牌';
    case 'check':
      return '过牌';
    case 'call':
      return `跟注 ${paid}`;
    case 'allIn':
      return `全押 ${roundBet}`;
    case 'raiseTo':
      return `加注到 ${roundBet}`;
  }
}

function streetText(hand: Hand): string {
  if (hand.street === 'flop') return `公共牌 翻牌 ${cardsText(hand.board.slice(0, 3))}`;
  if (hand.street === 'turn') return `转牌 ${cardsText(hand.board.slice(3, 4))}`;
  if (hand.street === 'river') return `河牌 ${cardsText(hand.board.slice(4, 5))}`;
  return '';
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

/** Opens a hand: publishes the seed commitment and starts the contribution window. */
export function beginHandFlow(room: PersistedRoom, ctx: CommandContext): void {
  const seats = liveSeats(room);
  const handNo = (room.tournament?.completedHands ?? 0) + 1;
  if (room.matchId === null) throw new AppError('INTERNAL', '比赛标识缺失');
  room.fairnessStage = {
    stage: 'collecting',
    handNo,
    seats,
    round: createRound(room.matchId, handNo),
    deck: null,
    dealt: null,
    button: null,
    // 新的 stage 对象，上一手的确认自然作废（确认门只认当前这一手）。
    settleAcks: [],
    // 这里还不知道首手筹码（首手时 tournament 还没建），发牌前由 applyDeal 填。
    startStacks: {},
  };
  room.deadlines.action = null;
  room.deadlines.actionSeat = null;
  room.deadlines.actionHandNo = null;
  room.deadlines.nextHand = null;
  room.notice = '';
  const [small, big] = blindLevel(room.tournament?.completedHands ?? 0);
  pushEvent(room, 'handStart', `第 ${handNo} 手开始，盲注 ${small}/${big}`);
  trimEvents(room);
  room.lastActivityAt = ctx.now;

  if (humanSeatsInHand(room, seats).length === 0) {
    // Nothing to wait for: bots contribute the public default nonce.
    finalizeStage(room, ctx);
    return;
  }
  room.deadlines.contribution = ctx.now + CONTRIBUTE_WINDOW_MS;
}

/** Fixes the shuffle. The deck is committed here and must be persisted before dealing. */
export function finalizeStage(room: PersistedRoom, ctx: CommandContext): void {
  const stage = room.fairnessStage;
  if (stage === null || stage.stage !== 'collecting') return;
  const {round, deck} = finalizeRound(stage.round, [...stage.seats].sort((a, b) => a - b));
  stage.round = round;
  stage.deck = deck;
  stage.stage = 'dealing';
  room.deadlines.contribution = null;
  room.lastActivityAt = ctx.now;
}

/** Deals the committed deck. Never reshuffles: a retry replays the stored deck. */
export function applyDeal(room: PersistedRoom, ctx: CommandContext): void {
  const stage = room.fairnessStage;
  if (stage === null || stage.stage !== 'dealing' || stage.deck === null) return;
  if (room.tournament !== null && room.tournament.winner !== null) return;
  const deck = stage.deck;
  const tournament =
    room.tournament === null
      ? createTournament(stage.seats, buttonFromDeck(deck, stage.seats))
      : room.tournament;
  // 记下各座位带进本手的筹码：引擎结算会把 committed 清零，之后只有这份快照能算出
  // 「这手谁赢了多少、谁输了多少」（见 storage.ts 的 startStacks）。
  stage.startStacks = Object.fromEntries(tournament.entries.map(entry => [String(entry.seat), entry.stack]));
  const next = nextHand(tournament, deck);
  const hand = next.hand!;
  if (hand.id !== stage.handNo) throw new AppError('INTERNAL', '牌局手号与公平流程不一致');
  room.tournament = next;
  stage.dealt = dealtFrom(hand);
  stage.button = hand.button;
  room.lastActivityAt = ctx.now;
  if (hand.street === 'settled' || hand.actor === null) {
    // A short stack was covered by the blinds, so there is nothing to bet: the hand is
    // decided the moment it is dealt. Scheduling an action here would freeze the match.
    settleFlow(room, ctx);
    return;
  }
  stage.stage = 'playing';
  room.deadlines.action = ctx.now + ACTION_TIMEOUT_MS;
  room.deadlines.actionSeat = hand.actor;
  room.deadlines.actionHandNo = stage.handNo;
}

function settleFlow(room: PersistedRoom, ctx: CommandContext): void {
  const tournament = room.tournament;
  const hand = tournament?.hand ?? null;
  if (tournament === null || hand === null || hand.result === null) return;
  const stage = room.fairnessStage;
  if (stage !== null) {
    stage.dealt = dealtFrom(hand);
    stage.stage = 'settled';
    if (stage.deck !== null) {
      room.fairnessHistory.push({
        handNo: stage.handNo,
        round: stage.round,
        deck: stage.deck,
        dealt: stage.dealt,
        button: stage.button,
      });
    }
  }
  const awards = hand.result.awards
    .map(award => `${memberName(room, award.seat)} 赢得 ${award.amount} 筹码`)
    .join('，');
  pushEvent(room, 'settle', `第 ${hand.id} 手结束${awards === '' ? '' : `，${awards}`}`);
  room.deadlines.action = null;
  room.deadlines.actionSeat = null;
  room.deadlines.actionHandNo = null;
  room.deadlines.contribution = null;
  if (tournament.winner !== null) {
    room.status = 'finished';
    room.deadlines.nextHand = null;
    pushEvent(room, 'finish', `比赛结束，${memberName(room, tournament.winner)} 获胜`);
  } else {
    // 兜底窗口：真人全部点确认会提前开下一手（见 settleAck），这个时刻是没人点时的上限。
    room.deadlines.nextHand = ctx.now + (ctx.settleDelayMs ?? SETTLE_DELAY_MS);
  }
  trimEvents(room);
  room.lastActivityAt = ctx.now;
}

/** Applies one seat's action and advances the hand, logging it for the table feed. */
export function applySeatAction(
  room: PersistedRoom,
  seat: SeatId,
  action: Action,
  ctx: CommandContext,
  source: 'human' | 'bot' | 'timeout',
): void {
  const tournament = room.tournament;
  if (tournament === null) throw new AppError('HAND_FINISHED');
  const before = tournament.hand;
  if (before === null || before.street === 'settled') throw new AppError('HAND_FINISHED');
  const transition = actTournament(tournament, seat, action);
  const after = transition.state.hand!;
  room.tournament = transition.state;

  for (const event of transition.events) {
    if (event.type === 'action') {
      const player = after.players.find(item => item.seat === event.seat)!;
      const previous = before.players.find(item => item.seat === event.seat)?.roundBet ?? 0;
      const paid = player.roundBet - previous;
      const text =
        source === 'timeout'
          ? `${memberName(room, event.seat)} 超时，自动${event.action.type === 'fold' ? '弃牌' : '过牌'}`
          : `${memberName(room, event.seat)} ${actionText(event.action, paid, player.roundBet)}`;
      // 金额口径见 PublicEvent.amount：加注与全押报本轮累计投入，跟注报本次实际投入。
      const amount =
        event.action.type === 'raiseTo'
          ? event.action.amount
          : event.action.type === 'allIn'
            ? player.roundBet
            : event.action.type === 'call'
              ? paid
              : undefined;
      pushEvent(room, 'action', text, {action: event.action.type, amount});
    } else if (event.type === 'street') {
      pushEvent(room, 'street', streetText(after));
    }
  }
  trimEvents(room);

  if (after.street === 'settled') {
    settleFlow(room, ctx);
    return;
  }
  // Without an actor there is nobody to time out and nothing to wait for, so a deadline
  // here would strand the table. The engine never produces this; fail loudly instead.
  if (after.actor === null) throw new AppError('INTERNAL', '牌局缺少行动人');
  room.deadlines.action = ctx.now + ACTION_TIMEOUT_MS;
  room.deadlines.actionSeat = after.actor;
  room.deadlines.actionHandNo = room.fairnessStage?.handNo ?? null;
  room.lastActivityAt = ctx.now;
}

/** Halts an unrecoverable hand instead of inventing a shuffle or an action. */
export function pauseMatch(room: PersistedRoom, ctx: CommandContext, error: unknown): void {
  room.deadlines.action = null;
  room.deadlines.actionSeat = null;
  room.deadlines.actionHandNo = null;
  room.deadlines.contribution = null;
  room.deadlines.nextHand = null;
  room.notice = '牌局出现异常，已暂停，请刷新后重试';
  ctx.log?.('牌局异常，已暂停', error);
  pushEvent(room, 'pause', room.notice);
  trimEvents(room);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Applies a command in place. Returns false when the command was legal but had
 * nothing to do（目前只有迟到的结算确认）——调用方据此跳过落盘与版本号自增，
 * 否则一条无害的重复确认也会让别的客户端白白吃一次 VERSION_CONFLICT。
 * 与 applyTimer 的「陈旧定时器返回 false」是同一条约定。
 */
export function applyCommand(
  room: PersistedRoom,
  actorId: string,
  command: ParsedCommand,
  ctx: CommandContext,
): boolean {
  switch (command.type) {
    case 'ready': {
      requireWaiting(room);
      const member = requireMember(room, actorId);
      if (member.bot) throw new AppError('FORBIDDEN', '机器人无需准备');
      member.ready = command.ready;
      break;
    }
    case 'start': {
      requireHost(room, actorId);
      requireWaiting(room);
      if (room.members.length < 2) throw new AppError('START_MIN_PLAYERS');
      if (!room.members.filter(member => !member.bot).every(member => member.ready)) {
        throw new AppError('NOT_READY');
      }
      room.status = 'playing';
      room.matchId = uuid();
      room.tournament = null;
      room.fairnessStage = null;
      room.fairnessHistory = [];
      room.events = [];
      room.deadlines = {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null};
      beginHandFlow(room, ctx);
      break;
    }
    case 'addBot': {
      requireHost(room, actorId);
      requireWaiting(room);
      if (room.members.length >= MAX_MEMBERS) throw new AppError('ROOM_FULL');
      const seat = lowestFreeSeat(room);
      const ordinal = room.members.filter(member => member.bot).length + 1;
      room.members.push({
        userId: `bot_${uuid()}`,
        name: `机器人${ordinal}`,
        seat,
        bot: true,
        ready: true,
        joinedAt: ctx.now,
      });
      room.members.sort((a, b) => a.seat - b.seat);
      break;
    }
    case 'removeBot': {
      requireHost(room, actorId);
      requireWaiting(room);
      const member = room.members.find(item => item.seat === command.seat);
      if (!member) throw new AppError('NOT_FOUND', '该座位没有玩家');
      if (member.userId === room.hostId) throw new AppError('FORBIDDEN', '不能移除自己');
      if (!member.bot && member.ready) throw new AppError('ROOM_LOCKED', '该玩家已准备，无法移除');
      room.members = room.members.filter(item => item.seat !== command.seat);
      break;
    }
    case 'action': {
      requirePlaying(room);
      const member = requireMember(room, actorId);
      const hand = activeHand(room);
      if (hand.actor !== member.seat) throw new AppError('NOT_YOUR_TURN');
      applySeatAction(room, member.seat, command.action, ctx, 'human');
      break;
    }
    case 'contribute': {
      requirePlaying(room);
      const member = requireMember(room, actorId);
      if (member.bot) throw new AppError('FORBIDDEN', '机器人无需提交随机贡献');
      const stage = room.fairnessStage;
      if (stage === null || stage.stage !== 'collecting' || stage.handNo !== command.handNo) {
        throw new AppError('CONTRIBUTE_CLOSED');
      }
      if (!stage.seats.includes(member.seat)) throw new AppError('FORBIDDEN', '本手你不在牌局中');
      if (stage.round.contributions[String(member.seat)] !== undefined) {
        throw new AppError('ALREADY_CONTRIBUTED');
      }
      stage.round = contribute(stage.round, member.seat, command.nonce);
      room.lastActivityAt = ctx.now;
      if (humanSeatsInHand(room, stage.seats).every(seat => stage.round.contributions[String(seat)] !== undefined)) {
        finalizeStage(room, ctx);
      }
      break;
    }
    case 'settleAck': {
      // 结算确认：只认「这一手已结算、比赛仍在进行」。其余情况（确认来晚了落到下一手、
      // 比赛已结束、机器人或已淘汰的座位）一律无副作用返回——双击、断线重发、
      // 旧标签页的迟到确认都不该给玩家弹一个错误横幅，也不该让房间白写一次盘。
      const member = requireMember(room, actorId);
      const stage = room.fairnessStage;
      if (room.status !== 'playing' || stage === null || stage.stage !== 'settled') return false;
      if (stage.handNo !== command.handNo) return false;
      if (member.bot || !stage.seats.includes(member.seat)) return false;
      if (stage.settleAcks.includes(member.seat)) return false; // 重复确认：幂等的空操作
      stage.settleAcks.push(member.seat);
      room.lastActivityAt = ctx.now;
      // 真人都确认了就立刻开下一手；否则等 deadlines.nextHand 的兜底定时器。
      if (humanSeatsInHand(room, stage.seats).every(seat => stage.settleAcks.includes(seat))) {
        beginHandFlow(room, ctx);
      }
      break;
    }
    case 'restart': {
      requireHost(room, actorId);
      if (room.status !== 'finished') throw new AppError('ROOM_LOCKED', '比赛尚未结束');
      room.status = 'waiting';
      room.matchId = null;
      room.tournament = null;
      room.fairnessStage = null;
      room.fairnessHistory = [];
      room.events = [];
      room.notice = '';
      room.deadlines = {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null};
      for (const item of room.members) item.ready = item.bot;
      break;
    }
    case 'leave': {
      if (room.status !== 'waiting') throw new AppError('ROOM_LOCKED');
      const member = requireMember(room, actorId);
      room.members = room.members.filter(item => item.userId !== member.userId);
      if (room.hostId === member.userId) {
        const humans = room.members.filter(item => !item.bot).sort((a, b) => a.joinedAt - b.joinedAt);
        const next = humans.find(item => ctx.online?.(item.userId) === true) ?? humans[0] ?? null;
        room.hostId = next?.userId ?? '';
      }
      break;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/** Runs one scheduled deadline; returns false when the timer is stale. */
export function applyTimer(room: PersistedRoom, spec: TimerSpec, ctx: CommandContext): boolean {
  if (spec.kind === 'contribute') {
    const stage = room.fairnessStage;
    if (stage === null || stage.stage !== 'collecting' || stage.handNo !== spec.handNo) return false;
    finalizeStage(room, ctx);
    return true;
  }
  if (spec.kind === 'action') {
    const stage = room.fairnessStage;
    const hand = room.tournament?.hand ?? null;
    if (stage === null || stage.stage !== 'playing' || stage.handNo !== spec.handNo) return false;
    if (hand === null || hand.street === 'settled' || hand.actor !== spec.seat) return false;
    applySeatAction(room, spec.seat, timeoutAction(hand), ctx, 'timeout');
    return true;
  }
  if (room.status !== 'playing') return false;
  if (room.tournament === null || room.tournament.winner !== null) return false;
  if (room.tournament.completedHands !== spec.completedHands) return false;
  beginHandFlow(room, ctx);
  return true;
}
