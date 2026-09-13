import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.ts';
import type {App} from '../src/app.ts';
import {loadConfig} from '../src/config.ts';
import type {ServerConfig} from '../src/config.ts';
import {createFileStorage, loadOrCreateKey} from '../src/storage/file.ts';
import type {Session as StoredSession, Storage} from '../src/storage/storage.ts';
import type {Coordinator} from '../src/rooms/coordinator.ts';
import type {TimerApi, TimerHandle} from '../src/rooms/timers.ts';

/** Deterministic clock: tests advance time explicitly and never sleep. */
export class TestClock {
  private current: number;
  private entries: {at: number; seq: number; callback: () => void; cancelled: boolean}[] = [];
  private counter = 0;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  timers(): TimerApi {
    return {
      set: (delayMs, callback) => {
        const entry = {
          at: this.current + Math.max(0, delayMs),
          seq: this.counter++,
          callback,
          cancelled: false,
        };
        this.entries.push(entry);
        const handle: TimerHandle = {
          cancel: () => {
            entry.cancelled = true;
          },
        };
        return handle;
      },
    };
  }

  /** Fires every timer that comes due, in schedule order, yielding between them. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.entries
        .filter(entry => !entry.cancelled && entry.at <= target)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      due.cancelled = true;
      this.current = Math.max(this.current, due.at);
      due.callback();
      await drain();
    }
    this.current = target;
    await drain();
  }

  pendingCount(): number {
    return this.entries.filter(entry => !entry.cancelled).length;
  }
}

/** Lets queued promise chains finish; the server does its work off the timer tick. */
export async function drain(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

/**
 * Waits for a condition the server reaches through real work. Multi-step flows (finalize,
 * deal, restart) await actual storage writes, so counting event-loop turns is not enough:
 * poll instead, the way a client would.
 */
export async function waitFor(
  done: () => boolean,
  label = '条件',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await drain(1);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
}

/**
 * Awaits a promise that the server has to settle by acting. A bug that forgets to
 * answer would otherwise hang the test process instead of failing, so give up loudly.
 */
export async function withTimeout<T>(promise: Promise<T>, label = '操作', timeoutMs = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`等待「${label}」超时`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

/**
 * In-process storage for tests that exercise game logic rather than durability.
 * Every write is copied in and out, so a test can never mutate committed state by
 * holding on to an object — the same guarantee the file and Postgres stores give.
 */
export function createMemoryStorage(): Storage & {rooms: Map<string, unknown>; sessions: Record<string, StoredSession>} {
  const rooms = new Map<string, unknown>();
  let sessions: Record<string, StoredSession> = {};
  return {
    rooms,
    get sessions() {
      return sessions;
    },
    init: async () => {},
    loadRoom: async id => (rooms.has(id) ? (structuredClone(rooms.get(id)) as any) : null),
    saveRoom: async room => {
      rooms.set(room.id, structuredClone(room));
    },
    deleteRoom: async id => {
      rooms.delete(id);
    },
    loadRooms: async () => [...rooms.values()].map(room => structuredClone(room) as any),
    loadSessions: async () => structuredClone(sessions),
    saveSessions: async next => {
      sessions = structuredClone(next);
    },
    close: async () => {},
  };
}

export interface Session {
  token: string;
  user: {id: string; name: string};
}

export interface TestServer {
  url: string;
  wsUrl: string;
  port: number;
  clock: TestClock;
  app: App;
  coordinator: Coordinator;
  storage: Storage;
  dataDir: string;
  /** True when closing leaves the room files behind for a restart to load. */
  keepData: boolean;
  call<T = any>(path: string, options?: {token?: string | null; body?: unknown; method?: string}): Promise<ApiResult<T>>;
  guest(name: string): Promise<Session>;
  createRoom(session: Session, bots?: number): Promise<any>;
  join(session: Session, code: string): Promise<ApiResult>;
  command(session: Session, roomId: string, body: Record<string, unknown>): Promise<ApiResult>;
  view(session: Session, roomId: string): Promise<any>;
  audit(session: Session, roomId: string): Promise<ApiResult>;
  connect(session: Session, roomId?: string): Promise<TestClient>;
  close(): Promise<void>;
}

export interface TestClient {
  messages: any[];
  send(message: unknown): void;
  /** Waits for the next message of the given type, or throws after the budget. */
  next(type: string, timeoutMs?: number): Promise<any>;
  closed(): Promise<{code: number; reason: string}>;
  close(): void;
  raw: WebSocket;
}

export interface StartOptions {
  storage?: 'file' | 'memory';
  /** Reuse a previous run's directory: the room files on disk are the restart. */
  dataDir?: string;
  /** Keep the directory on close so a later start can read the rooms back. */
  keepData?: boolean;
  /** Protocol ping interval; off by default so no test races the heartbeat. */
  heartbeatMs?: number | null;
  /** How long a socket may stay silent before it is closed; off by default. */
  subscribeTimeoutMs?: number | null;
}

export async function startTestServer(
  overrides: Partial<ServerConfig> = {},
  options: StartOptions = {},
): Promise<TestServer> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'poker-test-')));
  const clock = new TestClock();
  const config: ServerConfig = {
    ...loadConfig({POKER_MODE: 'development', POKER_DATA_DIR: dataDir}),
    port: 0,
    host: '127.0.0.1',
    dataDir,
    ...overrides,
  };
  const key = await loadOrCreateKey(join(dataDir, 'test.key'), null);
  // Durability is covered by storage.test.ts; the game-logic suites skip the fsync per
  // command so that playing a whole match stays fast.
  const storage = options.storage === 'memory' ? createMemoryStorage() : createFileStorage({dir: dataDir, key});
  const app = await createApp({
    config,
    storage,
    now: () => clock.now(),
    timers: clock.timers(),
    heartbeatMs: options.heartbeatMs ?? null,
    subscribeTimeoutMs: options.subscribeTimeoutMs ?? null,
  });
  const {port} = await app.listen();
  const url = `http://127.0.0.1:${port}`;

  const call = async <T = any>(
    path: string,
    options: {token?: string | null; body?: unknown; method?: string} = {},
  ): Promise<ApiResult<T>> => {
    const headers: Record<string, string> = {};
    if (options.token) headers['authorization'] = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(url + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return {status: response.status, body: body as T};
  };

  const guest = async (name: string): Promise<Session> => {
    const result = await call<Session>('/api/auth/guest', {body: {name}});
    if (result.status !== 200) throw new Error(`游客登录失败：${JSON.stringify(result.body)}`);
    return result.body;
  };

  const clients: TestClient[] = [];
  const server: TestServer = {
    url,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    port,
    clock,
    app,
    coordinator: app.coordinator,
    storage,
    dataDir,
    call,
    guest,
    createRoom: async (session, bots = 0) => {
      const result = await call('/api/rooms', {token: session.token, body: {bots}});
      if (result.status !== 200) throw new Error(`创建房间失败：${JSON.stringify(result.body)}`);
      return result.body;
    },
    join: (session, code) => call('/api/rooms/join', {token: session.token, body: {code}}),
    command: (session, roomId, body) => call(`/api/rooms/${roomId}/command`, {token: session.token, body}),
    view: async (session, roomId) => (await call(`/api/rooms/${roomId}`, {token: session.token})).body,
    audit: (session, roomId) => call(`/api/rooms/${roomId}/audit`, {token: session.token}),
    connect: async (session, roomId) => {
      const client = await openSocket(server.wsUrl);
      clients.push(client);
      client.send({type: 'subscribe', token: session.token, roomId});
      return client;
    },
    close: async () => {
      for (const client of clients) client.close();
      await app.close();
      if (options.keepData !== true) await rm(dataDir, {recursive: true, force: true});
    },
    keepData: options.keepData === true,
  };
  return server;
}

