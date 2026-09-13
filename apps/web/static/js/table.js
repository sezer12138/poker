// 牌桌页逻辑。约束：模块顶层不访问 window/document/localStorage，浏览器启动放在函数内。

import {ApiError, buildCommand, buildContributeCommand, createApi, ensureSession, isUnauthorized} from './api.js';
import {boardElements, cardElement, isCard} from './cards.js';
import {contributionKey, contributionPlan, saveCommitment, UNAVAILABLE_NOTICE} from './fairness.js';
import {
  STARTING_STACK,
  blindRoleText,
  blindRoles,
  computeOffset,
  countdownRatio,
  formatChips,
  formatCountdown,
  formatLevelText,
  formatSignedChips,
  potLabel,
  remainingMs,
  resultSummary,
  seatText,
  statusText,
  streetText,
} from './format.js';
import {el, navigate, pageUrl, qs, queryParam, render, setDisabled, setHidden, setText, toggleClass} from './util.js';
import {createRoomSocket} from './ws.js';

const ACTION_DEADLINE_MS = 30000;
const MAX_EVENTS = 40;

export function seatPositions(seats, viewerSeat) {
  const ordered = [...seats].sort((a, b) => a - b);
  const count = ordered.length;
  if (count === 0) return new Map();
  const viewerIndex = ordered.indexOf(viewerSeat);
  const rotated = viewerIndex >= 0 ? [...ordered.slice(viewerIndex), ...ordered.slice(0, viewerIndex)] : ordered;
  const positions = new Map();
  // 自己在正下方（角度 90°），其余人按座位顺序沿椭圆排开。
  rotated.forEach((seat, index) => {
    const angle = (Math.PI / 2) + (index / count) * Math.PI * 2;
    positions.set(seat, {
      x: 50 + Math.cos(angle) * 42,
      y: 50 + Math.sin(angle) * 38,
    });
  });
  return positions;
}

/** 底池口径：进行中按累计投入求和，结算后以 result.pots 为准。 */
export function potTotal(hand) {
  if (!hand) return 0;
  if (hand.result) return hand.result.pots.reduce((sum, pot) => sum + pot.amount, 0);
  return hand.players.reduce((sum, player) => sum + (player.committed ?? 0), 0);
}

/** 加注快捷目标：以“跟注后底池”为基准换算成本轮累计投入目标。 */
export function quickRaiseTargets(legal, pot, roundBet) {
  const call = typeof legal?.call === 'number' ? legal.call : 0;
  const base = pot + call;
  const clamp = (value) => {
    if (legal?.minRaiseTo === null || legal?.maxRaiseTo === null) return null;
    return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(value)));
  };
  return {
    min: legal?.minRaiseTo ?? null,
    half: clamp(roundBet + call + base * 0.5),
    pot: clamp(roundBet + call + base),
    max: legal?.maxRaiseTo ?? null,
  };
}

export function isValidRaiseTarget(legal, target, roundBet, stack) {
  if (!legal || !Number.isInteger(target)) return false;
  if (legal.minRaiseTo !== null && legal.maxRaiseTo !== null && target >= legal.minRaiseTo && target <= legal.maxRaiseTo) return true;
  // 短码全押：正好推完自己的筹码是合法目标，即使低于最小加注。
  // 但要高过本轮的既有下注（engine: target > h.currentBet），
  // 否则那只是跟注而已，服务端会以 ILLEGAL_ACTION 拒绝。
  // 既有下注 = 自己的本轮投入 + 跟注额（legal.call 为 null 表示无需跟注）。
  const currentBet = roundBet + (typeof legal.call === 'number' ? legal.call : 0);
  return legal.allIn === true && target === roundBet + stack && target > currentBet;
}

function createTableView() {
  return {
    room: null,
    roomId: null,
    api: null,
    socket: null,
    offset: 0,
    busy: false,
    allInArmed: false,
    submitted: new Set(),
    lastActorKey: null,
    lastHandKey: null,
    error: null,
    notice: null,
    redirecting: false,
  };
}

const view = createTableView();

function node(id) {
  return qs(`#${id}`);
}

function showError(message) {
  view.error = message;
  const banner = node('error-banner');
  if (banner) {
    setText(banner, message ?? '');
    setHidden(banner, !message);
  }
}

function showNotice(message) {
  view.notice = message;
  const banner = node('notice-banner');
  if (banner) {
    setText(banner, message ?? '');
    setHidden(banner, !message);
  }
}

