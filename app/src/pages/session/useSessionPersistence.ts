/* 训练执行页的编辑锁、前后台生命周期、跨实例救援与保存队列（Wave 1C.1 拆分 + Wave 1C.2 连续普通写合并）。
   ── 核心不变量（原封保留 V3-01 / V5-01 / V6-01 / V8-LC08 / A05 / A06 / G2B-FIX1-R2）──
   · 单活动训练编辑锁：挂载经 takeOwnershipOnMount 原子接手旧实例或获取新锁，8s 心跳续租，
     hidden 先排空队列再释放锁，visible 重新对齐最新记录与锁；
   · 普通输入先捕获真实意图基线（captureOrdinaryChange），队列内未开始执行的连续普通写合并为单笔落库
     （CoalescedOrdinarySlot），遇到 paired / 显式版本重试 / 终态提交立即封口保序；
   · 失败/异常路径同步发布跨实例救援草稿（publishRescueDraft），绝不静默丢失用户输入。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { getSession } from '../../db/repo';
import { revisionOf, type WriteResult } from '../../db/tx';
import {
  accumulateDraftIntent,
  mergeDraftOntoFresh,
  type PendingDraft,
  type PersistOutcome,
} from '../../domain/draftMerge';
import type { ExerciseTemplate, Session } from '../../domain/types';
import { AppLifecycleCoordinator } from '../../lib/appLifecycle';
import {
  ackRescueDraft,
  clearRescueDraft,
  loadRescueDraft,
  loadRescueRecord,
  publishRescueDraft,
  republishRebasedDraft,
  watchRescueDraft,
  type RescueRecord,
} from '../../lib/draftRescue';
import {
  acquireSessionLockDetailed,
  listenLockEvents,
  makeEditorId,
  refreshSessionLockDetailed,
  releaseSessionLock,
  takeOverSessionLock,
  takeOwnershipOnMount,
} from '../../lib/lock';
import { registerPageLeaveGuard } from '../../lib/nativeBack';
import { commitPairedSession, type PairedOutcome } from '../../lib/pairedCommit';
import {
  captureOrdinaryChange,
  decideQueuedSessionWrite,
  pendingDraftFromIntent,
  sealOrdinarySlot,
  settleOrdinarySlot,
  type CoalescedOrdinarySlot,
} from '../../lib/sessionWrite';
import type { SaveArgs, Toast } from '../../store';

/** 草稿身份生成器（V6-01）：单调递增，进程内唯一 */
let draftTokenSeq = 0;
const nextDraftToken = () => {
  draftTokenSeq += 1;
  return draftTokenSeq;
};

export interface UseSessionPersistenceParams {
  sessionId: string;
  session: Session | undefined;
  editorDirtyRef: MutableRefObject<boolean>;
  syncSessionLocal: (next: Session) => void;
  saveActiveSession: (next: Session, args: SaveArgs) => Promise<WriteResult>;
  saveActiveSessionWithTemplate: (
    next: Session,
    args: SaveArgs,
    template: ExerciseTemplate,
    templateExpectedRevision: number | null,
  ) => Promise<WriteResult>;
  refreshSessions: () => Promise<void>;
  pushToast: (text: string, kind?: Toast['kind']) => void;
}

