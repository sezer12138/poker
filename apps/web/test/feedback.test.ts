import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFeedback as webFeedback} from '../static/js/feedback.js';
import {createLoader} from '../../wechat/test/harness.ts';
const wechatFeedback = (createLoader().load('utils/feedback.js') as {createFeedback: typeof webFeedback}).createFeedback;
for (const [client, createFeedback] of [['web', webFeedback], ['wechat', wechatFeedback]] as const) {

test(client + ' 历史和重复快照不发声，新行动按类型播报，静音仍更新基线', () => {
  const played: string[] = [];
  const feedback = createFeedback({play: (channel: string, clip: string) => played.push(`${channel}:${clip}`)});
  feedback.setEnabled('voice', true);
  feedback.setEnabled('sfx', true);
  feedback.ingest([{seq: 1, type: 'action', action: 'fold'}], {initial: true});
  assert.deepEqual(played, []);
  const events = [{seq: 2, type: 'action', action: 'raiseTo'}];
  feedback.ingest(events);
  feedback.ingest(events);
  assert.deepEqual(played, ['sfx:chips', 'voice:raiseTo']);
  feedback.setEnabled('voice', false);
  feedback.ingest([{seq: 3, type: 'action', action: 'call'}]);
  assert.deepEqual(played.slice(2), ['sfx:chips']);
  feedback.setActive(false);
  feedback.ingest([{seq: 4, type: 'action', action: 'allIn'}]);
  feedback.setActive(true);
  feedback.ingest([{seq: 4, type: 'action', action: 'allIn'}]);
  assert.equal(played.length, 3);
});

test(client + ' 重连建立基线、批量事件只播最新反馈，未知事件不产生声音', () => {
  const played: string[] = [];
  const feedback = createFeedback({play: (_: string, clip: string) => played.push(clip)});
  feedback.setEnabled('voice', true);
  feedback.ingest([{seq: 1, type: 'action', action: 'call'}, {seq: 2, type: 'action', action: 'allIn'}]);
  assert.deepEqual(played, ['allIn']);
  feedback.ingest([{seq: 3, type: 'action', action: 'fold'}], {initial: true});
  feedback.ingest([{seq: 4, type: 'action', action: 'unknown'}]);
  assert.deepEqual(played, ['allIn']);
});

test(client + ' 同一快照的行动与翻牌事件均保留声音反馈', () => {
  const played: string[] = [];
  const feedback = createFeedback({play: (channel: string, clip: string) => played.push(`${channel}:${clip}`)});
  feedback.setEnabled('voice', true);
  feedback.setEnabled('sfx', true);
  feedback.ingest([{seq: 1, type: 'action', action: 'call'}, {seq: 2, type: 'street'}]);
  assert.deepEqual(played, ['sfx:deal', 'voice:call']);
});

}
