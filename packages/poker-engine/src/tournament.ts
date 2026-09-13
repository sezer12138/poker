import {act, startHand} from './hand.ts';
import {RuleError, type Action, type Card, type Hand, type SeatId, type Tournament, type Transition} from './types.ts';

const LEVELS: readonly (readonly [number, number])[] = [
  [5,10],[10,20],[15,30],[25,50],[50,100],[75,150],[100,200],
  [150,300],[250,500],[500,1000],[1000,2000],[2000,4000],[4500,9000],
];
export function blindLevel(completedHands:number):readonly [number,number] {
  if(!Number.isSafeInteger(completedHands)||completedHands<0) throw new RuleError('INVALID_INPUT','Invalid hand count.');
  const [small,big]=LEVELS[Math.min(Math.floor(completedHands/10),12)]!;
  return [small,big];
}
export function createTournament(seats:readonly SeatId[],button:SeatId):Tournament {
  if(!Array.isArray(seats)||seats.length<2||seats.length>9||new Set(seats).size!==seats.length||
    ![...seats].every(s=>Number.isInteger(s)&&s>=0&&s<=8)||!Number.isInteger(button)||!seats.includes(button)) {
    throw new RuleError('INVALID_INPUT','Invalid tournament seats.');
  }
  return {entries:seats.map(seat=>({seat,stack:1000})),button,completedHands:0,previousBigBlind:null,hand:null,winner:null};
}
function nextSeat(seats:SeatId[],after:SeatId):SeatId {
  return [...seats].sort((a,b)=>((a-after+9)%9||9)-((b-after+9)%9||9))[0]!;
}
/** Called only when installing a newly started or newly transitioned hand. */
function installHand(t:Tournament,hand:Hand):Tournament {
  const state:Tournament={...t,entries:t.entries.map(p=>({...p})),hand,button:hand.button};
  if(hand.street==='settled') {
    state.entries=state.entries.map(p=>({seat:p.seat,stack:hand.players.find(hp=>hp.seat===p.seat)?.stack??p.stack}));
    state.completedHands++;
    state.previousBigBlind=hand.bigBlindSeat;
    const live=state.entries.filter(p=>p.stack>0);
    state.winner=live.length===1?live[0]!.seat:null;
  }
  return state;
}
export function nextHand(t:Tournament,deck:readonly Card[]):Tournament {
  if(t.winner!==null) throw new RuleError('MATCH_FINISHED','Tournament is finished.');
  if(t.hand!==null&&t.hand.street!=='settled') throw new RuleError('ILLEGAL_ACTION','Current hand is active.');
  const live=t.entries.filter(p=>p.stack>0);
  const seats=live.map(p=>p.seat);
  let button=t.button;
  if(t.hand!==null) {
    if(live.length===2&&t.hand.players.length>2&&t.previousBigBlind!==null) {
      const bigBlind=nextSeat(seats,t.previousBigBlind);
      button=seats.find(s=>s!==bigBlind)!;
    } else button=nextSeat(seats,t.button);
  }
  return installHand(t,startHand(live,button,blindLevel(t.completedHands),deck,t.completedHands+1));
}
export function actTournament(t:Tournament,seat:SeatId,a:Action):Transition<Tournament> {
  if(t.winner!==null) throw new RuleError('MATCH_FINISHED','Tournament is finished.');
  if(t.hand===null||t.hand.street==='settled') throw new RuleError('HAND_FINISHED','No active hand.');
  const transition=act(t.hand,seat,a);
  return {state:installHand(t,transition.state),events:transition.events};
}
