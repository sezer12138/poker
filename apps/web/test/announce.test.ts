import test from 'node:test';
import assert from 'node:assert/strict';
import {QUEUE_CAP, TONE_DURATION_MS, TONES, createAnnouncer, toneOf} from '../static/js/announce.js';

/**
 * 播报队列。Node 里没有 DOM，所以注入一个记录调用的假 display 与可控定时器，
 * 断言的是「播了哪几条、什么语气、隔多久播下一条」。
 * 真实观感（动画、抖动、与结算弹窗的重叠）只能在浏览器里看，记在验证报告里。
 */

interface Shown {
  text: string;
  tone: string;
  durationMs: number;
}

function fakeDisplay() {
  const display: any = {
    shown: [] as Shown[],
    hides: 0,
    show(text: string, tone: string, durationMs: number) {
      display.shown.push({text, tone, durationMs});
    },
    hide() {
      display.hides += 1;
    },
  };
  return display;
}

/** 可控定时器：测试自己决定什么时候到点，不依赖真实时间。 */
function fakeTimers() {
  const timers: any = {
    callbacks: [] as {fn: () => void; ms: number; id: number}[],
    cleared: [] as number[],
    setTimeout(fn: () => void, ms: number) {
      const id = timers.callbacks.length + 1;
      timers.callbacks.push({fn, ms, id});
      return id;
    },
    clearTimeout(id: number) {
      timers.cleared.push(id);
    },
    /** 触发一次还活着的回调（模拟当前这条播完）。 */
    tick() {
      for (const entry of timers.callbacks) {
        if (timers.cleared.includes(entry.id)) continue;
        timers.cleared.push(entry.id); // 一次性定时器，触发过就不再触发
        entry.fn();
        return;
      }
    },
  };
  return timers;
}

function event(seq: number, type: string, extra: Record<string, unknown> = {}) {
  return {seq, handNo: 1, type, text: `${type}-${seq}`, ...extra};
}

test('语气映射：六个事件类型与五种动作各归各档，不认识的一律中性', () => {
  assert.deepEqual(TONES, ['big', 'medium', 'neutral', 'quiet', 'error']);

  // 动作按类型分档。
  assert.equal(toneOf('action', 'allIn'), 'big', '全押最炸');
  assert.equal(toneOf('action', 'raiseTo'), 'medium', '加注中等');
  assert.equal(toneOf('action', 'call'), 'neutral');
  assert.equal(toneOf('action', 'check'), 'neutral');
  assert.equal(toneOf('action', 'fold'), 'quiet', '弃牌安静');
  // 非动作事件。
  assert.equal(toneOf('street', undefined), 'medium', '发公共牌中等');
  assert.equal(toneOf('handStart', undefined), 'neutral');
  assert.equal(toneOf('settle', undefined), 'big');
  assert.equal(toneOf('finish', undefined), 'big');
  assert.equal(toneOf('pause', undefined), 'error', '暂停要显眼');
  // 防御：服务端升级前的老事件没有 action，将来的新类型也不该让界面炸。
  assert.equal(toneOf('action', undefined), 'neutral', '老事件缺 action 时不猜语气');
  assert.equal(toneOf('action', 'sidePot'), 'neutral', '不认识的动作退回中性');
  assert.equal(toneOf('somethingNew', undefined), 'neutral', '不认识的类型退回中性');
});

test('每档都有停留时长，且是正数毫秒', () => {
  const durations = TONE_DURATION_MS as Record<string, number>;
  for (const tone of TONES) {
    assert.equal(typeof durations[tone], 'number', `${tone} 缺时长`);
    assert.ok(durations[tone] > 0, `${tone} 的时长必须是正数`);
  }
  assert.ok(durations.big > durations.quiet, '全押该比弃牌停得久');
});

test('首帧只建立基线，不把入桌前的历史事件补播一遍', () => {
  const display = fakeDisplay();
  const announcer = createAnnouncer({timers: fakeTimers(), display});

  announcer.ingest([event(1, 'action', {action: 'fold'}), event(2, 'street')], {initial: true});
  assert.deepEqual(display.shown, [], '初始快照一条都不该播');
  assert.equal(display.hides, 0, '没播过就不必 hide');

  // 基线之后到来的事件才播。
  announcer.ingest([event(3, 'action', {action: 'allIn'})]);
  assert.equal(display.shown.length, 1);
  assert.equal(display.shown[0].text, 'action-3');
  assert.equal(display.shown[0].tone, 'big');

  // 低于或等于基线的 seq 永远不再播（刷新、重放都会走这条）。
  announcer.ingest([event(1, 'action', {action: 'fold'}), event(2, 'street')]);
  assert.equal(display.shown.length, 1, '旧事件不该重播');
});

