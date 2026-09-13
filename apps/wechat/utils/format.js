/**
 * 筹码 / 倒计时 / 中文文案。
 * 倒计时一律用服务端时间：剩余 = deadline - (Date.now() + offset)，
 * offset = serverTime - Date.now()（收到状态时计算）。
 */

const STATUS_TEXT = {
  waiting: '等待中',
  playing: '比赛中',
  finished: '已结束'
};

const STREET_TEXT = {
  preflop: '翻牌前',
  flop: '翻牌',
  turn: '转牌',
  river: '河牌',
  settled: '结算'
};

const ACTION_TEXT = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  allIn: '全押',
  raiseTo: '加注'
};

/**
 * 开赛前的筹码显示值：引擎固定每人 1000 起手（packages/poker-engine/src/tournament.ts）。
 * 等待阶段服务端还没有 tournament，也就没有真实筹码，只能显示这个数；
 * 开赛后一律读 hand.players[].stack，不再用这个常量。
 */
const STARTING_STACK = 1000;

/** 整数筹码千分位；非法值统一显示破折号（与浏览器端一致），不把 NaN 渲染给玩家。 */
function chips(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function statusText(status) {
  return STATUS_TEXT[status] || '未知';
}

function streetText(street) {
  return STREET_TEXT[street] || '未知';
}

function actionText(action) {
  if (!action || !action.type) return '';
  const name = ACTION_TEXT[action.type] || action.type;
  if (action.type === 'raiseTo') return name + '到 ' + chips(action.amount);
  return name;
}

function blindLabel(blinds) {
  if (!blinds || blinds.length < 2) return '—';
  return chips(blinds[0]) + ' / ' + chips(blinds[1]);
}

/** offset 为服务端与本地时钟差，桌面重连后重新计算。 */
function serverOffset(serverTime, now) {
  if (typeof serverTime !== 'number') return 0;
  const current = typeof now === 'number' ? now : Date.now();
  return serverTime - current;
}

function timeLeft(deadline, offset, now) {
  if (typeof deadline !== 'number') return null;
  const current = typeof now === 'number' ? now : Date.now();
  const adjust = typeof offset === 'number' ? offset : 0;
  return deadline - (current + adjust);
}

function countdown(deadline, offset, now) {
  const left = timeLeft(deadline, offset, now);
  if (left === null) return { text: '—', seconds: 0, urgent: false, expired: false };
  const seconds = Math.max(0, left) / 1000;
  if (seconds <= 0) return { text: '0.0s', seconds: 0, urgent: true, expired: true };
  const text = seconds >= 10 ? Math.ceil(seconds) + 's' : seconds.toFixed(1) + 's';
  return { text: text, seconds: seconds, urgent: seconds <= 5, expired: false };
}

function handsToNextLevelText(handsToNextLevel, nextBlinds) {
  if (typeof handsToNextLevel !== 'number') return '';
  if (handsToNextLevel <= 0) return '已达最高盲注级 ' + blindLabel(nextBlinds);
  return '距升盲还剩 ' + handsToNextLevel + ' 手';
}

function readyText(ready) {
  return ready ? '已准备' : '未准备';
}

function seatText(seat) {
  return typeof seat === 'number' ? '第' + (seat + 1) + '座' : '观众';
}

function positionText(position) {
  if (position === 'button') return 'D';
  if (position === 'smallBlind') return '小盲';
  if (position === 'bigBlind') return '大盲';
  return '';
}

function errorText(err) {
  if (!err) return '操作失败';
  if (err.message) return err.message;
  return '操作失败（' + (err.code || 'UNKNOWN') + '）';
}

/**
 * 盲注座位只用于界面标记：单挑时庄家兼小盲，其余情况小盲是庄家之后第一个未弃牌座位。
 * 金额与合法行动一律以服务端 hand.legal 为准，客户端不据此计算。
 */
function blindSeats(players, button) {
  const live = (players || [])
    .filter(function (p) {
      return p && p.folded !== true;
    })
    .map(function (p) {
      return p.seat;
    })
    .sort(function (a, b) {
      return a - b;
    });
  const headsUp = live.length === 2;
  const result = { smallBlind: null, bigBlind: null, headsUp: headsUp };
  if (live.length < 2 || typeof button !== 'number') return result;

  function after(seat) {
    for (let step = 1; step <= 9; step += 1) {
      const candidate = (seat + step) % 9;
      if (live.indexOf(candidate) >= 0) return candidate;
    }
    return null;
  }

  if (headsUp) {
    if (live.indexOf(button) < 0) return result;
    result.smallBlind = button;
    result.bigBlind = live[0] === button ? live[1] : live[0];
    return result;
  }
  if (live.indexOf(button) < 0) return result;
  const small = after(button);
  result.smallBlind = small;
  result.bigBlind = small === null ? null : after(small);
  return result;
}

module.exports = {
  STARTING_STACK: STARTING_STACK,
  chips: chips,
  statusText: statusText,
  streetText: streetText,
  actionText: actionText,
  blindLabel: blindLabel,
  serverOffset: serverOffset,
  timeLeft: timeLeft,
  countdown: countdown,
  handsToNextLevelText: handsToNextLevelText,
  readyText: readyText,
  seatText: seatText,
  positionText: positionText,
  errorText: errorText,
  blindSeats: blindSeats
};
