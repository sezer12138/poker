import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  NONCE_PATTERN,
  UNAVAILABLE_NOTICE,
  commitmentKey,
  commitmentRecord,
  contributionKey,
  contributionPlan,
  findCommitment,
  findStoredCommitment,
  hasSecureRandom,
  listCommitments,
  needsContribution,
  randomNonce,
  saveCommitment,
} from '../static/js/fairness.js';

const JS_DIR = fileURLToPath(new URL('../static/js/', import.meta.url));

/** 只暴露 getRandomValues 的桩：测试不依赖真实随机源。 */
function cryptoStub(fill: number) {
  return {
    getRandomValues(bytes: Uint8Array) {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = fill;
      return bytes;
    },
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    getItem(key: string) {
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

function roomWith(fairness: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    matchId: 'match-1',
    status: 'playing',
    viewerSeat: 1,
    members: [
      {userId: 'u0', seat: 0, name: '机器人一号', bot: true, ready: true},
      {userId: 'u1', seat: 1, name: '甲', bot: false, ready: true},
      {userId: 'u2', seat: 2, name: '乙', bot: false, ready: true},
    ],
    fairness,
    ...overrides,
  };
}

test('随机贡献是 64 位小写十六进制，来自注入的 crypto 桩', () => {
  const nonce = randomNonce(cryptoStub(0xab));
  assert.equal(nonce.length, 64);
  assert.match(nonce, NONCE_PATTERN);
  assert.equal(nonce, 'ab'.repeat(32));
  assert.ok(NONCE_PATTERN.test(nonce));
});

test('不同字节得到不同贡献，且每次调用独立取随机数', () => {
  let calls = 0;
  const cryptoImpl = {
    getRandomValues(bytes: Uint8Array) {
      calls += 1;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index + calls) % 256;
      return bytes;
    },
  };
  const first = randomNonce(cryptoImpl);
  const second = randomNonce(cryptoImpl);
  assert.equal(calls, 2);
  assert.notEqual(first, second);
  assert.match(first, NONCE_PATTERN);
  assert.match(second, NONCE_PATTERN);
  assert.equal(hasSecureRandom(cryptoImpl), true);
});

test('缺少安全随机源时抛出，绝不退回非密码学随机数', () => {
  assert.equal(hasSecureRandom({}), false);
  assert.equal(hasSecureRandom({getRandomValues: undefined} as unknown as Crypto), false);
  assert.throws(() => randomNonce({} as Crypto), /getRandomValues/);
  // 传 null 表示使用全局 crypto；Node 26 自带 webcrypto，所以这里必须是可用的。
  assert.equal(hasSecureRandom(null), typeof globalThis.crypto?.getRandomValues === 'function');
  if (hasSecureRandom(null)) assert.match(randomNonce(), NONCE_PATTERN);
});

test('全部前端脚本都不允许出现 Math.random', () => {
  const files = readdirSync(JS_DIR).filter((name) => name.endsWith('.js'));
  const required = ['api.js', 'ws.js', 'fairness.js', 'verify.js', 'cards.js', 'format.js', 'util.js', 'lobby.js', 'room.js', 'table.js', 'audit.js'];
  for (const name of required) assert.ok(files.includes(name), `缺少模块 ${name}`);
  for (const name of files) {
    const source = readFileSync(`${JS_DIR}${name}`, 'utf8');
    assert.equal(source.includes('Math.random'), false, `${name} 不得使用 Math.random`);
  }
});

test('是否提交只看服务端的 owed：本手不参赛（如已淘汰）不再每手提交', () => {
  const pending = roomWith({
    handNo: 4,
    commitment: 'aa'.repeat(32),
    deckCommitment: null,
    contributors: [0],
    owed: true,
    expected: [0, 1],
    deadline: 1,
  });
  assert.equal(needsContribution(pending, 1), true);
  // 服务端说不用交就是不用交：已交过、机器人、观众、本手被淘汰都在这里。
  assert.equal(needsContribution({...pending, fairness: {...pending.fairness, owed: false}}, 1), false);
  // 已定牌序、非比赛状态、没有 fairness 都不提交。
  assert.equal(needsContribution({...pending, fairness: {...pending.fairness, deckCommitment: 'bb'.repeat(32)}}, 1), false);
  assert.equal(needsContribution({...pending, status: 'waiting'}, 1), false);
  assert.equal(needsContribution({...pending, fairness: null}, 1), false);
  // 座位号缺失或视图里没有 owed（老服务端）时一律不提交，宁可交给公开默认贡献。
  assert.equal(needsContribution(pending, null), false);
  assert.equal(needsContribution(pending, undefined), false);
  const withoutOwed: Record<string, unknown> = {...pending.fairness};
  delete withoutOwed.owed;
  assert.equal(needsContribution({...pending, fairness: withoutOwed}, 1), false);
});

test('贡献计划：可用则给出座位/手号/随机数，不可用则只提示', () => {
  const room = roomWith({
    handNo: 7,
    commitment: 'cc'.repeat(32),
    deckCommitment: null,
    contributors: [],
    owed: true,
    expected: [0, 1, 2],
    deadline: 2,
  });
  const plan = contributionPlan(room, 1, {cryptoImpl: cryptoStub(0x5a)});
  assert.deepEqual(plan, {kind: 'contribute', seat: 1, handNo: 7, nonce: '5a'.repeat(32)});
  // 命令体由 api.buildContributeCommand 生成，这里只保证字段来源正确。
  assert.equal('expectedVersion' in plan, false);

  // 传入没有 getRandomValues 的实现即代表环境不支持安全随机数（不能用 null 表达，null 意为使用全局 crypto）。
  const fallback = contributionPlan(room, 1, {cryptoImpl: {} as Crypto});
  assert.deepEqual(fallback, {kind: 'unavailable', notice: UNAVAILABLE_NOTICE, handNo: 7});
  assert.equal(UNAVAILABLE_NOTICE, '随机数不可用，本手使用公开默认贡献');

  // 服务端说不用交（已交过、本手不参赛）就什么都不做，连随机数都不取。
  assert.deepEqual(contributionPlan({...room, fairness: {...room.fairness, owed: false}}, 1, {cryptoImpl: cryptoStub(1)}), {
    kind: 'none',
  });
  assert.deepEqual(contributionPlan(room, 1, {cryptoImpl: cryptoStub(1)}), {
    kind: 'contribute',
    seat: 1,
    handNo: 7,
    nonce: '01'.repeat(32),
  });
});

test('广播承诺按 比赛+手号 留存，可被核验页取回', () => {
  const store = memoryStorage();
  const room = roomWith({
    handNo: 12,
    commitment: 'de'.repeat(32),
    deckCommitment: null,
    contributors: [],
    deadline: 3,
  });
  const saved = saveCommitment(room, store, 1_700_000_000_000);
  assert.ok(saved);
  assert.equal(saved.handNo, 12);
  assert.equal(saved.roomId, 'room-1');
  assert.equal(saved.matchId, 'match-1');
  assert.equal(commitmentKey('match-1', 12), `poker_fair:match-1:12`);
  const found = findCommitment('match-1', 12, store);
  assert.equal(found?.commitment, 'de'.repeat(32));
  assert.equal(findCommitment('match-1', 13, store), null);
  assert.equal(findCommitment('other', 12, store), null);

  saveCommitment(roomWith({handNo: 13, commitment: 'ff'.repeat(32), deckCommitment: null, contributors: [], deadline: 3}), store);
  const all = listCommitments(store);
  assert.deepEqual(all.map((item) => item.handNo), [12, 13]);
  assert.equal(findStoredCommitment(all, 'match-1', 13)?.commitment, 'ff'.repeat(32));
  assert.equal(findStoredCommitment(all, 'match-1', 99), null);
  // 换了一场比赛（同房间开第二局）不再对得上：手号会重来，只按房间比会误报篡改。
  assert.equal(findStoredCommitment(all, 'match-2', 13), null);

  // 没有 fairness 快照（例如别人还没贡献）时不写入任何东西。
  assert.equal(commitmentRecord(roomWith(null)), null);
  assert.equal(saveCommitment(roomWith(null), store), null);
  assert.equal(listCommitments(memoryStorage()).length, 0);
});

test('提交去重键带比赛号，第二局的第 1 手不会被当成已提交', () => {
  const first = roomWith({handNo: 1, commitment: 'aa'.repeat(32), deckCommitment: null, contributors: [], owed: true, deadline: 1});
  const second = {...first, matchId: 'match-2'};
  assert.notEqual(contributionKey(first, 1), contributionKey(second, 1));
  assert.equal(contributionKey(first, 1), 'match-1:1');
  assert.equal(contributionKey(second, 1), 'match-2:1');
  // 缺比赛号时退化成手号，但仍不会与另一场的同号相撞。
  assert.equal(contributionKey({}, 3), ':3');
});

test('同一手重复广播不覆盖已留存的承诺，第二局的手号也不覆盖第一局', () => {
  const store = memoryStorage();
  const hand = (commitment: string, overrides = {}) =>
    roomWith({handNo: 1, commitment, deckCommitment: null, contributors: [], deadline: 1}, overrides);

  saveCommitment(hand('11'.repeat(32)), store);
  // 同一手再推一次（甚至内容不同）都不覆盖：留存的意义就是对照「当时公布过什么」。
  saveCommitment(hand('22'.repeat(32)), store);
  assert.equal(findCommitment('match-1', 1, store)?.commitment, '11'.repeat(32));

  // 第二局是另一场比赛，同样从第 1 手开始，必须各存各的。
  saveCommitment(hand('33'.repeat(32), {matchId: 'match-2'}), store);
  assert.equal(findCommitment('match-1', 1, store)?.commitment, '11'.repeat(32));
  assert.equal(findCommitment('match-2', 1, store)?.commitment, '33'.repeat(32));
  assert.equal(listCommitments(store).length, 2);

  // 没有比赛号的视图（例如开赛前的推送）不产生记录。
  assert.equal(commitmentRecord(hand('44'.repeat(32), {matchId: null})), null);
  assert.equal(commitmentRecord(hand('44'.repeat(32), {matchId: ''})), null);
});
