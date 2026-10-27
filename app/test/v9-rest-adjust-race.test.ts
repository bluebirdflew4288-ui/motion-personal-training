/* B4-R2 优先级一 #2/#3：真实 Controller 链上的连续 ±15 与"已 fired 后 +15"。

   ── 为什么不能只测算式 ──────────────────────────────────────
   `v9-rest-expiry-adjust.test.ts` 已经从源码抽 adjust 并锁住了**算术**。
   但用户真实失败发生在**控制器/取消链**上：
     · 归零后原生已 fired → 用户 +15 → 控制器先 supersede/cancel 再 arm，
       cancel 是 fire-and-forget，排程可能先到原生；
     · 连续快速 +,+,- 会产生多个意图与多条 cancel/ack，顺序不确定。
   本文件用**生产 RestScheduleController** + 生产 RestReminderState 的等价语义
   （原生状态机在 Java 侧已被 RestIntentIdentityTest 独立锁住），
   验证控制器在这两种真实序列下**不会丢点、不会丢新意图、不会误取消新轮**。

   证据边界：这是 Node 层真实控制器 + 状态机契约，不是 React DOM/真机；
   React 事件层与真机投递由真实自查与独立复验覆盖。 */

import { describe, expect, it } from 'vitest';
import { RestScheduleController, type RestScheduleOps } from '../src/lib/restSchedule';

/** 模拟原生持久状态机的等价实现（与 RestReminderState 规则一致的最小镜像） */
interface NativeState {
  token: string | null;
  generation: number;
  fired: boolean;
  notifId: number;
  lastIntentId: number;
}

/**
 * @param opts.cancelFails 模拟**取消持久化失败**（真实可达：commit 失败时
 *   原生正确保留身份）。这是"旧状态仍在 → 排程到达"的唯一真实条件 ——
 *   取消成功时 FIFO 会先把旧状态清掉，排程自然成为新身份，不算重放。
 */
function makeNative(init?: Partial<NativeState>, opts?: { cancelFails?: boolean }) {
  const cancelFails = opts?.cancelFails === true;
  const state: NativeState = {
    token: null,
    generation: 0,
    fired: false,
    notifId: 0,
    lastIntentId: 0,
    ...init,
  };
  /** 排程历史（真实到达原生的请求） */
  const scheduled: Array<{
    token: string;
    remainingMs: number;
    deadlineAtMs: number | null;
    intentId: number;
    accepted: boolean;
    reason: string;
    generation: number | null;
  }> = [];
  const cancelled: Array<{ token?: string; generation?: number }> = [];

  const ops: RestScheduleOps = {
    schedule: async (token, remainingMs, deadlineAtMs, intentId) => {
      const id = typeof intentId === 'number' ? intentId : 0;
      if (remainingMs <= 0) {
        state.token = null;
        state.generation += 1;
        state.fired = false;
        scheduled.push({
          token,
          remainingMs,
          deadlineAtMs: deadlineAtMs ?? null,
          intentId: id,
          accepted: false,
          reason: 'non-positive-delay',
          generation: null,
        });
        return { scheduled: false, path: 'rejected-state-non-positive-delay' };
      }
      const sameToken = state.token === token;
      if (sameToken && state.fired) {
        if (id <= 0) {
          scheduled.push({
            token, remainingMs, deadlineAtMs: deadlineAtMs ?? null, intentId: id,
            accepted: false, reason: 'already-fired', generation: null,
          });
          return { scheduled: false, path: 'rejected-state-already-fired' };
        }
        if (id <= state.lastIntentId) {
          scheduled.push({
            token, remainingMs, deadlineAtMs: deadlineAtMs ?? null, intentId: id,
            accepted: false, reason: 'stale-intent', generation: null,
          });
          return { scheduled: false, path: 'rejected-state-stale-intent' };
        }
      }
      state.generation += 1;
      state.notifId += 1;
      state.token = token;
      state.fired = false;
      if (id > state.lastIntentId) state.lastIntentId = id;
      scheduled.push({
        token, remainingMs, deadlineAtMs: deadlineAtMs ?? null, intentId: id,
        accepted: true, reason: 'ok', generation: state.generation,
      });
      return { scheduled: true, generation: state.generation, path: 'exact' };
    },
    cancel: async (identity) => {
      cancelled.push(identity ? { ...identity } : {});
      if (cancelFails) return false; // 持久化失败：身份被正确保留
      if (!identity) {
        state.token = null;
        state.generation += 1;
        state.fired = false;
        return true;
      }
      if (state.token === identity.token && state.generation === identity.generation) {
        state.token = null;
        state.generation += 1;
        state.fired = false;
        return true;
      }
      return false; // 陈旧身份：不动当前
    },
    getActive: async () => ({
      available: true,
      active: state.token !== null && !state.fired,
      token: state.token,
      generation: state.generation,
      fired: state.fired,
    }),
  };

  return {
    ops,
    state,
    scheduled,
    cancelled,
    /** 模拟原生到点触发（唯一投递出口） */
    fire: (token: string, generation: number) => {
      if (state.token !== token || state.generation !== generation || state.fired) return false;
      state.fired = true;
      return true;
    },
  };
}

