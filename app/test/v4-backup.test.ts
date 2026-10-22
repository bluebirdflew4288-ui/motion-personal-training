/* V3-02 回归：备份迁移保真 + 容量上限。
   三类根因（独立审查复现）：
   1) P1 真实 v2 稀疏组号（removeSetFrom 留下 roundIndex [1,3,4]）迁移后被按「数量」
      重建成 [1,2,3]，第 4 组不再匹配任何 group → 完成量 3 变 2。
   2) P1 validateSession 里 `.slice(0, MAX_EXERCISES)` 让 61 个训练动作「导入成功」却只剩 60 个。
   3) P1 repo.migrateSessions 用 `ex.groups?.length ? ... : 重建`，把 v3 合法的 `groups: []`
      （背 B 的可选零组动作）当成缺失，造出幽灵组。

   fixture 全部来自**真实回滚源码的构造器**（_rollback/v2-snapshot-20261021b），
   不是手写删字段的假数据：v2 的 createSession → addSetTo → removeSetFrom 本身就会
   产出稀疏组号，这正是生产里真实发生过的路径。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  listSessions,
  migrateSessions,
  restoreBackup,
  savePlan,
  saveSession,
  validateBackup,
} from '../src/db/repo';
import { migrateLegacyData, migrationIsIdempotent } from '../src/db/migrate';
import { createSession, summarizeSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Plan, Session, SessionExercise } from '../src/domain/types';

const NOW = 1_760_000_000_000;

/* ── 真实回滚源码（v2）─────────────────────
   tsconfig include 只有 src/test，跨目录静态 import 会被 tsc 报错，
   所以用 fileURLToPath + 动态 import 加载，类型按 any 处理。 */
const V2_DOMAIN = fileURLToPath(
  new URL('../../_rollback/v2-snapshot-20261021b/src/domain/', import.meta.url),
);

type V2Module = {
  createSession: (plan: unknown, day: unknown, now?: number) => any;
  addSetTo: (session: any, exId: string) => any;
  removeSetFrom: (session: any, exId: string, setId: string) => any;
};

let v2Cache: V2Module | null = null;
async function loadV2(): Promise<V2Module> {
  if (v2Cache) return v2Cache;
  const mod = (await import(/* @vite-ignore */ pathToFileURL(`${V2_DOMAIN}session.ts`).href)) as V2Module;
  v2Cache = mod;
  return mod;
}

async function v2PresetPlan(now = NOW): Promise<any> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(`${V2_DOMAIN}presets/v32.ts`).href)) as {
    createV32Plan: (now?: number) => any;
  };
  return mod.createV32Plan(now);
}

/** 用真实 v2 构造器造出「稀疏组号 + 全部记完」的训练记录（v2 结构：没有 groups 字段） */
async function v2SparseSession(): Promise<{ plan: any; session: any }> {
  const v2 = await loadV2();
  const plan = await v2PresetPlan();
  const day = plan.days[0];
  let s = v2.createSession(plan, day, NOW);
  const exId: string = s.exercises[0].id;

  // 真实 v2 用户路径：先临时加一组（4 组），再删掉第 2 组 → roundIndex 变成 [1,3,4]
  s = v2.addSetTo(s, exId);
  const victim = s.exercises[0].sets.find((x: any) => x.roundIndex === 2);
  s = v2.removeSetFrom(s, exId, victim.id);

  // 三组都记满（reps/weight 都有值）
  for (const ex of s.exercises) {
    for (const st of ex.sets) {
      st.reps = 10;
      st.weightKg = 40;
      st.status = 'done';
    }
  }
  s.status = 'completed';
  s.endedAt = NOW + 60_000;
  return { plan, session: s };
}

function wrapBackup(data: { plans: unknown[]; sessions: unknown[]; settings?: unknown[] }, appVersion = '0.9.0') {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: NOW,
    appVersion,
    data: { plans: data.plans, sessions: data.sessions, settings: data.settings ?? [] },
  };
}

