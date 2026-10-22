/* 离页时的「待存草稿」救援位（V8-LC08 → A06 修正）。
   ── 为什么必须有它 ────────────────────────────────────────────
   LC08 的原始描述是“慢提交期间离页/快速重进可能丢最后一笔”。
   只把 editorId 改成每实例唯一，只解决了「旧页面的 release 清掉新页面的锁」，
   并没有解决另外两件事：

     1. 旧页面卸载时**在途的保存**还没落地 → 新页面读到的库是旧的；
     2. 旧页面内存里有 pending 草稿，组件一卸载 ref 就没了 → 用户输入真的丢
        （“pending 不能只留在已销毁组件的 ref 里”，审查明确要求）。

   本模块提供**跨页面实例的草稿救援位**（sessionStorage）：
     · rememberDraft 一产生草稿就**同步**写救援位（不依赖离页守卫被调用）；
     · 旧实例卸载后，排队中的慢写入才失败（lock-lost）时，失败路径会再写一次；
     · 新实例挂载时读取，并**持续接收**后续更新的版本。

   ── A06 修正：每次发布都带**可区分的版本号**（seq）────────────────
   上一版把“救援”做成一次性的：新实例第一次接住就 done=true，
   于是后面的更新版本（1 → 15）永远送不到；更糟的是提交 1 成功后
   无条件 clear，把已经存在的 15 一并抹掉 —— 用户看到“已保存”，实际丢的是 15。

   现在：
     · 每次 saveRescueDraft 都分配**单调递增的 seq**，并随记录持久化；
     · 订阅者收到**每一次**发布（不只是第一次），新实例可以不断升级到最新版本；
     · 提交成功后只能确认**自己真正提交的那个 seq**（ackRescueDraft）：
         存储里 seq 更大 → 说明有更新的意图，**不清除**，交回调用方继续保留；
     · 没有任何时间窗口截断：慢提交多久都可能，watch 一直有效到页面卸载。 */

import type { PendingDraft } from '../domain/draftMerge';
import type { Session } from '../domain/types';

const KEY_PREFIX = 'motion-pending-draft:';

/** 救援记录（v2：带可区分的发布版本号） */
export interface RescueRecord {
  /** 存储格式版本 */
  v: 2;
  /** 发布序号：同一 session 内单调递增，用于区分同一 token 的不同内容版本 */
  seq: number;
  token: number;
  baseRevision: number;
  session: Session;
  baseSession: Session;
  /** 写入时间（诊断用） */
  at: number;
  /**
   * 重新定基后的坐标（A06 恢复闭环）：
   * rebase 之后 pending 的 base 变成「真实已提交结果 C」，
   * 这个关系必须**随救援记录一起持久化**，否则刷新/重挂后
   * ownPriorCommitRef 丢失，就会把库里的 C（自己刚写的 1）误判成外部改动，
   * 让已 rebase 的 15 永远存不进去。
   *
   * 语义与 PendingDraft 一一对应：
   *   baseRevision / baseSession ← C 的 revision 与内容
   *   session                    ← M2（rebase 合并后的目标）
   */
  rebased?: boolean;
}

/** 发布序号分配器：以「存储里的 seq」与「本模块已分配的最大值」取大者 + 1 */
const allocated = new Map<string, number>();

function nextSeq(sessionId: string, storedSeq: number): number {
  const prev = Math.max(allocated.get(sessionId) ?? 0, storedSeq);
  const next = prev + 1;
  allocated.set(sessionId, next);
  return next;
}

