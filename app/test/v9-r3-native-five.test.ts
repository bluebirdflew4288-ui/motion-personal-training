/* B4-R3 原生五项续修 · 应用侧针对性回归（F2 controller 责任闭包 + D2 编号作用域）。

   ── 覆盖的五个已证失败（旧实现真实缺口）────────────────────
   ① D2-invalid-deadline：显式非法截止被当成缺省 → 退回 now+remainingMs 伪造截止；
   ② D2-expired-old-request：过期旧请求 full-clear 当前好提醒（含 alarm/service）；
   ③ D2-stale-intent-while-unfired：未 fired 时不核验意图水位；且 Plugin 在判定
      outcome 前就 cancelAlarmOnly() → NOOP 清掉好 alarm；
   ④ F2-pending-cancel-late-ACK-commit-failure：controller 把 cancel 的
      false/rejection 丢掉，静默 inactive，"暂停了但原生还活着"；
   ⑤ O3-identity-commit-failure-during-off：先写 enabled=false 再取消失败时
      假报 ok:true，形成半提交。

   ── 本文件的边界 ──────────────────────────────────────────
   ③ 的原生状态机与 ①②⑤ 的原生返回由 Java 侧
   `RestR3DeadlineTest` / `RestR3DurableTest` 独立锁住；
   本文件测 **生产 RestScheduleController 源码**在真实异步/迟到时序下的责任归属，
   以及 native 返回被"如实传导"而不是被吞掉。
   真机投递/声音/震动/Android 实际写盘不在本文件范围（报告如实标注）。 */

import { describe, expect, it } from 'vitest';
import {
  RestScheduleController,
  type PendingCancelDuty,
  type RestScheduleOps,
} from '../src/lib/restSchedule';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const flushTwice = async () => {
  await flush();
  await flush();
};

/** 可控原生层：每个 cancel 的返回值都能逐个指定 */
function makeOps(opts?: {
  cancelResults?: boolean[];
  cancelThrows?: boolean[];
  active?: { token: string | null; generation: number; fired: boolean; active: boolean } | null;
  getActiveAvailable?: boolean;
}) {
  const scheduleCalls: Array<{
    token: string;
    remainingMs: number;
    deadlineAtMs?: number;
    intentId?: number;
    resolve: (r: { scheduled: boolean; generation?: number }) => void;
  }> = [];
  const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
  let i = 0;
  let nativeActive = opts?.active ?? null;

  const ops: RestScheduleOps = {
    schedule: (token, remainingMs, deadlineAtMs, intentId) =>
      new Promise((resolve) => {
        scheduleCalls.push({ token, remainingMs, deadlineAtMs, intentId, resolve });
      }),
    cancel: async (identity) => {
      cancelCalls.push(identity);
      const idx = i++;
      if (opts?.cancelThrows?.[idx]) throw new Error('commit-boom');
      const r = opts?.cancelResults?.[idx];
      const ok = typeof r === 'boolean' ? r : true;
      if (ok && nativeActive) {
        const sameToken = identity?.token === nativeActive.token;
        const sameGen = identity?.generation === nativeActive.generation;
        // 精确身份匹配才清；无身份全清无条件清（真实 cancelIfCurrent 语义）
        if (!identity || (sameToken && sameGen)) nativeActive = null;
      }
      return ok;
    },
    getActive: async () => ({
      available: opts?.getActiveAvailable !== false,
      active: nativeActive !== null && nativeActive.active && !nativeActive.fired,
      token: nativeActive?.token ?? null,
      generation: nativeActive?.generation ?? 0,
      fired: nativeActive?.fired ?? false,
    }),
  };
  return {
    ops,
    scheduleCalls,
    cancelCalls,
    setNativeActive: (v: typeof nativeActive) => {
      nativeActive = v;
    },
  };
}

