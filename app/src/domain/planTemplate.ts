/* 固定 JSON 计划模板（第3阶段，BRIEF 第5项）。
   ── 契约（PHASE-3-IMPLEMENT + PHASE-2-DECISIONS §6）─────────
   · 独立格式 `motion-plan-template` v1，单个 plan 内容；
     与全量备份 motion-training-backup **完全隔离**（后者出现在此入口 → 明确拒绝）。
   · **不暴露**存储身份/时间/cursor/revision/session/settings —— 出现即拒绝。
   · 严格逐层校验：未知字段、不适用字段、错误单位/数值/范围/步长、超限、
     未来版本一律**明确拒绝**；不静默猜测、不截断。
   · 新模板能力=现有编辑器能力：递减阶段 **2–6**（MAX_STAGES），
     旧备份容忍 12 阶段（MAX_STAGES_ACCEPTED）**不**变成新建模板能力。
   · 确认后 App 本地生成 plan/day/exercise/warmup/cardio 身份与时间，
     动作身份走既有 resolveExerciseId（预设映射 / custom:规范化名称），cursor=0。
   · 只能 insert 新记录：写入走 db/tx.ts 的 atomicInsertPlan（同事务容量+查重），
     不复用 upsert/savePlan 覆盖旧数据。 */

import {
  MAX_CARDIO_ENTRIES,
  MAX_DAYS,
  MAX_EXERCISES,
  MAX_INCLINE_PCT,
  MAX_PLAN_NAME,
  MAX_REPS,
  MAX_REST,
  MAX_REST_IN_SEC,
  MAX_ROUNDS,
  MAX_SET_ROWS,
  MAX_SPEED_KMH,
  MAX_STAGES,
  MAX_STRAIGHT_SETS,
  MAX_TEXT,
  MIN_INCLINE_PCT,
  MIN_ROUNDS,
  MIN_SPEED_KMH,
  MIN_STAGES,
  SPEED_STEP_KMH,
  INCLINE_STEP_PCT,
} from './limits';
import { CARDIO_PRESETS, LEGACY_CARDIO_PRESETS, LEGACY_TRAINING_FOCUSES, TRAINING_FOCUSES, TRAINING_FOCUS_LABEL } from './types';
import { describeCardioParams, normalizeCardioParams, validateCardioParams } from './cardio';
import { parseSetupNote } from './setupNote';
import { resolveExerciseId } from './identity';
import { stabilizeDropTargetStageIds } from './exerciseConfig';
import type {
  CardioParams,
  CardioPreset,
  DumbbellBasis,
  Plan,
  PlanCardio,
  PlanDay,
  PlanExercise,
  WarmupTarget,
  WeightMode,
} from './types';
import type { DropSetTarget, DropStageTarget, ExerciseTarget, StraightTarget } from './types';

export const PLAN_TEMPLATE_FORMAT = 'motion-plan-template';
export const PLAN_TEMPLATE_VERSION = 2;
/** 全量备份的 format 值 —— 出现在模板入口必须拒绝 */
export const FULL_BACKUP_FORMAT = 'motion-training-backup';

export interface TemplateIssue {
  path: string;
  message: string;
}

export type TemplateResult =
  | { ok: true; plan: Plan }
  | { ok: false; issues: TemplateIssue[] };

/* ── 校验基础设施 ───────────────────────── */

class TCtx {
  constructor(readonly version: 1 | 2) {}
  issues: TemplateIssue[] = [];
  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }
  get failed(): boolean {
    return this.issues.length > 0;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 白名单检查：出现任何未知字段（含 id/createdAt/cursor/revision/status/segments 等
 * 存储身份、时间、状态、实际计时字段）都明确拒绝，并区分提示。
 */
function rejectUnknown(c: TCtx, obj: Record<string, unknown>, allowed: string[], path: string): void {
  const stored = new Set([
    'id', 'planId', 'dayId', 'exerciseId', 'planExerciseId', 'planCardioId', 'sessionId',
    'createdAt', 'updatedAt', 'startedAt', 'endedAt', 'savedAt', 'cursor', 'revision',
    'status', 'presetId', 'advancedCycle', 'cycleIndexAtStart', 'cycleIndexAfter',
    'elapsedMs', 'runningSinceAt', 'segments', 'startElapsedMs', 'endElapsedMs',
    'cardioPausedBySession', 'restDate', 'settings', 'theme', 'token',
  ]);
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    if (stored.has(key)) {
      c.add(`${path}.${key}`, `"${key}" 是 App 内部存储字段，模板不允许携带（身份与时间由 App 本地生成）`);
    } else {
      c.add(`${path}.${key}`, `未知字段 "${key}"（允许：${allowed.join(' / ') || '无'}）`);
    }
  }
}

