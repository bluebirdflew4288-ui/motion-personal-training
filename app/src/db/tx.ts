/* 训练记录的唯一受约束写入入口（V3-01）。
   设计目标（对应独立审查 D12–D20）：
   1) 锁只有一种 schema（见 ./locks.ts），获取/续租/释放/保存校验全在原子事务里。
   2) 每条记录有单调 revision；写入方带 expectedRevision，同事务读 current → 核验 → 写。
   3) 新建 / 活动保存 / 结束 / 放弃 / 历史纠错**各自定义允许的状态转换**，
      已终态（completed/discarded）不能被旧的 active 快照复活。
   4) 结束幂等是数据层无条件成立的：已结束记录返回原结果，不再写、不推进游标。
   5) 计划推进在事务内从**最新计划**计算，不信任 UI 预先算好的整份 plan 快照。
   6) 失败整体回滚；重试不会重复推进。

   跨 store 说明：结束 = 写训练终态 + 可能推进计划，两者必须在同一个 transaction 里，
   任一失败整体 abort（审查 D16 已验证的方向，这里保留并加强）。 */

import { openDb, StorageError } from './idb';
import {
  atomicAcquireOrRenew,
  atomicRenew,
  atomicRelease,
  lockGrantsWrite,
  interpretLock,
  lockKey,
  readLockState,
  DEFAULT_LOCK_TTL_MS,
  type LockOpResult,
} from './locks';
import { pushCycle } from '../domain/cycle';
import type { Plan, Session } from '../domain/types';

export type WriteFailureReason =
  | 'lock-lost'
  | 'no-lock'
  | 'corrupt-lock'
  | 'version-conflict'
  | 'state-conflict'
  | 'storage';

export type WriteResult =
  | {
      ok: true;
      /** 写入后记录的 revision（幂等结束返回既有值） */
      revision: number;
      /** 落库后的记录（结束/放弃时基于事务内最新记录合并，而非调用方旧快照） */
      session: Session;
      /** 结束并推进后的计划（未推进时为事务内当前计划） */
      plan?: Plan;
      /** true = 记录本来已是终态，本次没有写入 */
      alreadyTerminal?: boolean;
    }
  | {
      ok: false;
      reason: WriteFailureReason;
      message: string;
      /** 事务内读到的最新记录，便于 UI 提示「刷新后查看」 */
      current?: Session;
    };

/** 写入意图：每种意图对应一组明确允许的状态转换 */
export type WriteIntent =
  /** 新建一次训练：允许记录不存在；不允许覆盖已存在的记录 */
  | { kind: 'create' }
  /** 训练进行中的普通保存：当前必须是 active */
  | { kind: 'active-save' }
  /** 结束训练：当前必须是 active；已终态则幂等返回既有结果且不推进 */
  | { kind: 'finish'; advanceCycle: boolean }
  /** 放弃训练：当前必须是 active；已终态则幂等返回 */
  | { kind: 'discard' }
  /** 历史纠错：当前必须是终态记录；只改当下合法版本 */
  | { kind: 'history-edit' };

export interface WriteOptions {
  intent: WriteIntent;
  /** 要写入的记录内容 */
  session: Session;
  /** 写入方 editorId（锁校验用）；history-edit / create 可为空 */
  editorId?: string;
  /** 期望的当前 revision；不传=不校验（仅 create/finish 允许省略） */
  expectedRevision?: number;
  /** 锁校验级别：required（默认，训练进行中）/ optional（历史纠错、首页结束引导确认后） */
  lockPolicy?: 'required' | 'optional';
  /** 锁租期 */
  ttlMs?: number;
}

/** 记录当前 revision（旧数据视为 0） */
export function revisionOf(s: Session | undefined): number {
  return typeof s?.revision === 'number' && Number.isFinite(s.revision) ? s.revision : 0;
}

function fail(
  reason: WriteFailureReason,
  message: string,
  current?: Session,
): { ok: false; reason: WriteFailureReason; message: string; current?: Session } {
  return { ok: false, reason, message, ...(current ? { current } : {}) };
}

