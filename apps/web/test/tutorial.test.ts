import test from 'node:test';
import assert from 'node:assert/strict';
import {TUTORIAL_STEPS, initTutorial, quizFeedback, shouldAutoOpen} from '../static/js/tutorial.js';
import {TUTORIAL_KEY} from '../static/js/util.js';

/**
 * 教程内容（TUTORIAL_STEPS）与判分（quizFeedback）是纯数据、纯函数，直接断言即可；
 * 弹窗行为则靠一个极小的假 DOM 驱动——只实现真正用到的 append / replaceChildren /
 * textContent / showModal / close / addEventListener，够跑「翻页、答错不放行、关掉记标记」。
 * 真实排版与动画只能在浏览器里看，这一点记在验证报告里。
 */
const STEPS: any[] = TUTORIAL_STEPS;

function makeNode(tag: string): any {
  const node: any = {
    tagName: tag,
    className: '',
    textContent: '',
    disabled: false,
    open: false,
    dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    listeners: {} as Record<string, ((event?: unknown) => void)[]>,
    children: [] as any[],
    parentNode: undefined as any,
    get isConnected() {
      return node.parentNode !== undefined;
    },
    append(...kids: any[]) {
      for (const kid of kids) {
        kid.parentNode = node;
        node.children.push(kid);
      }
    },
    replaceChildren(...kids: any[]) {
      node.children.length = 0;
      node.append(...kids);
    },
    addEventListener(type: string, handler: (event?: unknown) => void) {
      (node.listeners[type] ??= []).push(handler);
    },
    setAttribute(key: string, value: string) {
      node.attributes[key] = value;
    },
    focus() {},
    showModal() {
      node.open = true;
    },
    close() {
      node.open = false;
    },
    querySelector: () => null,
    click() {
      for (const handler of node.listeners.click ?? []) handler();
    },
  };
  return node;
}

function makeDoc(buttons: any[] = []) {
  const body = makeNode('body');
  return {
    body,
    createElement: (tag: string) => makeNode(tag),
    querySelectorAll: (selector: string) => (selector === '[data-tutorial]' ? buttons : []),
  };
}

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}

function withFakeDom<T>(doc: unknown, run: () => T): T {
  const saved = (globalThis as any).document;
  (globalThis as any).document = doc;
  try {
    return run();
  } finally {
    (globalThis as any).document = saved;
  }
}

/** 按文本找节点：假 DOM 里没有选择器，按钮文本就是它们的身份。 */
function findByText(root: any, text: string): any {
  if (root.textContent === text) return root;
  for (const kid of root.children ?? []) {
    const found = findByText(kid, text);
    if (found) return found;
  }
  return null;
}

test('教程六步覆盖从进桌到结算，每步都有正文与提示', () => {
  assert.equal(STEPS.length, 6, '六步刚好一屏能翻完');
  for (const step of STEPS) {
    assert.ok(typeof step.title === 'string' && step.title.length > 0, '每步要有标题');
    assert.ok(Array.isArray(step.body) && step.body.length > 0, `${step.title} 要有正文`);
    assert.ok(typeof step.tip === 'string' && step.tip.length > 0, `${step.title} 要有提示`);
    for (const item of step.body) assert.ok(item.length > 0, `${step.title} 的正文不能有空条目`);
  }
  const titles = STEPS.map((step) => step.title).join('|');
  for (const keyword of ['牌桌', '怎样进行', '怎么选', '比大小', '跟注', '结算']) {
    assert.ok(titles.includes(keyword), `教程缺少「${keyword}」这一步：${titles}`);
  }
});

test('教程口径与服务器一致：5 分钟行动、10 分钟兜底、虚拟筹码不可提现', () => {
  const text = STEPS.map((step) => [step.title, ...step.body, step.tip].join('。')).join('。');
  assert.ok(text.includes('5 分钟'), '要写明行动时限');
  assert.ok(text.includes('10 分钟'), '要写明结算兜底倒计时——不然玩家以为必须一直点确认');
  assert.ok(text.includes('确认'), '要讲清每手结束真人点确认');
  assert.equal(text.includes('30 秒'), false, '不能残留旧的 30 秒时限');
  assert.ok(text.includes('免费虚拟筹码') && text.includes('提现'), '要保留虚拟筹码不可兑换的声明');
});

test('第四步用五张公共牌举例，牌值合法且公共牌自己就凑成一对 A', () => {
  const step = STEPS.find((item) => Array.isArray(item.cards));
  assert.ok(step, '教程里要有一处看得见的牌面示例');
  assert.equal(step.cards.length, 5, '公共牌是五张');
  for (const card of step.cards) {
    assert.ok(Number.isInteger(card) && card >= 0 && card <= 51, `牌值越界：${card}`);
  }
  // 与引擎同一套编码：suit = floor(card / 13)，rank = card % 13 + 2。
  const ranks = step.cards.map((card: number) => (card % 13) + 2);
  assert.equal(ranks.filter((rank: number) => rank === 14).length, 2, '这副示例牌要在公共牌上就有一对 A');
});

