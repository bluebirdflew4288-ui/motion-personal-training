/* 电子教练按物理请求独立建账与前端对比指标计算（v0.2.3）。
   关键会计边界：
   1. 每次物理 HTTP 请求（含 tool 循环每一步、摘要压缩、独立识图、可选标题/搜索）各记一笔账单；
   2. 严格区分供应商原生口径：
      · DeepSeek 官方：prompt_cache_hit_tokens（缓存读）与 prompt_cache_miss_tokens（普通冷输入）互斥；
      · 阿里百炼 DeepSeek：prompt_tokens 包含 prompt_tokens_details.cached_tokens；
      · Anthropic Messages：input_tokens **仅为未命中普通输入**，totalInput = input_tokens + cache_read_input_tokens + cache_creation_input_tokens；
      · Gemini GenerateContent：promptTokenCount **已包含** cachedContentTokenCount；
      · usage 缺失时标记 source='unknown'、cost=null（绝不拿客户端估算冒充真实账单）。
   3. 缓存命中率定义：`ΣcachedInputTokens / (ΣcachedInputTokens + ΣuncachedInputTokens)`，
      不拿「至少命中过 1 token 的请求占比」虚高美化指标。 */

import type {
  CoachBillingMetricSource,
  CoachBillingRecord,
  CoachBillingRequestSource,
  CoachCostBounds,
  CoachCurrencySubtotal,
  CoachThreadBillingTotals,
  CoachWebSearchProvider,
} from './coachStorage';
import type { ProviderDeploymentCapabilities } from './providerCapabilities';
import { fnv1a64Hex } from './coachMainTx';

export interface NormalizeBillingParams {
  id: string;
  threadId: string;
  segmentId: string;
  turnId?: string;
  round: number;
  purpose: CoachBillingRecord['purpose'];
  requestSource?: CoachBillingRequestSource;
  searchProvider?: CoachWebSearchProvider;
  capabilities: ProviderDeploymentCapabilities;
  rawUsage?: Record<string, unknown>;
  fallbackEstimatedInputTokens?: number;
  prefixDigest?: string;
  systemPromptDigest?: string;
  toolsDigest?: string;
  prefixByteLength?: number;
  exactPrefixMatchedPrevRound?: boolean;
  durationMs?: number;
  ttftMs?: number;
  operationIdsCompleted?: string[];
  loggedSetsCount?: number;
  createdAt?: number;
}

