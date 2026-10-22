/* V4-05 回归：旧 v2「只删组」时迁移不许补出幽灵安排。

   根因（审查 V4D16 实测，用真实 v2 构造器）：
   v2 创建目标 3 组 → 删除第 2 组 → 真实 sets 只剩 roundIndex [1,3]。
   旧 migrate.ts 的 deriveGroups 为凑 target 声明数量 3 补出 groups [1,3,4] ——
   第 4 组没有任何实际行，**本次安排从 2 被改成 3，被删除的组复活了**。

   判据：groups 的**长度**必须等于真实存在行的不同轮数。
   `[1,3,4]` 三组都有行 → 保留 3 个（主分支，已修好，不得回归）；
   `[1,3]` 两组有行 → 只保留 2 个。

   fixture 全部来自真实回滚源码（_rollback/v2-snapshot-20261021b）的构造器，
   不是手写删字段的假数据：v2 的 createSession → addSetTo → removeSetFrom 本身就会
   产出稀疏组号，这正是生产里真实发生过的路径。 */

import 'fake-indexeddb/auto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { migrateSessions, validateBackup, BACKUP_FORMAT, BACKUP_VERSION } from '../src/db/repo';
import { deriveGroups, deriveGroupsFrom, migrateLegacyData, migrationIsIdempotent } from '../src/db/migrate';
import { summarizeSession } from '../src/domain/session';
import type { Session, SessionExercise } from '../src/domain/types';

const NOW = 1_760_000_000_000;

/* ── 真实回滚源码（v2）─────────────────────
   tsconfig include 只有 src/test，跨目录静态 import 会被 tsc 报错，
   所以用 fileURLToPath + 动态 import 加载，类型按 any 处理。 */
const V2_DOMAIN = fileURLToPath(new URL('../../_rollback/v2-snapshot-20261021b/src/domain/', import.meta.url));

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

/** 用真实 v2 构造器：胸 A 第一个动作，目标 3 组 */
async function v2BaseSession(): Promise<{ plan: any; session: any; exId: string }> {
  const v2 = await loadV2();
  const plan = await v2PresetPlan();
  const day = plan.days[0];
  const session = v2.createSession(plan, day, NOW);
  const exId: string = session.exercises[0].id;
  return { plan, session, exId };
}

/** 只删不加：目标 3 组，删第 2 组 → 真实 sets 只剩 roundIndex [1,3] */
async function v2DeleteOnly(): Promise<{ plan: any; session: any }> {
  const v2 = await loadV2();
  const { plan, session, exId } = await v2BaseSession();
  const victim = session.exercises[0].sets.find((x: any) => x.roundIndex === 2);
  const s = v2.removeSetFrom(session, exId, victim.id);
  return { plan, session: s };
}

/** 先加后删：目标 3 → 加第 4 → 删第 2 → roundIndex [1,3,4]（主分支，不得回归） */
async function v2AddThenDelete(): Promise<{ plan: any; session: any }> {
  const v2 = await loadV2();
  const { plan, session, exId } = await v2BaseSession();
  const added = v2.addSetTo(session, exId);
  const victim = added.exercises[0].sets.find((x: any) => x.roundIndex === 2);
  const s = v2.removeSetFrom(added, exId, victim.id);
  return { plan, session: s };
}

/** 递减组：腿 A 的哑铃侧平举（真实 v2 预设 3 轮 × 3 阶段），删掉整轮 */
async function v2DropDeleteRound(round: number): Promise<{ plan: any; session: any; exName: string }> {
  const v2 = await loadV2();
  const plan = await v2PresetPlan();
  const legsA = plan.days.find((d: any) => d.name === '腿 A');
  const session = v2.createSession(plan, legsA, NOW);
  const lateral = session.exercises.find((e: any) => e.name === '哑铃侧平举');
  const victim = lateral.sets.find((x: any) => x.roundIndex === round);
  const s = v2.removeSetFrom(session, lateral.id, victim.id);
  return { plan, session: s, exName: '哑铃侧平举' };
}

/** 记录所有行（真实 v2 结构：没有 groups 字段） */
function logAll(session: any, reps = 10, weightKg = 40): any {
  const copy = JSON.parse(JSON.stringify(session));
  for (const ex of copy.exercises) {
    for (const st of ex.sets) {
      st.reps = reps;
      st.weightKg = weightKg;
      st.status = 'done';
    }
  }
  copy.status = 'completed';
  copy.endedAt = NOW + 60_000;
  return copy;
}

function wrapBackup(data: { plans: unknown[]; sessions: unknown[]; settings?: unknown[] }) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: NOW,
    appVersion: '0.9.0',
    data: { plans: data.plans, sessions: data.sessions, settings: data.settings ?? [] },
  };
}

const onlyExercise = (session: Session, ex: SessionExercise): Session => ({ ...session, exercises: [ex] });
const findEx = (session: Session, name: string): SessionExercise => session.exercises.find((e) => e.name === name)!;
const roundIndexesOf = (ex: SessionExercise): number[] =>
  Array.from(new Set(ex.sets.map((s) => s.roundIndex))).sort((a, b) => a - b);

