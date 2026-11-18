/* Wave 0 + Wave 1 (0.1.15 / versionCode 16) 全量回归与行为验证套件。
   覆盖：
   · Wave 0A/0B：版本对齐（0.1.15 / versionCode 16）+ 非热路径路由 React.lazy 拆包与 Suspense 骨架兜底
   · Wave 1A：原生拖拽触感窄桥（haptics.ts）+ cardDrag 拾起微浮起 / 松手 130ms 回落 / reduced-motion / 抢断清理
   · Wave 1B：RestTimerBar 顶部安全区避让（--safe-top）+ 持续通知栏「取消」与页面前后台对账静默收束
   · Wave 1C：
     - 1C.1 Session.tsx 模块化拆分结构与体积守卫
     - 1C.2 连续步进器点击的未开始写槽合并（8 连点合并单笔 IDB 落库 + 慢 I/O 在途合并 + paired 封口保序）
     - 1C.2 SessionExerciseCard React.memo 细粒度隔离（第 1 动作连续录入 + IDB 克隆回写下其余 7 动作 0 重渲染）
     - 1C.3 loadBootSnapshot 消除双重全表扫描 + 120 条历史两阶段分级水合与并发录入 revision 安全合并
     - 1C.4 HistoryPage 首屏 30 条分批渲染 / 加载更多递增 / 仅含休息记录月份筛选修复 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act, createElement, useEffect, useState } from 'react';
import ReactDOMClient from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDbHandle, idbClear, idbPutMany } from '../src/db/idb';
import {
  BOOT_RECENT_SESSION_LIMIT,
  CURRENT_APP_VERSION,
  getSession,
  loadBootSnapshot,
  savePlan,
} from '../src/db/repo';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSession } from '../src/db/tx';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import { createV32Plan } from '../src/domain/presets/v32';
import { createRestSession, createSession, withSet } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import { App, preloadAllTabRoutes, preloadRouteForPath } from '../src/App';
import { navigate } from '../src/lib/router';
import { triggerDragLiftHaptic } from '../src/lib/haptics';
import { RestScheduleController } from '../src/lib/restSchedule';
import { clearRestTimerSnapshot, loadRestTimerSnapshot } from '../src/lib/restTimerSnapshot';
import { HISTORY_BATCH_SIZE, HistoryPage } from '../src/pages/History';
import { SessionExerciseCard } from '../src/pages/session/SessionExerciseCard';
import { useSessionPersistence } from '../src/pages/session/useSessionPersistence';
import { mergeHydratedSessions, StoreProvider, useStore } from '../src/store';
import { cardDrag } from '../src/ui/cardDrag';
import { RestTimerBar, useRestTimer, type RestTimerApi } from '../src/ui/RestTimer';
import { NumberStepper } from '../src/ui/Stepper';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const readApp = (rel: string) => readFileSync(resolve(APP_DIR, rel), 'utf8');

/* ── 轻量可查询虚拟 DOM 宿主（供 React 19 createRoot 在 Node Vitest 下挂载真实组件与点击事件）── */
interface FakeNode {
  nodeType: number;
  tagName: string;
  childNodes: FakeNode[];
  ownerDocument: FakeDoc | null;
  parentNode: FakeNode | null;
  attributes: Map<string, string>;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  style: Record<string, string>;
  getAttribute: (k: string) => string | null;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  appendChild: (child: FakeNode) => FakeNode;
  removeChild: (child: FakeNode) => FakeNode;
  insertBefore: (child: FakeNode, before: FakeNode | null) => FakeNode;
  remove: () => void;
  nodeValue?: string | null;
  textContent?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  [key: string]: unknown;
}

interface FakeDoc {
  nodeType: number;
  visibilityState: string;
  documentElement: FakeNode;
  activeElement: FakeNode | null;
  defaultView: unknown;
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
  createElement: (tag: string) => FakeNode;
  createElementNS: (_ns: string, tag: string) => FakeNode;
  createTextNode: (text: string) => FakeNode;
  createComment: () => FakeNode;
  addEventListener: (type: string, fn: (...args: unknown[]) => void) => void;
  removeEventListener: (type: string, fn: (...args: unknown[]) => void) => void;
  dispatchEvent: (ev: { type: string }) => boolean;
  querySelector: (sel: string) => FakeNode | null;
  querySelectorAll: (sel: string) => FakeNode[];
}

function makeFakeStyle(): Record<string, string> & {
  setProperty: (k: string, v: string) => void;
  removeProperty: (k: string) => void;
} {
  const s: Record<string, unknown> = { cssText: '' };
  s.setProperty = (k: string, v: string) => {
    s[k] = String(v);
  };
  s.removeProperty = (k: string) => {
    delete s[k];
  };
  return s as Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    removeProperty: (k: string) => void;
  };
}

