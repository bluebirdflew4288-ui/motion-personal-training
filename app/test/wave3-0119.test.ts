/* Wave 3（0.1.19 / versionCode 20）全量单元测试与 BackupPayload v3 兼容性验证。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  buildBackup,
  CURRENT_APP_VERSION,
  getPlan,
  getSession,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import {
  atomicAcquireLock,
  atomicCreateSession,
  atomicFinishSession,
  atomicSaveHistoryEdit,
  atomicSaveSession,
  revisionOf,
} from '../src/db/tx';
import {
  completeCardio,
  createCardioEntry,
  startCardio,
  validateCardioEntry,
} from '../src/domain/cardio';
import {
  appendBlankGroupToHistoryExercise,
  canRemoveBlankGroupFromHistoryExercise,
  correctHistoryCardioEntry,
  removeBlankGroupFromHistoryExercise,
  updateHistoryExerciseNote,
  updateHistorySessionNote,
} from '../src/domain/historyEdit';
import { calculateBarbellPlates } from '../src/domain/plateCalc';
import { detectSessionPRs } from '../src/domain/prDetector';
import { evaluateProgressionHint, PROGRESSION_HINT_TEXT } from '../src/domain/progressionHint';
import {
  addSetTo,
  createAdhocCardioSession,
  createRestSession,
  createSession,
  withSet,
} from '../src/domain/session';
import {
  applySessionArrangementToPlan,
  diffSessionVsPlanDay,
  extractCleanPlanExercises,
} from '../src/domain/sessionToPlanSync';
import type { Plan, Session, SessionExercise } from '../src/domain/types';
import { exportPngFile, registerNativeFileBridge } from '../src/lib/backupFile';
import { buildReceiptDataModel } from '../src/lib/receiptCanvas';
import { buildMonthCalendarData } from '../src/ui/HistoryCalendar';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const readApp = (rel: string) => readFileSync(resolve(APP, rel), 'utf8');

const T0 = 1_763_000_000_000;

function makeBasePlan(): Plan {
  return {
    id: 'plan-w3',
    name: '三分化测试计划',
    cursor: 0,
    createdAt: T0,
    updatedAt: T0,
    days: [
      {
        id: 'day-push',
        name: '推日 A',
        focus: 'chest',
        round: 'A',
        kind: 'train',
        warmups: [],
        exercises: [
          {
            id: 'pe-bench',
            exerciseId: 'lib-barbell-bench',
            name: '自由杠铃卧推',
            restSec: 150,
            note: '计划提示：沉肩收胛',
            substitutes: ['哑铃平板卧推'],
            target: {
              kind: 'straight',
              sets: 3,
              setsMax: 3,
              repsMin: 8,
              repsMax: 10,
              weightMode: 'external',
              suggestedWeightKg: null,
            },
          },
          {
            id: 'pe-dip',
            exerciseId: 'lib-chest-dip',
            name: '双杠臂屈伸',
            restSec: 120,
            target: {
              kind: 'straight',
              sets: 3,
              setsMax: 3,
              repsMin: 8,
              repsMax: 12,
              weightMode: 'assisted',
              suggestedWeightKg: 50,
            },
          },
        ],
      },
      {
        id: 'day-pull',
        name: '拉日 A',
        focus: 'back',
        round: 'A',
        kind: 'train',
        warmups: [],
        exercises: [],
      },
    ],
  };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const st of ['plans', 'sessions', 'settings', 'meta']) {
    await idbClear(st);
  }
  registerNativeFileBridge(null);
});

describe('0.1.19 折线图去框红点打磨静态与样式契约', () => {
  it('Stats.tsx 已移除选中信息黄框背景（--paper-3）与外圈光晕，节点选中态直接填充实心砖红 var(--brick)', () => {
    const statsSrc = readApp('src/pages/Stats.tsx');
    const selectedIdx = statsSrc.indexOf('data-testid="stats-trend-selected-info"');
    expect(selectedIdx).toBeGreaterThan(-1);
    const infoBlock = statsSrc.slice(selectedIdx, selectedIdx + 520);
    expect(infoBlock).not.toContain('var(--paper-3)');
    expect(infoBlock).not.toContain('borderLeft');
    expect(statsSrc).not.toContain('r="7.5"');
    expect(statsSrc).toContain("fill={isSelected ? 'var(--brick)' : 'var(--paper-2)'}");
  });
});

describe('Wave 3A：完成训练时可选「将今日动作编排同步回原计划」', () => {
  it('仅录入次数与当次备注但未改编排时 hasDiff = false，不打扰用户', () => {
    const plan = makeBasePlan();
    let session = createSession(plan, plan.days[0], T0);
    session = withSet(session, session.exercises[0].id, session.exercises[0].sets[0].id, {
      reps: 10,
      weightKg: 80,
      status: 'done',
    });
    session = { ...session, note: '今天状态不错' };
    session.exercises[0] = { ...session.exercises[0], note: '左肘微酸' };

    const diff = diffSessionVsPlanDay(session, plan);
    expect(diff.canSync).toBe(true);
    expect(diff.hasDiff).toBe(false);
    expect(diff.eligible).toBe(false);
  });

  it('调换顺序 + 加一组 + 临时新增动作：准确识别摘要且剥离全部运行态字段，保留原计划条目提示 note', () => {
    const plan = makeBasePlan();
    let session = createSession(plan, plan.days[0], T0);
    // 给第 1 个动作加 1 组并录入数据 + 当次备注
    session = addSetTo(session, session.exercises[0].id);
    session = withSet(session, session.exercises[0].id, session.exercises[0].sets[0].id, {
      reps: 9,
      weightKg: 82.5,
      status: 'done',
    });
    session.exercises[0] = { ...session.exercises[0], note: '当次训练备注不应污染计划' };

    // 调换前两个动作顺序，并新增一个临时动作
    const addedEx: SessionExercise = {
      id: 'sex-added-fly',
      exerciseId: 'lib-pec-deck',
      planExerciseId: null,
      name: '蝴蝶机夹胸',
      restSec: 90,
      target: {
        kind: 'straight',
        sets: 4,
        setsMax: 4,
        repsMin: 12,
        repsMax: 15,
        weightMode: 'external',
        suggestedWeightKg: 45,
      },
      status: 'done',
      groups: [
        { index: 1, stageCount: 1 },
        { index: 2, stageCount: 1 },
        { index: 3, stageCount: 1 },
        { index: 4, stageCount: 1 },
      ],
      sets: [],
      added: true,
      note: '新增动作当次感受',
    };
    session = {
      ...session,
      exercises: [session.exercises[1], session.exercises[0], addedEx],
    };

    const diff = diffSessionVsPlanDay(session, plan);
    expect(diff.eligible).toBe(true);
    expect(diff.reordered).toBe(true);
    expect(diff.addedCount).toBe(1);
    expect(diff.configChangedCount).toBe(1);
    expect(diff.summaryText).toContain('调整了顺序');
    expect(diff.summaryText).toContain('新增 1 个动作');

    const cleaned = extractCleanPlanExercises(session.exercises, plan.days[0].exercises);
    expect(cleaned).toHaveLength(3);
    expect(cleaned[0].id).toBe('pe-dip');
    expect(cleaned[1].id).toBe('pe-bench');
    // 原计划级提示保留，当次感受不混入；组数同步为 4 组
    expect(cleaned[1].note).toBe('计划提示：沉肩收胛');
    expect(cleaned[1].substitutes).toEqual(['哑铃平板卧推']);
    expect(cleaned[1].target.kind === 'straight' && cleaned[1].target.sets).toBe(4);
    // 临时新增动作无运行态残留字段
    expect(cleaned[2].note).toBeUndefined();
    for (const pe of cleaned) {
      const raw = pe as unknown as Record<string, unknown>;
      expect('sets' in raw).toBe(false);
      expect('status' in raw).toBe(false);
      expect('groups' in raw).toBe(false);
      expect('added' in raw).toBe(false);
      expect('replacedFrom' in raw).toBe(false);
    }
  });

  it('atomicFinishSession 单事务原子性：未勾选不改计划；勾选则同事务更新计划与游标；目标日失效则整笔事务回滚', async () => {
    const plan = makeBasePlan();
    await savePlan(plan);

    // 1) 未勾选 syncBackToPlanDay：训练结束 + 推进游标，但计划动作编排保持不变
    let s1 = createSession(plan, plan.days[0], T0);
    s1 = addSetTo(s1, s1.exercises[0].id);
    await atomicCreateSession({ session: s1 });
    await atomicAcquireLock(s1.id, 'ed-1');
    const saved1 = await atomicSaveSession({
      session: { ...s1, revision: 1 },
      guard: { editorId: 'ed-1', expectedVersion: 1 },
    });
    expect(saved1.ok).toBe(true);

    const fin1 = await atomicFinishSession({
      session: { ...s1, endedAt: T0 + 1800_000 },
      guard: { editorId: 'ed-1', advanceCycle: true, syncBackToPlanDay: false },
    });
    expect(fin1.ok).toBe(true);
    const planAfter1 = (await getPlan(plan.id))!;
    expect(planAfter1.cursor).toBe(1);
    expect(planAfter1.days[0].exercises[0].target.kind === 'straight' && planAfter1.days[0].exercises[0].target.sets).toBe(3);

    // 2) 勾选 syncBackToPlanDay：单事务同时完成训练终态、游标推进与计划日动作更新，且 BackupPayload v3 校验全绿
    let s2 = createSession(planAfter1, planAfter1.days[0], T0 + 86_400_000);
    s2 = addSetTo(s2, s2.exercises[0].id); // 3 组 -> 4 组
    await atomicCreateSession({ session: s2 });
    await atomicAcquireLock(s2.id, 'ed-2');
    await atomicSaveSession({
      session: { ...s2, revision: 1 },
      guard: { editorId: 'ed-2', expectedVersion: 1 },
    });

    const fin2 = await atomicFinishSession({
      session: { ...s2, endedAt: T0 + 88_200_000 },
      guard: { editorId: 'ed-2', advanceCycle: false, syncBackToPlanDay: true },
    });
    expect(fin2.ok).toBe(true);
    const planAfter2 = (await getPlan(plan.id))!;
    expect(planAfter2.days[0].exercises[0].target.kind === 'straight' && planAfter2.days[0].exercises[0].target.sets).toBe(4);

    const backup = await buildBackup(CURRENT_APP_VERSION);
    expect(backup.version).toBe(3);
    expect(validateBackup(backup).ok).toBe(true);

    // 3) 若目标训练日在另一标签页被改成休息日：勾选同步时整个事务 abort，训练保持 active 不丢锁
    await savePlan({
      ...planAfter2,
      days: planAfter2.days.map((d, idx) => (idx === 0 ? { ...d, kind: 'rest' as const } : d)),
    });
    const s3 = createSession(planAfter2, planAfter2.days[0], T0 + 172_800_000);
    await atomicCreateSession({ session: s3 });
    await atomicAcquireLock(s3.id, 'ed-3');
    const finFail = await atomicFinishSession({
      session: { ...s3, endedAt: T0 + 174_600_000 },
      guard: { editorId: 'ed-3', advanceCycle: true, syncBackToPlanDay: true },
    });
    expect(finFail.ok).toBe(false);
    const stillActive = (await getSession(s3.id))!;
    expect(stillActive.status).toBe('active');
  });

  it('applySessionArrangementToPlan 拒绝临时训练同步', () => {
    const plan = makeBasePlan();
    const adhoc = createAdhocCardioSession({
      plan,
      preset: 'stair-climber',
      params: { level: 6 },
      now: T0,
    });
    const res = applySessionArrangementToPlan(plan, plan.days[0].id, adhoc, T0);
    expect(res.ok).toBe(false);
  });
});

describe('Wave 3B：历史详情「纠正数据」全覆盖与 expectedRevision 冲突保护', () => {
  it('支持修改总备注/动作备注、补录一组与删除空白组（保护非空组并维护 groups 连续序号）', () => {
    const plan = makeBasePlan();
    let sess = createSession(plan, plan.days[0], T0);
    const exId = sess.exercises[0].id;
    sess = withSet(sess, exId, sess.exercises[0].sets[0].id, {
      reps: 10,
      weightKg: 80,
      status: 'done',
    });
    sess = { ...sess, status: 'completed', endedAt: T0 + 3_600_000 };

    // 补录第 4 组
    const appended = appendBlankGroupToHistoryExercise(sess, exId);
    expect(appended.ok).toBe(true);
    expect(appended.session.exercises[0].groups).toHaveLength(4);
    expect(appended.session.exercises[0].sets).toHaveLength(4);

    // 第 1 组已有记录，不可按空白组删除
    expect(canRemoveBlankGroupFromHistoryExercise(appended.session.exercises[0], 1)).toBe(false);
    const blockedRemove = removeBlankGroupFromHistoryExercise(appended.session, exId, 1);
    expect(blockedRemove.ok).toBe(false);

    // 删除中间空白第 2 组后，剩余 3 组重排为 1, 2, 3
    expect(canRemoveBlankGroupFromHistoryExercise(appended.session.exercises[0], 2)).toBe(true);
    const removed = removeBlankGroupFromHistoryExercise(appended.session, exId, 2);
    expect(removed.ok).toBe(true);
    const afterEx = removed.session.exercises[0];
    expect(afterEx.groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(afterEx.sets.map((s) => s.roundIndex)).toEqual([1, 2, 3]);

    // 备注更新与超长拦截
    const noteOk = updateHistoryExerciseNote(removed.session, exId, '补记：第 1 组RPE 8');
    expect(noteOk.ok).toBe(true);
    expect(noteOk.session.exercises[0].note).toBe('补记：第 1 组RPE 8');

    const tooLong = updateHistorySessionNote(noteOk.session, 'x'.repeat(2005));
    expect(tooLong.ok).toBe(false);
  });

  it('支持修正有氧异常超长耗时与参数，规范化封口 segments 并通过 BackupPayload v3 深层校验与 CAS 冲突检测', async () => {
    const plan = makeBasePlan();
    let entry = createCardioEntry({
      preset: 'treadmill-incline',
      name: '有氧爬坡',
      params: { speedKmh: 4.5, inclinePct: 8 },
    });
    entry = startCardio(entry, T0);
    // 模拟用户忘关计时器记出 5 小时异常时长
    entry = completeCardio(entry, T0 + 5 * 3600 * 1000);

    const cardioSess: Session = {
      ...createAdhocCardioSession({
        plan,
        preset: 'treadmill-incline',
        params: { speedKmh: 4.5, inclinePct: 8 },
        now: T0,
      }),
      status: 'completed',
      endedAt: T0 + 5 * 3600 * 1000,
      cardio: [entry],
    };

    await atomicCreateSession({ session: { ...cardioSess, status: 'active', endedAt: null } });
    await atomicAcquireLock(cardioSess.id, 'ed-c');
    const fin = await atomicFinishSession({
      session: cardioSess,
      guard: { editorId: 'ed-c', advanceCycle: false },
    });
    expect(fin.ok).toBe(true);
    const stored = (await getSession(cardioSess.id))!;

    // 修回真实 35 分钟 + 坡度 10%
    const corrected = correctHistoryCardioEntry(stored, stored.cardio![0].id, {
      durationSec: 35 * 60,
      params: { speedKmh: 5.0, inclinePct: 10 },
    });
    expect(corrected.ok).toBe(true);
    const fixedEntry = corrected.session.cardio![0];
    expect(fixedEntry.elapsedMs).toBe(35 * 60 * 1000);
    expect(fixedEntry.status).toBe('done');
    expect(fixedEntry.runningSinceAt).toBeNull();
    expect(fixedEntry.currentParams).toEqual({ speedKmh: 5.0, inclinePct: 10 });
    expect(validateCardioEntry(fixedEntry, stored.endedAt ?? T0)).toEqual([]);

    // 落库保存并验证旧 revision 再次写入被 CAS 拒绝
    const baseRev = revisionOf(stored);
    const saved = await atomicSaveHistoryEdit({
      session: corrected.session,
      expectedRevision: baseRev,
    });
    expect(saved.ok).toBe(true);

    const staleSave = await atomicSaveHistoryEdit({
      session: corrected.session,
      expectedRevision: baseRev,
    });
    expect(staleSave.ok).toBe(false);
    if (!staleSave.ok) {
      expect(staleSave.reason).toBe('version-conflict');
    }

    // 导出备份深层校验 100% 通过
    const backup = await buildBackup(CURRENT_APP_VERSION);
    expect(validateBackup(backup).ok).toBe(true);
  });
});

describe('Wave 3C：同口径渐进超负荷提示与杠铃配片速算器', () => {
  it('evaluateProgressionHint：上次满组且每组达上限时提示；缺组/差一次/力竭/已手动加码均不误报', () => {
    const plan = makeBasePlan();
    let prev = createSession(plan, plan.days[0], T0);
    const benchId = prev.exercises[0].id;
    for (const st of prev.exercises[0].sets) {
      prev = withSet(prev, benchId, st.id, { reps: 10, weightKg: 80, status: 'done' });
    }
    prev = { ...prev, status: 'completed', endedAt: T0 + 3600_000 };

    const today = createSession(plan, plan.days[0], T0 + 86_400_000);
    expect(evaluateProgressionHint(today.exercises[0], prev.exercises[0])).toBe(
      PROGRESSION_HINT_TEXT,
    );

    // 若上次最后一组的次数是 9（未满上限 10），不提示
    const missedLast = withSet(prev, benchId, prev.exercises[0].sets[2].id, { reps: 9 });
    expect(evaluateProgressionHint(today.exercises[0], missedLast.exercises[0])).toBeNull();

    // 若用户今天已经在计划里把目标重量提高到 82.5kg（高于上次实际 80kg），不再重复提示
    const bumpedToday: SessionExercise = {
      ...today.exercises[0],
      target:
        today.exercises[0].target.kind === 'straight'
          ? { ...today.exercises[0].target, suggestedWeightKg: 82.5 }
          : today.exercises[0].target,
    };
    expect(evaluateProgressionHint(bumpedToday, prev.exercises[0])).toBeNull();

    // 力竭组不提示满上限
    const failureToday: SessionExercise = {
      ...today.exercises[0],
      target:
        today.exercises[0].target.kind === 'straight'
          ? { ...today.exercises[0].target, toFailure: true }
          : today.exercises[0].target,
    };
    expect(evaluateProgressionHint(failureToday, prev.exercises[0])).toBeNull();
  });

  it('calculateBarbellPlates：覆盖 20/15/10/0 kg 杆重、精确拆解、低于杆重与不可整除最近邻', () => {
    const r100 = calculateBarbellPlates(100, 20);
    expect(r100.status).toBe('exact');
    expect(r100.perSideKg).toBe(40);
    expect(r100.platesPerSide).toEqual([
      { plateKg: 25, count: 1 },
      { plateKg: 15, count: 1 },
    ]);

    const r625 = calculateBarbellPlates(62.5, 20);
    expect(r625.exact).toBe(true);
    expect(r625.platesPerSide).toEqual([
      { plateKg: 20, count: 1 },
      { plateKg: 1.25, count: 1 },
    ]);

    const rWomen = calculateBarbellPlates(45, 15);
    expect(rWomen.exact).toBe(true);
    expect(rWomen.perSideKg).toBe(15);
    expect(rWomen.platesPerSide).toEqual([{ plateKg: 15, count: 1 }]);

    const rBelow = calculateBarbellPlates(15, 20);
    expect(rBelow.status).toBe('below-bar');

    const rNearest = calculateBarbellPlates(61, 20);
    expect(rNearest.status).toBe('nearest');
    expect(rNearest.exact).toBe(false);
    expect(rNearest.nearestLowerKg).toBe(60);
    expect(rNearest.nearestUpperKg).toBe(62.5);
    expect(rNearest.remainderKg).toBe(1);
  });
});

describe('Wave 3D：同口径 PR 印章（含辅助反向比较）、完赛小票导图与月历出勤印章', () => {
  it('detectSessionPRs：首录不发 PR；外加负重增重发重量 PR；辅助负重减轻发重量 PR（加重绝不误判）；同重加次发同重次数 PR；跨口径严格隔离；0 次试举不发 PR', async () => {
    const plan = makeBasePlan();

    // 第 1 次训练：卧推 80kg × 8；辅助双杠 60kg × 8 -> 均应标为「首录」而非 PR
    let s1 = createSession(plan, plan.days[0], T0);
    s1 = withSet(s1, s1.exercises[0].id, s1.exercises[0].sets[0].id, {
      reps: 8,
      weightKg: 80,
      status: 'done',
    });
    s1 = withSet(s1, s1.exercises[1].id, s1.exercises[1].sets[0].id, {
      reps: 8,
      weightKg: 60,
      status: 'done',
    });
    s1 = { ...s1, status: 'completed', endedAt: T0 + 3600_000 };

    const rep1 = detectSessionPRs([s1], s1);
    expect(rep1.prs).toHaveLength(0);
    expect(rep1.firstRecords).toHaveLength(2);

    // 第 2 次训练：
    // · 卧推：100kg × 0（失败试举，不算 PR！）+ 80kg × 10（同重次数 PR！）
    // · 辅助双杠：70kg × 10（辅助变多 = 更省力，绝不算重量 PR！）
    let s2 = createSession(plan, plan.days[0], T0 + 86_400_000);
    s2 = withSet(s2, s2.exercises[0].id, s2.exercises[0].sets[0].id, {
      reps: 0,
      weightKg: 100,
      status: 'done',
    });
    s2 = withSet(s2, s2.exercises[0].id, s2.exercises[0].sets[1].id, {
      reps: 10,
      weightKg: 80,
      status: 'done',
    });
    s2 = withSet(s2, s2.exercises[1].id, s2.exercises[1].sets[0].id, {
      reps: 10,
      weightKg: 70,
      status: 'done',
    });
    s2 = { ...s2, status: 'completed', endedAt: T0 + 90_000_000 };

    const rep2 = detectSessionPRs([s1, s2], s2);
    expect(rep2.prs).toHaveLength(1);
    expect(rep2.prs[0].kind).toBe('reps-at-weight-pr');
    expect(rep2.prs[0].exerciseId).toBe('lib-barbell-bench');

    // 第 3 次训练：
    // · 卧推：85kg × 6（重量 PR！）
    // · 辅助双杠：45kg × 8（辅助由 60kg 减至 45kg -> 重量 PR！）
    let s3 = createSession(plan, plan.days[0], T0 + 172_800_000);
    s3 = withSet(s3, s3.exercises[0].id, s3.exercises[0].sets[0].id, {
      reps: 6,
      weightKg: 85,
      status: 'done',
    });
    s3 = withSet(s3, s3.exercises[1].id, s3.exercises[1].sets[0].id, {
      reps: 8,
      weightKg: 45,
      status: 'done',
    });
    s3 = { ...s3, status: 'completed', endedAt: T0 + 176_400_000 };

    const rep3 = detectSessionPRs([s1, s2, s3], s3);
    expect(rep3.prs).toHaveLength(2);
    expect(rep3.prs.map((p) => p.kind)).toEqual(['weight-pr', 'weight-pr']);
    const dipPr = rep3.prs.find((p) => p.exerciseId === 'lib-chest-dip')!;
    expect(dipPr.detailText).toContain('辅助 45 kg');
    expect(dipPr.detailText).toContain('原最佳 辅助 60 kg');

    // 完赛小票模型与 PNG 导出桥契约验证
    const model = buildReceiptDataModel(s3, rep3);
    expect(model.prs).toHaveLength(2);
    expect(model.items).toHaveLength(2);
    expect(model.filename).toMatch(/^motion-slip-\d{8}-\d{4}\.png$/);

    // 验证浏览器回退导出对空串的拦截
    const emptyOut = await exportPngFile('test.png', '');
    expect(emptyOut.ok).toBe(false);
  });

  it('buildMonthCalendarData：准确区分力量实心章、纯有氧斜纹章、完全休息空心章及同日多场次角标', () => {
    const plan = makeBasePlan();
    const dStrength = new Date(2026, 10, 3, 18, 0, 0).getTime(); // 2026-11-03
    const dCardio1 = new Date(2026, 10, 5, 9, 0, 0).getTime(); // 2026-11-05 早
    const dCardio2 = new Date(2026, 10, 5, 19, 30, 0).getTime(); // 2026-11-05 晚

    const sStrength: Session = {
      ...createSession(plan, plan.days[0], dStrength),
      status: 'completed',
      endedAt: dStrength + 3600_000,
    };
    const sCardio1: Session = {
      ...createAdhocCardioSession({ plan, preset: 'stair-climber', params: { level: 6 }, now: dCardio1 }),
      status: 'completed',
      endedAt: dCardio1 + 1800_000,
    };
    const sCardio2: Session = {
      ...createAdhocCardioSession({ plan, preset: 'treadmill-incline', params: { speedKmh: 5, inclinePct: 8 }, now: dCardio2 }),
      status: 'completed',
      endedAt: dCardio2 + 1800_000,
    };
    const sRest = createRestSession({
      plan,
      restDate: '2026-11-06',
      origin: 'plan',
      now: new Date(2026, 10, 6, 12, 0, 0).getTime(),
    });

    const cal = buildMonthCalendarData([sStrength, sCardio1, sCardio2, sRest], 2026, 11);
    expect(cal.strengthDays).toBe(1);
    expect(cal.cardioOnlyDays).toBe(1);
    expect(cal.restDays).toBe(1);
    expect(cal.totalWorkouts).toBe(3); // 休息日不计入训练次数

    const cell3 = cal.days.find((d) => d.dateKey === '2026-11-03')!;
    const cell5 = cal.days.find((d) => d.dateKey === '2026-11-05')!;
    const cell6 = cal.days.find((d) => d.dateKey === '2026-11-06')!;
    expect(cell3.stampKind).toBe('strength');
    expect(cell5.stampKind).toBe('cardio');
    expect(cell5.sessions).toHaveLength(2);
    expect(cell6.stampKind).toBe('rest');
    expect(cell6.workoutCount).toBe(0);
  });
});
