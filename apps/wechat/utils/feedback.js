// 事件序号是唯一去重依据；历史快照、后台页面和批量追赶不排队补播。
function createFeedback(options = {}) {
  const play = options.play || (() => {});
  const stop = options.stop || (() => {});
  const enabled = {voice: false, sfx: false};
  let lastSeq = -1;
  let active = true;
  return {
    setEnabled(channel, value) {
      if (!(channel in enabled)) return;
      enabled[channel] = Boolean(value);
      if (!value) stop(channel);
    },
    setActive(value) {
      active = Boolean(value);
      if (!active) { stop('voice'); stop('sfx'); }
    },
    ingest(events, {initial = false} = {}) {
      const fresh = (Array.isArray(events) ? events : [])
        .filter(e => Number.isInteger(e.seq) && e.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      if (!fresh.length) return null;
      lastSeq = fresh[fresh.length - 1].seq;
      if (initial || !active) return null;
      const event = fresh[fresh.length - 1];
      const actions = {fold: 'fold', check: 'check', call: 'call', raiseTo: 'raiseTo', allIn: 'allIn'};
      const action = fresh.filter(e => e.type === 'action' && e.handNo === event.handNo).pop();
      const voice = action && Object.prototype.hasOwnProperty.call(actions, action.action) ? actions[action.action] : null;
      const sfx = ['handStart', 'street'].includes(event.type) ? 'deal'
        : ['settle', 'finish'].includes(event.type) ? 'win'
        : voice ? (['call', 'raiseTo', 'allIn'].includes(voice) ? 'chips' : 'tap') : null;
      if (sfx && enabled.sfx) play('sfx', sfx);
      if (voice && enabled.voice) play('voice', voice, action.amount);
      return {event, voice, sfx};
    }
  };
}



/** 将安全整数转成包内中文数字片段，支持万、亿、兆，不向第三方发送牌局信息。 */
function speechClips(action, amount) {
  if (!['raiseTo', 'allIn'].includes(action) || !Number.isSafeInteger(amount) || amount < 0) return [action];
  const groups = [];
  let remaining = amount;
  do { groups.push(remaining % 10000); remaining = Math.floor(remaining / 10000); } while (remaining);
  const number = [];
  const large = ['', 'tenThousand', 'hundredMillion', 'trillion'];
  const small = ['', 'ten', 'hundred', 'thousand'];
  let gap = false;
  for (let group = groups.length - 1; group >= 0; group--) {
    const value = groups[group];
    if (!value) { if (number.length) gap = true; continue; }
    if (number.length && (gap || value < 1000)) number.push('n0');
    gap = false;
    let zero = false;
    let spoken = false;
    for (let place = 3; place >= 0; place--) {
      const digit = Math.floor(value / (10 ** place)) % 10;
      if (!digit) { if (spoken) zero = true; continue; }
      if (zero) number.push('n0');
      if (!(digit === 1 && place === 1 && number.length === 0)) number.push('n' + digit);
      if (place) number.push(small[place]);
      spoken = true;
      zero = false;
    }
    if (group) number.push(large[group]);
  }
  if (!number.length) number.push('n0');
  return [action === 'raiseTo' ? 'raiseAmount' : 'allInAmount', ...number, 'chipUnit'];
}

/** 一句话播完才轮到下一句；关闭/切后台会清空整句队列，旧 onEnded 不能续播。 */
function createVoiceQueue({playClip, stopClip}) {
  let pending = [];
  let playing = false;
  let generation = 0;
  function next() {
    if (!pending.length) { playing = false; return; }
    playing = true;
    const clips = pending.shift();
    const current = generation;
    let index = 0;
    function step() {
      if (current !== generation) return;
      if (index === clips.length) { next(); return; }
      const clip = clips[index++];
      let completed = false;
      playClip(clip, () => {
        if (completed) return;
        completed = true;
        step();
      });
    }
    step();
  }
  return {
    enqueue(clips) {
      if (!clips.length) return;
      pending.push([...clips]);
      if (pending.length > 8) pending.shift();
      if (!playing) next();
    },
    clear() {
      generation++;
      pending = [];
      playing = false;
      stopClip();
    }
  };
}

module.exports = {createFeedback, speechClips, createVoiceQueue};
