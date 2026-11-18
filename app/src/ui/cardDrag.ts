/* G3B / G03 / G04：训练页卡片拖动、单张左滑展开与页面级手势取消的**唯一**协调器。
   ── 单一 owner ────────────────────────────────────────────────
   · 整个页面只有一份拖动状态、一个 RAF 和一套全局触摸/失焦/多指守卫；
   · 拖动期间的非被动 touchmove 平移阻止（panGuard）由本协调器统一挂载与释放，
     杜绝多卡重复监听或异常路径泄漏；
   · 自动滚动只在指针靠近上/下边缘时启动，离开边缘、松手、取消、blur、
     visibilitychange、卸载都立刻停；
   · 松手时返回最终 ID 顺序，由调用方在**最新 Session** 上做一次受约束保存。 */

import { useSyncExternalStore } from 'react';
import { SWIPE_SETTLE_MS, TAKEOVER_GUARD_MS, autoScrollVelocity, dropIndexFor, orderAfterDrop } from './cardGestures';
import { installSelectionGuard } from './selectionGuard';
import { triggerDragLiftHaptic } from '../lib/haptics';

const DROP_SETTLE_MS = 130;
const DROP_SETTLE_TIMEOUT_MS = 160;
const DROP_SETTLE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const LIFT_SCALE = 1.018;

function isReducedMotionPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export type ReorderKind = 'strength' | 'cardio';

export interface CardDragSnapshot {
  id: string;
  kind: ReorderKind;
  ids: string[];
  fromIndex: number;
  /** 插入位置（0..ids.length，原数组语义） */
  overIndex: number;
  offsetY: number;
  height: number;
}

type Commit = (orderedIds: string[]) => void | Promise<unknown>;

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as PromiseLike<unknown>).then === 'function'
  );
}

const ZONE_ATTR = 'data-reorder-kind';
const ID_ATTR = 'data-reorder-id';

/* ── 页面级统一手势与多触点守卫 ────────────────────────────────────
   · 任意位置（同卡、异卡、卡外、输入/按钮区）出现第二触点时立即锁存并取消全部手势；
   · 所有活动指针与触摸点全部离开前，剩余手指移动或逐个释放不会复活手势；
   · blur / visibilitychange / pointercancel / touchcancel 统一由此处广播取消，
     不再在每张卡片上重复注册全局监听。 */
const activePointers = new Map<number, string>();
let activeTouchCount = 0;
let multitouchLatched = false;
const gestureCancelListeners = new Set<() => void>();
let guardRefCount = 0;
let removeGestureGuards: (() => void) | null = null;

function clearTouchPointers(): void {
  for (const [id, kind] of activePointers) {
    if (kind === 'touch') activePointers.delete(id);
  }
}

function maybeResetMultitouchLatch(): void {
  if (activePointers.size === 0 && activeTouchCount === 0) {
    multitouchLatched = false;
  }
}

function resetPointerTracking(): void {
  activePointers.clear();
  activeTouchCount = 0;
  multitouchLatched = false;
}

function cancelAllActiveGestures(): void {
  cardOpenStore.cancelPendingOpen();
  cardDrag.cancel();
  for (const fn of [...gestureCancelListeners]) {
    fn();
  }
}

