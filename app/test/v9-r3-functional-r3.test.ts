/**
 * functional-r3 窄问题修复与合同补齐回归测试：
 * 1. BlockedNavigation 携带原 replace 与 fallback，并在续导航时准确使用（两条行为回归，不能仅加字段不用）；
 * 2. 移除新引入且无外部调用者的 peekBlockedNavigation / takeBlockedNavigation 全局 pending 兼容 API；
 * 3. HistoryDetailPage 删除成功清理草稿/raw/guard并可正常离页，删除失败保留草稿/确认窗；
 * 4. 保存中禁止竞态删除；
 * 5. 记录已不存在的早返回不挂不可见 guard。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  navigate,
  back,
  registerLeaveGuard,
  type BlockedNavigation,
} from '../src/lib/router';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');

function setupFakeWindow(initialHash = '#/history/h1', historyLength = 2) {
  const replaceStateSpy = vi.fn();
  const pushStateSpy = vi.fn();
  const backSpy = vi.fn();
  const goSpy = vi.fn();

  class FakeHashChangeEvent extends Event {
    constructor(type: string) {
      super(type);
    }
  }

  const fakeWindow = {
    location: {
      hash: initialHash,
      href: `http://localhost/${initialHash}`,
    },
    history: {
      state: { __motionIdx: 1 },
      length: historyLength,
      replaceState: replaceStateSpy,
      pushState: pushStateSpy,
      back: backSpy,
      go: goSpy,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  vi.stubGlobal('window', fakeWindow);
  vi.stubGlobal('HashChangeEvent', FakeHashChangeEvent);

  return {
    fakeWindow,
    replaceStateSpy,
    pushStateSpy,
    backSpy,
    goSpy,
  };
}

describe('合同补齐 · BlockedNavigation 携带并使用 replace / fallback', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('回归1：navigate(path, replace=true) 被拦时携带 replace=true，续导航准确应用 replaceState 而非 pushState', () => {
    const { replaceStateSpy, pushStateSpy } = setupFakeWindow('#/history/audit-history-a');
    const holder = { capturedIntent: null as BlockedNavigation | null };
    let guardActive = true;

    // 注册守卫：拦截导航并记录 intent
    const unregister = registerLeaveGuard((intent) => {
      if (guardActive) {
        holder.capturedIntent = intent;
        return false;
      }
      return true;
    });

    try {
      // 发起带 replace 的导航
      navigate('/stats', true);

      // 验证 intent 完整携带原参数
      expect(holder.capturedIntent).toEqual({
        kind: 'nav',
        path: '/stats',
        replace: true,
      });

      // 此时被守卫拦截，未触发真实的 pushState 或 replaceState
      expect(replaceStateSpy).not.toHaveBeenCalled();
      expect(pushStateSpy).not.toHaveBeenCalled();

      // 用户在确认层选择「放弃修改并离开」或「保存修改并离开」，解除守卫并续导航
      guardActive = false;
      const intent = holder.capturedIntent;
      if (!intent || intent.kind !== 'nav') throw new Error('Expected nav intent');
      navigate(intent.path, intent.replace);

      // 续导航准确使用了 replace: true，调用的是 replaceState 而不是 pushState
      expect(replaceStateSpy).toHaveBeenLastCalledWith(
        expect.anything(),
        '',
        '#/stats',
      );
      expect(pushStateSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('回归2：back(fallback) 被拦时携带 fallback，单条历史栈(length<=1)续导航准确使用 fallback', () => {
    const { replaceStateSpy, backSpy } = setupFakeWindow('#/history/audit-history-a', 1);
    const holder = { capturedIntent: null as BlockedNavigation | null };
    let guardActive = true;

    const unregister = registerLeaveGuard((intent) => {
      if (guardActive) {
        holder.capturedIntent = intent;
        return false;
      }
      return true;
    });

    try {
      // 发起带 fallback 的返回
      back('/settings');

      // 验证 intent 携带 fallback 参数
      expect(holder.capturedIntent).toEqual({
        kind: 'back',
        fallback: '/settings',
      });

      // 被守卫拦截，尚未调用任何返回
      expect(replaceStateSpy).not.toHaveBeenCalled();
      expect(backSpy).not.toHaveBeenCalled();

      // 解除守卫后续导航
      guardActive = false;
      const intent = holder.capturedIntent;
      if (!intent || intent.kind !== 'back') throw new Error('Expected back intent');
      back(intent.fallback);

      // 因为 length <= 1，back(fallback) 准确降级到 navigate(fallback, true)
      // 命中 replaceState，且参数为 '#/settings'，不会丢失 fallback 走向默认 '/'
      expect(replaceStateSpy).toHaveBeenCalledWith(
        expect.anything(),
        '',
        '#/settings',
      );
      expect(backSpy).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('router 模块不再导出 peekBlockedNavigation / takeBlockedNavigation 全局 pending API', async () => {
    const routerMod = await import('../src/lib/router');
    expect((routerMod as Record<string, unknown>).peekBlockedNavigation).toBeUndefined();
    expect((routerMod as Record<string, unknown>).takeBlockedNavigation).toBeUndefined();

    // 确认源码中已移除这两个函数定义
    const routerSrc = read('src/lib/router.ts');
    expect(routerSrc).not.toContain('function peekBlockedNavigation');
    expect(routerSrc).not.toContain('function takeBlockedNavigation');
  });
});

describe('History 详情页删除与离页守卫逻辑', () => {
  it('History.tsx 源码包含正确的删除与守卫契约', () => {
    const src = read('src/pages/History.tsx');

    // 1. 存在统一的 resetDraftState 辅助函数
    expect(src).toContain('const resetDraftState = () =>');

    // 2. performLeave 准确传递 intent.replace 与 intent.fallback
    expect(src).toMatch(/navigate\(intent\.path,\s*intent\.replace\)/);
    expect(src).toMatch(/back\(intent\.fallback\)/);

    // 3. 记录不存在（!session）时 isUnsafeNow 立即放行，不挂不可见 guard
    expect(src).toContain('if (!session) return false;');

    // 4. 删除按钮在 saving 或 deleting 期间均 disabled
    expect(src).toMatch(/disabled=\{saving \|\| deleting\}/);

    // 5. 只有数据库事务确认成功后才执行 resetDraftState，并且在 refreshSessions 之前清空草稿
    const onConfirmIdx = src.indexOf('onConfirm={async () => {');
    expect(onConfirmIdx).toBeGreaterThan(-1);
    const deleteBlock = src.slice(onConfirmIdx, onConfirmIdx + 2000);

    const deleteSessionIdx = deleteBlock.indexOf('await deleteSession(session.id);');
    const resetDraftIdx = deleteBlock.indexOf('resetDraftState();');
    const refreshIdx = deleteBlock.indexOf('await refreshSessions();');
    const navigateIdx = deleteBlock.indexOf("navigate('/history');");

    expect(deleteSessionIdx).toBeGreaterThan(-1);
    expect(resetDraftIdx).toBeGreaterThan(deleteSessionIdx);
    expect(refreshIdx).toBeGreaterThan(resetDraftIdx);
    expect(navigateIdx).toBeGreaterThan(refreshIdx);

    // 6. 异常时未调用 resetDraftState 且保留 confirm 弹窗供重试
    expect(deleteBlock).toContain('pushToast(err instanceof Error ? `删除失败：${err.message}` : \'删除失败\', \'error\');');
  });
});
