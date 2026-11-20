/* 双窗外壳状态与几何计算（业务页 + 电子教练持久双实例）。
   核心不变量：
   1. 业务壳与教练壳同壳持久挂载：主次互换只切换布局角色与等比缩放参数，不卸载业务页或训练页。
   2. 触摸热区独立于内容缩放：48dp 互换/控制按钮位于外框未缩放栏。
   3. 关闭教练 / 取消生成 / 撤销业务修改 三语义严格分离。 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { registerCoachBackHandler } from '../lib/nativeBack';

export type PaneId = 'business' | 'coach';
export type MiniWindowVisibility = 'closed' | 'mini' | 'minimized';
export type MiniPipCorner = 'top-left' | 'top-right' | null;
export type CoachVisibility = 'closed' | 'mini' | 'minimized' | 'primary';

export interface MiniWindowRect {
  x: number;
  y: number;
  width: number;
  aspect: number;
}

export interface EdgePillPos {
  side: 'left' | 'right';
  top: number;
}

export interface ViewportMetrics {
  width: number;
  height: number;
  /** 键盘弹出时被压缩后的实际可视底部（用于自动抬高/夹取小窗，避免遮挡输入行） */
  visibleBottom: number;
  safeTop: number;
}

export const LOGICAL_MINI_BASE_WIDTH = 375;
export const MINI_CHROME_TOP_PX = 24;
export const MINI_CHROME_BOTTOM_PX = 18;
export const MINI_MIN_WIDTH = 204;
export const MINI_PIP_WIDTH = 112;
export const MINI_MAX_WIDTH_RATIO = 0.88;
export const MINI_DEFAULT_ASPECT = 1.46;

export function clamp(val: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, val));
}

export function computeDefaultMiniRect(vp: ViewportMetrics): MiniWindowRect {
  const maxW = Math.max(MINI_MIN_WIDTH, Math.round(vp.width * MINI_MAX_WIDTH_RATIO));
  const targetDefaultW = Math.max(MINI_MIN_WIDTH + 32, Math.round(vp.width * 0.62));
  const width = clamp(targetDefaultW, MINI_MIN_WIDTH, Math.min(264, maxW));
  const totalHeight = Math.round(width * MINI_DEFAULT_ASPECT) + MINI_CHROME_TOP_PX + MINI_CHROME_BOTTOM_PX;
  const maxTop = Math.max(vp.safeTop + 8, vp.visibleBottom - totalHeight - 8);
  const y = clamp(vp.safeTop + 72, vp.safeTop + 8, maxTop);
  const x = clamp(vp.width - width - 12, 8, Math.max(8, vp.width - width - 8));
  return { x, y, width, aspect: MINI_DEFAULT_ASPECT };
}

/** 轻点底部缩放横条或顶部菜单尺寸项时：在标准宽度与放大视图间平滑切换 */
export function toggleMiniPresetWidth(currentRect: MiniWindowRect, vp: ViewportMetrics): MiniWindowRect {
  const geo = computeMiniGeometry(currentRect, vp);
  const defaultW = computeDefaultMiniRect(vp).width;
  const maxAllowedW = Math.max(MINI_MIN_WIDTH, Math.round(vp.width * MINI_MAX_WIDTH_RATIO));
  const expandedW = clamp(
    Math.round(vp.width * 0.78),
    Math.min(maxAllowedW, defaultW + 36),
    maxAllowedW,
  );
  const nextWidth = Math.abs(geo.width - defaultW) > 12 ? defaultW : expandedW;
  const nextGeo = computeMiniGeometry({ ...currentRect, x: geo.x, y: geo.y, width: nextWidth }, vp);
  return {
    x: nextGeo.x,
    y: nextGeo.y,
    width: nextGeo.width,
    aspect: currentRect.aspect,
  };
}

