/* 循环游标操作。循环与日历完全解耦：
   只有用户明确动作（结束训练时勾选推进 / 主动推进 / 跳过 / 确认休息日）才改变游标。 */

import type { Plan } from './types';

export function pushCycle(plan: Plan, steps = 1): Plan {
  const n = plan.days.length;
  if (!n) return plan;
  return { ...plan, cursor: (((plan.cursor + steps) % n) + n) % n };
}

export function skipCycle(plan: Plan): Plan {
  return pushCycle(plan, 1);
}

export function setCycleTo(plan: Plan, index: number): Plan {
  if (index < 0 || index >= plan.days.length) return plan;
  return { ...plan, cursor: index };
}

/** 训练结束时的循环处理 */
export type CycleAction = 'advance' | 'stay';

export function applyCycleAction(plan: Plan, action: CycleAction): Plan {
  return action === 'advance' ? pushCycle(plan) : plan;
}

export function describeCycle(plan: Plan): { position: string; current: string; next: string } {
  const n = plan.days.length;
  const cur = plan.days[plan.cursor];
  const nxt = plan.days[(plan.cursor + 1) % n];
  return {
    position: `${plan.cursor + 1} / ${n}`,
    current: cur ? cur.name : '—',
    next: nxt ? nxt.name : '—',
  };
}
