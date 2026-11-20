/* 计量口径的查询侧实现（V3-05）。
   问题背景（独立审查 F-COMPARABILITY）：
   `identity.ts` 里 `comparabilityKey` 早就定义了，但 stats 与「上次表现」都没调用，
   所以负重双杠 +20kg 和辅助双杠 70kg 落进同一条曲线，最大重量被算成 70kg。

   这组函数的职责：把「动作身份」和「怎么称重」这两件事同时用于查询。
   · exerciseId 回答「是不是同一个动作」（跨计划、跨 A/B 稳定）；
   · 计量口径（weightMode + dumbbellBasis）回答「这些数字能不能放一起比」。
   两者都相同的记录才进入同一条可比历史。 */

import type { ExerciseTarget, Session, SessionExercise, SessionSet, WeightMode, DumbbellBasis } from './types';
import { comparabilityKey, comparabilityLabel, WEIGHT_MODE_LABEL } from './identity';
import { roundStagesOf } from './exerciseConfig';
import { collectSingleMovementIds, filterComparableSetsForExercise } from './supersetPair';

/** 从任意 session 动作取出它的计量口径 */
export function modeOf(ex: SessionExercise): { weightMode: WeightMode; dumbbellBasis: DumbbellBasis } {
  const t = ex.target;
  return {
    weightMode: t.weightMode,
    // 未声明时按「合计」解释：这是 v1/v2 历史里隐含的口径
    dumbbellBasis: t.dumbbellBasis ?? 'total',
  };
}

/** 该动作在本次训练里的可比标识 */
export function comparabilityOf(ex: SessionExercise): string {
  const { weightMode, dumbbellBasis } = modeOf(ex);
  return comparabilityKey(ex.exerciseId ?? ex.name, {
    kind: ex.target.kind,
    weightMode,
    dumbbellBasis,
  });
}

/** 面向用户的一句话口径说明（如「外部负重 · 哑铃按单只」） */
export function describeMode(ex: SessionExercise): string | null {
  return comparabilityLabel(ex.target as ExerciseTarget) ?? WEIGHT_MODE_LABEL[modeOf(ex).weightMode] ?? null;
}

export interface ComparableHistoryEntry {
  sessionId: string;
  at: number;
  dayName: string;
  exerciseName: string;
  weightMode: WeightMode;
  dumbbellBasis: DumbbellBasis;
  /** 实际完成的组（普通组=组；递减组=阶段行，同时保留轮/阶段归属） */
  sets: Array<{
    reps: number | null;
    weightKg: number | null;
    roundIndex: number;
    stageIndex: number;
  }>;
  /** 完整大组数（递减组按轮计，按组结构判定，不用除法） */
  completeGroups: number;
  /** 有记录但不完整的组数 */
  partialGroups: number;
  /** 完整大组对应的阶段总数（递减组 = 完整轮 × 阶段数） */
  completeStages: number;
  /** 已记录阶段行数（V4-04：真实记录量，不是 完整大组 × 阶段数） */
  loggedStages: number;
  /** 本次训练里该动作的全部结构片段（V4-04 A：同动作中途转换后不再丢片段） */
  fragments: MovementFragment[];
  maxWeightKg: number | null;
  totalReps: number;
}

export interface ComparableHistory {
  exerciseId: string;
  name: string;
  weightMode: WeightMode;
  dumbbellBasis: DumbbellBasis;
  label: string | null;
  entries: ComparableHistoryEntry[];
  maxWeightKg: number | null;
  bestReps: number;
}

function isLogged(s: SessionSet): boolean {
  return s.status === 'done' && typeof s.reps === 'number' && Number.isFinite(s.reps);
}

/** 一个组的结构（组号 / 必需阶段数 / 是否跳过） */
interface FragmentStructure {
  index: number;
  stageCount: number;
  skipped: boolean;
}

/**
 * 该动作的组结构。
 * 优先用快照里的 groups（唯一判定依据）；旧数据没有 groups 时按真实 roundIndex 还原，
 * 阶段数取目标结构（**不从现存行数推断**，否则缺阶段会被误判成完整轮）。
 */
