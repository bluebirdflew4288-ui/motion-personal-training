/* MOTION 内置电子教练界面（阶段 2 + 完整对话体验：+号工具盘 / 思考深度 / 图片与视频 / 多对话与压缩）。
   ── 关键设计边界 ──────────────────────────────────────────────
   1. 与业务壳同壳持久挂载：互换主/小窗只改变外框缩放，聊天草稿、待发图片/视频、
      滚动位置与正在生成的回复完整保留；
   2. 所有教练写操作走 coachTools / coachTx 统一原子事务，数据仅存入隔离库 motion-coach-vault，
      绝不进入 BackupPayload v4；
   3. 「关闭窗口」「取消生成中回复」「撤销已提交业务修改」三语义严格独立；
   4. 大图/视频预览与二级弹出层登记至 backStack，物理返回键按层级依次收起。 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { backStack } from '../lib/backIntent';
import { useStore } from '../store';
import {
  abandonPendingCoachTurn,
  compressCoachContext,
  inspectCoachThreadPendingState,
  reconcileStaleBillingTotalsInVault,
  refreshOutboundRedactionForMessages,
  resumePendingCoachTurn,
  runCoachTurn,
  suggestCoachTitle,
  type CoachThreadPendingState,
} from './coachAgent';
import {
  computeCoachContextStats,
  formatCompactTokens,
  formatDurationCompact,
} from './coachContext';
import { attachmentToDataUrl, compressCoachImage, prepareCoachVideo } from './coachImage';
import {
  createEmptyCoachMemory,
  formatCoachMemoryForPrompt,
  loadCoachMemory,
  type CoachMemoryStore,
} from './coachMemory';
import { CoachDraftCard } from './CoachDraftCard';
import { CoachMarkdown } from './CoachMarkdown';
import { CoachMemoryPanel } from './CoachMemoryPanel';
import { CoachSettingsPanel } from './CoachSettingsPanel';
import { hashTextCompact } from './coachDelta';
import {
  createCoachThreadWithFirstMessageInVault,
  createDefaultCoachThreadsState,
  commitManualCompactionInVault,
  deleteCoachMessagesByIds,
  deleteCoachThread,
  deletePendingTurnStrict,
  DEFAULT_COACH_THREAD_ID,
  listCoachReceipts,
  listPendingTurns,
  loadCoachMessages,
  loadCoachProviderConfig,
  loadCoachThreadsState,
  normalizeWebSearchProvider,
  patchCoachThreadUiFields,
  saveCoachProviderConfig,
  switchActiveCoachThreadInVault,
  upsertCoachMessages,
  type CoachManualCompactionRecord,
  type CoachOperationReceipt,
  type CoachPendingTurn,
  type CoachPlanDraft,
  type CoachStoredAttachment,
  type CoachStoredMessage,
  type CoachStoredProviderConfig,
  type CoachThreadMeta,
  type CoachThreadsState,
  type CoachWebSearchProvider,
} from './coachStorage';
import { coachCreatePlanFromDraft, undoCoachReceipt, type CoachTxHooks } from './coachTx';
import {
  coachModelKey, coachThinkingLabel, coachThinkingLevels,
  isOfficialDeepSeek,
  type CoachCitation,
  type CoachProviderKind,
  type CoachThinkingDepth,
} from './providerAdapter';
import { computeDeploymentId } from './providerCapabilities';
import { useDualWindow } from './windowState';

interface UiPreviewAttachment {
  id: string;
  kind?: 'image' | 'video';
  name: string;
  dataUrl: string;
  posterDataUrl?: string;
  durationSec?: number;
  width: number;
  height: number;
  sizeBytes: number;
  stored?: CoachStoredAttachment;
}

interface CoachUiMessage {
  id: string;
  threadId?: string;
  role: 'user' | 'assistant';
  createdAt: number;
  text: string;
  reasoning?: string;
  attachment?: UiPreviewAttachment;
  demoReceipt?: {
    id: string;
    label: string;
    undone: boolean;
  };
  receiptIds?: string[];
  draftPlan?: CoachPlanDraft;
  citations?: CoachCitation[];
  thinkingFallback?: boolean;
  compressed?: boolean;
  streaming?: boolean;
  isDemo?: boolean;
}

function isPlaceholder(thread: CoachThreadMeta): boolean {
  return thread.titleSource === 'placeholder' ||
    (!thread.titleSource && /^(默认对话|新对话( \d+)?)$/.test(thread.title));
}

function conversationTitle(text: string): string {
  return Array.from(text.trim().replace(/\s+/g, ' ').replace(/^["“「]|["”」]$/g, ''))
    .slice(0, 28).join('');
}

const SAMPLE_PLAN_SVG_DATA_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
      `<rect width="320" height="200" fill="#fbf7ec" stroke="#16130e" stroke-width="3"/>` +
      `<rect x="14" y="14" width="292" height="30" fill="#16130e"/>` +
      `<text x="24" y="34" fill="#f4efe2" font-family="sans-serif" font-size="14" font-weight="700">示例训练图 · 推胸日（阶段 2 示例）</text>` +
      `<text x="24" y="72" fill="#16130e" font-family="monospace" font-size="13">1. 平板杠铃卧推  4×8  70 kg</text>` +
      `<text x="24" y="102" fill="#16130e" font-family="monospace" font-size="13">2. 上斜哑铃推举  3×10 22 kg/手</text>` +
      `<text x="24" y="132" fill="#b23a20" font-family="monospace" font-size="13">3. 蝴蝶机夹胸+俯卧撑 超级组 3轮</text>` +
      `<text x="24" y="168" fill="#6f6858" font-family="sans-serif" font-size="11">发送真实指令或上传照片将写入本地独立隔离库</text>` +
      `</svg>`,
  );

const INITIAL_DEMO_MESSAGES: CoachUiMessage[] = [
  {
    id: 'demo-u1',
    threadId: DEFAULT_COACH_THREAD_ID,
    role: 'user',
    createdAt: 1,
    isDemo: true,
    text: '帮我看下今天这张胸背计划图，另外刚才卧推第 2 组实际推了 11 次。',
    attachment: {
      id: 'att-sample-1',
      kind: 'image',
      name: '示例计划图.svg',
      dataUrl: SAMPLE_PLAN_SVG_DATA_URL,
      width: 320,
      height: 200,
      sizeBytes: 680,
    },
  },
  {
    id: 'demo-a1',
    threadId: DEFAULT_COACH_THREAD_ID,
    role: 'assistant',
    createdAt: 2,
    isDemo: true,
    text:
      '【示例引导】\n' +
      '你可以直接对我说「卧推第 2 组 60kg 做了 11 次」「把下一组目标改为 12 次」「把飞鸟和卧推配成超级组」，' +
      '或点输入框左侧「+」传照片/视频、切换模型与思考深度。每笔写库都会生成可独立撤销的操作回执卡片。',
    demoReceipt: {
      id: 'rcpt-demo-1',
      label: '示例操作回执 · 第 2 组 11 次（示例交互）',
      undone: false,
    },
  },
];

function storedToUiMessage(m: CoachStoredMessage): CoachUiMessage {
  const firstAtt = m.attachments?.[0];
  return {
    id: m.id,
    threadId: m.threadId ?? DEFAULT_COACH_THREAD_ID,
    role: m.role,
    createdAt: m.createdAt,
    text: m.text,
    reasoning: m.reasoning,
    attachment: firstAtt
      ? {
          id: firstAtt.id,
          kind: firstAtt.kind ?? 'image',
          name: firstAtt.name,
          dataUrl:
            firstAtt.kind === 'video'
              ? firstAtt.dataBase64
                ? `data:${firstAtt.mimeType};base64,${firstAtt.dataBase64}`
                : ''
              : attachmentToDataUrl(firstAtt),
          posterDataUrl: firstAtt.posterDataUrl,
          durationSec: firstAtt.durationSec,
          width: firstAtt.width,
          height: firstAtt.height,
          sizeBytes: firstAtt.sizeBytes,
          stored: firstAtt,
        }
      : undefined,
    receiptIds: m.receiptIds,
    draftPlan: m.draftPlan,
    citations: m.citations,
    thinkingFallback: m.thinkingFallback,
    compressed: m.compressed,
    isDemo: m.isDemo,
  };
}

function uiToStoredMessage(m: CoachUiMessage): CoachStoredMessage {
  return {
    id: m.id,
    threadId: m.threadId ?? DEFAULT_COACH_THREAD_ID,
    role: m.role,
    createdAt: m.createdAt,
    text: m.text,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    attachments: m.attachment?.stored ? [m.attachment.stored] : undefined,
    receiptIds: m.receiptIds,
    draftPlan: m.draftPlan,
    ...(m.citations?.length ? { citations: m.citations } : {}),
    thinkingFallback: m.thinkingFallback,
    ...(m.compressed ? { compressed: true } : {}),
    isDemo: m.isDemo,
  };
}



function formatAttachmentBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export interface ManualContextCompactionParams {
  threadId: string;
  messages: readonly CoachStoredMessage[];
  existingSummary?: string;
  providerConfig?: CoachStoredProviderConfig | null;
  keepRecent?: number;
  isStale?: () => boolean;
}

export interface ManualContextCompactionResult {
  committed: boolean;
  staleIgnored?: boolean;
  reason?: 'insufficient_messages' | 'nothing_compressed' | 'stale_state';
  summary: string;
  compressedCount: number;
  usedOnlineModel: boolean;
  compactionId?: string;
  compressedIds: string[];
  keptMessageIds: string[];
  threadsState?: CoachThreadsState;
}

const manualCompactionGenerationByThread = new Map<string, number>();

/**
 * CoachPane 手动压缩真实入口（UI 与回归共用同一实现）：
 * 1. 计算当次压缩摘要并固定保留最近 2 条未压缩原文快照（含原 ID、原角色、原顺序与脱敏正文）；
 * 2. 异步期间若同会话继续发送消息、切段、发生更新一次压缩或删除会话，安全忽略过期提交；
 * 3. 若用户仅切换至其他会话浏览，原会话的摘要、compressed 标记与 retained 尾部仍正确落库到原 threadId。
 */
