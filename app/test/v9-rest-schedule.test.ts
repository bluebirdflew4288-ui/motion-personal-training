/* REVIEW-1 #2：JS 异步排程的归属与补偿。

   ── 覆盖的真实序列 ──────────────────────────────────────────
   1. start(A) 后原生响应未回来就 pause → 迟到响应必须被补偿取消（暂停后不提醒）
   2. start(A) 后响应未回来就 stop → 同上
   3. start(A) → 响应回来 → start(B) → A 的旧凭据被精确取消，B 不受影响
   4. 乱序响应：B 的响应先回、A 的后回 → 旧响应不污染新凭据
   5. start(0) 跳过 → 必须取消已有提醒（旧实现漏了这一步）
   6. 同 token 调整/继续 → 新意图推进，旧响应补偿

   证据边界：本文件测试的是**协调器**（生产 hook 的真实依赖）。
   hook 自身的 React 生命周期（挂载/卸载时序）需要浏览器，见报告未验证项。 */

import { describe, expect, it } from 'vitest';
import { RestScheduleController, type RestScheduleOps } from '../src/lib/restSchedule';

/** 可控的假原生层：手动决定每个请求何时返回、返回什么 */
function makeOps() {
  const scheduleCalls: Array<{
    token: string;
    remainingMs: number;
    resolve: (r: { scheduled: boolean; generation?: number }) => void;
  }> = [];
  const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];

  const ops: RestScheduleOps = {
    schedule: (token, remainingMs) =>
      new Promise((resolve) => {
        scheduleCalls.push({ token, remainingMs, resolve });
      }),
    cancel: async (identity) => {
      cancelCalls.push(identity);
      return true;
    },
  };
  return { ops, scheduleCalls, cancelCalls };
}

