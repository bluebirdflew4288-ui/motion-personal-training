#!/usr/bin/env node
/* MOTION AI 教练 v0.2.2 (Baseline A) vs v0.2.3 (Upgraded B) 前缀缓存与计费对照脚本。
 *
 * 默认运行（离线）：
 *   mode = "offline-wire-prefix-verification"
 *   使用真实序列化请求体逐字节核对 64-token 对齐前缀复用（严格区分离线模拟器与服务端实际缓存/账单）。
 *   不给 DeepSeek 官方注入虚假的远程 title_gen 调用，并在 Upgraded B 中接入 patchCoachThreadUiFields /
 *   saveCoachThreadsUiLayout 并发 UI 回调验证单一稳定分段与工具轨迹保留。
 *
 * 实盘受控模式（--live）：
 *   仅在显式传 `--live` 且具备对应环境变量（DEEPSEEK_API_KEY / DASHSCOPE_API_KEY）时访问真实 HTTPS API。
 */

import { build } from 'esbuild';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
  console.log(`MOTION AI Coach Prefix Cache & Billing Benchmark

用法:
  node scripts/coach-cache-benchmark.mjs [选项]

选项:
  --live                      启用真实 HTTPS API 实盘运行（默认关闭，使用离线前缀核验）
  --provider <deepseek|bailian|all>
                              目标部署：deepseek / bailian / all（默认 all）
  --bucket <name>             实盘时间窗分桶：
                              first_turn | immediate_tool | inter_set_90s | inter_set_3m |
                              inter_set_6m_plus | cross_day_12_24h | all（默认 first_turn）
  --thinking <off|low|high>   思考深度（默认 high）
  --pricing-window <peak|off_peak|auto>
                              定价时段（离线默认 peak，实盘默认 auto 按北京时间判定）
  --checkpoint <file>         检查点 JSON 路径（每轮持久化会话与线程状态）
  --resume                    从 --checkpoint 指定的检查点恢复继续测试（用于跨组/跨天分桶）
  --help, -h                  显示帮助并退出

环境变量（仅 --live 需要）:
  DEEPSEEK_API_KEY            DeepSeek 官方 API Key (model=deepseek-flash)
  DASHSCOPE_API_KEY           阿里云百炼 cn-beijing Key (model=deepseek-v4.1-flash-1017)
`);
}

function parseCliArgs(argv) {
  const opts = {
    live: false,
    provider: 'all',
    bucket: 'first_turn',
    thinking: 'high',
    pricingWindow: '',
    checkpoint: '',
    resume: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--live') {
      opts.live = true;
    } else if (a === '--resume') {
      opts.resume = true;
    } else if (a === '--provider' && i + 1 < argv.length) {
      opts.provider = argv[++i];
    } else if (a.startsWith('--provider=')) {
      opts.provider = a.slice('--provider='.length);
    } else if (a === '--bucket' && i + 1 < argv.length) {
      opts.bucket = argv[++i];
    } else if (a.startsWith('--bucket=')) {
      opts.bucket = a.slice('--bucket='.length);
    } else if (a === '--thinking' && i + 1 < argv.length) {
      opts.thinking = argv[++i];
    } else if (a.startsWith('--thinking=')) {
      opts.thinking = a.slice('--thinking='.length);
    } else if (a === '--pricing-window' && i + 1 < argv.length) {
      opts.pricingWindow = argv[++i];
    } else if (a.startsWith('--pricing-window=')) {
      opts.pricingWindow = a.slice('--pricing-window='.length);
    } else if (a === '--checkpoint' && i + 1 < argv.length) {
      opts.checkpoint = argv[++i];
    } else if (a.startsWith('--checkpoint=')) {
      opts.checkpoint = a.slice('--checkpoint='.length);
    } else {
      throw new Error(`未知参数: ${a}（使用 --help 查看说明）`);
    }
  }
  const validProviders = new Set(['deepseek', 'bailian', 'all']);
  const validBuckets = new Set([
    'first_turn',
    'immediate_tool',
    'inter_set_90s',
    'inter_set_3m',
    'inter_set_6m_plus',
    'cross_day_12_24h',
    'all',
  ]);
  const validThinking = new Set(['off', 'low', 'high']);
  const pricingWindow = opts.pricingWindow || (opts.live ? 'auto' : 'peak');
  const validPricingWindows = new Set(['peak', 'off_peak', 'auto']);

  if (!validProviders.has(opts.provider)) throw new Error(`无效 --provider: ${opts.provider}`);
  if (!validBuckets.has(opts.bucket)) throw new Error(`无效 --bucket: ${opts.bucket}`);
  if (!validThinking.has(opts.thinking)) throw new Error(`无效 --thinking: ${opts.thinking}`);
  if (!validPricingWindows.has(pricingWindow)) {
    throw new Error(`无效 --pricing-window: ${pricingWindow}`);
  }
  opts.pricingWindow = pricingWindow;
  return opts;
}

