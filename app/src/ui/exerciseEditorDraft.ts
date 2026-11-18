import { validateExerciseTemplate } from '../db/templates';
import { newStageId } from '../domain/dropSet';
import {
  defaultStageIdentityAt,
  resolveGroupConfig,
  resolveRoundStageIdentities,
  roundStagesOf,
  trainingFormOf,
  type ConfigIssue,
} from '../domain/exerciseConfig';
import { exerciseIdFromName } from '../domain/identity';
import { MIN_STAGES } from '../domain/limits';
import type {
  DumbbellBasis,
  ExerciseTarget,
  ExerciseTemplate,
  GroupPlan,
  StraightTarget,
  TrainingForm,
  WeightMode,
} from '../domain/types';

export interface ExerciseEditorInitial {
  /** 稳定编辑对象键：变化时重新初始化草稿；同键父级重渲染不重建 */
  key?: string;
  name: string;
  en?: string;
  exerciseId?: string;
  target: ExerciseTarget;
  restSec: number;
  /** 本次实际安排的组结构（临时加减后的真实组数/stageCount） */
  arrangedGroups?: GroupPlan[];
  memory?: { mode: 'none' | 'first' | 'exists'; revision: number | null };
}

export interface ExerciseEditorSubmitValue {
  name: string;
  en?: string;
  exerciseId: string;
  target: ExerciseTarget;
  restSec: number;
  remember: boolean;
  templateExpectedRevision: number | null;
  template?: ExerciseTemplate;
}

export interface StraightRow {
  setIndex: number;
  weight: string;
  repsMin: string;
  repsMax: string;
  toFailure: boolean;
  /** 原 session 的 set 身份只用于 G2B；编辑器本身不持有 actual */
}

export interface StageRow {
  id: string;
  label: string;
  weight: string;
  repsMin: string;
  repsMax: string;
  toFailure: boolean;
  rest: string;
}

export interface EditorState {
  name: string;
  en: string;
  exerciseId: string;
  form: TrainingForm;
  setsRaw: string;
  restRaw: string;
  straightRows: StraightRow[];
  roundsRaw: string;
  stages: StageRow[];
  /** R02：逐轮覆盖（含第 1 轮覆盖时也独立存在；默认模板始终在 stages） */
  stageOverrides: Record<number, StageRow[]>;
  /** R02 / M02：保留逐轮短间歇默认值 restInSec */
  roundRestInSecOverrides: Record<number, number>;
  roundRestRaw: string;
  /** M02 F3：用户是否显式修改过整轮休息输入框（未修改时多阶段保留基准的独立 restSec） */
  roundRestEdited: boolean;
  weightMode: WeightMode;
  dumbbellBasis: DumbbellBasis | undefined;
  remember: boolean;
  /** 0.1.18 智能跟随锁：已单独修改或初始即异构的普通组序号（>=2）；未在其中的组默认跟随第 1 组 */
  customizedSets: number[];
  /** 0.1.18 智能跟随锁：已单独修改或初始即异构的轮序号（>=2）；未在其中的轮默认跟随第 1 轮 */
  customizedRounds: number[];
}

export interface ConfigBaseline {
  target: ExerciseTarget;
  restSec: number;
  arrangedGroups?: GroupPlan[];
}

export interface BaselineMeta {
  roundStageCounts: number[];
  hasRound1Override: boolean;
  minStageCount: number;
  fallbackRounds: number;
}

export interface AppliedTemplateNotice {
  exerciseId: string;
  exerciseName: string;
}

export interface AppliedTemplateUndoSnapshot {
  state: EditorState;
  activeRound: number;
  memory: NonNullable<ExerciseEditorInitial['memory']>;
  configBaseline: ConfigBaseline;
  dirty: boolean;
  errors: Record<string, string>;
  targetIssues: ConfigIssue[];
  submitError: string | null;
  templateLoadError: string | null;
}

export type TemplateSelectionResolution =
  | { kind: 'found'; template: ExerciseTemplate }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

export const rawNum = (n: number | null | undefined): string =>
  n === null || n === undefined ? '' : String(n);

export function cloneStageRows(rows: StageRow[]): StageRow[] {
  return rows.map((r) => ({ ...r }));
}

export function cloneConfigBaseline(baseline: ConfigBaseline): ConfigBaseline {
  return {
    target: structuredClone(baseline.target),
    restSec: baseline.restSec,
    ...(baseline.arrangedGroups
      ? { arrangedGroups: baseline.arrangedGroups.map((g) => ({ ...g })) }
      : {}),
  };
}

export function cloneEditorState(state: EditorState): EditorState {
  const stageOverrides: Record<number, StageRow[]> = {};
  for (const [k, rows] of Object.entries(state.stageOverrides)) {
    stageOverrides[Number(k)] = cloneStageRows(rows);
  }
  return {
    ...state,
    straightRows: state.straightRows.map((r) => ({ ...r })),
    stages: cloneStageRows(state.stages),
    stageOverrides,
    roundRestInSecOverrides: { ...state.roundRestInSecOverrides },
    customizedSets: [...state.customizedSets],
    customizedRounds: [...state.customizedRounds],
  };
}

