/* 电子教练统一三协议模型与工具契约（OpenAI-Compatible / Anthropic Messages / Gemini GenerateContent）。
   设计边界（v0.2.3）：
   1. “OpenAI-compatible”仅选择消息编码器；缓存/思考/usage/费率由 providerCapabilities 决定；
   2. 严格流式完整性校验：
      · 严禁为缺失 id 的 tool_call 伪造 `call_${index}`；
      · 严禁将空字符串 argumentsText 当作 `{}` 放行；
      · `finish_reason / stop_reason / finishReason` 出现 `length` / `max_tokens` / `MAX_TOKENS`，
        或流缺少完整终止信号（EOF）与非法 JSON/重复 ID，一律阻断整批工具调用并返回 explicit outcomeKind；
   3. 原生块与签名完整保留：DeepSeek `reasoning_content` 按能力回传，Anthropic thinking/signature/tool_use
      与 `cache_control` 断点，Gemini 完整 `candidate.content.parts` / `thoughtSignature` / 服务端 `functionCall.id`。 */

import { getCoachFetch } from './coachNativeStream';
import {
  isBailianDeepSeekDeployment,
  resolveProviderCapabilities,
  type ProviderDeploymentCapabilities,
} from './providerCapabilities';

export type CoachProviderKind = 'openai-compatible' | 'anthropic' | 'gemini';
export const COACH_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CoachThinkingDepth = 'default' | (typeof COACH_THINKING_LEVELS)[number];

export type CoachStreamOutcomeKind =
  | 'completed_text'
  | 'completed_tool_calls'
  | 'truncated_eof'
  | 'truncated_max_tokens'
  | 'malformed_tool_call';

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
  contextLength?: number;
}

export interface CoachTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  ttftMs?: number;
  durationMs?: number;
  tokensPerSec?: number;
  rounds?: number;
}

export interface CoachCitation {
  title: string;
  url: string;
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
  operationId?: string;
  index?: number;
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
  | { role: 'system'; text: string; cacheControl?: 'ephemeral' }
  | {
      role: 'user';
      parts: CoachContentPart[];
      cacheControl?: 'ephemeral';
      isSegmentBaseline?: boolean;
    }
  | {
      role: 'assistant';
      text: string;
      reasoning?: string;
      toolCalls?: CoachToolCall[];
      anthropicBlocks?: Array<Record<string, unknown>>;
      geminiParts?: Array<Record<string, unknown>>;
    }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
      cacheControl?: 'ephemeral';
    };

export interface CoachProviderConfig {
  kind: CoachProviderKind;
  presetId?: string;
  deploymentId?: string;
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
      outcomeKind: CoachStreamOutcomeKind;
      errorMessage?: string;
      text: string;
      reasoning?: string;
      toolCalls: CoachToolCall[];
      usage?: CoachTokenUsage;
      rawUsage?: Record<string, unknown>;
      anthropicBlocks?: Array<Record<string, unknown>>;
      geminiParts?: Array<Record<string, unknown>>;
      citations?: CoachCitation[];
    };

export interface CoachStreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  thinkingDepth?: CoachThinkingDepth;
  requestTitle?: boolean;
  allowThinkingFallback?: boolean;
  webSearch?: boolean;
  includeUsage?: boolean;
  promptCacheKey?: string;
  anthropicCacheControl?: boolean;
  capabilities?: ProviderDeploymentCapabilities;
}

export class GeminiGroundingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiGroundingConflictError';
  }
}

export function normalizeProviderBaseUrl(kind: CoachProviderKind, baseUrl: string): string {
  let clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (kind === 'openai-compatible') {
    clean = clean.replace(/\/(?:chat\/completions|models)$/i, '');
  } else if (kind === 'anthropic') {
    clean = clean.replace(/\/(?:messages|models)$/i, '');
  } else {
    clean = clean.replace(/\/models$/i, '');
  }
  return clean.replace(/\/+$/, '');
}

