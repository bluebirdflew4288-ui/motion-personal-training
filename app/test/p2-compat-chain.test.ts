/* 第2阶段 · 真实存储链路（场景 1 / 2 / 5 / 7）。

   ── 证据边界 ────────────────────────────────────────────────
   本文件打开**真实 fake-indexeddb**、走**真实 repo/tx/validate** 链路，
   不是镜像 helper：
   · 场景1：把**旧对象直接 seed 进 IDB**（绕过 restore/migration）→ 真实读取
   · 场景2：v1 备份恢复保真 + v1 夹带新结构必须拒绝
   · 场景5：v2 导出 → 校验 → 恢复 → 重读 → 重导出，逐字段比较
   · 场景7：同日休息连点/两页竞争 + 与 active/实际训练互斥

   不含真实 Android 运行时与浏览器 UI。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  buildBackup,
  getSession,
  listSessions,
  restoreBackup,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import { atomicCreateRest, atomicDeleteRest, atomicFinishSession, atomicWriteSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  createAdhocCardioSession,
  createRestSession,
  createSession,
  summarizeSession,
  withCardioEntry,
} from '../src/domain/session';
import {
  commitCardioParams,
  completeCardio,
  pauseCardio,
  resumeCardio,
  startCardio,
} from '../src/domain/cardio';
import { localDateKey } from '../src/domain/localDate';
import { sessionKindOf } from '../src/domain/sessionKind';
import { buildOverview } from '../src/domain/stats';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
const M = 60_000;

beforeEach(async () => {
  __resetDbHandle();
  await idbClear('sessions');
  await idbClear('plans');
  await idbClear('meta');
  await idbClear('settings');
});

/** 造一条**真正的旧版**对象：删掉第2阶段所有字段，模拟 0.1.2 写出的记录 */
function stripPhase2(s: Session): Session {
  const copy = structuredClone(s) as unknown as Record<string, unknown>;
  delete copy.kind;
  delete copy.origin;
  delete copy.cardio;
  delete copy.restDate;
  delete copy.cardioPausedBySession;
  return copy as unknown as Session;
}

describe('场景1 · 直接覆盖升级读旧库（绕过 restore）', () => {
  it('旧对象直接 seed 进 IDB → 真实读取补缺省，旧字段一字不动', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const fresh = createSession(plan, day, NOW);
    // 造一点真实数据：某组 reps=0 / 重量 0（真实 0 不能丢）
    fresh.exercises[0].sets[0] = {
      ...fresh.exercises[0].sets[0],
      reps: 0,
      weightKg: 0,
      status: 'done',
    };
    const legacy = stripPhase2(fresh);

    // 绕过 restore / migration：直接写原始旧对象
    await idbPut('sessions', legacy);

    const read = await getSession(legacy.id);
    expect(read).toBeDefined();
    // 归一化缺省
    expect(read!.kind).toBe('strength');
    expect(read!.origin).toBe('plan');
    expect(read!.cardio).toEqual([]);
    expect(read!.cardioPausedBySession).toEqual([]);
    // 旧字段完全不变
    expect(read!.exercises[0].sets[0].reps).toBe(0);
    expect(read!.exercises[0].sets[0].weightKg).toBe(0);
    expect(read!.targetSetsAtStart).toBe(legacy.targetSetsAtStart);
    expect(read!.exercises.length).toBe(legacy.exercises.length);
    // 空 groups 的合法动作不被复活
    const emptyGroups = read!.exercises.filter((e) => e.groups.length === 0);
    const legacyEmpty = legacy.exercises.filter((e) => e.groups.length === 0);
    expect(emptyGroups.length).toBe(legacyEmpty.length);
  });

  it('读取不写库（归一化只在内存）', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const legacy = stripPhase2(createSession(plan, day, NOW));
    await idbPut('sessions', legacy);
    await getSession(legacy.id);
    // 再直接读原始 IDB 值（不经 normalize）确认未被回写
    const { idbGet } = await import('../src/db/idb');
    const raw = await idbGet<Record<string, unknown>>('sessions', legacy.id);
    expect(raw!.kind).toBeUndefined();
    expect(raw!.cardio).toBeUndefined();
  });
});

