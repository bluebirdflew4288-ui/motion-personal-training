/* A03 回归：页面离开守卫必须**先 await**，导航只能发生一次且必须在其之后。
   ── 独立审查给出的真实缺陷顺序 ────────────────────────────────
   main.tsx 曾把 pageFallback → back('/') 注册进 backStack，
   而 handleBackIntent 是先 backStack.consume()、再 await leaveGuard。
   于是探针观察到的顺序是 ["navigate","guard:false"] —— 守卫说 false，
   页面照样已经离开了。probe 结果 action='blocked' 但 pass=false。

   本文件用**生产模块**（src/lib/nativeBack.ts + src/lib/backIntent.ts）
   在 fake DOM 上直接验证：
     · 有层 → 只关层，不导航
     · 无层有键盘焦点 → 只收键盘，不导航
     · 守卫 pending 期间 → 导航次数仍为 0
     · 守卫返回 false → 导航次数 0，结果 blocked
     · 守卫抛异常 → 导航次数 0，结果 blocked
     · 守卫返回 true → 导航次数**恰好 1**，结果 page
     · 首页（不可后退）→ 结果 exit，导航次数 0 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backStack } from '../src/lib/backIntent';
import { handleBackIntent, registerPageLeaveGuard } from '../src/lib/nativeBack';

/** 最小 fake DOM：只需要 document / window 的少量接口 */
function installFakeDom(initialHash = '#/session/s1') {
  const listeners = new Map<string, EventListener[]>();
  const navigations: string[] = [];

  const fakeWindow = {
    location: { hash: initialHash },
    history: {
      back: vi.fn(() => {
        navigations.push('back');
      }),
      length: 2,
    },
    addEventListener: (type: string, fn: EventListener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };

  const fakeDocument = {
    activeElement: null as unknown,
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('document', fakeDocument);
  return { fakeWindow, navigations };
}

describe('A03 原生返回：守卫必须先于导航', () => {
  beforeEach(() => {
    backStack.__resetForTest();
    registerPageLeaveGuard(null);
  });

  it('栈顶有弹层时只关弹层，不导航', async () => {
    const { navigations } = installFakeDom();
    const close = vi.fn();
    backStack.push({ id: 'sheet:1', handle: close });

    const r = await handleBackIntent();
    expect(r.action).toBe('layer');
    expect(close).toHaveBeenCalledTimes(1);
    expect(navigations.length).toBe(0);
  });

  it('栈空但有输入框焦点时只收键盘，不导航', async () => {
    const { fakeWindow, navigations } = installFakeDom();
    const blur = vi.fn();
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = {
      tagName: 'INPUT',
      isContentEditable: false,
      blur,
    };

    const r = await handleBackIntent();
    expect(r.action).toBe('keyboard');
    expect(blur).toHaveBeenCalledTimes(1);
    expect(navigations.length).toBe(0);
    void fakeWindow;
  });

  it('守卫 pending 期间导航次数保持 0', async () => {
    const { navigations } = installFakeDom();
    let release: (v: boolean) => void = () => undefined;
    registerPageLeaveGuard(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );

    const pending = handleBackIntent();
    // 让出若干微任务：若实现里存在“先导航后守卫”，这里就会观察到导航
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigations.length).toBe(0);

    release(true);
    const r = await pending;
    expect(r.action).toBe('page');
    expect(navigations.length).toBe(1);
  });

  it('守卫返回 false → 不导航，结果为 blocked', async () => {
    const { navigations } = installFakeDom();
    const guard = vi.fn(() => false);
    registerPageLeaveGuard(guard);

    const r = await handleBackIntent();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(r.action).toBe('blocked');
    expect(navigations.length).toBe(0);
  });

  it('守卫抛异常 → 不导航，结果为 blocked（不放行）', async () => {
    const { navigations } = installFakeDom();
    registerPageLeaveGuard(() => {
      throw new Error('storage exploded');
    });

    const r = await handleBackIntent();
    expect(r.action).toBe('blocked');
    expect(navigations.length).toBe(0);
  });

  it('守卫返回 true → 导航恰好 1 次，结果为 page', async () => {
    const { navigations } = installFakeDom();
    const guard = vi.fn(async () => true);
    registerPageLeaveGuard(guard);

    const r = await handleBackIntent();
    expect(guard).toHaveBeenCalledTimes(1);
    expect(r.action).toBe('page');
    expect(navigations.length).toBe(1);
  });

  it('已在首页（不可后退）→ 结果为 exit，导航次数 0', async () => {
    const { navigations } = installFakeDom('#/');
    const r = await handleBackIntent();
    expect(r.action).toBe('exit');
    expect(navigations.length).toBe(0);
  });

  it('多层弹层叠放时一次返回只关最上面一层（pop 由组件 effect 清理负责）', async () => {
    installFakeDom();
    const bottom = vi.fn();
    const top = vi.fn();
    backStack.push({ id: 'sheet:bottom', handle: bottom });
    // 记录每层被 push 时拿到的 pop 函数，模拟 React effect 清理
    let popTop: () => void = () => undefined;
    const pushTop = backStack.push({ id: 'sheet:top', handle: top });
    popTop = pushTop;

    const r1 = await handleBackIntent();
    expect(r1.action).toBe('layer');
    expect(top).toHaveBeenCalledTimes(1);
    expect(bottom).toHaveBeenCalledTimes(0);
    // 返回键只负责调用 handler；层从栈里移除由该弹层的 effect 清理完成
    expect(backStack.depth).toBe(2);
    popTop();
    expect(backStack.depth).toBe(1);

    const r2 = await handleBackIntent();
    expect(r2.action).toBe('layer');
    expect(bottom).toHaveBeenCalledTimes(1);
    expect(top).toHaveBeenCalledTimes(1);
  });

  /**
   * 最上层 handler 显式返回 false → 表示“这一层不消费”。
   * 约定：此时返回 'none'（本模块把该层视为放行），页面返回交给守卫与调用方，
   * 而不是“继续调用下一层的 handler” —— 一次返回最多关闭一个可见层。
   */
  it('最上层 handler 显式返回 false 时不强关下一层，也不自行导航', async () => {
    const { navigations } = installFakeDom();
    const bottom = vi.fn();
    backStack.push({ id: 'sheet:bottom', handle: bottom });
    backStack.push({ id: 'sheet:passthrough', handle: () => false });

    const r = await handleBackIntent();
    expect(r.action).toBe('page'); // 无守卫、可后退 → 页面返回
    expect(bottom).toHaveBeenCalledTimes(0); // 没有顺手关掉下层
    expect(navigations.length).toBe(1);
  });
});

describe('A07 单一历史条目：非首页也必须真的离开', () => {
  beforeEach(() => {
    backStack.__resetForTest();
    registerPageLeaveGuard(null);
  });

  it('history.length=1 时不再空 back()，而是安全替换回首页一次', async () => {
    const { fakeWindow } = installFakeDom('#/session/solo');
    fakeWindow.history.length = 1;
    const backFn = vi.fn();
    const replaceFn = vi.fn((_a: unknown, _b: unknown, url?: string) => {
      if (typeof url === 'string') fakeWindow.location.hash = url;
    });
    fakeWindow.history.back = backFn;
    (fakeWindow.history as unknown as { replaceState: typeof replaceFn }).replaceState = replaceFn;

    // 需要 HashChangeEvent 存在（node 没有）→ 提供一个最小实现
    vi.stubGlobal('HashChangeEvent', class {}) as unknown;
    const dispatch = vi.fn(() => true);
    (fakeWindow as unknown as { dispatchEvent: typeof dispatch }).dispatchEvent = dispatch;

    const r = await handleBackIntent();
    expect(r.action).toBe('page');
    expect(backFn).toHaveBeenCalledTimes(0); // 不能发那次空操作
    expect(replaceFn).toHaveBeenCalledTimes(1); // 恰好一次替换
    expect(fakeWindow.location.hash).toBe('#/');
    expect(dispatch).toHaveBeenCalledTimes(1); // 触发 hashchange 让路由重渲染
  });

  it('history.length>1 时仍然用 back()，不做替换', async () => {
    const { fakeWindow } = installFakeDom('#/session/two');
    fakeWindow.history.length = 3;
    const backFn = vi.fn();
    const replaceFn = vi.fn();
    fakeWindow.history.back = backFn;
    (fakeWindow.history as unknown as { replaceState: typeof replaceFn }).replaceState = replaceFn;

    const r = await handleBackIntent();
    expect(r.action).toBe('page');
    expect(backFn).toHaveBeenCalledTimes(1);
    expect(replaceFn).toHaveBeenCalledTimes(0);
  });

  it('单一历史条目 + 守卫 false → 不替换、不 back（导航仍为 0）', async () => {
    const { fakeWindow } = installFakeDom('#/session/solo');
    fakeWindow.history.length = 1;
    const backFn = vi.fn();
    const replaceFn = vi.fn();
    fakeWindow.history.back = backFn;
    (fakeWindow.history as unknown as { replaceState: typeof replaceFn }).replaceState = replaceFn;
    registerPageLeaveGuard(() => false);

    const r = await handleBackIntent();
    expect(r.action).toBe('blocked');
    expect(backFn).toHaveBeenCalledTimes(0);
    expect(replaceFn).toHaveBeenCalledTimes(0);
  });

  it('首页即使在单一历史条目下也返回 exit（交给原生退出）', async () => {
    const { fakeWindow } = installFakeDom('#/');
    fakeWindow.history.length = 1;
    const replaceFn = vi.fn();
    (fakeWindow.history as unknown as { replaceState: typeof replaceFn }).replaceState = replaceFn;

    const r = await handleBackIntent();
    expect(r.action).toBe('exit');
    expect(replaceFn).toHaveBeenCalledTimes(0);
  });
});

describe('A03 回归·顺序不变量（决定性断言）', () => {
  beforeEach(() => {
    backStack.__resetForTest();
    registerPageLeaveGuard(null);
  });

  it('执行顺序必须是 guard 先、navigate 后', async () => {
    const { navigations } = installFakeDom();
    const order: string[] = [];
    registerPageLeaveGuard(() => {
      order.push('guard');
      return true;
    });
    // history.back 打进顺序日志
    const w = globalThis as unknown as { window: { history: { back: () => void } } };
    w.window.history.back = () => {
      order.push('navigate');
      navigations.push('back');
    };

    await handleBackIntent();
    expect(order).toEqual(['guard', 'navigate']);
    expect(navigations.length).toBe(1);
  });

  it('守卫 false 时顺序里根本不应出现 navigate', async () => {
    const { navigations } = installFakeDom();
    const order: string[] = [];
    registerPageLeaveGuard(() => {
      order.push('guard');
      return false;
    });
    const w = globalThis as unknown as { window: { history: { back: () => void } } };
    w.window.history.back = () => {
      order.push('navigate');
      navigations.push('back');
    };

    const r = await handleBackIntent();
    expect(r.action).toBe('blocked');
    expect(order).toEqual(['guard']);
    expect(order.includes('navigate')).toBe(false);
    expect(navigations.length).toBe(0);
  });
});
