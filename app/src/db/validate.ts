/* 备份文件的完整运行时结构校验（审计 R1-03）。
   原则：
   · 只做数据校验，不执行文件里的任何内容。
   · 逐层检查必需字段、对象类型、枚举、数值范围、有限性、引用完整性。
   · 任何一处不合法 → 整份拒绝，**不写入任何正式数据**。
   · 返回结构化错误路径，便于在预览界面指出哪里坏了。 */

import type {
  DropSetTarget,
  ExerciseTarget,
  Plan,
  PlanDay,
  PlanExercise,
  Session,
  SessionExercise,
  SessionSet,
  SessionWarmup,
  GroupPlan,
  StraightTarget,
  WarmupTarget,
} from '../domain/types';
/* V3-02：容量上限的唯一真源是 domain/limits.ts。
   这里不再保留任何本地上限字面量，保证「编辑器能生成的合法数据」与「备份能接受的合法数据」
   是同一组数字（此前计划 60 / 训练 slice 60 不一致，导致 61 个动作导入后静默只剩 60）。 */
import {
  MAX_DAYS,
  MAX_EXERCISES,
  MAX_LOGGED_REPS,
  MAX_PLANS,
  MAX_REPS,
  MAX_REST,
  MAX_ROUNDS,
  MAX_SESSIONS,
  MAX_SET_ROWS,
  MAX_STAGES_ACCEPTED,
  MAX_STRAIGHT_SETS,
  MAX_TEXT,
  MAX_WEIGHT,
} from '../domain/limits';

export interface ValidationIssue {
  path: string;
  message: string;
}

export type DeepValidation<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; issues: ValidationIssue[] };

/** 返回最多 n 条问题（用于错误面板）。用显式循环而不是 slice，避免与「裁剪数据」混淆。 */
function firstIssues(list: ValidationIssue[], n: number): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (let i = 0; i < list.length && i < n; i++) out.push(list[i]);
  return out;
}

