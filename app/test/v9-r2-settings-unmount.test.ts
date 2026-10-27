/* B4-R2 已证缺口 3：Settings 卸载后不得再发 getStatus（真实 005 的等价合同）。

   ── Codex 已证（真实 React + 受控 Capacitor）──────────────────
   nativeShow 之后**同一 tick** 真正 Root.unmount，listener 已 remove、DOM 已空，
   仍发出一次 getStatus（seq 20）。
   根因：`onShow(isStale)` 的 isStale 来自 **LifecycleQueue 自己的代次**，
   而 `coordinator.stop()` 推进的是 **coordinator 的另一个代次**，
   不推进队列、也不撤销已排队的闭包 —— 于是"已排队 onShow + 同 tick 卸载"时
   isStale 仍为 false。

   ── 本文件锁住的合同（最小修法）──────────────────────────────
   Settings 的 effect 自持 alive 守卫：cleanup 先标记失效，
   `onShow` 与在途响应都检查它；**不改共享 LifecycleQueue 的排队语义**
   （Session 的 hidden 动作必须先排空保存）。

   证据边界：用真实 AppLifecycleCoordinator + 真实 LifecycleQueue 源码，
   只把"React 组件的 alive 标记 + 发请求"这段行为按 Settings 的真实结构建模。
   真实 React Root.unmount 的 DOM 时序属未验项（见报告）。 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * vitest 的 node 环境没有 DOM，而真实 AppLifecycleCoordinator 在 start() 里
 * 会注册 document/window 监听。这里注入**最小可用的 DOM 替身**：
 * 只实现 addEventListener/removeEventListener/dispatchEvent 与 visibilityState，
 * 事件语义与浏览器一致（同步派发）。被测代码本身一行未改。
 */
class FakeTarget {
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, cb: (e: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.get(type)?.delete(cb);
  }
  dispatchEvent(e: { type: string }) {
    for (const cb of Array.from(this.listeners.get(e.type) ?? [])) cb(e);
    return true;
  }
  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

function installFakeDom(initialVisibility: 'visible' | 'hidden' = 'visible') {
  const doc = new FakeTarget() as unknown as FakeTarget & { visibilityState: string };
  doc.visibilityState = initialVisibility;
  const win = new FakeTarget();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  return {
    doc,
    win,
    setVisibility(v: 'visible' | 'hidden') {
      doc.visibilityState = v;
      doc.dispatchEvent({ type: 'visibilitychange' });
    },
    cleanup() {
      vi.unstubAllGlobals();
    },
  };
}

import { AppLifecycleCoordinator } from '../src/lib/appLifecycle';

interface CallLog {
  at: number;
  seq: number;
}

/**
 * 按 Settings.tsx 的**真实结构**建模 effect：
 *   · aliveRef（cleanup 先置 false）
 *   · capReqSeq（请求序号）
 *   · coordinator.start({ onShow }) —— onShow 里先查 isStale 再查 alive
 */
function mountSettingsLike(coordinator: AppLifecycleCoordinator) {
  const calls: CallLog[] = [];
  let seq = 0;
  let alive = true;

  const refreshRestCap = async () => {
    const mySeq = ++seq;
    // 模拟真实 getStatus 的异步往返
    await new Promise((r) => setTimeout(r, 5));
    // 只有最新请求且仍存活才落 state（本文件只关心"是否发起调用"）
    return { mySeq, applied: mySeq === seq && alive };
  };

  const stop = coordinator.start({
    onShow: (isStale) => {
      if (isStale()) return; // 队列代次
      if (!alive) return; // B4-R2：本 effect 的 alive 守卫
      calls.push({ at: Date.now(), seq: ++seq });
      void refreshRestCap();
    },
    onHide: () => {},
  });

  return {
    calls,
    /** 真实卸载：先置 alive=false，再 stop（顺序与 Settings 一致） */
    unmount: () => {
      alive = false;
      stop();
    },
    get alive() {
      return alive;
    },
  };
}

describe('B4-R2 · Settings 卸载后不得再发 getStatus', () => {
  let dom: ReturnType<typeof installFakeDom>;

  beforeEach(() => {
    dom = installFakeDom('visible');
  });

  it('原生回前台排入 onShow 后同 tick 卸载 → 不产生新查询', async () => {
    const coordinator = new AppLifecycleCoordinator(true);
    const mounted = mountSettingsLike(coordinator);

    // 真实后台边沿
    dom.setVisibility('hidden');
    await new Promise((r) => setTimeout(r, 20));
    const beforeUnmount = mounted.calls.length;

    // 回前台（排入 onShow）+ **同 tick** 卸载
    dom.setVisibility('visible');
    mounted.unmount();

    await new Promise((r) => setTimeout(r, 80));

    expect(mounted.alive).toBe(false);
    expect(mounted.calls.length).toBe(beforeUnmount);
    dom.cleanup();
  });

  it('卸载后到达的旧响应不得再改 state（seq + alive 双门禁）', async () => {
    const coordinator = new AppLifecycleCoordinator(true);
    let seq = 0;
    let alive = true;
    let appliedCount = 0;

    const refresh = async () => {
      const mySeq = ++seq;
      await new Promise((r) => setTimeout(r, 10));
      if (mySeq === seq && alive) appliedCount += 1;
    };

    const stop = coordinator.start({
      onShow: (isStale) => {
        if (isStale()) return;
        if (!alive) return;
        void refresh();
      },
      onHide: () => {},
    });

    void refresh(); // 在途请求
    alive = false;
    seq += 1; // cleanup 里的 capReqSeq 推进
    stop();
    await new Promise((r) => setTimeout(r, 40));

    expect(appliedCount).toBe(0);
    dom.cleanup();
  });

  it('不卸载时，回前台仍必须真实刷新（守卫不得误伤正常路径）', async () => {
    const coordinator = new AppLifecycleCoordinator(true);
    const mounted = mountSettingsLike(coordinator);

    dom.setVisibility('hidden');
    await new Promise((r) => setTimeout(r, 20));
    const before = mounted.calls.length;

    dom.setVisibility('visible');
    await new Promise((r) => setTimeout(r, 60));

    expect(mounted.calls.length).toBe(before + 1);
    mounted.unmount();
    dom.cleanup();
  });
});
