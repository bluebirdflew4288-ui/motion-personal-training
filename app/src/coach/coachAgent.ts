/* 电子教练对话引擎与工具调度循环（0.2.2 全权限 + Hermes 记忆 + 联网思考版）。
   双模同轨：
   1. 在线模型模式：基于 providerAdapter.ts（streamCoachTurn）走真实 SSE 流式 + 多轮 tool call，支持 Gemini 原生联网两阶段回退与 Tavily/博查/Brave 通用搜索；
   2. 本地确定性引擎模式（无 API Key 或离线受控模式）：按同一组 coachTools / coachTx 通道执行动作替换、组型转换、备注、完训、热身/有氧/档位备忘、记忆与全量历史纠错；
   用户侧话术严格屏蔽内部工具标识符，并约束自然简洁、杜绝 AI 八股文。 */

import {
  billingTotalsFromRecords,
  normalizeUsageToBillingRecord,
  saltedPrefixDigest,
} from './coachBilling';
import {
  checkHardContextBudget,
  estimateTokens,
  evaluateEconomicCompaction,
} from './coachContext';
import {
  advanceCheckpointForToolOutcome,
  buildTurnDeltaBlock,
  computeSegmentSyncCheckpoint,
  hashTextCompact,
  type CoachSegmentCheckpoint,
} from './coachDelta';
import { extractPlanDraftFromImage } from './coachImage';
import { formatCoachMemoryForPrompt, loadCoachMemory } from './coachMemory';
import { getCoachFetch } from './coachNativeStream';
import {
  buildFrozenSegmentBaseline,
  sortToolDefinitionsStably,
  STATIC_COACH_SYSTEM_PROMPT,
} from './coachPrompt';
import {
  appendProtocolEntriesStrict,
  commitAbandonReconciliationAtomic,
  commitToolBatchIntentAtomic,
  commitToolStepOutcomeAtomic,
  DEFAULT_COACH_THREAD_ID,
  deletePendingTurnStrict,
  findSavedProviderConfigForRoute,
  findVaultReceiptByOperationIdStrict,
  getCoachReceiptByOperationId,
  getCoachRestoreEpoch,
  getPendingTurn,
  listBillingRecords,
  listPendingTurns,
  listProtocolEntries,
  loadCoachMessages,
  loadCoachVaultMeta,
  loadCoachThreadsState,
  normalizeWebSearchProvider,
  patchCoachThreadsState,
  replaceProtocolEntriesForThread,
  saveBillingRecordStrict,
  saveCoachReceipt,
  saveCoachVaultMeta,
  savePendingTurnStrict,
  type CoachBillingRecord,
  type CoachManualCompactionKeptMessage,
  type CoachOperationReceipt,
  type CoachPendingPlannedToolCall,
  type CoachPendingTurn,
  type CoachPlanDraft,
  type CoachProtocolEntry,
  type CoachProtocolToolCall,
  type CoachSegmentReason,
  type CoachSegmentState,
  type CoachStoredAttachment,
  type CoachStoredMessage,
  type CoachStoredProviderConfig,
} from './coachStorage';
import { receiptFromMainOpLog, type CoachMainOpLogRecord } from './coachMainTx';
import {
  advanceFrozenViewForToolOutcome,
  ALLOWED_BUSINESS_TOOL_NAMES,
  buildCoachReadOnlyContext,
  buildCoachReadOnlyContextWithView,
  COACH_TOOL_DEFINITIONS,
  executeCoachToolCall,
  freezeToolBatchAgainstView,
  projectToolOutcomeForModel,
  validateToolCallBatch,
  type CoachFrozenView,
  type CoachReadOnlyContext,
  type CoachToolExecutionContext,
} from './coachTools';
import { runCoachWebSearch } from './coachWebSearch';
import { COACH_OP_META_PREFIX, idbGet, REST_TIMER_STATE_META_PREFIX } from '../db/idb';
import { getPlan, getSession } from '../db/repo';
import { getActiveSessionRuntime } from './sessionRuntimeBridge';
import {
  shouldDispatchCoachOpTimer,
  type CoachRestTimerDirective,
  type DurableRestTimerRecord,
} from '../lib/restTimerDurable';
import {
  canonicalizeEndpointBaseUrl,
  streamCoachTurn,
  type CoachCitation,
  type CoachContentPart,
  type CoachProviderConfig,
  type CoachStreamOutcomeKind,
  type CoachThinkingDepth,
  type CoachTokenUsage,
  type CoachToolCall,
  type CoachTurnMessage,
} from './providerAdapter';
import {
  computeDeploymentId,
  resolveProviderCapabilities,
  type ProviderDeploymentCapabilities,
} from './providerCapabilities';

export interface RunCoachTurnParams {
  threadId?: string;
  userText: string;
  attachments?: CoachStoredAttachment[];
  history: CoachStoredMessage[];
  contextSummary?: string;
  thinkingDepth?: CoachThinkingDepth;
  webSearch?: boolean;
  providerConfig?: CoachStoredProviderConfig | null;
  toolContext: CoachToolExecutionContext;
  signal?: AbortSignal;
  /** 仅测试快速完结流时传 0；UI 交互默认按 35ms 分片流式输出以便支持中途取消 */
  streamChunkDelayMs?: number;
  onTextChunk?: (accumulatedText: string) => void;
  onReasoningChunk?: (accumulatedReasoning: string) => void;
  onReceipt?: (receipt: CoachOperationReceipt) => void;
  onUsage?: (usage: CoachTokenUsage) => void;
  onCitations?: (citations: CoachCitation[]) => void;
  requestTitle?: boolean;
  onTitle?: (title: string) => void;
  onThinkingFallback?: () => void;
  onDraftPlan?: (draft: CoachPlanDraft) => void;
  onBillingRecord?: (record: CoachBillingRecord) => void;
  onSegmentChanged?: (segment: CoachSegmentState) => void;
  onPendingTurnChange?: (pending: CoachPendingTurn | null) => void;
  onCompactionApplied?: (info: { compressedCount: number; summary: string; reason: string }) => void;
}

export interface RunCoachTurnResult {
  text: string;
  reasoning?: string;
  receipts: CoachOperationReceipt[];
  draftPlan?: CoachPlanDraft;
  usage?: CoachTokenUsage;
  citations?: CoachCitation[];
  aborted: boolean;
  blockedByUnclosedBatch?: boolean;
  unclosedBatchSegmentId?: string;
  outcomeKind?: CoachStreamOutcomeKind;
  errorMessage?: string;
  segmentId?: string;
  billingRecords?: CoachBillingRecord[];
  pendingTurn?: CoachPendingTurn;
}

function abortError(): Error {
  const err = new Error('已取消生成');
  err.name = 'AbortError';
  return err;
}

async function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const id = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function emitStreamedText(
  fullText: string,
  chunkDelayMs: number,
  signal: AbortSignal | undefined,
  onTextChunk?: (accumulatedText: string) => void,
  minChunks = 6,
): Promise<string> {
  if (chunkDelayMs <= 0 || fullText.length <= 16) {
    if (signal?.aborted) throw abortError();
    onTextChunk?.(fullText);
    return fullText;
  }
  const targetChunks = Math.max(minChunks, Math.min(12, Math.ceil(fullText.length / 8)));
  const chunkSize = Math.max(1, Math.ceil(fullText.length / targetChunks));
  let built = '';
  for (let i = 0; i < fullText.length; i += chunkSize) {
    if (signal?.aborted) throw abortError();
    built += fullText.slice(i, i + chunkSize);
    onTextChunk?.(built);
    if (i + chunkSize < fullText.length) {
      await sleepAbortable(chunkDelayMs, signal);
    }
  }
  return built;
}

const INFO_QUERY_TARGET_RE = /(热身|warmup|有氧|cardio|跑步机|椭圆机|划船机|登山|单车|器械档位|档位备忘|setupNote)/i;
const MUTATION_VERB_RE = /(改|调|设|加|添|删|去|减|写|记|换|开启|开始|暂停|继续|完成|结束|更新|勾选|打勾)/;
const FINISH_SESSION_RE =
  /^(?:帮我|请)?(?:现在|直接)?(?:结束|完成)(?:这|本|当)?(?:场|次)?训练[。！!]?$|^(?:帮我|请)?(?:现在|直接)?结束本次训练/i;
const MEMORY_SAVE_RE = /^(?:帮我|请)?记住[：:，,\s]+(.+)$/;
const SETUP_NOTE_RE = /(器械档位|档位备忘|座椅档位|pin位|setupNote)/i;
const CARDIO_RE = /(有氧|跑步机|椭圆机|划船机|登山机|动感单车|室内自行车|单车|跳绳|HIIT)/i;
const ACTIVE_NOTE_RE = /(?:加餐|加个?备注|写个?备注|记个?备注|备注(?:改为|写为|设为|[:：]))/;
const FORM_CONVERT_RE =
  /(?:改为|改成|切换成|转成|变为|换成)\s*(普通组|递减组|超级组|21响礼炮)/;
const EXERCISE_REPLACE_RE =
  /(?:把|将)?\s*([^\s，,。！？!]+?(?:[^\n，,。！？!]{0,18}?))\s*(?:替换为|替换成|换成)\s*([^\n，,。！？!]+)/;
const TARGET_ADJUST_RE =
  /(下一组|目标|改为\s*\d+\s*组|调整.{0,12}?(?:组|次|kg)|休息(?:时间|时长)?(?:调到|改为|设为|改到)?\s*\d+\s*(?:秒|s|分钟))/i;
const SET_RECORD_RE =
  /(?:刚才|刚完成|做完|推了|拉了|蹲了|第\s*\d+\s*组).{0,20}?(?:\d+\s*次|\d+(?:\.\d+)?\s*kg)|(?:第\s*\d+\s*组).{0,10}?(?:改成|改为|记为|记作|做了)\s*(?:\d+|空|null)/i;
const SUPERSET_RE = /(超级组|配对|拆散|解除配对)/i;
const SYNC_PLAN_RE = /(同步回|更新原计划|仅改本次|仅保留本次)/i;
const HISTORY_EDIT_RE = /(历史|上次|上一次|那次|上回).{0,20}?(?:改成|纠错|修改|备注|补加|补记|补一组)/i;
const HISTORY_QUERY_RE = /(第\s*\d+\s*次|最老|最早|共多少次|全部历史|历史记录|上次.*(?:多少|怎么))/i;

