/* 电子教练统一模型与工具契约（薄窄接口，支持自定义 fetch、流式与 AbortSignal 取消）。
   与 @earendil-works/pi-ai 的工具与流式语义对齐，但避免引入重型 Node/SDK 依赖（~550kB/provider），
   并支持不传 JS 明文 apiKey（由受限原生网络层或自定义 fetch 注入鉴权头）。 */

export type CoachProviderKind = 'openai-compatible' | 'gemini';
export const COACH_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CoachThinkingDepth = 'default' | (typeof COACH_THINKING_LEVELS)[number];

export function coachThinkingLabel(depth: CoachThinkingDepth): string {
  if (depth === 'default') return '跟随模型';
  if (depth === 'xhigh') return 'XHigh';
  return depth[0].toUpperCase() + depth.slice(1);
}

export interface CoachRemoteModel {
  id: string;
  displayName?: string;
  ownedBy?: string;
  thinkingLevels?: CoachThinkingDepth[];
}

export interface CoachToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface CoachToolCall {
  id: string;
  name: string;
  argumentsText: string;
  arguments: Record<string, unknown>;
  /** 若参数 JSON 畸形/截断，保留解析错误信息以便上层显式拦截而不静默吞错 */
  parseError?: string;
  thoughtSignature?: string;
}

export type CoachContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; dataBase64: string }
  | { type: 'video'; mimeType: string; dataBase64: string };

export type CoachTurnMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; parts: CoachContentPart[] }
  | { role: 'assistant'; text: string; reasoning?: string; toolCalls?: CoachToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface CoachProviderConfig {
  kind: CoachProviderKind;
  baseUrl: string;
  model: string;
  /** 可选；受限原生网络层模式下可省略，由自定义 fetch / 原生侧注入鉴权头 */
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export type CoachStreamEvent =
  | { type: 'title'; title: string }
  | { type: 'thinking_fallback' }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; call: CoachToolCall }
  | {
      type: 'done';
      finishReason: string;
      text: string;
      reasoning?: string;
      toolCalls: CoachToolCall[];
    };

export interface CoachStreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  thinkingDepth?: CoachThinkingDepth;
  requestTitle?: boolean;
  allowThinkingFallback?: boolean;
}

export function normalizeProviderBaseUrl(kind: CoachProviderKind, baseUrl: string): string {
  let clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (kind === 'openai-compatible') {
    clean = clean.replace(/\/(?:chat\/completions|models)$/i, '');
  } else {
    clean = clean.replace(/\/models$/i, '');
  }
  return clean.replace(/\/+$/, '');
}

type ModelIdentity = Pick<CoachProviderConfig, 'kind' | 'baseUrl' | 'model'>;

export function coachModelKey(config: ModelIdentity): string {
  return JSON.stringify([config.kind, normalizeProviderBaseUrl(config.kind, config.baseUrl), config.model.trim()]);
}

export function isOfficialDeepSeek(config: ModelIdentity): boolean {
  try {
    return config.kind === 'openai-compatible' &&
      new URL(config.baseUrl).origin === 'https://api.deepseek.com';
  } catch {
    return false;
  }
}

export function supportsCoachTitle(config: ModelIdentity): boolean {
  return isOfficialDeepSeek(config) && /^(deepseek-flash|deepseek-v4-pro)$/.test(config.model);
}

export function coachThinkingLevels(config: ModelIdentity): CoachThinkingDepth[] {
  const model = config.model.toLowerCase();
  if (isOfficialDeepSeek(config)) {
    if (/^(deepseek-flash|deepseek-v4-(?:flash|pro))$/.test(model)) return ['off', 'low', 'high', 'max'];
    return [];
  }
  if (config.kind === 'gemini') {
    if (/^gemini-3(?:\.\d+)?-flash/.test(model)) return ['minimal', 'low', 'medium', 'high'];
    if (/^gemini-3\.1-pro/.test(model)) return ['low', 'medium', 'high'];
    if (/^gemini-3-pro/.test(model)) return ['low', 'high'];
    if (/^gemini-2\.5-pro/.test(model)) return ['low', 'medium', 'high'];
    if (/^gemini-2\.5-flash/.test(model)) return ['off', 'low', 'medium', 'high'];
  }
  if (config.kind === 'openai-compatible' && /^https:\/\/api\.openai\.com(?:\/|$)/i.test(config.baseUrl)) {
    if (/^gpt-5\.6(?:-|$)/.test(model)) return ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-5\.(?:2|4)(?:-|$)/.test(model) && !model.includes('-pro')) return ['off', 'low', 'medium', 'high', 'xhigh'];
    if (/^gpt-5(?:-mini|-nano|-20\d\d|$)/.test(model)) return ['minimal', 'low', 'medium', 'high'];
    if (/^o[34](?:-|$)/.test(model)) return ['low', 'medium', 'high'];
  }
  return [];
}

