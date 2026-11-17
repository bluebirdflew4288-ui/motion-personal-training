/* 训练中「从本次训练移除动作」的数据保护与提交语义（旧添加配置契约已退役）。 */

import { describe, expect, it } from 'vitest';
import {
  createSession,
  exerciseCompletion,
  exerciseRemovalProtection,
  setHasActualInput,
  removeExerciseFromSession,
  roundsOf,
  skipRemaining,
  summarizeSession,
  withExercise,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  applyDeleteItem,
  previewDeleteItem,
  undoDeleteItem,
  type DeleteUndoRecord,
} from '../src/domain/sessionItemIntent';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
function chestSession() {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.name === '胸 A')!;
  return { plan, day, session: createSession(plan, day, NOW) };
}
describe('问题三 B · 移除：无记录时按 ID 移除，其余保持', () => {
  it('移除中间一项：其他动作身份、数据、相对顺序不变', () => {
    const { session } = chestSession();
    expect(session.exercises.length).toBeGreaterThanOrEqual(3);
    const idsBefore = session.exercises.map((e) => e.id);
    const targetId = idsBefore[1];

    const r = removeExerciseFromSession(session, targetId);
    expect(r.removed).toBe(true);
    expect(r.name).toBe(session.exercises[1].name);
    expect(r.session.exercises.map((e) => e.id)).toEqual(idsBefore.filter((id) => id !== targetId));
    // 剩余动作的组/记录完全没被改动
    for (const ex of r.session.exercises) {
      const before = session.exercises.find((e) => e.id === ex.id)!;
      expect(JSON.stringify(ex)).toBe(JSON.stringify(before));
    }
  });

  it('找不到 ID 或重复移除 → 不改数据（旧回调/重试安全）', () => {
    const { session } = chestSession();
    const before = JSON.stringify(session);
    const missing = removeExerciseFromSession(session, 'sex-does-not-exist');
    expect(missing.removed).toBe(false);
    expect(JSON.stringify(missing.session)).toBe(before);

    const id = session.exercises[0].id;
    const once = removeExerciseFromSession(session, id);
    expect(once.removed).toBe(true);
    const twice = removeExerciseFromSession(once.session, id);
    expect(twice.removed).toBe(false);
    expect(JSON.stringify(twice.session)).toBe(JSON.stringify(once.session));
  });
});

describe('问题三 B · 有实际输入/记录必须保护', () => {
  function firstStraight(session: Session) {
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    return ex;
  }

  it('完全空白 → 不保护（可移除）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const check = exerciseRemovalProtection(ex);
    expect(check.protected).toBe(false);
    expect(check.reasons).toHaveLength(0);
  });

  it('次数 0 也算实际输入（不能当「还没做」删掉）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 0 });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('重量 0 也算实际输入', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { weightKg: 0 });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('partial（已做但缺数据）受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { weightKg: 42.5, status: 'partial' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('组备注受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { note: '肩有点紧' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('动作备注受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withExercise(session, ex.id, { note: '器械调到 3 档' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
    expect(check.reasons.some((r) => r.includes('备注'))).toBe(true);
  });

  it('动作级标记完成受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withExercise(session, ex.id, { status: 'done' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('未提交 raw 草稿受保护（由 UI 传入）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const check = exerciseRemovalProtection(ex, { hasRawDraft: true });
    expect(check.protected).toBe(true);
    expect(check.reasons.some((r) => r.includes('草稿'))).toBe(true);
  });

  it('递减组：某一阶段有记录也受保护（不是只看完成轮数）', () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.name === '腿 A')!;
    const session = createSession(plan, day, NOW);
    const drop = session.exercises.find((e) => e.target.kind === 'dropSet')!;
    // 只填第 1 轮第 1 阶段
    const stage1 = drop.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    const s = withSet(session, drop.id, stage1.id, { reps: 12, weightKg: 7.5, status: 'done' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === drop.id)!);
    expect(check.protected).toBe(true);
  });

  it('受保护时移除函数仍只按 ID 生效，UI 需确认影响后才允许删除（核验判据与数据一致）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, status: 'done' });
    const cur = s.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseRemovalProtection(cur).protected).toBe(true);
    // 记录确实存在（保护不是空判据）
    expect(cur.sets.some(setHasActualInput)).toBe(true);
  });
});

