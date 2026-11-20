/* F10：删除**真实保存成功**后的局部消散与平滑补位（纯表现层，无依赖）。
   ── 纪律（对应本阶段验收口径）────────────────────────────────
   · 只在页面拿到删除事务 oncomplete / saved 之后调用；本模块不读库、不写库、
     不改 Session，也不参与任何 save/undo 判定。request success、buildNext、
     点击删除都不构成调用依据。
   · 所有产物都是**新建的展示节点**：没有 input/button/id/手势/拖动监听，
     pointer-events: none，不进入文档流（absolute），因此不改变布局与滚动范围，
     不截获输入、滚动与键盘焦点。原来的业务卡不在这里保留，也不会有第二份
     可操作的卡片元素。
   · 只在**自己创建的节点**上写样式；`translate` 用于补位（与卡片自身的
     transform 分开，互不覆盖）。卸载 / 切 session / 页面隐藏 / 撤销 / 失锁
     一律清空，且不向新页面注入。
   · 减少动态：不创建任何节点，也不做补位动画，直接落到最终布局。
   · 一次意图一次效果：由调用方用 token 去重；旧回调只能清**自己那一条**。
   · F10-FIX1 归属：补位不能只看"有卡向上移动"，必须由页面提供
     **已提交 Session 里这个对象真的消失了**的证据（见 dissolveAttribution），
     否则慢提交期间其它合法布局变化会被误当成删除成功。 */

function paneScaleAndScroll(el: Element | null): { scale: number; stageTop: number; scrollTop: number } {
  if (typeof window === 'undefined') return { scale: 1, stageTop: 0, scrollTop: 0 };
  const stage = el?.closest?.('[data-pane-stage="true"]') as HTMLElement | null;
  if (stage) {
    const rawScale = Number(stage.getAttribute('data-pane-scale') ?? '1');
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    const scrollEl =
      (el?.closest?.('[data-pane-scroll="true"]') as HTMLElement | null) ??
      stage.querySelector<HTMLElement>('[data-pane-scroll="true"]');
    return {
      scale,
      stageTop: stage.getBoundingClientRect().top,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
    };
  }
  return { scale: 1, stageTop: 0, scrollTop: window.scrollY };
}

/** 消散时长（方案要求 200–300ms） */
export const DISSOLVE_MS = 260;
/** 列表补位时长，与消散同时开始，略短于消散结束 */
export const REFLOW_MS = 240;
/** 消散粒子数（轻量：只做局部点缀，不做全屏 canvas） */
export const DISSOLVE_PARTICLE_COUNT = 10;
/** 补位位移小于该值视为噪声，不做动画（避免 1px 抖动） */
export const REFLOW_MIN_SHIFT = 2;

export type DissolveKind = 'exercise' | 'cardio';

/** 相对所属分区容器的几何（px）；与滚动无关，可直接用于 absolute 定位 */
export interface ZoneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface DissolveParticle {
  /** 起点，相对卡片宽高的百分比 */
  xPct: number;
  yPct: number;
  dx: number;
  dy: number;
  size: number;
  delayMs: number;
  durationMs: number;
  opacity: number;
  tone: 'brick' | 'ink';
}

export interface DissolveGhost {
  /** 本次删除意图的 token（与 preview/undo 同一来源），用于归属与去重 */
  token: string;
  itemId: string;
  kind: DissolveKind;
  name: string;
  rect: ZoneRect;
  startedAt: number;
  durationMs: number;
  particles: DissolveParticle[];
}

/** 稳定的字符串哈希（FNV-1a），让同一 token 得到同一组粒子 */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小、快、可复现（便于测试断言与截图对齐） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一组确定性的消散粒子。
 * 同一 token 永远得到同一组参数：多帧截图/逐帧时间线可比较，也不会每次重排抖动。
 */
export function buildDissolveParticles(seed: string, count = DISSOLVE_PARTICLE_COUNT): DissolveParticle[] {
  const rand = mulberry32(hashSeed(seed));
  const total = Math.max(1, Math.min(24, Math.floor(count)));
  const out: DissolveParticle[] = [];
  for (let i = 0; i < total; i += 1) {
    const xPct = 8 + rand() * 84;
    const yPct = 12 + rand() * 74;
    // 向左上/右上飘散：dx 有正负，dy 始终向上（卡片"向上散掉"，不压到下方邻卡）
    const dx = Math.round((rand() * 2 - 1) * 18);
    const dy = -Math.round(14 + rand() * 26);
    out.push({
      xPct: Math.round(xPct * 10) / 10,
      yPct: Math.round(yPct * 10) / 10,
      dx,
      dy,
      size: Math.round((2.4 + rand() * 2.8) * 10) / 10,
      delayMs: Math.round(rand() * 46),
      durationMs: Math.round(DISSOLVE_MS * (0.72 + rand() * 0.28)),
      opacity: Math.round((0.55 + rand() * 0.4) * 100) / 100,
      tone: rand() < 0.72 ? 'brick' : 'ink',
    });
  }
  return out;
}

