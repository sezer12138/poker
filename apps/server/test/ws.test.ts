import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  contributeAll,
  openSocket,
  readyRoom,
  startMatch,
  startTestServer,
  waitFor,
  withTimeout,
} from './helpers.ts';
import type {TestClient, TestServer} from './helpers.ts';

/** Every room state this connection has been sent, oldest first. */
function states(client: TestClient): any[] {
  return client.messages.filter(message => message.type === 'state').map(message => message.room);
}

/** Waits for a push beyond the ones already seen and returns it. */
async function push(client: TestClient, seen: number): Promise<any> {
  await waitFor(() => states(client).length > seen, '状态推送');
  return states(client).at(-1);
}

function errors(client: TestClient): any[] {
  return client.messages.filter(message => message.type === 'error').map(message => message.error);
}

describe('WebSocket 订阅与广播', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  it('订阅后立刻收到当前状态，且只有接收者自己的底牌', async () => {
    const {roomId, players} = await readyRoom(server);
    await startMatch(server, roomId, players);
    await contributeAll(server, roomId, players);

    for (const player of players) {
      const client = await server.connect(player, roomId);
      const message = await withTimeout(client.next('state'), '首帧状态');
      const room = message.room;
      assert.equal(room.id, roomId);
      assert.equal(room.you.userId, player.user.id);
      assert.notEqual(room.hand, null, '开局后订阅应直接拿到进行中的牌局');
      const own = room.hand.players.find((seat: any) => seat.seat === room.you.seat);
      assert.equal(own.hole.length, 2, '本人应该看见自己的两张底牌');
      for (const seat of room.hand.players) {
        if (seat.seat === room.you.seat) continue;
        assert.deepEqual(seat.hole, [], '别人的底牌绝不能进这条连接');
      }
    }
  });

  it('房间里的命令推送给每个订阅者，且每人拿到自己的视图', async () => {
    const {roomId, host, players} = await readyRoom(server);
    const hostClient = await server.connect(host, roomId);
    const guestClient = await server.connect(players[1]!, roomId);
    await withTimeout(hostClient.next('state'), '房主首帧');
    await withTimeout(guestClient.next('state'), '玩家首帧');
    const seenHost = states(hostClient).length;
    const seenGuest = states(guestClient).length;

    const view = await server.view(host, roomId);
    const result = await server.command(host, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'ready',
      ready: true,
    });
    assert.equal(result.status, 200);

    const pushedHost = await push(hostClient, seenHost);
    const pushedGuest = await push(guestClient, seenGuest);
    assert.equal(pushedHost.version, result.body.version, '推送必须与响应同一版本');
    assert.equal(pushedGuest.version, result.body.version);
    assert.equal(pushedHost.members.find((member: any) => member.userId === host.user.id).ready, true);
    assert.equal(pushedGuest.members.find((member: any) => member.userId === host.user.id).ready, true);
    // The two payloads really are two views, not one shared object.
    assert.equal(pushedHost.you.userId, host.user.id);
    assert.equal(pushedGuest.you.userId, players[1]!.user.id);
  });

  it('非成员订阅被拒绝，连接不会被顺手断掉', async () => {
    const {roomId} = await readyRoom(server);
    const outsider = await server.guest('路人');
    const client = await server.connect(outsider, roomId);

    const error = await withTimeout(client.next('error'), '拒绝消息');
    assert.equal(error.error.code, 'FORBIDDEN');
    assert.match(error.error.message, /成员/);
    assert.equal(client.raw.readyState, WebSocket.OPEN);
    assert.deepEqual(states(client), [], '被拒的连接拿不到任何房间数据');
  });

  it('token 失效时报错并以 4001 关闭', async () => {
    const {roomId} = await readyRoom(server);
    const client = await openSocket(server.wsUrl);
    try {
      client.send({type: 'subscribe', token: 'not-a-token', roomId});
      const error = await withTimeout(client.next('error'), '未授权消息');
      assert.equal(error.error.code, 'UNAUTHORIZED');
      assert.match(error.error.message, /登录已失效/);
      const closed = await withTimeout(client.closed(), '关闭帧');
      assert.equal(closed.code, 4001);
    } finally {
      client.close();
    }
  });

  it('同一用户在同一房间开新连接会顶掉旧连接', async () => {
    const {roomId, host} = await readyRoom(server);
    const stale = await server.connect(host, roomId);
    await withTimeout(stale.next('state'), '旧连接首帧');
    const fresh = await server.connect(host, roomId);
    await withTimeout(fresh.next('state'), '新连接首帧');

    const error = await withTimeout(stale.next('error'), '顶号消息');
    assert.equal(error.error.code, 'SESSION_INVALIDATED');
    assert.match(error.error.message, /其他设备/);
    const closed = await withTimeout(stale.closed(), '顶号关闭');
    assert.equal(closed.code, 4001);

    // The surviving connection keeps receiving pushes.
    const seen = states(fresh).length;
    const view = await server.view(host, roomId);
    await server.command(host, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'ready',
      ready: true,
    });
    assert.equal((await push(fresh, seen)).version, view.version + 1);
  });

  it('离开房间后连接被服务端收走', async () => {
    const {roomId, players} = await readyRoom(server);
    const guest = players[1]!;
    const client = await server.connect(guest, roomId);
    await withTimeout(client.next('state'), '首帧状态');

    const view = await server.view(guest, roomId);
    const left = await server.command(guest, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'leave',
    });
    assert.equal(left.status, 200, JSON.stringify(left.body));

    const error = await withTimeout(client.next('error'), '踢出消息');
    assert.equal(error.error.code, 'FORBIDDEN');
    assert.match(error.error.message, /不在该房间/);
    const closed = await withTimeout(client.closed(), '踢出关闭');
    assert.equal(closed.code, 4003);
    assert.equal(server.app.hub.countIn(roomId), 0);
  });

  it('断线重连后补上当前状态', async () => {
    const {roomId, host} = await readyRoom(server);
    const first = await server.connect(host, roomId);
    const initial = await withTimeout(first.next('state'), '首帧状态');

    first.close();
    await waitFor(() => server.app.hub.countIn(roomId) === 0, '连接移除');

    const again = await server.connect(host, roomId);
    const resumed = await withTimeout(again.next('state'), '重连首帧');
    // `next('state')` 给的是整条消息，房间视图在 message.room 上。
    assert.equal(resumed.room.id, roomId);
    assert.equal(resumed.room.version, initial.room.version, '没人操作过，版本不该变');
    assert.equal(resumed.room.you.userId, host.user.id, '重连要认出同一个人');
  });

  it('应用层 ping 得到 pong，坏消息只回 BAD_MESSAGE 且不断连接', async () => {
    const {roomId, host} = await readyRoom(server);
    const client = await server.connect(host, roomId);
    await withTimeout(client.next('state'), '首帧状态');

    client.send({type: 'ping'});
    assert.equal((await withTimeout(client.next('pong'), 'pong')).type, 'pong');

    const bad = ['not json', '[]', '{"type":"unknown"}', '{"type":"subscribe","token":"only-token"}', '"text"'];
    for (const text of bad) {
      const before = errors(client).length;
      client.raw.send(text);
      await waitFor(() => errors(client).length > before, '错误消息');
      assert.equal(errors(client).at(-1).code, 'BAD_MESSAGE', text);
      assert.ok(errors(client).at(-1).message.length > 0, '错误必须带中文说明');
    }
    assert.equal(client.raw.readyState, WebSocket.OPEN, '坏消息不该断开连接');
  });
});

