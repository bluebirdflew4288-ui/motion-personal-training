/* Wave 2 (0.1.17 / versionCode 18) 全量回归与行为验证套件。
   覆盖：
   · Wave 2A：Plans 拆分解耦（PlansPage + PlanDayEditor）、atomicSavePlanWithTemplate 单事务原子性
              （plans + meta 冲突/故障整体回滚）、统一动作配置（超级组 / 逐组独立配置 / 逐轮覆盖 / 力竭）、
              记忆模板带入、长按重排纯函数、多条乱序撤销相对位置恢复，以及 BackupPayload v3 100% 往返兼容
   · Wave 2B：统计模块三修（纯有氧不稀释力量均组数 + 有氧场次与时长概览、连续 8 自然周零填充跨年验证、
              assisted 辅助负重越小越强反向比较、单动作部位/拼音/别名筛选、同口径 ≥2 次原生 SVG 趋势折线图）
   · Wave 2C：零依赖汉字拼音首字母（ICU 23 分界点 + 健身多音字覆盖）与健身房俗称别名检索
   · Wave 2D：本地备份温和提醒（≥5 次首提、取消保存不误写 lastExportAt、14 天+≥3 次新训复提、7 天稍后静默期） */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, openDb } from '../src/db/idb';
import {
  atomicSavePlanWithTemplate,
  BACKUP_VERSION,
  buildBackup,
  CURRENT_APP_VERSION,
  getPlan,
  savePlan,
  saveSession,
  saveSettings,
  validateBackup,
} from '../src/db/repo';
import { getExerciseTemplate, putExerciseTemplate } from '../src/db/templates';
import { evaluateBackupNudge } from '../src/domain/backupNudge';
import { createCardioEntry } from '../src/domain/cardio';
import { exerciseTemplateFromConfig } from '../src/domain/exerciseConfig';
import { catalogFromTemplates, searchExerciseCatalog } from '../src/domain/exerciseLibrary';
import { exerciseIdFromName } from '../src/domain/identity';
import {
  charPinyinSyllables,
  matchesPinyinInitials,
  pinyinInitialsOf,
  pinyinMatchRank,
} from '../src/domain/pinyinInitials';
import {
  addPlanExerciseEntry,
  applyEditorToPlanExercise,
  planExerciseFromTemplate,
  removeExercise,
  reorderPlanExercises,
  restoreDeletedPlanExercise,
} from '../src/domain/planEdit';
import { EXERCISE_LIBRARY, searchExercises } from '../src/domain/presets/library';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  createAdhocCardioSession,
  createRestSession,
  createSession,
  withSetAndPrefillFollowingWeight,
} from '../src/domain/session';
import { buildEditorState } from '../src/ui/exerciseEditorDraft';
import {
  SWIPE_LEFT_EDGE_ZONE_PX,
  SWIPE_READY_HOLD_MS,
  SWIPE_READY_TRIGGER_RATIO,
  SWIPE_VERTICAL_INTENT_THRESHOLD,
} from '../src/ui/cardGestures';
import {
  buildConsecutiveIsoWeeks,
  buildExerciseHistory,
  buildOverview,
  filterTrainedExercises,
  listTrainedExercises,
} from '../src/domain/stats';
import type { Plan, Session } from '../src/domain/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, '..');
const readApp = (rel: string) => readFileSync(resolve(APP_DIR, rel), 'utf8');
const TEST_PLAN = createV32Plan(1_700_000_000_000);

function makeCompletedStrengthSession(opts: {
  id: string;
  endedAt: number;
  exerciseName: string;
  exerciseId?: string;
  weightMode?: 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted';
  dumbbellBasis?: 'per_hand' | 'total';
  sets: Array<{ weightKg: number | null; reps: number }>;
}): Session {
  const s = createSession(TEST_PLAN, TEST_PLAN.days[0], opts.endedAt - 3600_000);
  const exId = opts.exerciseId ?? exerciseIdFromName(opts.exerciseName);
  const weightMode = opts.weightMode ?? 'external';
  return {
    ...s,
    id: opts.id,
    status: 'completed',
    startedAt: opts.endedAt - 3600_000,
    endedAt: opts.endedAt,
    exercises: [
      {
        id: `sex-${opts.id}`,
        exerciseId: exId,
        planExerciseId: null,
        name: opts.exerciseName,
        restSec: 120,
        target: {
          kind: 'straight',
          sets: opts.sets.length,
          setsMax: opts.sets.length,
          repsMin: 6,
          repsMax: 12,
          weightMode,
          suggestedWeightKg: opts.sets[0]?.weightKg ?? null,
          ...(opts.dumbbellBasis ? { dumbbellBasis: opts.dumbbellBasis } : {}),
        },
        status: 'done',
        groups: opts.sets.map((_, idx) => ({ index: idx + 1, stageCount: 1 })),
        sets: opts.sets.map((st, idx) => ({
          id: `set-${opts.id}-${idx + 1}`,
          roundIndex: idx + 1,
          stageIndex: 1,
          weightKg: st.weightKg,
          reps: st.reps,
          status: 'done' as const,
        })),
      },
    ],
  };
}