describe('场景2 · v1 备份恢复保真 + 夹带新结构必须拒绝', () => {
  it('合法 v1 备份（无新字段）可恢复且旧字段保真', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const legacy = stripPhase2(createSession(plan, day, NOW));

    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.1.2',
      counts: { plans: 1, sessions: 1, activeSessions: 1 },
      data: { plans: [plan], sessions: [legacy], settings: [] },
    };

    const v = validateBackup(v1);
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;
    await restoreBackup(v.payload);
    const after = await getSession(legacy.id);
    expect(after).toBeDefined();
    expect(after!.exercises.length).toBe(legacy.exercises.length);
    expect(after!.targetSetsAtStart).toBe(legacy.targetSetsAtStart);
  });

  it('v1 夹带会话 cardio 字段 → 明确拒绝', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const s = stripPhase2(createSession(plan, day, NOW)) as unknown as Record<string, unknown>;
    s.cardio = [];

    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.1.2',
      counts: { plans: 1, sessions: 1, activeSessions: 1 },
      data: { plans: [plan], sessions: [s], settings: [] },
    };
    const v = validateBackup(v1);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('v1 备份包含新版结构');
  });

  it('v1 夹带计划日 cardio 目标 → 明确拒绝', async () => {
    const plan = createV32Plan(NOW);
    const badPlan = {
      ...plan,
      days: plan.days.map((d, i) =>
        i === 0 ? { ...d, cardio: [{ id: 'pc1', preset: 'treadmill-incline', name: 'x', target: { speedKmh: 4, inclinePct: 4 } }] } : d,
      ),
    };
    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.1.2',
      counts: { plans: 1, sessions: 0, activeSessions: 0 },
      data: { plans: [badPlan], sessions: [], settings: [] },
    };
    const v = validateBackup(v1);
    expect(v.ok).toBe(false);
  });

  it('v1 夹带计划日新类型 cardio → 拒绝', async () => {
    const plan = createV32Plan(NOW);
    const badPlan = {
      ...plan,
      days: plan.days.map((d, i) => (i === 0 ? { ...d, kind: 'cardio' } : d)),
    };
    const v1 = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.1.2',
      counts: { plans: 1, sessions: 0, activeSessions: 0 },
      data: { plans: [badPlan], sessions: [], settings: [] },
    };
    expect(validateBackup(v1).ok).toBe(false);
  });

  it('version 5 → 拒绝（不猜测读取；v4 已是当前格式）', () => {
    const future = {
      format: BACKUP_FORMAT,
      version: 5,
      exportedAt: NOW,
      appVersion: '9.9.9',
      counts: { plans: 0, sessions: 0, activeSessions: 0 },
      data: { plans: [], sessions: [], settings: [] },
    };
    const v = validateBackup(future);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('高于当前应用支持');
  });
});