class Ctx {
  issues: ValidationIssue[] = [];
  add(path: string, message: string) {
    this.issues.push({ path, message });
    return false;
  }
  get failed() {
    return this.issues.length > 0;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(c: Ctx, v: unknown, path: string, { max = MAX_TEXT, optional = false } = {}): string {
  if (v === undefined || v === null) {
    if (!optional) c.add(path, '缺少必填文本');
    return '';
  }
  if (typeof v !== 'string') {
    c.add(path, `应为字符串，实际是 ${typeof v}`);
    return '';
  }
  if (v.length > max) c.add(path, `文本超过 ${max} 字符`);
  return v;
}

function num(
  c: Ctx,
  v: unknown,
  path: string,
  { min = -Infinity, max = Infinity, integer = false, nullable = false } = {},
): number | null {
  if (v === null || v === undefined) {
    if (!nullable) c.add(path, '缺少数值');
    return null;
  }
  if (typeof v !== 'number') {
    c.add(path, `应为数字，实际是 ${typeof v}`);
    return null;
  }
  if (!Number.isFinite(v)) {
    c.add(path, `数值不是有限数字（${String(v)}）`);
    return null;
  }
  if (integer && !Number.isInteger(v)) c.add(path, `应为整数，实际是 ${v}`);
  if (v < min) c.add(path, `数值 ${v} 小于下限 ${min}`);
  if (v > max) c.add(path, `数值 ${v} 大于上限 ${max}`);
  return v;
}

function timestamp(c: Ctx, v: unknown, path: string, { nullable = false } = {}): number | null {
  if (v === null || v === undefined) {
    if (!nullable) c.add(path, '缺少时间戳');
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.add(path, '时间戳必须是有限数字');
    return null;
  }
  // 2000-01-01 ~ 2100-01-01
  if (v < 946684800000 || v > 4102444800000) c.add(path, `时间戳 ${v} 不在合理区间`);
  return v;
}

function oneOf<T extends string>(c: Ctx, v: unknown, path: string, allowed: readonly T[]): T | null {
  if (typeof v !== 'string') {
    c.add(path, '应为字符串枚举值');
    return null;
  }
  if (!(allowed as readonly string[]).includes(v)) {
    c.add(path, `取值 "${v}" 不在允许范围（${allowed.join(' / ')}）`);
    return null;
  }
  return v as T;
}

/* ── 动作目标 ───────────────────────────── */

function validateTarget(c: Ctx, v: unknown, path: string): ExerciseTarget | null {
  if (!isObj(v)) {
    c.add(path, '缺少动作目标（target）');
    return null;
  }
  const kind = oneOf(c, v.kind, `${path}.kind`, ['straight', 'dropSet'] as const);
  if (!kind) return null;

  if (kind === 'straight') {
    const t: StraightTarget = {
      kind: 'straight',
      sets: num(c, v.sets, `${path}.sets`, { min: 0, max: MAX_STRAIGHT_SETS, integer: true }) ?? 0,
      setsMax: num(c, v.setsMax, `${path}.setsMax`, { min: 0, max: MAX_STRAIGHT_SETS, integer: true }) ?? 0,
      repsMin: num(c, v.repsMin, `${path}.repsMin`, { min: 0, max: MAX_REPS, integer: true }) ?? 0,
      repsMax: num(c, v.repsMax, `${path}.repsMax`, { min: 0, max: MAX_REPS, integer: true }) ?? 0,
      weightMode:
        oneOf(c, v.weightMode, `${path}.weightMode`, [
          'external',
          'bodyweight',
          'bodyweight_plus',
          'assisted',
        ] as const) ?? 'external',
      suggestedWeightKg: num(c, v.suggestedWeightKg, `${path}.suggestedWeightKg`, {
        min: 0,
        max: MAX_WEIGHT,
        nullable: true,
      }),
    };
    if (t.setsMax < t.sets) c.add(`${path}.setsMax`, `组数上限 ${t.setsMax} 小于下限 ${t.sets}`);
    if (t.repsMax < t.repsMin) c.add(`${path}.repsMax`, `次数上限 ${t.repsMax} 小于下限 ${t.repsMin}`);
    if (v.dumbbellBasis !== undefined) {
      oneOf(c, v.dumbbellBasis, `${path}.dumbbellBasis`, ['per_hand', 'total'] as const);
      t.dumbbellBasis = v.dumbbellBasis as StraightTarget['dumbbellBasis'];
    }
    return t;
  }

  // dropSet
  if (!Array.isArray(v.stages) || v.stages.length === 0) {
    c.add(`${path}.stages`, '递减组必须有至少一个阶段');
    return null;
  }
  if (v.stages.length > MAX_STAGES_ACCEPTED) {
    c.add(`${path}.stages`, `递减组阶段数 ${v.stages.length} 超过上限 ${MAX_STAGES_ACCEPTED}`);
  }
  const stages = v.stages.map((st, i) => {
    const sp = `${path}.stages[${i}]`;
    if (!isObj(st)) {
      c.add(sp, '阶段必须是对象');
      return {
        label: '',
        weightKg: null,
        repsMin: null,
        repsMax: null,
        toFailure: false,
        targetText: '',
      };
    }
    return {
      label: str(c, st.label, `${sp}.label`, { max: 100 }),
      weightKg: num(c, st.weightKg, `${sp}.weightKg`, { min: 0, max: MAX_WEIGHT, nullable: true }),
      repsMin: num(c, st.repsMin, `${sp}.repsMin`, { min: 0, max: MAX_REPS, integer: true, nullable: true }),
      repsMax: num(c, st.repsMax, `${sp}.repsMax`, { min: 0, max: MAX_REPS, integer: true, nullable: true }),
      toFailure: typeof st.toFailure === 'boolean' ? st.toFailure : false,
      targetText: str(c, st.targetText, `${sp}.targetText`, { max: 200 }),
    };
  });
  // 非力竭阶段的次数下限必须 ≤ 上限（R10：20–10 这类反向范围要拒绝）
  stages.forEach((st, i) => {
    if (st.toFailure) return;
    if (st.repsMin !== null && st.repsMax !== null && st.repsMin > st.repsMax) {
      c.add(`${path}.stages[${i}]`, `次数下限 ${st.repsMin} 大于上限 ${st.repsMax}`);
    }
  });

  const t: DropSetTarget = {
    kind: 'dropSet',
    rounds: num(c, v.rounds, `${path}.rounds`, { min: 1, max: MAX_ROUNDS, integer: true }) ?? 1,
    stages,
    restInSec: num(c, v.restInSec, `${path}.restInSec`, { min: 0, max: MAX_REST, integer: true }) ?? 30,
    restAfterSec:
      num(c, v.restAfterSec, `${path}.restAfterSec`, { min: 0, max: MAX_REST, integer: true }) ?? 120,
    weightMode:
      oneOf(c, v.weightMode, `${path}.weightMode`, [
        'external',
        'bodyweight',
        'bodyweight_plus',
        'assisted',
      ] as const) ?? 'external',
  };
  if (v.dumbbellBasis !== undefined) {
    oneOf(c, v.dumbbellBasis, `${path}.dumbbellBasis`, ['per_hand', 'total'] as const);
    t.dumbbellBasis = v.dumbbellBasis as DropSetTarget['dumbbellBasis'];
  }
  return t;
}

function validateWarmup(c: Ctx, v: unknown, path: string): WarmupTarget | null {
  if (!isObj(v)) {
    c.add(path, '热身项必须是对象');
    return null;
  }
  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    name: str(c, v.name, `${path}.name`, { max: 200 }),
    en: v.en === undefined ? undefined : str(c, v.en, `${path}.en`, { max: 200, optional: true }),
    unit: oneOf(c, v.unit, `${path}.unit`, ['reps', 'time', 'breath'] as const) ?? 'reps',
    targetText: str(c, v.targetText, `${path}.targetText`, { max: 200 }),
    optional: typeof v.optional === 'boolean' ? v.optional : undefined,
  };
}

/* ── 计划 ───────────────────────────────── */

function validatePlanExercise(c: Ctx, v: unknown, path: string): PlanExercise | null {
  if (!isObj(v)) {
    c.add(path, '动作必须是对象');
    return null;
  }
  const target = validateTarget(c, v.target, `${path}.target`);
  if (!target) return null; // target 缺失/损坏直接判失败
  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    exerciseId: v.exerciseId === undefined ? undefined : str(c, v.exerciseId, `${path}.exerciseId`, { max: 160 }),
    name: str(c, v.name, `${path}.name`, { max: 200 }),
    en: v.en === undefined ? undefined : str(c, v.en, `${path}.en`, { max: 200, optional: true }),
    restSec: num(c, v.restSec, `${path}.restSec`, { min: 0, max: MAX_REST, integer: true }) ?? 120,
    target,
    note: v.note === undefined ? undefined : str(c, v.note, `${path}.note`, { max: MAX_TEXT, optional: true }),
    substitutes: Array.isArray(v.substitutes)
      ? (v.substitutes.length > MAX_EXERCISES
          ? (c.add(`${path}.substitutes`, `替代动作数 ${v.substitutes.length} 超过上限 ${MAX_EXERCISES}`), [])
          : v.substitutes.map((x, i) => str(c, x, `${path}.substitutes[${i}]`, { max: 200 }))
        )
      : undefined,
  };
}