function makeCompletedCardioSession(id: string, endedAt: number, elapsedMs: number): Session {
  const s = createAdhocCardioSession({
    plan: TEST_PLAN,
    preset: 'treadmill-incline',
    name: `有氧 ${id}`,
    params: { speedKmh: 5.5, inclinePct: 10 },
    now: endedAt - elapsedMs,
  });
  const entry = createCardioEntry({
    preset: 'treadmill-incline',
    name: `有氧 ${id}`,
    params: { speedKmh: 5.5, inclinePct: 10 },
  });
  return {
    ...s,
    id,
    status: 'completed',
    startedAt: endedAt - elapsedMs,
    endedAt,
    exercises: [],
    cardio: [
      {
        ...entry,
        status: 'done',
        elapsedMs,
        runningSinceAt: null,
        segments: [
          {
            id: `seg-${id}`,
            startElapsedMs: 0,
            endElapsedMs: elapsedMs,
            params: { speedKmh: 5.5, inclinePct: 10 },
          },
        ],
      },
    ],
  };
}

describe('Wave 2A · Plans 拆分解耦、单事务计划+记忆保存、统一编辑器配置与重排/撤销', () => {
  beforeEach(async () => {
    await __resetDbHandle();
    await idbClear('plans');
    await idbClear('sessions');
    await idbClear('settings');
    await idbClear('meta');
  });

  it('Plans.tsx 已拆分为独立 PlansPage.tsx 与 PlanDayEditor.tsx，且 PlanDayEditor 接入统一组件体系', () => {
    const entrySrc = readApp('src/pages/Plans.tsx');
    const pageSrc = readApp('src/pages/plans/PlansPage.tsx');
    const editorSrc = readApp('src/pages/plans/PlanDayEditor.tsx');

    expect(entrySrc.split('\n').length).toBeLessThan(20);
    expect(pageSrc).toContain('export function PlansPage()');
    expect(editorSrc).toContain('export function PlanDayEditor(');
    expect(editorSrc).toContain('<ExerciseNamePicker');
    expect(editorSrc).toContain('<ExerciseEditor');
    expect(editorSrc).toContain('<SwipeActionCard');
    expect(editorSrc).toContain('<DeleteDissolveLayer');
    expect(editorSrc).toContain('<UndoStack');
    expect(editorSrc).toContain('cardDrag.releaseCommitHold()');
  });

  it('atomicSavePlanWithTemplate 单事务原子性：模板 revision 冲突或 meta.put 异常时计划与模板整体回滚', async () => {
    const basePlan = createV32Plan(1_760_000_000_000);
    await savePlan(basePlan);

    const exId = exerciseIdFromName('自由杠铃卧推');
    const tplV1 = exerciseTemplateFromConfig({
      exerciseId: exId,
      name: '自由杠铃卧推',
      target: {
        kind: 'straight',
        sets: 4,
        setsMax: 4,
        repsMin: 6,
        repsMax: 8,
        weightMode: 'external',
        suggestedWeightKg: 80,
      },
      restSec: 150,
    });

    // 1) 首次同时保存计划改名与动作记忆 → 两者同时落库
    const renamedPlan: Plan = { ...basePlan, name: '三分化进阶版' };
    const okRes = await atomicSavePlanWithTemplate(renamedPlan, {
      template: tplV1,
      expectedRevision: null,
    });
    expect(okRes.ok).toBe(true);
    expect((await getPlan(basePlan.id))?.name).toBe('三分化进阶版');
    const savedTpl = await getExerciseTemplate(exId);
    expect(savedTpl?.revision).toBe(1);
    expect(savedTpl?.restSec).toBe(150);

    // 2) 模拟并发冲突：expectedRevision 仍传 null（或过期版本号），必须拒绝且计划名称不得被改写
    const conflictPlan: Plan = { ...renamedPlan, name: '冲突不应落库的名称' };
    const conflictRes = await atomicSavePlanWithTemplate(conflictPlan, {
      template: { ...tplV1, restSec: 180 },
      expectedRevision: null,
    });
    expect(conflictRes.ok).toBe(false);
    if (!conflictRes.ok) {
      expect(conflictRes.reason).toBe('version-conflict');
    }
    expect((await getPlan(basePlan.id))?.name).toBe('三分化进阶版');
    expect((await getExerciseTemplate(exId))?.restSec).toBe(150);

    // 3) 模拟同一事务内 planStore.put 已发出后 metaStore.put 抛错 → 计划修改必须一并回滚
    const db = await openDb();
    const origTx = db.transaction.bind(db);
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((
      storeNames: string | string[],
      mode?: IDBTransactionMode,
    ) => {
      const tx = origTx(storeNames, mode);
      const names = Array.isArray(storeNames) ? storeNames : [storeNames];
      if (mode === 'readwrite' && names.includes('plans') && names.includes('meta')) {
        const origObjectStore = tx.objectStore.bind(tx);
        tx.objectStore = ((name: string) => {
          const store = origObjectStore(name);
          if (name === 'meta') {
            const origPut = store.put.bind(store);
            store.put = (() => {
              throw new Error('injected-meta-put-explosion');
            }) as typeof store.put;
            void origPut;
          }
          return store;
        }) as typeof tx.objectStore;
      }
      return tx;
    }) as typeof db.transaction;

    try {
      const abortedRes = await atomicSavePlanWithTemplate(
        { ...renamedPlan, name: '故障事务不应残留的名称' },
        { template: { ...tplV1, restSec: 210 }, expectedRevision: 1 },
      );
      expect(abortedRes.ok).toBe(false);
    } finally {
      (db as unknown as { transaction: typeof db.transaction }).transaction = origTx;
    }

    expect((await getPlan(basePlan.id))?.name).toBe('三分化进阶版');
    expect((await getExerciseTemplate(exId))?.revision).toBe(1);
    expect((await getExerciseTemplate(exId))?.restSec).toBe(150);
  });

  it('计划动作支持超级组、逐组独立配置、力竭、逐轮覆盖与记忆模板带入，且 BackupPayload v3 100% 往返无损', async () => {
    const plan = createV32Plan(1_760_000_000_000);
    const dayId = plan.days[0].id;
    const firstEx = plan.days[0].exercises[0];

    // 1) 编辑为带逐组独立配置 + 力竭的普通组
    const straightEdited = applyEditorToPlanExercise(plan, dayId, firstEx.id, {
      name: firstEx.name,
      exerciseId: exerciseIdFromName(firstEx.name),
      restSec: 150,
      target: {
        kind: 'straight',
        sets: 3,
        setsMax: 3,
        repsMin: 8,
        repsMax: 10,
        weightMode: 'external',
        suggestedWeightKg: 80,
        perSetConfigs: [
          { setIndex: 1, repsMin: 8, repsMax: 10, suggestedWeightKg: 80, toFailure: false },
          { setIndex: 2, repsMin: 8, repsMax: 10, suggestedWeightKg: 82.5, toFailure: false },
          { setIndex: 3, repsMin: 6, repsMax: 8, suggestedWeightKg: 85, toFailure: true },
        ],
      },
    });
    expect(straightEdited.ok).toBe(true);
    if (!straightEdited.ok) return;

    // 2) 由记忆模板新增一个含逐轮覆盖的超级组动作
    const supersetTpl = exerciseTemplateFromConfig({
      exerciseId: exerciseIdFromName('哑铃侧平举'),
      name: '哑铃侧平举',
      en: 'Dumbbell Lateral Raise',
      restSec: 90,
      target: {
        kind: 'dropSet',
        form: 'superset',
        rounds: 3,
        restInSec: 10,
        restAfterSec: 90,
        weightMode: 'external',
        dumbbellBasis: 'per_hand',
        stages: [
          { id: 'st-a', label: '哑铃侧平举', weightKg: 12, repsMin: 12, repsMax: 15, toFailure: false, restAfterSec: 10, targetText: '12kg × 12-15' },
          { id: 'st-b', label: '俯身飞鸟', weightKg: 8, repsMin: 15, repsMax: 20, toFailure: true, targetText: '8kg × 力竭' },
        ],
        roundConfigs: [
          {
            roundIndex: 3,
            restInSec: 5,
            stages: [
              { id: 'st-a', label: '哑铃侧平举', weightKg: 14, repsMin: 10, repsMax: 12, toFailure: true, restAfterSec: 5, targetText: '14kg × 力竭' },
              { id: 'st-b', label: '俯身飞鸟', weightKg: 8, repsMin: 15, repsMax: 20, toFailure: true, targetText: '8kg × 力竭' },
            ],
          },
        ],
      },
    });
    const tplWrite = await putExerciseTemplate(supersetTpl, null);
    expect(tplWrite.ok).toBe(true);

    const fromTpl = planExerciseFromTemplate(supersetTpl);
    const addedRes = addPlanExerciseEntry(straightEdited.plan, dayId, fromTpl);
    expect(addedRes.added).toBe(true);
    await savePlan(addedRes.plan);

    // 3) 导出当前 BackupPayload 并执行深度校验，确保配置字段往返保真
    const backup = await buildBackup(CURRENT_APP_VERSION);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.version).toBe(4);
    const validated = validateBackup(backup);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const restoredDay = validated.payload.data.plans[0].days[0];
    const restoredEx0 = restoredDay.exercises[0];
    const restoredSuperset = restoredDay.exercises.find((e) => e.id === fromTpl.id);
    expect(restoredEx0.target.kind).toBe('straight');
    if (restoredEx0.target.kind === 'straight') {
      expect(restoredEx0.target.perSetConfigs).toHaveLength(3);
      expect(restoredEx0.target.perSetConfigs?.[2].toFailure).toBe(true);
    }
    expect(restoredSuperset?.target.kind).toBe('dropSet');
    if (restoredSuperset?.target.kind === 'dropSet') {
      expect(restoredSuperset.target.form).toBe('superset');
      expect(restoredSuperset.target.dumbbellBasis).toBe('per_hand');
      expect(restoredSuperset.target.roundConfigs?.[0].roundIndex).toBe(3);
    }

    // 4) 由该计划创建新训练会话：超级组与逐组独立配置完整继承到 Session
    const session = createSession(validated.payload.data.plans[0], restoredDay);
    const sessionSuperset = session.exercises.find((e) => e.planExerciseId === fromTpl.id);
    expect(sessionSuperset?.target.kind).toBe('dropSet');
    if (sessionSuperset?.target.kind === 'dropSet') {
      expect(sessionSuperset.target.form).toBe('superset');
    }
    expect(session.exercises[0].sets[2].toFailure).toBe(true);
  });

  it('reorderPlanExercises 严格校验全排列，restoreDeletedPlanExercise 支持多条乱序撤销恢复原相对顺序', () => {
    const plan = createV32Plan(1_760_000_000_000);
    const day = plan.days[0];
    const origIds = day.exercises.map((e) => e.id);
    expect(origIds.length).toBeGreaterThanOrEqual(4);

    // 非法重排（少一项 / 未知 ID / 重复 ID）一律拒绝
    expect(reorderPlanExercises(plan, day.id, origIds.slice(1)).ok).toBe(false);
    expect(reorderPlanExercises(plan, day.id, ['unknown', ...origIds.slice(1)]).ok).toBe(false);
    expect(reorderPlanExercises(plan, day.id, [origIds[0], origIds[0], ...origIds.slice(2)]).ok).toBe(false);

    // 合法重排：把第 3 项移到第 1 位
    const movedOrder = [origIds[2], origIds[0], origIds[1], ...origIds.slice(3)];
    const reordered = reorderPlanExercises(plan, day.id, movedOrder);
    expect(reordered.ok).toBe(true);
    if (!reordered.ok) return;
    expect(reordered.changed).toBe(true);
    expect(reordered.plan.days[0].exercises.map((e) => e.id)).toEqual(movedOrder);

    // 连续删除第 2 项和第 3 项，然后先撤销第 3 项、再撤销第 2 项 → 完整恢复 movedOrder！
    const delA = reordered.plan.days[0].exercises[1];
    const delB = reordered.plan.days[0].exercises[2];
    const afterDelA = removeExercise(reordered.plan, day.id, delA.id);
    const afterDelAB = removeExercise(afterDelA, day.id, delB.id);

    const undoBFirst = restoreDeletedPlanExercise(afterDelAB, day.id, delB, movedOrder, 2);
    expect(undoBFirst.ok).toBe(true);
    if (!undoBFirst.ok) return;
    const undoASecond = restoreDeletedPlanExercise(undoBFirst.plan, day.id, delA, movedOrder, 1);
    expect(undoASecond.ok).toBe(true);
    if (!undoASecond.ok) return;
    expect(undoASecond.plan.days[0].exercises.map((e) => e.id)).toEqual(movedOrder);
  });
});

