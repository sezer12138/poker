import {ACTION_TIMEOUT_MS, BOT_JITTER_MS, BOT_THINK_MS, CONTRIBUTE_WINDOW_MS, IDEMPOTENCY_CAP, IDEMPOTENCY_MAX_BYTES, MAX_MEMBERS, ROOM_IDLE_MS, SETTLE_DELAY_MS} from '../config.ts';
import {AppError, toAppError} from '../errors.ts';
import {randomFloat, randomHex, roomCode, uuid} from '../ids.ts';
import type {PersistedRoom, Storage} from '../storage/storage.ts';
import {applyBotAction} from './bots.ts';
import {applyCommand, applyDeal, applyTimer, parseCommand, pauseMatch} from './commands.ts';
import type {CommandContext, TimerSpec} from './commands.ts';
import type {Connection, Hub} from './hub.ts';
import {roomView} from './roomview.ts';
import type {RoomView} from './roomview.ts';
import {TimerSet} from './timers.ts';
import type {TimerApi} from './timers.ts';

export interface CoordinatorOptions {
  storage: Storage;
  hub: Hub;
  timers: TimerApi;
  now?: () => number;
  random?: () => number;
  botThinkMs?: number;
  settleDelayMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export interface CreateRoomInput {
  userId: string;
  name: string;
  roomName: string;
  bots: number;
}

export interface RoomSummary {
  id: string;
  code: string;
  invite: string;
}

const RESTART_NOTICE = '服务器已重启，本手的时间已重新开始计算';

/** Total size of the cached replays, which is what a room snapshot mostly consists of. */
function idempotencyBytes(entries: readonly (readonly [string, {viewJson: string}])[]): number {
  let total = 0;
  for (const [, record] of entries) total += record.viewJson.length;
  return total;
}

/**
 * Owns live room state. Every mutation goes through one serial queue per room:
 * clone → apply → persist → commit → broadcast. Persisting first means a
 * storage failure leaves the in-memory state exactly as it was.
 */
export class Coordinator {
  private rooms = new Map<string, PersistedRoom>();
  private queues = new Map<string, Promise<unknown>>();
  private timers = new Map<string, TimerSet>();
  private storage: Storage;
  private hub: Hub;
  private timerApi: TimerApi;
  private now: () => number;
  private random: () => number;
  private botThinkMs: number;
  private settleDelayMs: number | undefined;
  private log: (message: string, error?: unknown) => void;

  constructor(options: CoordinatorOptions) {
    this.storage = options.storage;
    this.hub = options.hub;
    this.timerApi = options.timers;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomFloat;
    this.botThinkMs = options.botThinkMs ?? BOT_THINK_MS;
    this.settleDelayMs = options.settleDelayMs;
    this.log = options.log ?? ((message, error) => console.error(`[rooms] ${message}`, error ?? ''));
  }

  // -- reads ---------------------------------------------------------------

  get(roomId: string): PersistedRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  byCode(code: string): PersistedRoom | null {
    const normalized = code.trim().toUpperCase();
    for (const room of this.rooms.values()) if (room.code === normalized) return room;
    return null;
  }

  byInvite(invite: string): PersistedRoom | null {
    for (const room of this.rooms.values()) if (room.invite === invite) return room;
    return null;
  }

  memberOf(roomId: string, userId: string): boolean {
    return this.get(roomId)?.members.some(member => member.userId === userId) ?? false;
  }

  connectionsIn(roomId: string): Connection[] {
    return this.hub.connectionsIn(roomId);
  }

  view(roomId: string, userId: string): RoomView | null {
    const room = this.get(roomId);
    if (room === null) return null;
    return roomView(room, userId, {online: this.hub.onlineIn(roomId), now: this.now()});
  }

  // -- creation ------------------------------------------------------------

  async createRoom(input: CreateRoomInput): Promise<PersistedRoom> {
    const now = this.now();
    const room: PersistedRoom = {
      v: 1,
      id: uuid(),
      code: this.freeCode(),
      invite: randomHex(16),
      name: input.roomName,
      version: 1,
      status: 'waiting',
      hostId: input.userId,
      members: [{userId: input.userId, name: input.name, seat: 0, bot: false, ready: false, joinedAt: now}],
      matchId: null,
      tournament: null,
      fairnessStage: null,
      fairnessHistory: [],
      events: [],
      seq: 0,
      idempotency: [],
      deadlines: {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null},
      notice: '',
      lastActivityAt: now,
      createdAt: now,
    };
    for (let index = 0; index < input.bots && room.members.length < MAX_MEMBERS; index++) {
      room.members.push({
        userId: `bot_${uuid()}`,
        name: `机器人${index + 1}`,
        seat: room.members.length,
        bot: true,
        ready: true,
        joinedAt: now,
      });
    }
    await this.storage.saveRoom(room);
    this.rooms.set(room.id, room);
    this.scheduleTimers(room);
    return room;
  }

