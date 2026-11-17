/* G2B-FIX1：成对提交（Session + 模板）的失败隔离与队列重放。
   · 每次执行都从**数据库最新 Session** 重新构建 next，避免旧快照套新 revision 覆盖背景更新；
   · 失败一律返回 failed，不进入通用 rememberDraft 救援；
   · 成功只在 save（内部为 atomic 事务 oncomplete）返回 ok 后报告；
   · 供 Session 的 saveQueue 串行调用，也可用 fake-indexeddb 直接做确定性测试。 */

import type { ExerciseTemplate, Session } from '../domain/types';
import type { WriteResult } from '../db/tx';
import { mergeDraftOntoFresh } from '../domain/draftMerge';

export type RebaseResult =
  | { ok: true; session: Session }
  | { ok: false; message: string; conflicts?: unknown };

/**
 * FIX1-R2：仅把 fresh 中**纯新增**的动作原样补进 base/mine，供 canonical 合并器复用。
 *
 * 安全前提（任一不满足即返回 null，保留原冲突）：
 *   · mine 的动作 ID 顺序与 base 完全相同（本页没有增删/排序）；
 *   · fresh 包含 base 的全部动作，且这些动作在 fresh 中的相对顺序与 base 相同（fresh 只增加、不删除/重排）；
 *   · fresh 至少有一个新增动作。
 *
 * 返回的新 Session 保持 fresh 的动作顺序；原动作取各自版本的内容，新增动作原样取自 fresh。
 * 这里只负责“补齐动作集合”，字段冲突仍交给 mergeDraftOntoFresh 判定，绝不自行降级成功。
 */
function withFreshAdditionsOnly(base: Session, mine: Session, fresh: Session): { base: Session; mine: Session } | null {
  const baseIds = base.exercises.map((e) => e.id);
  const mineIds = mine.exercises.map((e) => e.id);
  if (JSON.stringify(mineIds) !== JSON.stringify(baseIds)) return null;

  const baseIdSet = new Set(baseIds);
  const freshOriginalIds = fresh.exercises.filter((e) => baseIdSet.has(e.id)).map((e) => e.id);
  if (freshOriginalIds.length !== baseIds.length) return null;
  for (let i = 0; i < baseIds.length; i += 1) {
    if (freshOriginalIds[i] !== baseIds[i]) return null;
  }
  if (fresh.exercises.length === freshOriginalIds.length) return null; // 没有新增

  const augment = (session: Session): Session => {
    const byId = new Map(session.exercises.map((e) => [e.id, e]));
    return {
      ...session,
      exercises: fresh.exercises.map((freshEx) => {
        const own = byId.get(freshEx.id);
        return structuredClone(own ?? freshEx);
      }),
    };
  };
  return { base: augment(base), mine: augment(mine) };
}

/**
 * G3A2-FIX1：fresh **只删除**了 base 里的条目（本页未增删、未重排）时，
 * 把 base/mine 同步裁剪到 fresh 的动作集合，再交给 canonical 合并器。
 *
 * 安全前提（G3A2-FIX2 更正）：mine 的动作顺序与 base 完全相同；fresh 的 ID 序列是
 * base 的子序列（只删除、不新增、不重排）；**且被删除条目在 mine 中必须与 base 完全未修改**
 * —— 只要本页在被删项上有任何未保存改动（reps/note/状态…），一律返回冲突并保留草稿，
 * 绝不裁剪丢弃。其余条目的同字段冲突仍由 mergeDraftOntoFresh 判定，绝不降级成功。
 */
function withFreshRemovalsOnly(
  base: Session,
  mine: Session,
  fresh: Session,
): { base: Session; mine: Session; trim: (s: Session) => Session } | null {
  const baseIds = base.exercises.map((e) => e.id);
  const mineIds = mine.exercises.map((e) => e.id);
  if (JSON.stringify(mineIds) !== JSON.stringify(baseIds)) return null;
  const freshIds = fresh.exercises.map((e) => e.id);
  if (freshIds.length >= baseIds.length) return null;
  let cursor = 0;
  for (const id of baseIds) {
    if (cursor < freshIds.length && freshIds[cursor] === id) cursor += 1;
  }
  if (cursor !== freshIds.length) return null; // fresh 不是 base 的子序列（含新增/重排）
  const keep = new Set(freshIds);
  /**
   * P1 安全前提（根 revision8）：**被 fresh 删除的条目上，本页不得有任何未保存改动**。
   * 只要 mine 相对 base 改过被删项（reps/note/状态…），一律返回冲突，绝不静默丢弃，
   * 由调用方保留草稿/救援让用户重新处理。
   */
  const baseById = new Map(base.exercises.map((e) => [e.id, e]));
  for (const mineEx of mine.exercises) {
    if (keep.has(mineEx.id)) continue;
    const b = baseById.get(mineEx.id);
    if (!b || JSON.stringify(b) !== JSON.stringify(mineEx)) return null;
  }
  const trim = (s: Session): Session => ({ ...s, exercises: s.exercises.filter((e) => keep.has(e.id)) });
  return { base: trim(base), mine: trim(mine), trim };
}

