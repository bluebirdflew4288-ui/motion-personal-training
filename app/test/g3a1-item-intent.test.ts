/* G3A1：删除/撤销领域意图（纯函数，不冒充 UI/真机）。 */
import { describe, expect, it } from 'vitest';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import { createCardioEntry } from '../src/domain/cardio';
import {
  applyDeleteItem,
  previewDeleteItem,
  undoDeleteItem,
  type DeleteUndoRecord,
} from '../src/domain/sessionItemIntent';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
function makeSession(): Session {
  const plan = createV32Plan(NOW);
  return createSession(plan, plan.days[0], NOW);
}
function withThree(s: Session): Session {
  const base = s.exercises[0];
  return {
    ...s,
    exercises: [
      { ...structuredClone(base), id: 'ex-a' },
      { ...structuredClone(base), id: 'ex-b', name: '同名动作' },
      { ...structuredClone(base), id: 'ex-c', name: '同名动作' },
    ],
  };
}

describe('G3A1 delete/undo intent', () => {
  it('空白删除撤销：只恢复被删项，保留后来的其他输入', () => {
    let s = withThree(makeSession());
    const preview = previewDeleteItem(s, 'ex-b');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const del = applyDeleteItem(s, preview.preview, { now: NOW });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.session.exercises.map((e) => e.id)).toEqual(['ex-a', 'ex-c']);
    // 删除后另一个动作产生新输入
    const changed = { ...del.session, exercises: del.session.exercises.map((e, i) => i === 0 ? { ...e, sets: e.sets.map((x, j) => j === 0 ? { ...x, reps: 12 } : x) } : e) };
    const undo = undoDeleteItem(changed, del.undo as DeleteUndoRecord, NOW + 1000);
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.session.exercises.map((e) => e.id)).toEqual(['ex-a', 'ex-b', 'ex-c']);
    expect(undo.session.exercises.find((e) => e.id === 'ex-a')!.sets[0].reps).toBe(12);
  });

  it('0 次数也算实际输入：必须先确认；确认后允许删除', () => {
    let s = withThree(makeSession());
    s = { ...s, exercises: s.exercises.map((e, i) => i === 1 ? { ...e, sets: e.sets.map((x) => ({ ...x, reps: 0, status: 'done' })) } : e) };
    const p = previewDeleteItem(s, 'ex-b');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.requiresConfirm).toBe(true);
    const blocked = applyDeleteItem(s, p.preview);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('confirm-required');
    const ok = applyDeleteItem(s, p.preview, { confirmed: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.undo).toBeNull();
  });

  it('raw 风险与终态/缺失拒绝', () => {
    let s = withThree(makeSession());
    const raw = previewDeleteItem(s, 'ex-b', { hasRawDraft: true });
    expect(raw.ok && raw.preview.requiresConfirm).toBe(true);
    const missing = previewDeleteItem(s, 'nope');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('missing');
    const done = { ...s, status: 'completed' as const };
    const terminal = previewDeleteItem(done, 'ex-b');
    expect(terminal.ok).toBe(false);
    if (!terminal.ok) expect(terminal.reason).toBe('not-active');
  });

  it('同名不同 ID 只删除目标条目', () => {
    const s = withThree(makeSession());
    const p = previewDeleteItem(s, 'ex-c');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const del = applyDeleteItem(s, p.preview, { confirmed: true });
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.session.exercises.filter((e) => e.name === '同名动作').map((e) => e.id)).toEqual(['ex-b']);
  });

  it('有氧数据纳入影响；确认删除清理 cardioPausedBySession', () => {
    const s = makeSession();
    const a = createCardioEntry({ preset: 'treadmill-incline', name: '跑步机', params: { speedKmh: 5, inclinePct: 0 } });
    const b = { ...createCardioEntry({ preset: 'stair-climber', name: '爬楼机', params: { level: 1 } }), id: 'cardio-b' };
    const withCardio = { ...s, cardio: [{ ...a, status: 'running' as const, elapsedMs: 5000, runningSinceAt: NOW }, b], cardioPausedBySession: [a.id, b.id] };
    const p = previewDeleteItem(withCardio, a.id);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.requiresConfirm).toBe(true);
    const del = applyDeleteItem(withCardio, p.preview, { confirmed: true });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.session.cardio!.map((c) => c.id)).toEqual([b.id]);
    expect(del.session.cardioPausedBySession).toEqual([b.id]);
  });

  it('空白有氧可撤销，恢复快照不复活 running', () => {
    const s = makeSession();
    const a = createCardioEntry({ preset: 'treadmill-incline', name: '空白有氧', params: { speedKmh: 5, inclinePct: 0 } });
    const withCardio = { ...s, cardio: [a] };
    const p = previewDeleteItem(withCardio, a.id);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.requiresConfirm).toBe(false);
    const del = applyDeleteItem(withCardio, p.preview, { now: NOW });
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    const undo = undoDeleteItem(del.session, del.undo as DeleteUndoRecord, NOW + 10);
    expect(undo.ok).toBe(true);
    if (undo.ok) {
      expect(undo.session.cardio).toHaveLength(1);
      expect(undo.session.cardio![0].runningSinceAt).toBeNull();
    }
  });

  it('undo 过期/重复/容量冲突明确拒绝', () => {
    const s = withThree(makeSession());
    const p = previewDeleteItem(s, 'ex-b');
    if (!p.ok) throw new Error('fixture');
    const del = applyDeleteItem(s, p.preview, { now: NOW });
    if (!del.ok || !del.undo) throw new Error('fixture');
    const undo = del.undo;
    expect(undoDeleteItem(del.session, undo, NOW + 60_001).ok).toBe(false);
    expect(undoDeleteItem(s, undo, NOW + 1).ok).toBe(false); // 已存在同 ID
  });

  it('删除不改变原计划目标快照 targetSetsAtStart', () => {
    const s = withThree(makeSession());
    const p = previewDeleteItem(s, 'ex-b');
    if (!p.ok) throw new Error('fixture');
    const del = applyDeleteItem(s, p.preview, { confirmed: true });
    expect(del.ok).toBe(true);
    if (del.ok) expect(del.session.targetSetsAtStart).toBe(s.targetSetsAtStart);
  });
  it('preview 后出现新 raw：旧 preview 必须风险冲突/重新确认，不能删除', () => {
    const s = withThree(makeSession());
    const p = previewDeleteItem(s, 'ex-b');
    if (!p.ok) throw new Error('fixture');
    expect(p.preview.hasData).toBe(false);
    const changed = applyDeleteItem(s, p.preview, { hasRawDraft: true });
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(['risk-changed', 'confirm-required']).toContain(changed.reason);
  });

  it('cardio note 非空视为有数据，必须确认', () => {
    const s = makeSession();
    const entry = { ...createCardioEntry({ preset: 'treadmill-incline', name: '备注有氧', params: { speedKmh: 4, inclinePct: 0 } }), note: '膝盖不适' };
    const p = previewDeleteItem({ ...s, cardio: [entry] }, entry.id);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.requiresConfirm).toBe(true);
    expect(p.preview.reasons.join('')).toContain('备注');
  });

  it('undo 前邻居消失时回退到仍存活后邻居之前', () => {
    let s = withThree(makeSession());
    const p = previewDeleteItem(s, 'ex-b');
    if (!p.ok) throw new Error('fixture');
    const del = applyDeleteItem(s, p.preview, { now: NOW });
    if (!del.ok || !del.undo) throw new Error('fixture');
    // [ex-a, ex-c] -> 移除 ex-a 并插入 X/Y（C 前），模拟后续合法变化
    const base = del.session.exercises.find((e) => e.id === 'ex-c')!;
    const x = { ...structuredClone(base), id: 'ex-x', name: 'X' };
    const y = { ...structuredClone(base), id: 'ex-y', name: 'Y' };
    const changed = { ...del.session, exercises: [x, y, base] };
    const undo = undoDeleteItem(changed, del.undo, NOW + 10);
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.session.exercises.map((e) => e.id)).toEqual(['ex-x', 'ex-y', 'ex-b', 'ex-c']);
  });

});
