/* G2 回归：排程返回**身份完整性**与"缺代次"的可观测性。

   ── 已确证的接线缺口（Codex 静态审查）───────────────────────
   精确调用抛 SecurityException 后走不精确降级、成功却漏回 generation。
   JS 侧 `RestScheduleController.dispatch` 只有拿到**数字** generation 才提交
   取消凭据；缺了它 → 之后 pause/stop 只能记 pendingCancel，而该请求已结束，
   不会再有带代次的迟到 ack 补偿 → **暂停了原生提醒仍残留**。

   证据边界：本文件用替身验证 JS 契约与控制器归属判定，
   **不执行**真实 Android AlarmManager / NotificationCenter，
   也不证明荣耀真机投递或震感。真实 Java 分支见 native-test/RestScheduleReplyTest.java。 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RestScheduleController, type RestScheduleOps } from '../src/lib/restSchedule';

async function loadBridge(opts: { plugin?: Record<string, unknown> }) {
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({
    registerPlugin: () => opts.plugin,
  }));
  vi.stubGlobal('Capacitor', {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  });
  return await import('../src/lib/restReminder');
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@capacitor/core');
  vi.resetModules();
});

describe('G2 · 降级分支必须回传可取消身份', () => {
  it('exact-denied 降级成功 → 桥接层透传 generation/notifId/path/exactDenied', async () => {
    const { scheduleRestReminder } = await loadBridge({
      plugin: {
        getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: false, sdkInt: 34, dozeCaveat: true }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({
          scheduled: true,
          exact: false,
          generation: 12,
          notifId: 5,
          triggerAtMs: 1_700_000_015_000,
          path: 'exact-denied-fallback-inexact',
          exactDenied: true,
          reason: 'exact-denied-fallback-inexact',
        }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
      },
    });

    const r = await scheduleRestReminder('rest-A', 15000);
    expect(r.scheduled).toBe(true);
    expect(r.exact).toBe(false);
    // 关键：降级成功也必须有真实代次，否则 pause 无法按身份取消
    expect(r.generation).toBe(12);
    expect(r.notifId).toBe(5);
    expect(r.path).toBe('exact-denied-fallback-inexact');
    expect(r.exactDenied).toBe(true);
  });

  it('"一开始就没精确权限"与"降级"两条路径可区分', async () => {
    const mk = (path: string, exactDenied: boolean) =>
      loadBridge({
        plugin: {
          getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: false, sdkInt: 34, dozeCaveat: true }),
          requestNotificationPermission: async () => ({ notificationsGranted: true }),
          schedule: async () => ({ scheduled: true, exact: false, generation: 3, path, exactDenied }),
          cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
        },
      });
    const a = await (await mk('inexact-no-permission', false)).scheduleRestReminder('rest-A', 1000);
    const b = await (await mk('exact-denied-fallback-inexact', true)).scheduleRestReminder('rest-B', 1000);
    expect(a.path).not.toBe(b.path);
    expect(a.exactDenied).toBe(false);
    expect(b.exactDenied).toBe(true);
  });
});

describe('G2 · 控制器：缺代次必须可观测（不再静默 pending）', () => {
  function opsWith(scheduleResult: { scheduled: boolean; generation?: number; path?: string }) {
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    const ops: RestScheduleOps = {
      schedule: async () => scheduleResult,
      cancel: async (identity) => {
        cancelCalls.push(identity);
        return true;
      },
    };
    return { ops, cancelCalls };
  }

  it('正常带代次 → 提交凭据，无缺口', async () => {
    const { ops } = opsWith({ scheduled: true, generation: 7, path: 'exact' });
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 15000);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.snapshot.generation).toBe(7);
    expect(c.identityGapCount).toBe(0);
    expect(c.hasIdentityGap).toBe(false);
    expect(c.lastSchedulePath).toBe('exact');
  });

  it('已排程但缺代次 → 记录缺口（旧行为是静默停在 pending）', async () => {
    const { ops } = opsWith({ scheduled: true, path: 'exact-denied-fallback-inexact' });
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 15000);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.snapshot.generation).toBeNull();
    // 缺口必须可观测，供状态提示/诊断使用
    expect(c.identityGapCount).toBe(1);
    expect(c.hasIdentityGap).toBe(true);
    expect(c.lastSchedulePath).toBe('exact-denied-fallback-inexact');
  });

  it('缺代次时 pause 仍只记待取消（不伪造代次、不误伤）', async () => {
    const { ops, cancelCalls } = opsWith({ scheduled: true });
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 15000);
    await new Promise((r) => setTimeout(r, 0));
    c.disarm(false);
    // 绝不伪造一个 generation 去取消：那会误伤/误报
    expect(cancelCalls).toHaveLength(0);
    expect(c.snapshot.active).toBe(false);
  });

  it('排程失败（scheduled:false）不算身份缺口', async () => {
    const { ops } = opsWith({ scheduled: false });
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 15000);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.identityGapCount).toBe(0);
    expect(c.hasIdentityGap).toBe(false);
  });

  it('随后拿到真实代次 → 缺口自动清除', async () => {
    let call = 0;
    const ops: RestScheduleOps = {
      schedule: async () => {
        call += 1;
        return call === 1 ? { scheduled: true } : { scheduled: true, generation: 9 };
      },
      cancel: async () => true,
    };
    const c = new RestScheduleController(ops);
    c.arm('rest-A', 15000);
    await new Promise((r) => setTimeout(r, 0));
    expect(c.hasIdentityGap).toBe(true);

    c.arm('rest-A', 30000); // 用户再次加时 → 新意图
    await new Promise((r) => setTimeout(r, 0));
    expect(c.snapshot.generation).toBe(9);
    expect(c.hasIdentityGap).toBe(false);
  });
});

describe('G2 · 准确状态提示所需字段', () => {
  it('canVibrate 单独判定，不被 canAlert 掩盖', async () => {
    const { restReminderCapability } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          appNotificationsEnabled: true,
          channelEnabled: true,
          channelVibrates: false, // 渠道震动被单独关掉
          canAlert: true,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true, generation: 1 }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const cap = await restReminderCapability();
    expect(cap.canAlert).toBe(true);
    // 通知可达但不会震动：必须能说清，不能笼统说"可以提醒"
    expect(cap.canVibrate).toBe(false);
    expect(cap.deliveryGuaranteed).toBe(false);
  });

  it('原生未给 canVibrate 时按渠道+总开关合取计算（不乐观默认 true）', async () => {
    const { restReminderCapability } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          appNotificationsEnabled: true,
          channelEnabled: true,
          channelVibrates: true,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const cap = await restReminderCapability();
    expect(cap.canVibrate).toBe(true);
    expect(cap.deliveryGuaranteed).toBe(false);
  });

  it('recentDiag 只接受字符串、最多 16 条（有界透传）', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `17000000000${i % 10}|fire|${i}`);
    const { restReminderCapability } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          appNotificationsEnabled: true,
          channelEnabled: true,
          channelVibrates: true,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
          recentDiag: [...many, 123 as unknown as string, null as unknown as string],
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const cap = await restReminderCapability();
    expect(cap.recentDiag.length).toBe(16);
    expect(cap.recentDiag.every((x) => typeof x === 'string')).toBe(true);
  });

  it('原生不可用时 recentDiag 为空、canVibrate=false（不假装可用）', async () => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false, getPlatform: () => 'web' });
    const mod = await import('../src/lib/restReminder');
    const cap = await mod.restReminderCapability();
    expect(cap.available).toBe(false);
    expect(cap.canVibrate).toBe(false);
    expect(cap.recentDiag).toEqual([]);
  });
});
