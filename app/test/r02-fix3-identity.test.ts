/* R02 FIX3：阶段身份 / 逐轮配置 / 轮次边界回归。
   针对 Argon 交叉审查（2026-11-16）与 Codex 独立复现的四类根因：
   1. 真实草稿入口（defaultDropDraft / straightToDropDraft / addStage*）没有稳定身份，
      draftToDropTarget 为默认轮与 override 各造随机 id；
   2. 无 id 计划模板 / 内置 V3.2 / 旧数据在编辑保存后身份分裂；
   3. removeLastRound / removeSetFrom 未同步 target.rounds / roundConfigs；
   4. addSetTo 可写 21 轮或 204 行，先存坏再由校验兜底。
   这些用例从**真实入口**造数据，不预填 a/b/c 冒充身份。 */

import { describe, expect, it } from 'vitest';
import {
  addStage,
  addStageToRound,
  defaultDropDraft,
  draftToDropTarget,
  dropTargetToDraft,
  moveStageInRound,
  removeStageFromRound,
  setDropDraftRounds,
  straightToDropDraft,
  updateStageInRound,
  validateDropDraft,
} from '../src/domain/dropSet';
import {
  applyTargetToExercise,
  ensureStageIds,
  parseExerciseTargetUnknown,
  resolveRoundStageIdentities,
  stageIdentityAtForGroup,
  validateExerciseTarget,
} from '../src/domain/exerciseConfig';
import { MAX_ROUNDS } from '../src/domain/limits';
import { PLAN_TEMPLATE_FORMAT, parsePlanTemplate } from '../src/domain/planTemplate';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  addSetBlocker,
  addSetTo,
  createSession,
  inheritPreviousCompleteRoundForExercise,
  removeLastRound,
  removeSetFrom,
  sessionExerciseFromPlan,
} from '../src/domain/session';
import type { DropSetTarget, DropStageTarget, PlanExercise, Session, SessionExercise } from '../src/domain/types';

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
    ...(over.restAfterSec !== undefined ? { restAfterSec: over.restAfterSec } : {}),
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

function planExercise(target: DropSetTarget, id = 'p-fix3'): PlanExercise {
  return { id, exerciseId: `custom:${id}`, name: 'FIX3 多阶段', restSec: 90, target };
}

function sessionExercise(target: DropSetTarget, id = 'p-fix3'): SessionExercise {
  return sessionExerciseFromPlan(planExercise(target, id));
}

function markRoundDone(ex: SessionExercise, round: number): SessionExercise {
  return {
    ...ex,
    sets: ex.sets.map((s) =>
      s.roundIndex === round ? { ...s, reps: 10 + s.stageIndex, weightKg: 20 - s.stageIndex, status: 'done' as const } : s,
    ),
  };
}

function inherit(ex: SessionExercise) {
  return inheritPreviousCompleteRoundForExercise(ex);
}

