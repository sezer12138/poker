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
import type {TestServer} from './helpers.ts';
import {reconstructDeck, sha256Hex, canonicalJson, verifyRound, ZERO_NONCE} from '../../../packages/fairness/src/index.ts';
import type {FairRound} from '../../../packages/fairness/src/index.ts';

/** Every card that reaches a client, wherever the view puts it. */
function cardsInView(view: any): number[] {
  const cards: number[] = [];
  if (view.hand !== null) {
    for (const player of view.hand.players) cards.push(...player.hole);
    cards.push(...view.hand.board);
  }
  return cards.sort((a, b) => a - b);
}

describe('公平性与信息披露', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, {storage: 'memory'});
  });
  after(async () => {
    await server.close();
  });

  async function dealtRoom(bots = 0) {
    const room = await readyRoom(server, {bots});
    await startMatch(server, room.roomId, room.players);
    await contributeAll(server, room.roomId, room.players);
    return room;
  }

  /** The persisted round for the hand in play, seeds included: server-side only. */
  function currentRound(roomId: string): FairRound {
    const room = server.coordinator.get(roomId);
    assert.ok(room?.fairnessStage?.round !== undefined, '应有进行中的公平回合');
    return room.fairnessStage.round;
  }

  it('公开的牌序承诺等于牌堆的哈希，且牌堆可以按公开信息复算', async () => {
    const {roomId} = await dealtRoom();
    const round = currentRound(roomId);
    const stage = (await server.coordinator.get(roomId)!).fairnessStage!;
    assert.equal(stage.round.deckCommitment, sha256Hex(canonicalJson(stage.deck!)));
    assert.deepEqual(reconstructDeck(round), stage.deck);
    assert.equal(verifyRound(round).valid, true);
  });

  it('种子承诺在贡献之前公布，并且能验证到具体的种子', async () => {
    const room = await readyRoom(server, {bots: 1});
    await startMatch(server, room.roomId, room.players);

    const opened = (await server.view(room.players[0]!, room.roomId));
    assert.equal(opened.fairness.stage, 'collecting');
    assert.match(opened.fairness.commitment, /^[0-9a-f]{64}$/);
    assert.equal(opened.fairness.deckCommitment, null);

    const round = currentRound(room.roomId);
    assert.equal(round.commitment, opened.fairness.commitment, '公布的承诺就是本轮记录的承诺');
    assert.equal(verifyRound(round).valid, true, '承诺能对上一个真实的种子');
  });

  it('未摊牌的底牌不出现在任何视图里，种子与牌堆也不出现', async () => {
    const {roomId, players} = await dealtRoom();
    const stage = server.coordinator.get(roomId)!.fairnessStage!;
    const deck = stage.deck!;
    const dealt = new Set<number>([
      ...Object.values(stage.dealt!.holes).flat(),
      ...stage.dealt!.board,
      ...stage.dealt!.burned,
    ]);
    const undealt = deck.filter(card => !dealt.has(card));
    assert.equal(undealt.length, 52 - dealt.size);

    for (const player of players) {
      const view = (await server.view(player, roomId));
      const ownSeat = view.you.seat;
      const visible = cardsInView(view);
      // Exactly: the board plus the viewer's own two cards. Nothing else is a card.
      const board = view.hand.board.length;
      assert.equal(visible.length, board + 2, `座位 ${ownSeat} 只应看到公共牌与自己底牌`);
      for (const card of undealt) {
        assert.equal(visible.includes(card), false, `未发出的牌 ${card} 泄漏给了座位 ${ownSeat}`);
      }
      const text = JSON.stringify(view);
      assert.equal(text.includes(stage.round.serverSeed), false, '服务器种子绝不能出现在视图里');
      assert.equal(text.includes('serverSeed'), false);
      assert.equal(text.includes(ZERO_NONCE), false, '未提交时不应回显默认贡献');
    }
  });

  it('摊牌后所有未弃牌玩家的底牌公开，弃牌玩家的底牌仍然隐藏', async () => {
    const {roomId, players} = await dealtRoom(2);
    const view = await advanceMatch(server, roomId, players, {
      policy: CALL_ALWAYS,
      until: room => room.hand?.street === 'settled',
      maxHands: 1,
    });
    assert.equal(view.hand.street, 'settled');
    assert.equal(view.hand.board.length, 5);

    const settled = server.coordinator.get(roomId)!.tournament!.hand!;
    const folded = settled.players.filter(player => player.folded).map(player => player.seat);
    const shown = settled.players.filter(player => !player.folded).map(player => player.seat);

    if (shown.length > 1) {
      for (const seat of shown) {
        const card = view.hand.players.find((player: any) => player.seat === seat);
        assert.equal(card.hole.length, 2, `摊牌后座位 ${seat} 的底牌应公开`);
      }
    }
    for (const player of players) {
      const mine = (await server.view(player, roomId));
      for (const seat of folded) {
        if (seat === mine.you.seat) continue;
        assert.deepEqual(
          mine.hand.players.find((item: any) => item.seat === seat).hole,
          [],
          `弃牌玩家的底牌不应公开`,
        );
      }
    }
  });

  it('篡改任何一部分都会被核验发现', async () => {
    const {roomId} = await dealtRoom();
    const round = currentRound(roomId);

    const flipped = {...round, serverSeed: round.serverSeed.replace(/^./, round.serverSeed[0] === 'a' ? 'b' : 'a')};
    const seedCheck = verifyRound(flipped);
    assert.equal(seedCheck.valid, false);
    assert.ok(seedCheck.errors.includes('种子承诺不匹配'), seedCheck.errors.join('|'));

    const tamperedContributions: FairRound = {
      ...round,
      contributions: {...round.contributions, ...(Object.keys(round.contributions).length > 0
        ? {[Object.keys(round.contributions)[0]!]: ZERO_NONCE}
        : {0: ZERO_NONCE})},
    };
    const deckCheck = verifyRound(tamperedContributions);
    assert.equal(deckCheck.valid, false);
    assert.ok(
      deckCheck.errors.some(error => error.includes('牌序承诺')),
      deckCheck.errors.join('|'),
    );
  });

  it('首手庄位由已承诺的牌堆决定，重放同一牌堆得到同一庄位', async () => {
    const first = await dealtRoom();
    const second = await dealtRoom();

    const a = server.coordinator.get(first.roomId)!;
    const b = server.coordinator.get(second.roomId)!;
    // Same server-side rule the audit uses: the button is a pure function of the deck.
    const buttonFrom = (deck: readonly number[], seats: readonly number[]): number => {
      const limit = Math.floor(2704 / seats.length) * seats.length;
      for (let index = 0; index + 1 < deck.length; index += 2) {
        const value = deck[index]! * 52 + deck[index + 1]!;
        if (value < limit) return seats[value % seats.length]!;
      }
      return seats[0]!;
    };
    assert.equal(a.tournament!.hand!.button, buttonFrom(a.fairnessStage!.deck!, a.fairnessStage!.seats));
    assert.equal(b.tournament!.hand!.button, buttonFrom(b.fairnessStage!.deck!, b.fairnessStage!.seats));

    // Same match id and hand number always shuffle the same way: replayable.
    const replayed = reconstructDeck({...a.fairnessStage!.round});
    assert.deepEqual(replayed, a.fairnessStage!.deck);
  });

  it('每手结束后公开的承诺与历史记录一一对应', async () => {
    const {roomId, players} = await dealtRoom();
    const actor = await waitingActor(server, roomId, players);
    const commitment = (await server.view(players[0]!, roomId)).fairness.commitment;
    await act(server, roomId, actor!.session, {type: 'fold'});

    const view = (await server.view(players[0]!, roomId));
    assert.equal(view.fairness.history.length, 1);
    assert.equal(view.fairness.history[0].commitment, commitment);

    const stage = server.coordinator.get(roomId)!.fairnessHistory[0]!;
    assert.equal(stage.round.commitment, commitment);
    assert.equal(verifyRound(stage.round).valid, true);
    assert.equal(sha256Hex(canonicalJson(stage.deck)), stage.round.deckCommitment);
  });
});