function reqStr(c: TCtx, v: unknown, path: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    c.add(path, '必须是必填文本');
    return '';
  }
  if (v.length > max) c.add(path, `文本超过 ${max} 字符`);
  return v.trim();
}

function optStr(c: TCtx, v: unknown, path: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    c.add(path, '应为字符串');
    return undefined;
  }
  if (v.length > max) c.add(path, `文本超过 ${max} 字符`);
  return v;
}

function reqInt(c: TCtx, v: unknown, path: string, min: number, max: number, label: string): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.add(path, `${label}必须是数字（JSON 数字类型，不接受字符串）`);
    return null;
  }
  if (!Number.isInteger(v)) {
    c.add(path, `${label}必须是整数，实际是 ${v}`);
    return null;
  }
  if (v < min || v > max) {
    c.add(path, `${label}必须在 ${min}–${max} 之间，实际是 ${v}`);
    return null;
  }
  return v;
}

/**
 * 带步长的数值校验（超范围/非有限/非整倍步长明确拒绝，不 clamp、不四舍五入）。
 * 步长按十进制有理数比较，避免浮点误差把 4.5 误判为非法。
 */
function reqStepNum(
  c: TCtx,
  v: unknown,
  path: string,
  min: number,
  max: number,
  label: string,
  step = 0.1,
): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.add(path, `${label}必须是有限数字（不接受字符串/null）`);
    return null;
  }
  if (v < min || v > max) {
    c.add(path, `${label}必须在 ${min}–${max} 之间，实际是 ${v}`);
    return null;
  }
  const scaled = (v - min) / step;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    c.add(path, `${label}必须是 ${step} 的整数倍（从 ${min} 起），实际是 ${v}`);
    return null;
  }
  return v;
}

/**
 * 重量沿用现有编辑器契约：有限数值 + 范围即可，允许合法小配重精度（1.25/0.75…），
 * **不施加 0.1 步长**（那是模板新增的未批准限制）。不四舍五入、不截断。
 */
function reqWeightNum(
  c: TCtx,
  v: unknown,
  path: string,
  min: number,
  max: number,
  label: string,
): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.add(path, `${label}必须是有限数字（不接受字符串/null）`);
    return null;
  }
  if (v < min || v > max) {
    c.add(path, `${label}必须在 ${min}–${max} 之间，实际是 ${v}`);
    return null;
  }
  return v;
}

function oneOf<T extends string>(c: TCtx, v: unknown, path: string, allowed: readonly T[], label: string): T | null {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    c.add(path, `${label}只能是 ${allowed.join(' / ')}`);
    return null;
  }
  return v as T;
}

/* ── 各层解析（返回带默认值的"计划结构"，身份字段由 buildPlan 生成）── */

interface ParsedWarmup {
  name: string;
  en?: string;
  unit: WarmupTarget['unit'];
  targetText: string;
  optional?: boolean;
}

function parseWarmup(c: TCtx, v: unknown, path: string): ParsedWarmup | null {
  if (!isObj(v)) {
    c.add(path, '热身项必须是对象');
    return null;
  }
  rejectUnknown(c, v, ['name', 'en', 'unit', 'targetText', 'optional'], path);
  const name = reqStr(c, v.name, `${path}.name`, 200);
  const unit = oneOf(c, v.unit, `${path}.unit`, ['reps', 'time', 'breath'] as const, '记录单位');
  const targetText = reqStr(c, v.targetText, `${path}.targetText`, 200);
  let optional: boolean | undefined;
  if (v.optional !== undefined) {
    if (typeof v.optional !== 'boolean') c.add(`${path}.optional`, '应为布尔值');
    else optional = v.optional;
  }
  if (!name || !unit || !targetText) return null;
  return { name, en: optStr(c, v.en, `${path}.en`, 200), unit, targetText, optional };
}

const WEIGHT_MODES = ['external', 'bodyweight', 'bodyweight_plus', 'assisted'] as const;

function parseWeightFields(c: TCtx, v: Record<string, unknown>, path: string): {
  weightMode: WeightMode | null;
  suggestedWeightKg: number | null;
  dumbbellBasis?: DumbbellBasis;
} {
  const weightMode = oneOf(c, v.weightMode, `${path}.weightMode`, WEIGHT_MODES, '重量口径');
  let suggestedWeightKg: number | null = null;
  if (v.suggestedWeightKg !== undefined && v.suggestedWeightKg !== null) {
    const w = reqWeightNum(c, v.suggestedWeightKg, `${path}.suggestedWeightKg`, 0, 9999, '建议重量');
    if (w !== null) suggestedWeightKg = w;
  }
  let dumbbellBasis: DumbbellBasis | undefined;
  if (v.dumbbellBasis !== undefined) {
    const b = oneOf(c, v.dumbbellBasis, `${path}.dumbbellBasis`, ['per_hand', 'total'] as const, '哑铃口径');
    if (b) dumbbellBasis = b;
  }
  return { weightMode, suggestedWeightKg, dumbbellBasis };
}