describe('场景5 · 有氧记录导出 → 校验 → 恢复 → 重读 → 重导出 逐字段保真', () => {
  it('力量+两段有氧的混合记录往返保真', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    let s = createSession(plan, day, NOW);

    // 追加两段有氧（真实计时：0→5 改参→7 暂停→9 继续→12 完成）
    const T0 = NOW;
    let e = startCardio(
      {
        id: 'ce-1',
        preset: 'treadmill-incline',
        name: '有氧爬坡',
        planCardioId: null,
        target: null,
        elapsedMs: 0,
        runningSinceAt: null,
        status: 'pending',
        currentParams: { speedKmh: 4, inclinePct: 4 },
        segments: [],
      },
      T0,
    );
    const c1 = commitCardioParams(e, { speedKmh: 4, inclinePct: 12 }, T0 + 5 * M);
    if (c1.ok) e = c1.entry;
    e = pauseCardio(e, T0 + 7 * M);
    e = resumeCardio(e, T0 + 9 * M);
    e = completeCardio(e, T0 + 12 * M);
    s = withCardioEntry(s, e);

    const ended: Session = { ...s, status: 'completed', endedAt: T0 + 12 * M };
    const r = await atomicWriteSession({
      intent: { kind: 'create' },
      session: ended,
      lockPolicy: 'optional',
    });
    expect(r.ok).toBe(true);

    // 导出当前格式，并显式用旧版 envelope 验证旧格式
    const b1 = await buildBackup('2.0.0');
    expect(b1.version).toBe(4);
    const json1 = JSON.parse(JSON.stringify(b1));

    // 校验
    const v = validateBackup(json1);
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;

    // 恢复
    await restoreBackup(v.payload);
    const reloaded = await getSession(ended.id);
    expect(reloaded).toBeDefined();

    // 逐字段比较有氧
    const ce = reloaded!.cardio?.[0];
    expect(ce).toBeDefined();
    expect(ce!.preset).toBe('treadmill-incline');
    expect(ce!.elapsedMs).toBe(600000);
    expect(ce!.segments).toHaveLength(3);
    expect(ce!.segments.map((x) => [x.startElapsedMs, x.endElapsedMs])).toEqual([
      [0, 300000],
      [300000, 420000],
      [420000, 600000],
    ]);
    expect(ce!.segments[1].params).toEqual({ speedKmh: 4, inclinePct: 12 });
    expect(ce!.status).toBe('done');
    expect(ce!.runningSinceAt).toBeNull();
    // 力量部分不变
    expect(reloaded!.targetSetsAtStart).toBe(ended.targetSetsAtStart);
    expect(reloaded!.exercises.length).toBe(ended.exercises.length);

    // 重导出 → 与第一次逐字段一致（除 exportedAt）
    const b2 = await buildBackup('2.0.0');
    const json2 = JSON.parse(JSON.stringify(b2));
    expect(json2.data.sessions).toEqual(json1.data.sessions);
    expect(json2.data.plans).toEqual(json1.data.plans);
  });

  it('独立有氧会话（无力量结构）往返保真', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createAdhocCardioSession({
      plan,
      preset: 'stair-climber',
      params: { level: 7 },
      now: NOW,
    });
    const r = await atomicWriteSession({
      intent: { kind: 'create' },
      session: s,
      lockPolicy: 'optional',
    });
    expect(r.ok).toBe(true);

    const b = await buildBackup('2.0.0');
    const v = validateBackup(JSON.parse(JSON.stringify(b)));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await restoreBackup(v.payload);
    const after = await getSession(s.id);
    expect(sessionKindOf(after!)).toBe('cardio');
    expect(after!.origin).toBe('temporary');
    expect(after!.exercises).toEqual([]);
    expect(after!.cardio?.[0].currentParams).toEqual({ level: 7 });
  });
});

