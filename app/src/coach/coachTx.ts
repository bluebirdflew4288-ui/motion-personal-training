/* 电子教练原子事务层与字段级独立撤销（阶段 2）。
   安全契约：
   1. 单写入通道与乐观锁：所有写操作基于 IDB 最新记录与 revision/updatedAt，在原子事务内完成；
   2. 焦点避让：写前核验 checkFocusConflict，绝不静默覆盖用户正在输入或持有 dirty raw 的单元格；
   3. 诚实数据状态：已完成组写入空/非正次数或非法重量时显式阻断并抛 TxConflictError('dirty-state')；
   4. 诚实倒计时：只有当组状态从「非 done -> done」时才触发 RestTimer；
   5. 字段级独立撤销：核验 restoreEpoch 与目标字段未被后续冲突覆写后精准回滚，保留用户对其他组（如第 3 组）的后续手动修改。 */

import { openDb, REST_TIMER_STATE_META_PREFIX, idbGet } from '../db/idb';
import {
  atomicDeletePlanWithCurrent,
  getSession,
  savePlan,
} from '../db/repo';
import {
  getExerciseTemplate,
} from '../db/templates';
import {
  revisionOf,
  type WriteFailureReason,
} from '../db/tx';
import { validateDataDeep } from '../db/validate';
import {
  CARDIO_PRESET_CHOICES,
  CARDIO_PRESET_LABEL,
  commitCardioParams,
  completeCardio,
  createCardioEntry,
  finalizeCardioForFinish,
  normalizeCardioParams,
  pauseCardio,
  resumeCardio,
  startCardio,
  validateCardioParams,
} from '../domain/cardio';
import { pushCycle } from '../domain/cycle';
import {
  ensureStageIds,
  exerciseTemplateFromConfig,
  planTargetApply,
  trainingFormLabel,
  trainingFormOf,
  validateExerciseTarget,
} from '../domain/exerciseConfig';
import {
  appendBlankGroupToHistoryExercise,
  correctHistoryCardioEntry,
  removeBlankGroupFromHistoryExercise,
  updateHistoryExerciseNote,
  updateHistorySessionNote,
} from '../domain/historyEdit';
import { exerciseIdFromName } from '../domain/identity';
import {
  MAX_CARDIO_ENTRIES,
  MAX_EXERCISES,
  MAX_LOGGED_REPS,
  MAX_PLANS,
  MAX_REST,
  MAX_REST_IN_SEC,
  MAX_STAGES_ACCEPTED,
  MAX_TEXT,
  MAX_WEIGHT,
  MIN_ROUNDS,
} from '../domain/limits';
import {
  addExercise,
  addWarmup,
  removeExercise,
  removeWarmup,
  renameDay,
  renameExercise,
  renamePlan,
  updateExercise,
  updateTarget,
  updateWarmup,
} from '../domain/planEdit';
import {
  addCardioToSession,
  applyTargetToSessionExercise,
  exerciseRemovalProtection,
  groupsFromTarget,
  newId,
  removeCardioFromSession,
  removeExerciseFromSession,
  restAfterSet,
  skipRemaining,
  summarizeSession,
  unskipExercise,
  withCardioEntry,
  withExercise,
  withSetAndPrefillFollowingWeight,
} from '../domain/session';
import { applySessionArrangementToPlan, diffSessionVsPlanDay } from '../domain/sessionToPlanSync';
import { parseSetupNote, setupNoteFor, withSetupNote } from '../domain/setupNote';
import {
  cleanOrphanPairIds,
  convertExerciseToMultiStageSuperset,
  generateUuidV4,
  pairExercisesAsSuperset,
  unpairSupersetExercises,
} from '../domain/supersetPair';
import type {
  CardioParams,
  CardioPreset,
  DropSetTarget,
  DropStageTarget,
  DumbbellBasis,
  ExerciseTarget,
  ExerciseTemplate,
  Plan,
  PlanCardio,
  PlanDay,
  PlanExercise,
  Session,
  SessionExercise,
  SessionSet,
  StraightTarget,
  TrainingForm,
  WeightMode,
} from '../domain/types';
import {
  COACH_MEMORY_META_KEY,
  loadCoachMemory,
  removeCoachMemoryItem,
  upsertCoachMemoryItem,
  type CoachMemoryCategory,
  type CoachMemoryItem,
  type CoachMemoryStore,
} from './coachMemory';
import {
  getCoachReceipt,
  getCoachReceiptByOperationId,
  getCoachRestoreEpoch,
  getCoachVaultRestoreEpoch,
  runCoachMemoryVaultTx,
  saveCoachReceipt,
  saveCoachReceiptStrict,
  type CoachFrozenTargetPrecondition,
  type CoachOperationReceipt,
  type CoachPlanDraft,
  type CoachReceiptExerciseTargetTouched,
  type CoachReceiptSetTouched,
  type CoachReceiptTouchedTarget,
} from './coachStorage';
import {
  computeCoachOpArgsDigest,
  executeCoachMainTx,
  executeCoachMainUndoTx,
  MainTxError,
  type CoachMainOpLogRecord,
} from './coachMainTx';
import {
  buildDurableRecordFromCoachDirective,
  shouldDispatchCoachOpTimer,
  type CoachRestTimerDirective,
  type DurableRestTimerRecord,
} from '../lib/restTimerDurable';
import { newRestToken } from '../lib/restReminder';
import { checkFocusConflict, type CoachEditableField } from './focusGuard';
import { getActiveSessionRuntime } from './sessionRuntimeBridge';

export type CoachTxConflictReason =
  | WriteFailureReason
  | 'focus-conflict'
  | 'dirty-state'
  | 'epoch-mismatch'
  | 'field-conflict'
  | 'not-found'
  | 'invalid-input'
  | 'ambiguous-target';

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

async function wrapMainTx<R>(fn: () => Promise<R>): Promise<R> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MainTxError) {
      throw new TxConflictError(err.reason, err.message, err.currentRevision);
    }
    throw err;
  }
}

export interface CoachTxHooks {
  onSessionCommitted?: (session: Session) => void;
  onPlanCommitted?: (plan: Plan) => void;
  onPlanDeleted?: (planId: string) => void;
  onReceiptSaved?: (receipt: CoachOperationReceipt) => void;
  onTemplatesChanged?: () => void;
  onMemoryChanged?: (memory: CoachMemoryStore) => void;
}

export interface CoachCommitResult<T = Record<string, unknown>> {
  receipt: CoachOperationReceipt;
  session?: Session;
  plan?: Plan;
  replayed?: boolean;
  timerDirective?: CoachRestTimerDirective;
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
  if (exact.length > 1) {
    throw new TxConflictError('ambiguous-target', `找到多个同名动作「${selector.exerciseName}」，请指定具体卡片`);
  }
  const fuzzy = session.exercises.filter((e) => e.name.trim().toLowerCase().includes(needle));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new TxConflictError('ambiguous-target', `找到多个匹配「${selector.exerciseName}」的动作，请指定具体卡片`);
  }
  throw new TxConflictError('not-found', `本次训练中没有找到动作「${selector.exerciseName}」`);
}

function resolveTargetSet(
  ex: SessionExercise,
  selector: {
    setId?: string;
    roundIndex?: number;
    stageIndex?: number;
    targetMode?: 'next_pending' | 'last_completed';
  },
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
  if (selector.targetMode === 'last_completed') {
    for (let i = ex.sets.length - 1; i >= 0; i -= 1) {
      if (ex.sets[i].status === 'done') return ex.sets[i];
    }
    throw new TxConflictError('not-found', `动作「${ex.name}」还没有已完成组可纠正`);
  }
  const skipped = new Set(ex.groups.filter((g) => g.skipped).map((g) => g.index));
  const nextPending = ex.sets.find((s) => !skipped.has(s.roundIndex) && s.status !== 'done');
  if (!nextPending) {
    throw new TxConflictError(
      'ambiguous-target',
      `动作「${ex.name}」的未跳过组已全部完成，请明确指定 roundIndex / setId，或以 targetMode: "last_completed" 纠正上一组`,
    );
  }
  return nextPending;
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

export interface CoachTxPreconditionArgs {
  frozenPrecondition?: CoachFrozenTargetPrecondition;
  priorBatchOpIds?: string[];
  strictSessionRevision?: boolean;
  modelExpectedRevision?: number;
}

function advanceRevisionFromPriorOps(
  baseRev: number,
  entityType: CoachOperationReceipt['entityType'],
  entityId: string,
  currentEpoch: number,
  priorOpLogs: CoachMainOpLogRecord[],
): number {
  let cursor = baseRev;
  for (const op of priorOpLogs) {
    if (
      op.entityType === entityType &&
      op.entityId === entityId &&
      op.restoreEpoch === currentEpoch &&
      !op.undone &&
      op.beforeRevision === cursor
    ) {
      cursor = op.afterRevision;
    }
  }
  return cursor;
}

function resolveBatchAdjustedSetExpectation(
  pre: Extract<CoachFrozenTargetPrecondition, { kind: 'set' }>,
  priorOpLogs: CoachMainOpLogRecord[],
  currentEpoch: number,
): {
  status: SessionSet['status'];
  reps: number | null;
  weightKg: number | null;
  toFailure: boolean;
  note: string;
} {
  let status = pre.beforeStatus;
  let reps = pre.beforeReps;
  let weightKg = pre.beforeWeightKg;
  let toFailure = Boolean(pre.beforeToFailure);
  let note = pre.beforeNote;
  for (const op of priorOpLogs) {
    if (op.restoreEpoch !== currentEpoch || op.undone) continue;
    for (const t of op.touchedTargets) {
      if (t.kind === 'session-set' && t.sessionId === pre.sessionId && t.setId === pre.setId) {
        status = t.afterSet.status;
        reps = t.afterSet.reps;
        weightKg = t.afterSet.weightKg;
        toFailure = Boolean(t.afterSet.toFailure);
        note = t.afterSet.note ?? '';
      } else if (t.kind === 'session-snapshot' && t.sessionId === pre.sessionId) {
        const sAfter = t.afterSession.exercises
          .find((e) => e.id === pre.exId)
          ?.sets.find((s) => s.id === pre.setId);
        if (sAfter) {
          status = sAfter.status;
          reps = sAfter.reps;
          weightKg = sAfter.weightKg;
          toFailure = Boolean(sAfter.toFailure);
          note = sAfter.note ?? '';
        }
      }
    }
  }
  return { status, reps, weightKg, toFailure, note };
}

function isFrozenSessionPreconditionIntact(
  currentSession: Session,
  pre: CoachFrozenTargetPrecondition,
  priorOpLogs: CoachMainOpLogRecord[],
  currentEpoch: number,
): boolean {
  if (pre.kind === 'plan') return false;
  if (pre.sessionId && pre.sessionId !== currentSession.id) return false;
  switch (pre.kind) {
    case 'session-strict':
      return false;
    case 'set': {
      const ex = currentSession.exercises.find((e) => e.id === pre.exId);
      if (!ex) return false;
      if (ex.name !== pre.beforeExName || JSON.stringify(ex.target) !== pre.beforeTargetJson) {
        return false;
      }
      const liveSet = ex.sets.find((s) => s.id === pre.setId);
      if (!liveSet) return false;
      const expected = resolveBatchAdjustedSetExpectation(pre, priorOpLogs, currentEpoch);
      if (liveSet.status !== expected.status) return false;
      if (
        (pre.touchedFields.includes('reps') || pre.touchedFields.includes('status')) &&
        liveSet.reps !== expected.reps
      ) {
        return false;
      }
      if (
        (pre.touchedFields.includes('weightKg') || pre.touchedFields.includes('status')) &&
        liveSet.weightKg !== expected.weightKg
      ) {
        return false;
      }
      if (
        pre.touchedFields.includes('toFailure') &&
        Boolean(liveSet.toFailure) !== expected.toFailure
      ) {
        return false;
      }
      if (pre.touchedFields.includes('note') && (liveSet.note ?? '') !== expected.note) {
        return false;
      }
      return true;
    }
    case 'session-note': {
      let expectedNote = pre.beforeNote;
      for (const op of priorOpLogs) {
        if (op.restoreEpoch !== currentEpoch || op.undone) continue;
        for (const t of op.touchedTargets) {
          if (t.kind === 'session-snapshot' && t.sessionId === pre.sessionId) {
            expectedNote = t.afterSession.note ?? '';
          }
        }
      }
      return (currentSession.note ?? '') === expectedNote;
    }
    case 'exercise-note': {
      const ex = currentSession.exercises.find((e) => e.id === pre.exId);
      if (!ex) return false;
      return (ex.note ?? '') === pre.beforeNote;
    }
    case 'exercise-target': {
      const ex = currentSession.exercises.find((e) => e.id === pre.exId);
      if (!ex) return false;
      return (
        ex.name === pre.beforeExName &&
        ex.restSec === pre.beforeRestSec &&
        JSON.stringify(ex.target) === pre.beforeTargetJson
      );
    }
    case 'exercise-structure': {
      const ex = currentSession.exercises.find((e) => e.id === pre.exId);
      if (!ex) return false;
      const curShape = JSON.stringify({
        name: ex.name,
        form: trainingFormOf(ex.target),
        target: ex.target,
        sets: ex.sets.map((s) => ({ id: s.id, status: s.status, reps: s.reps, weightKg: s.weightKg })),
      });
      return curShape === pre.beforeExerciseJson;
    }
    case 'exercise-list': {
      return JSON.stringify(currentSession.exercises.map((e) => e.id)) === JSON.stringify(pre.beforeExIds);
    }
    case 'superset': {
      const curShape = JSON.stringify(
        currentSession.exercises.map((e) => ({
          id: e.id,
          pairId: e.pairId ?? null,
          target: e.target,
        })),
      );
      return curShape === pre.beforeExercisesJson;
    }
    case 'warmup': {
      const w = pre.warmupId ? currentSession.warmups.find((x) => x.id === pre.warmupId) : undefined;
      return JSON.stringify(w ?? null) === pre.beforeWarmupJson;
    }
    case 'warmup-list':
      return JSON.stringify(currentSession.warmups) === pre.beforeWarmupsJson;
    case 'cardio': {
      const list = currentSession.cardio ?? [];
      const c = pre.cardioId ? list.find((x) => x.id === pre.cardioId) : undefined;
      return JSON.stringify(c ?? null) === pre.beforeCardioJson;
    }
    case 'cardio-list':
      return JSON.stringify(currentSession.cardio ?? []) === pre.beforeCardioJson;
    case 'setup-note': {
      if (!pre.exId) return true;
      const ex = currentSession.exercises.find((e) => e.id === pre.exId);
      if (!ex) return false;
      return (ex.setupNote ?? '') === (pre.beforeSessionSetupNote ?? '');
    }
    default:
      return false;
  }
}

function assertSessionVersionOrPrecondition(params: {
  currentSession: Session;
  expectedRevision?: number;
  modelExpectedRevision?: number;
  currentEpoch: number;
  priorOpLogs: CoachMainOpLogRecord[];
  frozenPrecondition?: CoachFrozenTargetPrecondition;
  strictSessionRevision?: boolean;
  entityLabel?: string;
}): void {
  const {
    currentSession,
    expectedRevision,
    modelExpectedRevision,
    currentEpoch,
    priorOpLogs,
    frozenPrecondition,
    strictSessionRevision,
    entityLabel = '训练记录',
  } = params;
  const curRev = revisionOf(currentSession);
  if (expectedRevision !== undefined) {
    const selfExpectedRev = advanceRevisionFromPriorOps(
      expectedRevision,
      'session',
      currentSession.id,
      currentEpoch,
      priorOpLogs,
    );
    const frozenSatisfied =
      curRev === selfExpectedRev ||
      (!strictSessionRevision &&
        frozenPrecondition &&
        isFrozenSessionPreconditionIntact(currentSession, frozenPrecondition, priorOpLogs, currentEpoch));

    if (!frozenSatisfied) {
      throw new TxConflictError(
        'version-conflict',
        `${entityLabel}已更新到版本 r${curRev}（请求基准 r${expectedRevision}），目标内容存在并发修改，已拒绝覆盖`,
        curRev,
      );
    }
    if (
      modelExpectedRevision !== undefined &&
      (modelExpectedRevision < expectedRevision || modelExpectedRevision > selfExpectedRev)
    ) {
      throw new TxConflictError(
        'version-conflict',
        `${entityLabel}已更新到版本 r${curRev}（请求基准 r${modelExpectedRevision}），与冻结视图基准不一致，已拒绝覆盖`,
        curRev,
      );
    }
    return;
  }

  if (modelExpectedRevision !== undefined) {
    const selfModelRev = advanceRevisionFromPriorOps(
      modelExpectedRevision,
      'session',
      currentSession.id,
      currentEpoch,
      priorOpLogs,
    );
    if (
      curRev !== selfModelRev &&
      !(
        !strictSessionRevision &&
        frozenPrecondition &&
        isFrozenSessionPreconditionIntact(currentSession, frozenPrecondition, priorOpLogs, currentEpoch)
      )
    ) {
      throw new TxConflictError(
        'version-conflict',
        `${entityLabel}已更新到版本 r${curRev}（请求基准 r${modelExpectedRevision}），目标内容存在并发修改，已拒绝覆盖`,
        curRev,
      );
    }
  }
}

async function runActiveSessionMutation<T>(
  args: {
    operationId: string;
    toolName: CoachOperationReceipt['toolName'];
    sessionId: string;
    expectedRevision?: number;
    modelExpectedRevision?: number;
    expectedEpoch?: number;
    frozenPrecondition?: CoachFrozenTargetPrecondition;
    priorBatchOpIds?: string[];
    strictSessionRevision?: boolean;
    deferTimerDispatch?: boolean;
    argsForDigest?: unknown;
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
  const runtime = getActiveSessionRuntime(args.sessionId);
  if (runtime) {
    await runtime.awaitPendingWrites();
  }
  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx<T>({
      operationId: args.operationId,
      toolName: args.toolName,
      argsForDigest: args.argsForDigest ?? {
        toolName: args.toolName,
        sessionId: args.sessionId,
      },
      expectedEpoch: args.expectedEpoch,
      priorBatchOpIds: args.priorBatchOpIds,
      stores: ['sessions'],
      sessionId: args.sessionId,
      lockCheck: {
        sessionId: args.sessionId,
        editorId: runtime?.editorId,
        lockPolicy: runtime ? 'required' : 'optional',
      },
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentSession, priorOpLogs }) => {
        if (!currentSession) {
          throw new TxConflictError('not-found', '找不到目标训练记录');
        }
        if (currentSession.status !== 'active') {
          throw new TxConflictError('state-conflict', '训练已结束或已放弃，无法再以进行中训练写入');
        }
        const curRev = revisionOf(currentSession);
        assertSessionVersionOrPrecondition({
          currentSession,
          expectedRevision: args.expectedRevision,
          modelExpectedRevision: args.modelExpectedRevision,
          currentEpoch,
          priorOpLogs,
          frozenPrecondition: args.frozenPrecondition,
          strictSessionRevision: args.strictSessionRevision,
          entityLabel: '训练记录',
        });

        const computed = args.compute(currentSession);
        const cardioList = computed.nextSession.cardio ?? [];
        if (cardioList.length > MAX_CARDIO_ENTRIES) {
          throw new TxConflictError('dirty-state', `一次训练最多 ${MAX_CARDIO_ENTRIES} 个有氧项目`);
        }
        if (cardioList.filter((c) => c.status === 'running').length > 1) {
          throw new TxConflictError(
            'state-conflict',
            '一次训练只能有一个正在计时的有氧项目，请先暂停或完成当前项目',
          );
        }

        const nextSession: Session = {
          ...computed.nextSession,
          revision: curRev + 1,
        };
        const timerDirective: CoachRestTimerDirective | undefined = computed.timerTrigger
          ? {
              operationId: args.operationId,
              restSec: computed.timerTrigger.sec,
              source: computed.timerTrigger.source,
              token: newRestToken(),
              deadlineAtMs: now + computed.timerTrigger.sec * 1000,
              createdAt: now,
              restoreEpoch: currentEpoch,
            }
          : undefined;
        const durableRestTimer: DurableRestTimerRecord | undefined = timerDirective
          ? buildDurableRecordFromCoachDirective(currentSession.id, timerDirective)
          : undefined;

        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId: args.operationId,
          receiptId: makeReceiptId(),
          toolName: args.toolName,
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: 'session',
          summary: computed.summary,
          entityType: 'session',
          entityId: currentSession.id,
          beforeRevision: curRev,
          afterRevision: curRev + 1,
          undoable: true,
          undone: false,
          timerStarted: Boolean(timerDirective),
          ...(timerDirective ? { timerDirective } : {}),
          touchedTargets: computed.touchedTargets,
        };

        return {
          nextSession,
          durableRestTimer,
          opLog,
          meta: computed.meta,
        };
      },
    }),
  );

  // Best-effort mirror to motion-coach-vault; main DB already holds authoritative coach-op:*!
  await saveCoachReceipt(txResult.receipt);

  if (txResult.session && !txResult.replayed) {
    runtime?.applyCommittedSession(txResult.session);
    hooks?.onSessionCommitted?.(txResult.session);
  }
  hooks?.onReceiptSaved?.(txResult.receipt);

  const timerDirective = txResult.opLog.timerDirective;
  if (timerDirective && !args.deferTimerDispatch && runtime) {
    let nativeAlreadyScheduled: boolean | undefined;
    if (txResult.replayed && typeof indexedDB !== 'undefined') {
      const durableRow = await idbGet<{ key: string; value?: DurableRestTimerRecord }>(
        'meta',
        `${REST_TIMER_STATE_META_PREFIX}${args.sessionId}`,
      ).catch(() => undefined);
      nativeAlreadyScheduled = durableRow?.value?.nativeScheduled ?? true;
    }
    if (
      shouldDispatchCoachOpTimer({
        replayed: txResult.replayed,
        nativeScheduled: nativeAlreadyScheduled,
        isFinalTimerInBatch: true,
      })
    ) {
      if (runtime.startRestTimerWithDirective) {
        runtime.startRestTimerWithDirective(timerDirective);
      } else {
        runtime.startRestTimer(timerDirective.restSec, timerDirective.source);
      }
    }
  }

  return {
    receipt: txResult.receipt,
    session: txResult.session,
    replayed: txResult.replayed,
    timerDirective,
    meta: txResult.meta,
  };
}

