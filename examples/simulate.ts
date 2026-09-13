import {createTournament, nextHand, actTournament, legalActions, fullDeck, type Action} from '../packages/poker-engine/src/index.ts';

console.log('开发演示，固定牌序，不用于真实对局（不安全、非生产用途）');
let tournament = createTournament([0, 1, 2], 0);
let steps = 0;
while (tournament.winner === null) {
  if (++steps > 100000) throw new Error('Developer demo exceeded its transition limit');
  if (!tournament.hand || tournament.hand.street === 'settled') {
    const deck = fullDeck();
    const offset = tournament.completedHands % 52;
    tournament = nextHand(tournament, [...deck.slice(offset), ...deck.slice(0, offset)]);
    console.log(`手号 ${tournament.hand!.id}`);
  } else {
    const hand = tournament.hand;
    const legal = legalActions(hand, hand.actor!);
    const action: Action = legal.allIn ? {type:'allIn'} : legal.call !== null ? {type:'call'} : {type:'check'};
    const transition = actTournament(tournament, hand.actor!, action);
    for (const event of transition.events) console.log(JSON.stringify(event));
    tournament = transition.state;
  }
}
console.log(`最后胜者：座位 ${tournament.winner}，筹码 ${tournament.entries.find(p => p.seat === tournament.winner)!.stack}`);