/** 只保留一个动作的等价训练，便于对单动作断言完成组数 */
function onlyExercise(session: Session, ex: SessionExercise): Session {
  return { ...session, exercises: [ex] };
}

const findEx = (session: Session, name: string): SessionExercise =>
  session.exercises.find((e) => e.name === name)!;

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

/* ── 根因 1：稀疏组号迁移保真 ─────────────── */
describe('P1-1 真实 v2 稀疏组号迁移保真', () => {
  it('v2 createSession → addSetTo → removeSetFrom 产出 roundIndex [1,3,4]（fixture 自证）', async () => {
    const { session } = await v2SparseSession();
    const ex = session.exercises[0];
    // fixture 自证：这就是审查复现的那条路径，不是手写数据
    expect(ex.sets.map((s: any) => s.roundIndex)).toEqual([1, 3, 4]);
    expect('groups' in ex).toBe(false); // v2 没有 groups 字段
    expect(ex.sets.every((s: any) => s.status === 'done' && s.reps !== null && s.weightKg !== null)).toBe(true);
  });

  it('迁移后完成组数仍是 3，groups 的 index 与 sets 的 roundIndex 一一对应', async () => {
    const { plan, session } = await v2SparseSession();

    // ① 备份先被接受（旧结构 → 旧规则校验 → 内存迁移）
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }))));
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;

    // ② 直接钉住 migrateLegacyData → deriveGroups 的产出（旧实现在这里给出 [1,2,3]）
    const payloadEx = v.payload.data.sessions[0].exercises[0];
    expect(payloadEx.groups.map((g) => g.index)).toEqual([1, 3, 4]);

    // ③ 恢复路径上真正跑的那一步迁移
    const migrated = migrateSessions(JSON.parse(JSON.stringify(v.payload.data.sessions)) as Session[]);
    const ex = migrated[0].exercises[0];

    // 关键不变量：组号是真实组号，不是按数量重排的 1,2,3
    // （旧实现给出 [1,2,3]，因此下面 completedSets 会变成 2 —— 这条断言就是失败路径）
    expect(ex.groups.map((g) => g.index)).toEqual([1, 3, 4]);
    expect(new Set(ex.groups.map((g) => g.index))).toEqual(new Set(ex.sets.map((s) => s.roundIndex)));

    // 完成组数 3，不是 2
    expect(summarizeSession(onlyExercise(migrated[0], ex), NOW).completedSets).toBe(3);
  });

  it('每个 set 的 id / 次数 / 重量在迁移前后完全不变', async () => {
    const { plan, session } = await v2SparseSession();
    const before = session.exercises[0].sets.map((s: any) => ({
      id: s.id,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      status: s.status,
    }));

    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }))));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const [migrated] = migrateSessions(JSON.parse(JSON.stringify(v.payload.data.sessions)) as Session[]);
    const after = migrated.exercises[0].sets.map((s) => ({
      id: s.id,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      status: s.status,
    }));
    expect(after).toEqual(before);
  });

  it('声明数量多于真实组号时只保留真实组号，绝不补幽灵组（V4-05）', async () => {
    const { plan, session } = await v2SparseSession();
    // 人为把 roundIndex=3 的整组行拿掉 → 真实组号 [1,4]，target.sets 仍是 3
    const trimmed = JSON.parse(JSON.stringify(session));
    trimmed.exercises[0].sets = trimmed.exercises[0].sets.filter((s: any) => s.roundIndex !== 3);
    expect(trimmed.exercises[0].sets.map((s: any) => s.roundIndex)).toEqual([1, 4]);

    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [trimmed] }))));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const [migrated] = migrateSessions(JSON.parse(JSON.stringify(v.payload.data.sessions)) as Session[]);
    // V4-05 口径变更（原断言是 [1,4,5]）：
    // 「本次安排」以真实存在的轮/组为准，groups 长度必须等于真实不同轮数。
    // 第 5 组没有任何实际行，补出来就是把「计划目标 3」冒充成「本次安排 3」——
    // 与被删除的组复活是同一类错误。原计划目标仍保留在 target.sets（=3）里。
    expect(migrated.exercises[0].groups.map((g) => g.index)).toEqual([1, 4]);
    expect(migrated.exercises[0].groups).toHaveLength(
      new Set(migrated.exercises[0].sets.map((s) => s.roundIndex)).size,
    );
    // 原计划目标快照不因此被改写
    expect((migrated.exercises[0].target as { sets: number }).sets).toBe(3);
  });

  it('零 set 行的旧动作按声明从无到有生成（允许的唯一情况）', async () => {
    const { plan, session } = await v2SparseSession();
    const trimmed = JSON.parse(JSON.stringify(session));
    trimmed.exercises[0].sets = [];
    trimmed.exercises[0].target = { ...trimmed.exercises[0].target, sets: 3, setsMax: 3 };
    const m = migrateLegacyData({ plans: [plan], sessions: [trimmed], settings: [] });
    const ex = (m.sessions as any[])[0].exercises[0];
    expect(ex.groups.map((g: any) => g.index)).toEqual([1, 2, 3]);
  });
});

