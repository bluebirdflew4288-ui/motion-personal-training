/* R02 / W01 施工前置失败复现（先红后绿）。
   A：addSetTo 新增轮丢失 stageId → 沿用返回 mismatchRounds/filledFields=0。
   C：逐轮 stageCount 不同时 buildComparableHistory.completeStages 用“完整大组×全局阶段数”误报。
   这些用例直接复现 Codex 在 S/add-round-repro.* 与 S/variable-round-stats.json 的证据，
   修复前必须失败，修复后必须转绿；不得删断言。 */

import { describe, expect, it } from 'vitest';
import { addSetTo, inheritPreviousCompleteRoundForExercise, needsWeight, restAfterSet, sessionExerciseFromPlan } from '../src/domain/session';
import { buildComparableHistory } from '../src/domain/comparability';
import type { DropSetTarget, PlanExercise, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function twoStageTarget(): DropSetTarget {
  return {
    kind: 'dropSet',
    form: 'superset',
    rounds: 2,
    stages: ['a', 'b'].map((id, i) => ({
      id,
      label: `阶段${i + 1}`,
      weightKg: null,
      repsMin: 8,
      repsMax: 12,
      toFailure: false,
      targetText: '',
    })),
    restInSec: 15,
    restAfterSec: 90,
    weightMode: 'external',
  };
}

function makeTwoRoundExercise() {
  const planExercise: PlanExercise = {
    id: 'p-ex',
    exerciseId: 'custom:r02-a',
    name: '模拟三头超级组',
    restSec: 90,
    target: twoStageTarget(),
  };
  const ex = sessionExerciseFromPlan(planExercise);
  const completed = {
    ...ex,
    sets: ex.sets.map((s) => ({ ...s, status: 'done' as const, reps: 10 + s.stageIndex, weightKg: 20 - s.stageIndex })),
  };
  return completed;
}

describe('R02a 新增轮必须继承紧邻上一轮的阶段配置与身份', () => {
  it('2 个已完成轮 × 2 阶段，新增第 3 轮后 stageId 完整，沿用逐阶段填入 4 个字段', () => {
    const ex = makeTwoRoundExercise();
    const added = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];

    expect(added.groups.map((g) => g.stageCount)).toEqual([2, 2, 2]);
    expect(added.sets.filter((s) => s.roundIndex === 3).map((s) => s.stageId)).toEqual(['a', 'b']);
    // 新轮必须是全新空白行：新 id、reps/weight null、status blank，绝不复制运行态
    const round3 = added.sets.filter((s) => s.roundIndex === 3);
    expect(new Set(round3.map((s) => s.id)).size).toBe(2);
    expect(round3.every((s) => s.reps === null && s.weightKg === null && s.status === 'blank')).toBe(true);
    expect(round3.some((s) => s.note !== undefined && s.note !== '')).toBe(false);

    const outcome = inheritPreviousCompleteRoundForExercise(added);
    expect(outcome.mismatchRounds).toEqual([]);
    expect(outcome.noSourceRounds).toEqual([]);
    expect(outcome.filledFields).toBe(4);
    expect(
      outcome.exercise.sets
        .filter((s) => s.roundIndex === 3)
        .map((s) => ({ reps: s.reps, weightKg: s.weightKg, status: s.status })),
    ).toEqual([
      { reps: 11, weightKg: 19, status: 'blank' },
      { reps: 12, weightKg: 18, status: 'blank' },
    ]);
  });
});