function handleError(error) {
  if (isUnauthorized(error) || error?.code === 'UNAUTHORIZED') {
    // 令牌失效：清掉本地令牌并回到大厅重新以游客身份登录。
    view.api?.clearToken();
    showError('登录已失效，正在返回大厅重新登录…');
    setTimeout(() => navigate(pageUrl('index.html')), 600);
    return;
  }
  showError(error instanceof ApiError ? error.message : String(error?.message ?? error));
}

function applyRoom(room, source) {
  if (!room) return;
  view.room = room;
  // 每次应用快照都用服务器时间重算偏移，刷新或消息重放都不会让倒计时跑偏。
  view.offset = computeOffset(room.serverTime, Date.now());
  handleFairness(room);
  renderAll();
}

function handleFairness(room) {
  if (room.fairness) saveCommitment(room, null);
  if (room.status !== 'playing') return;
  const plan = contributionPlan(room, room.viewerSeat);
  if (plan.kind === 'unavailable') {
    showNotice(UNAVAILABLE_NOTICE);
    return;
  }
  if (plan.kind !== 'contribute') return;
  const key = contributionKey(room, plan.handNo);
  if (view.submitted.has(key)) return;
  view.submitted.add(key);
  view.api
    .command(room.id, buildContributeCommand(plan))
    .then((next) => view.socket.applyRoom(next, 'manual'))
    .catch((error) => {
      // 网络类失败允许下一次状态推送时重试；其余（例如重复提交）不再重试。
      if (error?.code === 'NETWORK') {
        // 断线横幅已经在说明情况了，这里只把去重标记撤掉，等下一次状态推送重试。
        view.submitted.delete(key);
        return;
      }
      // 本手不在牌局中（例如这一手正好被淘汰）：不是玩家能处理的错误，
      // 视图已经说明情况，不必在界面上再报一次。
      if (error?.code === 'FORBIDDEN') return;
      showError(error?.message ?? '随机贡献提交失败');
    });
}

async function sendCommand(type, extra = {}) {
  if (view.busy || !view.room) return false;
  view.busy = true;
  renderActions();
  const room = view.room;
  try {
    // 版本冲突不自动重试：只拉取最新状态交给玩家重新决定。
    const next = await view.api.command(room.id, buildCommand(type, room.version, extra));
    view.socket.applyRoom(next, 'manual');
    showError(null);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      showError('房间状态已变化，已刷新最新状态，请重新确认操作');
      await view.socket.refresh();
    } else {
      handleError(error);
    }
    return false;
  } finally {
    view.busy = false;
    view.allInArmed = false;
    renderActions();
  }
}

function renderAll() {
  const room = view.room;
  if (!room) return;
  const hand = room.hand;

  setText(node('room-title'), room.name || `房间 ${room.code}`);
  setText(node('room-code'), `房间码 ${room.code}`);
  setText(node('room-status'), statusText(room.status));
  setText(node('level-text'), formatLevelText(room.blinds, room.nextBlinds, room.handsToNextLevel));
  setText(node('hand-count'), `已完成 ${room.completedHands} 手`);
  setText(node('viewer-seat'), seatText(room.viewerSeat));
  setText(node('street-text'), hand ? streetText(hand.street) : statusText(room.status));
  setText(node('notice-banner'), room.notice ?? '');
  setHidden(node('notice-banner'), !room.notice);

  renderSeats(room, hand);
  renderBoard(hand);
  renderPots(hand);
  renderResult(room, hand);
  renderEvents(room);
  renderActions();
  renderFairness(room);
  renderBanner(room);
}

function renderBanner(room) {
  const socket = view.socket;
  const offline = Boolean(socket) && socket.status !== 'open';
  const banner = node('offline-banner');
  if (!banner) return;
  // 终止性关闭（顶号、被移出房间）不会重连，再写「正在重连」就是骗玩家。
  const text = !offline || socket.closeReason ? '' : '连接已断开，正在重连并使用房间接口同步状态…';
  setText(banner, text);
  setHidden(banner, !offline);
  const table = node('table-surface');
  toggleClass(table, 'is-disconnected', Boolean(offline));
  setHidden(node('next-hand'), !room.nextHandAt);
}

