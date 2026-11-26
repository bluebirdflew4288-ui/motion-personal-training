/* MOTION 第一批修复阶段 #2 专项回归：
   1. 普通发送前发现未闭合历史工具批（早于独立联网搜索、模型请求与新用户消息接收），保留草稿/附件；
   2. 正常与恢复工具续调在第一项副作用前原子持久化完整意图与原 assistant 条目；
   3. 「放弃」不执行业务工具、按优先级对账（已持久化 > 主库权威账本/回执重建 > 确定未执行证据写取消 > 无法确认整批隔离）；
   4. 放弃中途失败冷启重试累计仅记一组、冷启 R3-3 原路由恢复后继续能发、既往残批无 pending、多 pending 防死锁/防选错批；
   5. Claude 多 tool_result 紧邻 + 原生 blocks、OpenAI / Gemini 兼容、两条工具循环共用纯出站配对验证；
   6. 迟到异步状态与跨线程传参双层防护（CoachPane UI 线程绑定 + 引擎显式 pending 校验）。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COACH_OP_META_PREFIX,
  __resetDbHandle,
  idbClear,
  idbDelete,
  idbPut,
} from '../src/db/idb';
import { getSession, savePlan } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import {
  abandonPendingCoachTurn,
  inspectCoachThreadPendingState,
  resumePendingCoachTurn,
  runCoachTurn,
  validateOutboundToolPairing,
  validateProtocolEntriesPairing,
} from '../src/coach/coachAgent';
import { resolveThreadBoundRecoveryUi } from '../src/coach/CoachPane';
import { computeDeploymentId } from '../src/coach/providerCapabilities';
import {
  DEFAULT_COACH_THREAD_ID,
  appendProtocolEntriesStrict,
  getCoachRestoreEpoch,
  getPendingTurn,
  listCoachReceipts,
  listPendingTurns,
  listProtocolEntries,
  loadCoachThreadsState,
  resetCoachVaultForTest,
  saveCoachProviderConfig,
  saveCoachThreadsState,
  savePendingTurnStrict,
  type CoachPendingTurn,
  type CoachProtocolEntry,
  type CoachStoredProviderConfig,
} from '../src/coach/coachStorage';
import { coachRecordActiveSet } from '../src/coach/coachTx';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_768_000_000_000;

async function resetAll(): Promise<void> {
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');
}

function makePlan(id = 'plan-stage2-rec'): Plan {
  const base = createV32Plan(NOW);
  return {
    ...base,
    id,
    name: '阶段2恢复合成计划',
    days: [base.days[0]],
    cursor: 0,
  };
}

async function seedSession(sessionId: string): Promise<{ plan: Plan; session: Session }> {
  const plan = makePlan(`plan-${sessionId}`);
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = { ...raw, id: sessionId };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-stage2');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-stage2',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh };
}

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const dsCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'openai-compatible',
  presetId: 'deepseek-official',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  thinkingDepth: 'high',
  apiKey: 'sk-synthetic-ds',
  updatedAt: NOW,
};

const claudeCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'anthropic',
  presetId: 'anthropic-official',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514',
  thinkingDepth: 'high',
  apiKey: 'sk-synthetic-ant',
  updatedAt: NOW,
};

const gemCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'gemini',
  presetId: 'gemini-official',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash',
  thinkingDepth: 'high',
  apiKey: 'gm-synthetic-key',
  updatedAt: NOW,
};

async function createDualToolPartialCommit(params: {
  sessionId: string;
  threadId?: string;
  cfg?: CoachStoredProviderConfig;
}): Promise<{ session: Session; pending: CoachPendingTurn; threadId: string }> {
  const { session } = await seedSession(params.sessionId);
  const ex = session.exercises[0];
  const cfg = params.cfg ?? dsCfg;
  const threads = await loadCoachThreadsState();
  const threadId = params.threadId ?? threads.activeThreadId;
  if (!threads.threads.some((t) => t.id === threadId)) {
    await saveCoachThreadsState({
      ...threads,
      threads: [
        ...threads.threads,
        { id: threadId, title: `会话-${threadId}`, createdAt: NOW, updatedAt: NOW },
      ],
    });
  }

  vi.stubGlobal('fetch', async () => {
    if (cfg.kind === 'anthropic') {
      return sseResponse([
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 100 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'ANT_THINK_BATCH' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'signature_delta', signature: 'sig-ant-dual' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-dual-xyz' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 2, content_block: { type: 'tool_use', id: 'tu-dual-1', name: 'record_active_set', input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ sessionId: session.id, exId: ex.id, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }) } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 2 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 3, content_block: { type: 'tool_use', id: 'tu-dual-2', name: 'record_active_set', input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 3, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ sessionId: session.id, exId: ex.id, roundIndex: 2, reps: 8, weightKg: 65, status: 'done' }) } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 3 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } })}\n\n`,
        `event: message_stop\ndata: {}\n\n`,
      ]);
    }
    if (cfg.kind === 'gemini') {
      return sseResponse([
        `data: ${JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [
                  { text: 'Gemini 双工具推理', thought: true, thoughtSignature: 'gem-sig-thought' },
                  {
                    functionCall: {
                      name: 'record_active_set',
                      args: { sessionId: session.id, exId: ex.id, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' },
                    },
                    thoughtSignature: 'gem-sig-fc-1',
                  },
                  {
                    functionCall: {
                      name: 'record_active_set',
                      args: { sessionId: session.id, exId: ex.id, roundIndex: 2, reps: 8, weightKg: 65, status: 'done' },
                    },
                    thoughtSignature: 'gem-sig-fc-2',
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      ]);
    }
    return sseResponse([
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: '依次记入第1与第2组',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-dual-1',
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({ sessionId: session.id, exId: ex.id, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                  },
                },
                {
                  index: 1,
                  id: 'call-dual-2',
                  type: 'function',
                  function: {
                    name: 'record_active_set',
                    arguments: JSON.stringify({ sessionId: session.id, exId: ex.id, roundIndex: 2, reps: 8, weightKg: 65, status: 'done' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}\n\n`,
      'data: [DONE]\n\n',
    ]);
  });

  await expect(
    runCoachTurn({
      threadId,
      userText: '帮我记第1组60kg 10次和第2组65kg 8次',
      history: [],
      providerConfig: cfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
      onPendingTurnChange: (p) => {
        if (
          p?.plannedToolCalls &&
          p.plannedToolCalls[0]?.status === 'committed' &&
          p.plannedToolCalls[1]?.status === 'pending'
        ) {
          throw new Error('STOP_AFTER_FIRST_TOOL_COMMIT');
        }
      },
    }),
  ).rejects.toThrow('STOP_AFTER_FIRST_TOOL_COMMIT');

  const pending = (await listPendingTurns(threadId))[0]!;
  expect(pending).toBeTruthy();
  return { session: (await getSession(session.id))!, pending, threadId };
}

describe('MOTION 第一批修复 · 阶段 #2：未闭合批拦截、原子意图、对账放弃、纯出站校验与双层线程绑定', () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('1. 双工具首项提交后停止，直接发送不联网不请求模型且不接受新用户消息；明确放弃后下一次请求配对且不重写', async () => {
    const { session, threadId } = await createDualToolPartialCommit({ sessionId: 'sess-s2-1' });
    expect(session.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    const entriesBeforeSend = await listProtocolEntries(threadId);

    // 即使携带搜索意图词 + webSearch: true + 附件，直接发送必须早于独立联网搜索、模型请求与新用户消息落盘拦截
    const networkSpy = vi.fn(async () => {
      throw new Error('FORBIDDEN_NETWORK_CALL');
    });
    vi.stubGlobal('fetch', networkSpy);

    const blockedRes = await runCoachTurn({
      threadId,
      userText: '查一下深蹲标准动作要点',
      webSearch: true,
      attachments: [
        {
          id: 'att-keep-1',
          name: 'keep.jpg',
          mimeType: 'image/jpeg',
          width: 100,
          height: 100,
          sizeBytes: 32,
          dataBase64: 'QUFB',
        },
      ],
      history: [{ id: 'u-prev', threadId, role: 'user', createdAt: NOW, text: '上一条' }],
      providerConfig: { ...dsCfg, webSearchProvider: 'tavily', webSearchApiKey: 'tv-synthetic' },
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });

    expect(blockedRes.blockedByUnclosedBatch).toBe(true);
    expect(networkSpy).not.toHaveBeenCalled();
    expect(await listProtocolEntries(threadId)).toEqual(entriesBeforeSend);
    expect((await listPendingTurns(threadId)).length).toBe(1);

    // 明确放弃：不执行第 2 项业务工具（仍只记 1 组），补齐第 2 项确定取消结果，清理 pending
    const abandoned = await abandonPendingCoachTurn({ threadId });
    expect(abandoned.abandoned).toBe(true);
    expect(abandoned.quarantined).toBe(false);
    expect(abandoned.cancelledCount).toBe(1);
    expect(abandoned.receipts).toHaveLength(1);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(await listPendingTurns(threadId)).toHaveLength(0);

    const afterAbandonEntries = await listProtocolEntries(threadId);
    expect(validateProtocolEntriesPairing(afterAbandonEntries).ok).toBe(true);
    const toolEntries = afterAbandonEntries.filter((e) => e.kind === 'tool');
    expect(toolEntries).toHaveLength(2);
    expect(JSON.parse(toolEntries[1].toolResultText!).cancelled).toBe(true);

    // 放弃后下一条实际发送正常走网请求且工具消息严格配对、第 1 组不被重写
    const sentBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '收到，继续训练。' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const nextRes = await runCoachTurn({
      threadId,
      userText: '继续下一组建议',
      history: [{ id: 'u1', threadId, role: 'user', createdAt: NOW, text: '上一条' }],
      providerConfig: dsCfg,
      toolContext: { activeSession: (await getSession(session.id))! },
      streamChunkDelayMs: 0,
    });
    expect(nextRes.blockedByUnclosedBatch).toBeFalsy();
    expect(nextRes.text).toContain('继续训练');
    expect(sentBodies).toHaveLength(1);
    const roles = sentBodies[0].messages.map((m) => m.role);
    expect(roles.slice(-5)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    const afterNext = (await getSession(session.id))!;
    expect(afterNext.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(afterNext.exercises[0].sets[0].reps).toBe(10);
  });

  it('2. 主库提交但协议结果与回执未落盘（pending 仍标 pending）：优先按主库权威账本重建真实短结果而不伪造 aborted；无法确认时隔离未知', async () => {
    // 2a. 主库已提交 c0（coach-op 存在），但 tool(c0)、vault 回执均缺失且 pending[0].status 仍为 pending
    {
      const { session } = await seedSession('sess-s2-reconcile-main');
      const ex = session.exercises[0];
      const threads = await loadCoachThreadsState();
      const tid = threads.activeThreadId;
      const epoch = await getCoachRestoreEpoch();
      const segId = 'seg-reconcile-a';
      const op0 = 'turn-rec-a:r0:c0';
      const op1 = 'turn-rec-a:r0:c1';

      // 直接写入主库第 1 组并抹掉 vault 回执，模拟主库提交后崩溃在 vault 落盘前
      const commit0 = await coachRecordActiveSet({
        operationId: op0,
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 1,
        reps: 11,
        weightKg: 70,
        expectedRevision: session.revision,
        expectedEpoch: epoch,
        deferTimerDispatch: true,
        status: 'done',
      });
      await resetCoachVaultForTest();
      await saveCoachThreadsState({
        ...threads,
        activeThreadId: tid,
        threads: [
          {
            id: tid,
            title: '默认对话',
            createdAt: NOW,
            updatedAt: NOW,
            activeSegmentId: segId,
            segments: {
              [segId]: {
                segmentId: segId,
                startedAt: NOW,
                reason: 'initial',
                restoreEpoch: epoch,
                deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
                providerKind: 'openai-compatible',
                baseUrl: 'https://api.deepseek.com/v1',
                model: 'deepseek-flash',
                thinkingModeKey: 'high',
                baselineSnapshotJson: 'baseline',
                baselineSnapshotHash: 'bh',
                nextSeq: 5,
              },
            },
          },
        ],
      });
      await appendProtocolEntriesStrict([
        { id: `${tid}:${segId}:1`, threadId: tid, segmentId: segId, seq: 1, createdAt: NOW, kind: 'user', wireText: '记两组' },
        {
          id: `${tid}:${segId}:2`,
          threadId: tid,
          segmentId: segId,
          seq: 2,
          createdAt: NOW,
          kind: 'assistant',
          assistantText: '',
          reasoningText: 'r',
          toolCalls: [
            { id: 'c0', index: 0, name: 'record_active_set', argumentsText: '{}' },
            { id: 'c1', index: 1, name: 'record_active_set', argumentsText: '{}' },
          ],
        },
      ]);
      await savePendingTurnStrict({
        turnId: 'turn-rec-a',
        threadId: tid,
        segmentId: segId,
        status: 'awaiting_tools',
        round: 0,
        userMessageId: `${tid}:${segId}:1`,
        userPromptText: '记两组',
        createdAt: NOW,
        updatedAt: NOW,
        restoreEpoch: epoch,
        providerKind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
        model: 'deepseek-flash',
        assistantEntrySeq: 2,
        plannedToolCalls: [
          {
            toolCallId: 'c0',
            index: 0,
            operationId: op0,
            name: 'record_active_set',
            argumentsText: '{}',
            args: { sessionId: session.id, exId: ex.id, roundIndex: 1, reps: 11, weightKg: 70 },
            expectedRevision: session.revision,
            expectedEpoch: epoch,
            toolEntrySeq: 3,
            status: 'pending',
          },
          {
            toolCallId: 'c1',
            index: 1,
            operationId: op1,
            name: 'record_active_set',
            argumentsText: '{}',
            args: { sessionId: session.id, exId: ex.id, roundIndex: 2, reps: 9, weightKg: 70 },
            expectedRevision: commit0.session!.revision,
            expectedEpoch: epoch,
            toolEntrySeq: 4,
            status: 'pending',
          },
        ],
      });

      const res = await abandonPendingCoachTurn({ threadId: tid });
      expect(res.abandoned).toBe(true);
      expect(res.quarantined).toBe(false);
      expect(res.reconciledCount).toBe(1);
      expect(res.cancelledCount).toBe(1);
      expect(res.receipts).toHaveLength(1);
      expect(res.receipts[0].operationId).toBe(op0);

      const entries = await listProtocolEntries(tid, segId);
      const t0 = entries.find((e) => e.toolCallId === 'c0')!;
      const t1 = entries.find((e) => e.toolCallId === 'c1')!;
      const parsed0 = JSON.parse(t0.toolResultText!);
      expect(parsed0.ok).toBe(true);
      expect(parsed0.errorCode).toBeUndefined();
      expect(parsed0.receipt?.operationId).toBe(op0);
      expect(JSON.parse(t1.toolResultText!).cancelled).toBe(true);
      // 回执已镜像恢复至 vault
      expect((await listCoachReceipts()).some((r) => r.operationId === op0)).toBe(true);
    }

    // 2b. 未知状态（coach-op 丢失且实体版本已推进，无法确定是否跨库提交）-> 整批隔离，绝不伪造 aborted/failed
    {
      await resetAll();
      const { session } = await seedSession('sess-s2-quarantine-unknown');
      const ex = session.exercises[0];
      const threads = await loadCoachThreadsState();
      const tid = threads.activeThreadId;
      const epoch = await getCoachRestoreEpoch();
      const segId = 'seg-unk';
      const op0 = 'turn-unk:r0:c0';
      const op1 = 'turn-unk:r0:c1';

      // 先推进主库版本并删掉 coach-op，制造无法证明未执行的跨库不确定态
      await coachRecordActiveSet({
        operationId: op0,
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 1,
        reps: 10,
        weightKg: 60,
        expectedRevision: session.revision,
        expectedEpoch: epoch,
        deferTimerDispatch: true,
        status: 'done',
      });
      // 手动将主库 session 推进且抹除 op1 无迹可循
      const curSess = (await getSession(session.id))!;
      await idbPut('sessions', { ...curSess, revision: (curSess.revision ?? 1) + 1 });
      await idbDelete('meta', `${COACH_OP_META_PREFIX}${op0}`);

      await saveCoachThreadsState({
        ...threads,
        activeThreadId: tid,
        threads: [
          {
            id: tid,
            title: '默认对话',
            createdAt: NOW,
            updatedAt: NOW,
            activeSegmentId: segId,
            segments: {
              [segId]: {
                segmentId: segId,
                startedAt: NOW,
                reason: 'initial',
                restoreEpoch: epoch,
                deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
                providerKind: 'openai-compatible',
                baseUrl: 'https://api.deepseek.com/v1',
                model: 'deepseek-flash',
                thinkingModeKey: 'high',
                baselineSnapshotJson: 'baseline',
                baselineSnapshotHash: 'bh',
                nextSeq: 5,
              },
            },
          },
        ],
      });
      await appendProtocolEntriesStrict([
        { id: `${tid}:${segId}:1`, threadId: tid, segmentId: segId, seq: 1, createdAt: NOW, kind: 'user', wireText: '记两组' },
        {
          id: `${tid}:${segId}:2`,
          threadId: tid,
          segmentId: segId,
          seq: 2,
          createdAt: NOW,
          kind: 'assistant',
          assistantText: '',
          toolCalls: [
            { id: 'cu0', index: 0, name: 'record_active_set', argumentsText: '{}' },
            { id: 'cu1', index: 1, name: 'record_active_set', argumentsText: '{}' },
          ],
        },
        {
          id: `${tid}:${segId}:3`,
          threadId: tid,
          segmentId: segId,
          seq: 3,
          createdAt: NOW,
          kind: 'tool',
          toolCallId: 'cu0',
          toolName: 'record_active_set',
          toolResultText: JSON.stringify({ ok: true, summary: '已记第 1 组' }),
          toolError: false,
        },
      ]);
      await savePendingTurnStrict({
        turnId: 'turn-unk',
        threadId: tid,
        segmentId: segId,
        status: 'awaiting_tools',
        round: 0,
        userMessageId: `${tid}:${segId}:1`,
        userPromptText: '记两组',
        createdAt: NOW,
        updatedAt: NOW,
        restoreEpoch: epoch,
        providerKind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
        model: 'deepseek-flash',
        assistantEntrySeq: 2,
        plannedToolCalls: [
          {
            toolCallId: 'cu0',
            index: 0,
            operationId: op0,
            name: 'record_active_set',
            argumentsText: '{}',
            args: { sessionId: session.id, exId: ex.id, roundIndex: 1 },
            expectedRevision: session.revision,
            expectedEpoch: epoch,
            toolEntrySeq: 3,
            status: 'committed',
          },
          {
            toolCallId: 'cu1',
            index: 1,
            operationId: op1,
            name: 'record_active_set',
            argumentsText: '{}',
            args: { sessionId: session.id, exId: ex.id, roundIndex: 2 },
            expectedRevision: curSess.revision,
            expectedEpoch: epoch,
            toolEntrySeq: 4,
            status: 'pending',
          },
        ],
      });

      const res = await abandonPendingCoachTurn({ threadId: tid });
      expect(res.abandoned).toBe(true);
      expect(res.quarantined).toBe(true);
      expect(res.cancelledCount).toBe(0);

      const entries = await listProtocolEntries(tid, segId);
      // cu1 绝不能被伪造为 aborted/cancelled 写入
      expect(entries.some((e) => e.toolCallId === 'cu1')).toBe(false);
      // 原始审计数据完整保留并打上隔离标记
      expect(entries.find((e) => e.seq === 2)?.quarantinedFromReplay).toBe(true);
      expect(entries.find((e) => e.seq === 3)?.quarantinedFromReplay).toBe(true);
      expect(entries.find((e) => e.seq === 1)?.quarantinedFromReplay).toBeFalsy();
      expect(validateProtocolEntriesPairing(entries).ok).toBe(true);

      // 下一次正常发送不包含隔离批，能干净发出
      const sentBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
      vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return sseResponse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '已继续。' }, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      });
      const nextTurn = await runCoachTurn({
        threadId: tid,
        userText: '现在状态如何？',
        history: [{ id: 'u1', threadId: tid, role: 'user', createdAt: NOW, text: '记两组' }],
        providerConfig: dsCfg,
        toolContext: { activeSession: (await getSession(session.id))! },
        streamChunkDelayMs: 0,
      });
      expect(nextTurn.text).toContain('已继续');
      expect(JSON.stringify(sentBodies[0])).not.toContain('cu0');
      expect(JSON.stringify(sentBodies[0])).not.toContain('cu1');
    }
  });

  it('3. 放弃中途失败冷启可重试且累计只记一组；Phase 2 原子意图落盘失败零孤儿条目', async () => {
    // 3a. 放弃中途 IDB 事务中止 -> pending 与现场完整保留 -> 冷启重试成功且累计仍仅 1 组
    const { session, pending, threadId } = await createDualToolPartialCommit({ sessionId: 'sess-s2-abort-retry' });
    const origTx = IDBDatabase.prototype.transaction;
    let failAbandonOnce = false;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
      if (!failAbandonOnce && this.name === 'motion-coach-vault' && names.includes('pendingTurns') && names.includes('protocolEntries') && mode === 'readwrite') {
        failAbandonOnce = true;
        throw new DOMException('Simulated vault abort during abandon', 'AbortError');
      }
      return origTx.call(this, storeNames, mode, options);
    };
    try {
      await expect(abandonPendingCoachTurn({ threadId, pendingTurn: pending })).rejects.toThrow(/Simulated vault abort/i);
    } finally {
      IDBDatabase.prototype.transaction = origTx;
    }

    // 失败后 pending 仍存在、协议日志未半写入
    expect(await getPendingTurn(pending.turnId)).toBeTruthy();
    expect((await inspectCoachThreadPendingState(threadId)).hasUnclosedToolBatch).toBe(true);

    // 模拟冷启后重试放弃
    __resetDbHandle();
    const retryRes = await abandonPendingCoachTurn({ threadId, pendingTurn: pending });
    expect(retryRes.abandoned).toBe(true);
    expect(retryRes.cancelledCount).toBe(1);
    expect(await getPendingTurn(pending.turnId)).toBeUndefined();
    const afterSess = (await getSession(session.id))!;
    expect(afterSess.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);

    // 3b. Phase 2 原子意图（assistant + pendingTurn）写入中止时，不得留下孤儿 assistant(tool_calls)
    await resetAll();
    const { session: sAtom } = await seedSession('sess-s2-atomic-intent');
    const tidAtom = (await loadCoachThreadsState()).activeThreadId;
    vi.stubGlobal('fetch', async () =>
      sseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-atom-1',
                    function: {
                      name: 'record_active_set',
                      arguments: JSON.stringify({
                        sessionId: sAtom.id,
                        exId: sAtom.exercises[0].id,
                        roundIndex: 1,
                        reps: 10,
                        weightKg: 60,
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
    const origTx2 = IDBDatabase.prototype.transaction;
    let pCalls = 0;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
      if (this.name === 'motion-coach-vault' && names.includes('pendingTurns') && mode === 'readwrite') {
        pCalls += 1;
        if (pCalls >= 3) {
          throw new DOMException('Simulated atomic intent abort', 'AbortError');
        }
      }
      return origTx2.call(this, storeNames, mode, options);
    };
    try {
      await expect(
        runCoachTurn({
          threadId: tidAtom,
          userText: '帮我记第一组',
          history: [],
          providerConfig: dsCfg,
          toolContext: { activeSession: sAtom },
          streamChunkDelayMs: 0,
        }),
      ).rejects.toThrow(/Simulated atomic intent abort/i);
    } finally {
      IDBDatabase.prototype.transaction = origTx2;
    }
    const entriesAtom = await listProtocolEntries(tidAtom);
    // 仅有 user 条目，绝不遗留未配对的 assistant(tool_calls)
    expect(entriesAtom.map((e) => e.kind)).toEqual(['user']);
    expect(((await getSession(sAtom.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(0);
  });

  it('4. 冷启正常恢复原 route/operationId 及完成态继续能发', async () => {
    const { session, pending, threadId } = await createDualToolPartialCommit({ sessionId: 'sess-s2-cold-r33' });
    await saveCoachProviderConfig(dsCfg);
    const routeBCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      baseUrl: 'https://route-b.example.invalid/v1',
      model: 'custom-b-model',
      thinkingDepth: 'off',
      apiKey: 'sk-route-b',
      updatedAt: NOW + 1000,
    };
    await saveCoachProviderConfig(routeBCfg);

    // 冷启
    __resetDbHandle();
    const sentUrls: string[] = [];
    const sentModels: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      sentUrls.push(String(url));
      sentModels.push(JSON.parse(String(init?.body ?? '{}')).model);
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '两组均已按原路由完成确认。' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const resumed = await resumePendingCoachTurn({
      threadId,
      pendingTurn: pending,
      providerConfig: routeBCfg,
      thinkingDepth: 'off',
      toolContext: { activeSession: (await getSession(session.id))!, activeThreadId: threadId },
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.receipts).toHaveLength(2);
    expect(resumed.receipts[0].operationId).toBe(pending.plannedToolCalls![0].operationId);
    expect(resumed.receipts[1].operationId).toBe(pending.plannedToolCalls![1].operationId);
    expect(sentUrls[0]).toContain('api.deepseek.com/v1');
    expect(sentModels[0]).toBe('deepseek-flash');
    expect(await listPendingTurns(threadId)).toHaveLength(0);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(2);

    // 完成态后继续发送正常走新配置 route-B
    const nextRes = await runCoachTurn({
      threadId,
      userText: '下一组怎么安排？',
      history: [{ id: 'u-done', threadId, role: 'user', createdAt: NOW, text: '记两组' }],
      providerConfig: routeBCfg,
      toolContext: { activeSession: (await getSession(session.id))! },
      streamChunkDelayMs: 0,
    });
    expect(nextRes.blockedByUnclosedBatch).toBeFalsy();
    expect(sentUrls[1]).toContain('route-b.example.invalid/v1');
    expect(sentModels[1]).toBe('custom-b-model');
  });

  it('5. 既往有残批没 pending、多条旧 pending 防死锁/防选错批、待确认计划不阻断发送', async () => {
    const { session } = await seedSession('sess-s2-orphan-multi');
    const threads = await loadCoachThreadsState();
    const tid = threads.activeThreadId;
    const epoch = await getCoachRestoreEpoch();
    const segId = 'seg-orphan-multi';

    await saveCoachThreadsState({
      ...threads,
      activeThreadId: tid,
      threads: [
        {
          id: tid,
          title: '默认对话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: segId,
          segments: {
            [segId]: {
              segmentId: segId,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: epoch,
              deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
              providerKind: 'openai-compatible',
              baseUrl: 'https://api.deepseek.com/v1',
              model: 'deepseek-flash',
              thinkingModeKey: 'high',
              baselineSnapshotJson: 'baseline',
              baselineSnapshotHash: 'bh',
              nextSeq: 7,
            },
          },
        },
      ],
    });

    // 正常历史 [1:user, 2:asst] + 孤儿残批 [3:user, 4:asst(orphan-1, orphan-2), 5:tool(orphan-1)]（无对应 pending）
    await appendProtocolEntriesStrict([
      { id: `${tid}:${segId}:1`, threadId: tid, segmentId: segId, seq: 1, createdAt: NOW, kind: 'user', wireText: '正常问候' },
      { id: `${tid}:${segId}:2`, threadId: tid, segmentId: segId, seq: 2, createdAt: NOW, kind: 'assistant', assistantText: '你好，准备开始。', reasoningText: 'r0' },
      { id: `${tid}:${segId}:3`, threadId: tid, segmentId: segId, seq: 3, createdAt: NOW, kind: 'user', wireText: '帮我做两件事' },
      {
        id: `${tid}:${segId}:4`,
        threadId: tid,
        segmentId: segId,
        seq: 4,
        createdAt: NOW,
        kind: 'assistant',
        assistantText: '',
        reasoningText: 'r1',
        toolCalls: [
          { id: 'orphan-1', index: 0, name: 'record_active_set', argumentsText: '{}' },
          { id: 'orphan-2', index: 1, name: 'record_active_set', argumentsText: '{}' },
        ],
      },
      {
        id: `${tid}:${segId}:5`,
        threadId: tid,
        segmentId: segId,
        seq: 5,
        createdAt: NOW,
        kind: 'tool',
        toolCallId: 'orphan-1',
        toolName: 'record_active_set',
        toolResultText: JSON.stringify({ ok: true, summary: '历史第1项结果' }),
      },
    ]);

    // 写入多条干扰旧 pending：1 条已过期 epoch、1 条已完结旧 pending、1 条无关 awaiting_confirmation 草稿
    await savePendingTurnStrict({
      turnId: 'old-expired-epoch',
      threadId: tid,
      segmentId: segId,
      status: 'awaiting_tools',
      round: 0,
      userMessageId: `${tid}:${segId}:1`,
      userPromptText: '旧纪元',
      createdAt: NOW - 10000,
      updatedAt: NOW - 10000,
      restoreEpoch: epoch + 99,
      providerKind: 'openai-compatible',
      deploymentId: 'd',
      model: 'm',
    });
    await savePendingTurnStrict({
      turnId: 'old-superseded-turn',
      threadId: tid,
      segmentId: segId,
      status: 'awaiting_tools',
      round: 0,
      userMessageId: `${tid}:${segId}:1`,
      userPromptText: '已跨越的旧待办',
      createdAt: NOW - 5000,
      updatedAt: NOW - 5000,
      restoreEpoch: epoch,
      providerKind: 'openai-compatible',
      deploymentId: 'd',
      model: 'm',
      assistantEntrySeq: 999,
      plannedToolCalls: [
        { toolCallId: 'unrelated-call', index: 0, operationId: 'op-unrelated', name: 'record_active_set', argumentsText: '{}', args: {}, status: 'pending' },
      ],
    });
    await savePendingTurnStrict({
      turnId: 'draft-confirm-unrelated',
      threadId: tid,
      segmentId: segId,
      status: 'awaiting_confirmation',
      round: 0,
      userMessageId: `${tid}:${segId}:1`,
      userPromptText: '新建计划草稿',
      createdAt: NOW - 2000,
      updatedAt: NOW - 2000,
      restoreEpoch: epoch,
      providerKind: 'openai-compatible',
      deploymentId: 'd',
      model: 'm',
      pendingDraftPlan: {
        id: 'draft-1',
        planName: '推拉腿',
        days: [{ dayName: '推日', exercises: [{ kind: 'straight', name: '卧推', sets: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 }] }],
      },
    });

    const state = await inspectCoachThreadPendingState(tid);
    expect(state.hasUnclosedToolBatch).toBe(true);
    expect(state.orphanBatch).toBe(true);
    // 绝不误选无关的旧 pending
    expect(state.pendingTurn).toBeNull();

    const netSpy = vi.fn();
    vi.stubGlobal('fetch', netSpy);
    const blocked = await runCoachTurn({
      threadId: tid,
      userText: '查一下胸肌训练',
      webSearch: true,
      history: [{ id: 'h1', threadId: tid, role: 'user', createdAt: NOW, text: '正常问候' }],
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    expect(blocked.blockedByUnclosedBatch).toBe(true);
    expect(netSpy).not.toHaveBeenCalled();

    // 放弃孤儿批 -> 仅隔离 seq 4/5，保留 seq 1/2/3 正常历史，且不误删 awaiting_confirmation 草稿
    const abn = await abandonPendingCoachTurn({ threadId: tid });
    expect(abn.abandoned).toBe(true);
    expect(abn.quarantined).toBe(true);
    const postEntries = await listProtocolEntries(tid, segId);
    expect(postEntries.find((e) => e.seq === 1)?.quarantinedFromReplay).toBeFalsy();
    expect(postEntries.find((e) => e.seq === 2)?.quarantinedFromReplay).toBeFalsy();
    expect(postEntries.find((e) => e.seq === 4)?.quarantinedFromReplay).toBe(true);
    expect(postEntries.find((e) => e.seq === 5)?.quarantinedFromReplay).toBe(true);
    expect(await getPendingTurn('draft-confirm-unrelated')).toBeTruthy();

    // 仅剩 awaiting_confirmation（及已跨越旧 pending）时，普通发送必须继续可用
    const sent: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '草稿之外的正常对话畅通。' }, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });
    const okRes = await runCoachTurn({
      threadId: tid,
      userText: '正常发一条',
      history: [{ id: 'h1', threadId: tid, role: 'user', createdAt: NOW, text: '正常问候' }],
      providerConfig: dsCfg,
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    expect(okRes.blockedByUnclosedBatch).toBeFalsy();
    expect(okRes.text).toContain('正常对话畅通');
    expect(JSON.stringify(sent[0])).toContain('准备开始');
    expect(JSON.stringify(sent[0])).not.toContain('orphan-1');
  });

  it('6. 覆盖 Claude 多 tool_result 紧邻（保留 thinking/signature/redacted_thinking）与 Gemini/OpenAI 兼容，及两循环共用纯出站阻断', async () => {
    // 6a. Claude 双工具首项提交后放弃 -> 下一次请求保留原生 blocks 且紧邻单个 user([tool_result_1, tool_result_2])
    {
      const { session, threadId } = await createDualToolPartialCommit({
        sessionId: 'sess-s2-claude-dual',
        cfg: claudeCfg,
      });
      const abn = await abandonPendingCoachTurn({ threadId });
      expect(abn.abandoned).toBe(true);
      expect(abn.quarantined).toBe(false);
      expect(abn.cancelledCount).toBe(1);

      const antBodies: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = [];
      vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
        antBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return sseResponse([
          `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 50 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'Claude 配对正常。' } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`,
          `event: message_stop\ndata: {}\n\n`,
        ]);
      });

      const res = await runCoachTurn({
        threadId,
        userText: '继续下一组',
        history: [{ id: 'cu1', threadId, role: 'user', createdAt: NOW, text: '记两组' }],
        providerConfig: claudeCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(res.text).toContain('Claude 配对正常');
      const msgs = antBodies[0].messages;
      const asstIdx = msgs.findIndex(
        (m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'),
      );
      expect(asstIdx).toBeGreaterThanOrEqual(0);
      // 原生 thinking + signature + redacted_thinking 完整保留
      expect(msgs[asstIdx].content[0]).toEqual({
        type: 'thinking',
        thinking: 'ANT_THINK_BATCH',
        signature: 'sig-ant-dual',
      });
      expect(msgs[asstIdx].content[1]).toEqual({
        type: 'redacted_thinking',
        data: 'redacted-dual-xyz',
      });
      // 紧邻的下一条 user 消息内包含两条配对的 tool_result
      const nextMsg = msgs[asstIdx + 1];
      expect(nextMsg.role).toBe('user');
      const toolResults = nextMsg.content.filter((b) => b.type === 'tool_result');
      expect(toolResults.map((b) => b.tool_use_id)).toEqual(['tu-dual-1', 'tu-dual-2']);
      expect(toolResults[0].is_error).toBeUndefined();
      expect(toolResults[1].is_error).toBe(true);
    }

    // 6b. Gemini 双工具（无 server functionCall.id + thoughtSignature）放弃后下一次请求保持 parts/thoughtSignature 与紧邻 functionResponse
    {
      await resetAll();
      const { session, threadId } = await createDualToolPartialCommit({
        sessionId: 'sess-s2-gemini-dual',
        cfg: gemCfg,
      });
      const abn = await abandonPendingCoachTurn({ threadId });
      expect(abn.abandoned).toBe(true);
      expect(abn.quarantined).toBe(false);

      const gemBodies: Array<{ contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }> = [];
      vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
        gemBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return sseResponse([
          `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Gemini 配对正常。' }] } }] })}\n\n`,
        ]);
      });

      const res = await runCoachTurn({
        threadId,
        userText: '继续训练',
        history: [{ id: 'gu1', threadId, role: 'user', createdAt: NOW, text: '记两组' }],
        providerConfig: gemCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(res.text).toContain('Gemini 配对正常');
      const contents = gemBodies[0].contents;
      const modelIdx = contents.findIndex(
        (c) => c.role === 'model' && c.parts.some((p) => 'functionCall' in p),
      );
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(contents[modelIdx].parts[0].thoughtSignature).toBe('gem-sig-thought');
      expect(contents[modelIdx].parts[1].thoughtSignature).toBe('gem-sig-fc-1');
      expect(contents[modelIdx].parts[2].thoughtSignature).toBe('gem-sig-fc-2');
      const respTurn = contents[modelIdx + 1];
      expect(respTurn.role).toBe('user');
      expect(respTurn.parts.filter((p) => 'functionResponse' in p)).toHaveLength(2);
    }

    // 6c. 纯出站校验同时保护两条工具循环（含恢复续调循环）：未紧邻/游离结果直接阻断发网
    {
      const nonAdjacentCheck = validateOutboundToolPairing([
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'a1', name: 'record_active_set', argumentsText: '{}', arguments: {} },
            { id: 'a2', name: 'record_active_set', argumentsText: '{}', arguments: {} },
          ],
        },
        { role: 'tool', toolCallId: 'a1', name: 'record_active_set', content: '{}' },
        { role: 'user', parts: [{ type: 'text', text: '打断' }] },
        { role: 'tool', toolCallId: 'a2', name: 'record_active_set', content: '{}' },
      ]);
      expect(nonAdjacentCheck.ok).toBe(false);

      // 在恢复续调循环中构造非紧邻破坏的段：调用 resumePendingCoachTurn 必须 0 发网阻断
      await resetAll();
      const { session } = await seedSession('sess-s2-followup-guard');
      const threads = await loadCoachThreadsState();
      const tid = threads.activeThreadId;
      const epoch = await getCoachRestoreEpoch();
      const segId = 'seg-broken-followup';
      await saveCoachThreadsState({
        ...threads,
        activeThreadId: tid,
        threads: [
          {
            id: tid,
            title: '默认对话',
            createdAt: NOW,
            updatedAt: NOW,
            activeSegmentId: segId,
            segments: {
              [segId]: {
                segmentId: segId,
                startedAt: NOW,
                reason: 'initial',
                restoreEpoch: epoch,
                deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
                providerKind: 'openai-compatible',
                baseUrl: 'https://api.deepseek.com/v1',
                model: 'deepseek-flash',
                thinkingModeKey: 'high',
                baselineSnapshotJson: 'baseline',
                baselineSnapshotHash: 'bh',
                nextSeq: 5,
              },
            },
          },
        ],
      });
      await appendProtocolEntriesStrict([
        { id: `${tid}:${segId}:1`, threadId: tid, segmentId: segId, seq: 1, createdAt: NOW, kind: 'user', wireText: 'u' },
        {
          id: `${tid}:${segId}:2`,
          threadId: tid,
          segmentId: segId,
          seq: 2,
          createdAt: NOW,
          kind: 'assistant',
          assistantText: '',
          toolCalls: [
            { id: 'f1', index: 0, name: 'record_active_set', argumentsText: '{}' },
            { id: 'f2', index: 1, name: 'record_active_set', argumentsText: '{}' },
          ],
        },
        { id: `${tid}:${segId}:3`, threadId: tid, segmentId: segId, seq: 3, createdAt: NOW, kind: 'tool', toolCallId: 'f1', toolName: 'record_active_set', toolResultText: '{}' },
        { id: `${tid}:${segId}:4`, threadId: tid, segmentId: segId, seq: 4, createdAt: NOW, kind: 'user', wireText: 'stray gap' },
        { id: `${tid}:${segId}:5`, threadId: tid, segmentId: segId, seq: 5, createdAt: NOW, kind: 'tool', toolCallId: 'f2', toolName: 'record_active_set', toolResultText: '{}' },
      ]);
      const brokenFollowupPending: CoachPendingTurn = {
        turnId: 'turn-broken-followup',
        threadId: tid,
        segmentId: segId,
        status: 'awaiting_followup_model',
        round: 1,
        userMessageId: `${tid}:${segId}:1`,
        userPromptText: 'u',
        createdAt: NOW,
        updatedAt: NOW,
        restoreEpoch: epoch,
        providerKind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
        model: 'deepseek-flash',
      };
      await savePendingTurnStrict(brokenFollowupPending);
      const netSpy = vi.fn();
      vi.stubGlobal('fetch', netSpy);
      const resGuard = await resumePendingCoachTurn({
        threadId: tid,
        pendingTurn: brokenFollowupPending,
        providerConfig: dsCfg,
        toolContext: { activeSession: session, activeThreadId: tid },
      });
      expect(resGuard.resumed).toBe(false);
      expect(netSpy).not.toHaveBeenCalled();
    }
  });

  it('7. Codex 补充回归：跨线程/过期 pending 传参在引擎与 CoachPane UI 双层零副作用拦截', async () => {
    // 线程 A 产生部分提交待恢复；线程 B 干净
    const { session, pending: pendingA, threadId: threadA } = await createDualToolPartialCommit({
      sessionId: 'sess-s2-cross-thread',
      threadId: DEFAULT_COACH_THREAD_ID,
    });
    const threads = await loadCoachThreadsState();
    const threadB = 'thread-b-clean';
    await saveCoachThreadsState({
      ...threads,
      threads: [
        ...threads.threads,
        { id: threadB, title: '会话 B', createdAt: NOW + 1, updatedAt: NOW + 1 },
      ],
    });

    // 7a. UI 绑定辅助：当 activeThreadId 已切换为 threadB 时，遗留的 threadA pending/state 绝不在 B 渲染或允许执行
    const boundOnB = resolveThreadBoundRecoveryUi({
      activeThreadId: threadB,
      pendingRecoveryTurn: pendingA,
      pendingRecoveryState: {
        threadId: threadA,
        currentEpoch: pendingA.restoreEpoch,
        hasUnclosedToolBatch: true,
        orphanBatch: false,
        pendingTurn: pendingA,
        expiredPendingTurns: [],
      },
    });
    expect(boundOnB.visibleRecoveryTurn).toBeNull();
    expect(boundOnB.visibleRecoveryState).toBeNull();
    expect(boundOnB.canResume).toBe(false);
    expect(boundOnB.canAbandon).toBe(false);

    // 7b. 引擎跨线程传参：带 threadId=B 与旧 pending=A 调用 abandonPendingCoachTurn -> 无副作用拒绝，不删 A
    const crossAbn = await abandonPendingCoachTurn({
      threadId: threadB,
      pendingTurn: pendingA,
    });
    expect(crossAbn.abandoned).toBe(false);
    expect(crossAbn.threadMismatch).toBe(true);
    expect(await getPendingTurn(pendingA.turnId)).toBeTruthy();

    // 7c. 引擎跨线程传参：带 threadId=B 与旧 pending=A 调用 resumePendingCoachTurn -> 不执行 A 的工具，0 写入
    const netSpy = vi.fn();
    vi.stubGlobal('fetch', netSpy);
    const crossRes = await resumePendingCoachTurn({
      threadId: threadB,
      pendingTurn: pendingA,
      providerConfig: dsCfg,
      toolContext: { activeSession: session, activeThreadId: threadB },
    });
    expect(crossRes.resumed).toBe(false);
    expect(crossRes.threadMismatch).toBe(true);
    expect(netSpy).not.toHaveBeenCalled();
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(await getPendingTurn(pendingA.turnId)).toBeTruthy();

    // 7d. 引擎过期/不存在参数：先用错误 epoch 伪造参数，再删除 A 后用旧引用重试 -> 均拒绝从过期参数重建或改库
    const staleEpochParam: CoachPendingTurn = { ...pendingA, restoreEpoch: pendingA.restoreEpoch + 5 };
    const staleEpochAbn = await abandonPendingCoachTurn({ threadId: threadA, pendingTurn: staleEpochParam });
    expect(staleEpochAbn.abandoned).toBe(false);
    expect(staleEpochAbn.staleOrMissingPending).toBe(true);
    expect(await getPendingTurn(pendingA.turnId)).toBeTruthy();

    // 真正放弃 A 后，再用过期的 pendingA 引用调用 abandon / resume -> 必须返回无副作用可重试状态且不再写入/重建
    const realAbn = await abandonPendingCoachTurn({ threadId: threadA, pendingTurn: pendingA });
    expect(realAbn.abandoned).toBe(true);
    const entriesAfterRealAbn = await listProtocolEntries(threadA);

    const replayStaleAbn = await abandonPendingCoachTurn({ threadId: threadA, pendingTurn: pendingA });
    expect(replayStaleAbn.abandoned).toBe(false);
    expect(replayStaleAbn.staleOrMissingPending).toBe(true);
    expect(await listProtocolEntries(threadA)).toEqual(entriesAfterRealAbn);

    const replayStaleResume = await resumePendingCoachTurn({
      threadId: threadA,
      pendingTurn: pendingA,
      providerConfig: dsCfg,
      toolContext: { activeSession: (await getSession(session.id))!, activeThreadId: threadA },
    });
    expect(replayStaleResume.resumed).toBe(false);
    expect(replayStaleResume.staleOrMissingPending).toBe(true);
    expect(((await getSession(session.id))!).exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(1);

    // 7e. CoachPane 源码防回退契约：所有异步恢复/放弃/发送回调回填前均校验 activeThreadIdRef.current === targetThreadId
    const paneSrc = readFileSync(resolve(process.cwd(), 'src/coach/CoachPane.tsx'), 'utf8');
    expect(paneSrc).toContain('resolveThreadBoundRecoveryUi');
    expect(paneSrc).toContain('activeThreadIdRef.current !== targetTid');
    expect(paneSrc).toContain('activeThreadIdRef.current === targetThreadId');
    expect(paneSrc).toContain('activeThreadIdRef.current === threadIdAtSend');
  });

  it('8. 同段复用 Gemini 局部 ID（gem_local_1）时，放弃与恢复严格按槽位归属且不误伤早先完整批', async () => {
    const { session } = await seedSession('sess-s2-gemini-local-collision');
    const ex = session.exercises[0];
    const threads = await loadCoachThreadsState();
    const tid = threads.activeThreadId;
    const epoch = await getCoachRestoreEpoch();
    const segId = 'seg-gem-local-collision';

    await saveCoachProviderConfig(gemCfg);
    const gemDeploymentId = computeDeploymentId(gemCfg);

    await saveCoachThreadsState({
      ...threads,
      activeThreadId: tid,
      threads: [
        {
          id: tid,
          title: '默认对话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: segId,
          segments: {
            [segId]: {
              segmentId: segId,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: epoch,
              deploymentId: gemDeploymentId,
              providerKind: 'gemini',
              baseUrl: gemCfg.baseUrl,
              model: gemCfg.model,
              thinkingModeKey: 'off',
              baselineSnapshotJson: 'baseline',
              baselineSnapshotHash: 'bh',
              nextSeq: 6,
            },
          },
        },
      ],
    });

    const oldArgs = { sessionId: session.id, exId: ex.id, roundIndex: 0, weightKg: 80, reps: 8, status: 'done' };
    const curArgs = { sessionId: session.id, exId: ex.id, roundIndex: 1, weightKg: 82.5, reps: 8, status: 'done' };

    // 同段：
    // seq 1: user(轮1)
    // seq 2: assistant(gem_local_1) + seq 3: tool(gem_local_1) —— 早先健康完整批（含原生 geminiParts + thoughtSignature）
    // seq 4: user(轮2)
    // seq 5: assistant(gem_local_1) —— 当前问题批，缺 tool 结果，pending.assistantEntrySeq = 5, toolEntrySeq = 6
    const oldAsstEntry: CoachProtocolEntry = {
      id: `${tid}:${segId}:2`,
      threadId: tid,
      segmentId: segId,
      seq: 2,
      createdAt: NOW,
      kind: 'assistant',
      assistantText: '',
      toolCalls: [
        {
          id: 'gem_local_1',
          index: 0,
          name: 'record_active_set',
          argumentsText: JSON.stringify(oldArgs),
          thoughtSignature: 'sig-old-turn',
        },
      ],
      geminiParts: [
        {
          functionCall: {
            name: 'record_active_set',
            args: oldArgs,
          },
          thoughtSignature: 'sig-old-turn',
        },
      ],
    };
    const oldToolEntry: CoachProtocolEntry = {
      id: `${tid}:${segId}:3`,
      threadId: tid,
      segmentId: segId,
      seq: 3,
      createdAt: NOW + 1,
      kind: 'tool',
      toolCallId: 'gem_local_1',
      toolName: 'record_active_set',
      toolResultText: JSON.stringify({
        ok: true,
        summary: '早先第 1 轮已记录 80kg x 8',
        receipt: { operationId: 'turn-gem-old:r0:c0' },
      }),
    };
    const curAsstEntry: CoachProtocolEntry = {
      id: `${tid}:${segId}:5`,
      threadId: tid,
      segmentId: segId,
      seq: 5,
      createdAt: NOW + 2,
      kind: 'assistant',
      assistantText: '',
      toolCalls: [
        {
          id: 'gem_local_1',
          index: 0,
          name: 'record_active_set',
          argumentsText: JSON.stringify(curArgs),
          thoughtSignature: 'sig-cur-turn',
        },
      ],
      geminiParts: [
        {
          functionCall: {
            name: 'record_active_set',
            args: curArgs,
          },
          thoughtSignature: 'sig-cur-turn',
        },
      ],
    };

    await appendProtocolEntriesStrict([
      { id: `${tid}:${segId}:1`, threadId: tid, segmentId: segId, seq: 1, createdAt: NOW, kind: 'user', wireText: '第一组 80kg 8次' },
      oldAsstEntry,
      oldToolEntry,
      { id: `${tid}:${segId}:4`, threadId: tid, segmentId: segId, seq: 4, createdAt: NOW + 2, kind: 'user', wireText: '第二组 82.5kg 8次' },
      curAsstEntry,
    ]);

    const curPending: CoachPendingTurn = {
      turnId: 'turn-gem-cur',
      threadId: tid,
      segmentId: segId,
      userMessageId: `${tid}:${segId}:4`,
      userPromptText: '第二组 82.5kg 8次',
      status: 'awaiting_tools',
      round: 0,
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      restoreEpoch: epoch,
      providerKind: 'gemini',
      baseUrl: gemCfg.baseUrl,
      deploymentId: gemDeploymentId,
      model: gemCfg.model,
      assistantEntrySeq: 5,
      plannedToolCalls: [
        {
          index: 0,
          toolCallId: 'gem_local_1',
          operationId: 'turn-gem-cur:r0:c0',
          name: 'record_active_set',
          argumentsText: JSON.stringify(curArgs),
          args: curArgs,
          expectedRevision: session.revision,
          expectedEpoch: epoch,
          status: 'pending',
          toolEntrySeq: 6,
          thoughtSignature: 'sig-cur-turn',
        },
      ],
    };
    await savePendingTurnStrict(curPending);

    // 8a. 检测状态必须命中 seq 5 / curPending
    const stateBefore = await inspectCoachThreadPendingState(tid);
    expect(stateBefore.hasUnclosedToolBatch).toBe(true);
    expect(stateBefore.issue?.assistantEntrySeq).toBe(5);
    expect(stateBefore.pendingTurn?.turnId).toBe('turn-gem-cur');

    // 8b. 先检验“未知跨库状态 -> 放弃走隔离”时，只能隔离 seq 5，旧完整批 seq 2 & seq 3 必须逐条原样保留且未隔离
    const bumpedSess = (await getSession(session.id))!;
    await idbPut('sessions', { ...bumpedSess, revision: (bumpedSess.revision ?? 1) + 1 });
    const abnRes = await abandonPendingCoachTurn({
      threadId: tid,
      pendingTurn: curPending,
    });
    expect(abnRes.abandoned).toBe(true);
    expect(abnRes.quarantined).toBe(true);
    expect(await listPendingTurns(tid)).toHaveLength(0);

    const entriesAfterAbandon = (await listProtocolEntries(tid, segId)).sort((a, b) => a.seq - b.seq);
    const afterSeq2 = entriesAfterAbandon.find((e) => e.seq === 2)!;
    const afterSeq3 = entriesAfterAbandon.find((e) => e.seq === 3)!;
    const afterSeq5 = entriesAfterAbandon.find((e) => e.seq === 5)!;
    expect(afterSeq2).toEqual(oldAsstEntry);
    expect(afterSeq3).toEqual(oldToolEntry);
    expect(afterSeq2.quarantinedFromReplay).toBeFalsy();
    expect(afterSeq3.quarantinedFromReplay).toBeFalsy();
    expect(afterSeq5.quarantinedFromReplay).toBe(true);

    // 8c. 放弃一次后即可正常发送新消息，且出站仍保留 seq 2 -> seq 3 旧完整批
    let outboundBody: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      outboundBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '收到，继续第三组。' }] },
              finishReason: 'STOP',
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const nextSend = await runCoachTurn({
      threadId: tid,
      userText: '第三组怎么安排？',
      history: [
        { id: 'u-gem-1', threadId: tid, role: 'user', createdAt: NOW, text: '第一组 80kg 8次' },
        { id: 'a-gem-1', threadId: tid, role: 'assistant', createdAt: NOW + 1, text: '已记录第一组' },
        { id: 'u-gem-2', threadId: tid, role: 'user', createdAt: NOW + 2, text: '第二组 82.5kg 8次' },
      ],
      providerConfig: gemCfg,
      thinkingDepth: 'off',
      toolContext: { activeSession: (await getSession(session.id))!, activeThreadId: tid },
      streamChunkDelayMs: 0,
    });
    expect(nextSend.blockedByUnclosedBatch).toBeFalsy();
    expect(nextSend.text).toContain('继续第三组');
    const sentContents = (outboundBody?.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>) ?? [];
    const serialized = JSON.stringify(sentContents);
    expect(serialized).toContain('sig-old-turn');
    expect(serialized).toContain('早先第 1 轮已记录 80kg x 8');
    expect(serialized).not.toContain('sig-cur-turn');

    // 8d. 同段复用 gem_local_1 的“正常恢复”场景：seq 5 缺 seq 6，不得因 seq 3 已有 gem_local_1 而跳过执行或漏写 seq 6
    const segIdResume = 'seg-gem-resume-collision';
    await saveCoachThreadsState({
      ...(await loadCoachThreadsState()),
      activeThreadId: tid,
      threads: [
        {
          id: tid,
          title: '默认对话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: segIdResume,
          segments: {
            [segIdResume]: {
              segmentId: segIdResume,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: epoch,
              deploymentId: gemDeploymentId,
              providerKind: 'gemini',
              baseUrl: gemCfg.baseUrl,
              model: gemCfg.model,
              thinkingModeKey: 'off',
              baselineSnapshotJson: 'baseline',
              baselineSnapshotHash: 'bh',
              nextSeq: 6,
            },
          },
        },
      ],
    });
    await appendProtocolEntriesStrict([
      { id: `${tid}:${segIdResume}:1`, threadId: tid, segmentId: segIdResume, seq: 1, createdAt: NOW, kind: 'user', wireText: '第一组 80kg 8次' },
      { ...oldAsstEntry, id: `${tid}:${segIdResume}:2`, segmentId: segIdResume },
      { ...oldToolEntry, id: `${tid}:${segIdResume}:3`, segmentId: segIdResume },
      { id: `${tid}:${segIdResume}:4`, threadId: tid, segmentId: segIdResume, seq: 4, createdAt: NOW + 2, kind: 'user', wireText: '第二组 82.5kg 8次' },
      { ...curAsstEntry, id: `${tid}:${segIdResume}:5`, segmentId: segIdResume },
    ]);
    const resumeSess = (await getSession(session.id))!;
    const resumePending: CoachPendingTurn = {
      ...curPending,
      turnId: 'turn-gem-resume-cur',
      segmentId: segIdResume,
      userMessageId: `${tid}:${segIdResume}:4`,
      plannedToolCalls: [
        {
          ...curPending.plannedToolCalls![0],
          operationId: 'turn-gem-resume-cur:r0:c0',
          expectedRevision: resumeSess.revision,
          args: { ...curArgs, expectedRevision: resumeSess.revision },
        },
      ],
    };
    await savePendingTurnStrict(resumePending);

    vi.stubGlobal('fetch', async () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: '第二组也记好啦。' }] },
              finishReason: 'STOP',
            },
          ],
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const resResult = await resumePendingCoachTurn({
      threadId: tid,
      pendingTurn: resumePending,
      providerConfig: gemCfg,
      thinkingDepth: 'off',
      toolContext: { activeSession: (await getSession(session.id))!, activeThreadId: tid },
    });
    expect(resResult.resumed).toBe(true);
    expect(resResult.receipts).toHaveLength(1);
    const entriesAfterResume = await listProtocolEntries(tid, segIdResume);
    const seq6 = entriesAfterResume.find((e) => e.seq === 6);
    expect(seq6).toBeTruthy();
    expect(seq6?.kind).toBe('tool');
    expect(seq6?.toolCallId).toBe('gem_local_1');
    expect(((await getSession(session.id))!).exercises[0].sets[1].weightKg).toBe(82.5);
  });
});
