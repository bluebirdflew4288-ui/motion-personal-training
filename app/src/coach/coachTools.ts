/* 电子教练业务工具注册与统一调度（0.2.2 全权限版）。
   关键边界：
   · 写操作全部经由 coachTx.ts 原子事务层落盘，返回结构化 OperationReceipt（支持字段/快照级撤销）；
   · 支持替换/增删进行中动作、自由切换普通组/超级组/递减组、训练中备注、直接完训、热身/6种有氧/器械档位备忘读写、历史补组纠错与 Hermes 记忆；
   · 任何跨历史查询前强制 await ensureFullHistory() 并读 IDB 全量列表，绝不受限于启动首阶段 40 条快照；
   · 绝不向终端用户透出内部英文工具名。 */

import { getPlan, getSession, listPlans, listSessions } from '../db/repo';
import { listExerciseTemplates } from '../db/templates';
import { CARDIO_PRESET_CHOICES } from '../domain/cardio';
import { trainingFormOf } from '../domain/exerciseConfig';
import { dropRoundComplete, groupsFromTarget, roundsOf, summarizeSession } from '../domain/session';
import { diffSessionVsPlanDay } from '../domain/sessionToPlanSync';
import { setupNoteFor } from '../domain/setupNote';
import type {
  CardioEntry,
  CardioParams,
  CardioPreset,
  ExerciseTemplate,
  Plan,
  Session,
  SessionExercise,
  SessionSet,
  SessionWarmup,
  TrainingForm,
} from '../domain/types';
import { searchCoachMemoryAndThreads, type CoachMemoryCategory } from './coachMemory';
import type {
  CoachFrozenTargetPrecondition,
  CoachOperationReceipt,
  CoachPendingPlannedToolCall,
  CoachPlanDraft,
} from './coachStorage';
import {
  coachAdjustActiveTarget,
  coachConfigureSuperset,
  coachCorrectHistory,
  coachFinishActiveSession,
  coachManageActiveCardio,
  coachManageActiveExercise,
  coachManageActiveWarmup,
  coachManageMemory,
  coachModifyExistingPlan,
  coachRecordActiveSet,
  coachSyncSessionToPlan,
  coachUpdateActiveNote,
  coachUpdateSetupNote,
  TxConflictError,
  type CoachTargetStageInput,
  type CoachTxHooks,
} from './coachTx';
import type { CoachRestTimerDirective } from '../lib/restTimerDurable';
import type { CoachToolCall, CoachToolDefinition } from './providerAdapter';

export interface CoachFrozenView {
  restoreEpoch: number;
  activeSession?: Session | null;
  plansById: Record<string, Plan>;
  historySessionsById: Record<string, Session>;
  templatesById: Record<string, ExerciseTemplate>;
}

export interface CoachToolExecutionContext {
  activeSession?: Session | null;
  plans?: Plan[];
  exerciseTemplates?: ExerciseTemplate[] | Record<string, ExerciseTemplate>;
  historyHydrated?: boolean;
  ensureFullHistory?: () => Promise<unknown>;
  activeThreadId?: string;
  hooks?: CoachTxHooks;
  expectedEpoch?: number;
  modelExpectedRevision?: number;
  modelExpectedPlanUpdatedAt?: number;
  frozenPrecondition?: CoachFrozenTargetPrecondition;
  priorBatchOpIds?: string[];
  strictSessionRevision?: boolean;
  requireFrozenPreconditions?: boolean;
  deferTimerDispatch?: boolean;
  isWebSearchAllowed?: () => boolean;
  webSearchRunner?: (query: string) => Promise<CoachToolExecutionOutcome>;
}

export interface CoachToolExecutionOutcome {
  ok: boolean;
  summary: string;
  receipt?: CoachOperationReceipt;
  timerDirective?: CoachRestTimerDirective;
  draftPlan?: CoachPlanDraft;
  data?: Record<string, unknown>;
  errorCode?: string;
  committedSession?: Session;
  committedPlan?: Plan;
  queriedFrozenView?: CoachFrozenView;
  deletedMemory?: { id: string; title: string; content: string };
}

export interface CoachReadOnlyContext {
  activeSession: {
    id: string;
    revision: number;
    planId: string;
    planName: string;
    dayName: string;
    note: string;
    summary: {
      completedGroups: number;
      plannedGroups: number;
      targetGroups: number;
      completedStages: number;
      plannedStages: number;
      partialGroups: number;
      skippedGroups: number;
      countingRule: string;
    };
    warmups: Array<{ id: string; name: string; unit: string; targetText: string; done: boolean }>;
    cardioEntries: Array<{
      id: string;
      preset: string;
      name: string;
      status: string;
      elapsedMs: number;
      currentParams: CardioParams;
      note?: string;
    }>;
    exercises: Array<{
      id: string;
      exerciseId: string;
      name: string;
      form: TrainingForm;
      restSec: number;
      pairId?: string;
      setupNote?: string;
      note?: string;
      completedGroups: number;
      plannedGroups: number;
      target: unknown;
      sets: Array<{
        id: string;
        roundIndex: number;
        stageIndex: number;
        reps: number | null;
        weightKg: number | null;
        status: string;
        toFailure?: boolean;
        note?: string;
      }>;
    }>;
  } | null;
  cardioPresets: Array<{ preset: string; label: string; params: Record<string, unknown> }>;
  plans: Array<{
    id: string;
    name: string;
    updatedAt: number;
    days: Array<{
      id: string;
      name: string;
      kind: string;
      warmups: Array<{ id: string; name: string; unit: string; targetText: string }>;
      exercises: Array<{ id: string; name: string; form: TrainingForm; restSec: number; pairId?: string; target: unknown }>;
    }>;
  }>;
  totalCompletedSessions: number;
  historySessions: Array<{
    id: string;
    revision: number;
    planId: string;
    planName: string;
    dayId: string;
    dayName: string;
    startedAt: number;
    endedAt: number | null;
    completedSets: number;
    completedStages: number;
    note: string;
    canSyncToPlan: boolean;
    syncDiffSummary?: string;
    cardioEntries?: Array<{
      id: string;
      preset: string;
      name: string;
      elapsedMs: number;
      currentParams: CardioParams;
      note?: string;
    }>;
    exercises: Array<{
      id: string;
      name: string;
      form: TrainingForm;
      restSec: number;
      pairId?: string;
      setupNote?: string;
      note?: string;
      setsCount: number;
      completedStages: number;
      maxWeightKg: number | null;
      totalReps: number;
      sets?: Array<{
        id: string;
        roundIndex: number;
        stageIndex: number;
        reps: number | null;
        weightKg: number | null;
        status: string;
        note?: string;
      }>;
    }>;
  }>;
}

export function projectWarmupsForRoCtx(
  warmups: readonly SessionWarmup[],
): NonNullable<CoachReadOnlyContext['activeSession']>['warmups'] {
  return warmups.map((w) => ({
    id: w.id,
    name: w.name,
    unit: w.unit,
    targetText: w.targetText,
    done: w.done,
  }));
}

export function projectCardioForRoCtx(
  cardio: readonly CardioEntry[],
): NonNullable<CoachReadOnlyContext['activeSession']>['cardioEntries'] {
  return cardio.map((c) => ({
    id: c.id,
    preset: c.preset,
    name: c.name,
    status: c.status,
    elapsedMs: c.elapsedMs,
    currentParams: c.currentParams,
    ...(c.note ? { note: c.note } : {}),
  }));
}

export function projectSessionExerciseForRoCtx(
  ex: SessionExercise,
  templatesById: Record<string, ExerciseTemplate>,
): NonNullable<CoachReadOnlyContext['activeSession']>['exercises'][number] {
  const rounds = roundsOf(ex);
  const completedGroups = rounds.filter((r) => dropRoundComplete(ex, r)).length;
  return {
    id: ex.id,
    exerciseId: ex.exerciseId,
    name: ex.name,
    form: trainingFormOf(ex.target),
    restSec: ex.restSec,
    pairId: ex.pairId,
    setupNote: setupNoteFor(ex, templatesById[ex.exerciseId ?? ex.name]),
    ...(ex.note ? { note: ex.note } : {}),
    completedGroups,
    plannedGroups: rounds.length,
    target: ex.target,
    sets: ex.sets.map((s) => ({
      id: s.id,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      status: s.status,
      ...(s.toFailure ? { toFailure: true } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
  };
}

export async function buildCoachReadOnlyContextWithView(
  ctx: CoachToolExecutionContext,
  opts?: {
    includeAllHistory?: boolean;
    historyLimit?: number;
    historyOffset?: number;
    sessionId?: string;
    includeDetails?: boolean;
  },
  restoreEpoch = 0,
): Promise<{ roCtx: CoachReadOnlyContext; frozenView: CoachFrozenView }> {
  if ((opts?.includeAllHistory || opts?.sessionId) && ctx.ensureFullHistory && !ctx.historyHydrated) {
    await ctx.ensureFullHistory();
  }

  const [allPlans, allSessions, templateList] = await Promise.all([
    listPlans(),
    listSessions(),
    Array.isArray(ctx.exerciseTemplates)
      ? Promise.resolve(ctx.exerciseTemplates)
      : ctx.exerciseTemplates
        ? Promise.resolve(Object.values(ctx.exerciseTemplates))
        : listExerciseTemplates(),
  ]);
  const templatesById: Record<string, ExerciseTemplate> = Object.fromEntries(
    templateList.map((t) => [t.exerciseId, structuredClone(t)]),
  );
  const planMap = new Map(allPlans.map((p) => [p.id, p]));

  const active =
    allSessions.find((s) => s.status === 'active') ??
    (ctx.activeSession?.status === 'active' ? ctx.activeSession : undefined);

  const completed = allSessions
    .filter((s) => s.status === 'completed')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  const offset = Math.max(0, Math.trunc(opts?.historyOffset ?? 0));
  let limitedHistory =
    opts?.includeAllHistory && !opts?.historyLimit
      ? completed.slice(offset)
      : opts?.historyLimit
        ? completed.slice(offset, offset + opts.historyLimit)
        : completed.slice(offset, offset + 5);
  if (opts?.sessionId && !limitedHistory.some((s) => s.id === opts.sessionId)) {
    const matched = completed.find((s) => s.id === opts.sessionId);
    if (matched) limitedHistory = [matched, ...limitedHistory];
  }

  const plansById: Record<string, Plan> = {};
  for (const p of allPlans) plansById[p.id] = structuredClone(p);
  const historySessionsById: Record<string, Session> = {};
  for (const s of completed) historySessionsById[s.id] = structuredClone(s);

  const activeSum = active ? summarizeSession(active) : null;

  const roCtx: CoachReadOnlyContext = {
    activeSession: active && activeSum
      ? {
          id: active.id,
          revision: active.revision ?? 1,
          planId: active.planId,
          planName: active.planName,
          dayName: active.day.dayName,
          note: active.note,
          summary: {
            completedGroups: activeSum.completedSets,
            plannedGroups: activeSum.plannedSets,
            targetGroups: activeSum.targetSets,
            completedStages: activeSum.completedStages,
            plannedStages: activeSum.plannedStages,
            partialGroups: activeSum.partialGroups,
            skippedGroups: activeSum.skippedGroups,
            countingRule: '多阶段动作(递减组/超级组/21响礼炮)按完成轮数(大组)计入完成组数，不按阶段行数计',
          },
          warmups: projectWarmupsForRoCtx(active.warmups),
          cardioEntries: projectCardioForRoCtx(active.cardio ?? []),
          exercises: active.exercises.map((ex) => projectSessionExerciseForRoCtx(ex, templatesById)),
        }
      : null,
    cardioPresets: CARDIO_PRESET_CHOICES.map((c) => ({
      preset: c.preset,
      label: c.label,
      params: { ...c.params },
    })),
    plans: allPlans.map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      days: p.days.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        warmups: d.warmups.map((w) => ({ id: w.id, name: w.name, unit: w.unit, targetText: w.targetText })),
        exercises: d.exercises.map((e) => ({
          id: e.id,
          name: e.name,
          form: trainingFormOf(e.target),
          restSec: e.restSec,
          pairId: e.pairId,
          target: e.target,
        })),
      })),
    })),
    totalCompletedSessions: completed.length,
    historySessions: limitedHistory.map((s, idx) => {
      const sum = summarizeSession(s);
      const syncDiff = diffSessionVsPlanDay(s, planMap.get(s.planId));
      const includeDetails = opts?.sessionId === s.id || Boolean(opts?.includeDetails && idx < 3);
      return {
        id: s.id,
        revision: s.revision ?? 1,
        planId: s.planId,
        planName: s.planName,
        dayId: s.day.dayId,
        dayName: s.day.dayName,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        completedSets: sum.completedSets,
        completedStages: sum.completedStages,
        note: s.note,
        canSyncToPlan: syncDiff.canSync && syncDiff.hasDiff,
        ...(syncDiff.hasDiff ? { syncDiffSummary: syncDiff.summaryText } : {}),
        ...(includeDetails && (s.cardio?.length ?? 0) > 0
          ? {
              cardioEntries: (s.cardio ?? []).map((c) => ({
                id: c.id,
                preset: c.preset,
                name: c.name,
                elapsedMs: c.elapsedMs,
                currentParams: c.currentParams,
                ...(c.note ? { note: c.note } : {}),
              })),
            }
          : {}),
        exercises: s.exercises.map((e) => {
          const done = e.sets.filter((st) => st.status === 'done');
          const weights = done.map((st) => st.weightKg).filter((w): w is number => w !== null);
          const completedGroups = roundsOf(e).filter((r) => dropRoundComplete(e, r)).length;
          return {
            id: e.id,
            name: e.name,
            form: trainingFormOf(e.target),
            restSec: e.restSec,
            pairId: e.pairId,
            setupNote: setupNoteFor(e, templatesById[e.exerciseId ?? e.name]),
            ...(e.note ? { note: e.note } : {}),
            setsCount: completedGroups,
            completedStages: done.length,
            maxWeightKg: weights.length ? Math.max(...weights) : null,
            totalReps: done.reduce((acc, st) => acc + (st.reps ?? 0), 0),
            ...(includeDetails
              ? {
                  sets: e.sets.map((st) => ({
                    id: st.id,
                    roundIndex: st.roundIndex,
                    stageIndex: st.stageIndex,
                    reps: st.reps,
                    weightKg: st.weightKg,
                    status: st.status,
                    ...(st.note ? { note: st.note } : {}),
                  })),
                }
              : {}),
          };
        }),
      };
    }),
  };
  return {
    roCtx,
    frozenView: {
      restoreEpoch,
      activeSession: active ? structuredClone(active) : null,
      plansById,
      historySessionsById,
      templatesById,
    },
  };
}