/** 让所有已排队的 microtask 跑完 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('REVIEW-1 #2 · 迟到响应补偿', () => {
  it('start 后响应未回来就 pause → 迟到响应被补偿取消（暂停后不提醒）', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000);
    expect(scheduleCalls).toHaveLength(1);
    expect(c.snapshot.pending).toBe(true);

    // 响应还没回来就暂停
    c.disarm(false);
    expect(c.snapshot.active).toBe(false);

    // 现在原生响应才回来（已排上）
    scheduleCalls[0].resolve({ scheduled: true, generation: 5 });
    await flush();

    // 必须用**它自己的代次**补偿取消，否则提醒会照响
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 5 });
    expect(c.compensationCount).toBe(1);
  });

  it('start 后响应未回来就 stop → 同样补偿取消', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-B', 90000);
    c.disarm(true);
    scheduleCalls[0].resolve({ scheduled: true, generation: 3 });
    await flush();

    expect(cancelCalls).toContainEqual({ token: 'rest-B', generation: 3 });
  });

  it('响应正常回来 → 提交代次，无需补偿', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-C', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 8 });
    await flush();

    expect(c.snapshot.generation).toBe(8);
    expect(c.snapshot.pending).toBe(false);
    expect(c.compensationCount).toBe(0);
    expect(cancelCalls).toHaveLength(0);
  });
});

describe('REVIEW-1 #2 · 旧响应不污染新计时', () => {
  it('start(A) 已回 → start(B) → A 被精确取消，B 保留', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 1 });
    await flush();
    expect(c.snapshot.generation).toBe(1);

    c.arm('rest-B', 60000);
    // A 被取代时用 A 的代次精确取消（不会误伤 B）
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 1 });

    scheduleCalls[1].resolve({ scheduled: true, generation: 2 });
    await flush();
    expect(c.snapshot.token).toBe('rest-B');
    expect(c.snapshot.generation).toBe(2);
  });

  it('乱序响应：B 先回、A 后回 → 旧响应不覆盖新凭据', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000); // 请求 0
    c.arm('rest-B', 60000); // 请求 1（A 被取代）

    // B 的响应先回来
    scheduleCalls[1].resolve({ scheduled: true, generation: 20 });
    await flush();
    expect(c.snapshot.token).toBe('rest-B');
    expect(c.snapshot.generation).toBe(20);

    // A 的响应后回来（陈旧）
    scheduleCalls[0].resolve({ scheduled: true, generation: 10 });
    await flush();

    // 旧响应不得污染新凭据
    expect(c.snapshot.generation).toBe(20);
    expect(c.staleResponseCount).toBeGreaterThan(0);
    // 且 A 被补偿取消
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 10 });
  });

  it('旧响应即使 scheduled=false 也不影响当前状态', async () => {
    const { ops, scheduleCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000);
    c.arm('rest-B', 60000);
    scheduleCalls[1].resolve({ scheduled: true, generation: 30 });
    await flush();
    scheduleCalls[0].resolve({ scheduled: false });
    await flush();

    expect(c.snapshot.token).toBe('rest-B');
    expect(c.snapshot.generation).toBe(30);
  });
});

describe('REVIEW-1 #2 · start(0) 必须取消已有提醒', () => {
  it('已有 A → arm(0) → 取消 A（旧实现漏了）', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 4 });
    await flush();

    const cancelCountBefore = cancelCalls.length;
    c.arm('rest-0', 0); // 0 秒：跳过
    await flush();

    // 必须发生取消（要么精确取消 A，要么全清）
    expect(cancelCalls.length).toBeGreaterThan(cancelCountBefore);
    expect(c.snapshot.active).toBe(false);
  });

  it('arm(0) 时没有活跃提醒 → 仍然全清一次（保证无残留）', async () => {
    const { ops, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);
    c.arm('rest-0', 0);
    await flush();
    expect(cancelCalls.length).toBe(1);
    expect(cancelCalls[0]).toBeUndefined();
  });
});

describe('REVIEW-1 #2 · 同 token 调整/继续', () => {
  it('同 token 加时间：推进意图，旧响应被补偿', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000); // 请求 0
    c.arm('rest-A', 90000); // 请求 1（同 token，新意图）

    scheduleCalls[1].resolve({ scheduled: true, generation: 7 });
    await flush();
    expect(c.snapshot.generation).toBe(7);

    scheduleCalls[0].resolve({ scheduled: true, generation: 6 });
    await flush();
    // 旧代次 6 被补偿取消，当前仍是 7
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 6 });
    expect(c.snapshot.generation).toBe(7);
  });

  it('暂停后继续：disarm 再 arm，代次重新提交', async () => {
    const { ops, scheduleCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 11 });
    await flush();

    c.disarm(false); // 暂停
    expect(c.snapshot.active).toBe(false);

    c.arm('rest-A', 40000); // 继续
    scheduleCalls[1].resolve({ scheduled: true, generation: 12 });
    await flush();
    expect(c.snapshot.generation).toBe(12);
  });

  it('代次未知时 disarm(false) 不做全清（避免误杀后续新提醒）', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60000); // 响应未回
    c.disarm(false);
    // 不应立刻全清（那会误杀之后可能排上的新提醒）
    expect(cancelCalls).toHaveLength(0);

    // 迟到响应负责补偿
    scheduleCalls[0].resolve({ scheduled: true, generation: 2 });
    await flush();
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 2 });
  });
});

/* REVIEW-2 #1：排程成功必须回写快照代次，恢复必须把归属交给 controller。
   这两个断点导致真实 Chrome 链路里"快照 generation 恒 null、重建后 pause 不取消原生"。 */
