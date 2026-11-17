import { describe, expect, it } from 'vitest';
import {
  dropRoundComplete,
  inheritPreviousCompleteRound,
  inheritPreviousCompleteRoundForExercise,
} from '../src/domain/session';
import type { DropSetTarget, Session, SessionExercise, SessionSet } from '../src/domain/types';

/**
 * R01：多阶段（超级组/递减组）「未完成轮沿用上一完整轮」的纯领域回归。
 *
 * 证明：
 *  · 三阶段各值不同的前一轮 → 后一轮**逐阶段对应**沿用，不把最后一阶段套到全部阶段；
 *  · 每字段只在 null 时补，0 是有效值，已填 reps/weight 一律保留；来源 null 不覆盖；
 *  · 已完成轮 / 跳过轮不被修改；没有最近完整来源则不沿用（记录轮号）；
 *  · 阶段结构无法可靠对应则整轮跳过（不凭空补）；
 *  · 旧数据（无 stageId）按 stageIndex 兼容；
 *  · 不改 status/note/toFailure/结构，不改其他动作，纯函数不修改入参，重复执行幂等。
 *
 * 不证明：真实点击/持久化链路（由 DOM 行为测试覆盖）。
 */

const NOW = 1_760_000_000_000;

function makeStages(n: number, ids?: (string | null)[]) {
  return Array.from({ length: n }, (_, i) => ({
    id: ids ? (ids[i] ?? undefined) : `stage-${i + 1}`,
    label: `阶段${i + 1}`,
    weightKg: null,
    repsMin: 8,
    repsMax: 10,
    toFailure: false,
    targetText: '',
  }));
}

function makeDropExercise(opts?: {
  rounds?: number;
  stageCount?: number;
  form?: 'dropSet' | 'superset';
  stageIds?: (string | null)[];
  withStageIdOnSets?: boolean;
}): SessionExercise {
  const rounds = opts?.rounds ?? 3;
  const stageCount = opts?.stageCount ?? 3;
  const form = opts?.form ?? 'superset';
  const withStageIdOnSets = opts?.withStageIdOnSets ?? true;
  const target: DropSetTarget = {
    kind: 'dropSet',
    form,
    rounds,
    stages: makeStages(stageCount, opts?.stageIds),
    restInSec: 30,
    restAfterSec: 90,
    weightMode: 'external',
  };
  const groups = Array.from({ length: rounds }, (_, i) => ({ index: i + 1, stageCount }));
  const sets: SessionSet[] = [];
  for (let r = 1; r <= rounds; r++) {
    for (let s = 1; s <= stageCount; s++) {
      const stageId = target.stages[s - 1]?.id;
      sets.push({
        id: `r${r}s${s}`,
        roundIndex: r,
        stageIndex: s,
        ...(withStageIdOnSets && stageId ? { stageId } : {}),
        reps: null,
        weightKg: null,
        status: 'blank',
      });
    }
  }
  return {
    id: 'ex1',
    exerciseId: 'custom:ex1',
    planExerciseId: null,
    name: '多阶段动作',
    restSec: 60,
    target,
    status: 'pending',
    groups,
    sets,
  };
}

function setVals(
  ex: SessionExercise,
  round: number,
  stage: number,
  reps: number | null,
  weightKg: number | null,
  status: 'blank' | 'done' | 'partial' = 'blank',
  extra?: Partial<SessionSet>,
): SessionExercise {
  return {
    ...ex,
    sets: ex.sets.map((s) =>
      s.roundIndex === round && s.stageIndex === stage
        ? { ...s, reps, weightKg, status, ...(extra ?? {}) }
        : s,
    ),
  };
}

function completeRound(
  ex: SessionExercise,
  round: number,
  values: Array<[number | null, number | null]>,
): SessionExercise {
  let next = ex;
  values.forEach(([reps, w], i) => {
    next = setVals(next, round, i + 1, reps, w, 'done');
  });
  return next;
}

function getSet(ex: SessionExercise, round: number, stage: number): SessionSet {
  return ex.sets.find((s) => s.roundIndex === round && s.stageIndex === stage)!;
}

function baseSession(exercises: SessionExercise[]): Session {
  return {
    id: 's1',
    planId: 'p1',
    planName: 'P',
    day: { dayId: 'd1', dayName: 'D', partText: 'D' },
    cycleIndexAtStart: 0,
    startedAt: NOW,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: [],
    exercises,
    note: '',
  };
}