function finiteNonNeg(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** 生成本地非明文加盐前缀摘要（绝不外泄训练明文或思考原文） */
export function saltedPrefixDigest(salt: string, serializedPrefix: string): string {
  return `${serializedPrefix.length}:${fnv1a64Hex(`${salt}::${serializedPrefix}`)}`;
}

export function normalizeUsageToBillingRecord(params: NormalizeBillingParams): CoachBillingRecord {
  const { capabilities, rawUsage } = params;
  const createdAt = params.createdAt ?? Date.now();

  if (params.requestSource === 'external_search') {
    const providerTag = params.searchProvider ?? 'builtin';
    return {
      id: params.id,
      threadId: params.threadId,
      segmentId: params.segmentId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      round: params.round,
      purpose: params.purpose,
      requestSource: 'external_search',
      ...(params.searchProvider ? { searchProvider: params.searchProvider } : {}),
      createdAt,
      providerKind: capabilities.protocolKind,
      deploymentId: `external-search:${providerTag}`,
      model: `external-search:${providerTag}`,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      source: 'unknown',
      cacheDetailSource: 'unknown',
      computedCostUsd: null,
      currency: 'unknown',
      cacheHitRatio: null,
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    };
  }

  const pricing = capabilities.pricing;
  const currency = pricing.currency;

  let inputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let uncachedInputTokens = 0;
  let unknownCacheInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  let totalTokens = 0;
  let source: CoachBillingMetricSource = 'unknown';
  let cacheDetailSource: 'measured' | 'unknown' = 'unknown';

  if (rawUsage && typeof rawUsage === 'object') {
    if (capabilities.protocolKind === 'anthropic') {
      const inp = finiteNonNeg(rawUsage.input_tokens);
      const cacheReadRaw = finiteNonNeg(rawUsage.cache_read_input_tokens);
      const cacheCreateRaw = finiteNonNeg(rawUsage.cache_creation_input_tokens);
      const cacheRead = cacheReadRaw ?? 0;
      const cacheCreate = cacheCreateRaw ?? 0;
      const out = finiteNonNeg(rawUsage.output_tokens);
      if (inp !== null || cacheRead > 0 || cacheCreate > 0 || out !== null) {
        outputTokens = out ?? 0;
        source = 'measured';
        if (cacheReadRaw !== null || cacheCreateRaw !== null) {
          cacheDetailSource = 'measured';
          uncachedInputTokens = inp ?? 0;
          cachedInputTokens = cacheRead;
          cacheCreationInputTokens = cacheCreate;
          inputTokens = uncachedInputTokens + cachedInputTokens + cacheCreationInputTokens;
        } else {
          inputTokens = inp ?? 0;
          unknownCacheInputTokens = inputTokens;
        }
        totalTokens = inputTokens + outputTokens;
      }
    } else if (capabilities.protocolKind === 'gemini') {
      const promptCount = finiteNonNeg(rawUsage.promptTokenCount);
      const cachedCountRaw = finiteNonNeg(rawUsage.cachedContentTokenCount);
      const candCount = finiteNonNeg(rawUsage.candidatesTokenCount);
      const thoughtCount = finiteNonNeg(rawUsage.thoughtsTokenCount) ?? 0;
      const totalCount = finiteNonNeg(rawUsage.totalTokenCount);
      if (promptCount !== null || candCount !== null) {
        inputTokens = promptCount ?? 0;
        if (cachedCountRaw !== null) {
          cacheDetailSource = 'measured';
          cachedInputTokens = Math.min(inputTokens, cachedCountRaw);
          uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
        } else {
          unknownCacheInputTokens = inputTokens;
        }
        reasoningOutputTokens = thoughtCount;
        // Gemini candidatesTokenCount 与 thoughtsTokenCount 各自计费，总输出覆盖候选+思考
        outputTokens = (candCount ?? 0) + thoughtCount;
        totalTokens = totalCount ?? inputTokens + outputTokens;
        source = 'measured';
      }
    } else {
      // OpenAI-compatible（DeepSeek 官方 / 百炼 / OpenAI / 兼容网关）
      const hitTokens = finiteNonNeg(rawUsage.prompt_cache_hit_tokens);
      const missTokens = finiteNonNeg(rawUsage.prompt_cache_miss_tokens);
      const promptDetails = (rawUsage.prompt_tokens_details ?? undefined) as
        | Record<string, unknown>
        | undefined;
      const detailCached = finiteNonNeg(promptDetails?.cached_tokens);
      const detailWrite =
        finiteNonNeg(promptDetails?.cache_creation_input_tokens) ??
        finiteNonNeg(rawUsage.prompt_cache_creation_tokens) ??
        0;
      const promptTok = finiteNonNeg(rawUsage.prompt_tokens);
      const completionTok = finiteNonNeg(rawUsage.completion_tokens);
      const completionDetails = (rawUsage.completion_tokens_details ?? undefined) as
        | Record<string, unknown>
        | undefined;
      const reasonTok = finiteNonNeg(completionDetails?.reasoning_tokens) ?? 0;
      const totalTok = finiteNonNeg(rawUsage.total_tokens);

      if (hitTokens !== null || missTokens !== null) {
        // DeepSeek 官方口径：hit 与 miss 为互斥输入桶
        cachedInputTokens = hitTokens ?? 0;
        uncachedInputTokens = missTokens ?? Math.max(0, (promptTok ?? 0) - cachedInputTokens);
        inputTokens = promptTok ?? cachedInputTokens + uncachedInputTokens;
        source = 'measured';
        cacheDetailSource = 'measured';
      } else if (promptTok !== null) {
        inputTokens = promptTok;
        source = 'measured';
        if (detailCached !== null) {
          cacheDetailSource = 'measured';
          cachedInputTokens = Math.min(inputTokens, detailCached);
          cacheCreationInputTokens = Math.min(Math.max(0, inputTokens - cachedInputTokens), detailWrite);
          uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens - cacheCreationInputTokens);
        } else {
          // 明确缺失缓存明细：绝不把整段 prompt_tokens 当作已确认 miss！
          unknownCacheInputTokens = inputTokens;
        }
      }

      if (completionTok !== null) {
        outputTokens = completionTok;
        reasoningOutputTokens = Math.min(completionTok, reasonTok);
        source = 'measured';
      }
      if (source === 'measured') {
        totalTokens = totalTok ?? inputTokens + outputTokens;
      }
    }
  }

  let computedCostUsd: number | null = null;
  let costBounds: CoachCostBounds | null = null;
  if (
    source === 'measured' &&
    currency !== 'unknown' &&
    pricing.inputPer1MTokens !== null &&
    pricing.outputPer1MTokens !== null
  ) {
    const cachedRate = pricing.cachedInputPer1MTokens ?? pricing.inputPer1MTokens;
    const createRate = pricing.cacheWrite5mPer1MTokens ?? pricing.inputPer1MTokens;
    if (cacheDetailSource === 'measured' || cachedRate === pricing.inputPer1MTokens || inputTokens === 0) {
      const effectiveMiss = cacheDetailSource === 'measured' ? uncachedInputTokens : inputTokens;
      const rawCost =
        (effectiveMiss * pricing.inputPer1MTokens +
          cachedInputTokens * cachedRate +
          cacheCreationInputTokens * createRate +
          outputTokens * pricing.outputPer1MTokens) /
        1_000_000;
      computedCostUsd = Number(rawCost.toFixed(8));
    } else {
      const minRate = Math.min(cachedRate, pricing.inputPer1MTokens);
      const maxRate = Math.max(cachedRate, pricing.inputPer1MTokens);
      const minCost =
        (inputTokens * minRate + outputTokens * pricing.outputPer1MTokens) / 1_000_000;
      const maxCost =
        (inputTokens * maxRate + outputTokens * pricing.outputPer1MTokens) / 1_000_000;
      computedCostUsd = null;
      costBounds = {
        min: Number(minCost.toFixed(8)),
        max: Number(maxCost.toFixed(8)),
      };
    }
  }

  const denom = cachedInputTokens + uncachedInputTokens + cacheCreationInputTokens;
  const cacheHitRatio =
    source === 'measured' && cacheDetailSource === 'measured' && denom > 0
      ? Number((cachedInputTokens / denom).toFixed(6))
      : null;

  return {
    id: params.id,
    threadId: params.threadId,
    segmentId: params.segmentId,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    round: params.round,
    purpose: params.purpose,
    requestSource: params.requestSource ?? 'model',
    ...(params.searchProvider ? { searchProvider: params.searchProvider } : {}),
    createdAt,
    providerKind: capabilities.protocolKind,
    deploymentId: capabilities.deploymentId,
    model: capabilities.deploymentId.split(':').slice(2).join(':') || capabilities.displayName,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    ...(unknownCacheInputTokens > 0 ? { unknownCacheInputTokens } : {}),
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    source,
    cacheDetailSource,
    computedCostUsd,
    ...(costBounds ? { costBounds } : {}),
    currency,
    cacheHitRatio,
    ...(params.prefixDigest ? { prefixDigest: params.prefixDigest } : {}),
    ...(params.systemPromptDigest ? { systemPromptDigest: params.systemPromptDigest } : {}),
    ...(params.toolsDigest ? { toolsDigest: params.toolsDigest } : {}),
    ...(params.prefixByteLength !== undefined ? { prefixByteLength: params.prefixByteLength } : {}),
    ...(params.exactPrefixMatchedPrevRound !== undefined
      ? { exactPrefixMatchedPrevRound: params.exactPrefixMatchedPrevRound }
      : {}),
    ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    ...(params.ttftMs !== undefined ? { ttftMs: params.ttftMs } : {}),
    ...(rawUsage ? { rawUsage } : {}),
    ...(params.operationIdsCompleted?.length
      ? { operationIdsCompleted: params.operationIdsCompleted }
      : {}),
    ...(params.loggedSetsCount !== undefined ? { loggedSetsCount: params.loggedSetsCount } : {}),
  };
}

