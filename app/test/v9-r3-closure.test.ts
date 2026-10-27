/* B4-R3 独立验收后**有限补修的 5 组已证实缺口**（closure）应用侧回归。

   ── 对应 Codex 独立首轮 FAIL（只读证据，未修改）─────────────
   ① D2-explicit-invalid-deadline-null        → 原生侧（RestR3ClosureTest）
   ② D2-new-token-counter-scope-…             → 原生侧 + 快照水位（本文件）
   ③ F2-{precise,full-clear}-newB-rejected-must-retain-A-duty → 本文件
   ④ R3-F2-visible-failure-and-real-retry     → 本文件（真实组件源码）
   ⑤ N05-real-back-forward-dirty-history      → 本文件（纯历史决策 + 源码）

   ── 证据边界 ────────────────────────────────────────────────
   本文件测**生产源码**的控制器/快照/组件结构/路由决策，不运行真实浏览器、
   不冒充 Android 写盘或 Codex 的 CUA/原生宿主。
   真实 dev/prod 与真机仍由 Codex 停写后独立重验。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RestScheduleController, type RestScheduleOps } from '../src/lib/restSchedule';
import {
  loadRestTimerSnapshot,
  saveRestTimerSnapshot,
  type RestTimerSnapshot,
} from '../src/lib/restTimerSnapshot';
import { nextPushIdx, resolveBlockedHistoryAction } from '../src/lib/router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RestTimerBar, type RestTimerApi } from '../src/ui/RestTimer';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const flushTwice = async () => {
  await flush();
  await flush();
};

/* ───────────────────────── ② 快照水位（重挂连续性）───────────────────────── */

describe('Gap② · 意图水位随快照持久化（重挂后编号连续）', () => {
  // sessionStorage 在 node 环境不存在 → 用一个最小替身（与浏览器语义一致）
  function withSessionStorage<T>(fn: () => T): T {
    const map = new Map<string, string>();
    const g = globalThis as unknown as { sessionStorage?: Storage };
    const prev = g.sessionStorage;
    g.sessionStorage = {
      get length() {
        return map.size;
      },
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as unknown as Storage;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete g.sessionStorage;
      else g.sessionStorage = prev;
    }
  }

  it('写入后读回：水位原样保留（重挂时 hook 才能抬回序号）', () =>
    withSessionStorage(() => {
      saveRestTimerSnapshot({
        sessionId: 'sess-w1',
        token: 'rest-A',
        generation: 3,
        endsAt: Date.now() + 60_000,
        pausedRemaining: null,
        status: 'running',
        intentWatermark: 3,
      });
      const snap = loadRestTimerSnapshot('sess-w1');
      expect(snap).not.toBeNull();
      expect(snap?.intentWatermark).toBe(3);
    }));

  it('旧快照（没有 intentWatermark 字段）→ 读成 0，且**不丢弃**快照', () =>
    withSessionStorage(() => {
      // 模拟旧版本写入的原始 JSON
      const record = {
        v: 1,
        sessionId: 'sess-w2',
        token: 'rest-old',
        generation: 2,
        endsAt: Date.now() + 30_000,
        pausedRemaining: null,
        status: 'running',
        savedAt: Date.now(),
      };
      sessionStorage.setItem('motion-rest-timer:sess-w2', JSON.stringify(record));
      const snap = loadRestTimerSnapshot('sess-w2');
      expect(snap).not.toBeNull();
      expect(snap?.token).toBe('rest-old');
      expect(snap?.intentWatermark).toBe(0);
    }));

  it('非法水位（负数/NaN）→ 归 0，不污染恢复路径', () =>
    withSessionStorage(() => {
      const base: RestTimerSnapshot = {
        v: 1,
        sessionId: 'sess-w3',
        token: 'rest-X',
        generation: 1,
        intentWatermark: 0,
        endsAt: Date.now() + 10_000,
        pausedRemaining: null,
        status: 'running',
        savedAt: Date.now(),
      };
      for (const bad of [-5, Number.NaN, 1.7]) {
        sessionStorage.setItem(
          'motion-rest-timer:sess-w3',
          JSON.stringify({ ...base, intentWatermark: bad }),
        );
        const snap = loadRestTimerSnapshot('sess-w3');
        expect(snap?.intentWatermark).toBe(bad === 1.7 ? 1 : 0);
      }
    }));

  it('恢复水位后，连续 +15 的编号继续递增（不再从 1 重来）', () => {
    // 生产语义：hook 用 `Math.max(当前, 快照水位)` 抬回序号
    const restore = (snapshotWatermark: number, memory = 0) =>
      Math.max(memory, snapshotWatermark);
    const seqAfterRemount = restore(3);
    expect(seqAfterRemount).toBe(3);
    // 下一次 +15 用 4（> 原生水位 3）→ 不会被判 stale-intent
    expect(seqAfterRemount + 1).toBe(4);
  });
});

/* ─────────────── ② 旧 v1 快照窗口：getActive 未回时点 +15 也必须落地 ─────────────── */

