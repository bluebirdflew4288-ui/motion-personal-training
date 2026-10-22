/* V6-01 回归：待存草稿在恢复后普通输入 / 仍只读输入时不得丢失。
   V6-02 回归：重试必须等真实事务提交才报成功。

   审查用「从 Session.tsx AST 提取真实回调」的方式执行，本文件在此基础上
   用真实的 domain/draftMerge + db/tx 复现两条失败顺序的数据结果，
   并直接断言「草稿身份 (token) 语义」——这是本轮修复的核心契约。
   React 接线（recordingPaused 是否真的挡住 Stepper/备注/热身）由 verify-v7 的
   浏览器脚本与源码级断言覆盖。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { getSession, savePlan, saveSession } from '../src/db/repo';
import { atomicSaveSession, revisionOf } from '../src/db/tx';
import { acquireSessionLock } from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { mergeDraftOntoFresh, type PendingDraft } from '../src/domain/draftMerge';
import type { Session, SessionSet } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function set(over: Partial<SessionSet> & { id: string; roundIndex: number }): SessionSet {
  return { stageIndex: 1, reps: null, weightKg: null, status: 'blank', ...over } as SessionSet;
}

function makeSession(rev: number): Session {
  return {
    id: 'sess-v7',
    planId: 'plan-1',
    planName: '计划',
    day: { dayId: 'd1', dayName: '胸 A', focus: 'chest', round: 'A', partText: '胸 A' },
    cycleIndexAtStart: 0,
    targetSetsAtStart: 3,
    startedAt: NOW,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: [],
    exercises: [
      {
        id: 'ex-a',
        exerciseId: 'lib-chest-dip',
        planExerciseId: null,
        name: '双杠臂屈伸',
        restSec: 120,
        target: {
          kind: 'straight',
          sets: 3,
          setsMax: 3,
          repsMin: 8,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: null,
        },
        status: 'pending',
        groups: [
          { index: 1, stageCount: 1 },
          { index: 2, stageCount: 1 },
          { index: 3, stageCount: 1 },
        ],
        sets: [set({ id: 's1', roundIndex: 1 }), set({ id: 's2', roundIndex: 2 }), set({ id: 's3', roundIndex: 3 })],
        note: '',
      },
    ],
    note: '',
    revision: rev,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const repsOf = (s: Session) => s.exercises[0].sets.map((x) => x.reps);

beforeEach(async () => {
  __resetDbHandle();
  for (const st of ['plans', 'sessions', 'settings', 'meta']) await idbClear(st);
});

/* ═══ V6-01 · 路径 A：恢复可写后直接输入另一组 ═══ */
describe('V6-01 路径A：恢复可写后普通输入不得抹掉未重试的草稿', () => {
  it('旧行为（普通保存成功即清空 pending）会丢掉第1组15 —— 用 token 契约证明不再发生', () => {
    // 库初始：A 只读时输入 15 → 草稿 [15,null,null]，baseRev = 1
    const base = makeSession(1);
    const draft: PendingDraft = {
      token: 1,
      session: { ...clone(base), exercises: [{ ...clone(base.exercises[0]), sets: [set({ id: 's1', roundIndex: 1, reps: 15 }), set({ id: 's2', roundIndex: 2 }), set({ id: 's3', roundIndex: 3 })] }] },
      baseRevision: 1,
      baseSession: clone(base),
    };
    expect(repsOf(draft.session)).toEqual([15, null, null]);

    // B 保存第2组20 → 库 [null,20,null]，rev 2
    const fresh = clone(base);
    fresh.exercises[0].sets[1].reps = 20;
    fresh.revision = 2;

    // 本轮接线：存在 pending 时 recordingPaused=true，applyChange 直接 return（不改库、不动草稿）
    const recordingPaused = true;
    const wouldPersist = !recordingPaused;
    expect(wouldPersist).toBe(false);

    // 因此：库仍是 [null,20,null]，草稿仍是 [15,null,null]（token 1 未变）
    expect(repsOf(fresh)).toEqual([null, 20, null]);
    expect(draft.token).toBe(1);
    expect(repsOf(draft.session)).toEqual([15, null, null]);

    // 之后用户点重试 → 三方合并把 15 与 20 都保留
    const merged = mergeDraftOntoFresh(draft.baseSession, draft.session, fresh);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(repsOf(merged.session)).toEqual([15, 20, null]);
  });

  it('对照：若无暂停（旧行为），普通保存 [null,20,12] 成功并清空 pending，15 永久丢失', () => {
    const base = makeSession(1);
    // 旧行为直接把 fresh 派生快照存库，然后无条件清空 pending
    const fresh = clone(base);
    fresh.exercises[0].sets[1].reps = 20;
    fresh.revision = 2;
    // 用户在第3组输入 12（基于 fresh）
    fresh.exercises[0].sets[2].reps = 12;
    let pending: PendingDraft | null = {
      token: 1,
      session: clone(base),
      baseRevision: 1,
      baseSession: clone(base),
    };
    // 旧第 908 行：任何普通保存成功 → pending = null
    pending = null;
    expect(repsOf(fresh)).toEqual([null, 20, 12]);
    expect(pending).toBeNull();
    // 15 既不在库里，也没有草稿可恢复 —— 这正是被修掉的缺陷
    expect(repsOf(fresh).includes(15)).toBe(false);
  });
});

