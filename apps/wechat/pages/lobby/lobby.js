/**
 * 大厅：昵称、创建房间（0-8 机器人）、房间码加入、邀请进入、机器人练习、规则入口。
 */
const api = require('../../utils/api.js');
const auth = require('../../utils/auth.js');
const format = require('../../utils/format.js');

Page({
  data: {
    nickname: '',
    bots: 3,
    botOptions: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    botIndex: 3,
    code: '',
    invite: '',
    userName: '',
    modeText: '',
    notice: '',
    busy: false,
    error: ''
  },

  onLoad(query) {
    this.setData({
      invite: (query && query.invite) || '',
      code: (query && query.code) || ''
    });
    this.restore();
  },

  restore() {
    const self = this;
    return auth.ensureLogin().then(
      function (session) {
        self.applySession(session);
      },
      function (err) {
        self.setData({ error: format.errorText(err) });
      }
    );
  },

  applySession(session) {
    const user = (session && session.user) || {};
    this.setData({
      userName: user.name || '',
      modeText: session && session.mode === 'production' ? '微信登录' : '开发模式（游客）',
      notice: (session && session.notice) || '',
      nickname: this.data.nickname || user.name || '',
      error: ''
    });
  },

  onNickInput(event) {
    this.setData({ nickname: event.detail.value });
  },

  onCodeInput(event) {
    this.setData({ code: event.detail.value });
  },

  onBotsChange(event) {
    const index = Number(event.detail.value);
    this.setData({ botIndex: index, bots: this.data.botOptions[index] });
  },

  onCreate() {
    const self = this;
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    api.createRoom(this.data.nickname.trim(), this.data.bots).then(
      function (room) {
        self.setData({ busy: false });
        self.gotoRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  onPractice() {
    const self = this;
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    // 机器人练习 = 一名真人对多个机器人。
    api.createRoom('机器人练习', Math.max(1, this.data.bots)).then(
      function (room) {
        self.setData({ busy: false });
        self.gotoRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  onJoin() {
    const code = this.data.code.trim();
    if (!code) {
      this.setData({ error: '请输入房间码' });
      return;
    }
    this.join({ code: code });
  },

  onJoinInvite() {
    if (!this.data.invite) return;
    this.join({ invite: this.data.invite });
  },

  join(payload) {
    const self = this;
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    api.joinRoom(payload).then(
      function (room) {
        self.setData({ busy: false });
        self.gotoRoom(room);
      },
      function (err) {
        self.fail(err);
      }
    );
  },

  gotoRoom(room) {
    wx.navigateTo({ url: '/pages/room/room?roomId=' + room.id });
  },

  fail(err) {
    if (err && err.code === 'UNAUTHORIZED') {
      auth.clear();
      this.setData({ busy: false, error: '登录已失效，正在重新登录' });
      this.restore();
      return;
    }
    this.setData({ busy: false, error: format.errorText(err) });
  },

  onRelogin() {
    const self = this;
    const name = this.data.nickname.trim();
    wx.showModal({
      title: '重新登录',
      content: '换昵称会创建新的玩家身份，当前房间内的身份不会保留。是否继续？',
      success(result) {
        if (!result.confirm) return;
        auth.clear();
        self.setData({ busy: true, error: '' });
        auth.login({ name: name }).then(
          function (session) {
            self.setData({ busy: false });
            self.applySession(session);
          },
          function (err) {
            self.setData({ busy: false, error: format.errorText(err) });
          }
        );
      }
    });
  },

  onRules() {
    wx.navigateTo({ url: '/pages/rules/rules' });
  }
});
