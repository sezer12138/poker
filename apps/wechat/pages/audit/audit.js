/**
 * 赛后核验：调用 /api/rooms/:id/audit，展示每手承诺、贡献、牌序承诺，
 * 并与本地留存的承诺对照（本地留存只能发现事后改动，不构成第三方认证）。
 */
const api = require('../../utils/api.js');
const auth = require('../../utils/auth.js');
const fairness = require('../../utils/fairness.js');
const format = require('../../utils/format.js');

Page({
  data: {
    roomId: '',
    loading: true,
    locked: false,
    error: '',
    matchId: '',
    valid: false,
    verifyErrors: [],
    rounds: [],
    events: [],
    localCount: 0,
    mismatchCount: 0,
    lockedText: '比赛结束后可核验'
  },

  onLoad(query) {
    const roomId = (query && query.roomId) || '';
    this.setData({ roomId: roomId });
    this.load();
  },

  load() {
    const self = this;
    if (!this.data.roomId) {
      this.setData({ loading: false, error: '缺少房间号' });
      return;
    }
    auth.ensureLogin().then(
      function () {
        return api.audit(self.data.roomId);
      },
      function (err) {
        self.setData({ loading: false, error: format.errorText(err) });
        return null;
      }
    ).then(function (data) {
      if (!data) return;
      self.apply(data);
    }, function (err) {
      if (err && err.code === 'AUDIT_LOCKED') {
        self.setData({ loading: false, locked: true, error: '' });
        return;
      }
      if (err && err.code === 'UNAUTHORIZED') {
        auth.clear();
        self.setData({ loading: false, error: '登录已失效，请返回大厅重新进入' });
        return;
      }
      self.setData({ loading: false, error: format.errorText(err) });
    });
  },

  apply(data) {
    const local = {};
    // 按比赛号取本地留存：同一个房间的上一局手号会重来，只按房间取会把上一局算进来。
    fairness.listCommitments(data.matchId).forEach(function (item) {
      local[item.handNo] = item.commitment;
    });
    let localCount = 0;
    let mismatchCount = 0;
    const rounds = (data.rounds || []).map(function (round) {
      const stored = local[round.handNo] || '';
      let matchText = '本地无留存';
      let matchClass = 'muted';
      if (stored) {
        localCount += 1;
        if (stored === round.commitment) {
          matchText = '与本地留存一致';
          matchClass = 'brass';
        } else {
          matchText = '与本地留存不一致';
          matchClass = 'danger';
          mismatchCount += 1;
        }
      }
      const contributions = Object.keys(round.contributions || {}).map(function (seat) {
        return { seatText: format.seatText(Number(seat)), nonce: round.contributions[seat] };
      });
      return {
        handNo: round.handNo,
        version: round.version,
        commitment: round.commitment,
        serverSeed: round.serverSeed,
        deckCommitment: round.deckCommitment || '未生成',
        seatsText: (round.seats || []).map(format.seatText).join('、'),
        contributions: contributions,
        matchText: matchText,
        matchClass: matchClass
      };
    });
    const verification = data.verification || { valid: false, errors: [] };
    this.setData({
      loading: false,
      locked: false,
      error: '',
      matchId: data.matchId || '',
      valid: verification.valid === true,
      verifyErrors: verification.errors || [],
      rounds: rounds,
      events: (data.events || []).map(function (event) {
        return { seq: event.seq, handNo: event.handNo, text: event.text };
      }),
      localCount: localCount,
      mismatchCount: mismatchCount
    });
  }
});