export async function executeManualContextCompaction(
  params: ManualContextCompactionParams,
): Promise<ManualContextCompactionResult> {
  const targetTid = params.threadId || DEFAULT_COACH_THREAD_ID;
  const eligible = params.messages.filter(
    (m) =>
      !m.isDemo &&
      !m.compressed &&
      (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetTid,
  );
  const keep = Math.max(2, Math.min(8, params.keepRecent ?? 2));
  if (eligible.length < keep + 2) {
    return {
      committed: false,
      reason: 'insufficient_messages',
      summary: params.existingSummary ?? '',
      compressedCount: 0,
      usedOnlineModel: false,
      compressedIds: [],
      keptMessageIds: [],
    };
  }

  const nextGen = (manualCompactionGenerationByThread.get(targetTid) ?? 0) + 1;
  manualCompactionGenerationByThread.set(targetTid, nextGen);

  const [threadsBefore, vaultMsgsBefore, pendingBefore] = await Promise.all([
    loadCoachThreadsState(),
    loadCoachMessages(),
    listPendingTurns(targetTid),
  ]);
  const threadBefore = threadsBefore.threads.find((t) => t.id === targetTid);
  const segIdBefore = threadBefore?.activeSegmentId;
  const segNextSeqBefore = segIdBefore
    ? threadBefore?.segments?.[segIdBefore]?.nextSeq
    : undefined;
  const manualCompactionIdBefore = threadBefore?.manualCompaction?.compactionId;
  const startEligibleIds = new Set(eligible.map((m) => m.id));
  const vaultEligibleIdsBefore = new Set(
    vaultMsgsBefore
      .filter(
        (m) =>
          !m.isDemo &&
          !m.compressed &&
          (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetTid,
      )
      .map((m) => m.id),
  );
  const activePendingIdsBefore = new Set(
    pendingBefore
      .filter(
        (p) =>
          p.status === 'running_model' ||
          p.status === 'awaiting_tools' ||
          p.status === 'awaiting_followup_model',
      )
      .map((p) => p.turnId),
  );

  const res = await compressCoachContext({
    threadId: targetTid,
    messages: eligible,
    existingSummary: params.existingSummary ?? threadBefore?.contextSummary,
    providerConfig: params.providerConfig,
    keepRecent: keep,
  });

  if (res.compressedCount <= 0 || !res.keptMessages?.length) {
    return {
      committed: false,
      reason: 'nothing_compressed',
      summary: res.summary,
      compressedCount: 0,
      usedOnlineModel: res.usedOnlineModel,
      compressedIds: [],
      keptMessageIds: [],
    };
  }

  const checkStale = (
    latestThreads: CoachThreadsState,
    latestThreadVaultMsgs: CoachStoredMessage[],
    latestThreadPendings: CoachPendingTurn[],
  ): boolean => {
    if (manualCompactionGenerationByThread.get(targetTid) !== nextGen) return true;
    if (params.isStale?.()) return true;
    const hasNewLivePending = latestThreadPendings.some(
      (p) =>
        (p.status === 'running_model' ||
          p.status === 'awaiting_tools' ||
          p.status === 'awaiting_followup_model') &&
        !activePendingIdsBefore.has(p.turnId),
    );
    if (hasNewLivePending) return true;
    const latestThread = latestThreads.threads.find((t) => t.id === targetTid);
    if (!latestThread) return true;
    const latestSegId = latestThread.activeSegmentId;
    const latestSegNextSeq = latestSegId
      ? latestThread.segments?.[latestSegId]?.nextSeq
      : undefined;
    if (latestSegId !== segIdBefore || latestSegNextSeq !== segNextSeqBefore) {
      return true;
    }
    if (latestThread.manualCompaction?.compactionId !== manualCompactionIdBefore) {
      return true;
    }
    for (const m of latestThreadVaultMsgs) {
      if (m.isDemo) continue;
      if (!m.compressed && !startEligibleIds.has(m.id) && !vaultEligibleIdsBefore.has(m.id)) {
        return true;
      }
      if (startEligibleIds.has(m.id) && m.compressed) {
        return true;
      }
    }
    return false;
  };

  if (
    manualCompactionGenerationByThread.get(targetTid) !== nextGen ||
    params.isStale?.()
  ) {
    return {
      committed: false,
      staleIgnored: true,
      reason: 'stale_state',
      summary: params.existingSummary ?? threadBefore?.contextSummary ?? '',
      compressedCount: 0,
      usedOnlineModel: res.usedOnlineModel,
      compressedIds: [],
      keptMessageIds: [],
    };
  }

  const compressedIds = eligible.slice(0, res.compressedCount).map((m) => m.id);
  const compactionId = `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const manualCompaction: CoachManualCompactionRecord = {
    compactionId,
    summary: res.summary,
    summaryHash: hashTextCompact(res.summary),
    keptMessages: res.keptMessages,
    createdAt: Date.now(),
  };

  const commitRes = await commitManualCompactionInVault({
    threadId: targetTid,
    compressedIds,
    compressedCount: res.compressedCount,
    summary: res.summary,
    manualCompaction,
    snapshotMessages: eligible,
    isStale: checkStale,
  });

  if (!commitRes.committed) {
    return {
      committed: false,
      staleIgnored: true,
      reason: 'stale_state',
      summary: params.existingSummary ?? threadBefore?.contextSummary ?? '',
      compressedCount: 0,
      usedOnlineModel: res.usedOnlineModel,
      compressedIds: [],
      keptMessageIds: [],
      threadsState: commitRes.threadsState,
    };
  }

  return {
    committed: true,
    summary: res.summary,
    compressedCount: res.compressedCount,
    usedOnlineModel: res.usedOnlineModel,
    compactionId,
    compressedIds,
    keptMessageIds: res.keptMessages.map((m) => m.id),
    threadsState: commitRes.threadsState,
  };
}

export const COACH_DRAFT_SELECTION_ID = '__coach_local_draft__';

/**
 * 合并引擎或持久化层的最新线程字段到当前 UI 线程状态：
 * · 仅当 allowAdoptVaultActive=true 时才采用 Vault 的 activeThreadId（防止晚到异步回调覆盖用户切换或临时草稿）；
 * · 不吞掉 UI 中新建但尚未在旧快照中出现的正式线程，也不复活已删除线程；
 * · 自动同步最新引擎字段（activeSegmentId / segments / billingTotals / manualCompaction / contextSummary / compressedCount）。
 */
export function mergeVaultThreadsIntoUiState(
  prev: CoachThreadsState,
  incoming: CoachThreadsState,
  opts?: {
    deletedThreadIds?: ReadonlySet<string>;
    allowAdoptVaultActive?: boolean;
    preferIncomingUiForThreadId?: string;
  },
): CoachThreadsState {
  const deleted = opts?.deletedThreadIds;
  const incomingById = new Map(
    incoming.threads
      .filter((t) => !deleted?.has(t.id))
      .map((t) => [t.id, t]),
  );
  const seen = new Set<string>();
  const mergedThreads: CoachThreadMeta[] = [];

  for (const cur of prev.threads) {
    if (deleted?.has(cur.id)) continue;
    seen.add(cur.id);
    const fresh = incomingById.get(cur.id);
    if (!fresh) {
      mergedThreads.push(cur);
      continue;
    }
    const useIncomingUi = opts?.preferIncomingUiForThreadId === cur.id;
    mergedThreads.push({
      ...cur,
      ...(fresh.activeSegmentId !== undefined ? { activeSegmentId: fresh.activeSegmentId } : {}),
      ...(fresh.segments !== undefined ? { segments: fresh.segments } : {}),
      ...(fresh.billingTotals !== undefined ? { billingTotals: fresh.billingTotals } : {}),
      ...(fresh.manualCompaction !== undefined ? { manualCompaction: fresh.manualCompaction } : {}),
      ...(fresh.contextSummary !== undefined ? { contextSummary: fresh.contextSummary } : {}),
      ...(fresh.compressedCount !== undefined ? { compressedCount: fresh.compressedCount } : {}),
      ...(useIncomingUi
        ? {
            title: fresh.title,
            ...(fresh.titleSource !== undefined ? { titleSource: fresh.titleSource } : {}),
            updatedAt: fresh.updatedAt,
            ...('lastUsage' in fresh ? { lastUsage: fresh.lastUsage } : {}),
          }
        : {
            updatedAt: Math.max(cur.updatedAt, fresh.updatedAt),
            ...(fresh.lastUsage && (!cur.lastUsage || fresh.lastUsage.updatedAt >= cur.lastUsage.updatedAt)
              ? { lastUsage: fresh.lastUsage }
              : {}),
          }),
    });
  }

  for (const fresh of incoming.threads) {
    if (deleted?.has(fresh.id) || seen.has(fresh.id)) continue;
    seen.add(fresh.id);
    mergedThreads.push(fresh);
  }

  const fallbackActive = mergedThreads[0]?.id ?? prev.activeThreadId;
  const nextActive = opts?.allowAdoptVaultActive
    ? seen.has(incoming.activeThreadId)
      ? incoming.activeThreadId
      : fallbackActive
    : seen.has(prev.activeThreadId)
      ? prev.activeThreadId
      : fallbackActive;

  return {
    activeThreadId: nextActive,
    threads: mergedThreads,
  };
}

/**
 * 专门处理 reconcileStaleBillingTotalsInVault 的晚到异步回调：
 * 只把最新重算后的 billingTotals 合并到既有匹配线程上，不吞掉后来新建的正式线程，
 * 也不改动当前 activeThreadId 或临时草稿选中态。
 */
export function mergeReconciledBillingTotalsIntoThreadsState(
  prev: CoachThreadsState,
  reconciledState: CoachThreadsState,
): { next: CoachThreadsState; changed: boolean } {
  const reconciledById = new Map(
    reconciledState.threads.map((t) => [t.id, t.billingTotals]),
  );
  let changed = false;
  const mergedThreads = prev.threads.map((t) => {
    const nextBilling = reconciledById.get(t.id);
    if (
      nextBilling &&
      (!t.billingTotals || t.billingTotals.summarySchemaVersion !== 2) &&
      nextBilling !== t.billingTotals
    ) {
      changed = true;
      return { ...t, billingTotals: nextBilling };
    }
    return t;
  });
  if (!changed) return { next: prev, changed: false };
  return {
    changed: true,
    next: { ...prev, threads: mergedThreads },
  };
}

/**
 * 草稿首发创建事务完成时的晚到竞态收口：
 * · 始终将已落盘的新正式会话合并入列表，不吞并发线程或覆盖更晚选择；
 * · 仅当仍在同一次发起序号且当前仍处于该草稿选择态时才退出草稿并选中新会话。
 */
export function resolveDraftFirstSendOutcome(params: {
  prevUiState: CoachThreadsState;
  createdState: CoachThreadsState;
  deletedThreadIds?: ReadonlySet<string>;
  sendOpSeq: number;
  currentOpSeq: number;
  currentIsDraftActive: boolean;
  currentSelectedKey: string;
  draftSelectionKey?: string;
}): {
  adoptCreatedThread: boolean;
  nextThreadsState: CoachThreadsState;
} {
  const expectedDraftKey = params.draftSelectionKey ?? COACH_DRAFT_SELECTION_ID;
  const adoptCreatedThread =
    params.sendOpSeq === params.currentOpSeq &&
    params.currentIsDraftActive &&
    params.currentSelectedKey === expectedDraftKey;
  const nextThreadsState = mergeVaultThreadsIntoUiState(
    params.prevUiState,
    params.createdState,
    {
      deletedThreadIds: params.deletedThreadIds,
      allowAdoptVaultActive: adoptCreatedThread,
    },
  );
  return { adoptCreatedThread, nextThreadsState };
}

/**
 * 发送初始化 await 结束后仅当草稿未被用户改写时才清理对应文本。
 */
export function clearDraftTextIfUnchanged(
  prev: Record<string, string>,
  key: string,
  expectedRawDraft: string,
): Record<string, string> {
  if ((prev[key] ?? '') !== expectedRawDraft) return prev;
  if ((prev[key] ?? '') === '') return prev;
  return { ...prev, [key]: '' };
}

/**
 * 发送初始化 await 结束后仅当待发附件仍为发起同一对象时才清理，保留等待期间新增/替换的附件。
 */
export function clearDraftAttachmentIfUnchanged(
  prev: Record<string, UiPreviewAttachment>,
  key: string,
  expectedAttachment: UiPreviewAttachment | null,
): Record<string, UiPreviewAttachment> {
  const currentAtt = prev[key] ?? null;
  if (!currentAtt || !expectedAttachment) return prev;
  const sameAttachment =
    currentAtt === expectedAttachment ||
    currentAtt.id === expectedAttachment.id;
  if (!sameAttachment) return prev;
  const next = { ...prev };
  delete next[key];
  return next;
}

export function resolveThreadBoundRecoveryUi(params: {
  activeThreadId: string;
  pendingRecoveryTurn: CoachPendingTurn | null;
  pendingRecoveryState: CoachThreadPendingState | null;
}): {
  visibleRecoveryTurn: CoachPendingTurn | null;
  visibleRecoveryState: CoachThreadPendingState | null;
  canResume: boolean;
  canAbandon: boolean;
} {
  const turn =
    params.pendingRecoveryTurn && params.pendingRecoveryTurn.threadId === params.activeThreadId
      ? params.pendingRecoveryTurn
      : null;
  const state =
    params.pendingRecoveryState && params.pendingRecoveryState.threadId === params.activeThreadId
      ? params.pendingRecoveryState
      : null;
  const canResume = Boolean(turn);
  const canAbandon = Boolean(turn || state?.hasUnclosedToolBatch);
  return {
    visibleRecoveryTurn: turn,
    visibleRecoveryState: state,
    canResume,
    canAbandon,
  };
}

export function CoachPane() {
  const dual = useDualWindow();
  const {
    activeSession,
    plans,
    exerciseTemplates,
    historyHydrated,
    ensureFullHistory,
    syncSessionLocal,
    refreshSessions,
    refreshPlans,
    refreshExerciseTemplates,
    pushToast,
  } = useStore();

  const [messages, setMessages] = useState<CoachUiMessage[]>(INITIAL_DEMO_MESSAGES);
  const [threadsState, setThreadsState] = useState<CoachThreadsState>(() =>
    createDefaultCoachThreadsState(),
  );
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [windowActionsOpen, setWindowActionsOpen] = useState(false);
  const [compressingContext, setCompressingContext] = useState(false);

  const [receiptsById, setReceiptsById] = useState<Record<string, CoachOperationReceipt>>({});
  const [receiptErrors, setReceiptErrors] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, UiPreviewAttachment>>({});
  const [streamThreadId, setStreamThreadId] = useState<string | null>(null);
  const [showExample, setShowExample] = useState(false);
  const [threadMenu, setThreadMenu] = useState<string | null>(null);
  const [threadDialog, setThreadDialog] = useState<{ id: string; action: 'rename' | 'delete' } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [threadError, setThreadError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [confirmingDrafts, setConfirmingDrafts] = useState<string[]>([]);
  const confirmingDraftsRef = useRef(new Set<string>());
  const deletedThreads = useRef(new Set<string>());
  const threadScroll = useRef(new Map<string, number>());
  const pickingThread = useRef<string | null>(null);
  const threadsRef = useRef(threadsState);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const threadSendNonceRef = useRef(new Map<string, number>());
  const streamThreadIdRef = useRef<string | null>(null);
  streamThreadIdRef.current = streamThreadId;
  const [previewAttachment, setPreviewAttachment] = useState<UiPreviewAttachment | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusSubPanel, setPlusSubPanel] = useState<'none' | 'thinking' | 'model'>('none');

  const [providerKind, setProviderKind] = useState<CoachProviderKind>('openai-compatible');
  const [providerPresetId, setProviderPresetId] = useState<string | undefined>(undefined);
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [capabilitiesByModel, setCapabilitiesByModel] =
    useState<NonNullable<CoachStoredProviderConfig['capabilitiesByModel']>>({});
  const [contextWindowByModel, setContextWindowByModel] = useState<Record<string, number>>({});
  const [webSearchProvider, setWebSearchProvider] = useState<CoachWebSearchProvider>('builtin');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [memoryStore, setMemoryStore] = useState<CoachMemoryStore>(() => createEmptyCoachMemory());
  const [providerApiKey, setProviderApiKey] = useState('');
  const [savedConfig, setSavedConfig] = useState<CoachStoredProviderConfig | null>(null);
  const [pendingRecoveryTurn, setPendingRecoveryTurn] = useState<CoachPendingTurn | null>(null);
  const [pendingRecoveryState, setPendingRecoveryState] = useState<CoachThreadPendingState | null>(null);
  const [resumingPendingTurn, setResumingPendingTurn] = useState(false);
  const [abandoningPendingTurn, setAbandoningPendingTurn] = useState(false);
  const sendingGuardRef = useRef(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStreamMsgIdRef = useRef<string | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const [popoverBottomPx, setPopoverBottomPx] = useState<number | null>(null);
  const ctxPopoverRef = useRef<HTMLDivElement | null>(null);
  const ctxPillRef = useRef<HTMLButtonElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);
  const modelPanelRef = useRef<HTMLDivElement | null>(null);
  const modelPillRef = useRef<HTMLButtonElement | null>(null);
  const miniPanelRef = useRef<HTMLDivElement | null>(null);
  const previewLayerId = useId();
  const menuLayerId = useId();

  const [isDraftActive, setIsDraftActive] = useState(false);
  const isDraftActiveRef = useRef(isDraftActive);
  isDraftActiveRef.current = isDraftActive;
  const userSelectedThreadRef = useRef(false);
  const threadsUiOpSeqRef = useRef(0);

  const isPrimary = dual.primaryPane === 'coach';
  const activeThreadId = threadsState.activeThreadId;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const selectedThreadKey = isDraftActive ? COACH_DRAFT_SELECTION_ID : activeThreadId;
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  selectedThreadKeyRef.current = selectedThreadKey;
  const { visibleRecoveryTurn, visibleRecoveryState } = resolveThreadBoundRecoveryUi({
    activeThreadId: selectedThreadKey,
    pendingRecoveryTurn,
    pendingRecoveryState,
  });
  const draft = drafts[selectedThreadKey] ?? '';
  const pendingAttachment = attachments[selectedThreadKey] ?? null;
  const isStreaming = !isDraftActive && streamThreadId === activeThreadId;
  const selectedModelKey = savedConfig ? coachModelKey(savedConfig) : '';
  const online = Boolean(savedConfig?.apiKey && savedConfig.baseUrl && savedConfig.model);
  const levels = online && savedConfig
    ? savedConfig.capabilitiesByModel?.[selectedModelKey] ?? coachThinkingLevels(savedConfig)
    : [];
  const storedDepth = savedConfig?.thinkingByModel?.[selectedModelKey] ?? 'default';
  const thinkingDepth = levels.includes(storedDepth) ? storedDepth : 'default';
  const setDraft = (text: string) => {
    const targetKey = isDraftActiveRef.current ? COACH_DRAFT_SELECTION_ID : activeThreadIdRef.current;
    setDrafts((prev) => ({ ...prev, [targetKey]: text }));
  };
  const setAttachmentFor = (id: string, attachment: UiPreviewAttachment | null) => {
    if (deletedThreads.current.has(id)) return;
    setAttachments((prev) => {
      const next = { ...prev };
      if (attachment) next[id] = attachment;
      else delete next[id];
      return next;
    });
  };
  const setPendingAttachment = (attachment: UiPreviewAttachment | null) => {
    const targetKey = isDraftActiveRef.current ? COACH_DRAFT_SELECTION_ID : activeThreadIdRef.current;
    setAttachmentFor(targetKey, attachment);
  };
  useLayoutEffect(() => {
    const scroller = dual.coachScrollRef.current;
    if (scroller) scroller.scrollTop = threadScroll.current.get(selectedThreadKey) ?? scroller.scrollHeight;
  }, [selectedThreadKey, dual.coachScrollRef]);
  const activeThread = useMemo(
    () =>
      isDraftActive
        ? undefined
        : threadsState.threads.find((t) => t.id === activeThreadId) ?? threadsState.threads[0],
    [threadsState, activeThreadId, isDraftActive],
  );
  const visibleMessages = useMemo(
    () =>
      isDraftActive
        ? []
        : messages.filter(
            (m) => (m.threadId ?? DEFAULT_COACH_THREAD_ID) === activeThreadId,
          ),
    [messages, activeThreadId, isDraftActive],
  );
  const compressibleCount = useMemo(
    () =>
      visibleMessages.filter((m) => !m.isDemo && !m.streaming && !m.compressed).length,
    [visibleMessages],
  );
  const activeSegmentMeta = activeThread?.activeSegmentId
    ? activeThread.segments?.[activeThread.activeSegmentId]
    : undefined;
  const hasSessionSwitchHint = Boolean(
    !isStreaming &&
    activeSession?.id &&
    activeSegmentMeta?.lastSyncedSessionId &&
    activeSegmentMeta.lastSyncedSessionId !== activeSession.id &&
    visibleMessages.some((m) => !m.isDemo),
  );

  const txHooks: CoachTxHooks = useMemo(
    () => ({
      onSessionCommitted: (committed) => {
        syncSessionLocal(committed);
        void refreshSessions();
      },
      onPlanCommitted: () => {
        void refreshPlans();
        void listPendingTurns().then((turns) => {
          for (const t of turns) {
            if (t.status === 'awaiting_confirmation') {
              void deletePendingTurnStrict(t.turnId);
            }
          }
          setPendingRecoveryTurn((cur) =>
            cur?.status === 'awaiting_confirmation' ? null : cur,
          );
          setPendingRecoveryState((cur) =>
            cur?.pendingTurn?.status === 'awaiting_confirmation' && !cur.hasUnclosedToolBatch
              ? { ...cur, pendingTurn: null }
              : cur,
          );
        });
      },
      onPlanDeleted: () => {
        void refreshPlans();
      },
      onTemplatesChanged: () => {
        void refreshExerciseTemplates();
      },
      onMemoryChanged: (nextMemory) => {
        setMemoryStore(nextMemory);
      },
      onReceiptSaved: (r) => {
        setReceiptsById((prev) => ({ ...prev, [r.id]: r }));
      },
    }),
    [syncSessionLocal, refreshSessions, refreshPlans, refreshExerciseTemplates],
  );

  // 初始化读取独立隔离库 motion-coach-vault（与主库及 Backup v4 完全隔离）
  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadCoachMessages(),
      listCoachReceipts(),
      loadCoachProviderConfig(),
      loadCoachThreadsState(),
      loadCoachMemory(),
    ]).then(([storedMsgs, storedReceipts, storedCfg, storedThreads, storedMemory]) => {
      if (!alive) return;
      setMemoryStore(storedMemory);
      if (storedReceipts.length) {
        setReceiptsById((prev) => {
          const next = { ...prev };
          for (const r of storedReceipts) next[r.id] = r;
          return next;
        });
      }
      if (storedCfg) {
        const depth = storedCfg.thinkingDepth;
        const migrated = isOfficialDeepSeek(storedCfg) && depth === 'medium' ? 'high' : depth;
        setSavedConfig({
          ...storedCfg,
          thinkingByModel: storedCfg.thinkingByModel ?? (migrated ? { [coachModelKey(storedCfg)]: migrated } : {}),
        });
        setCapabilitiesByModel(storedCfg.capabilitiesByModel ?? {});
        setContextWindowByModel(storedCfg.contextWindowByModel ?? {});
        setWebSearchProvider(normalizeWebSearchProvider(storedCfg.webSearchProvider));
        setWebSearchApiKey(storedCfg.webSearchApiKey ?? '');
        setProviderKind(storedCfg.kind);
        setProviderPresetId(storedCfg.presetId);
        setProviderBaseUrl(storedCfg.baseUrl);
        setProviderModel(storedCfg.model);
        const list = Array.isArray(storedCfg.models)
          ? storedCfg.models
          : storedCfg.model
            ? [storedCfg.model]
            : [];
        setProviderModels(list);
        setProviderApiKey(storedCfg.apiKey);
      }
      const existingThreadIds = new Set(storedThreads.threads.map((t) => t.id));
      const extraThreads: CoachThreadMeta[] = [];
      for (const sm of storedMsgs) {
        const tid = sm.threadId ?? DEFAULT_COACH_THREAD_ID;
        if (!existingThreadIds.has(tid)) {
          existingThreadIds.add(tid);
          extraThreads.push({
            id: tid,
            title: '历史对话',
            createdAt: sm.createdAt,
            updatedAt: sm.createdAt,
          });
        }
      }
      const incomingThreads = extraThreads.length
        ? { ...storedThreads, threads: [...storedThreads.threads, ...extraThreads] }
        : storedThreads;
      setThreadsState((prev) => {
        const merged = mergeVaultThreadsIntoUiState(prev, incomingThreads, {
          deletedThreadIds: deletedThreads.current,
          allowAdoptVaultActive: !userSelectedThreadRef.current && !isDraftActiveRef.current,
        });
        threadsRef.current = merged;
        return merged;
      });
      if (incomingThreads.threads.some((t) => t.billingTotals && t.billingTotals.summarySchemaVersion !== 2)) {
        void reconcileStaleBillingTotalsInVault().then(({ changed, state }) => {
          if (!alive || !changed) return;
          setThreadsState((prev) => {
            const mergedRes = mergeReconciledBillingTotalsIntoThreadsState(prev, state);
            if (!mergedRes.changed) return prev;
            threadsRef.current = mergedRes.next;
            return mergedRes.next;
          });
        });
      }
      if (storedMsgs.length) {
        setMessages((prev) => {
          const merged = [...INITIAL_DEMO_MESSAGES];
          const existingIds = new Set(merged.map((m) => m.id));
          for (const sm of storedMsgs) {
            if (!existingIds.has(sm.id)) {
              existingIds.add(sm.id);
              merged.push(storedToUiMessage(sm));
            }
          }
          for (const cur of prev) {
            if (!existingIds.has(cur.id)) {
              existingIds.add(cur.id);
              merged.push(cur);
            }
          }
          return merged;
        });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPendingRecoveryState(null);
    setPendingRecoveryTurn(null);
    if (isDraftActive || streamThreadId === activeThreadId) {
      return undefined;
    }
    const targetTid = activeThreadId;
    void inspectCoachThreadPendingState(targetTid).then((state) => {
      if (
        cancelled ||
        isDraftActiveRef.current ||
        activeThreadIdRef.current !== targetTid ||
        state.threadId !== targetTid
      ) {
        return;
      }
      setPendingRecoveryState(state);
      setPendingRecoveryTurn(state.pendingTurn);
    });
    return () => {
      cancelled = true;
    };
  }, [activeThreadId, isDraftActive, streamThreadId]);

  const persistMessagesSnapshot = useCallback((list: CoachUiMessage[], onlyThreadId?: string) => {
    const persistable = list
      .filter((m) => {
        if (m.isDemo || m.streaming) return false;
        const tid = m.threadId ?? DEFAULT_COACH_THREAD_ID;
        if (deletedThreads.current.has(tid)) return false;
        if (onlyThreadId && tid !== onlyThreadId) return false;
        return true;
      })
      .map(uiToStoredMessage);
    if (!persistable.length) return;
    void upsertCoachMessages(persistable).then(() =>
      // 删除记忆发生在本轮气泡落库之前时，保存后立即在既有净化投影上继续脱敏，保证冷启动摘要仍覆盖
      refreshOutboundRedactionForMessages(persistable),
    );
  }, []);

  // 返回键第 1 层：图片/视频预览弹层优先于二级菜单、收键盘与退窗
  useEffect(() => {
    if (!previewAttachment) return undefined;
    return backStack.push({
      id: `coach-preview:${previewLayerId}`,
      handle: () => {
        setPreviewAttachment(null);
        return true;
      },
    });
  }, [previewAttachment, previewLayerId]);

  useEffect(() => {
    if (!plusMenuOpen && plusSubPanel === 'none' && !threadsOpen && !settingsOpen && !memoryOpen && !contextPopoverOpen && !windowActionsOpen) return undefined;
    return backStack.push({
      id: `coach-popover:${menuLayerId}`,
      handle: () => {
        if (contextPopoverOpen) {
          setContextPopoverOpen(false);
          return true;
        }
        if (plusMenuOpen || plusSubPanel !== 'none') {
          setPlusMenuOpen(false);
          setPlusSubPanel('none');
          return true;
        }
        if (windowActionsOpen) {
          setWindowActionsOpen(false);
          return true;
        }
        if (threadDialog) {
          if (!deleting) setThreadDialog(null);
          return true;
        }
        if (threadMenu) {
          setThreadMenu(null);
          return true;
        }
        if (memoryOpen) {
          setMemoryOpen(false);
          return true;
        }
        if (threadsOpen) {
          setThreadsOpen(false);
          return true;
        }
        if (settingsOpen) {
          setSettingsOpen(false);
          return true;
        }
        return false;
      },
    });
  }, [plusMenuOpen, plusSubPanel, threadsOpen, settingsOpen, memoryOpen, contextPopoverOpen, menuLayerId, threadDialog, threadMenu, deleting, windowActionsOpen]);

  // 点击弹层外空白区域或按 Escape 时自动收回（模型/档位、上下文、+菜单、会话操作及小窗内面板）
  useEffect(() => {
    const hasMiniPanelOpen = !isPrimary && (threadsOpen || settingsOpen || memoryOpen);
    if (!contextPopoverOpen && !plusMenuOpen && plusSubPanel === 'none' && threadMenu === null && !windowActionsOpen && !hasMiniPanelOpen) {
      return undefined;
    }
    const isInside = (target: Node, el: Element | null) => Boolean(el && el.contains(target));
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (contextPopoverOpen && !isInside(target, ctxPopoverRef.current) && !isInside(target, ctxPillRef.current)) {
        setContextPopoverOpen(false);
      }
      if (plusMenuOpen && !isInside(target, plusMenuRef.current) && !isInside(target, plusBtnRef.current)) {
        setPlusMenuOpen(false);
      }
      if (plusSubPanel !== 'none' && !isInside(target, modelPanelRef.current) && !isInside(target, modelPillRef.current)) {
        setPlusSubPanel('none');
      }
      if (threadMenu !== null && !(target instanceof Element && target.closest('.coach-thread-menu'))) {
        setThreadMenu(null);
      }
      if (
        hasMiniPanelOpen &&
        !isInside(target, miniPanelRef.current) &&
        !(target instanceof Element && target.closest('.coach-mini-banner, .coach-modal-backdrop'))
      ) {
        setThreadsOpen(false);
        setSettingsOpen(false);
        setMemoryOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setContextPopoverOpen(false);
      setPlusMenuOpen(false);
      setPlusSubPanel('none');
      setThreadMenu(null);
      setWindowActionsOpen(false);
      if (hasMiniPanelOpen) {
        setThreadsOpen(false);
        setSettingsOpen(false);
        setMemoryOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [contextPopoverOpen, plusMenuOpen, plusSubPanel, threadMenu, windowActionsOpen, isPrimary, threadsOpen, settingsOpen, memoryOpen]);

  useLayoutEffect(() => {
    if (!isPrimary || (!contextPopoverOpen && !plusMenuOpen && plusSubPanel === 'none')) {
      return undefined;
    }
    const updateAnchor = () => {
      const rect = composerRef.current?.getBoundingClientRect();
      if (rect && rect.top > 0 && typeof window !== 'undefined' && window.innerHeight > 0) {
        setPopoverBottomPx(Math.max(48, Math.round(window.innerHeight - rect.top + 6)));
      }
    };
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [isPrimary, contextPopoverOpen, plusMenuOpen, plusSubPanel, pendingAttachment, draft]);

  useEffect(() => {
    if (dual.coachVisibility === 'closed' || dual.coachVisibility === 'minimized') {
      setPreviewAttachment(null);
      setPlusMenuOpen(false);
      setPlusSubPanel('none');
      setThreadsOpen(false);
      setMemoryOpen(false);
      setContextPopoverOpen(false);
      setThreadDialog(null);
      setThreadMenu(null);
      setWindowActionsOpen(false);
    }
  }, [dual.coachVisibility]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);

  const cancelStreaming = () => abortControllerRef.current?.abort();

  const refreshThreadsFromVault = () => {
    void loadCoachThreadsState().then((fresh) => {
      setThreadsState((prev) => {
        const merged = mergeVaultThreadsIntoUiState(prev, fresh, {
          deletedThreadIds: deletedThreads.current,
          allowAdoptVaultActive: false,
        });
        threadsRef.current = merged;
        return merged;
      });
    });
  };

  const editThread = (id: string, update: (thread: CoachThreadMeta) => CoachThreadMeta) => {
    if (deletedThreads.current.has(id)) return;
    setThreadsState((prev) => {
      if (!prev.threads.some((t) => t.id === id)) return prev;
      const next: CoachThreadsState = {
        ...prev,
        threads: prev.threads.map((t) => {
          if (t.id !== id) return t;
          const updated = update(t);
          return {
            ...t,
            title: updated.title,
            ...(updated.titleSource !== undefined ? { titleSource: updated.titleSource } : {}),
            updatedAt: updated.updatedAt,
            ...('lastUsage' in updated ? { lastUsage: updated.lastUsage } : {}),
            ...('contextSummary' in updated ? { contextSummary: updated.contextSummary } : {}),
            ...('compressedCount' in updated ? { compressedCount: updated.compressedCount } : {}),
          };
        }),
      };
      threadsRef.current = next;
      return next;
    });
    void patchCoachThreadUiFields(id, (latestThread) => {
      const updated = update(latestThread);
      if (updated === latestThread) return null;
      return {
        ...(updated.title !== latestThread.title ? { title: updated.title } : {}),
        ...(updated.titleSource !== latestThread.titleSource
          ? { titleSource: updated.titleSource }
          : {}),
        ...(updated.updatedAt !== latestThread.updatedAt ? { updatedAt: updated.updatedAt } : {}),
        ...(updated.lastUsage !== latestThread.lastUsage ? { lastUsage: updated.lastUsage } : {}),
        ...(updated.contextSummary !== latestThread.contextSummary
          ? { contextSummary: updated.contextSummary }
          : {}),
        ...(updated.compressedCount !== latestThread.compressedCount
          ? { compressedCount: updated.compressedCount }
          : {}),
      };
    }).then((merged) => {
      if (deletedThreads.current.has(id)) return;
      setThreadsState((prev) => {
        const synced = mergeVaultThreadsIntoUiState(prev, merged, {
          deletedThreadIds: deletedThreads.current,
          allowAdoptVaultActive: false,
          preferIncomingUiForThreadId: id,
        });
        threadsRef.current = synced;
        return synced;
      });
    });
  };

  const rememberScroll = () => {
    threadScroll.current.set(selectedThreadKeyRef.current, dual.coachScrollRef.current?.scrollTop ?? 0);
    setPreviewAttachment(null);
    setIsComposing(false);
  };

  const handleNewThread = () => {
    userSelectedThreadRef.current = true;
    threadsUiOpSeqRef.current += 1;
    rememberScroll();
    isDraftActiveRef.current = true;
    setIsDraftActive(true);
    setPendingRecoveryState(null);
    setPendingRecoveryTurn(null);
    setThreadsOpen(false);
    setPlusMenuOpen(false);
    setPlusSubPanel('none');
    setThreadMenu(null);
    setShowExample(false);
  };

  const handleSwitchThread = (threadId: string) => {
    userSelectedThreadRef.current = true;
    const opSeq = ++threadsUiOpSeqRef.current;
    const wasDraft = isDraftActiveRef.current;
    if (wasDraft || threadId !== activeThreadId) {
      rememberScroll();
      isDraftActiveRef.current = false;
      setIsDraftActive(false);
      setThreadsState((prev) => {
        const next = { ...prev, activeThreadId: threadId };
        threadsRef.current = next;
        return next;
      });
      void switchActiveCoachThreadInVault(threadId).then((fresh) => {
        setThreadsState((prev) => {
          const synced = mergeVaultThreadsIntoUiState(prev, fresh, {
            deletedThreadIds: deletedThreads.current,
            allowAdoptVaultActive:
              opSeq === threadsUiOpSeqRef.current && !isDraftActiveRef.current,
          });
          threadsRef.current = synced;
          return synced;
        });
      });
      setShowExample(false);
      setPlusMenuOpen(false);
      setPlusSubPanel('none');
    }
    setThreadMenu(null);
    setThreadsOpen(false);
  };

  const handleDeleteThread = async (threadId: string) => {
    if (deleting) return;
    setDeleting(true);
    setThreadError('');
    userSelectedThreadRef.current = true;
    const opSeq = ++threadsUiOpSeqRef.current;
    const current = threadsRef.current;
    const remaining = current.threads.filter((thread) => thread.id !== threadId);
    const defaultResetState = createDefaultCoachThreadsState();
    const nextState: CoachThreadsState = remaining.length
      ? {
          activeThreadId:
            current.activeThreadId === threadId ? remaining[0].id : current.activeThreadId,
          threads: remaining,
        }
      : defaultResetState;
    if (streamThreadId === threadId) cancelStreaming();
    try {
      await deleteCoachThread(threadId, nextState);
      setAttachmentFor(threadId, null);
      deletedThreads.current.add(threadId);
      setThreadsState((prev) => {
        const surviving = prev.threads.filter((thread) => thread.id !== threadId);
        const uiNext = surviving.length
          ? {
              activeThreadId:
                prev.activeThreadId === threadId ? surviving[0].id : prev.activeThreadId,
              threads: surviving,
            }
          : defaultResetState;
        threadsRef.current = uiNext;
        return uiNext;
      });
      if (!remaining.length) {
        void switchActiveCoachThreadInVault(defaultResetState.activeThreadId).then((fresh) => {
          if (opSeq !== threadsUiOpSeqRef.current) return;
          setThreadsState((prev) => {
            const synced = mergeVaultThreadsIntoUiState(prev, fresh, {
              deletedThreadIds: deletedThreads.current,
              allowAdoptVaultActive: !isDraftActiveRef.current,
            });
            threadsRef.current = synced;
            return synced;
          });
        });
      }
      setMessages((prev) =>
        prev.filter((message) => (message.threadId ?? DEFAULT_COACH_THREAD_ID) !== threadId),
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
      threadScroll.current.delete(threadId);
      setThreadDialog(null);
    } catch {
      setThreadError('删除失败，请重试。');
    } finally {
      setDeleting(false);
    }
  };

  const handleCompressContext = async () => {
    if (compressingContext || isStreaming) return;
    if (compressibleCount < 4) {
      pushToast('当前对话未压缩消息不足 4 条，无需压缩', 'info');
      return;
    }
    setCompressingContext(true);
    try {
      const targetTid = activeThreadId;
      const sendNonceAtStart = threadSendNonceRef.current.get(targetTid) ?? 0;
      const eligible = messages.filter(
        (m) =>
          !m.isDemo &&
          !m.streaming &&
          !m.compressed &&
          (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetTid,
      );
      const startEligibleIds = new Set(eligible.map((m) => m.id));
      const res = await executeManualContextCompaction({
        threadId: targetTid,
        messages: eligible.map(uiToStoredMessage),
        existingSummary: activeThread?.contextSummary,
        providerConfig: savedConfig,
        isStale: () => {
          if (deletedThreads.current.has(targetTid)) return true;
          if ((threadSendNonceRef.current.get(targetTid) ?? 0) !== sendNonceAtStart) return true;
          if (activeStreamMsgIdRef.current !== null && streamThreadIdRef.current === targetTid) return true;
          const liveEligible = messagesRef.current.filter(
            (m) =>
              !m.isDemo &&
              !m.compressed &&
              (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetTid,
          );
          if (liveEligible.some((m) => m.streaming || !startEligibleIds.has(m.id))) return true;
          return false;
        },
      });
      if (deletedThreads.current.has(targetTid)) return;
      if (res.staleIgnored) {
        if (activeThreadIdRef.current === targetTid) {
          pushToast('压缩期间有新消息或状态更新，本次压缩结果已安全忽略', 'info');
        }
        return;
      }
      if (!res.committed || res.compressedCount <= 0) {
        pushToast('暂无可压缩的早期上下文', 'info');
        return;
      }
      const compressedIds = new Set(res.compressedIds);
      setMessages((prev) =>
        prev.map((m) => (compressedIds.has(m.id) ? { ...m, compressed: true } : m)),
      );
      if (res.threadsState) {
        setThreadsState((prev) => {
          const merged = {
            ...res.threadsState!,
            activeThreadId: prev.activeThreadId,
          };
          threadsRef.current = merged;
          return merged;
        });
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '上下文压缩失败', 'error');
    } finally {
      setCompressingContext(false);
    }
  };

  const handleResumePendingTurn = async () => {
    if (isDraftActiveRef.current) return;
    const targetThreadId = activeThreadId;
    const targetPending = visibleRecoveryTurn;
    if (
      !targetPending ||
      targetPending.threadId !== targetThreadId ||
      activeThreadIdRef.current !== targetThreadId ||
      resumingPendingTurn ||
      abandoningPendingTurn ||
      abortControllerRef.current
    ) {
      return;
    }
    setResumingPendingTurn(true);
    try {
      const cfgSnap = savedConfig;
      const res = await resumePendingCoachTurn({
        threadId: targetThreadId,
        pendingTurn: targetPending,
        providerConfig: cfgSnap,
        thinkingDepth,
        toolContext: {
          activeSession,
          plans,
          exerciseTemplates,
          historyHydrated,
          ensureFullHistory,
          activeThreadId: targetThreadId,
          hooks: txHooks,
        },
        onReceipt: (receipt) => {
          setReceiptsById((prev) => ({ ...prev, [receipt.id]: receipt }));
        },
        onBillingRecord: () => {
          refreshThreadsFromVault();
        },
      });
      refreshThreadsFromVault();
      if (res.receipts.length) {
        setReceiptsById((prev) => {
          const next = { ...prev };
          for (const r of res.receipts) next[r.id] = r;
          return next;
        });
      }
      if (!isDraftActiveRef.current && activeThreadIdRef.current === targetThreadId) {
        const nextState = await inspectCoachThreadPendingState(targetThreadId);
        if (
          !isDraftActiveRef.current &&
          activeThreadIdRef.current === targetThreadId &&
          nextState.threadId === targetThreadId
        ) {
          setPendingRecoveryState(nextState);
          if ((res.resumed && !res.needsConfirmationStream) || res.expiredByRestore) {
            setPendingRecoveryTurn(nextState.pendingTurn);
          } else {
            setPendingRecoveryTurn(nextState.pendingTurn ?? targetPending);
          }
        }
      }
      const msgText = res.text.trim();
      if (
        !res.threadMismatch &&
        !res.staleOrMissingPending &&
        (msgText || res.receipts.length || res.draftPlan)
      ) {
        const recoveredMsg: CoachUiMessage = {
          id: `a-rec-${Date.now().toString(36)}`,
          threadId: targetPending.threadId,
          role: 'assistant',
          createdAt: Date.now(),
          text: msgText,
          ...(res.reasoning ? { reasoning: res.reasoning } : {}),
          ...(res.receipts.length ? { receiptIds: res.receipts.map((r) => r.id) } : {}),
          ...(res.draftPlan ? { draftPlan: res.draftPlan } : {}),
        };
        setMessages((prev) => {
          const next = [...prev, recoveredMsg];
          persistMessagesSnapshot(next, targetPending.threadId);
          return next;
        });
      }
      if (res.expiredByRestore || res.routeMismatch || res.threadMismatch || res.staleOrMissingPending) {
        pushToast(res.text, 'info');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '恢复中断回合失败', 'error');
    } finally {
      setResumingPendingTurn(false);
    }
  };

  const handleAbandonPendingTurn = async () => {
    if (isDraftActiveRef.current) return;
    const targetThreadId = activeThreadId;
    const targetPending = visibleRecoveryTurn;
    const targetState = visibleRecoveryState;
    if (
      (!targetPending && !targetState?.hasUnclosedToolBatch) ||
      (targetPending && targetPending.threadId !== targetThreadId) ||
      (targetState && targetState.threadId !== targetThreadId) ||
      activeThreadIdRef.current !== targetThreadId ||
      resumingPendingTurn ||
      abandoningPendingTurn ||
      abortControllerRef.current
    ) {
      return;
    }
    setAbandoningPendingTurn(true);
    try {
      const res = await abandonPendingCoachTurn({
        threadId: targetThreadId,
        pendingTurn: targetPending,
      });
      refreshThreadsFromVault();
      if (res.receipts.length) {
        setReceiptsById((prev) => {
          const next = { ...prev };
          for (const r of res.receipts) next[r.id] = r;
          return next;
        });
      }
      if (!isDraftActiveRef.current && activeThreadIdRef.current === targetThreadId) {
        const nextState = await inspectCoachThreadPendingState(targetThreadId);
        if (
          !isDraftActiveRef.current &&
          activeThreadIdRef.current === targetThreadId &&
          nextState.threadId === targetThreadId
        ) {
          setPendingRecoveryState(nextState);
          setPendingRecoveryTurn(nextState.pendingTurn);
        }
      }
      if (res.threadMismatch || res.staleOrMissingPending) {
        pushToast(res.text, 'info');
        return;
      }
      const msgText = res.text.trim();
      if (msgText || res.receipts.length) {
        const abandonedMsg: CoachUiMessage = {
          id: `a-abn-${Date.now().toString(36)}`,
          threadId: targetThreadId,
          role: 'assistant',
          createdAt: Date.now(),
          text: msgText,
          ...(res.receipts.length ? { receiptIds: res.receipts.map((r) => r.id) } : {}),
        };
        setMessages((prev) => {
          const next = [...prev, abandonedMsg];
          persistMessagesSnapshot(next, targetThreadId);
          return next;
        });
      }
      pushToast(
        res.quarantined
          ? '已放弃并隔离未确认工具批，保留既有审计数据与实绩'
          : '已放弃未完成操作，可继续发送',
        'info',
      );
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : '放弃操作失败，已保留可恢复状态，请重试',
        'error',
      );
    } finally {
      setAbandoningPendingTurn(false);
    }
  };

  const persistQuickConfigUpdate = async (
    patch: Partial<{ model: string; models: string[]; thinkingDepth: CoachThinkingDepth }>,
  ) => {
    const nextModel = patch.model !== undefined ? patch.model.trim() : providerModel.trim();
    const nextModels =
      patch.models !== undefined
        ? patch.models
        : nextModel && !providerModels.includes(nextModel)
          ? [...providerModels, nextModel]
          : providerModels;
    const identity = {
      kind: savedConfig?.kind ?? providerKind,
      presetId: savedConfig?.presetId ?? providerPresetId,
      baseUrl: (savedConfig?.baseUrl ?? providerBaseUrl).trim(),
      model: nextModel,
    };
    const deploymentId = computeDeploymentId(identity);
    const thinkingByModel = { ...savedConfig?.thinkingByModel };
    if (patch.thinkingDepth) thinkingByModel[coachModelKey(identity)] = patch.thinkingDepth;
    const nextPayload = {
      ...identity,
      deploymentId,
      models: nextModels,
      thinkingByModel,
      capabilitiesByModel: savedConfig?.capabilitiesByModel,
      contextWindowByModel: savedConfig?.contextWindowByModel ?? contextWindowByModel,
      webSearchProvider: savedConfig?.webSearchProvider ?? webSearchProvider,
      webSearchApiKey: savedConfig?.webSearchApiKey ?? webSearchApiKey,
      apiKey: (savedConfig?.apiKey ?? providerApiKey).trim(),
    };
    setProviderModel(nextModel);
    setProviderModels(nextModels);
    setSavedConfig({ key: 'provider', ...nextPayload, updatedAt: Date.now() });
    await saveCoachProviderConfig(nextPayload);
    if (streamThreadId !== null) {
      pushToast('配置已保存，将在本轮工具链结束后生效', 'info');
    }
  };

  const handleSelectThinkingDepth = (nextDepth: CoachThinkingDepth) => {
    void persistQuickConfigUpdate({ thinkingDepth: nextDepth });
  };

  const handleQuickSwitchModel = (modelId: string) => {
    void persistQuickConfigUpdate({ model: modelId });
  };

  const handleSend = async () => {
    if (abortControllerRef.current || sendingGuardRef.current) return;
    const rawDraftAtSend = draft;
    const cleanText = rawDraftAtSend.trim();
    if (!cleanText && !pendingAttachment) return;

    sendingGuardRef.current = true;
    const now = Date.now();
    const isStartingFromDraft = isDraftActiveRef.current;
    const selectionKeyAtSend = selectedThreadKeyRef.current;
    const att = pendingAttachment;
    const uniqueSuffix =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    const threadIdAtSend = isStartingFromDraft
      ? `thread-${crypto.randomUUID()}`
      : activeThreadIdRef.current;
    const userMsgId = `u-${now.toString(36)}-${uniqueSuffix}`;
    const assistantMsgId = `a-${(now + 1).toString(36)}-${uniqueSuffix}`;
    const defaultAttPrompt =
      att?.kind === 'video'
        ? '请帮我分析这段训练视频中的动作与发力建议'
        : '请帮我识别这张图片中的训练计划';

    const userMsg: CoachUiMessage = {
      id: userMsgId,
      threadId: threadIdAtSend,
      role: 'user',
      createdAt: now,
      text: cleanText || defaultAttPrompt,
      attachment: att ?? undefined,
    };

    const placeholderMsg: CoachUiMessage = {
      id: assistantMsgId,
      threadId: threadIdAtSend,
      role: 'assistant',
      createdAt: now + 1,
      text: '',
      streaming: true,
    };

    const ac = new AbortController();
    let historyForTurn = isStartingFromDraft ? [] : visibleMessages.map(uiToStoredMessage);
    let contextSummary = isStartingFromDraft ? undefined : activeThread?.contextSummary;

    let canAdoptCreatedFocus = !isStartingFromDraft;
    try {
      if (isStartingFromDraft) {
        userSelectedThreadRef.current = true;
        const draftSendOpSeq = ++threadsUiOpSeqRef.current;
        const newThreadMeta: CoachThreadMeta = {
          id: threadIdAtSend,
          title: '新对话',
          titleSource: 'placeholder',
          createdAt: now,
          updatedAt: now,
        };
        const createdState = await createCoachThreadWithFirstMessageInVault({
          thread: newThreadMeta,
          firstMessage: uiToStoredMessage(userMsg),
        });
        const shouldAdopt =
          draftSendOpSeq === threadsUiOpSeqRef.current &&
          isDraftActiveRef.current &&
          selectedThreadKeyRef.current === selectionKeyAtSend;
        canAdoptCreatedFocus = shouldAdopt;
        if (shouldAdopt) {
          isDraftActiveRef.current = false;
          setIsDraftActive(false);
        }
        setThreadsState((prev) => {
          const outcome = resolveDraftFirstSendOutcome({
            prevUiState: prev,
            createdState,
            deletedThreadIds: deletedThreads.current,
            sendOpSeq: draftSendOpSeq,
            currentOpSeq: threadsUiOpSeqRef.current,
            currentIsDraftActive: shouldAdopt,
            currentSelectedKey: shouldAdopt ? COACH_DRAFT_SELECTION_ID : selectedThreadKeyRef.current,
          });
          threadsRef.current = outcome.nextThreadsState;
          return outcome.nextThreadsState;
        });
      } else {
        const pendingState = await inspectCoachThreadPendingState(threadIdAtSend);
        if (pendingState.hasUnclosedToolBatch) {
          if (!isDraftActiveRef.current && activeThreadIdRef.current === threadIdAtSend) {
            setPendingRecoveryState(pendingState);
            setPendingRecoveryTurn(pendingState.pendingTurn);
          }
          pushToast('检测到未闭合的历史工具操作，请先「恢复继续」或明确「放弃」后再发送', 'info');
          return;
        }
        await upsertCoachMessages([uiToStoredMessage(userMsg)]);
        canAdoptCreatedFocus =
          !isDraftActiveRef.current && activeThreadIdRef.current === threadIdAtSend;
      }
      abortControllerRef.current = ac;
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '消息发送初始化失败，请重试', 'error');
      return;
    } finally {
      sendingGuardRef.current = false;
    }

    threadSendNonceRef.current.set(
      threadIdAtSend,
      (threadSendNonceRef.current.get(threadIdAtSend) ?? 0) + 1,
    );

    setMessages((prev) => [...prev, userMsg, placeholderMsg]);

    const curThread = threadsRef.current.threads.find((thread) => thread.id === threadIdAtSend);
    const substantive = Boolean(att) || (cleanText.length > 2 &&
      !/^(你好|您好|嗨|哈喽|在吗|hi|hello)[！!。.?？\s]*$/i.test(cleanText));
    const needsTitle = Boolean((isStartingFromDraft || (curThread && isPlaceholder(curThread))) && substantive);
    let titled = false;
    const nameThread = (raw: string, allowReplace = false) => {
      const title = conversationTitle(raw);
      if (!title) return;
      editThread(threadIdAtSend, (thread) => {
        if (!isPlaceholder(thread) && !(allowReplace && thread.titleSource === 'auto' && thread.title === fallbackTitle)) {
          return thread;
        }
        titled = true;
        return { ...thread, title, titleSource: 'auto', updatedAt: now };
      });
    };
    const fallbackTitle = conversationTitle(
      cleanText.replace(/^(?:你好[，,\s]*|我想问(?:一下)?[，,\s]*|请帮我[，,\s]*)+/, '') ||
      (att?.kind === 'video' ? '训练视频' : '训练计划图片'),
    );
    if (!isStartingFromDraft) {
      editThread(threadIdAtSend, (thread) => ({ ...thread, updatedAt: now }));
    }

    const draftKeyToClear = isStartingFromDraft ? COACH_DRAFT_SELECTION_ID : threadIdAtSend;
    setDrafts((prev) => clearDraftTextIfUnchanged(prev, draftKeyToClear, rawDraftAtSend));
    setAttachments((prev) => clearDraftAttachmentIfUnchanged(prev, draftKeyToClear, att));
    if (canAdoptCreatedFocus) {
      setPlusMenuOpen(false);
      setPlusSubPanel('none');
      setContextPopoverOpen(false);
      setShowExample(false);
    }
    setStreamThreadId(threadIdAtSend);
    activeStreamMsgIdRef.current = assistantMsgId;
    requestAnimationFrame(() => {
      const scroller = dual.coachScrollRef.current;
      if (scroller && !isDraftActiveRef.current && threadsRef.current.activeThreadId === threadIdAtSend) {
        scroller.scrollTop = scroller.scrollHeight;
      }
    });

    const webSearchAtSend = webSearchEnabled;
    const cfgAtSend = savedConfig;
    const thinkingAtSend = thinkingDepth;

    void runCoachTurn({
      threadId: threadIdAtSend,
      userText: userMsg.text,
      attachments: att?.stored ? [att.stored] : undefined,
      history: historyForTurn,
      contextSummary,
      thinkingDepth: thinkingAtSend,
      webSearch: webSearchAtSend,
      providerConfig: cfgAtSend,
      toolContext: {
        activeSession,
        plans,
        exerciseTemplates,
        historyHydrated,
        ensureFullHistory,
        activeThreadId: threadIdAtSend,
        hooks: txHooks,
      },
      signal: ac.signal,
      streamChunkDelayMs: 38,
      onSegmentChanged: () => {
        if (!deletedThreads.current.has(threadIdAtSend)) refreshThreadsFromVault();
      },
      onBillingRecord: () => {
        if (!deletedThreads.current.has(threadIdAtSend)) refreshThreadsFromVault();
      },
      onCompactionApplied: ({ compressedCount, summary }) => {
        if (deletedThreads.current.has(threadIdAtSend) || compressedCount <= 0) return;
        let leftToMark = compressedCount;
        setMessages((prev) => {
          const next = prev.map((m) => {
            if (
              leftToMark > 0 &&
              (m.threadId ?? DEFAULT_COACH_THREAD_ID) === threadIdAtSend &&
              !m.isDemo &&
              !m.streaming &&
              !m.compressed &&
              m.id !== assistantMsgId
            ) {
              leftToMark -= 1;
              return { ...m, compressed: true };
            }
            return m;
          });
          persistMessagesSnapshot(next, threadIdAtSend);
          return next;
        });
        editThread(threadIdAtSend, (thread) => ({
          ...thread,
          contextSummary: summary,
          compressedCount: (thread.compressedCount ?? 0) + compressedCount,
          updatedAt: Date.now(),
        }));
        pushToast(`按经济收益完成自动压缩，已归档 ${compressedCount} 条早期对话`, 'info');
      },
      onReasoningChunk: (accumulatedReasoning) => {
        if (activeStreamMsgIdRef.current !== assistantMsgId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, reasoning: accumulatedReasoning } : m,
          ),
        );
      },
      onTextChunk: (accumulated) => {
        if (activeStreamMsgIdRef.current !== assistantMsgId) return;
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, text: accumulated } : m)),
        );
      },
      onReceipt: (receipt) => {
        setReceiptsById((prev) => ({ ...prev, [receipt.id]: receipt }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, receiptIds: [...(m.receiptIds ?? []), receipt.id] }
              : m,
          ),
        );
      },
      onUsage: (usage) => {
        const promptTokens = usage.promptTokens ?? usage.totalTokens ?? 0;
        editThread(threadIdAtSend, (thread) => {
          const prev = thread.lastUsage;
          const resolvedPrompt = promptTokens > 0 ? promptTokens : prev?.promptTokens ?? 0;
          if (resolvedPrompt <= 0 && usage.durationMs === undefined && usage.tokensPerSec === undefined) {
            return thread;
          }
          return {
            ...thread,
            lastUsage: {
              promptTokens: resolvedPrompt,
              ...(usage.completionTokens !== undefined
                ? { completionTokens: usage.completionTokens }
                : prev?.completionTokens !== undefined
                  ? { completionTokens: prev.completionTokens }
                  : {}),
              ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
              ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
              ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
              ...(usage.ttftMs !== undefined ? { ttftMs: usage.ttftMs } : {}),
              ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
              ...(usage.tokensPerSec !== undefined ? { tokensPerSec: usage.tokensPerSec } : {}),
              ...(usage.rounds !== undefined ? { rounds: usage.rounds } : {}),
              ...(promptTokens <= 0 && resolvedPrompt > 0 && prev?.estimated !== undefined
                ? { estimated: prev.estimated }
                : {}),
              updatedAt: Date.now(),
            },
          };
        });
      },
      onCitations: (citations) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, citations } : m)),
        );
      },
      requestTitle: needsTitle,
      onTitle: (title) => { if (needsTitle) nameThread(title); },
      onThinkingFallback: () => {
        setMessages((prev) => prev.map((m) =>
          m.id === assistantMsgId ? { ...m, thinkingFallback: true } : m));
      },
      onDraftPlan: (draftPlan) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, draftPlan } : m)),
        );
      },
    })
      .then((res) => {
        if (abortControllerRef.current === ac) {
          abortControllerRef.current = null;
          setStreamThreadId(null);
        }
        if (activeStreamMsgIdRef.current === assistantMsgId) {
          activeStreamMsgIdRef.current = null;
        }
        if (res.blockedByUnclosedBatch) {
          setMessages((prev) =>
            prev.filter((m) => m.id !== userMsgId && m.id !== assistantMsgId),
          );
          void deleteCoachMessagesByIds([userMsgId]);
          setDrafts((prev) => ({ ...prev, [threadIdAtSend]: cleanText }));
          if (att) setAttachmentFor(threadIdAtSend, att);
          void inspectCoachThreadPendingState(threadIdAtSend).then((st) => {
            if (!isDraftActiveRef.current && activeThreadIdRef.current === threadIdAtSend && st.threadId === threadIdAtSend) {
              setPendingRecoveryState(st);
              setPendingRecoveryTurn(st.pendingTurn);
            }
          });
          pushToast(res.text, 'info');
          return;
        }
        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  streaming: false,
                  ...(res.reasoning ? { reasoning: res.reasoning } : {}),
                  text: res.aborted
                    ? m.text
                      ? `${m.text}\n（已手动停止生成）`
                      : '（已手动停止生成）'
                    : res.text,
                  receiptIds: res.receipts.length ? res.receipts.map((r) => r.id) : m.receiptIds,
                  draftPlan: m.draftPlan ?? res.draftPlan,
                  citations: res.citations?.length ? res.citations : m.citations,
                }
              : m,
          );
          persistMessagesSnapshot(next, threadIdAtSend);
          return next;
        });
        if (!deletedThreads.current.has(threadIdAtSend)) refreshThreadsFromVault();
        if (needsTitle && !titled && !deletedThreads.current.has(threadIdAtSend)) {
          nameThread(fallbackTitle);
          if (!res.aborted && res.text) {
            void suggestCoachTitle(userMsg.text || fallbackTitle, res.text, cfgAtSend, {
              dayName: activeSession?.day.dayName,
              threadId: threadIdAtSend,
            })
              .then((title) => { if (title) nameThread(title, true); })
              .catch(() => {});
          }
        }
        if (!isDraftActiveRef.current && threadsRef.current.activeThreadId === threadIdAtSend) {
          requestAnimationFrame(() => {
            const scroller = dual.coachScrollRef.current;
            if (scroller && !isDraftActiveRef.current && threadsRef.current.activeThreadId === threadIdAtSend) scroller.scrollTop = scroller.scrollHeight;
          });
        }
      })
      .catch((err) => {
        if (abortControllerRef.current === ac) {
          abortControllerRef.current = null;
          setStreamThreadId(null);
        }
        if (activeStreamMsgIdRef.current === assistantMsgId) {
          activeStreamMsgIdRef.current = null;
        }
        if (needsTitle && !titled) nameThread(fallbackTitle);
        const aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
        const message = aborted ? '已停止生成' : err instanceof Error ? err.message : '发送失败，请重试';
        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, streaming: false, text: aborted && m.text ? m.text + '\n（已停止生成）' : message }
              : m,
          );
          persistMessagesSnapshot(next, threadIdAtSend);
          return next;
        });
      });
  };

  const handlePickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const threadId = pickingThread.current ?? selectedThreadKeyRef.current;
    pickingThread.current = null;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const compressed = await compressCoachImage(file);
      setAttachmentFor(threadId, {
        id: compressed.id,
        kind: 'image',
        name: compressed.name,
        dataUrl: attachmentToDataUrl(compressed),
        width: compressed.width,
        height: compressed.height,
        sizeBytes: compressed.sizeBytes,
        stored: compressed,
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '图片压缩或读取失败', 'error');
    }
  };

  const handlePickVideo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const threadId = pickingThread.current ?? selectedThreadKeyRef.current;
    pickingThread.current = null;
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const prepared = await prepareCoachVideo(file);
      setAttachmentFor(threadId, {
        id: prepared.id,
        kind: 'video',
        name: prepared.name,
        dataUrl: `data:${prepared.mimeType};base64,${prepared.dataBase64}`,
        posterDataUrl: prepared.posterDataUrl,
        durationSec: prepared.durationSec,
        width: prepared.width,
        height: prepared.height,
        sizeBytes: prepared.sizeBytes,
        stored: prepared,
      });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '视频读取失败', 'error');
    }
  };

  const toggleDemoUndo = (msgId: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.demoReceipt
          ? {
              ...m,
              demoReceipt: {
                ...m.demoReceipt,
                undone: !m.demoReceipt.undone,
              },
            }
          : m,
      ),
    );
  };

  const handleUndoRealReceipt = async (receiptId: string) => {
    try {
      setReceiptErrors((prev) => {
        const copy = { ...prev };
        delete copy[receiptId];
        return copy;
      });
      const res = await undoCoachReceipt(receiptId, txHooks);
      setReceiptsById((prev) => ({ ...prev, [res.receipt.id]: res.receipt }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : '无法撤销该操作';
      setReceiptErrors((prev) => ({ ...prev, [receiptId]: msg }));
    }
  };

  const updateDraftField = (msgId: string, updater: (draftPlan: CoachPlanDraft) => CoachPlanDraft) => {
    setMessages((prev) => {
      const targetTid = prev.find((m) => m.id === msgId)?.threadId ?? DEFAULT_COACH_THREAD_ID;
      const next = prev.map((m) =>
        m.id === msgId && m.draftPlan ? { ...m, draftPlan: updater(m.draftPlan) } : m,
      );
      persistMessagesSnapshot(next, targetTid);
      return next;
    });
  };

  const handleConfirmDraftPlan = async (msgId: string, draftPlan: CoachPlanDraft) => {
    if (confirmingDraftsRef.current.has(msgId) || draftPlan.confirmedPlanId) return;
    confirmingDraftsRef.current.add(msgId);
    setConfirmingDrafts([...confirmingDraftsRef.current]);
    setDraftErrors((prev) => ({ ...prev, [msgId]: '' }));
    try {
      const res = await coachCreatePlanFromDraft({ draft: draftPlan }, txHooks);
      setReceiptsById((prev) => ({ ...prev, [res.receipt.id]: res.receipt }));
      setMessages((prev) => {
        const targetTid = prev.find((m) => m.id === msgId)?.threadId ?? DEFAULT_COACH_THREAD_ID;
        const next = prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                draftPlan: { ...draftPlan, confirmedPlanId: res.plan?.id },
                receiptIds: [...(m.receiptIds ?? []), res.receipt.id],
              }
            : m,
        );
        persistMessagesSnapshot(next, targetTid);
        return next;
      });
    } catch (err) {
      setDraftErrors((prev) => ({ ...prev, [msgId]: err instanceof Error ? err.message : '创建计划失败' }));
    } finally {
      confirmingDraftsRef.current.delete(msgId);
      setConfirmingDrafts([...confirmingDraftsRef.current]);
    }
  };

  const handleSaveProvider = async () => {
    const cleanModel = providerModel.trim();
    const mergedModels =
      cleanModel && !providerModels.includes(cleanModel)
        ? [...providerModels, cleanModel]
        : providerModels;
    const deploymentId = computeDeploymentId({
      kind: providerKind,
      presetId: providerPresetId,
      baseUrl: providerBaseUrl.trim(),
      model: cleanModel,
    });
    const payload = {
      kind: providerKind,
      ...(providerPresetId ? { presetId: providerPresetId } : {}),
      deploymentId,
      baseUrl: providerBaseUrl.trim(),
      model: cleanModel,
      models: mergedModels,
      thinkingByModel: savedConfig?.thinkingByModel,
      capabilitiesByModel,
      contextWindowByModel,
      webSearchProvider,
      webSearchApiKey: webSearchApiKey.trim(),
      apiKey: providerApiKey.trim(),
    };
    setProviderModels(mergedModels);
    setSavedConfig({ key: 'provider', ...payload, updatedAt: Date.now() });
    setSettingsOpen(false);
    await saveCoachProviderConfig(payload);
    if (streamThreadId !== null) {
      pushToast('配置已保存，将在本轮工具链结束后生效', 'info');
    }
  };

  const openPanelFromAction = (panel: 'settings' | 'threads' | 'memory') => {
    setPlusMenuOpen(false);
    setPlusSubPanel('none');
    setContextPopoverOpen(false);
    if (panel === 'settings') {
      setThreadsOpen(false);
      setMemoryOpen(false);
      setSettingsOpen((v) => !v);
    } else if (panel === 'memory') {
      setThreadsOpen(false);
      setSettingsOpen(false);
      setMemoryOpen((v) => !v);
    } else {
      setSettingsOpen(false);
      setMemoryOpen(false);
      setThreadsOpen((v) => !v);
    }
  };

  const activeModelLabel = online ? savedConfig?.model.trim() : '本地教练';
  const memoryPromptPreview = useMemo(() => formatCoachMemoryForPrompt(memoryStore, 1200), [memoryStore]);
  const contextStats = useMemo(
    () =>
      computeCoachContextStats({
        model: online ? savedConfig?.model ?? '' : 'local',
        advertisedMaxTokens: selectedModelKey
          ? savedConfig?.contextWindowByModel?.[selectedModelKey] ?? contextWindowByModel[selectedModelKey]
          : undefined,
        messages: visibleMessages.map(uiToStoredMessage),
        contextSummary: activeThread?.contextSummary,
        compressedCount: activeThread?.compressedCount,
        memoryText: memoryPromptPreview,
        systemSnapshotChars: activeSession ? JSON.stringify(activeSession).length : 400,
        draftText: draft,
        hasPendingImage: pendingAttachment?.kind === 'image',
        hasPendingVideo: pendingAttachment?.kind === 'video',
        lastUsage: activeThread?.lastUsage,
      }),
    [
      online,
      savedConfig,
      selectedModelKey,
      contextWindowByModel,
      visibleMessages,
      activeThread,
      memoryPromptPreview,
      activeSession,
      draft,
      pendingAttachment,
    ],
  );
  const displayedMessages = visibleMessages.filter((message) => !message.isDemo || showExample);
  const dialogThread = threadsState.threads.find((thread) => thread.id === threadDialog?.id);
  const openThreadDialog = (thread: CoachThreadMeta, action: 'rename' | 'delete') => {
    setThreadMenu(null);
    setThreadError('');
    setRenameTitle(thread.title);
    setThreadDialog({ id: thread.id, action });
  };

  return (
    <div className={`coach-shell${isPrimary ? ' is-primary' : ' is-mini'}`}>
      {/* 主屏态独立顶栏；小窗态的顶栏控制由 FloatingWindowFrame 外部未缩放栏承接 */}
      {isPrimary ? (
        <header className="coach-primary-header" data-testid="coach-primary-header">
          <button
            type="button"
            className={`coach-header-btn${dual.miniVisibility === 'mini' ? ' is-swap' : ''}`}
            data-testid="coach-primary-swap-btn"
            aria-label={
              dual.miniVisibility === 'mini'
                ? '互换业务页回主屏'
                : dual.miniVisibility === 'minimized'
                  ? '恢复训练小窗'
                  : '打开训练小窗'
            }
            onClick={() => dual.swapPanes()}
          >
            <span className="coach-header-ico" aria-hidden="true">
              {dual.miniVisibility === 'mini' ? '⇄' : '✦'}
            </span>
            <span className="coach-header-txt">
              {dual.miniVisibility === 'mini' ? '互换' : dual.miniVisibility === 'minimized' ? '恢复' : '小窗'}
            </span>
          </button>
          <button type="button" className="coach-thread-heading" data-testid="coach-threads-btn"
            onClick={() => openPanelFromAction('threads')} title={isDraftActive ? '新对话' : activeThread?.title}>
            {isDraftActive ? '新对话' : (activeThread?.title ?? '新对话')} <span aria-hidden="true">⌄</span>
          </button>
          <div className="coach-primary-actions">
            <button type="button" className="coach-header-icon-btn" data-testid="coach-new-thread-btn"
              aria-label="新开对话" onClick={handleNewThread}>✎</button>
            <button type="button" className="coach-header-icon-btn" aria-label="窗口操作"
              aria-expanded={windowActionsOpen} data-testid="coach-window-actions"
              onClick={() => setWindowActionsOpen(!windowActionsOpen)}>···</button>
          </div>
        </header>
      ) : (
        <div className="coach-mini-banner">
          <button type="button" className="coach-thread-heading" data-testid="coach-mini-threads-btn"
            onClick={() => openPanelFromAction('threads')} title={isDraftActive ? '新对话' : activeThread?.title}>
            {isDraftActive ? '新对话' : (activeThread?.title ?? '新对话')} <span aria-hidden="true">⌄</span>
          </button>
          <button type="button" className="coach-mini-action-btn" data-testid="coach-mini-new-thread-btn"
            aria-label="新开对话" onClick={handleNewThread}>✎</button>
        </div>
      )}

      {isPrimary && windowActionsOpen ? createPortal(
        <div className="coach-modal-backdrop" onClick={() => setWindowActionsOpen(false)}>
          <section className="coach-modal-sheet coach-window-menu" role="dialog" aria-modal="true" aria-label="窗口操作"
            onClick={(e) => e.stopPropagation()}>
            {activeThreadId === DEFAULT_COACH_THREAD_ID && (
              <button type="button" className="btn btn-ghost" data-testid="coach-window-example-btn"
                onClick={() => { setShowExample(!showExample); setWindowActionsOpen(false); }}>
                {showExample ? '收起示例' : '用法示例'}
              </button>
            )}
            <button type="button" className="btn btn-ghost" data-testid="coach-window-memory-btn"
              onClick={() => { setWindowActionsOpen(false); openPanelFromAction('memory'); }}>
              长期记忆 ({memoryStore.items.length})
            </button>
            <button type="button" className="btn btn-ghost" data-testid="coach-primary-minimize-btn"
              onClick={() => { setWindowActionsOpen(false); dual.minimizeCoach(); }}>最小化教练</button>
            <button type="button" className="btn btn-ghost" data-testid="coach-primary-close-btn"
              onClick={() => { setWindowActionsOpen(false); dual.closeCoach(); }}>关闭教练</button>
          </section>
        </div>, document.body,
      ) : null}

      {threadsOpen
        ? (() => {
            const panel = (
              <section className="coach-threads-panel" data-testid="coach-threads-panel">
                <div className="coach-threads-head">
                  <strong>会话</strong>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => { setThreadMenu(null); setThreadsOpen(false); }}
                  >
                    收起
                  </button>
                </div>
                <div className="coach-threads-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    data-testid="coach-drawer-new-thread-btn"
                    onClick={handleNewThread}
                  >
                    新建会话
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    data-testid="coach-compress-ctx-btn"
                    disabled={compressingContext || isStreaming || compressibleCount < 4}
                    onClick={() => void handleCompressContext()}
                  >
                    {compressingContext
                      ? '压缩中…'
                      : `压缩上下文（${compressibleCount}条）`}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    data-testid="coach-threads-memory-btn"
                    onClick={() => openPanelFromAction('memory')}
                  >
                    长期记忆（{memoryStore.items.length}）
                  </button>
                </div>
                <div className="coach-threads-list">
                  {threadsState.threads.map((t) => {
                    const count = messages.filter(
                      (m) => !m.isDemo && (m.threadId ?? DEFAULT_COACH_THREAD_ID) === t.id,
                    ).length;
                    const isCur = !isDraftActive && t.id === activeThreadId;
                    return (
                      <div key={t.id} className={`coach-thread-row${isCur ? ' is-active' : ''}`}>
                        <button
                          type="button"
                          className="coach-thread-select"
                          data-testid={`coach-thread-item-${t.id}`}
                          onClick={() => handleSwitchThread(t.id)}
                        >
                          <strong>
                            {isCur ? '● ' : ''}
                            {t.title}
                          </strong>
                          <small>
                            {count} 条记录{t.contextSummary ? ' · 已摘要压缩' : ''}
                          </small>
                        </button>
                        <div className="coach-thread-menu">
                          <button type="button" className="coach-header-icon-btn"
                            data-testid={'coach-thread-menu-' + t.id}
                            aria-label={'管理会话 ' + t.title} aria-expanded={threadMenu === t.id}
                            onClick={() => setThreadMenu(threadMenu === t.id ? null : t.id)}>···</button>
                          {threadMenu === t.id && (
                            <div className="coach-thread-menu-actions">
                              <button type="button" onClick={() => openThreadDialog(t, 'rename')}>重命名</button>
                              <button type="button" onClick={() => openThreadDialog(t, 'delete')}>删除</button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
            if (isPrimary && typeof document !== 'undefined') {
              return createPortal(
                <div
                  className="coach-modal-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-label="对话列表与上下文管理"
                  onClick={() => { setThreadMenu(null); setThreadsOpen(false); }}
                >
                  <div className="coach-modal-sheet" onClick={(e) => e.stopPropagation()}>
                    {panel}
                  </div>
                </div>,
                document.body,
              );
            }
            return <div className="coach-mini-panel-wrap" ref={miniPanelRef}>{panel}</div>;
          })()
        : null}

      {settingsOpen
        ? (() => {
            const panel = (
              <CoachSettingsPanel
                kind={providerKind}
                presetId={providerPresetId}
                baseUrl={providerBaseUrl}
                apiKey={providerApiKey}
                model={providerModel}
                models={providerModels}
                onChangeKind={(k) => {
                  setProviderKind(k);
                  setProviderPresetId(undefined);
                }}
                onSelectPreset={(pid) => setProviderPresetId(pid)}
                onChangeBaseUrl={(u) => {
                  setProviderBaseUrl(u);
                  setProviderPresetId(undefined);
                }}
                onChangeApiKey={setProviderApiKey}
                onSelectModel={setProviderModel}
                onChangeModels={setProviderModels}
                onClose={() => setSettingsOpen(false)}
                onSave={handleSaveProvider}
                capabilitiesByModel={capabilitiesByModel}
                onCapabilities={setCapabilitiesByModel}
                webSearchProvider={webSearchProvider}
                webSearchApiKey={webSearchApiKey}
                onChangeWebSearchProvider={setWebSearchProvider}
                onChangeWebSearchApiKey={setWebSearchApiKey}
                contextWindowByModel={contextWindowByModel}
                memoryCount={memoryStore.items.length}
                onOpenMemory={() => openPanelFromAction('memory')}
                onContextWindows={(winMap) =>
                  setContextWindowByModel((prev) => {
                    const next = { ...prev };
                    for (const [k, v] of Object.entries(winMap)) {
                      if (typeof v === 'number' && Number.isFinite(v) && v >= 4096) {
                        next[k] = Math.round(v);
                      } else {
                        delete next[k];
                      }
                    }
                    return next;
                  })
                }
              />
            );
            if (isPrimary && typeof document !== 'undefined') {
              return createPortal(
                <div
                  className="coach-modal-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-label="电子教练模型配置"
                  onClick={() => setSettingsOpen(false)}
                >
                  <div className="coach-modal-sheet" onClick={(e) => e.stopPropagation()}>
                    {panel}
                  </div>
                </div>,
                document.body,
              );
            }
            return <div className="coach-mini-panel-wrap" ref={miniPanelRef}>{panel}</div>;
          })()
        : null}

      {memoryOpen
        ? (() => {
            const panel = (
              <CoachMemoryPanel
                open={memoryOpen}
                store={memoryStore}
                onClose={() => setMemoryOpen(false)}
                onChange={setMemoryStore}
                onToast={(msg) => pushToast(msg, 'info')}
              />
            );
            if (isPrimary && typeof document !== 'undefined') {
              return createPortal(
                <div
                  className="coach-modal-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-label="电子教练长期记忆"
                  onClick={() => setMemoryOpen(false)}
                >
                  <div className="coach-modal-sheet" onClick={(e) => e.stopPropagation()}>
                    {panel}
                  </div>
                </div>,
                document.body,
              );
            }
            return <div className="coach-mini-panel-wrap" ref={miniPanelRef}>{panel}</div>;
          })()
        : null}

      {threadDialog && dialogThread ? createPortal(
        <div className="coach-modal-backdrop coach-thread-dialog" onClick={() => { if (!deleting) setThreadDialog(null); }}>
          <form className="coach-modal-sheet coach-thread-form" role="dialog" aria-modal="true"
            aria-labelledby="coach-thread-dialog-title" onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (threadDialog.action === 'delete') {
                void handleDeleteThread(dialogThread.id);
              } else if (renameTitle.trim()) {
                editThread(dialogThread.id, (thread) => ({ ...thread, title: renameTitle.trim(), titleSource: 'manual' }));
                setThreadDialog(null);
              }
            }}>
            <h2 id="coach-thread-dialog-title">
              {threadDialog.action === 'delete' ? '删除「' + dialogThread.title + '」这条会话？' : '重命名会话'}
            </h2>
            {threadDialog.action === 'delete' ? (
              <p>聊天记录将删除。已保存的训练和计划会保留。</p>
            ) : (
              <input autoFocus aria-label="会话名称" value={renameTitle} maxLength={60}
                onChange={(e) => setRenameTitle(e.target.value)} />
            )}
            {threadError && <p role="alert">{threadError}</p>}
            <div className="coach-settings-actions">
              <button type="button" className="btn btn-sm btn-ghost" autoFocus={threadDialog.action === 'delete'}
                disabled={deleting} onClick={() => setThreadDialog(null)}>取消</button>
              <button type="submit" className="btn btn-sm btn-primary"
                disabled={deleting || (threadDialog.action === 'rename' && !renameTitle.trim())}>
                {threadDialog.action === 'delete' ? (deleting ? '删除中…' : '删除会话') : '保存名称'}
              </button>
            </div>
          </form>
        </div>, document.body,
      ) : null}

      {/* 消息滚动区 */}
      <div
        className="coach-messages"
        ref={dual.coachScrollRef}
        data-testid="coach-messages-scroll"
      >
        {activeThread?.contextSummary ? (
          <details className="coach-context-summary" data-testid="coach-context-summary">
            <summary>
              已压缩 {activeThread.compressedCount ?? 0} 条早期上下文 · 点此展开摘要
            </summary>
            <div className="coach-context-summary-body">{activeThread.contextSummary}</div>
          </details>
        ) : null}

        {!visibleMessages.some((m) => !m.isDemo) && (
          <div className="coach-thread-empty" data-testid="coach-thread-empty">
            <p>刚做完一组？告诉我重量和次数。</p>
            {visibleMessages.some((m) => m.isDemo) && (
              <button type="button" className="btn btn-sm btn-ghost" data-testid="coach-examples-btn"
                aria-expanded={showExample} onClick={() => setShowExample(!showExample)}>
                {showExample ? '收起示例' : '用法示例'}
              </button>
            )}
          </div>
        )}
        {displayedMessages.map((m) => (
          <article
            key={m.id}
            className={`coach-msg role-${m.role}${m.compressed ? ' is-compressed' : ''}`}
            data-testid={`coach-msg-${m.id}`}
          >
            <div className="coach-msg-role">
              <span>{m.role === 'user' ? '你' : '教练'}</span>

              {m.compressed ? <span className="coach-compressed-tag"> · 已归档压缩</span> : null}
            </div>
            {m.attachment ? (
              <button
                type="button"
                className="coach-att-thumb-btn"
                data-testid={`coach-att-preview-${m.id}`}
                aria-label={`预览附件 ${m.attachment.name}`}
                onClick={() => setPreviewAttachment(m.attachment!)}
              >
                {m.attachment.kind === 'video' ? (
                  m.attachment.posterDataUrl ? (
                    <img src={m.attachment.posterDataUrl} alt={m.attachment.name} />
                  ) : (
                    <span className="coach-video-badge">▶ 视频</span>
                  )
                ) : (
                  <img src={m.attachment.dataUrl} alt={m.attachment.name} />
                )}
                <span>
                  {m.attachment.kind === 'video' ? '🎬 ' : ''}
                  {m.attachment.name}
                  {m.attachment.durationSec ? ` · ${m.attachment.durationSec}s` : ''}
                </span>
              </button>
            ) : null}

            {m.role === 'assistant' && m.reasoning ? (
              <details
                className="coach-thinking-box"
                data-testid="coach-thinking-box"

              >
                <summary>查看思考过程</summary>
                <div className="coach-thinking-body">{m.reasoning}</div>
              </details>
            ) : null}

            <div className="coach-msg-body">
              {m.role === 'assistant' ? (
                m.text ? (
                  <CoachMarkdown text={m.text} streaming={m.streaming} />
                ) : m.streaming ? (
                  '正在回复…'
                ) : (
                  ''
                )
              ) : (
                m.text || (m.streaming ? '正在回复…' : '')
              )}
            </div>
            {m.thinkingFallback && <small className="coach-inline-note">本次使用模型默认</small>}

            {m.role === 'assistant' && m.citations?.length ? (
              <div className="coach-citations" data-testid="coach-citations">
                {m.citations.map((c) => (
                  <a
                    key={c.url}
                    className="coach-citation-chip"
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={c.url}
                  >
                    ↗ {c.title}
                  </a>
                ))}
              </div>
            ) : null}

            {m.draftPlan && (
              <CoachDraftCard draft={m.draftPlan} busy={confirmingDrafts.includes(m.id)}
                error={draftErrors[m.id]}
                onChange={(draftPlan) => updateDraftField(m.id, () => draftPlan)}
                onConfirm={(draftPlan) => void handleConfirmDraftPlan(m.id, draftPlan)}
              />
            )}

            {(m.receiptIds ?? []).map((rid) => {
              const receipt = receiptsById[rid];
              if (!receipt) return null;
              const errText = receiptErrors[receipt.id];
              return (
                <div
                  key={receipt.id}
                  className={`coach-receipt is-real${receipt.undone ? ' is-undone' : ''}`}
                  data-testid={`coach-receipt-card-${receipt.id}`}
                >
                  <div className="coach-receipt-row">
                    <span>{receipt.undone ? `已撤销：${receipt.summary}` : receipt.summary}
                      {!receipt.undone && receipt.timerStarted ? ' · 已开休息计时' : ''}
                    </span>
                    {!receipt.undone && receipt.undoable !== false ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm coach-receipt-undo"
                        data-testid={`coach-receipt-undo-${receipt.id}`}
                        onClick={() => void handleUndoRealReceipt(receipt.id)}
                      >
                        撤销
                      </button>
                    ) : null}
                  </div>
                  {errText ? <div className="coach-receipt-error">{errText}</div> : null}
                </div>
              );
            })}

            {m.demoReceipt ? (
              <div className={`coach-receipt${m.demoReceipt.undone ? ' is-undone' : ''}`}>
                <span>{m.demoReceipt.undone ? `已撤销：${m.demoReceipt.label}` : m.demoReceipt.label}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm coach-receipt-undo"
                  data-testid="coach-undo-demo-btn"
                  onClick={() => toggleDemoUndo(m.id)}
                >
                  {m.demoReceipt.undone ? '恢复示例' : '撤销示例'}
                </button>
              </div>
            ) : null}

            {m.role === 'assistant' && !m.streaming && m.text ? (
              <div className="coach-msg-actions">
                <button
                  type="button"
                  className="coach-copy-btn"
                  data-testid="coach-copy-btn"
                  onClick={async () => {
                    const ok = await copyPlainText(m.text);
                    pushToast(ok ? '已复制教练回复' : '当前环境无法访问剪贴板', ok ? 'ok' : 'error');
                  }}
                >
                  复制
                </button>
              </div>
            ) : null}
          </article>
        ))}
      </div>

      {/* 底部输入栏 + 悬浮弹层 + 极简底栏 */}
      <footer ref={composerRef} className="coach-composer" data-testid="coach-composer">
        {(() => {
          const portalStyle =
            isPrimary && popoverBottomPx !== null
              ? ({ bottom: `${popoverBottomPx}px` } as React.CSSProperties)
              : undefined;
          const wrapComposerPopover = (node: React.ReactElement | null) =>
            node && isPrimary && typeof document !== 'undefined'
              ? createPortal(node, document.body)
              : node;

          const ctxNode = contextPopoverOpen
            ? (() => {
                const u = activeThread?.lastUsage;
                const cachePct =
                  u?.cachedTokens !== undefined && u.promptTokens > 0
                    ? Math.min(100, Math.round((u.cachedTokens / u.promptTokens) * 100))
                    : undefined;
                const hasTelemetry = Boolean(
                  u &&
                    (u.cachedTokens !== undefined ||
                      u.ttftMs !== undefined ||
                      u.durationMs !== undefined ||
                      u.tokensPerSec !== undefined ||
                      u.completionTokens !== undefined ||
                      u.reasoningTokens !== undefined),
                );
                const fmtPct = (pct: number) =>
                  pct <= 0 ? '0%' : pct < 1 ? `${Math.max(0.1, Math.round(pct * 10) / 10)}%` : `${Math.round(pct)}%`;
                const billing = activeThread?.billingTotals;
                const billingDenom = billing
                  ? billing.cachedInputTokens + billing.uncachedInputTokens + billing.cacheCreationInputTokens
                  : 0;
                const billingHitPct =
                  billing && billingDenom > 0
                    ? Math.round((billing.cachedInputTokens / billingDenom) * 100)
                    : null;
                return (
                  <div
                    ref={ctxPopoverRef}
                    className={`coach-ctx-popover${isPrimary ? ' is-portaled-popover' : ''}`}
                    style={portalStyle}
                    data-testid="coach-context-panel"
                  >
                    <div className="coach-ctx-popover-head">
                      <strong>上下文窗口</strong>
                      <span className="coach-ctx-badge">
                        {contextStats.isMeasured ? '接口实测' : '本地估算'}
                      </span>
                    </div>
                    <div className="coach-ctx-summary-line">
                      <strong>{contextStats.percentLabel} 已用</strong>
                      <span>
                        {formatCompactTokens(contextStats.usedTokens)} /{' '}
                        {formatCompactTokens(contextStats.maxTokens)}
                      </span>
                    </div>
                    <div className="coach-ctx-bar" aria-hidden="true">
                      <div className="coach-ctx-seg is-sys" style={{ width: `${contextStats.systemPct}%` }} />
                      <div className="coach-ctx-seg is-mem" style={{ width: `${contextStats.memoryPct}%` }} />
                      <div className="coach-ctx-seg is-conv" style={{ width: `${contextStats.conversationPct}%` }} />
                      <div className="coach-ctx-seg is-att" style={{ width: `${contextStats.attachmentPct}%` }} />
                    </div>
                    <div className="coach-ctx-rows">
                      <div className="coach-ctx-row">
                        <span className="coach-ctx-key"><i className="coach-ctx-dot is-sys" />系统与工具</span>
                        <span className="coach-ctx-val">{fmtPct(contextStats.systemPct)} · {formatCompactTokens(contextStats.systemAndToolsTokens)}</span>
                      </div>
                      <div className="coach-ctx-row">
                        <span className="coach-ctx-key"><i className="coach-ctx-dot is-mem" />长期记忆</span>
                        <span className="coach-ctx-val">{fmtPct(contextStats.memoryPct)} · {formatCompactTokens(contextStats.memoryTokens)}</span>
                      </div>
                      <div className="coach-ctx-row">
                        <span className="coach-ctx-key"><i className="coach-ctx-dot is-conv" />对话（{contextStats.activeMessageCount}条）</span>
                        <span className="coach-ctx-val">{fmtPct(contextStats.conversationPct)} · {formatCompactTokens(contextStats.conversationTokens)}</span>
                      </div>
                      <div className="coach-ctx-row">
                        <span className="coach-ctx-key"><i className="coach-ctx-dot is-att" />媒体附件</span>
                        <span className="coach-ctx-val">{fmtPct(contextStats.attachmentPct)} · {formatCompactTokens(contextStats.attachmentTokens)}</span>
                      </div>
                      {billing && (billing.requests > 0 || (billing.externalSearchRequests ?? 0) > 0) ? (() => {
                        const hasUnknownCache = (billing.unknownCacheDetailRequests ?? 0) > 0;
                        const missLabel =
                          billing.unknownUsageRequests > 0 || hasUnknownCache
                            ? '错失unknown'
                            : `错失${formatCompactTokens(billing.uncachedInputTokens)}`;
                        const sym = billing.currency === 'CNY' ? '¥' : '$';
                        const costText = (() => {
                          if (billing.currency === 'mixed' && billing.subtotalsByCurrency) {
                            const parts: string[] = [];
                            const cny = billing.subtotalsByCurrency.CNY;
                            const usd = billing.subtotalsByCurrency.USD;
                            if (cny) {
                              parts.push(
                                cny.totalCost !== null
                                  ? `¥${cny.totalCost.toFixed(4)}`
                                  : cny.costBounds
                                    ? `¥${cny.costBounds.min.toFixed(4)}–${cny.costBounds.max.toFixed(4)}`
                                    : '¥unknown',
                              );
                            }
                            if (usd) {
                              parts.push(
                                usd.totalCost !== null
                                  ? `$${usd.totalCost.toFixed(4)}`
                                  : usd.costBounds
                                    ? `$${usd.costBounds.min.toFixed(4)}–${usd.costBounds.max.toFixed(4)}`
                                    : '$unknown',
                              );
                            }
                            return parts.length ? parts.join(' + ') : 'unknown';
                          }
                          if (billing.unknownUsageRequests > 0 || billing.currency === 'unknown') {
                            return 'unknown';
                          }
                          if (billing.totalCostUsd !== null) {
                            return `${sym}${billing.totalCostUsd.toFixed(4)}`;
                          }
                          if (billing.costBounds) {
                            return `${sym}${billing.costBounds.min.toFixed(4)}–${billing.costBounds.max.toFixed(4)}`;
                          }
                          return 'unknown';
                        })();
                        return (
                          <>
                            {billing.requests > 0 ? (
                              <div className="coach-ctx-row" data-testid="coach-context-billing">
                                <span className="coach-ctx-key">
                                  模型用量与费用（{billing.requests}次 · {!hasUnknownCache && billingHitPct !== null ? `${billingHitPct}%命中` : '命中unknown'} · {missLabel}）
                                </span>
                                <span className="coach-ctx-val">{costText}</span>
                              </div>
                            ) : null}
                            {(billing.externalSearchRequests ?? 0) > 0 ? (
                              <div className="coach-ctx-row" data-testid="coach-context-external-search-billing">
                                <span className="coach-ctx-key">
                                  外部检索（{billing.externalSearchRequests}次 · 不计入模型缓存）
                                </span>
                                <span className="coach-ctx-val">费用 unknown</span>
                              </div>
                            ) : null}
                          </>
                        );
                      })() : null}
                    </div>
                    {hasTelemetry && u ? (
                      <div className="coach-ctx-telemetry" data-testid="coach-context-telemetry">
                        {u.ttftMs !== undefined || u.tokensPerSec !== undefined ? (
                          <div className="coach-ctx-tel-item">
                            <span>TTFT {u.ttftMs !== undefined ? formatDurationCompact(u.ttftMs) : '—'}</span>
                            <strong>{u.tokensPerSec !== undefined ? `${u.tokensPerSec} tok/s` : ''}</strong>
                          </div>
                        ) : null}
                        {cachePct !== undefined ? (
                          <div className="coach-ctx-tel-item">
                            <span>缓存命中</span>
                            <strong>{cachePct}% · {formatCompactTokens(u.cachedTokens ?? 0)}</strong>
                          </div>
                        ) : null}
                        {u.durationMs !== undefined ? (
                          <div className="coach-ctx-tel-item">
                            <span>本轮耗时</span>
                            <strong>
                              {formatDurationCompact(u.durationMs)}
                              {u.rounds && u.rounds > 1 ? ` · ${u.rounds} 轮` : ''}
                            </strong>
                          </div>
                        ) : null}
                        {u.completionTokens !== undefined || u.reasoningTokens !== undefined ? (
                          <div className="coach-ctx-tel-item">
                            <span>输出 / 思考</span>
                            <strong>
                              {formatCompactTokens(u.completionTokens ?? 0)} / {formatCompactTokens(u.reasoningTokens ?? 0)}
                            </strong>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="coach-ctx-popover-foot">
                      <span className="coach-ctx-hint">经济收益 / 上限自动压缩</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        data-testid="coach-context-compress-btn"
                        disabled={compressingContext || isStreaming || compressibleCount < 4}
                        onClick={() => {
                          setContextPopoverOpen(false);
                          void handleCompressContext();
                        }}
                      >
                        {compressingContext ? '压缩中…' : `压缩早期上下文（${compressibleCount}条）`}
                      </button>
                    </div>
                  </div>
                );
              })()
            : null;

          const plusNode = plusMenuOpen ? (
            <div
              ref={plusMenuRef}
              className={`coach-plus-menu${isPrimary ? ' is-portaled-popover' : ''}`}
              style={portalStyle}
              data-testid="coach-plus-menu"
            >
              <div className="coach-plus-grid">
                <button
                  type="button"
                  className="coach-plus-tile"
                  data-testid="coach-pick-image-btn"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setPlusSubPanel('none');
                    pickingThread.current = selectedThreadKeyRef.current;
                    fileInputRef.current?.click();
                  }}
                >
                  <span className="coach-plus-tile-ico" aria-hidden="true">
                    🖼
                  </span>
                  <span>添加照片</span>
                </button>
                <button
                  type="button"
                  className="coach-plus-tile"
                  data-testid="coach-pick-video-btn"
                  onClick={() => {
                    setPlusMenuOpen(false);
                    setPlusSubPanel('none');
                    pickingThread.current = selectedThreadKeyRef.current;
                    videoInputRef.current?.click();
                  }}
                >
                  <span className="coach-plus-tile-ico" aria-hidden="true">
                    🎬
                  </span>
                  <span>添加视频</span>
                </button>
              </div>
            </div>
          ) : null;

          const modelNode = plusSubPanel !== 'none' ? (
            <div
              ref={modelPanelRef}
              className={`coach-plus-menu coach-model-menu${isPrimary ? ' is-portaled-popover' : ''}`}
              style={portalStyle}
              data-testid="coach-model-panel"
            >
              <div className="coach-model-tabs">
                <button
                  type="button"
                  className={plusSubPanel === 'model' ? 'is-active' : undefined}
                  data-testid="coach-plus-model-btn"
                  onClick={() => setPlusSubPanel('model')}
                >
                  模型
                </button>
                {online && (
                  <button
                    type="button"
                    className={plusSubPanel === 'thinking' ? 'is-active' : undefined}
                    data-testid="coach-plus-thinking-btn"
                    onClick={() => setPlusSubPanel('thinking')}
                  >
                    思考档位
                  </button>
                )}
                <button
                  type="button"
                  data-testid="coach-open-settings-from-plus"
                  onClick={() => openPanelFromAction('settings')}
                >
                  设置
                </button>
              </div>
              {plusSubPanel === 'thinking' ? (
                <div className="coach-plus-subpanel" data-testid="coach-thinking-selector">
                  <div className="coach-plus-subhead">选择推理/思考深度</div>
                  <div className="coach-thinking-options">
                    {(['default', ...levels] as CoachThinkingDepth[]).map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={`coach-thinking-opt${thinkingDepth === level ? ' is-active' : ''}`}
                        data-testid={`coach-thinking-opt-${level}`}
                        onClick={() => handleSelectThinkingDepth(level)}
                      >
                        <strong>{coachThinkingLabel(level)}</strong>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {plusSubPanel === 'model' ? (
                <div className="coach-plus-subpanel" data-testid="coach-model-switcher">
                  {providerModels.length === 0 ? (
                    <div className="coach-plus-empty">
                      还没有常用模型
                    </div>
                  ) : (
                    <div className="coach-quick-models">
                      {providerModels.map((id) => {
                        const isCur = (savedConfig?.model || providerModel).trim() === id;
                        return (
                          <button
                            key={id}
                            type="button"
                            className={`coach-quick-model-btn${isCur ? ' is-active' : ''}`}
                            data-testid={`coach-quick-model-${id}`}
                            onClick={() => handleQuickSwitchModel(id)}
                          >
                            {isCur ? '● ' : ''}
                            {id}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null;

          return (
            <>
              {wrapComposerPopover(ctxNode)}
              {wrapComposerPopover(plusNode)}
              {wrapComposerPopover(modelNode)}
            </>
          );
        })()}

        <div className="coach-composer-status">
          <button
            ref={modelPillRef}
            type="button"
            className="coach-status-pill"
            data-testid="coach-status-model-pill"
            aria-expanded={plusSubPanel !== 'none'}
            title={activeModelLabel}
            onClick={() => {
              setPlusMenuOpen(false);
              setContextPopoverOpen(false);
              setPlusSubPanel((current) => (current === 'none' ? 'model' : 'none'));
            }}
          >
            <span className="coach-status-model-txt">
              {activeModelLabel}{online ? ' · ' + coachThinkingLabel(thinkingDepth) : ''}
            </span>
            <span className="coach-status-caret" aria-hidden="true">▾</span>
          </button>
          <div className="coach-status-right">
            <button
              type="button"
              className={`coach-status-chip coach-web-toggle coach-web-icon-btn${webSearchEnabled ? ' is-active' : ''}`}
              data-testid="coach-web-search-toggle"
              aria-pressed={webSearchEnabled}
              aria-label={webSearchEnabled ? '联网搜索已开启，点击关闭' : '联网搜索已关闭，点击开启'}
              title={webSearchEnabled ? '联网搜索：开' : '联网搜索：关'}
              onClick={() => {
                setWebSearchEnabled((prev) => {
                  const next = !prev;
                  const eff = normalizeWebSearchProvider(
                    savedConfig?.webSearchProvider ?? webSearchProvider,
                  );
                  if (
                    next &&
                    online &&
                    savedConfig?.kind !== 'gemini' &&
                    (eff === 'off' ||
                      ((eff === 'tavily' || eff === 'bocha' || eff === 'brave') &&
                        !savedConfig?.webSearchApiKey?.trim()))
                  ) {
                    pushToast(
                      eff === 'off'
                        ? '外网搜索已设为关闭，请在设置中切回内置联网'
                        : '当前搜索服务未填 API Key，可在设置中补全或切回内置联网',
                      'info',
                    );
                  }
                  return next;
                });
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9.5" />
                <path d="M2.5 12h19" />
                <path d="M12 2.5a14.5 14.5 0 0 1 0 19 14.5 14.5 0 0 1 0-19Z" />
              </svg>
            </button>
            <button
              ref={ctxPillRef}
              type="button"
              className={`coach-status-chip coach-ctx-ring-btn is-${contextStats.level}`}
              data-testid="coach-context-pill"
              aria-expanded={contextPopoverOpen}
              aria-label={`上下文 ${formatCompactTokens(contextStats.usedTokens)} / ${formatCompactTokens(contextStats.maxTokens)}（${contextStats.percentLabel}）`}
              title={`上下文 ${formatCompactTokens(contextStats.usedTokens)} / ${formatCompactTokens(contextStats.maxTokens)}`}
              onClick={() => {
                setPlusMenuOpen(false);
                setPlusSubPanel('none');
                setContextPopoverOpen((v) => !v);
              }}
            >
              {(() => {
                const r = 6.5;
                const circ = 2 * Math.PI * r;
                const rawFill = Math.min(1, Math.max(0, contextStats.percentExact / 100)) * circ;
                const fillLen = contextStats.usedTokens > 0 ? Math.max(2.6, rawFill) : 0;
                return (
                  <svg className="coach-ctx-ring-svg" width="15" height="15" viewBox="0 0 18 18" aria-hidden="true">
                    <circle className="coach-ctx-ring-track" cx="9" cy="9" r={r} />
                    {fillLen > 0 ? (
                      <circle
                        className="coach-ctx-ring-fill"
                        cx="9"
                        cy="9"
                        r={r}
                        strokeDasharray={`${fillLen.toFixed(2)} ${circ.toFixed(2)}`}
                        transform="rotate(-90 9 9)"
                      />
                    ) : null}
                  </svg>
                );
              })()}
              <span className="coach-ctx-ring-pct">{contextStats.percentLabel}</span>
            </button>
          </div>
        </div>

        {streamThreadId && !isStreaming && (
          <div className="coach-inline-note">
            另一条会话正在回复 · <button type="button" className="btn btn-sm btn-ghost"
              onClick={() => handleSwitchThread(streamThreadId)}>查看</button>
          </div>
        )}
        {visibleRecoveryTurn || visibleRecoveryState?.hasUnclosedToolBatch ? (
          <div className="coach-inline-note" data-testid="coach-pending-recovery-banner">
            <span>
              {!visibleRecoveryTurn && visibleRecoveryState?.hasUnclosedToolBatch
                ? '检测到历史对话中存在未闭合的工具调用批（缺少对应恢复意图）'
                : visibleRecoveryTurn?.status === 'awaiting_tools'
                  ? '检测到上次中断前有未落盘的训练写入意图'
                  : visibleRecoveryTurn?.status === 'awaiting_followup_model'
                    ? '检测到上次已完成训练写入，等待模型补充确认回复'
                    : visibleRecoveryTurn?.status === 'awaiting_confirmation'
                      ? '检测到待确认的新建计划草稿'
                      : '上一条回复在生成中中断，尚未改动训练数据'}
            </span>{' '}
            {visibleRecoveryTurn ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid="coach-resume-pending-btn"
                  disabled={resumingPendingTurn || abandoningPendingTurn}
                  onClick={() => void handleResumePendingTurn()}
                >
                  {resumingPendingTurn ? '恢复中…' : '恢复继续'}
                </button>{' '}
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-testid="coach-dismiss-pending-btn"
              disabled={resumingPendingTurn || abandoningPendingTurn}
              onClick={() => void handleAbandonPendingTurn()}
            >
              {abandoningPendingTurn ? '放弃中…' : '放弃'}
            </button>
          </div>
        ) : null}
        {hasSessionSwitchHint ? (
          <div className="coach-inline-note" data-testid="coach-new-session-hint">
            <span>已切换到新训练「{activeSession?.day.dayName}」，继续发送将自动切换新段基线 · </span>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-testid="coach-new-session-thread-btn"
              onClick={handleNewThread}
            >
              新开训练对话
            </button>
          </div>
        ) : null}
        {pendingAttachment ? (
          <div className="coach-pending-att" data-testid="coach-pending-attachment">
            <button
              type="button"
              className="coach-pending-preview"
              onClick={() => setPreviewAttachment(pendingAttachment)}
            >
              {pendingAttachment.kind === 'video' ? (
                pendingAttachment.posterDataUrl ? (
                  <img src={pendingAttachment.posterDataUrl} alt={pendingAttachment.name} />
                ) : (
                  <span className="coach-video-badge">▶ 视频</span>
                )
              ) : (
                <img src={pendingAttachment.dataUrl} alt={pendingAttachment.name} />
              )}
              <span>
                {pendingAttachment.name}
                {pendingAttachment.width > 0
                  ? ` · ${pendingAttachment.width}×${pendingAttachment.height}`
                  : ''}
                {pendingAttachment.durationSec ? ` · ${pendingAttachment.durationSec}s` : ''} ·{' '}
                {formatAttachmentBytes(pendingAttachment.sizeBytes)}
              </span>
            </button>
            <button
              type="button"
              className="coach-pending-remove"
              aria-label="移除待发附件"
              onClick={() => setPendingAttachment(null)}
            >
              ×
            </button>
          </div>
        ) : null}

        <div className="coach-composer-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="选择训练或计划图片"
            data-testid="coach-file-input"
            onChange={(e) => void handlePickImage(e)}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            className="sr-only"
            aria-label="选择训练视频"
            data-testid="coach-video-input"
            onChange={(e) => void handlePickVideo(e)}
          />
          <button
            ref={plusBtnRef}
            type="button"
            className={`coach-tool-btn coach-plus-btn${plusMenuOpen ? ' is-open' : ''}`}
            data-testid="coach-plus-btn"
            aria-label="添加照片或视频"
            aria-expanded={plusMenuOpen}
            title="更多功能"
            onClick={() => {
              setPlusSubPanel('none');
              setContextPopoverOpen(false);
              setPlusMenuOpen(!plusMenuOpen);
            }}
          >
            {plusMenuOpen ? '×' : '+'}
          </button>
          <textarea
            className="coach-textarea"
            data-testid="coach-input"
            rows={1}
            placeholder="问教练…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isComposing && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (isStreaming) return;
                void handleSend();
              }
            }}
          />
          {isStreaming ? (
            <button
              type="button"
              className="coach-send-btn is-stop"
              data-testid="coach-cancel-stream-btn"
              onClick={cancelStreaming}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="coach-send-btn"
              data-testid="coach-send-btn"
              disabled={Boolean(streamThreadId) || (!draft.trim() && !pendingAttachment)}
              onClick={() => { void handleSend(); }}
            >
              发送
            </button>
          )}
        </div>
      </footer>

      {/* 图片/视频预览层（主屏态挂到 body 顶层压住悬浮小窗；小窗态限定在所属小窗内） */}
      {previewAttachment
        ? (() => {
            const modal = (
              <div
                className="coach-image-preview-backdrop"
                data-testid="coach-image-preview"
                role="dialog"
                aria-modal="true"
                aria-label={`预览 ${previewAttachment.name}`}
                onClick={() => setPreviewAttachment(null)}
              >
                <div className="coach-image-preview-card" onClick={(e) => e.stopPropagation()}>
                  <div className="coach-image-preview-head">
                    <span>{previewAttachment.name}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid="coach-image-preview-close"
                      onClick={() => setPreviewAttachment(null)}
                    >
                      关闭
                    </button>
                  </div>
                  {previewAttachment.kind === 'video' ? (
                    previewAttachment.dataUrl ? (
                      <video
                        src={previewAttachment.dataUrl}
                        poster={previewAttachment.posterDataUrl}
                        controls
                        playsInline
                        className="coach-video-preview-player"
                      />
                    ) : (
                      <div className="coach-video-archived-note">
                        {previewAttachment.posterDataUrl ? (
                          <img src={previewAttachment.posterDataUrl} alt={previewAttachment.name} />
                        ) : null}
                        <p>
                          该历史消息中的原视频未持久化保存以节省手机存储空间（
                          {formatAttachmentBytes(previewAttachment.sizeBytes)}）。
                        </p>
                      </div>
                    )
                  ) : (
                    <img src={previewAttachment.dataUrl} alt={previewAttachment.name} />
                  )}
                </div>
              </div>
            );
            return isPrimary && typeof document !== 'undefined'
              ? createPortal(modal, document.body)
              : modal;
          })()
        : null}
    </div>
  );
}