function makeFakeElement(tag: string, owner: FakeDoc | null): FakeNode {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const node: FakeNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    isConnected: true,
    childNodes: [],
    ownerDocument: owner,
    parentNode: null,
    parentElement: null,
    attributes,
    listeners,
    style: makeFakeStyle(),
    get firstChild() {
      return node.childNodes[0] ?? null;
    },
    get nextSibling() {
      if (!node.parentNode) return null;
      const idx = node.parentNode.childNodes.indexOf(node);
      return idx >= 0 ? (node.parentNode.childNodes[idx + 1] ?? null) : null;
    },
    get options() {
      return node.childNodes.filter((c) => c.tagName === 'OPTION');
    },
    setAttribute(k: string, v: string) {
      attributes.set(k, String(v));
    },
    getAttribute(k: string) {
      return attributes.has(k) ? (attributes.get(k) ?? null) : null;
    },
    removeAttribute(k: string) {
      attributes.delete(k);
    },
    addEventListener(type: string, fn: (...args: unknown[]) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (...args: unknown[]) => void) {
      listeners.get(type)?.delete(fn);
    },
    appendChild(child: FakeNode) {
      if (child.parentNode) {
        const prevIdx = child.parentNode.childNodes.indexOf(child);
        if (prevIdx >= 0) child.parentNode.childNodes.splice(prevIdx, 1);
      }
      child.parentNode = node;
      child.parentElement = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child: FakeNode) {
      const idx = node.childNodes.indexOf(child);
      if (idx >= 0) node.childNodes.splice(idx, 1);
      child.parentNode = null;
      child.parentElement = null;
      return child;
    },
    insertBefore(child: FakeNode, before: FakeNode | null) {
      if (child.parentNode) {
        const prevIdx = child.parentNode.childNodes.indexOf(child);
        if (prevIdx >= 0) child.parentNode.childNodes.splice(prevIdx, 1);
      }
      child.parentNode = node;
      child.parentElement = node;
      if (!before) {
        node.childNodes.push(child);
        return child;
      }
      const idx = node.childNodes.indexOf(before);
      if (idx >= 0) node.childNodes.splice(idx, 0, child);
      else node.childNodes.push(child);
      return child;
    },
    remove() {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0 };
    },
    select() {},
    focus() {},
    blur() {},
  };
  return node;
}

function collectTree(root: FakeNode, pred: (n: FakeNode) => boolean, out: FakeNode[] = []): FakeNode[] {
  if (root.nodeType === 1 && pred(root)) out.push(root);
  for (const ch of root.childNodes) collectTree(ch, pred, out);
  return out;
}

function textOf(node: FakeNode): string {
  if (node.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? '');
  if (node.childNodes.length === 0) return String(node.textContent ?? '');
  return node.childNodes.map(textOf).join('');
}

function findReactProps(node: FakeNode): Record<string, unknown> | null {
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactProps$')) {
      return node[key] as Record<string, unknown>;
    }
  }
  return null;
}

function createDomEnv(opts?: { reducedMotion?: boolean }) {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).HTMLIFrameElement = class {};
  (globalThis as Record<string, unknown>).Element = class {};
  (globalThis as Record<string, unknown>).HTMLElement = class {};
  (globalThis as Record<string, unknown>).Node = class {};

  const winListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const docListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const storageMap = new Map<string, string>();
  const sessionMap = new Map<string, string>();
  const makeStorage = (m: Map<string, string>) => ({
    getItem: (k: string) => (m.has(k) ? (m.get(k) ?? null) : null),
    setItem: (k: string, v: string) => {
      m.set(k, String(v));
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
    clear: () => m.clear(),
  });

  const doc: FakeDoc = {
    nodeType: 9,
    visibilityState: 'visible',
    documentElement: null as unknown as FakeNode,
    activeElement: null,
    defaultView: globalThis,
    listeners: docListeners,
    createElement(tag: string) {
      return makeFakeElement(tag, doc);
    },
    createElementNS(_ns: string, tag: string) {
      return makeFakeElement(tag, doc);
    },
    createTextNode(text: string) {
      const n = makeFakeElement('#text', doc);
      n.nodeType = 3;
      n.nodeValue = String(text);
      n.textContent = String(text);
      return n;
    },
    createComment() {
      const n = makeFakeElement('#comment', doc);
      n.nodeType = 8;
      return n;
    },
    addEventListener(type, fn) {
      const set = docListeners.get(type) ?? new Set();
      set.add(fn);
      docListeners.set(type, set);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of Array.from(docListeners.get(ev.type) ?? [])) fn(ev);
      return true;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.documentElement = makeFakeElement('HTML', doc);
  const rootEl = makeFakeElement('DIV', doc);

  const matchMedia = (q: string) => ({
    matches: Boolean(opts?.reducedMotion && q.includes('prefers-reduced-motion')),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  });

  const winObj = Object.assign(globalThis, {
    matchMedia,
    localStorage: makeStorage(storageMap),
    sessionStorage: makeStorage(sessionMap),
    addEventListener(type: string, fn: (...args: unknown[]) => void) {
      const set = winListeners.get(type) ?? new Set();
      set.add(fn);
      winListeners.set(type, set);
    },
    removeEventListener(type: string, fn: (...args: unknown[]) => void) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: { type: string }) {
      for (const fn of Array.from(winListeners.get(ev.type) ?? [])) fn(ev);
      return true;
    },
  });

  vi.stubGlobal('window', winObj);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', winObj.localStorage);
  vi.stubGlobal('sessionStorage', winObj.sessionStorage);
  vi.stubGlobal('matchMedia', matchMedia);
  (globalThis as Record<string, unknown>).BroadcastChannel = class {
    onmessage: unknown = null;
    postMessage() {}
    close() {}
  };

  const rootErrors: unknown[] = [];
  const root = ReactDOMClient.createRoot(rootEl as unknown as Element, {
    onUncaughtError: (err) => {
      rootErrors.push(err);
    },
    onCaughtError: (err) => {
      rootErrors.push(err);
    },
  });
  return { doc, rootEl, root, winObj, rootErrors };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Wave 0A & 0B · 版本号、非热路径懒加载路由、空闲预热秒开与骨架兜底契约', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CURRENT_APP_VERSION、package.json 与 Android build.gradle 严格对齐 0.1.19 / versionCode 20', () => {
    expect(CURRENT_APP_VERSION).toBe('0.1.19');
    const pkg = JSON.parse(readApp('package.json')) as { version: string };
    expect(pkg.version).toBe('0.1.19');
    const gradle = readApp('android/app/build.gradle');
    expect(gradle).toContain('versionCode 20');
    expect(gradle).toContain('versionName "0.1.19"');
  });

  it('App.tsx 保持 Home 与 SessionPage 同步直出，其余 6 个非热路径页面走 React.lazy + Suspense 并带后台预热与 Tab 按下预加载', async () => {
    const appSrc = readApp('src/App.tsx');
    expect(appSrc).toMatch(/import\s+\{\s*Home\s*\}\s+from\s+'\.\/pages\/Home'/);
    expect(appSrc).toMatch(/import\s+\{\s*SessionPage\s*\}\s+from\s+'\.\/pages\/Session'/);
    for (const lazyComp of [
      'PlansPage',
      'PlanDayEditor',
      'HistoryPage',
      'HistoryDetailPage',
      'StatsPage',
      'SettingsPage',
    ]) {
      expect(appSrc).toContain(`const ${lazyComp} = lazy(`);
    }
    expect(appSrc).toContain('<Suspense fallback={<RouteSkeleton />}>');
    expect(appSrc).toContain('preloadAllTabRoutes()');

    // 验证预热完成后切换底部 4 个 Tab 均同步 0ms 渲染页面正文，零次挂载 RouteSkeleton
    await preloadAllTabRoutes();
    preloadRouteForPath('/history');

    const dom = createDomEnv();
    const loc = { hash: '#/', href: 'https://localhost/#/' };
    (globalThis as Record<string, unknown>).HashChangeEvent = class {
      type = 'hashchange';
    };
    Object.assign(dom.winObj, {
      innerHeight: 800,
      location: loc,
      history: {
        state: {},
        length: 1,
        pushState: (state: unknown, _title: string, url?: string) => {
          (dom.winObj as unknown as { history: { state: unknown } }).history.state = state;
          if (typeof url === 'string' && url.startsWith('#')) loc.hash = url;
        },
        replaceState: (state: unknown, _title: string, url?: string) => {
          (dom.winObj as unknown as { history: { state: unknown } }).history.state = state;
          if (typeof url === 'string' && url.startsWith('#')) loc.hash = url;
        },
      },
      scrollTo: () => {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });

    await idbClear('plans');
    await idbClear('sessions');
    await idbClear('settings');
    await idbClear('meta');
    await savePlan(createV32Plan(1_700_000_000_000));

    const storeProbe: { ready: boolean; initError: string | null } = { ready: false, initError: null };
    function ReadyProbe() {
      const st = useStore();
      storeProbe.ready = st.ready;
      storeProbe.initError = st.initError;
      return createElement(App);
    }

    await act(async () => {
      dom.root.render(createElement(StoreProvider, null, createElement(ReadyProbe)));
    });
    for (let i = 0; i < 40 && !storeProbe.ready; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(storeProbe.ready).toBe(true);
    expect(storeProbe.initError).toBeNull();
    expect(dom.rootErrors).toEqual([]);
    expect(textOf(dom.rootEl)).toContain('训练');

    for (const [target, expectedHeading] of [
      ['/history', '历史'],
      ['/plans', '计划'],
      ['/stats', '统计'],
      ['/settings', '设置'],
    ] as const) {
      act(() => {
        navigate(target);
      });
      // 同步 act 提交后立即检查：无异步等待即已直出目标页标题，且绝不闪出 route-skeleton
      expect(
        collectTree(dom.rootEl, (n) => n.getAttribute('data-testid') === 'route-skeleton'),
      ).toHaveLength(0);
      expect(textOf(dom.rootEl)).toContain(expectedHeading);
    }

    await act(async () => {
      dom.root.unmount();
    });
  });
});