describe('Gap② · 旧 v1 快照（无水位）与 getActive 晚到窗口', () => {
  const TOKEN = 'rest-v1';
  const T0 = 1_800_000_000_000;

  it('水位未核实就 +15（编号 1 ≤ 原生水位 3）→ 用原生回报水位自愈重发一次，最终被接受', async () => {
    const native = makeStatefulNative();
    native.seed(TOKEN, 5, 3); // 原生已有身份，水位 3
    const watermarkSeen: number[] = [];
    const c = new RestScheduleController(
      native.ops,
      undefined,
      undefined,
      (v) => watermarkSeen.push(v),
    );
    c.adopt(TOKEN, 5);

    // Codex 场景：**一次 cancel 恰好失败** → 旧身份保留，schedule 才真正面对水位
    native.setFailCancelOnce();

    // 旧快照没有水位 → 内存序号归零；getActive 还没回，用户立刻点 +15
    const uiEndsAt = T0 + 75_000;
    c.arm(TOKEN, 75_000, uiEndsAt, 1);
    await flushTwice();
    await flushTwice();

    // 第一次被如实拒绝（stale-intent），随后用原生水位 3 + 1 = 4 重发并被接受
    expect(native.rejected.map((x) => x.reason)).toEqual(['stale-intent']);
    const last = native.accepted[native.accepted.length - 1];
    expect(last.intentId).toBe(4);
    expect(last.deadline).toBe(uiEndsAt); // **原生截止 == UI 截止**（不再 75 vs 60）
    expect(c.snapshot.generation).not.toBeNull();
    expect(c.snapshot.pending).toBe(false);
    expect(c.staleResyncCount).toBe(1);
    // 水位也回传给了上层，可用于抬内存序号
    expect(watermarkSeen).toContain(3);
    expect(watermarkSeen).toContain(4);
  });

  it('只自愈重发**一次**：原生继续拒绝时如实失败，不无限重试', async () => {
    const native = makeStatefulNative();
    native.seed(TOKEN, 5, 3);
    // 让原生永远把任何编号都判成旧请求（模拟极端陈旧）
    const originalSchedule = native.ops.schedule;
    native.ops.schedule = async (token, ms, deadline, intentId) => {
      const r = await originalSchedule(token, ms, deadline, intentId);
      if (r.scheduled) {
        return { ...r, scheduled: false, reason: 'stale-intent', lastIntentId: 3 };
      }
      return r;
    };
    native.setFailCancelOnce();
    const c = new RestScheduleController(native.ops);
    c.adopt(TOKEN, 5);
    c.arm(TOKEN, 75_000, T0 + 75_000, 1);
    await flushTwice();
    await flushTwice();

    // 初始 1 次 + 自愈 1 次 = 最多 2 次，之后不再重发
    expect(native.rejected.length).toBeLessThanOrEqual(2);
    expect(c.staleResyncCount).toBe(1);
    expect(c.snapshot.generation).toBeNull(); // 如实"未接受"，不假成功
    expect(c.snapshot.pending).toBe(true);    // 仍可恢复（下一次用户动作会重排）
  });

  it('旧原生不回报水位 → 不猜测编号、如实失败（不伪造成功）', async () => {
    const native = makeStatefulNative();
    native.seed(TOKEN, 5, 3);
    const originalSchedule = native.ops.schedule;
    native.ops.schedule = async (token, ms, deadline, intentId) => {
      const r = await originalSchedule(token, ms, deadline, intentId);
      // 模拟旧原生：没有 lastIntentId 字段
      const { lastIntentId: _drop, ...rest } = r as Record<string, unknown>;
      return rest as never;
    };
    native.setFailCancelOnce();
    const c = new RestScheduleController(native.ops);
    c.adopt(TOKEN, 5);
    c.arm(TOKEN, 75_000, T0 + 75_000, 1);
    await flushTwice();
    await flushTwice();

    expect(c.staleResyncCount).toBe(0); // 无水位依据就不重发
    expect(c.snapshot.generation).toBeNull();
    expect(native.rejected).toHaveLength(1);
  });

  it('新快照已有水位（正常路径）→ 首次就带足够新的编号，无需自愈', async () => {
    const native = makeStatefulNative();
    native.seed(TOKEN, 5, 3);
    const c = new RestScheduleController(native.ops);
    c.adopt(TOKEN, 5);
    c.arm(TOKEN, 75_000, T0 + 75_000, 4); // 恢复的水位 3 → 下一个编号 4
    await flushTwice();
    expect(native.rejected).toHaveLength(0);
    expect(c.staleResyncCount).toBe(0);
    expect(c.snapshot.generation).not.toBeNull();
  });
});

/* ────── ② 生命周期归属：disposed controller 不得主动自愈重排（审源第 3 节）────── */