export interface BillingSummaryReport {
  requests: number;
  externalSearchRequests: number;
  measuredRequests: number;
  unknownUsageRequests: number;
  usageCoverageRatio: number;
  cacheDetailMeasuredRequests: number;
  unknownCacheDetailRequests: number;
  cacheDetailCoverageRatio: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  unknownCacheInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  cacheHitRate: number | null;
  totalCost: number | null;
  costBounds: CoachCostBounds | null;
  currency: 'USD' | 'CNY' | 'unknown' | 'mixed';
  dedupedLoggedSets: number;
  costPerLoggedSet: number | null;
  missPerLoggedSet: number | null;
  subtotalsByCurrency: Partial<Record<'USD' | 'CNY', CoachCurrencySubtotal>>;
}

interface MutableCurrencyAcc {
  requests: number;
  measuredUsageRequests: number;
  measuredCacheDetailRequests: number;
  unknownCacheInputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  exactCostSum: number;
  minCostSum: number;
  maxCostSum: number;
  hasBoundedOnly: boolean;
  hasUnknownCost: boolean;
  hasAnyCostOrBounds: boolean;
  opIds: Set<string>;
  fallbackSets: number;
}

function makeCurrencyAcc(): MutableCurrencyAcc {
  return {
    requests: 0,
    measuredUsageRequests: 0,
    measuredCacheDetailRequests: 0,
    unknownCacheInputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    exactCostSum: 0,
    minCostSum: 0,
    maxCostSum: 0,
    hasBoundedOnly: false,
    hasUnknownCost: false,
    hasAnyCostOrBounds: false,
    opIds: new Set<string>(),
    fallbackSets: 0,
  };
}

