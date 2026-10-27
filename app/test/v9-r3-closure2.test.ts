/**
 * B4-R3 closure2 应用回归（第二次独立验收后的三个应用侧 FAIL）。
 *
 * <p>覆盖：
 *  · F2 fullClear：**已确认失败**必须立刻以 failed 发布（旧实现只留 in-flight →
 *    `cancelError=false`、`cancelFailed=0`，真实失败不可见）；
 *  · N05b：同一次 hashchange 只允许一个订阅者执行历史恢复（App/Plans 双 useRoute）；
 *  · N06：dirty 导入时必须在分流**之前**登记"等待中的新 ID"。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RestScheduleController } from '../src/lib/restSchedule';
import { claimHistoryRestore } from '../src/lib/router';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const flushTwice = async (): Promise<void> => {
  await flush();
  await flush();
};

const T0 = 1_800_000_000_000;

/** 最小原生镜像：cancel 可注入失败；schedule 一定成功 */
function makeNative(opts?: { cancelFails?: () => boolean }) {
  const state = {
    token: 'old-A' as string | null,
    generation: 4,
    notifId: 1,
    fired: false,
    lastIntentId: 3,
  };
  const cancels: Array<{ identity?: { token?: string; generation?: number } }> = [];
  const schedules: Array<{ token: string; intentId?: number }> = [];
  const ops = {
    schedule: async (token: string, _ms: number, _deadline?: number, intentId?: number) => {
      schedules.push({ token, intentId });
      state.token = token;
      state.generation += 1;
      state.lastIntentId = Math.max(state.lastIntentId, intentId ?? 0);
      return {
        scheduled: true,
        generation: state.generation,
        path: 'exact',
        lastIntentId: state.lastIntentId,
      };
    },
    cancel: async (identity?: { token?: string; generation?: number }) => {
      cancels.push({ identity });
      if (opts?.cancelFails?.()) return false;
      state.token = null;
      return true;
    },
    getActive: async () => ({
      available: true,
      active: state.token !== null,
      token: state.token,
      generation: state.generation,
      fired: state.fired,
      lastIntentId: state.lastIntentId,
    }),
  };
  return { ops, cancels, schedules, state };
}

describe('F2 · fullClear 已确认失败必须立刻发布为 failed', () => {
  it('wildcard 全清返回 false → pendingCancels=1 且 cancelError=true / cancelFailed=1', async () => {
    const native = makeNative({ cancelFails: () => true });
    const c = new RestScheduleController(native.ops);
    /**
     * Codex 的真实形态：原生提醒由 **API 直接排好**，controller 没有活跃意图
     * （`arm` 从未发生）→ `disarm(true)` 走的是**无身份全清**，不是精确取消。
     */
    c.disarm(true);
    await flushTwice();

    const snap = c.snapshot;
    expect(native.cancels).toHaveLength(1);          // 真实调用发生过
    expect(native.cancels[0].identity).toBeUndefined(); // 确实是无身份全清
    expect(snap.pendingCancels).toBe(1);             // 责任保留
    expect(snap.cancelFailed).toBe(1);               // 已确认失败计数
    expect(snap.cancelError).toBe(true);             // 旧实现在这里是 false（沉默失败）
    expect(snap.cancelErrorReason).toMatch(/full-clear/);
    // 责任是 failed 而不是 in-flight
    expect(c.pendingCancelDuties[0]?.state).toBe('failed');
  });

  it('持续故障下重试返回 false 且错误保持；故障解除后成功重试才清', async () => {
    let broken = true;
    const native = makeNative({ cancelFails: () => broken });
    const c = new RestScheduleController(native.ops);

    c.disarm(true); // 无活跃意图 → fullClear
    await flushTwice();
    expect(c.snapshot.cancelError).toBe(true);

    expect(await c.retryPendingCancels()).toBe(false); // 故障未解除：不假报成功
    await flushTwice();
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.snapshot.cancelError).toBe(true);

    broken = false;
    const retried = await c.retryPendingCancels();
    await flushTwice();
    expect(retried).toBe(true);
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.snapshot.cancelError).toBe(false);
  });

  it('精确责任失败同样是 failed（两者口径一致）', async () => {
    const native = makeNative({ cancelFails: () => true });
    const c = new RestScheduleController(native.ops);
    c.arm('old-A', 15_000, T0 + 15_000, 1);
    await flushTwice();
    c.disarm(false); // 精确取消当前身份
    await flushTwice();

    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.snapshot.cancelError).toBe(true);
    expect(c.pendingCancelDuties[0]?.state).toBe('failed');
  });
});

describe('N05b · 同一次历史事件只允许一个订阅者执行恢复', () => {
  it('同一 Event 对象：第一次 claim 成功，第二个订阅者被拒', () => {
    const event = { type: 'hashchange' };
    expect(claimHistoryRestore(event)).toBe(true);
    expect(claimHistoryRestore(event)).toBe(false); // App 已恢复，Plans 不再 go 第二次
    expect(claimHistoryRestore(event)).toBe(false);
  });

  it('不同事件（含我们自己 go() 引发的回位事件）都能各自处理', () => {
    const first = { type: 'hashchange' };
    const second = { type: 'hashchange' };
    expect(claimHistoryRestore(first)).toBe(true);
    expect(claimHistoryRestore(second)).toBe(true);
  });

  it('router 源码：hashchange 把事件对象传给恢复逻辑，并在恢复入口 claim', () => {
    const src = read('src/lib/router.ts');
    expect(src).toMatch(/const onChange = \(event: Event\) => \{/);
    expect(src).toContain('restoreEffectivePosition(readIdx(window.history.state), event)');
    expect(src).toContain('if (!claimHistoryRestore(event)) return;');
    // 恢复函数签名必须带 event（防止有人把 dedupe 摘掉）
    expect(src).toMatch(/function restoreEffectivePosition\(incomingIdx: number \| null, event: unknown\)/);
  });
});

describe('N06 · dirty 导入时必须在分流前登记等待中的新 ID', () => {
  const SRC = read('src/pages/Plans.tsx');

  it('pendingNewPlanIdRef 的登记早于 isAnyDirty 分流', () => {
    const importBlock = SRC.slice(SRC.indexOf('onImported={(imported: Plan) => {'));
    const block = importBlock.slice(0, importBlock.indexOf('pushToast={pushToast}'));
    const markAt = block.indexOf('pendingNewPlanIdRef.current = imported.id;');
    const dirtyAt = block.indexOf('if (isAnyDirty())');
    expect(markAt).toBeGreaterThan(-1);
    expect(dirtyAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(dirtyAt); // 旧实现是反的（dirty 分支直接 return）
  });

  it('初始化 effect 仍保留"等刷新、不判无效"的挂起规则', () => {
    const effectAt = SRC.indexOf('const pendingNew = pendingNewPlanIdRef.current;');
    expect(effectAt).toBeGreaterThan(-1);
    const body = SRC.slice(effectAt, effectAt + 600);
    expect(body).toContain('if (pendingNew && !plans.some((p) => p.id === pendingNew)) {');
    expect(body).toContain('return; // 等刷新，不判无效');
    expect(body).toContain('pendingNewPlanIdRef.current = null;');
  });

  it('放弃修改并切换仍把目标设为 pendingSwitch（不写训练 currentPlan）', () => {
    const at = SRC.indexOf('const performDiscardAndSwitch = (): void => {');
    const body = SRC.slice(at, at + 700);
    expect(body).toContain('if (target && target !== managePlanId) setManagePlanId(target);');
    expect(body).not.toContain('setCurrentPlan');
  });
});
