// 牌桌播报：把服务端事件流里「谁做了什么」放大成牌桌中央的一条闪现横幅。
// 约束与 music.js 一致：模块顶层不碰 window/document，定时器在函数体内取，
// 队列逻辑与 DOM 分离，所以能在 Node 里用假时钟直接测。
//
// 语气由服务端给的结构化字段决定（events[].action），不解析中文文案：
// 全押最炸、加注中等、跟注/过牌平、弃牌安静、暂停报警。纯视觉不发声。

/** 语气档位。样式表里一一对应 .announce--<tone>。 */
export const TONES = ['big', 'medium', 'neutral', 'quiet', 'error'];

/** 每档停留时长（毫秒）。show 收到的时长与 CSS 动画时长用的是同一个数。 */
export const TONE_DURATION_MS = {
  big: 2400,
  medium: 1800,
  neutral: 1500,
  quiet: 1200,
  error: 2200,
};

/** 队列上限：一次快照可能夹带一整手的事件（重连后尤其多），只留最近几条。 */
export const QUEUE_CAP = 6;

/**
 * 事件 → 语气。服务端 events[].type 只有六个取值，只有 action 事件带 action 字段。
 * 服务端升级前落盘的老事件没有 action，这时退回中性：文字照报，只是不猜语气。
 */
export function toneOf(type, action) {
  if (type === 'action') {
    if (action === 'allIn') return 'big';
    if (action === 'raiseTo') return 'medium';
    if (action === 'fold') return 'quiet';
    return 'neutral'; // call / check / 老事件缺 action / 不认识的动作
  }
  if (type === 'street') return 'medium';
  if (type === 'settle' || type === 'finish') return 'big';
  if (type === 'pause') return 'error';
  return 'neutral'; // handStart 与将来新增的类型
}

/**
 * 播报器：吃事件流，按顺序把要播的条目交给 display。
 * - 按 seq 去重，seq 是服务端全局单调递增的，重连、重放、刷新都不会重复播报。
 * - initial 只建立基线不播报：刚进牌桌时快照里已经有历史事件，那些不该再报一遍。
 * - display/timers 可注入，测试用假时钟驱动；默认 display 是无害的空实现。
 */
export function createAnnouncer(options = {}) {
  const timers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  };
  const display = options.display ?? {show() {}, hide() {}};

  let lastSeq = -1;
  let queue = [];
  let playing = false;
  let hideTimer = null;

  function playNext() {
    if (queue.length === 0) {
      playing = false;
      display.hide();
      return;
    }
    playing = true;
    const item = queue.shift();
    display.show(item.text, item.tone, item.durationMs);
    hideTimer = timers.setTimeout(() => {
      hideTimer = null;
      playing = false;
      playNext();
    }, item.durationMs);
  }

  return {
    /**
     * @param {Array<{seq:number,type:string,text?:string,action?:string}>} events 服务端的 events 数组
     * @param {{initial?: boolean}} [opts] initial=true 表示这是本页第一次收到快照（或刚重连）
     */
    ingest(events, opts = {}) {
      const list = Array.isArray(events) ? events : [];
      const known = list.filter(event => Number.isInteger(event?.seq));
      if (opts.initial) {
        // 只记基线，不播：历史事件是「已经发生过的」，玩家不在场时发生的不该补报。
        lastSeq = known.reduce((max, event) => Math.max(max, event.seq), lastSeq);
        queue = [];
        return;
      }
      const fresh = known.filter(event => event.seq > lastSeq).sort((a, b) => a.seq - b.seq);
      if (fresh.length === 0) return;
      lastSeq = fresh[fresh.length - 1].seq;
      for (const event of fresh) {
        const tone = toneOf(event.type, event.action);
        queue.push({text: String(event.text ?? ''), tone, durationMs: TONE_DURATION_MS[tone]});
      }
      if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP);
      if (!playing) playNext();
    },

    /** 停掉当前这条与排队中的（离开页面、重置房间时用）。lastSeq 不重置：seq 单调，重播没道理。 */
    clear() {
      queue = [];
      if (hideTimer !== null) {
        timers.clearTimeout(hideTimer);
        hideTimer = null;
      }
      playing = false;
      display.hide();
    },
  };
}
