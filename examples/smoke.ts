/**
 * 端到端冒烟：对**正在运行的真实服务端**跑一遍两个客户端真正会走的路径
 * （HTTP 契约 → 公平开局与贡献 → 打完整场 → 赛后核验 → WebSocket 关闭码与隐私）。
 *
 * 它不是测试套件的替代品（单元测试覆盖分支，这里只证明「跑起来是对的」）：
 * 每一行断言都对应客户端源码里真实读取的字段，或者 docs/product/contract.md 的约定。
 *
 * 用法：
 *   npm run smoke                                        # 自己起一个临时服务端（随机端口 + 临时数据目录）
 *   POKER_BASE=https://poker.example.com node examples/smoke.ts   # 核对已部署的实例
 *
 * 退出码：全部通过为 0，任一条不符为 1。
 */

import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ChildProcess} from 'node:child_process';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SPAWN = process.argv.includes('--spawn') || !process.env['POKER_BASE'];

const results: string[] = [];
let failures = 0;

function ok(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1;
  results.push(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const uuid = (): string => crypto.randomUUID();
const HEX64 = /^[0-9a-f]{64}$/;

interface ApiResult {
  status: number;
  body: any;
}

function makeClient(base: string) {
  return async function call(method: string, path: string, options: {token?: string; body?: unknown} = {}): Promise<ApiResult> {
    const response = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? {authorization: `Bearer ${options.token}`} : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return {status: response.status, body: await response.json().catch(() => null)};
  };
}

async function waitForServer(base: string, budgetMs = 15000): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // 还没起来，继续等。
    }
    await sleep(100);
  }
  throw new Error('服务端没有在 15 秒内就绪');
}

/** 起一个临时服务端（开发模式、文件存储、随机端口），返回 base 与关闭函数。 */
async function spawnServer(): Promise<{base: string; stop: () => Promise<void>}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'poker-smoke-'));
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'apps/server/src/main.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      POKER_MODE: 'development',
      POKER_STORAGE: 'file',
      POKER_STORAGE_KEY: 'ab'.repeat(32),
      POKER_HOST: '127.0.0.1',
      POKER_PORT: '0',
      POKER_DATA_DIR: dataDir,
      // 打到分出胜负才解锁赛后核验，而每手之间有 4 秒结算展示；机器人一直弃牌时
      // 一场可能几十手，按生产节奏就是好几分钟。这两个时长只在开发模式下可改，
      // 生产模式会忽略（见 config.ts），所以压缩节奏不会改变要验证的行为。
      POKER_SETTLE_MS: '40',
      POKER_BOT_THINK_MS: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const until = Date.now() + 15000;
  let port = 0;
  while (Date.now() < until && port === 0) {
    port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)?.[1] ?? 0);
    if (port === 0) {
      if (child.exitCode !== null) throw new Error(`服务端启动失败（${child.exitCode}）：${stdout}${stderr}`);
      await sleep(50);
    }
  }
  if (port === 0) {
    child.kill('SIGKILL');
    throw new Error(`没有从启动日志里读到端口：${stdout}${stderr}`);
  }
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(base);
  return {
    base,
    async stop() {
      child.kill('SIGTERM');
      await sleep(200);
      child.kill('SIGKILL');
      await rm(dataDir, {recursive: true, force: true});
    },
  };
}

/** 最小 WebSocket 客户端：收集消息、记录关闭帧。 */
function openSocket(url: string) {
  const ws = new WebSocket(url);
  const messages: any[] = [];
  let closeFrame: {code: number; reason: string} | null = null;
  ws.onmessage = event => {
    try {
      messages.push(JSON.parse(String(event.data)));
    } catch {
      messages.push({type: 'unparsable'});
    }
  };
  ws.onerror = () => {};
  const closed = new Promise<{code: number; reason: string}>(resolve => {
    ws.onclose = event => {
      closeFrame = {code: event.code, reason: event.reason};
      resolve(closeFrame);
    };
  });
  return {
    ws,
    closed,
    ready: new Promise<void>(resolve => { ws.onopen = () => resolve(); }),
    send: (payload: unknown): void => ws.send(JSON.stringify(payload)),
    sendRaw: (payload: string): void => ws.send(payload),
    /** 最新一条满足条件的消息（避免取到之前的同类消息）。 */
    async waitFor(predicate: (message: any) => boolean, budgetMs = 5000): Promise<any> {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (predicate(messages[index])) return messages[index];
        }
        await sleep(50);
      }
      return null;
    },
    get closeFrame() { return closeFrame; },
  };
}

