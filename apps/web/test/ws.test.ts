import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  TERMINAL_CLOSE_CODES,
  backoffDelay,
  closeDecision,
  createRoomSocket,
  parseSocketMessage,
  shouldApplyVersion,
} from '../static/js/ws.js';

type Job = {id: number; ms: number; fn: () => void};

function fakeTimers() {
  const jobs: Job[] = [];
  let nextId = 1;
  return {
    jobs,
    setTimeout(fn: () => void, ms: number) {
      const id = nextId;
      nextId += 1;
      jobs.push({id, ms, fn});
      return id;
    },
    clearTimeout(id: number) {
      const index = jobs.findIndex((job) => job.id === id);
      if (index >= 0) jobs.splice(index, 1);
    },
    runNext() {
      const job = jobs.shift();
      if (!job) throw new Error('没有待执行的定时器');
      job.fn();
      return job;
    },
    runAll() {
      while (jobs.length > 0) (jobs.shift() as Job).fn();
    },
  };
}

class FakeSocket {
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: {code?: number}) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  emit(payload: unknown) {
    this.onmessage?.({data: JSON.stringify(payload)});
  }

  emitRaw(data: string) {
    this.onmessage?.({data});
  }

  drop(code?: number) {
    this.onclose?.({code});
  }

  messages() {
    return this.sent.map((item) => JSON.parse(item));
  }
}

function harness(options: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const timers = fakeTimers();
  const states: {version: number; source: string}[] = [];
  const errors: {code: string; message: string}[] = [];
  const statuses: string[] = [];
  const client = createRoomSocket({
    roomId: 'room-1',
    token: 'token-abc',
    url: 'ws://127.0.0.1:8787/ws',
    createSocket: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onState: (room: any, source: string) => states.push({version: room.version, source}),
    onError: (error: any) => errors.push(error),
    onStatus: (status: string) => statuses.push(status),
    ...options,
  });
  return {client, sockets, timers, states, errors, statuses, socket: () => sockets[sockets.length - 1]};
}

test('订阅消息带令牌，令牌不进 URL', () => {
  const h = harness();
  h.client.start();
  assert.equal(h.sockets.length, 1);
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:8787/ws');
  assert.equal(h.sockets[0].url.includes('token-abc'), false);
  assert.deepEqual(h.sockets[0].sent, []);
  h.socket().open();
  assert.deepEqual(h.socket().messages(), [{type: 'subscribe', token: 'token-abc', roomId: 'room-1'}]);
  h.client.stop();
});

test('状态按版本单调应用：旧快照被丢弃，相同版本可重放', () => {
  const h = harness();
  h.client.start();
  h.socket().open();

  h.socket().emit({type: 'state', room: {id: 'room-1', version: 5, status: 'playing'}});
  h.socket().emit({type: 'state', room: {id: 'room-1', version: 4, status: 'waiting'}});
  h.socket().emit({type: 'state', room: {id: 'room-1', version: 5, status: 'playing'}});
  h.socket().emit({type: 'state', room: {id: 'room-1', version: 9, status: 'finished'}});

  assert.deepEqual(h.states, [
    {version: 5, source: 'socket'},
    {version: 5, source: 'socket'},
    {version: 9, source: 'socket'},
  ]);
  assert.equal(h.client.version, 9);
  assert.equal(h.client.room.version, 9);
  h.client.stop();
});

test('版本判定与消息解析的边界情况', () => {
  assert.equal(shouldApplyVersion(-1, {version: 0}), true);
  assert.equal(shouldApplyVersion(3, {version: 3}), true);
  assert.equal(shouldApplyVersion(3, {version: 2}), false);
  assert.equal(shouldApplyVersion(3, null), false);
  assert.equal(shouldApplyVersion(3, {version: '3'}), false);
  assert.equal(shouldApplyVersion(3, {}), false);

  assert.deepEqual(parseSocketMessage('{"type":"pong"}'), {type: 'pong'});
  assert.equal(parseSocketMessage('not json'), null);
  assert.equal(parseSocketMessage('[]'), null);
  assert.equal(parseSocketMessage({} as unknown as string), null);
});

test('心跳按固定间隔发送 ping，并能接受 pong', () => {
  const h = harness({pingIntervalMs: 20000});
  h.client.start();
  h.socket().open();
  assert.equal(h.timers.jobs.length, 1);
  assert.equal(h.timers.jobs[0].ms, 20000);
  h.timers.runNext();
  assert.deepEqual(h.socket().sent.slice(1), [JSON.stringify({type: 'ping'})]);
  h.socket().emit({type: 'pong'});
  assert.equal(h.errors.length, 0);
  assert.equal(h.timers.jobs.length, 1);
  h.client.stop();
  assert.equal(h.timers.jobs.length, 0);
});

test('服务端错误消息转交页面处理，不中断连接', () => {
  const h = harness();
  h.client.start();
  h.socket().open();
  h.socket().emit({type: 'error', error: {code: 'ROOM_LOCKED', message: '房间已锁定'}});
  assert.deepEqual(h.errors, [{code: 'ROOM_LOCKED', message: '房间已锁定'}]);
  assert.equal(h.client.isOpen, true);
  h.client.stop();
});

