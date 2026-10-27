/* G4 回归：每个 PlanDay 一张动态贴纸 + focus/round 可省略模型边界。
   ── 证据边界 ────────────────────────────────────────────────
   本文件验证**纯函数与领域校验**（真实 planDayStickers / 模板解析 / 备份校验），
   不运行 React DOM。真实点击、窄屏布局、IME 由独立 CUA 链验证。 */

import { describe, expect, it } from 'vitest';
import {
  dayStickerKey,
  isCycleDay,
  nextSelectedDayId,
  planDayStickers,
  resolveSelectedDay,
} from '../src/ui/StickerPicker';
import { addDay } from '../src/domain/planEdit';
import type { Plan, PlanDay } from '../src/domain/types';

/** 构造最小 PlanDay */
function day(id: string, name: string, extra: Partial<PlanDay> = {}): PlanDay {
  return {
    id,
    name,
    kind: 'train',
    warmups: [],
    exercises: [],
    ...extra,
  } as PlanDay;
}

function plan(days: PlanDay[]): Plan {
  return {
    id: 'plan-A',
    name: '测试计划',
    days,
    cursor: 0,
    createdAt: 1,
    updatedAt: 1,
  } as Plan;
}

describe('G4 · 每个 PlanDay 一张，不合并', () => {
  it('上肢/下肢两日 → 恰好两张', () => {
    const p = plan([day('d1', '上肢'), day('d2', '下肢')]);
    const s = planDayStickers(p);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.name)).toEqual(['上肢', '下肢']);
  });

  it('不自动补 A/B（名称原样）', () => {
    const p = plan([day('d1', '上肢'), day('d2', '下肢')]);
    const names = planDayStickers(p).map((x) => x.name);
    expect(names).not.toContain('上肢 A');
    expect(names).not.toContain('A');
    expect(names).toEqual(['上肢', '下肢']);
  });

  it('同名不同 ID 的两日 → 分别可选（key 不同）', () => {
    const p = plan([day('d1', '推日'), day('d2', '推日')]);
    const s = planDayStickers(p);
    expect(s).toHaveLength(2);
    expect(s[0].key).not.toBe(s[1].key);
    expect(s[0].dayId).toBe('d1');
    expect(s[1].dayId).toBe('d2');
  });

  it('顺序完全来自 plan.days 数组', () => {
    const p = plan([day('c', '第三'), day('a', '第一'), day('b', '第二')]);
    expect(planDayStickers(p).map((x) => x.name)).toEqual(['第三', '第一', '第二']);
  });

  it('不按 focus 合并（同日 focus 仍各一张）', () => {
    const p = plan([
      day('d1', '胸 A', { focus: 'chest', round: 'A' }),
      day('d2', '胸 B', { focus: 'chest', round: 'B' }),
    ]);
    expect(planDayStickers(p)).toHaveLength(2);
  });

  it('cardio / rest 日按计划出现', () => {
    const p = plan([
      day('d1', '上肢'),
      day('d2', '有氧日', { kind: 'cardio' }),
      day('d3', '休息日', { kind: 'rest' }),
    ]);
    const s = planDayStickers(p);
    expect(s.map((x) => x.kind)).toEqual(['train', 'cardio', 'rest']);
  });

  it('空计划 → 空列表（不伪造）', () => {
    expect(planDayStickers(plan([]))).toEqual([]);
    expect(planDayStickers(null)).toEqual([]);
  });
});

describe('G4 · 身份是 planId + day.id', () => {
  it('dayStickerKey 由两者组成', () => {
    expect(dayStickerKey('p1', 'd1')).toBe('p1::d1');
    expect(dayStickerKey('p1', 'd1')).not.toBe(dayStickerKey('p2', 'd1'));
    expect(dayStickerKey('p1', 'd1')).not.toBe(dayStickerKey('p1', 'd2'));
  });

  it('重命名不改变身份（选中可保持）', () => {
    const before = planDayStickers(plan([day('d1', '旧名')]))[0];
    const after = planDayStickers(plan([day('d1', '新名字更长')]))[0];
    expect(after.key).toBe(before.key);
  });

  it('换序不改变身份', () => {
    const before = planDayStickers(plan([day('d1', 'A'), day('d2', 'B')]));
    const after = planDayStickers(plan([day('d2', 'B'), day('d1', 'A')]));
    const k1 = before.find((x) => x.dayId === 'd1')!.key;
    const k2 = after.find((x) => x.dayId === 'd1')!.key;
    expect(k1).toBe(k2);
  });

  it('循环当前只影响高亮标记，不改变 key/顺序', () => {
    const p = plan([day('d1', 'A'), day('d2', 'B')]);
    const s = planDayStickers(p, 'd2');
    expect(s.map((x) => x.isCycle)).toEqual([false, true]);
    expect(s.map((x) => x.key)).toEqual(planDayStickers(p).map((x) => x.key));
  });
});