function validatePlanDay(c: Ctx, v: unknown, path: string): PlanDay | null {
  if (!isObj(v)) {
    c.add(path, '训练日必须是对象');
    return null;
  }
  const dayId = str(c, v.id, `${path}.id`, { max: 120 });
  let exercises: PlanExercise[] = [];
  if (!Array.isArray(v.exercises)) {
    c.add(`${path}.exercises`, '缺少动作数组');
  } else if (v.exercises.length > MAX_EXERCISES) {
    c.add(`${path}.exercises`, `动作数 ${v.exercises.length} 超过上限 ${MAX_EXERCISES}`);
  } else {
    exercises = v.exercises
      .map((ex, i) => validatePlanExercise(c, ex, `${path}.exercises[${i}]`))
      .filter((x): x is PlanExercise => x !== null);
    if (exercises.length !== v.exercises.length) c.add(`${path}.exercises`, '存在无法解析的动作');
  }
  // 计划热身同样要有上限：超限明确拒绝，绝不裁剪。
  let warmups: WarmupTarget[] = [];
  if (!Array.isArray(v.warmups)) {
    c.add(`${path}.warmups`, '缺少热身数组');
  } else if (v.warmups.length > MAX_EXERCISES) {
    c.add(`${path}.warmups`, `热身项数 ${v.warmups.length} 超过上限 ${MAX_EXERCISES}`);
  } else {
    warmups = v.warmups
      .map((w, i) => validateWarmup(c, w, `${path}.warmups[${i}]`))
      .filter((x): x is WarmupTarget => x !== null);
    if (warmups.length !== v.warmups.length) c.add(`${path}.warmups`, '存在无法解析的热身项');
  }

  return {
    id: dayId,
    name: str(c, v.name, `${path}.name`, { max: 100 }),
    focus: oneOf(c, v.focus, `${path}.focus`, ['chest', 'back', 'legs'] as const) ?? 'chest',
    round: oneOf(c, v.round, `${path}.round`, ['A', 'B'] as const) ?? 'A',
    kind: oneOf(c, v.kind, `${path}.kind`, ['train', 'rest'] as const) ?? 'train',
    restNote: v.restNote === undefined ? undefined : str(c, v.restNote, `${path}.restNote`, { max: 400, optional: true }),
    warmups,
    exercises,
  };
}

