/* 极简 hash 路由：静态服务器不需要 rewrite，刷新不会 404。 */
import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart || '/';
  return {
    path,
    parts: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryPart ?? ''),
  };
}

/**
 * 当前**已生效**的路由快照（供历史拦截回滚用）。
 * 模块级而不是组件级：多个页面共享同一个真相，避免各自为政。
 */
let currentHash = typeof window !== 'undefined' ? window.location.hash : '';

/**
 * 当前**已生效**条目在历史栈中的序号（B4-R3 closure · N05 历史栈保护）。
 *
 * <h2>旧实现的真实缺口</h2>
 * 守卫阻止一次真实浏览器 Back 时，旧代码用
 * {@code history.replaceState(null,'',currentHash)} 把 hash "回滚"回去。
 * 但这时浏览器**已经移动到上一条记录**了 —— replaceState 改的是
 * **那一条（管理页）记录的 URL**，于是：
 * <pre>
 *   栈：[/]，[管理] ← 被改写成 [编辑日]，[编辑日]
 *   取消后按 Back → 直接跳首页（管理页记录已被覆盖）
 *   原期望：回到管理页；Forward 应回到同一编辑日
 * </pre>
 *
 * <h2>现在的做法（保持真实索引/前后关系）</h2>
 * 每条由本应用压入的记录都带一个 {@code __motionIdx} 序号；
 * 被阻止时**不修改任何记录的 URL**，而是用 {@code history.go(delta)}
 * 把浏览器的**当前位置**送回原来那条记录。历史栈内容与顺序完全不变，
 * 因此事后 Back 仍回到管理页、Forward 仍回到同一编辑日，
 * 既不吞 Forward，也不丢 dirty 草稿。
 */
const IDX_KEY = '__motionIdx';

