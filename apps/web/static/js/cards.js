// 牌面渲染。编码来自引擎：suit = floor(card/13)（♣♦♥♠），rank = card%13+2。
// 模块顶层不触碰 DOM；cardElement 等函数在函数体内才访问 document。

export const SUITS = [
  {index: 0, symbol: '♣', name: '梅花', color: 'black', key: 'c'},
  {index: 1, symbol: '♦', name: '方块', color: 'red', key: 'd'},
  {index: 2, symbol: '♥', name: '红桃', color: 'red', key: 'h'},
  {index: 3, symbol: '♠', name: '黑桃', color: 'black', key: 's'},
];

export const RANK_LABELS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const CARD_BACK = Object.freeze({
  hidden: true,
  label: '牌背',
  rankLabel: '',
  suitSymbol: '',
  suitName: '',
  color: 'back',
});

export function isCard(card) {
  return Number.isInteger(card) && card >= 0 && card <= 51;
}

export function cardSuit(card) {
  if (!isCard(card)) throw new RangeError('牌值必须是 0 到 51 的整数');
  return Math.floor(card / 13);
}

export function cardRank(card) {
  if (!isCard(card)) throw new RangeError('牌值必须是 0 到 51 的整数');
  return (card % 13) + 2;
}

export function cardRankLabel(card) {
  return RANK_LABELS[cardRank(card) - 2];
}

export function cardSuitSymbol(card) {
  return SUITS[cardSuit(card)].symbol;
}

export function cardSuitName(card) {
  return SUITS[cardSuit(card)].name;
}

export function cardColor(card) {
  return SUITS[cardSuit(card)].color;
}

export function cardLabel(card) {
  return `${cardRankLabel(card)}${cardSuitSymbol(card)}`;
}

export function cardName(card) {
  return `${cardSuitName(card)}${cardRankLabel(card)}`;
}

/** 渲染所需的全部信息；DOM 之外的地方（如无障碍文本）也用它。 */
export function describeCard(card) {
  return {
    hidden: false,
    card,
    suit: cardSuit(card),
    rank: cardRank(card),
    rankLabel: cardRankLabel(card),
    suitSymbol: cardSuitSymbol(card),
    suitName: cardSuitName(card),
    color: cardColor(card),
    label: cardLabel(card),
    name: cardName(card),
  };
}

export function describeBack() {
  return {...CARD_BACK};
}

export function describeEmpty() {
  return {hidden: true, empty: true, label: '空位', rankLabel: '', suitSymbol: '', suitName: '', color: 'empty'};
}

/**
 * 牌面 DOM：hidden 或非法牌值渲染背面/空位，绝不因为脏数据抛错打断整桌渲染。
 * options.small 用于公共牌等紧凑位置；options.hidden 强制背面。
 */
export function cardElement(card, options = {}) {
  const doc = globalThis.document;
  if (!doc) throw new Error('cardElement 只能在浏览器中调用');
  const description = options.hidden === true || !isCard(card) ? (options.empty ? describeEmpty() : describeBack()) : describeCard(card);
  return renderDescription(description, options);
}

export function renderDescription(description, options = {}) {
  const doc = globalThis.document;
  if (!doc) throw new Error('renderDescription 只能在浏览器中调用');
  const classes = ['card', `card--${description.color}`];
  if (description.hidden) classes.push('card--back');
  if (description.empty) classes.push('card--empty');
  if (options.small) classes.push('card--small');
  if (options.mini) classes.push('card--mini');
  const node = doc.createElement('div');
  node.className = classes.join(' ');
  node.setAttribute('aria-label', description.name ?? description.label);
  if (!description.hidden) {
    const corner = doc.createElement('span');
    corner.className = 'card__corner';
    corner.textContent = description.rankLabel + description.suitSymbol;
    const center = doc.createElement('span');
    center.className = 'card__pip';
    center.textContent = description.suitSymbol;
    node.append(corner, center);
  } else {
    const back = doc.createElement('span');
    back.className = 'card__back';
    node.append(back);
  }
  return node;
}

/** 公共牌固定 5 个槽位，未发的牌显示空位，避免牌桌跳动。 */
export function boardElements(board, options = {}) {
  const slots = [];
  for (let index = 0; index < 5; index += 1) {
    const card = Array.isArray(board) ? board[index] : undefined;
    if (isCard(card)) slots.push(cardElement(card, options));
    else slots.push(cardElement(null, {...options, hidden: true, empty: true}));
  }
  return slots;
}

export function holeElements(hole, options = {}) {
  const list = Array.isArray(hole) ? hole : [];
  if (list.length === 0) return [cardElement(null, {...options, hidden: true})];
  return list.map((card) => cardElement(card, options));
}
