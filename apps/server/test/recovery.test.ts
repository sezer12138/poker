import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  CALL_ALWAYS,
  contributeAll,
  drain,
  nonce,
  readyRoom,
  restartServer,
  seatOf,
  startMatch,
  startTestServer,
  turnOf,
  waitFor,
  waitingActor,
} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {createTournament, nextHand} from '../../../packages/poker-engine/src/index.ts';
import {
  canonicalJson,
  contribute,
  createRound,
  finalizeRound,
  reconstructDeck,
  sha256Hex,
  verifyRound,
} from '../../../packages/fairness/src/index.ts';

/** A file-storage server whose room files survive `restartServer`. */
async function bootServer(): Promise<TestServer> {
  return startTestServer({}, {storage: 'file', keepData: true});
}

describe('重启恢复', () => {
  it('行动中的牌局：底牌与牌序不变，窗口重新计时 90 秒', async () => {
    let server = await bootServer();
    try {
      const {roomId, players} = await readyRoom(server);
      await startMatch(server, roomId, players);
      await contributeAll(server, roomId, players);

      const before = (await server.view(players[0]!, roomId));
      const deck = server.coordinator.get(roomId)!.fairnessStage!.deck!;
      const opponentSeat = before.members.find((member: any) => member.seat !== before.you.seat).seat;
      const opponentHoles = before.hand.players.find((player: any) => player.seat === opponentSeat).hole;
      assert.deepEqual(opponentHoles, [], '重启前对手底牌本来就不可见');

      server = await restartServer(server);

      const me = await server.call('/api/me', {token: players[0]!.token});
      assert.equal(me.status, 200, '会话在重启后仍然有效');

      const after = (await server.view(players[0]!, roomId));
      assert.equal(after.status, 'playing');
      assert.equal(after.hand.id, before.hand.id);
      assert.deepEqual(after.hand.board, before.hand.board);
      const mine = (view: any) => view.hand.players.find((player: any) => player.seat === view.you.seat).hole;
      assert.deepEqual(mine(after), mine(before), '自己的底牌必须还在');
      assert.deepEqual(
        after.hand.players.find((player: any) => player.seat === opponentSeat).hole,
        [],
        '重启不能让对手底牌泄漏',
      );
      assert.equal(after.fairness.stage, 'playing');
      assert.match(after.notice, /重启/, '重启要给玩家一句中文提示');
      assert.equal(after.deadline! - after.serverTime, 90000, '停机时间不计入玩家的行动时限');

      const restored = server.coordinator.get(roomId)!;
      assert.deepEqual(restored.fairnessStage!.deck, deck, '牌堆必须原样保留');
      assert.equal(restored.fairnessStage!.round.deckCommitment, sha256Hex(canonicalJson(deck)));
      assert.deepEqual(reconstructDeck(restored.fairnessStage!.round), deck, '重启后仍能复算牌序');

      // The re-armed timer really runs: 90s later the silent player is timed out.
      await server.clock.advance(90000);
      await waitFor(() => {
        const room = server.coordinator.get(roomId)!;
        return room.tournament!.hand!.street === 'settled' || room.tournament!.hand!.actor !== after.hand.actor;
      }, '行动超时');
      const moved = (await server.view(players[0]!, roomId));
      assert.ok(
        moved.hand.street === 'settled' || moved.hand.actor !== after.hand.actor,
        '重启后的行动窗口必须真的会触发',
      );
    } finally {
      await server.close();
    }
  });

  it('收集贡献阶段：给一个新的 5 秒窗口，无人贡献也能开出可核验的牌', async () => {
    let server = await bootServer();
    try {
      const {roomId, players} = await readyRoom(server);
      await startMatch(server, roomId, players);
      const before = (await server.view(players[0]!, roomId));
      assert.equal(before.fairness.stage, 'collecting');

      server = await restartServer(server);

      const after = (await server.view(players[0]!, roomId));
      assert.equal(after.fairness.stage, 'collecting');
      assert.equal(after.fairness.commitment, before.fairness.commitment, '承诺在重启前后必须是同一个');
      assert.equal(after.fairness.deckCommitment, null);
      assert.equal(after.fairness!.deadline! - after.serverTime, 5000);
      assert.match(after.notice, /重启/);

      await server.clock.advance(5000);
      await waitFor(() => server.coordinator.get(roomId)?.fairnessStage?.stage === 'playing', '封盘发牌');
      const dealt = (await server.view(players[0]!, roomId));
      assert.equal(dealt.fairness.stage, 'playing');
      assert.ok(dealt.fairness.deckCommitment !== null);

      const stage = server.coordinator.get(roomId)!.fairnessStage!;
      assert.equal(verifyRound(stage.round).valid, true, '重启前后的承诺与牌序必须自洽');
      assert.deepEqual(reconstructDeck(stage.round), stage.deck);
      assert.equal(stage.round.deckCommitment, sha256Hex(canonicalJson(stage.deck)));
    } finally {
      await server.close();
    }
  });

  it('结算展示阶段：核验记录不丢，8 秒后照常开下一手', async () => {
    let server = await bootServer();
    try {
      const {roomId, players} = await readyRoom(server);
      await startMatch(server, roomId, players);
      await contributeAll(server, roomId, players);
      const turn = await waitingActor(server, roomId, players);
      assert.ok(turn !== null);
      await act(server, roomId, turn.session, {type: 'fold'});
      const before = (await server.view(players[0]!, roomId));
      assert.equal(before.fairness.stage, 'settled');
      assert.equal(before.fairness.history.length, 1);

      server = await restartServer(server);

      const after = (await server.view(players[0]!, roomId));
      assert.equal(after.fairness.stage, 'settled');
      assert.equal(after.nextHandAt! - after.serverTime, 8000);
      assert.match(after.notice, /重启/);
      assert.deepEqual(after.fairness.history, before.fairness.history, '上一手的核验数据必须保留');

      await server.clock.advance(7999);
      await drain();
      assert.equal((await server.view(players[0]!, roomId)).fairness.handNo, 1);

      await server.clock.advance(1);
      await waitFor(() => server.coordinator.get(roomId)?.fairnessStage?.handNo === 2, '开下一手');
      const next = (await server.view(players[0]!, roomId));
      assert.equal(next.fairness.handNo, 2);
      assert.equal(next.fairness.stage, 'collecting');
      assert.equal(next.completedHands, 1);
    } finally {
      await server.close();
    }
  });

  it('发牌中途重启：用已经存下的牌序复牌，绝不重新洗牌', async () => {
    let server = await bootServer();
    try {
      const {roomId, players} = await readyRoom(server);
      await startMatch(server, roomId, players);

      // Rebuild the snapshot a crash between "牌序已持久化" and "发牌" would leave behind.
      const room = structuredClone(server.coordinator.get(roomId)!);
      const seats = room.members.map(member => member.seat).sort((a, b) => a - b);
      const handNo = room.fairnessStage!.handNo;
      let round = createRound(room.matchId!, handNo);
      for (const seat of seats) round = contribute(round, seat, nonce());
      const finalized = finalizeRound(round, seats);
      const deck = finalized.deck;
      room.fairnessStage = {stage: 'dealing', handNo, seats, round: finalized.round, deck, dealt: null, button: null, settleAcks: []};
      await server.storage.saveRoom(room);

      server = await restartServer(server);
      // The restore path re-deals off the queue, reading the deck it loaded from disk.
      await waitFor(() => server.coordinator.get(roomId)?.fairnessStage?.stage === 'playing', '恢复发牌');

      const restored = server.coordinator.get(roomId)!;
      assert.equal(restored.fairnessStage!.stage, 'playing', '恢复后应把这一手发完');
      assert.deepEqual(restored.fairnessStage!.deck, deck, '牌堆必须还是崩前那一副');
      assert.equal(restored.fairnessStage!.round.deckCommitment, sha256Hex(canonicalJson(deck)));

      const hand = restored.tournament!.hand!;
      const local = nextHand(createTournament(seats, hand.button), deck).hand!;
      assert.equal(hand.id, local.id);
      assert.deepEqual(
        hand.players.map(player => player.hole),
        local.players.map(player => player.hole),
        '恢复出的底牌必须与这副牌一一对应',
      );
      assert.deepEqual(hand.board, local.board);
      assert.deepEqual(
        restored.fairnessStage!.dealt!.holes,
        Object.fromEntries(local.players.map(player => [player.seat, player.hole])),
      );
      assert.deepEqual(restored.fairnessStage!.dealt!.board, local.board);

      // And the player really sees those cards.
      const view = (await server.view(players[0]!, roomId));
      const seat = seatOf(view, players[0]!)!;
      assert.deepEqual(
        view.hand.players.find((player: any) => player.seat === seat).hole,
        local.players.find(player => player.seat === seat)!.hole,
      );
    } finally {
      await server.close();
    }
  });

  it('重启后机器人重新计时，继续自己打完这一手', async () => {
    let server = await bootServer();
    try {
      const {roomId, players} = await readyRoom(server, {bots: 1});
      await startMatch(server, roomId, players);
      await contributeAll(server, roomId, players);
      const bot = server.coordinator.get(roomId)!.members.find(member => member.bot)!;

      // Play the humans' turns (nobody folds out) until the bot is up.
      for (let guard = 0; guard < 8; guard++) {
        const view = (await server.view(players[0]!, roomId));
        if (view.hand.actor === bot.seat || view.hand.street === 'settled') break;
        const actor = players.find(player => seatOf(view, player) === view.hand.actor)!;
        const turn = await turnOf(server, roomId, actor);
        assert.ok(turn !== null);
        await act(server, roomId, actor, CALL_ALWAYS(turn.legal));
        await drain();
      }
      const before = (await server.view(players[0]!, roomId));
      assert.equal(before.hand.actor, bot.seat, '这一手应该正好轮到机器人');

      server = await restartServer(server);

      // 机器人思考 2500ms + 抖动上限 2000ms：4500ms 一定已经出手。
      await server.clock.advance(4500);
      await drain();
      const after = (await server.view(players[0]!, roomId));
      assert.ok(after.events.length > before.events.length, '重启后机器人要继续行动');
      assert.ok(
        after.events.some((event: any) => event.text.startsWith(`${bot.name} `)),
        after.events.map((event: any) => event.text).join('|'),
      );
    } finally {
      await server.close();
    }
  });

  it('等待中的房间原样恢复，房号仍可加入', async () => {
    let server = await bootServer();
    try {
      const {roomId, players, code} = await readyRoom(server, {bots: 1});
      const before = (await server.view(players[0]!, roomId));
      assert.equal(before.status, 'waiting');

      server = await restartServer(server);

      const me = await server.call('/api/me', {token: players[0]!.token});
      assert.equal(me.status, 200);

      const after = (await server.view(players[0]!, roomId));
      assert.equal(after.status, 'waiting');
      assert.equal(after.notice, '', '等待中的房间不需要重启提示');
      assert.deepEqual(
        after.members.map((member: any) => [member.seat, member.name, member.bot, member.ready]),
        before.members.map((member: any) => [member.seat, member.name, member.bot, member.ready]),
      );

      const late = await server.guest('迟到者');
      const joined = await server.join(late, code);
      assert.equal(joined.status, 200, '房号在重启后仍然有效');
      assert.equal(joined.body.id, roomId, '房号必须指回同一个房间');
      assert.equal(joined.body.members.length, before.members.length + 1);
    } finally {
      await server.close();
    }
  });
});
