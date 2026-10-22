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
  ExerciseTarget,
  GroupPlan,
  Plan,
  PlanDay,
  PlanExercise,
  Session,
  SessionExercise,
  SessionSet,
  SessionSummary,
  SetStatus,
  DropSetTarget,
  StraightTarget,
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

/**
 * 目标的一句话摘要。
 * 递减组只给「N 轮 × M 阶段」的短摘要，阶段明细由 <DropStageList> 分行展示，
 * 避免把整段阶段链硬塞进一行导致换行溢出（视觉验收要求）。
 */
export function describeTarget(ex: PlanExercise): string {
  const t = ex.target;
  if (t.kind === 'dropSet') {
    return `${t.rounds} 轮 × ${t.stages.length} 阶段递减`;
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

/** 由目标推导组结构（普通组每组件 1 阶段；递减组每轮 = 阶段数） */
export function groupsFromTarget(t: ExerciseTarget): GroupPlan[] {
  if (t.kind === 'straight') {
    return Array.from({ length: t.sets }, (_, i) => ({ index: i + 1, stageCount: 1 }));
  }
  const stages = Math.max(1, t.stages.length);
  return Array.from({ length: t.rounds }, (_, i) => ({ index: i + 1, stageCount: stages }));
}

/** 为动作生成与组结构匹配的空记录 */
function initialSetsFor(ex: PlanExercise, groups: GroupPlan[]): SessionSet[] {
  const t = ex.target;
  const sets: SessionSet[] = [];
  for (const g of groups) {
    for (let si = 1; si <= g.stageCount; si++) {
      const toFailure =
        t.kind === 'dropSet' ? Boolean(t.stages[si - 1]?.toFailure) : false;
      sets.push(blankSet(g.index, si, toFailure));
    }
  }
  return sets;
}

export function sessionExerciseFromPlan(ex: PlanExercise): SessionExercise {
  const target = structuredClone(ex.target);
  const groups = groupsFromTarget(target);
  return {
    id: newId('sex'),
    exerciseId: ex.exerciseId ?? resolveExerciseId(ex),
    planExerciseId: ex.id,
    name: ex.name,
    en: ex.en,
    restSec: ex.restSec,
    target,
    status: 'pending',
    groups,
    sets: initialSetsFor(ex, groups),
    note: '',
  };
}

function warmupFromPlan(w: WarmupTarget) {
  return { id: w.id, name: w.name, unit: w.unit, targetText: w.targetText, done: false as boolean };
}

/** 开始训练：对计划日做快照 */
export function createSession(plan: Plan, day: PlanDay, now = Date.now()): Session {
  const exercises = day.exercises.map(sessionExerciseFromPlan);
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
    targetSetsAtStart: exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0),
    startedAt: now,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: day.warmups.map(warmupFromPlan),
    exercises,
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

/**
 * 是否已输入过任何实际数据（与「是否计入完成量」严格分开）。
 * 用于替换/转换时判断哪些组/轮「已经开始了」，不能当空白重建。
 * reps 或 weightKg 任一非 null（含 0）即算已输入；status !== 'blank' 也算；
 * 备注等用户留下的信息只要存在也保留。
 *
 * 注意：`toFailure` 不参与判定 —— 它由目标结构在建立空行时就写入，
 * 若把它当输入，任何「技术性力竭」阶段都会让递减组永远无法转换。
 */
export function setHasActualInput(s: SessionSet): boolean {
  if (hasReps(s)) return true;
  if (typeof s.weightKg === 'number' && Number.isFinite(s.weightKg)) return true;
  if (s.status !== 'blank') return true;
  return Boolean(s.note && s.note.trim());
}

export function dropRoundSets(ex: SessionExercise, round: number): SessionSet[] {
  return ex.sets.filter((s) => s.roundIndex === round).sort((a, b) => a.stageIndex - b.stageIndex);
}

/** 该组是否已输入过任何实际数据（任一阶段命中即可） */
export function groupHasActualInput(ex: SessionExercise, groupIndex: number): boolean {
  return dropRoundSets(ex, groupIndex).some(setHasActualInput);
}

/** 该组必需几个阶段（来自组结构快照，而不是现存行数） */
export function requiredStages(ex: SessionExercise, groupIndex: number): number {
  return ex.groups.find((g) => g.index === groupIndex)?.stageCount ?? 1;
}

/** 该组是否被跳过 */
export function isGroupSkipped(ex: SessionExercise, groupIndex: number): boolean {
  return Boolean(ex.groups.find((g) => g.index === groupIndex)?.skipped);
}

/**
 * 完整大组：必需的每个阶段都存在、已填次数且状态 done。
 * 只凭「现存行全 done」判完整是错误的（R03.4：缺阶段会被误判完整）。
 */
export function dropRoundComplete(ex: SessionExercise, round: number): boolean {
  const need = requiredStages(ex, round);
  const sets = dropRoundSets(ex, round);
  if (!sets.length) return false;
  for (let si = 1; si <= need; si++) {
    const set = sets.find((s) => s.stageIndex === si);
    if (!set || !isSetLogged(set)) return false;
  }
  return true;
}

/** 部分大组：有已记录阶段，但不满足完整条件 */
export function dropRoundPartial(ex: SessionExercise, round: number): boolean {
  if (isGroupSkipped(ex, round)) return false;
  const sets = dropRoundSets(ex, round);
  const logged = sets.filter((s) => isSetLogged(s)).length;
  return logged > 0 && !dropRoundComplete(ex, round);
}

/**
 * 该动作本次安排的组序号列表。
 * v3 合法的「零组动作」（groups: []、sets: []）必须返回空数组：
 * 不能凭空补一个幽灵「1 组」，否则 arrange/planned 统计会虚增。
 * 调用方若依赖「至少一组」，必须自行显式处理。
 */
export function roundsOf(ex: SessionExercise): number[] {
  if (ex.groups.length) return ex.groups.map((g) => g.index);
  const rounds = Array.from(new Set(ex.sets.map((s) => s.roundIndex))).sort((a, b) => a - b);
  return rounds.length ? rounds : [];
}

/**
 * 从本次训练快照读取休息配置（R09）。
 * · 递减组：阶段之间用 target.restInSec，完成整轮用 target.restAfterSec
 * · 普通组：用 ex.restSec
 * 全部来自 session 快照，不读计划当前值，也不硬编码。
 */
export function restConfigFor(
  ex: SessionExercise,
  kind: 'betweenStages' | 'afterGroup',
): number {
  if (ex.target.kind === 'dropSet') {
    return kind === 'betweenStages' ? ex.target.restInSec : ex.target.restAfterSec;
  }
  return ex.restSec;
}

/**
 * 某个 set 完成后应该休息多久（自动计时与手动「计时」共用同一份快照）。
 * · 递减组：该 set 是本轮最后一个必需阶段 → target.restAfterSec；否则 → target.restInSec
 * · 普通组 → ex.restSec
 * 只读本次训练快照（ex.target / ex.restSec），不读计划当前值，也不硬编码。
 */
export function restAfterSet(ex: SessionExercise, set: SessionSet): number {
  if (ex.target.kind === 'dropSet') {
    const need = requiredStages(ex, set.roundIndex);
    return set.stageIndex >= need ? ex.target.restAfterSec : ex.target.restInSec;
  }
  return ex.restSec;
}

/**
 * 该组是否没有任何需要保护的实际输入。
 * 语义 = 「完全未开始」，与「是否计入完成量」无关（见 setHasActualInput）。
 */
export function groupHasNoRecords(ex: SessionExercise, round: number): boolean {
  return !groupHasActualInput(ex, round);
}

/**
 * 是否有「可以撤销」的跳过：存在被 skipped 的组。
 * 用于 UI 决定显示「取消跳过」还是「跳过剩余组」——
 * 不能用 groups.every(g => g.skipped) 判断，那样做完 1 组再跳过剩余时永远不可取消。
 */
export function hasSkippedGroupsToUnskip(ex: SessionExercise): boolean {
  return ex.groups.some((g) => Boolean(g.skipped));
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
  const rounds = roundsOf(ex);
  const completed = rounds.filter((r) => dropRoundComplete(ex, r)).length;
  const skipped = rounds.filter((r) => isGroupSkipped(ex, r)).length;
  const hasAny = ex.sets.some(isSetLogged) || ex.sets.some(isSetIncomplete);

  // R02：把「跳过剩余」和「已完成 / 部分完成」分开表达。
  // · 有记录 + 全部组都完成 → done
  // · 有记录但还有组被跳过 / 未完成 → partial（不能说成已完成）
  // · 完全没记录且全部跳过 → skipped
  if (completed === rounds.length && rounds.length > 0) return 'done';
  if (hasAny || completed > 0) return 'partial';
  // 零组动作（合法可选动作）没有任何组可跳过：不能因为 0 === 0 就判成 skipped
  if (rounds.length > 0 && skipped === rounds.length) return 'skipped';
  if (ex.status === 'skipped') return 'skipped';
  return 'pending';
}

/** 该动作有几个组被跳过（用于界面区分「跳过剩余」） */
export function skippedGroupCount(ex: SessionExercise): number {
  return roundsOf(ex).filter((r) => isGroupSkipped(ex, r) && groupHasNoRecords(ex, r)).length;
}

/**
 * 统计一次训练。
 * 口径（R02 / R03 / R10 统一）：
 * · completedSets：完整大组数（递减组按轮计，不按阶段计）
 * · partialGroups：有记录但未完整的组
 * · skippedGroups：被跳过且无任何记录的组
 * · 被跳过的动作，只要之前有记录，实际量照常计入
 * · targetSets：开始训练时的计划目标（快照），替换/加组都不改
 * · plannedSets：本次安排（groups 之和）
 * · arrangedGroups：groups 数量
 */
export function summarizeSession(session: Session, now = Date.now()): SessionSummary {
  let completedSets = 0;
  let incompleteSets = 0;
  let partialGroups = 0;
  let targetSets = 0;
  let plannedSets = 0;
  let arrangedGroups = 0;
  let skippedGroups = 0;
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

    const rounds = roundsOf(ex);
    arrangedGroups += rounds.length;
    plannedSets += rounds.length;

    for (const r of rounds) {
      if (isGroupSkipped(ex, r)) {
        // 跳过的组：只有确实没有任何记录时才算「跳过」
        if (groupHasNoRecords(ex, r)) skippedGroups++;
        else if (dropRoundComplete(ex, r)) completedSets++;
        else partialGroups++;
        continue;
      }
      if (dropRoundComplete(ex, r)) completedSets++;
      else if (dropRoundPartial(ex, r)) partialGroups++;
    }

    // 缺数据的组（点了完成却没填次数）单独统计
    for (const set of ex.sets) {
      if (isSetIncomplete(set)) incompleteSets++;
    }
  }

  return {
    completedSets,
    incompleteSets,
    partialGroups,
    // R03.3：分母用开始时的快照，替换/加组不会把 20 改成 22
    targetSets: session.targetSetsAtStart ?? targetSets,
    plannedSets,
    arrangedGroups,
    skippedGroups,
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
 * 跳过剩余工作（R02）。
 * 只把「还没有任何记录」的组标记为 skipped；已有实际记录的组保持原样。
 * 因此跳过后，之前完成的组仍然计入实际量，不再从 1 变 0。
 */
export function skipRemaining(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const groups = ex.groups.map((g) => {
        const started = groupHasActualInput(ex, g.index);
        const complete = dropRoundComplete(ex, g.index);
        // 已完成或已有实际输入的组不受跳过影响
        if (started || complete) return { ...g, skipped: false };
        return { ...g, skipped: true };
      });
      const anyInput = ex.sets.some(setHasActualInput);
      return {
        ...ex,
        groups,
        // 全部组都被跳过且完全没有实际输入时才标记动作级 skipped
        status: anyInput ? ('done' as const) : ('skipped' as const),
      };
    }),
  };
}