describe('REVIEW-2 #1 · 代次回写与重建接管', () => {
  it('排程成功 → onCommit 回调收到真实代次（快照才能回写）', async () => {
    const { ops, scheduleCalls } = makeOps();
    const committed: Array<{ token: string; generation: number }> = [];
    const c = new RestScheduleController(ops, (t, g) => committed.push({ token: t, generation: g }));

    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 42 });
    await flush();

    expect(committed).toEqual([{ token: 'rest-A', generation: 42 }]);
    expect(c.snapshot.generation).toBe(42);
  });

  it('迟到/被取代的响应不触发 onCommit（不污染快照）', async () => {
    const { ops, scheduleCalls } = makeOps();
    const committed: Array<{ token: string; generation: number }> = [];
    const c = new RestScheduleController(ops, (t, g) => committed.push({ token: t, generation: g }));

    c.arm('rest-A', 60000);
    c.arm('rest-B', 60000);
    scheduleCalls[1].resolve({ scheduled: true, generation: 2 });
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 1 });
    await flush();

    // 只有 B 的代次被提交
    expect(committed).toEqual([{ token: 'rest-B', generation: 2 }]);
  });

  it('adopt 之后 pause 会按身份取消（重建路径与新建路径一致）', async () => {
    const { ops, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);

    // 模拟重建：快照里有 token + 代次
    c.adopt('rest-restored', 7);
    expect(c.snapshot.active).toBe(true);
    expect(c.snapshot.generation).toBe(7);

    c.disarm(false); // 恢复后 pause
    expect(cancelCalls).toContainEqual({ token: 'rest-restored', generation: 7 });
    expect(c.snapshot.active).toBe(false);
  });

  it('adopt 后 stop 也会取消（不留遗留提醒）', async () => {
    const { ops, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);
    c.adopt('rest-restored', 9);
    c.disarm(true);
    expect(cancelCalls.length).toBeGreaterThan(0);
    expect(c.snapshot.active).toBe(false);
  });

  it('adopt 后 adjust（重排）走正常意图，旧代次不残留', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);
    c.adopt('rest-restored', 11);
    c.arm('rest-restored', 30000); // 加减时间
    // 旧代次被精确取消
    expect(cancelCalls).toContainEqual({ token: 'rest-restored', generation: 11 });
    scheduleCalls[0].resolve({ scheduled: true, generation: 12 });
    await flush();
    expect(c.snapshot.generation).toBe(12);
  });

  it('adopt(null 代次) 时 disarm(false) 不做全清（未知凭据保守处理）', async () => {
    const { ops, cancelCalls } = makeOps();
    const c = new RestScheduleController(ops);
    c.adopt('rest-unknown', null);
    c.disarm(false);
    // 代次未知 → 不盲目全清（避免误杀其它提醒）
    expect(cancelCalls).toHaveLength(0);
  });

  it('reset 清空归属（训练实例切换）', async () => {
    const { ops, scheduleCalls } = makeOps();
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 5 });
    await flush();
    c.reset();
    expect(c.snapshot.active).toBe(false);
    expect(c.snapshot.token).toBeNull();
  });
});

/* REVIEW-3 #1：generation=null 是**正常生命周期窗口**（start 已落原生、ack 未回就重建），
   不是旧版本兼容问题。必须向原生实际核对，并在等待期间保留 pause/stop 意图。 */