describe('R02b/C 逐轮 stageCount 的真实统计口径', () => {
  it('第一轮 3 阶段、第二轮 2 阶段实际 5 行：completeStages 必须是 5 而不是 6', () => {
    const stages = ['a', 'b', 'c'].map((id) => ({
      id,
      label: id,
      weightKg: null,
      repsMin: 8,
      repsMax: 12,
      toFailure: false,
      targetText: '',
    }));
    const planExercise: PlanExercise = {
      id: 'p',
      exerciseId: 'synthetic-flex',
      name: '模拟变轮结构',
      restSec: 90,
      target: {
        kind: 'dropSet',
        form: 'superset',
        rounds: 2,
        stages,
        restInSec: 15,
        restAfterSec: 90,
        weightMode: 'external',
      },
    };
    const ex0 = sessionExerciseFromPlan(planExercise);
    const ex = {
      ...ex0,
      groups: [
        { index: 1, stageCount: 3 },
        { index: 2, stageCount: 2 },
      ],
      sets: ex0.sets
        .filter((s) => !(s.roundIndex === 2 && s.stageIndex === 3))
        .map((s) => ({ ...s, status: 'done' as const, reps: 10, weightKg: 10 })),
    };
    const session: Session = {
      id: 's',
      planId: 'p',
      planName: 'P',
      day: { dayId: 'd', dayName: '模拟', partText: '模拟' },
      cycleIndexAtStart: 0,
      startedAt: NOW,
      endedAt: NOW + 1000,
      status: 'completed',
      pausedMs: 0,
      pausedAt: null,
      warmups: [],
      exercises: [ex],
      note: '',
    };
    const history = buildComparableHistory([session], 'synthetic-flex');
    expect(history).not.toBeNull();
    const entry = history!.entries[0];
    expect(ex.sets.length).toBe(5);
    expect(entry.completeGroups).toBe(2);
    expect(entry.loggedStages).toBe(5);
    expect(entry.completeStages).toBe(5);
  });
});

/* ── R02b 逐轮配置（纯领域，先于 UI）────────────────────────── */

import { applyTargetToExercise, groupPlanForTarget, planTargetApply, resolveGroupConfig, validateExerciseTarget } from '../src/domain/exerciseConfig';
import { defaultDropDraft, draftToDropTarget, dropTargetToDraft, setDropDraftRounds, updateRoundStages } from '../src/domain/dropSet';
import { mergeFlushedDropDraft } from '../src/ui/draftForm';
import type { DropRoundConfig } from '../src/domain/types';

function stage(id: string, weightKg: number, repsMin: number | null = 8, repsMax: number | null = 12, toFailure = false, restAfterSec?: number) {
  return {
    id,
    label: `阶段-${id}`,
    weightKg,
    repsMin,
    repsMax,
    toFailure,
    targetText: '',
    ...(restAfterSec !== undefined ? { restAfterSec } : {}),
  };
}

function variableRoundTarget(): DropSetTarget {
  return {
    kind: 'dropSet',
    form: 'superset',
    rounds: 2,
    stages: [stage('a', 20, 8, 12, false, 15), stage('b', 15, 8, 12, true, 20), stage('c', 10, null, null, true)],
    roundConfigs: [
      {
        roundIndex: 2,
        stages: [stage('a2', 20, 6, 10, false, 25), stage('b2', 15, 10, 15, true)],
        restInSec: 25,
      },
    ],
    restInSec: 15,
    restAfterSec: 90,
    weightMode: 'external',
  };
}

