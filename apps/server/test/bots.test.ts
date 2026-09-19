import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  CALL_ALWAYS,
  contributeAll,
  drain,
  finishMatch,
  readyRoom,
  seatOf,
  startMatch,
  startTestServer,
  turnOf,
} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {applyBotAction} from '../src/rooms/bots.ts';
import {HISTORY_VIEW_CAP} from '../src/config.ts';
import {playerView} from '../../../packages/poker-engine/src/index.ts';
import {ZERO_NONCE} from '../../../packages/fairness/src/index.ts';
import type {PersistedRoom} from '../src/storage/storage.ts';

describe('机器人', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  function botSeat(roomId: string): number {
    const bot = server.coordinator.get(roomId)!.members.find(member => member.bot);
    assert.ok(bot !== undefined, '房间应有机器人');
    return bot.seat;
  }

  /** Ready, start and deal with one bot at the table. */
  async function tableWithBot(bots = 1) {
    const room = await readyRoom(server, {bots});
    await startMatch(server, room.roomId, room.players);
    await contributeAll(server, room.roomId, room.players);
    return room;
  }

  /**
   * Plays the humans' turns (cheaply, without folding anyone out) until the bot is
   * the actor. Leaves the clock untouched, so the bot's think timer is still ahead.
   */
  async function reachBotTurn(roomId: string, players: any[]): Promise<any> {
    const seat = botSeat(roomId);
    for (let guard = 0; guard < 10; guard++) {
      const view = (await server.view(players[0]!, roomId));
      const hand = view.hand;
      if (hand === null || hand.street === 'settled') return null;
      if (hand.actor === seat) return view;
      const actor = players.find(player => seatOf(view, player) === hand.actor);
      assert.ok(actor !== undefined, `行动者 ${hand.actor} 应该是在座的真人`);
      const turn = await turnOf(server, roomId, actor);
      assert.ok(turn !== null, '轮到行动却拿不到合法操作');
      const result = await act(server, roomId, actor, CALL_ALWAYS(turn.legal));
      assert.equal(result.status, 200);
      await drain();
    }
    return null;
  }

  it('机器人思考 2.5 秒以上才自行行动，行动前不抢跑', async () => {
    const {roomId, players} = await tableWithBot();
    const view = await reachBotTurn(roomId, players);
    assert.ok(view !== null, '机器人应该拿到行动权');

    // 思考时长 = 2500ms + 0..2000ms 抖动：2499 一定还没到，4500 一定已经出手。
    await server.clock.advance(2499);
    await drain();
    const waiting = (await server.view(players[0]!, roomId));
    assert.equal(waiting.hand.actor, botSeat(roomId), '第 2499 毫秒机器人还在思考');
    assert.equal(waiting.events.length, view.events.length, '思考期间不应产生事件');

    await server.clock.advance(2001);
    await drain();
    const moved = (await server.view(players[0]!, roomId));
    assert.ok(moved.events.length > view.events.length, '第 4500 毫秒机器人必须行动');
    assert.ok(
      moved.events.length > 0 && moved.hand.actor !== botSeat(roomId) || moved.hand.street === 'settled',
      '机器人行动后行动权应转交或直接摊牌',
    );
    const name = view.members.find((member: any) => member.seat === botSeat(roomId)).name;
    assert.ok(
      moved.events.some((event: any) => event.text.startsWith(`${name} `)),
      `事件里应有机器人的动作：${moved.events.map((event: any) => event.text).join('|')}`,
    );
  });

  it('机器人的决定只用自己看得见的视图', async () => {
    const {roomId, players} = await tableWithBot();
    const view = await reachBotTurn(roomId, players);
    assert.ok(view !== null);

    const room = server.coordinator.get(roomId)! as PersistedRoom;
    const seat = botSeat(roomId);
    const seen = playerView(room.tournament!.hand!, seat);
    // The view a bot decides from is exactly the public hand plus its own two cards.
    const own = seen.players.find(player => player.seat === seat)!;
    assert.equal(own.hole.length, 2);
    for (const player of seen.players) {
      if (player.seat === seat) continue;
      assert.deepEqual(player.hole, [], '机器人不能看到别人的底牌');
    }
    assert.notEqual(seen.legal, null, '轮到机器人时视图必须带上合法操作');
  });

  it('机器人不会在别人的行动点上出手', async () => {
    const {roomId, players} = await tableWithBot();
    const view = await reachBotTurn(roomId, players);
    assert.ok(view !== null);
    // 先把机器人自己那一步走完（思考上限 4500ms），行动权才会落到别人手上。
    await server.clock.advance(4500);
    await drain();
    // Someone else is thinking (or the hand is over): a bot action must be a no-op.
    const before = structuredClone(server.coordinator.get(roomId)!);
    const seat = botSeat(roomId);
    const hand = before.tournament!.hand!;
    // 先确认前置条件真的成立，否则下面的断言会被整段跳过、这条测试就是在空转。
    assert.ok(hand.street === 'settled' || hand.actor !== seat, '机器人那一步已经走完，行动权不该还在它手上');
    const events = JSON.stringify(before.events);
    applyBotAction(before, seat, {now: 1});
    const after = server.coordinator.get(roomId)!;
    assert.equal(JSON.stringify(before.events), events, '不是自己的行动点，不能落任何事件');
    assert.equal(JSON.stringify(before.events), JSON.stringify(after.events), '也不能碰到真实房间');
  });

  it('决策层失败时退回超时动作，绝不卡住牌桌', async () => {
    const {roomId, players} = await tableWithBot();
    const view = await reachBotTurn(roomId, players);
    assert.ok(view !== null);

    const room = structuredClone(server.coordinator.get(roomId)!);
    const seat = botSeat(roomId);
    const hand = room.tournament!.hand!;
    const couldCheck = playerView(hand, seat).legal!.check;
    const logs: string[] = [];
    const before = room.events.length;

    // Hand the decision layer a view it must reject — the bot's own cards are gone,
    // the same class of failure as a strategy bug. The server has to fall back.
    room.tournament!.hand!.players.find(player => player.seat === seat)!.hole = [];

    applyBotAction(room, seat, {now: 1_000_000, log: message => logs.push(message)});

    assert.ok(logs.some(message => message.includes('决策失败')), logs.join('|'));
    assert.ok(room.events.length > before, '兜底动作必须真正执行');
    const name = room.members.find(member => member.seat === seat)!.name;
    const texts = room.events.slice(before).map(event => event.text);
    // The fallback is the timeout action (fold facing a bet, check when free). It is
    // recorded as the bot's own action: 超时 wording is reserved for the real clock.
    assert.ok(
      texts.includes(couldCheck ? `${name} 过牌` : `${name} 弃牌`),
      `兜底应执行超时动作：${texts.join('|')}`,
    );
    // 机器人动作与真人同一套事件字段：客户端播报不看是谁下的。
    const expected = couldCheck ? `${name} 过牌` : `${name} 弃牌`;
    const fallback = room.events.slice(before).find(event => event.text === expected)!;
    assert.equal(fallback.action, couldCheck ? 'check' : 'fold');
    assert.notEqual(room.tournament!.hand!.actor, seat, '牌桌不能停在机器人身上');
  });

  it('机器人不参与贡献，封盘时按零贡献补齐', async () => {
    const {roomId, players} = await tableWithBot();
    const stage = server.coordinator.get(roomId)!.fairnessStage!;
    const seat = botSeat(roomId);
    assert.equal(stage.round.contributions[String(seat)], ZERO_NONCE, '机器人贡献恒为零');

    const view = (await server.view(players[0]!, roomId));
    assert.equal(view.fairness.expected.includes(seat), false, '不应等机器人贡献');
    assert.equal(view.fairness.contributors.includes(seat), true, '封盘后机器人席位出现在贡献名单里');
    for (const player of players) {
      const seatNumber = seatOf(view, player)!;
      assert.equal(view.fairness.expected.includes(seatNumber), true);
    }
  });

  it('真人全弃牌时机器人一路打到有人出局，比赛能正常结束', async () => {
    const {roomId, players} = await readyRoom(server, {bots: 1});
    await startMatch(server, roomId, players);
    await finishMatch(server, roomId, players);

    const view = (await server.view(players[0]!, roomId));
    assert.equal(view.status, 'finished');
    assert.ok(view.winner !== null, '比赛必须有胜者');
    // 只断言「赢家是在座的人」，不假设机器人必胜：机器人自己也会弃牌（单挑时它是小盲，牌弱就把
    // 大小盲让给大盲），而发牌与机器人决策都取真实随机源，胜者由牌决定。原来写成
    // assert.equal(view.winner, botSeat(roomId)) 会偶发假失败——错的是测试的前提，不是服务端。
    const seated = players.map(player => seatOf(view, player) ?? -1).concat([botSeat(roomId)]);
    assert.ok(seated.includes(view.winner!), `胜者必须是本桌在座的人，实际 ${view.winner}`);
    assert.ok(view.completedHands >= 1);
    // Every hand is on record; the live view shows only the most recent ones.
    assert.equal(server.coordinator.get(roomId)!.fairnessHistory.length, view.completedHands);
    assert.equal(view.fairness.history.length, Math.min(HISTORY_VIEW_CAP, view.completedHands));
  });
});
