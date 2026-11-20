/* 底部弹层。
   ── Android 返回键（V8-C）：每个打开的弹层向全局返回栈登记自己 ──
   打开时 backStack.push({id, handle})，关闭时由 effect 清理函数 pop。
   原生返回键只调用**栈顶那一个** handler，因此：
     · 多层弹层叠在一起时，一次返回只关最上层；
     · 不会向 document 广播 Escape（那会同时关掉所有层）。
   Escape 键仍保留原来的行为（桌面浏览器可用），但它与返回键走的是两套入口：
   Escape 是键盘事件，返回键是原生 backButton → backStack。

   ── 焦点策略（修复 R2-01 弹层抢焦点）──────────────────────────
   1. 初始焦点：只在「关闭 → 打开」这一次设置，用 ref 记录上一次的 open。
      父组件每秒重渲染、输入变化、计时刷新都不会重新聚焦面板。
   2. Escape：用最新的 onClose（存在 ref 里），但作为独立 effect 只依赖 open，
      不使用旧闭包，也不因为 onClose 身份变化而重跑焦点逻辑。
   3. 关闭后把焦点还给触发按钮（打开时记录 document.activeElement）。
   4. IME：不干扰 composition。弹层自身不聚焦 input，也不在任何渲染里改输入值。
   5. 禁止 body 滚动，避免 iOS 键盘弹出时页面跳动。 */

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { backStack } from '../lib/backIntent';
import { getPaneScrollContext } from './paneCoords';
import { usePaneRole } from '../coach/FloatingWindowFrame';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 打开时是否把焦点放到面板（含输入框的弹层建议设为 false，让用户自己点输入） */
  autoFocusPanel?: boolean;
}

export function Sheet({ open, title, onClose, children, footer, autoFocusPanel = true }: Props) {
  const paneRole = usePaneRole();
  const panelRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  /** 稳定的层标识：同一弹层重渲染不会在返回栈里堆同名项 */
  const layerId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // onClose 存 ref：Escape 永远调用最新的回调，但不会让焦点 effect 重跑
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 焦点：只在 关闭→打开 的边沿执行一次
  useEffect(() => {
    if (open && !wasOpen.current) {
      wasOpen.current = true;
      const active = document.activeElement;
      returnFocusRef.current = active instanceof HTMLElement ? active : null;

      const scrollEl = getPaneScrollContext(panelRef.current).scrollEl;
      const scrollHost = scrollEl ?? document.body;
      const prevOverflow = scrollHost.style.overflow;
      scrollHost.style.overflow = 'hidden';

      if (autoFocusPanel) {
        // 面板用 programmatic focus，不加 tabindex 到可聚焦输入
        requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
      }
      return () => {
        scrollHost.style.overflow = prevOverflow;
        wasOpen.current = false;
        // 关闭后把焦点还给触发元素；若该元素已不在文档中（列表重渲染），
        // 退回到弹层容器前的可聚焦元素，避免焦点掉回 body。
        const target = returnFocusRef.current;
        requestAnimationFrame(() => {
          if (target && document.contains(target) && !(target as HTMLButtonElement).disabled) {
            target.focus({ preventScroll: true });
            if (document.activeElement === target) return;
          }
          // 兜底：让焦点离开即将卸载的输入框
          const active = document.activeElement;
          if (active instanceof HTMLElement && active.closest('[role=dialog]')) {
            active.blur();
          }
        });
      };
    }
    return undefined;
  }, [open, autoFocusPanel]);

  /**
   * Android 原生返回键：把自己登记为「可关闭的最上层」。
   * 只随 open 挂载/卸载，回调永远读最新的 onClose（closeRef）。
   */
  useEffect(() => {
    if (!open) return undefined;
    return backStack.push({ id: `sheet:${layerId}`, handle: () => closeRef.current() });
  }, [open, layerId]);

  /**
   * Escape：独立 effect，只随 open 变化挂载/卸载。
   *
   * G2A（R5）：嵌套弹层时**只有最上层**处理 Esc。
   * 旧实现每个 open 实例都在 document 上监听，`stopPropagation()` 无法阻止
   * 同一 document 上的其他监听器 → 一次 Esc 会同时关闭编辑器、名称选择器
   * 与离开确认层。现在以返回栈栈顶为准：非栈顶层忽略 Esc，
   * 一次只关一层；返回键（nativeBack）本来就走 backStack 栈顶，语义一致。
   */
  useEffect(() => {
    if (!open) return undefined;
    const selfId = `sheet:${layerId}`;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (backStack.topId !== selfId) return;
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, layerId]);

  if (!open) return null;

  const node = (
    <div className="sheet-backdrop" onClick={() => closeRef.current()} role="presentation">
      <div
        className="sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // 面板本身可聚焦（供读屏定位），但只有在 autoFocusPanel 时才会主动聚焦一次
        tabIndex={-1}
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grab" aria-hidden="true" />
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          {/* v0.1.1：标题可能含长名称（计划名/动作名），必须能换行不撑宽 */}
          <h2 className="slip-title" style={{ fontSize: 18, overflowWrap: 'anywhere', minWidth: 0 }}>
            {title}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={() => closeRef.current()} aria-label="关闭">
            关闭
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
        {footer ? <div style={{ marginTop: 16 }}>{footer}</div> : null}
      </div>
    </div>
  );

  // 主屏态挂到 body 根层叠上下文，防止被 .app-shell(z-index:1) 压在悬浮小窗(z-index:55)下方；
  // 小窗态留在所属 .pane-scaled-stage 内，保持弹层归属隔离。
  if (paneRole === 'primary' && typeof document !== 'undefined') {
    return createPortal(node, document.body);
  }
  return node;
}