/* ── 工具 1：调整本次训练目标（支持切换普通组/超级组/递减组与休息时长，严格不标 done） ── */

export interface CoachTargetStageInput {
  id?: string;
  label: string;
  repsMin?: number | null;
  repsMax?: number | null;
  weightKg?: number | null;
  toFailure?: boolean;
  restAfterSec?: number;
}

export interface CoachTargetSpecInput {
  form?: TrainingForm;
  sets?: number;
  setsMax?: number;
  repsMin?: number;
  repsMax?: number;
  suggestedWeightKg?: number | null;
  weightMode?: WeightMode;
  dumbbellBasis?: DumbbellBasis;
  toFailure?: boolean;
  restSec?: number;
  restInSec?: number;
  restAfterSec?: number;
  stages?: CoachTargetStageInput[];
  stageTargets?: Array<{ stageIndex: number; repsMin?: number | null; repsMax?: number | null; weightKg?: number | null; label?: string; toFailure?: boolean; restAfterSec?: number }>;
}

const TWENTY_ONES_NAME_RE = /(21\s*响|21s|21\s*次)/i;

function defaultStagesForExercise(
  name: string,
  spec: CoachTargetSpecInput,
  fallbackTarget?: ExerciseTarget,
): DropStageTarget[] {
  if (fallbackTarget?.kind === 'dropSet' && fallbackTarget.stages.length >= 2) {
    return fallbackTarget.stages.map((st) => ({
      ...st,
      ...(spec.repsMin !== undefined ? { repsMin: spec.repsMin } : {}),
      ...(spec.repsMax !== undefined ? { repsMax: spec.repsMax } : {}),
      ...(spec.suggestedWeightKg !== undefined ? { weightKg: spec.suggestedWeightKg } : {}),
    }));
  }
  const baseWeight =
    spec.suggestedWeightKg !== undefined
      ? spec.suggestedWeightKg
      : fallbackTarget?.kind === 'straight'
        ? fallbackTarget.suggestedWeightKg
        : null;
  if (TWENTY_ONES_NAME_RE.test(name)) {
    return [
      { id: newId('st'), label: '下半程', weightKg: baseWeight, repsMin: 7, repsMax: 7, toFailure: false, targetText: `7次${baseWeight !== null ? ` · ${baseWeight}kg` : ''}` },
      { id: newId('st'), label: '上半程', weightKg: baseWeight, repsMin: 7, repsMax: 7, toFailure: false, targetText: `7次${baseWeight !== null ? ` · ${baseWeight}kg` : ''}` },
      { id: newId('st'), label: '全程', weightKg: baseWeight, repsMin: 7, repsMax: 7, toFailure: false, targetText: `7次${baseWeight !== null ? ` · ${baseWeight}kg` : ''}` },
    ];
  }
  const baseRepsMin =
    spec.repsMin ?? (fallbackTarget?.kind === 'straight' ? fallbackTarget.repsMin : 8);
  const baseRepsMax =
    spec.repsMax ?? (fallbackTarget?.kind === 'straight' ? fallbackTarget.repsMax : Math.max(baseRepsMin, 12));
  return [
    { id: newId('st'), label: '第 1 阶段', weightKg: baseWeight, repsMin: baseRepsMin, repsMax: baseRepsMax, toFailure: false, targetText: `${baseRepsMin}-${baseRepsMax}次` },
    { id: newId('st'), label: '第 2 阶段', weightKg: baseWeight !== null ? Math.max(0, Math.round(baseWeight * 0.75 * 2) / 2) : null, repsMin: baseRepsMin, repsMax: baseRepsMax, toFailure: false, targetText: `${baseRepsMin}-${baseRepsMax}次` },
  ];
}

export function buildExerciseTargetFromInput(
  name: string,
  input: CoachTargetSpecInput,
  fallbackTarget?: ExerciseTarget,
  fallbackRestSec = 120,
): { target: ExerciseTarget; restSec: number } {
  const inferredDrop =
    !input.form &&
    !input.stages?.length &&
    !fallbackTarget &&
    TWENTY_ONES_NAME_RE.test(name);
  const targetForm: TrainingForm =
    input.form ??
    (input.stages?.length ? (fallbackTarget?.kind === 'dropSet' && fallbackTarget.form === 'superset' ? 'superset' : 'dropSet') : inferredDrop ? 'dropSet' : fallbackTarget ? trainingFormOf(fallbackTarget) : 'straight');

  const weightMode: WeightMode = input.weightMode ?? fallbackTarget?.weightMode ?? 'external';
  const dumbbellBasis: DumbbellBasis | undefined = input.dumbbellBasis ?? fallbackTarget?.dumbbellBasis;
  const resolvedRestSec =
    input.restSec !== undefined
      ? Math.round(input.restSec)
      : input.restAfterSec !== undefined
        ? Math.round(input.restAfterSec)
        : fallbackTarget?.kind === 'dropSet'
          ? fallbackTarget.restAfterSec
          : fallbackRestSec;

  if (!Number.isInteger(resolvedRestSec) || resolvedRestSec < 0 || resolvedRestSec > MAX_REST) {
    throw new TxConflictError('invalid-input', `组间休息需在 0–${MAX_REST} 秒的整数之间`);
  }

  if (targetForm === 'straight') {
    const prevStraight: StraightTarget | undefined =
      fallbackTarget?.kind === 'straight' ? fallbackTarget : undefined;
    const prevFirstStage = fallbackTarget?.kind === 'dropSet' ? fallbackTarget.stages[0] : undefined;
    const sets = input.sets ?? prevStraight?.sets ?? (fallbackTarget?.kind === 'dropSet' ? fallbackTarget.rounds : 3);
    const setsMax = Math.max(sets, input.setsMax ?? prevStraight?.setsMax ?? sets);
    const repsMin = input.repsMin ?? prevStraight?.repsMin ?? prevFirstStage?.repsMin ?? 8;
    const repsMax = Math.max(repsMin, input.repsMax ?? prevStraight?.repsMax ?? prevFirstStage?.repsMax ?? Math.max(repsMin, 12));
    const suggestedWeightKg =
      input.suggestedWeightKg !== undefined
        ? input.suggestedWeightKg
        : prevStraight
          ? prevStraight.suggestedWeightKg
          : (prevFirstStage?.weightKg ?? null);
    const target: StraightTarget = {
      kind: 'straight',
      sets,
      setsMax,
      repsMin,
      repsMax,
      weightMode,
      suggestedWeightKg: weightMode === 'bodyweight' && input.suggestedWeightKg === undefined ? null : suggestedWeightKg,
      ...(dumbbellBasis ? { dumbbellBasis } : {}),
      ...(input.toFailure !== undefined
        ? { toFailure: input.toFailure }
        : prevStraight?.toFailure !== undefined
          ? { toFailure: prevStraight.toFailure }
          : {}),
      ...(prevStraight?.perSetConfigs ? { perSetConfigs: structuredClone(prevStraight.perSetConfigs) } : {}),
    };
    const issues = validateExerciseTarget(target);
    if (issues.length) {
      throw new TxConflictError('invalid-input', issues[0].message);
    }
    return { target, restSec: resolvedRestSec };
  }

  // 多阶段：dropSet 或 superset
  const prevDrop: DropSetTarget | undefined =
    fallbackTarget?.kind === 'dropSet' ? fallbackTarget : undefined;
  const rounds = Math.max(
    MIN_ROUNDS,
    input.sets ?? prevDrop?.rounds ?? (fallbackTarget?.kind === 'straight' ? Math.max(1, fallbackTarget.sets) : 3),
  );
  const restInSec =
    input.restInSec !== undefined
      ? Math.round(input.restInSec)
      : prevDrop?.restInSec ?? (targetForm === 'superset' ? 15 : 10);
  const restAfterSec =
    input.restAfterSec !== undefined
      ? Math.round(input.restAfterSec)
      : input.restSec !== undefined
        ? Math.round(input.restSec)
        : prevDrop?.restAfterSec ?? resolvedRestSec;

  if (!Number.isInteger(restInSec) || restInSec < 0 || restInSec > MAX_REST_IN_SEC) {
    throw new TxConflictError('invalid-input', `阶段间短歇需在 0–${MAX_REST_IN_SEC} 秒之间`);
  }

  let stages: DropStageTarget[];
  if (input.stages?.length) {
    stages = input.stages.map((st, idx) => {
      const rMin = st.repsMin === undefined ? 8 : st.repsMin;
      const rMax = st.repsMax === undefined ? (rMin !== null ? rMin : null) : st.repsMax;
      const wt = st.weightKg === undefined ? (input.suggestedWeightKg ?? null) : st.weightKg;
      return {
        id: st.id?.trim() || newId('st'),
        label: (st.label || `第 ${idx + 1} 阶段`).trim(),
        weightKg: wt,
        repsMin: rMin,
        repsMax: rMax,
        toFailure: Boolean(st.toFailure),
        ...(st.restAfterSec !== undefined ? { restAfterSec: Math.round(st.restAfterSec) } : {}),
        targetText:
          rMin !== null && rMax !== null
            ? `${rMin === rMax ? rMin : `${rMin}-${rMax}`}次${wt !== null ? ` · ${wt}kg` : ''}`
            : wt !== null
              ? `${wt}kg`
              : '',
      };
    });
  } else {
    stages = defaultStagesForExercise(name, input, fallbackTarget);
  }

  if (input.stageTargets?.length) {
    stages = stages.map((stage, i) => {
      const patch = input.stageTargets?.find((p) => p.stageIndex === i + 1);
      if (!patch) return stage;
      return {
        ...stage,
        ...(patch.label !== undefined ? { label: patch.label.trim() || stage.label } : {}),
        ...(patch.repsMin !== undefined ? { repsMin: patch.repsMin } : {}),
        ...(patch.repsMax !== undefined ? { repsMax: patch.repsMax } : {}),
        ...(patch.weightKg !== undefined ? { weightKg: patch.weightKg } : {}),
        ...(patch.toFailure !== undefined ? { toFailure: patch.toFailure } : {}),
        ...(patch.restAfterSec !== undefined ? { restAfterSec: Math.round(patch.restAfterSec) } : {}),
      };
    });
  }

  const rawDrop: DropSetTarget = {
    kind: 'dropSet',
    form: targetForm,
    rounds,
    stages,
    ...(prevDrop?.roundConfigs && !input.stages?.length ? { roundConfigs: structuredClone(prevDrop.roundConfigs) } : {}),
    restInSec,
    restAfterSec,
    weightMode,
    ...(dumbbellBasis ? { dumbbellBasis } : {}),
  };
  const target = ensureStageIds(rawDrop) as DropSetTarget;
  const issues = validateExerciseTarget(target, { minStages: 1, maxStages: MAX_STAGES_ACCEPTED });
  if (issues.length) {
    throw new TxConflictError('invalid-input', issues[0].message);
  }
  return { target, restSec: restAfterSec };
}

