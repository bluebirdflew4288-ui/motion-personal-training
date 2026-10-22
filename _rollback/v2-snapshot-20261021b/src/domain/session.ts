/* 训练实例的构造与统计口径。
   统计规则（与 README 的「统计口径」一致，测试见 test/session.test.ts）：
   · 热身不计入正式组。
   · 计划里没做的组不算已完成组。
   · 递减组按「大组」计数：一轮三个阶段的次数都填了才算 1 个完整大组；
     只填了部分阶段时算 1 个「部分完成大组」，不伪装成完整组。
   · 直练动作按组计数，只算 status='done' 且在计划组数范围内的组。 */

import { exerciseIdFromName, resolveExerciseId } from './identity';
import type {
  ExerciseCompletion,
  Plan,
  PlanDay,
  PlanExercise,
  Session,
  SessionExercise,
  SessionSet,
  SessionSummary,
  SetStatus,
  WarmupTarget,
} from './types';

export const newId = (prefix = 'id'): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 计划里这一天的目标大组数（递减组按轮数） */
export function targetGroupsOf(ex: PlanExercise): number {
  return ex.target.kind === 'straight' ? ex.target.sets : ex.target.rounds;
}

export function targetSetsOfPlan(day: PlanDay): number {
  return day.exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0);
}

export function describeTarget(ex: PlanExercise): string {
  const t = ex.target;
  if (t.kind === 'dropSet') {
    return `${t.rounds} 轮递减 · ${t.stages.map((s) => s.targetText).join(' → ')}`;
  }
  const sets = t.setsMax > t.sets ? `${t.sets}–${t.setsMax}` : `${t.sets}`;
  return `${sets} 组 × ${t.repsMin}–${t.repsMax} 次`;
}

export function weightModeLabel(ex: PlanExercise): string | null {
  const t = ex.target;
  if (t.kind !== 'straight') {
    return t.dumbbellBasis === 'per_hand' ? '哑铃 · 按单只计' : null;
  }
  switch (t.weightMode) {
    case 'bodyweight':
      return '自重';
    case 'bodyweight_plus':
      return '自重 + 外加负重';
    case 'assisted':
      return '辅助重量';
    default:
      return t.dumbbellBasis === 'per_hand' ? '哑铃 · 按单只计' : null;
  }
}

function blankSet(roundIndex: number, stageIndex: number, toFailure = false): SessionSet {
  return {
    id: newId('set'),
    roundIndex,
    stageIndex,
    reps: null,
    weightKg: null,
    status: 'blank',
    ...(toFailure ? { toFailure: true } : {}),
  };
}

/** 为直练动作生成计划组数的空记录 */
function initialSetsFor(ex: PlanExercise): SessionSet[] {
  const t = ex.target;
  if (t.kind === 'straight') {
    return Array.from({ length: t.sets }, (_, i) => blankSet(i + 1, 1));
  }
  const sets: SessionSet[] = [];
  for (let round = 1; round <= t.rounds; round++) {
    t.stages.forEach((stage, si) => {
      sets.push(blankSet(round, si + 1, stage.toFailure));
    });
  }
  return sets;
}

export function sessionExerciseFromPlan(ex: PlanExercise): SessionExercise {
  return {
    id: newId('sex'),
    exerciseId: ex.exerciseId ?? resolveExerciseId(ex),
    planExerciseId: ex.id,
    name: ex.name,
    en: ex.en,
    restSec: ex.restSec,
    target: structuredClone(ex.target),
    status: 'pending',
    sets: initialSetsFor(ex),
    note: '',
  };
}

function warmupFromPlan(w: WarmupTarget) {
  return { id: w.id, name: w.name, unit: w.unit, targetText: w.targetText, done: false as boolean };
}

/** 开始训练：对计划日做快照 */
export function createSession(plan: Plan, day: PlanDay, now = Date.now()): Session {
  return {
    id: newId('sess'),
    planId: plan.id,
    planName: plan.name,
    day: {
      dayId: day.id,
      dayName: day.name,
      focus: day.focus,
      round: day.round,
      partText: day.kind === 'rest' ? (day.restNote ?? '休息') : `${day.name}`,
    },
    cycleIndexAtStart: plan.cursor,
    startedAt: now,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: day.warmups.map(warmupFromPlan),
    exercises: day.exercises.map(sessionExerciseFromPlan),
    note: '',
  };
}

/* ── 组状态 ─────────────────────────────── */