describe('Wave 2B · 统计口径三修（有氧分离、8 周连续补零、assisted 反向最高表现与同口径 SVG 趋势图）', () => {
  it('buildOverview：纯有氧与完全休息不稀释力量平均组数，且准确汇总有氧场次与时长', () => {
    const t0 = Date.UTC(2026, 10, 16, 10, 0, 0);
    const s1 = makeCompletedStrengthSession({
      id: 'st-1',
      endedAt: t0,
      exerciseName: '自由杠铃卧推',
      sets: [
        { weightKg: 80, reps: 8 },
        { weightKg: 80, reps: 8 },
        { weightKg: 80, reps: 8 },
        { weightKg: 80, reps: 8 },
      ],
    });
    const s2 = makeCompletedStrengthSession({
      id: 'st-2',
      endedAt: t0 + 86400_000,
      exerciseName: '正向哈克深蹲',
      sets: [
        { weightKg: 100, reps: 10 },
        { weightKg: 100, reps: 10 },
      ],
    });
    const c1 = makeCompletedCardioSession('cd-1', t0 + 2 * 86400_000, 30 * 60_000);
    const c2 = makeCompletedCardioSession('cd-2', t0 + 3 * 86400_000, 25 * 60_000);
    const rest = createRestSession({
      plan: TEST_PLAN,
      restDate: '2026-11-15',
      origin: 'plan',
      now: t0 - 86400_000,
    });

    const ov = buildOverview([s1, s2, c1, c2, rest], t0 + 3 * 86400_000);
    expect(ov.totalSessions).toBe(4);
    expect(ov.strengthSessions).toBe(2);
    expect(ov.cardioSessions).toBe(2);
    expect(ov.totalCardioMs).toBe(55 * 60_000);
    // 力量正式组共 4 + 2 = 6 组，力量场次 2 次 → 平均 3.0 组/次（不被 2 次纯有氧稀释成 1.5！）
    expect(ov.totalSets).toBe(6);
    expect(ov.avgSetsPerSession).toBe(3);
  });

  it('buildConsecutiveIsoWeeks：跨空缺周与跨年边界连续生成 8 个自然周并显式补 0', () => {
    // 2026-01-12 (周一, 2026-W03) 向前推 8 周，跨越 2025 年底
    const anchor = Date.UTC(2026, 0, 12, 12, 0, 0);
    const weeks = buildConsecutiveIsoWeeks(anchor, new Map(), 8);
    expect(weeks).toHaveLength(8);
    expect(weeks[7].key).toBe('2026-W03');
    expect(weeks[6].key).toBe('2026-W02');
    expect(weeks[5].key).toBe('2026-W01');
    expect(weeks[4].key.startsWith('2025-W')).toBe(true);

    // 只在第 1 周和第 8 周各放 1 次训练，中间 6 周必须全部 count=0, sets=0
    const sEarly = makeCompletedStrengthSession({
      id: 'w-early',
      endedAt: anchor - 7 * 7 * 86400_000,
      exerciseName: '引体向上',
      sets: [{ weightKg: 0, reps: 10 }],
    });
    const sLate = makeCompletedStrengthSession({
      id: 'w-late',
      endedAt: anchor,
      exerciseName: '引体向上',
      sets: [
        { weightKg: 0, reps: 10 },
        { weightKg: 0, reps: 10 },
      ],
    });
    const ov = buildOverview([sEarly, sLate], anchor);
    expect(ov.weeks).toHaveLength(8);
    expect(ov.weeks[0]).toEqual({ key: weeks[0].key, label: weeks[0].label, count: 1, sets: 1 });
    for (let i = 1; i <= 6; i += 1) {
      expect(ov.weeks[i]).toEqual({ key: weeks[i].key, label: weeks[i].label, count: 0, sets: 0 });
    }
    expect(ov.weeks[7]).toEqual({ key: weeks[7].key, label: weeks[7].label, count: 1, sets: 2 });
  });

  it('buildExerciseHistory：assisted 辅助重量严格按越小越强取最佳值，绝不把高辅助重量误判为进步', () => {
    const t0 = 1_760_000_000_000;
    const assistedExId = exerciseIdFromName('辅助引体向上');
    const sessions = [
      makeCompletedStrengthSession({
        id: 'as-1',
        endedAt: t0,
        exerciseName: '辅助引体向上',
        exerciseId: assistedExId,
        weightMode: 'assisted',
        sets: [
          { weightKg: 70, reps: 8 },
          { weightKg: 65, reps: 8 },
        ],
      }),
      makeCompletedStrengthSession({
        id: 'as-2',
        endedAt: t0 + 86400_000,
        exerciseName: '辅助引体向上',
        exerciseId: assistedExId,
        weightMode: 'assisted',
        sets: [
          { weightKg: 50, reps: 8 },
          { weightKg: 40, reps: 6 },
        ],
      }),
    ];

    const hist = buildExerciseHistory(sessions, assistedExId, {
      weightMode: 'assisted',
      dumbbellBasis: 'total',
    });
    expect(hist).not.toBeNull();
    if (!hist) return;
    expect(hist.entries).toHaveLength(2);
    // buildExerciseHistory 按 startedAt 升序排列：entries[0] 为旧场次（65kg），entries[1] 为新场次（40kg）；
    // 全历史最佳辅助必须取最小值 40kg（绝不是 70kg！）
    expect(hist.entries[0].bestWeightKg).toBe(65);
    expect(hist.entries[1].bestWeightKg).toBe(40);
    expect(hist.bestWeightKg).toBe(40);
    expect(hist.bestReps).toBe(8);
  });

  it('filterTrainedExercises 支持按部位、拼音首字母及俗称别名筛选已练动作', () => {
    const t0 = 1_760_000_000_000;
    const sessions = [
      makeCompletedStrengthSession({
        id: 'f-1',
        endedAt: t0,
        exerciseName: '自由杠铃卧推',
        sets: [{ weightKg: 80, reps: 8 }],
      }),
      makeCompletedStrengthSession({
        id: 'f-2',
        endedAt: t0 + 1000,
        exerciseName: '正向哈克深蹲',
        sets: [{ weightKg: 120, reps: 8 }],
      }),
      makeCompletedStrengthSession({
        id: 'f-3',
        endedAt: t0 + 2000,
        exerciseName: '单臂绳索侧平举',
        sets: [{ weightKg: 10, reps: 15 }],
      }),
    ];
    const items = listTrainedExercises(sessions);
    expect(items).toHaveLength(3);

    expect(filterTrainedExercises(items, { group: '胸', query: '' }).map((x) => x.name)).toEqual(['自由杠铃卧推']);
    expect(filterTrainedExercises(items, { group: 'all', query: 'zyglwt' }).map((x) => x.name)).toEqual(['自由杠铃卧推']);
    expect(filterTrainedExercises(items, { group: 'all', query: '哈克蹲' }).map((x) => x.name)).toEqual(['正向哈克深蹲']);
    expect(filterTrainedExercises(items, { group: 'all', query: 'dbsscpj' }).map((x) => x.name)).toEqual(['单臂绳索侧平举']);
  });
});

