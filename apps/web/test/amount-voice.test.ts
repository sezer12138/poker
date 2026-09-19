import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLoader} from '../../wechat/test/harness.ts';
import * as web from '../static/js/feedback.js';
const wechat = createLoader().load('utils/feedback.js') as typeof web;
for (const [client, mod] of [['web', web], ['wechat', wechat]] as const) {
  test(client + ' 加注和全押播报完整金额，中文零位和十位正确', () => {
    assert.deepEqual(mod.speechClips('raiseTo', 1250), ['raiseAmount', 'n1', 'thousand', 'n2', 'hundred', 'n5', 'ten', 'chipUnit']);
    assert.deepEqual(mod.speechClips('allIn', 1005), ['allInAmount', 'n1', 'thousand', 'n0', 'n5', 'chipUnit']);
    assert.deepEqual(mod.speechClips('raiseTo', 10), ['raiseAmount', 'ten', 'chipUnit']);
    assert.deepEqual(mod.speechClips('raiseTo', 101), ['raiseAmount', 'n1', 'hundred', 'n0', 'n1', 'chipUnit']);
    assert.deepEqual(mod.speechClips('raiseTo', 10001), ['raiseAmount', 'n1', 'tenThousand', 'n0', 'n1', 'chipUnit']);
    for (const amount of [undefined, -1, 1.2, NaN, Infinity]) assert.deepEqual(mod.speechClips('allIn', amount), ['allIn']);
  });
  test(client + ' 真实事件的结构化金额传给语音播放器', () => {
    const heard: unknown[] = [];
    const feedback = mod.createFeedback({play: (channel: string, clip: string, amount: number) => { if (channel === 'voice') heard.push([clip, amount]); }});
    feedback.setEnabled('voice', true);
    feedback.ingest([{seq: 1, type: 'action', action: 'raiseTo', amount: 1250}]);
    feedback.ingest([{seq: 2, type: 'action', action: 'allIn', amount: 1005}]);
    assert.deepEqual(heard, [['raiseTo', 1250], ['allIn', 1005]]);
  });
  test(client + ' 金额语音顺序播放不被下一位玩家打断，静音清空且旧回调失效', () => {
    const played: string[] = [];
    const completions: (() => void)[] = [];
    const queue = mod.createVoiceQueue({playClip: (clip: string, done: () => void) => { played.push(clip); completions.push(done); }, stopClip() {}});
    queue.enqueue(['raiseAmount', 'n5', 'hundred', 'chipUnit']);
    queue.enqueue(['allInAmount', 'n1', 'thousand', 'chipUnit']);
    assert.deepEqual(played, ['raiseAmount']);
    for (let i = 0; i < 4; i++) completions[i]!();
    assert.deepEqual(played, ['raiseAmount', 'n5', 'hundred', 'chipUnit', 'allInAmount']);
    queue.clear();
    completions[4]!();
    assert.equal(played.length, 5);
    queue.enqueue(['check']);
    assert.equal(played.at(-1), 'check');
  });
}
