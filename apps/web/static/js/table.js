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
import {createMusic} from './music.js';
import {MUSIC_KEY, el, navigate, pageUrl, qs, queryParam, render, setDisabled, setHidden, setText, storageGet, storageSet, toggleClass} from './util.js';
import {createRoomSocket} from './ws.js';

/** 兜底用的行动时限：正常情况下以服务端下发的 room.actionTimeoutMs 为准。 */
const ACTION_DEADLINE_MS = 90000;
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

/**
 * 结算弹窗要显示的内容。纯函数：只吃数据、吐数据，DOM 由 renderResultDialog 负责，
 * 这样金额与排序能在 Node 里直接断言（见 test/table.test.ts）。
 * 返回 null 表示「这一手不该弹窗」——没有结果，或服务端没开确认门（比赛已结束）。
 *
 * 汇总口径：金额取服务端的 settle.changes（本手净输赢，见 roomview.ts 的 seatDeltas），
 * 它是「赢的减去输的」；服务端升级前落盘的老快照没有这份数据，此时 delta 为 null，
 * 界面只显示谁赢了底池，绝不自己算一个可能错的数出来。
 */
export function buildResultDialog(hand, members = [], settle = null, viewerSeat = null) {
  if (!hand?.result || !settle) return null;
  const nameOf = seat => members.find(member => member.seat === seat)?.name ?? `座位 ${seat}`;
  const sumBy = list => {
    const map = new Map();
    for (const item of list ?? []) if (item.amount > 0) map.set(item.seat, (map.get(item.seat) ?? 0) + item.amount);
    return map;
  };
  const awards = sumBy(hand.result.awards);
  const refunds = sumBy(hand.result.refunds);
  const deltas = new Map((settle.changes ?? []).map(change => [change.seat, change.delta]));

  const rows = [...new Set(hand.players.map(player => player.seat))]
    .sort((a, b) => a - b)
    .map(seat => {
      const delta = deltas.has(seat) ? deltas.get(seat) : null;
      const won = awards.get(seat) ?? 0;
      const refunded = refunds.get(seat) ?? 0;
      return {
        seat,
        name: nameOf(seat),
        delta,
        amount: delta === null ? '—' : formatSignedChips(delta),
        // 没有金额时退化成「赢没赢」：至少让人知道这手谁拿走了底池。
        win: delta === null ? won > 0 : delta > 0,
        detail: won > 0 ? `赢得底池 ${formatChips(won)}` : refunded > 0 ? `退回 ${formatChips(refunded)}` : '',
      };
    })
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity) || a.seat - b.seat);

  const required = [...(settle.required ?? [])].sort((a, b) => a - b);
  const acks = [...(settle.acks ?? [])].sort((a, b) => a - b);
  const canAck = viewerSeat !== null && required.includes(viewerSeat) && !acks.includes(viewerSeat);
  // 副标题只说「谁赢下多大的底池」：逐座位的净输赢在 rows 里，两处都写金额容易自相矛盾
  // （赢家拿走的底池 ≠ 他的净收入，底池里还有他自己投进去的那份）。
  const winners = rows.filter(row => row.win).map(row => row.name);
  const potTotal = (hand.result.pots ?? []).reduce((sum, pot) => sum + pot.amount, 0);
  return {
    handNo: settle.handNo,
    title: `第 ${settle.handNo} 手结算`,
    summary: winners.length === 0 ? '本手无人赢得底池' : `${winners.join('、')} 赢下 ${formatChips(potTotal)} 的底池`,
    rows,
    required,
    acks,
    canAck,
    ackText: `已确认 ${acks.length}/${required.length}`,
  };
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
    /** 被淘汰/观战时可以手动关掉结算弹窗；记下手号，免得又被下一帧重新弹出来。 */
    dismissedHand: null,
    music: null,
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
  renderResultDialog(room);
  renderEvents(room);
  renderActions();
  renderFairness(room);
  renderBanner(room);
}

/**
 * 结算确认弹窗：每手结束弹一次，列出谁赢谁输与金额；所有真人点完「确认」服务端才开
 * 下一手，有人不点则由服务端兜底窗口自动继续（倒计时就显示在弹窗里）。
 * 比赛结束时房间不再开确认门（settle 为 null），弹窗自然收起。
 */
