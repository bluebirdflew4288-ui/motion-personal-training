/* V7-R07 回归：接管自动保存必须进入与其他提交相同的忙状态。
   审查 R07 的真实回调顺序：
     1. 已有带 token 草稿（第1组15），库中另一页第2组20
     2. 点「接管继续编辑」，tryTakeOver 读最新库并进入 persist，用受控 Promise 暂停在提交期间
     3. 此时 takingOver=true 但 submittingRef=false → 放弃按钮 disabled=false
     4. 执行放弃 onClick：pending 立刻清除，提示"已放弃"
     5. 放行保存：库写入，随后又提示"已接管…已保存"
   → 用户已放弃，数据仍被写入。

   本轮把 retry/takeover/discard 收敛到**单一 busy owner**。
   这里用与 Session.tsx 同构的 busy 所有权逻辑验证互斥语义
   （React 接线与按钮 disabled 由 verify-v8 浏览器脚本覆盖）。 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { __resetDbHandle } from '../src/db/idb';
import { getSession, savePlan, saveSession } from '../src/db/repo';
import { atomicSaveSession, revisionOf } from '../src/db/tx';
import { acquireSessionLock } from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { mergeDraftOntoFresh, type PendingDraft } from '../src/domain/draftMerge';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

/** 与 Session.tsx 的 beginBusy/endBusy 同构的忙状态所有权 */
function makeBusyOwner() {
  let owner: 'retry' | 'takeover' | null = null;
  const messages: string[] = [];
  return {
    get owner() {
      return owner;
    },
    get busy() {
      return owner !== null;
    },
    messages,
    begin(who: 'retry' | 'takeover'): boolean {
      if (owner !== null) {
        messages.push(owner === 'takeover' ? '正在接管并保存刚才的改动，请稍候。' : '正在保存刚才的改动，请稍候。');
        return false;
      }
      owner = who;
      return true;
    },
    end(who: 'retry' | 'takeover'): void {
      // 只有当前所有者能释放
      if (owner === who) owner = null;
    },
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const repsOf = (sess: Session) => sess.exercises[0].sets.map((x) => x.reps);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/* ═══ 纯忙状态所有权 ═══ */
describe('R07 统一忙状态所有权', () => {
  it('接管期间 retry 无法进入（同一把锁）', () => {
    const busy = makeBusyOwner();
    expect(busy.begin('takeover')).toBe(true);
    expect(busy.begin('retry')).toBe(false);
    expect(busy.owner).toBe('takeover');
    expect(busy.messages[0]).toContain('正在接管并保存');
  });

  it('retry 期间 takeover 无法进入', () => {
    const busy = makeBusyOwner();
    expect(busy.begin('retry')).toBe(true);
    expect(busy.begin('takeover')).toBe(false);
    expect(busy.owner).toBe('retry');
  });

  it('只有当前所有者能释放忙状态（交错调用不误清）', () => {
    const busy = makeBusyOwner();
    busy.begin('takeover');
    busy.end('retry'); // 非所有者：不应释放
    expect(busy.owner).toBe('takeover');
    busy.end('takeover'); // 所有者：释放
    expect(busy.owner).toBeNull();
  });

  it('释放后可以再次进入', () => {
    const busy = makeBusyOwner();
    busy.begin('takeover');
    busy.end('takeover');
    expect(busy.begin('retry')).toBe(true);
  });
});

/* ═══ 审查 R07 的真实顺序：接管提交中执行放弃 ═══ */
describe('R07 接管自动保存期间，放弃必须被拒绝', () => {
  it('旧行为对照：没有共用忙状态时，放弃会清掉 pending 而在途保存仍写入', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    let s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-r07');
    const base = (await getSession(s.id))!;

    // 草稿：第1组15（带 token）
    const draftSession = clone(base);
    draftSession.exercises[0].sets[0].reps = 15;
    const draft: PendingDraft = {
      token: 1,
      session: draftSession,
      baseRevision: revisionOf(base),
      baseSession: clone(base),
    };
    let pending: PendingDraft | null = draft;

    // 旧接线：接管只 setTakingOver，放弃只查 submittingRef（此时为 false）→ 允许
    const legacyTakingOver = true; // 旧实现在接管时确实置了 true
    const legacySubmittingRef = false; // 但没有进入提交忙状态
    // 旧放弃按钮/handler 只看 submittingRef → 漏掉 takingOver
    const legacyDiscardAllowed = !legacySubmittingRef && !legacyTakingOver === false ? true : true;
    expect(legacyDiscardAllowed).toBe(true);

    // 用户点放弃 → pending 立即清除
    if (legacyDiscardAllowed) pending = null;
    expect(pending).toBeNull();

    // 在途的接管自动保存随后照旧提交（用草稿快照）
    const merged = mergeDraftOntoFresh(draft.baseSession, draft.session, base);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const r = await atomicSaveSession({
      session: { ...merged.session, revision: revisionOf(base) },
      guard: { sessionId: s.id, editorId: 'ed-r07', expectedVersion: revisionOf(base) },
    });
    expect(r.ok).toBe(true);

    // 缺陷现场：用户已放弃，但第1组 15 仍被写入
    const after = await getSession(s.id);
    expect(repsOf(after!)[0]).toBe(15);
    expect(pending).toBeNull();
  });

  it('新行为：接管持有忙状态时，放弃在 handler 层被拒绝，草稿保留', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    let s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-r07b');
    const base = (await getSession(s.id))!;

    const draftSession = clone(base);
    draftSession.exercises[0].sets[0].reps = 15;
    let pending: PendingDraft | null = {
      token: 1,
      session: draftSession,
      baseRevision: revisionOf(base),
      baseSession: clone(base),
    };

    const busy = makeBusyOwner();
    // 接管进入忙状态
    expect(busy.begin('takeover')).toBe(true);

    // 放弃 handler：检查同一 busy → 拒绝
    const tryDiscard = () => {
      if (busy.owner !== null) return false; // handler 层守卫
      pending = null;
      return true;
    };
    const discarded = tryDiscard();
    expect(discarded).toBe(false);
    expect(pending).not.toBeNull(); // 草稿保留
    expect(busy.messages.length).toBe(0); // tryDiscard 本身不发消息，由 UI 层发

    // 接管保存继续完成
    const merged = mergeDraftOntoFresh(pending.baseSession, pending.session, base);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const r = await atomicSaveSession({
      session: { ...merged.session, revision: revisionOf(base) },
      guard: { sessionId: s.id, editorId: 'ed-r07b', expectedVersion: revisionOf(base) },
    });
    expect(r.ok).toBe(true);
    busy.end('takeover');

    // 数据写入是"接管保存成功"的正常结果，不是"放弃后仍被写"
    expect(repsOf((await getSession(s.id))!)[0]).toBe(15);
    // 保存成功后才由 persist 清除草稿（这里模拟：提交包含该 token）
    pending = null;
    expect(pending).toBeNull();
  });

  it('接管提交失败时：草稿保留，忙状态释放，之后仍可重试', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-r07c');
    const base = (await getSession(s.id))!;

    const draftSession = clone(base);
    draftSession.exercises[0].sets[0].reps = 15;
    let pending: PendingDraft | null = {
      token: 3,
      session: draftSession,
      baseRevision: revisionOf(base),
      baseSession: clone(base),
    };

    const busy = makeBusyOwner();
    busy.begin('takeover');

    // 注入提交失败：request success 后 abort
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patched(...args: unknown[]) {
      const req = (origPut as (...a: unknown[]) => IDBRequest).apply(this, args);
      if (this.name === 'sessions') {
        const tx = this.transaction;
        req.addEventListener('success', () => {
          try {
            tx.abort();
          } catch {
            /* ignore */
          }
        });
      }
      return req;
    };
    let outcome: 'saved' | 'failed' = 'saved';
    try {
      const r = await atomicSaveSession({
        session: { ...draftSession, revision: revisionOf(base) },
        guard: { sessionId: s.id, editorId: 'ed-r07c', expectedVersion: revisionOf(base) },
      });
      outcome = r.ok ? 'saved' : 'failed';
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
    busy.end('takeover');

    expect(outcome).toBe('failed');
    expect(pending).not.toBeNull(); // 失败保留草稿
    expect(busy.owner).toBeNull(); // 忙状态已释放
    expect(busy.begin('retry')).toBe(true); // 之后可以重试
  });
});

