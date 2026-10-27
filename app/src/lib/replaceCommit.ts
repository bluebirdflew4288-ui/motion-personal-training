/* 替换确认的提交语义（纯逻辑，便于真实测试）。
   ── 为什么需要 ────────────────────────────────────────────────
   Session.tsx 的替换确认涉及四件容易错的事（预审第二轮 P1 #1/#2）：
   1. 慢保存期间"确认/取消/关闭"仍可点 → 重复入队或丢配置；
   2. 失败后产生待存草稿 → inputPaused 把再次确认拒绝，
      而 Sheet 遮住外面的重试横幅 → 用户被锁死在空弹层里；
   3. 旧提交的成功回调无条件关窗 → 会清掉后来打开的新配置；
   4. 已写入过再重试时若重放领域操作 → 对旧 targetId 二次替换 / 重复承接。

   把这些判定抽成纯函数，UI 只做渲染与副作用，测试才能真实覆盖决策。 */

/** 一次替换提交的可观测状态 */
export interface ReplaceCommitState {
  /** 本次替换意图的稳定标识 */
  commitId: string;
  /** editing=可改可确认；submitting=已提交等结果；failed=可重试 */
  phase: 'editing' | 'submitting' | 'failed';
  /** 是否已经把改动写进 latestRef（即可能已形成待存草稿） */
  submitted: boolean;
}

/** 关闭来源：user=用户点取消/关闭；settled=保存已结束由回调收窗 */
export type CloseReason = 'user' | 'settled';

/** 是否允许点「确认替换」/「重试」 */
export function canConfirmReplace(s: ReplaceCommitState | null): boolean {
  if (!s) return false;
  // 提交中一律禁止：慢保存下重复确认会重复入队
  return s.phase !== 'submitting';
}

/** 是否允许关闭 Sheet */
export function canCloseReplaceSheet(s: ReplaceCommitState | null, reason: CloseReason): boolean {
  if (!s) return true;
  // 保存结果已确定（settled）时允许收窗；用户主动关闭时提交中要拦住
  if (reason === 'settled') return true;
  return s.phase !== 'submitting';
}

/** 重试决策 */
export type ReplaceRetryAction = 'submit' | 'retry-save-only' | 'replay-domain' | 'reject-busy';

export interface ReplaceRetryDecision {
  action: ReplaceRetryAction;
  message: string;
}

/**
 * 失败后点「重试」应该做什么。
 *
 * · submitted=true  → 改动已在本页（可能已成待存草稿），**只重试保存**，
 *   绝不重放领域操作（否则旧 targetId 可能已不存在，或对跳过组二次承接）。
 * · submitted=false → 领域层明确拒绝或未写入，回到正常提交即可。
 */
export function decideReplaceRetry(s: ReplaceCommitState | null): ReplaceRetryDecision {
  if (!s) return { action: 'reject-busy', message: '没有待处理的替换配置' };
  if (s.phase === 'submitting') {
    return { action: 'reject-busy', message: '正在保存这次替换，请稍候' };
  }
  if (s.phase === 'editing') {
    return { action: 'submit', message: '提交这次替换' };
  }
  if (s.submitted) {
    return { action: 'retry-save-only', message: '重试保存这次替换（不再重复替换动作）' };
  }
  return { action: 'replay-domain', message: '重新执行这次替换' };
}

/** 结果是否属于当前这次提交（防旧回调清掉新配置） */
export function shouldOwnReplaceResult(commitId: string, currentCommitId: string | null): boolean {
  if (currentCommitId === null) return false;
  return commitId === currentCommitId;
}

/** 旧代次判定（语义与 shouldOwnReplaceResult 相反，供显式分支使用） */
export function isStaleCommit(commitId: string, currentCommitId: string | null): boolean {
  return !shouldOwnReplaceResult(commitId, currentCommitId);
}

/** 保存结果（对应 PersistOutcome + 领域拒绝） */
export type ReplaceOutcome =
  | { kind: 'saved' }
  | { kind: 'failed'; message: string }
  | { kind: 'not-attempted' }
  | { kind: 'domain-rejected'; message: string };

export interface ReplaceOutcomeEffect {
  /** 是否关窗（只有 saved 才关） */
  close: boolean;
  /** 关窗后的新状态；null 表示清空配置 */
  next: ReplaceCommitState | null;
  /** 需要展示的错误文案 */
  error: string | null;
  /** 是否已写入（成为待存草稿） */
  submitted: boolean;
}

/**
 * 把保存结果映射为 UI 效果。
 * 关键：只有 saved 才关窗；失败一律保留配置并标记 submitted=true，
 * 这样重试只走「重试保存」，不会二次替换。
 */
export function replacePhaseAfterOutcome(
  s: ReplaceCommitState,
  outcome: ReplaceOutcome,
): ReplaceOutcomeEffect {
  switch (outcome.kind) {
    case 'saved':
      return { close: true, next: null, error: null, submitted: false };
    case 'failed':
      return {
        close: false,
        next: { ...s, phase: 'failed', submitted: true },
        error: `替换没有保存成功：${outcome.message}。配置已保留，可重试保存或放弃这份改动。`,
        submitted: true,
      };
    case 'not-attempted':
      return {
        close: false,
        next: { ...s, phase: 'failed', submitted: true },
        error: '替换没有保存成功：当前不可写入（还有改动没存进本机，或本页只读）。',
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

/*
  说明：`verifyReplaceLanded` 已**移除**（REVIEW-3 #2）。

  历史：它先只比名称，后被加上「replacedFrom==originName + id!=oldID」启发式。
  但 Codex 用真实回调 + 真实库证明：同一训练此前已把**另一个同名原动作**
  换成同一目标时，库里就存在完全符合这些条件的既存实例 ——
  于是"本次其实没保存"会被误判成"已保存"。

  结论：任何基于名称/标记的推断都无法证明"这是本次提交的结果"。
  按 REVIEW-3 的最小安全方案，pending 为空时一律返回"无法核实"失败，
  让用户关闭后自行检查或重新操作；不为此罕见分支新增存储协议。
*/
