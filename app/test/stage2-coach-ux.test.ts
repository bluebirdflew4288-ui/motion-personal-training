import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findV4Contraband } from '../src/db/backupCompat';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, CURRENT_APP_VERSION, savePlan } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import { compressCoachContext, runCoachTurn } from '../src/coach/coachAgent';
import { COACH_MAX_VIDEO_BYTES, prepareCoachVideo } from '../src/coach/coachImage';
import {
  COACH_VAULT_DB_NAME,
  loadCoachMessages,
  loadCoachThreadsState,
  resetCoachVaultForTest,
  saveCoachMessages,
  saveCoachProviderConfig,
  saveCoachThreadsState,
} from '../src/coach/coachStorage';
import {
  buildGeminiRequest,
  buildOpenAICompatibleRequest,
  fetchProviderModels,
  normalizeProviderBaseUrl,
  streamCoachTurn,
} from '../src/coach/providerAdapter';

const NOW = 1_766_000_000_000;

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('电子教练基础体验升级：拉取模型 / 思考深度 / 视频媒体 / 多会话压缩', () => {
  beforeEach(async () => {
    await resetCoachVaultForTest();
    __resetDbHandle();
    await idbClear('plans');
    await idbClear('sessions');
    await idbClear('settings');
    await idbClear('meta');
  });

  it('normalizeProviderBaseUrl 与 fetchProviderModels 支持 OpenAI-Compatible 与 Gemini 双协议', async () => {
    expect(
      normalizeProviderBaseUrl('openai-compatible', 'https://proxy.example.com/v1/chat/completions/'),
    ).toBe('https://proxy.example.com/v1');
    expect(normalizeProviderBaseUrl('gemini', 'https://generativelanguage.googleapis.com/v1beta/models')).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );

    const openAiFetch = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('https://proxy.example.com/v1/models');
      return new Response(
        JSON.stringify({
          data: [
            { id: 'gpt-4.1-mini', owned_by: 'openai' },
            { id: 'deepseek-reasoner', owned_by: 'deepseek' },
            { id: 'gpt-4.1-mini', owned_by: 'openai' },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const oaModels = await fetchProviderModels({
      kind: 'openai-compatible',
      baseUrl: 'https://proxy.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      fetch: openAiFetch,
    });
    expect(oaModels.map((m) => m.id)).toEqual(['deepseek-reasoner', 'gpt-4.1-mini']);

    const gemFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://gem.example.com/v1beta/models?pageSize=200');
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('gm-test');
      return new Response(
        JSON.stringify({
          models: [
            {
              name: 'models/embedding-001',
              displayName: 'Embedding',
              supportedGenerationMethods: ['embedContent'],
            },
            {
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const gemModels = await fetchProviderModels({
      kind: 'gemini',
      baseUrl: 'https://gem.example.com/v1beta',
      apiKey: 'gm-test',
      fetch: gemFetch,
    });
    expect(gemModels).toEqual([{ id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }]);
  });

  it('思考深度序列化（OpenAI / Gemini 2.5 / Gemini 3）、流式推理解析与 400 自动降级重试', async () => {
    const oaDefault = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm1' },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'default' },
    );
    expect(JSON.parse(String(oaDefault.init.body)).reasoning_effort).toBeUndefined();

    const oaHigh = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm1' },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'high' },
    );
    expect(JSON.parse(String(oaHigh.init.body)).reasoning_effort).toBe('high');

    const oaOff = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'm1' },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'off' },
    );
    expect(JSON.parse(String(oaOff.init.body)).reasoning_effort).toBe('none');

    const gem25 = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-flash' },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'medium' },
    );
    expect(JSON.parse(String(gem25.init.body)).generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });

    const gem3 = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'gemini-3-flash' },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'low' },
    );
    expect(JSON.parse(String(gem3.init.body)).generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'LOW',
      includeThoughts: true,
    });

    // 若非思考模型因携带 reasoning_effort 返回 400，应自动回退 default 重试一次
    let attempts = 0;
    const fallbackFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body));
      if (attempts === 1) {
        expect(body.reasoning_effort).toBe('high');
        return new Response('Unsupported parameter: reasoning_effort', { status: 400 });
      }
      expect(body.reasoning_effort).toBeUndefined();
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先算容量。"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"建议保持 80kg。"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    }) as unknown as typeof fetch;

    const events: Array<{ type: string; delta?: string; reasoning?: string; text?: string }> = [];
    for await (const ev of streamCoachTurn(
      { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'plain-model', fetch: fallbackFetch },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { thinkingDepth: 'high' },
    )) {
      if (ev.type === 'reasoning_delta') events.push({ type: ev.type, delta: ev.delta });
      else if (ev.type === 'text_delta') events.push({ type: ev.type, delta: ev.delta });
      else if (ev.type === 'done') events.push({ type: ev.type, text: ev.text, reasoning: ev.reasoning });
    }
    expect(attempts).toBe(2);
    expect(events).toEqual([
      { type: 'reasoning_delta', delta: '先算容量。' },
      { type: 'text_delta', delta: '建议保持 80kg。' },
      { type: 'done', text: '建议保持 80kg。', reasoning: '先算容量。' },
    ]);

    // Gemini part.thought 隔离解析
    const gemThoughtFetch = vi.fn(async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"检查动作轨迹"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"下放时再慢一点。"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    ) as unknown as typeof fetch;

    let gemDone: { text: string; reasoning?: string } | null = null;
    for await (const ev of streamCoachTurn(
      { kind: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-pro', fetch: gemThoughtFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '帮我看视频' }] }],
      [],
      { thinkingDepth: 'high' },
    )) {
      if (ev.type === 'done') gemDone = { text: ev.text, reasoning: ev.reasoning };
    }
    expect(gemDone).toEqual({ text: '下放时再慢一点。', reasoning: '检查动作轨迹' });
  });

  it('视频附件请求编码、体积上限拦截、落库去原始 base64 与离线如实降级', async () => {
    const oaVideoReq = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', model: 'v-model' },
      [
        {
          role: 'user',
          parts: [
            { type: 'text', text: '看下动作标准吗' },
            { type: 'video', mimeType: 'video/mp4', dataBase64: 'AAAA' },
          ],
        },
      ],
      [],
    );
    const oaBody = JSON.parse(String(oaVideoReq.init.body));
    expect(oaBody.messages[0].content[1]).toEqual({
      type: 'video_url',
      video_url: { url: 'data:video/mp4;base64,AAAA' },
    });

    const gemVideoReq = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://g.test/v1beta', model: 'gemini-2.5-flash' },
      [
        {
          role: 'user',
          parts: [{ type: 'video', mimeType: 'video/mp4', dataBase64: 'BBBB' }],
        },
      ],
      [],
    );
    const gemBody = JSON.parse(String(gemVideoReq.init.body));
    expect(gemBody.contents[0].parts[0]).toEqual({
      inlineData: { mimeType: 'video/mp4', data: 'BBBB' },
    });

    const tooBig = new File([new Uint8Array(64)], 'squat.mp4', { type: 'video/mp4' });
    await expect(prepareCoachVideo(tooBig, { maxBytes: 32 })).rejects.toThrow(/超过/);
    expect(COACH_MAX_VIDEO_BYTES).toBe(15 * 1024 * 1024);

    const smallVid = new File([new Uint8Array([1, 2, 3, 4])], 'bench.mp4', { type: 'video/mp4' });
    const prepared = await prepareCoachVideo(smallVid);
    expect(prepared.kind).toBe('video');
    expect(prepared.dataBase64.length).toBeGreaterThan(0);

    // 离线引擎收到视频时不误走图片计划解析，如实说明需配置视频模型
    const offlineTurn = await runCoachTurn({
      userText: '',
      attachments: [prepared],
      history: [],
      toolContext: { activeSession: null },
      streamChunkDelayMs: 0,
    });
    expect(offlineTurn.draftPlan).toBeUndefined();
    expect(offlineTurn.text).toContain('视频');

    // 写入隔离库时自动剥离大体积视频 dataBase64，但保留元数据与文本
    await saveCoachMessages([
      {
        id: 'm-vid-1',
        threadId: 'thread-a',
        role: 'user',
        createdAt: NOW,
        text: '深蹲侧面视角',
        attachments: [prepared],
      },
    ]);
    const loaded = await loadCoachMessages();
    expect(loaded[0].attachments?.[0].kind).toBe('video');
    expect(loaded[0].attachments?.[0].name).toBe('bench.mp4');
    expect(loaded[0].attachments?.[0].dataBase64).toBe('');
  });

  it('多对话隔离、上下文压缩与 BackupPayload v4 零污染（保持库版本为 1）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const sess = createSession(plan, plan.days[0], NOW);
    await atomicCreateSession({ session: sess });

    await saveCoachProviderConfig({
      kind: 'openai-compatible',
      baseUrl: 'https://x.test/v1',
      model: 'gpt-4.1-mini',
      models: ['gpt-4.1-mini', 'deepseek-reasoner'],
      thinkingDepth: 'medium',
      apiKey: 'secret-key',
    });

    await saveCoachThreadsState({
      activeThreadId: 'thread-2',
      threads: [
        { id: 'default', title: '默认对话', createdAt: 1, updatedAt: 1 },
        { id: 'thread-2', title: '深蹲专项', createdAt: 2, updatedAt: 2 },
      ],
    });
    const threads = await loadCoachThreadsState();
    expect(threads.activeThreadId).toBe('thread-2');
    expect(threads.threads).toHaveLength(2);

    const threadMsgs = [
      { id: 'u1', threadId: 'thread-2', role: 'user' as const, createdAt: 10, text: '今天深蹲膝盖有点内扣' },
      { id: 'a1', threadId: 'thread-2', role: 'assistant' as const, createdAt: 11, text: '建议降低 10% 重量并外展脚尖' },
      { id: 'u2', threadId: 'thread-2', role: 'user' as const, createdAt: 12, text: '好，我降到 90kg 做了 3 组×5 次' },
      { id: 'a2', threadId: 'thread-2', role: 'assistant' as const, createdAt: 13, text: '完成得不错，继续维持控制节奏' },
    ];
    const comp = await compressCoachContext({ messages: threadMsgs });
    expect(comp.compressedCount).toBe(2);
    expect(comp.summary).toContain('深蹲');
    expect(comp.summary).toContain('10%');

    await saveCoachMessages(threadMsgs);
    const idbCheck = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(COACH_VAULT_DB_NAME, 1);
      req.onsuccess = () => {
        const db = req.result;
        const ver = db.version;
        db.close();
        resolve(ver);
      };
      req.onerror = () => reject(req.error);
    });
    expect(idbCheck).toBe(1);

    const backup = await buildBackup(CURRENT_APP_VERSION);
    expect(findV4Contraband(backup)).toEqual([]);
    expect(JSON.stringify(backup)).not.toContain('secret-key');
    expect(JSON.stringify(backup)).not.toContain('深蹲专项');
  });
});
