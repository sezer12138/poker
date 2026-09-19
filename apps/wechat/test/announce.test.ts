/**
 * 行动播报的队列逻辑。小程序里没有 DOM，这里注入记录调用的假 display 与
 * harness 的可控时钟，断言「播了哪几条、什么语气、隔多久播下一条」。
 * 横幅的真机观感（动画、抖动、与结算弹窗的重叠）只能在小程序里看，
 * 这一点如实记在验证报告与 README 里。
 * 与浏览器端 apps/web/test/announce.test.ts 是同一套用例，两端映射必须一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx, type FakeTimers} from './harness.ts';

interface Shown {
  text: string;
  tone: string;
  durationMs: number;
}

interface Announcer {
  ingest(events: unknown, options?: {initial?: boolean}): void;
  clear(): void;
}

interface AnnounceModule {
  TONES: string[];
  TONE_DURATION_MS: Record<string, number>;
  QUEUE_CAP: number;
  toneOf(type: string, action?: string): string;
  createAnnouncer(options?: {timers?: unknown; display?: unknown}): Announcer;
}

interface Display {
  shown: Shown[];
  hides: number;
  show(text: string, tone: string, durationMs: number): void;
  hide(): void;
}

function fakeDisplay(): Display {
  const display: Display = {
    shown: [],
    hides: 0,
    show(text: string, tone: string, durationMs: number) {
      display.shown.push({text, tone, durationMs});
    },
    hide() {
      display.hides += 1;
    }
  };
  return display;
}

function load(timers: FakeTimers = createTimers()) {
  const loader = createLoader({wx: createWx(), timers});
  return {timers, announce: loader.load('utils/announce.js') as AnnounceModule};
}

function event(seq: number, type: string, extra: Record<string, unknown> = {}) {
  return {seq, handNo: 1, type, text: `${type}-${seq}`, ...extra};
}

test('语气映射：六个事件类型与五种动作各归各档，不认识的一律中性', () => {
  const {announce} = load();
  assert.deepStrictEqual(announce.TONES, ['big', 'medium', 'neutral', 'quiet', 'error']);

  assert.equal(announce.toneOf('action', 'allIn'), 'big', '全押最炸');
  assert.equal(announce.toneOf('action', 'raiseTo'), 'medium', '加注中等');
  assert.equal(announce.toneOf('action', 'call'), 'neutral');
  assert.equal(announce.toneOf('action', 'check'), 'neutral');
  assert.equal(announce.toneOf('action', 'fold'), 'quiet', '弃牌安静');
  assert.equal(announce.toneOf('street'), 'medium', '发公共牌中等');
  assert.equal(announce.toneOf('handStart'), 'neutral');
  assert.equal(announce.toneOf('settle'), 'big');
  assert.equal(announce.toneOf('finish'), 'big');
  assert.equal(announce.toneOf('pause'), 'error', '暂停要显眼');
  // 防御：服务端升级前的老事件没有 action，将来的新类型也不该让界面炸。
  assert.equal(announce.toneOf('action', undefined), 'neutral', '老事件缺 action 时不猜语气');
  assert.equal(announce.toneOf('action', 'sidePot'), 'neutral', '不认识的动作退回中性');
  assert.equal(announce.toneOf('somethingNew'), 'neutral', '不认识的类型退回中性');
});

test('每档都有停留时长，且是正数毫秒', () => {
  const {announce} = load();
  for (const tone of announce.TONES) {
    assert.equal(typeof announce.TONE_DURATION_MS[tone], 'number', `${tone} 缺时长`);
    assert.ok(announce.TONE_DURATION_MS[tone]! > 0, `${tone} 的时长必须是正数`);
  }
  assert.ok(announce.TONE_DURATION_MS.big! > announce.TONE_DURATION_MS.quiet!, '全押该比弃牌停得久');
});

test('首帧只建立基线，不把入桌前的历史事件补播一遍', () => {
  const display = fakeDisplay();
  const {timers, announce} = load();
  const announcer = announce.createAnnouncer({timers, display});

  announcer.ingest([event(1, 'action', {action: 'fold'}), event(2, 'street')], {initial: true});
  // 这里判长度而不是 deepStrictEqual(display.shown, [])：@types/node 把 deepStrictEqual
  // 声明成断言函数，拿 [] 当期望值会把 display.shown 收窄成 never[]，后面就取不出元素字段。
  assert.equal(display.shown.length, 0, '初始快照一条都不该播');
  assert.equal(display.hides, 0, '没播过就不必 hide');

  announcer.ingest([event(3, 'action', {action: 'allIn'})]);
  assert.equal(display.shown.length, 1);
  assert.equal(display.shown[0]!.text, 'action-3');
  assert.equal(display.shown[0]!.tone, 'big');

  // 低于或等于基线的 seq 永远不再播（刷新、重放都会走这条）。
  announcer.ingest([event(1, 'action', {action: 'fold'}), event(2, 'street')]);
  assert.equal(display.shown.length, 1, '旧事件不该重播');
});

test('按 seq 去重并升序播放，乱序到达也照事件顺序播', () => {
  const display = fakeDisplay();
  const {timers, announce} = load();
  const announcer = announce.createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(7, 'action', {action: 'raiseTo'}), event(5, 'action', {action: 'fold'})]);
  assert.equal(display.shown.length, 1, '同一时刻只播一条');
  assert.equal(display.shown[0]!.text, 'action-5', '先播 seq 小的');

  timers.tick(2000);
  assert.equal(display.shown.length, 2);
  assert.equal(display.shown[1]!.text, 'action-7');
  assert.equal(display.shown[1]!.tone, 'medium');

  announcer.ingest([event(7, 'action', {action: 'raiseTo'})]);
  assert.equal(display.shown.length, 2, '重复投入同一批事件不再播');
});

test('顺序播放：每条播完才播下一条，播完队列就收起横幅', () => {
  const display = fakeDisplay();
  const {timers, announce} = load();
  const announcer = announce.createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(1, 'action', {action: 'call'}), event(2, 'street'), event(3, 'settle')]);
  assert.deepStrictEqual(
    display.shown.map((item) => [item.text, item.tone, item.durationMs]),
    [['action-1', 'neutral', announce.TONE_DURATION_MS.neutral]],
    '第一条立刻播，且用中性档的时长'
  );
  assert.equal(display.hides, 0, '还有下一条时不该收起');

  timers.tick(announce.TONE_DURATION_MS.neutral!);
  assert.equal(display.shown[1]!.text, 'street-2');
  assert.equal(display.shown[1]!.tone, 'medium');

  timers.tick(announce.TONE_DURATION_MS.medium!);
  assert.equal(display.shown[2]!.text, 'settle-3');
  assert.equal(display.shown[2]!.tone, 'big');
  assert.equal(display.shown[2]!.durationMs, announce.TONE_DURATION_MS.big);

  timers.tick(announce.TONE_DURATION_MS.big!);
  assert.equal(display.shown.length, 3, '没有更多条目');
  assert.equal(display.hides, 1, '播完才收起');
});

test('一次涌入太多事件时只播最近几条，重连回来不会被历史刷屏', () => {
  const display = fakeDisplay();
  const {timers, announce} = load();
  const announcer = announce.createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  const flood = Array.from({length: 10}, (_, index) => event(index + 1, 'action', {action: 'call'}));
  announcer.ingest(flood);

  const played: string[] = [display.shown[0]!.text];
  for (let step = 0; step < announce.QUEUE_CAP; step += 1) timers.tick(announce.TONE_DURATION_MS.neutral!);
  played.push(...display.shown.slice(1).map((item) => item.text));

  assert.equal(played.length, announce.QUEUE_CAP, `最多播 ${announce.QUEUE_CAP} 条`);
  assert.deepStrictEqual(played, ['action-5', 'action-6', 'action-7', 'action-8', 'action-9', 'action-10'], '留下的是最近几条');
});

test('clear 停掉当前与排队中的，但不会让播过的事件重播', () => {
  const display = fakeDisplay();
  const {timers, announce} = load();
  const announcer = announce.createAnnouncer({timers, display});
  announcer.ingest([], {initial: true});

  announcer.ingest([event(1, 'action', {action: 'allIn'}), event(2, 'settle')]);
  assert.equal(display.shown.length, 1);

  announcer.clear();
  assert.equal(display.hides, 1, 'clear 要收起横幅');
  timers.tick(announce.TONE_DURATION_MS.big!);
  assert.equal(display.shown.length, 1, '排队中的那条不该再冒出来');

  // clear 不重置 seq 基线：重置房间后 seq 继续往上走，播过的不该重播。
  announcer.ingest([event(1, 'action', {action: 'allIn'}), event(2, 'settle')]);
  assert.equal(display.shown.length, 1);
});

test('缺省 display 与空输入都是无害的', () => {
  const {announce} = load();
  const announcer = announce.createAnnouncer({timers: createTimers()});
  assert.doesNotThrow(() => {
    announcer.ingest([event(1, 'settle')]);
    announcer.ingest(null);
    announcer.ingest([{seq: 'x', type: 'settle'}], {initial: true});
    announcer.clear();
  });
});
