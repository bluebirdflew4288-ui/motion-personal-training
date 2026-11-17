/* A06d · F1 绑定漏口守护：retry 入口抓到 pending=1 后，await 期间最新意图升级到 15(seq2)。
   ── 独立复验给出的真实失败链 ────────────────────────────────
     1. retryUnsaved 入口：const pending = unsavedDraft.current  → 抓到旧 1
     2. 随后 await acquireSessionLockDetailed / refreshSessions / getSession 期间
        旧实例的 15 经真实 watch/adopt 成为当前意图，rescuedSeqRef 推进到 2
     3. 拿到 fresh 后提交的仍是**旧的 pending 1**
     4. 旧实现在 expect() 里写 reservedSeq: rescuedSeqRef.current → 读到 2
        → 提交 1 成功时确认了 seq2 → 把 15 删掉
        结果 DB=[1,20,null]、pending/rescue 全清、第二次 retry 提示“没有待保存的改动”

   修法：
     · retry / tryTakeOver 在**读取 pending 的同一同步时刻**冻结 (pending, seq) 快照对；
     · 这对快照一路传到 applyPendingDraft → expect → persist；
     · persist 用 `'reservedSeq' in ctx` 判定，**尊重显式 null**，绝不 `??` 回退到当前 ref。

   本文件直接跑真实 persist / rememberDraft / retryUnsaved / applyPendingDraft 回调，
   并复现上述 await 窗口。 */

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
import * as rescue from '../src/lib/draftRescue';
import * as sessionWrite from '../src/lib/sessionWrite';
import * as domain from '../src/domain/session';
import * as merge from '../src/domain/draftMerge';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Session } from '../src/domain/types';

const SESSION_FILE = resolve(process.cwd(), 'src/pages/Session.tsx');
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

const repsAt = (s: Session | null | undefined): number | null =>
  s ? ((s.exercises[0]?.sets[0]?.reps as number | null) ?? null) : null;

function makeEnv(args: {
  base: Session;
  sessionId: string;
  editorId: string;
  saveActiveSession: (s: Session, o: { editorId: string; expectedRevision: number }) => Promise<unknown>;
  messages: string[];
  tokenStart?: number;
}) {
  let tokenSeq = args.tokenStart ?? 0;
  const refs = {
    confirmedRevision: { current: args.base.revision ?? 0 },
    latestRef: { current: structuredClone(args.base) as Session },
    baseSessionRef: { current: structuredClone(args.base) as Session },
    viewBeforeRef: { current: structuredClone(args.base) as Session | null },
    unsavedDraft: { current: null as merge.PendingDraft | null },
    rescuedSeqRef: { current: null as number | null },
    ownPriorCommitRef: { current: null as { revision: number; intent: Session } | null },
    ownPublishedSeq: { current: 0 },
    adoptedRescueSeq: { current: 0 },
    pendingFromRescue: { current: false },
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
    takeOverSessionLock: locks.takeOverSessionLock,
  };
  return { env, refs };
}

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

