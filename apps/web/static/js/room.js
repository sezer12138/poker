// 等待房间：成员、座位、准备、机器人、邀请与开赛。模块顶层不访问 window/document。

import {ApiError, buildCommand, createApi, ensureSession, isUnauthorized} from './api.js';
import {STARTING_STACK, formatChips, formatLevelText, statusText} from './format.js';
import {el, navigate, pageUrl, qs, queryParam, render, setDisabled, setHidden, setText} from './util.js';
import {createRoomSocket} from './ws.js';

/** 准备按钮必须连同这句披露文案一起出现：准备即表示接受赛后完整牌序核验。 */
export const DISCLOSURE_TEXT = '比赛结束后本桌成员可核验完整历史牌序，准备即表示接受';

const view = {
  roomId: null,
  api: null,
  socket: null,
  room: null,
  busy: false,
  enteredTable: false,
};

function node(id) {
  return qs(`#${id}`);
}

function showError(message) {
  const banner = node('error-banner');
  if (!banner) return;
  setText(banner, message ?? '');
  setHidden(banner, !message);
}

function handleError(error, action = '操作') {
  if (isUnauthorized(error) || error?.code === 'UNAUTHORIZED') {
    view.api?.clearToken();
    showError('登录已失效，正在返回大厅…');
    setTimeout(() => navigate(pageUrl('index.html')), 600);
    return;
  }
  const messages = {
    ROOM_LOCKED: '房间已锁定，开赛后不能加入或移除成员',
    VERSION_CONFLICT: '房间状态已变化，已刷新，请重新确认',
    AUDIT_LOCKED: '比赛结束后可核验',
  };
  const mapped = error instanceof ApiError ? messages[error.code] ?? error.message : String(error?.message ?? error);
  showError(`${action}失败：${mapped}`);
}

function applyRoom(room) {
  if (!room) return;
  view.room = room;
  renderAll();
  if (room.status !== 'waiting' && !view.enteredTable) {
    // 开赛后房间页只作为入口：自动去一次牌桌，避免玩家停在等待页。
    view.enteredTable = true;
    navigate(pageUrl('table.html', {id: room.id}));
  }
}

async function send(type, extra = {}) {
  if (view.busy || !view.room) return;
  view.busy = true;
  renderAll();
  const room = view.room;
  try {
    const next = await view.api.command(room.id, buildCommand(type, room.version, extra));
    view.socket.applyRoom(next, 'manual');
    showError(null);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
      // 冲突只刷新，不重放命令：准备/开赛都不允许自动重试。
      showError('房间状态已变化，已刷新最新状态');
      await view.socket.refresh();
    } else {
      handleError(error);
    }
  } finally {
    view.busy = false;
    renderAll();
  }
}

function renderAll() {
  const room = view.room;
  if (!room) return;
  const isHost = room.hostId === room.viewerId;
  const self = (room.members ?? []).find((member) => member.seat === room.viewerSeat);
  const humans = (room.members ?? []).filter((member) => !member.bot);
  const allReady = humans.every((member) => member.ready);
  const canStart = isHost && room.status === 'waiting' && room.members.length >= 2 && allReady;

  setText(node('room-title'), room.name || `房间 ${room.code}`);
  setText(node('room-code'), room.code);
  setText(node('room-status'), statusText(room.status));
  setText(node('room-level'), formatLevelText(room.blinds, room.nextBlinds, room.handsToNextLevel));
  setText(node('invite-link'), inviteLink(room));
  setText(node('viewer-role'), isHost ? '你是房主' : '你是成员');
  setText(node('notice-banner'), room.notice ?? '');
  setHidden(node('notice-banner'), !room.notice);

  renderMembers(room, isHost);
  renderControls(room, {isHost, self, canStart, allReady});
  renderProgress(room, {canStart, allReady});
  setHidden(node('table-entry'), room.status === 'waiting');
  renderFairness(room);
}

