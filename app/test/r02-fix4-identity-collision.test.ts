/* R02 FIX4：不可信 fallback 阶段身份不得撞上目标内任何可信身份。
   根因（Codex 独立 8 项边界探针复现）：
   inferRoundStageIdentities 只用「本轮 explicitIds」初始化兜底避让集合，
   于是无 id 的未知阶段会得到 stage-pos-<轮>-<阶段>，若该字符串恰好等于
   默认模板或其它轮 override 的**显式可信 ID**，继承逻辑会把它误认为同源，
   从而把来源轮的实际 reps/weight 错误复制到本无对应关系的阶段。

   修复口径：fallback 身份同时避让「全目标可信身份」（默认模板显式/位置身份 +
   各轮 override 显式 ID）与「本轮已占用/已生成身份」；显式 ID 原样保留，
   真实同源 ID 与唯一名称映射照常沿用。以下用例均从真实入口造数据。 */

import { describe, expect, it } from 'vitest';
import { draftToDropTarget, dropTargetToDraft } from '../src/domain/dropSet';
import {
  applyTargetToExercise,
  ensureStageIds,
  inferRoundStageIdentities,
  reservedStageIdsForTarget,
  resolveRoundStageIdentities,
  stageIdentityAtForGroup,
  validateExerciseTarget,
} from '../src/domain/exerciseConfig';
import { createSession, inheritPreviousCompleteRoundForExercise, sessionExerciseFromPlan } from '../src/domain/session';
import type {
  DropSetTarget,
  DropStageTarget,
  Plan,
  PlanDay,
  PlanExercise,
  SessionExercise,
} from '../src/domain/types';

const NOW = 1_760_000_000_000;

function stage(over: Partial<DropStageTarget> & { label?: string } = {}): DropStageTarget {
  return {
    ...(over.id ? { id: over.id } : {}),
    label: over.label ?? '阶段',
    weightKg: over.weightKg ?? 10,
    repsMin: over.repsMin ?? 8,
    repsMax: over.repsMax ?? 12,
    toFailure: over.toFailure ?? false,
    targetText: '',
  };
}

function dropTarget(over: Partial<DropSetTarget> = {}): DropSetTarget {
  return {
    kind: 'dropSet',
    rounds: 2,
    stages: [stage({ label: '阶段1' }), stage({ label: '阶段2' }), stage({ label: '阶段3' })],
    restInSec: 15,
    restAfterSec: 90,
    weightMode: 'external',
    ...over,
  };
}

function planExercise(target: DropSetTarget): PlanExercise {
  return { id: 'p-fix4', exerciseId: 'custom:fix4', name: 'FIX4 多阶段', restSec: 90, target };
}

function sessionExercise(target: DropSetTarget): SessionExercise {
  return sessionExerciseFromPlan(planExercise(target));
}

function markRoundDone(ex: SessionExercise, round: number): SessionExercise {
  return {
    ...ex,
    sets: ex.sets.map((s) =>
      s.roundIndex === round
        ? { ...s, reps: 10 + s.stageIndex, weightKg: 30 - s.stageIndex, status: 'done' as const }
        : s,
    ),
  };
}

function inherit(ex: SessionExercise) {
  return inheritPreviousCompleteRoundForExercise(ex);
}

/** 默认模板显式 ID + 第 2 轮未知名称：来源 = 默认第 1 轮 */
function defaultSourceCollisionTarget(): DropSetTarget {
  return dropTarget({
    stages: [
      stage({ id: 'stage-pos-2-1', label: '默认A' }),
      stage({ id: 'default-1', label: '默认B' }),
      stage({ id: 'default-2', label: '默认C' }),
    ],
    roundConfigs: [
      { roundIndex: 2, stages: [stage({ label: '快' }), stage({ label: '慢' })] },
    ],
  });
}

/** 其它轮 override 显式 ID + 第 2 轮未知名称：来源 = 第 1 轮 override */
function overrideSourceCollisionTarget(): DropSetTarget {
  return dropTarget({
    stages: [stage({ id: 'default-0' }), stage({ id: 'default-1' }), stage({ id: 'default-2' })],
    roundConfigs: [
      { roundIndex: 1, stages: [stage({ id: 'stage-pos-2-1', label: '源A' }), stage({ id: 'old-r1-b', label: '源B' })] },
      { roundIndex: 2, stages: [stage({ label: '快' }), stage({ label: '慢' })] },
    ],
  });
}