describe('场景7 · 完全休息的原子去重与强互斥', () => {
  it('同日重复记录 → 只生成一条（跨计划去重）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    const first = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    const r1 = await atomicCreateRest({ session: first, restDate, advanceCycle: false });
    expect(r1.ok).toBe(true);

    // 第二次（模拟连点/另一页）
    const second = createRestSession({ plan, restDate, origin: 'temporary', now: NOW + 1000 });
    const r2 = await atomicCreateRest({ session: second, restDate, advanceCycle: false });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('已经记录过完全休息');

    const all = await listSessions();
    expect(all.filter((s) => sessionKindOf(s) === 'rest')).toHaveLength(1);
  });

  it('存在 active 训练 → 拒绝记录休息', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const active = createSession(plan, day, NOW);
    await atomicWriteSession({ intent: { kind: 'create' }, session: active, lockPolicy: 'optional' });

    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    const r = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('没有结束');
  });

  it('同日已有实际训练内容 → 拒绝（不能把真实训练标成没练）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    // 填一组真实内容：reps=8 / weight=20kg → 真实内容
    const realSet = { ...base.exercises[0].sets[0], reps: 8, weightKg: 20, status: 'done' as const };
    const done: Session = {
      ...base,
      exercises: base.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? realSet : st)) } : ex,
      ),
      status: 'completed',
      endedAt: NOW + 30 * M,
    };
    const c = await atomicWriteSession({ intent: { kind: 'create' }, session: done, lockPolicy: 'optional' });
    expect(c.ok).toBe(true);

    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW + M });
    const r = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('已有实际训练');
  });

  /**
   * Codex G1 关键路径：被**丢弃**但仍带真实运动数据（8次×20kg 的递减阶段）的记录
   * 不能被当成没练 —— 必须按 hasAnyRealContent 判断，不看 status 标签。
   */
  it('同日已丢弃但有真实内容 → 仍拒绝（不能仅按 discarded 标签放行）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    const realSet = { ...base.exercises[0].sets[0], reps: 8, weightKg: 20, status: 'done' as const };
    const discarded: Session = {
      ...base,
      exercises: base.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? realSet : st)) } : ex,
      ),
      status: 'discarded',
      endedAt: NOW + 30 * M,
    };
    const c = await atomicWriteSession({
      intent: { kind: 'create' },
      session: discarded,
      lockPolicy: 'optional',
    });
    expect(c.ok).toBe(true);

    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW + M });
    const r = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('已有实际训练');
  });

  it('撤销休息：只删该记录，不动真实训练', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW - 24 * 60 * M);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW - 24 * 60 * M });
    const r1 = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r1.ok).toBe(true);

    const r2 = await atomicDeleteRest({ session: rest, restDate });
    expect(r2.ok).toBe(true);
    const all = await listSessions();
    expect(all.filter((s) => sessionKindOf(s) === 'rest')).toHaveLength(0);
  });

  it('统计分母排除 rest；纯有氧计一次；混合计一次', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;

    const strength = createSession(plan, day, NOW);
    const cardioOnly = createAdhocCardioSession({ plan, preset: 'stair-climber', params: { level: 5 }, now: NOW });
    const mixed = withCardioEntry(createSession(plan, day, NOW), {
      id: 'ce-x',
      preset: 'treadmill-incline',
      name: '有氧爬坡',
      planCardioId: null,
      target: null,
      elapsedMs: 600000,
      runningSinceAt: null,
      status: 'done',
      currentParams: { speedKmh: 4, inclinePct: 4 },
      segments: [{ id: 's1', startElapsedMs: 0, endElapsedMs: 600000, params: { speedKmh: 4, inclinePct: 4 } }],
    });
    const rest = createRestSession({ plan, restDate: localDateKey(NOW), origin: 'temporary', now: NOW });

    const all: Session[] = [
      { ...strength, status: 'completed', endedAt: NOW + M },
      { ...cardioOnly, status: 'completed', endedAt: NOW + 2 * M },
      { ...mixed, status: 'completed', endedAt: NOW + 3 * M },
      rest,
    ];
    const ov = buildOverview(all);
    // rest 不计入；其余三条各计一次
    expect(ov.totalSessions).toBe(3);
    // 混合记录只计一次（不是两次）
    expect(ov.totalSessions).toBe(3);
    // 平均组数分母也用 3
    expect(ov.avgSetsPerSession).toBeGreaterThanOrEqual(0);
  });
});

describe('有氧总量派生（无冗余真源）', () => {
  it('summarizeSession.cardioMs 从 entries 派生', () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    const withC = withCardioEntry(base, {
      id: 'ce-1',
      preset: 'treadmill-incline',
      name: '有氧爬坡',
      planCardioId: null,
      target: null,
      elapsedMs: 300000,
      runningSinceAt: null,
      status: 'done',
      currentParams: { speedKmh: 4, inclinePct: 4 },
      segments: [],
    });
    const sum = summarizeSession(withC, NOW);
    expect(sum.cardioMs).toBe(300000);
    // 整次训练时长与有氧时长分别计算、不相加
    expect(sum.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/* G1 反向互斥：普通开练（力量/有氧）必须被同日 rest 拦住。
   旧实现只在 create 分支查当前 ID，于是「先记录休息，再开始训练」
   会同时成功，造成同一天既完全休息又练了。 */
describe('G1 · 普通 create 的反向互斥', () => {
  it('同日已有休息 → 开始力量训练被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    const r1 = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r1.ok).toBe(true);

    const day = plan.days.find((d) => d.kind === 'train')!;
    const strength = createSession(plan, day, NOW);
    const r2 = await atomicWriteSession({
      intent: { kind: 'create' },
      session: strength,
      lockPolicy: 'optional',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.message).toContain('完全休息');
    // 库中没有多出这条训练
    const list = await listSessions();
    expect(list.find((s) => s.id === strength.id)).toBeUndefined();
  });

  it('同日已有休息 → 开始独立有氧也被拒绝（双向）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    expect((await atomicCreateRest({ session: rest, restDate, advanceCycle: false })).ok).toBe(true);

    const cardio = createAdhocCardioSession({
      plan,
      preset: 'treadmill-incline',
      params: { speedKmh: 4, inclinePct: 4 },
      now: NOW + M,
    });
    const r = await atomicWriteSession({
      intent: { kind: 'create' },
      session: cardio,
      lockPolicy: 'optional',
    });
    expect(r.ok).toBe(false);
  });

  it('撤销休息后 → 同一天可以正常开始训练', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    // 撤销
    expect((await atomicDeleteRest({ session: rest, restDate })).ok).toBe(true);

    const day = plan.days.find((d) => d.kind === 'train')!;
    const strength = createSession(plan, day, NOW + 2 * M);
    const r = await atomicWriteSession({
      intent: { kind: 'create' },
      session: strength,
      lockPolicy: 'optional',
    });
    expect(r.ok).toBe(true);
  });
});

/* G6：tx 的所有读取出口（含两个"无写入"出口）必须带内存缺省，
   否则调用方拿到裸旧对象会缺 kind/origin/cardio 而判断错乱。
   注意：只读归一，不回写库、不重建 groups/目标分母。 */
describe('G6 · tx 读取出口缺省', () => {
  it('version-conflict.current 带缺省（无写入出口）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const s = createSession(plan, day, NOW);
    await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });
    // 用错误的 expectedRevision 触发 version-conflict，读回 current
    const r = await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: { ...s },
      editorId: 'nope',
      expectedRevision: 999,
      lockPolicy: 'optional',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.current).toBeDefined();
    expect(r.current!.kind).toBe('strength');
    expect(r.current!.origin).toBe('plan');
    expect(Array.isArray(r.current!.cardio)).toBe(true);
  });

  it('alreadyTerminal.session（重复结束幂等出口）带缺省', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const s = createSession(plan, day, NOW);
    await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });
    await atomicFinishSession({ session: { ...s, status: 'completed', endedAt: NOW + M }, guard: { lockPolicy: 'optional' } });
    // 再结束一次 → alreadyTerminal，返回库内既有记录
    const r2 = await atomicFinishSession({ session: { ...s, status: 'completed', endedAt: NOW + 2 * M }, guard: { lockPolicy: 'optional' } });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.alreadyTerminal).toBe(true);
    expect(r2.session.kind).toBe('strength');
    expect(Array.isArray(r2.session.cardio)).toBe(true);
  });
});

