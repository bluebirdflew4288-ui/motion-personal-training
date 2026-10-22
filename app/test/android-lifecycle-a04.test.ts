/* A04 回归：AppLifecycleCoordinator 的异步原生订阅必须服从 start/stop 代次。
   ── 独立审查探针复现的真实缺陷 ────────────────────────────────
   探针把第一个 App.addListener 的 Promise 挂起，start() 后立刻 stop()，
   再放行那个 Promise。旧实现的结果：
     registered: ["appStateChange","pause","resume"]
     removed: []                 ← 一个都没移除
     callbacksAfterStop: ["hide"]← 已停止实例仍被原生 pause 驱动
   根因：start() 里 fire-and-forget 地 await addListener，await 之后
   从不复核“我还该不该注册”。

   本文件用**生产模块** src/lib/appLifecycle.ts 验证：
     · stop 发生在第一个 await 中间 → 一个监听都不留、事件不触发
     · stop 发生在第二个 await 中间 → 已拿到的逐个移除
     · stop 后重新 start → 新代次正常工作，旧代次的回调无效
     · 正常 stop（无挂起）→ 全部移除 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLifecycleCoordinator } from '../src/lib/appLifecycle';

/** 可控的假 @capacitor/app：能精确挂起第 N 个 addListener */
function makeAppMock(opts?: { delayIndex?: number }) {
  const registered: Array<{ event: string; cb: (s?: { isActive?: boolean }) => void; removed: boolean }> = [];
  const removalLog: string[] = [];
  let pendingResolvers: Array<() => void> = [];
  let callCount = 0;

  const App = {
    addListener: vi.fn((event: string, cb: (s?: { isActive?: boolean }) => void) => {
      const item = { event, cb, removed: false };
      registered.push(item);
      const handle = {
        remove: async () => {
          item.removed = true;
          removalLog.push(event);
        },
      };
      callCount += 1;
      if (opts?.delayIndex !== undefined && callCount === opts.delayIndex) {
        // 挂起这一个：返回一个尚未 resolve 的 Promise
        return new Promise<typeof handle>((resolve) => {
          pendingResolvers.push(() => resolve(handle));
        });
      }
      return Promise.resolve(handle);
    }),
  };

  return {
    App,
    registered,
    removalLog,
    releasePending: () => {
      const list = pendingResolvers;
      pendingResolvers = [];
      for (const r of list) r();
    },
    hasPending: () => pendingResolvers.length > 0,
  };
}

/** 让出微任务队列，直到条件成立（有界，不无限等） */
async function tickUntil(cond: () => boolean, max = 50): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) {
    await Promise.resolve();
  }
}

function installFakeDom() {
  const listeners = new Map<string, EventListener[]>();
  // 让测试能检查 stop 后 DOM 监听是否真的被移除
  (globalThis as unknown as { __fakeListeners: Map<string, EventListener[]> }).__fakeListeners = listeners;
  const fakeWindow = {
    addEventListener: (t: string, fn: EventListener) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: EventListener) => {
      listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== fn));
    },
  };
  const fakeDocument = {
    activeElement: null,
    visibilityState: 'visible',
    addEventListener: (t: string, fn: EventListener) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: EventListener) => {
      listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== fn));
    },
  };
  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
  return { listeners };
}

