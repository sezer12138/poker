import test from 'node:test';
import assert from 'node:assert/strict';
import {createRound, contribute, finalizeRound, verifyRound as verifyRoundNode} from '../../../packages/fairness/src/index.ts';
import {commitmentKey, findCommitment} from '../static/js/fairness.js';
import {
  ZERO_NONCE,
  deckCommitment,
  hexToBytes,
  isHex64,
  reconstructDeck,
  seedCommitment,
  sha256Hex,
  shuffleWith,
  streamContext,
  uniform,
  verifyRounds,
  verifyRound,
} from '../static/js/verify.js';
import {createByteStream} from '../static/js/verify.js';

// 固定测试向量：由 packages/fairness 产出，两侧任何一方改动都必须让这里失败。
const FIXED = {
  version: 'hmac-sha256-fy-v1',
  matchId: 'match-fixed-1',
  handNo: 3,
  serverSeed: 'a1'.repeat(32),
  commitment: '04a96074467c6d54e96b376ebdee11252ddfa0269043d701f20c8ec978c1f75e',
  deckCommitment: '01972894e3fbf48716ef5035c561866aa02db456004770cb87eb2ef50eb3cbaf',
  seats: [0, 2, 5],
  contributions: {'0': '0a'.repeat(32), '2': 'b7'.repeat(32)},
  deckHead: [47, 23, 3, 51, 27, 22, 17, 48, 28, 18],
};

function fixedRound() {
  return {
    version: FIXED.version,
    matchId: FIXED.matchId,
    handNo: FIXED.handNo,
    serverSeed: FIXED.serverSeed,
    commitment: FIXED.commitment,
    contributions: {...FIXED.contributions},
    seats: [...FIXED.seats],
    deckCommitment: FIXED.deckCommitment,
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
  };
}

test('WebCrypto 复算与固定测试向量一致', async () => {
  const round = fixedRound();
  assert.equal(await seedCommitment(round.matchId, round.handNo, round.serverSeed), FIXED.commitment);
  const deck = await reconstructDeck(round);
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  assert.deepEqual(deck.slice(0, 10), FIXED.deckHead);
  assert.equal(await deckCommitment(deck), FIXED.deckCommitment);

  const result = await verifyRound(round, {storedCommitment: {commitment: FIXED.commitment}});
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.checks.map((check: {name: string; ok: boolean | null}) => [check.name, check.ok]),
    [
      ['种子承诺', true],
      ['牌序承诺', true],
      ['本地留存承诺', true],
    ],
  );
  assert.equal(result.contributorCount, 2);
  assert.equal(result.seatCount, 3);
});

test('缺失的贡献按公开全零补齐，与 fairness 模块的 finalize 结果一致', async () => {
  const round = fixedRound();
  const context = streamContext(round);
  assert.match(context, new RegExp(ZERO_NONCE));
  const source = await createByteStream(round.serverSeed, context);
  assert.equal(typeof (await source.next()), 'number');
  assert.equal(hexToBytes('00ff').join(','), '0,255');
  assert.equal(isHex64(ZERO_NONCE), true);
  assert.equal(isHex64('A'.repeat(64)), false);
});

test('浏览器实现与 packages/fairness 对同一手牌复算出相同牌序', async () => {
  const round = createRound('match-live-9', 11);
  const withContribution = contribute(contribute(round, 0, '11'.repeat(32)), 2, 'fe'.repeat(32));
  const {round: finalized, deck} = finalizeRound(withContribution, [0, 2, 4]);

  const browserDeck = await reconstructDeck(finalized);
  assert.deepEqual(browserDeck, deck);
  assert.equal(await deckCommitment(browserDeck), finalized.deckCommitment);
  assert.equal(await seedCommitment(finalized.matchId, finalized.handNo, finalized.serverSeed), finalized.commitment);

  const nodeVerdict = verifyRoundNode(finalized);
  const browserVerdict = await verifyRound(finalized);
  assert.equal(nodeVerdict.valid, true);
  assert.equal(browserVerdict.valid, true);
  assert.deepEqual(browserVerdict.errors, nodeVerdict.errors);
});

test('拒绝采样与洗牌是流驱动的：注入字节流可得到确定结果', async () => {
  const bytes = [5, 250, 7, 1, 200];
  let cursor = 0;
  const stream = {
    async next() {
      const value = bytes[cursor % bytes.length];
      cursor += 1;
      return value;
    },
  };
  // range=10 时上限为 250，250 会被丢弃，因此第二个取值是 7。
  assert.equal(await uniform(stream, 10), 5);
  assert.equal(await uniform(stream, 10), 7);
  const shuffled = await shuffleWith(stream, [0, 1, 2, 3]);
  assert.equal(shuffled.length, 4);
  assert.deepEqual([...shuffled].sort(), [0, 1, 2, 3]);
});