function buildProviderHeaders(
  config: Pick<CoachProviderConfig, 'kind' | 'apiKey' | 'headers'>,
  includeJsonContentType = true,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(includeJsonContentType ? { 'Content-Type': 'application/json' } : {}),
    ...(config.headers ?? {}),
  };
  if (config.apiKey) {
    if (config.kind === 'gemini') {
      if (!headers['x-goog-api-key'] && !headers['X-Goog-Api-Key']) {
        headers['x-goog-api-key'] = config.apiKey;
      }
    } else if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }
  return headers;
}

function extractModelEntry(raw: unknown): CoachRemoteModel | null {
  if (typeof raw === 'string') {
    const id = raw.trim().replace(/^models\//, '');
    return id ? { id } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawId = typeof obj.id === 'string' ? obj.id : typeof obj.name === 'string' ? obj.name : '';
  const id = rawId.trim().replace(/^models\//, '');
  if (!id) return null;
  const displayName = typeof obj.displayName === 'string' ? obj.displayName.trim() : undefined;
  const ownedBy = typeof obj.owned_by === 'string' ? obj.owned_by.trim() : undefined;
  const effort = obj.effort as { supported_levels?: unknown; can_disable?: unknown } | undefined;
  const advertised = effort?.supported_levels;
  const allowOff = effort?.can_disable === true || ownedBy?.toLowerCase() === 'deepseek';
  const thinkingLevels = Array.isArray(advertised)
    ? COACH_THINKING_LEVELS.filter((level) =>
        advertised.includes(level) || (level === 'off' && (allowOff || advertised.includes('none'))))
    : undefined;
  return {
    id,
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(displayName && displayName !== id ? { displayName } : {}),
    ...(ownedBy ? { ownedBy } : {}),
  };
}

/**
 * 拉取当前服务商可用模型列表（OpenAI-Compatible `/models` 与 Gemini `/models?pageSize=200`）。
 */
export async function fetchProviderModels(
  config: Pick<CoachProviderConfig, 'kind' | 'baseUrl' | 'apiKey' | 'headers' | 'fetch'>,
  signal?: AbortSignal,
): Promise<CoachRemoteModel[]> {
  const base = normalizeProviderBaseUrl(config.kind, config.baseUrl);
  if (!base) {
    throw new Error('请先填写请求地址（Base URL）');
  }
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('缺少可用的 fetch 实现');
  }

  const url = config.kind === 'gemini' ? `${base}/models?pageSize=200` : `${base}/models`;
  const headers = buildProviderHeaders(config, false);
  const res = await fetchFn(url, { method: 'GET', headers, signal });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`获取模型列表失败 (${res.status}): ${errText.slice(0, 200) || res.statusText}`);
  }

  const payload = (await res.json()) as unknown;
  let candidates: unknown[] = [];
  if (Array.isArray(payload)) {
    candidates = payload;
  } else if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.data)) candidates = rec.data;
    else if (Array.isArray(rec.models)) candidates = rec.models;
  }

  const byId = new Map<string, CoachRemoteModel>();
  for (const raw of candidates) {
    if (config.kind === 'gemini' && raw && typeof raw === 'object') {
      const methods = (raw as Record<string, unknown>).supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes('generateContent')) {
        continue;
      }
    }
    const parsed = extractModelEntry(raw);
    if (parsed && !byId.has(parsed.id)) {
      byId.set(parsed.id, parsed);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function safeJsonParseObject(raw: string): {
  value: Record<string, unknown>;
  parseError?: string;
} {
  if (!raw.trim()) return { value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown> };
    }
    return {
      value: {},
      parseError: '工具参数 JSON 必须是对象',
    };
  } catch (err) {
    return {
      value: {},
      parseError: `工具参数 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function buildOpenAICompatibleRequest(
  config: CoachProviderConfig,
  messages: CoachTurnMessage[],
  tools: CoachToolDefinition[],
  options?: CoachStreamOptions,
): { url: string; init: RequestInit } {
  const base = normalizeProviderBaseUrl('openai-compatible', config.baseUrl);
  const url = `${base}/chat/completions`;
  const mappedMessages = messages.map((m) => {
    if (m.role === 'system') {
      return { role: 'system', content: m.text };
    }
    if (m.role === 'user') {
      if (m.parts.length === 1 && m.parts[0].type === 'text') {
        return { role: 'user', content: m.parts[0].text };
      }
      return {
        role: 'user',
        content: m.parts.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : p.type === 'video'
              ? {
                  type: 'video_url',
                  video_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
                }
              : {
                  type: 'image_url',
                  image_url: { url: `data:${p.mimeType};base64,${p.dataBase64}` },
                },
        ),
      };
    }
    if (m.role === 'assistant') {
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: m.text || null,
      };
      if (isOfficialDeepSeek(config) && m.reasoning !== undefined) msg.reasoning_content = m.reasoning;
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.argumentsText || JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      return msg;
    }
    return {
      role: 'tool',
      tool_call_id: m.toolCallId,
      content: m.content,
    };
  });

  const reasoningEffort =
    options?.thinkingDepth === 'off'
      ? 'none'
      : options?.thinkingDepth && options.thinkingDepth !== 'default'
        ? options.thinkingDepth
        : undefined;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: mappedMessages,
    stream: true,
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(isOfficialDeepSeek(config) && reasoningEffort
      ? { thinking: { type: reasoningEffort === 'none' ? 'disabled' : 'enabled' } }
      : {}),
    ...(options?.requestTitle && supportsCoachTitle(config) ? { title: { enabled: true } } : {}),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  const headers = buildProviderHeaders({ ...config, kind: 'openai-compatible' });

  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    },
  };
}

function buildGeminiThinkingConfig(
  model: string,
  depth?: CoachThinkingDepth,
): Record<string, unknown> | undefined {
  if (!depth || depth === 'default' || depth === 'xhigh' || depth === 'max') return undefined;
  const includeThoughts = depth !== 'off';
  if (/gemini-3/i.test(model)) {
    if (depth === 'off') return undefined;
    const levelMap: Record<Exclude<CoachThinkingDepth, 'default' | 'xhigh' | 'max'>, string> = {
      off: 'MINIMAL',
      minimal: 'MINIMAL',
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
    };
    return { thinkingLevel: levelMap[depth], includeThoughts };
  }
  const budgetMap: Record<Exclude<CoachThinkingDepth, 'default' | 'xhigh' | 'max'>, number> = {
    off: 0,
    minimal: 512,
    low: 1024,
    medium: 8192,
    high: 24576,
  };
  return { thinkingBudget: budgetMap[depth], includeThoughts };
}

export function buildGeminiRequest(
  config: CoachProviderConfig,
  messages: CoachTurnMessage[],
  tools: CoachToolDefinition[],
  options?: CoachStreamOptions,
): { url: string; init: RequestInit } {
  const base = normalizeProviderBaseUrl('gemini', config.baseUrl);
  const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
  const url = `${base}/${modelPath}:streamGenerateContent?alt=sse`;

  const systemTexts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.text);
      continue;
    }
    if (m.role === 'user') {
      contents.push({
        role: 'user',
        parts: m.parts.map((p) =>
          p.type === 'text'
            ? { text: p.text }
            : { inlineData: { mimeType: p.mimeType, data: p.dataBase64 } },
        ),
      });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls ?? []) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    const responsePart = {
      functionResponse: {
        name: m.name,
        response: { result: m.content },
      },
    };
    const prev = contents[contents.length - 1];
    // Gemini 协议要求同一轮并行 functionCall 的多个 functionResponse 合并在同一个 user turn 的 parts 中
    if (
      prev &&
      prev.role === 'user' &&
      Array.isArray(prev.parts) &&
      prev.parts.length > 0 &&
      prev.parts.every((p) => typeof p === 'object' && p !== null && 'functionResponse' in p)
    ) {
      (prev.parts as Array<Record<string, unknown>>).push(responsePart);
    } else {
      contents.push({
        role: 'user',
        parts: [responsePart],
      });
    }
  }

  const thinkingConfig = buildGeminiThinkingConfig(config.model, options?.thinkingDepth);
  const generationConfig: Record<string, unknown> = {
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };

  const body: Record<string, unknown> = {
    contents,
    ...(systemTexts.length ? { systemInstruction: { parts: [{ text: systemTexts.join('\n\n') }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
  if (tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const headers = buildProviderHeaders({ ...config, kind: 'gemini' });

  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    },
  };
}

async function* iterateSseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const { value, done } = await reader.read();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          yield line.slice(5).trim();
        }
      }
    }
    if (buffer.startsWith('data:')) {
      yield buffer.slice(5).trim();
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function* streamCoachTurn(
  config: CoachProviderConfig,
  messages: CoachTurnMessage[],
  tools: CoachToolDefinition[],
  options?: CoachStreamOptions,
): AsyncGenerator<CoachStreamEvent> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('缺少可用的 fetch 实现');
  }

  const req =
    config.kind === 'gemini'
      ? buildGeminiRequest(config, messages, tools, options)
      : buildOpenAICompatibleRequest(config, messages, tools, options);

  const response = await fetchFn(req.url, req.init);
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (
      response.status === 400 &&
      options?.thinkingDepth &&
      options.thinkingDepth !== 'default' &&
      !options.signal?.aborted &&
      options.allowThinkingFallback !== false &&
      /reasoning[_ .-]?effort|thinking[_ .-]?(?:config|mode|budget|level)?/i.test(errText) &&
      /unsupported|not supported|unknown|invalid|not allowed|unrecognized/i.test(errText)
    ) {
      yield { type: 'thinking_fallback' };
      yield* streamCoachTurn(config, messages, tools, { ...options, thinkingDepth: 'default' });
      return;
    }
    throw new Error(`模型请求失败 (${response.status}): ${errText.slice(0, 240) || response.statusText}`);
  }
  if (!response.body) {
    throw new Error('模型响应缺少流式 body');
  }

  let fullText = '';
  let fullReasoning = '';
  let finishReason = 'stop';
  const openAiCalls = new Map<number, { id: string; name: string; args: string }>();
  const finalizedCalls: CoachToolCall[] = [];
  let geminiSeq = 0;

  for await (const data of iterateSseLines(response.body, options?.signal)) {
    if (!data || data === '[DONE]') continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (config.kind === 'gemini') {
      const candidates = (payload.candidates as Array<Record<string, unknown>> | undefined) ?? [];
      const first = candidates[0];
      if (!first) continue;
      if (typeof first.finishReason === 'string') {
        finishReason = first.finishReason;
      }
      const content = first.content as { parts?: Array<Record<string, unknown>> } | undefined;
      for (const part of content?.parts ?? []) {
        if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
          fullReasoning += part.text;
          yield { type: 'reasoning_delta', delta: part.text };
          continue;
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          fullText += part.text;
          yield { type: 'text_delta', delta: part.text };
        }
        const fc = part.functionCall as { name?: string; args?: Record<string, unknown> } | undefined;
        if (fc?.name) {
          const call: CoachToolCall = {
            id: 'gem_call_' + crypto.randomUUID() + '_' + ++geminiSeq,
            name: fc.name,
            argumentsText: JSON.stringify(fc.args ?? {}),
            arguments: fc.args ?? {},
            ...(typeof part.thoughtSignature === 'string' ? { thoughtSignature: part.thoughtSignature } : {}),
          };
          finalizedCalls.push(call);
          yield { type: 'tool_call', call };
        }
      }
      continue;
    }

    // OpenAI-compatible SSE chunk
    const choices = (payload.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const choice = choices[0];
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (typeof delta.title === 'string' && delta.title.trim()) yield { type: 'title', title: delta.title };
    const reasoningDelta =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (reasoningDelta.length > 0) {
      fullReasoning += reasoningDelta;
      yield { type: 'reasoning_delta', delta: reasoningDelta };
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      fullText += delta.content;
      yield { type: 'text_delta', delta: delta.content };
    }
    const tcDeltas = (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
    for (const tc of tcDeltas) {
      const index = typeof tc.index === 'number' ? tc.index : 0;
      const existing = openAiCalls.get(index) ?? {
        id: typeof tc.id === 'string' ? tc.id : `call_${index}`,
        name: '',
        args: '',
      };
      if (typeof tc.id === 'string' && tc.id) existing.id = tc.id;
      const fn = tc.function as { name?: string; arguments?: string } | undefined;
      if (typeof fn?.name === 'string' && fn.name) existing.name += fn.name;
      if (typeof fn?.arguments === 'string' && fn.arguments) existing.args += fn.arguments;
      openAiCalls.set(index, existing);
    }
  }

  if (config.kind === 'openai-compatible' && openAiCalls.size > 0) {
    const ordered = [...openAiCalls.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, raw] of ordered) {
      const parsed = safeJsonParseObject(raw.args);
      const call: CoachToolCall = {
        id: raw.id,
        name: raw.name,
        argumentsText: raw.args,
        arguments: parsed.value,
        ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
      };
      finalizedCalls.push(call);
      yield { type: 'tool_call', call };
    }
  }

  yield {
    type: 'done',
    finishReason,
    text: fullText,
    ...(fullReasoning ? { reasoning: fullReasoning } : {}),
    toolCalls: finalizedCalls,
  };
}