describe('R02b 逐轮阶段结构与配置解析', () => {
  it('groupPlanForTarget 按逐轮真实 stageCount（3/2），不是全局阶段数', () => {
    expect(groupPlanForTarget(variableRoundTarget()).map((g) => g.stageCount)).toEqual([3, 2]);
  });

  it('resolveGroupConfig 按轮返回独立次数范围/参考重量/力竭/阶段短歇，互不串轮', () => {
    const t = variableRoundTarget();
    expect(resolveGroupConfig(t, 1, 1)).toMatchObject({ repsMin: 8, repsMax: 12, weightKg: 20, toFailure: false, restAfterSec: 15 });
    expect(resolveGroupConfig(t, 2, 1)).toMatchObject({ repsMin: 6, repsMax: 10, weightKg: 20, toFailure: false, restAfterSec: 25 });
    expect(resolveGroupConfig(t, 2, 2)).toMatchObject({ repsMin: 10, repsMax: 15, weightKg: 15, toFailure: true, restAfterSec: null });
    // 第 1 轮不受第 2 轮覆盖影响
    expect(resolveGroupConfig(t, 1, 2).repsMin).toBe(8);
  });

  it('总行数按各轮求和：20 轮 × 12 阶段（默认 6 + 覆盖）超 200 行必须拒绝', () => {
    const stages = Array.from({ length: 6 }, (_, i) => stage(`s${i}`, 10));
    const roundConfigs: DropRoundConfig[] = Array.from({ length: 20 }, (_, i) => ({
      roundIndex: i + 1,
      stages: Array.from({ length: 12 }, (_, j) => stage(`r${i + 1}s${j}`, 10)),
    }));
    const bad: DropSetTarget = { kind: 'dropSet', rounds: 20, stages, roundConfigs, restInSec: 15, restAfterSec: 90, weightMode: 'external' };
    const issues = validateExerciseTarget(bad);
    expect(issues.some((i) => i.message.includes('超过单动作上限'))).toBe(true);
  });

  it('draft 只把修改的轮写成 override：第 1 轮默认 stages 不被第 2 轮重写', () => {
    const draft = defaultDropDraft();
    draft.rounds = 2;
    const round2 = draft.stages.map((s) => ({ ...s, id: `r2-${s.id ?? 'x'}` }));
    round2[1] = { ...round2[1], repsMin: 10, repsMax: 15 };
    const next = updateRoundStages(draft, 2, round2);
    const target = draftToDropTarget(next);
    expect(target.stages).toHaveLength(3);
    expect(target.roundConfigs).toHaveLength(1);
    expect(target.roundConfigs?.[0].roundIndex).toBe(2);
    expect(target.roundConfigs?.[0].stages.map((s) => s.repsMin)).toEqual([8, 10, null]);
    // 第 1 轮原文保持
    expect(target.stages.map((s) => s.repsMin)).toEqual([8, 8, null]);
    // roundtrip：再进草稿仍保留第 2 轮覆盖
    const again = dropTargetToDraft(target);
    expect(again.roundOverrides?.map((r) => r.roundIndex)).toEqual([2]);
    expect(again.roundOverrides?.[0].stages[1].repsMin).toBe(10);
  });

  it('应用逐轮改动：只动目标轮结构，其他轮 ID/actual/完成状态不变，删除已记录阶段需确认', () => {
    const t = variableRoundTarget();
    const planExercise = { id: 'p', exerciseId: 'custom:r02b', name: '变轮超级组', restSec: 90, target: t };
    const ex0 = sessionExerciseFromPlan(planExercise);
    let ex = {
      ...ex0,
      sets: ex0.sets.map((s, i) => ({ ...s, reps: 10 + i, weightKg: 20, status: 'done' as const })),
    };
    // 第 2 轮改为 3 阶段（新增 d 阶段），第 1 轮保持 3 阶段
    const nextTarget: DropSetTarget = {
      ...t,
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage('a2', 20, 6, 10), stage('b2', 15, 10, 15, true), stage('d2', 10, 8, 12)],
        },
      ],
    };
    const applied = applyTargetToExercise(ex, nextTarget);
    expect(applied.applied).toBe(true);
    const next = applied.exercise;
    expect(next.groups.map((g) => g.stageCount)).toEqual([3, 3]);
    // 第 1 轮 3 行 ID 原样保留
    const round1Before = ex.sets.filter((s) => s.roundIndex === 1);
    const round1After = next.sets.filter((s) => s.roundIndex === 1);
    expect(round1After.map((s) => s.id)).toEqual(round1Before.map((s) => s.id));
    expect(round1After.map((s) => s.reps)).toEqual(round1Before.map((s) => s.reps));
    // 第 2 轮已有 2 行原样保留，仅新增第 3 行空白
    expect(next.sets.filter((s) => s.roundIndex === 2).map((s) => s.status)).toEqual(['done', 'done', 'blank']);
  });
});

