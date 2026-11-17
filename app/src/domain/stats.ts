/* 统计：只计算能从真实记录可靠得到的数。
   口径写在 README「统计口径」：
   · 热身不算正式组（summarizeSession 已排除）
   · 计划未完成的组不算已完成组
   · 递减组按大组计数
   · 部分完成的大组单独统计，不伪装成完整组
   · 删除/纠正记录后重算，不做增量累加
   · 不跨动作/跨重量合成力量分数 */

import type { DumbbellBasis, Session, WeightMode } from './types';
import { summarizeSession } from './session';
import { sessionKindOf } from './sessionKind';
import { isoWeekKey } from '../lib/format';
import { comparabilityLabel } from './identity';
import { collectMovementFragments, type MovementFragment } from './comparability';

export interface Overview {
  totalSessions: number;
  totalSets: number;
  totalMs: number;
  avgDurationMs: number;
  avgSetsPerSession: number;
  weeks: Array<{ key: string; label: string; count: number; sets: number }>;
  byDayName: Array<{ name: string; count: number; sets: number }>;
  firstSessionAt: number | null;
  lastSessionAt: number | null;
}

export function buildOverview(sessions: Session[]): Overview {
  /**
   * 分母：已结束且**不是完全休息**的记录。
   * 完全休息不计入训练次数/周次/日类型/首次最近/平均时长/平均组数。
   */
  const done = sessions.filter(
    (s) => s.status === 'completed' && s.endedAt && sessionKindOf(s) !== 'rest',
  );
  const weekMap = new Map<string, { count: number; sets: number }>();
  const dayMap = new Map<string, { count: number; sets: number }>();
  let totalSets = 0;
  let totalMs = 0;

  for (const s of done) {
    const sum = summarizeSession(s, s.endedAt ?? Date.now());
    totalSets += sum.completedSets;
    totalMs += sum.durationMs;
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

  const weeks = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 8)
    .map(([key, v]) => ({ key, label: key.split('-W')[1] ? `W${key.split('-W')[1]}` : key, ...v }));

  const sorted = [...done].sort((a, b) => a.startedAt - b.startedAt);

  return {
    totalSessions: done.length,
    totalSets,
    totalMs,
    avgDurationMs: done.length ? Math.round(totalMs / done.length) : 0,
    avgSetsPerSession: done.length ? Math.round((totalSets / done.length) * 10) / 10 : 0,
    weeks: weeks.reverse(),
    byDayName: [...dayMap.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.count - a.count),
    firstSessionAt: sorted[0]?.startedAt ?? null,
    lastSessionAt: sorted.at(-1)?.startedAt ?? null,
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
  /** 最大重量（只在该动作确实记录重量时才有意义） */
  maxWeightKg: number | null;
  totalReps: number;
}

export interface ExerciseHistory {
  key: string;
  name: string;
  entries: ExerciseHistoryEntry[];
  maxWeightKg: number | null;
  bestReps: number;
  /** 本次展示所用的计量口径说明（V3-05：口径必须可见） */
  label: string | null;
  weightMode?: WeightMode;
  dumbbellBasis?: DumbbellBasis;
}

/**
 * 把查询用的 key 解析成数据里真实的动作身份。
 * 旧调用方可能传动作名称（v1 时代的历史没有 exerciseId），
 * 而 `collectMovementFragments` 按 exerciseId 匹配 —— 这里做一次解析，
 * 保证「按名称查」与「按身份查」命中同一批记录。
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
 * key 用动作身份 exerciseId；`mode` 用于把「负重 +20kg」和「辅助 70kg」分开。
 * 不传 mode 时由调用方决定口径；直接调用本函数且有多种口径时，
 * 只会返回与**最近一次记录**同口径的数据，避免把不同语义的重量算成一条曲线。
 */
export function buildExerciseHistory(
  sessions: Session[],
  key: string,
  mode?: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis },
): ExerciseHistory | null {
  const done = sessions.filter((s) => s.status === 'completed' && s.endedAt).sort((a, b) => a.startedAt - b.startedAt);
  const entries: ExerciseHistoryEntry[] = [];
  let name = '';

  // 未指定口径：取最近一次有实际记录的口径
  let chosen = mode;
  if (!chosen) {
    outer: for (let i = done.length - 1; i >= 0; i--) {
      for (const ex of done[i].exercises) {
        const exKey = ex.exerciseId ?? ex.name;
        if (exKey !== key && ex.name !== key) continue;
        if (!ex.sets.some((st) => st.status === 'done')) continue;
        chosen = {
          weightMode: ex.target.weightMode,
          dumbbellBasis: ex.target.dumbbellBasis ?? 'total',
        };
        break outer;
      }
    }
  }
  // 整个历史里没有这个动作的任何实际记录：没有口径可用，也就没有历史
  if (!chosen) return null;

  // 兼容旧调用方：key 可能是 exerciseId，也可能是动作名称。
  // collectMovementFragments 只认 exerciseId，这里先解析成数据里真实的身份，
  // 避免「按名称查询」在有 exerciseId 的新数据上查不到任何东西。
  const identity = resolveHistoryKey(done, key);

  for (const s of done) {
    // V4-04 A：一次训练 = 一条 entry。
    // 同动作中途转成递减组会在 session 里留下多个同 exerciseId + 同口径的片段，
    // 旧实现按片段各推一条 entry（一次训练被算成两次，组数/阶段数被拆散）。
    // V3-05 保留：跨计量口径仍然分开（口径不同就不进这条历史）。
    const perf = collectMovementFragments(s, identity, chosen);
    if (!perf) continue;
    name = name || perf.name;
    const dropFragments = perf.fragments.filter((f) => f.kind === 'dropSet');
    entries.push({
      sessionId: s.id,
      at: s.startedAt,
      dayName: s.day.dayName,
      // V3-05：保留轮/阶段归属，历史与统计不会把扁平阶段误称普通组
      // V4-04：多片段的记录行全部聚合（每行仍带自己的 roundIndex/stageIndex）
      sets: perf.fragments.flatMap((f) => f.sets),
      // 本次有递减片段时按「大组」措辞
      targetKind: dropFragments.length ? 'dropSet' : 'straight',
      stageCount: dropFragments.length ? Math.max(1, ...dropFragments.map((f) => f.stageCount)) : 1,
      fragments: perf.fragments,
      completeGroups: perf.completeGroups,
      completeStages: perf.fragments.reduce((n, f) => n + f.completeStages, 0),
      partialGroups: perf.partialGroups,
      loggedStages: perf.loggedStages,
      maxWeightKg: perf.maxWeightKg,
      totalReps: perf.totalReps,
    });
  }
  if (!entries.length) return null;
  const allWeights = entries.map((e) => e.maxWeightKg).filter((w): w is number => w !== null);
  const bestReps = Math.max(...entries.map((e) => Math.max(...e.sets.map((s) => s.reps ?? 0))));
  return {
    key,
    name,
    entries,
    maxWeightKg: allWeights.length ? Math.max(...allWeights) : null,
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

export function listTrainedExercises(sessions: Session[]): Array<{ key: string; name: string; count: number }> {
  const map = new Map<string, { name: string; count: number }>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    // V4-04 A：同一次训练里同动作可能有多条片段（中途转递减组），
    // 但「练过多少次」必须按训练计，不能按片段计。
    const seen = new Set<string>();
    for (const ex of s.exercises) {
      if (!ex.sets.some((st) => st.status === 'done')) continue;
      const key = ex.exerciseId ?? ex.name;
      if (seen.has(key)) continue;
      seen.add(key);
      const cur = map.get(key) ?? { name: ex.name, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    }
  }
  return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count);
}