/** 规范化端点 URL（保留完整路由路径与查询串，统一协议和主机名大小写并去掉尾斜杠） */
export function canonicalizeEndpointBaseUrl(kind: CoachProviderKind, baseUrl: string): string {
  const normalized = normalizeProviderBaseUrl(kind, baseUrl);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    const pathname = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathname}${u.search}`;
  } catch {
    return normalized.toLowerCase();
  }
}

type ModelIdentity = Pick<CoachProviderConfig, 'kind' | 'baseUrl' | 'model'> & {
  presetId?: string;
};

export function coachModelKey(config: ModelIdentity): string {
  return JSON.stringify([config.kind, normalizeProviderBaseUrl(config.kind, config.baseUrl), config.model.trim()]);
}

export function isOfficialDeepSeek(config: ModelIdentity): boolean {
  try {
    return (
      config.kind === 'openai-compatible' &&
      new URL(config.baseUrl).origin === 'https://api.deepseek.com'
    );
  } catch {
    return false;
  }
}

export function isBailianDeepSeek(config: ModelIdentity): boolean {
  return (
    config.kind === 'openai-compatible' &&
    isBailianDeepSeekDeployment(config.baseUrl, config.model, config.presetId)
  );
}

export function supportsCoachTitle(config: ModelIdentity): boolean {
  return isOfficialDeepSeek(config) && /^(deepseek-flash|deepseek-v4-pro)$/.test(config.model);
}

export function coachThinkingLevels(config: ModelIdentity): CoachThinkingDepth[] {
  const model = config.model.toLowerCase();
  if (isOfficialDeepSeek(config)) {
    if (/^(deepseek-flash|deepseek-v4-(?:flash|pro))$/.test(model)) return ['off', 'low', 'high', 'max'];
    if (/^deepseek-chat$/i.test(model)) return ['off', 'high'];
    if (/reasoner/i.test(model)) return ['high'];
    return [];
  }
  if (isBailianDeepSeek(config)) {
    if (/r1/i.test(model) && !/v3|v4/i.test(model)) return ['high'];
    return ['off', 'high'];
  }
  if (config.kind === 'anthropic') {
    return ['off', 'low', 'medium', 'high', 'max'];
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
    } else if (config.kind === 'anthropic') {
      if (!headers['x-api-key'] && !headers['X-Api-Key']) {
        headers['x-api-key'] = config.apiKey;
      }
      if (!headers['anthropic-version'] && !headers['Anthropic-Version']) {
        headers['anthropic-version'] = '2023-06-01';
      }
    } else if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  } else if (config.kind === 'anthropic') {
    if (!headers['anthropic-version'] && !headers['Anthropic-Version']) {
      headers['anthropic-version'] = '2023-06-01';
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
  const displayName =
    typeof obj.displayName === 'string'
      ? obj.displayName.trim()
      : typeof obj.display_name === 'string'
        ? obj.display_name.trim()
        : undefined;
  const ownedBy = typeof obj.owned_by === 'string' ? obj.owned_by.trim() : undefined;
  const effort = obj.effort as { supported_levels?: unknown; can_disable?: unknown } | undefined;
  const advertised = effort?.supported_levels;
  const allowOff = effort?.can_disable === true || ownedBy?.toLowerCase() === 'deepseek';
  const thinkingLevels = Array.isArray(advertised)
    ? COACH_THINKING_LEVELS.filter(
        (level) =>
          advertised.includes(level) ||
          (level === 'off' && (allowOff || advertised.includes('none'))),
      )
    : undefined;
  const rawCtxCandidates = [
    obj.context_length,
    obj.max_context_length,
    obj.context_window,
    obj.max_input_tokens,
    obj.inputTokenLimit,
    obj.input_token_limit,
    obj.max_model_len,
  ];
  const contextRaw = rawCtxCandidates.find(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 4096,
  );
  const contextLength = contextRaw !== undefined ? Math.round(contextRaw) : undefined;
  return {
    id,
    ...(thinkingLevels ? { thinkingLevels } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(displayName && displayName !== id ? { displayName } : {}),
    ...(ownedBy ? { ownedBy } : {}),
  };
}

/**
 * 拉取当前服务商可用模型列表（OpenAI `/models`、Anthropic `/models`、Gemini `/models?pageSize=200`）。
 */
export async function fetchProviderModels(
  config: Pick<CoachProviderConfig, 'kind' | 'baseUrl' | 'apiKey' | 'headers' | 'fetch'>,
  signal?: AbortSignal,
): Promise<CoachRemoteModel[]> {
  const base = normalizeProviderBaseUrl(config.kind, config.baseUrl);
  if (!base) {
    throw new Error('请先填写请求地址（Base URL）');
  }
  const fetchFn = config.fetch ?? getCoachFetch();
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

function parseStrictToolArguments(raw: string): {
  value: Record<string, unknown>;
  parseError?: string;
} {
  if (!raw.trim()) {
    return {
      value: {},
      parseError: '工具参数为空字符串（禁止静默当成 {}）',
    };
  }
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
  const caps = options?.capabilities ?? resolveProviderCapabilities(config);

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
      // 严格按能力回传：仅确认需要回传 reasoning_content 的部署/DeepSeek 官方/百炼 DeepSeek 才输出该字段
      if (caps.requiresReasoningReplayWithTools && m.reasoning !== undefined) {
        msg.reasoning_content = m.reasoning;
      }
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

  const depth = options?.thinkingDepth;
  const reasoningEffort =
    depth === 'off' ? 'none' : depth && depth !== 'default' ? depth : undefined;

  const isDs = isOfficialDeepSeek(config);
  const isBailianDs = isBailianDeepSeek(config);
  const wantsUsage =
    options?.includeUsage === true ||
    (options?.includeUsage !== false &&
      (isDs || isBailianDs || caps.upstreamFamily === 'openai'));

  const thinkingPayload: Record<string, unknown> = {};
  if (caps.thinkingControlStyle === 'deepseek_mode' && reasoningEffort) {
    thinkingPayload.thinking = { type: reasoningEffort === 'none' ? 'disabled' : 'enabled' };
    thinkingPayload.reasoning_effort = reasoningEffort;
  } else if (caps.thinkingControlStyle === 'bailian_enable_thinking' && depth && depth !== 'default') {
    thinkingPayload.enable_thinking = depth !== 'off';
  } else if (caps.thinkingControlStyle === 'openai_reasoning_effort' && reasoningEffort) {
    thinkingPayload.reasoning_effort = reasoningEffort;
  } else if (!isBailianDs && reasoningEffort && caps.upstreamFamily === 'custom-proxy') {
    thinkingPayload.reasoning_effort = reasoningEffort;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: mappedMessages,
    stream: true,
    ...(wantsUsage ? { stream_options: { include_usage: true } } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...thinkingPayload,
    ...(caps.upstreamFamily === 'openai' && options?.promptCacheKey
      ? { prompt_cache_key: options.promptCacheKey }
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

/**
 * DeepSeek 官方 Anthropic Messages 兼容入口的思考映射（官方契约，2026-11 核对）：
 * · `budget_tokens` 会被忽略，绝不用它表达强度；
 * · `thinking.type` 显式控制开关，`output_config.effort` 控制推理强度；
 * · off → thinking.type="disabled"（不携带 effort，等价显式关闭）；
 * · low/high/max（及 minimal/medium/xhigh 别名）→ thinking.type="enabled" + output_config.effort；
 * · 省略两字段时官方默认 thinking=enabled、effort=high，故 default 不发送任何思考字段以沿用服务端默认。
 */
function buildDeepSeekMessagesThinkingConfig(
  depth: CoachThinkingDepth | undefined,
  requestedMaxTokens: number,
): { thinking?: Record<string, unknown>; effort?: string; maxTokens: number } {
  if (!depth || depth === 'default') {
    return { maxTokens: requestedMaxTokens };
  }
  if (depth === 'off') {
    return { thinking: { type: 'disabled' }, maxTokens: requestedMaxTokens };
  }
  return { thinking: { type: 'enabled' }, effort: depth, maxTokens: requestedMaxTokens };
}

function buildAnthropicThinkingConfig(
  depth: CoachThinkingDepth | undefined,
  requestedMaxTokens: number,
): { thinking?: Record<string, unknown>; maxTokens: number } {
  if (!depth || depth === 'default' || depth === 'off') {
    return { maxTokens: requestedMaxTokens };
  }
  const budgetMap: Record<Exclude<CoachThinkingDepth, 'default' | 'off'>, number> = {
    minimal: 1024,
    low: 2048,
    medium: 6144,
    high: 12288,
    xhigh: 16384,
    max: 24576,
  };
  const budget = budgetMap[depth];
  const minMax = budget + 4096;
  return {
    thinking: { type: 'enabled', budget_tokens: budget },
    maxTokens: Math.max(requestedMaxTokens, minMax),
  };
}

export function buildAnthropicRequest(
  config: CoachProviderConfig,
  messages: CoachTurnMessage[],
  tools: CoachToolDefinition[],
  options?: CoachStreamOptions,
): { url: string; init: RequestInit } {
  const base = normalizeProviderBaseUrl('anthropic', config.baseUrl);
  const url = `${base}/messages`;
  const caps = options?.capabilities ?? resolveProviderCapabilities(config);
  const enableCacheControl =
    options?.anthropicCacheControl ?? caps.sendCacheControlBreakpoints;

  let breakpointsRemaining = enableCacheControl ? Math.min(4, Math.max(2, caps.maxCacheBreakpoints)) : 0;
  const takeBreakpoint = (): { cache_control: { type: 'ephemeral' } } | undefined => {
    if (breakpointsRemaining <= 0) return undefined;
    breakpointsRemaining -= 1;
    return { cache_control: { type: 'ephemeral' } };
  };

  const systemBlocks: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'system' && m.text.trim()) {
      systemBlocks.push({ type: 'text', text: m.text });
    }
  }
  if (systemBlocks.length > 0 && enableCacheControl) {
    const bp = takeBreakpoint();
    if (bp) Object.assign(systemBlocks[systemBlocks.length - 1], bp);
  }

  const mappedMessages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];
  const pushUserBlocks = (blocks: Array<Record<string, unknown>>) => {
    if (!blocks.length) return;
    const prev = mappedMessages[mappedMessages.length - 1];
    if (prev && prev.role === 'user') {
      prev.content.push(...blocks);
    } else {
      mappedMessages.push({ role: 'user', content: [...blocks] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const blocks: Array<Record<string, unknown>> = m.parts.map((p) => {
        if (p.type === 'text') return { type: 'text', text: p.text };
        if (p.type === 'image') {
          return {
            type: 'image',
            source: { type: 'base64', media_type: p.mimeType, data: p.dataBase64 },
          };
        }
        return {
          type: 'text',
          text: `[视频附件: ${p.mimeType}；当前 Anthropic Messages 不支持原始视频字节直接内联]`,
        };
      });
      if ((m.isSegmentBaseline || m.cacheControl === 'ephemeral') && blocks.length > 0) {
        const bp = takeBreakpoint();
        if (bp) Object.assign(blocks[blocks.length - 1], bp);
      }
      pushUserBlocks(blocks);
      continue;
    }
    if (m.role === 'tool') {
      const toolResultBlock: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      };
      if (m.cacheControl === 'ephemeral') {
        const bp = takeBreakpoint();
        if (bp) Object.assign(toolResultBlock, bp);
      }
      pushUserBlocks([toolResultBlock]);
      continue;
    }
    // assistant: 原样保留 thinking/signature/redacted_thinking/tool_use 块顺序，绝不向 thinking 块打标 cache_control
    if (m.anthropicBlocks?.length) {
      mappedMessages.push({
        role: 'assistant',
        content: m.anthropicBlocks.map((b) => structuredClone(b)),
      });
    } else {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments ?? {},
        });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      mappedMessages.push({ role: 'assistant', content: blocks });
    }
  }

  // 若仍有剩余断点配额，自动放在最后一个历史非思考可重用尾部边界（tool_result / user text）
  if (enableCacheControl && breakpointsRemaining > 0 && mappedMessages.length > 1) {
    for (let i = mappedMessages.length - 2; i >= 0; i -= 1) {
      const msg = mappedMessages[i];
      if (msg.role === 'user' && msg.content.length > 0) {
        const tailBlock = msg.content[msg.content.length - 1];
        if (!('cache_control' in tailBlock)) {
          const bp = takeBreakpoint();
          if (bp) Object.assign(tailBlock, bp);
        }
        break;
      }
    }
  }

  const isDeepSeekMessages = caps.upstreamFamily === 'deepseek';
  const thinkingCfg = isDeepSeekMessages
    ? buildDeepSeekMessagesThinkingConfig(
        options?.thinkingDepth,
        options?.maxTokens ?? caps.maxOutputTokens ?? 4096,
      )
    : buildAnthropicThinkingConfig(
        options?.thinkingDepth,
        options?.maxTokens ?? caps.maxOutputTokens ?? 4096,
      );
  const thinkingActive =
    Boolean(thinkingCfg.thinking) && thinkingCfg.thinking!.type !== 'disabled';

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: thinkingCfg.maxTokens,
    stream: true,
    ...(systemBlocks.length ? { system: systemBlocks } : {}),
    messages: mappedMessages,
    ...(thinkingCfg.thinking ? { thinking: thinkingCfg.thinking } : {}),
    ...('effort' in thinkingCfg && thinkingCfg.effort
      ? { output_config: { effort: thinkingCfg.effort } }
      : {}),
    ...(options?.temperature !== undefined && !thinkingActive
      ? { temperature: options.temperature }
      : {}),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const headers = buildProviderHeaders({ ...config, kind: 'anthropic' });

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
      if (m.geminiParts?.length) {
        contents.push({
          role: 'model',
          parts: m.geminiParts.map((p) => structuredClone(p)),
        });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls ?? []) {
        const fcObj: Record<string, unknown> = { name: tc.name, args: tc.arguments };
        if (tc.id && !tc.id.startsWith('gem_local_')) {
          fcObj.id = tc.id;
        }
        parts.push({
          functionCall: fcObj,
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    const fnRespObj: Record<string, unknown> = {
      name: m.name,
      response: { result: m.content },
    };
    if (m.toolCallId && !m.toolCallId.startsWith('gem_local_')) {
      fnRespObj.id = m.toolCallId;
    }
    const responsePart = { functionResponse: fnRespObj };
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
  if (tools.length || options?.webSearch === true) {
    const geminiTools: Array<Record<string, unknown>> = [];
    if (tools.length) {
      geminiTools.push({
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    }
    if (options?.webSearch === true) {
      geminiTools.push({ googleSearch: {} });
    }
    body.tools = geminiTools;
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

export interface ParsedSseEvent {
  event?: string;
  data: string;
}

export async function* iterateSseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

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

  const flushEvent = (): ParsedSseEvent | null => {
    if (!dataLines.length && currentEvent === undefined) return null;
    const ev: ParsedSseEvent = {
      ...(currentEvent !== undefined ? { event: currentEvent } : {}),
      data: dataLines.join('\n'),
    };
    currentEvent = undefined;
    dataLines = [];
    return ev;
  };

  const processLine = (rawLine: string): ParsedSseEvent | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      return flushEvent();
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') currentEvent = value;
    else if (field === 'data') dataLines.push(value);
    return null;
  };

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
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const ev = processLine(line);
        if (ev && ev.data) yield ev;
      }
    }
    if (buffer) {
      const ev = processLine(buffer);
      if (ev && ev.data) yield ev;
    }
    const trailing = flushEvent();
    if (trailing && trailing.data) yield trailing;
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
  const fetchFn = config.fetch ?? getCoachFetch();
  if (typeof fetchFn !== 'function') {
    throw new Error('缺少可用的 fetch 实现');
  }

  const req =
    config.kind === 'anthropic'
      ? buildAnthropicRequest(config, messages, tools, options)
      : config.kind === 'gemini'
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
      /reasoning[_ .-]?effort|thinking[_ .-]?(?:config|mode|budget|level)?|enable_thinking/i.test(errText) &&
      /unsupported|not supported|unknown|invalid|not allowed|unrecognized/i.test(errText)
    ) {
      yield { type: 'thinking_fallback' };
      yield* streamCoachTurn(config, messages, tools, { ...options, thinkingDepth: 'default' });
      return;
    }
    if (
      response.status === 400 &&
      options?.includeUsage !== false &&
      /stream_options|include_usage/i.test(errText)
    ) {
      yield* streamCoachTurn(config, messages, tools, { ...options, includeUsage: false });
      return;
    }
    if (
      config.kind === 'gemini' &&
      options?.webSearch === true &&
      tools.length > 0 &&
      response.status === 400 &&
      /google[_ ]?search|function[_ ]?(?:declaration|calling)|tool use/i.test(errText)
    ) {
      throw new GeminiGroundingConflictError(
        errText.slice(0, 200) || 'Gemini 不支持同轮混用搜索与函数工具',
      );
    }
    throw new Error(`模型请求失败 (${response.status}): ${errText.slice(0, 240) || response.statusText}`);
  }
  if (!response.body) {
    throw new Error('模型响应缺少流式 body');
  }

  let fullText = '';
  let fullReasoning = '';
  let rawFinishReason: string | undefined;
  let corruptDataFrameReason: string | undefined;
  let usage: CoachTokenUsage | undefined;
  let rawUsageObj: Record<string, unknown> | undefined;
  const citationsByUrl = new Map<string, CoachCitation>();

  // OpenAI-compatible accumulators
  let sawOpenAiDone = false;
  let openAiMalformedReason: string | undefined;
  const openAiCalls = new Map<number, { id: string; name: string; args: string }>();

  // Anthropic accumulators
  let sawAnthropicMessageStop = false;
  const anthropicBlockMap = new Map<
    number,
    {
      type: string;
      text: string;
      thinking: string;
      signature: string;
      data: string;
      id: string;
      name: string;
      inputJson: string;
      staticInput?: Record<string, unknown>;
      stopped: boolean;
    }
  >();
  let anthropicOrder: number[] = [];

  // Gemini accumulators
  const geminiPartsRaw: Array<Record<string, unknown>> = [];
  const geminiPendingCalls: CoachToolCall[] = [];
  let geminiLocalSeq = 0;
  let geminiMalformedReason: string | undefined;

  for await (const ev of iterateSseEvents(response.body, options?.signal)) {
    const data = ev.data.trim();
    if (!data) continue;
    if (data === '[DONE]') {
      sawOpenAiDone = true;
      continue;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        corruptDataFrameReason ??= 'SSE 数据帧格式非法（非 JSON 对象），已将该批次永久标记为不可写入';
        continue;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      corruptDataFrameReason ??= 'SSE 数据帧 JSON 损坏，已将该批次永久标记为不可写入';
      continue;
    }

    if (config.kind === 'anthropic') {
      const evType = ev.event || (typeof payload.type === 'string' ? payload.type : '');
      if (evType === 'message_start') {
        const msg = payload.message as Record<string, unknown> | undefined;
        const msgUsage = msg?.usage as Record<string, unknown> | undefined;
        if (msgUsage) {
          rawUsageObj = { ...(rawUsageObj ?? {}), ...msgUsage };
          const inp = typeof rawUsageObj.input_tokens === 'number' ? rawUsageObj.input_tokens : 0;
          const readTok =
            typeof rawUsageObj.cache_read_input_tokens === 'number'
              ? rawUsageObj.cache_read_input_tokens
              : 0;
          const createTok =
            typeof rawUsageObj.cache_creation_input_tokens === 'number'
              ? rawUsageObj.cache_creation_input_tokens
              : 0;
          usage = {
            promptTokens: inp + readTok + createTok,
            ...(readTok > 0 ? { cachedTokens: readTok } : {}),
            ...(createTok > 0 ? { cacheCreationTokens: createTok } : {}),
          };
        }
      } else if (evType === 'content_block_start') {
        const idx = typeof payload.index === 'number' ? payload.index : -1;
        const cb = payload.content_block as Record<string, unknown> | undefined;
        if (idx >= 0 && cb && typeof cb.type === 'string') {
          anthropicOrder.push(idx);
          anthropicBlockMap.set(idx, {
            type: cb.type,
            text: typeof cb.text === 'string' ? cb.text : '',
            thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
            signature: typeof cb.signature === 'string' ? cb.signature : '',
            data: typeof cb.data === 'string' ? cb.data : '',
            id: typeof cb.id === 'string' ? cb.id : '',
            name: typeof cb.name === 'string' ? cb.name : '',
            inputJson: '',
            ...(cb.input && typeof cb.input === 'object' && !Array.isArray(cb.input)
              ? { staticInput: cb.input as Record<string, unknown> }
              : {}),
            stopped: false,
          });
        }
      } else if (evType === 'content_block_delta') {
        const idx = typeof payload.index === 'number' ? payload.index : -1;
        const delta = payload.delta as Record<string, unknown> | undefined;
        const block = anthropicBlockMap.get(idx);
        if (block && delta) {
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            block.text += delta.text;
            fullText += delta.text;
            yield { type: 'text_delta', delta: delta.text };
          } else if (
            delta.type === 'thinking_delta' &&
            typeof delta.thinking === 'string' &&
            delta.thinking
          ) {
            block.thinking += delta.thinking;
            fullReasoning += delta.thinking;
            yield { type: 'reasoning_delta', delta: delta.thinking };
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            block.signature += delta.signature;
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            block.inputJson += delta.partial_json;
          }
        }
      } else if (evType === 'content_block_stop') {
        const idx = typeof payload.index === 'number' ? payload.index : -1;
        const block = anthropicBlockMap.get(idx);
        if (block) block.stopped = true;
      } else if (evType === 'message_delta') {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (typeof delta?.stop_reason === 'string') {
          rawFinishReason = delta.stop_reason;
        }
        const deltaUsage = payload.usage as Record<string, unknown> | undefined;
        if (deltaUsage) {
          rawUsageObj = { ...(rawUsageObj ?? {}), ...deltaUsage };
          const inp = typeof rawUsageObj.input_tokens === 'number' ? rawUsageObj.input_tokens : 0;
          const readTok =
            typeof rawUsageObj.cache_read_input_tokens === 'number'
              ? rawUsageObj.cache_read_input_tokens
              : 0;
          const createTok =
            typeof rawUsageObj.cache_creation_input_tokens === 'number'
              ? rawUsageObj.cache_creation_input_tokens
              : 0;
          const out =
            typeof rawUsageObj.output_tokens === 'number' ? rawUsageObj.output_tokens : undefined;
          usage = {
            promptTokens: inp + readTok + createTok,
            completionTokens: out,
            totalTokens: out !== undefined ? inp + readTok + createTok + out : undefined,
            ...(readTok > 0 ? { cachedTokens: readTok } : {}),
            ...(createTok > 0 ? { cacheCreationTokens: createTok } : {}),
          };
        }
      } else if (evType === 'message_stop') {
        sawAnthropicMessageStop = true;
      } else if (evType === 'error') {
        corruptDataFrameReason ??= 'Anthropic SSE 流返回 error 事件，已永久标记本批不可写入';
      } else if (evType === 'ping') {
        // 合法保活心跳
      }
      continue;
    }

    if (config.kind === 'gemini') {
      if (payload.error && !payload.candidates) {
        corruptDataFrameReason ??= 'Gemini SSE 流返回错误对象，已永久标记本批不可写入';
        continue;
      }
      const promptFeedback = payload.promptFeedback as { blockReason?: unknown } | undefined;
      if (typeof promptFeedback?.blockReason === 'string' && promptFeedback.blockReason.trim()) {
        geminiMalformedReason ??= `Gemini 输入触发安全拦截（blockReason=${promptFeedback.blockReason}），已阻断工具写入`;
      }
      const um = payload.usageMetadata as Record<string, unknown> | undefined;
      if (um) {
        rawUsageObj = um;
        const promptTokens = typeof um.promptTokenCount === 'number' ? um.promptTokenCount : undefined;
        const completionTokens =
          typeof um.candidatesTokenCount === 'number' ? um.candidatesTokenCount : undefined;
        const totalTokens = typeof um.totalTokenCount === 'number' ? um.totalTokenCount : undefined;
        const cachedTokens =
          typeof um.cachedContentTokenCount === 'number' && um.cachedContentTokenCount >= 0
            ? um.cachedContentTokenCount
            : undefined;
        const reasoningTokens =
          typeof um.thoughtsTokenCount === 'number' && um.thoughtsTokenCount >= 0
            ? um.thoughtsTokenCount
            : undefined;
        if (promptTokens !== undefined || totalTokens !== undefined) {
          usage = {
            promptTokens,
            completionTokens,
            totalTokens,
            ...(cachedTokens !== undefined ? { cachedTokens } : {}),
            ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
          };
        }
      }
      const candidates = (payload.candidates as Array<Record<string, unknown>> | undefined) ?? [];
      const first = candidates[0];
      if (!first) continue;
      if (typeof first.finishReason === 'string' && first.finishReason) {
        rawFinishReason = first.finishReason;
      }
      const grounding = first.groundingMetadata as
        | { groundingChunks?: Array<Record<string, unknown>> }
        | undefined;
      for (const chunk of grounding?.groundingChunks ?? []) {
        const web = chunk.web as { uri?: string; title?: string } | undefined;
        if (web?.uri && /^https?:\/\//i.test(web.uri)) {
          citationsByUrl.set(web.uri, { title: (web.title || web.uri).trim(), url: web.uri });
        }
      }
      const content = first.content as { parts?: Array<Record<string, unknown>> } | undefined;
      for (const part of content?.parts ?? []) {
        geminiPartsRaw.push(structuredClone(part));
        if (part.thought === true && typeof part.text === 'string' && part.text.length > 0) {
          fullReasoning += part.text;
          yield { type: 'reasoning_delta', delta: part.text };
          continue;
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          fullText += part.text;
          yield { type: 'text_delta', delta: part.text };
        }
        if ('functionCall' in part && part.functionCall !== undefined) {
          const fc = part.functionCall as
            | { id?: unknown; name?: unknown; args?: unknown }
            | undefined;
          if (!fc || typeof fc.name !== 'string' || !fc.name.trim()) {
            geminiMalformedReason = 'Gemini functionCall 缺少函数名';
            continue;
          }
          if (fc.args !== undefined && (typeof fc.args !== 'object' || fc.args === null || Array.isArray(fc.args))) {
            geminiMalformedReason = 'Gemini functionCall 参数不是合法对象';
            continue;
          }
          const serverId = typeof fc.id === 'string' && fc.id.trim() ? fc.id.trim() : '';
          const argsObj = (fc.args as Record<string, unknown> | undefined) ?? {};
          geminiPendingCalls.push({
            id: serverId || `gem_local_${++geminiLocalSeq}`,
            index: geminiPendingCalls.length,
            name: fc.name.trim(),
            argumentsText: JSON.stringify(argsObj),
            arguments: argsObj,
            ...(typeof part.thoughtSignature === 'string'
              ? { thoughtSignature: part.thoughtSignature }
              : {}),
          });
        }
      }
      continue;
    }

    // OpenAI-compatible SSE chunk
    if (payload.error && !payload.choices) {
      corruptDataFrameReason ??= '模型 SSE 流返回 error 对象，已永久标记本批不可写入';
      continue;
    }
    const rawUsage = payload.usage as Record<string, unknown> | undefined;
    if (rawUsage) {
      rawUsageObj = rawUsage;
      const promptTokens = typeof rawUsage.prompt_tokens === 'number' ? rawUsage.prompt_tokens : undefined;
      const completionTokens =
        typeof rawUsage.completion_tokens === 'number' ? rawUsage.completion_tokens : undefined;
      const totalTokens = typeof rawUsage.total_tokens === 'number' ? rawUsage.total_tokens : undefined;
      const promptDetails = rawUsage.prompt_tokens_details as Record<string, unknown> | undefined;
      const compDetails = rawUsage.completion_tokens_details as Record<string, unknown> | undefined;
      const cachedTokensRaw =
        typeof rawUsage.prompt_cache_hit_tokens === 'number'
          ? rawUsage.prompt_cache_hit_tokens
          : typeof promptDetails?.cached_tokens === 'number'
            ? promptDetails.cached_tokens
            : undefined;
      const cachedTokens =
        cachedTokensRaw !== undefined && cachedTokensRaw >= 0 ? cachedTokensRaw : undefined;
      const reasoningTokens =
        typeof compDetails?.reasoning_tokens === 'number' && compDetails.reasoning_tokens >= 0
          ? compDetails.reasoning_tokens
          : undefined;
      if (promptTokens !== undefined || totalTokens !== undefined) {
        usage = {
          promptTokens,
          completionTokens,
          totalTokens,
          ...(cachedTokens !== undefined ? { cachedTokens } : {}),
          ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
        };
      }
    }
    const choices = (payload.choices as Array<Record<string, unknown>> | undefined) ?? [];
    const choice = choices[0];
    if (!choice) continue;
    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      rawFinishReason = choice.finish_reason;
    }
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (!delta) continue;
    if (typeof delta.title === 'string' && delta.title.trim()) {
      yield { type: 'title', title: delta.title };
    }
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
      if (typeof tc.index !== 'number' || !Number.isInteger(tc.index) || tc.index < 0) {
        openAiMalformedReason = '工具调用缺少合法数字 index，拒绝伪造索引或 ID';
        continue;
      }
      const index = tc.index;
      const existing = openAiCalls.get(index) ?? {
        id: '',
        name: '',
        args: '',
      };
      if (typeof tc.id === 'string' && tc.id.trim()) {
        const nextId = tc.id.trim();
        if (existing.id && existing.id !== nextId) {
          openAiMalformedReason = `工具索引 ${index} 出现冲突的调用 ID`;
        } else {
          existing.id = nextId;
        }
      }
      const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof fn?.name === 'string' && fn.name) {
        existing.name += fn.name;
      }
      if (typeof fn?.arguments === 'string') {
        existing.args += fn.arguments;
      } else if (fn?.arguments !== undefined && fn?.arguments !== null) {
        openAiMalformedReason = '工具调用 arguments 字段类型非法';
      }
      openAiCalls.set(index, existing);
    }
  }

  const citations = Array.from(citationsByUrl.values());

  // ── 协议级严苛终态校验与结果输出 ──
  if (config.kind === 'anthropic') {
    const finishReason = rawFinishReason ?? 'eof';
    const uniqueOrder = Array.from(new Set(anthropicOrder));
    const orderedBlocks: Array<Record<string, unknown>> = [];
    const validatedCalls: CoachToolCall[] = [];
    const seenIds = new Set<string>();
    let invalidReason: string | undefined;

    for (const idx of uniqueOrder) {
      const b = anthropicBlockMap.get(idx);
      if (!b) continue;
      if (b.type === 'text') {
        orderedBlocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking') {
        orderedBlocks.push({
          type: 'thinking',
          thinking: b.thinking,
          ...(b.signature ? { signature: b.signature } : {}),
        });
      } else if (b.type === 'redacted_thinking') {
        orderedBlocks.push({ type: 'redacted_thinking', data: b.data });
      } else if (b.type === 'tool_use') {
        if (!b.stopped) {
          invalidReason = 'Anthropic tool_use block 未完整闭合（缺少 content_block_stop）';
          break;
        }
        const id = b.id.trim();
        const name = b.name.trim();
        if (!id || !name) {
          invalidReason = 'Anthropic tool_use 缺少 id 或 name';
          break;
        }
        if (seenIds.has(id)) {
          invalidReason = `Anthropic 返回了重复的 tool_use id: ${id}`;
          break;
        }
        seenIds.add(id);
        let argsObj: Record<string, unknown> = {};
        let argsText = b.inputJson;
        if (b.inputJson.trim()) {
          const parsed = parseStrictToolArguments(b.inputJson);
          if (parsed.parseError) {
            invalidReason = parsed.parseError;
            break;
          }
          argsObj = parsed.value;
        } else if (b.staticInput) {
          argsObj = b.staticInput;
          argsText = JSON.stringify(b.staticInput);
        } else {
          invalidReason = 'Anthropic tool_use 缺少参数 JSON';
          break;
        }
        orderedBlocks.push({ type: 'tool_use', id, name, input: argsObj });
        validatedCalls.push({
          id,
          index: validatedCalls.length,
          name,
          argumentsText: argsText,
          arguments: argsObj,
        });
      }
    }

    let outcomeKind: CoachStreamOutcomeKind = 'completed_text';
    let errorMessage: string | undefined;
    let outCalls = validatedCalls;
    const ALLOWED_ANTHROPIC_TOOL_REASONS = new Set(['tool_use']);
    const ALLOWED_ANTHROPIC_TEXT_REASONS = new Set(['end_turn', 'stop_sequence']);

    if (corruptDataFrameReason) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = corruptDataFrameReason;
      outCalls = [];
    } else if (finishReason === 'max_tokens' || finishReason === 'model_context_window_exceeded') {
      outcomeKind = 'truncated_max_tokens';
      errorMessage = '模型输出达到 max_tokens 上限被截断，已阻断未完整工具写入';
      outCalls = [];
    } else if (!sawAnthropicMessageStop || !rawFinishReason) {
      outcomeKind = 'truncated_eof';
      errorMessage = '模型流提前中断（EOF，缺少 message_stop/stop_reason），已阻断工具写入';
      outCalls = [];
    } else if (finishReason === 'refusal') {
      outcomeKind = 'malformed_tool_call';
      errorMessage = '模型因安全策略拒答（stop_reason=refusal），已阻断工具写入';
      outCalls = [];
    } else if (invalidReason) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = invalidReason;
      outCalls = [];
    } else if (outCalls.length > 0 && !ALLOWED_ANTHROPIC_TOOL_REASONS.has(finishReason)) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = `Anthropic 工具批次以非法的 stop_reason=${finishReason} 结束（仅允许 tool_use），已阻断工具写入`;
      outCalls = [];
    } else if (outCalls.length === 0 && !ALLOWED_ANTHROPIC_TEXT_REASONS.has(finishReason)) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = `Anthropic 响应以非法的 stop_reason=${finishReason} 结束（仅允许 end_turn/stop_sequence），已阻断写入`;
      outCalls = [];
    } else if (outCalls.length > 0) {
      outcomeKind = 'completed_tool_calls';
      for (const c of outCalls) yield { type: 'tool_call', call: c };
    }

    yield {
      type: 'done',
      finishReason,
      outcomeKind,
      ...(errorMessage ? { errorMessage } : {}),
      text: fullText,
      ...(fullReasoning ? { reasoning: fullReasoning } : {}),
      toolCalls: outCalls,
      ...(usage ? { usage } : {}),
      ...(rawUsageObj ? { rawUsage: rawUsageObj } : {}),
      ...(orderedBlocks.length ? { anthropicBlocks: orderedBlocks } : {}),
      ...(citations.length ? { citations } : {}),
    };
    return;
  }

  if (config.kind === 'gemini') {
    const finishReason = rawFinishReason ?? 'EOF';
    let outcomeKind: CoachStreamOutcomeKind = 'completed_text';
    let errorMessage: string | undefined;
    let outCalls = geminiPendingCalls;

    const seenIds = new Set<string>();
    for (const c of geminiPendingCalls) {
      if (seenIds.has(c.id)) {
        geminiMalformedReason = `Gemini 返回了重复的 functionCall id: ${c.id}`;
        break;
      }
      seenIds.add(c.id);
    }

    const ALLOWED_GEMINI_FINISH_REASONS = new Set(['STOP']);
    const normalizedGeminiReason = finishReason.toUpperCase();
    if (corruptDataFrameReason) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = corruptDataFrameReason;
      outCalls = [];
    } else if (normalizedGeminiReason === 'MAX_TOKENS') {
      outcomeKind = 'truncated_max_tokens';
      errorMessage = 'Gemini 输出达到 MAX_TOKENS 上限被截断，已阻断工具写入';
      outCalls = [];
    } else if (!rawFinishReason) {
      outcomeKind = 'truncated_eof';
      errorMessage = 'Gemini 流提前中断（EOF，缺少 finishReason），已阻断工具写入';
      outCalls = [];
    } else if (geminiMalformedReason) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = geminiMalformedReason;
      outCalls = [];
    } else if (!ALLOWED_GEMINI_FINISH_REASONS.has(normalizedGeminiReason)) {
      outcomeKind = 'malformed_tool_call';
      errorMessage = `Gemini 响应终止原因非法（finishReason=${finishReason}，仅允许 STOP），已阻断工具写入`;
      outCalls = [];
    } else if (outCalls.length > 0) {
      outcomeKind = 'completed_tool_calls';
      for (const c of outCalls) yield { type: 'tool_call', call: c };
    }

    yield {
      type: 'done',
      finishReason,
      outcomeKind,
      ...(errorMessage ? { errorMessage } : {}),
      text: fullText,
      ...(fullReasoning ? { reasoning: fullReasoning } : {}),
      toolCalls: outCalls,
      ...(usage ? { usage } : {}),
      ...(rawUsageObj ? { rawUsage: rawUsageObj } : {}),
      ...(geminiPartsRaw.length ? { geminiParts: geminiPartsRaw } : {}),
      ...(citations.length ? { citations } : {}),
    };
    return;
  }

  // OpenAI-compatible 严谨收口：检查 length / EOF / 缺失 [DONE] / 缺失 id / 空参数 / 畸形 JSON / 重复 id
  const finishReason = rawFinishReason ?? 'eof';
  const orderedRawCalls = [...openAiCalls.entries()].sort((a, b) => a[0] - b[0]);
  const validatedOpenAiCalls: CoachToolCall[] = [];
  const seenOpenAiIds = new Set<string>();

  if (!openAiMalformedReason && orderedRawCalls.length > 0) {
    for (const [index, raw] of orderedRawCalls) {
      const id = raw.id.trim();
      const name = raw.name.trim();
      if (!id) {
        openAiMalformedReason = `工具索引 ${index} 缺少真实 tool_call.id（禁止伪造 ID）`;
        break;
      }
      if (!name) {
        openAiMalformedReason = `工具 ${id} 缺少函数名`;
        break;
      }
      if (seenOpenAiIds.has(id)) {
        openAiMalformedReason = `返回了重复的 tool_call.id: ${id}`;
        break;
      }
      seenOpenAiIds.add(id);
      const parsed = parseStrictToolArguments(raw.args);
      if (parsed.parseError) {
        openAiMalformedReason = parsed.parseError;
        break;
      }
      validatedOpenAiCalls.push({
        id,
        index,
        name,
        argumentsText: raw.args,
        arguments: parsed.value,
      });
    }
  }

  let outcomeKind: CoachStreamOutcomeKind = 'completed_text';
  let errorMessage: string | undefined;
  let outCalls = validatedOpenAiCalls;
  const ALLOWED_OPENAI_TOOL_REASONS = new Set(['tool_calls']);
  const ALLOWED_OPENAI_TEXT_REASONS = new Set(['stop']);

  if (corruptDataFrameReason) {
    outcomeKind = 'malformed_tool_call';
    errorMessage = corruptDataFrameReason;
    outCalls = [];
  } else if (finishReason === 'length') {
    outcomeKind = 'truncated_max_tokens';
    errorMessage = '模型输出达到 max_tokens 上限（finish_reason=length），已阻断未完整工具写入';
    outCalls = [];
  } else if (finishReason.toLowerCase() === 'content_filter') {
    outcomeKind = 'malformed_tool_call';
    errorMessage = '模型输出触发内容过滤（finish_reason=content_filter），已阻断工具写入';
    outCalls = [];
  } else if (!rawFinishReason || !sawOpenAiDone) {
    outcomeKind = 'truncated_eof';
    errorMessage = !rawFinishReason
      ? '模型流提前中断（EOF，缺少 finish_reason），已阻断工具写入'
      : '模型流缺少 [DONE] 终止标志，已阻断未确认写入';
    outCalls = [];
  } else if (openAiMalformedReason) {
    outcomeKind = 'malformed_tool_call';
    errorMessage = openAiMalformedReason;
    outCalls = [];
  } else if (orderedRawCalls.length > 0 && !ALLOWED_OPENAI_TOOL_REASONS.has(finishReason)) {
    outcomeKind = 'malformed_tool_call';
    errorMessage = `工具调用批次以非法的 finish_reason=${finishReason} 结束（仅允许 tool_calls），已阻断工具写入`;
    outCalls = [];
  } else if (orderedRawCalls.length === 0 && !ALLOWED_OPENAI_TEXT_REASONS.has(finishReason)) {
    outcomeKind = 'malformed_tool_call';
    errorMessage = `模型响应以非法的 finish_reason=${finishReason} 结束（仅允许 stop），已阻断写入`;
    outCalls = [];
  } else if (outCalls.length > 0) {
    outcomeKind = 'completed_tool_calls';
    for (const c of outCalls) yield { type: 'tool_call', call: c };
  }

  yield {
    type: 'done',
    finishReason,
    outcomeKind,
    ...(errorMessage ? { errorMessage } : {}),
    text: fullText,
    ...(fullReasoning ? { reasoning: fullReasoning } : {}),
    toolCalls: outCalls,
    ...(usage ? { usage } : {}),
    ...(rawUsageObj ? { rawUsage: rawUsageObj } : {}),
    ...(citations.length ? { citations } : {}),
  };
}
