import test from 'node:test';
import assert from 'node:assert/strict';
import {TUTORIAL_FAQ, TUTORIAL_STEPS, renderFaq, renderTutorial} from '../static/js/tutorial.js';

/**
 * 新手教程是纯数据 + 渲染函数。Node 里没有 DOM，所以给 renderTutorial 一个极小的假
 * 容器，只实现 append / textContent / createElement —— 足够断言「渲染出了几步、
 * 每步有没有标题、正文和提示」。真正的样式与排版只能在浏览器里看，这一点记在验证报告里。
 */
function fakeDom() {
  const createElement = (tag: string) => {
    const node: any = {
      tagName: tag,
      children: [] as any[],
      dataset: {} as Record<string, string>,
      attributes: {} as Record<string, string>,
      listeners: {} as Record<string, unknown[]>,
      className: '',
      textContent: '',
      style: {},
      append(...kids: any[]) {
        for (const kid of kids) node.children.push(kid);
      },
      addEventListener(type: string, handler: unknown) {
        (node.listeners[type] ??= []).push(handler);
      },
      setAttribute(key: string, value: string) {
        node.attributes[key] = value;
      },
      querySelector: () => null,
    };
    return node;
  };
  return {createElement, addEventListener() {}} as any;
}

/** 递归把假 DOM 里的文本收成一个字符串，方便断言"页面上真的写了这句话"。 */
function textOf(node: any): string {
  if (typeof node === 'string') return node;
  const own = node.textContent === '' ? '' : String(node.textContent);
  return own + node.children.map(textOf).join('');
}

function withFakeDom<T>(run: () => T): T {
  const saved = (globalThis as any).document;
  (globalThis as any).document = fakeDom();
  try {
    return run();
  } finally {
    (globalThis as any).document = saved;
  }
}

test('教程按开局顺序覆盖每一步，每条都有正文与提示', () => {
  assert.ok(TUTORIAL_STEPS.length >= 5, '太短的教程教不会新手');
  for (const step of TUTORIAL_STEPS) {
    assert.ok(typeof step.title === 'string' && step.title.length > 0, '每步要有标题');
    assert.ok(Array.isArray(step.body) && step.body.length > 0, `${step.title} 要有正文`);
    assert.ok(typeof step.tip === 'string' && step.tip.length > 0, `${step.title} 要有提示`);
    for (const item of step.body) assert.ok(item.length > 0);
  }
  const titles = TUTORIAL_STEPS.map(step => step.title).join('|');
  for (const keyword of ['房', '准备', '行动', '公共牌', '结算', '核验']) {
    assert.ok(titles.includes(keyword), `教程缺少「${keyword}」这一步：${titles}`);
  }
});

test('教程与当前规则一致：90 秒行动、结算确认', () => {
  const text = TUTORIAL_STEPS.map(step => [step.title, ...step.body, step.tip].join('。')).join('。') +
    TUTORIAL_FAQ.map(item => `${item.question}。${item.answer}`).join('。');
  assert.ok(text.includes('90 秒'), '教程必须写明新的行动时限');
  assert.ok(!text.includes('30 秒'), '不能残留旧的 30 秒时限');
  assert.ok(text.includes('确认'), '要讲清每手结束要点确认');
  // 合规口径：教程里反复出现的免费筹码说明必须写明不可兑换。
  assert.ok(text.includes('免费虚拟筹码') && text.includes('提现'), '教程要保留虚拟筹码声明');
});

test('常见问题都成对给出问题与答案', () => {
  assert.ok(TUTORIAL_FAQ.length > 0);
  for (const item of TUTORIAL_FAQ) {
    assert.ok(item.question.length > 0 && item.answer.length > 0, '问答不能缺一半');
  }
});

test('渲染出与数据一一对应的步骤节点', () => {
  withFakeDom(() => {
    const container = fakeDom().createElement('section');
    renderTutorial(container);
    assert.equal(container.children.length, TUTORIAL_STEPS.length, '几步就渲染几个节点');
    TUTORIAL_STEPS.forEach((step, index) => {
      const node = container.children[index];
      assert.equal(node.className, 'tutorial__step');
      assert.equal(node.children[0].textContent, String(index + 1), '序号从 1 开始');
      const text = textOf(node);
      assert.ok(text.includes(step.title), `第 ${index + 1} 步缺少标题`);
      for (const item of step.body) assert.ok(text.includes(item), `第 ${index + 1} 步缺少正文（${item}）`);
      assert.ok(text.includes(step.tip), `第 ${index + 1} 步缺少提示`);
    });
  });
});

test('渲染常见问题时不会把答案渲染丢', () => {
  withFakeDom(() => {
    const container = fakeDom().createElement('div');
    renderFaq(container);
    const text = textOf(container);
    for (const item of TUTORIAL_FAQ) {
      assert.ok(text.includes(item.question), `缺少问题：${item.question}`);
      assert.ok(text.includes(item.answer), `缺少答案：${item.question}`);
    }
  });
});