export function computeMiniGeometry(
  rect: MiniWindowRect,
  vp: ViewportMetrics,
  allowPipWidth = false,
): {
  x: number;
  y: number;
  width: number;
  contentHeight: number;
  totalHeight: number;
  logicalWidth: number;
  logicalHeight: number;
  scale: number;
} {
  const minLimit = allowPipWidth ? MINI_PIP_WIDTH : MINI_MIN_WIDTH;
  const maxW = Math.max(minLimit, Math.round(vp.width * MINI_MAX_WIDTH_RATIO));
  const minW = Math.min(minLimit, maxW);
  const maxAvailHeight = Math.max(150, vp.visibleBottom - vp.safeTop - 16);
  const maxWByHeight = Math.floor(
    (maxAvailHeight - MINI_CHROME_TOP_PX - MINI_CHROME_BOTTOM_PX) / Math.max(0.8, rect.aspect),
  );
  const effectiveMaxW = Math.max(minW, Math.min(maxW, maxWByHeight));
  const width = clamp(Math.round(rect.width), minW, effectiveMaxW);
  const contentHeight = Math.round(width * rect.aspect);
  const totalHeight = contentHeight + MINI_CHROME_TOP_PX + MINI_CHROME_BOTTOM_PX;
  const x = clamp(Math.round(rect.x), 8, Math.max(8, vp.width - width - 8));
  const maxTop = Math.max(vp.safeTop + 8, vp.visibleBottom - totalHeight - 8);
  const y = clamp(Math.round(rect.y), vp.safeTop + 8, maxTop);
  const logicalWidth = LOGICAL_MINI_BASE_WIDTH;
  const scale = width / logicalWidth;
  const logicalHeight = Math.max(260, Math.round(contentHeight / scale));
  return {
    x,
    y,
    width,
    contentHeight,
    totalHeight,
    logicalWidth,
    logicalHeight,
    scale,
  };
}

/** 底部把手上滑缩小 / 下拉放大：以视觉高度增量按等比换算为宽度变化 */
export function resizeMiniFromHandle(
  startRect: MiniWindowRect,
  deltaY: number,
  vp: ViewportMetrics,
): MiniWindowRect {
  const startGeo = computeMiniGeometry(startRect, vp);
  const aspect = Math.max(0.9, startRect.aspect);
  const targetContentH = startGeo.contentHeight + deltaY;
  const rawWidth = Math.round(targetContentH / aspect);
  const maxW = Math.max(MINI_MIN_WIDTH, Math.round(vp.width * MINI_MAX_WIDTH_RATIO));
  const maxAvailHeight = Math.max(180, vp.visibleBottom - vp.safeTop - 16);
  const maxWByHeight = Math.floor((maxAvailHeight - MINI_CHROME_TOP_PX - MINI_CHROME_BOTTOM_PX) / aspect);
  const effectiveMaxW = Math.max(MINI_MIN_WIDTH, Math.min(maxW, maxWByHeight));
  const nextWidth = clamp(rawWidth, Math.min(MINI_MIN_WIDTH, effectiveMaxW), effectiveMaxW);
  const nextGeo = computeMiniGeometry({ ...startRect, width: nextWidth }, vp);
  // 若从屏幕左侧或右侧放大，维持左右安全边距，尽量保持顶边不变（仅触底时轻抬顶边）
  return {
    x: nextGeo.x,
    y: nextGeo.y,
    width: nextGeo.width,
    aspect,
  };
}

function readViewportMetrics(): ViewportMetrics {
  if (typeof window === 'undefined') {
    return { width: 390, height: 844, visibleBottom: 844, safeTop: 0 };
  }
  const width = window.innerWidth || 390;
  const height = window.innerHeight || 844;
  const vv = window.visualViewport;
  const vvBottom = vv ? Math.round(vv.height + vv.offsetTop) : height;
  const visibleBottom = Math.min(height, vvBottom);
  let safeTop = 0;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--safe-top').trim();
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed) && parsed > 0) safeTop = Math.round(parsed);
  } catch {
    safeTop = 0;
  }
  return { width, height, visibleBottom, safeTop };
}

