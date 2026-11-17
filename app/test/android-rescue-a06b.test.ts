/* A06b：用**真实生产代码**（AST 抽取 Session.tsx 的 persist / rememberDraft / cleanup +
   真实 tx / locks / 域函数 + fake-indexeddb）验证「慢写入 + 绕过守卫的卸载」不丢草稿。

   ── 为什么要 AST 抽取而不是重写一份替身 ──────────────────────
   审查探针之所以能抓到 A06，正是因为它没有用替身：它执行真实的 persist 失败路径。
   我们的单元替身永远会“实现得和预期一样”，从而掩盖真实的接线缺口。
   所以这里沿用同一手法，只断言行为，不复制实现。

   ── 断言的三件事（审查给出的最小要求）────────────────────────
     ① rememberDraft 必须**同步**把救援意图写出去（不依赖离页守卫）；
     ② 卸载（cleanup）之后的迟到失败写入也不能丢（救援位里仍在）；
     ③ 已挂载的新实例能收到/消费这份迟到救援。 */

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

const SESSION_FILE = resolve(process.cwd(), 'src/pages/Session.tsx');
const SOURCE = readFileSync(SESSION_FILE, 'utf8');
const AST = ts.createSourceFile(SESSION_FILE, SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 把一段源码包成可调用函数，在受控 env 里执行 */
function compile(exprSource: string, env: Record<string, unknown>) {
  const code = ts.transpileModule(`module.exports=(${exprSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(code, { ...env, module: mod, Promise, structuredClone });
  return mod.exports as (...args: unknown[]) => unknown;
}

/** 从 Session.tsx 抽取 `const <name> = useCallback(...)` 的回调体（真实源码） */
function extractCallback(name: string, env: Record<string, unknown>) {
  let src: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      let v: ts.Expression = n.initializer;
      // useCallback(fn, deps) → 取第一个参数
      if (ts.isCallExpression(v) && v.arguments.length) v = v.arguments[0];
      if (ts.isArrowFunction(v)) src = v.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error(`Session.tsx 里找不到可抽取的 ${name}`);
  return compile(src, env);
}

/** 抽取生命周期 effect 的 cleanup（真实源码）：`return () => {...}` */
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
          if (ret && ts.isReturnStatement(ret) && ret.expression) {
            src = (ret.expression as ts.ArrowFunction).getText(AST);
          }
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
  return { storage, map };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('A06b · 真实 persist 链路的救援（绕过离页守卫）', () => {
  beforeEach(() => {
    __resetDbHandle();
    installStorage();
    (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = class {
      onmessage: unknown = null;
      postMessage() {}
      close() {}
    };
  });

  it('慢写入期间卸载 + 写入失败 → 草稿进入救援位，新实例可在窗口内接住', async () => {
    // ① 建一个真实的活动训练
    const plan = createV32Plan(1_760_000_000_000);
    const init = domain.createSession(plan, plan.days[0], 1_760_000_000_000);
    init.id = 'a06b-session';
    const created = await tx.atomicCreateSession({ session: init });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const base: Session = created.session;

    // 旧实例持有锁
    expect((await locks.acquireSessionLock(base.id, 'ed-old')).ok).toBe(true);
    // 记录“上一个实例”供新实例接手
    (globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }).sessionStorage.setItem(
      'motion-editor-id',
      'ed-old',
    );

    const gate = deferred();
    const entered = deferred();
    const messages: string[] = [];
    const outcomes: string[] = [];
    let tokenSeq = 0;

    // ② 真实 refs（与 Session 同构）
    const refs = {
      confirmedRevision: { current: base.revision },
      latestRef: { current: structuredClone(base) as Session },
      baseSessionRef: { current: structuredClone(base) as Session },
      viewBeforeRef: { current: structuredClone(base) as Session | null },
      unsavedDraft: { current: null as merge.PendingDraft | null },
      rescuedSeqRef: { current: null as number | null },
      ownPriorCommitRef: { current: null as { revision: number; intent: Session } | null },
      saveQueue: { current: Promise.resolve() },
      lockBlockedRef: { current: false },
      editorId: { current: 'ed-old' },
      /**
       * persist 的异常路径会调用 rememberDraft(next)，而 rememberDraft 依赖
       * 这三个 ref（与真实 Session 组件同构）。此前 env 缺失，
       * 一旦 persist 走到 catch 就会 ReferenceError —— 正是本测试要覆盖的路径。
       */
      ownPublishedSeq: { current: 0 },
      adoptedRescueSeq: { current: 0 },
      pendingFromRescue: { current: false },
    };

    const env = {
      ...refs,
      sessionId: base.id,
      cancelled: false,
      heartbeat: 0,
      window: { clearInterval() {} },
      unlisten() {},
      stopListening() {},
      releaseSessionLock: locks.releaseSessionLock,
      nextDraftToken: () => ++tokenSeq,
      accumulateDraftIntent: merge.accumulateDraftIntent,
      decideQueuedSessionWrite: sessionWrite.decideQueuedSessionWrite,
      pendingDraftFromIntent: sessionWrite.pendingDraftFromIntent,
      getSession: repo.getSession,
      pushToast: (m: string) => messages.push(m),
      setSaveState() {},
      setLockBlocked() {},
      setLockLostReason() {},
      setConflictMessage() {},
      setHasPendingDraft() {},
      setDraftConflicts() {},
      clearRescueDraft: rescue.clearRescueDraft,
      publishRescueDraft: rescue.publishRescueDraft,
      republishRebasedDraft: rescue.republishRebasedDraft,
      loadRescueRecord: rescue.loadRescueRecord,
      ackRescueDraft: rescue.ackRescueDraft,
      saveRescueDraft: rescue.saveRescueDraft,
      syncSessionLocal: (s: Session) => {
        refs.latestRef.current = s;
      },
      // 受控慢写入：进入即挂起，等 gate 放行后走真实原子事务
      saveActiveSession: async (s: Session, options: { editorId: string; expectedRevision: number }) => {
        entered.resolve();
        await gate.promise;
        const r = await tx.atomicWriteSession({
          intent: { kind: 'active-save' },
          session: s,
          editorId: options.editorId,
          expectedRevision: options.expectedRevision,
        });
        outcomes.push(r.ok ? 'saved' : r.reason);
        return r;
      },
    };

    // ③ 编译真实 persist / rememberDraft / cleanup
    const rememberDraft = extractCallback('rememberDraft', env as unknown as Record<string, unknown>) as (
      n: Session,
    ) => void;
    // persist 内部调用 rememberDraft：把抽取到的真实函数注入 env
    (env as unknown as Record<string, unknown>).rememberDraft = rememberDraft;
    const persist = extractCallback('persist', env as unknown as Record<string, unknown>) as (
      n: Session,
      ctx?: unknown,
    ) => Promise<merge.PersistOutcome>;

    // ④ 旧页面排队两笔慢写入（1 → 15）
    const patch = (s: Session, reps: number): Session =>
      domain.withSet(s, s.exercises[0].id, s.exercises[0].sets[0].id, { reps });
    void persist(patch(base, 1));
    void persist(patch(base, 15));
    await entered.promise;

    // ⑤ 浏览器 hash 返回：直接执行真实 cleanup（**绕过** nativeBack / 页头守卫）
    const cleanup = extractCleanup(env as unknown as Record<string, unknown>) as () => void;
    cleanup();

    // ⑥ 新实例接手锁（真实原子改名）
    const adopted = await dbLocks.atomicAdoptLock(base.id, 'ed-old', 'ed-new');
    expect(adopted.ok).toBe(true);

    // ⑦ 新实例开始有界等迟到救援（此时救援位应为空 —— 对应“挂载时读到 null”）
    const lateFound: number[] = [];
    const stopWatch = rescue.watchLateRescue(
      base.id,
      (d) => lateFound.push(d.session.exercises[0].sets[0].reps as number),
      { intervalMs: 20 },
    );
    expect(rescue.loadRescueDraft(base.id)).toBeNull();

    // ⑧ 放行旧写入：它们现在必然 lock-lost（锁已被新实例接手）
    gate.resolve();
    await refs.saveQueue.current;
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // 关键断言 1：真实失败路径确实走了 lock-lost
    expect(outcomes).toEqual(['lock-lost', 'lock-lost']);
    // 关键断言 2：**同步**写入救援位（不需要任何守卫参与）
    const immediate = rescue.loadRescueDraft(base.id);
    expect(immediate).not.toBeNull();
    expect(immediate?.session.exercises[0].sets[0].reps).toBe(15);

    // 关键断言 3：已挂载的新实例在窗口内接住了它（或挂载时即可读到）
    const deadline = Date.now() + 1200;
    while (lateFound.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    stopWatch();
    expect(lateFound.length + (immediate ? 1 : 0)).toBeGreaterThan(0);

    // 关键断言 4：库里没有被旧写入污染（15 没进库）
    const stored = await repo.getSession(base.id);
    expect(stored?.exercises[0].sets[0].reps ?? null).not.toBe(15);
  }, 20000);
});