export async function buildCoachReadOnlyContext(
  ctx: CoachToolExecutionContext,
  opts?: {
    includeAllHistory?: boolean;
    historyLimit?: number;
    historyOffset?: number;
    sessionId?: string;
    includeDetails?: boolean;
  },
): Promise<CoachReadOnlyContext> {
  const { roCtx } = await buildCoachReadOnlyContextWithView(ctx, opts);
  return roCtx;
}

export const COACH_TOOL_DEFINITIONS: CoachToolDefinition[] = [
  {
    name: 'query_training_context',
    description: '只读查询当前训练、计划目录、热身、有氧预设、器械档位备忘与分页历史摘要（默认返回最近 5 条摘要，按需用 limit/offset 或 sessionId 展开）。',
    parameters: {
      type: 'object',
      properties: {
        includeAllHistory: { type: 'boolean', description: '默认 false；仅当确实需要全部历史时传 true。' },
        limit: { type: 'number', description: '分页返回条数（默认 5，最大 20）。' },
        offset: { type: 'number', description: '分页偏移量（默认 0）。' },
        includeDetails: { type: 'boolean', description: '是否展开最近记录逐组明细（默认 false）。' },
        sessionId: { type: 'string', description: '可选，传入某条历史训练 ID 获取完整逐组与有氧明细。' },
      },
    },
  },
  {
    name: 'adjust_active_target',
    description: '调整本次进行中训练某动作的目标参数（组数/轮数/次数区间/参考重量/组间休息/阶段短歇），也支持直接切换普通组(straight)/递减组(dropSet)/超级组(superset)并自定义阶段。绝不标为已完成。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        expectedRevision: { type: 'number' },
        form: { type: 'string', enum: ['straight', 'dropSet', 'superset'], description: '切换训练形式时必传。' },
        sets: { type: 'number', description: '普通组组数或递减/超级组轮数。' },
        repsMin: { type: 'number' },
        repsMax: { type: 'number' },
        suggestedWeightKg: { type: ['number', 'null'] },
        weightMode: { type: 'string', enum: ['external', 'bodyweight', 'bodyweight_plus', 'assisted'] },
        dumbbellBasis: { type: 'string', enum: ['per_hand', 'total'] },
        restSec: { type: 'number', description: '普通组组间休息或整轮后休息（秒）。' },
        restInSec: { type: 'number', description: '多阶段每程之间短歇（秒）。' },
        restAfterSec: { type: 'number', description: '多阶段整轮结束后休息（秒）。' },
        stages: {
          type: 'array',
          description: '切换为 dropSet 或 superset 时传入各阶段定义（如 21 响礼炮的 3 阶段）。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              repsMin: { type: ['number', 'null'] },
              repsMax: { type: ['number', 'null'] },
              weightKg: { type: ['number', 'null'] },
              toFailure: { type: 'boolean' },
              restAfterSec: { type: 'number' },
            },
          },
        },
        allowDiscardLoggedData: { type: 'boolean' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'record_active_set',
    description: '原子记录或修正本次进行中训练某一组的次数、重量、备注与完成状态（只有非done->done才触发休息计时）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        setId: { type: 'string' },
        roundIndex: { type: 'number' },
        stageIndex: { type: 'number' },
        targetMode: { type: 'string', enum: ['next_pending', 'last_completed'], description: '默认 next_pending；需纠正已完成最后一组时传 last_completed。' },
        expectedRevision: { type: 'number' },
        reps: { type: ['number', 'null'] },
        weightKg: { type: ['number', 'null'] },
        status: { type: 'string', enum: ['done', 'blank', 'partial'] },
        toFailure: { type: 'boolean' },
        note: { type: 'string', description: '单组备注（最多 500 字）。' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'manage_active_exercise',
    description: '管理进行中训练的动作：替换动作（如器械二头换21响礼炮）、新增动作、移除动作、切换普通组/递减组/超级组形式、跳过或取消跳过。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['replace', 'add', 'remove', 'convert_form', 'skip_remaining', 'unskip'] },
        exId: { type: 'string' },
        exerciseName: { type: 'string', description: '被替换/修改/移除的原动作名。' },
        newName: { type: 'string', description: 'replace 或 add 时的新动作名（如“21响礼炮”）。' },
        insertAfterExId: { type: 'string' },
        form: { type: 'string', enum: ['straight', 'dropSet', 'superset'] },
        sets: { type: 'number', description: '组数或轮数。' },
        repsMin: { type: 'number' },
        repsMax: { type: 'number' },
        suggestedWeightKg: { type: ['number', 'null'] },
        weightMode: { type: 'string', enum: ['external', 'bodyweight', 'bodyweight_plus', 'assisted'] },
        dumbbellBasis: { type: 'string', enum: ['per_hand', 'total'] },
        restSec: { type: 'number' },
        restInSec: { type: 'number' },
        restAfterSec: { type: 'number' },
        stages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              repsMin: { type: ['number', 'null'] },
              repsMax: { type: ['number', 'null'] },
              weightKg: { type: ['number', 'null'] },
              toFailure: { type: 'boolean' },
              restAfterSec: { type: 'number' },
            },
          },
        },
        setupNote: { type: 'string' },
        allowDiscardLoggedData: { type: 'boolean' },
      },
      required: ['sessionId', 'mode'],
    },
  },
  {
    name: 'update_active_note',
    description: '在训练进行中写入整场训练备注(session)、单动作备注(exercise)或单组备注(set)。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        scope: { type: 'string', enum: ['session', 'exercise', 'set'] },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        setId: { type: 'string' },
        roundIndex: { type: 'number' },
        stageIndex: { type: 'number' },
        note: { type: 'string' },
        append: { type: 'boolean', description: '传 true 时在原有备注后追加而不是覆盖。' },
      },
      required: ['sessionId', 'scope', 'note'],
    },
  },
  {
    name: 'finish_active_session',
    description: '仅在用户明确要求结束当前训练时调用，原子完训并可选同步本次编排回原计划。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        syncBackToPlanDay: { type: 'boolean' },
        advanceCycle: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'configure_superset',
    description: '配对两个及以上动作为超级组、解除超级组或将单动作安全拆转为多阶段超级组。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        mode: { type: 'string', enum: ['pair', 'unpair', 'convert_multistage'] },
        exIds: { type: 'array', items: { type: 'string' } },
        exId: { type: 'string' },
        partnerName: { type: 'string' },
        rounds: { type: 'number' },
        expectedRevision: { type: 'number' },
      },
      required: ['sessionId', 'mode'],
    },
  },
  {
    name: 'manage_active_warmup',
    description: '管理进行中训练的热身项目：完成/取消勾选(toggle_done)、新增(add)、修改(update)或移除(remove)。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['toggle_done', 'add', 'update', 'remove'] },
        warmupId: { type: 'string' },
        warmupName: { type: 'string' },
        done: { type: 'boolean' },
        name: { type: 'string' },
        unit: { type: 'string', enum: ['reps', 'time', 'breath'] },
        targetText: { type: 'string' },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'manage_active_cardio',
    description: '管理进行中训练的6种有氧预设项目：新增(add)、改参(update_params)、开始(start)、暂停(pause)、继续(resume)、完成(complete)或移除(remove)。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['add', 'update_params', 'start', 'pause', 'resume', 'complete', 'remove'] },
        cardioId: { type: 'string' },
        cardioName: { type: 'string' },
        preset: {
          type: 'string',
          enum: ['treadmill-incline', 'stair-climber', 'stationary-bike', 'elliptical', 'rowing-machine', 'free-cardio'],
        },
        name: { type: 'string' },
        params: { type: 'object', description: '如 speedKmh/inclinePct/level/resistanceLevel/cadenceRpm/damperLevel/splitSecPer500m' },
        note: { type: 'string' },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'update_setup_note',
    description: '写入或清空动作的跨计划器械档位备忘（如座椅第4格、插销第2孔）；训练进行中会同步更新本次会话与长期模板记忆。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        exerciseId: { type: 'string' },
        note: { type: 'string', description: '单行文字（最多 200 字），传空字符串表示清空。' },
      },
      required: ['note'],
    },
  },
  {
    name: 'correct_history_session',
    description: '对已完成的历史训练做纠错：修改已有组(correct_set)、补录新组并可一步填实绩(append_group)、删空白组(remove_blank_group)、改备注(update_session_note/update_exercise_note)或修正有氧(correct_cardio)。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        expectedRevision: { type: 'number' },
        action: {
          type: 'string',
          enum: [
            'correct_set',
            'append_group',
            'remove_blank_group',
            'update_session_note',
            'update_exercise_note',
            'correct_cardio',
          ],
        },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        setId: { type: 'string' },
        roundIndex: { type: 'number' },
        stageIndex: { type: 'number' },
        reps: { type: ['number', 'null'] },
        weightKg: { type: ['number', 'null'] },
        status: { type: 'string', enum: ['done', 'blank', 'partial'] },
        note: { type: 'string' },
        cardioId: { type: 'string' },
        cardioName: { type: 'string' },
        durationSec: { type: 'number' },
        elapsedMs: { type: 'number' },
        params: { type: 'object' },
      },
      required: ['sessionId', 'action'],
    },
  },
  {
    name: 'create_plan_from_draft',
    description: '生成可编辑的训练计划预览，等待用户在界面确认。工具不保存计划。保留动作顺序、分组、阶段和每手/合计口径。用 warnings 标记难以识别的字段。',
    parameters: {
      type: 'object',
      properties: {
        draft: {
          type: 'object',
          description: 'planName；days[] 含 dayName、exercises[]。每个动作含 name、kind (straight/dropSet)、sets、repsMin、repsMax、weightMode (external/bodyweight)、suggestedWeightKg (kg 或 null)；可含 dumbbellBasis (per_hand/total)、pairGroup、form (drop/superset)、stages[] (label、repsMin、repsMax、weightKg)。难以识别的组次填 0 并在 warnings[] 说明。',
        },
      },
      required: ['draft'],
    },
  },
  {
    name: 'modify_existing_plan',
    description: '对已有训练计划执行定向修改：action.kind 支持 rename_plan、rename_day、add_exercise、remove_exercise、replace_exercise、update_target（支持切 form/stages）、pair_superset、unpair_superset、add_warmup、update_warmup、remove_warmup、add_cardio、update_cardio、remove_cardio。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        expectedUpdatedAt: { type: 'number' },
        action: {
          type: 'object',
          description: '必须含 kind；可带 dayId/dayName、exId/exerciseName、name/newName、form/sets/repsMin/repsMax/suggestedWeightKg/restSec/stages 等。',
        },
      },
      required: ['planId', 'action'],
    },
  },
  {
    name: 'sync_session_to_plan',
    description: '将指定训练（进行中或刚结束的历史记录均可）的动作编排差量同步回原计划模板，或显式确认仅改本次训练。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        scope: { type: 'string', enum: ['session-only', 'sync-to-plan'] },
        expectedPlanUpdatedAt: { type: 'number' },
        alsoFinishSession: { type: 'boolean' },
      },
      required: ['sessionId', 'scope'],
    },
  },
  {
    name: 'manage_coach_memory',
    description: '保存、更新或删除关于用户的长期训练记忆（身体情况、训练偏好、伤病避让、器械环境、表达习惯、经验教训），让教练越用越懂你。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'delete'] },
        id: { type: 'string' },
        category: { type: 'string', enum: ['profile', 'preference', 'injury', 'equipment', 'habit', 'lesson'] },
        title: { type: 'string', description: '简短记忆标题（最多 40 字）。' },
        content: { type: 'string', description: '具体事实或偏好内容（最多 240 字）。' },
        pinned: { type: 'boolean', description: '关键约束（如伤病避让）设为 true 长期置顶。' },
      },
      required: ['action'],
    },
  },
  {
    name: 'search_coach_history',
    description: '跨过往对话会话和长期记忆关键词检索历史讨论结论，用于回答“之前聊过什么/上次怎么定的”。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
];