/**
 * 在**同一个** IndexedDB 事务里：读锁 → 读当前记录 →（结束还需）读最新计划 → 核验 → 写。
 * 所有判断都在 request 的 onsuccess 里同步完成，保证事务不被提前提交。
 */
export function atomicWriteSession(opts: WriteOptions): Promise<WriteResult> {
  const { intent, session, editorId, expectedRevision, lockPolicy = 'required', ttlMs = DEFAULT_LOCK_TTL_MS } = opts;
  const needsPlans = intent.kind === 'finish';
  const stores = needsPlans ? ['sessions', 'meta', 'plans'] : ['sessions', 'meta'];

  return openDb().then(
    (db) =>
      new Promise<WriteResult>((resolve) => {
        let settled = false;
        const done = (r: WriteResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        /**
         * 拟返回的成功结果（V4-01）。
         * 关键：put 请求 even 单个成功都不等于「事务已提交」。
         * 因此所有写分支只把结果暂存在这里，**只有 transaction.oncomplete**
         * 才 resolve 成功；onabort/onerror 一律返回失败。
         * 审查 V4D12：finish 分支曾经在 put 之后直接 done(ok)，
         * 导致提交前 abort 时调用方已收到成功、store 已更新内存。
         */
        let pendingSuccess: WriteResult | null = null;
        /** 不需要写库就能确定的成功结果（幂等终态）—— 它不依赖事务提交 */
        let immediateSuccess: WriteResult | null = null;

        let t: IDBTransaction;
        try {
          t = db.transaction(stores, 'readwrite');
        } catch (err) {
          done(fail('storage', err instanceof Error ? err.message : '事务开启失败'));
          return;
        }
        const sessions = t.objectStore('sessions');
        const meta = t.objectStore('meta');
        const plans = needsPlans ? t.objectStore('plans') : null;

        const abort = (r: WriteResult) => {
          // 主动失败：先清掉暂存的成功，避免 oncomplete 抢答（正常 abort 不会触发 oncomplete）
          pendingSuccess = null;
          immediateSuccess = null;
          try {
            t.abort();
          } catch {
            /* ignore */
          }
          done(r);
        };

        // 唯一的成功出口：事务真正提交后才把暂存结果交回调用方
        t.oncomplete = () => {
          if (pendingSuccess) {
            done(pendingSuccess);
            return;
          }
          if (immediateSuccess) {
            done(immediateSuccess);
            return;
          }
          done(fail('storage', '事务提交但未产生结果'));
        };
        t.onabort = () => {
          if (settled) return;
          settled = true;
          // 提交阶段失败：即使某个 put 的 request 曾 success，也必须报告失败
          pendingSuccess = null;
          resolve(fail('storage', t.error?.message ?? '事务被中止，数据未保存'));
        };
        t.onerror = () => abort(fail('storage', t.error?.message ?? '写入失败'));

        const lockReq = meta.get(lockKey(session.id));
        const curReq = sessions.get(session.id);

        let lockRaw: unknown;
        let current: Session | undefined;
        let pending = 2;

        const step = () => {
          pending--;
          if (pending > 0) return;
          const now = Date.now();

          // ── ⓪ 状态前置判定 ──
          // 只做「确定不写」的判断，让 UI 拿到准确原因，不构成写入授权。
          // · active-save 命中终态记录 → 已结束/已放弃，直接拒绝（审查 D14）
          // · finish/discard 命中终态记录 → 幂等返回既有结果，不写不推进（审查 D18）
          if (intent.kind === 'active-save') {
            if (!current) {
              abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
              return;
            }
            if (current.status !== 'active') {
              abort(
                fail(
                  'state-conflict',
                  current.status === 'completed' ? '这条训练已经结束，请刷新后查看' : '这条训练已经放弃，请刷新后查看',
                  current,
                ),
              );
              return;
            }
          }

          // ── ① 锁资格 ──
          // required：必须持有、未过期、结构合法（缺失/损坏/过期/非持有者一律拒绝，审查 D17/D13）。
          // optional：**只表示「允许无锁」**，不表示「可以无视别人正在持有的有效锁」（审查 V4D11）。
          //   → 锁空闲 / 已过期 / 属于自己 才放行；别人有效持锁必须拒绝。
          //   这样首页两步式「先查锁再 optional 结束」之间的竞争窗口在事务内被封住。
          // 唯一例外：finish/discard 命中已终态记录时不写入，允许无锁返回既有结果。
          const terminalNoop =
            (intent.kind === 'finish' || intent.kind === 'discard') && !!current && current.status !== 'active';
          if (lockPolicy === 'optional' && !terminalNoop) {
            const st = interpretLock(lockRaw, now, ttlMs);
            if (st.kind === 'corrupt') {
              abort(fail('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制', current));
              return;
            }
            if (st.kind === 'held' && st.editorId !== (editorId ?? '') && !st.expired) {
              abort(
                fail(
                  'lock-lost',
                  '这条训练正在另一个标签页中编辑，本页不会结束它。请回到那个标签页操作，或等它停止编辑后再试。',
                  current,
                ),
              );
              return;
            }
          }
          if (lockPolicy === 'required' && !terminalNoop) {
            const st = interpretLock(lockRaw, now, ttlMs);
            if (st.kind === 'corrupt') {
              abort(fail('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制', current));
              return;
            }
            if (st.kind !== 'held') {
              abort(fail('no-lock', '本页没有这个训练的编辑锁，不能写入。请刷新后重新取得控制。', current));
              return;
            }
            if (!lockGrantsWrite(lockRaw, editorId ?? '', now, ttlMs)) {
              abort(
                fail(
                  'lock-lost',
                  st.editorId === editorId
                    ? '编辑锁已过期，请重新取得控制后再保存'
                    : '这个训练已在另一个标签页中被接管，本页不再写入',
                  current,
                ),
              );
              return;
            }
          }

          // ── ② 状态转换与版本 ──
          const curStatus = current?.status;
          const curRev = revisionOf(current);

          switch (intent.kind) {
            case 'create': {
              if (current) {
                abort(fail('state-conflict', '这条训练记录已存在，不能重复新建', current));
                return;
              }
              writeNext({ ...session, revision: 1 });
              return;
            }
            case 'active-save': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
                return;
              }
              if (curStatus !== 'active') {
                // 审查 D14：终态不能被旧 active 快照复活
                abort(
                  fail(
                    'state-conflict',
                    curStatus === 'completed' ? '这条训练已经结束，请刷新后查看' : '这条训练已经放弃，请刷新后查看',
                    current,
                  ),
                );
                return;
              }
              if (expectedRevision !== undefined && expectedRevision !== curRev) {
                abort(fail('version-conflict', '这条记录已被更新（可能在另一个页面改过），请刷新后重新编辑', current));
                return;
              }
              writeNext({ ...session, revision: curRev + 1 });
              return;
            }
            case 'finish':
            case 'discard': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条训练记录，可能已被删除', current));
                return;
              }
              if (curStatus !== 'active') {
                // ④ 无条件幂等：**不写库**，因此不需要等提交，可以立即返回既有结果。
                // 注意这不会影响真实写分支的提交确认（那条路径走 finishWrite → oncomplete）。
                immediateSuccess = { ok: true, revision: curRev, session: current, alreadyTerminal: true };
                // 没有排入任何写入，可以立即返回（不受提交结果影响）
                done(immediateSuccess);
                return;
              }
              // 结束/放弃都以**事务内最新记录**为数据底，只应用终态字段，
              // 避免「首页旧快照」把别页刚保存的次数覆盖回去（审查 D19）。
              const base: Session = { ...current };
              if (intent.kind === 'discard') {
                const next: Session = { ...base, status: 'discarded', endedAt: session.endedAt ?? now, revision: curRev + 1 };
                writeNext(next);
                return;
              }
              // finish：需要事务内最新计划来算游标
              const planId = base.planId;
              const planReq = plans!.get(planId);
              planReq.onsuccess = () => {
                const curPlan = planReq.result as Plan | undefined;
                const shouldAdvance =
                  intent.advanceCycle && !base.advancedCycle && !!curPlan && curPlan.days.length > 0;
                const movedPlan = shouldAdvance && curPlan ? pushCycle(curPlan) : undefined;
                const next: Session = {
                  ...base,
                  status: 'completed',
                  endedAt: session.endedAt ?? now,
                  advancedCycle: Boolean(shouldAdvance),
                  // 从**事务内最新计划**读游标：不信任 UI 预先算好的 cycleIndexAfter
                  cycleIndexAfter: movedPlan ? movedPlan.cursor : (curPlan?.cursor ?? base.cycleIndexAtStart),
                  revision: curRev + 1,
                };
                // 训练备注等文本允许由调用方提供（只有文本字段，不含实际记录）
                if (typeof session.note === 'string') next.note = session.note;
                try {
                  sessions.put(next);
                  if (movedPlan && curPlan) plans!.put({ ...curPlan, ...movedPlan });
                } catch (err) {
                  abort(fail('storage', err instanceof Error ? err.message : '写入失败', current));
                  return;
                }
                /**
                 * V4-01：**不在这里返回成功**。
                 * put 只是把请求排进队列；提交阶段仍可能失败（审查 V4D12 注入的 abort）。
                 * 结果暂存到 pendingSuccess，由下面的 finishWrite(next, …) 统一交给 oncomplete。
                 */
                finishWrite({ ok: true, revision: next.revision ?? 0, session: next, plan: movedPlan ?? curPlan });
              };
              planReq.onerror = () => abort(fail('storage', '无法读取计划，结束已取消', current));
              return;
            }
            case 'history-edit': {
              if (!current) {
                abort(fail('state-conflict', '找不到这条历史记录', current));
                return;
              }
              if (curStatus === 'active') {
                abort(fail('state-conflict', '这条训练还在进行中，不能按历史纠错保存', current));
                return;
              }
              if (expectedRevision !== undefined && expectedRevision !== curRev) {
                abort(
                  fail('version-conflict', '这条历史记录已被修改过（可能在另一个页面），你的草稿没有覆盖它，请刷新后重新编辑', current),
                );
                return;
              }
              // 历史纠错保留终态语义，只允许改实际数据与备注
              const next: Session = {
                ...session,
                status: current.status,
                endedAt: current.endedAt,
                startedAt: current.startedAt,
                revision: curRev + 1,
              };
              writeNext(next);
              return;
            }
          }
        };

        /**
         * 排入写入并登记成功结果。
         * 成功结果只登记在 pendingSuccess，**由 transaction.oncomplete 唯一确认**。
         * 锁续租 / 结束后的锁清理都与终态写在同一个事务里，一起成功或一起回滚。
         */
        const writeNext = (next: Session) => {
          try {
            sessions.put(next);
          } catch (err) {
            abort(fail('storage', err instanceof Error ? err.message : '写入失败', current));
            return;
          }
          // 活动保存会顺手续租，避免长间隔后自己掉锁（与记录写同事务）
          if (intent.kind === 'active-save' && editorId) {
            meta.put({ key: lockKey(session.id), sessionId: session.id, editorId, at: Date.now() });
          }
          finishWrite({ ok: true, revision: next.revision ?? 0, session: next });
        };

        /**
         * finish 分支也走这里：plan 是额外要返回的信息，同样只在提交后可见。
         */
        const finishWrite = (result: WriteResult) => {
          // 锁清理与终态同事务（finish/discard 都释放锁，一起提交或一起回滚）
          if (intent.kind === 'finish' || intent.kind === 'discard') {
            meta.put({ key: lockKey(session.id), sessionId: session.id, editorId: '', at: 0 });
          }
          pendingSuccess = result;
        };

        lockReq.onsuccess = () => {
          lockRaw = lockReq.result;
          step();
        };
        lockReq.onerror = () => abort(fail('storage', '无法读取编辑锁'));
        curReq.onsuccess = () => {
          current = curReq.result as Session | undefined;
          step();
        };
        curReq.onerror = () => abort(fail('storage', '无法读取训练记录'));
      }),
  );
}

