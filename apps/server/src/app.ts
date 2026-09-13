import {createServer} from 'node:http';
import type {IncomingMessage, Server, ServerResponse} from 'node:http';
import {fileURLToPath} from 'node:url';
import {Auth, sanitizeName} from './auth.ts';
import {buildAudit} from './audit.ts';
import {JOIN_CODE_MAX_FAILURES, JOIN_CODE_WINDOW_MS, WS_HEARTBEAT_MS, WS_PONG_TIMEOUT_MS, WS_SUBSCRIBE_TIMEOUT_MS} from './config.ts';
import type {ServerConfig} from './config.ts';
import {AppError, toAppError} from './errors.ts';
import {bearerToken, readJsonBody, sendError, sendJson} from './http.ts';
import {randomHex} from './ids.ts';
import {Router} from './router.ts';
import {createStaticHandler} from './static.ts';
import {createPgStorageFromUrl} from './storage/pg-db.ts';
import {createFileStorage, loadOrCreateKey} from './storage/file.ts';
import type {Storage} from './storage/storage.ts';
import {Coordinator} from './rooms/coordinator.ts';
import {Hub} from './rooms/hub.ts';
import type {Connection} from './rooms/hub.ts';
import {realTimers} from './rooms/timers.ts';
import type {TimerApi, TimerHandle} from './rooms/timers.ts';
import {CLOSE, attachSocket, upgradeResponse} from './ws.ts';
import type {SocketConnection} from './ws.ts';
import {exchangeCode} from './wechat.ts';

export interface AppOptions {
  config: ServerConfig;
  storage: Storage;
  now?: () => number;
  timers?: TimerApi;
  random?: () => number;
  botThinkMs?: number;
  settleDelayMs?: number;
  log?: (message: string, error?: unknown) => void;
  webRoot?: string;
  heartbeatMs?: number | null;
  subscribeTimeoutMs?: number | null;
}

export interface App {
  server: Server;
  coordinator: Coordinator;
  auth: Auth;
  hub: Hub;
  storage: Storage;
  listen(): Promise<{host: string; port: number}>;
  close(): Promise<void>;
}

interface ClientState {
  id: string;
  userId: string | null;
  socket: SocketConnection;
  hub: Connection | null;
  subscribed: boolean;
  lastSeen: number;
  subscribeTimer: TimerHandle | null;
}

const defaultLog = (message: string, error?: unknown): void => console.error(`[server] ${message}`, error ?? '');

