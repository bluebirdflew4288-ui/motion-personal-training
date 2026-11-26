/* 电子教练供应商/模型/部署能力注册表与参考费率（v0.2.3）。
   设计边界：
   1. “OpenAI-compatible”仅描述消息编码器，不代表缓存机制、思考字段、计费单位一致。
   2. 严格区分：
      · DeepSeek 官方（api.deepseek.com）：隐式磁盘前缀缓存（hit ¥0.2/M，miss ¥2/M，output ¥3/M），
        thinking+tools 模式跨轮必须原样回传所有历史 assistant 的 reasoning_content；严禁发 cache_control；
        不支持多模态生图识图；官方不依赖模型起标题。
      · 阿里百炼 DeepSeek（dashscope*.aliyuncs.com + deepseek*）：列明模型默认隐式前缀缓存
        （严禁对列明隐式缓存模型默认发送 cache_control breakpoints），支持 enable_thinking，
        按 20% 缓存命中折算费率（miss ¥2/M，hit ¥0.4/M，output ¥3/M）。
      · Anthropic Messages：显式 cache_control: { type: 'ephemeral' } 断点（2-4 个），
        原样保存并回传 thinking/signature/redacted_thinking blocks；input_tokens 仅含未命中部分。
      · Gemini GenerateContent：隐式缓存默认启用，usageMetadata.promptTokenCount 已包含 cachedContentTokenCount；
        保留完整 candidate.content parts 与 thoughtSignature、服务端 functionCall.id。
      · 通用 OpenAI / 自定义反代：仅使用保守标准参数，不注入 DeepSeek 私有 reasoning_content 或显式断点，
        除非能力探测（手动触发）或显式能力表确认。 */

import type { CoachProviderConfig, CoachProviderKind, CoachThinkingDepth } from './providerAdapter';
import { getCoachFetch } from './coachNativeStream';

export type CacheMechanism =
  | 'implicit_prefix'
  | 'explicit_breakpoints'
  | 'implicit_or_explicit'
  | 'unknown';

export type ReasoningFieldFormat =
  | 'deepseek_reasoning_content'
  | 'anthropic_thinking_blocks'
  | 'gemini_thought_parts'
  | 'none';

export type ThinkingControlStyle =
  | 'deepseek_mode'
  | 'bailian_enable_thinking'
  | 'openai_reasoning_effort'
  | 'anthropic_thinking_budget'
  | 'gemini_thinking_config'
  | 'none';

export interface ProviderPricingSchedule {
  currency: 'CNY' | 'USD' | 'unknown';
  inputPer1MTokens: number | null;
  cachedInputPer1MTokens: number | null;
  cacheWrite5mPer1MTokens?: number | null;
  cacheWrite1hPer1MTokens?: number | null;
  outputPer1MTokens: number | null;
  pricingWindow?: 'peak' | 'off_peak' | 'flat' | 'unknown';
  pricingRegion?: string;
  pricingNote?: string;
}

export interface ProviderDeploymentCapabilities {
  deploymentId: string;
  presetId: string;
  displayName: string;
  protocolKind: CoachProviderKind;
  upstreamFamily: 'deepseek' | 'bailian-deepseek' | 'openai' | 'anthropic' | 'gemini' | 'custom-proxy';
  cacheMechanism: CacheMechanism;
  sendCacheControlBreakpoints: boolean;
  maxCacheBreakpoints: number;
  cacheMinPrefixTokens: number;
  requiresReasoningReplayWithTools: boolean;
  reasoningFieldFormat: ReasoningFieldFormat;
  thinkingControlStyle: ThinkingControlStyle;
  supportedThinkingLevels: CoachThinkingDepth[];
  supportsNativeVision: boolean;
  supportsNativeVideo: boolean;
  supportsNativeWebSearch: boolean;
  supportsToolSubset: boolean;
  supportsTitleModelCall: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  pricing: ProviderPricingSchedule;
  probedAt?: number;
  probeNotes?: string;
}

export interface CoachProviderPreset {
  id: string;
  label: string;
  kind: CoachProviderKind;
  defaultBaseUrl: string;
  defaultModel: string;
  description: string;
}

