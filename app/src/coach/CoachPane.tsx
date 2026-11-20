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
import { compressCoachContext, runCoachTurn, suggestCoachTitle } from './coachAgent';
import { attachmentToDataUrl, compressCoachImage, prepareCoachVideo } from './coachImage';
import { CoachDraftCard } from './CoachDraftCard';
import { CoachSettingsPanel } from './CoachSettingsPanel';
import {
  createDefaultCoachThreadsState,
  deleteCoachThread,
  DEFAULT_COACH_THREAD_ID,
  listCoachReceipts,
  loadCoachMessages,
  loadCoachProviderConfig,
  loadCoachThreadsState,
  saveCoachMessages,
  saveCoachProviderConfig,
  saveCoachThreadsState,
  type CoachOperationReceipt,
  type CoachPlanDraft,
  type CoachStoredAttachment,
  type CoachStoredMessage,
  type CoachStoredProviderConfig,
  type CoachThreadMeta,
  type CoachThreadsState,
} from './coachStorage';
import { coachCreatePlanFromDraft, undoCoachReceipt, type CoachTxHooks } from './coachTx';
import {
  coachModelKey, coachThinkingLabel, coachThinkingLevels,
  isOfficialDeepSeek, type CoachProviderKind, type CoachThinkingDepth,
} from './providerAdapter';
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
  const [previewAttachment, setPreviewAttachment] = useState<UiPreviewAttachment | null>(null);
  const [isComposing, setIsComposing] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [plusSubPanel, setPlusSubPanel] = useState<'none' | 'thinking' | 'model'>('none');

  const [providerKind, setProviderKind] = useState<CoachProviderKind>('openai-compatible');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [capabilitiesByModel, setCapabilitiesByModel] =
    useState<NonNullable<CoachStoredProviderConfig['capabilitiesByModel']>>({});
  const [providerApiKey, setProviderApiKey] = useState('');
  const [savedConfig, setSavedConfig] = useState<CoachStoredProviderConfig | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStreamMsgIdRef = useRef<string | null>(null);
  const previewLayerId = useId();
  const menuLayerId = useId();

  const isPrimary = dual.primaryPane === 'coach';
  const activeThreadId = threadsState.activeThreadId;
  const draft = drafts[activeThreadId] ?? '';
  const pendingAttachment = attachments[activeThreadId] ?? null;
  const isStreaming = streamThreadId === activeThreadId;
  const selectedModelKey = savedConfig ? coachModelKey(savedConfig) : '';
  const online = Boolean(savedConfig?.apiKey && savedConfig.baseUrl && savedConfig.model);
  const levels = online && savedConfig
    ? savedConfig.capabilitiesByModel?.[selectedModelKey] ?? coachThinkingLevels(savedConfig)
    : [];
  const storedDepth = savedConfig?.thinkingByModel?.[selectedModelKey] ?? 'default';
  const thinkingDepth = levels.includes(storedDepth) ? storedDepth : 'default';
  const setDraft = (text: string) => setDrafts((prev) => ({ ...prev, [activeThreadId]: text }));
  const setAttachmentFor = (id: string, attachment: UiPreviewAttachment | null) => {
    if (deletedThreads.current.has(id)) return;
    setAttachments((prev) => {
      const next = { ...prev };
      if (attachment) next[id] = attachment;
      else delete next[id];
      return next;
    });
  };
  const setPendingAttachment = (attachment: UiPreviewAttachment | null) =>
    setAttachmentFor(activeThreadId, attachment);
  useLayoutEffect(() => {
    const scroller = dual.coachScrollRef.current;
    if (scroller) scroller.scrollTop = threadScroll.current.get(activeThreadId) ?? scroller.scrollHeight;
  }, [activeThreadId, dual.coachScrollRef]);
  const activeThread = useMemo(
    () =>
      threadsState.threads.find((t) => t.id === activeThreadId) ?? threadsState.threads[0],
    [threadsState, activeThreadId],
  );
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (m) => (m.threadId ?? DEFAULT_COACH_THREAD_ID) === activeThreadId,
      ),
    [messages, activeThreadId],
  );
  const compressibleCount = useMemo(
    () =>
      visibleMessages.filter((m) => !m.isDemo && !m.streaming && !m.compressed).length,
    [visibleMessages],
  );

  const txHooks: CoachTxHooks = useMemo(
    () => ({
      onSessionCommitted: (committed) => {
        syncSessionLocal(committed);
        void refreshSessions();
      },
      onPlanCommitted: () => {
        void refreshPlans();
      },
      onPlanDeleted: () => {
        void refreshPlans();
      },
      onReceiptSaved: (r) => {
        setReceiptsById((prev) => ({ ...prev, [r.id]: r }));
      },
    }),
    [syncSessionLocal, refreshSessions, refreshPlans],
  );

  // 初始化读取独立隔离库 motion-coach-vault（与主库及 Backup v4 完全隔离）
  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadCoachMessages(),
      listCoachReceipts(),
      loadCoachProviderConfig(),
      loadCoachThreadsState(),
    ]).then(([storedMsgs, storedReceipts, storedCfg, storedThreads]) => {
      if (!alive) return;
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
        setProviderKind(storedCfg.kind);
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
      threadsRef.current = extraThreads.length
        ? { ...storedThreads, threads: [...storedThreads.threads, ...extraThreads] }
        : storedThreads;
      setThreadsState(threadsRef.current);
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

  const persistMessagesSnapshot = useCallback((list: CoachUiMessage[]) => {
    const persistable = list
      .filter((m) => !m.isDemo && !m.streaming && !deletedThreads.current.has(m.threadId ?? DEFAULT_COACH_THREAD_ID))
      .map(uiToStoredMessage);
    void saveCoachMessages(persistable);
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
    if (!plusMenuOpen && plusSubPanel === 'none' && !threadsOpen && !settingsOpen && !windowActionsOpen) return undefined;
    return backStack.push({
      id: `coach-popover:${menuLayerId}`,
      handle: () => {
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
  }, [plusMenuOpen, plusSubPanel, threadsOpen, settingsOpen, menuLayerId, threadDialog, threadMenu, deleting, windowActionsOpen]);

  useEffect(() => {
    if (dual.coachVisibility === 'closed' || dual.coachVisibility === 'minimized') {
      setPreviewAttachment(null);
      setPlusMenuOpen(false);
      setPlusSubPanel('none');
      setThreadsOpen(false);
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

  const updateAndSaveThreads = (nextState: CoachThreadsState) => {
    threadsRef.current = nextState;
    setThreadsState(nextState);
    void saveCoachThreadsState(nextState);
  };

  const editThread = (id: string, update: (thread: CoachThreadMeta) => CoachThreadMeta) => {
    const current = threadsRef.current;
    if (!current.threads.some((thread) => thread.id === id) || deletedThreads.current.has(id)) return;
    updateAndSaveThreads({ ...current, threads: current.threads.map((thread) => thread.id === id ? update(thread) : thread) });
  };

  const rememberScroll = () => {
    threadScroll.current.set(activeThreadId, dual.coachScrollRef.current?.scrollTop ?? 0);
    setPreviewAttachment(null);
    setIsComposing(false);
  };

  const createThread = (): CoachThreadMeta => {
    const now = Date.now();
    return { id: 'thread-' + crypto.randomUUID(), title: '新对话', titleSource: 'placeholder', createdAt: now, updatedAt: now };
  };

  const handleNewThread = () => {
    rememberScroll();
    const thread = createThread();
    updateAndSaveThreads({ activeThreadId: thread.id, threads: [thread, ...threadsRef.current.threads] });
    setThreadsOpen(false);
    setPlusMenuOpen(false);
    setPlusSubPanel('none');
    setThreadMenu(null);
    setShowExample(false);
  };

  const handleSwitchThread = (threadId: string) => {
    if (threadId !== activeThreadId) {
      rememberScroll();
      updateAndSaveThreads({ ...threadsRef.current, activeThreadId: threadId });
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
    const current = threadsRef.current;
    const remaining = current.threads.filter((thread) => thread.id !== threadId);
    const fallback = remaining[0] ?? createThread();
    const nextState = {
      activeThreadId: current.activeThreadId === threadId ? fallback.id : current.activeThreadId,
      threads: remaining.length ? remaining : [fallback],
    };
    if (streamThreadId === threadId) cancelStreaming();
    try {
      await deleteCoachThread(threadId, nextState);
      setAttachmentFor(threadId, null);
      deletedThreads.current.add(threadId);
      const surviving = threadsRef.current.threads.filter((thread) => thread.id !== threadId);
      updateAndSaveThreads({ ...nextState, threads: surviving.length ? surviving : nextState.threads });
      setMessages((prev) => {
        const next = prev.filter((message) => (message.threadId ?? DEFAULT_COACH_THREAD_ID) !== threadId);
        persistMessagesSnapshot(next);
        return next;
      });
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
      const eligible = messages.filter(
        (m) =>
          !m.isDemo &&
          !m.streaming &&
          !m.compressed &&
          (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetTid,
      );
      const res = await compressCoachContext({
        messages: eligible.map(uiToStoredMessage),
        existingSummary: activeThread?.contextSummary,
        providerConfig: savedConfig,
      });
      if (deletedThreads.current.has(targetTid)) return;
      if (res.compressedCount <= 0) {
        pushToast('暂无可压缩的早期上下文', 'info');
        return;
      }
      const compressedIds = new Set(eligible.slice(0, res.compressedCount).map((m) => m.id));
      setMessages((prev) => {
        const next = prev.map((m) =>
          compressedIds.has(m.id) ? { ...m, compressed: true } : m,
        );
        persistMessagesSnapshot(next);
        return next;
      });
      editThread(targetTid, (thread) => ({
        ...thread,
        contextSummary: res.summary,
        compressedCount: (thread.compressedCount ?? 0) + res.compressedCount,
        updatedAt: Date.now(),
      }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '上下文压缩失败', 'error');
    } finally {
      setCompressingContext(false);
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
      baseUrl: (savedConfig?.baseUrl ?? providerBaseUrl).trim(),
      model: nextModel,
    };
    const thinkingByModel = { ...savedConfig?.thinkingByModel };
    if (patch.thinkingDepth) thinkingByModel[coachModelKey(identity)] = patch.thinkingDepth;
    const nextPayload = {
      ...identity,
      models: nextModels,
      thinkingByModel,
      capabilitiesByModel: savedConfig?.capabilitiesByModel,
      apiKey: (savedConfig?.apiKey ?? providerApiKey).trim(),
    };
    setProviderModel(nextModel);
    setProviderModels(nextModels);
    setSavedConfig({ key: 'provider', ...nextPayload, updatedAt: Date.now() });
    await saveCoachProviderConfig(nextPayload);
  };

  const handleSelectThinkingDepth = (nextDepth: CoachThinkingDepth) => {
    void persistQuickConfigUpdate({ thinkingDepth: nextDepth });
  };

  const handleQuickSwitchModel = (modelId: string) => {
    void persistQuickConfigUpdate({ model: modelId });
  };

  const handleSend = () => {
    if (abortControllerRef.current) return;
    const cleanText = draft.trim();
    if (!cleanText && !pendingAttachment) return;

    const now = Date.now();
    const threadIdAtSend = activeThreadId;
    const userMsgId = `u-${now.toString(36)}`;
    const assistantMsgId = `a-${(now + 1).toString(36)}`;
    const att = pendingAttachment;

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

    const historyForTurn = visibleMessages.map(uiToStoredMessage);
    const contextSummary = activeThread?.contextSummary;

    setMessages((prev) => {
      const next = [...prev, userMsg, placeholderMsg];
      persistMessagesSnapshot(next);
      return next;
    });

    const curThread = threadsRef.current.threads.find((thread) => thread.id === threadIdAtSend);
    const substantive = Boolean(att) || (cleanText.length > 2 &&
      !/^(你好|您好|嗨|哈喽|在吗|hi|hello)[！!。.?？\s]*$/i.test(cleanText));
    const needsTitle = Boolean(curThread && isPlaceholder(curThread) && substantive);
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
    editThread(threadIdAtSend, (thread) => ({ ...thread, updatedAt: now }));

    setDraft('');
    setPendingAttachment(null);
    setPlusMenuOpen(false);
    setPlusSubPanel('none');
    setStreamThreadId(threadIdAtSend);
    setShowExample(false);
    activeStreamMsgIdRef.current = assistantMsgId;
    requestAnimationFrame(() => {
      const scroller = dual.coachScrollRef.current;
      if (scroller && threadsRef.current.activeThreadId === threadIdAtSend) scroller.scrollTop = scroller.scrollHeight;
    });

    const ac = new AbortController();
    abortControllerRef.current = ac;

    void runCoachTurn({
      userText: userMsg.text,
      attachments: att?.stored ? [att.stored] : undefined,
      history: historyForTurn,
      contextSummary,
      thinkingDepth,
      providerConfig: savedConfig,
      toolContext: {
        activeSession,
        plans,
        exerciseTemplates,
        historyHydrated,
        ensureFullHistory,
        hooks: txHooks,
      },
      signal: ac.signal,
      streamChunkDelayMs: 38,
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
                }
              : m,
          );
          persistMessagesSnapshot(next);
          return next;
        });
        if (needsTitle && !titled && !deletedThreads.current.has(threadIdAtSend)) {
          nameThread(fallbackTitle);
          if (!res.aborted && res.text) {
            void suggestCoachTitle(userMsg.text || fallbackTitle, res.text, savedConfig)
              .then((title) => { if (title) nameThread(title, true); })
              .catch(() => {});
          }
        }
        if (threadsRef.current.activeThreadId === threadIdAtSend) {
          requestAnimationFrame(() => {
            const scroller = dual.coachScrollRef.current;
            if (scroller && threadsRef.current.activeThreadId === threadIdAtSend) scroller.scrollTop = scroller.scrollHeight;
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
          persistMessagesSnapshot(next);
          return next;
        });
      });
  };

  const handlePickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const threadId = pickingThread.current ?? activeThreadId;
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
    const threadId = pickingThread.current ?? activeThreadId;
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
      const next = prev.map((m) =>
        m.id === msgId && m.draftPlan ? { ...m, draftPlan: updater(m.draftPlan) } : m,
      );
      persistMessagesSnapshot(next);
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
        const next = prev.map((m) =>
          m.id === msgId
            ? {
                ...m,
                draftPlan: { ...draftPlan, confirmedPlanId: res.plan?.id },
                receiptIds: [...(m.receiptIds ?? []), res.receipt.id],
              }
            : m,
        );
        persistMessagesSnapshot(next);
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
    const payload = {
      kind: providerKind,
      baseUrl: providerBaseUrl.trim(),
      model: cleanModel,
      models: mergedModels,
      thinkingByModel: savedConfig?.thinkingByModel,
      capabilitiesByModel,
      apiKey: providerApiKey.trim(),
    };
    setProviderModels(mergedModels);
    setSavedConfig({ key: 'provider', ...payload, updatedAt: Date.now() });
    setSettingsOpen(false);
    await saveCoachProviderConfig(payload);
  };

  const openPanelFromAction = (panel: 'settings' | 'threads') => {
    setPlusMenuOpen(false);
    setPlusSubPanel('none');
    if (panel === 'settings') {
      setThreadsOpen(false);
      setSettingsOpen((v) => !v);
    } else {
      setSettingsOpen(false);
      setThreadsOpen((v) => !v);
    }
  };

  const activeModelLabel = online ? savedConfig?.model.trim() : '本地教练';
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
            onClick={() => openPanelFromAction('threads')} title={activeThread?.title}>
            {activeThread?.title ?? '新对话'} <span aria-hidden="true">⌄</span>
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
            onClick={() => openPanelFromAction('threads')} title={activeThread?.title}>
            {activeThread?.title ?? '新对话'} <span aria-hidden="true">⌄</span>
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
                </div>
                <div className="coach-threads-list">
                  {threadsState.threads.map((t) => {
                    const count = messages.filter(
                      (m) => !m.isDemo && (m.threadId ?? DEFAULT_COACH_THREAD_ID) === t.id,
                    ).length;
                    const isCur = t.id === activeThreadId;
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
            return panel;
          })()
        : null}

      {settingsOpen
        ? (() => {
            const panel = (
              <CoachSettingsPanel
                kind={providerKind}
                baseUrl={providerBaseUrl}
                apiKey={providerApiKey}
                model={providerModel}
                models={providerModels}
                onChangeKind={setProviderKind}
                onChangeBaseUrl={setProviderBaseUrl}
                onChangeApiKey={setProviderApiKey}
                onSelectModel={setProviderModel}
                onChangeModels={setProviderModels}
                onClose={() => setSettingsOpen(false)}
                onSave={handleSaveProvider}
                capabilitiesByModel={capabilitiesByModel}
                onCapabilities={setCapabilitiesByModel}
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
            return panel;
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

            <div className="coach-msg-body">{m.text || (m.streaming ? '正在回复…' : '')}</div>
            {m.thinkingFallback && <small className="coach-inline-note">本次使用模型默认</small>}

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
                    {!receipt.undone ? (
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

      {/* 底部输入栏 + QQ/微信风格「+」二级菜单 */}
      <footer className="coach-composer" data-testid="coach-composer">
        <div className="coach-composer-status">
          <button type="button" className="coach-status-pill" data-testid="coach-status-model-pill"
            aria-expanded={plusSubPanel !== 'none'} title={activeModelLabel}
            onClick={() => {
              setPlusMenuOpen(false);
              setPlusSubPanel((current) => current === 'none' ? 'model' : 'none');
            }}>
            {activeModelLabel}{online ? ' · ' + coachThinkingLabel(thinkingDepth) : ''}
          </button>
        </div>

        {plusMenuOpen ? (
          <div className="coach-plus-menu" data-testid="coach-plus-menu">
            <div className="coach-plus-grid">
              <button
                type="button"
                className="coach-plus-tile"
                data-testid="coach-pick-image-btn"
                onClick={() => {
                  setPlusMenuOpen(false);
                  setPlusSubPanel('none');
                  pickingThread.current = activeThreadId;
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
                  pickingThread.current = activeThreadId;
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
        ) : null}

        {plusSubPanel !== 'none' && (
          <div className="coach-plus-menu">
            <div className="coach-model-tabs">
              <button type="button" data-testid="coach-plus-model-btn" onClick={() => setPlusSubPanel('model')}>模型</button>
              {online && (
                <button type="button" data-testid="coach-plus-thinking-btn"
                  onClick={() => setPlusSubPanel('thinking')}>思考档位</button>
              )}
              <button type="button" data-testid="coach-open-settings-from-plus"
                onClick={() => openPanelFromAction('settings')}>设置</button>
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
        )}

        {streamThreadId && !isStreaming && (
          <div className="coach-inline-note">
            另一条会话正在回复 · <button type="button" className="btn btn-sm btn-ghost"
              onClick={() => handleSwitchThread(streamThreadId)}>查看</button>
          </div>
        )}
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
            type="button"
            className={`coach-tool-btn coach-plus-btn${plusMenuOpen ? ' is-open' : ''}`}
            data-testid="coach-plus-btn"
            aria-label="添加照片或视频"
            aria-expanded={plusMenuOpen}
            title="更多功能"
            onClick={() => {
              setPlusSubPanel('none');
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
                handleSend();
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
              onClick={handleSend}
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
