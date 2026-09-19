import {blindLevel, playerView} from '../../../../packages/poker-engine/src/index.ts';
import type {Card, HandView} from '../../../../packages/poker-engine/src/index.ts';
import {ACTION_TIMEOUT_MS, EVENTS_VIEW_CAP, HISTORY_VIEW_CAP} from '../config.ts';
import {revealedCards} from './showdown.ts';
import type {Category, Reveal} from './showdown.ts';
import type {FairnessStage, PersistedRoom, PublicEvent, RoomStatus} from '../storage/storage.ts';
import type {FairnessStageName} from '../storage/storage.ts';

export interface RoomViewMember {
  userId: string;
  name: string;
  seat: number;
  bot: boolean;
  ready: boolean;
  online: boolean;
  isHost: boolean;
  isYou: boolean;
  /** Chip count from the running match; null before the first hand. */
  stack: number | null;
  out: boolean;
}

export interface FairnessView {
  stage: FairnessStageName | null;
  handNo: number | null;
  /** Published before any contribution; binds the server seed to this hand. */
  commitment: string | null;
  /** Published once the shuffle is fixed, before any card is dealt. */
  deckCommitment: string | null;
  /** Seats that already contributed to the current hand. */
  contributors: number[];
  /** Seats that must contribute before the hand can be dealt. */
  expected: number[];
  /** Contributions are published only after the deck is committed. */
  contributions: [number, string][];
  deadline: number | null;
  /** True when the viewer still owes a contribution for the current hand. */
  owed: boolean;
  history: {handNo: number; commitment: string; deckCommitment: string; contributions: [number, string][]}[];
}

/**
 * 对外房间视图。字段名与 docs/product/contract.md 冻结的一致：两个客户端都按契约
 * 读 `viewerId`/`viewerSeat`/`blinds` 元组/`deadline`/`nextHandAt`，
 * 服务端实现曾经用的是另一套写法（`you`、`blinds.small`、`deadlines`），
 * 结果浏览器端连房间都进不去。这里以契约为准，`you` 等字段是契约之外多给的。
 */
export interface RoomView {
  id: string;
  code: string;
  invite: string;
  name: string;
  version: number;
  status: RoomStatus;
  hostId: string;
  viewerId: string;
  /** 观战者（非成员）为 null。 */
  viewerSeat: number | null;
  you: {userId: string; name: string; seat: number | null; isHost: boolean; ready: boolean; bot: boolean};
  members: RoomViewMember[];
  /** [小盲, 大盲]；比赛未开始时给的是首手将要使用的级别。 */
  blinds: [number, number];
  nextBlinds: [number, number];
  /** 距离下一次升盲还有几手；已是最高级别时为 0。 */
  handsToNextLevel: number;
  completedHands: number;
  hand: HandView | null;
  winner: number | null;
  /** 未开赛时为 null；开赛后始终是对象。 */
  fairness: FairnessView | null;
  events: PublicEvent[];
  /** 当前行动的截止时间（毫秒时间戳），没有行动人时为 null。 */
  deadline: number | null;
  /** 下一手的开始时间；不在结算等待中时为 null。 */
  nextHandAt: number | null;
  /** 行动时限本身（毫秒）。客户端画倒计时进度条要用它，不能自己写死一个数。 */
  actionTimeoutMs: number;
  /**
   * 结算确认门。只在「这一手已结算、比赛仍在进行」时非空——比赛结束后弹确认框
   * 是没有意义的（确认命令不会生效）。客户端据此弹结算窗并显示谁已经点了确认。
   * `changes` 是每个座位本手的净输赢（赢 +奖励 与 +退回，输 -投入），结算弹窗按它
   * 逐条列出金额；服务器升级前落盘的老快照算不出这份差额，此时是空数组。
   *
   * `cards`/`category` 是本次新增的亮牌字段，同样是增量：**赢家总是亮，弃牌者不亮**。
   * 摊牌（公共牌五张且不止一人未弃牌）时每位未弃牌者都有最佳五张与类别码；弃牌结束时
   * 只有唯一赢家有，且底牌不足五张时直接给底牌、`category` 为 null。弃牌座位与
   * 弃牌结束时的非赢家没有这两个字段（客户端显示「未摊牌」）。类别码的中文名由客户端
   * 映射；每个座位的剩余筹码读视图里已有的 `hand.players[].stack`。
   */
  settle:
    | {
        handNo: number;
        acks: number[];
        required: number[];
        changes: {seat: number; delta: number; cards?: Card[]; category?: Category | null}[];
      }
    | null;
  notice: string;
  serverTime: number;
}

