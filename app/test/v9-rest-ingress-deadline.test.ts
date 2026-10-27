/* B4-R2 优先级一 #1：JS→native 入口延迟不得把提醒向后推。

   ── 已确证的真实缺陷（Codex 只读审查 + 本轮实测）──────────────
   `useRestTimer` 在**用户点击时刻**用 `Date.now()` 算 endsAt 并开始倒计时；
   而 `RestReminderPlugin.schedule` 在**原生实际执行时刻**才用
       System.currentTimeMillis() + remainingMs
       SystemClock.elapsedRealtime() + remainingMs
   建截止。于是桥接/任务队列排队耗时 D 会被原样加到截止上：
   原生闹钟比 UI 意图晚 D，用户看到"UI 已经归零了，过一会才响"。
   A5 只固定了「Plugin→Service」那一段单调截止，没有覆盖「UI→Plugin」这一段。

   ── 本文件的证据级别 ────────────────────────────────────────
   用**生产 RestScheduleController 的真实源码**驱动，
   在注入的 ops.schedule 边界上用**真实 setTimeout 延迟**模拟桥接排队
   （时钟用真实 Date.now，延迟期间时间自然前进，不做冻结时钟的假模拟），
   断言控制器交给原生的必须是**发起时的绝对目标截止**。
   真机 MagicOS 投递/声音/震动不在本文件覆盖范围。 */

import { describe, expect, it } from 'vitest';
import { RestScheduleController, type RestScheduleOps } from '../src/lib/restSchedule';

interface Ingress {
  sentAt: number;
  ingressAt: number;
  token: string;
  remainingMs: number;
  deadlineAtMs: number | null;
  generation: number;
}

/**
 * 受控排程后端：`delayMs` 模拟 JS→Plugin 排队耗时（真实等待）。
 *
 * 旧原生语义：trigger = ingressNow + remainingMs
 * 期望语义：  trigger = deadlineAtMs
 */
function makeOps(delayMs: number) {
  const ingresses: Ingress[] = [];
  let generation = 0;
  const ops: RestScheduleOps = {
    schedule: async (token, remainingMs, deadlineAtMs) => {
      const sentAt = Date.now();
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const ingressAt = Date.now();
      generation += 1;
      ingresses.push({
        sentAt,
        ingressAt,
        token,
        remainingMs,
        deadlineAtMs: typeof deadlineAtMs === 'number' ? deadlineAtMs : null,
        generation,
      });
      return { scheduled: true, generation, path: 'exact' };
    },
    cancel: async () => true,
    getActive: async () => ({
      available: true,
      active: false,
      token: null,
      generation: 0,
      fired: false,
    }),
  };
  /** 旧实现下原生会建出的截止（入口时刻 + 剩余） */
  const legacyTriggerAt = (i: Ingress): number => i.ingressAt + i.remainingMs;
  /** 修复后原生应建出的截止（尊重发起目标截止） */
  const actualTriggerAt = (i: Ingress): number =>
    i.deadlineAtMs !== null
      ? i.ingressAt + Math.max(0, i.deadlineAtMs - i.ingressAt)
      : legacyTriggerAt(i);
  return { ops, ingresses, legacyTriggerAt, actualTriggerAt };
}

describe('B4-R2 · JS→native 入口延迟不得把截止向后推', () => {
  for (const delayMs of [0, 200, 1000]) {
    it(`桥接排队 ${delayMs}ms：原生截止必须等于点击时的目标截止（不额外赠送 ${delayMs}ms 休息）`, async () => {
      const backend = makeOps(delayMs);
      const c = new RestScheduleController(backend.ops);

      /** 用户点击「开始休息 60 秒」那一刻的绝对目标截止 */
      const targetDeadline = Date.now() + 60_000;
      c.arm('rest-A', 60_000, targetDeadline);

      await new Promise((r) => setTimeout(r, delayMs + 60));

      expect(backend.ingresses.length).toBe(1);
      const i = backend.ingresses[0];
      // 控制器必须把**发起目标截止**传给原生，而不是只给剩余量
      expect(i.deadlineAtMs).toBe(targetDeadline);

      const trigger = backend.actualTriggerAt(i);
      // 关键断言：原生截止 == 用户点击时的目标截止（排队耗时被扣掉）
      expect(trigger).toBe(targetDeadline);
      if (delayMs > 0) {
        // 旧语义确实会晚 delayMs —— 证明这条断言不是同义反复
        expect(backend.legacyTriggerAt(i) - targetDeadline).toBeGreaterThanOrEqual(delayMs);
        expect(trigger).not.toBe(backend.legacyTriggerAt(i));
      }
    });
  }

  it('连续两次排程：各自按发起截止，不累计漂移', async () => {
    const backend = makeOps(200);
    const c = new RestScheduleController(backend.ops);

    const d1 = Date.now() + 60_000;
    c.arm('rest-A', 60_000, d1);
    await new Promise((r) => setTimeout(r, 260));

    const d2 = Date.now() + 30_000;
    c.arm('rest-A', 30_000, d2);
    await new Promise((r) => setTimeout(r, 260));

    expect(backend.ingresses.length).toBe(2);
    expect(backend.ingresses[0].deadlineAtMs).toBe(d1);
    expect(backend.ingresses[1].deadlineAtMs).toBe(d2);
    for (const i of backend.ingresses) {
      expect(backend.actualTriggerAt(i)).toBe(i.deadlineAtMs);
    }
  });

  it('未提供目标截止的旧调用仍按剩余量排（兼容路径不被破坏）', async () => {
    const backend = makeOps(0);
    const c = new RestScheduleController(backend.ops);
    c.arm('rest-legacy', 45_000);
    await new Promise((r) => setTimeout(r, 60));
    expect(backend.ingresses.length).toBe(1);
    expect(backend.ingresses[0].deadlineAtMs).toBeNull();
    expect(backend.ingresses[0].remainingMs).toBe(45_000);
  });

  it('非法目标截止（NaN/0/负）被忽略，退回剩余量语义', async () => {
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const backend = makeOps(0);
      const c = new RestScheduleController(backend.ops);
      c.arm('rest-bad', 20_000, bad as number);
      await new Promise((r) => setTimeout(r, 60));
      expect(backend.ingresses.length).toBe(1);
      expect(backend.ingresses[0].deadlineAtMs).toBeNull();
    }
  });
});
