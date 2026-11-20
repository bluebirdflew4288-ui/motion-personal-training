/* 电子教练对话引擎与工具调度循环（阶段 2）。
   双模同轨：
   1. 在线模型模式：基于 providerAdapter.ts（streamCoachTurn）走真实 SSE 流式 + 多轮 tool call；
   2. 本地确定性引擎模式（无 API Key 或离线受控模式）：按同一组 coachTools / coachTx 通道执行 7 类写操作、
      识图草稿提取、全量历史检索、只读解释与冲突/脏值阻断，确保离线也可完整端到端运行。
   用户侧话术严格屏蔽内部工具标识符。 */

import { extractPlanDraftFromImage } from './coachImage';
import type {
  CoachOperationReceipt,
  CoachPlanDraft,
  CoachStoredAttachment,
  CoachStoredMessage,
  CoachStoredProviderConfig,
} from './coachStorage';
import {
  buildCoachReadOnlyContext,
  COACH_TOOL_DEFINITIONS,
  executeCoachToolCall,
  type CoachReadOnlyContext,
  type CoachToolExecutionContext,
} from './coachTools';
import {
  streamCoachTurn,
  supportsCoachTitle,
  type CoachContentPart,
  type CoachProviderConfig,
  type CoachThinkingDepth,
  type CoachToolCall,
  type CoachTurnMessage,
} from './providerAdapter';

export interface RunCoachTurnParams {
  userText: string;
  attachments?: CoachStoredAttachment[];
  history: CoachStoredMessage[];
  contextSummary?: string;
  thinkingDepth?: CoachThinkingDepth;
  providerConfig?: CoachStoredProviderConfig | null;
  toolContext: CoachToolExecutionContext;
  signal?: AbortSignal;
  /** 仅测试快速完结流时传 0；UI 交互默认按 35ms 分片流式输出以便支持中途取消 */
  streamChunkDelayMs?: number;
  onTextChunk?: (accumulatedText: string) => void;
  onReasoningChunk?: (accumulatedReasoning: string) => void;
  onReceipt?: (receipt: CoachOperationReceipt) => void;
  requestTitle?: boolean;
  onTitle?: (title: string) => void;
  onThinkingFallback?: () => void;
  onDraftPlan?: (draft: CoachPlanDraft) => void;
}

