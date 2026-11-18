/* REVIEW-1 #5：存储异常后重试假成功。

   ── 缺陷链 ──────────────────────────────────────────────────
   persist.catch 只 settle(failed)、不 rememberDraft(next)
   → unsavedDraft 仍为 null
   → retryUnsavedDraftForReplace 看到 pending=null 就返回 ok:true 并关窗
   → 实际既没读库核验也没写库（openDb rejection 可进入此路径）。

   ── 本测试的做法 ────────────────────────────────────────────
   与既有 a06b 同一套机制：从 **Session.tsx 真实源码**抽取 `persist` 回调体，
   在受控 env 中运行，注入"存储层直接抛异常"，断言：
     1. persist 返回 failed；
     2. 异常路径确实登记了待存草稿（unsavedDraft 非空）——
        这是"重试能真正写库"的前提。

   证据边界：验证的是真实 persist 源码在异常下的行为；
   完整 React 点击流程（Sheet 按钮）需浏览器，见报告未验证项。 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import vm from 'node:vm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import * as merge from '../src/domain/draftMerge';
import * as rescue from '../src/lib/draftRescue';
import * as sessionWrite from '../src/lib/sessionWrite';
import type { Session } from '../src/domain/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = resolve(HERE, '../src/pages/session/useSessionPersistence.ts');
const SOURCE = readFileSync(SESSION_FILE, 'utf8');
const AST = ts.createSourceFile('Session.tsx', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 编译一段源码为可执行函数 */
function compile(exprSource: string, env: Record<string, unknown>) {
  const js = ts.transpileModule(`module.exports=(${exprSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(js, { ...env, module: mod, Promise, structuredClone });
  return mod.exports as (...args: unknown[]) => unknown;
}

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
      if (ts.isCallExpression(v) && v.arguments.length) v = v.arguments[0];
      if (ts.isArrowFunction(v)) src = v.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error(`Session.tsx 里找不到可抽取的 ${name}`);
  return compile(src, env);
}

const NOW = 1_760_000_000_000;

function baseSession(): Session {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.kind === 'train')!;
  return createSession(plan, day, NOW);
}

describe('REVIEW-1 #5 · persist 存储异常必须保留意图', () => {
  let base: Session;
  let refs: Record<string, { current: unknown }>;
  let messages: string[];

  beforeEach(() => {
    base = baseSession();
    messages = [];
    refs = {
      confirmedRevision: { current: 0 },
      latestRef: { current: structuredClone(base) },
      baseSessionRef: { current: structuredClone(base) },
      viewBeforeRef: { current: null },
      unsavedDraft: { current: null },
      rescuedSeqRef: { current: null },
      ownPriorCommitRef: { current: null },
      saveQueue: { current: Promise.resolve() },
      lockBlockedRef: { current: false },
      editorId: { current: 'ed-1' },
      ownPublishedSeq: { current: 0 },
      adoptedRescueSeq: { current: 0 },
      pendingFromRescue: { current: false },
    };
  });

  function makeEnv(over: Record<string, unknown> = {}) {
    const env: Record<string, unknown> = {
      ...refs,
      sessionId: base.id,
      nextDraftToken: (() => {
        let n = 0;
        return () => ++n;
      })(),
      accumulateDraftIntent: merge.accumulateDraftIntent,
      decideQueuedSessionWrite: sessionWrite.decideQueuedSessionWrite,
      pendingDraftFromIntent: sessionWrite.pendingDraftFromIntent,
      getSession: async () => undefined,
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
      syncSessionLocal() {},
      ...over,
    };
    return env;
  }

  it('存储层抛异常：persist 返回 failed 且登记待存草稿', async () => {
    // 存储层直接 reject（模拟 openDb 失败等异常路径）
    const env = makeEnv({
      saveActiveSession: async () => {
        throw new Error('openDb rejected');
      },
    });
    const rememberDraft = extractCallback('rememberDraft', env) as (n: Session) => void;
    env.rememberDraft = rememberDraft;
    const persist = extractCallback('persist', env) as (
      n: Session,
      ctx?: unknown,
    ) => Promise<merge.PersistOutcome>;

    // 改动：把某组次数改成 12
    const next: Session = structuredClone(base);
    next.exercises[0].sets[0].reps = 12;

    const outcome = await persist(next);
    expect(outcome.status).toBe('failed');

    // 关键断言：异常路径也必须留下意图，否则"重试"无从写库
    expect(refs.unsavedDraft.current).not.toBeNull();
    const pending = refs.unsavedDraft.current as { session: Session };
    expect(pending.session.exercises[0].sets[0].reps).toBe(12);

    // 有明确的失败提示
    expect(messages.some((m) => m.includes('未保存'))).toBe(true);
  });

  it('对照：存储成功时不留下草稿', async () => {
    const env = makeEnv({
      saveActiveSession: async () => ({ ok: true, revision: 1 }),
    });
    const rememberDraft = extractCallback('rememberDraft', env) as (n: Session) => void;
    env.rememberDraft = rememberDraft;
    const persist = extractCallback('persist', env) as (
      n: Session,
      ctx?: unknown,
    ) => Promise<merge.PersistOutcome>;

    const next: Session = structuredClone(base);
    next.exercises[0].sets[0].reps = 9;

    const outcome = await persist(next);
    expect(outcome.status).toBe('saved');
    expect(refs.unsavedDraft.current).toBeNull();
  });
});
