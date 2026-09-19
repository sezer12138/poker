import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {act, contributeAll, drain, readyRoom, startMatch, startTestServer, waitingActor} from './helpers.ts';
import type {TestServer} from './helpers.ts';

describe('倒计时与超时', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  /** Two humans at a table, so nothing acts on its own. */
  async function humanTable() {
    const room = await readyRoom(server);
    await startMatch(server, room.roomId, room.players);
    return room;
  }

  it('贡献窗口恰好 5 秒：4999 毫秒内不封盘，第 5000 毫秒封盘', async () => {
    const {roomId, players} = await humanTable();
    const opened = (await server.view(players[0]!, roomId));
    const deadline = opened.fairness.deadline as number;
    assert.equal(deadline - opened.serverTime, 5000, '窗口应为 5 秒');

    await server.clock.advance(4999);
    await drain();
    const waiting = (await server.view(players[0]!, roomId));
    assert.equal(waiting.fairness.stage, 'collecting');
    assert.equal(waiting.fairness.deckCommitment, null);

    await server.clock.advance(1);
    await drain();
    const committed = (await server.view(players[0]!, roomId));
    assert.equal(committed.fairness.stage, 'playing');
    assert.ok(committed.fairness.deckCommitment !== null);
  });

  it('行动窗口恰好 90 秒，超时自动弃牌并写入事件', async () => {
    const {roomId, players} = await humanTable();
    await contributeAll(server, roomId, players);
    const actor = await waitingActor(server, roomId, players);
    const name = actor!.view.you.name;
    assert.equal((await server.view(players[0]!, roomId)).actionTimeoutMs, 90000, '视图要告诉客户端行动时限');

    await server.clock.advance(89999);
    await drain();
    const waiting = (await server.view(players[0]!, roomId));
    assert.equal(waiting.hand.street, 'preflop', '第 89999 毫秒仍应等玩家行动');
    assert.equal(waiting.fairness.stage, 'playing');

    await server.clock.advance(1);
    await drain();
    const settled = (await server.view(players[0]!, roomId));
    assert.equal(settled.hand.street, 'settled');
    const texts = settled.events.map((event: any) => event.text);
    assert.ok(
      texts.some((text: string) => text === `${name} 超时，自动弃牌`),
      texts.join('|'),
    );
    // 超时也是弃牌，客户端照样按动作播报（文字里已经有「超时」）。
    const timedOut = settled.events.find((event: any) => event.text === `${name} 超时，自动弃牌`);
    assert.equal(timedOut.action, 'fold');
    assert.equal(timedOut.amount, undefined);
  });

  it('每次成功行动都会重置行动窗口', async () => {
    const {roomId, players} = await humanTable();
    await contributeAll(server, roomId, players);
    const first = await waitingActor(server, roomId, players);
    await act(server, roomId, first!.session, {type: 'call'});

    await server.clock.advance(89999);
    await drain();
    const view = (await server.view(players[0]!, roomId));
    assert.equal(view.hand.street, 'preflop', '窗口应从最后一次行动重新计时');
    assert.equal(view.deadline! - view.serverTime, 1);

    const second = await waitingActor(server, roomId, players);
    assert.ok(second !== null, '轮到另一位玩家');
    assert.equal(second!.legal.check, true, '大盲在无人加注时可以过牌');
  });

  it('没人点确认时，结算 8 秒后自动开始下一手，手号递增且重新开启贡献窗口', async () => {
    const {roomId, players} = await humanTable();
    await contributeAll(server, roomId, players);
    const actor = await waitingActor(server, roomId, players);
    await act(server, roomId, actor!.session, {type: 'fold'});

    const settled = (await server.view(players[0]!, roomId));
    assert.equal(settled.fairness.stage, 'settled');
    assert.equal(settled.nextHandAt! - settled.serverTime, 8000);

    await server.clock.advance(7999);
    await drain();
    assert.equal((await server.view(players[0]!, roomId)).fairness.handNo, 1);

    await server.clock.advance(1);
    await drain();
    const next = (await server.view(players[0]!, roomId));
    assert.equal(next.fairness.handNo, 2);
    assert.equal(next.fairness.stage, 'collecting');
    assert.equal(next.completedHands, 1);
    assert.equal(next.fairness.owed, true, '新一手仍需贡献');
  });

  it('无人贡献时用零贡献开牌，且每手只结算一次', async () => {
    const {roomId, players} = await humanTable();
    await contributeAll(server, roomId, players);
    const actor = await waitingActor(server, roomId, players);
    // Fold, then wait through the whole next-hand window without contributing.
    await act(server, roomId, actor!.session, {type: 'fold'});
    await server.clock.advance(8000);
    await drain();
    await server.clock.advance(5000);
    await drain();
    const view = (await server.view(players[0]!, roomId));
    assert.equal(view.status, 'playing');
    assert.equal(view.completedHands, 1, '第二手在无人贡献时用零贡献开牌');
    assert.ok(view.hand !== null);
    // Exactly one settle event per completed hand: no duplicated application.
    const settles = view.events.filter((event: any) => event.type === 'settle');
    assert.equal(settles.length, 1, JSON.stringify(view.events));
  });

  it('只剩机器人的房间会被回收，不会空转', async () => {
    const host = await server.guest('房主');
    const created = await server.createRoom(host, 2);
    const view = await server.view(host, created.id);
    const left = await server.command(host, created.id, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version,
      type: 'leave',
    });
    assert.equal(left.status, 200);
    const gone = await server.call(`/api/rooms/${created.id}`, {token: host.token});
    assert.equal(gone.status, 404, '只剩机器人的房间会被回收');
  });
});