export interface RunCoachTurnResult {
  text: string;
  reasoning?: string;
  receipts: CoachOperationReceipt[];
  draftPlan?: CoachPlanDraft;
  aborted: boolean;
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

const READONLY_WRITE_TARGET_RE = /(热身|warmup|有氧|cardio|跑步机|椭圆机|划船机|登山|单车|器械档位|档位备忘|setupNote)/i;
const MUTATION_VERB_RE = /(改|调|设|加|删|减|写|记|换|开启|修改|更新)/;
const TARGET_ADJUST_RE = /(下一组|目标|改为\s*\d+\s*组|调整.{0,12}?(?:组|次|kg))/i;
const SET_RECORD_RE = /(?:刚才|刚完成|做完|推了|拉了|蹲了|第\s*\d+\s*组).{0,20}?(?:\d+\s*次|\d+(?:\.\d+)?\s*kg)|(?:第\s*\d+\s*组).{0,10}?(?:改成|改为|记为|记作|做了)\s*(?:\d+|空|null)/i;
const SUPERSET_RE = /(超级组|配对|拆散|解除配对)/i;
const SYNC_PLAN_RE = /(同步回|更新原计划|仅改本次|仅保留本次)/i;
const HISTORY_EDIT_RE = /(历史|上次|上一次|那次).{0,16}?(?:改成|纠错|修改|备注)/i;
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

async function runDeterministicLocalTurn(
  params: RunCoachTurnParams,
): Promise<RunCoachTurnResult> {
  const { userText, attachments, toolContext, signal, streamChunkDelayMs = 38 } = params;
  const receipts: CoachOperationReceipt[] = [];
  let draftPlan: CoachPlanDraft | undefined;

  const trimmed = userText.trim();
  const hasVideo = Boolean(attachments?.some((a) => a.kind === 'video'));
  const hasImage = Boolean(attachments?.some((a) => a.kind !== 'video'));

  // 0. 离线引擎不支持视频帧解析，明确提示用户切换支持视频理解的在线模型
  if (hasVideo) {
    const vid = attachments?.find((a) => a.kind === 'video');
    const text = await emitStreamedText(
      `已接收你选择的视频「${vid?.name || '训练视频'}」。本地离线引擎暂不具备视频动作识别能力；请点击左上或「+ → 模型切换 / 设置」配置支持视频的多模态模型（如 Gemini 2.5 / 3 系列或兼容视频理解的模型）后重试。`,
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
      `已从图片提取可编辑计划草稿「${draft.planName}」：\n${lines}\n你可以在下方草稿卡片中直接修改名称、动作或组次后再点「确认新建计划」。`,
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

  // 2. 只读范围保护：热身 / 有氧 / 器械档位备忘禁止写操作
  if (READONLY_WRITE_TARGET_RE.test(trimmed) && MUTATION_VERB_RE.test(trimmed) && !HISTORY_EDIT_RE.test(trimmed)) {
    const text = await emitStreamedText(
      `首版电子教练对「热身、6 种有氧预设（含当前有氧）及器械档位备忘」为只读上下文，仅支持读取复盘，暂不直接修改这些字段。你可以直接在训练页对应卡片中手动调整。`,
      streamChunkDelayMs,
      signal,
      params.onTextChunk,
    );
    return { text, receipts, aborted: false };
  }

  // 3. 完训同步 vs 仅改本次训练
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

  // 4. 超级组配对 / 拆散
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

  // 5. 历史纠错
  if (HISTORY_EDIT_RE.test(trimmed) && roCtx.historySessions.length > 0) {
    const latestHist = roCtx.historySessions[0];
    const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
    const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
    const round = parseNumberAfter(trimmed, /第\s*(\d+)\s*组/);
    const exMatch = findNamedExercise(latestHist.exercises, trimmed);
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

  // 6. 进行中目标调整（严格不标 done、不触发计时器）
  if (roCtx.activeSession && TARGET_ADJUST_RE.test(trimmed) && !/做完|推了|拉了|蹲了|刚才/.test(trimmed)) {
    const ex = findNamedExercise(roCtx.activeSession.exercises, trimmed);
    if (ex) {
      const sets = parseNumberAfter(trimmed, /(\d+)\s*组/);
      const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
      const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('adjust_active_target', {
          sessionId: roCtx.activeSession.id,
          exId: ex.id,
          expectedRevision: roCtx.activeSession.revision,
          ...(sets !== undefined && !/下一组/.test(trimmed) ? { sets } : {}),
          ...(reps !== undefined ? { repsMin: reps, repsMax: reps } : {}),
          ...(weight !== undefined ? { suggestedWeightKg: weight } : {}),
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

  // 7. 进行中逐组实绩记录 / 纠正
  if (roCtx.activeSession && SET_RECORD_RE.test(trimmed)) {
    const ex = findNamedExercise(roCtx.activeSession.exercises, trimmed);
    if (ex) {
      const round = parseNumberAfter(trimmed, /第\s*(\d+)\s*组/);
      const reps = parseNumberAfter(trimmed, /(\d+)\s*次/);
      const weight = parseNumberAfter(trimmed, /(\d+(?:\.\d+)?)\s*kg/i);
      const emptyRepsRequested = /改为\s*空|清空次数|记为\s*空/.test(trimmed);
      const outcome = await executeCoachToolCall(
        makeLocalToolCall('record_active_set', {
          sessionId: roCtx.activeSession.id,
          exId: ex.id,
          expectedRevision: roCtx.activeSession.revision,
          ...(round !== undefined ? { roundIndex: round } : {}),
          ...(emptyRepsRequested ? { reps: null } : reps !== undefined ? { reps } : {}),
          ...(weight !== undefined ? { weightKg: weight } : {}),
          status: 'done',
        }),
        toolContext,
      );
      if (outcome.receipt) {
        receipts.push(outcome.receipt);
        params.onReceipt?.(outcome.receipt);
      }
      const reply = outcome.ok
        ? `${outcome.summary}。${outcome.data?.timerStarted ? '已同步开启组间休息倒计时。' : '本次为已有组更新，未重复打断计时器。'}`
        : `未能写入记录：${outcome.summary}`;
      const text = await emitStreamedText(reply, streamChunkDelayMs, signal, params.onTextChunk);
      return { text, receipts, aborted: false };
    }
  }

  // 8. 全量历史查询 / 只读复盘（保证查到超过 40 条之外的老记录）
  if (HISTORY_QUERY_RE.test(trimmed)) {
    const oldest = roCtx.historySessions[roCtx.historySessions.length - 1];
    const nthMatch = parseNumberAfter(trimmed, /第\s*(\d+)\s*次/);
    const nthItem = nthMatch ? roCtx.historySessions[nthMatch - 1] : undefined;
    const picked = nthItem ?? oldest;
    const summaryReply = picked
      ? `已完成全量历史检索（共 ${roCtx.totalCompletedSessions} 条已完成记录）：${nthItem ? `第 ${nthMatch} 条` : '最早一条'}是「${picked.dayName}」，完成 ${picked.completedSets} 组（${picked.exercises.map((e) => `${e.name}${e.maxWeightKg !== null ? ` ${e.maxWeightKg}kg` : ''}`).join('、')}）。`
      : '目前还没有已完成的历史训练记录。';
    const text = await emitStreamedText(summaryReply, streamChunkDelayMs, signal, params.onTextChunk);
    return { text, receipts, aborted: false };
  }

  // 9. 热身 / 有氧 / 器械档位只读解读
  if (READONLY_WRITE_TARGET_RE.test(trimmed)) {
    const warmupsSummary = roCtx.activeSession?.warmups.length
      ? roCtx.activeSession.warmups.map((w) => `${w.name}(${w.targetText}${w.done ? '，已完成' : ''})`).join('、')
      : '本次无热身项';
    const setupList = roCtx.activeSession?.exercises
      .filter((e) => e.setupNote)
      .map((e) => `${e.name}：${e.setupNote}`)
      .join('；');
    const presetsList = roCtx.cardioPresets.map((c) => c.label).join('、');
    const text = await emitStreamedText(
      `当前训练只读上下文：\n· 热身：${warmupsSummary}\n· 器械档位备忘：${setupList || '暂无'}\n· 6 种有氧预设：${presetsList}`,
      streamChunkDelayMs,
      signal,
      params.onTextChunk,
    );
    return { text, receipts, aborted: false };
  }

  // 10. 默认对话回复（离线/引导模式，也支持流式取消）
  const activeHint = roCtx.activeSession
    ? `当前正在进行「${roCtx.activeSession.dayName}」（${roCtx.activeSession.exercises.length} 个动作）。`
    : '当前不在活跃训练中，你可以发一张训练计划图让我生成可编辑草稿，或直接和我复盘历史训练。';
  const replyText =
    `收到你的记录「${trimmed || '图片参考'}」。${activeHint}\n` +
    `你可以直接说例如：「卧推第 2 组 60kg 做了 11 次」「把下一组卧推目标改为 12 次」，或上传计划图片由我识别草稿供你确认。`;
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
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
  };
}

function buildSystemPrompt(roCtx: CoachReadOnlyContext, contextSummary?: string): string {
  return [
    '你是 MOTION 内置电子教练。',
    '规则：',
    '1. 所有训练写入必须使用工具执行，成功后系统会在界面呈现操作回执，你绝不要在回复中暴露任何内部英文函数/工具名。',
    '2. 严格区分「目标设定」与「实际完成」：只修改目标时不标为已完成、不触发计时器；写入已完成组时必须包含有效次数，遇到焦点冲突或非法数值须如实停下告知用户。',
    '3. 热身、有氧（6种预设）与器械档位备忘为只读上下文，用户要求修改时如实说明暂不支持直接代改。',
    '4. 若涉及将本次调整同步回原计划，须先明确区分「仅改本次训练」与「同步更新原计划」。',
    ...(contextSummary?.trim()
      ? [`早期对话上下文摘要（已压缩以节省费用）：${contextSummary.trim()}`]
      : []),
    `当前只读上下文：${JSON.stringify({ activeSession: roCtx.activeSession, cardioPresets: roCtx.cardioPresets.map((c) => c.label), totalCompletedSessions: roCtx.totalCompletedSessions })}`,
  ].join('\n');
}

export async function runCoachTurn(params: RunCoachTurnParams): Promise<RunCoachTurnResult> {
  const cfg = params.providerConfig;
  const hasLiveProvider = Boolean(cfg && cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());
  if (!hasLiveProvider || !cfg) {
    return runDeterministicLocalTurn(params);
  }

  const roCtx = await buildCoachReadOnlyContext(params.toolContext, {
    includeAllHistory: false,
    historyLimit: 8,
  });

  const userParts: CoachContentPart[] = [];
  if (params.userText.trim()) userParts.push({ type: 'text', text: params.userText.trim() });
  for (const att of params.attachments ?? []) {
    if (!att.dataBase64) continue;
    userParts.push({
      type: att.kind === 'video' ? 'video' : 'image',
      mimeType: att.mimeType,
      dataBase64: att.dataBase64,
    });
  }

  const conversation: CoachTurnMessage[] = [
    { role: 'system', text: buildSystemPrompt(roCtx, params.contextSummary) },
    ...params.history
      .filter((m) => !m.isDemo && !m.compressed)
      .slice(-16)
      .map(
        (m): CoachTurnMessage =>
          m.role === 'user'
            ? { role: 'user', parts: [{ type: 'text', text: m.text }] }
            : { role: 'assistant', text: m.text },
      ),
    { role: 'user', parts: userParts.length ? userParts : [{ type: 'text', text: '请帮我看下这个附件' }] },
  ];

  let draftPlan: CoachPlanDraft | undefined;
  const effectiveThinking: CoachThinkingDepth = params.thinkingDepth ?? cfg.thinkingDepth ?? 'default';
  let usedDefaultThinking = false;
  const receipts: CoachOperationReceipt[] = [];
  let accumulatedText = '';
  let accumulatedReasoning = '';

  try {
    for (let round = 0; round < 6; round += 1) {
      if (params.signal?.aborted) {
        return {
          text: accumulatedText,
          ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
          receipts,
          aborted: true,
        };
      }
      const pendingCalls: CoachToolCall[] = [];
      let roundText = '';
      let roundReasoning = '';

      for await (const ev of streamCoachTurn(
        toProviderConfig(cfg),
        conversation,
        COACH_TOOL_DEFINITIONS,
        {
          signal: params.signal,
          thinkingDepth: usedDefaultThinking ? 'default' : effectiveThinking,
          allowThinkingFallback: round === 0,
          requestTitle: round === 0 && params.requestTitle,
        },
      )) {
        if (ev.type === 'title') {
          params.onTitle?.(ev.title);
        } else if (ev.type === 'thinking_fallback') {
          usedDefaultThinking = true;
          params.onThinkingFallback?.();
        } else if (ev.type === 'reasoning_delta') {
          roundReasoning += ev.delta;
          params.onReasoningChunk?.(accumulatedReasoning + roundReasoning);
        } else if (ev.type === 'text_delta') {
          roundText += ev.delta;
          params.onTextChunk?.(accumulatedText + roundText);
        } else if (ev.type === 'tool_call') {
          pendingCalls.push(ev.call);
        }
      }

      accumulatedReasoning += roundReasoning;
      accumulatedText += roundText;
      if (pendingCalls.length === 0) break;

      conversation.push({
        role: 'assistant',
        text: roundText,
        reasoning: roundReasoning,
        toolCalls: pendingCalls,
      });

      for (const call of pendingCalls) {
        if (params.signal?.aborted) throw abortError();
        const outcome = await executeCoachToolCall(call, params.toolContext);
        if (outcome.draftPlan && !draftPlan && !params.signal?.aborted) {
          draftPlan = outcome.draftPlan;
          params.onDraftPlan?.(draftPlan);
        }
        if (outcome.receipt) {
          receipts.push(outcome.receipt);
          params.onReceipt?.(outcome.receipt);
        }
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: JSON.stringify(outcome.draftPlan ? { ok: true, summary: outcome.summary } : outcome),
        });
      }
    }
    return {
      text: accumulatedText || (draftPlan ? '请核对草稿后创建计划。' : ''),
      draftPlan,
      ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
      receipts,
      aborted: false,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        text: accumulatedText,
        ...(accumulatedReasoning ? { reasoning: accumulatedReasoning } : {}),
        receipts,
        aborted: true,
      };
    }
    throw err;
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
 * 压缩当前对话中除最近 2 条以外的早期上下文，保留可读历史消息同时降低后续发送给模型的 Token 开销。
 */
export async function compressCoachContext(params: {
  messages: CoachStoredMessage[];
  existingSummary?: string;
  providerConfig?: CoachStoredProviderConfig | null;
  signal?: AbortSignal;
}): Promise<{ summary: string; compressedCount: number; usedOnlineModel: boolean }> {
  const eligible = params.messages.filter((m) => !m.isDemo && !m.compressed);
  if (eligible.length < 4) {
    return {
      summary: params.existingSummary ?? '',
      compressedCount: 0,
      usedOnlineModel: false,
    };
  }
  const toCompress = eligible.slice(0, -2);
  const cfg = params.providerConfig;
  const hasLiveProvider = Boolean(cfg && cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());

  if (hasLiveProvider && cfg) {
    try {
      const transcript = toCompress
        .map((m) => `${m.role === 'user' ? '用户' : '教练'}: ${m.text.replace(/\s+/g, ' ').slice(0, 220)}`)
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
              text: `${params.existingSummary?.trim() ? `既有摘要：\n${params.existingSummary.trim()}\n\n` : ''}待压缩对话：\n${transcript}`,
            },
          ],
        },
      ];
      let modelSummary = '';
      for await (const ev of streamCoachTurn(toProviderConfig(cfg), promptMessages, [], {
        signal: params.signal,
        thinkingDepth: 'off',
        maxTokens: 450,
      })) {
        if (ev.type === 'text_delta') modelSummary += ev.delta;
      }
      const clean = modelSummary.trim();
      if (clean) {
        return {
          summary: clean.slice(0, 600),
          compressedCount: toCompress.length,
          usedOnlineModel: true,
        };
      }
    } catch {
      /* 在线摘要失败时自动回退为本地确定性压缩，确保不阻塞用户整理上下文 */
    }
  }

  return {
    summary: buildDeterministicSummary(toCompress, params.existingSummary),
    compressedCount: toCompress.length,
    usedOnlineModel: false,
  };
}


export async function suggestCoachTitle(
  input: string,
  reply: string,
  config: CoachStoredProviderConfig | null,
): Promise<string | undefined> {
  if (!config?.apiKey || !config.baseUrl || !config.model || supportsCoachTitle(config)) return;
  let result = '';
  for await (const event of streamCoachTurn(toProviderConfig(config), [
    { role: 'system', text: '用 6–14 个字概括本轮训练话题。只输出标题。' },
    { role: 'user', parts: [{ type: 'text', text: input.slice(0, 300) + '\n' + reply.slice(0, 300) }] },
  ], [], { signal: AbortSignal.timeout(8000) })) {
    if (event.type === 'text_delta') result += event.delta;
  }
  return result.trim() || undefined;
}
