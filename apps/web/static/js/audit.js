// 赛后核验：读取 /audit，用 WebCrypto 复算每手牌序承诺并与记录、本机留存对照。
// 模块顶层不访问 window/document/localStorage。

import {ApiError, createApi, ensureSession, isUnauthorized} from './api.js';
import {listCommitments, sameMatch} from './fairness.js';
import {formatTime} from './format.js';
import {el, navigate, pageUrl, qs, queryParam, render, setHidden, setText} from './util.js';
import {verifyRounds} from './verify.js';

const view = {
  roomId: null,
  api: null,
  payload: null,
  rows: [],
};

function node(id) {
  return qs(`#${id}`);
}

function short(hex, size = 16) {
  if (typeof hex !== 'string') return '—';
  return hex.length <= size ? hex : `${hex.slice(0, size)}…`;
}

function showError(message) {
  const banner = node('error-banner');
  if (!banner) return;
  setText(banner, message ?? '');
  setHidden(banner, !message);
}

function handleError(error, action) {
  if (isUnauthorized(error)) {
    view.api?.clearToken();
    showError('登录已失效，正在返回大厅…');
    setTimeout(() => navigate(pageUrl('index.html')), 600);
    return;
  }
  if (error?.code === 'AUDIT_LOCKED') {
    showError('比赛结束后可核验。当前比赛尚未结束，无法查看完整牌序。');
    setHidden(node('audit-locked'), false);
    return;
  }
  if (error?.code === 'FORBIDDEN') {
    showError('只有本场成员可以核验该比赛的牌序。');
    return;
  }
  showError(`${action}失败：${error instanceof ApiError ? error.message : String(error?.message ?? error)}`);
}

function renderSummary(payload, rows) {
  const container = node('audit-summary');
  if (!container) return;
  const valid = rows.filter((row) => row.valid).length;
  const server = payload.verification ?? {valid: null, errors: []};
  const lines = [
    el('p', {text: `比赛标识：${payload.matchId ?? '—'} · 共 ${rows.length} 手`}),
    el('p', {text: `浏览器复算：${valid}/${rows.length} 手通过${valid === rows.length ? '（全部一致）' : '（存在不一致，详见下方）'}`}),
    el('p', {
      text: `服务端自检：${server.valid === true ? '通过' : server.valid === false ? `未通过（${(server.errors ?? []).join('；')}）` : '未提供'}`,
    }),
    el('p', {className: 'muted', text: '复算只证明记录自洽并且与比赛进行中广播的承诺一致，不代表对服务器随机源或发牌过程的独立认证。'}),
  ];
  render(container, lines);
}