export function needsWeight(ex: SessionExercise): boolean {
  const t = ex.target;
  if (t.kind === 'straight') return t.weightMode === 'external' || t.weightMode === 'bodyweight_plus' || t.weightMode === 'assisted';
  return true;
}

/** 该组是否「已填实际次数」——0 也算填了 */
export const hasReps = (s: SessionSet): boolean => typeof s.reps === 'number' && Number.isFinite(s.reps);

/**
 * 完整有效组：状态 done 且实际次数已填。
 * 注意：reps === 0 是「实际做了 0 次」，属于有效记录；reps === null 是「没填」，无效。
 */
export function isSetLogged(s: SessionSet): boolean {
  return s.status === 'done' && hasReps(s);
}

/** 已做但缺关键数据（例如点了完成却没填次数） */
export function isSetIncomplete(s: SessionSet): boolean {
  return s.status === 'partial' || (s.status === 'done' && !hasReps(s));
}

export function dropRoundSets(ex: SessionExercise, round: number): SessionSet[] {
  return ex.sets.filter((s) => s.roundIndex === round).sort((a, b) => a.stageIndex - b.stageIndex);
}

export function dropRoundComplete(ex: SessionExercise, round: number): boolean {
  const sets = dropRoundSets(ex, round);
  return sets.length > 0 && sets.every((s) => s.status === 'done');
}

export function dropRoundPartial(ex: SessionExercise, round: number): boolean {
  const sets = dropRoundSets(ex, round);
  const done = sets.filter((s) => s.status === 'done').length;
  return done > 0 && done < sets.length;
}

export function roundsOf(ex: SessionExercise): number[] {
  const rounds = Array.from(new Set(ex.sets.map((s) => s.roundIndex))).sort((a, b) => a - b);
  return rounds.length ? rounds : [1];
}

/* ── 汇总 ───────────────────────────────── */

export function elapsedMs(session: Session, now = Date.now()): number {
  const end = session.endedAt ?? now;
  let paused = session.pausedMs;
  if (session.pausedAt) paused += Math.max(0, now - session.pausedAt);
  return Math.max(0, end - session.startedAt - paused);
}

/**
 * 单个动作的完成状态 —— 汇总、历史、统计、导出共用这一处判定。
 * · skipped：用户显式跳过
 * · done   ：计划的每个大组都已完整有效完成
 * · partial：有有效记录但未完成全部（含递减组部分大组、临时加组未做等）
 * · pending：完全没有有效记录
 */
export function exerciseCompletion(ex: SessionExercise): ExerciseCompletion {
  if (ex.status === 'skipped') return 'skipped';

  if (ex.target.kind === 'straight') {
    const target = ex.target.sets;
    // 可选 0 组动作：未安排，不算完成也不该算待记录
    if (target === 0) {
      return ex.sets.some(isSetLogged) ? 'partial' : 'pending';
    }
    const valid = ex.sets.filter(isSetLogged).length;
    if (valid === 0) return 'pending';
    return valid >= target ? 'done' : 'partial';
  }

  // 递减组：按「完整大组」判定
  const rounds = roundsOf(ex);
  const completed = rounds.filter((r) => dropRoundComplete(ex, r)).length;
  const hasAny = ex.sets.some(isSetLogged);
  if (!hasAny) return 'pending';
  return completed >= ex.target.rounds ? 'done' : 'partial';
}

/**
 * 统计一次训练。
 * 口径（回答审计 R1-01 / R1-02 / R2-05）：
 * · completedSets：实际完成的完整有效组数，**不受原计划组数封顶**。
 *   计划 3 组、实际做 4 组 → 计 4 组。临时删组也不改原始目标快照。
 * · targetSets：开始训练时的计划目标（快照），用于对照。
 * · plannedSets：本次实际安排的组数（含临时加组、减去临时删组）。
 * · incompleteSets：点了完成却没填次数的组，单独统计，不算有效组。
 * · 递减组按完整大组计数；部分大组只记 partialGroups。
 * · 可选 0 组动作不会自动算完成（R2-05）。
 */