function summarizeTargetLabel(target: ExerciseTarget, restSec: number): string {
  if (target.kind === 'straight') {
    const parts = [
      `普通组 ${target.sets} 组 × ${target.repsMin}-${target.repsMax} 次`,
      ...(target.suggestedWeightKg !== null ? [`${target.suggestedWeightKg}kg`] : []),
      `休息 ${restSec}s`,
    ];
    return parts.join(' · ');
  }
  const formText = trainingFormLabel(trainingFormOf(target));
  const stageDesc = target.stages
    .map((s) => `${s.label}${s.repsMin !== null ? ` ${s.repsMin}${s.repsMax && s.repsMax !== s.repsMin ? `-${s.repsMax}` : ''}次` : ''}${s.weightKg !== null ? `·${s.weightKg}kg` : ''}`)
    .join('/');
  return `${formText} ${target.rounds} 轮 × ${target.stages.length} 阶段（${stageDesc}）· 轮间休息 ${target.restAfterSec}s`;
}

export type AdjustActiveTargetInput = {
  operationId?: string;
  sessionId: string;
  exId?: string;
  exerciseName?: string;
  expectedRevision?: number;
  expectedEpoch?: number;
  deferTimerDispatch?: boolean;
  form?: TrainingForm;
  sets?: number;
  setsMax?: number;
  repsMin?: number;
  repsMax?: number;
  suggestedWeightKg?: number | null;
  weightMode?: WeightMode;
  dumbbellBasis?: DumbbellBasis;
  toFailure?: boolean;
  restSec?: number;
  restInSec?: number;
  restAfterSec?: number;
  stages?: CoachTargetStageInput[];
  stageTargets?: Array<{ stageIndex: number; repsMin?: number | null; repsMax?: number | null; weightKg?: number | null; label?: string; toFailure?: boolean; restAfterSec?: number }>;
  allowDiscardLoggedData?: boolean;
} & CoachTxPreconditionArgs;

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
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      deferTimerDispatch: input.deferTimerDispatch,
      argsForDigest: input,
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

        const beforeForm = trainingFormOf(ex.target);
        const beforeRestSec = ex.target.kind === 'dropSet' ? ex.target.restAfterSec : ex.restSec;
        const { target: nextTarget, restSec: nextRestSec } = buildExerciseTargetFromInput(
          ex.name,
          input,
          ex.target,
          ex.restSec,
        );

        const impact = planTargetApply(ex, nextTarget);
        if (impact.validationIssues.length) {
          throw new TxConflictError('invalid-input', impact.validationIssues[0].message);
        }
        if (impact.removedWithData.length > 0 && !input.allowDiscardLoggedData) {
          throw new TxConflictError(
            'dirty-state',
            `目标调整会移除 ${impact.removedWithData.length} 条已输入实绩，已拒绝对实绩的静默修改`,
          );
        }

        const applied = applyTargetToSessionExercise(current, ex.id, nextTarget, { confirmImpact: true });
        if (!applied.applied) {
          throw new TxConflictError(
            'dirty-state',
            applied.message || '目标调整会影响已记录组，已拒绝对实绩的静默修改',
          );
        }

        const nextSession = withExercise(applied.session, ex.id, { restSec: nextRestSec });
        const nextEx = nextSession.exercises.find((e) => e.id === ex.id)!;
        const afterForm = trainingFormOf(nextEx.target);

        const parts: string[] = [];
        if (beforeForm !== afterForm) {
          parts.push(`形式 ${trainingFormLabel(beforeForm)} → ${trainingFormLabel(afterForm)}`);
        }
        if (nextEx.target.kind === 'straight') {
          parts.push(`${nextEx.target.sets} 组 × ${nextEx.target.repsMin}-${nextEx.target.repsMax} 次`);
          if (nextEx.target.suggestedWeightKg !== null) parts.push(`${nextEx.target.suggestedWeightKg}kg`);
        } else {
          parts.push(`${nextEx.target.rounds} 轮 × ${nextEx.target.stages.length} 阶段`);
        }
        if (beforeRestSec !== nextRestSec || input.restSec !== undefined || input.restAfterSec !== undefined) {
          parts.push(`休息 ${beforeRestSec}s → ${nextRestSec}s`);
        }
        if (nextEx.target.kind === 'dropSet' && input.restInSec !== undefined) {
          parts.push(`阶段短歇 ${nextEx.target.restInSec}s`);
        }
        const summary = `调整「${ex.name}」目标：${parts.join(' · ')}`;

        const touched: CoachReceiptExerciseTargetTouched = {
          kind: 'exercise-target',
          sessionId: current.id,
          exId: ex.id,
          beforeTarget: structuredClone(ex.target),
          afterTarget: structuredClone(nextEx.target),
          beforeSets: structuredClone(ex.sets),
          afterSets: structuredClone(nextEx.sets),
          beforeRestSec: ex.restSec,
          afterRestSec: nextEx.restSec,
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

export type RecordActiveSetInput = {
  operationId?: string;
  sessionId: string;
  exId?: string;
  exerciseName?: string;
  setId?: string;
  roundIndex?: number;
  stageIndex?: number;
  targetMode?: 'next_pending' | 'last_completed';
  expectedRevision?: number;
  expectedEpoch?: number;
  deferTimerDispatch?: boolean;
  reps?: number | null;
  weightKg?: number | null;
  status?: 'done' | 'blank' | 'partial';
  toFailure?: boolean;
  note?: string;
} & CoachTxPreconditionArgs;

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
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      deferTimerDispatch: input.deferTimerDispatch,
      argsForDigest: input,
      compute: (current) => {
        const ex = resolveSessionExercise(current, input);
        const prevSet = resolveTargetSet(ex, input);

        if (input.note !== undefined && input.note.length > 500) {
          throw new TxConflictError('invalid-input', '单组备注最多 500 个字符');
        }

        const nextReps = input.reps !== undefined ? input.reps : prevSet.reps;
        const nextWeight = input.weightKg !== undefined ? input.weightKg : prevSet.weightKg;
        const nextStatus: SessionSet['status'] = input.status ?? 'done';
        const explicitWeightClear = input.weightKg === null;

        assertCleanSetValues(ex, prevSet, nextReps, nextWeight, nextStatus, explicitWeightClear);

        const fieldsToGuard: CoachEditableField[] = [];
        if (input.reps !== undefined) fieldsToGuard.push('reps');
        if (input.weightKg !== undefined) fieldsToGuard.push('weight');
        if (input.note !== undefined) fieldsToGuard.push('note');
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

        const cleanNote = input.note !== undefined ? input.note.trim() : undefined;
        const patch: Partial<SessionSet> = {
          ...(input.reps !== undefined ? { reps: input.reps } : {}),
          ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
          ...(input.toFailure !== undefined ? { toFailure: input.toFailure } : {}),
          ...(cleanNote !== undefined ? { note: cleanNote || undefined } : {}),
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
        const noteTag = cleanNote ? ' · 已记备注' : '';
        const summary = `记录「${ex.name}」第 ${afterSet.roundIndex} 组${ex.sets.some((s) => s.stageIndex > 1) ? `·阶段${afterSet.stageIndex}` : ''}：${afterSet.reps ?? '—'} 次 × ${weightLabel}${noteTag}`;

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

export type ConfigureSupersetInput = (
  | {
      operationId?: string;
      sessionId: string;
      mode: 'pair';
      exIds: string[];
      pairId?: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
    }
  | {
      operationId?: string;
      sessionId: string;
      mode: 'unpair';
      exIds: string[];
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
    }
  | {
      operationId?: string;
      sessionId: string;
      mode: 'convert_multistage';
      exId: string;
      partnerName: string;
      rounds?: number;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
    }
) & CoachTxPreconditionArgs;

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
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      deferTimerDispatch: input.deferTimerDispatch,
      argsForDigest: input,
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

export type CorrectHistoryInput = (
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'update_session_note';
      note: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'update_exercise_note';
      exId?: string;
      exerciseName?: string;
      note: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'append_group';
      exId?: string;
      exerciseName?: string;
      reps?: number | null;
      weightKg?: number | null;
      status?: 'done' | 'blank' | 'partial';
      note?: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'remove_blank_group';
      exId?: string;
      exerciseName?: string;
      roundIndex: number;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'correct_set';
      exId?: string;
      exerciseName?: string;
      setId?: string;
      roundIndex?: number;
      stageIndex?: number;
      targetMode?: 'next_pending' | 'last_completed';
      reps?: number | null;
      weightKg?: number | null;
      status?: 'done' | 'blank' | 'partial';
      note?: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      action: 'correct_cardio';
      cardioId?: string;
      cardioName?: string;
      elapsedMs?: number;
      durationSec?: number;
      params?: CardioParams;
      note?: string;
    }
) & CoachTxPreconditionArgs;

export async function coachCorrectHistory(
  input: CorrectHistoryInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('hist-edit');
  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'correct_history_session',
      argsForDigest: input,
      expectedEpoch: input.expectedEpoch,
      priorBatchOpIds: input.priorBatchOpIds,
      stores: ['sessions'],
      sessionId: input.sessionId,
      lockCheck: { sessionId: input.sessionId, lockPolicy: 'optional' },
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentSession, priorOpLogs }) => {
        if (!currentSession) {
          throw new TxConflictError('not-found', '找不到要纠错的历史训练记录');
        }
        if (currentSession.status !== 'completed') {
          throw new TxConflictError('state-conflict', '仅已完成的历史训练支持历史纠错');
        }
        const curRev = revisionOf(currentSession);
        assertSessionVersionOrPrecondition({
          currentSession,
          expectedRevision: input.expectedRevision,
          modelExpectedRevision: input.modelExpectedRevision,
          currentEpoch,
          priorOpLogs,
          frozenPrecondition: input.frozenPrecondition,
          strictSessionRevision: input.strictSessionRevision,
          entityLabel: '历史训练记录',
        });

        let nextSession = currentSession;
        let summary = '';

        if (input.action === 'update_session_note') {
          const r = updateHistorySessionNote(currentSession, input.note);
          if (!r.ok) throw new TxConflictError('invalid-input', r.message);
          nextSession = r.session;
          summary = '更新历史训练总备注';
        } else if (input.action === 'update_exercise_note') {
          const ex = resolveSessionExercise(currentSession, input);
          const r = updateHistoryExerciseNote(currentSession, ex.id, input.note);
          if (!r.ok) throw new TxConflictError('invalid-input', r.message);
          nextSession = r.session;
          summary = `更新历史「${ex.name}」备注`;
        } else if (input.action === 'append_group') {
          const ex = resolveSessionExercise(currentSession, input);
          const r = appendBlankGroupToHistoryExercise(currentSession, ex.id);
          if (!r.ok) throw new TxConflictError('invalid-input', r.message);
          nextSession = r.session;
          const appendedEx = nextSession.exercises.find((e) => e.id === ex.id)!;
          const newRound =
            appendedEx.groups[appendedEx.groups.length - 1]?.index ?? appendedEx.groups.length;
          const newSet =
            appendedEx.sets.find((s) => s.roundIndex === newRound && s.stageIndex === 1) ??
            appendedEx.sets[appendedEx.sets.length - 1];
          if (input.note !== undefined && input.note.length > 500) {
            throw new TxConflictError('invalid-input', '单组备注最多 500 个字符');
          }
          const wantsSetValues =
            input.reps !== undefined ||
            input.weightKg !== undefined ||
            input.status !== undefined ||
            input.note !== undefined;
          if (wantsSetValues && newSet) {
            const nextReps = input.reps !== undefined ? input.reps : null;
            const nextWeight = input.weightKg !== undefined ? input.weightKg : null;
            const nextStatus: SessionSet['status'] =
              input.status ?? (nextReps !== null ? 'done' : 'blank');
            assertCleanSetValues(appendedEx, newSet, nextReps, nextWeight, nextStatus, false);
            const cleanNote = input.note !== undefined ? input.note.trim() : undefined;
            nextSession = withSetAndPrefillFollowingWeight(nextSession, ex.id, newSet.id, {
              ...(input.reps !== undefined ? { reps: input.reps } : {}),
              ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
              ...(cleanNote ? { note: cleanNote } : {}),
              status: nextStatus,
            });
            const afterNew = nextSession.exercises
              .find((e) => e.id === ex.id)
              ?.sets.find((s) => s.id === newSet.id);
            if (nextStatus === 'done' && afterNew?.status !== 'done') {
              throw new TxConflictError('dirty-state', '历史已完成组必须保留有效次数');
            }
            summary = `为历史「${ex.name}」补录第 ${newRound} 组（${afterNew?.reps ?? '—'} 次${
              afterNew?.weightKg !== null && afterNew?.weightKg !== undefined
                ? ` × ${afterNew.weightKg}kg`
                : ''
            }）`;
          } else {
            summary = `为历史「${ex.name}」补录第 ${newRound} 空白组`;
          }
        } else if (input.action === 'remove_blank_group') {
          const ex = resolveSessionExercise(currentSession, input);
          const r = removeBlankGroupFromHistoryExercise(currentSession, ex.id, input.roundIndex);
          if (!r.ok) throw new TxConflictError('invalid-input', r.message);
          nextSession = r.session;
          summary = `移除历史「${ex.name}」第 ${input.roundIndex} 个空白组`;
        } else if (input.action === 'correct_cardio') {
          const cardioList = currentSession.cardio ?? [];
          const targetCardio =
            (input.cardioId ? cardioList.find((c) => c.id === input.cardioId) : undefined) ??
            (input.cardioName
              ? cardioList.find((c) =>
                  c.name.trim().toLowerCase().includes(input.cardioName!.trim().toLowerCase()),
                )
              : cardioList.length === 1
                ? cardioList[0]
                : undefined);
          if (!targetCardio) {
            throw new TxConflictError('not-found', '找不到要修正的历史有氧项目');
          }
          const durationSec =
            input.durationSec !== undefined
              ? Math.round(input.durationSec)
              : input.elapsedMs !== undefined
                ? Math.round(input.elapsedMs / 1000)
                : Math.round(targetCardio.elapsedMs / 1000);
          const r = correctHistoryCardioEntry(currentSession, targetCardio.id, {
            durationSec,
            ...(input.params !== undefined ? { params: input.params } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          });
          if (!r.ok) throw new TxConflictError('invalid-input', r.message);
          nextSession = r.session;
          summary = `修正历史有氧「${targetCardio.name}」为 ${Math.round(durationSec / 60)} 分钟`;
        } else {
          const ex = resolveSessionExercise(currentSession, input);
          const prevSet = resolveTargetSet(ex, input);
          if (input.note !== undefined && input.note.length > 500) {
            throw new TxConflictError('invalid-input', '单组备注最多 500 个字符');
          }
          const nextReps = input.reps !== undefined ? input.reps : prevSet.reps;
          const nextWeight = input.weightKg !== undefined ? input.weightKg : prevSet.weightKg;
          const nextStatus = input.status ?? (prevSet.status === 'blank' ? 'done' : prevSet.status);
          assertCleanSetValues(ex, prevSet, nextReps, nextWeight, nextStatus, input.weightKg === null);

          const cleanNote = input.note !== undefined ? input.note.trim() : undefined;
          nextSession = withSetAndPrefillFollowingWeight(currentSession, ex.id, prevSet.id, {
            ...(input.reps !== undefined ? { reps: input.reps } : {}),
            ...(input.weightKg !== undefined ? { weightKg: input.weightKg } : {}),
            ...(cleanNote !== undefined ? { note: cleanNote || undefined } : {}),
            status: nextStatus,
          });
          const afterSet = nextSession.exercises
            .find((e) => e.id === ex.id)
            ?.sets.find((s) => s.id === prevSet.id);
          if (nextStatus === 'done' && afterSet?.status !== 'done') {
            throw new TxConflictError('dirty-state', '历史已完成组必须保留有效次数');
          }
          summary = `纠正历史「${ex.name}」第 ${prevSet.roundIndex} 组为 ${afterSet?.reps ?? '—'} 次 × ${
            afterSet?.weightKg ?? '自重'
          }${afterSet?.weightKg !== null ? 'kg' : ''}${cleanNote ? ' · 已记备注' : ''}`;
        }

        const committed: Session = { ...nextSession, revision: curRev + 1 };
        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'correct_history_session',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: 'history',
          summary,
          entityType: 'session',
          entityId: committed.id,
          beforeRevision: curRev,
          afterRevision: curRev + 1,
          undoable: true,
          undone: false,
          touchedTargets: [
            {
              kind: 'history-edit',
              sessionId: currentSession.id,
              beforeSession: structuredClone(currentSession),
              afterSession: structuredClone(committed),
            },
          ],
        };
        return { nextSession: committed, opLog };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (txResult.session && !txResult.replayed) hooks?.onSessionCommitted?.(txResult.session);
  hooks?.onReceiptSaved?.(txResult.receipt);
  return { receipt: txResult.receipt, session: txResult.session, replayed: txResult.replayed };
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
    expectedEpoch?: number;
    draft: CoachPlanDraft;
    allowDuplicateName?: boolean;
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? 'coach-plan:' + args.draft.id;
  if (!args.draft.days.length || args.draft.days.every((d) => d.exercises.length === 0)) {
    throw new TxConflictError('invalid-input', '计划草稿至少需要 1 个动作才能创建');
  }

  const invalid = args.draft.days.some((day) =>
    day.exercises.some(
      (ex) =>
        !ex.name.trim() ||
        !Number.isInteger(ex.sets) ||
        ex.sets < 1 ||
        (ex.kind === 'straight' && (ex.repsMin < 1 || ex.repsMax < ex.repsMin)) ||
        (ex.kind === 'dropSet' &&
          ex.stages?.some((stage) => !stage.label.trim() || stage.repsMin < 1 || stage.repsMax < stage.repsMin)),
    ),
  );
  if (invalid || !args.draft.planName.trim()) {
    throw new TxConflictError('invalid-input', '请补齐计划名称、动作和有效组次');
  }
  const candidate = buildPlanFromDraft(args.draft);
  const check = validateDataDeep({ plans: [candidate], sessions: [] });
  if (!check.ok) {
    throw new TxConflictError('invalid-input', `计划结构不合法：${check.issues[0]?.message ?? '请检查输入'}`);
  }
  const validatedCandidate = check.value.plans[0];
  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'create_plan_from_draft',
      argsForDigest: {
        draft: args.draft,
        allowDuplicateName: Boolean(args.allowDuplicateName),
      },
      expectedEpoch: args.expectedEpoch,
      stores: ['plans'],
      planId: validatedCandidate.id,
      needAllPlans: true,
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, allPlans }) => {
        const plans = allPlans ?? [];
        if (plans.some((p) => p.id === validatedCandidate.id)) {
          throw new TxConflictError('state-conflict', '该计划 ID 已存在，请更换草稿或重试');
        }
        if (plans.length >= MAX_PLANS) {
          throw new TxConflictError(
            'dirty-state',
            `计划数量已达 ${MAX_PLANS} 上限，请先删除不用的计划后再创建`,
          );
        }
        const name = validatedCandidate.name.trim();
        if (plans.some((p) => p.name.trim() === name) && !args.allowDuplicateName) {
          throw new TxConflictError(
            'state-conflict',
            `已经有一个同名计划「${name}」。如需创建同名新计划请确认 allowDuplicateName。`,
          );
        }

        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'create_plan_from_draft',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: 'plan',
          summary: `新建训练计划「${validatedCandidate.name}」（${validatedCandidate.days.length} 个训练日）`,
          entityType: 'plan',
          entityId: validatedCandidate.id,
          planId: validatedCandidate.id,
          beforeRevision: 0,
          afterRevision: 1,
          beforePlanRevision: 0,
          afterPlanRevision: validatedCandidate.updatedAt,
          undoable: true,
          undone: false,
          touchedTargets: [{ kind: 'plan-created', planId: validatedCandidate.id }],
        };
        return { insertPlan: validatedCandidate, opLog };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (txResult.plan && !txResult.replayed) hooks?.onPlanCommitted?.(txResult.plan);
  hooks?.onReceiptSaved?.(txResult.receipt);
  return { receipt: txResult.receipt, plan: txResult.plan, replayed: txResult.replayed };
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
  | { kind: 'rename_day'; dayId?: string; dayName?: string; name: string }
  | {
      kind: 'add_exercise';
      dayId?: string;
      dayName?: string;
      name: string;
      target?: ExerciseTarget;
      form?: TrainingForm;
      sets?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
      setupNote?: string;
    }
  | { kind: 'remove_exercise'; dayId?: string; dayName?: string; exId?: string; exerciseName?: string }
  | {
      kind: 'replace_exercise';
      dayId?: string;
      dayName?: string;
      exId?: string;
      exerciseName?: string;
      newName: string;
      keepIdentity?: boolean;
      form?: TrainingForm;
      sets?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
    }
  | {
      kind: 'update_target';
      dayId?: string;
      dayName?: string;
      exId?: string;
      exerciseName?: string;
      patch?: Partial<ExerciseTarget>;
      form?: TrainingForm;
      sets?: number;
      setsMax?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      toFailure?: boolean;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
    }
  | { kind: 'pair_superset'; dayId?: string; dayName?: string; exIds: string[] }
  | { kind: 'unpair_superset'; dayId?: string; dayName?: string; exIds: string[] }
  | {
      kind: 'add_warmup';
      dayId?: string;
      dayName?: string;
      name: string;
      unit?: 'reps' | 'time' | 'breath';
      targetText?: string;
    }
  | {
      kind: 'update_warmup';
      dayId?: string;
      dayName?: string;
      warmupId?: string;
      warmupName?: string;
      name?: string;
      unit?: 'reps' | 'time' | 'breath';
      targetText?: string;
    }
  | { kind: 'remove_warmup'; dayId?: string; dayName?: string; warmupId?: string; warmupName?: string }
  | {
      kind: 'add_cardio';
      dayId?: string;
      dayName?: string;
      preset: CardioPreset;
      name?: string;
      params?: CardioParams;
      note?: string;
    }
  | {
      kind: 'update_cardio';
      dayId?: string;
      dayName?: string;
      cardioId?: string;
      cardioName?: string;
      name?: string;
      params?: Partial<CardioParams>;
      note?: string;
    }
  | { kind: 'remove_cardio'; dayId?: string; dayName?: string; cardioId?: string; cardioName?: string };