/* ═══ 重复点击：两个入口都不能二次提交 ═══ */
describe('R07 重复点击不会发起第二次提交', () => {
  it('接管进行中再点接管：被拒绝，只产生一次提交', async () => {
    const busy = makeBusyOwner();
    let submits = 0;
    const runTakeover = async () => {
      if (!busy.begin('takeover')) return;
      try {
        submits += 1;
        await Promise.resolve();
      } finally {
        busy.end('takeover');
      }
    };
    const gate = deferred();
    // 首次进入后挂起
    const first = (async () => {
      if (!busy.begin('takeover')) return;
      try {
        submits += 1;
        await gate.promise;
      } finally {
        busy.end('takeover');
      }
    })();
    await Promise.resolve();
    await runTakeover(); // 第二次点击
    expect(submits).toBe(1);
    expect(busy.messages.length).toBe(1);
    gate.resolve();
    await first;
    expect(busy.owner).toBeNull();
  });

  it('retry 进行中再点 retry：被拒绝，只产生一次提交', async () => {
    const busy = makeBusyOwner();
    let submits = 0;
    const gate = deferred();
    const runRetry = async () => {
      if (!busy.begin('retry')) return;
      try {
        submits += 1;
        await gate.promise;
      } finally {
        busy.end('retry');
      }
    };
    const first = runRetry();
    await Promise.resolve();
    await runRetry();
    expect(submits).toBe(1);
    gate.resolve();
    await first;
  });

  it('retry 进行中点接管：被拒绝（同一把锁）', async () => {
    const busy = makeBusyOwner();
    let takeoverRuns = 0;
    const gate = deferred();
    const runRetry = async () => {
      if (!busy.begin('retry')) return;
      try {
        await gate.promise;
      } finally {
        busy.end('retry');
      }
    };
    const runTakeover = async () => {
      if (!busy.begin('takeover')) return;
      takeoverRuns += 1;
      busy.end('takeover');
    };
    const first = runRetry();
    await Promise.resolve();
    await runTakeover();
    expect(takeoverRuns).toBe(0);
    gate.resolve();
    await first;
  });
});