describe('Wave 2C · 零依赖拼音首字母与健身房俗称别名检索', () => {
  it('内置全部 57 个动作均能稳定生成非空拼音首字母，多音字（提拉带/单臂推举/双杠臂屈伸）准确覆盖', () => {
    expect(EXERCISE_LIBRARY.length).toBeGreaterThanOrEqual(55);
    for (const ex of EXERCISE_LIBRARY) {
      const variants = pinyinInitialsOf(ex.name);
      expect(variants.length).toBeGreaterThan(0);
      expect(variants[0].length).toBeGreaterThan(0);
    }

    expect(matchesPinyinInitials('自由杠铃卧推', 'zyglwt')).toBe(true);
    expect(matchesPinyinInitials('自由杠铃卧推', 'wt')).toBe(true);
    expect(matchesPinyinInitials('引体向上', 'ytxs')).toBe(true);
    expect(matchesPinyinInitials('哑铃侧平举', 'cpj')).toBe(true);
    expect(matchesPinyinInitials('提拉带罗马尼亚硬拉', 'tld')).toBe(true);
    expect(matchesPinyinInitials('单臂哑铃划船', 'dbylhc')).toBe(true);
  });

  it('searchExercises 与 searchExerciseCatalog 同时命中拼音首字母、俗称别名与用户自定义中文动作', () => {
    expect(searchExercises('哈克蹲').some((e) => e.name === '正向哈克深蹲')).toBe(true);
    expect(searchExercises('对握下拉').some((e) => e.name === '中立握高位下拉')).toBe(true);
    expect(searchExercises('RDL').some((e) => e.name === '罗马尼亚硬拉')).toBe(true);
    expect(searchExercises('龙门架夹胸').some((e) => e.name === '绳索夹胸')).toBe(true);

    const customTpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:牧师凳弯举',
      name: '牧师凳弯举',
      restSec: 90,
      target: {
        kind: 'straight',
        sets: 3,
        setsMax: 3,
        repsMin: 10,
        repsMax: 12,
        weightMode: 'external',
        suggestedWeightKg: 25,
      },
    });
    const catalog = catalogFromTemplates([customTpl]);
    expect(searchExerciseCatalog(catalog, 'msdwj').some((e) => e.name === '牧师凳弯举')).toBe(true);
    expect(searchExerciseCatalog(catalog, '哈克蹲').some((e) => e.name === '正向哈克深蹲')).toBe(true);
  });
});

