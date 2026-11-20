/* 训练执行页 —— 核心记录与编排主入口（Wave 1C.1 模块化拆分后）。
   · 编辑锁 / 生命周期 / 救援草稿 / 保存队列合并 → `./session/useSessionPersistence`
   · 顶栏 / 只读与待存草稿横幅 / 进度摘要 → `./session/SessionHeader`
   · 热身区 → `./session/SessionWarmupSection`
   · 单动作卡片与逐组步进记录（React.memo 细粒度隔离） → `./session/SessionExerciseCard`
   · 结束训练确认面板 → `./session/SessionFinishSheet` */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CARDIO_PRESET_CHOICES, createCardioEntry, validateCardioParams } from '../domain/cardio';
import { collectMovementFragments, comparabilityOf, describeMode, describeMovementPerformance, modeOf } from '../domain/comparability';
import { assessExerciseIdentityChange, exerciseTemplateFromConfig, planTargetApply, sessionExerciseFromTemplate } from '../domain/exerciseConfig';
import { MAX_CARDIO_ENTRIES } from '../domain/limits';
import { evaluateProgressionHint } from '../domain/progressionHint';
import { reorderSessionItems } from '../domain/reorder';
import {
  addCardioToSession, applyTargetToSessionExercise, collectPrefillWeightFieldIds,
  exerciseCompletion, hasAnyData, hasReps,
  hasSkippedGroupsToUnskip, removeLastRound, skipRemaining, summarizeSession, unskipExercise,
  withExercise, withSetAndPrefillFollowingWeight,
} from '../domain/session';
import { collectSingleMovementIds, filterComparableSetsForExercise } from '../domain/supersetPair';
import { setupNoteFor, withSetupNote } from '../domain/setupNote';
import { diffSessionVsPlanDay } from '../domain/sessionToPlanSync';
import {
  applyDeleteItem, previewDeleteItem, undoDeleteItem,
  type DeleteItemKind, type DeleteItemPreview, type DeleteUndoRecord,
} from '../domain/sessionItemIntent';
import type { DumbbellBasis, ExerciseTarget, Session, SessionExercise, WeightMode } from '../domain/types';
import { parseRawRiskField, useSessionRuntimeRegistration } from '../coach/sessionRuntimeBridge';
import { clearRawFieldsInMaps, hasNonEmptyRawDraftInMaps } from './session/rawDraftHelpers';
import {
  bindDeleteFeedback,
  captureDeleteFeedbackIntent,
  invalidateDeleteFeedback,
  notifyDeleteSucceeded,
  setDeleteFeedbackEnabled,
} from '../lib/deletionFeedback';
import { fmtDuration } from '../lib/format';
import { handleBackIntent } from '../lib/nativeBack';
import { navigate } from '../lib/router';
import { useStore } from '../store';
import { cardDrag, useCardDragSnapshot, type ReorderKind } from '../ui/cardDrag';
import { CardioPanel } from '../ui/CardioPanel';
import { Confirm } from '../ui/Confirm';
import {
  applyReflowAnimation,
  buildDissolveParticles,
  captureCardTops,
  captureDeleteRect,
  dissolveAttribution,
  dissolveTiming,
  prefersReducedMotion,
  type DissolveGhost,
  type DissolveKind,
  type DissolvePending,
  type ZoneRect,
} from '../ui/deleteDissolve';
import { DeleteDissolveLayer } from '../ui/DeleteDissolveLayer';
import {
  ExerciseEditor,
  type ExerciseEditorInitial,
  type ExerciseEditorSubmitValue,
} from '../ui/ExerciseEditor';
import { ExerciseNamePicker, type ExerciseNameSelection } from '../ui/ExerciseNamePicker';
import { PlateCalculatorSheet } from '../ui/PlateCalculatorSheet';
import { markPendingFinishReceipt } from '../ui/ReceiptSlipSheet';
import { RestTimerBar, useRestTimer } from '../ui/RestTimer';
import { Sheet } from '../ui/Sheet';
import { SessionSetupNote, useSetupNoteTarget } from './session/SessionSetupNote';
import { SwipeActionCard } from '../ui/SwipeActionCard';
import { UndoStack, type UndoStackItem } from '../ui/UndoStack';
import {
  SessionExerciseCard,
  type LastPerformanceSummary,
} from './session/SessionExerciseCard';
import { SessionFinishSheet } from './session/SessionFinishSheet';
import { SessionHeader } from './session/SessionHeader';
import { SessionWarmupSection } from './session/SessionWarmupSection';
import { useSessionPersistence } from './session/useSessionPersistence';

interface DeleteUndoEntry {
  undo: DeleteUndoRecord;
  until: number;
  name: string;
}

const defaultStraightTarget = (): ExerciseTarget => ({
  kind: 'straight',
  sets: 3,
  setsMax: 3,
  repsMin: 8,
  repsMax: 12,
  weightMode: 'external',
  suggestedWeightKg: null,
});