function structureOf(ex: SessionExercise): FragmentStructure[] {
  if (ex.groups.length) {
    return ex.groups.map((g) => ({
      index: g.index,
      stageCount: Math.max(1, g.stageCount),
      skipped: Boolean(g.skipped),
    }));
  }
  const target = ex.target;
  const fallbackStage = (round: number): number => {
    if (target.kind !== 'dropSet') return 1;
    // R02 FIX2：与 roundStagesOf 同一口径（额外轮按最后声明轮回退，不跨轮搜索）。
    return Math.max(1, roundStagesOf(target, round).length);
  };
  return Array.from(new Set(ex.sets.map((s) => s.roundIndex)))
    .sort((a, b) => a - b)
    .map((index) => ({ index, stageCount: fallbackStage(index), skipped: false }));
}

function roundRows(ex: SessionExercise, index: number): SessionSet[] {
  return ex.sets.filter((s) => s.roundIndex === index);
}

/** 该组是否完整：必需的每个阶段都存在且已记录（缺阶段一律不算完整） */
function groupIsComplete(ex: SessionExercise, g: FragmentStructure): boolean {
  const rows = roundRows(ex, g.index);
  if (!rows.length) return false;
  for (let si = 1; si <= g.stageCount; si++) {
    const row = rows.find((s) => s.stageIndex === si);
    if (!row || !isLogged(row)) return false;
  }
  return true;
}

/**
 * 部分大组：有已记录阶段、但不完整，且没有被跳过。
 * 与 `domain/session.ts` 的 `dropRoundPartial` 同规则（这里不改 session.ts，只复用其口径）。
 */
function groupIsPartial(ex: SessionExercise, g: FragmentStructure): boolean {
  if (g.skipped) return false;
  if (groupIsComplete(ex, g)) return false;
  return roundRows(ex, g.index).some(isLogged);
}

/** 完整大组数：按组结构逐组判定，**不用任何除法** */
function groupsComplete(ex: SessionExercise): number {
  return structureOf(ex).filter((g) => groupIsComplete(ex, g)).length;
}

/** 部分大组数：按组结构逐组判定，**不用任何除法** */
function groupsPartial(ex: SessionExercise): number {
  return structureOf(ex).filter((g) => groupIsPartial(ex, g)).length;
}

/* ── 同一次训练里「同动作多片段」的聚合（V4-04 A）──────────
   问题背景（审查 F-SPLIT-LAST）：
   历史数据中曾把「剩余未开始的组」转成递减组，会在同一次训练里
   留下两个合法的 SessionExercise（同 exerciseId、同计量口径）：
   · 片段 1 straight，1 组已记录；
   · 片段 2 dropSet，2 轮 × 3 阶段已记录。
   旧实现两处都只认「第一个片段」或「每个片段各算一条」：
   · Session.tsx 的 lastByExercise 用 map.has(key) continue → 下次只说「1 组」；
   · stats.ts 的 buildExerciseHistory 为这一次训练返回两条 entry，
     listTrainedExercises 把一次训练算成两次。
   这里提供唯一的聚合口径：按 session 收集片段 → 求和，且**每段保留自己的 roundIndex**
   （片段是各自从 1 开始编号的，跨片段合并会撞号）。 */

/** 同一次训练里，同一动作身份 + 同一计量口径的所有结构片段 */
export interface MovementFragment {
  sessionExerciseId: string;
  kind: 'straight' | 'dropSet';
  stageCount: number;
  /** 该片段自己的轮/阶段结构（保留片段独立 roundIndex，不跨片段合并，避免撞号） */
  groups: Array<{ index: number; stageCount: number; skipped: boolean }>;
  sets: Array<{ reps: number | null; weightKg: number | null; roundIndex: number; stageIndex: number }>;
  /** 按 groups 结构算的完整大组数（不用除法） */
  completeGroups: number;
  /** 按 groups 结构算的部分大组数 */
  partialGroups: number;
  /** 已记录阶段行数（不等于 completeGroups × stageCount） */
  loggedStages: number;
  /** 完整大组对应的真实阶段总数（R02：按每个完整轮自己的 stageCount 求和） */
  completeStages: number;
}