describe('REVIEW-3 #1 · 未知代次的核对与安全接管', () => {
  /** 带 getActive 的可控原生层 */
  function makeOpsWithActive(active: {
    available?: boolean;
    active?: boolean;
    token?: string | null;
    generation?: number;
    fired?: boolean;
  } | null) {
    const scheduleCalls: Array<{
      token: string;
      remainingMs: number;
      resolve: (r: { scheduled: boolean; generation?: number }) => void;
    }> = [];
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    let resolveActive: ((v: unknown) => void) | null = null;

    const ops: RestScheduleOps = {
      schedule: (token, remainingMs) =>
        new Promise((resolve) => {
          scheduleCalls.push({ token, remainingMs, resolve });
        }),
      cancel: async (identity) => {
        cancelCalls.push(identity);
        return true;
      },
      getActive: () =>
        new Promise((resolve) => {
          if (active !== null) {
            resolve({
              available: true,
              active: true,
              token: 'rest-A',
              generation: 7,
              fired: false,
              ...active,
            });
          } else {
            // 挂起：由测试手动放行
            resolveActive = resolve as (v: unknown) => void;
          }
        }),
    };
    return { ops, scheduleCalls, cancelCalls, releaseActive: (v: unknown) => resolveActive?.(v) };
  }

  it('核对到同一 token 的活跃提醒 → 用原生真实代次接管', async () => {
    const { ops } = makeOpsWithActive({ token: 'rest-A', generation: 7 });
    const c = new RestScheduleController(ops);
    const r = await c.adoptVerified('rest-A');
    expect(r.verified).toBe(true);
    expect(r.active).toBe(true);
    expect(r.generation).toBe(7);
    expect(c.snapshot.generation).toBe(7);
  });

  it('接管后 pause 能按身份取消（不再"保守不取消"）', async () => {
    const { ops, cancelCalls } = makeOpsWithActive({ token: 'rest-A', generation: 7 });
    const c = new RestScheduleController(ops);
    await c.adoptVerified('rest-A');
    c.disarm(false);
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 7 });
    expect(c.snapshot.active).toBe(false);
  });

  it('原生已无该提醒（已触发）→ 判为 inactive，交由 UI 清理', async () => {
    const { ops } = makeOpsWithActive({ token: 'rest-A', generation: 7, active: false });
    const c = new RestScheduleController(ops);
    const r = await c.adoptVerified('rest-A');
    expect(r.verified).toBe(true);
    expect(r.active).toBe(false);
    expect(c.snapshot.active).toBe(false);
  });

  it('token 不匹配（原生持有别的提醒）→ 不接管当前，避免误伤', async () => {
    const { ops } = makeOpsWithActive({ token: 'rest-OTHER', generation: 9 });
    const c = new RestScheduleController(ops);
    const r = await c.adoptVerified('rest-A');
    expect(r.active).toBe(false);
    expect(c.snapshot.active).toBe(false);
  });

  it('等待核对期间 pause → 核对完成后按真实代次补取消', async () => {
    const { ops, cancelCalls, releaseActive } = makeOpsWithActive(null); // 挂起
    const c = new RestScheduleController(ops);
    const pending = c.adoptVerified('rest-A');

    // 核对还没回来，用户已经暂停
    c.disarm(false);
    // 此时还没法取消（代次未知），但意图必须被记住
    expect(cancelCalls).toHaveLength(0);

    // 核对结果到达：同一 token、真实代次 7
    releaseActive({ available: true, active: true, token: 'rest-A', generation: 7, fired: false });
    const r = await pending;

    // 必须补取消，否则"暂停了却仍会提醒"
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 7 });
    expect(r.active).toBe(false);
    expect(c.snapshot.active).toBe(false);
  });

  it('无法核实（原生不可用）→ 保持待定，不假装已接管', async () => {
    const { ops } = makeOpsWithActive({ available: false });
    const c = new RestScheduleController(ops);
    const r = await c.adoptVerified('rest-A');
    expect(r.verified).toBe(false);
    // 待定：后续 pause 会记录待取消意图
    c.disarm(false);
    expect(c.snapshot.active).toBe(false);
  });

  it('核对期间换了新计时 → 不覆盖新意图', async () => {
    const { ops, releaseActive, cancelCalls } = makeOpsWithActive(null);
    const c = new RestScheduleController(ops);
    const pending = c.adoptVerified('rest-A');
    c.arm('rest-B', 60000); // 新计时
    releaseActive({ available: true, active: true, token: 'rest-A', generation: 7, fired: false });
    await pending;
    // 当前仍是 B 的意图，A 的核对结果不得覆盖
    expect(c.snapshot.token).toBe('rest-B');
    expect(cancelCalls).toHaveLength(0);
  });
});

