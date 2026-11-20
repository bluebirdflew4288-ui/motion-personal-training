/* 安卓式等比缩放悬浮小窗外框 + 最小化侧边入口。
   ── 核心手感与边界 ──────────────────────────────────────────────
   1. 严格同构 DOM 树：primary / mini / hidden 三态保持完全一致的 div 层级，
      互换主次时 React 零卸载，完整保留业务页输入、计时器、滚动与教练草稿/流式输出；
   2. 无全屏遮罩：小窗只占自身矩形，窗外第一次点击直接落到主屏业务控件；
   3. 去重极简触控条：顶部横条按住拖动小窗、轻点展开选项菜单（互换/大小/最小化/关闭）；
      底部横条上下拖动无极等比缩放、轻点在标准与放大视图间平滑切换；
   4. 内容区置于 .pane-scaled-stage + .pane-scroll-body，独立安全区归零与独立滚动，不锁死另一窗口。 */

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { backStack } from '../lib/backIntent';
import {
  clamp,
  resizeMiniFromHandle,
  toggleMiniPresetWidth,
  useDualWindow,
  useOptionalDualWindow,
  type PaneId,
  type ViewportMetrics,
} from './windowState';

type TopDragZone = 'none' | 'pip-left' | 'pip-right' | 'maximize';

function resolveTopDragZone(
  clientX: number,
  clientY: number,
  startY: number,
  vp: ViewportMetrics,
): TopDragZone {
  const dy = clientY - startY;
  const inTopBand = clientY <= vp.safeTop + 64 && (dy <= -10 || clientY <= vp.safeTop + 36);
  if (!inTopBand) return 'none';
  if (clientX <= vp.width * 0.28) return 'pip-left';
  if (clientX >= vp.width * 0.72) return 'pip-right';
  return 'maximize';
}

export type PaneRenderRole = 'primary' | 'mini' | 'hidden';
const PaneRoleContext = createContext<PaneRenderRole | null>(null);

export function usePaneRole(): PaneRenderRole | null {
  return useContext(PaneRoleContext);
}

interface PaneHostProps {
  paneId: PaneId;
  mode: 'primary' | 'mini' | 'hidden';
  title: string;
  testIdPrefix: string;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
  overlays?: ReactNode;
}

