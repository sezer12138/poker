/**
 * 牌桌：座位与 D/小盲/大盲标记、倒计时（deadline - (Date.now() + offset)）、
 * 公共牌、自己的底牌、筹码/投入、主池边池、事件流、操作区、每手结算确认弹窗、背景音乐。
 * 合法行动一律取 hand.legal（服务端唯一裁判），客户端不自行判断合法性。
 */
const api = require('../../utils/api.js');
const auth = require('../../utils/auth.js');
const wsUtil = require('../../utils/ws.js');
const cards = require('../../utils/cards.js');
const format = require('../../utils/format.js');
const fairness = require('../../utils/fairness.js');
const settleUtil = require('../../utils/settle.js');
const feedbackUtil = require('../../utils/feedback.js');
const musicUtil = require('../../utils/music.js');
const announceUtil = require('../../utils/announce.js');
const config = require('../../config.js');

const SEAT_COUNT = 9;
const ANGLE_STEP = 40;
const EVENT_LIMIT = 8;
const TICK_MS = 200;
const POT_FRACTIONS = [0.5, 0.75, 1];

const STATUS_LABEL = {
  connecting: '连接中',
  open: '已连接',
  closed: '连接已断开',
  error: '连接异常',
  reconnecting: '重连中',
  failed: '连接失败'
};

/** 自己在正下方，其余座位按 40° 均匀分布在椭圆上（屏幕坐标 y 向下）。 */
function seatPosition(displayIndex) {
  const angle = ((90 + displayIndex * ANGLE_STEP) * Math.PI) / 180;
  return {
    left: Math.round((50 + 44 * Math.cos(angle)) * 10) / 10,
    top: Math.round((50 + 40 * Math.sin(angle)) * 10) / 10
  };
}

function findPlayer(hand, seat) {
  if (!hand || typeof seat !== 'number') return null;
  return hand.players.filter(function (player) {
    return player.seat === seat;
  })[0] || null;
}

function buildSeats(room) {
  const hand = room.hand;
  const players = hand ? hand.players : [];
  const members = room.members || [];
  const viewerSeat = typeof room.viewerSeat === 'number' ? room.viewerSeat : null;
  const button = hand ? hand.button : null;
  const blinds = format.blindSeats(players, button);
  const awards = {};
  if (hand && hand.result) {
    hand.result.awards.forEach(function (award) {
      awards[award.seat] = (awards[award.seat] || 0) + award.amount;
    });
  }
  const seats = [];
  for (let seat = 0; seat < SEAT_COUNT; seat += 1) {
    const member = members.filter(function (m) {
      return m.seat === seat;
    })[0] || null;
    const player = findPlayer(hand, seat);
    const displayIndex = viewerSeat === null ? seat : (seat - viewerSeat + SEAT_COUNT) % SEAT_COUNT;
    const position = seatPosition(displayIndex);
    let stack = 0;
    if (player) stack = player.stack;
    // 等待阶段服务端还没有真实筹码，显示引擎的起手筹码。
    else if (room.status === 'waiting') stack = format.STARTING_STACK;
    seats.push({
      seat: seat,
      displayIndex: displayIndex,
      left: position.left,
      top: position.top,
      occupied: !!member,
      name: member ? member.name : '空座',
      bot: !!(member && member.bot),
      self: viewerSeat === seat,
      host: !!(member && room.hostId === member.userId),
      inHand: !!player,
      folded: !!(player && player.folded),
      stackText: format.chips(stack),
      committedText: player && player.committed > 0 ? format.chips(player.committed) : '',
      roundBetText: player && player.roundBet > 0 ? format.chips(player.roundBet) : '',
      isButton: button === seat,
      isSmallBlind: blinds.smallBlind === seat,
      isBigBlind: blinds.bigBlind === seat,
      isActor: !!(hand && hand.actor === seat),
      awardText: awards[seat] ? '+' + format.chips(awards[seat]) : '',
      cards: player ? cards.seatViews(player.hole, 2) : []
    });
  }
  seats.sort(function (a, b) {
    return a.displayIndex - b.displayIndex;
  });
  return seats;
}

function buildBoard(hand) {
  const views = cards.views(hand ? hand.board : []);
  const slots = [];
  for (let i = 0; i < 5; i += 1) {
    slots.push(views[i] || { hidden: true, empty: true, text: '', red: false });
  }
  return slots;
}