/**
 * Stops the server and boots a new one on the same data directory, the way a
 * process restart looks to the rooms: same key, same snapshot files, new clock.
 */
export async function restartServer(
  server: TestServer,
  overrides: Partial<ServerConfig> = {},
): Promise<TestServer> {
  const {dataDir, keepData} = server;
  await server.close();
  return startTestServer(overrides, {storage: 'file', dataDir, keepData});
}

/** Opens a socket and speaks the wire protocol; the caller decides what to send. */
export async function openSocket(url: string): Promise<TestClient> {
  const raw = new WebSocket(url);
  const messages: any[] = [];
  const waiters: {type: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout}[] = [];
  const closedPromise = new Promise<{code: number; reason: string}>(resolve => {
    raw.addEventListener('close', event => resolve({code: (event as CloseEvent).code, reason: (event as CloseEvent).reason}));
  });
  raw.addEventListener('message', event => {
    const parsed = JSON.parse(String((event as MessageEvent).data));
    messages.push(parsed);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (waiter.type === parsed.type) {
        waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(parsed);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    raw.addEventListener('open', () => resolve());
    raw.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  return {
    messages,
    raw,
    send: message => raw.send(JSON.stringify(message)),
    next: (type, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const existing = messages.find(message => message.type === type);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => {
          const index = waiters.findIndex(waiter => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`等待 ${type} 消息超时，已收到：${messages.map(message => message.type).join(',')}`));
        }, timeoutMs);
        waiters.push({type, resolve, reject, timer});
      }),
    closed: () => closedPromise,
    close: () => {
      if (raw.readyState === WebSocket.OPEN) raw.close();
    },
  };
}

