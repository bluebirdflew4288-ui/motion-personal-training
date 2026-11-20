/* 训练实例的构造与统计口径。
   统计规则（与 README 的「统计口径」一致，测试见 test/session.test.ts）：
   · 热身不计入正式组。
   · 计划里没做的组不算已完成组。
   · 递减组按「大组」计数：一轮三个阶段的次数都填了才算 1 个完整大组；
     只填了部分阶段时算 1 个「部分完成大组」，不伪装成完整组。
   · 直练动作按组计数，只算 status='done' 且在计划组数范围内的组。 */

import { resolveExerciseId } from './identity';
import {
  CARDIO_PRESET_LABEL,
  cardioTotalMs,
  createCardioEntry,
  pauseCardio,
  resumeCardio,
} from './cardio';
import { adhocDayId } from './sessionKind';
import {
  applyTargetToExercise,
  groupPlanForTarget,
  resolveGroupConfig,
  resolveRoundStageIdentities,
  resolveStageIdsFromConfigForRound,
  roundRestInSecOf,
  roundStagesOf,
  type TargetApplyImpact,
} from './exerciseConfig';
import { MAX_CARDIO_ENTRIES, MAX_ROUNDS, MAX_SET_ROWS } from './limits';
import { registerSessionPlanBaseline } from './sessionToPlanSync';
import { isValidUuidV4 } from './supersetPair';
import type {
  ExerciseCompletion,
  ExerciseTarget,
  DropStageTarget,
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
  PlanCardio,
  SessionOrigin,
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
    const counts = groupPlanForTarget(t).map((g) => g.stageCount);
    const uniform = counts.every((n) => n === counts[0]);
    const structure = uniform
      ? `${t.rounds} 轮 × ${t.stages.length} 阶段`
      : `${t.rounds} 轮 · 每轮阶段 ${counts.join('/')}`;
    return `${structure}${t.form === 'superset' ? '超级组' : '递减'}`;
  }
  const sets = t.setsMax > t.sets ? `${t.sets}–${t.setsMax}` : `${t.sets}`;
  return `${sets} 组 × ${t.repsMin}–${t.repsMax} 次`;
}

