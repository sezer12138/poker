/**
 * utils/fairness.js 契约测试：32 字节 wx.getRandomValues → 64 位小写十六进制，
 * 禁止 Math.random，随机源不可用时不提交并明确提示，承诺写入本地留存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createTimers, createWx, type WxMock} from './harness.ts';

interface ContributionResult {
  submitted: boolean;
  reason: string;
  notice: string;
  nonce?: string | null;
}

interface FairnessModule {
  NONCE_BYTES: number;
  nonceHex(): Promise<string | null>;
  randomAvailable(): boolean;
  needsContribution(room: unknown): boolean;
  contribute(room: unknown): Promise<ContributionResult>;
  describe(room: unknown): string;
  rememberCommitment(matchId: string, handNo: number, commitment: string): void;
  rememberFromRoom(room: unknown): void;
  markSubmitted(room: unknown): void;
  getCommitment(matchId: string, handNo: number): string | null;
  listCommitments(matchId: string): {handNo: number; commitment: string}[];
}

const COMMITMENT = 'c'.repeat(64);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup(wx: WxMock): FairnessModule {
  const loader = createLoader({wx, timers: createTimers()});
  return loader.load('utils/fairness.js') as FairnessModule;
}

function playingRoom(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'room-1',
    matchId: 'match-1',
    version: 12,
    status: 'playing',
    viewerSeat: 3,
    fairness: {
      handNo: 4,
      commitment: COMMITMENT,
      deckCommitment: null,
      contributors: [],
      owed: true,
      expected: [1, 3],
      deadline: 0
    },
    ...overrides
  };
}

test('nonceHex 使用 wx.getRandomValues(32 字节) 并输出 64 位小写十六进制', async () => {
  const bytes = Array.from({length: 32}, (_value, index) => (index * 7 + 200) % 256);
  const wx = createWx({randomBytes: bytes});
  const fairness = setup(wx);
  const nonce = await fairness.nonceHex();

  const expected = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assert.equal(nonce, expected);
  assert.match(String(nonce), /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(wx.randomLengths, [32]);
  assert.equal(fairness.NONCE_BYTES, 32);
});

test('Math.random 被替换为抛错时仍能生成 nonce 并提交', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const original = Math.random;
  Math.random = () => {
    throw new Error('禁止使用 Math.random');
  };
  try {
    const nonce = await fairness.nonceHex();
    assert.match(String(nonce), /^[0-9a-f]{64}$/);
    const result = await fairness.contribute(playingRoom());
    assert.equal(result.submitted, true);
  } finally {
    Math.random = original;
  }
});

test('随机源不可用时不提交任何请求并提示使用公开默认贡献', async () => {
  const wx = createWx({random: 'missing'});
  const fairness = setup(wx);
  assert.equal(fairness.randomAvailable(), false);
  assert.equal(await fairness.nonceHex(), null);

  const result = await fairness.contribute(playingRoom());
  assert.equal(result.submitted, false);
  assert.equal(result.reason, 'RANDOM_UNAVAILABLE');
  assert.equal(result.notice, '随机数不可用，本手使用公开默认贡献');
  assert.equal(wx.requests.length, 0, '随机源不可用时不得提交');

  const failed = createWx({random: 'fail'});
  const failedFairness = setup(failed);
  assert.equal(await failedFairness.nonceHex(), null);
  assert.equal((await failedFairness.contribute(playingRoom())).submitted, false);
});

test('contribute 提交 seat/nonce/handNo 且 requestId 为新 UUID', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const result = await fairness.contribute(playingRoom());

  assert.equal(result.submitted, true);
  assert.equal(wx.requests.length, 1);
  const request = wx.requests[0]!;
  assert.equal(request.url, 'http://127.0.0.1:8787/api/rooms/room-1/command');
  assert.equal(request.method, 'POST');
  const body = request.data as Record<string, unknown>;
  assert.equal(body.type, 'contribute');
  assert.equal(body.seat, 3);
  assert.equal(body.handNo, 4);
  assert.equal(body.expectedVersion, 12);
  assert.match(String(body.requestId), UUID);
  assert.equal(body.nonce, result.nonce);
  assert.match(String(body.nonce), /^[0-9a-f]{64}$/);
});

test('needsContribution 以服务端 owed 为准：本手不参赛（如已淘汰）不提交', () => {
  const fairness = setup(createWx());
  const round = (overrides: Record<string, unknown>) => ({handNo: 4, commitment: COMMITMENT, deckCommitment: null, contributors: [], owed: true, expected: [1, 3], deadline: 0, ...overrides});

  assert.equal(fairness.needsContribution(playingRoom()), true);
  assert.equal(fairness.needsContribution(playingRoom({status: 'waiting'})), false);
  assert.equal(fairness.needsContribution(playingRoom({status: 'finished'})), false);
  assert.equal(fairness.needsContribution(playingRoom({viewerSeat: null})), false);
  assert.equal(fairness.needsContribution(playingRoom({fairness: null})), false);
  assert.equal(
    fairness.needsContribution(playingRoom({fairness: round({deckCommitment: COMMITMENT})})),
    false,
    'deckCommitment 已定则不再收集'
  );
  assert.equal(fairness.needsContribution(playingRoom({fairness: round({owed: false})})), false, '服务端说不用交就不交');
  assert.equal(fairness.needsContribution(playingRoom({matchId: null})), false, '没有比赛号时宁可不提交');
});

test('同一手只提交一次，重复状态不会重复提交', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const room = playingRoom();
  const first = await fairness.contribute(room);
  const second = await fairness.contribute(room);
  assert.equal(first.submitted, true);
  assert.equal(second.submitted, false);
  assert.equal(second.reason, 'NOT_NEEDED');
  assert.equal(wx.requests.length, 1);

  // 下一手（handNo 变化）可以再次提交。
  const next = await fairness.contribute(
    playingRoom({version: 20, fairness: {handNo: 5, commitment: 'd'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [1, 3], deadline: 0}})
  );
  assert.equal(next.submitted, true);
  assert.equal(wx.requests.length, 2);
});

test('并发状态推送只产生一次提交', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const room = playingRoom();
  const results = await Promise.all([fairness.contribute(room), fairness.contribute(room), fairness.contribute(room)]);
  assert.equal(wx.requests.length, 1);
  assert.equal(results.filter((result) => result.submitted).length, 1);
  assert.equal(results.filter((result) => result.reason === 'IN_FLIGHT').length, 2);
});

test('提交成功后留存承诺，本地留存不覆盖', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const room = playingRoom();
  await fairness.contribute(room);

  assert.equal(fairness.getCommitment('match-1', 4), COMMITMENT);
  fairness.rememberCommitment('match-1', 4, 'f'.repeat(64));
  assert.equal(fairness.getCommitment('match-1', 4), COMMITMENT, '已留存承诺不得被覆盖');

  fairness.rememberFromRoom({
    id: 'room-1',
    matchId: 'match-1',
    fairness: {handNo: 5, commitment: 'e'.repeat(64), deckCommitment: null, contributors: [], deadline: 0}
  });
  assert.deepStrictEqual(fairness.listCommitments('match-1'), [
    {handNo: 4, commitment: COMMITMENT},
    {handNo: 5, commitment: 'e'.repeat(64)}
  ]);
  assert.deepStrictEqual(fairness.listCommitments('match-2'), []);
  assert.equal(fairness.getCommitment('match-1', 99), null);

  const stored = wx.storage.get('poker.commitments') as Record<string, string>;
  assert.equal(stored['match-1:4'], COMMITMENT);
});

test('承诺缺失或状态无 fairness 时不写入留存', () => {
  const wx = createWx();
  const fairness = setup(wx);
  fairness.rememberFromRoom(playingRoom({fairness: {handNo: 4, commitment: '', deckCommitment: null, contributors: [], deadline: 0}}));
  fairness.rememberFromRoom(playingRoom({fairness: null}));
  fairness.rememberFromRoom(null);
  assert.deepStrictEqual(fairness.listCommitments('match-1'), []);
  assert.equal(wx.storage.has('poker.commitments'), false);
});

test('同一房间重开一局：第二局照常提交，留存也不与第一局相撞', async () => {
  const wx = createWx();
  const fairness = setup(wx);
  const first = await fairness.contribute(playingRoom());
  assert.equal(first.submitted, true);

  // 房主点「再来一局」：房间号不变，比赛号变了，手号从 1 重新数。
  const reopened = playingRoom({
    matchId: 'match-2',
    version: 30,
    fairness: {handNo: 1, commitment: 'a'.repeat(64), deckCommitment: null, contributors: [], owed: true, expected: [1, 3], deadline: 0}
  });
  const second = await fairness.contribute(reopened);
  assert.equal(second.submitted, true, '第二局必须重新提交贡献');
  assert.equal(wx.requests.length, 2);

  fairness.markSubmitted(reopened);
  assert.equal(fairness.describe(reopened), '本手随机贡献已提交，等待其他玩家');
  assert.equal(fairness.getCommitment('match-2', 1), 'a'.repeat(64));
  assert.equal(fairness.getCommitment('match-1', 1), null, '两局的手号各存各的');
});

test('describe 给出收集阶段的中文说明', () => {
  const fairness = setup(createWx());
  assert.equal(fairness.describe(playingRoom()), '正在收集本手随机贡献');
  assert.equal(
    fairness.describe(playingRoom({fairness: {handNo: 4, commitment: COMMITMENT, deckCommitment: COMMITMENT, contributors: [], deadline: 0}})),
    '本手随机贡献已齐全，等待发牌'
  );
  assert.equal(fairness.describe(playingRoom({fairness: null})), '');
});