function renderSeats(room, hand) {
  const container = node('seats');
  if (!container) return;
  const members = [...(room.members ?? [])].sort((a, b) => a.seat - b.seat);
  const seats = members.map((member) => member.seat);
  const positions = seatPositions(seats, room.viewerSeat);
  const roles = blindRoles(hand);
  const players = new Map((hand?.players ?? []).map((player) => [player.seat, player]));

  const nodes = members.map((member) => {
    const player = players.get(member.seat);
    const isActor = hand?.actor === member.seat;
    const isSelf = room.viewerSeat === member.seat;
    const folded = player?.folded === true;
    const classes = ['seat'];
    if (isActor) classes.push('is-actor');
    if (isSelf) classes.push('is-self');
    if (folded) classes.push('is-folded');
    if (member.bot) classes.push('is-bot');

    const role = roles.get(member.seat);
    // 等待阶段服务端还没有真实筹码，显示引擎的起手筹码；淘汰或未参赛的座位显示 0。
    const stack = player ? player.stack : room.status === 'waiting' ? STARTING_STACK : 0;
    const bet = player?.roundBet ?? 0;

    const cards = el('div', {className: 'seat__cards'});
    if (!folded && hand) {
      const hole = player?.hole ?? [];
      if (hole.length > 0) {
        for (const card of hole) cards.append(cardElement(card, {small: true}));
      } else if (player) {
        cards.append(cardElement(null, {small: true, hidden: true}), cardElement(null, {small: true, hidden: true}));
      }
    }

    const position = positions.get(member.seat);
    return el('div', {
      className: classes.join(' '),
      dataset: {seat: String(member.seat)},
      attrs: position ? {style: `left:${position.x}%;top:${position.y}%;`} : {},
    }, [
      el('div', {className: 'seat__head'}, [
        el('span', {className: 'seat__name', text: member.name || `座位 ${member.seat}`}),
        member.bot ? el('span', {className: 'tag tag--bot', text: '机器人'}) : null,
        role ? el('span', {className: 'tag tag--role', text: blindRoleText(role)}) : null,
        isSelf ? el('span', {className: 'tag tag--self', text: '我'}) : null,
      ]),
      cards,
      el('div', {className: 'seat__stack', text: `筹码 ${formatChips(stack)}`}),
      bet > 0 ? el('div', {className: 'seat__bet', text: `本轮投入 ${formatChips(bet)}`}) : null,
      folded ? el('div', {className: 'seat__folded', text: '已弃牌'}) : null,
      isActor ? el('div', {className: 'seat__timer', dataset: {role: 'seat-countdown'}, text: '—'}) : null,
    ]);
  });
  render(container, nodes);
}

function renderBoard(hand) {
  const container = node('board');
  if (!container) return;
  render(container, boardElements(hand?.board ?? [], {small: true}));
}

function renderPots(hand) {
  const container = node('pots');
  if (!container) return;
  const rows = [];
  if (hand?.result) {
    hand.result.pots.forEach((pot, index) => {
      rows.push(el('div', {className: 'pot'}, [
        el('span', {className: 'pot__label', text: potLabel(index)}),
        el('span', {className: 'pot__amount', text: formatChips(pot.amount)}),
        el('span', {className: 'pot__eligible', text: `可赢座位 ${pot.eligible.join('、')}`}),
      ]));
    });
    for (const refund of hand.result.refunds) {
      if (refund.amount > 0) rows.push(el('div', {className: 'pot pot--refund'}, [
        el('span', {className: 'pot__label', text: `座位 ${refund.seat} 退回`}),
        el('span', {className: 'pot__amount', text: formatChips(refund.amount)}),
      ]));
    }
  } else {
    rows.push(el('div', {className: 'pot'}, [
      el('span', {className: 'pot__label', text: '底池'}),
      el('span', {className: 'pot__amount', text: formatChips(potTotal(hand))}),
    ]));
  }
  render(container, rows);
}

function renderResult(room, hand) {
  const panel = node('result');
  if (!panel) return;
  if (!hand?.result) {
    setHidden(panel, true);
    return;
  }
  setHidden(panel, false);
  const rows = [el('div', {className: 'result__summary', text: resultSummary(hand, room.members)})];
  for (const award of hand.result.awards) {
    if (award.amount > 0) rows.push(el('div', {className: 'result__row', text: `座位 ${award.seat} 赢得 ${formatChips(award.amount)}`}));
  }
  for (const refund of hand.result.refunds) {
    if (refund.amount > 0) rows.push(el('div', {className: 'result__row', text: `座位 ${refund.seat} 退回 ${formatChips(refund.amount)}`}));
  }
  if (room.nextHandAt) rows.push(el('div', {className: 'result__next', dataset: {role: 'next-hand-countdown'}, text: '结算展示中…'}));
  if (room.status === 'finished') rows.push(el('div', {className: 'result__next', text: `比赛结束，冠军：${room.winner === null ? '无' : `座位 ${room.winner}`}`}));
  render(panel, rows);
}