test('按 seq 去重并升序播放，乱序到达也照事件顺序播', () => {
  const display = fakeDisplay();
  const timers = fakeTimers();
  const announcer = createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(7, 'action', {action: 'raiseTo'}), event(5, 'action', {action: 'fold'})]);
  assert.equal(display.shown.length, 1, '同一时刻只播一条');
  assert.equal(display.shown[0].text, 'action-5', '先播 seq 小的');

  timers.tick();
  assert.equal(display.shown.length, 2);
  assert.equal(display.shown[1].text, 'action-7');
  assert.equal(display.shown[1].tone, 'medium');

  // 重复投入同一批事件不再播。
  announcer.ingest([event(7, 'action', {action: 'raiseTo'})]);
  assert.equal(display.shown.length, 2);
});

test('顺序播放：每条播完才播下一条，播完队列就收起横幅', () => {
  const display = fakeDisplay();
  const timers = fakeTimers();
  const announcer = createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(1, 'action', {action: 'call'}), event(2, 'street'), event(3, 'settle')]);
  assert.deepEqual(
    display.shown.map((item: Shown) => [item.text, item.tone, item.durationMs]),
    [['action-1', 'neutral', TONE_DURATION_MS.neutral]],
    '第一条立刻播，且用中性档的时长',
  );
  assert.equal(display.hides, 0, '还有下一条时不该收起');

  timers.tick();
  assert.equal(display.shown[1].text, 'street-2');
  assert.equal(display.shown[1].tone, 'medium');

  timers.tick();
  assert.equal(display.shown[2].text, 'settle-3');
  assert.equal(display.shown[2].tone, 'big');
  assert.equal(display.shown[2].durationMs, TONE_DURATION_MS.big);

  timers.tick();
  assert.equal(display.shown.length, 3, '没有更多条目');
  assert.equal(display.hides, 1, '播完才收起');
});

test('一次涌入太多事件时只播最近几条，重连回来不会被历史刷屏', () => {
  const display = fakeDisplay();
  const timers = fakeTimers();
  const announcer = createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  const flood = Array.from({length: 10}, (_, index) => event(index + 1, 'action', {action: 'call'}));
  announcer.ingest(flood);

  const played: string[] = [display.shown[0].text];
  for (let step = 0; step < QUEUE_CAP; step++) timers.tick();
  played.push(...display.shown.slice(1).map((item: Shown) => item.text));

  assert.equal(played.length, QUEUE_CAP, `最多播 ${QUEUE_CAP} 条`);
  assert.deepEqual(
    played,
    ['action-5', 'action-6', 'action-7', 'action-8', 'action-9', 'action-10'],
    '留下的是最近几条',
  );
});

test('clear 停掉当前与排队中的，但不会让播过的事件重播', () => {
  const display = fakeDisplay();
  const timers = fakeTimers();
  const announcer = createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(1, 'action', {action: 'allIn'}), event(2, 'settle')]);
  assert.equal(display.shown.length, 1);

  announcer.clear();
  assert.equal(display.hides, 1, 'clear 要收起横幅');
  timers.tick();
  assert.equal(display.shown.length, 1, '排队中的那条不该再冒出来');

  // clear 不重置 seq 基线：重置房间后 seq 继续往上走，播过的不该重播。
  announcer.ingest([event(1, 'action', {action: 'allIn'}), event(2, 'settle')]);
  assert.equal(display.shown.length, 1);
});

test('缺省 display 与空输入都是无害的', () => {
  const announcer = createAnnouncer({timers: fakeTimers()});
  assert.doesNotThrow(() => {
    announcer.ingest([event(1, 'settle')]);
    announcer.ingest(null as any);
    announcer.ingest([{seq: 'x', type: 'settle'} as any], {initial: true});
    announcer.clear();
  });
});