export function useSessionPersistence({
  sessionId,
  session,
  editorDirtyRef,
  syncSessionLocal,
  saveActiveSession,
  saveActiveSessionWithTemplate,
  refreshSessions,
  pushToast,
}: UseSessionPersistenceParams) {
  const [lockBlocked, setLockBlocked] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const editorId = useRef(makeEditorId());
  const confirmedRevision = useRef<number>(revisionOf(session));
  const [lockLostReason, setLockLostReason] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const busyOwnerRef = useRef<'retry' | 'takeover' | null>(null);
  const [busyOwner, setBusyOwner] = useState<'retry' | 'takeover' | null>(null);

  const beginBusy = useCallback(
    (owner: 'retry' | 'takeover'): boolean => {
      if (busyOwnerRef.current !== null) {
        pushToast(
          busyOwnerRef.current === 'takeover'
            ? '正在接管并保存刚才的改动，请稍候。'
            : '正在保存刚才的改动，请稍候。',
        );
        return false;
      }
      busyOwnerRef.current = owner;
      setBusyOwner(owner);
      return true;
    },
    [pushToast],
  );

  const endBusy = useCallback((owner: 'retry' | 'takeover') => {
    if (busyOwnerRef.current === owner) {
      busyOwnerRef.current = null;
      setBusyOwner(null);
    }
  }, []);

  const isCommittedBusy = busyOwner !== null;
  const intentionallyClosed = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingOrdinarySlotRef = useRef<CoalescedOrdinarySlot | null>(null);

  /** 始终指向最新 session，供「先判断再修改」的操作读取 */
  const latestRef = useRef<Session | undefined>(session);
  latestRef.current = session;

  const unsavedDraft = useRef<PendingDraft | null>(null);
  const rescuedSeqRef = useRef<number | null>(null);
  const ownPriorCommitRef = useRef<{ revision: number; intent: Session } | null>(null);
  const ownPublishedSeq = useRef(0);
  const lockBlockedRef = useRef(false);
  lockBlockedRef.current = lockBlocked;
  const baseSessionRef = useRef<Session | null>(session ?? null);
  const [draftConflicts, setDraftConflicts] = useState<Array<{ path: string; message: string }> | null>(null);
  const [hasPendingDraft, setHasPendingDraft] = useState(false);
  const lifecycle = useRef(new AppLifecycleCoordinator());
  const viewBeforeRef = useRef<Session | null>(null);

  const rescueApplied = useRef(false);
  const adoptedRescueSeq = useRef(0);
  const pendingFromRescue = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const coordinator = lifecycle.current;
    let hidden = !coordinator.isForeground;

    const acquireOnMount = async () => {
      const r = await takeOwnershipOnMount({ sessionId, editorId: editorId.current });
      if (cancelled) return;
      if (!r.ok) {
        setLockBlocked(true);
        setLockLostReason(r.message ?? '这个训练正在另一个标签页中编辑');
      }
    };
    void acquireOnMount();

    const unlisten = listenLockEvents((e) => {
      if (e.sessionId === sessionId && e.type === 'lock' && e.editorId !== editorId.current) {
        setLockBlocked(true);
        setLockLostReason('这个训练已在另一个标签页中接管');
      }
    });

    const heartbeat = window.setInterval(() => {
      if (intentionallyClosed.current || hidden) return;
      void refreshSessionLockDetailed(sessionId, editorId.current).then((r) => {
        if (cancelled || intentionallyClosed.current || hidden) return;
        if (!r.ok) {
          setLockBlocked(true);
          setLockLostReason(r.message ?? '编辑锁已失效');
        }
      });
    }, 8000);

    const doHide = async (isStale: () => boolean): Promise<void> => {
      hidden = true;
      if (intentionallyClosed.current) return;
      await saveQueue.current.catch(() => undefined);
      if (isStale() || cancelled || intentionallyClosed.current) return;
      await releaseSessionLock(sessionId, editorId.current).catch(() => undefined);
    };

    const doShow = async (isStale: () => boolean) => {
      hidden = false;
      if (cancelled || intentionallyClosed.current) return;

      try {
        await refreshSessions();
        const fresh = await getSession(sessionId);
        if (cancelled || isStale()) return;
        if (fresh) {
          confirmedRevision.current = revisionOf(fresh);
          baseSessionRef.current = fresh;
          latestRef.current = fresh;
          syncSessionLocal(fresh);
        }
      } catch {
        /* 读不到就沿用内存快照；下面按锁状态决定是否可写 */
      }
      if (isStale()) return;

      const r = await acquireSessionLockDetailed(sessionId, editorId.current);
      if (cancelled || isStale()) return;
      if (r.ok) {
        setLockBlocked(false);
        setLockLostReason(null);
        setSaveState((st) => (st === 'error' ? 'idle' : st));
        return;
      }
      setLockBlocked(true);
      setLockLostReason(
        r.reason === 'held-by-other'
          ? '这个训练正在另一个标签页中编辑。回到本页后仍是只读；需要在此继续请点「接管继续编辑」。'
          : (r.message ?? '回到本页后没能取得编辑锁'),
      );
    };

    const stopListening = coordinator.start({ onHide: doHide, onShow: doShow });

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      unlisten();
      stopListening();
      void (async () => {
        await saveQueue.current.catch(() => undefined);
        await releaseSessionLock(sessionId, editorId.current).catch(() => undefined);
      })();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const guard = async (): Promise<boolean> => {
      let guardLoop = 0;
      while (guardLoop < 50) {
        guardLoop += 1;
        const pendingQueue = saveQueue.current;
        await pendingQueue.catch(() => undefined);
        if (saveQueue.current === pendingQueue) break;
      }

      if (busyOwnerRef.current !== null) {
        pushToast('正在保存刚才的改动，请稍候再返回。', 'error');
        return false;
      }

      const draft = unsavedDraft.current;
      if (draft) {
        const seq = publishRescueDraft(sessionId, draft);
        rescuedSeqRef.current = seq ?? rescuedSeqRef.current;
        if (seq !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seq);
        const rescued = seq !== null;
        if (!rescued) {
          pushToast(
            '还有改动没有写进本机，而且当前环境无法临时保存这份草稿。请先点「重试保存这次改动」或「放弃这份改动」再返回。',
            'error',
          );
          return false;
        }
        pushToast(
          '还有改动没有写进本机。已为这份草稿保留临时副本：重进这个训练会继续提示你保存；也可以直接点「重试保存这次改动」。',
          'error',
        );
        return false;
      }

      if (editorDirtyRef.current) {
        pushToast('动作编辑器还有未保存内容，请先在编辑器内保存或放弃。', 'error');
        return false;
      }

      clearRescueDraft(sessionId);
      return true;
    };

    registerPageLeaveGuard(guard);
    return () => registerPageLeaveGuard(null);
  }, [sessionId, pushToast, editorDirtyRef]);

  const adoptRescueRecord = useCallback(
    (record: RescueRecord, source: 'mount' | 'late') => {
      if (record.seq <= adoptedRescueSeq.current) return;
      if (record.seq <= ownPublishedSeq.current) return;

      const existing = unsavedDraft.current;
      if (existing && !pendingFromRescue.current) return;

      adoptedRescueSeq.current = record.seq;
      pendingFromRescue.current = true;
      unsavedDraft.current = {
        token: record.token,
        baseRevision: record.baseRevision,
        session: record.session,
        baseSession: record.baseSession,
      };
      rescuedSeqRef.current = record.seq;
      setHasPendingDraft(true);
      setDraftConflicts(null);

      pushToast(
        source === 'late'
          ? '上次离开时那份没保存的改动刚刚被找回来了（已更新到最新内容），已恢复到本页；可以重试保存或明确放弃。'
          : '重进时发现上次离开前还有未保存的改动，已恢复到本页；可以重试保存或明确放弃。',
        'error',
      );
    },
    [pushToast],
  );

  useEffect(() => {
    if (rescueApplied.current) return;
    rescueApplied.current = true;

    const immediate = loadRescueDraft(sessionId);
    const immediateRecord = immediate ? loadRescueRecord(sessionId) : null;
    if (immediateRecord) adoptRescueRecord(immediateRecord, 'mount');

    const stopWatch = watchRescueDraft(sessionId, (record) => adoptRescueRecord(record, 'late'));
    return stopWatch;
  }, [sessionId, adoptRescueRecord]);

  const rememberDraft = useCallback(
    (next: Session, baseOverride?: { baseRevision: number; baseSession: Session }) => {
      const existing = unsavedDraft.current;
      if (existing) {
        const accumulated = accumulateDraftIntent(
          existing.baseSession,
          existing.session,
          viewBeforeRef.current ?? existing.session,
          next,
        );
        unsavedDraft.current = {
          ...existing,
          session: accumulated,
          baseRevision: existing.baseRevision,
          baseSession: existing.baseSession,
        };
        setHasPendingDraft(true);
        const seq = publishRescueDraft(sessionId, unsavedDraft.current);
        rescuedSeqRef.current = seq;
        if (seq !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seq);
        return;
      }
      const baseRevision = baseOverride?.baseRevision ?? confirmedRevision.current;
      const baseSession = baseOverride?.baseSession ?? baseSessionRef.current ?? next;
      unsavedDraft.current = pendingDraftFromIntent(next, baseSession, baseRevision, nextDraftToken());
      pendingFromRescue.current = false;
      setHasPendingDraft(true);
      const seqAgain = publishRescueDraft(sessionId, unsavedDraft.current);
      rescuedSeqRef.current = seqAgain;
      if (seqAgain !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seqAgain);
    },
    [sessionId],
  );

  const persist = useCallback(
    (
      next: Session,
      ctx?: {
        writable?: boolean;
        expectedRevision?: number;
        draftToken?: number;
        templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null };
        skipRescue?: boolean;
        baseSession?: Session;
        baseRevisionAtCall?: number;
        reservedSeq?: number | null;
        intentSnapshot?: Session;
      },
    ): Promise<PersistOutcome> => {
      const writable = ctx?.writable ?? !lockBlockedRef.current;
      const explicitExpected = ctx?.expectedRevision;
      const token = ctx?.draftToken ?? null;
      const reservedSeq = ctx && 'reservedSeq' in ctx ? (ctx.reservedSeq ?? null) : rescuedSeqRef.current;
      const submittedAtSeq = reservedSeq;
      const intentSnapshot: Session = ctx?.intentSnapshot ?? next;
      const baseRevisionAtCall = ctx?.baseRevisionAtCall ?? confirmedRevision.current;
      const baseSessionAtCall = ctx?.baseSession ?? next;
      const rescueBase =
        ctx?.baseSession !== undefined && ctx.baseRevisionAtCall !== undefined
          ? { baseRevision: ctx.baseRevisionAtCall, baseSession: ctx.baseSession }
          : undefined;

      // Wave 1C.2：仅对 applyChange 发出的标准普通写启用未执行写槽合并；AST 独立单测未注入 ref 时自动退化为逐笔模式
      const slotHolder =
        typeof pendingOrdinarySlotRef !== 'undefined' ? pendingOrdinarySlotRef : null;
      const canCoalesceOrdinary =
        slotHolder !== null &&
        writable &&
        ctx !== undefined &&
        ctx.baseSession !== undefined &&
        ctx.baseRevisionAtCall !== undefined &&
        ctx.expectedRevision === undefined &&
        ctx.draftToken === undefined &&
        !ctx.templateWrite &&
        !ctx.skipRescue &&
        !('reservedSeq' in ctx) &&
        ctx.intentSnapshot === undefined;

      if (!canCoalesceOrdinary && slotHolder?.current && !slotHolder.current.started) {
        slotHolder.current.sealed = true;
      }

      if (!writable) {
        if (!ctx?.skipRescue) rememberDraft(next, rescueBase);
        setSaveState('error');
        pushToast(
          '本页当前只读，这次改动还没有保存。取得编辑控制后可以重试保存；你的输入仍保留在本页。',
          'error',
        );
        return Promise.resolve({ status: 'not-attempted' as const });
      }

      setSaveState('saving');

      if (canCoalesceOrdinary && slotHolder) {
        const existingSlot = slotHolder.current;
        if (existingSlot && !existingSlot.started && !existingSlot.sealed) {
          existingSlot.latestNext = next;
          existingSlot.reservedSeq = reservedSeq;
          return new Promise<PersistOutcome>((res) => {
            existingSlot.waiters.push(res);
          });
        }
        const batchSlot: CoalescedOrdinarySlot = {
          started: false,
          sealed: false,
          baseSessionAtCall,
          baseRevisionAtCall,
          viewBeforeFirst: viewBeforeRef.current,
          latestNext: next,
          reservedSeq,
          waiters: [],
        };
        slotHolder.current = batchSlot;
        const batchOutcome = new Promise<PersistOutcome>((res) => {
          batchSlot.waiters.push(res);
        });
        const settleAll = (o: PersistOutcome) => {
          const cbs = batchSlot.waiters.splice(0, batchSlot.waiters.length);
          for (const cb of cbs) cb(o);
        };
        const rememberBatchFailure = () => {
          viewBeforeRef.current = batchSlot.viewBeforeFirst ?? batchSlot.baseSessionAtCall;
          rememberDraft(batchSlot.latestNext, {
            baseRevision: batchSlot.baseRevisionAtCall,
            baseSession: batchSlot.baseSessionAtCall,
          });
        };

        saveQueue.current = saveQueue.current
          .then(async () => {
            batchSlot.started = true;
            if (slotHolder.current === batchSlot) {
              slotHolder.current = null;
            }
            const effectiveNext = batchSlot.latestNext;
            const effectiveSeq = batchSlot.reservedSeq;
            const decision = await decideQueuedSessionWrite({
              sessionId,
              next: effectiveNext,
              explicitExpectedRevision: undefined,
              baseSessionAtCall: batchSlot.baseSessionAtCall,
              baseRevisionAtCall: batchSlot.baseRevisionAtCall,
              queueExecutionRevision: confirmedRevision.current,
              hasTemplateWrite: false,
              getSession,
              ownPriorCommit: ownPriorCommitRef.current ?? null,
            });
            if (decision.kind === 'conflict') {
              rememberBatchFailure();
              setSaveState('error');
              setConflictMessage(decision.message);
              pushToast(decision.message, 'error');
              settleAll({ status: 'failed', reason: 'version-conflict', message: decision.message });
              return;
            }
            if (decision.kind === 'storage') {
              rememberBatchFailure();
              setSaveState('error');
              pushToast(`未保存：${decision.message}`, 'error');
              settleAll({ status: 'failed', reason: 'storage', message: decision.message });
              return;
            }
            const expected = decision.expectedRevision;
            const nextToSave = decision.session;
            const saveArgs = { editorId: editorId.current, expectedRevision: expected };
            const r = await saveActiveSession({ ...nextToSave, revision: expected }, saveArgs);
            if (!r.ok) {
              const rescueNow = loadRescueRecord(sessionId);
              const newerRescue =
                rescueNow !== null && effectiveSeq !== null && rescueNow.seq > effectiveSeq;
              if (newerRescue && rescueNow) {
                unsavedDraft.current = {
                  token: rescueNow.token,
                  baseRevision: rescueNow.baseRevision,
                  session: rescueNow.session,
                  baseSession: rescueNow.baseSession,
                };
                rescuedSeqRef.current = rescueNow.seq;
                pendingFromRescue.current = true;
                setHasPendingDraft(true);
              } else {
                rememberBatchFailure();
              }
              if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
                setLockBlocked(true);
                setLockLostReason(r.message);
              }
              if (r.reason === 'state-conflict' || r.reason === 'version-conflict') {
                setConflictMessage(r.message);
              }
              setSaveState('error');
              pushToast(r.message, 'error');
              settleAll({ status: 'failed', reason: r.reason, message: r.message });
              return;
            }
            confirmedRevision.current = r.revision;
            baseSessionRef.current = r.session;
            ownPriorCommitRef.current = { revision: r.revision, intent: effectiveNext };
            if (unsavedDraft.current === null) {
              const acked = ackRescueDraft(sessionId, effectiveSeq);
              if (acked.newer) {
                const d1 = effectiveNext;
                const d2 = acked.newer;
                const rebased = mergeDraftOntoFresh(d1, d2.session, r.session, null);
                if (rebased.ok) {
                  unsavedDraft.current = {
                    token: d2.token,
                    baseRevision: r.revision,
                    baseSession: r.session,
                    session: rebased.session,
                  };
                } else {
                  unsavedDraft.current = {
                    token: d2.token,
                    baseRevision: d2.baseRevision,
                    session: d2.session,
                    baseSession: d2.baseSession,
                  };
                }
                rescuedSeqRef.current = acked.newer.seq;
                if (unsavedDraft.current) {
                  try {
                    const republished = republishRebasedDraft(
                      sessionId,
                      unsavedDraft.current,
                      acked.newer.seq,
                    );
                    if (republished !== null) {
                      rescuedSeqRef.current = republished;
                      ownPublishedSeq.current = Math.max(ownPublishedSeq.current, republished);
                      adoptedRescueSeq.current = Math.max(adoptedRescueSeq.current, republished);
                    }
                  } catch {
                    /* 写回失败不影响本页已 rebase 的正确草稿 */
                  }
                }
                pendingFromRescue.current = true;
                setHasPendingDraft(true);
              } else {
                unsavedDraft.current = null;
                rescuedSeqRef.current = null;
                pendingFromRescue.current = false;
                setHasPendingDraft(false);
                setDraftConflicts(null);
              }
            }
            syncSessionLocal(r.session);
            setSaveState('idle');
            settleAll({ status: 'saved', revision: r.revision, includedDraft: false });
          })
          .catch((err: unknown) => {
            setSaveState('error');
            rememberBatchFailure();
            pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存：本地写入失败', 'error');
            settleAll({ status: 'failed', reason: 'storage', message: '本地写入失败' });
          });
        return batchOutcome;
      }

      let settle: (o: PersistOutcome) => void = () => undefined;
      const outcome = new Promise<PersistOutcome>((res) => {
        settle = res;
      });
      saveQueue.current = saveQueue.current
        .then(async () => {
          const decision = await decideQueuedSessionWrite({
            sessionId,
            next,
            explicitExpectedRevision: explicitExpected,
            baseSessionAtCall,
            baseRevisionAtCall,
            queueExecutionRevision: confirmedRevision.current,
            hasTemplateWrite: Boolean(ctx?.templateWrite),
            getSession,
            ownPriorCommit: ownPriorCommitRef.current ?? null,
          });
          if (decision.kind === 'conflict') {
            if (!ctx?.skipRescue) rememberDraft(next, rescueBase);
            setSaveState('error');
            setConflictMessage(decision.message);
            pushToast(decision.message, 'error');
            settle({ status: 'failed', reason: 'version-conflict', message: decision.message });
            return;
          }
          if (decision.kind === 'storage') {
            if (!ctx?.skipRescue) rememberDraft(next, rescueBase);
            setSaveState('error');
            pushToast(`未保存：${decision.message}`, 'error');
            settle({ status: 'failed', reason: 'storage', message: decision.message });
            return;
          }
          const expected = decision.expectedRevision;
          const nextToSave = decision.session;
          const saveArgs = { editorId: editorId.current, expectedRevision: expected };
          const r = ctx?.templateWrite
            ? await saveActiveSessionWithTemplate(
                { ...nextToSave, revision: expected },
                saveArgs,
                ctx.templateWrite.template,
                ctx.templateWrite.expectedRevision,
              )
            : await saveActiveSession({ ...nextToSave, revision: expected }, saveArgs);
          if (!r.ok) {
            const rescueNow = loadRescueRecord(sessionId);
            const newerPending =
              unsavedDraft.current !== null && token !== null && unsavedDraft.current.token !== token;
            const newerRescue =
              rescueNow !== null && submittedAtSeq !== null && rescueNow.seq > submittedAtSeq;
            if (newerPending || newerRescue) {
              if (rescueNow) {
                unsavedDraft.current = {
                  token: rescueNow.token,
                  baseRevision: rescueNow.baseRevision,
                  session: rescueNow.session,
                  baseSession: rescueNow.baseSession,
                };
                rescuedSeqRef.current = rescueNow.seq;
                pendingFromRescue.current = true;
              }
              setHasPendingDraft(true);
            } else {
              if (!ctx?.skipRescue) rememberDraft(next, rescueBase);
            }
            if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
              setLockBlocked(true);
              setLockLostReason(r.message);
            }
            if (r.reason === 'state-conflict' || r.reason === 'version-conflict') {
              setConflictMessage(r.message);
            }
            setSaveState('error');
            pushToast(r.message, 'error');
            settle({ status: 'failed', reason: r.reason, message: r.message });
            return;
          }
          confirmedRevision.current = r.revision;
          baseSessionRef.current = r.session;
          const cur = unsavedDraft.current;
          const includedDraft = cur !== null && token !== null && cur.token === token;
          if (includedDraft || (token === null && !ctx?.templateWrite && !ctx?.skipRescue)) {
            ownPriorCommitRef.current = { revision: r.revision, intent: intentSnapshot };
          }
          if (includedDraft || (cur === null && token === null)) {
            const acked = ackRescueDraft(sessionId, submittedAtSeq);
            if (acked.newer) {
              const d1 = intentSnapshot;
              const d2 = acked.newer;
              const rebased = mergeDraftOntoFresh(d1, d2.session, r.session, null);
              if (rebased.ok) {
                unsavedDraft.current = {
                  token: d2.token,
                  baseRevision: r.revision,
                  baseSession: r.session,
                  session: rebased.session,
                };
              } else {
                unsavedDraft.current = {
                  token: d2.token,
                  baseRevision: d2.baseRevision,
                  session: d2.session,
                  baseSession: d2.baseSession,
                };
              }
              rescuedSeqRef.current = acked.newer.seq;
              if (unsavedDraft.current) {
                try {
                  const republished = republishRebasedDraft(
                    sessionId,
                    unsavedDraft.current,
                    acked.newer.seq,
                  );
                  if (republished !== null) {
                    rescuedSeqRef.current = republished;
                    ownPublishedSeq.current = Math.max(ownPublishedSeq.current, republished);
                    adoptedRescueSeq.current = Math.max(adoptedRescueSeq.current, republished);
                  }
                } catch {
                  /* 写回失败不影响主流程 */
                }
              }
              pendingFromRescue.current = true;
              setHasPendingDraft(true);
            } else {
              unsavedDraft.current = null;
              rescuedSeqRef.current = null;
              pendingFromRescue.current = false;
              setHasPendingDraft(false);
              setDraftConflicts(null);
            }
          }
          syncSessionLocal(r.session);
          setSaveState('idle');
          settle({ status: 'saved', revision: r.revision, includedDraft });
        })
        .catch((err: unknown) => {
          setSaveState('error');
          if (!ctx?.skipRescue) rememberDraft(next, rescueBase);
          pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存：本地写入失败', 'error');
          settle({ status: 'failed', reason: 'storage', message: '本地写入失败' });
        });
      return outcome;
    },
    [saveActiveSession, saveActiveSessionWithTemplate, syncSessionLocal, pushToast, rememberDraft, sessionId],
  );

  const inputPaused = hasPendingDraft || lockBlocked;
  const pausedNotice = useCallback(() => {
    if (hasPendingDraft) {
      pushToast(
        '还有改动没有写进本机。请先在下方「还有改动没有写进本机」里点「重试保存这次改动」，或明确「放弃这份改动」，然后再继续记录。',
        'error',
      );
      return;
    }
    pushToast(
      '本页当前只读（这个训练正在另一个标签页中编辑，或编辑锁已失效），暂时不能记录。请回到原标签页继续，或在这里点「接管继续编辑」取得控制。',
      'error',
    );
  }, [pushToast, hasPendingDraft]);

  const applyChange = useCallback(
    (fn: (prev: Session) => Session): Promise<PersistOutcome> | 'not-executed' => {
      if (inputPaused) {
        pausedNotice();
        return 'not-executed';
      }
      const prev = latestRef.current;
      if (!prev) return 'not-executed';
      const capturedRevision = confirmedRevision.current;
      const staged = captureOrdinaryChange(prev, capturedRevision, fn);
      if (!staged) return 'not-executed';
      viewBeforeRef.current = prev;
      latestRef.current = staged.next;
      return persist(staged.next, {
        baseSession: staged.baseSession,
        baseRevisionAtCall: staged.baseRevisionAtCall,
      });
    },
    [persist, inputPaused, pausedNotice],
  );

  const sealPendingWrites = useCallback(() => {
    sealOrdinarySlot(pendingOrdinarySlotRef.current);
  }, []);

  const commitPaired = useCallback(
    (
      buildNext: (fresh: Session) => Session,
      templateWrite?: { template: ExerciseTemplate; expectedRevision: number | null },
    ): Promise<PairedOutcome> => {
      sealOrdinarySlot(pendingOrdinarySlotRef.current);
      let settle: (o: PairedOutcome) => void = () => undefined;
      const outcome = new Promise<PairedOutcome>((res) => {
        settle = res;
      });
      saveQueue.current = saveQueue.current
        .then(async () => {
          const out = await commitPairedSession({
            sessionId,
            editorId: editorId.current,
            buildNext,
            templateWrite,
            deps: {
              getSession,
              save: async (sess, guard, tw) =>
                tw
                  ? saveActiveSessionWithTemplate(
                      sess,
                      { editorId: guard.editorId, expectedRevision: guard.expectedRevision },
                      tw.template,
                      tw.expectedRevision,
                    )
                  : saveActiveSession(sess, {
                      editorId: guard.editorId,
                      expectedRevision: guard.expectedRevision,
                    }),
            },
          });
          if (out.status === 'saved') {
            confirmedRevision.current = out.revision;
            baseSessionRef.current = out.session;
            latestRef.current = out.session;
            setSaveState('idle');
          } else if (out.status === 'failed') {
            setSaveState('error');
            if (out.reason === 'lock-lost' || out.reason === 'no-lock' || out.reason === 'corrupt-lock') {
              setLockBlocked(true);
              setLockLostReason(out.message);
            }
            if (out.reason === 'state-conflict' || out.reason === 'version-conflict') {
              setConflictMessage(out.message);
            }
            pushToast(out.message, 'error');
          }
          settle(out);
        })
        .catch((err: unknown) => {
          setSaveState('error');
          const message = err instanceof Error ? err.message : '本地写入失败';
          pushToast(`未保存：${message}`, 'error');
          settle({ status: 'failed', reason: 'storage', message });
        });
      return outcome;
    },
    [saveActiveSession, saveActiveSessionWithTemplate, pushToast, sessionId],
  );

  const applyPendingDraft = useCallback(
    async (
      pending: PendingDraft,
      fresh: Session,
      pendingSeq: number | null,
    ): Promise<{ kind: 'saved' } | { kind: 'conflict' } | { kind: 'failed'; message: string }> => {
      const freshRev = revisionOf(fresh);
      const expect = (sess: Session) =>
        persist(sess, {
          writable: true,
          expectedRevision: freshRev,
          draftToken: pending.token,
          reservedSeq: pendingSeq,
          intentSnapshot: pending.session,
        });

      if (pending.baseRevision === freshRev) {
        const r = await expect({ ...pending.session, revision: freshRev });
        if (r.status === 'saved') return { kind: 'saved' };
        if (r.status === 'not-attempted') return { kind: 'failed', message: '当前不可写，草稿已保留' };
        return { kind: 'failed', message: r.message };
      }

      const own = ownPriorCommitRef.current ?? pending.priorOwnCommit ?? null;
      const merged = mergeDraftOntoFresh(pending.baseSession, pending.session, fresh, own);

      if (!merged.ok) {
        setDraftConflicts(merged.conflicts.map((c) => ({ path: c.path, message: c.message })));
        setSaveState('error');
        pushToast(merged.message, 'error');
        return { kind: 'conflict' };
      }

      setDraftConflicts(null);
      const r = await expect(merged.session);
      if (r.status === 'saved') return { kind: 'saved' };
      if (r.status === 'not-attempted') return { kind: 'failed', message: '当前不可写，草稿已保留' };
      return { kind: 'failed', message: r.message };
    },
    [persist, pushToast],
  );

  const tryTakeOver = useCallback(async () => {
    if (!beginBusy('takeover')) return;
    try {
      const r = await takeOverSessionLock(sessionId, editorId.current);
      if (!r.ok) {
        setLockLostReason(r.message ?? '接管失败');
        pushToast(r.message ?? '接管失败', 'error');
        return;
      }
      await refreshSessions();
      const loaded = await getSession(sessionId);
      if (loaded) {
        confirmedRevision.current = revisionOf(loaded);
        syncSessionLocal(loaded);
      }
      setLockBlocked(false);
      setLockLostReason(null);
      setSaveState('idle');

      const pending = unsavedDraft.current;
      const pendingSeq = rescuedSeqRef.current;
      if (pending) {
        const fresh = await getSession(sessionId);
        if (!fresh) {
          pushToast('已接管这个训练，但读不到最新记录；刚才的改动仍保留在本页。', 'error');
        } else {
          const outcome = await applyPendingDraft(pending, fresh, pendingSeq);
          if (outcome.kind === 'saved') {
            pushToast('已接管这个训练，刚才的改动已保存。');
          } else if (outcome.kind === 'conflict') {
            pushToast('已接管这个训练。刚才的改动与另一页冲突，草稿保留在本页。', 'error');
          } else {
            pushToast(`已接管这个训练，但刚才的改动没有保存成功：${outcome.message}。草稿保留在本页。`, 'error');
          }
        }
      } else {
        pushToast('已接管这个训练，可以继续记录。');
      }
    } catch (err) {
      pushToast(err instanceof Error ? `接管失败：${err.message}` : '接管失败', 'error');
    } finally {
      endBusy('takeover');
    }
  }, [sessionId, refreshSessions, syncSessionLocal, pushToast, applyPendingDraft, beginBusy, endBusy]);

  const discardPendingDraft = useCallback(() => {
    if (busyOwnerRef.current !== null) {
      pushToast(
        busyOwnerRef.current === 'takeover'
          ? '正在接管并保存刚才的改动，请稍候再决定。'
          : '正在保存刚才的改动，请稍候再决定。',
        'error',
      );
      return;
    }
    if (!unsavedDraft.current) {
      pushToast('当前没有待保存的改动。');
      return;
    }
    unsavedDraft.current = null;
    rescuedSeqRef.current = null;
    pendingFromRescue.current = false;
    setHasPendingDraft(false);
    setDraftConflicts(null);
    setSaveState('idle');
    clearRescueDraft(sessionId);
    pushToast('已放弃这份未保存的改动。');
  }, [pushToast, sessionId]);

  const retryUnsaved = useCallback(async () => {
    const pending = unsavedDraft.current;
    const pendingSeq = rescuedSeqRef.current;
    if (!pending) {
      pushToast('当前没有待保存的改动。');
      return;
    }
    if (!beginBusy('retry')) return;
    try {
      const acq = await acquireSessionLockDetailed(sessionId, editorId.current);
      if (!acq.ok) {
        setLockBlocked(true);
        setLockLostReason(
          acq.reason === 'held-by-other'
            ? '这个训练仍被另一个标签页编辑。请先在那个标签页停止操作，约 20 秒后此处可接管。'
            : (acq.message ?? '仍未能取得编辑锁'),
        );
        pushToast('仍然没有编辑控制，改动继续保留在本页。', 'error');
        return;
      }
      await refreshSessions();
      const fresh = await getSession(sessionId);
      if (!fresh) {
        pushToast('读不到最新记录，改动继续保留在本页。', 'error');
        return;
      }
      syncSessionLocal(fresh);
      setLockBlocked(false);
      setLockLostReason(null);
      setSaveState('idle');

      const outcome = await applyPendingDraft(pending, fresh, pendingSeq);
      if (outcome.kind === 'saved') {
        if (unsavedDraft.current) {
          pushToast('这一版已保存，仍有更新改动待保存。');
        } else {
          pushToast('已保存本页改动。');
        }
      } else if (outcome.kind === 'conflict') {
        // 冲突说明已由 applyPendingDraft 发出
      } else {
        pushToast(`这些改动没有保存成功：${outcome.message}。草稿仍保留在本页。`, 'error');
      }
    } catch (err) {
      pushToast(err instanceof Error ? `重试失败：${err.message}` : '重试失败', 'error');
    } finally {
      endBusy('retry');
    }
  }, [sessionId, refreshSessions, syncSessionLocal, applyPendingDraft, pushToast, beginBusy, endBusy]);

  // 保留导出引用（避免未使用告警）
  void settleOrdinarySlot;

  const applyExternalSessionCommit = useCallback(
    (committed: Session) => {
      confirmedRevision.current = revisionOf(committed);
      baseSessionRef.current = committed;
      latestRef.current = committed;
      syncSessionLocal(committed);
    },
    [syncSessionLocal],
  );

  return {
    editorId,
    confirmedRevision,
    latestRef,
    unsavedDraftRef: unsavedDraft,
    saveQueue,
    intentionallyClosed,
    lockBlocked,
    setLockBlocked,
    lockLostReason,
    setLockLostReason,
    conflictMessage,
    setConflictMessage,
    saveState,
    hasPendingDraft,
    draftConflicts,
    busyOwner,
    isCommittedBusy,
    inputPaused,
    pausedNotice,
    applyChange,
    commitPaired,
    sealPendingWrites,
    applyExternalSessionCommit,
    tryTakeOver,
    retryUnsaved,
    discardPendingDraft,
  };
}