export interface MovementPerformance {
  sessionId: string;
  at: number;
  dayName: string;
  exerciseId: string;
  name: string;
  weightMode: WeightMode;
  dumbbellBasis: DumbbellBasis;
  fragments: MovementFragment[];
  completeGroups: number;
  partialGroups: number;
  loggedStages: number;
  loggedStraightSets: number;
  maxWeightKg: number | null;
  totalReps: number;
}

/** 把单个 SessionExercise 变成一个结构片段 */
export function fragmentOf(
  ex: SessionExercise,
  opts?: { hasSingleStraightHistory?: boolean },
): MovementFragment {
  const { eligibleSets, excludedAmbiguous } = filterComparableSetsForExercise(ex, opts);
  const filteredEx = excludedAmbiguous ? { ...ex, sets: eligibleSets } : ex;
  const structure = structureOf(filteredEx);
  const logged = eligibleSets
    .filter(isLogged)
    .sort((a, b) => a.roundIndex - b.roundIndex || a.stageIndex - b.stageIndex);
  const completeStages = structure
    .filter((g) => groupIsComplete(filteredEx, g))
    .reduce((n, g) => n + g.stageCount, 0);
  return {
    sessionExerciseId: ex.id,
    kind: ex.target.kind,
    // 兼容旧字段：片段内各轮可能不同，显示上限（统计口径以 completeStages / groups 为准）
    stageCount: structure.length ? Math.max(1, ...structure.map((g) => g.stageCount)) : 1,
    // 每段保留自己的组号，不重排、不跨段合并
    groups: structure.map((g) => ({ index: g.index, stageCount: g.stageCount, skipped: g.skipped })),
    sets: logged.map((s) => ({
      reps: s.reps,
      weightKg: s.weightKg,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
    })),
    completeGroups: groupsComplete(filteredEx),
    partialGroups: groupsPartial(filteredEx),
    loggedStages: logged.length,
    completeStages,
  };
}

function sameMode(
  a: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
  b: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
): boolean {
  return a.weightMode === b.weightMode && a.dumbbellBasis === b.dumbbellBasis;
}

function perfFromFragments(
  session: Session,
  exerciseId: string,
  mode: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
  fragments: MovementFragment[],
): MovementPerformance {
  const loggedRows = fragments.flatMap((f) => f.sets);
  const weights = loggedRows.map((s) => s.weightKg).filter((w): w is number => w !== null);
  return {
    sessionId: session.id,
    at: session.endedAt ?? session.startedAt,
    dayName: session.day.dayName,
    exerciseId,
    name: fragments.length ? nameOfFragment(session, fragments[0].sessionExerciseId) : exerciseId,
    weightMode: mode.weightMode,
    dumbbellBasis: mode.dumbbellBasis,
    fragments,
    completeGroups: fragments.reduce((n, f) => n + f.completeGroups, 0),
    partialGroups: fragments.reduce((n, f) => n + f.partialGroups, 0),
    loggedStages: fragments.reduce((n, f) => n + f.loggedStages, 0),
    loggedStraightSets: fragments
      .filter((f) => f.kind === 'straight')
      .reduce((n, f) => n + f.loggedStages, 0),
    maxWeightKg: weights.length ? Math.max(...weights) : null,
    totalReps: loggedRows.reduce((n, s) => n + (s.reps ?? 0), 0),
  };
}

function nameOfFragment(session: Session, sessionExerciseId: string): string {
  return session.exercises.find((e) => e.id === sessionExerciseId)?.name ?? '';
}

/**
 * 把一次训练里同 exerciseId + 同口径的片段聚合成一条。
 * 没有任何实际记录的片段不产生摘要（返回 null），避免「上次表现」显示空壳。
 */
