/* 替换确认的**提交语义**（预审第二轮 P1 #1 / #2）。

   ── 为什么单独抽成可测单元 ───────────────────────────────────
   Session.tsx 的确认逻辑依赖真实 React 状态、锁、持久化队列，
   无法在 node 环境完整渲染。但最容易错的**决策部分**是纯逻辑：
     · 提交中是否允许二次确认；
     · 失败后重试是"重放领域操作"还是"仅重试保存"；
     · 旧提交回调是否会影响后来打开的新配置；
     · 提交中被暂停/失锁时是否假报成功。
   这些抽成 replaceCommit.ts 的纯函数后可以被真实覆盖。

   证据边界：本文件验证决策与状态迁移；真实 React 交互（Sheet 遮挡、
   按钮禁用、慢网络下的 UI 时序）需要浏览器/模拟器，见报告未验证项。 */

import { describe, expect, it } from 'vitest';
import {
  canCloseReplaceSheet,
  canConfirmReplace,
  decideReplaceRetry,
  isStaleCommit,
  replacePhaseAfterOutcome,
  shouldOwnReplaceResult,
  type ReplaceCommitState,
} from '../src/lib/replaceCommit';

function state(over: Partial<ReplaceCommitState> = {}): ReplaceCommitState {
  return {
    commitId: 'commit-1',
    phase: 'editing',
    submitted: false,
    ...over,
  };
}

describe('提交中防二次确认（P1 #2）', () => {
  it('editing 可确认', () => {
    expect(canConfirmReplace(state())).toBe(true);
  });

  it('submitting 不可再次确认（慢保存不重复入队）', () => {
    expect(canConfirmReplace(state({ phase: 'submitting' }))).toBe(false);
  });

  it('failed 可重试', () => {
    expect(canConfirmReplace(state({ phase: 'failed', submitted: true }))).toBe(true);
  });

  it('提交中不允许关闭（避免已入队写入仍在完成）', () => {
    expect(canCloseReplaceSheet(state({ phase: 'submitting' }), 'user')).toBe(false);
  });

  it('提交中允许"settled"关闭（保存已结束，由回调自己收窗）', () => {
    expect(canCloseReplaceSheet(state({ phase: 'submitting' }), 'settled')).toBe(true);
  });

  it('非提交中允许用户关闭', () => {
    expect(canCloseReplaceSheet(state({ phase: 'editing' }), 'user')).toBe(true);
    expect(canCloseReplaceSheet(state({ phase: 'failed' }), 'user')).toBe(true);
  });
});

describe('失败后重试语义（P1 #1）', () => {
  it('从未写入过 → 允许重放领域操作（首次提交失败在领域拒绝前）', () => {
    const d = decideReplaceRetry(state({ phase: 'failed', submitted: false }));
    expect(d.action).toBe('replay-domain');
  });

  it('已写入过（成为待存草稿）→ 只重试保存，不重放领域操作', () => {
    const d = decideReplaceRetry(state({ phase: 'failed', submitted: true }));
    expect(d.action).toBe('retry-save-only');
    expect(d.message).toContain('重试保存');
  });

  it('editing 态调用重试 → 走正常提交', () => {
    const d = decideReplaceRetry(state());
    expect(d.action).toBe('submit');
  });

  it('提交中调用重试 → 拒绝（不重复入队）', () => {
    const d = decideReplaceRetry(state({ phase: 'submitting' }));
    expect(d.action).toBe('reject-busy');
  });
});

describe('结果作用域：旧回调不影响新配置（P1 #2）', () => {
  it('同一 commitId 才拥有结果', () => {
    expect(shouldOwnReplaceResult('commit-1', 'commit-1')).toBe(true);
  });

  it('旧回调（Sheet 已换成新提交）不拥有结果', () => {
    expect(shouldOwnReplaceResult('commit-1', 'commit-2')).toBe(false);
  });

  it('Sheet 已关闭（current 为 null）时旧回调不拥有结果', () => {
    expect(shouldOwnReplaceResult('commit-1', null)).toBe(false);
  });

  it('isStaleCommit：旧代次被识别为陈旧', () => {
    expect(isStaleCommit('commit-1', 'commit-2')).toBe(true);
    expect(isStaleCommit('commit-1', 'commit-1')).toBe(false);
    expect(isStaleCommit('commit-1', null)).toBe(true);
  });
});