/* ── 兼容包装（保留既有调用点与测试的语义）────────── */

/** 带锁校验的普通保存（训练进行中每次改动） */
export function atomicSaveSession(args: {
  session: Session;
  guard: { sessionId?: string; editorId: string; ttlMs?: number; expectedVersion?: number | null };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'active-save' },
    session,
    editorId: guard.editorId,
    expectedRevision: typeof guard.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard.ttlMs,
  });
}

/**
 * 结束训练（原子写终态 + 按需推进计划）。
 * · 不传 expectedVersion：以事务内最新记录为准（幂等、不推进第二次）。
 * · 传 expectedVersion：额外做一次版本核验。
 * · plan 参数已废弃：推进由事务内最新计划计算；保留了入参以便旧调用不报错。
 */
export function atomicFinishSession(args: {
  session: Session;
  plan?: Plan;
  guard?: {
    sessionId?: string;
    editorId?: string;
    ttlMs?: number;
    expectedVersion?: number | null;
    /** 结束时是否推进循环；不传则读 session.advancedCycle 的意图 */
    advanceCycle?: boolean;
    lockPolicy?: 'required' | 'optional';
  };
}): Promise<WriteResult> {
  const { session, guard } = args;
  const advanceCycle = guard?.advanceCycle ?? session.advancedCycle ?? false;
  return atomicWriteSession({
    intent: { kind: 'finish', advanceCycle },
    session,
    editorId: guard?.editorId,
    expectedRevision: typeof guard?.expectedVersion === 'number' ? guard.expectedVersion : undefined,
    ttlMs: guard?.ttlMs,
    lockPolicy: guard?.lockPolicy ?? 'required',
  });
}

