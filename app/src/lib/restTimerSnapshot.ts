/* 组间休息计时的**跨页面实例快照**（BRIEF 第2项：页面重建恢复计时）。
   ── 为什么需要 ────────────────────────────────────────────────
   useRestTimer 只有 useState/ref，Session 每次挂载都从空开始：
   切后台被系统回收、或页面重建后再进来，休息计时就丢了。
   "未重建时用 Date.now() 算剩余" 不等于 "重建后能恢复"。

   本模块用 sessionStorage（与既有 draftRescue 同一类存储，页面级、不跨设备、
   不进全量备份）保存**最小快照**：
     · sessionId 归属：只恢复属于当前这次训练的计时，避免串到别的训练；
     · endsAt 绝对时间戳 / 暂停时的剩余毫秒；
     · token 与原生代次：重建后能正确接管或取消同一条原生提醒；
     · status：running | paused，用于区分"在跑"和"暂停中"。

   ── 关键规则 ──────────────────────────────────────────────────
   1. 快照带 sessionId：只有同一次训练才恢复（防串训练）。
   2. 完成/放弃训练 → 调用 clear，绝不复活。
   3. 重建恢复**不重复排程**：若剩余时间与原生状态一致，只接管 UI 不再 schedule；
      若已过期，则不再提醒（避免迟到提醒）并清理快照。
   4. 快照过期（超过合理时长）直接丢弃，避免"几小时后突然提醒"。 */

const KEY_PREFIX = 'motion-rest-timer:';

/** 快照格式版本 */
const SNAPSHOT_VERSION = 1;

/** 允许恢复的最大时间跨度：2 小时。超过即视为陈旧，不再恢复。 */
export const MAX_RESTORE_AGE_MS = 2 * 60 * 60 * 1000;

export interface RestTimerSource {
  sessionExerciseId: string;
  setId?: string;
}

export interface RestTimerSnapshot {
  v: 1;
  /** 归属的训练实例 */
  sessionId: string;
  /** 本次休息 token */
  token: string;
  /** 原生代次（未知为 null） */
  generation: number | null;
  /** 计时归属（G3A1；旧快照无此字段 → null=unknown） */
  source?: RestTimerSource | null;
  /** 运行中：绝对结束时间戳；暂停时该字段无意义 */
  endsAt: number | null;
  /** 暂停时冻结的剩余毫秒；运行中为 null */
  pausedRemaining: number | null;
  /** 状态 */
  status: 'running' | 'paused';
  /**
   * **用户意图编号水位**（B4-R3 closure · 重挂后的编号连续性）。
   *
   * <p>页面/组件重挂时 hook 内存里的 {@code intentSeqRef} 会归零。
   * 若水位不随快照持久化，恢复后的第一次 +15 会带一个 ≤ 原生水位的编号到达，
   * 被原生判成 {@code stale-intent} 拒绝 —— 结果是
   * **界面截止已延长、原生仍按旧截止**（dev/prod 实测 75s vs 60s 分叉）。
   *
   * <p>兼容性：旧快照没有该字段 → 读取时为 0（由原生 getActive 水位兜底）。
   */
  intentWatermark: number;
  /** 写入时刻（用于判定陈旧） */
  savedAt: number;
}

function key(sessionId: string): string {
  return KEY_PREFIX + sessionId;
}

function storage(): Storage | null {
  try {
    // sessionStorage 在某些环境（SSR/隐私模式）不可用：返回 null 表示不支持
    if (typeof sessionStorage === 'undefined') return null;
    const probe = `${KEY_PREFIX}__probe`;
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    return sessionStorage;
  } catch {
    return null;
  }
}

/**
 * 写快照的入参。
 *
 * {@code intentWatermark} 是**可选**的：旧调用点（含既有测试）不传也能工作，
 * 读取时统一按 0 处理，因此不会破坏任何既有快照兼容路径。
 */
export type RestTimerSnapshotInput = Omit<
  RestTimerSnapshot,
  'v' | 'savedAt' | 'intentWatermark'
> & { intentWatermark?: number };

/** 保存快照（每次状态变化时调用；失败静默，不影响计时本身） */
export function saveRestTimerSnapshot(snap: RestTimerSnapshotInput): void {
  const s = storage();
  if (!s) return;
  try {
    const record: RestTimerSnapshot = {
      v: SNAPSHOT_VERSION,
      savedAt: Date.now(),
      intentWatermark: 0,
      source: snap.source ?? null,
      ...snap,
    };
    s.setItem(key(snap.sessionId), JSON.stringify(record));
  } catch {
    // 存储满/被禁用：不影响页面内计时
  }
}

/** 清除快照（完成/放弃/停止计时） */
export function clearRestTimerSnapshot(sessionId: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(key(sessionId));
  } catch {
    // 同上
  }
}