test('断线：回退 GET 房间 + 指数退避重连 + 重连后重新订阅', async () => {
  const fallback = {id: 'room-1', version: 6, status: 'playing'};
  const h = harness({fetchRoom: async () => fallback});
  h.client.start();
  h.socket().open();
  h.socket().emit({type: 'state', room: {id: 'room-1', version: 5}});

  h.socket().drop();
  assert.equal(h.client.status, 'offline');
  assert.deepEqual(h.statuses, ['connecting', 'open', 'offline']);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(h.states, [
    {version: 5, source: 'socket'},
    {version: 6, source: 'fallback'},
  ]);
  assert.equal(h.client.version, 6);

  assert.equal(h.timers.jobs[0].ms, BASE_BACKOFF_MS);
  h.timers.runNext();
  assert.equal(h.sockets.length, 2);
  h.socket().open();
  assert.deepEqual(h.socket().messages(), [{type: 'subscribe', token: 'token-abc', roomId: 'room-1'}]);
  assert.equal(h.client.status, 'open');
  h.client.stop();
});

test('连续失败时退避时间递增并封顶', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(1), 2000);
  assert.equal(backoffDelay(5), 15000);
  assert.equal(backoffDelay(20), MAX_BACKOFF_MS);
  assert.equal(backoffDelay(-3), BASE_BACKOFF_MS);

  const h = harness();
  h.client.start();
  h.socket().drop();
  assert.equal(h.timers.jobs[0].ms, 1000);
  h.timers.runNext();
  h.socket().drop();
  assert.equal(h.timers.jobs[0].ms, 2000);
  h.timers.runNext();
  h.socket().drop();
  assert.equal(h.timers.jobs[0].ms, 4000);
  h.client.stop();
});

test('回退请求失败只报错，不影响后续重连', async () => {
  const h = harness({
    fetchRoom: async () => {
      throw {code: 'UNAUTHORIZED', message: '登录已失效，请重新登录'};
    },
  });
  h.client.start();
  h.socket().open();
  h.socket().drop();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(h.errors, [{code: 'UNAUTHORIZED', message: '登录已失效，请重新登录'}]);
  assert.equal(h.timers.jobs[0].ms, 1000);
  h.client.stop();
});

test('关闭码策略：只有顶号与被移出房间是终止性的', () => {
  assert.deepEqual(TERMINAL_CLOSE_CODES, [4001, 4003]);
  assert.deepEqual(closeDecision(4001, {code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}), {
    terminal: true,
    code: 'SESSION_INVALIDATED',
    message: '您已在其他设备打开该房间',
  });
  // 没有错误消息时按关闭码给兜底文案，绝不显示成「正在重连」。
  assert.deepEqual(closeDecision(4001, null), {
    terminal: true,
    code: 'SESSION_INVALIDATED',
    message: '您已在其他设备打开该房间',
  });
  assert.deepEqual(closeDecision(4003, null), {terminal: true, code: 'FORBIDDEN', message: '您已不在该房间'});
  // 心跳超时（1001）、订阅超时（1008）、异常关闭（1006）都要继续重连。
  for (const code of [1000, 1001, 1006, 1008, 1009, undefined]) {
    assert.equal(closeDecision(code, {code: 'NETWORK', message: '连接异常'}).terminal, false, String(code));
  }
});

test('顶号关闭：停止重连、不做回退请求，把原因交给页面', async () => {
  let fallbackCalls = 0;
  const closed: {code: string; message: string}[] = [];
  const h = harness({
    fetchRoom: async () => {
      fallbackCalls += 1;
      return {id: 'room-1', version: 9};
    },
    onClosed: (decision: any) => closed.push(decision),
  });
  h.client.start();
  h.socket().open();
  h.socket().emit({type: 'error', error: {code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}});
  h.socket().drop(4001);

  assert.deepEqual(closed, [{terminal: true, code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}]);
  assert.equal(h.client.status, 'closed');
  assert.equal(h.client.closeReason.code, 'SESSION_INVALIDATED');
  assert.equal(h.client.isStopped, true);
  assert.equal(h.timers.jobs.length, 0, '终止性关闭不得安排重连');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fallbackCalls, 0, '已被请出房间就不要再请求房间接口（只会拿到 403）');
  assert.deepEqual(h.states, [], '不再应用任何状态');
});

test('被移出房间（4003）走同一条终止路径，普通断线照旧重连', () => {
  const removed: {code: string; message: string}[] = [];
  const h = harness({onClosed: (decision: any) => removed.push(decision)});
  h.client.start();
  h.socket().open();
  h.socket().drop(4003);
  assert.deepEqual(removed, [{terminal: true, code: 'FORBIDDEN', message: '您已不在该房间'}]);
  assert.equal(h.timers.jobs.length, 0);

  // 心跳关闭码不是终止性的：仍然走回退 + 重连。
  const beat = harness();
  beat.client.start();
  beat.socket().open();
  beat.socket().drop(1001);
  assert.equal(beat.client.closeReason, null);
  assert.equal(beat.client.status, 'offline');
  assert.equal(beat.timers.jobs[0].ms, BASE_BACKOFF_MS);
  beat.client.stop();
});

test('停止后不再重连，也不会再发状态', () => {
  const h = harness();
  h.client.start();
  h.socket().open();
  h.client.stop();
  assert.equal(h.client.status, 'closed');
  assert.equal(h.timers.jobs.length, 0);
  h.sockets[0].emit({type: 'state', room: {id: 'room-1', version: 2}});
  assert.deepEqual(h.states, []);
  assert.equal(h.client.send({type: 'ping'}), false);
});
