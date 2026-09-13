/**
 * 牌面渲染助手。编码来自引擎：suit = floor(card/13) 依次为 ♣ ♦ ♥ ♠，rank = card%13+2。
 * 未公开的底牌是空数组，渲染为背面。
 */
const SUITS = ['♣', '♦', '♥', '♠'];
const SUIT_NAMES = ['梅花', '方块', '红桃', '黑桃'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function isValid(card) {
  return typeof card === 'number' && Number.isInteger(card) && card >= 0 && card < 52;
}

function suitOf(card) {
  return Math.floor(card / 13);
}

function rankOf(card) {
  return (card % 13) + 2;
}

function isRed(card) {
  const suit = suitOf(card);
  return suit === 1 || suit === 2;
}

function label(card) {
  return RANKS[rankOf(card) - 2];
}

function symbol(card) {
  return SUITS[suitOf(card)];
}

function text(card) {
  return symbol(card) + label(card);
}

function back() {
  return { hidden: true, card: null, label: '', symbol: '', text: '背面', red: false, name: '未公开' };
}

/** 单张牌 → 渲染对象；非法或未公开的牌一律渲染为背面。 */
function view(card) {
  if (!isValid(card)) return back();
  return {
    hidden: false,
    card: card,
    label: label(card),
    symbol: symbol(card),
    text: text(card),
    red: isRed(card),
    name: SUIT_NAMES[suitOf(card)] + label(card)
  };
}

/** 牌数组 → 渲染对象数组，保持输入顺序（公共牌、底牌都直接用）。 */
function views(list) {
  return (list || []).map(view);
}

/** 座位底牌：未公开时按牌数补齐背面，界面不出现空洞。 */
function seatViews(hole, size) {
  const count = typeof size === 'number' ? size : 2;
  const result = (hole || []).map(view);
  while (result.length < count) result.push(back());
  return result;
}

module.exports = {
  SUITS: SUITS,
  SUIT_NAMES: SUIT_NAMES,
  RANKS: RANKS,
  isValid: isValid,
  suitOf: suitOf,
  rankOf: rankOf,
  isRed: isRed,
  label: label,
  symbol: symbol,
  text: text,
  view: view,
  views: views,
  back: back,
  seatViews: seatViews
};