export function collectMovementFragments(
  session: Session,
  exerciseId: string,
  mode: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
  opts?: { hasSingleStraightHistory?: boolean },
): MovementPerformance | null {
  const matched = session.exercises.filter(
    (ex) => (ex.exerciseId ?? ex.name) === exerciseId && sameMode(modeOf(ex), mode),
  );
  if (!matched.length) return null;
  const fragments = matched.map((ex) => fragmentOf(ex, opts)).filter((f) => f.loggedStages > 0);
  if (!fragments.length) return null;
  return perfFromFragments(session, exerciseId, mode, fragments);
}

/**
 * 按片段类型拆开的组数口径（统计页与「上次表现」共用，避免各处自己除）。
 * 普通组：1 组 = 1 行；递减组：1 大组 = 1 轮 × 阶段数，**按结构判定，绝不用除法**。
 */
export interface GroupBreakdown {
  /** 普通组片段里已记录的组数 */
  straightGroups: number;
  /** 递减组片段里的完整大组数（按轮结构判定） */
  dropComplete: number;
  /** 递减组片段里的部分大组数（有记录但阶段不全） */
  dropPartial: number;
  /** 递减组片段里已记录的阶段行数（真实记录量） */
  dropLoggedStages: number;
  /** 全部片段之和：完整大组数（普通组也按 1 组 = 1 大组计） */
  completeGroups: number;
  /** 全部片段之和：部分大组数 */
  partialGroups: number;
  /** 全部片段之和：已记录阶段行数 */
  loggedStages: number;
}

export function breakdownOf(fragments: MovementFragment[]): GroupBreakdown {
  const straight = fragments.filter((f) => f.kind === 'straight');
  const drop = fragments.filter((f) => f.kind === 'dropSet');
  return {
    straightGroups: straight.reduce((n, f) => n + f.loggedStages, 0),
    dropComplete: drop.reduce((n, f) => n + f.completeGroups, 0),
    dropPartial: drop.reduce((n, f) => n + f.partialGroups, 0),
    dropLoggedStages: drop.reduce((n, f) => n + f.loggedStages, 0),
    completeGroups: fragments.reduce((n, f) => n + f.completeGroups, 0),
    partialGroups: fragments.reduce((n, f) => n + f.partialGroups, 0),
    loggedStages: fragments.reduce((n, f) => n + f.loggedStages, 0),
  };
}

/**
 * 组数口径的一句话（统计页每行用）。
 * · 纯普通组：`3 组`
 * · 纯递减组：`2 完整大组 / 6 阶段`（有部分大组时补 ` / 1 部分大组`）
 * · 普通 + 递减混合：`普通 1 组 + 递减 2 完整大组 / 6 阶段`
 * 数字全部来自 breakdownOf（按轮结构判定），没有任何除法。
 */
export function describeGroupCounts(fragments: MovementFragment[]): string {
  const b = breakdownOf(fragments);
  if (!b.dropLoggedStages) return `${b.straightGroups} 组`;
  const dropParts = [`${b.dropComplete} 完整大组`, `${b.dropLoggedStages} 阶段`];
  if (b.dropPartial > 0) dropParts.push(`${b.dropPartial} 部分大组`);
  const dropText = dropParts.join(' / ');
  return b.straightGroups > 0 ? `普通 ${b.straightGroups} 组 + 递减 ${dropText}` : dropText;
}

/**
 * 「上次表现」/历史里的一句话摘要。
 * 必须同时体现：普通组部分的组数、递减部分的完整大组数与**已记录阶段数**、部分大组、重量与次数。
 * 例：`40kg/30kg · 普通 1 组 + 递减 2 完整大组 / 6 阶段 · 10/8/8/8/8/8 次`
 * 审查 B 修正：阶段数指「已记录阶段数」，不是「完整大组 × 阶段数」。
 */