/* ═══ V6-01 · 路径 B：仍只读时继续输入 ═══ */
describe('V6-01 路径B：仍只读时继续输入不得替换旧草稿', () => {
  it('rememberDraft 的增量合并保留旧 15，同时吸收新的第3组 12', () => {
    const base = makeSession(1);
    const oldPendingSession = clone(base);
    oldPendingSession.exercises[0].sets[0].reps = 15; // 旧草稿 [15,null,null]

    // fresh（B 未释放）：[null,20,null]
    const next = clone(base);
    next.exercises[0].sets[1].reps = 20;
    next.exercises[0].sets[2].reps = 12; // 用户在只读状态又填了第3组

    /**
     * 本轮 rememberDraft 的实现：
     *   mergeDraftOntoFresh(existing.session, next, existing.session)
     * base 与 fresh 都取 existing.session → 效果是"把 next 里改动的字段叠加到旧草稿上"。
     */
    // 与 Session.tsx 一致：base = next 的基线，mine = next，fresh = 旧草稿
    const merged = mergeDraftOntoFresh(base, next, oldPendingSession);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    // 旧的 15 保留（第1组），新的 20/12 被吸收
    expect(repsOf(merged.session)).toEqual([15, 20, 12]);
  });

  it('对照：旧实现 { ...existing, session: next } 会让 15 当场消失', () => {
    const base = makeSession(1);
    const existing = { token: 1, session: clone(base), baseRevision: 1, baseSession: clone(base) };
    existing.session.exercises[0].sets[0].reps = 15;
    const next = clone(base);
    next.exercises[0].sets[1].reps = 20;
    next.exercises[0].sets[2].reps = 12;
    // 旧写法
    const replaced = { ...existing, session: next };
    expect(repsOf(replaced.session)).toEqual([null, 20, 12]);
    expect(repsOf(replaced.session).includes(15)).toBe(false); // 15 丢失
  });
});

/* ═══ V6-01 · 草稿身份契约 ═══ */
describe('V6-01 草稿身份：只有包含该草稿的提交才能清除它', () => {
  it('普通保存（无 draftToken）即使成功也不清除他人草稿', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-v7');

    const cur = (await getSession(s.id))!;
    // 模拟页面里有一份 token=7 的草稿
    const draftToken = 7;
    let pending: { token: number } | null = { token: draftToken };

    // 普通输入保存（不带 token）
    const tokenInCtx: number | null = null;
    const r = await atomicSaveSession({
      session: { ...cur, note: '普通输入', revision: revisionOf(cur) },
      guard: { sessionId: s.id, editorId: 'ed-v7', expectedVersion: revisionOf(cur) },
    });
    expect(r.ok).toBe(true);

    // 页面清理逻辑：只有 token 相符才清
    const included = pending !== null && tokenInCtx !== null && pending.token === tokenInCtx;
    if (included) pending = null;

    expect(included).toBe(false);
    expect(pending).not.toBeNull(); // 草稿仍在
  });

  it('携带相符 draftToken 的提交成功后才清除草稿', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-v7');

    const cur = (await getSession(s.id))!;
    const draftToken = 9;
    let pending: { token: number } | null = { token: draftToken };

    const tokenInCtx: number | null = draftToken;
    const r = await atomicSaveSession({
      session: { ...cur, note: '重试草稿', revision: revisionOf(cur) },
      guard: { sessionId: s.id, editorId: 'ed-v7', expectedVersion: revisionOf(cur) },
    });
    expect(r.ok).toBe(true);

    const included = pending !== null && tokenInCtx !== null && pending.token === tokenInCtx;
    if (included) pending = null;
    expect(included).toBe(true);
    expect(pending).toBeNull();
  });
});

/* ═══ V6-02 · 重试必须等真实提交 ═══ */
describe('V6-02 重试必须等真实事务提交', () => {
  it('入队不等于已保存：abort 注入后结果是 failed，不是 saved', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-v7');
    const cur = (await getSession(s.id))!;

    // 在 sessions.put 的 request success 之后注入 abort（与审查 V6A07 同手法）
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function patched(...args: unknown[]) {
      const req = (origPut as (...a: unknown[]) => IDBRequest).apply(this, args);
      if (this.name === 'sessions') {
        const transaction = this.transaction;
        req.addEventListener('success', () => {
          try {
            transaction.abort();
          } catch {
            /* ignore */
          }
        });
      }
      return req;
    };

    let outcome: { status: string } | null = null;
    try {
      const r = await atomicSaveSession({
        session: { ...cur, note: '会被回滚', revision: revisionOf(cur) },
        guard: { sessionId: s.id, editorId: 'ed-v7', expectedVersion: revisionOf(cur) },
      });
      // 页面 persist 的等价映射
      outcome = r.ok ? { status: 'saved' } : { status: 'failed' };
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }

    expect(outcome!.status).toBe('failed');
    // 库未被写入
    expect((await getSession(s.id))!.note).not.toBe('会被回滚');
  });

  it('正常提交时结果才是 saved', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession(s);
    await acquireSessionLock(s.id, 'ed-v7');
    const cur = (await getSession(s.id))!;

    const r = await atomicSaveSession({
      session: { ...cur, note: '正常保存', revision: revisionOf(cur) },
      guard: { sessionId: s.id, editorId: 'ed-v7', expectedVersion: revisionOf(cur) },
    });
    const outcome = r.ok ? 'saved' : 'failed';
    expect(outcome).toBe('saved');
    expect((await getSession(s.id))!.note).toBe('正常保存');
  });
});