/**
 * 训练中把动作改成递减组（C01 路径 B），只影响本次训练。
 * 规则：
 * · 完全无记录 → 直接整条转换，保留动作身份与位置。
 * · 已有记录 → 旧结构收尾（有记录的组保持原样，未开始的组关闭），
 *   在原动作之后插入一个新的递减组实例承接剩余轮次。
 * · 已有实际数据绝不因转换而消失。
 */
export function convertExerciseToDropSet(
  session: Session,
  exId: string,
  target: DropSetTarget,
): { session: Session; converted: boolean; message: string } {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return { session, converted: false, message: '找不到这个动作' };
  const old = session.exercises[idx];
  const rounds = roundsOf(old);
  // 只有「真未开始」的组才能转换：填了 reps/weight/status 的组一律算已开始
  const notStarted = rounds.filter((r) => !groupHasActualInput(old, r));

  // 所有组都真未开始：整条转换
  if (notStarted.length === rounds.length) {
    const newGroups = groupsFromTarget(target);
    const sets: SessionSet[] = [];
    for (const g of newGroups) {
      for (let si = 1; si <= g.stageCount; si++) {
        sets.push(blankSet(g.index, si, Boolean(target.stages[si - 1]?.toFailure)));
      }
    }
    const next: SessionExercise = {
      ...old,
      target: structuredClone(target),
      groups: newGroups,
      sets,
      status: 'pending',
    };
    const exercises = [...session.exercises];
    exercises[idx] = next;
    return {
      session: { ...session, exercises },
      converted: true,
      message: `已把「${old.name}」改为 ${target.rounds} 轮 × ${target.stages.length} 阶段递减组`,
    };
  }

  // 有已开始的组：旧结构保留（含只有 reps 的组），剩余未开始的轮次转成一个新的递减组实例
  if (notStarted.length === 0) {
    return {
      session,
      converted: false,
      message: `「${old.name}」的每一组都已经记录，没有可转换的剩余部分。`,
    };
  }

  const keptOld: SessionExercise = {
    ...old,
    status: 'done',
    groups: old.groups.map((g) => ({
      ...g,
      skipped: groupHasActualInput(old, g.index) ? false : true,
    })),
    // 已开始的组保留全部原始 set 行（含空阶段），未开始的组不留在旧动作上
    sets: old.sets.filter((s) => groupHasActualInput(old, s.roundIndex)),
    note: `${old.note ? old.note + ' · ' : ''}剩余部分已转为递减组`,
  };

  const carried = Math.min(notStarted.length, target.rounds);
  const carriedTarget: DropSetTarget = { ...structuredClone(target), rounds: carried };
  const newGroups = groupsFromTarget(carriedTarget);
  const sets: SessionSet[] = [];
  for (const g of newGroups) {
    for (let si = 1; si <= g.stageCount; si++) {
      sets.push(blankSet(g.index, si, Boolean(target.stages[si - 1]?.toFailure)));
    }
  }
  const fresh: SessionExercise = {
    id: newId('sex'),
    exerciseId: old.exerciseId,
    planExerciseId: null,
    name: old.name,
    restSec: old.restSec,
    target: carriedTarget,
    status: 'pending',
    groups: newGroups,
    sets,
    note: `承接未开始的 ${carried} 轮，改为递减组`,
  };

  const exercises = [...session.exercises];
  exercises.splice(idx, 1, keptOld, fresh);
  return {
    session: { ...session, exercises },
    converted: true,
    message: `「${old.name}」已记录部分保留，未开始的 ${carried} 轮改为递减组`,
  };
}

