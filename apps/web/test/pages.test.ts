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

// renderSeats / renderResult / 结算弹窗里动态生成的节点，本来就不应出现在静态 HTML 中。
const DYNAMIC_SELECTORS = new Set(['seat-countdown', 'next-hand-countdown', 'dialog-countdown']);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, ROOT)), 'utf8');
}

test('每个页面都存在并使用 type="module" 引入自己的脚本', () => {
  for (const [page, script] of PAGES) {
    const html = read(page);
    assert.ok(html.includes('lang="zh-CN"'), `${page} 应声明中文语言`);
    assert.match(
      html,
      new RegExp(`<script type="module" src="static/js/${script}\\.js(\\?v=[^"]*)?"></script>`),
      `${page} 缺少模块脚本`,
    );
    assert.equal(/<script(?![^>]*type="module")/.test(html), false, `${page} 不允许非模块脚本`);
    assert.equal(/https?:\/\//.test(html), false, `${page} 不得引用外部资源`);
  }
});

test('页面引用的脚本与样式文件真实存在', () => {
  for (const file of [
    'static/styles.css',
    'static/js/lobby.js',
    'static/js/room.js',
    'static/js/table.js',
    'static/js/rules.js',
    'static/js/audit.js',
    'static/js/tutorial.js',
    'static/js/music.js',
  ]) {
    assert.ok(existsSync(fileURLToPath(new URL(file, ROOT))), `缺少 ${file}`);
  }
  const css = read('static/styles.css');
  assert.ok(css.includes('--bg: #F4F6F5'), '样式缺少浅灰底色');
  assert.ok(css.includes('--surface: #FFFFFF'), '样式缺少纯白面板底色');
  assert.ok(css.includes('--ink: #243C32'), '样式缺少墨色文字');
  assert.ok(css.includes('--accent: #28694F'), '样式缺少品牌绿点缀色');
  assert.ok(css.includes('--felt: #E5EEE9'), '样式缺少牌桌毡面底色');
  // 金色/铜色已从主题里去掉：强调一律走品牌绿，留一个 --brass 变量只会让后来者用错色。
  assert.equal(css.includes('--brass'), false, '样式表仍残留 --brass');
  assert.equal(/@import|url\(\s*['"]?https?:/.test(css), false, '样式不得引用外部资源');
});

test('每个页面的静态资源都带同一个缓存版本号', () => {
  const versions = new Set<string>();
  for (const [page, script] of PAGES) {
    const html = read(page);
    const css = html.match(/href="static\/styles\.css\?v=([^"]+)"/);
    const js = html.match(new RegExp(`src="static/js/${script}\\.js\\?v=([^"]+)"`));
    assert.ok(css, `${page} 的样式表没带版本号，换主题后老访客会拿到旧样式`);
    assert.ok(js, `${page} 的脚本没带版本号`);
    versions.add(css[1]!);
    assert.equal(css[1], js[1], `${page} 的样式与脚本版本号不一致`);
  }
  // 版本号必须是同一天同一批：只改一个页面会让两端缓存状态不一致。
  assert.equal(versions.size, 1, `各页面的缓存版本号不统一：${[...versions].join(' / ')}`);
});

test('播报横幅在样式表里有基础样式、五个语气档与动画', () => {
  const css = read('static/styles.css');
  assert.match(css, /\.announce\s*\{/, '缺少 .announce 基础样式');
  for (const tone of ['big', 'medium', 'neutral', 'quiet', 'error']) {
    // neutral 用基础样式即可，其余四档各有自己的修饰类。
    if (tone === 'neutral') continue;
    assert.ok(css.includes(`.announce--${tone}`), `缺少 ${tone} 档的样式`);
  }
  assert.ok(css.includes('@keyframes announce-in'), '缺少播报的淡入淡出动画');
});

test('新手教程改成弹窗后，五个页面都能就地打开它', () => {
  // 教程不再是独立页：它由 tutorial.js 在各页动态建出 <dialog>，靠 [data-tutorial] 按钮唤出。
  // 少任何一个入口，那一页的新手就永远看不到教程。
  const version = read('index.html').match(/styles\.css\?v=([^"]+)"/)?.[1];
  assert.ok(version, 'index.html 的样式表没带版本号');
  for (const [page] of PAGES) {
    const html = read(page);
    assert.ok(html.includes('data-tutorial'), `${page} 没有打开教程的入口`);
    assert.match(
      html,
      new RegExp(`<script type="module" src="static/js/tutorial\\.js(\\?v=${version})?"></script>`),
      `${page} 没有引入弹窗教程脚本`,
    );
    assert.equal(html.includes('tutorial.html'), false, `${page} 仍指向已删除的独立教程页`);
  }
  // 首次进大厅自动弹一次，其余页面只在点按钮时弹。
  assert.ok(read('index.html').includes('data-tutorial-auto="true"'), '大厅要声明自动弹出教程');
  for (const [page] of PAGES.slice(1)) {
    assert.equal(read(page).includes('data-tutorial-auto'), false, `${page} 不该自动弹出教程，会打断正在进行的牌局`);
  }
});

test('教程弹窗关掉后必须真的收起来（<dialog> 的 [open] 覆盖规则）', () => {
  // 原生 <dialog> 关闭时靠 UA 的 dialog:not([open]){display:none} 隐藏，
  // 而作者样式里的 display:flex 会压过它——少了这条覆盖，按 Esc 关掉的教程会一直盖在页面上。
  const css = read('static/styles.css');
  assert.match(css, /\.tutorial-dialog:not\(\[open\]\)\s*\{\s*display:\s*none/, 'styles.css 缺少关闭态的覆盖规则');
  assert.ok(css.includes('.tutorial-dialog::backdrop'), '教程弹窗缺少遮罩样式');
});

test('[hidden] 必须盖过作者样式，空弹窗不能遮住牌桌', () => {
  // 结算弹窗、操作按钮行、新手引导条都写了 display，作者样式压过 UA 的 [hidden]。
  // 少了这条 !important，隐藏只会在 DOM 里发生，屏幕上照样罩着。
  const css = read('static/styles.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, 'styles.css 缺少 [hidden] 覆盖规则');
});

test('每个页面的主题色与样式表的主色一致', () => {
  // 直接从样式表里取底色来比对，改主题时不用再手改这里的色值。
  const bg = read('static/styles.css').match(/--bg:\s*(#[0-9A-Fa-f]{6})/)?.[1];
  assert.ok(bg, '样式表里找不到 --bg');
  for (const [page] of PAGES) {
    const html = read(page);
    assert.ok(html.includes(`<meta name="theme-color" content="${bg}" />`), `${page} 的 theme-color 未跟随 --bg`);
    assert.equal(html.includes('#0B3D2E'), false, `${page} 仍残留旧的深绿牌桌色`);
  }
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
  const modules = [
    'api',
    'ws',
    'fairness',
    'verify',
    'cards',
    'format',
    'util',
    'music',
    'feedback',
    'announce',
    'lobby',
    'room',
    'table',
    'rules',
    'audit',
    'tutorial',
  ];
  for (const name of modules) {
    const source = read(`static/js/${name}.js`);
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const target = match[1];
      assert.ok(target.startsWith('./'), `${name}.js 只能相对引用同目录模块，发现 ${target}`);
      const file = target.slice(2).split('?')[0]!;
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