async function checkHttp(base: string): Promise<void> {
  const call = makeClient(base);

  const health = await call('GET', '/api/health');
  ok('GET /api/health 返回 {ok:true, mode, auth}',
    health.status === 200 && health.body.ok === true && typeof health.body.mode === 'string',
    `mode=${health.body?.mode} auth=${health.body?.auth}`);

  for (const page of ['/', '/index.html', '/room.html', '/table.html', '/rules.html', '/audit.html']) {
    const response = await fetch(base + page);
    ok(`静态页 ${page} 可用`, response.status === 200 && /text\/html/.test(response.headers.get('content-type') ?? ''),
      `HTTP ${response.status}`);
  }

  const login = await call('POST', '/api/auth/guest', {body: {name: '冒烟'}});
  ok('游客登录返回 token 与 user', login.status === 200 && typeof login.body?.token === 'string' && typeof login.body?.user?.id === 'string');
  const token = login.body.token as string;
  const command = (roomId: string, body: Record<string, unknown>) =>
    call('POST', `/api/rooms/${roomId}/command`, {token, body: {requestId: uuid(), ...body}});

  // 房间接口必须是裸 RoomView：两个客户端都是直接把它当房间对象用的。
  const created = await call('POST', '/api/rooms', {token, body: {name: '冒烟局', bots: 1}});
  ok('POST /api/rooms 直接返回 RoomView', typeof created.body?.id === 'string', Object.keys(created.body ?? {}).slice(0, 6).join(','));
  const roomId = created.body.id as string;
  ok('等待房间给出身份、盲注元组与升盲信息',
    created.body.viewerId === login.body.user.id && created.body.viewerSeat === 0 &&
    Array.isArray(created.body.blinds) && created.body.blinds.length === 2 &&
    Array.isArray(created.body.nextBlinds) && created.body.handsToNextLevel === 10,
    `blinds=${JSON.stringify(created.body.blinds)} next=${JSON.stringify(created.body.nextBlinds)} 剩 ${created.body.handsToNextLevel} 手`);
  ok('等待房间的 fairness 为 null，倒计时字段存在',
    created.body.fairness === null && 'deadline' in created.body && 'nextHandAt' in created.body);

  const fetched = await call('GET', `/api/rooms/${roomId}`, {token});
  ok('GET /api/rooms/:id 也是裸视图（断线回退直接用它）',
    fetched.body?.id === roomId && typeof fetched.body.version === 'number');

  const ready = await command(roomId, {type: 'ready', ready: true});
  ok('命令响应直接返回 RoomView', ready.body?.id === roomId, `status=${ready.status}`);
  const started = await command(roomId, {type: 'start', expectedVersion: ready.body.version});
  ok('开赛后 fairness 变成对象（承诺 + 贡献窗口 + owed）',
    started.body?.fairness !== null && HEX64.test(started.body?.fairness?.commitment ?? '') &&
    typeof started.body.fairness.deadline === 'number' && started.body.fairness.owed === true);

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const contributed = await command(roomId, {type: 'contribute', handNo: started.body.fairness.handNo, nonce});
  const fairness = contributed.body?.fairness;
  ok('贡献被接受，人齐即发牌并公布牌序承诺',
    contributed.status === 200 && fairness.stage === 'dealing' && HEX64.test(fairness.deckCommitment ?? ''),
    `贡献者 ${JSON.stringify(fairness?.contributors)}`);
  ok('contributors 是座位号数组', Array.isArray(fairness.contributors) && fairness.contributors.every((seat: unknown) => Number.isInteger(seat)));
  ok('视图里没有 serverSeed，也没有未公开的牌序',
    !JSON.stringify(contributed.body).includes('serverSeed') && !JSON.stringify(contributed.body).includes('"deck"'));

  const locked = await call('GET', `/api/rooms/${roomId}/audit`, {token});
  ok('比赛没结束不给核验（403 AUDIT_LOCKED）',
    locked.status === 403 && locked.body?.error?.code === 'AUDIT_LOCKED', locked.body?.error?.message);

  // 打完这一场：人类一路全押，同时把「轮到自己时视图长什么样」的几条契约断言采集下来。
  // 之所以边打边采集而不是固定抽一帧：节奏压缩后机器人一弃牌整手就结束了，
  // 固定抽样很容易正好落在已经结算的那一手（那时 deadline 为 null、摊牌的一手底牌也会公开），
  // 那不是契约被违反，只是抽到了另一个同样合法的状态。
  // 墙钟兜底，外加盯版本号：长时间不动说明是真卡住而不是慢，把现场写进失败信息。
  let final: any = null;
  let reason = '超时未结束';
  const matchDeadline = Date.now() + 60_000;
  let lastVersion = -1;
  let lastChange = Date.now();
  let dealingSeen = false;
  let actingViews = 0;
  let privacyViolations = 0;
  let maxSecondsLeft = 0;
  while (Date.now() < matchDeadline) {
    const current = (await call('GET', `/api/rooms/${roomId}`, {token})).body;
    if (current.version !== lastVersion) {
      lastVersion = current.version;
      lastChange = Date.now();
    }
    if (current.status === 'finished') {
      final = current;
      break;
    }
    if (Date.now() - lastChange > 20_000) {
      reason = `房间停在 v${current.version} 已有 20 秒：status=${current.status} stage=${current.fairness?.stage} hand=${current.hand?.street} actor=${current.hand?.actor}`;
      break;
    }
    if (current.hand !== null) dealingSeen = true;
    if (current.fairness?.owed) {
      await command(roomId, {
        type: 'contribute',
        handNo: current.fairness.handNo,
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
      });
      continue;
    }
    const hand = current.hand;
    if (hand && hand.actor === 0 && hand.legal) {
      // 这一帧就是「轮到我」：本人 2 张、别人 0 张、倒计时指向未来。
      actingViews += 1;
      const mine = hand.players.find((player: any) => player.seat === 0);
      const others = hand.players.filter((player: any) => player.seat !== 0);
      if (mine?.hole.length !== 2 || !others.every((player: any) => player.hole.length === 0)) privacyViolations += 1;
      if (typeof current.deadline === 'number' && current.deadline > current.serverTime) {
        maxSecondsLeft = Math.max(maxSecondsLeft, Math.round((current.deadline - current.serverTime) / 1000));
      }
      const action = hand.legal.allIn ? {type: 'allIn'} : hand.legal.check ? {type: 'check'} : {type: 'call'};
      await command(roomId, {type: 'action', action, expectedVersion: current.version});
      continue;
    }
    await sleep(50);
  }
  ok('发牌后 hand 出现', dealingSeen);
  ok('本人底牌 2 张、别人底牌为空（视图就是隐私边界）',
    actingViews > 0 && privacyViolations === 0,
    `轮到自己 ${actingViews} 次，越界 ${privacyViolations} 次`);
  ok('行动倒计时可用（deadline − serverTime）', maxSecondsLeft > 0, `${maxSecondsLeft} 秒`);
  ok('比赛能打到结束', final !== null, final ? `${final.completedHands} 手，赢家座位 ${final.winner}` : reason);
  ok('结束后 nextHandAt 归零', final ? final.nextHandAt === null : false);

  const audit = await call('GET', `/api/rooms/${roomId}/audit`, {token});
  ok('核验响应直接给出 matchId / rounds / events / verification',
    audit.status === 200 && typeof audit.body?.matchId === 'string' &&
    Array.isArray(audit.body?.rounds) && audit.body.rounds.length === audit.body.completedHands &&
    Array.isArray(audit.body?.events) && typeof audit.body?.verification?.valid === 'boolean',
    `共 ${audit.body?.rounds?.length ?? 0} 手，valid=${audit.body?.verification?.valid}`);
  ok('核验逐手通过（承诺、牌序、发牌都对得上）',
    audit.body?.verification?.valid === true && (audit.body?.verification?.errors ?? []).length === 0,
    JSON.stringify(audit.body?.verification?.errors));
  const round = audit.body?.rounds?.[0] ?? {};
  ok('每手给出复算所需的全部字段，contributions 是 {座位: nonce} 对象',
    typeof round.matchId === 'string' && typeof round.handNo === 'number' && HEX64.test(round.serverSeed ?? '') &&
    Array.isArray(round.seats) && round.contributions !== null && typeof round.contributions === 'object' &&
    !Array.isArray(round.contributions) && HEX64.test(round.contributions['0'] ?? ''));

  const outsider = await call('POST', '/api/auth/guest', {body: {name: '路人'}});
  const denied = await call('GET', `/api/rooms/${roomId}`, {token: outsider.body.token});
  ok('非成员拿不到房间（403 FORBIDDEN）', denied.status === 403 && denied.body?.error?.code === 'FORBIDDEN');
  const anonymous = await call('GET', `/api/rooms/${roomId}`);
  ok('未登录拿不到房间（401 UNAUTHORIZED）', anonymous.status === 401 && anonymous.body?.error?.code === 'UNAUTHORIZED');
  ok('错误消息是固定中文串，不是英文堆栈', /[一-龥]/.test(denied.body?.error?.message ?? ''), denied.body?.error?.message);
}