/**
 * 读取并校验快照。
 *
 * 返回 null 的情形（都必须是"安静地不恢复"，不能抛错打断页面）：
 * · 没有快照 / JSON 损坏 / 版本不符；
 * · 归属不是本次训练；
 * · 超过 {@link MAX_RESTORE_AGE_MS}（陈旧）；
 * · 字段类型非法（endsAt/pausedRemaining 非有限数字等）。
 */
export function loadRestTimerSnapshot(
  sessionId: string,
  now = Date.now(),
): RestTimerSnapshot | null {
  const s = storage();
  if (!s) return null;
  let raw: string | null;
  try {
    raw = s.getItem(key(sessionId));
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    clearRestTimerSnapshot(sessionId);
    return null;
  }

  const r = parsed as Partial<RestTimerSnapshot>;
  if (r.v !== SNAPSHOT_VERSION) {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  // 归属校验：绝不恢复别的训练的计时
  if (r.sessionId !== sessionId) return null;
  if (typeof r.token !== 'string' || r.token === '') {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  if (r.status !== 'running' && r.status !== 'paused') {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  // 陈旧判定
  if (now - r.savedAt > MAX_RESTORE_AGE_MS) {
    clearRestTimerSnapshot(sessionId);
    return null;
  }
  // 字段合法性
  if (r.status === 'running') {
    if (typeof r.endsAt !== 'number' || !Number.isFinite(r.endsAt)) {
      clearRestTimerSnapshot(sessionId);
      return null;
    }
  } else {
    if (typeof r.pausedRemaining !== 'number' || !Number.isFinite(r.pausedRemaining)) {
      clearRestTimerSnapshot(sessionId);
      return null;
    }
  }

  const generation =
    typeof r.generation === 'number' && Number.isFinite(r.generation) ? r.generation : null;
  /**
   * 旧快照没有 intentWatermark（老版本写入）→ 读成 0，不因此丢弃快照。
   * 负数/非有限值同样按 0 处理（水位只允许非负整数）。
   */
  const intentWatermark =
    typeof r.intentWatermark === 'number' &&
    Number.isFinite(r.intentWatermark) &&
    r.intentWatermark > 0
      ? Math.floor(r.intentWatermark)
      : 0;

  const rawSource = r.source;
  let source: RestTimerSource | null = null;
  if (rawSource !== undefined && rawSource !== null) {
    if (typeof rawSource !== 'object' || Array.isArray(rawSource)) {
      clearRestTimerSnapshot(sessionId);
      return null;
    }
    const src = rawSource as { sessionExerciseId?: unknown; setId?: unknown };
    if (typeof src.sessionExerciseId !== 'string' || src.sessionExerciseId.trim() === '') {
      clearRestTimerSnapshot(sessionId);
      return null;
    }
    if (src.setId !== undefined && typeof src.setId !== 'string') {
      clearRestTimerSnapshot(sessionId);
      return null;
    }
    source = { sessionExerciseId: src.sessionExerciseId, ...(src.setId !== undefined ? { setId: src.setId } : {}) };
  }

  return {
    v: SNAPSHOT_VERSION,
    sessionId,
    token: r.token,
    source,
    generation,
    intentWatermark,
    endsAt: typeof r.endsAt === 'number' && Number.isFinite(r.endsAt) ? r.endsAt : null,
    pausedRemaining:
      typeof r.pausedRemaining === 'number' && Number.isFinite(r.pausedRemaining)
        ? r.pausedRemaining
        : null,
    status: r.status,
    savedAt: r.savedAt,
  };
}

/**
 * 决定重建后如何恢复（纯函数，便于测试）。
 *
 * 返回：
 * · 'resume-running'：仍在计时且未到点 → 恢复 UI，**不重排**原生（原生自己会响）
 * · 'expired'：已到点 → 不恢复、不提醒（避免迟到提醒），清理快照
 * · 'restore-paused'：暂停中 → 恢复暂停态，不排原生
 * · 'none'：不恢复
 */
export type RestoreDecision =
  | { kind: 'resume-running'; endsAt: number; remainingMs: number }
  | { kind: 'restore-paused'; pausedRemaining: number }
  | { kind: 'expired' }
  | { kind: 'none' };

export function decideRestore(
  snap: RestTimerSnapshot | null,
  now = Date.now(),
): RestoreDecision {
  if (!snap) return { kind: 'none' };
  if (snap.status === 'paused') {
    if (snap.pausedRemaining === null) return { kind: 'none' };
    // 暂停中：剩余为 0 视为已结束，不复活
    if (snap.pausedRemaining <= 0) return { kind: 'expired' };
    return { kind: 'restore-paused', pausedRemaining: snap.pausedRemaining };
  }
  if (snap.endsAt === null) return { kind: 'none' };
  const remaining = snap.endsAt - now;
  if (remaining <= 0) return { kind: 'expired' };
  return { kind: 'resume-running', endsAt: snap.endsAt, remainingMs: remaining };
}