describe('W01 重量模式切换影响确认', () => {
  it('已有记录数值切换 weightMode：未确认拒绝，确认后保留数值且口径改变', () => {
    const straight = {
      id: 'p-w01',
      exerciseId: 'custom:w01',
      name: '绳索夹胸',
      restSec: 90,
      target: { kind: 'straight' as const, sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'bodyweight' as const, suggestedWeightKg: null },
    };
    const ex0 = sessionExerciseFromPlan(straight);
    const ex = { ...ex0, sets: ex0.sets.map((s) => ({ ...s, reps: 10, weightKg: 25, status: 'done' as const })) };
    const next = { ...straight.target, weightMode: 'external' as const, suggestedWeightKg: 25 };
    const impact = planTargetApply(ex, next);
    expect(impact.needsConfirmation).toBe(true);
    expect(impact.messages.join('')).toContain('重量口径');
    expect(impact.messages.join('')).toContain('2 条记录');
    const blocked = applyTargetToExercise(ex, next);
    expect(blocked.applied).toBe(false);
    const ok = applyTargetToExercise(ex, next, { confirmImpact: true });
    expect(ok.applied).toBe(true);
    expect(ok.exercise.target.weightMode).toBe('external');
    expect(ok.exercise.sets.map((s) => [s.reps, s.weightKg])).toEqual([[10, 25], [10, 25]]);
  });
});

describe('R02b 沿用：逐轮不同阶段数时按稳定身份对应', () => {
  it('来源 3 阶段、目标第 2 轮 2 阶段：a/b 明确对应沿用，c 无对应保持空白并计入提示', () => {
    const target: DropSetTarget = {
      kind: 'dropSet',
      form: 'superset',
      rounds: 2,
      stages: [stage('a', 20), stage('b', 15), stage('c', 10, null, null, true)],
      roundConfigs: [{ roundIndex: 2, stages: [stage('a', 20), stage('b', 15)] }],
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
    const ex0 = sessionExerciseFromPlan({ id: 'p', exerciseId: 'custom:r02b-inherit', name: '变轮', restSec: 90, target });
    let ex = {
      ...ex0,
      sets: ex0.sets.map((s) =>
        s.roundIndex === 1
          ? { ...s, reps: 10 + s.stageIndex, weightKg: 20 - s.stageIndex, status: 'done' as const }
          : s,
      ),
    };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2).sort((a, b) => a.stageIndex - b.stageIndex);
    expect(r2.map((s) => [s.reps, s.weightKg])).toEqual([[11, 19], [12, 18]]);
    expect(out.filledFields).toBe(4);
    expect(out.unmatchedStages).toBe(0);
  });

  it('目标阶段身份在来源中不存在：保持空白且不硬配其他阶段', () => {
    const target: DropSetTarget = {
      kind: 'dropSet', form: 'superset', rounds: 2,
      stages: [stage('a', 20), stage('b', 15), stage('c', 10, null, null, true)],
      roundConfigs: [{ roundIndex: 2, stages: [stage('a', 20), stage('x', 15)] }],
      restInSec: 15, restAfterSec: 90, weightMode: 'external',
    };
    const ex0 = sessionExerciseFromPlan({ id: 'p', exerciseId: 'custom:r02b-inherit2', name: '变轮', restSec: 90, target });
    const ex = { ...ex0, sets: ex0.sets.map((s) => (s.roundIndex === 1 ? { ...s, reps: 10, weightKg: 10, status: 'done' as const } : s)) };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2).sort((a, b) => a.stageIndex - b.stageIndex);
    expect(r2[0]).toMatchObject({ reps: 10, weightKg: 10 });
    expect(r2[1]).toMatchObject({ reps: null, weightKg: null });
    expect(out.unmatchedStages).toBe(1);
  });
});