export function summarizeSession(session: Session, now = Date.now()): SessionSummary {
  let completedSets = 0;
  let incompleteSets = 0;
  let partialGroups = 0;
  let targetSets = 0;
  let plannedSets = 0;
  let exercisesDone = 0;
  let exercisesPartial = 0;
  let exercisesSkipped = 0;
  let exercisesPending = 0;

  for (const ex of session.exercises) {
    targetSets += targetGroupsOf(ex);

    const state = exerciseCompletion(ex);
    if (state === 'done') exercisesDone++;
    else if (state === 'partial') exercisesPartial++;
    else if (state === 'skipped') exercisesSkipped++;
    else exercisesPending++;

    if (ex.status === 'skipped') {
      plannedSets += targetGroupsOf(ex);
      continue;
    }

    if (ex.target.kind === 'straight') {
      plannedSets += ex.sets.length;
      for (const set of ex.sets) {
        if (isSetLogged(set)) completedSets++;
        else if (isSetIncomplete(set)) incompleteSets++;
      }
    } else {
      const rounds = roundsOf(ex);
      plannedSets += rounds.length;
      for (const round of rounds) {
        if (dropRoundComplete(ex, round)) completedSets++;
        else if (dropRoundPartial(ex, round)) partialGroups++;
      }
      for (const set of ex.sets) {
        if (isSetIncomplete(set)) incompleteSets++;
      }
    }
  }

  return {
    completedSets,
    incompleteSets,
    partialGroups,
    targetSets,
    plannedSets,
    exercisesDone,
    exercisesPartial,
    exercisesSkipped,
    exercisesPending,
    durationMs: elapsedMs(session, now),
    totalSets: session.exercises.length,
  };
}

/** 是否已记录过任何有效数据（用于放弃确认） */
export function hasAnyData(session: Session): boolean {
  if (session.note.trim()) return true;
  if (session.warmups.some((w) => w.done)) return true;
  return session.exercises.some(
    (ex) => ex.status === 'skipped' || ex.sets.some((s) => s.status === 'done' || hasReps(s) || s.weightKg !== null),
  );
}

/* ── 变更操作（纯函数，返回新对象）───────── */

export function withSet(session: Session, exId: string, setId: string, patch: Partial<SessionSet>): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const sets = ex.sets.map((s) => {
        if (s.id !== setId) return s;
        const next = { ...s, ...patch };
        // 归一化：标记完成但没有实际次数 → partial（已做但缺数据），不计入完整有效组
        if (next.status === 'done' && !hasReps(next)) return { ...next, status: 'partial' as SetStatus };
        // 从 partial 补上次数且仍是 done 意图 → 恢复 done
        if (s.status === 'partial' && next.status === 'partial' && hasReps(next)) {
          return { ...next, status: 'done' as SetStatus };
        }
        return next;
      });
      return { ...ex, sets };
    }),
  };
}

export function withExercise(session: Session, exId: string, patch: Partial<SessionExercise>): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => (ex.id === exId ? { ...ex, ...patch } : ex)),
  };
}

/**
 * 标记整个动作完成：只改动作级状态，**绝不**凭空把空白组写成已完成。
 * 空白组保持 blank；已有缺次数的组保持 partial。
 */
export function markExerciseDone(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => (ex.id === exId ? { ...ex, status: 'done' as const } : ex)),
  };
}

export function addSetTo(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      if (ex.target.kind === 'straight') {
        const maxRound = ex.sets.reduce((m, s) => Math.max(m, s.roundIndex), 0);
        return { ...ex, sets: [...ex.sets, blankSet(maxRound + 1, 1)] };
      }
      // 递减组：补一整轮
      const maxRound = ex.sets.reduce((m, s) => Math.max(m, s.roundIndex), 0);
      const stages = ex.target.stages;
      return {
        ...ex,
        sets: [...ex.sets, ...stages.map((st, i) => blankSet(maxRound + 1, i + 1, st.toFailure))],
      };
    }),
  };
}

export function removeSetFrom(session: Session, exId: string, setId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const target = ex.sets.find((s) => s.id === setId);
      if (!target) return ex;
      const drop = ex.target.kind === 'dropSet' ? ex.sets.filter((s) => s.roundIndex === target.roundIndex) : [target];
      const dropIds = new Set(drop.map((s) => s.id));
      return { ...ex, sets: ex.sets.filter((s) => !dropIds.has(s.id)) };
    }),
  };
}

/**
 * 删除递减组的整轮（审计任务 K-9：删已记录轮前需确认，UI 负责）。
 * 直练动作等价于删最后一组。
 */