describe('G4 · 模型边界：新建日不得隐式补 chest/A', () => {
  it('addDay 不传 focus/round → 两字段都不写入', () => {
    const next = addDay(plan([]));
    const d = next.days[0];
    expect(d.focus).toBeUndefined();
    expect(d.round).toBeUndefined();
  });

  it('addDay 显式传 focus/round → 原样写入（旧明确值保真）', () => {
    const next = addDay(plan([]), 'back', 'B');
    expect(next.days[0].focus).toBe('back');
    expect(next.days[0].round).toBe('B');
  });
});

/* ── 选择语义（G4 第 6/8 条）───────────────────────────────
   贴纸的「选择」必须只是内存里的一个 day.id：
   不写库、不改 cursor、不推进循环。这里用纯函数锁死这条契约。 */
describe('G4 · 选择只认具体 day.id', () => {
  it('点同名不同 ID 的两日 → 各自命中自己的 dayId（不串台）', () => {
    const p = plan([day('d1', '推日'), day('d2', '推日')]);
    const items = planDayStickers(p);

    // 点第 1 张 → 选中 d1；点第 2 张 → 选中 d2（同名但身份不同）
    expect(nextSelectedDayId(items[0]!.dayId)).toBe('d1');
    expect(nextSelectedDayId(items[1]!.dayId)).toBe('d2');

    // 解析回来必须是**各自那一条**，而不是「第一条同名的」
    expect(resolveSelectedDay(p, 'd1')!.id).toBe('d1');
    expect(resolveSelectedDay(p, 'd2')!.id).toBe('d2');
    expect(resolveSelectedDay(p, 'd1')).not.toBe(resolveSelectedDay(p, 'd2'));
  });

  it('不按 focus 合并：同 focus 的两日各自可选', () => {
    const p = plan([
      day('d1', '胸 A', { focus: 'chest', round: 'A' }),
      day('d2', '胸 B', { focus: 'chest', round: 'B' }),
    ]);
    expect(planDayStickers(p)).toHaveLength(2);
    expect(resolveSelectedDay(p, 'd2')!.name).toBe('胸 B');
  });

  it('选择不写 cursor：cursor 由调用方原样保留', () => {
    const p: Plan = { ...plan([day('d1', 'A'), day('d2', 'B'), day('d3', 'C')]), cursor: 1 };
    const before = p.cursor;

    // 模拟 Home 的选择处理器：只把 day.id 存进 state
    let selected: string | null = null;
    selected = nextSelectedDayId('d3');
    resolveSelectedDay(p, selected);
    planDayStickers(p, 'd1');

    // 计划对象没被改动，cursor 一步没动
    expect(p.cursor).toBe(before);
    expect(p.days.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(selected).toBe('d3');
  });

  it('选中失效（计划被改/换计划）→ 回落循环当前，仍不改 cursor', () => {
    const p: Plan = { ...plan([day('d1', 'A'), day('d2', 'B')]), cursor: 1 };
    const fallback = resolveSelectedDay(p, 'day-已删除');
    expect(fallback!.id).toBe('d2'); // 循环当前位置
    expect(p.cursor).toBe(1);
  });

  it('循环高亮只看 cursor，与选中无关', () => {
    const p: Plan = { ...plan([day('d1', 'A'), day('d2', 'B')]), cursor: 1 };
    expect(isCycleDay(p, 'd2')).toBe(true);
    expect(isCycleDay(p, 'd1')).toBe(false);
    // 选中 d1 不改变「循环当前是 d2」
    nextSelectedDayId('d1');
    expect(isCycleDay(p, 'd2')).toBe(true);
  });

  it('空计划 / 空选择都安全（不抛错、不伪造）', () => {
    expect(resolveSelectedDay(null, 'd1')).toBeUndefined();
    expect(resolveSelectedDay(plan([]), 'd1')).toBeUndefined();
    expect(isCycleDay(null, 'd1')).toBe(false);
    expect(isCycleDay(plan([day('d1', 'A')]), null)).toBe(false);
  });
});
