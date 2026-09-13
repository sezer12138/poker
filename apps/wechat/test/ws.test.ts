/**
 * utils/ws.js 契约测试：令牌只经 subscribe 消息发送、状态按 version 单调应用、
 * state/error/pong 分派、心跳、断线重连与主动关闭。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoader,
  createTimers,
  createWx,
  type FakeSocketTask,
  type FakeTimers,
  type WxMock
} from './harness.ts';

interface WsError {
  code: string;
  message: string;
}

interface WsClient {
  connect(): void;
  close(): void;
  send(message: unknown): boolean;
  handleMessage(data: string): void;
  isOpen(): boolean;
  getVersion(): number;
}

interface CloseDecision {
  terminal: boolean;
  code: string;
  message: string;
}

interface WsModule {
  createClient(options: {
    roomId: string;
    token?: string;
    onState?(room: Record<string, unknown>): void;
    onError?(error: WsError): void;
    onStatus?(status: string): void;
    onOpen?(): void;
    onClose?(): void;
    onClosed?(decision: CloseDecision): void;
    onSubscribe?(): void;
    onPong?(): void;
  }): WsClient;
}

interface Context {
  wx: WxMock;
  timers: FakeTimers;
  ws: WsModule;
  states: Record<string, unknown>[];
  errors: WsError[];
  statuses: string[];
  closed: CloseDecision[];
  pongs: number;
}

function setup(wx: WxMock = createWx(), timers: FakeTimers = createTimers()): Context {
  const loader = createLoader({wx, timers});
  const context: Context = {
    wx,
    timers,
    ws: loader.load('utils/ws.js') as WsModule,
    states: [],
    errors: [],
    statuses: [],
    closed: [],
    pongs: 0
  };
  return context;
}

function open(context: Context, roomId = 'room-1'): {client: WsClient; socket: FakeSocketTask} {
  const client = context.ws.createClient({
    roomId,
    onState(room) {
      context.states.push(room);
    },
    onError(error) {
      context.errors.push(error);
    },
    onStatus(status) {
      context.statuses.push(status);
    },
    onClosed(decision) {
      context.closed.push(decision);
    },
    onPong() {
      context.pongs += 1;
    }
  });
  client.connect();
  const socket = context.wx.sockets[context.wx.sockets.length - 1]!;
  socket.emitOpen();
  return {client, socket};
}

function messages(socket: FakeSocketTask): Record<string, unknown>[] {
  return socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

test('连接使用 wsUrl，令牌不出现在 URL 中', () => {
  const wx = createWx();
  wx.storage.set('poker.token', 'secret-token');
  const context = setup(wx);
  const {client, socket} = open(context);

  assert.equal(socket.url, 'ws://127.0.0.1:8787/ws');
  assert.ok(!socket.url.includes('secret-token'), 'URL 不得携带令牌');
  assert.ok(!socket.url.includes('token'), 'URL 不得携带令牌字段');
  assert.equal(client.isOpen(), true);
  client.close();
});

test('open 后发送 subscribe，令牌在消息体中', () => {
  const wx = createWx();
  wx.storage.set('poker.token', 'secret-token');
  const context = setup(wx);

  const client = context.ws.createClient({roomId: 'room-9'});
  client.connect();
  const socket = context.wx.sockets[0]!;
  assert.deepStrictEqual(socket.sent, [], '未 open 前不发送任何消息');

  socket.emitOpen();
  assert.deepStrictEqual(messages(socket), [{type: 'subscribe', token: 'secret-token', roomId: 'room-9'}]);
  client.close();
});

test('心跳按间隔发送 ping 并接受 pong', () => {
  const context = setup();
  const {client, socket} = open(context);

  context.timers.tick(20000);
  assert.deepStrictEqual(messages(socket)[1], {type: 'ping'});
  context.timers.tick(20000);
  assert.equal(messages(socket).length, 3);

  socket.emitMessage(JSON.stringify({type: 'pong'}));
  assert.equal(context.pongs, 1);
  assert.equal(context.errors.length, 0, 'pong 不应产生错误');
  client.close();
});

test('state 按 version 单调应用，低版本被忽略', () => {
  const context = setup();
  const {client, socket} = open(context);

  socket.emitMessage(JSON.stringify({type: 'state', room: {id: 'room-1', version: 5}}));
  assert.equal(context.states.length, 1);
  assert.equal(client.getVersion(), 5);

  socket.emitMessage(JSON.stringify({type: 'state', room: {id: 'room-1', version: 4}}));
  assert.equal(context.states.length, 1, '低版本状态必须忽略');

  socket.emitMessage(JSON.stringify({type: 'state', room: {id: 'room-1', version: 5}}));
  assert.equal(context.states.length, 2, '相同版本可重复应用');

  socket.emitMessage(JSON.stringify({type: 'state', room: {id: 'room-1', version: 6}}));
  assert.equal(context.states.length, 3);
  assert.equal(context.states[2]!.version, 6);
  client.close();
});

test('error 消息转成 {code,message}，畸形消息被忽略', () => {
  const context = setup();
  const {client, socket} = open(context);

  assert.doesNotThrow(() => socket.emitMessage('not-json'));
  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({type: 'state'})));
  assert.doesNotThrow(() => socket.emitMessage(JSON.stringify({type: 'state', room: {version: 'x'}})));
  assert.equal(context.states.length, 0);
  assert.equal(context.errors.length, 0);

  socket.emitMessage(JSON.stringify({type: 'error', error: {code: 'ROOM_LOCKED', message: '房间已锁定'}}));
  assert.deepStrictEqual(context.errors, [{code: 'ROOM_LOCKED', message: '房间已锁定'}]);

  socket.emitMessage(JSON.stringify({type: 'error'}));
  assert.equal(context.errors.length, 2);
  assert.equal(context.errors[1]!.code, 'WS_ERROR');
  client.close();
});

test('主动 close 停止心跳且不再重连（对应 onHide）', () => {
  const context = setup();
  const {client, socket} = open(context);
  context.timers.tick(20000);
  const sentBefore = socket.sent.length;

  client.close();
  assert.equal(socket.closed, true);
  assert.equal(client.isOpen(), false);
  assert.equal(context.timers.pending(), 0, '主动关闭后不得保留重连定时器');

  context.timers.tick(120000);
  assert.equal(socket.sent.length, sentBefore);
  assert.equal(context.wx.sockets.length, 1);
});

test('意外断线后自动重连并重新订阅（对应 onShow 恢复）', () => {
  const wx = createWx();
  wx.storage.set('poker.token', 'secret-token');
  const context = setup(wx);
  const {client, socket} = open(context);
  assert.equal(context.wx.sockets.length, 1);

  socket.emitClose();
  assert.ok(context.statuses.includes('closed'));
  assert.equal(context.timers.pending(), 1, '断线后应安排一次重连');

  context.timers.tick(1000);
  assert.equal(wx.sockets.length, 2);
  const reconnected = wx.sockets[1]!;
  assert.equal(reconnected.url, 'ws://127.0.0.1:8787/ws');
  reconnected.emitOpen();
  assert.deepStrictEqual(messages(reconnected), [{type: 'subscribe', token: 'secret-token', roomId: 'room-1'}]);
  client.close();
  assert.equal(context.timers.pending(), 0);
});

test('顶号关闭（4001）停止重连，并把服务端原因交给页面', () => {
  const context = setup();
  const {client, socket} = open(context);

  // 服务端关闭前会先发一条 error 消息，客户端拿它当关闭原因。
  socket.emitMessage(
    JSON.stringify({type: 'error', error: {code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}})
  );
  socket.emitClose(4001, 'replaced');

  assert.deepStrictEqual(context.closed, [
    {terminal: true, code: 'SESSION_INVALIDATED', message: '您已在其他设备打开该房间'}
  ]);
  assert.equal(context.timers.pending(), 0, '终止性关闭不得留下重连定时器');
  context.timers.tick(120000);
  assert.equal(context.wx.sockets.length, 1, '不再创建新连接');
  client.close();
});

test('被移出房间（4003）同样不再重连，没有错误消息时给兜底中文原因', () => {
  const context = setup();
  const {client, socket} = open(context);

  socket.emitClose(4003);

  assert.deepStrictEqual(context.closed, [{terminal: true, code: 'FORBIDDEN', message: '您已不在该房间'}]);
  assert.equal(context.timers.pending(), 0);
  client.close();
});

test('心跳与订阅超时的关闭码不是终止性关闭，仍按退避重连', () => {
  for (const code of [1001, 1008, 1006]) {
    const context = setup();
    const {client, socket} = open(context);
    socket.emitClose(code);
    assert.deepStrictEqual(context.closed, [], `关闭码 ${code} 不该走终止路径`);
    assert.equal(context.timers.pending(), 1, `关闭码 ${code} 应安排重连`);
    client.close();
  }
});

test('重连次数达到上限后停止并上报失败', () => {
  const context = setup();
  const {client} = open(context);

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const socket = context.wx.sockets[context.wx.sockets.length - 1]!;
    socket.emitClose();
    context.timers.tick(60000);
  }

  assert.ok(context.statuses.includes('failed'));
  assert.equal(context.timers.pending(), 0);
  assert.equal(context.wx.sockets.length, 6, '重连次数受上限约束');
  client.close();
});

test('重复 connect 不会创建第二条连接', () => {
  const context = setup();
  const {client} = open(context);
  client.connect();
  client.connect();
  assert.equal(context.wx.sockets.length, 1);
  client.close();
});

test('connectSocket 抛错时上报错误并安排重连，不向外抛异常', () => {
  const wx = createWx();
  wx.connectSocket = () => {
    throw new Error('connectSocket:fail');
  };
  const context = setup(wx);
  const client = context.ws.createClient({
    roomId: 'room-1',
    onError(error) {
      context.errors.push(error);
    },
    onStatus(status) {
      context.statuses.push(status);
    }
  });
  assert.doesNotThrow(() => client.connect());
  assert.equal(context.errors.length, 1);
  assert.equal(context.errors[0]!.message, '无法建立连接');
  assert.equal(context.timers.pending(), 1, '失败后应有一次重连计划');
  client.close();
  assert.equal(context.timers.pending(), 0);
});

test('未连接时 send 返回 false 且不抛错', () => {
  const context = setup();
  const client = context.ws.createClient({roomId: 'room-1'});
  assert.equal(client.send({type: 'ping'}), false);
  assert.equal(client.connect(), undefined);
  context.wx.sockets[0]!.emitOpen();
  assert.equal(client.send({type: 'ping'}), true);
  client.close();
});
