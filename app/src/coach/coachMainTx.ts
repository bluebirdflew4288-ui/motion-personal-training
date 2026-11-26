/* 教练主库同事务操作账本与主库权威撤销（v0.2.3）。
   设计原则：
   1. 任何涉及主库训练状态（sessions / plans / settings / exercise-template:*）的教练写入，
      都在单笔 `motion-training` IndexedDB `readwrite` 事务中同步校验并写入：
        · 业务实体（session / plan / setting / template）
        · `coach-op:<operationId>` 幂等账本与参数摘要
        · `coach-restore-epoch`（若老版本主库尚无该键，先采纳 vault 纪元再落库）
        · `rest-timer-state:<sessionId>`（记组触发休息时同事务持久化，完训时同事务清理）
   2. 断线/重载重放时，在 revision/lock 校验之前先读取 `coach-op:<operationId>`，
      核对 epoch 与规范化 argsDigest 一致后直接返回已提交结果并修复 vault 回执镜像，0 二次写入。
   3. 撤销（Undo）同样以主库 `coach-op:<operationId>` 与最新实体状态为权威真源，
      单事务回滚业务实体并置 `undone = true`；v0.2.2 遗留无主库账本的历史回执支持一次性安全迁移墓碑。 */

import {
  COACH_OP_META_PREFIX,
  COACH_RESTORE_EPOCH_META_KEY,
  openDb,
  REST_TIMER_STATE_META_PREFIX,
} from '../db/idb';
import {
  DEFAULT_LOCK_TTL_MS,
  interpretLock,
  lockGrantsWrite,
  lockKey,
} from '../db/locks';
import { hasReps, withExercise, applyTargetToSessionExercise } from '../domain/session';
import { cleanOrphanPairIds } from '../domain/supersetPair';
import { withSetupNote } from '../domain/setupNote';
import type { ExerciseTemplate, Plan, Session, SessionSet } from '../domain/types';
import { checkFocusConflict } from './focusGuard';
import { getActiveSessionRuntime } from './sessionRuntimeBridge';
import type {
  CoachOperationReceipt,
  CoachReceiptTouchedTarget,
} from './coachStorage';
import type { CoachRestTimerDirective, DurableRestTimerRecord } from '../lib/restTimerDurable';

export interface CoachMainOpLogRecord {
  schemaVersion: 2;
  operationId: string;
  receiptId: string;
  toolName: CoachOperationReceipt['toolName'];
  argsDigest: string;
  createdAt: number;
  restoreEpoch: number;
  scope: CoachOperationReceipt['scope'];
  summary: string;
  entityType: CoachOperationReceipt['entityType'];
  entityId: string;
  planId?: string;
  beforeRevision: number;
  afterRevision: number;
  beforePlanRevision?: number;
  afterPlanRevision?: number;
  undoable: boolean;
  undone: boolean;
  undoneAt?: number;
  timerStarted?: boolean;
  timerDirective?: CoachRestTimerDirective;
  touchedTargets: CoachReceiptTouchedTarget[];
  migratedFromLegacy?: boolean;
}

export type MainTxConflictReason =
  | 'lock-lost'
  | 'no-lock'
  | 'corrupt-lock'
  | 'version-conflict'
  | 'state-conflict'
  | 'storage'
  | 'focus-conflict'
  | 'dirty-state'
  | 'epoch-mismatch'
  | 'field-conflict'
  | 'not-found'
  | 'invalid-input'
  | 'ambiguous-target';

export class MainTxError extends Error {
  constructor(
    public readonly reason: MainTxConflictReason,
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'MainTxError';
  }
}

const VOLATILE_ARG_KEYS = new Set([
  'operationId',
  'expectedRevision',
  'expectedPlanRevision',
  'expectedUpdatedAt',
  'expectedSessionRevision',
  'expectedPlanUpdatedAt',
  'modelExpectedRevision',
  'modelExpectedPlanUpdatedAt',
  'expectedEpoch',
  'deferTimerDispatch',
  'frozenPrecondition',
  'priorBatchOpIds',
  'batchAdvancedRevision',
  'strictSessionRevision',
]);

function stableNormalize(value: unknown, skipVolatileKeys: boolean): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item, false));
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    if (skipVolatileKeys && VOLATILE_ARG_KEYS.has(k)) continue;
    const v = (value as Record<string, unknown>)[k];
    if (v === undefined) continue;
    out[k] = stableNormalize(v, false);
  }
  return out;
}

export function fnv1a64Hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (c + i) & 0xffff;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

export function computeCoachOpArgsDigest(toolName: string, args: unknown): string {
  const canonical = JSON.stringify({
    toolName,
    args: stableNormalize(args ?? {}, true),
  });
  return `${canonical.length}:${fnv1a64Hex(canonical)}`;
}

export function receiptFromMainOpLog(op: CoachMainOpLogRecord): CoachOperationReceipt {
  return {
    id: op.receiptId,
    operationId: op.operationId,
    schemaVersion: 2,
    toolName: op.toolName,
    createdAt: op.createdAt,
    scope: op.scope,
    summary: op.summary,
    entityType: op.entityType,
    entityId: op.entityId,
    ...(op.planId ? { planId: op.planId } : {}),
    beforeRevision: op.beforeRevision,
    afterRevision: op.afterRevision,
    ...(op.beforePlanRevision !== undefined ? { beforePlanRevision: op.beforePlanRevision } : {}),
    ...(op.afterPlanRevision !== undefined ? { afterPlanRevision: op.afterPlanRevision } : {}),
    restoreEpoch: op.restoreEpoch,
    undone: op.undone,
    ...(op.undoneAt !== undefined ? { undoneAt: op.undoneAt } : {}),
    undoable: op.undoable,
    ...(op.timerStarted !== undefined ? { timerStarted: op.timerStarted } : {}),
    touchedTargets: op.touchedTargets,
  };
}

