import {legalActions} from './betting.ts';
import {RuleError, type Hand, type Legal, type Result, type SeatId, type Card, type Street} from './types.ts';

export interface HandView {
  id:number; street:Street; button:SeatId; actor:SeatId|null; board:Card[];
  players:{seat:SeatId;stack:number;roundBet:number;committed:number;folded:boolean;hole:Card[]}[];
  legal:Legal|null; result:Result|null;
}
export function playerView(h:Hand,viewer:SeatId|null):HandView {
  if(viewer!==null&&(!Number.isInteger(viewer)||viewer<0||viewer>8)) throw new RuleError('INVALID_INPUT','Invalid viewer.');
  const showdown=h.street==='settled'&&h.board.length===5&&h.players.filter(p=>!p.folded).length>1;
  const legal=viewer!==null&&viewer===h.actor?legalActions(h,viewer):null;
  return {
    id:h.id,street:h.street,button:h.button,actor:h.actor,board:[...h.board],
    players:h.players.map(p=>({seat:p.seat,stack:p.stack,roundBet:p.roundBet,committed:p.committed,folded:p.folded,
      hole:p.seat===viewer||(showdown&&!p.folded)?[...p.hole]:[]})),
    legal:legal===null?null:{fold:legal.fold,check:legal.check,call:legal.call,minRaiseTo:legal.minRaiseTo,maxRaiseTo:legal.maxRaiseTo,allIn:legal.allIn},
    result:h.result===null?null:{
      pots:h.result.pots.map(p=>({amount:p.amount,eligible:[...p.eligible]})),
      awards:h.result.awards.map(a=>({seat:a.seat,amount:a.amount})),
      refunds:h.result.refunds.map(a=>({seat:a.seat,amount:a.amount})),
    },
  };
}
