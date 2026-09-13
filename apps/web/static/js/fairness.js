// 随机贡献：每手由真人客户端提交 32 字节密码学随机数（64 位小写十六进制）。
// 严禁使用非密码学随机数兜底：取不到安全随机数就本手不提交，并告知玩家使用公开默认贡献。

import {bytesToHex, storage, storageSet} from './util.js';

export const NONCE_BYTES = 32;
export const NONCE_HEX_LENGTH = 64;
export const UNAVAILABLE_NOTICE = '随机数不可用，本手使用公开默认贡献';
export const COMMITMENT_PREFIX = 'poker_fair:';
export const NONCE_PATTERN = /^[0-9a-f]{64}$/;

export class FairnessUnavailableError extends Error {
  constructor(message = '当前环境缺少 crypto.getRandomValues') {
    super(message);
    this.name = 'FairnessUnavailableError';
    this.code = 'FAIRNESS_UNAVAILABLE';
  }
}

export function isNonce(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function hasSecureRandom(cryptoImpl) {
  const source = cryptoImpl ?? globalThis.crypto;
  return Boolean(source && typeof source.getRandomValues === 'function');
}

/** 生成贡献随机数；没有安全随机源时抛出，调用方必须降级为“不提交”。 */
export function randomNonce(cryptoImpl) {
  const source = cryptoImpl ?? globalThis.crypto;
  if (!source || typeof source.getRandomValues !== 'function') throw new FairnessUnavailableError();
  const bytes = new Uint8Array(NONCE_BYTES);
  source.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * 是否轮到自己贡献。判定完全交给服务端的 fairness.owed：它按「本人是否参加这一手」
 * 计算，已淘汰、观战、机器人席位都是 false，还没交过才是 true。
 * 早期版本在这里用 contributors 名单反推，淘汰玩家会在每一手都提交一次、
 * 再被服务端 403 拒绝一次，界面上每手都闪一条错误。
 */
export function needsContribution(room, viewerSeat) {
  if (!room || room.status !== 'playing') return false;
  const round = room.fairness;
  if (round === null || round === undefined) return false;
  if (round.deckCommitment !== null) return false;
  if (!Number.isInteger(viewerSeat)) return false;
  return round.owed === true;
}

/**
 * 本手提交的去重键。带比赛号：同一个房间再开一局时手号会从 1 重来，
 * 只按房间记会让第二局的第一手被当成「已经提交过」而漏交。
 */
export function contributionKey(room, handNo) {
  return `${room?.matchId ?? ''}:${handNo}`;
}

/**
 * 页面执行计划：contribute 走提交，unavailable 只提示不提交，none 不做任何事。
 * 只有需要贡献时才会去碰 crypto，避免无谓的随机数消耗。
 */
export function contributionPlan(room, viewerSeat, options = {}) {
  if (!needsContribution(room, viewerSeat)) return {kind: 'none'};
  const handNo = room.fairness.handNo;
  if (!hasSecureRandom(options.cryptoImpl)) return {kind: 'unavailable', notice: UNAVAILABLE_NOTICE, handNo};
  return {kind: 'contribute', seat: viewerSeat, handNo, nonce: randomNonce(options.cryptoImpl)};
}

/**
 * 承诺按 比赛+手号 留存，供赛后核验页对照。
 * 手号只在同一场比赛里唯一：同一个房间打完可以再开一局，手号从 1 重新数，
 * 只按房间记会让第二局的第一手覆盖掉第一局的记录。
 */
export function commitmentKey(matchId, handNo) {
  return `${COMMITMENT_PREFIX}${matchId}:${handNo}`;
}

export function commitmentRecord(room, now = Date.now()) {
  if (!room || !room.fairness || typeof room.fairness.commitment !== 'string') return null;
  // 没有比赛号就没有可靠的归属，宁可不留存也不要把不同场次混在一起。
  if (typeof room.matchId !== 'string' || room.matchId === '') return null;
  return {
    roomId: room.id,
    matchId: room.matchId,
    handNo: room.fairness.handNo,
    commitment: room.fairness.commitment,
    savedAt: now,
  };
}

export function saveCommitment(room, storageImpl, now = Date.now()) {
  const record = commitmentRecord(room, now);
  if (!record) return null;
  const key = commitmentKey(record.matchId, record.handNo);
  // 首次写入后不再覆盖：留存的用途就是「服务端当时公布过什么」，
  // 被后续状态推送改写后就失去了对照作用（小程序端同样如此）。
  const store = storage(storageImpl);
  if (store && store.getItem(key) !== null) return record;
  const ok = storageSet(key, JSON.stringify(record), storageImpl);
  return ok ? record : null;
}

export function findCommitment(matchId, handNo, storageImpl) {
  const store = storage(storageImpl);
  if (!store) return null;
  try {
    const raw = store.getItem(commitmentKey(matchId, handNo));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 本地留存与服务端的这一手是不是同一场比赛。
 * 两边都给出比赛号才认，缺一边就当作对不上：宁可显示「本机没有留存」，
 * 也不要把上一局的承诺拿来和这一局比，得出「被篡改」的错误结论。
 */
export function sameMatch(record, matchId) {
  return Boolean(
    record &&
      typeof record.matchId === 'string' &&
      record.matchId !== '' &&
      typeof matchId === 'string' &&
      matchId !== '' &&
      record.matchId === matchId,
  );
}

/** 列出本机留存的全部承诺；存储实现不支持枚举时返回空数组。 */
export function listCommitments(storageImpl) {
  const store = storage(storageImpl);
  if (!store || typeof store.key !== 'function' || typeof store.length !== 'number') return [];
  const out = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (typeof key !== 'string' || !key.startsWith(COMMITMENT_PREFIX)) continue;
    try {
      const parsed = JSON.parse(store.getItem(key));
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {
      // 坏记录直接跳过，不影响其余核验结果显示。
    }
  }
  return out.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
}

export function findStoredCommitment(list, matchId, handNo) {
  return (list ?? []).find((item) => sameMatch(item, matchId) && item.handNo === handNo) ?? null;
}