export function nonce(): string {
  return randomBytes(32).toString('hex');
}

/** Readies every human and starts the match, using the current version each time. */
export async function startMatch(server: TestServer, roomId: string, players: Session[]): Promise<void> {
  for (const player of players) {
    const view = await server.view(player, roomId);
    const result = await server.command(player, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'ready',
      ready: true,
    });
    if (result.status !== 200) throw new Error(`准备失败：${JSON.stringify(result.body)}`);
  }
  const view = await server.view(players[0]!, roomId);
  const started = await server.command(players[0]!, roomId, {
    requestId: crypto.randomUUID(),
    expectedVersion: view.version,
    type: 'start',
  });
  if (started.status !== 200) throw new Error(`开始失败：${JSON.stringify(started.body)}`);
}

/** Every seated human submits a fresh nonce for the open hand. */
export async function contributeAll(server: TestServer, roomId: string, players: Session[]): Promise<void> {
  const view = await server.view(players[0]!, roomId);
  const handNo = view.fairness.handNo as number;
  for (const player of players) {
    const seat = view.members.find((member: any) => member.userId === player.user.id)?.seat;
    if (seat === undefined || view.fairness.expected.includes(seat) === false) continue;
    const result = await server.command(player, roomId, {
      requestId: crypto.randomUUID(),
      type: 'contribute',
      nonce: nonce(),
      handNo,
    });
    if (result.status !== 200) throw new Error(`贡献失败：${JSON.stringify(result.body)}`);
  }
  // The last contribution closes the round; the deal then runs off the command's queue.
  await waitFor(() => {
    const stage = server.coordinator.get(roomId)?.fairnessStage?.stage;
    return stage === 'playing' || stage === 'settled';
  }, '发牌');
}

/** Reads the seat a session occupies in a room view. */
export function seatOf(view: any, session: Session): number | undefined {
  return view.members.find((member: any) => member.userId === session.user.id)?.seat;
}

/** Picks an action from the legal set a player was just handed. */
export type ActionPolicy = (legal: {
  fold: boolean;
  check: boolean;
  call: number | null;
  minRaiseTo: number | null;
  maxRaiseTo: number | null;
  allIn: boolean;
}) => unknown;

/** Folds whenever folding is offered, otherwise checks. */
export const FOLD_ALWAYS: ActionPolicy = legal => (legal.fold ? {type: 'fold'} : {type: 'check'});
/** Never folds while a free card is available; calls any bet it cannot check. */
export const CALL_ALWAYS: ActionPolicy = legal =>
  legal.check ? {type: 'check'} : legal.call !== null ? {type: 'call'} : {type: 'fold'};

/** Reads a session's own view and reports its turn, or null when it is not their turn. */
export async function turnOf(
  server: TestServer,
  roomId: string,
  session: Session,
): Promise<{seat: number; version: number; legal: any; view: any} | null> {
  const view = (await server.view(session, roomId));
  const legal = view.hand?.legal ?? null;
  if (legal === null) return null;
  return {seat: view.you.seat, version: view.version, legal, view};
}