function parseStraight(c: TCtx, v: Record<string, unknown>, path: string): StraightTarget | null {
  rejectUnknown(
    c,
    v,
    ['kind', 'sets', 'setsMax', 'repsMin', 'repsMax', 'weightMode', 'suggestedWeightKg', 'dumbbellBasis'],
    path,
  );
  const sets = reqInt(c, v.sets, `${path}.sets`, 1, MAX_STRAIGHT_SETS, '组数');
  const repsMin = reqInt(c, v.repsMin, `${path}.repsMin`, 0, MAX_REPS, '次数下限');
  const repsMax = reqInt(c, v.repsMax, `${path}.repsMax`, 0, MAX_REPS, '次数上限');
  const { weightMode, suggestedWeightKg, dumbbellBasis } = parseWeightFields(c, v, path);
  let setsMax = sets;
  if (v.setsMax !== undefined) {
    const m = reqInt(c, v.setsMax, `${path}.setsMax`, 1, MAX_STRAIGHT_SETS, '组数上限');
    if (m !== null) setsMax = m;
  }
  if (sets !== null && setsMax !== null && setsMax < sets) {
    c.add(`${path}.setsMax`, `组数上限 ${setsMax} 不能小于组数 ${sets}`);
  }
  if (repsMin !== null && repsMax !== null && repsMin > repsMax) {
    c.add(`${path}.repsMin`, `次数下限 ${repsMin} 不能大于上限 ${repsMax}`);
  }
  if (sets === null || repsMin === null || repsMax === null || !weightMode) return null;
  return {
    kind: 'straight',
    sets,
    setsMax: setsMax ?? sets,
    repsMin,
    repsMax,
    weightMode,
    suggestedWeightKg,
    dumbbellBasis,
  };
}

function trimNum(n: number): string {
  return String(n);
}

function stageText(st: DropStageTarget): string {
  return st.toFailure
    ? `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}技术性力竭`
    : `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}${st.repsMin ?? 0}–${st.repsMax ?? 0} 次`;
}

function parseDropStages(
  c: TCtx,
  list: unknown[],
  path: string,
  min: number,
  max: number,
  brokenRef: { broken: boolean },
): DropStageTarget[] {
  const stages: DropStageTarget[] = [];
  if (list.length < min || list.length > max) {
    c.add(path, `递减阶段数必须在 ${min}–${max} 之间（编辑器能力）`);
    brokenRef.broken = true;
    return stages;
  }
  list.forEach((sv, i) => {
    const sp = `${path}[${i}]`;
    if (!isObj(sv)) {
      c.add(sp, '阶段必须是对象');
      brokenRef.broken = true;
      return;
    }
    // R02 FIX3：阶段身份允许可选显式 id（跨轮同源阶段共享同一 id），
    // 由下面校验非空文本 + 同一阶段数组内唯一。
    rejectUnknown(c, sv, ['id', 'weightKg', 'repsMin', 'repsMax', 'toFailure'], sp);
    let stageId: string | undefined;
    if (sv.id !== undefined) {
      if (typeof sv.id !== 'string' || !sv.id.trim()) {
        c.add(`${sp}.id`, '阶段 ID 必须是非空文本');
        brokenRef.broken = true;
      } else if (sv.id.trim().length > 120) {
        c.add(`${sp}.id`, '阶段 ID 最多 120 个字符');
        brokenRef.broken = true;
      } else {
        stageId = sv.id.trim();
      }
    }
    let weightKg: number | null = null;
    if (sv.weightKg !== undefined && sv.weightKg !== null) {
      const w = reqWeightNum(c, sv.weightKg, `${sp}.weightKg`, 0, 999, '阶段重量');
      if (w === null) brokenRef.broken = true;
      else weightKg = w;
    }
    const toFailure = sv.toFailure === true;
    if (sv.toFailure !== undefined && typeof sv.toFailure !== 'boolean') {
      c.add(`${sp}.toFailure`, '应为布尔值');
      brokenRef.broken = true;
    }
    let repsMin: number | null = null;
    let repsMax: number | null = null;
    if (!toFailure) {
      // 非力竭阶段必须填次数范围（与编辑器 validateDropDraft 同一规则）
      repsMin = reqInt(c, sv.repsMin, `${sp}.repsMin`, 0, MAX_REPS, '次数下限');
      repsMax = reqInt(c, sv.repsMax, `${sp}.repsMax`, 0, MAX_REPS, '次数上限');
      if (repsMin === null || repsMax === null) brokenRef.broken = true;
      else if (repsMin > repsMax) {
        c.add(`${sp}.repsMin`, '次数下限不能大于上限');
        brokenRef.broken = true;
      }
    } else if (sv.repsMin !== undefined || sv.repsMax !== undefined) {
      c.add(sp, '技术性力竭阶段不需要次数范围');
      brokenRef.broken = true;
    }
    const stage: DropStageTarget = {
      ...(stageId ? { id: stageId } : {}),
      label: `第 ${i + 1} 阶段`,
      weightKg,
      repsMin,
      repsMax,
      toFailure,
      targetText: '',
    };
    stage.targetText = stageText(stage);
    stages.push(stage);
  });
  // 显式 id 必须在同一阶段数组内唯一；跨轮同源阶段共享 id 不受影响。
  const seenIds = new Set<string>();
  for (const stage of stages) {
    if (!stage.id) continue;
    if (seenIds.has(stage.id)) {
      c.add(path, `阶段 ID 重复：${stage.id}`);
      brokenRef.broken = true;
    }
    seenIds.add(stage.id);
  }
  return stages;
}

