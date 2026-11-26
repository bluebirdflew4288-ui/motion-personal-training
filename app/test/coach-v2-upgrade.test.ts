/* 0.2.2 电子教练全面升级测试（15 大场景全覆蓋）：
   1. 替换/增删进行中动作（器械二头 -> 21响礼炮 3 阶段递减结构 + 撤销）
   2. 自由转换组型（straight / dropSet / superset）与已记组防误删保护
   3. 训练中整场 / 动作 / 单组备注（含“加餐”追加、500 字组备注上限与撤销）
   4. restSec 透明度（上下文可见 restSec、调休息秒数生成前后差值回执、递减组 restAfterSec 与撤销恢复）
   5. 多阶段动作计数一致性（21响礼炮 2轮×3阶段 = 2完成组，不按6组计）
   6. 直接完训 finish_active_session（undoable: false、停计时器、拒撤）+ 完训前后 sync_session_to_plan
   7. 历史补加组（append_group 带 reps/weightKg/status/note 使 20 -> 30）与历史有氧纠错
   8. 已解锁热身、6种有氧预设+启停、跨计划器械档位备忘读写与撤销 + Backup v4 零污染
   9. 修改既有计划扩展（替换动作/增改删热身/增改删有氧/更新目标组型与阶段）
   10. Hermes 长期记忆（读写去重/置顶截断/撤销 + 跨会话关键词检索）
   11. 上下文窗口统计与 OpenAI stream_options 400 回退 / Gemini usageMetadata 真实用量解析
   12. CoachMarkdown 无 XSS 渲染、流式未闭合代码块容错、3*10 乘号保留与 javascript: 链接拦截
   13. 系统提示词反 AI 八股、注入记忆与 21 响礼炮口径校验
   14. 联网搜索（Tavily / Bocha / Brave）与 Gemini GoogleSearch + FunctionDeclarations 400 冲突两阶段自动回退
   15. 原生后台流式网络桥（createNativeStreamFetch）断连切回增量补拉与 seq 去重 + 中止取消 */

import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findV4Contraband } from '../src/db/backupCompat';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, getPlan, getSession, listPlans, savePlan } from '../src/db/repo';
import { listExerciseTemplates } from '../src/db/templates';
import { atomicCreateSession } from '../src/db/tx';
import { CARDIO_PRESET_CHOICES, createCardioEntry } from '../src/domain/cardio';
import { trainingFormOf } from '../src/domain/exerciseConfig';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession, restAfterSet } from '../src/domain/session';
import type { Plan, Session } from '../src/domain/types';
import { buildCoachSystemPrompt, compressCoachContext, runCoachTurn } from '../src/coach/coachAgent';
import {
  computeCoachContextStats,
  formatCompactTokens,
  formatContextPercent,
  resolveModelContextWindow,
  shouldAutoCompressContext,
} from '../src/coach/coachContext';
import { CoachMarkdown } from '../src/coach/CoachMarkdown';
import {
  formatCoachMemoryForPrompt,
  loadCoachMemory,
  searchCoachMemoryAndThreads,
} from '../src/coach/coachMemory';
import {
  createNativeStreamFetch,
  type CoachStreamDeltaEvent,
  type CoachStreamPluginShape,
} from '../src/coach/coachNativeStream';
import {
  resetCoachVaultForTest,
  saveCoachMessages,
  saveCoachThreadsState,
  type CoachStoredProviderConfig,
} from '../src/coach/coachStorage';
import { buildCoachReadOnlyContext } from '../src/coach/coachTools';
import {
  coachAdjustActiveTarget,
  coachCorrectHistory,
  coachFinishActiveSession,
  coachManageActiveCardio,
  coachManageActiveExercise,
  coachManageActiveWarmup,
  coachManageMemory,
  coachModifyExistingPlan,
  coachRecordActiveSet,
  coachSyncSessionToPlan,
  coachUpdateActiveNote,
  coachUpdateSetupNote,
  undoCoachReceipt,
} from '../src/coach/coachTx';
import {
  parseBingHtml,
  parseBingRss,
  parseDuckDuckGoHtml,
  parseSo360Html,
  runCoachWebSearch,
} from '../src/coach/coachWebSearch';
import { __resetFocusGuardForTest } from '../src/coach/focusGuard';
import { streamCoachTurn, type CoachStreamEvent } from '../src/coach/providerAdapter';
import { registerSessionRuntime } from '../src/coach/sessionRuntimeBridge';
import { acquireSessionLock } from '../src/lib/lock';

const NOW = 1_765_500_000_000;

async function resetAll(): Promise<void> {
  registerSessionRuntime(null);
  __resetFocusGuardForTest();
  await resetCoachVaultForTest();
  __resetDbHandle();
  await idbClear('plans');
  await idbClear('sessions');
  await idbClear('settings');
  await idbClear('meta');
}

function makeBackAPlan(): Plan {
  const base = createV32Plan(NOW);
  const backDay: Plan['days'][number] = {
    ...base.days[0],
    id: 'day-back-a',
    name: '背 A · 上背与二头',
    kind: 'train',
    focus: 'back',
    warmups: [{ id: 'w-lat', name: '弹力带肩激活', unit: 'reps', targetText: '2×15' }],
    exercises: [
      {
        id: 'ex-row',
        exerciseId: 'barbell-row',
        name: '俯身杠铃划船',
        target: {
          kind: 'straight',
          sets: 3,
          setsMax: 3,
          repsMin: 8,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: 60,
        },
        restSec: 90,
      },
      {
        id: 'ex-bicep',
        exerciseId: 'machine-curl',
        name: '器械二头弯举',
        target: {
          kind: 'straight',
          sets: 3,
          setsMax: 3,
          repsMin: 10,
          repsMax: 15,
          weightMode: 'external',
          suggestedWeightKg: 25,
        },
        restSec: 90,
      },
      {
        id: 'ex-hammer',
        exerciseId: 'hammer-curl',
        name: '锤式弯举',
        target: {
          kind: 'straight',
          sets: 2,
          setsMax: 2,
          repsMin: 10,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: 12,
          dumbbellBasis: 'per_hand',
        },
        restSec: 90,
      },
    ],
  };
  const cardioDay: Plan['days'][number] = {
    id: 'day-cardio',
    name: '有氧恢复日',
    kind: 'cardio',
    warmups: [],
    exercises: [],
    cardio: [],
  };
  return {
    ...base,
    id: 'plan-back-a',
    name: '三分化背 A',
    days: [backDay, cardioDay],
    cursor: 0,
  };
}