describe('问题三 B · 纯跳过不算实际成果，但语义不变', () => {
  it('跳过剩余组后：无实际输入 → 可移除；有记录的组仍计入实际量', () => {
    const { session } = chestSession();
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    const skipped = skipRemaining(session, ex.id);
    const skippedEx = skipped.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseCompletion(skippedEx)).toBe('skipped');
    // 纯跳过（无任何实际输入）→ 不保护
    expect(exerciseRemovalProtection(skippedEx).protected).toBe(false);

    // 先做 1 组再跳过剩余：已有实际输入 → 受保护
    const first = ex.sets[0];
    const withOne = withSet(session, ex.id, first.id, { reps: 10, status: 'done' });
    const mixed = skipRemaining(withOne, ex.id);
    const mixedEx = mixed.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseRemovalProtection(mixedEx).protected).toBe(true);
    // 既有语义不变：已记录的组仍计入完成量
    expect(summarizeSession(mixed, NOW).completedSets).toBeGreaterThanOrEqual(1);
  });

  it('移除一个纯跳过动作后，其余动作与统计口径不受影响', () => {
    const { session } = chestSession();
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    const skipped = skipRemaining(session, ex.id);
    const before = summarizeSession(skipped, NOW);
    const r = removeExerciseFromSession(skipped, ex.id);
    const after = summarizeSession(r.session, NOW);
    expect(after.completedSets).toBe(before.completedSets);
    expect(after.exercisesSkipped).toBe(before.exercisesSkipped - 1);
    expect(roundsOf(r.session.exercises[0]).length).toBe(roundsOf(session.exercises[0]).length);
  });
});

describe('提交语义 C · 归属、幂等与结果映射（当前 sessionItemIntent 生产 API）', () => {
  /** G3A2-FIX1：旧 exerciseCommit 三态已退役；仍适用的保护迁移到当前删除意图。 */
  it('稳定意图 token 唯一；跨 session 的旧预览不得删除新训练对象', () => {
    const { session } = chestSession();
    const tokens = new Set(Array.from({ length: 50 }, () => {
      const p = previewDeleteItem(session, session.exercises[0].id);
      if (!p.ok) throw new Error('preview failed');
      return p.preview.token;
    }));
    expect(tokens.size).toBe(50);

    const p = previewDeleteItem(session, session.exercises[0].id);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // 旧预览（属于另一条训练）必须被拒绝，不能按 ID 误删当前对象
    const foreign = { ...p.preview, sessionId: 'other-session' };
    const r = applyDeleteItem(session, foreign, { confirmed: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('conflict');
    expect(session.exercises.length).toBeGreaterThan(0);
    expect(session.exercises.some((e) => e.id === p.preview.itemId)).toBe(true);
  });

  it('同一 undo 只能消费一次；重复恢复被拒绝（不重复追加）', () => {
    const { session } = chestSession();
    const p = previewDeleteItem(session, session.exercises[0].id);
    if (!p.ok) throw new Error('preview failed');
    const del = applyDeleteItem(session, p.preview, { now: NOW });
    expect(del.ok).toBe(true);
    if (!del.ok || !del.undo) throw new Error('blank delete should return undo');
    const undo = del.undo as DeleteUndoRecord;
    const first = undoDeleteItem(del.session, undo, NOW + 100);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 已恢复过：同 ID 已存在 → 明确拒绝，不产生第二个副本
    const second = undoDeleteItem(first.session, undo, NOW + 200);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('duplicate');
    expect(first.session.exercises.filter((e) => e.id === undo.itemId)).toHaveLength(1);
  });

  it('失败/冲突时不得产生 undo，也不得假报已删除', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const p = previewDeleteItem(session, ex.id);
    if (!p.ok) throw new Error('preview failed');
    // 未确认的有数据删除：明确拒绝且不返回 undo
    const withData = {
      ...session,
      exercises: session.exercises.map((e, i) => (i === 0 ? { ...e, sets: e.sets.map((st) => ({ ...st, reps: 0, status: 'done' as const })) } : e)),
    };
    const p2 = previewDeleteItem(withData, ex.id);
    if (!p2.ok) throw new Error('preview2 failed');
    const blocked = applyDeleteItem(withData, p2.preview);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('confirm-required');
    // 对象在确认期间变化 → conflict，且原数据保持不变
    const changed = { ...withData, exercises: withData.exercises.map((e, i) => (i === 0 ? { ...e, sets: e.sets.map((st) => ({ ...st, reps: 5 })) } : e)) };
    const conflict = applyDeleteItem(changed, p2.preview, { confirmed: true });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe('conflict');
    expect(changed.exercises.find((e) => e.id === ex.id)!.sets[0].reps).toBe(5);
  });
});
