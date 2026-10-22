/* 原生返回键接线（Capacitor App 的 backButton 事件）+ 统一的「返回意图」调度。
   ── 优先级（施工要求 C）──────────────────────────────────────
     1. 最上层弹层 / 确认框 / 页面内弹层 → 只关这一个
     2. 输入框聚焦中 → 收键盘
     3. 页面离开守卫（训练页：排空保存队列 / 处理待存草稿）→ 放行才继续
     4. 页面返回（hash 路由 history.back / 兜底路径）
     5. 首页无路可退 → exitApp

   ── A03 修正（导航必须发生在守卫之后，且只有一次）─────────────
   旧实现把「页面级兜底导航」塞进了 backStack 的栈空分支，
   而 handleBackIntent 是先消费栈、后 await 守卫 —— 真实顺序变成
   [navigate, guard:false]，守卫返回 false 也拦不住离开。
   现在严格分成三段：
     ① consumeLayerOnly()：只关层/收键盘，**永不导航**
     ② await leaveGuard：false / 抛异常 → 直接返回 blocked，**一次导航都不发**
     ③ goBackOnce()：守卫放行后才执行，且整个调用里只有这一处导航
   LC08 相关：慢提交时守卫会等待保存队列排空；守卫期间不允许卸载页面，
   因此不会出现“旧页面释放新页面锁”或“pending 只留在已销毁组件里”。 */

import { backStack } from './backIntent';
import { isNativePlatform } from './platform';

type LeaveGuard = () => boolean | Promise<boolean>;

let leaveGuard: LeaveGuard | null = null;
let installed = false;
let removeListener: (() => void) | null = null;

/** 页面级离开守卫（当前挂载的页面注册，卸载时清空） */
export function registerPageLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard;
}

/** 当前是否有页面守卫（诊断/测试） */
export function hasPageLeaveGuard(): boolean {
  return leaveGuard !== null;
}

/** 当前是否处在「非首页」（首页在 Android 上应退出而不是继续返回） */
export function canNavigateBack(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash.replace(/^#/, '');
  const path = hash.split('?')[0] || '/';
  return path !== '/' && path !== '';
}

/**
 * 是否存在**应用内**的上一页记录。
 *
 * A07：`history.length > 1` 才说明确实有上一条记录可退。
 * 直接把训练页当唯一入口打开（通知点开、深链、`#/session/x` 手输）时
 * history.length === 1，此时 `history.back()` 是**空操作**，
 * 旧实现却照样报 “page”，用户看到的是“按了没反应”。
 */
export function hasPreviousEntry(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.history.length > 1;
  } catch {
    return false;
  }
}

/**
 * 用**一次**安全替换回到首页（A07 的兜底）。
 *
 * 没有上一条记录时不能用 back()：那是一次空操作。
 * 这里采用 replaceState + 手动派发 hashchange，与 router.navigate(path, true)
 * 完全同构 —— 不新增历史条目，页面正常重渲染。
 */
function replaceToHomeOnce(): void {
  if (typeof window === 'undefined') return;
  const target = '#/';
  try {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  } catch {
    /* 某些环境没有 HashChangeEvent / replaceState 受限 → 退回直接改 hash */
  }
  window.location.hash = target;
}

/** 一次「返回」的最终结果 */
export type BackOutcome =
  | { action: 'layer' }
  | { action: 'keyboard' }
  | { action: 'blocked' }
  | { action: 'page' }
  | { action: 'exit' };

/**
 * 处理一次返回意图（原生返回键与页面内「返回」按钮共用同一条路径）。
 *
 * @param opts.handleLayer 是否允许本次返回关闭最上层弹层（默认允许）
 */
export async function handleBackIntent(opts?: { handleLayer?: boolean }): Promise<BackOutcome> {
  // ① 层 / 键盘：只做这两件事，绝不导航
  if (opts?.handleLayer !== false) {
    const consumed = backStack.consumeLayerOnly();
    if (consumed === 'layer') return { action: 'layer' };
    if (consumed === 'keyboard') return { action: 'keyboard' };
  }

  // ② 页面离开守卫：必须先 await，且 false/异常一律不放行
  if (leaveGuard) {
    let allowed = false;
    try {
      allowed = await leaveGuard();
    } catch {
      allowed = false;
    }
    if (!allowed) return { action: 'blocked' };
  }

  // ③ 守卫放行后才导航 —— 整个函数里唯一的导航点
  if (!canNavigateBack()) return { action: 'exit' };

  if (hasPreviousEntry()) {
    window.history.back();
    return { action: 'page' };
  }

  // A07：非首页但没有任何应用内上一页 → 用一次安全替换回首页，而不是空 back()
  replaceToHomeOnce();
  return { action: 'page' };
}

/**
 * 安装原生返回键监听。浏览器里调用是**安全无副作用**的
 * （没有 Capacitor App 插件就跳过，系统默认行为接管）。
 */
export function installNativeBackHandler(): void {
  if (installed) return;
  installed = true;
  if (!isNativePlatform()) return;

  void (async () => {
    try {
      const { App } = await import('@capacitor/app');
      const handle = await App.addListener('backButton', () => {
        void (async () => {
          const r = await handleBackIntent();
          if (r.action === 'exit') {
            // 首页无路可退：按 Android 预期退出，而不是停在空白页
            try {
              await App.exitApp();
            } catch {
              /* 退出失败就停在这里，不静默改行为 */
            }
          }
        })();
      });
      removeListener = () => void handle.remove();
    } catch {
      /* 没有 App 插件：用系统默认返回行为 */
    }
  })();
}

/** 卸载监听（测试/热更新清理用） */
export function uninstallNativeBackHandler(): void {
  removeListener?.();
  removeListener = null;
  installed = false;
}
