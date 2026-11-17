/* M02：动作配置记忆自动带入与基准/错误保护测试。
   覆盖：
   - buildTemplateApplyDraft 深复制纯配置（普通组 perSetConfigs / 多阶段 3/2/2 + round1 override + 逐轮 restInSec / 0 vs null / weightMode / dumbbellBasis）；
   - computeBaselineMeta 在 A→B 后切换到 B 的阶段上下限与轮数基准（普通→8 阶段、8 阶段→2 阶段、round1 override）；
   - resolveTemplateForSelection 在 templateError 或损坏模板时不降级成 first，保留原动作与草稿；
   - 原模板对象不被修改，sessionExerciseFromTemplate 与原子保存事务正常协同。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSessionWithTemplate } from '../src/db/tx';
import { listExerciseTemplates, putExerciseTemplate } from '../src/db/templates';
import { getSession } from '../src/db/repo';
import {
  exerciseTemplateFromConfig,
  roundRestInSecOf,
  sessionExerciseFromTemplate,
} from '../src/domain/exerciseConfig';
import { createSession, applyTargetToSessionExercise } from '../src/domain/session';
import type { DropSetTarget, ExerciseTemplate, Plan, StraightTarget } from '../src/domain/types';
import {
  buildEditorState,
  buildTemplateApplyDraft,
  computeBaselineMeta,
  resolveTemplateForSelection,
} from '../src/ui/exerciseEditorDraft';

const NOW = 1_760_100_000_000;

function makePlan(): Plan {
  return {
    id: 'm02-plan',
    name: 'M02 测试计划',
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
    days: [
      {
        id: 'd1',
        name: '背 A',
        kind: 'train',
        warmups: [],
        exercises: [
          {
            id: 'pe-a',
            exerciseId: 'lib-barbell-bench',
            name: '自由杠铃卧推',
            restSec: 120,
            target: {
              kind: 'straight',
              sets: 2,
              setsMax: 2,
              repsMin: 8,
              repsMax: 12,
              weightMode: 'external',
              suggestedWeightKg: 60,
            },
          },
        ],
      },
    ],
  };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('M02 纯配置带入与深复制', () => {
  it('buildTemplateApplyDraft 完整带入多阶段 3/2/2、第1轮覆盖、逐轮 restInSec、0/null、力竭与口径，且不改原模板', () => {
    const target: DropSetTarget = {
      kind: 'dropSet',
      form: 'superset',
      rounds: 3,
      stages: [
        { id: 'def-1', label: '默认一', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
        { id: 'def-2', label: '默认二', weightKg: 0, repsMin: null, repsMax: null, toFailure: true, restAfterSec: 20, targetText: '' },
        { id: 'def-3', label: '默认三', weightKg: null, repsMin: 10, repsMax: 15, toFailure: false, targetText: '' },
      ],
      roundConfigs: [
        {
          roundIndex: 1,
          restInSec: 22,
          stages: [
            { id: 'r1-1', label: '首轮一', weightKg: 0, repsMin: 6, repsMax: 8, toFailure: false, targetText: '' },
            { id: 'r1-2', label: '首轮二', weightKg: null, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
          ],
        },
        {
          roundIndex: 2,
          restInSec: 30,
          stages: [
            { id: 'r2-1', label: '次轮一', weightKg: 25, repsMin: 8, repsMax: 10, toFailure: false, restAfterSec: 18, targetText: '' },
            { id: 'r2-2', label: '次轮二', weightKg: 15, repsMin: 10, repsMax: 12, toFailure: true, targetText: '' },
          ],
        },
      ],
      restInSec: 15,
      restAfterSec: 105,
      weightMode: 'assisted',
      dumbbellBasis: 'per_hand',
    };
    const tpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:胸托超级组',
      name: '胸托超级组',
      target,
      restSec: 105,
      revision: 4,
      now: NOW,
    });
    const tplSnapshot = structuredClone(tpl);

    const applied = buildTemplateApplyDraft({
      selection: { name: '胸托超级组', exerciseId: 'custom:胸托超级组' },
      template: tpl,
      key: 'edit:ex-a:1',
    });

    expect(applied.memory).toEqual({ mode: 'exists', revision: 4 });
    expect(applied.state.remember).toBe(false);
    expect(applied.state.roundRestEdited).toBe(false);
    expect(applied.state.form).toBe('superset');
    expect(applied.state.roundsRaw).toBe('3');
    expect(applied.state.roundRestRaw).toBe('105');
    expect(applied.state.weightMode).toBe('assisted');
    expect(applied.state.dumbbellBasis).toBe('per_hand');
    // 默认阶段模板与第 1 轮覆盖分离
    expect(applied.state.stages).toHaveLength(3);
    expect(applied.state.stages[1].weight).toBe('0');
    expect(applied.state.stages[2].weight).toBe('');
    expect(applied.state.stageOverrides[1]).toHaveLength(2);
    expect(applied.state.stageOverrides[1][0].rest).toBe('22'); // 继承 round 1 restInSec
    expect(applied.state.stageOverrides[2]).toHaveLength(2);
    expect(applied.state.roundRestInSecOverrides).toEqual({ 1: 22, 2: 30 });

    const meta = computeBaselineMeta(applied.baseline);
    expect(meta.roundStageCounts).toEqual([2, 2, 3]);
    expect(meta.hasRound1Override).toBe(true);
    expect(meta.fallbackRounds).toBe(3);

    // 修改产物不会回写原模板对象
    applied.state.stages[0].label = '被修改';
    if (applied.baseline.target.kind === 'dropSet') {
      applied.baseline.target.stages[0].weightKg = 999;
    }
    expect(tpl).toEqual(tplSnapshot);
  });

  it('普通组 0/null、perSetConfigs 与 restSec 完整带入', () => {
    const straight: StraightTarget = {
      kind: 'straight',
      sets: 3,
      setsMax: 3,
      repsMin: 10,
      repsMax: 12,
      weightMode: 'bodyweight',
      suggestedWeightKg: 0,
      perSetConfigs: [
        { setIndex: 1, repsMin: 10, repsMax: 12, suggestedWeightKg: 0, toFailure: false },
        { setIndex: 2, repsMin: null, repsMax: null, suggestedWeightKg: null, toFailure: true },
        { setIndex: 3, repsMin: 8, repsMax: 10, suggestedWeightKg: 12.5, toFailure: false },
      ],
    };
    const tpl = exerciseTemplateFromConfig({
      exerciseId: 'lib-chest-dip',
      name: '双杠臂屈伸',
      en: 'Chest Dip',
      target: straight,
      restSec: 137,
      revision: 2,
      now: NOW,
    });
    const applied = buildTemplateApplyDraft({
      selection: { name: '双杠臂屈伸', en: 'Chest Dip', exerciseId: 'lib-chest-dip' },
      template: tpl,
    });
    expect(applied.state.setsRaw).toBe('3');
    expect(applied.state.restRaw).toBe('137');
    expect(applied.state.weightMode).toBe('bodyweight');
    expect(applied.state.straightRows).toEqual([
      { setIndex: 1, weight: '0', repsMin: '10', repsMax: '12', toFailure: false },
      { setIndex: 2, weight: '', repsMin: '', repsMax: '', toFailure: true },
      { setIndex: 3, weight: '12.5', repsMin: '8', repsMax: '10', toFailure: false },
    ]);
  });

  it('A→B 基准切换：普通→8 阶段放开到 8；8 阶段→2 阶段收回到 6 且不继承 8 阶段额度', () => {
    const eightTarget: DropSetTarget = {
      kind: 'dropSet',
      rounds: 1,
      stages: Array.from({ length: 8 }, (_, i) => ({
        id: `e-${i + 1}`,
        label: `阶段${i + 1}`,
        weightKg: 10,
        repsMin: 8,
        repsMax: 12,
        toFailure: false,
        targetText: '',
      })),
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
    const twoTarget: DropSetTarget = {
      kind: 'dropSet',
      rounds: 1,
      stages: [
        { id: 't-1', label: '一', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
        { id: 't-2', label: '二', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: true, targetText: '' },
      ],
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
    const straightMeta = computeBaselineMeta({
      target: {
        kind: 'straight',
        sets: 3,
        setsMax: 3,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'external',
        suggestedWeightKg: 50,
      },
      restSec: 120,
    });
    expect(straightMeta.roundStageCounts).toEqual([0]);

    const appliedEight = buildTemplateApplyDraft({
      selection: { name: '八阶段', exerciseId: 'custom:八阶段' },
      template: exerciseTemplateFromConfig({
        exerciseId: 'custom:八阶段',
        name: '八阶段',
        target: eightTarget,
        restSec: 90,
        revision: 1,
      }),
    });
    expect(computeBaselineMeta(appliedEight.baseline).roundStageCounts).toEqual([8]);

    const appliedTwo = buildTemplateApplyDraft({
      selection: { name: '二阶段', exerciseId: 'custom:二阶段' },
      template: exerciseTemplateFromConfig({
        exerciseId: 'custom:二阶段',
        name: '二阶段',
        target: twoTarget,
        restSec: 90,
        revision: 1,
      }),
    });
    expect(computeBaselineMeta(appliedTwo.baseline).roundStageCounts).toEqual([2]);

    // 1 阶段旧配置也按新基准保留 minStageCount=1
    const oneState = buildEditorState({
      name: '单阶段旧',
      exerciseId: 'custom:单阶段旧',
      target: {
        kind: 'dropSet',
        rounds: 1,
        stages: [{ id: 'o-1', label: '唯一', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' }],
        restInSec: 15,
        restAfterSec: 90,
        weightMode: 'external',
      },
      restSec: 90,
    });
    expect(oneState.stages).toHaveLength(1);
  });
});

describe('M02 错误读取 / 损坏模板阻断与同事务落库', () => {
  it('templateError 或损坏模板对象返回 error，不降级为 missing', () => {
    const validTpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:正常',
      name: '正常',
      target: {
        kind: 'straight',
        sets: 3,
        setsMax: 3,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'external',
        suggestedWeightKg: 20,
      },
      restSec: 90,
      revision: 1,
    });

    const errRead = resolveTemplateForSelection({
      templates: [validTpl],
      exerciseId: 'custom:正常',
      templateError: 'IDB read failed',
      exerciseName: '正常',
    });
    expect(errRead.kind).toBe('error');
    if (errRead.kind === 'error') {
      expect(errRead.message).toContain('本次未替换');
    }

    const corruptTpl = { ...structuredClone(validTpl), restSec: -5 } as unknown as ExerciseTemplate;
    const errCorrupt = resolveTemplateForSelection({
      templates: [corruptTpl],
      exerciseId: 'custom:正常',
      templateError: null,
      exerciseName: '正常',
    });
    expect(errCorrupt.kind).toBe('error');
    if (errCorrupt.kind === 'error') {
      expect(errCorrupt.message).toContain('本次未替换');
    }
  });

  it('同事务保存替换后的 B 与 CAS revision 保护', async () => {
    const plan = makePlan();
    const session = createSession(plan, plan.days[0], NOW);
    await atomicCreateSession({ session });
    await atomicAcquireLock(session.id, 'editor-1');

    const bTarget: DropSetTarget = {
      kind: 'dropSet',
      rounds: 2,
      stages: [
        { id: 'b1', label: '起', weightKg: 30, repsMin: 8, repsMax: 10, toFailure: false, restAfterSec: 15, targetText: '' },
        { id: 'b2', label: '落', weightKg: 20, repsMin: 10, repsMax: 12, toFailure: true, targetText: '' },
      ],
      roundConfigs: [
        {
          roundIndex: 2,
          restInSec: 25,
          stages: [
            { id: 'b1', label: '起', weightKg: 25, repsMin: 8, repsMax: 10, toFailure: false, targetText: '' },
            { id: 'b2', label: '落', weightKg: 15, repsMin: 10, repsMax: 12, toFailure: true, targetText: '' },
          ],
        },
      ],
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    };
    const bTpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:B动作',
      name: 'B动作',
      target: bTarget,
      restSec: 90,
      revision: 1,
      now: NOW,
    });
    const put = await putExerciseTemplate(bTpl, null);
    expect(put.ok).toBe(true);

    // 基于 B 模板生成的新实例与替换结果均可独立落库且保留逐轮 restInSec
    const freshInst = sessionExerciseFromTemplate(bTpl);
    expect(roundRestInSecOf(freshInst.target, 2)).toBe(25);

    const exId = session.exercises[0].id;
    const applied = applyTargetToSessionExercise(session, exId, bTpl.target, { confirmImpact: true });
    expect(applied.applied).toBe(true);
    const nextSession = {
      ...applied.session,
      exercises: applied.session.exercises.map((e) =>
        e.id === exId
          ? { ...e, exerciseId: bTpl.exerciseId, name: bTpl.name, planExerciseId: null, restSec: bTpl.restSec }
          : e,
      ),
    };

    // 错传 expectedRevision=99 时 CAS 冲突整笔回滚，session 与 template 都不变
    const conflict = await atomicSaveSessionWithTemplate({
      session: nextSession,
      guard: { sessionId: session.id, editorId: 'editor-1', expectedVersion: session.revision },
      template: { ...bTpl, restSec: 111 },
      templateExpectedRevision: 99,
    });
    expect(conflict.ok).toBe(false);
    expect((await getSession(session.id))?.exercises[0].name).toBe('自由杠铃卧推');
    expect((await listExerciseTemplates())[0].restSec).toBe(90);

    // 传入正确 expectedRevision=1 时成功落库
    const saved = await atomicSaveSessionWithTemplate({
      session: nextSession,
      guard: { sessionId: session.id, editorId: 'editor-1', expectedVersion: session.revision },
      template: { ...bTpl, restSec: 111 },
      templateExpectedRevision: 1,
    });
    expect(saved.ok).toBe(true);
    const storedSession = await getSession(session.id);
    expect(storedSession?.exercises[0].exerciseId).toBe('custom:B动作');
    expect(roundRestInSecOf(storedSession!.exercises[0].target, 2)).toBe(25);
    expect((await listExerciseTemplates())[0].revision).toBe(2);
  });
});
