/* A05 + LC08 回归：编辑权的交接必须「先抓旧持有者 → 原子改名 → 才发布新 ID」。
   ── 独立审查指出的真实缺陷（已落在接线里）─────────────────────
   Session 里曾有两个 effect，声明顺序是：
     effect#1：rememberEditorId(新 ID)     ← 先发布
     effect#2：reclaimOwnLock()            ← 再读“上一个持有者”
   React 按声明顺序跑 effect，于是 effect#2 读到的“上一个持有者”就是**新 ID**，
   `prev === editorId` 直接 return true —— atomicAdoptLock 根本没执行。
   库里那把**未过期的旧实例锁**原封不动，新实例随后 acquire 撞 held-by-other，
   刷新/快速重进把自己锁在门外，第一笔输入存不进去。

   本文件不测孤立 helper，而是直接跑生产模块 lock.ts 的
   takeOwnershipOnMount()，并断言：
     · 旧锁未过期时，新实例拿到可写所有权（新 ID 真的成了持有者）
     · 第一笔输入真的能落库（saveActiveSession 成功、revision 前进）
     · 旧实例随后的 release 不会打掉新实例的锁
     · 顺序反例（先发布后接手）在本实现下不再可能造成自锁
     · 别人有效持锁时仍然拒绝（不偷锁） */

import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { __resetDbHandle } from '../src/db/idb';
import { getSession, savePlan, saveSession } from '../src/db/repo';
import { readLockState, lockKey } from '../src/db/locks';
import { atomicSaveSession, revisionOf } from '../src/db/tx';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { acquireSessionLock, releaseSessionLock, takeOwnershipOnMount } from '../src/lib/lock';
import type { Session } from '../src/domain/types';

const SESSION_STORAGE_KEY = 'motion-editor-id';
const NOW = 1_760_000_000_000;

/** node 环境没有 sessionStorage：装一个最小实现（lock.ts 只用 get/set/removeItem） */
function installSessionStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  return storage;
}

async function seedActiveSession(): Promise<Session> {
  const plan = createV32Plan(NOW);
  await savePlan(plan);
  const s = createSession(plan, plan.days[0], NOW);
  await saveSession(s);
  return s;
}

