/* V4-01 回归：结束成功必须等事务真正提交。
   审查 V4D12 的证据是「在 sessions.put 的 request success 之后、事务 commit 之前注入 abort」，
   此时 IndexedDB 整体回滚，但旧实现已经提前返回 ok:true，调用方据此更新内存与导航。
   本文件用真实的 request/transaction 事件注入复现这条路径，不是同步 throw。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGet } from '../src/db/idb';
import { getPlan, getSession, savePlan, saveSession } from '../src/db/repo';
import {
  atomicAcquireLock,
  atomicDiscardSession,
  atomicFinishSession,
  atomicSaveSession,
  revisionOf,
} from '../src/db/tx';
import { acquireSessionLock } from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function makeSession(id: string): Session {
  const plan = createV32Plan(NOW);
  return { ...createSession(plan, plan.days[0], NOW), id };
}

/**
 * 在指定 store 的 put 请求 success 之后、事务提交之前注入 abort。
 * 这是审查 V4D12 用的同一种故障注入：单个 request 已成功，但整个事务失败。
 */
function injectAbortAfterPutSuccess(storeName: string, times = 1) {
  const origPut = IDBObjectStore.prototype.put;
  let remaining = times;
  let aborted = 0;
  IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, ...args: unknown[]) {
    const req = (origPut as (...a: unknown[]) => IDBRequest).apply(this, args);
    if (this.name === storeName && remaining > 0) {
      remaining -= 1;
      const tx = this.transaction;
      req.addEventListener('success', () => {
        // request 已经成功，但事务还没提交：这正是不该提前返回成功的时刻
        try {
          tx.abort();
          aborted += 1;
        } catch {
          /* 事务可能已经提交，忽略 */
        }
      });
    }
    return req;
  } as typeof IDBObjectStore.prototype.put;
  return {
    restore: () => {
      IDBObjectStore.prototype.put = origPut;
    },
    get aborted() {
      return aborted;
    },
  };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

async function seedActive(id: string, editorId = 'A'): Promise<{ plan: Plan; session: Session }> {
  const plan = createV32Plan(NOW);
  await savePlan(plan);
  const session = makeSession(id);
  await saveSession({ ...session, planId: plan.id });
  const acq = await acquireSessionLock(id, editorId);
  expect(acq.ok).toBe(true);
  return { plan, session: (await getSession(id))! };
}

