/* R02 FIX3：身份/逐轮配置贯通刷新、模板记忆、完整备份恢复。
   用真实入口（defaultDropDraft / draftToDropTarget / createSession / addSetTo）
   造数据，不手写 a/b/c 冒充。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, getPlan, getSession, listPlans, restoreBackup, savePlan, validateBackup } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { listExerciseTemplates, putExerciseTemplate } from '../src/db/templates';
import { defaultDropDraft, draftToDropTarget, dropTargetToDraft, removeStageFromRound } from '../src/domain/dropSet';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import { addSetTo, createSession, inheritPreviousCompleteRoundForExercise, removeLastRound } from '../src/domain/session';
import type { DropSetTarget, Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function realTarget(): DropSetTarget {
  // 真实入口：默认草稿 3 阶段 → 第 2 轮删末阶段（3/2）
  let draft = defaultDropDraft({ weightKg: 20, repsMin: 8, repsMax: 12 });
  draft.rounds = 2;
  draft = removeStageFromRound(draft, 2, 2);
  return draftToDropTarget(draft);
}

function planWith(target: DropSetTarget): Plan {
  return {
    id: 'plan-fix3-roundtrip',
    name: 'FIX3 roundtrip',
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
    days: [
      {
        id: 'day-fix3',
        name: '胸 A',
        kind: 'train',
        warmups: [],
        exercises: [{ id: 'pe-fix3', exerciseId: 'custom:fix3-roundtrip', name: 'FIX3 变轮', restSec: 90, target }],
      },
    ],
  };
}

async function wipe(): Promise<void> {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}
beforeEach(wipe);

describe('FIX3 完整备份 / 模板 / 刷新 roundtrip', () => {
  it('计划目标 + 训练 stageId 经 buildBackup → validateBackup → restore 保真，恢复后仍可沿用', async () => {
    const target = realTarget();
    const plan = planWith(target);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    session.id = 'sess-fix3-rt';
    const exId = session.exercises[0].id;
    // 完成第 1 轮（真实 withSet 路径不引入；直接写 actual 字段与完成状态）
    session.exercises[0] = {
      ...session.exercises[0],
      sets: session.exercises[0].sets.map((s) =>
        s.roundIndex === 1 ? { ...s, reps: 10 + s.stageIndex, weightKg: 20 - s.stageIndex, status: 'done' as const } : s,
      ),
    };
    const created = await atomicCreateSession({ session });
    expect(created.ok).toBe(true);

    const backup = await buildBackup('0.1.11-fix3');
    const json = JSON.parse(JSON.stringify(backup));
    const v = validateBackup(json);
    expect(v.ok, v.ok ? '' : JSON.stringify(v)).toBe(true);
    if (!v.ok) return;

    await wipe();
    await restoreBackup(v.payload);

    const planBack = await getPlan('plan-fix3-roundtrip');
    expect(planBack).toBeDefined();
    const t2 = planBack!.days[0].exercises[0].target as DropSetTarget;
    expect(t2.stages.map((s) => s.id)).toEqual(target.stages.map((s) => s.id));
    expect(t2.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(target.roundConfigs![0].stages.map((s) => s.id));

    const sessBack = await getSession('sess-fix3-rt');
    expect(sessBack).toBeDefined();
    const ex = sessBack!.exercises.find((e) => e.id === exId)!;
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(4);
    const r2 = out.exercise.sets.filter((s) => s.roundIndex === 2).sort((a, b) => a.stageIndex - b.stageIndex);
    expect(r2.map((s) => [s.reps, s.weightKg])).toEqual([
      [11, 19],
      [12, 18],
    ]);
  });

  it('动作模板记忆 roundtrip：真实目标 → 模板 → 备份恢复 → 新实例沿用正常', async () => {
    const target = realTarget();
    const tpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:fix3-roundtrip',
      name: 'FIX3 变轮',
      restSec: 90,
      target,
      revision: 1,
      now: NOW,
    });
    const put = await putExerciseTemplate(tpl, null);
    expect(put.ok).toBe(true);

    const backup = await buildBackup('0.1.11-fix3');
    const v = validateBackup(JSON.parse(JSON.stringify(backup)));
    expect(v.ok, v.ok ? '' : JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    await wipe();
    await restoreBackup(v.payload);

    const templates = await listExerciseTemplates();
    const got = templates.find((t) => t.exerciseId === 'custom:fix3-roundtrip');
    expect(got).toBeDefined();
    const fresh = sessionExerciseFromTemplate(got!);
    expect(fresh.groups.map((g) => g.stageCount)).toEqual([3, 2]);
    const ex = {
      ...fresh,
      sets: fresh.sets.map((s) =>
        s.roundIndex === 1 ? { ...s, reps: 12, weightKg: 30, status: 'done' as const } : s,
      ),
    };
    const out = inheritPreviousCompleteRoundForExercise(ex);
    expect(out.mismatchRounds).toEqual([]);
    expect(out.filledFields).toBe(4);
  });

  it('刷新（IDB 重读）后目标身份/逐轮配置不漂移；草稿往返仍确定性一致', async () => {
    const target = realTarget();
    await savePlan(planWith(target));
    const reloaded = await getPlan('plan-fix3-roundtrip');
    const t2 = reloaded!.days[0].exercises[0].target as DropSetTarget;
    expect(t2).toEqual(target);
    const draft = dropTargetToDraft(t2);
    const again = draftToDropTarget(draft);
    expect(again).toEqual(draftToDropTarget(dropTargetToDraft(again)));
    expect(again.stages.map((s) => s.id)).toEqual(t2.stages.map((s) => s.id));
    expect(again.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(
      again.stages.slice(0, 2).map((s) => s.id),
    );
  });

  it('加轮后再删轮：备份里的 target 回到原状（无幽灵 roundConfig）', async () => {
    const target = realTarget();
    const plan = planWith(target);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    session.id = 'sess-fix3-add-remove';
    const ex = session.exercises[0];
    const added = addSetTo({ exercises: [ex] } as unknown as Session, ex.id).exercises[0];
    const removed = removeLastRound({ exercises: [added] } as unknown as Session, ex.id).exercises[0];
    expect(removed.target).toEqual(target);
    const backup = await buildBackup('0.1.11-fix3');
    const v = validateBackup(JSON.parse(JSON.stringify(backup)));
    expect(v.ok, v.ok ? '' : JSON.stringify(v)).toBe(true);
    const plans = await listPlans();
    expect(plans).toHaveLength(1);
  });
});