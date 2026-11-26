/* MOTION 第一批修复 · 阶段 #3 专项回归：
   1. CoachPane 手动压缩真实入口固定保留当次最近 2 条未压缩原文（原 ID/原角色/原顺序 + 脱敏正文，无工具轨迹/签名/附件），
      同一路由下一次发送开启 compaction 新段并与当次摘要一起承接，两条哨兵在出站请求中各恰出现 1 次且幂等不重复；
   2. 跨会话切换 / 冷加载重载后首发仍正确承接固定 2 条与当次摘要；
   3. 异步压缩期间：切到其他会话浏览仍正确提交原会话；同会话继续发消息则安全忽略过期提交；
      新一次手动压缩产出相同 BYTES 摘要时仍按新 compactionId 识别当前新尾部；
   4. 压缩完成后删除长期记忆，冷启/陈旧摘要参数传参均不再将已删记忆带出站；
   5. 切模型/端点不带过原文或原生轨迹；无元数据 v0.2.3 旧摘要仍可用且不扫库猜尾；备用摘要存在时不破坏 R3-3 原路由恢复。 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { getSession, savePlan } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import {
  purgeDeletedMemoryFromCoachHistory,
  resumePendingCoachTurn,
  runCoachTurn,
} from '../src/coach/coachAgent';
import { createEmptyCoachMemory, saveCoachMemory, upsertCoachMemoryItem } from '../src/coach/coachMemory';
import { executeManualContextCompaction } from '../src/coach/CoachPane';
import {
  appendProtocolEntriesStrict,
  DEFAULT_COACH_THREAD_ID,
  getCoachRestoreEpoch,
  listPendingTurns,
  listProtocolEntries,
  loadCoachMessages,
  loadCoachThreadsState,
  resetCoachVaultForTest,
  saveCoachMessages,
  saveCoachProviderConfig,
  saveCoachThreadsState,
  savePendingTurnStrict,
  type CoachPendingTurn,
  type CoachStoredAttachment,
  type CoachStoredMessage,
  type CoachStoredProviderConfig,
} from '../src/coach/coachStorage';
import { computeDeploymentId } from '../src/coach/providerCapabilities';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_769_000_000_000;

function makePlan(id = 'plan-stage3-comp'): Plan {
  const base = createV32Plan(NOW);
  return {
    ...base,
    id,
    name: '阶段3手动压缩测试计划',
    days: [base.days[0]],
    cursor: 0,
  };
}

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

async function seedSession(sessionId: string): Promise<{ plan: Plan; session: Session }> {
  const plan = makePlan(`plan-${sessionId}`);
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = { ...raw, id: sessionId };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-stage3');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-stage3',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh };
}

function sseOpenAIText(text: string, reasoning?: string): Response {
  const enc = new TextEncoder();
  const chunks = [
    ...(reasoning
      ? [`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`]
      : []),
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) >= 0) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

const routeACfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'openai-compatible',
  presetId: 'deepseek-official',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  thinkingDepth: 'high',
  apiKey: 'sk-synth-a',
  updatedAt: NOW,
};

const routeBCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'anthropic',
  presetId: 'anthropic-official',
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514',
  thinkingDepth: 'high',
  apiKey: 'sk-synth-b',
  updatedAt: NOW,
};

describe('MOTION 第一批修复 · 阶段 #3：手动压缩保留最近 2 条原文、幂等承接、并发边界与脱敏隔离', () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('1. 手动压缩真实入口保存固定 2 条标识，下一同路由请求开启 compaction 段且两条哨兵各恰出现一次（无旧工具/签名/附件、幂等不重复）', async () => {
    const { session } = await seedSession('sess-s3-basic');
    await saveCoachProviderConfig(routeACfg);
    const tid = DEFAULT_COACH_THREAD_ID;
    const epoch = await getCoachRestoreEpoch();
    const oldSegId = 'seg-old-route-a';
    const depA = computeDeploymentId(routeACfg);

    await saveCoachThreadsState({
      activeThreadId: tid,
      threads: [
        {
          id: tid,
          title: '默认对话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: oldSegId,
          segments: {
            [oldSegId]: {
              segmentId: oldSegId,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: epoch,
              deploymentId: depA,
              providerKind: routeACfg.kind,
              baseUrl: routeACfg.baseUrl,
              model: routeACfg.model,
              thinkingModeKey: 'high',
              baselineSnapshotJson: 'baseline-old',
              baselineSnapshotHash: 'bh-old',
              nextSeq: 6,
            },
          },
        },
      ],
    });

    const fakeAtt: CoachStoredAttachment = {
      id: 'att-early-1',
      kind: 'image',
      name: 'early.jpg',
      mimeType: 'image/jpeg',
      width: 64,
      height: 64,
      dataBase64: 'AAA_EARLY_IMAGE_BASE64',
      sizeBytes: 64,
    };

    // 旧段包含工具轨迹、签名与附件，不应被手动压缩新段回灌
    await appendProtocolEntriesStrict([
      {
        id: `${tid}:${oldSegId}:1`,
        threadId: tid,
        segmentId: oldSegId,
        seq: 1,
        createdAt: NOW,
        kind: 'user',
        wireText: '早期问题 EARLY_RAW_SENTINEL_1',
        attachments: [fakeAtt],
      },
      {
        id: `${tid}:${oldSegId}:2`,
        threadId: tid,
        segmentId: oldSegId,
        seq: 2,
        createdAt: NOW + 1,
        kind: 'assistant',
        assistantText: '',
        reasoningText: 'OLD_TRACE_REASONING_SIG_999',
        anthropicBlocks: [
          { type: 'thinking', thinking: 't', signature: 'OLD_ANT_SIG_888' },
          { type: 'tool_use', id: 'tc-old-1', name: 'record_active_set', input: { reps: 8 } },
        ],
        geminiParts: [
          {
            functionCall: { name: 'record_active_set', args: { reps: 8 } },
            thoughtSignature: 'OLD_GEM_SIG_777',
          },
        ],
        toolCalls: [
          {
            id: 'tc-old-1',
            index: 0,
            name: 'record_active_set',
            argumentsText: '{"reps":8}',
            thoughtSignature: 'OLD_GEM_SIG_777',
          },
        ],
      },
      {
        id: `${tid}:${oldSegId}:3`,
        threadId: tid,
        segmentId: oldSegId,
        seq: 3,
        createdAt: NOW + 2,
        kind: 'tool',
        toolCallId: 'tc-old-1',
        toolName: 'record_active_set',
        toolResultText: JSON.stringify({ ok: true, summary: 'OLD_TOOL_RESULT_TEXT' }),
      },
      {
        id: `${tid}:${oldSegId}:4`,
        threadId: tid,
        segmentId: oldSegId,
        seq: 4,
        createdAt: NOW + 3,
        kind: 'user',
        wireText: '最近用户消息 KEPT_SENTINEL_USER_A1',
        attachments: [fakeAtt],
      },
      {
        id: `${tid}:${oldSegId}:5`,
        threadId: tid,
        segmentId: oldSegId,
        seq: 5,
        createdAt: NOW + 4,
        kind: 'assistant',
        assistantText: '最近助手答复 KEPT_SENTINEL_ASST_B2',
        reasoningText: 'SHOULD_NOT_REPLAY_REASONING_666',
      },
    ]);

    const storedMsgs: CoachStoredMessage[] = [
      { id: 'msg-u1', threadId: tid, role: 'user', createdAt: NOW, text: '早期问题 EARLY_RAW_SENTINEL_1' },
      { id: 'msg-a1', threadId: tid, role: 'assistant', createdAt: NOW + 1, text: '早期回复 EARLY_RAW_SENTINEL_2' },
      {
        id: 'msg-u2',
        threadId: tid,
        role: 'user',
        createdAt: NOW + 3,
        text: '最近用户消息 KEPT_SENTINEL_USER_A1',
        attachments: [fakeAtt],
      },
      {
        id: 'msg-a2',
        threadId: tid,
        role: 'assistant',
        createdAt: NOW + 4,
        text: '最近助手答复 KEPT_SENTINEL_ASST_B2',
        reasoning: 'SHOULD_NOT_REPLAY_REASONING_666',
      },
    ];
    await saveCoachMessages(storedMsgs);

    const requestBodies: Array<Record<string, unknown>> = [];
    let fetchMode: 'summary' | 'chat1' | 'chat2' = 'summary';
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (fetchMode === 'summary') return sseOpenAIText('摘要结论：早前已完成热身与组数确认 COMPACT_SUM_ALPHA');
      if (fetchMode === 'chat1') return sseOpenAIText('好的，继续按 KEPT 上下文推进下一组。', 'turn1-reasoning');
      return sseOpenAIText('第二轮收到。', 'turn2-reasoning');
    });

    const compactRes = await executeManualContextCompaction({
      threadId: tid,
      messages: storedMsgs,
      providerConfig: routeACfg,
    });
    expect(compactRes.committed).toBe(true);
    expect(compactRes.compressedCount).toBe(2);
    expect(compactRes.compressedIds).toEqual(['msg-u1', 'msg-a1']);
    expect(compactRes.keptMessageIds).toEqual(['msg-u2', 'msg-a2']);

    const afterCompactState = await loadCoachThreadsState();
    const afterCompactThread = afterCompactState.threads.find((t) => t.id === tid)!;
    expect(afterCompactThread.contextSummary).toContain('COMPACT_SUM_ALPHA');
    expect(afterCompactThread.manualCompaction?.compactionId).toBe(compactRes.compactionId);
    expect(afterCompactThread.manualCompaction?.keptMessages).toEqual([
      { id: 'msg-u2', role: 'user', createdAt: NOW + 3, text: '最近用户消息 KEPT_SENTINEL_USER_A1' },
      { id: 'msg-a2', role: 'assistant', createdAt: NOW + 4, text: '最近助手答复 KEPT_SENTINEL_ASST_B2' },
    ]);

    // 下一请求（故意传入不包含 KEPT 哨兵的 history 片段以证明并非从 next send 临时截尾部，新消息也不得替换指定尾部）
    fetchMode = 'chat1';
    const turn1 = await runCoachTurn({
      threadId: tid,
      userText: '新消息 NEW_SEND_TAIL_C3',
      history: [{ id: 'unrelated-or-stale', threadId: tid, role: 'user', createdAt: NOW + 5, text: '不应覆盖旧尾部' }],
      contextSummary: afterCompactThread.contextSummary,
      providerConfig: routeACfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: session, activeThreadId: tid },
      streamChunkDelayMs: 0,
    });
    expect(turn1.text).toContain('推进下一组');

    const chat1Body = requestBodies[1];
    const chat1Json = JSON.stringify(chat1Body);
    const msgs1 = chat1Body.messages as Array<{ role: string; content: string; reasoning_content?: string; tool_calls?: unknown }>;

    // 摘要进入 baseline，早期原文不以独立消息出现
    expect(chat1Json).toContain('COMPACT_SUM_ALPHA');
    expect(chat1Json).not.toContain('EARLY_RAW_SENTINEL_1');
    expect(chat1Json).not.toContain('EARLY_RAW_SENTINEL_2');
    // 不回灌旧工具轨迹 / 签名 / 附件 / 未经脱敏 reasoning
    expect(chat1Json).not.toContain('OLD_TOOL_RESULT_TEXT');
    expect(chat1Json).not.toContain('OLD_TRACE_REASONING_SIG_999');
    expect(chat1Json).not.toContain('OLD_ANT_SIG_888');
    expect(chat1Json).not.toContain('OLD_GEM_SIG_777');
    expect(chat1Json).not.toContain('AAA_EARLY_IMAGE_BASE64');
    expect(chat1Json).not.toContain('SHOULD_NOT_REPLAY_REASONING_666');

    // 两条哨兵在出站请求中各恰出现 1 次，且以鲜明角色纯文本上下文引用形式按原顺序置于 baseline、早于新消息，不伪造缺 reasoning 的 assistant 协议轨迹
    expect(countOccurrences(chat1Json, 'KEPT_SENTINEL_USER_A1')).toBe(1);
    expect(countOccurrences(chat1Json, 'KEPT_SENTINEL_ASST_B2')).toBe(1);
    expect(countOccurrences(chat1Json, 'NEW_SEND_TAIL_C3')).toBe(1);
    const baselineMsg = msgs1[1];
    expect(baselineMsg.role).toBe('user');
    const baselineText = String(baselineMsg.content);
    expect(baselineText).toContain('用户 (user)');
    expect(baselineText).toContain('教练 (assistant)');
    const k1Pos = baselineText.indexOf('KEPT_SENTINEL_USER_A1');
    const k2Pos = baselineText.indexOf('KEPT_SENTINEL_ASST_B2');
    expect(k1Pos).toBeGreaterThan(0);
    expect(k2Pos).toBeGreaterThan(k1Pos);
    const newMsgIdx = msgs1.findIndex((m) => m.role === 'user' && String(m.content).includes('NEW_SEND_TAIL_C3'));
    expect(newMsgIdx).toBeGreaterThan(1);
    // 协议层与出站消息中均未伪造缺 reasoning 的 assistant 协议轨迹
    expect(msgs1.some((m) => m.role === 'assistant' && String(m.content).includes('KEPT_SENTINEL_ASST_B2'))).toBe(false);

    // 校验新 compaction 段与协议条目（首条即为新用户消息，containsAssistantWithoutReasoning 保持未污染）
    const afterTurn1State = await loadCoachThreadsState();
    const t1Thread = afterTurn1State.threads.find((t) => t.id === tid)!;
    const compSegId = t1Thread.activeSegmentId!;
    expect(compSegId).not.toBe(oldSegId);
    expect(t1Thread.segments?.[compSegId]?.reason).toBe('compaction');
    expect(t1Thread.segments?.[compSegId]?.manualCompactionId).toBe(compactRes.compactionId);
    expect(t1Thread.segments?.[compSegId]?.containsAssistantWithoutReasoning).toBeFalsy();
    expect(t1Thread.manualCompaction?.consumedBySegmentId).toBe(compSegId);

    const compEntries = (await listProtocolEntries(tid, compSegId)).sort((a, b) => a.seq - b.seq);
    expect(compEntries.some((e) => e.kind === 'assistant' && !e.reasoningText && e.assistantText?.includes('KEPT_SENTINEL_ASST_B2'))).toBe(false);
    expect(compEntries[0].kind).toBe('user');
    expect(compEntries[0].wireText).toContain('NEW_SEND_TAIL_C3');

    // 再发第二轮：幂等复用同一个 compaction 段，不重复注入 KEPT 哨兵
    fetchMode = 'chat2';
    await runCoachTurn({
      threadId: tid,
      userText: '继续第四组',
      history: [
        ...storedMsgs.map((m) => (m.id === 'msg-u1' || m.id === 'msg-a1' ? { ...m, compressed: true } : m)),
        { id: 'msg-u3', threadId: tid, role: 'user', createdAt: NOW + 5, text: '新消息 NEW_SEND_TAIL_C3' },
      ],
      contextSummary: t1Thread.contextSummary,
      providerConfig: routeACfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: session, activeThreadId: tid },
      streamChunkDelayMs: 0,
    });
    const chat2Json = JSON.stringify(requestBodies[2]);
    const afterTurn2State = await loadCoachThreadsState();
    expect(afterTurn2State.threads.find((t) => t.id === tid)?.activeSegmentId).toBe(compSegId);
    expect(countOccurrences(chat2Json, 'KEPT_SENTINEL_USER_A1')).toBe(1);
    expect(countOccurrences(chat2Json, 'KEPT_SENTINEL_ASST_B2')).toBe(1);
  });

  it('2. 跨会话切换 + 冷加载重载后首发仍正确承接固定 2 条与当次摘要', async () => {
    const { session } = await seedSession('sess-s3-reload');
    await saveCoachProviderConfig(routeACfg);
    const tidA = DEFAULT_COACH_THREAD_ID;
    const tidB = 'thread-b-browse';
    await saveCoachThreadsState({
      activeThreadId: tidA,
      threads: [
        { id: tidA, title: '会话A', createdAt: NOW, updatedAt: NOW },
        { id: tidB, title: '会话B', createdAt: NOW, updatedAt: NOW },
      ],
    });
    const msgsA: CoachStoredMessage[] = [
      { id: 'a-1', threadId: tidA, role: 'user', createdAt: NOW, text: '早期 RELOAD_EARLY_X1' },
      { id: 'a-2', threadId: tidA, role: 'assistant', createdAt: NOW + 1, text: '早期 RELOAD_EARLY_X2' },
      { id: 'a-3', threadId: tidA, role: 'user', createdAt: NOW + 2, text: '保留问题 RELOAD_KEPT_1' },
      { id: 'a-4', threadId: tidA, role: 'assistant', createdAt: NOW + 3, text: '保留回复 RELOAD_KEPT_2' },
    ];
    await saveCoachMessages(msgsA);

    let outbound: Record<string, unknown> | undefined;
    let mode: 'sum' | 'send' = 'sum';
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      if (mode === 'sum') return sseOpenAIText('冷加载摘要 RELOAD_SUM_OK');
      outbound = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return sseOpenAIText('冷加载首发正常');
    });

    const res = await executeManualContextCompaction({
      threadId: tidA,
      messages: msgsA,
      providerConfig: routeACfg,
    });
    expect(res.committed).toBe(true);

    // 切到会话 B 再冷启
    const st = await loadCoachThreadsState();
    await saveCoachThreadsState({ ...st, activeThreadId: tidB });
    __resetDbHandle();

    // 重载后切回 A 首次发送
    const reloaded = await loadCoachThreadsState();
    const threadA = reloaded.threads.find((t) => t.id === tidA)!;
    expect(threadA.manualCompaction?.keptMessages.map((m) => m.id)).toEqual(['a-3', 'a-4']);

    mode = 'send';
    await runCoachTurn({
      threadId: tidA,
      userText: '冷启后首发问题',
      history: (await loadCoachMessages()).filter((m) => m.threadId === tidA),
      providerConfig: routeACfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: session, activeThreadId: tidA },
      streamChunkDelayMs: 0,
    });
    const json = JSON.stringify(outbound);
    expect(json).toContain('RELOAD_SUM_OK');
    expect(countOccurrences(json, 'RELOAD_KEPT_1')).toBe(1);
    expect(countOccurrences(json, 'RELOAD_KEPT_2')).toBe(1);
    expect(json).not.toContain('RELOAD_EARLY_X1');
  });

  it('3. 异步压缩并发边界：切会话浏览正常落库原会话；同会话继续发消息安全忽略过期提交；同摘要相同 BYTES 再次手动压缩仍开新段承接新尾部', async () => {
    const { session } = await seedSession('sess-s3-async-races');
    await saveCoachProviderConfig(routeACfg);
    const tidA = 'thread-race-a';
    const tidB = 'thread-race-b';
    await saveCoachThreadsState({
      activeThreadId: tidA,
      threads: [
        { id: tidA, title: '竞赛会话A', createdAt: NOW, updatedAt: NOW },
        { id: tidB, title: '竞赛会话B', createdAt: NOW, updatedAt: NOW },
      ],
    });
    const msgsA: CoachStoredMessage[] = [
      { id: 'r-1', threadId: tidA, role: 'user', createdAt: NOW, text: '第一轮 R_EARLY_1' },
      { id: 'r-2', threadId: tidA, role: 'assistant', createdAt: NOW + 1, text: '第一轮 R_EARLY_2' },
      { id: 'r-3', threadId: tidA, role: 'user', createdAt: NOW + 2, text: '保留第一波 R_KEPT_WAVE1_U' },
      { id: 'r-4', threadId: tidA, role: 'assistant', createdAt: NOW + 3, text: '保留第一波 R_KEPT_WAVE1_A' },
    ];
    await saveCoachMessages(msgsA);

    // 3a. 异步压缩期间切换到 B 浏览 -> A 正常提交且保持 activeThreadId = B
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((r) => {
      releaseSummary = r;
    });
    const SAME_BYTES_SUMMARY = '固定同字节摘要 IDENTICAL_SUMMARY_BYTES_V1';
    vi.stubGlobal('fetch', async () => {
      await summaryGate;
      return sseOpenAIText(SAME_BYTES_SUMMARY);
    });

    const compactAPromise = executeManualContextCompaction({
      threadId: tidA,
      messages: msgsA,
      providerConfig: routeACfg,
    });
    // 等待异步进入 fetch 后切换到会话 B
    await Promise.resolve();
    await saveCoachThreadsState({ ...(await loadCoachThreadsState()), activeThreadId: tidB });
    releaseSummary();
    const resA = await compactAPromise;
    expect(resA.committed).toBe(true);
    const stateAfterSwitch = await loadCoachThreadsState();
    expect(stateAfterSwitch.activeThreadId).toBe(tidB);
    expect(stateAfterSwitch.threads.find((t) => t.id === tidA)?.manualCompaction?.keptMessages.map((m) => m.id)).toEqual(['r-3', 'r-4']);

    // 3b. 同摘要相同 BYTES 再次手动压缩：先发 1 轮（消费 wave1）再追加 1 轮使未压缩 >= 4 条，再用同一摘要文本再次压缩
    const sentPayloads: string[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? '{}');
      sentPayloads.push(body);
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
      if (parsed.messages?.[0]?.content?.includes('不超过 300 字')) {
        return sseOpenAIText(SAME_BYTES_SUMMARY);
      }
      return sseOpenAIText('模型回复 R_REPLY_ROUND', 'wave1-reasoning');
    });

    await runCoachTurn({
      threadId: tidA,
      userText: 'Wave1 新发 R_WAVE1_NEW',
      history: (await loadCoachMessages()).filter((m) => m.threadId === tidA),
      providerConfig: routeACfg,
      toolContext: { activeSession: session, activeThreadId: tidA },
      streamChunkDelayMs: 0,
    });
    const wave1SegId = (await loadCoachThreadsState()).threads.find((t) => t.id === tidA)!.activeSegmentId!;

    const msgsWave2: CoachStoredMessage[] = [
      { id: 'r-1', threadId: tidA, role: 'user', createdAt: NOW, text: '第一轮 R_EARLY_1', compressed: true },
      { id: 'r-2', threadId: tidA, role: 'assistant', createdAt: NOW + 1, text: '第一轮 R_EARLY_2', compressed: true },
      { id: 'r-3', threadId: tidA, role: 'user', createdAt: NOW + 2, text: '保留第一波 R_KEPT_WAVE1_U' },
      { id: 'r-4', threadId: tidA, role: 'assistant', createdAt: NOW + 3, text: '保留第一波 R_KEPT_WAVE1_A' },
      { id: 'r-5', threadId: tidA, role: 'user', createdAt: NOW + 5, text: '保留第二波 R_KEPT_WAVE2_U' },
      { id: 'r-6', threadId: tidA, role: 'assistant', createdAt: NOW + 6, text: '保留第二波 R_KEPT_WAVE2_A' },
    ];
    await saveCoachMessages(msgsWave2);

    const resWave2 = await executeManualContextCompaction({
      threadId: tidA,
      messages: msgsWave2,
      existingSummary: SAME_BYTES_SUMMARY,
      providerConfig: routeACfg,
    });
    expect(resWave2.committed).toBe(true);
    expect(resWave2.summary).toBe(SAME_BYTES_SUMMARY);
    expect(resWave2.keptMessageIds).toEqual(['r-5', 'r-6']);

    await runCoachTurn({
      threadId: tidA,
      userText: 'Wave2 新发 R_WAVE2_NEW',
      history: (await loadCoachMessages()).filter((m) => m.threadId === tidA),
      contextSummary: SAME_BYTES_SUMMARY,
      providerConfig: routeACfg,
      toolContext: { activeSession: session, activeThreadId: tidA },
      streamChunkDelayMs: 0,
    });
    const wave2Thread = (await loadCoachThreadsState()).threads.find((t) => t.id === tidA)!;
    const wave2SegId = wave2Thread.activeSegmentId!;
    // 即使摘要字节完全相同，仍因新的 compactionId 开启新段并准确承接 wave2 尾部
    expect(wave2SegId).not.toBe(wave1SegId);
    expect(wave2Thread.segments?.[wave2SegId]?.reason).toBe('compaction');
    const wave2Outbound = sentPayloads[sentPayloads.length - 1];
    expect(countOccurrences(wave2Outbound, 'R_KEPT_WAVE2_U')).toBe(1);
    expect(countOccurrences(wave2Outbound, 'R_KEPT_WAVE2_A')).toBe(1);
    expect(wave2Outbound).not.toContain('R_KEPT_WAVE1_U');

    // 3c. 异步压缩期间同会话继续发消息 -> 安全忽略过期压缩提交，保留新发消息与压缩前状态
    let releaseRaceSum!: () => void;
    const raceSumGate = new Promise<void>((r) => {
      releaseRaceSum = r;
    });
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
      if (parsed.messages?.[0]?.content?.includes('不超过 300 字')) {
        await raceSumGate;
        return sseOpenAIText('过期压缩摘要 STALE_SUMMARY_MUST_DROP');
      }
      return sseOpenAIText('异步期间插入回复');
    });

    const raceMsgs: CoachStoredMessage[] = [
      { id: 'r-5', threadId: tidA, role: 'user', createdAt: NOW + 5, text: '保留第二波 R_KEPT_WAVE2_U' },
      { id: 'r-6', threadId: tidA, role: 'assistant', createdAt: NOW + 6, text: '保留第二波 R_KEPT_WAVE2_A' },
      { id: 'r-7', threadId: tidA, role: 'user', createdAt: NOW + 7, text: '新对话 R_PRE_RACE_U' },
      { id: 'r-8', threadId: tidA, role: 'assistant', createdAt: NOW + 8, text: '新对话 R_PRE_RACE_A' },
    ];
    await saveCoachMessages(raceMsgs);

    const stalePromise = executeManualContextCompaction({
      threadId: tidA,
      messages: raceMsgs,
      providerConfig: routeACfg,
    });
    // 在摘要模型返回前，用户同一会话继续发送一条新消息
    await runCoachTurn({
      threadId: tidA,
      userText: '并发插入的新消息 DURING_COMPACT_NEW_MSG',
      history: raceMsgs,
      providerConfig: routeACfg,
      toolContext: { activeSession: session, activeThreadId: tidA },
      streamChunkDelayMs: 0,
    });
    releaseRaceSum();

    const staleRes = await stalePromise;
    expect(staleRes.committed).toBe(false);
    expect(staleRes.staleIgnored).toBe(true);
    const finalThreadA = (await loadCoachThreadsState()).threads.find((t) => t.id === tidA)!;
    expect(finalThreadA.contextSummary).toBe(SAME_BYTES_SUMMARY);
    expect(finalThreadA.contextSummary).not.toContain('STALE_SUMMARY_MUST_DROP');
    expect((await loadCoachMessages()).some((m) => m.id === 'r-5' && !m.compressed)).toBe(true);
  });

  it('4. 压缩完成后删除长期记忆，冷加载及带入陈旧未净化 contextSummary 参数时均不再将已删记忆带出站', async () => {
    const { session } = await seedSession('sess-s3-mem-delete');
    await saveCoachProviderConfig(routeACfg);
    const tid = DEFAULT_COACH_THREAD_ID;
    const SECRET_MEM = 'SENSITIVE_INJURY_TOKEN_66X';

    const memStore = createEmptyCoachMemory();
    const added = upsertCoachMemoryItem(memStore, {
      category: 'injury',
      title: '左膝伤病',
      content: SECRET_MEM,
      source: 'user',
    });
    await saveCoachMemory(added.store);

    const msgs: CoachStoredMessage[] = [
      { id: 'm-1', threadId: tid, role: 'user', createdAt: NOW, text: `早期关注 ${SECRET_MEM}` },
      { id: 'm-2', threadId: tid, role: 'assistant', createdAt: NOW + 1, text: '早期收到' },
      { id: 'm-3', threadId: tid, role: 'user', createdAt: NOW + 2, text: `近期再确认 ${SECRET_MEM} 与 KEPT_SAFE_TOKEN_1` },
      { id: 'm-4', threadId: tid, role: 'assistant', createdAt: NOW + 3, text: `已留意 ${SECRET_MEM}，按 KEPT_SAFE_TOKEN_2 执行` },
    ];
    await saveCoachMessages(msgs);

    let mode: 'sum' | 'send' = 'sum';
    let outboundBody = '';
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      if (mode === 'sum') {
        return sseOpenAIText(`摘要记录了 ${SECRET_MEM} 以及前两轮结论`);
      }
      outboundBody = String(init?.body ?? '{}');
      return sseOpenAIText('安全恢复完成');
    });

    const compactRes = await executeManualContextCompaction({
      threadId: tid,
      messages: msgs,
      providerConfig: routeACfg,
    });
    expect(compactRes.committed).toBe(true);

    // 压缩完成后才删除该记忆
    await saveCoachMemory(createEmptyCoachMemory());
    await purgeDeletedMemoryFromCoachHistory({
      threadId: tid,
      memoryId: added.item.id,
      memoryTitle: added.item.title,
      memoryContent: SECRET_MEM,
    });

    // 冷加载后，即使调用方仍错误传回压缩前未净化的 contextSummary，出站也必须彻底剔除已删记忆
    __resetDbHandle();
    mode = 'send';
    await runCoachTurn({
      threadId: tid,
      userText: '今天开始训练',
      history: msgs,
      contextSummary: `摘要记录了 ${SECRET_MEM} 以及前两轮结论`,
      providerConfig: routeACfg,
      toolContext: { activeSession: session, activeThreadId: tid },
      streamChunkDelayMs: 0,
    });

    expect(outboundBody).not.toContain(SECRET_MEM);
    expect(countOccurrences(outboundBody, 'KEPT_SAFE_TOKEN_1')).toBe(1);
    expect(countOccurrences(outboundBody, 'KEPT_SAFE_TOKEN_2')).toBe(1);
  });

  it('5. 切模型/端点不带过原文或原生轨迹；无元数据 v0.2.3 旧手动摘要可用且不猜尾；备用摘要存在时不改变 R3-3 原路由恢复', async () => {
    // 5a. 手动压缩后直接切换到新模型（Anthropic），开启 protocol_or_deployment_switch 段，不带过 Route A 原文或原生轨迹
    const { session } = await seedSession('sess-s3-switch-legacy-r33');
    await saveCoachProviderConfig(routeACfg);
    const tidSwitch = 'thread-switch-model';
    const segOldA = 'seg-route-a';
    await saveCoachThreadsState({
      activeThreadId: tidSwitch,
      threads: [
        {
          id: tidSwitch,
          title: '切模型会话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: segOldA,
          segments: {
            [segOldA]: {
              segmentId: segOldA,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: await getCoachRestoreEpoch(),
              deploymentId: computeDeploymentId(routeACfg),
              providerKind: routeACfg.kind,
              baseUrl: routeACfg.baseUrl,
              model: routeACfg.model,
              thinkingModeKey: 'high',
              baselineSnapshotJson: 'baseline-a',
              baselineSnapshotHash: 'ha',
              nextSeq: 3,
            },
          },
        },
      ],
    });
    const switchMsgs: CoachStoredMessage[] = [
      { id: 'sw-1', threadId: tidSwitch, role: 'user', createdAt: NOW, text: '旧模型问题 SW_EARLY_1' },
      { id: 'sw-2', threadId: tidSwitch, role: 'assistant', createdAt: NOW + 1, text: '旧模型回复 SW_EARLY_2' },
      { id: 'sw-3', threadId: tidSwitch, role: 'user', createdAt: NOW + 2, text: '同路由尾部 SW_SHOULD_NOT_CROSS_ROUTE_1' },
      { id: 'sw-4', threadId: tidSwitch, role: 'assistant', createdAt: NOW + 3, text: '同路由回复 SW_SHOULD_NOT_CROSS_ROUTE_2' },
    ];
    await saveCoachMessages(switchMsgs);

    let mode: 'sum' | 'anthropic' = 'sum';
    const anthropicBodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      if (mode === 'sum') return sseOpenAIText('跨模型前摘要 SW_SUMMARY_ONLY');
      anthropicBodies.push(String(init?.body ?? '{}'));
      return new Response(
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 10 } } })}\n\n` +
          `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: '新模型已接手' } })}\n\n` +
          `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n` +
          `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } })}\n\n` +
          'event: message_stop\ndata: {}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    await executeManualContextCompaction({
      threadId: tidSwitch,
      messages: switchMsgs,
      providerConfig: routeACfg,
    });

    // 切换到 Route B（Anthropic）发第 1、2 轮：均不得带过 Route A 的 SW_SHOULD_NOT_CROSS_ROUTE_*
    mode = 'anthropic';
    await runCoachTurn({
      threadId: tidSwitch,
      userText: '切模型后第一问',
      history: switchMsgs,
      providerConfig: routeBCfg,
      toolContext: { activeSession: session, activeThreadId: tidSwitch },
      streamChunkDelayMs: 0,
    });
    await runCoachTurn({
      threadId: tidSwitch,
      userText: '切模型后第二问',
      history: switchMsgs,
      providerConfig: routeBCfg,
      toolContext: { activeSession: session, activeThreadId: tidSwitch },
      streamChunkDelayMs: 0,
    });
    for (const body of anthropicBodies) {
      expect(body).not.toContain('SW_SHOULD_NOT_CROSS_ROUTE_1');
      expect(body).not.toContain('SW_SHOULD_NOT_CROSS_ROUTE_2');
    }
    const afterSwitchState = await loadCoachThreadsState();
    const swThread = afterSwitchState.threads.find((t) => t.id === tidSwitch)!;
    const swEntries = await listProtocolEntries(tidSwitch, swThread.activeSegmentId!);
    expect(swEntries.some((e) => e.sourceMessageId === 'sw-3' || e.sourceMessageId === 'sw-4')).toBe(false);

    // 5b. 现存无 manualCompaction 元数据的 v0.2.3 旧手动摘要继续可用，不擅自扫库猜两条尾部
    const tidLegacy = 'thread-v023-legacy-summary';
    const legacyMsgs: CoachStoredMessage[] = [
      { id: 'lg-1', threadId: tidLegacy, role: 'user', createdAt: NOW, text: '旧对话 GUESS_FORBIDDEN_1' },
      { id: 'lg-2', threadId: tidLegacy, role: 'assistant', createdAt: NOW + 1, text: '旧回复 GUESS_FORBIDDEN_2' },
    ];
    await saveCoachMessages(legacyMsgs);
    await saveCoachThreadsState({
      ...(await loadCoachThreadsState()),
      activeThreadId: tidLegacy,
      threads: [
        ...(await loadCoachThreadsState()).threads,
        {
          id: tidLegacy,
          title: '旧版摘要会话',
          createdAt: NOW,
          updatedAt: NOW,
          contextSummary: 'LEGACY_V023_SUMMARY_777',
          compressedCount: 2,
          activeSegmentId: 'seg-lg-0',
          segments: {
            'seg-lg-0': {
              segmentId: 'seg-lg-0',
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: await getCoachRestoreEpoch(),
              deploymentId: computeDeploymentId(routeACfg),
              providerKind: routeACfg.kind,
              baseUrl: routeACfg.baseUrl,
              model: routeACfg.model,
              thinkingModeKey: 'high',
              baselineSnapshotJson: 'no-summary-yet',
              baselineSnapshotHash: 'h-lg',
              nextSeq: 1,
            },
          },
        },
      ],
    });

    let legacyOutbound = '';
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      legacyOutbound = String(init?.body ?? '{}');
      return sseOpenAIText('旧摘要正常工作');
    });
    await runCoachTurn({
      threadId: tidLegacy,
      userText: '旧摘要下一次发送',
      history: legacyMsgs,
      providerConfig: routeACfg,
      toolContext: { activeSession: session, activeThreadId: tidLegacy },
      streamChunkDelayMs: 0,
    });
    expect(legacyOutbound).toContain('LEGACY_V023_SUMMARY_777');
    expect(legacyOutbound).not.toContain('GUESS_FORBIDDEN_1');
    expect(legacyOutbound).not.toContain('GUESS_FORBIDDEN_2');
    const lgAfter = (await loadCoachThreadsState()).threads.find((t) => t.id === tidLegacy)!;
    expect(lgAfter.segments?.[lgAfter.activeSegmentId!]?.reason).toBe('compaction');

    // 5c. 存在备用/手动摘要时，R3-3 原路由恢复契约不受影响
    const tidR33 = 'thread-r33-with-summary';
    const segR33 = 'seg-r33';
    const epoch = await getCoachRestoreEpoch();
    const pendingR33: CoachPendingTurn = {
      turnId: 'turn-r33-sum',
      threadId: tidR33,
      segmentId: segR33,
      status: 'awaiting_tools',
      round: 0,
      userMessageId: `${tidR33}:${segR33}:1`,
      userPromptText: '记一组',
      createdAt: NOW,
      updatedAt: NOW,
      restoreEpoch: epoch,
      providerKind: routeACfg.kind,
      baseUrl: routeACfg.baseUrl,
      deploymentId: computeDeploymentId(routeACfg),
      model: routeACfg.model,
      thinkingDepth: 'high',
      assistantEntrySeq: 2,
      plannedToolCalls: [
        {
          index: 0,
          toolCallId: 'call-r33-sum',
          operationId: 'turn-r33-sum:r0:c0',
          name: 'record_active_set',
          argumentsText: JSON.stringify({
            sessionId: session.id,
            exId: session.exercises[0].id,
            roundIndex: 1,
            weightKg: 75,
            reps: 8,
            expectedRevision: session.revision,
          }),
          args: {
            sessionId: session.id,
            exId: session.exercises[0].id,
            roundIndex: 1,
            weightKg: 75,
            reps: 8,
            expectedRevision: session.revision,
          },
          expectedRevision: session.revision,
          expectedEpoch: epoch,
          toolEntrySeq: 3,
          status: 'pending',
        },
      ],
    };
    await saveCoachThreadsState({
      ...(await loadCoachThreadsState()),
      activeThreadId: tidR33,
      threads: [
        ...(await loadCoachThreadsState()).threads,
        {
          id: tidR33,
          title: '恢复带摘要',
          createdAt: NOW,
          updatedAt: NOW,
          contextSummary: 'BACKUP_SUMMARY_EXISTS',
          manualCompaction: {
            compactionId: 'mc-r33-consumed',
            summary: 'BACKUP_SUMMARY_EXISTS',
            summaryHash: 'h',
            keptMessages: [],
            createdAt: NOW,
            consumedBySegmentId: segR33,
          },
          activeSegmentId: segR33,
          segments: {
            [segR33]: {
              segmentId: segR33,
              startedAt: NOW,
              reason: 'compaction',
              restoreEpoch: epoch,
              deploymentId: computeDeploymentId(routeACfg),
              providerKind: routeACfg.kind,
              baseUrl: routeACfg.baseUrl,
              model: routeACfg.model,
              thinkingModeKey: 'high',
              baselineSnapshotJson: '前期摘要:\nBACKUP_SUMMARY_EXISTS',
              baselineSnapshotHash: 'h2',
              nextSeq: 3,
            },
          },
        },
      ],
    });
    await appendProtocolEntriesStrict([
      { id: `${tidR33}:${segR33}:1`, threadId: tidR33, segmentId: segR33, seq: 1, createdAt: NOW, kind: 'user', wireText: '记一组' },
      {
        id: `${tidR33}:${segR33}:2`,
        threadId: tidR33,
        segmentId: segR33,
        seq: 2,
        createdAt: NOW + 1,
        kind: 'assistant',
        assistantText: '',
        reasoningText: 'orig-route-r',
        toolCalls: [{ id: 'call-r33-sum', index: 0, name: 'record_active_set', argumentsText: '{}' }],
      },
    ]);
    await savePendingTurnStrict(pendingR33);
    await saveCoachProviderConfig(routeACfg);

    const fetchedUrls: string[] = [];
    vi.stubGlobal('fetch', async (url: unknown) => {
      fetchedUrls.push(String(url));
      return sseOpenAIText('原路由恢复完成');
    });

    // 当前活跃配置传 Route B，但恢复仍须走原 Route A（api.deepseek.com）
    const resumed = await resumePendingCoachTurn({
      threadId: tidR33,
      pendingTurn: pendingR33,
      providerConfig: routeBCfg,
      toolContext: { activeSession: (await getSession(session.id))!, activeThreadId: tidR33 },
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.receipts).toHaveLength(1);
    expect(fetchedUrls[0]).toContain('api.deepseek.com');
    expect(await listPendingTurns(tidR33)).toHaveLength(0);
  });

  it('6. Codex 断点回归：无关线程并发异步写入 messages 保留、活跃 manualCompaction 压过一拍旧 params.contextSummary、同路由合法 thinking 切段保留护栏且不带工具轨迹', async () => {
    // 6a. 异步压缩期间无关线程 B 写入新消息 -> commitManualCompactionInVault 仅单事务局部更新本线程，不得清库覆盖 B
    const { session } = await seedSession('sess-s3-breakpoints');
    await saveCoachProviderConfig(routeACfg);
    const tidA = 'thread-bp-a';
    const tidB = 'thread-bp-b';
    await saveCoachThreadsState({
      activeThreadId: tidA,
      threads: [
        { id: tidA, title: 'A', createdAt: NOW, updatedAt: NOW },
        { id: tidB, title: 'B', createdAt: NOW, updatedAt: NOW },
      ],
    });
    const msgsA: CoachStoredMessage[] = [
      { id: 'bp-a1', threadId: tidA, role: 'user', createdAt: NOW, text: 'A早1' },
      { id: 'bp-a2', threadId: tidA, role: 'assistant', createdAt: NOW + 1, text: 'A早2' },
      { id: 'bp-a3', threadId: tidA, role: 'user', createdAt: NOW + 2, text: 'A尾1 NEW_TAIL_S1' },
      { id: 'bp-a4', threadId: tidA, role: 'assistant', createdAt: NOW + 3, text: 'A尾2 NEW_TAIL_S2' },
    ];
    const msgBInit: CoachStoredMessage = {
      id: 'bp-b1',
      threadId: tidB,
      role: 'user',
      createdAt: NOW + 4,
      text: 'B初始消息',
    };
    await saveCoachMessages([...msgsA, msgBInit]);

    let releaseSummaryFetch!: () => void;
    const summaryHold = new Promise<void>((r) => {
      releaseSummaryFetch = r;
    });
    vi.stubGlobal('fetch', async () => {
      await summaryHold;
      return sseOpenAIText('BOUND_FRESH_SUMMARY_909');
    });

    const compactPromiseA = executeManualContextCompaction({
      threadId: tidA,
      messages: msgsA,
      existingSummary: 'STALE_OLD_UI_SUMMARY_101',
      providerConfig: routeACfg,
    });

    // 等待进入在线摘要请求后，模拟无关线程 B 在提交前异步落库一条新消息
    await Promise.resolve();
    await saveCoachMessages([
      ...msgsA,
      msgBInit,
      { id: 'bp-b2-concurrent', threadId: tidB, role: 'user', createdAt: NOW + 5, text: 'B并发新消息必须保留' },
    ]);
    releaseSummaryFetch();

    const compactResA = await compactPromiseA;
    expect(compactResA.committed).toBe(true);
    const msgsAfterConcurrent = await loadCoachMessages();
    expect(msgsAfterConcurrent.some((m) => m.id === 'bp-b2-concurrent' && m.text === 'B并发新消息必须保留')).toBe(true);
    expect(msgsAfterConcurrent.find((m) => m.id === 'bp-a1')?.compressed).toBe(true);
    expect(msgsAfterConcurrent.find((m) => m.id === 'bp-a3')?.compressed).toBeFalsy();

    // 6b. 即使调用方 UI 仍传回一拍旧的 params.contextSummary='STALE_OLD_UI_SUMMARY_101'，
    //     因存在活跃 manualCompaction，出站仍必须使用与之绑定的 BOUND_FRESH_SUMMARY_909 + 新尾部整对出站
    let outboundPair = '';
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      outboundPair = String(init?.body ?? '{}');
      return sseOpenAIText('新摘要+新尾部整对已收到');
    });
    await runCoachTurn({
      threadId: tidA,
      userText: 'UI带了旧摘要参数测试',
      history: msgsA,
      contextSummary: 'STALE_OLD_UI_SUMMARY_101',
      providerConfig: routeACfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: session, activeThreadId: tidA },
      streamChunkDelayMs: 0,
    });
    expect(outboundPair).toContain('BOUND_FRESH_SUMMARY_909');
    expect(outboundPair).not.toContain('STALE_OLD_UI_SUMMARY_101');
    expect(countOccurrences(outboundPair, 'NEW_TAIL_S1')).toBe(1);
    expect(countOccurrences(outboundPair, 'NEW_TAIL_S2')).toBe(1);

    // 6c. 同路由下若碰巧触发合法 thinking_replay_boundary 切段，保留护栏（不携带旧段工具轨迹），同时承接纯文本鲜明角色引用与绑定摘要
    const tidThink = 'thread-bp-thinking-guard';
    const segThinkOld = 'seg-think-old';
    const epoch = await getCoachRestoreEpoch();
    await saveCoachThreadsState({
      ...(await loadCoachThreadsState()),
      activeThreadId: tidThink,
      threads: [
        ...(await loadCoachThreadsState()).threads,
        {
          id: tidThink,
          title: '同路由思考切段',
          createdAt: NOW,
          updatedAt: NOW,
          contextSummary: 'THINK_BOUNDARY_SUMMARY_555',
          manualCompaction: {
            compactionId: 'mc-think-555',
            summary: 'THINK_BOUNDARY_SUMMARY_555',
            summaryHash: 'ht',
            keptMessages: [
              { id: 'tk-1', role: 'user', createdAt: NOW + 3, text: 'THINK_KEPT_U1' },
              { id: 'tk-2', role: 'assistant', createdAt: NOW + 4, text: 'THINK_KEPT_A2' },
            ],
            createdAt: NOW + 4,
          },
          activeSegmentId: segThinkOld,
          segments: {
            [segThinkOld]: {
              segmentId: segThinkOld,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: epoch,
              deploymentId: computeDeploymentId(routeACfg),
              providerKind: routeACfg.kind,
              baseUrl: routeACfg.baseUrl,
              model: routeACfg.model,
              thinkingModeKey: 'off',
              baselineSnapshotJson: 'old-no-thinking',
              baselineSnapshotHash: 'h-no-th',
              nextSeq: 5,
              containsAssistantWithoutReasoning: true,
            },
          },
        },
      ],
    });
    await appendProtocolEntriesStrict([
      { id: `${tidThink}:${segThinkOld}:1`, threadId: tidThink, segmentId: segThinkOld, seq: 1, createdAt: NOW, kind: 'user', wireText: '早期' },
      {
        id: `${tidThink}:${segThinkOld}:2`,
        threadId: tidThink,
        segmentId: segThinkOld,
        seq: 2,
        createdAt: NOW + 1,
        kind: 'assistant',
        assistantText: '',
        toolCalls: [{ id: 'tk-old-call', index: 0, name: 'record_active_set', argumentsText: '{"reps":5}' }],
      },
      {
        id: `${tidThink}:${segThinkOld}:3`,
        threadId: tidThink,
        segmentId: segThinkOld,
        seq: 3,
        createdAt: NOW + 2,
        kind: 'tool',
        toolCallId: 'tk-old-call',
        toolName: 'record_active_set',
        toolResultText: JSON.stringify({ ok: true, summary: 'FORBIDDEN_OLD_TOOL_TRACE_TK' }),
      },
      {
        id: `${tidThink}:${segThinkOld}:4`,
        threadId: tidThink,
        segmentId: segThinkOld,
        seq: 4,
        createdAt: NOW + 3,
        kind: 'assistant',
        assistantText: '无推理旧回复',
      },
    ]);

    let thinkOutbound = '';
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      thinkOutbound = String(init?.body ?? '{}');
      return sseOpenAIText('切思考段后正常响应', 'thinking-new-segment-reason');
    });
    await runCoachTurn({
      threadId: tidThink,
      userText: '切高思考继续',
      history: [{ id: 'tk-1', threadId: tidThink, role: 'user', createdAt: NOW + 3, text: 'THINK_KEPT_U1' }],
      providerConfig: routeACfg,
      thinkingDepth: 'high',
      toolContext: { activeSession: session, activeThreadId: tidThink },
      streamChunkDelayMs: 0,
    });
    const thinkAfter = (await loadCoachThreadsState()).threads.find((t) => t.id === tidThink)!;
    const thinkNewSeg = thinkAfter.segments?.[thinkAfter.activeSegmentId!]!;
    expect(thinkNewSeg.reason).toBe('thinking_replay_boundary');
    expect(thinkNewSeg.containsAssistantWithoutReasoning).toBeFalsy();
    expect(thinkOutbound).not.toContain('FORBIDDEN_OLD_TOOL_TRACE_TK');
    expect(thinkOutbound).not.toContain('tk-old-call');
    expect(thinkOutbound).toContain('THINK_BOUNDARY_SUMMARY_555');
    expect(countOccurrences(thinkOutbound, 'THINK_KEPT_U1')).toBe(1);
    expect(countOccurrences(thinkOutbound, 'THINK_KEPT_A2')).toBe(1);
  });
});