export function removeLastRound(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      if (ex.target.kind === 'straight') {
        if (ex.sets.length <= 1) return ex;
        const maxRound = ex.sets.reduce((m, s) => Math.max(m, s.roundIndex), 0);
        return { ...ex, sets: ex.sets.filter((s) => s.roundIndex !== maxRound) };
      }
      const rounds = roundsOf(ex);
      if (rounds.length <= 1) return ex;
      const last = rounds[rounds.length - 1];
      return { ...ex, sets: ex.sets.filter((s) => s.roundIndex !== last) };
    }),
  };
}

/** 判断某动作最后一轮是否已有记录（用于删除前确认） */
export function lastRoundHasRecords(ex: SessionExercise): boolean {
  const rounds = roundsOf(ex);
  const last = rounds[rounds.length - 1];
  if (last === undefined) return false;
  return ex.sets
    .filter((s) => s.roundIndex === last)
    .some((s) => s.status !== 'blank' || s.reps !== null || s.weightKg !== null);
}

export function moveExercise(session: Session, exId: string, dir: -1 | 1): Session {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  const swap = idx + dir;
  if (idx < 0 || swap < 0 || swap >= session.exercises.length) return session;
  const next = [...session.exercises];
  const a = next[idx];
  const b = next[swap];
  next[idx] = b;
  next[swap] = a;
  return { ...session, exercises: next };
}

export function addLooseExercise(session: Session, name: string, sets = 3, repsMin = 8, repsMax = 12): Session {
  const planExercise: PlanExercise = {
    id: newId('adhoc'),
    exerciseId: exerciseIdFromName(name),
    name,
    restSec: 120,
    target: {
      kind: 'straight',
      sets,
      setsMax: sets,
      repsMin,
      repsMax,
      weightMode: 'external',
      suggestedWeightKg: null,
    },
  };
  const ex = sessionExerciseFromPlan(planExercise);
  return { ...session, exercises: [...session.exercises, { ...ex, added: true }] };
}

/**
 * 替换动作（原地，不追加）。
 * · 未记录任何数据的动作：整条替换成新动作，位置不变。
 * · 已有实际记录：**保留已记录的原动作**，把剩余未完成的部分替换为新动作，
 *   并在新动作上标注来源，避免把旧记录错误归到新动作名下。
 */
export function replaceExerciseInSession(session: Session, exId: string, name: string): Session {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return session;
  const old = session.exercises[idx];
  const newIdValue = exerciseIdFromName(name);

  const hasRecords = old.sets.some(
    (s) => isSetLogged(s) || isSetIncomplete(s) || s.weightKg !== null,
  );

  if (!hasRecords) {
    const replacement: SessionExercise = {
      id: newId('sex'),
      exerciseId: newIdValue,
      planExerciseId: null,
      name,
      restSec: old.restSec,
      target: structuredClone(old.target),
      status: 'pending',
      sets: old.sets.map((s) => ({ ...s, reps: null, weightKg: null, status: 'blank' as SetStatus })),
      note: old.note ?? '',
      replacedFrom: old.name,
    };
    const exercises = [...session.exercises];
    exercises[idx] = replacement;
    return { ...session, exercises };
  }

  // 已有记录：旧动作保留为已完成（只保留有数据的组），并在其后插入新动作
  const keptOld: SessionExercise = {
    ...old,
    name: old.name,
    status: 'done',
    note: `${old.note ? old.note + ' · ' : ''}已替换为「${name}」，保留已记录部分`,
    sets: old.sets.map((s) => (isSetLogged(s) || isSetIncomplete(s) || s.weightKg !== null ? s : { ...s, status: 'skipped' as SetStatus })),
  };

  const totalSets = old.target.kind === 'straight' ? old.target.sets : old.target.rounds;
  const doneCount = old.target.kind === 'straight'
    ? old.sets.filter(isSetLogged).length
    : roundsOf(old).filter((r) => dropRoundComplete(old, r)).length;
  const remaining = Math.max(0, totalSets - doneCount);

  const fresh: SessionExercise = {
    id: newId('sex'),
    exerciseId: newIdValue,
    planExerciseId: null,
    name,
    restSec: old.restSec,
    target: structuredClone(old.target),
    status: 'pending',
    sets: Array.from({ length: remaining }, (_, i) => ({
      id: newId('set'),
      roundIndex: i + 1,
      stageIndex: 1,
      reps: null,
      weightKg: null,
      status: 'blank' as SetStatus,
    })),
    note: `由「${old.name}」剩余部分替换（原记录已保留在上面）`,
    replacedFrom: old.name,
  };

  const exercises = [...session.exercises];
  exercises.splice(idx, 1, keptOld, fresh);
  return { ...session, exercises };
}
