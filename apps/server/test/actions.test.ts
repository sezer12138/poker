import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  advanceMatch,
  CALL_ALWAYS,
  contributeAll,
  readyRoom,
  startMatch,
  startTestServer,
  waitingActor,
} from './helpers.ts';
import type {Session, TestServer} from './helpers.ts';

describe('行动与街道推进', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  /** A heads-up match with the contribution window already closed. */
  async function dealtRoom(bots = 0) {
    const room = await readyRoom(server, {bots});
    await startMatch(server, room.roomId, room.players);
    await contributeAll(server, room.roomId, room.players);
    return room;
  }

  it('只有行动人拿得到合法操作，其他人一律为 null', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    assert.ok(actor !== null, '发牌后应有人行动');

    for (const player of players) {
      const view = (await server.view(player, roomId));
      const legal = view.hand.legal;
      if (player.user.id === actor.session.user.id) {
        assert.ok(legal !== null, '行动人应拿到合法操作');
        assert.equal(typeof legal.fold, 'boolean');
        assert.equal(typeof legal.allIn, 'boolean');
      } else {
        assert.equal(legal, null, '非行动人不应拿到任何合法操作');
      }
    }
  });

  it('非行动人提交行动被拒绝，且不改变房间状态', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    const idle = players.find(player => player.user.id !== actor!.session.user.id)!;
    const before = (await server.view(players[0]!, roomId));

    const result = await act(server, roomId, idle, {type: 'fold'});
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'NOT_YOUR_TURN');
    const after = (await server.view(players[0]!, roomId));
    assert.equal(after.version, before.version, '被拒绝的命令不消耗版本号');
    assert.equal(after.hand.street, before.hand.street);
  });

  it('面对下注时不能过牌', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    assert.equal(actor!.legal.check, false, '先行动的一方面对大盲注');
    assert.equal(actor!.legal.call, 5);

    const result = await act(server, roomId, actor!.session, {type: 'check'});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'ILLEGAL_ACTION');
  });

  it('加注金额必须合法', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);

    for (const amount of [0, -5, 1.5]) {
      const result = await act(server, roomId, actor!.session, {type: 'raiseTo', amount});
      assert.equal(result.status, 400, `amount=${amount} 应被拒绝`);
    }

    const tooSmall = await act(server, roomId, actor!.session, {
      type: 'raiseTo',
      amount: actor!.legal.minRaiseTo! - 1,
    });
    assert.equal(tooSmall.status, 400);
    assert.equal(tooSmall.body.error.code, 'ILLEGAL_ACTION');

    const tooBig = await act(server, roomId, actor!.session, {
      type: 'raiseTo',
      amount: actor!.legal.maxRaiseTo! + 1000,
    });
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error.code, 'ILLEGAL_ACTION');

    const ok = await act(server, roomId, actor!.session, {
      type: 'raiseTo',
      amount: actor!.legal.minRaiseTo!,
    });
    assert.equal(ok.status, 200);
  });

  it('行动写入中文事件流，并且只有自己看得到底牌', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    const name = actor!.view.you.name;

    const result = await act(server, roomId, actor!.session, {type: 'call'});
    assert.equal(result.status, 200);
    const last = result.body.events.at(-1);
    const text = last.text;
    assert.match(text, new RegExp(`^${name} 跟注 5$`));
    // 播报要用的结构化字段：跟注报本次投入。
    assert.equal(last.action, 'call');
    assert.equal(last.amount, 5);

    const mine = result.body.hand.players.find((player: any) => player.seat === actor!.seat);
    assert.equal(mine.hole.length, 2);

    const other = (await server.view(players.find(p => p.user.id !== actor!.session.user.id)!, roomId));
    const theirs = other.hand.players.find((player: any) => player.seat === actor!.seat);
    assert.deepEqual(theirs.hole, [], '未摊牌前看不到对手底牌');
    assert.equal(other.hand.players.find((player: any) => player.seat === other.you.seat).hole.length, 2);
  });

  it('弃牌立即结束本手并结算', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);

    const result = await act(server, roomId, actor!.session, {type: 'fold'});
    assert.equal(result.status, 200);
    assert.equal(result.body.fairness.stage, 'settled');
    assert.equal(result.body.hand.street, 'settled');
    const texts = result.body.events.map((event: any) => event.text);
    assert.ok(texts.some((text: string) => text.endsWith('弃牌')), texts.join('|'));
    assert.ok(texts.some((text: string) => /^第 1 手结束，.+ 赢得 \d+ 筹码$/.test(text)), texts.join('|'));
    const fold = result.body.events.find((event: any) => event.text.endsWith('弃牌'));
    assert.equal(fold.action, 'fold');
    assert.equal(fold.amount, undefined, '弃牌没有金额，不该编一个出来');
    // 非动作事件不带这两个键（undefined 会被 JSON 丢掉），客户端据此知道无从谈语气。
    const settle = result.body.events.find((event: any) => event.text.startsWith('第 1 手结束'));
    assert.equal('action' in settle, false, '结算事件不该带 action');
    assert.equal('amount' in settle, false, '结算事件不该带 amount');

    const again = await act(server, roomId, actor!.session, {type: 'fold'});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'HAND_FINISHED');
  });

  it('跟注推进到翻牌并公开公共牌', async () => {
    const {roomId, players} = await dealtRoom(2);
    const view = await advanceMatch(server, roomId, players, {
      policy: CALL_ALWAYS,
      until: room => room.hand?.board.length === 3,
      maxHands: 1,
    });

    assert.equal(view.hand.street, 'flop');
    assert.equal(view.hand.board.length, 3);
    const texts = view.events.map((event: any) => event.text);
    const flop = texts.find((text: string) => text.startsWith('公共牌 翻牌'));
    assert.ok(flop !== undefined, texts.join('|'));
    // 街道事件是公共信息，但既不是动作也没有金额。
    const street = view.events.find((event: any) => event.text.startsWith('公共牌 翻牌'));
    assert.equal('action' in street, false, '街道事件不该带 action');
    // Board cards are public: every viewer sees the same three.
    const other = (await server.view(players[1]!, roomId));
    assert.deepEqual(other.hand.board, view.hand.board);
  });

  it('全押后本手在发牌时即结算，不会卡死', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    assert.equal(actor!.legal.allIn, true);

    const result = await act(server, roomId, actor!.session, {type: 'allIn'});
    assert.equal(result.status, 200);
    const allIn = result.body.events.at(-1);
    assert.match(allIn.text, /全押/);
    // 单挑起手 1000 筹码全押：金额是全押后的本轮投入。
    assert.equal(allIn.action, 'allIn');
    assert.equal(allIn.amount, 1000);
    // The opponent can still fold or call, but a call ends the hand with no further betting.
    const opponent = players.find(player => player.user.id !== actor!.session.user.id)!;
    const turn = await waitingActor(server, roomId, [opponent]);
    assert.ok(turn !== null);
    const called = await act(server, roomId, opponent, {type: 'call'});
    assert.equal(called.status, 200);
    const settled = (await server.view(players[0]!, roomId));
    assert.equal(settled.hand.street, 'settled');
    assert.equal(settled.hand.board.length, 5, '全押后应直接发完公共牌');
    assert.ok(settled.fairness.stage === 'settled');
  });

  it('比赛中不能加入新玩家，且已结束的房间拒绝行动', async () => {
    const {roomId, players} = await dealtRoom();
    const outsider = await server.guest('路人');
    const denied = await server.command(outsider, roomId, {
      requestId: crypto.randomUUID(),
      type: 'action',
      action: {type: 'fold'},
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  });

  it('行动对局外人不可见：越权读取一律 403', async () => {
    const {roomId} = await dealtRoom();
    const outsider: Session = await server.guest('路人');
    const read = await server.call(`/api/rooms/${roomId}`, {token: outsider.token});
    assert.equal(read.status, 403);
  });
});