describe('FIX4-1 默认模板来源：fallback 不得撞上可信显式 ID', () => {
  it('默认第 1 阶段显式 stage-pos-2-1 + 第 2 轮未知名称 → 安全空白，不沿用实际值', () => {
    const target = defaultSourceCollisionTarget();
    const ids = resolveRoundStageIdentities(target, 2);
    expect(ids.map((r) => r.confidence)).toEqual(['fallback', 'fallback']);
    const idList = ids.map((r) => r.id);
    // 不可信 fallback 必须避让默认模板的显式可信 ID。
    expect(idList).not.toContain('stage-pos-2-1');
    expect(new Set(idList).size).toBe(idList.length);
    expect(stageIdentityAtForGroup(target, 2, 1)).not.toBe('stage-pos-2-1');

    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(0);
    expect(out.filledSets).toBe(0);
    const round2 = out.exercise.sets.filter((s) => s.roundIndex === 2);
    expect(round2).toHaveLength(2);
    for (const s of round2) {
      expect(s.reps).toBeNull();
      expect(s.weightKg).toBeNull();
      expect(s.stageId).not.toBe('stage-pos-2-1');
    }
  });

  it('同一目标重复解析/补 ID 确定且幂等，原显式 ID 一个不丢', () => {
    const target = defaultSourceCollisionTarget();
    const before = JSON.parse(JSON.stringify(target));
    const a = resolveRoundStageIdentities(target, 2).map((r) => r.id);
    const b = resolveRoundStageIdentities(target, 2).map((r) => r.id);
    expect(a).toEqual(b);
    // 解析是纯函数，不修改目标。
    expect(target).toEqual(before);

    const stable = ensureStageIds(target) as DropSetTarget;
    const again = ensureStageIds(stable) as DropSetTarget;
    expect(again).toEqual(stable);
    // 原显式 ID 原样保留（未被位置身份或 fallback 覆盖）。
    expect(stable.stages.map((s) => s.id)).toEqual(['stage-pos-2-1', 'default-1', 'default-2']);
    expect(stable.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(a);
    expect(validateExerciseTarget(stable)).toEqual([]);
  });
});

describe('FIX4-2 其它轮 override 来源：fallback 不得撞上可信显式 ID', () => {
  it('第 1 轮 override 显式 stage-pos-2-1 + 第 2 轮未知名称 → 安全空白', () => {
    const target = overrideSourceCollisionTarget();
    const resolved = reservedStageIdsForTarget(target);
    expect(resolved.has('stage-pos-2-1')).toBe(true);
    expect(resolved.has('old-r1-b')).toBe(true);

    const ids = resolveRoundStageIdentities(target, 2);
    expect(ids.map((r) => r.confidence)).toEqual(['fallback', 'fallback']);
    expect(ids.map((r) => r.id)).not.toContain('stage-pos-2-1');
    expect(new Set(ids.map((r) => r.id)).size).toBe(2);

    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(0);
    const round2 = out.exercise.sets.filter((s) => s.roundIndex === 2);
    expect(round2.every((s) => s.reps === null && s.weightKg === null)).toBe(true);
  });

  it('真实同源显式 ID（override 与默认共享 a/b）仍按身份沿用 4 个字段', () => {
    const target = dropTarget({
      stages: [stage({ id: 'a' }), stage({ id: 'b' }), stage({ id: 'c' })],
      roundConfigs: [{ roundIndex: 2, stages: [stage({ id: 'a' }), stage({ id: 'b' })] }],
    });
    expect(resolveRoundStageIdentities(target, 2).map((r) => r.id)).toEqual(['a', 'b']);
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(4);
    expect(out.mismatchRounds).toEqual([]);
    const round2 = out.exercise.sets
      .filter((s) => s.roundIndex === 2)
      .sort((x, y) => x.stageIndex - y.stageIndex);
    expect(round2.map((s) => [s.reps, s.weightKg])).toEqual([
      [11, 29],
      [12, 28],
    ]);
    // 显式 ID 原样保留，未被兜底/推断改写。
    expect(out.exercise.target.kind).toBe('dropSet');
    if (out.exercise.target.kind !== 'dropSet') return;
    expect(out.exercise.target.stages.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(out.exercise.target.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('FIX4-3 唯一名称映射与 fallback 避让并存', () => {
  it('唯一名称仍按身份沿用（下半程/全程），不因避让而失效', () => {
    const target = dropTarget({
      stages: [stage({ label: '上半程', weightKg: 30 }), stage({ label: '下半程', weightKg: 20 }), stage({ label: '全程', weightKg: 10 })],
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage({ label: '下半程', weightKg: 20 }), stage({ label: '全程', weightKg: 10 })],
        },
      ],
    });
    expect(resolveRoundStageIdentities(target, 2).map((r) => [r.id, r.confidence])).toEqual([
      ['stage-pos-2', 'inferred'],
      ['stage-pos-3', 'inferred'],
    ]);
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(4);
    expect(out.mismatchRounds).toEqual([]);
    const round2 = out.exercise.sets
      .filter((s) => s.roundIndex === 2)
      .sort((x, y) => x.stageIndex - y.stageIndex);
    // 下半程沿用下半程（12/28），全程沿用全程（13/27），不得串成上半程（11/29）。
    expect(round2.map((s) => [s.reps, s.weightKg])).toEqual([
      [12, 28],
      [13, 27],
    ]);
  });

  it('显式 reserved 集合进入纯算法：fallback 确定性追加后缀并避让', () => {
    const target = defaultSourceCollisionTarget();
    const reserved = reservedStageIdsForTarget(target);
    const a = inferRoundStageIdentities(target.stages, target.roundConfigs![0].stages, 2, reserved);
    const b = inferRoundStageIdentities(target.stages, target.roundConfigs![0].stages, 2, reserved);
    expect(a).toEqual(b);
    expect(a.map((r) => r.confidence)).toEqual(['fallback', 'fallback']);
    // 确定性：stage-pos-2-1 已被可信身份占用 → 追加 -2。
    expect(a[0].id).toBe('stage-pos-2-1-2');
    expect(a[1].id).toBe('stage-pos-2-2');
    // 不传 reserved（旧调用口径）时依旧只避让本轮身份，不改既有兼容语义。
    const legacy = inferRoundStageIdentities(target.stages, target.roundConfigs![0].stages, 2);
    expect(legacy[0].id).toBe('stage-pos-2-1');
  });
});

describe('FIX4-4 实际新会话与目标/草稿往返不出现碰撞', () => {
  it('编辑保存（applyTargetToExercise）后 fallback 仍避让，不误沿用', () => {
    const target = defaultSourceCollisionTarget();
    const applied = applyTargetToExercise(markRoundDone(sessionExercise(target), 1), target);
    expect(applied.applied).toBe(true);
    expect(applied.exercise.target.kind).toBe('dropSet');
    if (applied.exercise.target.kind !== 'dropSet') return;
    const round2Ids = applied.exercise.sets
      .filter((s) => s.roundIndex === 2)
      .map((s) => s.stageId);
    expect(round2Ids).not.toContain('stage-pos-2-1');
    expect(new Set(round2Ids).size).toBe(round2Ids.length);
    const out = inherit(applied.exercise);
    expect(out.filledFields).toBe(0);
    const round2 = out.exercise.sets.filter((s) => s.roundIndex === 2);
    expect(round2.every((s) => s.reps === null && s.weightKg === null)).toBe(true);
  });

  function planFor(target: DropSetTarget): { plan: Plan; day: PlanDay } {
    const day: PlanDay = {
      id: 'day-fix4',
      name: 'FIX4 A',
      kind: 'train',
      focus: 'chest',
      round: 'A',
      warmups: [],
      exercises: [planExercise(target)],
    };
    return {
      plan: { id: 'plan-fix4', name: 'FIX4', days: [day], cursor: 1, createdAt: NOW, updatedAt: NOW },
      day,
    };
  }

  for (const [label, buildTarget] of [
    ['默认来源', defaultSourceCollisionTarget],
    ['override 来源', overrideSourceCollisionTarget],
  ] as const) {
    it(`${label}：createSession → 完成第 1 轮 → 第 2 轮保持空白；草稿往返后仍不碰撞`, () => {
      const target = buildTarget();
      const { plan, day } = planFor(target);
      const session = createSession(plan, day, NOW);
      const out = inherit(markRoundDone(session.exercises[0], 1));
      expect(out.filledFields).toBe(0);
      const round2 = out.exercise.sets.filter((s) => s.roundIndex === 2);
      expect(round2.every((s) => s.reps === null && s.weightKg === null)).toBe(true);

      // 目标 → 草稿 → 目标：身份确定、幂等，且 fallback 仍与可信 ID 分离。
      const draft = dropTargetToDraft(target);
      const roundTripped = draftToDropTarget(draft);
      const roundTrippedAgain = draftToDropTarget(dropTargetToDraft(roundTripped));
      expect(roundTrippedAgain).toEqual(roundTripped);
      const ids = resolveRoundStageIdentities(roundTripped, 2).map((r) => r.id);
      expect(ids).toEqual(resolveRoundStageIdentities(target, 2).map((r) => r.id));
      expect(ids).not.toContain('stage-pos-2-1');
      expect(new Set(ids).size).toBe(ids.length);

      // 往返后的目标再次开新会话：仍不会把来源实际值错误沿用。
      const { plan: plan2, day: day2 } = planFor(roundTripped);
      const session2 = createSession(plan2, day2, NOW);
      const out2 = inherit(markRoundDone(session2.exercises[0], 1));
      expect(out2.filledFields).toBe(0);
      expect(
        out2.exercise.sets
          .filter((s) => s.roundIndex === 2)
          .every((s) => s.reps === null && s.weightKg === null),
      ).toBe(true);
    });
  }
});