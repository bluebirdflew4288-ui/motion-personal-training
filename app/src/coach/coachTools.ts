/* 电子教练业务工具注册与统一调度（阶段 2）。
   关键边界：
   · 7 类写操作全部经由 coachTx.ts 原子事务层落盘，返回结构化 OperationReceipt；
   · warmups、6 种 CARDIO_PRESETS 与 setupNote 严格只读：可读取供复盘建议，用户要求改动时如实说明暂不提供写入工具；
   · 任何跨历史查询前强制 await ensureFullHistory() 并读 IDB 全量列表，绝不受限于启动首阶段 40 条快照；
   · 绝不向终端用户透出内部英文工具名。 */

import { getPlan, listPlans, listSessions } from '../db/repo';
import { listExerciseTemplates } from '../db/templates';
import { CARDIO_PRESET_CHOICES } from '../domain/cardio';
import { summarizeSession } from '../domain/session';
import { setupNoteFor } from '../domain/setupNote';
import type { ExerciseTemplate, Plan, Session } from '../domain/types';
import {
  coachAdjustActiveTarget,
  coachConfigureSuperset,
  coachCorrectHistory,
  coachModifyExistingPlan,
  coachRecordActiveSet,
  coachSyncSessionToPlan,
  TxConflictError,
  type CoachTxHooks,
} from './coachTx';
import type { CoachOperationReceipt, CoachPlanDraft } from './coachStorage';
import type { CoachToolCall, CoachToolDefinition } from './providerAdapter';

export interface CoachToolExecutionContext {
  activeSession?: Session | null;
  plans?: Plan[];
  exerciseTemplates?: ExerciseTemplate[] | Record<string, ExerciseTemplate>;
  historyHydrated?: boolean;
  ensureFullHistory?: () => Promise<unknown>;
  hooks?: CoachTxHooks;
}

export interface CoachToolExecutionOutcome {
  ok: boolean;
  summary: string;
  receipt?: CoachOperationReceipt;
  draftPlan?: CoachPlanDraft;
  data?: Record<string, unknown>;
  errorCode?: string;
}

export interface CoachReadOnlyContext {
  activeSession: {
    id: string;
    revision: number;
    planId: string;
    planName: string;
    dayName: string;
    warmups: Array<{ id: string; name: string; unit: string; targetText: string; done: boolean }>;
    cardioEntries: Array<{ id: string; preset: string; name: string; status: string; elapsedMs: number }>;
    exercises: Array<{
      id: string;
      name: string;
      pairId?: string;
      setupNote?: string;
      target: unknown;
      sets: Array<{ id: string; roundIndex: number; stageIndex: number; reps: number | null; weightKg: number | null; status: string }>;
    }>;
  } | null;
  cardioPresets: Array<{ preset: string; label: string; params: Record<string, unknown> }>;
  plans: Array<{
    id: string;
    name: string;
    updatedAt: number;
    days: Array<{ id: string; name: string; exercises: Array<{ id: string; name: string; pairId?: string; target: unknown }> }>;
  }>;
  totalCompletedSessions: number;
  historySessions: Array<{
    id: string;
    planName: string;
    dayName: string;
    startedAt: number;
    endedAt: number | null;
    completedSets: number;
    note: string;
    exercises: Array<{ id: string; name: string; pairId?: string; setupNote?: string; setsCount: number; maxWeightKg: number | null; totalReps: number }>;
  }>;
}

export async function buildCoachReadOnlyContext(
  ctx: CoachToolExecutionContext,
  opts?: { includeAllHistory?: boolean; historyLimit?: number },
): Promise<CoachReadOnlyContext> {
  if (opts?.includeAllHistory && ctx.ensureFullHistory && !ctx.historyHydrated) {
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
    templateList.map((t) => [t.exerciseId, t]),
  );

  const active =
    allSessions.find((s) => s.status === 'active') ??
    (ctx.activeSession?.status === 'active' ? ctx.activeSession : undefined);

  const completed = allSessions
    .filter((s) => s.status === 'completed')
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));

  const limitedHistory =
    opts?.includeAllHistory || !opts?.historyLimit ? completed : completed.slice(0, opts.historyLimit);

  return {
    activeSession: active
      ? {
          id: active.id,
          revision: active.revision ?? 1,
          planId: active.planId,
          planName: active.planName,
          dayName: active.day.dayName,
          warmups: active.warmups.map((w) => ({
            id: w.id,
            name: w.name,
            unit: w.unit,
            targetText: w.targetText,
            done: w.done,
          })),
          cardioEntries: (active.cardio ?? []).map((c) => ({
            id: c.id,
            preset: c.preset,
            name: c.name,
            status: c.status,
            elapsedMs: c.elapsedMs,
          })),
          exercises: active.exercises.map((ex) => ({
            id: ex.id,
            name: ex.name,
            pairId: ex.pairId,
            setupNote: setupNoteFor(ex, templatesById[ex.exerciseId ?? ex.name]),
            target: ex.target,
            sets: ex.sets.map((s) => ({
              id: s.id,
              roundIndex: s.roundIndex,
              stageIndex: s.stageIndex,
              reps: s.reps,
              weightKg: s.weightKg,
              status: s.status,
            })),
          })),
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
        exercises: d.exercises.map((e) => ({
          id: e.id,
          name: e.name,
          pairId: e.pairId,
          target: e.target,
        })),
      })),
    })),
    totalCompletedSessions: completed.length,
    historySessions: limitedHistory.map((s) => {
      const sum = summarizeSession(s);
      return {
        id: s.id,
        planName: s.planName,
        dayName: s.day.dayName,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        completedSets: sum.completedSets,
        note: s.note,
        exercises: s.exercises.map((e) => {
          const done = e.sets.filter((st) => st.status === 'done');
          const weights = done.map((st) => st.weightKg).filter((w): w is number => w !== null);
          return {
            id: e.id,
            name: e.name,
            pairId: e.pairId,
            setupNote: setupNoteFor(e, templatesById[e.exerciseId ?? e.name]),
            setsCount: done.length,
            maxWeightKg: weights.length ? Math.max(...weights) : null,
            totalReps: done.reduce((acc, st) => acc + (st.reps ?? 0), 0),
          };
        }),
      };
    }),
  };
}

