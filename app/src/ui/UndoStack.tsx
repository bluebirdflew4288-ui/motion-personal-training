/* F08：删除撤销的固定底部堆叠（展示层）。
   ── 需求口径 ─────────────────────────────────────────────────
   · 固定在当前可见屏幕底部、底部导航/安全区**之上**，不随列表滚动，也不在文档流里；
   · 纵向堆叠：**最新删除在最下面**，旧项向上排列；
   · 每条显示 动作名 / 剩余秒数 / 独立撤销按钮，任意有效项都能单独撤销；
   · 最多显示 3 条的高度，更多时在该区域内滚动（可访问全部有效项）；
   · 顶部显示「已撤销N项 · 还可撤销M项」；
   · 每条剩余时间来自**它自己**的截止时间（本组件只负责显示，不改判定）；
   · 本组件不持有撤销权威：过期/落库/合并都在页面与领域层判定。
   本层不新增跨页持久历史（纯渲染当前批）。 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getPaneScopeRoot } from './paneCoords';
import { usePaneRole } from '../coach/FloatingWindowFrame';

export interface UndoStackItem {
  token: string;
  name: string;
  until: number;
}

interface Props {
  /** 顺序即渲染顺序：索引 0 最旧，末尾最新（显示在最下面） */
  items: UndoStackItem[];
  /** 当前批内真正撤销成功的条数（过期/失败不算） */
  undoneCount: number;
  /** 撤销事务进行中：禁用全部撤销按钮，避免重复写入 */
  busy?: boolean;
  onUndo: (token: string) => void;
}

export function UndoStack({ items, undoneCount, busy, onUndo }: Props) {
  const paneRole = usePaneRole();
  const boxRef = useRef<HTMLDivElement>(null);
  /**
   * 倒计时刷新信号（只用于触发重渲染）。
   *
   * FIX1-R1-4：**绝不缓存"现在几点了"**。本组件从训练页挂载起就存在，
   * 若把 now 存进 state 初始值，页面先停留一段时间后新插入的条目会用旧时钟
   * 算剩余时间（实测新删除显示 10 秒，超过真实的 8 秒）。
   * 因此这里每个渲染都读真实时钟，只用一个计数信号按 500ms 触发重绘。
   */
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!items.length) return undefined;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [items.length]);

  /**
   * 普通 toast 原本也贴在底部：撤销堆叠出现时必须把普通提示整体抬起，
   * 否则两层会互相遮挡（U02）。用测量值写 CSS 变量，而不是估一个固定高度。
   */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const scopeRoot = getPaneScopeRoot(el);
    const apply = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      const scaleRaw = Number(scopeRoot.getAttribute('data-pane-scale') ?? '1');
      const scale = Number.isFinite(scaleRaw) && scaleRaw > 0 ? scaleRaw : 1;
      scopeRoot.style.setProperty('--undo-lift', `${Math.ceil(h / scale) + 8}px`);
    };
    apply();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(apply);
      ro.observe(el);
    }
    window.addEventListener('resize', apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', apply);
      scopeRoot.style.removeProperty('--undo-lift');
    };
  }, [items.length, paneRole]);

  if (!items.length) return null;

  const node = (
    <div
      className="undo-stack"
      data-testid="delete-undo-stack"
      role="status"
      aria-live="polite"
      ref={boxRef}
    >
      <div className="undo-stack-head" data-testid="delete-undo-counts">
        已撤销{undoneCount}项 · 还可撤销{items.length}项
      </div>
      <div className="undo-stack-list" data-testid="delete-undo-list">
        {items.map((it) => {
          // 首帧就必须准确：每条按**自己**的截止时间取剩余秒数，且不超过 8 秒
          const left = Math.max(0, Math.min(8, Math.ceil((it.until - Date.now()) / 1000)));
          return (
            <div className="undo-row" key={it.token} data-testid={`delete-undo-row`} data-undo-token={it.token}>
              <span className="undo-row-name" title={it.name}>
                {it.name}
              </span>
              <span className="undo-row-time" data-testid="delete-undo-remaining">
                {left} 秒
              </span>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid={`delete-undo-${it.token}`}
                disabled={Boolean(busy)}
                onClick={() => onUndo(it.token)}
              >
                撤销
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (paneRole === 'primary' && typeof document !== 'undefined') {
    return createPortal(node, document.body);
  }
  return node;
}
