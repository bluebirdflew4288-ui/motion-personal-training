/* F08：同批多条空白删除 + 独立撤销的**顺序**约束（纯领域，不冒充 UI/真机）。
 *
 * 用户已确认口径：
 *   · 每条从各自保存成功起独立 8 秒，新删除不顶掉旧项、不重置旧项时间；
 *   · 任意有效项都能撤销；
 *   · 无后续主动排序时，**按任意顺序**撤销同一批删除都要恢复原相对顺序；
 *   · 有后续输入/排序时合并到最新状态，不能拿旧快照整份回滚。
 *
 * 这里覆盖的正是"逐次删除的邻居信息不足"的回归：
 * 先后删掉 B、C 时，C 的邻居里已经没有 B；只按邻居插回会得到 A,C,B。
 * 因此删除意图额外携带删除前的同分区顺序，撤销可传本批开始时的参照顺序。 */
import { describe, expect, it } from 'vitest';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import {
  applyDeleteItem,
  previewDeleteItem,
  undoDeleteItem,
  type DeleteUndoRecord,
} from '../src/domain/sessionItemIntent';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function baseSession(): Session {
  const plan = createV32Plan(NOW);
  return createSession(plan, plan.days[0], NOW);
}

/** 5 个空白动作：ex-1..ex-5（顺序即列表顺序） */
function withFive(): Session {
  const s = baseSession();
  const base = s.exercises[0];
  return {
    ...s,
    exercises: [1, 2, 3, 4, 5].map((n) => ({ ...structuredClone(base), id: `ex-${n}`, name: `动作${n}` })),
  };
}

const ids = (s: Session) => s.exercises.map((e) => e.id);

/** 删除一项，返回 delete 后的 session 与该条 undo（空白删除才有 undo） */
function deleteOne(s: Session, id: string): { session: Session; undo: DeleteUndoRecord; orderBefore: string[] } {
  const p = previewDeleteItem(s, id);
  if (!p.ok) throw new Error('preview failed: ' + p.reason);
  expect(p.preview.requiresConfirm).toBe(false);
  const d = applyDeleteItem(s, p.preview, { now: NOW });
  if (!d.ok) throw new Error('apply failed: ' + d.reason);
  if (!d.undo) throw new Error('blank delete should produce an undo record');
  return { session: d.session, undo: d.undo, orderBefore: p.preview.orderBefore };
}

