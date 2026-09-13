// 大厅：昵称、创建房间、房码/邀请链接加入、机器人练习与规则入口。
// 模块顶层不访问 window/document/localStorage。

import {ApiError, createApi, ensureSession, isUnauthorized, readName, saveName, saveToken} from './api.js';
import {navigate, pageUrl, qs, queryParam, setDisabled, setHidden, setText} from './util.js';

const view = {
  api: null,
  session: null,
  busy: false,
  mode: null,
};

function node(id) {
  return qs(`#${id}`);
}

function showError(message) {
  const banner = node('error-banner');
  if (!banner) return;
  setText(banner, message ?? '');
  setHidden(banner, !message);
}

function setBusy(busy) {
  view.busy = busy;
  for (const id of ['create-btn', 'join-code-btn', 'practice-btn', 'wechat-btn']) {
    setDisabled(node(id), busy);
  }
  setText(node('status-text'), busy ? '处理中…' : '');
}

function handleError(error, action) {
  if (isUnauthorized(error)) {
    view.api?.clearToken();
    showError('登录已失效，请重新进入大厅');
    return;
  }
  const code = error?.code;
  if (code === 'WECHAT_NOT_CONFIGURED') {
    showError('微信登录未配置，请使用游客登录');
    return;
  }
  const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
  showError(`${action}失败：${message}`);
}

function nickname() {
  const input = node('nickname');
  const value = input?.value?.trim() ?? '';
  return value === '' ? '玩家' : value.slice(0, 24);
}

/**
 * 昵称变化时重新以游客身份登录，房间内才会显示新昵称。
 * 仅在玩家主动点按钮时触发，避免回到大厅自动换掉正在用的身份。
 */
async function withNickname() {
  const name = nickname();
  saveName(name);
  if (view.session && view.session.user?.name === name) return view.session;
  const result = await view.api.guestLogin(name);
  saveToken(result.token);
  view.session = {token: result.token, user: result.user, mode: result.mode, created: true};
  setText(node('user-line'), `当前身份：${result.user.name}`);
  return view.session;
}

async function createRoom(bots) {
  if (view.busy) return;
  setBusy(true);
  showError(null);
  try {
    await withNickname();
    const room = await view.api.createRoom({name: nickname(), bots});
    navigate(pageUrl('room.html', {id: room.id}));
  } catch (error) {
    handleError(error, '创建房间');
  } finally {
    setBusy(false);
  }
}

async function joinRoom(params) {
  if (view.busy) return;
  setBusy(true);
  showError(null);
  try {
    await withNickname();
    const room = await view.api.joinRoom(params);
    navigate(pageUrl('room.html', {id: room.id}));
  } catch (error) {
    handleError(error, '加入房间');
  } finally {
    setBusy(false);
  }
}

async function wechatLogin() {
  if (view.busy) return;
  const code = node('wechat-code')?.value?.trim() ?? '';
  if (code === '') {
    showError('请填写微信登录凭证 code（本地开发环境未配置微信时请使用游客登录）');
    return;
  }
  setBusy(true);
  showError(null);
  try {
    const name = nickname();
    const result = await view.api.wechatLogin(code, name);
    saveToken(result.token);
    saveName(name);
    view.session = {token: result.token, user: result.user, mode: result.mode, created: true};
    setText(node('user-line'), `当前身份：${result.user.name}`);
  } catch (error) {
    handleError(error, '微信登录');
  } finally {
    setBusy(false);
  }
}

function wire() {
  node('create-btn')?.addEventListener('click', () => {
    const bots = Number.parseInt(node('create-bots')?.value ?? '0', 10);
    createRoom(Number.isInteger(bots) ? Math.max(0, Math.min(8, bots)) : 0);
  });
  node('practice-btn')?.addEventListener('click', () => createRoom(3));
  node('join-code-btn')?.addEventListener('click', () => {
    const code = node('join-code')?.value?.trim() ?? '';
    if (code === '') {
      showError('请输入房间码');
      return;
    }
    joinRoom({code});
  });
  node('join-invite-btn')?.addEventListener('click', () => {
    const invite = node('join-invite')?.value?.trim() ?? queryParam('invite') ?? '';
    if (invite === '') {
      showError('请粘贴邀请链接或邀请码');
      return;
    }
    const fromLink = invite.includes('invite=') ? queryParam('invite', invite.slice(invite.indexOf('?'))) : invite;
    joinRoom({invite: fromLink ?? invite});
  });
  node('wechat-btn')?.addEventListener('click', wechatLogin);
  node('nickname')?.addEventListener('change', () => saveName(nickname()));
}

async function main() {
  view.api = createApi({});
  wire();
  const input = node('nickname');
  if (input) input.value = readName() ?? '';
  try {
    const health = await view.api.health();
    view.mode = health.mode;
    setText(node('server-line'), `服务状态：${health.ok ? '可用' : '异常'} · 模式 ${health.mode} · 登录方式 ${health.auth}`);
    setHidden(node('wechat-box'), health.auth !== 'wechat');
  } catch {
    setText(node('server-line'), '暂时无法连接服务器，请确认本地服务已启动');
  }
  try {
    const session = await ensureSession(view.api, {name: nickname()});
    view.session = session;
    setText(node('user-line'), `当前身份：${session.user.name}${session.mode ? ` · ${session.mode}` : ''}`);
  } catch (error) {
    handleError(error, '自动登录');
    return;
  }
  const invite = queryParam('invite');
  if (invite) {
    setText(node('status-text'), '检测到邀请链接，正在加入…');
    await joinRoom({invite});
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((error) => handleError(error, '进入大厅'));
  });
}