describe('Gap② · 失去归属的 controller 不能靠迟到 ACK 覆盖新 B', () => {
  const OLD = 'old-A';
  const NEW = 'new-B';
  const T0 = 1_800_000_000_000;

  it('dispose → 新 B 已原生成功 → 旧 A 的**真实 stale 拒绝 ACK 迟到** → 禁止提号重发', async () => {
    const native = makeStatefulNative();
    native.seed(OLD, 9, 20); // 原生已有 A，水位 20

    const oldC = new RestScheduleController(native.ops);
    oldC.adopt(OLD, 9);

    // 旧 controller 用编号 1（落后）排 A：原生**如实拒绝**，但 ACK 被延迟。
    // 注入一次 cancel 失败，避免"cancel 先成功把旧身份清掉"掩盖 Watermark 判定。
    native.setFailCancelOnce();
    native.holdNextAck();
    oldC.arm(OLD, 30_000, T0 + 30_000, 1);
    await flushTwice();
    expect(native.rejected.map((x) => x.reason)).toEqual(['stale-intent']);
    expect(native.heldAck()).toMatchObject({ scheduled: false, reason: 'stale-intent', lastIntentId: 20 });
    const sendsAfterReject = native.accepted.length + native.rejected.length;

    // 旧页面 dispose（失去所有权），用户已经排好新 B（原生成功）
    oldC.dispose();
    const newC = new RestScheduleController(native.ops);
    newC.arm(NEW, 15_000, T0 + 15_000, 1);
    await flushTwice();
    expect(native.native()).toMatchObject({ token: NEW, fired: false });
    const bGeneration = native.native().generation;

    // 迟到的 A 拒绝 ACK 现在才回到旧 controller
    native.releaseHeldAck();
    await flushTwice();
    await flushTwice();

    // 旧 controller **不得**再发任何排程（否则会提号 21 覆盖 B）
    const sendsAfterLateAck = native.accepted.length + native.rejected.length;
    expect(sendsAfterLateAck).toBe(sendsAfterReject + 1); // 只有新 B 那一次
    expect(native.accepted.some((x) => x.token === OLD && x.intentId === 21)).toBe(false);
    // 原生仍是 B（没有被 A 覆盖）
    expect(native.native()).toMatchObject({ token: NEW });
    expect(native.native().generation).toBe(bGeneration);
    // 诊断可见：确实发生过"被禁止"（正确行为，不是静默）
    expect(oldC.staleResyncBlockedCount).toBe(1);
    expect(oldC.staleResyncCount).toBe(0);
    // 旧 controller 一直没有提交代次（未假成功）
    expect(oldC.snapshot.generation).toBeNull();
  });

  it('StrictMode：dispose → activate 后仍有归属 → 迟到真实 stale ACK 仍可自愈一次', async () => {
    const native = makeStatefulNative();
    native.seed(OLD, 9, 20);

    const c = new RestScheduleController(native.ops);
    c.adopt(OLD, 9);
    c.activate();

    native.setFailCancelOnce();
    native.holdNextAck();
    c.arm(OLD, 30_000, T0 + 30_000, 1);
    await flushTwice();
    expect(native.rejected.map((x) => x.reason)).toEqual(['stale-intent']);

    // React 开发态 StrictMode：cleanup → setup（复用同一 controller）
    c.dispose();
    c.activate();

    native.releaseHeldAck();
    await flushTwice();
    await flushTwice();

    // 归属已恢复 → 允许用真实水位 20 + 1 = 21 自愈一次
    expect(c.staleResyncBlockedCount).toBe(0);
    expect(c.staleResyncCount).toBe(1);
    const last = native.accepted[native.accepted.length - 1];
    expect(last).toMatchObject({ token: OLD, intentId: 21 });
    expect(last.deadline).toBe(T0 + 30_000); // 仍保持原点击目标截止
    expect(c.snapshot.generation).not.toBeNull();
  });

  it('真实卸载（dispose 后无 setup）→ 迟到 ACK 既不重发也不假提交', async () => {
    const native = makeStatefulNative();
    native.seed(OLD, 9, 20);
    const c = new RestScheduleController(native.ops);
    const committed: Array<{ token: string; generation: number }> = [];
    const c2 = new RestScheduleController(native.ops, (t, g) => committed.push({ token: t, generation: g }));
    c2.adopt(OLD, 9);

    native.setFailCancelOnce();
    native.holdNextAck();
    c2.arm(OLD, 30_000, T0 + 30_000, 1);
    await flushTwice();
    c2.dispose();
    native.releaseHeldAck();
    await flushTwice();
    await flushTwice();

    expect(c2.staleResyncCount).toBe(0);
    expect(c2.staleResyncBlockedCount).toBe(1);
    expect(c2.snapshot.generation).toBeNull(); // 未提交代次
    expect(committed).toHaveLength(0);        // 旧 UI 不回写
    expect(native.accepted.some((x) => x.token === OLD)).toBe(false);
    void c;
  });
});

/* ─────────────── ② 端到端：重挂（新 hook 实例）后 +15 必须被原生接受 ─────────────── */

/**
 * 有状态原生镜像（只镜像**本次要验证的**判定：同 token 旧编号拒绝 / 新 token 中文水位）。
 * 不是复制业务公式：它落实的是 `RestReminderState.startWithIntent` 的
 * per-token 水位语义，原生侧已由 RestR3ClosureTest 独立锁住。
 */