/** 训练中把递减组改回普通组（同样只影响未开始部分） */
export function convertExerciseToStraight(
  session: Session,
  exId: string,
  straight: StraightTarget,
): { session: Session; converted: boolean; message: string } {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return { session, converted: false, message: '找不到这个动作' };
  const old = session.exercises[idx];
  const rounds = roundsOf(old);
  // 只有「真未开始」的组才能转换：填了 reps/weight/status 的组一律算已开始
  const notStarted = rounds.filter((r) => !groupHasActualInput(old, r));

  // 所有组都真未开始：整条转换
  if (notStarted.length === rounds.length) {
    const groups = groupsFromTarget(straight);
    const next: SessionExercise = {
      ...old,
      target: structuredClone(straight),
      groups,
      sets: groups.map((g) => blankSet(g.index, 1)),
      status: 'pending',
    };
    const exercises = [...session.exercises];
    exercises[idx] = next;
    return {
      session: { ...session, exercises },
      converted: true,
      message: `已把「${old.name}」改为普通组 ${straight.sets} 组`,
    };
  }

  if (notStarted.length === 0) {
    return { session, converted: false, message: `「${old.name}」没有可转换的剩余组。` };
  }

  const keptOld: SessionExercise = {
    ...old,
    status: 'done',
    groups: old.groups.map((g) => ({ ...g, skipped: !groupHasActualInput(old, g.index) })),
    // 已开始的组保留全部原始 set 行（含只有 reps 的组），未开始的组不留在旧动作上
    sets: old.sets.filter((s) => groupHasActualInput(old, s.roundIndex)),
  };
  const carriedStraight: StraightTarget = {
    ...structuredClone(straight),
    sets: Math.min(notStarted.length, straight.sets),
    setsMax: Math.min(notStarted.length, straight.sets),
  };
  const groups = groupsFromTarget(carriedStraight);
  const fresh: SessionExercise = {
    id: newId('sex'),
    exerciseId: old.exerciseId,
    planExerciseId: null,
    name: old.name,
    restSec: old.restSec,
    target: carriedStraight,
    status: 'pending',
    groups,
    sets: groups.map((g) => blankSet(g.index, 1)),
    note: `承接未开始的 ${groups.length} 组，改为普通组`,
  };
  const exercises = [...session.exercises];
  exercises.splice(idx, 1, keptOld, fresh);
  return {
    session: { ...session, exercises },
    converted: true,
    message: `已记录部分保留，未开始的 ${groups.length} 组改为普通组`,
  };
}