async function checkSocket(base: string): Promise<void> {
  const call = makeClient(base);
  const wsUrl = base.replace(/^http/, 'ws') + '/ws';

  const host = (await call('POST', '/api/auth/guest', {body: {name: '连接甲'}})).body;
  const outsider = (await call('POST', '/api/auth/guest', {body: {name: '连接乙'}})).body;
  const room = (await call('POST', '/api/rooms', {token: host.token, body: {name: '连接局', bots: 2}})).body;
  const roomId = room.id as string;

  const first = openSocket(wsUrl);
  await first.ready;
  first.send({type: 'subscribe', token: host.token, roomId});
  const state = await first.waitFor(message => message.type === 'state');
  ok('订阅后收到 {type:state, room:RoomView}', state?.room?.id === roomId, `version=${state?.room?.version}`);
  ok('令牌只走 subscribe 消息，不进 URL', !wsUrl.includes('token') && !/token=/.test(wsUrl));
  ok('视图带 serverTime 供倒计时校正', typeof state?.room?.serverTime === 'number');

  first.send({type: 'ping'});
  ok('应用层 ping 得到 pong', Boolean(await first.waitFor(message => message.type === 'pong')));

  first.sendRaw('不是 JSON');
  const bad = await first.waitFor(message => message.type === 'error');
  ok('坏消息回 BAD_MESSAGE 且连接不断', bad?.error?.code === 'BAD_MESSAGE' && first.ws.readyState === WebSocket.OPEN,
    bad?.error?.message);

  const second = openSocket(wsUrl);
  await second.ready;
  second.send({type: 'subscribe', token: host.token, roomId});
  await second.waitFor(message => message.type === 'state');
  const replaced = await first.waitFor(message => message.type === 'error' && message.error.code === 'SESSION_INVALIDATED');
  ok('同一用户再开连接会顶号（SESSION_INVALIDATED + 中文原因）',
    Boolean(replaced) && /其他设备/.test(replaced?.error?.message ?? ''), replaced?.error?.message);
  ok('被顶掉的连接以 4001 关闭', (await first.closed).code === 4001);

  const stranger = openSocket(wsUrl);
  await stranger.ready;
  stranger.send({type: 'subscribe', token: outsider.token, roomId});
  const refused = await stranger.waitFor(message => message.type === 'error');
  ok('非成员订阅被拒（FORBIDDEN），连接不断、拿不到任何数据',
    refused?.error?.code === 'FORBIDDEN' && stranger.ws.readyState === WebSocket.OPEN &&
    stranger.closeFrame === null, refused?.error?.message);
  stranger.ws.close();

  const forged = openSocket(wsUrl);
  await forged.ready;
  forged.send({type: 'subscribe', token: 'not-a-token', roomId});
  const unauthorized = await forged.waitFor(message => message.type === 'error');
  ok('坏令牌回 UNAUTHORIZED 并以 4001 关闭',
    unauthorized?.error?.code === 'UNAUTHORIZED' && (await forged.closed).code === 4001, unauthorized?.error?.message);

  const silent = openSocket(wsUrl);
  await silent.ready;
  ok('迟迟不订阅的连接以 1008 关闭（10 秒内）', (await silent.closed).code === 1008);

  // 成员离开房间：连接必须被服务端收走，前端据此停止重连（4003）。
  const guest = (await call('POST', '/api/auth/guest', {body: {name: '被移除'}})).body;
  await call('POST', '/api/rooms/join', {token: guest.token, body: {code: room.code}});
  const guestSocket = openSocket(wsUrl);
  await guestSocket.ready;
  guestSocket.send({type: 'subscribe', token: guest.token, roomId});
  await guestSocket.waitFor(message => message.type === 'state');
  const view = (await call('GET', `/api/rooms/${roomId}`, {token: guest.token})).body;
  await call('POST', `/api/rooms/${roomId}/command`, {
    token: guest.token,
    body: {requestId: uuid(), type: 'leave', expectedVersion: view.version},
  });
  const kicked = await guestSocket.waitFor(message => message.type === 'error');
  ok('离开房间后连接被收走（FORBIDDEN + 4003）',
    kicked?.error?.code === 'FORBIDDEN' && (await guestSocket.closed).code === 4003, kicked?.error?.message);

  second.ws.close();
}

async function main(): Promise<void> {
  let spawned: {base: string; stop: () => Promise<void>} | null = null;
  const base = process.env['POKER_BASE'] ?? '';
  try {
    if (SPAWN) {
      spawned = await spawnServer();
      console.log(`冒烟目标：${spawned.base}（本次临时启动的进程，开发模式 + 文件存储）`);
    } else {
      await waitForServer(base);
      console.log(`冒烟目标：${base}`);
    }
    const target = spawned ? spawned.base : base;
    await checkHttp(target);
    console.log('— HTTP 契约 —');
    console.log(results.join('\n'));
    const httpCount = results.length;
    await checkSocket(target);
    console.log('\n— WebSocket 与关闭码 —');
    console.log(results.slice(httpCount).join('\n'));
  } finally {
    if (spawned) await spawned.stop();
  }
  console.log(failures === 0 ? `\n全部 ${results.length} 项通过` : `\n${failures} 项不符（共 ${results.length} 项）`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