describe('R01 逐阶段沿用上一完整轮', () => {
  it('超级组：三阶段各值不同 → 后一轮逐阶段对应，不把最后一阶段套全部', () => {
    const ex0 = completeRound(makeDropExercise({ form: 'superset' }), 1, [
      [10, 20],
      [12, 15],
      [15, 10],
    ]);
    expect(dropRoundComplete(ex0, 1)).toBe(true);
    const out = inheritPreviousCompleteRoundForExercise(ex0);

    // 两个未完成轮（2、3）各 3 阶段 × 2 字段 = 12 个字段、6 个 set
    expect(out.filledFields).toBe(12);
    expect(out.filledSets).toBe(6);

    // 第 2 轮逐阶段严格对应
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: 10, weightKg: 20 });
    expect(getSet(out.exercise, 2, 2)).toMatchObject({ reps: 12, weightKg: 15 });
    expect(getSet(out.exercise, 2, 3)).toMatchObject({ reps: 15, weightKg: 10 });
    // 反证：不是“最后一阶段(15,10) 覆盖全部阶段”
    expect(getSet(out.exercise, 2, 1).reps).not.toBe(getSet(out.exercise, 2, 3).reps);
    expect(getSet(out.exercise, 2, 1).weightKg).not.toBe(getSet(out.exercise, 2, 3).weightKg);

    // 第 3 轮最近完整来源仍是第 1 轮（第 2 轮未完成/未标 done）
    expect(getSet(out.exercise, 3, 1)).toMatchObject({ reps: 10, weightKg: 20 });

    // 已完成的第 1 轮不被改动
    expect(getSet(out.exercise, 1, 1)).toMatchObject({ reps: 10, weightKg: 20, status: 'done' });
    // 补值的轮**不**被标成 done
    expect(getSet(out.exercise, 2, 1).status).toBe('blank');
    expect(getSet(out.exercise, 3, 1).status).toBe('blank');
  });

  it('递减组：只补空白、保留已填、0 是有效值、来源 null 不覆盖', () => {
    let ex = makeDropExercise({ form: 'dropSet', rounds: 2 });
    // 第 1 轮完整：阶段1 (8,0)；阶段2 (12,null)；阶段3 (0,30)  —— 0 与 null 都是有效语义
    ex = completeRound(ex, 1, [
      [8, 0],
      [12, null],
      [0, 30],
    ]);
    expect(dropRoundComplete(ex, 1)).toBe(true);
    // 第 2 轮：阶段1 次数已填 99（要保留），重量 null；带备注与 toFailure（要保留）
    ex = setVals(ex, 2, 1, 99, null, 'blank', { note: '保留我', toFailure: true });

    const out = inheritPreviousCompleteRoundForExercise(ex);

    // 阶段1：次数保留 99；重量 null → 补 0（0 是有效值）
    expect(getSet(out.exercise, 2, 1)).toMatchObject({
      reps: 99,
      weightKg: 0,
      note: '保留我',
      toFailure: true,
    });
    // 阶段2：次数 null → 12；来源重量 null → 保持 null（不凭空造重量）
    expect(getSet(out.exercise, 2, 2)).toMatchObject({ reps: 12, weightKg: null });
    // 阶段3：次数 null → 0（0 有效）；重量 null → 30
    expect(getSet(out.exercise, 2, 3)).toMatchObject({ reps: 0, weightKg: 30 });
    // 4 个字段：阶段1 重量、阶段2 次数、阶段3 次数+重量
    expect(out.filledFields).toBe(4);
    expect(out.filledSets).toBe(3);
    // 全轮 status 仍是 blank（未自动完成）
    expect(getSet(out.exercise, 2, 1).status).toBe('blank');
    expect(getSet(out.exercise, 2, 2).status).toBe('blank');
  });

  it('已完成轮与跳过轮不被修改；跳过轮后仍从最近的完整轮取值', () => {
    let ex = makeDropExercise({ rounds: 4 });
    ex = completeRound(ex, 1, [
      [10, 20],
      [11, 21],
      [12, 22],
    ]);
    ex = completeRound(ex, 2, [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    ex = {
      ...ex,
      groups: ex.groups.map((g) => (g.index === 3 ? { ...g, skipped: true } : g)),
    };

    const out = inheritPreviousCompleteRoundForExercise(ex);

    // 第 2 轮已完成 → 不被第 1 轮覆盖
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: 1, weightKg: 2 });
    // 第 3 轮被跳过 → 不补
    expect(getSet(out.exercise, 3, 1)).toMatchObject({ reps: null, weightKg: null });
    // 第 4 轮 → 最近完整来源是第 2 轮（第 3 轮跳过非完整）
    expect(getSet(out.exercise, 4, 1)).toMatchObject({ reps: 1, weightKg: 2 });
    // 第 4 轮 3 阶段 × 2 = 6 字段
    expect(out.filledFields).toBe(6);
    expect(out.filledSets).toBe(3);
  });

  it('没有完整来源：不沿用，记录无来源轮号', () => {
    let ex = makeDropExercise({ rounds: 2 });
    // 第 1 轮只有一个阶段填了（partial，不完整）
    ex = setVals(ex, 1, 1, 10, 20, 'partial');
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.filledFields).toBe(0);
    expect(out.filledSets).toBe(0);
    expect(out.noSourceRounds).toEqual([1, 2]);
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: null, weightKg: null });
  });

  it('阶段结构无法可靠对应（稳定 ID 不一致）→ 整轮跳过，不凭空补', () => {
    let ex = makeDropExercise({ rounds: 2, stageIds: ['x1', 'x2', 'x3'] });
    ex = completeRound(ex, 1, [
      [10, 20],
      [11, 21],
      [12, 22],
    ]);
    // 第 2 轮阶段 ID 与第 1 轮不一致（结构改动）
    ex = {
      ...ex,
      sets: ex.sets.map((s) =>
        s.roundIndex === 2 ? { ...s, stageId: `y${s.stageIndex}` } : s,
      ),
    };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
    expect(out.filledSets).toBe(0);
    // 整轮都不补，不能只补能对上的阶段
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: null, weightKg: null });
    expect(getSet(out.exercise, 2, 2)).toMatchObject({ reps: null, weightKg: null });
  });

  it('旧数据（无 stageId）按 stageIndex 位置兼容对应', () => {
    let ex = makeDropExercise({ rounds: 2, withStageIdOnSets: false });
    ex = completeRound(ex, 1, [
      [10, 20],
      [11, 21],
      [12, 22],
    ]);
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(6);
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: 10, weightKg: 20 });
    expect(getSet(out.exercise, 2, 2)).toMatchObject({ reps: 11, weightKg: 21 });
    expect(getSet(out.exercise, 2, 3)).toMatchObject({ reps: 12, weightKg: 22 });
  });

  it('会话级：不修改入参、不影响其他动作、状态不变、重复执行幂等', () => {
    let ex = completeRound(makeDropExercise({ rounds: 2 }), 1, [
      [10, 20],
      [11, 21],
      [12, 22],
    ]);
    const other = { ...makeDropExercise({ rounds: 1 }), id: 'ex2', exerciseId: 'custom:ex2' };
    const session = baseSession([ex, other]);

    const out1 = inheritPreviousCompleteRound(session, 'ex1');
    expect(out1.filledFields).toBe(6);
    // 原会话未被原地修改（纯函数）
    expect(getSet(session.exercises[0], 2, 1).reps).toBeNull();
    // 其他动作对象引用不变
    expect(out1.session.exercises[1]).toBe(other);
    // 第 2 轮仍全 blank（不自动标完成）
    expect(
      out1.session.exercises[0].sets
        .filter((s) => s.roundIndex === 2)
        .every((s) => s.status === 'blank'),
    ).toBe(true);
    // 幂等：再执行一次没有可补字段
    const out2 = inheritPreviousCompleteRound(out1.session, 'ex1');
    expect(out2.filledFields).toBe(0);
    expect(out2.filledSets).toBe(0);
  });

  it('普通组（straight）不受影响（原语义不动）', () => {
    const straight: SessionExercise = {
      id: 'st1',
      exerciseId: 'custom:st1',
      planExerciseId: null,
      name: '普通动作',
      restSec: 60,
      target: {
        kind: 'straight',
        sets: 2,
        setsMax: 2,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'external',
        suggestedWeightKg: 20,
      },
      status: 'pending',
      groups: [
        { index: 1, stageCount: 1 },
        { index: 2, stageCount: 1 },
      ],
      sets: [
        { id: 'a', roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 20, status: 'done' },
        { id: 'b', roundIndex: 2, stageIndex: 1, reps: null, weightKg: null, status: 'blank' },
      ],
    };
    const out = inheritPreviousCompleteRoundForExercise(straight);
    expect(out.filledFields).toBe(0);
    expect(out.exercise).toBe(straight); // 原对象原样返回，未改动
  });
});