export function SessionPage({
  sessionId,
  onRenderCard,
}: {
  sessionId: string;
  onRenderCard?: (exId: string) => void;
}) {
  const {
    sessions,
    historyHydrated,
    ensureFullHistory,
    plans,
    activeSession,
    settings,
    syncSessionLocal,
    saveActiveSession,
    saveActiveSessionWithTemplate,
    exerciseTemplates,
    exerciseTemplateError,
    finishTrainingSession,
    discardTrainingSession,
    pushToast,
    refreshSessions,
    refreshPlans,
  } = useStore();

  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? (activeSession?.id === sessionId ? activeSession : undefined),
    [sessions, activeSession, sessionId],
  );

  useEffect(() => {
    if (!historyHydrated) {
      void ensureFullHistory();
    }
  }, [historyHydrated, ensureFullHistory]);

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [toolsFor, setToolsFor] = useState<string | null>(null);
  const { setupNoteForId, openSetupNote, closeSetupNote, templatesById } = useSetupNoteTarget(exerciseTemplates);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const defaultExpandedApplied = useRef(false);
  const [confirmRemoveRoundOpen, setConfirmRemoveRoundOpen] = useState(false);
  const pendingRemoveRound = useRef<string | null>(null);
  const [advanceCycleTouched, setAdvanceCycleTouched] = useState(false);
  const [advanceCycle, setAdvanceCycle] = useState(true);
  const [syncBackToPlanDay, setSyncBackToPlanDay] = useState(false);
  const [plateCalcState, setPlateCalcState] = useState<{
    exId: string;
    exerciseName: string;
    weightKg: number | null;
    setId?: string;
  } | null>(null);
  const finishGuard = useRef(false);
  const [finishing, setFinishing] = useState(false);
  const editorDirtyRef = useRef(false);

  const {
    editorId, confirmedRevision, latestRef, unsavedDraftRef, saveQueue, intentionallyClosed,
    lockBlocked, setLockBlocked, lockLostReason, setLockLostReason, conflictMessage, setConflictMessage,
    saveState, hasPendingDraft, draftConflicts, busyOwner, isCommittedBusy, inputPaused, pausedNotice,
    applyChange, commitPaired, sealPendingWrites, applyExternalSessionCommit, tryTakeOver, retryUnsaved, discardPendingDraft,
  } = useSessionPersistence({
    sessionId,
    session,
    editorDirtyRef,
    syncSessionLocal,
    saveActiveSession,
    saveActiveSessionWithTemplate,
    refreshSessions,
    pushToast,
  });

  const rawRiskRef = useRef<Map<string, Set<string>>>(new Map());
  const rawDraftRef = useRef<Map<string, Map<string, string>>>(new Map());
  const [, setRawRiskVersion] = useState(0);
  const [rawDraftVersions, setRawDraftVersions] = useState<Record<string, number>>({});
  const [rawResetEpochs, setRawResetEpochs] = useState<Record<string, number>>({});
  const bumpRawDraftVersion = useCallback((exId: string) => {
    setRawDraftVersions((prev) => ({ ...prev, [exId]: (prev[exId] ?? 0) + 1 }));
  }, []);
  const registerRawRisk = useCallback((exId: string, fieldId: string, risky: boolean) => {
    const fields = rawRiskRef.current.get(exId) ?? new Set<string>();
    const had = fields.has(fieldId);
    if (risky === had) return;
    if (risky) fields.add(fieldId);
    else fields.delete(fieldId);
    if (fields.size) rawRiskRef.current.set(exId, fields);
    else rawRiskRef.current.delete(exId);
    setRawRiskVersion((v) => v + 1);
  }, []);
  const hasRawRisk = useCallback((exId: string) => (rawRiskRef.current.get(exId)?.size ?? 0) > 0, []);
  const hasNonEmptyRawDraft = useCallback(
    (exId?: string) => hasNonEmptyRawDraftInMaps(rawRiskRef.current, rawDraftRef.current, exId),
    [],
  );
  const registerRawDraft = useCallback((exId: string, fieldId: string, raw: string | null) => {
    const fields = rawDraftRef.current.get(exId) ?? new Map<string, string>();
    const previous = fields.get(fieldId);
    if (raw === null) fields.delete(fieldId);
    else fields.set(fieldId, raw);
    if (fields.size) rawDraftRef.current.set(exId, fields);
    else rawDraftRef.current.delete(exId);
    if (previous !== raw) { setRawRiskVersion((v) => v + 1); bumpRawDraftVersion(exId); }
  }, [bumpRawDraftVersion]);
  const getRawDraft = useCallback(
    (exId: string, fieldId: string) => rawDraftRef.current.get(exId)?.get(fieldId),
    [],
  );
  const clearRawFields = useCallback((exId: string, fieldIds: readonly string[]) => {
    if (clearRawFieldsInMaps(rawRiskRef.current, rawDraftRef.current, exId, fieldIds)) {
      setRawRiskVersion((v) => v + 1);
      bumpRawDraftVersion(exId);
    }
  }, [bumpRawDraftVersion]);

  const cardioRawSignatureGettersRef = useRef<Map<string, () => string | undefined>>(new Map());
  const rawSignatureFor = useCallback((exId: string): string | undefined => {
    const cardioGetter = cardioRawSignatureGettersRef.current.get(exId);
    if (cardioGetter) {
      const live = cardioGetter();
      if (live) return live;
    }
    const fields = [...(rawRiskRef.current.get(exId) ?? [])].sort();
    const raws = [...(rawDraftRef.current.get(exId)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
    if (!fields.length && !raws.length) return undefined;
    return JSON.stringify({ fields, raws });
  }, []);
  const discardRawDrafts = useCallback((exId: string) => {
    rawDraftRef.current.delete(exId);
    rawRiskRef.current.delete(exId);
    setRawRiskVersion((v) => v + 1);
    bumpRawDraftVersion(exId);
    setRawResetEpochs((prev) => ({ ...prev, [exId]: (prev[exId] ?? 0) + 1 }));
  }, [bumpRawDraftVersion]);

  const addInFlightRef = useRef<string | null>(null);
  useEffect(() => {
    const map = rawRiskRef.current;
    if (!map.size) return;
    let changed = false;
    for (const [exId, fields] of Array.from(map)) {
      const ex = session?.exercises.find((e) => e.id === exId);
      if (!ex) {
        map.delete(exId);
        rawDraftRef.current.delete(exId);
        changed = true;
        continue;
      }
      const setIds = new Set(ex.sets.map((st) => st.id));
      for (const fid of Array.from(fields)) {
        const setId = fid.split(':')[0];
        if (!setIds.has(setId)) {
          fields.delete(fid);
          changed = true;
        }
      }
      const rawFields = rawDraftRef.current.get(exId);
      if (rawFields) {
        for (const fid of Array.from(rawFields.keys())) {
          const setId = fid.split(':')[0];
          if (!setIds.has(setId)) rawFields.delete(fid);
        }
        if (!rawFields.size) rawDraftRef.current.delete(exId);
      }
      if (!fields.size) {
        map.delete(exId);
        changed = true;
      }
    }
    if (changed) setRawRiskVersion((v) => v + 1);
  }, [session]);

  const [editorState, setEditorState] = useState<
    | {
        key: string;
        mode: 'add' | 'edit';
        exId: string | null;
        initial: ExerciseEditorInitial;
      }
    | null
  >(null);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;
  const [editorConfirm, setEditorConfirm] = useState<
    | {
        payload: ExerciseEditorSubmitValue;
        exId: string;
        title: string;
        body: string;
      }
    | null
  >(null);
  const [addNameOpen, setAddNameOpen] = useState(false);
  const addCommitRef = useRef<{ sessionId: string; exercise: SessionExercise } | null>(null);
  const [addFailed, setAddFailed] = useState<{
    entry: { sessionId: string; exercise: SessionExercise };
    payload?: ExerciseEditorSubmitValue;
  } | null>(null);
  const [addRetryBusy, setAddRetryBusy] = useState(false);
  const discardedAddIds = useRef<Set<string>>(new Set());
  const [deletePreview, setDeletePreview] = useState<DeleteItemPreview | null>(null);

  /* ── F10：删除成功后的局部消散 + 平滑补位（纯表现层）─────────────── */
  const [dissolveGhosts, setDissolveGhosts] = useState<DissolveGhost[]>([]);
  const dissolvePlayedRef = useRef<Set<string>>(new Set());
  const dissolveTimersRef = useRef<Map<string, number>>(new Map());
  const dissolveEpochRef = useRef(0);
  const reflowCleanupRef = useRef<(() => void) | null>(null);
  const pendingReflowRef = useRef<(DissolvePending & { tops: Map<string, number> }) | null>(null);

  const cancelReflow = useCallback(() => {
    const cleanup = reflowCleanupRef.current;
    reflowCleanupRef.current = null;
    cleanup?.();
  }, []);

  const disarmReflowPending = useCallback(() => {
    pendingReflowRef.current = null;
  }, []);

  const armReflow = useCallback(
    (pending: DissolvePending) => {
      disarmReflowPending();
      pendingReflowRef.current = { ...pending, tops: captureCardTops() };
    },
    [disarmReflowPending],
  );

  const clearDissolveTimer = useCallback((token: string) => {
    const timer = dissolveTimersRef.current.get(token);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dissolveTimersRef.current.delete(token);
    }
  }, []);

  const dissolveGhostsRef = useRef<DissolveGhost[]>([]);
  const setDissolveGhostsBoth = useCallback((next: DissolveGhost[]) => {
    dissolveGhostsRef.current = next;
    setDissolveGhosts(next);
  }, []);

  const endDissolveFor = useCallback(
    (keys: { token?: string; itemId?: string }) => {
      const tokens = new Set<string>();
      if (keys.token) tokens.add(keys.token);
      if (keys.itemId) {
        for (const g of dissolveGhostsRef.current) {
          if (g.itemId === keys.itemId) tokens.add(g.token);
        }
      }
      if (!tokens.size) {
        cancelReflow();
        return;
      }
      for (const token of tokens) clearDissolveTimer(token);
      const next = dissolveGhostsRef.current.filter((g) => !tokens.has(g.token));
      if (next.length !== dissolveGhostsRef.current.length) setDissolveGhostsBoth(next);
      cancelReflow();
    },
    [cancelReflow, clearDissolveTimer, setDissolveGhostsBoth],
  );

  const resetDissolve = useCallback(() => {
    for (const token of Array.from(dissolveTimersRef.current.keys())) clearDissolveTimer(token);
    dissolveTimersRef.current.clear();
    disarmReflowPending();
    cancelReflow();
    if (dissolveGhostsRef.current.length) setDissolveGhostsBoth([]);
  }, [cancelReflow, clearDissolveTimer, disarmReflowPending, setDissolveGhostsBoth]);

  const invalidateFeedback = useCallback(() => {
    dissolveEpochRef.current += 1;
    resetDissolve();
    invalidateDeleteFeedback('hidden-or-lock-lost');
  }, [resetDissolve]);

  const canPlayDissolve = useCallback((epoch: number): boolean => {
    if (epoch !== dissolveEpochRef.current) return false;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    if (prefersReducedMotion()) return false;
    return true;
  }, []);

  const prepareDissolveGeometry = useCallback(
    (preview: DeleteItemPreview, revisionAtIntent: number): ZoneRect | null => {
      try {
        const rect = captureDeleteRect(preview.itemId, preview.kind);
        const kind: DissolveKind = preview.kind === 'cardio' ? 'cardio' : 'exercise';
        armReflow({
          epoch: dissolveEpochRef.current,
          token: preview.token,
          sessionId: preview.sessionId,
          itemId: preview.itemId,
          kind,
          revision: revisionAtIntent,
        });
        return rect;
      } catch {
        disarmReflowPending();
        return null;
      }
    },
    [armReflow, disarmReflowPending],
  );

  const playDissolve = useCallback(
    (args: {
      token: string;
      itemId: string;
      kind: DeleteItemKind;
      name: string;
      rect: ZoneRect | null;
      epoch: number;
    }) => {
      if (!args.rect) return;
      if (dissolvePlayedRef.current.has(args.token)) return;
      if (!canPlayDissolve(args.epoch)) return;
      const timing = dissolveTiming(false);
      if (!timing.ghostMs) return;
      dissolvePlayedRef.current.add(args.token);
      const ghost: DissolveGhost = {
        token: args.token,
        itemId: args.itemId,
        kind: args.kind === 'cardio' ? 'cardio' : 'exercise',
        name: args.name,
        rect: args.rect,
        startedAt: Date.now(),
        durationMs: timing.ghostMs,
        particles: buildDissolveParticles(args.token),
      };
      if (!dissolveGhostsRef.current.some((g) => g.token === args.token)) {
        setDissolveGhostsBoth([...dissolveGhostsRef.current, ghost]);
      }
      clearDissolveTimer(args.token);
      const timer = window.setTimeout(() => {
        dissolveTimersRef.current.delete(args.token);
        const next = dissolveGhostsRef.current.filter((g) => g.token !== args.token);
        if (next.length !== dissolveGhostsRef.current.length) setDissolveGhostsBoth(next);
      }, timing.ghostMs + 40);
      dissolveTimersRef.current.set(args.token, timer);
    },
    [canPlayDissolve, clearDissolveTimer, setDissolveGhostsBoth],
  );

  const [deleteUndoStack, setDeleteUndoStack] = useState<DeleteUndoEntry[]>([]);
  const deleteUndoStackRef = useRef<DeleteUndoEntry[]>([]);
  const [deleteUndoneCount, setDeleteUndoneCount] = useState(0);
  const deleteBatchOrderRef = useRef<Partial<Record<DeleteItemKind, string[]>>>({});
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteInFlightRef = useRef<string | null>(null);
  const deleteConsumedRef = useRef<Set<string>>(new Set());
  const setDeleteUndoStackBoth = useCallback((next: DeleteUndoEntry[]) => {
    deleteUndoStackRef.current = next;
    setDeleteUndoStack(next);
  }, []);
  const deleteUndoStackItems = useMemo<UndoStackItem[]>(
    () => deleteUndoStack.map((it) => ({ token: it.undo.token, name: it.name, until: it.until })),
    [deleteUndoStack],
  );
  const editorSeq = useRef(0);

  const timer = useRestTimer(120, sessionId, (src) =>
    Boolean(
      latestRef.current?.exercises.some(
        (ex) => ex.id === src.sessionExerciseId && (!src.setId || ex.sets.some((st) => st.id === src.setId)),
      ),
    ),
  );
  const timerLiveRef = useRef(timer);
  timerLiveRef.current = timer;

  useSessionRuntimeRegistration(
    session && session.status === 'active'
      ? {
          sessionId: session.id,
          editorId: editorId.current,
          awaitPendingWrites: async () => { sealPendingWrites(); await saveQueue.current; },
          applyCommittedSession: applyExternalSessionCommit,
          hasBlockingDrafts: () => hasPendingDraft || unsavedDraftRef.current !== null || rawRiskRef.current.size > 0,
          startRestTimer: (sec, src) => timerLiveRef.current.start(sec, src),
          listRawRiskEntries: (exId) =>
            [...(rawRiskRef.current.get(exId) ?? [])]
              .map((fid) => parseRawRiskField(exId, fid, session.id))
              .filter((e): e is NonNullable<typeof e> => e !== null),
        }
      : null,
  );

  /* ── 第2阶段 G7：有氧草稿登记钩子（必须在所有提前 return 之前无条件调用）── */
  const cardioFlushers = useRef(new Map<string, () => boolean>());
  const registerCardioFlush = useCallback((id: string, fn: (() => boolean) | null) => {
    if (fn) cardioFlushers.current.set(id, fn);
    else cardioFlushers.current.delete(id);
  }, []);
  const requestOpenSummary = useCallback(() => {
    if (!session || session.status !== 'active') return;
    if (inputPaused) {
      pausedNotice();
      return;
    }
    let blocked = false;
    for (const flush of cardioFlushers.current.values()) {
      if (!flush()) blocked = true;
    }
    if (blocked) {
      pushToast('有氧参数还没输完或不合法，已在对应项目里标出；请先修正或放弃后再结束训练。', 'error');
      return;
    }
    setSyncBackToPlanDay(false);
    setSummaryOpen(true);
  }, [session, inputPaused, pausedNotice, pushToast]);

  const commitDelete = useCallback(async (preview: DeleteItemPreview, confirmed: boolean): Promise<boolean> => {
    if (deleteInFlightRef.current) return false;
    deleteInFlightRef.current = preview.token;
    setDeleteBusy(true);
    let builtUndo: DeleteUndoRecord | null = null;
    const ownerTokenAtStart = timerLiveRef.current.token;
    const dissolveEpochAtStart = dissolveEpochRef.current;
    const feedbackTicketAtStart = captureDeleteFeedbackIntent();
    const dissolveRect = prepareDissolveGeometry(preview, confirmedRevision.current);
    try {
      const r = await commitPaired((fresh) => {
        const rawSignature = rawSignatureFor(preview.itemId);
        const applied = applyDeleteItem(fresh, preview, {
          confirmed,
          hasRawDraft: hasRawRisk(preview.itemId),
          rawSignature,
        });
        if (!applied.ok) throw new Error(applied.message);
        builtUndo = applied.undo;
        return applied.session;
      });
      if (r.status === 'saved') {
        syncSessionLocal(r.session);
        const liveTimer = timerLiveRef.current;
        if (
          liveTimer.source?.sessionExerciseId === preview.itemId &&
          liveTimer.token === ownerTokenAtStart
        ) {
          liveTimer.stop();
        }
        const built = builtUndo as DeleteUndoRecord | null;
        if (built) {
          const committedAt = Date.now();
          const undo: DeleteUndoRecord = { ...built, expiresAt: committedAt + 8000 };
          const wasEmpty = deleteUndoStackRef.current.length === 0;
          if (wasEmpty) {
            deleteBatchOrderRef.current = {};
            setDeleteUndoneCount(0);
          }
          if (!deleteBatchOrderRef.current[built.kind]) {
            deleteBatchOrderRef.current[built.kind] = [...(built.orderBefore ?? [])];
          }
          setDeleteUndoStackBoth([
            ...deleteUndoStackRef.current,
            { undo, until: undo.expiresAt, name: preview.name },
          ]);
        } else pushToast('已删除');
        try {
          playDissolve({
            token: preview.token,
            itemId: preview.itemId,
            kind: preview.kind,
            name: preview.name,
            rect: dissolveRect,
            epoch: dissolveEpochAtStart,
          });
        } catch {
          /* 表现层失败不阻断已成功的业务结果 */
        }
        try {
          notifyDeleteSucceeded(
            {
              sessionId: preview.sessionId,
              itemId: preview.itemId,
              token: preview.token,
            },
            feedbackTicketAtStart,
          );
        } catch {
          /* 反馈失败不影响业务结果 */
        }
        return true;
      }
      disarmReflowPending();
      pushToast(r.status === 'failed' ? r.message : '删除没有保存成功，请重试', 'error');
      return false;
    } catch (err) {
      disarmReflowPending();
      throw err;
    } finally {
      deleteInFlightRef.current = null;
      setDeleteBusy(false);
    }
  }, [commitPaired, rawSignatureFor, hasRawRisk, pushToast, syncSessionLocal, playDissolve, prepareDissolveGeometry, disarmReflowPending, confirmedRevision, setDeleteUndoStackBoth]);

  const dragSnapshot = useCardDragSnapshot();
  const strengthIdsKey = session ? session.exercises.map((e) => e.id).join('\u0000') : '';
  const cardioIdsKey = session ? (session.cardio ?? []).map((c) => c.id).join('\u0000') : '';
  const strengthIds = useMemo(
    () => (strengthIdsKey ? strengthIdsKey.split('\u0000') : []),
    [strengthIdsKey],
  );
  const cardioIds = useMemo(
    () => (cardioIdsKey ? cardioIdsKey.split('\u0000') : []),
    [cardioIdsKey],
  );

  // 异步落库完成后 React 提交新 DOM 顺序，必须在浏览器绘制前同步释放 cardDrag 定格，消除回弹文字残影
  useLayoutEffect(() => {
    cardDrag.releaseCommitHold();
  }, [strengthIdsKey, cardioIdsKey]);

  useEffect(() => {
    return () => {
      cardDrag.releaseCommitHold();
    };
  }, []);

  const commitReorder = useCallback(
    async (kind: ReorderKind, orderedIds: string[], startIds: string[] | null) => {
      const r = await commitPaired((fresh) => {
        const currentIds =
          kind === 'strength'
            ? fresh.exercises.map((e) => e.id)
            : (fresh.cardio ?? []).map((c) => c.id);
        if (startIds && JSON.stringify(currentIds) !== JSON.stringify(startIds)) {
          throw new Error('拖动期间顺序已被其他改动更新，请重新拖动');
        }
        const applied = reorderSessionItems(fresh, kind, orderedIds);
        if (!applied.ok) throw new Error(applied.message);
        return applied.changed ? applied.session : fresh;
      });
      if (r.status === 'saved') {
        syncSessionLocal(r.session);
        pushToast('顺序已保存');
      } else {
        pushToast(r.status === 'failed' ? r.message : '顺序没有保存成功，已保留原顺序', 'error');
      }
    },
    [commitPaired, pushToast, syncSessionLocal],
  );

  const handleReorderStrength = useCallback(
    (ordered: string[], startIds: string[] | null) =>
      commitReorder('strength', ordered, startIds),
    [commitReorder],
  );

  const handleReorderCardio = useCallback(
    (ordered: string[], startIds: string[] | null) =>
      commitReorder('cardio', ordered, startIds),
    [commitReorder],
  );

  const requestDeleteItem = useCallback(
    (itemId: string) => {
      if (inputPaused) {
        pausedNotice();
        return;
      }
      const latest = latestRef.current;
      if (!latest) return;
      const rawSignature = rawSignatureFor(itemId);
      const p = previewDeleteItem(latest, itemId, { hasRawDraft: hasRawRisk(itemId), rawSignature });
      if (!p.ok) {
        pushToast(p.message, 'error');
        return;
      }
      if (p.preview.requiresConfirm) setDeletePreview(p.preview);
      else void commitDelete(p.preview, false);
    },
    [commitDelete, hasRawRisk, inputPaused, latestRef, pausedNotice, pushToast, rawSignatureFor],
  );

  const checkDeleteRequiresConfirm = useCallback(
    (itemId: string): boolean => {
      const current = latestRef.current;
      if (!current) return false;
      const p = previewDeleteItem(current, itemId, {
        hasRawDraft: hasRawRisk(itemId),
        rawSignature: rawSignatureFor(itemId),
      });
      return p.ok && p.preview.requiresConfirm;
    },
    [hasRawRisk, latestRef, rawSignatureFor],
  );

  const confirmDeletePreview = useCallback(() => {
    const preview = deletePreview;
    if (!preview || deleteBusy) return;
    setDeletePreview(null);
    void commitDelete(preview, true);
  }, [commitDelete, deleteBusy, deletePreview]);

  const undoDeleteEntry = useCallback(
    async (token: string) => {
      if (deleteInFlightRef.current) return;
      const entry = deleteUndoStackRef.current.find((it) => it.undo.token === token);
      if (!entry) return;
      if (deleteConsumedRef.current.has(token) || Date.now() > entry.until) {
        const left = deleteUndoStackRef.current.filter((it) => it.undo.token !== token);
        setDeleteUndoStackBoth(left);
        if (!left.length) {
          deleteBatchOrderRef.current = {};
          setDeleteUndoneCount(0);
        }
        pushToast('撤销已过期', 'error');
        return;
      }
      deleteInFlightRef.current = token;
      setDeleteBusy(true);
      endDissolveFor({ token: entry.undo.token, itemId: entry.undo.itemId });
      disarmReflowPending();
      try {
        const orderRef = deleteBatchOrderRef.current[entry.undo.kind];
        const result = await commitPaired((fresh) => {
          const r = undoDeleteItem(fresh, entry.undo, Date.now(), { orderRef });
          if (!r.ok) throw new Error(r.message);
          return r.session;
        });
        if (result.status === 'saved') {
          deleteConsumedRef.current.add(token);
          endDissolveFor({ token: entry.undo.token, itemId: entry.undo.itemId });
          const left = deleteUndoStackRef.current.filter((it) => it.undo.token !== token);
          setDeleteUndoStackBoth(left);
          if (left.length) setDeleteUndoneCount((n) => n + 1);
          else {
            deleteBatchOrderRef.current = {};
            setDeleteUndoneCount(0);
          }
          pushToast('已撤销删除');
        } else {
          pushToast(result.status === 'failed' ? result.message : '撤销没有保存成功', 'error');
        }
      } finally {
        deleteInFlightRef.current = null;
        setDeleteBusy(false);
      }
    },
    [commitPaired, disarmReflowPending, endDissolveFor, pushToast, setDeleteUndoStackBoth],
  );

  useEffect(() => {
    if (!deleteUndoStack.length) return undefined;
    const nextDeadline = Math.min(...deleteUndoStack.map((it) => it.until));
    const timeout = window.setTimeout(() => {
      const at = Date.now();
      const live = deleteUndoStackRef.current.filter((it) => it.until > at);
      if (live.length === deleteUndoStackRef.current.length) return;
      setDeleteUndoStackBoth(live);
      if (!live.length) {
        deleteBatchOrderRef.current = {};
        setDeleteUndoneCount(0);
      }
    }, Math.max(0, nextDeadline - Date.now()) + 16);
    return () => window.clearTimeout(timeout);
  }, [deleteUndoStack, setDeleteUndoStackBoth]);

  const memoryFor = useCallback(
    (exerciseId: string): NonNullable<ExerciseEditorInitial['memory']> => {
      if (exerciseTemplateError) return { mode: 'none', revision: null };
      const tpl = exerciseTemplates.find((t) => t.exerciseId === exerciseId);
      return tpl ? { mode: 'exists', revision: tpl.revision } : { mode: 'first', revision: null };
    },
    [exerciseTemplates, exerciseTemplateError],
  );

  const openEditEditor = useCallback(
    (exId: string) => {
      const latest = latestRef.current;
      const ex = latest?.exercises.find((e) => e.id === exId);
      if (!ex) {
        pushToast('这个动作已经不在本次训练里了', 'error');
        return;
      }
      if (hasNonEmptyRawDraft(exId)) {
        pushToast('这个动作还有未完成输入；请先提交或放弃那些输入，再编辑结构。', 'error');
        return;
      }
      editorSeq.current += 1;
      setEditorState({
        key: `edit:${exId}:${editorSeq.current}`,
        mode: 'edit',
        exId,
        initial: {
          key: `edit:${exId}:${editorSeq.current}`,
          name: ex.name,
          ...(ex.en !== undefined ? { en: ex.en } : {}),
          exerciseId: ex.exerciseId,
          target: structuredClone(ex.target),
          restSec: ex.restSec,
          arrangedGroups: ex.groups.map((g) => ({ ...g })),
          memory: memoryFor(ex.exerciseId),
        },
      });
    },
    [hasNonEmptyRawDraft, latestRef, memoryFor, pushToast],
  );

  const handleToggleExercise = useCallback((exId: string) => {
    setExpandedId((cur) => (cur === exId ? null : exId));
  }, []);

  const handleOpenTools = useCallback((exId: string) => {
    setToolsFor(exId);
  }, []);

  const handleOpenPlateCalc = useCallback(
    (exId: string, weightKg: number | null, setId?: string) => {
      const cur = latestRef.current?.exercises.find((e) => e.id === exId);
      setPlateCalcState({
        exId,
        exerciseName: cur?.name ?? '',
        weightKg,
        setId,
      });
    },
    [latestRef],
  );

  const handleRequestRemoveRound = useCallback((exId: string) => {
    pendingRemoveRound.current = exId;
    setConfirmRemoveRoundOpen(true);
  }, []);

  const commitAddExercise = useCallback(
    async (
      entry: { sessionId: string; exercise: SessionExercise },
      payload?: ExerciseEditorSubmitValue,
    ): Promise<{ ok: boolean; message?: string }> => {
      const latest = latestRef.current;
      if (!latest) return { ok: false, message: '当前不可写，草稿已保留' };
      const intentId = entry.exercise.id;
      if (addInFlightRef.current) return { ok: false, message: '这次添加正在保存，请稍候' };
      addInFlightRef.current = intentId;
      const priorTemplate = payload ? templatesById.get(payload.exerciseId) : undefined;
      const templateWrite =
        payload?.remember && payload.template
          ? { template: withSetupNote(payload.template, priorTemplate?.setupNote), expectedRevision: payload.templateExpectedRevision }
          : undefined;
      try {
        const r = await commitPaired(
          (fresh) =>
            fresh.exercises.some((e) => e.id === entry.exercise.id)
              ? fresh
              : { ...fresh, exercises: [...fresh.exercises, entry.exercise] },
          templateWrite,
        );
        if (r.status === 'saved') {
          pushToast(
            payload?.remember
              ? `已添加「${entry.exercise.name}」，并设为此动作的默认配置`
              : `已添加「${entry.exercise.name}」`,
          );
          addCommitRef.current = null;
          setAddFailed((prev) => (prev && prev.entry.exercise.id !== entry.exercise.id ? prev : null));
          return { ok: true };
        }
        if (!discardedAddIds.current.has(intentId)) {
          setAddFailed({ entry, ...(payload ? { payload } : {}) });
          pushToast(
            `添加没有保存成功：${r.status === 'failed' ? r.message : '版本冲突'}。配置已保留，可重试。`,
            'error',
          );
        }
        return { ok: false, message: '保存失败，配置已保留' };
      } finally {
        if (addInFlightRef.current === intentId) addInFlightRef.current = null;
      }
    },
    [commitPaired, latestRef, pushToast, templatesById],
  );

  const handleAddName = useCallback(
    (selection: ExerciseNameSelection) => {
      setAddNameOpen(false);
      if (exerciseTemplateError) {
        addInFlightRef.current = null;
        pushToast(`动作配置记忆读取异常：${exerciseTemplateError}`, 'error');
        return;
      }
      if (addInFlightRef.current) return;
      const tpl = exerciseTemplates.find((t) => t.exerciseId === selection.exerciseId);
      if (tpl) {
        const exercise = sessionExerciseFromTemplate(tpl);
        const entry = { sessionId, exercise };
        addCommitRef.current = entry;
        void commitAddExercise(entry).finally(() => {
          addInFlightRef.current = null;
        });
        return;
      }
      editorSeq.current += 1;
      const target = defaultStraightTarget();
      setEditorState({
        key: `add:${selection.exerciseId}:${editorSeq.current}`,
        mode: 'add',
        exId: null,
        initial: {
          key: `add:${selection.exerciseId}:${editorSeq.current}`,
          name: selection.name,
          ...(selection.en !== undefined ? { en: selection.en } : {}),
          exerciseId: selection.exerciseId,
          target,
          restSec: 120,
          arrangedGroups: [
            { index: 1, stageCount: 1 },
            { index: 2, stageCount: 1 },
            { index: 3, stageCount: 1 },
          ],
          memory: { mode: 'first', revision: null },
        },
      });
    },
    [commitAddExercise, exerciseTemplateError, exerciseTemplates, pushToast, sessionId],
  );

  const commitEditPayload = useCallback(
    async (payload: ExerciseEditorSubmitValue, exId: string): Promise<{ ok: boolean; message?: string }> => {
      const latest = latestRef.current;
      const source = latest?.exercises.find((e) => e.id === exId);
      if (!latest || !source) return { ok: false, message: '这个动作已经不在本次训练里了' };
      const priorTemplate = templatesById.get(payload.exerciseId);
      const nextNote = setupNoteFor(
        source.exerciseId === payload.exerciseId ? source : {},
        priorTemplate,
      );
      const templateWrite =
        payload.remember && payload.template
          ? { template: withSetupNote(payload.template, nextNote), expectedRevision: payload.templateExpectedRevision }
          : undefined;
      const r = await commitPaired((fresh) => {
        const freshSource = fresh.exercises.find((e) => e.id === exId);
        if (!freshSource) throw new Error('这个动作已经不在本次训练里了');
        const applied = applyTargetToSessionExercise(fresh, exId, payload.target, { confirmImpact: true });
        if (!applied.applied) throw new Error(applied.message);
        const appliedExercise = applied.session.exercises.find((e) => e.id === exId);
        if (!appliedExercise) throw new Error('这个动作已经不在本次训练里了');
        const identity = assessExerciseIdentityChange(freshSource, payload.exerciseId, payload.name);
        const nextExercise: SessionExercise = {
          ...appliedExercise,
          name: payload.name,
          ...(payload.en !== undefined ? { en: payload.en } : {}),
          restSec: payload.restSec,
          ...(identity.changed
            ? { exerciseId: payload.exerciseId, planExerciseId: null, replacedFrom: freshSource.name }
            : {}),
        };
        if (identity.changed && payload.en === undefined) {
          delete nextExercise.en;
        }
        return {
          ...applied.session,
          exercises: applied.session.exercises.map((e) => (e.id === exId ? withSetupNote(nextExercise, nextNote) : e)),
        };
      }, templateWrite);
      if (r.status === 'saved') {
        if (!payload.remember) {
          pushToast(`已保存本次调整（「${payload.name}」）`);
        } else if (payload.templateExpectedRevision === null) {
          pushToast(`已保存「${payload.name}」，并设为此动作的默认配置`);
        } else {
          pushToast(`已保存，并更新此动作的默认配置（「${payload.name}」）`);
        }
        return { ok: true };
      }
      const errMsg = r.status === 'failed' ? r.message : '版本冲突或记录已变化';
      pushToast(`保存没有成功：${errMsg}。草稿已保留。`, 'error');
      return { ok: false, message: `${errMsg}，草稿已保留` };
    },
    [commitPaired, latestRef, pushToast, templatesById],
  );

  const handleEditorSubmit = useCallback(
    async (payload: ExerciseEditorSubmitValue): Promise<{ ok: boolean; message?: string }> => {
      if (!editorState) return { ok: false, message: '编辑器状态已失效' };
      if (editorState.mode === 'add') {
        const existing = addCommitRef.current;
        const tpl = exerciseTemplateFromConfig({
          exerciseId: payload.exerciseId,
          name: payload.name,
          ...(payload.en !== undefined ? { en: payload.en } : {}),
          target: payload.target,
          restSec: payload.restSec,
          setupNote: templatesById.get(payload.exerciseId)?.setupNote,
        });
        const built = sessionExerciseFromTemplate(tpl);
        const entry = {
          sessionId,
          exercise: existing && existing.sessionId === sessionId ? { ...built, id: existing.exercise.id } : built,
        };
        addCommitRef.current = entry;
        const result = await commitAddExercise(entry, payload);
        if (result.ok) addInFlightRef.current = null;
        return result;
      }
      const exId = editorState.exId;
      if (!exId) return { ok: false, message: '找不到编辑对象' };
      const latest = latestRef.current;
      const source = latest?.exercises.find((e) => e.id === exId);
      if (!latest || !source) return { ok: false, message: '这个动作已经不在本次训练里了' };
      const impact = planTargetApply(source, payload.target);
      const identity = assessExerciseIdentityChange(source, payload.exerciseId, payload.name);
      if (impact.needsConfirmation || (identity.changed && identity.hasActual)) {
        const lines = [...impact.messages];
        if (identity.changed) lines.push(identity.message);
        setEditorConfirm({
          payload,
          exId,
          title: '确认修改影响',
          body: lines.join('\n') || '本次修改会影响已有记录，确认继续？',
        });
        return { ok: false, message: '请先确认影响后再保存' };
      }
      return commitEditPayload(payload, exId);
    },
    [commitAddExercise, commitEditPayload, editorState, latestRef, sessionId, templatesById],
  );

  /**
   * Wave 1C.2：「上次表现」缓存。
   * 仅当已完成历史集合发生变化（引用或长度改变）时重新聚合；
   * 活动训练内的逐组步进编辑不会触发全量历史重扫，也不会产生新对象引用导致兄弟卡重渲染。
   */
  const lastPerfCacheRef = useRef<{
    sessionId: string;
    completedList: Session[];
    byKey: Map<string, LastPerformanceSummary>;
    byExerciseId: Map<string, LastPerformanceSummary>;
    latestExByKey: Map<string, SessionExercise>;
  } | null>(null);

  const lastPerfIndex = useMemo(() => {
    const finished = sessions.filter(
      (s) => s.status === 'completed' && s.id !== sessionId && Boolean(s.endedAt),
    );
    const prev = lastPerfCacheRef.current;
    if (
      prev &&
      prev.sessionId === sessionId &&
      prev.completedList.length === finished.length &&
      prev.completedList.every((item, idx) => item === finished[idx])
    ) {
      return prev;
    }
    const sorted = [...finished].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const singleMovementIds = collectSingleMovementIds(finished);
    const byKey = new Map<string, LastPerformanceSummary>();
    const byExerciseId = new Map<string, LastPerformanceSummary>();
    const latestExByKey = new Map<string, SessionExercise>();
    for (const s of sorted) {
      const groups = new Map<
        string,
        { exerciseId: string; mode: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis }; ex: SessionExercise }
      >();
      for (const ex of s.exercises) {
        const key = comparabilityOf(ex);
        if (byKey.has(key) || groups.has(key)) continue;
        const { eligibleSets } = filterComparableSetsForExercise(ex, {
          hasSingleStraightHistory: singleMovementIds.has(ex.exerciseId ?? ex.name),
        });
        const doneSets = eligibleSets.filter((st) => st.status === 'done' && hasReps(st));
        if (!doneSets.length) continue;
        groups.set(key, { exerciseId: ex.exerciseId ?? ex.name, mode: modeOf(ex), ex });
        if (!latestExByKey.has(key)) {
          latestExByKey.set(key, ex);
        }
      }
      for (const [key, g] of groups) {
        const perf = collectMovementFragments(s, g.exerciseId, g.mode, {
          hasSingleStraightHistory: singleMovementIds.has(g.exerciseId),
        });
        if (!perf) continue;
        const entry: LastPerformanceSummary = {
          date: s.endedAt ?? s.startedAt,
          summary: describeMovementPerformance(perf),
          label: describeMode(g.ex),
        };
        byKey.set(key, entry);
        if (!byExerciseId.has(g.exerciseId)) {
          byExerciseId.set(g.exerciseId, entry);
        }
      }
    }
    const built = { sessionId, completedList: finished, byKey, byExerciseId, latestExByKey };
    lastPerfCacheRef.current = built;
    return built;
  }, [sessions, sessionId]);

  /* ── F10：补位（FLIP）与生命周期清理 ───────────────────────── */
  useLayoutEffect(() => {
    const pending = pendingReflowRef.current;
    if (!pending) return;
    const verdict = dissolveAttribution({
      pending,
      epoch: dissolveEpochRef.current,
      session,
    });
    if (verdict === 'wait') return;
    if (verdict === 'reject' || !canPlayDissolve(pending.epoch)) {
      disarmReflowPending();
      return;
    }
    const cleanup = applyReflowAnimation(pending.tops);
    disarmReflowPending();
    if (!cleanup) return;
    cancelReflow();
    reflowCleanupRef.current = cleanup;
  }, [session, canPlayDissolve, cancelReflow, disarmReflowPending]);

  useEffect(() => {
    dissolveEpochRef.current += 1;
    resetDissolve();
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') invalidateFeedback();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      dissolveEpochRef.current += 1;
      resetDissolve();
      dissolvePlayedRef.current.clear();
    };
  }, [sessionId, resetDissolve, invalidateFeedback]);

  /* ── F11：删除成功音/准备触感的页面归属与开关 ───────────────── */
  useEffect(() => {
    bindDeleteFeedback(sessionId);
    return () => invalidateDeleteFeedback('session-unbind');
  }, [sessionId]);

  const soundEnabled = settings.soundEnabled !== false;
  useEffect(() => {
    setDeleteFeedbackEnabled(soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    if (lockBlocked) invalidateFeedback();
  }, [lockBlocked, invalidateFeedback]);

  useEffect(() => {
    if (!session || defaultExpandedApplied.current) return;
    if (!session.exercises.length) return;
    const first = session.exercises.find(
      (e) => e.status !== 'skipped' && exerciseCompletion(e) !== 'done',
    );
    setExpandedId((first ?? session.exercises[0]).id);
    defaultExpandedApplied.current = true;
  }, [session]);

  if (!session) {
    if (!historyHydrated) {
      return (
        <main className="page page-top">
          <div className="empty" style={{ marginTop: 32 }}>
            <h2 className="empty-title">正在读取训练记录…</h2>
          </div>
        </main>
      );
    }
    return (
      <main className="page page-top">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">?</div>
          <h2 className="empty-title">找不到这次训练</h2>
          <p className="empty-body">可能已经被结束或删除。回到首页看看当前状态。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/')}>
            回首页
          </button>
        </div>
      </main>
    );
  }

  if (session.status !== 'active') {
    return (
      <main className="page page-top page-bottom-space">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">END</div>
          <h2 className="empty-title">这次训练已结束</h2>
          <p className="empty-body">可以去历史里查看或纠正数据。</p>
          <button
            className="btn btn-primary"
            style={{ marginTop: 16 }}
            onClick={() => navigate(`/history/${session.id}`)}
          >
            查看详情
          </button>
        </div>
      </main>
    );
  }

  const planForCycle = plans.find((p) => p.id === session.planId);
  const isCurrentCycleDay =
    !!planForCycle && planForCycle.days[planForCycle.cursor]?.id === session.day.dayId;
  const effectiveAdvance = advanceCycleTouched ? advanceCycle : isCurrentCycleDay;
  const planSyncDiff = diffSessionVsPlanDay(session, planForCycle);

  const summary = summarizeSession(session);
  const sessionCardio = session.cardio ?? [];
  const toolsEx = session.exercises.find((e) => e.id === toolsFor);
  const setupExercise = session.exercises.find((exercise) => exercise.id === setupNoteForId);

  async function finish() {
    if (!session) return;
    if (session.status !== 'active') return;
    if (finishGuard.current) return;
    finishGuard.current = true;
    setFinishing(true);
    try {
      sealPendingWrites();
      await saveQueue.current;
      if (hasPendingDraft || unsavedDraftRef.current !== null || hasNonEmptyRawDraft()) {
        finishGuard.current = false;
        pushToast('仍有未确认或未落盘的输入草稿，请先完成确认或恢复后再结束训练', 'error');
        return;
      }

      const activeSnapshot = latestRef.current ?? session;
      const ended: Session = {
        ...activeSnapshot,
        revision: confirmedRevision.current,
        status: 'completed',
        endedAt: Date.now(),
        advancedCycle: effectiveAdvance,
      };
      const shouldSyncPlan = Boolean(planSyncDiff.eligible && syncBackToPlanDay);

      const result = await finishTrainingSession(ended, {
        editorId: editorId.current,
        expectedRevision: confirmedRevision.current,
        advanceCycle: effectiveAdvance,
        syncBackToPlanDay: shouldSyncPlan,
        lockPolicy: 'required',
      });

      if (!result.ok) {
        finishGuard.current = false;
        if (
          result.reason === 'lock-lost' ||
          result.reason === 'no-lock' ||
          result.reason === 'corrupt-lock'
        ) {
          setLockBlocked(true);
          setLockLostReason(result.message);
        }
        pushToast(`${result.message}（可以重试）`, 'error');
        return;
      }

      timer.stop();
      intentionallyClosed.current = true;
      confirmedRevision.current = result.revision;
      await refreshSessions();
      await refreshPlans();
      if (shouldSyncPlan) {
        pushToast(`训练已结束，并已将动作编排更新回「${planSyncDiff.dayName}」`, 'ok');
      }
      setSummaryOpen(false);
      markPendingFinishReceipt(activeSnapshot.id);
      navigate(`/history/${activeSnapshot.id}`, true);
    } catch (err) {
      finishGuard.current = false;
      pushToast(err instanceof Error ? `结束失败：${err.message}，可重试` : '结束失败，可重试', 'error');
    } finally {
      setFinishing(false);
    }
  }

  async function requestLeave(_source: string) {
    const outcome = await handleBackIntent({ handleCoach: false });
    if (outcome.action === 'exit') {
      navigate('/', true);
    }
  }

  async function discard() {
    if (!session) return;
    sealPendingWrites();
    await saveQueue.current.catch(() => undefined);
    const activeSnapshot = latestRef.current ?? session;
    const ended: Session = {
      ...activeSnapshot,
      revision: confirmedRevision.current,
      status: 'discarded',
      endedAt: Date.now(),
    };
    try {
      const r = await discardTrainingSession(ended, {
        editorId: editorId.current,
        expectedRevision: confirmedRevision.current,
      });
      if (!r.ok) {
        if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
          setLockBlocked(true);
          setLockLostReason(r.message);
        }
        pushToast(r.message, 'error');
        return;
      }
      timer.stop();
      intentionallyClosed.current = true;
      confirmedRevision.current = r.revision;
      await refreshSessions();
      setDiscardOpen(false);
      navigate('/', true);
    } catch (err) {
      pushToast(err instanceof Error ? `放弃失败：${err.message}` : '放弃失败', 'error');
    }
  }

  return (
    <main
      className="page page-top"
      style={{ paddingBottom: 'calc(32px + var(--safe-bottom) + var(--kb-inset, 0px))' }}
    >
      <RestTimerBar timer={timer} />

      <SessionHeader
        session={session}
        summary={summary}
        saveState={saveState}
        lockBlocked={lockBlocked}
        lockLostReason={lockLostReason}
        hasPendingDraft={hasPendingDraft}
        draftConflicts={draftConflicts}
        conflictMessage={conflictMessage}
        inputPaused={inputPaused}
        isCommittedBusy={isCommittedBusy}
        busyOwner={busyOwner}
        onBack={() => void requestLeave('header-back')}
        onRequestOpenSummary={requestOpenSummary}
        onTakeOver={() => void tryTakeOver()}
        onRetryUnsaved={() => void retryUnsaved()}
        onDiscardPendingDraft={discardPendingDraft}
        onRefreshSessions={() => void refreshSessions()}
        onClearConflictAndRefresh={() => {
          setConflictMessage(null);
          void refreshSessions();
        }}
      />

      <SessionWarmupSection
        warmups={session.warmups}
        inputPaused={inputPaused}
        applyChange={applyChange}
      />

      <div style={{ marginTop: 6, position: 'relative' }} data-reorder-zone="strength">
        <DeleteDissolveLayer ghosts={dissolveGhosts.filter((g) => g.kind === 'exercise')} />
        {session.exercises.map((ex, i) => (
          <div key={ex.id}>
            <SessionExerciseCard
              ex={ex}
              index={i}
              expanded={expandedId === ex.id}
              historyHydrated={historyHydrated}
              onToggle={handleToggleExercise}
              lastPerformance={
                lastPerfIndex.byKey.get(comparabilityOf(ex)) ??
                (ex.exerciseId ? lastPerfIndex.byExerciseId.get(ex.exerciseId) : undefined) ??
                null
              }
              progressionHint={evaluateProgressionHint(
                ex,
                lastPerfIndex.latestExByKey.get(comparabilityOf(ex)),
              )}
              setupNote={setupNoteFor(ex, templatesById.get(ex.exerciseId))}
              onEditSetupNote={openSetupNote}
              onOpenPlateCalc={handleOpenPlateCalc}
              apply={applyChange}
              latestRef={latestRef}
              timer={timer}
              onOpenTools={handleOpenTools}
              onEditExercise={openEditEditor}
              onDeleteExercise={requestDeleteItem}
              checkDeleteRequiresConfirm={checkDeleteRequiresConfirm}
              onRequestRemoveRound={handleRequestRemoveRound}
              pushToast={pushToast}
              recordingPaused={inputPaused}
              onRawRisk={registerRawRisk}
              onRawDraft={registerRawDraft}
              rawDraftFor={getRawDraft}
              rawDraftVersion={rawDraftVersions[ex.id] ?? 0}
              rawResetToken={rawResetEpochs[ex.id] ?? 0}
              hasRawRisk={hasRawRisk(ex.id)}
              hasBlockingRawRisk={hasNonEmptyRawDraft(ex.id)}
              onClearRawFields={clearRawFields}
              onDiscardRawDraft={discardRawDrafts}
              reorderIds={strengthIds}
              drag={dragSnapshot && dragSnapshot.kind === 'strength' ? dragSnapshot : null}
              onReorderCommit={handleReorderStrength}
              onRenderCard={onRenderCard}
            />
          </div>
        ))}
      </div>

      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">有氧</h2>
          {sessionCardio.length ? (
            <span className="mono-label" style={{ fontSize: 11 }}>
              共 {fmtDuration(summary.cardioMs)}
            </span>
          ) : (
            <span className="mono-label" style={{ fontSize: 11 }}>
              可选
            </span>
          )}
        </div>

        <div style={{ position: 'relative' }} data-reorder-zone="cardio">
          <DeleteDissolveLayer ghosts={dissolveGhosts.filter((g) => g.kind === 'cardio')} />
          {sessionCardio.map((entry, i) => (
            <SwipeActionCard
              key={entry.id}
              testId={`cardio-card-${entry.id}`}
              reorderId={entry.id}
              reorderKind="cardio"
              reorderIndex={i}
              reorderIds={cardioIds}
              drag={dragSnapshot && dragSnapshot.kind === 'cardio' ? dragSnapshot : null}
              onReorderCommit={handleReorderCardio}
              onDelete={() => requestDeleteItem(entry.id)}
              deleteRequiresConfirm={() => checkDeleteRequiresConfirm(entry.id)}
              disabled={inputPaused}
            >
              <CardioPanel
                entry={entry}
                disabled={inputPaused}
                pushToast={pushToast}
                registerFlush={registerCardioFlush}
                registerRawSignature={(getter) => {
                  const map = cardioRawSignatureGettersRef.current;
                  if (getter) map.set(entry.id, getter);
                  else map.delete(entry.id);
                }}
                apply={(fn) =>
                  applyChange((prev) => {
                    const cur = (prev.cardio ?? []).find((c) => c.id === entry.id);
                    if (!cur) return prev;
                    return fn(cur, prev) ?? prev;
                  })
                }
              />
            </SwipeActionCard>
          ))}
        </div>

        {!sessionCardio.length ? (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.65, marginTop: 6 }}>
            需要追加有氧时可以在这里添加（与力量同一条历史）。有氧从 00:00 正计时，没有目标时长。
          </p>
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {CARDIO_PRESET_CHOICES.map((p) => (
            <button
              key={p.preset}
              className="btn btn-ghost btn-sm"
              disabled={inputPaused || sessionCardio.length >= MAX_CARDIO_ENTRIES}
              onClick={async () => {
                const issues = validateCardioParams(p.preset, p.params);
                if (issues.length) {
                  pushToast(issues[0].message, 'error');
                  return;
                }
                const entry = createCardioEntry({
                  preset: p.preset,
                  name: p.label,
                  params: p.params,
                });
                const outcome = applyChange((prev) => addCardioToSession(prev, entry) ?? prev);
                if (outcome === 'not-executed') return;
                const res = await outcome;
                if (res.status === 'saved') pushToast(`已添加「${p.label}」`);
                else pushToast(`添加「${p.label}」没有保存成功，请重试。`, 'error');
              }}
            >
              + {p.label}
            </button>
          ))}
        </div>
      </section>

      <UndoStack
        items={deleteUndoStackItems}
        undoneCount={deleteUndoneCount}
        busy={deleteBusy}
        onUndo={(token) => void undoDeleteEntry(token)}
      />

      {addFailed ? (
        <div
          data-testid="add-retry-bar"
          style={{
            marginTop: 12,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            borderLeft: '3px solid var(--brick)',
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, flex: 1, minWidth: 180 }}>
            「{addFailed.entry.exercise.name}」还没有保存成功；配置已保留，可重试。
          </span>
          <button
            className="btn btn-sm btn-primary"
            data-testid="add-retry"
            disabled={addRetryBusy}
            aria-busy={addRetryBusy}
            onClick={() => {
              if (addRetryBusy) return;
              setAddRetryBusy(true);
              void commitAddExercise(addFailed.entry, addFailed.payload).finally(() =>
                setAddRetryBusy(false),
              );
            }}
          >
            {addRetryBusy ? '重试中…' : '重试添加'}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            data-testid="add-retry-discard"
            onClick={() => {
              setAddFailed(null);
              addCommitRef.current = null;
            }}
          >
            放弃
          </button>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => {
            if (inputPaused) {
              pausedNotice();
              return;
            }
            setAddNameOpen(true);
          }}
          disabled={inputPaused}
        >
          + 临时加动作
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: 1, color: 'var(--brick)' }}
          onClick={() => setDiscardOpen(true)}
        >
          放弃训练
        </button>
      </div>

      <div style={{ marginTop: 18 }}>
        <button
          className="btn btn-primary btn-lg"
          onClick={requestOpenSummary}
          disabled={lockBlocked || finishing}
        >
          {lockBlocked
            ? '本页只读 · 请在原标签页继续'
            : finishing
              ? '正在结束…'
              : `结束训练 · ${summary.completedSets} 组`}
        </button>
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: 'var(--ink-4)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          每次修改都会立即保存到本机。未填写的组不会计入完成组。
        </p>
      </div>

      <Sheet open={!!toolsEx} title={toolsEx ? toolsEx.name : ''} onClose={() => setToolsFor(null)}>
        {toolsEx ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { openSetupNote(toolsEx.id); setToolsFor(null); }}>
              器械档位
            </button>
            {toolsEx.target.weightMode === 'external' ? (
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="tools-open-plate-calc"
                style={{ width: '100%' }}
                onClick={() => {
                  const firstFilled = toolsEx.sets.find((s) => s.weightKg !== null)?.weightKg ?? null;
                  const suggested =
                    toolsEx.target.kind === 'straight' ? toolsEx.target.suggestedWeightKg : null;
                  handleOpenPlateCalc(toolsEx.id, firstFilled ?? suggested);
                  setToolsFor(null);
                }}
              >
                杠铃配片速算
              </button>
            ) : null}
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                applyChange((prev) => {
                  const cur = prev.exercises.find((e) => e.id === toolsEx.id);
                  const canUnskip = cur ? hasSkippedGroupsToUnskip(cur) : false;
                  return canUnskip ? unskipExercise(prev, toolsEx.id) : skipRemaining(prev, toolsEx.id);
                });
                setToolsFor(null);
              }}
            >
              {hasSkippedGroupsToUnskip(toolsEx) ? '取消跳过剩余组' : '跳过剩余组'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                applyChange((prev) => withExercise(prev, toolsEx.id, { status: 'pending' }));
                setToolsFor(null);
              }}
            >
              重置为未完成
            </button>
            <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '4px 0 0' }}>
              这里的改动只影响本次训练，不会改计划。需要长期修改请到「计划」页。
            </p>
          </div>
        ) : null}
      </Sheet>

      <SessionFinishSheet
        open={summaryOpen}
        session={session}
        summary={summary}
        effectiveAdvance={effectiveAdvance}
        isCurrentCycleDay={isCurrentCycleDay}
        finishing={finishing}
        planSyncDiff={planSyncDiff}
        syncBackToPlanDay={syncBackToPlanDay}
        onSyncBackToPlanDayChange={setSyncBackToPlanDay}
        onClose={() => setSummaryOpen(false)}
        onAdvanceChange={(checked) => {
          setAdvanceCycleTouched(true);
          setAdvanceCycle(checked);
        }}
        onConfirmFinish={() => void finish()}
        applyChange={applyChange}
      />

      {setupExercise && <SessionSetupNote key={setupExercise.id} exercise={setupExercise} memory={templatesById.get(setupExercise.exerciseId)}
        blocked={inputPaused} templateError={exerciseTemplateError} commit={commitPaired}
        onClose={closeSetupNote} />}
      <PlateCalculatorSheet
        open={plateCalcState !== null}
        initialWeightKg={plateCalcState?.weightKg ?? null}
        exerciseName={plateCalcState?.exerciseName}
        onClose={() => setPlateCalcState(null)}
        onApplyWeight={
          plateCalcState?.setId && !inputPaused
            ? (w) => {
                const { exId, setId } = plateCalcState;
                if (!setId) return;
                const hasNonEmptyDraft = (otherId: string) => { const r = getRawDraft(exId, `${otherId}:weight`); return r !== undefined && r !== ''; };
                const curEx = latestRef.current?.exercises.find((e) => e.id === exId);
                clearRawFields(exId, collectPrefillWeightFieldIds(curEx, setId, w, true, hasNonEmptyDraft));
                applyChange((prev) => withSetAndPrefillFollowingWeight(prev, exId, setId, { weightKg: w }, hasNonEmptyDraft));
              }
            : undefined
        }
      />

      <Confirm
        open={confirmRemoveRoundOpen}
        title="删除这一轮？"
        body="这一轮已经记录了数据。删除后该轮的重量与次数会一并移除，且不会计入统计。"
        confirmText="删除这一轮"
        danger
        onCancel={() => {
          setConfirmRemoveRoundOpen(false);
          pendingRemoveRound.current = null;
        }}
        onConfirm={() => {
          const id = pendingRemoveRound.current;
          if (id) applyChange((prev) => removeLastRound(prev, id));
          setConfirmRemoveRoundOpen(false);
          pendingRemoveRound.current = null;
        }}
      />

      <ExerciseNamePicker
        open={addNameOpen}
        templates={exerciseTemplates}
        onSelect={handleAddName}
        onClose={() => setAddNameOpen(false)}
      />

      {editorState ? (
        <ExerciseEditor
          key={editorState.key}
          open
          mode={editorState.mode}
          initial={editorState.initial}
          templates={exerciseTemplates}
          templateError={exerciseTemplateError}
          onSubmit={handleEditorSubmit}
          onDirtyChange={(dirty) => {
            editorDirtyRef.current = dirty;
          }}
          onClose={(reason) => {
            const closing = editorState;
            if (closing?.mode === 'add' && reason !== 'saved') {
              const closingId = addCommitRef.current?.exercise.id;
              if (closingId) discardedAddIds.current.add(closingId);
              setAddFailed((prev) =>
                prev && closingId && prev.entry.exercise.id === closingId ? null : prev,
              );
            }
            editorDirtyRef.current = false;
            setEditorState(null);
            addCommitRef.current = null;
            addInFlightRef.current = null;
          }}
        />
      ) : null}

      <Confirm
        open={editorConfirm !== null}
        title={editorConfirm?.title ?? '确认修改影响'}
        body={editorConfirm?.body ?? ''}
        confirmText="确认并保存"
        danger={Boolean(editorConfirm?.body.includes('删除'))}
        onCancel={() => setEditorConfirm(null)}
        onConfirm={() => {
          const pending = editorConfirm;
          const ownerKey = editorStateRef.current?.key ?? null;
          const ownerExId = pending?.exId ?? null;
          setEditorConfirm(null);
          if (!pending) return;
          void commitEditPayload(pending.payload, pending.exId).then((r) => {
            const live = editorStateRef.current;
            if (r.ok) {
              if (live && ownerKey !== null && live.key === ownerKey && live.exId === ownerExId) {
                setEditorState(null);
                addCommitRef.current = null;
                addInFlightRef.current = null;
              }
            } else if (live && (ownerKey === null || live.key === ownerKey)) {
              pushToast(r.message ?? '保存失败', 'error');
            }
          });
        }}
      />

      <Confirm
        open={deletePreview !== null}
        title="删除这个项目？"
        body={
          deletePreview
            ? `将删除「${deletePreview.name}」。${deletePreview.reasons.join('；')}。确认后才能删除，取消会完整保留。`
            : ''
        }
        confirmText="确认删除"
        danger
        busy={deleteBusy}
        onCancel={() => setDeletePreview(null)}
        onConfirm={confirmDeletePreview}
      />

      <Confirm
        open={discardOpen}
        title="放弃这次训练？"
        body={
          hasAnyData(session)
            ? '已记录的内容会被丢弃，且不会出现在历史里。这个操作不能撤销。'
            : '这次训练还没有记录任何内容，放弃不会影响历史。'
        }
        confirmText="放弃训练"
        danger
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => void discard()}
      />
    </main>
  );
}