/* ── 根因 2：数组超限一律明确拒绝 ─────────── */
describe('P1-2 数组超限明确拒绝，绝不裁剪', () => {
  async function sessionWithExercises(n: number): Promise<Session> {
    const plan = createV32Plan(NOW);
    const base = createSession(plan, plan.days[0], NOW);
    const template = base.exercises[0];
    const exercises: SessionExercise[] = Array.from({ length: n }, (_, i) => ({
      ...JSON.parse(JSON.stringify(template)),
      id: `sex-${i}`,
      name: `动作 ${i}`,
      sets: template.sets.map((st, j) => ({ ...st, id: `set-${i}-${j}` })),
      groups: template.groups.map((g) => ({ ...g })),
    }));
    return { ...base, exercises };
  }

  it('61 个训练动作被明确拒绝（旧实现会静默只留 60 个）', async () => {
    const plan = createV32Plan(NOW);
    const session = await sessionWithExercises(61);
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }, '1.0.0'))));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.issues?.some((i) => i.path.includes('exercises') && i.message.includes('超过上限'))).toBe(true);
    }
  });

  it('60 个训练动作仍被接受（上限本身不误杀）', async () => {
    const plan = createV32Plan(NOW);
    const session = await sessionWithExercises(60);
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }, '1.0.0'))));
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
  });

  it('61 个计划动作仍被明确拒绝', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days[0];
    const exercises = Array.from({ length: 61 }, (_, i) => ({
      ...JSON.parse(JSON.stringify(day.exercises[0])),
      id: `ex-${i}`,
      name: `动作 ${i}`,
    }));
    const big: Plan = { ...plan, days: [{ ...day, exercises }] };
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [big], sessions: [] }, '1.0.0'))));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('超过上限');
  });

  it('组记录行数超限是报错，不是把整个动作丢掉', async () => {
    const plan = createV32Plan(NOW);
    const base = createSession(plan, plan.days[0], NOW);
    const ex = base.exercises[0];
    const template = ex.sets[0];
    const sets = Array.from({ length: 201 }, (_, i) => ({
      ...template,
      id: `set-${i}`,
      roundIndex: i + 1,
      stageIndex: 1,
    }));
    const session: Session = {
      ...base,
      exercises: [{ ...ex, sets, groups: sets.map((s) => ({ index: s.roundIndex, stageCount: 1 })) }],
    };
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }, '1.0.0'))));
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // 关键：路径指向 sets 的「超过上限」，而不是整个动作被判为无法解析后消失
      expect(v.issues?.some((i) => i.path.endsWith('.sets') && i.message.includes('超过上限'))).toBe(true);
    }
  });

  it('热身项超限：计划侧与训练侧都明确拒绝', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days[0];
    const warmups = Array.from({ length: 61 }, (_, i) => ({
      id: `w-${i}`,
      name: `热身 ${i}`,
      unit: 'reps' as const,
      targetText: '2 × 10',
    }));
    const bigPlan: Plan = { ...plan, days: [{ ...day, warmups }] };
    const vp = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [bigPlan], sessions: [] }, '1.0.0'))));
    expect(vp.ok).toBe(false);

    const base = createSession(plan, day, NOW);
    const bigSession: Session = {
      ...base,
      warmups: warmups.map((w) => ({ ...w, done: false })),
    };
    const vs = validateBackup(
      JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [bigSession] }, '1.0.0'))),
    );
    expect(vs.ok).toBe(false);
    if (!vs.ok) expect(vs.issues?.some((i) => i.path.includes('warmups'))).toBe(true);
  });

  it('替代动作清单超限被拒绝（计划与训练两侧）', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days[0];
    const substitutes = Array.from({ length: 61 }, (_, i) => `替代 ${i}`);
    const bigPlan: Plan = {
      ...plan,
      days: [
        {
          ...day,
          exercises: day.exercises.map((ex, i) => (i === 0 ? { ...ex, substitutes } : ex)),
        },
      ],
    };
    const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [bigPlan], sessions: [] }, '1.0.0'))));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues?.some((i) => i.path.includes('substitutes'))).toBe(true);
  });
});

