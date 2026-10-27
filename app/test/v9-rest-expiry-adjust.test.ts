/* G1 回归：休息归零/过期后 +15 必须给完整 15 秒（用户手机反馈修复）。
   ── 已复现的缺陷（Codex 独立证据）─────────────────────────────
   真实 React/CUA 与真实 hook+JavaState 两条链都确证：
   到期后 0/3/8/16/30 秒再点 +15，实际得到 15/12/7 秒/消失/消失。
   根因是 `adjust` 用**旧截止时刻**做基准：
       Math.max(Date.now(), prev + deltaSec * 1000)
   界面在 00:00 只把显示剩余夹到 0，并没有把截止推到"现在"，
   于是过期 d 秒后 +15 = max(0, 15-d) 秒；d>=15 走归零分支清 token/快照，
   计时条消失，原生也只排到缩短后的余量（12000/7000ms）或干脆不排。

   ── 本文件的证据级别 ────────────────────────────────────────
   从 `src/ui/RestTimer.tsx` 用 AST 抽取**真实 adjust 源码**，在受控 React 替身
   （最小 useState/useCallback，与生产语义一致：setState 支持函数式更新）里执行。
   断言的是生产代码自身的算术与分支，不是复制的公式。
   **这不是** React DOM/StrictMode/并发时序验收，也不证明 Android 实际投递或震感；
   真实 React/CUA 与真机由 Codex 独立复验。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const FILE = resolve(process.cwd(), 'src/ui/RestTimer.tsx');
const SOURCE = readFileSync(FILE, 'utf8');
const AST = ts.createSourceFile(FILE, SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 抽取 `const <name> = useCallback(...)` 的第一个参数（真实源码） */
function extractHandlerSource(name: string): string {
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
  if (!src) throw new Error(`RestTimer.tsx 里找不到可抽取的 ${name}`);
  return src;
}

const ADJUST_SRC = extractHandlerSource('adjust');

interface ScheduleCall {
  token: string;
  remainingMs: number;
}

/**
 * 受控执行环境：实现生产 adjust 依赖的最小集合。
 *
 * setEndsAt / setPausedRemaining 都支持函数式更新（与 React useState 一致），
 * 并且**立即应用**——因为 adjust 内部是嵌套 setState（先 paused，再 endsAt）。
 */
