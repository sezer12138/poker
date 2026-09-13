import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readyRoom, startMatch, startTestServer} from './helpers.ts';
import type {TestServer} from './helpers.ts';

describe('房间生命周期与成员权限', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });

  it('创建房间：房主坐 0 号位，机器人依次入座', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 3);
    assert.equal(created.members.length, 4);
    assert.deepEqual(
      created.members.map((member: any) => [member.seat, member.bot, member.name]),
      [
        [0, false, '房主'],
        [1, true, '机器人1'],
        [2, true, '机器人2'],
        [3, true, '机器人3'],
      ],
    );
    assert.equal(created.hostId, host.user.id);
    assert.match(created.code, /^[0-9A-HJ-NP-Z]{6}$/);
    assert.match(created.invite, /^[0-9a-f]{32}$/);
    assert.equal(created.status, 'waiting');
  });

  it('机器人数量超范围时拒绝', async () => {
    const host = await server.guest('房主');
    for (const bots of [-1, 9, 2.5, 'two']) {
      const result = await server.call('/api/rooms', {token: host.token, body: {bots}});
      assert.equal(result.status, 400, `bots=${bots} 应被拒绝`);
    }
  });

  it('非成员不能读取房间，成员可以', async () => {
    const host = await server.guest('房主');
    const outsider = await server.guest('路人');
    const created = await server.createRoom(host, 0);

    const denied = await server.call(`/api/rooms/${created.id}`, {token: outsider.token});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');

    const allowed = await server.call(`/api/rooms/${created.id}`, {token: host.token});
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.you.seat, 0);
    assert.equal(allowed.body.you.isHost, true);
  });

  it('房间号或邀请链接均可加入', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);

    const byCode = await server.guest('按号加入');
    const joined = await server.join(byCode, created.code);
    assert.equal(joined.status, 200);
    assert.equal(joined.body.members.length, 2);

    const byInvite = await server.guest('按链加入');
    const invited = await server.call('/api/rooms/join', {token: byInvite.token, body: {invite: created.invite}});
    assert.equal(invited.status, 200);
    assert.equal(invited.body.you.seat, 2);
  });

  it('同一用户重复加入不会重复占座', async () => {
    const {roomId, host} = await readyRoom(server);
    const before = (await server.view(host, roomId)).members.length;
    const again = await server.join(host, (await server.view(host, roomId)).code);
    assert.equal(again.status, 200);
    assert.equal(again.body.members.length, before);
  });

  it('错误房间号会限速', async () => {
    const user = await server.guest('试号的人');
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await server.join(user, 'ZZZZZZ');
      assert.equal(result.status, 404, `第 ${attempt + 1} 次应是 404`);
    }
    const limited = await server.join(user, 'ZZZZZZ');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
  });

  it('房间满员时拒绝加入', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 8);
    assert.equal(created.members.length, 9);
    const late = await server.guest('来晚的人');
    const result = await server.join(late, created.code);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'ROOM_FULL');
  });

  it('比赛进行中禁止新玩家加入，但原成员可重连', async () => {
    const host = await server.guest('房主');
    const guest = await server.guest('玩家2');
    const created = await server.createRoom(host, 1);
    await server.join(guest, created.code);
    await startMatch(server, created.id, [host, guest]);

    const outsider = await server.guest('后来的');
    const blocked = await server.join(outsider, created.code);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'ROOM_LOCKED');

    const rejoin = await server.join(host, created.code);
    assert.equal(rejoin.status, 200);
    assert.equal(rejoin.body.you.seat, 0);
  });

  it('房主离开后自动转交，最后一名真人离开后房间关闭', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 1);
    await server.join(second, created.code);

    const hostView = await server.view(host, created.id);
    const left = await server.command(host, created.id, {
      requestId: crypto.randomUUID(),
      expectedVersion: hostView.version,
      type: 'leave',
    });
    assert.equal(left.status, 200);
    assert.equal(left.body.hostId, second.user.id);
    assert.equal(left.body.members.some((member: any) => member.name === '房主'), false);

    const secondView = await server.view(second, created.id);
    const gone = await server.command(second, created.id, {
      requestId: crypto.randomUUID(),
      expectedVersion: secondView.version,
      type: 'leave',
    });
    assert.equal(gone.status, 200);
    // Only a bot is left, so the room is retired instead of running forever.
    const after = await server.call(`/api/rooms/${created.id}`, {token: host.token});
    assert.equal(after.status, 404);
  });

  it('比赛进行中不能离开', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 1);
    await server.join(second, created.code);
    await startMatch(server, created.id, [host, second]);

    const view = await server.view(host, created.id);
    const result = await server.command(host, created.id, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'leave',
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'ROOM_LOCKED');
  });

  it('非成员无法读取或提交命令', async () => {
    const host = await server.guest('房主');
    const outsider = await server.guest('路人');
    const created = await server.createRoom(host, 1);

    const read = await server.call(`/api/rooms/${created.id}`, {token: outsider.token});
    assert.equal(read.status, 403);

    const command = await server.command(outsider, created.id, {
      requestId: crypto.randomUUID(),
      type: 'addBot',
    });
    assert.equal(command.status, 403);
    assert.equal(command.body.error.code, 'FORBIDDEN');
  });

  it('不存在的房间返回 404', async () => {
    const host = await server.guest('房主');
    const result = await server.call('/api/rooms/00000000-0000-4000-8000-000000000000', {token: host.token});
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  });

  it('requestId 不合法时拒绝', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);
    for (const requestId of [undefined, '', 'not a uuid!', 42]) {
      const result = await server.command(host, created.id, {requestId, type: 'addBot'});
      assert.equal(result.status, 400, `requestId=${String(requestId)} 应被拒绝`);
    }
  });

  it('未知命令类型被拒绝', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);
    const result = await server.command(host, created.id, {requestId: crypto.randomUUID(), type: 'explode'});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_INPUT');
  });

  it('未登录无法操作', async () => {
    const result = await server.call('/api/rooms', {body: {bots: 0}});
    assert.equal(result.status, 401);
  });

  it('路径里的百分号编码解不开时返回 400，而不是 500', async () => {
    const malformed = await server.call('/api/rooms/%zz');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'INVALID_INPUT');

    // 合法编码照旧解码：这条路径指向一个不存在的房间，说明解码没有被一刀切掉。
    const guest = await server.guest('路人');
    const encoded = await server.call('/api/rooms/%41', {token: guest.token});
    assert.equal(encoded.status, 404);
  });
});
