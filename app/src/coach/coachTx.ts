/* 电子教练原子事务层与字段级独立撤销（阶段 2）。
   安全契约：
   1. 单写入通道与乐观锁：所有写操作基于 IDB 最新记录与 revision/updatedAt，在原子事务内完成；
   2. 焦点避让：写前核验 checkFocusConflict，绝不静默覆盖用户正在输入或持有 dirty raw 的单元格；
   3. 诚实数据状态：已完成组写入空/非正次数或非法重量时显式阻断并抛 TxConflictError('dirty-state')；
   4. 诚实倒计时：只有当组状态从「非 done -> done」时才触发 RestTimer；
   5. 字段级独立撤销：核验 restoreEpoch 与目标字段未被后续冲突覆写后精准回滚，保留用户对其他组（如第 3 组）的后续手动修改。 */

import { openDb } from '../db/idb';
import {
  atomicDeletePlanWithCurrent,
  getPlan,
  getSession,
  savePlan,
} from '../db/repo';
import {
  atomicFinishSession,
  atomicInsertPlan,
  atomicSaveHistoryEdit,
  atomicWriteSession,
  revisionOf,
  type WriteFailureReason,
} from '../db/tx';
import { validateDataDeep } from '../db/validate';
import {
  appendBlankGroupToHistoryExercise,
  correctHistoryCardioEntry,
  removeBlankGroupFromHistoryExercise,
  updateHistoryExerciseNote,
  updateHistorySessionNote,
} from '../domain/historyEdit';
import { exerciseIdFromName } from '../domain/identity';
import {
  MAX_LOGGED_REPS,
  MAX_PLANS,
  MAX_REST,
  MAX_ROUNDS,
  MAX_STRAIGHT_SETS,
  MAX_WEIGHT,
} from '../domain/limits';
import {
  addExercise,
  removeExercise,
  renameDay,
  renamePlan,
  updateExercise,
  updateTarget,
} from '../domain/planEdit';
import {
  applyTargetToSessionExercise,
  hasReps,
  newId,
  restAfterSet,
  withExercise,
  withSetAndPrefillFollowingWeight,
} from '../domain/session';
import { applySessionArrangementToPlan, diffSessionVsPlanDay } from '../domain/sessionToPlanSync';
import {
  cleanOrphanPairIds,
  convertExerciseToMultiStageSuperset,
  generateUuidV4,
  pairExercisesAsSuperset,
  unpairSupersetExercises,
} from '../domain/supersetPair';
import type {
  CardioParams,
  DropSetTarget,
  ExerciseTarget,
  Plan,
  PlanDay,
  PlanExercise,
  Session,
  SessionExercise,
  SessionSet,
  StraightTarget,
} from '../domain/types';
import {
  getCoachReceipt,
  getCoachReceiptByOperationId,
  getCoachRestoreEpoch,
  saveCoachReceipt,
  type CoachOperationReceipt,
  type CoachPlanDraft,
  type CoachReceiptExerciseTargetTouched,
  type CoachReceiptSetTouched,
  type CoachReceiptTouchedTarget,
} from './coachStorage';
import { checkFocusConflict, type CoachEditableField } from './focusGuard';
import { getActiveSessionRuntime } from './sessionRuntimeBridge';

export type CoachTxConflictReason =
  | WriteFailureReason
  | 'focus-conflict'
  | 'dirty-state'
  | 'epoch-mismatch'
  | 'field-conflict'
  | 'not-found'
  | 'invalid-input';

export class TxConflictError extends Error {
  constructor(
    public readonly reason: CoachTxConflictReason,
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'TxConflictError';
  }
}

export interface CoachTxHooks {
  onSessionCommitted?: (session: Session) => void;
  onPlanCommitted?: (plan: Plan) => void;
  onPlanDeleted?: (planId: string) => void;
  onReceiptSaved?: (receipt: CoachOperationReceipt) => void;
}

export interface CoachCommitResult<T = Record<string, unknown>> {
  receipt: CoachOperationReceipt;
  session?: Session;
  plan?: Plan;
  meta?: T;
}

