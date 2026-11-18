/* G1 备份 v3：模板与新字段一致快照、v1/v2 兼容、坏模板/高版本拒绝、
   恢复前快照、meta 定向替换与恢复原子性（ACCEPTANCE P04–P08 / D02）。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  getMeta,
  getPreRestoreSnapshot,
  listPlans,
  loadSettings,
  restoreBackup,
  savePlan,
  saveSettings,
  setMeta,
  snapshotBeforeRestore,
  validateBackup,
} from '../src/db/repo';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSessionWithTemplate } from '../src/db/tx';
import { listExerciseTemplates, putExerciseTemplate } from '../src/db/templates';
import { applyTargetToSessionExercise, createSession } from '../src/domain/session';
import { extractExerciseTemplate } from '../src/domain/exerciseConfig';
import { PLAN_TEMPLATE_FORMAT, parsePlanTemplate } from '../src/domain/planTemplate';
import { EXAMPLE_PLAN_TEMPLATE } from '../src/domain/planTemplateExample';
import type { ExerciseTarget, Plan, PlanDay, Session, StraightTarget } from '../src/domain/types';
import {
  LEGACY_0_1_8_BACKUP_VERSION,
  legacyValidateBackupVersionGate,
} from './fixtures/legacy-backup-gate-v0.1.8';

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

function supersetTarget(): Extract<ExerciseTarget, { kind: 'dropSet' }> {
  return {
    kind: 'dropSet',
    form: 'superset',
    rounds: 3,
    stages: [
      { id: 'stage-a', label: '卧推', weightKg: 60, repsMin: 8, repsMax: 10, toFailure: false, restAfterSec: 0, targetText: '' },
      { id: 'stage-b', label: '划船', weightKg: 40, repsMin: 10, repsMax: 12, toFailure: true, targetText: '' },
    ],
    restInSec: 0,
    restAfterSec: 120,
    weightMode: 'external',
  };
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
        target: straightTarget({
          perSetConfigs: [
            { setIndex: 1, repsMin: 8, repsMax: 12, suggestedWeightKg: 60, toFailure: false },
            { setIndex: 2, repsMin: 5, repsMax: 8, suggestedWeightKg: 65, toFailure: true },
            { setIndex: 3, repsMin: null, repsMax: null, suggestedWeightKg: 50, toFailure: true },
          ],
          toFailure: true,
        }),
      },
      { id: 'pe2', exerciseId: 'lib-seated-row', name: '坐姿绳索划船', restSec: 90, target: supersetTarget() },
    ],
  };
  return { id: 'p1', name: 'G1 备份计划', days: [day], cursor: 0, createdAt: NOW, updatedAt: NOW };
}

async function seedAll(): Promise<{ session: Session }> {
  const plan = makePlan();
  await savePlan(plan);
  await saveSettings({ currentPlanId: plan.id });
  const session = createSession(plan, plan.days[0], NOW);
  // 给第一个动作写入 actual（用于验证 actual 不进入模板，但随 session 备份往返）
  session.exercises[0].sets[0] = { ...session.exercises[0].sets[0], reps: 10, weightKg: 60, status: 'done' };
  const created = await atomicCreateSession({ session });
  expect(created.ok).toBe(true);
  const ex = session.exercises[0];
  const tpl = extractExerciseTemplate(ex, 1, NOW, (i) => `stage-fixed-${i}`);
  const t = await putExerciseTemplate(tpl, null);
  expect(t.ok).toBe(true);
  return { session };
}

async function wipe(): Promise<void> {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}

beforeEach(async () => {
  await wipe();
});

describe('P04 当前格式完整导出 → 恢复 → 再导出（模板与新字段一致快照）', () => {
  it('模板与 perSetConfigs / form / stage id / stage rest 全部往返保真', async () => {
    await seedAll();
    const b1 = await buildBackup('0.1.9');
    expect(b1.version).toBe(4);
    expect(BACKUP_VERSION).toBe(4);
    expect(b1.counts.exerciseTemplates).toBe(1);
    expect(b1.data.exerciseTemplates).toHaveLength(1);
    const tpl0 = b1.data.exerciseTemplates[0];
    expect(tpl0.target.kind).toBe('straight');
    expect('sets' in tpl0).toBe(false);
    expect('status' in tpl0).toBe(false);
    if (tpl0.target.kind === 'straight') {
      // 模板仓库/备份保真：null = 未设置，0 = 明确数值
      expect(tpl0.target.perSetConfigs?.[2].repsMin).toBeNull();
      expect(tpl0.target.perSetConfigs?.[2].toFailure).toBe(true);
    }

    const json1 = JSON.parse(JSON.stringify(b1));
    const v = validateBackup(json1);
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;
    expect(v.preview.exerciseTemplates).toBe(1);

    await wipe();
    await restoreBackup(v.payload);
    const b2 = await buildBackup('0.1.9');
    // 数据语义相等（exportedAt 本身是新的，不比较）
    expect(JSON.parse(JSON.stringify(b2.data))).toEqual(JSON.parse(JSON.stringify(b1.data)));

    // 新字段逐个核对
    const bench = b2.data.sessions[0].exercises[0];
    expect(bench.target.kind).toBe('straight');
    if (bench.target.kind === 'straight') {
      expect(bench.target.perSetConfigs).toHaveLength(3);
      expect(bench.target.perSetConfigs?.[2].repsMin).toBeNull();
      expect(bench.target.perSetConfigs?.[2].toFailure).toBe(true);
    }
    const row = b2.data.sessions[0].exercises[1];
    expect(row.target.kind === 'dropSet' && row.target.form).toBe('superset');
    if (row.target.kind === 'dropSet') {
      expect(row.target.stages.map((s) => s.id)).toEqual(['stage-a', 'stage-b']);
      expect(row.target.stages[0].restAfterSec).toBe(0);
    }
    // 备份里的 session actual 也保留（与模板无关）
    expect(b2.data.sessions[0].exercises[0].sets[0].reps).toBe(10);
  });

  it('G1-PRE-REVIEW #4 导出与并发原子更新：不会拼出旧 Session + 新模板', async () => {
    const { session } = await seedAll();
    const lock = await atomicAcquireLock(session.id, 'editor-A');
    expect(lock.ok).toBe(true);
    const ex0 = session.exercises[0];
    const next = applyTargetToSessionExercise(session, ex0.id, straightTarget({ sets: 4, setsMax: 4, repsMin: 5, repsMax: 8 }));
    const exNew = next.session.exercises[0];
    const tplNew = extractExerciseTemplate(exNew, 2, NOW + 1, (i) => `stage-fixed-${i}`);

    const [snapshot, save] = await Promise.all([
      buildBackup('0.1.9'),
      atomicSaveSessionWithTemplate({
        session: next.session,
        guard: { sessionId: session.id, editorId: 'editor-A', expectedVersion: 1 },
        template: tplNew,
        templateExpectedRevision: 1,
      }),
    ]);
    expect(save.ok).toBe(true);

    const bench = snapshot.data.sessions.find((s) => s.id === session.id)!.exercises[0];
    const sets = bench.target.kind === 'straight' ? bench.target.sets : -1;
    const tplRev = snapshot.data.exerciseTemplates.find((t) => t.exerciseId === 'lib-barbell-bench')!.revision;
    // 合法结果只有两种：完整旧版本（3 / 1）或完整新版本（4 / 2），不能混合
    expect((sets === 3 && tplRev === 1) || (sets === 4 && tplRev === 2)).toBe(true);
  });

  it('恢复前快照包含模板（P06 前置）', async () => {
    await seedAll();
    const snap = await snapshotBeforeRestore('0.1.9');
    expect(snap.version).toBe(4);
    expect(snap.data.exerciseTemplates).toHaveLength(1);
    expect((await getPreRestoreSnapshot())?.data.exerciseTemplates).toHaveLength(1);
  });
});

describe('P05 v1/v2 兼容、坏 v3、高版本', () => {
  it('v2 合法旧备份接受，模板缺省为空且旧 target 不被改写', async () => {
    const plan = makePlan();
    // 去掉 G1 新字段，模拟真实 v2 数据
    plan.days[0].exercises = plan.days[0].exercises.map((ex) => {
      if (ex.target.kind === 'straight') {
        const { toFailure: _tf, perSetConfigs: _ps, ...rest } = ex.target;
        return { ...ex, target: rest };
      }
      const { form: _form, ...rest } = ex.target;
      return {
        ...ex,
        target: {
          ...rest,
          stages: rest.stages.map((st) => {
            const { id: _id, restAfterSec: _r, ...s } = st;
            return s;
          }),
        },
      };
    });
    const session = createSession(plan, plan.days[0], NOW);
    const v2 = {
      format: BACKUP_FORMAT,
      version: 2,
      exportedAt: NOW,
      appVersion: '0.1.8',
      counts: { plans: 1, sessions: 1, activeSessions: 0 },
      data: { plans: [plan], sessions: [session], settings: [await loadSettings()] },
    };
    const v = validateBackup(JSON.parse(JSON.stringify(v2)));
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;
    expect(v.payload.data.exerciseTemplates).toEqual([]);

    await wipe();
    await restoreBackup(v.payload);
    const restored = await listPlans();
    const target = restored[0].days[0].exercises[0].target;
    expect(target.kind).toBe('straight');
    if (target.kind === 'straight') {
      expect(target.perSetConfigs).toBeUndefined();
      expect(target.toFailure).toBeUndefined();
    }
  });

  it('v2 夹带新字段 → 明确拒绝（不静默吞掉）', () => {
    const plan = makePlan();
    const session = createSession(plan, plan.days[0], NOW);
    const bad = {
      format: BACKUP_FORMAT,
      version: 2,
      exportedAt: NOW,
      appVersion: '0.1.8',
      counts: { plans: 1, sessions: 1, activeSessions: 0 },
      data: { plans: [plan], sessions: [session], settings: [] },
    };
    const v = validateBackup(JSON.parse(JSON.stringify(bad)));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('G1 新结构');
  });

  it('v1 空备份接受；v1 夹带新字段拒绝', async () => {
    const emptyV1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.1.2',
      counts: { plans: 0, sessions: 0, activeSessions: 0 },
      data: { plans: [], sessions: [], settings: [] },
    };
    const ok = validateBackup(emptyV1);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.payload.data.exerciseTemplates).toEqual([]);

    const badV1 = {
      ...emptyV1,
      data: {
        plans: [],
        sessions: [
          {
            id: 's1',
            planId: 'p1',
            planName: 'x',
            day: { dayId: 'd1', dayName: 'D', partText: '胸' },
            cycleIndexAtStart: 0,
            startedAt: NOW,
            endedAt: NOW + 1,
            status: 'completed',
            pausedMs: 0,
            pausedAt: null,
            warmups: [],
            note: '',
            exercises: [
              {
                id: 'e1',
                exerciseId: 'x',
                planExerciseId: null,
                name: 'x',
                restSec: 60,
                target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: null, perSetConfigs: [] },
                status: 'pending',
                groups: [],
                sets: [],
              },
            ],
          },
        ],
        settings: [],
      },
    };
    const v = validateBackup(badV1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('G1 新结构');
  });

  it('损坏 v3（坏模板）拒绝且原库不变', async () => {
    await seedAll();
    const b = await buildBackup('0.1.9');
    const bad = JSON.parse(JSON.stringify(b));
    bad.data.exerciseTemplates.push({ nonsense: true });
    const beforePlans = JSON.stringify(await listPlans());
    const v = validateBackup(bad);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('动作配置记忆');
    expect(JSON.stringify(await listPlans())).toBe(beforePlans);
    expect(await listExerciseTemplates()).toHaveLength(1);
  });

  it('高版本 v5 明确拒绝', async () => {
    const b = await buildBackup('0.1.9');
    const future = { ...JSON.parse(JSON.stringify(b)), version: 5 };
    const v = validateBackup(future);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('高于当前应用支持');
  });
});

describe('P06 恢复前快照 + 恢复原子性 + meta 保留', () => {
  it('恢复中断：原数据、模板与 meta 全部不变；成功后只替换模板前缀', async () => {
    await seedAll();
    await setMeta('lock:sess-1', { sessionId: 'sess-1', editorId: 'editor-A', at: NOW });
    await setMeta('custom-sentinel', { keep: true });
    await setMeta('seeded', false);

    // 生产恢复流程会先做恢复前快照；这里显式执行，验证快照含模板且被保留
    const snapshot = await snapshotBeforeRestore('0.1.9');
    expect(snapshot.data.exerciseTemplates).toHaveLength(1);

    const incoming = await buildBackup('0.1.9');
    incoming.data.plans[0].name = '恢复后的计划名';

    const originalPlans = JSON.stringify(await listPlans());
    const originalTemplates = JSON.stringify(await listExerciseTemplates());

    // 注入恢复事务中的 settings 写入失败
    const originalPut = IDBObjectStore.prototype.put;
    let injected = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'settings') {
        injected += 1;
        throw new DOMException('injected restore failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    let failed: unknown = null;
    try {
      await restoreBackup(incoming);
    } catch (err) {
      failed = err;
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(injected).toBeGreaterThan(0);
    expect(failed).toBeInstanceOf(Error);
    expect(JSON.stringify(await listPlans())).toBe(originalPlans);
    expect(JSON.stringify(await listExerciseTemplates())).toBe(originalTemplates);
    expect(await getMeta('lock:sess-1')).toEqual({ sessionId: 'sess-1', editorId: 'editor-A', at: NOW });
    expect(await getMeta('custom-sentinel')).toEqual({ keep: true });

    // 正常恢复：模板定向替换，其它 meta 保留，seeded=true
    await restoreBackup(incoming);
    expect((await listPlans())[0].name).toBe('恢复后的计划名');
    expect(await getMeta('lock:sess-1')).toEqual({ sessionId: 'sess-1', editorId: 'editor-A', at: NOW });
    expect(await getMeta('custom-sentinel')).toEqual({ keep: true });
    expect(await getMeta('seeded')).toBe(true);
    expect(await getPreRestoreSnapshot()).toBeDefined();
    expect(await listExerciseTemplates()).toHaveLength(1);
  });
});

describe('P07 当前 0.1.8 解析 v3 明确拒绝（冻结旧验证器）', () => {
  it('旧版本门只支持 1|2：v3 报“高于当前应用支持”', () => {
    expect(LEGACY_0_1_8_BACKUP_VERSION).toBe(2);
    expect(legacyValidateBackupVersionGate(1).ok).toBe(true);
    expect(legacyValidateBackupVersionGate(2).ok).toBe(true);
    const r = legacyValidateBackupVersionGate(3);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('高于当前应用支持');
  });
});

describe('P08 共享计划模板 v1 原有边界', () => {
  it('旧计划模板 v1 仍可解析；未来版本与 v1 夹带字段明确拒绝', () => {
    const ok = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE);
    expect(ok.ok).toBe(true);

    const future = JSON.stringify({ format: PLAN_TEMPLATE_FORMAT, version: 3, plan: { name: 'X', days: [] } });
    const badFuture = parsePlanTemplate(future);
    expect(badFuture.ok).toBe(false);

    const parsed = JSON.parse(EXAMPLE_PLAN_TEMPLATE) as {
      plan: { days: Array<{ exercises?: Array<{ target: Record<string, unknown> }> }> };
    };
    const firstTarget = parsed.plan.days[0].exercises?.[0].target;
    if (firstTarget) firstTarget.perSetConfigs = [];
    const contraband = parsePlanTemplate(JSON.stringify(parsed));
    expect(contraband.ok).toBe(false);
  });

  it('全量备份格式不能被计划模板入口接受（边界不误放开）', () => {
    const r = parsePlanTemplate(JSON.stringify({ format: BACKUP_FORMAT, version: 3, data: {} }));
    expect(r.ok).toBe(false);
  });
});