/**
 * 撤销跳过：只清掉 groups 上的 skipped 标记，已做数据一律不动。
 * 动作级 status 按实际记录重算（不再无脑重置为 pending，
 * 否则「做完 1 组再跳过 → 取消跳过」会把已有记录的动作降级成未开始）。
 */
export function unskipExercise(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const groups = ex.groups.map((g) => ({ ...g, skipped: false }));
      const next: SessionExercise = { ...ex, groups };
      const hasRecord = ex.sets.some((s) => isSetLogged(s) || isSetIncomplete(s));
      return { ...next, status: hasRecord ? ('done' as const) : ('pending' as const) };
    }),
  };
}

/**
 * 标记整个动作完成：只改动作级状态，**绝不**凭空把空白组写成已完成。
 * 空白组保持 blank；已有缺次数的组保持 partial。
 */
export function replaceExerciseInSession(
  session: Session,
  exId: string,
  name: string,
  opts: { exerciseId?: string } = {},
): { session: Session; replaced: boolean; message: string } {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return { session, replaced: false, message: '找不到要替换的动作' };
  const old = session.exercises[idx];
  const newExerciseId = opts.exerciseId ?? exerciseIdFromName(name);

  const rounds = roundsOf(old);
  const fullyDone = rounds.filter((r) => dropRoundComplete(old, r));
  // 「已开始」= 有任何实际输入（reps / weight / status / 备注），不只是「计入完成量」的那些
  const startedRounds = rounds.filter((r) => groupHasActualInput(old, r));
  const notStartedRounds = rounds.filter((r) => !groupHasActualInput(old, r));

  // ── 情况 1：所有组都真未开始 → 原地替换 ──
  if (notStartedRounds.length === rounds.length) {
    const replacement: SessionExercise = {
      ...old,
      id: newId('sex'),
      exerciseId: newExerciseId,
      planExerciseId: null,
      name,
      status: 'pending',
      groups: old.groups.map((g) => ({ ...g, skipped: false })),
      sets: old.sets.map((s) => ({
        ...s,
        id: newId('set'),
        reps: null,
        weightKg: null,
        status: 'blank' as SetStatus,
      })),
      note: old.note ?? '',
      replacedFrom: old.name,
    };
    const exercises = [...session.exercises];
    exercises[idx] = replacement;
    return {
      session: { ...session, exercises },
      replaced: true,
      message: `已替换为「${name}」，位置与结构不变`,
    };
  }

  // ── 情况 2：有记录，但没有「未开始的完整组」可承接 ──
  if (notStartedRounds.length === 0) {
    return {
      session,
      replaced: false,
      message: `「${old.name}」的每一组都已经开始记录，没有可承接的完整组。请用「临时加动作」另加「${name}」。`,
    };
  }

  // ── 情况 3：有已开始的组 + 有未开始的组 → 旧动作收尾，新动作承接未开始的组 ──
  // 旧动作：保留全部实际数据（含只有 reps 的组）；把未开始的组标记为 skipped
  const keptGroups: GroupPlan[] = old.groups.map((g) => ({
    ...g,
    // 只对「无实际输入」的组标记 skip；有输入但未完成的组保持原样（部分大组）
    skipped: !groupHasActualInput(old, g.index),
  }));

  const keptSets = old.sets.filter((s) => {
    const g = old.groups.find((x) => x.index === s.roundIndex);
    if (!g) return false;
    // 保留有输入的组的所有阶段行（含空阶段，便于看出缺哪个阶段）
    return groupHasActualInput(old, g.index);
  });

  const keptOld: SessionExercise = {
    ...old,
    status: 'done',
    groups: keptGroups,
    sets: keptSets,
    note: `${old.note ? old.note + ' · ' : ''}剩余部分已替换为「${name}」`,
  };

  // 新动作：承接尚未开始的完整组，结构按原组结构复制（不拆阶段）
  const carriedGroups: GroupPlan[] = notStartedRounds.map((r, i) => ({
    index: i + 1,
    stageCount: requiredStages(old, r),
  }));

  const freshSets: SessionSet[] = [];
  for (const g of carriedGroups) {
    for (let si = 1; si <= g.stageCount; si++) {
      const srcSet = dropRoundSets(old, notStartedRounds[g.index - 1]).find((s) => s.stageIndex === si);
      freshSets.push({
        id: newId('set'),
        roundIndex: g.index,
        stageIndex: si,
        reps: null,
        weightKg: null,
        status: 'blank' as SetStatus,
        ...(srcSet?.toFailure ? { toFailure: true } : {}),
      });
    }
  }

  // 新动作的目标：普通组按承接组数；递减组按承接轮数 + 原有阶段结构
  const newTarget: ExerciseTarget =
    old.target.kind === 'straight'
      ? {
          ...old.target,
          sets: carriedGroups.length,
          setsMax: carriedGroups.length,
        }
      : {
          ...structuredClone(old.target),
          rounds: carriedGroups.length,
        };

  const fresh: SessionExercise = {
    id: newId('sex'),
    exerciseId: newExerciseId,
    planExerciseId: null,
    name,
    restSec: old.restSec,
    target: newTarget,
    status: 'pending',
    groups: carriedGroups,
    sets: freshSets,
    note: `承接「${old.name}」未开始的 ${carriedGroups.length} ${
      old.target.kind === 'dropSet' ? '轮' : '组'
    }`,
    replacedFrom: old.name,
  };

  const exercises = [...session.exercises];
  exercises.splice(idx, 1, keptOld, fresh);

  const keptSummary =
    old.target.kind === 'dropSet'
      ? `${fullyDone.length} 轮完整、${startedRounds.length - fullyDone.length} 轮部分`
      : `${startedRounds.length} 组已开始`;

  return {
    session: { ...session, exercises },
    replaced: true,
    message: `「${old.name}」保留 ${keptSummary}，${carriedGroups.length} ${
      old.target.kind === 'dropSet' ? '轮' : '组'
    }未开始部分转给「${name}」`,
  };
}

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
      const maxRound = ex.groups.reduce((m, g) => Math.max(m, g.index), 0);
      const stageCount = ex.target.kind === 'dropSet' ? Math.max(1, ex.target.stages.length) : 1;
      const groups = [...ex.groups, { index: maxRound + 1, stageCount }];
      const sets = [
        ...ex.sets,
        ...Array.from({ length: stageCount }, (_, i) =>
          blankSet(
            maxRound + 1,
            i + 1,
            ex.target.kind === 'dropSet' ? Boolean(ex.target.stages[i]?.toFailure) : false,
          ),
        ),
      ];
      return { ...ex, groups, sets };
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
      // 递减组按整轮删除，普通组删单组
      const drop = ex.target.kind === 'dropSet' ? ex.sets.filter((s) => s.roundIndex === target.roundIndex) : [target];
      const dropIds = new Set(drop.map((s) => s.id));
      const groups = ex.groups.filter((g) => g.index !== target.roundIndex);
      // 重排组序号，保持连续
      const reindexed = groups.map((g, i) => ({ ...g, index: i + 1 }));
      const remap = new Map(groups.map((g, i) => [g.index, i + 1]));
      const sets = ex.sets
        .filter((s) => !dropIds.has(s.id))
        .map((s) => ({ ...s, roundIndex: remap.get(s.roundIndex) ?? s.roundIndex }));
      return { ...ex, groups: reindexed, sets };
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
      const rounds = roundsOf(ex);
      if (rounds.length <= 1) return ex;
      const last = rounds[rounds.length - 1];
      return {
        ...ex,
        groups: ex.groups.filter((g) => g.index !== last),
        sets: ex.sets.filter((s) => s.roundIndex !== last),
      };
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
