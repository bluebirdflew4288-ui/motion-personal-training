/* 通用递减组构造（C01）。
   目标：任意动作都能被配置成递减组，不依赖名称或预设。
   两条入口共用这里的纯函数：
   A. 计划编辑（影响未来训练）
   B. 正在训练（只影响本次）

   约束：
   · 阶段数 2–6（超限明确报错，不静默裁剪）
   · 每阶段：建议重量、次数范围 或 技术性力竭
   · 阶段间休息 + 轮间休息
   · 已有实际记录的结构修改只能作用于「未开始的完整组/轮」 */

import type { DropSetTarget, DropStageTarget, ExerciseTarget, StraightTarget } from './types';
import { MAX_ROUNDS, MAX_STAGES, MAX_STRAIGHT_SETS, MIN_ROUNDS, MIN_STAGES } from './limits';

export { MAX_ROUNDS, MAX_STAGES, MIN_ROUNDS, MIN_STAGES };

export interface StageDraft {
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  toFailure: boolean;
}

export interface DropSetDraft {
  rounds: number;
  stages: StageDraft[];
  restInSec: number;
  restAfterSec: number;
  weightMode: StraightTarget['weightMode'];
  dumbbellBasis?: StraightTarget['dumbbellBasis'];
  /** 从普通组转换时的原组数（仅用于界面提示「N 组 → N 轮」），不写入目标 */
  sourceSets?: number;
}

export interface DraftIssue {
  path: string;
  message: string;
}

/** 默认 3 阶段配置（最常见的递减结构，但用户可以改成 2–6） */
export function defaultDropDraft(base?: { weightKg?: number | null; repsMin?: number; repsMax?: number }): DropSetDraft {
  const w = base?.weightKg ?? null;
  const lo = base?.repsMin ?? 8;
  const hi = base?.repsMax ?? 12;
  return {
    rounds: 3,
    stages: [
      { weightKg: w, repsMin: lo, repsMax: hi, toFailure: false },
      { weightKg: w !== null ? Math.max(0, w * 0.8) : null, repsMin: lo, repsMax: hi, toFailure: false },
      { weightKg: w !== null ? Math.max(0, w * 0.6) : null, repsMin: null, repsMax: null, toFailure: true },
    ],
    restInSec: 15,
    restAfterSec: 180,
    weightMode: 'external',
  };
}

/**
 * 把普通组目标转成递减组草稿。
 * V3-05：必须保留计量口径（weightMode / dumbbellBasis）——
 * 旧实现走 defaultDropDraft，把辅助 70kg 变成外部负重、并丢掉「哑铃按单只」，
 * 用户没有明确改口径，含义却被改变了（审查 F-MODE-CONVERT）。
 * 同时保留普通组的组数意图（作为递减轮数的初值），并在草稿里记住来源组数，
 * 便于 UI 明确展示「这次转换会变成几轮」。
 */
export function straightToDropDraft(t: StraightTarget): DropSetDraft {
  const base = defaultDropDraft({
    weightKg: t.suggestedWeightKg,
    repsMin: t.repsMin,
    repsMax: t.repsMax,
  });
  return {
    ...base,
    // 组数 → 轮数：普通 3 组转递减默认 3 轮，用户仍可改
    rounds: Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, t.sets || base.rounds)),
    weightMode: t.weightMode,
    dumbbellBasis: t.dumbbellBasis,
    sourceSets: t.sets,
  };
}

/** 递减组目标转普通组目标（V3-05：同样保留计量口径） */
export function dropToStraightTarget(t: DropSetTarget): StraightTarget {
  const first = t.stages[0];
  return {
    kind: 'straight',
    sets: Math.min(MAX_STRAIGHT_SETS, Math.max(1, t.rounds)),
    setsMax: Math.min(MAX_STRAIGHT_SETS, Math.max(1, t.rounds)),
    repsMin: first?.repsMin ?? 8,
    repsMax: first?.repsMax ?? 12,
    weightMode: t.weightMode,
    suggestedWeightKg: first?.weightKg ?? null,
    dumbbellBasis: t.dumbbellBasis,
  };
}

