/* 统计：只计算能从真实记录可靠得到的数。
   口径写在 README「统计口径」：
   · 热身不算正式组（summarizeSession 已排除）
   · 计划未完成的组不算已完成组
   · 递减组按大组计数
   · 部分完成的大组单独统计，不伪装成完整组
   · 纯有氧场次不稀释力量「平均组数/次」，有氧场次与时长独立呈现（Wave 2B.1）
   · 周频连续推算 8 个自然 ISO 周并为空缺周补 0（Wave 2B.2）
   · 删除/纠正记录后重算，不做增量累加
   · 不跨动作/跨重量合成力量分数；辅助重量按「越小越强」单独计算最佳值（Wave 2B.3） */

import type { DumbbellBasis, Session, WeightMode } from './types';
import { summarizeSession } from './session';
import { sessionKindOf } from './sessionKind';
import { isoWeekKey } from '../lib/format';
import { comparabilityLabel, exerciseIdFromName, normalizeExerciseName } from './identity';
import { collectMovementFragments, type MovementFragment } from './comparability';
import { EXERCISE_LIBRARY, type LibraryEntry } from './presets/library';
import { matchesPinyinInitials } from './pinyinInitials';
import { collectSingleMovementIds, filterComparableSetsForExercise } from './supersetPair';

export const OVERVIEW_WEEK_SPAN = 8;

export interface Overview {
  totalSessions: number;
  strengthSessions: number;
  cardioSessions: number;
  totalCardioMs: number;
  totalSets: number;
  totalMs: number;
  avgDurationMs: number;
  avgSetsPerSession: number;
  weeks: Array<{ key: string; label: string; count: number; sets: number }>;
  byDayName: Array<{ name: string; count: number; sets: number }>;
  firstSessionAt: number | null;
  lastSessionAt: number | null;
}

/** 以锚点时间所在周的周一为终点，向前生成连续 N 个自然 ISO 周（无记录周补 0，跨年与夏令时安全） */
export function buildConsecutiveIsoWeeks(
  anchorTs: number,
  weekMap: ReadonlyMap<string, { count: number; sets: number }>,
  span = OVERVIEW_WEEK_SPAN,
): Array<{ key: string; label: string; count: number; sets: number }> {
  const anchor = new Date(anchorTs);
  const monday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 12, 0, 0, 0);
  const dayOffset = (monday.getDay() + 6) % 7; // 周一 = 0
  monday.setDate(monday.getDate() - dayOffset);

  const out: Array<{ key: string; label: string; count: number; sets: number }> = [];
  for (let back = span - 1; back >= 0; back--) {
    const d = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() - back * 7,
      12,
      0,
      0,
      0,
    );
    const key = isoWeekKey(d.getTime());
    const hit = weekMap.get(key);
    const wkPart = key.split('-W')[1];
    out.push({
      key,
      label: wkPart ? `W${wkPart}` : key,
      count: hit?.count ?? 0,
      sets: hit?.sets ?? 0,
    });
  }
  return out;
}