function resolvePlanDay(plan: Plan, selector: { dayId?: string; dayName?: string }): PlanDay {
  if (selector.dayId) {
    const exact = plan.days.find((d) => d.id === selector.dayId);
    if (!exact) throw new TxConflictError('not-found', '找不到目标训练日');
    return exact;
  }
  const needle = (selector.dayName ?? '').trim().toLowerCase();
  if (needle) {
    const exact = plan.days.filter((d) => d.name.trim().toLowerCase() === needle);
    if (exact.length === 1) return exact[0];
    const fuzzy = plan.days.filter((d) => d.name.trim().toLowerCase().includes(needle));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1 || exact.length > 1) {
      throw new TxConflictError('invalid-input', `找到多个匹配「${selector.dayName}」的训练日，请指定具体训练日`);
    }
  }
  if (plan.days.length === 1) return plan.days[0];
  throw new TxConflictError('not-found', '请明确指定要修改的训练日');
}

function resolvePlanExercise(
  day: PlanDay,
  selector: { exId?: string; exerciseName?: string },
): PlanExercise {
  if (selector.exId) {
    const exact = day.exercises.find((e) => e.id === selector.exId);
    if (!exact) throw new TxConflictError('not-found', '找不到目标计划动作');
    return exact;
  }
  const needle = (selector.exerciseName ?? '').trim().toLowerCase();
  if (!needle) throw new TxConflictError('invalid-input', '未指定要修改的计划动作');
  const exact = day.exercises.filter((e) => e.name.trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const fuzzy = day.exercises.filter((e) => e.name.trim().toLowerCase().includes(needle));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1 || exact.length > 1) {
    throw new TxConflictError('invalid-input', `训练日「${day.name}」中有多个匹配「${selector.exerciseName}」的动作`);
  }
  throw new TxConflictError('not-found', `训练日「${day.name}」里没有「${selector.exerciseName}」`);
}