export const COACH_TOOL_DEFINITIONS: CoachToolDefinition[] = [
  {
    name: 'query_training_context',
    description: '只读查询当前训练、所有计划、热身、6种有氧预设、器械档位备忘与全量历史训练记录。',
    parameters: {
      type: 'object',
      properties: {
        includeAllHistory: { type: 'boolean', description: '查询全部历史记录时传 true，触发完整历史水合。' },
      },
    },
  },
  {
    name: 'adjust_active_target',
    description: '调整本次进行中训练某动作的目标参数（组数/目标次数区间/参考重量/组间休息），绝不标为已完成。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        expectedRevision: { type: 'number' },
        sets: { type: 'number' },
        repsMin: { type: 'number' },
        repsMax: { type: 'number' },
        suggestedWeightKg: { type: ['number', 'null'] },
        restSec: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'record_active_set',
    description: '原子记录或修正本次进行中训练某一组的次数、重量与完成状态（只有非done->done才触发休息计时）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        setId: { type: 'string' },
        roundIndex: { type: 'number' },
        stageIndex: { type: 'number' },
        expectedRevision: { type: 'number' },
        reps: { type: ['number', 'null'] },
        weightKg: { type: ['number', 'null'] },
        status: { type: 'string', enum: ['done', 'blank', 'partial'] },
        toFailure: { type: 'boolean' },
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
    name: 'correct_history_session',
    description: '对已完成的历史训练做纠错（修改组实绩、备注或有氧时长）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        expectedRevision: { type: 'number' },
        action: { type: 'string' },
        exId: { type: 'string' },
        exerciseName: { type: 'string' },
        roundIndex: { type: 'number' },
        reps: { type: ['number', 'null'] },
        weightKg: { type: ['number', 'null'] },
        note: { type: 'string' },
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
    description: '对已有训练计划执行定向修改（重命名、增删动作、调整目标或超级组配对）。',
    parameters: {
      type: 'object',
      properties: {
        planId: { type: 'string' },
        expectedUpdatedAt: { type: 'number' },
        action: { type: 'object' },
      },
      required: ['planId', 'action'],
    },
  },
  {
    name: 'sync_session_to_plan',
    description: '显式选择仅保留本次调整，或将本次训练编排差量同步回原计划模板（保留长期计划另添动作）。',
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
];

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

  try {
    switch (call.name) {
      case 'query_training_context': {
        const snapshot = await buildCoachReadOnlyContext(ctx, {
          includeAllHistory: Boolean(args.includeAllHistory ?? true),
        });
        return {
          ok: true,
          summary: `已读取最新训练与全量历史（共 ${snapshot.totalCompletedSessions} 条完成记录）`,
          data: snapshot as unknown as Record<string, unknown>,
        };
      }

      case 'adjust_active_target': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可调整目标');
        const res = await coachAdjustActiveTarget(
          {
            operationId: call.id,
            sessionId,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            expectedRevision: numOrUndefined(args.expectedRevision),
            sets: numOrUndefined(args.sets),
            setsMax: numOrUndefined(args.setsMax),
            repsMin: numOrUndefined(args.repsMin),
            repsMax: numOrUndefined(args.repsMax),
            suggestedWeightKg: numOrNullOrUndefined(args.suggestedWeightKg),
            restSec: numOrUndefined(args.restSec),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt };
      }

      case 'record_active_set': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可记录实绩');
        const statusArg = args.status;
        const status =
          statusArg === 'done' || statusArg === 'blank' || statusArg === 'partial'
            ? statusArg
            : undefined;
        const res = await coachRecordActiveSet(
          {
            operationId: call.id,
            sessionId,
            exId: strOrUndefined(args.exId),
            exerciseName: strOrUndefined(args.exerciseName),
            setId: strOrUndefined(args.setId),
            roundIndex: numOrUndefined(args.roundIndex),
            stageIndex: numOrUndefined(args.stageIndex),
            expectedRevision: numOrUndefined(args.expectedRevision),
            reps: numOrNullOrUndefined(args.reps),
            weightKg: numOrNullOrUndefined(args.weightKg),
            status,
            toFailure: typeof args.toFailure === 'boolean' ? args.toFailure : undefined,
          },
          ctx.hooks,
        );
        return {
          ok: true,
          summary: res.receipt.summary,
          receipt: res.receipt,
          data: { timerStarted: Boolean(res.receipt.timerStarted) },
        };
      }

      case 'configure_superset': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '当前没有进行中的训练可配对超级组');
        const mode = strOrUndefined(args.mode);
        const expectedRevision = numOrUndefined(args.expectedRevision);
        if (mode === 'pair') {
          const exIds = Array.isArray(args.exIds) ? args.exIds.map(String) : [];
          const res = await coachConfigureSuperset(
            { operationId: call.id, sessionId, mode: 'pair', exIds, expectedRevision },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, data: res.meta };
        }
        if (mode === 'unpair') {
          const exIds = Array.isArray(args.exIds) ? args.exIds.map(String) : [];
          const res = await coachConfigureSuperset(
            { operationId: call.id, sessionId, mode: 'unpair', exIds, expectedRevision },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt };
        }
        if (mode === 'convert_multistage') {
          const exId = strOrUndefined(args.exId) ?? '';
          const partnerName = strOrUndefined(args.partnerName) ?? '配对动作';
          const res = await coachConfigureSuperset(
            {
              operationId: call.id,
              sessionId,
              mode: 'convert_multistage',
              exId,
              partnerName,
              rounds: numOrUndefined(args.rounds),
              expectedRevision,
            },
            ctx.hooks,
          );
          return { ok: true, summary: res.receipt.summary, receipt: res.receipt, data: res.meta };
        }
        throw new TxConflictError('invalid-input', '未知的超级组配置方式');
      }

      case 'correct_history_session': {
        const sessionId = strOrUndefined(args.sessionId);
        if (!sessionId) throw new TxConflictError('invalid-input', '请指定要纠错的历史训练记录');
        const action = strOrUndefined(args.action);
        const expectedRevision = numOrUndefined(args.expectedRevision);
        let res;
        if (action === 'update_session_note') {
          res = await coachCorrectHistory(
            { operationId: call.id, sessionId, expectedRevision, action, note: String(args.note ?? '') },
            ctx.hooks,
          );
        } else if (action === 'update_exercise_note') {
          res = await coachCorrectHistory(
            {
              operationId: call.id,
              sessionId,
              expectedRevision,
              action,
              exId: String(args.exId ?? ''),
              note: String(args.note ?? ''),
            },
            ctx.hooks,
          );
        } else if (action === 'append_group') {
          res = await coachCorrectHistory(
            { operationId: call.id, sessionId, expectedRevision, action, exId: String(args.exId ?? '') },
            ctx.hooks,
          );
        } else if (action === 'remove_blank_group') {
          res = await coachCorrectHistory(
            {
              operationId: call.id,
              sessionId,
              expectedRevision,
              action,
              exId: String(args.exId ?? ''),
              roundIndex: numOrUndefined(args.roundIndex) ?? 1,
            },
            ctx.hooks,
          );
        } else {
          res = await coachCorrectHistory(
            {
              operationId: call.id,
              sessionId,
              expectedRevision,
              action: 'correct_set',
              exId: strOrUndefined(args.exId),
              exerciseName: strOrUndefined(args.exerciseName),
              roundIndex: numOrUndefined(args.roundIndex),
              reps: numOrNullOrUndefined(args.reps),
              weightKg: numOrNullOrUndefined(args.weightKg),
            },
            ctx.hooks,
          );
        }
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt };
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
            operationId: call.id,
            planId,
            expectedUpdatedAt: numOrUndefined(args.expectedUpdatedAt),
            action,
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.receipt.summary, receipt: res.receipt };
      }

      case 'sync_session_to_plan': {
        const sessionId = strOrUndefined(args.sessionId) ?? ctx.activeSession?.id;
        if (!sessionId) throw new TxConflictError('not-found', '找不到目标训练会话');
        const scope = args.scope === 'sync-to-plan' ? 'sync-to-plan' : 'session-only';
        const res = await coachSyncSessionToPlan(
          {
            operationId: call.id,
            sessionId,
            scope,
            expectedPlanUpdatedAt: numOrUndefined(args.expectedPlanUpdatedAt),
            alsoFinishSession: Boolean(args.alsoFinishSession),
          },
          ctx.hooks,
        );
        return { ok: true, summary: res.message, receipt: res.receipt };
      }

      default:
        return {
          ok: false,
          errorCode: 'unsupported-tool',
          summary: '该操作在当前版本中仅提供只读查看或暂不支持自动写入，请在界面手动处理。',
        };
    }
  } catch (err) {
    if (err instanceof TxConflictError) {
      return {
        ok: false,
        errorCode: err.reason,
        summary: err.message,
      };
    }
    return {
      ok: false,
      errorCode: 'unknown',
      summary: err instanceof Error ? err.message : '执行失败',
    };
  }
}
