import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {advanceMatch, contributeAll, readyRoom, startMatch, startTestServer, FOLD_ALWAYS} from './helpers.ts';
import type {TestServer} from './helpers.ts';

/**
 * 客户端契约：网页与小程序两个客户端都按 docs/product/contract.md 的字段名读数据，
 * 服务端实现曾经走的是另一套写法（{room} 包装、viewerSeat 缺失、blinds 是对象、
 * fairness 恒为对象、核验里只有 hands），结果两个客户端都进不了房间。
 *
 * 这一组用例把「客户端实际读的字段」钉死，避免服务端单方面改形状。
 */
describe('客户端契约字段', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  it('房间接口直接返回视图，不再包一层 {room}', async () => {
    const {roomId, host, players} = await readyRoom(server);

    const created = await server.createRoom(host, 0);
    assert.equal(typeof created.id, 'string', '创建房间的响应本身就是 RoomView');
    assert.equal(created.code.length, 6);

    const joined = await server.join(players[1]!, created.code);
    assert.equal(joined.status, 200);
    assert.equal(joined.body.id, created.id, '加入房间同样直接给视图');

    const fetched = await server.view(host, roomId);
    assert.equal(fetched.id, roomId);
    assert.equal(typeof fetched.version, 'number');
  });

  it('等待房间给出身份、盲注元组与升盲信息', async () => {
    const {roomId, host} = await readyRoom(server);
    const view = await server.view(host, roomId);

    assert.equal(view.viewerId, host.user.id);
    assert.equal(view.viewerSeat, 0, '房主坐 0 号位');
    assert.deepEqual(view.blinds, [5, 10], 'blinds 必须是 [小盲, 大盲] 元组');
    assert.deepEqual(view.nextBlinds, [10, 20]);
    assert.equal(view.handsToNextLevel, 10);
    assert.equal(view.fairness, null, '未开赛时为 null，客户端据此显示占位文案');
    assert.equal(view.deadline, null);
    assert.equal(view.nextHandAt, null);
    assert.equal(view.hand, null);
    assert.equal(typeof view.serverTime, 'number', '倒计时要靠 serverTime 校正客户端时钟');
  });

  it('开赛后 fairness 变成对象，倒计时与贡献窗口都在里面', async () => {
    const {roomId, host, players} = await readyRoom(server);
    await startMatch(server, roomId, players);

    const view = await server.view(host, roomId);
    assert.equal(view.status, 'playing');
    assert.ok(view.fairness !== null, '开赛后必须有公平数据');
    assert.equal(view.fairness.handNo, 1);
    assert.match(view.fairness.commitment, /^[0-9a-f]{64}$/);
    assert.equal(view.fairness.deckCommitment, null, '还没收齐贡献时不能有牌序承诺');
    assert.equal(typeof view.fairness.deadline, 'number', '5 秒贡献窗口的截止时间');
    assert.equal(view.fairness.owed, true, '本人还没提交贡献');

    await contributeAll(server, roomId, players);
    const dealt = await server.view(host, roomId);
    assert.ok(dealt.hand !== null);
    assert.equal(typeof dealt.deadline, 'number', '行动倒计时的截止时间在顶层 deadline');
    assert.ok(dealt.deadline > dealt.serverTime);
    assert.equal(dealt.fairness.owed, false);
    assert.match(dealt.fairness.deckCommitment!, /^[0-9a-f]{64}$/);
  });

  it('非成员拿不到房间，成员拿到的座位只属于自己', async () => {
    const {roomId, host, players} = await readyRoom(server);
    await startMatch(server, roomId, players);

    // 房间视图里带 viewerId/viewerSeat，所以「谁能看到什么」必须按身份算：
    // 非成员直接 403，不会被当成没座位的观战者放进来。
    const outsider = await server.guest('路人');
    const denied = await server.call(`/api/rooms/${roomId}`, {token: outsider.token});
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');

    const hostView = await server.view(host, roomId);
    assert.equal(hostView.viewerSeat, 0);
    const otherView = await server.view(players[1]!, roomId);
    assert.equal(otherView.viewerSeat, 1);
    assert.equal(otherView.viewerId, players[1]!.user.id);
  });

  it('结算后 nextHandAt 给出下一手时间，并保留上一手的承诺', async () => {
    const {roomId, host, players} = await readyRoom(server);
    await startMatch(server, roomId, players);
    await contributeAll(server, roomId, players);
    // `maxHands` 是「还没打完就报错」的上限，不能用它停在第一手；这里用 until。
    await advanceMatch(server, roomId, players, {
      policy: FOLD_ALWAYS,
      until: view => view.completedHands >= 1,
    });

    const view = await server.view(host, roomId);
    assert.equal(view.completedHands >= 1, true);
    assert.ok(view.fairness !== null);
    assert.equal(view.fairness.history.length >= 1, true, '上一手的承诺要留在视图里供核对');
    if (view.status !== 'finished') {
      assert.equal(typeof view.nextHandAt, 'number', '结算展示期间给出下一手时间');
    }
  });

  it('核验响应直接给出 rounds 与 verification', async () => {
    const {roomId, host, players} = await readyRoom(server);
    await startMatch(server, roomId, players);
    await advanceMatch(server, roomId, players, {policy: FOLD_ALWAYS});

    const result = await server.audit(host, roomId);
    assert.equal(result.status, 200);
    const audit = result.body;
    assert.equal(typeof audit.matchId, 'string');
    assert.equal(Array.isArray(audit.rounds), true, '客户端按 rounds 复算牌序');
    assert.equal(audit.rounds.length, audit.completedHands);
    assert.equal(typeof audit.verification.valid, 'boolean');
    assert.equal(Array.isArray(audit.verification.errors), true);
    assert.equal(Array.isArray(audit.events), true);
    for (const round of audit.rounds) {
      assert.equal(typeof round.matchId, 'string');
      assert.equal(Array.isArray(round.seats), true);
      assert.equal(Array.isArray(round.contributions), false, '贡献是 {座位: nonce} 对象');
    }
  });
});