export interface RoomViewOptions {
  online?: (userId: string) => boolean;
  now?: number;
}

function currentStage(room: PersistedRoom): FairnessStageName | null {
  return room.fairnessStage === null ? null : room.fairnessStage.stage;
}

/**
 * The only place persisted room state becomes client-visible. Everything
 * private (server seeds, undealt decks, other players' hole cards) is dropped
 * here rather than being filtered by any caller.
 */
export function roomView(room: PersistedRoom, viewerId: string, options: RoomViewOptions = {}): RoomView {
  const online = options.online ?? (() => false);
  const viewer = room.members.find(member => member.userId === viewerId) ?? null;
  const viewerSeat = viewer === null ? null : viewer.seat;
  const hand = room.tournament?.hand ?? null;
  const stage = room.fairnessStage;
  const committed = stage !== null && stage.stage !== 'collecting';

  const owed =
    stage !== null &&
    stage.stage === 'collecting' &&
    viewer !== null &&
    !viewer.bot &&
    stage.seats.includes(viewer.seat) &&
    stage.round.contributions[String(viewer.seat)] === undefined;

  const blind = blindInfo(room.tournament?.completedHands ?? 0);

  return {
    id: room.id,
    code: room.code,
    invite: room.invite,
    name: room.name,
    version: room.version,
    status: room.status,
    hostId: room.hostId,
    viewerId,
    viewerSeat,
    you: {
      userId: viewerId,
      name: viewer?.name ?? '',
      seat: viewerSeat,
      isHost: room.hostId === viewerId,
      ready: viewer?.ready ?? false,
      bot: viewer?.bot ?? false,
    },
    members: room.members.map(member => {
      const entry = room.tournament?.entries.find(item => item.seat === member.seat) ?? null;
      return {
        userId: member.userId,
        name: member.name,
        seat: member.seat,
        bot: member.bot,
        ready: member.ready,
        online: member.bot || online(member.userId),
        isHost: member.userId === room.hostId,
        isYou: member.userId === viewerId,
        stack: entry === null ? null : entry.stack,
        out: entry !== null && entry.stack <= 0 && room.status !== 'waiting',
      };
    }),
    blinds: blind.blinds,
    nextBlinds: blind.nextBlinds,
    handsToNextLevel: blind.handsToNextLevel,
    completedHands: room.tournament?.completedHands ?? 0,
    hand: hand === null ? null : playerView(hand, viewerSeat),
    winner: room.tournament?.winner ?? null,
    fairness: room.status === 'waiting' ? null : {
      stage: currentStage(room),
      handNo: stage?.handNo ?? null,
      commitment: stage?.round.commitment ?? null,
      deckCommitment: stage?.round.deckCommitment ?? null,
      contributors: sortedContributions(stage?.round.contributions ?? {}).map(([seat]) => seat),
      expected: stage === null ? [] : stage.seats.filter(seat => !isBotSeat(room, seat)),
      contributions: committed && stage !== null ? sortedContributions(stage.round.contributions) : [],
      deadline: room.deadlines.contribution,
      owed: Boolean(owed),
      history: room.fairnessHistory.slice(-HISTORY_VIEW_CAP).map(record => ({
        handNo: record.handNo,
        commitment: record.round.commitment,
        deckCommitment: record.round.deckCommitment ?? '',
        contributions: sortedContributions(record.round.contributions),
      })),
    },
    events: room.events.slice(-EVENTS_VIEW_CAP),
    deadline: room.deadlines.action,
    nextHandAt: room.deadlines.nextHand,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
    settle:
      room.status === 'playing' && stage !== null && stage.stage === 'settled'
        ? {
            handNo: stage.handNo,
            acks: [...(stage.settleAcks ?? [])].sort((a, b) => a - b),
            required: stage.seats.filter(seat => !isBotSeat(room, seat)),
            changes: seatDeltas(room, stage, revealedCards(room.tournament?.hand ?? null)),
          }
        : null,
    notice: room.notice,
    serverTime: options.now ?? Date.now(),
  };
}