function installGestureGuards(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || removeGestureGuards) return;

  const removeSelectionGuard = installSelectionGuard();

  const onDocPointerDown = (ev: PointerEvent) => {
    cardDrag.flushSettle();
    activePointers.set(ev.pointerId, ev.pointerType || 'unknown');
    if (activePointers.size >= 2) {
      multitouchLatched = true;
      cancelAllActiveGestures();
    }
  };
  const onDocPointerMove = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.buttons === 0 && activePointers.has(ev.pointerId)) {
      activePointers.delete(ev.pointerId);
      maybeResetMultitouchLatch();
    }
  };
  const onDocPointerEnd = (ev: PointerEvent) => {
    activePointers.delete(ev.pointerId);
    maybeResetMultitouchLatch();
  };
  const onDocTouchStartOrMove = (ev: TouchEvent) => {
    activeTouchCount = ev.touches.length;
    if (activeTouchCount >= 2) {
      multitouchLatched = true;
      cancelAllActiveGestures();
    }
  };
  const onDocTouchEndOrCancel = (ev: TouchEvent) => {
    activeTouchCount = ev.touches.length;
    if (activeTouchCount === 0) clearTouchPointers();
    maybeResetMultitouchLatch();
  };
  const onWinPointerCancel = (ev: PointerEvent) => {
    activePointers.delete(ev.pointerId);
    if (!ev.isTrusted) {
      resetPointerTracking();
    } else {
      maybeResetMultitouchLatch();
    }
    cancelAllActiveGestures();
  };
  const onWinTouchCancel = (ev: TouchEvent) => {
    activeTouchCount = ev.touches.length;
    if (activeTouchCount === 0 || !ev.isTrusted) {
      clearTouchPointers();
      activeTouchCount = 0;
    }
    maybeResetMultitouchLatch();
    cancelAllActiveGestures();
  };
  const onWinBlur = () => {
    resetPointerTracking();
    cancelAllActiveGestures();
  };
  const onVisChange = () => {
    if (document.visibilityState !== 'visible') {
      resetPointerTracking();
      cancelAllActiveGestures();
    }
  };

  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('pointermove', onDocPointerMove, true);
  document.addEventListener('pointerup', onDocPointerEnd, true);
  document.addEventListener('pointercancel', onDocPointerEnd, true);
  document.addEventListener('touchstart', onDocTouchStartOrMove, { capture: true, passive: true });
  document.addEventListener('touchmove', onDocTouchStartOrMove, { capture: true, passive: true });
  document.addEventListener('touchend', onDocTouchEndOrCancel, { capture: true, passive: true });
  document.addEventListener('touchcancel', onDocTouchEndOrCancel, { capture: true, passive: true });
  window.addEventListener('pointercancel', onWinPointerCancel);
  window.addEventListener('touchcancel', onWinTouchCancel);
  window.addEventListener('blur', onWinBlur);
  document.addEventListener('visibilitychange', onVisChange);

  removeGestureGuards = () => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('pointermove', onDocPointerMove, true);
    document.removeEventListener('pointerup', onDocPointerEnd, true);
    document.removeEventListener('pointercancel', onDocPointerEnd, true);
    document.removeEventListener('touchstart', onDocTouchStartOrMove, true);
    document.removeEventListener('touchmove', onDocTouchStartOrMove, true);
    document.removeEventListener('touchend', onDocTouchEndOrCancel, true);
    document.removeEventListener('touchcancel', onDocTouchEndOrCancel, true);
    window.removeEventListener('pointercancel', onWinPointerCancel);
    window.removeEventListener('touchcancel', onWinTouchCancel);
    window.removeEventListener('blur', onWinBlur);
    document.removeEventListener('visibilitychange', onVisChange);
    removeSelectionGuard();
  };
}

export function isMultitouchBlocked(): boolean {
  return multitouchLatched || activePointers.size >= 2 || activeTouchCount >= 2;
}

export function registerGestureCancel(fn: () => void): () => void {
  gestureCancelListeners.add(fn);
  guardRefCount += 1;
  if (guardRefCount === 1) installGestureGuards();
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    gestureCancelListeners.delete(fn);
    guardRefCount = Math.max(0, guardRefCount - 1);
    if (guardRefCount === 0) {
      removeGestureGuards?.();
      removeGestureGuards = null;
      resetPointerTracking();
    }
  };
}

class CardDragStore {
  private snap: CardDragSnapshot | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;
  private pointerY = 0;
  private ownerPointerId: number | null = null;
  private commit: Commit | null = null;
  private onFinish: (() => void) | null = null;
  private onCancelCb: (() => void) | null = null;
  private cleanupWindow: (() => void) | null = null;
  private cleanupPanGuard: (() => void) | null = null;
  private elements: HTMLElement[] = [];
  /** 拖动开始时的稳定布局快照（页面坐标，不受邻居 140ms 让位动画干扰） */
  private layouts: Array<{ top: number; height: number }> = [];
  private startPageY = 0;
  private startViewportY = 0;
  private sourceFixedTop = 0;
  private hasMovedSinceLift = false;
  /** 浮起卡改为 position: fixed 脱离文档流，并用等高占位保持原布局与滚动边界稳定 */
  private placeholder: HTMLElement | null = null;
  private sourceEl: HTMLElement | null = null;
  private sourceShadowEl: HTMLElement | null = null;
  private sourceStyle: { cssText: string } | null = null;
  /** 松手 130ms 平滑落位控制器（新触摸可同步 flush，卸载/取消可立即 abort） */
  private settleControl: { flush: () => void; abort: () => void } | null = null;
  /** 异步落库期间保持已落位视觉定格，直到 React useLayoutEffect 同步完成 DOM 重排，消除回弹文字残影 */
  private commitHoldControl: { release: () => void; token: number } | null = null;
  private commitHoldSeq = 0;

