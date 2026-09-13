import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {applyDeal, applySeatAction} from '../src/rooms/commands.ts';
import type {CommandContext} from '../src/rooms/commands.ts';
import {blindLevel, createTournament} from '../../../packages/poker-engine/src/index.ts';
import type {Tournament} from '../../../packages/poker-engine/src/index.ts';
import {contribute, createRound, finalizeRound} from '../../../packages/fairness/src/index.ts';
import type {Card} from '../../../packages/poker-engine/src/index.ts';
import type {FairnessStage, PersistedRoom} from '../src/storage/storage.ts';

/**
 * A hand can be over the moment it is dealt: if the blinds already put a short
 * stack all-in and nobody can bet into them, the engine settles the hand during
 * nextHand. The server must notice, or the table waits forever for an action
 * that can never be taken. This builds exactly that state.
 */
function shortStackedRoom(): {room: PersistedRoom; seats: number[]; handNo: number} {
  const seats = [0, 1];
  let completedHands = 0;
  while (blindLevel(completedHands)[1] < 20) completedHands += 1;
  const [small] = blindLevel(completedHands);
  const handNo = completedHands + 1;

  const base = createTournament(seats, 1);
  const tournament: Tournament = {
    ...base,
    completedHands,
    previousBigBlind: null,
    // Seat 0 is the big blind and can only post part of it, so it is all-in on the blind.
    entries: [
      {seat: 0, stack: small},
      {seat: 1, stack: 1000},
    ],
  };

  let round = createRound('match-short', handNo);
  round = contribute(round, 0, 'aa'.repeat(32));
  round = contribute(round, 1, 'bb'.repeat(32));
  const finalized = finalizeRound(round, seats);
  const stage: FairnessStage = {
    stage: 'dealing',
    handNo,
    seats,
    round: finalized.round,
    deck: finalized.deck as Card[],
    dealt: null,
    button: null,
    settleAcks: [],
  };

  const room: PersistedRoom = {
    v: 1,
    id: 'room-short',
    code: 'AAAAAA',
    invite: 'f'.repeat(32),
    name: '短码测试',
    version: 1,
    status: 'playing',
    hostId: 'u0',
    members: [
      {userId: 'u0', name: '甲', seat: 0, bot: false, ready: true, joinedAt: 0},
      {userId: 'u1', name: '乙', seat: 1, bot: false, ready: true, joinedAt: 0},
    ],
    matchId: 'match-short',
    tournament,
    fairnessStage: stage,
    fairnessHistory: [],
    events: [],
    seq: 0,
    idempotency: [],
    deadlines: {action: null, actionSeat: null, actionHandNo: null, contribution: null, nextHand: null},
    notice: '',
    lastActivityAt: 0,
    createdAt: 0,
  };
  return {room, seats, handNo};
}

const ctx: CommandContext = {now: 1_000_000};

describe('发牌阶段', () => {
  it('发牌即结算的短码牌局不会留下无人可行动的死局', () => {
    const {room, handNo} = shortStackedRoom();
    applyDeal(room, ctx);

    const hand = room.tournament!.hand!;
    assert.equal(hand.street, 'settled', '短码全押的牌局应在发牌时直接发完公共牌');
    assert.equal(hand.board.length, 5);
    assert.equal(room.fairnessStage!.stage, 'settled');
    assert.equal(room.fairnessStage!.dealt!.board.length, 5);

    // Either the match is over or the next hand is scheduled — never "wait for an actor" with none.
    if (room.status === 'finished') {
      assert.equal(room.deadlines.nextHand, null);
      assert.ok(room.tournament!.winner !== null);
    } else {
      assert.equal(room.deadlines.nextHand, ctx.now + 8000);
    }
    assert.equal(room.deadlines.action, null, '不能留下没有行动人的行动截止时间');
    assert.equal(room.deadlines.actionSeat, null);

    // The settle is recorded once, with the button the deal used.
    assert.equal(room.fairnessHistory.length, 1);
    assert.equal(room.fairnessHistory[0]!.handNo, handNo);
    assert.equal(room.fairnessHistory[0]!.button, hand.button);
    const texts = room.events.map(event => event.text);
    assert.ok(texts.some(text => text.startsWith(`第 ${handNo} 手结束`)), texts.join('|'));
  });

  it('已结算的一手拒绝任何后续行动', () => {
    const {room} = shortStackedRoom();
    applyDeal(room, ctx);
    assert.throws(() => applySeatAction(room, 0, {type: 'check'}, ctx, 'human'), /本手已经结束|finished/);
  });
});
