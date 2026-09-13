import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionText,
  blindRoleText,
  blindRoles,
  clampRemaining,
  computeOffset,
  countdownRatio,
  eventText,
  formatBlinds,
  formatChips,
  formatClock,
  formatCountdown,
  formatLevelText,
  formatSignedChips,
  potLabel,
  remainingMs,
  resultSummary,
  seatText,
  statusText,
  streetText,
} from '../static/js/format.js';

test('筹码格式化：千分位、非法值不渲染 NaN', () => {
  assert.equal(formatChips(0), '0');
  assert.equal(formatChips(1000), '1,000');
  assert.equal(formatChips(9000), '9,000');
  assert.equal(formatChips(1234567), '1,234,567');
  assert.equal(formatChips(999), '999');
  assert.equal(formatChips(-500), '-500');
  assert.equal(formatChips(12.7), '12');
  assert.equal(formatChips(Number.NaN), '—');
  assert.equal(formatChips(undefined), '—');
  assert.equal(formatChips('1000'), '—');
  assert.equal(formatSignedChips(250), '+250');
  assert.equal(formatSignedChips(-250), '-250');
  assert.equal(formatSignedChips(0), '0');
});

test('盲注与级别文案', () => {
  assert.equal(formatBlinds([10, 20]), '10/20');
  assert.equal(formatBlinds([4500, 9000]), '4,500/9,000');
  assert.equal(formatBlinds(null), '—');
  assert.equal(formatLevelText([10, 20], [15, 30], 3), '当前盲注 10/20 · 下一级 15/30（还剩 3 手）');
  assert.equal(formatLevelText([4500, 9000], [4500, 9000], 0), '当前盲注 4,500/9,000 · 已是最高级别');
  assert.equal(formatLevelText([10, 20], null, null), '当前盲注 10/20');
});

test('倒计时使用服务器偏移校正，刷新与重放不产生偏差', () => {
  const deadline = 1_700_000_030_000;
  // 服务器比本地快 5 秒：本地时间加上偏移后才与服务器同一时间轴。
  const offset = computeOffset(1_700_000_000_000, 1_699_999_995_000);
  assert.equal(offset, 5000);
  assert.equal(remainingMs(deadline, offset, 1_699_999_995_000), 30_000);
  // 同一个快照重放 10 秒后，剩余时间相应减少，而不是重新回到 30 秒。
  assert.equal(remainingMs(deadline, offset, 1_700_000_005_000), 20_000);
  assert.equal(computeOffset(null, 1_000), 0);
  assert.equal(remainingMs(null, offset, 0), null);
  // 偏移缺失（NaN）时按 0 处理，退化为本地时钟而不是把倒计时算成负数或 NaN。
  assert.equal(remainingMs(deadline, Number.NaN, 1_699_999_995_000), 35_000);
});

test('倒计时文案与进度比例', () => {
  assert.equal(formatCountdown(30000), '30秒');
  assert.equal(formatCountdown(12400), '12秒');
  assert.equal(formatCountdown(9999), '10.0秒');
  assert.equal(formatCountdown(1500), '1.5秒');
  assert.equal(formatCountdown(0), '0.0秒');
  assert.equal(formatCountdown(-4200), '0.0秒');
  assert.equal(formatCountdown(Number.NaN), '0.0秒');
  assert.equal(clampRemaining(-1), 0);
  assert.equal(formatClock(65000), '01:05');
  assert.equal(formatClock(0), '00:00');
  assert.equal(countdownRatio(15000, 30000), 0.5);
  assert.equal(countdownRatio(45000, 30000), 1);
  assert.equal(countdownRatio(-5, 30000), 0);
  assert.equal(countdownRatio(1000, 0), 1);
});

test('阶段、状态与操作文案', () => {
  assert.equal(streetText('preflop'), '翻牌前');
  assert.equal(streetText('flop'), '翻牌');
  assert.equal(streetText('turn'), '转牌');
  assert.equal(streetText('river'), '河牌');
  assert.equal(streetText('settled'), '结算');
  assert.equal(streetText('???'), '未知阶段');
  assert.equal(statusText('waiting'), '等待中');
  assert.equal(statusText('playing'), '比赛中');
  assert.equal(statusText('finished'), '已结束');
  assert.equal(seatText(3), '座位 3');
  assert.equal(seatText(null), '观众');
});

test('操作文案覆盖加注累计目标', () => {
  assert.equal(actionText({type: 'fold'}), '弃牌');
  assert.equal(actionText({type: 'check'}), '过牌');
  assert.equal(actionText({type: 'call'}), '跟注');
  assert.equal(actionText({type: 'allIn'}), '全押');
  assert.equal(actionText({type: 'raiseTo', amount: 1200}), '加注到 1,200');
  assert.equal(actionText(null), '未知操作');
});

test('庄家/小盲/大盲标记：多人按顺时针，单挑庄家即小盲', () => {
  const multi = blindRoles({
    button: 2,
    players: [{seat: 0}, {seat: 2}, {seat: 5}, {seat: 7}],
  });
  assert.equal(multi.get(2), 'D');
  assert.equal(multi.get(5), 'SB');
  assert.equal(multi.get(7), 'BB');
  assert.equal(blindRoleText('D'), '庄家');
  assert.equal(blindRoleText('SB'), '小盲');
  assert.equal(blindRoleText('BB'), '大盲');

  const wrap = blindRoles({button: 7, players: [{seat: 0}, {seat: 3}, {seat: 7}]});
  assert.equal(wrap.get(7), 'D');
  assert.equal(wrap.get(0), 'SB');
  assert.equal(wrap.get(3), 'BB');

  const headsUp = blindRoles({button: 4, players: [{seat: 1}, {seat: 4}]});
  assert.equal(headsUp.get(4), 'D/SB');
  assert.equal(headsUp.get(1), 'BB');
  assert.equal(blindRoleText('D/SB'), '庄家/小盲');

  assert.equal(blindRoles(null).size, 0);
  assert.equal(blindRoles({button: 0, players: [{seat: 0}]}).size, 0);
});

test('事件文案与结算摘要', () => {
  assert.equal(eventText({seq: 1, handNo: 3, type: 'action', text: '甲 加注到 60'}), '甲 加注到 60');
  assert.equal(eventText({seq: 2, handNo: 3, type: 'street'}), '第 3 手 · street');
  assert.equal(eventText(null), '');

  const members = [
    {seat: 0, name: '甲'},
    {seat: 1, name: '乙'},
  ];
  const summary = resultSummary(
    {
      result: {
        pots: [{amount: 300, eligible: [0, 1]}],
        awards: [
          {seat: 0, amount: 200},
          {seat: 1, amount: 100},
        ],
        refunds: [{seat: 1, amount: 20}],
      },
    },
    members,
  );
  assert.equal(summary, '甲 +200，乙 +100，乙 退回 20');
  assert.equal(resultSummary({result: {awards: [], refunds: []}}, members), '本手无人赢得底池');
  assert.equal(resultSummary({result: null}), '');
  assert.equal(potLabel(0), '主池');
  assert.equal(potLabel(2), '边池 2');
});