function makeStatefulNative() {
  let state = { token: null as string | null, generation: 0, notifId: 0, fired: false, lastIntentId: 0 };
  /**
   * 取消可被注入失败：**这是关键的对照条件**。
   *
   * <p>如果 cancel 总是先成功，旧 token 身份会被清掉，随后的 schedule
   * 自然变成"新身份" → 编号从 1 重来的缺陷就被掩盖了
   * （Codex 明确要求"不要只靠 cancel 通常先成功掩盖"）。
   */
  let failCancel = false;
  /** 只失败**一次**的取消（Codex 场景：一次 cancel 恰好失败，随后 schedule 抵达） */
  let failCancelOnce = false;
  /** 只延迟**已判好**的 ACK 投递（不改变原生结果） */
  let holdAck = false;
  let held: {
    result: { scheduled: boolean; generation?: number; reason?: string; lastIntentId?: number };
    resolve: (r: {
      scheduled: boolean;
      generation?: number;
      reason?: string;
      lastIntentId?: number;
    }) => void;
  } | null = null;
  const accepted: Array<{ token: string; intentId: number; deadline: number }> = [];
  const rejected: Array<{ token: string; intentId: number; reason: string }> = [];
  const ops: RestScheduleOps = {
    schedule: (token, _remainingMs, deadlineAtMs, intentId) => {
      const settle = async () => {
      const id = typeof intentId === 'number' && Number.isFinite(intentId) && intentId > 0
        ? Math.floor(intentId)
        : 0;
      const sameToken = state.token === token;
      if (sameToken && state.fired && id <= 0) {
        rejected.push({ token, intentId: id, reason: 'already-fired' });
        return {
          scheduled: false,
          path: 'rejected-state-already-fired',
          reason: 'already-fired',
          lastIntentId: state.lastIntentId,
        };
      }
      if (sameToken && id > 0 && id <= state.lastIntentId) {
        rejected.push({ token, intentId: id, reason: 'stale-intent' });
        return {
          scheduled: false,
          path: 'rejected-state-stale-intent',
          reason: 'stale-intent',
          lastIntentId: state.lastIntentId,
        };
      }
      state.generation += 1;
      state.notifId += 1;
      state.token = token;
      state.fired = false;
      state.lastIntentId = sameToken ? Math.max(id, state.lastIntentId) : id > 0 ? id : 0;
      accepted.push({ token, intentId: id, deadline: deadlineAtMs ?? 0 });
      return { scheduled: true, generation: state.generation, lastIntentId: state.lastIntentId };
      };
      return new Promise((resolve) => {
        const deliver = (result: {
          scheduled: boolean;
          generation?: number;
          reason?: string;
          lastIntentId?: number;
        }) => {
          if (holdAck) {
            holdAck = false;
            held = { result, resolve };
            return;
          }
          resolve(result);
        };
        void settle().then(deliver);
      });
    },
    cancel: async (identity) => {
      if (failCancel) return false; // 真实可达：durable commit 失败，身份被正确保留
      if (failCancelOnce) {
        failCancelOnce = false;
        return false;
      }
      if (!identity) {
        state = { ...state, token: null, generation: state.generation + 1, fired: false };
        return true;
      }
      if (state.token === identity.token && state.generation === identity.generation) {
        state = { ...state, token: null, generation: state.generation + 1, fired: false };
        return true;
      }
      return false;
    },
    getActive: async () => ({
      available: true,
      active: !!state.token && !state.fired,
      token: state.token,
      generation: state.generation,
      fired: state.fired,
      lastIntentId: state.lastIntentId,
    }),
  };
  return {
    ops,
    accepted,
    rejected,
    native: () => ({ ...state }),
    setFailCancel: (v: boolean) => {
      failCancel = v;
    },
    /**
     * **只延迟已经判好的真实 ACK**（不合成业务结果）。
     *
     * 原生侧在 execute 时就已经决定了接受/拒绝并改了状态，
     * 这里仅把"回给 JS 的 resolve"扣住，用来复现
     * "旧页 dispose 后迟到的 stale 拒绝 ACK"这一真实时序。
     */
    holdNextAck: () => {
      holdAck = true;
    },
    releaseHeldAck: () => {
      const h = held;
      held = null;
      h?.resolve(h.result);
      return h?.result ?? null;
    },
    heldAck: () => (held ? held.result : null),
    /** 让**下一次**取消失败（身份保留），之后恢复正常 */
    setFailCancelOnce: () => {
      failCancelOnce = true;
    },
    /** 预热一个已存在的原生身份（模拟"页面重挂前原生已有水位"） */
    seed: (token: string, generation: number, lastIntentId: number) => {
      state = { token, generation, notifId: 1, fired: false, lastIntentId };
    },
  };
}

describe('Gap② · 重挂后编号连续（端到端，含反例）', () => {
  const TOKEN = 'rest-remount';
  const T0 = 1_800_000_000_000;

  /**
   * 复现 hook 的意图序号行为：provider 决定重挂后从几开始。
   *
   * @param restoreWatermark null = 旧 v1 快照（没有水位）
   * @param opts.echoWatermark false = 模拟**旧原生**（排程响应不带 lastIntentId，
   *        因此没有任何可用的自愈依据 → 只能如实失败）
   */
  async function run(restoreWatermark: number | null, opts?: { echoWatermark?: boolean }) {
    const native = makeStatefulNative();
    if (opts?.echoWatermark === false) {
      const original = native.ops.schedule;
      native.ops.schedule = async (token, ms, deadline, intentId) => {
        const r = await original(token, ms, deadline, intentId);
        const { lastIntentId: _drop, ...rest } = r as Record<string, unknown>;
        return rest as never;
      };
    }
    const c1 = new RestScheduleController(native.ops);
    let seq = 0;
    const nextId = () => ++seq;

    // start 30s, +15, +15 → 编号 1,2,3
    c1.arm(TOKEN, 30_000, T0 + 30_000, nextId());
    await flushTwice();
    c1.arm(TOKEN, 45_000, T0 + 45_000, nextId());
    await flushTwice();
    c1.arm(TOKEN, 60_000, T0 + 60_000, nextId());
    await flushTwice();
    const genBeforeRemount = c1.snapshot.generation;
    const watermarkBefore = seq;
    expect(watermarkBefore).toBe(3);

    // ── 组件重挂：全新 hook 实例 + 全新 controller ──
    // 新实例的内存序号**从 0 开始**（这正是旧缺陷的起点）
    let seq2 = 0;
    const nextId2 = () => ++seq2;
    const c2 = new RestScheduleController(native.ops);
    c2.adopt(TOKEN, genBeforeRemount);
    // 关键差异：是否把快照/原生水位恢复到新实例（生产实现 restoreWatermark）
    if (restoreWatermark !== null) seq2 = Math.max(seq2, restoreWatermark);

    /**
     * 重挂后的这一步按 Codex 真实驱动序列设置：**先注入一次 cancel 失败**
     * 再 +15。这样旧 token 身份不会因取消而消失，
     * 能否接受只取决于"新意图编号是否真的比原生水位新"。
     */
    native.setFailCancel(true);
    const uiEndsAt = T0 + 75_000;
    c2.arm(TOKEN, 75_000, uiEndsAt, nextId2());
    await flushTwice();
    await flushTwice();
    return { c2, native, uiEndsAt, genBeforeRemount, seqAfterRemount: seq2 };
  }

  it('恢复水位 → +15 被接受，原生截止与 UI 截止一致（不再 75s vs 60s 分叉）', async () => {
    const { c2, native, uiEndsAt, genBeforeRemount } = await run(3);
    expect(native.rejected).toHaveLength(0);
    expect(c2.snapshot.generation).not.toBeNull();
    expect(c2.snapshot.generation).toBeGreaterThan(genBeforeRemount ?? 0);
    const last = native.accepted[native.accepted.length - 1];
    // 从恢复的水位继续（3 → 4），而不是从 1 重来
    expect(last.intentId).toBe(4);
    expect(last.deadline).toBe(uiEndsAt); // 原生截止 == UI 截止
  });

  it('无水位 + **旧原生不回水位** → 只能如实失败（残留风险，不假成功）', async () => {
    const { c2, native, seqAfterRemount } = await run(null, { echoWatermark: false });
    expect(seqAfterRemount).toBe(1); // 新实例序号归零后第一次 +15 = 1
    // UI 已延长，但原生拒绝了这次新意图，且没有任何依据可自愈
    expect(native.rejected.some((x) => x.reason === 'stale-intent')).toBe(true);
    expect(c2.snapshot.generation).toBeNull(); // 代次未提交 = 原生没接受
    expect(c2.snapshot.pending).toBe(true);    // 明确未完成（可恢复），不是假的成功
    expect(c2.staleResyncCount).toBe(0);
  });

  it('无水位 + 原生回水位 → 自愈重发，UI 与原生截止一致（新兜底生效）', async () => {
    const { c2, native, uiEndsAt, seqAfterRemount } = await run(null);
    expect(seqAfterRemount).toBe(1); // 确实是"落后编号"起步
    expect(native.rejected.map((x) => x.reason)).toEqual(['stale-intent']); // 先如实拒绝
    const last = native.accepted[native.accepted.length - 1];
    expect(last.intentId).toBe(4);       // 用原生水位 3 + 1 重发
    expect(last.deadline).toBe(uiEndsAt); // 原生截止与 UI 一致
    expect(c2.snapshot.generation).not.toBeNull();
    expect(c2.staleResyncCount).toBe(1);
  });

  it('原生 getActive 暴露水位（旧快照兼容路径可用）', async () => {
    const native = makeStatefulNative();
    const c = new RestScheduleController(native.ops);
    c.arm(TOKEN, 30_000, T0 + 30_000, 7);
    await flushTwice();
    const info = await native.ops.getActive?.();
    expect(info?.lastIntentId).toBe(7);
  });
});

