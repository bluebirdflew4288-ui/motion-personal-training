/* Wave 3D.1：严谨同口径 PR（个人纪录）与首录判定纯函数。
   口径红线：
   1) 严格按 comparabilityOf(ex)（exerciseId + weightMode + dumbbellBasis）隔离，绝不跨负重模式或单双哑铃口径混比；
   2) 仅统计已完成有效组且实际完成次数 > 0（0 次试举失败不计为 PR）；
   3) 此前无任何同口径有效历史记录时，仅标记为「首录」（first-record），绝不滥发 PR；
   4) weightMode === 'assisted'（辅助引体/臂屈伸）采用反向比较：辅助重量越小代表自身力量越强（如 60kg -> 45kg 才是重量 PR，50kg -> 70kg 绝不判为 PR）；
   5) 在历史已出现过的同一重量下刷新单组最高次数，判定为「同重次数 PR」；纯自重刷新单组最高次数判定为「次数 PR」。 */

import { comparabilityOf, modeOf } from './comparability';
import { isSetLogged } from './session';
import { sessionKindOf } from './sessionKind';
import type { DumbbellBasis, Session, SessionExercise, WeightMode } from './types';
import { fmtWeight } from '../lib/format';

export type AchievementKind = 'weight-pr' | 'reps-at-weight-pr' | 'reps-pr' | 'first-record';

export interface ExerciseAchievement {
  kind: AchievementKind;
  isPr: boolean;
  /** 印章短标签：如「重量 PR」「同重次数 PR」「次数 PR」「首录」 */
  stampLabel: string;
  /** 详细说明：如「85 kg × 6（原最佳 80 kg）」 */
  detailText: string;
  sessionExerciseId: string;
  exerciseId: string;
  exerciseName: string;
  comparabilityKey: string;
  weightMode: WeightMode;
  dumbbellBasis: DumbbellBasis;
  weightKg: number | null;
  reps: number;
  previousBestWeightKg?: number | null;
  previousBestReps?: number | null;
}

export interface SessionPRReport {
  sessionId: string;
  /** 仅含真正刷新历史纪录的 PR 列表（不含「首录」） */
  prs: ExerciseAchievement[];
  /** 首次建立基准的动作列表 */
  firstRecords: ExerciseAchievement[];
  /** 按 sessionExercise.id 索引的成就列表（供历史详情与完赛小票直接挂载） */
  bySessionExerciseId: Map<string, ExerciseAchievement[]>;
}

interface ValidPositiveSet {
  reps: number;
  weightKg: number | null;
  weightGrams: number | null;
}

function collectPositiveSets(ex: SessionExercise): ValidPositiveSet[] {
  const out: ValidPositiveSet[] = [];
  for (const s of ex.sets) {
    if (!isSetLogged(s)) continue;
    if (typeof s.reps !== 'number' || !Number.isFinite(s.reps) || s.reps <= 0) continue;
    const hasW = typeof s.weightKg === 'number' && Number.isFinite(s.weightKg) && s.weightKg >= 0;
    out.push({
      reps: s.reps,
      weightKg: hasW ? s.weightKg : null,
      weightGrams: hasW ? Math.round(s.weightKg! * 1000) : null,
    });
  }
  return out;
}

function isChronologicallyBefore(prior: Session, target: Session): boolean {
  const priorTs = prior.endedAt ?? prior.startedAt;
  const targetTs = target.endedAt ?? target.startedAt;
  if (priorTs !== targetTs) return priorTs < targetTs;
  if (prior.startedAt !== target.startedAt) return prior.startedAt < target.startedAt;
  return prior.id < target.id;
}

/**
 * 检测目标训练会话中的同口径 PR 与首录。
 */
