import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// 页面与脚本的接线检查：DOM 无法在 Node 里跑，但“选择器写错导致按钮永远不生效”这类问题能静态查出来。

const ROOT = new URL('../', import.meta.url);
const PAGES: [string, string][] = [
  ['index.html', 'lobby'],
  ['room.html', 'room'],
  ['table.html', 'table'],
  ['rules.html', 'rules'],
  ['audit.html', 'audit'],
];

// renderSeats / renderResult 里动态生成的节点，本来就不应出现在静态 HTML 中。
const DYNAMIC_SELECTORS = new Set(['seat-countdown', 'next-hand-countdown']);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');
}

test('每个页面都存在并使用 type="module" 引入自己的脚本', () => {
  for (const [page, script] of PAGES) {
    const html = read(page);
    assert.ok(html.includes('lang="zh-CN"'), `${page} 应声明中文语言`);
    assert.ok(html.includes(`<script type="module" src="static/js/${script}.js"></script>`), `${page} 缺少模块脚本`);
    assert.equal(/<script(?![^>]*type="module")/.test(html), false, `${page} 不允许非模块脚本`);
    assert.equal(/https?:\/\//.test(html), false, `${page} 不得引用外部资源`);
  }
});

test('页面引用的脚本与样式文件真实存在', () => {
  for (const file of ['static/styles.css', 'static/js/lobby.js', 'static/js/room.js', 'static/js/table.js', 'static/js/rules.js', 'static/js/audit.js']) {
    assert.ok(existsSync(fileURLToPath(new URL(file, ROOT))), `缺少 ${file}`);
  }
  const css = read('static/styles.css');
  assert.ok(css.includes('#0B3D2E'), '样式缺少深绿牌桌主色');
  assert.ok(css.includes('#F5EFDC'), '样式缺少奶油牌面色');
  assert.ok(css.includes('#B5A642'), '样式缺少黄铜点缀色');
  assert.equal(/@import|url\(\s*['"]?https?:/.test(css), false, '样式不得引用外部资源');
});

test('脚本里引用的 #id 都能在对应页面找到', () => {
  for (const [page, script] of PAGES) {
    const html = read(page);
    const source = read(`static/js/${script}.js`);
    const ids = new Set<string>();
    for (const match of source.matchAll(/node\('([A-Za-z0-9_-]+)'\)/g)) ids.add(match[1]);
    for (const match of source.matchAll(/qs\('#([A-Za-z0-9_-]+)'/g)) ids.add(match[1]);
    assert.ok(ids.size > 0, `${script} 未引用任何元素`);
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `${page} 缺少脚本引用的 #${id}`);
    }
  }
});

test('脚本里引用的 data-action / data-quick / data-role 都能在页面找到', () => {
  for (const [page, script] of PAGES) {
    const html = read(page);
    const source = read(`static/js/${script}.js`);
    for (const attribute of ['data-action', 'data-quick', 'data-role']) {
      const pattern = new RegExp(`\\[${attribute}="([A-Za-z0-9_-]+)"\\]`, 'g');
      for (const match of source.matchAll(pattern)) {
        if (attribute === 'data-role' && DYNAMIC_SELECTORS.has(match[1])) continue;
        assert.ok(html.includes(`${attribute}="${match[1]}"`), `${page} 缺少脚本引用的 ${attribute}="${match[1]}"`);
      }
    }
  }
});

test('页面不引用未列出的模块，模块之间只使用相对路径', () => {
  const modules = ['api', 'ws', 'fairness', 'verify', 'cards', 'format', 'util', 'lobby', 'room', 'table', 'rules', 'audit'];
  for (const name of modules) {
    const source = read(`static/js/${name}.js`);
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const target = match[1];
      assert.ok(target.startsWith('./'), `${name}.js 只能相对引用同目录模块，发现 ${target}`);
      const file = target.slice(2);
      assert.ok(modules.includes(file.replace(/\.js$/, '')), `${name}.js 引用了未列出的模块 ${target}`);
    }
  }
});

test('等待房间的准备按钮旁必须有完整披露文案', () => {
  const html = read('room.html');
  assert.ok(html.includes('id="ready-disclosure"'), 'room.html 缺少披露文案容器');
  const source = read('static/js/room.js');
  assert.ok(source.includes('比赛结束后本桌成员可核验完整历史牌序，准备即表示接受'), 'room.js 缺少披露文案');
});

test('牌桌页面提供全部操作按钮与精确金额输入', () => {
  const html = read('table.html');
  for (const action of ['fold', 'check', 'call', 'raise', 'allIn']) {
    assert.ok(html.includes(`data-action="${action}"`), `table.html 缺少 ${action} 按钮`);
  }
  assert.ok(html.includes('id="raise-amount"'), 'table.html 缺少精确金额输入');
  assert.ok(html.includes('type="number"'), '金额输入必须是数字输入');
});