function renderEvents(room) {
  const container = node('events');
  if (!container) return;
  const events = [...(room.events ?? [])].slice(-MAX_EVENTS).reverse();
  render(
    container,
    events.map((event) =>
      el('li', {className: 'event'}, [
        el('span', {className: 'event__hand', text: `#${event.handNo}`}),
        el('span', {className: 'event__text', text: event.text}),
      ]),
    ),
  );
}

function renderFairness(room) {
  const container = node('fairness');
  if (!container) return;
  const fairness = room.fairness;
  if (!fairness) {
    render(container, [el('p', {className: 'muted', text: '本手尚未开始随机承诺流程。'})]);
    return;
  }
  const contributing = fairness.deckCommitment === null;
  render(container, [
    el('p', {className: 'fair__line', text: `第 ${fairness.handNo} 手种子承诺：${fairness.commitment}`}),
    el('p', {
      className: 'fair__line',
      text: contributing
        ? `正在收集随机贡献（已收到座位 ${fairness.contributors.join('、') || '无'}），未提交者使用公开全零贡献`
        : `牌序承诺：${fairness.deckCommitment}`,
    }),
  ]);
}

function disableActionButtons(buttons) {
  for (const button of buttons.querySelectorAll('button[data-action]')) button.disabled = true;
}

function renderActions() {
  const room = view.room;
  const hand = room?.hand ?? null;
  const legal = hand?.legal ?? null;
  const hint = node('action-hint');
  const buttons = node('action-buttons');
  const raiseBox = node('raise-box');
  if (!hint || !buttons) return;

  if (room?.status === 'finished') {
    setText(hint, '比赛已结束，可返回房间准备下一场。');
    setHidden(buttons, true);
    setHidden(raiseBox, true);
    disableActionButtons(buttons);
    return;
  }
  if (!hand || !legal) {
    setText(hint, room?.viewerSeat === null ? '你正在观战，只能查看公共信息。' : '等待其他玩家行动…');
    setHidden(buttons, true);
    setHidden(raiseBox, true);
    // 隐藏之外还要禁用：隐藏的按钮仍能被程序化点击触发。
    disableActionButtons(buttons);
    return;
  }

  setHidden(buttons, false);
  const self = hand.players.find((player) => player.seat === room.viewerSeat);
  const roundBet = self?.roundBet ?? 0;
  const stack = self?.stack ?? 0;
  const pot = potTotal(hand);

  const byAction = (name) => qs(`[data-action="${name}"]`, buttons);
  const foldBtn = byAction('fold');
  const checkBtn = byAction('check');
  const callBtn = byAction('call');
  const raiseBtn = byAction('raise');
  const allInBtn = byAction('allIn');

  setText(hint, `${seatText(room.viewerSeat)} 行动 · 本轮已投入 ${formatChips(roundBet)} · 底池 ${formatChips(pot)}`);
  setDisabled(foldBtn, view.busy || !legal.fold);
  setDisabled(checkBtn, view.busy || !legal.check);
  setDisabled(callBtn, view.busy || legal.call === null);
  setHidden(checkBtn, !legal.check);
  setHidden(callBtn, legal.call === null);
  setText(callBtn, legal.call === null ? '跟注' : `跟注 ${formatChips(legal.call)}`);
  setDisabled(raiseBtn, view.busy || legal.minRaiseTo === null);
  setDisabled(allInBtn, view.busy || !legal.allIn);
  setText(allInBtn, view.allInArmed ? '确认全押' : `全押 ${formatChips(roundBet + stack)}`);

  const raisable = legal.minRaiseTo !== null && legal.maxRaiseTo !== null;
  setHidden(raiseBox, !raisable);
  if (!raisable) return;

  const input = node('raise-amount');
  const actorKey = `${hand.id}:${hand.street}:${hand.actor}:${roundBet}`;
  if (input && view.lastActorKey !== actorKey) {
    // 换人/换轮次时重置为最小加注目标，避免沿用上一手的数值。
    view.lastActorKey = actorKey;
    input.value = String(legal.minRaiseTo);
  }
  const target = input ? Number.parseInt(input.value, 10) : Number.NaN;
  const valid = isValidRaiseTarget(legal, target, roundBet, stack);
  const delta = Number.isInteger(target) ? target - roundBet : 0;
  if (input) {
    input.min = String(legal.minRaiseTo);
    input.max = String(legal.maxRaiseTo);
    input.step = '1';
  }
  setText(node('raise-range'), `可加注范围 ${formatChips(legal.minRaiseTo)} 到 ${formatChips(legal.maxRaiseTo)}（本轮累计投入目标）`);
  setText(node('raise-delta'), valid ? `本次追加 ${formatChips(delta)}（投入后本轮共 ${formatChips(target)}）` : '请输入范围内的整数目标');
  setDisabled(raiseBtn, view.busy || !valid);
  setText(raiseBtn, valid ? `加注到 ${formatChips(target)}` : '加注');
}

