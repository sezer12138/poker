import test from 'node:test';
import assert from 'node:assert/strict';
import {CHORDS, NOTES_PER_BAR, createMusic, noteAt} from '../static/js/music.js';

/**
 * 合成背景音乐的调度逻辑。Node 里没有 Web Audio，所以注入一个假上下文：
 * 它记录每个音符的频率与起止时刻，测试据此断言「排了哪些音、什么时候排的、静音有没有生效」。
 * 真实发声只能在浏览器里听，这一点如实记在验证报告里。
 */
function fakeAudioContext() {
  const context: any = {
    currentTime: 0,
    state: 'running',
    destination: {name: 'destination'},
    resumes: 0,
    oscillators: [] as any[],
    gains: [] as any[],
    resume() {
      context.resumes += 1;
      return Promise.resolve();
    },
    createOscillator() {
      const oscillator: any = {
        type: '',
        frequency: {value: 0},
        startedAt: null,
        stoppedAt: null,
        start(at: number) {
          oscillator.startedAt = at;
        },
        stop(at: number) {
          oscillator.stoppedAt = at;
        },
        connect(node: unknown) {
          return node; // 与浏览器一致：connect 返回目标节点，方便链式接。
        },
      };
      context.oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      const gain: any = {
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect(node: unknown) {
          return node;
        },
      };
      context.gains.push(gain);
      return gain;
    },
  };
  return context;
}

/** 可控的定时器：测试自己决定什么时候触发补排，不依赖真实时间。 */
function fakeTimers() {
  const timers: any = {
    callbacks: [] as {fn: () => void; ms: number; id: number}[],
    cleared: [] as number[],
    setInterval(fn: () => void, ms: number) {
      const id = timers.callbacks.length + 1;
      timers.callbacks.push({fn, ms, id});
      return id;
    },
    clearInterval(id: number) {
      timers.cleared.push(id);
    },
    /** 触发所有还活着的补排回调。 */
    tick() {
      for (const entry of timers.callbacks) if (!timers.cleared.includes(entry.id)) entry.fn();
    },
  };
  return timers;
}

test('和弦表是四个七和弦，琶音在弦内循环、按小节换和弦', () => {
  assert.equal(CHORDS.length, 4);
  assert.equal(noteAt(0), CHORDS[0][0], '第一个音是根音');
  assert.equal(noteAt(3), CHORDS[0][3]);
  assert.equal(noteAt(4), CHORDS[0][0], '弦内循环：一小节八分音符里弹两遍');
  assert.equal(noteAt(NOTES_PER_BAR), CHORDS[1][0], '每小节换一个和弦');
  assert.equal(noteAt(NOTES_PER_BAR * 4), CHORDS[0][0], '四个和弦之后回到第一个');
});

test('start 会排出前几个音，并起一个补排定时器', () => {
  const context = fakeAudioContext();
  const timers = fakeTimers();
  const music = createMusic({createContext: () => context, timers});

  assert.equal(music.start(), true);
  assert.equal(context.oscillators.length, 2, '起点只排满 0.6 秒的提前量');
  assert.equal(context.oscillators[0].frequency.value, CHORDS[0][0]);
  assert.equal(context.oscillators[1].frequency.value, CHORDS[0][1]);
  assert.equal(context.oscillators[0].type, 'triangle', '三角波比方波柔和，适合背景音');
  assert.equal(context.oscillators[0].stoppedAt - context.oscillators[0].startedAt, 1.2, '每个音有固定时长');
  assert.deepEqual(timers.callbacks.map((entry: any) => entry.ms), [200], '补排步长 200ms');
  assert.equal(context.gains[0].gain.value, 0.14, '主音量压得比较小');
  assert.equal(music.state().playing, true);
});

test('补排跟着上下文时间往前推，音符序号不重复', () => {
  const context = fakeAudioContext();
  const timers = fakeTimers();
  const music = createMusic({createContext: () => context, timers});
  music.start();
  const first = context.oscillators.length;

  context.currentTime = 10;
  timers.tick();
  const frequencies = context.oscillators.slice(first).map((oscillator: any) => oscillator.frequency.value);
  assert.ok(frequencies.length >= 12, `10 秒补排应该排出十来个音，实际 ${frequencies.length}`);
  // 序号连续：第 n 个音必然是 noteAt(n)。这里反查频率序列，确保没有跳音或重排。
  assert.deepEqual(
    frequencies.slice(0, 4),
    [noteAt(2), noteAt(3), noteAt(4), noteAt(5)].map(value => value),
    '从上次排到的位置接着往下排',
  );
  assert.deepEqual(
    [...new Set(context.oscillators.map((oscillator: any) => oscillator.startedAt))].length,
    context.oscillators.length,
    '没有两个音排在同一时刻',
  );
});

test('stop 之后不再排音符，重复 start 不会叠出第二个定时器', () => {
  const context = fakeAudioContext();
  const timers = fakeTimers();
  const music = createMusic({createContext: () => context, timers});
  music.start();
  const master = context.gains[0];
  const notes = context.oscillators.length;
  music.start();
  assert.equal(timers.callbacks.length, 1, '第二次 start 不再起定时器');
  assert.equal(context.oscillators.length, notes, '也不会凭空多排一遍音');
  assert.equal(context.gains[0], master, '主音量节点复用，不重复建');

  music.stop();
  assert.equal(music.state().playing, false);
  const before = context.oscillators.length;
  context.currentTime = 30;
  timers.tick(); // 就算还有一次陈旧的补排回调，也不该再出声
  assert.equal(context.oscillators.length, before, '停了就是停了');

  assert.equal(music.start(), true, '还能再开');
  assert.equal(context.gains[0], master, '再开也复用同一个主音量节点');
});

test('静音只是把主音量降到 0，调度继续跑（取消静音立刻有声）', () => {
  const context = fakeAudioContext();
  const timers = fakeTimers();
  const music = createMusic({createContext: () => context, timers});
  music.start();

  assert.equal(music.setMuted(true), true);
  assert.equal(context.gains[0].gain.value, 0);
  assert.equal(music.state().muted, true);
  const before = context.oscillators.length;
  context.currentTime = 5;
  timers.tick();
  assert.ok(context.oscillators.length > before, '静音期间照常调度，取消静音不会掉一拍');

  music.setMuted(false);
  assert.equal(context.gains[0].gain.value, 0.14);
});

test('toggle 开关一次并返回新状态', () => {
  const context = fakeAudioContext();
  const music = createMusic({createContext: () => context, timers: fakeTimers()});
  assert.equal(music.toggle(), true);
  assert.equal(music.state().playing, true);
  assert.equal(music.toggle(), false);
  assert.equal(music.state().playing, false);
});

test('没有 Web Audio 的环境里静默降级，不是抛错', () => {
  const music = createMusic({createContext: () => null, timers: fakeTimers()});
  assert.equal(music.start(), false, '开不起来就如实返回 false');
  assert.equal(music.state().playing, false);
  // Node 里没有 AudioContext，牌桌据此把开关置灰。
  assert.equal(music.state().supported, false);
  assert.doesNotThrow(() => music.stop());
  assert.doesNotThrow(() => music.setMuted(true));
});
