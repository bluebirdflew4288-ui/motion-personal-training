/* 动作卡片交互层（G3B / F01–F03 / F06 / F07 / F09 / F12 / G01–G04 收敛版）。
   ── 裁决与分层 ───────────────────────────────────────────────
   · 只有**非交互展示区**上的单指手势参与裁决；输入、按钮、label/checkbox、
     步进器、slider、contenteditable 直接早退，不抢输入与滚动；
   · 方向未决前不抢手势：明确纵向 → 交给页面滚动；明确横向 → 进入左滑；
     静止满 LONG_PRESS_MS → 整卡浮起进入拖动（由 cardDrag 单一协调器接管）；
   · 全局选区/菜单/原生拖拽拦截、多触点锁存取消、失焦/隐藏取消与拖动期 touchmove
     平移阻止统一由协调器单点维护，卡片内部只维护单一手势会话状态机；
   · 收起态左滑操作层设为 visibility:hidden（左滑露出瞬间 0ms 切换 visible，回位过渡
     结束后再收起），既保留 F01 中间态可见，又杜绝隐藏按钮文字被系统识屏提取。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AXIS_THRESHOLD,
  CARD_GAP,
  LONG_PRESS_MS,
  SWIPE_ACTION_WIDTH,
  SWIPE_JITTER_TOLERANCE,
  SWIPE_PROMPT_BLANK,
  SWIPE_PROMPT_CONFIRM,
  SWIPE_READY_HOLD_MS,
  SWIPE_SETTLE_MS,
  SWIPE_VERTICAL_INTENT_THRESHOLD,
  decideAxis,
} from './cardGestures';
import { playPrepareHaptic } from '../lib/deletionFeedback';
import {
  cardDrag,
  cardOpenStore,
  handoverGateMs,
  isMultitouchBlocked,
  registerGestureCancel,
  useOpenCardId,
  type CardDragSnapshot,
  type ReorderKind,
} from './cardDrag';

interface Props {
  children: React.ReactNode;
  /** 蓝色编辑：打开共用编辑器。省略时操作区只有删除（有氧卡，F07） */
  onEdit?: () => void;
  /** 红色删除 */
  onDelete?: () => void;
  disabled?: boolean;
  /** F06/F12：记录展开时锁定左滑与长按拖动，不影响卡片内输入与纵向滚动 */
  locked?: boolean;
  testId?: string;
  reorderId?: string;
  reorderKind?: ReorderKind;
  reorderIndex?: number;
  reorderIds?: string[];
  drag?: CardDragSnapshot | null;
  onReorderCommit?: (orderedIds: string[], startIds: string[] | null) => void;
  deleteRequiresConfirm?: boolean | (() => boolean);
  actionWidth?: number;
}

type GesturePhase = 'idle' | 'tracking' | 'dragging';

/** 单次指针手势的统一会话状态（替代原先分散的多组布尔值与 ref） */
interface ActiveGesture {
  pointerId: number;
  mode: 'tracking' | 'dragging';
  x: number;
  y: number;
  axis: 'undecided' | 'vertical' | 'horizontal';
  /** 手势开始时的真实位移（-ACTION_WIDTH=已展开，0=收起），本次手势内固定 */
  base: number;
  wasOpen: boolean;
  /** F03 移交闸门截止时刻（performance.now() 时间基） */
  gateUntil: number;
  /** 闸门打开时的 dx 锚点（null 表示闸门尚未打开） */
  dxAnchor: number | null;
  /** F09-FIX1：出现纵向移动意图或移出卡片后，本手势禁止再次进入删除就绪态 */
  f09Aborted: boolean;
}

const DEFAULT_ACTION_WIDTH = SWIPE_ACTION_WIDTH;
const SETTLE_TRANSITION = `transform ${SWIPE_SETTLE_MS}ms ease`;