/** 救援位是否可用（隐私模式/超限时为 false） */
export function rescueAvailable(): boolean {
  try {
    const probe = `${KEY_PREFIX}__probe__`;
    sessionStorage.setItem(probe, '1');
    sessionStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function readRecord(sessionId: string): RescueRecord | null {
  try {
    const raw = sessionStorage.getItem(KEY_PREFIX + sessionId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RescueRecord> & { v?: number };
    if (parsed.v !== 2) return null;
    if (typeof parsed.seq !== 'number' || typeof parsed.token !== 'number') return null;
    if (typeof parsed.baseRevision !== 'number') return null;
    if (!parsed.session || !parsed.baseSession) return null;
    return parsed as RescueRecord;
  } catch {
    return null;
  }
}

/**
 * 把草稿写入救援位，并分配一个新的发布序号。
 *
 * @returns 成功时返回 seq（调用方需记住它，用于将来只确认这一版）；
 *          失败返回 null —— 调用方据此明确告知“这份草稿没能保住”，
 *          而不是让用户以为已经安全。
 */
export function publishRescueDraft(
  sessionId: string,
  draft: PendingDraft | null,
  opts?: { rebased?: boolean },
): number | null {
  const key = KEY_PREFIX + sessionId;
  try {
    const storedSeq = readRecord(sessionId)?.seq ?? 0;
    if (!draft) {
      sessionStorage.removeItem(key);
      notify(sessionId, null);
      return null;
    }
    const seq = nextSeq(sessionId, storedSeq);
    const record: RescueRecord = {
      v: 2,
      seq,
      token: draft.token,
      baseRevision: draft.baseRevision,
      session: draft.session,
      baseSession: draft.baseSession,
      at: Date.now(),
      ...(opts?.rebased ? { rebased: true as const } : {}),
    };
    sessionStorage.setItem(key, JSON.stringify(record));
    notify(sessionId, record);
    return seq;
  } catch {
    return null;
  }
}

/**
 * 把**已重新定基**的草稿写回救援位（A06 恢复闭环）。
 *
 * 与 publishRescueDraft 的区别：只在“这条记录仍是当前最新”时才写，
 * 且不会覆盖比它更晚的 seq —— 否则会用 rebase 结果倒灌掉更新的意图。
 *
 * @returns 写入后的 seq；被更新的意图挡住时返回 null（表示未写入，调用方不应改 rescuedSeqRef）
 */
export function republishRebasedDraft(
  sessionId: string,
  draft: PendingDraft,
  notNewerThanSeq: number,
): number | null {
  const current = readRecord(sessionId);
  // 已经有更晚的意图 → 绝不覆盖
  if (current && current.seq > notNewerThanSeq) return null;
  return publishRescueDraft(sessionId, draft, { rebased: true });
}

/** 兼容旧调用名：写入草稿，返回是否成功（不带 seq） */
export function saveRescueDraft(sessionId: string, draft: PendingDraft | null): boolean {
  return publishRescueDraft(sessionId, draft) !== null || draft === null;
}

/** 读取救援记录（含版本号） */
export function loadRescueRecord(sessionId: string): RescueRecord | null {
  return readRecord(sessionId);
}

/** 只读草稿本体（不含版本号） */
export function loadRescueDraft(sessionId: string): PendingDraft | null {
  const r = readRecord(sessionId);
  if (!r) return null;
  return { token: r.token, baseRevision: r.baseRevision, session: r.session, baseSession: r.baseSession };
}

/**
 * 提交成功后**只确认指定版本**。
 *
 * @param ackedSeq 本次提交真正覆盖的救援版本号（null = 本次提交不覆盖任何救援版本）
 * @returns
 *   · cleared: true  → 已清除（这就是本次提交的那一版）
 *   · newer: RescueRecord → 库里存在**更新**的意图，未被清除，调用方必须继续保留 pending
 */
export function ackRescueDraft(
  sessionId: string,
  ackedSeq: number | null,
): { cleared: boolean; newer: RescueRecord | null } {
  const current = readRecord(sessionId);
  if (!current) return { cleared: false, newer: null };

  if (ackedSeq === null || current.seq !== ackedSeq) {
    // 存在比本次提交更新的意图 → 绝不能清
    return { cleared: false, newer: current };
  }

  try {
    sessionStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    return { cleared: false, newer: current };
  }
  notify(sessionId, null);
  return { cleared: true, newer: null };
}

/** 清除救援位（用户明确放弃 / 已确认全部落库时） */
export function clearRescueDraft(sessionId: string): void {
  try {
    sessionStorage.removeItem(KEY_PREFIX + sessionId);
  } catch {
    /* ignore */
  }
  notify(sessionId, null);
}

/* ── 变化通知与持续观察 ─────────────────────────────────────── */

type RescueListener = (record: RescueRecord | null) => void;
const listeners = new Map<string, Set<RescueListener>>();

function notify(sessionId: string, record: RescueRecord | null): void {
  const set = listeners.get(sessionId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(record);
    } catch {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  }
}

/** 订阅救援位变化（每次发布都会回调，不只是第一次） */
export function subscribeRescueDraft(sessionId: string, fn: RescueListener): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(sessionId);
  };
}

/**
 * 持续观察救援位，**不设时间上限**（A06：慢提交可能很久以后才失败）。
 *
 * 同一文档内靠 subscribe 即时通知；另用低频轮询兜底跨 Realm / 手工写入。
 * 每次发现**更新的 seq**都会回调，调用方据此不断升级到最新意图。
 * 只有页面卸载时才由调用方 stop()。
 *
 * @returns stop 函数
 */
export function watchRescueDraft(
  sessionId: string,
  onRecord: (record: RescueRecord) => void,
  opts?: { intervalMs?: number },
): () => void {
  const intervalMs = opts?.intervalMs ?? 400;
  let highest = readRecord(sessionId)?.seq ?? 0;

  const consider = (record: RescueRecord | null) => {
    if (!record) return;
    if (record.seq <= highest) return;
    highest = record.seq;
    onRecord(record);
  };

  // 立刻检查一次（覆盖“救援先写入、观察后开始”）
  consider(readRecord(sessionId));

  const unsubscribe = subscribeRescueDraft(sessionId, (record) => consider(record));
  const timer = setInterval(() => consider(readRecord(sessionId)), intervalMs);

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}

/** 兼容旧名（无窗口限制版本） */
export function watchLateRescue(
  sessionId: string,
  onDraft: (draft: PendingDraft) => void,
  opts?: { intervalMs?: number },
): () => void {
  return watchRescueDraft(
    sessionId,
    (record) =>
      onDraft({ token: record.token, baseRevision: record.baseRevision, session: record.session, baseSession: record.baseSession }),
    opts,
  );
}