function buildPots(hand) {
  const state = { potTotal: 0, potTotalText: '0', potRows: [], awardRows: [], refundRows: [] };
  if (!hand) return state;
  state.potTotal = hand.players.reduce(function (sum, player) {
    return sum + player.committed;
  }, 0);
  state.potTotalText = format.chips(state.potTotal);
  const result = hand.result;
  if (!result) return state;
  const multi = result.pots.length > 1;
  state.potRows = result.pots.map(function (pot, index) {
    return {
      label: multi ? (index === 0 ? '主池' : '边池 ' + index) : '主池',
      amountText: format.chips(pot.amount),
      eligibleText: pot.eligible
        .map(function (seat) {
          return format.seatText(seat);
        })
        .join('、')
    };
  });
  state.awardRows = result.awards.map(function (award) {
    return { seatText: format.seatText(award.seat), amountText: format.chips(award.amount) };
  });
  state.refundRows = result.refunds.map(function (refund) {
    return { seatText: format.seatText(refund.seat), amountText: format.chips(refund.amount) };
  });
  return state;
}

/** 快捷金额只是「目标累计投入」的建议值，服务端仍会校验。 */
function quickTargets(pot, callAmount, myRoundBet, raiseMin, raiseMax) {
  const potAfterCall = pot + callAmount;
  const base = myRoundBet + callAmount;
  const targets = [];
  function push(value) {
    const target = Math.round(value);
    if (target < raiseMin || target > raiseMax) return;
    if (targets.indexOf(target) >= 0) return;
    targets.push(target);
  }
  push(raiseMin);
  POT_FRACTIONS.forEach(function (fraction) {
    push(base + potAfterCall * fraction);
  });
  push(raiseMax);
  targets.sort(function (a, b) {
    return a - b;
  });
  return targets.map(function (target) {
    return {
      target: target,
      add: target - myRoundBet,
      addText: format.chips(target - myRoundBet),
      label: target === raiseMin ? '最小' : target === raiseMax ? '全押目标' : format.chips(target)
    };
  });
}

function buildActionState(room) {
  const state = {
    myTurn: false,
    canFold: false,
    canCheck: false,
    canCall: false,
    canRaise: false,
    canAllIn: false,
    callText: '',
    callAmount: 0,
    raiseMin: 0,
    raiseMax: 0,
    myRoundBet: 0,
    myCommittedText: '0',
    quickTargets: [],
    waitingText: ''
  };
  const hand = room.hand;
  if (!hand) {
    state.waitingText = '等待比赛开始';
    return state;
  }
  const me = findPlayer(hand, room.viewerSeat);
  state.myRoundBet = me ? me.roundBet : 0;
  state.myCommittedText = format.chips(me ? me.committed : 0);
  const legal = hand.legal;
  if (!legal) {
    state.waitingText = hand.actor === null ? '本手等待结算' : '等待其他玩家行动';
    return state;
  }
  state.myTurn = true;
  state.canFold = legal.fold === true;
  state.canCheck = legal.check === true;
  state.canCall = legal.call !== null;
  state.callAmount = legal.call || 0;
  state.callText = '跟注 ' + format.chips(state.callAmount);
  state.canRaise = legal.minRaiseTo !== null && legal.maxRaiseTo !== null;
  state.canAllIn = legal.allIn === true;
  if (state.canRaise) {
    state.raiseMin = legal.minRaiseTo;
    state.raiseMax = legal.maxRaiseTo;
    const pot = hand.players.reduce(function (sum, player) {
      return sum + player.committed;
    }, 0);
    state.quickTargets = quickTargets(pot, state.callAmount, state.myRoundBet, state.raiseMin, state.raiseMax);
  }
  return state;
}