function defaultsFromStraight(t: StraightTarget, count: number): StraightRow[] {
  return Array.from({ length: Math.max(1, count) }, (_, i) => {
    const c = resolveGroupConfig(t, i + 1, 1);
    return {
      setIndex: i + 1,
      weight: rawNum(c.weightKg),
      repsMin: rawNum(c.repsMin),
      repsMax: rawNum(c.repsMax),
      toFailure: c.toFailure,
    };
  });
}

function stagesFromTarget(target: ExerciseTarget, roundIndex: number | 'default' = 1): StageRow[] {
  if (target.kind === 'dropSet') {
    const isDefault = roundIndex === 'default';
    const roundStages = isDefault ? target.stages : roundStagesOf(target, roundIndex);
    if (roundStages.length) {
      const last = roundStages.length - 1;
      const identities = isDefault
        ? target.stages.map((_, i) => defaultStageIdentityAt(target, i + 1))
        : resolveRoundStageIdentities(target, roundIndex as number);
      return roundStages.map((st, i) => {
        const id = identities[i]?.id ?? st.id ?? `stage-pos-${i + 1}`;
        const restFallback = isDefault
          ? target.restInSec
          : (resolveGroupConfig(target, roundIndex, i + 1).restAfterSec ?? target.restInSec);
        return {
          id,
          label: st.label,
          weight: rawNum(st.weightKg),
          repsMin: rawNum(st.repsMin),
          repsMax: rawNum(st.repsMax),
          toFailure: st.toFailure,
          rest: i === last ? '' : rawNum(st.restAfterSec ?? restFallback),
        };
      });
    }
  }
  const base = target.kind === 'straight' ? target : null;
  return [0, 1, 2].map((i) => ({
    id: newStageId(),
    label: `第 ${i + 1} 阶段`,
    weight: base ? rawNum(base.suggestedWeightKg) : '',
    repsMin: base ? rawNum(base.repsMin) : '8',
    repsMax: base ? rawNum(base.repsMax) : '12',
    toFailure: false,
    rest: i < 2 ? '15' : '',
  }));
}

export function buildEditorState(initial: ExerciseEditorInitial): EditorState {
  const form = trainingFormOf(initial.target);
  const arrangedCount =
    initial.arrangedGroups && initial.arrangedGroups.length > 0
      ? initial.arrangedGroups.length
      : initial.target.kind === 'straight'
        ? initial.target.sets
        : initial.target.rounds;
  const straightRows =
    initial.target.kind === 'straight'
      ? defaultsFromStraight(initial.target, arrangedCount)
      : Array.from({ length: Math.max(1, arrangedCount) }, (_, i) => {
          const st = initial.target.kind === 'dropSet' ? initial.target.stages[i] : undefined;
          return {
            setIndex: i + 1,
            weight: rawNum(st?.weightKg),
            repsMin: rawNum(st?.repsMin ?? 8),
            repsMax: rawNum(st?.repsMax ?? 12),
            toFailure: Boolean(st?.toFailure),
          };
        });
  const stages = stagesFromTarget(initial.target, initial.target.kind === 'dropSet' ? 'default' : 1);
  const rounds = initial.arrangedGroups?.length ?? (initial.target.kind === 'dropSet' ? initial.target.rounds : 3);
  const stageOverrides: Record<number, StageRow[]> = {};
  const roundRestInSecOverrides: Record<number, number> = {};
  if (initial.target.kind === 'dropSet') {
    for (const rc of initial.target.roundConfigs ?? []) {
      if (Number.isInteger(rc.roundIndex) && rc.roundIndex >= 1 && rc.roundIndex <= Math.max(1, rounds)) {
        stageOverrides[rc.roundIndex] = stagesFromTarget(initial.target, rc.roundIndex);
        if (rc.restInSec !== undefined) {
          roundRestInSecOverrides[rc.roundIndex] = rc.restInSec;
        }
      }
    }
  }

  const customizedSets: number[] = [];
  const firstSet = straightRows[0];
  if (firstSet) {
    for (let i = 1; i < straightRows.length; i += 1) {
      const row = straightRows[i];
      if (
        row.weight !== firstSet.weight ||
        row.repsMin !== firstSet.repsMin ||
        row.repsMax !== firstSet.repsMax ||
        row.toFailure !== firstSet.toFailure
      ) {
        customizedSets.push(row.setIndex);
      }
    }
  }

  const stageContentSignature = (rows: StageRow[]): string =>
    JSON.stringify(
      rows.map((r) => ({
        label: r.label,
        weight: r.weight,
        repsMin: r.repsMin,
        repsMax: r.repsMax,
        toFailure: r.toFailure,
        rest: r.rest,
      })),
    );
  const round1Rows = stageOverrides[1] ?? stages;
  const round1Sig = stageContentSignature(round1Rows);
  const baseRestInSec = initial.target.kind === 'dropSet' ? initial.target.restInSec : 15;
  const round1RestIn = roundRestInSecOverrides[1] ?? baseRestInSec;
  const customizedRounds: number[] = [];
  const roundTotal = Math.max(1, rounds);
  for (let r = 2; r <= roundTotal; r += 1) {
    const rRows = stageOverrides[r] ?? stages;
    const rRestIn = roundRestInSecOverrides[r] ?? baseRestInSec;
    if (stageContentSignature(rRows) !== round1Sig || rRestIn !== round1RestIn) {
      customizedRounds.push(r);
    }
  }

  return {
    name: initial.name,
    en: initial.en ?? '',
    exerciseId: initial.exerciseId ?? exerciseIdFromName(initial.name),
    form,
    setsRaw: String(Math.max(1, arrangedCount)),
    restRaw: String(initial.restSec),
    straightRows,
    roundsRaw: String(Math.max(1, rounds)),
    stages,
    stageOverrides,
    roundRestInSecOverrides,
    roundRestRaw: rawNum(initial.target.kind === 'dropSet' ? initial.target.restAfterSec : 120),
    roundRestEdited: false,
    weightMode: initial.target.weightMode,
    dumbbellBasis: initial.target.dumbbellBasis,
    remember: initial.memory?.mode === 'first',
    customizedSets,
    customizedRounds,
  };
}