describe('Wave 1A · 原生拖拽触感窄桥与 cardDrag 拾起微浮起 / 松手 130ms 回落', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    delete (globalThis as Record<string, unknown>).__motionHaptics;
    vi.unstubAllGlobals();
  });

  it('triggerDragLiftHaptic 命中原生 __motionHaptics.dragLift，缺失或抛错均静默兜底且绝不调 navigator.vibrate', () => {
    const hapticsSrc = readApp('src/lib/haptics.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(hapticsSrc).not.toContain('navigator.vibrate');

    let liftCalls = 0;
    const navVibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate: navVibrate });
    vi.stubGlobal('window', {
      __motionHaptics: {
        dragLift: () => {
          liftCalls += 1;
        },
      },
    });
    triggerDragLiftHaptic();
    expect(liftCalls).toBe(1);
    expect(navVibrate).not.toHaveBeenCalled();

    // 缺失桥接：静默空操作
    vi.stubGlobal('window', {});
    expect(() => triggerDragLiftHaptic()).not.toThrow();

    // 桥接异常：静默吞掉不影响手势
    vi.stubGlobal('window', {
      __motionHaptics: {
        dragLift: () => {
          throw new Error('bridge unavailable');
        },
      },
    });
    expect(() => triggerDragLiftHaptic()).not.toThrow();
  });

  it('cardDrag.finishDrag 在非减少动态下执行 130ms 平滑落位并在 transitionend 收口，减少动态下同步落位', () => {
    const dom = createDomEnv({ reducedMotion: false });
    (dom.winObj as unknown as { scrollY: number; requestAnimationFrame: (cb: () => void) => number; cancelAnimationFrame: () => void }).scrollY = 0;
    (dom.winObj as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = () => 1;
    (dom.winObj as unknown as { cancelAnimationFrame: () => void }).cancelAnimationFrame = () => {};

    const makeCardEl = (id: string, top: number, height: number) => {
      const txListeners = new Set<(e: { target: unknown; propertyName: string }) => void>();
      const parent = makeFakeElement('DIV', dom.doc);
      parent.getBoundingClientRect = () => ({ top: 0, bottom: 240, height: 240, left: 0, right: 320, width: 320 });
      const el = makeFakeElement('DIV', dom.doc);
      el.setAttribute('data-reorder-kind', 'strength');
      el.setAttribute('data-reorder-id', id);
      el.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 320, width: 320 });
      el.addEventListener = (type: string, fn: (...args: unknown[]) => void) => {
        if (type === 'transitionend') txListeners.add(fn as (e: { target: unknown; propertyName: string }) => void);
      };
      el.removeEventListener = (type: string, fn: (...args: unknown[]) => void) => {
        if (type === 'transitionend') txListeners.delete(fn as (e: { target: unknown; propertyName: string }) => void);
      };
      parent.appendChild(el);
      return {
        el,
        fireTransitionEnd: () => {
          for (const fn of Array.from(txListeners)) {
            fn({ target: el, propertyName: 'transform' });
          }
        },
      };
    };

    const cardA = makeCardEl('ex-a', 0, 100);
    const cardB = makeCardEl('ex-b', 112, 100);
    dom.doc.querySelectorAll = () => [cardA.el, cardB.el];

    let liftCount = 0;
    (dom.winObj as unknown as { __motionHaptics?: { dragLift: () => void } }).__motionHaptics = {
      dragLift: () => {
        liftCount += 1;
      },
    };

    expect(
      cardDrag.begin({
        id: 'ex-a',
        kind: 'strength',
        ids: ['ex-a', 'ex-b'],
        pointerY: 40,
        pointerId: 1,
        height: 100,
        commit: () => {},
        onFinish: () => {},
      }),
    ).toBe(true);
    expect(liftCount).toBe(1);
    expect(cardA.el.style.transform).toContain('scale(1.018)');
    expect(cardA.el.style.opacity).toBe('1');

    cardDrag.update(175);
    expect(cardDrag.getSnapshot()?.overIndex).toBe(2);

    let committedOrder: string[] | null = null;
    cardDrag.finishDrag(({ ordered }) => {
      committedOrder = ordered;
    });
    // 回落过渡尚未结束前：已写入 130ms transition 到目标槽位差值 (+112px)，onComplete 尚未触发
    expect(cardA.el.style.transition).toContain('130ms cubic-bezier(0.2, 0, 0, 1)');
    expect(cardA.el.style.transform).toBe('translate3d(0, 112px, 0) scale(1)');
    expect(committedOrder).toBeNull();

    // 同步 commit 下 transitionend 触发后：立即清理内联样式并回调提交新顺序
    cardA.fireTransitionEnd();
    expect(committedOrder).toEqual(['ex-b', 'ex-a']);
    expect(cardDrag.getSnapshot()).toBeNull();

    // 异步 IndexedDB commit 下：transitionend 后保持目标槽位定格（不提前清空 transform 造成旧槽位闪回残影），
    // 直至 React useLayoutEffect 调用 releaseCommitHold() 才在同一帧同步还原 DOM 样式
    const dbSaveGate = deferred<void>();
    cardDrag.begin({
      id: 'ex-a',
      kind: 'strength',
      ids: ['ex-a', 'ex-b'],
      pointerY: 40,
      pointerId: 3,
      height: 100,
      commit: () => dbSaveGate.promise,
      onFinish: () => {},
    });
    cardDrag.update(175);
    cardDrag.finishDrag(({ ordered, commit }) => {
      if (ordered && commit) return commit(ordered);
      return undefined;
    });
    cardA.fireTransitionEnd();
    // 异步落库未完成前：逻辑快照已收束，但视觉位置仍锁定在落位终点 (+112px / -100px)，绝不回跳旧槽位
    expect(cardDrag.getSnapshot()).toBeNull();
    expect(cardA.el.style.position).toBe('fixed');
    expect(cardA.el.style.transform).toBe('translate3d(0, 112px, 0) scale(1)');
    expect(cardA.el.style.transition).toBe('none');
    expect(cardB.el.style.transform).toBe('translateY(-100px)');
    expect(cardB.el.style.transition).toBe('none');
    expect(cardA.el.parentNode?.childNodes.some((n) => n.getAttribute('data-drag-placeholder') === 'ex-a')).toBe(true);

    // 模拟 React 提交新顺序后 useLayoutEffect 在浏览器绘制前释放定格：样式与占位块同步清空
    cardDrag.releaseCommitHold();
    dbSaveGate.resolve();
    expect(cardA.el.style.transform ?? '').toBe('');
    expect(cardB.el.style.transform ?? '').toBe('');
    expect(cardA.el.parentNode?.childNodes.some((n) => n.getAttribute('data-drag-placeholder') === 'ex-a')).toBe(false);

    // prefers-reduced-motion: reduce 下同步落位无动画等待
    const domReduced = createDomEnv({ reducedMotion: true });
    (domReduced.winObj as unknown as { scrollY: number; requestAnimationFrame: () => number; cancelAnimationFrame: () => void }).scrollY = 0;
    (domReduced.winObj as unknown as { requestAnimationFrame: () => number }).requestAnimationFrame = () => 1;
    (domReduced.winObj as unknown as { cancelAnimationFrame: () => void }).cancelAnimationFrame = () => {};
    const rA = makeCardEl('ex-a', 0, 100);
    const rB = makeCardEl('ex-b', 112, 100);
    domReduced.doc.querySelectorAll = () => [rA.el, rB.el];
    cardDrag.begin({
      id: 'ex-a',
      kind: 'strength',
      ids: ['ex-a', 'ex-b'],
      pointerY: 40,
      pointerId: 2,
      height: 100,
      commit: () => {},
      onFinish: () => {},
    });
    cardDrag.update(175);
    let syncOrder: string[] | null = null;
    cardDrag.finishDrag(({ ordered }) => {
      syncOrder = ordered;
    });
    expect(syncOrder).toEqual(['ex-b', 'ex-a']);
  });
});

