/* Wave 3C.1：同口径渐进超负荷温和提示（纯函数，零副作用，绝不自动篡改目标重量）。
   规则：
   · 严格要求同一可比口径（exerciseId + weightMode + dumbbellBasis）；
   · 检查最近一次含有效记录的已完成同口径动作：
     - 完成了当前目标要求的全部正式组/轮（1..targetGroups），且每阶段均为有效 done；
     - 至少存在一个非力竭且 repsMax > 0 的目标组/阶段；
     - 所有非力竭组/阶段的实际完成次数均达到上限（reps >= repsMax）；
     - 若当前目标显式填写了参考重量（suggestedWeightKg / stage.weightKg），上次对应组的实际负重也须已达到该目标水平（辅助模式为 ≤ 目标辅助重量，其余外加负重模式为 ≥ 目标重量），避免用户已经手动加码后仍重复提示。 */

import { comparabilityOf } from './comparability';
import { resolveGroupConfig, targetGroupCount, targetStageCountForGroup } from './exerciseConfig';
import { hasReps, isSetLogged } from './session';
import type { Session, SessionExercise } from './types';

export const PROGRESSION_HINT_TEXT = '↑ 上次已满上限';

function weightMeetsTarget(
  weightMode: SessionExercise['target']['weightMode'],
  actualWeightKg: number | null,
  targetWeightKg: number | null,
): boolean {
  if (targetWeightKg === null) return true;
  if (actualWeightKg === null || !Number.isFinite(actualWeightKg)) return false;
  if (weightMode === 'assisted') {
    return actualWeightKg <= targetWeightKg;
  }
  if (weightMode === 'bodyweight') {
    return true;
  }
  return actualWeightKg >= targetWeightKg;
}

/**
 * 基于最近一次同口径动作记录，判断当前动作是否满足「上次已满上限」提示条件。
 */
export function evaluateProgressionHint(
  currentEx: SessionExercise,
  lastSameModeEx: SessionExercise | null | undefined,
): string | null {
  if (!lastSameModeEx) return null;
  if (comparabilityOf(currentEx) !== comparabilityOf(lastSameModeEx)) return null;

  const target = currentEx.target;
  const requiredGroups = targetGroupCount(target);
  if (requiredGroups <= 0) return null;

  let checkedBoundedCount = 0;

  for (let gi = 1; gi <= requiredGroups; gi += 1) {
    const stageCount = targetStageCountForGroup(target, gi);
    if (stageCount <= 0) return null;

    for (let si = 1; si <= stageCount; si += 1) {
      const cfg = resolveGroupConfig(target, gi, si);
      const actual = lastSameModeEx.sets.find(
        (s) => s.roundIndex === gi && s.stageIndex === si && isSetLogged(s),
      );
      if (!actual || !hasReps(actual) || actual.reps === null) {
        return null;
      }

      if (!weightMeetsTarget(target.weightMode, actual.weightKg, cfg.weightKg)) {
        return null;
      }

      if (cfg.toFailure) {
        continue;
      }

      if (cfg.repsMax === null || cfg.repsMax <= 0) {
        return null;
      }

      if (actual.reps < cfg.repsMax) {
        return null;
      }
      checkedBoundedCount += 1;
    }
  }

  return checkedBoundedCount > 0 ? PROGRESSION_HINT_TEXT : null;
}

/**
 * 从已完成历史列表中为指定会话计算 `comparabilityKey -> SessionExercise` 最近同口径映射。
 */
export function findLatestComparableExerciseMap(
  completedSessions: readonly Session[],
  excludeSessionId?: string,
): Map<string, SessionExercise> {
  const sorted = completedSessions
    .filter((s) => s.status === 'completed' && Boolean(s.endedAt) && s.id !== excludeSessionId)
    .slice()
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  const latestByKey = new Map<string, SessionExercise>();
  for (const s of sorted) {
    for (const ex of s.exercises) {
      const key = comparabilityOf(ex);
      if (latestByKey.has(key)) continue;
      if (!ex.sets.some(isSetLogged)) continue;
      latestByKey.set(key, ex);
    }
  }
  return latestByKey;
}
