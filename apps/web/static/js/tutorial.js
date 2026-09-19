// 新手教程：一个盖在当前页面上的弹窗，六步讲完「认识牌桌 → 怎么行动 → 怎么比大小 → 跟注练习 → 看结算」。
// 首次进大厅自动弹出（body[data-tutorial-auto="true"]），各页顶栏的 [data-tutorial] 按钮随时能重看。
// 内容以数据形式给出、渲染只走 util/cards；模块顶层不碰 window/document，
// 因此 Node 端可以直接 import 这份数据与判分函数做静态检查（见 test/tutorial.test.ts）。

import {el, setText, storageGet, storageSet, TUTORIAL_KEY} from './util.js';
import {cardElement} from './cards.js';

/** 教程步骤：title 标题、body 这一步要做什么（逐条）、tip 新手最容易踩的坑。 */
export const TUTORIAL_STEPS = [
  {
    title: '先认识牌桌',
    body: [
      '每位参赛者起始 1,000 免费虚拟筹码，筹码跨手保留；输光即被淘汰，最后剩下的一名玩家是冠军。',
      '你自己的两张底牌是正面朝上的，别人的看不到；桌面中央的公共牌所有人共享。',
      '想先练手，在大厅点「机器人练习」就能单人开一桌（1 人对 3 个机器人），随时退出不扣什么。',
    ],
    tip: '牌桌上的筹码都是免费虚拟筹码，不能充值、提现，也不能兑换任何实物。',
  },
  {
    title: '一手牌怎样进行',
    body: [
      '小盲和大盲先投入盲注，每人发两张底牌，随后依次开出翻牌 3 张、转牌 1 张、河牌 1 张。',
      '每条街（翻牌前、翻牌、转牌、河牌）都有一轮下注，轮到你时可以从弃牌、过牌、跟注、加注、全押里选一个。',
      '盲注 5/10 起，每完成 10 手升一级，升到 4,500/9,000 封顶。',
    ],
    tip: '翻牌前从大盲左侧开始行动，翻牌后从庄家左侧仍在牌局中的玩家开始；两人单挑时庄家就是小盲，翻牌前先行动。',
  },
  {
    title: '轮到你时怎么选',
    body: [
      '过牌：没人要求你补筹码，免费看下一张。跟注：补齐到当前下注额。弃牌：放弃这一手，已投入的筹码留在底池里。',
      '加注框里填的是「本轮累计投入目标」，不是这一次要多掏多少：你已经投入 10，加注到 30，就只需再掏 20。',
      '全押会一次投入所有剩余筹码，按钮会先让你确认一次再发出去。',
      '每次行动有 5 分钟，超时会自动过牌（能过牌时）或自动弃牌，不会把你踢出房间。',
    ],
    tip: '拿不准金额就点快捷按钮（最小 / 半池 / 底池 / 全押），不用自己算。',
  },
  {
    title: '用最好的五张牌比大小',
    body: [
      '从两张底牌和五张公共牌里挑出最大的五张——可以用 0 张、1 张或 2 张底牌。',
      '从大到小：同花顺（最高是皇家同花顺）＞ 四条 ＞ 葫芦 ＞ 同花 ＞ 顺子 ＞ 三条 ＞ 两对 ＞ 一对 ＞ 高牌。',
      '牌型相同时比点数，花色不分大小；完全一样就平分底池，除不尽的余数从庄家左侧依次发。',
    ],
    tip: '下面这五张公共牌自己就凑成了「一对 A」——公共牌成牌型时，你的底牌可能一张都用不上。',
    // 展示用的五张公共牌（A♣ A♦ K♥ 9♠ 7♣），由 draw() 用 cardElement 渲染。
    cards: [12, 25, 37, 46, 5],
  },
  {
    title: '练习一次跟注',
    body: ['本轮你已经投入 10，对手把下注提到 30。你想继续留在牌局里、不加注，需要再投入多少？'],
    tip: '答对这道题才能继续——这正是新手最容易算错的一步。',
    quiz: {
      options: [10, 20, 30],
      answer: 20,
      correct: '答对了：30 − 10 = 20，再投入 20 就跟上了。加注框里填的永远是累计目标。',
      wrong: '再算一下：对手本轮已投入 30，你已经投入 10，跟上他还差 20。',
    },
  },
  {
    title: '看懂结算，再开下一手',
    body: [
      '每手结束弹出结算窗，逐条列出每个座位这手的净输赢、亮出的牌与牌型、还剩多少筹码。',
      '活着的真人各点一次「确认，继续」，全部确认后立刻开下一手；被淘汰的和观战者只看结果，没有确认按钮。',
      '有人一直不点也不会把整桌卡住：结算窗有 10 分钟兜底倒计时，到时自动开下一手。',
    ],
    tip: '整场结束后可以在核验页复算每一手的牌序，确认发牌没有被中途改动。现在可以开始了。',
  },
];

/**
 * 练习题判分：答对返回鼓励文案，答错返回纠正提示，这道题没有 quiz 时返回 null。
 * 单独抽出来是为了让 Node 端能直接测「算错一步就不会放行」。
 */
export function quizFeedback(step, amount) {
  const quiz = step?.quiz;
  if (!quiz) return null;
  return amount === quiz.answer ? quiz.correct : quiz.wrong;
}

