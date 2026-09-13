/**
 * 小程序测试装载器。
 * 小程序文件是 CommonJS 且带 Page/App/wx 全局，不能当作 ESM 导入，
 * 因此读取源码后用 node:vm 在当前 realm 中执行，注入假的
 * {wx, require, module, exports, getApp, Page, Component, App} 与定时器。
 * 在当前 realm 执行可保证对象原型一致，deepStrictEqual 与 instanceof 可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

export const WECHAT_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export interface RecordedRequest {
  url: string;
  method: string;
  data: unknown;
  header: Record<string, string>;
  timeout?: number;
}

export interface WxRequestOptions {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
  success?: (res: {statusCode: number; data: unknown}) => void;
  fail?: (err: unknown) => void;
}

export interface FakeSocketTask {
  url: string;
  sent: string[];
  closed: boolean;
  onOpen(cb: () => void): void;
  onMessage(cb: (res: {data: string}) => void): void;
  onError(cb: (err: unknown) => void): void;
  /** 与真实 wx API 一致：onClose 回调收到 {code, reason}。 */
  onClose(cb: (res?: {code?: number; reason?: string}) => void): void;
  send(message: {data: string}): void;
  close(options?: {code?: number}): void;
  emitOpen(): void;
  emitMessage(data: string): void;
  emitError(err: unknown): void;
  /** 不传 code 就模拟没有关闭码的断线（例如网络中断）。 */
  emitClose(code?: number, reason?: string): void;
}

export interface FakeAudioOscillator {
  type: string;
  frequency: {value: number};
  startedAt: number | null;
  stoppedAt: number | null;
  start(at: number): void;
  stop(at: number): void;
  /** 与小程序真实实现一致：不返回目标节点，所以生产代码不能写成链式 connect。 */
  connect(node: unknown): void;
}

export interface FakeAudioGain {
  gain: {
    value: number;
    setValueAtTime(value: number, at: number): void;
    linearRampToValueAtTime(value: number, at: number): void;
    exponentialRampToValueAtTime(value: number, at: number): void;
  };
  connect(node: unknown): void;
}

export interface FakeAudioContext {
  currentTime: number;
  state: string;
  destination: {name: string};
  resumes: number;
  oscillators: FakeAudioOscillator[];
  gains: FakeAudioGain[];
  resume(): Promise<void>;
  createOscillator(): FakeAudioOscillator;
  createGain(): FakeAudioGain;
}

export interface WxMock {
  requests: RecordedRequest[];
  sockets: FakeSocketTask[];
  storage: Map<string, unknown>;
  clipboard: string[];
  navigations: string[];
  randomCalls: number;
  randomLengths: number[];
  loginCalls: number;
  audioContexts: FakeAudioContext[];
  request(options: WxRequestOptions): void;
  connectSocket(options: {url: string}): FakeSocketTask;
  createWebAudioContext(): FakeAudioContext;
  getRandomValues(options: {
    length: number;
    success?: (res: {randomValues: ArrayBuffer}) => void;
    fail?: (err: unknown) => void;
  }): void;
  login(options: {success?: (res: {code: string}) => void; fail?: (err: unknown) => void}): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, value: unknown): void;
  removeStorageSync(key: string): void;
  setClipboardData(options: {data: string}): void;
  navigateTo(options: {url: string}): void;
  navigateBack(options?: {delta?: number}): void;
  showModal(options: {title?: string; content?: string; success?: (res: {confirm: boolean}) => void}): void;
  showToast(options: {title?: string}): void;
}

/** 假的 WebAudioContext：只记录排了哪些音、什么时候排的，不真的发声。 */
export function createAudioContext(): FakeAudioContext {
  const context: FakeAudioContext = {
    currentTime: 0,
    state: 'running',
    destination: {name: 'destination'},
    resumes: 0,
    oscillators: [],
    gains: [],
    resume() {
      context.resumes += 1;
      return Promise.resolve();
    },
    createOscillator() {
      const oscillator: FakeAudioOscillator = {
        type: '',
        frequency: {value: 0},
        startedAt: null,
        stoppedAt: null,
        start(at) {
          oscillator.startedAt = at;
        },
        stop(at) {
          oscillator.stoppedAt = at;
        },
        connect() {
          // 小程序真实实现不返回目标节点，链式 connect 会当场报错，这里刻意保持一致。
        }
      };
      context.oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      const gain: FakeAudioGain = {
        gain: {
          value: 1,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {}
        },
        connect() {}
      };
      context.gains.push(gain);
      return gain;
    }
  };
  return context;
}

export interface WxOptions {
  /** 返回 undefined 时使用默认 200 + {}。 */
  respond?: (request: RecordedRequest, index: number) => {statusCode: number; data: unknown} | undefined;
  random?: 'ok' | 'fail' | 'missing';
  randomBytes?: number[];
  login?: 'ok' | 'fail' | 'missing';
  loginCode?: string;
  /** 默认 ok（基础库 2.19+ 有 Web Audio）；missing 模拟老基础库，属性本身不存在。 */
  audio?: 'ok' | 'missing';
}