/* REVIEW-4：两处接线修正的纯逻辑侧断言。
   ① 旧实例卸载后必须失效回写（但不取消原生）；
   ② 陈旧 query 结果不得控制新计时（owned 门禁）。 */
describe('REVIEW-4 #1 · 卸载后失效回写', () => {
  function makeOpsSimple() {
    const scheduleCalls: Array<{
      token: string;
      remainingMs: number;
      resolve: (r: { scheduled: boolean; generation?: number }) => void;
    }> = [];
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    const ops: RestScheduleOps = {
      schedule: (token, remainingMs) =>
        new Promise((resolve) => scheduleCalls.push({ token, remainingMs, resolve })),
      cancel: async (identity) => {
        cancelCalls.push(identity);
        return true;
      },
    };
    return { ops, scheduleCalls, cancelCalls };
  }

  it('dispose 后 isDisposed=true，且 onCommit 不再被提交', async () => {
    const { ops, scheduleCalls } = makeOpsSimple();
    const committed: Array<{ token: string; generation: number }> = [];
    const c = new RestScheduleController(ops, (t, g) => committed.push({ token: t, generation: g }));

    c.arm('rest-A', 60000);
    c.dispose(); // 组件卸载
    expect(c.isDisposed).toBe(true);

    scheduleCalls[0].resolve({ scheduled: true, generation: 5 });
    await flush();

    // 旧实例的迟到 ack 不得提交（否则会把新页面的 paused 快照改回 running）
    expect(committed).toHaveLength(0);
    /**
     * dispose **保留归属**（不清空 current/seq）：
     * StrictMode 重放会 setup→activate 后继续使用它；
     * 真正卸载时回写由 disposed 标记阻断，不靠清空归属实现。
     */
    expect(c.isDisposed).toBe(true);
    expect(c.snapshot.token).toBe('rest-A');
  });

  it('dispose 不触发取消原生（只阻断回写）', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOpsSimple();
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 3 });
    await flush();
    const before = cancelCalls.length;

    c.dispose();
    await flush();
    // 卸载不应产生任何取消调用
    expect(cancelCalls.length).toBe(before);
  });
});

describe('REVIEW-4 补充 · 陈旧 query 不得控制新计时', () => {
  function makeOpsDeferred() {
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    let release: ((v: unknown) => void) | null = null;
    const ops: RestScheduleOps = {
      schedule: async () => ({ scheduled: true, generation: 1 }),
      cancel: async (identity) => {
        cancelCalls.push(identity);
        return true;
      },
      getActive: () =>
        new Promise((resolve) => {
          release = resolve as (v: unknown) => void;
        }),
    };
    return { ops, cancelCalls, release: (v: unknown) => release?.(v) };
  }

  it('query A 在途 → 换新计时 B → A 迟到返回时 owned=false', async () => {
    const { ops, release } = makeOpsDeferred();
    const c = new RestScheduleController(ops);
    const pending = c.adoptVerified('rest-A');

    // 用户换了新计时 B
    c.arm('rest-B', 60000);

    // A 的核对结果此时才回来
    release({ available: true, active: true, token: 'rest-A', generation: 7, fired: false });
    const r = await pending;

    // 结果不属于当前意图 → 调用方不得用它改 UI/快照
    expect(r.owned).toBe(false);
    expect(c.snapshot.token).toBe('rest-B');
  });

  it('query 在途 → 用户暂停 → 结果 owned 但 active=false 不代表暂停失效', async () => {
    const { ops, release, cancelCalls } = makeOpsDeferred();
    const c = new RestScheduleController(ops);
    const pending = c.adoptVerified('rest-A');
    c.disarm(false); // 暂停
    release({ available: true, active: true, token: 'rest-A', generation: 9, fired: false });
    const r = await pending;
    // 按身份补取消（暂停应生效）
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 9 });
    expect(r.active).toBe(false);
  });

  it('dispose 后 query 结果 owned=false（卸载门禁同样覆盖 query）', async () => {
    const { ops, release } = makeOpsDeferred();
    const c = new RestScheduleController(ops);
    const pending = c.adoptVerified('rest-A');
    c.dispose();
    release({ available: true, active: true, token: 'rest-A', generation: 4, fired: false });
    const r = await pending;
    expect(r.owned).toBe(false);
  });
});