/**
 * 判断账单记录是否属于“独立外部检索”（builtin / tavily / bocha / brave）。
 * · 新记录直接依据 requestSource / searchProvider / external-search 前缀识别；
 * · 已部署 v0.2.3 旧记录：原生模型搜索仅 providerKind==='gemini' 且总带 durationMs（即使 rawUsage 缺）；
 *   非 Gemini 已知协议（openai-compatible / anthropic）且 round=0、无 turnId / durationMs / rawUsage、
 *   source==='unknown' 且零 token 的 purpose==='web_search' 旧形状可确证来自独立外部检索；
 * · Gemini 来源不可确认的旧账继续保守视为模型请求。
 */
export function isExternalSearchBillingRecord(r: CoachBillingRecord): boolean {
  if (r.requestSource === 'external_search') return true;
  if (r.requestSource === 'model') return false;
  if (
    r.searchProvider === 'builtin' ||
    r.searchProvider === 'tavily' ||
    r.searchProvider === 'bocha' ||
    r.searchProvider === 'brave'
  ) {
    return true;
  }
  if (
    (typeof r.deploymentId === 'string' && r.deploymentId.startsWith('external-search:')) ||
    (typeof r.model === 'string' && r.model.startsWith('external-search:'))
  ) {
    return true;
  }
  if (
    r.purpose === 'web_search' &&
    (r.providerKind === 'openai-compatible' || r.providerKind === 'anthropic') &&
    r.round === 0 &&
    r.turnId === undefined &&
    r.durationMs === undefined &&
    r.rawUsage === undefined &&
    r.source === 'unknown' &&
    r.inputTokens === 0 &&
    r.outputTokens === 0
  ) {
    return true;
  }
  return false;
}

