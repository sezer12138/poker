/**
 * 合成背景音乐的调度逻辑。Node 里没有 Web Audio，这里注入测试桩：
 * wx.createWebAudioContext 返回一个记录音符频率与起止时刻的假上下文，
 * 定时器用 harness 的可控时钟驱动，测试据此断言「排了哪些音、什么时候排的、静音有没有生效」。
 * 真机发声只能在小程序里听，这一点如实记在验证报告与 README 里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx, type FakeAudioContext} from './harness.ts';

interface MusicModule {
  CHORDS: number[][];
  NOTES_PER_BAR: number;
  noteAt(step: number): number;
  createMusic(options?: {timers?: unknown}): Music;
}

interface Music {
  start(): boolean;
  stop(): void;
  setMuted(value: boolean): boolean;
  toggle(): boolean;
  state(): {playing: boolean; muted: boolean; supported: boolean};
}

function load(audio: 'ok' | 'missing' = 'ok') {
  const wx = createWx({audio});
  const loader = createLoader({wx, timers: createTimers()});
  return {wx, music: loader.load('utils/music.js') as MusicModule};
}

test('和弦表是四个七和弦，琶音在弦内循环、按小节换和弦', () => {
  const {music} = load();
  assert.equal(music.CHORDS.length, 4);
  assert.equal(music.noteAt(0), music.CHORDS[0][0], '第一个音是根音');
  assert.equal(music.noteAt(3), music.CHORDS[0][3]);
  assert.equal(music.noteAt(4), music.CHORDS[0][0], '弦内循环：一小节八分音符里弹两遍');
  assert.equal(music.noteAt(music.NOTES_PER_BAR), music.CHORDS[1][0], '每小节换一个和弦');
  assert.equal(music.noteAt(music.NOTES_PER_BAR * 4), music.CHORDS[0][0], '四个和弦之后回到第一个');
});

test('start 会借 wx.createWebAudioContext 排出前几个音，并起一个补排定时器', () => {
  const {wx, music} = load();
  const timers = createTimers();
  const created = music.createMusic({timers});
  assert.equal(created.start(), true);
  const context = wx.audioContexts[0] as FakeAudioContext;
  assert.ok(context, 'start 应该建一次 WebAudioContext');
  assert.equal(wx.audioContexts.length, 1, '重复 start 不重复建上下文');
  assert.equal(context.oscillators.length, 2, '起点只排满 0.6 秒的提前量');
  assert.equal(context.oscillators[0].frequency.value, music.CHORDS[0][0]);
  assert.equal(context.oscillators[1].frequency.value, music.CHORDS[0][1]);
  assert.equal(context.oscillators[0].type, 'triangle', '三角波比方波柔和，适合背景音');
  assert.equal(context.oscillators[0].stoppedAt! - context.oscillators[0].startedAt!, 1.2, '每个音有固定时长');
  assert.equal(context.gains[0].gain.value, 0.14, '主音量压得比较小');
  assert.equal(timers.pending(), 1, '补排定时器只起一个');
  assert.equal(created.state().playing, true);
});

test('补排跟着上下文时间往前推，音符序号不重复', () => {
  const {wx, music} = load();
  const timers = createTimers();
  const created = music.createMusic({timers});
  created.start();
  const context = wx.audioContexts[0] as FakeAudioContext;
  const first = context.oscillators.length;

  context.currentTime = 10;
  timers.tick(200);
  const frequencies = context.oscillators.slice(first).map((oscillator) => oscillator.frequency.value);
  assert.ok(frequencies.length >= 12, `10 秒补排应该排出十来个音，实际 ${frequencies.length}`);
  // 序号连续：第 n 个音必然是 noteAt(n)。这里反查频率序列，确保没有跳音或重排。
  assert.deepStrictEqual(frequencies.slice(0, 4), [2, 3, 4, 5].map((step) => music.noteAt(step)));
  const started = context.oscillators.map((oscillator) => oscillator.startedAt);
  assert.equal(new Set(started).size, started.length, '没有两个音排在同一时刻');
});

test('stop 之后不再排音符，重复 start 不会叠出第二个定时器', () => {
  const {wx, music} = load();
  const timers = createTimers();
  const created = music.createMusic({timers});
  created.start();
  const context = wx.audioContexts[0] as FakeAudioContext;
  const master = context.gains[0];
  const notes = context.oscillators.length;
  created.start();
  assert.equal(timers.pending(), 1, '第二次 start 不再起定时器');
  assert.equal(context.oscillators.length, notes, '也不会凭空多排一遍音');
  assert.equal(context.gains[0], master, '主音量节点复用，不重复建');

  created.stop();
  assert.equal(created.state().playing, false);
  assert.equal(timers.pending(), 0, '停了要把定时器清掉，否则页面隐藏后还在跑');
  const before = context.oscillators.length;
  context.currentTime = 30;
  timers.tick(400); // 就算还有一次陈旧的补排回调，也不该再出声
  assert.equal(context.oscillators.length, before, '停了就是停了');
});

test('静音只是把主音量降到 0，调度继续跑（取消静音立刻有声）', () => {
  const {wx, music} = load();
  const timers = createTimers();
  const created = music.createMusic({timers});
  created.start();
  const context = wx.audioContexts[0] as FakeAudioContext;

  assert.equal(created.setMuted(true), true);
  assert.equal(context.gains[0].gain.value, 0);
  assert.equal(created.state().muted, true);
  const before = context.oscillators.length;
  context.currentTime = 5;
  timers.tick(200);
  assert.ok(context.oscillators.length > before, '静音期间照常调度，取消静音不会掉一拍');

  created.setMuted(false);
  assert.equal(context.gains[0].gain.value, 0.14);
});

test('toggle 开关一次并返回新状态', () => {
  const {music} = load();
  const created = music.createMusic({timers: createTimers()});
  assert.equal(created.toggle(), true);
  assert.equal(created.state().playing, true);
  assert.equal(created.toggle(), false);
  assert.equal(created.state().playing, false);
});

test('基础库没有 createWebAudioContext 时静默降级，不是抛错', () => {
  // 老基础库上属性本身不存在；装载模块（模块顶层不碰 wx）不能因此报错。
  const {wx, music} = load('missing');
  assert.equal(wx.createWebAudioContext, undefined);
  const created = music.createMusic({timers: createTimers()});
  assert.equal(created.start(), false, '开不起来就如实返回 false');
  assert.equal(created.state().playing, false);
  assert.equal(created.state().supported, false, '牌桌据此把开关置灰');
  assert.doesNotThrow(() => created.stop());
  assert.doesNotThrow(() => created.setMuted(true));
  assert.equal(created.toggle(), false);
});

test('有 Web Audio 能力时 supported 为真，即使还没开始放', () => {
  const {music} = load();
  const created = music.createMusic({timers: createTimers()});
  assert.equal(created.state().supported, true);
  assert.equal(created.state().playing, false);
});