/** 可控时钟：测试驱动心跳与重连，不依赖真实定时器。 */
export interface FakeTimers {
  setTimeout(fn: () => void, ms?: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms?: number): number;
  clearInterval(id: number): void;
  tick(ms: number): void;
  pending(): number;
}

export function createTimers(): FakeTimers {
  let now = 0;
  let nextId = 1;
  const timers: {id: number; at: number; ms: number; fn: () => void; repeat: boolean}[] = [];

  function remove(id: number): void {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }

  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.push({id, at: now + (ms ?? 0), ms: ms ?? 0, fn, repeat: false});
      return id;
    },
    clearTimeout(id) {
      remove(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      const step = ms && ms > 0 ? ms : 1;
      timers.push({id, at: now + step, ms: step, fn, repeat: true});
      return id;
    },
    clearInterval(id) {
      remove(id);
    },
    tick(ms) {
      now += ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        let due: (typeof timers)[number] | null = null;
        for (const timer of timers) {
          if (timer.at > now) continue;
          if (due === null || timer.at < due.at) due = timer;
        }
        if (due === null) break;
        if (due.repeat) due.at = now + due.ms;
        else remove(due.id);
        due.fn();
      }
    },
    pending() {
      return timers.length;
    }
  };
}

export function createWx(options: WxOptions = {}): WxMock {
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocketTask[] = [];
  const storage = new Map<string, unknown>();
  const clipboard: string[] = [];
  const navigations: string[] = [];
  const audioContexts: FakeAudioContext[] = [];
  const randomBytes = options.randomBytes ?? Array.from({length: 32}, (_value, index) => index);
  const randomMode = options.random ?? 'ok';
  const loginMode = options.login ?? 'ok';
  const audioMode = options.audio ?? 'ok';

  const wx: WxMock = {
    requests,
    sockets,
    storage,
    clipboard,
    navigations,
    randomCalls: 0,
    randomLengths: [],
    loginCalls: 0,
    audioContexts,

    request(requestOptions) {
      const record: RecordedRequest = {
        url: requestOptions.url,
        method: requestOptions.method ?? 'GET',
        data: requestOptions.data,
        header: requestOptions.header ?? {},
        timeout: requestOptions.timeout
      };
      requests.push(record);
      const produced = options.respond
        ? options.respond(record, requests.length - 1)
        : {statusCode: 200, data: {}};
      const response = produced ?? {statusCode: 200, data: {}};
      if (requestOptions.success) requestOptions.success(response);
    },

    connectSocket(socketOptions) {
      const handlers: {
        open?: () => void;
        message?: (res: {data: string}) => void;
        error?: (err: unknown) => void;
        close?: (res?: {code?: number; reason?: string}) => void;
      } = {};
      const task: FakeSocketTask = {
        url: socketOptions.url,
        sent: [],
        closed: false,
        onOpen(cb) {
          handlers.open = cb;
        },
        onMessage(cb) {
          handlers.message = cb;
        },
        onError(cb) {
          handlers.error = cb;
        },
        onClose(cb) {
          handlers.close = cb;
        },
        send(message) {
          task.sent.push(message.data);
        },
        close(closeOptions) {
          task.closed = true;
          const code = closeOptions && typeof closeOptions.code === 'number' ? closeOptions.code : 1000;
          if (handlers.close) handlers.close({code, reason: ''});
        },
        emitOpen() {
          if (handlers.open) handlers.open();
        },
        emitMessage(data) {
          if (handlers.message) handlers.message({data});
        },
        emitError(err) {
          if (handlers.error) handlers.error(err);
        },
        emitClose(code, reason) {
          if (handlers.close) handlers.close({code, reason});
        }
      };
      sockets.push(task);
      return task;
    },

    createWebAudioContext() {
      const context = createAudioContext();
      audioContexts.push(context);
      return context;
    },

    getRandomValues(randomOptions) {
      wx.randomCalls += 1;
      wx.randomLengths.push(randomOptions.length);
      if (randomMode === 'fail') {
        if (randomOptions.fail) randomOptions.fail({errMsg: 'getRandomValues:fail'});
        return;
      }
      const length = randomOptions.length;
      const buffer = new ArrayBuffer(length);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < length; i += 1) view[i] = randomBytes[i % randomBytes.length] & 0xff;
      if (randomOptions.success) randomOptions.success({randomValues: buffer});
    },

    login(loginOptions) {
      wx.loginCalls += 1;
      if (loginMode === 'fail') {
        if (loginOptions.fail) loginOptions.fail({errMsg: 'login:fail'});
        return;
      }
      if (loginOptions.success) loginOptions.success({code: options.loginCode ?? 'CODE_FROM_WX_LOGIN'});
    },

    getStorageSync(key) {
      return storage.has(key) ? storage.get(key) : '';
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    setClipboardData(clipboardOptions) {
      clipboard.push(clipboardOptions.data);
    },
    navigateTo(navigateOptions) {
      navigations.push(navigateOptions.url);
    },
    navigateBack() {},
    showModal(modalOptions) {
      if (modalOptions.success) modalOptions.success({confirm: true});
    },
    showToast() {}
  };
  // 模拟不支持该能力的基础库：属性本身不存在，而不是调用时报错。
  if (randomMode === 'missing') delete (wx as Partial<WxMock>).getRandomValues;
  if (loginMode === 'missing') delete (wx as Partial<WxMock>).login;
  if (audioMode === 'missing') delete (wx as Partial<WxMock>).createWebAudioContext;
  return wx;
}

