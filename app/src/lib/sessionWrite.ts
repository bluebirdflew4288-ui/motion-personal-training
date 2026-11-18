/* G2B-FIX1-R2：普通逐键保存的「意图基线」与队列重放判定。
   ── 为什么抽出来 ─────────────────────────────────────────────
   根反馈 rev3：applyChange 实际仍是 `return persist(next)`，persist 的
   `baseSessionAtCall = ctx?.baseSession ?? next` 于是 base===mine===next；
   paired 提交先推进 confirmedRevision 后，排在队列里的普通输入在
   mergeDraftOntoFresh(base===mine, fresh) 下被当成“本页没有改动”，输入被吞。

   修法：applyChange 必须在**构造 next 之前**捕获 prev 与 confirmedRevision，
   作为不可变 ctx 随本次提交入队。本模块把这两个动作做成生产函数，
   由 Session.tsx 的 applyChange / persist 实际调用；测试也直接跑同一函数，
   避免“测试里另写一套正确算法”。

   本模块只做纯函数/队列判定，不读写 React 状态、不直接写库。 */

import type { PendingDraft, PersistOutcome } from '../domain/draftMerge';
import type { Session } from '../domain/types';
import { rebaseStaleSession } from './pairedCommit';

/** applyChange 在构造 next 之前冻结的提交上下文。 */
export interface OrdinaryChangeStage {
  /** 本页要保存的最终状态（基于 prev 构建） */
  next: Session;
  /** 真实意图基线：本次编辑前的当前视图（不是 next） */
  baseSession: Session;
  /** 本次编辑开始前本页已确认落库的 revision（不是队列执行时的最新 revision） */
  baseRevisionAtCall: number;
}

/**
 * 构造一次普通输入提交：**先捕获 base，再调用 fn 生成 next**。
 * `fn` 返回同一个对象表示没有产生改动（与 applyChange 原语义一致）。
 */
export function captureOrdinaryChange(
  prev: Session,
  confirmedRevision: number,
  fn: (prev: Session) => Session,
): OrdinaryChangeStage | null {
  const next = fn(prev);
  if (next === prev) return null;
  return { next, baseSession: prev, baseRevisionAtCall: confirmedRevision };
}

export interface QueuedSessionWriteInput {
  sessionId: string;
  /** 本次要保存的整份记录（普通输入=applyChange 的 next） */
  next: Session;
  /** 调用方显式给出的期望版本（合并/重试路径）；普通输入不传 */
  explicitExpectedRevision?: number;
  /** applyChange 捕获的真实意图基线 */
  baseSessionAtCall: Session;
  baseRevisionAtCall: number;
  /** 队列真正执行时的 confirmedRevision（可变 ref 的当前值） */
  queueExecutionRevision: number;
  /** 本次提交是否携带模板写入；携带时必须由 paired 专用路径处理，不走普通 stale rebase */
  hasTemplateWrite: boolean;
  getSession: (id: string) => Promise<Session | undefined>;
  ownPriorCommit?: { revision: number; intent: Session } | null;
}

export type QueuedSessionWriteDecision =
  | { kind: 'save'; session: Session; expectedRevision: number }
  | { kind: 'conflict'; message: string }
  | { kind: 'storage'; message: string };

/**
 * 队列执行时的普通保存判定（与 Session.persist 内的原逻辑等价）：
 * · 有显式 expected / 模板写入 / revision 未前进 → 原样保存；
 * · revision 已前进 → 读最新库，用**调用时捕获的 baseSession**做 canonical 三方合并；
 * · 合并冲突或读取抛错时返回对应失败，由调用方用**原始 base/revision**登记救援草稿。
 */
export async function decideQueuedSessionWrite(
  input: QueuedSessionWriteInput,
): Promise<QueuedSessionWriteDecision> {
  let expected = input.explicitExpectedRevision ?? input.queueExecutionRevision;
  if (!input.hasTemplateWrite && input.explicitExpectedRevision === undefined && expected !== input.baseRevisionAtCall) {
    try {
      const fresh = await input.getSession(input.sessionId);
      if (fresh) {
        const merged = rebaseStaleSession(
          input.baseSessionAtCall,
          input.next,
          fresh,
          input.ownPriorCommit ?? null,
        );
        if (!merged.ok) return { kind: 'conflict', message: merged.message };
        return { kind: 'save', session: merged.session, expectedRevision: fresh.revision ?? 0 };
      }
    } catch (err) {
      return { kind: 'storage', message: err instanceof Error ? err.message : '读取最新训练失败' };
    }
  }
  return { kind: 'save', session: input.next, expectedRevision: expected };
}

/** 普通输入失败时登记救援草稿所用的真实基线（绝不取队列执行后的新 base）。 */
export function pendingDraftFromIntent(
  next: Session,
  baseSession: Session,
  baseRevision: number,
  token: number,
): PendingDraft {
  return { token, session: next, baseRevision, baseSession };
}

/**
 * Wave 1C.2：尚未开始执行事务的连续普通输入写槽（CoalescedOrdinarySlot）。
 *
 * 当第一笔 IDB 事务（或前序 paired 操作）仍在途时，用户在步进器上快速连点产生的
 * 多笔普通 `applyChange` 不必逐笔排成 N 次独立 IDB 读写：
 * · 保留**首批**未开始写槽的 `baseSessionAtCall` 与 `baseRevisionAtCall`（保证与前序 paired 的三方合并以及失败救援基线完整覆盖整段累积变化）；
 * · 持续把目标快照更新为**最新一击**的 `latestNext`；
 * · 一旦该槽进入队列执行（`started = true`）或遇到 paired / 显式版本屏障（`sealOrdinarySlot`），立即封口，后续点击进入新槽；
 * · 该槽最终落库或失败时，向所有合并进来的调用方 Promise 广播同一真实 `PersistOutcome`。
 */
export interface CoalescedOrdinarySlot {
  started: boolean;
  sealed: boolean;
  readonly baseSessionAtCall: Session;
  readonly baseRevisionAtCall: number;
  readonly viewBeforeFirst: Session | null;
  latestNext: Session;
  reservedSeq: number | null;
  waiters: Array<(outcome: PersistOutcome) => void>;
}

export function sealOrdinarySlot(slot: CoalescedOrdinarySlot | null | undefined): void {
  if (slot && !slot.started) {
    slot.sealed = true;
  }
}

export function settleOrdinarySlot(slot: CoalescedOrdinarySlot, outcome: PersistOutcome): void {
  const callbacks = slot.waiters.splice(0, slot.waiters.length);
  for (const fn of callbacks) {
    fn(outcome);
  }
}
