import test from 'node:test';
import assert from 'node:assert/strict';
import {startHand, fullDeck, playerView, act} from '../src/index.ts';

test('views whitelist recursively and allow actions only for actor',()=>{
  const h=startHand([{seat:0,stack:1000},{seat:1,stack:1000}],0,[5,10],fullDeck(),1);
  const v=playerView(h,0);
  assert.deepEqual(v.players[0]!.hole,h.players[0]!.hole);
  assert.deepEqual(v.players[1]!.hole,[]);
  assert.notEqual(v.legal,null);
  assert.equal(playerView(h,1).legal,null);
  assert.equal(playerView(h,null).legal,null);
  function check(x:unknown):void { if(x&&typeof x==='object') for(const [k,v] of Object.entries(x)){assert.ok(!['deck','burned','cursor','actedAt','reopenBy'].includes(k));check(v);} }
  check(v);
  v.board.push(51);v.players[0]!.hole[0]=51;v.players[0]!.stack=0;
  assert.equal(h.board.length,0);assert.notEqual(h.players[0]!.stack,0);
});
test('fold winner stays private, showdown shows only nonfolded hands and clones result',()=>{
  let h=startHand([{seat:0,stack:1000},{seat:1,stack:1000},{seat:2,stack:1000}],0,[5,10],fullDeck(),1);
  const folded=act(act(h,0,{type:'fold'}).state,1,{type:'fold'}).state;
  assert.ok(playerView(folded,null).players.every(p=>p.hole.length===0));
  h=act(h,0,{type:'fold'}).state;
  while(h.street!=='settled') h=act(h,h.actor!,{type:'allIn'}).state;
  const v=playerView(h,null);
  assert.equal(v.players[0]!.hole.length,0);
  assert.equal(v.players[1]!.hole.length,2);
  v.result!.pots[0]!.eligible.push(8);v.result!.awards[0]!.amount=0;
  assert.ok(!h.result!.pots[0]!.eligible.includes(8));assert.ok(h.result!.awards[0]!.amount>0);
});
test('events contain no private data and settlement result does not alias state',()=>{
  let h=startHand([{seat:0,stack:1000},{seat:1,stack:1000}],0,[5,10],fullDeck(),1);
  const transition=act(h,0,{type:'fold'});
  function check(x:unknown):void {
    if(x&&typeof x==='object') for(const [key,value] of Object.entries(x)) {
      assert.ok(!['deck','burned','hole','cursor','players'].includes(key)); check(value);
    }
  }
  check(transition.events);
  const event=transition.events.find(e=>e.type==='settled')!;
  if(event.type==='settled') event.result.awards[0]!.amount=0;
  assert.ok(transition.state.result!.awards[0]!.amount>0);
});