function renderResultDialog(room) {
  const overlay = node('result-dialog');
  const card = node('result-dialog-card');
  if (!overlay || !card) return;
  const model = buildResultDialog(room.hand, room.members, room.settle, room.viewerSeat);
  if (!model || view.dismissedHand === model.handNo) {
    setHidden(overlay, true);
    render(card, []);
    return;
  }
  setHidden(overlay, false);

  const rows = model.rows.map(row =>
    el('div', {className: row.win ? 'dialog__row dialog__row--win' : 'dialog__row'}, [
      el('span', {className: 'dialog__name', text: `${row.name}（座位 ${row.seat}）`}),
      row.detail === '' ? null : el('span', {className: 'muted', text: row.detail}),
      el('span', {className: 'dialog__amount', text: row.amount}),
    ]),
  );

  const buttons = [];
  if (model.canAck) {
    buttons.push(
      el('button', {
        className: 'btn btn--block',
        text: '确认，继续下一手',
        dataset: {role: 'settle-ack'},
        on: {click: () => sendCommand('settleAck', {handNo: model.handNo})},
      }),
    );
  } else {
    // 已确认过 / 被淘汰 / 观战：给一个关闭入口，别让弹窗把人困在这儿。
    buttons.push(
      el('button', {
        className: 'btn btn--ghost btn--block',
        text: '关闭',
        on: {
          click: () => {
            view.dismissedHand = model.handNo;
            renderResultDialog(view.room ?? {});
          },
        },
      }),
    );
  }

  render(card, [
    el('div', {className: 'dialog__title', text: model.title, attrs: {id: 'result-dialog-title'}}),
    el('div', {className: 'dialog__subtitle', text: model.summary}),
    ...rows,
    el('div', {className: 'dialog__acks'}, [
      el('div', {text: `真人确认：${model.ackText}${model.required.length === 0 ? '（本手无真人参与）' : ''}`}),
      el('div', {
        className: 'dialog__timer',
        dataset: {role: 'dialog-countdown'},
        text: model.canAck ? '等待其他人确认…' : '等待其他玩家确认…',
      }),
    ]),
    el('div', {className: 'dialog__actions'}, buttons),
    model.canAck ? el('p', {className: 'dialog__note', text: '倒计时结束会自动开下一手，不会把你卡在这里。'}) : null,
  ]);
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
      // 时限以服务端下发的为准，客户端只留一个兜底值；写死 30000 会让改时限变成两端改。
      const total = typeof room.actionTimeoutMs === 'number' ? room.actionTimeoutMs : ACTION_DEADLINE_MS;
      if (bar) bar.style.width = `${Math.round(countdownRatio(remaining, total) * 100)}%`;
      const seatTimer = qs('[data-role="seat-countdown"]');
      if (seatTimer) setText(seatTimer, formatCountdown(remaining));
    }
  }
  const nextRemaining = remainingMs(room.nextHandAt, view.offset, now);
  const nextNode = qs('[data-role="next-hand-countdown"]');
  if (nextNode && nextRemaining !== null) setText(nextNode, `${formatCountdown(nextRemaining)}后开始下一手`);

  // 结算弹窗里的兜底倒计时：所有人点确认会立刻开下一手，这个数字只是「最迟还有多久」。
  const dialogNode = qs('[data-role="dialog-countdown"]');
  if (dialogNode && nextRemaining !== null) {
    setText(dialogNode, `等待确认，${formatCountdown(nextRemaining)}后自动开始下一手`);
  }
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

/**
 * 背景音乐开关。默认关：浏览器不允许没有用户手势就出声，与其让按钮显示「开」却
 * 一声不响，不如让玩家自己点一下。上次开着的话这次也直接续上，并在第一次点击时
 * 把被自动播放策略挂起的音频上下文唤醒。
 */
function wireMusic() {
  const button = node('music-btn');
  const music = createMusic({});
  view.music = music;

  const paint = () => {
    const state = music.state();
    setText(button, `音乐：${state.playing ? '开' : '关'}`);
    setDisabled(button, !state.supported);
    if (!state.supported) setText(button, '音乐：不可用');
  };

  if (storageGet(MUSIC_KEY) === 'on') {
    if (music.start()) {
      document.addEventListener('click', () => music.start(), {once: true});
    }
  }
  paint();

  button?.addEventListener('click', () => {
    const playing = music.toggle();
    storageSet(MUSIC_KEY, playing ? 'on' : 'off');
    paint();
  });
  // 离开页面就停：定时器与振荡器不该跟着标签页过夜。
  window.addEventListener('pagehide', () => music.stop());
}

async function main() {
  view.roomId = queryParam('id');
  if (!view.roomId) {
    showError('缺少房间参数，请从大厅进入。');
    return;
  }
  view.api = createApi({});
  wireActions();
  wireMusic();
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
