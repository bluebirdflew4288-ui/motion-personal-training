/* G2B-FIX1：成对提交（Session + 模板）全失败分支与队列旧快照安全。
   使用真实 fake-indexeddb + 实际 atomic 提交模块（非假算法）。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import {
  atomicAcquireLock,
  atomicCreateSession,
  atomicFinishSession,
  atomicSaveSession,
  atomicSaveSessionWithTemplate,
} from '../src/db/tx';
import { getSession } from '../src/db/repo';
import { listExerciseTemplates } from '../src/db/templates';
import { commitPairedSession, rebaseStaleSession } from '../src/lib/pairedCommit';
import { createSession } from '../src/domain/session';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import type { Plan, PlanDay, Session, SessionExercise, StraightTarget } from '../src/domain/types';

const NOW = 1_760_000_000_000;
function straight(): StraightTarget {
  return { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 };
}
function makePlan(): Plan {
  const day: PlanDay = { id: 'd1', name: '胸 A', kind: 'train', warmups: [], exercises: [{ id: 'pe1', exerciseId: 'lib-barbell-bench', name: '自由杠铃卧推', restSec: 120, target: straight() }] };
  return { id: 'p1', name: '计划', days: [day], cursor: 0, createdAt: NOW, updatedAt: NOW };
}
async function seed(): Promise<{ session: Session; editorId: string }> {
  const plan = makePlan();
  const session = createSession(plan, plan.days[0], NOW);
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  const editorId = 'editor-A';
  const lock = await atomicAcquireLock(fresh.id, editorId);
  expect(lock.ok).toBe(true);
  return { session: fresh, editorId };
}
function saveDeps() {
  return {
    getSession,
    save: async (session: Session, guard: { editorId: string; expectedRevision: number }, tw?: { template: any; expectedRevision: number | null }) =>
      tw
        ? atomicSaveSessionWithTemplate({
            session,
            guard: { sessionId: session.id, editorId: guard.editorId, expectedVersion: guard.expectedRevision },
            template: tw.template,
            templateExpectedRevision: tw.expectedRevision,
          })
        : atomicSaveSession({ session, guard: { editorId: guard.editorId, expectedVersion: guard.expectedRevision } }),
  };
}
function newExercise(name = '自定义推胸', id = 'sex-g2b-1'): SessionExercise {
  const t = exerciseTemplateFromConfig({
    exerciseId: `custom:${name}`,
    name,
    target: straight(),
    restSec: 120,
  });
  return { ...sessionExerciseFromTemplate(t), id };
}
function buildAdd(ex: SessionExercise) {
  return (fresh: Session) => (fresh.exercises.some((e) => e.id === ex.id) ? fresh : { ...fresh, exercises: [...fresh.exercises, ex] });
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('G2B-FIX1 paired success/failure branches', () => {
  it('成功：Session + 模板同一事务落库', async () => {
    const { session, editorId } = await seed();
    const ex = newExercise();
    const tpl = exerciseTemplateFromConfig({ exerciseId: ex.exerciseId, name: ex.name, target: ex.target, restSec: 120 });
    const r = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd(ex), templateWrite: { template: tpl, expectedRevision: null }, deps: saveDeps() });
    expect(r.status).toBe('saved');
    expect((await getSession(session.id))!.exercises.some((e) => e.id === ex.id)).toBe(true);
    expect((await listExerciseTemplates()).some((t) => t.exerciseId === ex.exerciseId)).toBe(true);
  });

  it('模板 meta 写入 abort：Session/模板都不变，同一实例可重试成功', async () => {
    const { session, editorId } = await seed();
    const ex = newExercise('失败重试', 'sex-retry');
    const tpl1 = exerciseTemplateFromConfig({ exerciseId: ex.exerciseId, name: ex.name, target: ex.target, restSec: 120 });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'meta' && (value as { key?: string })?.key?.startsWith('exercise-template:')) {
        throw new DOMException('injected paired failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    let failed;
    try {
      failed = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd(ex), templateWrite: { template: tpl1, expectedRevision: null }, deps: saveDeps() });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(failed.status).toBe('failed');
    expect((await getSession(session.id))!.exercises.some((e) => e.id === ex.id)).toBe(false);
    expect(await listExerciseTemplates()).toHaveLength(0);

    const tpl2 = exerciseTemplateFromConfig({ exerciseId: ex.exerciseId, name: ex.name, target: { ...straight(), sets: 4, setsMax: 4, repsMin: 6, repsMax: 10 }, restSec: 90 });
    const retried = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd({ ...ex, target: tpl2.target, restSec: 90 }), templateWrite: { template: tpl2, expectedRevision: null }, deps: saveDeps() });
    expect(retried.status).toBe('saved');
    const got = (await getSession(session.id))!.exercises.find((e) => e.id === ex.id)!;
    expect(got.target.kind === 'straight' && got.target.sets).toBe(4);
    expect((await listExerciseTemplates()).find((t) => t.exerciseId === ex.exerciseId)?.target.kind === 'straight').toBe(true);
  });

  it('store 方法 throw：失败返回 failed，不写任何数据', async () => {
    const { session } = await seed();
    const ex = newExercise('throw', 'sex-throw');
    const r = await commitPairedSession({
      sessionId: session.id,
      editorId: 'editor-A',
      buildNext: buildAdd(ex),
      deps: { getSession, save: async () => { throw new Error('injected store throw'); } },
    });
    expect(r.status).toBe('failed');
    expect((await getSession(session.id))!.exercises.some((e) => e.id === ex.id)).toBe(false);
  });

  it('锁丢失：失败且原 Session 不变', async () => {
    const { session } = await seed();
    const ex = newExercise('nolock', 'sex-nolock');
    // 释放锁：使用另一个 editor 的 acquire 无法抢到；直接改锁记录为过期/空
    await idbPut('meta', { key: `lock:${session.id}`, sessionId: session.id, editorId: '', at: 0 });
    const r = await commitPairedSession({ sessionId: session.id, editorId: 'editor-A', buildNext: buildAdd(ex), deps: saveDeps() });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(['no-lock', 'lock-lost']).toContain(r.reason);
    expect((await getSession(session.id))!.exercises.some((e) => e.id === ex.id)).toBe(false);
  });

  it('终态后提交：state-conflict，不复活', async () => {
    const { session, editorId } = await seed();
    const fin = await atomicFinishSession({ session: { ...session, endedAt: NOW + 1000 }, guard: { editorId, advanceCycle: false } });
    expect(fin.ok).toBe(true);
    const ex = newExercise('terminal', 'sex-terminal');
    const r = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd(ex), deps: saveDeps() });
    expect(r.status).toBe('failed');
    if (r.status === 'failed') expect(r.reason).toBe('state-conflict');
    expect((await getSession(session.id))!.status).toBe('completed');
  });
});

describe('G2B-FIX1 queue stale-snapshot safety', () => {
  it('pair→背景：paired 成功后基于最新库重放背景更新，两者保留', async () => {
    const { session, editorId } = await seed();
    const ex = newExercise('pair-first', 'sex-pair-first');
    const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd(ex), deps: saveDeps() });
    expect(pair.status).toBe('saved');
    const afterPair = (await getSession(session.id))!;
    const backgroundMine: Session = {
      ...session,
      exercises: session.exercises.map((e, i) => (i === 0 ? { ...e, sets: e.sets.map((st, j) => (j === 0 ? { ...st, reps: 15, status: 'done' as const } : st)) } : e)),
    };
    const merged = rebaseStaleSession(session, backgroundMine, afterPair);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const saved = await atomicSaveSession({ session: { ...merged.session, revision: afterPair.revision }, guard: { editorId, expectedVersion: afterPair.revision } });
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const final = (await getSession(session.id))!;
    expect(final.exercises.some((e) => e.id === ex.id)).toBe(true);
    expect(final.exercises[0].sets[0].reps).toBe(15);
  });

  it('背景→pair：paired 从最新 Session 构建，不覆盖背景更新', async () => {
    const { session, editorId } = await seed();
    const background: Session = {
      ...session,
      exercises: session.exercises.map((e) => ({ ...e, sets: e.sets.map((st, j) => (j === 0 ? { ...st, reps: 7, status: 'done' as const } : st)) })),
    };
    const bgSave = await atomicSaveSession({ session: { ...background, revision: session.revision }, guard: { editorId, expectedVersion: session.revision ?? 0 } });
    expect(bgSave.ok, JSON.stringify(bgSave)).toBe(true);
    const ex = newExercise('bg-first', 'sex-bg-first');
    const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: buildAdd(ex), deps: saveDeps() });
    expect(pair.status).toBe('saved');
    const final = (await getSession(session.id))!;
    expect(final.exercises.some((e) => e.id === ex.id)).toBe(true);
    expect(final.exercises[0].sets[0].reps).toBe(7);
  });
});