function roundCard(row, payload) {
  const round = (payload.rounds ?? []).find((item) => item.handNo === row.handNo) ?? {};
  const contributions = Object.entries(round.contributions ?? {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([seat, nonce]) => el('li', {
      className: 'audit__contribution',
      text: `座位 ${seat}：${/^0{64}$/.test(nonce) ? '未提交（公开全零贡献）' : short(nonce, 12)}`,
    }));
  if (contributions.length === 0) contributions.push(el('li', {className: 'muted', text: '本手没有真人提交贡献'}));

  const checks = row.checks.map((check) =>
    el('li', {className: `audit__check ${check.ok === true ? 'is-ok' : check.ok === false ? 'is-bad' : 'is-unknown'}`}, [
      el('span', {className: 'audit__mark', text: check.ok === true ? '✓' : check.ok === false ? '✗' : '·'}),
      el('span', {text: `${check.name}：${check.detail}`}),
    ]),
  );

  return el('article', {className: `audit__card ${row.valid ? 'is-valid' : 'is-invalid'}`, dataset: {handNo: String(row.handNo)}}, [
    el('header', {className: 'audit__head'}, [
      el('h3', {text: `第 ${row.handNo} 手`}),
      el('span', {className: `audit__badge ${row.valid ? 'is-ok' : 'is-bad'}`, text: row.valid ? '✓ 复算一致' : '✗ 复算不一致'}),
    ]),
    el('dl', {className: 'audit__fields'}, [
      el('dt', {text: '种子承诺'}),
      el('dd', {className: 'mono', text: round.commitment ?? '—'}),
      el('dt', {text: '服务器种子'}),
      el('dd', {className: 'mono', text: round.serverSeed ?? '—'}),
      el('dt', {text: '牌序承诺'}),
      el('dd', {className: 'mono', text: round.deckCommitment ?? '未生成'}),
    ]),
    el('div', {className: 'audit__section'}, [el('h4', {text: '随机贡献'}), el('ul', {}, contributions)]),
    el('div', {className: 'audit__section'}, [el('h4', {text: '核验结果'}), el('ul', {}, checks)]),
    row.errors.length > 0 ? el('p', {className: 'audit__errors', text: `问题：${row.errors.join('；')}`}) : null,
  ]);
}

function renderRounds(payload, rows) {
  const container = node('audit-rounds');
  if (!container) return;
  if (rows.length === 0) {
    render(container, [el('p', {className: 'muted', text: '该比赛没有可核验的手牌记录。'})]);
    return;
  }
  render(container, rows.map((row) => roundCard(row, payload)));
}

function renderEvents(payload) {
  const container = node('audit-events');
  if (!container) return;
  const events = payload.events ?? [];
  if (events.length === 0) {
    render(container, [el('li', {className: 'muted', text: '没有公开事件记录。'})]);
    return;
  }
  render(
    container,
    events.map((event) =>
      el('li', {className: 'event'}, [
        el('span', {className: 'event__hand', text: `#${event.handNo}`}),
        el('span', {className: 'event__text', text: event.text}),
        el('span', {className: 'event__time', text: formatTime(event.at) || ''}),
      ]),
    ),
  );
}

function renderStored(payload) {
  const container = node('audit-stored');
  if (!container) return;
  // 按比赛号筛选：同一房间的上一局手号会重来，只按房间取会把上一局的手号算进来。
  const stored = listCommitments().filter((item) => sameMatch(item, payload.matchId));
  if (stored.length === 0) {
    render(container, [el('p', {className: 'muted', text: '本机没有留存该场比赛的承诺记录。'})]);
    return;
  }
  const byHand = new Map((payload.rounds ?? []).map((round) => [round.handNo, round.commitment]));
  render(
    container,
    stored.map((item) => {
      const server = byHand.get(item.handNo);
      const same = server !== undefined && server === item.commitment;
      return el('p', {className: `audit__stored ${same ? 'is-ok' : 'is-bad'}`}, [
        el('span', {className: 'audit__mark', text: same ? '✓' : server === undefined ? '·' : '✗'}),
        el('span', {
          text: `第 ${item.handNo} 手本机留存 ${short(item.commitment, 12)}${server === undefined ? '（记录中缺失该手）' : same ? ' 与记录一致' : ' 与记录不一致'}`,
        }),
      ]);
    }),
  );
}

async function main() {
  view.roomId = queryParam('id');
  if (!view.roomId) {
    showError('缺少房间参数，请从房间或牌桌进入核验页。');
    return;
  }
  view.api = createApi({});
  const session = await ensureSession(view.api);
  setText(node('viewer-line'), `当前身份：${session.user.name}`);
  let payload;
  try {
    payload = await view.api.audit(view.roomId);
  } catch (error) {
    handleError(error, '获取核验数据');
    return;
  }
  view.payload = payload;
  setText(node('match-line'), `比赛 ${payload.matchId ?? '—'}`);
  const rows = await verifyRounds(payload.rounds ?? [], {
    cryptoImpl: globalThis.crypto,
    storedCommitments: listCommitments(),
  });
  view.rows = rows;
  renderSummary(payload, rows);
  renderRounds(payload, rows);
  renderStored(payload);
  renderEvents(payload);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => handleError(error, '核验'));
  });
}