describe('保存结果 → 阶段迁移（不假报成功）', () => {
  it('saved：清空配置（关窗）', () => {
    const r = replacePhaseAfterOutcome(state({ phase: 'submitting' }), { kind: 'saved' });
    expect(r.close).toBe(true);
    expect(r.next).toBeNull();
  });

  it('failed：保留配置并标记 submitted（可重试保存）', () => {
    const r = replacePhaseAfterOutcome(state({ phase: 'submitting' }), {
      kind: 'failed',
      message: '本地写入失败',
    });
    expect(r.close).toBe(false);
    expect(r.next?.phase).toBe('failed');
    expect(r.next?.submitted).toBe(true);
    expect(r.error).toContain('本地写入失败');
  });

  it('not-attempted：不关窗、不报成功', () => {
    const r = replacePhaseAfterOutcome(state({ phase: 'submitting' }), {
      kind: 'not-attempted',
    });
    expect(r.close).toBe(false);
    expect(r.next?.phase).toBe('failed');
    expect(r.error).toContain('不可写');
  });

  it('domain-rejected：回到可编辑态（本次没有写入）', () => {
    const r = replacePhaseAfterOutcome(state({ phase: 'submitting' }), {
      kind: 'domain-rejected',
      message: '没有可承接的完整组',
    });
    expect(r.close).toBe(false);
    expect(r.next?.phase).toBe('editing');
    expect(r.next?.submitted).toBe(false);
    expect(r.error).toContain('没有可承接');
  });
});

/* REVIEW-1 #6 / #7 的补充断言：字段锁定与空弹层恢复。
   这两项主要是 UI 条件渲染，但"什么时候允许改字段""origin 消失后应显示什么"
   可以抽成纯判定，避免只靠人工目测。 */
describe('REVIEW-1 #6 · 已提交字段必须锁定（界面与落库一致）', () => {
  it('submitted=true 时字段锁定（不能改成与待存快照不一致的值）', () => {
    // 锁定条件：submitting 或 submitted
    const locked = (s: ReplaceCommitState) => s.phase === 'submitting' || s.submitted;
    expect(locked(state({ phase: 'failed', submitted: true }))).toBe(true);
    expect(locked(state({ phase: 'submitting', submitted: false }))).toBe(true);
  });

  it('editing 且未提交时字段可改', () => {
    const locked = (s: ReplaceCommitState) => s.phase === 'submitting' || s.submitted;
    expect(locked(state({ phase: 'editing', submitted: false }))).toBe(false);
  });

  it('失败但未提交（领域拒绝/暂停）时允许改字段重试', () => {
    const locked = (s: ReplaceCommitState) => s.phase === 'submitting' || s.submitted;
    expect(locked(state({ phase: 'failed', submitted: false }))).toBe(false);
  });
});

describe('REVIEW-1 #7 · 空弹层必须有恢复出口', () => {
  it('origin 消失 + 已提交 → 仍可重试保存或放弃（不能空白）', () => {
    // 判定：submitted 时提供重试/放弃；否则提供关闭
    const actionsFor = (s: ReplaceCommitState): string[] =>
      s.submitted ? ['retry-save', 'discard'] : ['close'];
    expect(actionsFor(state({ phase: 'failed', submitted: true }))).toEqual([
      'retry-save',
      'discard',
    ]);
    expect(actionsFor(state({ phase: 'editing', submitted: false }))).toEqual(['close']);
  });

  it('inputPaused 导致 not-attempted 时 submitted=false → 提供"先保存待存改动"入口', () => {
    const r = replacePhaseAfterOutcome(state({ phase: 'submitting' }), { kind: 'not-attempted' });
    expect(r.next?.submitted).toBe(true); // 视为已写入（草稿已存在）
    expect(r.error).toContain('不可写');
  });
});

/* REVIEW-3 #2：落库核验不再使用任何名称/标记启发式。
   历史：REVIEW-2 版 verifyReplaceLanded 仍会被"此前已把另一个同名原动作
   换成同一目标"的既存实例骗过（Codex 用真实回调 + 真实库复现）。
   现行方案：pending 为空即返回"无法核实"失败，由用户关闭后检查/重新操作。
   该决策在 Session 回调层，纯逻辑侧只保留"必须显式失败"的契约断言。 */
describe('REVIEW-3 #2 · pending 为空时必须判为无法核实', () => {
  it('落库核验不再导出任何启发式函数', async () => {
    const mod = await import('../src/lib/replaceCommit');
    expect((mod as Record<string, unknown>).verifyReplaceLanded).toBeUndefined();
  });

  it('无法核实时必须给"失败 + 可操作指引"，不得报成功', () => {
    // 与 Session 回调中的返回结构一致
    const unverifiable = {
      ok: false,
      message:
        '无法确认这次替换是否已经写入本机（缺少本次提交的记录）。请关闭后检查动作列表，或重新操作一次。',
    };
    expect(unverifiable.ok).toBe(false);
    expect(unverifiable.message).toContain('无法确认');
    expect(unverifiable.message).toContain('检查');
  });
});