export function PaneHost({
  paneId,
  mode,
  title,
  testIdPrefix,
  scrollRef,
  children,
  overlays,
}: PaneHostProps) {
  const dual = useDualWindow();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isGesturing, setIsGesturing] = useState(false);
  const [topZone, setTopZone] = useState<TopDragZone>('none');
  const [swipeUpPx, setSwipeUpPx] = useState(0);
  const [exitKind, setExitKind] = useState<'swipe-up' | 'minimize' | 'close'>('close');
  const [expandAnim, setExpandAnim] = useState(false);
  const prevModeRef = useRef(mode);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const dragSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    zone: TopDragZone;
  } | null>(null);
  const pipSessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    moved: boolean;
    zone: TopDragZone;
  } | null>(null);
  const resizeSessionRef = useRef<{
    pointerId: number;
    startY: number;
    startRect: typeof dual.miniRect;
    intent: 'none' | 'swipe-close' | 'resize-down';
    lastDeltaY: number;
  } | null>(null);

  const isPrimary = mode === 'primary';
  const isHidden = mode === 'hidden';
  const isMiniPip = !isPrimary && !isHidden && dual.miniPipCorner !== null;
  const geo = dual.miniGeometry;

  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (mode === 'primary' && prev === 'mini') {
      setExpandAnim(true);
      const id = window.setTimeout(() => setExpandAnim(false), 240);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [mode]);

  useEffect(() => {
    if (mode !== 'mini') {
      setMenuOpen(false);
      setSwipeUpPx(0);
      setTopZone('none');
      setIsGesturing(false);
    }
  }, [mode]);

  useEffect(() => {
    if (isMiniPip) {
      setMenuOpen(false);
    }
  }, [isMiniPip]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    return backStack.push({
      id: `floating-menu:${menuId}`,
      handle: () => {
        setMenuOpen(false);
        return true;
      },
    });
  }, [menuOpen, menuId]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocDown = (ev: PointerEvent) => {
      if (!rootRef.current?.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocDown, true);
    return () => document.removeEventListener('pointerdown', onDocDown, true);
  }, [menuOpen]);

  const onDragPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (isPrimary || isHidden) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    dragSessionRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      origX: geo.x,
      origY: geo.y,
      moved: false,
      zone: 'none',
    };
  };

  const onDragPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = dragSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - s.startX;
    const dy = ev.clientY - s.startY;
    if (!s.moved) {
      if (Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return;
      s.moved = true;
      setIsGesturing(true);
      setMenuOpen(false);
    }
    const zone = resolveTopDragZone(ev.clientX, ev.clientY, s.startY, dual.viewport);
    if (zone !== s.zone) {
      s.zone = zone;
      setTopZone(zone);
    }
    const nextX = clamp(s.origX + dx, 8, Math.max(8, dual.viewport.width - geo.width - 8));
    const nextY = clamp(
      s.origY + dy,
      dual.viewport.safeTop + 8,
      Math.max(dual.viewport.safeTop + 8, dual.viewport.visibleBottom - geo.totalHeight - 8),
    );
    dual.setMiniRect((prev) => ({ ...prev, x: nextX, y: nextY }));
  };

  const onDragPointerUp = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = dragSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    dragSessionRef.current = null;
    setIsGesturing(false);
    setTopZone('none');
    if (!s.moved) {
      if (isMiniPip) {
        dual.restoreFromMiniPip();
      } else {
        setMenuOpen((prev) => !prev);
      }
      return;
    }
    if (s.zone === 'pip-left') {
      dual.enterMiniPip('top-left');
    } else if (s.zone === 'pip-right') {
      dual.enterMiniPip('top-right');
    } else if (s.zone === 'maximize') {
      dual.maximizeMiniWindow();
    }
  };

  const onDragPointerCancel = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (dragSessionRef.current?.pointerId === ev.pointerId) {
      dragSessionRef.current = null;
      setIsGesturing(false);
      setTopZone('none');
    }
  };

  const onPipPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!isMiniPip) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    pipSessionRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      origX: geo.x,
      origY: geo.y,
      moved: false,
      zone: 'none',
    };
  };

  const onPipPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = pipSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - s.startX;
    const dy = ev.clientY - s.startY;
    if (!s.moved) {
      if (Math.abs(dx) <= 5 && Math.abs(dy) <= 5) return;
      s.moved = true;
      setIsGesturing(true);
    }
    const zone = resolveTopDragZone(ev.clientX, ev.clientY, s.startY, dual.viewport);
    if (zone !== s.zone) {
      s.zone = zone;
      setTopZone(zone);
    }
    const nextX = clamp(s.origX + dx, 8, Math.max(8, dual.viewport.width - geo.width - 8));
    const nextY = clamp(
      s.origY + dy,
      dual.viewport.safeTop + 8,
      Math.max(dual.viewport.safeTop + 8, dual.viewport.visibleBottom - geo.totalHeight - 8),
    );
    dual.setMiniRect((prev) => ({ ...prev, x: nextX, y: nextY }));
  };

  const onPipPointerUp = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = pipSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    pipSessionRef.current = null;
    setIsGesturing(false);
    setTopZone('none');
    if (!s.moved) {
      dual.restoreFromMiniPip();
      return;
    }
    if (s.zone === 'pip-left') {
      dual.enterMiniPip('top-left');
    } else if (s.zone === 'pip-right') {
      dual.enterMiniPip('top-right');
    } else if (s.zone === 'maximize') {
      dual.maximizeMiniWindow();
    }
  };

  const onPipPointerCancel = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (pipSessionRef.current?.pointerId === ev.pointerId) {
      pipSessionRef.current = null;
      setIsGesturing(false);
      setTopZone('none');
    }
  };

  const onResizePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (isPrimary || isHidden) return;
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    setMenuOpen(false);
    setSwipeUpPx(0);
    resizeSessionRef.current = {
      pointerId: ev.pointerId,
      startY: ev.clientY,
      startRect: { ...dual.miniRect, x: geo.x, y: geo.y, width: geo.width },
      intent: 'none',
      lastDeltaY: 0,
    };
  };

  const onResizePointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    const deltaY = ev.clientY - s.startY;
    s.lastDeltaY = deltaY;
    if (s.intent === 'none') {
      if (deltaY < -4) {
        s.intent = 'swipe-close';
        setIsGesturing(true);
      } else if (deltaY > 6) {
        s.intent = 'resize-down';
        setIsGesturing(true);
      } else {
        return;
      }
    }
    if (s.intent === 'swipe-close') {
      const upPx = Math.max(0, Math.min(160, -deltaY));
      setSwipeUpPx(upPx);
      return;
    }
    const nextRect = resizeMiniFromHandle(s.startRect, Math.max(0, deltaY), dual.viewport);
    dual.setMiniRect(nextRect);
  };

  const onResizePointerUp = (ev: React.PointerEvent<HTMLDivElement>) => {
    const s = resizeSessionRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    resizeSessionRef.current = null;
    setIsGesturing(false);
    setSwipeUpPx(0);
    if (s.intent === 'none') {
      dual.setMiniRect((prev) => toggleMiniPresetWidth(prev, dual.viewport));
      return;
    }
    if (s.intent === 'swipe-close' && s.lastDeltaY <= -16) {
      setExitKind('swipe-up');
      dual.closeMiniWindow();
    }
  };

  const onResizePointerCancel = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (resizeSessionRef.current?.pointerId === ev.pointerId) {
      resizeSessionRef.current = null;
      setIsGesturing(false);
      setSwipeUpPx(0);
    }
  };

  const isSwipingClose = swipeUpPx > 0;
  const swipeProgress = Math.min(1, swipeUpPx / 110);

  const rootClass = isPrimary
    ? `pane-primary-${paneId}${expandAnim ? ' is-expanding-primary' : ''}`
    : `floating-mini-window${isHidden ? ` is-hidden exit-${exitKind}` : ''}${isMiniPip ? ' is-mini-pip' : ''}${isGesturing ? ' is-gesturing' : ''}${isSwipingClose ? ' is-swiping-close' : ''}${topZone === 'maximize' ? ' is-zone-maximize' : ''}${topZone === 'pip-left' || topZone === 'pip-right' ? ' is-zone-pip' : ''}${menuOpen ? ' has-menu-open' : ''}`;

  const rootStyle: React.CSSProperties | undefined = isPrimary
    ? undefined
    : {
        left: `${geo.x}px`,
        top: `${geo.y}px`,
        width: `${geo.width}px`,
        height: `${geo.totalHeight}px`,
        ...(isSwipingClose
          ? {
              transformOrigin: '50% 42%',
              transform: `translateY(${-Math.round(swipeUpPx * 0.45)}px) scale(${(1 - swipeProgress * 0.36).toFixed(3)})`,
              opacity: Number((1 - swipeProgress * 0.45).toFixed(3)),
            }
          : null),
      };

  const viewportStyle = isPrimary
    ? undefined
    : {
        width: `${geo.width}px`,
        height: `${geo.contentHeight}px`,
      };

  const stageStyle = isPrimary
    ? undefined
    : {
        width: `${geo.logicalWidth}px`,
        height: `${geo.logicalHeight}px`,
        transform: `scale(${geo.scale})`,
        transformOrigin: 'top left',
      };

  return (
    <PaneRoleContext.Provider value={mode}>
      <div
        ref={rootRef}
        className={rootClass}
        data-testid={`${testIdPrefix}-pane`}
        data-pane-role={mode}
        aria-hidden={isHidden || undefined}
        style={rootStyle}
      >
        {/* 顶部极简触控条（仅小窗态渲染：按住拖动小窗，轻点弹出/收起选项菜单） */}
        {!isPrimary ? (
          <div
            className="floating-mini-chrome"
            data-testid={`${testIdPrefix}-drag-handle`}
            role="button"
            tabIndex={isHidden ? -1 : 0}
            aria-label={`${title}窗口控制`}
            aria-expanded={menuOpen}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                setMenuOpen((prev) => !prev);
              }
            }}
            onPointerDown={onDragPointerDown}
            onPointerMove={onDragPointerMove}
            onPointerUp={onDragPointerUp}
            onPointerCancel={onDragPointerCancel}
          >
            <span className="floating-drag-pill" data-testid="floating-handle-pill" aria-hidden="true" />
          </div>
        ) : null}

        {/* 中间内容视口：与主屏共享完全一致的 div 层级 */}
        <div
          className={isPrimary ? 'pane-viewport-primary' : 'floating-mini-viewport'}
          style={viewportStyle}
          onPointerDownCapture={() => {
            if (menuOpen) setMenuOpen(false);
          }}
        >
          <div
            className={isPrimary ? 'pane-stage-primary' : 'pane-scaled-stage'}
            data-pane-stage={isPrimary ? undefined : 'true'}
            data-pane-scale={isPrimary ? undefined : String(geo.scale)}
            style={stageStyle}
          >
            <div
              className={isPrimary ? 'pane-scroll-primary' : 'pane-scroll-body'}
              data-pane-scroll={isPrimary ? undefined : 'true'}
              ref={scrollRef}
            >
              {children}
            </div>
            {overlays}
          </div>
        </div>

        {/* 底部贴底横条：上滑立即向心缩小并关闭小窗，下拉放大，轻点切换标准/放大视图 */}
        {!isPrimary ? (
          <div
            className="floating-mini-resize"
            data-testid="floating-resize-handle"
            role="separator"
            aria-label="上滑关闭小窗、下拉放大或轻点切换大小"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerCancel}
          >
            <span className="floating-resize-grip" aria-hidden="true" />
          </div>
        ) : null}

        {/* 轻点顶部横条弹出的悬浮选项菜单（业务小窗与教练小窗完全对称，均具备完整 4 项） */}
        {!isPrimary && !isMiniPip && menuOpen ? (
          <div
            className="floating-handle-menu"
            data-testid="floating-handle-menu"
            role="menu"
            aria-label={`${title}窗口选项`}
          >
            <button
              type="button"
              className="floating-handle-menu-item is-accent"
              data-testid="floating-swap-btn"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                dual.swapPanes();
              }}
            >
              <span className="floating-menu-ico" aria-hidden="true">⇄</span>
              <span>{paneId === 'coach' ? '互换主屏' : '互换回主屏'}</span>
            </button>
            <button
              type="button"
              className="floating-handle-menu-item"
              data-testid="floating-maximize-btn"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                dual.maximizeMiniWindow();
              }}
            >
              <span className="floating-menu-ico" aria-hidden="true">⛶</span>
              <span>最大化</span>
            </button>
            <button
              type="button"
              className="floating-handle-menu-item"
              data-testid="floating-minimize-btn"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setExitKind('minimize');
                dual.minimizeMiniWindow();
              }}
            >
              <span className="floating-menu-ico" aria-hidden="true">−</span>
              <span>最小化</span>
            </button>
            <button
              type="button"
              className="floating-handle-menu-item is-danger"
              data-testid="floating-close-btn"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setExitKind('close');
                dual.closeMiniWindow();
              }}
            >
              <span className="floating-menu-ico" aria-hidden="true">×</span>
              <span>关闭</span>
            </button>
          </div>
        ) : null}

        {/* 迷你悬浮窗覆盖交互盾牌：轻点立即复原标准大小，按住可拖动改位 */}
        {isMiniPip ? (
          <div
            className="floating-pip-shield"
            data-testid="floating-pip-restore-shield"
            role="button"
            tabIndex={0}
            aria-label={`点击复原${title}小窗`}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                dual.restoreFromMiniPip();
              }
            }}
            onPointerDown={onPipPointerDown}
            onPointerMove={onPipPointerMove}
            onPointerUp={onPipPointerUp}
            onPointerCancel={onPipPointerCancel}
          />
        ) : null}

        {/* 顶边三区拖拽的屏级视觉反馈（Portal 到 body 避免被小窗 overflow 裁剪） */}
        {!isPrimary && !isHidden && topZone !== 'none' && typeof document !== 'undefined'
          ? createPortal(
              topZone === 'maximize' ? (
                <div
                  className="floating-maximize-preview"
                  data-testid="floating-maximize-preview"
                  aria-hidden="true"
                >
                  <div className="floating-maximize-badge">⛶ 松手最大化</div>
                </div>
              ) : (
                <div
                  className={`floating-corner-pip-zone ${topZone === 'pip-left' ? 'side-left' : 'side-right'}`}
                  data-testid="floating-corner-pip-zone"
                  aria-hidden="true"
                >
                  <span className="floating-corner-pip-label">◰ 抬手进入</span>
                </div>
              ),
              document.body,
            )
          : null}
      </div>
    </PaneRoleContext.Provider>
  );
}

