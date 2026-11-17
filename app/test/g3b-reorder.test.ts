/* G3B：卡片排序领域 + 手势纯判定（不冒充真实触摸/UI 验收）。 */
import { describe, expect, it } from 'vitest';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import { reorderSessionItems } from '../src/domain/reorder';
import { createCardioEntry } from '../src/domain/cardio';
import {
  AXIS_THRESHOLD,
  autoScrollVelocity,
  decideAxis,
  dropIndexFor,
  orderAfterDrop,
} from '../src/ui/cardGestures';
import { shiftForIndex, type CardDragSnapshot } from '../src/ui/cardDrag';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
function makeSession(): Session {
  const plan = createV32Plan(NOW);
  return createSession(plan, plan.days[0], NOW);
}

describe('G3B 排序领域', () => {
  it('力量分区按 ID 顺序重排：只改顺序，sets/ID 不变', () => {
    const s = makeSession();
    const ids = s.exercises.map((e) => e.id);
    const before = JSON.stringify(s.exercises);
    const ordered = [ids[2], ids[0], ids[1], ...ids.slice(3)];
    const r = reorderSessionItems(s, 'strength', ordered);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.session.exercises.map((e) => e.id)).toEqual(ordered);
    // 元素对象未重建（深比较与原始完全一致）
    expect(JSON.stringify([...r.session.exercises].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)))).toBe(before);
    // 其他字段不受影响
    expect(r.session.targetSetsAtStart).toBe(s.targetSetsAtStart);
    expect(r.session.planId).toBe(s.planId);
    expect(r.session.revision).toBe(s.revision);
  });

  it('顺序未变化时 changed=false，不产生新对象语义', () => {
    const s = makeSession();
    const r = reorderSessionItems(s, 'strength', s.exercises.map((e) => e.id));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.changed).toBe(false);
  });

  it('拒绝：增删/重复/未知 ID/终态', () => {
    const s = makeSession();
    const ids = s.exercises.map((e) => e.id);
    expect(reorderSessionItems(s, 'strength', ids.slice(1)).ok).toBe(false);
    expect(reorderSessionItems(s, 'strength', [ids[0], ids[0], ...ids.slice(2)]).ok).toBe(false);
    expect(reorderSessionItems(s, 'strength', [...ids.slice(0, -1), 'ghost']).ok).toBe(false);
    const done = { ...s, status: 'completed' as const };
    const r = reorderSessionItems(done, 'strength', [ids[1], ids[0], ...ids.slice(2)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-active');
  });

  it('有氧分区独立排序，不影响力量顺序', () => {
    const s = makeSession();
    const a = createCardioEntry({ preset: 'treadmill-incline', name: 'A', params: { speedKmh: 5, inclinePct: 0 } });
    const b = { ...createCardioEntry({ preset: 'stair-climber', name: 'B', params: { level: 1 } }), id: 'cardio-b' };
    const withCardio = { ...s, cardio: [a, b] };
    const r = reorderSessionItems(withCardio, 'cardio', [b.id, a.id]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.cardio!.map((c) => c.id)).toEqual([b.id, a.id]);
    expect(r.session.exercises.map((e) => e.id)).toEqual(withCardio.exercises.map((e) => e.id));
    // 计时/分段等 entry 内容不变
    expect(r.session.cardio!.find((c) => c.id === a.id)).toEqual(a);
  });
});

describe('G3B 手势纯判定', () => {
  it('方向判定：未决/纵向/横向，斜滑按主轴', () => {
    expect(decideAxis(3, 4)).toBe('undecided');
    expect(decideAxis(AXIS_THRESHOLD + 1, 0)).toBe('horizontal');
    expect(decideAxis(0, AXIS_THRESHOLD + 1)).toBe('vertical');
    expect(decideAxis(40, 12)).toBe('horizontal');
    expect(decideAxis(12, 40)).toBe('vertical');
  });

  it('落点索引：按各卡中线插入，边界夹紧', () => {
    const rects = [
      { top: 0, height: 100 },
      { top: 100, height: 100 },
      { top: 200, height: 100 },
    ];
    expect(dropIndexFor(-50, rects)).toBe(0);
    expect(dropIndexFor(10, rects)).toBe(0);
    expect(dropIndexFor(60, rects)).toBe(1);
    expect(dropIndexFor(160, rects)).toBe(2);
    expect(dropIndexFor(999, rects)).toBe(3);
  });

  it('自动滚动：边缘内按深度加速，离开边缘为 0', () => {
    expect(autoScrollVelocity(400, 0, 800)).toBe(0);
    expect(autoScrollVelocity(10, 0, 800)).toBeLessThan(0);
    expect(autoScrollVelocity(790, 0, 800)).toBeGreaterThan(0);
    expect(Math.abs(autoScrollVelocity(0, 0, 800))).toBeGreaterThan(Math.abs(autoScrollVelocity(60, 0, 800)));
  });

  it('orderAfterDrop 为插入语义（不是交换）', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(orderAfterDrop(ids, 0, 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(orderAfterDrop(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(orderAfterDrop(ids, 1, 1)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('shiftForIndex：拖动时邻居让位，源卡不位移', () => {
    const snap: CardDragSnapshot = {
      id: 'b', kind: 'strength', ids: ['a', 'b', 'c', 'd'],
      fromIndex: 1, overIndex: 3, offsetY: 40, height: 100,
    };
    expect(shiftForIndex(snap, 0)).toBe(0);
    expect(shiftForIndex(snap, 1)).toBe(0); // 源卡自身
    expect(shiftForIndex(snap, 2)).toBe(-100);
    expect(shiftForIndex(snap, 3)).toBe(0);
  });
});
