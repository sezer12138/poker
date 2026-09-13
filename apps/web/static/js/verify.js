// 浏览器端核验：用 WebCrypto 复算 packages/fairness 的种子承诺与牌序承诺。
// 复算规则必须与 packages/fairness/src 完全一致：HMAC-SHA256 计数器字节流 + 拒绝采样 Fisher–Yates。
// 模块顶层不访问 window/navigator；crypto 由参数注入（默认 globalThis.crypto）。

import {bytesToHex} from './util.js';
import {NONCE_PATTERN, findStoredCommitment} from './fairness.js';

export const VERSION = 'hmac-sha256-fy-v1';
export const ZERO_NONCE = '0'.repeat(64);
export const DECK_SIZE = 52;

export class VerifyUnavailableError extends Error {
  constructor(message = '当前浏览器不支持 WebCrypto，无法完成核验') {
    super(message);
    this.name = 'VerifyUnavailableError';
    this.code = 'VERIFY_UNAVAILABLE';
  }
}

export function cryptoSource(cryptoImpl) {
  const source = cryptoImpl ?? globalThis.crypto;
  if (!source || !source.subtle) throw new VerifyUnavailableError();
  return source;
}

let encoder = null;

export function utf8Bytes(text) {
  if (!encoder) encoder = new TextEncoder();
  return encoder.encode(text);
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new RangeError('十六进制字符串非法');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function isHex64(value) {
  return typeof value === 'string' && NONCE_PATTERN.test(value);
}

export function fullDeck() {
  return Array.from({length: DECK_SIZE}, (_, card) => card);
}

export async function sha256Hex(text, cryptoImpl) {
  const source = cryptoSource(cryptoImpl);
  const digest = await source.subtle.digest('SHA-256', utf8Bytes(text));
  return bytesToHex(new Uint8Array(digest));
}

/** HMAC-SHA256 计数器字节流：context || counter(4 字节大端)，逐字节消费。 */
export async function createByteStream(serverSeedHex, context, cryptoImpl) {
  const source = cryptoSource(cryptoImpl);
  const key = await source.subtle.importKey('raw', hexToBytes(serverSeedHex), {name: 'HMAC', hash: 'SHA-256'}, false, [
    'sign',
  ]);
  const contextBytes = utf8Bytes(context);
  let block = new Uint8Array(0);
  let offset = 0;
  let counter = 0;
  return {
    async next() {
      if (offset >= block.length) {
        const message = new Uint8Array(contextBytes.length + 4);
        message.set(contextBytes, 0);
        new DataView(message.buffer).setUint32(contextBytes.length, counter, false);
        counter += 1;
        block = new Uint8Array(await source.subtle.sign('HMAC', key, message));
        offset = 0;
      }
      const byte = block[offset];
      offset += 1;
      return byte;
    },
  };
}

/** 拒绝采样：丢弃超出 range 最大整数倍的高位字节，保证每个取值等概率。 */
export async function uniform(stream, range) {
  const limit = Math.floor(256 / range) * range;
  for (;;) {
    const byte = await stream.next();
    if (byte < limit) return byte % range;
  }
}

export async function shuffleWith(stream, items) {
  const out = [...items];
  for (let index = 0; index < out.length - 1; index += 1) {
    const swap = index + (await uniform(stream, out.length - index));
    const value = out[index];
    out[index] = out[swap];
    out[swap] = value;
  }
  return out;
}

export function seedCommitment(matchId, handNo, serverSeed, cryptoImpl) {
  return sha256Hex(JSON.stringify([VERSION, matchId, handNo, serverSeed]), cryptoImpl);
}

/** 流上下文按座位升序绑定全部贡献；缺失座位使用公开全零贡献。 */
export function streamContext(round) {
  const seats = [...(round.seats ?? [])].sort((a, b) => a - b);
  const entries = seats.map((seat) => [seat, round.contributions?.[String(seat)] ?? ZERO_NONCE]);
  return JSON.stringify([VERSION, round.matchId, round.handNo, entries]);
}

export async function reconstructDeck(round, cryptoImpl) {
  if (!round || !isHex64(round.serverSeed)) throw new VerifyUnavailableError('服务器种子格式非法，无法复算牌序');
  const stream = await createByteStream(round.serverSeed, streamContext(round), cryptoImpl);
  return shuffleWith(stream, fullDeck());
}

export function deckCommitment(deck, cryptoImpl) {
  return sha256Hex(JSON.stringify(deck), cryptoImpl);
}

/**
 * 单手核验结果：
 * seed   — 服务器种子是否与承诺绑定；
 * deck   — 用公开记录能否复算出同样的牌序承诺；
 * stored — 与比赛进行中广播并留在本机的承诺是否一致（没有留存则为 unknown）。
 * 只做“记录自洽 + 与本地留存一致”的复算，不声称证明了实际发牌过程。
 */
export async function verifyRound(round, options = {}) {
  const cryptoImpl = options.cryptoImpl;
  const stored = options.storedCommitment ?? null;
  const errors = [];
  const checks = [];
  let expectedDeck = null;

  let seedOk = false;
  if (!isHex64(round?.serverSeed)) {
    errors.push('服务器种子格式非法');
  } else {
    const expected = await seedCommitment(round.matchId, round.handNo, round.serverSeed, cryptoImpl);
    seedOk = expected === round.commitment;
    if (!seedOk) errors.push('种子承诺与服务器种子不符');
  }
  checks.push({name: '种子承诺', ok: seedOk, detail: seedOk ? '与记录一致' : '与记录不符'});

  let deckOk = false;
  if (round?.deckCommitment === null || round?.deckCommitment === undefined) {
    errors.push('本手未记录牌序承诺');
  } else {
    try {
      expectedDeck = await reconstructDeck(round, cryptoImpl);
      if (new Set(expectedDeck).size !== DECK_SIZE) errors.push('复算牌序不是 52 张唯一牌');
      const digest = await deckCommitment(expectedDeck, cryptoImpl);
      deckOk = digest === round.deckCommitment;
      if (!deckOk) errors.push('牌序承诺与复算牌序不符');
    } catch (error) {
      errors.push(`复算牌序失败：${error?.message ?? error}`);
    }
  }
  checks.push({name: '牌序承诺', ok: deckOk, detail: deckOk ? 'WebCrypto 复算一致' : '复算不一致'});

  let storedOk = null;
  if (stored && typeof stored.commitment === 'string') {
    storedOk = stored.commitment === round?.commitment;
    if (!storedOk) errors.push('与比赛进行中留存的承诺不一致');
  }
  checks.push({
    name: '本地留存承诺',
    ok: storedOk,
    detail: stored ? (storedOk ? '与本机留存一致' : '与本机留存不一致') : '本机未留存该手承诺',
  });

  return {
    handNo: round?.handNo ?? null,
    matchId: round?.matchId ?? null,
    commitment: round?.commitment ?? null,
    deckCommitment: round?.deckCommitment ?? null,
    serverSeed: round?.serverSeed ?? null,
    deck: expectedDeck,
    seatCount: (round?.seats ?? []).length,
    contributorCount: Object.keys(round?.contributions ?? {}).length,
    checks,
    errors,
    valid: errors.length === 0,
  };
}

/**
 * 逐手核验；storedCommitments 传入本机留存的承诺列表。
 * 对照按比赛号 + 手号：同一个房间可以有第二局，手号会重来，
 * 只按房间（或只按手号）对照会把另一局的承诺算到这一局头上。
 */
export async function verifyRounds(rounds, options = {}) {
  const stored = options.storedCommitments ?? [];
  const rows = [];
  for (const round of rounds ?? []) {
    const record = findStoredCommitment(stored, round.matchId, round.handNo);
    rows.push(await verifyRound(round, {cryptoImpl: options.cryptoImpl, storedCommitment: record}));
  }
  return rows;
}