/* ── V4D12：结束分支在 put success 后 abort ─────────────────── */
describe('V4-01 结束成功必须等事务提交', () => {
  it('sessions.put success 后 abort：返回失败，训练仍 active，计划不推进', async () => {
    const id = 'v5-finish-abort';
    const { plan, session } = await seedActive(id, 'A');
    const cursorBefore = (await getPlan(plan.id))!.cursor;

    const guard = injectAbortAfterPutSuccess('sessions');
    let result;
    try {
      result = await atomicFinishSession({
        session: { ...session, status: 'completed', endedAt: NOW + 1000, revision: revisionOf(session) },
        guard: { sessionId: id, editorId: 'A', advanceCycle: true },
      });
    } finally {
      guard.restore();
    }

    const after = await getSession(id);
    const planAfter = await getPlan(plan.id);

    // 核心断言：绝不能在提交失败时返回 ok
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('storage');
    // 数据整体回滚
    expect(guard.aborted).toBe(1);
    expect(after!.status).toBe('active');
    expect(after!.endedAt).toBeNull();
    expect(planAfter!.cursor).toBe(cursorBefore);
    // 锁没有被"结束清理"提前写掉（同事务提交才有释放）
    const lock = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lock!.editorId).toBe('A');
  });

  it('结束提交失败后重试可成功，且只推进一次游标', async () => {
    const id = 'v5-finish-abort-retry';
    const { plan, session } = await seedActive(id, 'A');
    const cursorBefore = (await getPlan(plan.id))!.cursor;

    const guard = injectAbortAfterPutSuccess('sessions');
    const failed = await (async () => {
      try {
        return await atomicFinishSession({
          session: { ...session, status: 'completed', endedAt: NOW + 1000 },
          guard: { sessionId: id, editorId: 'A', advanceCycle: true },
        });
      } finally {
        guard.restore();
      }
    })();
    expect(failed.ok).toBe(false);
    expect((await getSession(id))!.status).toBe('active');

    // 重试：锁还在（同事务回滚），直接再结束一次
    const retry = await atomicFinishSession({
      session: { ...(await getSession(id))!, status: 'completed', endedAt: NOW + 1000, revision: revisionOf(await getSession(id)) },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(retry.ok).toBe(true);
    expect((await getSession(id))!.status).toBe('completed');

    const expected = (cursorBefore + 1) % plan.days.length;
    expect((await getPlan(plan.id))!.cursor).toBe(expected);

    // 再结束一次（幂等）：仍不重复推进
    await acquireSessionLock(id, 'A');
    const third = await atomicFinishSession({
      session: { ...(await getSession(id))!, status: 'completed', endedAt: NOW + 2000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.alreadyTerminal).toBe(true);
    expect((await getPlan(plan.id))!.cursor).toBe(expected);
  });

  it('plans.put success 后 abort：训练终态与计划推进一起回滚', async () => {
    const id = 'v5-finish-plan-abort';
    const { plan, session } = await seedActive(id, 'A');
    const cursorBefore = (await getPlan(plan.id))!.cursor;

    const guard = injectAbortAfterPutSuccess('plans');
    let result;
    try {
      result = await atomicFinishSession({
        session: { ...session, status: 'completed', endedAt: NOW + 1000 },
        guard: { sessionId: id, editorId: 'A', advanceCycle: true },
      });
    } finally {
      guard.restore();
    }

    expect(result.ok).toBe(false);
    expect((await getSession(id))!.status).toBe('active');
    expect((await getPlan(plan.id))!.cursor).toBe(cursorBefore);
  });

  it('正常提交（无故障注入）仍返回成功并带正确 plan', async () => {
    const id = 'v5-finish-ok';
    const { plan, session } = await seedActive(id, 'A');
    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: true },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.status).toBe('completed');
      expect(r.plan!.cursor).toBe(1);
    }
    expect((await getSession(id))!.status).toBe('completed');
    expect((await getPlan(plan.id))!.cursor).toBe(1);
  });

  it('放弃同样等提交：sessions.put success 后 abort → 返回失败且仍 active', async () => {
    const id = 'v5-discard-abort';
    const { session } = await seedActive(id, 'A');

    const guard = injectAbortAfterPutSuccess('sessions');
    let result;
    try {
      result = await atomicDiscardSession({
        session: { ...session, status: 'discarded', endedAt: NOW + 1000 },
        guard: { editorId: 'A' },
      });
    } finally {
      guard.restore();
    }

    expect(result.ok).toBe(false);
    expect((await getSession(id))!.status).toBe('active');
  });

  it('普通保存的同类故障继续正确失败（正向对照）', async () => {
    const id = 'v5-save-abort';
    const { session } = await seedActive(id, 'A');

    const guard = injectAbortAfterPutSuccess('sessions');
    let result;
    try {
      result = await atomicSaveSession({
        session: { ...session, note: '注入失败前不该生效', revision: revisionOf(session) },
        guard: { sessionId: id, editorId: 'A' },
      });
    } finally {
      guard.restore();
    }

    expect(result.ok).toBe(false);
    const after = await getSession(id);
    expect(after!.note).not.toBe('注入失败前不该生效');
    expect(revisionOf(after)).toBe(revisionOf(session));
  });

  it('已终态幂等返回不写库，因此不受提交故障影响', async () => {
    const id = 'v5-terminal-noop';
    const { session } = await seedActive(id, 'A');
    await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: false },
    });
    const rev = revisionOf(await getSession(id));

    // 即使注入 abort，幂等路径本来就不写库，应正常返回既有结果
    const guard = injectAbortAfterPutSuccess('sessions');
    let result;
    try {
      await acquireSessionLock(id, 'A');
      result = await atomicFinishSession({
        session: { ...session, status: 'completed', endedAt: NOW + 2000 },
        guard: { sessionId: id, editorId: 'A', advanceCycle: false, lockPolicy: 'optional' },
      });
    } finally {
      guard.restore();
    }

    expect(result!.ok).toBe(true);
    if (result!.ok) expect(result!.alreadyTerminal).toBe(true);
    expect(revisionOf(await getSession(id))).toBe(rev);
  });
});