describe('R01 缺陷回归（Codex 独立审查 4 项 + requiredStages）', () => {
  it('已完成(done)阶段整条不动：done 阶段 null weight 不补', () => {
    let ex = makeDropExercise({ rounds: 2 });
    ex = completeRound(ex, 1, [[10, 20], [11, 21], [12, 22]]);
    // 第 2 轮 stage2 已完成（reps=4）但 weight=null —— 不得被补 weight
    ex = setVals(ex, 2, 2, 4, null, 'done');
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(getSet(out.exercise, 2, 2)).toMatchObject({ reps: 4, weightKg: null, status: 'done' });
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: 10, weightKg: 20 });
    expect(getSet(out.exercise, 2, 3)).toMatchObject({ reps: 12, weightKg: 22 });
    expect(out.filledFields).toBe(4); // 只补 stage1/3 各 2 字段
  });

  it('来源 stageId 重复（a,a,c）→ 整轮 skip，不硬配', () => {
    let ex = makeDropExercise({ rounds: 2, stageIds: ['a', 'a', 'c'] });
    ex = completeRound(ex, 1, [[10, 20], [11, 21], [12, 22]]);
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: null, weightKg: null });
  });

  it('混合稳定 ID（部分阶段有/无）→ 整轮 skip', () => {
    let ex = makeDropExercise({ rounds: 2 });
    ex = completeRound(ex, 1, [[10, 20], [11, 21], [12, 22]]);
    // 去掉来源第 1 轮 stage2 的 stageId → 来源「混合」
    ex = {
      ...ex,
      sets: ex.sets.map((s) =>
        s.roundIndex === 1 && s.stageIndex === 2 ? { ...s, stageId: undefined } : s,
      ),
    };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
  });

  it('目标轮缺阶段（requiredStages=3 但只有 stage1/3）→ 整轮 skip，不凭空补', () => {
    let ex = makeDropExercise({ rounds: 2 });
    ex = completeRound(ex, 1, [[10, 20], [11, 21], [12, 22]]);
    ex = { ...ex, sets: ex.sets.filter((s) => !(s.roundIndex === 2 && s.stageIndex === 2)) };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: null, weightKg: null });
    expect(getSet(out.exercise, 2, 3)).toMatchObject({ reps: null, weightKg: null });
  });

  it('被跳过的轮（即便残留 3 行 done）不得作来源；改用更早的合法完整轮', () => {
    let ex = makeDropExercise({ rounds: 3 });
    ex = completeRound(ex, 1, [[1, 10], [2, 20], [3, 30]]);
    ex = completeRound(ex, 2, [[4, 40], [5, 50], [6, 60]]);
    // 第 2 轮标记 skipped，但仍有 3 行 done（must NOT 作来源）
    ex = { ...ex, groups: ex.groups.map((g) => (g.index === 2 ? { ...g, skipped: true } : g)) };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(getSet(out.exercise, 3, 1)).toMatchObject({ reps: 1, weightKg: 10 });
    expect(getSet(out.exercise, 3, 2)).toMatchObject({ reps: 2, weightKg: 20 });
    expect(getSet(out.exercise, 3, 3)).toMatchObject({ reps: 3, weightKg: 30 });
    expect(out.filledFields).toBe(6);
  });

  it('来源与目标 requiredStages 不一致 → 整轮 skip', () => {
    const ex0 = makeDropExercise({ rounds: 2 });
    let ex: SessionExercise = {
      ...ex0,
      groups: [
        { index: 1, stageCount: 2 },
        { index: 2, stageCount: 3 },
      ],
      sets: ex0.sets.filter((s) => (s.roundIndex === 1 ? s.stageIndex <= 2 : true)),
    };
    ex = completeRound(ex, 1, [[10, 20], [11, 21]]); // 来源轮只有 2 阶段
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
  });

  it('部分轮成功、部分轮结构不匹配：filledFields>0 且返回被跳过轮号', () => {
    let ex = makeDropExercise({ rounds: 3 });
    ex = completeRound(ex, 1, [[10, 20], [11, 21], [12, 22]]);
    // 第 3 轮缺 stage2（结构不匹配），第 2 轮可正常沿用
    ex = { ...ex, sets: ex.sets.filter((s) => !(s.roundIndex === 3 && s.stageIndex === 2)) };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.filledFields).toBe(6); // 第 2 轮 3 阶段 × 2
    expect(out.mismatchRounds).toEqual([3]);
    expect(getSet(out.exercise, 2, 1)).toMatchObject({ reps: 10, weightKg: 20 });
  });
});
