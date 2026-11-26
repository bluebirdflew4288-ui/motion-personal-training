import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COACH_VAULT_DB_NAME,
  DEFAULT_COACH_THREAD_ID,
  createCoachThreadWithFirstMessageInVault,
  createDefaultCoachThreadsState,
  deleteCoachMessagesByIds,
  deleteCoachThread,
  loadCoachMessages,
  loadCoachThreadsState,
  resetCoachVaultForTest,
  switchActiveCoachThreadInVault,
  upsertCoachMessages,
  type CoachStoredAttachment,
  type CoachStoredMessage,
  type CoachThreadMeta,
  type CoachThreadsState,
} from '../src/coach/coachStorage';
import {
  COACH_DRAFT_SELECTION_ID,
  clearDraftAttachmentIfUnchanged,
  clearDraftTextIfUnchanged,
  mergeReconciledBillingTotalsIntoThreadsState,
  mergeVaultThreadsIntoUiState,
  resolveDraftFirstSendOutcome,
  resolveThreadBoundRecoveryUi,
} from '../src/coach/CoachPane';

const NOW = 1_766_100_000_000;

function makeThread(id: string, overrides?: Partial<CoachThreadMeta>): CoachThreadMeta {
  return {
    id,
    title: '新对话',
    titleSource: 'placeholder',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeMsg(
  id: string,
  threadId: string,
  overrides?: Partial<CoachStoredMessage>,
): CoachStoredMessage {
  return {
    id,
    threadId,
    role: 'user',
    createdAt: NOW,
    text: '训练计划怎么安排？',
    ...overrides,
  };
}

describe('MOTION 阶段 #7：单空白草稿与晚到回调安全', () => {
  beforeEach(async () => {
    await resetCoachVaultForTest();
  });

  it('首条文本或仅附件发送原子创建正式会话与首条消息，重复同 ID 调用零重复写入', async () => {
    const tText = makeThread('t-text-1', { updatedAt: NOW + 1 });
    const mText = makeMsg('u-text-1', tText.id, { text: '今天深蹲热身几组？', createdAt: NOW + 1 });

    const created1 = await createCoachThreadWithFirstMessageInVault({
      thread: tText,
      firstMessage: mText,
    });
    expect(created1.activeThreadId).toBe('t-text-1');
    expect(created1.threads.map((t) => t.id)).toEqual(['t-text-1', DEFAULT_COACH_THREAD_ID]);

    const tAtt = makeThread('t-att-2', { updatedAt: NOW + 2 });
    const mAtt = makeMsg('u-att-2', tAtt.id, {
      text: '请帮我分析这段训练视频中的动作与发力建议',
      createdAt: NOW + 2,
      attachments: [
        {
          id: 'att-video-1',
          kind: 'video',
          name: 'sample-lift.mp4',
          mimeType: 'video/mp4',
          dataBase64: 'AAAA',
          width: 320,
          height: 240,
          sizeBytes: 1024,
        },
      ],
    });

    await createCoachThreadWithFirstMessageInVault({ thread: tAtt, firstMessage: mAtt });
    await createCoachThreadWithFirstMessageInVault({ thread: tAtt, firstMessage: mAtt });

    const storedState = await loadCoachThreadsState();
    const storedMsgs = await loadCoachMessages();
    expect(storedState.activeThreadId).toBe('t-att-2');
    expect(storedState.threads.filter((t) => t.id === 't-att-2')).toHaveLength(1);
    expect(storedMsgs.filter((m) => m.id === 'u-att-2')).toHaveLength(1);
    expect(storedMsgs.find((m) => m.id === 'u-att-2')?.attachments?.[0]?.kind).toBe('video');

    await expect(
      createCoachThreadWithFirstMessageInVault({
        thread: makeThread('t-collision'),
        firstMessage: makeMsg('u-att-2', 't-collision', { text: '跨线程同 ID 碰撞' }),
      }),
    ).rejects.toThrow('首条消息 ID 与既有会话冲突');

    const afterCollision = await loadCoachThreadsState();
    expect(afterCollision.threads.some((t) => t.id === 't-collision')).toBe(false);
  });

  it('IDB 事务中止回滚时不会残留幽灵线程或首条消息，且不会污染内存兜底状态', async () => {
    const baseThread = makeThread('t-committed', { title: '已提交会话' });
    const baseMsg = makeMsg('u-committed', baseThread.id, { text: '正常历史消息' });
    await createCoachThreadWithFirstMessageInVault({
      thread: baseThread,
      firstMessage: baseMsg,
    });

    const origTx = IDBDatabase.prototype.transaction;
    const spy = vi
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (this: IDBDatabase, storeNames, mode) {
        const tx = origTx.call(this, storeNames as string | string[], mode);
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        if (mode === 'readwrite' && names.includes('meta') && names.includes('messages')) {
          const origObjectStore = tx.objectStore.bind(tx);
          tx.objectStore = ((name: string) => {
            const store = origObjectStore(name);
            if (name === 'messages') {
              const origPut = store.put.bind(store);
              store.put = ((...args: Parameters<IDBObjectStore['put']>) => {
                const req = origPut(...args);
                req.addEventListener('success', () => {
                  tx.abort();
                });
                return req;
              }) as IDBObjectStore['put'];
            }
            return store;
          }) as unknown as IDBTransaction['objectStore'];
        }
        return tx;
      });

    await expect(
      createCoachThreadWithFirstMessageInVault({
        thread: makeThread('t-aborted', { updatedAt: NOW + 10 }),
        firstMessage: makeMsg('u-aborted', 't-aborted', { text: '事务中止不应落盘' }),
      }),
    ).rejects.toThrow();

    spy.mockRestore();

    const dbState = await loadCoachThreadsState();
    const dbMsgs = await loadCoachMessages();
    expect(dbState.threads.some((t) => t.id === 't-aborted')).toBe(false);
    expect(dbState.activeThreadId).toBe('t-committed');
    expect(dbMsgs.some((m) => m.id === 'u-aborted')).toBe(false);
    expect(dbMsgs.some((m) => m.id === 'u-committed')).toBe(true);

    vi.stubGlobal('indexedDB', undefined);
    try {
      const memState = await loadCoachThreadsState();
      const memMsgs = await loadCoachMessages();
      expect(memState.threads.some((t) => t.id === 't-aborted')).toBe(false);
      expect(memState.activeThreadId).toBe('t-committed');
      expect(memMsgs.some((m) => m.id === 'u-aborted')).toBe(false);
      expect(memMsgs.some((m) => m.id === 'u-committed')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('upsertCoachMessages / deleteCoachMessagesByIds 与 switchActiveCoachThreadInVault 按线程精确更新且不吞并发线程', async () => {
    const tA = makeThread('t-a', { title: '线程 A', titleSource: 'auto' });
    const tB = makeThread('t-b', { title: '线程 B', titleSource: 'auto' });
    await createCoachThreadWithFirstMessageInVault({
      thread: tA,
      firstMessage: makeMsg('u-a1', tA.id, { text: 'A-1' }),
    });
    await createCoachThreadWithFirstMessageInVault({
      thread: tB,
      firstMessage: makeMsg('u-b1', tB.id, { text: 'B-1' }),
    });

    await upsertCoachMessages([
      makeMsg('u-a2', tA.id, { text: 'A-2', createdAt: NOW + 5 }),
    ]);
    await switchActiveCoachThreadInVault(tA.id);
    await deleteCoachMessagesByIds(['u-a1']);

    const state = await loadCoachThreadsState();
    const msgs = await loadCoachMessages();
    expect(state.activeThreadId).toBe(tA.id);
    expect(state.threads.map((t) => t.id)).toContain(tB.id);
    expect(msgs.map((m) => m.id)).toEqual(['u-b1', 'u-a2']);
  });

  it('删除最后一个正式会话回到 default 语义，不重建持久化空「新对话」', async () => {
    const tOnly = makeThread('t-only', { title: '唯一自定义会话', titleSource: 'manual' });
    await createCoachThreadWithFirstMessageInVault({
      thread: tOnly,
      firstMessage: makeMsg('u-only', tOnly.id),
    });

    const resetDefault = createDefaultCoachThreadsState();
    await deleteCoachThread(tOnly.id, resetDefault);
    await deleteCoachThread(DEFAULT_COACH_THREAD_ID, resetDefault);

    const stored = await loadCoachThreadsState();
    expect(stored.activeThreadId).toBe(DEFAULT_COACH_THREAD_ID);
    expect(stored.threads).toHaveLength(1);
    expect(stored.threads[0].id).toBe(DEFAULT_COACH_THREAD_ID);
    expect(stored.threads.some((t) => t.id !== DEFAULT_COACH_THREAD_ID && t.title === '新对话')).toBe(
      false,
    );
  });

  it('mergeVaultThreadsIntoUiState 与 mergeReconciledBillingTotalsIntoThreadsState 对晚到回调安全且保留既有空会话', () => {
    const legacyEmptyThread = makeThread('legacy-empty', {
      title: '新对话',
      titleSource: 'placeholder',
      createdAt: NOW - 10_000,
      updatedAt: NOW - 10_000,
    });
    const newlyCreatedThread = makeThread('t-fresh', {
      title: '刚发的正式会话',
      titleSource: 'auto',
      updatedAt: NOW + 50,
    });

    const prevUi: CoachThreadsState = {
      activeThreadId: 't-fresh',
      threads: [
        newlyCreatedThread,
        legacyEmptyThread,
        makeThread(DEFAULT_COACH_THREAD_ID, { title: '教练对话' }),
      ],
    };

    const staleVaultSnapshot: CoachThreadsState = {
      activeThreadId: DEFAULT_COACH_THREAD_ID,
      threads: [
        legacyEmptyThread,
        makeThread(DEFAULT_COACH_THREAD_ID, {
          title: '教练对话',
          activeSegmentId: 'seg-2',
          contextSummary: '旧段摘要',
        }),
        makeThread('t-deleted', { title: '已删线程' }),
      ],
    };

    const merged = mergeVaultThreadsIntoUiState(prevUi, staleVaultSnapshot, {
      deletedThreadIds: new Set(['t-deleted']),
      allowAdoptVaultActive: false,
    });

    expect(merged.activeThreadId).toBe('t-fresh');
    expect(merged.threads.map((t) => t.id)).toEqual([
      't-fresh',
      'legacy-empty',
      DEFAULT_COACH_THREAD_ID,
    ]);
    expect(merged.threads.find((t) => t.id === DEFAULT_COACH_THREAD_ID)?.activeSegmentId).toBe('seg-2');

    const reconciledSnapshot: CoachThreadsState = {
      activeThreadId: DEFAULT_COACH_THREAD_ID,
      threads: [
        makeThread(DEFAULT_COACH_THREAD_ID, {
          billingTotals: {
            summarySchemaVersion: 2,
            currency: 'CNY',
            requests: 2,
            inputTokens: 200,
            cachedInputTokens: 50,
            uncachedInputTokens: 150,
            cacheCreationInputTokens: 0,
            outputTokens: 80,
            reasoningOutputTokens: 0,
            totalCostUsd: 0.12,
            unknownUsageRequests: 0,
            loggedSetsCount: 0,
          },
        }),
      ],
    };

    const billingMerged = mergeReconciledBillingTotalsIntoThreadsState(merged, reconciledSnapshot);
    expect(billingMerged.changed).toBe(true);
    expect(billingMerged.next.activeThreadId).toBe('t-fresh');
    expect(billingMerged.next.threads.map((t) => t.id)).toEqual([
      't-fresh',
      'legacy-empty',
      DEFAULT_COACH_THREAD_ID,
    ]);
    expect(
      billingMerged.next.threads.find((t) => t.id === DEFAULT_COACH_THREAD_ID)?.billingTotals
        ?.summarySchemaVersion,
    ).toBe(2);

    const draftRecovery = resolveThreadBoundRecoveryUi({
      activeThreadId: COACH_DRAFT_SELECTION_ID,
      pendingRecoveryTurn: {
        turnId: 'turn-1',
        threadId: 't-fresh',
        segmentId: 'seg-1',
        round: 1,
        userMessageId: 'u-1',
        userPromptText: '记录一组',
        restoreEpoch: 1,
        providerKind: 'openai-compatible',
        deploymentId: 'dep-1',
        model: 'deepseek-chat',
        updatedAt: NOW,
        createdAt: NOW,
        status: 'awaiting_tools',
      },
      pendingRecoveryState: {
        threadId: 't-fresh',
        currentEpoch: 1,
        hasUnclosedToolBatch: true,
        orphanBatch: false,
        pendingTurn: null,
        expiredPendingTurns: [],
      },
    });
    expect(draftRecovery.visibleRecoveryTurn).toBeNull();
    expect(draftRecovery.canResume).toBe(false);
    expect(draftRecovery.canAbandon).toBe(false);
  });

  it('首发保存完成回调延迟时切去旧会话或重进草稿不夺回选择，更新后的草稿文字/附件不被误清，且新线程与首消息只落盘一次', async () => {
    const delayedThread = makeThread('t-delayed', {
      title: '新对话',
      titleSource: 'placeholder',
      updatedAt: NOW + 100,
    });
    const delayedFirstMsg = makeMsg('u-delayed', delayedThread.id, {
      text: '首发提问',
      createdAt: NOW + 100,
    });

    // 模拟首发事务尚在等待完成期间，用户切换回 default 会话
    const savePromise = createCoachThreadWithFirstMessageInVault({
      thread: delayedThread,
      firstMessage: delayedFirstMsg,
    });
    const switchPromise = switchActiveCoachThreadInVault(DEFAULT_COACH_THREAD_ID);
    const [createdState] = await Promise.all([savePromise, switchPromise]);

    // Case A：await 完成时用户已切换到 default（opSeq 递增且 isDraftActive=false）
    const outcomeSwitchedOld = resolveDraftFirstSendOutcome({
      prevUiState: {
        activeThreadId: DEFAULT_COACH_THREAD_ID,
        threads: [makeThread(DEFAULT_COACH_THREAD_ID, { title: '教练对话' })],
      },
      createdState,
      sendOpSeq: 1,
      currentOpSeq: 2,
      currentIsDraftActive: false,
      currentSelectedKey: DEFAULT_COACH_THREAD_ID,
    });
    expect(outcomeSwitchedOld.adoptCreatedThread).toBe(false);
    expect(outcomeSwitchedOld.nextThreadsState.activeThreadId).toBe(DEFAULT_COACH_THREAD_ID);
    expect(outcomeSwitchedOld.nextThreadsState.threads.map((t) => t.id)).toEqual([
      DEFAULT_COACH_THREAD_ID,
      't-delayed',
    ]);

    // Case B：await 完成时用户切去旧会话后又重新点了铅笔进入草稿（opSeq 已递增）
    const outcomeReenteredDraft = resolveDraftFirstSendOutcome({
      prevUiState: {
        activeThreadId: DEFAULT_COACH_THREAD_ID,
        threads: [makeThread(DEFAULT_COACH_THREAD_ID, { title: '教练对话' })],
      },
      createdState,
      sendOpSeq: 1,
      currentOpSeq: 3,
      currentIsDraftActive: true,
      currentSelectedKey: COACH_DRAFT_SELECTION_ID,
    });
    expect(outcomeReenteredDraft.adoptCreatedThread).toBe(false);
    expect(outcomeReenteredDraft.nextThreadsState.activeThreadId).toBe(DEFAULT_COACH_THREAD_ID);
    expect(outcomeReenteredDraft.nextThreadsState.threads.some((t) => t.id === 't-delayed')).toBe(
      true,
    );

    // Case C：正常无切换，推进选中新正式会话
    const outcomeNormal = resolveDraftFirstSendOutcome({
      prevUiState: {
        activeThreadId: DEFAULT_COACH_THREAD_ID,
        threads: [makeThread(DEFAULT_COACH_THREAD_ID, { title: '教练对话' })],
      },
      createdState,
      sendOpSeq: 1,
      currentOpSeq: 1,
      currentIsDraftActive: true,
      currentSelectedKey: COACH_DRAFT_SELECTION_ID,
    });
    expect(outcomeNormal.adoptCreatedThread).toBe(true);
    expect(outcomeNormal.nextThreadsState.activeThreadId).toBe('t-delayed');

    // 验证首发清理不会抹掉 await 期间改写的文字或新增/替换的附件
    const attOldStored: CoachStoredAttachment = {
      id: 'att-old',
      kind: 'image',
      name: 'old.jpg',
      mimeType: 'image/jpeg',
      dataBase64: 'AAA=',
      width: 100,
      height: 100,
      sizeBytes: 3,
    };
    const attNewStored: CoachStoredAttachment = {
      ...attOldStored,
      id: 'att-new',
      name: 'new.jpg',
    };
    const attOldUi = {
      id: 'att-old',
      stored: attOldStored,
      kind: 'image' as const,
      name: 'old.jpg',
      dataUrl: 'data:image/jpeg;base64,AAA=',
      width: 100,
      height: 100,
      sizeBytes: 3,
    };
    const attNewUi = {
      ...attOldUi,
      id: 'att-new',
      stored: attNewStored,
      name: 'new.jpg',
    };

    expect(
      clearDraftTextIfUnchanged({ [COACH_DRAFT_SELECTION_ID]: '首发提问' }, COACH_DRAFT_SELECTION_ID, '首发提问')[
        COACH_DRAFT_SELECTION_ID
      ],
    ).toBe('');
    expect(
      clearDraftTextIfUnchanged(
        { [COACH_DRAFT_SELECTION_ID]: '等待期间更新的草稿' },
        COACH_DRAFT_SELECTION_ID,
        '首发提问',
      )[COACH_DRAFT_SELECTION_ID],
    ).toBe('等待期间更新的草稿');
    expect(
      clearDraftAttachmentIfUnchanged({ [COACH_DRAFT_SELECTION_ID]: attOldUi }, COACH_DRAFT_SELECTION_ID, attOldUi)[
        COACH_DRAFT_SELECTION_ID
      ],
    ).toBeUndefined();
    expect(
      clearDraftAttachmentIfUnchanged({ [COACH_DRAFT_SELECTION_ID]: attNewUi }, COACH_DRAFT_SELECTION_ID, attOldUi)[
        COACH_DRAFT_SELECTION_ID
      ]?.id,
    ).toBe('att-new');
    expect(
      clearDraftAttachmentIfUnchanged({ [COACH_DRAFT_SELECTION_ID]: attNewUi }, COACH_DRAFT_SELECTION_ID, null)[
        COACH_DRAFT_SELECTION_ID
      ]?.id,
    ).toBe('att-new');

    // 验证 Vault 中新线程与首消息仅各存一次，且最终 activeThreadId 保留在 default
    const storedState = await loadCoachThreadsState();
    const storedMsgs = await loadCoachMessages();
    expect(storedState.activeThreadId).toBe(DEFAULT_COACH_THREAD_ID);
    expect(storedState.threads.filter((t) => t.id === 't-delayed')).toHaveLength(1);
    expect(storedMsgs.filter((m) => m.id === 'u-delayed')).toHaveLength(1);
  });

  it('raw IndexedDB 跨会话新增第 17/18 条图片消息（首条新建与既有新增双路径）严格守住 16 条图片预算且不 clear 整库或丢文本', async () => {
    const readRawIdbMessages = (): Promise<CoachStoredMessage[]> =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open(COACH_VAULT_DB_NAME);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('messages', 'readonly');
          const allReq = tx.objectStore('messages').getAll();
          allReq.onsuccess = () => {
            db.close();
            resolve((allReq.result ?? []) as CoachStoredMessage[]);
          };
          allReq.onerror = () => {
            db.close();
            reject(allReq.error);
          };
        };
      });

    const imgAtt = (id: string): CoachStoredAttachment => ({
      id,
      kind: 'image',
      name: `${id}.jpg`,
      mimeType: 'image/jpeg',
      dataBase64: 'AAAA',
      width: 200,
      height: 200,
      sizeBytes: 4,
    });

    // 先建好 thread-a、旧纯文本与视频消息，以及跨线程共 15 张旧图
    await createCoachThreadWithFirstMessageInVault({
      thread: makeThread('t-img-a', { title: '图片会话 A' }),
      firstMessage: makeMsg('txt-old-a', 't-img-a', { text: '保留文本 A', createdAt: NOW + 1 }),
    });
    await upsertCoachMessages([
      makeMsg('txt-old-default', DEFAULT_COACH_THREAD_ID, {
        text: '保留文本 default',
        createdAt: NOW + 2,
      }),
      makeMsg('vid-old-1', 't-img-a', {
        text: '保留视频元数据',
        createdAt: NOW + 3,
        attachments: [
          {
            id: 'att-vid-old',
            kind: 'video',
            name: 'lift.mp4',
            mimeType: 'video/mp4',
            dataBase64: 'BBBB',
            width: 320,
            height: 240,
            sizeBytes: 1200,
          },
        ],
      }),
    ]);

    const seedImages: CoachStoredMessage[] = [];
    for (let i = 1; i <= 15; i += 1) {
      seedImages.push(
        makeMsg(`img-${i}`, i % 2 === 0 ? DEFAULT_COACH_THREAD_ID : 't-img-a', {
          text: `旧图 ${i} 描述`,
          createdAt: NOW + 100 + i,
          attachments: [imgAtt(`att-img-${i}`)],
        }),
      );
    }
    await upsertCoachMessages(seedImages);

    const clearSpy = vi.spyOn(IDBObjectStore.prototype, 'clear');
    try {
      // 第 16 条图片消息（既有会话新增）
      await upsertCoachMessages([
        makeMsg('img-16', DEFAULT_COACH_THREAD_ID, {
          text: '旧图 16 描述',
          createdAt: NOW + 216,
          attachments: [imgAtt('att-img-16')],
        }),
      ]);

      // 第 17 条图片消息（草稿首条新建会话路径）
      await createCoachThreadWithFirstMessageInVault({
        thread: makeThread('t-img-first-17', { title: '新图首条' }),
        firstMessage: makeMsg('img-17', 't-img-first-17', {
          text: '第 17 张首条图片',
          createdAt: NOW + 217,
          attachments: [imgAtt('att-img-17')],
        }),
      });

      const rawAfter17 = await readRawIdbMessages();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(rawAfter17).toHaveLength(20);
      expect(rawAfter17.find((m) => m.id === 'txt-old-a')?.text).toBe('保留文本 A');
      expect(rawAfter17.find((m) => m.id === 'txt-old-default')?.text).toBe('保留文本 default');
      expect(rawAfter17.find((m) => m.id === 'vid-old-1')?.attachments?.[0]?.kind).toBe('video');

      const withImages17 = rawAfter17.filter((m) =>
        m.attachments?.some((att) => att.kind !== 'video'),
      );
      expect(withImages17).toHaveLength(16);
      expect(withImages17.map((m) => m.id).sort()).toEqual(
        Array.from({ length: 16 }, (_, idx) => `img-${idx + 2}`).sort(),
      );
      const evictedImg1 = rawAfter17.find((m) => m.id === 'img-1');
      expect(evictedImg1?.text).toBe('旧图 1 描述');
      expect(evictedImg1?.attachments).toBeUndefined();

      // 第 18 条图片消息（已有会话 upsertCoachMessages 路径）
      await upsertCoachMessages([
        makeMsg('img-18', 't-img-a', {
          text: '第 18 张既有会话图片',
          createdAt: NOW + 218,
          attachments: [imgAtt('att-img-18')],
        }),
      ]);

      const rawAfter18 = await readRawIdbMessages();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(rawAfter18).toHaveLength(21);
      const withImages18 = rawAfter18.filter((m) =>
        m.attachments?.some((att) => att.kind !== 'video'),
      );
      expect(withImages18).toHaveLength(16);
      expect(withImages18.map((m) => m.id).sort()).toEqual(
        Array.from({ length: 16 }, (_, idx) => `img-${idx + 3}`).sort(),
      );
      const evictedImg2 = rawAfter18.find((m) => m.id === 'img-2');
      expect(evictedImg2?.text).toBe('旧图 2 描述');
      expect(evictedImg2?.attachments).toBeUndefined();
    } finally {
      clearSpy.mockRestore();
    }
  });
});