function validatePlan(c: Ctx, v: unknown, path: string): Plan | null {
  if (!isObj(v)) {
    c.add(path, '计划必须是对象');
    return null;
  }
  if (!Array.isArray(v.days) || v.days.length === 0) {
    c.add(`${path}.days`, '计划必须至少有一个训练日');
    return null;
  }
  if (v.days.length > MAX_DAYS) c.add(`${path}.days`, `训练日数量超过上限 ${MAX_DAYS}`);
  const days = v.days
    .map((d, i) => validatePlanDay(c, d, `${path}.days[${i}]`))
    .filter((x): x is PlanDay => x !== null);
  if (days.length !== v.days.length) c.add(`${path}.days`, '存在无法解析的训练日');

  const cursor = num(c, v.cursor, `${path}.cursor`, { min: 0, max: MAX_DAYS, integer: true }) ?? 0;
  if (cursor >= days.length) c.add(`${path}.cursor`, `循环位置 ${cursor} 超出训练日数量 ${days.length}`);

  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    name: str(c, v.name, `${path}.name`, { max: 200 }),
    days,
    cursor: Math.min(cursor, Math.max(0, days.length - 1)),
    createdAt: timestamp(c, v.createdAt, `${path}.createdAt`) ?? Date.now(),
    updatedAt: timestamp(c, v.updatedAt, `${path}.updatedAt`) ?? Date.now(),
    presetId: v.presetId === undefined ? undefined : str(c, v.presetId, `${path}.presetId`, { max: 120, optional: true }),
  };
}

/* ── 训练实例 ───────────────────────────── */

function validateSet(c: Ctx, v: unknown, path: string): SessionSet | null {
  if (!isObj(v)) {
    c.add(path, '组记录必须是对象');
    return null;
  }
  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    // 上界用「单动作组行数」而不是旧的字面量 60：训练中可以临时加组，
    // 应用自己生成的合法数据必须能被自己恢复（否则会出现「存得下、导不回」）。
    roundIndex: num(c, v.roundIndex, `${path}.roundIndex`, { min: 1, max: MAX_SET_ROWS, integer: true }) ?? 1,
    stageIndex: num(c, v.stageIndex, `${path}.stageIndex`, { min: 1, max: 20, integer: true }) ?? 1,
    reps: num(c, v.reps, `${path}.reps`, { min: 0, max: MAX_LOGGED_REPS, integer: true, nullable: true }),
    weightKg: num(c, v.weightKg, `${path}.weightKg`, { min: 0, max: MAX_WEIGHT, nullable: true }),
    status: oneOf(c, v.status, `${path}.status`, ['blank', 'done', 'partial'] as const) ?? 'blank',
    toFailure: typeof v.toFailure === 'boolean' ? v.toFailure : undefined,
    note: v.note === undefined ? undefined : str(c, v.note, `${path}.note`, { max: 500, optional: true }),
  };
}