export function summarizeBillingRecords(records: readonly CoachBillingRecord[]): BillingSummaryReport {
  const modelRecords = records.filter((r) => !isExternalSearchBillingRecord(r));
  const externalSearchRecords = records.filter((r) => isExternalSearchBillingRecord(r));

  let measuredRequests = 0;
  let unknownUsageRequests = 0;
  let cacheDetailMeasuredRequests = 0;
  let measuredCacheHit = 0;
  let measuredCacheMissAndCreate = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let unknownCacheInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  const byCurrency = new Map<'CNY' | 'USD', MutableCurrencyAcc>();
  let hasUnknownCurrency = false;
  let hasAnyUnknownCostOverall = false;
  const completedSetOpIds = new Set<string>();
  let fallbackLoggedSets = 0;

  for (const r of modelRecords) {
    if (r.currency === 'unknown') {
      hasUnknownCurrency = true;
      hasAnyUnknownCostOverall = true;
    }
    const curKey = r.currency === 'CNY' || r.currency === 'USD' ? r.currency : null;
    const acc = curKey ? (byCurrency.get(curKey) ?? makeCurrencyAcc()) : null;
    if (curKey && acc && !byCurrency.has(curKey)) byCurrency.set(curKey, acc);
    if (acc) acc.requests += 1;

    if (r.operationIdsCompleted?.length) {
      for (const opId of r.operationIdsCompleted) {
        completedSetOpIds.add(opId);
        acc?.opIds.add(opId);
      }
    } else if (typeof r.loggedSetsCount === 'number' && r.loggedSetsCount > 0) {
      fallbackLoggedSets += r.loggedSetsCount;
      if (acc) acc.fallbackSets += r.loggedSetsCount;
    }

    if (r.source === 'measured') {
      measuredRequests += 1;
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      reasoningOutputTokens += r.reasoningOutputTokens;
      if (acc) {
        acc.measuredUsageRequests += 1;
        acc.outputTokens += r.outputTokens;
      }

      if (r.cacheDetailSource === 'measured') {
        cacheDetailMeasuredRequests += 1;
        cachedInputTokens += r.cachedInputTokens;
        uncachedInputTokens += r.uncachedInputTokens;
        cacheCreationInputTokens += r.cacheCreationInputTokens;
        measuredCacheHit += r.cachedInputTokens;
        measuredCacheMissAndCreate += r.uncachedInputTokens + r.cacheCreationInputTokens;
        if (acc) {
          acc.measuredCacheDetailRequests += 1;
          acc.cachedInputTokens += r.cachedInputTokens;
          acc.uncachedInputTokens += r.uncachedInputTokens;
          acc.cacheCreationInputTokens += r.cacheCreationInputTokens;
        }
      } else {
        const unkIn = r.unknownCacheInputTokens ?? r.inputTokens;
        unknownCacheInputTokens += unkIn;
        if (acc) acc.unknownCacheInputTokens += unkIn;
      }

      if (r.computedCostUsd !== null && acc) {
        acc.exactCostSum += r.computedCostUsd;
        acc.minCostSum += r.computedCostUsd;
        acc.maxCostSum += r.computedCostUsd;
        acc.hasAnyCostOrBounds = true;
      } else if (r.costBounds && acc) {
        acc.minCostSum += r.costBounds.min;
        acc.maxCostSum += r.costBounds.max;
        acc.hasBoundedOnly = true;
        acc.hasAnyCostOrBounds = true;
      } else {
        hasAnyUnknownCostOverall = true;
        if (acc) acc.hasUnknownCost = true;
      }
    } else {
      unknownUsageRequests += 1;
      hasAnyUnknownCostOverall = true;
      if (acc) acc.hasUnknownCost = true;
    }
  }

  const dedupedLoggedSets = completedSetOpIds.size || fallbackLoggedSets;
  const unknownCacheDetailRequests = Math.max(0, modelRecords.length - cacheDetailMeasuredRequests);
  const cacheDenom = measuredCacheHit + measuredCacheMissAndCreate;
  const cacheHitRate =
    cacheDetailMeasuredRequests > 0 && cacheDenom > 0
      ? Number((measuredCacheHit / cacheDenom).toFixed(6))
      : null;

  const subtotalsByCurrency: Partial<Record<'USD' | 'CNY', CoachCurrencySubtotal>> = {};
  for (const [cur, acc] of byCurrency.entries()) {
    const sets = acc.opIds.size || acc.fallbackSets;
    const totalCost =
      !acc.hasUnknownCost && !acc.hasBoundedOnly && acc.hasAnyCostOrBounds
        ? Number(acc.exactCostSum.toFixed(6))
        : null;
    const costBounds: CoachCostBounds | null =
      !acc.hasUnknownCost && acc.hasAnyCostOrBounds
        ? {
            min: Number(acc.minCostSum.toFixed(6)),
            max: Number(acc.maxCostSum.toFixed(6)),
          }
        : null;
    subtotalsByCurrency[cur] = {
      requests: acc.requests,
      loggedSetsCount: sets,
      measuredUsageRequests: acc.measuredUsageRequests,
      measuredCacheDetailRequests: acc.measuredCacheDetailRequests,
      unknownCacheInputTokens: acc.unknownCacheInputTokens,
      cachedInputTokens: acc.cachedInputTokens,
      uncachedInputTokens: acc.uncachedInputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens,
      outputTokens: acc.outputTokens,
      totalCost,
      costBounds,
      costPerLoggedSet:
        totalCost !== null && sets > 0 ? Number((totalCost / sets).toFixed(6)) : null,
    };
  }

  const currency: BillingSummaryReport['currency'] =
    byCurrency.size === 0
      ? 'unknown'
      : byCurrency.size === 1
        ? ([...byCurrency.keys()][0] as 'USD' | 'CNY')
        : 'mixed';

  let totalCost: number | null = null;
  let costBounds: CoachCostBounds | null = null;
  if (currency !== 'mixed' && currency !== 'unknown' && !hasUnknownCurrency && !hasAnyUnknownCostOverall) {
    const only = subtotalsByCurrency[currency];
    if (only) {
      totalCost = only.totalCost;
      costBounds = only.totalCost === null ? only.costBounds : null;
    }
  }

  const fullCoverageForMiss =
    dedupedLoggedSets > 0 && unknownUsageRequests === 0 && unknownCacheDetailRequests === 0;

  return {
    requests: modelRecords.length,
    externalSearchRequests: externalSearchRecords.length,
    measuredRequests,
    unknownUsageRequests,
    usageCoverageRatio: modelRecords.length ? measuredRequests / modelRecords.length : 1,
    cacheDetailMeasuredRequests,
    unknownCacheDetailRequests,
    cacheDetailCoverageRatio: modelRecords.length ? cacheDetailMeasuredRequests / modelRecords.length : 1,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    unknownCacheInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens,
    cacheHitRate,
    totalCost,
    costBounds,
    currency,
    dedupedLoggedSets,
    costPerLoggedSet:
      totalCost !== null && dedupedLoggedSets > 0
        ? Number((totalCost / dedupedLoggedSets).toFixed(6))
        : null,
    missPerLoggedSet: fullCoverageForMiss
      ? Number((uncachedInputTokens / dedupedLoggedSets).toFixed(2))
      : null,
    subtotalsByCurrency,
  };
}