describe('F2 · 取消失败必须暴露而不是静默 inactive', () => {
  it('cancel 返回 false（原生写盘失败）→ controller 暴露 pendingCancels/cancelError', async () => {
    const { ops } = makeOps({ cancelResults: [false] });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 7;
    c.disarm(false);
    await flushTwice();

    const snap = c.snapshot;
    expect(snap.active).toBe(false);
    // 旧实现：current=null 后一切不可见 → pending 恒 false，静默成功
    expect(snap.pendingCancels).toBe(1);
    expect(snap.cancelError).toBe(true);
    expect(snap.cancelErrorReason).toContain('cancel-false');
    expect(c.cancelFailureCount).toBe(1);
    expect(c.cancelSuccessCount).toBe(0);
  });

  it('cancel 抛异常 → 同样保留责任，不静默', async () => {
    const { ops } = makeOps({ cancelThrows: [true] });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 3;
    c.disarm(false);
    await flushTwice();

    expect(c.snapshot.cancelError).toBe(true);
    expect(c.snapshot.cancelErrorReason).toContain('cancel-threw');
    expect(c.pendingCancelDuties[0]).toMatchObject({ token: 'rest-A', generation: 3 });
  });

  it('cancel 成功 → 责任立即释放（不会永远挂着）', async () => {
    const { ops } = makeOps({ cancelResults: [true] });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 4;
    c.disarm(false);
    await flushTwice();

    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.snapshot.cancelError).toBe(false);
    expect(c.cancelSuccessCount).toBe(1);
  });

  it('持续失败 + 可达重试 + 故障解除后重试成功才清责任', async () => {
    const results = [false, false, false, true];
    const { ops, setNativeActive } = makeOps({ cancelResults: results });
    // 原生**确实仍持有**该身份（写盘失败 → 身份被正确保留）→ 责任不可被终结
    setNativeActive({ token: 'rest-A', generation: 9, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 9;
    c.disarm(false);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    // 故障仍在：重试两次都失败 → 责任保留，attempts 累加
    expect(await c.retryPendingCancels()).toBe(false);
    expect(await c.retryPendingCancels()).toBe(false);
    expect(c.snapshot.pendingCancels).toBe(1);
    const duty = c.pendingCancelDuties[0];
    expect(duty.attempts).toBeGreaterThanOrEqual(2);
    expect(duty).toMatchObject({ token: 'rest-A', generation: 9 });

    // 故障解除：重试成功 → 彻底清理
    expect(await c.retryPendingCancels()).toBe(true);
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.snapshot.cancelError).toBe(false);
  });

  it('重试只按登记的原始身份发，绝不越权全清', async () => {
    const { ops, cancelCalls, setNativeActive } = makeOps({ cancelResults: [false, true] });
    setNativeActive({ token: 'rest-A', generation: 11, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 11;
    c.disarm(false);
    await flushTwice();

    await c.retryPendingCancels();
    // 每一次重试都必须携带精确身份（不是无身份全清）
    for (const call of cancelCalls) {
      expect(call).toBeDefined();
      expect(call).toMatchObject({ token: 'rest-A', generation: 11 });
    }
  });
});

describe('F2 修点② · 旧责任不能杀新 B', () => {
  it('通配责任（无身份全清失败）在**新 B 已被原生接受**后安全终结，重试不发全清', async () => {
    const { ops, cancelCalls, scheduleCalls } = makeOps({ cancelResults: [false] });
    const c = new RestScheduleController(ops);

    // 无活跃意图 → disarm(true) 走无身份全清，且失败
    c.disarm(true);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.pendingCancelDuties[0].token).toBe('');

    // 用户已经建立新 B，且原生**真的接受**了它
    c.arm('rest-B', 30_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 11 });
    await flushTwice();
    expect(c.snapshot.token).toBe('rest-B');
    const cancelsBeforeRetry = cancelCalls.length;

    const cleared = await c.retryPendingCancels();

    // 关键：绝不因为重试而发出无身份全清（那会杀掉 B）
    const newCancels = cancelCalls.slice(cancelsBeforeRetry);
    expect(newCancels.every((x) => x !== undefined)).toBe(true);
    expect(cleared).toBe(true);
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.reconciledDutyCount).toBeGreaterThanOrEqual(1);
    // B 的意图仍在（没有被这条旧责任打掉）
    expect(c.snapshot.token).toBe('rest-B');
  });

  it('精确旧责任在原生已无该身份时被安全终结（不永远挂错新轮）', async () => {
    const { ops, setNativeActive } = makeOps({ cancelResults: [false] });
    setNativeActive({ token: 'rest-A', generation: 5, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 5;
    c.disarm(false);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    // 用户在别的窗口/路径已让原生 clean（原生 getActive 报 active=false）
    (ops as unknown as { getActive: () => Promise<unknown> }).getActive = async () => ({
      available: true,
      active: false,
      token: null,
      generation: 0,
      fired: false,
    });

    const cleared = await c.retryPendingCancels();
    expect(cleared).toBe(true);
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.reconciledDutyCount).toBeGreaterThanOrEqual(1);
  });

  it('原生仍持有旧身份 → 责任必须保留（不能误判为已清理）', async () => {
    const { ops, setNativeActive } = makeOps({ cancelResults: [false, false] });
    setNativeActive({ token: 'rest-A', generation: 5, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 5;
    c.disarm(false);
    await flushTwice();

    const cleared = await c.retryPendingCancels();
    expect(cleared).toBe(false);
    expect(c.snapshot.pendingCancels).toBe(1);
  });

  it('旧精确责任重试不误伤新 B（新 B 换 token 且被接受后旧责任被终结）', async () => {
    const { ops, cancelCalls, scheduleCalls } = makeOps({ cancelResults: [false] });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 2;
    c.disarm(false);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    // 新 B 起来（不同 token）并被原生接受
    c.arm('rest-B', 20_000);
    await flush();
    scheduleCalls[0].resolve({ scheduled: true, generation: 9 });
    await flushTwice();
    const before = cancelCalls.length;
    await c.retryPendingCancels();

    // 旧 A 责任被安全终结，未对 A 再发取消（也不碰 B）
    expect(c.snapshot.pendingCancels).toBe(0);
    const extra = cancelCalls.slice(before);
    expect(extra.some((x) => x?.token === 'rest-A')).toBe(false);
    expect(c.snapshot.token).toBe('rest-B');
  });

  it('reset（训练实例切换）**保留**未完成责任 —— 不可静默丢', async () => {
    const { ops } = makeOps({ cancelResults: [false] });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 8;
    c.disarm(false);
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);

    c.reset();
    // 责任是精确身份绑定的：保留也不会误伤新训练的原生提醒
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.pendingCancelDuties).toHaveLength(1);
    expect(c.pendingCancelDuties[0]).toMatchObject({ token: 'rest-A', generation: 8 });
    // 但本控制器的活跃意图确实被清空了
    expect(c.snapshot.active).toBe(false);
  });
});

