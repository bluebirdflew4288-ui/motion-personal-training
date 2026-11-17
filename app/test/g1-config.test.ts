/* G1 数据契约：每组/阶段配置、力竭与参考次数、形式、阶段身份、间歇、
   合理应用与影响确认（ACCEPTANCE D01–D09 的领域侧证据）。
   所有测试用合成数据；不读取真实训练库。 */

import { describe, expect, it } from 'vitest';
import type { ExerciseTarget, Plan, PlanDay, Session, StraightTarget } from '../src/domain/types';
import {
  createSession,
  exerciseCompletion,
  restAfterSet,
  summarizeSession,
  applyTargetToSessionExercise,
  withSet,
} from '../src/domain/session';
import {
  applyTargetToExercise,
  assessExerciseIdentityChange,
  groupPlanForTarget,
  resolveGroupConfig,
  restSecondsForSet,
  trainingFormOf,
  validateExerciseTarget,
} from '../src/domain/exerciseConfig';
import {
  defaultDropDraft,
  draftToDropTarget,
  dropTargetToDraft,
  moveStage,
  removeStage,
} from '../src/domain/dropSet';

const NOW = 1_760_000_000_000;

function straightTarget(over: Partial<StraightTarget> = {}): StraightTarget {
  return {
    kind: 'straight',
    sets: 3,
    setsMax: 3,
    repsMin: 8,
    repsMax: 12,
    weightMode: 'external',
    suggestedWeightKg: 60,
    ...over,
  };
}

