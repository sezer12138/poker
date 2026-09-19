/**
 * 新手教程页：静态数据必须真的教会一遍完整流程，且口径与产品一致
 * （5 分钟行动时限、免费虚拟筹码、结算确认）。这里只校验数据与跳转，
 * 不验证渲染——WXML 的渲染只能在微信开发者工具里看。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoader, createPageContext, createTimers, createWx, invoke, type WxMock} from './harness.ts';

interface Step {
  title: string;
  body: string[];
  tip: string;
}

interface Faq {
  question: string;
  answer: string;
}

function tutorialPage(wx: WxMock = createWx()) {
  const loader = createLoader({wx, timers: createTimers()});
  return {wx, context: createPageContext(loader, 'pages/tutorial/tutorial.js')};
}

test('教程页注册成功，每步都有标题、正文与提示', () => {
  const {context} = tutorialPage();
  const steps = context.data.steps as Step[];
  assert.equal(steps.length, 6, '六个步骤覆盖从建房到核验');
  for (const step of steps) {
    assert.ok(step.title.length > 0, '步骤缺少标题');
    assert.ok(step.body.length >= 3, `步骤「${step.title}」的正文太短，讲不清一件事`);
    assert.ok(step.tip.length > 0, `步骤「${step.title}」缺少提示`);
  }
  assert.equal(new Set(steps.map((step) => step.title)).size, steps.length, '步骤标题不能重复');
});

test('教程覆盖完整流程的关键词', () => {
  const {context} = tutorialPage();
  const text = JSON.stringify(context.data);
  for (const keyword of ['创建好友房', '房间码', '准备', '弃牌', '跟注', '公共牌', '边池', '结算', '确认', '核验']) {
    assert.ok(text.includes(keyword), `教程缺少关键词：${keyword}`);
  }
});

test('教程写明 5 分钟行动时限与结算确认口径', () => {
  const {context} = tutorialPage();
  const text = JSON.stringify(context.data);
  assert.ok(text.includes('5 分钟'), '教程未说明 5 分钟行动时限');
  assert.ok(!text.includes('30 秒'), '教程仍写着旧的 30 秒行动时限');
  assert.ok(text.includes('确认'), '教程未说明结算确认');
  assert.ok(text.includes('自动继续'), '教程未说明不点确认也会自动开下一手');
});

test('常见问题如实说明免费虚拟筹码，不承诺提现', () => {
  const {context} = tutorialPage();
  const faq = context.data.faq as Faq[];
  assert.ok(faq.length >= 4, '至少四条常见问题');
  for (const item of faq) {
    assert.ok(item.question.length > 0 && item.answer.length > 0, '问答不能为空');
  }
  const text = JSON.stringify(faq);
  assert.ok(text.includes('免费虚拟筹码'), '必须说明筹码是免费虚拟筹码');
  assert.ok(text.includes('提现'), '必须明确回应能否提现');
  assert.ok(!text.includes('可以提现') && !text.includes('能够提现'), '不能承诺提现');
});

test('教程页可以跳到完整规则页', () => {
  const {wx, context} = tutorialPage();
  invoke(context, 'onRules');
  assert.deepStrictEqual(wx.navigations, ['/pages/rules/rules']);
});
