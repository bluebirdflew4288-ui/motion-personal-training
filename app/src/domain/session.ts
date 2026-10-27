/* 训练实例的构造与统计口径。
   统计规则（与 README 的「统计口径」一致，测试见 test/session.test.ts）：
   · 热身不计入正式组。
   · 计划里没做的组不算已完成组。
   · 递减组按「大组」计数：一轮三个阶段的次数都填了才算 1 个完整大组；
     只填了部分阶段时算 1 个「部分完成大组」，不伪装成完整组。
   · 直练动作按组计数，只算 status='done' 且在计划组数范围内的组。 */

import { exerciseIdFromName, resolveExerciseId } from './identity';
import {
  CARDIO_PRESET_LABEL,
  cardioTotalMs,
  createCardioEntry,
  pauseCardio,
  resumeCardio,
} from './cardio';
import { adhocDayId } from './sessionKind';
import {
  MAX_CARDIO_ENTRIES,
  MAX_EXERCISES,
  MAX_REPS,
  MAX_REST,
  MAX_ROUNDS,
  MAX_SET_ROWS,
  MAX_STRAIGHT_SETS,
  MIN_ROUNDS,
} from './limits';
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
  CardioEntry,
  CardioParams,
  CardioPreset,
  DropSetTarget,
  PlanCardio,
  SessionOrigin,
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
/**
 * 开始训练：对计划日做快照。
 *
 * **按 `day.kind` 分支**（第2阶段）：
 * · train  → 力量结构（原有行为，一字不改）
 * · cardio → 不复制 `day.exercises`（避免幽灵力量结构），带计划有氧目标
 * · rest   → 不走这里（休息是首页直接记录，见 createRestSession）
 */
export function createSession(plan: Plan, day: PlanDay, now = Date.now()): Session {
  const kind: Session['kind'] = day.kind === 'cardio' ? 'cardio' : 'strength';
  const isStrength = kind === 'strength';
  const exercises = isStrength ? day.exercises.map(sessionExerciseFromPlan) : [];
  const cardio = isStrength ? [] : (day.cardio ?? []).map(cardioEntryFromPlanCardio);

  return {
    id: newId('sess'),
    planId: plan.id,
    planName: plan.name,
    day: {
      dayId: day.id,
      dayName: day.name,
      // 非力量日不伪造胸背腿 / A·B
      ...(isStrength ? { focus: day.focus, round: day.round } : {}),
      partText: isStrength ? `${day.name}` : kind === 'cardio' ? `${day.name} · 有氧` : `${day.name}`,
    },
    cycleIndexAtStart: plan.cursor,
    targetSetsAtStart: exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0),
    startedAt: now,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: isStrength ? day.warmups.map(warmupFromPlan) : [],
    exercises,
    note: '',
    kind,
    origin: 'plan',
    cardio,
    cardioPausedBySession: [],
  };
}

/** 由计划有氧目标创建实际 entry（目标快照不可变，实际参数独立） */
function cardioEntryFromPlanCardio(pc: PlanCardio): CardioEntry {
  return createCardioEntry({
    preset: pc.preset,
    name: pc.name,
    params: pc.target,
    planCardioId: pc.id,
    target: { ...pc.target },
  });
}

/**
 * 创建**临时**独立有氧（首页「今日练什么」的有氧入口）。
 *
 * · `kind = 'cardio'`、`origin = 'temporary'`
 * · `day.dayId` 用 `adhoc:<sessionId>`，**不借当前力量 dayId**，避免误推进循环
 */
export function createAdhocCardioSession(args: {
  plan: Plan;
  preset: CardioPreset;
  name?: string;
  params: CardioParams;
  now?: number;
}): Session {
  const now = args.now ?? Date.now();
  const sessionId = newId('sess');
  const entry = createCardioEntry({
    preset: args.preset,
    name: args.name ?? CARDIO_PRESET_LABEL[args.preset],
    params: args.params,
  });
  return {
    id: sessionId,
    planId: args.plan.id,
    planName: args.plan.name,
    day: {
      dayId: adhocDayId(sessionId),
      dayName: '临时有氧',
      partText: '临时有氧',
    },
    cycleIndexAtStart: args.plan.cursor,
    targetSetsAtStart: 0,
    startedAt: now,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: [],
    exercises: [],
    note: '',
    kind: 'cardio',
    origin: 'temporary',
    cardio: [entry],
    cardioPausedBySession: [],
  };
}

