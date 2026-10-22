/* V4-02a 回归：可见性生命周期与恢复后的编辑资格。
   审查 V4D07 的证据是「按真实处理器调用的 API 序列」执行：
     acquire → hidden release → visible release → 首次保存 → no-lock；心跳也不能恢复。
   本文件用**真实的锁/存储函数**复现该序列，并断言修复后的语义。
   React 接线本身（visibilitychange 监听）由 verify-v5 的真实浏览器脚本覆盖。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGet, idbPut } from '../src/db/idb';
import { getSession, savePlan, saveSession } from '../src/db/repo';
import { atomicSaveSession, revisionOf } from '../src/db/tx';
import {
  acquireSessionLockDetailed,
  releaseSessionLock,
  refreshSessionLockDetailed,
} from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function makeSession(id: string): Session {
  const plan = createV32Plan(NOW);
  return { ...createSession(plan, plan.days[0], NOW), id };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

/**
 * 模拟 Session.tsx 的处理器序列：把 effect 里的调用抽成这几步，
 * 用真实存储函数执行（不是伪造的 mock）。
 */
async function seedAndAcquire(id: string, editorId: string) {
  const plan = createV32Plan(NOW);
  await savePlan(plan);
  const s = makeSession(id);
  await saveSession({ ...s, planId: plan.id });
  const acq = await acquireSessionLockDetailed(id, editorId);
  expect(acq.ok).toBe(true);
  return (await getSession(id))!;
}

/** hidden 阶段：排空队列后释放 */
async function onHidden(sessionId: string, editorId: string, queue: Promise<unknown>) {
  await queue.catch(() => undefined);
  await releaseSessionLock(sessionId, editorId);
}

/** visible 阶段：读最新记录 → 重新获取锁 */
async function onVisible(sessionId: string, editorId: string) {
  const fresh = await getSession(sessionId);
  const r = await acquireSessionLockDetailed(sessionId, editorId);
  return { fresh, lock: r };
}