describe('R02a 旧 addSetTo 缺失 stageId 轮的确定性兼容', () => {
  it('旧第三轮缺 stageId、配置可唯一对应 → 补齐 id 并沿用；不复制运行态', () => {
    const ex = makeTwoRoundExercise();
    // 模拟旧 addSetTo：第三轮 rows 没有 stageId（group stageCount 2 == target stages 2）
    const legacyThird = [
      { id: 'legacy-r3s1', roundIndex: 3, stageIndex: 1, reps: null, weightKg: null, status: 'blank' as const },
      { id: 'legacy-r3s2', roundIndex: 3, stageIndex: 2, reps: null, weightKg: null, status: 'blank' as const },
    ];
    const broken = {
      ...ex,
      groups: [...ex.groups, { index: 3, stageCount: 2 }],
      sets: [...ex.sets, ...legacyThird],
    };
    const out = inheritPreviousCompleteRoundForExercise(broken);
    expect(out.mismatchRounds).toEqual([]);
    const r3 = out.exercise.sets.filter((s) => s.roundIndex === 3).sort((a, b) => a.stageIndex - b.stageIndex);
    expect(r3.map((s) => s.stageId)).toEqual(['a', 'b']);
    expect(r3.map((s) => [s.reps, s.weightKg])).toEqual([
      [11, 19],
      [12, 18],
    ]);
  });

  it('配置阶段数与组快照不一致（无法证明唯一）→ 不补 stageId、整轮 mismatch', () => {
    const target = twoStageTarget();
    // 人为让 target 全局 3 阶段、组快照 2 阶段 → 不能按位置硬配
    target.stages.push({ id: 'c', label: '阶段3', weightKg: null, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' });
    const planExercise: PlanExercise = { id: 'p', exerciseId: 'custom:r02a', name: '歧义', restSec: 90, target };
    const ex0 = sessionExerciseFromPlan(planExercise);
    const broken = {
      ...ex0,
      groups: [
        { index: 1, stageCount: 3 },
        { index: 2, stageCount: 3 },
        { index: 3, stageCount: 2 },
      ],
      sets: [
        ...ex0.sets.map((s) => ({ ...s, status: 'done' as const, reps: 10, weightKg: 10 })),
        { id: 'amb1', roundIndex: 3, stageIndex: 1, reps: null, weightKg: null, status: 'blank' as const },
        { id: 'amb2', roundIndex: 3, stageIndex: 2, reps: null, weightKg: null, status: 'blank' as const },
      ],
    };
    const out = inheritPreviousCompleteRoundForExercise(broken);
    expect(out.mismatchRounds).toContain(3);
    const r3 = out.exercise.sets.filter((s) => s.roundIndex === 3);
    expect(r3.every((s) => s.stageId === undefined)).toBe(true);
  });
});

describe('R02b 逐轮休息', () => {
  it('第 1 轮 3 阶段：15/20/90；第 2 轮 2 阶段：25/90（末阶段接整轮）', () => {
    const t = variableRoundTarget();
    const ex = sessionExerciseFromPlan({ id: 'p', exerciseId: 'custom:r02-rest', name: '变轮', restSec: 90, target: t });
    const get = (r: number, s: number) => ex.sets.find((x) => x.roundIndex === r && x.stageIndex === s)!;
    expect(restAfterSet(ex, get(1, 1))).toBe(15);
    expect(restAfterSet(ex, get(1, 2))).toBe(20);
    expect(restAfterSet(ex, get(1, 3))).toBe(90);
    expect(restAfterSet(ex, get(2, 1))).toBe(25);
    expect(restAfterSet(ex, get(2, 2))).toBe(90);
  });
});


describe('R02b 计划配置面板 flush 合并', () => {
  it('未 blur 的第 2 轮字段也会进入 roundOverrides，而不是被旧 draft 覆盖', () => {
    const base = defaultDropDraft();
    base.rounds = 2;
    const next = mergeFlushedDropDraft(base, {
      'drop.r2s0.weight': 30,
      'drop.r2s0.repsMin': 7,
      'drop.r2s0.repsMax': 9,
    }, 'drop');
    const override = next.roundOverrides?.find((r) => r.roundIndex === 2);
    expect(override).toBeTruthy();
    expect(override!.stages[0].weightKg).toBe(30);
    expect(override!.stages[0].repsMin).toBe(7);
    expect(override!.stages[0].repsMax).toBe(9);
    // 第 1 轮默认值不被第 2 轮 flush 覆盖
    expect(next.stages[0].repsMin).toBe(8);
  });

  it('未 blur 的轮数 2→3 flush：新轮复制上一轮 override 结构', () => {
    const base = defaultDropDraft();
    base.rounds = 2;
    const round2 = base.stages.slice(0, 2).map((s) => ({ ...s, id: `r2-${s.id ?? 'x'}` }));
    const withOverride = updateRoundStages(base, 2, round2);
    const next = mergeFlushedDropDraft(withOverride, { 'drop.rounds': 3 }, 'drop');
    expect(next.rounds).toBe(3);
    const r3 = next.roundOverrides?.find((r) => r.roundIndex === 3);
    expect(r3?.stages.length).toBe(2);
    expect(r3?.stages.map((s) => s.id)).toEqual(round2.map((s) => s.id));
  });
});

describe('W02 needsWeight 统一显示重量', () => {
  it('external/bodyweight/bodyweight_plus/assisted 全部显示重量（straight 与 dropSet 同规则）', () => {
    const base = {
      id: 'p', exerciseId: 'custom:w', name: 'w', restSec: 90,
      target: { kind: 'straight' as const, sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'external' as const, suggestedWeightKg: null },
    };
    const modes = ['external', 'bodyweight', 'bodyweight_plus', 'assisted'] as const;
    const got = modes.map((m) => needsWeight({ ...sessionExerciseFromPlan(base), target: { ...base.target, weightMode: m } }));
    expect(got).toEqual([true, true, true, true]);
    const dropEx = sessionExerciseFromPlan({
      ...base,
      target: { kind: 'dropSet', form: 'superset', rounds: 1, stages: [stage('a', 10), stage('b', 5)], restInSec: 15, restAfterSec: 90, weightMode: 'bodyweight' },
    });
    expect(needsWeight(dropEx)).toBe(true);
  });
});


describe('R02b 计划编辑器轮数变化', () => {
  it('2→3：新轮继承第 2 轮结构（不是默认第 1 轮）', () => {
    let d = defaultDropDraft();
    d.rounds = 2;
    const round2 = d.stages.slice(0, 2).map((s) => ({ ...s, id: `r2-${s.id ?? 'x'}` }));
    d = updateRoundStages(d, 2, round2);
    d = setDropDraftRounds(d, 3);
    expect(d.rounds).toBe(3);
    expect(draftToDropTarget(d).roundConfigs?.map((r) => [r.roundIndex, r.stages.length])).toEqual([
      [2, 2],
      [3, 2],
    ]);
  });
});

describe('R02a 新增轮继承紧邻上一轮的逐轮配置', () => {
  it('上一轮是 2 阶段覆盖时，新轮也是 2 阶段并沿用该轮 stageId/toFailure，不落回全局 3 阶段', () => {
    const t = variableRoundTarget();
    const ex = sessionExerciseFromPlan({ id: 'p', exerciseId: 'custom:r02a2', name: '变轮', restSec: 90, target: t });
    const added = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(added.groups.map((g) => g.stageCount)).toEqual([3, 2, 2]);
    const r3 = added.sets.filter((s) => s.roundIndex === 3).sort((a, b) => a.stageIndex - b.stageIndex);
    expect(r3.map((s) => s.stageId)).toEqual(['a2', 'b2']);
    expect(r3.map((s) => Boolean(s.toFailure))).toEqual([false, true]);
    expect(r3.every((s) => s.reps === null && s.weightKg === null && s.status === 'blank')).toBe(true);
  });
});