export function describeMovementPerformance(perf: MovementPerformance): string {
  const logged = perf.fragments.flatMap((f) => f.sets);
  if (!logged.length) return '';
  const weights = [...new Set(logged.map((s) => s.weightKg).filter((w): w is number => w !== null))];
  const weightText = weights.length ? `${weights.map((w) => `${fmtKg(w)}kg`).join('/')} · ` : '';
  const repsText = `${logged.map((s) => s.reps ?? '—').join('/')} 次`;
  const b = breakdownOf(perf.fragments);

  // 纯普通组：保持原有的「N 组 · 次数」措辞
  if (!b.dropLoggedStages) return `${weightText}${b.straightGroups} 组 · ${repsText}`;

  // 递减部分的措辞：完整大组 + **已记录**阶段数（不是 完整大组 × 阶段数）
  const dropParts = [`${b.dropComplete} 个完整大组`, `${b.dropLoggedStages} 阶段`];
  if (b.dropPartial > 0) dropParts.push(`${b.dropPartial} 个部分大组`);
  const dropText = dropParts.join(' / ');
  const head = b.straightGroups > 0 ? `普通 ${b.straightGroups} 组 + 递减 ${dropText}` : dropText;
  return `${weightText}${head} · ${repsText}`;
}

/**
 * 建立某个「动作 + 计量口径」的可比历史。
 * @param sessions 全部训练（只用 completed 且有 endedAt 的）
 * @param exerciseId 动作身份
 * @param mode 计量口径；不传则取最近一次记录的直约口径
 */
