/* A06c：用**真实 Session 回调**（AST 抽取 rememberDraft / persist / adoptRescueRecord /
   retryUnsaved / cleanup）验证审查点名的两个确定性场景。

   ── 为什么必须用真实回调 ──────────────────────────────────────
   审查明确要求“不要只用手工 save/load helper 测试”。前两轮探针之所以能抓到
   A06（以及第二轮的回归），正是因为执行的是真实 persist/rememberDraft 失败路径
   与真实 adoptRescue 接线；手写替身会“实现得和预期一样”，掩盖接线缺口。

   ── 两个必测场景（审查给出）────────────────────────────────
     S1：两笔排队失败 1 → 15，新实例必须收到**最新的 15**，重试后库里是 15；
     S2：最新的 15 在“重试 1 正在提交”期间到达，那次提交成功**不得**清掉 15，
         15 必须仍为 pending。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle } from '../src/db/idb';
import * as tx from '../src/db/tx';
import * as repo from '../src/db/repo';
import * as locks from '../src/lib/lock';
import * as dbLocks from '../src/db/locks';
import * as rescue from '../src/lib/draftRescue';
import * as sessionWrite from '../src/lib/sessionWrite';
import * as domain from '../src/domain/session';
import * as merge from '../src/domain/draftMerge';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Session } from '../src/domain/types';

const SESSION_FILE = resolve(process.cwd(), 'src/pages/session/useSessionPersistence.ts');
const SOURCE = readFileSync(SESSION_FILE, 'utf8');
const AST = ts.createSourceFile(SESSION_FILE, SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function compile(exprSource: string, env: Record<string, unknown>) {
  const code = ts.transpileModule(`module.exports=(${exprSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(code, { ...env, module: mod, Promise, structuredClone, setInterval, clearInterval, setTimeout });
  return mod.exports as (...args: unknown[]) => unknown;
}

/** 抽取 `const <name> = useCallback(...)` 的真实回调体 */
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
  if (!src) throw new Error(`找不到可抽取的 ${name}`);
  return compile(src, env);
}

