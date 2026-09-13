import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../../../packages/poker-engine/src/index.ts';
import {bestFive, categoryOf, revealedCards} from '../src/rooms/showdown.ts';
import type {Card, Hand, Player} from '../../../packages/poker-engine/src/index.ts';

/**
 * 结算亮牌的两件事：挑出最强五张（引擎只给排名向量，不给是哪五张），以及把排名向量
 * 翻译成稳定的类别码。全部用固定牌向量断言，不依赖任何随机发牌。
 *
 * 牌编码：card = suit × 13 + (rank − 2)，花色 0=♣ 1=♦ 2=♥ 3=♠。
 */
describe('结算亮牌', () => {
  const CATEGORIES = [
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

  /** 把五张牌化成升序点数，用来做「是哪几张」的稳健断言（不关心顺序与同点数的花色）。 */
  function ranks(cards: readonly Card[]): number[] {
    return cards.map(card => (card % 13) + 2).sort((a, b) => a - b);
  }

  function categoryOfCards(cards: readonly Card[]): string | null {
    return categoryOf(evaluate(cards));
  }

  /** 一手已经结算的手牌，字段齐全，测试只关心 players 与 board。 */
  function settledHand(players: {seat: number; hole: Card[]; folded: boolean}[], board: Card[]): Hand {
    return {
      id: 1,
      players: players.map(
        (item): Player => ({
          seat: item.seat,
          stack: 1000,
          roundBet: 0,
          committed: 0,
          folded: item.folded,
          hole: item.hole,
          actedAt: null,
          reopenBy: 0,
        }),
      ),
      button: 0,
      bigBlindSeat: 1,
      smallBlind: 5,
      bigBlind: 10,
      street: 'settled',
      actor: null,
      currentBet: 0,
      lastFullRaise: 0,
      deck: [],
      cursor: 0,
      board,
      burned: [],
      result: {pots: [{amount: 100, eligible: [0, 1]}], awards: [{seat: 0, amount: 100}], refunds: []},
    };
  }

  it('不足五张时挑不出五张', () => {
    assert.equal(bestFive([]), null);
    assert.equal(bestFive([3, 4]), null);
    assert.equal(bestFive([3, 4, 5, 6]), null, '转牌前只有四张公共牌，凑不满五张');
  });

  it('正好五张时原样返回并给出类别码', () => {
    // ♥9 ♥T ♥J ♥Q ♥K —— 同一花色且连续，是 9 到 K 的同花顺。
    const five: Card[] = [33, 34, 35, 36, 37];
    const best = bestFive(five);
    assert.deepEqual(best, five);
    assert.equal(categoryOfCards(best!), 'straightFlush');
  });

  it('七张里挑出最优五张：同花压过顺子', () => {
    // ♥A ♥2 ♥Q ♥J ♥T ♣J ♦3：既有 A-Q-J-T 的顺子雏形，也有五张红桃。
    // 同花（5）比顺子（4）大，所以必须挑红桃那五张。
    const seven: Card[] = [38, 26, 36, 35, 34, 11, 14];
    const best = bestFive(seven);
    assert.ok(best !== null);
    assert.deepEqual(ranks(best!), [2, 10, 11, 12, 14], '红桃 A-Q-J-T-2，不是 A-K-Q-J-T 那个顺子');
    assert.equal(categoryOfCards(best!), 'flush');

    const suits = best!.map(card => Math.floor(card / 13));
    assert.deepEqual([...new Set(suits)], [2], '五张必须同花色');
  });

  it('七张里挑出最优五张：四条压过葫芦', () => {
    // 9♠ 9♥ 9♦ 9♣ K♠ K♥ 2♦：既能凑四条带 K，也能凑 999KK 的葫芦，四条更大。
    const seven: Card[] = [46, 33, 20, 7, 50, 37, 13];
    const best = bestFive(seven);
    assert.ok(best !== null);
    assert.deepEqual(ranks(best!), [9, 9, 9, 9, 13], '四张 9 带一张 K');
    assert.equal(categoryOfCards(best!), 'quads');
  });

  it('六张（转牌后结束）也能挑出最优五张', () => {
    // ♥A ♦A ♣J ♠Q ♥J ♦2：两对 A 与 J，带 Q 踢脚。
    const six: Card[] = [38, 25, 9, 49, 35, 13];
    const best = bestFive(six);
    assert.ok(best !== null);
    assert.deepEqual(ranks(best!), [11, 11, 12, 14, 14], 'A A J J Q');
    assert.equal(categoryOfCards(best!), 'twoPair');
  });

  it('九个类别码映射完整且稳定', () => {
    const scores: [number[], string][] = [
      [[8, 14], 'straightFlush'],
      [[7, 9, 14], 'quads'],
      [[6, 9, 5], 'fullHouse'],
      [[5, 14, 12, 10, 8, 3], 'flush'],
      [[4, 9], 'straight'],
      [[3, 9, 14, 12], 'trips'],
      [[2, 14, 9, 12], 'twoPair'],
      [[1, 14, 12, 10, 8], 'pair'],
      [[0, 14, 12, 10, 8, 3], 'highCard'],
    ];
    for (const [score, category] of scores) {
      assert.equal(categoryOf(score), category, `score[0]=${score[0]} 应映射为 ${category}`);
    }
    // 覆盖到全部九个，一个不漏：少一个客户端就会有牌型显示不出来。
    assert.deepEqual(
      scores.map(([, category]) => category).sort(),
      [...CATEGORIES].sort(),
    );
  });

  it('非法排名向量一律不猜', () => {
    assert.equal(categoryOf([]), null);
    assert.equal(categoryOf([9]), null, '引擎只会给出 0..8');
    assert.equal(categoryOf([-1]), null);
    assert.equal(categoryOf([1.5]), null);
  });

  it('摊牌：每位未弃牌者都亮最佳五张与牌型，弃牌者不亮', () => {
    const hand = settledHand(
      [
        {seat: 0, hole: [38, 37], folded: false}, // ♥A ♥K
        {seat: 1, hole: [0, 1], folded: false}, // ♣2 ♦3
        {seat: 2, hole: [51, 50], folded: true}, // ♠A ♠K，弃牌了
      ],
      [36, 35, 34, 20, 11], // ♥Q ♥J ♥T ♦9 ♣J
    );
    const reveals = revealedCards(hand);
    assert.deepEqual([...reveals.keys()].sort(), [0, 1], '弃牌的座位 2 不该出现在亮牌表里');
    assert.equal(reveals.get(0)!.category, 'straightFlush', '♥A ♥K ♥Q ♥J ♥T');
    assert.deepEqual(ranks(reveals.get(0)!.cards), [10, 11, 12, 13, 14]);
    assert.equal(reveals.get(1)!.cards.length, 5, '凑不满五张时也永远是五张（公共牌已发满）');
    assert.ok(reveals.get(1)!.category !== null);
  });

  it('弃牌结束（翻牌前）：只亮唯一赢家的两张底牌，没有牌型', () => {
    const hand = settledHand(
      [
        {seat: 0, hole: [38, 37], folded: false},
        {seat: 1, hole: [0, 1], folded: true},
      ],
      [],
    );
    const reveals = revealedCards(hand);
    assert.deepEqual([...reveals.keys()], [0], '只亮赢家');
    assert.deepEqual(reveals.get(0)!.cards, [38, 37], '没有公共牌，直接亮底牌');
    assert.equal(reveals.get(0)!.category, null, '两张牌算不出牌型');
  });

  it('弃牌结束（翻牌后）：赢家亮最佳五张并给出牌型', () => {
    const hand = settledHand(
      [
        {seat: 0, hole: [38, 25], folded: false}, // ♥A ♦A
        {seat: 1, hole: [0, 1], folded: true},
      ],
      [11, 49, 35], // ♣K ♠Q ♥J
    );
    const reveals = revealedCards(hand);
    assert.deepEqual([...reveals.keys()], [0]);
    assert.deepEqual(ranks(reveals.get(0)!.cards), [11, 12, 13, 14, 14], 'A A K Q J');
    assert.equal(reveals.get(0)!.category, 'pair');
  });

  it('没有手牌或还没结算时，一个人都不亮', () => {
    assert.equal(revealedCards(null).size, 0);
    const pending = settledHand([{seat: 0, hole: [38, 37], folded: false}], []);
    assert.equal(revealedCards({...pending, result: null}).size, 0, '没结算就没有「结果」可看，底牌仍然保密');
  });
});