function exIdByName(session: Session, name: string): string {
  const found = session.exercises.find((e) => e.name === name);
  if (!found) throw new Error(`Missing exercise ${name}`);
  return found.id;
}

async function seedBackActiveSession(opts?: {
  sessionId?: string;
  stopRestTimer?: () => void;
}): Promise<{ plan: Plan; session: Session }> {
  const plan = makeBackAPlan();
  await savePlan(plan);
  const raw = createSession(plan, plan.days[0], NOW);
  const session: Session = {
    ...raw,
    id: opts?.sessionId ?? 'sess-v2-active',
  };
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  await acquireSessionLock(fresh.id, 'editor-v2');
  registerSessionRuntime({
    sessionId: fresh.id,
    editorId: 'editor-v2',
    awaitPendingWrites: async () => undefined,
    applyCommittedSession: () => undefined,
    hasBlockingDrafts: () => false,
    startRestTimer: () => undefined,
    stopRestTimer: opts?.stopRestTimer,
  });
  return { plan, session: fresh };
}

describe('0.2.2 电子教练全面升级回归', () => {
  beforeEach(async () => {
    await resetAll();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 动作替换（器械二头 -> 21响礼炮 3阶段）、新增与删除及撤销还原', async () => {
    const { session } = await seedBackActiveSession();
    const bicepId = exIdByName(session, '器械二头弯举');

    const turn = await runCoachTurn({
      userText: '把器械二头弯举换成21响礼炮',
      history: [],
      toolContext: { activeSession: session },
      streamChunkDelayMs: 0,
    });
    expect(turn.receipts).toHaveLength(1);

    let current = (await getSession(session.id))!;
    const replaced = current.exercises.find((e) => e.name === '21响礼炮')!;
    expect(replaced).toBeTruthy();
    expect(replaced.name).toBe('21响礼炮');
    expect(replaced.target.kind).toBe('dropSet');
    if (replaced.target.kind === 'dropSet') {
      expect(replaced.target.stages.length).toBe(3);
    }

    // 撤销恢复为器械二头弯举
    await undoCoachReceipt(turn.receipts[0].id);
    current = (await getSession(session.id))!;
    expect(current.exercises.find((e) => e.id === bicepId)!.name).toBe('器械二头弯举');
    expect(current.exercises.find((e) => e.id === bicepId)!.target.kind).toBe('straight');

    // 新增动作后移除未开始的动作
    const added = await coachManageActiveExercise({
      operationId: 'op-add-ex',
      sessionId: session.id,
      mode: 'add',
      newName: '绳索面拉',
      sets: 3,
      repsMin: 12,
      repsMax: 15,
    });
    current = added.session!;
    const facePull = current.exercises.find((e) => e.name === '绳索面拉')!;
    expect(facePull).toBeTruthy();

    const removed = await coachManageActiveExercise({
      operationId: 'op-rm-ex',
      sessionId: session.id,
      mode: 'remove',
      exId: facePull.id,
    });
    expect(removed.session!.exercises.some((e) => e.name === '绳索面拉')).toBe(false);
  });

  it('2. 自由切换组型（普通组 / 递减组 / 超级组）与已记组防误丢弃保护', async () => {
    const { session } = await seedBackActiveSession();
    const rowId = exIdByName(session, '俯身杠铃划船');

    // 先将组1记成 done，验证默认 convert_form 拒绝直接清空实绩
    await coachRecordActiveSet({
      operationId: 'op-log-1',
      sessionId: session.id,
      exId: rowId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      status: 'done',
    });

    await expect(
      coachManageActiveExercise({
        operationId: 'op-conv-blocked',
        sessionId: session.id,
        mode: 'convert_form',
        exId: rowId,
        form: 'dropSet',
      }),
    ).rejects.toThrow();

    // 显式 allowDiscardLoggedData 后成功转换到 dropSet，并支持切到 superset 再切回 straight
    const toDrop = await coachManageActiveExercise({
      operationId: 'op-conv-drop',
      sessionId: session.id,
      mode: 'convert_form',
      exId: rowId,
      form: 'dropSet',
      allowDiscardLoggedData: true,
    });
    expect(trainingFormOf(toDrop.session!.exercises[0].target)).toBe('dropSet');

    const toSuper = await coachManageActiveExercise({
      operationId: 'op-conv-super',
      sessionId: session.id,
      mode: 'convert_form',
      exId: rowId,
      form: 'superset',
    });
    expect(trainingFormOf(toSuper.session!.exercises[0].target)).toBe('superset');

    // 撤销最新一次转换（回到 dropSet）
    await undoCoachReceipt(toSuper.receipt.id);
    const backDrop = (await getSession(session.id))!.exercises[0];
    expect(trainingFormOf(backDrop.target)).toBe('dropSet');

    // 再单独测试 straight -> dropSet -> 撤销恢复带已完成组
    const straight2Drop = await coachManageActiveExercise({
      operationId: 'op-conv-back-straight',
      sessionId: session.id,
      mode: 'convert_form',
      exId: rowId,
      form: 'straight',
    });
    expect(trainingFormOf(straight2Drop.session!.exercises[0].target)).toBe('straight');
    await undoCoachReceipt(straight2Drop.receipt.id);
    expect(trainingFormOf((await getSession(session.id))!.exercises[0].target)).toBe('dropSet');
  });

  it('3. 进行中备注写入（整场 / 动作 / 单组追加及 500 字组备注上限）与撤销', async () => {
    const { session } = await seedBackActiveSession();
    const rowId = exIdByName(session, '俯身杠铃划船');
    const hammerId = exIdByName(session, '锤式弯举');

    const sessNote = await coachUpdateActiveNote({
      operationId: 'op-note-sess',
      sessionId: session.id,
      scope: 'session',
      note: '今日状态不错，左前臂轻微紧张',
    });
    expect(sessNote.session!.note).toBe('今日状态不错，左前臂轻微紧张');

    await coachUpdateActiveNote({
      operationId: 'op-note-ex-1',
      sessionId: session.id,
      scope: 'exercise',
      exId: hammerId,
      note: '主体2组',
    });
    const exNote2 = await coachUpdateActiveNote({
      operationId: 'op-note-ex-2',
      sessionId: session.id,
      scope: 'exercise',
      exId: hammerId,
      note: '另5次/手为自选加餐，不计入实绩',
      append: true,
    });
    expect(exNote2.session!.exercises[2].note).toContain('主体2组');
    expect(exNote2.session!.exercises[2].note).toContain('自选加餐');
    await undoCoachReceipt(exNote2.receipt.id);
    expect((await getSession(session.id))!.exercises[2].note).toBe('主体2组');

    await expect(
      coachRecordActiveSet({
        operationId: 'op-rec-note-too-long',
        sessionId: session.id,
        exId: rowId,
        roundIndex: 1,
        reps: 10,
        weightKg: 60,
        status: 'done',
        note: 'a'.repeat(501),
      }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });

    const recWithNote = await coachRecordActiveSet({
      operationId: 'op-rec-note',
      sessionId: session.id,
      exId: rowId,
      roundIndex: 1,
      reps: 10,
      weightKg: 60,
      status: 'done',
      note: 'a'.repeat(500),
    });
    expect(recWithNote.session!.exercises[0].sets[0].note!.length).toBe(500);
  });

  it('4. restSec 上下文可见、调整时回执明确前后秒数、递减组同步 restAfterSec 且支持撤销', async () => {
    const { session } = await seedBackActiveSession();
    const rowId = exIdByName(session, '俯身杠铃划船');
    const bicepId = exIdByName(session, '器械二头弯举');

    const beforeCtx = await buildCoachReadOnlyContext({ activeSession: session });
    expect(beforeCtx.activeSession!.exercises[0].restSec).toBe(90);

    const res = await coachAdjustActiveTarget({
      operationId: 'op-rest-120',
      sessionId: session.id,
      exId: rowId,
      restSec: 120,
    });
    expect(res.receipt.summary).toContain('90s → 120s');
    expect((await getSession(session.id))!.exercises[0].restSec).toBe(120);
    await undoCoachReceipt(res.receipt.id);
    expect((await getSession(session.id))!.exercises[0].restSec).toBe(90);

    // 切到递减组并修改 restAfterSec，检验首阶段短间歇与末阶段 restAfterSet 读取
    await coachManageActiveExercise({
      operationId: 'op-drop-2',
      sessionId: session.id,
      mode: 'convert_form',
      exId: bicepId,
      form: 'dropSet',
    });
    const dropRest = await coachAdjustActiveTarget({
      operationId: 'op-drop-rest',
      sessionId: session.id,
      exId: bicepId,
      restAfterSec: 150,
    });
    const dropEx = dropRest.session!.exercises.find((e) => e.id === bicepId)!;
    const round1Sets = dropEx.sets.filter((s) => s.roundIndex === 1);
    expect(restAfterSet(dropEx, round1Sets[round1Sets.length - 1])).toBe(150);
  });

  it('5. 多阶段动作计数一致性（21响礼炮 2 轮 × 3 阶段 = 2 完成组，而非 6）', async () => {
    const { session } = await seedBackActiveSession();
    const bicepId = exIdByName(session, '器械二头弯举');
    await coachManageActiveExercise({
      operationId: 'op-rep-21',
      sessionId: session.id,
      mode: 'replace',
      exId: bicepId,
      newName: '21响礼炮',
      form: 'dropSet',
      sets: 2,
    });
    const cur = (await getSession(session.id))!;
    const cannon = cur.exercises.find((e) => e.name === '21响礼炮')!;
    // 记完第 1 轮与第 2 轮的所有阶段（2 × 3 = 6 行）
    for (const s of cannon.sets) {
      await coachRecordActiveSet({
        operationId: `op-s-${s.id}`,
        sessionId: session.id,
        exId: cannon.id,
        setId: s.id,
        reps: 7,
        weightKg: 10,
        status: 'done',
      });
    }

    const roCtx = await buildCoachReadOnlyContext({ activeSession: (await getSession(session.id))! });
    const cannonCtx = roCtx.activeSession!.exercises.find((e) => e.name === '21响礼炮')!;
    expect(cannonCtx.sets.length).toBe(6);
    expect(cannonCtx.completedGroups).toBe(2);
    expect(roCtx.activeSession!.summary.completedGroups).toBe(2);
    expect(roCtx.activeSession!.summary.completedStages).toBe(6);

    // 完训进入历史后同样按大组计为 2 组
    await coachFinishActiveSession({
      operationId: 'op-fin-cnt',
      sessionId: session.id,
    });
    const histCtx = await buildCoachReadOnlyContext({}, { includeAllHistory: true });
    expect(histCtx.historySessions[0].completedSets).toBe(2);
    expect(histCtx.historySessions[0].exercises.find((e) => e.name === '21响礼炮')!.setsCount).toBe(2);
  });

  it('6. 直接结束本次训练（undoable=false 停计时器）与完训后按历史 ID 同步回原计划', async () => {
    const stopRestTimer = vi.fn();
    const { plan, session } = await seedBackActiveSession({ stopRestTimer });
    const rowId = exIdByName(session, '俯身杠铃划船');

    // 修改本场划船重量后再直接结束训练
    await coachAdjustActiveTarget({
      operationId: 'op-adj-before-end',
      sessionId: session.id,
      exId: rowId,
      suggestedWeightKg: 75,
    });

    const finTurn = await runCoachTurn({
      userText: '帮我直接结束这次训练',
      history: [],
      toolContext: { activeSession: (await getSession(session.id))! },
      streamChunkDelayMs: 0,
    });
    expect(finTurn.receipts).toHaveLength(1);
    expect(finTurn.receipts[0].undoable).toBe(false);
    expect(stopRestTimer).toHaveBeenCalledTimes(1);
    expect((await getSession(session.id))!.status).toBe('completed');

    // 已完训回执不可撤销
    await expect(undoCoachReceipt(finTurn.receipts[0].id)).rejects.toThrow();

    // 完训后仍允许按历史 sessionId 同步回原计划
    const syncAfter = await coachSyncSessionToPlan({
      operationId: 'op-sync-after',
      sessionId: session.id,
      scope: 'sync-to-plan',
    });
    expect(syncAfter.plan).toBeTruthy();
    const updatedPlan = (await getPlan(plan.id))!;
    const rowInPlan = updatedPlan.days[0].exercises.find((e) => e.name === '俯身杠铃划船')!;
    if (rowInPlan.target.kind === 'straight') {
      expect(rowInPlan.target.suggestedWeightKg).toBe(75);
    }

    await undoCoachReceipt(syncAfter.receipt!.id);
    const rolledPlan = (await getPlan(plan.id))!;
    const rolledRow = rolledPlan.days[0].exercises.find((e) => e.name === '俯身杠铃划船')!;
    if (rolledRow.target.kind === 'straight') {
      expect(rolledRow.target.suggestedWeightKg).toBe(60);
    }
  });

  it('7. 历史补加一组（append_group 直接写入 reps/weightKg/status/note）与有氧记录纠错', async () => {
    const plan = makeBackAPlan();
    await savePlan(plan);
    const raw = createSession(plan, plan.days[0], NOW);
    const cardioEntry = createCardioEntry({
      preset: 'treadmill-incline',
      name: '爬坡步行',
      params: { speedKmh: 5, inclinePct: 10 },
    });
    const sessWithCardio: Session = {
      ...raw,
      id: 'sess-hist-fix',
      cardio: [
        {
          ...cardioEntry,
          id: 'c-tread',
          status: 'done',
          elapsedMs: 600_000,
          segments: [{ id: 'seg-1', startElapsedMs: 0, endElapsedMs: 600_000, params: cardioEntry.currentParams }],
        },
      ],
    };
    await atomicCreateSession({ session: sessWithCardio });
    await coachFinishActiveSession({ operationId: 'op-fin-hist', sessionId: 'sess-hist-fix' });

    // 给锤式弯举补加第 3 组实绩 10 次 12kg
    const appended = await coachCorrectHistory({
      operationId: 'op-hist-app',
      sessionId: 'sess-hist-fix',
      action: 'append_group',
      exerciseName: '锤式弯举',
      reps: 10,
      weightKg: 12,
      status: 'done',
      note: '加练第 3 组 10 次/手',
    });
    const hammer = appended.session!.exercises.find((e) => e.name === '锤式弯举')!;
    expect(hammer.sets.length).toBe(3);
    expect(hammer.sets[2]).toMatchObject({
      reps: 10,
      weightKg: 12,
      status: 'done',
      note: '加练第 3 组 10 次/手',
    });

    // 修改历史有氧时长从 10 分钟改为 18 分钟 + 备注
    const fixedCardio = await coachCorrectHistory({
      operationId: 'op-hist-cardio',
      sessionId: 'sess-hist-fix',
      action: 'correct_cardio',
      cardioName: '爬坡步行',
      durationSec: 18 * 60,
      note: '降坡完成有氧',
    });
    expect(fixedCardio.session!.cardio![0].elapsedMs).toBe(18 * 60 * 1000);
    expect(fixedCardio.session!.cardio![0].note).toBe('降坡完成有氧');

    await undoCoachReceipt(fixedCardio.receipt.id);
    expect((await getSession('sess-hist-fix'))!.cardio![0].elapsedMs).toBe(600_000);
  });

  it('8. 全权限解锁（热身增删改勾、6 种有氧启停调参、跨计划器械档位）+ Backup v4 零污染', async () => {
    const { session } = await seedBackActiveSession();

    // 热身勾选、新增与撤销
    const wToggle = await coachManageActiveWarmup({
      operationId: 'op-w-tog',
      sessionId: session.id,
      action: 'toggle_done',
      warmupName: '弹力带肩激活',
      done: true,
    });
    expect(wToggle.session!.warmups[0].done).toBe(true);

    const wAdd = await coachManageActiveWarmup({
      operationId: 'op-w-add',
      sessionId: session.id,
      action: 'add',
      name: '猫牛式放松',
      unit: 'time',
      targetText: '60秒',
    });
    expect(wAdd.session!.warmups).toHaveLength(2);

    // 6 种有氧预设全部可创建，并走 start -> pause -> complete
    for (const c of CARDIO_PRESET_CHOICES) {
      const addRes = await coachManageActiveCardio({
        operationId: `op-c-add-${c.preset}`,
        sessionId: session.id,
        action: 'add',
        preset: c.preset,
      });
      const createdCardio = addRes.session!.cardio!.find((entry) => entry.preset === c.preset);
      expect(createdCardio).toBeTruthy();
    }
    const firstCardioId = (await getSession(session.id))!.cardio![0].id;
    const started = await coachManageActiveCardio({
      operationId: 'op-c-start',
      sessionId: session.id,
      action: 'start',
      cardioId: firstCardioId,
      params: { speedKmh: 6.2 },
    });
    expect(started.session!.cardio![0].status).toBe('running');
    const paused = await coachManageActiveCardio({
      operationId: 'op-c-pause',
      sessionId: session.id,
      action: 'pause',
      cardioId: firstCardioId,
    });
    expect(paused.session!.cardio![0].status).toBe('paused');

    // 跨计划器械档位写入同步模板 + 活跃会话 + 可撤销
    const setupRes = await coachUpdateSetupNote({
      operationId: 'op-setup-1',
      sessionId: session.id,
      exerciseName: '俯身杠铃划船',
      note: '护腕第 3 格 / 站距窄于肩',
    });
    expect(setupRes.session?.exercises[0].setupNote).toBe('护腕第 3 格 / 站距窄于肩');
    const templates = await listExerciseTemplates();
    expect(templates.find((t) => t.exerciseId === 'barbell-row')?.setupNote).toBe('护腕第 3 格 / 站距窄于肩');
    await undoCoachReceipt(setupRes.receipt.id);
    expect((await getSession(session.id))!.exercises[0].setupNote).toBeUndefined();

    // 写入一条 Hermes 记忆后校验 BackupPayload v4 零污染
    await coachManageMemory({
      operationId: 'op-mem-iso',
      action: 'save',
      category: 'injury',
      title: '左腕轻度不适',
      content: '弯举避免大重量直杆反握',
    });
    const backup = await buildBackup('0.2.2');
    expect(findV4Contraband(backup)).toEqual([]);
    expect(JSON.stringify(backup)).not.toContain('左腕轻度不适');
  });

  it('9. 修改既有计划扩展（替换动作 / 热身增改删 / 有氧增改删 / 更新目标组型阶段）', async () => {
    const plan = makeBackAPlan();
    await savePlan(plan);

    const r1 = await coachModifyExistingPlan({
      operationId: 'op-plan-rep',
      planId: plan.id,
      action: {
        kind: 'replace_exercise',
        dayId: 'day-back-a',
        exerciseName: '器械二头弯举',
        newName: '21响礼炮',
        form: 'dropSet',
      },
    });
    expect(r1.plan!.days[0].exercises.find((e) => e.id === 'ex-bicep')!.name).toBe('21响礼炮');
    expect(r1.plan!.days[0].exercises.find((e) => e.id === 'ex-bicep')!.target.kind).toBe('dropSet');
    await undoCoachReceipt(r1.receipt.id);
    expect((await listPlans()).find((p) => p.id === plan.id)!.days[0].exercises.find((e) => e.id === 'ex-bicep')!.name).toBe('器械二头弯举');

    await coachModifyExistingPlan({
      operationId: 'op-plan-w',
      planId: plan.id,
      action: {
        kind: 'add_warmup',
        dayId: 'day-back-a',
        name: '胸椎灵活性',
        unit: 'reps',
        targetText: '12次',
      },
    });
    const rc = await coachModifyExistingPlan({
      operationId: 'op-plan-c',
      planId: plan.id,
      action: {
        kind: 'add_cardio',
        dayId: 'day-cardio',
        preset: 'elliptical',
        name: '椭圆机放松',
      },
    });
    const curPlan = (await getPlan(plan.id))!;
    expect(curPlan.days[0].warmups).toHaveLength(2);
    expect(curPlan.days[1].cardio?.length).toBe(1);

    await undoCoachReceipt(rc.receipt.id);
    const rolled = (await listPlans()).find((p) => p.id === plan.id)!;
    expect(rolled.days[1].cardio?.length ?? 0).toBe(0);
  });

  it('10. Hermes 长期记忆（保存 / 去重更新 / 置顶优先级与字符预算截断 / 删撤）与跨会话搜索', async () => {
    const rSave = await coachManageMemory({
      operationId: 'op-mem-1',
      action: 'save',
      category: 'equipment',
      title: '家里器械环境',
      content: '只有一对可调哑铃和单杠，没有龙门架',
      pinned: true,
    });
    expect(rSave.receipt.scope).toBe('memory');

    // 同 category + title 自动去重更新
    await coachManageMemory({
      operationId: 'op-mem-2',
      action: 'save',
      category: 'equipment',
      title: '家里器械环境',
      content: '有可调哑铃+单杠+高位下拉配件',
      pinned: true,
    });
    const mem = await loadCoachMemory();
    expect(mem.items).toHaveLength(1);
    expect(mem.items[0].content).toContain('高位下拉配件');

    // 再加一条长内容，验证 formatCoachMemoryForPrompt 置顶优先与 maxChars 裁剪
    await coachManageMemory({
      operationId: 'op-mem-3',
      action: 'save',
      category: 'lesson',
      title: '次要习惯',
      content: '热身尽量控制在十分钟以内，避免消耗过大体能影响主项卧推表现。',
      pinned: false,
    });
    const promptMem = formatCoachMemoryForPrompt(await loadCoachMemory(), 90);
    expect(promptMem).toContain('家里器械环境');
    expect(promptMem.length).toBeLessThanOrEqual(90);

    // 跨会话关键词检索：当前 thread 被排除，能命中另一条历史对话
    await saveCoachThreadsState({
      activeThreadId: 't-cur',
      threads: [
        { id: 't-cur', title: '当前对话', createdAt: NOW, updatedAt: NOW },
        { id: 't-old', title: '上月聊膝盖', createdAt: NOW - 1000, updatedAt: NOW - 1000 },
      ],
    });
    await saveCoachMessages([
      {
        id: 'm-old-1',
        threadId: 't-old',
        role: 'user',
        createdAt: NOW - 1000,
        text: '上次深蹲蹲到一半左膝前侧稍微有点响',
      },
      {
        id: 'm-cur-1',
        threadId: 't-cur',
        role: 'user',
        createdAt: NOW,
        text: '今天还是聊左膝热身',
      },
    ]);
    const searched = await searchCoachMemoryAndThreads('左膝', { excludeThreadId: 't-cur' });
    expect(searched.messages).toHaveLength(1);
    expect(searched.messages[0].threadId).toBe('t-old');
  });

  it('11. DeepSeek 1M 上下文窗口、百分比精度、自动压缩与缓存/推理 Token 解析', async () => {
    expect(resolveModelContextWindow('gemini-2.5-flash')).toBe(1_048_576);
    expect(resolveModelContextWindow('deepseek-v4-pro')).toBe(1_048_576);
    expect(resolveModelContextWindow('deepseek-v4.1-flash-1017')).toBe(1_048_576);
    expect(formatCompactTokens(1_048_576)).toBe('1M');
    expect(formatContextPercent(3000, 1_048_576)).toBe('0.3%');
    expect(formatContextPercent(3456, 131_072)).toBe('3%');

    const stats = computeCoachContextStats({
      model: 'deepseek-v4-pro',
      messages: [
        { id: 'm1', role: 'user', createdAt: 100, text: '你好' },
        { id: 'm2', role: 'assistant', createdAt: 200, text: '练什么？' },
        { id: 'm3', role: 'user', createdAt: 300, text: '今天练背A，加一条备忘' },
      ],
      memoryText: '- [id1] 左肩：注意热身',
      lastUsage: { promptTokens: 4500, updatedAt: 250 },
    });
    expect(stats.isMeasured).toBe(true);
    expect(stats.maxTokens).toBe(1_048_576);
    expect(stats.percentLabel).toBe('0.4%');
    expect(stats.usedTokens).toBeGreaterThan(4500);
    expect(stats.memoryTokens).toBeGreaterThan(0);

    expect(shouldAutoCompressContext({ ...stats, percent: 82 }, 6)).toBe(true);
    expect(shouldAutoCompressContext({ ...stats, percent: 82 }, 5)).toBe(false);
    const comp = await compressCoachContext({
      messages: Array.from({ length: 6 }, (_, i) => ({
        id: `c${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        createdAt: 100 + i,
        text: `测试消息 ${i}`,
      })),
      keepRecent: 4,
    });
    expect(comp.compressedCount).toBe(2);
    expect(comp.summary).toContain('测试消息 0');

    // OpenAI 接口不支持 stream_options 时自动 400 回退一次并消费 usage（含 DeepSeek prompt_cache_hit_tokens + reasoning_tokens）
    let callCount = 0;
    const mockFetch: typeof fetch = vi.fn(async (_url, init) => {
      callCount += 1;
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { stream_options?: unknown };
      if (callCount === 1 && parsed.stream_options) {
        return new Response('unknown field stream_options', { status: 400 });
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"好了"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1230,"completion_tokens":40,"total_tokens":1270,"prompt_cache_hit_tokens":1000,"completion_tokens_details":{"reasoning_tokens":18}}}\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const events: CoachStreamEvent[] = [];
    for await (const ev of streamCoachTurn(
      { kind: 'openai-compatible', baseUrl: 'https://mock.local/v1', model: 'deepseek-v4.1-flash', apiKey: 'k', fetch: mockFetch },
      [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      [],
      { includeUsage: true },
    )) {
      events.push(ev);
    }
    expect(callCount).toBe(2);
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.usage?.promptTokens).toBe(1230);
    expect(done?.type === 'done' && done.usage?.cachedTokens).toBe(1000);
    expect(done?.type === 'done' && done.usage?.reasoningTokens).toBe(18);

    // Gemini usageMetadata & groundingMetadata 解析
    const gemFetch: typeof fetch = vi.fn(async () => {
      const chunk = {
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: '查到了答案' }] },
            groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.org/fit', title: '指南' } }] },
          },
        ],
        usageMetadata: { promptTokenCount: 210, candidatesTokenCount: 15, totalTokenCount: 225 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200 });
    });
    const gemEvents: CoachStreamEvent[] = [];
    for await (const ev of streamCoachTurn(
      { kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash', apiKey: 'k', fetch: gemFetch },
      [{ role: 'user', parts: [{ type: 'text', text: '查一下' }] }],
      [],
      { webSearch: true },
    )) {
      gemEvents.push(ev);
    }
    const gemDone = gemEvents.find((e) => e.type === 'done');
    expect(gemDone?.type === 'done' && gemDone.usage?.totalTokens).toBe(225);
    expect(gemDone?.type === 'done' && gemDone.citations?.[0].url).toBe('https://example.org/fit');
  });

  it('12. CoachMarkdown 安全渲染（保留 3*10 / 未闭合代码块容错 / 拦截 javascript: 协议与 HTML 注入）', () => {
    const md = [
      '## 今日建议',
      '- 平板卧推做 `3*10` 组或 3*10*12 次，重点 **慢离心** 顺带 *轻拉* 激活。',
      '',
      '| 动作 | 重量 | 组数 |',
      '| --- | --- | --- |',
      '| 划船 | 60kg | 3 |',
      '',
      '[安全资料](https://exrx.net) 与 [恶意脚本](javascript:alert(1)) <script>alert(2)</script>',
      '',
      '```json',
      '{"sets": 3',
    ].join('\n');

    const html = renderToStaticMarkup(React.createElement(CoachMarkdown, { text: md, streaming: true }));
    expect(html).toContain('<h2 class="coach-md-h2">今日建议</h2>');
    expect(html).toContain('<table class="coach-md-table">');
    expect(html).toContain('3*10*12');
    expect(html).not.toContain('<em>10</em>');
    expect(html).toContain('<em class="coach-md-em">轻拉</em>');
    expect(html).toContain('<strong class="coach-md-strong">慢离心</strong>');
    expect(html).toContain('href="https://exrx.net"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>');
    expect(html).toContain('is-streaming');
  });

  it('13. 系统提示词反 AI 八股、注入记忆与 21 响礼炮大组计数准则', async () => {
    const { session } = await seedBackActiveSession();
    await coachManageMemory({
      operationId: 'op-mem-p',
      action: 'save',
      category: 'habit',
      title: '直给习惯',
      content: '讨厌废话，只看重点',
      pinned: true,
    });
    const [roCtx, memStore] = await Promise.all([
      buildCoachReadOnlyContext({ activeSession: session }),
      loadCoachMemory(),
    ]);
    const prompt = buildCoachSystemPrompt(roCtx, formatCoachMemoryForPrompt(memStore), '之前练了深蹲');
    expect(prompt).toContain('严禁 AI 八股腔');
    expect(prompt).toContain('21响礼炮');
    expect(prompt).toContain('90秒 → 120秒');
    expect(prompt).toContain('直给习惯');
    expect(prompt).toContain('之前练了深蹲');
    expect(prompt).toContain('restSec');
  });

  it('14. 免 Key 内置多源搜索（DuckDuckGo/360/Bing 级联解析）+ DeepSeek 默认直接联网 + Tavily/Bocha/Brave + Gemini 回退', async () => {
    const ddgHtml = `<a class='result__a' href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffit.example.com%2F21s&amp;rut=1"><b>21响礼炮</b>指南</a><a class='result__snippet'>先下程7次再上程7次最后全程7次。</a>`;
    const soHtml = `<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=abc" data-mdurl="https://so.example.com/bench">卧推肩痛解决</a></h3><p class="res-desc">收紧肩胛骨与适度缩窄握距。</p></li>`;
    const bingHtml = `<li class="b_algo"><h2><a href="https://bing.example.com/row">划船要点</a></h2><div class="b_caption"><p>拉向肚脐方向。</p></div></li>`;
    const bingMobileHtml = `<li class="b_algo"><div class="b_algoheader"><a href="https://bing.example.com/m"><h2>硬拉站距</h2></a></div><p>齐肩宽。</p></li>`;
    const bingRssXml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[深蹲护膝]]></title><link>https://bing.example.com/rss</link><description>保持膝盖对齐脚尖。</description></item></channel></rss>`;

    expect(parseDuckDuckGoHtml(ddgHtml)[0]).toMatchObject({
      title: '21响礼炮 指南',
      url: 'https://fit.example.com/21s',
    });
    expect(parseSo360Html(soHtml)[0]).toMatchObject({
      title: '卧推肩痛解决',
      url: 'https://so.example.com/bench',
    });
    expect(parseBingHtml(bingHtml)[0]).toMatchObject({
      title: '划船要点',
      url: 'https://bing.example.com/row',
    });
    expect(parseBingHtml(bingMobileHtml)[0]).toMatchObject({
      title: '硬拉站距',
      url: 'https://bing.example.com/m',
    });
    expect(parseBingRss(bingRssXml)[0]).toMatchObject({
      title: '深蹲护膝',
      url: 'https://bing.example.com/rss',
    });

    // 内置免 Key 搜索：DDG 202 反爬校验时自动降级到 360 成功
    const cascadeFetch: typeof fetch = vi.fn(async (url) => {
      if (String(url).includes('duckduckgo')) return new Response('challenge', { status: 202 });
      if (String(url).includes('so.com')) return new Response(soHtml, { status: 200 });
      return new Response(bingHtml, { status: 200 });
    });
    const builtinRes = await runCoachWebSearch({ provider: 'builtin', query: '卧推', fetchFn: cascadeFetch });
    expect(builtinRes.source).toBe('so360');
    expect(builtinRes.hits[0].url).toBe('https://so.example.com/bench');

    // DeepSeek 模型默认 webSearchProvider=undefined/builtin 时，v0.2.3 保持 16 业务工具前缀不变，走独立搜索并注入尾部参考上下文
    const { session: dsSession } = await seedBackActiveSession({ sessionId: 'sess-ds-web' });
    const dsReqs: Array<{
      tools?: Array<{ function?: { name?: string } }>;
      messages?: Array<{ role?: string; content?: unknown }>;
    }> = [];
    let searchHitsCount = 0;
    const dsFetch: typeof fetch = vi.fn(async (url, init) => {
      if (String(url).includes('duckduckgo')) {
        searchHitsCount += 1;
        return new Response(ddgHtml, { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      dsReqs.push(body);
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '按 7+7+7 依次完成。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 18, prompt_cache_hit_tokens: 600 } })}\n\ndata: [DONE]\n\n`,
        { status: 200 },
      );
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = dsFetch;
    try {
      const dsTurn = await runCoachTurn({
        userText: '帮我查一下21响礼炮怎么练',
        history: [],
        webSearch: true,
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4.1-flash',
          apiKey: 'ds-key',
          updatedAt: NOW,
        },
        toolContext: { activeSession: dsSession },
        streamChunkDelayMs: 0,
      });
      expect(searchHitsCount).toBe(1);
      expect(dsReqs[0]?.tools?.length).toBe(16);
      expect(dsReqs[0]?.tools?.some((t) => t.function?.name === 'web_search')).toBe(false);
      expect(String(dsReqs[0]?.messages?.[dsReqs[0].messages.length - 1]?.content ?? '')).toContain('21响礼炮');
      expect(dsTurn.citations?.[0]?.url).toBe('https://fit.example.com/21s');
      expect(dsTurn.usage?.cachedTokens).toBe(600);
      expect(dsTurn.usage?.rounds).toBe(1);

      // 关网时外部搜索次数必须为 0
      const countBeforeOff = searchHitsCount;
      await runCoachTurn({
        userText: '帮我查一下21响礼炮怎么练',
        history: [],
        webSearch: false,
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4.1-flash',
          apiKey: 'ds-key',
          updatedAt: NOW,
        },
        toolContext: { activeSession: dsSession },
        streamChunkDelayMs: 0,
      });
      expect(searchHitsCount).toBe(countBeforeOff);

      // 当内置搜索全源失败（如手机短暂断网）时，回传降级不崩溃继续由模型回答
      const failSearchFetch: typeof fetch = vi.fn(async (url, init) => {
        const s = String(url);
        if (s.includes('duckduckgo') || s.includes('so.com') || s.includes('bing.com')) {
          throw new Error('network down');
        }
        return dsFetch(url, init);
      });
      globalThis.fetch = failSearchFetch;
      const offlineTurn = await runCoachTurn({
        userText: '弱网环境查一下21响礼炮',
        history: [],
        webSearch: true,
        providerConfig: {
          key: 'provider',
          kind: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-v4.1-flash',
          apiKey: 'ds-key',
          updatedAt: NOW,
        },
        toolContext: { activeSession: dsSession },
        streamChunkDelayMs: 0,
      });
      expect(offlineTurn.text).toContain('7+7+7');
    } finally {
      globalThis.fetch = origFetch;
    }

    const mockSearchFetch: typeof fetch = vi.fn(async (url) => {
      if (String(url).includes('tavily')) {
        return new Response(
          JSON.stringify({ results: [{ title: 'T1', url: 'https://t.example/1', content: '片1' }] }),
          { status: 200 },
        );
      }
      if (String(url).includes('bochaai')) {
        return new Response(
          JSON.stringify({ data: { webPages: { value: [{ name: 'B1', url: 'https://b.example/1', summary: '博1' }] } } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ web: { results: [{ title: 'Br1', url: 'https://br.example/1', description: '勇1' }] } }),
        { status: 200 },
      );
    });
    const tRes = await runCoachWebSearch({ provider: 'tavily', apiKey: 'k1', query: '卧推', fetchFn: mockSearchFetch });
    const bRes = await runCoachWebSearch({ provider: 'bocha', apiKey: 'k2', query: '卧推', fetchFn: mockSearchFetch });
    const brRes = await runCoachWebSearch({ provider: 'brave', apiKey: 'k3', query: '卧推', fetchFn: mockSearchFetch });
    expect(tRes.hits[0].title).toBe('T1');
    expect(bRes.hits[0].title).toBe('B1');
    expect(brRes.hits[0].title).toBe('Br1');

    // Gemini 独立 grounding 搜索轮 ({ hasFn: false, hasSearch: true }) + 固定业务工具轮 ({ hasFn: true, hasSearch: false })
    const { session } = await seedBackActiveSession();
    const callsMade: Array<{ hasFn: boolean; hasSearch: boolean }> = [];
    const conflictFetch: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tools?: Array<Record<string, unknown>> };
      const hasFn = Boolean(body.tools?.some((t) => 'functionDeclarations' in t));
      const hasSearch = Boolean(body.tools?.some((t) => 'googleSearch' in t));
      callsMade.push({ hasFn, hasSearch });
      if (!hasFn && hasSearch) {
        const chunk = {
          candidates: [
            {
              finishReason: 'STOP',
              content: { parts: [{ text: '21响礼炮分下程/上程/全程共3程。' }] },
              groundingMetadata: {
                groundingChunks: [{ web: { uri: 'https://fit.example/21', title: '21响礼炮说明' } }],
              },
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200 });
      }
      // 主工具对话轮：无 googleSearch，直接返回文本完成
      const chunk = {
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '已结合查到的资料回复你。' }] } }],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200 });
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = conflictFetch;
    try {
      const gemCfg: CoachStoredProviderConfig = {
        key: 'provider',
        kind: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash',
        apiKey: 'gem-key',
        updatedAt: NOW,
      };
      const turn = await runCoachTurn({
        userText: '查一下21响礼炮做法',
        history: [],
        webSearch: true,
        providerConfig: gemCfg,
        toolContext: { activeSession: session },
        streamChunkDelayMs: 0,
      });
      expect(callsMade).toEqual([
        { hasFn: false, hasSearch: true },
        { hasFn: true, hasSearch: false },
      ]);
      expect(turn.text).toContain('已结合查到的资料');
      expect(turn.citations?.[0].url).toBe('https://fit.example/21');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('15. 原生流式桥 createNativeStreamFetch 切后台恢复 drainEvents 去重续传与 abortStream 取消', async () => {
    let listener: ((ev: CoachStreamDeltaEvent) => void) | null = null;
    let resumeCb: (() => void) | null = null;
    let abortedId = '';
    const eventsByReq = new Map<string, CoachStreamDeltaEvent[]>();

    const mockPlugin: CoachStreamPluginShape = {
      async startStream(opts) {
        const list: CoachStreamDeltaEvent[] = [
          { requestId: opts.requestId, seq: 1, type: 'status', status: 200, statusText: 'OK' },
          { requestId: opts.requestId, seq: 2, type: 'chunk', chunk: 'data: {"a":1}\n' },
          { requestId: opts.requestId, seq: 3, type: 'chunk', chunk: 'data: {"b":"你好世界"}\n' },
          { requestId: opts.requestId, seq: 4, type: 'done' },
        ];
        eventsByReq.set(opts.requestId, list);
        // 模拟切后台前只推了 seq=1 和 seq=2，3 与 4 留在原生缓冲区等待恢复补拉
        setTimeout(() => {
          listener?.(list[0]);
          listener?.(list[1]);
        }, 5);
        return { requestId: opts.requestId };
      },
      async drainEvents(opts) {
        const list = eventsByReq.get(opts.requestId) ?? [];
        const events = list.filter((e) => e.seq > opts.afterSeq);
        return { events, finished: list.some((e) => e.type === 'done') };
      },
      async abortStream(opts) {
        abortedId = opts.requestId;
        return { aborted: true };
      },
      async fetchText() {
        return { status: 200, statusText: 'OK', body: '{"ok":true}' };
      },
      async addListener(_name, cb) {
        listener = cb;
        return {
          remove: async () => {
            listener = null;
          },
        };
      },
    };

    const nativeFetch = createNativeStreamFetch(mockPlugin, {
      onResume: (cb) => {
        resumeCb = cb;
        return () => {
          resumeCb = null;
        };
      },
    });

    // 非流式直走 fetchText
    const jsonRes = await nativeFetch('https://api.example.com/v1/models');
    expect(await jsonRes.text()).toBe('{"ok":true}');

    // 流式：先收 1..2，再触发 onResume + 重复推送 seq=2 检验幂等去重
    const resp = await nativeFetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    });
    expect(resp.status).toBe(200);
    setTimeout(() => {
      const reqId = Array.from(eventsByReq.keys())[0];
      listener?.(eventsByReq.get(reqId)![1]); // 重复 seq=2 必须被丢弃
      resumeCb?.();
    }, 20);
    const fullBody = await resp.text();
    expect(fullBody).toBe('data: {"a":1}\ndata: {"b":"你好世界"}\n');

    // 验证 AbortSignal 触发 abortStream
    const ac = new AbortController();
    const hangingPlugin: CoachStreamPluginShape = {
      ...mockPlugin,
      async startStream(opts) {
        setTimeout(() => {
          listener?.({ requestId: opts.requestId, seq: 1, type: 'status', status: 200, statusText: 'OK' });
          ac.abort();
        }, 5);
        return { requestId: opts.requestId };
      },
      async drainEvents() {
        return { events: [], finished: false };
      },
    };
    const abortableFetch = createNativeStreamFetch(hangingPlugin, { onResume: () => () => undefined });
    const abortResp = await abortableFetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
      signal: ac.signal,
    });
    await expect(abortResp.body!.getReader().read()).rejects.toThrow();
    expect(abortedId).toBeTruthy();
  });
});