/** F09 准备触感：单通道调用（Android 原生插件 / Web Vibration 互斥，由 deletionFeedback 保证） */
function triggerF09Haptic(): void {
  try {
    playPrepareHaptic();
  } catch {
    // 触感不可用不阻断交互（文字提示仍在）
  }
}

const clampOffset = (v: number, maxW = DEFAULT_ACTION_WIDTH): number =>
  Math.max(-maxW, Math.min(0, v));

function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, label, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="slider"], [role="button"], [role="checkbox"], [role="switch"], [tabindex], [data-no-drag]',
    ),
  );
}

export function SwipeActionCard({
  children,
  onEdit,
  onDelete,
  disabled,
  locked,
  testId,
  reorderId,
  reorderKind = 'strength',
  reorderIndex = 0,
  reorderIds,
  drag,
  onReorderCommit,
  deleteRequiresConfirm,
  actionWidth,
}: Props) {
  const ACTION_WIDTH = actionWidth ?? DEFAULT_ACTION_WIDTH;
  const openId = useOpenCardId();
  const open = Boolean(testId) && openId === testId;

  const [offset, setOffsetState] = useState(0);
  const offsetRef = useRef(0);
  const setOffset = useCallback((next: number) => {
    offsetRef.current = next;
    setOffsetState(next);
  }, []);

  const [phase, setPhase] = useState<GesturePhase>('idle');
  const [readyToDelete, setReadyToDelete] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ActiveGesture | null>(null);
  const pressTimer = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const gestureSeqRef = useRef(0);
  const startIdsRef = useRef<string[] | null>(null);

  const readyToDeleteRef = useRef(false);
  readyToDeleteRef.current = readyToDelete;
  const hapticFiredRef = useRef(false);

  const lockedRef = useRef(Boolean(locked));
  lockedRef.current = Boolean(locked);
  const disabledRef = useRef(Boolean(disabled));
  disabledRef.current = Boolean(disabled);

  const clearPress = useCallback(() => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }, []);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const disarmF09 = useCallback(() => {
    clearHoldTimer();
    setReadyToDelete(false);
    hapticFiredRef.current = false;
  }, [clearHoldTimer]);

  const ownsOpen = useCallback(
    () => Boolean(testId) && cardOpenStore.get() === testId,
    [testId],
  );

  /** 卸载清理：只撤销本卡关联的定时器、延后展开与拖动会话 */
  useEffect(() => {
    return () => {
      clearPress();
      disarmF09();
      if (testId) cardOpenStore.cancelPendingOpen(testId);
      const snap = cardDrag.getSnapshot();
      if (snap && reorderId && snap.id === reorderId) cardDrag.cancel();
    };
  }, [reorderId, testId, clearPress, disarmF09]);

  /** 单一展开真源协调：逻辑展开不属于本卡且无进行中手势时，位移回到 0 */
  useEffect(() => {
    if (open) return;
    if (phase !== 'idle' || sessionRef.current !== null) return;
    if (testId && cardOpenStore.getPendingOpenCardId() === testId) return;
    if (offsetRef.current !== 0) setOffset(0);
  }, [open, phase, setOffset, testId]);

  /** 统一手势取消（由协调器在多指/失焦/切后台/cancel 时回调，或本卡门禁变化触发） */
  const cancelPointerGesture = useCallback(() => {
    gestureSeqRef.current += 1;
    const cur = sessionRef.current;
    sessionRef.current = null;
    clearPress();
    disarmF09();
    if (testId) cardOpenStore.cancelPendingOpen(testId);
    setPhase('idle');
    if (cur?.mode === 'dragging') {
      const snap = cardDrag.getSnapshot();
      if (snap && reorderId && snap.id === reorderId) cardDrag.cancel();
    }
    if (!cur) return;
    const wasShifted = offsetRef.current !== 0;
    const nextOffset = ownsOpen() ? -ACTION_WIDTH : 0;
    if (wasShifted && nextOffset === 0 && testId) {
      cardOpenStore.notifyClosing(testId);
    }
    setOffset(nextOffset);
  }, [ACTION_WIDTH, ownsOpen, reorderId, setOffset, testId, clearPress, disarmF09]);

  /** 注册到页面级协调器（共享单一多触点与生命周期取消监听） */
  useEffect(() => registerGestureCancel(cancelPointerGesture), [cancelPointerGesture]);

  /** P1/P2-02：左滑追踪期间若指针移动到卡片外部后释放，立即解除 F09 并清理手势 */
  useEffect(() => {
    if (phase !== 'tracking') return undefined;
    const onGlobalUp = (ev: Event) => {
      const cur = sessionRef.current;
      if (!cur) return;
      if (ev instanceof PointerEvent && ev.pointerId !== cur.pointerId) return;
      const el = rootRef.current;
      const isInside = Boolean(el && ev.target instanceof Node && el.contains(ev.target));
      if (!isInside) {
        cur.f09Aborted = true;
        disarmF09();
        cancelPointerGesture();
      }
    };
    window.addEventListener('pointerup', onGlobalUp, true);
    window.addEventListener('mouseup', onGlobalUp, true);
    window.addEventListener('touchend', onGlobalUp, true);
    return () => {
      window.removeEventListener('pointerup', onGlobalUp, true);
      window.removeEventListener('mouseup', onGlobalUp, true);
      window.removeEventListener('touchend', onGlobalUp, true);
    };
  }, [phase, disarmF09, cancelPointerGesture]);

  /** F06/F12：只读或记录展开时立即取消手势、收起左滑且不提交排序 */
  useEffect(() => {
    if (!locked && !disabled) return;
    gestureSeqRef.current += 1;
    sessionRef.current = null;
    clearPress();
    disarmF09();
    if (testId) cardOpenStore.cancelPendingOpen(testId);
    setPhase('idle');
    const snap = cardDrag.getSnapshot();
    if (snap && reorderId && snap.id === reorderId) cardDrag.cancel();
    if (ownsOpen()) cardOpenStore.set(null);
    if (offsetRef.current !== 0) {
      if (testId) cardOpenStore.notifyClosing(testId);
      setOffset(0);
    }
  }, [locked, disabled, reorderId, ownsOpen, setOffset, testId, clearPress, disarmF09]);

  /** 单张展开的视口外部点击收起（仅当前展开的那一张卡挂载监听） */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (ev: PointerEvent) => {
      const el = rootRef.current;
      if (el && ev.target instanceof Node && el.contains(ev.target)) {
        const target = ev.target instanceof Element ? ev.target : null;
        if (target && target.closest('button')) return;
        if (isInteractive(ev.target)) {
          cardOpenStore.set(null);
          return;
        }
        return;
      }
      cardOpenStore.set(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const settleTo = useCallback((target: number) => {
    const next = target < -ACTION_WIDTH / 2 ? -ACTION_WIDTH : 0;
    const prev = offsetRef.current;
    if (next !== prev) setOffset(next);
    if (next !== 0) {
      if (testId) cardOpenStore.set(testId);
    } else if (ownsOpen()) {
      cardOpenStore.set(null);
    } else if (prev !== 0 && testId) {
      cardOpenStore.notifyClosing(testId);
    }
  }, [ACTION_WIDTH, testId, ownsOpen, setOffset]);

  const endDrag = () => {
    sessionRef.current = null;
    gestureSeqRef.current += 1;
    setPhase('idle');
    const { ordered, commit, startIds } = cardDrag.end();
    if (ordered && commit) {
      startIdsRef.current = startIds;
      commit(ordered);
    }
  };

  const beginDrag = (pointerY: number, ownerPointerId: number, ownerSeq: number) => {
    if (disabledRef.current || lockedRef.current) return;
    if (isMultitouchBlocked()) {
      cancelPointerGesture();
      return;
    }
    const cur = sessionRef.current;
    if (
      gestureSeqRef.current !== ownerSeq ||
      !cur ||
      cur.pointerId !== ownerPointerId ||
      cur.mode !== 'tracking' ||
      cur.axis !== 'undecided'
    ) {
      return;
    }
    if (cardDrag.getSnapshot()) return;
    if (!reorderId || !onReorderCommit || !reorderIds) return;
    const el = rootRef.current;
    if (!el || !el.isConnected) return;
    const height = el.getBoundingClientRect().height;

    disarmF09();
    if (testId) cardOpenStore.cancelPendingOpen(testId);
    if (ownsOpen()) cardOpenStore.set(null);
    setOffset(0);
    cur.mode = 'dragging';
    setPhase('dragging');

    const started = cardDrag.begin({
      id: reorderId,
      kind: reorderKind,
      ids: reorderIds,
      pointerY,
      pointerId: ownerPointerId,
      height,
      commit: (ordered) => onReorderCommit(ordered, startIdsRef.current),
      onFinish: () => endDrag(),
      onCancel: () => {
        sessionRef.current = null;
        gestureSeqRef.current += 1;
        setPhase('idle');
      },
    });
    if (!started) {
      sessionRef.current = null;
      gestureSeqRef.current += 1;
      setPhase('idle');
    }
  };

  const isDragSource = Boolean(drag && reorderId && drag.id === reorderId);
  const gestureBusy = phase !== 'idle';
  const actionsInteractive = open && !disabled && !gestureBusy && !readyToDelete;
  const actionsExposed = open || offset < 0 || readyToDelete;
  const showEdit = typeof onEdit === 'function';

  const isRisky = typeof deleteRequiresConfirm === 'function'
    ? deleteRequiresConfirm()
    : Boolean(deleteRequiresConfirm);
  const promptText = isRisky ? SWIPE_PROMPT_CONFIRM : SWIPE_PROMPT_BLANK;

  return (
    <div
      ref={rootRef}
      className="reorder-card"
      data-testid={testId}
      data-reorder-id={reorderId}
      data-reorder-kind={reorderId ? reorderKind : undefined}
      data-drag-source={isDragSource ? 'true' : undefined}
      data-reorder-index={reorderIndex}
      data-gesture-lock={locked ? 'records-expanded' : disabled ? 'readonly' : undefined}
      style={{
        position: 'relative',
        overflow: 'hidden',
        paddingTop: CARD_GAP,
      }}
    >
      <div
        data-testid={testId ? `${testId}-actions` : undefined}
        style={{
          position: 'absolute',
          right: 0,
          top: CARD_GAP,
          bottom: 0,
          width: ACTION_WIDTH,
          display: 'flex',
          // 左滑露出瞬间立即显示（无延迟满足 F01）；收起静止态隐藏，杜绝隐藏按钮文字被系统选区/残影抓取
          visibility: actionsExposed ? 'visible' : 'hidden',
          transition: actionsExposed ? 'none' : `visibility 0s linear ${SWIPE_SETTLE_MS}ms`,
          pointerEvents: actionsInteractive ? 'auto' : 'none',
        }}
        aria-hidden={!open}
      >
        {readyToDelete ? (
          <div
            data-testid={testId ? `${testId}-ready-banner` : 'swipe-delete-ready-banner'}
            className="swipe-delete-ready-banner"
            role="status"
            aria-live="assertive"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--danger-delete, #b3261e)',
              color: 'var(--danger-delete-ink, #fff)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 8px',
              fontSize: 12.5,
              fontWeight: 600,
              textAlign: 'center',
              lineHeight: 1.3,
              zIndex: 5,
              pointerEvents: 'none',
              letterSpacing: '0.02em',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.2)',
            }}
          >
            {promptText}
          </div>
        ) : null}
        {showEdit ? (
          <button
            type="button"
            data-testid={testId ? `${testId}-edit` : undefined}
            tabIndex={open && !disabled ? 0 : -1}
            disabled={Boolean(disabled)}
            onClick={() => {
              if (ownsOpen()) cardOpenStore.set(null);
              setOffset(0);
              onEdit?.();
            }}
            style={{
              flex: 1,
              border: 0,
              background: '#1f5fbf',
              color: '#fff',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            编辑
          </button>
        ) : null}
        <button
          type="button"
          data-testid={testId ? `${testId}-delete` : undefined}
          tabIndex={open && !disabled ? 0 : -1}
          disabled={Boolean(disabled)}
          onClick={() => {
            if (ownsOpen()) cardOpenStore.set(null);
            setOffset(0);
            onDelete?.();
          }}
          style={{
            flex: 1,
            border: 0,
            background: 'var(--danger-delete, var(--brick))',
            color: 'var(--danger-delete-ink, #fff)',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          删除
        </button>
      </div>
      <div
        data-drag-handle={reorderId ? 'true' : undefined}
        onPointerDown={(e) => {
          if (disabled || lockedRef.current) return;
          if (isInteractive(e.target)) return;
          if (isMultitouchBlocked()) {
            cancelPointerGesture();
            return;
          }
          if (cardDrag.getSnapshot()) return;
          if (sessionRef.current !== null && sessionRef.current.pointerId !== e.pointerId) {
            cancelPointerGesture();
            return;
          }
          cardOpenStore.cancelPendingOpen();
          disarmF09();
          const ownerPointerId = e.pointerId;
          const ownerSeq = ++gestureSeqRef.current;
          const base = clampOffset(offsetRef.current, ACTION_WIDTH);
          const wasOpen = ownsOpen();
          const isSameClosing = Boolean(testId) && cardOpenStore.getClosingCardId() === testId;
          const gateMs = wasOpen || isSameClosing ? 0 : handoverGateMs(testId);
          sessionRef.current = {
            pointerId: ownerPointerId,
            mode: 'tracking',
            x: e.clientX,
            y: e.clientY,
            axis: 'undecided',
            base,
            wasOpen,
            gateUntil: gateMs > 0 ? performance.now() + gateMs : 0,
            dxAnchor: gateMs > 0 ? null : 0,
            f09Aborted: false,
          };
          setPhase('tracking');
          setOffset(base);
          if (reorderId && onReorderCommit && reorderIds) {
            clearPress();
            pressTimer.current = window.setTimeout(() => {
              pressTimer.current = null;
              beginDrag(e.clientY, ownerPointerId, ownerSeq);
            }, LONG_PRESS_MS);
          }
        }}
        onPointerMove={(e) => {
          const cur = sessionRef.current;
          if (!cur || e.pointerId !== cur.pointerId) return;
          if (isMultitouchBlocked()) {
            cancelPointerGesture();
            return;
          }
          if (disabled || lockedRef.current) return;
          if (cur.mode === 'dragging') {
            disarmF09();
            cardDrag.update(e.clientY);
            return;
          }

          const dx = e.clientX - cur.x;
          const dy = e.clientY - cur.y;
          if (cur.axis === 'undecided') {
            const axis = decideAxis(dx, dy, AXIS_THRESHOLD);
            if (axis === 'undecided') return;
            cur.axis = axis;
            clearPress();
            if (axis === 'vertical') {
              disarmF09();
              sessionRef.current = null;
              setPhase('idle');
              if (cur.wasOpen) {
                settleTo(0);
              } else {
                if (offsetRef.current !== 0 && testId) cardOpenStore.notifyClosing(testId);
                setOffset(cur.base);
              }
              return;
            }
          }
          if (cur.axis !== 'horizontal') {
            disarmF09();
            return;
          }

          if (Math.abs(dy) >= SWIPE_VERTICAL_INTENT_THRESHOLD) {
            cur.f09Aborted = true;
            disarmF09();
          }

          const el = rootRef.current;
          if (el) {
            const rect = el.getBoundingClientRect();
            if (e.clientY < rect.top - 8 || e.clientY > rect.bottom + 8) {
              cur.f09Aborted = true;
              disarmF09();
            }
          }

          if (cur.gateUntil > 0 && performance.now() < cur.gateUntil) {
            setOffset(cur.base);
            return;
          }
          if (cur.dxAnchor === null) cur.dxAnchor = dx;
          const targetOffset = cur.base + (dx - cur.dxAnchor);
          setOffset(clampOffset(targetOffset, ACTION_WIDTH));

          const isAtMax = targetOffset <= -ACTION_WIDTH + SWIPE_JITTER_TOLERANCE;
          if (isAtMax && !cur.f09Aborted) {
            if (holdTimerRef.current === null && !readyToDeleteRef.current) {
              holdTimerRef.current = window.setTimeout(() => {
                holdTimerRef.current = null;
                setReadyToDelete(true);
                if (!hapticFiredRef.current) {
                  hapticFiredRef.current = true;
                  triggerF09Haptic();
                }
              }, SWIPE_READY_HOLD_MS);
            }
          } else {
            clearHoldTimer();
            setReadyToDelete(false);
          }
        }}
        onPointerUp={(e) => {
          const cur = sessionRef.current;
          if (!cur || e.pointerId !== cur.pointerId) return;
          if (isMultitouchBlocked()) {
            cancelPointerGesture();
            return;
          }
          gestureSeqRef.current += 1;
          clearPress();
          clearHoldTimer();
          if (cur.mode === 'dragging') {
            disarmF09();
            endDrag();
            return;
          }

          sessionRef.current = null;
          setPhase('idle');

          if (readyToDeleteRef.current && !cur.f09Aborted) {
            disarmF09();
            if (ownsOpen()) cardOpenStore.set(null);
            setOffset(0);
            onDelete?.();
            return;
          }

          disarmF09();
          if (cur.axis === 'undecided') {
            if (cur.wasOpen) settleTo(0);
            return;
          }
          const rawTarget = clampOffset(cur.base + (e.clientX - cur.x), ACTION_WIDTH);
          if (rawTarget >= -ACTION_WIDTH / 2) {
            settleTo(0);
            return;
          }
          const remainingGate = cur.gateUntil > 0 ? cur.gateUntil - performance.now() : 0;
          if (remainingGate <= 0) {
            settleTo(-ACTION_WIDTH);
          } else {
            setOffset(cur.base);
            if (testId) {
              cardOpenStore.schedulePendingOpen(testId, Math.ceil(remainingGate), () => {
                settleTo(-ACTION_WIDTH);
              });
            }
          }
        }}
        onPointerCancel={(e) => {
          const cur = sessionRef.current;
          if (!cur || e.pointerId !== cur.pointerId) return;
          gestureSeqRef.current += 1;
          sessionRef.current = null;
          clearPress();
          disarmF09();
          if (testId) cardOpenStore.cancelPendingOpen(testId);
          setPhase('idle');
          if (cur.mode === 'dragging') {
            const snap = cardDrag.getSnapshot();
            if (snap && reorderId && snap.id === reorderId) cardDrag.cancel();
            return;
          }
          const nextOffset = cur.base;
          if (offsetRef.current !== 0 && nextOffset === 0 && testId) {
            cardOpenStore.notifyClosing(testId);
          }
          setOffset(nextOffset);
        }}
        onPointerLeave={(e) => {
          const cur = sessionRef.current;
          if (!cur || e.pointerId !== cur.pointerId) return;
          clearPress();
          cur.f09Aborted = true;
          disarmF09();
        }}
        onContextMenu={(e) => {
          if (isInteractive(e.target)) return;
          e.preventDefault();
        }}
        onDragStart={(e) => {
          if (isInteractive(e.target)) return;
          e.preventDefault();
        }}
        style={{
          position: 'relative',
          transform: `translateX(${offset}px)`,
          transition: gestureBusy ? 'none' : SETTLE_TRANSITION,
          touchAction: 'pan-y',
          background: 'var(--paper)',
        }}
      >
        <div className="reorder-card-body">
          {children}
        </div>
      </div>
    </div>
  );
}
