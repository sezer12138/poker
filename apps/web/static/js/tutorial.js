// 新手教程页：把「从进大厅到打完一手」的完整路径拆成几步，每步配一条实用提示。
// 内容以数据形式给出，再由 renderTutorial 渲染；模块顶层不访问 window/document，
// 这样 Node 端可以直接 import 这份数据做静态检查（见 test/tutorial.test.ts）。

import {el, qs, render} from './util.js';

/** 教程步骤。body 是这一步要做的动作，tip 是新手最容易踩的坑。 */
export const TUTORIAL_STEPS = [
  {
    title: '建房或加入房间',
    body: [
      '在大厅点「创建房间」，填一个房间名并选择机器人数量，2 至 9 人都能开局。',
      '房主创建后会拿到 6 位房号与一条邀请链接，发给朋友就能拉人进同一桌。',
      '只想先熟悉一下？加两个机器人自己练手最快。',
    ],
    tip: '房主自动坐在 0 号座位。房号不区分大小写，邀请链接里带的是房间令牌，不要随便外发。',
  },
  {
    title: '等所有人准备',
    body: [
      '进入房间后点「准备」，真人需要各自点一次；机器人自动准备。',
      '至少 2 位参赛者、且所有真人都准备后，房主才能点「开始比赛」。',
      '准备即表示接受：比赛结束后本桌成员可以核验完整历史牌序（含弃牌者的底牌）。',
    ],
    tip: '开赛后名单锁定，中途进不来人，也不能换座。想加人请在开赛前加。',
  },
  {
    title: '看牌并行动',
    body: [
      '每人起始 1,000 筹码，牌桌上你自己的两张底牌是正面朝上的，别人的看不到。',
      '轮到你时下面的操作区会亮起来，可选：弃牌、过牌、跟注、加注、全押。',
      '每次行动有 90 秒；超时会自动过牌（能过牌时）或自动弃牌。',
      '加注框里填的是「本轮累计投入目标」，不是这一次要多掏多少。',
    ],
    tip: '底部有「最小/半池/底池/最大」快捷键，拿不准金额时直接点，不用自己算。',
  },
  {
    title: '看清公共牌与底池',
    body: [
      '桌面中央依次开出翻牌 3 张、转牌 1 张、河牌 1 张，每人用两张底牌与五张公共牌里的任意组合比大小。',
      '底池按投入金额分层：主池给所有人竞争，边池只在其有资格的玩家之间比较，各自独立结算。',
      '没人匹配的超额投入会退回本人，弃牌者的筹码留在池里但不再有获奖资格。',
    ],
    tip: '「跟注」按钮上会写实际需要补多少，不用自己盯别人的下注额。',
  },
  {
    title: '每手结束确认结算',
    body: [
      '一手结束时弹出结算窗：谁赢了、赢了多少、谁被淘汰，金额逐条列出。',
      '所有真人点「确认，继续」后立刻开下一手；有人暂时没点也没关系，窗口倒计时结束会自动继续。',
      '被淘汰的座位不参与确认，只看结果。',
    ],
    tip: '结算窗在倒计时结束后会自动收起，所以离开一会儿不会把整桌人卡住。',
  },
  {
    title: '打完一整场并核验',
    body: [
      '筹码归零即被淘汰，最后剩下的一名玩家是冠军。',
      '每手发牌前服务器先公布种子承诺，每位真人提交一次随机贡献，牌序由这些输入共同决定。',
      '整场比赛结束后，本桌成员可以在核验页复算每一手的牌序，确认发牌没有被中途改动。',
    ],
    tip: '比赛进行中不公开核验包——这是为了防止边打边算出别人的底牌。',
  },
];

/** 常见问题。answers 用纯文本，避免教程页引入富文本渲染。 */
export const TUTORIAL_FAQ = [
  {
    question: '行动时我不在手机前会怎样？',
    answer: '90 秒后服务器会自动过牌或弃牌，这一手你只是放弃下注，不会被踢出房间；回来还能继续打下一手。',
  },
  {
    question: '能看别人上一手用什么牌赢的吗？',
    answer: '可以。整场比赛结束后，本桌成员在核验页可以看到每一手的完整底牌与牌序复算结果。',
  },
  {
    question: '筹码输光了怎么办？',
    answer: '比赛结束后房主可以重新开始一场，届时所有人统一重置为 1,000 筹码并生成新的比赛标识。',
  },
  {
    question: '这些筹码能换成钱吗？',
    answer: '不能。所有筹码都是免费虚拟筹码，产品不提供任何充值、提现、道具购买或实物兑换。',
  },
];

export function renderTutorial(container) {
  render(
    container,
    TUTORIAL_STEPS.map((step, index) =>
      el('section', {className: 'tutorial__step'}, [
        el('div', {className: 'tutorial__num', text: String(index + 1)}),
        el('div', {className: 'tutorial__body'}, [
          el('h3', {text: step.title}),
          el('ul', {}, step.body.map((item) => el('li', {text: item}))),
          el('p', {className: 'tutorial__tip', text: `提示：${step.tip}`}),
        ]),
      ]),
    ),
  );
}

export function renderFaq(container) {
  render(
    container,
    TUTORIAL_FAQ.map(item =>
      el('div', {}, [el('h4', {text: item.question}), el('p', {className: 'muted', text: item.answer})]),
    ),
  );
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const steps = qs('#tutorial-steps');
    if (steps) renderTutorial(steps);
    const faq = qs('#tutorial-faq');
    if (faq) renderFaq(faq);
  });
}