export function revisionOfSession(s: Session | undefined): number {
  return typeof s?.revision === 'number' && Number.isFinite(s.revision) ? s.revision : 0;
}

export interface MainTxLoadedState {
  now: number;
  currentEpoch: number;
  currentSession?: Session;
  currentPlan?: Plan;
  allPlans?: Plan[];
  currentTemplate?: ExerciseTemplate;
  priorOpLogs: CoachMainOpLogRecord[];
}

export interface MainTxPreparedWrite<T> {
  nextSession?: Session;
  nextPlan?: Plan;
  insertPlan?: Plan;
  nextTemplate?: ExerciseTemplate;
  deleteTemplateExerciseId?: string;
  nextSettings?: unknown;
  durableRestTimer?: DurableRestTimerRecord;
  deleteRestTimerSessionId?: string;
  opLog: CoachMainOpLogRecord;
  meta?: T;
}

export async function executeCoachMainTx<T = Record<string, unknown>>(params: {
  operationId: string;
  toolName: CoachOperationReceipt['toolName'];
  argsForDigest: unknown;
  expectedEpoch?: number;
  priorBatchOpIds?: string[];
  stores: Array<'sessions' | 'plans' | 'settings'>;
  sessionId?: string;
  planId?: string;
  needAllPlans?: boolean;
  templateExerciseId?: string;
  lockCheck?: {
    sessionId: string;
    editorId?: string;
    lockPolicy: 'required' | 'optional';
    ttlMs?: number;
  };
  fallbackVaultEpoch?: number;
  prepare: (loaded: MainTxLoadedState) => MainTxPreparedWrite<T>;
}): Promise<{
  receipt: CoachOperationReceipt;
  opLog: CoachMainOpLogRecord;
  session?: Session;
  plan?: Plan;
  template?: ExerciseTemplate;
  replayed: boolean;
  meta?: T;
}> {
  const argsDigest = computeCoachOpArgsDigest(params.toolName, params.argsForDigest);
  const storeNames = Array.from(new Set<string>(['meta', ...params.stores]));
  const db = await openDb();

  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const resolveOnce = (val: {
      receipt: CoachOperationReceipt;
      opLog: CoachMainOpLogRecord;
      session?: Session;
      plan?: Plan;
      template?: ExerciseTemplate;
      replayed: boolean;
      meta?: T;
    }) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, 'readwrite');
    } catch (err) {
      rejectOnce(
        new MainTxError('storage', err instanceof Error ? err.message : '开启主库事务失败'),
      );
      return;
    }

    let abortReason: Error | null = null;
    let pendingResult: {
      receipt: CoachOperationReceipt;
      opLog: CoachMainOpLogRecord;
      session?: Session;
      plan?: Plan;
      template?: ExerciseTemplate;
      replayed: boolean;
      meta?: T;
    } | null = null;

    const failTx = (err: Error) => {
      abortReason = err;
      try {
        tx.abort();
      } catch {
        /* ignore */
      }
      rejectOnce(err);
    };

    tx.oncomplete = () => {
      if (pendingResult) resolveOnce(pendingResult);
      else rejectOnce(abortReason ?? new MainTxError('storage', '事务完成但未产生写入结果'));
    };
    tx.onerror = () => {
      rejectOnce(
        abortReason ?? new MainTxError('storage', tx.error?.message ?? '主库事务写入失败'),
      );
    };
    tx.onabort = () => {
      rejectOnce(
        abortReason ?? new MainTxError('storage', tx.error?.message ?? '主库事务被中止'),
      );
    };

    const metaStore = tx.objectStore('meta');
    const sessionsStore = storeNames.includes('sessions') ? tx.objectStore('sessions') : null;
    const plansStore = storeNames.includes('plans') ? tx.objectStore('plans') : null;
    const settingsStore = storeNames.includes('settings') ? tx.objectStore('settings') : null;

    let epochRow: { key?: unknown; value?: unknown } | undefined;
    let opRow: { key?: unknown; value?: unknown } | undefined;
    let lockRaw: unknown;
    let currentSession: Session | undefined;
    let currentPlan: Plan | undefined;
    let allPlans: Plan[] | undefined;
    let tplRow: { key?: unknown; value?: unknown } | undefined;
    let metaCount = 0;

    const priorIds = Array.isArray(params.priorBatchOpIds) ? params.priorBatchOpIds.filter(Boolean) : [];
    const priorOpLogsByIdx: Array<CoachMainOpLogRecord | undefined> = new Array(priorIds.length).fill(undefined);

    let pending =
      3 + // epoch + op + metaCount
      priorIds.length +
      (params.lockCheck ? 1 : 0) +
      (sessionsStore && params.sessionId ? 1 : 0) +
      (plansStore && params.planId ? 1 : 0) +
      (plansStore && params.needAllPlans ? 1 : 0) +
      (params.templateExerciseId ? 1 : 0);

    const step = () => {
      pending -= 1;
      if (pending > 0) return;

      const now = Date.now();
      const hasMainEpoch =
        epochRow &&
        typeof epochRow.value === 'number' &&
        Number.isFinite(epochRow.value) &&
        epochRow.value >= 0;
      const currentEpoch = hasMainEpoch
        ? Math.trunc(epochRow!.value as number)
        : Math.max(0, Math.trunc(params.fallbackVaultEpoch ?? 0));

      if (params.expectedEpoch !== undefined && currentEpoch !== params.expectedEpoch) {
        failTx(
          new MainTxError(
            'epoch-mismatch',
            '系统已执行过备份恢复，历史上下文请求已过期，请刷新当前状态后再操作。',
          ),
        );
        return;
      }

      const existingOp =
        opRow?.value && typeof opRow.value === 'object'
          ? (opRow.value as CoachMainOpLogRecord)
          : undefined;

      // 优先检查同幂等键：命中则不重复检查 expectedRevision/锁，也不执行任何写操作
      if (existingOp && existingOp.operationId === params.operationId) {
        if (existingOp.restoreEpoch !== currentEpoch) {
          failTx(
            new MainTxError(
              'epoch-mismatch',
              '该幂等操作键归属备份恢复前纪元，已拒绝重放。',
            ),
          );
          return;
        }
        if (existingOp.argsDigest !== argsDigest) {
          failTx(
            new MainTxError(
              'invalid-input',
              '相同 operationId 的请求参数与首次提交不一致，已阻断重放。',
            ),
          );
          return;
        }
        const replayedReceipt = receiptFromMainOpLog(existingOp);
        pendingResult = {
          receipt: replayedReceipt,
          opLog: existingOp,
          session: currentSession,
          plan: currentPlan,
          replayed: true,
        };
        return;
      }

      // 写入路径锁校验（对齐 src/db/tx.ts 语义）
      if (params.lockCheck) {
        const ttlMs = params.lockCheck.ttlMs ?? DEFAULT_LOCK_TTL_MS;
        const editorId = params.lockCheck.editorId ?? '';
        const st = interpretLock(lockRaw, now, ttlMs);
        if (st.kind === 'corrupt') {
          failTx(
            new MainTxError('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制'),
          );
          return;
        }
        if (params.lockCheck.lockPolicy === 'optional') {
          if (st.kind === 'held' && st.editorId !== editorId && !st.expired) {
            failTx(
              new MainTxError(
                'lock-lost',
                '这条训练正在另一个标签页中编辑，当前写入已让位。',
                revisionOfSession(currentSession),
              ),
            );
            return;
          }
        } else {
          if (st.kind !== 'held') {
            failTx(
              new MainTxError(
                'no-lock',
                '本页没有这个训练的编辑锁，不能写入。请刷新后重新取得控制。',
                revisionOfSession(currentSession),
              ),
            );
            return;
          }
          if (!lockGrantsWrite(lockRaw, editorId, now, ttlMs)) {
            failTx(
              new MainTxError(
                'lock-lost',
                st.editorId === editorId
                  ? '编辑锁已过期，请重新取得控制后再保存'
                  : '这个训练已在另一个标签页中被接管，本页不再写入',
                revisionOfSession(currentSession),
              ),
            );
            return;
          }
        }
      }

      const currentTemplate = tplRow?.value as ExerciseTemplate | undefined;
      let prepared: MainTxPreparedWrite<T>;
      try {
        prepared = params.prepare({
          now,
          currentEpoch,
          currentSession,
          currentPlan,
          allPlans,
          currentTemplate,
          priorOpLogs: priorOpLogsByIdx.filter((x): x is CoachMainOpLogRecord => Boolean(x)),
        });
      } catch (err) {
        failTx(
          err instanceof Error ? err : new MainTxError('invalid-input', String(err)),
        );
        return;
      }

      try {
        if (!hasMainEpoch) {
          metaStore.put({ key: COACH_RESTORE_EPOCH_META_KEY, value: currentEpoch });
        }
        if (prepared.nextSession && sessionsStore) {
          sessionsStore.put(prepared.nextSession);
        }
        if (prepared.insertPlan && plansStore) {
          plansStore.add(prepared.insertPlan);
        } else if (prepared.nextPlan && plansStore) {
          plansStore.put(prepared.nextPlan);
        }
        if (prepared.nextSettings && settingsStore) {
          settingsStore.put(prepared.nextSettings);
        }
        if (prepared.nextTemplate) {
          metaStore.put({ key: prepared.nextTemplate.key, value: prepared.nextTemplate });
        }
        if (prepared.deleteTemplateExerciseId) {
          metaStore.delete(`exercise-template:${prepared.deleteTemplateExerciseId}`);
        }
        if (prepared.durableRestTimer) {
          metaStore.put({
            key: `${REST_TIMER_STATE_META_PREFIX}${prepared.durableRestTimer.sessionId}`,
            value: prepared.durableRestTimer,
          });
        } else if (prepared.deleteRestTimerSessionId) {
          metaStore.delete(`${REST_TIMER_STATE_META_PREFIX}${prepared.deleteRestTimerSessionId}`);
        }

        const storedOp: CoachMainOpLogRecord = {
          ...prepared.opLog,
          schemaVersion: 2,
          argsDigest,
          restoreEpoch: currentEpoch,
        };
        metaStore.put({
          key: `${COACH_OP_META_PREFIX}${params.operationId}`,
          value: storedOp,
        });

        const finalSession = prepared.nextSession ?? currentSession;
        const finalPlan = prepared.insertPlan ?? prepared.nextPlan ?? currentPlan;

        // 超过 550 条 meta 记录时做有界淘汰，仅清理已完成且非当前训练的老旧 coach-op:* 记录，保留最近 500 条
        if (metaCount > 550) {
          const rangeReq =
            typeof IDBKeyRange !== 'undefined'
              ? metaStore.getAll(IDBKeyRange.bound(COACH_OP_META_PREFIX, `${COACH_OP_META_PREFIX}\uffff`))
              : metaStore.getAll();
          rangeReq.onsuccess = () => {
            const rows = (rangeReq.result ?? []) as Array<{ key?: unknown; value?: unknown }>;
            const opRows = rows
              .filter(
                (r) =>
                  typeof r.key === 'string' &&
                  r.key.startsWith(COACH_OP_META_PREFIX) &&
                  r.key !== `${COACH_OP_META_PREFIX}${params.operationId}`,
              )
              .map((r) => ({ key: r.key as string, op: r.value as CoachMainOpLogRecord }));
            const staleCandidates = opRows
              .filter(
                (x) =>
                  x.op &&
                  x.op.entityId !== params.sessionId &&
                  (x.op.undone || x.op.scope !== 'session'),
              )
              .sort((a, b) => (a.op?.createdAt ?? 0) - (b.op?.createdAt ?? 0));
            const excess = opRows.length - 500;
            if (excess > 0) {
              for (const victim of staleCandidates.slice(0, excess)) {
                metaStore.delete(victim.key);
              }
            }
          };
        }

        pendingResult = {
          receipt: receiptFromMainOpLog(storedOp),
          opLog: storedOp,
          session: finalSession,
          plan: finalPlan,
          template: prepared.nextTemplate,
          replayed: false,
          meta: prepared.meta,
        };
      } catch (err) {
        failTx(
          err instanceof Error
            ? err
            : new MainTxError('storage', '写入主库与操作账本失败'),
        );
      }
    };

    const reqEpoch = metaStore.get(COACH_RESTORE_EPOCH_META_KEY);
    reqEpoch.onerror = () => failTx(new MainTxError('storage', '读取主库纪元失败'));
    reqEpoch.onsuccess = () => {
      epochRow = reqEpoch.result as typeof epochRow;
      step();
    };

    const reqOp = metaStore.get(`${COACH_OP_META_PREFIX}${params.operationId}`);
    reqOp.onerror = () => failTx(new MainTxError('storage', '读取操作账本失败'));
    reqOp.onsuccess = () => {
      opRow = reqOp.result as typeof opRow;
      step();
    };

    priorIds.forEach((pid, idx) => {
      const reqPrior = metaStore.get(`${COACH_OP_META_PREFIX}${pid}`);
      reqPrior.onerror = () => failTx(new MainTxError('storage', '读取同批前置操作账本失败'));
      reqPrior.onsuccess = () => {
        const row = reqPrior.result as { value?: unknown } | undefined;
        if (row?.value && typeof row.value === 'object') {
          priorOpLogsByIdx[idx] = row.value as CoachMainOpLogRecord;
        }
        step();
      };
    });

    const reqCount = metaStore.count();
    reqCount.onerror = () => {
      metaCount = 0;
      step();
    };
    reqCount.onsuccess = () => {
      metaCount = typeof reqCount.result === 'number' ? reqCount.result : 0;
      step();
    };

    if (params.lockCheck) {
      const reqLock = metaStore.get(lockKey(params.lockCheck.sessionId));
      reqLock.onerror = () => failTx(new MainTxError('storage', '读取编辑锁失败'));
      reqLock.onsuccess = () => {
        lockRaw = reqLock.result;
        step();
      };
    }

    if (sessionsStore && params.sessionId) {
      const reqSess = sessionsStore.get(params.sessionId);
      reqSess.onerror = () => failTx(new MainTxError('storage', '读取训练记录失败'));
      reqSess.onsuccess = () => {
        currentSession = reqSess.result as Session | undefined;
        step();
      };
    }

    if (plansStore && params.planId) {
      const reqPlan = plansStore.get(params.planId);
      reqPlan.onerror = () => failTx(new MainTxError('storage', '读取计划失败'));
      reqPlan.onsuccess = () => {
        currentPlan = reqPlan.result as Plan | undefined;
        step();
      };
    }

    if (plansStore && params.needAllPlans) {
      const reqAllPlans = plansStore.getAll();
      reqAllPlans.onerror = () => failTx(new MainTxError('storage', '读取计划列表失败'));
      reqAllPlans.onsuccess = () => {
        allPlans = (reqAllPlans.result ?? []) as Plan[];
        step();
      };
    }

    if (params.templateExerciseId) {
      const reqTpl = metaStore.get(`exercise-template:${params.templateExerciseId}`);
      reqTpl.onerror = () => failTx(new MainTxError('storage', '读取动作配置记忆失败'));
      reqTpl.onsuccess = () => {
        tplRow = reqTpl.result as typeof tplRow;
        step();
      };
    }
  });
}

