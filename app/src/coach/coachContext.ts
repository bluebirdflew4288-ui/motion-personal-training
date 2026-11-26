/* 当前对话窗口上下文占用统计（优先采用接口真实返回 usage，无返回时本地快速估算）。 */

import type { CoachStoredMessage, CoachThreadUsage } from './coachStorage';

export interface CoachContextStats {
  systemAndToolsTokens: number;
  memoryTokens: number;
  conversationTokens: number;
  attachmentTokens: number;
  usedTokens: number;
  maxTokens: number;
  percent: number;
  percentExact: number;
  percentLabel: string;
  systemPct: number;
  memoryPct: number;
  conversationPct: number;
  attachmentPct: number;
  level: 'ok' | 'warn' | 'high';
  isMeasured: boolean;
  activeMessageCount: number;
  totalThreadMessages: number;
  compressedCount: number;
}

/** 轻量中英文混排 Token 估算：中文约 1.55 char/token，ASCII 约 3.8 char/token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk / 1.5 + ascii / 3.8);
}

export function resolveModelContextWindow(model: string, advertised?: number): number {
  if (typeof advertised === 'number' && Number.isFinite(advertised) && advertised >= 4096) {
    return Math.round(advertised);
  }
  const m = model.trim().toLowerCase();
  if (!m) return 128_000;
  if (/gemini-/.test(m)) return 1_048_576;
  if (/deepseek/.test(m)) return 1_048_576;
  if (/qwen-long/.test(m)) return 1_048_576;
  if (/gpt-5|^o[134](?:-|$)|claude-/.test(m)) return 200_000;
  if (/gpt-4\.1/.test(m)) return 1_048_576;
  if (/gpt-4o|gpt-4-turbo/.test(m)) return 128_000;
  if (/qwen/.test(m)) return 128_000;
  return 128_000;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (Math.abs(tokens - 1_048_576) <= 2048) return '1M';
  if (Math.abs(tokens - 2_097_152) <= 4096) return '2M';
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(tokens));
}

export function formatContextPercent(usedTokens: number, maxTokens: number): string {
  if (!Number.isFinite(usedTokens) || !Number.isFinite(maxTokens) || usedTokens <= 0 || maxTokens <= 0) {
    return '0%';
  }
  const pct = (usedTokens / maxTokens) * 100;
  if (pct < 1) {
    return `${Math.max(0.1, Math.round(pct * 10) / 10)}%`;
  }
  return `${Math.min(100, Math.round(pct))}%`;
}

export function formatDurationCompact(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

export function shouldAutoCompressContext(stats: CoachContextStats, compressibleCount: number): boolean {
  return stats.percent >= 80 && compressibleCount >= 6;
}

export interface ModelContextLimits {
  totalWindowTokens: number;
  maxInputTokens: number;
  reservedOutputTokens: number;
}

export function resolveModelContextLimits(
  model: string,
  advertisedMaxTokens?: number,
  reservedOutputTokens = 8192,
): ModelContextLimits {
  const totalWindowTokens = resolveModelContextWindow(model, advertisedMaxTokens);
  const safeReserved = Math.min(Math.max(1024, reservedOutputTokens), Math.floor(totalWindowTokens * 0.25));
  return {
    totalWindowTokens,
    maxInputTokens: Math.max(2048, totalWindowTokens - safeReserved),
    reservedOutputTokens: safeReserved,
  };
}

export interface HardContextBudgetResult {
  ok: boolean;
  exceedsHardLimit: boolean;
  projectedTotalTokens: number;
  maxInputTokens: number;
  totalWindowTokens: number;
  reason?: string;
}

export function checkHardContextBudget(params: {
  estimatedInputTokens: number;
  incomingToolResultTokens?: number;
  model: string;
  advertisedMaxTokens?: number;
  reservedOutputTokens?: number;
  safetyMarginRatio?: number;
}): HardContextBudgetResult {
  const limits = resolveModelContextLimits(
    params.model,
    params.advertisedMaxTokens,
    params.reservedOutputTokens,
  );
  const margin = Math.ceil(params.estimatedInputTokens * (params.safetyMarginRatio ?? 0.08));
  const projectedInput = params.estimatedInputTokens + (params.incomingToolResultTokens ?? 0) + margin;
  const projectedTotal = projectedInput + limits.reservedOutputTokens;
  const exceedsHardLimit =
    projectedInput > limits.maxInputTokens || projectedTotal > limits.totalWindowTokens;

  return {
    ok: !exceedsHardLimit,
    exceedsHardLimit,
    projectedTotalTokens: projectedTotal,
    maxInputTokens: limits.maxInputTokens,
    totalWindowTokens: limits.totalWindowTokens,
    ...(exceedsHardLimit
      ? {
          reason: `预计上下文 (${projectedTotal}) 超出模型窗口/输入安全上限 (${limits.maxInputTokens}/${limits.totalWindowTokens})`,
        }
      : {}),
  };
}

export interface EconomicCompactionDecision {
  shouldCheckEconomic: boolean;
  shouldCompact: boolean;
  reason: string;
  projectedBreakEvenRequests: number;
  estimatedSavingsEquivTokens: number;
  estimatedCompactionCostEquivTokens: number;
}

export const ECONOMIC_COMPACTION_CHECK_TOKENS = 24_000;
export const ECONOMIC_COMPACTION_CANDIDATE_TOKENS = 32_000;

/**
 * 经济压缩决策模型（与大窗口百分比阈值解耦）：
 * · 仅当累计/下次输入 >= 24k 开始测算回本，>= 32k 作为自动压缩候选；
 * · 回本条件：预计剩余请求数 * 每请求可省冷/热等价成本 > 摘要开销 + 失去热前缀冷读成本 + 重建基线首写代价。
 */