test('篡改任意字段都会让核验失败', async () => {
  const tamperedSeed = await verifyRound({...fixedRound(), serverSeed: 'b2'.repeat(32)});
  assert.equal(tamperedSeed.valid, false);
  assert.ok(tamperedSeed.errors.includes('种子承诺与服务器种子不符'));

  const tamperedContribution = await verifyRound({...fixedRound(), contributions: {'0': '0b'.repeat(32), '2': 'b7'.repeat(32)}});
  assert.equal(tamperedContribution.valid, false);
  assert.ok(tamperedContribution.errors.includes('牌序承诺与复算牌序不符'));

  const tamperedDeck = await verifyRound({...fixedRound(), deckCommitment: 'cc'.repeat(32)});
  assert.equal(tamperedDeck.valid, false);

  const noDeck = await verifyRound({...fixedRound(), deckCommitment: null});
  assert.equal(noDeck.valid, false);
  assert.ok(noDeck.errors.includes('本手未记录牌序承诺'));

  const badSeed = await verifyRound({...fixedRound(), serverSeed: 'zz'});
  assert.equal(badSeed.valid, false);
  assert.ok(badSeed.errors.includes('服务器种子格式非法'));
});

test('与比赛进行中留存的承诺对照：一致 / 不一致 / 未留存', async () => {
  const matching = await verifyRound(fixedRound(), {storedCommitment: {commitment: FIXED.commitment}});
  assert.equal(matching.checks[2].ok, true);

  const mismatched = await verifyRound(fixedRound(), {storedCommitment: {commitment: 'ff'.repeat(32)}});
  assert.equal(mismatched.valid, false);
  assert.equal(mismatched.checks[2].ok, false);
  assert.ok(mismatched.errors.includes('与比赛进行中留存的承诺不一致'));

  const missing = await verifyRound(fixedRound());
  assert.equal(missing.valid, true);
  assert.equal(missing.checks[2].ok, null);
  assert.match(missing.checks[2].detail, /未留存/);
});

test('承诺留存的读取键与写入键一致', () => {
  const store = memoryStorage();
  const key = commitmentKey('match-9', 4);
  assert.equal(key, 'poker_fair:match-9:4');
  store.setItem(key, JSON.stringify({roomId: 'room-9', matchId: 'match-9', handNo: 4, commitment: FIXED.commitment}));
  assert.equal(findCommitment('match-9', 4, store)?.commitment, FIXED.commitment);
  assert.equal(findCommitment('match-9', 5, store), null);
  store.setItem('poker_fair:match-9:bad', '{不是 JSON');
  assert.equal(findCommitment('match-9', Number.NaN, store), null);
});

test('整场核验逐手输出结果，并带上本机留存承诺', async () => {
  const rows = await verifyRounds([fixedRound(), {...fixedRound(), handNo: 4, deckCommitment: null}], {
    storedCommitments: [{roomId: 'room-1', matchId: FIXED.matchId, handNo: 3, commitment: FIXED.commitment}],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].valid, true);
  assert.equal(rows[0].checks[2].ok, true);
  assert.equal(rows[1].handNo, 4);
  assert.equal(rows[1].valid, false);
  assert.equal(rows[1].checks[2].ok, null);
});

test('同一房间的第二局不会被上一局的留存承诺判成篡改', async () => {
  // 手号在第二局会从 1 重新数：没有比赛号就无法区分「第 1 手」，只按房间对照必然误报。
  const second = finalizeRound(createRound('match-fixed-2', 1), [0]).round;
  const firstMatchRecord = {
    roomId: 'room-1',
    matchId: FIXED.matchId,
    handNo: second.handNo,
    commitment: second.commitment,
  };
  const rows = await verifyRounds([second], {storedCommitments: [firstMatchRecord]});
  assert.equal(rows[0].valid, true, '缺本局留存只能算「未留存」，不能算不一致');
  assert.equal(rows[0].checks[2].ok, null);
  assert.match(rows[0].checks[2].detail, /未留存/);

  // 同一场比赛的留存照旧对照得上。
  const same = await verifyRounds([second], {
    storedCommitments: [{...firstMatchRecord, matchId: 'match-fixed-2'}],
  });
  assert.equal(same[0].checks[2].ok, true);
  assert.equal(same[0].valid, true);
});

test('sha256 与十六进制工具的基本约束', async () => {
  assert.equal(await sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.throws(() => hexToBytes('abc'), RangeError);
  assert.throws(() => hexToBytes('zz'), RangeError);
});
