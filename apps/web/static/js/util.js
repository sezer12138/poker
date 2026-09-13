// 通用工具。约束：模块顶层不得访问 window/document/localStorage/navigator，
// 所有浏览器 API 只能在函数体内使用，Node 才能直接 import 本文件做单元测试。

export const TOKEN_KEY = 'poker_token';
export const NAME_KEY = 'poker_name';
export const FAIR_KEY_PREFIX = 'poker_fair';

export function bytesToHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 请求标识必须是新 UUID：幂等重试复用同一个 id，不同命令绝不复用。 */
export function newRequestId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  // 不使用非密码学随机数兜底：请求标识必须来自密码学随机源。
  throw new Error('当前环境缺少安全随机数，无法生成请求标识');
}

export function readGlobal(name) {
  return typeof globalThis === 'undefined' ? undefined : globalThis[name];
}

export function storage(storageImpl) {
  if (storageImpl) return storageImpl;
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function storageGet(key, fallback = null, storageImpl) {
  const store = storage(storageImpl);
  if (!store) return fallback;
  try {
    const value = store.getItem(key);
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

export function storageSet(key, value, storageImpl) {
  const store = storage(storageImpl);
  if (!store) return false;
  try {
    store.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key, storageImpl) {
  const store = storage(storageImpl);
  if (!store) return false;
  try {
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function requireDocument() {
  if (typeof document === 'undefined') throw new Error('该函数只能在浏览器中调用');
  return document;
}

export function qs(selector, root) {
  const scope = root ?? (typeof document === 'undefined' ? null : document);
  return scope ? scope.querySelector(selector) : null;
}

export function qsa(selector, root) {
  const scope = root ?? (typeof document === 'undefined' ? null : document);
  return scope ? Array.from(scope.querySelectorAll(selector)) : [];
}

/**
 * 创建元素：属性用 props 传，文本一律走 textContent，避免任何 HTML 注入路径。
 * props.on 为事件映射；props.dataset 写入 data-*；props.attrs 写入普通属性。
 */
export function el(tag, props = {}, children = []) {
  const doc = requireDocument();
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'dataset') for (const [k, v] of Object.entries(value)) node.dataset[k] = String(v);
    else if (key === 'on') for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
    else if (key === 'attrs') for (const [k, v] of Object.entries(value)) node.setAttribute(k, String(v));
    else if (key in node) node[key] = value;
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export function clear(node) {
  if (!node) return node;
  node.textContent = '';
  return node;
}

/** 用新节点替换容器内容；null/undefined 子项被忽略。 */
export function render(node, children) {
  if (!node) return node;
  clear(node);
  append(node, children);
  return node;
}

export function setText(node, value) {
  if (node) node.textContent = value === null || value === undefined ? '' : String(value);
  return node;
}

export function setHidden(node, hidden) {
  if (!node) return node;
  node.hidden = Boolean(hidden);
  return node;
}

export function setDisabled(node, disabled) {
  if (!node) return node;
  node.disabled = Boolean(disabled);
  return node;
}

export function toggleClass(node, name, on) {
  if (!node) return node;
  node.classList.toggle(name, Boolean(on));
  return node;
}

export function on(node, type, handler, options) {
  if (!node) return () => {};
  node.addEventListener(type, handler, options);
  return () => node.removeEventListener(type, handler, options);
}

/** 读取查询参数；页面全部通过这里取 id/invite，避免散落的 URLSearchParams 访问。 */
export function queryParam(name, search) {
  const raw = search ?? (typeof location === 'undefined' ? '' : location.search);
  return new URLSearchParams(raw ?? '').get(name);
}

export function navigate(url) {
  if (typeof location !== 'undefined') location.assign(url);
}

/** 相对链接构造：页面可被服务端挂在任意前缀下，因此链接保持相对。 */
export function pageUrl(page, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix === '' ? page : `${page}?${suffix}`;
}

export function absoluteUrl(url) {
  if (typeof location === 'undefined') return url;
  try {
    return new URL(url, location.href).href;
  } catch {
    return url;
  }
}