function multiTarget(over: Partial<Extract<ExerciseTarget, { kind: 'dropSet' }>> = {}) {
  const t: Extract<ExerciseTarget, { kind: 'dropSet' }> = {
    kind: 'dropSet',
    rounds: 2,
    stages: [
      { id: 's1', label: '上半程', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
      { id: 's2', label: '下半程', weightKg: 15, repsMin: 8, repsMax: 12, toFailure: true, restAfterSec: 20, targetText: '' },
      { id: 's3', label: '全程', weightKg: 10, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
    ],
    restInSec: 30,
    restAfterSec: 90,
    weightMode: 'external',
    ...over,
  };
  return t;
}

function makePlan(): Plan {
  const day: PlanDay = {
    id: 'd1',
    name: '胸 A',
    kind: 'train',
    warmups: [],
    exercises: [
      {
        id: 'pe1',
        exerciseId: 'lib-barbell-bench',
        name: '自由杠铃卧推',
        restSec: 120,
        target: straightTarget(),
      },
      {
        id: 'pe2',
        exerciseId: 'lib-lateral-raise',
        name: '哑铃侧平举',
        restSec: 90,
        target: multiTarget(),
      },
    ],
  };
  return { id: 'p1', name: '测试计划', days: [day], cursor: 2, createdAt: NOW, updatedAt: NOW };
}

function makeSession(): { plan: Plan; session: Session; day: PlanDay } {
  const plan = makePlan();
  const day = plan.days[0];
  return { plan, session: createSession(plan, day, NOW), day };
}

describe('D03 三种训练形式与合法组结构', () => {
  it('straight / superset / dropSet 都有明确形式，组数/轮数不倍增', () => {
    const straight = straightTarget({ sets: 4, setsMax: 4 });
    const superset = multiTarget({ form: 'superset', rounds: 3 });
    const drop = multiTarget({ rounds: 2 });

    expect(trainingFormOf(straight)).toBe('straight');
    expect(trainingFormOf(superset)).toBe('superset');
    expect(trainingFormOf(drop)).toBe('dropSet');

    expect(groupPlanForTarget(straight)).toHaveLength(4);
    expect(groupPlanForTarget(superset)).toHaveLength(3);
    expect(groupPlanForTarget(drop)).toHaveLength(2);
    expect(groupPlanForTarget(superset).every((g) => g.stageCount === 3)).toBe(true);

    expect(validateExerciseTarget(straight)).toEqual([]);
    expect(validateExerciseTarget(superset)).toEqual([]);
    expect(validateExerciseTarget(drop)).toEqual([]);
    // 重量口径原样保留
    expect(superset.weightMode).toBe('external');
    expect(drop.weightMode).toBe('external');
  });

  it('旧 kind 联合未被破坏：超级组仍走 dropSet 兼容分支（summary/identity 不会 half support）', () => {
    const superset = multiTarget({ form: 'superset' });
    expect(superset.kind).toBe('dropSet');
    // 旧 API 只认识 straight/dropSet，仍可处理
    expect(groupPlanForTarget(superset).length).toBe(superset.rounds);
  });
});

describe('D04/D05 每组/阶段独立力竭与参考次数', () => {
  it('普通组可按组独立力竭：同一次配置中多组不同', () => {
    const t = straightTarget({
      sets: 3,
      perSetConfigs: [
        { setIndex: 1, repsMin: 8, repsMax: 12, suggestedWeightKg: 60, toFailure: false },
        { setIndex: 2, repsMin: 5, repsMax: 8, suggestedWeightKg: 65, toFailure: true },
        { setIndex: 3, repsMin: null, repsMax: null, suggestedWeightKg: 50, toFailure: true },
      ],
    });
    expect(validateExerciseTarget(t)).toEqual([]);
    expect(resolveGroupConfig(t, 1).toFailure).toBe(false);
    expect(resolveGroupConfig(t, 2).toFailure).toBe(true);
    expect(resolveGroupConfig(t, 2).repsMin).toBe(5);
    // 力竭组仍可选填参考次数；未设置是 null，不是 0
    expect(resolveGroupConfig(t, 3).toFailure).toBe(true);
    expect(resolveGroupConfig(t, 3).repsMin).toBeNull();
  });

  it('多阶段每个阶段独立力竭；同轮可有多个力竭阶段', () => {
    const t = multiTarget();
    expect(resolveGroupConfig(t, 1, 1).toFailure).toBe(false);
    expect(resolveGroupConfig(t, 1, 2).toFailure).toBe(true);
    expect(resolveGroupConfig(t, 1, 3).toFailure).toBe(true);
    // 力竭不注销次数
    expect(resolveGroupConfig(t, 1, 2).repsMin).toBe(8);
  });

  it('null 与 0 不混淆；空的力竭参考范围合法，0 是明确数值', () => {
    const empty: ExerciseTarget = multiTarget({
      stages: [
        { id: 'a', label: 'A', weightKg: null, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
        { id: 'b', label: 'B', weightKg: null, repsMin: 0, repsMax: 0, toFailure: false, targetText: '' },
      ],
    });
    expect(validateExerciseTarget(empty)).toEqual([]);
    expect(resolveGroupConfig(empty, 1, 1).repsMin).toBeNull();
    expect(resolveGroupConfig(empty, 1, 1).repsMax).toBeNull();
    expect(resolveGroupConfig(empty, 1, 2).repsMin).toBe(0);
    expect(resolveGroupConfig(empty, 1, 2).repsMax).toBe(0);
  });

  it('反向、半填、NaN、越界在力竭时仍然被校验（不因勾选力竭绕过）', () => {
    const reverse = multiTarget({
      stages: [
        { id: 'a', label: 'A', weightKg: 10, repsMin: 20, repsMax: 10, toFailure: true, targetText: '' },
        { id: 'b', label: 'B', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
      ],
    });
    expect(validateExerciseTarget(reverse).some((i) => i.message.includes('下限'))).toBe(true);

    const half = multiTarget({
      stages: [
        { id: 'a', label: 'A', weightKg: 10, repsMin: null, repsMax: 10, toFailure: true, targetText: '' },
        { id: 'b', label: 'B', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
      ],
    });
    expect(validateExerciseTarget(half).some((i) => i.message.includes('同时'))).toBe(true);

    const nan = straightTarget({ repsMin: Number.NaN, repsMax: 12 });
    expect(validateExerciseTarget(nan).some((i) => i.message.includes('整数'))).toBe(true);

    const outOfRange = straightTarget({ repsMin: 0, repsMax: 9999 });
    expect(validateExerciseTarget(outOfRange).some((i) => i.message.includes('0–500'))).toBe(true);
  });
});

describe('D06 阶段名与阶段身份往返', () => {
  it('自定义阶段名 上半程/下半程/全程 经 draft → target → draft 原文保留，不串阶段', () => {
    const draft = defaultDropDraft();
    draft.stages = draft.stages.map((st, i) => ({
      ...st,
      id: `fixed-stage-${i + 1}`,
      label: ['上半程', '下半程', '全程'][i],
      restAfterSec: [15, 20, 90][i],
    }));
    const target = draftToDropTarget(draft);
    expect(target.stages.map((s) => s.label)).toEqual(['上半程', '下半程', '全程']);
    expect(target.stages.map((s) => s.id)).toEqual(['fixed-stage-1', 'fixed-stage-2', 'fixed-stage-3']);

    const round = dropTargetToDraft(target);
    expect(round.stages.map((s) => s.label)).toEqual(['上半程', '下半程', '全程']);
    expect(round.stages.map((s) => s.id)).toEqual(['fixed-stage-1', 'fixed-stage-2', 'fixed-stage-3']);
    expect(round.stages.map((s) => s.restAfterSec)).toEqual([15, 20, 90]);
  });
});

describe('D07 各段独立间歇，末阶段只接整轮休息', () => {
  it('第一段15、第二段20、整轮90：逐阶段准确，末阶段不再叠加短休息', () => {
    const t = multiTarget();
    expect(restSecondsForSet(t, 1, 1, 0)).toBe(15);
    expect(restSecondsForSet(t, 1, 2, 0)).toBe(20);
    expect(restSecondsForSet(t, 1, 3, 0)).toBe(90);
    // 旧数据没有 per-stage restAfterSec 时回退 restInSec（旧语义）
    const legacy = multiTarget({
      stages: [
        { id: 'a', label: 'A', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
        { id: 'b', label: 'B', weightKg: 5, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
      ],
      restInSec: 25,
      restAfterSec: 120,
    });
    expect(restSecondsForSet(legacy, 1, 1, 0)).toBe(25);
    expect(restSecondsForSet(legacy, 1, 2, 0)).toBe(120);
    // 普通组用 ex.restSec
    expect(restSecondsForSet(straightTarget(), 1, 1, 150)).toBe(150);
  });

  it('组快照 stageCount 优先于 target 阶段数：target 3阶段、本组快照2阶段 → 第2阶段取整轮90', () => {
    const { session } = makeSession();
    const ex0 = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const ex = { ...ex0, groups: [{ index: 1, stageCount: 2 }] };
    const second = { ...ex.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 2)! };
    expect(restAfterSet(ex, second)).toBe(90);
    const first = { ...ex.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)! };
    expect(restAfterSet(ex, first)).toBe(15);
  });

  it('session.restAfterSet 与统一解析函数同源', () => {
    const { session } = makeSession();
    const ex = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const first = ex.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    const last = ex.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 3)!;
    expect(restAfterSet(ex, first)).toBe(15);
    expect(restAfterSet(ex, last)).toBe(90);
  });
});

describe('D08 3组已做2组后删空白第3组', () => {
  it('动作按本次2组完成，前2组 actual/ID 不变，原计划仍3组', () => {
    // 只保留一个动作，便于把「原计划 3 组」与本次完成度分开核对
    const plan = makePlan();
    plan.days[0].exercises = [plan.days[0].exercises[0]];
    const session = createSession(plan, plan.days[0], NOW);
    const ex0 = session.exercises[0];
    let s = session;
    const set1 = ex0.sets[0];
    const set2 = ex0.sets[1];
    s = withSet(s, ex0.id, set1.id, { reps: 10, weightKg: 60, status: 'done' });
    s = withSet(s, ex0.id, set2.id, { reps: 9, weightKg: 60, status: 'done' });

    const beforePlanJson = JSON.stringify(plan);
    const idsBefore = [set1.id, set2.id];

    const r = applyTargetToSessionExercise(s, ex0.id, straightTarget({ sets: 2, setsMax: 2 }));
    expect(r.applied).toBe(true);
    const next = r.session.exercises.find((e) => e.id === ex0.id)!;

    expect(next.sets).toHaveLength(2);
    expect(next.sets.map((x) => x.id)).toEqual(idsBefore);
    expect(next.sets.map((x) => x.reps)).toEqual([10, 9]);
    expect(next.groups).toHaveLength(2);
    expect(exerciseCompletion(next)).toBe('done');

    const sum = summarizeSession(r.session, NOW + 1000);
    expect(sum.targetSets).toBe(3); // 原计划目标快照保持 3
    expect(sum.plannedSets).toBe(2); // 本次按 2 组完成
    expect(sum.completedSets).toBe(2);
    // 原计划对象完全没变（深比较）
    expect(JSON.stringify(plan)).toBe(beforePlanJson);
  });
});

describe('D01/D09 应用到当前训练：不写计划；已有记录必须影响确认；不自动拆卡', () => {
  it('改名称/组数/形式/阶段名不会改原计划、历史或循环游标', () => {
    const { plan, session } = makeSession();
    const before = JSON.stringify(plan);
    const ex = session.exercises[1];
    const target = multiTarget({ form: 'superset', rounds: 3 });
    const r = applyTargetToSessionExercise(session, ex.id, target);
    expect(r.applied).toBe(true);
    expect(JSON.stringify(plan)).toBe(before);
    expect(plan.cursor).toBe(2);
    // 只影响目标动作，其他动作原样
    expect(r.session.exercises[0]).toEqual(session.exercises[0]);
    expect(r.session.exercises).toHaveLength(session.exercises.length);
    expect((r.session.exercises[1].target as { form?: string }).form).toBe('superset');
  });

  it('删除含实际输入的组：未确认不执行，确认后执行且不静默丢记录', () => {
    const { session } = makeSession();
    const ex = session.exercises[0];
    let s = withSet(session, ex.id, ex.sets[2].id, { reps: 8, weightKg: 60, status: 'done' });

    const blocked = applyTargetToExercise(s.exercises[0], straightTarget({ sets: 2, setsMax: 2 }));
    expect(blocked.applied).toBe(false);
    expect(blocked.impact.needsConfirmation).toBe(true);
    expect(blocked.impact.removedWithData).toHaveLength(1);
    expect(blocked.impact.removedWithData[0].groupIndex).toBe(3);
    expect(blocked.impact.removedWithData[0].reason).toContain('8 次');

    const confirmed = applyTargetToExercise(s.exercises[0], straightTarget({ sets: 2, setsMax: 2 }), {
      confirmImpact: true,
    });
    expect(confirmed.applied).toBe(true);
    expect(confirmed.exercise.sets).toHaveLength(2);
    // 不自动拆卡：动作数不变
    expect(s.exercises).toHaveLength(2);
  });

  it('真实动作身份变更返回明确影响信息；仅改显示名不算身份变化', () => {
    const { session } = makeSession();
    const ex = session.exercises[0];
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, weightKg: 60, status: 'done' });
    const withActual = s.exercises[0];

    const changed = assessExerciseIdentityChange(withActual, 'lib-other-exercise', '别的动作');
    expect(changed.changed).toBe(true);
    expect(changed.hasActual).toBe(true);
    expect(changed.affectedGroups).toEqual([1]);
    expect(changed.message).toContain('确认');

    const renamed = assessExerciseIdentityChange(withActual, withActual.exerciseId, '新显示名');
    expect(renamed.changed).toBe(false);
    expect(renamed.message).toContain('只改显示名');
  });

  it('非法目标配置被 apply API 统一校验拒绝，session 原样返回', () => {
    const { session } = makeSession();
    const ex = session.exercises[0];
    const bad = straightTarget({ repsMin: 20, repsMax: 10 });
    const r = applyTargetToExercise(ex, bad);
    expect(r.applied).toBe(false);
    expect(r.exercise).toBe(ex);
    expect(r.impact.validationIssues.length).toBeGreaterThan(0);
    expect(r.impact.messages[0]).toContain('配置不合法');
  });

  it('删除空白组直接执行（无实际输入不需要确认）', () => {
    const { session } = makeSession();
    const ex = session.exercises[0];
    const r = applyTargetToExercise(ex, straightTarget({ sets: 2, setsMax: 2 }));
    expect(r.applied).toBe(true);
    expect(r.impact.removedWithData).toHaveLength(0);
    expect(r.impact.removedBlankCount).toBe(1);
  });
});

describe('G1-PRE-REVIEW #1 阶段稳定 ID 真正用于映射（删除首/中、重排、只改 label）', () => {
  function threeStageSession(useIds: boolean): { session: Session } {
    const t = multiTarget({ rounds: 1 });
    if (!useIds) {
      t.stages = t.stages.map((st) => ({ label: st.label, weightKg: st.weightKg, repsMin: st.repsMin, repsMax: st.repsMax, toFailure: st.toFailure, targetText: '' }));
    }
    const plan = makePlan();
    plan.days[0].exercises = [
      { id: 'pe-x', exerciseId: 'lib-lateral-raise', name: '哑铃侧平举', restSec: 90, target: t },
    ];
    const session = createSession(plan, plan.days[0], NOW);
    const ex = session.exercises[0];
    let s = session;
    [11, 12, 13].forEach((reps, i) => {
      s = withSet(s, ex.id, ex.sets[i].id, { reps, weightKg: 10 + i, status: 'done' });
    });
    return { session: s };
  }

  it('删除首阶段：旧阶段2/3的实际记录按 ID 跟随到新阶段1/2，首阶段列入影响', () => {
    const { session } = threeStageSession(true);
    const oldEx = session.exercises[0];
    const oldIds = oldEx.sets.map((s) => s.id);
    const draft = dropTargetToDraft(oldEx.target as Extract<ExerciseTarget, { kind: 'dropSet' }>);
    const nextTarget = draftToDropTarget(removeStage(draft, 0));

    const r = applyTargetToExercise(oldEx, nextTarget);
    expect(r.applied).toBe(false); // 首阶段有 actual，需要确认
    expect(r.impact.removedWithData.map((x) => x.stageIndex)).toEqual([1]);

    const done = applyTargetToExercise(oldEx, nextTarget, { confirmImpact: true });
    expect(done.applied).toBe(true);
    expect(done.exercise.sets.map((s) => s.reps)).toEqual([12, 13]);
    expect(done.exercise.sets.map((s) => s.id)).toEqual([oldIds[1], oldIds[2]]);
    expect(done.exercise.sets.map((s) => s.stageId)).toEqual(['s2', 's3']);
  });

  it('删除中间阶段同理，不把阶段3的记录串到阶段2', () => {
    const { session } = threeStageSession(true);
    const oldEx = session.exercises[0];
    const draft = dropTargetToDraft(oldEx.target as Extract<ExerciseTarget, { kind: 'dropSet' }>);
    const nextTarget = draftToDropTarget(removeStage(draft, 1));
    const done = applyTargetToExercise(oldEx, nextTarget, { confirmImpact: true });
    expect(done.exercise.sets.map((s) => s.reps)).toEqual([11, 13]);
    expect(done.exercise.sets.map((s) => s.stageId)).toEqual(['s1', 's3']);
  });

  it('重排阶段：actual 跟随阶段 ID 移动', () => {
    const { session } = threeStageSession(true);
    const oldEx = session.exercises[0];
    const draft = dropTargetToDraft(oldEx.target as Extract<ExerciseTarget, { kind: 'dropSet' }>);
    const nextTarget = draftToDropTarget(moveStage(draft, 1, -1)); // [s2, s1, s3]
    const done = applyTargetToExercise(oldEx, nextTarget);
    expect(done.applied).toBe(true);
    expect(done.impact.removedWithData).toHaveLength(0);
    expect(done.exercise.sets.map((s) => s.stageId)).toEqual(['s2', 's1', 's3']);
    expect(done.exercise.sets.map((s) => s.reps)).toEqual([12, 11, 13]);
  });

  it('旧数据无 stage.id：编辑草稿一次性稳定化后删除首阶段仍能正确映射', () => {
    const { session } = threeStageSession(false);
    const oldEx = session.exercises[0];
    expect(oldEx.sets.every((s) => s.stageId === undefined)).toBe(true);
    const draft = dropTargetToDraft(oldEx.target as Extract<ExerciseTarget, { kind: 'dropSet' }>);
    expect(draft.stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2', 'stage-pos-3']);
    const nextTarget = draftToDropTarget(removeStage(draft, 0));
    const done = applyTargetToExercise(oldEx, nextTarget, { confirmImpact: true });
    expect(done.exercise.sets.map((s) => s.reps)).toEqual([12, 13]);
    expect(done.exercise.sets.map((s) => s.stageId)).toEqual(['stage-pos-2', 'stage-pos-3']);
  });

  it('ID 相同只改 label：不删除任何 actual，记录完整保留', () => {
    const { session } = threeStageSession(true);
    const oldEx = session.exercises[0];
    const draft = dropTargetToDraft(oldEx.target as Extract<ExerciseTarget, { kind: 'dropSet' }>);
    draft.stages[1].label = '改过的阶段名';
    const done = applyTargetToExercise(oldEx, draftToDropTarget(draft));
    expect(done.applied).toBe(true);
    expect(done.impact.removedWithData).toHaveLength(0);
    expect(done.exercise.sets.map((s) => s.reps)).toEqual([11, 12, 13]);
    expect((done.exercise.target as Extract<ExerciseTarget, { kind: 'dropSet' }>).stages[1].label).toBe('改过的阶段名');
  });
});

describe('G1-PRE-REVIEW #2 普通配置编辑保留 skipped 状态', () => {
  it('只改名称/参考次数/阶段名时，已跳过组不被重新激活；新增组默认未跳过', () => {
    const { session } = makeSession();
    const ex = session.exercises[0];
    let s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, weightKg: 60, status: 'done' });
    s = {
      ...s,
      exercises: s.exercises.map((e) =>
        e.id === ex.id ? { ...e, groups: e.groups.map((g) => (g.index === 2 ? { ...g, skipped: true } : g)) } : e,
      ),
    };
    const oldEx = s.exercises[0];
    const next = straightTarget({ sets: 4, setsMax: 4, repsMin: 6, repsMax: 10 });
    const done = applyTargetToExercise(oldEx, next);
    expect(done.applied).toBe(true);
    expect(done.exercise.groups.map((g) => Boolean(g.skipped))).toEqual([false, true, false, false]);
    expect(done.exercise.sets[0].reps).toBe(10);
  });
});

describe('D02 旧数据按旧语义读取（不生成幽灵组/阶段）', () => {
  it('旧 straight 缺少 toFailure/perSetConfigs：全局次数生效，力竭默认 false', () => {
    const old = straightTarget();
    expect(resolveGroupConfig(old, 1).toFailure).toBe(false);
    expect(resolveGroupConfig(old, 1).repsMin).toBe(8);
    expect(groupPlanForTarget(old)).toHaveLength(3);
  });

  it('旧 dropSet 缺少 stage.id 与 per-stage rest：位置读取、restInSec 回退', () => {
    const legacy = multiTarget({
      stages: [
        { label: '第 1 阶段', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, targetText: 'old' },
        { label: '第 2 阶段', weightKg: 15, repsMin: 8, repsMax: 12, toFailure: false, targetText: 'old' },
      ],
      restInSec: 45,
      restAfterSec: 180,
    });
    expect(resolveGroupConfig(legacy, 1, 1).stageId).toBeNull();
    expect(resolveGroupConfig(legacy, 1, 1).restAfterSec).toBe(45);
    expect(groupPlanForTarget(legacy)).toHaveLength(2);
  });
});