interface BlindsView {
  blinds: [number, number];
  nextBlinds: [number, number];
  handsToNextLevel: number;
}

/**
 * 引擎每 10 手升一级（`blindLevel` 就是按 completedHands 查它的级别表）。
 * 比赛开始前 tournament 还不存在，但首手的级别已经由引擎定死，所以等待阶段
 * 给出首手级别，而不是 null —— 客户端要把它显示成「当前盲注 5/10」。
 * 到顶时返回 handsToNextLevel = 0（客户端据此显示「已是最高级别」）。
 */
function blindInfo(completedHands: number): BlindsView {
  const level = blindLevel(completedHands);
  const blinds: [number, number] = [level[0], level[1]];
  const remaining = 10 - (completedHands % 10);
  const ahead = blindLevel(completedHands + remaining);
  if (ahead[0] === blinds[0] && ahead[1] === blinds[1]) {
    return {blinds, nextBlinds: blinds, handsToNextLevel: 0};
  }
  return {blinds, nextBlinds: [ahead[0], ahead[1]], handsToNextLevel: remaining};
}

function sortedContributions(contributions: Record<string, string>): [number, string][] {
  return Object.entries(contributions)
    .map(([seat, nonce]): [number, string] => [Number(seat), nonce])
    .sort((a, b) => a[0] - b[0]);
}

function isBotSeat(room: PersistedRoom, seat: number): boolean {
  return room.members.some(member => member.seat === seat && member.bot);
}

/**
 * 本手各座位的净输赢 = 结算后筹码 - 发牌前筹码。引擎结算时会把本轮与累计投入清零，
 * 牌局视图里没有「这手投入了多少」的痕迹，所以只能靠发牌前存下的快照做差；引擎的
 * 筹码守恒不变量保证这份差额就等于该座位这手赢的减去输的。
 * 快照缺失（服务器升级前落盘的老快照）时返回空数组，由客户端决定怎么退化显示。
 * `reveals` 是亮牌表（见 showdown.ts）：只有该亮的座位才有牌面字段，没亮的一律不带
 * 这两个键——客户端据「有没有 cards」区分「亮牌」与「未摊牌」，所以这里不能填 null 占位。
 */
function seatDeltas(
  room: PersistedRoom,
  stage: FairnessStage,
  reveals: ReadonlyMap<number, Reveal>,
): {seat: number; delta: number; cards?: Card[]; category?: Category | null}[] {
  const start = stage.startStacks ?? {};
  const stacks = new Map((room.tournament?.entries ?? []).map(entry => [entry.seat, entry.stack]));
  const deltas: {seat: number; delta: number; cards?: Card[]; category?: Category | null}[] = [];
  for (const seat of Object.keys(start).map(Number).sort((a, b) => a - b)) {
    const stack = stacks.get(seat);
    if (stack === undefined) continue; // 快照里有、牌局里已经没有的座位：不显示，也不猜。
    const delta = stack - start[String(seat)]!;
    const reveal = reveals.get(seat);
    deltas.push(reveal === undefined ? {seat, delta} : {seat, delta, cards: reveal.cards, category: reveal.category});
  }
  return deltas;
}