/** 放弃训练（原子写终态，不推进） */
export function atomicDiscardSession(args: {
  session: Session;
  guard?: { editorId?: string; ttlMs?: number; expectedVersion?: number | null; lockPolicy?: 'required' | 'optional' };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'discard' },
    session,
    editorId: guard?.editorId,
    ttlMs: guard?.ttlMs,
    lockPolicy: guard?.lockPolicy ?? 'required',
  });
}

/** 新建训练（不允许覆盖已存在记录） */
export function atomicCreateSession(args: {
  session: Session;
  guard?: { editorId?: string; lockPolicy?: 'required' | 'optional' };
}): Promise<WriteResult> {
  const { session, guard } = args;
  return atomicWriteSession({
    intent: { kind: 'create' },
    session,
    editorId: guard?.editorId,
    lockPolicy: guard?.lockPolicy ?? 'optional',
  });
}

/** 历史纠错保存（必须带 expectedRevision；不改终态） */
export function atomicSaveHistoryEdit(args: {
  session: Session;
  expectedRevision: number;
}): Promise<WriteResult> {
  return atomicWriteSession({
    intent: { kind: 'history-edit' },
    session: args.session,
    expectedRevision: args.expectedRevision,
    lockPolicy: 'optional',
  });
}

/* ── 锁操作转发（保持既有的 import 路径可用）────────── */

export { atomicAcquireOrRenew, atomicRenew, atomicRelease, readLockState };

/** 原子获取/续租锁（读与写在同一事务里，避免两个标签同时 ok=true） */
export async function atomicAcquireLock(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<{ ok: true } | { ok: false; heldBy: string }> {
  const r = await atomicAcquireOrRenew(sessionId, editorId, ttlMs);
  return r.ok ? { ok: true } : { ok: false, heldBy: r.heldBy ?? 'unknown' };
}

/** 供 UI 直接拿到带 reason 的锁结果 */
export async function acquireLockDetailed(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockOpResult> {
  return atomicAcquireOrRenew(sessionId, editorId, ttlMs);
}

export { StorageError };