export async function coachModifyExistingPlan(
  args: {
    operationId?: string;
    planId: string;
    expectedUpdatedAt?: number;
    modelExpectedUpdatedAt?: number;
    expectedEpoch?: number;
    priorBatchOpIds?: string[];
    action: ModifyPlanAction;
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? makeOpId('mod-plan');
  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'modify_existing_plan',
      argsForDigest: args,
      expectedEpoch: args.expectedEpoch,
      priorBatchOpIds: args.priorBatchOpIds,
      stores: ['plans'],
      planId: args.planId,
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentPlan, priorOpLogs }) => {
        if (!currentPlan) {
          throw new TxConflictError('not-found', '找不到要修改的计划');
        }
        const expectedPlanRev =
          args.expectedUpdatedAt !== undefined
            ? advanceRevisionFromPriorOps(
                args.expectedUpdatedAt,
                'plan',
                currentPlan.id,
                currentEpoch,
                priorOpLogs,
              )
            : undefined;
        if (expectedPlanRev !== undefined) {
          if (currentPlan.updatedAt !== expectedPlanRev) {
            throw new TxConflictError(
              'version-conflict',
              '目标计划已在别处被修改，已拒绝对计划的过期覆盖',
              currentPlan.updatedAt,
            );
          }
          if (
            args.modelExpectedUpdatedAt !== undefined &&
            (args.modelExpectedUpdatedAt < args.expectedUpdatedAt! ||
              args.modelExpectedUpdatedAt > expectedPlanRev)
          ) {
            throw new TxConflictError(
              'version-conflict',
              '目标计划当前版本与模型指定的期望版本不一致，已拒绝覆盖',
              currentPlan.updatedAt,
            );
          }
        } else if (args.modelExpectedUpdatedAt !== undefined) {
          const selfModelPlanRev = advanceRevisionFromPriorOps(
            args.modelExpectedUpdatedAt,
            'plan',
            currentPlan.id,
            currentEpoch,
            priorOpLogs,
          );
          if (currentPlan.updatedAt !== selfModelPlanRev) {
            throw new TxConflictError(
              'version-conflict',
              '目标计划已在别处被修改，已拒绝对计划的过期覆盖',
              currentPlan.updatedAt,
            );
          }
        }
        const beforePlan = structuredClone(currentPlan);
        const current = structuredClone(currentPlan);
        let summary = '';
        const nextRaw: Plan = (() => {
      const act = args.action;
      if (act.kind === 'rename_plan') {
        summary = `重命名计划为「${act.name.trim()}」`;
        return renamePlan(current, act.name);
      }
      if (act.kind === 'rename_day') {
        const day = resolvePlanDay(current, act);
        summary = `重命名训练日为「${act.name.trim()}」`;
        return renameDay(current, day.id, act.name);
      }
      if (act.kind === 'add_exercise') {
        const day = resolvePlanDay(current, act);
        const built = act.target
          ? { target: ensureStageIds(act.target), restSec: act.restSec ?? 120 }
          : buildExerciseTargetFromInput(act.name, act);
        const res = addExercise(current, day.id, act.name, built.target);
        if (!res.added) {
          throw new TxConflictError(
            res.reason === 'capacity' ? 'dirty-state' : 'not-found',
            res.reason === 'capacity' ? '该训练日动作数量已达上限' : '找不到目标训练日',
          );
        }
        const addedDay = res.plan.days.find((d) => d.id === day.id)!;
        const addedEx = addedDay.exercises[addedDay.exercises.length - 1];
        let nextPlan = res.plan;
        if (addedEx) {
          const setup = parseSetupNote(act.setupNote);
          if (!setup.ok) throw new TxConflictError('invalid-input', setup.message);
          nextPlan = updateExercise(nextPlan, day.id, addedEx.id, {
            exerciseId: exerciseIdFromName(act.name),
            restSec: built.restSec,
            ...(setup.note ? { setupNote: setup.note } : {}),
          });
        }
        summary = `在「${day.name}」新增动作「${act.name.trim()}」（${summarizeTargetLabel(built.target, built.restSec)}）`;
        return nextPlan;
      }
      if (act.kind === 'remove_exercise') {
        const targetDay = resolvePlanDay(current, act);
        const targetEx = resolvePlanExercise(targetDay, act);
        summary = `从「${targetDay.name}」移除动作「${targetEx.name}」`;
        return removeExercise(current, targetDay.id, targetEx.id);
      }
      if (act.kind === 'replace_exercise') {
        const targetDay = resolvePlanDay(current, act);
        const targetEx = resolvePlanExercise(targetDay, act);
        const cleanNew = act.newName.trim();
        if (!cleanNew) throw new TxConflictError('invalid-input', '替换后的动作名称不能为空');
        const hasTargetOverride =
          act.form !== undefined ||
          act.sets !== undefined ||
          act.repsMin !== undefined ||
          act.repsMax !== undefined ||
          act.suggestedWeightKg !== undefined ||
          act.stages !== undefined ||
          act.restSec !== undefined ||
          act.restInSec !== undefined ||
          act.restAfterSec !== undefined;
        const built = hasTargetOverride
          ? buildExerciseTargetFromInput(cleanNew, act, act.keepIdentity ? targetEx.target : undefined, targetEx.restSec)
          : { target: ensureStageIds(structuredClone(targetEx.target)), restSec: targetEx.restSec };
        let nextPlan = renameExercise(current, targetDay.id, targetEx.id, cleanNew, {
          keepIdentity: Boolean(act.keepIdentity),
        });
        nextPlan = updateExercise(nextPlan, targetDay.id, targetEx.id, {
          ...(act.keepIdentity ? {} : { exerciseId: exerciseIdFromName(cleanNew) }),
          target: built.target,
          restSec: built.restSec,
        });
        summary = `将「${targetDay.name}」中的「${targetEx.name}」替换为「${cleanNew}」`;
        return nextPlan;
      }
      if (act.kind === 'update_target') {
        const targetDay = resolvePlanDay(current, act);
        const targetEx = resolvePlanExercise(targetDay, act);
        const usesSpec =
          act.form !== undefined ||
          act.stages !== undefined ||
          act.sets !== undefined ||
          act.setsMax !== undefined ||
          act.repsMin !== undefined ||
          act.repsMax !== undefined ||
          act.suggestedWeightKg !== undefined ||
          act.weightMode !== undefined ||
          act.dumbbellBasis !== undefined ||
          act.toFailure !== undefined ||
          act.restInSec !== undefined ||
          act.restAfterSec !== undefined ||
          !act.patch;
        if (usesSpec) {
          const built = buildExerciseTargetFromInput(targetEx.name, act, targetEx.target, targetEx.restSec);
          const updated = updateExercise(current, targetDay.id, targetEx.id, {
            target: built.target,
            restSec: built.restSec,
          });
          summary = `修改计划动作「${targetEx.name}」：${summarizeTargetLabel(built.target, built.restSec)}`;
          return updated;
        }
        let updated = updateTarget(current, targetDay.id, targetEx.id, act.patch!);
        if (act.restSec !== undefined) {
          updated = updateExercise(updated, targetDay.id, targetEx.id, { restSec: act.restSec });
        }
        summary = `修改计划动作「${targetEx.name}」目标参数`;
        return updated;
      }
      if (act.kind === 'pair_superset') {
        const day = resolvePlanDay(current, act);
        const paired = pairExercisesAsSuperset(day.exercises, act.exIds);
        if (!paired.ok) throw new TxConflictError('invalid-input', paired.message);
        summary = `将计划训练日「${day.name}」内动作配对为超级组`;
        return {
          ...current,
          days: current.days.map((d) => (d.id === day.id ? { ...d, exercises: paired.exercises } : d)),
        };
      }
      if (act.kind === 'unpair_superset') {
        const day = resolvePlanDay(current, act);
        summary = `解除计划训练日「${day.name}」内指定超级组配对`;
        return {
          ...current,
          days: current.days.map((d) =>
            d.id === day.id
              ? { ...d, exercises: unpairSupersetExercises(d.exercises, { exerciseIds: act.exIds }) }
              : d,
          ),
        };
      }
      if (act.kind === 'add_warmup') {
        const day = resolvePlanDay(current, act);
        if (day.warmups.length >= MAX_EXERCISES) {
          throw new TxConflictError('dirty-state', `热身项数已达 ${MAX_EXERCISES} 上限`);
        }
        const added = addWarmup(current, day.id, act.name);
        const updatedDay = added.days.find((d) => d.id === day.id)!;
        const newest = updatedDay.warmups[updatedDay.warmups.length - 1];
        const nextPlan: Plan = {
          ...added,
          days: added.days.map((d) =>
            d.id !== day.id
              ? d
              : {
                  ...d,
                  warmups: d.warmups.map((w) =>
                    w.id === newest.id
                      ? {
                          ...w,
                          ...(act.unit ? { unit: act.unit } : {}),
                          ...(act.targetText !== undefined ? { targetText: act.targetText.trim() || w.targetText } : {}),
                        }
                      : w,
                  ),
                },
          ),
        };
        summary = `在「${day.name}」新增热身「${act.name.trim()}」`;
        return nextPlan;
      }
      if (act.kind === 'update_warmup') {
        const day = resolvePlanDay(current, act);
        const wNeedle = (act.warmupName ?? '').trim().toLowerCase();
        const w =
          (act.warmupId ? day.warmups.find((x) => x.id === act.warmupId) : undefined) ??
          (wNeedle ? day.warmups.find((x) => x.name.trim().toLowerCase().includes(wNeedle)) : undefined);
        if (!w) throw new TxConflictError('not-found', '找不到要修改的热身项');
        let nextPlan = act.targetText !== undefined ? updateWarmup(current, day.id, w.id, act.targetText) : current;
        if (act.name !== undefined || act.unit !== undefined) {
          nextPlan = {
            ...nextPlan,
            days: nextPlan.days.map((d) =>
              d.id !== day.id
                ? d
                : {
                    ...d,
                    warmups: d.warmups.map((item) =>
                      item.id === w.id
                        ? {
                            ...item,
                            ...(act.name?.trim() ? { name: act.name.trim() } : {}),
                            ...(act.unit ? { unit: act.unit } : {}),
                          }
                        : item,
                    ),
                  },
            ),
          };
        }
        summary = `修改「${day.name}」热身「${w.name}」`;
        return nextPlan;
      }
      if (act.kind === 'remove_warmup') {
        const day = resolvePlanDay(current, act);
        const wNeedle = (act.warmupName ?? '').trim().toLowerCase();
        const w =
          (act.warmupId ? day.warmups.find((x) => x.id === act.warmupId) : undefined) ??
          (wNeedle ? day.warmups.find((x) => x.name.trim().toLowerCase().includes(wNeedle)) : undefined);
        if (!w) throw new TxConflictError('not-found', '找不到要删除的热身项');
        summary = `移除「${day.name}」热身「${w.name}」`;
        return removeWarmup(current, day.id, w.id);
      }
      if (act.kind === 'add_cardio') {
        const day = resolvePlanDay(current, act);
        if (day.kind !== 'cardio') {
          throw new TxConflictError('state-conflict', `「${day.name}」不是有氧日，无法添加计划内有氧目标`);
        }
        const list = day.cardio ?? [];
        if (list.length >= MAX_CARDIO_ENTRIES) {
          throw new TxConflictError('dirty-state', `单日有氧项目已达 ${MAX_CARDIO_ENTRIES} 项上限`);
        }
        const defaultParams =
          CARDIO_PRESET_CHOICES.find((c) => c.preset === act.preset)?.params ?? {};
        const normalized = normalizeCardioParams(act.preset, {
          ...defaultParams,
          ...(act.params ?? {}),
        });
        const issues = validateCardioParams(act.preset, normalized);
        if (issues.length) throw new TxConflictError('invalid-input', issues[0].message);
        const item: PlanCardio = {
          id: newId('pcardio'),
          preset: act.preset,
          name: (act.name ?? CARDIO_PRESET_LABEL[act.preset]).trim() || CARDIO_PRESET_LABEL[act.preset],
          target: normalized,
          ...(act.note?.trim() ? { note: act.note.trim() } : {}),
        };
        summary = `在有氧日「${day.name}」添加「${item.name}」`;
        return {
          ...current,
          days: current.days.map((d) => (d.id === day.id ? { ...d, cardio: [...list, item] } : d)),
        };
      }
      if (act.kind === 'update_cardio') {
        const day = resolvePlanDay(current, act);
        if (day.kind !== 'cardio') {
          throw new TxConflictError('state-conflict', `「${day.name}」不是有氧日`);
        }
        const list = day.cardio ?? [];
        const needle = (act.cardioName ?? '').trim().toLowerCase();
        const target =
          (act.cardioId ? list.find((c) => c.id === act.cardioId) : undefined) ??
          (needle ? list.find((c) => c.name.trim().toLowerCase().includes(needle)) : list.length === 1 ? list[0] : undefined);
        if (!target) throw new TxConflictError('not-found', '找不到要修改的计划有氧项');
        const nextParams = act.params
          ? normalizeCardioParams(target.preset, { ...target.target, ...act.params })
          : target.target;
        const issues = validateCardioParams(target.preset, nextParams);
        if (issues.length) throw new TxConflictError('invalid-input', issues[0].message);
        summary = `修改有氧日「${day.name}」中的「${target.name}」`;
        return {
          ...current,
          days: current.days.map((d) =>
            d.id !== day.id
              ? d
              : {
                  ...d,
                  cardio: list.map((c) =>
                    c.id === target.id
                      ? {
                          ...c,
                          ...(act.name?.trim() ? { name: act.name.trim() } : {}),
                          target: nextParams,
                          ...(act.note !== undefined ? (act.note.trim() ? { note: act.note.trim() } : { note: undefined }) : {}),
                        }
                      : c,
                  ),
                },
          ),
        };
      }
      // remove_cardio
      const day = resolvePlanDay(current, act);
      const list = day.cardio ?? [];
      const needle = (act.cardioName ?? '').trim().toLowerCase();
      const target =
        (act.cardioId ? list.find((c) => c.id === act.cardioId) : undefined) ??
        (needle ? list.find((c) => c.name.trim().toLowerCase().includes(needle)) : undefined);
      if (!target) throw new TxConflictError('not-found', '找不到要移除的计划有氧项');
      summary = `从「${day.name}」移除有氧「${target.name}」`;
      return {
        ...current,
        days: current.days.map((d) =>
          d.id === day.id ? { ...d, cardio: list.filter((c) => c.id !== target.id) } : d,
        ),
      };
        })();

        const candidatePlan: Plan = {
          ...nextRaw,
          days: nextRaw.days.map((d) => ({ ...d, exercises: cleanOrphanPairIds(d.exercises) })),
          updatedAt: Math.max(now, currentPlan.updatedAt + 1),
        };
        const valid = validateDataDeep({ plans: [candidatePlan], sessions: [] });
        if (!valid.ok) {
          throw new TxConflictError('invalid-input', `计划校验失败：${valid.issues[0]?.message ?? ''}`);
        }
        const afterPlan = valid.value.plans[0];
        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'modify_existing_plan',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: 'plan',
          summary,
          entityType: 'plan',
          entityId: afterPlan.id,
          planId: afterPlan.id,
          beforeRevision: 1,
          afterRevision: 1,
          beforePlanRevision: beforePlan.updatedAt,
          afterPlanRevision: afterPlan.updatedAt,
          undoable: true,
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
        return { nextPlan: afterPlan, opLog };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (txResult.plan && !txResult.replayed) hooks?.onPlanCommitted?.(txResult.plan);
  hooks?.onReceiptSaved?.(txResult.receipt);
  return { receipt: txResult.receipt, plan: txResult.plan, replayed: txResult.replayed };
}

/* ── 工具 7：完训 / 编排同步回原计划（显式区分仅改本次会话 vs 同步原计划） ── */