const RUNNER_TS = `
import 'fake-indexeddb/auto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { __resetDbHandle, idbClear, idbDelete, idbGetAll, idbPut, idbPutMany } from './src/db/idb';
import { getSession, savePlan } from './src/db/repo';
import { atomicCreateSession } from './src/db/tx';
import { createV32Plan } from './src/domain/presets/v32';
import { createSession } from './src/domain/session';
import { STATIC_COACH_SYSTEM_PROMPT } from './src/coach/coachPrompt';
import {
  COACH_TOOL_DEFINITIONS,
  COACH_WEB_SEARCH_TOOL_DEFINITION,
  buildCoachReadOnlyContext,
  executeCoachToolCall,
} from './src/coach/coachTools';
import { buildCoachSystemPrompt, runCoachTurn } from './src/coach/coachAgent';
import { undoCoachReceipt } from './src/coach/coachTx';
import {
  normalizeUsageToBillingRecord,
  summarizeBillingRecords,
  type BillingSummaryReport,
} from './src/coach/coachBilling';
import {
  resolveProviderCapabilities,
  type ProviderDeploymentCapabilities,
} from './src/coach/providerCapabilities';
import { estimateTokens } from './src/coach/coachContext';
import {
  appendProtocolEntriesStrict,
  listBillingRecords,
  listCoachReceipts,
  listPendingTurns,
  listProtocolEntries,
  loadCoachThreadsState,
  patchCoachThreadUiFields,
  replaceProtocolEntriesForThread,
  resetCoachVaultForTest,
  saveBillingRecordStrict,
  saveCoachReceipt,
  saveCoachThreadsState,
  saveCoachThreadsUiLayout,
  savePendingTurnStrict,
  type CoachBillingRecord,
  type CoachOperationReceipt,
  type CoachPendingTurn,
  type CoachProtocolEntry,
  type CoachStoredMessage,
  type CoachStoredProviderConfig,
  type CoachThreadsState,
} from './src/coach/coachStorage';
import { __resetFocusGuardForTest } from './src/coach/focusGuard';
import { registerSessionRuntime } from './src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from './src/lib/lock';
import type { CoachThinkingDepth } from './src/coach/providerAdapter';
import { iterateSseEvents } from './src/coach/providerAdapter';

interface BenchOptions {
  live: boolean;
  provider: 'deepseek' | 'bailian' | 'all';
  bucket: string;
  thinking: CoachThinkingDepth;
  pricingWindow: 'peak' | 'off_peak' | 'auto';
  checkpoint: string;
  resume: boolean;
}

const OPTS: BenchOptions = JSON.parse(process.env.BENCH_OPTS_JSON ?? '{}');
const NOW = 1_766_800_000_000;

function countExactPrefixTokens64(prevText: string, curText: string): { total: number; hit: number; miss: number } {
  const minLen = Math.min(prevText.length, curText.length);
  let commonChars = 0;
  while (commonChars < minLen && prevText.charCodeAt(commonChars) === curText.charCodeAt(commonChars)) {
    commonChars += 1;
  }
  const commonTokens = estimateTokens(curText.slice(0, commonChars));
  const hit = Math.floor(commonTokens / 64) * 64;
  const total = Math.max(128, estimateTokens(curText));
  const clampedHit = Math.min(hit, total);
  return { total, hit: clampedHit, miss: Math.max(0, total - clampedHit) };
}

const UPGRADED_EDITOR_ID = 'bench-live-editor';
const BASELINE_EDITOR_ID = 'bench-baseline-editor';

async function setupWorkout(sessionId: string, editorId = 'bench-editor') {
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');

  const basePlan = createV32Plan(NOW);
  const wideDay = {
    ...basePlan.days[0],
    exercises: basePlan.days[0].exercises.map((e, i) =>
      i === 0 ? { ...e, target: { ...e.target, sets: 10, setsMax: 10 } } : e,
    ),
  };
  const plan = { ...basePlan, id: 'plan-bench', name: '胸肌分化日', days: [wideDay], cursor: 0 };
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session = { ...raw, id: sessionId };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  const lockRes = await acquireSessionLock(fresh.id, editorId);
  if (!lockRes.ok) {
    throw new Error('初始化基准训练编辑锁失败（heldBy=' + lockRes.heldBy + '）');
  }
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId,
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return fresh;
}

function makeSse(chunks: string[]): Response {
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

function pricingArgs(cfg: CoachStoredProviderConfig) {
  return {
    ...cfg,
    ...(OPTS.pricingWindow !== 'auto' ? { pricingWindowOverride: OPTS.pricingWindow } : {}),
  };
}

function buildStableWire(body: { tools?: unknown[]; messages?: unknown[] }): string {
  return JSON.stringify({ tools: body.tools ?? [], messages: body.messages ?? [] });
}

function toOpenAiWireTools(
  defs: ReadonlyArray<{ name: string; description: string; parameters: unknown }>,
) {
  return defs.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function countDoneSetsInSession(sess: { exercises: Array<{ sets: Array<{ status: string }> }> } | null | undefined): number {
  if (!sess) return 0;
  let total = 0;
  for (const ex of sess.exercises) {
    for (const s of ex.sets) {
      if (s.status === 'done') total += 1;
    }
  }
  return total;
}

/** 返回稳定“目标组”键集合（exerciseId:setId），用于按剧本实际请求的目标组核对 DB 最终完成状态。 */
function doneTargetKeySet(
  sess: { exercises: Array<{ id: string; sets: Array<{ id: string; status: string }> }> } | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!sess) return out;
  for (const ex of sess.exercises) {
    for (const s of ex.sets) {
      if (s.status === 'done') out.add(ex.id + ':' + s.id);
    }
  }
  return out;
}

/** 本次相对上次新完成的目标组键（用于“单桶用该次完成目标数”）。 */
function newDoneTargetKeys(
  before: Set<string>,
  sess: { exercises: Array<{ id: string; sets: Array<{ id: string; status: string }> }> } | null | undefined,
): string[] {
  const after = doneTargetKeySet(sess);
  return [...after].filter((k) => !before.has(k));
}

/**
 * 派发前按“播种动作 + 本次 setNo(roundIndex)”固定本轮唯一目标组的稳定键。
 * 计数时只认这个目标是否在臂主库最终 done；模型若记了未请求的其他组，不计入。
 */
function resolveIntendedTargetKey(
  sess: { exercises: Array<{ id: string; name?: string; sets: Array<{ id: string; roundIndex?: number; stageIndex?: number }> }> } | null | undefined,
  roundIndex: number,
): string | null {
  if (!sess) return null;
  const ex =
    sess.exercises.find((e) => typeof e.name === 'string' && e.name.indexOf('双杠臂屈伸') >= 0) ||
    sess.exercises[0];
  if (!ex) return null;
  const set =
    ex.sets.find((s) => s.roundIndex === roundIndex && (s.stageIndex === undefined || s.stageIndex === 1)) ||
    ex.sets.find((s) => s.roundIndex === roundIndex);
  if (!set) return null;
  return ex.id + ':' + set.id;
}

/**
 * 只在解析出“实际生成的 token”时才判定首 token：
 * · OpenAI: choices[].delta 的非空 content / reasoning_content / tool_calls.function.arguments；
 * · Anthropic: content_block_delta 的 text_delta/thinking_delta 非空文本、input_json_delta 非空 partial_json；
 * · Gemini: candidates[].content.parts[].text 非空。
 * role-only / usage-only / 空 delta 帧一律跳过。
 */
function sseEventHasGeneratedToken(ev: { data?: string; event?: string } | null | undefined): boolean {
  if (!ev || typeof ev.data !== 'string' || ev.data === '[DONE]') return false;
  var obj: any;
  try { obj = JSON.parse(ev.data); } catch { return false; }
  if (!obj || typeof obj !== 'object') return false;
  if (obj.type === 'content_block_delta' && obj.delta) {
    var d = obj.delta;
    if (d.type === 'text_delta' && typeof d.text === 'string' && d.text.length) return true;
    if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking.length) return true;
    if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json.length) return true;
    return false;
  }
  if (Array.isArray(obj.choices)) {
    for (var i = 0; i < obj.choices.length; i += 1) {
      var ch = obj.choices[i];
      var delta = ch && ch.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content.length) return true;
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) return true;
      if (Array.isArray(delta.tool_calls)) {
        for (var j = 0; j < delta.tool_calls.length; j += 1) {
          var f = delta.tool_calls[j] && delta.tool_calls[j].function;
          if (f && typeof f.arguments === 'string' && f.arguments.length) return true;
        }
      }
    }
    return false;
  }
  if (Array.isArray(obj.candidates)) {
    for (var k = 0; k < obj.candidates.length; k += 1) {
      var parts = obj.candidates[k] && obj.candidates[k].content && obj.candidates[k].content.parts;
      if (Array.isArray(parts)) {
        for (var m = 0; m < parts.length; m += 1) {
          if (parts[m] && typeof parts[m].text === 'string' && parts[m].text.length) return true;
        }
      }
    }
  }
  return false;
}

function formatMetrics(summary: BillingSummaryReport, loggedSetsInDb: number) {
  return {
    requests: summary.requests,
    measuredRequests: summary.measuredRequests,
    unknownUsageRequests: summary.unknownUsageRequests,
    usageCoverageRatio: Number(summary.usageCoverageRatio.toFixed(4)),
    cacheDetailMeasuredRequests: summary.cacheDetailMeasuredRequests,
    unknownCacheDetailRequests: summary.unknownCacheDetailRequests,
    cacheDetailCoverageRatio: Number(summary.cacheDetailCoverageRatio.toFixed(4)),
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    uncachedInputTokens: summary.uncachedInputTokens,
    unknownCacheInputTokens: summary.unknownCacheInputTokens,
    outputTokens: summary.outputTokens,
    reasoningOutputTokens: summary.reasoningOutputTokens,
    weightedCacheHitRate: summary.cacheHitRate !== null ? Number(summary.cacheHitRate.toFixed(4)) : null,
    dedupedLoggedSets: summary.dedupedLoggedSets,
    loggedSetsInDb,
    missPerLoggedSet: summary.missPerLoggedSet !== null ? Number(summary.missPerLoggedSet.toFixed(1)) : null,
    estimatedCostFromSchedule: summary.totalCost !== null ? Number(summary.totalCost.toFixed(6)) : null,
    estimatedCostBoundsFromSchedule: summary.costBounds
      ? {
          min: Number(summary.costBounds.min.toFixed(6)),
          max: Number(summary.costBounds.max.toFixed(6)),
        }
      : null,
    estimatedCostPerLoggedSet:
      summary.totalCost !== null && loggedSetsInDb > 0
        ? Number((summary.totalCost / loggedSetsInDb).toFixed(6))
        : null,
    currency: summary.currency,
    subtotalsByCurrency: summary.subtotalsByCurrency,
    actualBillingVoucher: {
      status: 'unreconciled_manual_check_required',
      invoiceId: null,
      actualChargedAmount: null,
      note: '脚本按当前官方时段定价表估算；真实扣费请以平台控制台账单为准。',
    },
  };
}

/**
 * Baseline A（v0.2.2 线缆形态）：
 * - 动态 system 含实时训练快照，每次记组均会重写前置 system 块；
 * - 第 6 轮联网切换 tools 列表（追加 web_search 工具定义）；
 * - 普通写工具将包含 before/after 的完整 receipt 快照写回 tool result；
 * - 跨轮丢弃 reasoning_content 与 tool_calls/tool 轨迹，仅保留 user/assistant 文本历史；
 * - 严禁给 DeepSeek 官方伪造不存在的 title_gen 远程调用。
 */
async function runBaselineV022Simulator(providerCfg: CoachStoredProviderConfig) {
  const session = await setupWorkout('sess-bench-v022-' + providerCfg.presetId);
  const exId = session.exercises[0].id;
  const caps = resolveProviderCapabilities(pricingArgs(providerCfg));
  const records: CoachBillingRecord[] = [];
  let seq = 0;
  let lastWire = '';

  const evalPrefix = (wire: string) => {
    const res = lastWire ? countExactPrefixTokens64(lastWire, wire) : { total: Math.max(128, estimateTokens(wire)), hit: 0, miss: Math.max(128, estimateTokens(wire)) };
    lastWire = wire;
    return res;
  };

  const makeUsage = (s: { total: number; hit: number; miss: number }, outToks: number) =>
    providerCfg.presetId === 'bailian-deepseek'
      ? {
          prompt_tokens: s.total,
          completion_tokens: outToks,
          prompt_tokens_details: { cached_tokens: s.hit },
        }
      : {
          prompt_tokens: s.total,
          completion_tokens: outToks,
          prompt_cache_hit_tokens: s.hit,
          prompt_cache_miss_tokens: s.miss,
        };

  const uiHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (let setIdx = 1; setIdx <= 10; setIdx += 1) {
    const curSess = (await getSession(session.id))!;
    const roCtx = await buildCoachReadOnlyContext({ activeSession: curSess }, { includeAllHistory: false, historyLimit: 3 });
    const volatileSystem = STATIC_COACH_SYSTEM_PROMPT + '\\n' + JSON.stringify(roCtx);
    const toolsList = toOpenAiWireTools(
      setIdx === 6 ? [...COACH_TOOL_DEFINITIONS, COACH_WEB_SEARCH_TOOL_DEFINITION] : COACH_TOOL_DEFINITIONS,
    );
    const prompt =
      setIdx === 6
        ? '帮我搜一下双杠臂屈伸动作要点，并记第 6 组 60kg 10次'
        : '帮我记第 ' + setIdx + ' 组 60kg 10次';

    // Round 0: 模型发出 record_active_set
    const r0Body = buildStableWire({
      tools: toolsList,
      messages: [
        { role: 'system', content: volatileSystem },
        ...uiHistory,
        { role: 'user', content: prompt },
      ],
    });
    const s0 = evalPrefix(r0Body);
    const opId = 'v022-set-' + setIdx;
    const execOut = await executeCoachToolCall(
      {
        id: opId,
        name: 'record_active_set',
        argumentsText: JSON.stringify({ sessionId: session.id, exId, roundIndex: setIdx, reps: 10, weightKg: 60, status: 'done' }),
        arguments: { sessionId: session.id, exId, roundIndex: setIdx, reps: 10, weightKg: 60, status: 'done' },
      },
      { activeSession: curSess },
    );
    records.push(
      normalizeUsageToBillingRecord({
        id: 'a-' + (++seq),
        threadId: 'bench-v022',
        segmentId: 'seg-a',
        round: 0,
        purpose: 'coach_turn',
        capabilities: caps,
        rawUsage: makeUsage(s0, 46),
        operationIdsCompleted: [opId],
      }),
    );

    // Round 1: 同轮续调，v0.2.2 把膨胀的完整 touchedTargets + snapshot 塞回 tool result
    const bloatedToolJson = JSON.stringify({ ok: true, summary: execOut.summary, receipt: execOut.receipt });
    const r1Body = buildStableWire({
      tools: toolsList,
      messages: [
        { role: 'system', content: volatileSystem },
        ...uiHistory,
        { role: 'user', content: prompt },
        { role: 'assistant', reasoning_content: '思考第 ' + setIdx + ' 组', tool_calls: [{ id: opId }] },
        { role: 'tool', tool_call_id: opId, content: bloatedToolJson },
      ],
    });
    const s1 = evalPrefix(r1Body);
    const confirmText = '第 ' + setIdx + ' 组已记录，注意组间呼吸恢复。';
    records.push(
      normalizeUsageToBillingRecord({
        id: 'a-' + (++seq),
        threadId: 'bench-v022',
        segmentId: 'seg-a',
        round: 1,
        purpose: 'coach_turn',
        capabilities: caps,
        rawUsage: makeUsage(s1, 28),
      }),
    );

    uiHistory.push({ role: 'user', content: prompt });
    uiHistory.push({ role: 'assistant', content: confirmText });

    // 第 4 组后一次 UI 手改，第 7 组后一次 Undo + 重记
    if (setIdx === 4) {
      const sNow = (await getSession(session.id))!;
      await idbPut('sessions', {
        ...sNow,
        revision: (sNow.revision ?? 0) + 1,
        exercises: sNow.exercises.map((e, idx) =>
          idx === 0 ? { ...e, sets: e.sets.map((st, si) => (si === 3 ? { ...st, reps: 11 } : st)) } : e,
        ),
      });
    }
    if (setIdx === 7 && execOut.receipt) {
      await undoCoachReceipt(execOut.receipt.id);
      const redoCur = (await getSession(session.id))!;
      await executeCoachToolCall(
        {
          id: opId + '-redo',
          name: 'record_active_set',
          argumentsText: '{}',
          arguments: { sessionId: session.id, exId, roundIndex: 7, reps: 10, weightKg: 60, status: 'done' },
        },
        { activeSession: redoCur },
      );
    }
  }

  // 额外 5 轮常规问询（累计 25 次模型物理请求，不含任何虚假 title_gen 调用）
  for (let q = 1; q <= 5; q += 1) {
    const curSess = (await getSession(session.id))!;
    const roCtx = await buildCoachReadOnlyContext({ activeSession: curSess }, { includeAllHistory: false, historyLimit: 3 });
    const qPrompt = '休息建议问题 #' + q;
    const qBody = buildStableWire({
      tools: toOpenAiWireTools(COACH_TOOL_DEFINITIONS),
      messages: [
        { role: 'system', content: STATIC_COACH_SYSTEM_PROMPT + '\\n' + JSON.stringify(roCtx) },
        ...uiHistory,
        { role: 'user', content: qPrompt },
      ],
    });
    const sq = evalPrefix(qBody);
    records.push(
      normalizeUsageToBillingRecord({
        id: 'a-' + (++seq),
        threadId: 'bench-v022',
        segmentId: 'seg-a',
        round: 0,
        purpose: 'coach_turn',
        capabilities: caps,
        rawUsage: makeUsage(sq, 32),
      }),
    );
    uiHistory.push({ role: 'user', content: qPrompt });
    uiHistory.push({ role: 'assistant', content: '保持动作控制与核心稳定。' });
  }

  const finalSess = (await getSession(session.id))!;
  const loggedSetsInDb = finalSess.exercises[0].sets.filter((s) => s.status === 'done').length;
  return {
    metrics: formatMetrics(summarizeBillingRecords(records), loggedSetsInDb),
  };
}

/**
 * Upgraded B（真实驱动 v0.2.3 runCoachTurn + UI 并发回调）：
 * - 通过 patchCoachThreadUiFields 与 saveCoachThreadsUiLayout 模拟真实 CoachPane UI 并发写；
 * - 校验线缆请求字节：Turn 2+ 保留配对 assistant(tool_calls + reasoning_content) 与 tool，无 before/after 膨胀快照，且全场维持 1 个稳定分段。
 */
async function runUpgradedV023Benchmark(providerCfg: CoachStoredProviderConfig) {
  const effectiveCfg: CoachStoredProviderConfig = {
    ...providerCfg,
    ...(OPTS.pricingWindow !== 'auto' ? { pricingWindowOverride: OPTS.pricingWindow } as Partial<CoachStoredProviderConfig> : {}),
  };
  const session = await setupWorkout('sess-bench-v023-' + providerCfg.presetId);
  const exId = session.exercises[0].id;
  const threads = await loadCoachThreadsState();
  const tid = threads.activeThreadId;
  const seenSerializedReqs: string[] = [];
  const capturedBodies: Array<{ tools?: unknown[]; messages: Array<Record<string, unknown>> }> = [];
  const compactionEvents: Array<{ compressedCount: number; reason: string }> = [];

  const simulateUsage = (serializedWire: string, completionToks: number) => {
    let bestHit = 0;
    const total = Math.max(128, estimateTokens(serializedWire));
    for (const prev of seenSerializedReqs.slice(-6)) {
      const m = countExactPrefixTokens64(prev, serializedWire);
      if (m.hit > bestHit) bestHit = m.hit;
    }
    seenSerializedReqs.push(serializedWire);
    const hit = Math.min(bestHit, total);
    const miss = Math.max(0, total - hit);
    return providerCfg.presetId === 'bailian-deepseek'
      ? {
          prompt_tokens: total,
          completion_tokens: completionToks,
          prompt_tokens_details: { cached_tokens: hit },
        }
      : {
          prompt_tokens: total,
          completion_tokens: completionToks,
          prompt_cache_hit_tokens: hit,
          prompt_cache_miss_tokens: miss,
        };
  };

  let setToLog = 1;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const sUrl = String(url);
    if (sUrl.includes('duckduckgo')) {
      return new Response(
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffit.example%2Fdips">双杠臂屈伸要点</a><a class="result__snippet">躯干略前倾，肩胛下沉稳定。</a>',
        { status: 200 },
      );
    }
    if (sUrl.includes('so.com') || sUrl.includes('bing.com')) {
      return new Response('', { status: 404 });
    }
    const rawStr = String(init?.body ?? '{}');
    const body = JSON.parse(rawStr) as {
      tools?: unknown[];
      messages: Array<Record<string, unknown>>;
    };
    capturedBodies.push(body);
    const stableWire = buildStableWire(body);
    const lastMsg = body.messages[body.messages.length - 1] ?? {};
    const lastRole = String(lastMsg.role ?? '');
    const lastText = String(lastMsg.content ?? '');

    if (lastRole === 'user' && lastText.includes('记第') && setToLog <= 10) {
      const curSet = setToLog;
      setToLog += 1;
      const usage = simulateUsage(stableWire, 46);
      return makeSse([
        'data: ' + JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '确认目标为双杠臂屈伸第 ' + curSet + ' 组 60kg 10 次。',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-v023-' + curSet,
                    function: {
                      name: 'record_active_set',
                      arguments: JSON.stringify({ sessionId: session.id, exId, roundIndex: curSet, reps: 10, weightKg: 60, status: 'done' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage,
        }) + '\\n\\n',
        'data: [DONE]\\n\\n',
      ]);
    }

    const usage = simulateUsage(stableWire, lastRole === 'tool' ? 28 : 32);
    return makeSse([
      'data: ' + JSON.stringify({
        choices: [
          {
            delta: {
              reasoning_content: '回复简明训练建议。',
              content: lastRole === 'tool' ? '第 ' + (setToLog - 1) + ' 组已记录，注意组间呼吸恢复。' : '保持动作控制与核心稳定。',
            },
            finish_reason: 'stop',
          },
        ],
        usage,
      }) + '\\n\\n',
      'data: [DONE]\\n\\n',
    ]);
  };

  try {
    const uiHistory: CoachStoredMessage[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const prompt =
        i === 6
          ? '帮我搜一下双杠臂屈伸动作要点，并记第 6 组 60kg 10次'
          : '帮我记第 ' + i + ' 组 60kg 10次';
      const pendingUiUpdates: Array<Promise<unknown>> = [];
      const turn = await runCoachTurn({
        threadId: tid,
        userText: prompt,
        history: uiHistory,
        webSearch: i === 6,
        thinkingDepth: OPTS.thinking,
        providerConfig: effectiveCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
        onUsage: (u) => {
          pendingUiUpdates.push(
            patchCoachThreadUiFields(tid, {
              updatedAt: NOW + i,
              lastUsage: {
                promptTokens: u.promptTokens ?? 0,
                cachedTokens: u.cachedTokens,
                completionTokens: u.completionTokens,
                totalTokens: u.totalTokens,
                updatedAt: NOW + i,
              },
            }),
          );
        },
        onSegmentChanged: () => {
          pendingUiUpdates.push(patchCoachThreadUiFields(tid, { updatedAt: NOW + i }));
        },
        onCompactionApplied: (info) => {
          compactionEvents.push({ compressedCount: info.compressedCount, reason: info.reason });
        },
      });
      await Promise.all(pendingUiUpdates);
      if (i === 1) {
        const curState = await loadCoachThreadsState();
        await saveCoachThreadsUiLayout({
          activeThreadId: curState.activeThreadId,
          threads: curState.threads.map((t) => (t.id === tid ? { ...t, title: '胸肌分化训练' } : t)),
        });
      }
      uiHistory.push({ id: 'u-' + i, threadId: tid, role: 'user', createdAt: NOW + i, text: prompt });
      uiHistory.push({ id: 'a-' + i, threadId: tid, role: 'assistant', createdAt: NOW + i + 1, text: turn.text, reasoning: turn.reasoning });

      if (i === 4) {
        const sNow = (await getSession(session.id))!;
        await idbPut('sessions', {
          ...sNow,
          revision: (sNow.revision ?? 0) + 1,
          exercises: sNow.exercises.map((e, idx) =>
            idx === 0 ? { ...e, sets: e.sets.map((st, si) => (si === 3 ? { ...st, reps: 11 } : st)) } : e,
          ),
        });
      }
      if (i === 7 && turn.receipts[0]) {
        await undoCoachReceipt(turn.receipts[0].id);
        const curSess = (await getSession(session.id))!;
        await executeCoachToolCall(
          {
            id: 'redo-set-7-' + providerCfg.presetId,
            name: 'record_active_set',
            argumentsText: '{}',
            arguments: { sessionId: session.id, exId, roundIndex: 7, reps: 10, weightKg: 60, status: 'done' },
          },
          { activeSession: curSess },
        );
      }
    }

    for (let q = 1; q <= 5; q += 1) {
      const qPrompt = '休息建议问题 #' + q;
      const pendingUiUpdates: Array<Promise<unknown>> = [];
      const qTurn = await runCoachTurn({
        threadId: tid,
        userText: qPrompt,
        history: uiHistory,
        webSearch: false,
        thinkingDepth: OPTS.thinking,
        providerConfig: effectiveCfg,
        toolContext: { activeSession: await getSession(session.id) },
        streamChunkDelayMs: 0,
        onUsage: (u) => {
          pendingUiUpdates.push(
            patchCoachThreadUiFields(tid, {
              updatedAt: NOW + 100 + q,
              lastUsage: {
                promptTokens: u.promptTokens ?? 0,
                cachedTokens: u.cachedTokens,
                completionTokens: u.completionTokens,
                totalTokens: u.totalTokens,
                updatedAt: NOW + 100 + q,
              },
            }),
          );
        },
      });
      await Promise.all(pendingUiUpdates);
      uiHistory.push({ id: 'uq-' + q, threadId: tid, role: 'user', createdAt: NOW + 100 + q, text: qPrompt });
      uiHistory.push({ id: 'aq-' + q, threadId: tid, role: 'assistant', createdAt: NOW + 101 + q, text: qTurn.text, reasoning: qTurn.reasoning });
    }
  } finally {
    globalThis.fetch = origFetch;
  }

  const finalThreads = await loadCoachThreadsState();
  const threadMeta = finalThreads.threads.find((t) => t.id === tid);
  const segmentCount = Object.keys(threadMeta?.segments ?? {}).length;
  const secondTurnReq = capturedBodies[2]; // Turn 2 Round 0
  const hasPairedToolCallsInTurn2 = Boolean(
    secondTurnReq?.messages.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && typeof m.reasoning_content === 'string') &&
      secondTurnReq?.messages.some((m) => m.role === 'tool' && typeof m.tool_call_id === 'string'),
  );
  const hasSnapshotLeak = capturedBodies.some((b) =>
    b.messages.some((m) => m.role === 'tool' && (String(m.content ?? '').includes('"before"') || String(m.content ?? '').includes('"after"'))),
  );
  let byteExactContinuations = 0;
  for (let idx = 1; idx < capturedBodies.length; idx += 1) {
    const prevS = buildStableWire(capturedBodies[idx - 1]);
    const curS = buildStableWire(capturedBodies[idx]);
    // 去掉上一轮 JSON 结尾 \`}]}\` 后大部分前缀应逐字节匹配
    const compareLen = Math.max(0, prevS.length - 4);
    if (compareLen > 128 && curS.startsWith(prevS.slice(0, compareLen))) {
      byteExactContinuations += 1;
    }
  }

  const allBills = await listBillingRecords(tid);
  const modelBills = allBills.filter((b) => b.purpose !== 'web_search');
  const finalSess = (await getSession(session.id))!;
  const loggedSetsInDb = finalSess.exercises[0].sets.filter((s) => s.status === 'done').length;
  return {
    wireInvariants: {
      segmentCount,
      singleStableSegment: segmentCount === 1,
      hasPairedToolCallsInTurn2,
      hasSnapshotLeak,
      byteExactContinuations,
      totalModelRequests: capturedBodies.length,
      compactionEventsCount: compactionEvents.length,
    },
    modelRequestsOnly: formatMetrics(summarizeBillingRecords(modelBills), loggedSetsInDb),
    fullLedger: formatMetrics(summarizeBillingRecords(allBills), loggedSetsInDb),
  };
}

interface BenchToolErrorRecord {
  arm: 'A' | 'B';
  setNo: number;
  round: number;
  toolName: string;
  errorCode: string;
  summary: string;
}

interface BenchControlSnapshot {
  maxTokens: number | null;
  thinking: unknown;
  reasoningEffort: unknown;
  enableThinking: unknown;
}

interface BenchRequestTrace {
  arm: 'A' | 'B';
  setNo: number;
  round: number;
  purpose: string;
  startedAtMs: number;
  /** 响应头到达时刻（不代表完成） */
  responseHeaderAtMs?: number;
  /** 首个 token/响应体片段到达时刻 */
  firstTokenAtMs?: number;
  completedAtMs: number;
  durationMs: number;
  /** 完成判定依据：协议终帧 / 无终帧 EOF / 中断 / 错误 */
  terminalKind?: 'protocol_terminal' | 'eof_without_terminal' | 'aborted' | 'error';
  aborted?: boolean;
  msSincePrevSameArmRequest: number | null;
  controls: BenchControlSnapshot;
}

interface LiveCheckpoint {
  version: 2;
  providerKey: 'deepseek' | 'bailian';
  deploymentId: string;
  model: string;
  thinking: CoachThinkingDepth;
  hasWarmPrefix: boolean;
  sessionId: string;
  baselineSessionId: string;
  baselineSession: Awaited<ReturnType<typeof getSession>> | null;
  threadId: string;
  nextSetIndex: number;
  lastTurnAtMs: number;
  lastArmATurnAtMs?: number;
  lastArmBTurnAtMs?: number;
  lastArmARequestAtMs?: number;
  lastArmBRequestAtMs?: number;
  plans: unknown[];
  sessions: unknown[];
  settings: unknown[];
  meta: unknown[];
  threadsState: CoachThreadsState;
  protocolEntries: CoachProtocolEntry[];
  billingRecords: CoachBillingRecord[];
  receipts: CoachOperationReceipt[];
  pendingTurns: CoachPendingTurn[];
  uiHistory: CoachStoredMessage[];
  baselineRecords?: CoachBillingRecord[];
  baselineUiHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  armAToolErrors?: BenchToolErrorRecord[];
  armBToolErrors?: BenchToolErrorRecord[];
  armARequestTraces?: BenchRequestTrace[];
  armBRequestTraces?: BenchRequestTrace[];
  /** 累计“本次实际请求的目标稳定组”完成集合（跨 checkpoint 保留） */
  armACompletedTargetKeys?: string[];
  armBCompletedTargetKeys?: string[];
  /** 跨 checkpoint 保留的不可比证据，避免 resume 后漏报 */
  bucketWindowMismatchObserved?: boolean;
  targetCompletionMismatchObserved?: boolean;
}

const BUCKET_WINDOWS_MS: Record<string, { minMs: number; maxMs: number }> = {
  first_turn: { minMs: 0, maxMs: Number.POSITIVE_INFINITY },
  immediate_tool: { minMs: 0, maxMs: 30_000 },
  inter_set_90s: { minMs: 75_000, maxMs: 135_000 },
  inter_set_3m: { minMs: 165_000, maxMs: 240_000 },
  inter_set_6m_plus: { minMs: 360_000, maxMs: 12 * 3_600_000 - 1 },
  cross_day_12_24h: { minMs: 12 * 3_600_000, maxMs: 24 * 3_600_000 },
};

function classifyElapsedBucket(elapsedMs: number): string {
  if (elapsedMs < 30_000) return 'immediate_tool';
  if (elapsedMs < 135_000) return 'inter_set_90s';
  if (elapsedMs < 240_000) return 'inter_set_3m';
  if (elapsedMs < 12 * 3_600_000) return 'inter_set_6m_plus';
  if (elapsedMs <= 24 * 3_600_000) return 'cross_day_12_24h';
  return 'over_24h_expired';
}

function resolveCheckpointPath(
  rawPath: string,
  providerKey: 'deepseek' | 'bailian',
  multiProvider: boolean,
): string {
  if (!rawPath) return '';
  if (rawPath.includes('{provider}')) {
    return rawPath.replace(/\\{provider\\}/g, providerKey);
  }
  if (!multiProvider) return rawPath;
  if (/\\.json$/i.test(rawPath)) {
    return rawPath.replace(/\\.json$/i, '.' + providerKey + '.json');
  }
  return rawPath + '.' + providerKey + '.json';
}

async function saveCheckpointFile(
  path: string,
  providerKey: 'deepseek' | 'bailian',
  providerCfg: CoachStoredProviderConfig,
  hasWarmPrefix: boolean,
  sessionId: string,
  baselineSessionId: string,
  baselineSession: Awaited<ReturnType<typeof getSession>> | null,
  threadId: string,
  nextSetIndex: number,
  lastTurnAtMs: number,
  uiHistory: CoachStoredMessage[],
  baselineRecords: CoachBillingRecord[],
  baselineUiHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  extra?: {
    lastArmATurnAtMs?: number;
    lastArmBTurnAtMs?: number;
    lastArmARequestAtMs?: number;
    lastArmBRequestAtMs?: number;
    armAToolErrors?: BenchToolErrorRecord[];
    armBToolErrors?: BenchToolErrorRecord[];
    armARequestTraces?: BenchRequestTrace[];
    armBRequestTraces?: BenchRequestTrace[];
    armACompletedTargetKeys?: string[];
    armBCompletedTargetKeys?: string[];
    bucketWindowMismatchObserved?: boolean;
    targetCompletionMismatchObserved?: boolean;
  },
) {
  const caps = resolveProviderCapabilities(pricingArgs(providerCfg));
  const [plans, sessions, settings, meta, threadsState, protocolEntries, billingRecords, receipts, pendingTurns] =
    await Promise.all([
      idbGetAll('plans'),
      idbGetAll('sessions'),
      idbGetAll('settings'),
      idbGetAll('meta'),
      loadCoachThreadsState(),
      listProtocolEntries(threadId),
      listBillingRecords(threadId),
      listCoachReceipts(),
      listPendingTurns(threadId),
    ]);
  const ckpt: LiveCheckpoint = {
    version: 2,
    providerKey,
    deploymentId: caps.deploymentId,
    model: providerCfg.model,
    thinking: OPTS.thinking,
    hasWarmPrefix,
    sessionId,
    baselineSessionId,
    baselineSession,
    threadId,
    nextSetIndex,
    lastTurnAtMs,
    ...(extra ?? {}),
    plans,
    sessions,
    settings,
    meta,
    threadsState,
    protocolEntries,
    billingRecords,
    receipts,
    pendingTurns,
    uiHistory,
    baselineRecords,
    baselineUiHistory,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ckpt, null, 2), 'utf8');
}

async function restoreCheckpointFile(
  path: string,
  expectedProviderKey: 'deepseek' | 'bailian',
  expectedCfg: CoachStoredProviderConfig,
): Promise<LiveCheckpoint> {
  if (!existsSync(path)) {
    throw new Error('找不到检查点文件: ' + path);
  }
  const ckpt = JSON.parse(readFileSync(path, 'utf8')) as LiveCheckpoint;
  const expectedCaps = resolveProviderCapabilities(pricingArgs(expectedCfg));
  if (ckpt.providerKey !== expectedProviderKey) {
    throw new Error('检查点 provider mismatch: 期望 ' + expectedProviderKey + '，实际 ' + String(ckpt.providerKey));
  }
  if (ckpt.deploymentId && ckpt.deploymentId !== expectedCaps.deploymentId) {
    throw new Error('检查点 deploymentId mismatch: 期望 ' + expectedCaps.deploymentId + '，实际 ' + ckpt.deploymentId);
  }
  if (ckpt.model && ckpt.model !== expectedCfg.model) {
    throw new Error('检查点 model mismatch: 期望 ' + expectedCfg.model + '，实际 ' + ckpt.model);
  }
  if (ckpt.thinking && ckpt.thinking !== OPTS.thinking) {
    throw new Error('检查点 thinking mismatch: 期望 ' + OPTS.thinking + '，实际 ' + ckpt.thinking);
  }
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');
  if (ckpt.plans.length) await idbPutMany('plans', ckpt.plans);
  if (ckpt.sessions.length) await idbPutMany('sessions', ckpt.sessions);
  if (ckpt.settings.length) await idbPutMany('settings', ckpt.settings);
  if (ckpt.meta.length) await idbPutMany('meta', ckpt.meta);
  await idbDelete('meta', 'lock:' + ckpt.sessionId);
  await saveCoachThreadsState(ckpt.threadsState);
  await replaceProtocolEntriesForThread(ckpt.threadId, ckpt.protocolEntries);
  for (const r of ckpt.billingRecords) await saveBillingRecordStrict(r);
  for (const rc of ckpt.receipts) await saveCoachReceipt(rc);
  for (const pt of ckpt.pendingTurns) await savePendingTurnStrict(pt);
  const lockRes = await acquireSessionLock(ckpt.sessionId, UPGRADED_EDITOR_ID);
  if (!lockRes.ok) {
    throw new Error('恢复检查点编辑锁失败（heldBy=' + lockRes.heldBy + '）');
  }
  registerSessionRuntime({
    sessionId: ckpt.sessionId,
    editorId: UPGRADED_EDITOR_ID,
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });
  return ckpt;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LiveOpenAiToolCallRaw {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function buildBenchThinkingPayload(
  caps: ProviderDeploymentCapabilities,
  depth: CoachThinkingDepth,
): Record<string, unknown> {
  const reasoningEffort =
    depth === 'off' ? 'none' : depth && depth !== 'default' ? depth : undefined;
  const thinkingPayload: Record<string, unknown> = {};
  if (caps.thinkingControlStyle === 'deepseek_mode' && reasoningEffort) {
    thinkingPayload.thinking = { type: reasoningEffort === 'none' ? 'disabled' : 'enabled' };
    thinkingPayload.reasoning_effort = reasoningEffort;
  } else if (caps.thinkingControlStyle === 'bailian_enable_thinking' && depth && depth !== 'default') {
    thinkingPayload.enable_thinking = depth !== 'off';
  } else if (caps.thinkingControlStyle === 'openai_reasoning_effort' && reasoningEffort) {
    thinkingPayload.reasoning_effort = reasoningEffort;
  }
  return thinkingPayload;
}

function extractControlSnapshot(body: Record<string, unknown>): BenchControlSnapshot {
  return {
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    thinking: body.thinking ?? null,
    reasoningEffort: body.reasoning_effort ?? null,
    enableThinking: typeof body.enable_thinking === 'boolean' ? body.enable_thinking : null,
  };
}

function controlsEqual(a: BenchControlSnapshot, b: BenchControlSnapshot): boolean {
  return (
    a.maxTokens === b.maxTokens &&
    JSON.stringify(a.thinking) === JSON.stringify(b.thinking) &&
    a.reasoningEffort === b.reasoningEffort &&
    a.enableThinking === b.enableThinking
  );
}

async function postLiveBaselineChat(
  cfg: CoachStoredProviderConfig,
  caps: ProviderDeploymentCapabilities,
  messages: Array<Record<string, unknown>>,
  tools: unknown[],
): Promise<{
  text: string;
  reasoning?: string;
  toolCalls: LiveOpenAiToolCallRaw[];
  rawUsage?: Record<string, unknown>;
  startedAtMs: number;
  completedAtMs: number;
  controls: BenchControlSnapshot;
}> {
  const endpoint = cfg.baseUrl.replace(/\\/+$/, '') + '/chat/completions';
  const payload: Record<string, unknown> = {
    model: cfg.model,
    stream: false,
    messages,
    tools,
    ...buildBenchThinkingPayload(caps, OPTS.thinking),
  };
  const controls = extractControlSnapshot(payload);
  const startedAtMs = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + cfg.apiKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error('Baseline live HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
  }
  const json = (await res.json()) as {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        tool_calls?: LiveOpenAiToolCallRaw[];
      };
    }>;
    usage?: Record<string, unknown>;
  };
  const completedAtMs = Date.now();
  const msg = json.choices?.[0]?.message;
  return {
    text: String(msg?.content ?? ''),
    ...(msg?.reasoning_content ? { reasoning: String(msg.reasoning_content) } : {}),
    toolCalls: Array.isArray(msg?.tool_calls) ? msg!.tool_calls : [],
    rawUsage: json.usage,
    startedAtMs,
    completedAtMs,
    controls,
  };
}

async function runLiveBaselineTurn(params: {
  cfg: CoachStoredProviderConfig;
  upgradedSessionId: string;
  baselineSession: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  baselineUiHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  prompt: string;
  setNo: number;
  prevArmARequestAtMs?: number;
}): Promise<{
  records: CoachBillingRecord[];
  finalText: string;
  nextBaselineSession: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  toolErrors: BenchToolErrorRecord[];
  requestTraces: BenchRequestTrace[];
  lastRequestAtMs?: number;
  completedAtMs: number;
}> {
  const { cfg, upgradedSessionId, baselineSession, baselineUiHistory, prompt, setNo } = params;
  const caps = resolveProviderCapabilities(pricingArgs(cfg));
  const wireTools = toOpenAiWireTools(COACH_TOOL_DEFINITIONS);
  const upgradedSnapshot = await getSession(upgradedSessionId);

  // 将 IDB sessions 临时切换为 Baseline A 独立训练记录，避免与 Upgraded B 混淆
  await idbClear('sessions');
  await idbPut('sessions', baselineSession);
  await idbDelete('meta', 'lock:' + baselineSession.id);
  const lockA = await acquireSessionLock(baselineSession.id, BASELINE_EDITOR_ID);
  if (!lockA.ok) {
    throw new Error('获取 Arm A 编辑锁失败（heldBy=' + lockA.heldBy + '）');
  }
  registerSessionRuntime({
    sessionId: baselineSession.id,
    editorId: BASELINE_EDITOR_ID,
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: () => undefined,
  });

  const turnRecords: CoachBillingRecord[] = [];
  const toolErrors: BenchToolErrorRecord[] = [];
  const requestTraces: BenchRequestTrace[] = [];
  let prevReqAt = params.prevArmARequestAtMs;
  let finalText = '';
  try {
    const curSessBefore = (await getSession(baselineSession.id))!;
    const roCtxA = await buildCoachReadOnlyContext(
      { activeSession: curSessBefore },
      { includeAllHistory: false, historyLimit: 3 },
    );
    const volatileSysA = buildCoachSystemPrompt(roCtxA, '');

    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: volatileSysA },
      ...baselineUiHistory,
      { role: 'user', content: prompt },
    ];

    for (let round = 0; round < 4; round += 1) {
      const reply = await postLiveBaselineChat(cfg, caps, messages, wireTools);
      requestTraces.push({
        arm: 'A',
        setNo,
        round,
        purpose: round === 0 ? 'initial_turn' : 'tool_followup',
        startedAtMs: reply.startedAtMs,
        completedAtMs: reply.completedAtMs,
        durationMs: Math.max(0, reply.completedAtMs - reply.startedAtMs),
        msSincePrevSameArmRequest:
          prevReqAt !== undefined ? Math.max(0, reply.startedAtMs - prevReqAt) : null,
        controls: reply.controls,
      });
      prevReqAt = reply.completedAtMs;
      finalText = reply.text;
      const completedSetOpsInRound: string[] = [];

      if (reply.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: reply.text || null,
          ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
          tool_calls: reply.toolCalls,
        });

        for (let i = 0; i < reply.toolCalls.length; i += 1) {
          const tc = reply.toolCalls[i];
          const toolCallId = tc.id?.trim() || ('live-a-tc-' + setNo + '-' + round + '-' + i);
          const fnName = tc.function?.name?.trim() ?? '';
          const argsText = tc.function?.arguments ?? '{}';
          let parsedArgs: Record<string, unknown> = {};
          try {
            parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
          } catch {
            parsedArgs = {};
          }
          const latestA = (await getSession(baselineSession.id))!;
          const out = await executeCoachToolCall(
            {
              id: toolCallId,
              operationId: 'live-a:' + setNo + ':r' + round + ':c' + i,
              name: fnName,
              argumentsText: argsText,
              arguments: parsedArgs,
            },
            { activeSession: latestA },
          );
          if (!out.ok) {
            toolErrors.push({
              arm: 'A',
              setNo,
              round,
              toolName: fnName,
              errorCode: out.errorCode ?? 'unknown',
              summary: out.summary,
            });
          } else if (out.receipt?.toolName === 'record_active_set') {
            completedSetOpsInRound.push(out.receipt.operationId);
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: JSON.stringify({
              ok: out.ok,
              summary: out.summary,
              ...(out.receipt ? { receipt: out.receipt } : {}),
              ...(out.errorCode ? { errorCode: out.errorCode } : {}),
            }),
          });
        }
      }

      turnRecords.push(
        normalizeUsageToBillingRecord({
          id: 'live-a-' + Date.now() + '-' + round + '-' + Math.random().toString(36).slice(2, 6),
          threadId: 'live-baseline-a',
          segmentId: 'seg-live-a',
          round,
          purpose: 'coach_turn',
          capabilities: caps,
          rawUsage: reply.rawUsage,
          durationMs: Math.max(1, reply.completedAtMs - reply.startedAtMs),
          operationIdsCompleted: completedSetOpsInRound,
          loggedSetsCount: completedSetOpsInRound.length,
        }),
      );

      if (reply.toolCalls.length === 0) break;
    }

    const updatedA = (await getSession(baselineSession.id)) ?? baselineSession;
    return {
      records: turnRecords,
      finalText,
      nextBaselineSession: updatedA,
      toolErrors,
      requestTraces,
      lastRequestAtMs: prevReqAt,
      completedAtMs: Date.now(),
    };
  } finally {
    await idbClear('sessions');
    if (upgradedSnapshot) {
      await idbPut('sessions', upgradedSnapshot);
      await idbDelete('meta', 'lock:' + upgradedSnapshot.id);
      const restoreLock = await acquireSessionLock(upgradedSnapshot.id, UPGRADED_EDITOR_ID);
      if (!restoreLock.ok) {
        throw new Error('恢复 Arm B 编辑锁失败（heldBy=' + restoreLock.heldBy + '）');
      }
      registerSessionRuntime({
        sessionId: upgradedSnapshot.id,
        editorId: UPGRADED_EDITOR_ID,
        awaitPendingWrites: async () => undefined,
        applyCommittedSession: () => undefined,
        hasBlockingDrafts: () => false,
        startRestTimer: () => undefined,
        stopRestTimer: () => undefined,
      });
    }
  }
}

async function runLiveControlled(providerKey: 'deepseek' | 'bailian', providerCfg: CoachStoredProviderConfig) {
  const effectiveCfg: CoachStoredProviderConfig = {
    ...providerCfg,
    ...(OPTS.pricingWindow !== 'auto'
      ? ({ pricingWindowOverride: OPTS.pricingWindow } as Partial<CoachStoredProviderConfig>)
      : {}),
  };
  let sessionId = 'sess-live-' + providerKey + '-' + Date.now();
  let baselineSessionId = 'sess-live-baseline-' + providerKey + '-' + Date.now();
  let baselineSession: Awaited<ReturnType<typeof getSession>> | null = null;
  let tid: string;
  let nextSetIndex = 1;
  let hasWarmPrefix = false;
  let lastCompletedTurnAtMs = 0;
  let lastArmATurnAtMs = 0;
  let lastArmBTurnAtMs = 0;
  let lastArmARequestAtMs: number | undefined;
  let lastArmBRequestAtMs: number | undefined;
  let uiHistory: CoachStoredMessage[] = [];
  let resumeElapsedMs: number | null = null;
  let baselineRecords: CoachBillingRecord[] = [];
  let baselineUiHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let armAToolErrors: BenchToolErrorRecord[] = [];
  let armBToolErrors: BenchToolErrorRecord[] = [];
  let armARequestTraces: BenchRequestTrace[] = [];
  let armBRequestTraces: BenchRequestTrace[] = [];
  // 累计“本次实际请求的目标稳定组”（按 exerciseId:setId）与跨 checkpoint 的不可比证据
  let armACompletedTargetKeys = new Set<string>();
  let armBCompletedTargetKeys = new Set<string>();
  let bucketWindowMismatchObserved = false;
  let targetCompletionMismatchObserved = false;
  const ckptPath = resolveCheckpointPath(OPTS.checkpoint, providerKey, OPTS.provider === 'all');

  if (OPTS.resume) {
    if (!ckptPath) throw new Error('--resume 必须同时提供 --checkpoint <file>');
    const ckpt = await restoreCheckpointFile(ckptPath, providerKey, effectiveCfg);
    sessionId = ckpt.sessionId;
    baselineSessionId = ckpt.baselineSessionId ?? ('sess-live-baseline-' + providerKey + '-resumed');
    baselineSession = ckpt.baselineSession ?? structuredClone(await getSession(sessionId));
    tid = ckpt.threadId;
    nextSetIndex = ckpt.nextSetIndex;
    hasWarmPrefix = Boolean(ckpt.hasWarmPrefix);
    lastCompletedTurnAtMs = ckpt.lastTurnAtMs;
    lastArmATurnAtMs = ckpt.lastArmATurnAtMs ?? ckpt.lastTurnAtMs;
    lastArmBTurnAtMs = ckpt.lastArmBTurnAtMs ?? ckpt.lastTurnAtMs;
    lastArmARequestAtMs = ckpt.lastArmARequestAtMs;
    lastArmBRequestAtMs = ckpt.lastArmBRequestAtMs;
    uiHistory = ckpt.uiHistory;
    baselineRecords = ckpt.baselineRecords ?? [];
    baselineUiHistory = ckpt.baselineUiHistory ?? [];
    armAToolErrors = ckpt.armAToolErrors ?? [];
    armBToolErrors = ckpt.armBToolErrors ?? [];
    armARequestTraces = ckpt.armARequestTraces ?? [];
    armBRequestTraces = ckpt.armBRequestTraces ?? [];
    armACompletedTargetKeys = new Set(ckpt.armACompletedTargetKeys ?? []);
    armBCompletedTargetKeys = new Set(ckpt.armBCompletedTargetKeys ?? []);
    bucketWindowMismatchObserved = Boolean(ckpt.bucketWindowMismatchObserved);
    targetCompletionMismatchObserved = Boolean(ckpt.targetCompletionMismatchObserved);
    resumeElapsedMs = Date.now() - ckpt.lastTurnAtMs;
  } else {
    const session = await setupWorkout(sessionId, UPGRADED_EDITOR_ID);
    baselineSession = { ...structuredClone(session), id: baselineSessionId };
    const threads = await loadCoachThreadsState();
    tid = threads.activeThreadId;
    // 不再在首轮派发前预写 checkpoint：仅在本桶完成并核对 DB 目标/时间桶后一次性落盘（见循环内）。
  }

  const bucketList =
    OPTS.bucket === 'all'
      ? ['first_turn', 'immediate_tool', 'inter_set_90s', 'inter_set_3m', 'inter_set_6m_plus']
      : [OPTS.bucket];

  const bucketReports: Array<Record<string, unknown>> = [];

  for (const bucket of bucketList) {
    const win = BUCKET_WINDOWS_MS[bucket] ?? { minMs: 0, maxMs: Number.POSITIVE_INFINITY };
    let actualElapsedMs: number | null = null;
    let armAElapsedSincePrevTurnMs: number | null = null;
    let armBElapsedSincePrevTurnMs: number | null = null;

    if (bucket !== 'first_turn') {
      if (!hasWarmPrefix) {
        if (bucket === 'cross_day_12_24h' && !OPTS.resume) {
          throw new Error('cross_day_12_24h 需要已有热前缀的 --resume 检查点：请先运行 --bucket first_turn --checkpoint <file>');
        }
        if (OPTS.resume) {
          bucketReports.push({
            bucket,
            status: 'cold_checkpoint_missing_warm_prefix',
            actualElapsedMs: null,
            armAElapsedSincePrevTurnMs: null,
            armBElapsedSincePrevTurnMs: null,
            classifiedBucket: 'cold_uninitialized',
            windowMatched: false,
            note: '当前检查点尚未完成首轮热前缀建立，拒绝在冷状态下伪造热缓存分桶结果。',
          });
          continue;
        }
        throw new Error('分桶 ' + bucket + ' 需要热前缀：请先运行 --bucket first_turn --checkpoint <file>，再用 --resume 继续（或传 --bucket all 连续测量）');
      }

      if (!OPTS.resume && lastCompletedTurnAtMs > 0) {
        const refTs = Math.max(lastArmATurnAtMs || 0, lastArmBTurnAtMs || 0, lastCompletedTurnAtMs);
        const elapsedSoFar = Date.now() - refTs;
        if (elapsedSoFar < win.minMs) {
          await sleepMs(win.minMs - elapsedSoFar + 50);
        }
      }

      actualElapsedMs = lastCompletedTurnAtMs > 0 ? Date.now() - lastCompletedTurnAtMs : 0;
      armAElapsedSincePrevTurnMs = lastArmATurnAtMs > 0 ? Date.now() - lastArmATurnAtMs : 0;
      if (actualElapsedMs < win.minMs || actualElapsedMs > win.maxMs) {
        bucketReports.push({
          bucket,
          status: 'elapsed_out_of_window',
          actualElapsedMs,
          armAElapsedSincePrevTurnMs,
          armBElapsedSincePrevTurnMs: lastArmBTurnAtMs > 0 ? Date.now() - lastArmBTurnAtMs : null,
          expectedWindowMs: {
            min: win.minMs,
            max: Number.isFinite(win.maxMs) ? win.maxMs : null,
          },
          classifiedBucket: classifyElapsedBucket(actualElapsedMs),
          windowMatched: false,
          note:
            actualElapsedMs < win.minMs
              ? '实际间隔短于分桶下界，未执行请求以避免伪造冷/温切换结论。'
              : '实际间隔超过分桶上界，未执行请求以避免跨窗失真。',
        });
        continue;
      }
    } else if (OPTS.resume && lastCompletedTurnAtMs > 0 && hasWarmPrefix) {
      actualElapsedMs = Date.now() - lastCompletedTurnAtMs;
      armAElapsedSincePrevTurnMs = lastArmATurnAtMs > 0 ? Date.now() - lastArmATurnAtMs : null;
    }

    const beforeBills = (await listBillingRecords(tid)).length;
    const beforeEntryIds = new Set((await listProtocolEntries(tid)).map((e) => e.id));
    const setNo = nextSetIndex;
    nextSetIndex += 1;
    const prompt =
      bucket === 'first_turn'
        ? '开始训练！请帮我记录第 1 组双杠臂屈伸 60kg 10次，并简短确认。'
        : bucket === 'immediate_tool'
          ? '第 ' + setNo + ' 组 60kg 10次完成，请记组后给一句简短呼吸提示。'
          : '刚完成第 ' + setNo + ' 组 60kg 10次，帮我记录这组。';

    const intendedTargetKey = resolveIntendedTargetKey(baselineSession, setNo);
    const baselineTurnOut = await runLiveBaselineTurn({
      cfg: effectiveCfg,
      upgradedSessionId: sessionId,
      baselineSession: baselineSession!,
      baselineUiHistory,
      prompt,
      setNo,
      prevArmARequestAtMs: lastArmARequestAtMs,
    });
    baselineSession = baselineTurnOut.nextBaselineSession;
    const bucketANewKeys =
      intendedTargetKey && doneTargetKeySet(baselineSession).has(intendedTargetKey)
        ? [intendedTargetKey]
        : [];
    for (const k of bucketANewKeys) armACompletedTargetKeys.add(k);
    baselineRecords.push(...baselineTurnOut.records);
    lastArmATurnAtMs = baselineTurnOut.completedAtMs;
    lastArmARequestAtMs = baselineTurnOut.lastRequestAtMs ?? lastArmARequestAtMs;
    armAToolErrors.push(...baselineTurnOut.toolErrors);
    armARequestTraces.push(...baselineTurnOut.requestTraces);
    baselineUiHistory.push({ role: 'user', content: prompt });
    if (baselineTurnOut.finalText) {
      baselineUiHistory.push({ role: 'assistant', content: baselineTurnOut.finalText });
    }

    // 续租 Arm B 编辑锁，防止跨桶长等待后锁过期导致误拒写
    const renewB = await acquireSessionLock(sessionId, UPGRADED_EDITOR_ID);
    if (!renewB.ok) {
      throw new Error('续租 Arm B 编辑锁失败（heldBy=' + renewB.heldBy + '）');
    }

    armBElapsedSincePrevTurnMs = lastArmBTurnAtMs > 0 ? Date.now() - lastArmBTurnAtMs : null;
    const armBTurnTraces: BenchRequestTrace[] = [];
    let armBRoundIdx = 0;
    const prevGlobalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const startedAtMs = Date.now();
      let controls: BenchControlSnapshot = {
        maxTokens: null,
        thinking: null,
        reasoningEffort: null,
        enableThinking: null,
      };
      let purpose = armBRoundIdx === 0 ? 'initial_turn' : 'tool_followup';
      try {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        controls = extractControlSnapshot(parsed);
        const msgs = Array.isArray(parsed.messages)
          ? (parsed.messages as Array<{ role?: string }>)
          : [];
        const lastRole = msgs[msgs.length - 1]?.role;
        if (lastRole === 'tool') purpose = 'tool_followup';
        else if (armBRoundIdx === 0) purpose = 'initial_turn';
      } catch {
        /* keep default */
      }
      const res = await prevGlobalFetch(url, init);
      // 分列响应头、首 token、协议终帧三个时刻；完成以“解析器消费到协议终帧”为准，
      // 绝不等迟来的 EOF，也不用响应头时刻冒充完成。异常/中断单独以 terminalKind 标注。
      const responseHeaderAtMs = Date.now();
      const trace: BenchRequestTrace = {
        arm: 'B',
        setNo,
        round: armBRoundIdx,
        purpose,
        startedAtMs,
        responseHeaderAtMs,
        completedAtMs: startedAtMs,
        durationMs: 0,
        msSincePrevSameArmRequest:
          lastArmBRequestAtMs !== undefined
            ? Math.max(0, startedAtMs - lastArmBRequestAtMs)
            : null,
        controls,
      };
      armBTurnTraces.push(trace);
      armBRoundIdx += 1;
      let finalized = false;
      const finalize = (kind: 'protocol_terminal' | 'eof_without_terminal' | 'aborted' | 'error') => {
        if (finalized) return;
        finalized = true;
        const completed = Date.now();
        trace.completedAtMs = completed;
        trace.durationMs = Math.max(0, completed - startedAtMs);
        trace.terminalKind = kind;
        trace.aborted = kind === 'aborted' || kind === 'error';
        lastArmBRequestAtMs = completed;
      };
      if (!res.body) {
        // 非流式响应（错误体等）：以 body 读完为界，标记无终帧语义
        finalize(res.ok ? 'protocol_terminal' : 'error');
        return res;
      }
      const [callerBody, observeBody] = res.body.tee();
      let sawFirstToken = false;
      // 复用 iterateSseEvents 语义事件：可跨网络块聚合，协议终帧判定不依赖单块正则
      (async () => {
        try {
          for await (const ev of iterateSseEvents(observeBody)) {
            if (!sawFirstToken && sseEventHasGeneratedToken(ev)) {
              sawFirstToken = true;
              trace.firstTokenAtMs = Date.now();
            }
            if (finalized) continue;
            const data = ev && typeof ev.data === 'string' ? ev.data : '';
            if (
              data === '[DONE]' ||
              data.indexOf('"message_stop"') >= 0 ||
              (ev && ev.event === 'message_stop')
            ) {
              finalize('protocol_terminal');
            }
          }
          if (!finalized) finalize('eof_without_terminal');
        } catch {
          if (!finalized) finalize('error');
        }
      })();
      const callerReader = callerBody.getReader();
      const passthrough = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await callerReader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (err) {
            controller.error(err);
          }
        },
        cancel(reason) {
          finalize('aborted');
          return callerReader.cancel(reason);
        },
      });
      return new Response(passthrough, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    };

    const tStart = Date.now();
    let res;
    try {
      res = await runCoachTurn({
        threadId: tid,
        userText: prompt,
        history: uiHistory,
        webSearch: false,
        thinkingDepth: OPTS.thinking,
        providerConfig: effectiveCfg,
        toolContext: { activeSession: await getSession(sessionId) },
        streamChunkDelayMs: 0,
        onUsage: async (u) => {
          await patchCoachThreadUiFields(tid, {
            updatedAt: Date.now(),
            lastUsage: {
              promptTokens: u.promptTokens ?? 0,
              cachedTokens: u.cachedTokens,
              completionTokens: u.completionTokens,
              totalTokens: u.totalTokens,
              updatedAt: Date.now(),
            },
          });
        },
      });
    } finally {
      globalThis.fetch = prevGlobalFetch;
    }

    const turnEntries = (await listProtocolEntries(tid)).filter((e) => !beforeEntryIds.has(e.id));
    const bucketArmBToolErrors: BenchToolErrorRecord[] = [];
    let armBAssistantToolRounds = 0;
    for (const entry of turnEntries) {
      if (entry.kind === 'assistant' && entry.toolCalls?.length) {
        armBAssistantToolRounds += 1;
      } else if (entry.kind === 'tool' && entry.toolError) {
        let errorCode = 'tool_error';
        let summary = entry.toolResultText ?? '';
        try {
          const parsed = JSON.parse(entry.toolResultText ?? '{}') as {
            errorCode?: string;
            summary?: string;
          };
          errorCode = parsed.errorCode ?? 'tool_error';
          summary = parsed.summary ?? summary;
        } catch {
          /* keep raw */
        }
        bucketArmBToolErrors.push({
          arm: 'B',
          setNo,
          round: Math.max(0, armBAssistantToolRounds - 1),
          toolName: entry.toolName ?? 'unknown',
          errorCode,
          summary,
        });
      }
    }
    if (
      bucketArmBToolErrors.length === 0 &&
      (res.aborted ||
        res.outcomeKind === 'malformed_tool_call' ||
        res.outcomeKind === 'truncated_eof' ||
        res.outcomeKind === 'truncated_max_tokens')
    ) {
      bucketArmBToolErrors.push({
        arm: 'B',
        setNo,
        round: Math.max(0, armBTurnTraces.length - 1),
        toolName: 'batch_or_stream',
        errorCode: res.outcomeKind ?? 'aborted',
        summary: res.errorMessage ?? res.text ?? 'Arm B 工具批校验或流式异常',
      });
    }
    armBToolErrors.push(...bucketArmBToolErrors);
    armBRequestTraces.push(...armBTurnTraces);

    hasWarmPrefix = true;
    lastCompletedTurnAtMs = Date.now();
    lastArmBTurnAtMs = lastCompletedTurnAtMs;
    uiHistory.push({ id: 'live-u-' + setNo, threadId: tid, role: 'user', createdAt: tStart, text: prompt });
    uiHistory.push({ id: 'live-a-' + setNo, threadId: tid, role: 'assistant', createdAt: lastCompletedTurnAtMs, text: res.text, reasoning: res.reasoning });

    const afterBills = (await listBillingRecords(tid)).slice(beforeBills);
    const curSess = (await getSession(sessionId))!;
    const bucketBNewKeys =
      intendedTargetKey && doneTargetKeySet(curSess).has(intendedTargetKey)
        ? [intendedTargetKey]
        : [];
    for (const k of bucketBNewKeys) armBCompletedTargetKeys.add(k);
    // 单桶用“该次实际完成的目标组数”；累计每成功组费用用跨 checkpoint 的稳定目标组集合。
    const loggedSetsInDb = bucketBNewKeys.length;
    const baselineLoggedSetsInDb = bucketANewKeys.length;
    // 目标完成状态：本次有效操作数 > 本次实际完成目标组数 => 存在“改同一已完成组”的重复操作，标记不可比，
    // 并写入跨 checkpoint 证据（resume 后仍会被发现，不会漏报）。
    const bucketBOps = summarizeBillingRecords(afterBills).dedupedLoggedSets;
    if (bucketBOps > bucketBNewKeys.length) targetCompletionMismatchObserved = true;
    // 两臂按各自“实际发送时”的续发间隔独立分桶；只要有一臂落在别桶，就不能当作匹配样本，
    // 仍分臂保留观察值，但窗口匹配为 false 且不参与节省率。跨 checkpoint 保留该不匹配证据。
    const armAClassifiedBucket =
      bucket === 'first_turn' ? 'first_turn' : classifyElapsedBucket(armAElapsedSincePrevTurnMs ?? 0);
    const armBClassifiedBucket =
      bucket === 'first_turn' ? 'first_turn' : classifyElapsedBucket(armBElapsedSincePrevTurnMs ?? 0);
    const windowMatched =
      bucket === 'first_turn'
        ? true
        : armAClassifiedBucket === bucket && armBClassifiedBucket === bucket;
    if (!windowMatched && bucket !== 'first_turn') bucketWindowMismatchObserved = true;
    bucketReports.push({
      bucket,
      actualElapsedMs,
      armAElapsedSincePrevTurnMs,
      armAClassifiedBucket,
      armBElapsedSincePrevTurnMs,
      armBClassifiedBucket,
      classifiedBucket:
        bucket === 'first_turn'
          ? 'first_turn'
          : classifyElapsedBucket(actualElapsedMs ?? 0),
      windowMatched,
      ...(windowMatched
        ? {}
        : {
            note: '两臂各自实际续发间隔分桶不一致（A=' +
              armAClassifiedBucket + '，B=' + armBClassifiedBucket + '，请求桶=' + bucket +
              '），仅保留分臂观察值，不作为匹配样本进入节省率。',
          }),
      resumedFromElapsedMs: resumeElapsedMs,
      aborted: res.aborted,
      outcomeKind: res.outcomeKind,
      errorMessage: res.errorMessage ?? null,
      armAToolErrors: baselineTurnOut.toolErrors,
      armBToolErrors: bucketArmBToolErrors,
      armAPerRequestRecords: baselineTurnOut.records.map((b, rIdx) => ({
        round: b.round,
        purpose: baselineTurnOut.requestTraces[rIdx]?.purpose ?? 'coach_turn',
        startedAtMs: baselineTurnOut.requestTraces[rIdx]?.startedAtMs ?? null,
        completedAtMs: baselineTurnOut.requestTraces[rIdx]?.completedAtMs ?? null,
        durationMs: b.durationMs ?? baselineTurnOut.requestTraces[rIdx]?.durationMs ?? null,
        msSincePrevSameArmRequest:
          baselineTurnOut.requestTraces[rIdx]?.msSincePrevSameArmRequest ?? null,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        uncachedInputTokens: b.uncachedInputTokens,
        unknownCacheInputTokens: b.unknownCacheInputTokens ?? 0,
        outputTokens: b.outputTokens,
        cacheDetailSource: b.cacheDetailSource,
        computedCost: b.computedCostUsd,
      })),
      armBPerRequestRecords: afterBills.map((b, rIdx) => ({
        round: b.round,
        purpose: armBTurnTraces[rIdx]?.purpose ?? b.purpose,
        startedAtMs: armBTurnTraces[rIdx]?.startedAtMs ?? null,
        responseHeaderAtMs: armBTurnTraces[rIdx]?.responseHeaderAtMs ?? null,
        firstTokenAtMs: armBTurnTraces[rIdx]?.firstTokenAtMs ?? null,
        completedAtMs: armBTurnTraces[rIdx]?.completedAtMs ?? null,
        durationMs: armBTurnTraces[rIdx]?.durationMs ?? b.durationMs ?? null,
        terminalKind: armBTurnTraces[rIdx]?.terminalKind ?? null,
        aborted: armBTurnTraces[rIdx]?.aborted ?? false,
        msSincePrevSameArmRequest:
          armBTurnTraces[rIdx]?.msSincePrevSameArmRequest ?? null,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        uncachedInputTokens: b.uncachedInputTokens,
        unknownCacheInputTokens: b.unknownCacheInputTokens ?? 0,
        outputTokens: b.outputTokens,
        cacheDetailSource: b.cacheDetailSource,
        computedCost: b.computedCostUsd,
      })),
      baselineA_v022_bucket: formatMetrics(
        summarizeBillingRecords(baselineTurnOut.records),
        baselineLoggedSetsInDb,
      ),
      perRequestRecords: afterBills.map((b, rIdx) => ({
        round: b.round,
        purpose: armBTurnTraces[rIdx]?.purpose ?? b.purpose,
        startedAtMs: armBTurnTraces[rIdx]?.startedAtMs ?? null,
        responseHeaderAtMs: armBTurnTraces[rIdx]?.responseHeaderAtMs ?? null,
        firstTokenAtMs: armBTurnTraces[rIdx]?.firstTokenAtMs ?? null,
        completedAtMs: armBTurnTraces[rIdx]?.completedAtMs ?? null,
        durationMs: armBTurnTraces[rIdx]?.durationMs ?? b.durationMs ?? null,
        terminalKind: armBTurnTraces[rIdx]?.terminalKind ?? null,
        aborted: armBTurnTraces[rIdx]?.aborted ?? false,
        msSincePrevSameArmRequest:
          armBTurnTraces[rIdx]?.msSincePrevSameArmRequest ?? null,
        inputTokens: b.inputTokens,
        cachedInputTokens: b.cachedInputTokens,
        uncachedInputTokens: b.uncachedInputTokens,
        unknownCacheInputTokens: b.unknownCacheInputTokens ?? 0,
        outputTokens: b.outputTokens,
        cacheDetailSource: b.cacheDetailSource,
        computedCost: b.computedCostUsd,
      })),
      bucketSummary: formatMetrics(summarizeBillingRecords(afterBills), loggedSetsInDb),
    });
    if (ckptPath) {
      await saveCheckpointFile(
        ckptPath,
        providerKey,
        effectiveCfg,
        hasWarmPrefix,
        sessionId,
        baselineSessionId,
        baselineSession,
        tid,
        nextSetIndex,
        lastCompletedTurnAtMs,
        uiHistory,
        baselineRecords,
        baselineUiHistory,
        {
          lastArmATurnAtMs,
          lastArmBTurnAtMs,
          lastArmARequestAtMs,
          lastArmBRequestAtMs,
          armAToolErrors,
          armBToolErrors,
          armARequestTraces,
          armBRequestTraces,
          armACompletedTargetKeys: [...armACompletedTargetKeys],
          armBCompletedTargetKeys: [...armBCompletedTargetKeys],
          bucketWindowMismatchObserved,
          targetCompletionMismatchObserved,
        },
      );
    }
    resumeElapsedMs = null;
  }

  const totalBills = (await listBillingRecords(tid)).filter((b) => b.purpose !== 'web_search');
  // 累计每成功组费用按“本次实际请求的目标稳定组”核对 DB 最终完成状态（跨 checkpoint 保留），
  // 不再用全表 done 数（避免把其他动作/未请求组计入）或 operationId 分母；
  // 并与当前主库最终 done 取交集，累计集中若目标已被 Undo 撤回则不计入。
  const finalBSess = await getSession(sessionId);
  const finalADone = doneTargetKeySet(baselineSession);
  const finalBDone = doneTargetKeySet(finalBSess);
  const totalLoggedInDb = [...armBCompletedTargetKeys].filter((k) => finalBDone.has(k)).length;
  const totalBaselineLoggedInDb = [...armACompletedTargetKeys].filter((k) => finalADone.has(k)).length;
  const armASummary = formatMetrics(summarizeBillingRecords(baselineRecords), totalBaselineLoggedInDb);
  const armBSummary = formatMetrics(summarizeBillingRecords(totalBills), totalLoggedInDb);
  const armAControl = armARequestTraces[0]?.controls ?? null;
  const armBControl = armBRequestTraces[0]?.controls ?? null;
  const controlsMatched =
    armAControl !== null &&
    armBControl !== null &&
    armARequestTraces.every((t) => controlsEqual(t.controls, armAControl)) &&
    armBRequestTraces.every((t) => controlsEqual(t.controls, armAControl));
  const incomparableReasons: string[] = [];
  if (totalBaselineLoggedInDb <= 0) incomparableReasons.push('armA_zero_logged_sets');
  if (totalLoggedInDb <= 0) incomparableReasons.push('armB_zero_logged_sets');
  if (armAToolErrors.length > 0) incomparableReasons.push('armA_tool_failures');
  if (armBToolErrors.length > 0) incomparableReasons.push('armB_tool_failures');
  if (bucketReports.some((b) => b.aborted)) incomparableReasons.push('armB_turn_aborted');
  if (
    bucketWindowMismatchObserved ||
    bucketReports.some((b) => b.bucket !== 'first_turn' && b.windowMatched === false)
  ) {
    bucketWindowMismatchObserved = true;
    incomparableReasons.push('bucket_window_mismatch');
  }
  // 有效操作数（distinct operationId）大于实际完成的目标组数 => 其中一次是“改同一已完成组”
  // （A=2、B 第二次重写第一组时 B 仍为 1 组）。不能按 operationId 充作第二组，也不可混算节省率。
  // 该判定同时参考跨 checkpoint 保留的证据，resume 后已发现的不匹配不会漏报。
  if (armBSummary.dedupedLoggedSets > totalLoggedInDb) targetCompletionMismatchObserved = true;
  if (targetCompletionMismatchObserved) incomparableReasons.push('armB_target_completion_mismatch');
  if (armASummary.dedupedLoggedSets > totalBaselineLoggedInDb) {
    incomparableReasons.push('armA_target_completion_mismatch');
  }
  if (!controlsMatched) incomparableReasons.push('generation_controls_mismatch');
  if (
    armASummary.estimatedCostFromSchedule === null ||
    armBSummary.estimatedCostFromSchedule === null
  ) {
    incomparableReasons.push('missing_usage_or_unknown_pricing');
  }
  const costPerLoggedSetComparable = incomparableReasons.length === 0;
  const costSavingsRatio =
    costPerLoggedSetComparable &&
    armASummary.estimatedCostPerLoggedSet !== null &&
    armASummary.estimatedCostPerLoggedSet > 0 &&
    armBSummary.estimatedCostPerLoggedSet !== null
      ? Number(
          (
            1 -
            armBSummary.estimatedCostPerLoggedSet / armASummary.estimatedCostPerLoggedSet
          ).toFixed(6),
        )
      : null;

  return {
    providerKey,
    model: providerCfg.model,
    sessionId,
    baselineSessionId,
    threadId: tid,
    baselineProvenance: {
      source: 'reconstructed_v022_strategy_on_current_worktree',
      note: 'Arm A 在当前工作树按 v0.2.2 动态 system 快照与单轮历史策略重建（无旧版实机抓包时作为可控对照基线）。',
    },
    controlVariables: {
      armA: armAControl,
      armB: armBControl,
      controlsMatched,
    },
    armAToolErrors,
    armBToolErrors,
    costPerLoggedSetComparable,
    incomparableReasons,
    costSavingsRatio,
    deploymentSummary: {
      deploymentId: resolveProviderCapabilities(pricingArgs(effectiveCfg)).deploymentId,
      armA: {
        weightedCacheHitRate: armASummary.weightedCacheHitRate,
        cumulativeMissTokens: armASummary.uncachedInputTokens,
        usageCoverageRatio: armASummary.usageCoverageRatio,
        cacheDetailCoverageRatio: armASummary.cacheDetailCoverageRatio,
        loggedSetsInDb: totalBaselineLoggedInDb,
        estimatedCostPerLoggedSet: armASummary.estimatedCostPerLoggedSet,
        estimatedTotalCost: armASummary.estimatedCostFromSchedule,
        currency: armASummary.currency,
      },
      armB: {
        weightedCacheHitRate: armBSummary.weightedCacheHitRate,
        cumulativeMissTokens: armBSummary.uncachedInputTokens,
        usageCoverageRatio: armBSummary.usageCoverageRatio,
        cacheDetailCoverageRatio: armBSummary.cacheDetailCoverageRatio,
        loggedSetsInDb: totalLoggedInDb,
        estimatedCostPerLoggedSet: armBSummary.estimatedCostPerLoggedSet,
        estimatedTotalCost: armBSummary.estimatedCostFromSchedule,
        currency: armBSummary.currency,
      },
    },
    buckets: bucketReports,
    baselineA_v022_cumulative: armASummary,
    cumulativeSummary: armBSummary,
  };
}

function makeTargets(): Array<{ key: 'deepseek' | 'bailian'; label: string; cfg: CoachStoredProviderConfig }> {
  const dsKey = process.env.DEEPSEEK_API_KEY ?? 'offline-bench-key';
  const blKey = process.env.DASHSCOPE_API_KEY ?? 'offline-bench-key';
  const all = [
    {
      key: 'deepseek' as const,
      label: 'DeepSeek Official (api.deepseek.com / deepseek-flash)',
      cfg: {
        key: 'provider' as const,
        kind: 'openai-compatible' as const,
        presetId: 'deepseek-official',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        thinkingDepth: OPTS.thinking,
        apiKey: dsKey,
        updatedAt: NOW,
      },
    },
    {
      key: 'bailian' as const,
      label: 'Aliyun Bailian DeepSeek (dashscope cn-beijing / deepseek-v4.1-flash-1017)',
      cfg: {
        key: 'provider' as const,
        kind: 'openai-compatible' as const,
        presetId: 'bailian-deepseek',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'deepseek-v4.1-flash-1017',
        thinkingDepth: OPTS.thinking,
        apiKey: blKey,
        updatedAt: NOW,
      },
    },
  ];
  return OPTS.provider === 'all' ? all : all.filter((t) => t.key === OPTS.provider);
}

async function main() {
  const targets = makeTargets();
  if (!OPTS.live) {
    const offlineResults = [];
    for (const target of targets) {
      const caps = resolveProviderCapabilities(pricingArgs(target.cfg));
      const a = await runBaselineV022Simulator(target.cfg);
      const b = await runUpgradedV023Benchmark(target.cfg);
      offlineResults.push({
        target: target.label,
        pricing: caps.pricing,
        baselineA_v022: a,
        upgradedB_v023: b,
      });
    }
    console.log(
      JSON.stringify(
        {
          mode: 'offline-wire-prefix-verification',
          note: '离线模式基于真实序列化 HTTP 请求体做 64-token 对齐前缀匹配，并依据官方时段定价表换算估算值；真实服务端命中与实际扣费请以 --live 与平台账单核对为准。',
          thinking: OPTS.thinking,
          pricingWindow: OPTS.pricingWindow,
          targets: offlineResults,
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const t of targets) {
    if (t.key === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
      throw new Error('--live --provider ' + t.key + ' 需要设置环境变量 DEEPSEEK_API_KEY');
    }
    if (t.key === 'bailian' && !process.env.DASHSCOPE_API_KEY) {
      throw new Error('--live --provider ' + t.key + ' 需要设置环境变量 DASHSCOPE_API_KEY');
    }
  }

  const liveResults = [];
  for (const t of targets) {
    liveResults.push(await runLiveControlled(t.key, t.cfg));
  }
  console.log(
    JSON.stringify(
      {
        mode: 'live-controlled-endpoint',
        thinking: OPTS.thinking,
        pricingWindow: OPTS.pricingWindow,
        bucketRequested: OPTS.bucket,
        targets: liveResults,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;

async function runHost() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entryTs = join(APP_DIR, `.bench-runner-${stamp}.tmp.ts`);
  const outMjs = join(APP_DIR, `.bench-runner-${stamp}.tmp.mjs`);
  writeFileSync(entryTs, RUNNER_TS, 'utf8');

  try {
    await build({
      entryPoints: [entryTs],
      outfile: outMjs,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      packages: 'external',
      absWorkingDir: APP_DIR,
      logLevel: 'silent',
    });
    process.env.BENCH_OPTS_JSON = JSON.stringify(opts);
    await import(pathToFileURL(outMjs).href);
  } finally {
    if (existsSync(entryTs)) rmSync(entryTs, { force: true });
    if (existsSync(outMjs)) rmSync(outMjs, { force: true });
  }
}

runHost().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