/* ── 根因 3：合法空 groups 不被当成缺失 ───── */
describe('P1-3 合法空 groups 不被当成缺失', () => {
  it('v3 零组动作（groups: [] / sets: []）备份接受 → 恢复后仍是空，不产生幽灵组', async () => {
    const plan = createV32Plan(NOW);
    const backB = plan.days.find((d) => d.name === '背 B')!;
    const session = createSession(plan, backB, NOW);
    const opt = findEx(session, '绳索直臂下拉');
    // v3 合法数据本身：0 组 → groups/sets 都是空数组
    expect(opt.groups).toHaveLength(0);
    expect(opt.sets).toHaveLength(0);

    await savePlan(plan);
    await saveSession({ ...session, status: 'completed', endedAt: NOW + 1000 });
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v = validateBackup(backup);
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;

    await restoreBackup(v.payload);
    const [restored] = await listSessions();
    const ex = findEx(restored, '绳索直臂下拉');
    // 旧实现会在这里造出 [{index:1,stageCount:1}] 幽灵组
    expect(ex.groups).toHaveLength(0);
    expect(ex.sets).toHaveLength(0);
  });

  it('缺 groups 字段的旧动作：迁移补出的 index 覆盖所有真实 roundIndex', async () => {
    const plan = createV32Plan(NOW);
    const base = createSession(plan, plan.days[0], NOW);
    const legacy = JSON.parse(JSON.stringify(base)) as Session;
    for (const ex of legacy.exercises) delete (ex as { groups?: unknown }).groups;
    // 造一个稀疏组号：第 2 组的行删掉
    legacy.exercises[0].sets = legacy.exercises[0].sets.filter((s) => s.roundIndex !== 2);

    const [migrated] = migrateSessions([legacy]);
    for (const ex of migrated.exercises) {
      const indexes = new Set(ex.groups.map((g) => g.index));
      for (const st of ex.sets) expect(indexes.has(st.roundIndex)).toBe(true);
    }
    expect(migrated.exercises[0].groups.map((g) => g.index)).toEqual([1, 3]);
  });

  it('迁移补齐 revision=0，已有 revision 原样保留', () => {
    const plan = createV32Plan(NOW);
    const s = createSession(plan, plan.days[0], NOW);
    const [fresh] = migrateSessions([s]);
    expect(fresh.revision).toBe(0);

    const bumped: Session = { ...s, revision: 7 };
    const [kept] = migrateSessions([bumped]);
    expect(kept.revision).toBe(7);
  });

  it('迁移幂等：跑两次 JSON 完全相同', async () => {
    const { plan, session } = await v2SparseSession();
    const once = migrateSessions(JSON.parse(JSON.stringify([session])) as Session[]);
    const twice = migrateSessions(JSON.parse(JSON.stringify(once)) as Session[]);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    // 已含 groups 的 v3 数据再跑一次也不变（含合法空数组那条）
    const v3Plan = createV32Plan(NOW);
    const backB = v3Plan.days.find((d) => d.name === '背 B')!;
    const v3 = createSession(v3Plan, backB, NOW);
    const a = migrateSessions([v3]);
    const b = migrateSessions(JSON.parse(JSON.stringify(a)) as Session[]);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    // 旧结构整体迁移也幂等
    expect(migrationIsIdempotent({ plans: [plan], sessions: [session], settings: [] })).toBe(true);
  });
});