test('跟注练习：正解是 20，答错给纠正提示、答对才给鼓励', () => {
  const step = STEPS.find((item) => item.quiz);
  assert.ok(step, '教程里要有一道练习题');
  assert.deepEqual(step.quiz.options, [10, 20, 30]);
  assert.equal(step.quiz.answer, 20, '已投入 10、对手下注到 30，跟注还差 20');
  assert.ok(step.quiz.options.includes(step.quiz.answer), '正解必须在选项里');
  assert.equal(quizFeedback(step, 20), step.quiz.correct);
  assert.equal(quizFeedback(step, 10), step.quiz.wrong);
  assert.equal(quizFeedback(step, 30), step.quiz.wrong, '把累计目标当成追加量是最常见的错法');
  assert.equal(quizFeedback(STEPS[0], 20), null, '没有练习题的步骤不该冒出评语');
  assert.equal(quizFeedback(undefined, 20), null, '没有这一步时也不能抛错');
});

test('首访自动弹出：页面声明了 data-tutorial-auto 且本地没记过才弹', () => {
  const storage = fakeStorage();
  const doc: any = {body: {dataset: {}}};
  assert.equal(shouldAutoOpen(doc, storage), false, '没声明 auto 的页面不弹');
  assert.equal(shouldAutoOpen(undefined, storage), false, '连 body 都没有时也不能抛错');
  doc.body.dataset.tutorialAuto = 'true';
  assert.equal(shouldAutoOpen(doc, storage), true, '第一次进大厅要弹');
  storage.setItem(TUTORIAL_KEY, 'yes');
  assert.equal(shouldAutoOpen(doc, storage), false, '看过了就不再打扰');
});

test('各页的教程按钮都能打开弹窗，默认不自动弹', () => {
  const buttons = [makeNode('button'), makeNode('button')];
  const doc = makeDoc(buttons);
  withFakeDom(doc, () => {
    const handle = initTutorial({document: doc, storage: fakeStorage()});
    assert.ok(handle, '假 DOM 齐备时应该建出弹窗');
    assert.equal(handle.dialog.open, false, '没声明 auto 的页面不该自己弹出来');
    assert.equal(doc.body.children.length, 0, '没打开时不该往 body 里塞节点');
    buttons[1].click();
    assert.equal(handle.dialog.open, true, '顶栏按钮要能打开教程');
    assert.equal(handle.dialog.attributes['aria-labelledby'], 'tutorial-title');
    assert.ok(findByText(handle.dialog, '新手教程 · 1 / 6'), '打开时停在第一步');
    assert.ok(findByText(handle.dialog, STEPS[0].title), '第一屏要显示标题');
    assert.ok(findByText(handle.dialog, `提示：${STEPS[0].tip}`), '第一屏要显示提示');
  });
});

test('答错不放行、答对才能翻到下一步，翻完写下「看过了」', () => {
  const storage = fakeStorage();
  const doc = makeDoc();
  withFakeDom(doc, () => {
    const handle = initTutorial({document: doc, storage, steps: STEPS});
    assert.ok(handle, '假 DOM 齐备时应该建出弹窗');
    handle.open();
    const next = () => findByText(handle.dialog, '下一步') ?? findByText(handle.dialog, '开始打牌');
    // 第 1～4 步没有练习题，直接翻过去。
    for (let index = 0; index < 4; index += 1) next().click();
    assert.ok(findByText(handle.dialog, '新手教程 · 5 / 6'), '四步之后停在跟注练习');
    assert.equal(next().disabled, true, '没答题前不许往下走');

    findByText(handle.dialog, '再投入 10').click();
    assert.ok(findByText(handle.dialog, STEPS[4].quiz.wrong), '答错要给纠正提示');
    assert.equal(next().disabled, true, '答错仍然不放行');

    findByText(handle.dialog, '再投入 20').click();
    assert.ok(findByText(handle.dialog, STEPS[4].quiz.correct), '答对要给鼓励');
    assert.equal(next().disabled, false, '答对后放行');

    next().click();
    assert.ok(findByText(handle.dialog, '新手教程 · 6 / 6'), '最后一步是结算');
    findByText(handle.dialog, '开始打牌').click();
    assert.equal(handle.dialog.open, false, '走完要关窗');
    assert.equal(storage.getItem(TUTORIAL_KEY), 'yes', '走完要记「看过了」');
  });
});

test('中途跳过也记「看过了」，且回退时不重置已答对的题', () => {
  const storage = fakeStorage();
  const doc = makeDoc();
  withFakeDom(doc, () => {
    const handle = initTutorial({document: doc, storage, steps: STEPS});
    assert.ok(handle, '假 DOM 齐备时应该建出弹窗');
    handle.open();
    findByText(handle.dialog, '上一步').click();
    assert.ok(findByText(handle.dialog, '新手教程 · 1 / 6'), '第一步再往前还是第一步');
    findByText(handle.dialog, '跳过').click();
    assert.equal(handle.dialog.open, false, '跳过要关窗');
    assert.equal(storage.getItem(TUTORIAL_KEY), 'yes', '跳过也算看过了，否则每进一次大厅弹一次');

    // 重开一次回到第一步。答过的题会记住（不逼人再答一遍），但第一步本来就没有题目，所以「下一步」是开的。
    handle.open();
    assert.equal(findByText(handle.dialog, '下一步').disabled, false, '第一步本来就没有题目');
  });
});