export async function coachSyncSessionToPlan(
  args: {
    operationId?: string;
    sessionId: string;
    scope: 'session-only' | 'sync-to-plan';
    expectedPlanUpdatedAt?: number;
    modelExpectedPlanUpdatedAt?: number;
    expectedSessionRevision?: number;
    modelExpectedRevision?: number;
    expectedEpoch?: number;
    priorBatchOpIds?: string[];
    strictSessionRevision?: boolean;
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
  const preSession = await getSession(args.sessionId);
  if (!preSession) {
    throw new TxConflictError('not-found', '找不到目标训练记录');
  }

  if (args.scope === 'session-only') {
    if (args.alsoFinishSession && preSession.status === 'active') {
      const fin = await coachFinishActiveSession(
        {
          operationId,
          sessionId: args.sessionId,
          expectedRevision: args.expectedSessionRevision,
          modelExpectedRevision: args.modelExpectedRevision,
          expectedEpoch: args.expectedEpoch,
          priorBatchOpIds: args.priorBatchOpIds,
          strictSessionRevision: true,
          syncBackToPlanDay: false,
          advanceCycle: args.advanceCycle,
        },
        hooks,
      );
      return {
        scope: 'session-only',
        synced: false,
        message: fin.receipt.summary,
        receipt: fin.receipt,
        session: fin.session,
      };
    }
    const preRev = revisionOf(preSession);
    if (args.expectedSessionRevision !== undefined && preRev !== args.expectedSessionRevision) {
      throw new TxConflictError('version-conflict', `训练版本已变更为 r${preRev}`, preRev);
    }
    if (
      args.modelExpectedRevision !== undefined &&
      preRev !== args.modelExpectedRevision
    ) {
      throw new TxConflictError('version-conflict', `训练版本已变更为 r${preRev}`, preRev);
    }
    return {
      scope: 'session-only',
      synced: false,
      message: '已确认仅保留本次训练内的临时编排，原训练计划模板未作任何修改。',
      session: preSession,
    };
  }

  if (args.alsoFinishSession && preSession.status === 'active') {
    const fin = await coachFinishActiveSession(
      {
        operationId,
        sessionId: args.sessionId,
        expectedRevision: args.expectedSessionRevision,
        modelExpectedRevision: args.modelExpectedRevision,
        expectedEpoch: args.expectedEpoch,
        priorBatchOpIds: args.priorBatchOpIds,
        strictSessionRevision: true,
        syncBackToPlanDay: true,
        advanceCycle: args.advanceCycle,
      },
      hooks,
    );
    return {
      scope: 'sync-to-plan',
      synced: true,
      message: fin.receipt.summary,
      receipt: fin.receipt,
      plan: fin.plan,
      session: fin.session,
    };
  }

  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);
  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'sync_session_to_plan',
      argsForDigest: args,
      expectedEpoch: args.expectedEpoch,
      priorBatchOpIds: args.priorBatchOpIds,
      stores: ['plans', 'sessions'],
      sessionId: args.sessionId,
      planId: preSession.planId,
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentSession, currentPlan, priorOpLogs }) => {
        if (!currentSession) {
          throw new TxConflictError('not-found', '找不到目标训练记录');
        }
        const sessRev = revisionOf(currentSession);
        assertSessionVersionOrPrecondition({
          currentSession,
          expectedRevision: args.expectedSessionRevision,
          modelExpectedRevision: args.modelExpectedRevision,
          currentEpoch,
          priorOpLogs,
          strictSessionRevision: true,
          entityLabel: '训练记录',
        });
        if (!currentPlan) {
          throw new TxConflictError('not-found', '找不到原训练计划');
        }
        const expectedPlanRev =
          args.expectedPlanUpdatedAt !== undefined
            ? advanceRevisionFromPriorOps(
                args.expectedPlanUpdatedAt,
                'plan',
                currentPlan.id,
                currentEpoch,
                priorOpLogs,
              )
            : undefined;
        if (expectedPlanRev !== undefined) {
          if (currentPlan.updatedAt !== expectedPlanRev) {
            throw new TxConflictError(
              'version-conflict',
              '原训练计划已被更新，请刷新后再同步',
              currentPlan.updatedAt,
            );
          }
          if (
            args.modelExpectedPlanUpdatedAt !== undefined &&
            (args.modelExpectedPlanUpdatedAt < args.expectedPlanUpdatedAt! ||
              args.modelExpectedPlanUpdatedAt > expectedPlanRev)
          ) {
            throw new TxConflictError(
              'version-conflict',
              '原训练计划当前版本与模型指定期望版本不一致，请刷新后再同步',
              currentPlan.updatedAt,
            );
          }
        } else if (args.modelExpectedPlanUpdatedAt !== undefined) {
          const selfModelPlanRev = advanceRevisionFromPriorOps(
            args.modelExpectedPlanUpdatedAt,
            'plan',
            currentPlan.id,
            currentEpoch,
            priorOpLogs,
          );
          if (currentPlan.updatedAt !== selfModelPlanRev) {
            throw new TxConflictError(
              'version-conflict',
              '原训练计划已被更新，请刷新后再同步',
              currentPlan.updatedAt,
            );
          }
        }
        const beforePlan = structuredClone(currentPlan);
        const diff = diffSessionVsPlanDay(currentSession, currentPlan);
        if (!diff.canSync) {
          if (diff.planUpdatedDuringSession) {
            throw new TxConflictError(
              'version-conflict',
              diff.blockerMessage ?? '原计划在训练开始后也被独立修改，请先核对后再手动调整计划',
              currentPlan.updatedAt,
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
          structuredClone(currentPlan),
          currentSession.day.dayId,
          currentSession,
        );
        if (!syncResult.ok) {
          throw new TxConflictError('state-conflict', syncResult.message);
        }
        const diffMessage = `已将「${diff.dayName}」编排同步回原计划（${diff.summaryText}）`;
        const candidatePlan: Plan = {
          ...syncResult.plan,
          days: syncResult.plan.days.map((d) => ({ ...d, exercises: cleanOrphanPairIds(d.exercises) })),
          updatedAt: Math.max(now, currentPlan.updatedAt + 1),
        };
        const valid = validateDataDeep({ plans: [candidatePlan], sessions: [] });
        if (!valid.ok) {
          throw new TxConflictError('invalid-input', `计划校验失败：${valid.issues[0]?.message ?? ''}`);
        }
        const afterPlan = valid.value.plans[0];
        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'sync_session_to_plan',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: 'plan',
          summary: diffMessage,
          entityType: 'plan',
          entityId: afterPlan.id,
          planId: afterPlan.id,
          beforeRevision: sessRev,
          afterRevision: sessRev,
          beforePlanRevision: beforePlan.updatedAt,
          afterPlanRevision: afterPlan.updatedAt,
          undoable: true,
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
        return { nextPlan: afterPlan, opLog };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (txResult.plan && !txResult.replayed) hooks?.onPlanCommitted?.(txResult.plan);
  hooks?.onReceiptSaved?.(txResult.receipt);
  return {
    scope: 'sync-to-plan',
    synced: true,
    message: txResult.receipt.summary,
    receipt: txResult.receipt,
    plan: txResult.plan,
    session: txResult.session,
  };
}

/* ── 工具 8：进行中动作管理（替换/新增/移除/切训练形式/跳过） ── */

export type ManageActiveExerciseInput =
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
      mode: 'replace';
      exId?: string;
      exerciseName?: string;
      newName: string;
      form?: TrainingForm;
      sets?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
      setupNote?: string;
      allowDiscardLoggedData?: boolean;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
      mode: 'add';
      newName: string;
      insertAfterExId?: string;
      form?: TrainingForm;
      sets?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
      setupNote?: string;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
      mode: 'remove' | 'skip_remaining' | 'unskip';
      exId?: string;
      exerciseName?: string;
      allowDiscardLoggedData?: boolean;
    }
  | {
      operationId?: string;
      sessionId: string;
      expectedRevision?: number;
      expectedEpoch?: number;
      deferTimerDispatch?: boolean;
      mode: 'convert_form';
      exId?: string;
      exerciseName?: string;
      form: TrainingForm;
      sets?: number;
      repsMin?: number;
      repsMax?: number;
      suggestedWeightKg?: number | null;
      weightMode?: WeightMode;
      dumbbellBasis?: DumbbellBasis;
      restSec?: number;
      restInSec?: number;
      restAfterSec?: number;
      stages?: CoachTargetStageInput[];
      allowDiscardLoggedData?: boolean;
    };

function buildBlankSetsFromTarget(target: ExerciseTarget): SessionSet[] {
  const groups = groupsFromTarget(target);
  const sets: SessionSet[] = [];
  for (const g of groups) {
    for (let si = 1; si <= g.stageCount; si += 1) {
      const stage = target.kind === 'dropSet' ? target.stages[si - 1] : undefined;
      sets.push({
        id: newId('set'),
        roundIndex: g.index,
        stageIndex: si,
        ...(stage?.id ? { stageId: stage.id } : {}),
        reps: null,
        weightKg: null,
        status: 'blank',
        ...(target.kind === 'straight' ? (target.toFailure ? { toFailure: true } : {}) : stage?.toFailure ? { toFailure: true } : {}),
      });
    }
  }
  return sets;
}

export async function coachManageActiveExercise(
  input: ManageActiveExerciseInput & CoachTxPreconditionArgs,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('manage-ex');
  const nextNameRaw = input.mode === 'replace' || input.mode === 'add' ? input.newName.trim() : '';
  if ((input.mode === 'replace' || input.mode === 'add') && !nextNameRaw) {
    throw new TxConflictError('invalid-input', '请提供新动作的名称');
  }
  const newExerciseId = nextNameRaw ? exerciseIdFromName(nextNameRaw) : '';
  const newTemplate = newExerciseId ? await getExerciseTemplate(newExerciseId) : undefined;

  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'manage_active_exercise',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      deferTimerDispatch: input.deferTimerDispatch,
      argsForDigest: input,
      compute: (current) => {
        const beforeSnapshot = structuredClone(current);

        if (input.mode === 'replace') {
          const old = resolveSessionExercise(current, input);
          const focus = checkFocusConflict({ sessionId: current.id, exId: old.id });
          if (focus.conflict) {
            throw new TxConflictError('focus-conflict', focus.message ?? '原动作输入框正在编辑中');
          }
          const prot = exerciseRemovalProtection(old);
          if (prot.protected && !input.allowDiscardLoggedData) {
            throw new TxConflictError(
              'dirty-state',
              `「${old.name}」${prot.reasons.join('、')}，为避免误丢已练数据，已停止直接替换；若确认丢弃并替换请明确说明，或让我新增一个动作。`,
            );
          }
          const hasExplicitSpec =
            input.form !== undefined ||
            input.sets !== undefined ||
            input.repsMin !== undefined ||
            input.repsMax !== undefined ||
            input.suggestedWeightKg !== undefined ||
            input.weightMode !== undefined ||
            input.dumbbellBasis !== undefined ||
            input.restSec !== undefined ||
            input.restInSec !== undefined ||
            input.restAfterSec !== undefined ||
            Boolean(input.stages?.length);
          const built = buildExerciseTargetFromInput(
            nextNameRaw,
            input,
            hasExplicitSpec ? undefined : newTemplate?.target,
            newTemplate?.restSec ?? old.restSec ?? 120,
          );
          const setupParsed = parseSetupNote(input.setupNote);
          if (!setupParsed.ok) throw new TxConflictError('invalid-input', setupParsed.message);
          const resolvedSetup = setupParsed.note ?? setupNoteFor({}, newTemplate);
          const replacement: SessionExercise = {
            id: newId('sex'),
            exerciseId: newExerciseId,
            planExerciseId: null,
            replacedFrom: old.name,
            name: nextNameRaw,
            restSec: built.restSec,
            target: built.target,
            status: 'pending',
            groups: groupsFromTarget(built.target),
            sets: buildBlankSetsFromTarget(built.target),
            note: '',
            ...(resolvedSetup ? { setupNote: resolvedSetup } : {}),
          };
          const exercises = cleanOrphanPairIds(
            current.exercises.map((e) => (e.id === old.id ? replacement : e)),
          );
          const nextSession: Session = { ...current, exercises };
          return {
            nextSession,
            summary: `将「${old.name}」替换为「${nextNameRaw}」（${summarizeTargetLabel(built.target, built.restSec)}）`,
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        if (input.mode === 'add') {
          if (current.exercises.length >= MAX_EXERCISES) {
            throw new TxConflictError('dirty-state', `单次训练最多 ${MAX_EXERCISES} 个动作，无法继续添加`);
          }
          const built = buildExerciseTargetFromInput(
            nextNameRaw,
            input,
            newTemplate?.target,
            newTemplate?.restSec ?? 120,
          );
          const setupParsed = parseSetupNote(input.setupNote);
          if (!setupParsed.ok) throw new TxConflictError('invalid-input', setupParsed.message);
          const resolvedSetup = setupParsed.note ?? setupNoteFor({}, newTemplate);
          const addedEx: SessionExercise = {
            id: newId('sex'),
            exerciseId: newExerciseId,
            planExerciseId: null,
            name: nextNameRaw,
            restSec: built.restSec,
            target: built.target,
            status: 'pending',
            groups: groupsFromTarget(built.target),
            sets: buildBlankSetsFromTarget(built.target),
            note: '',
            added: true,
            ...(resolvedSetup ? { setupNote: resolvedSetup } : {}),
          };
          const nextExercises = [...current.exercises];
          const insertIdx = input.insertAfterExId
            ? nextExercises.findIndex((e) => e.id === input.insertAfterExId)
            : -1;
          if (insertIdx >= 0) nextExercises.splice(insertIdx + 1, 0, addedEx);
          else nextExercises.push(addedEx);
          const nextSession: Session = { ...current, exercises: nextExercises };
          return {
            nextSession,
            summary: `新增动作「${nextNameRaw}」（${summarizeTargetLabel(built.target, built.restSec)}）`,
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        if (input.mode === 'remove') {
          const ex = resolveSessionExercise(current, input);
          const focus = checkFocusConflict({ sessionId: current.id, exId: ex.id });
          if (focus.conflict) {
            throw new TxConflictError('focus-conflict', focus.message ?? '目标动作输入框正在编辑中');
          }
          const prot = exerciseRemovalProtection(ex);
          if (prot.protected && !input.allowDiscardLoggedData) {
            throw new TxConflictError(
              'dirty-state',
              `「${ex.name}」${prot.reasons.join('、')}，确认要移除并丢弃已记录内容后再操作`,
            );
          }
          const rem = removeExerciseFromSession(current, ex.id);
          const nextSession: Session = {
            ...rem.session,
            exercises: cleanOrphanPairIds(rem.session.exercises),
          };
          return {
            nextSession,
            summary: `移除本次训练中的「${ex.name}」`,
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        if (input.mode === 'convert_form') {
          const ex = resolveSessionExercise(current, input);
          const focus = checkFocusConflict({ sessionId: current.id, exId: ex.id, fields: ['target'] });
          if (focus.conflict) {
            throw new TxConflictError('focus-conflict', focus.message ?? '目标字段正在编辑中');
          }
          const beforeForm = trainingFormOf(ex.target);
          const built = buildExerciseTargetFromInput(ex.name, input, ex.target, ex.restSec);
          const impact = planTargetApply(ex, built.target);
          if (impact.removedWithData.length > 0 && !input.allowDiscardLoggedData) {
            throw new TxConflictError(
              'dirty-state',
              `转换形式会移除 ${impact.removedWithData.length} 条已录入实绩，请先确认允许覆盖或保留原记录`,
            );
          }
          const applied = applyTargetToSessionExercise(current, ex.id, built.target, { confirmImpact: true });
          if (!applied.applied) {
            throw new TxConflictError('dirty-state', applied.message);
          }
          const nextSession = withExercise(applied.session, ex.id, { restSec: built.restSec });
          return {
            nextSession,
            summary: `将「${ex.name}」从${trainingFormLabel(beforeForm)}切换为${trainingFormLabel(input.form)}（${summarizeTargetLabel(built.target, built.restSec)}）`,
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        const ex = resolveSessionExercise(current, input);
        const nextSession =
          input.mode === 'skip_remaining' ? skipRemaining(current, ex.id) : unskipExercise(current, ex.id);
        return {
          nextSession,
          summary:
            input.mode === 'skip_remaining'
              ? `已将「${ex.name}」未开始组标为跳过`
              : `已恢复「${ex.name}」被跳过的组`,
          touchedTargets: [
            {
              kind: 'session-snapshot',
              sessionId: current.id,
              beforeSession: beforeSnapshot,
              afterSession: structuredClone(nextSession),
            },
          ],
        };
      },
    },
    hooks,
  );
}

/* ── 工具 9：进行中训练写备注（整场 / 动作 / 单组） ── */

export type UpdateActiveNoteInput = {
  operationId?: string;
  sessionId: string;
  expectedRevision?: number;
  expectedEpoch?: number;
  scope: 'session' | 'exercise' | 'set';
  exId?: string;
  exerciseName?: string;
  setId?: string;
  roundIndex?: number;
  stageIndex?: number;
  targetMode?: 'next_pending' | 'last_completed';
  note: string;
  append?: boolean;
} & CoachTxPreconditionArgs;

export async function coachUpdateActiveNote(
  input: UpdateActiveNoteInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('act-note');
  const maxLen = input.scope === 'set' ? 500 : MAX_TEXT;
  if (input.note.length > maxLen) {
    throw new TxConflictError('invalid-input', `备注最多 ${maxLen} 个字符`);
  }

  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'update_active_note',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      argsForDigest: input,
      compute: (current) => {
        const beforeSnapshot = structuredClone(current);
        const mergeNote = (oldNote: string | undefined): string => {
          const incoming = input.note.trim();
          if (!input.append) return incoming;
          const prev = (oldNote ?? '').trim();
          if (!prev) return incoming;
          if (!incoming) return prev;
          const joined = `${prev}；${incoming}`;
          if (joined.length > maxLen) {
            throw new TxConflictError('invalid-input', `追加后备注超过 ${maxLen} 字上限`);
          }
          return joined;
        };

        if (input.scope === 'session') {
          const nextNote = mergeNote(current.note);
          const nextSession: Session = { ...current, note: nextNote };
          return {
            nextSession,
            summary: nextNote ? `更新本场训练备注：${nextNote.slice(0, 36)}` : '清空本场训练备注',
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        const ex = resolveSessionExercise(current, input);
        if (input.scope === 'exercise') {
          const focus = checkFocusConflict({ sessionId: current.id, exId: ex.id, fields: ['note'] });
          if (focus.conflict) {
            throw new TxConflictError('focus-conflict', focus.message ?? '动作备注正在编辑中');
          }
          const nextNote = mergeNote(ex.note);
          const nextSession = withExercise(current, ex.id, { note: nextNote });
          return {
            nextSession,
            summary: nextNote ? `记录「${ex.name}」备注：${nextNote.slice(0, 36)}` : `清空「${ex.name}」备注`,
            touchedTargets: [
              {
                kind: 'session-snapshot',
                sessionId: current.id,
                beforeSession: beforeSnapshot,
                afterSession: structuredClone(nextSession),
              },
            ],
          };
        }

        const targetSet = resolveTargetSet(ex, input);
        const focus = checkFocusConflict({
          sessionId: current.id,
          exId: ex.id,
          setId: targetSet.id,
          fields: ['note'],
        });
        if (focus.conflict) {
          throw new TxConflictError('focus-conflict', focus.message ?? '单组备注正在编辑中');
        }
        const nextNote = mergeNote(targetSet.note);
        const nextSession = withSetAndPrefillFollowingWeight(current, ex.id, targetSet.id, {
          note: nextNote || undefined,
        });
        const afterSet = nextSession.exercises.find((e) => e.id === ex.id)!.sets.find((s) => s.id === targetSet.id)!;
        return {
          nextSession,
          summary: nextNote
            ? `记录「${ex.name}」第 ${targetSet.roundIndex} 组备注：${nextNote.slice(0, 32)}`
            : `清空「${ex.name}」第 ${targetSet.roundIndex} 组备注`,
          touchedTargets: [
            {
              kind: 'session-set',
              sessionId: current.id,
              exId: ex.id,
              setId: targetSet.id,
              beforeSet: structuredClone(targetSet),
              afterSet: structuredClone(afterSet),
            },
          ],
        };
      },
    },
    hooks,
  );
}

/* ── 工具 10：直接结束当前进行中训练 ── */

export async function coachFinishActiveSession(
  args: {
    operationId?: string;
    sessionId: string;
    expectedRevision?: number;
    expectedEpoch?: number;
    syncBackToPlanDay?: boolean;
    advanceCycle?: boolean;
    note?: string;
  } & CoachTxPreconditionArgs,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? makeOpId('finish-sess');
  const runtime = getActiveSessionRuntime(args.sessionId);
  if (runtime) {
    await runtime.awaitPendingWrites();
    if (runtime.hasBlockingDrafts()) {
      throw new TxConflictError(
        'focus-conflict',
        '训练页还有未确认或未落盘的手工输入草稿，请先点一下空白处保存后再结束训练',
      );
    }
  }
  if (args.note !== undefined && args.note.length > MAX_TEXT) {
    throw new TxConflictError('invalid-input', `训练备注最多 ${MAX_TEXT} 个字符`);
  }

  const preSession = await getSession(args.sessionId);
  if (!preSession) {
    throw new TxConflictError('not-found', '找不到要结束的训练记录');
  }
  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'finish_active_session',
      argsForDigest: args,
      expectedEpoch: args.expectedEpoch,
      priorBatchOpIds: args.priorBatchOpIds,
      stores: ['sessions', 'plans'],
      sessionId: args.sessionId,
      planId: preSession.planId,
      lockCheck: {
        sessionId: args.sessionId,
        editorId: runtime?.editorId,
        lockPolicy: runtime ? 'required' : 'optional',
      },
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentSession, currentPlan, priorOpLogs }) => {
        if (!currentSession) {
          throw new TxConflictError('not-found', '找不到要结束的训练记录');
        }
        if (currentSession.status !== 'active') {
          throw new TxConflictError('state-conflict', '这场训练已经结束，无需重复收尾');
        }
        const curRev = revisionOf(currentSession);
        assertSessionVersionOrPrecondition({
          currentSession,
          expectedRevision: args.expectedRevision,
          modelExpectedRevision: args.modelExpectedRevision,
          currentEpoch,
          priorOpLogs,
          frozenPrecondition: args.frozenPrecondition,
          strictSessionRevision: args.strictSessionRevision ?? true,
          entityLabel: '训练记录',
        });

        const advance = args.advanceCycle ?? true;
        const syncPlan = Boolean(args.syncBackToPlanDay);
        const freshPlanBefore = currentPlan ? structuredClone(currentPlan) : undefined;
        let workingPlan = currentPlan ? structuredClone(currentPlan) : undefined;
        if (syncPlan) {
          if (!workingPlan) {
            throw new TxConflictError(
              'state-conflict',
              '原计划已不存在，无法将今日动作编排同步回计划',
            );
          }
          const synced = applySessionArrangementToPlan(
            workingPlan,
            currentSession.day.dayId,
            currentSession,
            now,
          );
          if (!synced.ok) {
            throw new TxConflictError('state-conflict', synced.message);
          }
          workingPlan = synced.plan;
        }
        const shouldAdvance =
          advance && !currentSession.advancedCycle && !!workingPlan && workingPlan.days.length > 0;
        const movedPlan = shouldAdvance && workingPlan ? pushCycle(workingPlan) : undefined;
        const planToPersist =
          movedPlan && workingPlan
            ? { ...workingPlan, ...movedPlan }
            : syncPlan
              ? workingPlan
              : undefined;

        const finalizedCardio = Array.isArray(currentSession.cardio)
          ? currentSession.cardio.map((c) => finalizeCardioForFinish(c, now))
          : currentSession.cardio;
        const nextSession: Session = {
          ...currentSession,
          ...(finalizedCardio ? { cardio: finalizedCardio } : {}),
          ...(args.note !== undefined ? { note: args.note.trim() } : {}),
          status: 'completed',
          endedAt: now,
          advancedCycle: Boolean(shouldAdvance),
          cycleIndexAfter: movedPlan
            ? movedPlan.cursor
            : (workingPlan?.cursor ?? currentSession.cycleIndexAtStart),
          revision: curRev + 1,
        };

        const sum = summarizeSession(nextSession);
        const targets: CoachReceiptTouchedTarget[] = [];
        if (syncPlan && freshPlanBefore && planToPersist) {
          targets.push({
            kind: 'plan-day',
            planId: planToPersist.id,
            beforePlan: freshPlanBefore,
            afterPlan: structuredClone(planToPersist),
          });
        }
        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'finish_active_session',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: syncPlan ? 'session+plan' : 'session',
          summary: syncPlan
            ? `已结束「${nextSession.day.dayName}」（完成 ${sum.completedSets} 组）并同步更新原计划`
            : `已结束「${nextSession.day.dayName}」（完成 ${sum.completedSets} 组）`,
          entityType: syncPlan ? 'session+plan' : 'session',
          entityId: nextSession.id,
          planId: (planToPersist ?? workingPlan)?.id,
          beforeRevision: curRev,
          afterRevision: curRev + 1,
          beforePlanRevision: freshPlanBefore?.updatedAt,
          afterPlanRevision: planToPersist?.updatedAt,
          undoable: false,
          undone: false,
          touchedTargets: targets,
        };
        return {
          nextSession,
          nextPlan: planToPersist,
          deleteRestTimerSessionId: currentSession.id,
          opLog,
        };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (!txResult.replayed) {
    runtime?.stopRestTimer?.();
    if (txResult.session) {
      runtime?.applyCommittedSession(txResult.session);
      hooks?.onSessionCommitted?.(txResult.session);
    }
    if (txResult.plan) hooks?.onPlanCommitted?.(txResult.plan);
  }
  hooks?.onReceiptSaved?.(txResult.receipt);
  return {
    receipt: txResult.receipt,
    session: txResult.session,
    plan: txResult.plan,
    replayed: txResult.replayed,
  };
}

/* ── 工具 11：进行中热身管理 ── */

export type ManageActiveWarmupInput = {
  operationId?: string;
  sessionId: string;
  expectedRevision?: number;
  expectedEpoch?: number;
  action: 'toggle_done' | 'add' | 'update' | 'remove';
  warmupId?: string;
  warmupName?: string;
  done?: boolean;
  name?: string;
  unit?: 'reps' | 'time' | 'breath';
  targetText?: string;
} & CoachTxPreconditionArgs;

export async function coachManageActiveWarmup(
  input: ManageActiveWarmupInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('warmup');
  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'manage_active_warmup',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      argsForDigest: input,
      compute: (current) => {
        const beforeSnapshot = structuredClone(current);
        const resolveWarmup = () => {
          if (input.warmupId) {
            const w = current.warmups.find((x) => x.id === input.warmupId);
            if (!w) throw new TxConflictError('not-found', '找不到目标热身项');
            return w;
          }
          const needle = (input.warmupName ?? input.name ?? '').trim().toLowerCase();
          if (needle) {
            const exact = current.warmups.filter((x) => x.name.trim().toLowerCase() === needle);
            if (exact.length === 1) return exact[0];
            if (exact.length > 1) throw new TxConflictError('ambiguous-target', '找到多个同名热身项，请明确指定');
            const fuzzy = current.warmups.filter((x) => x.name.trim().toLowerCase().includes(needle));
            if (fuzzy.length === 1) return fuzzy[0];
            if (fuzzy.length > 1) throw new TxConflictError('ambiguous-target', '找到多个匹配热身项，请明确全称');
          }
          if (current.warmups.length === 1) return current.warmups[0];
          throw new TxConflictError('not-found', '本次训练中找不到对应热身项');
        };

        let nextWarmups = [...current.warmups];
        let summary = '';

        if (input.action === 'add') {
          if (nextWarmups.length >= MAX_EXERCISES) {
            throw new TxConflictError('dirty-state', `热身项数已达 ${MAX_EXERCISES} 上限`);
          }
          const name = (input.name ?? input.warmupName ?? '').trim();
          const targetText = (input.targetText ?? '2 × 10').trim();
          if (!name) throw new TxConflictError('invalid-input', '请提供热身项目名称');
          if (name.length > 200 || targetText.length > 200) {
            throw new TxConflictError('invalid-input', '热身名称与目标文字最多 200 字');
          }
          nextWarmups.push({
            id: newId('w'),
            name,
            unit: input.unit ?? 'reps',
            targetText,
            done: Boolean(input.done),
          });
          summary = `新增热身「${name}」（${targetText}）`;
        } else if (input.action === 'remove') {
          const w = resolveWarmup();
          nextWarmups = nextWarmups.filter((x) => x.id !== w.id);
          summary = `移除热身「${w.name}」`;
        } else if (input.action === 'update') {
          const w = resolveWarmup();
          const nextName = input.name !== undefined ? input.name.trim() : w.name;
          const nextText = input.targetText !== undefined ? input.targetText.trim() : w.targetText;
          if (!nextName || nextName.length > 200 || nextText.length > 200) {
            throw new TxConflictError('invalid-input', '热身名称不能为空且名称/目标均不能超过 200 字');
          }
          nextWarmups = nextWarmups.map((x) =>
            x.id === w.id
              ? {
                  ...x,
                  name: nextName,
                  unit: input.unit ?? x.unit,
                  targetText: nextText,
                  ...(input.done !== undefined ? { done: input.done } : {}),
                }
              : x,
          );
          summary = `更新热身「${nextName}」（${nextText}）`;
        } else {
          const w = resolveWarmup();
          const nextDone = input.done !== undefined ? input.done : !w.done;
          nextWarmups = nextWarmups.map((x) => (x.id === w.id ? { ...x, done: nextDone } : x));
          summary = `${nextDone ? '完成' : '取消完成'}热身「${w.name}」`;
        }

        const nextSession: Session = { ...current, warmups: nextWarmups };
        return {
          nextSession,
          summary,
          touchedTargets: [
            {
              kind: 'session-snapshot',
              sessionId: current.id,
              beforeSession: beforeSnapshot,
              afterSession: structuredClone(nextSession),
            },
          ],
        };
      },
    },
    hooks,
  );
}

/* ── 工具 12：进行中有氧管理（6 种有氧预设全面放开） ── */

export type ManageActiveCardioInput = {
  operationId?: string;
  sessionId: string;
  expectedRevision?: number;
  expectedEpoch?: number;
  action: 'add' | 'update_params' | 'start' | 'pause' | 'resume' | 'complete' | 'remove';
  cardioId?: string;
  cardioName?: string;
  preset?: CardioPreset;
  name?: string;
  params?: Partial<CardioParams>;
  note?: string;
} & CoachTxPreconditionArgs;

export async function coachManageActiveCardio(
  input: ManageActiveCardioInput,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = input.operationId ?? makeOpId('cardio');
  return runActiveSessionMutation(
    {
      operationId,
      toolName: 'manage_active_cardio',
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      modelExpectedRevision: input.modelExpectedRevision,
      expectedEpoch: input.expectedEpoch,
      frozenPrecondition: input.frozenPrecondition,
      priorBatchOpIds: input.priorBatchOpIds,
      strictSessionRevision: input.strictSessionRevision,
      argsForDigest: input,
      compute: (current) => {
        const beforeSnapshot = structuredClone(current);
        const list = current.cardio ?? [];
        const resolveEntry = () => {
          if (input.cardioId) {
            const c = list.find((x) => x.id === input.cardioId);
            if (!c) throw new TxConflictError('not-found', '找不到目标有氧项目');
            return c;
          }
          const needle = (input.cardioName ?? input.name ?? '').trim().toLowerCase();
          if (needle) {
            const exact = list.filter((x) => x.name.trim().toLowerCase() === needle);
            if (exact.length === 1) return exact[0];
            const fuzzy = list.filter((x) => x.name.trim().toLowerCase().includes(needle));
            if (fuzzy.length === 1) return fuzzy[0];
            if (fuzzy.length > 1) throw new TxConflictError('invalid-input', '找到多个匹配有氧项目，请明确名称');
          }
          if (list.length === 1) return list[0];
          throw new TxConflictError('not-found', '当前训练中找不到对应有氧项目');
        };

        let nextSession: Session = current;
        let summary = '';

        if (input.action === 'add') {
          const preset: CardioPreset = input.preset ?? 'free-cardio';
          const defaultParams =
            CARDIO_PRESET_CHOICES.find((c) => c.preset === preset)?.params ?? {};
          const normalized = normalizeCardioParams(preset, {
            ...defaultParams,
            ...(input.params ?? {}),
          });
          const issues = validateCardioParams(preset, normalized);
          if (issues.length) throw new TxConflictError('invalid-input', issues[0].message);
          let entry = createCardioEntry({
            preset,
            name: (input.name ?? CARDIO_PRESET_LABEL[preset]).trim() || CARDIO_PRESET_LABEL[preset],
            params: normalized,
          });
          if (input.note?.trim()) {
            if (input.note.trim().length > MAX_TEXT) throw new TxConflictError('invalid-input', `备注最多 ${MAX_TEXT} 字`);
            entry = { ...entry, note: input.note.trim() };
          }
          const added = addCardioToSession(current, entry);
          if (!added) {
            throw new TxConflictError('dirty-state', `单次训练最多 ${MAX_CARDIO_ENTRIES} 个有氧项目`);
          }
          nextSession = added;
          summary = `追加有氧项目「${entry.name}」`;
        } else if (input.action === 'remove') {
          const entry = resolveEntry();
          nextSession = removeCardioFromSession(current, entry.id);
          summary = `移除有氧项目「${entry.name}」`;
        } else {
          let entry = resolveEntry();
          if (input.note !== undefined) {
            if (input.note.length > MAX_TEXT) throw new TxConflictError('invalid-input', `备注最多 ${MAX_TEXT} 字`);
            entry = input.note.trim() ? { ...entry, note: input.note.trim() } : { ...entry, note: undefined };
            if (entry.note === undefined) delete entry.note;
          }
          if (input.action === 'update_params') {
            const merged = normalizeCardioParams(entry.preset, { ...entry.currentParams, ...(input.params ?? {}) });
            const issues = validateCardioParams(entry.preset, merged);
            if (issues.length) throw new TxConflictError('invalid-input', issues[0].message);
            const res = commitCardioParams(entry, merged);
            if (!res.ok) throw new TxConflictError('dirty-state', res.reason);
            entry = res.entry;
            summary = `调整有氧「${entry.name}」参数`;
          } else if (input.action === 'start') {
            if (list.some((c) => c.id !== entry.id && c.status === 'running')) {
              throw new TxConflictError('state-conflict', '已有另一项有氧正在计时，请先暂停或完成它');
            }
            entry = startCardio(entry);
            summary = `开始有氧「${entry.name}」计时`;
          } else if (input.action === 'pause') {
            entry = pauseCardio(entry);
            summary = `暂停有氧「${entry.name}」`;
          } else if (input.action === 'resume') {
            if (list.some((c) => c.id !== entry.id && c.status === 'running')) {
              throw new TxConflictError('state-conflict', '已有另一项有氧正在计时，请先暂停或完成它');
            }
            entry = resumeCardio(entry);
            summary = `恢复有氧「${entry.name}」计时`;
          } else {
            entry = completeCardio(entry);
            summary = `完成有氧「${entry.name}」`;
          }
          nextSession = withCardioEntry(current, entry);
        }

        return {
          nextSession,
          summary,
          touchedTargets: [
            {
              kind: 'session-snapshot',
              sessionId: current.id,
              beforeSession: beforeSnapshot,
              afterSession: structuredClone(nextSession),
            },
          ],
        };
      },
    },
    hooks,
  );
}

/* ── 工具 13：跨计划器械档位备忘读写 ── */

export async function coachUpdateSetupNote(
  args: {
    operationId?: string;
    sessionId?: string;
    exId?: string;
    exerciseName?: string;
    exerciseId?: string;
    expectedRevision?: number;
    expectedEpoch?: number;
    note: string;
  } & CoachTxPreconditionArgs,
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult> {
  const operationId = args.operationId ?? makeOpId('setup-note');
  const parsed = parseSetupNote(args.note);
  if (!parsed.ok) {
    throw new TxConflictError('invalid-input', parsed.message);
  }
  const nextNote = parsed.note;

  const runtime = args.sessionId ? getActiveSessionRuntime(args.sessionId) : null;
  if (runtime) await runtime.awaitPendingWrites();

  let preSession: Session | undefined;
  let preEx: SessionExercise | undefined;
  if (args.sessionId) {
    preSession = await getSession(args.sessionId);
    if (preSession && preSession.status === 'active') {
      try {
        preEx = resolveSessionExercise(preSession, { exId: args.exId, exerciseName: args.exerciseName });
      } catch (err) {
        if (!args.exerciseId) throw err;
      }
    }
  }

  const targetExerciseId =
    args.exerciseId?.trim() ||
    preEx?.exerciseId ||
    (args.exerciseName?.trim() ? exerciseIdFromName(args.exerciseName.trim()) : '');
  const displayName = preEx?.name || args.exerciseName?.trim() || targetExerciseId;
  if (!targetExerciseId) {
    throw new TxConflictError('invalid-input', '请指定要设置器械档位备忘的动作名称');
  }

  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);

  const txResult = await wrapMainTx(() =>
    executeCoachMainTx({
      operationId,
      toolName: 'update_setup_note',
      argsForDigest: {
        sessionId: args.sessionId,
        exId: args.exId,
        exerciseName: args.exerciseName,
        exerciseId: targetExerciseId,
        note: nextNote,
      },
      expectedEpoch: args.expectedEpoch,
      priorBatchOpIds: args.priorBatchOpIds,
      stores: preEx && preSession ? ['sessions'] : [],
      sessionId: preEx && preSession ? preSession.id : undefined,
      templateExerciseId: targetExerciseId,
      lockCheck:
        preEx && preSession
          ? {
              sessionId: preSession.id,
              editorId: runtime?.editorId,
              lockPolicy: runtime ? 'required' : 'optional',
            }
          : undefined,
      fallbackVaultEpoch,
      prepare: ({ now, currentEpoch, currentSession, currentTemplate, priorOpLogs }) => {
        let activeEx: SessionExercise | undefined;
        let beforeRev = 0;
        let afterRev = 0;
        let nextSession: Session | undefined;

        if (preEx && args.sessionId) {
          if (!currentSession || currentSession.status !== 'active') {
            throw new TxConflictError('state-conflict', '训练已结束或不存在，无法联动修改器械档位');
          }
          beforeRev = revisionOf(currentSession);
          assertSessionVersionOrPrecondition({
            currentSession,
            expectedRevision: args.expectedRevision,
            modelExpectedRevision: args.modelExpectedRevision,
            currentEpoch,
            priorOpLogs,
            frozenPrecondition: args.frozenPrecondition,
            strictSessionRevision: args.strictSessionRevision,
            entityLabel: '训练记录',
          });
          activeEx = resolveSessionExercise(currentSession, {
            exId: args.exId ?? preEx.id,
            exerciseName: args.exerciseName,
          });
          afterRev = beforeRev + 1;
          nextSession = {
            ...currentSession,
            revision: afterRev,
            exercises: currentSession.exercises.map((e) =>
              e.id === activeEx!.id ? withSetupNote(e, nextNote) : e,
            ),
          };
        }

        const baseTemplate: ExerciseTemplate =
          currentTemplate ??
          exerciseTemplateFromConfig({
            exerciseId: targetExerciseId,
            name: displayName,
            target: activeEx?.target ?? {
              kind: 'straight',
              sets: 3,
              setsMax: 3,
              repsMin: 8,
              repsMax: 12,
              weightMode: 'external',
              suggestedWeightKg: null,
            },
            restSec: activeEx?.restSec ?? 120,
          });
        const candidateRaw = withSetupNote(baseTemplate, nextNote);
        const committedTemplate: ExerciseTemplate = {
          ...candidateRaw,
          schemaVersion: 1,
          key: `exercise-template:${targetExerciseId}`,
          revision: currentTemplate ? currentTemplate.revision + 1 : 1,
          updatedAt: now,
        };

        const opLog: CoachMainOpLogRecord = {
          schemaVersion: 2,
          operationId,
          receiptId: makeReceiptId(),
          toolName: 'update_setup_note',
          argsDigest: '',
          createdAt: now,
          restoreEpoch: currentEpoch,
          scope: activeEx && currentSession ? 'session' : 'plan',
          summary: nextNote
            ? `更新「${displayName}」器械档位备忘：${nextNote}`
            : `清空「${displayName}」器械档位备忘`,
          entityType: activeEx && currentSession ? 'session' : 'plan',
          entityId: activeEx && currentSession ? currentSession.id : targetExerciseId,
          beforeRevision: beforeRev,
          afterRevision: afterRev,
          undoable: true,
          undone: false,
          touchedTargets: [
            {
              kind: 'setup-note',
              ...(activeEx && currentSession
                ? {
                    sessionId: currentSession.id,
                    exId: activeEx.id,
                    beforeSessionNote: activeEx.setupNote,
                    afterSessionNote: nextNote,
                  }
                : {}),
              exerciseId: targetExerciseId,
              ...(currentTemplate ? { beforeTemplate: structuredClone(currentTemplate) } : {}),
              afterTemplate: structuredClone(committedTemplate),
            },
          ],
        };

        return {
          ...(nextSession ? { nextSession } : {}),
          nextTemplate: committedTemplate,
          opLog,
        };
      },
    }),
  );

  await saveCoachReceipt(txResult.receipt);
  if (!txResult.replayed) {
    if (txResult.session) {
      runtime?.applyCommittedSession(txResult.session);
      hooks?.onSessionCommitted?.(txResult.session);
    }
    hooks?.onTemplatesChanged?.();
  }
  hooks?.onReceiptSaved?.(txResult.receipt);
  return { receipt: txResult.receipt, session: txResult.session, replayed: txResult.replayed };
}

/* ── 工具 14：Hermes 式持久记忆管理 ── */

export async function coachManageMemory(
  args: {
    operationId?: string;
    expectedEpoch?: number;
    action: 'save' | 'delete';
    id?: string;
    category?: CoachMemoryCategory;
    title?: string;
    content?: string;
    pinned?: boolean;
    source?: 'coach' | 'user';
  },
  hooks?: CoachTxHooks,
): Promise<CoachCommitResult & { memory: CoachMemoryStore; savedItem?: CoachMemoryItem; removedItem?: CoachMemoryItem }> {
  const operationId = args.operationId ?? makeOpId('mem');
  const currentEpoch = await getCoachRestoreEpoch();
  if (args.expectedEpoch !== undefined && currentEpoch !== args.expectedEpoch) {
    throw new TxConflictError('epoch-mismatch', '备份已恢复，请刷新上下文后再操作记忆');
  }
  const existingReceipt = await getCoachReceiptByOperationId(operationId);
  const currentMem = await loadCoachMemory();
  if (existingReceipt) {
    let removedItem: CoachMemoryItem | undefined;
    let savedItem: CoachMemoryItem | undefined;
    const target = existingReceipt.touchedTargets.find((t) => t.kind === 'coach-memory');
    if (target && target.kind === 'coach-memory') {
      if (args.action === 'delete') {
        const afterIds = new Set(target.afterMemory.items.map((x) => x.id));
        removedItem = target.beforeMemory.items.find((x) => !afterIds.has(x.id));
      } else {
        savedItem = target.afterMemory.items.find(
          (x) =>
            (args.id && x.id === args.id) ||
            (args.title && x.title === args.title.trim()) ||
            x.updatedAt === existingReceipt.afterRevision,
        );
      }
    }
    return {
      receipt: existingReceipt,
      memory: currentMem,
      replayed: true,
      ...(savedItem ? { savedItem } : {}),
      ...(removedItem ? { removedItem } : {}),
    };
  }

  let afterMem: CoachMemoryStore;
  let summary = '';
  let savedItem: CoachMemoryItem | undefined;
  let removedItem: CoachMemoryItem | undefined;

  if (args.action === 'delete') {
    const res = removeCoachMemoryItem(currentMem, { id: args.id, title: args.title });
    if (!res.removed) {
      throw new TxConflictError('not-found', '找不到要删除的教练记忆');
    }
    afterMem = res.store;
    removedItem = res.removed;
    summary = `忘记记忆「${res.removed.title}」`;
  } else {
    const title = (args.title ?? '').trim();
    const content = (args.content ?? '').trim();
    if (!title || !content) {
      throw new TxConflictError('invalid-input', '写入长期记忆需要提供标题和内容');
    }
    const res = upsertCoachMemoryItem(currentMem, {
      id: args.id,
      category: args.category ?? 'preference',
      title,
      content,
      source: args.source ?? 'coach',
      pinned: args.pinned,
    });
    afterMem = res.store;
    savedItem = res.item;
    summary = `${res.created ? '记住' : '更新'}「${res.item.title}」：${res.item.content}`;
  }

  const receipt: CoachOperationReceipt = {
    id: makeReceiptId(),
    operationId,
    schemaVersion: 2,
    toolName: 'manage_coach_memory',
    createdAt: Date.now(),
    scope: 'memory',
    summary,
    entityType: 'memory',
    entityId: 'coach-memory',
    beforeRevision: currentMem.updatedAt,
    afterRevision: afterMem.updatedAt,
    restoreEpoch: currentEpoch,
    undone: false,
    touchedTargets: [
      {
        kind: 'coach-memory',
        beforeMemory: structuredClone(currentMem),
        afterMemory: structuredClone(afterMem),
      },
    ],
  };

  await runCoachMemoryVaultTx({
    memoryKey: COACH_MEMORY_META_KEY,
    nextMemory: afterMem,
    receipt,
  });

  hooks?.onMemoryChanged?.(afterMem);
  hooks?.onReceiptSaved?.(receipt);
  return {
    receipt,
    memory: afterMem,
    replayed: false,
    ...(savedItem ? { savedItem } : {}),
    ...(removedItem ? { removedItem } : {}),
  };
}

/* ── 字段级独立撤销（主库权威账本单事务回滚，v0.2.2 兼容迁移墓碑） ── */

export async function undoCoachReceipt(
  receiptId: string,
  hooks?: CoachTxHooks,
): Promise<{ receipt: CoachOperationReceipt; session?: Session; plan?: Plan }> {
  const receipt = await getCoachReceipt(receiptId);
  if (!receipt) {
    throw new TxConflictError('not-found', '找不到对应的操作回执');
  }
  if (receipt.undoable === false) {
    throw new TxConflictError('state-conflict', '已结束训练的完训动作不支持通过聊天回执直接复活，请在历史中调整');
  }
  if (receipt.undone) {
    throw new TxConflictError('state-conflict', '该操作回执已经撤销过了');
  }

  if (receipt.scope === 'memory') {
    const currentEpoch = await getCoachRestoreEpoch();
    if (receipt.restoreEpoch !== currentEpoch) {
      throw new TxConflictError(
        'epoch-mismatch',
        '系统已执行过备份恢复，恢复前产生的教练回执已自动失效，无法撤销。',
      );
    }
    const memTarget = receipt.touchedTargets.find((t) => t.kind === 'coach-memory');
    const restoredMem = memTarget
      ? structuredClone(memTarget.beforeMemory)
      : await loadCoachMemory();
    const nextReceipt: CoachOperationReceipt = {
      ...receipt,
      schemaVersion: receipt.schemaVersion ?? 2,
      undone: true,
      undoneAt: Date.now(),
    };
    await runCoachMemoryVaultTx({
      memoryKey: COACH_MEMORY_META_KEY,
      nextMemory: restoredMem,
      receipt: nextReceipt,
    });
    hooks?.onMemoryChanged?.(restoredMem);
    hooks?.onReceiptSaved?.(nextReceipt);
    return { receipt: nextReceipt };
  }

  const fallbackVaultEpoch = await getCoachVaultRestoreEpoch().catch(() => 0);
  const res = await wrapMainTx(() =>
    executeCoachMainUndoTx({
      receipt,
      fallbackVaultEpoch,
    }),
  );

  if (!res.alreadyUndoneInMain) {
    if (res.session) {
      const rt = getActiveSessionRuntime(res.session.id);
      rt?.applyCommittedSession(res.session);
      hooks?.onSessionCommitted?.(res.session);
    }
    if (res.stopTimerSessionId) {
      getActiveSessionRuntime(res.stopTimerSessionId)?.stopRestTimer?.();
    }
    if (res.plan) {
      hooks?.onPlanCommitted?.(res.plan);
    }
    if (res.deletedPlanId) {
      hooks?.onPlanDeleted?.(res.deletedPlanId);
    }
    if (res.templatesChanged) {
      hooks?.onTemplatesChanged?.();
    }
  }
  await saveCoachReceiptStrict(res.nextReceipt);
  hooks?.onReceiptSaved?.(res.nextReceipt);

  return {
    receipt: res.nextReceipt,
    session: res.session,
    plan: res.plan,
  };
}

// 兼容导出，避免未用 savePlan / computeCoachOpArgsDigest / atomicDeletePlanWithCurrent 告警
export { savePlan, computeCoachOpArgsDigest, atomicDeletePlanWithCurrent };