function parseDropSet(c: TCtx, v: Record<string, unknown>, path: string): DropSetTarget | null {
  rejectUnknown(
    c,
    v,
    ['kind', 'form', 'rounds', 'stages', 'roundConfigs', 'restInSec', 'restAfterSec', 'weightMode', 'dumbbellBasis'],
    path,
  );
  const rounds = reqInt(c, v.rounds, `${path}.rounds`, MIN_ROUNDS, MAX_ROUNDS, '轮数');
  // 新模板能力 = 编辑器能力：阶段 2–6。
  // （备份校验层容忍 12 阶段只保护旧数据，不成为模板新建能力。）
  if (!Array.isArray(v.stages)) {
    c.add(`${path}.stages`, '缺少阶段数组');
    return null;
  }
  const { weightMode, dumbbellBasis } = parseWeightFields(c, v, path);
  if (v.suggestedWeightKg !== undefined) {
    c.add(`${path}.suggestedWeightKg`, '递减组的重量在各阶段里填写');
  }
  const restIn = reqInt(c, v.restInSec, `${path}.restInSec`, 0, MAX_REST_IN_SEC, '阶段间休息');
  const restAfter = reqInt(c, v.restAfterSec, `${path}.restAfterSec`, 0, MAX_REST, '轮间休息');
  const state = { broken: rounds === null || restIn === null || restAfter === null || !weightMode };
  const stages = parseDropStages(c, v.stages, `${path}.stages`, MIN_STAGES, MAX_STAGES, state);
  const roundConfigs: Array<{ roundIndex: number; stages: DropStageTarget[]; restInSec?: number }> = [];
  if (v.roundConfigs !== undefined) {
    if (!Array.isArray(v.roundConfigs)) {
      c.add(`${path}.roundConfigs`, '逐轮配置必须是数组');
      state.broken = true;
    } else if (v.roundConfigs.length > MAX_ROUNDS) {
      c.add(`${path}.roundConfigs`, `逐轮配置不能超过 ${MAX_ROUNDS} 项`);
      state.broken = true;
    } else {
      const seen = new Set<number>();
      v.roundConfigs.forEach((rv, i) => {
        const rp = `${path}.roundConfigs[${i}]`;
        if (!isObj(rv)) {
          c.add(rp, '逐轮配置必须是对象');
          state.broken = true;
          return;
        }
        rejectUnknown(c, rv, ['roundIndex', 'stages', 'restInSec'], rp);
        const roundIndex = reqInt(c, rv.roundIndex, `${rp}.roundIndex`, 1, MAX_ROUNDS, '轮序号');
        if (roundIndex !== null) {
          if (seen.has(roundIndex)) {
            c.add(`${rp}.roundIndex`, `轮序号重复：${roundIndex}`);
            state.broken = true;
          }
          seen.add(roundIndex);
          if (rounds !== null && roundIndex > rounds) {
            c.add(`${rp}.roundIndex`, `轮序号 ${roundIndex} 超过轮数 ${rounds}`);
            state.broken = true;
          }
        }
        if (!Array.isArray(rv.stages)) {
          c.add(`${rp}.stages`, '每轮阶段配置必须是数组');
          state.broken = true;
          return;
        }
        const roundStages = parseDropStages(c, rv.stages, `${rp}.stages`, MIN_STAGES, MAX_STAGES, state);
        let rest: number | undefined;
        if (rv.restInSec !== undefined) {
          const r = reqInt(c, rv.restInSec, `${rp}.restInSec`, 0, MAX_REST_IN_SEC, '阶段间休息');
          if (r === null) state.broken = true;
          else rest = r;
        }
        roundConfigs.push({
          roundIndex: roundIndex ?? i + 1,
          stages: roundStages,
          ...(rest !== undefined ? { restInSec: rest } : {}),
        });
      });
    }
  }
  // R02：总行数按各轮真实 stageCount 求和
  let totalRows = 0;
  for (let r = 1; r <= Math.max(1, rounds ?? 1); r += 1) {
    const override = roundConfigs.find((x) => x.roundIndex === r);
    totalRows += (override?.stages ?? stages).length;
  }
  if (totalRows > MAX_SET_ROWS) {
    c.add(`${path}.rounds`, `组结构会生成 ${totalRows} 行，超过上限 ${MAX_SET_ROWS}`);
    state.broken = true;
  }
  if (state.broken) return null;
  // 导入是“新写入”：把默认轮与可证明同源的 override 身份一次性稳定化，
  // 旧无 id JSON 也能在训练中按阶段沿用；无法证明的不同阶段仍保持无 id，
  // 运行时用确定性兜底身份且不按位置硬配。
  return stabilizeDropTargetStageIds({
    kind: 'dropSet',
    ...(v.form !== undefined ? { form: oneOf(c, v.form, `${path}.form`, ['dropSet', 'superset'] as const, '训练形式') ?? 'dropSet' } : {}),
    rounds: rounds!,
    stages,
    ...(roundConfigs.length ? { roundConfigs } : {}),
    restInSec: restIn!,
    restAfterSec: restAfter!,
    weightMode: weightMode!,
    dumbbellBasis,
  }) as DropSetTarget;
}