/* StrictMode 开发态 effect 重放：setup/cleanup 必须正确配对。
   React 开发态会 setup → cleanup → setup（复用同一 controller）。
   旧实现 cleanup 无条件永久 dispose，导致重放后 ack 回写被阻断。 */
describe('StrictMode 重放 · dispose/activate 配对', () => {
  function makeOpsSimple() {
    const scheduleCalls: Array<{
      token: string;
      remainingMs: number;
      resolve: (r: { scheduled: boolean; generation?: number }) => void;
    }> = [];
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    const ops: RestScheduleOps = {
      schedule: (token, remainingMs) =>
        new Promise((resolve) => scheduleCalls.push({ token, remainingMs, resolve })),
      cancel: async (identity) => {
        cancelCalls.push(identity);
        return true;
      },
    };
    return { ops, scheduleCalls, cancelCalls };
  }

  it('setup → cleanup → setup 后，迟到 ack 仍能提交代次（重放不永久失效）', async () => {
    const { ops, scheduleCalls } = makeOpsSimple();
    const committed: Array<{ token: string; generation: number }> = [];
    const c = new RestScheduleController(ops, (t, g) => committed.push({ token: t, generation: g }));

    c.activate();      // 首次 setup
    c.arm('rest-A', 60000);
    c.dispose();       // StrictMode 的额外 cleanup
    c.activate();      // 紧随其后的 setup（复用同一 controller）

    scheduleCalls[0].resolve({ scheduled: true, generation: 7 });
    await flush();

    // 重放后 ack 必须仍能回写，否则快照 generation 永远为 null
    expect(committed).toEqual([{ token: 'rest-A', generation: 7 }]);
    expect(c.snapshot.generation).toBe(7);
  });

  it('真正卸载（dispose 后无 setup）→ 迟到 ack 仍被阻断', async () => {
    const { ops, scheduleCalls } = makeOpsSimple();
    const committed: Array<{ token: string; generation: number }> = [];
    const c = new RestScheduleController(ops, (t, g) => committed.push({ token: t, generation: g }));

    c.activate();
    c.arm('rest-A', 60000);
    c.dispose();       // 真正卸载：不会再有 setup

    scheduleCalls[0].resolve({ scheduled: true, generation: 9 });
    await flush();

    expect(committed).toHaveLength(0);
    expect(c.isDisposed).toBe(true);
  });

  it('dispose 不清空归属（重放后仍持有意图）', async () => {
    const { ops, scheduleCalls } = makeOpsSimple();
    const c = new RestScheduleController(ops);
    c.activate();
    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 3 });
    await flush();

    c.dispose();
    // 归属仍在：重放后 setup 可直接继续使用
    expect(c.snapshot.token).toBe('rest-A');
    expect(c.snapshot.generation).toBe(3);

    c.activate();
    expect(c.isDisposed).toBe(false);
    c.disarm(false); // 恢复后 pause 仍能按身份取消
    expect(c.snapshot.active).toBe(false);
  });

  it('重放后暂停取消仍按身份生效（取消不被误报为失败）', async () => {
    const { ops, scheduleCalls, cancelCalls } = makeOpsSimple();
    const c = new RestScheduleController(ops);
    c.activate();
    c.arm('rest-A', 60000);
    scheduleCalls[0].resolve({ scheduled: true, generation: 5 });
    await flush();

    c.dispose();
    c.activate();
    c.disarm(false);
    expect(cancelCalls).toContainEqual({ token: 'rest-A', generation: 5 });
  });
});