/** 首访自动弹出的条件：页面声明了 data-tutorial-auto，且本地没记过「看过了」。 */
export function shouldAutoOpen(doc, storageImpl) {
  return doc?.body?.dataset?.tutorialAuto === 'true' && storageGet(TUTORIAL_KEY, null, storageImpl) !== 'yes';
}

/**
 * 建好弹窗并接上各页的 [data-tutorial] 按钮，返回 {open, close} 供调用方复用。
 * 浏览器里由页面自己调（见文件末尾），测试里注入假 document/存储。
 */
export function initTutorial(options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== 'function') return null;
  const steps = options.steps ?? TUTORIAL_STEPS;
  const storage = options.storage;

  const eyebrow = el('p', {className: 'eyebrow'});
  const title = el('h2', {attrs: {id: 'tutorial-title', tabindex: '-1'}});
  const content = el('div', {className: 'tutorial-dialog__content'});
  const feedback = el('p', {className: 'tutorial-dialog__feedback', attrs: {'aria-live': 'polite'}});
  const prev = el('button', {className: 'btn btn--ghost', type: 'button', text: '上一步', on: {click: () => go(index - 1)}});
  const next = el('button', {className: 'btn', type: 'button', on: {click: () => (index === steps.length - 1 ? finish() : go(index + 1))}});
  const skip = el('button', {className: 'btn btn--ghost', type: 'button', text: '跳过', on: {click: () => finish()}});
  const card = el('div', {className: 'tutorial-dialog__card'}, [
    eyebrow,
    title,
    content,
    feedback,
    el('div', {className: 'row row--between'}, [skip, el('div', {className: 'row'}, [prev, next])]),
  ]);
  const dialog = el('dialog', {className: 'tutorial-dialog', attrs: {'aria-labelledby': 'tutorial-title'}}, [card]);

  let index = 0;
  // 每一题各自记住选过的答案：来回翻步骤时不该把已经答对的题重置回未答状态。
  const chosen = new Map();

  /** 画出当前这一步。整块重建，省得逐节点同步。 */
  function draw() {
    const step = steps[index];
    setText(eyebrow, `新手教程 · ${index + 1} / ${steps.length}`);
    setText(title, step.title);
    // 反馈行是常驻节点（不随 content 重建），换步时要自己清干净，否则上一题的评语会跟过来。
    feedback.className = 'tutorial-dialog__feedback';
    setText(feedback, '');
    const blocks = [el('ul', {}, step.body.map((item) => el('li', {text: item})))];
    if (Array.isArray(step.cards)) {
      blocks.push(el('div', {className: 'board'}, step.cards.map((card) => cardElement(card, {small: true}))));
      blocks.push(el('p', {className: 'muted', text: '示例：这五张就是公共牌。'}));
    }
    if (step.quiz) blocks.push(quizBlock(step));
    blocks.push(el('p', {className: 'tutorial__tip', text: `提示：${step.tip}`}));
    content.replaceChildren(...blocks);

    setText(next, index === steps.length - 1 ? '开始打牌' : '下一步');
    prev.disabled = index === 0;
    next.disabled = !passed(step);
    if (typeof title.focus === 'function') title.focus();
  }

  /** 这道题是否已经答对。没答、答错都不算——答错要一直改到对，这正是这道题的目的。 */
  function passed(step) {
    return !step.quiz || chosen.get(index) === step.quiz.answer;
  }

  /** 练习题：三个金额按钮 + 一行反馈；答对才把「下一步」打开。 */
  function quizBlock(step) {
    const picked = chosen.get(index);
    const buttons = step.quiz.options.map((amount) =>
      el('button', {
        className: `btn ${picked === amount ? (amount === step.quiz.answer ? 'is-right' : 'is-wrong') : 'btn--ghost'}`,
        type: 'button',
        text: `再投入 ${amount}`,
        on: {
          click: () => {
            if (picked === step.quiz.answer) return; // 答对后不再改答案，反馈也不该被推翻
            chosen.set(index, amount);
            draw();
          },
        },
      }),
    );
    const state = picked === undefined ? '' : picked === step.quiz.answer ? 'is-right' : 'is-wrong';
    feedback.className = `tutorial-dialog__feedback ${state}`.trim();
    setText(feedback, picked === undefined ? '' : quizFeedback(step, picked));
    return el('div', {className: 'tutorial-dialog__options'}, buttons);
  }

  function go(target) {
    index = Math.max(0, Math.min(steps.length - 1, target));
    draw();
  }

  function open() {
    index = 0;
    draw();
    if (typeof doc.body?.append === 'function' && !dialog.isConnected) doc.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
  }

  /**
   * 收工：关窗并记「看过了」。没点完就跳过也记——否则每进一次大厅就再弹一次，
   * 新人被反复打扰比错过教程更糟。
   */
  function finish() {
    if (typeof dialog.close === 'function') dialog.close();
    storageSet(TUTORIAL_KEY, 'yes', storage);
  }

  for (const button of options.buttons ?? doc.querySelectorAll('[data-tutorial]')) {
    button.addEventListener('click', open);
  }
  if (shouldAutoOpen(doc, storage)) open();

  return {open, close: finish, dialog};
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => initTutorial());
}
