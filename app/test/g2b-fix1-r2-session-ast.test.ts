/* G2B-FIX1-R2：从 Session.tsx **真实源码**抽取 applyChange / persist / rememberDraft，
   在受控 env 中跑「paired 在途 → 普通输入排队」的确定性重叠。

   这是根反馈 rev2/rev3 点名的“实际 applyChange→persist 链”证据：
   · 不手写 applyChange 替身，直接执行 Session.tsx 的 useCallback 源码；
   · paired 保存先进入 saveQueue（真实 atomic 事务），普通输入在它未完成时调用；
   · 断言普通输入真实落库，paired 新增动作保留；
   · 冲突场景断言救援草稿带原始 base/revision（不是 paired 后的新 base）。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSession, revisionOf } from '../src/db/tx';
import { getSession } from '../src/db/repo';
import { commitPairedSession } from '../src/lib/pairedCommit';
import * as merge from '../src/domain/draftMerge';
import * as rescue from '../src/lib/draftRescue';
import * as sessionWrite from '../src/lib/sessionWrite';
import { createSession } from '../src/domain/session';
import { exerciseTemplateFromConfig, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import type { Plan, Session, SessionExercise, StraightTarget } from '../src/domain/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(HERE, '../src/pages/session/useSessionPersistence.ts');
const SOURCE = readFileSync(SESSION_FILE, 'utf8');
const AST = ts.createSourceFile('Session.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function compile(exprSource: string, env: Record<string, unknown>) {
  const js = ts.transpileModule(`module.exports=(${exprSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(js, { ...env, module: mod, Promise, structuredClone, setTimeout, clearTimeout });
  return mod.exports as (...args: unknown[]) => unknown;
}
function extractCallback(name: string, env: Record<string, unknown>) {
  let src: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let v: ts.Expression = n.initializer;
      if (ts.isCallExpression(v) && v.arguments.length) v = v.arguments[0];
      if (ts.isArrowFunction(v)) src = v.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error(`Session.tsx 里找不到可抽取的 ${name}`);
  return compile(src, env);
}
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const NOW = 1_760_000_000_000;
function straight(): StraightTarget {
  return { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 };
}
function makePlan(): Plan {
  return { id: 'p-ast', name: 'AST', cursor: 0, createdAt: NOW, updatedAt: NOW, days: [{ id: 'd-ast', name: '胸 AST', kind: 'train', warmups: [], exercises: [{ id: 'pe-ast', exerciseId: 'lib-barbell-bench', name: '自由杠铃卧推', restSec: 120, target: straight() }] }] };
}
async function seed(): Promise<{ session: Session; editorId: string }> {
  const plan = makePlan();
  const session = createSession(plan, plan.days[0], NOW);
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  expect((await atomicAcquireLock(fresh.id, 'editor-ast')).ok).toBe(true);
  return { session: fresh, editorId: 'editor-ast' };
}
function newExercise(name: string, id: string): SessionExercise {
  const tpl = exerciseTemplateFromConfig({ exerciseId: `custom:${name}`, name, target: straight(), restSec: 90 });
  return { ...sessionExerciseFromTemplate(tpl), id };
}
function withFirstSetReps(s: Session, reps: number): Session {
  return { ...s, exercises: s.exercises.map((ex, i) => i === 0 ? { ...ex, sets: ex.sets.map((st, j) => j === 0 ? { ...st, reps } : st) } : ex) };
}
function addExercise(s: Session, ex: SessionExercise): Session {
  return s.exercises.some((e) => e.id === ex.id) ? s : { ...s, exercises: [...s.exercises, ex] };
}

interface Harness {
  env: Record<string, unknown>;
  refs: Record<string, { current: any }>;
  applyChange: (fn: (prev: Session) => Session) => Promise<merge.PersistOutcome> | 'not-executed';
  gate: { promise: Promise<void>; resolve: () => void };
  pairDone: Promise<void>;
}

function buildHarness(base: Session, editorId: string): Harness {
  let token = 0;
  const refs: Record<string, { current: any }> = {
    confirmedRevision: { current: revisionOf(base) },
    latestRef: { current: structuredClone(base) },
    baseSessionRef: { current: structuredClone(base) },
    viewBeforeRef: { current: null },
    unsavedDraft: { current: null },
    rescuedSeqRef: { current: null },
    ownPriorCommitRef: { current: null },
    saveQueue: { current: Promise.resolve() },
    lockBlockedRef: { current: false },
    editorId: { current: editorId },
    ownPublishedSeq: { current: 0 },
    adoptedRescueSeq: { current: 0 },
    pendingFromRescue: { current: false },
    rescueApplied: { current: false },
  };
  const messages: string[] = [];
  const env: Record<string, unknown> = {
    ...refs,
    sessionId: base.id,
    inputPaused: false,
    pausedNotice: () => {},
    nextDraftToken: () => ++token,
    accumulateDraftIntent: merge.accumulateDraftIntent,
    captureOrdinaryChange: sessionWrite.captureOrdinaryChange,
    decideQueuedSessionWrite: sessionWrite.decideQueuedSessionWrite,
    pendingDraftFromIntent: sessionWrite.pendingDraftFromIntent,
    getSession,
    pushToast: (m: string) => messages.push(m),
    setSaveState() {}, setLockBlocked() {}, setLockLostReason() {}, setConflictMessage() {},
    setHasPendingDraft() {}, setDraftConflicts() {},
    clearRescueDraft: rescue.clearRescueDraft,
    publishRescueDraft: rescue.publishRescueDraft,
    republishRebasedDraft: rescue.republishRebasedDraft,
    loadRescueRecord: rescue.loadRescueRecord,
    ackRescueDraft: rescue.ackRescueDraft,
    saveRescueDraft: rescue.saveRescueDraft,
    syncSessionLocal: (s: Session) => { refs.latestRef.current = s; },
    saveActiveSession: async (s: Session, args: { editorId: string; expectedRevision: number }) =>
      atomicSaveSession({ session: s, guard: { editorId: args.editorId, expectedVersion: args.expectedRevision } }),
  };
  const rememberDraft = extractCallback('rememberDraft', env);
  env.rememberDraft = rememberDraft;
  const persist = extractCallback('persist', env);
  env.persist = persist;
  const applyChange = extractCallback('applyChange', env) as unknown as Harness['applyChange'];
  const gate = deferred();
  const pairDone = (async () => { await gate.promise; })();
  return { env, refs, applyChange, gate, pairDone };
}

function queuePairBefore(h: Harness, run: () => Promise<void>): void {
  const prior = h.refs.saveQueue.current as Promise<void>;
  void prior;
  h.refs.saveQueue.current = (async () => {
    await h.gate.promise;
    await run();
  })();
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('G2B-FIX1-R2 actual applyChange→persist source execution', () => {
  it('paired 在途时普通输入：真实 applyChange 落库，新增动作保留', async () => {
    const { session, editorId } = await seed();
    const pairEx = newExercise('AST新增', 'sex-ast-add');
    const h = buildHarness(session, editorId);
    queuePairBefore(h, async () => {
      const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: (fresh) => addExercise(fresh, pairEx), deps: {
        getSession,
        save: async (s, guard) => atomicSaveSession({ session: s, guard: { editorId: guard.editorId, expectedVersion: guard.expectedRevision } }),
      } });
      expect(pair.status).toBe('saved');
      if (pair.status === 'saved') {
        h.refs.confirmedRevision.current = pair.revision;
        h.refs.baseSessionRef.current = pair.session;
        h.refs.latestRef.current = pair.session;
      }
    });
    const outcomePromise = h.applyChange((prev) => withFirstSetReps(prev, 9));
    expect(typeof outcomePromise).toBe('object');
    if (typeof outcomePromise === 'string') return;
    h.gate.resolve();
    const outcome = await outcomePromise;
    expect(outcome.status).toBe('saved');

    const final = (await getSession(session.id))!;
    expect(final.exercises.some((e) => e.id === pairEx.id)).toBe(true);
    expect(final.exercises[0].sets[0].reps).toBe(9);
  });

  it('合并冲突时真实 persist 的救援草稿带原始 base/revision', async () => {
    const { session, editorId } = await seed();
    const pairEx = newExercise('AST冲突', 'sex-ast-conflict');
    const h = buildHarness(session, editorId);
    queuePairBefore(h, async () => {
      const pair = await commitPairedSession({ sessionId: session.id, editorId, buildNext: (fresh) => withFirstSetReps(addExercise(fresh, pairEx), 10), deps: {
        getSession,
        save: async (s, guard) => atomicSaveSession({ session: s, guard: { editorId: guard.editorId, expectedVersion: guard.expectedRevision } }),
      } });
      expect(pair.status).toBe('saved');
      if (pair.status === 'saved') {
        h.refs.confirmedRevision.current = pair.revision;
        h.refs.baseSessionRef.current = pair.session;
        h.refs.latestRef.current = pair.session;
      }
    });
    const outcomePromise = h.applyChange((prev) => withFirstSetReps(prev, 9));
    if (typeof outcomePromise === 'string') throw new Error('applyChange not executed');
    h.gate.resolve();
    const outcome = await outcomePromise;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toBe('version-conflict');

    const draft = h.refs.unsavedDraft.current as { baseRevision: number; baseSession: Session; session: Session } | null;
    expect(draft).not.toBeNull();
    if (!draft) return;
    expect(draft.baseRevision).toBe(revisionOf(session));
    expect(draft.baseSession.exercises).toHaveLength(1); // 原始 base 没有 paired 新动作
    expect(draft.session.exercises).toHaveLength(1);
    const fresh = (await getSession(session.id))!;
    expect(fresh.exercises).toHaveLength(2);
    expect(fresh.exercises[0].sets[0].reps).toBe(10);
  });
});