  getSnapshot = (): CardDragSnapshot | null => this.snap;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private armPanGuard(): void {
    if (this.cleanupPanGuard || typeof document === 'undefined') return;
    const onTouchMove = (ev: TouchEvent) => {
      if (ev.cancelable) ev.preventDefault();
    };
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    this.cleanupPanGuard = () => document.removeEventListener('touchmove', onTouchMove);
  }

  private disarmPanGuard(): void {
    this.cleanupPanGuard?.();
    this.cleanupPanGuard = null;
  }

  begin(args: {
    id: string;
    kind: ReorderKind;
    ids: string[];
    pointerY: number;
    pointerId?: number;
    height: number;
    commit: Commit;
    onFinish: () => void;
    onCancel?: () => void;
  }): boolean {
    this.flushSettle();
    if (this.snap || isMultitouchBlocked()) return false;
    const fromIndex = Math.max(0, args.ids.indexOf(args.id));
    this.pointerY = args.pointerY;
    this.ownerPointerId = args.pointerId ?? null;
    this.commit = args.commit;
    this.onFinish = args.onFinish;
    this.onCancelCb = args.onCancel ?? null;
    this.hasMovedSinceLift = false;
    this.snap = {
      id: args.id,
      kind: args.kind,
      ids: [...args.ids],
      fromIndex,
      overIndex: fromIndex,
      offsetY: 0,
      height: args.height,
    };
    this.elements = Array.from(
      document.querySelectorAll<HTMLElement>(`[${ZONE_ATTR}="${args.kind}"][${ID_ATTR}]`),
    );
    this.layouts = this.elements.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, height: r.height };
    });
    this.startPageY = args.pointerY + window.scrollY;
    this.startViewportY = args.pointerY;
    this.armPanGuard();
    this.liftSource(args.id);
    this.applyVisuals();
    this.bindWindowGuards();

    const onMove = (ev: PointerEvent) => {
      if (this.ownerPointerId !== null && ev.pointerId !== this.ownerPointerId) return;
      if (isMultitouchBlocked()) {
        this.cancel();
        return;
      }
      this.update(ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      if (this.ownerPointerId !== null && ev.pointerId !== this.ownerPointerId) return;
      const finish = this.onFinish;
      this.onFinish = null;
      if (finish) finish();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    const prevCleanup = this.cleanupWindow;
    this.cleanupWindow = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      prevCleanup?.();
    };
    this.emit();
    return true;
  }

  update(pointerY: number): void {
    if (!this.snap || this.settleControl) return;
    if (pointerY !== this.startViewportY) this.hasMovedSinceLift = true;
    this.pointerY = pointerY;
    this.recompute();
    this.ensureRaf();
    this.emit();
  }

  private recompute(): void {
    const snap = this.snap;
    if (!snap || this.settleControl) return;
    const pageY = this.pointerY + window.scrollY;
    const overIndex = dropIndexFor(pageY, this.layouts);
    const offsetY = pageY - this.startPageY;
    if (offsetY !== 0) this.hasMovedSinceLift = true;
    if (overIndex === snap.overIndex && offsetY === snap.offsetY) return;
    this.snap = { ...snap, overIndex, offsetY };
    this.applyVisuals();
  }

  private liftSource(id: string): void {
    const el = this.elements.find((e) => e.getAttribute(ID_ATTR) === id) ?? null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const shadowEl =
      typeof el.querySelector === 'function'
        ? (el.querySelector<HTMLElement>('.reorder-card-body') ?? el)
        : el;
    this.sourceEl = el;
    this.sourceShadowEl = shadowEl;
    this.sourceFixedTop = r.top;
    this.sourceStyle = { cssText: el.style.cssText };
    const ph = document.createElement('div');
    ph.setAttribute('data-drag-placeholder', id);
    ph.style.height = `${r.height}px`;
    ph.style.width = '100%';
    ph.style.pointerEvents = 'none';
    ph.style.userSelect = 'none';
    ph.style.setProperty('-webkit-user-select', 'none');
    el.parentElement?.insertBefore(ph, el);
    this.placeholder = ph;
    el.style.position = 'fixed';
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.margin = '0';
    el.style.zIndex = '60';
    el.style.pointerEvents = 'none';
    el.style.transition = isReducedMotionPreferred()
      ? 'none'
      : `transform 110ms ${DROP_SETTLE_EASING}, box-shadow 110ms ease`;
    if (shadowEl !== el) {
      shadowEl.style.transition = isReducedMotionPreferred() ? 'none' : 'box-shadow 110ms ease';
    }
    triggerDragLiftHaptic();
  }

  private restoreSource(): void {
    if (this.sourceShadowEl && this.sourceShadowEl !== this.sourceEl) {
      this.sourceShadowEl.style.boxShadow = '';
      this.sourceShadowEl.style.transition = '';
    }
    if (this.sourceEl && this.sourceStyle) {
      this.sourceEl.style.cssText = this.sourceStyle.cssText;
    }
    this.placeholder?.remove();
    this.placeholder = null;
    this.sourceEl = null;
    this.sourceShadowEl = null;
    this.sourceStyle = null;
    this.sourceFixedTop = 0;
  }

  private applyVisuals(): void {
    const snap = this.snap;
    if (!snap) return;
    const dy = this.pointerY - this.startViewportY;
    this.elements.forEach((el, i) => {
      if (el.getAttribute(ID_ATTR) === snap.id) {
        if (this.hasMovedSinceLift) el.style.transition = 'none';
        el.style.transform = `translate3d(0, ${dy}px, 0) scale(${LIFT_SCALE})`;
        // 保持 100% 不透明纸面，仅用阴影表达浮起高度，杜绝底层兄弟卡片文字半透明透出残影
        el.style.opacity = '1';
        const shadowEl = this.sourceShadowEl ?? el;
        if (shadowEl !== el) {
          el.style.boxShadow = '';
          shadowEl.style.boxShadow = '0 12px 28px rgba(22, 19, 14, 0.26)';
        } else {
          el.style.boxShadow = '0 12px 28px rgba(22, 19, 14, 0.22)';
        }
      } else {
        const shift = shiftForIndex(snap, i);
        el.style.transform = shift ? `translateY(${shift}px)` : '';
        el.style.transition = 'transform 140ms ease';
        el.style.zIndex = '';
        el.style.opacity = '';
        el.style.boxShadow = '';
      }
    });
  }

  private clearVisuals(): void {
    this.restoreSource();
    for (const el of this.elements) {
      el.style.transform = '';
      el.style.transition = '';
      el.style.zIndex = '';
      el.style.opacity = '';
      el.style.boxShadow = '';
    }
    this.elements = [];
  }

  private ensureRaf(): void {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      if (!this.snap) return;
      const v = autoScrollVelocity(this.pointerY, 0, window.innerHeight);
      if (v === 0) return;
      window.scrollBy(0, v);
      this.recompute();
      this.emit();
      this.raf = window.requestAnimationFrame(step);
    };
    this.raf = window.requestAnimationFrame(step);
  }

  private stopRaf(): void {
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private bindWindowGuards(): void {
    this.unbindWindowGuards();
    const stop = () => this.cancel();
    const onVis = () => {
      if (document.visibilityState !== 'visible') stop();
    };
    window.addEventListener('blur', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('touchcancel', stop);
    document.addEventListener('visibilitychange', onVis);
    this.cleanupWindow = () => {
      window.removeEventListener('blur', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('touchcancel', stop);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  private unbindWindowGuards(): void {
    this.cleanupWindow?.();
    this.cleanupWindow = null;
  }

  releaseCommitHold(expectedToken?: number): void {
    const hold = this.commitHoldControl;
    if (!hold) return;
    if (expectedToken !== undefined && hold.token !== expectedToken) return;
    this.commitHoldControl = null;
    hold.release();
  }

  flushSettle(): void {
    const ctl = this.settleControl;
    if (ctl) ctl.flush();
    this.releaseCommitHold();
  }

  private completeAfterSettle(
    shouldCommit: boolean,
    ordered: string[] | null,
    commit: Commit | null,
    startIds: string[] | null,
    onComplete?: (res: {
      ordered: string[] | null;
      commit: Commit | null;
      startIds: string[] | null;
    }) => void | Promise<unknown>,
  ): void {
    this.commit = null;
    this.onFinish = null;
    this.onCancelCb = null;
    this.hasMovedSinceLift = false;
    if (this.snap) {
      this.snap = null;
      this.emit();
    }

    if (!shouldCommit) {
      this.clearVisuals();
      return;
    }

    if (!ordered || !this.sourceEl || !this.sourceEl.isConnected) {
      this.clearVisuals();
      onComplete?.({ ordered, commit, startIds });
      return;
    }

    // 冻结所有卡片 CSS transition 并保持目标槽位定格，直至异步 IDB 落库后 React 同步重排 DOM
    this.sourceEl.style.transition = 'none';
    if (this.sourceShadowEl && this.sourceShadowEl !== this.sourceEl) {
      this.sourceShadowEl.style.transition = 'none';
    }
    for (const el of this.elements) {
      if (el !== this.sourceEl) {
        el.style.transition = 'none';
      }
    }

    let pending: unknown;
    try {
      pending = onComplete?.({ ordered, commit, startIds });
    } catch (err) {
      this.clearVisuals();
      throw err;
    }

    if (!isPromiseLike(pending)) {
      this.clearVisuals();
      return;
    }

    const token = ++this.commitHoldSeq;
    let fallbackTimer = 0;
    let rafId = 0;
    const cleanupTimers = () => {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = 0;
      }
      if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    this.commitHoldControl = {
      token,
      release: () => {
        cleanupTimers();
        this.clearVisuals();
      },
    };
    fallbackTimer = window.setTimeout(() => {
      this.releaseCommitHold(token);
    }, 260);
    const schedulePostCommitRelease = () => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        rafId = window.requestAnimationFrame(() => {
          rafId = 0;
          this.releaseCommitHold(token);
        });
      } else {
        this.releaseCommitHold(token);
      }
    };
    pending.then(schedulePostCommitRelease, schedulePostCommitRelease);
  }

  finishDrag(
    onComplete?: (res: {
      ordered: string[] | null;
      commit: Commit | null;
      startIds: string[] | null;
    }) => void | Promise<unknown>,
  ): void {
    const snap = this.snap;
    const commit = this.commit;
    const startIds = snap ? [...snap.ids] : null;
    if (!snap) {
      this.reset();
      onComplete?.({ ordered: null, commit: null, startIds: null });
      return;
    }
    const next = orderAfterDrop(snap.ids, snap.fromIndex, snap.overIndex);
    const ordered = next.every((id, i) => id === snap.ids[i]) ? null : next;

    // 指针已松开：立即释放触摸滚动阻止、自动滚屏 RAF 与全局拖动窗口监听
    this.disarmPanGuard();
    this.stopRaf();
    this.unbindWindowGuards();
    this.ownerPointerId = null;
    this.onFinish = null;
    this.onCancelCb = null;

    const sourceEl = this.sourceEl;
    if (!sourceEl || !sourceEl.isConnected) {
      this.reset();
      onComplete?.({ ordered, commit, startIds });
      return;
    }

    const phRect = this.placeholder?.getBoundingClientRect() ?? null;
    const targetSlot = snap.overIndex > snap.fromIndex ? snap.overIndex - 1 : snap.overIndex;
    let targetViewportTop: number;
    if (targetSlot === snap.fromIndex && phRect) {
      targetViewportTop = phRect.top;
    } else if (targetSlot >= 0 && targetSlot < this.layouts.length) {
      const slotPageTop =
        targetSlot > snap.fromIndex
          ? this.layouts[targetSlot].top + this.layouts[targetSlot].height - snap.height
          : this.layouts[targetSlot].top;
      targetViewportTop = slotPageTop - window.scrollY;
    } else {
      targetViewportTop = phRect ? phRect.top : this.sourceFixedTop;
    }
    const targetDy = targetViewportTop - this.sourceFixedTop;
    const shadowEl = this.sourceShadowEl ?? sourceEl;

    if (isReducedMotionPreferred()) {
      sourceEl.style.transition = 'none';
      sourceEl.style.transform = `translate3d(0, ${targetDy}px, 0) scale(1)`;
      sourceEl.style.opacity = '1';
      if (shadowEl !== sourceEl) {
        shadowEl.style.transition = 'none';
        shadowEl.style.boxShadow = '0 0 0 rgba(22, 19, 14, 0)';
      } else {
        sourceEl.style.boxShadow = '0 0 0 rgba(22, 19, 14, 0)';
      }
      this.completeAfterSettle(true, ordered, commit, startIds, onComplete);
      return;
    }

    let done = false;
    let fallbackTimer = 0;
    const cleanupTransition = () => {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = 0;
      }
      sourceEl.removeEventListener('transitionend', onTransitionEnd);
    };
    const finalize = (shouldCommit: boolean) => {
      if (done) return;
      done = true;
      cleanupTransition();
      this.settleControl = null;
      this.completeAfterSettle(shouldCommit, ordered, commit, startIds, onComplete);
    };
    const onTransitionEnd = (ev: TransitionEvent) => {
      if (ev.target !== sourceEl) return;
      if (ev.propertyName && ev.propertyName !== 'transform') return;
      finalize(true);
    };

    this.settleControl = {
      flush: () => finalize(true),
      abort: () => finalize(false),
    };

    sourceEl.addEventListener('transitionend', onTransitionEnd);
    fallbackTimer = window.setTimeout(() => finalize(true), DROP_SETTLE_TIMEOUT_MS);
    sourceEl.style.transition = `transform ${DROP_SETTLE_MS}ms ${DROP_SETTLE_EASING}, box-shadow ${DROP_SETTLE_MS}ms ${DROP_SETTLE_EASING}`;
    sourceEl.style.transform = `translate3d(0, ${targetDy}px, 0) scale(1)`;
    sourceEl.style.opacity = '1';
    if (shadowEl !== sourceEl) {
      shadowEl.style.transition = `box-shadow ${DROP_SETTLE_MS}ms ${DROP_SETTLE_EASING}`;
      shadowEl.style.boxShadow = '0 0 0 rgba(22, 19, 14, 0)';
    } else {
      sourceEl.style.boxShadow = '0 0 0 rgba(22, 19, 14, 0)';
    }
  }

  end(): { ordered: string[] | null; commit: Commit | null; startIds: string[] | null } {
    const snap = this.snap;
    const commit = this.commit;
    const startIds = snap ? [...snap.ids] : null;
    this.reset();
    if (!snap) return { ordered: null, commit: null, startIds: null };
    const next = orderAfterDrop(snap.ids, snap.fromIndex, snap.overIndex);
    return { ordered: next.every((id, i) => id === snap.ids[i]) ? null : next, commit, startIds };
  }

  cancel(): void {
    if (this.settleControl) {
      const ctl = this.settleControl;
      this.settleControl = null;
      ctl.abort();
      return;
    }
    if (this.commitHoldControl) {
      this.releaseCommitHold();
      return;
    }
    const cb = this.onCancelCb;
    this.onCancelCb = null;
    this.reset();
    cb?.();
  }

  private reset(): void {
    const ctl = this.settleControl;
    this.settleControl = null;
    if (ctl) ctl.abort();
    this.releaseCommitHold();
    this.disarmPanGuard();
    this.clearVisuals();
    this.stopRaf();
    this.unbindWindowGuards();
    this.ownerPointerId = null;
    this.commit = null;
    this.onFinish = null;
    this.onCancelCb = null;
    this.hasMovedSinceLift = false;
    if (this.snap) {
      this.snap = null;
      this.emit();
    }
  }
}

export const cardDrag = new CardDragStore();

/* ── 单张展开协调（G3B-FIX1 / FIX1-R1-2）────────────────────── */
let openCardId: string | null = null;
let closingCardId: string | null = null;
let closeStartedAt: number | null = null;

/** 页面级唯一的延后展开管理（FIX2-B / AG-R1） */
let pendingOpenCardId: string | null = null;
let pendingOpenTimer: number | null = null;
let gestureGeneration = 0;
let cancelGlobalGuards: (() => void) | null = null;

const openListeners = new Set<() => void>();
const gestureClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const cardOpenStore = {
  get: (): string | null => openCardId,
  getClosingCardId: (): string | null => closingCardId,
  getPendingOpenCardId: (): string | null => pendingOpenCardId,
  set(id: string | null): void {
    if (openCardId === id) return;
    if (openCardId !== null) {
      closeStartedAt = gestureClock();
      closingCardId = openCardId;
    }
    openCardId = id;
    for (const fn of openListeners) fn();
  },
  notifyClosing(id: string | null): void {
    closeStartedAt = gestureClock();
    closingCardId = id;
    for (const fn of openListeners) fn();
  },
  schedulePendingOpen(id: string, delayMs: number, onOpen: () => void): void {
    this.cancelPendingOpen();
    const token = ++gestureGeneration;
    pendingOpenCardId = id;

    const cleanup = () => {
      cancelGlobalGuards?.();
      cancelGlobalGuards = null;
    };
    const onInterrupt = () => {
      this.cancelPendingOpen();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', onInterrupt, true);
      window.addEventListener('touchstart', onInterrupt, true);
      window.addEventListener('blur', onInterrupt);
      window.addEventListener('pointercancel', onInterrupt);
      window.addEventListener('touchcancel', onInterrupt);
      document.addEventListener('visibilitychange', onInterrupt);
      cancelGlobalGuards = () => {
        window.removeEventListener('pointerdown', onInterrupt, true);
        window.removeEventListener('touchstart', onInterrupt, true);
        window.removeEventListener('blur', onInterrupt);
        window.removeEventListener('pointercancel', onInterrupt);
        window.removeEventListener('touchcancel', onInterrupt);
        document.removeEventListener('visibilitychange', onInterrupt);
      };
    }

    pendingOpenTimer = (setTimeout as unknown as Window['setTimeout'])(() => {
      cleanup();
      if (token !== gestureGeneration || pendingOpenCardId !== id) return;
      pendingOpenCardId = null;
      pendingOpenTimer = null;
      onOpen();
    }, delayMs);
  },
  cancelPendingOpen(id?: string): void {
    if (id && pendingOpenCardId !== id) return;
    if (pendingOpenTimer !== null) {
      clearTimeout(pendingOpenTimer);
      pendingOpenTimer = null;
    }
    cancelGlobalGuards?.();
    cancelGlobalGuards = null;
    pendingOpenCardId = null;
    gestureGeneration++;
  },
  subscribe(fn: () => void): () => void {
    openListeners.add(fn);
    return () => {
      openListeners.delete(fn);
    };
  },
};

export function handoverGateMs(callerId?: string): number {
  if (closeStartedAt === null) return 0;
  if (callerId && closingCardId && callerId === closingCardId) return 0;
  const need = SWIPE_SETTLE_MS + TAKEOVER_GUARD_MS;
  const elapsed = gestureClock() - closeStartedAt;
  return elapsed < need ? need - elapsed : 0;
}

export function closeStartedAtMs(): number | null {
  return closeStartedAt;
}

export function useOpenCardId(): string | null {
  return useSyncExternalStore(cardOpenStore.subscribe, cardOpenStore.get, cardOpenStore.get);
}

export function useCardDragSnapshot(): CardDragSnapshot | null {
  return useSyncExternalStore(cardDrag.subscribe, cardDrag.getSnapshot, cardDrag.getSnapshot);
}

export function shiftForIndex(snap: CardDragSnapshot, index: number): number {
  if (snap.id === snap.ids[index]) return 0;
  const from = snap.fromIndex;
  const over = snap.overIndex > from ? snap.overIndex - 1 : snap.overIndex;
  if (index === from) return 0;
  if (from < over && index > from && index <= over) return -snap.height;
  if (over < from && index >= over && index < from) return snap.height;
  return 0;
}
