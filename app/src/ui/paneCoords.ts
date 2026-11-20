/* 双窗外壳的坐标系与滚动宿主适配。
   当某窗口处于等比缩放悬浮小窗态（.pane-scaled-stage）时，内部卡片拖动、
   消散动画与弹层滚动锁定必须使用所属窗口的滚动容器、缩放比例与逻辑高度，
   而不是误读整页 window.scrollY / window.innerHeight。 */

export interface PaneScrollContext {
  /** 当前内容相对真实屏幕的等比缩放倍率（主屏=1） */
  scale: number;
  /** 逻辑阶段左上角在真实视口中的位置 */
  stageLeft: number;
  stageTop: number;
  /** 逻辑可视高度（主屏=window.innerHeight，小窗=容器逻辑高度） */
  viewportHeight: number;
  /** 若在小窗内滚动则为局部滚动容器；主屏态为 null（走 window） */
  scrollEl: HTMLElement | null;
  /** 当前垂直滚动偏移 */
  scrollTop: number;
  /** 垂直滚动指定增量 */
  scrollBy: (dy: number) => void;
}

export function getPaneScrollContext(el: Element | null): PaneScrollContext {
  if (typeof window === 'undefined') {
    return {
      scale: 1,
      stageLeft: 0,
      stageTop: 0,
      viewportHeight: 800,
      scrollEl: null,
      scrollTop: 0,
      scrollBy: () => {},
    };
  }
  const stage = el?.closest?.('[data-pane-stage="true"]') as HTMLElement | null;
  if (stage) {
    const rawScale = Number(stage.getAttribute('data-pane-scale') ?? '1');
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    const rect = stage.getBoundingClientRect();
    const scrollEl =
      (el?.closest?.('[data-pane-scroll="true"]') as HTMLElement | null) ??
      stage.querySelector<HTMLElement>('[data-pane-scroll="true"]');
    const logicalHeight = stage.clientHeight > 0 ? stage.clientHeight : rect.height / scale;
    return {
      scale,
      stageLeft: rect.left,
      stageTop: rect.top,
      viewportHeight: logicalHeight || window.innerHeight,
      scrollEl,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
      scrollBy: (dy: number) => {
        if (scrollEl) scrollEl.scrollBy(0, dy);
      },
    };
  }
  return {
    scale: 1,
    stageLeft: 0,
    stageTop: 0,
    viewportHeight: window.innerHeight,
    scrollEl: null,
    scrollTop: window.scrollY,
    scrollBy: (dy: number) => {
      window.scrollBy(0, dy);
    },
  };
}

/** 找到元素所属的局部作用域节点（用于 --undo-lift 与局部弹层/滚动锁定） */
export function getPaneScopeRoot(el: Element | null): HTMLElement {
  const stage = el?.closest?.('[data-pane-stage="true"]') as HTMLElement | null;
  if (stage) return stage;
  return document.documentElement;
}