/** 队列中旧普通更新遇到 revision 前进时，基于最新库合并本页意图（不覆盖背景变化）。 */
export function rebaseStaleSession(
  base: Session,
  mine: Session,
  fresh: Session,
  own: Parameters<typeof mergeDraftOntoFresh>[3] = null,
): RebaseResult {
  const direct = mergeDraftOntoFresh(base, mine, fresh, own);
  if (direct.ok) return direct;

  /**
   * FIX1-R2：唯一允许的最小保守适配 —— fresh 只新增动作、mine 未动原动作集合时，
   * 把 fresh 的新增项原样补进 base/mine 后**重新调用既有 canonical 合并器**。
   * session.note / cardio / 热身 / 同字段冲突全部仍由 mergeDraftOntoFresh 判定；
   * 其余冲突（同 set 强写、删除他人新 actual、mine 自己增删动作等）原样返回 conflict。
   */
  const augmented = withFreshAdditionsOnly(base, mine, fresh);
  if (augmented) return mergeDraftOntoFresh(augmented.base, augmented.mine, fresh, own);

  /**
   * G3A2-FIX1：删除已落库后，本页在删除前捕获的普通输入（base 仍含被删项）。
   * 仅在 fresh 只是删除了 base 的条目时裁剪重放，其余冲突照旧返回。
   */
  const trimmed = withFreshRemovalsOnly(base, mine, fresh);
  if (!trimmed) return direct;
  /**
   * A06 的 D1 意图快照也必须同步裁剪：否则 sameOwner 时 effBase 仍含被删条目，
   * 会把「fresh 少了条目」误报成另一个页面改过动作集合。
   */
  const trimmedOwn = own ? { revision: own.revision, intent: trimmed.trim(own.intent) } : own;
  return mergeDraftOntoFresh(trimmed.base, trimmed.mine, fresh, trimmedOwn);
}

export type PairedOutcome =
  | { status: 'saved'; session: Session; revision: number; template?: ExerciseTemplate }
  | { status: 'failed'; reason: string; message: string }
  | { status: 'not-attempted'; message: string };

export interface PairedSaveRequest {
  sessionId: string;
  editorId: string;
  /** 基于**最新** Session 构建本次意图（必须是纯函数） */
  buildNext: (fresh: Session) => Session;
  templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null };
  deps: {
    getSession: (id: string) => Promise<Session | undefined>;
    save: (
      session: Session,
      guard: { editorId: string; expectedRevision: number },
      templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null },
    ) => Promise<WriteResult>;
  };
}

export async function commitPairedSession(req: PairedSaveRequest): Promise<PairedOutcome> {
  let fresh: Session | undefined;
  try {
    fresh = await req.deps.getSession(req.sessionId);
  } catch (err) {
    return { status: 'failed', reason: 'storage', message: err instanceof Error ? err.message : '读取最新训练失败' };
  }
  if (!fresh) return { status: 'failed', reason: 'state-conflict', message: '这条训练记录已经不存在了' };

  let next: Session;
  try {
    next = req.buildNext(fresh);
  } catch (err) {
    return { status: 'failed', reason: 'state-conflict', message: err instanceof Error ? err.message : '本次编辑对象已变化' };
  }

  try {
    const r = await req.deps.save(
      { ...next, revision: fresh.revision ?? 0 },
      { editorId: req.editorId, expectedRevision: fresh.revision ?? 0 },
      req.templateWrite,
    );
    if (!r.ok) return { status: 'failed', reason: r.reason, message: r.message };
    return {
      status: 'saved',
      session: r.session,
      revision: r.revision,
      ...(r.template ? { template: r.template } : {}),
    };
  } catch (err) {
    return { status: 'failed', reason: 'storage', message: err instanceof Error ? err.message : '本地写入失败' };
  }
}
