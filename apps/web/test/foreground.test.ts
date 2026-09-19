import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createForegroundSync} from '../static/js/table.js';
import {createFeedback} from '../static/js/feedback.js';

test('后台无变化，回前台同步后第一条新行动仍播报', async () => {
  const clips: string[] = [];
  const feedback = createFeedback({play: (_: string, clip: string) => clips.push(clip)});
  feedback.setEnabled('voice', true);
  const events = [{seq: 1, type: 'action', action: 'fold'}];
  feedback.ingest(events, {initial: true});
  let refreshes = 0;
  const visibility = createForegroundSync({
    setActive: (active: boolean) => feedback.setActive(active),
    refresh: async () => { refreshes++; },
    baseline: () => feedback.ingest(events, {initial: true}),
  });
  await visibility(true);
  await visibility(false);
  feedback.ingest([{seq: 2, type: 'action', action: 'call'}]);
  assert.equal(refreshes, 1);
  assert.deepEqual(clips, ['call']);
});

test('同步请求尚未返回时再次切后台，不会恢复音频', async () => {
  const active: boolean[] = [];
  let resolve!: () => void;
  let baselines = 0;
  const visibility = createForegroundSync({
    setActive: (value: boolean) => active.push(value),
    refresh: () => new Promise<void>(done => { resolve = done; }),
    baseline: () => { baselines++; },
  });
  const pending = visibility(false);
  await visibility(true);
  resolve();
  await pending;
  assert.deepEqual(active, [false, false]);
  assert.equal(baselines, 0);
});