export function evaluateEconomicCompaction(params: {
  usedTokens: number;
  estimatedPostCompactTokens?: number;
  estimatedSummaryInputTokens?: number;
  compressibleCount: number;
  remainingExpectedRequests?: number;
  cacheReadRatio?: number | null;
  outputToInputRatio?: number | null;
  hasMeasuredUsage?: boolean;
  hasKnownPricing?: boolean;
  nearHardWindowLimit?: boolean;
}): EconomicCompactionDecision {
  if (params.compressibleCount < 4) {
    return {
      shouldCheckEconomic: false,
      shouldCompact: false,
      reason: '可压缩轮次不足 4 条，跳过压缩',
      projectedBreakEvenRequests: 0,
      estimatedSavingsEquivTokens: 0,
      estimatedCompactionCostEquivTokens: 0,
    };
  }
  if (params.nearHardWindowLimit) {
    return {
      shouldCheckEconomic: true,
      shouldCompact: true,
      reason: '逼近上下文硬边界，执行强制压缩切换新段',
      projectedBreakEvenRequests: 1,
      estimatedSavingsEquivTokens: params.usedTokens,
      estimatedCompactionCostEquivTokens: 0,
    };
  }
  if (params.hasMeasuredUsage === false) {
    return {
      shouldCheckEconomic: false,
      shouldCompact: false,
      reason: '缺少当前部署真实 usage 遥测，禁止盲目切段破坏热前缀',
      projectedBreakEvenRequests: 0,
      estimatedSavingsEquivTokens: 0,
      estimatedCompactionCostEquivTokens: 0,
    };
  }
  if (params.hasKnownPricing === false || params.cacheReadRatio === null) {
    return {
      shouldCheckEconomic: false,
      shouldCompact: false,
      reason: '当前部署费率或缓存倍率未知（unknown），跳过经济切段压缩',
      projectedBreakEvenRequests: 0,
      estimatedSavingsEquivTokens: 0,
      estimatedCompactionCostEquivTokens: 0,
    };
  }
  if (params.usedTokens < ECONOMIC_COMPACTION_CHECK_TOKENS) {
    return {
      shouldCheckEconomic: false,
      shouldCompact: false,
      reason: `当前约 ${params.usedTokens} tokens，低于 24k 经济测算起点，维持原热前缀更省`,
      projectedBreakEvenRequests: 0,
      estimatedSavingsEquivTokens: 0,
      estimatedCompactionCostEquivTokens: 0,
    };
  }

  const r = Math.max(0.01, Math.min(1, params.cacheReadRatio ?? 0.1));
  const kOut = Math.max(0.5, Math.min(20, params.outputToInputRatio ?? 4));
  const postCompact = Math.min(params.usedTokens * 0.45, params.estimatedPostCompactTokens ?? 9000);
  const droppedTokens = Math.max(0, params.usedTokens - postCompact);
  const perRequestSavings = droppedTokens * r;
  const remainingReqs = Math.max(0, params.remainingExpectedRequests ?? 8);
  const totalSavingsEquiv = perRequestSavings * remainingReqs;
  const summaryInTokens = Math.max(0, params.estimatedSummaryInputTokens ?? Math.round(params.usedTokens * 0.7));
  const summaryOutTokens = 450;
  // 摘要独立请求输入（按冷读，或实际同段热读计价由上层传入）+ 输出 + 重建新基线首次冷写增价
  const compactionCostEquiv = summaryInTokens + summaryOutTokens * kOut + postCompact * (1 - r);
  const breakEven = perRequestSavings > 0 ? Math.ceil(compactionCostEquiv / perRequestSavings) : 999;

  const candidate = params.usedTokens >= ECONOMIC_COMPACTION_CANDIDATE_TOKENS;
  const profitable = remainingReqs > 0 && totalSavingsEquiv > compactionCostEquiv;

  return {
    shouldCheckEconomic: true,
    shouldCompact: candidate && profitable,
    reason: !candidate
      ? `介于 24k–32k 观察区（当前 ${params.usedTokens}），继续沿用热前缀`
      : profitable
        ? `预计剩余 ${remainingReqs} 次请求净省 ${Math.round(totalSavingsEquiv - compactionCostEquiv)} 等价 token，建议切段压缩`
        : `剩余请求过少（需 ${breakEven} 次才回本），暂不破坏热前缀`,
    projectedBreakEvenRequests: breakEven,
    estimatedSavingsEquivTokens: Math.round(totalSavingsEquiv),
    estimatedCompactionCostEquivTokens: Math.round(compactionCostEquiv),
  };
}