/** 减少动态：不播放任何表现层动画（直接完成） */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 本次效果的时长；减少动态时为 0（调用方据此直接跳过） */
export function dissolveTiming(reduced: boolean): { ghostMs: number } {
  return { ghostMs: reduced ? 0 : DISSOLVE_MS };
}

/**
 * 补位位移：只在**向上**移动（前面的卡被删掉）且足够大时返回正数，否则 0。
 *
 * 为什么只做向上：删除失败时页面顶部会出现错误横幅，那会把卡片**向下**推；
 * 那不是补位，不能做出"删掉了一样"的动效（失败不得有假消散/假补位）。
 */
export function reflowShift(prevPageTop: number, nextPageTop: number): number {
  if (!Number.isFinite(prevPageTop) || !Number.isFinite(nextPageTop)) return 0;
  const shift = Math.round(prevPageTop - nextPageTop);
  if (shift <= 0) return 0;
  return shift >= REFLOW_MIN_SHIFT ? shift : 0;
}

/** 页面坐标的卡片顶端（与滚动量无关），key = data-reorder-id */
export function captureCardTops(root?: ParentNode | null): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof document === 'undefined') return out;
  const scope = root ?? document;
  const els = Array.from(scope.querySelectorAll<HTMLElement>('[data-reorder-id]'));
  if (!els.length) return out;
  const ctx = paneScaleAndScroll(els[0]);
  for (const el of els) {
    const id = el.getAttribute('data-reorder-id');
    if (!id) continue;
    out.set(id, (el.getBoundingClientRect().top - ctx.stageTop) / ctx.scale + ctx.scrollTop);
  }
  return out;
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\\]]/g, '\\$&');
}

/**
 * 删除前的惰性几何快照：所属卡的盒子 + 所属分区容器，全部换算成
 * **容器相对坐标**，这样滚动、补位动画都不会影响幽灵的落点。
 */
export function captureDeleteRect(itemId: string, kind: DissolveKind): ZoneRect | null {
  if (typeof document === 'undefined') return null;
  const card = document.querySelector<HTMLElement>(`[data-reorder-id="${cssEscape(itemId)}"]`);
  if (!card) return null;
  const ctx = paneScaleAndScroll(card);
  const zone =
    card.closest<HTMLElement>('[data-reorder-zone]') ??
    document.querySelector<HTMLElement>(`[data-reorder-zone="${kind === 'cardio' ? 'cardio' : 'strength'}"]`);
  const cardRect = card.getBoundingClientRect();
  const zoneRect = zone ? zone.getBoundingClientRect() : { top: 0, left: 0 };
  return {
    top: (cardRect.top - zoneRect.top) / ctx.scale,
    left: (cardRect.left - zoneRect.left) / ctx.scale,
    width: cardRect.width / ctx.scale,
    height: cardRect.height / ctx.scale,
  };
}

/**
 * 平滑补位（FLIP）：用**页面坐标**比较删除前/后的卡片位置，
 * 把差值作为反向 `translate` 先写回去，再在下一帧过渡到 0。
 *
 * · 只写 `translate`（独立属性），不与卡片自身的 `transform` 抢写；
 * · 先做一次强制回流，保证过渡真的从旧位置开始，不会先跳到终点；
 * · 只要用户一按下（pointerdown/touchstart）就立刻收尾到最终布局，
 *   绝不因为补位动画影响手势、拖动或点击；
 * · 返回的清理函数可重复调用，且只碰仍然连在文档里的元素；
 *   没有任何卡发生向上位移时返回 null（调用方据此保留待生效批次）。
 */