function parseExercise(c: TCtx, v: unknown, path: string): PlanExercise | null {
  if (!isObj(v)) {
    c.add(path, '动作必须是对象');
    return null;
  }
  const allowedKeys = ['name', 'en', 'restSec', 'note', 'target'];
  if (c.version === 2) allowedKeys.push('setupNote');
  rejectUnknown(c, v, allowedKeys, path);
  const setup = parseSetupNote(v.setupNote);
  if (!setup.ok) c.add(`${path}.setupNote`, setup.message);
  const name = reqStr(c, v.name, `${path}.name`, 200);
  const en = optStr(c, v.en, `${path}.en`, 200);
  const note = optStr(c, v.note, `${path}.note`, MAX_TEXT);
  let restSec: number | null = 0;
  if (v.restSec !== undefined) restSec = reqInt(c, v.restSec, `${path}.restSec`, 0, MAX_REST, '休息秒数');
  if (!isObj(v.target)) {
    c.add(`${path}.target`, '缺少动作目标 target（straight / dropSet）');
    return null;
  }
  const kind = oneOf(c, v.target.kind, `${path}.target.kind`, ['straight', 'dropSet'] as const, '训练形式');
  let target: ExerciseTarget | null = null;
  if (kind === 'straight') target = parseStraight(c, v.target as Record<string, unknown>, `${path}.target`);
  else if (kind === 'dropSet') target = parseDropSet(c, v.target as Record<string, unknown>, `${path}.target`);
  if (!name || !target) return null;
  const ex: PlanExercise = {
    id: '', // instantiatePlan 生成
    name,
    restSec: restSec ?? 0,
    target,
  };
  if (en !== undefined) ex.en = en;
  if (note !== undefined) ex.note = note;
  if (setup.ok && setup.note !== undefined) ex.setupNote = setup.note;
  return ex;
}

/* ── 有氧参数（复用审定契约，两预设固定字段）──────── */

function parseCardioTarget(c: TCtx, preset: CardioPreset, v: unknown, path: string): CardioParams | null {
  if (!isObj(v)) {
    c.add(path, '有氧目标必须是对象');
    return null;
  }
  if (c.version === 1 && preset === 'treadmill-incline') {
    rejectUnknown(c, v, ['speedKmh', 'inclinePct'], path);
    const sp = reqStepNum(c, v.speedKmh, `${path}.speedKmh`, MIN_SPEED_KMH, MAX_SPEED_KMH, '速度（km/h）', SPEED_STEP_KMH);
    const inc = reqStepNum(c, v.inclinePct, `${path}.inclinePct`, MIN_INCLINE_PCT, MAX_INCLINE_PCT, '坡度（%）', INCLINE_STEP_PCT);
    if (sp === null || inc === null) return null;
    return { speedKmh: sp, inclinePct: inc };
  }
  const issues = validateCardioParams(preset, v);
  for (const issue of issues) c.add(`${path}.${issue.field}`, issue.message);
  return issues.length ? null : normalizeCardioParams(preset, v);
}

