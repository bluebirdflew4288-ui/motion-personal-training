/* G3B：卡片手势的纯判定函数 + 单一拖动协调器。
   ── 为什么拆开 ────────────────────────────────────────────────
   · 纯函数（方向判定 / 落点索引 / 自动滚动速度）可以在 node 里穷举；
   · 协调器只持有**一份**拖动状态与**一个** RAF，避免每张卡各自监听导致多写、多滚；
   · 组件只上报指针事件，不做方向裁决，保证"正常纵滚不误拖、左滑不误拖"。 */

export type GestureAxis = 'undecided' | 'vertical' | 'horizontal';

/**
 * 长按激活阈值（毫秒）：到点后整卡浮起进入拖动。
 *
 * G01-R2：必须早于 Android 原生文本选择的长按超时（AOSP ViewConfiguration
 * 默认 400ms，OEM 可能更短/更长）——0.1.10 用 420ms 时，原生长按先启动选区
 * 并发出 pointercancel，应用侧拖动刚/尚未开始就被取消。340ms 让应用先进入
 * 拖动（卡片随即 pointer-events:none），再叠加展示区不可选中规则。
 */
export const LONG_PRESS_MS = 340;
/** 方向判定阈值（px）：小于它仍属"未决"，不抢手势 */
export const AXIS_THRESHOLD = 10;
/** 左滑操作层宽度（与 SwipeActionCard 保持一致） */
export const SWIPE_ACTION_WIDTH = 140;
/**
 * F09：左滑到达最大操作区后需保持约 750ms 才能进入删除就绪态。
 */
export const SWIPE_READY_HOLD_MS = 750;
/** F09：手势停留时的微小手指抖动容差（px） */
export const SWIPE_JITTER_TOLERANCE = 8;
/** F09-FIX1：就绪后或左滑中识别为明确纵向移动意图的 Y 位移阈值（px） */
export const SWIPE_VERTICAL_INTENT_THRESHOLD = 20;
/** F09：就绪状态提示文案（空白直删 vs 有风险先确认） */
export const SWIPE_PROMPT_BLANK = '松开手指可删除';
export const SWIPE_PROMPT_CONFIRM = '松开以确认删除';
/**
 * 左滑展开/回位/收回的过渡时长（ms）。
 *
 * 方案建议 180–220ms。FIX1 起该常量同时被"切换卡闸门"引用：
 * 一张卡回位需要这么长时间，另一张卡的手势必须等它完成才开始产生位移
 * （R1-2：任意时刻全页最多一张卡**实际**左移）。
 */
export const SWIPE_SETTLE_MS = 180;
/** 闸门额外宽限（ms）：覆盖 store 变化到下一帧开始过渡的延迟 */
export const TAKEOVER_GUARD_MS = 25;

/**
 * 卡片之间（以及卡片区顶部）的留白（px）。
 *
 * F02：留白必须位于**卡片之外**，操作区只覆盖卡片自身可见边界。
 * 该常量同时用于卡片容器的上内边距与操作层的上边界，避免两处各写一个数字后再次错位。
 */
export const CARD_GAP = 14;

/**
 * 方向判定：**只有明确横向**才进入左滑，**明确纵向**交给页面滚动。
 * 斜滑在未超过阈值前保持未决，超过后按主轴归类。
 */
export function decideAxis(dx: number, dy: number, threshold = AXIS_THRESHOLD): GestureAxis {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return 'undecided';
  return Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
}

/**
 * 落点索引：按各卡片中线与指针 Y 比较，返回插入位置（0..n）。
 *
 * @param pointerY 当前指针/触摸的页面 Y（含滚动偏移后的视口坐标）
 * @param rects    同一分区内各卡片（**当前视觉顺序**）的矩形
 */
export function dropIndexFor(
  pointerY: number,
  rects: ReadonlyArray<{ top: number; height: number }>,
): number {
  let index = 0;
  for (const r of rects) {
    if (pointerY > r.top + r.height / 2) index += 1;
  }
  return Math.max(0, Math.min(index, rects.length));
}

/**
 * 自动滚动速度（px/帧）。越靠近边缘越快；离开边缘返回 0。
 *
 * @param pointerY 指针视口 Y
 * @param viewportTop 可见区域上界（通常是 0）
 * @param viewportBottom 可见区域下界（通常是 window.innerHeight）
 * @param edge 边缘感应带宽度
 * @param maxSpeed 最大速度（px/帧）
 */
export function autoScrollVelocity(
  pointerY: number,
  viewportTop: number,
  viewportBottom: number,
  edge = 72,
  maxSpeed = 18,
): number {
  if (pointerY < viewportTop + edge) {
    const depth = Math.min(1, (viewportTop + edge - pointerY) / edge);
    return -Math.round(maxSpeed * depth);
  }
  if (pointerY > viewportBottom - edge) {
    const depth = Math.min(1, (pointerY - (viewportBottom - edge)) / edge);
    return Math.round(maxSpeed * depth);
  }
  return 0;
}

/** 把「拖动的起点索引 → 目标插入位置」换算成最终 ID 顺序（插入语义，非交换） */
export function orderAfterDrop(
  ids: readonly string[],
  fromIndex: number,
  insertIndex: number,
): string[] {
  const rest = ids.filter((_, i) => i !== fromIndex);
  // 删除起点后，落点在原数组里需要左移一位（当落点在起点之后）
  const target = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
  const next = [...rest];
  next.splice(Math.max(0, Math.min(target, next.length)), 0, ids[fromIndex]);
  return next;
}
