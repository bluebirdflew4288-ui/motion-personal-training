/* 阶段 2 · MOTION 内置电子教练结构化写库引擎、并发事务锁、焦点避让、
   字段级独立撤销、图片压缩与 Backup v4 隔离全链路测试。 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findV4Contraband } from '../src/db/backupCompat';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  buildBackup,
  CURRENT_APP_VERSION,
  getPlan,
  getSession,
  restoreBackup,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import {
  atomicCreateSession,
  atomicDiscardSession,
  atomicFinishSession,
  revisionOf,
} from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession, summarizeSession } from '../src/domain/session';
import { applyDeleteItem, previewDeleteItem } from '../src/domain/sessionItemIntent';
import { detectSessionPRs } from '../src/domain/prDetector';
import { buildExerciseHistory } from '../src/domain/stats';
import {
  cleanOrphanPairIds,
  isValidUuidV4,
  pairExercisesAsSuperset,
} from '../src/domain/supersetPair';
import type { Plan, Session } from '../src/domain/types';
import { runCoachTurn } from '../src/coach/coachAgent';
import {
  compressWithEncoder,
  containsExifMetadata,
  extractPlanDraftFromImage,
  stripExifFromJpegBytes,
} from '../src/coach/coachImage';
import {
  getCoachRestoreEpoch,
  listCoachReceipts,
  loadCoachMessages,
  resetCoachVaultForTest,
  saveCoachMessages,
  saveCoachProviderConfig,
} from '../src/coach/coachStorage';
import { buildCoachReadOnlyContext, executeCoachToolCall } from '../src/coach/coachTools';
import {
  coachAdjustActiveTarget,
  coachConfigureSuperset,
  coachCorrectHistory,
  coachCreatePlanFromDraft,
  coachModifyExistingPlan,
  coachRecordActiveSet,
  coachSyncSessionToPlan,
  undoCoachReceipt,
} from '../src/coach/coachTx';
import {
  __resetFocusGuardForTest,
  registerFocusedField,
  setDirtyField,
} from '../src/coach/focusGuard';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_765_000_000_000;

async function resetAllStores(): Promise<void> {
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');
}

async function seedPlanAndActiveSession(opts?: {
  sessionId?: string;
  mountRuntime?: boolean;
  onStartTimer?: (sec: number, src: { sessionExerciseId: string; setId?: string }) => void;
}): Promise<{ plan: Plan; session: Session }> {
  const plan = createV32Plan(NOW);
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = {
    ...raw,
    id: opts?.sessionId ?? 'sess-stage2-1',
    warmups: [{ id: 'w-1', name: '肩袖热身', unit: 'reps', targetText: '2 × 15', done: false }],
    exercises: raw.exercises.map((e, i) =>
      i === 0 ? { ...e, setupNote: '座椅第 4 格，保护杆第 2 孔' } : e,
    ),
  };
  const created = await atomicCreateSession({ session });
  expect(created.ok).toBe(true);
  const fresh = (await getSession(session.id))!;

  if (opts?.mountRuntime) {
    const editorId = 'editor-live-1';
    await acquireSessionLock(fresh.id, editorId);
    let latest = fresh;
    registerSessionRuntime({
      sessionId: fresh.id,
      editorId,
      awaitPendingWrites: async () => undefined,
      applyCommittedSession: (c) => {
        latest = c;
        void latest;
      },
      hasBlockingDrafts: () => false,
      startRestTimer: (sec, src) => {
        opts.onStartTimer?.(sec, src);
      },
    });
  }

  return { plan, session: fresh };
}

function makeFakeJpegWithExif(payloadSize: number): Uint8Array {
  // SOI (FF D8) + APP1 EXIF (FF E1 len "Exif\0\0" ...) + SOS (FF DA) + dummy pixels + EOI (FF D9)
  const exifData = new TextEncoder().encode('Exif\0\0MM\0*\0\0\0\x08MockGPSCameraMeta');
  const app1Len = 2 + exifData.length;
  const body = new Uint8Array(Math.max(16, payloadSize));
  const out = new Uint8Array(2 + 2 + app1Len + 2 + body.length + 2);
  let p = 0;
  out[p++] = 0xff;
  out[p++] = 0xd8;
  out[p++] = 0xff;
  out[p++] = 0xe1;
  out[p++] = (app1Len >> 8) & 0xff;
  out[p++] = app1Len & 0xff;
  out.set(exifData, p);
  p += exifData.length;
  out[p++] = 0xff;
  out[p++] = 0xda;
  out.set(body, p);
  p += body.length;
  out[p++] = 0xff;
  out[p++] = 0xd9;
  return out;
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

describe('阶段 2 · 电子教练业务工具、并发事务与字段级独立撤销', () => {
  beforeEach(async () => {
    await resetAllStores();
  });

  afterEach(() => {
    registerSessionRuntime(null);
    __resetFocusGuardForTest();
  });

  it('目标调参与实绩记录严格隔离：调目标绝不标 done、不增加完成组、不触发 RestTimer', async () => {
    const startTimer = vi.fn();
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true, onStartTimer: startTimer });
    const firstEx = session.exercises[0];

    const adj = await coachAdjustActiveTarget({
      sessionId: session.id,
      exId: firstEx.id,
      expectedRevision: revisionOf(session),
      repsMin: 12,
      repsMax: 12,
    });

    expect(startTimer).not.toHaveBeenCalled();
    const afterAdj = (await getSession(session.id))!;
    expect(summarizeSession(afterAdj).completedSets).toBe(0);
    expect(afterAdj.exercises[0].target.kind === 'straight' && afterAdj.exercises[0].target.repsMax).toBe(12);
    expect(afterAdj.exercises[0].sets.every((s) => s.status === 'blank')).toBe(true);
    expect(adj.receipt.timerStarted).toBe(false);

    // 通过自然语言“下一组做 12 次”同样只改目标不标完成
    const turn = await runCoachTurn({
      userText: `下一组${firstEx.name}做 12 次`,
      history: [],
      toolContext: { activeSession: afterAdj },
      streamChunkDelayMs: 0,
    });
    expect(turn.receipts.length).toBe(1);
    expect(turn.receipts[0].toolName).toBe('adjust_active_target');
    expect(startTimer).not.toHaveBeenCalled();
    expect(summarizeSession((await getSession(session.id))!).completedSets).toBe(0);
  });

  it('逐组实绩：原子写入且仅非 done -> done 触发 RestTimer；拦截已完成组的非法半空数值', async () => {
    const startTimer = vi.fn();
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true, onStartTimer: startTimer });
    const ex = session.exercises.find((e) => e.target.weightMode === 'external') ?? session.exercises[1];

    // 记录第 1 组：非 done -> done，触发 RestTimer 并自动预填后续空白组
    const rec1 = await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 1,
      reps: 11,
      weightKg: 60,
      status: 'done',
    });
    expect(rec1.receipt.timerStarted).toBe(true);
    expect(startTimer).toHaveBeenCalledTimes(1);
    expect(startTimer).toHaveBeenCalledWith(ex.restSec, {
      sessionExerciseId: ex.id,
      setId: ex.sets[0].id,
    });

    const after1 = (await getSession(session.id))!;
    const afterEx = after1.exercises.find((e) => e.id === ex.id)!;
    expect(afterEx.sets[0].status).toBe('done');
    expect(afterEx.sets[0].reps).toBe(11);
    expect(afterEx.sets[1].weightKg).toBe(60);

    // 修正已完成的第 1 组数字：不得重复触发或打断 RestTimer
    const recEdit1 = await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 1,
      reps: 12,
      weightKg: 62.5,
      status: 'done',
    });
    expect(recEdit1.receipt.timerStarted).toBe(false);
    expect(startTimer).toHaveBeenCalledTimes(1);

    // 试图把已完成组改为 null / 0 / NaN / 清空外加重量 → 明确阻断为 dirty-state，绝不出现“done 但无次数”
    await expect(
      coachRecordActiveSet({
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 1,
        reps: null,
        status: 'done',
      }),
    ).rejects.toMatchObject({ name: 'TxConflictError', reason: 'dirty-state' });

    await expect(
      coachRecordActiveSet({
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 1,
        reps: 0,
        status: 'done',
      }),
    ).rejects.toMatchObject({ name: 'TxConflictError', reason: 'dirty-state' });

    await expect(
      coachRecordActiveSet({
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 1,
        weightKg: null,
        status: 'done',
      }),
    ).rejects.toMatchObject({ name: 'TxConflictError', reason: 'dirty-state' });
  });

  it('乐观锁 revision 并发保护与焦点避让：Set 3 聚焦/dirty 时拒绝覆写 Set 3，允许写入 Set 2', async () => {
    const startTimer = vi.fn();
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true, onStartTimer: startTimer });
    const ex = session.exercises[0];
    const staleRev = revisionOf(session);

    // 先推进第 1 组使 revision 前进
    await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
    });

    // 携带过期 expectedRevision → 拒绝覆盖
    await expect(
      coachRecordActiveSet({
        sessionId: session.id,
        exId: ex.id,
        roundIndex: 2,
        reps: 10,
        weightKg: 60,
        expectedRevision: staleRev,
      }),
    ).rejects.toMatchObject({ name: 'TxConflictError', reason: 'version-conflict' });

    // 用户正在 Set 3 输入框聚焦并存在未成型 dirty raw
    const set3 = ex.sets[2];
    registerFocusedField({ sessionId: session.id, exId: ex.id, setId: set3.id, field: 'reps' });
    setDirtyField({ sessionId: session.id, exId: ex.id, setId: set3.id, field: 'reps' }, true);

    await expect(
      coachRecordActiveSet({
        sessionId: session.id,
        exId: ex.id,
        setId: set3.id,
        reps: 8,
        weightKg: 60,
      }),
    ).rejects.toMatchObject({ name: 'TxConflictError', reason: 'focus-conflict' });

    // 同时对不同组 Set 2 写入应放行且不误碰 Set 3
    const okSet2 = await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      setId: ex.sets[1].id,
      reps: 11,
      weightKg: 60,
    });
    expect(okSet2.session?.exercises[0].sets[1].reps).toBe(11);
  });

  it('字段级独立撤销：教练改第2组 → 用户手动改第3组 → 撤销第2组时完整保留第3组；若用户改了第2组则拒绝撤销', async () => {
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true });
    const ex = session.exercises[0];

    // 1. 教练记录第 2 组：11 次 × 60kg
    const r2 = await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 2,
      reps: 11,
      weightKg: 60,
      status: 'done',
    });

    // 2. 用户在窗外手动记录第 3 组（直接以新 revision 原子提交 Set 3，revision 递增）
    const curAfterR2 = (await getSession(session.id))!;
    const set3Patch: Session = {
      ...curAfterR2,
      exercises: curAfterR2.exercises.map((item) =>
        item.id !== ex.id
          ? item
          : {
              ...item,
              sets: item.sets.map((s) =>
                s.roundIndex === 3 ? { ...s, reps: 9, weightKg: 62.5, status: 'done' as const } : s,
              ),
            },
      ),
    };
    const { atomicWriteSession } = await import('../src/db/tx');
    const manRes = await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: set3Patch,
      editorId: 'editor-live-1',
      expectedRevision: revisionOf(curAfterR2),
      lockPolicy: 'required',
    });
    expect(manRes.ok).toBe(true);

    // 3. 点第 2 组回执「撤销」：必须精准回滚第 2 组，且第 3 组 9次×62.5kg 纹丝不动！
    const undone = await undoCoachReceipt(r2.receipt.id);
    expect(undone.receipt.undone).toBe(true);
    const afterUndo = (await getSession(session.id))!;
    const afterEx = afterUndo.exercises[0];
    expect(afterEx.sets[1].status).toBe('blank');
    expect(afterEx.sets[1].reps).toBeNull();
    expect(afterEx.sets[2].status).toBe('done');
    expect(afterEx.sets[2].reps).toBe(9);
    expect(afterEx.sets[2].weightKg).toBe(62.5);

    // 4. 若教练改完第 2 组后，用户又亲手改了同一组（第 2 组），再撤销第 2 组必须阻断，绝不覆盖用户新改动
    const r2b = await coachRecordActiveSet({
      sessionId: session.id,
      exId: ex.id,
      roundIndex: 2,
      reps: 10,
      weightKg: 60,
      status: 'done',
    });
    const curForConflict = (await getSession(session.id))!;
    await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: {
        ...curForConflict,
        exercises: curForConflict.exercises.map((item) =>
          item.id !== ex.id
            ? item
            : {
                ...item,
                sets: item.sets.map((s) => (s.roundIndex === 2 ? { ...s, reps: 14 } : s)),
              },
        ),
      },
      editorId: 'editor-live-1',
      expectedRevision: revisionOf(curForConflict),
      lockPolicy: 'required',
    });
    await expect(undoCoachReceipt(r2b.receipt.id)).rejects.toMatchObject({
      name: 'TxConflictError',
      reason: 'field-conflict',
    });
    expect((await getSession(session.id))!.exercises[0].sets[1].reps).toBe(14);
  });

  it('多动作超级组 pairId UUID v4 配对、孤立清理与多阶段转换防 PR/历史/统计串算', async () => {
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true });
    expect(session.exercises.length).toBeGreaterThanOrEqual(3);
    const [exA, exB, exC] = session.exercises;

    // 配对 A + B
    const paired = await coachConfigureSuperset({
      sessionId: session.id,
      mode: 'pair',
      exIds: [exA.id, exB.id],
    });
    expect(isValidUuidV4(paired.meta?.pairId)).toBe(true);
    const sAfterPair = (await getSession(session.id))!;
    expect(sAfterPair.exercises[0].pairId).toBe(paired.meta?.pairId);
    expect(sAfterPair.exercises[1].pairId).toBe(paired.meta?.pairId);
    expect(sAfterPair.exercises[2].pairId).toBeUndefined();

    // 删除 B 后仅剩 A 单个 → 必须自动清理孤立 pairId
    const prevDelB = previewDeleteItem(sAfterPair, exB.id);
    expect(prevDelB.ok).toBe(true);
    if (!prevDelB.ok) throw new Error('preview failed');
    const afterDelB = applyDeleteItem(sAfterPair, prevDelB.preview, { confirmed: true });
    expect(afterDelB.ok).toBe(true);
    if (!afterDelB.ok) throw new Error('delete failed');
    expect(afterDelB.session.exercises[0].pairId).toBeUndefined();
    expect(cleanOrphanPairIds([{ id: 'x', pairId: paired.meta?.pairId }])[0].pairId).toBeUndefined();

    // 重新将 exC 记完 1 组后再转为多阶段超级组 → 保留单动作已做组与单动作身份，新建独立 superset:... 复合卡
    await coachRecordActiveSet({
      sessionId: session.id,
      exId: exC.id,
      roundIndex: 1,
      reps: 10,
      weightKg: 50,
    });
    const conv = await coachConfigureSuperset({
      sessionId: session.id,
      mode: 'convert_multistage',
      exId: exC.id,
      partnerName: '哑铃飞鸟',
      rounds: 2,
    });
    const afterConv = conv.session!;
    const keptCard = afterConv.exercises.find((e) => e.id === exC.id)!;
    const superCard = afterConv.exercises.find((e) => e.id === conv.meta?.supersetExerciseId)!;
    expect(keptCard.exerciseId).toBe(exC.exerciseId);
    expect(keptCard.sets[0].status).toBe('done');
    expect(superCard.exerciseId.startsWith('superset:')).toBe(true);
    expect(superCard.target.kind).toBe('dropSet');

    // 验证旧数据（复用单动作 exerciseId 的混合超级组）绝不跨动作污染单动作 PR 与统计
    const straightHist: Session = {
      ...session,
      id: 'h-straight-1',
      status: 'completed',
      startedAt: NOW - 200_000,
      endedAt: NOW - 190_000,
      exercises: [
        {
          ...exA,
          id: 'hx-a1',
          sets: [{ id: 's1', roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 20, status: 'done' }],
        },
      ],
    };
    const legacyMixedSuper: Session = {
      ...session,
      id: 'h-legacy-mix',
      status: 'completed',
      startedAt: NOW - 100_000,
      endedAt: NOW - 90_000,
      exercises: [
        {
          ...exA,
          id: 'hx-mix',
          target: {
            kind: 'dropSet',
            form: 'superset',
            rounds: 1,
            stages: [
              { id: 'st1', label: exA.name, weightKg: 20, repsMin: 10, repsMax: 12, toFailure: false, targetText: '' },
              { id: 'st2', label: '杠铃硬拉', weightKg: 180, repsMin: 5, repsMax: 5, toFailure: false, targetText: '' },
            ],
            restInSec: 15,
            restAfterSec: 90,
            weightMode: exA.target.weightMode,
          },
          groups: [{ index: 1, stageCount: 2 }],
          sets: [
            { id: 'ms1', roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 22, status: 'done' },
            { id: 'ms2', roundIndex: 1, stageIndex: 2, reps: 5, weightKg: 180, status: 'done' },
          ],
        },
      ],
    };
    const prReport = detectSessionPRs([straightHist, legacyMixedSuper], legacyMixedSuper);
    const achieved = prReport.prs.find((p) => p.sessionExerciseId === 'hx-mix');
    // 绝不能拿硬拉的 180kg 当 exA 的 PR！最高只能取匹配 stages[0] 的 22kg
    expect(achieved?.weightKg).toBe(22);

    const histStats = buildExerciseHistory([straightHist, legacyMixedSuper], exA.exerciseId);
    expect(histStats?.maxWeightKg).toBe(22);
    void pairExercisesAsSuperset;
  });

  it('历史纠错、识图草稿新建计划、已有计划定向修改与完训同步保留长期计划新增动作', async () => {
    const { plan, session } = await seedPlanAndActiveSession({ mountRuntime: true });
    // 完训后做历史纠错
    const fin = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 10_000 },
      guard: { editorId: 'editor-live-1', expectedVersion: revisionOf(session), advanceCycle: false },
    });
    expect(fin.ok).toBe(true);
    if (!fin.ok) throw new Error('finish failed');

    const histEdit = await coachCorrectHistory({
      sessionId: session.id,
      expectedRevision: fin.revision,
      action: 'correct_set',
      exId: session.exercises[0].id,
      roundIndex: 1,
      reps: 15,
      weightKg: 70,
    });
    expect((await getSession(session.id))!.exercises[0].sets[0].reps).toBe(15);

    // 识图草稿新建计划（含配对 group 与自动孤立清理）
    const draft = extractPlanDraftFromImage(
      {
        id: 'att-1',
        name: 'plan.jpg',
        mimeType: 'image/jpeg',
        dataBase64: 'AAAA',
        width: 1200,
        height: 900,
        sizeBytes: 12000,
        exifStripped: true,
      },
      '平板杠铃卧推 4x8-10 60kg\n哑铃飞鸟 3x12 14kg',
    );
    draft.days[0].exercises[0].pairGroup = 'G1';
    draft.days[0].exercises[1].pairGroup = 'G1';
    draft.days[0].exercises.push({
      name: '单臂滑轮侧平举',
      kind: 'straight',
      sets: 3,
      repsMin: 15,
      repsMax: 15,
      weightMode: 'external',
      suggestedWeightKg: 5,
      pairGroup: 'ORPHAN_SINGLE',
    });

    const createdPlanRes = await coachCreatePlanFromDraft({ draft });
    const createdPlan = (await getPlan(createdPlanRes.plan!.id))!;
    expect(isValidUuidV4(createdPlan.days[0].exercises[0].pairId)).toBe(true);
    expect(createdPlan.days[0].exercises[0].pairId).toBe(createdPlan.days[0].exercises[1].pairId);
    // 单个孤立 pairGroup 必须已清掉 pairId
    expect(createdPlan.days[0].exercises[2].pairId).toBeUndefined();

    // 修改已有计划（移除第二个配对动作 → 第一个 pairId 自动清除）
    await coachModifyExistingPlan({
      planId: createdPlan.id,
      expectedUpdatedAt: createdPlan.updatedAt,
      action: {
        kind: 'remove_exercise',
        dayId: createdPlan.days[0].id,
        exId: createdPlan.days[0].exercises[1].id,
      },
    });
    const modifiedPlan = (await getPlan(createdPlan.id))!;
    expect(modifiedPlan.days[0].exercises[0].pairId).toBeUndefined();

    // 完训同步回原计划：开启第 2 场训练并在期间向长期原计划新增无关动作，再 sync-to-plan 不得覆盖长期新增动作！
    const s2 = createSession(plan, plan.days[0], NOW + 20_000);
    await atomicCreateSession({ session: s2 });
    const s2Db = (await getSession(s2.id))!;

    // 会话期间把第 1 个动作 restSec 改成 90s（会话内编排调整）
    await coachAdjustActiveTarget({
      sessionId: s2Db.id,
      exId: s2Db.exercises[0].id,
      restSec: 90,
    });

    // 会话期间同时向长期原计划额外新增一个不冲突的新动作「悬垂举腿」
    const latestPlan = (await getPlan(plan.id))!;
    await coachModifyExistingPlan({
      planId: latestPlan.id,
      expectedUpdatedAt: latestPlan.updatedAt,
      action: {
        kind: 'add_exercise',
        dayId: plan.days[0].id,
        name: '悬垂举腿',
      },
    });

    // 仅改本次会话：原计划不应被改写
    const onlySess = await coachSyncSessionToPlan({ sessionId: s2Db.id, scope: 'session-only' });
    expect(onlySess.synced).toBe(false);

    // 同步回原计划：必须合并保留长期计划刚新增的「悬垂举腿」，并把第 1 个动作的 restSec 更新为 90
    const synced = await coachSyncSessionToPlan({ sessionId: s2Db.id, scope: 'sync-to-plan' });
    expect(synced.synced).toBe(true);
    const syncedPlan = (await getPlan(plan.id))!;
    expect(syncedPlan.days[0].exercises[0].restSec).toBe(90);
    expect(syncedPlan.days[0].exercises.some((e) => e.name === '悬垂举腿')).toBe(true);
    void histEdit;
  });

  it('tx.ts finish/discard 终态错配与过期 active revision 校验', async () => {
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true });
    // 过期 revision 禁止 finish
    const bump = await coachRecordActiveSet({
      sessionId: session.id,
      exId: session.exercises[0].id,
      roundIndex: 1,
      reps: 8,
      weightKg: 60,
    });
    const staleFinish = await atomicFinishSession({
      session: { ...bump.session!, status: 'completed', endedAt: NOW + 5000 },
      guard: { editorId: 'editor-live-1', expectedVersion: revisionOf(session), advanceCycle: false },
    });
    expect(staleFinish.ok).toBe(false);
    expect(!staleFinish.ok && staleFinish.reason).toBe('version-conflict');

    // 先 discard，然后尝试 finish 终态错配必须返回 state-conflict
    const cur = (await getSession(session.id))!;
    const dis = await atomicDiscardSession({
      session: { ...cur, status: 'discarded', endedAt: NOW + 6000 },
      guard: { editorId: 'editor-live-1', expectedVersion: revisionOf(cur) },
    });
    expect(dis.ok).toBe(true);

    const wrongFin = await atomicFinishSession({
      session: { ...cur, status: 'completed', endedAt: NOW + 7000 },
      guard: { lockPolicy: 'optional' },
    });
    expect(wrongFin.ok).toBe(false);
    expect(!wrongFin.ok && wrongFin.reason).toBe('state-conflict');
  });

  it('冷启动第 41 条之外跨历史查询自动触发 ensureFullHistory + 只读范围不越权写热身/有氧/档位', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);

    for (let i = 1; i <= 45; i += 1) {
      const s = createSession(plan, plan.days[0], NOW - (46 - i) * 86_400_000);
      await atomicCreateSession({
        session: {
          ...s,
          id: `hist-${i}`,
          status: 'completed',
          startedAt: NOW - (46 - i) * 86_400_000,
          endedAt: NOW - (46 - i) * 86_400_000 + 3_600_000,
          day: {
            ...s.day,
            dayName: i === 45 ? '第45次最早记录日' : `历史第${i}天`,
          },
        },
      });
    }

    const ensureFullHistory = vi.fn(async () => {});
    const roCtx = await buildCoachReadOnlyContext(
      { historyHydrated: false, ensureFullHistory },
      { includeAllHistory: true },
    );
    expect(ensureFullHistory).toHaveBeenCalledTimes(1);
    expect(roCtx.totalCompletedSessions).toBe(45);
    expect(roCtx.cardioPresets.length).toBe(6);

    const queryReply = await runCoachTurn({
      userText: '帮我查一下全部历史里最早那次练了什么？',
      history: [],
      toolContext: { historyHydrated: false, ensureFullHistory },
      streamChunkDelayMs: 0,
    });
    expect(ensureFullHistory).toHaveBeenCalledTimes(2);
    expect(queryReply.text).toContain('45');

    // 只读范围：要求改热身 / 器械档位备忘 → 诚实拒改且不生成写回执
    const { session: actSess } = await seedPlanAndActiveSession({ sessionId: 'sess-ro-1', mountRuntime: true });
    const roTurn = await runCoachTurn({
      userText: '帮我把今天的热身肩袖改为 3 组，并把器械档位备忘改成第 5 格',
      history: [],
      toolContext: { activeSession: actSess },
      streamChunkDelayMs: 0,
    });
    expect(roTurn.receipts.length).toBe(0);
    expect(roTurn.text).toContain('只读');
    expect((await getSession('sess-ro-1'))!.exercises[0].setupNote).toBe('座椅第 4 格，保护杆第 2 孔');

    // 通过底层 executeCoachToolCall 也不存在任何未注册写工具
    const unknownOutcome = await executeCoachToolCall(
      { id: 'c-bad', name: 'mutate_setup_note', argumentsText: '{}', arguments: {} },
      { activeSession: actSess },
    );
    expect(unknownOutcome.ok).toBe(false);
  });

  it('图片压缩强制 <= 1536px、剥离 EXIF APP1、<= 1MB，超限显式报错拒绝', async () => {
    const rawWithExif = makeFakeJpegWithExif(120_000);
    expect(containsExifMetadata(rawWithExif)).toBe(true);
    const stripped = stripExifFromJpegBytes(rawWithExif);
    expect(containsExifMetadata(stripped)).toBe(false);

    // 模拟 3072×2048 大图与随 quality/width 递减的编码器
    const att = await compressWithEncoder(
      3072,
      2048,
      async ({ width, quality }) => {
        const size = quality >= 0.7 ? 1_400_000 : Math.round((width / 1536) * quality * 900_000);
        return { mimeType: 'image/jpeg', bytes: makeFakeJpegWithExif(size) };
      },
      { name: 'big.jpg' },
    );
    expect(Math.max(att.width, att.height)).toBeLessThanOrEqual(1536);
    expect(att.sizeBytes).toBeLessThanOrEqual(1_048_576);
    expect(att.exifStripped).toBe(true);
    expect(containsExifMetadata(att.dataBase64)).toBe(false);

    // 即使降至最低质量与分辨率仍 > 1MB 时显式拒绝
    await expect(
      compressWithEncoder(4000, 3000, async () => ({
        mimeType: 'image/jpeg',
        bytes: new Uint8Array(1_300_000),
      })),
    ).rejects.toThrow(/超过.*KB/);
  });

  it('存储域红线与恢复纪元：教练消息/Key/图片/回执零污染 BackupPayload v4，恢复后历史回执自动失效', async () => {
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true });
    await saveCoachProviderConfig({
      kind: 'openai-compatible',
      baseUrl: 'https://mock.local/v1',
      model: 'gpt-4.1-mini',
      apiKey: 'sk-secret-isolated-key',
    });
    await saveCoachMessages([
      {
        id: 'm1',
        role: 'user',
        createdAt: NOW,
        text: '测试消息',
        attachments: [
          {
            id: 'a1',
            name: 'p.jpg',
            mimeType: 'image/jpeg',
            dataBase64: 'QUFB',
            width: 800,
            height: 600,
            sizeBytes: 3,
          },
        ],
      },
    ]);
    const rec = await coachRecordActiveSet({
      sessionId: session.id,
      exId: session.exercises[0].id,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
    });

    const backup = await buildBackup(CURRENT_APP_VERSION);
    const jsonText = JSON.stringify(backup);
    expect(validateBackup(backup).ok).toBe(true);
    expect(
      findV4Contraband(backup.data).filter((x) => !x.path.endsWith('setupNote')),
    ).toEqual([]);
    expect(jsonText).not.toContain('sk-secret-isolated-key');
    expect(jsonText).not.toContain('motion-coach-vault');
    expect(jsonText).not.toContain(rec.receipt.id);
    expect((await loadCoachMessages()).length).toBe(1);
    expect((await listCoachReceipts()).length).toBe(1);

    // 执行备份恢复：restoreEpoch 递增，恢复前生成的回执点击撤销必须被安全拦截（epoch-mismatch）
    const epochBefore = await getCoachRestoreEpoch();
    await restoreBackup(backup);
    const epochAfter = await getCoachRestoreEpoch();
    expect(epochAfter).toBeGreaterThan(epochBefore);

    await expect(undoCoachReceipt(rec.receipt.id)).rejects.toMatchObject({
      name: 'TxConflictError',
      reason: 'epoch-mismatch',
    });
  });

  it('在线多轮 SSE tool_call 循环 + 中途 AbortSignal 取消不回滚已提交写回执', async () => {
    const { session } = await seedPlanAndActiveSession({ mountRuntime: true });
    const ex = session.exercises[0];
    let turnCallCount = 0;

    vi.stubGlobal('fetch', vi.fn(async () => {
      turnCallCount += 1;
      if (turnCallCount === 1) {
        return sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'tc-live-1',
                      function: {
                        name: 'adjust_active_target',
                        arguments: JSON.stringify({
                          sessionId: session.id,
                          exId: ex.id,
                          repsMin: 15,
                          repsMax: 15,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      }
      return sseResponse([
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '已为你将目标调整为每组 15 次。' }, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }));

    try {
      const liveRes = await runCoachTurn({
        userText: '帮我把目标改成 15 次',
        history: [],
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://mock.coach/v1',
          model: 'test-model',
          apiKey: 'sk-test-123',
          updatedAt: NOW,
        },
        toolContext: { activeSession: session },
      });

      expect(liveRes.receipts.length).toBe(1);
      expect(liveRes.text).toContain('15 次');
      const updatedTarget = (await getSession(session.id))!.exercises[0].target;
      expect(updatedTarget.kind === 'straight' && updatedTarget.repsMax).toBe(15);

      // 测试取消生成中的新流式请求，不得影响前面已提交的 receipt/DB
      const ac = new AbortController();
      const promise = runCoachTurn({
        userText: '再来聊一段很长很长的复盘建议',
        history: [],
        toolContext: { activeSession: await getSession(session.id) },
        signal: ac.signal,
        streamChunkDelayMs: 60,
      });
      setTimeout(() => ac.abort(), 30);
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect((await listCoachReceipts()).some((r) => r.id === liveRes.receipts[0].id && !r.undone)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