describe('FIX3-1 真实草稿入口建立稳定身份（默认/override 不随机分裂）', () => {
  it('defaultDropDraft / straightToDropDraft：初始阶段即有唯一稳定 id，转换不随机分裂', () => {
    for (const draft of [
      defaultDropDraft({ weightKg: 20 }),
      straightToDropDraft({ kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 20 }),
    ]) {
      const ids = draft.stages.map((s) => s.id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(3);
      const a = draftToDropTarget(draft);
      const b = draftToDropTarget(draft);
      expect(a.stages.map((s) => s.id)).toEqual(ids);
      expect(b.stages.map((s) => s.id)).toEqual(ids);
    }
  });

  it('3/3 仅改第 2 轮重量：默认与 override 共享身份 → 沿用 6 个字段', () => {
    let draft = defaultDropDraft({ weightKg: 20, repsMin: 8, repsMax: 12 });
    draft.rounds = 2;
    draft = updateStageInRound(draft, 2, 0, { weightKg: 17.5 });
    const target = draftToDropTarget(draft);
    expect(target.roundConfigs).toHaveLength(1);
    expect(target.roundConfigs![0].stages.map((s) => s.id)).toEqual(target.stages.map((s) => s.id));
    const ex = markRoundDone(sessionExercise(target), 1);
    const out = inherit(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(6);
  });

  it('3/2 删第 2 轮末阶段：共享前两个身份 → 沿用 4 个字段，不整轮 mismatch', () => {
    for (const converted of [false, true]) {
      let draft = converted
        ? straightToDropDraft({ kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 20 })
        : defaultDropDraft({ weightKg: 20 });
      draft.rounds = 2;
      draft = removeStageFromRound(draft, 2, 2);
      expect(validateDropDraft(draft)).toEqual([]);
      const target = draftToDropTarget(draft);
      expect(target.roundConfigs![0].roundIndex).toBe(2);
      expect(target.roundConfigs![0].stages.map((s) => s.id)).toEqual(target.stages.slice(0, 2).map((s) => s.id));
      const ex = markRoundDone(sessionExercise(target), 1);
      const out = inherit(ex);
      expect(out.mismatchRounds).toEqual([]);
      expect(out.filledFields).toBe(4);
    }
  });

  it('超级组 form 保留，且逐轮配置身份同样共享', () => {
    let draft = defaultDropDraft({ weightKg: 20 });
    draft.form = 'superset';
    draft.rounds = 2;
    draft = updateStageInRound(draft, 2, 1, { weightKg: 15 });
    const target = draftToDropTarget(draft);
    expect(target.form).toBe('superset');
    expect(target.roundConfigs![0].stages[1].id).toBe(target.stages[1].id);
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(6);
  });

  it('addStage / addStageToRound 生成新身份；复制/整轮改动保留原身份', () => {
    const base = defaultDropDraft({ weightKg: 20 });
    const withDefaultStage = addStage(base);
    expect(withDefaultStage.stages).toHaveLength(4);
    const baseIds = new Set(base.stages.map((s) => s.id));
    expect(baseIds.has(withDefaultStage.stages[3].id)).toBe(false);

    const withRoundStage = addStageToRound(base, 2);
    const round2 = withRoundStage.roundOverrides!.find((r) => r.roundIndex === 2)!;
    expect(round2.stages).toHaveLength(4);
    expect(round2.stages.slice(0, 3).map((s) => s.id)).toEqual(base.stages.map((s) => s.id));
    expect(baseIds.has(round2.stages[3].id)).toBe(false);

    // 复制轮（setDropDraftRounds 新增轮）保留上一轮身份；
    // 未修改的轮继续沿用默认模板，不会被无意义地写成 override。
    const four = setDropDraftRounds(base, 4);
    expect(four.roundOverrides?.map((r) => r.roundIndex)).toEqual([4]);
    for (const r of [2, 3, 4]) {
      const rows = r === 4 ? four.roundOverrides!.find((x) => x.roundIndex === 4)!.stages : four.stages;
      expect(rows.map((s) => s.id)).toEqual(base.stages.map((s) => s.id));
    }
  });

  it('删除/重排阶段后身份随阶段移动，不会被重新按位置命名', () => {
    const base = defaultDropDraft({ weightKg: 20 });
    const ids = base.stages.map((s) => s.id) as string[];
    const moved = moveStageInRound(base, 1, 1, -1);
    const rows = moved.roundOverrides!.find((r) => r.roundIndex === 1)!.stages;
    expect(rows.map((s) => s.id)).toEqual([ids[1], ids[0], ids[2]]);
    const removed = removeStageFromRound(base, 1, 0);
    const rows2 = removed.roundOverrides!.find((r) => r.roundIndex === 1)!.stages;
    expect(rows2.map((s) => s.id)).toEqual([ids[1], ids[2]]);
  });
});

describe('FIX3-2 旧无 id / 模板 / V3.2 / 真实编辑器保存后身份一致', () => {
  it('无 id 计划模板 3/2 → 导入稳定化 → createSession → 沿用 4 个字段', () => {
    const raw = {
      format: PLAN_TEMPLATE_FORMAT,
      version: 1,
      plan: {
        name: '无 id 变轮',
        days: [
          {
            name: '胸 A',
            kind: 'train',
            warmups: [],
            exercises: [
              {
                name: '无 id 多阶段',
                restSec: 90,
                target: {
                  kind: 'dropSet',
                  rounds: 2,
                  stages: [1, 2, 3].map((n) => ({ weightKg: 20 - n, repsMin: 8, repsMax: 12, toFailure: false })),
                  roundConfigs: [
                    { roundIndex: 2, stages: [1, 2].map((n) => ({ weightKg: 20 - n, repsMin: 6, repsMax: 10, toFailure: false })) },
                  ],
                  restInSec: 15,
                  restAfterSec: 90,
                  weightMode: 'external',
                },
              },
            ],
          },
        ],
      },
    };
    const parsed = parsePlanTemplate(JSON.stringify(raw));
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const target = parsed.plan.days[0].exercises[0].target as DropSetTarget;
    expect(target.stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2', 'stage-pos-3']);
    expect(target.roundConfigs![0].stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2']);
    // 真实 createSession（不是手写 builder）
    const session = createSession(parsed.plan, parsed.plan.days[0], NOW);
    const ex = markRoundDone(session.exercises[0], 1);
    const out = inherit(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(4);
  });

  it('带显式 id 的计划模板：原样保留；同数组重复 id 明确拒绝', () => {
    const raw = {
      format: PLAN_TEMPLATE_FORMAT,
      version: 1,
      plan: {
        name: '显式 id',
        days: [
          {
            name: '胸 A',
            kind: 'train',
            warmups: [],
            exercises: [
              {
                name: '显式 id 多阶段',
                restSec: 90,
                target: {
                  kind: 'dropSet',
                  rounds: 2,
                  stages: [
                    { id: 'a', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false },
                    { id: 'b', weightKg: 15, repsMin: 8, repsMax: 12, toFailure: false },
                    { id: 'c', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false },
                  ],
                  roundConfigs: [
                    {
                      roundIndex: 2,
                      stages: [
                        { id: 'a', weightKg: 20, repsMin: 6, repsMax: 10, toFailure: false },
                        { id: 'b', weightKg: 15, repsMin: 8, repsMax: 12, toFailure: false },
                      ],
                    },
                  ],
                  restInSec: 15,
                  restAfterSec: 90,
                  weightMode: 'external',
                },
              },
            ],
          },
        ],
      },
    };
    const parsed = parsePlanTemplate(JSON.stringify(raw));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = parsed.plan.days[0].exercises[0].target as DropSetTarget;
    expect(target.stages.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(target.roundConfigs![0].stages.map((s) => s.id)).toEqual(['a', 'b']);
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.filledFields).toBe(4);
    expect(out.mismatchRounds).toEqual([]);

    const dup = JSON.parse(JSON.stringify(raw));
    dup.plan.days[0].exercises[0].target.stages[1].id = 'a';
    const bad = parsePlanTemplate(JSON.stringify(dup));
    expect(bad.ok).toBe(false);
  });

  it('默认「上半程/下半程/全程」+ override「下半程/全程」无 id：按唯一名称识别重排，禁止下半程套上半程数值', () => {
    const target = dropTarget({
      stages: [
        stage({ label: '上半程', weightKg: 30 }),
        stage({ label: '下半程', weightKg: 20 }),
        stage({ label: '全程', weightKg: 10 }),
      ],
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage({ label: '下半程', weightKg: 20 }), stage({ label: '全程', weightKg: 10 })],
        },
      ],
    });
    expect(
      resolveRoundStageIdentities(target, 2).map((r) => r.id),
    ).toEqual(['stage-pos-2', 'stage-pos-3']);
    const ex = markRoundDone(sessionExercise(target), 1);
    const out = inherit(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(4);
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2).sort((a, b) => a.stageIndex - b.stageIndex);
    // 第 1 轮按阶段序号写入 actual：上半程 11/19、下半程 12/18、全程 13/17。
    // 下半程只能沿用下半程（12/18），不能串成上半程（11/19）。
    expect(r2.map((s) => [s.reps, s.weightKg])).toEqual([
      [12, 18],
      [13, 17],
    ]);
  });

  it('无法证明的不同阶段：保持独立兜底身份，沿用整轮 mismatch 且不硬配', () => {
    const target = dropTarget({
      stages: [stage({ label: '上' }), stage({ label: '下' }), stage({ label: '全' })],
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage({ label: '快' }), stage({ label: '慢' })],
        },
      ],
    });
    const identities = resolveRoundStageIdentities(target, 2);
    expect(identities.map((r) => r.confidence)).toEqual(['fallback', 'fallback']);
    expect(identities.map((r) => r.id)).toEqual(['stage-pos-2-1', 'stage-pos-2-2']);
    const ex = markRoundDone(sessionExercise(target), 1);
    const out = inherit(ex);
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2);
    expect(r2.every((s) => s.reps === null && s.weightKg === null)).toBe(true);
  });

  it('重复名称且阶段数变化：不能猜第一个匹配，未证明阶段保持空白（Codex edge）', () => {
    const target = dropTarget({
      stages: [stage({ label: '递减' }), stage({ label: '递减' }), stage({ label: '全程' })],
      roundConfigs: [{ roundIndex: 2, stages: [stage({ label: '递减' }), stage({ label: '全程' })] }],
    });
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2).sort((a, b) => a.stageIndex - b.stageIndex);
    // “递减/递减”无法唯一对应，绝不能用同位置猜成第 1 个递减；
    // 但“全程”唯一匹配默认第 3 阶段，可以按身份沿用（部分对应，其余保持空白）。
    expect(r2[0].reps).toBeNull();
    expect(r2[0].weightKg).toBeNull();
    expect(r2[1].reps).toBe(13);
    expect(r2[1].weightKg).toBe(17);
    expect(out.filledFields).toBe(2);
  });

  it('显式 id 与生成位置身份不得撞车（Codex edge：显式 stage-pos-2 + 缺 id 阶段）', () => {
    const raw = {
      format: PLAN_TEMPLATE_FORMAT,
      version: 1,
      plan: {
        name: 'id 冲突',
        days: [
          {
            name: 'A',
            kind: 'train',
            warmups: [],
            exercises: [
              {
                name: '冲突动作',
                restSec: 90,
                target: {
                  kind: 'dropSet',
                  rounds: 2,
                  stages: [
                    { id: 'stage-pos-2', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false },
                    { weightKg: 5, repsMin: 8, repsMax: 12, toFailure: false },
                  ],
                  restInSec: 15,
                  restAfterSec: 90,
                  weightMode: 'external',
                },
              },
            ],
          },
        ],
      },
    };
    const parsed = parsePlanTemplate(JSON.stringify(raw));
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const target = parsed.plan.days[0].exercises[0].target as DropSetTarget;
    const ids = target.stages.map((s) => s.id);
    expect(ids[0]).toBe('stage-pos-2');
    expect(new Set(ids).size).toBe(2);
    expect(ids[1]).not.toBe('stage-pos-2');
    expect(validateExerciseTarget(target)).toEqual([]);
  });

  it('混合轮：认不出的显式 id + 缺失 id 阶段不按位置硬配；可识别的显式 id 才允许唯一名称推断', () => {
    // 认不出的显式 id（x）说明该轮可能重排/来自另一阶段；缺失阶段只能兜底。
    const mixedUnknown = dropTarget({
      stages: [stage({ id: 'a', label: 'A' }), stage({ id: 'b', label: 'B' }), stage({ id: 'c', label: 'C' })],
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage({ id: 'x', label: '第 1 阶段' }), stage({ label: '第 2 阶段' })],
        },
      ],
    });
    const unknown = resolveRoundStageIdentities(mixedUnknown, 2);
    expect(unknown.map((r) => [r.id, r.confidence])).toEqual([
      ['x', 'explicit'],
      ['stage-pos-2-2', 'fallback'],
    ]);

    // 显式 id 可识别（a 明确是默认第 1 阶段）且缺失阶段名称唯一匹配 b：
    // 这是可证明的同源关系，允许共享 b 的默认身份。
    const mixedKnown = dropTarget({
      stages: [stage({ id: 'a', label: 'A' }), stage({ id: 'b', label: 'B' }), stage({ id: 'c', label: 'C' })],
      roundConfigs: [
        {
          roundIndex: 2,
          stages: [stage({ id: 'a', label: '第 1 阶段' }), stage({ label: 'B' })],
        },
      ],
    });
    const known = resolveRoundStageIdentities(mixedKnown, 2);
    expect(known.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('已有不同显式 id 的阶段不被位置强行合并（a/b/c 与 x/y）', () => {
    const target = dropTarget({
      stages: [stage({ id: 'a' }), stage({ id: 'b' }), stage({ id: 'c' })],
      roundConfigs: [{ roundIndex: 2, stages: [stage({ id: 'x' }), stage({ id: 'y' })] }],
    });
    expect(stageIdentityAtForGroup(target, 2, 1)).toBe('x');
    const out = inherit(markRoundDone(sessionExercise(target), 1));
    expect(out.mismatchRounds).toEqual([2]);
    expect(out.filledFields).toBe(0);
  });

  it('V3.2 哑铃侧平举：完成 3 轮 → 加第 4 轮 → 无改保存 → 沿用第 3 轮', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.id === 'day-legs-a')!;
    const session = createSession(plan, legsA, NOW);
    const index = session.exercises.findIndex((e) => e.name.includes('侧平举'));
    expect(index).toBeGreaterThanOrEqual(0);
    const ex0 = session.exercises[index];
    // 真实完成前 3 轮（含 actual），原始 V3.2 target 无 stage.id
    let completed = ex0;
    for (let r = 1; r <= 3; r += 1) completed = markRoundDone(completed, r);
    const addedSession = addSetTo({ exercises: [completed] } as Session, completed.id);
    const added = addedSession.exercises[0];
    expect(added.groups.map((g) => g.stageCount)).toEqual([3, 3, 3, 3]);
    expect(added.target.kind).toBe('dropSet');
    if (added.target.kind !== 'dropSet') return;
    expect(added.target.rounds).toBe(4);
    expect(added.target.roundConfigs?.some((r) => r.roundIndex === 4)).toBe(true);
    // 无修改保存 = applyTargetToExercise 同一 target；真实 ExerciseEditor 的 DOM 检查另测。
    const saved = applyTargetToExercise(added, added.target);
    expect(saved.applied).toBe(true);
    // 把第 4 轮当作未完成，沿用它前面最近的完整轮（第 3 轮）
    const out = inherit(saved.exercise);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(6);
    const r4 = out.exercise.sets.filter((s) => s.roundIndex === 4);
    expect(r4.map((s) => [s.reps, s.weightKg])).toEqual([
      [11, 19],
      [12, 18],
      [13, 17],
    ]);
  });

  it('旧目标无 id：dropTargetToDraft → draftToDropTarget 确定性稳定，往返不随机分裂', () => {
    const legacy = dropTarget({
      stages: [stage({ label: '阶段1' }), stage({ label: '阶段2' }), stage({ label: '阶段3' })],
      roundConfigs: [{ roundIndex: 2, stages: [stage({ label: '阶段1' }), stage({ label: '阶段2' })] }],
    });
    const draft = dropTargetToDraft(legacy);
    expect(draft.stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2', 'stage-pos-3']);
    expect(draft.roundOverrides![0].stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2']);
    const a = draftToDropTarget(draft);
    const b = draftToDropTarget(draft);
    expect(a).toEqual(b);
    expect(a.roundConfigs![0].stages.map((s) => s.id)).toEqual(a.stages.slice(0, 2).map((s) => s.id));
  });

  it('ensureStageIds / 备份解析：无 id 旧目标补齐后沿用正常，显式 id 不丢', () => {
    const legacy = dropTarget();
    const withIds = ensureStageIds(legacy) as DropSetTarget;
    expect(withIds.stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2', 'stage-pos-3']);
    const parsed = parseExerciseTargetUnknown(JSON.parse(JSON.stringify(withIds)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect((parsed.target as DropSetTarget).stages.map((s) => s.id)).toEqual(['stage-pos-1', 'stage-pos-2', 'stage-pos-3']);
  });
});

describe('FIX3-3 删轮/删中间轮与 target 同步', () => {
  it('加再删轮恢复原 target（rounds / roundConfigs 清理）', () => {
    const target = dropTarget({
      rounds: 3,
      stages: [stage({ id: 'a' }), stage({ id: 'b' }), stage({ id: 'c' })],
      roundConfigs: [{ roundIndex: 2, stages: [stage({ id: 'a' }), stage({ id: 'b' })] }],
    });
    const ex = sessionExercise(target);
    const added = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0] as SessionExercise;
    expect(added.target.kind).toBe('dropSet');
    if (added.target.kind !== 'dropSet') return;
    expect(added.target.rounds).toBe(4);
    expect(added.target.roundConfigs?.some((r) => r.roundIndex === 4)).toBe(true);
    const removed = removeLastRound({ exercises: [added] } as Session, ex.id).exercises[0] as SessionExercise;
    expect(removed.target.kind).toBe('dropSet');
    if (removed.target.kind !== 'dropSet') return;
    expect(removed.groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(removed.target.rounds).toBe(3);
    expect(removed.target.roundConfigs).toEqual(target.roundConfigs);
  });

  it('删中间整轮：剩余轮配置按同一 remap 跟随，actual/status/note/skipped 保留', () => {
    const stagesById = [stage({ id: 'a' }), stage({ id: 'b' }), stage({ id: 'c' })];
    const target = dropTarget({
      rounds: 4,
      stages: stagesById,
      roundConfigs: [
        { roundIndex: 2, stages: [stage({ id: 'a2' }), stage({ id: 'b2' })] },
        { roundIndex: 4, stages: [stage({ id: 'a4' }), stage({ id: 'b4' })] },
      ],
    });
    const ex0 = sessionExercise(target);
    const ex: SessionExercise = {
      ...ex0,
      groups: ex0.groups.map((g) => (g.index === 3 ? { ...g, skipped: true } : g)),
      sets: ex0.sets.map((s) => ({
        ...s,
        reps: s.roundIndex === 2 ? 22 : 10 + s.stageIndex,
        weightKg: s.roundIndex === 2 ? 12 : 20,
        status: 'done' as const,
        ...(s.roundIndex === 4 && s.stageIndex === 1 ? { note: '保留备注' } : {}),
      })),
    };
    const victim = ex.sets.find((s) => s.roundIndex === 2)!.id;
    const after = removeSetFrom({ exercises: [ex] } as Session, ex.id, victim).exercises[0] as SessionExercise;
    expect(after.groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(after.sets.filter((s) => s.roundIndex === 2)).toHaveLength(3); // 原第 3 轮
    expect(after.sets.filter((s) => s.roundIndex === 3)).toHaveLength(2); // 原第 4 轮
    const targetAfter = after.target as DropSetTarget;
    expect(targetAfter.rounds).toBe(3);
    expect(targetAfter.roundConfigs?.map((r) => r.roundIndex)).toEqual([3]);
    expect(targetAfter.roundConfigs?.find((r) => r.roundIndex === 3)?.stages.map((s) => s.id)).toEqual(['a4', 'b4']);
    // 原第 3 轮的 skipped 跟随到新第 2 轮；原第 4 轮备注跟随到新第 3 轮
    expect(after.groups.find((g) => g.index === 2)?.skipped).toBe(true);
    const movedNote = after.sets.find((s) => s.roundIndex === 3 && s.stageIndex === 1);
    expect(movedNote?.note).toBe('保留备注');
    expect(movedNote?.stageId).toBe('a4');
    // 原第 1/3/4 轮的 actual 不串到别的阶段
    expect(after.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)?.reps).toBe(11);
    expect(after.sets.find((s) => s.roundIndex === 2 && s.stageIndex === 2)?.reps).toBe(12);
  });

  it('普通组删单组：不篡改原 target 计划快照（旧语义不变）', () => {
    const straight = {
      kind: 'straight' as const,
      sets: 3,
      setsMax: 3,
      repsMin: 8,
      repsMax: 12,
      weightMode: 'external' as const,
      suggestedWeightKg: null,
    };
    const ex = sessionExerciseFromPlan({ id: 'p-straight', name: '普通组', restSec: 90, target: straight });
    const beforeTarget = JSON.parse(JSON.stringify(ex.target));
    const after = removeSetFrom({ exercises: [ex] } as Session, ex.id, ex.sets[0].id).exercises[0];
    expect(after.sets).toHaveLength(2);
    expect(after.target).toEqual(beforeTarget);
  });
});

describe('FIX3-4 轮数/行数边界：领域与 UI 门禁共用 20 轮 / 200 行', () => {
  function legacyRows(rounds: number, stages: number): DropSetTarget {
    return {
      kind: 'dropSet',
      rounds,
      stages: Array.from({ length: stages }, (_, i) => stage({ id: `legacy-${i}`, label: `阶段${i + 1}` })),
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
  }

  it('20 轮 × 3 阶段：加轮被领域阻止，UI 同一 blocker 明确说明', () => {
    const ex = sessionExercise(legacyRows(MAX_ROUNDS, 3));
    expect(addSetBlocker(ex)?.kind).toBe('rounds');
    expect(addSetBlocker(ex)?.message).toContain('20 轮上限');
    const after = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(after.groups).toHaveLength(MAX_ROUNDS);
    expect(after.sets).toHaveLength(MAX_ROUNDS * 3);
  });

  it('合法 legacy 16 轮 × 12 阶段 = 192 行：再加一轮会到 204 行 → 阻止，不写坏', () => {
    const target = legacyRows(16, 12);
    const ex = sessionExercise(target);
    expect(ex.sets).toHaveLength(192);
    const block = addSetBlocker(ex);
    expect(block?.kind).toBe('rows');
    expect(block?.message).toContain('204');
    expect(block?.message).toContain('200');
    const after = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(after.sets).toHaveLength(192);
    expect(after.groups).toHaveLength(16);
    // 既有合法目标本身仍通过校验（不把历史数据截断）
    expect(validateExerciseTarget(after.target, { maxStages: 12 })).toEqual([]);
  });

  it('边界另一侧：19 轮 × 10 阶段 = 190 行 → 加一轮到 200 行允许，仍合法', () => {
    const ex = sessionExercise(legacyRows(19, 10));
    expect(addSetBlocker(ex)).toBeNull();
    const after = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(after.groups).toHaveLength(20);
    expect(after.sets).toHaveLength(200);
    expect(validateExerciseTarget(after.target, { maxStages: 12 })).toEqual([]);
  });

  it('恰好 20 轮 × 10 阶段 = 200 行：加轮被 20 轮上限阻止（不是先写 210 行）', () => {
    const ex = sessionExercise(legacyRows(20, 10));
    expect(ex.sets).toHaveLength(200);
    expect(addSetBlocker(ex)?.kind).toBe('rounds');
    const after = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(after.sets).toHaveLength(200);
  });

  it('多阶段 20 轮 / 192 行时 removeLastRound 仍可用并同步撤回，不触发容量门禁', () => {
    const ex = sessionExercise(legacyRows(20, 10));
    const removed = removeLastRound({ exercises: [ex] } as Session, ex.id).exercises[0];
    expect(removed.groups).toHaveLength(19);
    expect((removed.target as DropSetTarget).rounds).toBe(19);
  });
});