/* 统计：只计算能从真实记录可靠得到的数。
   口径写在 README「统计口径」：
   · 热身不算正式组（summarizeSession 已排除）
   · 计划未完成的组不算已完成组
   · 递减组按大组计数
   · 部分完成的大组单独统计，不伪装成完整组
   · 删除/纠正记录后重算，不做增量累加
   · 不跨动作/跨重量合成力量分数 */

import type { Session } from './types';
import { summarizeSession } from './session';
import { isoWeekKey } from '../lib/format';

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
  const done = sessions.filter((s) => s.status === 'completed' && s.endedAt);
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
  /** 每次训练该动作的已完成组 */
  sets: Array<{ reps: number | null; weightKg: number | null }>;
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
}

/** 单个动作跨次表现。key 用 planExerciseId，临时动作退回名称。 */
export function buildExerciseHistory(sessions: Session[], key: string): ExerciseHistory | null {
  const done = sessions.filter((s) => s.status === 'completed' && s.endedAt).sort((a, b) => a.startedAt - b.startedAt);
  const entries: ExerciseHistoryEntry[] = [];
  let name = '';
  for (const s of done) {
    for (const ex of s.exercises) {
      // 动作身份优先（审计 R1-06：跨 A/B 轮必须关联同一动作）
      const exKey = ex.exerciseId ?? ex.name;
      if (exKey !== key && ex.name !== key) continue;
      const sets = ex.sets.filter((st) => st.status === 'done' && typeof st.reps === 'number' && Number.isFinite(st.reps));
      if (!sets.length) continue;
      name = name || ex.name;
      const weights = sets.map((st) => st.weightKg).filter((w): w is number => w !== null);
      entries.push({
        sessionId: s.id,
        at: s.startedAt,
        dayName: s.day.dayName,
        sets: sets.map((st) => ({ reps: st.reps, weightKg: st.weightKg })),
        maxWeightKg: weights.length ? Math.max(...weights) : null,
        totalReps: sets.reduce((n, st) => n + (st.reps ?? 0), 0),
      });
    }
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
  };
}

export function listTrainedExercises(sessions: Session[]): Array<{ key: string; name: string; count: number }> {
  const map = new Map<string, { name: string; count: number }>();
  for (const s of sessions) {
    if (s.status !== 'completed') continue;
    for (const ex of s.exercises) {
      if (!ex.sets.some((st) => st.status === 'done')) continue;
      const key = ex.exerciseId ?? ex.name;
      const cur = map.get(key) ?? { name: ex.name, count: 0 };
      cur.count += 1;
      map.set(key, cur);
    }
  }
  return [...map.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.count - a.count);
}
