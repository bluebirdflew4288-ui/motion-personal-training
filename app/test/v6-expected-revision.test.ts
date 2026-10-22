/* V5-01 守护：连续输入的期望版本必须按队列顺序递增。
   这是本轮修复过程中一度引入的真实回归：
   persist 在**调用时**把 confirmedRevision.current 拷进闭包，
   连续两次输入带着同一个旧 revision 入队 → 第二次 version-conflict
   → 表现为「第 1 组只写进第一位数字」。
   用真实 tx.atomicSaveSession 复现该顺序。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { getSession, savePlan, saveSession } from '../src/db/repo';
import { atomicSaveSession, revisionOf } from '../src/db/tx';
import { acquireSessionLock } from '../src/lib/lock';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

beforeEach(async () => {
  __resetDbHandle();
  for (const st of ['plans', 'sessions', 'settings', 'meta']) await idbClear(st);
});

async function seed(): Promise<Session> {
  const plan = createV32Plan(NOW);
  await savePlan(plan);
  const s = createSession(plan, plan.days[0], NOW);
  await saveSession(s);
  await acquireSessionLock(s.id, 'ed-test');
  return (await getSession(s.id))!;
}

function withReps(s: Session, reps: number): Session {
  return {
    ...s,
    exercises: s.exercises.map((e, i) =>
      i === 0 ? { ...e, sets: e.sets.map((st, j) => (j === 0 ? { ...st, reps } : st)) } : e,
    ),
  };
}

describe('V5-01 守护：连续输入的期望版本必须按队列顺序递增', () => {
  it('同一队列里连续两次保存，第二次用第一次返回的 revision（而不是调用时的旧值）', async () => {
    const s = await seed();
    let confirmed = revisionOf(s);

    let queue: Promise<void> = Promise.resolve();
    const persistCorrect = (reps: number) => {
      queue = queue.then(async () => {
        const expected = confirmed; // ← 队列执行时读取（正确做法）
        const r = await atomicSaveSession({
          session: withReps(s, reps),
          guard: { sessionId: s.id, editorId: 'ed-test', expectedVersion: expected },
        });
        expect(r.ok).toBe(true);
        if (r.ok) confirmed = r.revision;
      });
    };
    persistCorrect(1);
    persistCorrect(15);
    await queue;

    const final = await getSession(s.id);
    expect(final!.exercises[0].sets[0].reps).toBe(15);
    expect(confirmed).toBeGreaterThan(revisionOf(s));
  });

  it('反例：若在调用时快照 expected，第二次会 version-conflict（证明守护有意义）', async () => {
    const s = await seed();
    const confirmedAtStart = revisionOf(s);

    let queue: Promise<void> = Promise.resolve();
    const results: Array<{ ok: boolean; reason?: string }> = [];
    const persistSnapshotAtCall = (reps: number) => {
      const expectedAtCall = confirmedAtStart; // ← 错误做法：调用时就拷出来
      queue = queue.then(async () => {
        const r = await atomicSaveSession({
          session: withReps(s, reps),
          guard: { sessionId: s.id, editorId: 'ed-test', expectedVersion: expectedAtCall },
        });
        results.push(r.ok ? { ok: true } : { ok: false, reason: r.reason });
      });
    };
    persistSnapshotAtCall(1);
    persistSnapshotAtCall(15);
    await queue;

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].reason).toBe('version-conflict');
    // 第二次被拒 → 15 没有写进去（这正是页面表现的「只写进第一位」
    const final = await getSession(s.id);
    expect(final!.exercises[0].sets[0].reps).toBe(1);
  });
});