function makeHarness(init: {
  now: number;
  endsAt: number | null;
  pausedRemaining: number | null;
  token: string | null;
}) {
  let now = init.now;
  let endsAt = init.endsAt;
  let pausedRemaining = init.pausedRemaining;
  let token = init.token;
  const scheduleCalls: ScheduleCall[] = [];
  const persistCalls: Array<Record<string, unknown>> = [];
  const cleared: string[] = [];

  const applyState = <T,>(prev: T, next: T | ((p: T) => T)): T =>
    typeof next === 'function' ? (next as (p: T) => T)(prev) : next;

  /** 生产 adjust 依赖的最小替身：setState 支持函数式更新并立即应用（与 React 语义一致） */
  const env = {
    Date: { now: () => now },
    Math,
    controller: {
      arm: (t: string, ms: number) => scheduleCalls.push({ token: t, remainingMs: ms }),
    },
    persist: (snap: Record<string, unknown>) => persistCalls.push(snap),
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
    sessionRef: { current: 'sess-1' },
    /**
     * A3 #3 引入：adjust 会写"最近一次用户操作来源"。
     * 这里只需一个可写的 ref 替身；本文件断言的是计时算术，不涉及 FGS 来源判定。
     */
    pendingOriginRef: { current: 'user-adjust' },
    /**
     * B4-R2 新增依赖：adjust 正加时会取一个**明确用户新意图**编号。
     *
     * 这是生产 `RestTimer.tsx` 的真实依赖（归零后 +15 需要新的可投递身份）。
     * 本文件只断言计时算术与排程次数，因此给一个单调计数器即可；
     * 身份语义本身由 `v9-rest-adjust-race.test.ts` 与 Java
     * `RestIntentIdentityTest` 独立覆盖。
     */
    nextIntentId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return n;
      };
    })(),
    clearRestTimerSnapshot: (sid: string) => cleared.push(sid),
    setToken: (v: string | null) => { token = v; },
    setPausedRemaining: (next: unknown) => {
      pausedRemaining = applyState(pausedRemaining, next as typeof pausedRemaining);
    },
    setEndsAt: (next: unknown) => {
      endsAt = applyState(endsAt, next as typeof endsAt);
    },
  };

  const code = ts.transpileModule(`module.exports=(${ADJUST_SRC});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(code, { ...env, module: mod, Promise });
  const adjust = mod.exports as (deltaSec: number) => void;

  return {
    adjust,
    scheduleCalls,
    persistCalls,
    cleared,
    setNow: (t: number) => { now = t; },
    get now() { return now; },
    get endsAt() { return endsAt; },
    get pausedRemaining() { return pausedRemaining; },
    get token() { return token; },
    /** 生产 RestTimerBar 的剩余表达式（与源码同义：夹到 0） */
    get uiRemainingMs() {
      if (pausedRemaining !== null) return pausedRemaining;
      if (endsAt === null) return null;
      return Math.max(0, endsAt - now);
    },
    get active() { return endsAt !== null || pausedRemaining !== null; },
  };
}

const BASE = 1_800_000_000_000;

describe('B4-R3 · StrictMode 不得重放计时业务副作用', () => {
  for (const name of ['pause', 'resume', 'adjust']) {
    it(`${name} 不使用可重放的 state updater，副作用只在事件处理器执行一次`, () => {
      const source = extractHandlerSource(name);
      const handler = ts.createSourceFile(
        `${name}.ts`,
        `const handler = ${source};`,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const functionalSetters: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          ['setEndsAt', 'setPausedRemaining'].includes(node.expression.text) &&
          node.arguments[0] &&
          (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
        ) {
          functionalSetters.push(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(handler);
      expect(functionalSetters).toEqual([]);
    });
  }
});

describe('G1 · 到期后 +15 必须给完整 15 秒', () => {
  // Codex 独立证据里的 5 个失败/边界场景：0/3/8/16/30 秒后再 +15
  for (const delaySec of [0, 3, 8, 16, 30]) {
    it(`到期后 ${delaySec} 秒再 +15 → 从点按当时给足 15000ms（不是 15000-${delaySec * 1000}）`, () => {
      const endsAt = BASE + 30_000;
      const now = endsAt + delaySec * 1000;
      const h = makeHarness({ now, endsAt, pausedRemaining: null, token: 'rest-A' });

      h.adjust(15);

      // ① 界面剩余：完整 15 秒（旧实现是 max(0, 15000-delay*1000)）
      expect(h.uiRemainingMs).toBe(15_000);
      // ② 仍然 active：旧实现在 delay>=15 时清 token/快照并 return null → 计时条消失
      expect(h.active).toBe(true);
      expect(h.token).toBe('rest-A');
      expect(h.cleared).toEqual([]);
      // ③ 截止 = 点按当时 + 15000（不是旧 endsAt + 15000）
      expect(h.endsAt).toBe(now + 15_000);
      // ④ 交给原生的余量同样是完整 15000（旧实现送 12000/7000，或干脆不送）
      expect(h.scheduleCalls).toEqual([{ token: 'rest-A', remainingMs: 15_000 }]);
      // ⑤ 快照按 running 写回真实截止，重建后能继续
      expect(h.persistCalls.at(-1)).toMatchObject({
        token: 'rest-A',
        status: 'running',
        endsAt: now + 15_000,
        pausedRemaining: null,
      });
    });
  }
});

describe('G1 · 未到期时给"当前余量 + 15"', () => {
  it('运行中尚余 20 秒 → 35000ms（不是旧截止 +15 的 45000）', () => {
    const endsAt = BASE + 30_000;
    const now = endsAt - 20_000;
    const h = makeHarness({ now, endsAt, pausedRemaining: null, token: 'rest-A' });

    h.adjust(15);

    expect(h.uiRemainingMs).toBe(35_000);
    expect(h.endsAt).toBe(now + 35_000);
    expect(h.scheduleCalls).toEqual([{ token: 'rest-A', remainingMs: 35_000 }]);
  });

  it('临界：到期前 1ms +15 → 15001ms（余量 1ms 必须算进去）', () => {
    const endsAt = BASE + 30_000;
    const now = endsAt - 1;
    const h = makeHarness({ now, endsAt, pausedRemaining: null, token: 'rest-A' });

    h.adjust(15);

    expect(h.uiRemainingMs).toBe(15_001);
    expect(h.scheduleCalls).toEqual([{ token: 'rest-A', remainingMs: 15_001 }]);
  });

  it('到期后连续两次 +15 → 首次 15000、第二次 30000（正确累计）', () => {
    const endsAt = BASE + 30_000;
    const h = makeHarness({ now: endsAt + 8_000, endsAt, pausedRemaining: null, token: 'rest-A' });

    h.adjust(15);
    expect(h.uiRemainingMs).toBe(15_000);

    h.adjust(15);
    expect(h.uiRemainingMs).toBe(30_000);
    expect(h.scheduleCalls.map((c) => c.remainingMs)).toEqual([15_000, 30_000]);
  });
});

describe('G1 · 暂停态加时保持暂停', () => {
  it('暂停剩余 0 → +15 = 15000，仍暂停，且不排闹钟', () => {
    const h = makeHarness({
      now: BASE + 38_000,
      endsAt: null,
      pausedRemaining: 0,
      token: 'rest-A',
    });

    h.adjust(15);

    expect(h.pausedRemaining).toBe(15_000);
    expect(h.endsAt).toBeNull();
    expect(h.active).toBe(true);
    // 暂停态绝不排闹钟：恢复时才按余量统一排
    expect(h.scheduleCalls).toEqual([]);
    expect(h.persistCalls.at(-1)).toMatchObject({ status: 'paused', pausedRemaining: 15_000 });
  });

  it('暂停剩余 20 秒 → 35000，且不排闹钟', () => {
    const h = makeHarness({
      now: BASE,
      endsAt: null,
      pausedRemaining: 20_000,
      token: 'rest-A',
    });

    h.adjust(15);

    expect(h.pausedRemaining).toBe(35_000);
    expect(h.scheduleCalls).toEqual([]);
  });
});

describe('G1 · 归零后计时条不消失（−15 不得清掉本次休息）', () => {
  it('到期后 −15 → 剩余夹到 0 但仍 active（还能继续 +15 或跳过）', () => {
    const endsAt = BASE + 30_000;
    const now = endsAt + 5_000;
    const h = makeHarness({ now, endsAt, pausedRemaining: null, token: 'rest-A' });

    h.adjust(-15);

    expect(h.uiRemainingMs).toBe(0);
    expect(h.active).toBe(true);
    expect(h.token).toBe('rest-A');
    expect(h.cleared).toEqual([]);
    // 减到 0：取消旧提醒，不排新的
    expect(h.scheduleCalls).toEqual([{ token: 'rest-A', remainingMs: 0 }]);
  });

  it('减到 0 之后再 +15 → 仍是完整 15000（不会因为"已归零"而失效）', () => {
    const endsAt = BASE + 30_000;
    const now = endsAt + 5_000;
    const h = makeHarness({ now, endsAt, pausedRemaining: null, token: 'rest-A' });

    h.adjust(-15);
    expect(h.uiRemainingMs).toBe(0);

    h.adjust(15);
    expect(h.uiRemainingMs).toBe(15_000);
    expect(h.endsAt).toBe(now + 15_000);
  });
});