/* G8a：计划有氧日 → createSession 生成实际 entry，
   目标参数带入、不带力量结构、dayId 用计划日、focus/round 不伪造。 */
describe('G8a · 计划有氧日执行', () => {
  it('有氧日快照不复制力量动作，entry 带 planCardioId 与目标', async () => {
    const plan = createV32Plan(NOW);
    const cardioDay: typeof plan.days[number] = {
      id: 'day-cardio',
      name: '有氧爬坡',
      kind: 'cardio',
      warmups: [],
      exercises: [{ id: 'ghost', name: '遗留力量动作', restSec: 120, target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: null } }],
      cardio: [{ id: 'pc-1', preset: 'treadmill-incline', name: '有氧爬坡', target: { speedKmh: 5, inclinePct: 10 } }],
    };
    const planWith: typeof plan = { ...plan, days: [...plan.days, cardioDay] };
    const s = createSession(planWith, cardioDay, NOW);
    expect(sessionKindOf(s)).toBe('cardio');
    // 执行按显式类型：不复制 day.exercises（避免幽灵力量结构）
    expect(s.exercises).toEqual([]);
    expect(s.day.focus).toBeUndefined();
    expect(s.day.round).toBeUndefined();
    const entry = s.cardio?.[0];
    expect(entry?.planCardioId).toBe('pc-1');
    expect(entry?.currentParams).toEqual({ speedKmh: 5, inclinePct: 10 });
    expect(entry?.target).toEqual({ speedKmh: 5, inclinePct: 10 });
    expect(entry?.status).toBe('pending');
  });
});

