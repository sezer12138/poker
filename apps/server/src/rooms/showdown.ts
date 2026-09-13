/**
 * 结算亮牌：哪几张牌、算哪种牌型。
 *
 * 引擎是冻结的，只导出 `evaluate`（给出可比大小的排名向量，`score[0]` 就是牌型）与
 * `compare`，没有「最佳五张」也没有牌型枚举，所以这两件事在本模块补齐。纯函数：
 * 无时钟、无随机、无 IO，直接可用固定牌向量单测（见 test/showdown.test.ts）。
 *
 * 亮牌口径（产品确认）：**赢家总是亮，弃牌者不亮**。摊牌时（公共牌发满五张且不止一人
 * 未弃牌）每位未弃牌者都亮；弃牌结束时只有唯一赢家亮，且底牌不够五张时就直接亮底牌、
 * 没有牌型可算。这条口径与引擎视图一致（view.ts 里摊牌才互亮底牌），并且不把弃牌者的
 * 底牌放进任何响应——历史弃牌仍然只在整场结束后的核验页公开。
 */

import {compare, evaluate} from '../../../../packages/poker-engine/src/index.ts';
import type {Card, Hand} from '../../../../packages/poker-engine/src/index.ts';

/**
 * 牌型类别码。这是给客户端的稳定契约（见 docs/product/contract.md）：客户端按码映射
 * 中文牌型名，服务端不关心中文怎么写。顺序固定 8..0，与引擎 `evaluate` 的 `score[0]` 对应。
 */
export type Category =
  | 'straightFlush'
  | 'quads'
  | 'fullHouse'
  | 'flush'
  | 'straight'
  | 'trips'
  | 'twoPair'
  | 'pair'
  | 'highCard';

/** 一个座位亮出来的牌：摊牌时是最佳五张，不足五张时是底牌本身。 */
export interface Reveal {
  cards: Card[];
  /** 牌型类别码；不足五张时没有牌型可算，为 null。 */
  category: Category | null;
}

/** 引擎 `evaluate` 的 `score[0]` 按下标即类别码。 */
const CATEGORY_BY_SCORE: readonly Category[] = [
  'highCard',
  'pair',
  'twoPair',
  'trips',
  'straight',
  'flush',
  'fullHouse',
  'quads',
  'straightFlush',
];

/**
 * 从任意牌集中挑出最强的五张。枚举全部五张组合，每个组合交给引擎 `evaluate`（五张是
 * 合法输入），再用 `compare` 取最大。引擎里实际只会出现 2/5/6/7 张（底牌 + 公共牌），
 * 组合数最多 21，不会爆炸。不足五张返回 null —— 调用方据此回退成「直接亮底牌」。
 */
export function bestFive(cards: readonly Card[]): Card[] | null {
  if (cards.length < 5) return null;
  let best: Card[] | null = null;
  let bestScore: number[] | null = null;
  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const five = [cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!];
            const score = evaluate(five);
            if (bestScore === null || compare(score, bestScore) > 0) {
              best = five;
              bestScore = score;
            }
          }
        }
      }
    }
  }
  return best;
}

/** 排名向量 → 类别码。引擎之外的输入（空数组、越界值）一律 null，不猜。 */
export function categoryOf(score: readonly number[]): Category | null {
  const index = score[0];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 8) return null;
  return CATEGORY_BY_SCORE[index]!;
}

/**
 * 本手该亮哪些座位、亮什么。`hand` 为 null（还没开赛）或还没结算（`result` 为空）时
 * 返回空表——结算窗口之外没有人应该看到底牌。
 */
export function revealedCards(hand: Hand | null): Map<number, Reveal> {
  const reveals = new Map<number, Reveal>();
  if (hand === null || hand.result === null) return reveals;

  const live = hand.players.filter(player => !player.folded);
  // 摊牌：公共牌发满五张且不止一人未弃牌。只按牌面判断，不引入新的状态位。
  const showdown = live.length > 1 && hand.board.length === 5;
  // 弃牌结束：唯一未弃牌者收池，即便公共牌没发完也亮他的底牌（赢家总是亮）。
  const winner = live.length === 1 ? live[0]!.seat : null;

  for (const player of hand.players) {
    if (player.folded) continue;
    if (!showdown && player.seat !== winner) continue;
    const five = bestFive([...player.hole, ...hand.board]);
    const reveal: Reveal =
      five === null
        ? {cards: [...player.hole], category: null}
        : {cards: five, category: categoryOf(evaluate(five))};
    // 一张牌都没有的座位（异常状态）当作没亮，客户端会显示「未摊牌」而不是一行空白。
    if (reveal.cards.length === 0) continue;
    reveals.set(player.seat, reveal);
  }
  return reveals;
}