describe('A04 生命周期协调者：代次所有权', () => {
  beforeEach(() => {
    installFakeDom();
  });

  /** 直接注入原生插件加载器（生产代码的公开注入点），避免模块 mock 串味 */
  function makeCoordinator(
    mock: ReturnType<typeof makeAppMock>,
    foreground = true,
  ): import('../src/lib/appLifecycle').AppLifecycleCoordinator {
    return new AppLifecycleCoordinator(foreground, {
      isNative: () => true,
      loadNativeApp: async () => mock.App,
    });
  }

  it('stop 落在第一个 addListener 的 await 中间 → 一个监听都不留、事件不触发', async () => {
    const mock = makeAppMock({ delayIndex: 1 });
    const events: string[] = [];
    const c = makeCoordinator(mock);
    c.start({ onHide: () => {
          events.push('hide');
        }, onShow: () => {
          events.push('show');
        } });

    await tickUntil(() => mock.hasPending());
    expect(mock.hasPending()).toBe(true);

    c.stop();
    mock.releasePending();
    await tickUntil(() => true, 20);

    expect(mock.registered.length).toBe(1);
    expect(mock.registered.every((r) => r.removed)).toBe(true);
    expect(mock.removalLog).toContain('appStateChange');

    mock.registered[0].cb({ isActive: false });
    await c.drain();
    expect(events).toEqual([]);
  });

  it('stop 落在第二个 await 中间 → 已拿到的 handle 全部移除，后续不再注册', async () => {
    const mock = makeAppMock({ delayIndex: 2 });
    const events: string[] = [];
    const c = makeCoordinator(mock);
    c.start({ onHide: () => {
          events.push('hide');
        }, onShow: () => {
          events.push('show');
        } });

    await tickUntil(() => mock.hasPending());
    expect(mock.registered.length).toBe(2);

    c.stop();
    mock.releasePending();
    await tickUntil(() => true, 20);

    expect(mock.registered.length).toBe(2);
    expect(mock.registered.every((r) => r.removed)).toBe(true);
    mock.registered[1].cb();
    await c.drain();
    expect(events).toEqual([]);
  });

  it('正常 stop（无挂起）→ 三个监听全部移除', async () => {
    const mock = makeAppMock();
    const c = makeCoordinator(mock);
    c.start({ onHide: () => undefined, onShow: () => undefined });
    await tickUntil(() => mock.registered.length === 3);

    expect(mock.registered.map((r) => r.event)).toEqual(['appStateChange', 'pause', 'resume']);
    c.stop();
    await tickUntil(() => true, 10);
    expect(mock.registered.every((r) => r.removed)).toBe(true);
  });

  it('stop 后重新 start → 新代次生效，旧代次回调无效', async () => {
    const mock = makeAppMock();
    const events: string[] = [];
    const c = makeCoordinator(mock);
    c.start({ onHide: () => {
          events.push('hide-1');
        },
      onShow: () => {
          events.push('show-1');
        }, });
    await tickUntil(() => mock.registered.length === 3);
    const firstGenHandles = [...mock.registered];

    c.stop();
    await tickUntil(() => true, 10);

    c.start({ onHide: () => {
          events.push('hide-2');
        },
      onShow: () => {
          events.push('show-2');
        }, });
    await tickUntil(() => mock.registered.length === 6);
    expect(c.isRunning).toBe(true);

    // 旧代次回调：被调用也不能产生动作
    firstGenHandles[0].cb({ isActive: false });
    await c.drain();
    expect(events).toEqual([]);

    // 新代次回调：正常工作
    const newPause = mock.registered[4];
    expect(newPause.event).toBe('pause');
    newPause.cb();
    await c.drain();
    expect(events).toEqual(['hide-2']);
  });

  it('start/stop 推进代次且 start 幂等（不重复注册）', async () => {
    const mock = makeAppMock();
    const c = makeCoordinator(mock);
    const gen0 = c.currentGeneration;
    c.start({ onHide: () => undefined, onShow: () => undefined });
    const gen1 = c.currentGeneration;
    expect(gen1).toBeGreaterThan(gen0);

    c.start({ onHide: () => undefined, onShow: () => undefined });
    await tickUntil(() => mock.registered.length === 3);
    expect(mock.registered.length).toBe(3);

    c.stop();
    expect(c.currentGeneration).toBeGreaterThan(gen1);
    expect(c.isRunning).toBe(false);
  });

  it('前台/后台去重：原生 pause 与 resume 按边沿触发', async () => {
    const mock = makeAppMock();
    const events: string[] = [];
    const c = makeCoordinator(mock);
    c.start({ onHide: () => {
          events.push('hide');
        }, onShow: () => {
          events.push('show');
        } });
    await tickUntil(() => mock.registered.length === 3);

    mock.registered[1].cb(); // pause
    await c.drain();
    expect(events).toEqual(['hide']);

    mock.registered[1].cb(); // 重复 pause：不应重复
    await c.drain();
    expect(events).toEqual(['hide']);

    mock.registered[2].cb(); // resume
    await c.drain();
    expect(events).toEqual(['hide', 'show']);

    mock.registered[2].cb(); // 重复 resume：不应重复
    await c.drain();
    expect(events).toEqual(['hide', 'show']);
  });

  it('stop 后 DOM 信号也不再驱动已停止的实例', async () => {
    const mock = makeAppMock();
    const events: string[] = [];
    const c = makeCoordinator(mock);
    c.start({ onHide: () => {
          events.push('hide');
        }, onShow: () => {
          events.push('show');
        } });
    await tickUntil(() => mock.registered.length === 3);
    c.stop();

    // stop 已移除 DOM 监听：手动派发也拿不到回调
    const listeners = (globalThis as unknown as { __fakeListeners: Map<string, EventListener[]> }).__fakeListeners;
    const vis = listeners.get('visibilitychange') ?? [];
    expect(vis.length).toBe(0);
    void vis;
    await c.drain();
    expect(events).toEqual([]);
  });
});
