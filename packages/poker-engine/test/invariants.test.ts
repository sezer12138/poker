import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, createTournament, nextHand, actTournament, legalActions, type Action, type Tournament} from '../src/index.ts';
import {referenceSeven, testRandom} from './reference.ts';

test('10,000 seeded seven-card hands agree with an independent rank/suit oracle', () => {
  const random = testRandom();
  for (let i = 0; i < 10000; i++) {
    const cards = random.deck().slice(0, 7);
    assert.deepEqual(evaluate(cards), referenceSeven(cards), `sample ${i}: ${cards}`);
  }
});

function invariant(t: Tournament, total: number): void {
  assert.equal(t.entries.reduce((sum, p) => sum + p.stack, 0), total);
  for (const p of t.entries) assert.ok(Number.isSafeInteger(p.stack) && p.stack >= 0);
  const h = t.hand;
  if (!h) return;
  assert.equal(h.players.reduce((sum, p) => sum + p.stack + p.committed, 0), total);
  for (const p of h.players) {
    for (const n of [p.stack, p.committed, p.roundBet, p.reopenBy]) assert.ok(Number.isSafeInteger(n) && n >= 0);
    if (p.actedAt !== null) assert.ok(Number.isSafeInteger(p.actedAt) && p.actedAt >= 0);
    assert.ok(p.roundBet <= p.committed);
  }
  for (const n of [h.currentBet, h.lastFullRaise, h.cursor, h.id, t.completedHands]) assert.ok(Number.isSafeInteger(n) && n >= 0);
  const dealt = [...h.players.flatMap(p => p.hole), ...h.board, ...h.burned];
  assert.equal(new Set(dealt).size, dealt.length);
  assert.deepEqual([...dealt].sort((a,b) => a-b), h.deck.slice(0, h.cursor).sort((a,b) => a-b));
  assert.equal(new Set(h.deck).size, 52);
  if (h.street === 'settled') assert.equal(h.actor, null);
  else {
    const actor = h.players.find(p => p.seat === h.actor);
    assert.ok(actor && !actor.folded && actor.stack > 0);
    const legal = legalActions(h, h.actor!);
    assert.ok(legal.fold || legal.check || legal.call !== null || legal.allIn);
  }
}

for (const mode of ['mixed', 'all-in'] as const) {
  for (let players = 2; players <= 9; players++) {
    test(`${mode}: 20 complete ${players}-player tournaments preserve every transition`, () => {
      let actions = 0;
      let hands = 0;
      for (let run = 0; run < 20; run++) {
        const random = testRandom(20260913 + players * 100 + run);
        let t = createTournament(Array.from({length: players}, (_, i) => i), run % players);
        let steps = 0;
        invariant(t, players * 1000);
        while (t.winner === null) {
          assert.ok(steps++ < 100000, `nonterminating ${mode}/${players}/${run}`);
          const before = structuredClone(t);
          const previous = t;
          if (!t.hand || t.hand.street === 'settled') t = nextHand(t, random.deck());
          else {
            const l = legalActions(t.hand, t.hand.actor!);
            const choices: Action[] = [];
            if (l.fold) choices.push({type:'fold'});
            if (l.check) choices.push({type:'check'});
            if (l.call !== null) choices.push({type:'call'});
            if (l.minRaiseTo !== null) choices.push({type:'raiseTo', amount:l.minRaiseTo});
            if (l.allIn) choices.push({type:'allIn'});
            const action: Action = mode === 'all-in'
              ? l.allIn ? {type:'allIn'} : l.call !== null ? {type:'call'} : {type:'check'}
              : choices[random.sample(choices.length)]!;
            t = actTournament(t, t.hand.actor!, action).state;
            actions++;
          }
          assert.deepEqual(previous, before);
          invariant(t, players * 1000);
        }
        assert.equal(t.entries.filter(p => p.stack > 0).length, 1);
        assert.equal(t.entries.find(p => p.seat === t.winner)!.stack, players * 1000);
        hands += t.completedHands;
      }
      console.log(`${mode} ${players} players: 20 tournaments, ${hands} hands, ${actions} actions`);
    });
  }
}
