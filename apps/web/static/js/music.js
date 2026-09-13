// 背景音乐：用 Web Audio 实时合成，不加载任何音频文件（pages.test.ts 禁止页面引用外部
// 资源，合成音乐也就没有版权与体积问题）。
//
// 约束：模块顶层不访问 window/AudioContext，浏览器 API 只在函数体内使用，Node 才能
// 直接 import 本文件做单元测试（注入假上下文，见 test/music.test.ts）。

/** 曲子速度：慢，像咖啡馆里的背景音，不抢牌桌的注意力。 */
const BPM = 70;
/** 一拍时长（秒）。 */
const BEAT_S = 60 / BPM;
/** 每小节 8 个八分音符。 */
export const NOTES_PER_BAR = 8;
/** 调度步长：每隔多久补排一次音符。 */
const LOOKAHEAD_MS = 200;
/** 每次补排的提前量，够盖住定时器抖动即可。 */
const SCHEDULE_AHEAD_S = 0.6;
/** 主题音量。合成波形的谐波多，比采样音源更容易吵，压小一点。 */
const MASTER_GAIN = 0.14;

/**
 * Cmaj7 – Am7 – Fmaj7 – G7 的琶音，一小节一个和弦（频率单位 Hz，均为十二平均律）。
 * 这四个和弦没有半音冲突，随便按什么顺序循环听着都顺，适合无限循环。
 */
export const CHORDS = [
  [261.63, 329.63, 392.0, 493.88], // Cmaj7
  [220.0, 261.63, 329.63, 392.0], // Am7
  [174.61, 220.0, 261.63, 329.63], // Fmaj7
  [196.0, 246.94, 293.66, 349.23], // G7
];

/** 第 step 个八分音符对应的频率：先按小节选和弦，再在弦内循环。 */
export function noteAt(step) {
  const chord = CHORDS[Math.floor(step / NOTES_PER_BAR) % CHORDS.length];
  return chord[step % chord.length];
}

/**
 * 浏览器里真正建上下文的办法。放在函数里而不是模块顶层：Node 导入本模块做测试时
 * 根本没有 window，顶层建上下文会当场炸掉。
 */
function defaultAudioContext() {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    return new Ctor();
  } catch {
    return null; // 某些环境（隐私模式、无音频设备）直接抛错，静默降级为没有音乐。
  }
}

/**
 * 合成背景音乐。返回的每个方法都可以安全地重复调用：
 * 没有 Web Audio 的环境（老浏览器、Node、小程序真机不支持）里 start 是空操作，
 * state().supported 为 false，牌桌据此把开关按钮置灰而不是假装在放。
 */
export function createMusic(options = {}) {
  const createContext = options.createContext ?? defaultAudioContext;
  const timers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: id => clearInterval(id),
  };

  let context = null;
  let master = null;
  let timer = null;
  let step = 0;
  let nextNoteAt = 0;
  let playing = false;
  let muted = false;

  function playNote(frequency, at) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.value = frequency;
    // 慢起慢落：没有包络的方波会"咔"一声，背景音乐里最刺耳的就是这个。
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(1, at + 0.05);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
    oscillator.connect(envelope).connect(master);
    oscillator.start(at);
    oscillator.stop(at + 1.2);
  }

  /** 把 SCHEDULE_AHEAD_S 之内的音符排出去。定时器只负责补排，不负责发声时刻。 */
  function schedule() {
    // playing 是防御性的：停掉之后即使还有一次陈旧的定时器回调，也不该再排出音符。
    if (!playing || context === null) return;
    const horizon = context.currentTime + SCHEDULE_AHEAD_S;
    while (nextNoteAt < horizon) {
      playNote(noteAt(step), nextNoteAt);
      step += 1;
      nextNoteAt += BEAT_S / 2; // 八分音符
    }
  }

  function start() {
    if (playing) return true;
    if (context === null) context = createContext();
    if (context === null) return false;
    if (master === null) {
      master = context.createGain();
      master.gain.value = muted ? 0 : MASTER_GAIN;
      master.connect(context.destination);
    }
    // 自动播放策略会让上下文停在 suspended：这里试着唤醒，失败也无所谓——
    // 用户点「音乐」本身就是一次手势，届时调用 resume 即可。
    if (typeof context.resume === 'function' && context.state === 'suspended') void context.resume();
    playing = true;
    step = 0;
    nextNoteAt = context.currentTime;
    schedule();
    timer = timers.setInterval(schedule, LOOKAHEAD_MS);
    return true;
  }

  function stop() {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
    playing = false;
  }

  function setMuted(next) {
    muted = Boolean(next);
    if (master !== null) master.gain.value = muted ? 0 : MASTER_GAIN;
    return muted;
  }

  return {
    start,
    stop,
    setMuted,
    /** 开关一次，返回开关之后是否在放。牌桌按钮直接用返回值改文案。 */
    toggle() {
      if (playing) {
        stop();
        return false;
      }
      return start();
    },
    state() {
      // supported 看的是「这个环境有没有 Web Audio」，不是「现在有没有在放」：
      // 牌桌据此把开关置灰，而不是让玩家点一个永远不响的按钮。
      const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      return {playing, muted, supported: context !== null || typeof Ctor === 'function'};
    },
  };
}