export function billingTotalsFromRecords(records: readonly CoachBillingRecord[]): CoachThreadBillingTotals {
  const s = summarizeBillingRecords(records);
  return {
    requests: s.requests,
    inputTokens: s.inputTokens,
    cachedInputTokens: s.cachedInputTokens,
    uncachedInputTokens: s.uncachedInputTokens,
    ...(s.unknownCacheInputTokens > 0 ? { unknownCacheInputTokens: s.unknownCacheInputTokens } : {}),
    cacheCreationInputTokens: s.cacheCreationInputTokens,
    outputTokens: s.outputTokens,
    reasoningOutputTokens: s.reasoningOutputTokens,
    totalCostUsd: s.totalCost,
    ...(s.costBounds ? { costBounds: s.costBounds } : {}),
    currency: s.currency,
    unknownUsageRequests: s.unknownUsageRequests,
    unknownCacheDetailRequests: s.unknownCacheDetailRequests,
    loggedSetsCount: s.dedupedLoggedSets,
    missPerLoggedSet: s.missPerLoggedSet,
    costPerLoggedSet: s.costPerLoggedSet,
    subtotalsByCurrency: s.subtotalsByCurrency,
    ...(s.externalSearchRequests > 0 ? { externalSearchRequests: s.externalSearchRequests } : {}),
    summarySchemaVersion: 2,
  };
}