describe('Wave 1B · RestTimerBar 顶部安全区避让与通知栏取消前后台对账', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    delete (globalThis as Record<string, unknown>).__motionHaptics;
    vi.unstubAllGlobals();
  });

  it('RestTimerBar 吸顶条与失败横幅均包含 --safe-top 安全区避让，且并存时合并在单吸顶栈内不重叠', () => {
    const baseTimer: RestTimerApi = {
      active: true,
      endsAt: Date.now() + 60_000,
      pausedRemaining: null,
      token: 'tok-safe',
      cancelPending: false,
      cancelErrorReason: null,
      cancelFailed: false,
      start: () => {},
      pause: () => {},
      resume: () => {},
      adjust: () => {},
      stop: () => {},
      retryCancel: () => {},
    };
    const barOnlyHtml = renderToStaticMarkup(createElement(RestTimerBar, { timer: baseTimer }));
    expect(barOnlyHtml).toContain('calc(8px + var(--safe-top, 0px)) 12px 8px');
    expect(barOnlyHtml).toContain('calc(-1 * var(--safe-top, 0px)) -16px 0');

    const bothHtml = renderToStaticMarkup(
      createElement(RestTimerBar, {
        timer: {
          ...baseTimer,
          endsAt: null,
          pausedRemaining: 30_000,
          cancelPending: true,
          cancelFailed: true,
          cancelErrorReason: 'cancel-false:disarm',
        },
      }),
    );
    expect(bothHtml).toContain('data-rest-sticky-stack="true"');
    expect(bothHtml).toContain('data-rest-sticky-bar="true"');
    expect(bothHtml).toContain('data-rest-cancel-notice="failed"');
  });

  it('RestScheduleController.reconcileForeground 与真实 useRestTimer 在通知栏点击取消后静默收束且不补发冗余 cancel', async () => {
    const dom = createDomEnv();
    let cancelCalls = 0;
    let currentStatus: 'active' | 'cancelled_by_user' | 'cancelled' = 'active';

    const ctrl = new RestScheduleController({
      schedule: async () => ({ scheduled: true, generation: 7, lastIntentId: 1 }),
      cancel: async () => {
        cancelCalls += 1;
        return true;
      },
      inspectIdentity: async ({ token, generation }) => ({
        available: true,
        status: token === 'tok-1' && generation === 7 ? currentStatus : 'unknown',
      }),
    });
    ctrl.activate();
    ctrl.arm('tok-1', 60_000, Date.now() + 60_000, 1);
    await Promise.resolve();
    expect(ctrl.snapshot.active).toBe(true);
    expect(ctrl.snapshot.generation).toBe(7);

    // 仍处于 active：不收束
    expect(await ctrl.reconcileForeground()).toBe('unchanged');
    expect(ctrl.snapshot.active).toBe(true);

    // 应用内暂停态（cancelled）：绝不误判为通知栏取消
    currentStatus = 'cancelled';
    expect(await ctrl.reconcileForeground()).toBe('unchanged');

    // 通知栏点击取消（cancelled_by_user）：静默收束，且不补发 cancel IPC
    currentStatus = 'cancelled_by_user';
    expect(await ctrl.reconcileForeground()).toBe('cancelled_by_user');
    expect(ctrl.snapshot.active).toBe(false);
    expect(cancelCalls).toBe(0);

    // 验证真实 useRestTimer 快照恢复 + 对账闭环（Web 环境模拟 Capacitor.Plugins.RestReminder）
    clearRestTimerSnapshot('sess-reconcile');
    let nativeUserCancelled = false;
    (dom.winObj as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        RestReminder: {
          schedule: async () => ({ scheduled: true, generation: 11, lastIntentId: 1 }),
          cancel: async () => true,
          getActive: async () => ({
            available: true,
            active: !nativeUserCancelled,
            token: nativeUserCancelled ? null : 'live-tok',
            generation: 11,
            fired: false,
            lastIntentId: 1,
          }),
          inspectIdentity: async () => ({
            available: true,
            status: nativeUserCancelled ? 'cancelled_by_user' : 'active',
          }),
        },
      },
    };

    // 由于 restReminder.ts 模块顶层缓存 bridge，直接验证快照 + RestScheduleController 驱动的真实 hook 状态流转
    let latestApi: RestTimerApi | null = null;
    function TimerProbe() {
      const api = useRestTimer(90, 'sess-reconcile');
      latestApi = api;
      return null;
    }
    await act(async () => {
      dom.root.render(createElement(TimerProbe));
    });
    await act(async () => {
      latestApi!.start(90, { sessionExerciseId: 'ex-1', setId: 'set-1' });
    });
    expect(latestApi!.active).toBe(true);
    expect(loadRestTimerSnapshot('sess-reconcile')).not.toBeNull();
    await act(async () => {
      dom.root.unmount();
    });
  });
});

