/* MOTION 第一批修复 · 阶段 #5（记忆分块与稳定 tie-break）、#6B（计费来源区分与口径重算）、明确禁搜（阻止独立检索且保持 16 工具不变）回归 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { getSession, savePlan } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import {
  isExplicitNoSearchCommand,
  reconcileStaleBillingTotalsInVault,
  runCoachTurn,
  shouldRunIndependentSearch,
} from '../src/coach/coachAgent';
import {
  billingTotalsFromRecords,
  isExternalSearchBillingRecord,
  normalizeUsageToBillingRecord,
  summarizeBillingRecords,
} from '../src/coach/coachBilling';
import {
  formatCoachMemoryForPrompt,
  saveCoachMemory,
  type CoachMemoryStore,
} from '../src/coach/coachMemory';
import { buildFrozenSegmentBaseline, sortToolDefinitionsStably } from '../src/coach/coachPrompt';
import { COACH_TOOL_DEFINITIONS } from '../src/coach/coachTools';
import {
  DEFAULT_COACH_THREAD_ID,
  getCoachRestoreEpoch,
  listBillingRecords,
  loadCoachThreadsState,
  resetCoachVaultForTest,
  saveBillingRecordStrict,
  saveCoachProviderConfig,
  saveCoachThreadsState,
  type CoachBillingRecord,
  type CoachStoredProviderConfig,
} from '../src/coach/coachStorage';
import { resolveProviderCapabilities } from '../src/coach/providerCapabilities';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_770_000_000_000;

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
  const base = createV32Plan(NOW);
  const plan: Plan = {
    ...base,
    id: `plan-${sessionId}`,
    name: '阶段5-6B合成计划',
    days: [base.days[0]],
    cursor: 0,
  };
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = { ...raw, id: sessionId };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-s56');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-s56',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh };
}

function sseOpenAiMeasured(text: string, hitTokens = 1000, missTokens = 200, outTokens = 40): Response {
  const enc = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'r' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: hitTokens + missTokens,
        prompt_cache_hit_tokens: hitTokens,
        prompt_cache_miss_tokens: missTokens,
        completion_tokens: outTokens,
        total_tokens: hitTokens + missTokens + outTokens,
      },
    })}\n\n`,
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

const dsCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'openai-compatible',
  presetId: 'deepseek-official',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-flash',
  thinkingDepth: 'high',
  webSearchProvider: 'builtin',
  apiKey: 'sk-synth-ds',
  updatedAt: NOW,
};

const gemCfg: CoachStoredProviderConfig = {
  key: 'provider',
  kind: 'gemini',
  presetId: 'gemini-official',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-flash',
  thinkingDepth: 'off',
  webSearchProvider: 'builtin',
  apiKey: 'gm-synth-key',
  updatedAt: NOW,
};

describe('MOTION 第一批修复 · #5 / #6B / 明确禁搜', () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('#5：长期记忆保持分类块归属不散、同时间戳打乱输入出站完全一致、预算裁剪下置顶优先且不改已有冻结段', async () => {
    const storeA: CoachMemoryStore = {
      version: 1,
      updatedAt: NOW,
      items: [
        { id: 'mem-1', category: 'injury', title: '左肩保护', content: 'INJ_ITEM_1 大重量前先热身', source: 'user', createdAt: NOW, updatedAt: NOW },
        { id: 'mem-2', category: 'equipment', title: '家用哑铃', content: 'EQP_ITEM_2 步进2.5kg', source: 'user', createdAt: NOW, updatedAt: NOW },
        { id: 'mem-3', category: 'injury', title: '右膝注意事项', content: 'INJ_ITEM_3 避免弹震到底', source: 'coach', createdAt: NOW, updatedAt: NOW },
        { id: 'mem-4', category: 'equipment', title: '史密斯杆重', content: 'EQP_ITEM_4 空杆15kg', source: 'coach', createdAt: NOW, updatedAt: NOW },
        { id: 'mem-pinned', category: 'habit', title: '核心置顶约定', content: 'PINNED_OLD_TS_MUST_KEEP', source: 'user', pinned: true, createdAt: NOW - 10_000, updatedAt: NOW - 10_000 },
      ],
    };
    const storeShuffled: CoachMemoryStore = {
      ...storeA,
      items: [storeA.items[3], storeA.items[1], storeA.items[4], storeA.items[2], storeA.items[0]],
    };

    const formattedA = formatCoachMemoryForPrompt(storeA, 1200);
    const formattedB = formatCoachMemoryForPrompt(storeShuffled, 1200);
    expect(formattedA).toBe(formattedB);

    // 验证分类头与各自条目同块紧邻、绝不跨块被打散
    const blockIdxInjury = formattedA.indexOf('【伤病避让】');
    const blockIdxEquip = formattedA.indexOf('【器械环境】');
    expect(blockIdxInjury).toBeGreaterThan(-1);
    expect(blockIdxEquip).toBeGreaterThan(-1);
    const injSectionMatch = formattedA.match(/【伤病避让】\n([\s\S]*?)(?=\n【|$)/);
    const eqpSectionMatch = formattedA.match(/【器械环境】\n([\s\S]*?)(?=\n【|$)/);
    expect(injSectionMatch?.[1]).toContain('INJ_ITEM_1');
    expect(injSectionMatch?.[1]).toContain('INJ_ITEM_3');
    expect(injSectionMatch?.[1]).not.toContain('EQP_ITEM_');
    expect(eqpSectionMatch?.[1]).toContain('EQP_ITEM_2');
    expect(eqpSectionMatch?.[1]).toContain('EQP_ITEM_4');
    expect(eqpSectionMatch?.[1]).not.toContain('INJ_ITEM_');

    // 验证预算裁剪下旧时间戳的置顶项仍优先保留
    const tightPrompt = formatCoachMemoryForPrompt(storeShuffled, 90);
    expect(tightPrompt).toContain('PINNED_OLD_TS_MUST_KEEP');

    // buildFrozenSegmentBaseline 不应做扁平逐行排序破坏分类归属
    const baseline = buildFrozenSegmentBaseline({
      roCtx: { activeSession: null, plans: [], cardioPresets: [], historySessions: [], totalCompletedSessions: 0 },
      memoryPrompt: formattedA,
      reason: 'initial',
    });
    expect(baseline).toContain(formattedA);

    // 真实模拟 runCoachTurn 对比两种输入顺序（同一主库训练快照）：出站 baseline 字节完全一致
    const { session: fixedSession } = await seedSession('sess-s5-fixed');
    const sendWithOrder = async (store: CoachMemoryStore): Promise<string> => {
      await resetCoachVaultForTest();
      __resetDbHandle();
      await acquireSessionLock(fixedSession.id, 'editor-s56');
      registerSessionRuntime({
        sessionId: fixedSession.id,
        editorId: 'editor-s56',
        awaitPendingWrites: async () => undefined,
        applyCommittedSession: () => undefined,
        hasBlockingDrafts: () => false,
        startRestTimer: () => undefined,
        stopRestTimer: () => undefined,
      });
      await saveCoachMemory(store);
      let body = '';
      vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
        body = String(init?.body ?? '{}');
        return sseOpenAiMeasured('已了解你的记忆。');
      });
      await runCoachTurn({
        threadId: DEFAULT_COACH_THREAD_ID,
        userText: '今天开始吧',
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: fixedSession, activeThreadId: DEFAULT_COACH_THREAD_ID },
        streamChunkDelayMs: 0,
      });
      return body;
    };

    const bodyOrderA = await sendWithOrder(storeA);
    const bodyOrderB = await sendWithOrder(storeShuffled);
    const baselineA = (JSON.parse(bodyOrderA).messages as Array<{ content: string }>)[1].content;
    const baselineB = (JSON.parse(bodyOrderB).messages as Array<{ content: string }>)[1].content;
    expect(baselineA).toBe(baselineB);
    expect(baselineA).toContain(formattedA);

    // 已有冻结段不能下迁移被偷偷改写
    const legacyFrozenSegId = 'seg-legacy-frozen-untouched';
    await saveCoachThreadsState({
      activeThreadId: DEFAULT_COACH_THREAD_ID,
      threads: [
        {
          id: DEFAULT_COACH_THREAD_ID,
          title: '默认对话',
          createdAt: NOW,
          updatedAt: NOW,
          activeSegmentId: legacyFrozenSegId,
          segments: {
            [legacyFrozenSegId]: {
              segmentId: legacyFrozenSegId,
              startedAt: NOW,
              reason: 'initial',
              restoreEpoch: await getCoachRestoreEpoch(),
              deploymentId: 'openai-compatible:api.deepseek.com:deepseek-flash',
              providerKind: 'openai-compatible',
              baseUrl: dsCfg.baseUrl,
              model: dsCfg.model,
              thinkingModeKey: 'high',
              baselineSnapshotJson: 'LEGACY_PREEXISTING_FROZEN_BASELINE_TEXT',
              baselineSnapshotHash: 'legacy-h',
              nextSeq: 1,
            },
          },
        },
      ],
    });
    const afterCheck = (await loadCoachThreadsState()).threads[0].segments?.[legacyFrozenSegId];
    expect(afterCheck?.baselineSnapshotJson).toBe('LEGACY_PREEXISTING_FROZEN_BASELINE_TEXT');
  });

  it('#6B：独立外部检索不拉低模型缓存与费用口径；Gemini 原生联网缺 usage 仍入模型 unknown；旧记录仅可靠证据归类且重开会话重算不沿用旧缓存', async () => {
    // 1. 真实运行一次 DeepSeek（含 builtin 外部检索 + 实测模型回合）
    const { session } = await seedSession('sess-s6b-ext');
    await saveCoachProviderConfig(dsCfg);
    vi.stubGlobal('fetch', async (url: unknown) => {
      const u = String(url);
      if (u.includes('duckduckgo.com')) {
        return new Response(
          '<a class="result__a" href="https://example.org/squat">深蹲动作指南</a><span class="result__snippet">核心收紧，膝盖与脚尖同向。</span>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      return sseOpenAiMeasured('已结合权威检索给出建议。', 1200, 300, 50);
    });

    const turnRes = await runCoachTurn({
      threadId: DEFAULT_COACH_THREAD_ID,
      userText: '帮我查一下深蹲动作要点',
      history: [],
      webSearch: true,
      providerConfig: dsCfg,
      toolContext: { activeSession: session, activeThreadId: DEFAULT_COACH_THREAD_ID },
      streamChunkDelayMs: 0,
    });
    expect(turnRes.text).toContain('权威检索');

    const bills = await listBillingRecords(DEFAULT_COACH_THREAD_ID);
    expect(bills).toHaveLength(2);
    const extBill = bills.find((b) => b.requestSource === 'external_search')!;
    const modelBill = bills.find((b) => b.requestSource === 'model')!;
    expect(extBill.searchProvider).toBe('builtin');
    expect(modelBill.source).toBe('measured');

    const threadAfter = (await loadCoachThreadsState()).threads[0];
    const bt = threadAfter.billingTotals!;
    // 独立外部检索不计入模型 requests / unknownUsage / cacheDetail，且模型命中率精确保持 1200/1500 = 80%
    expect(bt.requests).toBe(1);
    expect(bt.externalSearchRequests).toBe(1);
    expect(bt.unknownUsageRequests).toBe(0);
    expect(bt.unknownCacheDetailRequests).toBe(0);
    expect(bt.cachedInputTokens).toBe(1200);
    expect(bt.uncachedInputTokens).toBe(300);
    expect(bt.currency).toBe('CNY');
    expect(bt.totalCostUsd).toBeGreaterThan(0);
    expect(bt.summarySchemaVersion).toBe(2);

    // 2. Gemini 原生联网真实模型请求（即使返回缺 usage），仍必须进入模型口径并拉出 unknown
    await resetAll();
    const { session: gemSess } = await seedSession('sess-s6b-gemini-nousage');
    await saveCoachProviderConfig(gemCfg);
    let gemCalls = 0;
    vi.stubGlobal('fetch', async () => {
      gemCalls += 1;
      if (gemCalls === 1) {
        // Gemini 原生联网：刻意不附带 usageMetadata
        return new Response(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini 原生检索要点：保持脊柱中立。' }] }, finishReason: 'STOP' }],
          })}\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      // 主模型回合带 usageMetadata
      return new Response(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: '已总结。' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 250, candidatesTokenCount: 30, totalTokenCount: 530 },
        })}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    await runCoachTurn({
      threadId: DEFAULT_COACH_THREAD_ID,
      userText: '帮我查一下硬拉动作要点',
      history: [],
      webSearch: true,
      providerConfig: gemCfg,
      toolContext: { activeSession: gemSess, activeThreadId: DEFAULT_COACH_THREAD_ID },
      streamChunkDelayMs: 0,
    });
    const gemBills = await listBillingRecords(DEFAULT_COACH_THREAD_ID);
    expect(gemBills).toHaveLength(2);
    expect(gemBills.every((b) => b.requestSource === 'model' && !isExternalSearchBillingRecord(b))).toBe(true);
    const gemTotals = (await loadCoachThreadsState()).threads[0].billingTotals!;
    expect(gemTotals.requests).toBe(2);
    expect(gemTotals.externalSearchRequests).toBeUndefined();
    expect(gemTotals.unknownUsageRequests).toBe(1);
    expect(gemTotals.totalCostUsd).toBeNull();

    // 3. 旧记录分类：
    //    - 缺 usage 的旧 Gemini 原生 web_search（即使带 durationMs）与来源不可确认的旧 Gemini 记录，必须保守视为模型请求；
    //    - 非 Gemini 已知协议（如 DeepSeek）且 round=0 / 无 turnId / 无 durationMs / 无 rawUsage / source='unknown' 的旧 web_search 形状可确证为独立外部检索，并在重算后停止污染；
    const dsCaps = resolveProviderCapabilities(dsCfg);
    const legacyGeminiNativeNoUsage: CoachBillingRecord = {
      ...normalizeUsageToBillingRecord({
        id: 'legacy-gem-native-nousage',
        threadId: 'thread-legacy-gem',
        segmentId: 'seg-1',
        round: 0,
        purpose: 'web_search',
        capabilities: resolveProviderCapabilities(gemCfg),
        durationMs: 120,
      }),
    };
    delete legacyGeminiNativeNoUsage.requestSource;
    expect(isExternalSearchBillingRecord(legacyGeminiNativeNoUsage)).toBe(false);

    const legacyGeminiAmbiguousNoDuration: CoachBillingRecord = {
      ...normalizeUsageToBillingRecord({
        id: 'legacy-gem-ambiguous',
        threadId: 'thread-legacy-gem',
        segmentId: 'seg-1',
        round: 0,
        purpose: 'web_search',
        capabilities: resolveProviderCapabilities(gemCfg),
      }),
    };
    delete legacyGeminiAmbiguousNoDuration.requestSource;
    expect(isExternalSearchBillingRecord(legacyGeminiAmbiguousNoDuration)).toBe(false);

    const legacyDeepSeekExtShape: CoachBillingRecord = {
      ...normalizeUsageToBillingRecord({
        id: 'legacy-ds-ext-shape',
        threadId: 'thread-legacy-bill',
        segmentId: 'seg-1',
        round: 0,
        purpose: 'web_search',
        capabilities: dsCaps,
      }),
    };
    delete legacyDeepSeekExtShape.requestSource;
    // 无 requestSource 且无 searchProvider，仅符合 v0.2.3 DeepSeek 独立外部检索固定形状
    expect(legacyDeepSeekExtShape.searchProvider).toBeUndefined();
    expect(isExternalSearchBillingRecord(legacyDeepSeekExtShape)).toBe(true);

    const dsMeasuredModel = normalizeUsageToBillingRecord({
      id: 'bill-ds-clean',
      threadId: 'thread-legacy-bill',
      segmentId: 'seg-1',
      round: 0,
      purpose: 'coach_turn',
      capabilities: dsCaps,
      rawUsage: {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 800,
        prompt_cache_miss_tokens: 200,
        completion_tokens: 20,
      },
    });
    const reportMixed = summarizeBillingRecords([legacyDeepSeekExtShape, dsMeasuredModel]);
    expect(reportMixed.requests).toBe(1);
    expect(reportMixed.externalSearchRequests).toBe(1);
    expect(reportMixed.unknownUsageRequests).toBe(0);
    expect(reportMixed.cacheHitRate).toBeCloseTo(0.8, 6);
    expect(reportMixed.totalCost).toBeCloseTo(dsMeasuredModel.computedCostUsd!, 6);

    // 模拟 Vault 中持久化着旧口径（无 summarySchemaVersion，被旧 DeepSeek 外部检索记录拉低成 requests: 2, unknownUsageRequests: 1）
    await saveBillingRecordStrict(legacyDeepSeekExtShape);
    await saveBillingRecordStrict(dsMeasuredModel);
    await saveCoachThreadsState({
      activeThreadId: 'thread-legacy-bill',
      threads: [
        {
          id: 'thread-legacy-bill',
          title: '旧口径重算测试',
          createdAt: NOW,
          updatedAt: NOW,
          billingTotals: {
            ...billingTotalsFromRecords([dsMeasuredModel]),
            summarySchemaVersion: undefined,
            requests: 2,
            unknownUsageRequests: 1,
            unknownCacheDetailRequests: 1,
            totalCostUsd: null,
          },
        },
      ],
    });
    const reconciled = await reconcileStaleBillingTotalsInVault();
    expect(reconciled.changed).toBe(true);
    const healed = reconciled.state.threads.find((t) => t.id === 'thread-legacy-bill')!.billingTotals!;
    expect(healed.summarySchemaVersion).toBe(2);
    expect(healed.requests).toBe(1);
    expect(healed.externalSearchRequests).toBe(1);
    expect(healed.unknownUsageRequests).toBe(0);
    expect(healed.totalCostUsd).toBeCloseTo(dsMeasuredModel.computedCostUsd!, 6);

    // 缺 usage 的旧 Gemini 原生联网账保持保守进入模型 unknown 口径
    const gemLegacyReport = summarizeBillingRecords([legacyGeminiNativeNoUsage]);
    expect(gemLegacyReport.requests).toBe(1);
    expect(gemLegacyReport.externalSearchRequests).toBe(0);
    expect(gemLegacyReport.unknownUsageRequests).toBe(1);
    expect(gemLegacyReport.totalCost).toBeNull();

    // UI 标签源码契约（含「模型用量与费用」与外部检索单列，不含 B5/Harness）
    const paneSrc = readFileSync(resolve(process.cwd(), 'src/coach/CoachPane.tsx'), 'utf8');
    expect(paneSrc).toContain('模型用量与费用（');
    expect(paneSrc).toContain('coach-context-external-search-billing');
  });

  it('明确禁搜：不用/不要/无需/别联网优先阻止任何独立检索，地球关=0 检索，普通否定训练词不误伤，且主模型 16 工具名称/顺序/定义完全一致', async () => {
    // 1. 纯规则语义边界核验
    expect(isExplicitNoSearchCommand('深蹲动作要点，不用联网')).toBe(true);
    expect(isExplicitNoSearchCommand('不要联网，帮我查一下蛋白粉')).toBe(true);
    expect(isExplicitNoSearchCommand('无需联网搜索硬拉注意事项')).toBe(true);
    expect(isExplicitNoSearchCommand('别联网，直接回答')).toBe(true);

    expect(shouldRunIndependentSearch('深蹲动作要点，不用联网')).toBe(false);
    expect(shouldRunIndependentSearch('不要联网，帮我查一下蛋白粉')).toBe(false);
    expect(shouldRunIndependentSearch('无需联网搜索硬拉注意事项')).toBe(false);
    expect(shouldRunIndependentSearch('别联网，直接回答')).toBe(false);
    // 普通训练否定句（未否定联网/搜索）仍保留原有搜索召回
    expect(shouldRunIndependentSearch('不用器材怎么练背，帮我查一下动作要点')).toBe(true);
    expect(shouldRunIndependentSearch('不要太重，搜一下硬拉注意事项')).toBe(true);

    // 2. 真实端到端 mock fetch 验证：开地球 + 明确禁搜（分别在 builtin 与 Gemini 原生下验证 0 外部/0 联网检索）
    const expectedToolNames = sortToolDefinitionsStably(COACH_TOOL_DEFINITIONS).map((t) => t.name);
    expect(expectedToolNames).toHaveLength(16);

    const captureTurnToolsAndSearchCalls = async (opts: {
      cfg: CoachStoredProviderConfig;
      webSearch: boolean;
      userText: string;
      sid: string;
    }) => {
      await resetAll();
      const { session } = await seedSession(opts.sid);
      const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
      vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        let parsed: Record<string, unknown> | null = null;
        if (init?.body) {
          try {
            parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        calls.push({ url: u, body: parsed });
        if (u.includes('duckduckgo.com')) {
          return new Response(
            '<a class="result__a" href="https://example.org/x">x</a><span class="result__snippet">hit</span>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        }
        if (opts.cfg.kind === 'gemini') {
          return new Response(
            `data: ${JSON.stringify({
              candidates: [{ content: { role: 'model', parts: [{ text: '直答完成' }] }, finishReason: 'STOP' }],
            })}\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        return sseOpenAiMeasured('直答完成');
      });

      await runCoachTurn({
        threadId: DEFAULT_COACH_THREAD_ID,
        userText: opts.userText,
        history: [],
        webSearch: opts.webSearch,
        providerConfig: opts.cfg,
        toolContext: { activeSession: session, activeThreadId: DEFAULT_COACH_THREAD_ID },
        streamChunkDelayMs: 0,
      });
      return calls;
    };

    // DeepSeek + builtin，开启地球 + 「不用联网」 -> 仅有 1 次主模型请求，0 检索请求
    const dsNoSearch = await captureTurnToolsAndSearchCalls({
      cfg: dsCfg,
      webSearch: true,
      userText: '帮我查一下深蹲动作要点，不用联网',
      sid: 'sess-ns-ds-on',
    });
    expect(dsNoSearch).toHaveLength(1);
    expect(dsNoSearch[0].url).toContain('api.deepseek.com');
    const toolsNoSearch = (dsNoSearch[0].body?.tools as Array<{ function: { name: string } }>) ?? [];
    expect(toolsNoSearch.map((t) => t.function.name)).toEqual(expectedToolNames);

    // 地球关闭 -> 0 检索请求，且 16 工具名称/顺序/定义一致
    const dsGlobeOff = await captureTurnToolsAndSearchCalls({
      cfg: dsCfg,
      webSearch: false,
      userText: '帮我查一下深蹲动作要点',
      sid: 'sess-ns-ds-off',
    });
    expect(dsGlobeOff).toHaveLength(1);
    expect(dsGlobeOff[0].body?.tools).toEqual(dsNoSearch[0].body?.tools);

    // 地球开启 + 允许检索（对照主请求 16 工具亦完全相同）
    const dsGlobeOnAllowed = await captureTurnToolsAndSearchCalls({
      cfg: dsCfg,
      webSearch: true,
      userText: '帮我查一下深蹲动作要点',
      sid: 'sess-ns-ds-allow',
    });
    const mainModelCallOn = dsGlobeOnAllowed.find((c) => c.url.includes('api.deepseek.com'))!;
    expect(dsGlobeOnAllowed.some((c) => c.url.includes('duckduckgo.com'))).toBe(true);
    expect(mainModelCallOn.body?.tools).toEqual(dsNoSearch[0].body?.tools);

    // Gemini 原生联网开启地球 + 「不要联网」 -> 仅 1 次主模型请求，不含 google_search
    const gemNoSearch = await captureTurnToolsAndSearchCalls({
      cfg: gemCfg,
      webSearch: true,
      userText: '硬拉标准动作要点，不要联网',
      sid: 'sess-ns-gem-on',
    });
    expect(gemNoSearch).toHaveLength(1);
    const gemBodyStr = JSON.stringify(gemNoSearch[0].body);
    expect(gemBodyStr).not.toContain('google_search');
  });
});