function validateSessionExercise(c: Ctx, v: unknown, path: string): SessionExercise | null {
  if (!isObj(v)) {
    c.add(path, '训练动作必须是对象');
    return null;
  }
  const target = validateTarget(c, v.target, `${path}.target`);
  if (!target) return null;

  // V3-02：超限一律「明确拒绝」，绝不裁剪、也绝不丢弃整个动作。
  // 旧实现是 `> MAX_SETS` 时直接 return null（等于静默丢掉这个动作的全部记录），
  // 现在只报错并继续解析，最终由 c.failed 让整份备份失败，问题路径仍可定位。
  let sets: SessionSet[] = [];
  if (!Array.isArray(v.sets)) {
    c.add(`${path}.sets`, '缺少组记录数组');
  } else {
    if (v.sets.length > MAX_SET_ROWS) {
      c.add(`${path}.sets`, `组记录行数 ${v.sets.length} 超过上限 ${MAX_SET_ROWS}`);
    }
    sets = v.sets
      .map((s, i) => validateSet(c, s, `${path}.sets[${i}]`))
      .filter((x): x is SessionSet => x !== null);
  }

  // 同一动作内 set ID 必须唯一（R05：重复键会让按 ID 更新同时改多行）
  const setIds = new Set<string>();
  for (const st of sets) {
    if (setIds.has(st.id)) c.add(`${path}.sets`, `组记录 ID 重复：${st.id}`);
    setIds.add(st.id);
  }
  if (Array.isArray(v.sets) && sets.length !== v.sets.length) {
    c.add(`${path}.sets`, '存在无法解析的组记录');
  }

  // 训练动作上的替代动作清单：同样不裁剪，超限明确拒绝。
  if (Array.isArray(v.substitutes) && v.substitutes.length > MAX_EXERCISES) {
    c.add(`${path}.substitutes`, `替代动作数 ${v.substitutes.length} 超过上限 ${MAX_EXERCISES}`);
  }

  // 组结构（新字段；旧数据缺失时由迁移补，不在此强制）
  // 注意：`groups: []` 是**合法**的（背 B 的可选零组动作），必须原样保留，不能当成缺失。
  let groups: GroupPlan[] = [];
  if (v.groups !== undefined) {
    if (!Array.isArray(v.groups)) {
      c.add(`${path}.groups`, '组结构必须是数组');
    } else if (v.groups.length > MAX_SET_ROWS) {
      c.add(`${path}.groups`, `组结构数量 ${v.groups.length} 超过上限 ${MAX_SET_ROWS}`);
    } else {
      const seen = new Set<number>();
      groups = v.groups.map((g, i) => {
        const gp = `${path}.groups[${i}]`;
        if (!isObj(g)) {
          c.add(gp, '组结构必须是对象');
          return { index: i + 1, stageCount: 1 };
        }
        const index = num(c, g.index, `${gp}.index`, { min: 1, max: MAX_SET_ROWS, integer: true }) ?? i + 1;
        if (seen.has(index)) c.add(`${gp}.index`, `组序号重复：${index}`);
        seen.add(index);
        return {
          index,
          stageCount:
            num(c, g.stageCount, `${gp}.stageCount`, { min: 1, max: MAX_STAGES_ACCEPTED, integer: true }) ?? 1,
          skipped: typeof g.skipped === 'boolean' ? g.skipped : undefined,
        };
      });
      // 每组必需阶段数必须与实际记录到的阶段数一致（不能声明 3 阶段却只有 1 行）
      for (const g of groups) {
        const stages = sets.filter((st) => st.roundIndex === g.index).length;
        if (stages > g.stageCount) {
          c.add(`${path}.groups[${g.index}]`, `组 ${g.index} 记录到 ${stages} 阶段，超过声明的 ${g.stageCount}`);
        }
      }
    }
  }

  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    exerciseId: str(c, v.exerciseId, `${path}.exerciseId`, { max: 160 }),
    planExerciseId: v.planExerciseId === null || v.planExerciseId === undefined
      ? null
      : str(c, v.planExerciseId, `${path}.planExerciseId`, { max: 120 }),
    name: str(c, v.name, `${path}.name`, { max: 200 }),
    en: v.en === undefined ? undefined : str(c, v.en, `${path}.en`, { max: 200, optional: true }),
    restSec: num(c, v.restSec, `${path}.restSec`, { min: 0, max: MAX_REST, integer: true }) ?? 120,
    target,
    status: oneOf(c, v.status, `${path}.status`, ['pending', 'done', 'skipped'] as const) ?? 'pending',
    groups,
    sets,
    note: v.note === undefined ? undefined : str(c, v.note, `${path}.note`, { max: MAX_TEXT, optional: true }),
    replacedFrom: v.replacedFrom === undefined ? undefined : str(c, v.replacedFrom, `${path}.replacedFrom`, { max: 200, optional: true }),
    added: typeof v.added === 'boolean' ? v.added : undefined,
  };
}

