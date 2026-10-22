import { describe, expect, it } from 'vitest';
import {
  addSetTo,
  createSession,
  dropRoundComplete,
  elapsedMs,
  exerciseCompletion,
  hasAnyData,
  removeSetFrom,
  roundsOf,
  summarizeSession,
  targetSetsOfPlan,
  withExercise,
  withSet,
} from '../src/domain/session';
import { createV32Plan, expectedSetRange } from '../src/domain/presets/v32';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function setup(dayIndex = 0) {
  const plan = createV32Plan(NOW);
  const day = plan.days[dayIndex];
  const session = createSession(plan, day, NOW);
  return { plan, day, session };
}

function markAllSetsDone(ex: Session, exId: string): Session {
  const target = ex.exercises.find((e) => e.id === exId)!;
  let next = ex;
  for (const s of target.sets) {
    next = withSet(next, exId, s.id, { reps: 10, weightKg: 60, status: 'done' });
  }
  return next;
}

describe('V3.2 预设与 PDF 一致', () => {
  it('八个循环日，六个训练日', () => {
    const plan = createV32Plan(NOW);
    expect(plan.days).toHaveLength(8);
    expect(plan.days.filter((d) => d.kind === 'train')).toHaveLength(6);
  });

  it('各训练日目标组数与 PDF 标注一致', () => {
    const plan = createV32Plan(NOW);
    const expected: Record<string, [number, number]> = {
      '胸 A': [17, 17],
      '背 A': [16, 17],
      '腿 A': [20, 20],
      '胸 B': [17, 17],
      '背 B': [17, 20],
      '腿 B': [20, 20],
    };
    for (const day of plan.days.filter((d) => d.kind === 'train')) {
      const range = expectedSetRange(day);
      expect([range.min, range.max], `${day.name} 组数`).toEqual(expected[day.name]);
    }
  });

  it('侧平举按 3 个正式大组计入，不是 9 组', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const lateral = legsA.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(lateral.target.kind).toBe('dropSet');
    if (lateral.target.kind === 'dropSet') {
      expect(lateral.target.rounds).toBe(3);
      expect(lateral.target.stages).toHaveLength(3);
    }
    // 3 轮 × 3 阶段 = 9 条记录，但只算 3 个正式大组
    expect(targetSetsOfPlan(legsA)).toBe(20);
  });

  it('胸 A 第一个动作是双杠臂屈伸（PDF P03 顺序）', () => {
    const plan = createV32Plan(NOW);
    expect(plan.days[0].exercises[0].name).toBe('双杠臂屈伸');
    expect(plan.days[0].exercises[1].name).toBe('自由杠铃卧推');
  });
});