function parsePlanCardio(c: TCtx, v: unknown, path: string): PlanCardio | null {
  if (!isObj(v)) {
    c.add(path, '有氧项目必须是对象');
    return null;
  }
  rejectUnknown(c, v, ['preset', 'name', 'target', 'note'], path);
  const preset = oneOf(
    c,
    v.preset,
    `${path}.preset`,
    c.version === 2 ? CARDIO_PRESETS : LEGACY_CARDIO_PRESETS,
    '有氧预设',
  );
  const name = reqStr(c, v.name, `${path}.name`, 100);
  const note = optStr(c, v.note, `${path}.note`, MAX_TEXT);
  if (!preset) return null;
  const target = parseCardioTarget(c, preset, v.target, `${path}.target`);
  if (!name || !target) return null;
  const pc: PlanCardio = { id: '', preset, name, target };
  if (note !== undefined) pc.note = note;
  return pc;
}

function parseDay(c: TCtx, v: unknown, path: string): PlanDay | null {
  if (!isObj(v)) {
    c.add(path, '训练日必须是对象');
    return null;
  }
  rejectUnknown(c, v, ['name', 'kind', 'focus', 'round', 'restNote', 'warmups', 'exercises', 'cardio'], path);
  const name = reqStr(c, v.name, `${path}.name`, 100);
  const kind = oneOf(c, v.kind, `${path}.kind`, ['train', 'cardio', 'rest'] as const, '日类型');
  if (!name || !kind) return null;

  const warm = Array.isArray(v.warmups) ? v.warmups : undefined;
  const exer = Array.isArray(v.exercises) ? v.exercises : undefined;

  if (kind === 'train') {
    if (!warm) c.add(`${path}.warmups`, '力量日必须提供 warmups 数组（可为空数组）');
    if (!exer) c.add(`${path}.exercises`, '力量日必须提供 exercises 数组（可为空数组）');
    if (v.cardio !== undefined) c.add(`${path}.cardio`, '力量日不能携带 cardio');
    if (v.restNote !== undefined) c.add(`${path}.restNote`, '力量日不能携带 restNote');
    if (!warm || !exer) return null;
    if (warm.length > MAX_EXERCISES) c.add(`${path}.warmups`, `热身项数超过上限 ${MAX_EXERCISES}`);
    if (exer.length > MAX_EXERCISES) c.add(`${path}.exercises`, `动作数超过上限 ${MAX_EXERCISES}`);
    const warmups = warm
      .map((w, i) => parseWarmup(c, w, `${path}.warmups[${i}]`))
      .filter((x): x is ParsedWarmup => x !== null);
    const exercises = exer
      .map((e, i) => parseExercise(c, e, `${path}.exercises[${i}]`))
      .filter((x): x is PlanExercise => x !== null);
    if (warmups.length !== warm.length || exercises.length !== exer.length) {
      c.add(path, '存在无法解析的条目，整个模板已拒绝');
      return null;
    }
    /**
     * G4 模型边界（已裁决）：**缺省与非法必须分开**。
     *
     * · 缺省（undefined）→ 允许省略，**不隐式补 chest/A**；
     * · 显式提供 → 仍按既有合法枚举严格校验，非法值拒绝整个模板。
     *
     * 旧实现在缺省时补 'chest'/'A'，会让"新自定义力量日"被静默改写成
     * 胸/A，与"任意分化"直接冲突。
     */
    const focus = v.focus === undefined
      ? undefined
      : oneOf(c, v.focus, `${path}.focus`, c.version === 2 ? TRAINING_FOCUSES : LEGACY_TRAINING_FOCUSES, '部位');
    const round = v.round === undefined
      ? undefined
      : oneOf(c, v.round, `${path}.round`, ['A', 'B'] as const, '轮次');
    // 显式给了但不合法 → 拒绝（缺省才是允许的 undefined）
    if (v.focus !== undefined && focus === null) return null;
    if (v.round !== undefined && round === null) return null;
    // 到这里 focus/round 只可能是合法值或 undefined
    const focusVal = focus ?? undefined;
    const roundVal = round ?? undefined;
    const day: PlanDay = {
      id: '',
      name,
      kind: 'train',
      // 只在显式提供时写入字段，缺省时保持"没有该字段"
      ...(focusVal !== undefined ? { focus: focusVal } : {}),
      ...(roundVal !== undefined ? { round: roundVal } : {}),
      warmups: warmups.map((w) => {
        const wt: WarmupTarget = { id: '', name: w.name, unit: w.unit, targetText: w.targetText };
        if (w.en !== undefined) wt.en = w.en;
        if (w.optional !== undefined) wt.optional = w.optional;
        return wt;
      }),
      exercises,
    };
    return day;
  }

  if (kind === 'cardio') {
    if (v.focus !== undefined) c.add(`${path}.focus`, '有氧日不适用部位');
    if (v.round !== undefined) c.add(`${path}.round`, '有氧日不适用轮次');
    if (v.restNote !== undefined) c.add(`${path}.restNote`, '有氧日不适用休息说明');
    // G2（REVIEW-3）：**按键出现**拒绝，不论值是空数组 / null / 标量 / 对象
    if (v.exercises !== undefined) c.add(`${path}.exercises`, '有氧日不能携带 exercises（含空数组）');
    if (v.warmups !== undefined) c.add(`${path}.warmups`, '有氧日不能携带 warmups（含空数组）');
    if (!Array.isArray(v.cardio) || v.cardio.length === 0) {
      c.add(`${path}.cardio`, '有氧日必须提供至少一个 cardio 项目');
      return null;
    }
    if (v.cardio.length > MAX_CARDIO_ENTRIES) {
      c.add(`${path}.cardio`, `有氧项目数超过上限 ${MAX_CARDIO_ENTRIES}`);
      return null;
    }
    const cardio = (v.cardio as unknown[])
      .map((pc, i) => parsePlanCardio(c, pc, `${path}.cardio[${i}]`))
      .filter((x): x is PlanCardio => x !== null);
    if (cardio.length !== v.cardio.length) return null;
    return { id: '', name, kind: 'cardio', warmups: [], exercises: [], cardio };
  }

  // rest
  if (v.focus !== undefined) c.add(`${path}.focus`, '休息日不适用部位');
  if (v.round !== undefined) c.add(`${path}.round`, '休息日不适用轮次');
  // G2（REVIEW-3）：休息日同样按键出现拒绝 warmups/exercises，不静默丢弃
  if (v.exercises !== undefined) c.add(`${path}.exercises`, '休息日不能携带 exercises（含空数组）');
  if (v.warmups !== undefined) c.add(`${path}.warmups`, '休息日不能携带 warmups（含空数组）');
  if (v.cardio !== undefined) c.add(`${path}.cardio`, '休息日不能携带有氧');
  const restNote = optStr(c, v.restNote, `${path}.restNote`, 400);
  return { id: '', name, kind: 'rest', warmups: [], exercises: [], ...(restNote !== undefined ? { restNote } : {}) };
}