export interface LoaderResult {
  load(specifier: string): unknown;
  pages: Map<string, Record<string, unknown>>;
  app: Record<string, unknown> | null;
  required: string[];
}

export interface LoaderOptions {
  wx?: unknown;
  timers?: FakeTimers;
}

const PARAMS = [
  'exports',
  'require',
  'module',
  '__filename',
  '__dirname',
  'wx',
  'getApp',
  'Page',
  'Component',
  'App',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'console'
];

/** 只解析小程序的相对路径模块；没有 node_modules 解析，也没有构建步骤。 */
function resolveSpecifier(fromDir: string, specifier: string): string {
  const base = path.resolve(fromDir, specifier);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`模块不存在: ${specifier}（相对 ${fromDir}）`);
}

export function createLoader(options: LoaderOptions = {}): LoaderResult {
  const timers = options.timers ?? createTimers();
  const wx = options.wx ?? createWx();
  const cache = new Map<string, {exports: unknown}>();
  const pages = new Map<string, Record<string, unknown>>();
  const required: string[] = [];
  let app: Record<string, unknown> | null = null;
  let currentFile = '';

  function loadModule(file: string): {exports: unknown} {
    const cached = cache.get(file);
    if (cached) return cached;
    const source = fs.readFileSync(file, 'utf8');
    const module = {exports: {} as unknown};
    cache.set(file, module);
    const dir = path.dirname(file);
    const localRequire = (specifier: string): unknown => {
      const target = resolveSpecifier(dir, specifier);
      required.push(path.relative(WECHAT_ROOT, target));
      return loadModule(target).exports;
    };
    const previous = currentFile;
    currentFile = file;
    const compiled = vm.compileFunction(source, PARAMS, {filename: file}) as unknown as (
      ...args: unknown[]
    ) => unknown;
    compiled(
      module.exports,
      localRequire,
      module,
      file,
      dir,
      wx,
      () => app ?? {},
      (pageOptions: Record<string, unknown>) => {
        pages.set(path.relative(WECHAT_ROOT, currentFile), pageOptions);
      },
      () => {},
      (appOptions: Record<string, unknown>) => {
        app = appOptions;
      },
      timers.setTimeout,
      timers.clearTimeout,
      timers.setInterval,
      timers.clearInterval,
      console
    );
    currentFile = previous;
    return module;
  }

  return {
    load(specifier) {
      return loadModule(resolveSpecifier(WECHAT_ROOT, specifier)).exports;
    },
    pages,
    get app() {
      return app;
    },
    required
  };
}

export interface PageContext {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  [key: string]: unknown;
}

/** 用注册的页面对象伪造页面上下文，使 this.setData 与页面方法可用。 */
export function createPageContext(loader: LoaderResult, name: string): PageContext {
  let options = loader.pages.get(name);
  if (!options) {
    loader.load(name);
    options = loader.pages.get(name);
  }
  if (!options) throw new Error(`页面未注册: ${name}`);
  const context = {
    data: {...((options.data as Record<string, unknown> | undefined) ?? {})}
  } as PageContext;
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'function') context[key] = value;
  }
  context.setData = (patch: Record<string, unknown>) => {
    // 与小程序一致：浅合并进 this.data。
    Object.assign(context.data, patch);
  };
  return context;
}

/** 调用页面方法，this 绑定到页面上下文。 */
export function invoke(context: PageContext, method: string, ...args: unknown[]): unknown {
  const fn = context[method];
  if (typeof fn !== 'function') throw new Error(`页面缺少方法: ${method}`);
  return (fn as (...rest: unknown[]) => unknown).call(context, ...args);
}

/** 递归收集目录下的文件（按扩展名过滤）。 */
export function walk(dir: string, extension: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full, extension));
    else if (entry.name.endsWith(extension)) result.push(full);
  }
  return result.sort();
}

export function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function relative(file: string): string {
  return path.relative(WECHAT_ROOT, file);
}