export interface DualWindowContextValue {
  /** 当前主屏显示的窗口 */
  primaryPane: PaneId;
  /** 当前悬浮小窗（即非主屏的那一端：教练或业务页）的显示状态 */
  miniVisibility: MiniWindowVisibility;
  /** 若当前小窗被拖入左上/右上角，则为迷你悬浮窗停靠角 */
  miniPipCorner: MiniPipCorner;
  /** 教练当前状态（向后兼容派生值） */
  coachVisibility: CoachVisibility;
  /** 教练窗口是否曾经开启过（首次开启后持久挂载，关闭仅隐藏不卸载） */
  hasOpenedCoach: boolean;
  /** 悬浮小窗当前矩形 */
  miniRect: MiniWindowRect;
  /** 已计算的悬浮小窗实际几何 */
  miniGeometry: ReturnType<typeof computeMiniGeometry>;
  /** 最小化侧边入口位置 */
  edgePill: EdgePillPos;
  /** 视口尺寸与键盘可视底边 */
  viewport: ViewportMetrics;
  /** 业务页内滚容器引用（处于小窗态时启用） */
  businessScrollRef: React.RefObject<HTMLDivElement | null>;
  /** 教练消息列表滚动容器引用 */
  coachScrollRef: React.RefObject<HTMLDivElement | null>;
  /** 动作 */
  openCoachMini: () => void;
  openMiniWindow: () => void;
  swapPanes: () => void;
  minimizeMiniWindow: () => void;
  closeMiniWindow: () => void;
  maximizeMiniWindow: () => void;
  enterMiniPip: (corner: 'top-left' | 'top-right') => void;
  restoreFromMiniPip: () => void;
  minimizeCoach: () => void;
  restoreFromMinimized: () => void;
  closeCoach: () => void;
  setMiniRect: (next: MiniWindowRect | ((prev: MiniWindowRect) => MiniWindowRect)) => void;
  setEdgePill: (next: EdgePillPos | ((prev: EdgePillPos) => EdgePillPos)) => void;
}

const DualWindowContext = createContext<DualWindowContextValue | null>(null);