function findNamedExercise(
  exercises: Array<{ id: string; name: string; sets?: Array<{ status: string }> }>,
  text: string,
): { id: string; name: string } | undefined {
  const lower = text.toLowerCase();
  const matches = exercises.filter((e) => lower.includes(e.name.trim().toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches.sort((a, b) => b.name.length - a.name.length)[0];
  // 常见简称兜底匹配
  for (const ex of exercises) {
    const tokens = ex.name
      .replace(/(平板|上斜|下斜|坐姿|站姿|哑铃|杠铃|器械)/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length >= 2);
    if (tokens.some((tok) => lower.includes(tok.toLowerCase()))) return ex;
  }
  if (exercises.length === 1) return exercises[0];
  // 多动作场景下用户说“刚才那组/下一组”且未点名时：若恰好只有 1 个“已开始但未全部完成”的进行中动作，自动定位它
  if (/(刚才|那组|下一组|当前)/.test(text)) {
    const inProgress = exercises.filter(
      (e) =>
        e.sets?.some((s) => s.status === 'done' || s.status === 'partial') &&
        e.sets?.some((s) => s.status === 'blank'),
    );
    if (inProgress.length === 1) return inProgress[0];
  }
  return undefined;
}

function makeLocalToolCall(name: string, args: Record<string, unknown>): CoachToolCall {
  return {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    argumentsText: JSON.stringify(args),
    arguments: args,
  };
}

function parseNumberAfter(text: string, re: RegExp): number | undefined {
  const m = text.match(re);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function detectRequestedForm(text: string): 'straight' | 'dropSet' | 'superset' | undefined {
  if (/21响礼炮|递减组/.test(text)) return 'dropSet';
  if (/超级组/.test(text)) return 'superset';
  if (/普通组/.test(text)) return 'straight';
  return undefined;
}

function detectCardioPresetFromText(text: string): string {
  if (/椭圆/.test(text)) return 'elliptical';
  if (/划船/.test(text)) return 'rowing-machine';
  if (/登山|爬楼/.test(text)) return 'stair-climber';
  if (/单车|自行车/.test(text)) return 'stationary-bike';
  if (/跳绳|hiit|间歇|自由有氧/i.test(text)) return 'free-cardio';
  return 'treadmill-incline';
}

async function runDeterministicLocalTurn(
  params: RunCoachTurnParams,
): Promise<RunCoachTurnResult> {
  const { userText, attachments, toolContext, signal, streamChunkDelayMs = 38 } = params;
  const receipts: CoachOperationReceipt[] = [];
  let draftPlan: CoachPlanDraft | undefined;

  const trimmed = userText.trim();
  const hasVideo = Boolean(attachments?.some((a) => a.kind === 'video'));
  const hasImage = Boolean(attachments?.some((a) => a.kind !== 'video'));

  // 0. 离线引擎不支持视频帧解析，引导切换多模态模型
  if (hasVideo) {
    const vid = attachments?.find((a) => a.kind === 'video');
    const text = await emitStreamedText(
      `收到视频「${vid?.name || '训练视频'}」。本地离线模式没法看视频画面，去设置里配一个支持视频的模型再发给我就行。`,
      streamChunkDelayMs,
      signal,
      params.onTextChunk,
    );
    return { text, receipts, aborted: false };
  }

  // 1. 识图新建计划草稿（先解析草稿卡片，确认后落盘）
  if (hasImage && attachments?.length) {
    const draft = extractPlanDraftFromImage(attachments[0], trimmed);
    draftPlan = draft;
    params.onDraftPlan?.(draft);
    const lines = draft.days
      .flatMap((d) =>
        d.exercises.map(
          (e) =>
            `· ${e.name}：${e.sets} 组 × ${e.repsMin}-${e.repsMax} 次${e.suggestedWeightKg !== null ? `（${e.suggestedWeightKg}kg）` : ''}`,
        ),
      )
      .join('\n');
    const text = await emitStreamedText(
      `已提取「${draft.planName}」草稿：\n${lines}\n核对或改完直接点下方「确认新建计划」。`,
      streamChunkDelayMs,
      signal,
      params.onTextChunk,
    );
    return { text, receipts, draftPlan, aborted: false };
  }

  const roCtx = await buildCoachReadOnlyContext(toolContext, {
    includeAllHistory: HISTORY_QUERY_RE.test(trimmed) || HISTORY_EDIT_RE.test(trimmed),
    historyLimit: 10,
  });

  // 2. 记忆写入（Hermes）
  const memMatch = trimmed.match(MEMORY_SAVE_RE);
  if (memMatch) {
    const body = memMatch[1].trim();
    const category = /伤|痛|不舒服|康复|拉伤/.test(body)
      ? 'injury'
      : /器械|龙门架|哑铃|杠铃|档位|健身房/.test(body)
        ? 'equipment'
        : /身高|体重|年龄|体脂/.test(body)
          ? 'profile'
          : 'preference';
    const outcome = await executeCoachToolCall(
      makeLocalToolCall('manage_coach_memory', {
        action: 'save',
        category,
        title: body.slice(0, 18),
        content: body,
      }),
      toolContext,
    );
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 3. 直接结束当前训练
  if (FINISH_SESSION_RE.test(trimmed)) {
    if (!roCtx.activeSession) {
      const text = await emitStreamedText('现在没有正在进行的训练。', streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
    const outcome = await executeCoachToolCall(
      makeLocalToolCall('finish_active_session', {
        sessionId: roCtx.activeSession.id,
        syncBackToPlanDay: /同步回/.test(trimmed),
      }),
      toolContext,
    );
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 4. 器械档位备忘更新（可跨计划）
  if (SETUP_NOTE_RE.test(trimmed) && MUTATION_VERB_RE.test(trimmed) && !HISTORY_EDIT_RE.test(trimmed)) {
    const noteMatch = trimmed.match(/(?:改为|改成|写为|写成|设为|设成|记为|记成|调成|调到|[:：])\s*([^\n]+)$/);
    const noteVal = (noteMatch?.[1] ?? trimmed).replace(/[。！!]+$/, '').trim();
    const targetExercises = roCtx.activeSession?.exercises ?? [];
    const exMatch = findNamedExercise(targetExercises, trimmed);
    if (noteVal) {
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('update_setup_note', {
          ...(roCtx.activeSession ? { sessionId: roCtx.activeSession.id } : {}),
          ...(exMatch ? { exId: exMatch.id, exerciseName: exMatch.name } : {}),
          note: noteVal,
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 5. 进行中备注写入（优先于热身/有氧正则，防止备注内容含“热身/跑步机”等词被误分流）
  if (roCtx.activeSession && ACTIVE_NOTE_RE.test(trimmed) && !HISTORY_EDIT_RE.test(trimmed) && !SETUP_NOTE_RE.test(trimmed)) {
    const exMatch = findNamedExercise(roCtx.activeSession.exercises, trimmed);
    const round = parseNumberAfter(trimmed, /第\s*(\d+)\s*组/);
    const noteMatch = trimmed.match(/(?:备注(?:改为|改成|写为|写成|设为|设成|[:：])|写个?备注[:：\s]*|加个?备注[:：\s]*|记个?备注[:：\s]*)(.+)$/);
    const noteText = (noteMatch?.[1] ?? trimmed).trim();
    const scope = round !== undefined && exMatch ? 'set' : exMatch ? 'exercise' : 'session';
    const outcome = await executeCoachToolCall(
      makeLocalToolCall('update_active_note', {
        sessionId: roCtx.activeSession.id,
        scope,
        ...(exMatch ? { exId: exMatch.id } : {}),
        ...(round !== undefined ? { roundIndex: round } : {}),
        note: noteText,
        append: /加餐|追加|补充/.test(trimmed),
      }),
      toolContext,
    );
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 6. 热身写入（勾选完成 / 新增 / 修改 / 删除）
  if (roCtx.activeSession && /热身/.test(trimmed) && MUTATION_VERB_RE.test(trimmed) && !HISTORY_EDIT_RE.test(trimmed) && !ACTIVE_NOTE_RE.test(trimmed)) {
    const matchedWarmup = roCtx.activeSession.warmups.find((w) =>
      trimmed.toLowerCase().includes(w.name.trim().toLowerCase()),
    ) ?? roCtx.activeSession.warmups[0];
    let action: 'toggle_done' | 'add' | 'update' | 'remove' = 'toggle_done';
    if (/添加|新增|加上/.test(trimmed)) action = 'add';
    else if (/删除|去掉|移除/.test(trimmed)) action = 'remove';
    else if (/改成|改为|修改|调整/.test(trimmed)) action = 'update';

    const args: Record<string, unknown> = {
      sessionId: roCtx.activeSession.id,
      action,
    };
    if (action === 'toggle_done') {
      if (matchedWarmup) args.warmupId = matchedWarmup.id;
      args.done = !/取消|未完成/.test(trimmed);
    } else if (action === 'add') {
      const namePart = trimmed.match(/(?:添加|新增|加上)热身(?:项)?[：:\s]*([^\d，,。]+)/)?.[1]?.trim() || '动态拉伸';
      const targetMatch = trimmed.match(/(\d+\s*(?:分钟|秒|次))/);
      args.name = namePart;
      args.unit = /秒|分钟/.test(targetMatch?.[1] ?? '') ? 'time' : 'reps';
      args.targetText = targetMatch?.[1]?.replace(/\s+/g, '') || '5分钟';
    } else if (matchedWarmup) {
      args.warmupId = matchedWarmup.id;
      if (action === 'update') {
        const targetMatch = trimmed.match(/(\d+\s*(?:组|轮|分钟|秒|次))/);
        if (targetMatch) args.targetText = targetMatch[1].replace(/\s+/g, '');
      }
    }
    const outcome = await executeCoachToolCall(makeLocalToolCall('manage_active_warmup', args), toolContext);
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 6. 有氧操作（进行中或历史）
  if (CARDIO_RE.test(trimmed) && MUTATION_VERB_RE.test(trimmed)) {
    const latestHist = roCtx.historySessions[0];
    const firstHistCardio = latestHist?.cardioEntries?.[0];
    if (HISTORY_EDIT_RE.test(trimmed) && latestHist && firstHistCardio) {
      const mins = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*分钟/);
      const secs = parseNumberAfter(trimmed, /(\d+)\s*秒/);
      const durationSec = mins !== undefined ? Math.round(mins * 60) : secs;
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('correct_history_session', {
          sessionId: latestHist.id,
          action: 'correct_cardio',
          cardioId: firstHistCardio.id,
          ...(durationSec !== undefined ? { durationSec } : {}),
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
    if (roCtx.activeSession) {
      const preset = detectCardioPresetFromText(trimmed);
      const existing = roCtx.activeSession.cardioEntries.find((c) => c.preset === preset)
        ?? roCtx.activeSession.cardioEntries[0];
      let action: 'add' | 'update_params' | 'start' | 'pause' | 'resume' | 'complete' | 'remove' = 'add';
      if (/开始/.test(trimmed) && existing) action = 'start';
      else if (/暂停/.test(trimmed) && existing) action = 'pause';
      else if (/继续/.test(trimmed) && existing) action = 'resume';
      else if (/完成|结束/.test(trimmed) && existing) action = 'complete';
      else if (/删除|去掉|移除/.test(trimmed) && existing) action = 'remove';
      else if (existing && /改|调|设/.test(trimmed)) action = 'update_params';

      const mins = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*分钟/);
      const speed = parseNumberAfter(trimmed, /速度\s*(\d+(?:\.\d+)?)/);
      const incline = parseNumberAfter(trimmed, /坡度\s*(\d+(?:\.\d+)?)/);
      const cardioParams: Record<string, unknown> = {
        ...(mins !== undefined ? { targetMinutes: Math.round(mins) } : {}),
        ...(speed !== undefined ? { speedKmh: speed } : {}),
        ...(incline !== undefined ? { inclinePct: incline } : {}),
      };
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('manage_active_cardio', {
          sessionId: roCtx.activeSession.id,
          action,
          ...(existing ? { cardioId: existing.id } : {}),
          preset,
          ...(Object.keys(cardioParams).length ? { params: cardioParams } : {}),
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 7. 完训同步 vs 仅改本次训练
  if (SYNC_PLAN_RE.test(trimmed)) {
    const targetSession = roCtx.activeSession ?? roCtx.historySessions[0];
    if (!targetSession) {
      const text = await emitStreamedText('当前没有可同步编排的训练记录。', streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
    const isSessionOnly = /仅改本次|仅保留本次/.test(trimmed);
    const outcome = await executeCoachToolCall(
      makeLocalToolCall('sync_session_to_plan', {
        sessionId: targetSession.id,
        scope: isSessionOnly ? 'session-only' : 'sync-to-plan',
      }),
      toolContext,
    );
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 9. 进行中组型转换或动作替换（含 器械二头 -> 21响礼炮、普通/递减/超级组转换）
  if (roCtx.activeSession) {
    const replaceMatch = trimmed.match(EXERCISE_REPLACE_RE);
    if (replaceMatch && !/第\s*\d+\s*组/.test(trimmed) && !/\d+\s*(?:次|kg)/i.test(replaceMatch[2].trim())) {
      const fromText = replaceMatch[1];
      const toText = replaceMatch[2].replace(/(试试|吧|哦|呀)$/, '').trim();
      const exMatch = findNamedExercise(roCtx.activeSession.exercises, fromText);
      const requestedForm = detectRequestedForm(toText);
      if (exMatch && requestedForm && /^(普通组|递减组|超级组)$/.test(toText)) {
        const outcome = await executeCoachToolCall(
          makeLocalToolCall('manage_active_exercise', {
            sessionId: roCtx.activeSession.id,
            mode: 'convert_form',
            exId: exMatch.id,
            form: requestedForm,
          }),
          toolContext,
        );
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
        }
        const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
        return { text, receipts, aborted: false };
      }
      if (exMatch && toText) {
        const outcome = await executeCoachToolCall(
          makeLocalToolCall('manage_active_exercise', {
            sessionId: roCtx.activeSession.id,
            mode: 'replace',
            exId: exMatch.id,
            newName: toText,
            ...(requestedForm ? { form: requestedForm } : {}),
            ...( /覆盖|强行/.test(trimmed) ? { allowDiscardLoggedData: true } : {}),
          }),
          toolContext,
        );
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
        }
        const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
        return { text, receipts, aborted: false };
      }
    }

    const convertMatch = trimmed.match(FORM_CONVERT_RE);
    if (convertMatch && !SUPERSET_RE.test(trimmed)) {
      const exMatch = findNamedExercise(roCtx.activeSession.exercises, trimmed);
      const requestedForm = detectRequestedForm(convertMatch[1]);
      if (exMatch && requestedForm) {
        const outcome = await executeCoachToolCall(
          makeLocalToolCall('manage_active_exercise', {
            sessionId: roCtx.activeSession.id,
            mode: 'convert_form',
            exId: exMatch.id,
            form: requestedForm,
          }),
          toolContext,
        );
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
        }
        const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
        return { text, receipts, aborted: false };
      }
    }
  }

  // 10. 超级组配对 / 拆散
  if (SUPERSET_RE.test(trimmed) && roCtx.activeSession) {
    const matched = roCtx.activeSession.exercises.filter((e) =>
      trimmed.toLowerCase().includes(e.name.trim().toLowerCase()),
    );
    const isUnpair = /拆散|解除|取消/.test(trimmed);
    if (matched.length >= 2 || (isUnpair && matched.length >= 1)) {
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('configure_superset', {
          sessionId: roCtx.activeSession.id,
          mode: isUnpair ? 'unpair' : 'pair',
          exIds: matched.map((m) => m.id),
          expectedRevision: roCtx.activeSession.revision,
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 11. 历史纠错（含补加一组与备注）
  if (HISTORY_EDIT_RE.test(trimmed) && roCtx.historySessions.length > 0) {
    const latestHist = roCtx.historySessions[0];
    const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
    const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
    const round = parseNumberAfter(trimmed, /第\s*(\d+)\s*组/);
    const exMatch = findNamedExercise(latestHist.exercises, trimmed);
    if (exMatch && /补加|补记|补一组|加一组/.test(trimmed)) {
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('correct_history_session', {
          sessionId: latestHist.id,
          action: 'append_group',
          exId: exMatch.id,
          ...(reps !== undefined ? { reps } : {}),
          ...(weight !== undefined ? { weightKg: weight } : {}),
          status: reps !== undefined ? 'done' : 'blank',
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
    if (exMatch && (reps !== undefined || weight !== undefined)) {
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('correct_history_session', {
          sessionId: latestHist.id,
          action: 'correct_set',
          exId: exMatch.id,
          ...(round !== undefined ? { roundIndex: round } : {}),
          ...(reps !== undefined ? { reps } : {}),
          ...(weight !== undefined ? { weightKg: weight } : {}),
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 12. 进行中目标调整（包含 restSec 休息秒数，不标 done、不触发计时器）
  if (roCtx.activeSession && TARGET_ADJUST_RE.test(trimmed) && !/做完|推了|拉了|蹲了|刚才/.test(trimmed)) {
    const ex = findNamedExercise(roCtx.activeSession.exercises, trimmed);
    if (ex) {
      const sets = parseNumberAfter(trimmed, /(\d+)\s*组/);
      const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
      const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
      const restSecDirect = parseNumberAfter(trimmed, /(\d+)\s*(?:秒|s)\b/i);
      const restMin =
        parseNumberAfter(trimmed, /(\d+)\s*分钟休息/) ??
        parseNumberAfter(trimmed, /休息(?:时间|时长)?\s*(?:调到|改为|设为|改到)?\s*(\d+)\s*分钟/);
      const restSec = restSecDirect ?? (restMin !== undefined ? restMin * 60 : undefined);
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('adjust_active_target', {
          sessionId: roCtx.activeSession.id,
          exId: ex.id,
          expectedRevision: roCtx.activeSession.revision,
          ...(sets !== undefined && !/下一组/.test(trimmed) ? { sets } : {}),
          ...(reps !== undefined ? { repsMin: reps, repsMax: reps } : {}),
          ...(weight !== undefined ? { suggestedWeightKg: weight } : {}),
          ...(restSec !== undefined ? { restSec } : {}),
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const text = await emitStreamedText(outcome.summary, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 13. 进行中逐组实绩记录 / 纠正
  if (roCtx.activeSession && SET_RECORD_RE.test(trimmed)) {
    const ex = findNamedExercise(roCtx.activeSession.exercises, trimmed);
    if (ex) {
      const round = parseNumberAfter(trimmed, /第\s*(\d+)\s*组/);
      const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
      const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
      const emptyRepsRequested = /改为\s*空|清空次数|记为\s*空/.test(trimmed);
      const noteMatch = trimmed.match(/备注[:：\s]*(.+)$/);
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('record_active_set', {
          sessionId: roCtx.activeSession.id,
          exId: ex.id,
          expectedRevision: roCtx.activeSession.revision,
          ...(round !== undefined ? { roundIndex: round } : {}),
          ...(emptyRepsRequested ? { reps: null } : reps !== undefined ? { reps } : {}),
          ...(weight !== undefined ? { weightKg: weight } : {}),
          ...(noteMatch ? { note: noteMatch[1].trim() } : {}),
          status: 'done',
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const reply = outcome.ok
        ? `${outcome.summary}${outcome.data?.timerStarted ? '，已开始休息计时。' : '。'}`
        : `没写入成功：${outcome.summary}`;
      const text = await emitStreamedText(reply, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 14. 全量历史查询 / 复盘
  if (HISTORY_QUERY_RE.test(trimmed)) {
    const oldest = roCtx.historySessions[roCtx.historySessions.length - 1];
    const nthMatch = parseNumberAfter(trimmed, /第\s*(\d+)\s*次/);
    const nthItem = nthMatch ? roCtx.historySessions[nthMatch - 1] : undefined;
    const picked = nthItem ?? oldest;
    const summaryReply = picked
      ? `共查到 ${roCtx.totalCompletedSessions} 条已完成训练，${nthItem ? `第 ${nthMatch} 条` : '最早一条'}是「${picked.dayName}」，完成 ${picked.completedSets} 组（${picked.exercises.map((e) => `${e.name}${e.maxWeightKg !== null ? ` ${e.maxWeightKg}kg` : ''}`).join('、')}）。`
      : '目前还没有已完成的历史训练记录。';
    const text = await emitStreamedText(summaryReply, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 15. 热身 / 有氧 / 器械档位查询（未带修改动词时展示当前信息）
  if (INFO_QUERY_TARGET_RE.test(trimmed)) {
    const warmupsSummary = roCtx.activeSession?.warmups.length
      ? roCtx.activeSession.warmups.map((w) => `${w.name}(${w.targetText}${w.done ? '，已完成' : ''})`).join('、')
      : '本次无热身项';
    const setupList = roCtx.activeSession?.exercises
      .filter((e) => e.setupNote)
      .map((e) => `${e.name}：${e.setupNote}`)
      .join('；');
    const presetsList = roCtx.cardioPresets.map((c) => c.label).join('、');
    const text = await emitStreamedText(
      `当前训练情况：\n· 热身：${warmupsSummary}\n· 器械档位备忘：${setupList || '暂无'}\n· 6 种有氧预设：${presetsList}（都可以直接让我帮你改）`,
      streamChunkDelayMs,
      signal,
      params.onTextChunk,
    );
    return { text, receipts, aborted: false };
  }

  // 16. 默认对话回复
  const activeHint = roCtx.activeSession
    ? `当前练到「${roCtx.activeSession.dayName}」（${roCtx.activeSession.exercises.length} 个动作）。`
    : '当前没有进行中的训练。';
  const replyText =
    `${activeHint}直接跟我说记录、换动作、改组数或补备注就行，比如「卧推第 2 组 60kg 做了 11 次」或「把器械二头换成 21响礼炮」。`;
  const text = await emitStreamedText(
    replyText,
    streamChunkDelayMs > 0 ? Math.max(streamChunkDelayMs, 145) : 0,
    signal,
    params.onTextChunk,
    12,
  );
  return { text, receipts, aborted: false };
}

function toProviderConfig(cfg: CoachStoredProviderConfig): CoachProviderConfig {
  return {
    kind: cfg.kind,
    presetId: cfg.presetId,
    deploymentId: cfg.deploymentId,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
  };
}

export function buildCoachSystemPrompt(
  roCtx: CoachReadOnlyContext,
  memoryPrompt: string,
  contextSummary?: string,
): string {
  const recentHistory = roCtx.historySessions.slice(0, 3).map((s) => ({
    id: s.id,
    dayName: s.dayName,
    planId: s.planId,
    completedSets: s.completedSets,
    note: s.note,
    canSyncToPlan: s.canSyncToPlan,
    ...(s.syncDiffSummary ? { syncDiffSummary: s.syncDiffSummary } : {}),
    cardioEntries: s.cardioEntries,
    exercises: s.exercises.map((e) => ({
      id: e.id,
      name: e.name,
      form: e.form,
      restSec: e.restSec,
      setsCount: e.setsCount,
      note: e.note,
      sets: e.sets,
    })),
  }));

  const plansOverview = roCtx.plans.map((p) => ({
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    days: p.days.map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
  }));

  return [
    STATIC_COACH_SYSTEM_PROMPT,
    ...(memoryPrompt.trim() ? ['', '用户长期记忆（跨会话保留）：', memoryPrompt.trim()] : []),
    ...(contextSummary?.trim() ? ['', `早期对话上下文摘要：${contextSummary.trim()}`] : []),
    '',
    `当前上下文JSON：${JSON.stringify({
      activeSession: roCtx.activeSession,
      cardioPresets: roCtx.cardioPresets.map((c) => ({ preset: c.preset, label: c.label })),
      plans: plansOverview,
      recentHistory,
      totalCompletedSessions: roCtx.totalCompletedSessions,
    })}`,
  ].join('\n');
}

const segmentCheckpointCache = new Map<string, CoachSegmentCheckpoint>();
const lastWireStateBySegment = new Map<string, { msgCount: number; fullDigest: string }>();
let memoryPurgeGeneration = 0;
const recentPurgeEvents: Array<{ gen: number; needles: string[]; memoryId?: string }> = [];

const SEARCH_INTENT_RE =
  /查一下|搜索|搜一下|联网|百科|怎么做|怎么练|如何练|动作要点|姿势|注意事项|营养|热量|碳水|蛋白|科普|区别|研究|文献|标准动作|指南|推荐吃|21响/;

const EXPLICIT_NO_SEARCH_RE =
  /(?:不用|不要|无需|勿需|不必|不需要|别|切勿|禁止|停止|关闭|关掉|取消|先不|暂不|不需)(?:再去|去)?(?:联网|上网|联机|外部搜索|网页搜索|在线搜索|网络搜索|全网搜索|联网搜索|联网查|上网查|搜索|检索)/;

export function isExplicitNoSearchCommand(userText: string): boolean {
  return EXPLICIT_NO_SEARCH_RE.test(userText.trim());
}

export function shouldRunIndependentSearch(userText: string): boolean {
  const trimmed = userText.trim();
  if (!trimmed || isExplicitNoSearchCommand(trimmed)) return false;
  return SEARCH_INTENT_RE.test(trimmed);
}

/**
 * 若 Vault 中已有持久化 billingTotals 仍属于旧口径（未升级至 summarySchemaVersion=2），
 * 则基于 billingLedger 真实账单列表重算并回写，避免本次会话展示永久沿用受污染的旧缓存。
 */
export async function reconcileStaleBillingTotalsInVault(): Promise<{
  changed: boolean;
  state: Awaited<ReturnType<typeof loadCoachThreadsState>>;
}> {
  const initial = await loadCoachThreadsState();
  const updates = new Map<string, CoachThreadBillingTotalsCache>();
  for (const t of initial.threads) {
    if (!t.billingTotals || t.billingTotals.summarySchemaVersion === 2) continue;
    const records = await listBillingRecords(t.id);
    if (!records.length) continue;
    updates.set(t.id, billingTotalsFromRecords(records));
  }
  if (!updates.size) {
    return { changed: false, state: initial };
  }
  const patched = await patchCoachThreadsState((latest) => ({
    ...latest,
    threads: latest.threads.map((t) => {
      const nextTotals = updates.get(t.id);
      if (!nextTotals || (t.billingTotals && t.billingTotals.summarySchemaVersion === 2)) {
        return t;
      }
      return { ...t, billingTotals: nextTotals };
    }),
  }));
  return { changed: true, state: patched };
}

function buildSearchQueryFromUserText(userText: string): string {
  const clean = userText
    .replace(/sess-[\w-]+|plan-[\w-]+|ex-[\w-]+|set-[\w-]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, 120);
}

async function collectGeminiGroundedBrief(
  providerCfg: CoachProviderConfig,
  query: string,
  caps: ProviderDeploymentCapabilities,
  signal: AbortSignal | undefined,
  onCitations?: (citations: CoachCitation[]) => void,
  onUsage?: (usage: CoachTokenUsage) => void,
  citationsByUrl?: Map<string, CoachCitation>,
): Promise<{ brief: string; rawUsage?: Record<string, unknown> }> {
  const groundedMessages: CoachTurnMessage[] = [
    {
      role: 'system',
      text: '请只针对用户当前健身/营养/动作问题做简短准确的联网检索与客观要点提炼（不超过 360 字），不要编造。',
    },
    {
      role: 'user',
      parts: [{ type: 'text', text: query }],
    },
  ];
  let brief = '';
  let rawUsage: Record<string, unknown> | undefined;
  for await (const ev of streamCoachTurn(providerCfg, groundedMessages, [], {
    signal,
    thinkingDepth: 'off',
    webSearch: true,
    includeUsage: true,
    capabilities: caps,
  })) {
    if (ev.type === 'text_delta') {
      brief += ev.delta;
    } else if (ev.type === 'done') {
      rawUsage = ev.rawUsage;
      if (ev.usage) onUsage?.(ev.usage);
      if (ev.citations?.length) {
        if (citationsByUrl) {
          for (const c of ev.citations) citationsByUrl.set(c.url, c);
          onCitations?.(Array.from(citationsByUrl.values()));
        } else {
          onCitations?.(ev.citations);
        }
      }
    }
  }
  return { brief: brief.trim(), rawUsage };
}

function protocolEntryToTurnMessage(entry: CoachProtocolEntry): CoachTurnMessage | null {
  if (entry.quarantinedFromReplay || entry.isControlMarker) {
    return null;
  }
  if (entry.kind === 'user') {
    const parts: CoachContentPart[] = [];
    if (entry.wireText) parts.push({ type: 'text', text: entry.wireText });
    if (!entry.mediaStripped && entry.attachments?.length) {
      for (const att of entry.attachments) {
        if (!att.dataBase64) continue;
        parts.push({
          type: att.kind === 'video' ? 'video' : 'image',
          mimeType: att.mimeType,
          dataBase64: att.dataBase64,
        });
      }
    }
    if (!parts.length) parts.push({ type: 'text', text: '（用户附件回合）' });
    return { role: 'user', parts };
  }
  if (entry.kind === 'assistant') {
    return {
      role: 'assistant',
      text: entry.assistantText ?? '',
      ...(entry.reasoningText !== undefined ? { reasoning: entry.reasoningText } : {}),
      ...(entry.toolCalls?.length
        ? {
            toolCalls: entry.toolCalls.map((tc): CoachToolCall => ({
              id: tc.id,
              index: tc.index,
              name: tc.name,
              argumentsText: tc.argumentsText,
              arguments: (() => {
                try {
                  return JSON.parse(tc.argumentsText) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })(),
              ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            })),
          }
        : {}),
      ...(entry.anthropicBlocks ? { anthropicBlocks: entry.anthropicBlocks } : {}),
      ...(entry.geminiParts ? { geminiParts: entry.geminiParts } : {}),
    };
  }
  if (entry.kind === 'tool') {
    return {
      role: 'tool',
      toolCallId: entry.toolCallId ?? '',
      name: entry.toolName ?? '',
      content: entry.toolResultText ?? '{}',
      ...(entry.toolError ? { isError: true } : {}),
    };
  }
  return null;
}

export type CoachToolPairingIssueKind =
  | 'unclosed_tool_batch'
  | 'stray_tool_result'
  | 'malformed_tool_batch';

export interface CoachToolPairingValidationResult {
  ok: boolean;
  reason?: string;
  issueKind?: CoachToolPairingIssueKind;
  assistantEntrySeq?: number;
  assistantEntryId?: string;
  expectedCallIds?: string[];
  presentCallIds?: string[];
  missingCallIds?: string[];
  strayCallIds?: string[];
  affectedSeqs?: number[];
}

interface PairingSequenceItem {
  message: CoachTurnMessage;
  entry?: CoachProtocolEntry;
}

function extractAssistantExpectedToolCallIds(
  msg: Extract<CoachTurnMessage, { role: 'assistant' }>,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const tcCalls = msg.toolCalls ?? [];
  const tcIds: string[] = [];
  const tcSeen = new Set<string>();
  for (let i = 0; i < tcCalls.length; i += 1) {
    const id = typeof tcCalls[i]?.id === 'string' ? tcCalls[i].id.trim() : '';
    if (!id) {
      return { ok: false, reason: `assistant 消息第 ${i + 1} 个工具调用缺少调用 ID` };
    }
    if (tcSeen.has(id)) {
      return { ok: false, reason: `assistant 消息包含重复工具调用 ID: ${id}` };
    }
    tcSeen.add(id);
    tcIds.push(id);
  }

  const antIds: string[] = [];
  if (Array.isArray(msg.anthropicBlocks) && msg.anthropicBlocks.length > 0) {
    const antSeen = new Set<string>();
    for (const block of msg.anthropicBlocks) {
      if (!block || typeof block !== 'object') {
        return { ok: false, reason: 'assistant anthropicBlocks 包含非法块结构' };
      }
      if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id.trim() : '';
        const name = typeof block.name === 'string' ? block.name.trim() : '';
        if (!id || !name) {
          return { ok: false, reason: 'anthropicBlocks tool_use 块缺少 id 或 name' };
        }
        if (antSeen.has(id)) {
          return { ok: false, reason: `anthropicBlocks 包含重复的 tool_use id: ${id}` };
        }
        antSeen.add(id);
        antIds.push(id);
      }
    }
    if (tcIds.length > 0) {
      if (antIds.length !== tcIds.length || antIds.some((id, idx) => id !== tcIds[idx])) {
        return { ok: false, reason: 'anthropicBlocks tool_use 与 toolCalls 调用 ID 列表不一致' };
      }
    }
  }

  const gemIds: string[] = [];
  if (Array.isArray(msg.geminiParts) && msg.geminiParts.length > 0) {
    const fcParts = msg.geminiParts.filter(
      (p) => p && typeof p === 'object' && 'functionCall' in p && p.functionCall !== undefined,
    );
    const gemSeen = new Set<string>();
    for (let idx = 0; idx < fcParts.length; idx += 1) {
      const fc = fcParts[idx].functionCall as { id?: unknown; name?: unknown } | undefined;
      if (!fc || typeof fc.name !== 'string' || !fc.name.trim()) {
        return { ok: false, reason: 'geminiParts functionCall 缺少合法函数名' };
      }
      const fcId = typeof fc.id === 'string' ? fc.id.trim() : '';
      if (fcId) {
        if (gemSeen.has(fcId)) {
          return { ok: false, reason: `geminiParts 包含重复的 functionCall id: ${fcId}` };
        }
        gemSeen.add(fcId);
        gemIds.push(fcId);
      }
    }
    if (tcIds.length > 0) {
      if (fcParts.length !== tcIds.length) {
        return { ok: false, reason: 'geminiParts functionCall 数量与 toolCalls 不一致' };
      }
      for (let idx = 0; idx < fcParts.length; idx += 1) {
        const fc = fcParts[idx].functionCall as { id?: unknown } | undefined;
        const fcId = typeof fc?.id === 'string' ? fc.id.trim() : '';
        if (fcId && fcId !== tcIds[idx]) {
          return { ok: false, reason: `geminiParts functionCall.id (${fcId}) 与 toolCalls (${tcIds[idx]}) 不一致` };
        }
      }
    } else if (fcParts.length > 0) {
      if (gemIds.length !== fcParts.length) {
        return { ok: false, reason: 'geminiParts 存在缺少本地关联 toolCalls ID 的 functionCall' };
      }
    }
  }

  return {
    ok: true,
    ids: tcIds.length > 0 ? tcIds : antIds.length > 0 ? antIds : gemIds,
  };
}

function validateTurnMessageSequencePairing(
  items: readonly PairingSequenceItem[],
): CoachToolPairingValidationResult {
  let i = 0;
  while (i < items.length) {
    const cur = items[i];
    const m = cur.message;
    if (m.role === 'system' || m.role === 'user') {
      i += 1;
      continue;
    }
    if (m.role === 'tool') {
      const straySeqs: number[] = [];
      const strayCallIds: string[] = [];
      let j = i;
      while (j < items.length && items[j].message.role === 'tool') {
        const toolItem = items[j];
        if (toolItem.entry) straySeqs.push(toolItem.entry.seq);
        const cid = (toolItem.message as Extract<CoachTurnMessage, { role: 'tool' }>).toolCallId.trim();
        if (cid) strayCallIds.push(cid);
        j += 1;
      }
      return {
        ok: false,
        issueKind: 'stray_tool_result',
        reason: `存在游离工具结果（toolCallId=${strayCallIds[0] || '未知'}），未紧邻前置 assistant 工具调用`,
        strayCallIds,
        affectedSeqs: straySeqs,
      };
    }

    const extracted = extractAssistantExpectedToolCallIds(m);
    if (!extracted.ok) {
      return {
        ok: false,
        issueKind: 'malformed_tool_batch',
        reason: extracted.reason,
        ...(cur.entry ? { assistantEntrySeq: cur.entry.seq, assistantEntryId: cur.entry.id, affectedSeqs: [cur.entry.seq] } : {}),
      };
    }
    const expectedIds = extracted.ids;
    if (expectedIds.length === 0) {
      i += 1;
      continue;
    }

    const expectedSet = new Set(expectedIds);
    const seenToolIds = new Set<string>();
    const presentCallIds: string[] = [];
    const contiguousSeqs: number[] = [];
    let j = i + 1;
    let dupOrStrayReason: string | undefined;

    while (j < items.length && items[j].message.role === 'tool') {
      const toolItem = items[j];
      const tm = toolItem.message as Extract<CoachTurnMessage, { role: 'tool' }>;
      const cid = tm.toolCallId.trim();
      if (toolItem.entry) contiguousSeqs.push(toolItem.entry.seq);
      if (!cid) {
        dupOrStrayReason ??= '工具结果缺少 toolCallId';
      } else if (seenToolIds.has(cid)) {
        dupOrStrayReason ??= `同批工具结果出现重复的 toolCallId: ${cid}`;
      } else if (!expectedSet.has(cid)) {
        dupOrStrayReason ??= `工具结果 toolCallId=${cid} 不属于紧邻前置 assistant 工具批`;
      } else {
        seenToolIds.add(cid);
        presentCallIds.push(cid);
      }
      j += 1;
    }

    const missingCallIds = expectedIds.filter((id) => !seenToolIds.has(id));
    if (dupOrStrayReason || missingCallIds.length > 0) {
      const affectedSeqSet = new Set<number>();
      if (cur.entry) affectedSeqSet.add(cur.entry.seq);
      for (const s of contiguousSeqs) affectedSeqSet.add(s);
      for (let k = j; k < items.length; k += 1) {
        const later = items[k];
        // 同一 toolCallId 可能是后续新模型轮的局部 ID（如 Gemini gem_local_1），不能跨轮把后续健康批次拉进当前问题批
        if (later.message.role === 'assistant' || later.message.role === 'user') {
          break;
        }
        if (later.message.role === 'tool') {
          const cid = (later.message as Extract<CoachTurnMessage, { role: 'tool' }>).toolCallId.trim();
          if (cid && expectedSet.has(cid) && later.entry) {
            affectedSeqSet.add(later.entry.seq);
          }
        }
      }
      return {
        ok: false,
        issueKind: dupOrStrayReason && missingCallIds.length === 0 ? 'stray_tool_result' : 'unclosed_tool_batch',
        reason:
          dupOrStrayReason ??
          `历史工具批未闭合：调用 ${missingCallIds.join(', ')} 缺少紧邻配对结果`,
        ...(cur.entry ? { assistantEntrySeq: cur.entry.seq, assistantEntryId: cur.entry.id } : {}),
        expectedCallIds: expectedIds,
        presentCallIds,
        missingCallIds,
        affectedSeqs: Array.from(affectedSeqSet).sort((a, b) => a - b),
      };
    }

    i = j;
  }
  return { ok: true };
}

/** 两条在线工具循环（正常轮与恢复续调轮）出站前共用的纯配对校验，保护各适配器原生块与签名。 */
export function validateOutboundToolPairing(
  messages: readonly CoachTurnMessage[],
): CoachToolPairingValidationResult {
  const items: PairingSequenceItem[] = messages.map((message) => ({ message }));
  return validateTurnMessageSequencePairing(items);
}

/** 校验持久化协议条目序列的工具批闭合与紧邻配对完整性（自动忽略已隔离/控制条目）。 */
export function validateProtocolEntriesPairing(
  entries: readonly CoachProtocolEntry[],
): CoachToolPairingValidationResult {
  const ordered = [...entries]
    .filter((e) => !e.quarantinedFromReplay && !e.isControlMarker)
    .sort((a, b) => a.seq - b.seq);
  const items: PairingSequenceItem[] = [];
  for (const entry of ordered) {
    const message = protocolEntryToTurnMessage(entry);
    if (message) items.push({ message, entry });
  }
  return validateTurnMessageSequencePairing(items);
}

function makeSegmentId(): string {
  return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

async function openFreshSegmentState(params: {
  threadId: string;
  reason: CoachSegmentReason;
  restoreEpoch: number;
  cfg: CoachStoredProviderConfig;
  caps: ProviderDeploymentCapabilities;
  effectiveThinking: CoachThinkingDepth;
  roCtx: CoachReadOnlyContext;
  memoryPrompt: string;
  contextSummary?: string;
  carriedMessages?: readonly CoachManualCompactionKeptMessage[];
}): Promise<{
  segment: CoachSegmentState;
  checkpoint: CoachSegmentCheckpoint;
}> {
  const baselineSnapshotJson = buildFrozenSegmentBaseline({
    roCtx: params.roCtx,
    memoryPrompt: params.memoryPrompt,
    contextSummary: params.contextSummary,
    carriedMessages: params.carriedMessages,
    reason: params.reason,
  });
  const checkpoint = computeSegmentSyncCheckpoint(params.roCtx, params.memoryPrompt);
  const segment: CoachSegmentState = {
    segmentId: makeSegmentId(),
    startedAt: Date.now(),
    reason: params.reason,
    restoreEpoch: params.restoreEpoch,
    deploymentId: params.caps.deploymentId,
    providerKind: params.cfg.kind,
    baseUrl: canonicalizeEndpointBaseUrl(params.cfg.kind, params.cfg.baseUrl),
    model: params.cfg.model,
    thinkingModeKey: params.effectiveThinking,
    baselineSnapshotJson,
    baselineSnapshotHash: hashTextCompact(baselineSnapshotJson),
    lastSyncedSessionId: checkpoint.activeSessionId,
    lastSyncedSessionRevision: checkpoint.activeSessionRevision,
    lastSyncedPlanRevisions: checkpoint.planRevisions,
    lastSyncedMemoryHash: checkpoint.memoryHash,
    lastSyncedSetupNotesHash: checkpoint.setupNotesHash,
    lastSyncedCheckpoint: checkpoint,
    nextSeq: 1,
    containsAssistantWithoutReasoning: false,
  };
  segmentCheckpointCache.set(`${params.threadId}:${segment.segmentId}`, checkpoint);
  return { segment, checkpoint };
}

function estimateConversationTokens(
  messages: readonly CoachTurnMessage[],
  toolsJsonOrDefs?: string | readonly unknown[],
): number {
  let total =
    typeof toolsJsonOrDefs === 'string'
      ? estimateTokens(toolsJsonOrDefs)
      : Array.isArray(toolsJsonOrDefs)
        ? estimateTokens(JSON.stringify(toolsJsonOrDefs))
        : 1500;
  for (const m of messages) {
    if (m.role === 'system') total += estimateTokens(m.text);
    else if (m.role === 'user') {
      for (const p of m.parts) {
        total += p.type === 'text' ? estimateTokens(p.text) : p.type === 'video' ? 4096 : 1024;
      }
    } else if (m.role === 'assistant') {
      total += estimateTokens(m.text) + estimateTokens(m.reasoning ?? '');
      if (m.toolCalls?.length) {
        total += estimateTokens(m.toolCalls.map((c) => c.argumentsText).join(' '));
      }
    } else {
      total += estimateTokens(m.content);
    }
  }
  return total;
}

export interface CoachThreadPendingState {
  threadId: string;
  currentEpoch: number;
  segmentId?: string;
  hasUnclosedToolBatch: boolean;
  orphanBatch: boolean;
  reason?: string;
  issue?: CoachToolPairingValidationResult;
  pendingTurn: CoachPendingTurn | null;
  expiredPendingTurns: CoachPendingTurn[];
}

/**
 * 限定在 pendingTurn 所属的当前轮次切片（自 userMessageId 之后到下一个 user 之前）中定位对应的唯一 assistant 工具批起点。
 * 若 pendingTurn 已记录精确 assistantEntrySeq，则绝不退化为按 toolCallId 跨批匹配，防止后续轮次的局部自增 ID（如 Gemini gem_local_1）误伤历史健康批次。
 */
function resolvePendingAssistantBatchIndex(
  pending: CoachPendingTurn,
  activeEntries: readonly CoachProtocolEntry[],
): { index: number; ambiguous: boolean; sliceStart: number; sliceEnd: number } {
  let sliceStart = 0;
  let sliceEnd = activeEntries.length;
  if (pending.userMessageId) {
    const userIdx = activeEntries.findIndex((e) => e.id === pending.userMessageId);
    if (userIdx >= 0) {
      sliceStart = userIdx + 1;
      for (let k = sliceStart; k < activeEntries.length; k += 1) {
        if (activeEntries[k].kind === 'user') {
          sliceEnd = k;
          break;
        }
      }
    }
  }

  if (pending.assistantEntrySeq !== undefined) {
    const exactIdx = activeEntries.findIndex(
      (e) => e.kind === 'assistant' && e.seq === pending.assistantEntrySeq,
    );
    return { index: exactIdx, ambiguous: false, sliceStart, sliceEnd };
  }

  const plannedCallIds = new Set(pending.plannedToolCalls?.map((p) => p.toolCallId) ?? []);
  if (!plannedCallIds.size) {
    return { index: -1, ambiguous: false, sliceStart, sliceEnd };
  }

  const matchedIndices: number[] = [];
  for (let i = sliceStart; i < sliceEnd; i += 1) {
    const e = activeEntries[i];
    if (e.kind === 'assistant' && e.toolCalls?.some((tc) => plannedCallIds.has(tc.id))) {
      matchedIndices.push(i);
    }
  }
  if (matchedIndices.length === 1) {
    return { index: matchedIndices[0], ambiguous: false, sliceStart, sliceEnd };
  }
  if (matchedIndices.length > 1) {
    return { index: -1, ambiguous: true, sliceStart, sliceEnd };
  }
  return { index: -1, ambiguous: false, sliceStart, sliceEnd };
}

/**
 * 严格按保留槽位（toolEntrySeq）或目标 assistant 批次紧邻工具区匹配既有 tool 结果，
 * 绝不因为旧轮次恰巧使用相同的局部 ID（如 gem_local_1）而误认旧结果为当前结果。
 */
function findSlotBoundToolEntry(
  entries: readonly CoachProtocolEntry[],
  pending: CoachPendingTurn,
  step: CoachPendingPlannedToolCall,
): CoachProtocolEntry | undefined {
  const activeEntries = [...entries]
    .filter((e) => !e.quarantinedFromReplay && !e.isControlMarker)
    .sort((a, b) => a.seq - b.seq);
  if (step.toolEntrySeq !== undefined) {
    return activeEntries.find(
      (e) => e.kind === 'tool' && e.seq === step.toolEntrySeq && e.toolCallId === step.toolCallId,
    );
  }
  const resolved = resolvePendingAssistantBatchIndex(pending, activeEntries);
  if (resolved.index >= 0) {
    for (let idx = resolved.index + 1; idx < activeEntries.length; idx += 1) {
      const candidate = activeEntries[idx];
      if (candidate.kind !== 'tool') break;
      if (candidate.toolCallId === step.toolCallId) return candidate;
    }
    return undefined;
  }
  if (pending.assistantEntrySeq === undefined && !resolved.ambiguous) {
    const hasOtherBatchWithSameCallId = activeEntries.some(
      (e) =>
        e.kind === 'assistant' && e.toolCalls?.some((tc) => tc.id === step.toolCallId),
    );
    if (!hasOtherBatchWithSameCallId) {
      for (let i = resolved.sliceStart; i < resolved.sliceEnd; i += 1) {
        const candidate = activeEntries[i];
        if (candidate.kind === 'tool' && candidate.toolCallId === step.toolCallId) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

function isPendingTurnSupersededByEntries(
  p: CoachPendingTurn,
  segEntries: readonly CoachProtocolEntry[],
): boolean {
  const ordered = [...segEntries].sort((a, b) => a.seq - b.seq);
  if (!ordered.length) return false;
  let afterIdx = -1;
  if (p.userMessageId) {
    afterIdx = ordered.findIndex((e) => e.id === p.userMessageId);
  }
  if (afterIdx < 0 && p.assistantEntrySeq !== undefined) {
    const asstIdx = ordered.findIndex((e) => e.seq === p.assistantEntrySeq && e.kind === 'assistant');
    if (asstIdx >= 0) afterIdx = asstIdx - 1;
  }
  if (afterIdx < 0) {
    // 若该 pendingTurn 的 userMessageId/seq 不在本段条目内，但本段末尾已是一轮干净的问答（或无未闭合批）
    return false;
  }
  const tail = ordered.slice(afterIdx + 1).filter((e) => !e.isControlMarker);
  if (!tail.length) return false;
  // 若尾部已有后续新用户消息，说明该 pendingTurn 已被后继回合跨过
  if (tail.some((e) => e.kind === 'user')) return true;
  // 若已有工具调用之后的最终纯文本 assistant 回复（无 toolCalls 且未隔离），说明该回合已闭合结束
  const lastActive = [...tail].reverse().find((e) => !e.quarantinedFromReplay);
  if (
    lastActive &&
    lastActive.kind === 'assistant' &&
    !(lastActive.toolCalls && lastActive.toolCalls.length > 0) &&
    !(lastActive.anthropicBlocks?.some((b) => b.type === 'tool_use')) &&
    !(lastActive.geminiParts?.some((pt) => 'functionCall' in pt && pt.functionCall !== undefined))
  ) {
    return true;
  }
  return false;
}

/**
 * 在普通发送与 UI 挂载前检查当前会话是否存在未闭合的历史工具批或待恢复回合：
 * · 优先检查当前活跃段（及无段旧库尾部）的协议条目配对状态，能识别没有 pendingTurn 的孤儿残批；
 * · 当存在多条旧 pendingTurn 时按 epoch、段匹配与调用 ID 精确匹配当前批，不被过期/已完结旧 pending 死锁或选错批；
 * · 待确认计划（awaiting_confirmation）且工具批已闭合时绝不阻断正常发送。
 */
export async function inspectCoachThreadPendingState(
  threadId = DEFAULT_COACH_THREAD_ID,
): Promise<CoachThreadPendingState> {
  const [currentEpoch, threadsState, allPending] = await Promise.all([
    getCoachRestoreEpoch(),
    loadCoachThreadsState(),
    listPendingTurns(threadId),
  ]);
  const threadMeta = threadsState.threads.find((t) => t.id === threadId);
  const activeSegment = threadMeta?.activeSegmentId
    ? threadMeta.segments?.[threadMeta.activeSegmentId]
    : undefined;

  const expiredPendingTurns = allPending.filter((p) => p.restoreEpoch !== currentEpoch);
  const currentEpochPendingsNewest = [...allPending]
    .filter((p) => p.restoreEpoch === currentEpoch)
    .reverse();

  // 若活跃段归属备份恢复前旧纪元，后续发送将开启 restore_backup 新段，旧段不阻塞新发送
  if (
    activeSegment &&
    activeSegment.restoreEpoch !== undefined &&
    activeSegment.restoreEpoch !== currentEpoch
  ) {
    return {
      threadId,
      currentEpoch,
      segmentId: activeSegment.segmentId,
      hasUnclosedToolBatch: false,
      orphanBatch: false,
      pendingTurn: expiredPendingTurns[expiredPendingTurns.length - 1] ?? null,
      expiredPendingTurns,
    };
  }

  let targetSegmentId = activeSegment?.segmentId;
  let segEntries = targetSegmentId ? await listProtocolEntries(threadId, targetSegmentId) : [];

  if (!targetSegmentId) {
    const allEntries = await listProtocolEntries(threadId);
    if (allEntries.length > 0) {
      const bySeg = new Map<string, CoachProtocolEntry[]>();
      for (const e of allEntries) {
        const arr = bySeg.get(e.segmentId) ?? [];
        arr.push(e);
        bySeg.set(e.segmentId, arr);
      }
      const orderedSegIds = Array.from(bySeg.keys()).sort((a, b) => {
        const maxA = Math.max(...(bySeg.get(a)?.map((x) => x.createdAt) ?? [0]));
        const maxB = Math.max(...(bySeg.get(b)?.map((x) => x.createdAt) ?? [0]));
        return maxB - maxA;
      });
      for (const sid of orderedSegIds) {
        const candidate = bySeg.get(sid) ?? [];
        if (!validateProtocolEntriesPairing(candidate).ok) {
          targetSegmentId = sid;
          segEntries = candidate;
          break;
        }
      }
      if (!targetSegmentId && orderedSegIds[0]) {
        targetSegmentId = orderedSegIds[0];
        segEntries = bySeg.get(targetSegmentId) ?? [];
      }
    }
  }

  const pairing = validateProtocolEntriesPairing(segEntries);
  if (!pairing.ok) {
    const activeSegEntries = [...segEntries]
      .filter((e) => !e.quarantinedFromReplay && !e.isControlMarker)
      .sort((a, b) => a.seq - b.seq);
    const affectedSeqSet = new Set(pairing.affectedSeqs ?? []);
    const issueCallIds = new Set<string>([
      ...(pairing.expectedCallIds ?? []),
      ...(pairing.strayCallIds ?? []),
    ]);
    const matchedPending =
      currentEpochPendingsNewest.find((p) => {
        if (targetSegmentId && p.segmentId !== targetSegmentId) return false;
        if (pairing.assistantEntrySeq !== undefined && p.assistantEntrySeq !== undefined) {
          return p.assistantEntrySeq === pairing.assistantEntrySeq;
        }
        if (pairing.assistantEntrySeq !== undefined && p.assistantEntrySeq === undefined) {
          const resolved = resolvePendingAssistantBatchIndex(p, activeSegEntries);
          return (
            !resolved.ambiguous &&
            resolved.index >= 0 &&
            activeSegEntries[resolved.index]?.seq === pairing.assistantEntrySeq
          );
        }
        if (isPendingTurnSupersededByEntries(p, segEntries)) return false;
        const hasReservedSeqMatch = Boolean(
          p.plannedToolCalls?.some(
            (pc) => pc.toolEntrySeq !== undefined && affectedSeqSet.has(pc.toolEntrySeq),
          ),
        );
        if (hasReservedSeqMatch) return true;
        return (
          p.assistantEntrySeq === undefined &&
          issueCallIds.size > 0 &&
          Boolean(p.plannedToolCalls?.some((pc) => issueCallIds.has(pc.toolCallId)))
        );
      }) ?? null;

    return {
      threadId,
      currentEpoch,
      ...(targetSegmentId ? { segmentId: targetSegmentId } : {}),
      hasUnclosedToolBatch: true,
      orphanBatch: matchedPending === null,
      reason: pairing.reason ?? '检测到未闭合的历史工具批',
      issue: pairing,
      pendingTurn: matchedPending,
      expiredPendingTurns,
    };
  }

  // 协议条目自身已闭合（或尚未写入 assistant tool_calls）时，再核对当前段是否存在未完结的 awaiting_tools pending
  const liveAwaitingTools = currentEpochPendingsNewest.find((p) => {
    if (p.status !== 'awaiting_tools') return false;
    if (targetSegmentId && p.segmentId !== targetSegmentId) return false;
    const entriesForPending =
      p.segmentId === targetSegmentId ? segEntries : [];
    if (isPendingTurnSupersededByEntries(p, entriesForPending)) return false;
    return Boolean(p.plannedToolCalls?.some((pc) => pc.status === 'pending'));
  });

  if (liveAwaitingTools) {
    return {
      threadId,
      currentEpoch,
      segmentId: liveAwaitingTools.segmentId,
      hasUnclosedToolBatch: true,
      orphanBatch: false,
      reason: '检测到待执行或未落盘的历史工具操作批',
      pendingTurn: liveAwaitingTools,
      expiredPendingTurns,
    };
  }

  // 无未闭合工具批：按优先级挑选未过期的常规恢复提示（待确认草稿 / 待续调确认回复 / 中断生成）
  const bannerCandidate =
    currentEpochPendingsNewest.find((p) => {
      if (p.status === 'awaiting_confirmation' && p.pendingDraftPlan) return true;
      if (p.status === 'awaiting_followup_model') {
        if (targetSegmentId && p.segmentId !== targetSegmentId) return false;
        return !isPendingTurnSupersededByEntries(p, segEntries);
      }
      if (p.status === 'running_model') {
        if (targetSegmentId && p.segmentId !== targetSegmentId) return false;
        return !isPendingTurnSupersededByEntries(p, segEntries);
      }
      return false;
    }) ?? null;

  return {
    threadId,
    currentEpoch,
    ...(targetSegmentId ? { segmentId: targetSegmentId } : {}),
    hasUnclosedToolBatch: false,
    orphanBatch: false,
    pendingTurn: bannerCandidate,
    expiredPendingTurns,
  };
}

export interface AbandonCoachTurnResult {
  abandoned: boolean;
  expiredByRestore?: boolean;
  threadMismatch?: boolean;
  staleOrMissingPending?: boolean;
  quarantined: boolean;
  reconciledCount: number;
  cancelledCount: number;
  quarantinedCount: number;
  receipts: CoachOperationReceipt[];
  text: string;
}

const NO_SIDE_EFFECT_TOOLS = new Set([
  'create_plan_from_draft',
  'query_training_context',
  'search_coach_history',
  'web_search',
]);

async function inspectAuthoritativeOpStatus(
  operationId: string,
  currentEpoch: number,
): Promise<
  | { kind: 'committed'; receipt: CoachOperationReceipt; hasVaultReceipt: boolean }
  | { kind: 'absent'; mainCheckedCleanly: boolean; vaultCheckedCleanly: boolean }
  | { kind: 'read-error'; reason: string }
> {
  if (!operationId.trim()) {
    return { kind: 'read-error', reason: '缺少 operationId，无法对账' };
  }
  let mainCheckedCleanly = false;
  let vaultCheckedCleanly = false;
  let mainReceipt: CoachOperationReceipt | undefined;
  let vaultReceipt: CoachOperationReceipt | undefined;

  try {
    vaultReceipt = await findVaultReceiptByOperationIdStrict(operationId);
    vaultCheckedCleanly = true;
  } catch {
    return { kind: 'read-error', reason: `读取 vault 回执失败 (${operationId})` };
  }

  try {
    const mainRow = await idbGet<{ key: string; value?: CoachMainOpLogRecord }>(
      'meta',
      `${COACH_OP_META_PREFIX}${operationId}`,
    );
    mainCheckedCleanly = true;
    const op = mainRow?.value;
    if (op && op.operationId === operationId) {
      if (op.restoreEpoch !== currentEpoch) {
        return { kind: 'read-error', reason: `主库操作账本纪元不匹配 (${operationId})` };
      }
      mainReceipt = receiptFromMainOpLog(op);
    }
  } catch {
    return { kind: 'read-error', reason: `读取主库操作账本失败 (${operationId})` };
  }

  if (mainReceipt) {
    return {
      kind: 'committed',
      receipt: mainReceipt,
      hasVaultReceipt: Boolean(vaultReceipt && vaultReceipt.id === mainReceipt.id),
    };
  }
  if (vaultReceipt && vaultReceipt.restoreEpoch === currentEpoch) {
    return {
      kind: 'committed',
      receipt: vaultReceipt,
      hasVaultReceipt: true,
    };
  }
  return { kind: 'absent', mainCheckedCleanly, vaultCheckedCleanly };
}

/**
 * 明确放弃未完成/未闭合的工具批：
 * · 绝不执行任何业务工具；
 * · 按每项对账：可信已持久化协议结果优先 -> 权威账本/回执重建真实短结果 -> 确定未执行证据才写取消；
 * · 存在任一无法确认项或结构损坏或孤儿残批时，将整个问题工具批隔离出模型重放，保留审计数据与已知实绩；
 * · 收尾与 pending 清理在同一 vault 事务原子提交，失败保留现场支持断点幂等重试；正常历史不做大扫除。
 */
export async function abandonPendingCoachTurn(params?: {
  threadId?: string;
  pendingTurn?: CoachPendingTurn | null;
}): Promise<AbandonCoachTurnResult> {
  if (params?.threadId && params?.pendingTurn && params.pendingTurn.threadId !== params.threadId) {
    return {
      abandoned: false,
      threadMismatch: true,
      quarantined: false,
      reconciledCount: 0,
      cancelledCount: 0,
      quarantinedCount: 0,
      receipts: [],
      text: '待放弃记录与当前会话不匹配，未改动任何会话或训练数据。',
    };
  }
  const threadId =
    params?.threadId ?? params?.pendingTurn?.threadId ?? DEFAULT_COACH_THREAD_ID;
  const [currentEpoch, state, allPending] = await Promise.all([
    getCoachRestoreEpoch(),
    inspectCoachThreadPendingState(threadId),
    listPendingTurns(threadId),
  ]);

  let targetPending: CoachPendingTurn | null = null;
  if (params?.pendingTurn) {
    const persisted = allPending.find((p) => p.turnId === params.pendingTurn!.turnId);
    if (
      !persisted ||
      persisted.threadId !== threadId ||
      persisted.segmentId !== params.pendingTurn.segmentId ||
      persisted.restoreEpoch !== params.pendingTurn.restoreEpoch
    ) {
      return {
        abandoned: false,
        staleOrMissingPending: true,
        quarantined: false,
        reconciledCount: 0,
        cancelledCount: 0,
        quarantinedCount: 0,
        receipts: [],
        text: '待放弃的恢复记录在当前会话中已不存在或已过期，未改动任何数据。',
      };
    }
    targetPending = persisted;
  } else {
    targetPending = state.pendingTurn;
  }

  if (targetPending && targetPending.restoreEpoch !== currentEpoch) {
    const expiredIds = Array.from(
      new Set([targetPending.turnId, ...state.expiredPendingTurns.map((p) => p.turnId)]),
    );
    await commitAbandonReconciliationAtomic({ deletePendingTurnIds: expiredIds });
    return {
      abandoned: true,
      expiredByRestore: true,
      quarantined: false,
      reconciledCount: 0,
      cancelledCount: 0,
      quarantinedCount: 0,
      receipts: [],
      text: '检测到系统已恢复过历史备份，先前中断的待恢复操作已安全清理。',
    };
  }

  const targetSegmentId = targetPending?.segmentId ?? state.segmentId;
  const segEntries = targetSegmentId
    ? await listProtocolEntries(threadId, targetSegmentId)
    : [];
  const pairing = validateProtocolEntriesPairing(segEntries);

  // 无问题工具批且无孤儿残批：仅原子清理目标 pendingTurn，绝不扫除正常历史
  if (pairing.ok && !state.hasUnclosedToolBatch) {
    const deleteIds = targetPending ? [targetPending.turnId] : [];
    if (deleteIds.length) {
      await commitAbandonReconciliationAtomic({ deletePendingTurnIds: deleteIds });
    }
    return {
      abandoned: true,
      quarantined: false,
      reconciledCount: 0,
      cancelledCount: 0,
      quarantinedCount: 0,
      receipts: [],
      text: '已放弃未完成的恢复状态。',
    };
  }

  // Case A：无对应 pendingTurn 的孤儿问题批 -> 隔离该批出模型重放，保留审计数据与已知实绩
  if (!targetPending || !targetPending.plannedToolCalls?.length) {
    const affectedSeqSet = new Set<number>(pairing.affectedSeqs ?? []);
    if (affectedSeqSet.size === 0 && targetPending?.assistantEntrySeq !== undefined) {
      affectedSeqSet.add(targetPending.assistantEntrySeq);
    }
    const now = Date.now();
    const quarantineReason =
      pairing.reason ?? '缺少可对账的恢复意图，已将该问题工具批隔离出模型重放';
    const entriesToQuarantine = segEntries
      .filter((e) => affectedSeqSet.has(e.seq) && !e.quarantinedFromReplay)
      .map((e) => ({
        ...e,
        quarantinedFromReplay: true,
        quarantineReason,
        quarantinedAt: now,
      }));
    const preservedReceipts: CoachOperationReceipt[] = [];
    for (const e of entriesToQuarantine) {
      if (e.kind === 'tool' && e.toolResultText) {
        try {
          const parsed = JSON.parse(e.toolResultText) as { receipt?: { operationId?: string } };
          const opId = parsed?.receipt?.operationId;
          if (typeof opId === 'string' && opId) {
            const rec = await getCoachReceiptByOperationId(opId);
            if (rec) preservedReceipts.push(rec);
          }
        } catch {
          /* ignore */
        }
      }
    }
    const deleteIds = targetPending ? [targetPending.turnId] : [];
    await commitAbandonReconciliationAtomic({
      upsertEntries: entriesToQuarantine,
      deletePendingTurnIds: deleteIds,
    });
    return {
      abandoned: true,
      quarantined: entriesToQuarantine.length > 0,
      reconciledCount: 0,
      cancelledCount: 0,
      quarantinedCount: entriesToQuarantine.length,
      receipts: preservedReceipts,
      text: preservedReceipts.length
        ? `已放弃并隔离未闭合的历史工具批（已保留 ${preservedReceipts.length} 项既有操作审计回执），不影响继续对话。`
        : '已放弃并隔离未闭合的历史工具批，保留原始审计记录，可继续正常发送。',
    };
  }

  // Case B：有 pendingTurn 与 plannedToolCalls -> 逐项严格对账
  const planned = targetPending.plannedToolCalls;
  const plannedCallIds = new Set(planned.map((p) => p.toolCallId));
  const orderedEntries = [...segEntries].sort((a, b) => a.seq - b.seq);
  const activeEntries = orderedEntries.filter((e) => !e.quarantinedFromReplay && !e.isControlMarker);

  const resolvedAsst = resolvePendingAssistantBatchIndex(targetPending, activeEntries);
  const asstIdx = resolvedAsst.index;
  const existingAsst = asstIdx >= 0 ? activeEntries[asstIdx] : undefined;

  // 检查是否已有结构破坏（非紧邻工具条目 / 重复 toolCallId / 同批外部插入 / 跨轮歧义）
  let structuralCorruption = resolvedAsst.ambiguous;
  const contiguousToolByCallId = new Map<string, CoachProtocolEntry>();
  const batchExistingSeqs = new Set<number>();
  if (existingAsst) {
    batchExistingSeqs.add(existingAsst.seq);
    let idx = asstIdx + 1;
    while (idx < activeEntries.length && activeEntries[idx].kind === 'tool') {
      const te = activeEntries[idx];
      batchExistingSeqs.add(te.seq);
      const cid = te.toolCallId?.trim() ?? '';
      if (!cid || !plannedCallIds.has(cid) || contiguousToolByCallId.has(cid)) {
        structuralCorruption = true;
      } else {
        contiguousToolByCallId.set(cid, te);
      }
      idx += 1;
    }
    for (let k = idx; k < activeEntries.length; k += 1) {
      const later = activeEntries[k];
      // 遇到新的 assistant 工具轮或新用户消息即终止，避免把后续或同 ID 批次卷入当前批
      if (later.kind === 'assistant' || later.kind === 'user') {
        break;
      }
      if (later.kind === 'tool' && later.toolCallId && plannedCallIds.has(later.toolCallId)) {
        batchExistingSeqs.add(later.seq);
        structuralCorruption = true;
      }
    }
    if (idx < activeEntries.length) {
      // 若问题批后面已经紧跟着其他活跃条目，而本批还需要补写缺口，将出现非紧邻问题 -> 只能安全隔离
      const hasAnyMissingTool = planned.some((p) => !contiguousToolByCallId.has(p.toolCallId));
      if (hasAnyMissingTool) {
        structuralCorruption = true;
      }
    }
  } else if (resolvedAsst.ambiguous && !pairing.ok) {
    // 遗留无 seq 记录在同段多批同 ID 时存在歧义：仅隔离协议校验精确指出的当前问题批，绝不触碰早先完整批次
    for (const seq of pairing.affectedSeqs ?? []) {
      batchExistingSeqs.add(seq);
    }
  } else {
    // assistant 条目尚未找到时，仅按本批保留的 toolEntrySeq 槽位或同一轮切片定位，绝不按 toolCallId 误扫前置健康批次
    const reservedToolSeqs = new Set(
      planned.map((p) => p.toolEntrySeq).filter((s): s is number => typeof s === 'number'),
    );
    if (reservedToolSeqs.size > 0) {
      for (const te of activeEntries) {
        if (te.kind === 'tool' && reservedToolSeqs.has(te.seq)) {
          batchExistingSeqs.add(te.seq);
          structuralCorruption = true;
        }
      }
    } else if (targetPending.assistantEntrySeq === undefined && targetPending.userMessageId) {
      for (let i = resolvedAsst.sliceStart; i < resolvedAsst.sliceEnd; i += 1) {
        const te = activeEntries[i];
        if (te.kind === 'tool' && te.toolCallId && plannedCallIds.has(te.toolCallId)) {
          batchExistingSeqs.add(te.seq);
          structuralCorruption = true;
        }
      }
    }
  }

  type ReconciledStep =
    | { kind: 'persisted'; step: CoachPendingPlannedToolCall; entry: CoachProtocolEntry; receipt?: CoachOperationReceipt }
    | { kind: 'rebuilt_committed'; step: CoachPendingPlannedToolCall; resultJson: string; receipt?: CoachOperationReceipt }
    | { kind: 'rebuilt_failed'; step: CoachPendingPlannedToolCall; resultJson: string }
    | { kind: 'confirmed_cancelled'; step: CoachPendingPlannedToolCall; resultJson: string }
    | { kind: 'unknown'; step: CoachPendingPlannedToolCall; reason: string };

  const reconciled: ReconciledStep[] = [];
  const receipts: CoachOperationReceipt[] = [];
  const receiptsToMirror: CoachOperationReceipt[] = [];
  const runningSessionRev = new Map<string, number>();
  const runningPlanRev = new Map<string, number>();

  for (let i = 0; i < planned.length; i += 1) {
    const step = planned[i];
    const persistedTool = contiguousToolByCallId.get(step.toolCallId);
    const opStatus = step.operationId
      ? await inspectAuthoritativeOpStatus(step.operationId, currentEpoch)
      : ({ kind: 'read-error', reason: '缺少 operationId' } as const);

    const advanceRevsFromReceipt = (rec?: CoachOperationReceipt) => {
      if (!rec) return;
      if (rec.entityType === 'session' || rec.entityType === 'session+plan') {
        runningSessionRev.set(rec.entityId, rec.afterRevision);
      }
      if (rec.entityType === 'plan' && rec.afterPlanRevision !== undefined) {
        runningPlanRev.set(rec.entityId, rec.afterPlanRevision);
      } else if (rec.planId && rec.afterPlanRevision !== undefined) {
        runningPlanRev.set(rec.planId, rec.afterPlanRevision);
      }
    };

    // 1. 可信已持久化协议结果优先
    if (persistedTool && persistedTool.toolResultText && persistedTool.toolResultText.trim()) {
      let rec: CoachOperationReceipt | undefined;
      if (opStatus.kind === 'committed') {
        rec = opStatus.receipt;
        receipts.push(rec);
        if (!opStatus.hasVaultReceipt) receiptsToMirror.push(rec);
        advanceRevsFromReceipt(rec);
      } else if (step.afterRevision !== undefined && typeof step.args?.sessionId === 'string') {
        runningSessionRev.set(step.args.sessionId, step.afterRevision);
      }
      reconciled.push({ kind: 'persisted', step, entry: persistedTool, receipt: rec });
      continue;
    }

    // 2. 已提交但缺协议结果：按权威操作账本/回执重建真实短结果
    if (opStatus.kind === 'committed') {
      const rec = opStatus.receipt;
      receipts.push(rec);
      if (!opStatus.hasVaultReceipt) receiptsToMirror.push(rec);
      advanceRevsFromReceipt(rec);
      const rebuiltJson = JSON.stringify(
        projectToolOutcomeForModel(step.name, {
          ok: true,
          summary: rec.summary,
          receipt: rec,
          data: rec.timerStarted !== undefined ? { timerStarted: rec.timerStarted } : undefined,
        }),
      );
      reconciled.push({ kind: 'rebuilt_committed', step, resultJson: rebuiltJson, receipt: rec });
      continue;
    }

    if (step.status === 'committed' && step.outcomeJson) {
      reconciled.push({ kind: 'rebuilt_committed', step, resultJson: step.outcomeJson });
      continue;
    }

    if (step.status === 'failed') {
      const failJson =
        step.outcomeJson ??
        JSON.stringify({ ok: false, errorCode: 'failed', summary: step.errorText || '执行失败' });
      reconciled.push({ kind: 'rebuilt_failed', step, resultJson: failJson });
      continue;
    }

    // 3. 判断是否具备确定未执行证据（仅凭 pending/无回执绝不足以证明跨库写没发生）
    if (opStatus.kind === 'read-error' || step.status !== 'pending' || !step.operationId) {
      reconciled.push({
        kind: 'unknown',
        step,
        reason: opStatus.kind === 'read-error' ? opStatus.reason : '状态与账本记录不一致，无法确认是否已执行',
      });
      continue;
    }

    let confirmedNotExecuted = false;
    if (NO_SIDE_EFFECT_TOOLS.has(step.name)) {
      confirmedNotExecuted = true;
    } else if (step.name === 'manage_coach_memory') {
      // manage_coach_memory 与 vault.receipts 同事务提交；vault 严格可读且无回执即可确认未执行
      confirmedNotExecuted = opStatus.vaultCheckedCleanly && opStatus.kind === 'absent';
    } else if (opStatus.mainCheckedCleanly && opStatus.vaultCheckedCleanly) {
      const pre = step.frozenPrecondition;
      const targetSid =
        (pre && 'sessionId' in pre ? pre.sessionId : undefined) ??
        (typeof step.args?.sessionId === 'string' ? step.args.sessionId : undefined);
      const targetPid =
        (pre && 'planId' in pre ? pre.planId : undefined) ??
        (typeof step.args?.planId === 'string' ? step.args.planId : undefined);

      if (targetSid) {
        const expectedRev = runningSessionRev.get(targetSid) ?? step.expectedRevision;
        if (expectedRev !== undefined) {
          try {
            const liveSession = await getSession(targetSid);
            if (liveSession && liveSession.revision === expectedRev) {
              confirmedNotExecuted = true;
            }
          } catch {
            confirmedNotExecuted = false;
          }
        }
      } else if (targetPid) {
        const expectedPlanRev = runningPlanRev.get(targetPid) ?? step.expectedPlanRevision;
        if (expectedPlanRev !== undefined) {
          try {
            const livePlan = await getPlan(targetPid);
            if (livePlan && livePlan.updatedAt === expectedPlanRev) {
              confirmedNotExecuted = true;
            }
          } catch {
            confirmedNotExecuted = false;
          }
        }
      }
    }

    if (confirmedNotExecuted) {
      reconciled.push({
        kind: 'confirmed_cancelled',
        step,
        resultJson: JSON.stringify({
          ok: false,
          errorCode: 'user-abandoned',
          cancelled: true,
          summary: '用户已放弃该未执行的工具操作（未写入数据）',
        }),
      });
    } else {
      reconciled.push({
        kind: 'unknown',
        step,
        reason: `无法确认调用 ${step.name} (${step.toolCallId}) 是否已在跨库侧提交`,
      });
    }
  }

  const hasUnknown = reconciled.some((r) => r.kind === 'unknown');
  const anyExecuted = reconciled.some(
    (r) => r.kind === 'persisted' || r.kind === 'rebuilt_committed' || r.kind === 'rebuilt_failed',
  );
  const occupiedSeqs = new Set(orderedEntries.map((e) => e.seq));
  let maxSeq = orderedEntries.reduce((m, e) => Math.max(m, e.seq), 0);
  const allocSafeSeq = (preferred?: number): number => {
    if (preferred !== undefined && preferred >= 1 && !occupiedSeqs.has(preferred)) {
      occupiedSeqs.add(preferred);
      if (preferred > maxSeq) maxSeq = preferred;
      return preferred;
    }
    maxSeq += 1;
    while (occupiedSeqs.has(maxSeq)) maxSeq += 1;
    occupiedSeqs.add(maxSeq);
    return maxSeq;
  };

  // 同段同批的多余旧 pending 也一并清理（只按 exact assistantEntrySeq 或同 userMessageId 遗留格式匹配，绝不跨批按 toolCallId 误删）
  const deletePendingIds = Array.from(
    new Set([
      targetPending.turnId,
      ...allPending
        .filter(
          (p) =>
            p.turnId !== targetPending!.turnId &&
            p.segmentId === targetPending!.segmentId &&
            p.status !== 'awaiting_confirmation' &&
            ((targetPending!.assistantEntrySeq !== undefined &&
              p.assistantEntrySeq === targetPending!.assistantEntrySeq) ||
              (targetPending!.assistantEntrySeq === undefined &&
                p.assistantEntrySeq === undefined &&
                Boolean(targetPending!.userMessageId) &&
                p.userMessageId === targetPending!.userMessageId &&
                Boolean(p.plannedToolCalls?.some((pc) => plannedCallIds.has(pc.toolCallId))))),
        )
        .map((p) => p.turnId),
    ]),
  );

  // 存在无法确认项或结构损坏或缺失原 assistant 条目且无法安全闭合 -> 整批隔离出模型重放，不把未知伪装为失败
  if (
    hasUnknown ||
    structuralCorruption ||
    (!existingAsst && anyExecuted && !targetPending.assistantEntrySnapshot)
  ) {
    const now = Date.now();
    const firstUnknownReason =
      reconciled.find((r): r is Extract<ReconciledStep, { kind: 'unknown' }> => r.kind === 'unknown')
        ?.reason ?? '工具批状态无法完整对账，已隔离出模型重放';
    const upsertEntries: CoachProtocolEntry[] = [];
    for (const e of segEntries) {
      if (batchExistingSeqs.has(e.seq)) {
        upsertEntries.push({
          ...e,
          quarantinedFromReplay: true,
          quarantineReason: firstUnknownReason,
          quarantinedAt: now,
        });
      }
    }
    if (!existingAsst && targetPending.assistantEntrySnapshot && targetSegmentId) {
      const asstSeq = allocSafeSeq(targetPending.assistantEntrySeq);
      upsertEntries.push({
        id: `${threadId}:${targetSegmentId}:${asstSeq}`,
        threadId,
        segmentId: targetSegmentId,
        seq: asstSeq,
        ...targetPending.assistantEntrySnapshot,
        quarantinedFromReplay: true,
        quarantineReason: firstUnknownReason,
        quarantinedAt: now,
      });
    }
    for (const item of reconciled) {
      if ((item.kind === 'rebuilt_committed' || item.kind === 'rebuilt_failed') && targetSegmentId) {
        const toolSeq = allocSafeSeq(item.step.toolEntrySeq);
        upsertEntries.push({
          id: `${threadId}:${targetSegmentId}:${toolSeq}`,
          threadId,
          segmentId: targetSegmentId,
          seq: toolSeq,
          createdAt: now,
          kind: 'tool',
          toolCallId: item.step.toolCallId,
          toolName: item.step.name,
          toolResultText: item.resultJson,
          toolError: item.kind === 'rebuilt_failed',
          quarantinedFromReplay: true,
          quarantineReason: firstUnknownReason,
          quarantinedAt: now,
        });
      }
    }
    await commitAbandonReconciliationAtomic({
      upsertEntries,
      upsertReceipts: receiptsToMirror,
      deletePendingTurnIds: deletePendingIds,
      ...(targetSegmentId ? { segmentUpdate: { threadId, segmentId: targetSegmentId, nextSeq: maxSeq + 1 } } : {}),
    });
    const rebuiltCnt = reconciled.filter((r) => r.kind === 'rebuilt_committed').length;
    return {
      abandoned: true,
      quarantined: true,
      reconciledCount: rebuiltCnt,
      cancelledCount: 0,
      quarantinedCount: upsertEntries.length,
      receipts,
      text: receipts.length
        ? `已放弃继续执行；因部分操作跨库状态无法确认，已将整批隔离出后续模型对话，并保留 ${receipts.length} 项已提交操作回执。`
        : '已放弃继续执行；因部分操作跨库状态无法确认，已将整批隔离出后续模型对话（未将未知状态伪装为失败）。',
    };
  }

  // 若 assistant 条目从未落盘且全部确定未执行 -> 直接清理 pendingTurn，不污染协议日志
  if (!existingAsst && !anyExecuted) {
    await commitAbandonReconciliationAtomic({
      deletePendingTurnIds: deletePendingIds,
    });
    return {
      abandoned: true,
      quarantined: false,
      reconciledCount: 0,
      cancelledCount: reconciled.filter((r) => r.kind === 'confirmed_cancelled').length,
      quarantinedCount: 0,
      receipts,
      text: '已放弃未执行的工具操作，未改动任何训练数据。',
    };
  }

  // 所有项均有确定归属：补写缺失的真实结果或确定取消结果，保持完整配对
  const upsertEntries: CoachProtocolEntry[] = [];
  if (!existingAsst && targetPending.assistantEntrySnapshot && targetSegmentId) {
    const asstSeq = allocSafeSeq(targetPending.assistantEntrySeq);
    upsertEntries.push({
      id: `${threadId}:${targetSegmentId}:${asstSeq}`,
      threadId,
      segmentId: targetSegmentId,
      seq: asstSeq,
      ...targetPending.assistantEntrySnapshot,
    });
  }
  const now = Date.now();
  let rebuiltCommittedCount = 0;
  let cancelledCount = 0;

  for (const item of reconciled) {
    if (item.kind === 'persisted' || item.kind === 'unknown') continue;
    if (item.kind === 'rebuilt_committed') rebuiltCommittedCount += 1;
    if (item.kind === 'confirmed_cancelled') cancelledCount += 1;
    if (targetSegmentId) {
      const toolSeq = allocSafeSeq(item.step.toolEntrySeq);
      upsertEntries.push({
        id: `${threadId}:${targetSegmentId}:${toolSeq}`,
        threadId,
        segmentId: targetSegmentId,
        seq: toolSeq,
        createdAt: now,
        kind: 'tool',
        toolCallId: item.step.toolCallId,
        toolName: item.step.name,
        toolResultText: item.resultJson,
        toolError: item.kind !== 'rebuilt_committed',
      });
    }
  }

  // 出站前最终验证：若意外出现非配对（例如并发插入了其他条目），自动退回安全隔离
  const simulatedById = new Map(segEntries.map((e) => [e.id, e]));
  for (const u of upsertEntries) simulatedById.set(u.id, u);
  const simulatedCheck = validateProtocolEntriesPairing(Array.from(simulatedById.values()));
  if (!simulatedCheck.ok) {
    const quarantineSeqs = new Set(batchExistingSeqs);
    const quarantinedUpserts: CoachProtocolEntry[] = [];
    for (const e of segEntries) {
      if (quarantineSeqs.has(e.seq)) {
        quarantinedUpserts.push({
          ...e,
          quarantinedFromReplay: true,
          quarantineReason: simulatedCheck.reason ?? '对账后结构校验未通过，安全隔离',
          quarantinedAt: now,
        });
      }
    }
    for (const u of upsertEntries) {
      quarantinedUpserts.push({
        ...u,
        quarantinedFromReplay: true,
        quarantineReason: simulatedCheck.reason ?? '对账后结构校验未通过，安全隔离',
        quarantinedAt: now,
      });
    }
    await commitAbandonReconciliationAtomic({
      upsertEntries: quarantinedUpserts,
      upsertReceipts: receiptsToMirror,
      deletePendingTurnIds: deletePendingIds,
      ...(targetSegmentId ? { segmentUpdate: { threadId, segmentId: targetSegmentId, nextSeq: maxSeq + 1 } } : {}),
    });
    return {
      abandoned: true,
      quarantined: true,
      reconciledCount: rebuiltCommittedCount,
      cancelledCount: 0,
      quarantinedCount: quarantinedUpserts.length,
      receipts,
      text: '已放弃继续执行并安全隔离未闭合工具批，已保留既有审计数据与操作回执。',
    };
  }

  await commitAbandonReconciliationAtomic({
    upsertEntries,
    upsertReceipts: receiptsToMirror,
    deletePendingTurnIds: deletePendingIds,
    ...(targetSegmentId ? { segmentUpdate: { threadId, segmentId: targetSegmentId, nextSeq: maxSeq + 1 } } : {}),
  });

  return {
    abandoned: true,
    quarantined: false,
    reconciledCount: rebuiltCommittedCount,
    cancelledCount,
    quarantinedCount: 0,
    receipts,
    text: receipts.length
      ? `已放弃后续未执行操作（已保留 ${receipts.length} 项已提交记录${cancelledCount ? `，${cancelledCount} 项未执行已标记放弃` : ''}），可继续发送新消息。`
      : '已放弃未执行的工具操作并闭合记录，可继续发送新消息。',
  };
}

export async function runCoachTurn(params: RunCoachTurnParams): Promise<RunCoachTurnResult> {
  const threadId = params.threadId || DEFAULT_COACH_THREAD_ID;
  await getActiveSessionRuntime(params.toolContext.activeSession?.id)?.awaitPendingWrites();

  // 必须早于独立联网搜索、模型请求与新用户消息接收检查未闭合的历史工具批
  const preflightPending = await inspectCoachThreadPendingState(threadId);
  if (preflightPending.hasUnclosedToolBatch) {
    // 若传入空 UI 历史（如重置测试态）、无任何 pendingTurn 且仅有旧段尾前残留孤立 tool（无任何 assistant 工具批），放行后续 initial 重置段
    let allowLegacyEmptyHistoryReset = false;
    if (
      params.history.length === 0 &&
      !preflightPending.pendingTurn &&
      preflightPending.orphanBatch &&
      preflightPending.issue?.issueKind === 'stray_tool_result' &&
      preflightPending.segmentId
    ) {
      const segEntries = await listProtocolEntries(threadId, preflightPending.segmentId);
      const ordered = [...segEntries]
        .filter((e) => !e.quarantinedFromReplay && !e.isControlMarker)
        .sort((a, b) => a.seq - b.seq);
      const hasAnyAssistantToolBatch = ordered.some(
        (e) =>
          e.kind === 'assistant' &&
          ((e.toolCalls && e.toolCalls.length > 0) ||
            Boolean(e.anthropicBlocks?.some((b) => b.type === 'tool_use')) ||
            Boolean(e.geminiParts?.some((p) => 'functionCall' in p && p.functionCall !== undefined))),
      );
      const lastEntry = ordered[ordered.length - 1];
      if (!hasAnyAssistantToolBatch && lastEntry?.kind === 'user') {
        allowLegacyEmptyHistoryReset = true;
      }
    }
    if (!allowLegacyEmptyHistoryReset) {
      return {
        text: '检测到上轮工具操作尚未闭合，请先「恢复继续」或明确「放弃」后再发送新消息。',
        receipts: [],
        aborted: false,
        blockedByUnclosedBatch: true,
        unclosedBatchSegmentId: preflightPending.segmentId,
        errorMessage: preflightPending.reason ?? '存在未闭合的历史工具批',
        ...(preflightPending.pendingTurn ? { pendingTurn: preflightPending.pendingTurn } : {}),
      };
    }
  }

  const cfg = params.providerConfig;
  const hasLiveProvider = Boolean(cfg && cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());
  if (!hasLiveProvider || !cfg) {
    return runDeterministicLocalTurn(params);
  }

  const providerCfg = toProviderConfig(cfg);
  const caps = resolveProviderCapabilities({
    ...cfg,
    contextWindowOverride: cfg.contextWindowByModel?.[cfg.model],
  });
  const effectiveThinking: CoachThinkingDepth =
    params.thinkingDepth ?? cfg.thinkingDepth ?? 'default';

  const [ctxAndView, memoryStore, threadsStateInitial, currentEpoch] = await Promise.all([
    buildCoachReadOnlyContextWithView(
      params.toolContext,
      {
        includeAllHistory: false,
        historyLimit: 5,
      },
      await getCoachRestoreEpoch(),
    ),
    loadCoachMemory(),
    loadCoachThreadsState(),
    getCoachRestoreEpoch(),
  ]);
  const roCtxInitial = ctxAndView.roCtx;
  let roundFrozenView: CoachFrozenView = {
    ...ctxAndView.frozenView,
    restoreEpoch: currentEpoch,
  };
  const memoryPrompt = formatCoachMemoryForPrompt(memoryStore, 1200);
  const threadMeta = threadsStateInitial.threads.find((t) => t.id === threadId);
  const manualCompaction = threadMeta?.manualCompaction;
  let activeSegment: CoachSegmentState | undefined = threadMeta?.activeSegmentId
    ? threadMeta.segments?.[threadMeta.activeSegmentId]
    : undefined;
  let segmentEntries = activeSegment
    ? await listProtocolEntries(threadId, activeSegment.segmentId)
    : [];

  const hasPendingManualCompaction = Boolean(
    manualCompaction &&
      !manualCompaction.consumedBySegmentId &&
      activeSegment?.manualCompactionId !== manualCompaction.compactionId,
  );
  // 活跃的 manualCompaction 必须以与 keptMessages 绑定的 Vault 摘要为准，避免一拍旧的 UI params.contextSummary 覆盖形成旧摘要+新尾部
  const rawWorkingSummary =
    hasPendingManualCompaction && manualCompaction
      ? manualCompaction.summary
      : (params.contextSummary ?? threadMeta?.contextSummary);
  let workingSummary = await resolveRedactedSummaryForThread(threadId, rawWorkingSummary);

  const upsertThreadSegment = async (
    segment: CoachSegmentState,
    summaryOverride?: string,
    billingTotals?: CoachThreadBillingTotalsCache,
    consumedManualCompactionId?: string,
  ) => {
    await patchCoachThreadsState((latestState) => {
      if (!latestState.threads.some((t) => t.id === threadId)) return latestState;
      const nextThreads = latestState.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              activeSegmentId: segment.segmentId,
              ...(summaryOverride !== undefined ? { contextSummary: summaryOverride } : {}),
              ...(billingTotals ? { billingTotals } : {}),
              ...(consumedManualCompactionId &&
              t.manualCompaction?.compactionId === consumedManualCompactionId
                ? {
                    manualCompaction: {
                      ...t.manualCompaction,
                      consumedBySegmentId: segment.segmentId,
                    },
                  }
                : {}),
              segments: {
                ...(t.segments ?? {}),
                [segment.segmentId]: segment,
              },
              updatedAt: Date.now(),
            }
          : t,
      );
      return { ...latestState, threads: nextThreads };
    });
  };

  // 决定延续当前段还是开新段（仅在必要边界重算冻结基线）
  const canonicalBaseUrl = canonicalizeEndpointBaseUrl(cfg.kind, cfg.baseUrl);
  let needNewReason: CoachSegmentReason | null = null;
  if (!activeSegment) {
    needNewReason = hasPendingManualCompaction ? 'compaction' : 'initial';
  } else if (
    params.history.length === 0 &&
    segmentEntries.length > 0 &&
    !hasPendingManualCompaction
  ) {
    needNewReason = 'initial';
  } else if (
    activeSegment.restoreEpoch !== undefined &&
    activeSegment.restoreEpoch !== currentEpoch
  ) {
    needNewReason = 'restore_backup';
  } else if (
    activeSegment.deploymentId !== caps.deploymentId ||
    activeSegment.providerKind !== cfg.kind ||
    activeSegment.model !== cfg.model ||
    (activeSegment.baseUrl !== undefined && activeSegment.baseUrl !== canonicalBaseUrl)
  ) {
    needNewReason = 'protocol_or_deployment_switch';
  } else if (
    roCtxInitial.activeSession?.id &&
    activeSegment.lastSyncedSessionId &&
    activeSegment.lastSyncedSessionId !== roCtxInitial.activeSession.id
  ) {
    needNewReason = 'new_session';
  } else if (
    activeSegment.containsAssistantWithoutReasoning &&
    caps.requiresReasoningReplayWithTools &&
    effectiveThinking !== 'off'
  ) {
    needNewReason = 'thinking_replay_boundary';
  } else if (
    hasPendingManualCompaction ||
    (workingSummary && !activeSegment.baselineSnapshotJson.includes(workingSummary))
  ) {
    needNewReason = 'compaction';
  }

  let prevCheckpoint: CoachSegmentCheckpoint | undefined;
  if (needNewReason) {
    // 同一路由（含合法 thinking_replay_boundary 切段）保留护栏且绝不携带旧段工具轨迹；仅作为纯文本鲜明角色上下文引用随基线冻结
    const applyManualCompactionCarryover =
      hasPendingManualCompaction &&
      Boolean(manualCompaction) &&
      (needNewReason === 'compaction' || needNewReason === 'thinking_replay_boundary');
    let carriedMessages: CoachManualCompactionKeptMessage[] | undefined;
    if (applyManualCompactionCarryover && manualCompaction?.keptMessages.length) {
      const redactionOverlay = await loadMessageRedactionOverlay();
      carriedMessages = manualCompaction.keptMessages.map((item) => {
        const overlayText = redactionOverlay[item.id]?.text ?? item.text;
        return {
          ...item,
          text: scrubTextWithRecentPurges(overlayText, 'plain'),
        };
      });
    }
    const opened = await openFreshSegmentState({
      threadId,
      reason: needNewReason,
      restoreEpoch: currentEpoch,
      cfg,
      caps,
      effectiveThinking,
      roCtx: roCtxInitial,
      memoryPrompt,
      contextSummary: workingSummary,
      ...(carriedMessages?.length ? { carriedMessages } : {}),
    });
    activeSegment = applyManualCompactionCarryover && manualCompaction
      ? { ...opened.segment, manualCompactionId: manualCompaction.compactionId }
      : opened.segment;
    prevCheckpoint = opened.checkpoint;
    segmentEntries = [];

    // v0.2.2 升级兼容：仅首次从无段无协议条目旧对话升级时导入一次；切段/思考边界/恢复/压缩绝不回灌缺失原生轨迹的旧气泡
    const existingThreadProtoCount =
      needNewReason === 'initial' && !threadMeta?.activeSegmentId && Object.keys(threadMeta?.segments ?? {}).length === 0
        ? (await listProtocolEntries(threadId)).length
        : 1;
    if (
      needNewReason === 'initial' &&
      !threadMeta?.activeSegmentId &&
      Object.keys(threadMeta?.segments ?? {}).length === 0 &&
      existingThreadProtoCount === 0 &&
      params.history.length > 0
    ) {
      const legacyOverlay = await loadMessageRedactionOverlay();
      const legacyMsgs = params.history
        .filter((m) => !m.isDemo && !m.compressed)
        .map((m) => applyMessageRedactionProjection(m, legacyOverlay));
      const seededEntries: CoachProtocolEntry[] = [];
      let hadNoReasonAssistant = false;
      for (const m of legacyMsgs) {
        const seq = activeSegment.nextSeq;
        activeSegment.nextSeq += 1;
        if (m.role === 'user') {
          seededEntries.push({
            id: `${threadId}:${activeSegment.segmentId}:${seq}`,
            threadId,
            segmentId: activeSegment.segmentId,
            seq,
            createdAt: m.createdAt,
            kind: 'user',
            wireText: m.text,
          });
        } else {
          if (!m.reasoning) hadNoReasonAssistant = true;
          seededEntries.push({
            id: `${threadId}:${activeSegment.segmentId}:${seq}`,
            threadId,
            segmentId: activeSegment.segmentId,
            seq,
            createdAt: m.createdAt,
            kind: 'assistant',
            assistantText: m.text,
            ...(m.reasoning !== undefined ? { reasoningText: m.reasoning } : {}),
          });
        }
      }
      if (hadNoReasonAssistant) activeSegment.containsAssistantWithoutReasoning = true;
      if (seededEntries.length) {
        await appendProtocolEntriesStrict(seededEntries);
        segmentEntries = seededEntries;
      }
    }
    // 无论是 compaction 正式承接还是切模型/恢复边界跨过，均消费该 compactionId，避免幂等重放或换模型后滞后泄露
    await upsertThreadSegment(
      activeSegment,
      applyManualCompactionCarryover ? workingSummary : undefined,
      undefined,
      hasPendingManualCompaction ? manualCompaction?.compactionId : undefined,
    );
    params.onSegmentChanged?.(activeSegment);
  } else if (activeSegment) {
    activeSegment.thinkingModeKey = effectiveThinking;
    const cacheKey = `${threadId}:${activeSegment.segmentId}`;
    prevCheckpoint =
      segmentCheckpointCache.get(cacheKey) ??
      activeSegment.lastSyncedCheckpoint ??
      ({
        activeSessionId: activeSegment.lastSyncedSessionId,
        activeSessionRevision: activeSegment.lastSyncedSessionRevision,
        exerciseDigests: {},
        warmupsDigest: '',
        cardioDigest: '',
        planRevisions: activeSegment.lastSyncedPlanRevisions ?? {},
        memoryHash: activeSegment.lastSyncedMemoryHash ?? '',
        setupNotesHash: activeSegment.lastSyncedSetupNotesHash ?? '',
      } as CoachSegmentCheckpoint);
  }

  const citationsByUrl = new Map<string, CoachCitation>();
  let latestUsage: CoachTokenUsage | undefined;
  const turnBillingRecords: CoachBillingRecord[] = [];
  const mergeRoundUsage = (next: CoachTokenUsage) => {
    latestUsage = {
      promptTokens: next.promptTokens ?? latestUsage?.promptTokens,
      completionTokens:
        next.completionTokens !== undefined
          ? (latestUsage?.completionTokens ?? 0) + next.completionTokens
          : latestUsage?.completionTokens,
      totalTokens: next.totalTokens ?? latestUsage?.totalTokens,
      cachedTokens: next.cachedTokens ?? latestUsage?.cachedTokens,
      cacheCreationTokens: next.cacheCreationTokens ?? latestUsage?.cacheCreationTokens,
      reasoningTokens:
        next.reasoningTokens !== undefined
          ? (latestUsage?.reasoningTokens ?? 0) + next.reasoningTokens
          : latestUsage?.reasoningTokens,
    };
    params.onUsage?.(latestUsage);
  };

  const recordBilling = async (record: CoachBillingRecord) => {
    turnBillingRecords.push(record);
    await saveBillingRecordStrict(record);
    params.onBillingRecord?.(record);
    const allThreadBills = await listBillingRecords(threadId);
    await upsertThreadSegment(activeSegment!, undefined, billingTotalsFromRecords(allThreadBills));
  };

  // 独立联网搜索（开关关闭或用户明确要求不用联网时 0 外部检索，0 search tool，不改写主请求工具集合）
  const effectiveSearchProvider = normalizeWebSearchProvider(cfg.webSearchProvider);
  const explicitNoSearch = isExplicitNoSearchCommand(params.userText);
  const webSearchAllowed = Boolean(
    params.webSearch && effectiveSearchProvider !== 'off' && !explicitNoSearch,
  );
  let externalSearchBrief = '';

  if (webSearchAllowed && shouldRunIndependentSearch(params.userText)) {
    const searchQuery = buildSearchQueryFromUserText(params.userText);
    if (searchQuery) {
      const paidReady =
        (effectiveSearchProvider === 'tavily' ||
          effectiveSearchProvider === 'bocha' ||
          effectiveSearchProvider === 'brave') &&
        Boolean(cfg.webSearchApiKey?.trim());
      if (cfg.kind === 'gemini' && !paidReady && caps.supportsNativeWebSearch) {
        try {
          const t0 = Date.now();
          const gemRes = await collectGeminiGroundedBrief(
            providerCfg,
            searchQuery,
            caps,
            params.signal,
            params.onCitations,
            mergeRoundUsage,
            citationsByUrl,
          );
          externalSearchBrief = gemRes.brief;
          await recordBilling(
            normalizeUsageToBillingRecord({
              id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              threadId,
              segmentId: activeSegment!.segmentId,
              round: 0,
              purpose: 'web_search',
              requestSource: 'model',
              capabilities: caps,
              rawUsage: gemRes.rawUsage,
              durationMs: Math.max(1, Date.now() - t0),
            }),
          );
        } catch (err) {
          if (params.signal?.aborted) throw err;
        }
      } else {
        try {
          const extSearchT0 = Date.now();
          const searchProviderUsed = paidReady ? effectiveSearchProvider : 'builtin';
          const res = await runCoachWebSearch({
            provider: searchProviderUsed,
            apiKey: paidReady ? cfg.webSearchApiKey! : '',
            query: searchQuery,
            fetchFn: getCoachFetch(),
            signal: params.signal,
          });
          for (const h of res.hits) {
            citationsByUrl.set(h.url, { title: h.title, url: h.url });
          }
          if (res.hits.length) {
            params.onCitations?.(Array.from(citationsByUrl.values()));
            externalSearchBrief = res.hits
              .slice(0, 4)
              .map((h, i) => `${i + 1}. ${h.title} (${h.url}): ${h.snippet}`)
              .join('\n');
          }
          await recordBilling(
            normalizeUsageToBillingRecord({
              id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              threadId,
              segmentId: activeSegment!.segmentId,
              round: 0,
              purpose: 'web_search',
              requestSource: 'external_search',
              searchProvider: searchProviderUsed,
              capabilities: caps,
              durationMs: Math.max(1, Date.now() - extSearchT0),
            }),
          );
        } catch (err) {
          if (params.signal?.aborted) throw err;
        }
      }
    }
  }

  // 附件处理：按模型能力区分原生视觉输入 vs 一次性结构化摘要（不向文本端发图片字节）
  const currentUserParts: CoachContentPart[] = [];
  let mediaTextBrief = '';
  let mediaStripped = false;
  const rawAttachments = (params.attachments ?? []).filter((a) => Boolean(a.dataBase64));

  if (!caps.supportsNativeVision && rawAttachments.length > 0) {
    mediaStripped = true;
    const descLines: string[] = [];
    for (const att of rawAttachments) {
      if (att.kind === 'video') {
        descLines.push(
          `[视频 ${att.name} · ${att.width}x${att.height} · ${Math.round(att.durationSec ?? 0)}s；当前文本模型不支持原片直传]`,
        );
      } else {
        descLines.push(
          `[图片 ${att.name} · ${att.width}x${att.height}；当前部署 ${cfg.model} 不支持原生识图]`,
        );
      }
    }
    mediaTextBrief = descLines.join('\n');
  } else {
    for (const att of rawAttachments) {
      if (att.kind === 'video' && !caps.supportsNativeVideo) {
        mediaTextBrief += `\n[视频 ${att.name} · ${att.width}x${att.height} · ${Math.round(att.durationSec ?? 0)}s]`;
        mediaStripped = true;
      } else {
        currentUserParts.push({
          type: att.kind === 'video' ? 'video' : 'image',
          mimeType: att.mimeType,
          dataBase64: att.dataBase64,
        });
      }
    }
  }

  // Layer 3 尾部变化增量
  const { deltaText, nextCheckpoint } = buildTurnDeltaBlock({
    prevCheckpoint,
    currentRoCtx: roCtxInitial,
    memoryPrompt,
    externalSearchBrief,
    mediaTextBrief,
  });
  const baseUserText = params.userText.trim() || (rawAttachments.length ? '请帮我看下这个附件' : '');
  const fullUserWireText = deltaText ? `${deltaText}\n\n${baseUserText}` : baseUserText;
  currentUserParts.unshift({ type: 'text', text: fullUserWireText });

  const userSeq = activeSegment!.nextSeq;
  activeSegment!.nextSeq += 1;
  const currentUserEntry: CoachProtocolEntry = {
    id: `${threadId}:${activeSegment!.segmentId}:${userSeq}`,
    threadId,
    segmentId: activeSegment!.segmentId,
    seq: userSeq,
    createdAt: Date.now(),
    kind: 'user',
    wireText: fullUserWireText,
    ...(rawAttachments.length && !mediaStripped ? { attachments: rawAttachments } : {}),
    ...(mediaStripped ? { mediaStripped: true } : {}),
  };

  let currentCheckpoint: CoachSegmentCheckpoint = nextCheckpoint;
  segmentCheckpointCache.set(`${threadId}:${activeSegment!.segmentId}`, currentCheckpoint);
  activeSegment!.lastSyncedSessionId = currentCheckpoint.activeSessionId;
  activeSegment!.lastSyncedSessionRevision = currentCheckpoint.activeSessionRevision;
  activeSegment!.lastSyncedPlanRevisions = currentCheckpoint.planRevisions;
  activeSegment!.lastSyncedMemoryHash = currentCheckpoint.memoryHash;
  activeSegment!.lastSyncedCheckpoint = currentCheckpoint;

  let workingMemoryPrompt = memoryPrompt;
  let seenPurgeGen = memoryPurgeGeneration;

  const tools = sortToolDefinitionsStably(COACH_TOOL_DEFINITIONS);

  const rebuildWireConversation = (entries: CoachProtocolEntry[]): CoachTurnMessage[] => {
    const msgs: CoachTurnMessage[] = [
      { role: 'system', text: STATIC_COACH_SYSTEM_PROMPT, cacheControl: 'ephemeral' },
      {
        role: 'user',
        parts: [{ type: 'text', text: activeSegment!.baselineSnapshotJson }],
        isSegmentBaseline: true,
        cacheControl: 'ephemeral',
      },
    ];
    for (const e of entries) {
      const m = protocolEntryToTurnMessage(e);
      if (m) msgs.push(m);
    }
    return msgs;
  };

  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let pendingTurn: CoachPendingTurn = {
    turnId,
    threadId,
    segmentId: activeSegment!.segmentId,
    status: 'running_model',
    round: 0,
    userMessageId: currentUserEntry.id,
    userPromptText: baseUserText,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    restoreEpoch: currentEpoch,
    providerKind: cfg.kind,
    ...(cfg.presetId ? { presetId: cfg.presetId } : {}),
    baseUrl: canonicalBaseUrl,
    deploymentId: caps.deploymentId,
    model: cfg.model,
    thinkingDepth: effectiveThinking,
    webSearchUsed: Boolean(externalSearchBrief),
    frozenView: structuredClone(roundFrozenView),
  };

  // Phase 1：先持久化用户条目与 pendingTurn，再发出首次模型请求
  await appendProtocolEntriesStrict([currentUserEntry]);
  segmentEntries.push(currentUserEntry);
  await savePendingTurnStrict(pendingTurn);
  params.onPendingTurnChange?.(pendingTurn);
  await upsertThreadSegment(activeSegment!);

  const receipts: CoachOperationReceipt[] = [];
  let draftPlan: CoachPlanDraft | undefined;
  let accumulatedText = '';
  let accumulatedReasoning = '';
  let usedDefaultThinking = false;
  const fullPrefixPayloadCache = { lastInputTokens: 0 };
  const turnStartMs = Date.now();
  let firstTokenMs: number | null = null;
  let roundsExecuted = 0;

  const systemPromptDigest = saltedPrefixDigest(threadId, STATIC_COACH_SYSTEM_PROMPT);
  const toolsJsonString = JSON.stringify(tools);
  const toolsDigest = saltedPrefixDigest(threadId, toolsJsonString);

  const syncActiveTurnIfMemoryPurged = async (): Promise<MemoryScrubSpec | null> => {
    if (seenPurgeGen === memoryPurgeGeneration) return null;
    const missedEvents = recentPurgeEvents.filter((ev) => ev.gen > seenPurgeGen);
    const missedNeedles = missedEvents.flatMap((ev) => ev.needles);
    const missedMemoryId = missedEvents.find((ev) => ev.memoryId)?.memoryId;
    const scrubSpec = buildMemoryScrubSpec(missedNeedles, missedMemoryId);
    seenPurgeGen = memoryPurgeGeneration;

    const latestThreads = await loadCoachThreadsState();
    const tMeta = latestThreads.threads.find((t) => t.id === threadId);
    const reloadedSeg = tMeta?.activeSegmentId ? tMeta.segments?.[tMeta.activeSegmentId] : undefined;
    if (reloadedSeg) {
      activeSegment = reloadedSeg;
      params.onSegmentChanged?.(reloadedSeg);
    } else if (activeSegment && (scrubSpec.needles.length || scrubSpec.memoryId)) {
      const scrubbedBaseline = scrubBaselineSnapshot(activeSegment.baselineSnapshotJson, scrubSpec);
      activeSegment = {
        ...activeSegment,
        baselineSnapshotJson: scrubbedBaseline,
        baselineSnapshotHash: hashTextCompact(scrubbedBaseline),
      };
    }
    const persistedEntries = await listProtocolEntries(threadId, activeSegment!.segmentId);
    if (persistedEntries.length) {
      segmentEntries = persistedEntries;
    } else if (scrubSpec.needles.length || scrubSpec.memoryId) {
      const taintedIds = collectTaintedMemorySaveCallIds(segmentEntries, scrubSpec);
      segmentEntries = segmentEntries.map((e) => scrubProtocolEntryWithSpec(e, scrubSpec, taintedIds).entry);
    }
    const reloadedPending = await getPendingTurn(pendingTurn.turnId);
    if (reloadedPending) {
      pendingTurn = reloadedPending;
    } else if (pendingTurn.segmentId !== activeSegment!.segmentId) {
      pendingTurn = { ...pendingTurn, segmentId: activeSegment!.segmentId };
    }
    if (scrubSpec.needles.length) {
      accumulatedText = scrubPlainTextWithSpec(accumulatedText, scrubSpec);
      accumulatedReasoning = scrubPlainTextWithSpec(accumulatedReasoning, scrubSpec);
      if (workingSummary) workingSummary = scrubPlainTextWithSpec(workingSummary, scrubSpec);
    }
    workingMemoryPrompt = formatCoachMemoryForPrompt(await loadCoachMemory(), 1200);
    const refreshedMemHash = hashTextCompact(workingMemoryPrompt.trim());
    currentCheckpoint = { ...currentCheckpoint, memoryHash: refreshedMemHash };
    segmentCheckpointCache.set(`${threadId}:${activeSegment!.segmentId}`, currentCheckpoint);
    activeSegment!.lastSyncedMemoryHash = refreshedMemHash;
    activeSegment!.lastSyncedCheckpoint = currentCheckpoint;
    return scrubSpec;
  };

  const executePlannedStep = async (
    step: CoachPendingPlannedToolCall,
    execCtxBase: CoachToolExecutionContext,
  ) => {
    return executeCoachToolCall(
      {
        id: step.toolCallId,
        operationId: step.operationId,
        index: step.index,
        name: step.name,
        argumentsText: step.argumentsText,
        arguments: step.args,
        ...(step.thoughtSignature ? { thoughtSignature: step.thoughtSignature } : {}),
      },
      {
        ...execCtxBase,
        expectedEpoch: step.expectedEpoch ?? execCtxBase.expectedEpoch,
        ...(step.modelExpectedRevision !== undefined
          ? { modelExpectedRevision: step.modelExpectedRevision }
          : {}),
        ...(step.modelExpectedPlanRevision !== undefined
          ? { modelExpectedPlanUpdatedAt: step.modelExpectedPlanRevision }
          : {}),
        ...(step.frozenPrecondition ? { frozenPrecondition: step.frozenPrecondition } : {}),
        ...(step.priorBatchOpIds?.length ? { priorBatchOpIds: step.priorBatchOpIds } : {}),
        ...(step.strictSessionRevision ? { strictSessionRevision: true } : {}),
        requireFrozenPreconditions: true,
      },
    );
  };

  try {
    for (let round = 0; round < 6; round += 1) {
      if (params.signal?.aborted) {
        const citations = Array.from(citationsByUrl.values());
        return {
          text: accumulatedText,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          receipts,
          ...(latestUsage ? { usage: latestUsage } : {}),
          ...(citations.length ? { citations } : {}),
          segmentId: activeSegment!.segmentId,
          billingRecords: turnBillingRecords,
          aborted: true,
        };
      }

      pendingTurn = {
        ...pendingTurn,
        round,
        status:
          round === 0
            ? 'running_model'
            : pendingTurn.status === 'awaiting_confirmation'
              ? 'awaiting_confirmation'
              : 'awaiting_followup_model',
      };
      await savePendingTurnStrict(pendingTurn);
      params.onPendingTurnChange?.(pendingTurn);

      await syncActiveTurnIfMemoryPurged();
      let wireMessages = rebuildWireConversation(segmentEntries);
      let estInput = estimateConversationTokens(wireMessages, toolsJsonString);
      fullPrefixPayloadCache.lastInputTokens = estInput;
      let hardCheck = checkHardContextBudget({
        estimatedInputTokens: estInput,
        model: cfg.model,
        advertisedMaxTokens: cfg.contextWindowByModel?.[cfg.model],
        reservedOutputTokens: caps.maxOutputTokens,
      });

      if (hardCheck.exceedsHardLimit) {
        if (round === 0 && segmentEntries.length >= 4) {
          // Round 0 尚未提交任何工具：安全摘要早期对话并开启干净新段
          const comp = await compressCoachContext({
            threadId,
            messages: params.history,
            existingSummary: workingSummary,
            providerConfig: cfg,
            keepRecent: 2,
            signal: params.signal,
          });
          workingSummary = comp.summary;
          const freshWithView = await buildCoachReadOnlyContextWithView(
            params.toolContext,
            { includeAllHistory: false, historyLimit: 5 },
            currentEpoch,
          );
          roundFrozenView = { ...freshWithView.frozenView, restoreEpoch: currentEpoch };
          pendingTurn = { ...pendingTurn, frozenView: structuredClone(roundFrozenView) };
          const freshMem = formatCoachMemoryForPrompt(await loadCoachMemory(), 1200);
          const opened = await openFreshSegmentState({
            threadId,
            reason: 'compaction',
            restoreEpoch: currentEpoch,
            cfg,
            caps,
            effectiveThinking,
            roCtx: freshWithView.roCtx,
            memoryPrompt: freshMem,
            contextSummary: workingSummary,
          });
          activeSegment = opened.segment;
          currentCheckpoint = opened.checkpoint;
          workingMemoryPrompt = freshMem;
          const compUserSeq = activeSegment.nextSeq;
          activeSegment.nextSeq += 1;
          const carryUser: CoachProtocolEntry = {
            ...currentUserEntry,
            id: `${threadId}:${activeSegment.segmentId}:${compUserSeq}`,
            segmentId: activeSegment.segmentId,
            seq: compUserSeq,
          };
          await appendProtocolEntriesStrict([carryUser]);
          segmentEntries = [carryUser];
          await upsertThreadSegment(activeSegment, workingSummary);
          params.onSegmentChanged?.(activeSegment);
          wireMessages = rebuildWireConversation(segmentEntries);
          estInput = estimateConversationTokens(wireMessages, toolsJsonString);
          fullPrefixPayloadCache.lastInputTokens = estInput;
        } else if (round >= 1) {
          // Round >= 1 已有本轮工具提交：绝不丢弃 tool 轨迹回退成裸 user！
          const currentTurnEntries = segmentEntries.filter((e) => e.seq >= currentUserEntry.seq);
          const earlierEntries = segmentEntries.filter((e) => e.seq < currentUserEntry.seq);
          if (earlierEntries.length >= 2) {
            const comp = await compressCoachContext({
              threadId,
              messages: params.history,
              existingSummary: workingSummary,
              providerConfig: cfg,
              keepRecent: 2,
              signal: params.signal,
            });
            workingSummary = comp.summary;
            const opened = await openFreshSegmentState({
              threadId,
              reason: 'compaction',
              restoreEpoch: currentEpoch,
              cfg,
              caps,
              effectiveThinking,
              roCtx: roCtxInitial,
              memoryPrompt: workingMemoryPrompt,
              contextSummary: workingSummary,
            });
            activeSegment = {
              ...opened.segment,
              lastSyncedSessionId: currentCheckpoint.activeSessionId,
              lastSyncedSessionRevision: currentCheckpoint.activeSessionRevision,
              lastSyncedPlanRevisions: currentCheckpoint.planRevisions,
              lastSyncedMemoryHash: currentCheckpoint.memoryHash,
              lastSyncedCheckpoint: currentCheckpoint,
            };
            segmentCheckpointCache.set(`${threadId}:${activeSegment.segmentId}`, currentCheckpoint);
            const seqRemap = new Map<number, number>();
            const copiedTurnEntries: CoachProtocolEntry[] = currentTurnEntries.map((entry) => {
              const nextSeq = activeSegment!.nextSeq;
              activeSegment!.nextSeq += 1;
              seqRemap.set(entry.seq, nextSeq);
              return {
                ...entry,
                id: `${threadId}:${activeSegment!.segmentId}:${nextSeq}`,
                segmentId: activeSegment!.segmentId,
                seq: nextSeq,
              };
            });
            await appendProtocolEntriesStrict(copiedTurnEntries);
            segmentEntries = copiedTurnEntries;
            pendingTurn = {
              ...pendingTurn,
              segmentId: activeSegment.segmentId,
              userMessageId: copiedTurnEntries[0]?.id ?? pendingTurn.userMessageId,
              ...(pendingTurn.assistantEntrySeq !== undefined
                ? { assistantEntrySeq: seqRemap.get(pendingTurn.assistantEntrySeq) ?? pendingTurn.assistantEntrySeq }
                : {}),
              ...(pendingTurn.plannedToolCalls
                ? {
                    plannedToolCalls: pendingTurn.plannedToolCalls.map((pc) => ({
                      ...pc,
                      ...(pc.toolEntrySeq !== undefined
                        ? { toolEntrySeq: seqRemap.get(pc.toolEntrySeq) ?? pc.toolEntrySeq }
                        : {}),
                    })),
                  }
                : {}),
            };
            await savePendingTurnStrict(pendingTurn);
            await upsertThreadSegment(activeSegment, workingSummary);
            params.onSegmentChanged?.(activeSegment);
            wireMessages = rebuildWireConversation(segmentEntries);
            estInput = estimateConversationTokens(wireMessages, toolsJsonString);
            fullPrefixPayloadCache.lastInputTokens = estInput;
            hardCheck = checkHardContextBudget({
              estimatedInputTokens: estInput,
              model: cfg.model,
              advertisedMaxTokens: cfg.contextWindowByModel?.[cfg.model],
              reservedOutputTokens: caps.maxOutputTokens,
            });
          }
          if (hardCheck.exceedsHardLimit) {
            // 仅在本轮工具结果本身超限时裁剪 tool 消息中的重型 data 负载，完整保留 assistant(tool_calls)+tool 配对
            wireMessages = wireMessages.map((m) => {
              if (m.role !== 'tool') return m;
              try {
                const parsed = JSON.parse(m.content) as Record<string, unknown>;
                if (parsed && typeof parsed === 'object' && 'data' in parsed && m.content.length > 600) {
                  const compactPayload = {
                    ok: parsed.ok ?? true,
                    summary: typeof parsed.summary === 'string' ? parsed.summary : '已完成查询',
                    ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
                    ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
                    truncatedForBudget: true,
                  };
                  return { ...m, content: JSON.stringify(compactPayload) };
                }
              } catch {
                /* keep raw */
              }
              return m.content.length > 1200
                ? {
                    ...m,
                    content: JSON.stringify({
                      ok: true,
                      summary: m.content.slice(0, 400),
                      truncatedForBudget: true,
                    }),
                  }
                : m;
            });
            estInput = estimateConversationTokens(wireMessages, toolsJsonString);
            fullPrefixPayloadCache.lastInputTokens = estInput;
            hardCheck = checkHardContextBudget({
              estimatedInputTokens: estInput,
              model: cfg.model,
              advertisedMaxTokens: cfg.contextWindowByModel?.[cfg.model],
              reservedOutputTokens: caps.maxOutputTokens,
            });
            if (hardCheck.exceedsHardLimit) {
              await savePendingTurnStrict({
                ...pendingTurn,
                status: 'awaiting_followup_model',
                lastError: hardCheck.reason ?? '工具结果超出模型硬上下文上限，已保留已提交结果，请手动压缩后重试确认',
              });
              params.onPendingTurnChange?.(pendingTurn);
              return {
                text: receipts.length
                  ? `已完成 ${receipts.length} 项写入，但工具返回超出当前上下文硬上限，已保留恢复状态（未重复执行）。`
                  : hardCheck.reason ?? '上下文超出模型硬上限，已保留恢复状态。',
                ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
                receipts,
                ...(latestUsage ? { usage: latestUsage } : {}),
                segmentId: activeSegment!.segmentId,
                billingRecords: turnBillingRecords,
                pendingTurn,
                errorMessage: hardCheck.reason,
                aborted: false,
              };
            }
          }
        }
      }

      const prefixKey = `${threadId}:${activeSegment!.segmentId}`;
      const prevWire = lastWireStateBySegment.get(prefixKey);
      let exactPrefixMatchedPrevRound = false;
      if (prevWire && wireMessages.length >= prevWire.msgCount) {
        const sharedSliceDigest = saltedPrefixDigest(
          threadId,
          JSON.stringify({
            system: STATIC_COACH_SYSTEM_PROMPT,
            tools,
            messages: wireMessages.slice(0, prevWire.msgCount),
          }),
        );
        exactPrefixMatchedPrevRound = sharedSliceDigest === prevWire.fullDigest;
      }
      const fullPrefixPayload = JSON.stringify({
        system: STATIC_COACH_SYSTEM_PROMPT,
        tools,
        messages: wireMessages,
      });
      const prefixDigest = saltedPrefixDigest(threadId, fullPrefixPayload);
      lastWireStateBySegment.set(prefixKey, {
        msgCount: wireMessages.length,
        fullDigest: prefixDigest,
      });

      const outboundPairing = validateOutboundToolPairing(wireMessages);
      if (!outboundPairing.ok) {
        pendingTurn = {
          ...pendingTurn,
          lastError: outboundPairing.reason,
        };
        await savePendingTurnStrict(pendingTurn);
        params.onPendingTurnChange?.(pendingTurn);
        return {
          text: accumulatedText || `出站工具消息配对校验未通过：${outboundPairing.reason}（已阻断模型请求，未写入数据）`,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          receipts,
          ...(latestUsage ? { usage: latestUsage } : {}),
          errorMessage: outboundPairing.reason,
          segmentId: activeSegment!.segmentId,
          billingRecords: turnBillingRecords,
          pendingTurn,
          aborted: false,
        };
      }

      let roundText = '';
      let roundReasoning = '';
      let doneOutcomeKind: CoachStreamOutcomeKind = 'completed_text';
      let doneErrorMessage: string | undefined;
      let doneToolCalls: CoachToolCall[] = [];
      let doneRawUsage: Record<string, unknown> | undefined;
      let doneAnthropicBlocks: Array<Record<string, unknown>> | undefined;
      let doneGeminiParts: Array<Record<string, unknown>> | undefined;
      const reqStartMs = Date.now();
      let reqFirstTokenMs: number | undefined;
      roundsExecuted += 1;

      for await (const ev of streamCoachTurn(providerCfg, wireMessages, tools, {
        signal: params.signal,
        thinkingDepth: usedDefaultThinking ? 'default' : effectiveThinking,
        allowThinkingFallback: round === 0,
        requestTitle: false,
        webSearch: false,
        includeUsage: true,
        promptCacheKey: `motion:${caps.deploymentId}:${threadId}:${activeSegment!.segmentId}`,
        anthropicCacheControl: caps.sendCacheControlBreakpoints,
        capabilities: caps,
      })) {
        if (ev.type === 'title') {
          params.onTitle?.(ev.title);
        } else if (ev.type === 'thinking_fallback') {
          usedDefaultThinking = true;
          params.onThinkingFallback?.();
        } else if (ev.type === 'reasoning_delta') {
          if (firstTokenMs === null && ev.delta) firstTokenMs = Date.now();
          if (reqFirstTokenMs === undefined && ev.delta) reqFirstTokenMs = Date.now();
          roundReasoning += ev.delta;
          params.onReasoningChunk?.(accumulatedReasoning + roundReasoning);
        } else if (ev.type === 'text_delta') {
          if (firstTokenMs === null && ev.delta) firstTokenMs = Date.now();
          if (reqFirstTokenMs === undefined && ev.delta) reqFirstTokenMs = Date.now();
          roundText += ev.delta;
          params.onTextChunk?.(accumulatedText + roundText);
        } else if (ev.type === 'done') {
          doneOutcomeKind = ev.outcomeKind;
          doneErrorMessage = ev.errorMessage;
          doneToolCalls = ev.toolCalls;
          doneRawUsage = ev.rawUsage;
          doneAnthropicBlocks = ev.anthropicBlocks;
          doneGeminiParts = ev.geminiParts;
          if (ev.usage) mergeRoundUsage(ev.usage);
          if (ev.citations?.length) {
            for (const c of ev.citations) citationsByUrl.set(c.url, c);
            params.onCitations?.(Array.from(citationsByUrl.values()));
          }
        }
      }

      const completedSetOpsInRound: string[] = [];
      const reqDurationMs = Math.max(1, Date.now() - reqStartMs);

      // 若请求在途期间用户删除了记忆，写盘前先把本轮内存缓冲按新增敏感词净空并切到新段
      const streamPurgeSpec = await syncActiveTurnIfMemoryPurged();
      if (streamPurgeSpec && (streamPurgeSpec.needles.length || streamPurgeSpec.memoryId)) {
        roundText = scrubPlainTextWithSpec(roundText, streamPurgeSpec);
        roundReasoning = scrubPlainTextWithSpec(roundReasoning, streamPurgeSpec);
        if (doneAnthropicBlocks?.length) {
          doneAnthropicBlocks = doneAnthropicBlocks.map(
            (b) => deepScrubMemoryValueWithSpec(b, streamPurgeSpec) as Record<string, unknown>,
          );
        }
        if (doneGeminiParts?.length) {
          doneGeminiParts = doneGeminiParts.map(
            (p) => deepScrubMemoryValueWithSpec(p, streamPurgeSpec) as Record<string, unknown>,
          );
        }
      }

      // 拦截未闭合流/截断/畸形 JSON/伪造 ID：0 执行，0 落库，保护训练状态
      if (
        doneOutcomeKind === 'truncated_eof' ||
        doneOutcomeKind === 'truncated_max_tokens' ||
        doneOutcomeKind === 'malformed_tool_call'
      ) {
        await recordBilling(
          normalizeUsageToBillingRecord({
            id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            threadId,
            segmentId: activeSegment!.segmentId,
            turnId,
            round,
            purpose: 'coach_turn',
            capabilities: caps,
            rawUsage: doneRawUsage,
            prefixDigest,
            systemPromptDigest,
            toolsDigest,
            prefixByteLength: fullPrefixPayload.length,
            exactPrefixMatchedPrevRound,
            durationMs: reqDurationMs,
            ttftMs: reqFirstTokenMs ? Math.max(1, reqFirstTokenMs - reqStartMs) : undefined,
          }),
        );
        const keepAwaitingConfirmation =
          round > 0 && Boolean(pendingTurn.plannedToolCalls?.some((c) => c.status === 'committed'));
        pendingTurn = {
          ...pendingTurn,
          status: keepAwaitingConfirmation ? 'awaiting_followup_model' : 'failed',
          lastError: doneErrorMessage ?? '流式响应未完整闭合',
        };
        await savePendingTurnStrict(pendingTurn);
        params.onPendingTurnChange?.(pendingTurn);
        const msg = doneErrorMessage || '模型响应在流式传输中异常中断，为防止残缺参数破坏训练记录，本次未执行任何修改。';
        return {
          text: accumulatedText || msg,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          receipts,
          ...(latestUsage ? { usage: latestUsage } : {}),
          outcomeKind: doneOutcomeKind,
          errorMessage: msg,
          segmentId: activeSegment!.segmentId,
          billingRecords: turnBillingRecords,
          pendingTurn,
          aborted: false,
        };
      }

      accumulatedReasoning += roundReasoning;
      accumulatedText += roundText;

      // 无工具调用：写完最终助手协议项，标记 pendingTurn 完成并清理
      if (doneToolCalls.length === 0) {
        await recordBilling(
          normalizeUsageToBillingRecord({
            id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            threadId,
            segmentId: activeSegment!.segmentId,
            turnId,
            round,
            purpose: 'coach_turn',
            capabilities: caps,
            rawUsage: doneRawUsage,
            prefixDigest,
            systemPromptDigest,
            toolsDigest,
            prefixByteLength: fullPrefixPayload.length,
            exactPrefixMatchedPrevRound,
            durationMs: reqDurationMs,
            ttftMs: reqFirstTokenMs ? Math.max(1, reqFirstTokenMs - reqStartMs) : undefined,
          }),
        );

        const asstSeq = activeSegment!.nextSeq;
        activeSegment!.nextSeq += 1;
        if (!roundReasoning) {
          activeSegment!.containsAssistantWithoutReasoning = true;
        }
        const finalAsstEntry: CoachProtocolEntry = {
          id: `${threadId}:${activeSegment!.segmentId}:${asstSeq}`,
          threadId,
          segmentId: activeSegment!.segmentId,
          seq: asstSeq,
          createdAt: Date.now(),
          kind: 'assistant',
          assistantText: roundText,
          ...(roundReasoning ? { reasoningText: roundReasoning } : {}),
          ...(doneAnthropicBlocks?.length ? { anthropicBlocks: doneAnthropicBlocks } : {}),
          ...(doneGeminiParts?.length ? { geminiParts: doneGeminiParts } : {}),
        };
        await appendProtocolEntriesStrict([finalAsstEntry]);
        segmentEntries.push(finalAsstEntry);
        await upsertThreadSegment(activeSegment!);
        break;
      }

      // 整批参数 Schema / ID / 授权预校验
      const batchCheck = validateToolCallBatch(doneToolCalls, ALLOWED_BUSINESS_TOOL_NAMES);
      if (!batchCheck.ok) {
        await recordBilling(
          normalizeUsageToBillingRecord({
            id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            threadId,
            segmentId: activeSegment!.segmentId,
            turnId,
            round,
            purpose: 'coach_turn',
            capabilities: caps,
            rawUsage: doneRawUsage,
            prefixDigest,
            systemPromptDigest,
            toolsDigest,
            prefixByteLength: fullPrefixPayload.length,
            exactPrefixMatchedPrevRound,
            durationMs: reqDurationMs,
            ttftMs: reqFirstTokenMs ? Math.max(1, reqFirstTokenMs - reqStartMs) : undefined,
          }),
        );
        pendingTurn = {
          ...pendingTurn,
          status: 'failed',
          lastError: batchCheck.reason,
        };
        await savePendingTurnStrict(pendingTurn);
        params.onPendingTurnChange?.(pendingTurn);
        return {
          text: accumulatedText || `工具参数校验未通过：${batchCheck.reason}（整批已拦截，0 写入）`,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          receipts,
          ...(latestUsage ? { usage: latestUsage } : {}),
          outcomeKind: 'malformed_tool_call',
          errorMessage: batchCheck.reason,
          segmentId: activeSegment!.segmentId,
          billingRecords: turnBillingRecords,
          pendingTurn,
          aborted: false,
        };
      }

      // Phase 2：在执行第 0 步前先基于本轮模型所见冻结视图锁定目标 ID、前置版本/字段条件与确定 seq 槽位
      const baseSeq = Math.max(
        activeSegment!.nextSeq,
        segmentEntries.reduce((m, e) => Math.max(m, e.seq), 0) + 1,
      );
      const plannedCalls: CoachPendingPlannedToolCall[] = freezeToolBatchAgainstView({
        calls: doneToolCalls,
        frozenView: roundFrozenView,
        turnId,
        round,
        baseSeq,
        restoreEpoch: currentEpoch,
      });

      if (!roundReasoning) {
        activeSegment!.containsAssistantWithoutReasoning = true;
      }
      const protoToolCalls: CoachProtocolToolCall[] = doneToolCalls.map((c, idx) => ({
        id: c.id,
        index: c.index ?? idx,
        name: c.name,
        argumentsText: c.argumentsText,
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      }));
      const assistantEntrySnapshot: Omit<CoachProtocolEntry, 'id' | 'threadId' | 'segmentId' | 'seq'> = {
        createdAt: Date.now(),
        kind: 'assistant',
        assistantText: roundText,
        ...(roundReasoning ? { reasoningText: roundReasoning } : {}),
        toolCalls: protoToolCalls,
        ...(doneAnthropicBlocks?.length ? { anthropicBlocks: doneAnthropicBlocks } : {}),
        ...(doneGeminiParts?.length ? { geminiParts: doneGeminiParts } : {}),
      };
      const asstToolEntry: CoachProtocolEntry = {
        id: `${threadId}:${activeSegment!.segmentId}:${baseSeq}`,
        threadId,
        segmentId: activeSegment!.segmentId,
        seq: baseSeq,
        ...assistantEntrySnapshot,
      };
      activeSegment!.nextSeq = baseSeq + 1 + doneToolCalls.length;
      const nextPendingWithIntent: CoachPendingTurn = {
        ...pendingTurn,
        round,
        status: 'awaiting_tools',
        assistantEntrySeq: baseSeq,
        assistantEntrySnapshot,
        plannedToolCalls: plannedCalls,
      };
      pendingTurn = await commitToolBatchIntentAtomic({
        pendingTurn: nextPendingWithIntent,
        entries: [asstToolEntry],
        segmentUpdate: { threadId, segment: activeSegment! },
      });
      segmentEntries.push(asstToolEntry);
      params.onSegmentChanged?.(activeSegment!);
      params.onPendingTurnChange?.(pendingTurn);

      const deferredTimers: CoachRestTimerDirective[] = [];
      const roundToolContext: CoachToolExecutionContext = {
        ...params.toolContext,
        activeThreadId: threadId,
        expectedEpoch: currentEpoch,
        deferTimerDispatch: true,
        requireFrozenPreconditions: true,
        isWebSearchAllowed: () => webSearchAllowed,
      };

      for (let i = 0; i < plannedCalls.length; i += 1) {
        if (params.signal?.aborted) throw abortError();
        const plannedStep = plannedCalls[i];
        const outcome = await executePlannedStep(plannedStep, roundToolContext);
        roundFrozenView = advanceFrozenViewForToolOutcome({
          frozenView: roundFrozenView,
          toolName: plannedStep.name,
          toolArgs: plannedStep.args,
          outcome,
        });
        currentCheckpoint = advanceCheckpointForToolOutcome({
          checkpoint: currentCheckpoint,
          toolName: plannedStep.name,
          toolArgs: plannedStep.args,
          outcome,
          templatesById: roundFrozenView.templatesById,
          formatMemoryPrompt: (store) => formatCoachMemoryForPrompt(store, 1200),
        });
        if (outcome.draftPlan && !draftPlan && !params.signal?.aborted) {
          draftPlan = outcome.draftPlan;
          params.onDraftPlan?.(draftPlan);
          pendingTurn = {
            ...pendingTurn,
            status: 'awaiting_confirmation',
            pendingDraftPlan: draftPlan,
          };
        }
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
          if (outcome.receipt.toolName === 'record_active_set' && outcome.ok) {
            completedSetOpsInRound.push(outcome.receipt.operationId);
          }
        }
        if (outcome.timerDirective) {
          deferredTimers.push(outcome.timerDirective);
        }

        const projectedJson = JSON.stringify(projectToolOutcomeForModel(plannedStep.name, outcome));
        plannedCalls[i] = {
          ...plannedStep,
          status: outcome.ok ? 'committed' : 'failed',
          ...(outcome.receipt ? { receiptId: outcome.receipt.id, afterRevision: outcome.receipt.afterRevision } : {}),
          outcomeJson: projectedJson,
          ...(!outcome.ok ? { errorText: outcome.summary } : {}),
        };
        const toolSeq = plannedStep.toolEntrySeq ?? baseSeq + 1 + i;
        const toolEntry: CoachProtocolEntry = {
          id: `${threadId}:${activeSegment!.segmentId}:${toolSeq}`,
          threadId,
          segmentId: activeSegment!.segmentId,
          seq: toolSeq,
          createdAt: Date.now(),
          kind: 'tool',
          toolCallId: plannedStep.toolCallId,
          toolName: plannedStep.name,
          toolResultText: projectedJson,
          toolError: !outcome.ok,
        };
        pendingTurn = await commitToolStepOutcomeAtomic({
          entries: [toolEntry],
          pendingTurn: {
            ...pendingTurn,
            plannedToolCalls: [...plannedCalls],
            frozenView: structuredClone(roundFrozenView),
          },
        });
        segmentEntries.push(toolEntry);
        params.onPendingTurnChange?.(pendingTurn);

        if (outcome.deletedMemory) {
          await purgeDeletedMemoryFromCoachHistory({
            memoryId: outcome.deletedMemory.id,
            memoryTitle: outcome.deletedMemory.title,
            memoryContent: outcome.deletedMemory.content,
          });
          await syncActiveTurnIfMemoryPurged();
        }
      }

      if (pendingTurn.status !== 'awaiting_confirmation') {
        pendingTurn = {
          ...pendingTurn,
          round: round + 1,
          status: 'awaiting_followup_model',
          frozenView: structuredClone(roundFrozenView),
        };
        await savePendingTurnStrict(pendingTurn);
        params.onPendingTurnChange?.(pendingTurn);
      }

      // 整批仅在全部工具落盘完成后对最后一个计时指令触发一次 UI/原生排程
      if (deferredTimers.length > 0 && !params.signal?.aborted) {
        const lastTimer = deferredTimers[deferredTimers.length - 1];
        const targetSid =
          params.toolContext.activeSession?.id ??
          receipts.find((r) => r.operationId === lastTimer.operationId)?.entityId;
        const rt = getActiveSessionRuntime(targetSid);
        if (
          rt &&
          shouldDispatchCoachOpTimer({
            replayed: false,
            nativeScheduled: false,
            isFinalTimerInBatch: true,
          })
        ) {
          if (rt.startRestTimerWithDirective) {
            rt.startRestTimerWithDirective(lastTimer);
          } else {
            rt.startRestTimer(lastTimer.restSec, lastTimer.source);
          }
        }
      }

      // 记账本轮物理请求（含去重记组 operationId）
      await recordBilling(
        normalizeUsageToBillingRecord({
          id: `bill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId,
          segmentId: activeSegment!.segmentId,
          turnId,
          round,
          purpose: 'coach_turn',
          capabilities: caps,
          rawUsage: doneRawUsage,
          prefixDigest,
          systemPromptDigest,
          toolsDigest,
          prefixByteLength: fullPrefixPayload.length,
          exactPrefixMatchedPrevRound,
          durationMs: reqDurationMs,
          ttftMs: reqFirstTokenMs ? Math.max(1, reqFirstTokenMs - reqStartMs) : undefined,
          operationIdsCompleted: completedSetOpsInRound,
          loggedSetsCount: completedSetOpsInRound.length,
        }),
      );

      // 仅按已交付工具的精确检查点持久化，绝不顺带吞掉并发的 session.note 或未触及字段修改
      segmentCheckpointCache.set(`${threadId}:${activeSegment!.segmentId}`, currentCheckpoint);
      activeSegment!.lastSyncedSessionId = currentCheckpoint.activeSessionId;
      activeSegment!.lastSyncedSessionRevision = currentCheckpoint.activeSessionRevision;
      activeSegment!.lastSyncedPlanRevisions = currentCheckpoint.planRevisions;
      activeSegment!.lastSyncedMemoryHash = currentCheckpoint.memoryHash;
      activeSegment!.lastSyncedCheckpoint = currentCheckpoint;
      await upsertThreadSegment(activeSegment!);
    }

    if (pendingTurn.status !== 'awaiting_confirmation') {
      await deletePendingTurnStrict(pendingTurn.turnId);
      params.onPendingTurnChange?.(null);

      // Step 7：在完整回合彻底结束后按部署实际用量、价格与剩余组次测算经济切段收益（绝不在工具中途触发）
      if (!draftPlan && !params.signal?.aborted) {
        try {
          const postTurnCtx = await buildCoachReadOnlyContext(params.toolContext, {
            includeAllHistory: false,
            historyLimit: 3,
          });
          let remainingSets = 0;
          if (postTurnCtx.activeSession) {
            for (const ex of postTurnCtx.activeSession.exercises) {
              remainingSets += ex.sets.filter((s) => s.status !== 'done').length;
            }
          }
          const remainingExpectedRequests = remainingSets > 0 ? remainingSets * 2 : 0;
          const allBills = await listBillingRecords(threadId);
          const depBills = allBills.filter(
            (b) => b.deploymentId === caps.deploymentId && (b.purpose === 'coach_turn' || b.purpose === 'compact_summary'),
          );
          const hasMeasuredUsage = depBills.some((b) => b.source === 'measured' && b.inputTokens > 0);
          const inRate = caps.pricing.inputPer1MTokens;
          const hitRate = caps.pricing.cachedInputPer1MTokens;
          const outRate = caps.pricing.outputPer1MTokens;
          const hasKnownPricing =
            caps.pricing.currency !== 'unknown' &&
            inRate !== null &&
            inRate > 0 &&
            hitRate !== null &&
            outRate !== null;

          const syntheticAssistantMsg: CoachStoredMessage = {
            id: `asst-end-${turnId}`,
            threadId,
            role: 'assistant',
            createdAt: Date.now(),
            text: accumulatedText,
            ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
            ...(receipts.length ? { receiptIds: receipts.map((r) => r.id) } : {}),
          };
          const syntheticUserMsg: CoachStoredMessage = {
            id: pendingTurn.userMessageId,
            threadId,
            role: 'user',
            createdAt: pendingTurn.createdAt,
            text: pendingTurn.userPromptText,
          };
          const eligibleMsgs = [...params.history, syntheticUserMsg, syntheticAssistantMsg].filter(
            (m) => !m.isDemo && !m.compressed,
          );
          const toCompressPreview = eligibleMsgs.length >= 6 ? eligibleMsgs.slice(0, -4) : eligibleMsgs;
          const estimatedSummaryInputTokens = estimateTokens(
            toCompressPreview.map((m) => `${m.role}: ${m.text}`).join('\n'),
          );
          const usedTokens =
            (latestUsage?.promptTokens ?? 0) > 0
              ? latestUsage!.promptTokens!
              : fullPrefixPayloadCache.lastInputTokens;
          const decision = evaluateEconomicCompaction({
            usedTokens,
            estimatedSummaryInputTokens,
            compressibleCount: eligibleMsgs.length,
            remainingExpectedRequests,
            cacheReadRatio: hasKnownPricing ? hitRate! / inRate! : null,
            outputToInputRatio: hasKnownPricing ? outRate! / inRate! : null,
            hasMeasuredUsage,
            hasKnownPricing,
          });
          if (decision.shouldCompact) {
            const comp = await compressCoachContext({
              threadId,
              messages: eligibleMsgs,
              existingSummary: workingSummary,
              providerConfig: cfg,
              keepRecent: 4,
              signal: params.signal,
            });
            if (comp.compressedCount > 0) {
              workingSummary = comp.summary;
              const freshMem = formatCoachMemoryForPrompt(await loadCoachMemory(), 1200);
              const compacted = await openFreshSegmentState({
                threadId,
                reason: 'compaction',
                restoreEpoch: currentEpoch,
                cfg,
                caps,
                effectiveThinking,
                roCtx: postTurnCtx,
                memoryPrompt: freshMem,
                contextSummary: workingSummary,
              });
              activeSegment = compacted.segment;
              const retainedOverlay = await loadMessageRedactionOverlay();
              const retainedMsgs = eligibleMsgs
                .slice(-4)
                .map((m) => applyMessageRedactionProjection(m, retainedOverlay));
              const retainedEntries: CoachProtocolEntry[] = retainedMsgs.map((m) => {
                const s = activeSegment!.nextSeq;
                activeSegment!.nextSeq += 1;
                return {
                  id: `${threadId}:${activeSegment!.segmentId}:${s}`,
                  threadId,
                  segmentId: activeSegment!.segmentId,
                  seq: s,
                  createdAt: m.createdAt,
                  kind: m.role === 'user' ? 'user' : 'assistant',
                  ...(m.role === 'user' ? { wireText: m.text } : { assistantText: m.text }),
                  ...(m.role === 'assistant' && m.reasoning ? { reasoningText: m.reasoning } : {}),
                };
              });
              if (retainedEntries.length) await appendProtocolEntriesStrict(retainedEntries);
              await upsertThreadSegment(activeSegment, workingSummary);
              params.onSegmentChanged?.(activeSegment);
              params.onCompactionApplied?.({
                compressedCount: comp.compressedCount,
                summary: comp.summary,
                reason: decision.reason,
              });
            }
          }
        } catch {
          /* 经济压缩测算失败不影响已完成回合结果返回 */
        }
      }
    }

    const durationMs = Math.max(1, Date.now() - turnStartMs);
    const genTokens =
      (latestUsage?.completionTokens ?? 0) > 0
        ? latestUsage!.completionTokens!
        : estimateTokens(accumulatedText + accumulatedReasoning);
    const genDurationMs = firstTokenMs !== null ? Math.max(200, Date.now() - firstTokenMs) : durationMs;
    const tokensPerSec =
      genTokens > 0 ? Math.round((genTokens / (genDurationMs / 1000)) * 10) / 10 : undefined;
    if (latestUsage || genTokens > 0) {
      latestUsage = {
        ...latestUsage,
        ...(firstTokenMs !== null ? { ttftMs: Math.max(1, firstTokenMs - turnStartMs) } : {}),
        durationMs,
        ...(tokensPerSec !== undefined ? { tokensPerSec } : {}),
        rounds: Math.max(1, roundsExecuted),
      };
      params.onUsage?.(latestUsage);
    }
    const citations = Array.from(citationsByUrl.values());
    return {
      text: accumulatedText || (draftPlan ? '请核对草稿后创建计划。' : ''),
      draftPlan,
      ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
      receipts,
      ...(latestUsage ? { usage: latestUsage } : {}),
      ...(citations.length ? { citations } : {}),
      outcomeKind: doneOutcomeKindDefault(draftPlan, receipts),
      segmentId: activeSegment!.segmentId,
      billingRecords: turnBillingRecords,
      ...(pendingTurn.status === 'awaiting_confirmation' ? { pendingTurn } : {}),
      aborted: false,
    };
  } catch (err) {
    if (params.signal?.aborted && err instanceof Error && err.name === 'AbortError') {
      const citations = Array.from(citationsByUrl.values());
      return {
        text: accumulatedText,
        ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
        receipts,
        ...(latestUsage ? { usage: latestUsage } : {}),
        ...(citations.length ? { citations } : {}),
        segmentId: activeSegment!.segmentId,
        billingRecords: turnBillingRecords,
        aborted: true,
      };
    }
    throw err;
  }
}

type CoachThreadBillingTotalsCache = NonNullable<
  import('./coachStorage').CoachThreadMeta['billingTotals']
>;

function doneOutcomeKindDefault(
  draftPlan: CoachPlanDraft | undefined,
  receipts: CoachOperationReceipt[],
): CoachStreamOutcomeKind {
  return draftPlan || receipts.length > 0 ? 'completed_tool_calls' : 'completed_text';
}

/**
 * 断线/崩溃/重载恢复未完成回合：
 * · 若 epoch 变更（执行过备份恢复）-> 作废不写入；
 * · 若 awaiting_confirmation -> 原样返回待确认草稿，绝不重跑工具；
 * · 若 awaiting_tools -> 对未执行工具用原 deterministic operationId 顺序补执行（已提交者自动幂等跳过），并仅对最终未排程计时器补发一次提醒。
 */
export async function resumePendingCoachTurn(params: {
  threadId?: string;
  pendingTurn: CoachPendingTurn;
  toolContext: CoachToolExecutionContext;
  providerConfig?: CoachStoredProviderConfig | null;
  thinkingDepth?: CoachThinkingDepth;
  onReceipt?: (receipt: CoachOperationReceipt) => void;
  onTextChunk?: (accumulatedText: string) => void;
  onReasoningChunk?: (accumulatedReasoning: string) => void;
  onUsage?: (usage: CoachTokenUsage) => void;
  onBillingRecord?: (record: CoachBillingRecord) => void;
  signal?: AbortSignal;
}): Promise<{
  resumed: boolean;
  expiredByRestore?: boolean;
  routeMismatch?: boolean;
  threadMismatch?: boolean;
  staleOrMissingPending?: boolean;
  needsUserRetry?: boolean;
  needsConfirmationStream?: boolean;
  draftPlan?: CoachPlanDraft;
  receipts: CoachOperationReceipt[];
  reasoning?: string;
  usage?: CoachTokenUsage;
  text: string;
}> {
  const explicitThreadId = params.threadId ?? params.toolContext.activeThreadId;
  if (explicitThreadId && params.pendingTurn.threadId !== explicitThreadId) {
    return {
      resumed: false,
      threadMismatch: true,
      needsUserRetry: true,
      receipts: [],
      text: '待恢复记录与当前会话不匹配，已阻止跨会话执行。',
    };
  }
  let pendingTurn = params.pendingTurn;
  if (explicitThreadId) {
    const threadPendings = await listPendingTurns(explicitThreadId);
    const persisted = threadPendings.find((p) => p.turnId === params.pendingTurn.turnId);
    if (
      !persisted ||
      persisted.threadId !== explicitThreadId ||
      persisted.segmentId !== params.pendingTurn.segmentId ||
      persisted.restoreEpoch !== params.pendingTurn.restoreEpoch
    ) {
      return {
        resumed: false,
        staleOrMissingPending: true,
        needsUserRetry: true,
        receipts: [],
        text: '待恢复记录在当前会话中已不存在或已过期，未执行任何工具操作。',
      };
    }
    pendingTurn = persisted;
  }
  const currentEpoch = await getCoachRestoreEpoch();
  if (pendingTurn.restoreEpoch !== currentEpoch) {
    await deletePendingTurnStrict(pendingTurn.turnId);
    return {
      resumed: false,
      expiredByRestore: true,
      receipts: [],
      text: '检测到系统已恢复过历史备份，先前中断的待执行操作已安全作废。',
    };
  }

  if (pendingTurn.status === 'awaiting_confirmation' && pendingTurn.pendingDraftPlan) {
    return {
      resumed: true,
      draftPlan: pendingTurn.pendingDraftPlan,
      receipts: [],
      text: '已恢复待确认的训练计划草稿，核对无误后点击创建即可。',
    };
  }

  if (pendingTurn.status === 'running_model') {
    return {
      resumed: false,
      needsUserRetry: true,
      receipts: [],
      text: '上一条回复在流式生成中中断，尚未改动任何训练数据；可直接重新发送刚才的问题。',
    };
  }

  const runConfirmationFollowupLoop = async (
    initialPending: CoachPendingTurn,
    receipts: CoachOperationReceipt[],
    initialCheckpoint?: CoachSegmentCheckpoint,
  ): Promise<{
    resumed: boolean;
    expiredByRestore?: boolean;
    routeMismatch?: boolean;
    needsUserRetry?: boolean;
    needsConfirmationStream?: boolean;
    draftPlan?: CoachPlanDraft;
    receipts: CoachOperationReceipt[];
    reasoning?: string;
    usage?: CoachTokenUsage;
    text: string;
  }> => {
    let currentPending = initialPending;
    let threadsState = await loadCoachThreadsState();
    let threadMeta = threadsState.threads.find((t) => t.id === currentPending.threadId);
    let seg = threadMeta?.segments?.[currentPending.segmentId];

    const matchesPendingRoute = (
      cand: CoachStoredProviderConfig | null | undefined,
    ): cand is CoachStoredProviderConfig => {
      if (!cand || !cand.apiKey.trim() || !cand.baseUrl.trim() || !cand.model.trim()) {
        return false;
      }
      if (cand.kind !== currentPending.providerKind) return false;
      if (cand.model.trim() !== currentPending.model.trim()) return false;
      if (currentPending.deploymentId && computeDeploymentId(cand) !== currentPending.deploymentId) {
        return false;
      }
      const expectedBaseUrl = currentPending.baseUrl ?? seg?.baseUrl;
      if (
        expectedBaseUrl &&
        canonicalizeEndpointBaseUrl(cand.kind, cand.baseUrl) !==
          canonicalizeEndpointBaseUrl(currentPending.providerKind, expectedBaseUrl)
      ) {
        return false;
      }
      return true;
    };

    const incomingCfg = params.providerConfig;
    const hasIncomingCfg = Boolean(
      incomingCfg && incomingCfg.apiKey.trim() && incomingCfg.baseUrl.trim() && incomingCfg.model.trim(),
    );
    let cfg: CoachStoredProviderConfig | null = null;
    if (hasIncomingCfg && matchesPendingRoute(incomingCfg)) {
      cfg = incomingCfg!;
    } else {
      const savedRouteCfg = await findSavedProviderConfigForRoute({
        kind: currentPending.providerKind,
        baseUrl: currentPending.baseUrl ?? seg?.baseUrl,
        deploymentId: currentPending.deploymentId,
        model: currentPending.model,
      });
      if (matchesPendingRoute(savedRouteCfg)) {
        cfg = savedRouteCfg;
      } else if (hasIncomingCfg) {
        return {
          resumed: false,
          routeMismatch: true,
          needsConfirmationStream: true,
          receipts,
          text: `当前模型设置（${incomingCfg!.model}）与待恢复回合原部署（${currentPending.model}）不一致，且未找到原路由的有效配置；已保留待恢复状态并阻止向新端点发送原训练历史。`,
        };
      }
    }

    if (!cfg) {
      return {
        resumed: true,
        needsConfirmationStream: true,
        receipts,
        text: receipts.length
          ? `已完成 ${receipts.length} 项训练写入，确认回复在网络中断处暂停。`
          : '工具执行已完成，待补充模型确认回复。',
      };
    }

    const tools = sortToolDefinitionsStably(COACH_TOOL_DEFINITIONS);
    const toolsJsonString = JSON.stringify(tools);
    const systemPromptDigest = saltedPrefixDigest(
      currentPending.threadId,
      STATIC_COACH_SYSTEM_PROMPT,
    );
    const toolsDigest = saltedPrefixDigest(currentPending.threadId, toolsJsonString);
    const caps = resolveProviderCapabilities({
      ...cfg,
      contextWindowOverride: cfg.contextWindowByModel?.[cfg.model],
    });
    const effectiveThinking: CoachThinkingDepth =
      currentPending.thinkingDepth ??
      (seg?.thinkingModeKey as CoachThinkingDepth | undefined) ??
      params.thinkingDepth ??
      cfg.thinkingDepth ??
      'default';

    if (!seg) {
      await deletePendingTurnStrict(currentPending.turnId);
      return {
        resumed: true,
        receipts,
        text: receipts.length
          ? `已确认 ${receipts.length} 项写入：${receipts.map((r) => r.summary).join('；')}。`
          : '中断回合已完成核对。',
      };
    }

    let entries = await listProtocolEntries(currentPending.threadId, currentPending.segmentId);
    let currentCheckpoint: CoachSegmentCheckpoint =
      initialCheckpoint ??
      segmentCheckpointCache.get(`${currentPending.threadId}:${seg.segmentId}`) ??
      seg.lastSyncedCheckpoint ?? {
        activeSessionId: seg.lastSyncedSessionId,
        activeSessionRevision: seg.lastSyncedSessionRevision,
        exerciseDigests: {},
        warmupsDigest: '',
        cardioDigest: '',
        planRevisions: seg.lastSyncedPlanRevisions ?? {},
        memoryHash: seg.lastSyncedMemoryHash ?? '',
        setupNotesHash: seg.lastSyncedSetupNotesHash ?? '',
      };
    let roundFrozenView: CoachFrozenView;
    if (currentPending.frozenView) {
      roundFrozenView = {
        ...structuredClone(currentPending.frozenView),
        restoreEpoch: currentEpoch,
      };
    } else {
      const initView = await buildCoachReadOnlyContextWithView(
        params.toolContext,
        { includeAllHistory: false, historyLimit: 5 },
        currentEpoch,
      );
      roundFrozenView = {
        ...initView.frozenView,
        restoreEpoch: currentEpoch,
      };
    }

    let accumulatedText = '';
    let accumulatedReasoning = '';
    let latestUsage: CoachTokenUsage | undefined;
    let seenPurgeGen = memoryPurgeGeneration;

    const rebuildWireForRecovery = (curSeg: CoachSegmentState, curEntries: CoachProtocolEntry[]) => {
      const wireMessages: CoachTurnMessage[] = [
        { role: 'system', text: STATIC_COACH_SYSTEM_PROMPT, cacheControl: 'ephemeral' },
        {
          role: 'user',
          parts: [{ type: 'text', text: curSeg.baselineSnapshotJson }],
          isSegmentBaseline: true,
          cacheControl: 'ephemeral',
        },
      ];
      for (const e of curEntries) {
        const m = protocolEntryToTurnMessage(e);
        if (m) wireMessages.push(m);
      }
      return wireMessages;
    };

    const syncRecoveryIfMemoryPurged = async (): Promise<MemoryScrubSpec | null> => {
      if (seenPurgeGen === memoryPurgeGeneration) return null;
      const missedEvents = recentPurgeEvents.filter((ev) => ev.gen > seenPurgeGen);
      const missedNeedles = missedEvents.flatMap((ev) => ev.needles);
      const missedMemoryId = missedEvents.find((ev) => ev.memoryId)?.memoryId;
      const scrubSpec = buildMemoryScrubSpec(missedNeedles, missedMemoryId);
      seenPurgeGen = memoryPurgeGeneration;

      threadsState = await loadCoachThreadsState();
      threadMeta = threadsState.threads.find((t) => t.id === currentPending.threadId);
      const reloadedSeg = threadMeta?.activeSegmentId
        ? threadMeta.segments?.[threadMeta.activeSegmentId]
        : undefined;
      if (reloadedSeg) seg = reloadedSeg;
      entries = await listProtocolEntries(currentPending.threadId, seg!.segmentId);
      const reloadedPending = await getPendingTurn(currentPending.turnId);
      if (reloadedPending) {
        currentPending = reloadedPending;
      } else if (currentPending.segmentId !== seg!.segmentId) {
        currentPending = { ...currentPending, segmentId: seg!.segmentId };
      }
      if (scrubSpec.needles.length) {
        accumulatedText = scrubPlainTextWithSpec(accumulatedText, scrubSpec);
        accumulatedReasoning = scrubPlainTextWithSpec(accumulatedReasoning, scrubSpec);
      }
      const postMem = formatCoachMemoryForPrompt(await loadCoachMemory(), 1200);
      const memHash = hashTextCompact(postMem.trim());
      currentCheckpoint = { ...currentCheckpoint, memoryHash: memHash };
      segmentCheckpointCache.set(`${currentPending.threadId}:${seg!.segmentId}`, currentCheckpoint);
      seg = { ...seg!, lastSyncedMemoryHash: memHash, lastSyncedCheckpoint: currentCheckpoint };
      return scrubSpec;
    };

    for (let stepRound = 0; stepRound < 6; stepRound += 1) {
      if (params.signal?.aborted) {
        return {
          resumed: false,
          needsConfirmationStream: true,
          receipts,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text: accumulatedText || '续发确认被取消，可重试恢复。',
        };
      }
      const latestEpoch = await getCoachRestoreEpoch();
      if (latestEpoch !== currentEpoch) {
        await deletePendingTurnStrict(currentPending.turnId);
        return {
          resumed: false,
          expiredByRestore: true,
          receipts,
          text: '检测到系统已恢复过历史备份，先前中断的续调已安全作废。',
        };
      }

      await syncRecoveryIfMemoryPurged();
      if (!seg) break;

      let wireMessages = rebuildWireForRecovery(seg, entries);
      let estInput = estimateConversationTokens(wireMessages, toolsJsonString);
      let hardCheck = checkHardContextBudget({
        estimatedInputTokens: estInput,
        model: cfg.model,
        advertisedMaxTokens: cfg.contextWindowByModel?.[cfg.model],
        reservedOutputTokens: caps.maxOutputTokens,
      });
      if (hardCheck.exceedsHardLimit) {
        wireMessages = wireMessages.map((m) => {
          if (m.role !== 'tool') return m;
          try {
            const parsed = JSON.parse(m.content) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object' && 'data' in parsed && m.content.length > 600) {
              return {
                ...m,
                content: JSON.stringify({
                  ok: parsed.ok ?? true,
                  summary: typeof parsed.summary === 'string' ? parsed.summary : '已完成查询',
                  ...(parsed.receipt ? { receipt: parsed.receipt } : {}),
                  ...(parsed.errorCode ? { errorCode: parsed.errorCode } : {}),
                  truncatedForBudget: true,
                }),
              };
            }
          } catch {
            /* keep raw */
          }
          return m.content.length > 1200
            ? {
                ...m,
                content: JSON.stringify({
                  ok: true,
                  summary: m.content.slice(0, 400),
                  truncatedForBudget: true,
                }),
              }
            : m;
        });
        estInput = estimateConversationTokens(wireMessages, toolsJsonString);
        hardCheck = checkHardContextBudget({
          estimatedInputTokens: estInput,
          model: cfg.model,
          advertisedMaxTokens: cfg.contextWindowByModel?.[cfg.model],
          reservedOutputTokens: caps.maxOutputTokens,
        });
        if (hardCheck.exceedsHardLimit) {
          await savePendingTurnStrict({
            ...currentPending,
            status: 'awaiting_followup_model',
            lastError: hardCheck.reason ?? '恢复续调时上下文超出硬上限',
          });
          return {
            resumed: false,
            needsConfirmationStream: true,
            receipts,
            ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
            ...(latestUsage ? { usage: latestUsage } : {}),
            text:
              accumulatedText ||
              hardCheck.reason ||
              '工具结果超出模型硬上下文上限，已保留恢复状态，请手动压缩后重试。',
          };
        }
      }

      const roundIdx = (currentPending.round ?? 1) + stepRound;
      const outboundPairing = validateOutboundToolPairing(wireMessages);
      if (!outboundPairing.ok) {
        currentPending = {
          ...currentPending,
          lastError: outboundPairing.reason,
        };
        await savePendingTurnStrict(currentPending);
        return {
          resumed: false,
          needsConfirmationStream: true,
          receipts,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text:
            accumulatedText ||
            `出站工具消息配对校验未通过：${outboundPairing.reason}（已阻断模型续调请求，未写入数据）`,
        };
      }

      let roundText = '';
      let roundReasoning = '';
      let doneOutcomeKind: CoachStreamOutcomeKind = 'completed_text';
      let doneErrorMessage: string | undefined;
      let doneToolCalls: CoachToolCall[] = [];
      let doneRawUsage: Record<string, unknown> | undefined;
      let doneAnthropicBlocks: Array<Record<string, unknown>> | undefined;
      let doneGeminiParts: Array<Record<string, unknown>> | undefined;
      const reqStartMs = Date.now();
      let reqFirstTokenMs: number | undefined;

      for await (const ev of streamCoachTurn(toProviderConfig(cfg), wireMessages, tools, {
        signal: params.signal,
        thinkingDepth: effectiveThinking,
        allowThinkingFallback: true,
        requestTitle: false,
        webSearch: false,
        includeUsage: true,
        promptCacheKey: `motion:${caps.deploymentId}:${currentPending.threadId}:${seg.segmentId}`,
        anthropicCacheControl: caps.sendCacheControlBreakpoints,
        capabilities: caps,
      })) {
        if (ev.type === 'reasoning_delta') {
          if (reqFirstTokenMs === undefined && ev.delta) reqFirstTokenMs = Date.now();
          roundReasoning += ev.delta;
          params.onReasoningChunk?.(accumulatedReasoning + roundReasoning);
        } else if (ev.type === 'text_delta') {
          if (reqFirstTokenMs === undefined && ev.delta) reqFirstTokenMs = Date.now();
          roundText += ev.delta;
          params.onTextChunk?.(accumulatedText + roundText);
        } else if (ev.type === 'done') {
          doneOutcomeKind = ev.outcomeKind;
          doneErrorMessage = ev.errorMessage;
          doneToolCalls = ev.toolCalls;
          doneRawUsage = ev.rawUsage;
          doneAnthropicBlocks = ev.anthropicBlocks;
          doneGeminiParts = ev.geminiParts;
          if (ev.usage) {
            latestUsage = {
              promptTokens: ev.usage.promptTokens ?? latestUsage?.promptTokens,
              completionTokens:
                ev.usage.completionTokens !== undefined
                  ? (latestUsage?.completionTokens ?? 0) + ev.usage.completionTokens
                  : latestUsage?.completionTokens,
              totalTokens: ev.usage.totalTokens ?? latestUsage?.totalTokens,
              cachedTokens: ev.usage.cachedTokens ?? latestUsage?.cachedTokens,
              cacheCreationTokens: ev.usage.cacheCreationTokens ?? latestUsage?.cacheCreationTokens,
              reasoningTokens:
                ev.usage.reasoningTokens !== undefined
                  ? (latestUsage?.reasoningTokens ?? 0) + ev.usage.reasoningTokens
                  : latestUsage?.reasoningTokens,
            };
            params.onUsage?.(latestUsage);
          }
        }
      }

      const streamPurgeSpec = await syncRecoveryIfMemoryPurged();
      if (streamPurgeSpec && (streamPurgeSpec.needles.length || streamPurgeSpec.memoryId)) {
        roundText = scrubPlainTextWithSpec(roundText, streamPurgeSpec);
        roundReasoning = scrubPlainTextWithSpec(roundReasoning, streamPurgeSpec);
        if (doneAnthropicBlocks?.length) {
          doneAnthropicBlocks = doneAnthropicBlocks.map(
            (b) => deepScrubMemoryValueWithSpec(b, streamPurgeSpec) as Record<string, unknown>,
          );
        }
        if (doneGeminiParts?.length) {
          doneGeminiParts = doneGeminiParts.map(
            (p) => deepScrubMemoryValueWithSpec(p, streamPurgeSpec) as Record<string, unknown>,
          );
        }
      }

      const prefixPayload = JSON.stringify({
        system: STATIC_COACH_SYSTEM_PROMPT,
        tools,
        messages: wireMessages,
      });
      const reqDurationMs = Math.max(1, Date.now() - reqStartMs);
      const ttftMs = reqFirstTokenMs ? Math.max(1, reqFirstTokenMs - reqStartMs) : undefined;
      const prefixDigest = saltedPrefixDigest(currentPending.threadId, prefixPayload);

      if (
        doneOutcomeKind === 'truncated_eof' ||
        doneOutcomeKind === 'truncated_max_tokens' ||
        doneOutcomeKind === 'malformed_tool_call'
      ) {
        const failBill = normalizeUsageToBillingRecord({
          id: `bill-res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId: currentPending.threadId,
          segmentId: seg!.segmentId,
          turnId: currentPending.turnId,
          round: roundIdx,
          purpose: 'coach_turn',
          capabilities: caps,
          rawUsage: doneRawUsage,
          prefixDigest,
          systemPromptDigest,
          toolsDigest,
          prefixByteLength: prefixPayload.length,
          exactPrefixMatchedPrevRound: true,
          durationMs: reqDurationMs,
          ttftMs,
        });
        await saveBillingRecordStrict(failBill);
        params.onBillingRecord?.(failBill);
        return {
          resumed: false,
          needsConfirmationStream: true,
          receipts,
          ...(roundReasoning ? { reasoning: accumulatedReasoning + roundReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text: accumulatedText || roundText || doneErrorMessage || '续发确认响应未完整结束，可重试。',
        };
      }

      accumulatedReasoning += roundReasoning;
      accumulatedText += roundText;

      if (doneToolCalls.length === 0) {
        const finalBill = normalizeUsageToBillingRecord({
          id: `bill-res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId: currentPending.threadId,
          segmentId: seg!.segmentId,
          turnId: currentPending.turnId,
          round: roundIdx,
          purpose: 'coach_turn',
          capabilities: caps,
          rawUsage: doneRawUsage,
          prefixDigest,
          systemPromptDigest,
          toolsDigest,
          prefixByteLength: prefixPayload.length,
          exactPrefixMatchedPrevRound: true,
          durationMs: reqDurationMs,
          ttftMs,
        });
        await saveBillingRecordStrict(finalBill);
        params.onBillingRecord?.(finalBill);

        const nextSeq = Math.max(
          seg!.nextSeq ?? 1,
          entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1,
        );
        const asstEntry: CoachProtocolEntry = {
          id: `${currentPending.threadId}:${seg!.segmentId}:${nextSeq}`,
          threadId: currentPending.threadId,
          segmentId: seg!.segmentId,
          seq: nextSeq,
          createdAt: Date.now(),
          kind: 'assistant',
          assistantText: roundText,
          ...(roundReasoning ? { reasoningText: roundReasoning } : {}),
          ...(doneAnthropicBlocks?.length ? { anthropicBlocks: doneAnthropicBlocks } : {}),
          ...(doneGeminiParts?.length ? { geminiParts: doneGeminiParts } : {}),
        };
        await appendProtocolEntriesStrict([asstEntry]);
        entries.push(asstEntry);
        const allThreadBills = await listBillingRecords(currentPending.threadId);
        const updatedSeg: CoachSegmentState = {
          ...seg!,
          nextSeq: nextSeq + 1,
          lastSyncedSessionId: currentCheckpoint.activeSessionId,
          lastSyncedSessionRevision: currentCheckpoint.activeSessionRevision,
          lastSyncedPlanRevisions: currentCheckpoint.planRevisions,
          lastSyncedMemoryHash: currentCheckpoint.memoryHash,
          lastSyncedCheckpoint: currentCheckpoint,
          ...(roundReasoning ? {} : { containsAssistantWithoutReasoning: true }),
        };
        segmentCheckpointCache.set(`${currentPending.threadId}:${updatedSeg.segmentId}`, currentCheckpoint);
        await patchCoachThreadsState((latest) => ({
          ...latest,
          threads: latest.threads.map((t) =>
            t.id === currentPending.threadId
              ? {
                  ...t,
                  activeSegmentId: updatedSeg.segmentId,
                  billingTotals: billingTotalsFromRecords(allThreadBills),
                  segments: { ...(t.segments ?? {}), [updatedSeg.segmentId]: updatedSeg },
                  updatedAt: Date.now(),
                }
              : t,
          ),
        }));
        await deletePendingTurnStrict(currentPending.turnId);
        return {
          resumed: true,
          receipts,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text: accumulatedText || '已完成此前操作并补充确认。',
        };
      }

      const batchCheck = validateToolCallBatch(doneToolCalls, ALLOWED_BUSINESS_TOOL_NAMES);
      if (!batchCheck.ok) {
        const badBill = normalizeUsageToBillingRecord({
          id: `bill-res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId: currentPending.threadId,
          segmentId: seg!.segmentId,
          turnId: currentPending.turnId,
          round: roundIdx,
          purpose: 'coach_turn',
          capabilities: caps,
          rawUsage: doneRawUsage,
          prefixDigest,
          systemPromptDigest,
          toolsDigest,
          prefixByteLength: prefixPayload.length,
          exactPrefixMatchedPrevRound: true,
          durationMs: reqDurationMs,
          ttftMs,
        });
        await saveBillingRecordStrict(badBill);
        params.onBillingRecord?.(badBill);
        await savePendingTurnStrict({
          ...currentPending,
          status: 'awaiting_followup_model',
          lastError: batchCheck.reason,
        });
        return {
          resumed: false,
          needsConfirmationStream: true,
          receipts,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text: accumulatedText || `续调工具参数校验未通过：${batchCheck.reason}（0 写入）`,
        };
      }

      const baseSeq = Math.max(
        seg!.nextSeq ?? 1,
        entries.reduce((m, e) => Math.max(m, e.seq), 0) + 1,
      );
      const plannedCalls = freezeToolBatchAgainstView({
        calls: doneToolCalls,
        frozenView: roundFrozenView,
        turnId: currentPending.turnId,
        round: roundIdx,
        baseSeq,
        restoreEpoch: currentEpoch,
      });

      const protoToolCalls: CoachProtocolToolCall[] = doneToolCalls.map((c, idx) => ({
        id: c.id,
        index: c.index ?? idx,
        name: c.name,
        argumentsText: c.argumentsText,
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      }));
      const assistantEntrySnapshot: Omit<CoachProtocolEntry, 'id' | 'threadId' | 'segmentId' | 'seq'> = {
        createdAt: Date.now(),
        kind: 'assistant',
        assistantText: roundText,
        ...(roundReasoning ? { reasoningText: roundReasoning } : {}),
        toolCalls: protoToolCalls,
        ...(doneAnthropicBlocks?.length ? { anthropicBlocks: doneAnthropicBlocks } : {}),
        ...(doneGeminiParts?.length ? { geminiParts: doneGeminiParts } : {}),
      };
      const asstToolEntry: CoachProtocolEntry = {
        id: `${currentPending.threadId}:${seg!.segmentId}:${baseSeq}`,
        threadId: currentPending.threadId,
        segmentId: seg!.segmentId,
        seq: baseSeq,
        ...assistantEntrySnapshot,
      };
      seg = {
        ...seg!,
        nextSeq: baseSeq + 1 + doneToolCalls.length,
        ...(roundReasoning ? {} : { containsAssistantWithoutReasoning: true }),
      };
      const nextFollowupPending: CoachPendingTurn = {
        ...currentPending,
        round: roundIdx,
        status: 'awaiting_tools',
        assistantEntrySeq: baseSeq,
        assistantEntrySnapshot,
        plannedToolCalls: plannedCalls,
      };
      currentPending = await commitToolBatchIntentAtomic({
        pendingTurn: nextFollowupPending,
        entries: [asstToolEntry],
        segmentUpdate: { threadId: currentPending.threadId, segment: seg },
      });
      entries.push(asstToolEntry);

      const deferredTimers: CoachRestTimerDirective[] = [];
      const completedSetOpsInRound: string[] = [];
      let draftPlan: CoachPlanDraft | undefined;

      for (let i = 0; i < plannedCalls.length; i += 1) {
        const plannedStep = plannedCalls[i];
        const outcome = await executeCoachToolCall(
          {
            id: plannedStep.toolCallId,
            operationId: plannedStep.operationId,
            index: plannedStep.index,
            name: plannedStep.name,
            argumentsText: plannedStep.argumentsText,
            arguments: plannedStep.args,
            ...(plannedStep.thoughtSignature ? { thoughtSignature: plannedStep.thoughtSignature } : {}),
          },
          {
            ...params.toolContext,
            activeThreadId: currentPending.threadId,
            expectedEpoch: plannedStep.expectedEpoch ?? currentEpoch,
            ...(plannedStep.modelExpectedRevision !== undefined
              ? { modelExpectedRevision: plannedStep.modelExpectedRevision }
              : {}),
            ...(plannedStep.modelExpectedPlanRevision !== undefined
              ? { modelExpectedPlanUpdatedAt: plannedStep.modelExpectedPlanRevision }
              : {}),
            ...(plannedStep.frozenPrecondition ? { frozenPrecondition: plannedStep.frozenPrecondition } : {}),
            ...(plannedStep.priorBatchOpIds?.length ? { priorBatchOpIds: plannedStep.priorBatchOpIds } : {}),
            ...(plannedStep.strictSessionRevision ? { strictSessionRevision: true } : {}),
            requireFrozenPreconditions: true,
            deferTimerDispatch: true,
            isWebSearchAllowed: () => Boolean(currentPending.webSearchUsed),
          },
        );
        roundFrozenView = advanceFrozenViewForToolOutcome({
          frozenView: roundFrozenView,
          toolName: plannedStep.name,
          toolArgs: plannedStep.args,
          outcome,
        });
        currentCheckpoint = advanceCheckpointForToolOutcome({
          checkpoint: currentCheckpoint,
          toolName: plannedStep.name,
          toolArgs: plannedStep.args,
          outcome,
          templatesById: roundFrozenView.templatesById,
          formatMemoryPrompt: (store) => formatCoachMemoryForPrompt(store, 1200),
        });
        if (outcome.draftPlan && !draftPlan) {
          draftPlan = outcome.draftPlan;
          currentPending = {
            ...currentPending,
            status: 'awaiting_confirmation',
            pendingDraftPlan: draftPlan,
          };
        }
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
          if (outcome.receipt.toolName === 'record_active_set' && outcome.ok) {
            completedSetOpsInRound.push(outcome.receipt.operationId);
          }
        }
        if (outcome.timerDirective) {
          deferredTimers.push(outcome.timerDirective);
        }

        const projectedJson = JSON.stringify(projectToolOutcomeForModel(plannedStep.name, outcome));
        plannedCalls[i] = {
          ...plannedStep,
          status: outcome.ok ? 'committed' : 'failed',
          ...(outcome.receipt ? { receiptId: outcome.receipt.id, afterRevision: outcome.receipt.afterRevision } : {}),
          outcomeJson: projectedJson,
          ...(!outcome.ok ? { errorText: outcome.summary } : {}),
        };
        const toolSeq = plannedStep.toolEntrySeq ?? baseSeq + 1 + i;
        const toolEntry: CoachProtocolEntry = {
          id: `${currentPending.threadId}:${seg!.segmentId}:${toolSeq}`,
          threadId: currentPending.threadId,
          segmentId: seg!.segmentId,
          seq: toolSeq,
          createdAt: Date.now(),
          kind: 'tool',
          toolCallId: plannedStep.toolCallId,
          toolName: plannedStep.name,
          toolResultText: projectedJson,
          toolError: !outcome.ok,
        };
        currentPending = await commitToolStepOutcomeAtomic({
          entries: [toolEntry],
          pendingTurn: {
            ...currentPending,
            plannedToolCalls: [...plannedCalls],
            frozenView: structuredClone(roundFrozenView),
          },
        });
        entries.push(toolEntry);

        if (outcome.deletedMemory) {
          await purgeDeletedMemoryFromCoachHistory({
            memoryId: outcome.deletedMemory.id,
            memoryTitle: outcome.deletedMemory.title,
            memoryContent: outcome.deletedMemory.content,
          });
          await syncRecoveryIfMemoryPurged();
        }
      }

      if (deferredTimers.length > 0 && !params.signal?.aborted) {
        const lastTimer = deferredTimers[deferredTimers.length - 1];
        const targetSid =
          params.toolContext.activeSession?.id ??
          receipts.find((r) => r.operationId === lastTimer.operationId)?.entityId;
        const rt = getActiveSessionRuntime(targetSid);
        if (
          rt &&
          shouldDispatchCoachOpTimer({
            replayed: false,
            nativeScheduled: false,
            isFinalTimerInBatch: true,
          })
        ) {
          if (rt.startRestTimerWithDirective) {
            rt.startRestTimerWithDirective(lastTimer);
          } else {
            rt.startRestTimer(lastTimer.restSec, lastTimer.source);
          }
        }
      }

      const stepBill = normalizeUsageToBillingRecord({
        id: `bill-res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        threadId: currentPending.threadId,
        segmentId: seg!.segmentId,
        turnId: currentPending.turnId,
        round: roundIdx,
        purpose: 'coach_turn',
        capabilities: caps,
        rawUsage: doneRawUsage,
        prefixDigest,
        systemPromptDigest,
        toolsDigest,
        prefixByteLength: prefixPayload.length,
        exactPrefixMatchedPrevRound: true,
        durationMs: reqDurationMs,
        ttftMs,
        operationIdsCompleted: completedSetOpsInRound,
        loggedSetsCount: completedSetOpsInRound.length,
      });
      await saveBillingRecordStrict(stepBill);
      params.onBillingRecord?.(stepBill);

      const allThreadBills = await listBillingRecords(currentPending.threadId);
      const updatedSeg: CoachSegmentState = {
        ...seg!,
        lastSyncedSessionId: currentCheckpoint.activeSessionId,
        lastSyncedSessionRevision: currentCheckpoint.activeSessionRevision,
        lastSyncedPlanRevisions: currentCheckpoint.planRevisions,
        lastSyncedMemoryHash: currentCheckpoint.memoryHash,
        lastSyncedCheckpoint: currentCheckpoint,
      };
      seg = updatedSeg;
      segmentCheckpointCache.set(`${currentPending.threadId}:${updatedSeg.segmentId}`, currentCheckpoint);
      await patchCoachThreadsState((latest) => ({
        ...latest,
        threads: latest.threads.map((t) =>
          t.id === currentPending.threadId
            ? {
                ...t,
                activeSegmentId: updatedSeg.segmentId,
                billingTotals: billingTotalsFromRecords(allThreadBills),
                segments: { ...(t.segments ?? {}), [updatedSeg.segmentId]: updatedSeg },
                updatedAt: Date.now(),
              }
            : t,
        ),
      }));

      if (draftPlan) {
        currentPending = {
          ...currentPending,
          status: 'awaiting_confirmation',
          plannedToolCalls: [...plannedCalls],
          pendingDraftPlan: draftPlan,
          frozenView: structuredClone(roundFrozenView),
        };
        await savePendingTurnStrict(currentPending);
        return {
          resumed: true,
          draftPlan,
          receipts,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          ...(latestUsage ? { usage: latestUsage } : {}),
          text: accumulatedText || '已生成训练计划草稿，请确认。',
        };
      }

      currentPending = {
        ...currentPending,
        status: 'awaiting_followup_model',
        round: roundIdx + 1,
        plannedToolCalls: [...plannedCalls],
        frozenView: structuredClone(roundFrozenView),
      };
      await savePendingTurnStrict(currentPending);
    }

    return {
      resumed: false,
      needsConfirmationStream: true,
      receipts,
      ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
      ...(latestUsage ? { usage: latestUsage } : {}),
      text: accumulatedText || '恢复续调轮次已达上限，可重试继续确认。',
    };
  };

  if (pendingTurn.status === 'awaiting_followup_model') {
    const receipts: CoachOperationReceipt[] = [];
    for (const step of pendingTurn.plannedToolCalls ?? []) {
      if (step.status === 'committed') {
        const rec = await getCoachReceiptByOperationId(step.operationId);
        if (rec) {
          await saveCoachReceipt(rec);
          receipts.push(rec);
        }
      }
    }
    return runConfirmationFollowupLoop(pendingTurn, receipts);
  }

  let activePending = pendingTurn;
  const planned = [...(activePending.plannedToolCalls ?? [])];
  if (planned.length === 0) {
    await deletePendingTurnStrict(activePending.turnId);
    return { resumed: true, receipts: [], text: '无需额外补执行操作。' };
  }

  const receipts: CoachOperationReceipt[] = [];
  let threadsState = await loadCoachThreadsState();
  let threadMeta = threadsState.threads.find((t) => t.id === activePending.threadId);
  let seg = threadMeta?.segments?.[activePending.segmentId];
  let existingEntries = await listProtocolEntries(activePending.threadId, activePending.segmentId);
  const occupiedSeqs = new Set(existingEntries.map((e) => e.seq));
  let maxSeq = Math.max(
    (seg?.nextSeq ?? 1) - 1,
    existingEntries.reduce((m, e) => Math.max(m, e.seq), 0),
  );
  const allocSafeSeq = (preferred?: number): number => {
    if (preferred !== undefined && preferred >= 1 && !occupiedSeqs.has(preferred)) {
      occupiedSeqs.add(preferred);
      if (preferred > maxSeq) maxSeq = preferred;
      return preferred;
    }
    maxSeq += 1;
    while (occupiedSeqs.has(maxSeq)) maxSeq += 1;
    occupiedSeqs.add(maxSeq);
    return maxSeq;
  };

  // 若助手 tool_calls 条目尚未落盘且 pendingTurn 保存了快照，幂等补写而不覆写既有记录（按槽位/轮次边界识别）
  const activeForSlotCheck = [...existingEntries]
    .filter((e) => !e.quarantinedFromReplay && !e.isControlMarker)
    .sort((a, b) => a.seq - b.seq);
  const resolvedAsstForResume = resolvePendingAssistantBatchIndex(activePending, activeForSlotCheck);
  const hasAsstEntry = resolvedAsstForResume.index >= 0;
  if (!hasAsstEntry && activePending.assistantEntrySnapshot) {
    const asstSeq = allocSafeSeq(activePending.assistantEntrySeq);
    const rebuiltAsst: CoachProtocolEntry = {
      id: `${activePending.threadId}:${activePending.segmentId}:${asstSeq}`,
      threadId: activePending.threadId,
      segmentId: activePending.segmentId,
      seq: asstSeq,
      ...activePending.assistantEntrySnapshot,
    };
    await appendProtocolEntriesStrict([rebuiltAsst]);
    existingEntries.push(rebuiltAsst);
    if (activePending.assistantEntrySeq === undefined) {
      activePending = { ...activePending, assistantEntrySeq: asstSeq };
    }
  }

  let recoveryFrozenView: CoachFrozenView;
  if (activePending.frozenView) {
    recoveryFrozenView = {
      ...structuredClone(activePending.frozenView),
      restoreEpoch: currentEpoch,
    };
  } else {
    const recoveryRoView = await buildCoachReadOnlyContextWithView(
      params.toolContext,
      { includeAllHistory: false, historyLimit: 5 },
      currentEpoch,
    );
    recoveryFrozenView = {
      ...recoveryRoView.frozenView,
      restoreEpoch: currentEpoch,
    };
  }
  let currentCheckpoint: CoachSegmentCheckpoint =
    segmentCheckpointCache.get(`${activePending.threadId}:${activePending.segmentId}`) ??
    seg?.lastSyncedCheckpoint ?? {
      activeSessionId: seg?.lastSyncedSessionId,
      activeSessionRevision: seg?.lastSyncedSessionRevision,
      exerciseDigests: {},
      warmupsDigest: '',
      cardioDigest: '',
      planRevisions: seg?.lastSyncedPlanRevisions ?? {},
      memoryHash: seg?.lastSyncedMemoryHash ?? '',
      setupNotesHash: seg?.lastSyncedSetupNotesHash ?? '',
    };

  let lastTimerDirective: CoachRestTimerDirective | undefined;
  let draftPlan: CoachPlanDraft | undefined = activePending.pendingDraftPlan;

  const execCtx: CoachToolExecutionContext = {
    ...params.toolContext,
    activeThreadId: activePending.threadId,
    expectedEpoch: activePending.restoreEpoch,
    deferTimerDispatch: true,
    isWebSearchAllowed: () => Boolean(activePending.webSearchUsed),
  };

  for (let i = 0; i < planned.length; i += 1) {
    const step = planned[i];
    const stepOpId =
      step.operationId || `${activePending.turnId}:r${activePending.round ?? 0}:c${step.index ?? i}`;
    const hasMatchingToolEntry = Boolean(
      findSlotBoundToolEntry(existingEntries, activePending, step),
    );
    if (step.status === 'committed') {
      const priorReceipt = await getCoachReceiptByOperationId(stepOpId);
      if (priorReceipt) {
        await saveCoachReceipt(priorReceipt);
        receipts.push(priorReceipt);
        params.onReceipt?.(priorReceipt);
        if (priorReceipt.toolName === 'manage_coach_memory') {
          const memTarget = priorReceipt.touchedTargets.find((t) => t.kind === 'coach-memory');
          if (memTarget && memTarget.kind === 'coach-memory') {
            const afterIds = new Set(memTarget.afterMemory.items.map((x) => x.id));
            const deleted = memTarget.beforeMemory.items.filter((x) => !afterIds.has(x.id));
            for (const item of deleted) {
              await purgeDeletedMemoryFromCoachHistory({
                memoryId: item.id,
                memoryTitle: item.title,
                memoryContent: item.content,
              });
            }
            if (deleted.length) {
              threadsState = await loadCoachThreadsState();
              threadMeta = threadsState.threads.find((t) => t.id === activePending.threadId);
              seg = threadMeta?.activeSegmentId ? threadMeta.segments?.[threadMeta.activeSegmentId] : seg;
              if (seg) {
                existingEntries = await listProtocolEntries(activePending.threadId, seg.segmentId);
                const reloaded = await getPendingTurn(activePending.turnId);
                activePending = reloaded ?? { ...activePending, segmentId: seg.segmentId };
                const refreshedMemHash = hashTextCompact(
                  formatCoachMemoryForPrompt(await loadCoachMemory(), 1200).trim(),
                );
                currentCheckpoint = { ...currentCheckpoint, memoryHash: refreshedMemHash };
              }
            }
          }
        }
      }
      if (!hasMatchingToolEntry) {
        const projectedJson =
          step.outcomeJson ??
          JSON.stringify(
            projectToolOutcomeForModel(step.name, {
              ok: true,
              summary: priorReceipt?.summary ?? '已完成此前训练操作',
              receipt: priorReceipt,
              data:
                priorReceipt?.timerStarted !== undefined
                  ? { timerStarted: priorReceipt.timerStarted }
                  : undefined,
            }),
          );
        const toolSeq = allocSafeSeq(step.toolEntrySeq);
        const recoveredToolEntry: CoachProtocolEntry = {
          id: `${activePending.threadId}:${activePending.segmentId}:${toolSeq}`,
          threadId: activePending.threadId,
          segmentId: activePending.segmentId,
          seq: toolSeq,
          createdAt: Date.now(),
          kind: 'tool',
          toolCallId: step.toolCallId,
          toolName: step.name,
          toolResultText: projectedJson,
          toolError: false,
        };
        await appendProtocolEntriesStrict([recoveredToolEntry]);
        existingEntries.push(recoveredToolEntry);
        planned[i] = { ...step, outcomeJson: projectedJson, toolEntrySeq: toolSeq };
      }
      continue;
    }

    if (step.status === 'failed') {
      if (!hasMatchingToolEntry) {
        const projectedJson =
          step.outcomeJson ??
          JSON.stringify({ ok: false, errorCode: 'failed', summary: step.errorText || '执行失败' });
        const toolSeq = allocSafeSeq(step.toolEntrySeq);
        const recoveredErrEntry: CoachProtocolEntry = {
          id: `${activePending.threadId}:${activePending.segmentId}:${toolSeq}`,
          threadId: activePending.threadId,
          segmentId: activePending.segmentId,
          seq: toolSeq,
          createdAt: Date.now(),
          kind: 'tool',
          toolCallId: step.toolCallId,
          toolName: step.name,
          toolResultText: projectedJson,
          toolError: true,
        };
        await appendProtocolEntriesStrict([recoveredErrEntry]);
        existingEntries.push(recoveredErrEntry);
        planned[i] = { ...step, toolEntrySeq: toolSeq };
      }
      continue;
    }

    const call: CoachToolCall = {
      id: step.toolCallId,
      operationId: stepOpId,
      index: step.index,
      name: step.name,
      argumentsText: step.argumentsText,
      arguments: step.args,
      ...(step.thoughtSignature ? { thoughtSignature: step.thoughtSignature } : {}),
    };
    const outcome = await executeCoachToolCall(call, {
      ...execCtx,
      expectedEpoch: step.expectedEpoch ?? execCtx.expectedEpoch,
      ...(step.modelExpectedRevision !== undefined
        ? { modelExpectedRevision: step.modelExpectedRevision }
        : {}),
      ...(step.modelExpectedPlanRevision !== undefined
        ? { modelExpectedPlanUpdatedAt: step.modelExpectedPlanRevision }
        : {}),
      ...(step.frozenPrecondition ? { frozenPrecondition: step.frozenPrecondition } : {}),
      ...(step.priorBatchOpIds?.length ? { priorBatchOpIds: step.priorBatchOpIds } : {}),
      ...(step.strictSessionRevision ? { strictSessionRevision: true } : {}),
      requireFrozenPreconditions:
        step.frozenPrecondition !== undefined ||
        step.expectedRevision !== undefined ||
        step.expectedPlanRevision !== undefined,
    });
    recoveryFrozenView = advanceFrozenViewForToolOutcome({
      frozenView: recoveryFrozenView,
      toolName: step.name,
      toolArgs: step.args,
      outcome,
    });
    currentCheckpoint = advanceCheckpointForToolOutcome({
      checkpoint: currentCheckpoint,
      toolName: step.name,
      toolArgs: step.args,
      outcome,
      templatesById: recoveryFrozenView.templatesById,
      formatMemoryPrompt: (store) => formatCoachMemoryForPrompt(store, 1200),
    });
    if (outcome.receipt) {
      receipts.push(outcome.receipt);
      params.onReceipt?.(outcome.receipt);
    }
    if (outcome.timerDirective) {
      lastTimerDirective = outcome.timerDirective;
    }
    if (outcome.draftPlan && !draftPlan) {
      draftPlan = outcome.draftPlan;
    }
    const projectedJson = JSON.stringify(projectToolOutcomeForModel(call.name, outcome));
    const toolSeq = allocSafeSeq(step.toolEntrySeq);
    planned[i] = {
      ...step,
      status: outcome.ok ? 'committed' : 'failed',
      ...(outcome.receipt ? { receiptId: outcome.receipt.id, afterRevision: outcome.receipt.afterRevision } : {}),
      outcomeJson: projectedJson,
      ...(!outcome.ok ? { errorText: outcome.summary } : {}),
      toolEntrySeq: toolSeq,
    };
    let newlyWrittenToolEntry: CoachProtocolEntry | undefined;
    if (!hasMatchingToolEntry) {
      newlyWrittenToolEntry = {
        id: `${activePending.threadId}:${activePending.segmentId}:${toolSeq}`,
        threadId: activePending.threadId,
        segmentId: activePending.segmentId,
        seq: toolSeq,
        createdAt: Date.now(),
        kind: 'tool',
        toolCallId: step.toolCallId,
        toolName: step.name,
        toolResultText: projectedJson,
        toolError: !outcome.ok,
      };
      existingEntries.push(newlyWrittenToolEntry);
    }
    activePending = await commitToolStepOutcomeAtomic({
      entries: newlyWrittenToolEntry ? [newlyWrittenToolEntry] : [],
      pendingTurn: {
        ...activePending,
        plannedToolCalls: [...planned],
        frozenView: structuredClone(recoveryFrozenView),
      },
    });

    if (outcome.deletedMemory) {
      await purgeDeletedMemoryFromCoachHistory({
        memoryId: outcome.deletedMemory.id,
        memoryTitle: outcome.deletedMemory.title,
        memoryContent: outcome.deletedMemory.content,
      });
      threadsState = await loadCoachThreadsState();
      threadMeta = threadsState.threads.find((t) => t.id === activePending.threadId);
      seg = threadMeta?.activeSegmentId ? threadMeta.segments?.[threadMeta.activeSegmentId] : seg;
      if (seg) {
        existingEntries = await listProtocolEntries(activePending.threadId, seg.segmentId);
        const reloaded = await getPendingTurn(activePending.turnId);
        activePending = reloaded ?? { ...activePending, segmentId: seg.segmentId };
        const refreshedMemHash = hashTextCompact(
          formatCoachMemoryForPrompt(await loadCoachMemory(), 1200).trim(),
        );
        currentCheckpoint = { ...currentCheckpoint, memoryHash: refreshedMemHash };
      }
    }
  }

  const finalNextSeq = Math.max(seg?.nextSeq ?? 1, maxSeq + 1);
  if (seg && threadMeta) {
    const nextSeg: CoachSegmentState = {
      ...seg,
      nextSeq: finalNextSeq,
      lastSyncedSessionId: currentCheckpoint.activeSessionId,
      lastSyncedSessionRevision: currentCheckpoint.activeSessionRevision,
      lastSyncedPlanRevisions: currentCheckpoint.planRevisions,
      lastSyncedMemoryHash: currentCheckpoint.memoryHash,
      lastSyncedCheckpoint: currentCheckpoint,
    };
    seg = nextSeg;
    segmentCheckpointCache.set(`${activePending.threadId}:${nextSeg.segmentId}`, currentCheckpoint);
    await patchCoachThreadsState((latest) => ({
      ...latest,
      threads: latest.threads.map((t) =>
        t.id === activePending.threadId
          ? {
              ...t,
              activeSegmentId: nextSeg.segmentId,
              segments: { ...(t.segments ?? {}), [nextSeg.segmentId]: nextSeg },
            }
          : t,
      ),
    }));
  }

  if (lastTimerDirective) {
    const targetSid =
      params.toolContext.activeSession?.id ?? receipts[receipts.length - 1]?.entityId;
    const rt = getActiveSessionRuntime(targetSid);
    if (rt && targetSid) {
      const durableRow = await idbGet<{ key: string; value?: DurableRestTimerRecord }>(
        'meta',
        `${REST_TIMER_STATE_META_PREFIX}${targetSid}`,
      ).catch(() => undefined);
      if (
        shouldDispatchCoachOpTimer({
          replayed: true,
          nativeScheduled: durableRow?.value?.nativeScheduled,
          isFinalTimerInBatch: true,
        })
      ) {
        if (rt.startRestTimerWithDirective) rt.startRestTimerWithDirective(lastTimerDirective);
        else rt.startRestTimer(lastTimerDirective.restSec, lastTimerDirective.source);
      }
    }
  }

  if (draftPlan) {
    await savePendingTurnStrict({
      ...activePending,
      status: 'awaiting_confirmation',
      plannedToolCalls: planned,
      pendingDraftPlan: draftPlan,
    });
    return {
      resumed: true,
      draftPlan,
      receipts,
      text: receipts.length
        ? `已恢复并补齐执行 ${receipts.length} 项训练操作，请确认草稿。`
        : '已恢复待确认草稿。',
    };
  }

  const cfg = params.providerConfig;
  const hasLiveProvider = Boolean(cfg && cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());
  if (hasLiveProvider) {
    const nextPending: CoachPendingTurn = {
      ...activePending,
      status: 'awaiting_followup_model',
      round: (activePending.round ?? 0) + 1,
      plannedToolCalls: planned,
      frozenView: structuredClone(recoveryFrozenView),
    };
    await savePendingTurnStrict(nextPending);
    return runConfirmationFollowupLoop(nextPending, receipts, currentCheckpoint);
  }

  await deletePendingTurnStrict(activePending.turnId);
  return {
    resumed: true,
    draftPlan,
    receipts,
    text: receipts.length
      ? `已恢复并补齐执行 ${receipts.length} 项训练操作：${receipts.map((r) => r.summary).join('；')}。`
      : '中断回合已完成核对。',
  };
}

const REDACTED_MEMORY_TAG = '[已删除记忆]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface MemoryScrubSpec {
  needles: string[];
  plainRegexes: RegExp[];
  escapedRegexes: RegExp[];
  memoryId?: string;
}

function buildMemoryScrubSpec(needles: readonly string[], memoryId?: string): MemoryScrubSpec {
  const unique = Array.from(new Set(needles.map((s) => s.trim()).filter(Boolean))).sort(
    (a, b) => b.length - a.length,
  );
  const variants = new Set<string>(unique);
  for (const n of unique) {
    if (n.length >= 20 && n.endsWith('…')) {
      variants.add(n.slice(0, -1));
    }
  }
  const plainRegexes: RegExp[] = [];
  const escapedRegexes: RegExp[] = [];
  for (const v of variants) {
    const parts = v.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    plainRegexes.push(new RegExp(parts.map(escapeRegExp).join('\\s+'), 'g'));
    const escapedParts = parts.map((p) => escapeRegExp(JSON.stringify(p).slice(1, -1)));
    escapedRegexes.push(
      new RegExp(escapedParts.join('(?:\\\\r\\\\n|\\\\n|\\\\r|\\\\t|\\s)+'), 'g'),
    );
  }
  return { needles: unique, plainRegexes, escapedRegexes, memoryId };
}

function testAnyRegex(text: string, regexes: readonly RegExp[]): boolean {
  for (const re of regexes) {
    re.lastIndex = 0;
    if (re.test(text)) {
      re.lastIndex = 0;
      return true;
    }
  }
  return false;
}

function matchesMemorySpec(val: unknown, spec: MemoryScrubSpec): boolean {
  if (typeof val === 'string') {
    if (spec.memoryId && val.includes(spec.memoryId)) return true;
    return testAnyRegex(val, spec.plainRegexes) || testAnyRegex(val, spec.escapedRegexes);
  }
  if (Array.isArray(val)) return val.some((item) => matchesMemorySpec(item, spec));
  if (val && typeof val === 'object') {
    return Object.values(val as Record<string, unknown>).some((v) => matchesMemorySpec(v, spec));
  }
  return false;
}

function scrubPlainTextWithSpec(input: string, spec: MemoryScrubSpec): string {
  let out = input;
  for (const re of spec.plainRegexes) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED_MEMORY_TAG);
  }
  return out;
}

function scrubRawTextWithJsonEscapes(input: string, spec: MemoryScrubSpec): string {
  let out = scrubPlainTextWithSpec(input, spec);
  for (const re of spec.escapedRegexes) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED_MEMORY_TAG);
  }
  return out;
}

function deepScrubMemoryValueWithSpec(val: unknown, spec: MemoryScrubSpec): unknown {
  if (typeof val === 'string') return scrubPlainTextWithSpec(val, spec);
  if (Array.isArray(val)) return val.map((item) => deepScrubMemoryValueWithSpec(item, spec));
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepScrubMemoryValueWithSpec(v, spec);
    }
    return out;
  }
  return val;
}

function isTargetMemorySavePayload(
  obj: Record<string, unknown>,
  spec: MemoryScrubSpec,
  callId?: string,
  taintedSaveCallIds?: ReadonlySet<string>,
): boolean {
  if (obj.action !== 'save') return false;
  if (callId && taintedSaveCallIds?.has(callId)) return true;
  if (spec.memoryId && obj.id === spec.memoryId) return true;
  return matchesMemorySpec(obj.content, spec) || matchesMemorySpec(obj.title, spec);
}

function scrubMemoryArgsObject(
  obj: Record<string, unknown>,
  spec: MemoryScrubSpec,
  callId?: string,
  taintedSaveCallIds?: ReadonlySet<string>,
): Record<string, unknown> {
  const scrubbed = deepScrubMemoryValueWithSpec(obj, spec) as Record<string, unknown>;
  if (isTargetMemorySavePayload(obj, spec, callId, taintedSaveCallIds)) {
    if (typeof scrubbed.content === 'string') scrubbed.content = REDACTED_MEMORY_TAG;
    if (
      typeof scrubbed.title === 'string' &&
      (matchesMemorySpec(obj.title, spec) ||
        (callId && taintedSaveCallIds?.has(callId)) ||
        (spec.memoryId && obj.id === spec.memoryId))
    ) {
      scrubbed.title = REDACTED_MEMORY_TAG;
    }
  }
  return scrubbed;
}

function scrubJsonEncodedString(
  raw: string,
  spec: MemoryScrubSpec,
  opts?: {
    toolName?: string;
    toolCallId?: string;
    taintedSaveCallIds?: ReadonlySet<string>;
  },
): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (opts?.toolName === 'manage_coach_memory') {
        return JSON.stringify(
          scrubMemoryArgsObject(obj, spec, opts.toolCallId, opts.taintedSaveCallIds),
        );
      }
    }
    return JSON.stringify(deepScrubMemoryValueWithSpec(parsed, spec));
  } catch {
    return scrubRawTextWithJsonEscapes(raw, spec);
  }
}

function scrubBaselineSnapshot(baseline: string, spec: MemoryScrubSpec): string {
  const marker = '基线数据JSON:';
  const idx = baseline.indexOf(marker);
  if (idx < 0) {
    return scrubRawTextWithJsonEscapes(baseline, spec);
  }
  const head = baseline.slice(0, idx + marker.length);
  const jsonTail = baseline.slice(idx + marker.length);
  return `${scrubRawTextWithJsonEscapes(head, spec)}${scrubJsonEncodedString(jsonTail, spec)}`;
}

function collectTaintedMemorySaveCallIds(
  entries: readonly CoachProtocolEntry[],
  spec: MemoryScrubSpec,
): Set<string> {
  const tainted = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'tool' && e.toolName === 'manage_coach_memory' && e.toolCallId) {
      let matched = false;
      if (e.toolResultText) {
        try {
          const parsed = JSON.parse(e.toolResultText) as { data?: { memoryId?: string } };
          if (spec.memoryId && parsed?.data?.memoryId === spec.memoryId) matched = true;
          if (!matched && matchesMemorySpec(parsed, spec)) matched = true;
        } catch {
          if (matchesMemorySpec(e.toolResultText, spec)) matched = true;
        }
      }
      if (matched) tainted.add(e.toolCallId);
    }
    if (e.kind === 'assistant' && e.toolCalls?.length) {
      for (const tc of e.toolCalls) {
        if (tc.name !== 'manage_coach_memory') continue;
        try {
          const parsed = JSON.parse(tc.argumentsText) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && isTargetMemorySavePayload(parsed, spec, tc.id)) {
            tainted.add(tc.id);
          }
        } catch {
          if (matchesMemorySpec(tc.argumentsText, spec)) tainted.add(tc.id);
        }
      }
    }
    if (e.kind === 'assistant' && e.anthropicBlocks?.length) {
      for (const b of e.anthropicBlocks) {
        if (b.type === 'tool_use' && b.name === 'manage_coach_memory' && typeof b.id === 'string') {
          const input = b.input as Record<string, unknown> | undefined;
          if (input && typeof input === 'object' && isTargetMemorySavePayload(input, spec, b.id)) {
            tainted.add(b.id);
          }
        }
      }
    }
    if (e.kind === 'assistant' && e.geminiParts?.length) {
      for (const p of e.geminiParts) {
        const fc = p.functionCall as { id?: unknown; name?: unknown; args?: unknown } | undefined;
        if (fc && fc.name === 'manage_coach_memory' && typeof fc.id === 'string') {
          const argsObj = fc.args as Record<string, unknown> | undefined;
          if (argsObj && typeof argsObj === 'object' && isTargetMemorySavePayload(argsObj, spec, fc.id)) {
            tainted.add(fc.id);
          }
        }
      }
    }
  }
  return tainted;
}

function scrubProtocolEntryWithSpec(
  entry: CoachProtocolEntry,
  spec: MemoryScrubSpec,
  taintedSaveCallIds: ReadonlySet<string>,
  segmentTouched = false,
): { entry: CoachProtocolEntry; touched: boolean; touchedUnresignableThinking: boolean } {
  let touched = false;
  let touchedUnresignableThinking = false;

  const wireText =
    entry.wireText !== undefined ? scrubRawTextWithJsonEscapes(entry.wireText, spec) : undefined;
  if (wireText !== entry.wireText) touched = true;

  const assistantText =
    entry.assistantText !== undefined
      ? scrubRawTextWithJsonEscapes(entry.assistantText, spec)
      : undefined;
  if (assistantText !== entry.assistantText) touched = true;

  const reasoningText =
    entry.reasoningText !== undefined
      ? scrubRawTextWithJsonEscapes(entry.reasoningText, spec)
      : undefined;
  if (reasoningText !== entry.reasoningText) touched = true;

  const toolCalls = entry.toolCalls?.map((tc) => {
    const nextArgsText = scrubJsonEncodedString(tc.argumentsText, spec, {
      toolName: tc.name,
      toolCallId: tc.id,
      taintedSaveCallIds,
    });
    if (nextArgsText !== tc.argumentsText) touched = true;
    return { ...tc, argumentsText: nextArgsText };
  });

  let toolResultText = entry.toolResultText;
  if (entry.toolResultText !== undefined) {
    const isTaintedMemoryTool =
      entry.kind === 'tool' &&
      entry.toolName === 'manage_coach_memory' &&
      ((entry.toolCallId && taintedSaveCallIds.has(entry.toolCallId)) ||
        (() => {
          try {
            const parsed = JSON.parse(entry.toolResultText!) as unknown;
            return matchesMemorySpec(parsed, spec);
          } catch {
            return matchesMemorySpec(entry.toolResultText!, spec);
          }
        })());
    if (isTaintedMemoryTool) {
      toolResultText = JSON.stringify({ ok: true, summary: '[该记忆项已由用户删除]' });
      touched = true;
    } else {
      toolResultText = scrubJsonEncodedString(entry.toolResultText, spec);
      if (toolResultText !== entry.toolResultText) touched = true;
    }
  }

  let anthropicBlocks: Array<Record<string, unknown>> | undefined;
  if (entry.anthropicBlocks?.length) {
    const nextBlocks: Array<Record<string, unknown>> = [];
    for (const rawBlock of entry.anthropicBlocks) {
      if (rawBlock.type === 'redacted_thinking') {
        if (touched || segmentTouched) {
          touched = true;
          touchedUnresignableThinking = true;
          continue;
        }
        nextBlocks.push(rawBlock);
        continue;
      }
      if (rawBlock.type === 'thinking' && typeof rawBlock.thinking === 'string') {
        const cleanThinking = scrubRawTextWithJsonEscapes(rawBlock.thinking, spec);
        if (cleanThinking !== rawBlock.thinking) {
          touched = true;
          if (typeof rawBlock.signature === 'string' && rawBlock.signature) {
            touchedUnresignableThinking = true;
            // 原签名块无法重签，丢弃已污染 thinking 块以保协议合法性与隐私净空
            continue;
          }
          nextBlocks.push({ ...rawBlock, thinking: cleanThinking });
          continue;
        }
        nextBlocks.push(rawBlock);
        continue;
      }
      if (rawBlock.type === 'tool_use') {
        const cloned = structuredClone(rawBlock);
        if (cloned.input && typeof cloned.input === 'object' && !Array.isArray(cloned.input)) {
          const inputObj = cloned.input as Record<string, unknown>;
          const id = typeof cloned.id === 'string' ? cloned.id : undefined;
          const nextInput =
            cloned.name === 'manage_coach_memory'
              ? scrubMemoryArgsObject(inputObj, spec, id, taintedSaveCallIds)
              : (deepScrubMemoryValueWithSpec(inputObj, spec) as Record<string, unknown>);
          if (JSON.stringify(nextInput) !== JSON.stringify(inputObj)) touched = true;
          cloned.input = nextInput;
        }
        nextBlocks.push(cloned);
        continue;
      }
      const scrubbedBlock = deepScrubMemoryValueWithSpec(rawBlock, spec) as Record<string, unknown>;
      if (JSON.stringify(scrubbedBlock) !== JSON.stringify(rawBlock)) touched = true;
      nextBlocks.push(scrubbedBlock);
    }
    anthropicBlocks = nextBlocks;
  }

  let geminiParts: Array<Record<string, unknown>> | undefined;
  if (entry.geminiParts?.length) {
    const nextParts: Array<Record<string, unknown>> = [];
    for (const rawPart of entry.geminiParts) {
      if (rawPart.thought === true && typeof rawPart.text === 'string') {
        const cleanThought = scrubRawTextWithJsonEscapes(rawPart.text, spec);
        if (cleanThought !== rawPart.text) {
          touched = true;
          if (typeof rawPart.thoughtSignature === 'string' && rawPart.thoughtSignature) {
            touchedUnresignableThinking = true;
            continue;
          }
          nextParts.push({ ...rawPart, text: cleanThought });
          continue;
        }
        nextParts.push(rawPart);
        continue;
      }
      if (rawPart.functionCall && typeof rawPart.functionCall === 'object') {
        const cloned = structuredClone(rawPart);
        const fc = cloned.functionCall as Record<string, unknown>;
        if (fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args)) {
          const argsObj = fc.args as Record<string, unknown>;
          const fcId = typeof fc.id === 'string' ? fc.id : undefined;
          const nextArgs =
            fc.name === 'manage_coach_memory'
              ? scrubMemoryArgsObject(argsObj, spec, fcId, taintedSaveCallIds)
              : (deepScrubMemoryValueWithSpec(argsObj, spec) as Record<string, unknown>);
          if (JSON.stringify(nextArgs) !== JSON.stringify(argsObj)) touched = true;
          fc.args = nextArgs;
        }
        nextParts.push(cloned);
        continue;
      }
      const scrubbedPart = deepScrubMemoryValueWithSpec(rawPart, spec) as Record<string, unknown>;
      if (JSON.stringify(scrubbedPart) !== JSON.stringify(rawPart)) touched = true;
      nextParts.push(scrubbedPart);
    }
    geminiParts = nextParts;
  }

  return {
    entry: {
      ...entry,
      ...(wireText !== undefined ? { wireText } : {}),
      ...(assistantText !== undefined ? { assistantText } : {}),
      ...(reasoningText !== undefined ? { reasoningText } : {}),
      ...(toolResultText !== undefined ? { toolResultText } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      ...(anthropicBlocks ? { anthropicBlocks } : {}),
      ...(geminiParts ? { geminiParts } : {}),
    },
    touched,
    touchedUnresignableThinking,
  };
}

const MEMORY_REDACTION_OVERLAY_KEY = 'memoryRedactionOverlay';
const MEMORY_SUMMARY_OVERLAY_KEY = 'memoryRedactionSummaryOverlay';
type CoachMessageRedactionOverlay = Record<string, { text: string; reasoning?: string }>;

/**
 * 在“已净化投影”基础上继续脱敏：对同一气泡先后删除多条记忆时，必须从既有净化文本继续清理，
 * 绝不能从原始 m.text 重新生成（否则会复活先前已删内容）。仅存脱敏文本，不新增明文副本。
 */
function scrubOverlayBase(
  base: string | undefined,
  raw: string,
  spec: MemoryScrubSpec,
): { text: string; changed: boolean } {
  const from = base !== undefined ? base : raw;
  const text = scrubRawTextWithJsonEscapes(from, spec);
  return { text, changed: text !== from };
}

/**
 * 记录“已删记忆”的净化投影（仅存已脱敏文本，绝不新增明文副本）。
 * 摘要入口直接读取 UI 旧气泡文本，因此需在删除时把受影响气泡的净化版本落到 meta，
 * 冷启动后在线/本地摘要统一按同一净化投影出站；UI 原对话与本地 Undo 不受影响。
 * 不做固定条数淘汰：任何淘汰都会让对应气泡回退到含明文的原文。
 */
async function recordMessageRedactionOverlay(spec: MemoryScrubSpec): Promise<void> {
  if (!spec.needles.length && !spec.memoryId) return;
  let messages: CoachStoredMessage[];
  try {
    messages = await loadCoachMessages();
  } catch {
    return;
  }
  if (!messages.length) return;
  const existing = await loadMessageRedactionOverlay();
  let changed = false;
  for (const m of messages) {
    const base = existing[m.id];
    const textRes = scrubOverlayBase(base?.text, m.text, spec);
    const rawReasoning = m.reasoning;
    const baseReasoning = base?.reasoning !== undefined ? base.reasoning : rawReasoning;
    const nextReasoning =
      baseReasoning !== undefined ? scrubRawTextWithJsonEscapes(baseReasoning, spec) : undefined;
    const reasoningChanged = nextReasoning !== undefined && nextReasoning !== baseReasoning;
    if (textRes.changed || reasoningChanged) {
      existing[m.id] = {
        text: textRes.text,
        ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
      };
      changed = true;
    }
  }
  if (changed) await saveCoachVaultMeta(MEMORY_REDACTION_OVERLAY_KEY, existing);
}

async function loadMessageRedactionOverlay(): Promise<CoachMessageRedactionOverlay> {
  try {
    return (await loadCoachVaultMeta<CoachMessageRedactionOverlay>(MEMORY_REDACTION_OVERLAY_KEY)) ?? {};
  } catch {
    return {};
  }
}

/**
 * 统一的“逐气泡净化投影”：把已删记忆污染过的气泡文本/推理替换为净化副本。
 * 摘要 transcript、经济压缩保留段、legacy 首次导入等所有“模型出站”通路都复用它，
 * UI 原对话与本地 Undo 仍保留原文。
 */
function applyMessageRedactionProjection(
  m: CoachStoredMessage,
  overlay: CoachMessageRedactionOverlay,
): CoachStoredMessage {
  const patch = overlay[m.id];
  if (!patch) return m;
  return {
    ...m,
    text: patch.text,
    ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
  };
}

/**
 * 处理“本轮气泡保存晚于删除”：删除发生时当前轮的用户/助手气泡可能尚未落库。
 * 保存后按本进程最近的删除 needle 在既有净化投影上继续脱敏并持久化，冷启动摘要仍可覆盖。
 */
export async function refreshOutboundRedactionForMessages(
  messages: readonly CoachStoredMessage[],
): Promise<void> {
  if (!messages.length || recentPurgeEvents.length === 0) return;
  const needles = recentPurgeEvents.flatMap((e) => e.needles).filter(Boolean);
  if (!needles.length) return;
  const spec = buildMemoryScrubSpec(needles);
  const existing = await loadMessageRedactionOverlay();
  let changed = false;
  for (const m of messages) {
    const base = existing[m.id];
    const textRes = scrubOverlayBase(base?.text, m.text, spec);
    const baseReasoning = base?.reasoning !== undefined ? base.reasoning : m.reasoning;
    const nextReasoning =
      baseReasoning !== undefined ? scrubRawTextWithJsonEscapes(baseReasoning, spec) : undefined;
    const reasoningChanged = nextReasoning !== undefined && nextReasoning !== baseReasoning;
    if (textRes.changed || reasoningChanged) {
      existing[m.id] = {
        text: textRes.text,
        ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
      };
      changed = true;
    }
  }
  if (changed) await saveCoachVaultMeta(MEMORY_REDACTION_OVERLAY_KEY, existing);
}

type CoachSummaryRedactionOverlay = Record<
  string,
  { rawHash: string; rawHashes?: string[]; cleaned: string }
>;

function scrubTextWithRecentPurges(
  input: string,
  mode: 'plain' | 'jsonEscapes' = 'jsonEscapes',
  fromGenExclusive = 0,
): string {
  const needles = recentPurgeEvents
    .filter((ev) => ev.gen > fromGenExclusive)
    .flatMap((ev) => ev.needles)
    .filter(Boolean);
  if (!needles.length) return input;
  const spec = buildMemoryScrubSpec(needles);
  return mode === 'plain'
    ? scrubPlainTextWithSpec(input, spec)
    : scrubRawTextWithJsonEscapes(input, spec);
}

async function resolveRedactedSummaryForThread(
  threadId: string,
  rawSummary: string | undefined,
): Promise<string | undefined> {
  if (rawSummary === undefined) return undefined;
  const summaryOverlay = await loadSummaryRedactionOverlay();
  const entry = summaryOverlay[threadId];
  const rawHash = hashTextCompact(rawSummary);
  if (
    entry &&
    (entry.rawHash === rawHash || entry.rawHashes?.includes(rawHash))
  ) {
    return entry.cleaned;
  }
  return scrubTextWithRecentPurges(rawSummary, 'jsonEscapes');
}

async function loadSummaryRedactionOverlay(): Promise<CoachSummaryRedactionOverlay> {
  try {
    return (await loadCoachVaultMeta<CoachSummaryRedactionOverlay>(MEMORY_SUMMARY_OVERLAY_KEY)) ?? {};
  } catch {
    return {};
  }
}

/**
 * 记录会话级摘要的净化投影（existingSummary 也必须来自可信清理投影）。
 * 以 rawHash / rawHashes 绑定“被删除时的那份旧原文”：只有当前 existingSummary 仍是旧原文时
 * 才用已净化副本；一旦摘要已持久化推进到新版本（hash 变化且非已记录旧 hash），投影自动失效、正常使用新摘要，
 * 绝不永久钉住旧摘要。连续多次删除记忆时在已净化文本上继续清理（不复活）。
 */
async function recordSummaryRedactionOverlay(
  spec: MemoryScrubSpec,
  threadIds: readonly string[],
): Promise<void> {
  if (!spec.needles.length && !spec.memoryId) return;
  let state: Awaited<ReturnType<typeof loadCoachThreadsState>>;
  try {
    state = await loadCoachThreadsState();
  } catch {
    return;
  }
  const existing = await loadSummaryRedactionOverlay();
  let changed = false;
  for (const t of state.threads) {
    if (threadIds.length && !threadIds.includes(t.id)) continue;
    const prev = existing[t.id];
    const rawCandidates = [
      typeof t.contextSummary === 'string' ? t.contextSummary : '',
      typeof t.manualCompaction?.summary === 'string' ? t.manualCompaction.summary : '',
    ].filter(Boolean);
    const raw = rawCandidates[0] ?? '';
    if (!raw && !prev) continue;
    const hashes = new Set<string>(prev?.rawHashes ?? (prev ? [prev.rawHash] : []));
    for (const c of rawCandidates) hashes.add(hashTextCompact(c));
    const rawHash = raw ? hashTextCompact(raw) : (prev?.rawHash ?? '');
    const base = prev ? prev.cleaned : raw;
    const baseMatchesCurrent = raw ? (prev ? hashes.has(rawHash) : true) : true;
    const effectiveBase = prev && baseMatchesCurrent ? prev.cleaned : raw;
    const next = scrubRawTextWithJsonEscapes(effectiveBase, spec);
    const prevCleanStillDirty = prev ? scrubRawTextWithJsonEscapes(base, spec) !== base : false;
    if (next !== effectiveBase || prevCleanStillDirty || !prev || hashes.size > (prev.rawHashes?.length ?? 1)) {
      existing[t.id] = {
        rawHash,
        rawHashes: Array.from(hashes).slice(-8),
        cleaned: next,
      };
      changed = true;
    }
  }
  if (changed) await saveCoachVaultMeta(MEMORY_SUMMARY_OVERLAY_KEY, existing);
}

/**
 * 用户删除长期记忆时彻底清理所有持久化可重放副本（全部历史段基线、协议参数/文本/Thinking/原生块、pendingTurns 与内存缓存），
 * 确保删除后无论是冷重启恢复还是续发下一轮都不会将已删隐私再次送给模型。
 */
export async function purgeDeletedMemoryFromCoachHistory(params: {
  memoryId?: string;
  memoryTitle?: string;
  memoryContent?: string;
  threadId?: string;
}): Promise<void> {
  const needles = [params.memoryTitle?.trim(), params.memoryContent?.trim()]
    .filter((s): s is string => Boolean(s))
    .sort((a, b) => b.length - a.length);
  const spec = buildMemoryScrubSpec(needles, params.memoryId);

  memoryPurgeGeneration += 1;
  const purgeGen = memoryPurgeGeneration;
  recentPurgeEvents.push({
    gen: purgeGen,
    needles: spec.needles,
    ...(params.memoryId ? { memoryId: params.memoryId } : {}),
  });
  if (recentPurgeEvents.length > 32) {
    recentPurgeEvents.splice(0, recentPurgeEvents.length - 32);
  }

  // UI 气泡保留原文；为摘要等“模型出站”路径记录净化投影（只存脱敏文本）
  await recordMessageRedactionOverlay(spec);

  const postPurgeMemPrompt = formatCoachMemoryForPrompt(await loadCoachMemory(), 1200).trim();
  const postPurgeMemoryHash = hashTextCompact(postPurgeMemPrompt);

  const initialState = await loadCoachThreadsState();
  const targetThreadIds = params.threadId
    ? [params.threadId]
    : initialState.threads.map((t) => t.id);
  // existingSummary（会话级摘要）也须来自同一份可信清理投影
  await recordSummaryRedactionOverlay(spec, targetThreadIds);
  const segRenameByThread = new Map<string, Map<string, string>>();
  const activeSegIdByThread = new Map<string, string>();

  await patchCoachThreadsState((latest) => {
    const updatedThreads = latest.threads.map((t) => {
      if (!targetThreadIds.includes(t.id)) return t;
      const renameMap = new Map<string, string>();
      segRenameByThread.set(t.id, renameMap);

      const cleanedSegments: Record<string, CoachSegmentState> = {};
      let nextActiveSegmentId = t.activeSegmentId;
      for (const [segKey, seg] of Object.entries(t.segments ?? {})) {
        const cleanBaseline =
          spec.needles.length || spec.memoryId
            ? scrubBaselineSnapshot(seg.baselineSnapshotJson, spec)
            : seg.baselineSnapshotJson;
        cleanedSegments[segKey] = {
          ...seg,
          baselineSnapshotJson: cleanBaseline,
          baselineSnapshotHash: hashTextCompact(cleanBaseline),
          lastSyncedMemoryHash: postPurgeMemoryHash,
          ...(seg.lastSyncedCheckpoint
            ? {
                lastSyncedCheckpoint: {
                  ...seg.lastSyncedCheckpoint,
                  memoryHash: postPurgeMemoryHash,
                },
              }
            : {}),
        };
      }
      if (t.activeSegmentId && cleanedSegments[t.activeSegmentId]) {
        const curSeg = cleanedSegments[t.activeSegmentId];
        const baseSegId = curSeg.segmentId.replace(/-(?:p\d+|purged)$/i, '');
        const purgedId = `${baseSegId}-p${purgeGen}`;
        renameMap.set(t.activeSegmentId, purgedId);
        if (curSeg.segmentId !== t.activeSegmentId) {
          renameMap.set(curSeg.segmentId, purgedId);
        }
        cleanedSegments[purgedId] = {
          ...curSeg,
          segmentId: purgedId,
          startedAt: Date.now(),
          reason: 'manual_reset' as CoachSegmentReason,
        };
        if (purgedId !== t.activeSegmentId) {
          delete cleanedSegments[t.activeSegmentId];
        }
        nextActiveSegmentId = purgedId;
        activeSegIdByThread.set(t.id, purgedId);
      }
      const nextContextSummary =
        t.contextSummary && (spec.needles.length || spec.memoryId)
          ? scrubRawTextWithJsonEscapes(t.contextSummary, spec)
          : t.contextSummary;
      const nextManualCompaction =
        t.manualCompaction && (spec.needles.length || spec.memoryId)
          ? (() => {
              const cleanedSummary = scrubRawTextWithJsonEscapes(t.manualCompaction.summary, spec);
              return {
                ...t.manualCompaction,
                summary: cleanedSummary,
                summaryHash: hashTextCompact(cleanedSummary),
                keptMessages: t.manualCompaction.keptMessages.map((km) => ({
                  ...km,
                  text: scrubPlainTextWithSpec(km.text, spec),
                })),
              };
            })()
          : t.manualCompaction;
      return {
        ...t,
        ...(nextActiveSegmentId ? { activeSegmentId: nextActiveSegmentId } : {}),
        ...(Object.keys(cleanedSegments).length ? { segments: cleanedSegments } : {}),
        ...(nextContextSummary !== undefined ? { contextSummary: nextContextSummary } : {}),
        ...(nextManualCompaction ? { manualCompaction: nextManualCompaction } : {}),
      };
    });
    return { ...latest, threads: updatedThreads };
  });

  for (const tid of targetThreadIds) {
    for (const k of Array.from(segmentCheckpointCache.keys())) {
      if (k.startsWith(`${tid}:`)) segmentCheckpointCache.delete(k);
    }
    for (const k of Array.from(lastWireStateBySegment.keys())) {
      if (k.startsWith(`${tid}:`)) lastWireStateBySegment.delete(k);
    }

    const entries = await listProtocolEntries(tid);
    const renameMap = segRenameByThread.get(tid);
    const activePurgedSegId = activeSegIdByThread.get(tid);
    const pendings = await listPendingTurns(tid);
    const taintedSaveCallIds = collectTaintedMemorySaveCallIds(entries, spec);
    let activeSegmentHadUnresignableThinking = false;
    let cleanedEntries: CoachProtocolEntry[] = [];

    if (entries.length) {
      const segHasTaint = new Set<string>();
      for (const e of entries) {
        const mappedSegId = renameMap?.get(e.segmentId) ?? e.segmentId;
        if (
          matchesMemorySpec(e.wireText, spec) ||
          matchesMemorySpec(e.assistantText, spec) ||
          matchesMemorySpec(e.reasoningText, spec) ||
          matchesMemorySpec(e.toolResultText, spec) ||
          e.toolCalls?.some(
            (tc) =>
              taintedSaveCallIds.has(tc.id) || matchesMemorySpec(tc.argumentsText, spec),
          ) ||
          matchesMemorySpec(e.anthropicBlocks, spec) ||
          matchesMemorySpec(e.geminiParts, spec)
        ) {
          segHasTaint.add(mappedSegId);
        }
      }

      cleanedEntries = entries.map((e) => {
        const mappedSegId = renameMap?.get(e.segmentId) ?? e.segmentId;
        const base: CoachProtocolEntry = {
          ...e,
          segmentId: mappedSegId,
          id: `${tid}:${mappedSegId}:${e.seq}`,
        };
        if (spec.needles.length === 0 && !spec.memoryId) return base;
        const scrubbed = scrubProtocolEntryWithSpec(
          base,
          spec,
          taintedSaveCallIds,
          segHasTaint.has(mappedSegId),
        );
        if (
          scrubbed.touchedUnresignableThinking &&
          (!activePurgedSegId || mappedSegId === activePurgedSegId)
        ) {
          activeSegmentHadUnresignableThinking = true;
        }
        return scrubbed.entry;
      });
    }

    const activePendingInThread = pendings.find(
      (p) =>
        p.status === 'running_model' ||
        p.status === 'awaiting_tools' ||
        p.status === 'awaiting_followup_model',
    );
    const seqRemapForPending = new Map<number, number>();
    let resetActiveSegNextSeq: number | undefined;

    // 若清理触及不可重签的原生签名思考块，从干净基线重建当前活跃段；保留正在进行中的工具配对
    if (activeSegmentHadUnresignableThinking && activePurgedSegId) {
      const otherSegEntries = cleanedEntries.filter((e) => e.segmentId !== activePurgedSegId);
      const activeSegEntries = cleanedEntries.filter((e) => e.segmentId === activePurgedSegId);
      if (activePendingInThread) {
        const turnUserSeq = Number(activePendingInThread.userMessageId.split(':').pop());
        const startIdx = activeSegEntries.findIndex(
          (e) =>
            e.id === activePendingInThread.userMessageId ||
            (Number.isFinite(turnUserSeq) && e.seq >= turnUserSeq),
        );
        const keptTurnEntries = startIdx >= 0 ? activeSegEntries.slice(startIdx) : [];
        let nextSeq = 1;
        const renumberedTurnEntries = keptTurnEntries.map((e) => {
          const newSeq = nextSeq++;
          seqRemapForPending.set(e.seq, newSeq);
          return {
            ...e,
            seq: newSeq,
            id: `${tid}:${activePurgedSegId}:${newSeq}`,
          };
        });
        cleanedEntries = [...otherSegEntries, ...renumberedTurnEntries];
        resetActiveSegNextSeq = nextSeq;
      } else {
        cleanedEntries = otherSegEntries;
        resetActiveSegNextSeq = 1;
      }
      await patchCoachThreadsState((latest) => ({
        ...latest,
        threads: latest.threads.map((t) => {
          if (t.id !== tid || !t.segments?.[activePurgedSegId]) return t;
          const seg = t.segments[activePurgedSegId];
          return {
            ...t,
            segments: {
              ...t.segments,
              [activePurgedSegId]: {
                ...seg,
                nextSeq: resetActiveSegNextSeq ?? 1,
                containsAssistantWithoutReasoning: false,
              },
            },
          };
        }),
      }));
    }

    if (entries.length) {
      await replaceProtocolEntriesForThread(tid, cleanedEntries);
    }

    for (const p of pendings) {
      const mappedSegId = renameMap?.get(p.segmentId) ?? p.segmentId;
      if (!spec.needles.length && !spec.memoryId && mappedSegId === p.segmentId) continue;
      const mappedUserMsgId = (() => {
        if (seqRemapForPending.size && mappedSegId === activePurgedSegId) {
          const oldSeq = Number(p.userMessageId.split(':').pop());
          const newSeq = seqRemapForPending.get(oldSeq);
          if (newSeq !== undefined) return `${tid}:${mappedSegId}:${newSeq}`;
        }
        return p.userMessageId;
      })();
      const scrubSnap = p.assistantEntrySnapshot
        ? (() => {
            const dummyEntry: CoachProtocolEntry = {
              id: 'pending-snap',
              threadId: tid,
              segmentId: mappedSegId,
              seq: 0,
              createdAt: p.assistantEntrySnapshot.createdAt,
              kind: p.assistantEntrySnapshot.kind,
              assistantText: p.assistantEntrySnapshot.assistantText,
              reasoningText: p.assistantEntrySnapshot.reasoningText,
              toolCalls: p.assistantEntrySnapshot.toolCalls,
              anthropicBlocks: p.assistantEntrySnapshot.anthropicBlocks,
              geminiParts: p.assistantEntrySnapshot.geminiParts,
            };
            const res = scrubProtocolEntryWithSpec(dummyEntry, spec, taintedSaveCallIds, true).entry;
            return {
              ...p.assistantEntrySnapshot,
              ...(res.assistantText !== undefined ? { assistantText: res.assistantText } : {}),
              ...(res.reasoningText !== undefined ? { reasoningText: res.reasoningText } : {}),
              ...(res.toolCalls ? { toolCalls: res.toolCalls } : {}),
              ...(res.anthropicBlocks ? { anthropicBlocks: res.anthropicBlocks } : {}),
              ...(res.geminiParts ? { geminiParts: res.geminiParts } : {}),
            };
          })()
        : undefined;
      const scrubbedPending: CoachPendingTurn = {
        ...p,
        segmentId: mappedSegId,
        userMessageId: mappedUserMsgId,
        ...(p.assistantEntrySeq !== undefined && seqRemapForPending.has(p.assistantEntrySeq)
          ? { assistantEntrySeq: seqRemapForPending.get(p.assistantEntrySeq) }
          : {}),
        userPromptText:
          spec.needles.length || spec.memoryId
            ? scrubPlainTextWithSpec(p.userPromptText, spec)
            : p.userPromptText,
        ...(scrubSnap ? { assistantEntrySnapshot: scrubSnap } : {}),
        ...(p.plannedToolCalls?.length
          ? {
              plannedToolCalls: p.plannedToolCalls.map((pc) => ({
                ...pc,
                ...(pc.toolEntrySeq !== undefined && seqRemapForPending.has(pc.toolEntrySeq)
                  ? { toolEntrySeq: seqRemapForPending.get(pc.toolEntrySeq) }
                  : {}),
                argumentsText:
                  spec.needles.length || spec.memoryId
                    ? scrubJsonEncodedString(pc.argumentsText, spec, {
                        toolName: pc.name,
                        toolCallId: pc.toolCallId,
                        taintedSaveCallIds,
                      })
                    : pc.argumentsText,
                args:
                  spec.needles.length || spec.memoryId
                    ? pc.name === 'manage_coach_memory'
                      ? scrubMemoryArgsObject(pc.args, spec, pc.toolCallId, taintedSaveCallIds)
                      : (deepScrubMemoryValueWithSpec(pc.args, spec) as Record<string, unknown>)
                    : pc.args,
                ...(pc.outcomeJson !== undefined && (spec.needles.length || spec.memoryId)
                  ? {
                      outcomeJson:
                        pc.name === 'manage_coach_memory' && taintedSaveCallIds.has(pc.toolCallId)
                          ? JSON.stringify({ ok: true, summary: '[该记忆项已由用户删除]' })
                          : scrubJsonEncodedString(pc.outcomeJson, spec),
                    }
                  : {}),
                ...(pc.errorText !== undefined && (spec.needles.length || spec.memoryId)
                  ? { errorText: scrubPlainTextWithSpec(pc.errorText, spec) }
                  : {}),
              })),
            }
          : {}),
      };
      await savePendingTurnStrict(scrubbedPending);
    }
  }
}

export async function purgeDeletedAttachmentFromCoachHistory(params: {
  threadId: string;
  attachmentId: string;
}): Promise<void> {
  const entries = await listProtocolEntries(params.threadId);
  const cleaned = entries.map((e) => {
    if (!e.attachments?.some((a) => a.id === params.attachmentId)) return e;
    const remaining = e.attachments.filter((a) => a.id !== params.attachmentId);
    return {
      ...e,
      attachments: remaining.length ? remaining : undefined,
      mediaStripped: true,
    };
  });
  if (entries.length) {
    await replaceProtocolEntriesForThread(params.threadId, cleaned);
  }
}

function buildDeterministicSummary(
  toCompress: CoachStoredMessage[],
  existingSummary?: string,
): string {
  const bullets = toCompress
    .map((m) => {
      const prefix = m.role === 'user' ? '用户' : '教练';
      const clean = m.text.replace(/\s+/g, ' ').trim();
      const snippet = clean.length > 72 ? `${clean.slice(0, 72)}…` : clean;
      return `· ${prefix}：${snippet || '（附件/操作）'}`;
    })
    .slice(-10);
  const merged = [
    ...(existingSummary?.trim() ? [existingSummary.trim()] : []),
    ...bullets,
  ].join('\n');
  return merged.length > 600 ? merged.slice(-600) : merged;
}

/**
 * 压缩早期上下文并独立记账（compact_summary）。
 * 关键修复（v0.2.3）：移除 `220` 字硬截断，保留完整轮次输入，确保模型摘要准确不失真。
 */
export async function compressCoachContext(params: {
  threadId?: string;
  messages: CoachStoredMessage[];
  existingSummary?: string;
  providerConfig?: CoachStoredProviderConfig | null;
  keepRecent?: number;
  signal?: AbortSignal;
}): Promise<{
  summary: string;
  compressedCount: number;
  usedOnlineModel: boolean;
  keptMessages?: CoachManualCompactionKeptMessage[];
}> {
  // 摘要出站统一使用“已删记忆净化投影”：仅覆盖被删除记忆污染过的气泡文本，
  // 其余消息保持原样；UI 原对话与本地 Undo 语义不变。覆盖冷启动与自动/手动摘要分支。
  const purgeGenAtStart = memoryPurgeGeneration;
  const redactionOverlay = await loadMessageRedactionOverlay();
  const summaryThreadId = params.threadId || DEFAULT_COACH_THREAD_ID;
  const cleanedExistingSummary = await resolveRedactedSummaryForThread(
    summaryThreadId,
    params.existingSummary,
  );
  const projectForOutbound = (m: CoachStoredMessage): CoachStoredMessage =>
    applyMessageRedactionProjection(m, redactionOverlay);
  const eligible = params.messages
    .filter((m) => !m.isDemo && !m.compressed)
    .map(projectForOutbound);
  const keep = Math.max(2, Math.min(8, params.keepRecent ?? 2));
  if (eligible.length < keep + 2) {
    return {
      summary: cleanedExistingSummary ?? '',
      compressedCount: 0,
      usedOnlineModel: false,
    };
  }
  const toCompress = eligible.slice(0, -keep);
  const rawKeptSlice = params.messages.filter((m) => !m.isDemo && !m.compressed).slice(-keep);
  const buildRedactedKept = async (): Promise<CoachManualCompactionKeptMessage[]> => {
    const latestOverlay =
      memoryPurgeGeneration > purgeGenAtStart
        ? await loadMessageRedactionOverlay()
        : redactionOverlay;
    return rawKeptSlice.map((orig) => {
      const projected = applyMessageRedactionProjection(orig, latestOverlay);
      const cleanedText =
        memoryPurgeGeneration > purgeGenAtStart
          ? scrubTextWithRecentPurges(projected.text, 'plain', purgeGenAtStart)
          : projected.text;
      return {
        id: orig.id,
        role: orig.role,
        createdAt: orig.createdAt,
        text: cleanedText,
      };
    });
  };
  const finalizeSummaryText = (raw: string): string =>
    memoryPurgeGeneration > purgeGenAtStart
      ? scrubTextWithRecentPurges(raw, 'jsonEscapes', purgeGenAtStart)
      : raw;

  const cfg = params.providerConfig;
  const hasLiveProvider = Boolean(cfg && cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());

  if (hasLiveProvider && cfg) {
    const caps = resolveProviderCapabilities(cfg);
    const threadId = params.threadId || DEFAULT_COACH_THREAD_ID;
    const reqStartMs = Date.now();
    try {
      const transcript = toCompress
        .map((m) => `${m.role === 'user' ? '用户' : '教练'}: ${m.text.replace(/\s+/g, ' ').trim()}`)
        .join('\n');
      const promptMessages: CoachTurnMessage[] = [
        {
          role: 'system',
          text: '请把下面这段力量训练助手对话提炼为简明中文上下文摘要（不超过 300 字），仅保留关键动作、重量/次数调整、训练计划结论和待确认事项，不要闲聊。',
        },
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `${cleanedExistingSummary?.trim() ? `既有摘要：\n${cleanedExistingSummary.trim()}\n\n` : ''}待压缩对话：\n${transcript}`,
            },
          ],
        },
      ];
      let modelSummary = '';
      let rawUsage: Record<string, unknown> | undefined;
      for await (const ev of streamCoachTurn(toProviderConfig(cfg), promptMessages, [], {
        signal: params.signal,
        thinkingDepth: 'off',
        maxTokens: 450,
        includeUsage: true,
        capabilities: caps,
      })) {
        if (ev.type === 'text_delta') modelSummary += ev.delta;
        else if (ev.type === 'done') rawUsage = ev.rawUsage;
      }

      await saveBillingRecordStrict(
        normalizeUsageToBillingRecord({
          id: `bill-cmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          threadId,
          segmentId: 'compaction',
          round: 0,
          purpose: 'compact_summary',
          capabilities: caps,
          rawUsage,
          durationMs: Math.max(1, Date.now() - reqStartMs),
        }),
      );

      const clean = finalizeSummaryText(modelSummary.trim());
      if (clean) {
        return {
          summary: clean.slice(0, 600),
          compressedCount: toCompress.length,
          usedOnlineModel: true,
          keptMessages: await buildRedactedKept(),
        };
      }
    } catch {
      /* 在线摘要失败时自动回退为本地确定性压缩 */
    }
  }

  return {
    summary: finalizeSummaryText(buildDeterministicSummary(toCompress, cleanedExistingSummary)),
    compressedCount: toCompress.length,
    usedOnlineModel: false,
    keptMessages: await buildRedactedKept(),
  };
}

export function buildLocalCoachTitle(input: string, dayName?: string): string {
  const firstSentence = input
    .trim()
    .replace(/\s+/g, ' ')
    .split(/[。！？!?\n]/)[0]
    ?.trim() ?? '';
  if (dayName?.trim() && firstSentence.length > 0 && firstSentence.length <= 10) {
    const joined = `${dayName.trim()}·${firstSentence}`;
    return joined.slice(0, 18);
  }
  if (firstSentence) {
    return firstSentence.length > 16 ? `${firstSentence.slice(0, 15)}…` : firstSentence;
  }
  if (dayName?.trim()) return `${dayName.trim()}训练`;
  return '新对话';
}

export async function suggestCoachTitle(
  input: string,
  _reply: string,
  config: CoachStoredProviderConfig | null,
  options?: { dayName?: string; threadId?: string; allowRemote?: boolean },
): Promise<string | undefined> {
  const localTitle = buildLocalCoachTitle(input, options?.dayName);
  if (!config?.apiKey || !config.baseUrl || !config.model) {
    return localTitle;
  }
  const caps = resolveProviderCapabilities(config);
  // DeepSeek 官方与百炼默认使用零请求本地标题；只有显式启用且能力支持低上限关闭思考时才发请求
  if (!options?.allowRemote || !caps.supportsTitleModelCall) {
    return localTitle;
  }
  const reqStartMs = Date.now();
  let result = '';
  let rawUsage: Record<string, unknown> | undefined;
  try {
    for await (const event of streamCoachTurn(
      toProviderConfig(config),
      [
        { role: 'system', text: '用 6–14 个字概括本轮训练话题。只输出标题。' },
        { role: 'user', parts: [{ type: 'text', text: input.slice(0, 260) }] },
      ],
      [],
      {
        signal: AbortSignal.timeout(8000),
        thinkingDepth: 'off',
        maxTokens: 48,
        includeUsage: true,
        capabilities: caps,
      },
    )) {
      if (event.type === 'text_delta') result += event.delta;
      else if (event.type === 'done') rawUsage = event.rawUsage;
    }
    await saveBillingRecordStrict(
      normalizeUsageToBillingRecord({
        id: `bill-ttl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        threadId: options?.threadId || DEFAULT_COACH_THREAD_ID,
        segmentId: 'title',
        round: 0,
        purpose: 'title_gen',
        capabilities: caps,
        rawUsage,
        durationMs: Math.max(1, Date.now() - reqStartMs),
      }),
    );
    return result.trim() || localTitle;
  } catch {
    return localTitle;
  }
}