export function computeCoachContextStats(params: {
  model: string;
  advertisedMaxTokens?: number;
  messages: CoachStoredMessage[];
  contextSummary?: string;
  compressedCount?: number;
  memoryText?: string;
  systemSnapshotChars?: number;
  draftText?: string;
  hasPendingImage?: boolean;
  hasPendingVideo?: boolean;
  lastUsage?: CoachThreadUsage;
}): CoachContextStats {
  const maxTokens = resolveModelContextWindow(params.model, params.advertisedMaxTokens);

  // 基础人设 + 16 个业务工具 schema 约占 ~1.8k tokens，加上当前训练快照文本
  const systemAndToolsTokens =
    1850 + Math.ceil((params.systemSnapshotChars ?? 1600) / 3.2);
  const memoryTokens = estimateTokens(params.memoryText ?? '');

  const nonDemo = params.messages.filter((m) => !m.isDemo);
  const activeMsgs = nonDemo.filter((m) => !m.compressed);

  let conversationTokens = estimateTokens(params.contextSummary ?? '');
  let attachmentTokens = 0;
  for (const m of activeMsgs) {
    conversationTokens += 12 + estimateTokens(m.text);
    for (const att of m.attachments ?? []) {
      attachmentTokens += att.kind === 'video' ? 4096 : 1024;
    }
  }
  if (params.draftText?.trim()) {
    conversationTokens += estimateTokens(params.draftText);
  }
  if (params.hasPendingImage) attachmentTokens += 1024;
  if (params.hasPendingVideo) attachmentTokens += 4096;

  const estimatedTotal = systemAndToolsTokens + memoryTokens + conversationTokens + attachmentTokens;

  // 若最近一轮有服务端真实返回 promptTokens，且本轮发生在最新消息之后，优先用真实值 + 新消息增量
  let usedTokens = estimatedTotal;
  let isMeasured = false;
  if (params.lastUsage && params.lastUsage.promptTokens > 0 && !params.lastUsage.estimated) {
    const newerMsgs = nonDemo.filter((m) => m.createdAt > params.lastUsage!.updatedAt && !m.compressed);
    const delta =
      newerMsgs.reduce((acc, m) => acc + 12 + estimateTokens(m.text), 0) +
      estimateTokens(params.draftText ?? '') +
      (params.hasPendingImage ? 1024 : 0) +
      (params.hasPendingVideo ? 4096 : 0);
    usedTokens = params.lastUsage.promptTokens + delta;
    isMeasured = true;
  }

  const ratio = maxTokens > 0 ? Math.min(1, Math.max(0, usedTokens / maxTokens)) : 0;
  const percentExact = ratio * 100;
  const percent = Math.max(0, Math.min(100, Math.round(percentExact)));
  const percentLabel = formatContextPercent(usedTokens, maxTokens);
  const scale = isMeasured && estimatedTotal > 0 ? usedTokens / estimatedTotal : 1;
  const toSegmentPct = (tokens: number) =>
    maxTokens > 0 ? Math.max(0, Math.min(100, ((tokens * scale) / maxTokens) * 100)) : 0;
  const level: CoachContextStats['level'] =
    percent >= 85 ? 'high' : percent >= 70 ? 'warn' : 'ok';

  return {
    systemAndToolsTokens,
    memoryTokens,
    conversationTokens,
    attachmentTokens,
    usedTokens,
    maxTokens,
    percent,
    percentExact,
    percentLabel,
    systemPct: toSegmentPct(systemAndToolsTokens),
    memoryPct: toSegmentPct(memoryTokens),
    conversationPct: toSegmentPct(conversationTokens),
    attachmentPct: toSegmentPct(attachmentTokens),
    level,
    isMeasured,
    activeMessageCount: activeMsgs.length,
    totalThreadMessages: nonDemo.length,
    compressedCount: params.compressedCount ?? 0,
  };
}