/** 抽取真实的救援订阅 effect（含 watchRescueDraft 接线）并返回其 cleanup */
function extractRescueEffect(env: Record<string, unknown>) {
  let src: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(AST) === 'useEffect') {
      const cb = n.arguments[0];
      if (cb && cb.getText(AST).includes('const stopWatch = watchRescueDraft')) src = cb.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error('找不到救援订阅 effect');
  const code = ts.transpileModule(`module.exports=${src};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(code, { ...env, module: mod, Promise, structuredClone, setInterval, clearInterval, setTimeout });
  return (mod.exports as () => unknown)();
}

/** 抽取生命周期 cleanup */
function extractCleanup(env: Record<string, unknown>) {
  let src: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(AST) === 'useEffect') {
      const cb = n.arguments[0];
      if (cb && cb.getText(AST).includes('const coordinator = lifecycle.current')) {
        const body = (cb as ts.ArrowFunction).body;
        if (ts.isBlock(body)) {
          const ret = body.statements.find(
            (st) => ts.isReturnStatement(st) && st.expression && ts.isArrowFunction(st.expression),
          );
          if (ret && ts.isReturnStatement(ret) && ret.expression) src = (ret.expression as ts.ArrowFunction).getText(AST);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error('找不到生命周期 cleanup');
  return compile(src, env);
}

function installStorage() {
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
  return map;
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const repsAt = (s: Session | undefined | null): number | null =>
  s ? ((s.exercises[0]?.sets[0]?.reps as number | null) ?? null) : null;

/** 从 PendingDraft 里读 reps（避免把 draft 当 Session 传） */
const repsOfDraft = (d: { session: Session } | null | undefined): number | null =>
  d ? repsAt(d.session) : null;

/** 建会话 + 造一套「旧实例 env」 */
async function setup(lockOwner = 'ed-old') {
  const plan = createV32Plan(1_760_000_000_000);
  const init = domain.createSession(plan, plan.days[0], 1_760_000_000_000);
  init.id = `a06c-${Math.random().toString(36).slice(2, 8)}`;
  const created = await tx.atomicCreateSession({ session: init });
  if (!created.ok) throw new Error('create failed');
  const base: Session = created.session;
  expect((await locks.acquireSessionLock(base.id, lockOwner)).ok).toBe(true);
  (globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }).sessionStorage.setItem(
    'motion-editor-id',
    lockOwner,
  );
  return base;
}

/** 造一个与 Session 同构的 env（可在旧/新实例间共享 refs） */
interface EnvBag {
  // 动态挂载的抽取回调（persist / retryUnsaved / adoptRescueRecord ...）
  [key: string]: unknown;
}

/** 测试实际会读写的 ref（其余 ref 保持动态，避免过度建模） */
interface EnvRefs {
  unsavedDraft: { current: merge.PendingDraft | null };
  rescuedSeqRef: { current: number | null };
  saveQueue: { current: Promise<void> };
  editorId: { current: string };
  [key: string]: { current: unknown };
}

function makeEnv(args: {
  base: Session;
  sessionId: string;
  editorId: string;
  saveActiveSession: (s: Session, o: { editorId: string; expectedRevision: number }) => Promise<unknown>;
  messages: string[];
  tokenStart?: number;
}): { env: EnvBag; refs: EnvRefs } {
  let tokenSeq = args.tokenStart ?? 0;
  const refs = {
    confirmedRevision: { current: args.base.revision },
    latestRef: { current: structuredClone(args.base) as Session },
    baseSessionRef: { current: structuredClone(args.base) as Session },
    viewBeforeRef: { current: structuredClone(args.base) as Session | null },
    unsavedDraft: { current: null as merge.PendingDraft | null },
    rescuedSeqRef: { current: null as number | null },
    ownPriorCommitRef: { current: null as { revision: number; intent: Session } | null },
    pendingFromRescue: { current: false },
    adoptedRescueSeq: { current: 0 },
    ownPublishedSeq: { current: 0 },
    rescueApplied: { current: false },
    saveQueue: { current: Promise.resolve() },
    lockBlockedRef: { current: false },
    editorId: { current: args.editorId },
    busyOwnerRef: { current: null as 'retry' | 'takeover' | null },
    busyOwner: { current: null as 'retry' | 'takeover' | null },
    intentionallyClosed: { current: false },
    finishGuard: { current: false },
  };
  const env: Record<string, unknown> = {
    ...refs,
    sessionId: args.sessionId,
    cancelled: false,
    heartbeat: 0,
    window: { clearInterval() {}, setInterval: () => 0 },
    unlisten() {},
    stopListening() {},
    releaseSessionLock: locks.releaseSessionLock,
    nextDraftToken: () => ++tokenSeq,
    accumulateDraftIntent: merge.accumulateDraftIntent,
    mergeDraftOntoFresh: merge.mergeDraftOntoFresh,
    decideQueuedSessionWrite: sessionWrite.decideQueuedSessionWrite,
    pendingDraftFromIntent: sessionWrite.pendingDraftFromIntent,
    publishRescueDraft: rescue.publishRescueDraft,
    republishRebasedDraft: rescue.republishRebasedDraft,
    ackRescueDraft: rescue.ackRescueDraft,
    clearRescueDraft: rescue.clearRescueDraft,
    loadRescueDraft: rescue.loadRescueDraft,
    loadRescueRecord: rescue.loadRescueRecord,
    watchRescueDraft: rescue.watchRescueDraft,
    pushToast: (m: string) => args.messages.push(m),
    setSaveState() {},
    setLockBlocked() {},
    setLockLostReason() {},
    setConflictMessage() {},
    setHasPendingDraft() {},
    setDraftConflicts() {},
    setBusyOwner(v: 'retry' | 'takeover' | null) {
      refs.busyOwner.current = v;
    },
    syncSessionLocal: (s: Session) => {
      refs.latestRef.current = s;
    },
    saveActiveSession: args.saveActiveSession,
    refreshSessions: async () => {},
    getSession: repo.getSession,
    revisionOf: tx.revisionOf,
    acquireSessionLockDetailed: locks.acquireSessionLockDetailed,
    takeOwnershipOnMount: locks.takeOwnershipOnMount,
  };
  return { env: env as EnvBag, refs: refs as unknown as EnvRefs };
}

/** 把 env 里互相引用的真实回调补齐（persist 依赖 rememberDraft 等） */
function wire(env: Record<string, unknown>) {
  env.rememberDraft = extractCallback('rememberDraft', env);
  env.persist = extractCallback('persist', env);
  env.adoptRescueRecord = extractCallback('adoptRescueRecord', env);
  env.beginBusy = extractCallback('beginBusy', env);
  env.endBusy = extractCallback('endBusy', env);
  env.applyPendingDraft = extractCallback('applyPendingDraft', env);
  env.retryUnsaved = extractCallback('retryUnsaved', env);
  return env;
}

describe('A06c · 真实 Session 回调的双场景验证', () => {
  beforeEach(() => {
    __resetDbHandle();
    installStorage();
    (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = class {
      onmessage: unknown = null;
      postMessage() {}
      close() {}
    };
  });

  it('S1：两笔排队失败 1→15，新实例收到最新 15，重试后库里是 15', async () => {
    const base = await setup();
    const sid = base.id;
    const messages: string[] = [];
    const outcomes: string[] = [];
    const gate = deferred();
    const entered = deferred();

    // 旧实例：受控慢写入
    const old = makeEnv({
      base,
      sessionId: sid,
      editorId: 'ed-old',
      messages,
      saveActiveSession: async (s, o) => {
        entered.resolve();
        await gate.promise;
        const r = await tx.atomicWriteSession({
          intent: { kind: 'active-save' },
          session: s,
          editorId: o.editorId,
          expectedRevision: o.expectedRevision,
        });
        outcomes.push(r.ok ? 'saved' : r.reason);
        return r;
      },
    });
    wire(old.env as unknown as Record<string, unknown>);
    const patch = (s: Session, reps: number) =>
      domain.withSet(s, s.exercises[0].id, s.exercises[0].sets[0].id, { reps });

    // 排队 1 → 15（两笔都挂在 gate 上）
    void (old.env.persist as (s: Session) => Promise<unknown>)(patch(base, 1));
    void (old.env.persist as (s: Session) => Promise<unknown>)(patch(base, 15));
    await entered.promise;
    // 注意：pending 只在**写入失败后**才由 rememberDraft 产生，
    // 此刻两笔还在 gate 上挂着，所以这时 pending 仍是空的（不是缺陷）。

    // 浏览器 hash 返回：跑真实 cleanup（绕过守卫）
    (extractCleanup(old.env as unknown as Record<string, unknown>) as () => void)();

    // 新实例：接手 + 真实救援订阅
    const newMessages: string[] = [];
    const nw = makeEnv({
      base,
      sessionId: sid,
      editorId: 'ed-new',
      messages: newMessages,
      saveActiveSession: (s, o) => tx.atomicWriteSession({
        intent: { kind: 'active-save' },
        session: s,
        editorId: o.editorId,
        expectedRevision: o.expectedRevision,
      }),
      tokenStart: 100,
    });
    wire(nw.env as unknown as Record<string, unknown>);
    const ownership = await locks.takeOwnershipOnMount({ sessionId: sid, editorId: 'ed-new' });
    expect(ownership.ok).toBe(true);

    // 启动真实救援订阅 effect（挂载时读一次 + 持续 watch）
    const stopWatch = extractRescueEffect(nw.env as unknown as Record<string, unknown>) as () => void;

    // 放行旧写入：两笔都 lock-lost，第二名会把 15 发布到救援位
    gate.resolve();
    await old.refs.saveQueue.current;
    for (let i = 0; i < 60; i++) await Promise.resolve();
    // 等 watch 轮询检出新版本
    const deadline = Date.now() + 1500;
    while (repsAt(nw.refs.unsavedDraft.current?.session ?? null) !== 15 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // ① 真实失败路径
    expect(outcomes).toEqual(['lock-lost', 'lock-lost']);
    // ② 新实例的 pending 已经是**最新的 15**（不是第一版的 1）
    expect(repsAt(nw.refs.unsavedDraft.current?.session ?? null)).toBe(15);
    expect(nw.env.hasPendingDraft).toBeUndefined(); // 仅状态函数，不参与断言

    // ③ 用真实 retryUnsaved 提交
    await (nw.env.retryUnsaved as () => Promise<void>)();
    stopWatch();

    // ④ 库里真的是 15
    const stored = await repo.getSession(sid);
    expect(repsAt(stored)).toBe(15);
    // ⑤ 救援位已被正确确认清除
    expect(rescue.loadRescueDraft(sid)).toBeNull();
  }, 30000);

  it('S2：最新的 15 在「重试 1 提交中」到达，那次成功不得清掉 15', async () => {
    const base = await setup();
    const sid = base.id;

    const nwMessages: string[] = [];
    const commitGate = deferred();
    const committing = deferred();

    const nw = makeEnv({
      base,
      sessionId: sid,
      editorId: 'ed-new',
      messages: nwMessages,
      tokenStart: 200,
      // 受控提交：进入即挂起，模拟“正在保存 1”
      saveActiveSession: async (s, o) => {
        committing.resolve();
        await commitGate.promise;
        return tx.atomicWriteSession({
          intent: { kind: 'active-save' },
          session: s,
          editorId: o.editorId,
          expectedRevision: o.expectedRevision,
        });
      },
    });
    wire(nw.env as unknown as Record<string, unknown>);
    expect((await locks.takeOwnershipOnMount({ sessionId: sid, editorId: 'ed-new' })).ok).toBe(true);

    // 新实例先接住第 1 版救援（1）
    const seq1 = (rescue.publishRescueDraft(sid, {
      token: 1,
      session: domain.withSet(base, base.exercises[0].id, base.exercises[0].sets[0].id, { reps: 1 }),
      baseRevision: base.revision ?? 0,
      baseSession: base,
    }) ?? 0) as number;
    const rec1 = rescue.loadRescueRecord(sid);
    expect(rec1).not.toBeNull();
    (nw.env.adoptRescueRecord as (r: unknown, s: string) => void)(rec1, 'mount');
    expect(repsAt(nw.refs.unsavedDraft.current?.session ?? null)).toBe(1);

    // 开始重试（提交 1）—— 挂起在提交中
    const retryPromise = (nw.env.retryUnsaved as () => Promise<void>)();
    await committing.promise;

    // 提交期间，更新的 15 到达（模拟旧实例迟到的失败写入）
    const seq15 = (rescue.publishRescueDraft(sid, {
      token: 1,
      session: domain.withSet(base, base.exercises[0].id, base.exercises[0].sets[0].id, { reps: 15 }),
      baseRevision: base.revision ?? 0,
      baseSession: base,
    }) ?? 0) as number;
    expect(seq15).toBeGreaterThan(seq1);

    // 放行这次提交（它保存的是 1）
    commitGate.resolve();
    await retryPromise;
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // 关键断言：库确实写入了 1（这次提交本身成功）
    const stored1 = await repo.getSession(sid);
    expect(repsAt(stored1)).toBe(1);

    // 但 15 **绝不能被这次成功清掉**
    const stillRescued = rescue.loadRescueDraft(sid);
    expect(repsOfDraft(stillRescued)).toBe(15);

    // 并且本页 pending 仍然保留 15（不会因为“已保存”提示而丢失）
    expect(repsAt(nw.refs.unsavedDraft.current?.session ?? null)).toBe(15);

    /**
     * 再点一次「重试保存」—— 审查要求的行为：
     * 同一意图 1→15 的演进**不是**外部冲突，第二次重试必须真正把 15 落库。
     *
     * 这就是原缺陷的核心：旧实现把「库里自己刚写的 1」当成外部改动，
     * 让 15 永远存不进去（或直接清掉 15）。修复后：
     *   · base 用 D1（原始意图 1），mine 用 D2（15），fresh 用 C（库里的 1 + 别处的 20）
     *   · 20 不在 D1/D2 变化范围 → 保留 fresh 的 20
     *   · 15 相对 D1 变了、fresh 没变 → 采用 15
     */
    const retry2 = (nw.env.retryUnsaved as () => Promise<void>)();
    await retry2;
    for (let i = 0; i < 30; i++) await Promise.resolve();

    const finalStored = await repo.getSession(sid);
    expect(repsAt(finalStored)).toBe(15); // 同一意图的后续增量真正落库
    expect(rescue.loadRescueDraft(sid)).toBeNull(); // 全部落库后救援位清空
    expect(nw.refs.unsavedDraft.current).toBeNull(); // pending 也清空
    void dbLocks;
  }, 30000);
});
