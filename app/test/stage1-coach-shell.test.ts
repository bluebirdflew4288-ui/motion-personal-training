/* 阶段 1 · 双窗外壳几何、四层物理返回调度、与薄窄模型适配接口单元测试。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeDefaultMiniRect,
  computeMiniGeometry,
  MINI_CHROME_BOTTOM_PX,
  MINI_CHROME_TOP_PX,
  MINI_MIN_WIDTH,
  MINI_PIP_WIDTH,
  resizeMiniFromHandle,
  toggleMiniPresetWidth,
  type ViewportMetrics,
} from '../src/coach/windowState';
import {
  buildGeminiRequest,
  buildOpenAICompatibleRequest,
  streamCoachTurn,
  type CoachStreamEvent,
  type CoachToolDefinition,
} from '../src/coach/providerAdapter';
import { backStack } from '../src/lib/backIntent';
import {
  handleBackIntent,
  registerCoachBackHandler,
  registerPageLeaveGuard,
} from '../src/lib/nativeBack';
import { buildBackup, CURRENT_APP_VERSION } from '../src/db/repo';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('阶段 1 · 双窗小窗几何与等比缩放', () => {
  const vp: ViewportMetrics = { width: 390, height: 844, visibleBottom: 844, safeTop: 24 };

  it('默认小窗落在安全右上区域，宽度≥204、极简顶底横条 24/18px 且避开顶栏动作底边', () => {
    const rect = computeDefaultMiniRect(vp);
    const geo = computeMiniGeometry(rect, vp);
    expect(MINI_MIN_WIDTH).toBeGreaterThanOrEqual(204);
    expect(MINI_CHROME_TOP_PX).toBe(24);
    expect(MINI_CHROME_BOTTOM_PX).toBe(18);
    expect(geo.width).toBeGreaterThanOrEqual(MINI_MIN_WIDTH);
    expect(geo.x).toBeGreaterThanOrEqual(8);
    expect(geo.x + geo.width).toBeLessThanOrEqual(vp.width - 8);
    expect(geo.y).toBeGreaterThanOrEqual(vp.safeTop + 72);
    expect(geo.scale).toBeCloseTo(geo.width / geo.logicalWidth, 4);
    expect(geo.totalHeight).toBe(geo.contentHeight + MINI_CHROME_TOP_PX + MINI_CHROME_BOTTOM_PX);
  });

  it('toggleMiniPresetWidth 在 360px 荣耀真机与 390px 视口下切换清晰且差值 ≥32px', () => {
    for (const testVp of [
      { width: 360, height: 800, visibleBottom: 800, safeTop: 24 },
      vp,
    ]) {
      const defRect = computeDefaultMiniRect(testVp);
      const expandedRect = toggleMiniPresetWidth(defRect, testVp);
      expect(expandedRect.width - defRect.width).toBeGreaterThanOrEqual(32);

      const backToDef = toggleMiniPresetWidth(expandedRect, testVp);
      expect(backToDef.width).toBe(defRect.width);

      const compactRect = { ...defRect, width: MINI_MIN_WIDTH };
      const fromCompact = toggleMiniPresetWidth(compactRect, testVp);
      expect(fromCompact.width).toBe(defRect.width);
      expect(defRect.width - MINI_MIN_WIDTH).toBeGreaterThanOrEqual(32);
    }
  });

  it('缩放把手上滑缩小、下拉放大，始终等比并受边界夹取', () => {
    const base = computeDefaultMiniRect(vp);
    const smaller = resizeMiniFromHandle(base, -140, vp);
    const larger = resizeMiniFromHandle(base, 180, vp);
    expect(smaller.width).toBeLessThan(base.width);
    expect(smaller.width).toBeGreaterThanOrEqual(MINI_MIN_WIDTH);
    expect(larger.width).toBeGreaterThan(base.width);
    expect(smaller.aspect).toBe(base.aspect);
    expect(larger.aspect).toBe(base.aspect);
  });

  it('迷你悬浮窗模式支持 112px 停靠顶角等比几何并保持常规模式底限 ≥204', () => {
    expect(MINI_PIP_WIDTH).toBe(112);
    const pipRect = { x: vp.width - MINI_PIP_WIDTH - 10, y: vp.safeTop + 12, width: MINI_PIP_WIDTH, aspect: 1.46 };
    const pipGeo = computeMiniGeometry(pipRect, vp, true);
    expect(pipGeo.width).toBe(MINI_PIP_WIDTH);
    expect(pipGeo.scale).toBeCloseTo(MINI_PIP_WIDTH / 375, 4);
    expect(pipGeo.x + pipGeo.width).toBeLessThanOrEqual(vp.width - 8);

    const normalClamped = computeMiniGeometry(pipRect, vp, false);
    expect(normalClamped.width).toBeGreaterThanOrEqual(MINI_MIN_WIDTH);
  });

  it('软键盘弹出压缩 visibleBottom 时小窗自动上收避免遮挡底部输入行', () => {
    const base = computeDefaultMiniRect(vp);
    const pushedDown = { ...base, y: 500 };
    const kbVp: ViewportMetrics = { ...vp, visibleBottom: 480 };
    const geo = computeMiniGeometry(pushedDown, kbVp);
    expect(geo.y + geo.totalHeight).toBeLessThanOrEqual(kbVp.visibleBottom - 8);
  });
});

describe('阶段 1 · Android 四层物理返回调度', () => {
  afterEach(() => {
    backStack.__resetForTest();
    registerPageLeaveGuard(null);
  });

  it('按严格四层顺序每次只消费一层：弹层 -> 收键盘 -> 教练退小窗/最小化 -> 业务离开', async () => {
    const events: string[] = [];
    let modalOpen = true;
    const popLayer = backStack.push({
      id: 'preview-modal',
      handle: () => {
        modalOpen = false;
        events.push('close-modal');
        return true;
      },
    });

    let focused = true;
    const origDoc = globalThis.document;
    vi.stubGlobal('document', {
      activeElement: {
        tagName: 'TEXTAREA',
        isContentEditable: false,
        blur: () => {
          focused = false;
          events.push('blur-ime');
        },
      },
    });

    let coachState: 'primary' | 'mini' | 'minimized' = 'primary';
    const unregCoach = registerCoachBackHandler(() => {
      if (coachState === 'primary') {
        coachState = 'mini';
        events.push('coach-to-mini');
        return true;
      }
      if (coachState === 'mini') {
        coachState = 'minimized';
        events.push('coach-to-minimized');
        return true;
      }
      return false;
    });

    registerPageLeaveGuard(() => {
      events.push('leave-guard-allow');
      return true;
    });

    try {
      // 1) 第 1 层：关最上层图片预览/弹层
      expect(await handleBackIntent()).toEqual({ action: 'layer' });
      expect(modalOpen).toBe(false);
      popLayer();

      // 2) 第 2 层：收起输入法
      expect(await handleBackIntent()).toEqual({ action: 'keyboard' });
      expect(focused).toBe(false);
      vi.stubGlobal('document', { activeElement: null });

      // 3a) 第 3 层：教练主屏 -> 退回角落小窗
      expect(await handleBackIntent()).toEqual({ action: 'coach' });
      expect(coachState).toBe('mini');

      // 3b) 第 3 层：教练小窗 -> 最小化
      expect(await handleBackIntent()).toEqual({ action: 'coach' });
      expect(coachState).toBe('minimized');

      // 4) 第 4 层：教练已最小化，走到业务 leaveGuard -> exit（当前在首页）
      vi.stubGlobal('window', { location: { hash: '#/' } });
      expect(await handleBackIntent()).toEqual({ action: 'exit' });

      expect(events).toEqual([
        'close-modal',
        'blur-ime',
        'coach-to-mini',
        'coach-to-minimized',
        'leave-guard-allow',
      ]);
    } finally {
      unregCoach();
      vi.unstubAllGlobals();
      if (origDoc) globalThis.document = origDoc;
    }
  });

  it('页面内返回按钮传入 handleCoach:false 时跳过第 3 层教练小窗，直接走业务返回', async () => {
    let coachCalled = false;
    const unreg = registerCoachBackHandler(() => {
      coachCalled = true;
      return true;
    });
    vi.stubGlobal('window', { location: { hash: '#/session/s1' }, history: { length: 2, back: vi.fn() } });
    try {
      const r = await handleBackIntent({ handleCoach: false });
      expect(coachCalled).toBe(false);
      expect(r).toEqual({ action: 'page' });
    } finally {
      unreg();
      vi.unstubAllGlobals();
    }
  });

  it('教练隐藏态（minimized/closed）释放大图预览 backStack 后不再吞掉后续返回键，且 UndoStack 监听 paneRole', async () => {
    let previewSwallowed = false;
    const popPreview = backStack.push({
      id: 'coach-preview:test',
      handle: () => {
        previewSwallowed = true;
        return true;
      },
    });
    // 模拟 CoachPane 在 coachVisibility 为 closed/minimized 时清空 previewAttachment 并触发 backStack cleanup
    popPreview();
    vi.stubGlobal('window', { location: { hash: '#/session/s1' }, history: { length: 2, back: vi.fn() } });
    try {
      const r = await handleBackIntent();
      expect(previewSwallowed).toBe(false);
      expect(r).toEqual({ action: 'page' });
    } finally {
      vi.unstubAllGlobals();
    }

    const coachPaneSrc = readFileSync(resolve(process.cwd(), 'src/coach/CoachPane.tsx'), 'utf8');
    expect(coachPaneSrc).toMatch(/dual\.coachVisibility === 'closed' \|\| dual\.coachVisibility === 'minimized'/);
    expect(coachPaneSrc).toContain('setPreviewAttachment(null)');

    const undoStackSrc = readFileSync(resolve(process.cwd(), 'src/ui/UndoStack.tsx'), 'utf8');
    expect(undoStackSrc).toContain('[items.length, paneRole]');
  });
});

describe('阶段 1 · 薄窄模型接口（图片多模态 + 工具调用 + 自定义 fetch + 中途取消）', () => {
  const sampleTools: CoachToolDefinition[] = [
    {
      name: 'extract_plan_draft',
      description: '从训练计划图提取结构化草稿',
      parameters: {
        type: 'object',
        properties: {
          planName: { type: 'string' },
          exercises: { type: 'array', items: { type: 'string' } },
        },
        required: ['planName', 'exercises'],
      },
    },
  ];

  it('支持自定义 fetch 注入鉴权且 JS 请求体/头不强迫携带明文 apiKey', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const customFetch: typeof fetch = async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"extract_plan_draft","arguments":"{\\"planName\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"推胸日\\",\\"exercises\\":[\\"卧推\\"]}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const reqBuilt = buildOpenAICompatibleRequest(
      { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'demo-vision', fetch: customFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '识别计划图' }, { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }] }],
      sampleTools,
    );
    expect((reqBuilt.init.headers as Record<string, string>).Authorization).toBeUndefined();

    const events: string[] = [];
    let toolArgs: Record<string, unknown> | null = null;
    for await (const ev of streamCoachTurn(
      { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'demo-vision', fetch: customFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '识别计划图' }, { type: 'image', mimeType: 'image/png', dataBase64: 'AAAA' }] }],
      sampleTools,
    )) {
      events.push(ev.type);
      if (ev.type === 'tool_call') toolArgs = ev.call.arguments;
    }

    expect(capturedHeaders?.Authorization).toBeUndefined();
    expect(events).toEqual(['tool_call', 'done']);
    expect(toolArgs).toEqual({ planName: '推胸日', exercises: ['卧推'] });
  });

  it('Gemini 适配支持自定义 fetch、inlineData 图片与流式工具返回', async () => {
    const gemReq = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
      [{ role: 'user', parts: [{ type: 'image', mimeType: 'image/png', dataBase64: 'BBBB' }, { type: 'text', text: '解析' }] }],
      sampleTools,
    );
    expect(gemReq.url).toContain('models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect((gemReq.init.headers as Record<string, string>)['x-goog-api-key']).toBeUndefined();

    const customFetch: typeof fetch = async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"extract_plan_draft","args":{"planName":"拉背日","exercises":["高位下拉"]}}}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"已为您识别并整理好拉背日草稿。"}]},"finishReason":"STOP"}]}\n\n',
      ]);

    let text = '';
    const calls: string[] = [];
    for await (const ev of streamCoachTurn(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', fetch: customFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '解析' }] }],
      sampleTools,
    )) {
      if (ev.type === 'text_delta') text += ev.delta;
      if (ev.type === 'tool_call') calls.push(ev.call.name);
    }
    expect(calls).toEqual(['extract_plan_draft']);
    expect(text).toBe('已为您识别并整理好拉背日草稿。');
  });

  it('支持 AbortController 中途取消流式输出', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const slowFetch: typeof fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'));
          setTimeout(() => {
            try {
              ctrl.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第二段"}}]}\n\n'));
              ctrl.close();
            } catch {
              /* aborted */
            }
          }, 500);
        },
      });
      return new Response(stream, { status: 200 });
    };

    let received = '';
    let aborted = false;
    try {
      for await (const ev of streamCoachTurn(
        { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'demo', fetch: slowFetch },
        [{ role: 'user', parts: [{ type: 'text', text: '测试取消' }] }],
        [],
        { signal: controller.signal },
      )) {
        if (ev.type === 'text_delta') {
          received += ev.delta;
          controller.abort();
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') aborted = true;
    }

    expect(received).toBe('第一段');
    expect(aborted).toBe(true);
  });

  it('畸形或截断的 tool_call JSON 返回 malformed_tool_call 且整批阻断不放出调用', async () => {
    const badFetch: typeof fetch = async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","function":{"name":"extract_plan_draft","arguments":"{\\"planName\\":\\"未闭合"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ]);

    const calls = [];
    let doneEv: Extract<CoachStreamEvent, { type: 'done' }> | undefined;
    for await (const ev of streamCoachTurn(
      { kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'demo', fetch: badFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '测试畸形参数' }] }],
      sampleTools,
    )) {
      if (ev.type === 'tool_call') calls.push(ev.call);
      if (ev.type === 'done') doneEv = ev;
    }
    expect(calls).toHaveLength(0);
    expect(doneEv?.outcomeKind).toBe('malformed_tool_call');
    expect(doneEv?.errorMessage).toBeTruthy();
    expect(doneEv?.toolCalls).toEqual([]);
  });

  it('Gemini 连续多条 role=tool 回传合并到同一个 user turn 的 parts 数组并配对服务端 ID', () => {
    const gemReq = buildGeminiRequest(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
      [
        { role: 'user', parts: [{ type: 'text', text: '查两次' }] },
        {
          role: 'assistant',
          text: '',
          toolCalls: [
            { id: 'c1', name: 'tool_a', argumentsText: '{}', arguments: {} },
            { id: 'c2', name: 'tool_b', argumentsText: '{}', arguments: {} },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'tool_a', content: '{"a":1}' },
        { role: 'tool', toolCallId: 'c2', name: 'tool_b', content: '{"b":2}' },
      ],
      sampleTools,
    );
    const body = JSON.parse(String(gemReq.init.body)) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents).toHaveLength(3);
    expect(body.contents[2].role).toBe('user');
    expect(body.contents[2].parts).toHaveLength(2);
    expect(body.contents[2].parts[0]).toEqual({
      functionResponse: { id: 'c1', name: 'tool_a', response: { result: '{"a":1}' } },
    });
    expect(body.contents[2].parts[1]).toEqual({
      functionResponse: { id: 'c2', name: 'tool_b', response: { result: '{"b":2}' } },
    });
  });

  it('BackupPayload v4 导出绝不包含教练聊天、图片或 API Key 字段', async () => {
    const payload = await buildBackup(CURRENT_APP_VERSION);
    const json = JSON.stringify(payload);
    expect(payload.version).toBe(4);
    expect(json).not.toContain('coachMessages');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('demoReceipt');
  });
});