function inviteLink(room) {
  if (!room.invite) return '';
  const base = typeof location === 'undefined' ? '' : `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
  return `${base}${pageUrl('index.html', {invite: room.invite})}`;
}

function renderMembers(room, isHost) {
  const container = node('members');
  if (!container) return;
  const rows = [...(room.members ?? [])].sort((a, b) => a.seat - b.seat).map((member) => {
    const isSelf = member.seat === room.viewerSeat;
    const classes = ['member'];
    if (member.bot) classes.push('member--bot');
    if (isSelf) classes.push('member--self');
    // 房主可移除机器人，也可移除未开赛的真人，但不能移除自己。
    const removable = isHost && room.status === 'waiting' && !isSelf;
    return el('li', {className: classes.join(' '), dataset: {seat: String(member.seat)}}, [
      el('span', {className: 'member__seat', text: `座位 ${member.seat}`}),
      el('span', {className: 'member__name', text: member.name}),
      member.bot ? el('span', {className: 'tag tag--bot', text: '机器人'}) : null,
      member.seat === room.hostId ? el('span', {className: 'tag tag--host', text: '房主'}) : null,
      isSelf ? el('span', {className: 'tag tag--self', text: '我'}) : null,
      el('span', {
        className: `member__ready ${member.ready ? 'is-ready' : ''}`,
        text: member.bot ? '机器人自动准备' : member.ready ? '已准备' : '未准备',
      }),
      // 等待阶段没有真实筹码，显示引擎的起手筹码（开赛后牌桌读 hand.players）。
      room.status === 'waiting' && !member.bot
        ? el('span', {className: 'member__stack', text: `筹码 ${formatChips(STARTING_STACK)}`})
        : null,
      removable
        ? el('button', {className: 'btn btn--ghost', text: '移除', dataset: {removeSeat: String(member.seat)}, disabled: view.busy})
        : null,
    ]);
  });
  render(container, rows);
}

function renderControls(room, {isHost, self, canStart}) {
  const readyBox = node('ready-box');
  const readyButton = node('ready-btn');
  const disclosure = node('ready-disclosure');
  if (disclosure) setText(disclosure, DISCLOSURE_TEXT);

  const isPlayer = Boolean(self) && self.bot !== true;
  setHidden(readyBox, !isPlayer || room.status !== 'waiting');
  if (readyButton && isPlayer) {
    const ready = self.ready === true;
    setText(readyButton, ready ? '取消准备' : '我准备好了');
    setDisabled(readyButton, view.busy);
    readyButton.dataset.ready = ready ? 'true' : 'false';
  }

  setHidden(node('host-box'), !isHost || room.status !== 'waiting');
  setDisabled(node('add-bot'), view.busy || room.members.length >= 9);
  setDisabled(node('start-btn'), view.busy || !canStart);
  setDisabled(node('restart-btn'), view.busy || !isHost || room.status !== 'finished');
  setHidden(node('finished-box'), room.status !== 'finished');
}

function renderProgress(room, {canStart, allReady}) {
  const hint = node('progress-hint');
  if (!hint) return;
  if (room.status === 'playing') {
    setText(hint, '比赛进行中，本页仅作为入口。');
    return;
  }
  if (room.status === 'finished') {
    setText(hint, `本场已结束，冠军：${room.winner === null ? '无' : `座位 ${room.winner}`}。重新准备后可再开一场。`);
    return;
  }
  if (room.members.length < 2) {
    setText(hint, '至少需要 2 位参赛者（可添加机器人）才能开始。');
    return;
  }
  if (!allReady) {
    const pending = room.members.filter((member) => !member.bot && !member.ready).map((member) => member.name);
    setText(hint, `等待真人准备：${pending.join('、')}`);
    return;
  }
  setText(hint, canStart ? '全部真人已准备，房主可以开始比赛。' : '全部真人已准备，等待房主开始。');
}

function renderFairness(room) {
  const container = node('fairness');
  if (!container) return;
  render(container, [
    el('p', {text: '每手发牌前服务器先公布种子承诺，再由每位真人提交一次随机贡献；贡献齐全后立即发牌，最多等待 5 秒。'}),
    el('p', {text: '未提交或机器人席位使用规则中公开的全零贡献，收到后不可覆盖。'}),
    el('p', {text: '比赛结束后，本桌成员可在核验页用完整记录复算每手牌序承诺。'}),
    room.fairness
      ? el('p', {className: 'fair__line', text: `第 ${room.fairness.handNo} 手种子承诺：${room.fairness.commitment}`})
      : el('p', {className: 'muted', text: '开赛后这里会显示当前手牌的种子承诺。'}),
  ]);
}

function wire() {
  const readyButton = node('ready-btn');
  if (readyButton) {
    readyButton.addEventListener('click', () => {
      const ready = readyButton.dataset.ready === 'true';
      send('ready', {ready: !ready});
    });
  }
  const start = node('start-btn');
  if (start) start.addEventListener('click', () => send('start'));
  const restart = node('restart-btn');
  if (restart) restart.addEventListener('click', () => send('restart'));
  const addBot = node('add-bot');
  if (addBot) addBot.addEventListener('click', () => send('addBot'));

  const members = node('members');
  if (members) {
    members.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-remove-seat]');
      if (!button || button.disabled) return;
      const seat = Number.parseInt(button.dataset.removeSeat, 10);
      if (Number.isInteger(seat)) send('removeBot', {seat});
    });
  }

  const copy = node('copy-invite');
  if (copy) {
    copy.addEventListener('click', async () => {
      const link = inviteLink(view.room ?? {});
      if (!link) return;
      const done = await copyText(link);
      setText(node('copy-hint'), done ? '邀请链接已复制' : `复制失败，请手动复制：${link}`);
    });
  }

  const leave = node('leave-btn');
  if (leave) leave.addEventListener('click', async () => {
    await send('leave');
    navigate(pageUrl('index.html'));
  });

  const tableEntry = node('table-entry');
  if (tableEntry) tableEntry.addEventListener('click', () => navigate(pageUrl('table.html', {id: view.roomId})));
}

/** 复制邀请链接：优先 clipboard，不可用时退回临时输入框选择。 */
async function copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 继续走兜底路径。
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy') === true;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function main() {
  view.roomId = queryParam('id');
  if (!view.roomId) {
    showError('缺少房间参数，请从大厅创建或加入房间。');
    return;
  }
  view.api = createApi({});
  wire();
  const session = await ensureSession(view.api);
  const room = await view.api.getRoom(view.roomId);
  view.socket = createRoomSocket({
    roomId: view.roomId,
    token: session.token,
    fetchRoom: () => view.api.getRoom(view.roomId),
    onState: applyRoom,
    onError: (error) => handleError(error, '连接'),
    // 顶号/被移出：不再重连，把服务端的中文原因留在页面上。
    onClosed: (decision) => handleError({code: decision.code, message: decision.message}, '连接'),
  });
  view.socket.applyRoom(room, 'manual');
  view.socket.start();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => handleError(error, '进入房间'));
  });
}