/**
 * 创建**完全休息**记录（首页「今天完全休息」）。
 *
 * · `kind = 'rest'`、`status = 'completed'`（创建即终态）
 * · `restDate` 用**本地日**并在创建时固定
 * · 不进入 active 继续训练入口
 */
export function createRestSession(args: {
  plan: Plan;
  restDate: string;
  origin: SessionOrigin;
  now?: number;
}): Session {
  const now = args.now ?? Date.now();
  return {
    id: newId('sess'),
    planId: args.plan.id,
    planName: args.plan.name,
    day: {
      dayId: adhocDayId(newId('rest')),
      dayName: '完全休息',
      partText: '完全休息',
    },
    cycleIndexAtStart: args.plan.cursor,
    targetSetsAtStart: 0,
    startedAt: now,
    endedAt: now,
    status: 'completed',
    pausedMs: 0,
    pausedAt: null,
    warmups: [],
    exercises: [],
    note: '',
    kind: 'rest',
    origin: args.origin,
    restDate: args.restDate,
    cardio: [],
    cardioPausedBySession: [],
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
    // 有氧有效时长单列（不并入 durationMs，避免双计）
    cardioMs: cardioTotalMs(session.cardio, now),
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
  opts: { exerciseId?: string; config?: ReplaceExerciseConfig } = {},
): { session: Session; replaced: boolean; message: string } {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return { session, replaced: false, message: '找不到要替换的动作' };
  const old = session.exercises[idx];
  const newExerciseId = opts.exerciseId ?? exerciseIdFromName(name);
  const kind = old.target.kind;

  const rounds = roundsOf(old);
  const fullyDone = rounds.filter((r) => dropRoundComplete(old, r));
  // 「已开始」= 有任何实际输入（reps / weight / status / 备注），不只是「计入完成量」的那些
  const startedRounds = rounds.filter((r) => groupHasActualInput(old, r));
  const notStartedRounds = rounds.filter((r) => !groupHasActualInput(old, r));

  /**
   * 新动作本次的组数/轮数（需求 1）。
   * · 未指定 → 沿用「可承接的完整组数」（保持旧行为，替换不凭空增减量）。
   * · 指定 → 用用户确认的值，按目标类型夹紧到合法上限（不静默截断成非法值）。
   * 注意：这只决定**新动作**的组数，原动作的组结构一个都不改。
   */
  const carriedCount = notStartedRounds.length;
  const wantedGroups = clampGroupCount(kind, opts.config?.sets ?? carriedCount);

  /**
   * 新动作的休息配置（预审反馈 3）。
   *
   * 缺省值必须**按目标类型取该动作真正使用的休息字段**，不能一律读 ex.restSec：
   * · 普通组：休息就是 ex.restSec。
   * · 递减组：ex.restSec 是历史遗留、实际不参与计时（见 restConfigFor）；
   *   真正的「轮间/组间休息」是 target.restAfterSec。若缺省取 ex.restSec，
   *   原 restSec=120 / restAfterSec=90 的动作会在替换后被**无意改成 120**。
   * 这与 replaceConfigSeedFor 的取法保持一致（同一份规则，两处不能分叉）。
   */
  const defaultRestSec =
    kind === 'dropSet'
      ? clampRestSec((old.target as DropSetTarget).restAfterSec)
      : clampRestSec(old.restSec);
  const nextRestSec =
    opts.config?.restSec === undefined ? defaultRestSec : clampRestSec(opts.config.restSec);

  /** 递减组阶段结构沿用原动作（阶段数、力竭标记都不改） */
  const stageCountOf = (round: number): number => {
    if (kind !== 'dropSet') return 1;
    const fromSnapshot = requiredStages(old, round);
    return Math.max(1, fromSnapshot);
  };
  /** 新建轮次（超出原未开始组数时）沿用第一个可承接轮的结构，否则用目标阶段数 */
  const fallbackStageCount =
    kind === 'dropSet'
      ? Math.max(
          1,
          carriedCount > 0
            ? requiredStages(old, notStartedRounds[0])
            : (old.target as DropSetTarget).stages.length,
        )
      : 1;

  /**
   * B4：把用户设置的**每组目标次数**应用到新动作 target（两分支共用）。
   *
   * 规则（产品裁决）：
   *   · 普通组：沿用既有 target 模型，只改 repsMin/repsMax；固定次数=上下限相同；
   *   · 递减组：**逐阶段**只覆盖 repsMin/repsMax/toFailure，
   *     保留阶段数量/顺序/label/weightKg/其它结构；
   *   · 只改 target（目标），**绝不改 actual**（新记录 reps/weight 仍 null/blank）；
   *   · 同步更新派生文案 targetText，避免数字已改但摘要仍显示旧次数。
   */
  /**
   * B4-R1：目标次数覆盖的**合法性校验**（domain 层）。
   *
   * UI 校验不能替代领域校验：非法值若进入 session，会生成**无法备份恢复**的记录
   * （validate.ts 会拒绝整份备份）。这里按既有 limits 真源逐项检查，
   * 非法直接**拒绝替换**（返回原 session，不静默夹紧）。
   */
  const repsOverrideError = (ov: ReplaceRepsOverride | undefined): string | null => {
    if (!ov) return null;
    /**
     * B4-R2（已证缺口 4）：**kind 不匹配必须最先拒绝**。
     *
     * <p>真实失败（22 例 20 PASS / 2 FAIL）：
     * <ul>
     *   <li>普通 target + dropSet override → 走到 dropSet 分支读
     *       {@code old.target.stages.length} → **TypeError**（未捕获的崩溃）；</li>
     *   <li>dropSet target + straight override → 通过范围校验，但
     *       {@code applyRepsOverride} 返回**原样**的 drop target，
     *       外层却报 {@code replaced:true} —— 假称成功且静默忽略用户目标。</li>
     * </ul>
     *
     * <p>两者都是公开 union 的合法成员组合，属于 API 边界缺口。
     * 这里在读任何 shape-specific 字段**之前**先比 kind，
     * 返回明确失败（调用方据此返回原 session、replaced:false）。
     * 不盲 catch、不改既有断言。
     */
    if (ov.kind !== old.target.kind) {
      return '目标次数类型与动作目标类型不一致，无法应用';
    }
    const okInt = (n: unknown): n is number =>
      typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_REPS;
    if (ov.kind === 'straight') {
      if (!okInt(ov.repsMin) || !okInt(ov.repsMax)) {
        return `每组目标次数必须是 0–${MAX_REPS} 的整数`;
      }
      if (ov.repsMin > ov.repsMax) return '每组目标次数的下限不能大于上限';
      return null;
    }
    // dropSet：阶段数量必须与目标一致
    const base = old.target as DropSetTarget;
    if (ov.stages.length !== base.stages.length) {
      return '阶段数量与目标不一致，无法应用目标次数';
    }
    for (let i = 0; i < ov.stages.length; i += 1) {
      const st = ov.stages[i];
      const baseSt = base.stages[i];
      const toFailure = st.toFailure ?? baseSt.toFailure;
      if (toFailure) continue; // 力竭阶段不要求次数
      const min = st.repsMin ?? baseSt.repsMin;
      const max = st.repsMax ?? baseSt.repsMax;
      if (!okInt(min) || !okInt(max)) {
        return `第 ${i + 1} 阶段的目标次数必须是 0–${MAX_REPS} 的整数`;
      }
      if (min > max) return `第 ${i + 1} 阶段的下限不能大于上限`;
    }
    return null;
  };

  const applyRepsOverride = (base: StraightTarget | DropSetTarget): StraightTarget | DropSetTarget => {
    const ov = opts.config?.reps;
    if (!ov) return base;
    if (base.kind === 'straight') {
      /**
       * 理论上不可达：kind 不匹配已在 repsOverrideError 早拒。
       * 保留返回原 target 作为防御，但**绝不能**让外层报 replaced:true
       * （外层只在 repsErr 为空时才继续，因此不会走到这里）。
       */
      if (ov.kind !== 'straight') return base;
      const t = base as StraightTarget;
      return {
        ...t,
        repsMin: ov.repsMin,
        repsMax: ov.repsMax,
      };
    }
    if (ov.kind !== 'dropSet') return base;
    const t = base as DropSetTarget;
    const stages = t.stages.map((st, i) => {
      const patch = ov.stages[i];
      if (!patch) return st; // 未覆盖的阶段原样保留
      const toFailure = patch.toFailure ?? st.toFailure;
      const repsMin = toFailure ? null : (patch.repsMin ?? st.repsMin);
      const repsMax = toFailure ? null : (patch.repsMax ?? st.repsMax);
      return {
        ...st,
        repsMin,
        repsMax,
        toFailure,
        // 更新派生文案：力竭阶段写「技术性力竭」，否则「下限–上限 次」
        targetText: toFailure
          ? '技术性力竭'
          : repsMin !== null && repsMax !== null
            ? repsMin === repsMax
              ? `${repsMin} 次`
              : `${repsMin}–${repsMax} 次`
            : st.targetText,
      };
    });
    return { ...t, stages };
  };

  /** B4-R1：非法目标次数直接拒绝（不生成无法备份的 session） */
  const repsErr = repsOverrideError(opts.config?.reps);
  if (repsErr) return { session, replaced: false, message: repsErr };

  /**
   * 已应用目标次数覆盖的基准 target（供 buildGroupsAndSets 取力竭标志）。
   * 未提供 reps 时等价于原 target。
   */
  const effectiveTarget = applyRepsOverride(
    kind === 'dropSet'
      ? structuredClone(old.target as DropSetTarget)
      : { ...(old.target as StraightTarget) },
  );

  /** 按「用户确认的组数」构造新动作的组结构 + 空记录行 */
  const buildGroupsAndSets = (): { groups: GroupPlan[]; sets: SessionSet[] } => {
    const groups: GroupPlan[] = [];
    const sets: SessionSet[] = [];
    for (let i = 0; i < wantedGroups; i += 1) {
      const srcRound = notStartedRounds[i];
      const stageCount = srcRound !== undefined ? stageCountOf(srcRound) : fallbackStageCount;
      groups.push({ index: i + 1, stageCount });
      for (let si = 1; si <= stageCount; si += 1) {
        // 力竭标记只在递减组有意义，且必须跟随原结构，不能靠位置猜
        /**
         * B4-R1：新空 set 的力竭标志必须来自**新目标**（可能已被用户切换），
         * 不能用旧 target —— 否则 UI 勾了力竭、记录行却仍按旧标志构造。
         */
        const toFailure =
          kind === 'dropSet'
            ? Boolean(
                (effectiveTarget as DropSetTarget | null)?.stages[si - 1]?.toFailure ??
                  (old.target as DropSetTarget).stages[si - 1]?.toFailure,
              )
            : false;
        sets.push({
          id: newId('set'),
          roundIndex: i + 1,
          stageIndex: si,
          reps: null,
          weightKg: null,
          status: 'blank' as SetStatus,
          ...(toFailure ? { toFailure: true } : {}),
        });
      }
    }
    return { groups, sets };
  };

  // ── 情况 1：所有组都真未开始 → 原地替换（位置不变，组数/休息按用户确认值） ──
  if (notStartedRounds.length === rounds.length) {
    const { groups, sets } = buildGroupsAndSets();
    /**
     * 预审反馈 4：联合上限校验。超限**拒绝替换**（返回原 session 不变），
     * 不静默裁剪轮数，也不生成备份无法恢复的记录。
     */
    const budget = checkGroupRowBudget(
      groups.length,
      groups.map((g) => g.stageCount),
    );
    if (!budget.ok) return { session, replaced: false, message: budget.message };
    const replacement: SessionExercise = {
      ...old,
      id: newId('sex'),
      exerciseId: newExerciseId,
      planExerciseId: null,
      name,
      status: 'pending',
      restSec: nextRestSec,
      // 递减组：轮数随用户确认值；阶段结构原样保留，只更新轮间休息
      target: applyRepsOverride(
        kind === 'dropSet'
          ? {
              ...structuredClone(old.target as DropSetTarget),
              rounds: groups.length,
              restAfterSec: nextRestSec,
            }
          : {
              ...(old.target as StraightTarget),
              sets: groups.length,
              setsMax: groups.length,
            },
      ),
      groups,
      sets,
      note: old.note ?? '',
      replacedFrom: old.name,
    };
    const exercises = [...session.exercises];
    exercises[idx] = replacement;
    return {
      session: { ...session, exercises },
      replaced: true,
      message:
        opts.config?.sets === undefined && opts.config?.restSec === undefined
          ? `已替换为「${name}」，位置与结构不变`
          : `已替换为「${name}」，本次 ${groups.length} ${kind === 'dropSet' ? '轮' : '组'}、休息 ${nextRestSec} 秒`,
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

  // ── 情况 3：有已开始的组 + 有未开始的组 → 旧动作收尾，新动作承接 ──
  // 旧动作：保留全部实际数据（含只有 reps 的组）；未开始的组标记 skipped
  // 硬要求：已有原动作数据继续归属原动作，不删除、不改名、不迁移到新动作。
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

  const { groups: carriedGroups, sets: freshSets } = buildGroupsAndSets();

  /**
   * 预审反馈 4：承接路径同样要过联合上限。
   * 此时**尚未构造任何新 session**，直接返回原 session，保证「拒绝且不改数据」。
   */
  const carriedBudget = checkGroupRowBudget(
    carriedGroups.length,
    carriedGroups.map((g) => g.stageCount),
  );
  if (!carriedBudget.ok) return { session, replaced: false, message: carriedBudget.message };

  /**
   * 新动作的目标：普通组按确认组数；递减组按确认轮数 + 原有阶段结构。
   * B4：**两个分支共用同一目标构造规则** —— 这里同样应用每组目标次数覆盖。
   */
  const newTarget: ExerciseTarget = applyRepsOverride(
    kind === 'straight'
      ? {
          ...(old.target as StraightTarget),
          sets: carriedGroups.length,
          setsMax: carriedGroups.length,
        }
      : {
          ...structuredClone(old.target as DropSetTarget),
          rounds: carriedGroups.length,
          restAfterSec: nextRestSec,
        },
  ) as ExerciseTarget;

  const fresh: SessionExercise = {
    id: newId('sex'),
    exerciseId: newExerciseId,
    planExerciseId: null,
    name,
    restSec: nextRestSec,
    target: newTarget,
    status: 'pending',
    groups: carriedGroups,
    sets: freshSets,
    note: `承接「${old.name}」未开始的部分，本次 ${carriedGroups.length} ${
      kind === 'dropSet' ? '轮' : '组'
    }`,
    replacedFrom: old.name,
  };

  const exercises = [...session.exercises];
  exercises.splice(idx, 1, keptOld, fresh);

  const keptSummary =
    kind === 'dropSet'
      ? `${fullyDone.length} 轮完整、${startedRounds.length - fullyDone.length} 轮部分`
      : `${startedRounds.length} 组已开始`;

  return {
    session: { ...session, exercises },
    replaced: true,
    message: `「${old.name}」保留 ${keptSummary}；「${name}」本次 ${carriedGroups.length} ${
      kind === 'dropSet' ? '轮' : '组'
    }、休息 ${nextRestSec} 秒`,
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

/* ── 临时添加力量动作（本次训练）：先配置，确认后才追加 ──────────
   用户反馈问题二：旧行为是「选动作/输入名字 → 直接添加」，组数固定 3、
   次数固定 8–12、休息固定 120 秒，用户无法先设定本次目标。

   现在改成两段式：
     ① UI 收集「组数 / 每组目标次数 / 组间休息」草稿（不写 session）；
     ② 用户确认后，用**当前 raw 输入**构造一份完整配置，交给本函数追加一次。

   领域约束（与 limits.ts 唯一真源一致，超限明确拒绝，绝不静默裁剪）：
   · 组数 1–MAX_STRAIGHT_SETS；次数 0–MAX_REPS 且下限 ≤ 上限；
     固定次数 = 上下限相等（沿用既有模型，不新增字段）。
   · 休息 0–MAX_REST（0 合法 = 不休息）。
   · 动作数受 MAX_EXERCISES 约束，与备份校验同一条边界。
   · 只追加到本次 session 快照：原计划、历史、循环游标、既有动作记录都不变。
   · 新动作的 actual 全部为空（reps/weightKg = null、status = 'blank'），
     目标次数只写进 target，绝不写成实际完成。 */

/** 临时添加动作的完整配置（一次添加意图的全部输入） */
export interface LooseExerciseConfig {
  name: string;
  /** 本次组数（普通组） */
  sets: number;
  /** 每组目标次数下限（与上限相等表示固定次数） */
  repsMin: number;
  /** 每组目标次数上限 */
  repsMax: number;
  /** 组间休息秒数 */
  restSec: number;
}

export type LooseExerciseConfigCheck =
  | { ok: true; config: LooseExerciseConfig }
  | { ok: false; message: string };

/**
 * 校验并归一化一份「临时添加动作」配置。
 *
 * 纯函数：UI 在确认前调用一次（提示用），领域在追加前再调用一次
 * （真正的边界，防止绕过 UI 直接调用产生非法数据）。
 */
export function checkLooseExerciseConfig(cfg: LooseExerciseConfig): LooseExerciseConfigCheck {
  const name = typeof cfg.name === 'string' ? cfg.name.trim() : '';
  if (!name) return { ok: false, message: '动作名不能为空' };
  if (!Number.isInteger(cfg.sets) || cfg.sets < 1 || cfg.sets > MAX_STRAIGHT_SETS) {
    return { ok: false, message: `组数必须是 1–${MAX_STRAIGHT_SETS} 的整数` };
  }
  for (const [label, v] of [
    ['次数下限', cfg.repsMin],
    ['次数上限', cfg.repsMax],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_REPS) {
      return { ok: false, message: `${label}必须是 0–${MAX_REPS} 的整数` };
    }
  }
  if (cfg.repsMin > cfg.repsMax) {
    return { ok: false, message: '每组目标次数的下限不能大于上限' };
  }
  if (!Number.isInteger(cfg.restSec) || cfg.restSec < 0 || cfg.restSec > MAX_REST) {
    return { ok: false, message: `休息秒数必须是 0–${MAX_REST} 的整数` };
  }
  return { ok: true, config: { ...cfg, name } };
}

/**
 * 按配置追加一个临时动作（**只追加一次**，幂等由调用方按提交身份保证）。
 *
 * @returns added=false 时 session 原样返回，message 是明确拒绝原因
 *          （容量已达上限 / 配置不合法），绝不静默截断或部分写入。
 */
export function addConfiguredLooseExercise(
  session: Session,
  cfg: LooseExerciseConfig,
): { session: Session; added: boolean; message: string } {
  const checked = checkLooseExerciseConfig(cfg);
  if (!checked.ok) return { session, added: false, message: checked.message };
  const c = checked.config;

  // 容量在领域边界核验：与备份校验同一条 MAX_EXERCISES，拒绝而非裁剪
  if (session.exercises.length >= MAX_EXERCISES) {
    return {
      session,
      added: false,
      message: `本次训练已经有 ${MAX_EXERCISES} 个动作，达到上限（备份也只支持这个范围）。请先移除或合并动作。`,
    };
  }

  const planExercise: PlanExercise = {
    id: newId('adhoc'),
    exerciseId: exerciseIdFromName(c.name),
    name: c.name,
    restSec: c.restSec,
    target: {
      kind: 'straight',
      sets: c.sets,
      setsMax: c.sets,
      repsMin: c.repsMin,
      repsMax: c.repsMax,
      weightMode: 'external',
      suggestedWeightKg: null,
    },
  };
  const ex = sessionExerciseFromPlan(planExercise);
  const repsText = c.repsMin === c.repsMax ? `${c.repsMin}` : `${c.repsMin}–${c.repsMax}`;
  return {
    session: { ...session, exercises: [...session.exercises, { ...ex, added: true }] },
    added: true,
    message: `已添加「${c.name}」（${c.sets} 组 × ${repsText} 次 · 休息 ${c.restSec} 秒）`,
  };
}

/**
 * 旧签名（组数/次数/休息固定默认值）——**保留给既有测试与历史调用**。
 *
 * 新的 UI 路径一律走 `addConfiguredLooseExercise`（先配置后确认）。
 * 这里委托给新函数，因此同样受 MAX_EXERCISES / limits 约束；
 * 被拒绝时返回原 session（不产生半条记录）。
 */
export function addLooseExercise(session: Session, name: string, sets = 3, repsMin = 8, repsMax = 12): Session {
  return addConfiguredLooseExercise(session, { name, sets, repsMin, repsMax, restSec: 120 }).session;
}

/* ── 从本次训练移除整个动作（用户反馈问题三）──────────────────
   这是**整项动作移除**，不是删单组、不是删计划、也不是「跳过剩余组」。

   保护判据（复用既有 actual-input 口径，不用完成组数/truthy 猜）：
   · 任一组 setHasActualInput —— 次数（含 0）、重量（含 0）、
     非 blank 状态（done/partial）、组备注；
   · 动作备注非空；
   · 动作被显式标记为完成（status='done'）——那是用户的显式结论；
   · 未提交的输入草稿（raw，由 UI 通过 Stepper 的风险登记传入）。
   纯跳过（status='skipped' 且没有任何实际输入）不算实际成果，可以移除。 */

export interface ExerciseRemovalCheck {
  /** true = 有需要保护的实际输入/记录，不能直接移除 */
  protected: boolean;
  /** 保护原因（UI 直接展示；「可跳过剩余组」的指引由 UI 补充） */
  reasons: string[];
}

/** 判定一个动作是否含有需要保护的实际输入 */
export function exerciseRemovalProtection(
  ex: SessionExercise,
  opts?: {
    /** 该动作是否有未提交的输入草稿（raw） */
    hasRawDraft?: boolean;
  },
): ExerciseRemovalCheck {
  const reasons: string[] = [];
  if (ex.sets.some(setHasActualInput)) reasons.push('已经有次数/重量/组状态或组备注记录');
  if ((ex.note ?? '').trim()) reasons.push('已经有动作备注');
  if (ex.status === 'done') reasons.push('已经被标记为完成');
  if (opts?.hasRawDraft) reasons.push('还有没提交的输入草稿');
  return { protected: reasons.length > 0, reasons };
}

/**
 * 按 **sessionExerciseId** 移除整个动作（不按名称，避免同名不同 ID 误删）。
 *
 * · 只影响本次 session：原计划、历史、循环游标、其他动作的数据与相对顺序不变；
 * · 找不到该 ID → removed=false，session 原样返回（重复调用/旧回调安全）；
 * · 移除后允许动作数为 0（正常空态，可重新添加，备份/导出仍合法）。
 */
export function removeExerciseFromSession(
  session: Session,
  exId: string,
): { session: Session; removed: boolean; name: string } {
  const target = session.exercises.find((e) => e.id === exId);
  if (!target) return { session, removed: false, name: '' };
  return {
    session: { ...session, exercises: session.exercises.filter((e) => e.id !== exId) },
    removed: true,
    name: target.name,
  };
}

/**
 * 替换动作时可配置的「本次训练」参数（需求 1）。
 *
 * 语义边界（必须与需求一致）：
 * · sets  = **新动作本次要做的组数/轮数**，不是原动作剩余组数。
 * · restSec = 新动作本次的组间休息秒数（普通组写 ex.restSec；
 *             递减组写 target.restAfterSec —— 那是「完成整轮」后的休息，
 *             阶段间 restInSec 沿用原结构，不在这里改）。
 * · 两者都只影响本次 session 快照，**绝不回写计划**。
 *
 * 只允许「未开始的完整组」被承接：已有原动作数据继续归属原动作。
 */
export interface ReplaceExerciseConfig {
  /** 新动作本次的组数（普通组=组数，递减组=轮数）。undefined → 沿用可承接的组数 */
  sets?: number;
  /** 新动作本次的休息秒数。undefined → 沿用原动作的休息配置 */
  restSec?: number;
  /**
   * B4 用户新增：**每组目标次数**（只作用于新动作的 target，不碰 actual）。
   *
   * 用区分普通/递减的联合类型，避免拿整份 target 覆盖（那会顺带改重量、
   * 阶段结构、休息或模式）。缺省 → 完全保持旧行为。
   */
  reps?: ReplaceRepsOverride;
}

/**
 * 替换动作的目标次数覆盖（B4）。
 *
 * · `straight`：所有新组共用的次数范围（固定次数 = 上下限相同）；
 * · `dropSet`：**按阶段**给次数/力竭，保留原阶段数量、顺序、重量与其它结构。
 *
 * 只覆盖"用户明确设置的目标次数/力竭"，其余字段从原 target 克隆。
 */
export type ReplaceRepsOverride =
  | { kind: 'straight'; repsMin: number; repsMax: number }
  | {
      kind: 'dropSet';
      /** 与目标 stages 等长；只覆盖 repsMin/repsMax/toFailure */
      stages: Array<{ repsMin?: number; repsMax?: number; toFailure?: boolean }>;
    };

/** 组数上限按目标类型取：普通组 MAX_STRAIGHT_SETS，递减组 MAX_ROUNDS */
function clampGroupCount(kind: 'straight' | 'dropSet', n: number): number {
  const max = kind === 'straight' ? MAX_STRAIGHT_SETS : MAX_ROUNDS;
  const min = kind === 'straight' ? 1 : MIN_ROUNDS;
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 休息秒数的唯一合法化入口（0 合法 = 不休息；上限 MAX_REST） */
export function clampRestSec(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_REST, Math.max(0, Math.trunc(n)));
}

/**
 * 组结构行数（groups.stageCount 之和）的联合上限校验（预审反馈 4）。
 *
 * 为什么需要单独一条：MAX_ROUNDS(20) 与 MAX_STAGES_ACCEPTED(12) 各自合法，
 * 但 20 × 12 = 240 行 > MAX_SET_ROWS(200)。历史数据里 12 阶段的动作本来能通过校验，
 * 替换时若允许把轮数拉到 20，就会生成**新备份无法恢复**的记录
 * （validate.ts 会以「组记录行数超过上限」拒绝整份备份）。
 *
 * 规则：超限时**明确拒绝**（返回错误消息），绝不静默裁剪轮数或阶段数。
 */
export function checkGroupRowBudget(
  rounds: number,
  stageCounts: number[],
): { ok: true } | { ok: false; message: string } {
  // 行数 = 每轮阶段数之和（stageCounts 就是按轮给出的 stageCount）
  const rows = stageCounts.reduce((n, c) => n + Math.max(1, c), 0);
  if (rows > MAX_SET_ROWS) {
    const per = stageCounts.length ? Math.max(...stageCounts.map((c) => Math.max(1, c))) : 1;
    return {
      ok: false,
      message: `按 ${rounds} 轮 × ${per} 阶段会生成 ${rows} 行记录，超过单动作上限 ${MAX_SET_ROWS} 行。请减少轮数。`,
    };
  }
  return { ok: true };
}

/**
 * 替换动作确认步骤的**初始值**（需求 1：初始值继承可承接的原动作配置）。
 *
 * 组数取「可承接的未开始组/轮数」——因为替换只承接这些；若一个都不可承接
 * （已有组全部开始记录），替换会被拒绝，此时组数回退到原动作总组数仅用于展示。
 * 休息取原动作本次快照的休息秒数（普通组 restSec；递减组 restAfterSec = 完成整轮后休息）。
 *
 * 这是纯函数，UI 只用它填初值；真正的上限夹紧发生在 replaceExerciseInSession。
 */
export function replaceConfigSeedFor(ex: SessionExercise): {
  sets: number;
  restSec: number;
  carriedCount: number;
  kind: 'straight' | 'dropSet';
} {
  const kind = ex.target.kind;
  const rounds = roundsOf(ex);
  const carriedCount = rounds.filter((r) => !groupHasActualInput(ex, r)).length;
  const restSec =
    kind === 'dropSet' ? clampRestSec((ex.target as DropSetTarget).restAfterSec) : clampRestSec(ex.restSec);
  const sets = clampGroupCount(kind, carriedCount > 0 ? carriedCount : rounds.length);
  return { sets, restSec, carriedCount, kind };
}

/**
 * 替换动作（原地，不追加）。
 * · 未记录任何数据的动作：整条替换成新动作，位置不变。
 * · 已有实际记录：**保留已记录的原动作**，把剩余未完成的部分替换为新动作，
 *   并在新动作上标注来源，避免把旧记录错误归到新动作名下。
 *
 * 需求 1（替换后确认组数与休息）在此实现，全部是「本次训练」快照：
 * · config.sets 决定新动作本次的组数/轮数（不再是「剩余组数」）。
 * · config.restSec 决定新动作本次的休息秒数。
 * · 已有原动作数据（含部分组）绝不删除、不改名、不归到新动作。
 */


/* ── 有氧项目的会话级操作（第2阶段）───────────── */

/** 用新 entry 替换同 id 的有氧项目 */
export function withCardioEntry(session: Session, entry: CardioEntry): Session {
  const list = session.cardio ?? [];
  const idx = list.findIndex((c) => c.id === entry.id);
  const cardio = idx < 0 ? [...list, entry] : list.map((c) => (c.id === entry.id ? entry : c));
  return { ...session, cardio };
}

/**
 * 追加一个临时有氧项目到本次训练（力量训练后追加）。
 * G3：容量在**领域与写入边界**都核验，不只靠渲染 disabled ——
 * 否则快速输入能产生超过 8 项、备份无法恢复的自产数据。
 */
export function addCardioToSession(
  session: Session,
  entry: CardioEntry,
): Session | null {
  const list = session.cardio ?? [];
  if (list.length >= MAX_CARDIO_ENTRIES) return null; // 已达上限：拒绝，不改数据
  return { ...session, cardio: [...list, entry] };
}

/** 移除一个有氧项目 */
export function removeCardioFromSession(session: Session, entryId: string): Session {
  return { ...session, cardio: (session.cardio ?? []).filter((c) => c.id !== entryId) };
}

/**
 * 整次训练暂停 → 停住正在运行的有氧，并记录**最小必要**的恢复意图。
 * 恢复时只恢复这些，不误开用户手动暂停的有氧。
 */
export function pauseCardioForSessionPause(session: Session, now = Date.now()): Session {
  const list = session.cardio ?? [];
  const running = list.filter((c) => c.status === 'running');
  if (!running.length) return session;
  return {
    ...session,
    cardio: list.map((c) => (c.status === 'running' ? pauseCardio(c, now) : c)),
    cardioPausedBySession: running.map((c) => c.id),
  };
}

/** 整次训练恢复 → 只恢复因整次暂停而被停住的有氧 */
export function resumeCardioForSessionResume(session: Session, now = Date.now()): Session {
  const ids = session.cardioPausedBySession ?? [];
  if (!ids.length) return session;
  const set = new Set(ids);
  return {
    ...session,
    cardio: (session.cardio ?? []).map((c) => (set.has(c.id) ? resumeCardio(c, now) : c)),
    cardioPausedBySession: [],
  };
}