describe('Wave 2D · 本地数据安全护栏（evaluateBackupNudge 精确门禁）', () => {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 10, 18, 8, 0, 0);

  function makeNWorkouts(count: number, baseTime: number): Session[] {
    return Array.from({ length: count }, (_, i) =>
      makeCompletedStrengthSession({
        id: `bk-${i + 1}`,
        endedAt: baseTime + i * 3600_000,
        exerciseName: '自由杠铃卧推',
        sets: [{ weightKg: 60, reps: 10 }],
      }),
    );
  }

  it('已完成训练 < 5 次时不打扰（即使夹杂完全休息记录也不误计入）', () => {
    const workouts = makeNWorkouts(4, T0 - 5 * DAY);
    const rests = [
      createRestSession({ plan: TEST_PLAN, restDate: '2026-11-10', origin: 'plan', now: T0 - 6 * DAY }),
      createRestSession({ plan: TEST_PLAN, restDate: '2026-11-11', origin: 'plan', now: T0 - 5 * DAY }),
    ];
    const decision = evaluateBackupNudge(
      [...workouts, ...rests],
      { lastExportAt: null, lastBackupPromptAt: null },
      T0,
    );
    expect(decision.shouldShow).toBe(false);
    expect(decision.totalCompleted).toBe(4);
  });

  it('≥ 5 次且从未导出（含用户取消系统保存弹窗后 lastExportAt 仍为 null）时展示首次提醒；导出成功后立即隐藏', () => {
    const workouts = makeNWorkouts(5, T0 - 5 * DAY);
    const beforeExport = evaluateBackupNudge(
      workouts,
      { lastExportAt: null, lastBackupPromptAt: null },
      T0,
    );
    expect(beforeExport).toEqual({
      shouldShow: true,
      reason: 'never-exported',
      unbackedCount: 5,
      totalCompleted: 5,
    });

    // 导出成功后写入 lastExportAt = T0 → 立即不再显示
    const afterExport = evaluateBackupNudge(
      workouts,
      { lastExportAt: T0, lastBackupPromptAt: null },
      T0 + 1000,
    );
    expect(afterExport.shouldShow).toBe(false);
  });

  it('距上次导出满 14 天且新增 ≥ 3 次训练才复提；点击「稍后」静默 7 天后自动恢复提醒', () => {
    const oldWorkouts = makeNWorkouts(5, T0 - 25 * DAY);
    const lastExportAt = T0 - 15 * DAY;

    // 仅新增 2 次训练 → 不打扰
    const twoNew = [
      ...oldWorkouts,
      ...makeNWorkouts(2, T0 - 3 * DAY).map((s, i) => ({ ...s, id: `new2-${i}` })),
    ];
    expect(
      evaluateBackupNudge(twoNew, { lastExportAt, lastBackupPromptAt: null }, T0).shouldShow,
    ).toBe(false);

    // 新增 3 次训练且距上次导出 15 天 → 触发 stale-export，精准报告 3 次未备份新训练
    const threeNew = [
      ...oldWorkouts,
      ...makeNWorkouts(3, T0 - 3 * DAY).map((s, i) => ({ ...s, id: `new3-${i}` })),
    ];
    const triggered = evaluateBackupNudge(
      threeNew,
      { lastExportAt, lastBackupPromptAt: null },
      T0,
    );
    expect(triggered).toEqual({
      shouldShow: true,
      reason: 'stale-export',
      unbackedCount: 3,
      totalCompleted: 8,
    });

    // 点击「稍后」写入 lastBackupPromptAt = T0：第 6 天内保持静默，满 7 天后恢复提示
    expect(
      evaluateBackupNudge(
        threeNew,
        { lastExportAt, lastBackupPromptAt: T0 },
        T0 + 6 * DAY,
      ).shouldShow,
    ).toBe(false);
    expect(
      evaluateBackupNudge(
        threeNew,
        { lastExportAt, lastBackupPromptAt: T0 },
        T0 + 7 * DAY,
      ).shouldShow,
    ).toBe(true);
  });

  it('Stats 趋势折线图与备份设置在真实数据下正确工作', async () => {
    await __resetDbHandle();
    await idbClear('sessions');
    await idbClear('settings');
    const exId = exerciseIdFromName('自由杠铃卧推');
    const s1 = makeCompletedStrengthSession({
      id: 'tr-1',
      endedAt: T0 - 2 * DAY,
      exerciseName: '自由杠铃卧推',
      exerciseId: exId,
      sets: [{ weightKg: 75, reps: 8 }],
    });
    const s2 = makeCompletedStrengthSession({
      id: 'tr-2',
      endedAt: T0 - DAY,
      exerciseName: '自由杠铃卧推',
      exerciseId: exId,
      sets: [{ weightKg: 80, reps: 8 }],
    });
    await saveSession(s1);
    await saveSession(s2);
    const savedSettings = await saveSettings({ lastBackupPromptAt: T0 });
    expect(savedSettings.lastBackupPromptAt).toBe(T0);

    const hist = buildExerciseHistory([s1, s2], exId, {
      weightMode: 'external',
      dumbbellBasis: 'total',
    });
    expect(hist).not.toBeNull();
    if (!hist) return;
    expect(hist.entries).toHaveLength(2);
    expect(hist.bestWeightKg).toBe(80);
    // 确认 React SSR 工具链正常可用
    expect(renderToStaticMarkup(createElement('div', { 'data-ok': '1' }, 'wave2'))).toContain('wave2');
  });
});