describe('F2 · 责任结构可被上层如实展示', () => {
  it('pendingCancelDuties 含精确 token/generation/原因/尝试次数', async () => {
    const { ops, setNativeActive } = makeOps({ cancelResults: [false, false] });
    setNativeActive({ token: 'rest-A', generation: 6, fired: false, active: true });
    const c = new RestScheduleController(ops);

    c.arm('rest-A', 60_000);
    await flush();
    (c as unknown as { current: { generation: number } }).current.generation = 6;
    c.disarm(false);
    await flushTwice();
    await c.retryPendingCancels();

    const d: PendingCancelDuty[] = c.pendingCancelDuties;
    expect(d).toHaveLength(1);
    expect(d[0].token).toBe('rest-A');
    expect(d[0].generation).toBe(6);
    expect(d[0].reason).toMatch(/cancel-false/);
    expect(d[0].attempts).toBeGreaterThanOrEqual(2);
    // 只读副本：改它不影响内部状态
    d[0].attempts = 999;
    expect(c.pendingCancelDuties[0].attempts).not.toBe(999);
  });
});

/* ── D2 三项：Plugin 侧接线（源码级结构断言，非复制业务公式）────────
   D2 的**状态机语义**由 Java `RestR3DeadlineTest` 独立锁住；
   这里锁"接线顺序"这一类只有 Plugin 源码才有的性质：
   · 显式非法截止必须早于任何 Store transition / alarm / service 副作用；
   · 过期旧请求不得 full-clear 当前好提醒；
   · NOOP 不得先 cancelAlarmOnly。
   断言对象是**生产源码文本**，因此接线被改回去时本测试会立刻失败。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PLUGIN_SRC = readFileSync(
  resolve(
    process.cwd(),
    'android/app/src/main/java/app/motion/personal/plugins/RestReminderPlugin.java',
  ),
  'utf8',
);

/** 截取 `public void schedule(PluginCall call) {` 起的方法体（按大括号配平） */
function scheduleMethodBody(src: string): string {
  const start = src.indexOf('public void schedule(PluginCall call) {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  throw new Error('schedule 方法体未闭合');
}

const SCHEDULE_BODY = scheduleMethodBody(PLUGIN_SRC);

describe('D2 接线 · 非法/过期/NOOP 都不得破坏当前好提醒', () => {
  it('显式非法截止返回 invalid-deadline，且早于任何 Store transition', () => {
    const invalidIdx = SCHEDULE_BODY.indexOf('invalid-deadline');
    expect(invalidIdx).toBeGreaterThan(-1);
    // 非法分支必须在第一次 RestReminderStore.transition 之前
    const firstTransition = SCHEDULE_BODY.indexOf('RestReminderStore.transition');
    expect(firstTransition).toBeGreaterThan(-1);
    expect(invalidIdx).toBeLessThan(firstTransition);
    // 且显式使用三态分类，不再把非法折成 null
    expect(SCHEDULE_BODY).toContain('classifyDeadline');
    expect(SCHEDULE_BODY).toContain('deadline.isInvalid()');
  });

  it('过期请求只拒绝自己：返回 deadline-already-passed 且不 cancelAlarmOnly', () => {
    const expiredIdx = SCHEDULE_BODY.indexOf('deadline-already-passed');
    expect(expiredIdx).toBeGreaterThan(-1);
    // 过期分支所在区间内不得出现 cancelAlarmOnly / State.cancel
    const nextResolve = SCHEDULE_BODY.indexOf('call.resolve(ret);', expiredIdx);
    expect(nextResolve).toBeGreaterThan(expiredIdx);
    const expiredBlock = SCHEDULE_BODY.slice(expiredIdx, nextResolve);
    expect(expiredBlock).not.toContain('cancelAlarmOnly');
    expect(expiredBlock).not.toContain('RestReminderState.cancel');
    expect(expiredBlock).not.toContain('RestCountdownService.stop');
    /**
     * 旧实现的关键特征：过期分支里先 transition(cancel) 再 cancelAlarmOnly。
     * 断言"从方法开始到 deadline-already-passed 之间没有出现过第二次 cancel 迁移"，
     * 保证没有把它改成"先记 cancel 再报告过期"的等价写法。
     */
    const beforeExpired = SCHEDULE_BODY.slice(0, expiredIdx);
    expect(beforeExpired).not.toContain('RestReminderState.cancel');
  });

  it('NOOP 不产生资源副作用：cancelAlarmOnly 只在 SCHEDULE 之后', () => {
    const rejectIdx = SCHEDULE_BODY.indexOf('rejected-state-');
    expect(rejectIdx).toBeGreaterThan(-1);
    const acceptIdx = SCHEDULE_BODY.indexOf('真正被接受的 SCHEDULE');
    expect(acceptIdx).toBeGreaterThan(-1);
    const cancelAlarmIdx = SCHEDULE_BODY.indexOf('cancelAlarmOnly();', acceptIdx);
    expect(cancelAlarmIdx).toBeGreaterThan(acceptIdx);
    // 拒绝分支（NOOP）必须在 cancelAlarmOnly 之前就 resolve 并 return
    expect(rejectIdx).toBeLessThan(cancelAlarmIdx);
    // 且拒绝分支自身不含 cancelAlarmOnly
    const rejectBlock = SCHEDULE_BODY.slice(rejectIdx, SCHEDULE_BODY.indexOf('call.resolve(ret);', rejectIdx));
    expect(rejectBlock).not.toContain('cancelAlarmOnly');
  });

  it('stale-intent 拒绝路径如实上报 outcomeAction（可观测，不静默）', () => {
    expect(SCHEDULE_BODY).toContain('outcomeAction');
  });
});