function readIdx(state: unknown): number | null {
  if (!state || typeof state !== 'object') return null;
  const v = (state as Record<string, unknown>)[IDX_KEY];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 当前条目的**历史栈位置**（0 基）；null 表示还没播种。
 *
 * **必须是"实际相对位置"，不能是全局唯一递增号**
 * （Codex 只读审源指出的真实窗口）：
 * <pre>
 *   Home(idx0) → 管理(idx1) → 编辑(idx2)
 *   clean Back 到管理(1)      ← 物理位置 1
 *   再从管理 navigate 编辑     ← 浏览器会截断 forward 分支，新条目物理位置只能是 2
 *   若用全局计数发 idx3 → 之后 dirty Back 到 1 时会 go(3-1)=go(2)，
 *   而前方物理只有 1 个条目 → 回不到编辑页，且反复回退/重进会持续拉大差值
 * </pre>
 * 因此 push 一律用 {@code currentIdx + 1}（当前位置的下一个物理位置），
 * POP 被允许时把 currentIdx 更新为目标条目的序号。
 */
let currentIdx: number | null = null;

/**
 * 下一个 push 条目应有的序号 = **当前物理位置 + 1**。
 *
 * 纯函数导出，便于离线回归"截断 forward 分支后仍物理相邻"。
 */
export function nextPushIdx(current: number | null): number {
  return (current ?? 0) + 1;
}

/** 在当前（已生效）历史条目上播种序号，不改变 URL 与栈结构 */
function seedCurrentIdx(): void {
  if (currentIdx !== null) return;
  try {
    const prev = window.history.state;
    const incoming = readIdx(prev);
    /**
     * 没有戳记时（首次进入本应用版本 / 外部入口）：
     * 用 `history.length - 1` 作为**最佳估计**的物理位置（通常是栈里最新一条）。
     * 只要之后每条记录都由本应用打戳，后续 delta 就都基于真实位置。
     */
    const fallback =
      typeof window.history.length === 'number' && window.history.length > 0
        ? window.history.length - 1
        : 0;
    const next = incoming ?? fallback;
    window.history.replaceState({ ...(prev ?? {}), [IDX_KEY]: next }, '', window.location.href);
    currentIdx = next;
  } catch {
    // replaceState 受限：保持 null，退回"不可判定"的保守处理
  }
}

if (typeof window !== 'undefined') {
  seedCurrentIdx();
  if (!currentHash) currentHash = window.location.hash;
}

/**
 * **同一次历史事件只允许一个订阅者执行恢复**（B4-R3 closure2 · N05b）。
 *
 * <h2>真实缺陷</h2>
 * `useRoute()` 被多处同时使用（App 与 Plans 页各一份），一次 `hashchange`
 * 会触发**多个**监听器。旧实现每个监听器都会各自 `history.go(...)`：
 * 一次被阻止的 Forward 会被执行成两次 `go(-1)`，
 * 于是 URL 在编辑日/管理/首页之间来回纠偏（实测 44 次 go 调用），
 * 物理位置被推来推去，原 forward 目标也随之丢失。
 *
 * <h2>做法</h2>
 * 用**事件对象本身**作为一次性令牌：同一 `Event` 实例只放行第一个订阅者，
 * 其余订阅者直接跳过。浏览器每次导航都会产生新的 Event，
 * 因此不同事件（含我们自己 go() 引发的回位事件）互不影响。
 *
 * @returns true = 本次事件由调用者负责恢复；false = 已被别的订阅者处理
 */
let lastRestoreEvent: unknown = null;

export function claimHistoryRestore(event: unknown): boolean {
  if (event === lastRestoreEvent) return false;
  lastRestoreEvent = event;
  return true;
}

/** 被阻止的历史导航应当怎么处理（纯函数，便于离线回归） */
export type BlockedHistoryAction =
  | { action: 'none' }
  | { action: 'go'; delta: number }
  | { action: 'seed-forward' };

/**
 * 计算"被守卫阻止的浏览器历史导航"应执行的动作（**纯函数**）。
 *
 * <p>不变量：**绝不修改任何已存在历史条目的 URL**。
 * 旧实现把当前条目 URL replaceState 掉，等于抹掉用户要回去的那一页；
 * 这里只决定"要不要把位置挪回原条目"，以及挪几步。
 *
 * @param blocked     守卫是否阻止
 * @param currentHash 当前**已生效**（应用正在显示）的 hash
 * @param targetHash  浏览器已经移动到的 hash
 * @param currentIdx  已生效条目的序号（null = 未播种）
 * @param incomingIdx 目标条目的序号（null = 外部条目/未知）
 */
export function resolveBlockedHistoryAction(params: {
  blocked: boolean;
  currentHash: string;
  targetHash: string;
  currentIdx: number | null;
  incomingIdx: number | null;
}): BlockedHistoryAction {
  const { blocked, currentHash, targetHash, currentIdx, incomingIdx } = params;
  if (!blocked) return { action: 'none' };
  if (targetHash === currentHash) return { action: 'none' };
  if (currentIdx === null) return { action: 'none' };
  if (incomingIdx === null) return { action: 'seed-forward' };
  const delta = currentIdx - incomingIdx;
  return delta === 0 ? { action: 'none' } : { action: 'go', delta };
}

/**
 * 被阻止的浏览器历史导航：把位置送回原条目，**不动栈内容**。
 *
 * @param incomingIdx 目标条目序号（可能因外部跳转缺失）
 */
function restoreEffectivePosition(incomingIdx: number | null, event: unknown): void {
  /**
   * N05b：同一 hashchange 只允许一个订阅者执行恢复（其余订阅者共享同一 Event）。
   * 这消除了"App 与 Plans 各发一次 go(-1)"导致的历史位置振荡。
   */
  if (!claimHistoryRestore(event)) return;
  seedCurrentIdx();
  const decision = resolveBlockedHistoryAction({
    blocked: true,
    currentHash,
    targetHash: window.location.hash,
    currentIdx,
    incomingIdx,
  });
  if (decision.action === 'none') return;
  if (currentIdx === null) return;
  if (decision.action === 'seed-forward') {
    /**
     * 无法判定方向（极少数：外部写入的历史条目）。
     * 保守处理：把**目标条目**的序号补成"当前前一条"的假设值，
     * 只改 state 不改 URL，然后前进一格回到原条目。
     * 绝不 replaceState 覆盖目标条目的 URL（旧缺陷就在这一步）。
     */
    try {
      const prev = window.history.state;
      window.history.replaceState(
        { ...(prev ?? {}), [IDX_KEY]: currentIdx - 1 },
        '',
        window.location.href,
      );
    } catch {
      return;
    }
    try {
      window.history.go(1);
    } catch {
      /* 无法回位：保持现状，URL 与视图可能暂时不一致，但不破坏栈 */
    }
    return;
  }
  try {
    window.history.go(decision.delta);
  } catch {
    /* 同上：不回退到"覆盖 URL"的旧做法 */
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = (event: Event) => {
      /**
       * **B3/G5-R3：浏览器 Back/Forward 也必须过门禁**。
       *
       * 旧实现只让 `navigate()` 检查守卫；用户按真实浏览器 Back
       * （或 hashchange 由历史栈触发）时直接 setRoute，脏视图被卸载 → 草稿丢失。
       * Codex 真实 CUA 确证：配置页轮数 4 未保存，Tab.back 跳管理页，重进恢复 3。
       *
       * 现在的处理：
       *   · 若守卫阻止 → 用 history.go 把**位置**送回原条目（不改任何记录 URL），
       *     → 不卸载当前视图，也不破坏历史栈的前后关系；
       *   · 允许时正常更新 route 与快照。
       */
      if (isLeaveBlocked()) {
        restoreEffectivePosition(readIdx(window.history.state), event);
        return;
      }
      const idx = readIdx(window.history.state);
      if (idx !== null) {
        // 允许的 POP：位置跟着目标条目走（这可能比 currentIdx 小 = 真的后退）
        currentIdx = idx;
      } else {
        seedCurrentIdx();
      }
      currentHash = window.location.hash;
      setRoute(parse());
    };
    // 首次挂载同步快照，避免初值不一致导致误回滚
    if (!currentHash) currentHash = window.location.hash;
    seedCurrentIdx();
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/**
 * 离页门禁（B2/G5-R3）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 旧 `navigate` 直接改 hash，任何页面都能在草稿未保存时被卸载。
 * Codex 真实 CUA 确证：管理页有未保存草稿时点"编辑训练日"直接导航丢草稿；
 * 递减组轮数改了没保存，点"‹计划"无提示返回，草稿丢失。
 *
 * ── 语义 ──────────────────────────────────────────────────────
 * 注册的守卫返回 `true` 表示"**允许**离开"，`false` 表示"阻止"。
 * 任一守卫阻止则不导航。守卫由页面在挂载时注册、卸载时注销。
 * 这是**局部可审查**的机制，不是全 App 草稿框架。
 */
export type LeaveGuard = () => boolean;
const leaveGuards = new Set<LeaveGuard>();

/** 注册离页守卫，返回注销函数 */
export function registerLeaveGuard(guard: LeaveGuard): () => void {
  leaveGuards.add(guard);
  return () => {
    leaveGuards.delete(guard);
  };
}

/** 当前是否有守卫阻止离开（供 UI 提示用） */
export function isLeaveBlocked(): boolean {
  for (const g of leaveGuards) {
    try {
      if (!g()) return true;
    } catch {
      // 守卫抛错按阻止处理（保守）
      return true;
    }
  }
  return false;
}

export function navigate(path: string, replace = false): void {
  /**
   * 统一门禁：所有导航（管理 select、进日编辑、返回、主导航）都过这里。
   * 被阻止时**不导航**，也不清任何状态 —— 由调用方决定是否提示。
   */
  if (isLeaveBlocked()) return;
  const target = `#${path}`;
  seedCurrentIdx();
  if (replace) {
    // 替换当前条目：序号不变（仍是同一条历史记录的"不同 URL"）
    const idx = currentIdx ?? 0;
    try {
      window.history.replaceState({ ...(window.history.state ?? {}), [IDX_KEY]: idx }, '', target);
    } catch {
      window.history.replaceState(null, '', target);
    }
    // 门禁已放行，同步快照后再广播，避免监听器把它当"未生效"回滚
    currentHash = target;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== target) {
    /**
     * B4-R3 closure：push 一条**带序号**的记录。
     *
     * 用 pushState 而不是 `location.hash =` 才能把序号一起写入；
     * 两者都会产生真实历史条目，浏览器 Back/Forward 行为一致。
     * pushState 不会自动触发 hashchange，因此这里显式广播（与 replace 路径同构）。
     */
    /**
     * 关键（B4-R3 closure · N05 修补）：序号是**物理位置** = 当前位置 + 1。
     * 绝不能用"全局唯一递增号"——一旦浏览器截断 forward 分支，
     * 两者就会分叉，`history.go(delta)` 也就不再等于真实步数。
     */
    const nextIdx = nextPushIdx(currentIdx);
    currentIdx = nextIdx;
    try {
      window.history.pushState({ ...(window.history.state ?? {}), [IDX_KEY]: nextIdx }, '', target);
    } catch {
      window.history.pushState(null, '', target);
    }
    currentHash = target;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

/**
 * 程序化返回。
 *
 * B3：`history.back()` 不经过 `navigate`，必须**显式**过门禁，
 * 否则"‹计划"之类的返回按钮仍能在脏视图下丢草稿。
 */
export function back(fallback = '/'): void {
  if (isLeaveBlocked()) return;
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, true);
}
