/**
 * 随机贡献：32 字节来自 wx.getRandomValues，编码为 64 位小写十六进制。
 * 禁止用 Math.random 顶替；随机源不可用时不得提交，界面必须说明本手使用公开默认贡献。
 * 每手承诺留存到本地存储（matchId:handNo），供赛后核验对照。
 */
const api = require('./api.js');
const config = require('../config.js');

const NONCE_BYTES = 32;
const submitted = {};
const inflight = {};

/**
 * 留存与去重都按「比赛 + 手号」：
 * 同一个房间打完可以再开一局，手号会从 1 重新数。只按房间记会让第二局的第 1 手
 * 命中第一局的记录——既不提交贡献，赛后对照还会得出「被篡改」的错误结论。
 */
function storageKey(matchId, handNo) {
  return String(matchId) + ':' + String(handNo);
}

/** 视图里的比赛号；没有它就无法把手号归属到某一场比赛。 */
function matchOf(room) {
  return room && typeof room.matchId === 'string' && room.matchId !== '' ? room.matchId : null;
}

function readCommitments() {
  try {
    const value = wx.getStorageSync(config.storage.commitments);
    return value && typeof value === 'object' ? value : {};
  } catch (e) {
    return {};
  }
}

function writeCommitments(map) {
  try {
    wx.setStorageSync(config.storage.commitments, map);
  } catch (e) {
    // 留存失败只影响赛后本地对照，不影响本手进行。
  }
}

/** 首次写入后不覆盖：本地留存用于发现事后改动。 */
function rememberCommitment(matchId, handNo, commitment) {
  if (!commitment || !matchId) return;
  const all = readCommitments();
  const key = storageKey(matchId, handNo);
  if (all[key]) return;
  all[key] = commitment;
  writeCommitments(all);
}

function getCommitment(matchId, handNo) {
  const all = readCommitments();
  return all[storageKey(matchId, handNo)] || null;
}

function listCommitments(matchId) {
  const all = readCommitments();
  const prefix = String(matchId) + ':';
  const result = [];
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(prefix) !== 0) return;
    const handNo = Number(key.slice(prefix.length));
    if (!isFinite(handNo)) return;
    result.push({ handNo: handNo, commitment: all[key] });
  });
  return result.sort(function (a, b) {
    return a.handNo - b.handNo;
  });
}

/** 每次收到状态都调用：只记录服务端已公布的承诺。 */
function rememberFromRoom(room) {
  if (!room || !room.fairness || !room.fairness.commitment) return;
  const matchId = matchOf(room);
  if (!matchId) return;
  rememberCommitment(matchId, room.fairness.handNo, room.fairness.commitment);
}

function randomAvailable() {
  return typeof wx !== 'undefined' && wx !== null && typeof wx.getRandomValues === 'function';
}

function toBytes(value) {
  if (!value) return null;
  if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return value;
  if (typeof value.byteLength === 'number' && typeof value.length === 'number') {
    return Array.prototype.slice.call(value);
  }
  return null;
}

function bytesToHex(value) {
  const bytes = toBytes(value);
  if (!bytes || bytes.length !== NONCE_BYTES) return null;
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] & 0xff;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/** 解析为 64 位小写十六进制；随机源不可用或长度不符时返回 null。 */
function nonceHex() {
  return new Promise(function (resolve) {
    if (!randomAvailable()) {
      resolve(null);
      return;
    }
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    try {
      wx.getRandomValues({
        length: NONCE_BYTES,
        success: function (res) {
          done(bytesToHex(res && res.randomValues));
        },
        fail: function () {
          done(null);
        }
      });
    } catch (e) {
      done(null);
    }
  });
}

/**
 * 契约条件：比赛中、未定牌序、服务端说本人这一手还欠一次贡献（fairness.owed）。
 * owed 由服务端按「本人是否参加这一手」算好：已淘汰、观战、机器人席位都是 false，
 * 因此被淘汰的玩家不会每手白提交一次再被 403 一次（那正是之前的做法）。
 */
function needsContribution(room) {
  if (!room || room.status !== 'playing') return false;
  if (typeof room.viewerSeat !== 'number') return false;
  const round = room.fairness;
  if (!round || typeof round.handNo !== 'number') return false;
  if (round.deckCommitment !== null) return false;
  if (round.owed !== true) return false;
  const matchId = matchOf(room);
  if (!matchId) return false;
  return submitted[storageKey(matchId, round.handNo)] !== true;
}

function contribute(room) {
  if (!needsContribution(room)) {
    return Promise.resolve({ submitted: false, reason: 'NOT_NEEDED', notice: '' });
  }
  const roomId = room.id;
  const handNo = room.fairness.handNo;
  const commitment = room.fairness.commitment;
  const matchId = matchOf(room);
  const key = storageKey(matchId, handNo);
  // 同一手同时只允许一个在途提交，避免连续状态推送重复提交。
  if (inflight[key]) {
    return Promise.resolve({ submitted: false, reason: 'IN_FLIGHT', notice: '' });
  }
  inflight[key] = true;
  return nonceHex().then(function (nonce) {
    if (!nonce) {
      inflight[key] = false;
      return { submitted: false, reason: 'RANDOM_UNAVAILABLE', notice: config.notice.randomUnavailable };
    }
    return api
      .command(roomId, {
        type: 'contribute',
        expectedVersion: room.version,
        seat: room.viewerSeat,
        nonce: nonce,
        handNo: handNo
      })
      .then(
        function () {
          inflight[key] = false;
          // 内存去重避免重复推送重复提交；重启后重复提交由服务端按每席一次拒绝。
          submitted[key] = true;
          rememberCommitment(matchId, handNo, commitment);
          return { submitted: true, reason: '', nonce: nonce, notice: '已提交本手随机贡献' };
        },
        function (err) {
          inflight[key] = false;
          return {
            submitted: false,
            reason: (err && err.code) || 'FAILED',
            notice: (err && err.message) || '随机贡献提交失败'
          };
        }
      );
  });
}

/** 服务端已收下本手的贡献（重复提交才会被告知），本地记下来不再重试。 */
function markSubmitted(room) {
  const matchId = matchOf(room);
  if (!matchId || !room.fairness) return;
  submitted[storageKey(matchId, room.fairness.handNo)] = true;
}

function describe(room) {
  if (!room || !room.fairness) return '';
  const round = room.fairness;
  if (round.deckCommitment !== null) return '本手随机贡献已齐全，等待发牌';
  const matchId = matchOf(room);
  return matchId && submitted[storageKey(matchId, round.handNo)] === true
    ? '本手随机贡献已提交，等待其他玩家'
    : '正在收集本手随机贡献';
}

module.exports = {
  NONCE_BYTES: NONCE_BYTES,
  nonceHex: nonceHex,
  randomAvailable: randomAvailable,
  needsContribution: needsContribution,
  contribute: contribute,
  markSubmitted: markSubmitted,
  describe: describe,
  rememberCommitment: rememberCommitment,
  rememberFromRoom: rememberFromRoom,
  getCommitment: getCommitment,
  listCommitments: listCommitments
};