export function buildComparableHistory(
  sessions: Session[],
  exerciseId: string,
  mode?: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
): ComparableHistory | null {
  const done = sessions
    .filter((s) => s.status === 'completed' && s.endedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  const singleIds = collectSingleMovementIds(done);
  const hasSingleStraightHistory = singleIds.has(exerciseId);

  // 找出所有出现过的「动作 + 口径」组合
  const modes = new Map<string, { weightMode: WeightMode; dumbbellBasis: DumbbellBasis }>();
  for (const s of done) {
    for (const ex of s.exercises) {
      if ((ex.exerciseId ?? ex.name) !== exerciseId) continue;
      const m = modeOf(ex);
      modes.set(`${m.weightMode}::${m.dumbbellBasis}`, m);
    }
  }
  if (!modes.size) return null;

  // 未指定口径：取最后一次实际记录的口径（不使用跨口径最大值）
  let chosen = mode;
  let name = '';
  if (!chosen) {
    for (let i = done.length - 1; i >= 0 && !chosen; i--) {
      for (const ex of done[i].exercises) {
        if ((ex.exerciseId ?? ex.name) !== exerciseId) continue;
        if (!filterComparableSetsForExercise(ex, { hasSingleStraightHistory }).eligibleSets.some(isLogged)) continue;
        chosen = modeOf(ex);
        name = ex.name;
        break;
      }
    }
  }
  if (!chosen) chosen = [...modes.values()][0];

  const entries: ComparableHistoryEntry[] = [];
  for (const s of done) {
    // V4-04 A：同一次训练里同口径的多个片段聚合成一条（不再一段一条）
    const perf = collectMovementFragments(s, exerciseId, chosen, { hasSingleStraightHistory });
    if (!perf) continue;
    name = name || perf.name;
    const sets = perf.fragments.flatMap((f) => f.sets);
    // R02：每个完整轮按自己的真实 stageCount 求和，绝不能用 completeGroups × 全局阶段数。
    const completeStages = perf.fragments.reduce((n, f) => n + f.completeStages, 0);
    entries.push({
      sessionId: s.id,
      at: s.endedAt ?? s.startedAt,
      dayName: s.day.dayName,
      exerciseName: perf.name,
      weightMode: perf.weightMode,
      dumbbellBasis: perf.dumbbellBasis,
      sets,
      completeGroups: perf.completeGroups,
      partialGroups: perf.partialGroups,
      completeStages,
      loggedStages: perf.loggedStages,
      fragments: perf.fragments,
      maxWeightKg: perf.maxWeightKg,
      totalReps: perf.totalReps,
    });
  }
  if (!entries.length) return null;

  const allWeights = entries.map((e) => e.maxWeightKg).filter((w): w is number => w !== null);
  const bestReps = Math.max(...entries.map((e) => Math.max(...e.sets.map((s) => s.reps ?? 0))));
  return {
    exerciseId,
    name,
    weightMode: chosen.weightMode,
    dumbbellBasis: chosen.dumbbellBasis,
    label: comparabilityLabel({ kind: 'straight', weightMode: chosen.weightMode, dumbbellBasis: chosen.dumbbellBasis }),
    entries,
    maxWeightKg: allWeights.length ? Math.max(...allWeights) : null,
    bestReps,
  };
}

/**
 * 一个动作出现过的全部可比口径（用于界面上的口径选择入口）。
 * V4-04 A：`count` 按**训练次数**计，不按片段计 ——
 * 同一次训练里「普通 + 递减」两个片段仍只算练过 1 次。
 */
export function listComparabilityModes(
  sessions: Session[],
  exerciseId: string,
): Array<{ weightMode: WeightMode; dumbbellBasis: DumbbellBasis; label: string; count: number }> {
  const singleIds = collectSingleMovementIds(sessions);
  const hasSingleStraightHistory = singleIds.has(exerciseId);
  const map = new Map<string, { weightMode: WeightMode; dumbbellBasis: DumbbellBasis; count: number }>();
  for (const s of sessions) {
    if (s.status !== 'completed' || !s.endedAt) continue;
    const seen = new Set<string>();
    for (const ex of s.exercises) {
      if ((ex.exerciseId ?? ex.name) !== exerciseId) continue;
      if (!filterComparableSetsForExercise(ex, { hasSingleStraightHistory }).eligibleSets.some(isLogged)) continue;
      const m = modeOf(ex);
      const k = `${m.weightMode}::${m.dumbbellBasis}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = map.get(k) ?? { ...m, count: 0 };
      cur.count += 1;
      map.set(k, cur);
    }
  }
  return [...map.values()].map((m) => ({
    ...m,
    label: comparabilityLabel({ kind: 'straight', weightMode: m.weightMode, dumbbellBasis: m.dumbbellBasis }) ?? m.weightMode,
  }));
}

/**
 * 「上次表现」用的可比摘要（训练页折叠态显示）。
 * 递减组必须称「N 个完整大组 / M 阶段」，不能把阶段行数叫成组数（审查 V3-05 最后一条）。
 *
 * V4-04 B 修正（审查 F-PARTIAL-GROUP-DISPLAY 的第二半）：
 * 「阶段数」必须指**已记录阶段数**。旧实现写的是 `完整大组 × 阶段数`，
 * 于是「三轮各只做阶段 1」显示成「0 个完整大组 · 0 阶段 · 3 个部分大组」——
 * 明明记录了 3 个阶段却说 0 阶段。现在直接取已记录行数。
 */
export function describeLastPerformance(ex: SessionExercise): string {
  const sets = ex.sets.filter(isLogged);
  if (!sets.length) return '';
  const isDrop = ex.target.kind === 'dropSet';
  const complete = groupsComplete(ex);
  const partial = groupsPartial(ex);
  const reps = sets.map((st) => st.reps).join('/');
  const weights = [...new Set(sets.map((st) => st.weightKg).filter((w): w is number => w !== null))];
  const weightText = weights.length ? `${weights.map((w) => `${fmtKg(w)}kg`).join('/')} · ` : '';
  if (isDrop) {
    // 已记录阶段数 = 真实记录行数，不是「完整大组 × 阶段数」
    const parts = [`${complete} 个完整大组`, `${sets.length} 阶段`];
    if (partial > 0) parts.push(`${partial} 个部分大组`);
    return `${weightText}${parts.join(' · ')} · ${reps} 次`;
  }
  return `${weightText}${complete} 组 · ${reps} 次`;
}

function fmtKg(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}