const T0 = 1_800_000_000_000;

describe('B4-R2 · 连续 ±15 不丢点', () => {
  it('running：+,+,- 三次真实点击 → 最终截止 = 基准 +15s（净 +15）', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);

    let now = T0;
    const base = 20_000;
    c.arm('rest-A', base, now + base, 1);
    await Promise.resolve();
    await Promise.resolve();

    // +15
    now += 100;
    let remaining = Math.max(0, (now - 100 + base) - now) + 15_000;
    c.arm('rest-A', remaining, now + remaining, 2);
    await Promise.resolve(); await Promise.resolve();

    // +15
    now += 100;
    remaining = Math.max(0, (now - 100 + remaining) - now) + 15_000;
    c.arm('rest-A', remaining, now + remaining, 3);
    await Promise.resolve(); await Promise.resolve();

    // -15
    now += 100;
    remaining = Math.max(0, (now - 100 + remaining) - now) - 15_000;
    c.arm('rest-A', remaining, now + remaining, 0);
    await new Promise((r) => setTimeout(r, 20));

    const accepted = native.scheduled.filter((s) => s.accepted);
    // 每次点击都真的到达原生（不丢点）
    expect(native.scheduled.length).toBe(4);
    /**
     * 最后一次的剩余 = 基准 20s + 15s(净) − 三次点击间真实流逝 300ms
     * = 34.7s。注意这里**必须**扣掉真实流逝：三次点击共 300ms 是真实时间，
     * 不扣反而是错的（那等于凭空多给 300ms 休息）。
     */
    expect(accepted[accepted.length - 1].remainingMs).toBe(34_700);
  });

  it('连续 5 次 +15：累计为基准 + 75s（不丢失、不重复）', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);
    let now = T0;
    let remaining = 10_000;
    c.arm('rest-A', remaining, now + remaining, 1);
    await Promise.resolve(); await Promise.resolve();

    for (let i = 0; i < 5; i += 1) {
      now += 10;
      remaining = Math.max(0, (now - 10 + remaining) - now) + 15_000;
      c.arm('rest-A', remaining, now + remaining, 2 + i);
      await Promise.resolve(); await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 20));

    const accepted = native.scheduled.filter((s) => s.accepted);
    expect(accepted.length).toBe(6);
    const last = accepted[accepted.length - 1];
    expect(last.remainingMs).toBeGreaterThanOrEqual(84_900);
    expect(last.remainingMs).toBeLessThanOrEqual(85_100);
  });

  it('减到 0 后 +15：仍从 0 起给完整 15s（不会因为归零而失效）', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);
    let now = T0;
    // 归零：arm(...,0)
    c.arm('rest-A', 0, now, 1);
    await new Promise((r) => setTimeout(r, 10));
    // 用户 +15
    now += 50;
    c.arm('rest-A', 15_000, now + 15_000, 2);
    await new Promise((r) => setTimeout(r, 20));

    const accepted = native.scheduled.filter((s) => s.accepted);
    expect(accepted.length).toBe(1);
    expect(accepted[0].remainingMs).toBe(15_000);
    expect(accepted[0].deadlineAtMs).toBe(now + 15_000);
  });
});