describe('A05 · 编辑权交接顺序（生产模块）', () => {
  let storage: ReturnType<typeof installSessionStorage>;

  beforeEach(async () => {
    storage = installSessionStorage();
    storage.clear();
    __resetDbHandle();
  });

  it('旧锁未过期时，新实例获得可写所有权，第一笔输入真的落库', async () => {
    const session = await seedActiveSession();
    const sid = session.id;

    // 旧实例（上一次页面实例）：合法拿到未过期的锁
    const oldEditor = 'ed-old-instance';
    const acq = await acquireSessionLock(sid, oldEditor);
    expect(acq.ok).toBe(true);
    // 模拟“刷新前”留下了自己的 editorId
    storage.setItem(SESSION_STORAGE_KEY, oldEditor);
    const stateBefore = await readLockState(sid);
    expect(stateBefore.kind).toBe('held');
    if (stateBefore.kind === 'held') {
      expect(stateBefore.editorId).toBe(oldEditor);
      expect(stateBefore.expired).toBe(false);
    }

    // 新实例挂载：走生产入口拿编辑权
    const newEditor = 'ed-new-instance';
    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: newEditor });
    expect(r.ok).toBe(true);

    // ① 新 ID 真的成了持有者（旧锁被原子改名，而不是留在原处）
    const stateAfter = await readLockState(sid);
    expect(stateAfter.kind).toBe('held');
    if (stateAfter.kind === 'held') {
      expect(stateAfter.editorId).toBe(newEditor);
      expect(stateAfter.expired).toBe(false);
    }

    // ② 发布的 editorId 已经是新实例（供下一次刷新接手）
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBe(newEditor);

    // ③ 第一笔输入真的能保存（不是“看起来可写”）
    const fresh = await getSession(sid);
    expect(fresh).toBeDefined();
    const rev = revisionOf(fresh);
    const edited: Session = {
      ...(fresh as Session),
      revision: rev,
      warmups: (fresh as Session).warmups.map((w, i) => (i === 0 ? { ...w, done: true } : w)),
    };
    const saved = await atomicSaveSession({ session: edited, guard: { editorId: newEditor, expectedVersion: rev } });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.revision).toBeGreaterThan(rev);
      const reread = await getSession(sid);
      expect(reread?.warmups[0]?.done).toBe(true);
    }
  });

  it('旧实例晚到的 release 不会打掉新实例的锁（LC08 核心）', async () => {
    const session = await seedActiveSession();
    const sid = session.id;

    const oldEditor = 'ed-old';
    await acquireSessionLock(sid, oldEditor);
    storage.setItem(SESSION_STORAGE_KEY, oldEditor);

    const newEditor = 'ed-new';
    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: newEditor });
    expect(r.ok).toBe(true);

    // 旧实例的卸载清理终于落地
    const released = await releaseSessionLock(sid, oldEditor);
    expect(released).toBe(false); // 非持有者被拒绝

    // 新实例仍然持锁且可写
    const state = await readLockState(sid);
    expect(state.kind).toBe('held');
    if (state.kind === 'held') expect(state.editorId).toBe(newEditor);

    const stillWritable = await import('../src/lib/lock').then((m) => m.refreshSessionLock(sid, newEditor));
    expect(stillWritable).toBe(true);
  });

  it('别人有效持锁时拒绝接手（绝不偷锁）', async () => {
    const session = await seedActiveSession();
    const sid = session.id;

    const other = 'ed-other-tab';
    await acquireSessionLock(sid, other);
    // 本标签页上一次实例（名字不同，但锁现在在别人手里）
    storage.setItem(SESSION_STORAGE_KEY, 'ed-my-previous');

    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: 'ed-new' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('held-by-other');

    const state = await readLockState(sid);
    if (state.kind === 'held') expect(state.editorId).toBe(other); // 没被抢
  });

  it('没有上一个持有者时也能正常拿到锁（首装/首进）', async () => {
    const session = await seedActiveSession();
    const sid = session.id;
    // sessionStorage 为空 = 没有上一次实例
    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: 'ed-first' });
    expect(r.ok).toBe(true);
    const state = await readLockState(sid);
    if (state.kind === 'held') expect(state.editorId).toBe('ed-first');
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBe('ed-first');
  });

  it('顺序反例：若“先发布新 ID 再接手”，接手会静默失效（本实现不再走这条路）', async () => {
    const session = await seedActiveSession();
    const sid = session.id;

    const oldEditor = 'ed-old';
    await acquireSessionLock(sid, oldEditor);
    // 人为模拟 A05 的错误前置：先发布新 ID，覆盖掉旧持有者记录
    const newEditor = 'ed-new';
    storage.setItem(SESSION_STORAGE_KEY, newEditor);

    // 此时 takeOwnershipOnMount 抓到的“上一个持有者”是 newEditor 自己，
    // 与 editorId 相同 → 不做改名（返回 ok 仅因后续 acquire 的结论）。
    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: newEditor });
    // 关键：旧锁仍在 oldEditor 名下 → acquire 必须失败（这正是 A05 描述的“自锁”）
    expect(r.ok).toBe(false);
    const state = await readLockState(sid);
    if (state.kind === 'held') expect(state.editorId).toBe(oldEditor);
    // 说明：这条断言把“先发布”错误固定为可观察失败，
    // 而 Session 现在只调用 capture-before-publish 的入口，不会进入此状态。
  });

  it('接手后锁与 revision 一致：连续两次输入都能保存（无 no-lock / 无 version-conflict）', async () => {
    const session = await seedActiveSession();
    const sid = session.id;
    const oldEditor = 'ed-old';
    await acquireSessionLock(sid, oldEditor);
    storage.setItem(SESSION_STORAGE_KEY, oldEditor);

    const newEditor = 'ed-new';
    expect((await takeOwnershipOnMount({ sessionId: sid, editorId: newEditor })).ok).toBe(true);

    let current = (await getSession(sid)) as Session;
    for (let i = 1; i <= 2; i++) {
      const rev = revisionOf(current);
      const next: Session = {
        ...current,
        revision: rev,
        warmups: current.warmups.map((w, idx) => (idx === 0 ? { ...w, done: i % 2 === 1 } : w)),
      };
      const saved = await atomicSaveSession({ session: next, guard: { editorId: newEditor, expectedVersion: rev } });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      current = { ...next, revision: saved.revision };
    }
    const final = await getSession(sid);
    expect(final?.warmups[0]?.done).toBe(false); // 第二次输入把 done 改回 false，证明确实写进去了
  });

  it('sessionStorage 不可用时（隐私模式）挂载仍然可用', async () => {
    const session = await seedActiveSession();
    const sid = session.id;
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    (globalThis as unknown as { sessionStorage: typeof broken }).sessionStorage = broken;

    const r = await takeOwnershipOnMount({ sessionId: sid, editorId: 'ed-privacy' });
    expect(r.ok).toBe(true);
    const state = await readLockState(sid);
    if (state.kind === 'held') expect(state.editorId).toBe('ed-privacy');
    void lockKey;
  });
});