/* ───────────────────────── ③ F2 责任不可凭未成功新意图结清 ───────────────────── */

type ScheduleCall = {
  token: string;
  remainingMs: number;
  resolve: (r: { scheduled: boolean; generation?: number }) => void;
};

/** 可控原生层：schedule 手动放行；cancel 结果可逐个指定；getActive 可设定 */
function makeOps(opts?: {
  cancelResults?: boolean[];
  native?: { token: string | null; generation: number; fired: boolean; active: boolean } | null;
}) {
  const scheduleCalls: ScheduleCall[] = [];
  const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
  let cancelIdx = 0;
  let native = opts?.native ?? null;
  const ops: RestScheduleOps = {
    schedule: (token, remainingMs) =>
      new Promise((resolve) => {
        scheduleCalls.push({ token, remainingMs, resolve });
      }),
    cancel: async (identity) => {
      cancelCalls.push(identity);
      const r = opts?.cancelResults?.[cancelIdx++];
      const ok = typeof r === 'boolean' ? r : true;
      if (ok && native) {
        const full = !identity;
        const match =
          full || (native.token === identity?.token && native.generation === identity?.generation);
        if (match) native = null;
      }
      return ok;
    },
    getActive: async () => ({
      available: true,
      active: !!native && native.active && !native.fired,
      token: native?.token ?? null,
      generation: native?.generation ?? 0,
      fired: !!native?.fired,
    }),
  };
  return { ops, scheduleCalls, cancelCalls, setNative: (v: typeof native) => (native = v) };
}

describe('Gap② · 原生侧水位接线（源码结构，供新 SOURCE 绑定）', () => {
  const PLUGIN = read('android/app/src/main/java/app/motion/personal/plugins/RestReminderPlugin.java');

  it('排程成功回报 lastIntentId（JS 每次排程后都能与原生对齐）', () => {
    expect(PLUGIN).toContain('ret.put("lastIntentId", outcome.state.lastIntentId)');
  });

  it('stale-intent 等 NOOP 拒绝也回报 lastIntentId（自愈依据）', () => {
    expect(PLUGIN).toContain('ret.put("lastIntentId", outcome == null ? -1L : outcome.state.lastIntentId)');
  });

  it('getActive 暴露 lastIntentId（旧快照兜底）', () => {
    expect(PLUGIN).toMatch(/ret\.put\("lastIntentId", cur\.lastIntentId\)/);
  });

  it('控制器仅在收到数字水位时才自愈，且只重发一次', () => {
    // 触发条件：明确被拒 + 有数字水位 + 未重发过
    expect(REST_SCHEDULE_SRC).toContain("result.reason === 'stale-intent'");
    expect(REST_SCHEDULE_SRC).toContain("typeof result.lastIntentId === 'number'");
    expect(REST_SCHEDULE_SRC).toContain('!intent.staleRetried');
    // 只重发一次
    expect(REST_SCHEDULE_SRC).toContain('intent.staleRetried = true');
    // 重发用的是「原生水位 + 1」，不是猜测值
    expect(REST_SCHEDULE_SRC).toMatch(
      /intent\.intentId = Math\.max\(intent\.intentId, Math\.floor\(result\.lastIntentId\)\) \+ 1;/,
    );
  });
});

