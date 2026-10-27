/* 第2阶段 · finish 封口与草稿合并（场景 4 / 9 / 10）。

   ── 证据边界 ────────────────────────────────────────────────
   使用**真实 tx 事务 + 真实 fake-indexeddb**：
   · finish 在事务内以**库内 current** 结算有氧最后一段
   · 训练页与 Home 两条结束路径共用同一逻辑，且只推进一次
   · 有氧 entry 级三方合并（一边力量一边有氧保留双方；同一 entry 冲突拒绝） */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { getPlan, getSession, savePlan } from '../src/db/repo';
import { atomicFinishSession, atomicWriteSession } from '../src/db/tx';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import {
  commitCardioParams,
  createCardioEntry,
  liveElapsedMs,
  startCardio,
} from '../src/domain/cardio';
import { mergeCardioEntries, mergeDraftOntoFresh } from '../src/domain/draftMerge';
import type { CardioEntry, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
const M = 60_000;

beforeEach(async () => {
  __resetDbHandle();
  await idbClear('sessions');
  await idbClear('plans');
  await idbClear('meta');
  await idbClear('settings');
});

/** 建一条带运行中有氧的 active 训练（真实写入库） */
async function seedRunningCardio(now = NOW) {
  const plan = createV32Plan(now);
  await savePlan(plan);
  const day = plan.days.find((d) => d.kind === 'train')!;
  let s = createSession(plan, day, now);

  let e = createCardioEntry({
    preset: 'treadmill-incline',
    name: '有氧爬坡',
    params: { speedKmh: 4, inclinePct: 4 },
  });
  e = startCardio(e, now);
  const c = commitCardioParams(e, { speedKmh: 4, inclinePct: 12 }, now + 5 * M);
  if (c.ok) e = c.entry;

  s = { ...s, cardio: [e] };
  const r = await atomicWriteSession({
    intent: { kind: 'create' },
    session: s,
    lockPolicy: 'optional',
  });
  expect(r.ok).toBe(true);
  return { plan, session: s, entryId: e.id };
}

describe('场景4 · finish 在事务内结算最后一段', () => {
  it('运行中的有氧在结束时被封口，最后一段不丢', async () => {
    const { session, entryId } = await seedRunningCardio();
    const finishAt = NOW + 12 * M;

    const r = await atomicFinishSession({
      session: { ...session, endedAt: finishAt },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);

    const after = await getSession(session.id);
    expect(after!.status).toBe('completed');
    const ce = after!.cardio!.find((x) => x.id === entryId)!;
    // 已结算：不再 running，有效时长 = 5 分（改参）+ 7 分（改参后到结束）
    expect(ce.status).toBe('done');
    expect(ce.runningSinceAt).toBeNull();
    expect(ce.elapsedMs).toBe(12 * M);
    // 最后一段被封口
    expect(ce.segments.every((x) => x.endElapsedMs !== null)).toBe(true);
    const sum = ce.segments.reduce((n, x) => n + ((x.endElapsedMs ?? 0) - x.startElapsedMs), 0);
    expect(sum).toBe(12 * M);
  });

  it('paused 有氧：保留已有有效量并终结（不改时长）', async () => {
    const { session } = await seedRunningCardio();
    // 先把有氧改成 paused（模拟用户手动暂停）
    const paused: Session = {
      ...session,
      cardio: session.cardio!.map((c) => ({
        ...c,
        status: 'paused' as const,
        elapsedMs: 180000,
        runningSinceAt: null,
        segments: [{ ...c.segments[0], endElapsedMs: 180000 }],
      })),
    };
    await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: paused,
      lockPolicy: 'optional',
    });

    const r = await atomicFinishSession({
      session: { ...paused, endedAt: NOW + 20 * M },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(session.id);
    const ce = after!.cardio![0];
    // 时长不变（暂停保留已有有效量）
    expect(ce.elapsedMs).toBe(180000);
    expect(ce.status).toBe('done');
  });

  it('pending 有氧：不伪造时长', async () => {
    const { session } = await seedRunningCardio();
    const pending: Session = {
      ...session,
      cardio: session.cardio!.map((c) => ({
        ...c,
        status: 'pending' as const,
        elapsedMs: 0,
        runningSinceAt: null,
        segments: [],
      })),
    };
    await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: pending,
      lockPolicy: 'optional',
    });

    const r = await atomicFinishSession({
      session: { ...pending, endedAt: NOW + 30 * M },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(session.id);
    expect(after!.cardio![0].elapsedMs).toBe(0);
  });

  it('不接受调用方传入的 segments 冒充已保存事实（以库内 current 为准）', async () => {
    const { session, entryId } = await seedRunningCardio();
    // 调用方伪造一份"已经结算好"的 cardio
    const forged: Session = {
      ...session,
      endedAt: NOW + 12 * M,
      cardio: session.cardio!.map((c) => ({
        ...c,
        status: 'done' as const,
        elapsedMs: 999999999,
        runningSinceAt: null,
        segments: [{ id: 'fake', startElapsedMs: 0, endElapsedMs: 999999999, params: { speedKmh: 4, inclinePct: 4 } }],
      })),
    };
    const r = await atomicFinishSession({
      session: forged,
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(session.id);
    const ce = after!.cardio!.find((x) => x.id === entryId)!;
    // 用库内锚点结算 = 12 分钟，而不是伪造值
    expect(ce.elapsedMs).toBe(12 * M);
    expect(ce.elapsedMs).not.toBe(999999999);
  });
});

describe('场景9 · 两条结束路径只推进一次', () => {
  it('训练页结束 + 重复结束：只推进一次（终态幂等）', async () => {
    const { plan, session } = await seedRunningCardio();
    const before = (await getPlan(plan.id))!.cursor;

    const r1 = await atomicFinishSession({
      session: { ...session, endedAt: NOW + 12 * M },
      guard: { advanceCycle: true, lockPolicy: 'optional' },
    });
    expect(r1.ok).toBe(true);
    const cursorAfterFirst = (await getPlan(plan.id))!.cursor;
    expect(cursorAfterFirst).toBe((before + 1) % plan.days.length);

    // 重复结束（模拟 Home 的 finishExistingThenStart 又跑一次）
    const r2 = await atomicFinishSession({
      session: { ...session, endedAt: NOW + 13 * M },
      guard: { advanceCycle: true, lockPolicy: 'optional' },
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.alreadyTerminal).toBe(true);
    // 游标没有再动
    expect((await getPlan(plan.id))!.cursor).toBe(cursorAfterFirst);
  });

  it('首页结束旧训练路径也能封口有氧（同一 finalizeCardio）', async () => {
    const { session, entryId } = await seedRunningCardio();
    // Home 用 optional 锁 + advanceCycle:false
    const r = await atomicFinishSession({
      session: { ...session, endedAt: NOW + 10 * M },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(session.id);
    const ce = after!.cardio!.find((x) => x.id === entryId)!;
    expect(ce.status).toBe('done');
    expect(ce.elapsedMs).toBe(10 * M);
    expect(ce.segments.every((s) => s.endElapsedMs !== null)).toBe(true);
  });
});

describe('场景10 · 有氧 entry 级三方合并', () => {
  const baseEntry: CardioEntry = {
    id: 'ce-1',
    preset: 'treadmill-incline',
    name: '有氧爬坡',
    planCardioId: null,
    target: null,
    elapsedMs: 60000,
    runningSinceAt: null,
    status: 'paused',
    currentParams: { speedKmh: 4, inclinePct: 4 },
    segments: [{ id: 's1', startElapsedMs: 0, endElapsedMs: 60000, params: { speedKmh: 4, inclinePct: 4 } }],
  };

  it('一边改力量、一边改有氧 → 保留双方（非冲突）', () => {
    const conflicts: never[] = [];
    const merged = mergeCardioEntries({
      base: [baseEntry],
      mine: [{ ...baseEntry, elapsedMs: 120000 }],
      fresh: [baseEntry],
      conflicts: conflicts as never,
    });
    expect(merged).not.toBeNull();
    expect(merged![0].elapsedMs).toBe(120000);
    expect(conflicts).toHaveLength(0);
  });

  it('同一 entry 两边都改且不同 → 冲突拒绝', () => {
    const conflicts: Array<{ path: string; message: string }> = [];
    const merged = mergeCardioEntries({
      base: [baseEntry],
      mine: [{ ...baseEntry, elapsedMs: 120000 }],
      fresh: [{ ...baseEntry, elapsedMs: 180000 }],
      conflicts: conflicts as never,
    });
    expect(merged).toBeNull();
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it('同一 entry 两边改成相同结果 → 采用该值（非冲突）', () => {
    const conflicts: Array<{ path: string; message: string }> = [];
    const same = { ...baseEntry, elapsedMs: 150000 };
    const merged = mergeCardioEntries({
      base: [baseEntry],
      mine: [same],
      fresh: [{ ...same }],
      conflicts: conflicts as never,
    });
    expect(merged).not.toBeNull();
    expect(merged![0].elapsedMs).toBe(150000);
    expect(conflicts).toHaveLength(0);
  });

  it('不同 entry 各自改动 → 都保留', () => {
    const other: CardioEntry = { ...baseEntry, id: 'ce-2', name: '爬楼机', preset: 'stair-climber', currentParams: { level: 5 }, segments: [] };
    const conflicts: never[] = [];
    const merged = mergeCardioEntries({
      base: [baseEntry, other],
      mine: [{ ...baseEntry, elapsedMs: 120000 }, other],
      fresh: [baseEntry, { ...other, currentParams: { level: 8 } }],
      conflicts: conflicts as never,
    });
    expect(merged).not.toBeNull();
    expect(merged!.find((x) => x.id === 'ce-1')!.elapsedMs).toBe(120000);
    expect(merged!.find((x) => x.id === 'ce-2')!.currentParams.level).toBe(8);
    expect(conflicts).toHaveLength(0);
  });

  it('本页删除 + 别处修改 → 冲突（不静默删数据）', () => {
    const conflicts: Array<{ path: string; message: string }> = [];
    const merged = mergeCardioEntries({
      base: [baseEntry],
      mine: [],
      fresh: [{ ...baseEntry, elapsedMs: 180000 }],
      conflicts: conflicts as never,
    });
    expect(merged).toBeNull();
    expect(conflicts.length).toBeGreaterThan(0);
  });
});


/* G5：finish 封口不再依赖调用方传 flag。
   旧实现用可选 finalizeCardio，任何漏传的 UI 入口（如 Home 孤儿 active 列表）
   都会留下"终态但仍 running / 末段未封口"的损坏记录。 */
describe('G5 · 所有 finish 入口都封口（无可选 flag）', () => {
  it('完全不传任何 flag 也封口运行中的有氧', async () => {
    const { session, entryId } = await seedRunningCardio();
    // 只传最小参数（不传任何"是否封口"的 flag —— 旧实现会因此漏封口）
    const r = await atomicFinishSession({
      session: { ...session, endedAt: NOW + 12 * M },
      guard: { lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    const after = await getSession(session.id);
    const ce = after!.cardio!.find((x) => x.id === entryId)!;
    expect(ce.status).toBe('done');
    expect(ce.runningSinceAt).toBeNull();
    expect(ce.segments.every((x) => x.endElapsedMs !== null)).toBe(true);
    // 终态记录不再有 running（否则应用自产备份会被自己的校验拒绝）
    expect(after!.cardio!.some((x) => x.status === 'running')).toBe(false);
  });
});

/* G3：双 running / 超容量必须被**真实写入边界**拦住
   （旧实现只在渲染时 disabled，快速输入能写出无法恢复的自产备份）。 */
describe('G3 · 会话级有氧不变量的写入边界', () => {
  const mk = (id: string, status: CardioEntry['status']): CardioEntry => ({
    id,
    preset: 'treadmill-incline',
    name: '有氧',
    planCardioId: null,
    target: null,
    elapsedMs: status === 'running' ? 1000 : 0,
    runningSinceAt: status === 'running' ? Date.now() : null,
    status,
    currentParams: { speedKmh: 4, inclinePct: 4 },
    segments:
      status === 'running'
        ? [{ id: `${id}s`, startElapsedMs: 0, endElapsedMs: null, params: { speedKmh: 4, inclinePct: 4 } }]
        : [],
  });

  it('active 保存出现两个 running → 拒绝且不落库', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    const single = { ...base, cardio: [mk('a', 'running')] };
    const created = await atomicWriteSession({
      intent: { kind: 'create' },
      session: single,
      lockPolicy: 'optional',
    });
    expect(created.ok).toBe(true);

    const double = { ...single, cardio: [mk('a', 'running'), mk('b', 'running')] };
    const bad = await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: double,
      editorId: 'e',
      expectedRevision: 1,
      lockPolicy: 'optional',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('一个');
    // 库里仍是单项
    const after = await getSession(base.id);
    expect(after!.cardio).toHaveLength(1);
  });

  it('超过 8 项 → 领域 addCardioToSession 拒绝（返回 null）', async () => {
    const { addCardioToSession } = await import('../src/domain/session');
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.kind === 'train')!;
    let s = createSession(plan, day, NOW);
    for (let i = 0; i < 8; i += 1) s = { ...s, cardio: [...(s.cardio ?? []), mk(`e${i}`, 'pending')] };
    expect(addCardioToSession(s, mk('overflow', 'pending'))).toBeNull();
    expect(s.cardio).toHaveLength(8);
  });

  it('两个 running 的记录被自产备份校验拒绝（证明不变量意义）', async () => {
    const { buildBackup } = await import('../src/db/repo');
    const { validateBackup } = await import('../src/db/repo');
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    // 强制塞进库（绕过 active-save 边界，模拟损坏数据）以证明校验会拒绝
    const { idbPut } = await import('../src/db/idb');
    await idbPut('sessions', { ...base, cardio: [mk('a', 'running'), mk('b', 'running')] });
    const b = await buildBackup('2.0.0');
    expect(validateBackup(JSON.parse(JSON.stringify(b))).ok).toBe(false);
  });
});

/* G4b · 合并保留 cardioPausedBySession（整次暂停来源不被 fresh 清空）。
   与 Codex draft-loss-evidence 同一语义：不能只靠镜像 helper，走真实 mergeDraftOntoFresh。 */
describe('G4b · 合并保留暂停来源', () => {
  const ce = (id: string, status: CardioEntry['status'], extra: Partial<CardioEntry> = {}): CardioEntry => ({
    id,
    preset: 'stair-climber',
    name: '爬楼',
    planCardioId: null,
    target: null,
    elapsedMs: 60000,
    runningSinceAt: status === 'running' ? 1 : null,
    status,
    currentParams: { level: 5 },
    segments:
      status === 'running'
        ? [{ id: `${id}-s`, startElapsedMs: 0, endElapsedMs: null, params: { level: 5 } }]
        : [{ id: `${id}-s`, startElapsedMs: 0, endElapsedMs: 60000, params: { level: 5 } }],
    ...extra,
  });
  const plan = createV32Plan(1);
  const day = plan.days.find((d) => d.kind === 'train')!;
  const base = createSession(plan, day, 1);

  it('mine 自动暂停 + fresh 仅改力量 → 暂停来源仍保留', () => {
    const baseS = { ...base, cardio: [ce('c1', 'running')], cardioPausedBySession: [] };
    const mine = { ...baseS, cardio: [ce('c1', 'paused')], cardioPausedBySession: ['c1'] };
    const fresh = { ...baseS, cardio: [ce('c1', 'running')], note: '别人加的备注' };
    const r = mergeDraftOntoFresh(baseS, mine, fresh, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.cardio?.[0].status).toBe('paused');
    expect(r.session.cardioPausedBySession).toEqual(['c1']);
    expect(r.session.note).toBe('别人加的备注'); // 别处力量备注仍在
  });

  it('两边都改暂停来源且不同 → 冲突拒绝（不拼假时间线）', () => {
    const baseS = { ...base, cardio: [ce('c1', 'running'), ce('c2', 'running')], cardioPausedBySession: [] };
    const mine = { ...baseS, cardioPausedBySession: ['c1'] };
    const fresh = { ...baseS, cardioPausedBySession: ['c2'] };
    const r = mergeDraftOntoFresh(baseS, mine, fresh, null);
    expect(r.ok).toBe(false);
  });
});

/* G1 · 普通 create 反向互斥：同日已有 rest 必须先撤销才能开练。 */
describe('G1 · 撤销休息后同一天才能开练', () => {
  it('rest 在库 → 力量 create 被拒；撤销后成功', async () => {
    const { createRestSession } = await import('../src/domain/session');
    const { localDateKey } = await import('../src/domain/localDate');
    const { atomicCreateRest, atomicDeleteRest } = await import('../src/db/tx');
    const plan = createV32Plan(1);
    await savePlan(plan);
    const rd = localDateKey(1);
    const rest = createRestSession({ plan, restDate: rd, origin: 'temporary', now: 1 });
    expect((await atomicCreateRest({ session: rest, restDate: rd, advanceCycle: false })).ok).toBe(true);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const s = createSession(plan, day, 1);
    expect((await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' })).ok).toBe(false);
    expect((await atomicDeleteRest({ session: rest, restDate: rd })).ok).toBe(true);
    expect((await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' })).ok).toBe(true);
  });
});

/* REVIEW-2 #2 · 终态不得残留运行痕迹 */
describe('REVIEW-2 #2 · 终态备份拒绝 running / 锚点 / 未封口段', () => {
  const entry = (over: Partial<CardioEntry>): CardioEntry => ({
    id: 'ce-t',
    preset: 'treadmill-incline',
    name: '有氧',
    planCardioId: null,
    target: null,
    elapsedMs: 30000,
    runningSinceAt: null,
    status: 'done',
    currentParams: { speedKmh: 4, inclinePct: 4 },
    segments: [{ id: 'sg-t', startElapsedMs: 0, endElapsedMs: 30000, params: { speedKmh: 4, inclinePct: 4 } }],
    ...over,
  });

  async function seedTerminal(kind: 'completed' | 'discarded', ce: CardioEntry) {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    // 直接种入终态记录（模拟损坏数据），验证备份校验拒绝
    const { idbPut } = await import('../src/db/idb');
    await idbPut('sessions', {
      ...base,
      kind: 'strength',
      status: kind,
      endedAt: NOW + 60000,
      cardio: [ce],
    });
    const { buildBackup, validateBackup } = await import('../src/db/repo');
    const b = await buildBackup('2.0.0');
    return validateBackup(JSON.parse(JSON.stringify(b)));
  }

  it('completed + running → 拒绝', async () => {
    const v = await seedTerminal('completed', entry({ status: 'running', runningSinceAt: NOW, segments: [{ id: 's', startElapsedMs: 0, endElapsedMs: null, params: { speedKmh: 4, inclinePct: 4 } }] }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect((v as { issues?: Array<{ path: string }> }).issues?.some((i) => i.path.includes('status'))).toBe(true);
  });

  it('discarded + 残留运行锚点 → 拒绝', async () => {
    const v = await seedTerminal('discarded', entry({ status: 'paused', runningSinceAt: NOW }));
    expect(v.ok).toBe(false);
  });

  it('discarded + 未封口末段 → 拒绝', async () => {
    const v = await seedTerminal('discarded', entry({ status: 'paused', segments: [{ id: 's', startElapsedMs: 0, endElapsedMs: null, params: { speedKmh: 4, inclinePct: 4 } }] }));
    expect(v.ok).toBe(false);
  });

  it('合法终态（done+封口段）与 pending（无时长/无开段）→ 接受', async () => {
    const okDone = await seedTerminal('completed', entry({}));
    expect(okDone.ok).toBe(true);
    const okPending = await seedTerminal('completed', entry({ status: 'pending', elapsedMs: 0, segments: [] }));
    expect(okPending.ok).toBe(true);
  });
});

/* REVIEW-2 #2 · discard 在公共事务里封口，保留已做的真实量 */
describe('REVIEW-2 #2 · atomicDiscardSession 封口', () => {
  it('放弃时运行中的有氧被封口：有效量停止增长、锚点清空、段封口；旧真实内容保留', async () => {
    const { atomicDiscardSession } = await import('../src/db/tx');
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    let s = createSession(plan, day, NOW);
    let e = startCardio(
      {
        id: 'ce-d',
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
    // 力量部分写入真实内容（放弃不清空真实数据）
    const first = s.exercises[0].sets[0];
    s = {
      ...s,
      cardio: [e],
      exercises: s.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st) => (st.id === first.id ? { ...st, reps: 10, weightKg: 60, status: 'done' as const } : st)) } : ex,
      ),
    };
    const created = await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });
    expect(created.ok).toBe(true);

    const terminalAt = NOW + 30000; // 放弃时刻：有效 30 秒
    const r = await atomicDiscardSession({
      session: { ...s, endedAt: terminalAt },
      guard: { lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);

    const after = await getSession(s.id);
    expect(after!.status).toBe('discarded');
    const ce = after!.cardio![0];
    expect(ce.status).toBe('done');
    expect(ce.runningSinceAt).toBeNull();
    expect(ce.elapsedMs).toBe(30000);
    expect(ce.segments.every((x) => x.endElapsedMs !== null)).toBe(true);
    // 真实力量内容保留
    expect(after!.exercises[0].sets.some((x) => x.reps === 10 && x.weightKg === 60)).toBe(true);

    // 自产备份通过终态校验（不再被拒绝）
    const { buildBackup, validateBackup } = await import('../src/db/repo');
    const b = await buildBackup('2.0.0');
    const v = validateBackup(JSON.parse(JSON.stringify(b)));
    expect(v.ok, v.ok ? '' : JSON.stringify((v as { issues?: unknown[] }).issues ?? (v as { error?: string }).error)).toBe(true);

    // 再等 60 秒：终态记录计时不增长（锚点已清、elapsed 冻结在放弃时刻）
    expect(liveElapsedMs(ce, terminalAt + 60000)).toBe(30000);
  });

  it('discard 不接受调用方伪造的旧候选段（以库内 current 封口）', async () => {
    const { atomicDiscardSession } = await import('../src/db/tx');
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const base = createSession(plan, day, NOW);
    const running: CardioEntry = {
      id: 'ce-fake',
      preset: 'stair-climber',
      name: '爬楼',
      planCardioId: null,
      target: null,
      elapsedMs: 5000,
      runningSinceAt: NOW,
      status: 'running',
      currentParams: { level: 8 },
      segments: [{ id: 'sg', startElapsedMs: 0, endElapsedMs: null, params: { level: 8 } }],
    };
    const s = { ...base, cardio: [running] };
    await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });

    // 调用方伪造"已经结算好"的段
    const forged = {
      ...s,
      endedAt: NOW + 30000,
      cardio: [{ ...running, status: 'done' as const, elapsedMs: 999999, segments: [{ id: 'fake', startElapsedMs: 0, endElapsedMs: 999999, params: { level: 8 } }] }],
    };
    const r = await atomicDiscardSession({ session: forged, guard: { lockPolicy: 'optional' } });
    expect(r.ok).toBe(true);
    const after = await getSession(s.id);
    // 以库内 current（elapsed 5000 + 锚点 NOW → NOW+30000）= 35000 结算，不是 999999
    expect(after!.cardio![0].elapsedMs).toBe(35000);
    expect(after!.cardio![0].segments).toHaveLength(1);
    expect(after!.cardio![0].segments[0].id).toBe('sg');
  });

  it('discard 终态幂等：重复放弃不再写、不封口新时刻', async () => {
    const { atomicDiscardSession } = await import('../src/db/tx');
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const day = plan.days.find((d) => d.kind === 'train')!;
    const s = createSession(plan, day, NOW);
    await atomicWriteSession({ intent: { kind: 'create' }, session: s, lockPolicy: 'optional' });
    const r1 = await atomicDiscardSession({ session: { ...s, endedAt: NOW + 1000 }, guard: { lockPolicy: 'optional' } });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const rev1 = r1.revision;
    const r2 = await atomicDiscardSession({ session: { ...s, endedAt: NOW + 99999 }, guard: { lockPolicy: 'optional' } });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.alreadyTerminal).toBe(true);
    expect(r2.revision).toBe(rev1);
    const after = await getSession(s.id);
    expect(after!.endedAt).toBe(NOW + 1000); // 第二次不再改时刻
  });
});