function setsEqualCore(a: SessionSet, b: SessionSet): boolean {
  return (
    a.reps === b.reps &&
    a.weightKg === b.weightKg &&
    a.status === b.status &&
    Boolean(a.toFailure) === Boolean(b.toFailure) &&
    (a.note ?? '') === (b.note ?? '')
  );
}

/**
 * 单事务执行主库权威撤销：
 * 1. 先检查运行时草稿/焦避与待写队列；
 * 2. 在单笔 `motion-training` readwrite 事务中同时核对 `coach-restore-epoch`、`coach-op:<opId>`、目标实体字段状态；
 * 3. v0.2.3 回执缺失主库 `coach-op:*` 直接拒绝，防止盲回滚；
 *    v0.2.2 遗留历史回执在核验未撤销与目标字段一致后执行一次性迁移墓碑（写入 `undone: true` 的 `coach-op:*`），避免 vault 写失败导致二次点击重复回滚。
 */
export async function executeCoachMainUndoTx(params: {
  receipt: CoachOperationReceipt;
  fallbackVaultEpoch: number;
}): Promise<{
  nextReceipt: CoachOperationReceipt;
  alreadyUndoneInMain: boolean;
  session?: Session;
  plan?: Plan;
  deletedPlanId?: string;
  templatesChanged?: boolean;
  stopTimerSessionId?: string;
}> {
  const { receipt, fallbackVaultEpoch } = params;
  if (receipt.undoable === false) {
    throw new MainTxError(
      'state-conflict',
      '已结束训练的完训动作不支持通过聊天回执直接复活，请在历史中调整',
    );
  }
  if (receipt.undone) {
    throw new MainTxError('state-conflict', '该操作回执已经撤销过了');
  }

  // 撤销前先等待进行中的前台编辑器写队列并核查焦点冲突
  const runtimeBySession = new Map<string, ReturnType<typeof getActiveSessionRuntime>>();
  for (const target of receipt.touchedTargets) {
    if ('sessionId' in target && target.sessionId) {
      const rt = getActiveSessionRuntime(target.sessionId);
      if (rt) {
        await rt.awaitPendingWrites();
        runtimeBySession.set(target.sessionId, rt);
      }
      if (target.kind === 'session-set') {
        const focus = checkFocusConflict({
          sessionId: target.sessionId,
          exId: target.exId,
          setId: target.setId,
        });
        if (focus.conflict) {
          throw new MainTxError(
            'focus-conflict',
            focus.message ?? '目标输入框正在编辑中，请稍后再撤销',
          );
        }
      } else if (target.kind === 'exercise-target') {
        const focus = checkFocusConflict({
          sessionId: target.sessionId,
          exId: target.exId,
          fields: ['target'],
        });
        if (focus.conflict) {
          throw new MainTxError('focus-conflict', focus.message ?? '目标动作正在编辑中');
        }
      }
    }
  }

  const db = await openDb();
  return new Promise((resolve, reject) => {
    let settled = false;
    const rejectOnce = (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const resolveOnce = (val: {
      nextReceipt: CoachOperationReceipt;
      alreadyUndoneInMain: boolean;
      session?: Session;
      plan?: Plan;
      deletedPlanId?: string;
      templatesChanged?: boolean;
      stopTimerSessionId?: string;
    }) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    let tx: IDBTransaction;
    try {
      tx = db.transaction(['meta', 'sessions', 'plans', 'settings'], 'readwrite');
    } catch (err) {
      rejectOnce(new MainTxError('storage', err instanceof Error ? err.message : '开启撤销事务失败'));
      return;
    }

    let abortReason: Error | null = null;
    let pendingOut: {
      nextReceipt: CoachOperationReceipt;
      alreadyUndoneInMain: boolean;
      session?: Session;
      plan?: Plan;
      deletedPlanId?: string;
      templatesChanged?: boolean;
      stopTimerSessionId?: string;
    } | null = null;

    const failTx = (err: Error) => {
      abortReason = err;
      try {
        tx.abort();
      } catch {
        /* ignore */
      }
      rejectOnce(err);
    };

    tx.oncomplete = () => {
      if (pendingOut) resolveOnce(pendingOut);
      else rejectOnce(abortReason ?? new MainTxError('storage', '撤销事务完成但未返回结果'));
    };
    tx.onerror = () => {
      rejectOnce(abortReason ?? new MainTxError('storage', tx.error?.message ?? '撤销事务失败'));
    };
    tx.onabort = () => {
      rejectOnce(abortReason ?? new MainTxError('storage', tx.error?.message ?? '撤销事务被中止'));
    };

    const metaStore = tx.objectStore('meta');
    const sessionsStore = tx.objectStore('sessions');
    const plansStore = tx.objectStore('plans');
    const settingsStore = tx.objectStore('settings');

    const neededSessionIds = new Set<string>();
    const neededPlanIds = new Set<string>();
    const neededTemplateIds = new Set<string>();
    let needAllPlansForDelete = false;
    let needSettingsForDelete = false;
    let durableTimerSessionId: string | undefined;

    for (const target of receipt.touchedTargets) {
      if ('sessionId' in target && target.sessionId) {
        neededSessionIds.add(target.sessionId);
      }
      if (target.kind === 'plan-created') {
        neededPlanIds.add(target.planId);
        needAllPlansForDelete = true;
        needSettingsForDelete = true;
      } else if (target.kind === 'plan-day') {
        neededPlanIds.add(target.planId);
      } else if (target.kind === 'setup-note') {
        neededTemplateIds.add(target.exerciseId);
      }
      if (target.kind === 'session-set') {
        durableTimerSessionId = target.sessionId;
      }
    }

    let epochRow: { key?: unknown; value?: unknown } | undefined;
    let opRow: { key?: unknown; value?: unknown } | undefined;
    const loadedSessions = new Map<string, Session | undefined>();
    const loadedLocks = new Map<string, unknown>();
    const loadedPlans = new Map<string, Plan | undefined>();
    const loadedTemplates = new Map<string, ExerciseTemplate | undefined>();
    let allPlans: Plan[] = [];
    let settingsRow: Record<string, unknown> | undefined;
    let durableTimerRow: { key?: unknown; value?: unknown } | undefined;

    let pending =
      2 + // epoch + op
      neededSessionIds.size * 2 + // session + lock
      neededPlanIds.size +
      neededTemplateIds.size +
      (needAllPlansForDelete ? 1 : 0) +
      (needSettingsForDelete ? 1 : 0) +
      (durableTimerSessionId ? 1 : 0);

    const step = () => {
      pending -= 1;
      if (pending > 0) return;

      const now = Date.now();
      const hasMainEpoch =
        epochRow &&
        typeof epochRow.value === 'number' &&
        Number.isFinite(epochRow.value) &&
        epochRow.value >= 0;
      const currentEpoch = hasMainEpoch
        ? Math.trunc(epochRow!.value as number)
        : Math.max(0, Math.trunc(fallbackVaultEpoch));

      if (receipt.restoreEpoch !== currentEpoch) {
        failTx(
          new MainTxError(
            'epoch-mismatch',
            '系统已执行过备份恢复，恢复前产生的教练回执已自动失效，无法撤销。',
          ),
        );
        return;
      }

      const existingOp =
        opRow?.value && typeof opRow.value === 'object'
          ? (opRow.value as CoachMainOpLogRecord)
          : undefined;

      if (existingOp) {
        if (existingOp.undone) {
          // 主库已经执行过 Undo（可能是 vault 回执写失败后再次点 Undo）：0 二次改动，同步修复回执状态
          pendingOut = {
            nextReceipt: {
              ...receipt,
              schemaVersion: 2,
              undone: true,
              undoneAt: existingOp.undoneAt ?? now,
            },
            alreadyUndoneInMain: true,
          };
          return;
        }
      } else if ((receipt.schemaVersion ?? 1) >= 2) {
        failTx(
          new MainTxError(
            'dirty-state',
            '主库操作账本缺失，为防止盲目回滚造成状态破坏，已拒绝本次撤销。',
          ),
        );
        return;
      }

      let outSession: Session | undefined;
      let outPlan: Plan | undefined;
      let deletedPlanId: string | undefined;
      let templatesChanged = false;
      let stopTimerSessionId: string | undefined;

      try {
        for (const target of receipt.touchedTargets) {
          if (target.kind === 'session-set') {
            const rt = runtimeBySession.get(target.sessionId) ?? null;
            const current = loadedSessions.get(target.sessionId);
            if (!current || current.status !== 'active') {
              throw new MainTxError(
                'state-conflict',
                '训练已结束或记录已不存在，无法按进行中会话撤销',
              );
            }
            verifyLockInTx(loadedLocks.get(target.sessionId), rt?.editorId, rt ? 'required' : 'optional', now);
            const ex = current.exercises.find((e) => e.id === target.exId);
            const curSet = ex?.sets.find((s) => s.id === target.setId);
            if (!ex || !curSet) {
              throw new MainTxError('field-conflict', '目标组已被删除，无法安全撤销');
            }
            if (!setsEqualCore(curSet, target.afterSet)) {
              throw new MainTxError(
                'field-conflict',
                '你在教练操作后又修改过同一组数据，已停止撤销以避免覆盖你的最新修改',
              );
            }
            const prefillMap = new Map((target.prefilledSets ?? []).map((p) => [p.setId, p]));
            const rolledBack: Session = {
              ...current,
              revision: revisionOfSession(current) + 1,
              exercises: current.exercises.map((item) => {
                if (item.id !== target.exId) return item;
                return {
                  ...item,
                  sets: item.sets.map((s) => {
                    if (s.id === target.setId) return structuredClone(target.beforeSet);
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
            sessionsStore.put(rolledBack);
            loadedSessions.set(target.sessionId, rolledBack);
            outSession = rolledBack;

            if (durableTimerRow?.value && typeof durableTimerRow.value === 'object') {
              const dt = durableTimerRow.value as DurableRestTimerRecord;
              if (dt.coachOperationId === receipt.operationId) {
                metaStore.delete(`${REST_TIMER_STATE_META_PREFIX}${target.sessionId}`);
                stopTimerSessionId = target.sessionId;
              }
            }
          } else if (target.kind === 'exercise-target') {
            const rt = runtimeBySession.get(target.sessionId) ?? null;
            const current = loadedSessions.get(target.sessionId);
            if (!current || current.status !== 'active') {
              throw new MainTxError('state-conflict', '训练已非进行中状态，无法撤销目标修改');
            }
            verifyLockInTx(loadedLocks.get(target.sessionId), rt?.editorId, rt ? 'required' : 'optional', now);
            const ex = current.exercises.find((e) => e.id === target.exId);
            if (!ex) {
              throw new MainTxError('field-conflict', '目标动作已不存在，无法撤销');
            }
            if (JSON.stringify(ex.target) !== JSON.stringify(target.afterTarget)) {
              throw new MainTxError('field-conflict', '该动作目标在教练修改后又发生了变更，已终止撤销');
            }
            if (target.afterRestSec !== undefined && ex.restSec !== target.afterRestSec) {
              throw new MainTxError('field-conflict', '该动作组间休息在教练修改后又发生了变更，已终止撤销');
            }
            const afterAddedIds = new Set(
              target.afterSets
                .filter((s) => !target.beforeSets.some((b) => b.id === s.id))
                .map((s) => s.id),
            );
            const anyAddedGotLogged = ex.sets.some(
              (s) =>
                afterAddedIds.has(s.id) &&
                (s.status !== 'blank' || s.reps !== null || s.weightKg !== null),
            );
            if (anyAddedGotLogged) {
              throw new MainTxError(
                'field-conflict',
                '新增的目标空白组已被写入实际训练数据，无法安全撤销',
              );
            }
            const applied = applyTargetToSessionExercise(current, ex.id, target.beforeTarget, {
              confirmImpact: true,
            });
            if (!applied.applied) {
              throw new MainTxError('field-conflict', applied.message);
            }
            const rolledSession: Session = {
              ...(target.beforeRestSec !== undefined
                ? withExercise(applied.session, ex.id, { restSec: target.beforeRestSec })
                : applied.session),
              revision: revisionOfSession(current) + 1,
            };
            sessionsStore.put(rolledSession);
            loadedSessions.set(target.sessionId, rolledSession);
            outSession = rolledSession;
          } else if (target.kind === 'exercise-superset') {
            const rt = runtimeBySession.get(target.sessionId) ?? null;
            const current = loadedSessions.get(target.sessionId);
            if (!current || current.status !== 'active') {
              throw new MainTxError('state-conflict', '训练已非进行中状态，无法撤销超级组改动');
            }
            verifyLockInTx(loadedLocks.get(target.sessionId), rt?.editorId, rt ? 'required' : 'optional', now);
            if (revisionOfSession(current) !== receipt.afterRevision) {
              const beforeTouched = JSON.stringify(target.afterSession.exercises);
              const curTouched = JSON.stringify(current.exercises);
              if (beforeTouched !== curTouched) {
                throw new MainTxError('field-conflict', '超级组动作在撤销前已发生其他变更，已阻止覆盖撤销');
              }
            }
            const rolledBack: Session = {
              ...current,
              revision: revisionOfSession(current) + 1,
              exercises: cleanOrphanPairIds(structuredClone(target.beforeSession.exercises)),
            };
            sessionsStore.put(rolledBack);
            loadedSessions.set(target.sessionId, rolledBack);
            outSession = rolledBack;
          } else if (target.kind === 'history-edit') {
            const current = loadedSessions.get(target.sessionId);
            if (!current || current.status !== 'completed') {
              throw new MainTxError('state-conflict', '历史记录已不存在或状态异常，无法撤销');
            }
            verifyLockInTx(loadedLocks.get(target.sessionId), undefined, 'optional', now);
            if (revisionOfSession(current) !== receipt.afterRevision) {
              throw new MainTxError(
                'version-conflict',
                '该历史记录之后已被其他入口再次编辑，无法回滚覆盖',
                revisionOfSession(current),
              );
            }
            const rolledBack: Session = {
              ...structuredClone(target.beforeSession),
              revision: revisionOfSession(current) + 1,
            };
            sessionsStore.put(rolledBack);
            loadedSessions.set(target.sessionId, rolledBack);
            outSession = rolledBack;
          } else if (target.kind === 'plan-created') {
            const curPlan = loadedPlans.get(target.planId);
            if (!curPlan) {
              throw new MainTxError('not-found', '新建的计划已被手动删除，无需撤销');
            }
            if (
              receipt.afterPlanRevision !== undefined &&
              curPlan.updatedAt !== receipt.afterPlanRevision
            ) {
              throw new MainTxError('field-conflict', '该新建计划创建后已被修改，已阻止整份删除式撤销');
            }
            const remaining = allPlans.filter((p) => p.id !== target.planId).map((p) => p.id);
            const curSettingId = (settingsRow?.currentPlanId as string | null | undefined) ?? null;
            plansStore.delete(target.planId);
            if (curSettingId === target.planId && settingsRow) {
              settingsStore.put({
                ...settingsRow,
                key: 'app',
                currentPlanId: remaining[0] ?? null,
              });
            }
            deletedPlanId = target.planId;
          } else if (target.kind === 'plan-day') {
            const curPlan = loadedPlans.get(target.planId);
            if (!curPlan) {
              throw new MainTxError('not-found', '找不到要撤销修改的计划');
            }
            if (
              receipt.afterPlanRevision !== undefined &&
              curPlan.updatedAt !== receipt.afterPlanRevision
            ) {
              throw new MainTxError(
                'version-conflict',
                '目标计划已在别处被修改，已拒绝对计划的过期覆盖',
                curPlan.updatedAt,
              );
            }
            const rolledPlan: Plan = {
              ...structuredClone(target.beforePlan),
              updatedAt: now,
            };
            plansStore.put(rolledPlan);
            loadedPlans.set(target.planId, rolledPlan);
            outPlan = rolledPlan;
          } else if (target.kind === 'session-snapshot') {
            const rt = runtimeBySession.get(target.sessionId) ?? null;
            const current = loadedSessions.get(target.sessionId);
            if (!current || current.status !== 'active') {
              throw new MainTxError('state-conflict', '训练已结束或记录已不存在，无法撤销本次修改');
            }
            verifyLockInTx(loadedLocks.get(target.sessionId), rt?.editorId, rt ? 'required' : 'optional', now);
            if (revisionOfSession(current) !== receipt.afterRevision) {
              throw new MainTxError(
                'version-conflict',
                '你在教练操作后又修改过本次训练数据，已停止整项撤销以避免覆盖后续改动',
                revisionOfSession(current),
              );
            }
            const rolledBack: Session = {
              ...structuredClone(target.beforeSession),
              revision: revisionOfSession(current) + 1,
              exercises: cleanOrphanPairIds(structuredClone(target.beforeSession.exercises)),
            };
            sessionsStore.put(rolledBack);
            loadedSessions.set(target.sessionId, rolledBack);
            outSession = rolledBack;
          } else if (target.kind === 'setup-note') {
            const curTpl = loadedTemplates.get(target.exerciseId);
            if (target.beforeTemplate) {
              if (!curTpl || (target.afterTemplate && curTpl.revision !== target.afterTemplate.revision)) {
                throw new MainTxError('field-conflict', '动作配置记忆在之后被更新，已停止撤销');
              }
              metaStore.put({
                key: `exercise-template:${target.exerciseId}`,
                value: {
                  ...structuredClone(target.beforeTemplate),
                  revision: curTpl.revision + 1,
                  updatedAt: now,
                },
              });
            } else if (curTpl && target.afterTemplate && curTpl.revision === target.afterTemplate.revision) {
              metaStore.delete(`exercise-template:${target.exerciseId}`);
            }

            if (target.sessionId && target.exId) {
              const rt = runtimeBySession.get(target.sessionId) ?? null;
              const current = loadedSessions.get(target.sessionId);
              if (!current || current.status !== 'active') {
                throw new MainTxError('state-conflict', '训练已结束，无法撤销进行中器械档位联动修改');
              }
              verifyLockInTx(loadedLocks.get(target.sessionId), rt?.editorId, rt ? 'required' : 'optional', now);
              const ex = current.exercises.find((e) => e.id === target.exId);
              if (!ex) throw new MainTxError('field-conflict', '原动作已不存在，无法撤销器械档位');
              if ((ex.setupNote ?? undefined) !== (target.afterSessionNote ?? undefined)) {
                throw new MainTxError('field-conflict', '你在之后又改过该器械档位，已停止撤销');
              }
              const nextSession: Session = {
                ...current,
                revision: revisionOfSession(current) + 1,
                exercises: current.exercises.map((e) =>
                  e.id === target.exId ? withSetupNote(e, target.beforeSessionNote) : e,
                ),
              };
              sessionsStore.put(nextSession);
              loadedSessions.set(target.sessionId, nextSession);
              outSession = nextSession;
            }
            templatesChanged = true;
          }
        }

        if (!hasMainEpoch) {
          metaStore.put({ key: COACH_RESTORE_EPOCH_META_KEY, value: currentEpoch });
        }
        const tombstoneOp: CoachMainOpLogRecord = existingOp
          ? { ...existingOp, undone: true, undoneAt: now }
          : {
              schemaVersion: 2,
              operationId: receipt.operationId,
              receiptId: receipt.id,
              toolName: receipt.toolName,
              argsDigest: 'legacy-v1-migrated',
              createdAt: receipt.createdAt,
              restoreEpoch: currentEpoch,
              scope: receipt.scope,
              summary: receipt.summary,
              entityType: receipt.entityType,
              entityId: receipt.entityId,
              ...(receipt.planId ? { planId: receipt.planId } : {}),
              beforeRevision: receipt.beforeRevision,
              afterRevision: receipt.afterRevision,
              ...(receipt.beforePlanRevision !== undefined
                ? { beforePlanRevision: receipt.beforePlanRevision }
                : {}),
              ...(receipt.afterPlanRevision !== undefined
                ? { afterPlanRevision: receipt.afterPlanRevision }
                : {}),
              undoable: receipt.undoable ?? true,
              undone: true,
              undoneAt: now,
              touchedTargets: receipt.touchedTargets,
              migratedFromLegacy: true,
            };
        metaStore.put({
          key: `${COACH_OP_META_PREFIX}${receipt.operationId}`,
          value: tombstoneOp,
        });

        pendingOut = {
          nextReceipt: {
            ...receipt,
            schemaVersion: receipt.schemaVersion ?? 2,
            undone: true,
            undoneAt: now,
          },
          alreadyUndoneInMain: false,
          session: outSession,
          plan: outPlan,
          deletedPlanId,
          templatesChanged,
          stopTimerSessionId,
        };
      } catch (err) {
        failTx(err instanceof Error ? err : new MainTxError('storage', String(err)));
      }
    };

    const reqEpoch = metaStore.get(COACH_RESTORE_EPOCH_META_KEY);
    reqEpoch.onerror = () => failTx(new MainTxError('storage', '读取主库纪元失败'));
    reqEpoch.onsuccess = () => {
      epochRow = reqEpoch.result as typeof epochRow;
      step();
    };

    const reqOp = metaStore.get(`${COACH_OP_META_PREFIX}${receipt.operationId}`);
    reqOp.onerror = () => failTx(new MainTxError('storage', '读取操作账本失败'));
    reqOp.onsuccess = () => {
      opRow = reqOp.result as typeof opRow;
      step();
    };

    for (const sid of neededSessionIds) {
      const sReq = sessionsStore.get(sid);
      sReq.onerror = () => failTx(new MainTxError('storage', '读取训练记录失败'));
      sReq.onsuccess = () => {
        loadedSessions.set(sid, sReq.result as Session | undefined);
        step();
      };
      const lReq = metaStore.get(lockKey(sid));
      lReq.onerror = () => failTx(new MainTxError('storage', '读取编辑锁失败'));
      lReq.onsuccess = () => {
        loadedLocks.set(sid, lReq.result);
        step();
      };
    }

    for (const pid of neededPlanIds) {
      const pReq = plansStore.get(pid);
      pReq.onerror = () => failTx(new MainTxError('storage', '读取计划失败'));
      pReq.onsuccess = () => {
        loadedPlans.set(pid, pReq.result as Plan | undefined);
        step();
      };
    }

    for (const exId of neededTemplateIds) {
      const tReq = metaStore.get(`exercise-template:${exId}`);
      tReq.onerror = () => failTx(new MainTxError('storage', '读取动作模板失败'));
      tReq.onsuccess = () => {
        const row = tReq.result as { value?: ExerciseTemplate } | undefined;
        loadedTemplates.set(exId, row?.value);
        step();
      };
    }

    if (needAllPlansForDelete) {
      const allReq = plansStore.getAll();
      allReq.onerror = () => failTx(new MainTxError('storage', '读取计划列表失败'));
      allReq.onsuccess = () => {
        allPlans = (allReq.result ?? []) as Plan[];
        step();
      };
    }

    if (needSettingsForDelete) {
      const stReq = settingsStore.get('app');
      stReq.onerror = () => failTx(new MainTxError('storage', '读取设置失败'));
      stReq.onsuccess = () => {
        settingsRow = stReq.result as Record<string, unknown> | undefined;
        step();
      };
    }

    if (durableTimerSessionId) {
      const dtReq = metaStore.get(`${REST_TIMER_STATE_META_PREFIX}${durableTimerSessionId}`);
      dtReq.onerror = () => step();
      dtReq.onsuccess = () => {
        durableTimerRow = dtReq.result as typeof durableTimerRow;
        step();
      };
    }
  });
}

function verifyLockInTx(
  lockRaw: unknown,
  editorId: string | undefined,
  policy: 'required' | 'optional',
  now: number,
): void {
  const st = interpretLock(lockRaw, now, DEFAULT_LOCK_TTL_MS);
  if (st.kind === 'corrupt') {
    throw new MainTxError('corrupt-lock', '编辑锁记录已损坏，请刷新页面重新取得控制');
  }
  if (policy === 'optional') {
    if (st.kind === 'held' && st.editorId !== (editorId ?? '') && !st.expired) {
      throw new MainTxError('lock-lost', '这条训练正在另一个标签页中编辑，当前操作已让位');
    }
    return;
  }
  if (st.kind !== 'held') {
    throw new MainTxError('no-lock', '本页没有这个训练的编辑锁，不能写入。请刷新后重新取得控制。');
  }
  if (!lockGrantsWrite(lockRaw, editorId ?? '', now, DEFAULT_LOCK_TTL_MS)) {
    throw new MainTxError(
      'lock-lost',
      st.editorId === editorId
        ? '编辑锁已过期，请重新取得控制后再保存'
        : '这个训练已在另一个标签页中被接管，本页不再写入',
    );
  }
}
