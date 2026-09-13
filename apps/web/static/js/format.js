// 筹码、倒计时与中文文案格式化。全部为纯函数，便于单测。

import {SUITS} from './cards.js';

export const STREET_TEXT = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  settled: '结算',
};

export const STATUS_TEXT = {
  waiting: '等待中',
  playing: '比赛中',
  finished: '已结束',
};

export const ACTION_TEXT = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  raiseTo: '加注',
  allIn: '全押',
};

/**
 * 开赛前的筹码显示值：引擎固定每人 1000 起手（packages/poker-engine/src/tournament.ts）。
 * 等待阶段服务端还没有 tournament，也就没有真实筹码，成员列表和牌桌只能显示这个数；
 * 开赛后一律读 hand.players[].stack，不再用这个常量。
 */
export const STARTING_STACK = 1000;

/** 整数筹码千分位；非法值统一显示破折号，避免把 NaN 渲染给玩家。 */
export function formatChips(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.trunc(value);
  const sign = rounded < 0 ? '-' : '';
  return sign + Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatSignedChips(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const text = formatChips(value);
  return value > 0 ? `+${text}` : text;
}

export function formatBlinds(blinds) {
  if (!Array.isArray(blinds) || blinds.length < 2) return '—';
  return `${formatChips(blinds[0])}/${formatChips(blinds[1])}`;
}

export function formatLevelText(blinds, nextBlinds, handsToNextLevel) {
  const current = `当前盲注 ${formatBlinds(blinds)}`;
  if (!Array.isArray(nextBlinds) || typeof handsToNextLevel !== 'number') return current;
  if (handsToNextLevel <= 0) return `${current} · 已是最高级别`;
  return `${current} · 下一级 ${formatBlinds(nextBlinds)}（还剩 ${handsToNextLevel} 手）`;
}

/** 服务器时间与本地时钟的偏移：remaining = deadline - (Date.now() + offset)。 */
export function computeOffset(serverTime, clientNow) {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return 0;
  return serverTime - clientNow;
}

export function remainingMs(deadline, offset, clientNow) {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return null;
  return deadline - (clientNow + (Number.isFinite(offset) ? offset : 0));
}

export function clampRemaining(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0;
  return ms > 0 ? ms : 0;
}

/** 倒计时文案：10 秒以上取整秒，10 秒以内保留一位小数便于玩家掐点。 */
export function formatCountdown(ms) {
  const value = clampRemaining(ms);
  if (value >= 10000) return `${Math.floor(value / 1000)}秒`;
  return `${(value / 1000).toFixed(1)}秒`;
}

export function formatClock(ms) {
  const total = Math.ceil(clampRemaining(ms) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTime(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 倒计时剩余比例，用于进度条；无截止时间时返回 1。 */
export function countdownRatio(ms, totalMs) {
  if (typeof totalMs !== 'number' || totalMs <= 0) return 1;
  return Math.max(0, Math.min(1, clampRemaining(ms) / totalMs));
}

export function streetText(street) {
  return STREET_TEXT[street] ?? '未知阶段';
}

export function statusText(status) {
  return STATUS_TEXT[status] ?? '未知状态';
}

export function seatText(seat) {
  return typeof seat === 'number' ? `座位 ${seat}` : '观众';
}

export function actionText(action) {
  if (!action || typeof action !== 'object') return '未知操作';
  if (action.type === 'raiseTo') return `加注到 ${formatChips(action.amount)}`;
  return ACTION_TEXT[action.type] ?? '未知操作';
}

export function cardText(card) {
  return SUITS[Math.floor(card / 13)].symbol + (card % 13 + 2);
}

/**
 * 庄家/盲注标记。RoomView 不提供大小盲座位，只能由手牌状态推导：
 * 单挑时庄家即小盲（引擎规则），多人时按座位顺时针取庄家之后两张座位。
 */
export function blindRoles(hand) {
  const roles = new Map();
  if (!hand || !Array.isArray(hand.players) || !Number.isInteger(hand.button)) return roles;
  const seats = hand.players.map((player) => player.seat).filter((seat) => Number.isInteger(seat)).sort((a, b) => a - b);
  if (seats.length < 2) return roles;
  const after = (seat) => {
    for (const candidate of seats) if (candidate > seat) return candidate;
    return seats[0];
  };
  if (seats.length === 2) {
    // 单挑：庄家同时是小盲，另一人单独大盲。
    roles.set(hand.button, 'D/SB');
    roles.set(seats.find((seat) => seat !== hand.button), 'BB');
    return roles;
  }
  roles.set(hand.button, 'D');
  const smallBlind = after(hand.button);
  const bigBlind = after(smallBlind);
  roles.set(smallBlind, 'SB');
  roles.set(bigBlind, 'BB');
  return roles;
}

export function blindRoleText(role) {
  if (role === 'D') return '庄家';
  if (role === 'SB') return '小盲';
  if (role === 'BB') return '大盲';
  if (role === 'D/SB') return '庄家/小盲';
  return '';
}

export function eventText(event) {
  if (!event) return '';
  if (typeof event.text === 'string' && event.text !== '') return event.text;
  return `第 ${event.handNo ?? '?'} 手 · ${event.type ?? '事件'}`;
}

/** 结算展示用的一行摘要：赢家与各池金额。 */
export function resultSummary(hand, members = []) {
  if (!hand || !hand.result) return '';
  const nameOf = (seat) => members.find((member) => member.seat === seat)?.name ?? `座位 ${seat}`;
  const awards = (hand.result.awards ?? []).filter((award) => award.amount > 0);
  if (awards.length === 0) return '本手无人赢得底池';
  const parts = awards.map((award) => `${nameOf(award.seat)} +${formatChips(award.amount)}`);
  const refunds = (hand.result.refunds ?? []).filter((refund) => refund.amount > 0);
  const refundText = refunds.map((refund) => `${nameOf(refund.seat)} 退回 ${formatChips(refund.amount)}`);
  return [...parts, ...refundText].join('，');
}

export function potLabel(index) {
  return index === 0 ? '主池' : `边池 ${index}`;
}
