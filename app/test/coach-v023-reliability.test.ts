/* v0.2.3 电子教练可靠性、幂等事务、崩溃恢复、备份隔离、协议流完整性与跨进程计时回归套件。 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COACH_OP_META_PREFIX,
  COACH_RESTORE_EPOCH_META_KEY,
  __resetDbHandle,
  idbClear,
  idbDelete,
  idbGet,
  idbPut,
} from '../src/db/idb';
import {
  CURRENT_APP_VERSION,
  buildBackup,
  getSession,
  restoreBackup,
  savePlan,
} from '../src/db/repo';
import { atomicCreateSession, atomicWriteSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import { compressCoachContext, purgeDeletedMemoryFromCoachHistory, resumePendingCoachTurn, runCoachTurn } from '../src/coach/coachAgent';
import {
  createEmptyCoachMemory,
  loadCoachMemory,
  saveCoachMemory,
  upsertCoachMemoryItem,
} from '../src/coach/coachMemory';
import {
  appendProtocolEntriesStrict,
  findSavedProviderConfigForRoute,
  getCoachRestoreEpoch,
  getPendingTurn,
  listCoachReceipts,
  listPendingTurns,
  listProtocolEntries,
  loadCoachThreadsState,
  loadCoachMessages,
  saveCoachMessages,
  resetCoachVaultForTest,
  saveCoachProviderConfig,
  saveCoachReceipt,
  saveCoachThreadsState,
  savePendingTurnStrict,
  type CoachOperationReceipt,
  type CoachPendingTurn,
} from '../src/coach/coachStorage';
import { buildCoachReadOnlyContext, validateToolCallBatch, ALLOWED_BUSINESS_TOOL_NAMES } from '../src/coach/coachTools';
import { coachRecordActiveSet, undoCoachReceipt } from '../src/coach/coachTx';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import { buildAnthropicRequest, streamCoachTurn, type CoachStreamEvent } from '../src/coach/providerAdapter';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';
import {
  clearDurableRestTimerIfMatches,
  reconcileRestTimerRecovery,
  type DurableRestTimerRecord,
} from '../src/lib/restTimerDurable';

const NOW = 1_766_000_000_000;

async function resetEverything(): Promise<void> {
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');
}

function makePlan(): Plan {
  const base = createV32Plan(NOW);
  return {
    ...base,
    id: 'plan-v023-rel',
    name: 'v023 可靠性测试计划',
    days: [base.days[0]],
    cursor: 0,
  };
}

async function seedActive(opts?: {
  sessionId?: string;
  startRestTimer?: (sec: number, src: { sessionExerciseId: string; setId?: string }) => void;
  startRestTimerWithDirective?: (d: {
    operationId: string;
    restSec: number;
    source: { sessionExerciseId: string; setId?: string };
    token: string;
    deadlineAtMs: number;
    createdAt: number;
    restoreEpoch: number;
  }) => void;
}): Promise<{ plan: Plan; session: Session }> {
  const plan = makePlan();
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = {
    ...raw,
    id: opts?.sessionId ?? 'sess-v023-rel-1',
  };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-v023');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-v023',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: opts?.startRestTimer ?? (() => undefined),
    startRestTimerWithDirective: opts?.startRestTimerWithDirective,
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh };
}

function injectOnceVaultTxFailure(targetStoreName: string, message: string): () => void {
  const origTx = IDBDatabase.prototype.transaction;
  let tripped = false;
  IDBDatabase.prototype.transaction = function (
    storeNames: string | Iterable<string>,
    mode?: IDBTransactionMode,
    options?: IDBTransactionOptions,
  ) {
    const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
    if (!tripped && this.name === 'motion-coach-vault' && names.includes(targetStoreName) && mode === 'readwrite') {
      tripped = true;
      throw new DOMException(message, 'AbortError');
    }
    return origTx.call(this, storeNames, mode, options);
  };
  return () => {
    IDBDatabase.prototype.transaction = origTx;
  };
}

async function collectDone(gen: AsyncGenerator<CoachStreamEvent>) {
  let done: Extract<CoachStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of gen) {
    if (ev.type === 'done') done = ev;
  }
  return done!;
}

function makeSseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const line of chunks) c.enqueue(enc.encode(line));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('MOTION v0.2.3 写入可靠性、幂等闭环、崩溃恢复与协议完整性', () => {
  beforeEach(async () => {
    await resetEverything();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Vault 回执写入中止后重载同键重试：无论带不带 expectedRevision 均只记 1 组并补全可撤销回执，同键异参拒写', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const restoreVaultTx = injectOnceVaultTxFailure('receipts', 'Simulated vault quota abort');

    let firstReceiptId = '';
    try {
      const r1 = await coachRecordActiveSet({
        operationId: 'op-vault-abort-1',
        sessionId: session.id,
        exId,
        roundIndex: 1,
        reps: 10,
        weightKg: 60,
        expectedRevision: session.revision,
        status: 'done',
      });
      firstReceiptId = r1.receipt.id;
    } finally {
      restoreVaultTx();
    }

    // 主库已提交 1 组，vault 未写入回执（模拟重载后回执库空缺）
    const afterFirst = (await getSession(session.id))!;
    expect(afterFirst.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    const receiptsBeforeRetry = await listCoachReceipts();
    expect(receiptsBeforeRetry).toHaveLength(0);

    // 1a. 重载后按同键 + 原 expectedRevision 重试：不报冲突，只补回执，完成组仍为 1
    const retryWithPinnedRev = await coachRecordActiveSet({
      operationId: 'op-vault-abort-1',
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      expectedRevision: session.revision,
      status: 'done',
    });
    expect(retryWithPinnedRev.replayed).toBe(true);
    expect(retryWithPinnedRev.receipt.id).toBe(firstReceiptId);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(await listCoachReceipts()).toHaveLength(1);

    // 1b. 同键不带 expectedRevision 重试：同样命中幂等，不写入第 2 组
    const retryWithoutRev = await coachRecordActiveSet({
      operationId: 'op-vault-abort-1',
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      status: 'done',
    });
    expect(retryWithoutRev.replayed).toBe(true);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);

    // 1c. 同 operationId 但参数不同：必须拒写
    await expect(
      coachRecordActiveSet({
        operationId: 'op-vault-abort-1',
        sessionId: session.id,
        exId,
        roundIndex: 1,
        reps: 15,
        weightKg: 60,
        status: 'done',
      }),
    ).rejects.toThrow(/不一致|阻断/);

    // 1d. 找回回执可干净撤销到 0 组
    await undoCoachReceipt(retryWithPinnedRev.receipt.id);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);
  });

  it('2. Phase 2 待执行意图（pendingTurns）持久化失败时业务零写入', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const threads = await loadCoachThreadsState();
    await saveCoachThreadsState(threads);

    const sseFetch: typeof fetch = vi.fn(async () =>
      makeSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'srv-call-fail-pt',
                    function: {
                      name: 'record_active_set',
                      arguments: JSON.stringify({
                        sessionId: session.id,
                        exId,
                        roundIndex: 1,
                        reps: 12,
                        weightKg: 50,
                        status: 'done',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    // 放行 Phase 1 (running_model) 写入，拦截 Phase 2 (awaiting_tools) 写入
    const origTx = IDBDatabase.prototype.transaction;
    let vaultPendingCalls = 0;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
      if (this.name === 'motion-coach-vault' && names.includes('pendingTurns') && mode === 'readwrite') {
        vaultPendingCalls += 1;
        if (vaultPendingCalls >= 3) {
          throw new DOMException('Simulated Phase 2 pendingTurns abort', 'AbortError');
        }
      }
      return origTx.call(this, storeNames, mode, options);
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = sseFetch;
    try {
      await expect(
        runCoachTurn({
          threadId: threads.activeThreadId,
          userText: '帮我记第 1 组 50kg 12 次',
          history: [],
          providerConfig: {
            key: 'provider',
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            apiKey: 'ds-key',
            updatedAt: NOW,
          },
          toolContext: { activeSession: session },
          streamChunkDelayMs: 0,
        }),
      ).rejects.toThrow(/Abort|fail|pending/i);
    } finally {
      globalThis.fetch = origFetch;
      IDBDatabase.prototype.transaction = origTx;
    }

    const latest = (await getSession(session.id))!;
    expect(latest.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);
  });

  it('3. 两项并行工具在第 1 项提交后中断：resumePendingCoachTurn 补执行第 2 项原参数；若中间手改则冲突保护', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const epoch = await getCoachRestoreEpoch();
    const op0 = 'turn-crash-1:r0:c0';
    const op1 = 'turn-crash-1:r0:c1';

    // 预提交第 1 项并构造崩溃现场
    const firstCommit = await coachRecordActiveSet({
      operationId: op0,
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      expectedEpoch: epoch,
      deferTimerDispatch: true,
      status: 'done',
    });

    const threads = await loadCoachThreadsState();
    const segId = 'seg-crash-tools';
    await saveCoachThreadsState({
      ...threads,
      threads: threads.threads.map((t) =>
        t.id === threads.activeThreadId
          ? {
              ...t,
              activeSegmentId: segId,
              segments: {
                [segId]: {
                  segmentId: segId,
                  startedAt: NOW,
                  reason: 'initial',
                  restoreEpoch: epoch,
                  deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
                  providerKind: 'openai-compatible',
                  model: 'deepseek-chat',
                  thinkingModeKey: 'off',
                  baselineSnapshotJson: '{}',
                  baselineSnapshotHash: 'h',
                  nextSeq: 3,
                },
              },
            }
          : t,
      ),
    });

    const pendingTurn: CoachPendingTurn = {
      turnId: 'turn-crash-1',
      threadId: threads.activeThreadId,
      segmentId: segId,
      status: 'awaiting_tools',
      round: 0,
      userMessageId: 'u-1',
      userPromptText: '记第1和第2组',
      createdAt: NOW,
      updatedAt: NOW,
      restoreEpoch: epoch,
      providerKind: 'openai-compatible',
      deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
      model: 'deepseek-chat',
      plannedToolCalls: [
        {
          toolCallId: 'srv-0',
          index: 0,
          operationId: op0,
          name: 'record_active_set',
          argumentsText: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
          args: { sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' },
          expectedEpoch: epoch,
          status: 'committed',
          receiptId: firstCommit.receipt.id,
        },
        {
          toolCallId: 'srv-1',
          index: 1,
          operationId: op1,
          name: 'record_active_set',
          argumentsText: JSON.stringify({ sessionId: session.id, exId, roundIndex: 2, reps: 8, weightKg: 62.5, expectedRevision: (session.revision ?? 0) + 1, status: 'done' }),
          args: { sessionId: session.id, exId, roundIndex: 2, reps: 8, weightKg: 62.5, expectedRevision: (session.revision ?? 0) + 1, status: 'done' },
          expectedEpoch: epoch,
          status: 'pending',
        },
      ],
    };
    await savePendingTurnStrict(pendingTurn);

    // 场景 A：直接恢复 -> 第 1 项不重复写，第 2 项按原参数 8次 62.5kg 提交
    const resA = await resumePendingCoachTurn({
      pendingTurn,
      toolContext: { activeSession: firstCommit.session },
    });
    expect(resA.resumed).toBe(true);
    expect(resA.receipts).toHaveLength(2);
    const afterResumed = (await getSession(session.id))!;
    expect(afterResumed.exercises[0].sets[0].reps).toBe(10);
    expect(afterResumed.exercises[0].sets[1].reps).toBe(8);
    expect(afterResumed.exercises[0].sets[1].weightKg).toBe(62.5);
    expect(await listPendingTurns(threads.activeThreadId)).toHaveLength(0);

    // 场景 B：第 1 项提交后用户在 UI 手动改了动作 -> expectedRevision 冲突，第 2 项不得覆盖手改
    const opB1 = 'turn-crash-2:r0:c1';
    const pendingWithConflict: CoachPendingTurn = {
      ...pendingTurn,
      turnId: 'turn-crash-2',
      plannedToolCalls: [
        pendingTurn.plannedToolCalls![0],
        {
          toolCallId: 'srv-b1',
          index: 1,
          operationId: opB1,
          name: 'record_active_set',
          argumentsText: JSON.stringify({
            sessionId: session.id,
            exId,
            roundIndex: 3,
            reps: 6,
            weightKg: 70,
            expectedRevision: afterResumed.revision,
            status: 'done',
          }),
          args: {
            sessionId: session.id,
            exId,
            roundIndex: 3,
            reps: 6,
            weightKg: 70,
            expectedRevision: afterResumed.revision,
            status: 'done',
          },
          expectedEpoch: epoch,
          status: 'pending',
        },
      ],
    };
    // 模拟外部手改把 revision 推高并把第 3 组写成 99 次
    const editedSession: Session = {
      ...afterResumed,
      revision: (afterResumed.revision ?? 0) + 1,
      exercises: afterResumed.exercises.map((e, i) =>
        i === 0
          ? {
              ...e,
              sets: e.sets.map((s, si) =>
                si === 2 ? { ...s, reps: 99, weightKg: 88, status: 'done' as const } : s,
              ),
            }
          : e,
      ),
    };
    await idbPut('sessions', editedSession);

    const resB = await resumePendingCoachTurn({
      pendingTurn: pendingWithConflict,
      toolContext: { activeSession: editedSession },
    });
    expect(resB.resumed).toBe(true);
    // 第 2 项因版本冲突被拦截，未生成新回执，手改的 99 次完整保留
    expect(resB.receipts).toHaveLength(1);
    const finalSess = (await getSession(session.id))!;
    expect(finalSess.exercises[0].sets[2].reps).toBe(99);
    expect(finalSess.exercises[0].sets[2].weightKg).toBe(88);
  });

  it('4. 确认流中断（awaiting_followup_model）只续发确认流不重跑工具；草稿确认恢复（awaiting_confirmation）零请求还原卡片', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const epoch = await getCoachRestoreEpoch();
    const opId = 'turn-conf-crash:r0:c0';
    const committed = await coachRecordActiveSet({
      operationId: opId,
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 10,
      weightKg: 55,
      expectedEpoch: epoch,
      deferTimerDispatch: true,
      status: 'done',
    });

    const threads = await loadCoachThreadsState();
    const segId = 'seg-conf-crash';
    await saveCoachThreadsState({
      ...threads,
      threads: threads.threads.map((t) =>
        t.id === threads.activeThreadId
          ? {
              ...t,
              activeSegmentId: segId,
              segments: {
                [segId]: {
                  segmentId: segId,
                  startedAt: NOW,
                  reason: 'initial',
                  restoreEpoch: epoch,
                  deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
                  providerKind: 'openai-compatible',
                  model: 'deepseek-chat',
                  thinkingModeKey: 'high',
                  baselineSnapshotJson: 'BASELINE_CTX',
                  baselineSnapshotHash: 'h',
                  nextSeq: 4,
                },
              },
            }
          : t,
      ),
    });

    await appendProtocolEntriesStrict([
      {
        id: `${threads.activeThreadId}:${segId}:1`,
        threadId: threads.activeThreadId,
        segmentId: segId,
        seq: 1,
        createdAt: NOW,
        kind: 'user',
        wireText: '记第一组 55kg 10次',
      },
      {
        id: `${threads.activeThreadId}:${segId}:2`,
        threadId: threads.activeThreadId,
        segmentId: segId,
        seq: 2,
        createdAt: NOW + 1,
        kind: 'assistant',
        assistantText: '',
        reasoningText: '先记下第一组。',
        toolCalls: [{ id: 'call-conf-1', index: 0, name: 'record_active_set', argumentsText: '{}' }],
      },
      {
        id: `${threads.activeThreadId}:${segId}:3`,
        threadId: threads.activeThreadId,
        segmentId: segId,
        seq: 3,
        createdAt: NOW + 2,
        kind: 'tool',
        toolCallId: 'call-conf-1',
        toolName: 'record_active_set',
        toolResultText: '{"ok":true,"summary":"已记录第 1 组 55kg×10次"}',
      },
    ]);

    const pendingFollowup: CoachPendingTurn = {
      turnId: 'turn-conf-crash',
      threadId: threads.activeThreadId,
      segmentId: segId,
      status: 'awaiting_followup_model',
      round: 1,
      userMessageId: `${threads.activeThreadId}:${segId}:1`,
      userPromptText: '记第一组 55kg 10次',
      createdAt: NOW,
      updatedAt: NOW,
      restoreEpoch: epoch,
      providerKind: 'openai-compatible',
      deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
      model: 'deepseek-chat',
      plannedToolCalls: [
        {
          toolCallId: 'call-conf-1',
          index: 0,
          operationId: opId,
          name: 'record_active_set',
          argumentsText: '{}',
          args: {},
          status: 'committed',
          receiptId: committed.receipt.id,
        },
      ],
    };
    await savePendingTurnStrict(pendingFollowup);

    const requestsSent: Array<{ messages: Array<{ role: string }> }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string }> };
      requestsSent.push(body);
      return makeSseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '第一组 55kg × 10 次已记好。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 800, completion_tokens: 14, prompt_cache_hit_tokens: 720, prompt_cache_miss_tokens: 80 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    try {
      const resumedFollowup = await resumePendingCoachTurn({
        pendingTurn: pendingFollowup,
        toolContext: { activeSession: committed.session },
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: 'ds-key',
          updatedAt: NOW,
        },
      });
      expect(resumedFollowup.resumed).toBe(true);
      expect(resumedFollowup.text).toContain('55kg × 10 次已记好');
      expect(requestsSent).toHaveLength(1);
      expect(requestsSent[0].messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant', 'tool']);
      expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);

      // awaiting_confirmation 草稿恢复：0 请求、0 工具重跑
      const confirmPending: CoachPendingTurn = {
        turnId: 'turn-draft-conf',
        threadId: threads.activeThreadId,
        segmentId: segId,
        status: 'awaiting_confirmation',
        round: 0,
        userMessageId: 'u-draft',
        userPromptText: '按图片新建计划',
        createdAt: NOW,
        updatedAt: NOW,
        restoreEpoch: epoch,
        providerKind: 'openai-compatible',
        deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
        model: 'deepseek-chat',
        pendingDraftPlan: {
          id: 'draft-conf-1',
          planName: '上下肢分化',
          days: [{ dayName: '上肢 A', exercises: [{ kind: 'straight', name: '卧推', sets: 4, repsMin: 6, repsMax: 10, weightMode: 'external', suggestedWeightKg: 70 }] }],
        },
      };
      const resumedDraft = await resumePendingCoachTurn({
        pendingTurn: confirmPending,
        toolContext: { activeSession: committed.session },
      });
      expect(resumedDraft.resumed).toBe(true);
      expect(resumedDraft.draftPlan?.planName).toBe('上下肢分化');
      expect(requestsSent).toHaveLength(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('5. 主库 Undo 成功后 vault 更新失败：再次点 Undo 幂等零改动且补齐回执 undone 状态', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const committed = await coachRecordActiveSet({
      operationId: 'op-undo-partial-fail',
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 12,
      weightKg: 50,
      status: 'done',
    });

    const restoreVaultTx = injectOnceVaultTxFailure('receipts', 'Simulated vault error after main undo');
    try {
      await expect(undoCoachReceipt(committed.receipt.id)).rejects.toThrow();
    } finally {
      restoreVaultTx();
    }

    // 主库实际已撤销完成，revision = 2
    const afterMainUndo = (await getSession(session.id))!;
    expect(afterMainUndo.exercises[0].sets[0].status).toBe('blank');
    const revAfterFirstUndo = afterMainUndo.revision;

    // Vault 中旧回执仍显示未 undone
    const staleReceipts = await listCoachReceipts();
    expect(staleReceipts.find((r) => r.id === committed.receipt.id)?.undone).toBe(false);

    // 二次点 Undo：主库不做第二次回滚（revision 不变），仅把 vault 回执修正为 undone: true
    const healed = await undoCoachReceipt(committed.receipt.id);
    expect(healed.receipt.undone).toBe(true);
    expect(((await getSession(session.id))!).revision).toBe(revAfterFirstUndo);
    expect((await listCoachReceipts()).find((r) => r.id === committed.receipt.id)?.undone).toBe(true);
  });

  it('6. Backup v4 不含 coach-op/epoch/timer；同 sessionId 与 revision 恢复后即使 vault 同步失败旧 pending 与旧 Undo 仍全部拒写', async () => {
    const { session } = await seedActive();
    const exId = session.exercises[0].id;
    const backupBeforeWrite = await buildBackup(CURRENT_APP_VERSION);

    const committed = await coachRecordActiveSet({
      operationId: 'op-backup-invalidation',
      sessionId: session.id,
      exId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      status: 'done',
    });

    const exportedWithOp = await buildBackup(CURRENT_APP_VERSION);
    const exportedStr = JSON.stringify(exportedWithOp);
    expect(exportedStr).not.toContain(COACH_OP_META_PREFIX);
    expect(exportedStr).not.toContain(COACH_RESTORE_EPOCH_META_KEY);
    expect(exportedStr).not.toContain('rest-timer-state:');

    const oldEpoch = await getCoachRestoreEpoch();
    const threads = await loadCoachThreadsState();
    await savePendingTurnStrict({
      turnId: 'turn-pre-restore',
      threadId: threads.activeThreadId,
      segmentId: 'seg-pre-restore',
      status: 'awaiting_tools',
      round: 0,
      userMessageId: 'u-old',
      userPromptText: '旧组',
      createdAt: NOW,
      updatedAt: NOW,
      restoreEpoch: oldEpoch,
      providerKind: 'openai-compatible',
      deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
      model: 'deepseek-chat',
      plannedToolCalls: [
        {
          toolCallId: 'c-old',
          index: 0,
          operationId: 'op-pre-restore-set2',
          name: 'record_active_set',
          argumentsText: '{}',
          args: {
            sessionId: session.id,
            exId,
            roundIndex: 2,
            reps: 10,
            weightKg: 60,
            expectedRevision: backupBeforeWrite.data.sessions[0].revision,
            status: 'done',
          },
          expectedEpoch: oldEpoch,
          status: 'pending',
        },
      ],
    });

    // 故意制造备份前 epoch 与备份内 sessionId + revision 相同，但 vault meta 更新在恢复后失败
    const restoreVaultMetaFail = injectOnceVaultTxFailure('meta', 'Simulated vault epoch failure on restore');
    try {
      await restoreBackup(backupBeforeWrite);
    } finally {
      restoreVaultMetaFail();
    }

    // 主库 epoch 已在同一笔 restore 事务推进且清除旧 coach-op:*
    const mainEpoch = await idbGet<{ value?: number }>('meta', COACH_RESTORE_EPOCH_META_KEY);
    expect(mainEpoch?.value).toBeGreaterThan(oldEpoch);
    expect(await idbGet('meta', `${COACH_OP_META_PREFIX}${committed.receipt.operationId}`)).toBeUndefined();

    // 旧 pending 即使 sessionId 与 revision 全部吻合，仍必须因 epoch 失配而零写入
    const oldPending = (await listPendingTurns(threads.activeThreadId))[0];
    const resumedOld = await resumePendingCoachTurn({
      pendingTurn: oldPending,
      toolContext: { activeSession: await getSession(session.id) },
    });
    expect(resumedOld.expiredByRestore).toBe(true);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);

    // 旧回执撤销也必须被拒绝
    await expect(undoCoachReceipt(committed.receipt.id)).rejects.toThrow(/恢复/);
  });

  it('7. v0.2.2 遗留回执升级：有效 v1 可撤 1->0 且写墓碑防二撤；已撤销/过期/字段冲突继续拦截；v0.2.3 缺主库账本直接拒撤', async () => {
    const { session } = await seedActive();
    const ex = session.exercises[0];
    const epoch = await getCoachRestoreEpoch();

    // 把第 1 组和第 2 组设为 done，模拟 v0.2.2 写入后的主库现场（无 coach-op:* 账本）
    const sDone = await coachRecordActiveSet({
      operationId: 'op-seed-tmp-v2',
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      status: 'done',
    });
    // 删除 op-seed-tmp-v2 主库账本以伪造 v0.2.2 遗留无账本场景，同时构造各类回执
    await idbDelete('meta', `${COACH_OP_META_PREFIX}op-seed-tmp-v2`);
    const curSess = (await getSession(session.id))!;
    const afterSet1 = curSess.exercises[0].sets[0];
    const beforeSet1 = session.exercises[0].sets[0];

    const curSessRev = curSess.revision ?? 1;
    const validLegacyV1: CoachOperationReceipt = {
      id: 'rcpt-legacy-v1-valid',
      operationId: 'op-legacy-v1-valid',
      // 缺省或 schemaVersion: 1 代表 v0.2.2 遗留回执
      toolName: 'record_active_set',
      createdAt: NOW,
      scope: 'session',
      summary: 'v0.2.2 旧回执记组 60kg×10',
      entityType: 'session',
      entityId: curSess.id,
      beforeRevision: curSessRev - 1,
      afterRevision: curSessRev,
      restoreEpoch: epoch,
      undone: false,
      undoable: true,
      touchedTargets: [
        {
          kind: 'session-set',
          sessionId: curSess.id,
          exId: ex.id,
          setId: afterSet1.id,
          beforeSet: beforeSet1,
          afterSet: afterSet1,
        },
      ],
    };

    const alreadyUndoneLegacyV1: CoachOperationReceipt = {
      ...validLegacyV1,
      id: 'rcpt-legacy-v1-undone',
      operationId: 'op-legacy-v1-undone',
      undone: true,
    };

    const staleEpochLegacyV1: CoachOperationReceipt = {
      ...validLegacyV1,
      id: 'rcpt-legacy-v1-stale-epoch',
      operationId: 'op-legacy-v1-stale-epoch',
      restoreEpoch: epoch + 99,
    };

    const missingOpV2: CoachOperationReceipt = {
      ...validLegacyV1,
      id: 'rcpt-v2-missing-oplog',
      operationId: 'op-v2-missing-oplog',
      schemaVersion: 2,
    };

    await saveCoachReceipt(validLegacyV1);
    await saveCoachReceipt(alreadyUndoneLegacyV1);
    await saveCoachReceipt(staleEpochLegacyV1);
    await saveCoachReceipt(missingOpV2);

    // v0.2.2 已撤销 / 过期 / v0.2.3 缺主库账本 全部拒绝
    await expect(undoCoachReceipt(alreadyUndoneLegacyV1.id)).rejects.toThrow(/已经撤销/);
    await expect(undoCoachReceipt(staleEpochLegacyV1.id)).rejects.toThrow(/恢复/);
    await expect(undoCoachReceipt(missingOpV2.id)).rejects.toThrow(/主库操作账本缺失/);

    // 有效 v0.2.2 回执可安全撤销 1 -> 0，并写墓碑记录
    const undoLegacyRes = await undoCoachReceipt(validLegacyV1.id);
    expect(undoLegacyRes.receipt.undone).toBe(true);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);
    const tombstone = await idbGet<{ value?: { undone?: boolean; migratedFromLegacy?: boolean } }>(
      'meta',
      `${COACH_OP_META_PREFIX}op-legacy-v1-valid`,
    );
    expect(tombstone?.value?.undone).toBe(true);
    expect(tombstone?.value?.migratedFromLegacy).toBe(true);

    // 即使回执库未同步成功（再次重置 undone=false），主库墓碑也会阻断第二次回滚
    await saveCoachReceipt({ ...validLegacyV1, undone: false });
    const revAfterFirst = ((await getSession(session.id))!).revision;
    const secondUndo = await undoCoachReceipt(validLegacyV1.id);
    expect(secondUndo.receipt.undone).toBe(true);
    expect(((await getSession(session.id))!).revision).toBe(revAfterFirst);

    void sDone;
  });

  it('8. 目标动作歧义与全部已完成防覆盖（ambiguous-target）及 targetMode=last_completed 定向修改', async () => {
    const { session } = await seedActive();
    // 1. 不传 exId/exerciseName -> invalid-input；模糊名字命中多个动作（“卧推”匹配两个卧推动作） -> ambiguous-target
    await expect(
      coachRecordActiveSet({
        operationId: 'op-missing-ex',
        sessionId: session.id,
        reps: 10,
        weightKg: 50,
        status: 'done',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });

    await expect(
      coachRecordActiveSet({
        operationId: 'op-ambig-ex',
        sessionId: session.id,
        exerciseName: '卧推',
        reps: 10,
        weightKg: 50,
        status: 'done',
      }),
    ).rejects.toMatchObject({ reason: 'ambiguous-target' });

    // 2. 把第一个动作的所有组记为 done，再不带 roundIndex/targetMode 调 record -> 拒绝对末尾组静默覆写
    const ex = session.exercises[0];
    let curRev = session.revision;
    for (let i = 0; i < ex.sets.length; i += 1) {
      const step = await coachRecordActiveSet({
        operationId: `op-fill-${i}`,
        sessionId: session.id,
        exId: ex.id,
        roundIndex: i + 1,
        reps: 10,
        weightKg: 60,
        expectedRevision: curRev,
        status: 'done',
      });
      curRev = step.receipt.afterRevision;
    }

    await expect(
      coachRecordActiveSet({
        operationId: 'op-all-done-ambig',
        sessionId: session.id,
        exId: ex.id,
        reps: 15,
        weightKg: 80,
        expectedRevision: curRev,
        status: 'done',
      }),
    ).rejects.toMatchObject({ reason: 'ambiguous-target' });

    // 3. 明确指定 targetMode: 'last_completed' -> 准确改写最后一个已完成组
    const fixLast = await coachRecordActiveSet({
      operationId: 'op-last-completed-edit',
      sessionId: session.id,
      exId: ex.id,
      targetMode: 'last_completed',
      reps: 12,
      weightKg: 70,
      expectedRevision: curRev,
      status: 'done',
    });
    const updatedSets = fixLast.session!.exercises[0].sets;
    expect(updatedSets[updatedSets.length - 1].reps).toBe(12);
    expect(updatedSets[updatedSets.length - 1].weightKg).toBe(70);
  });

  it('9. 跨进程休息计时恢复 6 种场景 + 多组同批仅派发最后一个有效计时', async () => {
    const baseRecord: DurableRestTimerRecord = {
      v: 1,
      sessionId: 'sess-rt',
      token: 'coach:sess-rt:op2:2',
      source: { sessionExerciseId: 'ex1', setId: 's2' },
      generation: null,
      intentWatermark: 0,
      endsAt: 1_000_000 + 90_000,
      pausedRemaining: null,
      status: 'running',
      savedAt: 1_000_000,
      restoreEpoch: 3,
      coachOperationId: 'op2',
      nativeScheduled: false,
    };

    // 1) 未派发先退出 -> schedule-pending-native（按 deadlineAtMs 计算余量）
    const a1 = reconcileRestTimerRecovery({
      record: baseRecord,
      nativeActive: null,
      now: 1_030_000,
      currentRestoreEpoch: 3,
    });
    expect(a1.kind).toBe('schedule-pending-native');
    if (a1.kind === 'schedule-pending-native') expect(a1.remainingMs).toBe(60_000);

    // 2) 原生已激活且匹配 token -> adopt-native
    const a2 = reconcileRestTimerRecovery({
      record: { ...baseRecord, nativeScheduled: true },
      nativeActive: { active: true, token: baseRecord.token, generation: 5, deadlineAtMs: 1_090_000, lastIntentId: 2 },
      now: 1_030_000,
      currentRestoreEpoch: 3,
    });
    expect(a2.kind).toBe('adopt-native');

    // 3) 取消后清空记录 -> none
    const a3 = reconcileRestTimerRecovery({ record: null, nativeActive: null, now: 1_030_000, currentRestoreEpoch: 3 });
    expect(a3.kind).toBe('none');

    // 4) 已过期 -> expired
    const a4 = reconcileRestTimerRecovery({
      record: baseRecord,
      nativeActive: null,
      now: 1_100_000,
      currentRestoreEpoch: 3,
    });
    expect(a4.kind).toBe('expired');

    // 5) 恢复纪元过期 -> stale-epoch
    const a5 = reconcileRestTimerRecovery({
      record: baseRecord,
      nativeActive: null,
      now: 1_020_000,
      currentRestoreEpoch: 4,
    });
    expect(a5.kind).toBe('stale-epoch');

    // 6) 120s 休息在第 30s 暂停（余量 90s），第 130s 恢复仍保 90s 暂停余量
    const pausedRecord: DurableRestTimerRecord = {
      ...baseRecord,
      status: 'paused',
      endsAt: null,
      pausedRemaining: 90_000,
      nativeScheduled: true,
    };
    const a6 = reconcileRestTimerRecovery({
      record: pausedRecord,
      nativeActive: null,
      now: 1_130_000,
      currentRestoreEpoch: 3,
    });
    expect(a6.kind).toBe('restore-paused');
    if (a6.kind === 'restore-paused') expect(a6.pausedRemaining).toBe(90_000);

    // 多组同批记组：仅派发最后一组计时指令
    const dispatchedTokens: string[] = [];
    const { session } = await seedActive({
      sessionId: 'sess-batch-timer',
      startRestTimerWithDirective: (d) => dispatchedTokens.push(d.operationId),
    });
    const exId = session.exercises[0].id;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string }> };
      const lastRole = body.messages[body.messages.length - 1]?.role;
      if (lastRole === 'user') {
        return makeSseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-b1',
                      function: { name: 'record_active_set', arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }) },
                    },
                    {
                      index: 1,
                      id: 'call-b2',
                      function: { name: 'record_active_set', arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 2, reps: 10, weightKg: 60, status: 'done' }) },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '两组已记好。' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    try {
      await runCoachTurn({
        userText: '帮我同时记第1和第2组 60kg 10次',
        history: [],
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: 'ds-key',
          updatedAt: NOW,
        },
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(dispatchedTokens).toHaveLength(1);
      expect(dispatchedTokens[0]).toMatch(/:r0:c1$/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('10. 三协议 SSE 完整性与整批校验（EOF / length / max_tokens / filter / 伪造ID / 缺index / 空串参数 / 批次后项非法 -> 0写入）', async () => {
    // 10a. OpenAI 合法分片（后续分片无 id/name）放行
    const validFrag = await collectDone(
      streamCoachTurn(
        {
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: 'k',
          fetch: async () =>
            makeSseResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_frag', function: { name: 'record_active_set', arguments: '{"reps":' } }] } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '10}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
              'data: [DONE]\n\n',
            ]),
        },
        [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        [],
      ),
    );
    expect(validFrag.outcomeKind).toBe('completed_tool_calls');
    expect(validFrag.toolCalls[0].id).toBe('call_frag');

    // 10b. OpenAI 各种损坏/截断流一律拒绝并返回 0 调用
    const oaiBadPayloads: Array<{ label: string; chunks: string[]; expectedOutcome: string }> = [
      {
        label: 'EOF 缺少 [DONE]',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'record_active_set', arguments: '{"reps":10}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
        ],
        expectedOutcome: 'truncated_eof',
      },
      {
        label: 'finish_reason=length',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'record_active_set', arguments: '{"reps":10}' } }] }, finish_reason: 'length' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'truncated_max_tokens',
      },
      {
        label: 'content_filter',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c3', function: { name: 'record_active_set', arguments: '{"reps":10}' } }] }, finish_reason: 'content_filter' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'malformed_tool_call',
      },
      {
        label: '缺失真实 id',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'record_active_set', arguments: '{"reps":10}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'malformed_tool_call',
      },
      {
        label: '缺失 index',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'c4', function: { name: 'record_active_set', arguments: '{"reps":10}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'malformed_tool_call',
      },
      {
        label: '空串 arguments',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c5', function: { name: 'record_active_set', arguments: '' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'malformed_tool_call',
      },
      {
        label: '重复 tool_call id',
        chunks: [
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'dup', function: { name: 'record_active_set', arguments: '{"reps":8}' } }, { index: 1, id: 'dup', function: { name: 'record_active_set', arguments: '{"reps":9}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`,
          'data: [DONE]\n\n',
        ],
        expectedOutcome: 'malformed_tool_call',
      },
    ];
    for (const c of oaiBadPayloads) {
      const res = await collectDone(
        streamCoachTurn(
          {
            kind: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-chat',
            apiKey: 'k',
            fetch: async () => makeSseResponse(c.chunks),
          },
          [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
          [],
        ),
      );
      expect(res.outcomeKind, c.label).toBe(c.expectedOutcome);
      expect(res.toolCalls, c.label).toHaveLength(0);
    }

    // 10c. Anthropic max_tokens & refusal
    const antMax = await collectDone(
      streamCoachTurn(
        {
          kind: 'anthropic',
          baseUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'k',
          fetch: async () =>
            makeSseResponse([
              `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'record_active_set', input: {} } })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: '{"reps":10}' } })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
              `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'max_tokens' } })}\n\n`,
              `event: message_stop\ndata: {}\n\n`,
            ]),
        },
        [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        [],
      ),
    );
    expect(antMax.outcomeKind).toBe('truncated_max_tokens');
    expect(antMax.toolCalls).toHaveLength(0);

    // 10d. Gemini 合法无 ID & MAX_TOKENS/SAFETY
    const gemOk = await collectDone(
      streamCoachTurn(
        {
          kind: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-2.5-flash',
          apiKey: 'k',
          fetch: async () =>
            makeSseResponse([
              `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'record_active_set', args: { reps: 10 } } }] } }] })}\n\n`,
            ]),
        },
        [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        [],
      ),
    );
    expect(gemOk.outcomeKind).toBe('completed_tool_calls');
    expect(gemOk.toolCalls[0].id).toMatch(/^gem_local_/);

    const gemBlocked = await collectDone(
      streamCoachTurn(
        {
          kind: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-2.5-flash',
          apiKey: 'k',
          fetch: async () =>
            makeSseResponse([
              `data: ${JSON.stringify({ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ functionCall: { name: 'record_active_set', args: { reps: 10 } } }] } }] })}\n\n`,
            ]),
        },
        [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
        [],
      ),
    );
    expect(gemBlocked.outcomeKind).toBe('malformed_tool_call');
    expect(gemBlocked.toolCalls).toHaveLength(0);

    // 10e. 批次中第 2 项参数不合法（weightKg=-5） -> 整批阻断，第 1 项 0 写入
    const { session } = await seedActive({ sessionId: 'sess-batch-schema' });
    const exId = session.exercises[0].id;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      makeSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'valid-0',
                    function: { name: 'record_active_set', arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }) },
                  },
                  {
                    index: 1,
                    id: 'invalid-1',
                    function: { name: 'record_active_set', arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 2, reps: 10, weightKg: -5, status: 'done' }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );
    try {
      const turn = await runCoachTurn({
        userText: '批量记两组',
        history: [],
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: 'k',
          updatedAt: NOW,
        },
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(turn.outcomeKind).toBe('malformed_tool_call');
      expect(turn.receipts).toHaveLength(0);
      expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);
    } finally {
      globalThis.fetch = origFetch;
    }

    // 额外直调 validateToolCallBatch 验证权限门禁
    const roCheck = validateToolCallBatch(
      [{ id: 'c-rogue', name: 'web_search', argumentsText: '{"query":"test"}', arguments: { query: 'test' } }],
      ALLOWED_BUSINESS_TOOL_NAMES,
    );
    expect(roCheck.ok).toBe(false);
    void buildCoachReadOnlyContext;
  });
});

async function seedReliabilityActiveSession(sessionId: string, setsCount = 6) {
  const { __resetDbHandle, idbClear } = await import('../src/db/idb');
  const { getSession, savePlan } = await import('../src/db/repo');
  const { atomicCreateSession } = await import('../src/db/tx');
  const { createV32Plan } = await import('../src/domain/presets/v32');
  const { createSession } = await import('../src/domain/session');

  registerSessionRuntime(null);
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');

  const now = 1_766_900_000_000;
  const base = createV32Plan(now);
  const wideDay = {
    ...base.days[0],
    exercises: base.days[0].exercises.map((e, i) =>
      i === 0 ? { ...e, target: { ...e.target, sets: setsCount, setsMax: setsCount } } : e,
    ),
  };
  const plan = { ...base, id: `plan-${sessionId}`, name: '可靠性 R1 测试计划', days: [wideDay], cursor: 0 };
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], now);
  const sess = { ...raw, id: sessionId };
  await atomicCreateSession({ session: sess });
  const fresh = (await getSession(sess.id))!;
  await acquireSessionLock(fresh.id, 'editor-r1');
  const startedTimers: Array<{ sec: number; source?: unknown }> = [];
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-r1',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: (sec, source) => {
      startedTimers.push({ sec, source });
    },
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh, startedTimers, now };
}

function makeR1Sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(enc.encode(c));
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createR1FakeDom() {
  interface FNode {
    nodeType: number;
    tagName: string;
    isConnected: boolean;
    childNodes: FNode[];
    ownerDocument: unknown;
    parentNode: FNode | null;
    parentElement: FNode | null;
    attributes: Map<string, string>;
    listeners: Map<string, Set<(...args: unknown[]) => void>>;
    style: Record<string, string>;
    nodeValue?: string | null;
    textContent?: string;
    setAttribute: (k: string, v: string) => void;
    getAttribute: (k: string) => string | null;
    removeAttribute: (k: string) => void;
    addEventListener: (t: string, fn: (...args: unknown[]) => void) => void;
    removeEventListener: (t: string, fn: (...args: unknown[]) => void) => void;
    appendChild: (c: FNode) => FNode;
    removeChild: (c: FNode) => FNode;
    insertBefore: (c: FNode, b: FNode | null) => FNode;
    remove: () => void;
  }

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).HTMLIFrameElement = class {};
  (globalThis as Record<string, unknown>).Element = class {};
  (globalThis as Record<string, unknown>).HTMLElement = class {};
  (globalThis as Record<string, unknown>).Node = class {};

  const makeEl = (tag: string, owner: unknown): FNode => {
    const attributes = new Map<string, string>();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const node: FNode = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      isConnected: true,
      childNodes: [],
      ownerDocument: owner,
      parentNode: null,
      parentElement: null,
      attributes,
      listeners,
      style: {},
      setAttribute: (k, v) => attributes.set(k, String(v)),
      getAttribute: (k) => (attributes.has(k) ? (attributes.get(k) ?? null) : null),
      removeAttribute: (k) => attributes.delete(k),
      addEventListener: (t, fn) => {
        const s = listeners.get(t) ?? new Set();
        s.add(fn);
        listeners.set(t, s);
      },
      removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
      appendChild: (c) => {
        c.parentNode = node;
        c.parentElement = node;
        node.childNodes.push(c);
        return c;
      },
      removeChild: (c) => {
        const idx = node.childNodes.indexOf(c);
        if (idx >= 0) node.childNodes.splice(idx, 1);
        c.parentNode = null;
        c.parentElement = null;
        return c;
      },
      insertBefore: (c, b) => {
        c.parentNode = node;
        c.parentElement = node;
        const idx = b ? node.childNodes.indexOf(b) : -1;
        if (idx >= 0) node.childNodes.splice(idx, 0, c);
        else node.childNodes.push(c);
        return c;
      },
      remove: () => {
        node.parentNode?.removeChild(node);
      },
    };
    return node;
  };

  const docListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const winListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const lsMap = new Map<string, string>();
  const ssMap = new Map<string, string>();
  const wrapStorage = (m: Map<string, string>) => ({
    get length() {
      return m.size;
    },
    key: (idx: number) => Array.from(m.keys())[idx] ?? null,
    getItem: (k: string) => (m.has(k) ? (m.get(k) ?? null) : null),
    setItem: (k: string, v: string) => m.set(k, String(v)),
    removeItem: (k: string) => m.delete(k),
    clear: () => m.clear(),
  });

  const doc = {
    nodeType: 9,
    visibilityState: 'visible',
    documentElement: null as unknown as FNode,
    activeElement: null,
    defaultView: globalThis,
    createElement: (tag: string) => makeEl(tag, doc),
    createElementNS: (_ns: string, tag: string) => makeEl(tag, doc),
    createTextNode: (t: string) => {
      const n = makeEl('#text', doc);
      n.nodeType = 3;
      n.nodeValue = String(t);
      n.textContent = String(t);
      return n;
    },
    createComment: () => {
      const n = makeEl('#comment', doc);
      n.nodeType = 8;
      return n;
    },
    addEventListener: (t: string, fn: (...args: unknown[]) => void) => {
      const s = docListeners.get(t) ?? new Set();
      s.add(fn);
      docListeners.set(t, s);
    },
    removeEventListener: (t: string, fn: (...args: unknown[]) => void) => docListeners.get(t)?.delete(fn),
    dispatchEvent: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  doc.documentElement = makeEl('HTML', doc);
  const rootEl = makeEl('DIV', doc);
  const winObj = Object.assign(globalThis, {
    localStorage: wrapStorage(lsMap),
    sessionStorage: wrapStorage(ssMap),
    matchMedia: (q: string) => ({ matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }),
    addEventListener: (t: string, fn: (...args: unknown[]) => void) => {
      const s = winListeners.get(t) ?? new Set();
      s.add(fn);
      winListeners.set(t, s);
    },
    removeEventListener: (t: string, fn: (...args: unknown[]) => void) => winListeners.get(t)?.delete(fn),
    dispatchEvent: () => true,
  });
  return { doc, rootEl, winObj };
}

describe('MOTION v0.2.3 R1 退回项高风险可靠性回归', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).Capacitor;
  });

  it('11. SSE 损坏 JSON data 帧、Gemini UNEXPECTED_TOOL_CALL、Anthropic 异常结束零写入；合法分片+心跳+单独usage帧精确写入 1 次', async () => {
    const { getSession } = await import('../src/db/repo');
    const dsCfg = {
      key: 'provider' as const,
      kind: 'openai-compatible' as const,
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      thinkingDepth: 'high' as const,
      apiKey: 'sk-sse-test',
      updatedAt: 1_766_900_000_000,
    };

    // 1) OpenAI-compat 含损坏 JSON data 帧，即便随后给出合法 tool_calls + [DONE] 也必须零写入
    {
      const { session, startedTimers } = await seedReliabilityActiveSession('sess-r1-sse-corrupt');
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      vi.stubGlobal('fetch', async () =>
        makeR1Sse([
          'data: {broken_json_chunk\n\n',
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-after-corrupt',
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
      const res = await runCoachTurn({
        threadId: tid,
        userText: '记第 1 组 60kg 10次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      expect(res.outcomeKind).not.toBe('completed');
      const sAfter = (await getSession(session.id))!;
      expect(sAfter.exercises[0].sets[0].status).toBe('blank');
      expect(await listCoachReceipts()).toHaveLength(0);
      expect(startedTimers).toHaveLength(0);
    }

    // 2) Gemini finishReason = UNEXPECTED_TOOL_CALL 必须零写入
    {
      const { session, startedTimers } = await seedReliabilityActiveSession('sess-r1-gemini-unexpected');
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      vi.stubGlobal('fetch', async () =>
        makeR1Sse([
          `data: ${JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'record_active_set',
                        args: { sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' },
                      },
                    },
                  ],
                },
                finishReason: 'UNEXPECTED_TOOL_CALL',
              },
            ],
          })}\n\n`,
        ]),
      );
      const res = await runCoachTurn({
        threadId: tid,
        userText: '记第 1 组 60kg 10次',
        history: [],
        providerConfig: {
          key: 'provider',
          kind: 'gemini',
          presetId: 'gemini-official',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-2.5-flash',
          apiKey: 'gm-test',
          updatedAt: 1_766_900_000_000,
        },
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      expect(res.outcomeKind).not.toBe('completed');
      const sAfter = (await getSession(session.id))!;
      expect(sAfter.exercises[0].sets[0].status).toBe('blank');
      expect(await listCoachReceipts()).toHaveLength(0);
      expect(startedTimers).toHaveLength(0);
    }

    // 3) Anthropic stop_reason = max_tokens 或缺 message_stop 均必须零写入
    for (const includeStopEvent of [true, false]) {
      const { session, startedTimers } = await seedReliabilityActiveSession(`sess-r1-anth-${includeStopEvent}`);
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const events = [
        `event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_abn_1', name: 'record_active_set', input: {} },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
          },
        })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: includeStopEvent ? 'max_tokens' : 'tool_use' },
          usage: { output_tokens: 40 },
        })}\n\n`,
      ];
      if (includeStopEvent) {
        events.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
      vi.stubGlobal('fetch', async () => makeR1Sse(events));
      const res = await runCoachTurn({
        threadId: tid,
        userText: '记第 1 组 60kg 10次',
        history: [],
        providerConfig: {
          key: 'provider',
          kind: 'anthropic',
          presetId: 'anthropic-official',
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-sonnet-4-5',
          apiKey: 'ant-test',
          updatedAt: 1_766_900_000_000,
        },
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      expect(res.outcomeKind).not.toBe('completed');
      const sAfter = (await getSession(session.id))!;
      expect(sAfter.exercises[0].sets[0].status).toBe('blank');
      expect(await listCoachReceipts()).toHaveLength(0);
      expect(startedTimers).toHaveLength(0);
    }

    // 4) 正向对照：心跳注释 `: keep-alive` + 分片参数 + choices:[] 独立 usage 帧 -> 精确写入 1 次
    {
      const { session } = await seedReliabilityActiveSession('sess-r1-sse-valid');
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const argsJson = JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' });
      let step = 0;
      vi.stubGlobal('fetch', async () => {
        step += 1;
        if (step === 1) {
          return makeR1Sse([
            ': keep-alive\n\n',
            `data: ${JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-good-1', function: { name: 'record_active_set', arguments: argsJson.slice(0, 20) } }] } }],
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(20) } }] }, finish_reason: 'tool_calls' }],
            })}\n\n`,
            `data: ${JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 1400, completion_tokens: 30, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1400 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        return makeR1Sse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '第 1 组 60kg×10 已成功记录。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1550, completion_tokens: 15, prompt_cache_hit_tokens: 1344, prompt_cache_miss_tokens: 206 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      });

      const res = await runCoachTurn({
        threadId: tid,
        userText: '记第 1 组 60kg 10次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      expect(res.aborted).toBe(false);
      expect(res.receipts).toHaveLength(1);
      const sAfter = (await getSession(session.id))!;
      expect(sAfter.exercises[0].sets[0].status).toBe('done');
      expect(sAfter.exercises[0].sets[1].status).toBe('blank');
      expect(await listCoachReceipts()).toHaveLength(1);
    }
  });

  it('12. 并发手改保护（省略 expectedRevision 仍拒旧覆写）、同批自推进 [w1,w2] 放行、跨动作/备注互不冲突保留', async () => {
    const { getSession } = await import('../src/db/repo');
    const { idbPut } = await import('../src/db/idb');
    const dsCfg = {
      key: 'provider' as const,
      kind: 'openai-compatible' as const,
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      thinkingDepth: 'high' as const,
      apiKey: 'sk-concurrency',
      updatedAt: 1_766_900_000_000,
    };

    // Sub-case A1 & A2: 请求在途时用户手改 Set 1 -> 12 次，模型省略 expectedRevision 返回 9 次（带 roundIndex=1 或省略 roundIndex）-> 保留 12 次且第 2 组不被偷记，含冷恢复复验
    for (const omitRoundIndex of [false, true]) {
      const { session } = await seedReliabilityActiveSession(`sess-r1-conflict-${omitRoundIndex}`);
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      let releaseFetch!: () => void;
      const fetchStarted = new Promise<void>((res) => {
        let round = 0;
        vi.stubGlobal('fetch', async () => {
          round += 1;
          if (round === 1) {
            res();
            await new Promise<void>((r) => {
              releaseFetch = r;
            });
            const toolArgs: Record<string, unknown> = {
              sessionId: session.id,
              exId,
              reps: 9,
              weightKg: 60,
              status: 'done',
              ...(omitRoundIndex ? {} : { roundIndex: 1 }),
            };
            return makeR1Sse([
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call-conflict-${omitRoundIndex}`,
                          function: { name: 'record_active_set', arguments: JSON.stringify(toolArgs) },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 },
              })}\n\n`,
              'data: [DONE]\n\n',
            ]);
          }
          return makeR1Sse([
            `data: ${JSON.stringify({
              choices: [{ delta: { content: '检测到手改冲突，未覆盖您的 12 次记录。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1300, completion_tokens: 18, prompt_cache_hit_tokens: 1152, prompt_cache_miss_tokens: 148 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        });
      });

      let capturedColdPending = null as Awaited<ReturnType<typeof listPendingTurns>>[number] | null;
      const turnPromise = runCoachTurn({
        threadId: tid,
        userText: '把刚才那组记成 9 次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
        onPendingTurnChange: (p) => {
          if (p?.plannedToolCalls?.length && p.plannedToolCalls[0]?.status === 'pending') {
            capturedColdPending = structuredClone(p);
          }
        },
      });
      await fetchStarted;

      // 在模型请求仍在途时手改主库 Set 1 -> 12 次并推进 revision
      const cur = (await getSession(session.id))!;
      await idbPut('sessions', {
        ...cur,
        revision: (cur.revision ?? 0) + 1,
        exercises: cur.exercises.map((e, i) =>
          i === 0 ? { ...e, sets: e.sets.map((s, si) => (si === 0 ? { ...s, reps: 12, weightKg: 60, status: 'done' as const } : s)) } : e,
        ),
      });
      releaseFetch();

      const liveOut = await turnPromise;
      const afterLive = (await getSession(session.id))!;
      expect(afterLive.exercises[0].sets[0].reps).toBe(12);
      expect(afterLive.exercises[0].sets[1].status).toBe('blank');
      expect(liveOut.receipts).toHaveLength(0);

      // 模拟同前置条件冷崩溃恢复，同样不能覆盖 12 次或偷记第 2 组
      expect(capturedColdPending).not.toBeNull();
      if (capturedColdPending) {
        const coldPending = {
          ...capturedColdPending,
          turnId: `cold-conflict-${omitRoundIndex}`,
          status: 'awaiting_tools' as const,
          plannedToolCalls: (capturedColdPending.plannedToolCalls ?? []).map((c, idx) =>
            idx === 0 ? { ...c, operationId: `op-cold-conflict-${omitRoundIndex}`, status: 'pending' as const } : c,
          ),
        };
        await savePendingTurnStrict(coldPending);
        await resumePendingCoachTurn({
          pendingTurn: coldPending,
          providerConfig: dsCfg,
          toolContext: { activeSession: await getSession(session.id) },
        });
        const afterCold = (await getSession(session.id))!;
        expect(afterCold.exercises[0].sets[0].reps).toBe(12);
        expect(afterCold.exercises[0].sets[1].status).toBe('blank');
      }
    }

    // Sub-case B: 单批双工具 [Set 1, Set 2] 同批自推进均省略 expectedRevision -> 两者都应提交成功
    {
      const { session } = await seedReliabilityActiveSession('sess-r1-self-advance');
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      let round = 0;
      vi.stubGlobal('fetch', async () => {
        round += 1;
        if (round === 1) {
          return makeR1Sse([
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-batch-1',
                        function: {
                          name: 'record_active_set',
                          arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                        },
                      },
                      {
                        index: 1,
                        id: 'call-batch-2',
                        function: {
                          name: 'record_active_set',
                          arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 2, reps: 8, weightKg: 65, status: 'done' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 1300, completion_tokens: 35, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1300 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        return makeR1Sse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '第 1、2 组已连续记录完成。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1500, completion_tokens: 16, prompt_cache_hit_tokens: 1280, prompt_cache_miss_tokens: 220 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      });

      const batchRes = await runCoachTurn({
        threadId: tid,
        userText: '帮我补记第 1 组 60kg 10次和第 2 组 65kg 8次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(batchRes.receipts).toHaveLength(2);
      const afterBatch = (await getSession(session.id))!;
      expect(afterBatch.exercises[0].sets[0].reps).toBe(10);
      expect(afterBatch.exercises[0].sets[0].status).toBe('done');
      expect(afterBatch.exercises[0].sets[1].reps).toBe(8);
      expect(afterBatch.exercises[0].sets[1].status).toBe('done');
    }

    // Sub-case C: 互不冲突的并发修改（用户改训练备注/第二动作，模型记第一动作第一组）-> 两者都保留
    {
      const { session } = await seedReliabilityActiveSession('sess-r1-non-conflict');
      const exId = session.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      let releaseFetch!: () => void;
      const fetchStarted = new Promise<void>((res) => {
        let round = 0;
        vi.stubGlobal('fetch', async () => {
          round += 1;
          if (round === 1) {
            res();
            await new Promise<void>((r) => {
              releaseFetch = r;
            });
            return makeR1Sse([
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-nonconf-1',
                          function: {
                            name: 'record_active_set',
                            arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                          },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
                usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1200 },
              })}\n\n`,
              'data: [DONE]\n\n',
            ]);
          }
          return makeR1Sse([
            `data: ${JSON.stringify({
              choices: [{ delta: { content: '第一动作第 1 组已记录，您的训练备注已保留。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1350, completion_tokens: 18, prompt_cache_hit_tokens: 1152, prompt_cache_miss_tokens: 198 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        });
      });

      const p = runCoachTurn({
        threadId: tid,
        userText: '帮我记第一动作第 1 组 60kg 10次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      await fetchStarted;

      const cur = (await getSession(session.id))!;
      await idbPut('sessions', {
        ...cur,
        revision: (cur.revision ?? 0) + 1,
        note: '并发修改整场备注',
      });
      releaseFetch();

      const out = await p;
      expect(out.receipts).toHaveLength(1);
      const afterNonConf = (await getSession(session.id))!;
      expect(afterNonConf.note).toBe('并发修改整场备注');
      expect(afterNonConf.exercises[0].sets[0].status).toBe('done');
      expect(afterNonConf.exercises[0].sets[0].reps).toBe(10);
    }
  });

  it('13. 双工具半崩溃冷恢复（w1已落库、tool(w1)缺失、w2待执行）完整恢复 [1:user, 2:asst, 3:tool(w1), 4:tool(w2), 5:asst]，确认流中断重放零重记', async () => {
    const { getSession } = await import('../src/db/repo');
    const { listProtocolEntries: getProtoEntries, replaceProtocolEntriesForThread } = await import('../src/coach/coachStorage');
    const { session } = await seedReliabilityActiveSession('sess-r1-dual-crash');
    const exId = session.exercises[0].id;
    const tid = (await loadCoachThreadsState()).activeThreadId;
    const dsCfg = {
      key: 'provider' as const,
      kind: 'openai-compatible' as const,
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      thinkingDepth: 'high' as const,
      apiKey: 'sk-dual-crash',
      updatedAt: 1_766_900_000_000,
    };

    // 先触发真实双工具执行到 w1 已提交、w2 待执行时通过 onPendingTurnChange 中止，制造半崩溃状态
    vi.stubGlobal('fetch', async () =>
      makeR1Sse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '依次记入第 1 和第 2 组',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-dual-w1',
                    function: {
                      name: 'record_active_set',
                      arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                    },
                  },
                  {
                    index: 1,
                    id: 'call-dual-w2',
                    function: {
                      name: 'record_active_set',
                      arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 2, reps: 8, weightKg: 65, status: 'done' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1400, completion_tokens: 40, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1400 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]),
    );

    let crashTurnCaptured: Awaited<ReturnType<typeof listPendingTurns>>[number] | null = null;
    await expect(
      runCoachTurn({
        threadId: tid,
        userText: '帮我记第 1 组 60kg 10次和第 2 组 65kg 8次',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
        onPendingTurnChange: (p) => {
          const calls = p?.plannedToolCalls;
          if (calls && calls[0]?.status === 'committed' && calls[1]?.status === 'pending') {
            crashTurnCaptured = structuredClone(p);
            throw new Error('SIMULATED_CRASH_BEFORE_TOOL_W1_ENTRY');
          }
        },
      }),
    ).rejects.toThrow('SIMULATED_CRASH_BEFORE_TOOL_W1_ENTRY');

    // 抹去 tool(w1)，仅保留 [1:user, 2:assistant(w1,w2)]，模拟写入 tool(w1) 前进程被杀
    const rawEntries = await getProtoEntries(tid);
    await replaceProtocolEntriesForThread(tid, rawEntries.slice(0, 2));
    if (crashTurnCaptured) {
      await savePendingTurnStrict(crashTurnCaptured);
    }

    const sBeforeRecovery = (await getSession(session.id))!;
    expect(sBeforeRecovery.exercises[0].sets[0].status).toBe('done');
    expect(sBeforeRecovery.exercises[0].sets[1].status).toBe('blank');
    expect(await getProtoEntries(tid)).toHaveLength(2);

    // 冷恢复第 1 次：w2 成功执行，确认流故意直接断流失败
    vi.stubGlobal('fetch', async () =>
      makeR1Sse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '截断不完整确认流' } }],
        })}\n\n`,
      ]),
    );

    const initialPending = (await listPendingTurns(tid))[0];
    expect(initialPending).toBeTruthy();
    const firstResume = await resumePendingCoachTurn({
      pendingTurn: initialPending,
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
    });
    expect(firstResume.needsUserRetry || firstResume.needsConfirmationStream).toBe(true);

    const sMid = (await getSession(session.id))!;
    expect(sMid.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(2);
    const midEntries = await getProtoEntries(tid);
    expect(midEntries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(midEntries[1].toolCalls?.map((t) => t.id)).toEqual(['call-dual-w1', 'call-dual-w2']);
    expect(midEntries[2].toolCallId).toBe('call-dual-w1');
    expect(midEntries[3].toolCallId).toBe('call-dual-w2');
    const midPending = await listPendingTurns(tid);
    expect(midPending).toHaveLength(1);
    expect(midPending[0].status).toBe('awaiting_followup_model');

    // 冷恢复第 2 次：仅重放自然语言确认流，检查线缆消息含配对工具轨迹且 0 重复记组
    const followupRequests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      followupRequests.push(JSON.parse(String(init?.body ?? '{}')));
      return makeR1Sse([
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: '确认两组状态', content: '第 1 和第 2 组均已恢复并确认完毕。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1700, completion_tokens: 20, prompt_cache_hit_tokens: 1344, prompt_cache_miss_tokens: 356 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const secondResume = await resumePendingCoachTurn({
      pendingTurn: midPending[0],
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
    });
    expect(secondResume.resumed).toBe(true);
    expect(secondResume.needsUserRetry).toBeFalsy();
    const sFinal = (await getSession(session.id))!;
    expect(sFinal.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(2);
    const finalEntries = await getProtoEntries(tid);
    expect(finalEntries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(await listPendingTurns(tid)).toHaveLength(0);
    expect(followupRequests).toHaveLength(1);
    const sentRoles = followupRequests[0].messages.map((m) => m.role);
    expect(sentRoles.slice(-4)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });

  it('14. Round 1 工具续调中途触及硬上下文上限时不分裂无 tool 配对的裸 user 分段并正常收尾零重复写', async () => {
    const { getSession } = await import('../src/db/repo');
    const { listProtocolEntries: getProtoEntries } = await import('../src/coach/coachStorage');
    const { session } = await seedReliabilityActiveSession('sess-r1-hard-budget');
    const exId = session.exercises[0].id;
    const tid = (await loadCoachThreadsState()).activeThreadId;
    const dsTightCfg = {
      key: 'provider' as const,
      kind: 'openai-compatible' as const,
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      contextWindowByModel: { 'deepseek-flash': 12000 },
      thinkingDepth: 'high' as const,
      apiKey: 'sk-hard-budget',
      updatedAt: 1_766_900_000_000,
    };

    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<Record<string, unknown>> };
      requests.push(body);
      const lastRole = body.messages[body.messages.length - 1]?.role;
      const hasAnyTool = body.messages.some((m) => m.role === 'tool');
      if (lastRole === 'user' && !hasAnyTool) {
        if (!String(body.messages[body.messages.length - 1]?.content ?? '').includes('压缩')) {
          return makeR1Sse([
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_content: '记录第 1 组并随后检查上下文裁剪 '.repeat(80),
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-budget-1',
                        function: {
                          name: 'record_active_set',
                          arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 7200, completion_tokens: 300, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 7200 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '折叠历史摘要：前序讨论已汇总。' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return makeR1Sse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '第 1 组已安全保存。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5800, completion_tokens: 18, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 1800 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const out = await runCoachTurn({
      threadId: tid,
      userText: '帮我记第 1 组 60kg 10次',
      history: Array.from({ length: 8 }, (_, k) => ({
        id: `bh-${k}`,
        threadId: tid,
        role: k % 2 === 0 ? ('user' as const) : ('assistant' as const),
        createdAt: 1_766_900_000_000 + k,
        text: `历史记录 ${k} `.repeat(65),
      })),
      providerConfig: dsTightCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });

    expect(out.aborted).toBe(false);
    const confirmReq = requests[requests.length - 1];
    expect(confirmReq.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(true);
    expect(confirmReq.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call-budget-1')).toBe(true);
    const sAfter = (await getSession(session.id))!;
    expect(sAfter.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    const entriesAfter = await getProtoEntries(tid);
    const hasPairedTool = entriesAfter.some((e) => e.kind === 'assistant' && Boolean(e.toolCalls?.length)) &&
      entriesAfter.some((e) => e.kind === 'tool' && e.toolCallId === 'call-budget-1');
    expect(hasPairedTool).toBe(true);
  });

  it('15. 真实 useRestTimer 挂载恢复竞态：同 sessionId 过期本地快照 token-A 绝不删除主库更新的有效持久记录 token-B', async () => {
    const { act, createElement } = await import('react');
    const ReactDOMClient = (await import('react-dom/client')).default;
    const { idbGet } = await import('../src/db/idb');
    const { saveRestTimerSnapshot } = await import('../src/lib/restTimerSnapshot');
    const { restTimerDurableMetaKey, saveDurableRestTimer } = await import('../src/lib/restTimerDurable');
    const { useRestTimer } = await import('../src/ui/RestTimer');

    const dom = createR1FakeDom();
    vi.stubGlobal('window', dom.winObj);
    vi.stubGlobal('document', dom.doc);
    vi.stubGlobal('localStorage', dom.winObj.localStorage);
    vi.stubGlobal('sessionStorage', dom.winObj.sessionStorage);
    (globalThis as Record<string, unknown>).BroadcastChannel = class {
      onmessage: unknown = null;
      postMessage() {}
      close() {}
    };

    const { session } = await seedReliabilityActiveSession('sess-r1-timer-race');
    const sid = session.id;
    const epoch = await getCoachRestoreEpoch();
    const deadlineB = Date.now() + 60_000;

    // 写入过期的本地 sessionStorage 快照 token-A
    saveRestTimerSnapshot({
      sessionId: sid,
      token: 'token-A',
      generation: 1,
      endsAt: Date.now() - 5_000,
      pausedRemaining: null,
      status: 'running',
    });

    // 主库存在更新且仍有效的持久休息计时记录 token-B
    await saveDurableRestTimer({
      v: 1,
      sessionId: sid,
      token: 'token-B',
      source: { sessionExerciseId: session.exercises[0].id, setId: session.exercises[0].sets[0].id },
      generation: null,
      intentWatermark: 0,
      endsAt: deadlineB,
      pausedRemaining: null,
      status: 'running',
      savedAt: Date.now(),
      restoreEpoch: epoch,
      coachOperationId: 'op-timer-token-b',
      nativeScheduled: false,
    });

    let latestApi: { active: boolean; endsAt: number | null } | null = null;
    function Probe() {
      const api = useRestTimer(90, sid);
      latestApi = { active: api.active, endsAt: api.endsAt };
      return null;
    }

    const root = ReactDOMClient.createRoot(dom.rootEl as unknown as Element);
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });

    const durableRow = await idbGet<{ key: string; value: { token: string; endsAt: number | null; status: string } }>(
      'meta',
      restTimerDurableMetaKey(sid),
    );
    const timerSnapshot = latestApi as { active: boolean; endsAt: number | null } | null;
    expect(durableRow?.value?.token).toBe('token-B');
    expect(durableRow?.value?.endsAt).toBe(deadlineB);
    expect(timerSnapshot?.active).toBe(true);
    expect(timerSnapshot?.endsAt).toBe(deadlineB);

    await act(async () => {
      root.unmount();
    });
  });
});

describe('v0.2.3 R2 复核缺陷全链路回归', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    registerSessionRuntime(null);
    __resetFocusGuardForTest();
  });

  const dsCfg = {
    key: 'provider' as const,
    kind: 'openai-compatible' as const,
    presetId: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    thinkingDepth: 'high' as const,
    apiKey: 'sk-r2-test',
    updatedAt: 1_766_900_000_000,
  };

  function sseFrame(delta: Record<string, unknown>, finishReason: string): Response {
    return makeR1Sse([
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: 'R2推理', ...delta }, finish_reason: finishReason }],
        usage: { prompt_tokens: 1000, completion_tokens: 16, prompt_cache_hit_tokens: 512, prompt_cache_miss_tokens: 488 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }

  it('R2-1：模型显式伪造/猜测 expectedRevision=2 绝不能绕过本地冻结版本 r1 对在途手改的拦截', async () => {
    const { session } = await seedReliabilityActiveSession('sess-r2-rev-precedence');
    const ex = session.exercises[0];
    let n = 0;

    vi.stubGlobal('fetch', async () => {
      n += 1;
      if (n !== 1) return sseFrame({ content: '已核对冲突，保留您的手动修改。' }, 'stop');
      const edited = structuredClone(session);
      edited.exercises[0].sets[0].reps = 12;
      const w = await atomicWriteSession({
        session: edited,
        expectedRevision: session.revision,
        editorId: 'editor-r1',
        lockPolicy: 'optional',
        intent: { kind: 'active-save' },
      });
      expect(w.ok).toBe(true);
      return sseFrame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call-guessed-rev2',
              type: 'function',
              function: {
                name: 'record_active_set',
                arguments: JSON.stringify({
                  sessionId: session.id,
                  exId: ex.id,
                  setId: ex.sets[0].id,
                  reps: 9,
                  status: 'done',
                  expectedRevision: (session.revision ?? 1) + 1,
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    });

    const tid = (await loadCoachThreadsState()).activeThreadId;
    const out = await runCoachTurn({
      threadId: tid,
      userText: '帮我记第一组九次',
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });

    expect(out.receipts).toHaveLength(0);
    const saved = (await getSession(session.id))!;
    expect(saved.exercises[0].sets[0].reps).toBe(12);
    expect(saved.exercises[0].sets[0].status).toBe('blank');
  });

  it('R2-2：agent 工具 manage_coach_memory(delete) 连续删多条记忆时清理全部可重放历史并保留 Undo 快照', async () => {
    const { session } = await seedReliabilityActiveSession('sess-r2-mem-purge');
    const marker1 = 'R2_SECRET_ALPHA';
    const marker2 = 'R2_SECRET_BETA';
    let mem = upsertCoachMemoryItem(createEmptyCoachMemory(), {
      title: '隐私条目A',
      content: marker1,
      category: 'preference',
    });
    mem = upsertCoachMemoryItem(mem.store, {
      title: '隐私条目B',
      content: marker2,
      category: 'habit',
    });
    const m1Id = mem.store.items.find((i) => i.content === marker1)!.id;
    const m2Id = mem.store.items.find((i) => i.content === marker2)!.id;
    await saveCoachMemory(mem.store);

    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (bodies.length === 1) {
        return sseFrame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'erase-1',
                type: 'function',
                function: {
                  name: 'manage_coach_memory',
                  arguments: JSON.stringify({ action: 'delete', id: m1Id }),
                },
              },
            ],
          },
          'tool_calls',
        );
      }
      if (bodies.length === 3) {
        return sseFrame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'erase-2',
                type: 'function',
                function: {
                  name: 'manage_coach_memory',
                  arguments: JSON.stringify({ action: 'delete', id: m2Id }),
                },
              },
            ],
          },
          'tool_calls',
        );
      }
      return sseFrame({ content: '已完成遗忘。' }, 'stop');
    });

    const tid = (await loadCoachThreadsState()).activeThreadId;
    const t1 = await runCoachTurn({
      threadId: tid,
      userText: '忘掉第一条隐私偏好',
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    const t2 = await runCoachTurn({
      threadId: tid,
      userText: '再忘掉第二条隐私习惯',
      history: [
        { id: 'u1', role: 'user', createdAt: 1, text: '忘掉第一条隐私偏好' },
        { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    await runCoachTurn({
      threadId: tid,
      userText: '继续训练',
      history: [
        { id: 'u1', role: 'user', createdAt: 1, text: '忘掉第一条隐私偏好' },
        { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
        { id: 'u2', role: 'user', createdAt: 3, text: '再忘掉第二条隐私习惯' },
        { id: 'a2', role: 'assistant', createdAt: 4, text: t2.text, reasoning: t2.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });

    const liveMem = await loadCoachMemory();
    expect(liveMem.items).toHaveLength(0);
    // 第一次 delete 后第 2 次请求即不可包含 marker1；第二次 delete 后后续请求均不可包含 marker1 或 marker2
    expect(JSON.stringify(bodies[1].messages)).not.toContain(marker1);
    expect(JSON.stringify(bodies[2].messages)).not.toContain(marker1);
    expect(JSON.stringify(bodies[3].messages)).not.toContain(marker2);
    expect(JSON.stringify(bodies[4].messages)).not.toContain(marker1);
    expect(JSON.stringify(bodies[4].messages)).not.toContain(marker2);

    // 连续两次删除会轮转产生唯一递增 -p1 / -p2 段 ID
    const stAfter = await loadCoachThreadsState();
    const activeSegId = stAfter.threads.find((t) => t.id === tid)?.activeSegmentId ?? '';
    expect(activeSegId).toMatch(/-p\d+$/);

    // 本地 Vault Undo 仍保留被删快照可恢复，绝不因模型侧脱敏损坏
    expect(t2.receipts[0]).toBeTruthy();
    await undoCoachReceipt(t2.receipts[0].id);
    const restoredMem = await loadCoachMemory();
    expect(restoredMem.items.some((i) => i.content === marker2)).toBe(true);
    void purgeDeletedMemoryFromCoachHistory;
  });

  it('R2-3：在途并发手改 session.note 期间仅按已交付工具推进检查点，下一轮仍向模型增量送达 note', async () => {
    const { session } = await seedReliabilityActiveSession('sess-r2-note-delta');
    const ex = session.exercises[0];
    const marker = 'R2_CONCURRENT_NOTE_MARKER';
    const bodies: Array<Record<string, unknown>> = [];

    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      if (bodies.length !== 1) return sseFrame({ content: '收到并确认。' }, 'stop');
      const edited = structuredClone(session);
      edited.note = marker;
      const w = await atomicWriteSession({
        session: edited,
        expectedRevision: session.revision,
        editorId: 'editor-r1',
        lockPolicy: 'optional',
        intent: { kind: 'active-save' },
      });
      expect(w.ok).toBe(true);
      return sseFrame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call-r2-note-w1',
              type: 'function',
              function: {
                name: 'record_active_set',
                arguments: JSON.stringify({
                  sessionId: session.id,
                  exId: ex.id,
                  setId: ex.sets[0].id,
                  reps: 9,
                  status: 'done',
                }),
              },
            },
          ],
        },
        'tool_calls',
      );
    });

    const tid = (await loadCoachThreadsState()).activeThreadId;
    const t1 = await runCoachTurn({
      threadId: tid,
      userText: '帮我记第一组九次',
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    expect(t1.receipts).toHaveLength(1);
    const saved = (await getSession(session.id))!;
    expect(saved.note).toBe(marker);

    // 验证 lastSyncedCheckpoint 已在段状态持久化
    const st = await loadCoachThreadsState();
    const th = st.threads.find((t) => t.id === tid)!;
    const seg = th.segments?.[th.activeSegmentId!]!;
    expect(seg.lastSyncedCheckpoint).toBeDefined();
    expect(seg.lastSyncedCheckpoint?.activeSessionNote ?? '').toBe('');

    await runCoachTurn({
      threadId: tid,
      userText: '刚才我手动改了什么备注？',
      history: [
        { id: 'u1', role: 'user', createdAt: 1, text: '帮我记第一组九次' },
        { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: saved },
      streamChunkDelayMs: 0,
    });

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0].messages)).not.toContain(marker);
    expect(JSON.stringify(bodies[1].messages)).not.toContain(marker);
    expect(JSON.stringify(bodies[2].messages)).toContain(marker);
  });

  it('R2-4：崩溃在 awaiting_followup_model 且模型续调新工具 call-2 时完整冻结执行、配对写入并清理 pendingTurn', async () => {
    const { session } = await seedReliabilityActiveSession('sess-r2-cold-multiround');
    const ex = session.exercises[0];
    let savedPending: CoachPendingTurn | null = null;

    vi.stubGlobal('fetch', async () =>
      sseFrame(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call-cold-1',
              type: 'function',
              function: {
                name: 'record_active_set',
                arguments: JSON.stringify({
                  sessionId: session.id,
                  exId: ex.id,
                  setId: ex.sets[0].id,
                  reps: 9,
                  status: 'done',
                }),
              },
            },
          ],
        },
        'tool_calls',
      ),
    );

    const tid = (await loadCoachThreadsState()).activeThreadId;
    await expect(
      runCoachTurn({
        threadId: tid,
        userText: '帮我记前两组每组九次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
        onPendingTurnChange(p) {
          if (p?.status === 'awaiting_followup_model') {
            savedPending = structuredClone(p);
            throw new Error('simulated crash after first commit');
          }
        },
      }),
    ).rejects.toThrow('simulated crash after first commit');

    expect(savedPending).not.toBeNull();
    let reqCount = 0;
    vi.stubGlobal('fetch', async () => {
      reqCount += 1;
      if (reqCount === 1) {
        return sseFrame(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-cold-2',
                type: 'function',
                function: {
                  name: 'record_active_set',
                  arguments: JSON.stringify({
                    sessionId: session.id,
                    exId: ex.id,
                    setId: ex.sets[1].id,
                    reps: 9,
                    status: 'done',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        );
      }
      return sseFrame({ content: '两组 9 次都已记好并确认。' }, 'stop');
    });

    const resumed = await resumePendingCoachTurn({
      pendingTurn: (await getPendingTurn(savedPending!.turnId))!,
      providerConfig: dsCfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: (await getSession(session.id))! },
    });

    expect(resumed.resumed).toBe(true);
    expect(reqCount).toBe(2);
    expect(resumed.text).toContain('两组 9 次都已记好并确认');
    const finalSess = (await getSession(session.id))!;
    expect(finalSess.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(2);
    expect(await getPendingTurn(savedPending!.turnId)).toBeUndefined();
    const entries = await listProtocolEntries(savedPending!.threadId, savedPending!.segmentId);
    expect(entries.some((e) => e.kind === 'tool' && e.toolCallId === 'call-cold-2')).toBe(true);
  });

  it('R2-5：clearDurableRestTimerIfMatches 单事务原子比对删除：并发写入 token-B 时 token-A 清理绝不误删 B', async () => {
    const { session } = await seedReliabilityActiveSession('sess-r2-atomic-timer');
    const key = `rest-timer-state:${session.id}`;
    const mk = (token: string): DurableRestTimerRecord => ({
      v: 1,
      sessionId: session.id,
      token,
      source: null,
      generation: 1,
      intentWatermark: 1,
      endsAt: Date.now() + 90_000,
      pausedRemaining: null,
      status: 'running',
      savedAt: Date.now(),
      restoreEpoch: 1,
      nativeScheduled: false,
    });

    await idbPut('meta', { key, value: mk('token-A') });
    await Promise.all([
      clearDurableRestTimerIfMatches(session.id, { token: 'token-A', restoreEpoch: 1 }),
      idbPut('meta', { key, value: mk('token-B') }),
    ]);

    const row = await idbGet<{ key: string; value?: DurableRestTimerRecord }>('meta', key);
    expect(row?.value?.token).toBe('token-B');
  });

  it('R2-6：benchmark --live 在假端点纯文本下 A/B 均计 0 组且工具均为 OpenAI function 包装，--provider all 自动隔离检查点并校验时间窗', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'motion-bench-r2-'));
    try {
      const ckptArg = join(tmpDir, 'bench-ckpt.json');
      const script = `
        process.env.DEEPSEEK_API_KEY = 'synthetic-ds';
        process.env.DASHSCOPE_API_KEY = 'synthetic-bl';
        process.argv = [
          process.execPath,
          'scripts/coach-cache-benchmark.mjs',
          '--live',
          '--provider', 'all',
          '--bucket', 'first_turn',
          '--checkpoint', ${JSON.stringify(ckptArg)},
        ];
        const toolShapes = [];
        globalThis.fetch = async (_url, opts) => {
          const body = JSON.parse(opts.body);
          toolShapes.push(Object.keys(body.tools[0]));
          const usage = { prompt_tokens: 900, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900, completion_tokens: 10 };
          const content = '仅文字确认，不执行工具写库';
          if (!body.stream) {
            return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage });
          }
          const chunk = { choices: [{ delta: { reasoning_content: 'think', content }, finish_reason: 'stop' }], usage };
          return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        };
        const origLog = console.log;
        console.log = (...args) => {
          const report = JSON.parse(args[0]);
          origLog(JSON.stringify({
            toolShapes,
            targets: report.targets.map((t) => ({
              providerKey: t.providerKey,
              aLogged: t.baselineA_v022_cumulative.loggedSetsInDb,
              bLogged: t.cumulativeSummary.loggedSetsInDb,
              bucket0: t.buckets[0],
            })),
          }));
        };
        await import('./scripts/coach-cache-benchmark.mjs');
      `;
      const res1 = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: script,
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(res1.status, res1.stderr).toBe(0);
      const parsed = JSON.parse(res1.stdout.trim()) as {
        toolShapes: string[][];
        targets: Array<{ providerKey: string; aLogged: number; bLogged: number; bucket0: { windowMatched: boolean } }>;
      };
      expect(parsed.targets).toHaveLength(2);
      expect(parsed.targets[0].aLogged).toBe(0);
      expect(parsed.targets[0].bLogged).toBe(0);
      expect(parsed.targets[1].aLogged).toBe(0);
      expect(parsed.targets[1].bLogged).toBe(0);
      expect(parsed.toolShapes.every((ks) => ks.includes('type') && ks.includes('function'))).toBe(true);
      expect(existsSync(join(tmpDir, 'bench-ckpt.deepseek.json'))).toBe(true);
      expect(existsSync(join(tmpDir, 'bench-ckpt.bailian.json'))).toBe(true);

      // 使用刚刚跑过 first_turn 的检查点立即 --resume inter_set_90s，必须因未满 75s 被标为 elapsed_out_of_window 且零网络请求
      const resumeScript = `
        process.env.DEEPSEEK_API_KEY = 'synthetic-ds';
        process.argv = [
          process.execPath,
          'scripts/coach-cache-benchmark.mjs',
          '--live',
          '--provider', 'deepseek',
          '--bucket', 'inter_set_90s',
          '--resume',
          '--checkpoint', ${JSON.stringify(join(tmpDir, 'bench-ckpt.deepseek.json'))},
        ];
        let networkCalls = 0;
        globalThis.fetch = async () => { networkCalls += 1; throw new Error('should not call network out of window'); };
        const origLog = console.log;
        console.log = (...args) => {
          const report = JSON.parse(args[0]);
          origLog(JSON.stringify({ networkCalls, bucket0: report.targets[0].buckets[0] }));
        };
        await import('./scripts/coach-cache-benchmark.mjs');
      `;
      const res2 = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: resumeScript,
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      expect(res2.status, res2.stderr).toBe(0);
      const out2 = JSON.parse(res2.stdout.trim()) as {
        networkCalls: number;
        bucket0: { status: string; windowMatched: boolean };
      };
      expect(out2.networkCalls).toBe(0);
      expect(out2.bucket0.status).toBe('elapsed_out_of_window');
      expect(out2.bucket0.windowMatched).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('v0.2.3 R3 复核缺陷全链路回归', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    registerSessionRuntime(null);
    __resetFocusGuardForTest();
  });

  const dsCfg = {
    key: 'provider' as const,
    kind: 'openai-compatible' as const,
    presetId: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    thinkingDepth: 'high' as const,
    apiKey: 'sk-r3-test',
    updatedAt: 1_767_000_000_000,
  };

  function dsSse(delta: Record<string, unknown>, finishReason: string): Response {
    return makeR1Sse([
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: 'R3推理', ...delta }, finish_reason: finishReason }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 18,
          prompt_cache_hit_tokens: 512,
          prompt_cache_miss_tokens: 488,
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }

  function antSse(
    blocks: Array<Record<string, unknown>>,
    stopReason: 'tool_use' | 'end_turn',
  ): Response {
    const events: string[] = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      })}\n\n`,
    ];
    blocks.forEach((blk, index) => {
      if (blk.type === 'thinking') {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'thinking', thinking: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: String(blk.thinking ?? '') },
          })}\n\n`,
        );
        if (blk.signature) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: String(blk.signature) },
            })}\n\n`,
          );
        }
        events.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`);
      } else if (blk.type === 'redacted_thinking') {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'redacted_thinking', data: String(blk.data ?? '') },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
        );
      } else if (blk.type === 'tool_use') {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(blk.input ?? {}) },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
        );
      } else {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: String(blk.text ?? '') },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index })}\n\n`,
        );
      }
    });
    events.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 32 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    );
    return makeR1Sse(events);
  }

  it('R3-1：正常多步续调与冷恢复均保护模型未见的第2组手改（12次+备注），且无手改时两组顺序提交正常通过', async () => {
    const { getSession } = await import('../src/db/repo');
    const { atomicWriteSession } = await import('../src/db/tx');

    // 1a. 在线多步工具调用期间手改第 2 组为 12 次 + 备注 -> 旧视图第 2 组 9 次被 version-conflict 拦截并披露 latestSet
    {
      const { session } = await seedReliabilityActiveSession('sess-r3-1-live');
      const ex = session.exercises[0];
      const manualNote = 'R3_LIVE_SECOND_MANUAL';
      let round = 0;
      const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];

      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages: Array<{ role: string; content?: unknown }>;
        };
        bodies.push(body);
        round += 1;
        if (round === 1) {
          const edited = structuredClone(session);
          edited.exercises[0].sets[1] = {
            ...edited.exercises[0].sets[1],
            reps: 12,
            status: 'done',
            note: manualNote,
          };
          const wr = await atomicWriteSession({
            session: edited,
            expectedRevision: session.revision,
            editorId: 'editor-r1',
            lockPolicy: 'optional',
            intent: { kind: 'active-save' },
          });
          expect(wr.ok).toBe(true);
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-r3-live-1',
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({
                      sessionId: session.id,
                      exId: ex.id,
                      setId: ex.sets[0].id,
                      reps: 9,
                      status: 'done',
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        if (round === 2) {
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-r3-live-2',
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({
                      sessionId: session.id,
                      exId: ex.id,
                      setId: ex.sets[1].id,
                      reps: 9,
                      status: 'done',
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        return dsSse({ content: '第1组已记9次；第2组检测到您手改为12次，已保留。' }, 'stop');
      });

      const tid = (await loadCoachThreadsState()).activeThreadId;
      const out = await runCoachTurn({
        threadId: tid,
        userText: '把前两组记成9次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });

      expect(out.receipts).toHaveLength(1);
      const after = (await getSession(session.id))!;
      expect(after.exercises[0].sets[0].reps).toBe(9);
      expect(after.exercises[0].sets[1].reps).toBe(12);
      expect(after.exercises[0].sets[1].note).toBe(manualNote);

      const conflictToolMsg = bodies[2].messages.find((m) => m.role === 'tool' && String(m.content).includes('version-conflict'));
      expect(conflictToolMsg).toBeTruthy();
      const conflictObj = JSON.parse(String(conflictToolMsg!.content)) as {
        errorCode?: string;
        data?: { latestSet?: { reps?: number; note?: string } };
      };
      expect(conflictObj.errorCode).toBe('version-conflict');
      expect(conflictObj.data?.latestSet?.reps).toBe(12);
      expect(conflictObj.data?.latestSet?.note).toBe(manualNote);
      expect(String(conflictToolMsg!.content)).not.toContain('"before"');
      expect(String(conflictToolMsg!.content)).not.toContain('"after"');
    }

    // 1b. 冷恢复：第 1 组提交后停在 awaiting_followup_model -> 外部手改第 2 组 12 次 -> resumePendingCoachTurn 必须沿用冻结视图
    {
      await resetEverything();
      const { session } = await seedReliabilityActiveSession('sess-r3-1-cold');
      const ex = session.exercises[0];
      const coldNote = 'R3_COLD_SECOND_MANUAL';
      let capturedPending: CoachPendingTurn | null = null;

      vi.stubGlobal('fetch', async () =>
        dsSse(
          {
            tool_calls: [
              {
                index: 0,
                id: 'call-r3-cold-1',
                type: 'function',
                function: {
                  name: 'record_active_set',
                  arguments: JSON.stringify({
                    sessionId: session.id,
                    exId: ex.id,
                    setId: ex.sets[0].id,
                    reps: 9,
                    status: 'done',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      );

      const tid = (await loadCoachThreadsState()).activeThreadId;
      await expect(
        runCoachTurn({
          threadId: tid,
          userText: '帮我把前两组记成9次',
          history: [],
          thinkingDepth: 'high',
          providerConfig: dsCfg,
          toolContext: { activeSession: session },
          streamChunkDelayMs: 0,
          onPendingTurnChange(p) {
            if (p?.status === 'awaiting_followup_model') {
              capturedPending = structuredClone(p);
              throw new Error('simulated crash before followup');
            }
          },
        }),
      ).rejects.toThrow('simulated crash before followup');

      const snapPending = capturedPending as CoachPendingTurn | null;
      expect(snapPending?.frozenView?.activeSession?.revision).toBe((session.revision ?? 0) + 1);
      const afterSet1 = (await getSession(session.id))!;
      const manual2 = structuredClone(afterSet1);
      manual2.exercises[0].sets[1] = {
        ...manual2.exercises[0].sets[1],
        reps: 12,
        status: 'done',
        note: coldNote,
      };
      const wr = await atomicWriteSession({
        session: manual2,
        expectedRevision: afterSet1.revision,
        editorId: 'editor-r1',
        lockPolicy: 'optional',
        intent: { kind: 'active-save' },
      });
      expect(wr.ok).toBe(true);

      let resumeReq = 0;
      vi.stubGlobal('fetch', async () => {
        resumeReq += 1;
        if (resumeReq === 1) {
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-r3-cold-2',
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({
                      sessionId: session.id,
                      exId: ex.id,
                      setId: ex.sets[1].id,
                      reps: 9,
                      status: 'done',
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        return dsSse({ content: '已保留您手改的第2组12次。' }, 'stop');
      });

      const resumed = await resumePendingCoachTurn({
        pendingTurn: (await getPendingTurn(capturedPending!.turnId))!,
        providerConfig: dsCfg,
        thinkingDepth: 'high',
        toolContext: { activeSession: (await getSession(session.id))! },
      });
      expect(resumed.resumed).toBe(true);
      const finalCold = (await getSession(session.id))!;
      expect(finalCold.exercises[0].sets[0].reps).toBe(9);
      expect(finalCold.exercises[0].sets[1].reps).toBe(12);
      expect(finalCold.exercises[0].sets[1].note).toBe(coldNote);
    }

    // 1c. 正向：无并发手改时，连续两轮工具顺次提交前两组均成功落库
    {
      await resetEverything();
      const { session } = await seedReliabilityActiveSession('sess-r3-1-happy');
      const ex = session.exercises[0];
      let round = 0;
      vi.stubGlobal('fetch', async () => {
        round += 1;
        if (round === 1 || round === 2) {
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: `call-r3-happy-${round}`,
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({
                      sessionId: session.id,
                      exId: ex.id,
                      setId: ex.sets[round - 1].id,
                      reps: 9,
                      status: 'done',
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        return dsSse({ content: '两组 9 次全部记好了。' }, 'stop');
      });
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const out = await runCoachTurn({
        threadId: tid,
        userText: '帮我把前两组记成9次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(out.receipts).toHaveLength(2);
      const saved = (await getSession(session.id))!;
      expect(saved.exercises[0].sets[0].reps).toBe(9);
      expect(saved.exercises[0].sets[0].status).toBe('done');
      expect(saved.exercises[0].sets[1].reps).toBe(9);
      expect(saved.exercises[0].sets[1].status).toBe('done');
    }
  });

  it('R3-2：删除含引号/反斜杠/换行的长期记忆后，删除确认/下轮/重启重放零泄漏且 JSON 合法，Anthropic 签名思考块清段保配对与本地 Undo', async () => {
    const { getSession } = await import('../src/db/repo');

    // 2a. DeepSeek / OpenAI-compatible：含双引号、反斜杠与换行符
    {
      const { session } = await seedReliabilityActiveSession('sess-r3-2-special-chars');
      const secretTitle = '右肩 "特殊训练" 约束';
      const secretContent = '右肩 "前束不适" 记录路径 C:\\gym\\rehab\n第二行禁止大重量';
      const capturedBodies: Array<Record<string, unknown>> = [];
      let phase: 'save' | 'delete' | 'chat' | 'reload' = 'save';

      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        capturedBodies.push(parsed);
        const msgs = (parsed.messages ?? []) as Array<{ role?: string; tool_calls?: Array<{ id?: string; function?: { arguments?: string } }> }>;
        const lastRole = msgs[msgs.length - 1]?.role;
        if (phase === 'save' && lastRole === 'user') {
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-mem-save-special',
                  type: 'function',
                  function: {
                    name: 'manage_coach_memory',
                    arguments: JSON.stringify({
                      action: 'save',
                      category: 'injury',
                      title: secretTitle,
                      content: secretContent,
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        if (phase === 'delete' && lastRole === 'user') {
          const memItems = (await loadCoachMemory()).items;
          return dsSse(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-mem-del-special',
                  type: 'function',
                  function: {
                    name: 'manage_coach_memory',
                    arguments: JSON.stringify({
                      action: 'delete',
                      id: memItems[0].id,
                    }),
                  },
                },
              ],
            },
            'tool_calls',
          );
        }
        return dsSse({ content: '已收到。' }, 'stop');
      });

      const tid = (await loadCoachThreadsState()).activeThreadId;
      const t1 = await runCoachTurn({
        threadId: tid,
        userText: '帮我记住一条限制',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect((await loadCoachMemory()).items).toHaveLength(1);

      phase = 'delete';
      const reqCountBeforeDeleteConfirm = capturedBodies.length + 1;
      const t2 = await runCoachTurn({
        threadId: tid,
        userText: '把那条限制删掉',
        history: [
          { id: 'u1', role: 'user', createdAt: 1, text: '帮我记住一条限制' },
          { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
        ],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect((await loadCoachMemory()).items).toHaveLength(0);

      phase = 'chat';
      const t3 = await runCoachTurn({
        threadId: tid,
        userText: '今天练什么？',
        history: [
          { id: 'u1', role: 'user', createdAt: 1, text: '帮我记住一条限制' },
          { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
          { id: 'u2', role: 'user', createdAt: 3, text: '把那条限制删掉' },
          { id: 'a2', role: 'assistant', createdAt: 4, text: t2.text, reasoning: t2.reasoning },
        ],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });

      phase = 'reload';
      await runCoachTurn({
        threadId: tid,
        userText: '重启后再问一句',
        history: [
          { id: 'u1', role: 'user', createdAt: 1, text: '帮我记住一条限制' },
          { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
          { id: 'u2', role: 'user', createdAt: 3, text: '把那条限制删掉' },
          { id: 'a2', role: 'assistant', createdAt: 4, text: t2.text, reasoning: t2.reasoning },
          { id: 'u3', role: 'user', createdAt: 5, text: '今天练什么？' },
          { id: 'a3', role: 'assistant', createdAt: 6, text: t3.text, reasoning: t3.reasoning },
        ],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });

      const postDeleteBodies = capturedBodies.slice(reqCountBeforeDeleteConfirm);
      expect(postDeleteBodies.length).toBeGreaterThanOrEqual(3); // 删除确认 + 下一轮 + 重启重放
      for (const body of postDeleteBodies) {
        const serialized = JSON.stringify(body.messages);
        expect(serialized).not.toContain('前束不适');
        expect(serialized).not.toContain('C:\\\\gym\\\\rehab');
        expect(serialized).not.toContain('第二行禁止大重量');
        expect(serialized).not.toContain('特殊训练');
        const msgs = (body.messages ?? []) as Array<{
          tool_calls?: Array<{ function?: { arguments?: string } }>;
        }>;
        for (const m of msgs) {
          for (const tc of m.tool_calls ?? []) {
            const decoded = JSON.parse(String(tc.function?.arguments ?? '{}')) as Record<string, unknown>;
            const decodedStr = JSON.stringify(decoded);
            expect(decodedStr).not.toContain('前束不适');
            expect(decodedStr).not.toContain('第二行禁止大重量');
            expect(decodedStr).not.toContain('特殊训练');
          }
        }
      }
    }

    // 2b. Anthropic：含 signature 的 thinking 与 redacted_thinking 被触及时从干净基线开段，保留当前 tool_use/tool_result 配对与本地 Undo
    {
      await resetEverything();
      const { session } = await seedReliabilityActiveSession('sess-r3-2-anthropic');
      const ex = session.exercises[0];
      const antCfg = {
        key: 'provider' as const,
        kind: 'anthropic' as const,
        presetId: 'anthropic-official',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        thinkingDepth: 'high' as const,
        apiKey: 'sk-ant-r3',
        updatedAt: 1_767_000_000_000,
      };
      const antSecret = 'Anthropic隐私 "左肩旧伤" 注意动作';
      const sentBodies: Array<{
        system?: Array<{ text?: string }>;
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      }> = [];
      let step = 0;

      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as (typeof sentBodies)[number];
        sentBodies.push(parsed);
        step += 1;
        if (step === 1) {
          return antSse(
            [
              {
                type: 'tool_use',
                id: 'tu-ant-set-1',
                name: 'record_active_set',
                input: { sessionId: session.id, exId: ex.id, setId: ex.sets[0].id, reps: 10, status: 'done' },
              },
            ],
            'tool_use',
          );
        }
        if (step === 2) {
          return antSse([{ type: 'text', text: '第1组已记好。' }], 'end_turn');
        }
        if (step === 3) {
          return antSse(
            [
              { type: 'thinking', thinking: `记录秘密 ${antSecret}`, signature: 'sig-tainted-1' },
              { type: 'redacted_thinking', data: 'opaque-secret-block' },
              {
                type: 'tool_use',
                id: 'tu-ant-mem-save',
                name: 'manage_coach_memory',
                input: { action: 'save', category: 'injury', title: '左肩提示', content: antSecret },
              },
            ],
            'tool_use',
          );
        }
        if (step === 4) {
          return antSse([{ type: 'text', text: '已记住。' }], 'end_turn');
        }
        if (step === 5) {
          const [item] = (await loadCoachMemory()).items;
          return antSse(
            [
              { type: 'thinking', thinking: '准备删除该条记录', signature: 'sig-clean-del' },
              {
                type: 'tool_use',
                id: 'tu-ant-mem-del',
                name: 'manage_coach_memory',
                input: { action: 'delete', id: item.id },
              },
            ],
            'tool_use',
          );
        }
        return antSse([{ type: 'text', text: '已删除并确认。' }], 'end_turn');
      });

      const tid = (await loadCoachThreadsState()).activeThreadId;
      const tSet = await runCoachTurn({
        threadId: tid,
        userText: '帮我记第1组10次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: antCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      const setReceiptId = tSet.receipts[0].id;

      const tMem = await runCoachTurn({
        threadId: tid,
        userText: '保存左肩提示',
        history: [
          { id: 'au1', role: 'user', createdAt: 1, text: '帮我记第1组10次' },
          { id: 'aa1', role: 'assistant', createdAt: 2, text: tSet.text },
        ],
        thinkingDepth: 'high',
        providerConfig: antCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });

      const tDel = await runCoachTurn({
        threadId: tid,
        userText: '忘掉刚才的左肩提示',
        history: [
          { id: 'au1', role: 'user', createdAt: 1, text: '帮我记第1组10次' },
          { id: 'aa1', role: 'assistant', createdAt: 2, text: tSet.text },
          { id: 'au2', role: 'user', createdAt: 3, text: '保存左肩提示' },
          { id: 'aa2', role: 'assistant', createdAt: 4, text: tMem.text },
        ],
        thinkingDepth: 'high',
        providerConfig: antCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });

      await runCoachTurn({
        threadId: tid,
        userText: '再继续聊训练',
        history: [
          { id: 'au1', role: 'user', createdAt: 1, text: '帮我记第1组10次' },
          { id: 'aa1', role: 'assistant', createdAt: 2, text: tSet.text },
          { id: 'au2', role: 'user', createdAt: 3, text: '保存左肩提示' },
          { id: 'aa2', role: 'assistant', createdAt: 4, text: tMem.text },
          { id: 'au3', role: 'user', createdAt: 5, text: '忘掉刚才的左肩提示' },
          { id: 'aa3', role: 'assistant', createdAt: 6, text: tDel.text },
        ],
        thinkingDepth: 'high',
        providerConfig: antCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });

      expect((await loadCoachMemory()).items).toHaveLength(0);
      const delConfirmReq = sentBodies[5];
      const nextTurnReq = sentBodies[6];
      expect(JSON.stringify(delConfirmReq)).not.toContain('左肩旧伤');
      expect(JSON.stringify(delConfirmReq)).not.toContain('sig-tainted-1');
      expect(JSON.stringify(delConfirmReq)).not.toContain('opaque-secret-block');
      expect(JSON.stringify(nextTurnReq)).not.toContain('左肩旧伤');

      // 当前 delete 工具链配对（assistant tool_use -> user tool_result）完整保留
      const hasPairedDelToolUse = delConfirmReq.messages.some(
        (m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool_use' && c.id === 'tu-ant-mem-del'),
      );
      const hasPairedDelToolResult = delConfirmReq.messages.some(
        (m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'tu-ant-mem-del'),
      );
      expect(hasPairedDelToolUse).toBe(true);
      expect(hasPairedDelToolResult).toBe(true);

      // 本地 Undo 仍可正常回滚之前的记组写入
      const undoRes = await undoCoachReceipt(setReceiptId);
      expect(undoRes.receipt.undone).toBe(true);
      const afterUndo = (await getSession(session.id))!;
      expect(afterUndo.exercises[0].sets[0].status).toBe('blank');
    }
  });

  it('R3-3：冷恢复绑定原部署/端点路径/协议/模型/思考档位；无原配置时阻断保 pending，有原配置时用原路由恢复且新设置于下一新轮生效', async () => {
    const { getSession } = await import('../src/db/repo');
    const routeACfg = {
      key: 'provider' as const,
      kind: 'openai-compatible' as const,
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      thinkingDepth: 'high' as const,
      apiKey: 'sk-route-a',
      updatedAt: 1_767_000_000_000,
    };

    const seedSuspendedTurn = async (sid: string) => {
      await resetEverything();
      const { session } = await seedReliabilityActiveSession(sid);
      const ex = session.exercises[0];
      let savedPending: CoachPendingTurn | null = null;
      vi.stubGlobal('fetch', async () =>
        dsSse(
          {
            tool_calls: [
              {
                index: 0,
                id: `call-susp-${sid}`,
                type: 'function',
                function: {
                  name: 'record_active_set',
                  arguments: JSON.stringify({
                    sessionId: session.id,
                    exId: ex.id,
                    setId: ex.sets[0].id,
                    reps: 10,
                    status: 'done',
                  }),
                },
              },
            ],
          },
          'tool_calls',
        ),
      );
      const tid = (await loadCoachThreadsState()).activeThreadId;
      await expect(
        runCoachTurn({
          threadId: tid,
          userText: '帮我记第一组10次',
          history: [],
          thinkingDepth: 'high',
          providerConfig: routeACfg,
          toolContext: { activeSession: session },
          streamChunkDelayMs: 0,
          onPendingTurnChange(p) {
            if (p?.status === 'awaiting_followup_model') {
              savedPending = structuredClone(p);
              throw new Error('suspend on route A');
            }
          },
        }),
      ).rejects.toThrow('suspend on route A');
      return { session, pending: (await getPendingTurn(savedPending!.turnId))! };
    };

    // 3a. 无原路由配置时：换主机、同主机换路径(/v2)、或换模型均零请求阻断且保留 pendingTurn 与第1组
    {
      const { session, pending } = await seedSuspendedTurn('sess-r3-3-block');
      const mismatchedTargets = [
        { ...routeACfg, baseUrl: 'https://route-b.example.invalid/v1' },
        { ...routeACfg, baseUrl: 'https://api.deepseek.com/v2' },
        { ...routeACfg, model: 'deepseek-v4-pro' },
      ];
      let calls = 0;
      vi.stubGlobal('fetch', async () => {
        calls += 1;
        return dsSse({ content: 'forbidden' }, 'stop');
      });
      for (const badCfg of mismatchedTargets) {
        const res = await resumePendingCoachTurn({
          pendingTurn: pending,
          providerConfig: badCfg,
          thinkingDepth: 'off',
          toolContext: { activeSession: (await getSession(session.id))! },
        });
        expect(res.resumed).toBe(false);
        expect(res.routeMismatch).toBe(true);
        expect(res.needsConfirmationStream).toBe(true);
        expect(res.text).toContain('端点');
      }
      expect(calls).toBe(0);
      expect(await getPendingTurn(pending.turnId)).toBeTruthy();
      const sNow = (await getSession(session.id))!;
      expect(sNow.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    }

    // 3b. Vault 保存了原路由有效配置：即使当前切换到 route-b 与 thinking=off，恢复仍发往 route-a 且保持高思考，下一新轮再用 route-b
    {
      const { session, pending } = await seedSuspendedTurn('sess-r3-3-recover');
      await saveCoachProviderConfig(routeACfg);
      const routeBCfg = {
        key: 'provider' as const,
        kind: 'openai-compatible' as const,
        baseUrl: 'https://route-b.example.invalid/v1',
        model: 'custom-b-model',
        thinkingDepth: 'off' as const,
        apiKey: 'sk-route-b',
        updatedAt: 1_767_000_000_500,
      };
      await saveCoachProviderConfig(routeBCfg);
      expect(await findSavedProviderConfigForRoute({
        kind: routeACfg.kind,
        baseUrl: routeACfg.baseUrl,
        model: routeACfg.model,
      })).toMatchObject({ baseUrl: routeACfg.baseUrl, model: routeACfg.model });

      const reqUrls: string[] = [];
      const reqBodies: Array<{ model?: string; thinking?: { type?: string }; reasoning_effort?: string }> = [];
      vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
        reqUrls.push(String(url));
        reqBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return dsSse({ content: '已按原部署确认。' }, 'stop');
      });

      const res = await resumePendingCoachTurn({
        pendingTurn: pending,
        providerConfig: routeBCfg,
        thinkingDepth: 'off',
        toolContext: { activeSession: (await getSession(session.id))! },
      });
      expect(res.resumed).toBe(true);
      expect(reqUrls[0]).toContain('api.deepseek.com/v1');
      expect(reqBodies[0].model).toBe('deepseek-flash');
      expect(reqBodies[0].thinking).toEqual({ type: 'enabled' });
      expect(reqBodies[0].reasoning_effort).toBe('high');
      expect(await getPendingTurn(pending.turnId)).toBeUndefined();

      // 下一条新用户轮起，新设置 route-b 生效
      await runCoachTurn({
        threadId: pending.threadId,
        userText: '新的一轮问候',
        history: [{ id: 'ru1', role: 'user', createdAt: 1, text: '帮我记第一组10次' }],
        thinkingDepth: 'off',
        providerConfig: routeBCfg,
        toolContext: { activeSession: (await getSession(session.id))! },
        streamChunkDelayMs: 0,
      });
      expect(reqUrls[1]).toContain('route-b.example.invalid/v1');
      expect(reqBodies[1].model).toBe('custom-b-model');
    }
  });

  it('R3-4：无活跃训练先聊天，再开训时首条训练请求送达新 sessionId 及可定位动作/组 ID，后续同状态复用前缀', async () => {
    const { getSession, savePlan } = await import('../src/db/repo');
    const { atomicCreateSession } = await import('../src/db/tx');
    const { createV32Plan } = await import('../src/domain/presets/v32');
    const { createSession } = await import('../src/domain/session');

    await resetEverything();
    const plan = makePlan();
    await savePlan(plan);
    const tid = (await loadCoachThreadsState()).activeThreadId;
    const reqs: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];

    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      reqs.push(JSON.parse(String(init?.body ?? '{}')));
      return dsSse({ content: '好的。' }, 'stop');
    });

    const t1 = await runCoachTurn({
      threadId: tid,
      userText: '还没开训，先聊聊今天状态',
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: null },
      streamChunkDelayMs: 0,
    });

    const newSess = { ...createSession(createV32Plan(NOW), plan.days[0], NOW), id: 'sess-r3-4-started' };
    expect((await atomicCreateSession({ session: newSess })).ok).toBe(true);
    await acquireSessionLock(newSess.id, 'editor-r3-4');
    const freshSess = (await getSession(newSess.id))!;

    const t2 = await runCoachTurn({
      threadId: tid,
      userText: '刚点开始训练，第一个动作是什么？',
      history: [
        { id: 'u1', role: 'user', createdAt: 1, text: '还没开训，先聊聊今天状态' },
        { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: freshSess },
      streamChunkDelayMs: 0,
    });

    await runCoachTurn({
      threadId: tid,
      userText: '第一组目标是多少？',
      history: [
        { id: 'u1', role: 'user', createdAt: 1, text: '还没开训，先聊聊今天状态' },
        { id: 'a1', role: 'assistant', createdAt: 2, text: t1.text, reasoning: t1.reasoning },
        { id: 'u2', role: 'user', createdAt: 3, text: '刚点开始训练，第一个动作是什么？' },
        { id: 'a2', role: 'assistant', createdAt: 4, text: t2.text, reasoning: t2.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(freshSess.id) },
      streamChunkDelayMs: 0,
    });

    expect(reqs).toHaveLength(3);
    expect(JSON.stringify(reqs[0].messages)).not.toContain(freshSess.id);

    const turn2LastMsg = String(reqs[1].messages[reqs[1].messages.length - 1].content);
    expect(turn2LastMsg).toContain('[新训练开始');
    expect(turn2LastMsg).toContain(freshSess.id);
    expect(turn2LastMsg).toContain(freshSess.exercises[0].id);
    expect(turn2LastMsg).toContain(freshSess.exercises[0].sets[0].id);

    const turn3LastMsg = String(reqs[2].messages[reqs[2].messages.length - 1].content);
    expect(turn3LastMsg).toBe('第一组目标是多少？');

    // 单一分段且 Turn 3 逐字节延续 Turn 2 的消息前缀
    const th = (await loadCoachThreadsState()).threads.find((t) => t.id === tid)!;
    expect(Object.keys(th.segments ?? {})).toHaveLength(1);
    expect(JSON.stringify(reqs[2].messages.slice(0, reqs[1].messages.length))).toBe(
      JSON.stringify(reqs[1].messages),
    );
  });

  it('R3-5：A/B 基准 --live 验证合法记组 A=1/B=1、参数对称、分臂请求时刻/间隔、--resume 多组与工具失败不可比标记', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const tmpDir = mkdtempSync(join(tmpdir(), 'motion-bench-r3-'));
    try {
      const ckptPath = join(tmpDir, 'bench-r3-live.json');

      const runBenchSub = (args: string[], mode: 'valid' | 'bad_tool', setRoundIdx: number) => {
        const runner = `
          process.env.DEEPSEEK_API_KEY = 'synthetic-r3-ds';
          process.argv = [process.execPath, 'scripts/coach-cache-benchmark.mjs', ...${JSON.stringify(args)}];
          const captured = [];
          globalThis.fetch = async (_url, opts) => {
            const b = JSON.parse(opts.body);
            const last = b.messages.at(-1);
            const follow = last.role === 'tool';
            const usage = { prompt_tokens: 1100, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 460, completion_tokens: 14 };
            const targetSessId = JSON.stringify(b.messages).match(/sess-live-(?:baseline-)?deepseek-[a-z0-9-]+/)?.[0];
            if (!targetSessId) throw new Error('Missing target sessionId in messages');
            const toolArgs = ${mode === 'valid'
              ? `{ sessionId: targetSessId, exerciseName: '双杠臂屈伸', roundIndex: ${setRoundIdx}, reps: 10, weightKg: 60, status: 'done' }`
              : `{ sessionId: targetSessId, exerciseName: '不存在动作', roundIndex: ${setRoundIdx}, reps: 10, weightKg: 60, status: 'done' }`
            };
            const tc = {
              id: 'call-' + (b.stream ? 'B' : 'A') + '-' + ${setRoundIdx},
              type: 'function',
              function: { name: 'record_active_set', arguments: JSON.stringify(toolArgs) },
            };
            captured.push({
              arm: b.stream ? 'B' : 'A',
              role: last.role,
              maxTokens: b.max_tokens ?? null,
              reasoningEffort: b.reasoning_effort ?? null,
              thinking: b.thinking ?? null,
            });
            const msgPayload = follow ? { content: '完成确认' } : { tool_calls: [b.stream ? { index: 0, ...tc } : tc] };
            const finish_reason = follow ? 'stop' : 'tool_calls';
            if (!b.stream) {
              return Response.json({ choices: [{ message: { role: 'assistant', reasoning_content: 'r', ...msgPayload }, finish_reason }], usage });
            }
            const chunk = { choices: [{ delta: { reasoning_content: 'r', ...msgPayload }, finish_reason }], usage };
            return new Response('data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n', {
              headers: { 'content-type': 'text/event-stream' },
            });
          };
          const origLog = console.log;
          console.log = (json) => {
            origLog(JSON.stringify({ captured, report: JSON.parse(json) }));
          };
          await import('./scripts/coach-cache-benchmark.mjs');
        `;
        const res = spawnSync(process.execPath, ['--input-type=module', '-'], {
          input: runner,
          cwd: process.cwd(),
          encoding: 'utf8',
        });
        expect(res.status, res.stderr).toBe(0);
        return JSON.parse(res.stdout.trim()) as {
          captured: Array<{
            arm: 'A' | 'B';
            role: string;
            maxTokens: number | null;
            reasoningEffort: string | null;
            thinking: unknown;
          }>;
          report: {
            targets: Array<{
              baselineProvenance: { source: string; note: string };
              controlVariables: { controlsMatched: boolean };
              armAToolErrors: Array<{ errorCode: string }>;
              armBToolErrors: Array<{ errorCode: string }>;
              costPerLoggedSetComparable: boolean;
              incomparableReasons: string[];
              baselineA_v022_cumulative: { loggedSetsInDb: number };
              cumulativeSummary: { loggedSetsInDb: number };
              buckets: Array<{
                armAElapsedSincePrevTurnMs: number | null;
                armBElapsedSincePrevTurnMs: number | null;
                armAPerRequestRecords: Array<{ startedAtMs: number | null; completedAtMs: number | null; purpose: string }>;
                armBPerRequestRecords: Array<{ startedAtMs: number | null; completedAtMs: number | null; purpose: string }>;
              }>;
            }>;
          };
        };
      };

      // 场景 A：合法记组 A=1, B=1 + --resume 续跑第 2 组 A=2, B=2
      const first = runBenchSub(
        ['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', ckptPath],
        'valid',
        1,
      );
      const t1 = first.report.targets[0];
      expect(t1.baselineA_v022_cumulative.loggedSetsInDb).toBe(1);
      expect(t1.cumulativeSummary.loggedSetsInDb).toBe(1);
      expect(t1.costPerLoggedSetComparable).toBe(true);
      expect(t1.controlVariables.controlsMatched).toBe(true);
      expect(t1.baselineProvenance.source).toBe('reconstructed_v022_strategy_on_current_worktree');
      expect(first.captured.every((r) => r.maxTokens === null && r.reasoningEffort === 'low')).toBe(true);
      expect(t1.buckets[0].armAPerRequestRecords.length).toBeGreaterThanOrEqual(2);
      expect(t1.buckets[0].armBPerRequestRecords.length).toBeGreaterThanOrEqual(2);
      expect(t1.buckets[0].armAPerRequestRecords[0].startedAtMs).toBeTypeOf('number');
      expect(t1.buckets[0].armBPerRequestRecords[0].purpose).toBe('initial_turn');
      expect(t1.buckets[0].armBPerRequestRecords[1].purpose).toBe('tool_followup');

      // 模拟 95s 组间休息后用 --resume 跑 inter_set_90s 记第 2 组
      const ckptJson = JSON.parse(readFileSync(ckptPath, 'utf8')) as Record<string, unknown>;
      const fakePast = Date.now() - 95_000;
      ckptJson.lastTurnAtMs = fakePast;
      ckptJson.lastArmATurnAtMs = fakePast;
      ckptJson.lastArmBTurnAtMs = fakePast;
      writeFileSync(ckptPath, JSON.stringify(ckptJson, null, 2), 'utf8');

      const second = runBenchSub(
        ['--live', '--provider', 'deepseek', '--bucket', 'inter_set_90s', '--thinking', 'low', '--resume', '--checkpoint', ckptPath],
        'valid',
        2,
      );
      const t2 = second.report.targets[0];
      expect(t2.baselineA_v022_cumulative.loggedSetsInDb).toBe(2);
      expect(t2.cumulativeSummary.loggedSetsInDb).toBe(2);
      expect(t2.costPerLoggedSetComparable).toBe(true);
      expect(t2.buckets[0].armAElapsedSincePrevTurnMs).toBeGreaterThanOrEqual(75_000);
      expect(t2.buckets[0].armBElapsedSincePrevTurnMs).toBeGreaterThanOrEqual(75_000);

      // 场景 B：工具参数非法触发失败 -> 记录具体 errorCode 并标记不可比
      const badCkpt = join(tmpDir, 'bench-r3-bad.json');
      const bad = runBenchSub(
        ['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', badCkpt],
        'bad_tool',
        1,
      );
      const tb = bad.report.targets[0];
      expect(tb.armAToolErrors.length).toBeGreaterThanOrEqual(1);
      expect(tb.armBToolErrors.length).toBeGreaterThanOrEqual(1);
      expect(tb.armAToolErrors[0].errorCode).toBe('not-found');
      expect(tb.armBToolErrors[0].errorCode).toBe('not-found');
      expect(tb.costPerLoggedSetComparable).toBe(false);
      expect(tb.incomparableReasons).toContain('armA_tool_failures');
      expect(tb.incomparableReasons).toContain('armB_tool_failures');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('v0.2.3 R4 复核缺陷全链路回归', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    registerSessionRuntime(null);
    __resetFocusGuardForTest();
  });

  const providerCfg = {
    key: 'provider' as const,
    kind: 'openai-compatible' as const,
    presetId: 'deepseek-official',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'sk-r4-test',
    updatedAt: 1_767_000_000_000,
  };

  function dsTool(id: string, name: string, args: Record<string, unknown>): Response {
    return makeR1Sse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: 'R4推理',
              tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 12, prompt_cache_hit_tokens: 320, prompt_cache_miss_tokens: 680 },
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }
  function dsAnswer(): Response {
    return makeR1Sse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '合成确认' }, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  }

  it('R4-1：次数/休息修改后由手改的备注不被模型误当已见覆盖（same_set 与 adjust_rest 竞争场景）；无手改时两组顺序提交正常', async () => {
    // 正常路径：无并发手改时两组顺序提交均成功
    {
      await resetEverything();
      const { session } = await seedActive({ sessionId: 'sess-r4-normal' });
      const modelSession = structuredClone(session);
      const ex = session.exercises[0];
      let n = 0;
      const outcomes: boolean[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const last = body.messages.at(-1);
        if (last?.role === 'tool') {
          try { outcomes.push(Boolean(JSON.parse(last.content).ok)); } catch { /* ignore */ }
        }
        n += 1;
        if (n === 1) return dsTool('w1', 'record_active_set', { sessionId: session.id, exId: ex.id, setId: ex.sets[0].id, reps: 9, status: 'done' });
        if (n === 2) return dsTool('w2', 'record_active_set', { sessionId: session.id, exId: ex.id, setId: ex.sets[1].id, reps: 8, status: 'done' });
        return dsAnswer();
      }));
      await runCoachTurn({ providerConfig: providerCfg, thinkingDepth: 'high', userText: '请把前两组分别记为九次和八次', history: [], toolContext: { activeSession: modelSession } });
      const saved = (await getSession(session.id))!.exercises[0].sets;
      expect(saved[0].status).toBe('done');
      expect(saved[1].status).toBe('done');
      expect(outcomes.every((o) => o === true)).toBe(true);
    }

    for (const scope of ['same_set', 'adjust_rest'] as const) {
      await resetEverything();
      const { session } = await seedActive({ sessionId: 'sess-r4-' + scope });
      const modelSession = structuredClone(session);
      const ex = session.exercises[0];
      const marker = 'R4_MANUAL_' + scope;
      let n = 0;
      const outcomes: boolean[] = [];
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const last = body.messages.at(-1);
        if (last?.role === 'tool') {
          try { outcomes.push(Boolean(JSON.parse(last.content).ok)); } catch { /* ignore */ }
        }
        n += 1;
        if (n === 1) {
          const cur = (await getSession(session.id))!;
          const upd = structuredClone(cur);
          upd.exercises[0].sets[0].note = marker;
          const w = await atomicWriteSession({ session: upd, expectedRevision: cur.revision, editorId: 'editor-v023', lockPolicy: 'optional', intent: { kind: 'active-save' } });
          expect(w.ok).toBe(true);
          return scope === 'same_set'
            ? dsTool('log', 'record_active_set', { sessionId: session.id, exId: ex.id, setId: ex.sets[0].id, reps: 9, status: 'done' })
            : dsTool('rest', 'adjust_active_target', { sessionId: session.id, exId: ex.id, restSec: 79 });
        }
        if (n === 2) {
          return dsTool('change_note', 'record_active_set', { sessionId: session.id, exId: ex.id, setId: ex.sets[0].id, reps: 9, status: 'done', note: '模型写的备注' });
        }
        return dsAnswer();
      }));
      await runCoachTurn({ providerConfig: providerCfg, thinkingDepth: 'high', userText: '先调整训练，再为第一组写备注', history: [], toolContext: { activeSession: modelSession } });
      const saved = (await getSession(session.id))!.exercises[0];
      // 手改备注必须保留；第一个（次数/休息）修改仍须成功
      expect(saved.sets[0].note, scope).toBe(marker);
      expect(outcomes[0], scope).toBe(true);
      if (scope === 'adjust_rest') expect(saved.restSec).toBe(79);
      else expect(saved.sets[0].reps).toBe(9);
    }
  });

  it('R4-2：同气泡先后删除两条记忆不复活先删内容；少于压缩阈值入口的 existingSummary 亦走可信清理投影', async () => {
    await resetEverything();
    await seedActive({ sessionId: 'sess-r4-mem' });
    const secretA = 'R4_SECRET_ALPHA_5f3a';
    const secretB = 'R4_SECRET_BETA_9c1d';
    let store = createEmptyCoachMemory();
    const ra = upsertCoachMemoryItem(store, { category: 'preference', title: '甲偏好', content: secretA, source: 'coach' });
    store = ra.store;
    const rb = upsertCoachMemoryItem(store, { category: 'preference', title: '乙偏好', content: secretB, source: 'coach' });
    store = rb.store;
    await saveCoachMemory(store);
    await saveCoachMessages([
      { id: 'u1', role: 'user', createdAt: 1, text: '请记住甲的偏好 ' + secretA + '，以及乙的偏好 ' + secretB },
      { id: 'a1', role: 'assistant', createdAt: 2, text: '都记下了' },
      { id: 'u2', role: 'user', createdAt: 3, text: '谢谢' },
      { id: 'a2', role: 'assistant', createdAt: 4, text: '不客气' },
    ] as any);
    // 连续两次删除：第二次必须在既有净化投影上继续清理，绝不能从原文复活第一条
    await purgeDeletedMemoryFromCoachHistory({ memoryId: ra.item.id, memoryTitle: ra.item.title, memoryContent: secretA });
    await purgeDeletedMemoryFromCoachHistory({ memoryId: rb.item.id, memoryTitle: rb.item.title, memoryContent: secretB });

    const wires: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      wires.push(String(init.body));
      return dsAnswer();
    }));
    const transcript = await loadCoachMessages();
    const res = await compressCoachContext({ messages: transcript, providerConfig: providerCfg });
    expect(res.usedOnlineModel).toBe(true);
    const joined = wires.join('\n');
    expect(joined.includes(secretA)).toBe(false);
    expect(joined.includes(secretB)).toBe(false);

    // 少于压缩阈值：直接返回 existingSummary，也必须来自可信清理投影
    await resetEverything();
    await seedActive({ sessionId: 'sess-r4-mem2' });
    const secretC = 'R4_SECRET_SUMMARY_ONLY_77ab';
    await saveCoachThreadsState({
      activeThreadId: 'default',
      threads: [{ id: 'default', title: '默认对话', createdAt: 1, updatedAt: 2, contextSummary: '旧摘要包含 ' + secretC }],
    } as any);
    await purgeDeletedMemoryFromCoachHistory({ threadId: 'default', memoryContent: secretC });
    const early = await compressCoachContext({
      messages: [
        { id: 'm1', role: 'user', createdAt: 1, text: 'x' },
        { id: 'm2', role: 'assistant', createdAt: 2, text: 'y' },
      ],
      existingSummary: '旧摘要包含 ' + secretC,
      providerConfig: providerCfg,
      keepRecent: 2,
    });
    expect(early.usedOnlineModel).toBe(false);
    expect(early.summary.includes(secretC)).toBe(false);

    // 非默认会话手动压缩：threadId 必须命中该会话，出站不得含已删原文
    await resetEverything();
    await seedActive({ sessionId: 'sess-r4-mem3' });
    const secretD = 'R4_SECRET_THREAD2_4d2f';
    let store2 = createEmptyCoachMemory();
    const rd = upsertCoachMemoryItem(store2, { category: 'preference', title: '丙偏好', content: secretD, source: 'coach' });
    await saveCoachMemory(rd.store);
    await saveCoachMessages([
      { id: 't2u1', threadId: 'thread-2', role: 'user', createdAt: 1, text: '我的偏好 ' + secretD },
      { id: 't2a1', threadId: 'thread-2', role: 'assistant', createdAt: 2, text: '记下了' },
      { id: 't2u2', threadId: 'thread-2', role: 'user', createdAt: 3, text: '继续' },
      { id: 't2a2', threadId: 'thread-2', role: 'assistant', createdAt: 4, text: '好' },
    ] as any);
    await purgeDeletedMemoryFromCoachHistory({ threadId: 'thread-2', memoryId: rd.item.id, memoryTitle: rd.item.title, memoryContent: secretD });
    const wires2: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      wires2.push(String(init.body));
      return dsAnswer();
    }));
    const msgs2 = (await loadCoachMessages()).filter((m) => m.threadId === 'thread-2');
    const res2 = await compressCoachContext({ threadId: 'thread-2', messages: msgs2, providerConfig: providerCfg });
    expect(res2.usedOnlineModel).toBe(true);
    expect(wires2.join('\n').includes(secretD)).toBe(false);
  });

  it('R4-3：DeepSeek 官方 Messages 按 off/low/high/max 正确序列化 thinking 与 output_config.effort，不用 budget_tokens；Claude 自身仍用 budget_tokens', () => {
    const dsMsgCfg = { ...providerCfg, kind: 'anthropic' as const, baseUrl: 'https://api.deepseek.com/anthropic' };
    const msgs = [{ role: 'user' as const, parts: [{ type: 'text' as const, text: '合成文本' }] }];
    const wire = (depth: 'off' | 'low' | 'high' | 'max') => {
      const r = buildAnthropicRequest(dsMsgCfg, msgs, [], { thinkingDepth: depth });
      return JSON.parse(String(r.init.body)) as Record<string, any>;
    };
    const off = wire('off');
    expect(off.thinking?.type).toBe('disabled');
    expect(off.output_config?.effort).toBeUndefined();
    expect(off.thinking?.budget_tokens).toBeUndefined();
    for (const depth of ['low', 'high', 'max'] as const) {
      const b = wire(depth);
      expect(b.thinking?.type, depth).toBe('enabled');
      expect(b.output_config?.effort, depth).toBe(depth);
      expect(b.thinking?.budget_tokens, depth).toBeUndefined();
    }
    // 真实 Claude 的思考预算参数保持 budget_tokens
    const claudeCfg = { ...providerCfg, kind: 'anthropic' as const, presetId: 'anthropic-official', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514' };
    const claudeBody = JSON.parse(String(buildAnthropicRequest(claudeCfg, msgs, [], { thinkingDepth: 'high' }).init.body)) as Record<string, any>;
    expect(claudeBody.thinking?.type).toBe('enabled');
    expect(typeof claudeBody.thinking?.budget_tokens).toBe('number');
    expect(claudeBody.output_config).toBeUndefined();
  });

  it('R4-4：基准按主库成功目标组计每成功组费用（改同组不充作第二组）、分臂独立分桶不匹配禁用节省率、流终态计完成时刻', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'motion-bench-r4-'));
    try {
      const runBench = (
        args: string[],
        spec: { roundA: number; roundB: number; delayMs: number; sseScript?: Array<{ delayMs: number; data: string }>; eofDelayMs?: number },
      ) => {
        const runner = `
          process.env.DEEPSEEK_API_KEY = 'synthetic-r4-ds';
          process.argv = [process.execPath, 'scripts/coach-cache-benchmark.mjs', ...${JSON.stringify(args)}];
          const spec = ${JSON.stringify(spec)};
          globalThis.fetch = async (_url, opts) => {
            const b = JSON.parse(opts.body);
            const follow = b.messages.at(-1).role === 'tool';
            const sess = JSON.stringify(b.messages).match(/sess-live-(?:baseline-)?deepseek-\\d+/)?.[0];
            if (!sess) throw Error('Missing synthetic session ID');
            const roundIndex = b.stream ? spec.roundB : spec.roundA;
            const fn = { name: 'record_active_set', arguments: JSON.stringify({ sessionId: sess, exerciseName: '双杠臂屈伸', roundIndex, reps: 10, weightKg: 60, status: 'done' }) };
            const tc = { id: 'call-' + (b.stream ? 'B' : 'A'), type: 'function', function: fn };
            const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 320, prompt_cache_miss_tokens: 680, completion_tokens: 12 };
            const parts = follow ? { content: '完成' } : { tool_calls: [b.stream ? { index: 0, ...tc } : tc] };
            const finish = follow ? 'stop' : 'tool_calls';
            if (!b.stream) {
              return Response.json({ choices: [{ message: { role: 'assistant', reasoning_content: 'r', ...parts }, finish_reason: finish }], usage });
            }
            const chunk = { choices: [{ delta: { reasoning_content: 'r', ...parts }, finish_reason: finish }], usage };
            const wire = 'data: ' + JSON.stringify(chunk) + '\\n\\ndata: [DONE]\\n\\n';
            const enc = new TextEncoder();
            const steps = Array.isArray(spec.sseScript)
              ? spec.sseScript.map((st) => ({ delayMs: st.delayMs || 0, data: st.data }))
              : [{ delayMs: spec.delayMs || 0, data: wire }];
            let si = 0;
            const body = new ReadableStream({ async pull(c) {
              if (si < steps.length) { const st = steps[si++]; if (st.delayMs > 0) await new Promise((r) => setTimeout(r, st.delayMs)); c.enqueue(enc.encode(st.data)); return; }
              if (spec.eofDelayMs > 0) await new Promise((r) => setTimeout(r, spec.eofDelayMs));
              c.close();
            } }, { highWaterMark: 0 });
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          };
          let lastReport = null;
          console.log = (s) => { lastReport = s; };
          await import('./scripts/coach-cache-benchmark.mjs');
          await new Promise((resolve) => {
            const started = Date.now();
            const iv = setInterval(() => {
              if (lastReport !== null || Date.now() - started > 60000) { clearInterval(iv); resolve(); }
            }, 10);
          });
          process.stdout.write('__RPT__' + JSON.stringify(JSON.parse(lastReport)));
        `;
        const res = spawnSync(process.execPath, ['--input-type=module', '-'], { input: runner, cwd: process.cwd(), encoding: 'utf8' });
        expect(res.status, res.stderr).toBe(0);
        const line = res.stdout.split('\n').filter((l) => l.startsWith('__RPT__')).pop();
        expect(line, res.stdout).toBeTruthy();
        return JSON.parse(line!.slice('__RPT__'.length)) as {
          targets: Array<{
            costPerLoggedSetComparable: boolean;
            costSavingsRatio: number | null;
            incomparableReasons: string[];
            baselineA_v022_cumulative: { loggedSetsInDb: number };
            cumulativeSummary: { loggedSetsInDb: number; dedupedLoggedSets: number; estimatedCostFromSchedule: number | null; estimatedCostPerLoggedSet: number | null };
            buckets: Array<{ windowMatched: boolean; armBPerRequestRecords: Array<{ startedAtMs: number | null; responseHeaderAtMs: number | null; firstTokenAtMs: number | null; completedAtMs: number | null; durationMs: number | null; terminalKind: string | null; aborted: boolean }> }>;
          }>;
        };
      };

      // (a) 流终态：完成时刻必须覆盖实际派发的响应体（延迟 500ms），不能用响应头时刻冒充
      const sse = runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', join(tmpDir, 'a.json')], { roundA: 1, roundB: 1, delayMs: 500 });
      const recs = sse.targets[0].buckets[0].armBPerRequestRecords;
      expect(recs.length).toBeGreaterThanOrEqual(1);
      for (const r of recs) {
        expect(typeof r.startedAtMs).toBe('number');
        expect(typeof r.responseHeaderAtMs).toBe('number');
        expect(typeof r.firstTokenAtMs).toBe('number');
        expect((r.completedAtMs as number) - (r.startedAtMs as number)).toBeGreaterThanOrEqual(350);
        expect((r.responseHeaderAtMs as number)).toBeGreaterThanOrEqual(r.startedAtMs as number);
        expect((r.firstTokenAtMs as number)).toBeGreaterThanOrEqual(r.responseHeaderAtMs as number);
        expect(r.terminalKind).toBe('protocol_terminal');
        expect(r.aborted).toBe(false);
      }

      // (e) role-only 帧先到、120ms 后才出现首个内容 token、终帧拆两块、EOF 再迟 200ms：
      //     首 token 时刻应≈120ms（不能等于头后 0–1ms），完成时刻应≈180ms 且早于迟来的 EOF。
      const roleOnly = 'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n';
      const firstTok = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '好' }, finish_reason: null }] }) + '\n\n';
      const termObj = 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } });
      const termPart1 = termObj.slice(0, 24);
      const termPart2 = termObj.slice(24) + '\n\ndata: [DONE]\n\n';
      const tok = runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', join(tmpDir, 'token.json')], {
        roundA: 1,
        roundB: 1,
        delayMs: 0,
        sseScript: [
          { delayMs: 0, data: roleOnly },
          { delayMs: 120, data: firstTok },
          { delayMs: 60, data: termPart1 },
          { delayMs: 0, data: termPart2 },
        ],
        eofDelayMs: 200,
      });
      const tokRec = tok.targets[0].buckets[0].armBPerRequestRecords[0];
      expect(tokRec.terminalKind).toBe('protocol_terminal');
      expect((tokRec.firstTokenAtMs as number) - (tokRec.startedAtMs as number)).toBeGreaterThanOrEqual(90);
      expect((tokRec.completedAtMs as number) - (tokRec.startedAtMs as number)).toBeGreaterThanOrEqual(150);
      expect((tokRec.completedAtMs as number) - (tokRec.firstTokenAtMs as number)).toBeGreaterThanOrEqual(20);

      // (b) B 第二轮重写第一组：A=2、B=1，不可按第二个 operationId 充当第二组，perSet 与总额一致且不可比
      const repCkpt = join(tmpDir, 'repeat.json');
      const firstRep = runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', repCkpt], { roundA: 1, roundB: 1, delayMs: 0 });
      expect(firstRep.targets[0].cumulativeSummary.loggedSetsInDb).toBe(1);
      const rep = runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--resume', '--checkpoint', repCkpt], { roundA: 2, roundB: 1, delayMs: 0 });
      const tr = rep.targets[0];
      expect(tr.baselineA_v022_cumulative.loggedSetsInDb).toBe(2);
      expect(tr.cumulativeSummary.loggedSetsInDb).toBe(1);
      expect(tr.cumulativeSummary.dedupedLoggedSets).toBeGreaterThan(tr.cumulativeSummary.loggedSetsInDb);
      expect(tr.costPerLoggedSetComparable).toBe(false);
      expect(tr.incomparableReasons).toContain('armB_target_completion_mismatch');
      if (tr.cumulativeSummary.estimatedCostFromSchedule !== null && tr.cumulativeSummary.estimatedCostPerLoggedSet !== null) {
        expect(Math.abs(tr.cumulativeSummary.estimatedCostFromSchedule - tr.cumulativeSummary.estimatedCostPerLoggedSet)).toBeLessThan(0.000002);
      }

      // (d) B 记了“未请求的第三组”：本轮固定目标为第 2 组，B 却记第 3 组 -> 第 2 组未完成，不计成功组
      const unrCkpt = join(tmpDir, 'unrequested.json');
      runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', unrCkpt], { roundA: 1, roundB: 1, delayMs: 0 });
      const unr = runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--resume', '--checkpoint', unrCkpt], { roundA: 2, roundB: 3, delayMs: 0 });
      const tu = unr.targets[0];
      // B 只在首轮成功记了第 1 组；第二轮记的是未请求的第 3 组，不能充作第 2 组
      expect(tu.cumulativeSummary.loggedSetsInDb).toBe(1);
      expect(tu.baselineA_v022_cumulative.loggedSetsInDb).toBe(2);

      // (c) 分臂独立分桶：A≈90s 归 inter_set_90s、B≈180s 归 inter_set_3m -> 匹配 false、不可比、无节省率
      const buckCkpt = join(tmpDir, 'bucket.json');
      runBench(['--live', '--provider', 'deepseek', '--bucket', 'first_turn', '--thinking', 'low', '--checkpoint', buckCkpt], { roundA: 1, roundB: 1, delayMs: 0 });
      const ckptJson = JSON.parse(readFileSync(buckCkpt, 'utf8')) as Record<string, unknown>;
      const now = Date.now();
      ckptJson.lastTurnAtMs = now - 90_000;
      ckptJson.lastArmATurnAtMs = now - 90_000;
      ckptJson.lastArmBTurnAtMs = now - 180_000;
      writeFileSync(buckCkpt, JSON.stringify(ckptJson, null, 2), 'utf8');
      const buck = runBench(['--live', '--provider', 'deepseek', '--bucket', 'inter_set_90s', '--thinking', 'low', '--resume', '--checkpoint', buckCkpt], { roundA: 2, roundB: 2, delayMs: 0 });
      const tb = buck.targets[0];
      expect(tb.buckets[0].windowMatched).toBe(false);
      expect(tb.costPerLoggedSetComparable).toBe(false);
      expect(tb.incomparableReasons).toContain('bucket_window_mismatch');
      expect(tb.costSavingsRatio).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