/* ── 顶层解析 ───────────────────────────── */

function parsePlanRoot(c: TCtx, root: Record<string, unknown>): Plan | null {
  if (!isObj(root.plan)) {
    c.add('plan', '缺少 plan 对象');
    return null;
  }
  rejectUnknown(c, root.plan, ['name', 'days'], 'plan');
  // 模板是「新输入」，与新建/重命名/savePlan 共用 MAX_PLAN_NAME（200），不放宽成 legacy 读取上限。
  const name = reqStr(c, root.plan.name, 'plan.name', MAX_PLAN_NAME);
  if (!Array.isArray(root.plan.days)) {
    c.add('plan.days', '缺少训练日数组');
    return null;
  }
  if (root.plan.days.length === 0) {
    c.add('plan.days', '计划至少需要一个训练日');
    return null;
  }
  if (root.plan.days.length > MAX_DAYS) {
    c.add('plan.days', `训练日数量 ${root.plan.days.length} 超过上限 ${MAX_DAYS}`);
    return null;
  }
  const days = root.plan.days
    .map((d, i) => parseDay(c, d, `plan.days[${i}]`))
    .filter((x): x is PlanDay => x !== null);
  if (!name || days.length !== root.plan.days.length) return null;
  return { id: '', name, days, cursor: 0, createdAt: 0, updatedAt: 0 };
}

/**
 * 解析并严格校验模板文本（纯校验，不写任何东西）。
 * 任何一处不合法 → 返回全部问题（带可理解的位置路径），调用方保留原文以便修正。
 */
export function parsePlanTemplate(text: string, now = Date.now()): TemplateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      issues: [{ path: '(文件)', message: `不是有效的 JSON：${err instanceof Error ? err.message : '解析失败'}` }],
    };
  }
  if (!isObj(raw)) return { ok: false, issues: [{ path: '(根)', message: '模板顶层必须是对象' }] };

  // 备份误投：明确指路，不按模板处理
  if (raw.format === FULL_BACKUP_FORMAT) {
    return {
      ok: false,
      issues: [{ path: 'format', message: '这是「全量备份」文件，不能在模板导入里使用；请到 设置 → 备份与恢复 → 从文件恢复' }],
    };
  }
  const c = new TCtx(raw.version === 2 ? 2 : 1);
  rejectUnknown(c, raw, ['format', 'version', 'plan'], '(根)');
  if (raw.format !== PLAN_TEMPLATE_FORMAT) {
    c.add('format', `应为 "${PLAN_TEMPLATE_FORMAT}"，实际是 ${JSON.stringify(raw.format)}`);
  }
  if (raw.version !== 1 && raw.version !== PLAN_TEMPLATE_VERSION) {
    if (typeof raw.version === 'number' && raw.version > PLAN_TEMPLATE_VERSION) {
      c.add('version', `模板版本 ${raw.version} 高于当前支持的 ${PLAN_TEMPLATE_VERSION}，请先升级应用`);
    } else {
      c.add('version', `模板版本只能是 1 或 ${PLAN_TEMPLATE_VERSION}`);
    }
  }
  const plan = parsePlanRoot(c, raw);
  if (c.failed || !plan) return { ok: false, issues: c.issues };
  return { ok: true, plan: instantiatePlan(plan, now) };
}