function makeReceiptId(): string {
  return `rcpt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function makeOpId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveSessionExercise(
  session: Session,
  selector: { exId?: string; exerciseName?: string },
): SessionExercise {
  if (selector.exId) {
    const exact = session.exercises.find((e) => e.id === selector.exId);
    if (!exact) {
      throw new TxConflictError('not-found', `当前训练中找不到动作（ID: ${selector.exId}）`);
    }
    return exact;
  }
  const needle = (selector.exerciseName ?? '').trim().toLowerCase();
  if (!needle) {
    throw new TxConflictError('invalid-input', '未指定要操作的训练动作');
  }
  const exact = session.exercises.filter((e) => e.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const fuzzy = session.exercises.filter((e) => e.name.trim().toLowerCase().includes(needle));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1 || exact.length > 1) {
    throw new TxConflictError('invalid-input', `找到多个匹配「${selector.exerciseName}」的动作，请指定具体卡片`);
  }
  throw new TxConflictError('not-found', `本次训练中没有找到动作「${selector.exerciseName}」`);
}

function resolveTargetSet(
  ex: SessionExercise,
  selector: { setId?: string; roundIndex?: number; stageIndex?: number },
): SessionSet {
  if (selector.setId) {
    const found = ex.sets.find((s) => s.id === selector.setId);
    if (!found) {
      throw new TxConflictError('not-found', `动作「${ex.name}」中找不到对应组记录`);
    }
    return found;
  }
  if (selector.roundIndex !== undefined) {
    const stageIdx = selector.stageIndex ?? 1;
    const found = ex.sets.find((s) => s.roundIndex === selector.roundIndex && s.stageIndex === stageIdx);
    if (!found) {
      throw new TxConflictError('not-found', `动作「${ex.name}」第 ${selector.roundIndex} 组不存在`);
    }
    return found;
  }
  const skipped = new Set(ex.groups.filter((g) => g.skipped).map((g) => g.index));
  const nextPending = ex.sets.find((s) => !skipped.has(s.roundIndex) && s.status !== 'done');
  return nextPending ?? ex.sets[ex.sets.length - 1];
}

function assertCleanSetValues(
  ex: SessionExercise,
  prevSet: SessionSet,
  nextReps: number | null,
  nextWeight: number | null,
  nextStatus: SessionSet['status'],
  explicitWeightClear: boolean,
): void {
  if (nextReps !== null) {
    if (!Number.isFinite(nextReps) || !Number.isInteger(nextReps) || nextReps <= 0 || nextReps > MAX_LOGGED_REPS) {
      throw new TxConflictError(
        'dirty-state',
        `次数必须是 1–${MAX_LOGGED_REPS} 的整数，已阻断无效输入进入训练记录`,
      );
    }
  }
  if (nextWeight !== null) {
    if (!Number.isFinite(nextWeight) || nextWeight < 0 || nextWeight > MAX_WEIGHT) {
      throw new TxConflictError(
        'dirty-state',
        `重量必须在 0–${MAX_WEIGHT} kg 之间，已阻断非法负重写入`,
      );
    }
  }
  const intendedDone = nextStatus === 'done' || (prevSet.status === 'done' && nextStatus !== 'blank');
  if (intendedDone && (nextReps === null || !Number.isFinite(nextReps) || nextReps <= 0)) {
    throw new TxConflictError(
      'dirty-state',
      '已完成组必须保留有效的完成次数，绝不允许写入「勾选完成但数值残缺」的状态',
    );
  }
  if (
    intendedDone &&
    ex.target.weightMode === 'external' &&
    explicitWeightClear &&
    prevSet.weightKg !== null
  ) {
    throw new TxConflictError(
      'dirty-state',
      '外加负重动作的已完成组不允许将重量直接清空为残缺值，请填写有效重量或先取消完成状态',
    );
  }
}

async function runActiveSessionMutation<T>(
  args: {
    operationId: string;
    toolName: CoachOperationReceipt['toolName'];
    sessionId: string;
    expectedRevision?: number;
    compute: (current: Session) => {
      nextSession: Session;
      summary: string;
      touchedTargets: CoachReceiptTouchedTarget[];
      timerTrigger?: { sec: number; source: { sessionExerciseId: string; setId: string } };
      meta?: T;
    };
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult<T>> {
  const existingReceipt = await getCoachReceiptByOperationId(args.operationId);
  if (existingReceipt) {
    const latestSession = await getSession(args.sessionId);
    return { receipt: existingReceipt, session: latestSession };
  }

  const runtime = getActiveSessionRuntime(args.sessionId);
  if (runtime) {
    await runtime.awaitPendingWrites();
  }

  const current = await getSession(args.sessionId);
  if (!current) {
    throw new TxConflictError('not-found', '找不到目标训练记录');
  }
  if (current.status !== 'active') {
    throw new TxConflictError('state-conflict', '训练已结束或已放弃，无法再以进行中训练写入');
  }
  const curRev = revisionOf(current);
  if (args.expectedRevision !== undefined && curRev !== args.expectedRevision) {
    throw new TxConflictError(
      'version-conflict',
      `训练记录已更新到版本 r${curRev}（请求基准 r${args.expectedRevision}），请基于最新数据重审`,
      curRev,
    );
  }

  const computed = args.compute(current);
  const res = await atomicWriteSession({
    intent: { kind: 'active-save' },
    session: computed.nextSession,
    editorId: runtime?.editorId,
    expectedRevision: curRev,
    lockPolicy: runtime ? 'required' : 'optional',
  });

  if (!res.ok) {
    throw new TxConflictError(
      res.reason,
      res.message,
      res.current ? revisionOf(res.current) : undefined,
    );
  }

  runtime?.applyCommittedSession(res.session);
  hooks?.onSessionCommitted?.(res.session);

  if (computed.timerTrigger) {
    runtime?.startRestTimer(computed.timerTrigger.sec, computed.timerTrigger.source);
  }

  const epoch = await getCoachRestoreEpoch();
  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId: args.operationId,
    toolName: args.toolName,
    createdAt: Date.now(),
    scope: 'session',
    summary: computed.summary,
    entityType: 'session',
    entityId: res.session.id,
    beforeRevision: curRev,
    afterRevision: res.revision,
    restoreEpoch: epoch,
    undone: false,
    timerStarted: Boolean(computed.timerTrigger),
    touchedTargets: computed.touchedTargets,
  };
  await saveCoachReceipt(receipt);
  hooks?.onReceiptSaved?.(receipt);

  return { receipt, session: res.session, meta: computed.meta };
}

/* ── 工具 1：调整本次训练目标（严格只改目标，绝不标 done、不误触计时器） ── */

export interface AdjustActiveTargetInput {
  operationId?: string;
  sessionId: string;
  exId?: string;
  exerciseName?: string;
  expectedRevision?: number;
  sets?: number;
  setsMax?: number;
  repsMin?: number;
  repsMax?: number;
  suggestedWeightKg?: number | null;
  restSec?: number;
  stageTargets?: Array<{ stageIndex: number; repsMin?: number | null; repsMax?: number | null; weightKg?: number | null }>;
}

export async function coachAdjustActiveTarget(
  input: AdjustActiveTargetInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('adj-target');
  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'adjust_active_target',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      compute: (current) => {
        const ex = resolveSessionExercise(current, input);
        const focus = checkFocusConflict({
          sessionId: current.id,
          exId: ex.id,
          fields: ['target'],
        });
        if (focus.conflict) {
          throw new TxConflictError('focus-conflict', focus.message ?? '目标字段正在编辑中');
        }

        let nextTarget: ExerciseTarget = structuredClone(ex.target);
        if (nextTarget.kind === 'straight') {
          const st: StraightTarget = { ...nextTarget };
          if (input.sets !== undefined) {
            if (!Number.isInteger(input.sets) || input.sets < 1 || input.sets > MAX_STRAIGHT_SETS) {
              throw new TxConflictError('invalid-input', `目标组数需在 1–${MAX_STRAIGHT_SETS} 之间`);
            }
            st.sets = input.sets;
            st.setsMax = Math.max(input.setsMax ?? input.sets, input.sets);
          } else if (input.setsMax !== undefined) {
            st.setsMax = Math.max(st.sets, input.setsMax);
          }
          if (input.repsMin !== undefined) {
            if (!Number.isInteger(input.repsMin) || input.repsMin < 1 || input.repsMin > 100) {
              throw new TxConflictError('invalid-input', '目标次数下限需在 1–100 之间');
            }
            st.repsMin = input.repsMin;
            st.repsMax = Math.max(input.repsMax ?? Math.max(st.repsMax, input.repsMin), input.repsMin);
          }
          if (input.repsMax !== undefined) {
            if (!Number.isInteger(input.repsMax) || input.repsMax < st.repsMin || input.repsMax > 100) {
              throw new TxConflictError('invalid-input', '目标次数上限不能低于下限且需 <= 100');
            }
            st.repsMax = input.repsMax;
          }
          if (input.suggestedWeightKg !== undefined) {
            if (
              input.suggestedWeightKg !== null &&
              (!Number.isFinite(input.suggestedWeightKg) || input.suggestedWeightKg < 0 || input.suggestedWeightKg > MAX_WEIGHT)
            ) {
              throw new TxConflictError('invalid-input', `参考重量需在 0–${MAX_WEIGHT} kg 之间`);
            }
            st.suggestedWeightKg = input.suggestedWeightKg;
          }
          nextTarget = st;
        } else {
          const dt: DropSetTarget = { ...nextTarget };
          if (input.sets !== undefined) {
            if (!Number.isInteger(input.sets) || input.sets < 1 || input.sets > MAX_ROUNDS) {
              throw new TxConflictError('invalid-input', `目标轮数需在 1–${MAX_ROUNDS} 之间`);
            }
            dt.rounds = input.sets;
          }
          if (input.stageTargets?.length) {
            dt.stages = dt.stages.map((stage, i) => {
              const patch = input.stageTargets?.find((p) => p.stageIndex === i + 1);
              if (!patch) return stage;
              return {
                ...stage,
                ...(patch.repsMin !== undefined ? { repsMin: patch.repsMin } : {}),
                ...(patch.repsMax !== undefined ? { repsMax: patch.repsMax } : {}),
                ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
              };
            });
          } else if (input.repsMin !== undefined || input.repsMax !== undefined || input.suggestedWeightKg !== undefined) {
            dt.stages = dt.stages.map((stage) => ({
              ...stage,
              ...(input.repsMin !== undefined ? { repsMin: input.repsMin } : {}),
              ...(input.repsMax !== undefined ? { repsMax: input.repsMax } : {}),
              ...(input.suggestedWeightKg !== undefined ? { weightKg: input.suggestedWeightKg } : {}),
            }));
          }
          nextTarget = dt;
        }

        const applied = applyTargetToSessionExercise(current, ex.id, nextTarget, { confirmImpact: false });
        if (!applied.applied) {
          throw new TxConflictError(
            'dirty-state',
            applied.message || '目标调整会影响已记录组，已拒绝对实绩的静默修改',
          );
        }

        let nextSession = applied.session;
        if (input.restSec !== undefined) {
          if (!Number.isFinite(input.restSec) || input.restSec < 0 || input.restSec > MAX_REST) {
            throw new TxConflictError('invalid-input', `组间休息需在 0–${MAX_REST} 秒之间`);
          }
          nextSession = withExercise(nextSession, ex.id, { restSec: Math.round(input.restSec) });
        }

        const nextEx = nextSession.exercises.find((e) => e.id === ex.id)!;
        const parts: string[] = [];
        if (nextEx.target.kind === 'straight') {
          parts.push(`${nextEx.target.sets} 组 × ${nextEx.target.repsMin}-${nextEx.target.repsMax} 次`);
          if (nextEx.target.suggestedWeightKg !== null) parts.push(`${nextEx.target.suggestedWeightKg}kg`);
        } else {
          parts.push(`${nextEx.target.rounds} 轮多阶段目标已更新`);
        }
        const summary = `调整「${ex.name}」训练目标为 ${parts.join(' · ')}（未计入已完成组，未触及休息计时）`;

        const touched: CoachReceiptExerciseTargetTouched = {
          kind: 'exercise-target',
          sessionId: current.id,
          exId: ex.id,
          beforeTarget: structuredClone(ex.target),
          afterTarget: structuredClone(nextEx.target),
          beforeSets: structuredClone(ex.sets),
          afterSets: structuredClone(nextEx.sets),
        };

        return {
          nextSession,
          summary,
          touchedTargets: [touched],
          timerTrigger: undefined,
        };
      },
    },
    hooks,
  );
}

/* ── 工具 2：记录/纠正进行中逐组实绩（原子 + 防脏值 + 诚实计时器） ── */

export interface RecordActiveSetInput {
  operationId?: string;
  sessionId: string;
  exId?: string;
  exerciseName?: string;
  setId?: string;
  roundIndex?: number;
  stageIndex?: number;
  expectedRevision?: number;
  reps?: number | null;
  weightKg?: number | null;
  status?: 'done' | 'blank' | 'partial';
  toFailure?: boolean;
}

export async function coachRecordActiveSet(
  input: RecordActiveSetInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('rec-set');
  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'record_active_set',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      compute: (current) => {
        const ex = resolveSessionExercise(current, input);
        const prevSet = resolveTargetSet(ex, input);

        const nextReps = input.reps !== undefined ? input.reps : prevSet.reps;
        const nextWeight = input.weightKg !== undefined ? input.weightKg : prevSet.weightKg;
        const nextStatus: SessionSet['status'] = input.status ?? 'done';
        const explicitWeightClear = input.weightKg === null;

        assertCleanSetValues(ex, prevSet, nextReps, nextWeight, nextStatus, explicitWeightClear);

        const fieldsToGuard: CoachEditableField[] = [];
        if (input.reps !== undefined) fieldsToGuard.push('reps');
        if (input.weightKg !== undefined) fieldsToGuard.push('weight');
        if (!fieldsToGuard.length) fieldsToGuard.push('reps', 'weight');

        const focus = checkFocusConflict({
          sessionId: current.id,
          exId: ex.id,
          setId: prevSet.id,
          fields: fieldsToGuard,
          includeDirtyInSet: nextStatus === 'done',
        });
        if (focus.conflict) {
          throw new TxConflictError('focus-conflict', focus.message ?? '目标组输入框正在编辑中');
        }

        const hasLocalWeightDraft = (otherSetId: string): boolean =>
          checkFocusConflict({
            sessionId: current.id,
            exId: ex.id,
            setId: otherSetId,
            fields: ['weight'],
          }).conflict;

        const patch: Partial<SessionSet> = {
          ...(input.reps !== undefined ? { reps: input.reps } : {}),
          ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
          ...(input.toFailure !== undefined ? { toFailure: input.toFailure } : {}),
          status: nextStatus,
        };

        const nextSession = withSetAndPrefillFollowingWeight(
          current,
          ex.id,
          prevSet.id,
          patch,
          hasLocalWeightDraft,
        );
        const nextEx = nextSession.exercises.find((e) => e.id === ex.id)!;
        const afterSet = nextEx.sets.find((s) => s.id === prevSet.id)!;

        // 防止 domain 归一化静默降级成 partial
        if (nextStatus === 'done' && afterSet.status !== 'done') {
          throw new TxConflictError('dirty-state', '已完成组必须包含有效次数，已阻断半空状态');
        }

        const prefilledSets: CoachReceiptSetTouched['prefilledSets'] = [];
        for (const afterS of nextEx.sets) {
          if (afterS.id === prevSet.id) continue;
          const beforeS = ex.sets.find((s) => s.id === afterS.id);
          if (beforeS && beforeS.weightKg !== afterS.weightKg) {
            prefilledSets.push({
              setId: afterS.id,
              beforeWeightKg: beforeS.weightKg,
              afterWeightKg: afterS.weightKg,
            });
          }
        }

        const triggeredRest = prevSet.status !== 'done' && afterSet.status === 'done';
        const restSec = restAfterSet(nextEx, afterSet);

        const weightLabel =
          afterSet.weightKg !== null ? `${afterSet.weightKg}kg` : ex.target.weightMode === 'bodyweight' ? '自重' : '未填重量';
        const summary = `记录「${ex.name}」第 ${afterSet.roundIndex} 组${ex.sets.some((s) => s.stageIndex > 1) ? `·阶段${afterSet.stageIndex}` : ''}：${afterSet.reps ?? '—'} 次 × ${weightLabel}`;

        const touched: CoachReceiptSetTouched = {
          kind: 'session-set',
          sessionId: current.id,
          exId: ex.id,
          setId: prevSet.id,
          beforeSet: structuredClone(prevSet),
          afterSet: structuredClone(afterSet),
          ...(prefilledSets.length ? { prefilledSets } : {}),
        };

        return {
          nextSession,
          summary,
          touchedTargets: [touched],
          ...(triggeredRest && restSec > 0
            ? { timerTrigger: { sec: restSec, source: { sessionExerciseId: ex.id, setId: afterSet.id } } }
            : {}),
        };
      },
    },
    hooks,
  );
}

/* ── 工具 3：超级组配对 / 拆散 / 多阶段安全转换 ── */

export type ConfigureSupersetInput =
  | {
      operationId?: string;
      sessionId: string;
      mode: 'pair';
      exIds: string[];
      pairId?: string;
      expectedRevision?: number;
    }
  | {
      operationId?: string;
      sessionId: string;
      mode: 'unpair';
      exIds: string[];
      expectedRevision?: number;
    }
  | {
      operationId?: string;
      sessionId: string;
      mode: 'convert_multistage';
      exId: string;
      partnerName: string;
      rounds?: number;
      expectedRevision?: number;
    };

export async function coachConfigureSuperset(
  input: ConfigureSupersetInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult<{ pairId?: string; supersetExerciseId?: string }>> {
  const operationId = input.operationId ?? makeOpId('superset');
  return runActiveSessionMutation<{ pairId?: string; supersetExerciseId?: string }>(
    {
      operationId,
      toolName: 'configure_superset',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      compute: (current) => {
        const beforeSnapshot = structuredClone(current);
        if (input.mode === 'pair') {
          for (const id of input.exIds) {
            const f = checkFocusConflict({ sessionId: current.id, exId: id });
            if (f.conflict) throw new TxConflictError('focus-conflict', f.message ?? '动作正在输入中');
          }
          const res = pairExercisesAsSuperset(current.exercises, input.exIds, input.pairId);
          if (!res.ok) {
            throw new TxConflictError('invalid-input', res.message);
          }
          const nextSession: Session = { ...current, exercises: res.exercises };
          const names = input.exIds
            .map((id) => current.exercises.find((e) => e.id === id)?.name)
            .filter(Boolean)
            .join(' + ');
          return {
            nextSession,
            summary: `将「${names}」配对为超级组（pairId: ${res.pairId.slice(0, 8)}）`,
            touchedTargets: [
              {
                kind: 'exercise-superset',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
            meta: { pairId: res.pairId },
          };
        }

        if (input.mode === 'unpair') {
          for (const id of input.exIds) {
            const f = checkFocusConflict({ sessionId: current.id, exId: id });
            if (f.conflict) throw new TxConflictError('focus-conflict', f.message ?? '动作正在输入中');
          }
          const nextExercises = unpairSupersetExercises(current.exercises, { exerciseIds: input.exIds });
          const nextSession: Session = { ...current, exercises: nextExercises };
          return {
            nextSession,
            summary: `解除指定动作超级组配对，并自动清理孤立 pairId`,
            touchedTargets: [
              {
                kind: 'exercise-superset',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        const f = checkFocusConflict({ sessionId: current.id, exId: input.exId });
        if (f.conflict) throw new TxConflictError('focus-conflict', f.message ?? '动作正在输入中');
        const srcEx = current.exercises.find((e) => e.id === input.exId);
        const conv = convertExerciseToMultiStageSuperset(
          current,
          input.exId,
          [
            { name: srcEx?.name ?? '阶段 1', exerciseId: srcEx?.exerciseId },
            { name: input.partnerName },
          ],
          { rounds: input.rounds },
        );
        if (!conv.ok) {
          throw new TxConflictError('invalid-input', conv.message);
        }
        return {
          nextSession: conv.session,
          summary:
            conv.preservedCompletedSets > 0
              ? `保留原单动作已完成的 ${conv.preservedCompletedSets} 组实绩，并为后续轮次新建超级组复合卡`
              : `将动作转为超级组复合卡（独立组合身份，不污染单动作 PR）`,
          touchedTargets: [
            {
              kind: 'exercise-superset',
              sessionId: current.id,
              beforeSession: beforeSnapshot,
              afterSession: structuredClone(conv.session),
            },
          ],
          meta: { supersetExerciseId: conv.supersetExerciseId },
        };
      },
    },
    hooks,
  );
}

/* ── 工具 4：已完成历史训练纠错 ── */

export type CorrectHistoryInput =
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'update_session_note';
      note: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'update_exercise_note';
      exId: string;
      note: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'append_group';
      exId: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'remove_blank_group';
      exId: string;
      roundIndex: number;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'correct_set';
      exId?: string;
      exerciseName?: string;
      setId?: string;
      roundIndex?: number;
      stageIndex?: number;
      reps?: number | null;
      weightKg?: number | null;
      status?: 'done' | 'blank' | 'partial';
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      action: 'correct_cardio';
      cardioId: string;
      elapsedMs: number;
      params?: CardioParams;
    };

export async function coachCorrectHistory(
  input: CorrectHistoryInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('hist-edit');
  const existingReceipt = await getCoachReceiptByOperationId(operationId);
  if (existingReceipt) {
    return { receipt: existingReceipt, session: await getSession(input.sessionId) };
  }

  const current = await getSession(input.sessionId);
  if (!current) {
    throw new TxConflictError('not-found', '找不到要纠错的历史训练记录');
  }
  if (current.status !== 'completed') {
    throw new TxConflictError('state-conflict', '仅已完成的历史训练支持历史纠错');
  }
  const curRev = revisionOf(current);
  if (input.expectedRevision !== undefined && curRev !== input.expectedRevision) {
    throw new TxConflictError('version-conflict', `历史记录版本已变更为 r${curRev}`, curRev);
  }

  let nextSession = current;
  let summary = '';

  if (input.action === 'update_session_note') {
    const r = updateHistorySessionNote(current, input.note);
    if (!r.ok) throw new TxConflictError('invalid-input', r.message);
    nextSession = r.session;
    summary = '更新历史训练总备注';
  } else if (input.action === 'update_exercise_note') {
    const r = updateHistoryExerciseNote(current, input.exId, input.note);
    if (!r.ok) throw new TxConflictError('invalid-input', r.message);
    nextSession = r.session;
    summary = '更新历史动作备注';
  } else if (input.action === 'append_group') {
    const r = appendBlankGroupToHistoryExercise(current, input.exId);
    if (!r.ok) throw new TxConflictError('invalid-input', r.message);
    nextSession = r.session;
    summary = '为历史动作补录 1 个空白组';
  } else if (input.action === 'remove_blank_group') {
    const r = removeBlankGroupFromHistoryExercise(current, input.exId, input.roundIndex);
    if (!r.ok) throw new TxConflictError('invalid-input', r.message);
    nextSession = r.session;
    summary = `移除历史动作第 ${input.roundIndex} 个空白组`;
  } else if (input.action === 'correct_cardio') {
    const r = correctHistoryCardioEntry(current, input.cardioId, {
      durationSec: Math.round(input.elapsedMs / 1000),
      params: input.params,
    });
    if (!r.ok) throw new TxConflictError('invalid-input', r.message);
    nextSession = r.session;
    summary = '修正历史有氧项目时长/参数';
  } else {
    const ex = resolveSessionExercise(current, input);
    const prevSet = resolveTargetSet(ex, input);
    const nextReps = input.reps !== undefined ? input.reps : prevSet.reps;
    const nextWeight = input.weightKg !== undefined ? input.weightKg : prevSet.weightKg;
    const nextStatus = input.status ?? (prevSet.status === 'blank' ? 'done' : prevSet.status);
    assertCleanSetValues(ex, prevSet, nextReps, nextWeight, nextStatus, input.weightKg === null);

    nextSession = withSetAndPrefillFollowingWeight(current, ex.id, prevSet.id, {
      ...(input.reps !== undefined ? { reps: input.reps } : {}),
      ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
      status: nextStatus,
    });
    const afterSet = nextSession.exercises.find((e) => e.id === ex.id)?.sets.find((s) => s.id === prevSet.id);
    if (nextStatus === 'done' && afterSet?.status !== 'done') {
      throw new TxConflictError('dirty-state', '历史已完成组必须保留有效次数');
    }
    summary = `纠正历史「${ex.name}」第 ${prevSet.roundIndex} 组为 ${afterSet?.reps ?? '—'} 次 × ${afterSet?.weightKg ?? '自重'}${afterSet?.weightKg !== null ? 'kg' : ''}`;
  }

  const res = await atomicSaveHistoryEdit({ session: nextSession, expectedRevision: curRev });
  if (!res.ok) {
    throw new TxConflictError(res.reason, res.message, res.current ? revisionOf(res.current) : undefined);
  }
  hooks?.onSessionCommitted?.(res.session);

  const epoch = await getCoachRestoreEpoch();
  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId,
    toolName: 'correct_history_session',
    createdAt: Date.now(),
    scope: 'history',
    summary,
    entityType: 'session',
    entityId: res.session.id,
    beforeRevision: curRev,
    afterRevision: res.revision,
    restoreEpoch: epoch,
    undone: false,
    touchedTargets: [
      {
        kind: 'history-edit',
        sessionId: current.id,
        beforeSession: structuredClone(current),
        afterSession: structuredClone(res.session),
      },
    ],
  };
  await saveCoachReceipt(receipt);
  hooks?.onReceiptSaved?.(receipt);
  return { receipt, session: res.session };
}

/* ── 工具 5：识图 / 结构化草稿新建计划 ── */

function buildPlanFromDraft(draft: CoachPlanDraft): Plan {
  const now = Date.now();
  const days: PlanDay[] = draft.days.map((d) => {
    const pairMap = new Map<string, string>();
    const rawExercises: PlanExercise[] = d.exercises.map((item) => {
      let pairId: string | undefined;
      if (item.pairGroup && item.pairGroup.trim()) {
        const key = item.pairGroup.trim();
        pairId = pairMap.get(key) ?? generateUuidV4();
        pairMap.set(key, pairId);
      }
      const target: ExerciseTarget =
        item.kind === 'dropSet' && item.stages?.length
          ? {
              kind: 'dropSet',
              form: item.form === 'superset' ? 'superset' : 'dropSet',
              rounds: Math.max(1, item.sets),
              stages: item.stages.map((s) => ({
                id: newId('st'),
                label: s.label || '阶段',
                weightKg: s.weightKg,
                repsMin: s.repsMin,
                repsMax: s.repsMax,
                toFailure: false,
                targetText: `${s.repsMin}-${s.repsMax}次${s.weightKg !== null ? ` · ${s.weightKg}kg` : ''}`,
              })),
              restInSec: 30,
              restAfterSec: 120,
              weightMode: item.weightMode,
              ...(item.dumbbellBasis ? { dumbbellBasis: item.dumbbellBasis } : {}),
            }
          : {
              kind: 'straight',
              sets: Math.max(1, item.sets),
              setsMax: Math.max(1, item.sets),
              repsMin: Math.max(1, item.repsMin),
              repsMax: Math.max(item.repsMin, item.repsMax),
              weightMode: item.weightMode,
              ...(item.dumbbellBasis ? { dumbbellBasis: item.dumbbellBasis } : {}),
              suggestedWeightKg: item.weightMode === 'bodyweight' ? null : item.suggestedWeightKg,
            };
      return {
        id: newId('ex'),
        exerciseId: exerciseIdFromName(item.name),
        name: item.name.trim() || '未命名动作',
        restSec: 120,
        target,
        ...(pairId ? { pairId } : {}),
      };
    });

    return {
      id: newId('day'),
      name: d.dayName.trim() || '训练日',
      kind: 'train',
      warmups: [],
      exercises: cleanOrphanPairIds(rawExercises),
    };
  });

  return {
    id: 'coach-plan-' + draft.id,
    name: draft.planName.trim() || '教练新建计划',
    cursor: 0,
    days,
    createdAt: now,
    updatedAt: now,
  };
}

export async function coachCreatePlanFromDraft(
  args: {
    operationId?: string;
    draft: CoachPlanDraft;
    allowDuplicateName?: boolean;
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? 'coach-plan:' + args.draft.id;
  const existing = await getCoachReceiptByOperationId(operationId);
  if (existing) {
    return { receipt: existing, plan: existing.planId ? await getPlan(existing.planId) : undefined };
  }

  if (!args.draft.days.length || args.draft.days.every((d) => d.exercises.length === 0)) {
    throw new TxConflictError('invalid-input', '计划草稿至少需要 1 个动作才能创建');
  }

  const invalid = args.draft.days.some((day) => day.exercises.some((ex) =>
    !ex.name.trim() || !Number.isInteger(ex.sets) || ex.sets < 1 ||
    (ex.kind === 'straight' && (ex.repsMin < 1 || ex.repsMax < ex.repsMin)) ||
    (ex.kind === 'dropSet' && ex.stages?.some((stage) =>
      !stage.label.trim() || stage.repsMin < 1 || stage.repsMax < stage.repsMin))));
  if (invalid || !args.draft.planName.trim()) {
    throw new TxConflictError('invalid-input', '请补齐计划名称、动作和有效组次');
  }
  const candidate = buildPlanFromDraft(args.draft);
  const check = validateDataDeep({ plans: [candidate], sessions: [] });
  if (!check.ok) {
    throw new TxConflictError('invalid-input', `计划结构不合法：${check.issues[0]?.message ?? '请检查输入'}`);
  }

  const priorPlan = await getPlan(candidate.id);
  let res = priorPlan
    ? { ok: true as const, plan: priorPlan }
    : await atomicInsertPlan(candidate, { allowDuplicateName: args.allowDuplicateName });
  if (!res.ok && res.reason === 'duplicate-id') {
    const committed = await getPlan(candidate.id);
    if (committed) res = { ok: true, plan: committed };
  }
  if (!res.ok) {
    const mappedReason: CoachTxConflictReason =
      res.reason === 'capacity'
        ? 'dirty-state'
        : res.reason === 'duplicate-name' || res.reason === 'duplicate-id'
          ? 'state-conflict'
          : 'storage';
    if (res.reason === 'capacity') {
      throw new TxConflictError(mappedReason, `计划数量已达 ${MAX_PLANS} 上限：${res.message}`);
    }
    throw new TxConflictError(mappedReason, res.message);
  }

  hooks?.onPlanCommitted?.(res.plan);

  const epoch = await getCoachRestoreEpoch();
  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId,
    toolName: 'create_plan_from_draft',
    createdAt: Date.now(),
    scope: 'plan',
    summary: `新建训练计划「${res.plan.name}」（${res.plan.days.length} 个训练日）`,
    entityType: 'plan',
    entityId: res.plan.id,
    planId: res.plan.id,
    beforeRevision: 0,
    afterRevision: 1,
    beforePlanRevision: 0,
    afterPlanRevision: res.plan.updatedAt,
    restoreEpoch: epoch,
    undone: false,
    touchedTargets: [{ kind: 'plan-created', planId: res.plan.id }],
  };
  await saveCoachReceipt(receipt);
  hooks?.onReceiptSaved?.(receipt);
  return { receipt, plan: res.plan };
}

/* ── 工具 6：已有计划定向修改（原子读-核验-写 plans store） ── */

export async function atomicUpdatePlanInTx(
  planId: string,
  expectedUpdatedAt: number | undefined,
  mutate: (current: Plan) => Plan,
): Promise<{ beforePlan: Plan; afterPlan: Plan }> {
  const db = await openDb();
  return new Promise<{ beforePlan: Plan; afterPlan: Plan }>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(['plans'], 'readwrite');
    } catch (err) {
      fail(new TxConflictError('storage', err instanceof Error ? err.message : '开启计划事务失败'));
      return;
    }
    const store = tx.objectStore('plans');
    let result: { beforePlan: Plan; afterPlan: Plan } | null = null;
    tx.oncomplete = () => {
      if (result && !settled) {
        settled = true;
        resolve(result);
      } else {
        fail(new TxConflictError('storage', '事务完成但计划未保存'));
      }
    };
    tx.onabort = () => {
      fail(new TxConflictError('storage', tx.error?.message ?? '计划修改事务被中止'));
    };
    tx.onerror = () => {
      fail(new TxConflictError('storage', tx.error?.message ?? '计划修改失败'));
    };

    const getReq = store.get(planId);
    getReq.onerror = () => fail(new TxConflictError('storage', getReq.error?.message ?? '读取计划失败'));
    getReq.onsuccess = () => {
      const current = getReq.result as Plan | undefined;
      if (!current) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        fail(new TxConflictError('not-found', '找不到要修改的计划'));
        return;
      }
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        fail(
          new TxConflictError(
            'version-conflict',
            '目标计划已在别处被修改，已拒绝对计划的过期覆盖',
            current.updatedAt,
          ),
        );
        return;
      }
      let nextRaw: Plan;
      try {
        nextRaw = mutate(structuredClone(current));
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        fail(err instanceof Error ? err : new TxConflictError('invalid-input', String(err)));
        return;
      }
      const nextPlan: Plan = {
        ...nextRaw,
        days: nextRaw.days.map((d) => ({ ...d, exercises: cleanOrphanPairIds(d.exercises) })),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };
      const valid = validateDataDeep({ plans: [nextPlan], sessions: [] });
      if (!valid.ok) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        fail(new TxConflictError('invalid-input', `计划校验失败：${valid.issues[0]?.message ?? ''}`));
        return;
      }
      const validatedPlan = valid.value.plans[0];
      try {
        store.put(validatedPlan);
        result = { beforePlan: structuredClone(current), afterPlan: validatedPlan };
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        fail(new TxConflictError('storage', err instanceof Error ? err.message : '计划写回失败'));
      }
    };
  });
}

export type ModifyPlanAction =
  | { kind: 'rename_plan'; name: string }
  | { kind: 'rename_day'; dayId: string; name: string }
  | { kind: 'add_exercise'; dayId: string; name: string; target?: ExerciseTarget }
  | { kind: 'remove_exercise'; dayId: string; exId: string }
  | { kind: 'update_target'; dayId: string; exId: string; patch: Partial<ExerciseTarget>; restSec?: number }
  | { kind: 'pair_superset'; dayId: string; exIds: string[] }
  | { kind: 'unpair_superset'; dayId: string; exIds: string[] };

export async function coachModifyExistingPlan(
  args: {
    operationId?: string;
    planId: string;
    expectedUpdatedAt?: number;
    action: ModifyPlanAction;
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? makeOpId('mod-plan');
  const existing = await getCoachReceiptByOperationId(operationId);
  if (existing) {
    return { receipt: existing, plan: await getPlan(args.planId) };
  }

  let summary = '';
  const { beforePlan, afterPlan } = await atomicUpdatePlanInTx(
    args.planId,
    args.expectedUpdatedAt,
    (current) => {
      const act = args.action;
      if (act.kind === 'rename_plan') {
        summary = `重命名计划为「${act.name.trim()}」`;
        return renamePlan(current, act.name);
      }
      if (act.kind === 'rename_day') {
        summary = `重命名训练日为「${act.name.trim()}」`;
        return renameDay(current, act.dayId, act.name);
      }
      if (act.kind === 'add_exercise') {
        const res = addExercise(current, act.dayId, act.name, act.target);
        if (!res.added) {
          throw new TxConflictError(
            res.reason === 'capacity' ? 'dirty-state' : 'not-found',
            res.reason === 'capacity' ? '该训练日动作数量已达上限' : '找不到目标训练日',
          );
        }
        summary = `在计划中新增动作「${act.name}」`;
        return res.plan;
      }
      if (act.kind === 'remove_exercise') {
        const targetDay = current.days.find((d) => d.id === act.dayId);
        const targetEx = targetDay?.exercises.find((e) => e.id === act.exId);
        if (!targetDay || !targetEx) {
          throw new TxConflictError('not-found', '找不到要移除的计划动作');
        }
        summary = `从计划移除动作「${targetEx.name}」并自动清理孤立配对`;
        return removeExercise(current, act.dayId, act.exId);
      }
      if (act.kind === 'update_target') {
        const targetDay = current.days.find((d) => d.id === act.dayId);
        const targetEx = targetDay?.exercises.find((e) => e.id === act.exId);
        if (!targetDay || !targetEx) {
          throw new TxConflictError('not-found', '找不到要调整目标的计划动作');
        }
        let updated = updateTarget(current, act.dayId, act.exId, act.patch);
        if (act.restSec !== undefined) {
          updated = updateExercise(updated, act.dayId, act.exId, { restSec: act.restSec });
        }
        summary = `修改计划动作「${targetEx.name}」目标参数`;
        return updated;
      }
      if (act.kind === 'pair_superset') {
        const day = current.days.find((d) => d.id === act.dayId);
        if (!day) throw new TxConflictError('not-found', '找不到目标训练日');
        const paired = pairExercisesAsSuperset(day.exercises, act.exIds);
        if (!paired.ok) throw new TxConflictError('invalid-input', paired.message);
        summary = `将计划训练日「${day.name}」内动作配对为超级组`;
        return {
          ...current,
          days: current.days.map((d) => (d.id === act.dayId ? { ...d, exercises: paired.exercises } : d)),
        };
      }
      const day = current.days.find((d) => d.id === act.dayId);
      if (!day) throw new TxConflictError('not-found', '找不到目标训练日');
      summary = `解除计划训练日「${day.name}」内指定超级组配对`;
      return {
        ...current,
        days: current.days.map((d) =>
          d.id === act.dayId
            ? { ...d, exercises: unpairSupersetExercises(d.exercises, { exerciseIds: act.exIds }) }
            : d,
        ),
      };
    },
  );

  hooks?.onPlanCommitted?.(afterPlan);
  const epoch = await getCoachRestoreEpoch();
  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId,
    toolName: 'modify_existing_plan',
    createdAt: Date.now(),
    scope: 'plan',
    summary,
    entityType: 'plan',
    entityId: afterPlan.id,
    planId: afterPlan.id,
    beforeRevision: 1,
    afterRevision: 1,
    beforePlanRevision: beforePlan.updatedAt,
    afterPlanRevision: afterPlan.updatedAt,
    restoreEpoch: epoch,
    undone: false,
    touchedTargets: [
      {
        kind: 'plan-day',
        planId: afterPlan.id,
        beforePlan,
        afterPlan: structuredClone(afterPlan),
      },
    ],
  };
  await saveCoachReceipt(receipt);
  hooks?.onReceiptSaved?.(receipt);
  return { receipt, plan: afterPlan };
}

/* ── 工具 7：完训 / 编排同步回原计划（显式区分仅改本次会话 vs 同步原计划） ── */

export async function coachSyncSessionToPlan(
  args: {
    operationId?: string;
    sessionId: string;
    scope: 'session-only' | 'sync-to-plan';
    expectedPlanUpdatedAt?: number;
    expectedSessionRevision?: number;
    alsoFinishSession?: boolean;
    advanceCycle?: boolean;
  },
  hooks?: CoachTxHooks,
): Promise<{
  scope: 'session-only' | 'sync-to-plan';
  synced: boolean;
  message: string;
  receipt?: CoachOperationReceipt;
  plan?: Plan;
  session?: Session;
}> {
  const operationId = args.operationId ?? makeOpId('sync-plan');
  const currentSession = await getSession(args.sessionId);
  if (!currentSession) {
    throw new TxConflictError('not-found', '找不到目标训练记录');
  }
  const sessionRev = revisionOf(currentSession);
  if (args.expectedSessionRevision !== undefined && sessionRev !== args.expectedSessionRevision) {
    throw new TxConflictError('version-conflict', `训练版本已变更为 r${sessionRev}`, sessionRev);
  }

  if (args.scope === 'session-only') {
    return {
      scope: 'session-only',
      synced: false,
      message: '已确认仅保留本次训练内的临时编排，原训练计划模板未作任何修改。',
      session: currentSession,
    };
  }

  const existingReceipt = await getCoachReceiptByOperationId(operationId);
  if (existingReceipt) {
    return {
      scope: 'sync-to-plan',
      synced: true,
      message: existingReceipt.summary,
      receipt: existingReceipt,
      plan: existingReceipt.planId ? await getPlan(existingReceipt.planId) : undefined,
      session: await getSession(args.sessionId),
    };
  }

  // 若用户顺便请求以“带同步计划”方式完训，直接走 tx.ts 原子完训通道
  if (args.alsoFinishSession && currentSession.status === 'active') {
    const runtime = getActiveSessionRuntime(currentSession.id);
    if (runtime) await runtime.awaitPendingWrites();
    const freshPlanBefore = await getPlan(currentSession.planId);
    const ended: Session = {
      ...currentSession,
      revision: sessionRev,
      status: 'completed',
      endedAt: Date.now(),
      advancedCycle: args.advanceCycle ?? true,
    };
    const finRes = await atomicFinishSession({
      session: ended,
      guard: {
        editorId: runtime?.editorId,
        expectedVersion: sessionRev,
        advanceCycle: args.advanceCycle ?? true,
        syncBackToPlanDay: true,
        lockPolicy: runtime ? 'required' : 'optional',
      },
    });
    if (!finRes.ok) {
      throw new TxConflictError(finRes.reason, finRes.message);
    }
    hooks?.onSessionCommitted?.(finRes.session);
    if (finRes.plan) hooks?.onPlanCommitted?.(finRes.plan);
    const epoch = await getCoachRestoreEpoch();
    const targets: CoachReceiptTouchedTarget[] = [];
    if (freshPlanBefore && finRes.plan) {
      targets.push({
        kind: 'plan-day',
        planId: finRes.plan.id,
        beforePlan: structuredClone(freshPlanBefore),
        afterPlan: structuredClone(finRes.plan),
      });
    }
    const receipt: CoachOperationReceipt = {
      id: makeReceiptId(),
      operationId,
      toolName: 'sync_session_to_plan',
      createdAt: Date.now(),
      scope: 'session+plan',
      summary: `已结束训练，并将本次编排同步更新回计划「${finRes.plan?.name ?? currentSession.planName}」`,
      entityType: 'session+plan',
      entityId: finRes.session.id,
      planId: finRes.plan?.id,
      beforeRevision: sessionRev,
      afterRevision: finRes.revision,
      beforePlanRevision: freshPlanBefore?.updatedAt,
      afterPlanRevision: finRes.plan?.updatedAt,
      restoreEpoch: epoch,
      undone: false,
      touchedTargets: targets,
    };
    await saveCoachReceipt(receipt);
    hooks?.onReceiptSaved?.(receipt);
    return {
      scope: 'sync-to-plan',
      synced: true,
      message: receipt.summary,
      receipt,
      plan: finRes.plan,
      session: finRes.session,
    };
  }

  // 直接将当前训练（active 或 completed）的编排差量写回原计划模板（保留长期计划中另行新增的无关动作）
  let diffMessage = '';
  const { beforePlan, afterPlan } = await atomicUpdatePlanInTx(
    currentSession.planId,
    args.expectedPlanUpdatedAt,
    (curPlan) => {
      const diff = diffSessionVsPlanDay(currentSession, curPlan);
      if (!diff.canSync) {
        if (diff.planUpdatedDuringSession) {
          throw new TxConflictError(
            'version-conflict',
            diff.blockerMessage ?? '原计划在训练开始后也被独立修改，请先核对后再手动调整计划',
            curPlan.updatedAt,
          );
        }
        throw new TxConflictError(
          'state-conflict',
          diff.blockerMessage ?? '当前训练不符合同步回原计划的条件',
        );
      }
      if (!diff.hasDiff) {
        throw new TxConflictError('state-conflict', '本次训练动作编排与原计划训练日一致，无需重复同步');
      }
      const syncResult = applySessionArrangementToPlan(
        curPlan,
        currentSession.day.dayId,
        currentSession,
      );
      if (!syncResult.ok) {
        throw new TxConflictError('state-conflict', syncResult.message);
      }
      diffMessage = `已将「${diff.dayName}」编排同步回原计划（${diff.summaryText}）`;
      return syncResult.plan;
    },
  );

  hooks?.onPlanCommitted?.(afterPlan);
  const epoch = await getCoachRestoreEpoch();
  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId,
    toolName: 'sync_session_to_plan',
    createdAt: Date.now(),
    scope: 'plan',
    summary: diffMessage,
    entityType: 'plan',
    entityId: afterPlan.id,
    planId: afterPlan.id,
    beforeRevision: sessionRev,
    afterRevision: sessionRev,
    beforePlanRevision: beforePlan.updatedAt,
    afterPlanRevision: afterPlan.updatedAt,
    restoreEpoch: epoch,
    undone: false,
    touchedTargets: [
      {
        kind: 'plan-day',
        planId: afterPlan.id,
        beforePlan,
        afterPlan: structuredClone(afterPlan),
      },
    ],
  };
  await saveCoachReceipt(receipt);
  hooks?.onReceiptSaved?.(receipt);
  return {
    scope: 'sync-to-plan',
    synced: true,
    message: receipt.summary,
    receipt,
    plan: afterPlan,
    session: currentSession,
  };
}

/* ── 字段级独立撤销（允许教练改第2组 → 用户改第3组 → 撤销第2组并完整保留第3组） ── */

function setsEqualCore(a: SessionSet, b: SessionSet): boolean {
  return (
    a.reps === b.reps &&
    a.weightKg === b.weightKg &&
    a.status === b.status &&
    Boolean(a.toFailure) === Boolean(b.toFailure)
  );
}

export async function undoCoachReceipt(
  receiptId: string,
  hooks?: CoachTxHooks,
): Promise<{ receipt: CoachOperationReceipt; session?: Session; plan?: Plan }> {
  const receipt = await getCoachReceipt(receiptId);
  if (!receipt) {
    throw new TxConflictError('not-found', '找不到对应的操作回执');
  }
  if (receipt.undone) {
    throw new TxConflictError('state-conflict', '该操作回执已经撤销过了');
  }

  const currentEpoch = await getCoachRestoreEpoch();
  if (receipt.restoreEpoch !== currentEpoch) {
    throw new TxConflictError(
      'epoch-mismatch',
      '系统已执行过备份恢复，恢复前产生的教练回执已自动失效，无法撤销。',
    );
  }

  let outSession: Session | undefined;
  let outPlan: Plan | undefined;

  for (const target of receipt.touchedTargets) {
    if (target.kind === 'session-set') {
      const runtime = getActiveSessionRuntime(target.sessionId);
      if (runtime) await runtime.awaitPendingWrites();

      const focus = checkFocusConflict({
        sessionId: target.sessionId,
        exId: target.exId,
        setId: target.setId,
      });
      if (focus.conflict) {
        throw new TxConflictError('focus-conflict', focus.message ?? '目标输入框正在编辑中，请稍后再撤销');
      }

      const current = await getSession(target.sessionId);
      if (!current || current.status !== 'active') {
        throw new TxConflictError('state-conflict', '训练已结束或记录已不存在，无法按进行中会话撤销');
      }
      const ex = current.exercises.find((e) => e.id === target.exId);
      const curSet = ex?.sets.find((s) => s.id === target.setId);
      if (!ex || !curSet) {
        throw new TxConflictError('field-conflict', '目标组已被删除，无法安全撤销');
      }
      if (!setsEqualCore(curSet, target.afterSet)) {
        throw new TxConflictError(
          'field-conflict',
          '你在教练操作后又修改过同一组数据，已停止撤销以避免覆盖你的最新修改',
        );
      }

      const prefillMap = new Map(
        (target.prefilledSets ?? []).map((p) => [p.setId, p]),
      );

      const rolledBack: Session = {
        ...current,
        exercises: current.exercises.map((item) => {
          if (item.id !== target.exId) return item;
          return {
            ...item,
            sets: item.sets.map((s) => {
              if (s.id === target.setId) {
                return structuredClone(target.beforeSet);
              }
              const pf = prefillMap.get(s.id);
              if (
                pf &&
                s.status === 'blank' &&
                !hasReps(s) &&
                s.weightKg === pf.afterWeightKg
              ) {
                return { ...s, weightKg: pf.beforeWeightKg };
              }
              return s;
            }),
          };
        }),
      };

      const res = await atomicWriteSession({
        intent: { kind: 'active-save' },
        session: rolledBack,
        editorId: runtime?.editorId,
        expectedRevision: revisionOf(current),
        lockPolicy: runtime ? 'required' : 'optional',
      });
      if (!res.ok) {
        throw new TxConflictError(res.reason, res.message);
      }
      runtime?.applyCommittedSession(res.session);
      hooks?.onSessionCommitted?.(res.session);
      outSession = res.session;
    } else if (target.kind === 'exercise-target') {
      const runtime = getActiveSessionRuntime(target.sessionId);
      if (runtime) await runtime.awaitPendingWrites();

      const focus = checkFocusConflict({ sessionId: target.sessionId, exId: target.exId, fields: ['target'] });
      if (focus.conflict) {
        throw new TxConflictError('focus-conflict', focus.message ?? '目标动作正在编辑中');
      }
      const current = await getSession(target.sessionId);
      if (!current || current.status !== 'active') {
        throw new TxConflictError('state-conflict', '训练已非进行中状态，无法撤销目标修改');
      }
      const ex = current.exercises.find((e) => e.id === target.exId);
      if (!ex) {
        throw new TxConflictError('field-conflict', '目标动作已不存在，无法撤销');
      }
      if (JSON.stringify(ex.target) !== JSON.stringify(target.afterTarget)) {
        throw new TxConflictError('field-conflict', '该动作目标在教练修改后又发生了变更，已终止撤销');
      }
      // 保留用户在其它组已经新记录的实绩，但回退 target 与尚未被用户填写的新增空白组
      const afterAddedIds = new Set(
        target.afterSets
          .filter((s) => !target.beforeSets.some((b) => b.id === s.id))
          .map((s) => s.id),
      );
      const anyAddedGotLogged = ex.sets.some(
        (s) => afterAddedIds.has(s.id) && (s.status !== 'blank' || s.reps !== null || s.weightKg !== null),
      );
      if (anyAddedGotLogged) {
        throw new TxConflictError('field-conflict', '新增的目标空白组已被写入实际训练数据，无法安全撤销');
      }

      const applied = applyTargetToSessionExercise(current, ex.id, target.beforeTarget, {
        confirmImpact: false,
      });
      if (!applied.applied) {
        throw new TxConflictError('field-conflict', applied.message);
      }
      const res = await atomicWriteSession({
        intent: { kind: 'active-save' },
        session: applied.session,
        editorId: runtime?.editorId,
        expectedRevision: revisionOf(current),
        lockPolicy: runtime ? 'required' : 'optional',
      });
      if (!res.ok) throw new TxConflictError(res.reason, res.message);
      runtime?.applyCommittedSession(res.session);
      hooks?.onSessionCommitted?.(res.session);
      outSession = res.session;
    } else if (target.kind === 'exercise-superset') {
      const runtime = getActiveSessionRuntime(target.sessionId);
      if (runtime) await runtime.awaitPendingWrites();

      const current = await getSession(target.sessionId);
      if (!current || current.status !== 'active') {
        throw new TxConflictError('state-conflict', '训练已非进行中状态，无法撤销超级组改动');
      }
      if (revisionOf(current) !== receipt.afterRevision) {
        // 核验受超级组影响的动作自身是否在后续被改动
        const beforeTouched = JSON.stringify(target.afterSession.exercises);
        const curTouched = JSON.stringify(current.exercises);
        if (beforeTouched !== curTouched) {
          throw new TxConflictError('field-conflict', '超级组动作在撤销前已发生其他变更，已阻止覆盖撤销');
        }
      }
      const rolledBack: Session = {
        ...current,
        exercises: cleanOrphanPairIds(structuredClone(target.beforeSession.exercises)),
      };
      const res = await atomicWriteSession({
        intent: { kind: 'active-save' },
        session: rolledBack,
        editorId: runtime?.editorId,
        expectedRevision: revisionOf(current),
        lockPolicy: runtime ? 'required' : 'optional',
      });
      if (!res.ok) throw new TxConflictError(res.reason, res.message);
      runtime?.applyCommittedSession(res.session);
      hooks?.onSessionCommitted?.(res.session);
      outSession = res.session;
    } else if (target.kind === 'history-edit') {
      const current = await getSession(target.sessionId);
      if (!current || current.status !== 'completed') {
        throw new TxConflictError('state-conflict', '历史记录已不存在或状态异常，无法撤销');
      }
      if (revisionOf(current) !== receipt.afterRevision) {
        throw new TxConflictError(
          'version-conflict',
          '该历史记录之后已被其他入口再次编辑，无法回滚覆盖',
          revisionOf(current),
        );
      }
      const rolledBack: Session = structuredClone(target.beforeSession);
      const res = await atomicSaveHistoryEdit({
        session: rolledBack,
        expectedRevision: revisionOf(current),
      });
      if (!res.ok) throw new TxConflictError(res.reason, res.message);
      hooks?.onSessionCommitted?.(res.session);
      outSession = res.session;
    } else if (target.kind === 'plan-created') {
      const curPlan = await getPlan(target.planId);
      if (!curPlan) {
        throw new TxConflictError('not-found', '新建的计划已被手动删除，无需撤销');
      }
      if (receipt.afterPlanRevision !== undefined && curPlan.updatedAt !== receipt.afterPlanRevision) {
        throw new TxConflictError('field-conflict', '该新建计划创建后已被修改，已阻止整份删除式撤销');
      }
      const delRes = await atomicDeletePlanWithCurrent(target.planId, (curId, remaining) =>
        curId === target.planId ? (remaining[0] ?? null) : undefined,
      );
      if (!delRes.ok) {
        throw new TxConflictError('storage', delRes.reason ?? '删除计划失败');
      }
      hooks?.onPlanDeleted?.(target.planId);
    } else if (target.kind === 'plan-day') {
      const { afterPlan } = await atomicUpdatePlanInTx(
        target.planId,
        receipt.afterPlanRevision,
        () => structuredClone(target.beforePlan),
      );
      hooks?.onPlanCommitted?.(afterPlan);
      outPlan = afterPlan;
    }
  }

  const nextReceipt: CoachOperationReceipt = {
    ...receipt,
    undone: true,
    undoneAt: Date.now(),
  };
  await saveCoachReceipt(nextReceipt);
  hooks?.onReceiptSaved?.(nextReceipt);
  return { receipt: nextReceipt, session: outSession, plan: outPlan };
}

// 兼容导出，避免未用 savePlan 告警（某些回退或简单创建仍按需调用）
export { savePlan };