export async function createApp(options: AppOptions): Promise<App> {
  const {config} = options;
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers();
  const log = options.log ?? defaultLog;
  const hub = new Hub();
  const auth = new Auth({storage: options.storage, ttlMs: config.sessionTtlMs, now});
  await options.storage.init();
  await auth.init();
  const coordinator = new Coordinator({
    storage: options.storage,
    hub,
    timers,
    now,
    random: options.random,
    botThinkMs: options.botThinkMs ?? config.botThinkMs,
    settleDelayMs: options.settleDelayMs ?? config.settleDelayMs,
    log,
  });
  await coordinator.restore();

  const router = new Router();
  const clients = new Map<string, ClientState>();
  const joinFailures = new Map<string, {count: number; resetAt: number}>();
  const heartbeatMs = options.heartbeatMs === undefined ? WS_HEARTBEAT_MS : options.heartbeatMs;
  const subscribeTimeoutMs = options.subscribeTimeoutMs === undefined ? WS_SUBSCRIBE_TIMEOUT_MS : options.subscribeTimeoutMs;

  // -- helpers -------------------------------------------------------------

  async function requireUser(req: IncomingMessage) {
    const token = bearerToken(req);
    if (token === null) throw new AppError('UNAUTHORIZED');
    const user = await auth.resolve(token);
    if (user === null) throw new AppError('UNAUTHORIZED');
    return user;
  }

  function noteJoinFailure(userId: string): void {
    const at = now();
    const entry = joinFailures.get(userId);
    if (!entry || at > entry.resetAt) {
      joinFailures.set(userId, {count: 1, resetAt: at + JOIN_CODE_WINDOW_MS});
      return;
    }
    entry.count += 1;
    if (entry.count > JOIN_CODE_MAX_FAILURES) throw new AppError('RATE_LIMITED');
  }

  // -- routes --------------------------------------------------------------

  router.add('GET', '/api/health', ({res}) => {
    sendJson(res, 200, {
      ok: true,
      mode: config.mode,
      auth: config.mode === 'development' ? 'guest' : 'wechat',
      wechatConfigured: config.wechat !== null,
    });
  });

  router.add('POST', '/api/auth/guest', async ({req, res}) => {
    if (config.mode === 'production') throw new AppError('GUEST_DISABLED');
    const body = await readJsonBody(req);
    const name = sanitizeName(body['name']);
    const {token, user} = await auth.create(name, `guest_${randomHex(8)}`);
    sendJson(res, 200, {token, user, mode: config.mode});
  });

  router.add('POST', '/api/auth/wechat', async ({req, res}) => {
    const body = await readJsonBody(req);
    const name = sanitizeName(body['name'] ?? '微信玩家');
    const code = body['code'];
    if (typeof code !== 'string' || code === '') throw new AppError('INVALID_INPUT', '登录凭证不合法');
    if (config.wechat === null) {
      throw config.mode === 'production'
        ? new AppError('WECHAT_UNAVAILABLE')
        : new AppError('WECHAT_NOT_CONFIGURED');
    }
    const openId = await exchangeCode(config.wechat, code);
    const {token, user} = await auth.create(name, `wx_${openId}`);
    sendJson(res, 200, {token, user, mode: config.mode});
  });

  router.add('GET', '/api/me', async ({req, res}) => {
    const user = await requireUser(req);
    sendJson(res, 200, {user, mode: config.mode});
  });

  router.add('POST', '/api/rooms', async ({req, res}) => {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const bots = body['bots'] ?? 0;
    if (!Number.isInteger(bots) || (bots as number) < 0 || (bots as number) > 8) {
      throw new AppError('INVALID_INPUT', '机器人数量需在 0 到 8 之间');
    }
    const roomName = body['name'] === undefined ? `${user.name}的牌局` : sanitizeName(body['name']);
    const room = await coordinator.createRoom({
      userId: user.id,
      name: user.name,
      roomName,
      bots: bots as number,
    });
    // 契约要求这些接口直接返回 RoomView（id/code/invite 都在视图里），
    // 外面再包一层 {room} 会让两个客户端都取不到 id。
    sendJson(res, 200, coordinator.view(room.id, user.id));
  });

  router.add('POST', '/api/rooms/join', async ({req, res}) => {
    const user = await requireUser(req);
    const body = await readJsonBody(req);
    const code = typeof body['code'] === 'string' ? body['code'] : null;
    const invite = typeof body['invite'] === 'string' ? body['invite'] : null;
    if (code === null && invite === null) throw new AppError('INVALID_INPUT', '请提供房间号或邀请链接');
    const room = invite !== null ? coordinator.byInvite(invite) : coordinator.byCode(code!);
    if (room === null) {
      noteJoinFailure(user.id);
      throw new AppError('NOT_FOUND', '房间不存在，请检查房间号');
    }
    joinFailures.delete(user.id);
    await coordinator.join(room.id, user.id, user.name);
    sendJson(res, 200, coordinator.view(room.id, user.id));
  });

  router.add('GET', '/api/rooms/:id', async ({req, res, params}) => {
    const user = await requireUser(req);
    const roomId = params['id']!;
    if (coordinator.get(roomId) === null) throw new AppError('NOT_FOUND');
    if (!coordinator.memberOf(roomId, user.id)) throw new AppError('FORBIDDEN', '你不是该房间成员');
    sendJson(res, 200, coordinator.view(roomId, user.id));
  });

  router.add('POST', '/api/rooms/:id/command', async ({req, res, params}) => {
    const user = await requireUser(req);
    const roomId = params['id']!;
    const body = await readJsonBody(req);
    const result = await coordinator.command(roomId, user.id, body);
    sendJson(res, 200, result);
  });

  router.add('GET', '/api/rooms/:id/audit', async ({req, res, params}) => {
    const user = await requireUser(req);
    const roomId = params['id']!;
    const room = coordinator.get(roomId);
    if (room === null) throw new AppError('NOT_FOUND');
    if (!coordinator.memberOf(roomId, user.id)) throw new AppError('FORBIDDEN', '你不是该房间成员');
    if (room.status !== 'finished') throw new AppError('AUDIT_LOCKED');
    sendJson(res, 200, buildAudit(room));
  });

  router.add('GET', '/ws', ({res}) => {
    res.writeHead(426, {'content-type': 'text/plain; charset=utf-8'});
    res.end('该地址仅接受 WebSocket 连接');
  });

  const serveStatic = createStaticHandler({
    root: options.webRoot ?? fileURLToPath(new URL('../../web/', import.meta.url)),
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendJson(res, 400, {error: {code: 'INVALID_INPUT', message: '请求地址不合法'}});
      return;
    }
    try {
      if (await router.handle(req, res, url)) return;
      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, {error: {code: 'NOT_FOUND', message: '接口不存在'}});
        return;
      }
      await serveStatic({req, res, url, params: {}});
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === 'INTERNAL') log('未预期的请求错误', error);
      sendError(res, error);
    }
  }

  // -- websocket -----------------------------------------------------------

  server.on('upgrade', (req, socket, head) => {
    const result = upgradeResponse(req, {allowedOrigins: config.allowedOrigins});
    if (!result.ok) {
      const text = result.message === 'Unsupported WebSocket version' ? 'Upgrade Required' : 'Bad Request';
      const extra = result.status === 405 ? 'Allow: GET\r\n' : '';
      socket.write(
        `HTTP/1.1 ${result.status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write(result.response);
    const state: ClientState = {
      id: randomHex(8),
      userId: null,
      socket: null as unknown as SocketConnection,
      hub: null,
      subscribed: false,
      lastSeen: now(),
      subscribeTimer: null,
    };
    const connection = attachSocket({
      socket,
      onActivity: () => {
        state.lastSeen = now();
      },
      onMessage: (_conn, text) => {
        void handleMessage(state, text);
      },
      onClose: () => {
        state.subscribeTimer?.cancel();
        if (state.hub !== null) hub.remove(state.hub);
        clients.delete(state.id);
      },
    });
    state.socket = connection;
    clients.set(state.id, state);
    // Any bytes that arrived with the upgrade are replayed now that the state exists.
    if (head.length > 0) connection.push(head);
    if (subscribeTimeoutMs !== null && subscribeTimeoutMs > 0) {
      state.subscribeTimer = timers.set(subscribeTimeoutMs, () => {
        if (!state.subscribed) connection.close(CLOSE.policyViolation, 'subscribe timeout');
      });
    }
  });

  async function handleMessage(state: ClientState, text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'BAD_MESSAGE', message: '消息必须是 JSON'}}));
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'BAD_MESSAGE', message: '消息格式不合法'}}));
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (message['type'] === 'ping') {
      state.socket.send(JSON.stringify({type: 'pong'}));
      return;
    }
    if (message['type'] !== 'subscribe') {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'BAD_MESSAGE', message: '未知的消息类型'}}));
      return;
    }
    const token = message['token'];
    const roomId = message['roomId'];
    if (typeof token !== 'string' || typeof roomId !== 'string' || roomId === '') {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'BAD_MESSAGE', message: '订阅参数不合法'}}));
      return;
    }
    const user = await auth.resolve(token);
    if (user === null) {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'UNAUTHORIZED', message: '登录已失效，请重新登录'}}));
      state.socket.close(4001, 'unauthorized');
      return;
    }
    if (!coordinator.memberOf(roomId, user.id)) {
      state.socket.send(JSON.stringify({type: 'error', error: {code: 'FORBIDDEN', message: '你不是该房间成员'}}));
      return;
    }
    state.userId = user.id;
    const connection: Connection = state.hub ?? {
      id: state.id,
      userId: user.id,
      roomId: null,
      send: payload => state.socket.send(JSON.stringify(payload)),
      close: (code, reason) => state.socket.close(code, reason),
    };
    state.hub = connection;
    const evicted = hub.subscribe(connection, roomId);
    if (evicted !== null && evicted !== connection) {
      evicted.send({type: 'error', error: {code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}});
      evicted.close(4001, 'replaced');
    }
    state.subscribed = true;
    state.subscribeTimer?.cancel();
    state.subscribeTimer = null;
    const view = coordinator.view(roomId, user.id);
    if (view !== null) state.socket.send(JSON.stringify({type: 'state', room: view}));
  }

  let heartbeat: TimerHandle | null = null;
  if (heartbeatMs !== null && heartbeatMs > 0) {
    const tick = (): void => {
      const at = now();
      for (const state of clients.values()) {
        if (at - state.lastSeen > WS_PONG_TIMEOUT_MS) {
          state.socket.close(CLOSE.goingAway, 'heartbeat timeout');
          continue;
        }
        state.socket.ping();
      }
      heartbeat = timers.set(heartbeatMs, tick);
    };
    heartbeat = timers.set(heartbeatMs, tick);
  }

  async function shutdown(): Promise<void> {
    heartbeat?.cancel();
    for (const state of clients.values()) state.socket.close(CLOSE.goingAway, 'server shutdown');
    clients.clear();
    await coordinator.drain();
    await auth.flush(true);
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await options.storage.close();
  }

  return {
    server,
    coordinator,
    auth,
    hub,
    storage: options.storage,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      return {host: config.host, port};
    },
    close: shutdown,
  };
}

/** Builds the storage backend described by the environment. */
export async function createStorage(config: ServerConfig): Promise<Storage> {
  if (config.storage === 'postgres') {
    if (config.pgUrl === null) throw new Error('使用 postgres 存储必须设置 POKER_PG_URL');
    const key = await loadOrCreateKey(`${config.dataDir}/pg.key`, config.storageKey);
    return createPgStorageFromUrl({url: config.pgUrl, key});
  }
  const key = await loadOrCreateKey(`${config.dataDir}/dev.key`, config.storageKey);
  return createFileStorage({dir: config.dataDir, key});
}