/* ── 本地身份与时间（确认后由 App 生成；insert-only 由存储层保证）── */

const idOf = (prefix: string, now: number, i: number, j = 0, k = 0, m = 0): string =>
  `${prefix}-${now.toString(36)}-${i}-${j}-${k}-${m}`;

/** 校验通过后的计划骨架 → 完整 Plan：稳定 ID、exerciseId、时间、cursor=0 */
export function instantiatePlan(skeleton: Plan, now = Date.now()): Plan {
  const days: PlanDay[] = skeleton.days.map((day, di) => {
    const d: PlanDay = { ...day, id: idOf('day', now, di) };
    d.warmups = day.warmups.map((w, wi) => ({ ...w, id: idOf('wu', now, di, wi) }));
    d.exercises = day.exercises.map((ex, ei) => {
      const ne: PlanExercise = { ...ex, id: idOf('ex', now, di, ei) };
      ne.exerciseId = resolveExerciseId(ne);
      return ne;
    });
    if (day.cardio) d.cardio = day.cardio.map((pc, ci) => ({ ...pc, id: idOf('pc', now, di, ci) }));
    return d;
  });
  return {
    id: idOf('plan', now, 0),
    name: skeleton.name,
    days,
    cursor: 0, // 循环从首日开始
    createdAt: now,
    updatedAt: now,
  };
}

/* ── 只读预览数据 ───────────────────────── */

export interface PreviewDay {
  order: number;
  name: string;
  kind: 'train' | 'cardio' | 'rest';
  focusLabel?: string;
  roundLabel?: string;
  targetSets: number;
  exerciseLines: string[];
  warmupCount: number;
  cardioLines: string[];
  restNote?: string;
}

export interface TemplatePreview {
  planName: string;
  dayCount: number;
  trainDays: number;
  cardioDays: number;
  restDays: number;
  days: PreviewDay[];
}

export function buildPreview(plan: Plan): TemplatePreview {
  const days: PreviewDay[] = plan.days.map((d, i) => {
    const targetSets = d.exercises.reduce(
      (n, ex) => n + (ex.target.kind === 'straight' ? ex.target.sets : ex.target.rounds),
      0,
    );
    const exerciseLines = d.exercises.map((ex) => {
      const t = ex.target;
      let base: string;
      if (t.kind === 'straight') {
        base =
          `${t.sets}${t.setsMax > t.sets ? `–${t.setsMax}` : ''} 组 × ${t.repsMin}–${t.repsMax} 次` +
          (t.suggestedWeightKg !== null ? ` · ${t.suggestedWeightKg}kg` : '');
      } else {
        const counts = Array.from({ length: t.rounds }, (_, i) => {
          const override = t.roundConfigs?.find((r) => r.roundIndex === i + 1);
          return (override?.stages ?? t.stages).length;
        });
        const uniform = counts.every((n) => n === counts[0]);
        base = uniform
          ? `${t.rounds} 轮 × ${t.stages.length} 阶段递减`
          : `${t.rounds} 轮 · 每轮阶段 ${counts.join('/')} 递减`;
      }
      return `${ex.name}：${base} · 休息 ${ex.restSec} 秒`;
    });
    const cardioLines = (d.cardio ?? []).map(
      (pc) => `${pc.name}：${describeCardioParams(pc.preset, pc.target)}`,
    );
    return {
      order: i + 1,
      name: d.name,
      kind: d.kind,
      ...(d.focus ? { focusLabel: TRAINING_FOCUS_LABEL[d.focus] } : {}),
      ...(d.round ? { roundLabel: d.round } : {}),
      targetSets,
      exerciseLines,
      warmupCount: d.warmups.length,
      cardioLines,
      ...(d.restNote ? { restNote: d.restNote } : {}),
    };
  });
  return {
    planName: plan.name,
    dayCount: plan.days.length,
    trainDays: plan.days.filter((d) => d.kind === 'train').length,
    cardioDays: plan.days.filter((d) => d.kind === 'cardio').length,
    restDays: plan.days.filter((d) => d.kind === 'rest').length,
    days,
  };
}