describe('A06d · retry 入口 await 窗口内意图升级（F1 绑定）', () => {
  beforeEach(() => {
    __resetDbHandle();
    installStorage();
    (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel = class {
      onmessage: unknown = null;
      postMessage() {}
      close() {}
    };
  });

  it('await getSession 期间意图 1→15 升级，提交 1 时不得确认 15 那一版', async () => {
    // ① 真实会话
    const plan = createV32Plan(1_760_000_000_000);
    const init = domain.createSession(plan, plan.days[0], 1_760_000_000_000);
    init.id = 'a06d-window';
    const created = await tx.atomicCreateSession({ session: init });
    if (!created.ok) throw new Error('create failed');
    const base: Session = created.session;
    expect((await locks.acquireSessionLock(base.id, 'ed-old')).ok).toBe(true);
    (globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }).sessionStorage.setItem(
      'motion-editor-id',
      'ed-old',
    );

    const messages: string[] = [];
    let gateGetSession: (() => void) | null = null;

    const { env, refs } = makeEnv({
      base,
      sessionId: base.id,
      editorId: 'ed-old',
      messages,
      // 正常走真实事务（不注入 abort）
      saveActiveSession: (s, o) =>
        tx.atomicWriteSession({
          intent: { kind: 'active-save' },
          session: s,
          editorId: o.editorId,
          expectedRevision: o.expectedRevision,
        }),
    });

    // 让 getSession 可被“挂住”，用来精确复现 await 窗口
    const realGetSession = repo.getSession;
    let holdNextGet = false;
    env.getSession = async (id: string) => {
      if (holdNextGet) {
        holdNextGet = false;
        await new Promise<void>((r) => {
          gateGetSession = r;
        });
      }
      return realGetSession(id);
    };

    wire(env);

    // ② 新实例接管
    expect((await locks.takeOwnershipOnMount({ sessionId: base.id, editorId: 'ed-new' })).ok).toBe(true);
    refs.editorId.current = 'ed-new';

    // ③ 先让 pending = 1（pub1），模拟“入口抓到的旧意图”
    const patch = (s: Session, reps: number) =>
      domain.withSet(s, s.exercises[0].id, s.exercises[0].sets[0].id, { reps });
    const seq1 = rescue.publishRescueDraft(base.id, {
      token: 1,
      session: patch(base, 1),
      baseRevision: base.revision ?? 0,
      baseSession: base,
    }) as number;
    const rec1 = rescue.loadRescueRecord(base.id)!;
    (env.adoptRescueRecord as (r: unknown, s: string) => void)(rec1, 'mount');
    refs.rescuedSeqRef.current = seq1;
    expect(repsAt(refs.unsavedDraft.current?.session)).toBe(1);

    // ④ 关键：让下一次 getSession 挂住（这一挂就是 await 窗口）
    holdNextGet = true;
    const retryPromise = (env.retryUnsaved as () => Promise<void>)();

    // 等到 getSession 真的被挂住
    const deadline = Date.now() + 1000;
    while (!gateGetSession && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(gateGetSession).not.toBeNull();

    // ⑤ 在窗口内：旧意图 15 到达（真实 publish → 真实 adopt 推进当前 seq）
    const seq2 = rescue.publishRescueDraft(base.id, {
      token: 1, // 同 token：同一意图的演进
      session: patch(base, 15),
      baseRevision: base.revision ?? 0,
      baseSession: base,
    }) as number;
    expect(seq2).toBeGreaterThan(seq1);
    const rec2 = rescue.loadRescueRecord(base.id)!;
    (env.adoptRescueRecord as (r: unknown, s: string) => void)(rec2, 'late');
    // 此刻当前意图已是 15、当前 seq 已是 seq2
    expect(repsAt(refs.unsavedDraft.current?.session)).toBe(15);
    expect(refs.rescuedSeqRef.current).toBe(seq2);

    // ⑥ 放行 getSession → 用**入口冻结的旧 pending=1** 提交
    (gateGetSession as unknown as () => void)();
    await retryPromise;
    for (let i = 0; i < 40; i++) await Promise.resolve();

    // ⑦ 决定性断言：提交的是 1，所以【15 必须还在】pending/rescue 里
    const recAfter = rescue.loadRescueRecord(base.id);
    expect(recAfter).not.toBeNull(); // 没有被误清
    expect(repsAt(recAfter?.session)).toBe(15);
    expect(repsAt(refs.unsavedDraft.current?.session)).toBe(15);

    const dbAfter = await realGetSession(base.id);
    expect(repsAt(dbAfter)).toBe(1); // 这次只提交了 1

    // ⑧ 第二次 retry 把 15 真正落库，并且清空
    await (env.retryUnsaved as () => Promise<void>)();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const dbFinal = await realGetSession(base.id);
    expect(repsAt(dbFinal)).toBe(15);
    expect(refs.unsavedDraft.current).toBeNull();
    expect(rescue.loadRescueRecord(base.id)).toBeNull();
  }, 30000);

  it('persist 尊重显式 null：没对应救援版本时不得回退到当前 seq', async () => {
    const plan = createV32Plan(1_760_000_000_000);
    const init = domain.createSession(plan, plan.days[0], 1_760_000_000_000);
    init.id = 'a06d-null';
    const created = await tx.atomicCreateSession({ session: init });
    if (!created.ok) throw new Error('create failed');
    const base: Session = created.session;
    expect((await locks.acquireSessionLock(base.id, 'ed-x')).ok).toBe(true);

    const messages: string[] = [];
    const commits: Array<{ reservedSeq: number | null | undefined }> = [];
    const { env, refs } = makeEnv({
      base,
      sessionId: base.id,
      editorId: 'ed-x',
      messages,
      saveActiveSession: (s, o) =>
        tx.atomicWriteSession({
          intent: { kind: 'active-save' },
          session: s,
          editorId: o.editorId,
          expectedRevision: o.expectedRevision,
        }),
    });
    wire(env);

    // 当前 ref 指向一个“别人的新版本”
    refs.rescuedSeqRef.current = 7;
    rescue.publishRescueDraft(base.id, {
      token: 99,
      session: base,
      baseRevision: base.revision ?? 0,
      baseSession: base,
    });

    const realPersist = env.persist as (
      s: Session,
      ctx?: { reservedSeq?: number | null; writable?: boolean },
    ) => Promise<unknown>;

    // 显式 null：必须保持 null（不得变成 7）
    const outcome = await realPersist(base, { writable: true, reservedSeq: null });
    commits.push({ reservedSeq: null });
    expect(outcome).toBeDefined();

    // 显式 null 时不能把 seq 更大的那份救援清掉
    const still = rescue.loadRescueRecord(base.id);
    expect(still).not.toBeNull();
    expect(still?.seq).toBeGreaterThan(0);
  }, 20000);
});