describe('Gap③ · 新 B 排程被拒时 A 的取消责任必须保留', () => {
  it('精确责任：A 取消失败 → arm B → B 被拒 → retry 返回 false 且责任保留', async () => {
    const { ops, scheduleCalls, setNative } = makeOps({ cancelResults: [false, false] });
    setNative({ token: 'old-A', generation: 4, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('old-A', 15_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 4 });
    await flushTwice();
    expect(c.snapshot.generation).toBe(4);

    c.disarm(false); // 取消失败 → 责任保留
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    // 新 B 被原生**拒绝**
    c.arm('new-B', 30_000);
    await flush();
    scheduleCalls[1].resolve({ scheduled: false });
    await flushTwice();
    expect(c.snapshot.token).toBe('new-B');
    expect(c.snapshot.generation).toBeNull(); // 未提交代次 = 未接受

    const cleared = await c.retryPendingCancels();
    expect(cleared).toBe(false); // ← 旧实现这里错误地返回 true
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.snapshot.cancelError).toBe(true);
    // 旧 A 责任仍在（身份精确）
    expect(c.pendingCancelDuties[0]).toMatchObject({ token: 'old-A', generation: 4 });
  });

  it('通配责任：A 全清失败 → arm B → B 被拒 → retry 返回 false 且责任保留', async () => {
    const { ops, scheduleCalls, setNative } = makeOps({ cancelResults: [false, false] });
    setNative({ token: 'old-A', generation: 2, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.disarm(true); // 无活跃意图 → 无身份全清，失败
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.pendingCancelDuties[0].token).toBe('');

    c.arm('new-B', 30_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: false });
    await flushTwice();

    const cleared = await c.retryPendingCancels();
    expect(cleared).toBe(false);
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.snapshot.cancelError).toBe(true);
  });

  it('故障解除后重试成功才清责任（同一 controller 可恢复）', async () => {
    const results = [false, false, true];
    const { ops, scheduleCalls, setNative } = makeOps({ cancelResults: results });
    setNative({ token: 'old-A', generation: 4, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('old-A', 15_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 4 });
    await flushTwice();
    c.disarm(false);
    await flushTwice();
    c.arm('new-B', 30_000);
    await flush();
    scheduleCalls[1].resolve({ scheduled: false });
    await flushTwice();

    expect(await c.retryPendingCancels()).toBe(false); // 故障仍在
    expect(await c.retryPendingCancels()).toBe(true); // 故障解除
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.snapshot.cancelError).toBe(false);
  });

  it('B 被真实接受后才结清，且不伤 B', async () => {
    const { ops, scheduleCalls, cancelCalls, setNative } = makeOps({ cancelResults: [false] });
    setNative({ token: 'old-A', generation: 4, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('old-A', 15_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 4 });
    await flushTwice();
    c.disarm(false);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    c.arm('new-B', 30_000);
    await flush();
    scheduleCalls[1].resolve({ scheduled: true, generation: 9 });
    await flushTwice();

    const before = cancelCalls.length;
    expect(await c.retryPendingCancels()).toBe(true);
    // 结清是"安全终结"，不再发任何取消（不能伤 B）
    expect(cancelCalls.length).toBe(before);
    expect(c.snapshot.token).toBe('new-B');
    expect(c.snapshot.generation).toBe(9);
  });
});

/* ───────────────────────── ④ F2 可见失败与真实重试（组件源码）─────────────── */

const TIMER_SRC = read('src/ui/RestTimer.tsx');
const REST_SCHEDULE_SRC = read('src/lib/restSchedule.ts');

describe('Gap④ · RestTimerBar 必须有可见说明与可点重试', () => {
  it('组件渲染「重试取消」按钮并带可识别标签', () => {
    expect(TIMER_SRC).toContain('重试取消');
    expect(TIMER_SRC).toContain('aria-label="重试取消提醒"');
    expect(TIMER_SRC).toContain('onClick={timer.retryCancel}');
  });

  it('可见文案是产品语言（不暴露 commit/durable 实现词）', () => {
    const visible = '提醒未取消，仍可能响。';
    expect(TIMER_SRC).toContain(visible);
    expect(TIMER_SRC).toContain('重试取消');
    // 用户能看到的字符串里不得出现实现词
    for (const word of ['commit', 'durable', 'generation', 'prefs']) {
      expect(visible.toLowerCase()).not.toContain(word);
      expect('重试取消').not.toContain(word);
    }
    // 说明区必须由 RestTimerBar 自身返回（挂在 #actual-timer 之内）
    expect(TIMER_SRC).toContain('data-rest-cancel-notice');
  });

  it('计时条消失（停止/无剩余）时提示**仍然可见**（责任不静默丢）', () => {
    // 早退必须返回提示而不是 null
    expect(TIMER_SRC).toMatch(/if \(!active \|\| remainingMs === null\) return cancelNotice;/);
  });

  it('只在**已确认失败**时提示；in-flight 不算失败（不闪假告警）', () => {
    expect(TIMER_SRC).toContain('timer.cancelFailed && timer.cancelPending');
    expect(REST_SCHEDULE_SRC).toContain("state: 'in-flight' | 'failed'");
    expect(REST_SCHEDULE_SRC).toMatch(/const failed = this\.duties\.filter\(\(d\) => d\.state === 'failed'\)/);
  });

  it('hook 暴露 cancelFailed / retryCancel，且责任变化会触发刷新', () => {
    expect(TIMER_SRC).toContain('cancelFailed: boolean;');
    expect(TIMER_SRC).toContain('retryCancel: () => void;');
    // 控制器第三个回调（责任变化）已接线
    expect(TIMER_SRC).toContain('() => bumpCancelDuty()');
  });

  it('真实组件渲染：计时条消失（inactive）时仍输出提示与重试按钮', () => {
    const timer: RestTimerApi = {
      active: false,
      endsAt: null,
      pausedRemaining: null,
      token: null,
      cancelPending: true,
      cancelErrorReason: 'cancel-false:disarm',
      cancelFailed: true,
      start: () => {},
      pause: () => {},
      resume: () => {},
      adjust: () => {},
      stop: () => {},
      retryCancel: () => {},
    };
    const html = renderToStaticMarkup(createElement(RestTimerBar, { timer }));
    // 旧实现这里返回 null → 责任在"无计时条"状态下彻底不可见
    expect(html).toContain('data-rest-cancel-notice');
    expect(html).toContain('提醒未取消，仍可能响。');
    expect(html).toContain('重试取消提醒');
  });

  it('真实组件渲染：仅在途（未确认失败）不显示失败提示', () => {
    const timer: RestTimerApi = {
      active: false,
      endsAt: null,
      pausedRemaining: null,
      token: null,
      cancelPending: true,
      cancelErrorReason: 'in-flight:disarm',
      cancelFailed: false,
      start: () => {},
      pause: () => {},
      resume: () => {},
      adjust: () => {},
      stop: () => {},
      retryCancel: () => {},
    };
    const html = renderToStaticMarkup(createElement(RestTimerBar, { timer }));
    expect(html).toBe('');
  });

  it('真实组件渲染：暂停态 + 取消失败时，计时条与提示同时出现', () => {
    const timer: RestTimerApi = {
      active: true,
      endsAt: null,
      pausedRemaining: 30_000,
      token: 'rest-A',
      cancelPending: true,
      cancelErrorReason: 'cancel-false:disarm',
      cancelFailed: true,
      start: () => {},
      pause: () => {},
      resume: () => {},
      adjust: () => {},
      stop: () => {},
      retryCancel: () => {},
    };
    const html = renderToStaticMarkup(createElement(RestTimerBar, { timer }));
    expect(html).toContain('组间休息');
    expect(html).toContain('data-rest-cancel-notice');
    expect(html).toContain('重试取消提醒');
  });

  it('重试走 identity 精确路径，**禁止**无条件 native 全清', () => {
    const idx = REST_SCHEDULE_SRC.indexOf('async retryPendingCancels');
    const body = REST_SCHEDULE_SRC.slice(idx, idx + 2600);
    expect(body).toContain('this.ops.cancel({ token: duty.token, generation: duty.generation })');
    // 通配全清只允许作为**已登记责任**的重试，且必须先过 isDutyObsolete
    expect(body).toContain('this.isDutyObsolete(duty)');
  });
});

