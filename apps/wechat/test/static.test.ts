/**
 * 静态校验：配置可解析、页面文件 1:1、所有 .js 语法有效且可装载、
 * 无 web-view、无 Math.random、后端地址单一配置、品牌与中文文案。
 * 这些检查都不能替代微信开发者工具与真机运行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {WECHAT_ROOT, createLoader, createTimers, createWx, read, readJson, relative, walk} from './harness.ts';

const EXPECTED_PAGES = [
  'pages/lobby/lobby',
  'pages/room/room',
  'pages/table/table',
  'pages/tutorial/tutorial',
  'pages/rules/rules',
  'pages/audit/audit'
];

const JS_FILES = walk(WECHAT_ROOT, '.js').filter((file) => !file.includes(`${path.sep}test${path.sep}`));

test('app.json 可解析，pages 与页面文件 1:1', () => {
  const appJson = readJson(path.join(WECHAT_ROOT, 'app.json'));
  const pages = appJson.pages as string[];
  assert.ok(Array.isArray(pages), 'app.json 缺少 pages 数组');
  assert.deepStrictEqual([...pages].sort(), [...EXPECTED_PAGES].sort());

  for (const page of pages) {
    for (const extension of ['.js', '.wxml', '.wxss', '.json']) {
      const file = path.join(WECHAT_ROOT, page + extension);
      assert.ok(fs.existsSync(file), `${page}${extension} 不存在`);
    }
    assert.ok(readJson(path.join(WECHAT_ROOT, page + '.json')), `${page}.json 不可解析`);
  }

  // 反向检查：pages/ 下的每个目录都必须在 app.json 登记，且没有多余登记。
  const directories = fs
    .readdirSync(path.join(WECHAT_ROOT, 'pages'), {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .map((entry) => `pages/${entry.name}/${entry.name}`);
  assert.deepStrictEqual(directories.sort(), [...pages].sort());
});

test('project.config.json 可解析且为可导入的游客 appid', () => {
  const project = readJson(path.join(WECHAT_ROOT, 'project.config.json'));
  assert.equal(project.appid, 'touristappid');
  assert.equal(project.compileType, 'miniprogram');
  const description = String(project.description ?? '');
  assert.match(description, /AppID/, 'project.config.json 需说明必须替换真实 AppID');
  const setting = project.setting as Record<string, unknown>;
  assert.equal(setting.urlCheck, false, '本地开发需关闭域名校验');

  const sitemap = readJson(path.join(WECHAT_ROOT, 'sitemap.json'));
  assert.ok(Array.isArray(sitemap.rules));
});

test('所有 .js 文件通过 vm.Script 语法检查', () => {
  assert.ok(JS_FILES.length >= 12, `预期至少 12 个 .js 文件，实际 ${JS_FILES.length}`);
  for (const file of JS_FILES) {
    assert.doesNotThrow(() => new vm.Script(read(file), {filename: file}), `${relative(file)} 语法错误`);
  }
});

test('每个页面与 app.js 都能在注入桩后装载并注册', () => {
  const loader = createLoader({wx: createWx(), timers: createTimers()});
  assert.doesNotThrow(() => loader.load('app.js'));
  assert.ok(loader.app, 'app.js 未调用 App()');

  for (const page of EXPECTED_PAGES) {
    assert.doesNotThrow(() => loader.load(`${page}.js`), `${page}.js 装载失败`);
  }
  assert.equal(loader.pages.size, EXPECTED_PAGES.length);
  for (const [name, options] of loader.pages) {
    assert.ok(typeof options.onLoad === 'function' || options.data !== undefined, `${name} 既无 onLoad 也无 data`);
  }
  // 交互页面必须自己拉取状态，规则页是纯静态内容。
  for (const page of ['pages/lobby/lobby', 'pages/room/room', 'pages/table/table', 'pages/audit/audit']) {
    const options = loader.pages.get(`${page}.js`);
    assert.equal(typeof options?.onLoad, 'function', `${page} 缺少 onLoad`);
  }
  // 等待房间与牌桌必须实现生命周期重连。
  for (const page of ['pages/room/room', 'pages/table/table']) {
    const options = loader.pages.get(`${page}.js`);
    assert.equal(typeof options?.onHide, 'function', `${page} 缺少 onHide`);
    assert.equal(typeof options?.onShow, 'function', `${page} 缺少 onShow`);
    assert.equal(typeof options?.onUnload, 'function', `${page} 缺少 onUnload`);
  }
});

test('等待房间实现分享路径，且不把令牌放进 URL 之外的地方', () => {
  const loader = createLoader({wx: createWx(), timers: createTimers()});
  loader.load('pages/room/room.js');
  const room = loader.pages.get('pages/room/room.js');
  assert.ok(room, '房间页未注册');
  const share = (
    room.onShareAppMessage as (this: unknown) => {title: string; path: string}
  ).call({data: {room: {invite: 'INVITE_TOKEN'}, invite: ''}});
  assert.equal(share.title, '同桌 · 德州扑克 邀请');
  assert.equal(share.path, '/pages/room/room?invite=INVITE_TOKEN');

  const fallback = (
    room.onShareAppMessage as (this: unknown) => {title: string; path: string}
  ).call({data: {room: null, invite: 'QUERY_TOKEN'}});
  assert.equal(fallback.path, '/pages/room/room?invite=QUERY_TOKEN');
});

test('小程序不使用 Math.random，后端地址只在 config.js 配置', () => {
  for (const file of JS_FILES) {
    const source = read(file);
    assert.ok(!/Math\.random\s*\(/.test(source), `${relative(file)} 使用了 Math.random`);
    if (relative(file) === 'config.js') continue;
    assert.ok(!source.includes('127.0.0.1'), `${relative(file)} 硬编码了后端地址`);
    assert.ok(!/wss?:\/\//.test(source), `${relative(file)} 硬编码了 WebSocket 地址`);
  }

  const loader = createLoader({wx: createWx(), timers: createTimers()});
  const config = loader.load('config.js') as {baseUrl: string; wsUrl: string; storage: {token: string}};
  assert.equal(config.baseUrl, 'http://127.0.0.1:8787');
  assert.equal(config.wsUrl, 'ws://127.0.0.1:8787/ws');
  assert.equal(config.storage.token, 'poker.token');
});

test('两端调色板逐值一致：改一头必须改另一头', () => {
  // app.wxss 与 web 的 styles.css 各自在顶部声明同一套变量，两边的注释都写着
  // 「改色要两端一起改」。没有这条断言，那句话就只是一句注释。
  const shared = [
    '--bg',
    '--surface',
    '--surface-2',
    '--line',
    '--line-strong',
    '--ink',
    '--muted',
    '--accent',
    '--accent-dark',
    '--accent-soft',
    '--on-accent',
    '--felt',
    '--card-back',
    '--danger',
    '--ok'
  ];
  const readVars = (source: string) => {
    const vars = new Map<string, string>();
    // 变量名里可能有数字（--surface-2），字符类要带上 0-9。
    for (const match of source.matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
      vars.set(match[1]!, match[2]!.toUpperCase());
    }
    return vars;
  };
  const web = readVars(read(path.join(WECHAT_ROOT, '..', 'web', 'static', 'styles.css')));
  const mini = readVars(read(path.join(WECHAT_ROOT, 'app.wxss')));
  for (const name of shared) {
    assert.ok(web.has(name), `web 样式表缺少 ${name}`);
    assert.equal(mini.get(name), web.get(name), `${name} 两端不一致（小程序 ${mini.get(name)} / web ${web.get(name)}）`);
  }
});

test('不使用 web-view，品牌色与中文文案齐备', () => {
  const wxmlFiles = walk(WECHAT_ROOT, '.wxml');
  assert.ok(wxmlFiles.length >= EXPECTED_PAGES.length);
  for (const file of wxmlFiles) {
    assert.ok(!read(file).includes('web-view'), `${relative(file)} 使用了 web-view`);
  }

  // 简约主题的调色板：浅灰底、低饱和绿牌桌、墨色文字，全站只有一种强调色（品牌绿）。
  const appWxss = read(path.join(WECHAT_ROOT, 'app.wxss'));
  for (const color of ['#F4F6F5', '#243C32', '#28694F', '#E5EEE9', '#B3261E']) {
    assert.ok(appWxss.includes(color), `app.wxss 缺少主题色 ${color}`);
  }
  // 旧的深绿主题与铜色点缀必须彻底退出，否则会出现半新半旧的界面。
  for (const color of ['#0B3D2E', '#F5EFDC', '#B5A642', '#A98A4E']) {
    assert.ok(!appWxss.includes(color), `app.wxss 仍残留旧主题色 ${color}`);
  }
  // 铜色类名一并删掉：留一个名字叫 brass 的绿色类，后来者一定会用错。
  assert.equal(appWxss.includes('brass'), false, 'app.wxss 仍残留 brass');
  assert.ok(appWxss.includes('.accent'), '强调文字类改名为 .accent 后要在样式里定义');

  const roomWxml = read(path.join(WECHAT_ROOT, 'pages/room/room.wxml'));
  assert.ok(roomWxml.includes('随机核验披露'), '等待房间缺少核验披露说明');

  const lobbyWxml = read(path.join(WECHAT_ROOT, 'pages/lobby/lobby.wxml'));
  assert.ok(lobbyWxml.includes('机器人练习'), '大厅缺少机器人练习入口');
  assert.ok(lobbyWxml.includes('创建好友房'), '大厅缺少创建房间入口');
  assert.ok(lobbyWxml.includes('新手教程'), '大厅缺少新手教程入口');
});

test('浅色主题：导航栏配色与页面样式表都不再硬编码旧配色', () => {
  const appJson = readJson(path.join(WECHAT_ROOT, 'app.json'));
  const window = appJson.window as Record<string, unknown>;
  assert.equal(window.backgroundColor, '#F4F6F5');
  assert.equal(window.navigationBarBackgroundColor, '#F4F6F5');
  // 浅底必须配深字，否则导航标题在浅色背景上看不见。
  assert.equal(window.navigationBarTextStyle, 'black');

  const legacy = ['#0B3D2E', '#F5EFDC', '#B5A642', '#E4786C', '#10241C', '#B23A2E', '#14503C'];
  for (const file of walk(WECHAT_ROOT, '.wxss')) {
    const source = read(file);
    for (const color of legacy) {
      assert.ok(!source.includes(color), `${relative(file)} 仍残留旧主题色 ${color}`);
    }
    // 色值只在 app.wxss 的 page 变量里定义一次；页面样式一律 var(--x)（rgba 遮罩除外）。
    if (relative(file) !== 'app.wxss') {
      assert.ok(!/#[0-9A-Fa-f]{6}/.test(source), `${relative(file)} 硬编码了色值，应改用 app.wxss 的变量`);
    }
  }
});

test('规则页覆盖必需主题', () => {
  const rules = read(path.join(WECHAT_ROOT, 'pages/rules/rules.js'));
  for (const keyword of ['牌型', '最小加注', '短码全押', '边池', '平局', '单挑', '超时', '淘汰', '核验', '结算']) {
    assert.ok(rules.includes(keyword), `规则页缺少主题：${keyword}`);
  }
  // 行动时限与结算口径已改为 90 秒 / 8 秒兜底，规则页不能还写着 30 秒。
  assert.ok(rules.includes('90 秒'), '规则页未说明 90 秒行动时限');
  assert.ok(!rules.includes('30 秒'), '规则页仍写着旧的 30 秒行动时限');
  assert.ok(rules.includes('8 秒'), '规则页未说明结算兜底 8 秒');
});

test('README 明确列出无法验证项', () => {
  const readme = read(path.join(WECHAT_ROOT, 'README.md'));
  for (const item of ['wx.login', '分享', 'wss', 'WXML']) {
    assert.ok(readme.includes(item), `README 未说明无法验证：${item}`);
  }
  assert.ok(readme.includes('touristappid'), 'README 未说明导入 appid');
});