describe('WebSocket 超时与心跳', () => {
  it('迟迟不订阅的连接会被关掉', async () => {
    const slow = await startTestServer({}, {storage: 'memory', subscribeTimeoutMs: 100});
    try {
      const client = await openSocket(slow.wsUrl);
      await slow.clock.advance(100);
      const closed = await withTimeout(client.closed(), '订阅超时关闭');
      assert.equal(closed.code, 1008);
    } finally {
      await slow.close();
    }
  });

  it('有往来的连接不会被心跳误踢', async () => {
    const beat = await startTestServer({}, {storage: 'memory', heartbeatMs: 1000});
    try {
      const {roomId, host} = await readyRoom(beat);
      const client = await beat.connect(host, roomId);
      await withTimeout(client.next('state'), '首帧状态');

      const pongs = (): number => client.messages.filter(message => message.type === 'pong').length;
      // Ten times the pong timeout, always answering: the server must keep the socket.
      for (let index = 0; index < 70; index++) {
        client.send({type: 'ping'});
        await waitFor(() => pongs() > index, '心跳应答');
        await beat.clock.advance(1000);
      }
      assert.equal(client.raw.readyState, WebSocket.OPEN, '活着的连接不能被心跳关掉');
      assert.equal(beat.app.hub.countIn(roomId), 1);
    } finally {
      await beat.close();
    }
  });
});