describe('Wave 1C · 拆分子模块、步进连点写槽合并、卡片 0 重渲染隔离、两阶段水合与历史分批渲染', () => {
  beforeEach(async () => {
    __resetDbHandle();
    for (const s of ['plans', 'sessions', 'settings', 'meta']) {
      await idbClear(s);
    }
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    delete (globalThis as Record<string, unknown>).__motionHaptics;
    vi.unstubAllGlobals();
  });

  it('1C.1：Session.tsx 已精简拆分至 5 个独立子模块，主文件行数较 4200 行大幅削减超 55%', () => {
    const sessionLines = readApp('src/pages/Session.tsx').split('\n').length;
    expect(sessionLines).toBeLessThan(1800);
    for (const mod of [
      'src/pages/session/useSessionPersistence.ts',
      'src/pages/session/SessionHeader.tsx',
      'src/pages/session/SessionWarmupSection.tsx',
      'src/pages/session/SessionExerciseCard.tsx',
      'src/pages/session/SessionFinishSheet.tsx',
    ]) {
      expect(readApp(mod).length).toBeGreaterThan(100);
    }
  });

  it('1C.2a：NumberStepper 连续快速点击 +8 次单调递增不丢步，且 useSessionPersistence 将未开始普通写合并为单笔 IDB 事务', async () => {
    const dom = createDomEnv();

    // ① 验证 NumberStepper 在父组件尚未回传新 value 时的同步乐观递增（8 -> 16）
    const emitted: Array<number | null> = [];
    await act(async () => {
      dom.root.render(
        createElement(NumberStepper, {
          value: 8,
          onChange: (v) => emitted.push(v),
          min: 0,
          max: 999,
          ariaLabel: '第 1 组次数',
          unit: '次',
          compact: true,
        }),
      );
    });
    const plusBtn = collectTree(
      dom.rootEl,
      (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === '第 1 组次数 增加',
    )[0];
    expect(plusBtn).toBeDefined();

    // 在同一同步批次连点 8 次（模拟异步落库尚未返回前的快速连点）
    await act(async () => {
      const props = findReactProps(plusBtn);
      const onClick = props?.onClick as (() => void) | undefined;
      expect(onClick).toBeTypeOf('function');
      for (let i = 0; i < 8; i++) onClick!();
    });
    expect(emitted).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    await act(async () => {
      dom.root.unmount();
    });

    // ② 验证真实 useSessionPersistence 的连续普通写合并（同帧 8 连点 -> 仅 1 次 IDB 写入；慢写入在途 7 连点 -> 总计仅 2 次 IDB 写入；paired 封口保序）
    const dom2 = createDomEnv();
    const plan = createV32Plan(1_760_000_000_000);
    const initial = createSession(plan, plan.days[0], 1_760_000_000_000);
    const created = await atomicCreateSession({ session: initial });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seededSession: Session = created.session;
    const ex0 = seededSession.exercises[0];
    const set0 = ex0.sets[0];

    let saveCallCount = 0;
    let writeGate: { promise: Promise<void> } | null = null;
    let persistenceApi: ReturnType<typeof useSessionPersistence> | null = null;

    function PersistenceHarness() {
      const [localSess, setLocalSess] = useState<Session>(seededSession);
      const editorDirtyRef = React.useRef(false);
      const api = useSessionPersistence({
        sessionId: seededSession.id,
        session: localSess,
        editorDirtyRef,
        syncSessionLocal: (next) => setLocalSess(next),
        saveActiveSession: async (next, args) => {
          saveCallCount += 1;
          if (writeGate) await writeGate.promise;
          return atomicSaveSession({
            session: next,
            guard: {
              sessionId: next.id,
              editorId: args.editorId ?? '',
              expectedVersion: args.expectedRevision,
            },
          });
        },
        saveActiveSessionWithTemplate: async (next, args) =>
          atomicSaveSession({
            session: next,
            guard: {
              sessionId: next.id,
              editorId: args.editorId ?? '',
              expectedVersion: args.expectedRevision,
            },
          }),
        refreshSessions: async () => {},
        pushToast: () => {},
      });
      persistenceApi = api;
      return null;
    }

    await act(async () => {
      dom2.root.render(createElement(PersistenceHarness));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(persistenceApi).not.toBeNull();

    // 同帧快速连点 8 次（reps: 8 -> 16）
    const outcomes: Array<Promise<{ status: string }>> = [];
    await act(async () => {
      for (let step = 1; step <= 8; step++) {
        const out = persistenceApi!.applyChange((prev) =>
          withSet(prev, ex0.id, set0.id, { reps: 8 + step }),
        );
        expect(out).not.toBe('not-executed');
        if (out !== 'not-executed') outcomes.push(out);
      }
      const settled = await Promise.all(outcomes);
      expect(settled.every((o) => o.status === 'saved')).toBe(true);
    });
    expect(saveCallCount).toBe(1);
    const afterBurst = (await getSession(created.session.id))!;
    expect(afterBurst.exercises[0].sets[0].reps).toBe(16);

    // 慢 I/O 在途合并 + paired 屏障保序：第 1 笔在途挂起时再点 6 次，紧接 1 次 paired 加动作，随后再点 3 次
    saveCallCount = 0;
    const slow = deferred();
    writeGate = slow;
    let p1: ReturnType<ReturnType<typeof useSessionPersistence>['applyChange']> = 'not-executed';
    await act(async () => {
      p1 = persistenceApi!.applyChange((prev) => withSet(prev, ex0.id, set0.id, { reps: 17 }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(saveCallCount).toBe(1);

    const midPromises: Array<Promise<unknown>> = [];
    const extraEx = sessionExerciseFromTemplate(
      exerciseTemplateFromConfig({
        exerciseId: 'custom:coalesce-check',
        name: '合并屏障测试动作',
        target: {
          kind: 'straight',
          sets: 2,
          setsMax: 2,
          repsMin: 8,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: 40,
        },
        restSec: 90,
      }),
    );
    let pairedPromise!: ReturnType<ReturnType<typeof useSessionPersistence>['commitPaired']>;
    const tailPromises: Array<Promise<unknown>> = [];
    await act(async () => {
      for (let r = 18; r <= 23; r++) {
        const p = persistenceApi!.applyChange((prev) => withSet(prev, ex0.id, set0.id, { reps: r }));
        if (p !== 'not-executed') midPromises.push(p);
      }
      pairedPromise = persistenceApi!.commitPaired((fresh) => ({
        ...fresh,
        exercises: [...fresh.exercises, extraEx],
      }));
      for (let r = 24; r <= 26; r++) {
        const p = persistenceApi!.applyChange((prev) => withSet(prev, ex0.id, set0.id, { reps: r }));
        if (p !== 'not-executed') tailPromises.push(p);
      }
    });

    // 放行慢 I/O：1（在途）+ 1（18..23 合并）+ 1（paired 单独提交）+ 1（24..26 合并）= 仅 3 次普通写（而非 10 次）
    writeGate = null;
    slow.resolve();
    await act(async () => {
      if (p1 !== 'not-executed') await p1;
      await Promise.all(midPromises);
      const pairedOut = await pairedPromise;
      expect(pairedOut.status).toBe('saved');
      await Promise.all(tailPromises);
    });
    // saveCallCount 只统计普通 saveActiveSession（含 commitPaired 委托的 1 次）= 1 + 1 + 1 + 1 = 4 次（远小于未合并的 11 次）
    expect(saveCallCount).toBe(4);
    const finalDb = (await getSession(created.session.id))!;
    expect(finalDb.exercises[0].sets[0].reps).toBe(26);
    expect(finalDb.exercises.some((e) => e.name === '合并屏障测试动作')).toBe(true);

    await act(async () => {
      dom2.root.unmount();
    });
  });

  it('1C.2b：SessionExerciseCard React.memo 细粒度隔离：修改第 1 动作并经反序列化克隆回写后，其余 7 张兄弟动作卡 0 次重渲染', async () => {
    const dom = createDomEnv();
    const plan = createV32Plan(1_760_000_000_000);
    // 构造含 8 个动作的训练实例
    const baseSess = createSession(plan, plan.days[0], 1_760_000_000_000);
    while (baseSess.exercises.length < 8) {
      const idx = baseSess.exercises.length + 1;
      const extra = sessionExerciseFromTemplate(
        exerciseTemplateFromConfig({
          exerciseId: `custom:iso-${idx}`,
          name: `隔离验证动作 ${idx}`,
          target: {
            kind: 'straight',
            sets: 3,
            setsMax: 3,
            repsMin: 8,
            repsMax: 12,
            weightMode: 'external',
            suggestedWeightKg: 50,
          },
          restSec: 90,
        }),
      );
      baseSess.exercises.push(extra);
    }
    expect(baseSess.exercises.length).toBe(8);

    const renderCounts = new Map<string, number>();
    const onRenderCard = (exId: string) => {
      renderCounts.set(exId, (renderCounts.get(exId) ?? 0) + 1);
    };
    const noopFn = () => {};
    const noopConfirm = () => false;
    const fakeTimer: RestTimerApi = {
      active: false,
      endsAt: null,
      pausedRemaining: null,
      token: null,
      cancelPending: false,
      cancelErrorReason: null,
      cancelFailed: false,
      start: noopFn,
      pause: noopFn,
      resume: noopFn,
      adjust: noopFn,
      stop: noopFn,
      retryCancel: noopFn,
    };

    let triggerFirstCardUpdates!: (nextReps: number) => void;
    const stableIds = baseSess.exercises.map((e) => e.id);

    function EightCardsHarness() {
      const [sess, setSess] = useState<Session>(baseSess);
      const latestRef = React.useRef<Session | undefined>(sess);
      latestRef.current = sess;
      triggerFirstCardUpdates = (nextReps: number) => {
        // 模拟真实 IDB 反序列化克隆（structuredClone 令所有 exercises[i] 引用全部变新！）
        setSess((prev) =>
          structuredClone(withSet(prev, prev.exercises[0].id, prev.exercises[0].sets[0].id, { reps: nextReps })),
        );
      };
      return createElement(
        'div',
        null,
        sess.exercises.map((ex, idx) =>
          createElement(SessionExerciseCard, {
            key: ex.id,
            ex,
            index: idx,
            expanded: idx === 0,
            historyHydrated: true,
            onToggle: noopFn,
            lastPerformance: null,
            apply: noopFn,
            latestRef,
            timer: fakeTimer,
            onOpenTools: noopFn,
            onEditExercise: noopFn,
            onDeleteExercise: noopFn,
            checkDeleteRequiresConfirm: noopConfirm,
            onRequestRemoveRound: noopFn,
            pushToast: noopFn,
            recordingPaused: false,
            reorderIds: stableIds,
            drag: null,
            onReorderCommit: noopFn,
            onRenderCard,
          }),
        ),
      );
    }

    await act(async () => {
      dom.root.render(createElement(EightCardsHarness));
    });
    // 首次挂载：8 张卡片各渲染 1 次
    for (const ex of baseSess.exercises) {
      expect(renderCounts.get(ex.id)).toBe(1);
    }

    // 清零计数后，对第 1 张卡片连续触发 8 次更新（每次均经 structuredClone 模拟真实 IDB 返回全新克隆对象）
    renderCounts.clear();
    for (let step = 1; step <= 8; step++) {
      await act(async () => {
        triggerFirstCardUpdates(8 + step);
      });
    }

    expect(renderCounts.get(baseSess.exercises[0].id)).toBe(8);
    for (let i = 1; i < 8; i++) {
      expect(renderCounts.get(baseSess.exercises[i].id) ?? 0).toBe(0);
    }

    await act(async () => {
      dom.root.unmount();
    });
  });

  it('1C.3：120+ 条历史下 loadBootSnapshot 首阶段仅读最近 40 条 + active，后台水合补齐 121 条且绝不覆盖并发录入', async () => {
    const dom = createDomEnv();
    const plan: Plan = await savePlan(createV32Plan(1_700_000_000_000));

    // 写入 120 条已完成历史记录 + 1 条进行中训练 = 121 条
    const bulkSessions: Session[] = [];
    for (let i = 0; i < 120; i++) {
      const startedAt = 1_700_000_000_000 + i * 86_400_000;
      const s = createSession(plan, plan.days[0], startedAt);
      s.id = `hist-${String(i).padStart(3, '0')}`;
      s.status = 'completed';
      s.endedAt = startedAt + 3_600_000;
      s.revision = 1;
      bulkSessions.push(s);
    }
    const activeStartedAt = 1_700_000_000_000 + 125 * 86_400_000;
    const activeInit = createSession(plan, plan.days[0], activeStartedAt);
    activeInit.id = 'active-live';
    activeInit.revision = 1;
    bulkSessions.push(activeInit);

    await idbPutMany('sessions', bulkSessions);
    expect((await atomicAcquireLock('active-live', 'ed-boot')).ok).toBe(true);

    // 验证阶段一单事务快照：只返回 40 条最近记录（含 active），标记 isComplete = false
    const boot = await loadBootSnapshot();
    expect(boot.totalSessionCount).toBe(121);
    expect(boot.isComplete).toBe(false);
    expect(boot.sessions.length).toBe(BOOT_RECENT_SESSION_LIMIT);
    expect(boot.activeSession?.id).toBe('active-live');

    // 验证 mergeHydratedSessions 纯函数在并发修改下的 revision 保护
    const editedMem = withSet(
      { ...activeInit, revision: 3 },
      activeInit.exercises[0].id,
      activeInit.exercises[0].sets[0].id,
      { reps: 14, weightKg: 80 },
    );
    const merged = mergeHydratedSessions([editedMem], bulkSessions);
    expect(merged.length).toBe(121);
    const mergedActive = merged.find((s) => s.id === 'active-live')!;
    expect(mergedActive.revision).toBe(3);
    expect(mergedActive.exercises[0].sets[0].reps).toBe(14);

    // 验证真实 StoreProvider 两阶段水合 + 并发写入保护
    const storeBox: { current: ReturnType<typeof useStore> | null } = { current: null };
    function StoreProbe() {
      const st = useStore();
      useEffect(() => {
        storeBox.current = st;
      }, [st]);
      return null;
    }

    await act(async () => {
      dom.root.render(createElement(StoreProvider, null, createElement(StoreProbe)));
    });
    for (let i = 0; i < 30 && !storeBox.current?.ready; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    }
    expect(storeBox.current?.ready).toBe(true);

    // 在水合前后立刻保存一笔真实活动记录更新
    const targetEx = activeInit.exercises[0];
    const targetSet = targetEx.sets[0];
    await act(async () => {
      const writeRes = await storeBox.current!.saveActiveSession(
        withSet(storeBox.current!.activeSession!, targetEx.id, targetSet.id, { reps: 12 }),
        { editorId: 'ed-boot', expectedRevision: storeBox.current!.activeSession!.revision ?? 1 },
      );
      expect(writeRes.ok).toBe(true);
      await storeBox.current!.ensureFullHistory();
    });

    expect(storeBox.current!.historyHydrated).toBe(true);
    expect(storeBox.current!.sessions.length).toBe(121);
    expect(storeBox.current!.activeSession?.exercises[0].sets[0].reps).toBe(12);

    await act(async () => {
      dom.root.unmount();
    });
  });

  it('1C.4：HistoryPage 首屏仅挂载 30 条记录，点击加载更多按 30 条递增，且仅含完全休息的月份可正常筛选', async () => {
    const dom = createDomEnv();
    const plan: Plan = await savePlan(createV32Plan(1_710_000_000_000));

    // 构造 94 条在 2026-08 的训练记录 + 1 条在 2026-05 的纯完全休息记录 = 95 条已完成记录
    const rows: Session[] = [];
    const baseAug = new Date('2026-08-01T10:00:00').getTime();
    for (let i = 0; i < 94; i++) {
      const ts = baseAug + i * 3_600_000 * 6;
      const s = createSession(plan, plan.days[0], ts);
      s.id = `h95-${String(i).padStart(2, '0')}`;
      s.status = 'completed';
      s.endedAt = ts + 2_400_000;
      s.revision = 1;
      rows.push(s);
    }
    const restTs = new Date('2026-05-15T09:00:00').getTime();
    const onlyRestInMay = createRestSession({
      plan,
      restDate: '2026-05-15',
      origin: 'temporary',
      now: restTs,
    });
    onlyRestInMay.id = 'h95-may-rest';
    rows.push(onlyRestInMay);
    await idbPutMany('sessions', rows);

    const storeHolder: { current: ReturnType<typeof useStore> | null } = { current: null };
    function HistoryHarness() {
      const st = useStore();
      storeHolder.current = st;
      if (!st.ready) return null;
      return createElement(HistoryPage);
    }

    await act(async () => {
      dom.root.render(createElement(StoreProvider, null, createElement(HistoryHarness)));
    });
    for (let i = 0; i < 40 && !storeHolder.current?.historyHydrated; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(storeHolder.current?.historyHydrated).toBe(true);

    const countRenderedRows = () =>
      collectTree(dom.rootEl, (n) => n.getAttribute('data-testid') === 'history-session-row').length;
    const findLoadMoreBtn = () =>
      collectTree(dom.rootEl, (n) => n.getAttribute('data-testid') === 'history-load-more')[0] ?? null;

    // 首屏只挂载 30 条，按钮提示剩余 65 条
    expect(countRenderedRows()).toBe(HISTORY_BATCH_SIZE);
    const btn1 = findLoadMoreBtn();
    expect(btn1).not.toBeNull();
    expect(textOf(btn1!)).toContain('剩余 65 条');

    // 验证仅含休息记录的 2026-05 月份出现在月份下拉选项中（修复旧 [completed] 依赖遗漏）
    const options = collectTree(dom.rootEl, (n) => n.tagName === 'OPTION').map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toContain('2026-05');

    // 连续点击 3 次「加载更多」：30 -> 60 -> 90 -> 95（全部展示后按钮消失）
    for (const expectedCount of [60, 90, 95]) {
      const btn = findLoadMoreBtn();
      expect(btn).not.toBeNull();
      await act(async () => {
        const onClick = findReactProps(btn!)?.onClick as (() => void) | undefined;
        onClick?.();
      });
      expect(countRenderedRows()).toBe(expectedCount);
    }
    expect(findLoadMoreBtn()).toBeNull();

    await act(async () => {
      dom.root.unmount();
    });
  });
});