/** 迁移入口：备份校验 → repo.migrateSessions（与恢复路径一致） */
async function migrateThroughBackup(plan: any, session: any): Promise<Session> {
  const v = validateBackup(JSON.parse(JSON.stringify(wrapBackup({ plans: [plan], sessions: [session] }))));
  expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
  if (!v.ok) throw new Error(v.error);
  const [migrated] = migrateSessions(JSON.parse(JSON.stringify(v.payload.data.sessions)) as Session[]);
  return migrated;
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

/* ══ V4-05 必须覆盖的 8 条断言 ═════════════════════════════════ */

describe('V4-05 旧 v2 只删组不产生幽灵安排', () => {
  it('① 只删不加：目标 3 组删第 2 组 → sets [1,3] → groups 长度 2、indexes [1,3]，completed 不变', async () => {
    const { plan, session } = await v2DeleteOnly();
    // fixture 自证：这就是审查复现的那条真实路径
    expect(session.exercises[0].sets.map((s: any) => s.roundIndex)).toEqual([1, 3]);
    expect('groups' in session.exercises[0]).toBe(false);
    expect(session.exercises[0].target.sets).toBe(3); // 原计划目标仍是 3

    const migrated = await migrateThroughBackup(plan, logAll(session));
    const ex = migrated.exercises[0];

    // 旧实现给出 [1,3,4]（第 4 组无任何实际行 = 被删的第 2 组换了个号复活）
    expect(ex.groups.map((g) => g.index)).toEqual([1, 3]);
    expect(ex.groups).toHaveLength(2);
    expect(ex.groups).toHaveLength(new Set(ex.sets.map((s) => s.roundIndex)).size);

    // 完成量不变：两组都有记录 → 2 个完整组
    expect(summarizeSession(onlyExercise(migrated, ex), NOW).completedSets).toBe(2);
    // 本次安排 = 2（不是被改回 3）
    expect(summarizeSession(onlyExercise(migrated, ex), NOW).arrangedGroups).toBe(2);
    // 计划目标快照仍保留 3
    expect((ex.target as { sets: number }).sets).toBe(3);
  });

  it('② 先加后删（主分支）：目标 3 → 加第 4 → 删第 2 → groups 长度 3、indexes [1,3,4]，completed 3', async () => {
    const { plan, session } = await v2AddThenDelete();
    expect(session.exercises[0].sets.map((s: any) => s.roundIndex)).toEqual([1, 3, 4]);

    const migrated = await migrateThroughBackup(plan, logAll(session));
    const ex = migrated.exercises[0];
    expect(ex.groups.map((g) => g.index)).toEqual([1, 3, 4]);
    expect(ex.groups).toHaveLength(3);
    // 三组都有真实行 → 完成量 3，一个都不能丢（V3-02 主分支不回归）
    expect(summarizeSession(onlyExercise(migrated, ex), NOW).completedSets).toBe(3);
  });

  it('③ 合法零组：groups [] / sets [] → 仍是 0 组（不造幽灵组）', async () => {
    const { plan, session } = await v2DeleteOnly();
    const trimmed = JSON.parse(JSON.stringify(logAll(session)));
    trimmed.exercises[0].sets = [];
    trimmed.exercises[0].target = { ...trimmed.exercises[0].target, sets: 0, setsMax: 0 };

    const m = migrateLegacyData({ plans: [plan], sessions: [trimmed], settings: [] });
    const ex = (m.sessions as any[])[0].exercises[0];
    expect(ex.groups).toEqual([]);

    // v3 合法空数组在 repo 迁移里也不被当成缺失
    const v3: Session = {
      ...(trimmed as Session),
      exercises: [{ ...(trimmed as Session).exercises[0], groups: [] }],
    };
    const [kept] = migrateSessions([JSON.parse(JSON.stringify(v3)) as Session]);
    expect(kept.exercises[0].groups).toEqual([]);
  });

  it('④ 稀疏 drop 轮次：递减组删掉第 2 轮 → 只保留实际存在的轮次', async () => {
    const { plan, session, exName } = await v2DropDeleteRound(2);
    const lateralBefore = session.exercises.find((e: any) => e.name === exName);
    expect([...new Set(lateralBefore.sets.map((s: any) => s.roundIndex))]).toEqual([1, 3]);

    const migrated = await migrateThroughBackup(plan, logAll(session, 12, 7.5));
    const ex = findEx(migrated, exName);
    expect(ex.groups.map((g) => g.index)).toEqual([1, 3]);
    // 阶段数来自 target 结构（3 阶段），不是现存行数
    expect(ex.groups.every((g) => g.stageCount === 3)).toBe(true);
    expect(ex.groups).toHaveLength(new Set(ex.sets.map((s) => s.roundIndex)).size);
  });

  it('⑤ 重复迁移幂等：跑两次 JSON 完全相同', async () => {
    const { plan, session } = await v2DeleteOnly();
    const logged = logAll(session);
    const once = migrateSessions(JSON.parse(JSON.stringify([logged])) as Session[]);
    const twice = migrateSessions(JSON.parse(JSON.stringify(once)) as Session[]);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(migrationIsIdempotent({ plans: [plan], sessions: [logged], settings: [] })).toBe(true);

    // 走完整备份路径也幂等
    const first = await migrateThroughBackup(plan, logged);
    const second = migrateSessions(JSON.parse(JSON.stringify([first])) as Session[]);
    expect(JSON.stringify(second)).toBe(JSON.stringify([first]));
  });

  it('⑥ 已完成数据、ID、次数、重量不变', async () => {
    const { plan, session } = await v2DeleteOnly();
    const logged = logAll(session);
    const before = logged.exercises[0].sets.map((s: any) => ({
      id: s.id,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      status: s.status,
    }));

    const migrated = await migrateThroughBackup(plan, logged);
    const after = migrated.exercises[0].sets.map((s) => ({
      id: s.id,
      roundIndex: s.roundIndex,
      stageIndex: s.stageIndex,
      reps: s.reps,
      weightKg: s.weightKg,
      status: s.status,
    }));
    expect(after).toEqual(before);
    // 组结构变了，但记录行一行都没动
    expect(migrated.exercises[0].sets).toHaveLength(2);
  });

  it('⑦ 删除的安排不复活：groups 长度 === 真实不同轮数（多组删法都成立）', async () => {
    const cases = [
      { removeRounds: [2], expect: [1, 3] },
      { removeRounds: [1], expect: [2, 3] },
      { removeRounds: [3], expect: [1, 2] },
      { removeRounds: [1, 3], expect: [2] },
    ];
    const v2 = await loadV2();
    for (const c of cases) {
      const { plan, session } = await v2BaseSession();
      let s = session;
      for (const r of c.removeRounds) {
        const victim = s.exercises[0].sets.find((x: any) => x.roundIndex === r);
        s = v2.removeSetFrom(s, s.exercises[0].id, victim.id);
      }
      const migrated = await migrateThroughBackup(plan, logAll(s));
      const ex = migrated.exercises[0];
      const realRounds = roundIndexesOf(ex);
      expect(ex.groups.map((g) => g.index), `删掉 ${c.removeRounds.join(',')}`).toEqual(c.expect);
      expect(ex.groups).toHaveLength(realRounds.length);
      // 每个 group 都必须有真实行支撑
      for (const g of ex.groups) {
        expect(ex.sets.some((st) => st.roundIndex === g.index), `组 ${g.index} 必须真实存在`).toBe(true);
      }
    }
  });

  it('⑧ 真正缺失结构 + 无实际行：按 target 声明重建（唯一允许的从无到有）', async () => {
    const { plan, session } = await v2DeleteOnly();
    const trimmed = JSON.parse(JSON.stringify(session));
    trimmed.exercises[0].sets = [];
    trimmed.exercises[0].target = { ...trimmed.exercises[0].target, sets: 3, setsMax: 3 };

    const m = migrateLegacyData({ plans: [plan], sessions: [trimmed], settings: [] });
    const ex = (m.sessions as any[])[0].exercises[0];
    expect(ex.groups.map((g: any) => g.index)).toEqual([1, 2, 3]);
    // 不编造完成值：重建的组没有任何记录
    expect(ex.sets).toEqual([]);
  });
});

/* ── 共享规则：migrate 与 repo 必须完全一致 ───── */
describe('V4-05 migrate 与 repo 的重建规则一致', () => {
  it('deriveGroups 与 deriveGroupsFrom 对同一输入给出同一结果', () => {
    const targets = [
      { kind: 'straight', sets: 3 },
      { kind: 'straight', sets: 5 },
      { kind: 'dropSet', rounds: 3, stages: [{}, {}, {}] },
    ];
    const setCases: unknown[][] = [
      [],
      [{ roundIndex: 1 }, { roundIndex: 3 }],
      [{ roundIndex: 1 }, { roundIndex: 3 }, { roundIndex: 4 }],
      [{ roundIndex: 2 }],
    ];
    for (const target of targets) {
      for (const sets of setCases) {
        const ex = { sets };
        expect(deriveGroups(ex, target)).toEqual(deriveGroupsFrom(sets, target));
      }
    }
  });

  it('repo 重建路径（groups 字段缺失）与 migrateLegacyData 结果一致', async () => {
    const { session } = await v2DeleteOnly();
    const logged = logAll(session);
    // repo 路径：删掉 groups 字段后由 migrateSessions 重建
    const forRepo = JSON.parse(JSON.stringify(logged)) as Session;
    delete (forRepo.exercises[0] as { groups?: unknown }).groups;
    const [viaRepo] = migrateSessions([forRepo]);
    // migrate 路径：备份迁移
    const viaMigrate = migrateLegacyData({
      plans: [],
      sessions: [JSON.parse(JSON.stringify(logged))],
      settings: [],
    });
    const exViaMigrate = (viaMigrate.sessions as any[])[0].exercises[0];
    expect(viaRepo.exercises[0].groups.map((g) => g.index)).toEqual(
      exViaMigrate.groups.map((g: any) => g.index),
    );
  });
});
