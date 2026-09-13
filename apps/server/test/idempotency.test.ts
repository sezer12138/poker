import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readyRoom, startMatch, startTestServer, waitFor} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {IDEMPOTENCY_CAP, IDEMPOTENCY_MAX_BYTES} from '../src/config.ts';

describe('命令幂等', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  it('重放同一 requestId 逐字返回首次响应，且只生效一次', async () => {
    const {roomId, host} = await readyRoom(server);
    const view = await server.view(host, roomId);
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'ready',
      ready: true,
    };

    const first = await server.command(host, roomId, body);
    assert.equal(first.status, 200);
    const version = first.body.version;

    const replay = await server.command(host, roomId, body);
    assert.equal(replay.status, 200);
    assert.equal(JSON.stringify(replay.body), JSON.stringify(first.body), '重放必须逐字一致');

    const now = await server.view(host, roomId);
    assert.equal(now.version, version, '重放不推进版本号');
    assert.equal(now.members.filter((member: any) => member.ready).length, 1);
  });

  it('幂等检查优先于版本检查：过期版本的重放仍然返回原响应', async () => {
    const {roomId, host} = await readyRoom(server);
    const view = await server.view(host, roomId);
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'ready',
      ready: true,
    };
    const first = await server.command(host, roomId, body);
    assert.equal(first.status, 200);

    // Another command moves the room on, so the original expectedVersion is now stale.
    const other = await server.command(host, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: first.body.version,
      type: 'ready',
      ready: false,
    });
    assert.equal(other.status, 200);

    const replay = await server.command(host, roomId, body);
    assert.equal(replay.status, 200, '重放不应被版本检查拦下');
    assert.equal(replay.body.version, first.body.version);
  });

  it('幂等记录绑定发起者：别人拿同一 requestId 也拿不到我的视图', async () => {
    const {roomId, players} = await readyRoom(server, {bots: 1});
    await startMatch(server, roomId, players);
    const alice = players[0]!;
    const bob = players[1]!;
    const view = await server.view(alice, roomId);
    const aliceSeat = view.viewerSeat as number;
    const bobSeat = (await server.view(bob, roomId)).viewerSeat as number;
    const requestId = crypto.randomUUID();

    const mine = await server.command(alice, roomId, {
      requestId,
      type: 'contribute',
      nonce: 'ab'.repeat(32),
      handNo: view.fairness.handNo,
    });
    assert.equal(mine.status, 200);
    assert.equal(
      server.coordinator.get(roomId)!.idempotency.find(([id]) => id === requestId)?.[1].userId,
      alice.user.id,
      '记录里必须留下发起者，否则无从判断该不该回放',
    );

    // Bob 拿着 Alice 的 requestId 发自己的命令：要么按自己的身份执行，要么报错，
    // 但绝不能把 Alice 的视图（含她的底牌）当成响应返回。
    const forged = await server.command(bob, roomId, {
      requestId,
      type: 'contribute',
      nonce: 'cd'.repeat(32),
      handNo: view.fairness.handNo,
    });
    assert.notEqual(forged.body?.viewerId, alice.user.id, '响应不能是别人的视角');
    assert.equal(forged.body?.viewerId, bob.user.id);
    assert.equal(forged.body?.viewerSeat, bobSeat);

    // 贡献齐了就发牌，Bob 再看一次自己收到的视图：Alice 的底牌必须仍是空的。
    await waitFor(() => server.coordinator.get(roomId)?.fairnessStage?.stage !== 'collecting', '发牌');
    const bobView = await server.view(bob, roomId);
    assert.equal(bobView.hand.players.find((player: any) => player.seat === aliceSeat).hole.length, 0);
    assert.equal(bobView.hand.players.find((player: any) => player.seat === bobSeat).hole.length, 2);
  });

  it('对不存在的房间发命令返回 404，与 GET 的口径一致', async () => {
    const ghost = await server.guest('路过');
    const result = await server.command(ghost, crypto.randomUUID(), {
      requestId: crypto.randomUUID(),
      type: 'ready',
      ready: true,
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, 'NOT_FOUND');
  });

  it('不同 requestId 的命令各自生效', async () => {
    const {roomId, host} = await readyRoom(server);
    const before = await server.view(host, roomId);

    for (let index = 0; index < 3; index++) {
      const view = await server.view(host, roomId);
      const result = await server.command(host, roomId, {
        requestId: crypto.randomUUID(),
        expectedVersion: view.version,
        type: 'addBot',
      });
      assert.equal(result.status, 200);
    }
    const after = await server.view(host, roomId);
    assert.equal(after.members.length, before.members.length + 3);
  });

  it('幂等记录受条数与体积双重限制，超出的按最旧逐出', async () => {
    const {roomId, host} = await readyRoom(server);
    const requestIds: string[] = [];
    let lastVersion = 0;

    for (let index = 0; index < 201; index++) {
      const view = await server.view(host, roomId);
      const requestId = crypto.randomUUID();
      requestIds.push(requestId);
      const result = await server.command(host, roomId, {
        requestId,
        expectedVersion: view.version,
        type: 'ready',
        ready: index % 2 === 0,
      });
      assert.equal(result.status, 200);
      lastVersion = result.body.version;
    }

    // The newest record still replays verbatim.
    const newest = await server.command(host, roomId, {
      requestId: requestIds[200]!,
      type: 'ready',
      ready: true,
    });
    assert.equal(newest.status, 200);
    assert.equal(newest.body.version, lastVersion);

    // The oldest was evicted, so it is treated as a brand new command and applies again.
    const oldest = await server.command(host, roomId, {
      requestId: requestIds[0]!,
      type: 'ready',
      ready: true,
    });
    assert.equal(oldest.status, 200);
    assert.equal(oldest.body.version, lastVersion + 1, '超窗的 requestId 视为新命令');

    const capped = server.coordinator.get(roomId)!;
    assert.ok(capped.idempotency.length <= IDEMPOTENCY_CAP, '条数上限');
    const bytes = capped.idempotency.reduce((total, [, record]) => total + record.viewJson.length, 0);
    assert.ok(bytes <= IDEMPOTENCY_MAX_BYTES, `体积上限，实际 ${bytes}`);
    assert.ok(capped.idempotency.length > 0, '至少保留最近一条');
  });

  it('被拒绝的命令不写入幂等记录，修正后可用同一 requestId 重试', async () => {
    const {roomId, host} = await readyRoom(server);
    const view = await server.view(host, roomId);
    const requestId = crypto.randomUUID();

    const rejected = await server.command(host, roomId, {
      requestId,
      expectedVersion: view.version + 10,
      type: 'addBot',
    });
    assert.equal(rejected.status, 409);

    const retry = await server.command(host, roomId, {
      requestId,
      expectedVersion: view.version,
      type: 'addBot',
    });
    assert.equal(retry.status, 200, '失败的命令不占用 requestId');
    assert.equal(retry.body.members.some((member: any) => member.bot), true);
  });

  it('比赛开始后的命令依旧按 requestId 幂等', async () => {
    const {roomId, players} = await readyRoom(server, {bots: 1});
    await startMatch(server, roomId, players);
    const view = await server.view(players[0]!, roomId);
    const handNo = view.fairness.handNo;
    const body = {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'contribute',
      nonce: 'ab'.repeat(32),
      handNo,
    };

    const first = await server.command(players[0]!, roomId, body);
    assert.equal(first.status, 200);
    const replay = await server.command(players[0]!, roomId, body);
    assert.equal(replay.status, 200);
    assert.equal(JSON.stringify(replay.body), JSON.stringify(first.body));

    // Applied exactly once: one nonce in the round, and the round is still open.
    const stage = server.coordinator.get(roomId)!.fairnessStage!;
    const seat = stage.round.contributions;
    assert.deepEqual(Object.values(seat), ['ab'.repeat(32)]);
    assert.equal(stage.round.deckCommitment, null, '重放不应提前封盘');
    assert.equal(stage.stage, 'collecting');
  });
});