/* ── 保留已通过项（不得回归）───────────────── */
describe('保留项：既有 PASS 项不回归', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures-v1-backup.json', import.meta.url));
  const v1 = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('真实 v1 备份仍可通过升级预览', () => {
    const r = validateBackup(v1);
    expect(r.ok, r.ok ? '' : (r as { error: string }).error).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('旧版本'))).toBe(true);
    expect(r.preview.sessions).toBe(v1.data.sessions.length);
  });

  it('基本 v2 备份可导入（补 groups）', async () => {
    const { plan, session } = await v2SparseSession();
    const r = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }))));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ex = r.payload.data.sessions[0].exercises[0];
    expect(Array.isArray(ex.groups)).toBe(true);
    expect(ex.groups.length).toBeGreaterThan(0);
  });

  it('新 v3 备份正常往返（restore → buildBackup → validate 等价）', async () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const session = createSession(plan, legsA, NOW);
    await savePlan(plan);
    await saveSession({ ...session, status: 'completed', endedAt: NOW + 1000 });

    const b1 = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v1r = validateBackup(b1);
    expect(v1r.ok).toBe(true);
    if (!v1r.ok) return;
    await restoreBackup(v1r.payload);

    const b2 = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v2r = validateBackup(b2);
    expect(v2r.ok).toBe(true);
    if (!v2r.ok) return;
    // 数据等价：动作/组结构/组记录一致
    expect(b2.data.sessions[0].exercises.map((e: SessionExercise) => e.groups)).toEqual(
      b1.data.sessions[0].exercises.map((e: SessionExercise) => e.groups),
    );
    expect(b2.data.sessions[0].exercises.map((e: SessionExercise) => e.sets)).toEqual(
      b1.data.sessions[0].exercises.map((e: SessionExercise) => e.sets),
    );
  });

  it('坏元数据仍被拒绝：appVersion 非字符串 / exportedAt 非有限数 / theme 非法', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const base = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const cases: Array<[string, (b: any) => void]> = [
      ['appVersion 对象', (b) => { b.appVersion = { v: 1 }; }],
      ['appVersion 数字', (b) => { b.appVersion = 42; }],
      ['exportedAt 非有限数', (b) => { b.exportedAt = Number.POSITIVE_INFINITY; }],
      ['exportedAt 文本', (b) => { b.exportedAt = 'yesterday'; }],
      ['theme 非法', (b) => { b.data.settings = [{ key: 'app', theme: 'neon' }]; }],
    ];
    for (const [label, mutate] of cases) {
      const copy = JSON.parse(JSON.stringify(base));
      mutate(copy);
      const r = validateBackup(copy);
      expect(r.ok, `${label} 应被拒绝`).toBe(false);
    }
  });

  it('同一动作内重复 set ID 仍被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    session.exercises[0].sets[1].id = session.exercises[0].sets[0].id;
    await saveSession(session);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v = validateBackup(backup);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues?.some((i) => i.message.includes('重复'))).toBe(true);
  });
});
