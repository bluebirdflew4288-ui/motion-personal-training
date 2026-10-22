/* V5-02 回归：过时的 hidden 释放不能推翻新的 visible 取锁。
   审查 V5D08 的实际顺序：
     saveQueue 未决 → onHidden 登记「队列完成后 release」
     → onVisible 先刷新并 acquire（UI 宣告可写）
     → 旧队列此刻完成 → 旧 hidden 链 release → 首笔保存 no-lock
   这里用真实 LifecycleQueue + 可控制的 saveQueue/锁桩穷举顺序。 */

import { describe, expect, it } from 'vitest';
import { LifecycleQueue } from '../src/lib/lifecycleQueue';

/** 可手动放行的 Promise */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface LockState {
  /** 当前持有者（'' = 空闲） */
  editorId: string;
  /** 历史操作记录，便于断言顺序 */
  log: string[];
}

/** 极简锁桩：只记录操作顺序与最终持有者 */
function makeLockStub() {
  const state: LockState = { editorId: '', log: [] };
  return {
    state,
    async acquire(editorId: string) {
      // 别人的有效锁不可抢；空闲则取得
      if (state.editorId && state.editorId !== editorId) {
        state.log.push(`acquire-denied:${editorId}`);
        return false;
      }
      state.editorId = editorId;
      state.log.push(`acquire:${editorId}`);
      return true;
    },
    async release(editorId: string) {
      if (state.editorId !== editorId) {
        state.log.push(`release-denied:${editorId}`);
        return false;
      }
      state.editorId = '';
      state.log.push(`release:${editorId}`);
      return true;
    },
  };
}

/** 复刻 Session.tsx 里 doHide / doShow 的结构（同一串行队列 + await 后核验过时） */
function makeLifecycle(queue: LifecycleQueue, lock: ReturnType<typeof makeLockStub>, saveQueue: { current: Promise<void> }) {
  const doHide = async (isStale: () => boolean): Promise<void> => {
    await saveQueue.current.catch(() => undefined);
    if (isStale()) return; // ← 关键：轮到我们时已回到前台 → 不释放新锁
    await lock.release('A');
  };
  const doShow = async (isStale: () => boolean): Promise<void> => {
    // 读最新记录（这里省略，语义无关）
    if (isStale()) return;
    await lock.acquire('A');
  };
  return {
    hidden: () => queue.schedule('hidden', (isStale) => doHide(isStale)),
    visible: () => queue.schedule('visible', (isStale) => doShow(isStale)),
    pagehide: () => queue.schedule('pagehide', (isStale) => doHide(isStale)),
    pageshow: () => queue.schedule('pageshow', (isStale) => doShow(isStale)),
  };
}

