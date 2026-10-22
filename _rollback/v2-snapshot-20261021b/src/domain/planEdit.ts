/* 计划编辑的纯函数集合。
   约束：这些改动只影响计划本身，永远不回写历史训练实例。 */

import type { Plan, PlanDay, PlanExercise, ExerciseTarget } from './types';
import { newId } from './session';

export function renamePlan(plan: Plan, name: string): Plan {
  return { ...plan, name: name.trim() || plan.name };
}

export function clonePlan(plan: Plan, nameSuffix = '副本'): Plan {
  const now = Date.now();
  return {
    ...structuredClone(plan),
    id: newId('plan'),
    name: `${plan.name} ${nameSuffix}`,
    cursor: 0,
    createdAt: now,
    updatedAt: now,
    presetId: undefined,
    days: plan.days.map((d) => ({ ...structuredClone(d), id: newId('day') })),
  };
}

export function renameDay(plan: Plan, dayId: string, name: string): Plan {
  return {
    ...plan,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, name: name.trim() || d.name } : d)),
  };
}

export function moveDay(plan: Plan, dayId: string, dir: -1 | 1): Plan {
  const idx = plan.days.findIndex((d) => d.id === dayId);
  const target = idx + dir;
  if (idx < 0 || target < 0 || target >= plan.days.length) return plan;
  const days = [...plan.days];
  const a = days[idx];
  days[idx] = days[target];
  days[target] = a;
  const cursor = plan.cursor;
  return { ...plan, days, cursor: Math.min(cursor, days.length - 1) };
}

export function deleteDay(plan: Plan, dayId: string): Plan {
  if (plan.days.length <= 1) return plan;
  const days = plan.days.filter((d) => d.id !== dayId);
  return { ...plan, days, cursor: Math.min(plan.cursor, days.length - 1) };
}

export function addDay(plan: Plan, focus: PlanDay['focus'] = 'chest'): Plan {
  const day: PlanDay = {
    id: newId('day'),
    name: '新训练日',
    focus,
    round: 'A',
    kind: 'train',
    warmups: [],
    exercises: [],
  };
  return { ...plan, days: [...plan.days, day] };
}

export function setDayKind(plan: Plan, dayId: string, kind: PlanDay['kind']): Plan {
  return {
    ...plan,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, kind, restNote: kind === 'rest' ? (d.restNote ?? '休息') : d.restNote } : d)),
  };
}

export function addExercise(plan: Plan, dayId: string, name: string): Plan {
  const ex: PlanExercise = {
    id: newId('ex'),
    name: name.trim() || '新动作',
    restSec: 120,
    target: {
      kind: 'straight',
      sets: 3,
      setsMax: 3,
      repsMin: 8,
      repsMax: 12,
      weightMode: 'external',
      suggestedWeightKg: null,
    },
  };
  return {
    ...plan,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises: [...d.exercises, ex] } : d)),
  };
}

export function updateExercise(plan: Plan, dayId: string, exId: string, patch: Partial<PlanExercise>): Plan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.id !== dayId
        ? d
        : { ...d, exercises: d.exercises.map((ex) => (ex.id === exId ? { ...ex, ...patch } : ex)) },
    ),
  };
}

export function updateTarget(plan: Plan, dayId: string, exId: string, patch: Partial<ExerciseTarget>): Plan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.id !== dayId
        ? d
        : {
            ...d,
            exercises: d.exercises.map((ex) =>
              ex.id === exId ? { ...ex, target: { ...ex.target, ...patch } as ExerciseTarget } : ex,
            ),
          },
    ),
  };
}

export function removeExercise(plan: Plan, dayId: string, exId: string): Plan {
  return {
    ...plan,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises: d.exercises.filter((e) => e.id !== exId) } : d)),
  };
}

export function moveExerciseInPlan(plan: Plan, dayId: string, exId: string, dir: -1 | 1): Plan {
  return {
    ...plan,
    days: plan.days.map((d) => {
      if (d.id !== dayId) return d;
      const idx = d.exercises.findIndex((e) => e.id === exId);
      const target = idx + dir;
      if (idx < 0 || target < 0 || target >= d.exercises.length) return d;
      const list = [...d.exercises];
      const a = list[idx];
      list[idx] = list[target];
      list[target] = a;
      return { ...d, exercises: list };
    }),
  };
}

export function addWarmup(plan: Plan, dayId: string, name: string): Plan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.id !== dayId
        ? d
        : {
            ...d,
            warmups: [
              ...d.warmups,
              { id: newId('w'), name: name.trim() || '新热身', unit: 'reps', targetText: '2 × 10' },
            ],
          },
    ),
  };
}

export function removeWarmup(plan: Plan, dayId: string, warmupId: string): Plan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.id === dayId ? { ...d, warmups: d.warmups.filter((w) => w.id !== warmupId) } : d,
    ),
  };
}

export function updateWarmup(plan: Plan, dayId: string, warmupId: string, text: string): Plan {
  return {
    ...plan,
    days: plan.days.map((d) =>
      d.id !== dayId ? d : { ...d, warmups: d.warmups.map((w) => (w.id === warmupId ? { ...w, targetText: text } : w)) },
    ),
  };
}

/** 把本次训练里的临时调整回写进计划（用户主动操作） */
export function applySessionChangesToDay(
  plan: Plan,
  dayId: string,
  exercises: PlanExercise[],
): Plan {
  return {
    ...plan,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises } : d)),
  };
}
