import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceMatch,
  CALL_ALWAYS,
  contributeAll,
  readyRoom,
  startMatch,
  startTestServer,
} from './helpers.ts';
import type {ActionPolicy} from './helpers.ts';
import type {TestServer} from './helpers.ts';
import {EVENTS_VIEW_CAP, HISTORY_VIEW_CAP, IDEMPOTENCY_MAX_BYTES} from '../src/config.ts';

const HEX64 = /^[0-9a-f]{64}$/;

/** Shoves whenever the engine allows it: the fastest honest way to a finished match. */
const ALL_IN_ALWAYS: ActionPolicy = legal =>
  legal.allIn ? {type: 'allIn'} : legal.check ? {type: 'check'} : legal.call !== null ? {type: 'call'} : {type: 'fold'};

describe('赛后核验', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  /** A finished match with at least one hand that went to showdown. */
  async function playedMatch() {
    const room = await readyRoom(server);
    await startMatch(server, room.roomId, room.players);
    await advanceMatch(server, room.roomId, room.players, {
      policy: CALL_ALWAYS,
      until: view => view.hand?.street === 'settled' && view.hand.board.length === 5,
      maxHands: 5,
    });
    await advanceMatch(server, room.roomId, room.players, {policy: ALL_IN_ALWAYS});
    return room;
  }

  it('比赛没结束不给核验', async () => {
    const {roomId, players} = await readyRoom(server);
    await startMatch(server, roomId, players);
    await contributeAll(server, roomId, players);

    const locked = await server.audit(players[0]!, roomId);
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error.code, 'AUDIT_LOCKED');
    assert.match(locked.body.error.message, /比赛结束后可核验/);
  });

  it('非成员与未登录都拿不到核验', async () => {
    const {roomId} = await playedMatch();
    const outsider = await server.guest('路人');
    const forbidden = await server.audit(outsider, roomId);
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'FORBIDDEN');

    const anonymous = await server.call(`/api/rooms/${roomId}/audit`);
    assert.equal(anonymous.status, 401);
  });

  it('完整一场可以逐手核验通过，并且公开种子与贡献', async () => {
    const {roomId, players} = await playedMatch();

    const result = await server.audit(players[0]!, roomId);
    assert.equal(result.status, 200);
    const audit = result.body;

    assert.equal(audit.valid, true, JSON.stringify(audit.hands.map((hand: any) => hand.verification.errors)));
    assert.equal(audit.hands.length, audit.completedHands);
    assert.ok(audit.hands.length >= 2, '至少要打完两手');
    assert.ok(audit.matchId !== null);
    assert.ok(audit.winner !== null);

    const room = server.coordinator.get(roomId)!;
    const names = new Map(room.members.map(member => [member.seat, member.name]));
    for (const [index, hand] of audit.hands.entries()) {
      assert.equal(hand.handNo, index + 1, '手号应从 1 开始连续递增');
      assert.match(hand.serverSeed, HEX64, '种子必须公开');
      assert.match(hand.commitment, HEX64);
      assert.match(hand.deckCommitment, HEX64);
      assert.equal(hand.verification.valid, true, hand.verification.errors.join('|'));
      assert.equal(hand.dealMatches, true, hand.dealErrors.join('|'));
      assert.deepEqual([...hand.seats].sort((a: number, b: number) => a - b), hand.seats, '座位升序');
      const seats = hand.contributions.map(([seat]: [number, string]) => seat);
      assert.deepEqual([...seats].sort((a: number, b: number) => a - b), seats, '贡献按座位升序');
      assert.deepEqual(
        hand.contributions.map(([, value]: [number, string]) => value).filter((value: string) => !HEX64.test(value)),
        [],
      );
      assert.deepEqual(
        hand.players.map((player: any) => [player.seat, player.name]),
        hand.seats.map((seat: number) => [seat, names.get(seat)]),
        '核验报告给出每个座位的名字',
      );
      for (const player of hand.players) {
        assert.equal(player.hole.length === 0 || player.hole.length === 2, true);
      }
    }

    const showdown = audit.hands.find((hand: any) => hand.board.length === 5);
    assert.ok(showdown !== undefined, '应有一手打到摊牌');
    assert.equal(showdown.burned.length, 3, '摊牌的一手要烧三张牌');
    assert.equal(showdown.players.every((player: any) => player.hole.length === 2), true, '摊牌后底牌全部公开');

    const finish = audit.events.find((event: any) => event.type === 'finish');
    assert.ok(finish !== undefined, '事件流应记录比赛结束');
    assert.match(finish.text, /比赛结束/);
    assert.ok(audit.notes.length >= 3, '必须写清核验证明了什么、不能证明什么');
    assert.ok(audit.notes.some((note: string) => note.includes('不能证明')));
  });

  it('核验响应按契约给出 rounds 与汇总 verification（客户端直接拿它复算）', async () => {
    const {roomId, players} = await playedMatch();
    const audit = (await server.audit(players[0]!, roomId)).body;

    assert.equal(audit.rounds.length, audit.completedHands);
    assert.equal(audit.verification.valid, true, audit.verification.errors.join('|'));
    assert.deepEqual(audit.verification.errors, []);
    assert.equal(audit.verification.valid, audit.valid, '汇总与旧字段必须一致');

    for (const [index, round] of audit.rounds.entries()) {
      assert.equal(round.handNo, index + 1);
      assert.equal(round.matchId, audit.matchId, '每手都要能对上比赛标识，客户端靠它复算承诺');
      assert.equal(round.version, 'hmac-sha256-fy-v1');
      assert.match(round.serverSeed, HEX64);
      assert.match(round.commitment, HEX64);
      assert.match(round.deckCommitment!, HEX64);
      assert.deepEqual([...round.seats].sort((a: number, b: number) => a - b), round.seats, '座位升序');

      // 客户端按对象取值（round.contributions[seat]），元组数组会让复算全错。
      assert.equal(Array.isArray(round.contributions), false, '贡献必须是对象而不是 [seat, nonce] 数组');
      assert.deepEqual(
        Object.keys(round.contributions).sort(),
        round.seats.map(String).sort(),
        '每个座位都要有一条贡献（缺席者为全零）',
      );
      const contributions: Record<string, string> = round.contributions;
      for (const value of Object.values(contributions)) assert.match(value, HEX64, '贡献必须是 64 位十六进制');
    }
  });

  it('被篡改的种子会被核验抓出来', async () => {
    const {roomId, players} = await playedMatch();
    const healthy = await server.audit(players[0]!, roomId);
    assert.equal(healthy.body.valid, true);

    const room = server.coordinator.get(roomId)!;
    const record = room.fairnessHistory[0]!;
    const original = record.round.serverSeed;
    record.round = {...record.round, serverSeed: (original[0] === 'a' ? 'b' : 'a') + original.slice(1)};

    const tampered = await server.audit(players[0]!, roomId);
    assert.equal(tampered.body.valid, false);
    assert.equal(tampered.body.verification.valid, false, '汇总也要跟着判不过');
    assert.ok(
      tampered.body.verification.errors.some((error: string) => error.includes('第 1 手') && error.includes('种子承诺不匹配')),
      tampered.body.verification.errors.join('|'),
    );
    assert.ok(
      tampered.body.hands[0].verification.errors.includes('种子承诺不匹配'),
      tampered.body.hands[0].verification.errors.join('|'),
    );
    assert.equal(tampered.body.hands[1].verification.valid, true, '只影响被动过的那一手');
  });

  it('被篡改的牌序会被发牌复算抓出来', async () => {
    const {roomId, players} = await playedMatch();
    const room = server.coordinator.get(roomId)!;
    const record = room.fairnessHistory[0]!;
    // Swap the first two cards: the committed deck no longer explains the deal.
    const deck = [...record.deck];
    [deck[0], deck[1]] = [deck[1]!, deck[0]!];
    record.deck = deck;

    const tampered = await server.audit(players[0]!, roomId);
    const hand = tampered.body.hands[0];
    // The commitment chain is untouched, so the round itself still verifies: it is the
    // deal replay that catches this, and the report as a whole is invalid.
    assert.equal(hand.verification.valid, true);
    assert.equal(hand.dealMatches, false);
    assert.ok(hand.dealErrors.includes('实际发出的牌与承诺牌序不一致'), hand.dealErrors.join('|'));
    assert.equal(tampered.body.valid, false);
    assert.equal(tampered.body.hands[1].dealMatches, true, '只影响被动过的那一手');
  });

  it('打完一整场，房间快照仍然有界，而完整历史留给核验', async () => {
    const {roomId, players} = await playedMatch();
    const room = server.coordinator.get(roomId)!;
    const view = (await server.view(players[0]!, roomId));

    // The live view is trimmed (events and finished hands) so a long match never makes
    // every response — or every cached replay — grow with the number of hands played.
    assert.equal(view.events.length <= EVENTS_VIEW_CAP, true);
    assert.equal(view.fairness.history.length, Math.min(HISTORY_VIEW_CAP, room.fairnessHistory.length));
    assert.equal(room.fairnessHistory.length, room.tournament!.completedHands, '存储里的历史是一整场');
    assert.ok(JSON.stringify(view).length < 64 * 1024, `视图应保持小巧，实际 ${JSON.stringify(view).length}`);

    const idempotencyBytes = room.idempotency.reduce((total, [, record]) => total + record.viewJson.length, 0);
    assert.ok(idempotencyBytes <= IDEMPOTENCY_MAX_BYTES, `幂等缓存应有体积上限，实际 ${idempotencyBytes}`);
    assert.ok(JSON.stringify(room).length < 512 * 1024, `房间快照应有界，实际 ${JSON.stringify(room).length}`);

    // Nothing was lost: the audit still shows every hand of the match.
    const audit = (await server.audit(players[0]!, roomId)).body;
    assert.equal(audit.hands.length, room.fairnessHistory.length);
  });

  it('缺少发牌记录也算核验不过', async () => {
    const {roomId, players} = await playedMatch();
    const room = server.coordinator.get(roomId)!;
    room.fairnessHistory[0]!.dealt = null;

    const result = await server.audit(players[0]!, roomId);
    assert.equal(result.body.valid, false);
    assert.ok(result.body.hands[0].verification.errors.includes('缺少发牌记录'));
    assert.equal(result.body.hands[0].dealMatches, false);
  });
});
