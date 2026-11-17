/* R02 FIX2：三条“默认模板与实际每轮配置分离”的回归。
   F1 新增轮必须继承紧邻上一轮（不得取更早 override / 回最初默认）。
   F2 第 1 轮也必须是独立轮（改第 1 轮不得改写其他默认轮）。
   F3 合法首轮 override 在无操作保存/草稿 roundtrip 后必须保留 [2,3] 语义。 */

import { describe, expect, it } from 'vitest';
import { addSetTo, sessionExerciseFromPlan } from '../src/domain/session';
import {
  parseExerciseTargetUnknown,
  resolveGroupConfig,
  roundRestInSecOf,
  roundStagesOf,
  validateExerciseTarget,
} from '../src/domain/exerciseConfig';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import {
  draftStagesForRound,
  draftToDropTarget,
  dropTargetToDraft,
  updateRoundStages,
} from '../src/domain/dropSet';
import type { DropSetTarget, PlanExercise, Session } from '../src/domain/types';

function st(id: string, label: string, weightKg: number | null = 10, restAfterSec?: number) {
  return {
    id,
    label,
    weightKg,
    repsMin: 8,
    repsMax: 12,
    toFailure: false,
    targetText: '',
    ...(restAfterSec !== undefined ? { restAfterSec } : {}),
  };
}

/** 默认 3 阶段；第 2 轮 override 2 阶段；第 3 轮恢复默认 3。 */
function default3Override2Default3(): DropSetTarget {
  return {
    kind: 'dropSet',
    form: 'superset',
    rounds: 3,
    stages: [st('a', '阶段A'), st('b', '阶段B'), st('c', '阶段C')],
    roundConfigs: [{ roundIndex: 2, stages: [st('a2', '阶段A2'), st('b2', '阶段B2')], restInSec: 25 }],
    restInSec: 15,
    restAfterSec: 90,
    weightMode: 'external',
  };
}

describe('R02 FIX2 F1：新增轮继承紧邻上一轮（default3/override2/default3）', () => {
  it('加第 4 轮：groups/sets 为 3，roundStagesOf / resolveGroupConfig / 休息都取第 3 轮默认 3 阶段', () => {
    const target = default3Override2Default3();
    const plan: PlanExercise = { id: 'p', exerciseId: 'custom:fix2-f1', name: '变轮', restSec: 90, target };
    const ex = sessionExerciseFromPlan(plan);
    const added = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];

    expect(added.groups.map((g) => g.stageCount)).toEqual([3, 2, 3, 3]);
    expect(added.sets.filter((s) => s.roundIndex === 4)).toHaveLength(3);
    expect(roundStagesOf(added.target, 4)).toEqual(roundStagesOf(target, 3));
    for (let si = 1; si <= 3; si += 1) {
      const { groupIndex: _gotRound, ...got } = resolveGroupConfig(added.target, 4, si);
      const { groupIndex: _wantRound, ...want } = resolveGroupConfig(target, 3, si);
      expect(got).toEqual(want);
    }
    // 第 2 轮 restInSec=25 不得被更早 override 冒充到第 4 轮。
    expect(roundRestInSecOf(added.target, 4)).toBe(15);
    // 新轮配置已物化为合法纯配置（可导出/可再进编辑器）。
    expect(added.target.kind).toBe('dropSet');
    if (added.target.kind === 'dropSet') {
      expect(added.target.rounds).toBe(4);
      expect(added.target.roundConfigs?.some((r) => r.roundIndex === 4)).toBe(true);
      expect(validateExerciseTarget(added.target)).toEqual([]);
    }
  });

  it('模板/新实例：物化后的第 4 轮配置不会回最初默认或更早 override', () => {
    const target = default3Override2Default3();
    const plan: PlanExercise = { id: 'p', exerciseId: 'custom:fix2-f1-tpl', name: '变轮', restSec: 90, target };
    const ex = sessionExerciseFromPlan(plan);
    const added = addSetTo({ exercises: [ex] } as Session, ex.id).exercises[0];
    const tpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:fix2-f1-tpl',
      name: '变轮',
      restSec: 90,
      target: added.target,
      makeStageId: (i) => `tpl-stage-${i}`,
    });
    const fresh = sessionExerciseFromTemplate(tpl);
    expect(fresh.groups.map((g) => g.stageCount)).toEqual([3, 2, 3, 3]);
    expect(roundStagesOf(fresh.target, 4)).toHaveLength(3);
    // JSON 纯配置 roundtrip：物化后的 config 不依赖运行态，未知字段仍会被拒绝。
    const parsed = parseExerciseTargetUnknown(JSON.parse(JSON.stringify(added.target)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(roundStagesOf(parsed.target, 4)).toHaveLength(3);
      expect(validateExerciseTarget(parsed.target)).toEqual([]);
    }
  });

  it('旧数据无物化配置：额外轮只按最后声明轮（rounds）回退，不搜索更早 override', () => {
    const target = default3Override2Default3();
    // 模拟旧 addSetTo：groups 有第 4 轮但 target.rounds 仍为 3、无 roundConfig[4]。
    expect(roundStagesOf(target, 4)).toHaveLength(3);
    expect(roundRestInSecOf(target, 4)).toBe(15);
  });
});