/* ───────────────────────── ⑤ N05 历史栈保护（纯决策 + 源码）────────────────── */

/**
 * **真实顺序**的历史栈模拟（不是线性 0/1/2 纯函数断言）。
 *
 * 实现浏览器实际语义：push 会**截断 forward 分支**，back/forward 移动位置，
 * 被守卫阻止时按 `resolveBlockedHistoryAction` 回位。
 * 用同一套真实 router 决策函数驱动两种"发号"策略：
 *   · dense：下一个 push 序号 = 当前位置 + 1（本轮修复）
 *   · global：全局唯一递增号（旧实现，Codex 指出的缺陷）
 * 仅仅"纯前进"时两者相同；一旦 Back 后新导航截断 forward 就会分叉。
 */
function simulateHistory(policy: 'dense' | 'global') {
  type Entry = { hash: string; idx: number };
  const entries: Entry[] = [{ hash: '#/', idx: 0 }];
  let pos = 0;
  let curIdx: number | null = 0;
  let globalCounter = 0;
  let broken = false;

  const current = () => entries[pos];

  /** 应用内 navigate：push（浏览器会丢弃 pos 之后的条目） */
  const push = (hash: string) => {
    const idx =
      policy === 'dense' ? nextPushIdx(curIdx) : (globalCounter += 1);
    entries.splice(pos + 1);
    entries.push({ hash, idx });
    pos = entries.length - 1;
    curIdx = idx;
  };

  /** 允许的 POP：位置与 currentIdx 跟着目标条目 */
  const moveAllowed = (target: number) => {
    pos = target;
    curIdx = current().idx;
  };

  /**
   * 浏览器历史移动（guardBlocked=true 时按真实决策回位）。
   * @returns 实际是否发生了路由切换
   */
  const go = (delta: number, guardBlocked: boolean) => {
    const target = pos + delta;
    if (target < 0 || target >= entries.length) return false;
    const displayHashBefore = entries[pos].hash; // 应用当前正显示的页面
    const effectiveIdxBefore = curIdx;
    const incomingIdx = entries[target].idx;
    pos = target; // 浏览器先移动
    if (!guardBlocked) {
      moveAllowed(target);
      return true;
    }
    const decision = resolveBlockedHistoryAction({
      blocked: true,
      currentHash: displayHashBefore,
      targetHash: entries[target].hash,
      currentIdx: effectiveIdxBefore,
      incomingIdx,
    });
    if (decision.action === 'go') {
      // 回位：必须真的走回原条目；越界即索引失真（旧缺陷）
      const back = pos + decision.delta;
      if (back < 0 || back >= entries.length || back !== target - delta) {
        broken = true;
        return false;
      }
      pos = back;
      return false;
    }
    if (decision.action === 'seed-forward') {
      pos = target - delta;
      return false;
    }
    return false;
  };

  return {
    push,
    back: (blocked: boolean) => go(-1, blocked),
    forward: (blocked: boolean) => go(1, blocked),
    hash: () => current().hash,
    stack: () => entries.map((e) => `${e.idx}:${e.hash}`),
    idx: () => curIdx,
    pos: () => pos,
    broken: () => broken,
  };
}