describe('V4-02a 切后台再回来：编辑资格被正确恢复', () => {
  it('hidden→visible 后重新取得锁，首笔保存成功（旧实现是 no-lock）', async () => {
    const id = 'v5-vis-restore';
    const editor = 'ed-A';
    let session = await seedAndAcquire(id, editor);

    // hidden：队列为空 → 立即释放
    await onHidden(id, editor, Promise.resolve());
    const lockWhileHidden = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lockWhileHidden!.editorId).toBe(''); // 隐藏时确实释放了

    // visible：应重新取得控制
    const vis = await onVisible(id, editor);
    expect(vis.lock.ok).toBe(true);
    const lockAfterVisible = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lockAfterVisible!.editorId).toBe(editor);

    // 首笔保存必须成功
    session = vis.fresh!;
    const save = await atomicSaveSession({
      session: { ...session, note: '回到前台后的第一笔', revision: revisionOf(session) },
      guard: { sessionId: id, editorId: editor, expectedVersion: revisionOf(session) },
    });
    expect(save.ok).toBe(true);
    expect((await getSession(id))!.note).toBe('回到前台后的第一笔');
  });

  it('visible 时同步 revision：用恢复后的 revision 写入，不会版本冲突', async () => {
    const id = 'v5-vis-revision';
    const editor = 'ed-A';
    const initial = await seedAndAcquire(id, editor);

    // 模拟隐藏期间别的地方把记录推进了一版（例如另一路径保存）
    // 用受约束入口写入，保证 revision 递增
    const bumped = await atomicSaveSession({
      session: { ...initial, note: '隐藏期间的变化', revision: revisionOf(initial) },
      guard: { sessionId: id, editorId: editor, expectedVersion: revisionOf(initial) },
    });
    expect(bumped.ok).toBe(true);

    await onHidden(id, editor, Promise.resolve());
    const vis = await onVisible(id, editor);
    expect(vis.lock.ok).toBe(true);

    // 关键：恢复后必须用**库里最新的 revision**，否则会 version-conflict
    const freshRev = revisionOf(vis.fresh);
    expect(freshRev).toBeGreaterThan(revisionOf(initial));
    const save = await atomicSaveSession({
      session: { ...vis.fresh!, note: '用最新 revision 写入', revision: freshRev },
      guard: { sessionId: id, editorId: editor, expectedVersion: freshRev },
    });
    expect(save.ok).toBe(true);
  });

  it('隐藏时仍有待存队列：队列排空后才释放，最后一笔改动不丢', async () => {
    const id = 'v5-vis-queued';
    const editor = 'ed-A';
    const session = await seedAndAcquire(id, editor);

    // 构造一个「还在队列里」的保存
    let resolveQueued: () => void = () => undefined;
    const queued = new Promise<void>((res) => {
      resolveQueued = res;
    });
    const queuedWork = queued.then(async () => {
      const r = await atomicSaveSession({
        session: { ...session, note: '隐藏前的最后一笔', revision: revisionOf(session) },
        guard: { sessionId: id, editorId: editor, expectedVersion: revisionOf(session) },
      });
      return r;
    });

    // hidden 在队列未完成时触发
    const hiddenWork = onHidden(id, editor, queuedWork);
    // 此刻队列还没跑完，锁应仍属于自己（否则这笔保存会 no-lock）
    const lockDuringQueue = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lockDuringQueue!.editorId).toBe(editor);

    resolveQueued();
    const saved = await queuedWork;
    await hiddenWork;

    expect(saved.ok).toBe(true);
    expect((await getSession(id))!.note).toBe('隐藏前的最后一笔');
  });

  it('别人有效持锁时 visible 不偷锁：明确只读，且不能写入', async () => {
    const id = 'v5-vis-other-lock';
    const mine = 'ed-A';
    const other = 'ed-B';
    const session = await seedAndAcquire(id, mine);

    // hidden 释放自己
    await onHidden(id, mine, Promise.resolve());

    // 另一标签页在隐藏期间拿到锁并写入
    const otherAcq = await acquireSessionLockDetailed(id, other);
    expect(otherAcq.ok).toBe(true);
    const otherSave = await atomicSaveSession({
      session: { ...session, note: '另一标签页的数据', revision: revisionOf(session) },
      guard: { sessionId: id, editorId: other, expectedVersion: revisionOf(session) },
    });
    expect(otherSave.ok).toBe(true);

    // 我 visible：绝不能抢到锁
    const vis = await onVisible(id, mine);
    expect(vis.lock.ok).toBe(false);
    if (!vis.lock.ok) expect(vis.lock.reason).toBe('held-by-other');

    // 锁仍属于别人
    const lock = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lock!.editorId).toBe(other);

    // 我的写入被拒（明确只读，而不是看似可写）
    const mySave = await atomicSaveSession({
      session: { ...vis.fresh!, note: '我的旧数据', revision: revisionOf(vis.fresh) },
      guard: { sessionId: id, editorId: mine },
    });
    expect(mySave.ok).toBe(false);
    expect((await getSession(id))!.note).toBe('另一标签页的数据');
  });

  it('别人的锁已过期时 visible 可安全接管', async () => {
    const id = 'v5-vis-expired';
    const mine = 'ed-A';
    await seedAndAcquire(id, mine);
    await onHidden(id, mine, Promise.resolve());

    // 别人拿过锁但已过期（at=0）
    await idbPut('meta', { key: `lock:${id}`, sessionId: id, editorId: 'ed-B', at: 0 });

    const vis = await onVisible(id, mine);
    expect(vis.lock.ok).toBe(true);
    const lock = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lock!.editorId).toBe(mine);
  });

  it('心跳不能复活已释放的锁（避免只读页偷锁）', async () => {
    const id = 'v5-vis-heartbeat';
    const mine = 'ed-A';
    await seedAndAcquire(id, mine);
    await onHidden(id, mine, Promise.resolve());

    // 心跳（续租）在锁为空时必须失败，不能创建锁
    const renew = await refreshSessionLockDetailed(id, mine);
    expect(renew.ok).toBe(false);
    const lock = await idbGet<{ editorId: string }>('meta', `lock:${id}`);
    expect(lock!.editorId).toBe('');
  });

  it('visible → hidden → visible 反复切换仍能稳定恢复', async () => {
    const id = 'v5-vis-cycle';
    const editor = 'ed-A';
    let session = await seedAndAcquire(id, editor);

    for (let i = 0; i < 3; i++) {
      await onHidden(id, editor, Promise.resolve());
      const vis = await onVisible(id, editor);
      expect(vis.lock.ok).toBe(true);
      const rev = revisionOf(vis.fresh);
      const save = await atomicSaveSession({
        session: { ...vis.fresh!, note: `第 ${i + 1} 轮回到前台`, revision: rev },
        guard: { sessionId: id, editorId: editor, expectedVersion: rev },
      });
      expect(save.ok).toBe(true);
      session = (await getSession(id))!;
    }
    expect(session.note).toBe('第 3 轮回到前台');
  });
});