describe('R02 FIX2 F2：第 1 轮独立修改不得改写其他默认轮', () => {
  it('修改第 1 轮阶段名：draft 只生成 roundOverrides[1]，第 2/3 轮保持原配置', () => {
    const target = default3Override2Default3();
    const draft = dropTargetToDraft(target);
    const round1 = draftStagesForRound(draft, 1).map((s, i) => ({ ...s, label: i === 0 ? '仅为第1轮' : s.label }));
    const nextDraft = updateRoundStages(draft, 1, round1);
    const next = draftToDropTarget(nextDraft);

    // 默认模板（供未覆盖轮使用）不变。
    expect(next.stages.map((s) => s.label)).toEqual(['阶段A', '阶段B', '阶段C']);
    // 第 1 轮有独立 override。
    const rc1 = next.roundConfigs?.find((r) => r.roundIndex === 1);
    expect(rc1?.stages[0].label).toBe('仅为第1轮');
    // 第 2 轮覆盖仍在且未被第 1 轮改写；第 3 轮走默认 3 阶段。
    expect(next.roundConfigs?.find((r) => r.roundIndex === 2)?.stages.map((s) => s.label)).toEqual(['阶段A2', '阶段B2']);
    expect(roundStagesOf(next, 3).map((s) => s.label)).toEqual(['阶段A', '阶段B', '阶段C']);
    expect(validateExerciseTarget(next)).toEqual([]);
  });
});

describe('R02 FIX2 F3：首轮 override 的草稿 roundtrip 保留 [2,3]', () => {
  it('默认 3 + roundConfigs[{roundIndex:1,stages:2}]：转草稿再保存仍 第1轮2/第2轮3', () => {
    const target: DropSetTarget = {
      kind: 'dropSet',
      form: 'superset',
      rounds: 2,
      stages: [st('a', '默认A'), st('b', '默认B'), st('c', '默认C')],
      roundConfigs: [{ roundIndex: 1, stages: [st('x', '首轮X'), st('y', '首轮Y')], restInSec: 7 }],
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
    const draft = dropTargetToDraft(target);
    // 默认模板是 3 阶段，不能把第 1 轮生效的 2 阶段当默认。
    expect(draft.stages).toHaveLength(3);
    expect(draft.roundOverrides?.find((r) => r.roundIndex === 1)?.stages).toHaveLength(2);

    const back = draftToDropTarget(draft);
    expect(roundStagesOf(back, 1).map((s) => s.id)).toEqual(['x', 'y']);
    expect(roundStagesOf(back, 2).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(validateExerciseTarget(back)).toEqual([]);
    const stripText = (list: Array<{ targetText: string }>) => list.map(({ targetText: _t, ...rest }) => rest);
    expect(stripText(roundStagesOf(back, 1))).toEqual(stripText(roundStagesOf(target, 1)));
    expect(stripText(roundStagesOf(back, 2))).toEqual(stripText(roundStagesOf(target, 2)));
  });
});
