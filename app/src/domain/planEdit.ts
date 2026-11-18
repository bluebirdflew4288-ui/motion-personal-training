/* 计划编辑的纯函数集合。
   约束：这些改动只影响计划本身，永远不回写历史训练实例。 */

import type { ExerciseTemplate, Plan, PlanDay, PlanExercise, ExerciseTarget } from './types';
import { newId } from './session';
import { MAX_DAYS, MAX_EXERCISES, MAX_PLAN_NAME, MAX_STAGES_ACCEPTED } from './limits';
import { ensureStageIds, validateExerciseTarget } from './exerciseConfig';
import { resolveExerciseId } from './identity';

/** 计划名称是否在备份/恢复可接受的范围内（与 validate.ts 的 200 上限一致） */
export function isPlanNameWithinLimit(name: string): boolean {
  return name.length <= MAX_PLAN_NAME;
}

/** 规范化的计划名称；trim 后为空时保留原名。超限**不截断**，由调用方明确拒绝。 */
export function normalizePlanName(plan: Plan, name: string): string {
  return name.trim() || plan.name;
}

/**
 * 重命名计划。
 *
 * <p>超限时**明确拒绝**（返回原计划，数据不变），绝不静默截断把用户输入改短。
 * 调用方应先用 {@link normalizePlanName} 取规范化结果并提示长度问题，
 * 避免把「被拒绝」误报成「已保存」。
 */
export function renamePlan(plan: Plan, name: string): Plan {
  const next = normalizePlanName(plan, name);
  if (!isPlanNameWithinLimit(next)) return plan;
  return { ...plan, name: next };
}

/**
 * 复制计划。
 *
 * <p>为后缀**预留长度**：基名按 `MAX_PLAN_NAME - 后缀长度` 截断，
 * 保证复制结果始终 ≤ 200 字、可被自身备份恢复；
 * 只截断**复制出来的新计划**，绝不改动源计划或历史字节。
 */
