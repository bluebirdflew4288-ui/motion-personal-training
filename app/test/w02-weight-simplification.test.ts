/* W02 重量填写简化：行为与数据兼容测试。
   覆盖：
   - 0 vs null 严格语义区分（draftForm / DropSetEditor flush / ExerciseConfig / Stats setRowsText）；
   - 四旧 weightMode 与 dumbbellBasis 在备份/模板往返中完整保留，不删除枚举、不迁移；
   - assisted 与 external 在 comparabilityKey / 上次表现 / buildExerciseHistory / listComparabilityModes 严格隔离；
   - needsWeight 对所有旧口径统一返回 true（训练页不再因旧 bodyweight 隐藏重量输入）。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, listPlans, restoreBackup, savePlan, saveSession, listSessions, validateBackup } from '../src/db/repo';
import { parsePlanTemplate, PLAN_TEMPLATE_FORMAT } from '../src/domain/planTemplate';
import { parseExerciseTargetUnknown } from '../src/domain/exerciseConfig';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession, needsWeight, withSet } from '../src/domain/session';
import { buildExerciseHistory } from '../src/domain/stats';
import { describeLastPerformance, listComparabilityModes } from '../src/domain/comparability';
import { defaultDropDraft, draftToDropTarget, dropTargetToDraft } from '../src/domain/dropSet';
import { mergeFlushedDropDraft, parseDraftNumber } from '../src/ui/draftForm';
import { setRowsText } from '../src/pages/Stats';
import type { ExerciseTarget, Plan, Session, WeightMode } from '../src/domain/types';

const NOW = 1_760_000_000_000;

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('W02 draftForm 与 0/null 严格区分', () => {
  it('parseDraftNumber：nullable=true 区分空串 null 与显式 0；default nullable=false 仍拒绝空串', () => {
    expect(parseDraftNumber('', { min: 0, max: 999, integer: false })).toMatchObject({
      ok: false,
      value: null,
    });
    expect(parseDraftNumber('', { min: 0, max: 999, integer: false, nullable: true })).toEqual({
      ok: true,
      value: null,
      message: null,
    });
    expect(parseDraftNumber('0', { min: 0, max: 999, integer: false, nullable: true })).toEqual({
      ok: true,
      value: 0,
      message: null,
    });
    expect(parseDraftNumber('12.5', { min: 0, max: 999, integer: false, nullable: true })).toEqual({
      ok: true,
      value: 12.5,
      message: null,
    });
    expect(parseDraftNumber('7.', { min: 0, max: 999, integer: false, nullable: true }).ok).toBe(false);
  });

  it('mergeFlushedDropDraft：nullIds 把被清空的阶段重量保存为 null，显式 0 保存为 0，且保留原 weightMode', () => {
    const base = {
      ...defaultDropDraft({ weightKg: 40, repsMin: 8, repsMax: 12 }),
      rounds: 2,
      weightMode: 'assisted' as const,
      dumbbellBasis: 'per_hand' as const,
    };
    const next = mergeFlushedDropDraft(
      base,
      {
        'ex.s0.weight': 0,
        'ex.r2s1.weight': 0,
      },
      'ex',
      {
        round1AsOverride: true,
        nullIds: new Set(['ex.s1.weight', 'ex.r2s0.weight']),
      },
    );
    const r1 = next.roundOverrides?.find((r) => r.roundIndex === 1);
    const r2 = next.roundOverrides?.find((r) => r.roundIndex === 2);
    expect(r1?.stages[0].weightKg).toBe(0);
    expect(r1?.stages[1].weightKg).toBeNull();
    expect(r2?.stages[0].weightKg).toBeNull();
    expect(r2?.stages[1].weightKg).toBe(0);
    const target = draftToDropTarget(next);
    expect(target.weightMode).toBe('assisted');
    expect(target.dumbbellBasis).toBe('per_hand');
    const roundtripped = dropTargetToDraft(target);
    expect(roundtripped.weightMode).toBe('assisted');
    expect(roundtripped.dumbbellBasis).toBe('per_hand');
  });
});

describe('W02 统计与历史：显式 0kg 可见且未填 null 不冒充 0', () => {
  it('setRowsText 区分 weightKg=0 与 weightKg=null（普通组与递减组）', () => {
    const entryBase = {
      sessionId: 's1',
      at: NOW,
      dayName: '推',
      targetKind: 'straight' as const,
      stageCount: 1,
      completeGroups: 2,
      completeStages: 2,
      partialGroups: 0,
      loggedStages: 2,
      maxWeightKg: 0,
      totalReps: 20,
      sets: [
        { reps: 10, weightKg: 0, roundIndex: 1, stageIndex: 1 },
        { reps: 10, weightKg: null, roundIndex: 2, stageIndex: 1 },
      ],
      fragments: [
        {
          sessionExerciseId: 'e1',
          kind: 'straight' as const,
          stageCount: 1,
          groups: [
            { index: 1, stageCount: 1, skipped: false },
            { index: 2, stageCount: 1, skipped: false },
          ],
          sets: [
            { reps: 10, weightKg: 0, roundIndex: 1, stageIndex: 1 },
            { reps: 10, weightKg: null, roundIndex: 2, stageIndex: 1 },
          ],
          completeGroups: 2,
          partialGroups: 0,
          loggedStages: 2,
          completeStages: 2,
        },
      ],
    };
    expect(setRowsText(entryBase)).toBe('10×0 · 10');

    const dropText = setRowsText({
      ...entryBase,
      targetKind: 'dropSet',
      stageCount: 2,
      fragments: [
        {
          ...entryBase.fragments[0],
          kind: 'dropSet',
          stageCount: 2,
        },
      ],
    });
    expect(dropText).toBe('R1S1 10×0 · R2S1 10');
  });

  it('assisted 70kg 与 external 20kg 同 exerciseId 严格隔离，不合并曲线或上次表现', () => {
    const plan = createV32Plan(NOW);
    const baseEx = plan.days[0].exercises[0];
    const mkSession = (id: string, offset: number, weightMode: WeightMode, weightKg: number): Session => {
      const s = createSession(plan, plan.days[0], NOW + offset);
      s.id = id;
      s.status = 'completed';
      s.endedAt = NOW + offset + 1000;
      const ex = {
        ...s.exercises[0],
        exerciseId: 'lib-pull-up',
        name: '正手宽握引体向上',
        target: { ...baseEx.target, kind: 'straight' as const, sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode, suggestedWeightKg: weightKg },
        groups: [{ index: 1, stageCount: 1 }],
        sets: [{ id: `${id}-set`, roundIndex: 1, stageIndex: 1, reps: 10, weightKg, status: 'done' as const }],
      };
      s.exercises = [ex];
      return s;
    };

    const sAssisted = mkSession('sess-assisted', 0, 'assisted', 70);
    const sExternal = mkSession('sess-external', 100_000, 'external', 20);
    const modes = listComparabilityModes([sAssisted, sExternal], 'lib-pull-up');
    expect(modes.map((m) => m.weightMode).sort()).toEqual(['assisted', 'external']);

    const hExt = buildExerciseHistory([sAssisted, sExternal], 'lib-pull-up', { weightMode: 'external', dumbbellBasis: 'total' });
    const hAss = buildExerciseHistory([sAssisted, sExternal], 'lib-pull-up', { weightMode: 'assisted', dumbbellBasis: 'total' });
    expect(hExt?.maxWeightKg).toBe(20);
    expect(hExt?.entries).toHaveLength(1);
    expect(hAss?.maxWeightKg).toBe(70);
    expect(hAss?.entries).toHaveLength(1);
    expect(describeLastPerformance(sAssisted.exercises[0])).toContain('70kg');
    expect(describeLastPerformance(sExternal.exercises[0])).toContain('20kg');
  });
});

describe('W02 四旧值与 0/null 在 0.1.12 备份与计划模板往返', () => {
  it('四旧 weightMode + per_hand/total + suggestedWeightKg=0/null 完整往返不丢值', async () => {
    const plan = createV32Plan(NOW);
    const modes: WeightMode[] = ['external', 'bodyweight', 'bodyweight_plus', 'assisted'];
    plan.days[0].exercises = modes.map((m, idx) => ({
      id: `ex-mode-${m}`,
      exerciseId: `custom:mode-${m}`,
      name: `动作-${m}`,
      restSec: 90,
      target: {
        kind: 'straight',
        sets: 2,
        setsMax: 2,
        repsMin: 8,
        repsMax: 12,
        weightMode: m,
        dumbbellBasis: idx % 2 === 0 ? 'per_hand' : 'total',
        suggestedWeightKg: idx === 1 ? 0 : idx === 0 ? null : 15,
      } satisfies ExerciseTarget,
    }));
    await savePlan(plan);

    let sess = createSession(plan, plan.days[0], NOW + 5000);
    sess.id = 'sess-rt';
    // 旧 bodyweight 动作在训练中显式记 0kg（第 1 组）与空白 null（第 2 组）
    sess = withSet(sess, sess.exercises[1].id, sess.exercises[1].sets[0].id, { reps: 12, weightKg: 0, status: 'done' });
    sess = withSet(sess, sess.exercises[1].id, sess.exercises[1].sets[1].id, { reps: 10, status: 'done' });
    sess.status = 'completed';
    sess.endedAt = NOW + 6000;
    await saveSession(sess);

    // 验证 needsWeight 对旧 bodyweight 也返回 true
    expect(sess.exercises.every((e) => needsWeight(e))).toBe(true);

    // 导出并校验再恢复往返
    const backup = await buildBackup('0.1.12');
    const checked = validateBackup(JSON.parse(JSON.stringify(backup)));
    expect(checked.ok, checked.ok ? '' : checked.error).toBe(true);
    if (!checked.ok) return;
    await idbClear('plans');
    await idbClear('sessions');
    await restoreBackup(checked.payload);

    const restoredPlans = await listPlans();
    const restoredPlan: Plan = restoredPlans[0];
    expect(restoredPlan.days[0].exercises.map((e) => e.target.weightMode)).toEqual(modes);
    expect(restoredPlan.days[0].exercises.map((e) => e.target.dumbbellBasis)).toEqual([
      'per_hand',
      'total',
      'per_hand',
      'total',
    ]);
    expect(restoredPlan.days[0].exercises.map((e) => (e.target.kind === 'straight' ? e.target.suggestedWeightKg : null))).toEqual([
      null,
      0,
      15,
      15,
    ]);

    const restoredSessions = await listSessions();
    const bwEx = restoredSessions[0].exercises[1];
    expect(bwEx.sets[0].weightKg).toBe(0);
    expect(bwEx.sets[1].weightKg).toBeNull();
  });

  it('parseExerciseTargetUnknown 与 parsePlanTemplate 接受四旧 weightMode 且保留 0 与 null', () => {
    const rawTpl = {
      format: PLAN_TEMPLATE_FORMAT,
      version: 1,
      plan: {
        name: 'W02 往返模板',
        days: [
          {
            name: 'D1',
            kind: 'train',
            focus: 'chest',
            round: 'A',
            warmups: [],
            exercises: (['external', 'bodyweight', 'bodyweight_plus', 'assisted'] as const).map((m, i) => ({
              name: `模板-${m}`,
              restSec: 90,
              target: {
                kind: 'straight',
                sets: 2,
                repsMin: 8,
                repsMax: 12,
                weightMode: m,
                dumbbellBasis: i === 0 ? 'per_hand' : 'total',
                suggestedWeightKg: i === 1 ? 0 : i === 0 ? null : 25,
              },
            })),
          },
        ],
      },
    };
    const parsed = parsePlanTemplate(JSON.stringify(rawTpl));
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed.issues)).toBe(true);
    if (!parsed.ok) return;
    const exs = parsed.plan.days[0].exercises;
    expect(exs.map((e) => e.target.weightMode)).toEqual(['external', 'bodyweight', 'bodyweight_plus', 'assisted']);
    expect(exs[0].target.kind === 'straight' && exs[0].target.suggestedWeightKg).toBeNull();
    expect(exs[1].target.kind === 'straight' && exs[1].target.suggestedWeightKg).toBe(0);

    const parsedUnknown = parseExerciseTargetUnknown({
      kind: 'straight',
      sets: 2,
      setsMax: 2,
      repsMin: 8,
      repsMax: 12,
      weightMode: 'assisted',
      dumbbellBasis: 'per_hand',
      suggestedWeightKg: 0,
    });
    expect(parsedUnknown.ok).toBe(true);
    if (parsedUnknown.ok && parsedUnknown.target.kind === 'straight') {
      expect(parsedUnknown.target.weightMode).toBe('assisted');
      expect(parsedUnknown.target.dumbbellBasis).toBe('per_hand');
      expect(parsedUnknown.target.suggestedWeightKg).toBe(0);
    }
  });
});
