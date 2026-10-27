import { describe, expect, it } from 'vitest';
import { RestScheduleController } from '../src/lib/restSchedule';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const flushTwice = async (): Promise<void> => {
  await flush();
  await flush();
};

const T0 = 1_800_000_000_000;

/**
 * 模拟原生端旧版本 schema 行为：
 * 初始持久态无 lastIntentToken 键；
 * 但原生在 Snapshot 构造时正规化其归属为当前活跃 token，
 * 从而在取消后进行 -15（无编号）时完好保留水位 3。
 */
function makeLegacyNative(initialWatermark = 3) {
  let state = {
    token: 'legacy-A' as string | null,
    generation: 4,
    notifId: 1,
    fired: false,
    lastIntentId: initialWatermark,
    // 旧 schema 初始无 lastIntentToken，正规化为 active token
    lastIntentToken: 'legacy-A' as string | null,
  };

  let failCancel = false;
  const schedules: Array<{ token: string; intentId: number; scheduled: boolean }> = [];

  const ops = {
    schedule: async (token: string, _remainingMs: number, _deadline?: number, intentId?: number) => {
      const id = intentId ?? 0;
      const sameToken = state.token !== null && token === state.token;
      const sameLineage = state.token === null && state.lastIntentToken !== null && token === state.lastIntentToken;

      // 处于同编号空间（活跃同 token 或取消后回流的同 token）
      if (id > 0 && (sameToken || sameLineage) && id <= state.lastIntentId) {
        schedules.push({ token, intentId: id, scheduled: false });
        return {
          scheduled: false,
          reason: 'stale-intent',
          lastIntentId: state.lastIntentId,
        };
      }

      state.token = token;
      state.generation += 1;
      state.notifId += 1;

      // 同编号空间不降水位；新 token 起算
      if (sameToken || sameLineage) {
        state.lastIntentId = id > state.lastIntentId ? id : state.lastIntentId;
      } else {
        state.lastIntentId = id > 0 ? id : 0;
      }
      state.lastIntentToken = token;

      schedules.push({ token, intentId: id, scheduled: true });
      return {
        scheduled: true,
        generation: state.generation,
        lastIntentId: state.lastIntentId,
      };
    },

    cancel: async (identity?: { token?: string; generation?: number }) => {
      if (failCancel) return false;
      if (identity?.token && identity.token !== state.token) return false;
      if (identity?.generation && identity.generation !== state.generation) return false;
      state.token = null;
      state.generation += 1;
      // 取消保留水位与 lineage
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

  return {
    ops,
    schedules,
    state: () => ({ ...state }),
    setFailCancel: (v: boolean) => {
      failCancel = v;
    },
  };
}

describe('B4-R3 legacy-lineage · 旧原生 schema 水位归属与控制器交互', () => {
  it('旧 schema 活跃 A -> 取消 -> 减时 -15 -> 水位保留 3，控制器遵从有界自愈合同', async () => {
    const native = makeLegacyNative(3);
    const c = new RestScheduleController(native.ops);
    c.adopt('legacy-A', 4);

    // 1. 取消活跃 A
    c.disarm(false);
    await flushTwice();
    expect(native.state().token).toBeNull();
    expect(native.state().lastIntentId).toBe(3);
    expect(native.state().lastIntentToken).toBe('legacy-A');

    // 2. 合法减时 -15（无编号，intentId=0）
    c.arm('legacy-A', 45_000, T0 + 45_000, 0);
    await flushTwice();
    expect(native.state().token).toBe('legacy-A');
    expect(native.state().lastIntentId).toBe(3); // 未被清零！

    // 3. 用户发起意图编号 2（小于原生当前水位 3）：
    // 原生状态机首次收到 2 时必须以 stale-intent 拒绝；
    // 控制器作为最新未取消的当前意图，遵从已验的有界自愈合同：保留原 deadline 并用 (3+1)=4 重发一次
    c.arm('legacy-A', 15_000, T0 + 15_000, 2);
    await flushTwice();
    const replayAttempt = native.schedules.find((s) => s.intentId === 2);
    expect(replayAttempt).toBeDefined();
    expect(replayAttempt?.scheduled).toBe(false); // 原生确拒旧意图 2

    // 控制器合同：自愈发生且仅 1 次，提号至 4 并成功排程
    expect(c.staleResyncCount).toBe(1);
    const selfHealAttempt = native.schedules.find((s) => s.intentId === 4);
    expect(selfHealAttempt).toBeDefined();
    expect(selfHealAttempt?.scheduled).toBe(true);
    expect(native.state().lastIntentId).toBe(4);

    // 4. 后续新意图编号 5：正常排程并推进水位至 5
    c.arm('legacy-A', 60_000, T0 + 60_000, 5);
    await flushTwice();
    const lastNewer = native.schedules[native.schedules.length - 1];
    expect(lastNewer.intentId).toBe(5);
    expect(lastNewer.scheduled).toBe(true);
    expect(native.state().lastIntentId).toBe(5);
  });

  it('新 token B 到达时不受旧 legacy-A 水位限制，从 1 起算', async () => {
    const native = makeLegacyNative(20); // 旧 A 水位高达 20
    const c = new RestScheduleController(native.ops);
    c.adopt('legacy-A', 4);
    c.disarm(false);
    await flushTwice();

    // 切换到全新 token B，编号 1
    c.arm('new-B', 15_000, T0 + 15_000, 1);
    await flushTwice();
    expect(native.state().token).toBe('new-B');
    expect(native.state().lastIntentId).toBe(1); // 从 1 起算，不受 20 限制
  });

  it('旧 schema 下写盘故障保持责任并暴露错误，故障解除后成功清理', async () => {
    const native = makeLegacyNative(3);
    native.setFailCancel(true);

    const c = new RestScheduleController(native.ops);
    c.adopt('legacy-A', 4);

    c.disarm(false);
    await flushTwice();

    // 故障期间：责任保留，cancelError 为 true
    expect(c.snapshot.pendingCancels).toBe(1);
    expect(c.snapshot.cancelError).toBe(true);
    expect(native.state().token).toBe('legacy-A'); // 原生保留

    // 重试仍失败
    const retryFail = await c.retryPendingCancels();
    expect(retryFail).toBe(false);
    expect(c.snapshot.pendingCancels).toBe(1);

    // 故障解除
    native.setFailCancel(false);
    const retryOk = await c.retryPendingCancels();
    expect(retryOk).toBe(true);
    expect(c.snapshot.pendingCancels).toBe(0);
    expect(c.snapshot.cancelError).toBe(false);
    expect(native.state().token).toBeNull();
  });
});