export const COACH_WEB_SEARCH_TOOL_DEFINITION: CoachToolDefinition = {
  name: 'web_search',
  description: '实时联网搜索训练动作细节、器械用法、营养热量或最新指南，仅当用户开启联网模式且需要外部知识时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
};

export const ALLOWED_BUSINESS_TOOL_NAMES: ReadonlySet<string> = new Set(
  COACH_TOOL_DEFINITIONS.map((t) => t.name),
);

const ALL_TOOL_SCHEMA_MAP: ReadonlyMap<string, CoachToolDefinition> = new Map(
  [...COACH_TOOL_DEFINITIONS, COACH_WEB_SEARCH_TOOL_DEFINITION].map((t) => [t.name, t]),
);

/**
 * 在提交 Phase 2 `pendingTurn` 与执行任何业务写入之前整批预校验：
 * 任一 toolCall 存在缺失/重复 ID、未知工具、JSON 解析错误、非对象参数、缺失必填业务键或非法枚举值，
 * 整批 0 执行、0 写盘。
 */
export function validateToolCallBatch(
  calls: readonly CoachToolCall[],
  allowedToolNames: ReadonlySet<string> = ALLOWED_BUSINESS_TOOL_NAMES,
): { ok: true } | { ok: false; reason: string } {
  const seenIds = new Set<string>();
  for (let i = 0; i < calls.length; i += 1) {
    const c = calls[i];
    const id = typeof c?.id === 'string' ? c.id.trim() : '';
    if (!id) {
      return { ok: false, reason: `第 ${i + 1} 个工具调用缺少真实 call.id` };
    }
    if (seenIds.has(id)) {
      return { ok: false, reason: `同一批次出现重复的工具调用 ID: ${id}` };
    }
    seenIds.add(id);

    if (!allowedToolNames.has(c.name)) {
      return { ok: false, reason: `工具「${c.name}」未在当前允许集合内` };
    }
    if (c.parseError) {
      return { ok: false, reason: `工具「${c.name}」参数错误：${c.parseError}` };
    }
    if (!c.arguments || typeof c.arguments !== 'object' || Array.isArray(c.arguments)) {
      return { ok: false, reason: `工具「${c.name}」参数必须是 JSON 对象` };
    }

    const def = ALL_TOOL_SCHEMA_MAP.get(c.name);
    if (def) {
      const props = def.parameters.properties ?? {};
      for (const reqKey of def.parameters.required ?? []) {
        // sessionId 容许走 ctx.activeSession?.id 兜底，但其余业务必填键不得缺失
        if (reqKey === 'sessionId') continue;
        const val = c.arguments[reqKey];
        if (val === undefined || val === null) {
          return { ok: false, reason: `工具「${c.name}」缺少必填字段 ${reqKey}` };
        }
        if (typeof val === 'string' && !val.trim() && reqKey !== 'note') {
          return { ok: false, reason: `工具「${c.name}」必填字段 ${reqKey} 不能为空` };
        }
      }
      for (const [key, propSpec] of Object.entries(props)) {
        const val = c.arguments[key];
        if (val === undefined || val === null) continue;
        const spec = propSpec as { enum?: unknown[]; type?: string | string[] };
        if (spec.type !== undefined) {
          const allowedTypes = Array.isArray(spec.type) ? spec.type : [spec.type];
          const matchesType = allowedTypes.some((t) => {
            if (t === 'number') return typeof val === 'number' && Number.isFinite(val);
            if (t === 'integer') return typeof val === 'number' && Number.isInteger(val);
            if (t === 'string') return typeof val === 'string';
            if (t === 'boolean') return typeof val === 'boolean';
            if (t === 'array') return Array.isArray(val);
            if (t === 'object') return typeof val === 'object' && val !== null && !Array.isArray(val);
            return true;
          });
          if (!matchesType) {
            return {
              ok: false,
              reason: `工具「${c.name}」字段 ${key} 类型不合法`,
            };
          }
        }
        if (Array.isArray(spec.enum) && typeof val === 'string' && !spec.enum.includes(val)) {
          return {
            ok: false,
            reason: `工具「${c.name}」字段 ${key} 取值「${val}」不在允许范围 [${spec.enum.join(', ')}] 内`,
          };
        }
        if (typeof val === 'number') {
          if (key === 'weightKg' || key === 'suggestedWeightKg') {
            if (!Number.isFinite(val) || val < 0 || val > 2000) {
              return { ok: false, reason: `工具「${c.name}」字段 ${key} 超出 0–2000 kg 合法范围` };
            }
          } else if (key === 'reps' || key === 'repsMin' || key === 'repsMax') {
            if (!Number.isInteger(val) || val < 1 || val > 999) {
              return { ok: false, reason: `工具「${c.name}」字段 ${key} 必须是 1–999 的正整数` };
            }
          } else if (key === 'roundIndex' || key === 'stageIndex' || key === 'sets' || key === 'setsMax') {
            if (!Number.isInteger(val) || val < 1) {
              return { ok: false, reason: `工具「${c.name}」字段 ${key} 必须是大于等于 1 的整数` };
            }
          } else if (key === 'restSec') {
            if (!Number.isFinite(val) || val < 0 || val > 3600) {
              return { ok: false, reason: `工具「${c.name}」字段 ${key} 超出 0–3600 秒合法范围` };
            }
          }
        }
      }
      if (c.name === 'create_plan_from_draft') {
        const draft = c.arguments.draft as CoachPlanDraft | undefined;
        if (!isDraftStructure(draft)) {
          return { ok: false, reason: 'create_plan_from_draft 的 draft 结构不完整' };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * 工具结果返回模型前的严格白名单投影：
 * 绝不透传 touchedTargets、beforeSession、afterSession、beforeSet、afterSet、beforePlan、afterPlan、
 * beforeMemory、afterMemory、beforeTemplate、afterTemplate 等重型或冗余回滚快照。
 */
export function projectToolOutcomeForModel(
  toolName: string,
  outcome: CoachToolExecutionOutcome,
): Record<string, unknown> {
  const safeSummary =
    outcome.deletedMemory ||
    (toolName === 'manage_coach_memory' && outcome.ok && outcome.summary.startsWith('忘记记忆'))
      ? '已删除指定长期记忆并清理可重放历史'
      : outcome.summary;
  const compact: Record<string, unknown> = {
    ok: Boolean(outcome.ok),
    summary: safeSummary,
  };
  if (outcome.errorCode) compact.errorCode = outcome.errorCode;
  if (outcome.receipt) {
    compact.receipt = {
      receiptId: outcome.receipt.id,
      operationId: outcome.receipt.operationId,
      scope: outcome.receipt.scope,
      entityId: outcome.receipt.entityId,
      afterRevision: outcome.receipt.afterRevision,
      ...(outcome.receipt.afterPlanRevision !== undefined
        ? { afterPlanRevision: outcome.receipt.afterPlanRevision }
        : {}),
      ...(outcome.receipt.timerStarted !== undefined
        ? { timerStarted: outcome.receipt.timerStarted }
        : {}),
    };
  }
  if (outcome.draftPlan) {
    compact.draftPlan = {
      id: outcome.draftPlan.id,
      planName: outcome.draftPlan.planName,
      daysCount: outcome.draftPlan.days.length,
    };
  }
  if (outcome.data) {
    if (toolName === 'query_training_context' || toolName === 'search_coach_history' || toolName === 'web_search') {
      compact.data = outcome.data;
    } else {
      const safeData: Record<string, unknown> = {};
      for (const k of [
        'timerStarted',
        'pairId',
        'supersetExerciseId',
        'pageOffset',
        'pageLimit',
        'hasMore',
        'currentRevision',
        'latestSet',
        'memoryId',
      ]) {
        if (k in outcome.data) safeData[k] = outcome.data[k];
      }
      if (Object.keys(safeData).length) compact.data = safeData;
    }
  }
  return compact;
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function numOrNullOrUndefined(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function formOrUndefined(v: unknown): TrainingForm | undefined {
  return v === 'straight' || v === 'dropSet' || v === 'superset' ? v : undefined;
}

function parseStagesArg(raw: unknown): CoachTargetStageInput[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((item, i) => {
    const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    return {
      ...(strOrUndefined(obj.id) ? { id: strOrUndefined(obj.id) } : {}),
      label: strOrUndefined(obj.label) ?? `第 ${i + 1} 阶段`,
      repsMin: numOrNullOrUndefined(obj.repsMin),
      repsMax: numOrNullOrUndefined(obj.repsMax),
      weightKg: numOrNullOrUndefined(obj.weightKg),
      toFailure: typeof obj.toFailure === 'boolean' ? obj.toFailure : undefined,
      restAfterSec: numOrUndefined(obj.restAfterSec),
    };
  });
}

function isDraftStructure(draft: CoachPlanDraft | undefined): draft is CoachPlanDraft {
  const text = (value: unknown) => typeof value === 'string';
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  const weight = (value: unknown) => value === null || number(value);
  return Boolean(draft && text(draft.planName) && Array.isArray(draft.days) &&
    (draft.warnings === undefined || (Array.isArray(draft.warnings) && draft.warnings.every(text))) &&
    draft.days.some((day) => Array.isArray(day?.exercises) && day.exercises.length > 0) &&
    draft.days.every((day) => day && text(day.dayName) && Array.isArray(day.exercises) &&
      day.exercises.every((ex: CoachPlanDraft['days'][number]['exercises'][number]) =>
        ex && text(ex.name) && (ex.kind === 'straight' || ex.kind === 'dropSet') &&
        number(ex.sets) && number(ex.repsMin) && number(ex.repsMax) &&
        (ex.weightMode === 'external' || ex.weightMode === 'bodyweight') &&
        weight(ex.suggestedWeightKg) &&
        (ex.dumbbellBasis === undefined || ex.dumbbellBasis === 'per_hand' || ex.dumbbellBasis === 'total') &&
        (ex.pairGroup === undefined || text(ex.pairGroup)) &&
        (ex.kind !== 'dropSet' || (Array.isArray(ex.stages) && ex.stages.length > 0 &&
          ex.stages.every((stage) => stage && text(stage.label) && number(stage.repsMin) &&
            number(stage.repsMax) && weight(stage.weightKg)))))));
}

function resolveExFromFrozen(
  session: Session | null | undefined,
  selector: { exId?: unknown; exerciseName?: unknown },
) {
  if (!session) return undefined;
  const exId = strOrUndefined(selector.exId);
  if (exId) return session.exercises.find((e) => e.id === exId);
  const needle = strOrUndefined(selector.exerciseName)?.toLowerCase();
  if (!needle) return undefined;
  const exact = session.exercises.filter((e) => e.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const fuzzy = session.exercises.filter((e) => e.name.trim().toLowerCase().includes(needle));
  if (fuzzy.length === 1) return fuzzy[0];
  return undefined;
}

function resolveSetFromFrozen(
  ex: Session['exercises'][number] | undefined,
  selector: { setId?: unknown; roundIndex?: unknown; stageIndex?: unknown; targetMode?: unknown },
) {
  if (!ex) return undefined;
  const setId = strOrUndefined(selector.setId);
  if (setId) return ex.sets.find((s) => s.id === setId);
  const roundIdx = numOrUndefined(selector.roundIndex);
  if (roundIdx !== undefined) {
    const stageIdx = numOrUndefined(selector.stageIndex) ?? 1;
    return ex.sets.find((s) => s.roundIndex === roundIdx && s.stageIndex === stageIdx);
  }
  if (selector.targetMode === 'last_completed') {
    for (let i = ex.sets.length - 1; i >= 0; i -= 1) {
      if (ex.sets[i].status === 'done') return ex.sets[i];
    }
    return undefined;
  }
  const skipped = new Set(ex.groups.filter((g) => g.skipped).map((g) => g.index));
  return ex.sets.find((s) => !skipped.has(s.roundIndex) && s.status !== 'done');
}

/**
 * 基于发给模型的冻结只读视图（frozenView），在执行第 0 步前冻结每条待执行工具的目标 ID、
 * 预期版本 expectedRevision / expectedUpdatedAt、字段级前置条件与同批前置 operationId 链。
 * 首次执行与崩溃冷恢复共用同一批计划，绝不凭当前已变动的主库重新解析 “下一组”。
 */
export function freezeToolBatchAgainstView(params: {
  calls: CoachToolCall[];
  frozenView: CoachFrozenView;
  turnId: string;
  round: number;
  baseSeq: number;
  restoreEpoch: number;
}): CoachPendingPlannedToolCall[] {
  const workingActive = params.frozenView.activeSession
    ? structuredClone(params.frozenView.activeSession)
    : null;
  const workingHistory = new Map<string, Session>(
    Object.entries(params.frozenView.historySessionsById).map(([k, v]) => [k, structuredClone(v)]),
  );
  const workingPlans = new Map<string, Plan>(
    Object.entries(params.frozenView.plansById).map(([k, v]) => [k, structuredClone(v)]),
  );
  const priorOpsBySession = new Map<string, string[]>();
  const priorOpsByPlan = new Map<string, string[]>();

  return params.calls.map((c, idx) => {
    const operationId = `${params.turnId}:r${params.round}:c${idx}`;
    const toolEntrySeq = params.baseSeq + 1 + idx;
    const rawArgs = structuredClone(c.arguments ?? {}) as Record<string, unknown>;
    const frozenArgs: Record<string, unknown> = { ...rawArgs };
    const modelExpectedRevision = numOrUndefined(rawArgs.expectedRevision ?? rawArgs.expectedSessionRevision);
    const modelExpectedPlanRevision = numOrUndefined(rawArgs.expectedUpdatedAt ?? rawArgs.expectedPlanUpdatedAt);
    let expectedRevision: number | undefined;
    let expectedPlanRevision: number | undefined;
    let frozenPrecondition: CoachFrozenTargetPrecondition | undefined;
    let priorBatchOpIds: string[] | undefined;
    let strictSessionRevision: boolean | undefined;

    const activeIdArg = strOrUndefined(rawArgs.sessionId);
    const activeTargetMatch =
      workingActive && (!activeIdArg || activeIdArg === workingActive.id) ? workingActive : undefined;

    if (
      c.name === 'record_active_set' ||
      c.name === 'adjust_active_target' ||
      c.name === 'manage_active_exercise' ||
      c.name === 'update_active_note' ||
      c.name === 'finish_active_session' ||
      c.name === 'configure_superset' ||
      c.name === 'manage_active_warmup' ||
      c.name === 'manage_active_cardio'
    ) {
      const targetSid = activeIdArg ?? workingActive?.id;
      if (targetSid && !frozenArgs.sessionId) frozenArgs.sessionId = targetSid;
      const baseActiveRev =
        activeTargetMatch && typeof activeTargetMatch.revision === 'number'
          ? activeTargetMatch.revision
          : 1;
      if (activeTargetMatch) {
        expectedRevision = baseActiveRev;
        frozenArgs.expectedRevision = expectedRevision;
      } else {
        delete frozenArgs.expectedRevision;
        delete frozenArgs.expectedSessionRevision;
      }
      if (targetSid) {
        const priors = priorOpsBySession.get(targetSid);
        if (priors?.length) priorBatchOpIds = [...priors];
      }

      if (c.name === 'record_active_set' && activeTargetMatch) {
        const ex = resolveExFromFrozen(activeTargetMatch, rawArgs);
        if (ex) {
          frozenArgs.exId = ex.id;
          const targetSet = resolveSetFromFrozen(ex, rawArgs);
          if (targetSet) {
            frozenArgs.setId = targetSet.id;
            frozenArgs.roundIndex = targetSet.roundIndex;
            frozenArgs.stageIndex = targetSet.stageIndex;
            const touchedFields: Array<'status' | 'reps' | 'weightKg' | 'toFailure' | 'note'> = ['status'];
            if (rawArgs.reps !== undefined) touchedFields.push('reps');
            if (rawArgs.weightKg !== undefined) touchedFields.push('weightKg');
            if (rawArgs.toFailure !== undefined) touchedFields.push('toFailure');
            if (rawArgs.note !== undefined) touchedFields.push('note');
            frozenPrecondition = {
              kind: 'set',
              sessionId: activeTargetMatch.id,
              exId: ex.id,
              setId: targetSet.id,
              beforeExName: ex.name,
              beforeTargetJson: JSON.stringify(ex.target),
              beforeStatus: targetSet.status,
              beforeReps: targetSet.reps,
              beforeWeightKg: targetSet.weightKg,
              beforeToFailure: Boolean(targetSet.toFailure),
              beforeNote: targetSet.note ?? '',
              touchedFields,
            };
            // 在本地工作副本上推进该组状态，保证同批后续省略 roundIndex 的调用解析到下一待记组
            targetSet.status =
              rawArgs.status === 'blank' || rawArgs.status === 'partial' || rawArgs.status === 'done'
                ? rawArgs.status
                : 'done';
            if (typeof rawArgs.reps === 'number' || rawArgs.reps === null) targetSet.reps = rawArgs.reps;
            if (typeof rawArgs.weightKg === 'number' || rawArgs.weightKg === null) targetSet.weightKg = rawArgs.weightKg;
          }
        }
      } else if (c.name === 'adjust_active_target' && activeTargetMatch) {
        const ex = resolveExFromFrozen(activeTargetMatch, rawArgs);
        if (ex) {
          frozenArgs.exId = ex.id;
          frozenPrecondition = {
            kind: 'exercise-target',
            sessionId: activeTargetMatch.id,
            exId: ex.id,
            beforeExName: ex.name,
            beforeTargetJson: JSON.stringify(ex.target),
            beforeRestSec: ex.restSec,
          };
        }
      } else if (c.name === 'update_active_note' && activeTargetMatch) {
        const scope = rawArgs.scope === 'exercise' || rawArgs.scope === 'set' ? rawArgs.scope : 'session';
        if (scope === 'session') {
          frozenPrecondition = {
            kind: 'session-note',
            sessionId: activeTargetMatch.id,
            beforeNote: activeTargetMatch.note ?? '',
          };
          if (typeof rawArgs.note === 'string' && !rawArgs.append) {
            activeTargetMatch.note = rawArgs.note.trim();
          }
        } else {
          const ex = resolveExFromFrozen(activeTargetMatch, rawArgs);
          if (ex) {
            frozenArgs.exId = ex.id;
            if (scope === 'exercise') {
              frozenPrecondition = {
                kind: 'exercise-note',
                sessionId: activeTargetMatch.id,
                exId: ex.id,
                beforeNote: ex.note ?? '',
              };
            } else {
              const targetSet = resolveSetFromFrozen(ex, rawArgs);
              if (targetSet) {
                frozenArgs.setId = targetSet.id;
                frozenArgs.roundIndex = targetSet.roundIndex;
                frozenArgs.stageIndex = targetSet.stageIndex;
                frozenPrecondition = {
                  kind: 'set',
                  sessionId: activeTargetMatch.id,
                  exId: ex.id,
                  setId: targetSet.id,
                  beforeExName: ex.name,
                  beforeTargetJson: JSON.stringify(ex.target),
                  beforeStatus: targetSet.status,
                  beforeReps: targetSet.reps,
                  beforeWeightKg: targetSet.weightKg,
                  beforeToFailure: Boolean(targetSet.toFailure),
                  beforeNote: targetSet.note ?? '',
                  touchedFields: ['note'],
                };
              }
            }
          }
        }
      } else if (c.name === 'manage_active_exercise' && activeTargetMatch) {
        const mode = strOrUndefined(rawArgs.mode);
        if (mode === 'add') {
          frozenPrecondition = {
            kind: 'exercise-list',
            sessionId: activeTargetMatch.id,
            beforeExIds: activeTargetMatch.exercises.map((e) => e.id),
            ...(strOrUndefined(rawArgs.insertAfterExId) ? { insertAfterExId: strOrUndefined(rawArgs.insertAfterExId) } : {}),
          };
        } else {
          const ex = resolveExFromFrozen(activeTargetMatch, rawArgs);
          if (ex) {
            frozenArgs.exId = ex.id;
            frozenPrecondition = {
              kind: 'exercise-structure',
              sessionId: activeTargetMatch.id,
              exId: ex.id,
              beforeExerciseJson: JSON.stringify({
                name: ex.name,
                form: trainingFormOf(ex.target),
                target: ex.target,
                sets: ex.sets.map((s) => ({ id: s.id, status: s.status, reps: s.reps, weightKg: s.weightKg })),
              }),
            };
          }
        }
      } else if (c.name === 'configure_superset' && activeTargetMatch) {
        frozenPrecondition = {
          kind: 'superset',
          sessionId: activeTargetMatch.id,
          beforeExercisesJson: JSON.stringify(
            activeTargetMatch.exercises.map((e) => ({
              id: e.id,
              pairId: e.pairId ?? null,
              target: e.target,
            })),
          ),
        };
      } else if (c.name === 'manage_active_warmup' && activeTargetMatch) {
        const action = strOrUndefined(rawArgs.action);
        if (action === 'add') {
          frozenPrecondition = {
            kind: 'warmup-list',
            sessionId: activeTargetMatch.id,
            beforeWarmupsJson: JSON.stringify(activeTargetMatch.warmups),
          };
        } else {
          const needle = strOrUndefined(rawArgs.warmupName ?? rawArgs.name)?.toLowerCase();
          const wid = strOrUndefined(rawArgs.warmupId);
          const w =
            (wid ? activeTargetMatch.warmups.find((x) => x.id === wid) : undefined) ??
            (needle
              ? activeTargetMatch.warmups.find((x) => x.name.trim().toLowerCase() === needle) ??
                activeTargetMatch.warmups.find((x) => x.name.trim().toLowerCase().includes(needle))
              : activeTargetMatch.warmups.length === 1
                ? activeTargetMatch.warmups[0]
                : undefined);
          if (w) {
            frozenArgs.warmupId = w.id;
            frozenPrecondition = {
              kind: 'warmup',
              sessionId: activeTargetMatch.id,
              warmupId: w.id,
              beforeWarmupJson: JSON.stringify(w),
            };
          }
        }
      } else if (c.name === 'manage_active_cardio' && activeTargetMatch) {
        const action = strOrUndefined(rawArgs.action);
        const list = activeTargetMatch.cardio ?? [];
        if (action === 'add') {
          frozenPrecondition = {
            kind: 'cardio-list',
            sessionId: activeTargetMatch.id,
            beforeCardioJson: JSON.stringify(list),
          };
        } else {
          const cid = strOrUndefined(rawArgs.cardioId);
          const needle = strOrUndefined(rawArgs.cardioName ?? rawArgs.name)?.toLowerCase();
          const entry =
            (cid ? list.find((x) => x.id === cid) : undefined) ??
            (needle
              ? list.find((x) => x.name.trim().toLowerCase() === needle) ??
                list.find((x) => x.name.trim().toLowerCase().includes(needle))
              : list.length === 1
                ? list[0]
                : undefined);
          if (entry) {
            frozenArgs.cardioId = entry.id;
            frozenPrecondition = {
              kind: 'cardio',
              sessionId: activeTargetMatch.id,
              cardioId: entry.id,
              beforeCardioJson: JSON.stringify(entry),
            };
          }
        }
      } else if (c.name === 'finish_active_session' && activeTargetMatch) {
        strictSessionRevision = true;
        frozenPrecondition = {
          kind: 'session-strict',
          sessionId: activeTargetMatch.id,
        };
      }

      if (targetSid) {
        const list = priorOpsBySession.get(targetSid) ?? [];
        list.push(operationId);
        priorOpsBySession.set(targetSid, list);
      }
    } else if (c.name === 'update_setup_note') {
      const targetSid = activeIdArg ?? workingActive?.id;
      if (targetSid && activeTargetMatch) {
        frozenArgs.sessionId = targetSid;
        const ex = resolveExFromFrozen(activeTargetMatch, rawArgs);
        if (ex) {
          frozenArgs.exId = ex.id;
          frozenArgs.exerciseId = ex.exerciseId;
          expectedRevision = typeof activeTargetMatch.revision === 'number' ? activeTargetMatch.revision : 1;
          frozenArgs.expectedRevision = expectedRevision;
          frozenPrecondition = {
            kind: 'setup-note',
            sessionId: targetSid,
            exId: ex.id,
            exerciseId: ex.exerciseId,
            beforeSessionSetupNote: ex.setupNote ?? '',
          };
        } else {
          delete frozenArgs.expectedRevision;
        }
        const priors = priorOpsBySession.get(targetSid);
        if (priors?.length) priorBatchOpIds = [...priors];
        const list = priorOpsBySession.get(targetSid) ?? [];
        list.push(operationId);
        priorOpsBySession.set(targetSid, list);
      } else {
        delete frozenArgs.expectedRevision;
      }
    } else if (c.name === 'correct_history_session') {
      const targetSid = strOrUndefined(rawArgs.sessionId);
      const hist = targetSid ? workingHistory.get(targetSid) : undefined;
      if (targetSid) {
        const priors = priorOpsBySession.get(targetSid);
        if (priors?.length) priorBatchOpIds = [...priors];
        const list = priorOpsBySession.get(targetSid) ?? [];
        list.push(operationId);
        priorOpsBySession.set(targetSid, list);
      }
      if (hist) {
        expectedRevision = typeof hist.revision === 'number' ? hist.revision : 1;
        frozenArgs.expectedRevision = expectedRevision;
        const action = strOrUndefined(rawArgs.action);
        if (action === 'update_session_note') {
          frozenPrecondition = { kind: 'session-note', sessionId: hist.id, beforeNote: hist.note ?? '' };
        } else if (action === 'update_exercise_note') {
          const ex = resolveExFromFrozen(hist, rawArgs);
          if (ex) {
            frozenArgs.exId = ex.id;
            frozenPrecondition = { kind: 'exercise-note', sessionId: hist.id, exId: ex.id, beforeNote: ex.note ?? '' };
          }
        } else if (!action || action === 'correct_set') {
          const ex = resolveExFromFrozen(hist, rawArgs);
          if (ex) {
            frozenArgs.exId = ex.id;
            const s = resolveSetFromFrozen(ex, rawArgs);
            if (s) {
              frozenArgs.setId = s.id;
              frozenArgs.roundIndex = s.roundIndex;
              frozenArgs.stageIndex = s.stageIndex;
              frozenPrecondition = {
                kind: 'set',
                sessionId: hist.id,
                exId: ex.id,
                setId: s.id,
                beforeExName: ex.name,
                beforeTargetJson: JSON.stringify(ex.target),
                beforeStatus: s.status,
                beforeReps: s.reps,
                beforeWeightKg: s.weightKg,
                beforeToFailure: Boolean(s.toFailure),
                beforeNote: s.note ?? '',
                touchedFields: ['status', 'reps', 'weightKg', 'note'],
              };
            }
          }
        } else {
          strictSessionRevision = true;
          frozenPrecondition = { kind: 'session-strict', sessionId: hist.id };
        }
      } else {
        delete frozenArgs.expectedRevision;
      }
    } else if (c.name === 'modify_existing_plan') {
      const targetPlanId = strOrUndefined(rawArgs.planId) ?? workingActive?.planId;
      const plan = targetPlanId ? workingPlans.get(targetPlanId) : undefined;
      if (targetPlanId) frozenArgs.planId = targetPlanId;
      if (plan) {
        expectedPlanRevision = plan.updatedAt;
        frozenArgs.expectedUpdatedAt = expectedPlanRevision;
        const priors = priorOpsByPlan.get(plan.id);
        if (priors?.length) priorBatchOpIds = [...priors];
        const list = priorOpsByPlan.get(plan.id) ?? [];
        list.push(operationId);
        priorOpsByPlan.set(plan.id, list);
      } else {
        delete frozenArgs.expectedUpdatedAt;
      }
    } else if (c.name === 'sync_session_to_plan') {
      const targetSid = activeIdArg ?? workingActive?.id;
      const sess = (targetSid && activeTargetMatch?.id === targetSid ? activeTargetMatch : undefined) ??
        (targetSid ? workingHistory.get(targetSid) : undefined);
      if (targetSid) frozenArgs.sessionId = targetSid;
      if (sess) {
        expectedRevision = typeof sess.revision === 'number' ? sess.revision : 1;
        frozenArgs.expectedRevision = expectedRevision;
        frozenArgs.expectedSessionRevision = expectedRevision;
        strictSessionRevision = true;
        const plan = workingPlans.get(sess.planId);
        if (plan) {
          expectedPlanRevision = plan.updatedAt;
          frozenArgs.expectedPlanUpdatedAt = expectedPlanRevision;
        } else {
          delete frozenArgs.expectedPlanUpdatedAt;
        }
      } else {
        delete frozenArgs.expectedRevision;
        delete frozenArgs.expectedSessionRevision;
        delete frozenArgs.expectedPlanUpdatedAt;
      }
      if (targetSid) {
        const priors = priorOpsBySession.get(targetSid);
        if (priors?.length) priorBatchOpIds = [...priors];
        const list = priorOpsBySession.get(targetSid) ?? [];
        list.push(operationId);
        priorOpsBySession.set(targetSid, list);
      }
    }

    return {
      toolCallId: c.id,
      index: c.index ?? idx,
      operationId,
      name: c.name,
      argumentsText: c.argumentsText,
      args: frozenArgs,
      ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(expectedPlanRevision !== undefined ? { expectedPlanRevision } : {}),
      ...(modelExpectedRevision !== undefined ? { modelExpectedRevision } : {}),
      ...(modelExpectedPlanRevision !== undefined ? { modelExpectedPlanRevision } : {}),
      expectedEpoch: params.restoreEpoch,
      ...(frozenPrecondition ? { frozenPrecondition } : {}),
      ...(priorBatchOpIds?.length ? { priorBatchOpIds } : {}),
      ...(strictSessionRevision ? { strictSessionRevision } : {}),
      toolEntrySeq,
      status: 'pending',
    };
  });
}

/**
 * 并发外部手改时，仅按本工具实际写入的字段把已提交结果合并进冻结组，
 * 其余字段（尤其是用户手改、模型未见的备注）一律保留冻结视图原值，
 * 使下一轮的字段级前置条件仍能识别“未披露手改”并返回紧凑冲突态。
 */
function mergeWrittenSetFields(
  frozenSet: SessionSet,
  committedSet: SessionSet,
  toolArgs: Record<string, unknown> | undefined,
): SessionSet {
  const next: SessionSet = { ...frozenSet };
  next.status = committedSet.status;
  if (toolArgs?.reps !== undefined) next.reps = committedSet.reps;
  if (toolArgs?.weightKg !== undefined) next.weightKg = committedSet.weightKg;
  if (toolArgs?.toFailure !== undefined) next.toFailure = committedSet.toFailure;
  if (toolArgs?.note !== undefined) next.note = committedSet.note;
  return next;
}

/**
 * 仅按本工具实际已提交的修改推进模型侧冻结视图（frozenView）：
 * 若期间发生并发外部手改（receipt.beforeRevision !== prevRevision），绝不拿整份 committedSession
 * 覆盖未触及字段或偷升版本号，确保未向模型披露的手改继续受冻结前缀与字段冲突保护。
 */
export function advanceFrozenViewForToolOutcome(params: {
  frozenView: CoachFrozenView;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  outcome: CoachToolExecutionOutcome;
}): CoachFrozenView {
  const { frozenView, toolName, toolArgs, outcome } = params;
  if (!outcome.ok) return frozenView;

  if (toolName === 'query_training_context' && outcome.queriedFrozenView) {
    return {
      ...outcome.queriedFrozenView,
      restoreEpoch: frozenView.restoreEpoch,
      historySessionsById: {
        ...frozenView.historySessionsById,
        ...outcome.queriedFrozenView.historySessionsById,
      },
    };
  }

  let nextActive = frozenView.activeSession ? structuredClone(frozenView.activeSession) : null;
  const nextHistory = { ...frozenView.historySessionsById };
  const nextPlans = { ...frozenView.plansById };
  const nextTemplates = { ...frozenView.templatesById };

  if (outcome.committedPlan) {
    nextPlans[outcome.committedPlan.id] = structuredClone(outcome.committedPlan);
  }

  const receipt = outcome.receipt;
  if (receipt) {
    const patchSessionByTarget = (
      targetSessId: string,
      apply: (sess: Session, isActive: boolean, revContiguous: boolean) => Session | null,
    ) => {
      if (nextActive && nextActive.id === targetSessId) {
        const prevRev = typeof nextActive.revision === 'number' ? nextActive.revision : 1;
        const revContiguous = receipt.beforeRevision === prevRev;
        const updated = apply(nextActive, true, revContiguous);
        nextActive = updated;
        return;
      }
      const hist = nextHistory[targetSessId];
      if (hist) {
        const prevRev = typeof hist.revision === 'number' ? hist.revision : 1;
        const revContiguous = receipt.beforeRevision === prevRev;
        const cloned = structuredClone(hist);
        const updated = apply(cloned, false, revContiguous);
        if (updated) nextHistory[targetSessId] = updated;
      }
    };

    for (const t of receipt.touchedTargets) {
      if (t.kind === 'session-set') {
        patchSessionByTarget(t.sessionId, (sess, _isActive, revContiguous) => {
          const prefillMap = new Map(
            (t.prefilledSets ?? []).map((pf) => [pf.setId, pf.afterWeightKg]),
          );
          const nextExercises = sess.exercises.map((ex) => {
            if (ex.id !== t.exId) return ex;
            return {
              ...ex,
              sets: ex.sets.map((s) => {
                if (s.id === t.setId) {
                  return revContiguous
                    ? structuredClone(t.afterSet)
                    : mergeWrittenSetFields(s, t.afterSet, toolArgs);
                }
                if (prefillMap.has(s.id)) return { ...s, weightKg: prefillMap.get(s.id)! };
                return s;
              }),
            };
          });
          return {
            ...sess,
            ...(revContiguous ? { revision: receipt.afterRevision } : {}),
            exercises: nextExercises,
          };
        });
      } else if (t.kind === 'exercise-target') {
        patchSessionByTarget(t.sessionId, (sess, _isActive, revContiguous) => {
          const nextExercises = sess.exercises.map((ex) => {
            if (ex.id !== t.exId) return ex;
            const nextEx: Session['exercises'][number] = {
              ...ex,
              target: structuredClone(t.afterTarget),
              groups: groupsFromTarget(t.afterTarget),
              ...(t.afterRestSec !== undefined ? { restSec: t.afterRestSec } : {}),
            };
            if (revContiguous) {
              nextEx.sets = structuredClone(t.afterSets);
            } else {
              // 并发外部手改：按稳定组 ID 合并结构，保留用户手改（尤其实绩备注），
              // 仅加入目标调整真正新增的组，绝不整份覆盖未披露字段。
              const frozenById = new Map((ex.sets ?? []).map((s) => [s.id, s]));
              nextEx.sets = (t.afterSets ?? []).map((afterS) =>
                frozenById.has(afterS.id) ? frozenById.get(afterS.id)! : structuredClone(afterS),
              );
            }
            return nextEx;
          });
          return {
            ...sess,
            ...(revContiguous ? { revision: receipt.afterRevision } : {}),
            exercises: nextExercises,
          };
        });
      } else if (t.kind === 'setup-note') {
        if (t.afterTemplate) {
          nextTemplates[t.exerciseId] = structuredClone(t.afterTemplate);
        }
        if (t.sessionId && t.exId) {
          patchSessionByTarget(t.sessionId, (sess, _isActive, revContiguous) => ({
            ...sess,
            ...(revContiguous ? { revision: receipt.afterRevision } : {}),
            exercises: sess.exercises.map((ex) =>
              ex.id === t.exId ? { ...ex, setupNote: t.afterSessionNote ?? '' } : ex,
            ),
          }));
        }
      } else if (
        t.kind === 'session-snapshot' ||
        t.kind === 'exercise-superset' ||
        t.kind === 'history-edit'
      ) {
        patchSessionByTarget(t.sessionId, (sess, isActive, revContiguous) => {
          if (t.afterSession.status !== 'active' && isActive) {
            if (t.afterSession.status === 'completed') {
              nextHistory[t.sessionId] = structuredClone(t.afterSession);
            }
            return null;
          }
          if (revContiguous) {
            return structuredClone(t.afterSession);
          }
          // 存在未披露并发外部修改时，保留原 revision，仅按本工具作用域打局部补丁
          if (toolName === 'update_active_note') {
            const scope = toolArgs?.scope === 'exercise' ? 'exercise' : 'session';
            if (scope === 'session') {
              return { ...sess, note: t.afterSession.note };
            }
            const targetExId =
              strOrUndefined(toolArgs?.exId) ??
              resolveExFromFrozen(sess, { exerciseName: toolArgs?.exerciseName })?.id;
            const afterEx = targetExId
              ? t.afterSession.exercises.find((e) => e.id === targetExId)
              : undefined;
            if (!afterEx) return sess;
            return {
              ...sess,
              exercises: sess.exercises.map((ex) =>
                ex.id === afterEx.id ? { ...ex, note: afterEx.note } : ex,
              ),
            };
          }
          if (toolName === 'manage_active_warmup') {
            return { ...sess, warmups: structuredClone(t.afterSession.warmups) };
          }
          if (toolName === 'manage_active_cardio') {
            return { ...sess, cardio: structuredClone(t.afterSession.cardio) };
          }
          if (toolName === 'manage_active_exercise') {
            const mode = strOrUndefined(toolArgs?.mode);
            if (mode === 'remove') {
              const afterIds = new Set(t.afterSession.exercises.map((e) => e.id));
              return {
                ...sess,
                exercises: sess.exercises.filter((e) => afterIds.has(e.id)),
              };
            }
            if (mode === 'add') {
              const beforeIds = new Set(t.beforeSession.exercises.map((e) => e.id));
              const addedIdx = t.afterSession.exercises.findIndex((e) => !beforeIds.has(e.id));
              if (addedIdx >= 0) {
                const addedEx = structuredClone(t.afterSession.exercises[addedIdx]);
                const afterAnchorId = addedIdx > 0 ? t.afterSession.exercises[addedIdx - 1].id : null;
                const insertPos = afterAnchorId
                  ? sess.exercises.findIndex((e) => e.id === afterAnchorId)
                  : -1;
                const nextList = [...sess.exercises];
                nextList.splice(insertPos >= 0 ? insertPos + 1 : nextList.length, 0, addedEx);
                return { ...sess, exercises: nextList };
              }
              return sess;
            }
            const targetExId =
              strOrUndefined(toolArgs?.exId) ??
              resolveExFromFrozen(t.beforeSession, { exerciseName: toolArgs?.exerciseName })?.id;
            const afterEx = targetExId
              ? t.afterSession.exercises.find((e) => e.id === targetExId)
              : undefined;
            if (afterEx) {
              return {
                ...sess,
                exercises: sess.exercises.map((ex) =>
                  ex.id === afterEx.id ? structuredClone(afterEx) : ex,
                ),
              };
            }
            return sess;
          }
          if (toolName === 'configure_superset') {
            const beforeById = new Map(t.beforeSession.exercises.map((e) => [e.id, e]));
            const afterById = new Map(t.afterSession.exercises.map((e) => [e.id, e]));
            const changedIds = new Set<string>();
            for (const [id, ae] of afterById) {
              const be = beforeById.get(id);
              if (
                !be ||
                be.pairId !== ae.pairId ||
                JSON.stringify(be.target) !== JSON.stringify(ae.target) ||
                be.sets.length !== ae.sets.length
              ) {
                changedIds.add(id);
              }
            }
            const nextExercises = sess.exercises.map((ex) =>
              changedIds.has(ex.id) && afterById.has(ex.id)
                ? structuredClone(afterById.get(ex.id)!)
                : ex,
            );
            for (const ae of t.afterSession.exercises) {
              if (!beforeById.has(ae.id) && !nextExercises.some((e) => e.id === ae.id)) {
                nextExercises.push(structuredClone(ae));
              }
            }
            return { ...sess, exercises: nextExercises };
          }
          if (toolName === 'correct_history_session') {
            const action = strOrUndefined(toolArgs?.action);
            if (action === 'update_session_note') {
              return { ...sess, note: t.afterSession.note };
            }
            if (action === 'correct_cardio') {
              return { ...sess, cardio: structuredClone(t.afterSession.cardio) };
            }
            const targetExId =
              strOrUndefined(toolArgs?.exId) ??
              resolveExFromFrozen(t.beforeSession, { exerciseName: toolArgs?.exerciseName })?.id;
            const afterEx = targetExId
              ? t.afterSession.exercises.find((e) => e.id === targetExId)
              : undefined;
            if (afterEx) {
              return {
                ...sess,
                exercises: sess.exercises.map((ex) =>
                  ex.id === afterEx.id ? structuredClone(afterEx) : ex,
                ),
              };
            }
          }
          return sess;
        });
      }
    }
  }

  return {
    restoreEpoch: frozenView.restoreEpoch,
    activeSession: nextActive,
    plansById: nextPlans,
    historySessionsById: nextHistory,
    templatesById: nextTemplates,
  };
}

export async function executeCoachToolCall(
  call: CoachToolCall,
  ctx: CoachToolExecutionContext,
): Promise<CoachToolExecutionOutcome> {
  if (call.parseError) {
    return {
      ok: false,
      errorCode: 'parse-error',
      summary: `参数解析失败：${call.parseError}`,
    };
  }
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const effectiveOperationId = call.operationId?.trim() || call.id;
  const preArgs = {
    ...(ctx.frozenPrecondition ? { frozenPrecondition: ctx.frozenPrecondition } : {}),
    ...(ctx.priorBatchOpIds?.length ? { priorBatchOpIds: ctx.priorBatchOpIds } : {}),
    ...(ctx.strictSessionRevision ? { strictSessionRevision: true } : {}),
    ...(ctx.modelExpectedRevision !== undefined ? { modelExpectedRevision: ctx.modelExpectedRevision } : {}),
  };

  try {
    if (ctx.requireFrozenPreconditions) {
      const requiresSessionRev = new Set([
        'adjust_active_target',
        'record_active_set',
        'manage_active_exercise',
        'update_active_note',
        'finish_active_session',
        'configure_superset',
        'manage_active_warmup',
        'manage_active_cardio',
        'correct_history_session',
      ]);
      if (requiresSessionRev.has(call.name) && numOrUndefined(args.expectedRevision) === undefined) {
        throw new TxConflictError('invalid-input', '缺少冻结版本前置条件 expectedRevision，已拒绝未锁定视图写入');
      }
      if (call.name === 'modify_existing_plan' && numOrUndefined(args.expectedUpdatedAt) === undefined) {
        throw new TxConflictError('invalid-input', '缺少冻结版本前置条件 expectedUpdatedAt，已拒绝计划覆盖');
      }
    }
    switch (call.name) {
      case 'query_training_context': {
        const includeAllHistory = Boolean(args.includeAllHistory ?? false);
        const rawLimit = numOrUndefined(args.limit);
        const limit = Math.min(20, Math.max(1, rawLimit !== undefined ? Math.trunc(rawLimit) : 5));
        const offset = Math.max(0, Math.trunc(numOrUndefined(args.offset) ?? 0));
        const sessionId = strOrUndefined(args.sessionId);
        const includeDetails = Boolean(args.includeDetails ?? Boolean(sessionId));
        const { roCtx: snapshot, frozenView: queriedFrozenView } =
          await buildCoachReadOnlyContextWithView(
            ctx,
            {
              includeAllHistory,
              historyLimit: includeAllHistory && rawLimit === undefined ? undefined : limit,
              historyOffset: offset,
              sessionId,
              includeDetails,
            },
            ctx.expectedEpoch ?? 0,
          );
        return {
          ok: true,
          summary: includeAllHistory
            ? `已分页读取历史训练（共 ${snapshot.totalCompletedSessions} 条，本页 ${snapshot.historySessions.length} 条）`
            : `已读取当前训练概览与最近 ${snapshot.historySessions.length}/${snapshot.totalCompletedSessions} 条历史`,
          queriedFrozenView,
          data: {
            ...snapshot,
            pageOffset: offset,
            pageLimit: limit,
            hasMore: offset + snapshot.historySessions.length < snapshot.totalCompletedSessions,
          } as unknown as Record<string, unknown>,
        };
      }

      case 'adjust_active_target': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可调整目标');
        const res = await coachAdjustActiveTarget(
          {
            operationId: effectiveOperationId,
            sessionId,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            deferTimerDispatch: ctx.deferTimerDispatch,
            ...preArgs,
            form: formOrUndefined(args.form),
            sets: numOrUndefined(args.sets),
            setsMax: numOrUndefined(args.setsMax),
            repsMin: numOrUndefined(args.repsMin),
            repsMax: numOrUndefined(args.repsMax),
            suggestedWeightKg: numOrNullOrUndefined(args.suggestedWeightKg),
            weightMode: strOrUndefined(args.weightMode) as 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted' | undefined,
            dumbbellBasis: strOrUndefined(args.dumbbellBasis) as 'per_hand' | 'total' | undefined,
            toFailure: typeof args.toFailure === 'boolean' ? args.toFailure : undefined,
            restSec: numOrUndefined(args.restSec),
            restInSec: numOrUndefined(args.restInSec),
            restAfterSec: numOrUndefined(args.restAfterSec),
            stages: parseStagesArg(args.stages),
            allowDiscardLoggedData: Boolean(args.allowDiscardLoggedData),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'record_active_set': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可记录实绩');
        const statusArg = args.status;
        const status =
          statusArg === 'done' || statusArg === 'blank' || statusArg === 'partial'
            ? statusArg
            : undefined;
        const targetMode =
          args.targetMode === 'last_completed' || args.targetMode === 'next_pending'
            ? args.targetMode
            : undefined;
        const res = await coachRecordActiveSet(
          {
            operationId: effectiveOperationId,
            sessionId,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            setId: strOrUndefined(args.setId),
            roundIndex: numOrUndefined(args.roundIndex),
            stageIndex: numOrUndefined(args.stageIndex),
            targetMode,
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            deferTimerDispatch: ctx.deferTimerDispatch,
            ...preArgs,
            reps: numOrNullOrUndefined(args.reps),
            weightKg: numOrNullOrUndefined(args.weightKg),
            status,
            toFailure: typeof args.toFailure === 'boolean' ? args.toFailure : undefined,
            note: typeof args.note === 'string' ? args.note : undefined,
          },
          ctx.hooks,
        );
        return {
          ok: true,
          summary: res.receipt.summary,
          receipt: res.receipt,
          committedSession: res.session,
          ...(res.timerDirective ? { timerDirective: res.timerDirective } : {}),
          data: { timerStarted: Boolean(res.receipt.timerStarted) },
        };
      }

      case 'manage_active_exercise': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可编辑动作');
        const mode = strOrUndefined(args.mode);
        const commonSpec = {
          form: formOrUndefined(args.form),
          sets: numOrUndefined(args.sets),
          repsMin: numOrUndefined(args.repsMin),
          repsMax: numOrUndefined(args.repsMax),
          suggestedWeightKg: numOrNullOrUndefined(args.suggestedWeightKg),
          weightMode: strOrUndefined(args.weightMode) as 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted' | undefined,
          dumbbellBasis: strOrUndefined(args.dumbbellBasis) as 'per_hand' | 'total' | undefined,
          restSec: numOrUndefined(args.restSec),
          restInSec: numOrUndefined(args.restInSec),
          restAfterSec: numOrUndefined(args.restAfterSec),
          stages: parseStagesArg(args.stages),
        };
        if (mode === 'replace') {
          const res = await coachManageActiveExercise(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision: numOrUndefined(args.expectedRevision),
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
              mode: 'replace',
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              newName: strOrUndefined(args.newName) ?? '',
              setupNote: typeof args.setupNote === 'string' ? args.setupNote : undefined,
              allowDiscardLoggedData: Boolean(args.allowDiscardLoggedData),
              ...commonSpec,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
        }
        if (mode === 'add') {
          const res = await coachManageActiveExercise(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision: numOrUndefined(args.expectedRevision),
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
              mode: 'add',
              newName: strOrUndefined(args.newName) ?? '',
              insertAfterExId: strOrUndefined(args.insertAfterExId),
              setupNote: typeof args.setupNote === 'string' ? args.setupNote : undefined,
              ...commonSpec,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
        }
        if (mode === 'convert_form') {
          const form = formOrUndefined(args.form) ?? 'straight';
          const res = await coachManageActiveExercise(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision: numOrUndefined(args.expectedRevision),
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
              mode: 'convert_form',
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              allowDiscardLoggedData: Boolean(args.allowDiscardLoggedData),
              ...commonSpec,
              form,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
        }
        if (mode === 'remove' || mode === 'skip_remaining' || mode === 'unskip') {
          const res = await coachManageActiveExercise(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision: numOrUndefined(args.expectedRevision),
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
              mode,
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              allowDiscardLoggedData: Boolean(args.allowDiscardLoggedData),
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
        }
        throw new TxConflictError('invalid-input', '未知的进行中动作管理模式');
      }

      case 'update_active_note': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可写入备注');
        const scope = args.scope === 'exercise' || args.scope === 'set' ? args.scope : 'session';
        const targetMode =
          args.targetMode === 'last_completed' || args.targetMode === 'next_pending'
            ? args.targetMode
            : undefined;
        const res = await coachUpdateActiveNote(
          {
            operationId: effectiveOperationId,
            sessionId,
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            ...preArgs,
            scope,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            setId: strOrUndefined(args.setId),
            roundIndex: numOrUndefined(args.roundIndex),
            stageIndex: numOrUndefined(args.stageIndex),
            targetMode,
            note: String(args.note ?? ''),
            append: Boolean(args.append),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'finish_active_session': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可结束');
        const res = await coachFinishActiveSession(
          {
            operationId: effectiveOperationId,
            sessionId,
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            ...preArgs,
            syncBackToPlanDay: Boolean(args.syncBackToPlanDay),
            advanceCycle: args.advanceCycle === undefined ? true : Boolean(args.advanceCycle),
            note: typeof args.note === 'string' ? args.note : undefined,
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session, committedPlan: res.plan };
      }

      case 'configure_superset': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可配对超级组');
        const mode = strOrUndefined(args.mode);
        const expectedRevision = numOrUndefined(args.expectedRevision);
        if (mode === 'pair') {
          const exIds = Array.isArray(args.exIds) ? args.exIds.map(String) : [];
          const res = await coachConfigureSuperset(
            {
              operationId: effectiveOperationId,
              sessionId,
              mode: 'pair',
              exIds,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session, data: res.meta };
        }
        if (mode === 'unpair') {
          const exIds = Array.isArray(args.exIds) ? args.exIds.map(String) : [];
          const res = await coachConfigureSuperset(
            {
              operationId: effectiveOperationId,
              sessionId,
              mode: 'unpair',
              exIds,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
        }
        if (mode === 'convert_multistage') {
          const exId = strOrUndefined(args.exId) ?? '';
          const partnerName = strOrUndefined(args.partnerName) ?? '配对动作';
          const res = await coachConfigureSuperset(
            {
              operationId: effectiveOperationId,
              sessionId,
              mode: 'convert_multistage',
              exId,
              partnerName,
              rounds: numOrUndefined(args.rounds),
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              deferTimerDispatch: ctx.deferTimerDispatch,
              ...preArgs,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session, data: res.meta };
        }
        throw new TxConflictError('invalid-input', '未知的超级组配置方式');
      }

      case 'manage_active_warmup': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可修改热身');
        const action = strOrUndefined(args.action);
        if (action !== 'toggle_done' && action !== 'add' && action !== 'update' && action !== 'remove') {
          throw new TxConflictError('invalid-input', '未知的热身操作类型');
        }
        const unit = args.unit === 'time' || args.unit === 'breath' || args.unit === 'reps' ? args.unit : undefined;
        const res = await coachManageActiveWarmup(
          {
            operationId: effectiveOperationId,
            sessionId,
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            ...preArgs,
            action,
            warmupId: strOrUndefined(args.warmupId),
            warmupName: strOrUndefined(args.warmupName),
            done: typeof args.done === 'boolean' ? args.done : undefined,
            name: strOrUndefined(args.name),
            unit,
            targetText: typeof args.targetText === 'string' ? args.targetText : undefined,
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'manage_active_cardio': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可操作有氧');
        const action = strOrUndefined(args.action);
        const validActions = ['add', 'update_params', 'start', 'pause', 'resume', 'complete', 'remove'] as const;
        if (!action || !validActions.includes(action as (typeof validActions)[number])) {
          throw new TxConflictError('invalid-input', '未知的有氧操作类型');
        }
        const res = await coachManageActiveCardio(
          {
            operationId: effectiveOperationId,
            sessionId,
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            ...preArgs,
            action: action as (typeof validActions)[number],
            cardioId: strOrUndefined(args.cardioId),
            cardioName: strOrUndefined(args.cardioName),
            preset: strOrUndefined(args.preset) as CardioPreset | undefined,
            name: strOrUndefined(args.name),
            params: (args.params && typeof args.params === 'object' ? args.params : undefined) as Partial<CardioParams> | undefined,
            note: typeof args.note === 'string' ? args.note : undefined,
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'update_setup_note': {
        const res = await coachUpdateSetupNote(
          {
            operationId: effectiveOperationId,
            sessionId: strOrUndefined(args.sessionId) ?? ctx.activeSession?.id,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            exerciseId: strOrUndefined(args.exerciseId),
            expectedRevision: numOrUndefined(args.expectedRevision),
            expectedEpoch: ctx.expectedEpoch,
            ...preArgs,
            note: String(args.note ?? ''),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'correct_history_session': {
        const sessionId = strOrUndefined(args.sessionId);
        if (!sessionId) throw new TxConflictError('invalid-input', '请指定要纠错的历史训练记录');
        const action = strOrUndefined(args.action);
        const expectedRevision = numOrUndefined(args.expectedRevision);
        let res;
        if (action === 'update_session_note') {
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action,
              note: String(args.note ?? ''),
            },
            ctx.hooks,
          );
        } else if (action === 'update_exercise_note') {
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action,
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              note: String(args.note ?? ''),
            },
            ctx.hooks,
          );
        } else if (action === 'append_group') {
          const statusArg = args.status;
          const status = statusArg === 'done' || statusArg === 'blank' || statusArg === 'partial' ? statusArg : undefined;
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action,
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              reps: numOrNullOrUndefined(args.reps),
              weightKg: numOrNullOrUndefined(args.weightKg),
              status,
              note: typeof args.note === 'string' ? args.note : undefined,
            },
            ctx.hooks,
          );
        } else if (action === 'remove_blank_group') {
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action,
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              roundIndex: numOrUndefined(args.roundIndex) ?? 1,
            },
            ctx.hooks,
          );
        } else if (action === 'correct_cardio') {
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action,
              cardioId: strOrUndefined(args.cardioId),
              cardioName: strOrUndefined(args.cardioName),
              durationSec: numOrUndefined(args.durationSec),
              elapsedMs: numOrUndefined(args.elapsedMs),
              params: (args.params && typeof args.params === 'object' ? args.params : undefined) as CardioParams | undefined,
              note: typeof args.note === 'string' ? args.note : undefined,
            },
            ctx.hooks,
          );
        } else {
          const statusArg = args.status;
          const status = statusArg === 'done' || statusArg === 'blank' || statusArg === 'partial' ? statusArg : undefined;
          res = await coachCorrectHistory(
            {
              operationId: effectiveOperationId,
              sessionId,
              expectedRevision,
              expectedEpoch: ctx.expectedEpoch,
              ...preArgs,
              action: 'correct_set',
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              setId: strOrUndefined(args.setId),
              roundIndex: numOrUndefined(args.roundIndex),
              stageIndex: numOrUndefined(args.stageIndex),
              targetMode:
                args.targetMode === 'last_completed' || args.targetMode === 'next_pending'
                  ? args.targetMode
                  : undefined,
              reps: numOrNullOrUndefined(args.reps),
              weightKg: numOrNullOrUndefined(args.weightKg),
              status,
              note: typeof args.note === 'string' ? args.note : undefined,
            },
            ctx.hooks,
          );
        }
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedSession: res.session };
      }

      case 'create_plan_from_draft': {
        const draft = args.draft as CoachPlanDraft | undefined;
        if (!isDraftStructure(draft)) {
          throw new TxConflictError('invalid-input', '草稿结构不完整，请提供训练日、动作、组次和重量字段');
        }
        return {
          ok: true,
          summary: '草稿已显示，请在卡片中核对并点击创建计划。',
          draftPlan: { ...draft, id: crypto.randomUUID(), confirmedPlanId: undefined },
        };
      }

      case 'modify_existing_plan': {
        const planId = strOrUndefined(args.planId) ?? (await getPlan(ctx.activeSession?.planId ?? ''))?.id;
        if (!planId) throw new TxConflictError('not-found', '请指定要修改的训练计划');
        const action = args.action as Parameters<typeof coachModifyExistingPlan>[0]['action'];
        const res = await coachModifyExistingPlan(
          {
            operationId: effectiveOperationId,
            planId,
            expectedUpdatedAt: numOrUndefined(args.expectedUpdatedAt),
            ...(ctx.modelExpectedPlanUpdatedAt !== undefined
              ? { modelExpectedUpdatedAt: ctx.modelExpectedPlanUpdatedAt }
              : {}),
            expectedEpoch: ctx.expectedEpoch,
            ...(ctx.priorBatchOpIds?.length ? { priorBatchOpIds: ctx.priorBatchOpIds } : {}),
            action,
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt, committedPlan: res.plan };
      }

      case 'sync_session_to_plan': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '找不到目标训练会话');
        const scope = args.scope === 'sync-to-plan' ? 'sync-to-plan' : 'session-only';
        const res = await coachSyncSessionToPlan(
          {
            operationId: effectiveOperationId,
            sessionId,
            scope,
            expectedPlanUpdatedAt: numOrUndefined(args.expectedPlanUpdatedAt),
            expectedSessionRevision: numOrUndefined(args.expectedSessionRevision ?? args.expectedRevision),
            ...(ctx.modelExpectedRevision !== undefined ? { modelExpectedRevision: ctx.modelExpectedRevision } : {}),
            ...(ctx.modelExpectedPlanUpdatedAt !== undefined
              ? { modelExpectedPlanUpdatedAt: ctx.modelExpectedPlanUpdatedAt }
              : {}),
            expectedEpoch: ctx.expectedEpoch,
            ...(ctx.priorBatchOpIds?.length ? { priorBatchOpIds: ctx.priorBatchOpIds } : {}),
            ...(ctx.strictSessionRevision ? { strictSessionRevision: true } : {}),
            alsoFinishSession: Boolean(args.alsoFinishSession),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.message, receipt: res.receipt, committedSession: res.session, committedPlan: res.plan };
      }

      case 'manage_coach_memory': {
        const action = args.action === 'delete' ? 'delete' : 'save';
        const validCategories = new Set(['profile', 'preference', 'injury', 'equipment', 'habit', 'lesson']);
        const category = typeof args.category === 'string' && validCategories.has(args.category)
          ? (args.category as CoachMemoryCategory)
          : 'preference';
        const res = await coachManageMemory(
          {
            operationId: effectiveOperationId,
            expectedEpoch: ctx.expectedEpoch,
            action,
            id: strOrUndefined(args.id),
            category,
            title: strOrUndefined(args.title),
            content: strOrUndefined(args.content),
            pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined,
            source: 'coach',
          },
          ctx.hooks,
        );
        return {
          ok: true,
          summary: res.receipt.summary,
          receipt: res.receipt,
          ...(res.savedItem ? { data: { memoryId: res.savedItem.id } } : {}),
          ...(res.removedItem
            ? {
                deletedMemory: {
                  id: res.removedItem.id,
                  title: res.removedItem.title,
                  content: res.removedItem.content,
                },
              }
            : {}),
        };
      }

      case 'search_coach_history': {
        const query = String(args.query ?? '').trim();
        const found = await searchCoachMemoryAndThreads(query, {
          limit: numOrUndefined(args.limit),
          excludeThreadId: ctx.activeThreadId,
        });
        return {
          ok: true,
          summary: `检索到 ${found.memories.length} 条长期记忆与 ${found.messages.length} 条过往对话片段`,
          data: found as unknown as Record<string, unknown>,
        };
      }

      case 'web_search': {
        if (ctx.isWebSearchAllowed && !ctx.isWebSearchAllowed()) {
          return {
            ok: false,
            errorCode: 'web-search-disabled',
            summary: '联网搜索开关已关闭，已阻断外部搜索请求。',
          };
        }
        if (!ctx.webSearchRunner) {
          return {
            ok: false,
            errorCode: 'web-search-disabled',
            summary: '当前未开启联网或未配置搜索服务 Key。',
          };
        }
        const query = String(args.query ?? '').trim();
        if (!query) throw new TxConflictError('invalid-input', '搜索关键词不能为空');
        return ctx.webSearchRunner(query);
      }

      default:
        return {
          ok: false,
          errorCode: 'unsupported-tool',
          summary: '未知操作，暂不支持直接写入。',
        };
    }
  } catch (err) {
    if (err instanceof TxConflictError) {
      let conflictData: Record<string, unknown> | undefined =
        err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : undefined;
      if (
        err.reason === 'version-conflict' &&
        (call.name === 'record_active_set' ||
          (call.name === 'update_active_note' && args.scope === 'set') ||
          call.name === 'correct_history_session')
      ) {
        const targetSid = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (targetSid) {
          const latestSess = await getSession(targetSid).catch(() => undefined);
          const latestEx = resolveExFromFrozen(latestSess, args);
          const latestSet = resolveSetFromFrozen(latestEx, args);
          if (latestSet) {
            conflictData = {
              ...(conflictData ?? {}),
              latestSet: {
                id: latestSet.id,
                r: latestSet.roundIndex,
                st: latestSet.stageIndex,
                reps: latestSet.reps,
                kg: latestSet.weightKg,
                status: latestSet.status,
                ...(latestSet.note ? { note: latestSet.note } : {}),
              },
            };
          }
        }
      }
      return {
        ok: false,
        errorCode: err.reason,
        summary: err.message,
        ...(conflictData ? { data: conflictData } : {}),
      };
    }
    return {
      ok: false,
      errorCode: 'unknown',
      summary: err instanceof Error ? err.message : '执行失败',
    };
  }
}
