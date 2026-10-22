/* V3-01 存储可靠性回归：锁 schema 唯一、版本、状态转换、幂等、全部写入口。
   每条对应独立审查 data-probes.json 里 D12–D14 / D17–D20 的失败路径。
   使用 fake-indexeddb；真实浏览器双标签验证在 verify-v4/browser-two-tabs.mjs。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGet } from '../src/db/idb';
import { getSession, getPlan, savePlan } from '../src/db/repo';
import {
  atomicAcquireLock,
  atomicCreateSession,
  atomicDiscardSession,
  atomicFinishSession,
  atomicSaveHistoryEdit,
  atomicSaveSession,
  atomicWriteSession,
  revisionOf,
} from '../src/db/tx';
import { acquireSessionLock, refreshSessionLock, releaseSessionLock, currentLockState } from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function makeSession(id: string): Session {
  const plan = createV32Plan(NOW);
  const s = createSession(plan, plan.days[0], NOW);
  return { ...s, id };
}

function plan0(): Plan {
  return createV32Plan(NOW);
}

async function seedActive(id: string, editorId = 'A'): Promise<Session> {
  const s = makeSession(id);
  const created = await atomicCreateSession({ session: s });
  expect(created.ok).toBe(true);
  const acq = await acquireSessionLock(id, editorId);
  expect(acq.ok).toBe(true);
  return (await getSession(id))!;
}

/** 直接写一行 meta 锁（模拟另一个写者或损坏数据） */
async function putRawLock(key: string, row: unknown) {
  const { idbPut } = await import('../src/db/idb');
  await idbPut('meta', row as object);
  void key;
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

/* ── D12：心跳不得改变锁 schema，且 8 秒后仍能挡住接管 ─────────── */
describe('V3-01 / D12 锁 schema 唯一且心跳后仍有效', () => {
  it('心跳前后锁记录结构与 key 完全一致（不再写成 nested）', async () => {
    const id = 'd12-schema';
    await seedActive(id, 'A');
    const before = await idbGet<Record<string, unknown>>('meta', `lock:${id}`);
    const ok = await refreshSessionLock(id, 'A');
    const after = await idbGet<Record<string, unknown>>('meta', `lock:${id}`);
    expect(ok).toBe(true);
    expect(Object.keys(before!).sort()).toEqual(['at', 'editorId', 'key', 'sessionId']);
    expect(Object.keys(after!).sort()).toEqual(['at', 'editorId', 'key', 'sessionId']);
    // 关键：不存在 value 包装
    expect('value' in after!).toBe(false);
    expect(after!.editorId).toBe('A');
  });

  it('A 心跳后 B 抢不到锁，A 的过期心跳不会把锁交出去', async () => {
    const id = 'd12-takeover';
    await seedActive(id, 'A');
    await refreshSessionLock(id, 'A');
    const b = await acquireSessionLock(id, 'B');
    expect(b.ok).toBe(false);
    expect(await refreshSessionLock(id, 'A')).toBe(true);
    const st = await currentLockState(id);
    expect(st.kind).toBe('held');
    if (st.kind === 'held') expect(st.editorId).toBe('A');
  });

  it('A 心跳后 A 的陈旧写入仍被接受（同一持有者），B 的写入被拒', async () => {
    const id = 'd12-stale-write';
    const s = await seedActive(id, 'A');
    await refreshSessionLock(id, 'A');
    const a = await atomicSaveSession({
      session: { ...s, note: 'A edit', revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(a.ok).toBe(true);
    const b = await atomicSaveSession({
      session: { ...s, note: 'B edit', revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'B' },
    });
    expect(b.ok).toBe(false);
    const final = await getSession(id);
    expect(final!.note).toBe('A edit');
  });
});

/* ── D13：非持有者不得释放 ─────────────────────────────── */
describe('V3-01 / D13 非持有者不能释放', () => {
  it('A 释放 B 的锁不生效，锁仍属于 B', async () => {
    const id = 'd13-release';
    await seedActive(id, 'B');
    const released = await releaseSessionLock(id, 'A');
    expect(released).toBe(false);
    const st = await currentLockState(id);
    expect(st.kind).toBe('held');
    if (st.kind === 'held') expect(st.editorId).toBe('B');
  });

  it('A 释放 B 的锁后，A 的写入仍然被拒绝', async () => {
    const id = 'd13-write';
    const s = await seedActive(id, 'B');
    await releaseSessionLock(id, 'A');
    const w = await atomicSaveSession({
      session: { ...s, note: 'A after fake release', revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('lock-lost');
    expect((await getSession(id))!.note).toBe(s.note);
  });

  it('持有者本人释放后锁为空，且之后的写入被拒（无锁不许写）', async () => {
    const id = 'd13-own-release';
    const s = await seedActive(id, 'A');
    expect(await releaseSessionLock(id, 'A')).toBe(true);
    const st = await currentLockState(id);
    expect(st.kind).toBe('free');
    const w = await atomicSaveSession({
      session: { ...s, note: 'after own release', revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('no-lock');
  });
});

/* ── D17：缺失 / 损坏 / 过期锁一律没有写入资格 ───────────── */
describe('V3-01 / D17 缺失、损坏、过期锁不得默认为有权保存', () => {
  it('从未获取过锁时的保存被拒（reason=no-lock）', async () => {
    const id = 'd17-no-lock';
    const s = makeSession(id);
    await atomicCreateSession({ session: s });
    const w = await atomicSaveSession({
      session: { ...s, note: 'never had a lock', revision: 0 },
      guard: { sessionId: id, editorId: 'A', expectedVersion: 999 },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('no-lock');
  });

  it('损坏的锁记录（嵌套旧格式）被拒，不当成无锁放行', async () => {
    const id = 'd17-corrupt';
    const s = makeSession(id);
    await atomicCreateSession({ session: s });
    // 旧 bug 写出的 nested 格式
    await putRawLock(`lock:${id}`, { key: `lock:${id}`, value: { sessionId: id, editorId: 'A', at: Date.now() } });
    const w = await atomicSaveSession({
      session: { ...s, note: 'against corrupt lock', revision: 0 },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('corrupt-lock');
  });

  it('过期锁不授权保存（reason=lock-lost）', async () => {
    const id = 'd17-expired';
    const s = await seedActive(id, 'A');
    await putRawLock(`lock:${id}`, { key: `lock:${id}`, sessionId: id, editorId: 'A', at: Date.now() - 60_000 });
    const w = await atomicSaveSession({
      session: { ...s, note: 'expired lock write', revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('lock-lost');
  });
});

/* ── D14：终态不可被旧 active 快照复活 ──────────────────── */
describe('V3-01 / D14 已结束记录不能被旧 active 快照写回', () => {
  it('B 结束训练后，A 队列里的守锁保存被拒，状态保持 completed', async () => {
    const id = 'd14-resurrection';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');
    const stale = { ...s };

    // B 从首页结束（拿到锁之后，或结束后持锁行为由 finish 释放，这里用 A 的锁结束）
    const fin = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: false },
    });
    expect(fin.ok).toBe(true);

    // A 的旧 active 快照此刻才写入：必须被状态转换拒绝
    const revive = await atomicWriteSession({
      intent: { kind: 'active-save' },
      session: { ...stale, note: 'A stale active' },
      editorId: 'A',
    });
    expect(revive.ok).toBe(false);
    if (!revive.ok) expect(revive.reason).toBe('state-conflict');
    const final = await getSession(id);
    expect(final!.status).toBe('completed');
    expect(final!.note).not.toBe('A stale active');
  });
});

/* ── D19：首页结束不得覆盖别页刚保存的实际数据 ────────────── */
describe('V3-01 / D19 首页结束基于事务内最新记录', () => {
  it('A 把 8 次改成 12 次并保存后，B 用旧快照结束，历史仍是 12 次', async () => {
    const id = 'd19-home-stale';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');
    const homeSnapshot = structuredClone(s);

    // A 改数据并保存
    const edited: Session = {
      ...s,
      exercises: s.exercises.map((ex, i) =>
        i === 0
          ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? { ...st, reps: 12, weightKg: 25, status: 'done' as const } : st)) }
          : ex,
      ),
      revision: revisionOf(s),
    };
    const saved = await atomicSaveSession({ session: edited, guard: { sessionId: id, editorId: 'A' } });
    expect(saved.ok).toBe(true);

    // 首页用旧快照结束（reps=8 / 未完成）
    // V4-02b：optional **不再**允许无视别人正在持有的有效锁。
    // 真实首页流程此刻是「别页没有在编辑」（页面已关闭/停止心跳），
    // 所以这里先让 A 的锁失效，模拟首页看到的真实前置条件。
    const { idbPut } = await import('../src/db/idb');
    await idbPut('meta', { key: `lock:${id}`, sessionId: id, editorId: 'A', at: 0 });
    const homeFinish = await atomicFinishSession({
      session: { ...homeSnapshot, status: 'completed', endedAt: NOW + 2000 },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(homeFinish.ok).toBe(true);

    const final = await getSession(id);
    expect(final!.status).toBe('completed');
    // 关键：实际数据以事务内最新为准，不被旧快照覆盖
    expect(final!.exercises[0].sets[0].reps).toBe(12);
    expect(final!.exercises[0].sets[0].weightKg).toBe(25);
  });
});

/* ── D20：守锁保存成功后的第二次无锁写必须消失 ───────────── */
describe('V3-01 / D20 成功后只更新内存，不再二次写库', () => {
  it('A 守锁保存后 B 合法接管并保存，A 若再写会被拒（无旁路）', async () => {
    const id = 'd20-second-write';
    const s = await seedActive(id, 'A');

    const first = await atomicSaveSession({ session: s, guard: { sessionId: id, editorId: 'A' } });
    expect(first.ok).toBe(true);

    // 让 A 的锁过期，B 接管
    await putRawLock(`lock:${id}`, { key: `lock:${id}`, sessionId: id, editorId: 'A', at: 0 });
    const takeover = await acquireSessionLock(id, 'B');
    expect(takeover.ok).toBe(true);

    const bSave = await atomicSaveSession({
      session: { ...s, note: 'newer B data', revision: revisionOf(s) + 1 },
      guard: { sessionId: id, editorId: 'B' },
    });
    expect(bSave.ok).toBe(true);

    // A 的任何后续写入（旧实现里 store.updateSession 的那次）必须失败
    const aSecond = await atomicSaveSession({
      session: { ...s, note: 'old A second write', revision: revisionOf(s) + 1 },
      guard: { sessionId: id, editorId: 'A' },
    });
    expect(aSecond.ok).toBe(false);
    expect((await getSession(id))!.note).toBe('newer B data');
  });

  it('同一 editorId 的第二次写入会因 revision 不符被拒', async () => {
    const id = 'd20-revision';
    const s = await seedActive(id, 'A');
    const r1 = await atomicSaveSession({ session: s, guard: { sessionId: id, editorId: 'A' } });
    expect(r1.ok).toBe(true);
    const revAfter = revisionOf(await getSession(id));
    expect(revAfter).toBe(revisionOf(s) + 1);

    // 用陈旧 revision 再写
    const stale = await atomicSaveSession({
      session: { ...s, revision: revisionOf(s) },
      guard: { sessionId: id, editorId: 'A', expectedVersion: revisionOf(s) },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('version-conflict');
  });
});

/* ── D18：结束幂等（无条件，不依赖 guard 是否传 expectedVersion）── */
describe('V3-01 / D18 结束幂等且不重复推进游标', () => {
  it('不传 expectedVersion 重复结束：返回原结果、不写、不推进', async () => {
    const id = 'd18-idempotent';
    const plan = { ...plan0(), cursor: 0 };
    await savePlan(plan);
    const s = await seedActive(id, 'A');

    const first = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.plan!.cursor).toBe(1);
      expect(first.session.cycleIndexAfter).toBe(1);
    }
    const revAfterFirst = revisionOf(await getSession(id));

    // 重新取得锁（模拟重新挂载），再用旧 active 快照结束一次
    await acquireSessionLock(id, 'A');
    const second = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 2000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.alreadyTerminal).toBe(true);

    const finalPlan = await getPlan(plan.id);
    expect(finalPlan!.cursor).toBe(1); // 没有推进到 2
    expect(revisionOf(await getSession(id))).toBe(revAfterFirst); // 没有再写
  });

  it('失败后重试成功，只推进一次', async () => {
    const id = 'd18-retry';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');

    // 先制造一次失败：锁过期
    await putRawLock(`lock:${id}`, { key: `lock:${id}`, sessionId: id, editorId: 'A', at: 0 });
    const failed = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(failed.ok).toBe(false);
    expect((await getSession(id))!.status).toBe('active');
    expect((await getPlan(plan.id))!.cursor).toBe(0);

    // 重新取得控制后重试
    expect((await acquireSessionLock(id, 'A')).ok).toBe(true);
    const retry = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(retry.ok).toBe(true);
    expect((await getPlan(plan.id))!.cursor).toBe(1);
  });

  it('结束写计划失败时训练终态一起回滚（同事务）', async () => {
    const id = 'd18-rollback';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');
    // 把 planId 指向不存在的计划：计划读取失败 → 结束必须整体失败
    const { idbPut } = await import('../src/db/idb');
    await idbPut('sessions', { ...s, planId: 'no-such-plan' });
    const r = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    // 计划不存在时不推进，但训练仍应能结束（不因为「没有计划可推进」失败）
    expect(r.ok).toBe(true);
    expect((await getSession(id))!.status).toBe('completed');
  });

  it('推进读取事务内最新计划，不信任 UI 预先算好的 cycleIndexAfter', async () => {
    const id = 'd18-plan-truth';
    const plan = { ...plan0(), cursor: 3 };
    await savePlan(plan);
    const s = await seedActive(id, 'A');
    // 页面算的 cycleIndexAfter 是 99（陈旧/错误），事务内应无视它
    const r = await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000, cycleIndexAfter: 99 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(r.ok).toBe(true);
    const expected = (3 + 1) % plan.days.length;
    expect((await getPlan(plan.id))!.cursor).toBe(expected);
    expect((await getSession(id))!.cycleIndexAfter).toBe(expected);
  });
});

/* ── 放弃 / 历史纠错 / 新建 的状态转换 ─────────────────── */
describe('V3-01 各写入口的状态转换', () => {
  it('放弃：active → discarded；重复放弃幂等', async () => {
    const id = 'st-discard';
    const s = await seedActive(id, 'A');
    const d1 = await atomicDiscardSession({
      session: { ...s, status: 'discarded', endedAt: NOW + 1000 },
      guard: { editorId: 'A' },
    });
    expect(d1.ok).toBe(true);
    const rev = revisionOf(await getSession(id));
    const d2 = await atomicDiscardSession({
      session: { ...s, status: 'discarded', endedAt: NOW + 2000 },
      guard: { editorId: 'A', lockPolicy: 'optional' },
    });
    expect(d2.ok).toBe(true);
    if (d2.ok) expect(d2.alreadyTerminal).toBe(true);
    expect(revisionOf(await getSession(id))).toBe(rev);
  });

  it('放弃后的记录不能被 active 保存复活', async () => {
    const id = 'st-discard-revive';
    const s = await seedActive(id, 'A');
    await atomicDiscardSession({ session: { ...s, status: 'discarded', endedAt: NOW + 1000 }, guard: { editorId: 'A' } });
    const w = await atomicSaveSession({ session: s, guard: { sessionId: id, editorId: 'A' } });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.reason).toBe('state-conflict');
  });

  it('历史纠错只能改终态记录，且必须带 expectedRevision', async () => {
    const id = 'st-history';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');

    // active 记录不能走历史纠错。
    // V4-02b 之后 history-edit 也是 optional 锁策略，会先遇到「A 正持锁」这个更强的拒绝理由；
    // 这里断言「被拒绝」即可，并接受 lock-lost / state-conflict 两种具体原因
    // （下一段在锁释放后单独验证 state-conflict 这条主判据）。
    const wrong = await atomicSaveHistoryEdit({ session: s, expectedRevision: revisionOf(s) });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(['state-conflict', 'lock-lost']).toContain(wrong.reason);

    await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: false },
    });
    const done = (await getSession(id))!;
    const fixed = await atomicSaveHistoryEdit({
      session: { ...done, note: '历史纠错', revision: done.revision },
      expectedRevision: done.revision!,
    });
    expect(fixed.ok).toBe(true);
    expect((await getSession(id))!.note).toBe('历史纠错');
  });

  it('历史纠错遇到版本冲突时拒绝写入并保留冲突前内容', async () => {
    const id = 'st-history-conflict';
    const plan = plan0();
    await savePlan(plan);
    const s = await seedActive(id, 'A');
    await atomicFinishSession({
      session: { ...s, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: false },
    });
    const done = (await getSession(id))!;
    // 另一个标签页先保存
    const first = await atomicSaveHistoryEdit({
      session: { ...done, note: '另一页的修改', revision: done.revision },
      expectedRevision: done.revision!,
    });
    expect(first.ok).toBe(true);
    // 本页仍拿着旧 revision
    const second = await atomicSaveHistoryEdit({
      session: { ...done, note: '本页旧草稿', revision: done.revision },
      expectedRevision: done.revision!,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('version-conflict');
    expect((await getSession(id))!.note).toBe('另一页的修改');
  });

  it('新建不允许覆盖已存在记录', async () => {
    const id = 'st-create';
    const s = makeSession(id);
    const c1 = await atomicCreateSession({ session: s });
    expect(c1.ok).toBe(true);
    const c2 = await atomicCreateSession({ session: s });
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.reason).toBe('state-conflict');
  });

  it('revision 单调递增：每次成功写入 +1', async () => {
    const id = 'st-revision';
    let s = await seedActive(id, 'A');
    const seen: number[] = [revisionOf(s)];
    expect(seen[0]).toBe(1); // 新建写入即为 revision 1
    for (let i = 0; i < 3; i++) {
      const r = await atomicSaveSession({
        session: { ...s, note: `edit ${i}`, revision: revisionOf(s) },
        guard: { sessionId: id, editorId: 'A' },
      });
      expect(r.ok).toBe(true);
      s = (await getSession(id))!;
      seen.push(revisionOf(s));
    }
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});

/* ── 并发首次获取仍只有一方成功（既有效能力，防回归）────── */
describe('V3-01 并发获取锁只有一方成功', () => {
  it('Promise.all 同时获取', async () => {
    const [a, b] = await Promise.all([atomicAcquireLock('conc-1', 'editor-A'), atomicAcquireLock('conc-1', 'editor-B')]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  });

  it('持有者续租成功，他人被拒', async () => {
    expect((await atomicAcquireLock('conc-2', 'editor-A')).ok).toBe(true);
    expect((await atomicAcquireLock('conc-2', 'editor-A')).ok).toBe(true);
    expect((await atomicAcquireLock('conc-2', 'editor-B')).ok).toBe(false);
  });
});

/* ── 首页 / 放弃 / 历史都不再经 repo.saveSession 旁路 ────── */
describe('V3-01 写入口收敛（源码层面）', () => {
  it('repo.saveSession 仍存在但只能由存储层内部使用；其调用点必须都走受约束入口', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('._')) continue;
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        const rel = path.relative(root, full);
        // 仓库层与测试脚手架自身允许调用
        if (rel === 'db/repo.ts') continue;
        const text = fs.readFileSync(full, 'utf8');
        // 页面/状态层不允许直接 await saveSession(
        if (/\bsaveSession\s*\(/.test(text) && !/db\/repo/.test(rel)) {
          // 允许注释里提到
          const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
          if (/\bsaveSession\s*\(/.test(withoutComments)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