  private freeCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = roomCode();
      if (this.byCode(code) === null) return code;
    }
    throw new AppError('INTERNAL', '无法分配房间号，请稍后重试');
  }

  /** Joins a waiting room; a running match only lets its own members back in. */
  async join(roomId: string, userId: string, name: string): Promise<PersistedRoom> {
    return this.enqueue(roomId, async () => {
      const room = this.get(roomId);
      if (room === null) throw new AppError('NOT_FOUND');
      const existing = room.members.find(member => member.userId === userId);
      if (existing) return room;
      if (room.status !== 'waiting') throw new AppError('ROOM_LOCKED');
      if (room.members.length >= MAX_MEMBERS) throw new AppError('ROOM_FULL');
      const draft = structuredClone(room);
      draft.version = room.version + 1;
      const taken = new Set(draft.members.map(member => member.seat));
      let seat = 0;
      while (taken.has(seat)) seat += 1;
      draft.members.push({userId, name, seat, bot: false, ready: false, joinedAt: this.now()});
      draft.members.sort((a, b) => a.seat - b.seat);
      await this.persistAndCommit(draft);
      this.afterCommit(draft.id);
      return draft;
    });
  }

  // -- commands ------------------------------------------------------------

  async command(roomId: string, userId: string, body: Record<string, unknown>): Promise<unknown> {
    const requestId = body['requestId'];
    if (typeof requestId !== 'string' || !/^[0-9a-fA-F-]{8,64}$/.test(requestId)) {
      throw new AppError('INVALID_INPUT', 'requestId 非法');
    }
    const command = parseCommand(body);

    const current = this.get(roomId);
    if (current === null) throw new AppError('NOT_FOUND');
    if (!current.members.some(item => item.userId === userId)) {
      throw new AppError('FORBIDDEN', '你不是该房间成员');
    }
    const expected = body['expectedVersion'];
    if (command.type !== 'contribute' && expected !== undefined) {
      if (!Number.isSafeInteger(expected)) throw new AppError('INVALID_INPUT', 'expectedVersion 非法');
    }

    return this.enqueue(roomId, async () => {
      const room = this.get(roomId);
      if (room === null) throw new AppError('NOT_FOUND');
      // A retry of an already-applied command returns the first response verbatim.
      // 回放必须同时匹配发起者：视图是按人裁剪的（含本人底牌），只认 requestId
      // 会让拿到别人 requestId 的人收到别人的牌。没有 userId 的旧记录一律不回放。
      const replay = room.idempotency.find(([id, record]) => id === requestId && record.userId === userId);
      if (replay) return JSON.parse(replay[1].viewJson);
      if (command.type !== 'contribute' && expected !== undefined && expected !== room.version) {
        throw new AppError('VERSION_CONFLICT');
      }

      const draft = structuredClone(room);
      draft.version = room.version + 1;
      const ctx = this.context();
      try {
        applyCommand(draft, userId, command, ctx);
      } catch (error) {
        throw toAppError(error);
      }
      const body_ = JSON.stringify(roomView(draft, userId, this.viewOptions(draft.id, ctx.now)));
      draft.idempotency.push([requestId, {viewJson: body_, version: draft.version, at: ctx.now, userId}]);
      if (draft.idempotency.length > IDEMPOTENCY_CAP) {
        draft.idempotency.splice(0, draft.idempotency.length - IDEMPOTENCY_CAP);
      }
      // Oldest first, so a room that has been played for a long time still keeps the
      // recent replays the clients actually retry, and stays small on disk.
      for (let bytes = idempotencyBytes(draft.idempotency); bytes > IDEMPOTENCY_MAX_BYTES && draft.idempotency.length > 1;) {
        bytes -= draft.idempotency[0]![1].viewJson.length;
        draft.idempotency.shift();
      }
      await this.persistAndCommit(draft);
      this.afterCommit(draft.id);
      return JSON.parse(body_);
    });
  }

  // -- persistence and fan-out --------------------------------------------

  private async persistAndCommit(draft: PersistedRoom): Promise<void> {
    try {
      await this.storage.saveRoom(draft);
    } catch (error) {
      this.log('房间保存失败，状态未提交', error);
      throw error instanceof AppError ? error : new AppError('STORAGE_FAILED');
    }
    this.rooms.set(draft.id, draft);
    this.broadcast(draft.id);
  }

  private viewOptions(roomId: string, now: number): {online: (userId: string) => boolean; now: number} {
    return {online: this.hub.onlineIn(roomId), now};
  }

  private broadcast(roomId: string): void {
    const room = this.get(roomId);
    if (room === null) return;
    const now = this.now();
    const options = this.viewOptions(roomId, now);
    this.hub.broadcast(roomId, conn => ({type: 'state', room: roomView(room, conn.userId, options)}));
  }

  /** Post-commit bookkeeping: dealing, membership enforcement, timers. */
  private afterCommit(roomId: string): void {
    const room = this.get(roomId);
    if (room === null) return;

    if (room.members.every(member => member.bot)) {
      void this.closeRoom(roomId, '房间已无真人玩家，已自动关闭');
      return;
    }

    for (const conn of this.hub.connectionsIn(roomId)) {
      if (room.members.some(member => member.userId === conn.userId)) continue;
      this.hub.evict(roomId, conn.userId);
      conn.send({type: 'error', error: {code: 'FORBIDDEN', message: '你已不在该房间'}});
      conn.close(4003, 'not a member');
    }

    if (room.fairnessStage?.stage === 'dealing') {
      void this.enqueue(roomId, () => this.runDeal(roomId)).catch(error => this.log('发牌失败', error));
    }
    this.scheduleTimers(room);
  }

  /** Commits the deck that was persisted during finalize, then deals it. */
  private async runDeal(roomId: string): Promise<void> {
    const room = this.get(roomId);
    if (room === null || room.fairnessStage?.stage !== 'dealing') return;
    const draft = structuredClone(room);
    draft.version = room.version + 1;
    applyDeal(draft, this.context());
    await this.persistAndCommit(draft);
    this.afterCommit(roomId);
  }

  private scheduleTimers(room: PersistedRoom): void {
    const set = this.timerSet(room.id);
    set.clear();
    const now = this.now();
    const stage = room.fairnessStage;

    if (room.deadlines.contribution !== null && stage !== null && stage.stage === 'collecting') {
      const spec: TimerSpec = {kind: 'contribute', handNo: stage.handNo};
      set.add(room.deadlines.contribution - now, () => this.fire(room.id, spec));
    }

    const actor = room.deadlines.actionSeat;
    const actionHandNo = room.deadlines.actionHandNo;
    if (room.deadlines.action !== null && stage !== null && stage.stage === 'playing' && actor !== null && actionHandNo !== null) {
      const spec: TimerSpec = {kind: 'action', handNo: actionHandNo, seat: actor};
      set.add(room.deadlines.action - now, () => this.fire(room.id, spec));
      if (room.members.find(member => member.seat === actor)?.bot === true) {
        // 固定时长的机器人一眼就能看出是机器；加一点抖动让它像在思考。
        // 振幅跟着 botThinkMs 缩放：开发模式把它压到 10ms 时，抖动也必须跟着变小，
        // 否则冒烟脚本每手会凭空多出几秒真实等待（见 examples/smoke.ts）。
        const jitter = Math.floor(this.random() * Math.min(BOT_JITTER_MS, this.botThinkMs));
        set.add(this.botThinkMs + jitter, () => this.fireBot(room.id, actor, actionHandNo));
      }
    }

    if (room.deadlines.nextHand !== null && room.tournament !== null) {
      const completedHands = room.tournament.completedHands;
      set.add(room.deadlines.nextHand - now, () => this.fire(room.id, {kind: 'nextHand', completedHands}));
    }

    set.add(room.lastActivityAt + ROOM_IDLE_MS - now, () => this.sweepIdle(room.id));
  }

  private timerSet(roomId: string): TimerSet {
    let set = this.timers.get(roomId);
    if (!set) {
      set = new TimerSet(this.timerApi);
      this.timers.set(roomId, set);
    }
    return set;
  }

  private fire(roomId: string, spec: TimerSpec): void {
    void this.enqueue(roomId, async () => {
      const room = this.get(roomId);
      if (room === null) return;
      const draft = structuredClone(room);
      const ctx = this.context();
      let applied: boolean;
      try {
        applied = applyTimer(draft, spec, ctx);
      } catch (error) {
        this.log('定时动作失败，已暂停牌局', error);
        pauseMatch(draft, ctx, error);
        applied = true;
      }
      if (!applied) return; // Stale timer: the deadline moved on while it waited in the queue.
      draft.version = room.version + 1;
      await this.persistAndCommit(draft);
      this.afterCommit(roomId);
    }).catch(error => this.log('定时任务失败', error));
  }

  private fireBot(roomId: string, seat: number, handNo: number): void {
    void this.enqueue(roomId, async () => {
      const room = this.get(roomId);
      if (room === null) return;
      const stage = room.fairnessStage;
      const hand = room.tournament?.hand ?? null;
      if (stage === null || stage.stage !== 'playing' || stage.handNo !== handNo) return;
      if (hand === null || hand.street === 'settled' || hand.actor !== seat) return;
      const draft = structuredClone(room);
      draft.version = room.version + 1;
      applyBotAction(draft, seat, this.context());
      await this.persistAndCommit(draft);
      this.afterCommit(roomId);
    }).catch(error => this.log('机器人行动失败', error));
  }

  private sweepIdle(roomId: string): void {
    const room = this.get(roomId);
    if (room === null) return;
    const now = this.now();
    if (now - room.lastActivityAt < ROOM_IDLE_MS) {
      this.scheduleTimers(room);
      return;
    }
    const humans = room.members.filter(member => !member.bot);
    const online = this.hub.onlineIn(roomId);
    if (humans.length > 0 && humans.every(member => !online(member.userId))) {
      void this.closeRoom(roomId, '房间长时间无人，已自动关闭');
      return;
    }
    // Someone is still around: back off a full idle window before checking again.
    room.lastActivityAt = now;
    this.scheduleTimers(room);
  }

  async closeRoom(roomId: string, reason: string): Promise<void> {
    if (!this.rooms.has(roomId)) return;
    this.rooms.delete(roomId);
    this.timers.get(roomId)?.clear();
    this.timers.delete(roomId);
    for (const conn of this.hub.closeRoom(roomId)) {
      conn.send({type: 'error', error: {code: 'NOT_FOUND', message: reason}});
      conn.close(4000, 'room closed');
    }
    try {
      await this.storage.deleteRoom(roomId);
    } catch (error) {
      this.log(`房间 ${roomId} 清理失败`, error);
    }
  }

  // -- startup -------------------------------------------------------------

  /** Loads persisted rooms and restarts every clock from now: downtime is never charged to players. */
  async restore(): Promise<void> {
    const rooms = await this.storage.loadRooms();
    const now = this.now();
    for (const stored of rooms) {
      const room = structuredClone(stored);
      let changed = false;
      if (room.status === 'playing' && room.fairnessStage !== null) {
        const stage = room.fairnessStage.stage;
        if (stage === 'collecting') {
          room.deadlines.contribution = now + CONTRIBUTE_WINDOW_MS;
          changed = true;
        } else if (stage === 'playing') {
          room.deadlines.action = now + ACTION_TIMEOUT_MS;
          changed = true;
        } else if (stage === 'settled') {
          room.deadlines.nextHand = now + (this.settleDelayMs ?? SETTLE_DELAY_MS);
          changed = true;
        }
        if (changed) {
          room.version = stored.version + 1;
          room.notice = RESTART_NOTICE;
          room.seq += 1;
          room.events.push({seq: room.seq, handNo: room.fairnessStage.handNo, type: 'restart', text: RESTART_NOTICE});
        }
      }
      this.rooms.set(room.id, room);
      if (changed) {
        try {
          await this.storage.saveRoom(room);
        } catch (error) {
          this.log(`房间 ${room.id} 重启状态保存失败`, error);
        }
      }
      this.afterCommit(room.id);
    }
  }

  /** Waits for every queued task so shutdown does not cut a write in half. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
    for (const set of this.timers.values()) set.clear();
    this.timers.clear();
  }

  private context(): CommandContext {
    return {
      now: this.now(),
      online: userId => this.hub.online(userId),
      random: this.random,
      log: this.log,
      settleDelayMs: this.settleDelayMs,
    };
  }

  private enqueue<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      roomId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

export type {PersistedRoom};