export function clonePlan(plan: Plan, nameSuffix = '副本'): Plan {
  const now = Date.now();
  const suffix = ` ${nameSuffix}`;
  const room = Math.max(0, MAX_PLAN_NAME - suffix.length);
  const base = plan.name.slice(0, room);
  const copiedName = `${base}${suffix}`.slice(0, MAX_PLAN_NAME);
  return {
    ...structuredClone(plan),
    id: newId('plan'),
    name: copiedName,
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
          const { setupNote: _setupNote, ...rest } = ex;
          return { ...rest, name: trimmed, exerciseId: undefined };
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

/* ── Wave 2A：统一动作编辑器、记忆模板、长按排序与左滑撤销支持 ── */

/**
 * 由动作配置记忆模板生成全新计划动作（深复制纯配置，不含任何运行态字段）。
 */
export function planExerciseFromTemplate(tpl: ExerciseTemplate): PlanExercise {
  const target = ensureStageIds(structuredClone(tpl.target) as ExerciseTarget);
  return {
    id: newId('ex'),
    exerciseId: tpl.exerciseId,
    name: tpl.name,
    ...(tpl.en !== undefined ? { en: tpl.en } : {}),
    restSec: tpl.restSec,
    ...(tpl.setupNote ? { setupNote: tpl.setupNote } : {}),
    target,
  };
}

/**
 * 向训练日追加已构造好的计划动作（带幂等防重与容量上限校验）。
 */
export function addPlanExerciseEntry(
  plan: Plan,
  dayId: string,
  exercise: PlanExercise,
): { plan: Plan; added: boolean; reason?: 'capacity' | 'not-found'; exercise?: PlanExercise } {
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return { plan, added: false, reason: 'not-found' };
  if (day.exercises.some((e) => e.id === exercise.id)) {
    return { plan, added: true, exercise };
  }
  if (day.exercises.length >= MAX_EXERCISES) {
    return { plan, added: false, reason: 'capacity' };
  }
  const cloned = structuredClone(exercise) as PlanExercise;
  cloned.target = ensureStageIds(cloned.target);
  return {
    plan: {
      ...plan,
      days: plan.days.map((d) =>
        d.id === dayId ? { ...d, exercises: [...d.exercises, cloned] } : d,
      ),
    },
    added: true,
    exercise: cloned,
  };
}

/**
 * 将统一编辑器（ExerciseEditor）提交结果应用到计划中的指定动作。
 * 保留既有 PlanExercise.id、note、substitutes；若替换了动作身份则同步更新 exerciseId。
 */
export function applyEditorToPlanExercise(
  plan: Plan,
  dayId: string,
  exId: string,
  payload: {
    name: string;
    en?: string;
    exerciseId: string;
    target: ExerciseTarget;
    restSec: number;
  },
): { ok: true; plan: Plan; identityChanged: boolean } | { ok: false; message: string } {
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return { ok: false, message: '找不到这个训练日' };
  const source = day.exercises.find((e) => e.id === exId);
  if (!source) return { ok: false, message: '这个动作已经不在该训练日里了' };
  const trimmedName = payload.name.trim();
  if (!trimmedName) return { ok: false, message: '动作名称不能为空' };
  const issues = validateExerciseTarget(payload.target, {
    minStages: 1,
    maxStages: MAX_STAGES_ACCEPTED,
  });
  if (issues.length) {
    return { ok: false, message: issues[0].message };
  }
  const prevIdentity = resolveExerciseId(source);
  const identityChanged = prevIdentity !== payload.exerciseId;
  const nextTarget = ensureStageIds(structuredClone(payload.target) as ExerciseTarget);
  const nextExercise: PlanExercise = {
    ...source,
    name: trimmedName,
    exerciseId: payload.exerciseId,
    restSec: payload.restSec,
    target: nextTarget,
  };
  if (identityChanged) delete nextExercise.setupNote;
  if (payload.en !== undefined) {
    nextExercise.en = payload.en;
  } else {
    delete nextExercise.en;
  }
  return {
    ok: true,
    identityChanged,
    plan: {
      ...plan,
      days: plan.days.map((d) =>
        d.id !== dayId
          ? d
          : { ...d, exercises: d.exercises.map((e) => (e.id === exId ? nextExercise : e)) },
      ),
    },
  };
}

/**
 * 计划日正式动作列表长按拖拽重排（严格全排列校验，绝不借此增删动作）。
 */
export function reorderPlanExercises(
  plan: Plan,
  dayId: string,
  orderedIds: readonly string[],
): { ok: true; plan: Plan; changed: boolean } | { ok: false; message: string } {
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return { ok: false, message: '找不到这个训练日' };
  const before = day.exercises.map((e) => e.id);
  if (orderedIds.length !== before.length) {
    return { ok: false, message: '顺序数量与当前训练日不一致，请刷新后重试' };
  }
  const beforeSet = new Set(before);
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!beforeSet.has(id)) return { ok: false, message: '要排序的动作已不在当前训练日里' };
    if (seen.has(id)) return { ok: false, message: '排序结果里有重复动作' };
    seen.add(id);
  }
  if (orderedIds.every((id, i) => id === before[i])) {
    return { ok: true, plan, changed: false };
  }
  const byId = new Map(day.exercises.map((e) => [e.id, e]));
  const exercises = orderedIds.map((id) => byId.get(id)!);
  return {
    ok: true,
    changed: true,
    plan: {
      ...plan,
      days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises } : d)),
    },
  };
}

function resolveRestoreIndex(
  currentIds: string[],
  orderRef: readonly string[],
  itemId: string,
  fallbackIndex: number,
): number {
  const clamped = Math.max(0, Math.min(fallbackIndex, currentIds.length));
  const pos = orderRef.indexOf(itemId);
  if (pos < 0) return clamped;
  for (let i = pos + 1; i < orderRef.length; i += 1) {
    const at = currentIds.indexOf(orderRef[i]);
    if (at >= 0) return at;
  }
  for (let i = pos - 1; i >= 0; i -= 1) {
    const at = currentIds.indexOf(orderRef[i]);
    if (at >= 0) return at + 1;
  }
  return clamped;
}

/**
 * 撤销删除计划动作：按原相对顺序插回最新训练日列表，不覆盖期间其它合法修改。
 */
export function restoreDeletedPlanExercise(
  plan: Plan,
  dayId: string,
  deleted: PlanExercise,
  orderBefore: readonly string[],
  fallbackIndex = 0,
): { ok: true; plan: Plan } | { ok: false; message: string } {
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) return { ok: false, message: '找不到这个训练日' };
  if (day.exercises.some((e) => e.id === deleted.id)) {
    return { ok: true, plan };
  }
  if (day.exercises.length >= MAX_EXERCISES) {
    return { ok: false, message: `动作数已达上限 ${MAX_EXERCISES}，无法撤销恢复` };
  }
  const currentIds = day.exercises.map((e) => e.id);
  const insertAt = resolveRestoreIndex(currentIds, orderBefore, deleted.id, fallbackIndex);
  const exercises = [...day.exercises];
  exercises.splice(insertAt, 0, structuredClone(deleted) as PlanExercise);
  return {
    ok: true,
    plan: {
      ...plan,
      days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises } : d)),
    },
  };
}
