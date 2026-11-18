/* Wave 3A：结束训练时可选「将今日动作编排同步回原计划」的纯函数层。
   设计红线：
   1) 纯配置提纯：严禁把 SessionExercise 的 sets / status / groups / replacedFrom / added / note（当次训练感受）带入 PlanExercise；
   2) 身份连续性：原计划内保留下来的条目沿用既有 PlanExercise.id（及原计划条目的提示 note / substitutes），临时新增或替换身份后的动作生成干净稳定 id；
   3) 容量与目标合法性：与编辑器/备份校验共用 MAX_EXERCISES、MAX_STRAIGHT_SETS、MAX_ROUNDS、validateExerciseTarget 真源，超限或非法明确拒绝。 */

import { ensureStageIds, validateExerciseTarget } from './exerciseConfig';
import { resolveExerciseId } from './identity';
import {
  MAX_EXERCISE_ID,
  MAX_EXERCISES,
  MAX_REST,
  MAX_ROUNDS,
  MAX_STAGES_ACCEPTED,
  MAX_STRAIGHT_SETS,
  MIN_ROUNDS,
} from './limits';
import type {
  DropSetTarget,
  ExerciseTarget,
  Plan,
  PlanExercise,
  Session,
  SessionExercise,
  StraightTarget,
} from './types';

export interface PlanSyncDiff {
  /** 是否满足同步资格（计划来源 + 力量训练 + 原计划与力量训练日仍存在 + 目标合法） */
  canSync: boolean;
  /** 与原计划训练日相比是否存在实质编排变化 */
  hasDiff: boolean;
  /** UI 是否应展示「同步回原计划」复选框（canSync && hasDiff） */
  eligible: boolean;
  planId: string;
  planName: string;
  dayId: string;
  dayName: string;
  addedCount: number;
  removedCount: number;
  replacedCount: number;
  reordered: boolean;
  configChangedCount: number;
  summaryText: string;
  nextExercises: PlanExercise[];
  blockerMessage?: string;
}

function cleanTargetFromSessionExercise(ex: SessionExercise): ExerciseTarget {
  const raw = structuredClone(ex.target);
  if (raw.kind === 'straight') {
    const sets = Math.max(0, Math.min(MAX_STRAIGHT_SETS, ex.groups.length));
    const hadRange = raw.setsMax > raw.sets;
    const setsMax = hadRange ? Math.max(sets, Math.min(MAX_STRAIGHT_SETS, raw.setsMax)) : sets;
    const next: StraightTarget = {
      kind: 'straight',
      sets,
      setsMax,
      repsMin: raw.repsMin,
      repsMax: raw.repsMax,
      weightMode: raw.weightMode,
      suggestedWeightKg: raw.suggestedWeightKg,
      ...(raw.dumbbellBasis !== undefined ? { dumbbellBasis: raw.dumbbellBasis } : {}),
      ...(typeof raw.toFailure === 'boolean' ? { toFailure: raw.toFailure } : {}),
    };
    if (Array.isArray(raw.perSetConfigs) && sets > 0) {
      const kept = raw.perSetConfigs
        .filter((c) => Number.isInteger(c.setIndex) && c.setIndex >= 1 && c.setIndex <= sets)
        .map((c) => ({
          setIndex: c.setIndex,
          repsMin: c.repsMin,
          repsMax: c.repsMax,
          suggestedWeightKg: c.suggestedWeightKg,
          toFailure: Boolean(c.toFailure),
        }))
        .sort((a, b) => a.setIndex - b.setIndex);
      if (kept.length > 0) {
        next.perSetConfigs = kept;
      }
    }
    return next;
  }

  const rounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, ex.groups.length || raw.rounds));
  const drop: DropSetTarget = {
    kind: 'dropSet',
    ...(raw.form !== undefined ? { form: raw.form } : {}),
    rounds,
    stages: raw.stages.map((st) => ({
      ...(typeof st.id === 'string' && st.id.trim() ? { id: st.id.trim() } : {}),
      label: st.label,
      weightKg: st.weightKg,
      repsMin: st.repsMin,
      repsMax: st.repsMax,
      toFailure: Boolean(st.toFailure),
      ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
      targetText: st.targetText ?? '',
    })),
    restInSec: raw.restInSec,
    restAfterSec: raw.restAfterSec,
    weightMode: raw.weightMode,
    ...(raw.dumbbellBasis !== undefined ? { dumbbellBasis: raw.dumbbellBasis } : {}),
  };
  if (Array.isArray(raw.roundConfigs) && raw.roundConfigs.length > 0) {
    const keptRounds = raw.roundConfigs
      .filter((rc) => Number.isInteger(rc.roundIndex) && rc.roundIndex >= 1 && rc.roundIndex <= rounds)
      .map((rc) => ({
        roundIndex: rc.roundIndex,
        stages: rc.stages.map((st) => ({
          ...(typeof st.id === 'string' && st.id.trim() ? { id: st.id.trim() } : {}),
          label: st.label,
          weightKg: st.weightKg,
          repsMin: st.repsMin,
          repsMax: st.repsMax,
          toFailure: Boolean(st.toFailure),
          ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
          targetText: st.targetText ?? '',
        })),
        ...(rc.restInSec !== undefined ? { restInSec: rc.restInSec } : {}),
      }))
      .sort((a, b) => a.roundIndex - b.roundIndex);
    if (keptRounds.length > 0) {
      drop.roundConfigs = keptRounds;
    }
  }
  return ensureStageIds(drop);
}

