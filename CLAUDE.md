# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

A WeChat Texas Hold'em product, built in stages. **Only stage 1 exists in code**: `packages/poker-engine`, a pure no-limit elimination-tournament rules engine. Everything else is specified but unimplemented:

- `docs/superpowers/specs/2026-09-13-wechat-poker-design.md` — confirmed product design (rules, rooms, fairness protocol, WeChat client).
- `docs/product/contract.md` — frozen interface contract for the next stage (HTTP/WS protocol, `RoomView`, `packages/fairness`, `packages/bot`). Treat as authoritative for those interfaces.
- `docs/product/implementation-plan.md` — remaining work items A–F (`packages/fairness`, `packages/bot`, `apps/web`, `apps/wechat`, `apps/server`).
- `docs/verification/` — dated reports of what was actually run, with command output and timings.

Prose docs, code comments, and error messages are Chinese. Commit messages are conventional commits (`feat:`/`fix:`/`test:`/`docs:`/`chore:`). Work has been happening on the `codex/poker-engine-implementation` branch.

## Commands

```sh
npm ci                          # required before typecheck; tests run without it
npm test                        # packages/poker-engine/test/*.test.ts (not recursive)
npm run test:exhaustive         # packages/poker-engine/test/exhaustive/*.test.ts — separate, ~4s
npm run typecheck               # tsc --noEmit
npm run demo                    # examples/simulate.ts
node --test packages/poker-engine/test/pots.test.ts   # single test file
```

Node 26 runs `.ts` directly by stripping types, so `npm test` works from a clean checkout with no `node_modules`. Type stripping does **not** typecheck — `npm run typecheck` is the only type check and needs `npm ci` first. The exhaustive suite is deliberately excluded from `npm test` because it enumerates all 2,598,960 five-card hands.

Node's glob for `npm test` is `*` (not `**`); new test files under a subdirectory will not be picked up by `npm test`.

## Architecture

Zero production dependencies. `packages/poker-engine/src/index.ts` re-exports everything; **add new exports there** — tests import only from `../src/index.ts` (or `../../src/index.ts` from `test/exhaustive/`), with explicit `.ts` extensions (required by `allowImportingTsExtensions` + `module: nodenext`).

Layering, each module depending only on those below it:

`types.ts` → `cards.ts` → `evaluate.ts` → `betting.ts` → `pots.ts` → `hand.ts` → `tournament.ts` → `view.ts`

Two state levels: `Hand` is one hand; `Tournament` wraps it and owns stack carryover, blind levels, button rotation, elimination, and `winner`. `startHand` is also callable standalone.

The engine is a pure immutable state transition: it never reads the clock, network, or a random source. Callers inject a complete, duplicate-free 52-card deck and the initial button, and receive a new state plus `EngineEvent[]`. All mutations happen on a `structuredClone`, so the input state is never touched — tests assert this on every transition.

Control flow inside a hand:

- `betting.applyBet` only moves chips and round state; it does not advance the street or choose the next actor.
- `hand.advance` owns actor selection, street dealing (burn + 3/1/1), and settlement. It loops, so it handles streets where no betting is possible (all-in run-outs) and settles immediately when only one player is live — a fold winner needs no board.
- `hand.act` = `applyBet` + `advance` and is the normal entry point.

`view.playerView(hand, seat)` is the only sanctioned leak boundary: hole cards appear only for the viewer or at a true showdown, and `legal` is non-null only for the actor. Broadcasting raw `Hand`/`Tournament` state to clients is a defect.

## Rules the code encodes (easy to get wrong)

- `{type:'raiseTo', amount}` is the **cumulative total for this round**, not an increment. Increments are a UI concern.
- Short all-ins are legal below the minimum raise but do not lower `lastFullRaise`, and they reopen betting only for players whose faced increase since their own last action (`actedAt`/`reopenBy`) has reached the full raise size. Calling resets that accumulation, so the same short all-in can reopen for one player and not another.
- Card encoding: `suit = floor(card / 13)` in `c d h s` (♣♦♥♠) order, `rank = card % 13 + 2`. Suits never compare.
- Pots are built in committed-amount layers. Unmatched excess is refunded; folded players' chips stay in the pot but those seats are ineligible. Odd chips go to tied winners clockwise from the left of the button.
- Heads-up: the button is the small blind and acts first preflop. When the table drops to two, the big blind goes to the live seat after the previous hand's big blind.
- Blinds rise every 10 completed hands and cap at 4500/9000.

## Testing conventions

`node:test` + `node:assert/strict`; there is no lint, formatter, or test framework dependency.

- `test/reference.ts` holds an independent seven-card oracle that must not call production `evaluate`/`compare` (it works from rank counts and suit sets). Its LCG is test-only and must never reach production code.
- `test/invariants.test.ts` drives complete 2–9 player tournaments with seeded random legal actions and re-checks, after every transition: chip conservation, safe non-negative integers, unique dealt cards matching the deck prefix, a legal actor, and that the previous state was not mutated. Non-termination fails the test rather than forcing a winner.
- Coverage claims are proven by running the command and pasting real output into `docs/verification/`. Where something could not be verified (WeChat device login, production storage, fairness), the docs say so explicitly instead of implying it works — follow that standard in new docs.

`Math.random`, `Date`, timers, and network/crypto calls are prohibited in `src/`; the verification report records the `rg` sweep that confirms this. Stage-2 concerns (shuffling security, timing, persistence, identity) belong to the server layer, not the engine.