export function detectSessionPRs(
  allCompletedSessions: readonly Session[],
  targetSession: Session,
): SessionPRReport {
  const prs: ExerciseAchievement[] = [];
  const firstRecords: ExerciseAchievement[] = [];
  const bySessionExerciseId = new Map<string, ExerciseAchievement[]>();

  if (sessionKindOf(targetSession) === 'rest' || targetSession.exercises.length === 0) {
    return { sessionId: targetSession.id, prs, firstRecords, bySessionExerciseId };
  }

  const priorSessions = allCompletedSessions.filter(
    (s) =>
      s.status === 'completed' &&
      s.id !== targetSession.id &&
      sessionKindOf(s) !== 'rest' &&
      isChronologicallyBefore(s, targetSession),
  );

  // 将目标会话内的动作按可比口径聚合（保留首个具有正次数记录的实例 ID 作为印章落点）
  const targetGroups = new Map<
    string,
    {
      primaryEx: SessionExercise;
      sets: ValidPositiveSet[];
    }
  >();

  for (const ex of targetSession.exercises) {
    const sets = collectPositiveSets(ex);
    if (sets.length === 0) continue;
    const key = comparabilityOf(ex);
    const existing = targetGroups.get(key);
    if (existing) {
      existing.sets.push(...sets);
    } else {
      targetGroups.set(key, { primaryEx: ex, sets });
    }
  }

  for (const [key, { primaryEx, sets: curSets }] of targetGroups) {
    const { weightMode, dumbbellBasis } = modeOf(primaryEx);

    let priorSessionCount = 0;
    const priorWeightsGrams: number[] = [];
    const priorBestRepsAtWeight = new Map<number, number>();
    let priorBestBodyweightReps = 0;

    for (const ps of priorSessions) {
      let hitInSession = false;
      for (const pex of ps.exercises) {
        if (comparabilityOf(pex) !== key) continue;
        const pSets = collectPositiveSets(pex);
        if (pSets.length === 0) continue;
        hitInSession = true;
        for (const st of pSets) {
          if (st.reps > priorBestBodyweightReps) {
            priorBestBodyweightReps = st.reps;
          }
          if (st.weightGrams !== null) {
            priorWeightsGrams.push(st.weightGrams);
            const prevReps = priorBestRepsAtWeight.get(st.weightGrams) ?? 0;
            if (st.reps > prevReps) {
              priorBestRepsAtWeight.set(st.weightGrams, st.reps);
            }
          }
        }
      }
      if (hitInSession) {
        priorSessionCount += 1;
      }
    }

    const pushAchievement = (ach: ExerciseAchievement) => {
      if (ach.isPr) prs.push(ach);
      else firstRecords.push(ach);
      const bucket = bySessionExerciseId.get(ach.sessionExerciseId) ?? [];
      bucket.push(ach);
      bySessionExerciseId.set(ach.sessionExerciseId, bucket);
    };

    if (priorSessionCount === 0) {
      // 首次记录：选出本次代表性最佳组展示，但不算 PR
      let repBest = curSets[0];
      for (const st of curSets) {
        if (weightMode === 'assisted') {
          if (
            st.weightGrams !== null &&
            (repBest.weightGrams === null ||
              st.weightGrams < repBest.weightGrams ||
              (st.weightGrams === repBest.weightGrams && st.reps > repBest.reps))
          ) {
            repBest = st;
          }
        } else if (weightMode === 'bodyweight') {
          if (st.reps > repBest.reps) repBest = st;
        } else if (
          st.weightGrams !== null &&
          (repBest.weightGrams === null ||
            st.weightGrams > repBest.weightGrams ||
            (st.weightGrams === repBest.weightGrams && st.reps > repBest.reps))
        ) {
          repBest = st;
        }
      }
      const detail =
        repBest.weightKg !== null && weightMode !== 'bodyweight'
          ? `${weightMode === 'assisted' ? '辅助 ' : ''}${fmtWeight(repBest.weightKg)} kg × ${repBest.reps} 次`
          : `${repBest.reps} 次`;
      pushAchievement({
        kind: 'first-record',
        isPr: false,
        stampLabel: '首录',
        detailText: detail,
        sessionExerciseId: primaryEx.id,
        exerciseId: primaryEx.exerciseId,
        exerciseName: primaryEx.name,
        comparabilityKey: key,
        weightMode,
        dumbbellBasis,
        weightKg: repBest.weightKg,
        reps: repBest.reps,
      });
      continue;
    }

    // 有同口径历史：根据负重模式判定 PR
    if (weightMode === 'bodyweight') {
      let bestSet = curSets[0];
      for (const st of curSets) {
        if (st.reps > bestSet.reps) bestSet = st;
      }
      if (priorBestBodyweightReps > 0 && bestSet.reps > priorBestBodyweightReps) {
        pushAchievement({
          kind: 'reps-pr',
          isPr: true,
          stampLabel: '次数 PR',
          detailText: `单组 ${bestSet.reps} 次（原最佳 ${priorBestBodyweightReps} 次）`,
          sessionExerciseId: primaryEx.id,
          exerciseId: primaryEx.exerciseId,
          exerciseName: primaryEx.name,
          comparabilityKey: key,
          weightMode,
          dumbbellBasis,
          weightKg: null,
          reps: bestSet.reps,
          previousBestReps: priorBestBodyweightReps,
        });
      }
      continue;
    }

    const curWeightedSets = curSets.filter((s) => s.weightGrams !== null);
    if (curWeightedSets.length === 0) {
      continue;
    }

    // 1) 重量 PR（辅助模式越小越强；外加负重越大越强）
    let weightPrSet: ValidPositiveSet | null = null;
    let prevBestWeightKg: number | null = null;

    if (priorWeightsGrams.length > 0) {
      if (weightMode === 'assisted') {
        const priorMinGrams = Math.min(...priorWeightsGrams);
        prevBestWeightKg = priorMinGrams / 1000;
        for (const st of curWeightedSets) {
          if (st.weightGrams! < priorMinGrams) {
            if (
              !weightPrSet ||
              st.weightGrams! < weightPrSet.weightGrams! ||
              (st.weightGrams === weightPrSet.weightGrams && st.reps > weightPrSet.reps)
            ) {
              weightPrSet = st;
            }
          }
        }
      } else {
        const positivePrior = priorWeightsGrams.filter((g) => g > 0);
        if (positivePrior.length > 0) {
          const priorMaxGrams = Math.max(...positivePrior);
          prevBestWeightKg = priorMaxGrams / 1000;
          for (const st of curWeightedSets) {
            if (st.weightGrams! > priorMaxGrams && st.weightGrams! > 0) {
              if (
                !weightPrSet ||
                st.weightGrams! > weightPrSet.weightGrams! ||
                (st.weightGrams === weightPrSet.weightGrams && st.reps > weightPrSet.reps)
              ) {
                weightPrSet = st;
              }
            }
          }
        }
      }
    }

    if (weightPrSet && weightPrSet.weightKg !== null && prevBestWeightKg !== null) {
      const prefix = weightMode === 'assisted' ? '辅助 ' : '';
      pushAchievement({
        kind: 'weight-pr',
        isPr: true,
        stampLabel: '重量 PR',
        detailText: `${prefix}${fmtWeight(weightPrSet.weightKg)} kg × ${weightPrSet.reps}（原最佳 ${prefix}${fmtWeight(prevBestWeightKg)} kg）`,
        sessionExerciseId: primaryEx.id,
        exerciseId: primaryEx.exerciseId,
        exerciseName: primaryEx.name,
        comparabilityKey: key,
        weightMode,
        dumbbellBasis,
        weightKg: weightPrSet.weightKg,
        reps: weightPrSet.reps,
        previousBestWeightKg: prevBestWeightKg,
      });
    }

    // 2) 同重次数 PR（在历史曾练过的同一重量下刷新单组次数）
    let bestSameWeightSet: { set: ValidPositiveSet; prevReps: number } | null = null;
    for (const st of curWeightedSets) {
      const wg = st.weightGrams!;
      if (weightPrSet && wg === weightPrSet.weightGrams) continue;
      const prevReps = priorBestRepsAtWeight.get(wg);
      if (prevReps === undefined || prevReps <= 0) continue;
      if (st.reps > prevReps) {
        if (
          !bestSameWeightSet ||
          (weightMode === 'assisted'
            ? wg < bestSameWeightSet.set.weightGrams!
            : wg > bestSameWeightSet.set.weightGrams!) ||
          (wg === bestSameWeightSet.set.weightGrams && st.reps > bestSameWeightSet.set.reps)
        ) {
          bestSameWeightSet = { set: st, prevReps };
        }
      }
    }

    if (bestSameWeightSet && bestSameWeightSet.set.weightKg !== null) {
      const prefix = weightMode === 'assisted' ? '辅助 ' : '';
      pushAchievement({
        kind: 'reps-at-weight-pr',
        isPr: true,
        stampLabel: '同重次数 PR',
        detailText: `${prefix}${fmtWeight(bestSameWeightSet.set.weightKg)} kg × ${bestSameWeightSet.set.reps} 次（原最佳 ${bestSameWeightSet.prevReps} 次）`,
        sessionExerciseId: primaryEx.id,
        exerciseId: primaryEx.exerciseId,
        exerciseName: primaryEx.name,
        comparabilityKey: key,
        weightMode,
        dumbbellBasis,
        weightKg: bestSameWeightSet.set.weightKg,
        reps: bestSameWeightSet.set.reps,
        previousBestReps: bestSameWeightSet.prevReps,
      });
    }
  }

  return { sessionId: targetSession.id, prs, firstRecords, bySessionExerciseId };
}