export function weightModeLabel(ex: PlanExercise): string | null {
  const t = ex.target;
  if (t.kind !== 'straight') {
    if (t.dumbbellBasis === 'per_hand') return '哑铃 · 按单只计';
    if (t.dumbbellBasis === 'total') return '哑铃 · 按合计计';
    return null;
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

function blankSet(
  roundIndex: number,
  stageIndex: number,
  toFailure = false,
  stageId?: string,
): SessionSet {
  return {
    id: newId('set'),
    roundIndex,
    stageIndex,
    ...(stageId ? { stageId } : {}),
    reps: null,
    weightKg: null,
    status: 'blank',
    ...(toFailure ? { toFailure: true } : {}),
  };
}

/** 由目标推导组结构（普通组每组件 1 阶段；递减组/超级组每轮 = 阶段数） */
export function groupsFromTarget(t: ExerciseTarget): GroupPlan[] {
  return groupPlanForTarget(t);
}

/** 为动作生成与组结构匹配的空记录（每组件/阶段独立力竭标记；仅写真实 id，不给旧数据造 ID） */
function initialSetsFor(ex: PlanExercise, groups: GroupPlan[]): SessionSet[] {
  const t = ex.target;
  const sets: SessionSet[] = [];
  for (const g of groups) {
    for (let si = 1; si <= g.stageCount; si++) {
      const resolved = resolveGroupConfig(t, g.index, si);
      // 旧数据只写真实持久化的 id，不在开始训练时给旧计划/旧历史“造身份”；
      // 缺失身份在运行时由 resolveMissingStageIdsFromConfig / 统一解析按
      // “可证明同源”口径确定性补齐，不会被随机分裂或按位置硬配。
      sets.push(blankSet(g.index, si, resolved.toFailure, resolved.stageId ?? undefined));
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
    ...(ex.setupNote ? { setupNote: ex.setupNote } : {}),
    ...(isValidUuidV4(ex.pairId) ? { pairId: ex.pairId.trim().toLowerCase() } : {}),
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
  const sessionId = newId('sess');
  if (isStrength) {
    registerSessionPlanBaseline(sessionId, day.exercises);
  }

  return {
    id: sessionId,
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
  // W02：训练页不再因旧 bodyweight 隐藏重量输入；所有力量动作均显示重量（kg）。
  void ex;
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

/* ── R01：未完成轮沿用上一完整轮（多阶段：超级组/递减组）────────── */

/** 「未完成轮沿用上一完整轮」的结果（R01） */
export interface InheritPrevRoundOutcome {
  session: Session;
  /** 实际补写的字段数（reps / weightKg 各算一个） */
  filledFields: number;
  /** 至少补写了一个字段的 set 数 */
  filledSets: number;
  /** 因「之前没有完整已完成轮」而未能沿用的目标轮号 */
  noSourceRounds: number[];
  /** 因「阶段结构无法可靠对应」而整轮跳过的目标轮号 */
  mismatchRounds: number[];
  /** R02：逐轮配置下按稳定身份仍无来源、保持空白的阶段数 */
  unmatchedStages: number;
}

/**
 * 对**已经由旧 addSetTo 产生的缺失 stageId 轮**做确定性兼容解析（R02a）。
 *
 * 仅当某轮满足全部条件才补：
 * 1. 该轮 GroupPlan.stageCount 与 target 当前轮配置的阶段数一致；
 * 2. 配置中每个阶段都有非空且轮内唯一的 id；
 * 3. 该轮现有行的 stageIndex 恰好覆盖 1..stageCount 且无重复；
 * 4. 已存在的 stageId（若有）必须与配置给出的 id 一致（不允许“部分串轮”）。
 *
 * 不能证明唯一对应（配置阶段数不同 / id 缺失或重复 / 行残缺）→ 该轮保持原样，
 * 绝不按位置硬配不同动作或不同结构的阶段。返回新对象，不修改入参。
 */
export function resolveMissingStageIdsFromConfig(ex: SessionExercise): { exercise: SessionExercise; changedRounds: number[] } {
  if (ex.target.kind !== 'dropSet') return { exercise: ex, changedRounds: [] };
  const changedRounds: number[] = [];
  const updatedById = new Map<string, SessionSet>();
  for (const g of ex.groups) {
    const sets = dropRoundSets(ex, g.index);
    if (!stageRowsComplete(sets, g.stageCount)) continue;
    // 只处理「整轮都没有 stageId」的旧 addSetTo 产物；
    // 部分有、部分无的混合轮不解析，保持原有严格跳过语义（绝不猜）。
    if (sets.some((s) => Boolean(s.stageId))) continue;
    const resolution = resolveStageIdsFromConfigForRound(ex.target, g.index, g.stageCount);
    if (!resolution.ok) continue;
    changedRounds.push(g.index);
    for (const s of sets) {
      updatedById.set(s.id, { ...s, stageId: resolution.byIndex.get(s.stageIndex)! });
    }
  }
  if (!updatedById.size) return { exercise: ex, changedRounds: [] };
  return {
    exercise: { ...ex, sets: ex.sets.map((s) => updatedById.get(s.id) ?? s) },
    changedRounds,
  };
}

/**
 * 目标/来源某轮的行是否**完整且位置唯一**：行数 = requiredStages，stageIndex 恰好覆盖 1..required 各一次。
 * 缺阶段（残行）或重复位置都不可靠 —— 不能凭空补阶段，也不能把残行硬配。
 */
function stageRowsComplete(sets: SessionSet[], required: number): boolean {
  if (required <= 0 || sets.length !== required) return false;
  const seen = new Set<number>();
  for (const s of sets) {
    if (s.stageIndex < 1 || s.stageIndex > required) return false;
    if (seen.has(s.stageIndex)) return false;
    seen.add(s.stageIndex);
  }
  return seen.size === required;
}

/**
 * 逐阶段建立「目标阶段 → 来源阶段」的可靠映射（R01）。
 *
 * <p>只有两种形态被认为**可靠**：
 * <ul>
 *   <li>两侧都带稳定 `stageId`：必须**各自唯一**（无重复），按 stageId 一一对应；</li>
 *   <li>两侧都没有稳定 ID（旧数据）：按 `stageIndex` 位置一一对应。</li>
 * </ul>
 * 其余情况（任一侧「混合」——部分阶段有 ID 部分没有；或单侧有 ID、单侧无 ID）
 * 都视为**不可靠**，返回 null → 调用方整轮 skip，绝不硬配。
 *
 * @return 逐阶段配对；不可靠/缺对应 → null（整轮不可可靠对应）
 */
function mapTargetStagesToSource(
  targetSets: SessionSet[],
  sourceSets: SessionSet[],
  opts: { allowPartialById?: boolean } = {},
): { pairs: Array<[SessionSet, SessionSet]>; unmatchedTargets: number } | null {
  if (targetSets.length === 0 || sourceSets.length === 0) return null;
  const tgtWithId = targetSets.filter((s) => Boolean(s.stageId)).length;
  const srcWithId = sourceSets.filter((s) => Boolean(s.stageId)).length;
  const tgtAllIds = tgtWithId === targetSets.length;
  const srcAllIds = srcWithId === sourceSets.length;
  const tgtNoIds = tgtWithId === 0;
  const srcNoIds = srcWithId === 0;

  const byStageId = tgtAllIds && srcAllIds;
  const byStageIndex = tgtNoIds && srcNoIds;
  if (!byStageId && !byStageIndex) return null; // 混合 ID / 单侧有 ID → 不可靠

  if (byStageId) {
    const srcIds = sourceSets.map((s) => s.stageId as string);
    const tgtIds = targetSets.map((s) => s.stageId as string);
    // 稳定 ID 必须唯一；重复（如 a,a,c）会让 find 产生歧义配对 → 整轮 skip
    if (new Set(srcIds).size !== srcIds.length) return null;
    if (new Set(tgtIds).size !== tgtIds.length) return null;
    const pairs: Array<[SessionSet, SessionSet]> = [];
    let unmatchedTargets = 0;
    for (const tgt of targetSets) {
      const match = sourceSets.find((s) => s.stageId === tgt.stageId);
      if (!match) {
        // R02：只有“逐轮配置”启用时才允许部分对应：稳定身份明确对应的阶段沿用，
        // 无对应阶段保持空白；旧 R01（无逐轮配置）仍整轮 skip，保持旧语义。
        if (!opts.allowPartialById) return null;
        unmatchedTargets += 1;
        continue;
      }
      pairs.push([tgt, match]);
    }
    if (!pairs.length) return null;
    return { pairs, unmatchedTargets };
  }

  // 旧数据：按 stageIndex 位置唯一对应；阶段数不一致不能按位置硬配
  if (targetSets.length !== sourceSets.length) return null;
  const srcIdx = sourceSets.map((s) => s.stageIndex);
  const tgtIdx = targetSets.map((s) => s.stageIndex);
  if (new Set(srcIdx).size !== srcIdx.length) return null;
  if (new Set(tgtIdx).size !== tgtIdx.length) return null;
  const pairs: Array<[SessionSet, SessionSet]> = [];
  for (const tgt of targetSets) {
    const match = sourceSets.find((s) => s.stageIndex === tgt.stageIndex);
    if (!match) return null;
    pairs.push([tgt, match]);
  }
  return { pairs, unmatchedTargets: 0 };
}

/**
 * 单个多阶段动作：把「未完成且未跳过」的目标轮，按阶段沿用**它之前最近的、
 * 非跳过的完整已完成轮**的实际 reps / weightKg（R01，规则：只补空白、保留已填）。
 *
 * 关键边界（与「普通组沿用」语义刻意不同）：
 * <ul>
 *   <li>只处理 `kind: 'dropSet'`（超级组/递减组共用）；普通组一律不碰。</li>
 *   <li>来源轮必须是完整、**且未被跳过**的已完成轮；跳过轮即便有残留 done 行也不作来源。</li>
 *   <li>目标/来源的 `requiredStages` 必须一致，且阶段行完整、位置唯一；缺阶段/重复位置 → 整轮 skip。</li>
 *   <li>逐阶段对应复制，**不**把最后一阶段的值套到全部阶段。</li>
 *   <li>每字段**只在 null 时补**：0 是有效值；已填 reps/weight 一律保留。</li>
 *   <li>**已完成（status=done）的阶段整条不动**，即使它还有 null 的 weight 也不补。</li>
 *   <li>不改 status/note/toFailure/结构/ID/顺序，不动已完成轮与跳过轮，不启动/结束计时。</li>
 * </ul>
 */
export function inheritPreviousCompleteRoundForExercise(ex: SessionExercise): {
  exercise: SessionExercise;
  filledFields: number;
  filledSets: number;
  noSourceRounds: number[];
  mismatchRounds: number[];
  unmatchedStages: number;
} {
  // 只对多阶段（超级组/递减组）生效；普通组语义不动
  if (ex.target.kind !== 'dropSet') {
    return { exercise: ex, filledFields: 0, filledSets: 0, noSourceRounds: [], mismatchRounds: [], unmatchedStages: 0 };
  }
  // R02a legacy 兼容：旧 addSetTo 生成的缺失 stageId 轮，只在配置可唯一证明时补齐；
  // 不补也继续按原有严格规则处理（会进入 mismatch，不会硬配）。
  ex = resolveMissingStageIdsFromConfig(ex).exercise;
  const rounds = roundsOf(ex).slice().sort((a, b) => a - b);
  const updatedById = new Map<string, SessionSet>();
  const noSourceRounds: number[] = [];
  const mismatchRounds: number[] = [];
  let filledFields = 0;
  let unmatchedStages = 0;

  for (let ri = 0; ri < rounds.length; ri++) {
    const r = rounds[ri];
    if (dropRoundComplete(ex, r)) continue; // 已完成轮不改
    if (isGroupSkipped(ex, r)) continue; // 跳过轮不改
    const required = requiredStages(ex, r);
    const tgtSets = dropRoundSets(ex, r);
    // 目标轮阶段行必须完整且位置唯一；残行（缺阶段）不能硬配、也不能凭空补
    if (!stageRowsComplete(tgtSets, required)) {
      mismatchRounds.push(r);
      continue;
    }
    // 找「之前最近的、非跳过的完整已完成轮」作为唯一来源
    let sourceRound: number | undefined;
    for (let i = ri - 1; i >= 0; i--) {
      const rr = rounds[i];
      if (isGroupSkipped(ex, rr)) continue; // 跳过轮不得作来源（即便有残留 done 行）
      if (dropRoundComplete(ex, rr)) {
        sourceRound = rr;
        break;
      }
    }
    if (sourceRound === undefined) {
      noSourceRounds.push(r);
      continue;
    }
    const srcRequired = requiredStages(ex, sourceRound);
    const srcSets = dropRoundSets(ex, sourceRound);
    // 来源轮必须阶段行完整、位置唯一；R02 逐轮配置允许跨不同阶段数按稳定 ID 部分对应。
    if (!stageRowsComplete(srcSets, srcRequired)) {
      mismatchRounds.push(r);
      continue;
    }
    const allowPartialById = Boolean(ex.target.kind === 'dropSet' && ex.target.roundConfigs?.length);
    if (srcRequired !== required && !allowPartialById) {
      mismatchRounds.push(r);
      continue;
    }
    const mapped = mapTargetStagesToSource(tgtSets, srcSets, { allowPartialById });
    if (!mapped) {
      mismatchRounds.push(r);
      continue;
    }
    unmatchedStages += mapped.unmatchedTargets;
    for (const [tgt, src] of mapped.pairs) {
      if (tgt.status === 'done') continue; // 已完成阶段整条不动
      let reps = tgt.reps;
      let weightKg = tgt.weightKg;
      let changed = false;
      // 只补 null：0 是有效值，已填一律保留
      if (reps === null && src.reps !== null) {
        reps = src.reps;
        changed = true;
        filledFields++;
      }
      if (weightKg === null && src.weightKg !== null) {
        weightKg = src.weightKg;
        changed = true;
        filledFields++;
      }
      if (changed) updatedById.set(tgt.id, { ...tgt, reps, weightKg });
    }
  }

  const filledSets = updatedById.size;
  if (filledSets === 0) {
    return { exercise: ex, filledFields, filledSets: 0, noSourceRounds, mismatchRounds, unmatchedStages };
  }
  const sets = ex.sets.map((s) => updatedById.get(s.id) ?? s);
  return { exercise: { ...ex, sets }, filledFields, filledSets, noSourceRounds, mismatchRounds, unmatchedStages };
}

/** 会话级：对指定动作执行「未完成轮沿用上一完整轮」（R01，纯函数，返回新会话） */
export function inheritPreviousCompleteRound(
  session: Session,
  exId: string,
): InheritPrevRoundOutcome {
  const ex = session.exercises.find((e) => e.id === exId);
  if (!ex) {
    return { session, filledFields: 0, filledSets: 0, noSourceRounds: [], mismatchRounds: [], unmatchedStages: 0 };
  }
  const out = inheritPreviousCompleteRoundForExercise(ex);
  if (out.filledSets === 0) {
    return {
      session,
      filledFields: 0,
      filledSets: 0,
      noSourceRounds: out.noSourceRounds,
      mismatchRounds: out.mismatchRounds,
      unmatchedStages: out.unmatchedStages,
    };
  }
  return {
    session: {
      ...session,
      exercises: session.exercises.map((e) => (e.id === exId ? out.exercise : e)),
    },
    filledFields: out.filledFields,
    filledSets: out.filledSets,
    noSourceRounds: out.noSourceRounds,
    mismatchRounds: out.mismatchRounds,
    unmatchedStages: out.unmatchedStages,
  };
}

export interface InheritStraightValuesOutcome {
  session: Session;
  hasAnySource: boolean;
  filledFields: number;
  filledSets: number;
  changedSetIds: string[];
  touchedFieldIds: string[];
}

const hasWeightKg = (s: SessionSet): boolean =>
  typeof s.weightKg === 'number' && Number.isFinite(s.weightKg);

/**
 * 常规组「未完成的组沿用已填数值」纯函数。
 * 优先级（跳过组一律不作来源也不被改写）：
 * · 次数来源：最近一个已完成且已填次数的组 → 最近一个已填次数的组；
 * · 重量来源：最近一个已完成且已填重量的组 → 最近一个已填次数且已填重量的组 → 最近一个已填重量的组。
 * · 仅补齐未完成组（status !== 'done'）中仍为 null 的字段，保留已有非空输入与先填数值，绝不改写组状态。
 */
export function inheritStraightSetValues(
  session: Session,
  exId: string,
): InheritStraightValuesOutcome {
  const ex = session.exercises.find((e) => e.id === exId);
  if (!ex) {
    return {
      session,
      hasAnySource: false,
      filledFields: 0,
      filledSets: 0,
      changedSetIds: [],
      touchedFieldIds: [],
    };
  }
  const skippedRounds = new Set(ex.groups.filter((g) => g.skipped).map((g) => g.index));
  const activeSets = ex.sets
    .filter((s) => !skippedRounds.has(s.roundIndex))
    .sort((a, b) => a.roundIndex - b.roundIndex || a.stageIndex - b.stageIndex);

  const reverseSets = [...activeSets].reverse();
  const repsSource =
    reverseSets.find((s) => s.status === 'done' && hasReps(s)) ??
    reverseSets.find((s) => hasReps(s));

  const withWeight = needsWeight(ex);
  const weightSource = withWeight
    ? reverseSets.find((s) => s.status === 'done' && hasWeightKg(s)) ??
      reverseSets.find((s) => hasReps(s) && hasWeightKg(s)) ??
      reverseSets.find((s) => hasWeightKg(s))
    : undefined;

  const sourceReps = repsSource?.reps ?? null;
  const sourceWeight = withWeight ? (weightSource?.weightKg ?? null) : null;
  const hasAnySource = sourceReps !== null || sourceWeight !== null;
  if (!hasAnySource) {
    return {
      session,
      hasAnySource: false,
      filledFields: 0,
      filledSets: 0,
      changedSetIds: [],
      touchedFieldIds: [],
    };
  }

  const updatedById = new Map<string, SessionSet>();
  const changedSetIds: string[] = [];
  const touchedFieldIds: string[] = [];
  let filledFields = 0;

  for (const tgt of activeSets) {
    if (tgt.status === 'done') continue;
    let reps = tgt.reps;
    let weightKg = tgt.weightKg;
    let changed = false;

    if (reps === null && sourceReps !== null) {
      reps = sourceReps;
      changed = true;
      filledFields += 1;
      touchedFieldIds.push(`${tgt.id}:reps`);
    }
    if (withWeight && weightKg === null && sourceWeight !== null) {
      weightKg = sourceWeight;
      changed = true;
      filledFields += 1;
      touchedFieldIds.push(`${tgt.id}:weight`);
    }
    if (changed) {
      updatedById.set(tgt.id, { ...tgt, reps, weightKg });
      changedSetIds.push(tgt.id);
    }
  }

  if (!updatedById.size) {
    return {
      session,
      hasAnySource: true,
      filledFields: 0,
      filledSets: 0,
      changedSetIds: [],
      touchedFieldIds: [],
    };
  }

  const sets = ex.sets.map((s) => updatedById.get(s.id) ?? s);
  return {
    session: {
      ...session,
      exercises: session.exercises.map((e) => (e.id === exId ? { ...e, sets } : e)),
    },
    hasAnySource: true,
    filledFields,
    filledSets: updatedById.size,
    changedSetIds,
    touchedFieldIds,
  };
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
 * · 递减组：该 set 是本轮最后一个必需阶段 → target.restAfterSec；否则 → 该轮阶段短歇
 * · 普通组 → ex.restSec
 * 只读本次训练快照（ex.target / ex.restSec），不读计划当前值，也不硬编码。
 */
export function restAfterSet(ex: SessionExercise, set: SessionSet): number {
  const t = ex.target;
  if (t.kind !== 'dropSet') return ex.restSec;
  /**
   * G2A 兼容回归：末阶段判定必须用**本组 GroupPlan.stageCount 快照**
   * （requiredStages），不能用 target.stages.length。
   * 合法旧数据可能有 target 3 阶段、但某组快照只要求 2 阶段：
   * 该组第 2 阶段就是组尾，应取整轮休息，而不是阶段短间歇。
   */
  const need = requiredStages(ex, set.roundIndex);
  if (set.stageIndex >= need) return t.restAfterSec;
  const stages = roundStagesOf(t, set.roundIndex);
  return stages[set.stageIndex - 1]?.restAfterSec ?? roundRestInSecOf(t, set.roundIndex);
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
  let completedStages = 0;
  let plannedStages = 0;
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
      const stagesInRound = requiredStages(ex, r);
      plannedStages += stagesInRound;
      if (isGroupSkipped(ex, r)) {
        // 跳过的组：只有确实没有任何记录时才算「跳过」
        if (groupHasNoRecords(ex, r)) skippedGroups++;
        else if (dropRoundComplete(ex, r)) {
          completedSets++;
          completedStages += stagesInRound;
        } else partialGroups++;
        continue;
      }
      if (dropRoundComplete(ex, r)) {
        completedSets++;
        completedStages += stagesInRound;
      } else if (dropRoundPartial(ex, r)) partialGroups++;
    }

    // 缺数据的组（点了完成却没填次数）单独统计
    for (const set of ex.sets) {
      if (isSetIncomplete(set)) incompleteSets++;
    }
  }

  return {
    completedSets,
    completedStages,
    incompleteSets,
    partialGroups,
    // R03.3：分母用开始时的快照，替换/加组不会把 20 改成 22
    targetSets: session.targetSetsAtStart ?? targetSets,
    plannedSets,
    plannedStages,
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

function findPrefillFollowingSetIds(
  ex: SessionExercise,
  setId: string,
  nextWeight: number | null | undefined,
  hasLocalWeightDraft?: (otherSetId: string) => boolean,
): Set<string> {
  const ids = new Set<string>();
  if (typeof nextWeight !== 'number' || !Number.isFinite(nextWeight) || nextWeight <= 0) {
    return ids;
  }
  const targetBefore = ex.sets.find((s) => s.id === setId);
  if (!targetBefore || targetBefore.roundIndex !== 1) {
    return ids;
  }
  const skippedRounds = new Set(ex.groups.filter((g) => g.skipped).map((g) => g.index));
  const prevFirstWeight = targetBefore.weightKg;
  const stageIdx = targetBefore.stageIndex;
  for (const s of ex.sets) {
    if (s.id === setId) continue;
    if (s.roundIndex <= 1 || s.stageIndex !== stageIdx) continue;
    if (skippedRounds.has(s.roundIndex)) continue;
    if (s.status !== 'blank' || hasReps(s)) continue;
    if (hasLocalWeightDraft?.(s.id)) continue;
    if (s.weightKg !== null && s.weightKg !== prevFirstWeight) continue;
    ids.add(s.id);
  }
  return ids;
}

/** 收集首组写入正重量后将被自动预填的后续组重量字段 ID（用于清理陈旧空白草稿）。 */
export function collectPrefillWeightFieldIds(
  ex: SessionExercise | undefined,
  setId: string,
  nextWeight: number | null | undefined,
  includeSelf: boolean,
  hasLocalWeightDraft?: (otherSetId: string) => boolean,
): string[] {
  const out = includeSelf ? [`${setId}:weight`] : [];
  if (!ex) return out;
  for (const id of findPrefillFollowingSetIds(ex, setId, nextWeight, hasLocalWeightDraft)) {
    out.push(`${id}:weight`);
  }
  return out;
}

/**
 * 训练中首组 / 第 1 轮填写正重量时自动预填后续同阶段空白组（0.1.18）。
 * · 仅当修改对象位于 `roundIndex === 1` 且 `patch.weightKg > 0` 时触发（0 kg 显式自重绝不污染后续空白组）；
 * · 仅同步到同动作中 `roundIndex > 1`、同 `stageIndex`、未跳过、`status === 'blank'` 且 `reps === null`、
 *   且尚未被单独改成其它重量（`s.weightKg === null || s.weightKg === prevFirstWeight`）的组；
 * · 修改第 2/3 轮（组）时只改该组自身，绝不反向或向后覆盖。
 */
export function withSetAndPrefillFollowingWeight(
  session: Session,
  exId: string,
  setId: string,
  patch: Partial<SessionSet>,
  hasLocalWeightDraft?: (otherSetId: string) => boolean,
): Session {
  const updated = withSet(session, exId, setId, patch);
  const prevEx = session.exercises.find((e) => e.id === exId);
  if (!prevEx) return updated;
  const followIds = findPrefillFollowingSetIds(prevEx, setId, patch.weightKg, hasLocalWeightDraft);
  if (!followIds.size) return updated;
  const nextWeight = patch.weightKg as number;

  return {
    ...updated,
    exercises: updated.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const sets = ex.sets.map((s) => (followIds.has(s.id) ? { ...s, weightKg: nextWeight } : s));
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

export function markExerciseDone(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => (ex.id === exId ? { ...ex, status: 'done' as const } : ex)),
  };
}

/**
 * 新增一组/一轮的容量阻断（R02 FIX3）。
 *
 * 领域层必须先于 UI 阻止非法增长，绝不能“先写坏、导出/备份时再失败”：
 * · 多阶段动作的轮数上限 MAX_ROUNDS（20）；
 * · 单动作总行数上限 MAX_SET_ROWS（200，按各轮真实 stageCount 求和）。
 * 普通组保持既有语义（不在此改变），其它门禁不变。
 */
export interface AddSetBlock {
  kind: 'rounds' | 'rows';
  message: string;
}

export function addSetBlocker(ex: SessionExercise): AddSetBlock | null {
  if (ex.target.kind !== 'dropSet') return null;
  const maxRound = ex.groups.reduce((m, g) => Math.max(m, g.index), 0);
  const newRound = maxRound + 1;
  if (newRound > MAX_ROUNDS) {
    return {
      kind: 'rounds',
      message: `已达 ${MAX_ROUNDS} 轮上限，不能再加一轮。`,
    };
  }
  const prevGroup = ex.groups.find((g) => g.index === maxRound);
  const fallbackSc = groupPlanForTarget(ex.target).reduce((m, g) => Math.max(m, g.stageCount), 0);
  const stageCount = Math.max(1, prevGroup?.stageCount ?? fallbackSc ?? 1);
  const currentRows = ex.groups.reduce((n, g) => n + Math.max(1, g.stageCount), 0);
  const nextRows = currentRows + stageCount;
  if (nextRows > MAX_SET_ROWS) {
    return {
      kind: 'rows',
      message: `再加一轮会生成 ${nextRows} 行，超过单动作上限 ${MAX_SET_ROWS} 行（当前 ${currentRows} 行）。`,
    };
  }
  return null;
}

/**
 * 在当前动作末尾新增一组/一轮（R02a）。
 *
 * 用户规则：新增轮必须继承**紧邻上一轮**的小组数量、阶段配置与身份；
 * 实际 reps/weightKg 一律 null、status blank、生成全新 set.id，
 * **绝不复制** done/skipped/actual/note 等运行态。
 * 第一轮/旧数据无可靠来源时兼容回退到目标配置；普通组保持原语义（1 阶段）。
 *
 * R02 FIX2（F1）：新增轮的生效配置必须**物化**到 `target.roundConfigs`
 * （roundIndex = 新轮），否则 `roundStagesOf` 会回退到默认 stages / 更早的
 * override，跨训练页、重新打开编辑器、模板/备份都会丢失“紧邻上一轮”的配置。
 * 物化后的 target.rounds 同步覆盖到新轮，保证配置是合法、可导出的纯配置。
 */
export function addSetTo(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      // 领域层硬门禁：超轮数/超行数直接拒绝增长（返回原动作，不产生半套数据）。
      if (addSetBlocker(ex)) return ex;
      // 旧 addSetTo 可能留下缺失 stageId 的轮；先做可证明的确定性解析，
      // 让“上一轮”的身份来源可靠（不可证明的轮保持原样，不硬配）。
      const base = resolveMissingStageIdsFromConfig(ex).exercise;
      const maxRound = base.groups.reduce((m, g) => Math.max(m, g.index), 0);
      const prevRound = maxRound > 0 ? maxRound : 1;
      const prevGroup = base.groups.find((g) => g.index === prevRound);
      const fallbackGroup = groupPlanForTarget(base.target)[Math.max(0, prevRound - 1)];
      const stageCount = Math.max(1, prevGroup?.stageCount ?? fallbackGroup?.stageCount ?? 1);
      const prevSets = dropRoundSets(base, prevRound);
      const newRound = maxRound + 1;
      // 上一轮的真实生效阶段配置（逐轮 override → 默认 stages 的统一解析）。
      const prevStages = base.target.kind === 'dropSet' ? roundStagesOf(base.target, prevRound) : [];
      const prevIdentities = base.target.kind === 'dropSet' ? resolveRoundStageIdentities(base.target, prevRound) : [];
      const newStages: DropStageTarget[] = Array.from({ length: stageCount }, (_, i) => {
        const stageIndex = i + 1;
        const prevSet = prevSets.find((s) => s.stageIndex === stageIndex);
        const source = prevStages[stageIndex - 1];
        const copy: DropStageTarget = source
          ? (structuredClone(source) as DropStageTarget)
          : {
              label: `第 ${stageIndex} 阶段`,
              weightKg: null,
              repsMin: null,
              repsMax: null,
              toFailure: false,
              targetText: '',
            };
        // 身份优先取上一轮真实 set.stageId；旧数据行里没有时取统一解析出的
        // 上一轮身份（含旧数据 stage-pos-N / 可证明的 override 同源身份）；
        // 新轮继承上一轮身份，保证“加一轮后沿用上一轮”按阶段精确对应。
        if (prevSet?.stageId) copy.id = prevSet.stageId;
        else if (prevIdentities[stageIndex - 1]?.id) copy.id = prevIdentities[stageIndex - 1].id;
        if (prevSet?.toFailure !== undefined) copy.toFailure = prevSet.toFailure;
        return copy;
      });
      let target = base.target;
      if (base.target.kind === 'dropSet') {
        const clone = structuredClone(base.target);
        const prevOverride = clone.roundConfigs?.find((r) => r.roundIndex === prevRound);
        const entry = {
          roundIndex: newRound,
          stages: newStages,
          // 上一轮的轮级短歇若为显式覆盖，新轮一并继承；否则沿用 target.restInSec。
          ...(prevOverride?.restInSec !== undefined ? { restInSec: prevOverride.restInSec } : {}),
        };
        clone.roundConfigs = [...(clone.roundConfigs ?? []).filter((r) => r.roundIndex !== newRound), entry].sort(
          (a, b) => a.roundIndex - b.roundIndex,
        );
        clone.rounds = Math.max(clone.rounds, newRound);
        target = clone;
      }
      const groups = [...base.groups, { index: newRound, stageCount }];
      const sets = [
        ...base.sets,
        ...Array.from({ length: stageCount }, (_, i) => {
          const stageIndex = i + 1;
          const resolved = resolveGroupConfig(target, newRound, stageIndex);
          const stageId = resolved.stageId ?? newStages[stageIndex - 1]?.id ?? undefined;
          return blankSet(newRound, stageIndex, resolved.toFailure, stageId);
        }),
      ];
      return { ...base, target, groups, sets };
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
      // 递减组/超级组按整轮删除；普通组删单组（保持既有语义）。
      const isDrop = ex.target.kind === 'dropSet';
      if (isDrop && ex.groups.length <= 1) return ex;
      const dropIds = isDrop
        ? new Set(ex.sets.filter((s) => s.roundIndex === target.roundIndex).map((s) => s.id))
        : new Set([target.id]);
      const groups = ex.groups.filter((g) => g.index !== target.roundIndex);
      // 重排组序号，保持连续
      const reindexed = groups.map((g, i) => ({ ...g, index: i + 1 }));
      const remap = new Map(groups.map((g, i) => [g.index, i + 1]));
      const sets = ex.sets
        .filter((s) => !dropIds.has(s.id))
        .map((s) => ({ ...s, roundIndex: remap.get(s.roundIndex) ?? s.roundIndex }));
      if (!isDrop) return { ...ex, groups: reindexed, sets };
      // R02 FIX3：删中间整轮后 groups/sets 已重排，target.rounds 与逐轮配置
      // 必须按同一 remap 跟随，不能简单 filter(index <= 新长度) 丢掉别的轮配置。
      const clone = structuredClone(ex.target) as Extract<ExerciseTarget, { kind: 'dropSet' }>;
      const nextConfigs = (clone.roundConfigs ?? [])
        .flatMap((rc) => {
          const nextIndex = remap.get(rc.roundIndex);
          return nextIndex === undefined ? [] : [{ ...rc, roundIndex: nextIndex }];
        })
        .sort((a, b) => a.roundIndex - b.roundIndex);
      clone.rounds = Math.max(1, Math.min(MAX_ROUNDS, reindexed.length));
      if (nextConfigs.length) clone.roundConfigs = nextConfigs;
      else delete clone.roundConfigs;
      return { ...ex, groups: reindexed, sets, target: clone };
    }),
  };
}

/**
 * 删除递减组的整轮（审计任务 K-9：删已记录轮前需确认，UI 负责）。
 * 直练动作等价于删最后一组。
 *
 * R02 FIX3：与 addSetTo 对称，必须同步清理 target.rounds 与已删除轮的
 * roundConfigs，否则训练卡轮数与提取模板会保留幽灵轮。
 */
export function removeLastRound(session: Session, exId: string): Session {
  return {
    ...session,
    exercises: session.exercises.map((ex) => {
      if (ex.id !== exId) return ex;
      const rounds = roundsOf(ex);
      if (rounds.length <= 1) return ex;
      const last = rounds[rounds.length - 1];
      const groups = ex.groups.filter((g) => g.index !== last);
      const sets = ex.sets.filter((s) => s.roundIndex !== last);
      if (ex.target.kind !== 'dropSet') {
        return { ...ex, groups, sets };
      }
      const clone = structuredClone(ex.target) as Extract<ExerciseTarget, { kind: 'dropSet' }>;
      const nextConfigs = (clone.roundConfigs ?? []).filter((rc) => rc.roundIndex !== last);
      const maxGroup = groups.reduce((m, g) => Math.max(m, g.index), 0);
      clone.rounds = Math.max(1, Math.min(MAX_ROUNDS, maxGroup || clone.rounds - 1));
      clone.roundConfigs = nextConfigs.filter((rc) => rc.roundIndex <= clone.rounds);
      if (!clone.roundConfigs.length) delete clone.roundConfigs;
      return { ...ex, groups, sets, target: clone };
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
  /** 删除影响原因（UI 预览/确认时展示；有记录时确认后可删除，不是永久禁止） */
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

/* ── G1：把新配置应用到「当前训练」的某个动作 ───────────────
   这是 G2 统一编辑器的领域入口：
   · 只改本次 session 快照，不写计划、不改历史、不动循环游标；
   · actual 与 SessionSet.id 保留；
   · 删除已输入组/阶段必须先拿到 impact 确认（confirmImpact），不静默丢记录；
   · 绝不调用旧自动拆卡逻辑。 */

export interface ApplyTargetToSessionResult {
  session: Session;
  applied: boolean;
  impact: TargetApplyImpact;
  message: string;
}

export function applyTargetToSessionExercise(
  session: Session,
  exId: string,
  nextTarget: ExerciseTarget,
  opts: { confirmImpact?: boolean } = {},
): ApplyTargetToSessionResult {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) {
    return {
      session,
      applied: false,
      impact: {
        formBefore: 'straight',
        formAfter: 'straight',
        groupCountBefore: 0,
        groupCountAfter: 0,
        stageCountBefore: 1,
        stageCountAfter: 1,
        roundStageCountsBefore: [],
        roundStageCountsAfter: [],
        weightModeBefore: 'external',
        weightModeAfter: 'external',
        dumbbellBasisBefore: 'total',
        dumbbellBasisAfter: 'total',
        removedWithData: [],
        removedBlankCount: 0,
        addedBlankCount: 0,
        needsConfirmation: false,
        messages: ['找不到这个动作'],
        validationIssues: [],
      },
      message: '找不到这个动作',
    };
  }
  const old = session.exercises[idx];
  const r = applyTargetToExercise(old, nextTarget, { confirmImpact: opts.confirmImpact });
  if (!r.applied) {
    return {
      session,
      applied: false,
      impact: r.impact,
      message: r.impact.messages.join('；') || '配置未应用',
    };
  }
  const exercises = [...session.exercises];
  exercises[idx] = r.exercise;
  return {
    session: { ...session, exercises },
    applied: true,
    impact: r.impact,
    message:
      r.impact.messages.length > 0
        ? `「${old.name}」配置已更新（${r.impact.messages.join('；')}）`
        : `「${old.name}」配置已更新，实际记录保持不变`,
  };
}