export function computeBaselineMeta(baseline: ConfigBaseline): BaselineMeta {
  const { target, arrangedGroups } = baseline;
  const roundStageCounts: number[] =
    target.kind === 'dropSet'
      ? (() => {
          const editorRounds =
            arrangedGroups && arrangedGroups.length > 0
              ? arrangedGroups.length
              : Math.max(1, target.rounds);
          return Array.from({ length: editorRounds }, (_, i) =>
            Math.max(1, roundStagesOf(target, i + 1).length),
          );
        })()
      : [0];
  const hasRound1Override = Boolean(
    target.kind === 'dropSet' && target.roundConfigs?.some((r) => r.roundIndex === 1),
  );
  const positiveCounts = roundStageCounts.filter((n) => n > 0);
  const minStageCount = positiveCounts.length > 0 ? Math.min(...positiveCounts) : MIN_STAGES;
  const fallbackRounds =
    target.kind === 'dropSet'
      ? Math.max(1, arrangedGroups?.length ?? target.rounds)
      : 3;
  return {
    roundStageCounts,
    hasRound1Override,
    minStageCount,
    fallbackRounds,
  };
}

/**
 * M02：统一查询与校验选定动作的已存纯配置记忆。
 * 读取异常（templateError）或模板对象校验失败时绝不降级成无记忆（first），
 * 避免后续保存覆盖损坏或不可读的记忆。
 */
export function resolveTemplateForSelection(params: {
  templates?: ExerciseTemplate[];
  exerciseId: string;
  templateError?: string | null;
  exerciseName: string;
}): TemplateSelectionResolution {
  const { templates, exerciseId, templateError, exerciseName } = params;
  if (templateError) {
    return {
      kind: 'error',
      message: `动作配置记忆异常（${templateError}），本次未替换为「${exerciseName}」，已保留原动作与当前草稿`,
    };
  }
  const candidate = templates?.find((t) => t.exerciseId === exerciseId);
  if (!candidate) return { kind: 'missing' };
  const validated = validateExerciseTemplate(candidate);
  if (!validated.ok) {
    const reason = validated.issues[0]?.message ?? '格式不合法';
    return {
      kind: 'error',
      message: `动作「${exerciseName}」的默认配置已损坏（${reason}），本次未替换动作且不会覆盖记忆，已保留原动作与当前草稿`,
    };
  }
  return {
    kind: 'found',
    template: structuredClone(validated.template),
  };
}

/**
 * M02：由合法模板深复制构建完整草稿与新配置基准（与临时添加同源、实例独立）。
 */
export function buildTemplateApplyDraft(params: {
  selection: { name: string; en?: string; exerciseId: string };
  template: ExerciseTemplate;
  key?: string;
}): {
  state: EditorState;
  baseline: ConfigBaseline;
  memory: { mode: 'exists'; revision: number };
} {
  const clonedTarget = structuredClone(params.template.target);
  const memory: { mode: 'exists'; revision: number } = {
    mode: 'exists',
    revision: params.template.revision,
  };
  const en = params.selection.en ?? params.template.en;
  const state = buildEditorState({
    ...(params.key ? { key: params.key } : {}),
    name: params.selection.name,
    ...(en !== undefined ? { en } : {}),
    exerciseId: params.selection.exerciseId,
    target: clonedTarget,
    restSec: params.template.restSec,
    memory,
  });
  return {
    state,
    baseline: {
      target: structuredClone(clonedTarget),
      restSec: params.template.restSec,
    },
    memory,
  };
}
