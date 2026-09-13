import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANK_LABELS,
  SUITS,
  boardElements,
  cardColor,
  cardLabel,
  cardName,
  cardRank,
  cardRankLabel,
  cardSuit,
  cardSuitName,
  cardSuitSymbol,
  describeBack,
  describeCard,
  isCard,
} from '../static/js/cards.js';

test('四种花色按 ♣♦♥♠ 顺序解码，且颜色正确', () => {
  assert.deepEqual(SUITS.map((suit: {symbol: string}) => suit.symbol), ['♣', '♦', '♥', '♠']);
  assert.equal(cardSuit(0), 0);
  assert.equal(cardSuit(12), 0);
  assert.equal(cardSuit(13), 1);
  assert.equal(cardSuit(26), 2);
  assert.equal(cardSuit(39), 3);
  assert.equal(cardSuit(51), 3);
  assert.equal(cardSuitSymbol(0), '♣');
  assert.equal(cardSuitSymbol(13), '♦');
  assert.equal(cardSuitSymbol(26), '♥');
  assert.equal(cardSuitSymbol(39), '♠');
  assert.equal(cardSuitName(13), '方块');
  assert.equal(cardSuitName(26), '红桃');
  assert.equal(cardColor(0), 'black');
  assert.equal(cardColor(13), 'red');
  assert.equal(cardColor(26), 'red');
  assert.equal(cardColor(39), 'black');
});

test('点数按 card % 13 + 2 解码，含 A/K/Q/J/10', () => {
  assert.equal(cardRank(0), 2);
  assert.equal(cardRank(8), 10);
  assert.equal(cardRank(9), 11);
  assert.equal(cardRank(10), 12);
  assert.equal(cardRank(11), 13);
  assert.equal(cardRank(12), 14);
  assert.equal(cardRankLabel(9), 'J');
  assert.equal(cardRankLabel(10), 'Q');
  assert.equal(cardRankLabel(11), 'K');
  assert.equal(cardRankLabel(12), 'A');
  assert.equal(cardLabel(12), 'A♣');
  assert.equal(cardLabel(8), '10♣');
  assert.equal(cardLabel(51), 'A♠');
  assert.equal(cardName(51), '黑桃A');
  assert.equal(RANK_LABELS.length, 13);
});

test('整副 52 张牌都能渲染出非空标签，且无重复', () => {
  const labels = new Set<string>();
  for (let card = 0; card < 52; card += 1) {
    assert.ok(isCard(card));
    const described = describeCard(card);
    assert.equal(described.label, `${described.rankLabel}${described.suitSymbol}`);
    assert.ok(described.label.length >= 2);
    labels.add(described.label);
  }
  assert.equal(labels.size, 52);
});

test('牌背与空位描述稳定', () => {
  const back = describeBack();
  assert.equal(back.hidden, true);
  assert.equal(back.color, 'back');
  assert.equal(back.label, '牌背');
  assert.equal(back.suitSymbol, '');
  assert.notEqual(back, describeBack());
});

test('非法牌值被拒绝，isCard 是唯一判定入口', () => {
  assert.equal(isCard(52), false);
  assert.equal(isCard(-1), false);
  assert.equal(isCard(1.5), false);
  assert.equal(isCard('7'), false);
  assert.equal(isCard(null), false);
  assert.throws(() => cardLabel(52), RangeError);
  assert.throws(() => cardSuit(-1), RangeError);
});

test('牌面 DOM 只在浏览器中构造：Node 下抛错而不是静默失败', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const back = describeBack();
  assert.equal(back.hidden, true);
  assert.throws(() => boardElements([0, 1, 2]), /只能在浏览器中调用/);
});