/* ── V4-02b：optional 不能无视别人有效锁 ─────────────────── */
describe('V4-02b optional 结束/放弃不得绕过他人的有效锁', () => {
  it('A 有效持锁时，Home 同参数 optional finish 必须被拒', async () => {
    const id = 'v5-home-optional';
    const { session } = await seedActive(id, 'A');
    expect((await atomicAcquireLock(id, 'A')).ok).toBe(true);

    // Home 的做法：无 editorId、lockPolicy=optional
    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('lock-lost');
    // 记录未被结束，A 的锁还在
    expect((await getSession(id))!.status).toBe('active');
    const lock = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lock!.editorId).toBe('A');
  });

  it('锁空闲时 optional 结束可以成功（首页正常路径）', async () => {
    const id = 'v5-home-optional-free';
    const { session } = await seedActive(id, 'A');
    const { releaseSessionLock } = await import('../src/lib/lock');
    await releaseSessionLock(id, 'A');

    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
    expect((await getSession(id))!.status).toBe('completed');
  });

  it('锁已过期时 optional 结束可以成功（可安全接管）', async () => {
    const id = 'v5-home-optional-expired';
    const { session } = await seedActive(id, 'A');
    const { idbPut } = await import('../src/db/idb');
    await idbPut('meta', { key: `lock:${id}`, sessionId: id, editorId: 'B', at: 0 });

    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
  });

  it('A 有效持锁时 optional discard 同样被拒', async () => {
    const id = 'v5-home-optional-discard';
    const { session } = await seedActive(id, 'A');
    expect((await atomicAcquireLock(id, 'A')).ok).toBe(true);

    const r = await atomicDiscardSession({
      session: { ...session, status: 'discarded', endedAt: NOW + 1000 },
      guard: { lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(false);
    expect((await getSession(id))!.status).toBe('active');
  });

  it('自己是锁持有者时 optional 结束成功', async () => {
    const id = 'v5-optional-self';
    const { session } = await seedActive(id, 'A');
    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { editorId: 'A', advanceCycle: false, lockPolicy: 'optional' },
    });
    expect(r.ok).toBe(true);
  });
});

/* ── V4-02b 补充：锁规则收紧后，历史纠错的主判据仍然成立 ───────── */
describe('V4-02b 历史纠错的状态判据未被锁规则掩盖', () => {
  it('锁空闲时，active 记录走历史纠错仍返回 state-conflict', async () => {
    const id = 'v5-history-active-free';
    const { session } = await seedActive(id, 'A');
    const { releaseSessionLock } = await import('../src/lib/lock');
    await releaseSessionLock(id, 'A');

    const { atomicSaveHistoryEdit } = await import('../src/db/tx');
    const r = await atomicSaveHistoryEdit({ session, expectedRevision: revisionOf(session) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('state-conflict');
  });

  it('锁空闲时，终态记录的历史纠错可以成功', async () => {
    const id = 'v5-history-done-free';
    const { session } = await seedActive(id, 'A');
    await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      guard: { sessionId: id, editorId: 'A', advanceCycle: false },
    });
    // finish 会在同事务里释放锁
    const done = (await getSession(id))!;
    const { atomicSaveHistoryEdit } = await import('../src/db/tx');
    const r = await atomicSaveHistoryEdit({
      session: { ...done, note: '锁空闲时纠错', revision: done.revision },
      expectedRevision: revisionOf(done),
    });
    expect(r.ok).toBe(true);
    expect((await getSession(id))!.note).toBe('锁空闲时纠错');
  });
});
