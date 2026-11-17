/* 本轮返工的回归测试：每个用例对应审计报告中的一条已复现问题。
   命名规则：R1-xx / R2-xx 与报告编号对应。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  listPlans,
  listSessions,
  migratePlans,
  migrateSessions,
  restoreBackup,
  savePlan,
  saveSession,
  validateBackup,
} from '../src/db/repo';
import {
  addSetTo,
  createSession,
  exerciseCompletion,
  isSetIncomplete,
  isSetLogged,
  markExerciseDone,
  removeLastRound,
  summarizeSession,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { comparabilityKey, exerciseIdFromName, resolveExerciseId } from '../src/domain/identity';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function setup(dayIndex = 0) {
  const plan = createV32Plan(NOW);
  const day = plan.days[dayIndex];
  const session = createSession(plan, day, NOW);
  return { plan, day, session };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('R1-01 加组后统计被原计划组数封顶', () => {
  it('计划 3 组、实际完成 4 组 → 汇总/历史/统计都是 4 组', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    // 逐组记录 10/9/8，再加一组记 7
    for (const reps of [10, 9, 8]) {
      const target = session.exercises[0].sets.find((s) => s.status === 'blank')!;
      session = withSet(session, dip.id, target.id, { reps, status: 'done' });
    }
    session = addSetTo(session, dip.id);
    const extra = session.exercises[0].sets.at(-1)!;
    session = withSet(session, dip.id, extra.id, { reps: 7, status: 'done' });

    const s = summarizeSession(session, NOW);
    expect(session.exercises[0].sets.filter(isSetLogged)).toHaveLength(4);
    expect(s.completedSets).toBe(4);      // 关键：不再被 3 封顶
    expect(s.targetSets).toBe(17);        // 原计划快照
    expect(s.plannedSets).toBe(18);       // 本次安排
  });

  it('递减组按实际完整大组统计，部分大组单独计', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    // 完整做完 2 轮
    for (const st of session.exercises.find((e) => e.id === lateral.id)!.sets.filter((s) => s.roundIndex <= 2)) {
      session = withSet(session, lateral.id, st.id, { reps: 12, status: 'done' });
    }
    // 第 3 轮只做 1 个阶段
    const third = session.exercises.find((e) => e.id === lateral.id)!.sets.find((s) => s.roundIndex === 3)!;
    session = withSet(session, lateral.id, third.id, { reps: 9, status: 'done' });

    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(2);
    expect(s.partialGroups).toBe(1);
  });
});

describe('R1-02 未填次数仍计入完成组', () => {
  it('点完成但没填次数：不计入有效组，标为缺数据', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    const first = dip.sets[0];
    session = withSet(session, dip.id, first.id, { status: 'done' });
    const set = session.exercises[0].sets[0];
    expect(set.reps).toBeNull();
    expect(set.status).toBe('partial');     // 归一化为缺数据
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.incompleteSets).toBe(1);
  });

  it('实际 0 次是有效记录，与未填写区分', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = withSet(session, dip.id, dip.sets[0].id, { reps: 0, status: 'done' });
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(1);
    expect(s.incompleteSets).toBe(0);
  });

  it('「标记动作完成」不凭空生成有效组', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markExerciseDone(session, dip.id);
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(session.exercises[0].sets.every((set) => set.status === 'blank')).toBe(true);
  });

  it('补上次数后 partial 自动恢复为 done', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    const first = dip.sets[0].id;
    session = withSet(session, dip.id, first, { status: 'done' });
    expect(session.exercises[0].sets[0].status).toBe('partial');
    session = withSet(session, dip.id, first, { reps: 8 });
    expect(session.exercises[0].sets[0].status).toBe('done');
    expect(isSetLogged(session.exercises[0].sets[0])).toBe(true);
  });
});

describe('R2-05 可选 0 组动作被算完成', () => {
  it('背 B 的绳索直臂下拉 0 组，未记录时不算完成动作', () => {
    const plan = createV32Plan(NOW);
    const backB = plan.days.find((d) => d.name === '背 B')!;
    const session = createSession(plan, backB, NOW);
    const opt = session.exercises.find((e) => e.name === '绳索直臂下拉')!;
    expect(exerciseCompletion(opt)).toBe('pending');
    const s = summarizeSession(session, NOW);
    expect(s.exercisesDone).toBe(0);
    expect(s.completedSets).toBe(0);
  });
});

describe('R1-03 损坏备份允许覆盖', () => {
  it('删除某动作的 target 后，整份备份被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    await saveSession(createSession(plan, plan.days[0], NOW));
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));

    // 复刻审计样例：删掉 data.plans[0].days[0].exercises[0].target
    delete backup.data.plans[0].days[0].exercises[0].target;
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('损坏');
      expect(r.issues?.some((i) => i.path.includes('exercises[0].target'))).toBe(true);
    }
  });

  it('校验失败时不写入任何数据', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const before = (await listPlans()).length;

    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    backup.data.plans[0].days[0].exercises[0].target = { kind: 'unknown' };
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
    // 现有数据原封不动
    expect((await listPlans()).length).toBe(before);
  });

  it('拒绝 NaN / Infinity / 负数 / 非法枚举', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const base = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));

    const cases: Array<(b: typeof base) => void> = [
      (b) => { b.data.plans[0].days[0].exercises[0].target.sets = Number.NaN; },
      (b) => { b.data.plans[0].days[0].exercises[0].target.repsMin = Infinity; },
      (b) => { b.data.plans[0].days[0].exercises[0].target.repsMax = -5; },
      (b) => { b.data.plans[0].days[0].exercises[0].restSec = 'abc'; },
      (b) => { b.data.plans[0].days[0].focus = 'arms'; },
      (b) => { b.data.plans[0].cursor = 999; },
      (b) => { b.data.plans[0].days[0].exercises[0].target.kind = 'nope'; },
      (b) => { b.data.plans = []; b.data.sessions = []; }, // 空数据合法，另测
    ];
    for (let i = 0; i < cases.length - 1; i++) {
      const copy = JSON.parse(JSON.stringify(base));
      cases[i](copy);
      const r = validateBackup(copy);
      expect(r.ok, `case ${i} 应被拒绝`).toBe(false);
    }
    // 空数据本身合法
    const empty = JSON.parse(JSON.stringify(base));
    empty.data.plans = [];
    empty.data.sessions = [];
    expect(validateBackup(empty).ok).toBe(true);
  });

  it('重复 ID 被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    backup.data.plans.push(JSON.parse(JSON.stringify(backup.data.plans[0])));
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
  });

  it('次数下限 > 上限被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    backup.data.plans[0].days[0].exercises[0].target.repsMin = 20;
    backup.data.plans[0].days[0].exercises[0].target.repsMax = 10;
    const r = validateBackup(backup);
    expect(r.ok).toBe(false);
  });

  it('合法备份仍可恢复', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    await saveSession(session);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const r = validateBackup(backup);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await idbClear('sessions');
    await restoreBackup(r.payload);
    expect(await listSessions()).toHaveLength(1);
  });
});

describe('R1-06 同一动作跨 A/B 不关联', () => {
  it('胸 A 与胸 B 的双杠臂屈伸是同一 exerciseId', () => {
    const plan = createV32Plan(NOW);
    const chestA = plan.days.find((d) => d.name === '胸 A')!;
    const chestB = plan.days.find((d) => d.name === '胸 B')!;
    const a = chestA.exercises.find((e) => e.name === '双杠臂屈伸')!;
    const b = chestB.exercises.find((e) => e.name === '双杠臂屈伸')!;
    expect(resolveExerciseId(a)).toBe(resolveExerciseId(b));
  });

  it('不同动作不会共用身份', () => {
    const plan = createV32Plan(NOW);
    const chestA = plan.days.find((d) => d.name === '胸 A')!;
    const ids = chestA.exercises.map((e) => resolveExerciseId(e));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('R06：身份只由动作决定，负重模式通过 comparabilityKey 区分', () => {
    const base = {
      id: 'x1',
      name: '引体向上',
      restSec: 120,
      target: {
        kind: 'straight' as const,
        sets: 3,
        setsMax: 3,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'bodyweight' as const,
        suggestedWeightKg: null,
      },
    };
    const plus = { ...base, id: 'x2', target: { ...base.target, weightMode: 'bodyweight_plus' as const } };

    // 同一个动作：身份相同（这样 v1 历史能与迁移后计划匹配上）
    expect(resolveExerciseId(base)).toBe(resolveExerciseId(plus));
    // 但计量口径不同 → 不可直接比较
    expect(comparabilityKey(resolveExerciseId(base), base.target)).not.toBe(
      comparabilityKey(resolveExerciseId(plus), plus.target),
    );
  });

  it('自定义动作按规范化名称稳定', () => {
    expect(exerciseIdFromName('我的 自定义动作')).toBe(exerciseIdFromName('我的自定义动作'));
    expect(exerciseIdFromName('ＷＥＩＲＤ')).toBe(exerciseIdFromName('weird'));
  });
});

describe('R2-04 多个未结束训练', () => {
  it('旧数据里的多个 active 不被删除，迁移后仍可见', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s1 = createSession(plan, plan.days[0], NOW);
    const s2 = createSession(plan, plan.days[1], NOW + 1000);
    await saveSession(s1);
    await saveSession(s2);
    const all = await listSessions();
    expect(all.filter((s) => s.status === 'active')).toHaveLength(2);
  });
});

describe('旧数据升级与历史隔离', () => {
  it('迁移把无次数 done 降级为 partial', () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    const legacy = JSON.parse(JSON.stringify(session)) as Session;
    legacy.exercises[0].sets[0].status = 'done';
    legacy.exercises[0].sets[0].reps = null;
    const [migrated] = migrateSessions([legacy]);
    expect(migrated.exercises[0].sets[0].status).toBe('partial');
    expect(isSetIncomplete(migrated.exercises[0].sets[0])).toBe(true);
  });

  it('迁移给旧计划补 exerciseId，且不改原 name/target', () => {
    const plan = createV32Plan(NOW);
    const legacy = JSON.parse(JSON.stringify(plan)) as Plan;
    for (const d of legacy.days) for (const ex of d.exercises) delete ex.exerciseId;
    const [migrated] = migratePlans([legacy]);
    expect(migrated.days[0].exercises[0].exerciseId).toBeTruthy();
    expect(migrated.days[0].exercises[0].name).toBe(legacy.days[0].exercises[0].name);
    expect(migrated.days[0].exercises[0].target).toEqual(legacy.days[0].exercises[0].target);
  });

  it('迁移给旧训练补 exerciseId', () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    const legacy = JSON.parse(JSON.stringify(session)) as Session;
    for (const ex of legacy.exercises) delete (ex as { exerciseId?: string }).exerciseId;
    const [migrated] = migrateSessions([legacy]);
    expect(migrated.exercises[0].exerciseId).toBe(exerciseIdFromName(migrated.exercises[0].name));
  });
});

describe('递减组轮次增减', () => {
  it('删一轮只删最后一轮，保留前面的记录', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const firstRound = session.exercises.find((e) => e.id === lateral.id)!.sets.filter((s) => s.roundIndex === 1);
    for (const st of firstRound) session = withSet(session, lateral.id, st.id, { reps: 12, status: 'done' });

    const after = removeLastRound(session, lateral.id);
    const ex = after.exercises.find((e) => e.id === lateral.id)!;
    expect(Math.max(...ex.sets.map((s) => s.roundIndex))).toBe(2);
    expect(ex.sets.filter(isSetLogged)).toHaveLength(3); // 第 1 轮的 3 个阶段还在
  });
});

describe('备份格式版本与结构完整性', () => {
  it('导出的备份能被自己的校验器接受', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const b = await buildBackup('1.0.0');
    expect(b.format).toBe(BACKUP_FORMAT);
    expect(b.version).toBe(BACKUP_VERSION);
    const r = validateBackup(JSON.parse(JSON.stringify(b)));
    expect(r.ok).toBe(true);
  });
});