describe('B4-R2 · 已 fired 后 +15 建立新可投递身份', () => {
  it('原生已 fired → 用户 +15（新意图）→ 排程被接受，旧代次广播仍被拒', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);

    let now = T0;
    c.arm('rest-A', 60_000, now + 60_000, 1);
    await new Promise((r) => setTimeout(r, 20));
    const firstGen = native.state.generation;
    expect(firstGen).toBeGreaterThan(0);

    // 原生真实到点
    expect(native.fire('rest-A', firstGen)).toBe(true);
    expect(native.state.fired).toBe(true);

    // 用户 +15：控制器先 supersede（异步 cancel）再 arm
    now += 2_000;
    c.arm('rest-A', 15_000, now + 15_000, 2);
    await new Promise((r) => setTimeout(r, 30));

    // 新身份必须真的排上（不被 already-fired 吞掉）
    const accepted = native.scheduled.filter((s) => s.accepted);
    expect(accepted.length).toBe(2);
    expect(accepted[1].remainingMs).toBe(15_000);
    expect(native.state.fired).toBe(false);
    expect(native.state.token).toBe('rest-A');
    expect(native.state.generation).toBeGreaterThan(firstGen);

    // 旧代次广播不得再响
    expect(native.fire('rest-A', firstGen)).toBe(false);
    // 新代次可投递一次
    expect(native.fire('rest-A', native.state.generation)).toBe(true);
  });

  it('取消持久化失败 + 旧请求重放（同意图编号）→ stale-intent 拒绝，不重新响铃', async () => {
    /**
     * 真实条件：取消 commit 失败 → 原生**正确保留** fired 身份。
     * 此时迟到的旧排程请求（同意图编号）到达，必须被 stale-intent 挡掉。
     * 若取消成功，FIFO 会先清旧状态，排程自然成为新身份 —— 那不算重放，
     * 本用例刻意不把两种情况混为一谈。
     */
    const native = makeNative(undefined, { cancelFails: true });
    const c = new RestScheduleController(native.ops);
    let now = T0;
    c.arm('rest-A', 60_000, now + 60_000, 5);
    await new Promise((r) => setTimeout(r, 20));
    native.fire('rest-A', native.state.generation);

    // 重放同编号 5（迟到的旧排程请求；supersede 的 cancel 会失败、身份保留）
    c.arm('rest-A', 15_000, now + 15_000, 5);
    await new Promise((r) => setTimeout(r, 40));

    const rejected = native.scheduled.filter((s) => !s.accepted);
    expect(rejected.some((r) => r.reason === 'stale-intent')).toBe(true);
    expect(native.state.fired).toBe(true);
  });

  it('取消持久化失败 + 无意图编号（自动恢复/接管）→ already-fired 门禁仍生效', async () => {
    const native = makeNative(undefined, { cancelFails: true });
    const c = new RestScheduleController(native.ops);
    let now = T0;
    c.arm('rest-A', 60_000, now + 60_000, 1);
    await new Promise((r) => setTimeout(r, 20));
    native.fire('rest-A', native.state.generation);

    // 自动恢复路径：不带意图编号
    c.arm('rest-A', 15_000, now + 15_000, 0);
    await new Promise((r) => setTimeout(r, 40));

    const rejected = native.scheduled.filter((s) => !s.accepted);
    expect(rejected.some((r) => r.reason === 'already-fired')).toBe(true);
    expect(native.state.fired).toBe(true);
  });

  it('取消成功（普通 FIFO）→ 排程按新身份接受（不是重放，正常业务路径）', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);
    let now = T0;
    c.arm('rest-A', 60_000, now + 60_000, 1);
    await new Promise((r) => setTimeout(r, 20));
    native.fire('rest-A', native.state.generation);

    c.arm('rest-A', 15_000, now + 15_000, 2);
    await new Promise((r) => setTimeout(r, 40));

    const accepted = native.scheduled.filter((s) => s.accepted);
    expect(accepted.length).toBe(2);
    expect(native.state.fired).toBe(false);
    expect(native.state.token).toBe('rest-A');
  });

  it('暂停后继续：不误取消新轮（新 arm 的身份不被旧 cancel 打掉）', async () => {
    const native = makeNative();
    const c = new RestScheduleController(native.ops);
    let now = T0;
    c.arm('rest-A', 30_000, now + 30_000, 1);
    await new Promise((r) => setTimeout(r, 20));
    const genA = native.state.generation;

    // 暂停：按身份取消
    c.disarm(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(native.state.token).toBeNull();

    // 继续：新意图
    now += 500;
    c.arm('rest-A', 25_000, now + 25_000, 2);
    await new Promise((r) => setTimeout(r, 30));

    // 新轮必须存活，且旧代次的取消不得作用于它
    expect(native.state.token).toBe('rest-A');
    expect(native.state.fired).toBe(false);
    expect(native.state.generation).toBeGreaterThan(genA);
    const lastCancel = native.cancelled[native.cancelled.length - 1];
    // 最后一次 cancel 若带身份，必须不是新轮的代次
    if (lastCancel && lastCancel.generation !== undefined) {
      expect(lastCancel.generation).not.toBe(native.state.generation);
    }
  });
});
