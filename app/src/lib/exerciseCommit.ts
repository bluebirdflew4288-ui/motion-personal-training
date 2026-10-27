/* 「临时添加动作」与「从本次训练移除动作」的提交语义（纯逻辑，便于真实测试）。

   ── 为什么单独一份 ────────────────────────────────────────────
   Session.tsx 里这两个动作和「替换」一样，容易在四个地方出错：
   1. 慢保存期间「确认/取消/关闭」仍可点 → 重复入队；
   2. 保存失败后重试又执行一次领域操作 → **重复追加一个动作**；
   3. 旧提交的异步回调无条件关窗/提示 → 清掉后来打开的新配置；
   4. 用名称或「看起来像成功了」的启发式判断结果 → 把没保存的说成已保存。

   这里沿用 `replaceCommit.ts` 已确立的判定口径（同一套语义，不新造概念），
   把「一次添加/移除意图」的稳定身份与阶段迁移抽成纯函数，UI 只做渲染与副作用。

   ── 提交身份（关键）────────────────────────────────────────────
   一次意图的 `commitId` 在**第一次确认时**固定，并与 `sessionId` 一起作为归属凭据：
   · 只有「当前配置的 commitId 与 sessionId 都匹配」的回调才允许关窗/写提示；
   · `submitted=true` 表示领域操作**已经执行过一次**（动作 ID 已生成、可能已成待存草稿），
     此后重试只走「重试保存这份 pending」，**绝不再次调用领域添加函数**。

   这样即使保存失败后用户连点重试，也只会保存同一份添加意图，不会出现两个动作。 */

import type { LooseExerciseConfig } from '../domain/session';

/** 提交阶段的公共三态 */
export type CommitPhase = 'editing' | 'submitting' | 'failed';

/** 一次「添加动作」意图的可观测状态 */
export interface AddExerciseCommitState {
  /** 本次意图的稳定标识（打开配置时生成，重试期间不变） */
  commitId: string;
  /** 归属：这条意图属于哪次训练（跨训练/跨页面的旧回调必须失效） */
  sessionId: string;
  /** 第一次确认时冻结的配置（之后的重试只保存它，不再读取 UI 草稿） */
  intent: LooseExerciseConfig;
  phase: CommitPhase;
  /** 领域操作是否已经执行过（决定重试是「只重试保存」还是「重新提交」） */
  submitted: boolean;
}

/** 一次「移除动作」意图的可观测状态 */
export interface RemoveExerciseCommitState {
  commitId: string;
  sessionId: string;
  /** 目标动作的**稳定 ID**（绝不按名称定位，避免同名不同 ID 误删） */
  exerciseId: string;
  /** 打开确认时的动作名快照（动作消失后仍能显示有意义的内容） */
  name: string;
  phase: CommitPhase;
  submitted: boolean;
}

/** 归属判定用的最小形状 */
export interface CommitOwner {
  sessionId: string;
  commitId: string;
}

/** 是否属于当前这次提交（旧回调不得影响后来打开的新配置） */
export function ownsCommit(
  sessionId: string,
  commitId: string,
  current: CommitOwner | null,
): boolean {
  if (current === null) return false;
  return current.sessionId === sessionId && current.commitId === commitId;
}

/** 旧代次判定（语义与 ownsCommit 相反） */
export function isStaleCommit(
  sessionId: string,
  commitId: string,
  current: CommitOwner | null,
): boolean {
  return !ownsCommit(sessionId, commitId, current);
}

/** 是否允许点「确认」（提交中一律禁止：慢保存下重复确认会重复入队） */
export function canConfirmCommit(s: { phase: CommitPhase } | null): boolean {
  if (!s) return false;
  return s.phase !== 'submitting';
}

/** 是否允许关闭弹层（用户主动关闭时，提交中必须拦住） */
export function canCloseCommitSheet(
  s: { phase: CommitPhase } | null,
  reason: 'user' | 'settled',
): boolean {
  if (!s) return true;
  if (reason === 'settled') return true;
  return s.phase !== 'submitting';
}

/** 重试决策：只有「还没执行过领域操作」才允许重新提交 */
export type CommitRetryAction = 'submit' | 'retry-save-only' | 'reject-busy';

export interface CommitRetryDecision {
  action: CommitRetryAction;
  message: string;
}

export function decideCommitRetry(
  s: { phase: CommitPhase; submitted: boolean } | null,
  label: string,
): CommitRetryDecision {
  if (!s) return { action: 'reject-busy', message: `没有待处理的${label}` };
  if (s.phase === 'submitting') {
    return { action: 'reject-busy', message: `正在保存这次${label}，请稍候` };
  }
  if (s.phase === 'editing') return { action: 'submit', message: `提交这次${label}` };
  /**
   * 已经执行过领域操作：**只重试保存**。
   * 再执行一次会追加第二个动作（添加）或对已不存在的 ID 误操作（移除）。
   */
  if (s.submitted) {
    return { action: 'retry-save-only', message: `重试保存这次${label}（不会重复执行）` };
  }
  return { action: 'submit', message: `重新执行这次${label}` };
}

/** 保存结果（与 PersistOutcome + 领域拒绝对齐） */
export type CommitOutcome =
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }
  | { kind: 'not-attempted' }
  | { kind: 'domain-rejected'; message: string };

export interface CommitOutcomeEffect {
  /** 是否关窗（只有 saved 才关） */
  close: boolean;
  /** 关窗后的新状态；null 表示清空配置 */
  next: { phase: CommitPhase; submitted: boolean } | null;
  /** 需要展示的错误文案 */
  error: string | null;
  /** 是否已写入（可能成为待存草稿） */
  submitted: boolean;
}

/**
 * 把保存结果映射为 UI 效果。
 *
 * 关键：**只有 saved 才关窗并报成功**；失败一律保留配置并标记 submitted=true，
 * 这样重试只走「重试保存」，不会重复执行领域操作。
 * not-attempted（输入被暂停/只读）也按失败处理 —— 绝不能提示成功。
 */
export function commitPhaseAfterOutcome(
  s: { phase: CommitPhase; submitted: boolean },
  outcome: CommitOutcome,
  label: string,
): CommitOutcomeEffect {
  switch (outcome.kind) {
    case 'saved':
      return { close: true, next: null, error: null, submitted: false };
    case 'failed':
      return {
        close: false,
        next: { ...s, phase: 'failed', submitted: true },
        error: `这次${label}没有保存成功：${outcome.message}。配置已保留，可重试保存或放弃这份改动。`,
        submitted: true,
      };
    case 'not-attempted':
      return {
        close: false,
        next: { ...s, phase: 'failed', submitted: true },
        error: `这次${label}没有保存成功：当前不可写入（还有改动没存进本机，或本页只读）。`,
        submitted: true,
      };
    case 'domain-rejected':
      return {
        close: false,
        // 领域明确拒绝 = 本次没有写入，回到可编辑态让用户修正
        next: { ...s, phase: 'editing', submitted: false },
        error: outcome.message,
        submitted: false,
      };
  }
}

/**
 * 添加动作配置的初始值（可预填，用户可改）。
 *
 * 沿用旧行为的历史默认值：3 组、8–12 次、休息 120 秒。
 * 只是**默认值**，不再是不可改的固定值。
 */
export const ADD_EXERCISE_DEFAULTS: LooseExerciseConfig = {
  name: '',
  sets: 3,
  repsMin: 8,
  repsMax: 12,
  restSec: 120,
};

/** 生成一次提交意图的稳定 ID（与 replace 的 commitId 同风格） */
export function newCommitId(prefix: 'add' | 'remove'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