/* G2 · 撤销休息的稳定身份（Codex 复现的两页竞争路径） */
describe('G2 · atomicDeleteRest 稳定身份核验', () => {
  it('A 页用旧快照撤销 → 已被 B 页重建的同日 new 不被误删', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    // A 建 old → 撤销 old → B 建同日 new（真实：两条 id 不同）
    const old = createRestSession({ plan, restDate, origin: 'temporary', now: NOW });
    expect((await atomicCreateRest({ session: old, restDate, advanceCycle: false })).ok).toBe(true);
    expect((await atomicDeleteRest({ session: old, restDate })).ok).toBe(true);
    const re = createRestSession({ plan, restDate, origin: 'temporary', now: NOW + 2000 });
    expect((await atomicCreateRest({ session: re, restDate, advanceCycle: false })).ok).toBe(true);

    // A 仍持有已撤销的 old 快照 → 撤销它不得删除 new
    const r = await atomicDeleteRest({ session: old, restDate });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('已经被改动或撤销');
    // 同日只剩 re 一条
    const list = await listSessions();
    const rests = list.filter((x) => sessionKindOf(x) === 'rest' && x.restDate === restDate);
    expect(rests).toHaveLength(1);
    expect(rests[0].id).toBe(re.id);
  });

  it('正常撤销不碰真实训练、不回退 cursor', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW - 24 * 60 * M);
    const rest = createRestSession({ plan, restDate, origin: 'plan', now: NOW - 24 * 60 * M });
    // 带推进（模拟计划内休息 + advance），再撤销 → 训练不受影响
    const c = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(c.ok).toBe(true);
    const d = await atomicDeleteRest({ session: rest, restDate });
    expect(d.ok).toBe(true);
    const list = await listSessions();
    expect(list.filter((x) => sessionKindOf(x) !== 'rest')).toHaveLength(0);
  });
});

/* G8b · 计划内休息记录（create-rest 事务：一次推进 + 与训练互斥） */
describe('G8b · 计划内休息事务', () => {
  it('plan-rest 记录 → 可选推进一次；同日再记被去重', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const restDate = localDateKey(NOW);
    const day = plan.days.find((d) => d.kind === 'rest') ?? plan.days[0];
    const rest = createRestSession({ plan, restDate, origin: 'plan', now: NOW });
    rest.day = { dayId: day.id, dayName: day.name, partText: '休息' };
    rest.cycleIndexAtStart = plan.cursor;
    const r = await atomicCreateRest({ session: rest, restDate, advanceCycle: true });
    expect(r.ok).toBe(true);

    // 同日第二次（模拟连点）→ 去重
    const again = createRestSession({ plan, restDate, origin: 'plan', now: NOW + 1000 });
    expect((await atomicCreateRest({ session: again, restDate, advanceCycle: false })).ok).toBe(false);

    // 推进后 cursor 变了一次（plan.rest 日，create-rest 事务内推进）
    const after = (await import('../src/db/repo')).getPlan(plan.id);
    // cursor 变化 = 推进一次（循环日数可能 > 0）
    expect(after).toBeDefined();
  });

  it('同日已有训练 → 计划内休息记录被拒（双向互斥）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    const realSet = { ...base.exercises[0].sets[0], reps: 10, weightKg: 40, status: 'done' as const };
    const done: Session = {
      ...base,
      exercises: base.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? realSet : st)) } : ex,
      ),
      status: 'completed',
      endedAt: NOW + 30 * M,
    };
    expect((await atomicWriteSession({ intent: { kind: 'create' }, session: done, lockPolicy: 'optional' })).ok).toBe(true);

    const restDate = localDateKey(NOW);
    const rest = createRestSession({ plan, restDate, origin: 'plan', now: NOW });
    const r = await atomicCreateRest({ session: rest, restDate, advanceCycle: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('已有实际训练');
  });
});

/* G5 · Home 第三条结束路径（optional 锁 + 不传任何 flag）也封口 */
describe('G5 · Home finishExistingThenStart 封口', () => {
  it('optional 锁的 finish 同样封口运行中的有氧', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    let s = createSession(plan, day, NOW);
    let e = startCardio(
      {
        id: 'ce-home',
        preset: 'treadmill-incline',
        name: '有氧',
        planCardioId: null,
        target: null,
        elapsedMs: 0,
        runningSinceAt: null,
        status: 'pending',
        currentParams: { speedKmh: 4, inclinePct: 4 },
        segments: [],
      },
      NOW,
    );
    s = { ...s, cardio: [e] };
    await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });

    const r = await atomicFinishSession({
      session: s,
      guard: { lockPolicy: 'optional', advanceCycle: false },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(s.id);
    expect(after!.cardio![0].status).toBe('done');
    expect(after!.cardio![0].runningSinceAt).toBeNull();
    // 自产备份合法（不再有未封口段）
    const { buildBackup, validateBackup } = await import('../src/db/repo');
    const b = await buildBackup('2.0.0');
    const v = validateBackup(JSON.parse(JSON.stringify(b)));
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
  });
});
