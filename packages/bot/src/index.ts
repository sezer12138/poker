import type {Action, HandView} from '../../poker-engine/src/index.ts';
import {secureRandom} from './random.ts';
import {decide} from './strategy.ts';
import {assertLegal, readView} from './validate.ts';

export * from './validate.ts';
export * from './strategy.ts';
export * from './random.ts';

/**
 * Picks one legal action for the seat this view belongs to. The bot only sees
 * what that seat may see, and the caller still re-validates with the engine.
 */
export function chooseAction(view: HandView, random: () => number = secureRandom): Action {
  const facts = readView(view);
  const action = decide(facts, random);
  assertLegal(facts, action);
  return action;
}