export function buildOverview(sessions: Session[], referenceNow?: number): Overview {
  /**
   * 分母：已结束且**不是完全休息**的记录。
   * 完全休息不计入训练次数/周次/日类型/首次最近/平均时长/平均组数。
   * Wave 2B.1：纯有氧场次计入总场次与有氧统计，但不计入力量 `avgSetsPerSession` 分母。
   */
  const done = sessions.filter(
    (s) => s.status === 'completed' && s.endedAt && sessionKindOf(s) !== 'rest',
  );
  const weekMap = new Map<string, { count: number; sets: number }>();
  const dayMap = new Map<string, { count: number; sets: number }>();
  let totalSets = 0;
  let totalMs = 0;
  let totalCardioMs = 0;
  let strengthSessions = 0;
  let cardioSessions = 0;

  for (const s of done) {
    const kind = sessionKindOf(s);
    const sum = summarizeSession(s, s.endedAt ?? Date.now());
    totalSets += sum.completedSets;
    totalMs += sum.durationMs;
    totalCardioMs += sum.cardioMs;

    if (kind !== 'cardio' && s.exercises.length > 0) {
      strengthSessions += 1;
    }
    if (
      kind === 'cardio' ||
      sum.cardioMs > 0 ||
      (s.cardio ?? []).some((c) => c.status === 'done' || c.segments.length > 0)
    ) {
      cardioSessions += 1;
    }

    const wk = isoWeekKey(s.startedAt);
    const w = weekMap.get(wk) ?? { count: 0, sets: 0 };
    w.count += 1;
    w.sets += sum.completedSets;
    weekMap.set(wk, w);

    const name = s.day.dayName;
    const d = dayMap.get(name) ?? { count: 0, sets: 0 };
    d.count += 1;
    d.sets += sum.completedSets;
    dayMap.set(name, d);
  }

  const sorted = [...done].sort((a, b) => a.startedAt - b.startedAt);
  const latestAt = sorted.at(-1)?.startedAt ?? null;
  const weeks =
    latestAt === null
      ? []
      : buildConsecutiveIsoWeeks(
          referenceNow !== undefined && Number.isFinite(referenceNow)
            ? Math.max(latestAt, referenceNow)
            : latestAt,
          weekMap,
          OVERVIEW_WEEK_SPAN,
        );

  return {
    totalSessions: done.length,
    strengthSessions,
    cardioSessions,
    totalCardioMs,
    totalSets,
    totalMs,
    avgDurationMs: done.length ? Math.round(totalMs / done.length) : 0,
    avgSetsPerSession: strengthSessions ? Math.round((totalSets / strengthSessions) * 10) / 10 : 0,
    weeks,
    byDayName: [...dayMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    firstSessionAt: sorted[0]?.startedAt ?? null,
    lastSessionAt: latestAt,
  };
}

export interface ExerciseHistoryEntry {
  sessionId: string;
  at: number;
  dayName: string;
  /** 每次训练该动作的已完成组（保留轮/阶段归属；多片段时聚合全部片段的记录行） */
  sets: Array<{
    reps: number | null;
    weightKg: number | null;
    roundIndex: number;
    stageIndex: number;
  }>;
  /** 该次是普通组还是递减组（决定「组」还是「大组」的措辞） */
  targetKind: 'straight' | 'dropSet';
  /** 递减组的阶段数（普通组为 1） */
  stageCount: number;
  /**
   * V4-04 A：本次训练里该动作的全部结构片段。
   * 同动作中途转换成递减组时会留下多个片段，这里必须全部保留；
   * `sets` 是它们的记录行聚合。
   */
  fragments: MovementFragment[];
  /** 完整大组数（按组结构判定，不用除法） */
  completeGroups: number;
  /** R02：完整大组对应真实阶段总数（按每轮 stageCount 求和） */
  completeStages: number;
  /** 部分大组数（有记录但不完整） */
  partialGroups: number;
  /** 已记录阶段行数（真实记录量，不是 完整大组 × 阶段数） */
  loggedStages: number;
  /** 数值最大重量（兼容旧调用方） */
  maxWeightKg: number | null;
  /** 按口径语义的最佳重量（assisted 为最小辅助重量，其余为最大重量） */
  bestWeightKg: number | null;
  /** 单组最多次数 */
  bestReps: number;
  totalReps: number;
}

export interface ExerciseHistory {
  key: string;
  name: string;
  entries: ExerciseHistoryEntry[];
  maxWeightKg: number | null;
  bestWeightKg: number | null;
  bestReps: number;
  /** 本次展示所用的计量口径说明（V3-05：口径必须可见） */
  label: string | null;
  weightMode?: WeightMode;
  dumbbellBasis?: DumbbellBasis;
}

/**
 * 把查询用的 key 解析成数据里真实的动作身份。
 */
function resolveHistoryKey(done: Session[], key: string): string {
  for (const s of done) {
    for (const ex of s.exercises) {
      const exKey = ex.exerciseId ?? ex.name;
      if (exKey === key) return exKey;
      if (ex.name === key) return exKey;
    }
  }
  return key;
}

/**
 * 单个动作跨次表现（V3-05：必须按计量口径筛选）。
 */
export function buildExerciseHistory(
  sessions: Session[],
  key: string,
  mode?: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
): ExerciseHistory | null {
  const done = sessions
    .filter((s) => s.status === 'completed' && s.endedAt)
    .sort((a, b) => a.startedAt - b.startedAt);
  const singleIds = collectSingleMovementIds(done);
  const entries: ExerciseHistoryEntry[] = [];
  let name = '';

  const identity = resolveHistoryKey(done, key);
  const hasSingleStraightHistory = singleIds.has(identity);

  // 未指定口径：取最近一次有实际记录的口径
  let chosen = mode;
  if (!chosen) {
    outer: for (let i = done.length - 1; i >= 0; i--) {
      for (const ex of done[i].exercises) {
        const exKey = ex.exerciseId ?? ex.name;
        if (exKey !== key && ex.name !== key) continue;
        if (!filterComparableSetsForExercise(ex, { hasSingleStraightHistory }).eligibleSets.some((st) => st.status === 'done')) {
          continue;
        }
        chosen = {
          weightMode: ex.target.weightMode,
          dumbbellBasis: ex.target.dumbbellBasis ?? 'total',
        };
        break outer;
      }
    }
  }
  if (!chosen) return null;

  const isAssisted = chosen.weightMode === 'assisted';

  for (const s of done) {
    const perf = collectMovementFragments(s, identity, chosen, { hasSingleStraightHistory });
    if (!perf) continue;
    name = name || perf.name;
    const dropFragments = perf.fragments.filter((f) => f.kind === 'dropSet');
    const flatSets = perf.fragments.flatMap((f) => f.sets);
    const entryWeights = flatSets
      .map((st) => st.weightKg)
      .filter((w): w is number => typeof w === 'number' && Number.isFinite(w));
    const entryBestWeight = entryWeights.length
      ? isAssisted
        ? Math.min(...entryWeights)
        : Math.max(...entryWeights)
      : null;
    const entryBestReps = flatSets.length ? Math.max(...flatSets.map((st) => st.reps ?? 0)) : 0;

    entries.push({
      sessionId: s.id,
      at: s.startedAt,
      dayName: s.day.dayName,
      sets: flatSets,
      targetKind: dropFragments.length ? 'dropSet' : 'straight',
      stageCount: dropFragments.length ? Math.max(1, ...dropFragments.map((f) => f.stageCount)) : 1,
      fragments: perf.fragments,
      completeGroups: perf.completeGroups,
      completeStages: perf.fragments.reduce((n, f) => n + f.completeStages, 0),
      partialGroups: perf.partialGroups,
      loggedStages: perf.loggedStages,
      maxWeightKg: perf.maxWeightKg,
      bestWeightKg: entryBestWeight,
      bestReps: entryBestReps,
      totalReps: perf.totalReps,
    });
  }
  if (!entries.length) return null;
  const allMaxWeights = entries.map((e) => e.maxWeightKg).filter((w): w is number => w !== null);
  const allBestWeights = entries.map((e) => e.bestWeightKg).filter((w): w is number => w !== null);
  const bestReps = Math.max(...entries.map((e) => e.bestReps));
  return {
    key,
    name,
    entries,
    maxWeightKg: allMaxWeights.length ? Math.max(...allMaxWeights) : null,
    bestWeightKg: allBestWeights.length
      ? isAssisted
        ? Math.min(...allBestWeights)
        : Math.max(...allBestWeights)
      : null,
    bestReps,
    label: chosen
      ? (comparabilityLabel({
          kind: 'straight',
          weightMode: chosen.weightMode,
          dumbbellBasis: chosen.dumbbellBasis,
        }) ?? chosen.weightMode)
      : null,
    weightMode: chosen?.weightMode,
    dumbbellBasis: chosen?.dumbbellBasis,
  };
}

export interface TrainedExerciseItem {
  key: string;
  name: string;
  count: number;
  group?: LibraryEntry['group'];
  aliases?: string[];
  en?: string;
}

const LIBRARY_BY_ID = new Map<string, LibraryEntry>(
  EXERCISE_LIBRARY.map((item) => [exerciseIdFromName(item.name), item]),
);

export function listTrainedExercises(sessions: Session[]): TrainedExerciseItem[] {
  const singleIds = collectSingleMovementIds(sessions);
  const map = new Map<string, { name: string; count: number }>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    const seen = new Set<string>();
    for (const ex of s.exercises) {
      const key = ex.exerciseId ?? ex.name;
      if (!filterComparableSetsForExercise(ex, { hasSingleStraightHistory: singleIds.has(key) }).eligibleSets.some((st) => st.status === 'done')) {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = map.get(key) ?? { name: ex.name, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    }
  }
  return [...map.entries()]
    .map(([key, v]) => {
      const meta = LIBRARY_BY_ID.get(key) ?? LIBRARY_BY_ID.get(exerciseIdFromName(v.name));
      return {
        key,
        ...v,
        ...(meta?.group ? { group: meta.group } : {}),
        ...(meta?.aliases?.length ? { aliases: meta.aliases } : {}),
        ...(meta?.en ? { en: meta.en } : {}),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** 按部位与关键字 / 拼音首字母 / 别名过滤已训练动作列表（Wave 2B.3） */
export function filterTrainedExercises(
  items: readonly TrainedExerciseItem[],
  opts: { group?: string; query?: string },
): TrainedExerciseItem[] {
  const groupFilter = opts.group && opts.group !== 'all' ? opts.group : null;
  const rawQuery = (opts.query ?? '').trim();
  const normQuery = rawQuery ? normalizeExerciseName(rawQuery) : '';
  const lowerQuery = rawQuery.toLowerCase();

  return items.filter((item) => {
    if (groupFilter && (item.group ?? '其他') !== groupFilter) return false;
    if (!rawQuery) return true;
    if (normalizeExerciseName(item.name).includes(normQuery)) return true;
    if (item.en && item.en.toLowerCase().includes(lowerQuery)) return true;
    if (item.group && item.group.includes(rawQuery)) return true;
    if (matchesPinyinInitials(item.name, rawQuery)) return true;
    if (
      item.aliases?.some(
        (alias) => normalizeExerciseName(alias).includes(normQuery) || matchesPinyinInitials(alias, rawQuery),
      )
    ) {
      return true;
    }
    return false;
  });
}