/** 最小化后的侧边悬浮入口：对教练小窗与业务小窗通用，支持纵向拖动位置，轻点原位恢复小窗 */
export function CoachMinimizedEdgePill() {
  const dual = useOptionalDualWindow();
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origTop: number;
    moved: boolean;
  } | null>(null);

  if (!dual || dual.miniVisibility !== 'minimized') return null;

  const { edgePill, viewport } = dual;
  const isBusinessMinimized = dual.primaryPane === 'coach';
  const pillLabel = isBusinessMinimized ? '训练' : '教练';
  const pillAria = isBusinessMinimized ? '恢复训练小窗' : '恢复电子教练小窗';

  const onPointerDown = (ev: React.PointerEvent<HTMLButtonElement>) => {
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    dragRef.current = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      origTop: edgePill.top,
      moved: false,
    };
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragRef.current;
    if (!s || s.pointerId !== ev.pointerId) return;
    const dx = ev.clientX - s.startX;
    const dy = ev.clientY - s.startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
      s.moved = true;
    }
    if (!s.moved) return;
    const nextTop = clamp(
      s.origTop + dy,
      viewport.safeTop + 60,
      Math.max(viewport.safeTop + 60, viewport.visibleBottom - 80),
    );
    const nextSide = ev.clientX < viewport.width / 2 ? 'left' : 'right';
    dual.setEdgePill({ side: nextSide, top: nextTop });
  };

  const onPointerUp = (ev: React.PointerEvent<HTMLButtonElement>) => {
    const s = dragRef.current;
    dragRef.current = null;
    if (!s || s.pointerId !== ev.pointerId) return;
    if (!s.moved) {
      dual.restoreFromMinimized();
    }
  };

  return (
    <button
      type="button"
      className={`coach-edge-pill side-${edgePill.side}`}
      data-testid="coach-minimized-pill"
      aria-label={pillAria}
      style={{ top: `${edgePill.top}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
    >
      <span className="coach-edge-dot" aria-hidden="true" />
      <span>{pillLabel}</span>
    </button>
  );
}