function makeFallbackPlanExerciseId(rawExId: string, index: number, usedIds: Set<string>): string {
  const sanitized = rawExId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || `item${index + 1}`;
  let candidate = `pe-${sanitized}`.slice(0, 120);
  let suffix = 2;
  while (usedIds.has(candidate)) {
    const tail = `-${suffix}`;
    candidate = `pe-${sanitized.slice(0, 116 - tail.length)}${tail}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * 将训练实例中的动作列表提纯为干净的 `PlanExercise[]`。
 * 剥离一切运行态/当次实际记录字段（sets / status / groups / replacedFrom / added / session note）。
 */
export function extractCleanPlanExercises(
  exercises: readonly SessionExercise[],
  originalPlanExercises: readonly PlanExercise[] = [],
): PlanExercise[] {
  const origById = new Map<string, PlanExercise>();
  for (const pe of originalPlanExercises) {
    origById.set(pe.id, pe);
  }
  const usedIds = new Set<string>();

  return exercises.map((ex, idx) => {
    const target = cleanTargetFromSessionExercise(ex);
    let id: string;
    if (
      typeof ex.planExerciseId === 'string' &&
      ex.planExerciseId.trim().length > 0 &&
      ex.planExerciseId.length <= 120 &&
      !usedIds.has(ex.planExerciseId)
    ) {
      id = ex.planExerciseId;
    } else {
      id = makeFallbackPlanExerciseId(ex.id, idx, usedIds);
    }
    usedIds.add(id);

    const trimmedName = ex.name.trim() || ex.name;
    const fallbackEx: PlanExercise = {
      id,
      name: trimmedName,
      restSec: ex.restSec,
      target,
    };
    const exerciseId =
      typeof ex.exerciseId === 'string' && ex.exerciseId.trim().length > 0
        ? ex.exerciseId.trim()
        : resolveExerciseId(fallbackEx);

    const orig = origById.get(id);
    const origExerciseId = orig ? (orig.exerciseId ?? resolveExerciseId(orig)) : null;
    const sameIdentityAsOrig = Boolean(orig && origExerciseId === exerciseId);

    const clean: PlanExercise = {
      id,
      exerciseId,
      name: trimmedName,
      ...(typeof ex.en === 'string' && ex.en.trim().length > 0 ? { en: ex.en } : {}),
      restSec: ex.restSec,
      target,
      ...(sameIdentityAsOrig && orig?.note !== undefined ? { note: orig.note } : {}),
      ...(sameIdentityAsOrig && orig?.substitutes !== undefined
        ? { substitutes: [...orig.substitutes] }
        : {}),
    };
    return clean;
  });
}

function canonicalTargetKey(target: ExerciseTarget): string {
  if (target.kind === 'straight') {
    const perSet = (target.perSetConfigs ?? [])
      .slice()
      .sort((a, b) => a.setIndex - b.setIndex)
      .map((c) => ({
        setIndex: c.setIndex,
        repsMin: c.repsMin,
        repsMax: c.repsMax,
        suggestedWeightKg: c.suggestedWeightKg,
        toFailure: Boolean(c.toFailure),
      }));
    return JSON.stringify({
      kind: 'straight',
      sets: target.sets,
      setsMax: target.setsMax,
      repsMin: target.repsMin,
      repsMax: target.repsMax,
      weightMode: target.weightMode,
      dumbbellBasis: target.dumbbellBasis ?? 'total',
      suggestedWeightKg: target.suggestedWeightKg,
      toFailure: Boolean(target.toFailure),
      perSetConfigs: perSet,
    });
  }

  const normStages = (stages: DropSetTarget['stages']) =>
    stages.map((st) => ({
      label: st.label.trim(),
      weightKg: st.weightKg,
      repsMin: st.repsMin,
      repsMax: st.repsMax,
      toFailure: Boolean(st.toFailure),
      restAfterSec: st.restAfterSec ?? null,
    }));

  const roundConfigs = (target.roundConfigs ?? [])
    .slice()
    .sort((a, b) => a.roundIndex - b.roundIndex)
    .map((rc) => ({
      roundIndex: rc.roundIndex,
      restInSec: rc.restInSec ?? null,
      stages: normStages(rc.stages),
    }));

  return JSON.stringify({
    kind: 'dropSet',
    form: target.form ?? 'dropSet',
    rounds: target.rounds,
    restInSec: target.restInSec,
    restAfterSec: target.restAfterSec,
    weightMode: target.weightMode,
    dumbbellBasis: target.dumbbellBasis ?? 'total',
    stages: normStages(target.stages),
    roundConfigs,
  });
}

function canonicalPlanExerciseSignature(pe: PlanExercise): string {
  const exerciseId = pe.exerciseId ?? resolveExerciseId(pe);
  return JSON.stringify({
    exerciseId,
    name: pe.name.trim(),
    en: (pe.en ?? '').trim(),
    restSec: pe.restSec,
    target: canonicalTargetKey(pe.target),
  });
}

function validateExtractedPlanExercises(list: readonly PlanExercise[]): string | null {
  if (list.length > MAX_EXERCISES) {
    return `动作数量（${list.length}）超过计划单日上限 ${MAX_EXERCISES} 个，无法同步回原计划`;
  }
  for (let i = 0; i < list.length; i += 1) {
    const pe = list[i];
    if (!pe.id || pe.id.length > 120) {
      return `第 ${i + 1} 个动作的条目 ID 不合法`;
    }
    if (!pe.name.trim() || pe.name.length > 200) {
      return `第 ${i + 1} 个动作的名称长度不合法`;
    }
    if (pe.en !== undefined && pe.en.length > 200) {
      return `「${pe.name}」的英文名超过 200 字符上限`;
    }
    if (pe.exerciseId !== undefined && pe.exerciseId.length > MAX_EXERCISE_ID) {
      return `「${pe.name}」的动作身份标识超过 ${MAX_EXERCISE_ID} 字符上限`;
    }
    if (!Number.isInteger(pe.restSec) || pe.restSec < 0 || pe.restSec > MAX_REST) {
      return `「${pe.name}」的休息秒数超出合法范围（0–${MAX_REST} 秒）`;
    }
    const issues = validateExerciseTarget(pe.target, {
      minStages: 1,
      maxStages: MAX_STAGES_ACCEPTED,
    });
    if (issues.length > 0) {
      return `「${pe.name}」的目标配置不合法：${issues[0].message}`;
    }
  }
  return null;
}

/**
 * 对比当前训练实例与目标计划训练日的编排差异。
 */
export function diffSessionVsPlanDay(session: Session, plan: Plan | undefined): PlanSyncDiff {
  const emptyBase = {
    canSync: false,
    hasDiff: false,
    eligible: false,
    planId: session.planId,
    planName: plan?.name ?? session.planName,
    dayId: session.day.dayId,
    dayName: session.day.dayName,
    addedCount: 0,
    removedCount: 0,
    replacedCount: 0,
    reordered: false,
    configChangedCount: 0,
    summaryText: '',
    nextExercises: [] as PlanExercise[],
  };

  if ((session.origin ?? 'plan') !== 'plan') {
    return emptyBase;
  }
  if ((session.kind ?? 'strength') !== 'strength') {
    return emptyBase;
  }
  if (!plan) {
    return { ...emptyBase, blockerMessage: '原计划已被删除，无法同步回计划' };
  }
  const day = plan.days.find((d) => d.id === session.day.dayId);
  if (!day || day.kind !== 'train') {
    return { ...emptyBase, blockerMessage: '原训练日已不存在或不再是力量训练日' };
  }

  const nextExercises = extractCleanPlanExercises(session.exercises, day.exercises);
  const validationError = validateExtractedPlanExercises(nextExercises);
  if (validationError) {
    return {
      ...emptyBase,
      dayName: day.name,
      nextExercises,
      blockerMessage: validationError,
    };
  }

  const origList = day.exercises;
  const origById = new Map(origList.map((e) => [e.id, e]));
  const origOrder = new Map(origList.map((e, idx) => [e.id, idx]));

  const keptOrigIds: string[] = [];
  let configChangedCount = 0;
  for (const pe of nextExercises) {
    const orig = origById.get(pe.id);
    if (orig) {
      keptOrigIds.push(pe.id);
      if (canonicalPlanExerciseSignature(orig) !== canonicalPlanExerciseSignature(pe)) {
        configChangedCount += 1;
      }
    }
  }

  let reordered = false;
  for (let i = 1; i < keptOrigIds.length; i += 1) {
    const prevIdx = origOrder.get(keptOrigIds[i - 1]) ?? -1;
    const curIdx = origOrder.get(keptOrigIds[i]) ?? -1;
    if (curIdx < prevIdx) {
      reordered = true;
      break;
    }
  }

  const replacedCount = session.exercises.filter(
    (ex) => Boolean(ex.replacedFrom) && !origById.has(ex.planExerciseId ?? ''),
  ).length;
  const rawNewCount = nextExercises.length - keptOrigIds.length;
  const rawRemovedCount = origList.length - keptOrigIds.length;
  const effectiveReplaced = Math.min(replacedCount, rawNewCount, rawRemovedCount);
  const addedCount = Math.max(0, rawNewCount - effectiveReplaced);
  const removedCount = Math.max(0, rawRemovedCount - effectiveReplaced);

  const exactSameSequence =
    origList.length === nextExercises.length &&
    origList.every(
      (orig, idx) =>
        orig.id === nextExercises[idx].id &&
        canonicalPlanExerciseSignature(orig) === canonicalPlanExerciseSignature(nextExercises[idx]),
    );

  if (!exactSameSequence && !reordered && addedCount === 0 && removedCount === 0 && effectiveReplaced === 0 && configChangedCount === 0) {
    reordered = true;
  }

  const hasDiff = !exactSameSequence;
  const parts: string[] = [];
  if (reordered) parts.push('调整了顺序');
  if (effectiveReplaced > 0) parts.push(`替换 ${effectiveReplaced} 个动作`);
  if (addedCount > 0) parts.push(`新增 ${addedCount} 个动作`);
  if (removedCount > 0) parts.push(`移除 ${removedCount} 个动作`);
  if (configChangedCount > 0) parts.push(`修改了 ${configChangedCount} 处组/目标配置`);
  const summaryText = hasDiff ? (parts.join(' · ') || '调整了动作编排') : '';

  return {
    canSync: true,
    hasDiff,
    eligible: hasDiff,
    planId: plan.id,
    planName: plan.name,
    dayId: day.id,
    dayName: day.name,
    addedCount,
    removedCount,
    replacedCount: effectiveReplaced,
    reordered,
    configChangedCount,
    summaryText,
    nextExercises,
  };
}

/**
 * 在结束训练事务内将 session 的编排应用到最新读取的 `Plan` 上。
 */
export function applySessionArrangementToPlan(
  plan: Plan,
  dayId: string,
  session: Session,
  now = Date.now(),
): { ok: true; plan: Plan } | { ok: false; message: string } {
  if ((session.origin ?? 'plan') !== 'plan') {
    return { ok: false, message: '临时训练不属于固定计划日，不能同步回原计划' };
  }
  if ((session.kind ?? 'strength') !== 'strength') {
    return { ok: false, message: '当前仅支持将力量训练日的动作编排同步回原计划' };
  }
  const day = plan.days.find((d) => d.id === dayId);
  if (!day) {
    return { ok: false, message: '原计划中的对应训练日已被删除，无法同步动作编排（取消勾选后可正常结束训练）' };
  }
  if (day.kind !== 'train') {
    return { ok: false, message: '原计划中的该训练日已不再是力量日，无法同步动作编排（取消勾选后可正常结束训练）' };
  }

  const nextExercises = extractCleanPlanExercises(session.exercises, day.exercises);
  const validationError = validateExtractedPlanExercises(nextExercises);
  if (validationError) {
    return { ok: false, message: validationError };
  }

  const updatedPlan: Plan = {
    ...plan,
    updatedAt: now,
    days: plan.days.map((d) => (d.id === dayId ? { ...d, exercises: nextExercises } : d)),
  };
  return { ok: true, plan: updatedPlan };
}
