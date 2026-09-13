import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  act,
  advanceMatch,
  contributeAll,
  drain,
  readyRoom,
  restartServer,
  seatOf,
  startMatch,
  startTestServer,
  waitingActor,
} from './helpers.ts';
import type {ActionPolicy, Session, TestServer} from './helpers.ts';
import {applyCommand} from '../src/rooms/commands.ts';
import type {CommandContext} from '../src/rooms/commands.ts';
import {roomView} from '../src/rooms/roomview.ts';
import {assertPersistedRoom} from '../src/storage/storage.ts';
import type {PersistedRoom} from '../src/storage/storage.ts';

/** 一路全押：打完一整场最快的方式，用来把比赛推到 finished。 */
const ALL_IN_ALWAYS: ActionPolicy = legal =>
  legal.allIn ? {type: 'allIn'} : legal.check ? {type: 'check'} : legal.call !== null ? {type: 'call'} : {type: 'fold'};

/**
 * 结算确认门：一手打完先弹结果，真人点完「确认」才开下一手；有人不点时由
 * deadlines.nextHand 的兜底定时器自动继续——一个挂机的玩家不能把整桌钉住。
 */
describe('结算确认门', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  /** 把当前这一手打到结算：贡献齐 → 有人弃牌。 */
  async function settleCurrentHand(roomId: string, players: Session[]): Promise<number> {
    await contributeAll(server, roomId, players);
    const actor = await waitingActor(server, roomId, players);
    assert.ok(actor !== null, '总该有人行动');
    const result = await act(server, roomId, actor.session, {type: 'fold'});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const view = await server.view(players[0]!, roomId);
    assert.equal(view.fairness.stage, 'settled');
    return view.fairness.handNo;
  }

  /** 两个真人打一手，fold 直接结算，此时还没有人确认。 */
  async function settledHand(): Promise<{roomId: string; players: Session[]; handNo: number}> {
    const room = await readyRoom(server);
    await startMatch(server, room.roomId, room.players);
    const handNo = await settleCurrentHand(room.roomId, room.players);
    return {roomId: room.roomId, players: room.players, handNo};
  }

  /** 客户端发确认命令的样子：永远带上手号。 */
  function ack(session: Session, roomId: string, handNo: number, extra: Record<string, unknown> = {}) {
    return server.command(session, roomId, {
      requestId: crypto.randomUUID(),
      type: 'settleAck',
      handNo,
      ...extra,
    });
  }

  async function seatsOf(roomId: string, players: Session[]): Promise<number[]> {
    const seats: number[] = [];
    for (const player of players) seats.push(seatOf(await server.view(player, roomId), player)!);
    return seats.sort((a, b) => a - b);
  }

  it('结算期间视图开出确认门，列出需要确认的真人座位', async () => {
    const {roomId, players, handNo} = await settledHand();
    const view = await server.view(players[0]!, roomId);
    assert.notEqual(view.settle, null, '结算中必须能看到确认门');
    assert.equal(view.settle.handNo, handNo);
    assert.deepEqual(view.settle.acks, [], '还没人点确认');
    assert.deepEqual(view.settle.required, await seatsOf(roomId, players));
    assert.equal(view.actionTimeoutMs, 90000, '客户端画倒计时条要用它，不能自己写死');
  });

  it('结算视图给出每个座位本手的净输赢金额', async () => {
    const {roomId, players, handNo} = await settledHand();
    const view = await server.view(players[0]!, roomId);
    assert.equal(view.settle.handNo, handNo);
    const changes: {seat: number; delta: number}[] = view.settle.changes;
    assert.equal(changes.length, 2, '两个座位都要有金额，弹窗才能逐条列出输赢');
    assert.equal(
      changes.reduce((sum, change) => sum + change.delta, 0),
      0,
      '筹码守恒：赢的总额必须等于输的总额',
    );
    // 这一手是弃牌结束的：弃牌的一方输掉自己投进底池的部分，另一方等额赢下。
    const folded = view.hand.players.find((player: any) => player.folded).seat;
    const deltaOf = (seat: number) => changes.find(change => change.seat === seat)!.delta;
    assert.equal(deltaOf(folded), -5, '弃牌的座位只亏掉了自己投入的盲注');
    const winner = changes.find(change => change.seat !== folded)!;
    assert.equal(winner.delta, 5, '赢家赢到的正好是对手投进底池的部分');
  });

  it('机器人座位也带金额，弹窗里不会出现没数字的一行', async () => {
    const room = await readyRoom(server, {bots: 1});
    await startMatch(server, room.roomId, room.players);
    await advanceMatch(server, room.roomId, room.players, {
      until: (view: any) => view.fairness.stage === 'settled',
    });
    const view = await server.view(room.players[0]!, room.roomId);
    assert.equal(view.fairness.stage, 'settled');
    const seats = view.members.map((member: any) => member.seat).sort((a: number, b: number) => a - b);
    assert.deepEqual(
      view.settle.changes.map((change: any) => change.seat).sort((a: number, b: number) => a - b),
      seats,
      '每个座位（含机器人）都要有本手净输赢',
    );
  });

  it('真人确认后全桌可见，但没集齐之前不开下一手', async () => {
    const {roomId, players, handNo} = await settledHand();
    const [seat] = await seatsOf(roomId, players);
    const result = await ack(players[0]!, roomId, handNo);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(result.body.settle.acks, [seat]);

    await drain();
    const view = await server.view(players[1]!, roomId);
    assert.equal(view.fairness.handNo, handNo, '还有真人没确认，不能开下一手');
    assert.equal(view.fairness.stage, 'settled');
    assert.deepEqual(view.settle.acks, [seat], '确认状态要对全桌可见');
  });

  it('带着过期版本号的确认照样生效（两人几乎同时点不会吃 409）', async () => {
    const {roomId, players, handNo} = await settledHand();
    const stale = (await server.view(players[0]!, roomId)).version - 5;
    const result = await ack(players[0]!, roomId, handNo, {expectedVersion: stale});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.settle.acks.length, 1);
  });

  it('真人都确认后立刻开下一手，不必等兜底窗口', async () => {
    const {roomId, players, handNo} = await settledHand();
    const first = await ack(players[0]!, roomId, handNo);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const second = await ack(players[1]!, roomId, handNo);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    await drain();

    const view = await server.view(players[0]!, roomId);
    assert.equal(view.fairness.handNo, handNo + 1, '集齐确认就该立刻发下一手');
    assert.equal(view.fairness.stage, 'collecting');
    assert.equal(view.completedHands, handNo);
    assert.equal(view.settle, null, '新一手开始后确认门必须消失');
  });

  it('重复确认是幂等的：不报错、不重复计数、不误开下一手', async () => {
    const {roomId, players, handNo} = await settledHand();
    await ack(players[0]!, roomId, handNo);
    await ack(players[0]!, roomId, handNo);
    const view = await server.view(players[0]!, roomId);
    assert.equal(view.settle.acks.length, 1, '同一个座位只记一次');
    assert.equal(view.fairness.handNo, handNo, '只确认了一半，不该开下一手');

    // 全桌确认后，一个迟到的重复确认不能再推进一手。
    await ack(players[1]!, roomId, handNo);
    await drain();
    assert.equal((await server.view(players[0]!, roomId)).fairness.handNo, handNo + 1);
    const late = await ack(players[0]!, roomId, handNo);
    assert.equal(late.status, 200, '迟到的确认不该给玩家弹错误横幅');
    assert.equal(late.body.fairness.handNo, handNo + 1, '也不能把下一手顶掉');
  });

  it('手号对不上的确认一律无副作用（迟到的那一手确认不能打开新手的门）', async () => {
    const {roomId, players} = await settledHand();
    // 两个人把第一手确认掉，牌桌进到第二手，再打到结算。
    await ack(players[0]!, roomId, 1);
    await ack(players[1]!, roomId, 1);
    await drain();
    const handNo = await settleCurrentHand(roomId, players);
    assert.equal(handNo, 2);

    const before = await server.view(players[0]!, roomId);
    // 上一手的确认姗姗来迟：手号 1 ≠ 2，必须一个字都不写。
    const late = await ack(players[0]!, roomId, 1);
    assert.equal(late.status, 200, '迟到的确认不该给玩家弹错误横幅');
    assert.deepEqual(late.body.settle.acks, [], '上一手的确认不能算进这一手');
    // 未来的手号同样无效。
    const early = await ack(players[0]!, roomId, handNo + 1);
    assert.equal(early.status, 200);
    assert.deepEqual(early.body.settle.acks, []);
    assert.equal((await server.view(players[0]!, roomId)).version, before.version, '空操作不该改动房间版本');

    // 手号从 1 开始，0/负数/小数属于畸形输入，在解析阶段就被拒。
    for (const bad of [0, -1, 1.5]) {
      assert.equal((await ack(players[0]!, roomId, bad)).status, 400, `手号 ${bad} 应被拒绝`);
    }
  });

  it('机器人座位和不在本手的座位都不能确认', async () => {
    const room = await readyRoom(server, {bots: 1});
    await startMatch(server, room.roomId, room.players);
    await contributeAll(server, room.roomId, room.players);
    const settled = await advanceMatch(server, room.roomId, room.players, {
      until: (view: any) => view.fairness.stage === 'settled',
    });
    const view = await server.view(room.players[0]!, room.roomId);
    assert.equal(view.fairness.stage, 'settled');
    const bot = view.members.find((member: any) => member.bot);
    assert.ok(!view.settle.required.includes(bot.seat), '机器人视同已确认，不进 required');

    const live = server.coordinator.get(room.roomId)!;
    const ctx: CommandContext = {now: 1_000_000};
    const handNo = view.settle.handNo;

    // 机器人：座位在本手里，但绝不能替自己盖章（否则确认门会被机器人凑齐）。
    const withBot = structuredClone(live);
    applyCommand(withBot, bot.userId, {type: 'settleAck', handNo}, ctx);
    assert.deepEqual(withBot.fairnessStage!.settleAcks, [], '机器人不能确认');

    // 已淘汰/不在本手的人：座位不在 stage.seats 里，同样不许进确认表。
    const outsider = structuredClone(live);
    outsider.fairnessStage!.seats = outsider.fairnessStage!.seats.filter(seat => seat !== view.you.seat);
    applyCommand(outsider, view.you.userId, {type: 'settleAck', handNo}, ctx);
    assert.deepEqual(outsider.fairnessStage!.settleAcks, [], '不在本手的人不能确认');

    // 非成员连房间都进不去。
    const stranger = structuredClone(live);
    assert.throws(() => applyCommand(stranger, 'u-stranger', {type: 'settleAck', handNo}, ctx), /不是该房间成员/);
    void settled;
  });

  it('没人确认时，兜底窗口结束后自动继续（挂机的人不能钉住牌桌）', async () => {
    const {roomId, players, handNo} = await settledHand();
    await ack(players[0]!, roomId, handNo);
    await server.clock.advance(8000);
    await drain();
    const view = await server.view(players[1]!, roomId);
    assert.equal(view.fairness.handNo, handNo + 1, '兜底定时器必须把牌桌推下去');
    assert.equal(view.fairness.stage, 'collecting');
    assert.equal(view.settle, null);
  });

  it('比赛结束时不弹确认框，确认命令也无副作用', async () => {
    const room = await readyRoom(server);
    await startMatch(server, room.roomId, room.players);
    const final = await advanceMatch(server, room.roomId, room.players, {policy: ALL_IN_ALWAYS});
    assert.equal(final.status, 'finished');
    assert.equal(final.settle, null, '比赛已结束，弹确认框没有意义');

    const before = await server.view(room.players[0]!, room.roomId);
    const result = await ack(room.players[0]!, room.roomId, before.fairness.handNo);
    assert.equal(result.status, 200, '结束后的确认不该报错');
    assert.equal(result.body.status, 'finished');
    assert.equal((await server.view(room.players[0]!, room.roomId)).version, before.version, '不能改动已结束的房间');
  });

  it('重启保留已确认的座位，只把兜底窗口重新计时', async () => {
    let booted = await startTestServer({}, {storage: 'file', keepData: true});
    try {
      const room = await readyRoom(booted);
      await startMatch(booted, room.roomId, room.players);
      await contributeAll(booted, room.roomId, room.players);
      const actor = await waitingActor(booted, room.roomId, room.players);
      await act(booted, room.roomId, actor!.session, {type: 'fold'});
      const settled = await booted.view(room.players[0]!, room.roomId);
      const handNo = settled.fairness.handNo;
      const seat = seatOf(settled, room.players[0]!)!;
      const acked = await booted.command(room.players[0]!, room.roomId, {
        requestId: crypto.randomUUID(),
        type: 'settleAck',
        handNo,
      });
      assert.equal(acked.status, 200, JSON.stringify(acked.body));

      booted = await restartServer(booted);

      const after = await booted.view(room.players[0]!, room.roomId);
      assert.equal(after.fairness.handNo, handNo, '重启不该凭空开下一手');
      assert.deepEqual(after.settle.acks, [seat], '确认过的座位在重启后依然算数');
      assert.equal(after.nextHandAt! - after.serverTime, 8000, '兜底窗口重新计时，停机不算在玩家头上');

      // 剩下的真人一确认就该立刻开手，说明重启没把 acks 弄丢。
      const second = await booted.command(room.players[1]!, room.roomId, {
        requestId: crypto.randomUUID(),
        type: 'settleAck',
        handNo,
      });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      await drain();
      assert.equal((await booted.view(room.players[0]!, room.roomId)).fairness.handNo, handNo + 1);
    } finally {
      await booted.close();
    }
  });

  it('加确认门之前的老快照：缺 settleAcks 时补空数组而不是判死', () => {
    const legacy: Record<string, unknown> = {
      v: 1,
      id: 'room-legacy',
      code: 'LEGACY',
      invite: 'f'.repeat(32),
      name: '老快照',
      version: 3,
      status: 'playing',
      hostId: 'u0',
      members: [{userId: 'u0', name: '甲', seat: 0, bot: false, ready: true, joinedAt: 0}],
      matchId: 'm',
      tournament: null,
      fairnessStage: {
        stage: 'settled',
        handNo: 1,
        seats: [0],
        round: {commitment: 'ab', deckCommitment: 'cd', contributions: {}},
        deck: null,
        dealt: null,
        button: null,
      },
      fairnessHistory: [],
      events: [],
      seq: 0,
      idempotency: [],
      deadlines: {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null},
      notice: '',
      lastActivityAt: 0,
      createdAt: 0,
    };
    const room: PersistedRoom = assertPersistedRoom(legacy);
    assert.deepEqual(room.fairnessStage!.settleAcks, [], '缺字段补空数组');
    assert.deepEqual(room.fairnessStage!.startStacks, {}, '缺筹码快照补空对象');

    // 字段在但是坏的形状（比如旧版本写成 null）也要补回来。
    const broken: Record<string, unknown> = {...legacy, fairnessStage: {...(legacy['fairnessStage'] as object), settleAcks: null}};
    assert.deepEqual(assertPersistedRoom(broken).fairnessStage!.settleAcks, []);

    const truncated: Record<string, unknown> = {
      ...legacy,
      fairnessStage: {...(legacy['fairnessStage'] as object), settleAcks: [], startStacks: 'x'},
    };
    assert.deepEqual(assertPersistedRoom(truncated).fairnessStage!.startStacks, {});

    // 老快照没有快照数据 → 结算弹窗拿不到金额，视图给空数组（客户端退化成只显示赢家）。
    const view = roomView(room, 'u0', {now: 0});
    assert.deepEqual(view.settle!.changes, [], '没有筹码快照时不编造金额');
  });
});