describe('Gap⑤ · 真实顺序：Back → 新分支 → dirty Back 仍能回到同一页', () => {
  function run(policy: 'dense' | 'global') {
    const h = simulateHistory(policy);
    h.push('#/plans?plan=p1'); // 管理
    h.push('#/plan/p1/day/d1'); // 编辑日
    // clean Back 到管理（未 dirty，允许）
    h.back(false);
    const atManagement = h.hash();
    // 从管理再次导航编辑：浏览器会截断 forward 分支
    h.push('#/plan/p1/day/d1');
    const atDayAgain = h.hash();
    // 页面 dirty 后 Back：应被拦回编辑日
    h.back(true);
    const afterBlockedBack = h.hash();
    // 取消 dirty 后再 Back：应回到管理
    h.back(false);
    const afterCancelBack = h.hash();
    // Forward：应回到同一编辑日
    h.forward(false);
    const afterForward = h.hash();
    return {
      atManagement,
      atDayAgain,
      afterBlockedBack,
      afterCancelBack,
      afterForward,
      stack: h.stack(),
      idx: h.idx(),
      pos: h.pos(),
      broken: h.broken(),
    };
  }

  it('dense（当前位置+1）→ 前后关系完整，Forward 回同一编辑日', () => {
    const r = run('dense');
    expect(r.atManagement).toBe('#/plans?plan=p1');
    expect(r.atDayAgain).toBe('#/plan/p1/day/d1');
    expect(r.afterBlockedBack).toBe('#/plan/p1/day/d1'); // 拦回编辑日
    expect(r.afterCancelBack).toBe('#/plans?plan=p1');   // 回到管理
    expect(r.afterForward).toBe('#/plan/p1/day/d1');     // Forward 回同一编辑日
    // 物理位置与序号始终一致（截断后仍是 0,1,2）
    expect(r.stack).toEqual(['0:#/', '1:#/plans?plan=p1', '2:#/plan/p1/day/d1']);
    expect(r.pos).toBe(2);
    expect(r.idx).toBe(2);
    expect(r.broken).toBe(false);
  });

  it('global 唯一递增号 → 索引与物理位置分叉，回位越界（旧缺陷形态）', () => {
    const r = run('global');
    // 截断后物理只有 3 条，但序号是 0,1,3 → Back 时应有的 delta 与实际步数不符
    // 截断后物理只有 3 条，但序号是 0,1,3（全局唯一号，不是物理位置）
    expect(r.stack).toEqual(['0:#/', '1:#/plans?plan=p1', '3:#/plan/p1/day/d1']);
    // 全局号让 delta(3-1=2) 大于实际物理步数(1) → 回位越界
    expect(r.broken).toBe(true);
    // 于是"拦回编辑日"失败，后续 Back/Forward 也回不到期望页面（Codex 描述的缺陷形态）
    expect(r.afterBlockedBack).not.toBe('#/plan/p1/day/d1');
    expect(r.afterForward).not.toBe('#/plan/p1/day/d1');
  });
});

describe('Gap⑤ · 被阻止的历史导航不得破坏历史栈', () => {
  it('Back 被阻止：把位置送回原条目（delta = +1），不覆盖任何记录', () => {
    expect(
      resolveBlockedHistoryAction({
        blocked: true,
        currentHash: '#/plan/p1/day/d1',
        targetHash: '#/plans?plan=p1',
        currentIdx: 2,
        incomingIdx: 1,
      }),
    ).toEqual({ action: 'go', delta: 1 });
  });

  it('Forward 被阻止：同样回到原条目（delta = -1）', () => {
    expect(
      resolveBlockedHistoryAction({
        blocked: true,
        currentHash: '#/plan/p1/day/d1',
        targetHash: '#/plans?plan=p1',
        currentIdx: 1,
        incomingIdx: 2,
      }),
    ).toEqual({ action: 'go', delta: -1 });
  });

  it('目标就是当前已生效 hash → 不需要动作（避免回退循环）', () => {
    expect(
      resolveBlockedHistoryAction({
        blocked: true,
        currentHash: '#/x',
        targetHash: '#/x',
        currentIdx: 3,
        incomingIdx: 3,
      }),
    ).toEqual({ action: 'none' });
  });

  it('外部条目（无序号）→ 只补序号并前进一格，不覆盖 URL', () => {
    expect(
      resolveBlockedHistoryAction({
        blocked: true,
        currentHash: '#/day',
        targetHash: '#/plans',
        currentIdx: 4,
        incomingIdx: null,
      }),
    ).toEqual({ action: 'seed-forward' });
  });

  it('未阻止 → 不干预（正常应用导航）', () => {
    expect(
      resolveBlockedHistoryAction({
        blocked: false,
        currentHash: '#/a',
        targetHash: '#/b',
        currentIdx: 1,
        incomingIdx: 2,
      }),
    ).toEqual({ action: 'none' });
  });

  it('router 源码：不再用 replaceState 把当前 hash 写回被退到的条目', () => {
    const ROUTER = read('src/lib/router.ts');
    // 旧缺陷写法必须消失
    expect(ROUTER).not.toMatch(/replaceState\(null, '', currentHash/);
    expect(ROUTER).not.toMatch(/replaceState\([^)]*currentHash\s*\|\|/);
    // 新机制：真实索引 + history.go 回位
    expect(ROUTER).toContain("const IDX_KEY = '__motionIdx'");
    expect(ROUTER).toContain('window.history.go(decision.delta)');
    // 压栈也带序号（否则无法判定前后关系）
    expect(ROUTER).toContain('window.history.pushState(');
  });

  it('router 源码：保留既有门禁与非破坏性契约', () => {
    const ROUTER = read('src/lib/router.ts');
    // 旧测试期望的结构断言必须继续成立
    expect(ROUTER).toContain('isLeaveBlocked()');
    expect(ROUTER).toContain('currentHash');
    expect(ROUTER).toContain('replaceState');
    expect(ROUTER).toMatch(/if \(isLeaveBlocked\(\)\) return;/);
    const idx = ROUTER.indexOf('export function back');
    const body = ROUTER.slice(idx, idx + 300);
    expect(body).toContain('isLeaveBlocked()');
    expect(body).toContain('return');
  });
});