Page({
  data: {
    roomId: '',
    room: null,
    hand: null,
    viewerSeat: null,
    seats: [],
    board: [],
    streetText: '',
    handNo: 0,
    blindText: '',
    levelText: '',
    linkText: '未连接',
    potTotalText: '0',
    potRows: [],
    awardRows: [],
    refundRows: [],
    events: [],
    announce: null,
    offset: 0,
    countdownText: '—',
    countdownUrgent: false,
    nextHandText: '',
    hasNextHand: false,
    myTurn: false,
    canFold: false,
    canCheck: false,
    canCall: false,
    canRaise: false,
    canAllIn: false,
    callText: '',
    callAmount: 0,
    raiseMin: 0,
    raiseMax: 0,
    raiseTarget: 0,
    raiseAddText: '0',
    quickTargets: [],
    waitingText: '',
    myRoundBet: 0,
    myCommittedText: '0',
    fairnessTip: '',
    notice: '',
    serverNotice: '',
    error: '',
    busy: false,
    finished: false,
    winnerText: '',
    dialog: null,
    dialogTimerText: '',
    musicText: '音乐：关',
    voiceText: '语音：关',
    sfxText: '音效：关',
    motionClass: ''
  },

  onLoad(query) {
    this.setData({ roomId: (query && query.roomId) || '' });
  },

  onShow() {
    this.setupFeedback();
    this.feedback.setActive(true);
    this.feedbackInitial = true;
    this.attach();
  },

  onHide() {
    this.detach();
  },

  onUnload() {
    this.detach();
    Object.values(this.audioChannels || {}).forEach(function (audio) { audio.destroy(); });
    this.audioChannels = {};
  },

  attach() {
    const self = this;
    if (this.attached) return;
    this.attached = true;
    if (!this.data.roomId) {
      this.setData({ error: '缺少房间号' });
      return;
    }
    auth.ensureLogin().then(
      function () {
        self.openSocket();
        self.refresh();
        self.startTick();
        self.resumeMusic();
      },
      function (err) {
        self.setData({ error: format.errorText(err) });
      }
    );
  },

  detach() {
    this.attached = false;
    if (this.feedback) this.feedback.setActive(false);
    this.feedbackInitial = true;
    if (this.announcer) this.announcer.clear();
    this.announced = false;
    if (this.motionTimer) clearTimeout(this.motionTimer);
    this.stopTick();
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    // 离开牌桌就停音乐：小程序页面隐藏后定时器仍在跑，不停会一直出声。
    if (this.music) this.music.stop();
  },

  /** 只有玩家自己开过音乐才会在回到牌桌时续播，不擅自出声。 */
  resumeMusic() {
    const music = this.setupMusic();
    const wanted = wx.getStorageSync(config.storage.music) === 'on';
    if (wanted && !music.state().playing) music.start();
    this.setData({ musicText: this.musicLabel(music.state().playing) });
  },

  setupMusic() {
    if (!this.music) this.music = musicUtil.createMusic({});
    return this.music;
  },

  musicLabel(playing) {
    // 没有 Web Audio 能力时如实说「不可用」，而不是让按钮点着没反应。
    if (!this.music || !this.music.state().supported) return '音乐：不可用';
    return playing ? '音乐：开' : '音乐：关';
  },

  onMusic() {
    const music = this.setupMusic();
    if (!music.state().supported) {
      this.setData({ musicText: this.musicLabel(false) });
      return;
    }
    const playing = music.toggle();
    wx.setStorageSync(config.storage.music, playing ? 'on' : 'off');
    this.setData({ musicText: this.musicLabel(playing) });
  },

  setupFeedback() {
    if (this.feedback) return;
    const self = this;
    this.audioChannels = {};
    this.audioEnabled = {};
    this.voiceQueue = feedbackUtil.createVoiceQueue({
      playClip: (clip, done) => this.playFeedbackClip('voice', clip, done),
      stopClip: () => { if (this.audioChannels.voice) this.audioChannels.voice.stop(); }
    });
    this.feedbackInitial = true;
    this.feedback = feedbackUtil.createFeedback({
      play: function (channel, clip, amount) { self.playFeedback(channel, clip, amount); },
      stop: function (channel) {
        if (channel === 'voice') self.voiceQueue.clear();
        else if (self.audioChannels[channel]) self.audioChannels[channel].stop();
      }
    });
    ['voice', 'sfx'].forEach(function (channel) {
      self.audioEnabled[channel] = wx.getStorageSync(config.storage[channel]) === 'on';
      self.feedback.setEnabled(channel, self.audioEnabled[channel]);
      self.setData({[channel + 'Text']: (channel === 'voice' ? '语音' : '音效') + '：' + (self.audioEnabled[channel] ? '开' : '关')});
    });
  },

  playFeedback(channel, clip, amount) {
    if (channel === 'voice') this.voiceQueue.enqueue(feedbackUtil.speechClips(clip, amount));
    else this.playFeedbackClip(channel, clip);
  },

  playFeedbackClip(channel, clip, done) {
    try {
      if (typeof wx.createInnerAudioContext !== 'function') throw new Error('unsupported');
      let audio = this.audioChannels[channel];
      if (!audio) {
        audio = wx.createInnerAudioContext();
        audio.onEnded(() => { if (this.audioDone && this.audioDone[channel]) this.audioDone[channel](); });
        audio.onError(() => {
          this.setData({notice: '声音未能播放，请检查设备音量并重新启用声音。'});
          if (channel === 'voice') this.voiceQueue.clear();
        });
        this.audioChannels[channel] = audio;
      }
      audio.stop();
      if (!this.audioDone) this.audioDone = {};
      this.audioDone[channel] = done;
      audio.src = '/audio/' + clip + '.mp3';
      audio.volume = channel === 'voice' ? 0.85 : 0.4;
      audio.play();
    } catch (err) {
      this.setData({notice: '当前设备无法播放声音'});
      if (channel === 'voice') this.voiceQueue.clear();
    }
  },

  onFeedback(event) {
    this.setupFeedback();
    const channel = event.currentTarget.dataset.channel;
    if (!['voice', 'sfx'].includes(channel)) return;
    const enabled = !this.audioEnabled[channel];
    this.audioEnabled[channel] = enabled;
    this.feedback.setEnabled(channel, enabled);
    wx.setStorageSync(config.storage[channel], enabled ? 'on' : 'off');
    this.setData({[channel + 'Text']: (channel === 'voice' ? '语音' : '音效') + '：' + (enabled ? '开' : '关')});
    if (enabled) this.playFeedback(channel, channel === 'voice' ? 'check' : 'chips');
  },

  openSocket() {
    const self = this;
    if (this.client) return;
    this.client = wsUtil.createClient({
      roomId: this.data.roomId,
      onState(room) {
        self.applyRoom(room);
      },
      onError(error) {
        self.setData({ notice: '连接提醒：' + ((error && error.message) || '未知错误') });
      },
      onStatus(status) {
        if (status !== 'open') self.feedbackInitial = true;
        self.setData({ linkText: STATUS_LABEL[status] || status });
      },
      onClosed(decision) {
        // 顶号/被移出房间：服务端不会再放行，直接显示中文原因，不再重连。
        self.setData({ busy: false, error: decision.message });
      }
    });
    this.client.connect();
  },

  /** 回退路径：socket 断开时仍能刷新状态。 */
  refresh() {
    const self = this;
    api.getRoom(this.data.roomId).then(
      function (room) {
        self.applyRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  startTick() {
    const self = this;
    if (this.ticker) return;
    this.ticker = setInterval(function () {
      self.syncClock();
    }, TICK_MS);
    this.syncClock();
  },

  stopTick() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  syncClock() {
    const room = this.data.room;
    if (!room) return;
    const offset = this.data.offset;
    const action = format.countdown(room.deadline, offset, Date.now());
    const next =
      typeof room.nextHandAt === 'number'
        ? format.countdown(room.nextHandAt, offset, Date.now())
        : { text: '', expired: true };
    const patch = {};
    if (this.data.countdownText !== action.text) patch.countdownText = action.text;
    if (this.data.countdownUrgent !== action.urgent) patch.countdownUrgent = action.urgent;
    if (this.data.nextHandText !== next.text) patch.nextHandText = next.text;
    const hasNextHand = typeof room.nextHandAt === 'number' && !next.expired;
    if (this.data.hasNextHand !== hasNextHand) patch.hasNextHand = hasNextHand;
    // 结算弹窗里的兜底倒计时：到点服务端会自己开下一手，玩家点不点确认都不会卡住。
    const dialogTimerText = this.data.dialog
      ? typeof room.nextHandAt === 'number'
        ? '倒计时结束自动开下一手 · ' + next.text
        : ''
      : '';
    if (this.data.dialogTimerText !== dialogTimerText) patch.dialogTimerText = dialogTimerText;
    if (Object.keys(patch).length > 0) this.setData(patch);
  },

  applyRoom(room) {
    fairness.rememberFromRoom(room);
    const hand = room.hand;
    const action = buildActionState(room);
    const potState = buildPots(hand);
    const raiseTarget = action.canRaise
      ? Math.max(action.raiseMin, Math.min(action.raiseMax, this.data.raiseTarget || action.raiseMin))
      : 0;
    // 结算确认弹窗：比赛结束时服务端不再开确认门（settle 为空），弹窗自然收起。
    const dialogModel = settleUtil.buildResultDialog(hand, room.members, room.settle, room.viewerSeat);
    const dialog = dialogModel && this.dismissedHand !== dialogModel.handNo ? dialogModel : null;
    this.setData({
      dialog: dialog,
      room: room,
      hand: hand,
      viewerSeat: typeof room.viewerSeat === 'number' ? room.viewerSeat : null,
      seats: buildSeats(room),
      board: buildBoard(hand),
      streetText: hand ? format.streetText(hand.street) : '',
      handNo: hand ? hand.id : 0,
      blindText: format.blindLabel(room.blinds),
      levelText: format.handsToNextLevelText(room.handsToNextLevel, room.nextBlinds),
      offset: format.serverOffset(room.serverTime, Date.now()),
      potTotalText: potState.potTotalText,
      potRows: potState.potRows,
      awardRows: potState.awardRows,
      refundRows: potState.refundRows,
      events: (room.events || [])
        .slice(-EVENT_LIMIT)
        .reverse()
        .map(function (event) {
          return { seq: event.seq, handNo: event.handNo, text: event.text };
        }),
      myTurn: action.myTurn,
      canFold: action.canFold,
      canCheck: action.canCheck,
      canCall: action.canCall,
      canRaise: action.canRaise,
      canAllIn: action.canAllIn,
      callText: action.callText,
      callAmount: action.callAmount,
      raiseMin: action.raiseMin,
      raiseMax: action.raiseMax,
      raiseTarget: raiseTarget,
      raiseAddText: format.chips(Math.max(0, raiseTarget - action.myRoundBet)),
      quickTargets: action.quickTargets,
      waitingText: action.waitingText,
      myRoundBet: action.myRoundBet,
      myCommittedText: action.myCommittedText,
      finished: room.status === 'finished',
      winnerText: room.winner === null || room.winner === undefined ? '' : format.seatText(room.winner) + ' 获胜',
      serverNotice: room.notice || '',
      error: ''
    });
    this.setupFeedback();
    const cue = this.feedback.ingest(room.events || [], {initial: this.feedbackInitial});
    this.feedbackInitial = false;
    if (cue && cue.sfx) {
      if (this.motionTimer) clearTimeout(this.motionTimer);
      this.setData({motionClass: 'motion-' + cue.sfx});
      this.motionTimer = setTimeout(() => this.setData({motionClass: ''}), 650);
    }
    this.announceEvents(room.events);
    this.syncClock();
    this.updateFairness(room);
  },

  /**
   * 行动播报：把新到的服务端事件交给播报器，按语气档在牌桌中央闪一条。
   * 播报器与「是否已建立基线」记在实例上（与 dismissedHand 同一路数），
   * 所以每一帧 applyRoom 都不会把播过的事件重播一遍。
   */
  announceEvents(events) {
    const self = this;
    if (!this.announcer) {
      this.announcer = announceUtil.createAnnouncer({
        display: {
          show: function (text, tone, durationMs) {
            self.setData({
              announce: { text: text, tone: tone, toneClass: 'announce--' + tone, durationMs: durationMs }
            });
          },
          hide: function () {
            self.setData({ announce: null });
          }
        }
      });
    }
    this.announcer.ingest(events || [], { initial: !this.announced });
    this.announced = true;
  },

  updateFairness(room) {
    const self = this;
    if (!room.fairness) {
      if (this.data.fairnessTip) this.setData({ fairnessTip: '' });
      return;
    }
    this.setData({ fairnessTip: fairness.describe(room) });
    if (!fairness.needsContribution(room)) return;
    fairness.contribute(room).then(function (result) {
      if (!result) return;
      if (result.submitted) {
        self.setData({ fairnessTip: result.notice || '已提交本手随机贡献' });
        return;
      }
      if (result.reason === 'NOT_NEEDED' || result.reason === 'IN_FLIGHT') return;
      if (result.reason === 'RANDOM_UNAVAILABLE') {
        // 随机源不可用时按契约不提交，并明确告知本手使用公开默认贡献。
        self.setData({ fairnessTip: config.notice.randomUnavailable });
        return;
      }
      if (result.reason === 'ALREADY_CONTRIBUTED') {
        // 服务端已经收下本手的贡献，记下来不再重试，界面照实说明。
        fairness.markSubmitted(room);
        self.setData({ fairnessTip: result.notice || '本手随机贡献已提交' });
        return;
      }
      if (result.reason === 'FORBIDDEN') {
        // 本手不在牌局中（例如这一手正好被淘汰）：视图已经说明情况，不必再报一次错。
        // 下一次状态推送里 owed 会变成 false，也就不会再走到这里。
        return;
      }
      // 其余失败（窗口已关、不是本手参赛者等）必须把服务端的中文原因显示出来，
      // 否则界面会一直停在「正在收集本手随机贡献」，玩家不知道发生了什么。
      self.setData({ fairnessTip: result.notice || '随机贡献提交失败' });
    });
  },

  fail(err) {
    if (err && err.code === 'VERSION_CONFLICT') {
      // 契约：动作不自动重试，只刷新状态后由玩家重新选择。
      this.setData({ busy: false, notice: '房间状态已更新，请重新选择操作' });
      this.refresh();
      return;
    }
    if (err && err.code === 'UNAUTHORIZED') {
      auth.clear();
      this.setData({ busy: false, error: '登录已失效，请返回大厅重新进入' });
      return;
    }
    this.setData({ busy: false, error: format.errorText(err) });
  },

  /** 统一的命令发送：行动与结算确认共用同一套失败处理与状态应用。 */
  sendCommand(payload) {
    const self = this;
    const room = this.data.room;
    if (!room || this.data.busy) return;
    this.setData({ busy: true, error: '' });
    api.command(room.id, payload).then(
      function (next) {
        self.setData({ busy: false });
        self.applyRoom(next);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  sendAction(action) {
    const room = this.data.room;
    if (!room || !room.hand) return;
    this.sendCommand({ type: 'action', action: action, expectedVersion: room.version });
  },

  /**
   * 结算确认。服务端按 handNo 校验并豁免版本检查：两个真人几乎同时点确认时，
   * 后到者不会吃 409，旧手号的确认也串不到下一手的结算窗口。
   */
  onSettleAck() {
    const dialog = this.data.dialog;
    if (!dialog || this.data.busy) return;
    this.sendCommand({ type: 'settleAck', handNo: dialog.handNo });
  },

  /** 被淘汰 / 观战时可以关掉弹窗，记下手号免得下一帧又被重新弹出来。 */
  onDismissDialog() {
    const dialog = this.data.dialog;
    if (!dialog) return;
    this.dismissedHand = dialog.handNo;
    this.setData({ dialog: null, dialogTimerText: '' });
  },

  onFold() {
    this.sendAction({ type: 'fold' });
  },

  onCheck() {
    this.sendAction({ type: 'check' });
  },

  onCall() {
    this.sendAction({ type: 'call' });
  },

  onAllIn() {
    this.sendAction({ type: 'allIn' });
  },

  onRaise() {
    if (!this.data.canRaise) return;
    const target = Number(this.data.raiseTarget);
    if (!Number.isInteger(target) || target < this.data.raiseMin || target > this.data.raiseMax) {
      this.setData({ error: '加注金额需在 ' + this.data.raiseMin + ' 到 ' + this.data.raiseMax + ' 之间' });
      return;
    }
    this.sendAction({ type: 'raiseTo', amount: target });
  },

  onQuick(event) {
    this.setRaiseTarget(Number(event.currentTarget.dataset.target));
  },

  onStep(event) {
    const blinds = this.data.room && this.data.room.blinds ? this.data.room.blinds[1] : 0;
    if (!blinds) return;
    // 步进以一个大盲为单位，最终仍由 setRaiseTarget 夹在合法区间内。
    const step = Number(event.currentTarget.dataset.step) * blinds;
    this.setRaiseTarget(this.data.raiseTarget + step);
  },

  onRaiseInput(event) {
    const value = parseInt(event.detail.value, 10);
    if (Number.isNaN(value)) return;
    this.setRaiseTarget(value);
  },

  setRaiseTarget(value) {
    if (!this.data.canRaise) return;
    const clamped = Math.max(this.data.raiseMin, Math.min(this.data.raiseMax, Math.round(value)));
    this.setData({
      raiseTarget: clamped,
      raiseAddText: format.chips(Math.max(0, clamped - this.data.myRoundBet))
    });
  },

  onAudit() {
    wx.navigateTo({ url: '/pages/audit/audit?roomId=' + this.data.roomId });
  },

  onBackRoom() {
    wx.navigateBack({ delta: 1 });
  },

  onRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  },

  onShareAppMessage() {
    const invite = this.data.room ? this.data.room.invite : '';
    // 无邀请令牌时只分享到大厅，避免生成打不开的邀请链接。
    return {
      title: '同桌 · 德州扑克 邀请',
      path: invite ? '/pages/room/room?invite=' + invite : '/pages/lobby/lobby'
    };
  }
});
