/* G2B-FIX1-R2：实际生产接线的确定性重叠验证。

   根反馈 rev3 的两个要求：
   1. 普通输入必须在**构造 next 之前**捕获真实 intent base / revision；
   2. 测试必须走实际 applyChange→persist 使用的生产函数，不能只在测试里
      手动对“正确 base”调用 rebaseStaleSession。

   本文件直接执行 Session.tsx 实际调用的 captureOrdinaryChange /
   decideQueuedSessionWrite / pendingDraftFromIntent，并配合真实
   fake-indexeddb + atomicSaveSession 验证 pair 在途时的两种顺序与救援基线。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSession, revisionOf } from '../src/db/tx';
import { getSession } from '../src/db/repo';
import { commitPairedSession } from '../src/lib/pairedCommit';
import { captureOrdinaryChange, decideQueuedSessionWrite, pendingDraftFromIntent } from '../src/lib/sessionWrite';
import { createSession } from '../src/domain/session';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import type { Plan, Session, SessionExercise, StraightTarget } from '../src/domain/types';

const NOW = 1_760_000_000_000;
function straight(): StraightTarget {
  return { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 };
}
function makePlan(): Plan {
  return {
    id: 'p-r2', name: 'R2', cursor: 0, createdAt: NOW, updatedAt: NOW,
    days: [{ id: 'd-r2', name: '胸 R2', kind: 'train', warmups: [], exercises: [{ id: 'pe-r2', exerciseId: 'lib-barbell-bench', name: '自由杠铃卧推', restSec: 120, target: straight() }] }],
  };
}
async function seed(): Promise<{ session: Session; editorId: string }> {
  const plan = makePlan();
  const session = createSession(plan, plan.days[0], NOW);
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  const lock = await atomicAcquireLock(fresh.id, 'editor-r2');
  expect(lock.ok).toBe(true);
  return { session: fresh, editorId: 'editor-r2' };
}
function newExercise(name = '器械推胸', id = 'sex-r2-pair'): SessionExercise {
  const tpl = exerciseTemplateFromConfig({ exerciseId: `custom:${name}`, name, target: straight(), restSec: 90 });
  return { ...sessionExerciseFromTemplate(tpl), id };
}
function withFirstSetReps(s: Session, reps: number): Session {
  return {
    ...s,
    exercises: s.exercises.map((ex, i) =>
      i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? { ...st, reps } : st)) } : ex,
    ),
  };
}
function addExercise(s: Session, ex: SessionExercise): Session {
  return s.exercises.some((e) => e.id === ex.id) ? s : { ...s, exercises: [...s.exercises, ex] };
}
function saveDeps() {
  return {
    getSession,
    save: async (session: Session, guard: { editorId: string; expectedRevision: number }) =>
      atomicSaveSession({ session, guard: { editorId: guard.editorId, expectedVersion: guard.expectedRevision } }),
  };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('G2B-FIX1-R2 actual production chain', () => {
  it('pair 在途时普通输入：capture→queue decision→atomic save，普通值与新增动作都保留', async () => {
    const { session, editorId } = await seed();
    const pairEx = newExercise();
    const revAtCall = revisionOf(session);

    // applyChange 实际调用的生产函数：先捕获 base/revision，再构建 next
    const staged = captureOrdinaryChange(session, revAtCall, (prev) => withFirstSetReps(prev, 9));
    expect(staged).not.toBeNull();
    if (!staged) return;
    expect(staged.baseSession).toBe(session); // 真实 intent base，不是 next
    expect(staged.baseSession.exercises.some((e) => e.id === pairEx.id)).toBe(false);

    // pair 提交先落库（模拟 saveQueue 中排在普通输入之前的 paired 保存）
    const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: (fresh) => addExercise(fresh, pairEx), deps: saveDeps() });
    expect(pair.status).toBe('saved');
    if (pair.status !== 'saved') return;
    expect(pair.revision).toBeGreaterThan(revAtCall);

    // persist 队列执行时 confirmedRevision 已前进；必须用 staged 的原始 base 做 cold rebase
    const decision = await decideQueuedSessionWrite({
      sessionId: session.id,
      next: staged.next,
      baseSessionAtCall: staged.baseSession,
      baseRevisionAtCall: staged.baseRevisionAtCall,
      queueExecutionRevision: pair.revision,
      hasTemplateWrite: false,
      getSession,
      ownPriorCommit: null,
    });
    expect(decision.kind).toBe('save');
    if (decision.kind !== 'save') return;
    const saved = await atomicSaveSession({
      session: { ...decision.session, revision: decision.expectedRevision },
      guard: { editorId, expectedVersion: decision.expectedRevision },
    });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const final = (await getSession(session.id))!;
    expect(final.exercises.some((e) => e.id === pairEx.id)).toBe(true); // 新增动作保留
    expect(final.exercises[0].sets[0].reps).toBe(9); // 普通输入真实提交
  });

  it('普通输入先入队、pair 后提交：两者都保留', async () => {
    const { session, editorId } = await seed();
    const revAtCall = revisionOf(session);
    const staged = captureOrdinaryChange(session, revAtCall, (prev) => withFirstSetReps(prev, 7));
    expect(staged).not.toBeNull();
    if (!staged) return;

    const decision = await decideQueuedSessionWrite({
      sessionId: session.id,
      next: staged.next,
      baseSessionAtCall: staged.baseSession,
      baseRevisionAtCall: staged.baseRevisionAtCall,
      queueExecutionRevision: revAtCall,
      hasTemplateWrite: false,
      getSession,
      ownPriorCommit: null,
    });
    expect(decision.kind).toBe('save');
    if (decision.kind !== 'save') return;
    const saved = await atomicSaveSession({ session: { ...decision.session, revision: decision.expectedRevision }, guard: { editorId, expectedVersion: decision.expectedRevision } });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const pairEx = newExercise('背景新增', 'sex-r2-bg');
    const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: (fresh) => addExercise(fresh, pairEx), deps: saveDeps() });
    expect(pair.status).toBe('saved');

    const final = (await getSession(session.id))!;
    expect(final.exercises.some((e) => e.id === pairEx.id)).toBe(true);
    expect(final.exercises[0].sets[0].reps).toBe(7);
  });

  it('普通合并冲突时，救援草稿保留原始 base/revision，不把 paired 新动作当成“用户删除”', async () => {
    const { session, editorId } = await seed();
    const pairEx = newExercise('冲突新增', 'sex-r2-conflict');
    const revAtCall = revisionOf(session);
    const staged = captureOrdinaryChange(session, revAtCall, (prev) => withFirstSetReps(prev, 9));
    expect(staged).not.toBeNull();
    if (!staged) return;

    // pair 同时改同一组值并新增动作 → 普通输入 cold rebase 必须冲突，不能强写
    const pair = await commitPairedSession({
      sessionId: session.id,
      editorId,
      buildNext: (fresh) => withFirstSetReps(addExercise(fresh, pairEx), 10),
      deps: saveDeps(),
    });
    expect(pair.status).toBe('saved');
    if (pair.status !== 'saved') return;
    const fresh = (await getSession(session.id))!;

    const decision = await decideQueuedSessionWrite({
      sessionId: session.id,
      next: staged.next,
      baseSessionAtCall: staged.baseSession,
      baseRevisionAtCall: staged.baseRevisionAtCall,
      queueExecutionRevision: pair.revision,
      hasTemplateWrite: false,
      getSession,
      ownPriorCommit: null,
    });
    expect(decision.kind).toBe('conflict');

    // 生产 rememberDraft 使用 pendingDraftFromIntent(next, staged.baseSession, staged.baseRevisionAtCall, token)
    const rescue = pendingDraftFromIntent(staged.next, staged.baseSession, staged.baseRevisionAtCall, 501);
    expect(rescue.baseRevision).toBe(revAtCall);
    expect(rescue.baseSession.exercises).toHaveLength(1); // 原始 base：没有 paired 新动作
    expect(rescue.session.exercises).toHaveLength(1); // 原始意图：也没有新动作
    expect(fresh.exercises).toHaveLength(2); // 库里的 paired 新动作不丢
    expect(fresh.exercises[0].sets[0].reps).toBe(10);
  });
});