export const COACH_PROVIDER_PRESETS: CoachProviderPreset[] = [
  {
    id: 'deepseek-official',
    label: 'DeepSeek 官方',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    description: '隐式前缀缓存（hit 2%，支持原生识图），工具+思考模式跨轮回传 reasoning_content',
  },
  {
    id: 'bailian-deepseek',
    label: '阿里百炼 DeepSeek',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'deepseek-v4.1-flash-1017',
    description: '百炼北京 DashScope 兼容接口，列明部署走隐式缓存（hit 2%，不发显式 cache_control）',
  },
  {
    id: 'anthropic-official',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    description: 'Messages 原生协议，2–3 个 ephemeral 缓存断点，保留 thinking 签名块',
  },
  {
    id: 'gemini-official',
    label: 'Google Gemini',
    kind: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    description: 'GenerateContent 原生协议，隐式缓存，保留完整 parts/签名/调用 ID',
  },
  {
    id: 'openai-official',
    label: 'OpenAI 官方',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    description: 'Chat Completions 原生工具协议，自动前缀缓存与稳定 prompt_cache_key',
  },
];

function extractUrlHostname(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return (
      trimmed
        .replace(/^https?:\/\//i, '')
        .split(/[/?#]/)[0]
        ?.split(':')[0]
        ?.toLowerCase() ?? ''
    );
  }
}

export function isOfficialDeepSeekEndpoint(baseUrl: string, model: string, presetId?: string): boolean {
  const host = extractUrlHostname(baseUrl);
  if (host) return host === 'api.deepseek.com';
  if (presetId === 'deepseek-official') return true;
  const mdl = model.trim().toLowerCase();
  return mdl.startsWith('deepseek-');
}

export function isBailianEndpoint(baseUrl: string): boolean {
  const host = extractUrlHostname(baseUrl);
  if (!host) return false;
  return (
    host === 'dashscope.aliyuncs.com' ||
    host === 'dashscope-intl.aliyuncs.com' ||
    host.includes('bailian')
  );
}

export function isBailianDeepSeekDeployment(
  baseUrl: string,
  model: string,
  presetId?: string,
): boolean {
  const cleanUrl = baseUrl.trim();
  const mdl = model.trim().toLowerCase();
  if (cleanUrl) {
    return isBailianEndpoint(cleanUrl) && mdl.includes('deepseek');
  }
  return presetId === 'bailian-deepseek';
}

function isOfficialAnthropicEndpoint(baseUrl: string, presetId?: string): boolean {
  const host = extractUrlHostname(baseUrl);
  if (host) return host === 'api.anthropic.com';
  return presetId === 'anthropic-official';
}

function isOfficialGeminiEndpoint(baseUrl: string, presetId?: string): boolean {
  const host = extractUrlHostname(baseUrl);
  if (host) return host === 'generativelanguage.googleapis.com';
  return presetId === 'gemini-official';
}

function isOfficialOpenAiEndpoint(baseUrl: string, presetId?: string): boolean {
  const host = extractUrlHostname(baseUrl);
  if (host) return host === 'api.openai.com';
  return presetId === 'openai-official';
}

export function computeDeploymentId(config: {
  kind: CoachProviderKind;
  presetId?: string;
  baseUrl: string;
  model: string;
}): string {
  const host = (() => {
    try {
      return new URL(config.baseUrl.trim()).host.toLowerCase();
    } catch {
      return config.baseUrl.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0] || 'local';
    }
  })();
  const mdl = config.model.trim().toLowerCase() || 'unknown-model';
  return `${config.kind}:${host}:${mdl}`;
}

const CN_STATUTORY_HOLIDAYS_2026 = new Set<string>([
  // 元旦 1/1-1/3
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节 2/15-2/23
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节 4/4-4/6
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节 5/1-5/5
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节 6/19-6/21
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节 9/25-9/27
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节 10/1-10/7
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

function cstCalendarParts(nowMs = Date.now()): { dateKey: string; dayOfWeek: number; hour: number } {
  const cstDate = new Date(nowMs + 8 * 3_600_000);
  const year = cstDate.getUTCFullYear();
  const month = String(cstDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(cstDate.getUTCDate()).padStart(2, '0');
  return {
    dateKey: `${year}-${month}-${day}`,
    dayOfWeek: cstDate.getUTCDay(), // 0=Sun..6=Sat in UTC+8
    hour: cstDate.getUTCHours(),
  };
}

/**
 * DeepSeek 官方分时判定（UTC+8 北京时间）：工作日 9:00-12:00 与 14:00-18:00 为高峰；
 * 周末与国务院 2026 法定节假日（及显式假日覆盖）全天按空闲时段计价。
 */
export function isDeepSeekOfficialPeakWindow(
  nowMs = Date.now(),
  opts?: { isCnHolidayOverride?: boolean },
): boolean {
  const { dateKey, dayOfWeek, hour } = cstCalendarParts(nowMs);
  if (opts?.isCnHolidayOverride === true) return false;
  if (opts?.isCnHolidayOverride !== false && CN_STATUTORY_HOLIDAYS_2026.has(dateKey)) {
    return false;
  }
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * 阿里云百炼 DeepSeek 分时判定（UTC+8 北京时间）：22:00-次日08:00 为闲时，其余 08:00-22:00 为高峰。
 */
export function isBailianDeepSeekPeakWindow(nowMs = Date.now()): boolean {
  const { hour } = cstCalendarParts(nowMs);
  return hour >= 8 && hour < 22;
}

export function resolveProviderCapabilities(
  config: Pick<CoachProviderConfig, 'kind' | 'baseUrl' | 'model'> & {
    presetId?: string;
    contextWindowOverride?: number;
    pricingWindowOverride?: 'peak' | 'off_peak';
    isCnHolidayOverride?: boolean;
    nowMs?: number;
    probedOverrides?: Partial<ProviderDeploymentCapabilities>;
  },
): ProviderDeploymentCapabilities {
  const baseUrl = config.baseUrl.trim();
  const urlLower = baseUrl.toLowerCase();
  const model = config.model.trim();
  const modelLower = model.toLowerCase();
  const deploymentId = computeDeploymentId({
    kind: config.kind,
    presetId: config.presetId,
    baseUrl,
    model,
  });
  const wireKind = config.kind;
  const wireReasoningFieldFormat: ReasoningFieldFormat =
    wireKind === 'anthropic'
      ? 'anthropic_thinking_blocks'
      : wireKind === 'gemini'
        ? 'gemini_thought_parts'
        : 'none';
  const wireThinkingControlStyle: ThinkingControlStyle =
    wireKind === 'anthropic'
      ? 'anthropic_thinking_budget'
      : wireKind === 'gemini'
        ? 'gemini_thinking_config'
        : 'none';

  // 先识别实际部署与模型，再结合所选 wire 协议决定编码格式、思考控制字段与缓存策略
  if (isBailianDeepSeekDeployment(baseUrl, model, config.presetId)) {
    const isReasonerOnly = modelLower.includes('r1') && !modelLower.includes('v3') && !modelLower.includes('v4');
    const isBeijingHost =
      urlLower.includes('dashscope.aliyuncs.com') && !urlLower.includes('dashscope-intl.aliyuncs.com');
    const isFlashVerifiedModel = /^deepseek-v4\.1-flash(?:-1017)?$/i.test(modelLower);
    const isProModel = /^deepseek-(?:v4(?:\.\d+)?-)?pro/i.test(modelLower);
    const peak = config.pricingWindowOverride
      ? config.pricingWindowOverride === 'peak'
      : isBailianDeepSeekPeakWindow(config.nowMs);
    const bailianPricing: ProviderPricingSchedule =
      isBeijingHost && isFlashVerifiedModel
        ? peak
          ? {
              currency: 'CNY',
              inputPer1MTokens: 2.0,
              cachedInputPer1MTokens: 0.04,
              outputPer1MTokens: 8.0,
              pricingWindow: 'peak',
              pricingRegion: 'cn-beijing',
              pricingNote: '百炼 cn-beijing 忙时（08:00-22:00 CST，缓存命中按 2%）',
            }
          : {
              currency: 'CNY',
              inputPer1MTokens: 1.0,
              cachedInputPer1MTokens: 0.02,
              outputPer1MTokens: 4.0,
              pricingWindow: 'off_peak',
              pricingRegion: 'cn-beijing',
              pricingNote: '百炼 cn-beijing 闲时（22:00-08:00 CST，缓存命中按 2%）',
            }
        : {
            currency: 'unknown',
            inputPer1MTokens: null,
            cachedInputPer1MTokens: null,
            outputPer1MTokens: null,
            pricingWindow: 'unknown',
            pricingRegion: urlLower.includes('dashscope-intl.aliyuncs.com') ? 'intl-unverified' : isBeijingHost ? 'cn-beijing-unverified-model' : 'unknown',
            pricingNote: '仅对百炼北京已核实型号计费，其余部署或地域价格留空（unknown）',
          };

    return applyCapabilityOverrides(
      {
        deploymentId,
        presetId: 'bailian-deepseek',
        displayName: wireKind === 'anthropic' ? '阿里百炼 DeepSeek (Messages)' : '阿里百炼 DeepSeek',
        protocolKind: wireKind,
        upstreamFamily: 'bailian-deepseek',
        cacheMechanism: 'implicit_prefix',
        // 严格遵守审查规则：百炼已列明隐式缓存的模型部署默认不发 cache_control breakpoints
        sendCacheControlBreakpoints: false,
        maxCacheBreakpoints: 0,
        cacheMinPrefixTokens: 64,
        requiresReasoningReplayWithTools: true,
        reasoningFieldFormat:
          wireKind === 'openai-compatible' ? 'deepseek_reasoning_content' : wireReasoningFieldFormat,
        thinkingControlStyle:
          wireKind === 'openai-compatible'
            ? isReasonerOnly
              ? 'none'
              : 'bailian_enable_thinking'
            : wireThinkingControlStyle,
        supportedThinkingLevels:
          wireKind === 'anthropic'
            ? isReasonerOnly
              ? ['high']
              : ['off', 'low', 'medium', 'high', 'max']
            : isReasonerOnly
              ? ['high']
              : ['off', 'high'],
        supportsNativeVision: isFlashVerifiedModel && !isProModel,
        supportsNativeVideo: false,
        supportsNativeWebSearch: false,
        supportsToolSubset: false,
        supportsTitleModelCall: false,
        contextWindowTokens: config.contextWindowOverride ?? (isFlashVerifiedModel ? 1_048_576 : 131_072),
        maxOutputTokens: 8192,
        pricing: bailianPricing,
      },
      config.probedOverrides,
    );
  }

  if (isOfficialDeepSeekEndpoint(baseUrl, model, config.presetId)) {
    const isReasoner = modelLower === 'deepseek-reasoner' || modelLower.includes('reasoner');
    const isFlash = /^deepseek-(?:v4\.1-)?flash(?:$|-)/i.test(modelLower);
    const isPro = /^deepseek-(?:v4(?:\.\d+)?-)?pro(?:$|-)/i.test(modelLower);
    const isDeprecatedChat = modelLower === 'deepseek-chat';
    const peak = config.pricingWindowOverride
      ? config.pricingWindowOverride === 'peak'
      : isDeepSeekOfficialPeakWindow(config.nowMs, {
          isCnHolidayOverride: config.isCnHolidayOverride,
        });
    const officialPricing: ProviderPricingSchedule = isFlash
      ? peak
        ? {
            currency: 'CNY',
            inputPer1MTokens: 2.0,
            cachedInputPer1MTokens: 0.04,
            outputPer1MTokens: 8.0,
            pricingWindow: 'peak',
            pricingRegion: 'cn',
            pricingNote: 'DeepSeek 官方 Flash 高峰时段（法定节假日与周末全天空闲计价）',
          }
        : {
            currency: 'CNY',
            inputPer1MTokens: 1.0,
            cachedInputPer1MTokens: 0.02,
            outputPer1MTokens: 4.0,
            pricingWindow: 'off_peak',
            pricingRegion: 'cn',
            pricingNote: 'DeepSeek 官方 Flash 空闲时段（含命中 2%）',
          }
      : isPro
        ? peak
          ? {
              currency: 'CNY',
              inputPer1MTokens: 9.0,
              cachedInputPer1MTokens: 0.3,
              outputPer1MTokens: 27.0,
              pricingWindow: 'peak',
              pricingRegion: 'cn',
              pricingNote: 'DeepSeek 官方 Pro 高峰时段（¥9 / ¥0.30 / ¥27 per 1M tokens）',
            }
          : {
              currency: 'CNY',
              inputPer1MTokens: 4.5,
              cachedInputPer1MTokens: 0.15,
              outputPer1MTokens: 13.5,
              pricingWindow: 'off_peak',
              pricingRegion: 'cn',
              pricingNote: 'DeepSeek 官方 Pro 空闲时段（¥4.50 / ¥0.15 / ¥13.50 per 1M tokens）',
            }
        : {
            currency: 'unknown',
            inputPer1MTokens: null,
            cachedInputPer1MTokens: null,
            outputPer1MTokens: null,
            pricingWindow: 'unknown',
            pricingRegion: 'cn',
            pricingNote: isDeprecatedChat
              ? 'deepseek-chat 已公告于 2026-07-24 停用，请切换 deepseek-flash；旧名费率留空'
              : '未核实 DeepSeek 模型费率，价格留空（unknown）',
          };

    return applyCapabilityOverrides(
      {
        deploymentId,
        presetId: 'deepseek-official',
        displayName:
          wireKind === 'anthropic'
            ? 'DeepSeek 官方 (Messages)'
            : wireKind === 'gemini'
              ? 'DeepSeek 官方 (Gemini)'
              : 'DeepSeek 官方',
        protocolKind: wireKind,
        upstreamFamily: 'deepseek',
        cacheMechanism: 'implicit_prefix',
        // 严格规则：DeepSeek 官方（含 Anthropic Messages 兼容入口）走隐式磁盘缓存，不发显式 cache_control 断点
        sendCacheControlBreakpoints: false,
        maxCacheBreakpoints: 0,
        cacheMinPrefixTokens: 64,
        requiresReasoningReplayWithTools: true,
        reasoningFieldFormat:
          wireKind === 'openai-compatible' ? 'deepseek_reasoning_content' : wireReasoningFieldFormat,
        thinkingControlStyle:
          wireKind === 'openai-compatible' ? 'deepseek_mode' : wireThinkingControlStyle,
        supportedThinkingLevels:
          wireKind === 'anthropic'
            ? isReasoner
              ? ['high']
              : ['off', 'low', 'medium', 'high', 'max']
            : isReasoner
              ? ['high']
              : isFlash || isPro
                ? ['off', 'low', 'high', 'max']
                : ['off', 'high'],
        supportsNativeVision: isFlash && !isPro,
        supportsNativeVideo: false,
        supportsNativeWebSearch: false,
        supportsToolSubset: false,
        supportsTitleModelCall: false,
        contextWindowTokens: config.contextWindowOverride ?? (isFlash || isPro ? 1_048_576 : 131_072),
        maxOutputTokens: 8192,
        pricing: officialPricing,
      },
      config.probedOverrides,
    );
  }

  if (isOfficialAnthropicEndpoint(baseUrl, config.presetId)) {
    const isHaiku = modelLower.includes('haiku');
    const isOpus = modelLower.includes('opus');
    const inputPer1M = isOpus ? 15 : isHaiku ? 1 : 3;
    const cachedPer1M = isOpus ? 1.5 : isHaiku ? 0.1 : 0.3;
    const write5mPer1M = isOpus ? 18.75 : isHaiku ? 1.25 : 3.75;
    const outputPer1M = isOpus ? 75 : isHaiku ? 5 : 15;
    return applyCapabilityOverrides(
      {
        deploymentId,
        presetId: config.presetId ?? 'anthropic-official',
        displayName: 'Anthropic Messages',
        protocolKind: wireKind,
        upstreamFamily: 'anthropic',
        cacheMechanism: 'explicit_breakpoints',
        sendCacheControlBreakpoints: wireKind === 'anthropic',
        maxCacheBreakpoints: wireKind === 'anthropic' ? 4 : 0,
        cacheMinPrefixTokens: isHaiku || modelLower.includes('opus-4-6') ? 4096 : 1024,
        requiresReasoningReplayWithTools: true,
        reasoningFieldFormat:
          wireKind === 'openai-compatible' ? 'anthropic_thinking_blocks' : wireReasoningFieldFormat,
        thinkingControlStyle:
          wireKind === 'openai-compatible' ? 'anthropic_thinking_budget' : wireThinkingControlStyle,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'max'],
        supportsNativeVision: true,
        supportsNativeVideo: false,
        supportsNativeWebSearch: true,
        supportsToolSubset: true,
        supportsTitleModelCall: false,
        contextWindowTokens: config.contextWindowOverride ?? 200_000,
        maxOutputTokens: 8192,
        pricing: {
          currency: 'USD',
          inputPer1MTokens: inputPer1M,
          cachedInputPer1MTokens: cachedPer1M,
          cacheWrite5mPer1MTokens: write5mPer1M,
          outputPer1MTokens: outputPer1M,
        },
      },
      config.probedOverrides,
    );
  }

  if (isOfficialGeminiEndpoint(baseUrl, config.presetId)) {
    const isPro = modelLower.includes('pro');
    const is25 = modelLower.includes('2.5');
    return applyCapabilityOverrides(
      {
        deploymentId,
        presetId: config.presetId ?? 'gemini-official',
        displayName: 'Google Gemini',
        protocolKind: wireKind,
        upstreamFamily: 'gemini',
        cacheMechanism: 'implicit_or_explicit',
        sendCacheControlBreakpoints: false,
        maxCacheBreakpoints: 0,
        cacheMinPrefixTokens: is25 ? 2048 : 4096,
        requiresReasoningReplayWithTools: true,
        reasoningFieldFormat:
          wireKind === 'openai-compatible' ? 'gemini_thought_parts' : wireReasoningFieldFormat,
        thinkingControlStyle:
          wireKind === 'openai-compatible' ? 'gemini_thinking_config' : wireThinkingControlStyle,
        supportedThinkingLevels: is25 && isPro ? ['low', 'medium', 'high'] : ['off', 'low', 'medium', 'high'],
        supportsNativeVision: true,
        supportsNativeVideo: true,
        supportsNativeWebSearch: true,
        supportsToolSubset: true,
        supportsTitleModelCall: false,
        contextWindowTokens: config.contextWindowOverride ?? 1_048_576,
        maxOutputTokens: 8192,
        pricing: {
          currency: 'USD',
          inputPer1MTokens: isPro ? 1.25 : 0.3,
          cachedInputPer1MTokens: isPro ? 0.3125 : 0.075,
          outputPer1MTokens: isPro ? 10 : 2.5,
        },
      },
      config.probedOverrides,
    );
  }

  if (isOfficialOpenAiEndpoint(baseUrl, config.presetId)) {
    const isMini = modelLower.includes('mini');
    const isNano = modelLower.includes('nano');
    return applyCapabilityOverrides(
      {
        deploymentId,
        presetId: 'openai-official',
        displayName: 'OpenAI 官方',
        protocolKind: wireKind,
        upstreamFamily: 'openai',
        cacheMechanism: 'implicit_prefix',
        sendCacheControlBreakpoints: false,
        maxCacheBreakpoints: 0,
        cacheMinPrefixTokens: 1024,
        requiresReasoningReplayWithTools: wireKind !== 'openai-compatible',
        reasoningFieldFormat: wireReasoningFieldFormat,
        thinkingControlStyle:
          wireKind === 'openai-compatible'
            ? /^o[134]|gpt-5/i.test(modelLower)
              ? 'openai_reasoning_effort'
              : 'none'
            : wireThinkingControlStyle,
        supportedThinkingLevels: /^o[134]|gpt-5/i.test(modelLower)
          ? ['minimal', 'low', 'medium', 'high']
          : ['default'],
        supportsNativeVision: true,
        supportsNativeVideo: false,
        supportsNativeWebSearch: false,
        supportsToolSubset: true,
        supportsTitleModelCall: false,
        contextWindowTokens: config.contextWindowOverride ?? 128_000,
        maxOutputTokens: 8192,
        pricing: {
          currency: 'USD',
          inputPer1MTokens: isNano ? 0.1 : isMini ? 0.15 : 2.5,
          cachedInputPer1MTokens: isNano ? 0.025 : isMini ? 0.075 : 1.25,
          outputPer1MTokens: isNano ? 0.4 : isMini ? 0.6 : 10,
        },
      },
      config.probedOverrides,
    );
  }

  // 通用自定义代理（含 OpenAI-compatible / Anthropic / Gemini 兼容反代）：保留所选 wire 协议，但价格与缓存机制保持保守 unknown
  const looksVision =
    /gpt-4o|gpt-4\.1|gpt-5|claude|gemini|qwen.*vl|vl|vision|omni/i.test(modelLower);
  const looksVideo = /gemini|qwen.*vl|vl|vision|omni|video/i.test(modelLower);
  return applyCapabilityOverrides(
    {
      deploymentId,
      presetId: config.presetId ?? 'custom-proxy',
      displayName:
        wireKind === 'anthropic'
          ? '自定义兼容接口 (Messages)'
          : wireKind === 'gemini'
            ? '自定义兼容接口 (Gemini)'
            : '自定义兼容接口',
      protocolKind: wireKind,
      upstreamFamily: 'custom-proxy',
      cacheMechanism: 'unknown',
      sendCacheControlBreakpoints: false,
      maxCacheBreakpoints: 0,
      cacheMinPrefixTokens: 0,
      requiresReasoningReplayWithTools: wireKind !== 'openai-compatible',
      reasoningFieldFormat: wireReasoningFieldFormat,
      thinkingControlStyle: wireThinkingControlStyle,
      supportedThinkingLevels:
        wireKind === 'anthropic'
          ? ['off', 'low', 'medium', 'high', 'max']
          : ['off', 'low', 'medium', 'high'],
      supportsNativeVision: looksVision,
      supportsNativeVideo: looksVideo,
      supportsNativeWebSearch: false,
      supportsToolSubset: false,
      supportsTitleModelCall: false,
      contextWindowTokens: config.contextWindowOverride ?? 128_000,
      maxOutputTokens: wireKind === 'openai-compatible' ? 4096 : 8192,
      pricing: {
        currency: 'unknown',
        inputPer1MTokens: null,
        cachedInputPer1MTokens: null,
        outputPer1MTokens: null,
      },
    },
    config.probedOverrides,
  );
}

function applyCapabilityOverrides(
  base: ProviderDeploymentCapabilities,
  overrides?: Partial<ProviderDeploymentCapabilities>,
): ProviderDeploymentCapabilities {
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    pricing: overrides.pricing ? { ...base.pricing, ...overrides.pricing } : base.pricing,
  };
}

/**
 * 手动按需的轻量能力探测（仅在用户主动点「探测端点能力」时执行，普通对话绝不自动发探测请求）。
 * 用无副作用的最小合成工具定义验证协议、reasoning 字段回传与 usage 可见性。
 */
export async function probeDeploymentCapabilities(
  config: CoachProviderConfig,
): Promise<Partial<ProviderDeploymentCapabilities>> {
  const fetcher = config.fetch ?? getCoachFetch();
  const baseCaps = resolveProviderCapabilities(config);
  const now = Date.now();
  const cleanUrl = config.baseUrl.trim().replace(/\/+$/, '');
  const notes: string[] = [];

  if (config.kind === 'openai-compatible') {
    const endpoint = /\/chat\/completions$/i.test(cleanUrl)
      ? cleanUrl
      : /\/v1$/i.test(cleanUrl) || /\/compatible-mode\/v1$/i.test(cleanUrl)
        ? `${cleanUrl}/chat/completions`
        : `${cleanUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(config.headers ?? {}),
    };
    if (config.apiKey?.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }

    try {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model.trim(),
          stream: false,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'ping: reply ok only' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'noop_probe',
                description: 'No-op capability probe tool',
                parameters: { type: 'object', properties: { echo: { type: 'string' } } },
              },
            },
          ],
        }),
      });
      if (!res.ok) {
        notes.push(`HTTP ${res.status}`);
        return { probedAt: now, probeNotes: notes.join('; ') };
      }
      const data = (await res.json()) as {
        usage?: Record<string, unknown>;
        choices?: Array<{ message?: Record<string, unknown> }>;
      };
      const msg = data.choices?.[0]?.message ?? {};
      const hasReasoning =
        typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0;
      const usageKeys = Object.keys(data.usage ?? {});
      notes.push(`usage字段:[${usageKeys.join(',') || 'none'}]`);
      if (hasReasoning) notes.push('返回 reasoning_content');
      return {
        probedAt: now,
        probeNotes: notes.join(' · '),
        ...(hasReasoning
          ? {
              reasoningFieldFormat: 'deepseek_reasoning_content' as const,
              requiresReasoningReplayWithTools: true,
            }
          : {}),
      };
    } catch (err) {
      return {
        probedAt: now,
        probeNotes: err instanceof Error ? err.message : '探测请求失败',
      };
    }
  }

  return {
    ...baseCaps,
    probedAt: now,
    probeNotes: `使用内置 ${baseCaps.displayName} 能力配置`,
  };
}