/** Sends an action using the sender's own fresh version, the way a client would. */
export async function act(
  server: TestServer,
  roomId: string,
  session: Session,
  action: unknown,
): Promise<ApiResult> {
  const view = (await server.view(session, roomId));
  return server.command(session, roomId, {
    requestId: crypto.randomUUID(),
    expectedVersion: view.version,
    type: 'action',
    action,
  });
}

export interface AdvanceOptions {
  /** Defaults to folding every turn: the fastest way to finish a hand. */
  policy?: ActionPolicy;
  /** Stops as soon as this is true; defaults to "the match is over". */
  until?: (view: any) => boolean;
  maxHands?: number;
  contributions?: boolean;
}

/**
 * Plays a match forward. Humans contribute when a window is open and act with the
 * given policy when it is their turn; bots play their own strategy with the clock
 * advanced so their timers fire. Stops when `until` holds and returns that view.
 */
export async function advanceMatch(
  server: TestServer,
  roomId: string,
  players: Session[],
  options: AdvanceOptions = {},
): Promise<any> {
  const policy = options.policy ?? FOLD_ALWAYS;
  const until = options.until ?? ((view: any) => view.status === 'finished');
  const maxHands = options.maxHands ?? 200;
  let iterations = 0;

  for (;;) {
    if (++iterations > 6000) throw new Error('牌局没有推进，可能是死循环');
    const view = (await server.view(players[0]!, roomId));
    if (until(view)) return view;
    if (view.completedHands >= maxHands) throw new Error(`比赛未能在 ${maxHands} 手内结束`);

    if (view.fairness.stage === 'collecting') {
      if (options.contributions === false) {
        await server.clock.advance(5000);
        continue;
      }
      for (const player of players) {
        const seat = seatOf(view, player);
        if (seat === undefined || !view.fairness.expected.includes(seat)) continue;
        const result = await server.command(player, roomId, {
          requestId: crypto.randomUUID(),
          type: 'contribute',
          nonce: nonce(),
          handNo: view.fairness.handNo,
        });
        if (result.status !== 200) throw new Error(`贡献失败：${JSON.stringify(result.body)}`);
      }
      await drain(2);
      continue;
    }

    const actorSeat = view.hand?.actor ?? null;
    if (view.fairness.stage !== 'playing' || actorSeat === null) {
      await server.clock.advance(2000);
      continue;
    }
    const actor = players.find(player => seatOf(view, player) === actorSeat);
    if (actor === undefined) {
      await server.clock.advance(1500); // A bot is thinking; let its timer fire.
      continue;
    }
    const turn = await turnOf(server, roomId, actor);
    if (turn === null) throw new Error('轮到行动却拿不到合法操作');
    const result = await act(server, roomId, actor, policy(turn.legal));
    if (result.status !== 200) throw new Error(`行动失败：${JSON.stringify(result.body)}`);
  }
}

/** Plays the whole match out to a winner. */
export async function finishMatch(server: TestServer, roomId: string, players: Session[]): Promise<void> {
  await advanceMatch(server, roomId, players);
}

/** A room with a host, a second human and optional bots, ready to start. */
export async function readyRoom(
  server: TestServer,
  options: {bots?: number; extraHumans?: number} = {},
): Promise<{roomId: string; host: Session; players: Session[]; code: string}> {
  const host = await server.guest('房主');
  const created = await server.createRoom(host, options.bots ?? 0);
  const players: Session[] = [host];
  for (let index = 0; index < (options.extraHumans ?? 1); index++) {
    const player = await server.guest(`玩家${index + 2}`);
    const joined = await server.join(player, created.code);
    if (joined.status !== 200) throw new Error(`加入房间失败：${JSON.stringify(joined.body)}`);
    players.push(player);
  }
  return {roomId: created.id, host, players, code: created.code};
}

/** The player whose turn it is, with their legal actions; null while nobody can act. */
export async function waitingActor(
  server: TestServer,
  roomId: string,
  players: Session[],
): Promise<{session: Session; seat: number; version: number; legal: any; view: any} | null> {
  for (const session of players) {
    const turn = await turnOf(server, roomId, session);
    if (turn !== null) return {session, ...turn};
  }
  return null;
}