function validateSession(c: Ctx, v: unknown, path: string): Session | null {
  if (!isObj(v)) {
    c.add(path, '训练记录必须是对象');
    return null;
  }
  if (!isObj(v.day)) {
    c.add(`${path}.day`, '缺少训练日快照');
    return null;
  }
  const day = v.day;
  // V3-02：训练动作与计划动作走同一条规则 —— 超 MAX_EXERCISES 明确拒绝，绝不 slice。
  // （旧实现 `.slice(0, MAX_EXERCISES)` 让 61 个动作「导入成功」却只剩 60 个。）
  let exercises: SessionExercise[] = [];
  if (!Array.isArray(v.exercises)) {
    c.add(`${path}.exercises`, '缺少动作数组');
  } else {
    if (v.exercises.length > MAX_EXERCISES) {
      c.add(`${path}.exercises`, `动作数 ${v.exercises.length} 超过上限 ${MAX_EXERCISES}`);
    }
    exercises = v.exercises
      .map((ex, i) => validateSessionExercise(c, ex, `${path}.exercises[${i}]`))
      .filter((x): x is SessionExercise => x !== null);
    if (exercises.length !== v.exercises.length) c.add(`${path}.exercises`, '存在无法解析的动作');
  }

  // 热身上限：热身是「一个训练日里的事项」，与动作同量级，用 MAX_EXERCISES 作为上限。
  // 超限明确拒绝（旧实现完全没有上限）。
  let warmups: SessionWarmup[] = [];
  if (!Array.isArray(v.warmups)) {
    warmups = [];
  } else if (v.warmups.length > MAX_EXERCISES) {
    c.add(`${path}.warmups`, `热身项数 ${v.warmups.length} 超过上限 ${MAX_EXERCISES}`);
  } else {
    const items = v.warmups.map((w, i) => {
      const wp = `${path}.warmups[${i}]`;
      if (!isObj(w)) {
        c.add(wp, '热身记录必须是对象');
        return null;
      }
      return {
        id: str(c, w.id, `${wp}.id`, { max: 120 }),
        name: str(c, w.name, `${wp}.name`, { max: 200 }),
        unit: oneOf(c, w.unit, `${wp}.unit`, ['reps', 'time', 'breath'] as const) ?? 'reps',
        targetText: str(c, w.targetText, `${wp}.targetText`, { max: 200 }),
        done: typeof w.done === 'boolean' ? w.done : false,
      };
    });
    warmups = items.filter((x): x is SessionWarmup => x !== null);
    if (warmups.length !== v.warmups.length) c.add(`${path}.warmups`, '存在无法解析的热身记录');
  }

  const startedAt = timestamp(c, v.startedAt, `${path}.startedAt`);
  const endedAt = timestamp(c, v.endedAt, `${path}.endedAt`, { nullable: true });
  if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
    c.add(`${path}.endedAt`, '结束时间早于开始时间');
  }

  return {
    id: str(c, v.id, `${path}.id`, { max: 120 }),
    planId: str(c, v.planId, `${path}.planId`, { max: 120 }),
    planName: str(c, v.planName, `${path}.planName`, { max: 200 }),
    day: {
      dayId: str(c, day.dayId, `${path}.day.dayId`, { max: 120 }),
      dayName: str(c, day.dayName, `${path}.day.dayName`, { max: 100 }),
      focus: oneOf(c, day.focus, `${path}.day.focus`, ['chest', 'back', 'legs'] as const) ?? 'chest',
      round: oneOf(c, day.round, `${path}.day.round`, ['A', 'B'] as const) ?? 'A',
      partText: str(c, day.partText, `${path}.day.partText`, { max: 300 }),
    },
    cycleIndexAtStart:
      num(c, v.cycleIndexAtStart, `${path}.cycleIndexAtStart`, { min: 0, max: MAX_DAYS, integer: true }) ?? 0,
    targetSetsAtStart:
      v.targetSetsAtStart === undefined
        ? undefined
        : num(c, v.targetSetsAtStart, `${path}.targetSetsAtStart`, { min: 0, max: 5000, integer: true }) ?? undefined,
    startedAt: startedAt ?? Date.now(),
    endedAt,
    status: oneOf(c, v.status, `${path}.status`, ['active', 'completed', 'discarded'] as const) ?? 'completed',
    pausedMs: num(c, v.pausedMs, `${path}.pausedMs`, { min: 0, max: 86400000, integer: true }) ?? 0,
    pausedAt: v.pausedAt === null || v.pausedAt === undefined ? null : timestamp(c, v.pausedAt, `${path}.pausedAt`, { nullable: true }),
    warmups,
    exercises,
    note: v.note === undefined ? '' : str(c, v.note, `${path}.note`, { max: MAX_TEXT, optional: true }),
    advancedCycle: typeof v.advancedCycle === 'boolean' ? v.advancedCycle : undefined,
    cycleIndexAfter:
      v.cycleIndexAfter === undefined
        ? undefined
        : num(c, v.cycleIndexAfter, `${path}.cycleIndexAfter`, { min: 0, max: MAX_DAYS, integer: true }) ?? undefined,
    // V3-01/V3-02：revision 是记录的一部分，备份往返必须保真。
    // 旧数据没有该字段 → 交给 migrateSessions 补 0（这里保持 undefined，不编造）。
    revision:
      v.revision === undefined
        ? undefined
        : num(c, v.revision, `${path}.revision`, { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }) ??
          undefined,
  };
}