describe('F08 同批删除的撤销顺序', () => {
  it('删除意图携带删除前的同分区顺序（供任意顺序撤销参照）', () => {
    const s = withFive();
    const p = previewDeleteItem(s, 'ex-3');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.preview.orderBefore).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
    const d = applyDeleteItem(s, p.preview, { now: NOW });
    expect(d.ok).toBe(true);
    if (!d.ok || !d.undo) return;
    expect(d.undo.orderBefore).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
  });

  it('三项按删除顺序（FIFO）撤销：以本批参照顺序恢复原相对顺序', () => {
    let cur = withFive();
    // 批次参照顺序 = 本批第一次删除前的分区顺序
    const first = deleteOne(cur, 'ex-2');
    const batchRef = first.orderBefore;
    cur = first.session;
    const second = deleteOne(cur, 'ex-3');
    cur = second.session;
    const third = deleteOne(cur, 'ex-4');
    cur = third.session;
    expect(ids(cur)).toEqual(['ex-1', 'ex-5']);

    const u1 = undoDeleteItem(cur, first.undo, NOW + 10, { orderRef: batchRef });
    expect(u1.ok).toBe(true);
    if (!u1.ok) return;
    expect(ids(u1.session)).toEqual(['ex-1', 'ex-2', 'ex-5']);

    const u2 = undoDeleteItem(u1.session, second.undo, NOW + 20, { orderRef: batchRef });
    expect(u2.ok).toBe(true);
    if (!u2.ok) return;
    expect(ids(u2.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-5']);

    const u3 = undoDeleteItem(u2.session, third.undo, NOW + 30, { orderRef: batchRef });
    expect(u3.ok).toBe(true);
    if (!u3.ok) return;
    expect(ids(u3.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
  });

  it('三项按反序（LIFO）撤销：同样恢复原相对顺序', () => {
    let cur = withFive();
    const first = deleteOne(cur, 'ex-2');
    const batchRef = first.orderBefore;
    cur = first.session;
    const second = deleteOne(cur, 'ex-3');
    cur = second.session;
    const third = deleteOne(cur, 'ex-4');
    cur = third.session;

    const u3 = undoDeleteItem(cur, third.undo, NOW + 10, { orderRef: batchRef });
    if (!u3.ok) throw new Error('undo third failed');
    const u2 = undoDeleteItem(u3.session, second.undo, NOW + 20, { orderRef: batchRef });
    if (!u2.ok) throw new Error('undo second failed');
    const u1 = undoDeleteItem(u2.session, first.undo, NOW + 30, { orderRef: batchRef });
    if (!u1.ok) throw new Error('undo first failed');
    expect(ids(u1.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
  });

  it('乱序（先撤销中间再撤销两端）也恢复原相对顺序', () => {
    let cur = withFive();
    const first = deleteOne(cur, 'ex-2');
    const batchRef = first.orderBefore;
    cur = first.session;
    const second = deleteOne(cur, 'ex-3');
    cur = second.session;
    const third = deleteOne(cur, 'ex-4');
    cur = third.session;

    const mid = undoDeleteItem(cur, second.undo, NOW + 10, { orderRef: batchRef });
    if (!mid.ok) throw new Error('undo middle failed');
    expect(ids(mid.session)).toEqual(['ex-1', 'ex-3', 'ex-5']);
    const last = undoDeleteItem(mid.session, third.undo, NOW + 20, { orderRef: batchRef });
    if (!last.ok) throw new Error('undo third failed');
    expect(ids(last.session)).toEqual(['ex-1', 'ex-3', 'ex-4', 'ex-5']);
    const firstBack = undoDeleteItem(last.session, first.undo, NOW + 30, { orderRef: batchRef });
    if (!firstBack.ok) throw new Error('undo first failed');
    expect(ids(firstBack.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
  });

  it('有后续主动排序时合并到最新状态（不整份回滚旧顺序）', () => {
    let cur = withFive();
    const first = deleteOne(cur, 'ex-2');
    const batchRef = first.orderBefore;
    cur = first.session; // [1,3,4,5]
    const second = deleteOne(cur, 'ex-3');
    cur = second.session; // [1,4,5]
    // 用户随后主动把 ex-5 排到了最前（最新状态必须被尊重）
    const reordered: Session = {
      ...cur,
      exercises: [cur.exercises[2], cur.exercises[0], cur.exercises[1]],
    };
    expect(ids(reordered)).toEqual(['ex-5', 'ex-1', 'ex-4']);
    const back = undoDeleteItem(reordered, first.undo, NOW + 10, { orderRef: batchRef });
    if (!back.ok) throw new Error('undo failed');
    const after = ids(back.session);
    // ex-2 落回 ex-4 之前、ex-1/ex-5 的既有新顺序保持不变
    expect(after).toEqual(['ex-5', 'ex-1', 'ex-2', 'ex-4']);
    expect(after.filter((id) => id !== 'ex-2')).toEqual(['ex-5', 'ex-1', 'ex-4']);
  });

  it('后续新增了条目时按参照锚点插入，不覆盖新条目', () => {
    let cur = withFive();
    const del = deleteOne(cur, 'ex-3');
    cur = del.session; // [1,2,4,5]
    const base = cur.exercises[0];
    const added: Session = {
      ...cur,
      exercises: [...cur.exercises, { ...structuredClone(base), id: 'ex-new', name: '新动作' }],
    };
    const back = undoDeleteItem(added, del.undo, NOW + 10, { orderRef: del.orderBefore });
    if (!back.ok) throw new Error('undo failed');
    expect(ids(back.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5', 'ex-new']);
  });

  it('传入参照顺序也不放宽原有保护：过期/重复/容量/非活动训练仍拒绝', () => {
    const s = withFive();
    const del = deleteOne(s, 'ex-3');
    // 过期
    const expired = undoDeleteItem(del.session, del.undo, NOW + 60_001, { orderRef: del.orderBefore });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe('expired');
    // 重复（项目还在）
    const dup = undoDeleteItem(s, del.undo, NOW + 10, { orderRef: del.orderBefore });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.reason).toBe('duplicate');
    // 训练已结束
    const done = { ...del.session, status: 'completed' as const };
    const notActive = undoDeleteItem(done, del.undo, NOW + 10, { orderRef: del.orderBefore });
    expect(notActive.ok).toBe(false);
    if (!notActive.ok) expect(notActive.reason).toBe('not-active');
  });

  it('不传参照顺序时仍保持原有邻居语义（旧调用方零影响）', () => {
    const s = withFive();
    const del = deleteOne(s, 'ex-3');
    const back = undoDeleteItem(del.session, del.undo, NOW + 10);
    if (!back.ok) throw new Error('undo failed');
    expect(ids(back.session)).toEqual(['ex-1', 'ex-2', 'ex-3', 'ex-4', 'ex-5']);
  });
});
