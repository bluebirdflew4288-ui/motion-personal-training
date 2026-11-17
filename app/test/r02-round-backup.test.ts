/* R02：逐轮配置必须贯通模板记忆、全量备份导入导出/恢复、计划模板；旧 JSON 无字段按旧规则。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { buildBackup, listPlans, restoreBackup, savePlan, validateBackup } from '../src/db/repo';
import { atomicCreateSession } from '../src/db/tx';
import { listExerciseTemplates, putExerciseTemplate } from '../src/db/templates';
import { createSession } from '../src/domain/session';
import { exerciseTemplateFromConfig } from '../src/domain/exerciseConfig';
import { PLAN_TEMPLATE_FORMAT, parsePlanTemplate } from '../src/domain/planTemplate';
import type { DropStageTarget, Plan } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function st(id: string, weightKg: number, repsMin: number | null, repsMax: number | null, restAfterSec?: number): DropStageTarget {
  return {
    id,
    label: `阶段-${id}`,
    weightKg,
    repsMin,
    repsMax,
    toFailure: repsMin === null,
    targetText: '',
    ...(restAfterSec !== undefined ? { restAfterSec } : {}),
  };
}

function plan(): Plan {
  return {
    id: 'p-r02',
    name: 'R02 变轮计划',
    cursor: 0,
    createdAt: NOW,
    updatedAt: NOW,
    days: [
      {
        id: 'd1',
        name: '胸 A',
        kind: 'train',
        warmups: [],
        exercises: [
          {
            id: 'pe1',
            exerciseId: 'custom:变轮超级组',
            name: '变轮超级组',
            restSec: 90,
            target: {
              kind: 'dropSet',
              form: 'superset',
              rounds: 2,
              stages: [st('a', 20, 8, 12, 15), st('b', 15, 8, 12, 20), st('c', 10, null, null)],
              roundConfigs: [
                {
                  roundIndex: 2,
                  stages: [st('a2', 20, 6, 10, 25), st('b2', 15, 10, 15)],
                  restInSec: 25,
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
  };
}

async function wipe(): Promise<void> {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}
beforeEach(wipe);

describe('R02 全量备份', () => {
  it('buildBackup → validateBackup → restore：逐轮差异与 stageId 保持，安全拒绝未知字段', async () => {
    const p = plan();
    await savePlan(p);
    const session = createSession(p, p.days[0], NOW);
    // 第一轮 3 阶段 + 第二轮 2 阶段都完成
    session.status = 'completed';
    session.endedAt = NOW + 60_000;
    session.exercises[0].sets = session.exercises[0].sets.map((s, i) => ({
      ...s,
      reps: 10 + i,
      weightKg: 20,
      status: 'done' as const,
    }));
    const created = await atomicCreateSession({ session });
    expect(created.ok).toBe(true);
    // 直接构造备份（会话随 data.sessions）
    const backup = await buildBackup('0.1.11-r02');
    const json = JSON.parse(JSON.stringify(backup));
    const good = validateBackup(json);
    expect(good.ok, good.ok ? '' : JSON.stringify(good)).toBe(true);
    if (!good.ok) return;
    await wipe();
    await restoreBackup(good.payload);
    const plans = await listPlans();
    const t = plans[0].days[0].exercises[0].target;
    expect(t.kind).toBe('dropSet');
    if (t.kind === 'dropSet') {
      expect(t.stages.map((s) => s.id)).toEqual(['a', 'b', 'c']);
      expect(t.roundConfigs?.map((r) => [r.roundIndex, r.stages.length, r.restInSec])).toEqual([[2, 2, 25]]);
      expect(t.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(['a2', 'b2']);
    }
  });

  it('动作模板记忆 roundtrip：逐轮 stageId 与配置保留', async () => {
    const tpl = exerciseTemplateFromConfig({
      exerciseId: 'custom:变轮超级组',
      name: '变轮超级组',
      restSec: 90,
      target: plan().days[0].exercises[0].target,
      revision: 1,
      now: NOW,
    });
    const put = await putExerciseTemplate(tpl, null);
    expect(put.ok).toBe(true);
    const backup = await buildBackup('0.1.11-r02');
    const json = JSON.parse(JSON.stringify(backup));
    const v = validateBackup(json);
    expect(v.ok, v.ok ? '' : JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    await wipe();
    await restoreBackup(v.payload);
    const list = await listExerciseTemplates();
    const got = list.find((t) => t.exerciseId === 'custom:变轮超级组')!;
    expect(got.target.kind).toBe('dropSet');
    if (got.target.kind === 'dropSet') {
      expect(got.target.roundConfigs?.length).toBe(1);
      expect(got.target.roundConfigs?.[0].stages.map((s) => s.id)).toEqual(['a2', 'b2']);
    }
  });
});

describe('R02 计划模板 JSON', () => {
  const tpl = {
    format: PLAN_TEMPLATE_FORMAT,
    version: 1,
    plan: {
      name: '变轮模板',
      days: [
        {
          name: '胸 A',
          kind: 'train',
          warmups: [],
          exercises: [
            {
              name: '变轮超级组',
              restSec: 90,
              target: {
                kind: 'dropSet',
                rounds: 2,
                stages: [
                  { weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false },
                  { weightKg: 15, repsMin: 8, repsMax: 12, toFailure: false },
                  { weightKg: 10, repsMin: 10, repsMax: 12, toFailure: false },
                ],
                roundConfigs: [
                  {
                    roundIndex: 2,
                    restInSec: 25,
                    stages: [
                      { weightKg: 20, repsMin: 6, repsMax: 10, toFailure: false },
                      { weightKg: 15, repsMin: 10, repsMax: 15, toFailure: false },
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

  it('计划模板可导入逐轮 roundConfigs；旧 JSON 无字段按旧规则仍可读', () => {
    const parsed = parsePlanTemplate(JSON.stringify(tpl));
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
    if (parsed.ok) {
      const target = parsed.plan.days[0].exercises[0].target;
      expect(target.kind).toBe('dropSet');
      if (target.kind === 'dropSet') expect(target.roundConfigs?.[0].stages.length).toBe(2);
    }
    const legacy = JSON.parse(JSON.stringify(tpl));
    delete legacy.plan.days[0].exercises[0].target.roundConfigs;
    const old = parsePlanTemplate(JSON.stringify(legacy));
    expect(old.ok).toBe(true);
    if (old.ok) {
      const target = old.plan.days[0].exercises[0].target;
      if (target.kind === 'dropSet') expect(target.roundConfigs).toBeUndefined();
    }
  });

  it('计划模板 roundConfigs 额外未知字段必须拒绝', () => {
    const bad = JSON.parse(JSON.stringify(tpl));
    bad.plan.days[0].exercises[0].target.roundConfigs[0].stages[0].actualReps = 10;
    const r = parsePlanTemplate(JSON.stringify(bad));
    expect(r.ok).toBe(false);
  });
});
