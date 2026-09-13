import test from 'node:test';
import assert from 'node:assert/strict';
import {createTournament, blindLevel, nextHand, actTournament, fullDeck, type Tournament} from '../src/index.ts';

test('equal stacks, validation, and every blind boundary', () => {
  assert.deepEqual(createTournament([0,1,2],0).entries.map(p=>p.stack),[1000,1000,1000]);
  const levels = [[5,10],[10,20],[15,30],[25,50],[50,100],[75,150],[100,200],[150,300],[250,500],[500,1000],[1000,2000],[2000,4000],[4500,9000]];
  levels.forEach((level,i)=>{assert.deepEqual(blindLevel(i*10),level); assert.deepEqual(blindLevel(i*10+9),level);});
  assert.deepEqual(blindLevel(10000),[4500,9000]);
  for (const n of [-1,0.5,NaN]) assert.throws(()=>blindLevel(n));
  for (const seats of [[0],[0,0],[0,9]]) assert.throws(()=>createTournament(seats,0));
  assert.throws(()=>createTournament([0,1],2));
});

test('first button is preserved, active hand rejected, folds settle once', () => {
  const t=nextHand(createTournament([0,1],1),fullDeck());
  assert.equal(t.hand!.button,1);
  assert.throws(()=>nextHand(t,fullDeck()));
  const snapshot=structuredClone(t);
  const done=actTournament(t,1,{type:'fold'}).state;
  assert.deepEqual(t,snapshot);
  assert.equal(done.completedHands,1);
  assert.equal(done.previousBigBlind,0);
  assert.throws(()=>actTournament(done,1,{type:'fold'}));
  const next=nextHand(done,fullDeck());
  assert.equal(next.hand!.button,0);
  assert.equal(next.completedHands,1);
});

function settledWithStacks(seats:number[], stacks:number[]):Tournament {
  const t=nextHand(createTournament(seats,0),fullDeck());
  while(t.hand!.street!=='settled') {
    const next=actTournament(t,t.hand!.actor!,{type:'fold'}).state;
    Object.assign(t,next);
  }
  t.entries=t.entries.map((p,i)=>({...p,stack:stacks[i]!}));
  return t;
}
test('four to three rotates live button; entering heads up prioritizes next big blind',()=>{
  const three=nextHand(settledWithStacks([0,2,5,8],[1000,0,1000,2000]),fullDeck());
  assert.equal(three.button,5);
  assert.deepEqual(three.hand!.players.map(p=>p.seat),[0,5,8]);
  const two=nextHand(settledWithStacks([0,2,5],[1500,0,1500]),fullDeck());
  assert.equal(two.hand!.bigBlindSeat,0);
  assert.equal(two.button,5);
  assert.throws(()=>actTournament(two,2,{type:'allIn'}));
});
test('blind-only settlement updates bookkeeping and match winner exactly once',()=>{
  const t=createTournament([0,1],0); t.completedHands=120;
  const done=nextHand(t,fullDeck());
  assert.equal(done.hand!.street,'settled');
  assert.equal(done.completedHands,121);
  assert.equal(done.previousBigBlind,1);
  assert.deepEqual(done.entries,done.hand!.players.map(p=>({seat:p.seat,stack:p.stack})));
  assert.equal(done.entries.reduce((s,p)=>s+p.stack,0),2000);
  if(done.winner!==null) assert.throws(()=>nextHand(done,fullDeck()));
  assert.throws(()=>actTournament(done,0,{type:'fold'}));
  assert.deepEqual(createTournament([0,1],0).entries.map(p=>p.stack),[1000,1000]);
});
test('same hand can eliminate multiple players',()=>{
  let t=createTournament([0,1,2],0);
  t=nextHand(t,fullDeck());
  while(t.hand!.street!=='settled') t=actTournament(t,t.hand!.actor!,{type:'allIn'}).state;
  assert.equal(t.completedHands,1);
  assert.equal(t.entries.reduce((s,p)=>s+p.stack,0),3000);
  assert.equal(t.entries.filter(p=>p.stack===0).length,2);
  assert.notEqual(t.winner,null);
  assert.throws(()=>nextHand(t,fullDeck()));
});
