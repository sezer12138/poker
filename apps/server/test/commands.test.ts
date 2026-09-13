import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {finishMatch, startMatch, startTestServer} from './helpers.ts';
import type {Session, TestServer} from './helpers.ts';

async function command(server: TestServer, session: Session, roomId: string, body: Record<string, unknown>) {
  const view = await server.view(session, roomId);
  return server.command(session, roomId, {requestId: crypto.randomUUID(), expectedVersion: view.version, ...body});
}

describe('等待房间里的命令', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  it('准备状态会广播给其他成员', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 0);
    await server.join(second, created.code);

    const result = await command(server, second, created.id, {type: 'ready', ready: true});
    assert.equal(result.status, 200);
    const member = result.body.members.find((item: any) => item.userId === second.user.id);
    assert.equal(member.ready, true);

    const other = await server.view(host, created.id);
    assert.equal(other.members.find((item: any) => item.userId === second.user.id).ready, true);
  });

  it('人数不足时不能开始', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);
    const result = await command(server, host, created.id, {type: 'start'});
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'START_MIN_PLAYERS');
    assert.match(result.body.error.message, /至少需要 2 名玩家/);
  });

  it('有真人未准备时不能开始（房主也要确认披露）', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 0);
    await server.join(second, created.code);
    await command(server, second, created.id, {type: 'ready', ready: true});

    const result = await command(server, host, created.id, {type: 'start'});
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'NOT_READY');
    assert.match(result.body.error.message, /还有玩家未准备/);
  });

  it('非房主不能开始或添加机器人', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 0);
    await server.join(second, created.code);

    for (const body of [{type: 'start'}, {type: 'addBot'}, {type: 'restart'}]) {
      const result = await command(server, second, created.id, body);
      assert.equal(result.status, 403, `${body.type} 应被拒绝`);
      assert.equal(result.body.error.code, 'FORBIDDEN');
    }
  });

  it('可以添加与移除机器人，机器人始终已准备', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);

    const added = await command(server, host, created.id, {type: 'addBot'});
    assert.equal(added.status, 200);
    const bot = added.body.members.find((member: any) => member.bot);
    assert.equal(bot.ready, true);
    assert.equal(bot.seat, 1);

    const removed = await command(server, host, created.id, {type: 'removeBot', seat: 1});
    assert.equal(removed.status, 200);
    assert.equal(removed.body.members.length, 1);
  });

  it('9 人满座后不能再添加机器人', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 8);
    const result = await command(server, host, created.id, {type: 'addBot'});
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'ROOM_FULL');
  });

  it('已准备的真人不能被移除，房主也不能移除自己', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 0);
    await server.join(second, created.code);
    await command(server, second, created.id, {type: 'ready', ready: true});

    const blocked = await command(server, host, created.id, {type: 'removeBot', seat: 1});
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error.message, /已准备/);

    const self = await command(server, host, created.id, {type: 'removeBot', seat: 0});
    assert.equal(self.status, 403);

    const empty = await command(server, host, created.id, {type: 'removeBot', seat: 5});
    assert.equal(empty.status, 404);
  });

  it('未准备的真人可以被房主移除', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 0);
    await server.join(second, created.code);

    const result = await command(server, host, created.id, {type: 'removeBot', seat: 1});
    assert.equal(result.status, 200);
    assert.equal(result.body.members.length, 1);
  });

  it('开始后等待房间的命令被拒绝', async () => {
    const host = await server.guest('房主');
    const second = await server.guest('玩家2');
    const created = await server.createRoom(host, 1);
    await server.join(second, created.code);
    await startMatch(server, created.id, [host, second]);

    const addBot = await command(server, host, created.id, {type: 'addBot'});
    assert.equal(addBot.status, 403);
    assert.equal(addBot.body.error.code, 'ROOM_LOCKED');

    const ready = await command(server, host, created.id, {type: 'ready', ready: false});
    assert.equal(ready.status, 403);
  });

  it('版本冲突返回 409，并且不改变房间状态', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);
    const view = await server.view(host, created.id);

    const stale = await server.command(host, created.id, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version + 5,
      type: 'addBot',
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
    assert.match(stale.body.error.message, /请刷新后重试/);

    const unchanged = await server.view(host, created.id);
    assert.equal(unchanged.version, view.version);
    assert.equal(unchanged.members.length, 1);
  });

  it('每次成功命令都会递增版本号', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 0);
    const first = await command(server, host, created.id, {type: 'addBot'});
    const second = await command(server, host, created.id, {type: 'addBot'});
    assert.equal(second.body.version, first.body.version + 1);
  });

  it('比赛结束后可以重开一局并清空上一局数据', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 1);
    const second = await server.guest('玩家2');
    await server.join(second, created.code);
    await startMatch(server, created.id, [host, second]);

    const beforeFinish = await command(server, host, created.id, {type: 'restart'});
    assert.equal(beforeFinish.status, 403);
    assert.match(beforeFinish.body.error.message, /尚未结束/);

    // Drive the match to a finish by having every human fold whenever it is their turn.
    await finishMatch(server, created.id, [host, second]);

    const restarted = await command(server, host, created.id, {type: 'restart'});
    assert.equal(restarted.status, 200);
    assert.equal(restarted.body.status, 'waiting');
    assert.equal(restarted.body.hand, null);
    assert.equal(restarted.body.winner, null);
    assert.deepEqual(restarted.body.events, []);
    assert.equal(restarted.body.fairness, null, '重开一局后上一场的公平数据必须清空');
    // Waiting rooms still report the first hand's level, which is what the lobby shows.
    assert.deepEqual(restarted.body.blinds, [5, 10]);
    assert.deepEqual(restarted.body.nextBlinds, [10, 20]);
    assert.equal(restarted.body.handsToNextLevel, 10);
    // The tournament is gone, so every seat shows the same fresh starting stack.
    assert.deepEqual(restarted.body.members.map((member: any) => member.stack), [null, null, null]);
    assert.equal(restarted.body.members.find((member: any) => member.bot).ready, true);
    assert.equal(restarted.body.members.find((member: any) => !member.bot).ready, false);
  });
});