export function applyReflowAnimation(prevTops: Map<string, number>): (() => void) | null {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !prevTops.size) {
    return null;
  }
  const touched: HTMLElement[] = [];
  const els = Array.from(document.querySelectorAll<HTMLElement>('[data-reorder-id]'));
  if (!els.length) return null;
  const ctx = paneScaleAndScroll(els[0]);
  for (const el of els) {
    const id = el.getAttribute('data-reorder-id');
    if (!id) continue;
    const prev = prevTops.get(id);
    if (prev === undefined) continue;
    const shift = reflowShift(prev, (el.getBoundingClientRect().top - ctx.stageTop) / ctx.scale + ctx.scrollTop);
    if (!shift) continue;
    el.style.setProperty('translate', `0 ${shift}px`);
    el.style.setProperty('transition', 'none');
    touched.push(el);
  }
  // 没有任何卡片真的向上移动：本次不构成补位（例如只是 busy 状态触发的重渲染）
  if (!touched.length) return null;

  /** 收尾：把元素交还给最终布局（translate/transition 都不留残留） */
  let done = false;
  const finalize = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    window.cancelAnimationFrame(raf);
    document.removeEventListener('pointerdown', finalize, true);
    document.removeEventListener('touchstart', finalize, true);
    for (const el of touched) {
      if (!el.isConnected) continue;
      el.style.removeProperty('translate');
      el.style.removeProperty('transition');
    }
  };

  // 强制一次样式计算：确保下一步的过渡从"位移后的当前位置"开始
  void document.body.offsetHeight;
  const raf = window.requestAnimationFrame(() => {
    if (done) return;
    for (const el of touched) {
      if (!el.isConnected) continue;
      el.style.setProperty('transition', `translate ${REFLOW_MS}ms cubic-bezier(.22,.61,.36,1)`);
      el.style.setProperty('translate', '0 0');
    }
  });
  const timer = window.setTimeout(finalize, REFLOW_MS + 80);
  // 用户一按下就收尾：补位动画绝不抢手势/拖动/点击
  document.addEventListener('pointerdown', finalize, true);
  document.addEventListener('touchstart', finalize, true);
  return finalize;
}

/* ── F10-FIX1：补位的"成功归属"判定 ────────────────────────────
   背景：慢事务（真实 IDB 提交 2s+）期间，用户仍可能折叠/展开记录、输入数值，
   列表本来就可能在动。仅凭"某张卡向上移动"就播放补位，会把非删除的布局变化
   误当成删除成功（假补位）。因此补位必须同时满足：

     ① 还是同一次捕获（epoch 未因卸载/切 session/隐藏/失锁失效）；
     ② 还是同一个 Session；
     ③ 被删对象**已经不在**该 Session 的已提交快照里（真的删掉了）；
     ④ 版本比下达命令时更新（证明这是一个真实提交，而不是旧快照重放）。

   本模块不定义"什么是保存成功"—— 它只读页面交来的已提交快照与版本，
   成功与否仍由事务 oncomplete / saved 决定。 */

export interface DissolvePending {
  /** 下达删除命令时的捕获世代 */
  epoch: number;
  /** 删除意图 token（与 preview / undo 同源） */
  token: string;
  /** 命令所属 Session */
  sessionId: string;
  /** 本次要删除的对象 */
  itemId: string;
  kind: DissolveKind;
  /** 下达命令时本页已确认落库的版本 */
  revision: number;
}

/** 已提交 Session 快照里是否仍包含该条目 */
export function sessionHasItem(
  session:
    | {
        exercises: ReadonlyArray<{ id: string }>;
        cardio?: ReadonlyArray<{ id: string }>;
      }
    | undefined
    | null,
  kind: DissolveKind,
  itemId: string,
): boolean {
  if (!session) return false;
  const list = kind === 'cardio' ? (session.cardio ?? []) : session.exercises;
  return list.some((item) => item.id === itemId);
}

export type AttributionVerdict = 'wait' | 'match' | 'reject';

/**
 * 判定这次渲染能否作为"本删除已提交"的补位时机。
 *
 * · `wait`   —— 还没到那个时候（条目仍在，继续等下一次渲染；不是失败）
 * · `match`  —— 同一次捕获 / 同一个 Session / 条目已移除 / 版本已前进
 * · `reject` —— 越页、换 Session、或条目消失但没有对应的版本前进（不是本删除）
 */
export function dissolveAttribution(args: {
  pending: Pick<DissolvePending, 'epoch' | 'sessionId' | 'itemId' | 'kind' | 'revision'>;
  epoch: number;
  session:
    | {
        id: string;
        /** 已提交版本；缺省时跳过"版本必须前进"这一条，只以条目消失为准 */
        revision?: number;
        exercises: ReadonlyArray<{ id: string }>;
        cardio?: ReadonlyArray<{ id: string }>;
      }
    | undefined
    | null;
}): AttributionVerdict {
  const { pending, epoch, session } = args;
  if (pending.epoch !== epoch) return 'reject';
  if (!session || session.id !== pending.sessionId) return 'reject';
  if (sessionHasItem(session, pending.kind, pending.itemId)) return 'wait';
  // 条目已消失：还要求版本相对命令时前进，排除"旧快照重放/与本删除无关的移除"
  if (typeof session.revision === 'number' && session.revision <= pending.revision) return 'reject';
  return 'match';
}
