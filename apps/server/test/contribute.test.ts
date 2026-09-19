import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {contributeAll, drain, nonce, readyRoom, startMatch, startTestServer} from './helpers.ts';
import type {Session, TestServer} from './helpers.ts';
import {ZERO_NONCE} from '../../../packages/fairness/src/index.ts';

const NONCE_PATTERN = /^[0-9a-f]{64}$/;

describe('随机贡献与发牌流程', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  async function startedRoom(options: {bots?: number} = {}) {
    const room = await readyRoom(server, options);
    await startMatch(server, room.roomId, room.players);
    return room;
  }

  function contribute(session: Session, roomId: string, body: Record<string, unknown>) {
    return server.command(session, roomId, {requestId: crypto.randomUUID(), type: 'contribute', ...body});
  }

  it('开始后先公布承诺，提交齐全才发牌', async () => {
    const {roomId, players} = await startedRoom();
    const opened = (await server.view(players[0]!, roomId));

    assert.equal(opened.fairness.stage, 'collecting');
    assert.match(opened.fairness.commitment, NONCE_PATTERN);
    assert.equal(opened.fairness.deckCommitment, null, '定案前不应有牌序承诺');
    assert.equal(opened.hand, null, '定案前不应发牌');
    assert.deepEqual(opened.fairness.expected, [0, 1]);
    assert.deepEqual(opened.fairness.contributors, []);

    const first = await contribute(players[0]!, roomId, {nonce: nonce(), handNo: opened.fairness.handNo});
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.fairness.contributors, [0]);
    assert.equal(first.body.hand, null, '还有人没提交，不应发牌');

    const second = await contribute(players[1]!, roomId, {nonce: nonce(), handNo: opened.fairness.handNo});
    assert.equal(second.status, 200);
    await drain();
    const dealt = (await server.view(players[0]!, roomId));
    assert.equal(dealt.fairness.stage, 'playing');
    assert.match(dealt.fairness.deckCommitment, NONCE_PATTERN);
    assert.equal(dealt.hand.street, 'preflop');
    assert.equal(dealt.hand.players.find((player: any) => player.seat === 0).hole.length, 2);
  });

  it('同一座位重复提交被拒绝', async () => {
    const {roomId, players} = await startedRoom();
    const view = (await server.view(players[0]!, roomId));
    const handNo = view.fairness.handNo;

    assert.equal((await contribute(players[0]!, roomId, {nonce: nonce(), handNo})).status, 200);
    const again = await contribute(players[0]!, roomId, {nonce: nonce(), handNo});
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_CONTRIBUTED');
  });

  it('手号不匹配或窗口关闭后提交被拒绝', async () => {
    const {roomId, players} = await startedRoom();
    const view = (await server.view(players[0]!, roomId));

    const wrongHand = await contribute(players[0]!, roomId, {nonce: nonce(), handNo: view.fairness.handNo + 1});
    assert.equal(wrongHand.status, 409);
    assert.equal(wrongHand.body.error.code, 'CONTRIBUTE_CLOSED');

    const badNonce = await contribute(players[0]!, roomId, {nonce: 'A'.repeat(64), handNo: view.fairness.handNo});
    assert.equal(badNonce.status, 400);
    assert.equal(badNonce.body.error.code, 'INVALID_INPUT');

    const shortNonce = await contribute(players[0]!, roomId, {nonce: 'ab', handNo: view.fairness.handNo});
    assert.equal(shortNonce.status, 400);

    const noHand = await contribute(players[0]!, roomId, {nonce: nonce()});
    assert.equal(noHand.status, 400);
  });

  it('贡献命令忽略 expectedVersion（客户端无需重取版本）', async () => {
    const {roomId, players} = await startedRoom();
    const view = (await server.view(players[0]!, roomId));

    const stale = await server.command(players[0]!, roomId, {
      requestId: crypto.randomUUID(),
      expectedVersion: view.version + 99,
      type: 'contribute',
      nonce: nonce(),
      handNo: view.fairness.handNo,
    });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body.fairness.contributors, [0]);
  });

  it('机器人席位无需贡献，机器人本身也不能提交', async () => {
    const {roomId, players} = await startedRoom({bots: 2});
    const opened = (await server.view(players[0]!, roomId));
    const humanSeats = opened.members.filter((member: any) => !member.bot).map((member: any) => member.seat);
    const botSeats = opened.members.filter((member: any) => member.bot).map((member: any) => member.seat);
    assert.deepEqual(opened.fairness.expected, humanSeats, '只有真人席位需要贡献');
    assert.equal(opened.fairness.expected.includes(botSeats[0]), false);

    await contributeAll(server, roomId, players);
    const dealt = (await server.view(players[0]!, roomId));
    assert.equal(dealt.fairness.stage, 'playing');
    // Once the shuffle is fixed every seat has an entry, bots included, because the
    // zero nonce is what makes the deck reproducible by anyone.
    assert.deepEqual(dealt.fairness.contributors, [...humanSeats, ...botSeats].sort((a, b) => a - b));

    // Bot seats are filled with the public default nonce, so anyone can redo the shuffle.
    const byS: Record<number, string> = Object.fromEntries(dealt.fairness.contributions);
    for (const seat of botSeats) assert.equal(byS[seat], ZERO_NONCE);

    // A bot has no session, so the closest a human can get is a seat that is not theirs.
    const asOther = await server.command(players[0]!, roomId, {
      requestId: crypto.randomUUID(),
      type: 'contribute',
      nonce: nonce(),
      handNo: opened.fairness.handNo,
    });
    assert.equal(asOther.status, 409, '本手已经发牌，贡献窗口关闭');
    assert.equal(asOther.body.error.code, 'CONTRIBUTE_CLOSED');
  });

  it('非牌局成员（已淘汰）不能贡献', async () => {
    const {roomId, players} = await startedRoom({bots: 1});
    const view = (await server.view(players[0]!, roomId));

    const outsider = await server.guest('路人');
    const denied = await server.command(outsider, roomId, {
      requestId: crypto.randomUUID(),
      type: 'contribute',
      nonce: nonce(),
      handNo: view.fairness.handNo,
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');
  });

  it('窗口超时后缺位用零贡献补齐并照常发牌', async () => {
    const {roomId, players} = await startedRoom();
    const opened = (await server.view(players[0]!, roomId));
    const commitment = opened.fairness.commitment;

    await contribute(players[0]!, roomId, {nonce: nonce(), handNo: opened.fairness.handNo});
    await server.clock.advance(5000);
    await drain();

    const dealt = (await server.view(players[0]!, roomId));
    assert.equal(dealt.fairness.stage, 'playing');
    assert.equal(dealt.fairness.handNo, opened.fairness.handNo);
    assert.equal(dealt.fairness.commitment, commitment, '手号相同则承诺不变');
    const byS: Record<number, string> = Object.fromEntries(dealt.fairness.contributions);
    assert.equal(byS[1], ZERO_NONCE, '缺席者按公开默认贡献补齐');
    assert.equal(dealt.fairness.deadline, null);
  });

  it('定案前不泄漏任何 nonce，定案后才公开且与本人提交一致', async () => {
    const {roomId, players} = await startedRoom();
    const opened = (await server.view(players[0]!, roomId));
    const mine = nonce();

    const submitted = await contribute(players[0]!, roomId, {nonce: mine, handNo: opened.fairness.handNo});
    // Still collecting: the seat list is public, the values are not.
    assert.deepEqual(submitted.body.fairness.contributors, [0]);
    assert.deepEqual(submitted.body.fairness.contributions, []);

    await contributeAll(server, roomId, [players[1]!]);
    const dealt = (await server.view(players[0]!, roomId));
    const byS: Record<number, string> = Object.fromEntries(dealt.fairness.contributions);
    assert.equal(byS[0], mine);
    assert.match(byS[1]!, NONCE_PATTERN);
  });

  it('每手结束后写入公开的公平历史', async () => {
    const {roomId, players} = await startedRoom();
    await contributeAll(server, roomId, players);

    for (let round = 0; round < 200; round++) {
      const view = (await server.view(players[0]!, roomId));
      if (view.fairness.history.length > 0) {
        const record = view.fairness.history[0];
        assert.equal(record.handNo, 1);
        assert.match(record.commitment, NONCE_PATTERN);
        assert.match(record.deckCommitment, NONCE_PATTERN);
        assert.equal(record.contributions.length, 2);
        return;
      }
      if (view.fairness.stage === 'collecting') await contributeAll(server, roomId, players);
      const actorSeat = view.hand?.actor;
      const actor = players.find(player => {
        const seat = view.members.find((member: any) => member.userId === player.user.id)?.seat;
        return seat === actorSeat;
      });
      if (actor === undefined) {
        // 轮到机器人（思考 2500ms + 抖动）或正在结算兜底窗口：跨过足够的时钟让它推进。
        await server.clock.advance(8000);
        continue;
      }
      const actorView = (await server.view(actor, roomId));
      const legal = actorView.hand.legal;
      const action = legal.fold ? {type: 'fold'} : legal.check ? {type: 'check'} : {type: 'call'};
      await server.command(actor, roomId, {
        requestId: crypto.randomUUID(),
        expectedVersion: actorView.version,
        type: 'action',
        action,
      });
    }
    throw new Error('一手牌未能在预期轮次内结束');
  });
});