describe('V5-02 串行生命周期队列本身', () => {
  it('动作按登记顺序串行执行（前一个 await 完成后才开始下一个）', async () => {
    const q = new LifecycleQueue();
    const order: string[] = [];
    const gate = deferred();

    q.schedule('a', async () => {
      order.push('a-start');
      await gate.promise;
      order.push('a-end');
    });
    q.schedule('b', async () => {
      order.push('b-start');
    });

    await Promise.resolve();
    await Promise.resolve();
    // a 还没放行，b 不能开始
    expect(order).toEqual(['a-start']);
    gate.resolve();
    await q.drain();
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('排队动作仍会执行（不会被预判跳过），但过时的副作用由动作自查后放弃', async () => {
    const q = new LifecycleQueue();
    const ran: string[] = [];
    const sideEffects: string[] = [];
    const gate = deferred();

    q.schedule('hidden', async (isStale) => {
      ran.push('hidden-enter');
      await gate.promise;
      ran.push('hidden-after-await');
      // 关键：await 之后自查过时 → 放弃副作用（例如 release），但"排空队列"已发生
      if (isStale()) {
        sideEffects.push('hidden-release-skipped');
        return;
      }
      sideEffects.push('hidden-release');
    });
    q.schedule('visible', async () => {
      ran.push('visible');
      sideEffects.push('visible-acquire');
    });

    gate.resolve();
    await q.drain();
    // 两个动作都执行了；hidden 的 release 被跳过
    expect(ran).toEqual(['hidden-enter', 'hidden-after-await', 'visible']);
    expect(sideEffects).toEqual(['hidden-release-skipped', 'visible-acquire']);
  });

  it('单个动作抛错不影响后续动作', async () => {
    const q = new LifecycleQueue();
    const ran: string[] = [];
    q.schedule('bad', () => {
      throw new Error('boom');
    });
    q.schedule('good', () => {
      ran.push('good');
    });
    await q.drain();
    expect(ran).toEqual(['good']);
  });

  it('当代次在等待期间前进时 isStale() 返回 true', async () => {
    const q = new LifecycleQueue();
    const gate = deferred();
    let staleAtCheck: boolean | null = null;

    q.schedule('hidden', async (isStale) => {
      await gate.promise;
      staleAtCheck = isStale();
    });
    // 在 hidden 等待期间登记更新的动作 → hidden 的代次过时
    q.schedule('visible', () => undefined);
    gate.resolve();
    await q.drain();
    expect(staleAtCheck).toBe(true);
  });
});

describe('V5-02 审查 V5D08 原顺序：旧 hidden 释放不能推翻新 visible 的锁', () => {
  it('saveQueue 未决 → hidden → visible（队列未完成就回来）→ 放行旧队列 → 首笔保存仍可写', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    // A 已持锁
    await lock.acquire('A');
    expect(lock.state.editorId).toBe('A');

    // 构造未决的保存队列
    const pending = deferred();
    saveQueue.current = pending.promise;

    // ① hidden：登记「队列完成后 release」（会卡在 await saveQueue）
    const hiddenTask = lc.hidden();
    await Promise.resolve();
    await Promise.resolve();
    // hidden 还在等队列，锁仍是 A
    expect(lock.state.editorId).toBe('A');

    // ② visible：在队列未完成时就回到前台（登记到同一串行队列，排在 hidden 之后）
    const visibleTask = lc.visible();

    // ③ 放行旧队列
    pending.resolve();
    await hiddenTask.done;
    await visibleTask.done;

    // 核心：旧 hidden 因为已被 visible 取代，**跳过了 release**；最终锁仍是 A
    expect(lock.state.editorId).toBe('A');
    expect(lock.state.log).not.toContain('release:A');

    // ④ 首笔保存：锁合法（可写）
    const canSave = lock.state.editorId === 'A';
    expect(canSave).toBe(true);
    expect(lock.state.log).toContain('acquire:A');
  });

  it('正常顺序（等 hidden 完全做完再 visible）：仍然先释放再取得，可写', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    await lock.acquire('A');
    const pending = deferred();
    saveQueue.current = pending.promise;

    const hiddenTask = lc.hidden();
    pending.resolve();
    await hiddenTask.done; // 等 hidden 完全结束
    expect(lock.state.editorId).toBe(''); // 已释放

    const visibleTask = lc.visible();
    await visibleTask.done;
    expect(lock.state.editorId).toBe('A'); // 重新取得
    // 顺序必须是 release 之后 acquire
    const relIdx = lock.state.log.indexOf('release:A');
    const acqIdxAfter = lock.state.log.lastIndexOf('acquire:A');
    expect(relIdx).toBeGreaterThanOrEqual(0);
    expect(acqIdxAfter).toBeGreaterThan(relIdx);
  });

  it('多轮快速 hidden→visible：最终状态由最后一次意图决定（可写）', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    await lock.acquire('A');
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      const p = deferred();
      saveQueue.current = p.promise;
      tasks.push(lc.hidden());
      tasks.push(lc.visible());
      p.resolve();
    }
    for (const t of tasks) await t.done;

    expect(lock.state.editorId).toBe('A');
  });

  it('pagehide + visibility 双事件：最后是 visible/pageshow → 可写', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    await lock.acquire('A');
    const p = deferred();
    saveQueue.current = p.promise;

    const pagehideTask = lc.pagehide();
    const visTask = lc.visible();
    p.resolve();
    await pagehideTask.done;
    await visTask.done;

    expect(lock.state.editorId).toBe('A');
  });

  it('最后意图是 hidden 时，最终应为空闲（不误留锁）', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    await lock.acquire('A');
    const visTask = lc.visible(); // 先 visible
    await visTask.done;
    expect(lock.state.editorId).toBe('A');

    const hidTask = lc.hidden(); // 最后 hidden
    await hidTask.done;
    expect(lock.state.editorId).toBe('');
  });

  it('别的编辑者持有效锁时 visible 不偷锁（acquire 被拒，状态保持他人）', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    // B 持锁
    await lock.acquire('B');
    const hidTask = lc.hidden(); // A 的 hidden：A 不是持有者，release 会被拒
    await hidTask.done;
    expect(lock.state.editorId).toBe('B'); // 没有被 A 清掉

    const visTask = lc.visible();
    await visTask.done;
    expect(lock.state.editorId).toBe('B'); // A 仍未偷到
    expect(lock.state.log).toContain('acquire-denied:A');
    expect(lock.state.log).toContain('release-denied:A');
  });

  it('隐藏前的最后一笔保存在释放之前完成（不能为避免竞态丢掉它）', async () => {
    const q = new LifecycleQueue();
    const lock = makeLockStub();
    const saved: string[] = [];
    const saveQueue = { current: Promise.resolve() as Promise<void> };
    const lc = makeLifecycle(q, lock, saveQueue);

    await lock.acquire('A');
    const pending = deferred();
    saveQueue.current = pending.promise.then(() => {
      saved.push('最后一笔');
    });

    const hidTask = lc.hidden();
    // 队列未完成：还不能释放
    await Promise.resolve();
    await Promise.resolve();
    expect(lock.state.editorId).toBe('A');

    pending.resolve();
    await hidTask.done;
    expect(saved).toEqual(['最后一笔']); // 保存确实执行了
    expect(lock.state.editorId).toBe('');
  });
});
