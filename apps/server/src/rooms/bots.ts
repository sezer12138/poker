import {playerView, timeoutAction} from '../../../../packages/poker-engine/src/index.ts';
import {chooseAction} from '../../../../packages/bot/src/index.ts';
import type {Action, Hand, SeatId} from '../../../../packages/poker-engine/src/index.ts';
import {applySeatAction, pauseMatch} from './commands.ts';
import type {CommandContext} from './commands.ts';
import type {PersistedRoom} from '../storage/storage.ts';

/**
 * A bot decides from exactly the view a seated human would get, so it can never
 * act on information the table does not have. Any failure falls back to the
 * timeout action, and a failure of that pauses the hand instead of guessing.
 */
export function applyBotAction(room: PersistedRoom, seat: SeatId, ctx: CommandContext): void {
  const hand: Hand | null = room.tournament?.hand ?? null;
  if (hand === null || hand.street === 'settled' || hand.actor !== seat) return;

  let action: Action;
  try {
    action = chooseAction(playerView(hand, seat), ctx.random);
  } catch (error) {
    ctx.log?.(`机器人（座位 ${seat}）决策失败，改为超时动作`, error);
    action = timeoutAction(hand);
  }

  try {
    applySeatAction(room, seat, action, ctx, 'bot');
  } catch (error) {
    ctx.log?.(`机器人（座位 ${seat}）动作被拒绝，改为超时动作`, error);
    try {
      applySeatAction(room, seat, timeoutAction(hand), ctx, 'timeout');
    } catch (fatal) {
      pauseMatch(room, ctx, fatal);
    }
  }
}