/** 校验草稿，返回全部问题（用于保存前定位字段） */
export function validateDropDraft(d: DropSetDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!Number.isInteger(d.rounds) || d.rounds < MIN_ROUNDS || d.rounds > MAX_ROUNDS) {
    issues.push({ path: 'rounds', message: `轮数必须是 ${MIN_ROUNDS}–${MAX_ROUNDS} 的整数` });
  }
  if (d.stages.length < MIN_STAGES) {
    issues.push({ path: 'stages', message: `递减组至少需要 ${MIN_STAGES} 个阶段` });
  }
  if (d.stages.length > MAX_STAGES) {
    issues.push({ path: 'stages', message: `最多 ${MAX_STAGES} 个阶段` });
  }
  d.stages.forEach((st, i) => {
    const p = `stages[${i}]`;
    if (st.weightKg !== null) {
      if (!Number.isFinite(st.weightKg) || st.weightKg < 0 || st.weightKg > 999) {
        issues.push({ path: `${p}.weightKg`, message: '重量必须是 0–999 的数值' });
      }
    }
    if (st.toFailure) {
      // 技术性力竭：允许不填次数目标
      return;
    }
    if (st.repsMin === null || st.repsMax === null) {
      issues.push({ path: `${p}.reps`, message: '非力竭阶段必须填次数范围' });
      return;
    }
    if (!Number.isInteger(st.repsMin) || !Number.isInteger(st.repsMax)) {
      issues.push({ path: `${p}.reps`, message: '次数必须是整数' });
      return;
    }
    if (st.repsMin < 0 || st.repsMax > 500) {
      issues.push({ path: `${p}.reps`, message: '次数必须在 0–500 之间' });
    }
    // R10：禁止 20–10 这类反向范围
    if (st.repsMin > st.repsMax) {
      issues.push({ path: `${p}.reps`, message: `次数下限 ${st.repsMin} 大于上限 ${st.repsMax}` });
    }
  });
  if (!Number.isInteger(d.restInSec) || d.restInSec < 0 || d.restInSec > 600) {
    issues.push({ path: 'restInSec', message: '阶段间休息必须是 0–600 秒的整数' });
  }
  if (!Number.isInteger(d.restAfterSec) || d.restAfterSec < 0 || d.restAfterSec > 3600) {
    issues.push({ path: 'restAfterSec', message: '轮间休息必须是 0–3600 秒的整数' });
  }
  return issues;
}

/** 草稿 → 领域目标（只在校验通过后调用） */
export function draftToDropTarget(d: DropSetDraft): DropSetTarget {
  const stages: DropStageTarget[] = d.stages.map((st, i) => ({
    label: `第 ${i + 1} 阶段`,
    weightKg: st.weightKg,
    repsMin: st.repsMin,
    repsMax: st.repsMax,
    toFailure: st.toFailure,
    targetText: st.toFailure
      ? `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}技术性力竭`
      : `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}${st.repsMin ?? 0}–${st.repsMax ?? 0} 次`,
  }));
  return {
    kind: 'dropSet',
    rounds: d.rounds,
    stages,
    restInSec: d.restInSec,
    restAfterSec: d.restAfterSec,
    weightMode: d.weightMode,
    dumbbellBasis: d.dumbbellBasis,
  };
}

/** 领域目标 → 草稿（用于「修改已存在的递减组」） */
export function dropTargetToDraft(t: DropSetTarget): DropSetDraft {
  return {
    rounds: t.rounds,
    stages: t.stages.map((st) => ({
      weightKg: st.weightKg,
      repsMin: st.repsMin,
      repsMax: st.repsMax,
      toFailure: st.toFailure,
    })),
    restInSec: t.restInSec,
    restAfterSec: t.restAfterSec,
    weightMode: t.weightMode,
    dumbbellBasis: t.dumbbellBasis,
  };
}

/** 由任意目标取出一份草稿（普通组按默认值生成） */
export function draftFromTarget(t: ExerciseTarget): DropSetDraft {
  return t.kind === 'dropSet' ? dropTargetToDraft(t) : straightToDropDraft(t);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** 结构摘要，用于 UI 预览（保存前给用户看） */
export function describeDropDraft(d: DropSetDraft): string {
  const parts = d.stages.map((st) => {
    const w = st.weightKg !== null ? `${trimNum(st.weightKg)}kg` : '—';
    if (st.toFailure) return `${w} 力竭`;
    return `${w} × ${st.repsMin ?? 0}–${st.repsMax ?? 0}`;
  });
  return `${d.rounds} 轮 × ${d.stages.length} 阶段｜${parts.join(' → ')}`;
}

/** 新增/删除/排序阶段（纯函数，供 UI 调用） */
export function addStage(d: DropSetDraft): DropSetDraft {
  if (d.stages.length >= MAX_STAGES) return d;
  const last = d.stages[d.stages.length - 1];
  const next: StageDraft = {
    weightKg: last?.weightKg !== null && last?.weightKg !== undefined ? Math.max(0, last.weightKg - 2.5) : null,
    repsMin: last?.repsMin ?? 8,
    repsMax: last?.repsMax ?? 12,
    toFailure: false,
  };
  return { ...d, stages: [...d.stages, next] };
}

export function removeStage(d: DropSetDraft, index: number): DropSetDraft {
  if (d.stages.length <= MIN_STAGES) return d;
  return { ...d, stages: d.stages.filter((_, i) => i !== index) };
}

export function moveStage(d: DropSetDraft, index: number, dir: -1 | 1): DropSetDraft {
  const target = index + dir;
  if (index < 0 || target < 0 || target >= d.stages.length) return d;
  const stages = [...d.stages];
  const a = stages[index];
  stages[index] = stages[target];
  stages[target] = a;
  return { ...d, stages };
}

export function updateStage(d: DropSetDraft, index: number, patch: Partial<StageDraft>): DropSetDraft {
  return {
    ...d,
    stages: d.stages.map((st, i) => (i === index ? { ...st, ...patch } : st)),
  };
}
