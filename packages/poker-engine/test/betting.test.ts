import test from 'node:test';
import assert from 'node:assert/strict';
import {applyBet, legalActions, roundComplete, fullDeck, RuleError, type Hand, type Action} from '../src/index.ts';
function fixture(): Hand {
  return {id:1,players:[0,1,2].map(seat=>({seat,stack:990,roundBet:10,committed:10,folded:false,hole:[],actedAt:null,reopenBy:10})),currentBet:10,lastFullRaise:10,actor:0,button:0,bigBlindSeat:2,smallBlind:5,bigBlind:10,street:'preflop',deck:fullDeck(),cursor:0,board:[],burned:[],result:null};
}
function act(h:Hand,seat:number,a:Action):Hand { return applyBet({...h,actor:seat},seat,a); }
function hundred():Hand { const h=fixture(); h.currentBet=100; h.lastFullRaise=100; for(const p of h.players){p.roundBet=100;p.committed=100;p.reopenBy=100;} return h; }
test('full raise and rejected under-raise preserve original',()=>{const h=fixture(),before=structuredClone(h);assert.throws(()=>applyBet(h,0,{type:'raiseTo',amount:15}));assert.deepEqual(h,before);const n=applyBet(h,0,{type:'raiseTo',amount:30});assert.equal(n.players[0].stack,970);assert.equal(n.lastFullRaise,20);assert.equal(n.currentBet,30);assert.deepEqual(h,before);assert.equal(n.actor,h.actor);assert.equal(n.players[0].actedAt,30);assert.equal(n.players[0].reopenBy,20);});
test('cumulative short all-ins reopen at the saved full raise threshold',()=>{let h=hundred();h=act(h,0,{type:'check'});h.players[1].stack=50;h=act(h,1,{type:'allIn'});assert.equal(legalActions({...h,actor:0},0).allIn,false);assert.throws(()=>act(h,0,{type:'allIn'}));assert.equal(h.lastFullRaise,100);h.players[2].stack=100;h=act(h,2,{type:'allIn'}); // add a responsive fourth player
h.players.push({...h.players[0],seat:3,actedAt:null});assert.equal(legalActions({...h,actor:0},0).minRaiseTo,300);});
test('calling 150 resets threshold so 200 does not reopen',()=>{let h=hundred();h=act(h,0,{type:'check'});h.players[1].stack=50;h=act(h,1,{type:'allIn'});h=act(h,0,{type:'call'});h.players[2].stack=100;h=act(h,2,{type:'allIn'});h.players.push({...h.players[0],seat:3,actedAt:null});assert.equal(legalActions({...h,actor:0},0).minRaiseTo,null);assert.equal(h.players[0].actedAt,150);assert.equal(h.players[0].reopenBy,100);});
test('short opening all-in can be completed to big blind; checking does not unconditionally reopen',()=>{let h=fixture();h.currentBet=0;h.street='flop';for(const p of h.players){p.roundBet=0;p.committed=0;}h=act(h,0,{type:'check'});h.players[1].stack=5;h=act(h,1,{type:'allIn'});assert.equal(legalActions({...h,actor:2},2).minRaiseTo,10);assert.equal(legalActions({...h,actor:0},0).minRaiseTo,null);h=act(h,2,{type:'raiseTo',amount:10});assert.equal(h.lastFullRaise,10);assert.equal(legalActions({...h,actor:0},0).minRaiseTo,20);});
test('short big blind retains nominal preflop call and raise',()=>{const h=fixture();h.players[2].stack=0;h.players[2].roundBet=3;h.players[0].roundBet=5;assert.equal(legalActions(h,0).call,5);assert.equal(legalActions(h,0).minRaiseTo,20);});
test('unraised big blind has action; all active players must act and match',()=>{let h=fixture();h=act(h,0,{type:'check'});h=act(h,1,{type:'check'});assert.equal(roundComplete(h),false);h=act(h,2,{type:'check'});assert.equal(roundComplete(h),true);});
test('lone non-all-in player owes call but cannot add unmatched wagers',()=>{const h=fixture();h.players[1].stack=0;h.players[2].stack=0;h.players[0].roundBet=5;const l=legalActions(h,0);assert.equal(l.call,5);assert.equal(l.minRaiseTo,null);assert.equal(l.allIn,false);assert.equal(roundComplete(h),false);assert.equal(roundComplete(applyBet(h,0,{type:'call'})),true);});
test('short all-in call and under-minimum raise spend entire stack only',()=>{let h=fixture();h.players[0].roundBet=0;h.players[0].stack=4;assert.equal(legalActions(h,0).call,4);h=applyBet(h,0,{type:'call'});assert.equal(h.players[0].stack,0);assert.equal(h.currentBet,10);h=fixture();h.players[0].stack=5;assert.equal(legalActions(h,0).minRaiseTo,null);assert.equal(legalActions(h,0).allIn,true);h=applyBet(h,0,{type:'raiseTo',amount:15});assert.equal(h.currentBet,15);assert.equal(h.lastFullRaise,10);});
test('invalid actions, seats and out-of-turn access reject without mutation',()=>{const h=fixture(),before=structuredClone(h);for(const amount of [NaN,Infinity,15.5,-1,1001])assert.throws(()=>applyBet(h,0,{type:'raiseTo',amount}),RuleError);for(const a of [null,{}, {type:'unknown'}])assert.throws(()=>applyBet(h,0,a as Action),RuleError);for(const seat of [NaN,0.5,-1,9])assert.throws(()=>legalActions(h,seat),RuleError);assert.throws(()=>applyBet(h,1,{type:'check'}),{code:'NOT_YOUR_TURN'});assert.throws(()=>applyBet(h,0,{type:'call'}),{code:'ILLEGAL_ACTION'});assert.throws(()=>applyBet({...h,street:'settled'},0,{type:'check'}),{code:'HAND_FINISHED'});assert.deepEqual(h,before);});
test('full raise reopens action and records its new increment', () => {
  let h = fixture();
  h = act(h, 0, {type:'check'});
  h = act(h, 1, {type:'raiseTo', amount:40});
  const legal = legalActions({...h, actor:0}, 0);
  assert.equal(legal.minRaiseTo, 70);
  assert.equal(h.players[1].actedAt, 40);
  assert.equal(h.players[1].reopenBy, 30);
  assert.equal(roundComplete(h), false);
  assert.throws(() => act(h, 0, {type:'check'}), {code:'ILLEGAL_ACTION'});
});
test('fold preserves chips and completes when only one player remains', () => {
  let h = fixture();
  h = act(h, 0, {type:'fold'});
  assert.equal(h.players[0].stack, 990);
  assert.equal(h.players[0].committed, 10);
  assert.equal(h.players[0].folded, true);
  assert.throws(() => act(h, 0, {type:'check'}), {code:'ILLEGAL_ACTION'});
  h = act(h, 1, {type:'fold'});
  assert.equal(roundComplete(h), true);
});
test('all-in call remains available with closed raising rights', () => {
  const h = hundred();
  h.currentBet = 150;
  h.players[0].actedAt = 100;
  h.players[0].stack = 25;
  assert.equal(legalActions(h, 0).allIn, true);
  const n = applyBet(h, 0, {type:'allIn'});
  assert.equal(n.players[0].stack, 0);
  assert.equal(n.players[0].roundBet, 125);
  assert.equal(n.currentBet, 150);
  assert.equal(n.lastFullRaise, 100);
});