function tick() {
  const room = view.room;
  if (!room) return;
  const now = Date.now();
  const remaining = remainingMs(room.deadline, view.offset, now);
  const timer = node('table-timer');
  const hand = room.hand;
  if (timer) {
    const active = remaining !== null && hand?.actor !== null && hand?.actor !== undefined && room.status === 'playing';
    setHidden(timer, !active);
    if (active) {
      setText(qs('[data-role="timer-text"]', timer), hand.actor === room.viewerSeat ? `你的行动时间 ${formatCountdown(remaining)}` : `${seatText(hand.actor)} 行动 ${formatCountdown(remaining)}`);
      const bar = qs('[data-role="timer-bar"]', timer);
      if (bar) bar.style.width = `${Math.round(countdownRatio(remaining, ACTION_DEADLINE_MS) * 100)}%`;
      const seatTimer = qs('[data-role="seat-countdown"]');
      if (seatTimer) setText(seatTimer, formatCountdown(remaining));
    }
  }
  const nextRemaining = remainingMs(room.nextHandAt, view.offset, now);
  const nextNode = qs('[data-role="next-hand-countdown"]');
  if (nextNode && nextRemaining !== null) setText(nextNode, `${formatCountdown(nextRemaining)}后开始下一手`);
}

function wireActions() {
  const buttons = node('action-buttons');
  if (!buttons) return;
  buttons.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'fold') sendCommand('action', {action: {type: 'fold'}});
    else if (action === 'check') sendCommand('action', {action: {type: 'check'}});
    else if (action === 'call') sendCommand('action', {action: {type: 'call'}});
    else if (action === 'allIn') {
      // 全押不可撤销，需要二次确认。
      if (!view.allInArmed) {
        view.allInArmed = true;
        renderActions();
        return;
      }
      sendCommand('action', {action: {type: 'allIn'}});
    } else if (action === 'raise') {
      const input = node('raise-amount');
      const target = input ? Number.parseInt(input.value, 10) : Number.NaN;
      const hand = view.room?.hand;
      const self = hand?.players.find((player) => player.seat === view.room.viewerSeat);
      if (!isValidRaiseTarget(hand?.legal, target, self?.roundBet ?? 0, self?.stack ?? 0)) {
        showError('加注目标不在合法范围内');
        return;
      }
      sendCommand('action', {action: {type: 'raiseTo', amount: target}});
    }
  });

  const input = node('raise-amount');
  if (input) {
    input.addEventListener('input', () => {
      showError(null);
      renderActions();
    });
  }

  const quick = node('quick-amounts');
  if (quick) {
    quick.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-quick]');
      const input2 = node('raise-amount');
      const hand = view.room?.hand;
      if (!button || !input2 || !hand?.legal) return;
      const self = hand.players.find((player) => player.seat === view.room.viewerSeat);
      const targets = quickRaiseTargets(hand.legal, potTotal(hand), self?.roundBet ?? 0);
      const value = targets[button.dataset.quick];
      if (typeof value !== 'number') return;
      input2.value = String(value);
      renderActions();
    });
  }

  const leave = node('leave-btn');
  if (leave) leave.addEventListener('click', () => sendCommand('leave'));
  const back = node('back-room');
  if (back) back.addEventListener('click', () => navigate(pageUrl('room.html', {id: view.roomId})));
  const restart = node('restart-btn');
  if (restart) restart.addEventListener('click', () => sendCommand('restart'));
}

async function main() {
  view.roomId = queryParam('id');
  if (!view.roomId) {
    showError('缺少房间参数，请从大厅进入。');
    return;
  }
  view.api = createApi({});
  wireActions();
  const session = await ensureSession(view.api);
  const room = await view.api.getRoom(view.roomId);
  view.socket = createRoomSocket({
    roomId: view.roomId,
    token: session.token,
    fetchRoom: () => view.api.getRoom(view.roomId),
    onState: applyRoom,
    onError: (error) => handleError(error),
    onStatus: () => renderBanner(view.room ?? {nextHandAt: null}),
    // 顶号/被移出：服务端不会再放行，直接显示中文原因，不再重连。
    onClosed: (decision) => handleError({code: decision.code, message: decision.message}),
  });
  view.socket.applyRoom(room, 'manual');
  view.socket.start();
  setInterval(tick, 250);
  tick();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => handleError(error));
  });
}
