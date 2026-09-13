/**
 * 每手结算弹窗的数据模型。纯函数：只吃服务端视图、吐渲染数据，页面只负责把它画出来，
 * 这样金额与排序能在 Node 里直接断言（见 test/settle.test.ts）。
 * 字段与口径与 web 端 apps/web/static/js/table.js 的 buildResultDialog 一一对应。
 *
 * 汇总口径：金额取服务端的 settle.changes（本手净输赢，见 apps/server/src/rooms/roomview.ts
 * 的 seatDeltas），它是「带进本手的筹码减去结算后的筹码」。服务端升级前落盘的老快照没有
 * 这份数据，此时 delta 为 null，界面只显示谁赢了底池，绝不自己算一个可能错的数出来。
 */

const format = require('./format.js');

/** 带符号的筹码：+250 / -250 / 0。 */
function signedChips(value) {
  const rounded = Math.round(Number(value));
  if (!Number.isFinite(rounded)) return '—';
  return (rounded > 0 ? '+' : '') + format.chips(rounded);
}

function nameOf(members, seat) {
  const found = (members || []).filter(function (member) {
    return member.seat === seat;
  })[0];
  return found ? found.name : format.seatText(seat);
}

/** 同一个座位可能既拿主池又拿边池，先按座位合并再显示。 */
function sumBySeat(items) {
  const map = {};
  (items || []).forEach(function (item) {
    if (item.amount > 0) map[item.seat] = (map[item.seat] || 0) + item.amount;
  });
  return map;
}

function ascending(a, b) {
  return a - b;
}

/**
 * 返回 null 表示「这一手不该弹窗」——没有结算结果，或服务端没开确认门（比赛已结束）。
 * viewerSeat 为 null（观战）时不给确认按钮。
 */
function buildResultDialog(hand, members, settle, viewerSeat) {
  if (!hand || !hand.result || !settle) return null;
  const awards = sumBySeat(hand.result.awards);
  const refunds = sumBySeat(hand.result.refunds);
  const deltas = {};
  const hasDelta = {};
  (settle.changes || []).forEach(function (change) {
    deltas[change.seat] = change.delta;
    hasDelta[change.seat] = true;
  });

  const seats = [];
  (hand.players || []).forEach(function (player) {
    if (seats.indexOf(player.seat) < 0) seats.push(player.seat);
  });

  const rows = seats.sort(ascending).map(function (seat) {
    const delta = hasDelta[seat] ? deltas[seat] : null;
    const won = awards[seat] || 0;
    const refunded = refunds[seat] || 0;
    return {
      seat: seat,
      name: nameOf(members, seat),
      delta: delta,
      // 没有金额时退化成「赢没赢」：至少让人知道这手谁拿走了底池。
      win: delta === null ? won > 0 : delta > 0,
      amount: delta === null ? '—' : signedChips(delta),
      amountClass: delta === null ? 'amount-none' : delta > 0 ? 'amount-win' : 'amount-lose',
      detail: won > 0 ? '赢得底池 ' + format.chips(won) : refunded > 0 ? '退回 ' + format.chips(refunded) : ''
    };
  });
  // 赢家在最前；都没有金额（老快照）时按座位顺序，不假装知道谁赢得多。
  rows.sort(function (a, b) {
    const left = a.delta === null ? -Infinity : a.delta;
    const right = b.delta === null ? -Infinity : b.delta;
    return right - left || a.seat - b.seat;
  });

  const required = (settle.required || []).slice().sort(ascending);
  const acks = (settle.acks || []).slice().sort(ascending);
  const canAck =
    typeof viewerSeat === 'number' && required.indexOf(viewerSeat) >= 0 && acks.indexOf(viewerSeat) < 0;
  const winners = rows
    .filter(function (row) {
      return row.win;
    })
    .map(function (row) {
      return row.name;
    });
  const potTotal = (hand.result.pots || []).reduce(function (sum, pot) {
    return sum + pot.amount;
  }, 0);

  return {
    handNo: settle.handNo,
    title: '第 ' + settle.handNo + ' 手结算',
    // 副标题只说「谁赢下多大的底池」：逐座位的净输赢在 rows 里，两处都写金额容易自相矛盾
    // （赢家拿走的底池 ≠ 他的净收入，底池里还有他自己投进去的那份）。
    summary:
      winners.length === 0
        ? '本手无人赢得底池'
        : winners.join('、') + ' 赢下 ' + format.chips(potTotal) + ' 的底池',
    rows: rows,
    required: required,
    acks: acks,
    canAck: canAck,
    ackText: acks.length + '/' + required.length
  };
}

module.exports = {
  signedChips: signedChips,
  buildResultDialog: buildResultDialog
};
