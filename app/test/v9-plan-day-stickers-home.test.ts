/* G4 回归（Home 侧接线）：贴纸选择不推进循环、同名不同 ID 命中具体 day。
   ── 证据边界 ────────────────────────────────────────────────
   结构断言 + 纯函数验证，**不运行 React DOM**。
   真实点击/窄屏布局由独立 CUA 链验证。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dayStickerKey,
  planDayStickers,
  resolveSelectedDay,
} from '../src/ui/StickerPicker';
import type { Plan, PlanDay } from '../src/domain/types';

const HOME = resolve(process.cwd(), 'src/pages/Home.tsx');
const SRC = readFileSync(HOME, 'utf8');

/** 共享 fixture：d1/d2 同名不同 id，用于验证"不按名字串选" */
const PLAN: Plan = {
  id: 'P',
  name: 'x',
  cursor: 0,
  createdAt: 1,
  updatedAt: 1,
  days: [
    { id: 'd1', name: '推日', kind: 'train', warmups: [], exercises: [] },
    { id: 'd2', name: '推日', kind: 'train', warmups: [], exercises: [] },
  ],
} as Plan;

describe('G4 · Home 选择只改本地 state，不推进循环', () => {
  it('onSelect 只调用 setSelectedDayId', () => {
    const idx = SRC.indexOf('onSelect={');
    expect(idx).toBeGreaterThan(-1);
    const seg = SRC.slice(idx, idx + 160);
    expect(seg).toContain('setSelectedDayId');
    // 绝不能在选择时写库/改 cursor
    expect(seg).not.toContain('upsertPlan');
    expect(seg).not.toContain('cursor:');
    // 选中值只回传 day.id（nextSelectedDayId 是恒等透传，不推进循环）
    expect(SRC).toContain('nextSelectedDayId(item.dayId)');
  });

  it('选中日解析只按 day.id，不按 name/focus/round', () => {
    // 选中解析已抽成纯函数 resolveSelectedDay（Home 调用它）
    expect(SRC).toContain('resolveSelectedDay(plan, selectedDayId)');
    /**
     * 解析逻辑只按 id 匹配。
     * 用**纯函数行为断言**而不是源码字符串窗口 —— 后者对注释长度/格式化极脆弱。
     */
    const picked = resolveSelectedDay(PLAN, 'd2');
    expect(picked?.id).toBe('d2');
    // 名字相同但 id 不同 → 不会按名字串选
    expect(resolveSelectedDay(PLAN, 'd1')?.id).toBe('d1');
    // 不存在的 id → 回落循环当前，不按名字猜
    expect(resolveSelectedDay(PLAN, 'nope')?.id).toBe('d1');
  });

  it('不再有旧的 focus 筛选逻辑', () => {
    expect(SRC).not.toContain('focusDays');
    expect(SRC).not.toContain('setFocus');
    expect(SRC).not.toContain("d.kind === 'train' && d.focus === focus");
  });

  it('贴纸列表来自 planDayStickers（plan.days 原样）', () => {
    expect(SRC).toContain('planDayStickers(plan)');
  });
});

describe('G4 · 同名不同 ID 命中具体 day', () => {
  function day(id: string, name: string): PlanDay {
    return { id, name, kind: 'train', warmups: [], exercises: [] } as PlanDay;
  }
  function plan(days: PlanDay[]): Plan {
    return { id: 'P', name: 'x', days, cursor: 0, createdAt: 1, updatedAt: 1 } as Plan;
  }

  it('两张同名贴纸的 dayId 不同，可分别定位', () => {
    const s = planDayStickers(plan([day('d1', '推日'), day('d2', '推日')]));
    expect(s[0].name).toBe(s[1].name);
    expect(s[0].dayId).not.toBe(s[1].dayId);
    // 选中 d2 时能唯一命中
    const picked = s.find((x) => x.dayId === 'd2');
    expect(picked).toBeDefined();
    expect(picked!.key).toBe(dayStickerKey('P', 'd2'));
  });

  it('选中项失效时回落到循环当前（不报错）', () => {
    // 行为断言：失效 id 回落到 cursor 指向的那天
    expect(resolveSelectedDay(PLAN, 'gone')?.id).toBe('d1');
    // cursor 前移后回落目标随之变化
    const moved = { ...PLAN, cursor: 1 };
    expect(resolveSelectedDay(moved, 'gone')?.id).toBe('d2');
    // 空计划不报错
    expect(resolveSelectedDay(null, 'x')).toBeUndefined();
    expect(resolveSelectedDay({ days: [], cursor: 0 }, 'x')).toBeUndefined();
  });
});
