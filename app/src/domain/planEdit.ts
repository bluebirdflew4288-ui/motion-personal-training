/* 计划编辑的纯函数集合。
   约束：这些改动只影响计划本身，永远不回写历史训练实例。 */

import type { Plan, PlanDay, PlanExercise, ExerciseTarget } from './types';
import { newId } from './session';
import { MAX_DAYS, MAX_EXERCISES } from './limits';

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

/**
 * 新增训练日。
 *
 * <p><b>G4 模型边界（已裁决）</b>：新建/空白日**不得隐式补 chest/A**。
 * 旧实现默认 `focus='chest'` 且固定 `round='A'`，于是"任意分化"被静默改写成
 * 胸/A，与"新自定义力量日允许省略 focus/round"直接冲突。
 *
 * <p>调用方**显式**传入 focus/round 时仍照写（旧明确值保真）；
 * 不传就不写该字段，绝不猜。
 */
export function addDay(
  plan: Plan,
  focus?: PlanDay['focus'],
  round?: PlanDay['round'],
): Plan {
  // 容量上限：超出后返回原计划（备份校验也只接受这个范围，见 limits.ts）
  if (plan.days.length >= MAX_DAYS) return plan;
  const day: PlanDay = {
    id: newId('day'),
    name: '新训练日',
    // 只在显式提供时写入；缺省保持"没有该字段"
    ...(focus !== undefined ? { focus } : {}),
    ...(round !== undefined ? { round } : {}),
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

/**
 * 添加动作。
 * · `target` 可选：新增普通动作/递减组时把用户在配置面板里填的**真实值**写进去，
 *   不再固定 3×8–12（V3-04）。
 * · 到达容量上限时**不添加**（返回原计划），由调用方给出明确提示 ——
 *   绝不"添加成功但实际丢失"，也绝不超出备份可恢复的范围（V3-02）。
 */
export function addExercise(
  plan: Plan,
  dayId: string,
  name: string,
  target?: ExerciseTarget,
): { plan: Plan; added: boolean; reason?: 'capacity' | 'not-found' } {
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return { plan, added: false, reason: 'not-found' };
  if (day.exercises.length >= MAX_EXERCISES) return { plan, added: false, reason: 'capacity' };
  const ex: PlanExercise = {
    id: newId('ex'),
    name: name.trim() || '新动作',
    restSec: 120,
    target: target ?? {
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
    plan: {
      ...plan,
      days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises: [...d.exercises, ex] } : d)),
    },
    added: true,
  };
}

/** 剩余可添加的动作数（UI 用来提前禁用按钮并解释原因） */
export function remainingExerciseSlots(day: PlanDay): number {
  return Math.max(0, MAX_EXERCISES - day.exercises.length);
}

/** 是否还能再加训练日 */
export function canAddDay(plan: Plan): boolean {
  return plan.days.length < MAX_DAYS;
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

/**
 * 改动作名 + 明确定是否同时改身份（V3-05）。
 *
 * 背景：只改输入框时旧实现保留 exerciseId，于是把「双杠臂屈伸」改成「器械推胸」
 * 仍共用前者的历史；反过来如果每敲一个字就重生 ID，又会让同一次编辑拆成多个身份。
 *
 * 规则（由 UI 明确选择意图，不由代码猜）：
 * · renameExercise(..., { keepIdentity: true })  → 显示名修正：保留 exerciseId，历史仍合并
 * · renameExercise(..., { keepIdentity: false }) → 真正换动作：按新名重新解析 exerciseId
 *   历史不会被回写（历史是快照），但之后的新记录归到新身份。
 */
export function renameExercise(
  plan: Plan,
  dayId: string,
  exId: string,
  name: string,
  opts: { keepIdentity: boolean },
): Plan {
  const trimmed = name.trim();
  if (!trimmed) return plan;
  return {
    ...plan,
    days: plan.days.map((d) => {
      if (d.id !== dayId) return d;
      return {
        ...d,
        exercises: d.exercises.map((ex) => {
          if (ex.id !== exId) return ex;
          if (opts.keepIdentity) return { ...ex, name: trimmed };
          // 真正换动作：清掉旧 exerciseId，让读取侧按新名重新解析
          return { ...ex, name: trimmed, exerciseId: undefined };
        }),
      };
    }),
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
