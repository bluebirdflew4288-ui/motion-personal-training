/* v0.2.3 三协议（DeepSeek 官方 / 阿里百炼 DeepSeek / OpenAI & 反代 / Anthropic Messages / Gemini GenerateContent）、
   3 层静态前缀不变性、突破 200/240 截断边界、Delta 增量、经济压缩与独立计费回归套件。 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import { getSession, savePlan } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import {
  compressCoachContext,
  purgeDeletedAttachmentFromCoachHistory,
  purgeDeletedMemoryFromCoachHistory,
  runCoachTurn,
  suggestCoachTitle,
} from '../src/coach/coachAgent';
import {
  normalizeUsageToBillingRecord,
  summarizeBillingRecords,
} from '../src/coach/coachBilling';
import {
  checkHardContextBudget,
  evaluateEconomicCompaction,
} from '../src/coach/coachContext';
import { createEmptyCoachMemory, saveCoachMemory, upsertCoachMemoryItem } from '../src/coach/coachMemory';
import { STATIC_COACH_SYSTEM_PROMPT } from '../src/coach/coachPrompt';
import {
  DEFAULT_COACH_THREAD_ID,
  appendProtocolEntriesStrict,
  listBillingRecords,
  listPendingTurns,
  listProtocolEntries,
  loadCoachMessages,
  loadCoachThreadsState,
  patchCoachThreadUiFields,
  replaceProtocolEntriesForThread,
  resetCoachVaultForTest,
  saveCoachMessages,
  saveCoachThreadsState,
  saveCoachThreadsUiLayout,
  savePendingTurnStrict,
  type CoachPendingTurn,
  type CoachStoredProviderConfig,
} from '../src/coach/coachStorage';
import { undoCoachReceipt } from '../src/coach/coachTx';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import {
  buildAnthropicRequest,
  buildGeminiRequest,
  buildOpenAICompatibleRequest,
} from '../src/coach/providerAdapter';
import {
  isDeepSeekOfficialPeakWindow,
  resolveProviderCapabilities,
} from '../src/coach/providerCapabilities';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_766_500_000_000;

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

function makeWidePlan(): Plan {
  const base = createV32Plan(NOW);
  const d0 = base.days[0];
  // 扩充到 10+ 组，便于真实跑满 10 组记组剧本
  const wideDay: Plan['days'][number] = {
    ...d0,
    exercises: d0.exercises.map((e, idx) =>
      idx === 0
        ? { ...e, target: { ...e.target, sets: 10, setsMax: 10 } }
        : e,
    ),
  };
  return {
    ...base,
    id: 'plan-v023-cache',
    name: 'v023 缓存与协议测试计划',
    days: [wideDay],
    cursor: 0,
  };
}

async function seedWideActive(sessionId = 'sess-cache-1'): Promise<{ plan: Plan; session: Session }> {
  const plan = makeWidePlan();
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = { ...raw, id: sessionId };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-cache');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-cache',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return { plan, session: fresh };
}

function makeSse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of chunks) c.enqueue(enc.encode(l));
        c.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('MOTION v0.2.3 三协议适配、前缀缓存不变性与独立经济计费', () => {
  beforeEach(async () => {
    await resetEverything();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. DeepSeek 官方与阿里百炼 DeepSeek：真部署定价/视觉能力、显式断点禁发、reasoning_content 跨轮全重放、off->high 切段，以及 OpenAI/反代差异化字段', async () => {
    const dsFlashPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      pricingWindowOverride: 'peak',
    });
    const dsFlashOffPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      pricingWindowOverride: 'off_peak',
    });
    const dsProPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      pricingWindowOverride: 'peak',
    });
    const dsProOffPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      pricingWindowOverride: 'off_peak',
    });
    const dsRetired = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    });
    const bailianPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'bailian-deepseek',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'deepseek-v4.1-flash-1017',
      pricingWindowOverride: 'peak',
    });
    const bailianOffPeak = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'bailian-deepseek',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'deepseek-v4.1-flash-1017',
      pricingWindowOverride: 'off_peak',
    });
    const bailianV32 = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'bailian-deepseek',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'deepseek-v3.2',
    });
    const bailianIntl = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'bailian-deepseek',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      model: 'deepseek-v4.1-flash-1017',
    });
    const bailianCaps = bailianPeak;
    const oaiCaps = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'openai-official',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
    const proxyCaps = resolveProviderCapabilities({
      kind: 'openai-compatible',
      baseUrl: 'https://my-gateway.example.com/v1',
      model: 'llama-3.3-70b',
    });

    expect(dsFlashPeak.sendCacheControlBreakpoints).toBe(false);
    expect(dsFlashPeak.requiresReasoningReplayWithTools).toBe(true);
    expect(dsFlashPeak.supportsNativeVision).toBe(true);
    expect(dsFlashPeak.contextWindowTokens).toBe(1_048_576);
    expect(dsFlashPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 2,
      cachedInputPer1MTokens: 0.04,
      outputPer1MTokens: 8,
    });
    expect(dsFlashOffPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 1,
      cachedInputPer1MTokens: 0.02,
      outputPer1MTokens: 4,
    });
    expect(dsProPeak.supportsNativeVision).toBe(false);
    expect(dsProPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 9,
      cachedInputPer1MTokens: 0.3,
      outputPer1MTokens: 27,
      pricingWindow: 'peak',
    });
    expect(dsProOffPeak.supportsNativeVision).toBe(false);
    expect(dsProOffPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 4.5,
      cachedInputPer1MTokens: 0.15,
      outputPer1MTokens: 13.5,
      pricingWindow: 'off_peak',
    });
    // 2026 中国国务院法定节假日工作日全天闲时 + 正常工作日高峰 + 显式覆盖
    expect(isDeepSeekOfficialPeakWindow(Date.parse('2026-10-01T10:00:00+08:00'))).toBe(false);
    expect(isDeepSeekOfficialPeakWindow(Date.parse('2026-05-01T15:00:00+08:00'))).toBe(false);
    expect(isDeepSeekOfficialPeakWindow(Date.parse('2026-02-17T10:30:00+08:00'))).toBe(false);
    expect(isDeepSeekOfficialPeakWindow(Date.parse('2026-10-12T10:00:00+08:00'))).toBe(true);
    expect(
      isDeepSeekOfficialPeakWindow(Date.parse('2026-10-12T10:00:00+08:00'), {
        isCnHolidayOverride: true,
      }),
    ).toBe(false);
    expect(
      isDeepSeekOfficialPeakWindow(Date.parse('2026-10-01T10:00:00+08:00'), {
        isCnHolidayOverride: false,
      }),
    ).toBe(true);
    expect(dsRetired.supportsNativeVision).toBe(false);
    expect(dsRetired.pricing.currency).toBe('unknown');
    expect(dsRetired.pricing.inputPer1MTokens).toBeNull();

    expect(bailianPeak.sendCacheControlBreakpoints).toBe(false);
    expect(bailianPeak.thinkingControlStyle).toBe('bailian_enable_thinking');
    expect(bailianPeak.supportsNativeVision).toBe(true);
    expect(bailianPeak.contextWindowTokens).toBe(1_048_576);
    expect(bailianPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 2,
      cachedInputPer1MTokens: 0.04,
      outputPer1MTokens: 8,
    });
    expect(bailianOffPeak.pricing).toMatchObject({
      currency: 'CNY',
      inputPer1MTokens: 1,
      cachedInputPer1MTokens: 0.02,
      outputPer1MTokens: 4,
    });
    expect(bailianV32.pricing.currency).toBe('unknown');
    expect(bailianV32.pricing.inputPer1MTokens).toBeNull();
    expect(bailianIntl.pricing.currency).toBe('unknown');
    expect(bailianIntl.pricing.inputPer1MTokens).toBeNull();

    expect(oaiCaps.requiresReasoningReplayWithTools).toBe(false);
    expect(proxyCaps.requiresReasoningReplayWithTools).toBe(false);
    expect(proxyCaps.sendCacheControlBreakpoints).toBe(false);

    // 校验 百炼 DeepSeek 与 自定义反代 的真实请求体边界
    const bailianReq = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', presetId: 'bailian-deepseek', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'deepseek-v3.2', apiKey: 'bk' },
      [
        { role: 'system', text: 'SYS', cacheControl: 'ephemeral' },
        { role: 'user', parts: [{ type: 'text', text: 'HI' }], cacheControl: 'ephemeral' },
        { role: 'assistant', text: 'OK', reasoning: 'THINK_1' },
      ],
      [],
      { thinkingDepth: 'high', anthropicCacheControl: false, capabilities: bailianCaps },
    );
    const bailianBody = JSON.parse(String(bailianReq.init.body));
    expect(JSON.stringify(bailianBody)).not.toContain('cache_control');
    expect(bailianBody.enable_thinking).toBe(true);
    expect(bailianBody.messages[2].reasoning_content).toBe('THINK_1');

    const proxyReq = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://my-gateway.example.com/v1', model: 'llama-3.3-70b', apiKey: 'pk' },
      [
        { role: 'system', text: 'SYS' },
        { role: 'assistant', text: 'OK', reasoning: 'INTERNAL_REASON' },
      ],
      [],
      { promptCacheKey: 'k1', capabilities: proxyCaps },
    );
    const proxyBody = JSON.parse(String(proxyReq.init.body));
    expect(proxyBody.messages[1].reasoning_content).toBeUndefined();
    expect(proxyBody.prompt_cache_key).toBeUndefined();

    // OpenAI 官方携带 prompt_cache_key，但不盲注 DeepSeek reasoning_content
    const oaiReq = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', presetId: 'openai-official', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'ok' },
      [{ role: 'system', text: 'SYS' }, { role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { promptCacheKey: 'motion-oai-key', capabilities: oaiCaps },
    );
    expect(JSON.parse(String(oaiReq.init.body)).prompt_cache_key).toBe('motion-oai-key');

    // DeepSeek 官方真实 2 轮 + off->high 自动切换新段
    const { session } = await seedWideActive();
    const exId = session.exercises[0].id;
    const wireBodies: Array<{
      thinking?: { type?: string };
      messages: Array<{ role: string; reasoning_content?: string }>;
    }> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof wireBodies)[number];
      wireBodies.push(body);
      expect(JSON.stringify(body)).not.toContain('cache_control');
      const lastRole = body.messages[body.messages.length - 1]?.role;
      const callIdx = wireBodies.length;
      if (callIdx === 1 && lastRole === 'user') {
        return makeSse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'R1_TOOL',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'ds-call-1',
                      function: { name: 'record_active_set', arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }) },
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
      if (callIdx === 2) {
        return makeSse([
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: 'R1_FINAL', content: '第1组已记好。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 200 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      if (callIdx === 3) {
        return makeSse([
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: 'R2_TEXT', content: '继续保持。' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1260, completion_tokens: 10, prompt_cache_hit_tokens: 1200, prompt_cache_miss_tokens: 60 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      // 第 4 次（off 模式纯文本，无 reasoning_content）
      return makeSse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '关闭思考回复。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1280, completion_tokens: 10, prompt_cache_hit_tokens: 1200, prompt_cache_miss_tokens: 80 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const dsCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'ds-k',
      updatedAt: NOW,
    };
    const threads = await loadCoachThreadsState();
    try {
      await runCoachTurn({
        threadId: threads.activeThreadId,
        userText: '帮我记第 1 组 60kg 10次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      // 第 2 次用户轮：验证 R1_TOOL 与 R1_FINAL 全部原样回传
      await runCoachTurn({
        threadId: threads.activeThreadId,
        userText: '不错继续',
        history: [{ id: 'm1', threadId: threads.activeThreadId, role: 'user', createdAt: NOW, text: 't' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      const turn2MsgRoles = wireBodies[2].messages.map((m) => m.role);
      expect(turn2MsgRoles).toEqual(['system', 'user', 'user', 'assistant', 'tool', 'assistant', 'user']);
      expect(wireBodies[2].messages[3].reasoning_content).toBe('R1_TOOL');
      expect(wireBodies[2].messages[5].reasoning_content).toBe('R1_FINAL');
      expect(wireBodies[2].thinking).toEqual({ type: 'enabled' });

      // 从 high 切 off，再切回 high：因为中间产生了无 reasoning_content 的助手回复，切回 high 必须自动开新段防 400
      await runCoachTurn({
        threadId: threads.activeThreadId,
        userText: '关闭思考问一句',
        history: [{ id: 'm2', threadId: threads.activeThreadId, role: 'user', createdAt: NOW, text: 't' }],
        thinkingDepth: 'off',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      let switchedSegReason = '';
      await runCoachTurn({
        threadId: threads.activeThreadId,
        userText: '重新开启思考',
        history: [{ id: 'm3', threadId: threads.activeThreadId, role: 'user', createdAt: NOW, text: 't' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
        onSegmentChanged: (s) => {
          switchedSegReason = s.reason;
        },
      });
      expect(switchedSegReason).toBe('thinking_replay_boundary');
      // 新段干净从 [system, baseline, user] 起步，绝不夹带缺 reasoning_content 的旧助手轮
      expect(wireBodies[4].messages.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('2. Anthropic Messages 协议：头/顶层system/ephemeral断点(2-4个)/text0+tool_use1/thinking+signature/tool_result合并与未命中计费', async () => {
    const antCaps = resolveProviderCapabilities({
      kind: 'anthropic',
      presetId: 'anthropic-official',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514',
    });
    const reqInit = buildAnthropicRequest(
      { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', apiKey: 'ant-key' },
      [
        { role: 'system', text: 'STATIC_SYS', cacheControl: 'ephemeral' },
        { role: 'user', parts: [{ type: 'text', text: 'BASELINE' }], isSegmentBaseline: true, cacheControl: 'ephemeral' },
        { role: 'user', parts: [{ type: 'text', text: 'turn 1' }] },
        {
          role: 'assistant',
          text: '先记一下',
          anthropicBlocks: [
            { type: 'thinking', thinking: 'THK', signature: 'sig-abc-123' },
            { type: 'redacted_thinking', data: 'opaque-xyz' },
            { type: 'text', text: '先记一下' },
            { type: 'tool_use', id: 'tu_1', name: 'record_active_set', input: { reps: 10 } },
          ],
        },
        { role: 'tool', toolCallId: 'tu_1', name: 'record_active_set', content: '{"ok":true}', cacheControl: 'ephemeral' },
        { role: 'user', parts: [{ type: 'text', text: 'turn 2' }] },
      ],
      [],
      { thinkingDepth: 'high', anthropicCacheControl: true, capabilities: antCaps },
    );

    expect(reqInit.url).toBe('https://api.anthropic.com/v1/messages');
    const hdrs = reqInit.init.headers as Record<string, string>;
    expect(hdrs['x-api-key']).toBe('ant-key');
    expect(hdrs['anthropic-version']).toBe('2023-06-01');

    const parsedBody = JSON.parse(String(reqInit.init.body)) as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(parsedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // 合并后消息序列为: [0] merged user (baseline + turn 1), [1] assistant (verbatim), [2] merged user (tool_result + turn 2)
    expect(parsedBody.messages[0].role).toBe('user');
    const asstContent = parsedBody.messages[1].content;
    expect(asstContent[0]).toEqual({ type: 'thinking', thinking: 'THK', signature: 'sig-abc-123' });
    expect(asstContent[1]).toEqual({ type: 'redacted_thinking', data: 'opaque-xyz' });
    expect(parsedBody.messages[2].role).toBe('user');
    expect(parsedBody.messages[2].content[0].type).toBe('tool_result');
    expect(parsedBody.messages[2].content[1].type).toBe('text');

    // 计算总 cache_control 断点数应在 2-4 之间
    const bpMatches = JSON.stringify(parsedBody).match(/"cache_control"/g) ?? [];
    expect(bpMatches.length).toBeGreaterThanOrEqual(2);
    expect(bpMatches.length).toBeLessThanOrEqual(4);

    // 真实流端到端跑一轮：text block 0 + tool_use block 1 + usage 拆包
    const { session } = await seedWideActive();
    const exId = session.exercises[0].id;
    const antReqBodies: Array<Record<string, unknown>> = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      antReqBodies.push(b);
      if (antReqBodies.length === 1) {
        return makeSse([
          `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 50, cache_read_input_tokens: 2800, cache_creation_input_tokens: 100 } } })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'thinking', thinking: '' } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'CLAUDE_THINK' } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'signature_delta', signature: 'sig-live-99' } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ index: 1, content_block: { type: 'text', text: '' } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 1, delta: { type: 'text_delta', text: '我来帮你记。' } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ index: 1 })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({ index: 2, content_block: { type: 'tool_use', id: 'toolu_abc', name: 'record_active_set', input: {} } })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({ index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ sessionId: session.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }) } })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ index: 2 })}\n\n`,
          `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } })}\n\n`,
          `event: message_stop\ndata: {}\n\n`,
        ]);
      }
      return makeSse([
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 20, cache_read_input_tokens: 2950, cache_creation_input_tokens: 0 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: '已记好。' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })}\n\n`,
        `event: message_stop\ndata: {}\n\n`,
      ]);
    });

    try {
      const turn = await runCoachTurn({
        threadId: DEFAULT_COACH_THREAD_ID,
        userText: '记第1组60kg 10次',
        history: [],
        thinkingDepth: 'high',
        providerConfig: {
          key: 'provider',
          kind: 'anthropic',
          presetId: 'anthropic-official',
          baseUrl: 'https://api.anthropic.com/v1',
          model: 'claude-sonnet-4-20250514',
          apiKey: 'ant-live',
          updatedAt: NOW,
        },
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(turn.receipts).toHaveLength(1);
      // 第二轮传给 Claude 的 assistant 原生块（messages[1]）包含 signature
      const sentMsgs = antReqBodies[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      expect(sentMsgs[1].content[0]).toEqual({
        type: 'thinking',
        thinking: 'CLAUDE_THINK',
        signature: 'sig-live-99',
      });
      // 计费核算：input_tokens=50 为未命中普通输入，总输入 = 50 + 2800 + 100 = 2950
      const bills = await listBillingRecords(DEFAULT_COACH_THREAD_ID);
      expect(bills[0].uncachedInputTokens).toBe(50);
      expect(bills[0].cachedInputTokens).toBe(2800);
      expect(bills[0].cacheCreationInputTokens).toBe(100);
      expect(bills[0].inputTokens).toBe(2950);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('3. Gemini GenerateContent 协议：parts/thoughtSignature 原样保留、关网不带 googleSearch、无 ID 多轮防冲突', async () => {
    const reqNoSearch = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', apiKey: 'gem-k' },
      [{ role: 'system', text: 'SYS' }, { role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { webSearch: false },
    );
    expect(reqNoSearch.url).toContain(':streamGenerateContent?alt=sse');
    const bodyNoSearch = JSON.parse(String(reqNoSearch.init.body)) as { tools?: Array<Record<string, unknown>> };
    expect(bodyNoSearch.tools?.some((t) => 'googleSearch' in t)).not.toBe(true);

    // 连续两轮用户记组，每轮 Gemini 都省略 functionCall.id，靠本地 turnId:r:c 派生唯一 operationId 绝不误命中幂等重放
    const { session } = await seedWideActive('sess-gem-noid');
    const exId = session.exercises[0].id;
    const gemReqBodies: Array<Record<string, unknown>> = [];
    let gemCallSeq = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
      gemReqBodies.push(b);
      gemCallSeq += 1;
      const lastParts = b.contents[b.contents.length - 1]?.parts ?? [];
      const hasFnResp = lastParts.some((p) => 'functionResponse' in p);
      if (!hasFnResp) {
        const roundIdx = gemCallSeq <= 2 ? 1 : 2;
        return makeSse([
          `data: ${JSON.stringify({
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  parts: [
                    { text: '思索过程', thought: true, thoughtSignature: `sig-${roundIdx}` },
                    { functionCall: { name: 'record_active_set', args: { sessionId: session.id, exId, roundIndex: roundIdx, reps: 10, weightKg: 60, status: 'done' } }, thoughtSignature: `fc-sig-${roundIdx}` },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 1400, cachedContentTokenCount: 1024, candidatesTokenCount: 30, thoughtsTokenCount: 40 },
          })}\n\n`,
        ]);
      }
      return makeSse([
        `data: ${JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Gemini 已记完该组。' }] } }],
          usageMetadata: { promptTokenCount: 1450, cachedContentTokenCount: 1300, candidatesTokenCount: 12 },
        })}\n\n`,
      ]);
    });

    const gemCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'gemini',
      presetId: 'gemini-official',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      apiKey: 'gem-k',
      updatedAt: NOW,
    };
    try {
      await runCoachTurn({
        threadId: DEFAULT_COACH_THREAD_ID,
        userText: '记第1组 60kg 10次',
        history: [],
        webSearch: false,
        providerConfig: gemCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      await runCoachTurn({
        threadId: DEFAULT_COACH_THREAD_ID,
        userText: '再记第2组 60kg 10次',
        history: [{ id: 'm1', threadId: DEFAULT_COACH_THREAD_ID, role: 'user', createdAt: NOW, text: 'x' }],
        webSearch: false,
        providerConfig: gemCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      const updatedSess = (await getSession(session.id))!;
      expect(updatedSess.exercises[0].sets.filter((s) => s.status === 'done')).toHaveLength(2);
      // 续调请求中完整重放了 thoughtSignature，且未发 googleSearch
      const followupContents = gemReqBodies[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      expect(followupContents[2].parts[0].thoughtSignature).toBe('sig-1');
      expect(followupContents[2].parts[1].thoughtSignature).toBe('fc-sig-1');
      expect(JSON.stringify(gemReqBodies)).not.toContain('googleSearch');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('4. 真实 10 组 + 超 200/240 边界训练剧本：3 层静态/基线字节恒同、3 会话跨线程前缀相同、Delta 不重发与重启恢复', async () => {
    const { session } = await seedWideActive('sess-10sets');
    const exId = session.exercises[0].id;
    const threadsState = await loadCoachThreadsState();
    const tid = threadsState.activeThreadId;

    // 预植 245 条旧协议记录以直接突破旧 200/240 裁剪上限
    const segId = 'seg-long-10sets';
    const seedEntries = Array.from({ length: 245 }, (_, idx) => ({
      id: `${tid}:${segId}:${idx + 1}`,
      threadId: tid,
      segmentId: segId,
      seq: idx + 1,
      createdAt: NOW + idx,
      kind: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      ...(idx % 2 === 0
        ? { wireText: `历史对话 #${idx + 1}` }
        : { assistantText: `答复 #${idx + 1}`, reasoningText: `RT_${idx + 1}` }),
    }));
    await appendProtocolEntriesStrict(seedEntries);
    const frozenBaseline = '{"frozenBaseline":"v0.2.3-baseline"}';
    await saveCoachThreadsState({
      ...threadsState,
      threads: threadsState.threads.map((t) =>
        t.id === tid
          ? {
              ...t,
              activeSegmentId: segId,
              segments: {
                [segId]: {
                  segmentId: segId,
                  startedAt: NOW,
                  reason: 'initial',
                  restoreEpoch: 0,
                  deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
                  providerKind: 'openai-compatible',
                  model: 'deepseek-chat',
                  thinkingModeKey: 'high',
                  baselineSnapshotJson: frozenBaseline,
                  baselineSnapshotHash: 'seed-hash',
                  lastSyncedSessionId: session.id,
                  lastSyncedSessionRevision: session.revision,
                  nextSeq: 246,
                },
              },
            }
          : t,
      ),
    });

    // 验证 vault saveCoachMessages / loadCoachMessages 不再在 240 处裁掉文本历史
    const bigMsgs = Array.from({ length: 260 }, (_, i) => ({
      id: `m-${i}`,
      threadId: 'thread-archive-260',
      role: 'user' as const,
      createdAt: NOW + i,
      text: `msg-${i}`,
    }));
    await saveCoachMessages(bigMsgs);
    expect(
      (await loadCoachMessages()).filter((m) => m.threadId === 'thread-archive-260').length,
    ).toBe(260);

    const dsCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'ds-key',
      updatedAt: NOW,
    };

    const capturedReqs: Array<{
      tools: unknown[];
      messages: Array<{ role: string; content?: unknown; reasoning_content?: string }>;
    }> = [];

    let setCursor = 1;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as (typeof capturedReqs)[number];
      capturedReqs.push(body);
      const lastRole = body.messages[body.messages.length - 1]?.role;
      const lastContent = String(body.messages[body.messages.length - 1]?.content ?? '');
      if (lastRole === 'user' && lastContent.includes('记第') && setCursor <= 10) {
        const curSet = setCursor;
        setCursor += 1;
        return makeSse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: `THINK_SET_${curSet}`,
                  tool_calls: [
                    {
                      index: 0,
                      id: `c-set-${curSet}`,
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({
                          sessionId: session.id,
                          exId,
                          roundIndex: curSet,
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
            usage: { prompt_tokens: 4000, completion_tokens: 20, prompt_cache_hit_tokens: 3840, prompt_cache_miss_tokens: 160 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return makeSse([
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: 'THINK_OK', content: '已完成。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4060, completion_tokens: 10, prompt_cache_hit_tokens: 4000, prompt_cache_miss_tokens: 60 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    try {
      // 1) 连记 10 组（含第 5 组后用户 UI 手动改第 5 组为 12 次 + Undo 第 1 组并补记）
      for (let i = 1; i <= 5; i += 1) {
        await runCoachTurn({
          threadId: tid,
          userText: `记第 ${i} 组 60kg 10次`,
          history: [{ id: `ui-${i}`, threadId: tid, role: 'user', createdAt: NOW + 1000 + i, text: 'x' }],
          thinkingDepth: 'high',
          providerConfig: dsCfg,
          toolContext: { activeSession: await getSession(session.id) },
          streamChunkDelayMs: 0,
        });
      }

      // 模拟用户在 UI 手动改第 5 组次数 -> 12 次
      const after5 = (await getSession(session.id))!;
      const manualEdited: Session = {
        ...after5,
        revision: (after5.revision ?? 0) + 1,
        exercises: after5.exercises.map((e, idx) =>
          idx === 0
            ? {
                ...e,
                sets: e.sets.map((s, si) => (si === 4 ? { ...s, reps: 12 } : s)),
              }
            : e,
        ),
      };
      await idbPut('sessions', manualEdited);

      const reqIdxBeforeManualTurn = capturedReqs.length;
      await runCoachTurn({
        threadId: tid,
        userText: '刚才第5组我手改成12次了，继续记第 6 组',
        history: [{ id: 'ui-manual', threadId: tid, role: 'user', createdAt: NOW + 2000, text: 'x' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });

      // Layer 3 尾部增量中必须把 UI 手改后的 compact 状态送给模型
      const manualUserMsgText = String(
        capturedReqs[reqIdxBeforeManualTurn].messages[capturedReqs[reqIdxBeforeManualTurn].messages.length - 1].content,
      );
      expect(manualUserMsgText).toContain('[训练增量');
      expect(manualUserMsgText).toContain('12');

      // 接着下一轮未手改直接闲聊问句，已同步过的动作状态不重复塞整块大状态
      const reqIdxNextChat = capturedReqs.length;
      await runCoachTurn({
        threadId: tid,
        userText: '不错，休息一下',
        history: [{ id: 'ui-chat', threadId: tid, role: 'user', createdAt: NOW + 2500, text: 'x' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      const nextChatText = String(
        capturedReqs[reqIdxNextChat].messages[capturedReqs[reqIdxNextChat].messages.length - 1].content,
      );
      expect(nextChatText).toBe('不错，休息一下');

      // 模拟 Undo 第 7 组后继续发一轮 -> Delta 通知模型撤销后的紧凑态
      const turn7 = await runCoachTurn({
        threadId: tid,
        userText: '记第 7 组 60kg 10次',
        history: [{ id: 'ui-7', threadId: tid, role: 'user', createdAt: NOW + 2600, text: 'x' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      await undoCoachReceipt(turn7.receipts[0].id);

      const reqIdxAfterUndo = capturedReqs.length;
      await runCoachTurn({
        threadId: tid,
        userText: '撤销后看下现在进度',
        history: [{ id: 'ui-after-undo', threadId: tid, role: 'user', createdAt: NOW + 2700, text: 'x' }],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      expect(
        String(capturedReqs[reqIdxAfterUndo].messages[capturedReqs[reqIdxAfterUndo].messages.length - 1].content),
      ).toContain('[训练增量');

      // 验证：所有请求 Layer 1 (system) + 16 tools + Layer 2 (baseline) 在整个段内逐字节恒同，且第一条 seed 消息 #1 未被 200/240 裁掉！
      const sys0 = capturedReqs[0].messages[0].content;
      const base0 = capturedReqs[0].messages[1].content;
      const tools0 = JSON.stringify(capturedReqs[0].tools);
      for (let k = 1; k < capturedReqs.length; k += 1) {
        expect(capturedReqs[k].messages[0].content).toBe(sys0);
        expect(capturedReqs[k].messages[1].content).toBe(base0);
        expect(JSON.stringify(capturedReqs[k].tools)).toBe(tools0);
        expect(capturedReqs[k].messages[2].content).toBe('历史对话 #1');
        // 每个工具续调请求（messages[0..n-1]）严格前缀包含前一轮的 wire messages
        if (k > 0 && capturedReqs[k].messages.length >= capturedReqs[k - 1].messages.length) {
          const prevSlice = JSON.stringify(capturedReqs[k - 1].messages);
          const curSlice = JSON.stringify(
            capturedReqs[k].messages.slice(0, capturedReqs[k - 1].messages.length),
          );
          expect(curSlice).toBe(prevSlice);
        }
      }

      // 验证 3 条独立会话共享同一静态前缀（system + 16 tools）
      const tState2 = await loadCoachThreadsState();
      await saveCoachThreadsState({
        ...tState2,
        threads: [
          ...tState2.threads,
          { id: 'thread-peer-2', title: 'S2', createdAt: NOW, updatedAt: NOW },
          { id: 'thread-peer-3', title: 'S3', createdAt: NOW, updatedAt: NOW },
        ],
      });
      await runCoachTurn({
        threadId: 'thread-peer-2',
        userText: '线程2第一问',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      await runCoachTurn({
        threadId: 'thread-peer-3',
        userText: '线程3第一问',
        history: [],
        thinkingDepth: 'high',
        providerConfig: dsCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
      });
      const peerReq2 = capturedReqs[capturedReqs.length - 2];
      const peerReq3 = capturedReqs[capturedReqs.length - 1];
      expect(peerReq2.messages[0].content).toBe(sys0);
      expect(peerReq3.messages[0].content).toBe(sys0);
      expect(JSON.stringify(peerReq2.tools)).toBe(tools0);
      expect(JSON.stringify(peerReq3.tools)).toBe(tools0);
      expect(sys0).toBe(STATIC_COACH_SYSTEM_PROMPT);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('5. 删除记忆/附件清理重放历史、一次性/原生视觉分流、无截断摘要、24k/32k 经济压缩判定、本地优先标题与独立账本覆盖率', async () => {
    // 5a. 记忆删除清理重放历史
    let memStore = createEmptyCoachMemory();
    memStore = upsertCoachMemoryItem(memStore, {
      category: 'injury',
      title: '隐私伤病秘密代号X',
      content: '秘密细节ABCDEF',
    }).store;
    await saveCoachMemory(memStore);

    const threads = await loadCoachThreadsState();
    const tid = threads.activeThreadId;
    await saveCoachThreadsState({
      ...threads,
      threads: threads.threads.map((t) =>
        t.id === tid
          ? {
              ...t,
              activeSegmentId: 'seg-mem',
              segments: {
                'seg-mem': {
                  segmentId: 'seg-mem',
                  startedAt: NOW,
                  reason: 'initial',
                  deploymentId: 'openai-compatible:api.deepseek.com:deepseek-chat',
                  providerKind: 'openai-compatible',
                  model: 'deepseek-chat',
                  thinkingModeKey: 'high',
                  baselineSnapshotJson: '记忆: 隐私伤病秘密代号X / 秘密细节ABCDEF',
                  baselineSnapshotHash: 'h',
                  nextSeq: 2,
                },
              },
            }
          : t,
      ),
    });
    await appendProtocolEntriesStrict([
      {
        id: `${tid}:seg-mem:1`,
        threadId: tid,
        segmentId: 'seg-mem',
        seq: 1,
        createdAt: NOW,
        kind: 'tool',
        toolCallId: 'c-mem',
        toolName: 'manage_coach_memory',
        toolResultText: JSON.stringify({ ok: true, summary: '已记住隐私伤病秘密代号X' }),
      },
      {
        id: `${tid}:seg-mem:2`,
        threadId: tid,
        segmentId: 'seg-mem',
        seq: 2,
        createdAt: NOW,
        kind: 'user',
        wireText: '看图',
        attachments: [
          { id: 'att-del-1', name: 'secret.jpg', mimeType: 'image/jpeg', width: 100, height: 100, sizeBytes: 120, dataBase64: 'AAA=' },
        ],
      },
    ]);

    await purgeDeletedMemoryFromCoachHistory({
      memoryTitle: '隐私伤病秘密代号X',
      memoryContent: '秘密细节ABCDEF',
      threadId: tid,
    });
    await purgeDeletedAttachmentFromCoachHistory({ threadId: tid, attachmentId: 'att-del-1' });

    const afterPurgeThreads = await loadCoachThreadsState();
    const activeSeg = afterPurgeThreads.threads[0].segments![afterPurgeThreads.threads[0].activeSegmentId!];
    expect(activeSeg.baselineSnapshotJson).not.toContain('隐私伤病秘密代号X');
    const cleanedEntries = await listProtocolEntries(tid);
    expect(cleanedEntries[0].toolResultText).not.toContain('隐私伤病秘密代号X');
    expect(cleanedEntries[1].attachments).toBeUndefined();
    expect(cleanedEntries[1].mediaStripped).toBe(true);

    // 5b. 压缩上下文移除 220 字硬截断 + 标题本地优先（DeepSeek/百炼 0 远端请求）+ 视觉能力分流
    const longMsgA = 'A'.repeat(390) + 'TAIL_MARKER_1';
    const longMsgB = 'B'.repeat(390) + 'TAIL_MARKER_2';
    let capturedSummaryPrompt = '';
    const seenTitleRequests: number[] = [];
    const seenVisionPayloads: unknown[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init) => {
      const sUrl = String(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (sUrl.includes('deepseek.com')) {
        const sysMsg = String((body.messages as Array<{ content?: string }>)[0]?.content ?? '');
        if (sysMsg.includes('只输出标题')) seenTitleRequests.push(1);
        else if (sysMsg.includes('上下文摘要')) {
          capturedSummaryPrompt = String((body.messages as Array<{ content?: string }>)[1]?.content ?? '');
        } else {
          seenVisionPayloads.push(body.messages);
        }
        return makeSse([
          `data: ${JSON.stringify({ choices: [{ delta: { content: '摘要完整结果' }, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 20, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 500 } })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      // Anthropic native vision
      seenVisionPayloads.push(body.messages);
      return makeSse([
        `event: message_start\ndata: ${JSON.stringify({ message: { usage: { input_tokens: 300 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: 'text_delta', text: '已看图。' } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } })}\n\n`,
        `event: message_stop\ndata: {}\n\n`,
      ]);
    });

    const dsCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'ds-key',
      updatedAt: NOW,
    };
    const antCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'anthropic',
      presetId: 'anthropic-official',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'ant-key',
      updatedAt: NOW,
    };
    try {
      await compressCoachContext({
        threadId: tid,
        messages: [
          { id: 'c1', role: 'user', createdAt: 1, text: longMsgA },
          { id: 'c2', role: 'assistant', createdAt: 2, text: longMsgB },
          { id: 'c3', role: 'user', createdAt: 3, text: 'recent 1' },
          { id: 'c4', role: 'assistant', createdAt: 4, text: 'recent 2' },
        ],
        providerConfig: dsCfg,
        keepRecent: 2,
      });
      expect(capturedSummaryPrompt).toContain('TAIL_MARKER_1');
      expect(capturedSummaryPrompt).toContain('TAIL_MARKER_2');

      const title = await suggestCoachTitle('胸推80kg 8次', 'ok', dsCfg, {
        dayName: '推力 A',
        threadId: tid,
      });
      expect(title).toContain('推力 A');
      expect(seenTitleRequests).toHaveLength(0);

      // 5c. 视觉隔离：DeepSeek 文本模型不传 image base64；Anthropic 原生传 base64 image block
      const { session } = await seedWideActive('sess-vision');
      const fakeImg = { id: 'img-1', name: 'plan.jpg', mimeType: 'image/jpeg', width: 200, height: 200, sizeBytes: 50, dataBase64: 'BASE64_IMG_BYTES' };
      await runCoachTurn({
        threadId: tid,
        userText: '帮我看这张图',
        attachments: [fakeImg],
        history: [],
        providerConfig: dsCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      await runCoachTurn({
        threadId: 'thread-vision-ant',
        userText: '帮我看这张图',
        attachments: [fakeImg],
        history: [],
        providerConfig: antCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(JSON.stringify(seenVisionPayloads[0])).not.toContain('BASE64_IMG_BYTES');
      expect(JSON.stringify(seenVisionPayloads[1])).toContain('BASE64_IMG_BYTES');
    } finally {
      globalThis.fetch = origFetch;
    }

    // 5d. 24k/32k 经济压缩判定与硬上限检查
    const below24k = evaluateEconomicCompaction({ usedTokens: 20_000, compressibleCount: 10, remainingExpectedRequests: 20 });
    expect(below24k.shouldCompact).toBe(false);
    const fixed32kShortTail = evaluateEconomicCompaction({ usedTokens: 32_500, compressibleCount: 10, remainingExpectedRequests: 1 });
    expect(fixed32kShortTail.shouldCompact).toBe(false);
    const longProfitable = evaluateEconomicCompaction({
      usedTokens: 42_000,
      estimatedPostCompactTokens: 8_000,
      compressibleCount: 12,
      remainingExpectedRequests: 20,
      cacheReadRatio: 0.1,
    });
    expect(longProfitable.shouldCompact).toBe(true);
    const hardOverflow = checkHardContextBudget({
      estimatedInputTokens: 125_000,
      model: 'deepseek-chat',
      advertisedMaxTokens: 128_000,
      reservedOutputTokens: 8192,
    });
    expect(hardOverflow.exceedsHardLimit).toBe(true);

    // 5e. 独立计费账本：usage 缺失 & 反代缺缓存明细均各自严格标 unknown、不伪造 0% 命中率、去重统计成功记组
    const dsCaps = resolveProviderCapabilities({ kind: 'openai-compatible', presetId: 'deepseek-official', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
    const proxyMeasuredNoCache = normalizeUsageToBillingRecord({
      id: 'b-nocache',
      threadId: 't-bill',
      segmentId: 's-bill',
      round: 0,
      purpose: 'coach_turn',
      capabilities: dsCaps,
      rawUsage: { prompt_tokens: 1000, completion_tokens: 50 },
      operationIdsCompleted: ['op-1'],
    });
    const proxyMissingUsage = normalizeUsageToBillingRecord({
      id: 'b-nousage',
      threadId: 't-bill',
      segmentId: 's-bill',
      round: 1,
      purpose: 'coach_turn',
      capabilities: dsCaps,
      operationIdsCompleted: ['op-1'], // 同 operationId 重放去重
    });
    expect(proxyMeasuredNoCache.source).toBe('measured');
    expect(proxyMeasuredNoCache.cacheDetailSource).toBe('unknown');
    expect(proxyMeasuredNoCache.cacheHitRatio).toBeNull();
    expect(proxyMissingUsage.source).toBe('unknown');
    expect(proxyMissingUsage.computedCostUsd).toBeNull();

    const summary = summarizeBillingRecords([proxyMeasuredNoCache, proxyMissingUsage]);
    expect(summary.usageCoverageRatio).toBe(0.5);
    expect(summary.cacheDetailCoverageRatio).toBe(0);
    expect(summary.cacheHitRate).toBeNull();
    expect(summary.totalCost).toBeNull();
    expect(summary.dedupedLoggedSets).toBe(1);
  });
});

function makeOpenAiSseResponse(chunks: string[]): Response {
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

describe('MOTION v0.2.3 R1 补强回归：未知缓存边界、多币种、记忆全清理、UI并发与经济压缩接线', () => {
  beforeEach(async () => {
    await resetEverything();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('6. 缺失缓存明细时严禁当作 100% miss，并给出费用上下界及 mixed 多币种分小计', () => {
    const dsCaps = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      pricingWindowOverride: 'peak',
    });
    const recUnknown = normalizeUsageToBillingRecord({
      id: 'bill-unknown-cache',
      threadId: 't-bill',
      segmentId: 's-bill',
      round: 0,
      purpose: 'coach_turn',
      capabilities: dsCaps,
      rawUsage: {
        prompt_tokens: 1000,
        completion_tokens: 10,
      },
      operationIdsCompleted: ['op-u1'],
    });

    expect(recUnknown.cacheDetailSource).toBe('unknown');
    expect(recUnknown.inputTokens).toBe(1000);
    expect(recUnknown.cachedInputTokens).toBe(0);
    expect(recUnknown.uncachedInputTokens).toBe(0);
    expect(recUnknown.unknownCacheInputTokens).toBe(1000);
    expect(recUnknown.computedCostUsd).toBeNull();
    // Peak DeepSeek Flash: input ¥2/M, cached ¥0.04/M, output ¥8/M
    expect(recUnknown.costBounds?.min).toBeCloseTo((1000 * 0.04 + 10 * 8) / 1_000_000, 8);
    expect(recUnknown.costBounds?.max).toBeCloseTo((1000 * 2 + 10 * 8) / 1_000_000, 8);

    const unknownSummary = summarizeBillingRecords([recUnknown]);
    expect(unknownSummary.cacheDetailCoverageRatio).toBe(0);
    expect(unknownSummary.unknownCacheDetailRequests).toBe(1);
    expect(unknownSummary.unknownCacheInputTokens).toBe(1000);
    expect(unknownSummary.uncachedInputTokens).toBe(0);
    expect(unknownSummary.totalCost).toBeNull();
    expect(unknownSummary.missPerLoggedSet).toBeNull();
    expect(unknownSummary.costBounds?.min).toBeCloseTo(recUnknown.costBounds!.min, 8);
    expect(unknownSummary.costBounds?.max).toBeCloseTo(recUnknown.costBounds!.max, 8);

    const dsMeasured = normalizeUsageToBillingRecord({
      id: 'bill-cny',
      threadId: 't-mixed',
      segmentId: 's-cny',
      round: 0,
      purpose: 'coach_turn',
      capabilities: dsCaps,
      rawUsage: {
        prompt_tokens: 2000,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 1000,
        completion_tokens: 50,
      },
      operationIdsCompleted: ['op-m1'],
    });
    const oaiCaps = resolveProviderCapabilities({
      kind: 'openai-compatible',
      presetId: 'openai-official',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
    const oaiMeasured = normalizeUsageToBillingRecord({
      id: 'bill-usd',
      threadId: 't-mixed',
      segmentId: 's-usd',
      round: 0,
      purpose: 'coach_turn',
      capabilities: oaiCaps,
      rawUsage: {
        prompt_tokens: 1000,
        prompt_tokens_details: { cached_tokens: 500 },
        completion_tokens: 50,
      },
      operationIdsCompleted: ['op-m2'],
    });

    const mixedSummary = summarizeBillingRecords([dsMeasured, oaiMeasured]);
    expect(mixedSummary.currency).toBe('mixed');
    expect(mixedSummary.totalCost).toBeNull();
    expect(mixedSummary.costBounds).toBeNull();
    expect(mixedSummary.subtotalsByCurrency.CNY?.totalCost).toBeCloseTo(dsMeasured.computedCostUsd!, 6);
    expect(mixedSummary.subtotalsByCurrency.USD?.totalCost).toBeCloseTo(oaiMeasured.computedCostUsd!, 6);
  });

  it('7. 删除长期记忆后，所有历史分段基线、protocolEntries（含 toolCalls.argumentsText）、pendingTurns 与后续请求彻底清零', async () => {
    const { session } = await seedWideActive('sess-mem-purge');
    const exId = session.exercises[0].id;
    const MARKER = 'SECRET_MEM_MARKER_SHOULDER_999';
    const mem = upsertCoachMemoryItem(
      createEmptyCoachMemory(),
      {
        category: 'injury',
        title: '右肩保护备注',
        content: MARKER,
        source: 'user',
      },
      NOW,
    ).store;
    await saveCoachMemory(mem);

    const dsCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      thinkingDepth: 'high',
      apiKey: 'sk-test-mem',
      updatedAt: NOW,
    };

    const capturedPayloads: string[] = [];
    let callIdx = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      capturedPayloads.push(String(init?.body ?? ''));
      callIdx += 1;
      if (callIdx === 1) {
        return makeOpenAiSseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: `注意保护右肩：${MARKER}`,
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-mem-1',
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({
                          sessionId: session.id,
                          exId,
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
            usage: { prompt_tokens: 1800, completion_tokens: 30, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1800 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return makeOpenAiSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: `已确认：${MARKER}`,
                content: `第 1 组已记下（关联备注 ${MARKER}）。`,
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 2100, completion_tokens: 25, prompt_cache_hit_tokens: 1792, prompt_cache_miss_tokens: 308 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const threads = await loadCoachThreadsState();
    const tid = threads.activeThreadId;
    let capturedPending = null as CoachPendingTurn | null;
    await runCoachTurn({
      threadId: tid,
      userText: `记第一组 60kg 10次（${MARKER}）`,
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
      streamChunkDelayMs: 0,
      onPendingTurnChange: (p) => {
        if (p) capturedPending = p;
      },
    });

    // 人为补入旧分段基线、toolCalls[].argumentsText、contextSummary 与残留 pendingTurn 中的隐私副本
    const existingEntries = await listProtocolEntries(tid);
    await replaceProtocolEntriesForThread(
      tid,
      existingEntries.map((e) =>
        e.toolCalls?.length
          ? {
              ...e,
              toolCalls: e.toolCalls.map((tc) => ({
                ...tc,
                argumentsText: tc.argumentsText.replace('}', `,"memo":"${MARKER}"}`),
              })),
            }
          : e,
      ),
    );
    const stNow = await loadCoachThreadsState();
    const tMeta = stNow.threads.find((t) => t.id === tid)!;
    const activeSeg = tMeta.segments![tMeta.activeSegmentId!];
    await saveCoachThreadsState({
      ...stNow,
      threads: stNow.threads.map((t) =>
        t.id === tid
          ? {
              ...t,
              contextSummary: `历史摘要含 ${MARKER}`,
              segments: {
                ...t.segments,
                'seg-old-stale': {
                  ...activeSeg,
                  segmentId: 'seg-old-stale',
                  baselineSnapshotJson: activeSeg.baselineSnapshotJson + `\n# stale ${MARKER}`,
                },
              },
            }
          : t,
      ),
    });
    if (capturedPending) {
      await savePendingTurnStrict({
        ...capturedPending,
        userPromptText: `残留待恢复提示含 ${MARKER}`,
      });
    }

    await saveCoachMemory(createEmptyCoachMemory());
    await purgeDeletedMemoryFromCoachHistory({
      memoryTitle: 'shoulder',
      memoryContent: MARKER,
    });

    const afterThreads = await loadCoachThreadsState();
    const afterThread = afterThreads.threads.find((t) => t.id === tid)!;
    for (const seg of Object.values(afterThread.segments ?? {})) {
      expect(seg.baselineSnapshotJson).not.toContain(MARKER);
    }
    expect(afterThread.contextSummary ?? '').not.toContain(MARKER);
    const entriesAfter = await listProtocolEntries(tid);
    expect(JSON.stringify(entriesAfter)).not.toContain(MARKER);
    const pendingAfter = await listPendingTurns(tid);
    expect(JSON.stringify(pendingAfter)).not.toContain(MARKER);

    capturedPayloads.length = 0;
    await runCoachTurn({
      threadId: tid,
      userText: '下一组准备好了，给个建议',
      history: [{ id: 'u1', threadId: tid, role: 'user', createdAt: NOW, text: '上一轮' }],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
      streamChunkDelayMs: 0,
    });
    expect(capturedPayloads.length).toBeGreaterThanOrEqual(1);
    for (const wire of capturedPayloads) {
      expect(wire).not.toContain(MARKER);
    }
  });

  it('8. CoachPane UI 并发回调（patchCoachThreadUiFields + saveCoachThreadsUiLayout）与 runCoachTurn 并发不分裂分段、Turn 2+ 保留工具轨迹', async () => {
    const { session } = await seedWideActive('sess-ui-concurrency');
    const exId = session.exercises[0].id;
    const dsCfg: CoachStoredProviderConfig = {
      key: 'provider',
      kind: 'openai-compatible',
      presetId: 'deepseek-official',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      thinkingDepth: 'high',
      apiKey: 'sk-test-ui',
      updatedAt: NOW,
    };

    const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
    let turnPhase = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<Record<string, unknown>> };
      requests.push(parsed);
      turnPhase += 1;
      if (turnPhase === 1) {
        return makeOpenAiSseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: '并发 UI 回调测试：先记录第 1 组',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-ui-race-1',
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
            usage: { prompt_tokens: 1500, completion_tokens: 28, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1500 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return makeOpenAiSseResponse([
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '汇总响应',
                content: turnPhase === 2 ? '第 1 组 60kg×10 已完成。' : '刚刚第 1 组记录的是 60kg×10次。',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1900, completion_tokens: 20, prompt_cache_hit_tokens: 1472, prompt_cache_miss_tokens: 428 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    });

    const threads = await loadCoachThreadsState();
    const tid = threads.activeThreadId;
    const inflightUiWrites: Array<Promise<unknown>> = [];
    const t1 = await runCoachTurn({
      threadId: tid,
      userText: '帮我记第 1 组 60kg 10次',
      history: [],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
      streamChunkDelayMs: 0,
      onUsage: (u) => {
        inflightUiWrites.push(
          patchCoachThreadUiFields(tid, {
            updatedAt: NOW + 10,
            lastUsage: {
              promptTokens: u.promptTokens ?? 0,
              cachedTokens: u.cachedTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              updatedAt: NOW + 10,
            },
          }),
        );
      },
      onSegmentChanged: () => {
        inflightUiWrites.push(patchCoachThreadUiFields(tid, { updatedAt: NOW + 11, title: '胸肌训练' }));
      },
    });
    const curLayout = await loadCoachThreadsState();
    inflightUiWrites.push(
      saveCoachThreadsUiLayout({
        activeThreadId: curLayout.activeThreadId,
        threads: curLayout.threads.map((th) => (th.id === tid ? { ...th, title: '胸肌分化实时对话' } : th)),
      }),
    );
    await Promise.all(inflightUiWrites);

    const t2 = await runCoachTurn({
      threadId: tid,
      userText: '上一组多少次？',
      history: [
        { id: 'u1', threadId: tid, role: 'user', createdAt: NOW + 1, text: '帮我记第 1 组 60kg 10次' },
        { id: 'a1', threadId: tid, role: 'assistant', createdAt: NOW + 2, text: t1.text, reasoning: t1.reasoning },
      ],
      thinkingDepth: 'high',
      providerConfig: dsCfg,
      toolContext: { activeSession: await getSession(session.id) },
      streamChunkDelayMs: 0,
    });
    expect(t2.aborted).toBe(false);

    const afterState = await loadCoachThreadsState();
    const afterThread = afterState.threads.find((t) => t.id === tid)!;
    expect(Object.keys(afterThread.segments ?? {})).toHaveLength(1);

    const turn2Req = requests[2];
    expect(turn2Req).toBeTruthy();
    expect(
      turn2Req.messages.some(
        (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && typeof m.reasoning_content === 'string',
      ),
    ).toBe(true);
    expect(turn2Req.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call-ui-race-1')).toBe(true);
  });

  it('9. evaluateEconomicCompaction 仅在完整回合结束接线触发：缺 usage / 未知定价跳过，有利润时按回合末顺序触发且绝不工具中途切断', async () => {
    const base = createV32Plan(NOW);
    const largeDay = {
      ...base.days[0],
      exercises: base.days[0].exercises.map((e, idx) =>
        idx === 0 ? { ...e, target: { ...e.target, sets: 25, setsMax: 25 } } : e,
      ),
    };
    const bigPlan = { ...base, id: 'plan-econ-wire', name: '大容量计划', days: [largeDay], cursor: 0 };
    await savePlan(bigPlan);

    // Sub-case A: 缺 usage 时不触发经济压缩
    {
      const sessA = { ...createSession(bigPlan, bigPlan.days[0], NOW), id: 'sess-econ-no-usage' };
      await atomicCreateSession({ session: sessA });
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const events: string[] = [];
      vi.stubGlobal('fetch', async () =>
        makeOpenAiSseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '无 usage 回复' }, finish_reason: 'stop' }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
      await runCoachTurn({
        threadId: tid,
        userText: '请评价当前动作节奏',
        history: Array.from({ length: 10 }, (_, k) => ({
          id: `hm-${k}`,
          threadId: tid,
          role: k % 2 === 0 ? ('user' as const) : ('assistant' as const),
          createdAt: NOW + k,
          text: '训练历史消息 '.repeat(120),
        })),
        thinkingDepth: 'off',
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          presetId: 'deepseek-official',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          apiKey: 'sk-econ-a',
          updatedAt: NOW,
        },
        toolContext: { activeSession: await getSession(sessA.id) },
        streamChunkDelayMs: 0,
        onCompactionApplied: (info) => {
          events.push(info.reason);
        },
      });
      expect(events).toHaveLength(0);
    }

    // Sub-case B: 未知定价部署（custom-unpriced-model）不触发经济压缩
    {
      await resetEverything();
      await savePlan(bigPlan);
      const sessB = { ...createSession(bigPlan, bigPlan.days[0], NOW), id: 'sess-econ-no-price' };
      await atomicCreateSession({ session: sessB });
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const events: string[] = [];
      vi.stubGlobal('fetch', async () =>
        makeOpenAiSseResponse([
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '未知定价回复' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 65000, completion_tokens: 30, prompt_cache_hit_tokens: 45000, prompt_cache_miss_tokens: 20000 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      );
      await runCoachTurn({
        threadId: tid,
        userText: '请评价当前动作节奏',
        history: Array.from({ length: 10 }, (_, k) => ({
          id: `hb-${k}`,
          threadId: tid,
          role: k % 2 === 0 ? ('user' as const) : ('assistant' as const),
          createdAt: NOW + k,
          text: '未知定价长历史 '.repeat(120),
        })),
        thinkingDepth: 'off',
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://my-gateway.example.com/v1',
          model: 'custom-unpriced-model',
          apiKey: 'sk-econ-b',
          updatedAt: NOW,
        },
        toolContext: { activeSession: await getSession(sessB.id) },
        streamChunkDelayMs: 0,
        onCompactionApplied: (info) => {
          events.push(info.reason);
        },
      });
      expect(events).toHaveLength(0);
    }

    // Sub-case C: deepseek-flash + 实测大上下文 + 多剩余请求 -> 完整回合末尾才触发压缩，绝不在 tool 循环中途切段
    {
      await resetEverything();
      await savePlan(bigPlan);
      const sessC = { ...createSession(bigPlan, bigPlan.days[0], NOW), id: 'sess-econ-profit' };
      await atomicCreateSession({ session: sessC });
      const freshC = (await getSession(sessC.id))!;
      const exId = freshC.exercises[0].id;
      const tid = (await loadCoachThreadsState()).activeThreadId;
      const callOrder: string[] = [];
      const summaryWires: string[] = [];
      const nextTurnWires: string[] = [];

      vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          messages: Array<{ role: string; content?: string }>;
        };
        const lastMsg = body.messages[body.messages.length - 1];
        const msgsStr = JSON.stringify(body.messages);
        if (lastMsg?.role === 'user' && String(lastMsg.content ?? '').includes('记第 1 组')) {
          callOrder.push('round0_tool');
          return makeOpenAiSseResponse([
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_content: '准备记第 1 组',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-econ-1',
                        function: {
                          name: 'record_active_set',
                          arguments: JSON.stringify({ sessionId: freshC.id, exId, roundIndex: 1, reps: 10, weightKg: 60, status: 'done' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 65000, completion_tokens: 30, prompt_cache_hit_tokens: 55000, prompt_cache_miss_tokens: 10000 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        if (lastMsg?.role === 'tool') {
          callOrder.push('round1_confirm');
          return makeOpenAiSseResponse([
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    reasoning_content: '记组完成',
                    content: '第 1 组 60kg 10次已记录。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 65500, completion_tokens: 24, prompt_cache_hit_tokens: 64960, prompt_cache_miss_tokens: 540 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        if (lastMsg?.role === 'user' && String(lastMsg.content ?? '').includes('复盘继续')) {
          nextTurnWires.push(msgsStr);
          callOrder.push('next_turn');
          return makeOpenAiSseResponse([
            `data: ${JSON.stringify({ choices: [{ delta: { content: '好的，继续。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 6, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900 } })}\n\n`,
            'data: [DONE]\n\n',
          ]);
        }
        summaryWires.push(msgsStr);
        callOrder.push('summary_call');
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '已完成 1 组胸肌推举（60kg×10），节奏稳定。' } }],
            usage: { prompt_tokens: 900, completion_tokens: 40, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      });

      const historyLong = Array.from({ length: 12 }, (_, k) => ({
        id: `hc-${k}`,
        threadId: tid,
        role: k % 2 === 0 ? ('user' as const) : ('assistant' as const),
        createdAt: NOW + k,
        text: `长训练记录分析第 ${k} 段 `.repeat(40),
      }));
      const R4_EARLY = 'R4_EARLY_DELETED_zz1';
      const R4_RECENT = 'R4_RECENT_DELETED_zz2';
      historyLong[0].text += ' ' + R4_EARLY;
      historyLong[10].text += ' ' + R4_RECENT;
      await saveCoachMessages(historyLong as unknown as Parameters<typeof saveCoachMessages>[0]);
      await purgeDeletedMemoryFromCoachHistory({ threadId: tid, memoryContent: R4_EARLY });
      await purgeDeletedMemoryFromCoachHistory({ threadId: tid, memoryContent: R4_RECENT });

      await runCoachTurn({
        threadId: tid,
        userText: '帮我记第 1 组 60kg 10次',
        history: historyLong,
        thinkingDepth: 'high',
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          presetId: 'deepseek-official',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          thinkingDepth: 'high',
          apiKey: 'sk-econ-c',
          updatedAt: NOW,
        },
        toolContext: { activeSession: freshC },
        streamChunkDelayMs: 0,
        onCompactionApplied: () => {
          callOrder.push('onCompactionApplied');
        },
      });

      expect(callOrder).toEqual(['round0_tool', 'round1_confirm', 'summary_call', 'onCompactionApplied']);
      // 早期(被压缩)与最近(保留段)的被删标记都不得出现在 summary_call 与压缩后下一轮出站
      expect(summaryWires.length).toBeGreaterThan(0);
      expect(summaryWires.every((w) => !w.includes(R4_EARLY) && !w.includes(R4_RECENT))).toBe(true);
      // 本回合末尾确实发生了经济压缩（新段 reason=compaction）
      const compactedState = await loadCoachThreadsState();
      const compactedTh = compactedState.threads.find((t) => t.id === tid)!;
      expect(compactedTh.segments?.[compactedTh.activeSegmentId!]?.reason).toBe('compaction');

      await runCoachTurn({
        threadId: tid,
        userText: '复盘继续',
        history: [],
        thinkingDepth: 'high',
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          presetId: 'deepseek-official',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          thinkingDepth: 'high',
          apiKey: 'sk-econ-c',
          updatedAt: NOW,
        },
        toolContext: { activeSession: (await getSession(sessC.id))! },
        streamChunkDelayMs: 0,
      });
      expect(nextTurnWires.length).toBeGreaterThan(0);
      expect(nextTurnWires.every((w) => !w.includes(R4_EARLY) && !w.includes(R4_RECENT))).toBe(true);
    }
  });

  it('10. R3-6：DeepSeek 官方 Anthropic Messages 入口按实际部署取人民币隐式缓存费率，保留原生思考/工具与 usage 解析；自定义代理显式 unknown', () => {
    for (const model of ['deepseek-flash', 'deepseek-v4-pro'] as const) {
      for (const win of ['peak', 'off_peak'] as const) {
        const chatCaps = resolveProviderCapabilities({
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model,
          pricingWindowOverride: win,
        });
        const msgCaps = resolveProviderCapabilities({
          kind: 'anthropic',
          baseUrl: 'https://api.deepseek.com/anthropic',
          model,
          pricingWindowOverride: win,
        });
        expect(msgCaps.protocolKind).toBe('anthropic');
        expect(msgCaps.upstreamFamily).toBe('deepseek');
        expect(msgCaps.cacheMechanism).toBe('implicit_prefix');
        expect(msgCaps.sendCacheControlBreakpoints).toBe(false);
        expect(msgCaps.maxCacheBreakpoints).toBe(0);
        expect(msgCaps.reasoningFieldFormat).toBe('anthropic_thinking_blocks');
        expect(msgCaps.pricing.currency).toBe('CNY');
        expect(msgCaps.pricing.inputPer1MTokens).toBe(chatCaps.pricing.inputPer1MTokens);
        expect(msgCaps.pricing.cachedInputPer1MTokens).toBe(chatCaps.pricing.cachedInputPer1MTokens);
        expect(msgCaps.pricing.outputPer1MTokens).toBe(chatCaps.pricing.outputPer1MTokens);
      }
    }

    const dsMsgCaps = resolveProviderCapabilities({
      kind: 'anthropic',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-flash',
      pricingWindowOverride: 'peak',
    });

    const dsMsgReq = buildAnthropicRequest(
      {
        kind: 'anthropic',
        baseUrl: 'https://api.deepseek.com/anthropic',
        model: 'deepseek-flash',
        apiKey: 'ds-msg-k',
      },
      [
        { role: 'system', text: 'STATIC_SYS', cacheControl: 'ephemeral' },
        { role: 'user', parts: [{ type: 'text', text: 'turn 1' }] },
        {
          role: 'assistant',
          text: '记组',
          anthropicBlocks: [
            { type: 'thinking', thinking: 'DS_MSG_THINK', signature: 'sig-ds-1' },
            { type: 'tool_use', id: 'tu_ds_1', name: 'record_active_set', input: { reps: 10 } },
          ],
        },
        { role: 'tool', toolCallId: 'tu_ds_1', name: 'record_active_set', content: '{"ok":true}' },
      ],
      [],
      { thinkingDepth: 'high', capabilities: dsMsgCaps },
    );
    expect(dsMsgReq.url).toBe('https://api.deepseek.com/anthropic/messages');
    const hdrs = dsMsgReq.init.headers as Record<string, string>;
    expect(hdrs['x-api-key']).toBe('ds-msg-k');
    expect(hdrs['anthropic-version']).toBe('2023-06-01');
    const rawBody = String(dsMsgReq.init.body);
    expect(rawBody).not.toContain('cache_control');
    const parsedDsMsgBody = JSON.parse(rawBody) as {
      messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    };
    expect(parsedDsMsgBody.messages[1].content[0]).toEqual({
      type: 'thinking',
      thinking: 'DS_MSG_THINK',
      signature: 'sig-ds-1',
    });
    expect(parsedDsMsgBody.messages[1].content[1]).toEqual({
      type: 'tool_use',
      id: 'tu_ds_1',
      name: 'record_active_set',
      input: { reps: 10 },
    });

    const bill = normalizeUsageToBillingRecord({
      id: 'bill-ds-msg-1',
      threadId: 'th-1',
      segmentId: 'seg-1',
      round: 0,
      purpose: 'coach_turn',
      capabilities: dsMsgCaps,
      rawUsage: {
        input_tokens: 100,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
      },
    });
    expect(bill.providerKind).toBe('anthropic');
    expect(bill.currency).toBe('CNY');
    expect(bill.uncachedInputTokens).toBe(100);
    expect(bill.cachedInputTokens).toBe(2000);
    expect(bill.inputTokens).toBe(2100);
    expect(bill.outputTokens).toBe(50);
    // 100 * 2 + 2000 * 0.04 + 50 * 8 = 200 + 80 + 400 = 680 / 1e6 = 0.00068
    expect(bill.computedCostUsd).toBeCloseTo(0.00068, 8);

    const customAntProxy = resolveProviderCapabilities({
      kind: 'anthropic',
      baseUrl: 'https://my-proxy.example.com/v1',
      model: 'claude-sonnet-4-5',
    });
    expect(customAntProxy.upstreamFamily).toBe('custom-proxy');
    expect(customAntProxy.pricing.currency).toBe('unknown');
    expect(customAntProxy.sendCacheControlBreakpoints).toBe(false);

    const customGemProxy = resolveProviderCapabilities({
      kind: 'gemini',
      baseUrl: 'https://my-proxy.example.com/v1beta',
      model: 'gemini-2.5-flash',
    });
    expect(customGemProxy.upstreamFamily).toBe('custom-proxy');
    expect(customGemProxy.pricing.currency).toBe('unknown');
    expect(customGemProxy.sendCacheControlBreakpoints).toBe(false);
  });
});