describe('组数统计口径', () => {
  it('计划内未做的组不算已完成组', () => {
    const { session } = setup();
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.targetSets).toBe(17);
  });

  it('直练动作：三组全做完才记 3 组', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    expect(dip.target.kind).toBe('straight');
    session = markAllSetsDone(session, dip.id);
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(3);
  });

  it('临时加组并实际完成，计入实际总量（计划 3 组做 4 组 = 4 组）', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markAllSetsDone(session, dip.id);
    session = addSetTo(session, dip.id);
    const extra = session.exercises[0].sets.at(-1)!;
    session = withSet(session, dip.id, extra.id, { reps: 8, status: 'done' });
    const s = summarizeSession(session, NOW);
    expect(session.exercises[0].sets).toHaveLength(4);
    // 实际 4 组不因原计划 3 组被封顶
    expect(s.completedSets).toBe(4);
    // 原始目标快照不变，便于对照
    expect(s.targetSets).toBe(17);
    expect(s.plannedSets).toBe(18);
  });

  it('临时删组不篡改原始目标快照', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markAllSetsDone(session, dip.id);
    const first = session.exercises[0].sets[0];
    session = removeSetFrom(session, dip.id, first.id);
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(2);
    expect(s.targetSets).toBe(17);          // 计划目标没变
    expect(s.plannedSets).toBe(16);         // 本次安排少了一组
  });

  it('实际 0 次与未填写是两种状态', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    const first = dip.sets[0];
    session = withSet(session, dip.id, first.id, { reps: 0, status: 'done' });
    const after = session.exercises[0].sets[0];
    expect(after.reps).toBe(0);
    expect(after.status).toBe('done');
    expect(summarizeSession(session, NOW).completedSets).toBe(1);

    const untouched = dip.sets[1];
    expect(untouched.reps).toBeNull();
    expect(untouched.status).toBe('blank');
  });

  it('点了完成但没填次数：不计入完整有效组，单独统计', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    const first = dip.sets[0];
    session = withSet(session, dip.id, first.id, { status: 'done' }); // reps 仍为 null
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.incompleteSets).toBe(1);
    // 动作状态是「部分完成」（已开始记录但不完整），绝不是 done
    expect(exerciseCompletion(session.exercises[0])).toBe('partial');
  });

  it('实际 0 次算有效记录（与未填写区分）', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    const first = dip.sets[0];
    session = withSet(session, dip.id, first.id, { reps: 0, status: 'done' });
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(1);
    expect(s.incompleteSets).toBe(0);
  });

  it('可选 0 组动作不伪装成已完成', () => {
    const plan = createV32Plan(NOW);
    const backB = plan.days.find((d) => d.name === '背 B')!;
    let session = createSession(plan, backB, NOW);
    const opt = session.exercises.find((e) => e.name === '绳索直臂下拉')!;
    expect(opt.target.kind === 'straight' && opt.target.sets).toBe(0);
    const s = summarizeSession(session, NOW);
    // 完全没有记录时，0 组动作不能算完成
    expect(s.exercisesDone).toBe(0);
    expect(exerciseCompletion(opt)).toBe('pending');
  });

  it('动作状态与汇总口径一致（同一来源）', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markAllSetsDone(session, dip.id);
    const s = summarizeSession(session, NOW);
    expect(exerciseCompletion(session.exercises[0])).toBe('done');
    expect(s.exercisesDone).toBe(1);
    // 一个动作只能落在一个分类里
    expect(s.exercisesDone + s.exercisesPartial + s.exercisesSkipped + s.exercisesPending).toBe(
      session.exercises.length,
    );
  });

  it('跳过动作不产生已完成组', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = withExercise(session, dip.id, { status: 'skipped' });
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.exercisesSkipped).toBe(1);
  });

  it('递减组：一轮三阶段全做完记 1 个正式大组', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(session.exercises.find((e) => e.id === lateral.id)!.sets).toHaveLength(9);

    let next = session;
    for (const st of next.exercises.find((e) => e.id === lateral.id)!.sets.filter((s) => s.roundIndex === 1)) {
      next = withSet(next, lateral.id, st.id, { reps: 12, weightKg: st.stageIndex === 1 ? 7.5 : 5, status: 'done' });
    }
    expect(dropRoundComplete(next.exercises.find((e) => e.id === lateral.id)!, 1)).toBe(true);
    expect(summarizeSession(next, NOW).completedSets).toBe(1);
  });

  it('递减组：一轮只做部分阶段 → 记为部分完成大组，不算完整组', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const first = session.exercises.find((e) => e.id === lateral.id)!.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    session = withSet(session, lateral.id, first.id, { reps: 14, weightKg: 7.5, status: 'done' });
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.partialGroups).toBe(1);
  });

  it('递减组九条记录不会膨胀成九组', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    let next = session;
    for (const st of next.exercises.find((e) => e.id === lateral.id)!.sets) {
      next = withSet(next, lateral.id, st.id, { reps: 12, status: 'done' });
    }
    expect(summarizeSession(next, NOW).completedSets).toBe(3);
    expect(roundsOf(next.exercises.find((e) => e.id === lateral.id)!)).toEqual([1, 2, 3]);
  });

  it('删除一组后统计同步下降', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markAllSetsDone(session, dip.id);
    expect(summarizeSession(session, NOW).completedSets).toBe(3);
    const toRemove = session.exercises[0].sets[0];
    session = removeSetFrom(session, dip.id, toRemove.id);
    expect(summarizeSession(session, NOW).completedSets).toBe(2);
  });

  it('热身已完成也不计入正式组', () => {
    let { session } = setup();
    session = { ...session, warmups: session.warmups.map((w) => ({ ...w, done: true })) };
    expect(summarizeSession(session, NOW).completedSets).toBe(0);
    expect(hasAnyData(session)).toBe(true);
  });
});

describe('时长与暂停', () => {
  it('总经过时长扣除暂停时间', () => {
    const { session } = setup();
    const paused = { ...session, pausedMs: 5 * 60_000 };
    expect(elapsedMs(paused, NOW + 60 * 60_000)).toBe(55 * 60_000);
  });

  it('正在暂停时按当前时间计算', () => {
    const { session } = setup();
    const pausing = { ...session, pausedAt: NOW + 10 * 60_000 };
    expect(elapsedMs(pausing, NOW + 20 * 60_000)).toBe(10 * 60_000);
  });

  it('结束后时长固定', () => {
    const { session } = setup();
    const ended = { ...session, endedAt: NOW + 30 * 60_000, status: 'completed' as const };
    expect(elapsedMs(ended, NOW + 999 * 60_000)).toBe(30 * 60_000);
  });
});

describe('部分完成', () => {
  it('只做一个动作也能结束，统计如实反映', () => {
    let { session } = setup();
    const dip = session.exercises[0];
    session = markAllSetsDone(session, dip.id);
    session = { ...session, status: 'completed', endedAt: NOW + 20 * 60_000 };
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(3);
    expect(s.exercisesDone).toBe(1);
    expect(s.exercisesPending).toBe(7);
    expect(s.exercisesPartial).toBe(0);
  });
});