export function DualWindowProvider({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState<ViewportMetrics>(readViewportMetrics);
  const [primaryPane, setPrimaryPane] = useState<PaneId>('business');
  const [miniVisibility, setMiniVisibility] = useState<MiniWindowVisibility>('closed');
  const [miniPipCorner, setMiniPipCorner] = useState<MiniPipCorner>(null);
  const [hasOpenedCoach, setHasOpenedCoach] = useState(false);
  const [miniRect, setMiniRect] = useState<MiniWindowRect>(() => computeDefaultMiniRect(readViewportMetrics()));
  const prePipRectRef = useRef<MiniWindowRect | null>(null);
  const [edgePill, setEdgePill] = useState<EdgePillPos>(() => ({
    side: 'right',
    top: Math.round(readViewportMetrics().height * 0.42),
  }));

  const coachVisibility: CoachVisibility = primaryPane === 'coach' ? 'primary' : miniVisibility;

  const businessScrollRef = useRef<HTMLDivElement | null>(null);
  const coachScrollRef = useRef<HTMLDivElement | null>(null);

  /** 主屏 ↔ 小窗互换时保留业务页滚动位置（window.scrollY <-> inner scrollTop） */
  const savedBusinessScrollYRef = useRef(0);
  const prevBusinessPrimaryRef = useRef(true);

  useEffect(() => {
    const syncVp = () => setViewport(readViewportMetrics());
    syncVp();
    window.addEventListener('resize', syncVp);
    window.addEventListener('orientationchange', syncVp);
    window.visualViewport?.addEventListener('resize', syncVp);
    window.visualViewport?.addEventListener('scroll', syncVp);
    return () => {
      window.removeEventListener('resize', syncVp);
      window.removeEventListener('orientationchange', syncVp);
      window.visualViewport?.removeEventListener('resize', syncVp);
      window.visualViewport?.removeEventListener('scroll', syncVp);
    };
  }, []);

  const businessIsPrimary = primaryPane === 'business';

  useLayoutEffect(() => {
    const wasPrimary = prevBusinessPrimaryRef.current;
    prevBusinessPrimaryRef.current = businessIsPrimary;
    if (wasPrimary === businessIsPrimary) return;

    if (!businessIsPrimary) {
      // Business: primary -> mini：把刚才在主屏保存的 window.scrollY 恢复到内滚容器
      const targetEl = businessScrollRef.current;
      if (targetEl) {
        targetEl.scrollTop = savedBusinessScrollYRef.current;
      }
    } else {
      // Business: mini -> primary：把刚才在小窗内记录的 scrollTop 恢复回 window.scrollTo
      window.scrollTo({ top: savedBusinessScrollYRef.current, behavior: 'auto' });
    }
  }, [businessIsPrimary]);

  const exitPipRectIfNeeded = useCallback(() => {
    if (miniPipCorner === null) return;
    const target = prePipRectRef.current ?? computeDefaultMiniRect(viewport);
    prePipRectRef.current = null;
    setMiniPipCorner(null);
    setMiniRect(target);
  }, [miniPipCorner, viewport]);

  const openCoachMini = useCallback(() => {
    exitPipRectIfNeeded();
    setHasOpenedCoach(true);
    setPrimaryPane('business');
    setMiniVisibility('mini');
  }, [exitPipRectIfNeeded]);

  const openMiniWindow = useCallback(() => {
    exitPipRectIfNeeded();
    setHasOpenedCoach(true);
    setMiniVisibility('mini');
  }, [exitPipRectIfNeeded]);

  const swapPanes = useCallback(() => {
    exitPipRectIfNeeded();
    if (miniVisibility === 'closed' || miniVisibility === 'minimized') {
      setHasOpenedCoach(true);
      setMiniVisibility('mini');
      return;
    }
    if (primaryPane === 'business') {
      savedBusinessScrollYRef.current = typeof window !== 'undefined' ? window.scrollY : 0;
      setHasOpenedCoach(true);
      setPrimaryPane('coach');
      setMiniVisibility('mini');
    } else {
      savedBusinessScrollYRef.current =
        businessScrollRef.current?.scrollTop ?? savedBusinessScrollYRef.current;
      setPrimaryPane('business');
      setMiniVisibility('mini');
    }
  }, [exitPipRectIfNeeded, miniVisibility, primaryPane]);

  /** 将当前悬浮小窗（无论教练小窗还是业务小窗）最小化为侧边胶囊，保持当前主屏不变 */
  const minimizeMiniWindow = useCallback(() => {
    if (primaryPane === 'coach' && businessScrollRef.current) {
      savedBusinessScrollYRef.current = businessScrollRef.current.scrollTop;
    }
    setMiniVisibility('minimized');
  }, [primaryPane]);

  /** 关闭当前悬浮小窗（无论教练小窗还是业务小窗），保持当前主屏全屏无遮挡 */
  const closeMiniWindow = useCallback(() => {
    if (primaryPane === 'coach' && businessScrollRef.current) {
      savedBusinessScrollYRef.current = businessScrollRef.current.scrollTop;
    }
    exitPipRectIfNeeded();
    setMiniVisibility('closed');
  }, [exitPipRectIfNeeded, primaryPane]);

  /** 将当前悬浮小窗最大化为全屏主屏并关闭另一端小窗（顶部菜单「最大化」与拖至顶中松手共用） */
  const maximizeMiniWindow = useCallback(() => {
    exitPipRectIfNeeded();
    if (primaryPane === 'business') {
      savedBusinessScrollYRef.current = typeof window !== 'undefined' ? window.scrollY : 0;
      setHasOpenedCoach(true);
      setPrimaryPane('coach');
      setMiniVisibility('closed');
    } else {
      savedBusinessScrollYRef.current =
        businessScrollRef.current?.scrollTop ?? savedBusinessScrollYRef.current;
      setPrimaryPane('business');
      setMiniVisibility('closed');
    }
  }, [exitPipRectIfNeeded, primaryPane]);

  /** 拖至左上角或右上角抬手进入迷你悬浮窗 */
  const enterMiniPip = useCallback(
    (corner: 'top-left' | 'top-right') => {
      if (miniPipCorner === null) {
        prePipRectRef.current = miniRect;
      }
      const pipTotalH =
        Math.round(MINI_PIP_WIDTH * miniRect.aspect) + MINI_CHROME_TOP_PX + MINI_CHROME_BOTTOM_PX;
      const y = clamp(
        viewport.safeTop + 12,
        viewport.safeTop + 8,
        Math.max(viewport.safeTop + 8, viewport.visibleBottom - pipTotalH - 8),
      );
      const x =
        corner === 'top-left'
          ? 10
          : Math.max(8, viewport.width - MINI_PIP_WIDTH - 10);
      setMiniPipCorner(corner);
      setMiniRect((prev) => ({
        ...prev,
        x,
        y,
        width: MINI_PIP_WIDTH,
      }));
    },
    [miniPipCorner, miniRect, viewport],
  );

  /** 轻点迷你悬浮窗复原为进入前的常规尺寸与位置 */
  const restoreFromMiniPip = useCallback(() => {
    const target = prePipRectRef.current ?? computeDefaultMiniRect(viewport);
    prePipRectRef.current = null;
    setMiniPipCorner(null);
    setMiniRect(target);
  }, [viewport]);

  /** 教练主屏顶栏「−」或「×」：收起教练本身并回到业务主屏 */
  const minimizeCoach = useCallback(() => {
    if (primaryPane === 'coach' && businessScrollRef.current && miniVisibility === 'mini') {
      savedBusinessScrollYRef.current = businessScrollRef.current.scrollTop;
    }
    setPrimaryPane('business');
    setMiniVisibility('minimized');
  }, [primaryPane, miniVisibility]);

  const restoreFromMinimized = useCallback(() => {
    setHasOpenedCoach(true);
    setMiniVisibility('mini');
  }, []);

  const closeCoach = useCallback(() => {
    if (primaryPane === 'coach' && businessScrollRef.current && miniVisibility === 'mini') {
      savedBusinessScrollYRef.current = businessScrollRef.current.scrollTop;
    }
    exitPipRectIfNeeded();
    setPrimaryPane('business');
    setMiniVisibility('closed');
  }, [exitPipRectIfNeeded, primaryPane, miniVisibility]);

  // 四层 Android 返回键第 3 层：
  // 1) 若当前有悬浮小窗正在显示（无论教练在主屏还是业务在主屏），先消费小窗：
  //    教练在主屏 -> 退回业务主屏+教练小窗；业务在主屏 -> 教练小窗最小化；
  // 2) 若教练在主屏且业务小窗已被最小化/关闭 -> 退回业务主屏+教练小窗。
  useEffect(() => {
    return registerCoachBackHandler(() => {
      if (primaryPane === 'coach') {
        if (miniVisibility === 'mini') {
          savedBusinessScrollYRef.current =
            businessScrollRef.current?.scrollTop ?? savedBusinessScrollYRef.current;
        }
        setPrimaryPane('business');
        setMiniVisibility('mini');
        return true;
      }
      if (miniVisibility === 'mini') {
        setMiniVisibility('minimized');
        return true;
      }
      return false;
    });
  }, [primaryPane, miniVisibility]);

  const miniGeometry = useMemo(
    () => computeMiniGeometry(miniRect, viewport, miniPipCorner !== null),
    [miniRect, viewport, miniPipCorner],
  );

  const value = useMemo<DualWindowContextValue>(
    () => ({
      primaryPane,
      miniVisibility,
      miniPipCorner,
      coachVisibility,
      hasOpenedCoach,
      miniRect,
      miniGeometry,
      edgePill,
      viewport,
      businessScrollRef,
      coachScrollRef,
      openCoachMini,
      openMiniWindow,
      swapPanes,
      minimizeMiniWindow,
      closeMiniWindow,
      maximizeMiniWindow,
      enterMiniPip,
      restoreFromMiniPip,
      minimizeCoach,
      restoreFromMinimized,
      closeCoach,
      setMiniRect,
      setEdgePill,
    }),
    [
      primaryPane,
      miniVisibility,
      miniPipCorner,
      coachVisibility,
      hasOpenedCoach,
      miniRect,
      miniGeometry,
      edgePill,
      viewport,
      openCoachMini,
      openMiniWindow,
      swapPanes,
      minimizeMiniWindow,
      closeMiniWindow,
      maximizeMiniWindow,
      enterMiniPip,
      restoreFromMiniPip,
      minimizeCoach,
      restoreFromMinimized,
      closeCoach,
    ],
  );

  return <DualWindowContext.Provider value={value}>{children}</DualWindowContext.Provider>;
}

export function useDualWindow(): DualWindowContextValue {
  const ctx = useContext(DualWindowContext);
  if (!ctx) {
    throw new Error('useDualWindow 必须在 DualWindowProvider 内使用');
  }
  return ctx;
}

/** 可选版本：在独立测试挂载单个页面而不包裹 DualWindowProvider 时安全降级 */
export function useOptionalDualWindow(): DualWindowContextValue | null {
  return useContext(DualWindowContext);
}