describe('0.1.18 真机反馈专项优化验证（F09 / 拼音全音节前缀 / 趋势图交互 / 醒目入口 / 首轮首组智能联动）', () => {
  it('1. F09 左滑悬停松手删除：380ms 悬停、78% 触发比、40px 屏幕左边缘判定、48px 拇指弧线容差且松手越出卡片左侧不误判取消', () => {
    expect(SWIPE_READY_HOLD_MS).toBe(380);
    expect(SWIPE_READY_TRIGGER_RATIO).toBeCloseTo(0.78, 2);
    expect(SWIPE_LEFT_EDGE_ZONE_PX).toBe(40);
    expect(SWIPE_VERTICAL_INTENT_THRESHOLD).toBe(48);

    const swipeSrc = readApp('src/ui/SwipeActionCard.tsx');
    expect(swipeSrc).toContain('setPointerCapture');
    expect(swipeSrc).toContain('reachedLeftScreenEdge');
    // pointerLeave 不再无脑重置 f09Aborted / disarmF09
    const onPointerLeaveSlice = swipeSrc.slice(
      swipeSrc.indexOf('const onPointerLeave'),
      swipeSrc.indexOf('const commitReorderIfNeeded'),
    );
    expect(onPointerLeaveSlice).not.toContain('disarmF09()');
    expect(onPointerLeaveSlice).not.toContain('cur.f09Aborted = true');
  });

  it('2. 拼音快速搜索：支持首字母（WT/YT）、不完整音节（Wo/Wot/Yin/Yint）、全拼（Wotui/Yinti）与混输（zyglwo），且句首命中优先于英文偶然子串', () => {
    expect(charPinyinSyllables('卧')[0]).toBe('wo');
    expect(charPinyinSyllables('推')[0]).toBe('tui');
    expect(charPinyinSyllables('引')[0]).toBe('yin');
    expect(charPinyinSyllables('体')[0]).toBe('ti');

    for (const q of ['WT', 'wt', 'Wo', 'wo', 'Wot', 'Wotui', 'zyglwo', 'zyglwt']) {
      expect(matchesPinyinInitials('自由杠铃卧推', q), `query=${q}`).toBe(true);
    }
    for (const q of ['YT', 'yt', 'Yin', 'yin', 'Yint', 'Yinti', 'ytxs']) {
      expect(matchesPinyinInitials('引体向上', q), `query=${q}`).toBe(true);
    }
    expect(matchesPinyinInitials('引体向上', 'wo')).toBe(false);
    expect(pinyinMatchRank('引体向上', 'Yin')).toBe(0);
    expect(pinyinMatchRank('辅助引体向上', 'Yin')).toBe(1);

    const catalog = catalogFromTemplates([]);
    const yinHits = searchExerciseCatalog(catalog, 'Yin');
    expect(yinHits.length).toBeGreaterThanOrEqual(2);
    expect(yinHits.slice(0, 2).every((e) => e.name.includes('引体向上'))).toBe(true);

    // 若用户记住过「引体向上」模板，句首拼音命中排第 1 位（高于句中命中如「反手引体向上」）
    const pullUpTpl = exerciseTemplateFromConfig({
      exerciseId: 'lib-pull-up',
      name: '引体向上',
      restSec: 120,
      target: {
        kind: 'straight',
        sets: 4,
        setsMax: 4,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'external',
        suggestedWeightKg: null,
      },
    });
    const catalogWithPullUp = catalogFromTemplates([pullUpTpl]);
    expect(searchExerciseCatalog(catalogWithPullUp, 'Yin')[0].name).toBe('引体向上');

    const woHits = searchExerciseCatalog(catalog, 'Wo');
    expect(woHits.some((e) => e.name.includes('卧推'))).toBe(true);
  });

  it('3. 折线图与卡片入口源码契约：Stats 含中间日期刻度与节点点击详情条；计划日与训练中卡片均直接露出醒目编排/编辑按钮', () => {
    const statsSrc = readApp('src/pages/Stats.tsx');
    expect(statsSrc).toContain('stats-trend-selected-info');
    expect(statsSrc).toContain('stats-trend-xticks');
    expect(statsSrc).toContain('stats-trend-point-');

    const planEditorSrc = readApp('src/pages/plans/PlanDayEditor.tsx');
    expect(planEditorSrc).toContain('plan-ex-full-edit-');
    expect(planEditorSrc).toContain('完整编排（阶段名/记忆）');

    const sessionCardSrc = readApp('src/pages/session/SessionExerciseCard.tsx');
    expect(sessionCardSrc).toContain('session-ex-edit-');
  });

  it('4. 智能跟随锁：同构多轮默认 customizedRounds 为空（跟随第 1 轮），初始已异构轮自动锁定独立；训练中第 1 轮/首组正重量自动预填后续空白同阶段组', () => {
    // 同构 3 轮超级组：初始无任何轮被锁定为独立
    const uniformState = buildEditorState({
      name: '超级组A',
      restSec: 90,
      target: {
        kind: 'dropSet',
        form: 'superset',
        rounds: 3,
        stages: [
          { id: 's1', label: 'A1', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
          { id: 's2', label: 'A2', weightKg: 15, repsMin: 10, repsMax: 12, toFailure: false, targetText: '' },
        ],
        restInSec: 15,
        restAfterSec: 90,
        weightMode: 'external',
      },
    });
    expect(uniformState.customizedRounds).toEqual([]);

    // 初始第 2 轮已异构：第 2 轮自动进 customizedRounds，第 3 轮同第 1 轮则继续跟随
    const heteroState = buildEditorState({
      name: '异构超级组',
      restSec: 90,
      target: {
        kind: 'dropSet',
        form: 'superset',
        rounds: 3,
        stages: [
          { id: 's1', label: 'A1', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
          { id: 's2', label: 'A2', weightKg: 15, repsMin: 10, repsMax: 12, toFailure: false, targetText: '' },
        ],
        roundConfigs: [
          {
            roundIndex: 2,
            stages: [{ id: 's1', label: 'A1重', weightKg: 25, repsMin: 6, repsMax: 8, toFailure: false, targetText: '' }],
          },
        ],
        restInSec: 15,
        restAfterSec: 90,
        weightMode: 'external',
      },
    });
    expect(heteroState.customizedRounds).toEqual([2]);

    // 训练中第 1 轮/首组正重量自动预填后续空白同阶段组，但第 2 轮手改不反向影响且 0kg 不污染空白组
    const plan = createV32Plan(1_760_000_000_000);
    let sess = createSession(plan, plan.days[0], 1_760_000_000_000);
    const ex0 = sess.exercises[0];
    expect(ex0.sets.length).toBeGreaterThanOrEqual(3);

    // 首组填 0kg（自重）：后续空白组保持 null
    const afterZero = withSetAndPrefillFollowingWeight(sess, ex0.id, ex0.sets[0].id, { weightKg: 0 });
    expect(afterZero.exercises[0].sets[0].weightKg).toBe(0);
    expect(afterZero.exercises[0].sets[1].weightKg).toBeNull();

    // 首组填 65kg：第 2、3 组空白自动预填 65kg，status 仍保持 blank
    sess = withSetAndPrefillFollowingWeight(sess, ex0.id, ex0.sets[0].id, { weightKg: 65 });
    expect(sess.exercises[0].sets[0].weightKg).toBe(65);
    expect(sess.exercises[0].sets[1].weightKg).toBe(65);
    expect(sess.exercises[0].sets[2].weightKg).toBe(65);
    expect(sess.exercises[0].sets[1].status).toBe('blank');

    // 手动把第 2 组改为 70kg：第 1、3 组保持 65kg 不受影响
    sess = withSetAndPrefillFollowingWeight(sess, ex0.id, ex0.sets[1].id, { weightKg: 70 });
    expect(sess.exercises[0].sets[0].weightKg).toBe(65);
    expect(sess.exercises[0].sets[1].weightKg).toBe(70);
    expect(sess.exercises[0].sets[2].weightKg).toBe(65);

    // 再把第 1 组微调为 67.5kg：未手改的第 3 组跟随变为 67.5kg，已手改的第 2 组保留 70kg！
    sess = withSetAndPrefillFollowingWeight(sess, ex0.id, ex0.sets[0].id, { weightKg: 67.5 });
    expect(sess.exercises[0].sets[0].weightKg).toBe(67.5);
    expect(sess.exercises[0].sets[1].weightKg).toBe(70);
    expect(sess.exercises[0].sets[2].weightKg).toBe(67.5);
  });
});
