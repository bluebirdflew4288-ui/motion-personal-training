import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const FILE = resolve(process.cwd(), 'src/ui/RestTimer.tsx');
const SOURCE = readFileSync(FILE, 'utf8');
const AST = ts.createSourceFile(FILE, SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function extractAdjust(): string {
  let source: string | null = null;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'adjust' &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length > 0 &&
      ts.isArrowFunction(node.initializer.arguments[0])
    ) {
      source = node.initializer.arguments[0].getText(AST);
    }
    ts.forEachChild(node, visit);
  };
  visit(AST);
  if (!source) throw new Error('RestTimer.tsx adjust handler not found');
  return source;
}

const ADJUST_SOURCE = extractAdjust();
const BASE = 1_800_000_000_000;

function executeProductionAdjust(input: {
  now?: number;
  endsAt: number | null;
  pausedRemaining?: number | null;
  token?: string | null;
}) {
  let endsAt = input.endsAt;
  let pausedRemaining = input.pausedRemaining ?? null;
  let token = input.token === undefined ? 'rest-A' : input.token;
  const origin = { current: 'query' };
  const calls: Array<{
    token: string;
    remainingMs: number;
    deadlineAtMs?: number;
    intentId?: number;
    origin: string;
  }> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  let nextId = 0;
  const apply = <T,>(current: T, value: T | ((previous: T) => T)): T =>
    typeof value === 'function' ? (value as (previous: T) => T)(current) : value;

  const env = {
    Date: { now: () => input.now ?? BASE },
    Math,
    controller: {
      arm: (t: string, ms: number, deadlineAtMs?: number, intentId?: number) => {
        calls.push({ token: t, remainingMs: ms, deadlineAtMs, intentId, origin: origin.current });
      },
    },
    persist: (snapshot: Record<string, unknown>) => snapshots.push(snapshot),
    tokenRef: { get current() { return token; } },
    liveStateRef: {
      get current() {
        return {
          token,
          status: pausedRemaining !== null ? 'paused' : 'running',
          endsAt,
          pausedRemaining,
        };
      },
    },
    pendingOriginRef: origin,
    nextIntentId: () => ++nextId,
    setEndsAt: (value: number | null | ((previous: number | null) => number | null)) => {
      endsAt = apply(endsAt, value);
    },
    setPausedRemaining: (value: number | null | ((previous: number | null) => number | null)) => {
      pausedRemaining = apply(pausedRemaining, value);
    },
  };
  const js = ts.transpileModule(`module.exports = (${ADJUST_SOURCE});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: null as unknown };
  vm.runInNewContext(js, { ...env, module, Promise });
  return {
    adjust: module.exports as (deltaSec: number) => void,
    calls,
    snapshots,
    get endsAt() { return endsAt; },
    get pausedRemaining() { return pausedRemaining; },
    get token() { return token; },
  };
}

describe('RestTimer.adjust explicit user adjustment origin', () => {
  it('negative adjustment with time remaining reschedules from user-adjust without advancing intentId', () => {
    const now = BASE + 1_000;
    const h = executeProductionAdjust({ now, endsAt: BASE + 60_000 });

    h.adjust(-15);

    expect(h.calls).toEqual([{
      token: 'rest-A',
      remainingMs: 44_000,
      deadlineAtMs: now + 44_000,
      intentId: 0,
      origin: 'user-adjust',
    }]);
    expect(h.endsAt).toBe(now + 44_000);
    expect(h.snapshots.at(-1)).toMatchObject({ status: 'running', endsAt: now + 44_000 });
  });

  it('positive adjustment keeps a numbered user intent', () => {
    const now = BASE + 1_000;
    const h = executeProductionAdjust({ now, endsAt: BASE + 60_000 });

    h.adjust(15);

    expect(h.calls[0]).toMatchObject({
      remainingMs: 74_000,
      deadlineAtMs: now + 74_000,
      intentId: 1,
      origin: 'user-adjust',
    });
  });

  it('zero adjustment keeps the conservative query origin and does not advance intent', () => {
    const now = BASE + 1_000;
    const h = executeProductionAdjust({ now, endsAt: BASE + 60_000 });

    h.adjust(0);

    expect(h.calls[0]).toMatchObject({
      remainingMs: 59_000,
      deadlineAtMs: now + 59_000,
      intentId: 0,
      origin: 'query',
    });
  });

  it('a second reduction targets the latest deadline and remains at intent zero', () => {
    const now = BASE + 1_000;
    const h = executeProductionAdjust({ now, endsAt: BASE + 60_000 });

    h.adjust(-15);
    h.adjust(-15);

    expect(h.calls.map(({ remainingMs, deadlineAtMs, intentId, origin }) => ({
      remainingMs, deadlineAtMs, intentId, origin,
    }))).toEqual([
      { remainingMs: 44_000, deadlineAtMs: now + 44_000, intentId: 0, origin: 'user-adjust' },
      { remainingMs: 29_000, deadlineAtMs: now + 29_000, intentId: 0, origin: 'user-adjust' },
    ]);
  });

  it('paused adjustment updates the snapshot without scheduling', () => {
    const h = executeProductionAdjust({ endsAt: null, pausedRemaining: 20_000 });

    h.adjust(-15);

    expect(h.calls).toEqual([]);
    expect(h.pausedRemaining).toBe(5_000);
    expect(h.snapshots.at(-1)).toMatchObject({ status: 'paused', pausedRemaining: 5_000 });
  });

  it('adjusting to zero cancels through arm(0) without granting user origin or new intent', () => {
    const h = executeProductionAdjust({ now: BASE, endsAt: BASE + 10_000 });

    h.adjust(-15);

    expect(h.calls).toEqual([{
      token: 'rest-A',
      remainingMs: 0,
      deadlineAtMs: undefined,
      intentId: undefined,
      origin: 'query',
    }]);
    expect(h.endsAt).toBe(BASE);
  });
});