/* ── 入口 ───────────────────────────────── */

export interface ValidatedData {
  plans: Plan[];
  sessions: Session[];
  settings: unknown[];
}

export function validateDataDeep(data: unknown): DeepValidation<ValidatedData> {
  const c = new Ctx();
  if (!isObj(data)) {
    return { ok: false, issues: [{ path: 'data', message: '备份缺少 data 对象' }] };
  }
  if (!Array.isArray(data.plans)) c.add('data.plans', '缺少计划数组');
  if (!Array.isArray(data.sessions)) c.add('data.sessions', '缺少训练记录数组');
  if (c.failed) return { ok: false, issues: c.issues };

  const plansRaw = data.plans as unknown[];
  const sessionsRaw = data.sessions as unknown[];

  // R05：超限要明确拒绝，绝不静默裁剪
  if (plansRaw.length > MAX_PLANS) {
    c.add('data.plans', `计划数量 ${plansRaw.length} 超过上限 ${MAX_PLANS}`);
  }
  if (sessionsRaw.length > MAX_SESSIONS) {
    c.add('data.sessions', `训练记录数量 ${sessionsRaw.length} 超过上限 ${MAX_SESSIONS}`);
  }
  if (c.failed) return { ok: false, issues: firstIssues(c.issues, 40) };

  const plans = plansRaw
    .map((p, i) => validatePlan(c, p, `data.plans[${i}]`))
    .filter((x): x is Plan => x !== null);

  const sessions = sessionsRaw
    .map((s, i) => validateSession(c, s, `data.sessions[${i}]`))
    .filter((x): x is Session => x !== null);
  // 解析数量必须与输入一致，否则就是丢了数据
  if (plans.length !== plansRaw.length) c.add('data.plans', '存在无法解析的计划');
  if (sessions.length !== sessionsRaw.length) c.add('data.sessions', '存在无法解析的训练记录');

  if (c.failed) return { ok: false, issues: firstIssues(c.issues, 40) };

  // ID 唯一性
  const planIds = new Set<string>();
  for (const p of plans) {
    if (planIds.has(p.id)) c.add(`data.plans`, `计划 ID 重复：${p.id}`);
    planIds.add(p.id);
  }
  const sessionIds = new Set<string>();
  for (const s of sessions) {
    if (sessionIds.has(s.id)) c.add(`data.sessions`, `训练 ID 重复：${s.id}`);
    sessionIds.add(s.id);
  }
  for (const p of plans) {
    const dayIds = new Set<string>();
    for (const d of p.days) {
      if (dayIds.has(d.id)) c.add(`data.plans(${p.id}).days`, `训练日 ID 重复：${d.id}`);
      dayIds.add(d.id);
    }
  }

  // 唯一性检查之后必须再判一次失败，否则重复 ID 只会被记录却仍然放行
  if (c.failed) return { ok: false, issues: firstIssues(c.issues, 40) };

  const warnings: string[] = [];
  const actives = sessions.filter((s) => s.status === 'active');
  if (actives.length > 1) warnings.push(`备份包含 ${actives.length} 个未结束训练，导入后将逐条处理`);
  else if (actives.length === 1) warnings.push('备份包含 1 个未结束训练，恢复后可继续记录');
  if (!plans.length && sessions.length) warnings.push('备份里没有计划，但存在训练记录（历史仍可查看）');

  return {
    ok: true,
    value: {
      plans,
      sessions,
      settings: Array.isArray(data.settings) ? (data.settings as unknown[]) : [],
    },
    warnings,
  };
}
