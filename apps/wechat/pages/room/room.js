/**
 * 等待房间：成员/座位/机器人标注、准备（含核验披露确认）、房主增删机器人、开始、邀请分享。
 * WS 在 onShow 重连+重新订阅、onHide 关闭；GET 房间始终作为回退。
 */
const api = require('../../utils/api.js');
const auth = require('../../utils/auth.js');
const wsUtil = require('../../utils/ws.js');
const format = require('../../utils/format.js');
const config = require('../../config.js');

const STATUS_LABEL = {
  connecting: '连接中',
  open: '已连接',
  closed: '连接已断开',
  error: '连接异常',
  reconnecting: '重连中',
  failed: '连接失败，可用刷新重试'
};

Page({
  data: {
    roomId: '',
    invite: '',
    room: null,
    members: [],
    isHost: false,
    mySeat: null,
    myReady: false,
    canStart: false,
    canRestart: false,
    statusText: '',
    blindText: '',
    levelText: '',
    completedText: '',
    linkText: '未连接',
    notice: '',
    serverNotice: '',
    error: '',
    busy: false,
    finished: false,
    winnerText: '',
    auditNotice: config.notice.auditAccepted
  },

  onLoad(query) {
    this.setData({
      roomId: (query && query.roomId) || '',
      invite: (query && query.invite) || ''
    });
  },

  onShow() {
    this.attach();
  },

  onHide() {
    this.detach();
  },

  onUnload() {
    this.detach();
  },

  attach() {
    const self = this;
    if (this.attached) return;
    this.attached = true;
    auth.ensureLogin().then(
      function () {
        self.bootstrap();
      },
      function (err) {
        self.setData({ error: format.errorText(err) });
      }
    );
  },

  detach() {
    this.attached = false;
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  },

  bootstrap() {
    const self = this;
    if (this.data.roomId) {
      this.openSocket();
      this.refresh();
      return;
    }
    if (!this.data.invite) {
      this.setData({ error: '缺少房间号或邀请令牌' });
      return;
    }
    api.joinRoom({ invite: this.data.invite }).then(
      function (room) {
        self.setData({ roomId: room.id });
        self.openSocket();
        self.applyRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  openSocket() {
    const self = this;
    if (this.client || !this.data.roomId) return;
    this.client = wsUtil.createClient({
      roomId: this.data.roomId,
      onState(room) {
        self.applyRoom(room);
      },
      onError(error) {
        self.setData({ notice: '连接提醒：' + ((error && error.message) || '未知错误') });
      },
      onStatus(status) {
        self.setData({ linkText: STATUS_LABEL[status] || status });
      },
      onClosed(decision) {
        // 顶号/被移出房间：服务端不会再放行，直接显示中文原因，不再重连。
        self.setData({ busy: false, error: decision.message, linkText: '连接已停止' });
      }
    });
    this.client.connect();
  },

  refresh() {
    const self = this;
    if (!this.data.roomId) return;
    api.getRoom(this.data.roomId).then(
      function (room) {
        self.applyRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  applyRoom(room) {
    const isViewerHost = room.viewerId === room.hostId;
    const removable = isViewerHost && room.status === 'waiting';
    const members = (room.members || [])
      .slice()
      .sort(function (a, b) {
        return a.seat - b.seat;
      })
      .map(function (member) {
        const self = member.userId === room.viewerId;
        return {
          userId: member.userId,
          seat: member.seat,
          seatText: format.seatText(member.seat),
          name: member.name,
          bot: member.bot,
          botText: member.bot ? '机器人' : '',
          ready: member.ready,
          readyText: format.readyText(member.ready),
          self: self,
          // 房主可移除机器人，也可移除未开赛真人（不能移除自己）。
          canRemove: removable && !self,
          host: member.userId === room.hostId,
          // 等待阶段没有真实筹码，显示引擎的起手筹码（开赛后牌桌读 hand.players）。
          stackText: format.chips(format.STARTING_STACK)
        };
      });
    const mine = room.members.filter(function (member) {
      return member.userId === room.viewerId;
    })[0];
    const humans = room.members.filter(function (member) {
      return !member.bot;
    });
    const allReady = humans.length > 0 && humans.every(function (member) {
      return member.ready;
    });
    const isHost = isViewerHost;
    const enoughPlayers = room.members.length >= 2;
    this.setData({
      room: room,
      members: members,
      isHost: isHost,
      mySeat: room.viewerSeat,
      myReady: !!(mine && mine.ready),
      canStart: room.status === 'waiting' && isHost && enoughPlayers && allReady,
      // 契约：结束后重新准备再开赛，重新开始需再次确认全体真人准备。
      canRestart: room.status === 'finished' && isHost && enoughPlayers && allReady,
      statusText: format.statusText(room.status),
      blindText: format.blindLabel(room.blinds),
      levelText: format.handsToNextLevelText(room.handsToNextLevel, room.nextBlinds),
      completedText: typeof room.completedHands === 'number' ? '已完成 ' + room.completedHands + ' 手' : '',
      finished: room.status === 'finished',
      winnerText: room.winner === null || room.winner === undefined ? '' : format.seatText(room.winner) + ' 获胜',
      serverNotice: room.notice || '',
      error: ''
    });
    if (room.status === 'playing' && !this.redirected) {
      // 每页实例只自动进入牌桌一次，返回房间后由按钮再次进入。
      this.redirected = true;
      wx.navigateTo({ url: '/pages/table/table?roomId=' + room.id });
    }
  },

  send(type, extra) {
    const self = this;
    const room = this.data.room;
    if (!room || this.data.busy) return Promise.resolve(null);
    this.setData({ busy: true, error: '' });
    const payload = Object.assign({ type: type, expectedVersion: room.version }, extra || {});
    return api.command(room.id, payload).then(
      function (next) {
        self.setData({ busy: false });
        self.applyRoom(next);
        return next;
      },
      function (err) {
        self.fail(err);
        return null;
      }
    );
  },

  fail(err) {
    if (err && err.code === 'VERSION_CONFLICT') {
      // 契约：版本冲突不自动重试，只重新拉取最新状态。
      this.setData({ busy: false, notice: '房间状态已更新，请按最新状态操作' });
      this.refresh();
      return;
    }
    if (err && err.code === 'UNAUTHORIZED') {
      auth.clear();
      this.setData({ busy: false, error: '登录已失效，请返回大厅重新进入' });
      return;
    }
    if (err && err.code === 'ROOM_LOCKED') {
      this.setData({ busy: false, error: err.message || '房间已锁定' });
      return;
    }
    this.setData({ busy: false, error: format.errorText(err) });
  },

  onReady() {
    this.send('ready', { ready: !this.data.myReady });
  },

  onStart() {
    this.send('start', {});
  },

  onRestart() {
    this.send('restart', {});
  },

  onAddBot() {
    this.send('addBot', {});
  },

  onRemoveBot(event) {
    // 房主可移除机器人，也可移除未开赛真人（不能移除自己）。
    const seat = Number(event.currentTarget.dataset.seat);
    if (this.data.mySeat === seat) {
      this.setData({ error: '不能移除自己' });
      return;
    }
    this.send('removeBot', { seat: seat });
  },

  onLeave() {
    this.send('leave', {}).then(function () {
      wx.navigateBack({ delta: 1 });
    });
  },

  onCopyCode() {
    if (!this.data.room) return;
    wx.setClipboardData({ data: String(this.data.room.code) });
  },

  onCopyInvite() {
    if (!this.data.room) return;
    wx.setClipboardData({ data: String(this.data.room.invite) });
  },

  onTable() {
    if (!this.data.room) return;
    wx.navigateTo({ url: '/pages/table/table?roomId=' + this.data.room.id });
  },

  onAudit() {
    wx.navigateTo({ url: '/pages/audit/audit?roomId=' + this.data.roomId });
  },

  onRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  },

  onShareAppMessage() {
    return {
      title: '同桌 · 德州扑克 邀请',
      path: '/pages/room/room?invite=' + (this.data.room ? this.data.room.invite : this.data.invite)
    };
  }
});
