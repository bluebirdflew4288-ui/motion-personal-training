/* 需求 2：组间休息到时提醒的 JS↔原生桥接契约。

   ── 覆盖 ────────────────────────────────────────────────────
   1. 原生不可用时**如实降级**：不假装已排程（scheduled:false / reason:'not-native'）。
   2. 排程把剩余时间按整数毫秒传出，负数被夹到 0（不排"立刻触发"的闹钟）。
   3. 取消/消费/震动在原生不可用时是安全 no-op，不抛异常打断页面流程。
   4. 插件抛错时返回真实失败，不吞成成功。
   5. token 唯一性（同一毫秒连续两次也不相同）。

   证据边界：这是**桥接层**测试，用替身验证 JS 侧契约与参数形状；
   真实 Android 运行（AlarmManager 投递、通知渠道、锁屏）不在本文件覆盖范围，
   见 verify-expansion/PHASE-1-REPORT.md 的未验证项。 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** 以可控方式伪造 Capacitor 运行时，再重新 import 模块 */
async function loadBridge(opts: {
  native?: boolean;
  plugin?: Record<string, unknown> | null;
}) {
  vi.resetModules();
  const native = opts.native ?? true;
  const registered: Record<string, unknown> = {};

  vi.doMock('@capacitor/core', () => ({
    registerPlugin: (name: string) => {
      if (opts.plugin === null) throw new Error('plugin missing');
      registered[name] = opts.plugin;
      return opts.plugin;
    },
  }));

  vi.stubGlobal('Capacitor', {
    isNativePlatform: () => native,
    getPlatform: () => (native ? 'android' : 'web'),
  });

  const mod = await import('../src/lib/restReminder');
  return { mod, registered };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('@capacitor/core');
  vi.resetModules();
});

describe('需求 2 · 原生不可用时如实降级', () => {
  it('非原生平台：hasRestReminder=false', async () => {
    const { mod } = await loadBridge({ native: false });
    expect(mod.hasRestReminder()).toBe(false);
  });

  it('非原生平台：capability 返回 available:false（不假装可用）', async () => {
    const { mod } = await loadBridge({ native: false });
    const cap = await mod.restReminderCapability();
    expect(cap.available).toBe(false);
    expect(cap.dozeCaveat).toBe(true);
  });

  it('非原生平台：schedule 返回 not-native，不报成功', async () => {
    const { mod } = await loadBridge({ native: false });
    const r = await mod.scheduleRestReminder('rest-1', 60000);
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe('not-native');
  });

  it('非原生平台：cancel/consume/vibrate 都是安全 no-op', async () => {
    const { mod } = await loadBridge({ native: false });
    // cancel 返回真实布尔：不可用时为 false（不假装成功）
    await expect(mod.cancelRestReminder()).resolves.toBe(false);
    // consume API 已移除（REVIEW-1 #3）：桥接不再导出该方法
    expect((mod as Record<string, unknown>).consumeRestReminder).toBeUndefined();
    await expect(mod.vibrateNow()).resolves.toBeUndefined();
  });
});

describe('需求 2 · 参数形状与真实结果透传', () => {
  it('schedule 传出整数毫秒（60000 / 120000 / 180000）', async () => {
    const calls: Array<{ token: string; remainingMs: number }> = [];
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async (o: { token: string; remainingMs: number }) => {
          calls.push(o);
          return { scheduled: true, exact: true, triggerAtMs: 123 };
        },
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    await mod.scheduleRestReminder('rest-a', 60000);
    await mod.scheduleRestReminder('rest-b', 120000);
    await mod.scheduleRestReminder('rest-c', 180000);
    expect(calls.map((c) => c.remainingMs)).toEqual([60000, 120000, 180000]);
    expect(calls.every((c) => Number.isInteger(c.remainingMs))).toBe(true);
  });

  it('负数/小数剩余时间被规整为非负整数（不传出非法值）', async () => {
    const calls: Array<{ remainingMs: number }> = [];
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async (o: { token: string; remainingMs: number }) => {
          calls.push(o);
          return { scheduled: false, exact: false, reason: 'non-positive-delay' };
        },
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    await mod.scheduleRestReminder('rest-x', -5000);
    await mod.scheduleRestReminder('rest-y', 1500.7);
    expect(calls[0].remainingMs).toBe(0);
    expect(calls[1].remainingMs).toBe(1501);
    expect(calls.every((c) => c.remainingMs >= 0 && Number.isInteger(c.remainingMs))).toBe(true);
  });

  it('原生返回 scheduled:false 时原样透传（不改成成功）', async () => {
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: false,
          exactAlarmsGranted: false,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: false }),
        schedule: async () => ({ scheduled: false, exact: false, reason: 'exact-alarm-permission-denied' }),
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const r = await mod.scheduleRestReminder('rest-1', 60000);
    expect(r.scheduled).toBe(false);
    expect(r.exact).toBe(false);
    expect(r.reason).toBe('exact-alarm-permission-denied');
  });

  it('插件抛错 → 返回 plugin-error，不抛出到页面', async () => {
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => {
          throw new Error('boom');
        },
        requestNotificationPermission: async () => ({ notificationsGranted: false }),
        schedule: async () => {
          throw new Error('boom');
        },
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const r = await mod.scheduleRestReminder('rest-1', 60000);
    expect(r.scheduled).toBe(false);
    expect(r.reason).toBe('plugin-error');
    const cap = await mod.restReminderCapability();
    expect(cap.available).toBe(false);
  });

  it('capability 透传真实的权限与渠道状态', async () => {
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: true,
          appNotificationsEnabled: false,
          channelEnabled: false,
          channelVibrates: false,
          exactAlarmsGranted: false,
          sdkInt: 33,
          dozeCaveat: true,
          canAlert: false,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: false }),
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    const cap = await mod.restReminderCapability();
    expect(cap.available).toBe(true);
    expect(cap.notificationsGranted).toBe(true);
    expect(cap.exactAlarmsGranted).toBe(false);
    expect(cap.sdkInt).toBe(33);
  });

  it('requestNotificationPermission 返回真实布尔（拒绝时为 false）', async () => {
    const { mod } = await loadBridge({
      plugin: {
        getStatus: async () => ({
          notificationsGranted: false,
          exactAlarmsGranted: true,
          sdkInt: 34,
          dozeCaveat: true,
        }),
        requestNotificationPermission: async () => ({ notificationsGranted: false }),
        schedule: async () => ({ scheduled: true, exact: true }),
        cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
      },
    });
    await expect(mod.requestRestNotificationPermission()).resolves.toBe(false);
  });
});

describe('需求 2 · token 唯一性', () => {
  it('连续生成不重复（同一毫秒内也不重复）', async () => {
    const { mod } = await loadBridge({ native: false });
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) tokens.add(mod.newRestToken());
    expect(tokens.size).toBe(200);
  });

  it('token 带 rest- 前缀（便于日志与调试识别）', async () => {
    const { mod } = await loadBridge({ native: false });
    expect(mod.newRestToken().startsWith('rest-')).toBe(true);
  });
});

describe('补充 P1 #1 · 代次贯穿 cancel/consume', () => {
  function pluginWith(over: Record<string, unknown> = {}) {
    const cancelCalls: Array<{ token?: string; generation?: number } | undefined> = [];
    const base = {
      getStatus: async () => ({
        notificationsGranted: true,
        appNotificationsEnabled: true,
        channelEnabled: true,
        channelVibrates: true,
        canAlert: true,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      }),
      requestNotificationPermission: async () => ({ notificationsGranted: true }),
      schedule: async () => ({ scheduled: true, exact: true, generation: 7 }),
      cancel: async (o?: { token?: string; generation?: number }) => {
        cancelCalls.push(o);
        return { cancelled: true };
      },
      vibrateNow: async () => ({ vibrated: true }),
      ...over,
    };
    return { base, cancelCalls };
  }

  it('schedule 返回的 generation 被透传（调用方可保存）', async () => {
    const { base } = pluginWith();
    const { mod } = await loadBridge({ plugin: base });
    const r = await mod.scheduleRestReminder('rest-a', 60000);
    expect(r.generation).toBe(7);
  });

  it('cancel 带身份时传出 token 与 generation', async () => {
    const { base, cancelCalls } = pluginWith();
    const { mod } = await loadBridge({ plugin: base });
    await mod.cancelRestReminder({ token: 'rest-a', generation: 7 });
    expect(cancelCalls[0]).toEqual({ token: 'rest-a', generation: 7 });
  });

  it('cancel 不带身份时传空对象（显式全清）', async () => {
    const { base, cancelCalls } = pluginWith();
    const { mod } = await loadBridge({ plugin: base });
    await mod.cancelRestReminder();
    expect(cancelCalls[0]).toEqual({});
  });

  it('陈旧 cancel 被原生拒绝（cancelled:false）时如实返回 false', async () => {
    const { base } = pluginWith({
      cancel: async () => ({ cancelled: false, reason: 'stale-generation' }),
    });
    const { mod } = await loadBridge({ plugin: base });
    await expect(mod.cancelRestReminder({ token: 'rest-old', generation: 3 })).resolves.toBe(false);
  });

  it('cancel 写盘失败（cancelled:false）如实返回 false', async () => {
    const { base } = pluginWith({
      cancel: async () => ({ cancelled: false, reason: 'persist-failed:commit-failed' }),
    });
    const { mod } = await loadBridge({ plugin: base });
    await expect(mod.cancelRestReminder({ token: 'rest-a', generation: 7 })).resolves.toBe(false);
  });

  it('consume API 已移除，避免假门禁（REVIEW-1 #3）', async () => {
    const { base } = pluginWith();
    const { mod } = await loadBridge({ plugin: base });
    expect((mod as Record<string, unknown>).consumeRestReminder).toBeUndefined();
  });
});

describe('补充 P2 #3 · 完整能力状态透传（不乐观默认）', () => {
  function statusPlugin(status: Record<string, unknown>) {
    return {
      getStatus: async () => status,
      requestNotificationPermission: async () => ({ notificationsGranted: true }),
      schedule: async () => ({ scheduled: true, exact: true }),
      cancel: async () => ({ cancelled: true }),
      vibrateNow: async () => ({ vibrated: true }),
    };
  }

  it('渠道关闭 → canAlert=false（即使权限已允许）', async () => {
    const { mod } = await loadBridge({
      plugin: statusPlugin({
        notificationsGranted: true,
        appNotificationsEnabled: true,
        channelEnabled: false,
        channelVibrates: false,
        canAlert: false,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      }),
    });
    const cap = await mod.restReminderCapability();
    expect(cap.notificationsGranted).toBe(true);
    expect(cap.channelEnabled).toBe(false);
    expect(cap.canAlert).toBe(false);
  });

  it('App 总开关关闭 → canAlert=false', async () => {
    const { mod } = await loadBridge({
      plugin: statusPlugin({
        notificationsGranted: true,
        appNotificationsEnabled: false,
        channelEnabled: true,
        channelVibrates: true,
        canAlert: false,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      }),
    });
    const cap = await mod.restReminderCapability();
    expect(cap.appNotificationsEnabled).toBe(false);
    expect(cap.canAlert).toBe(false);
  });

  it('原生未提供 canAlert 时按三项合取计算（不乐观默认 true）', async () => {
    const { mod } = await loadBridge({
      plugin: statusPlugin({
        notificationsGranted: true,
        appNotificationsEnabled: true,
        channelEnabled: false, // 渠道关
        channelVibrates: true,
        // 故意不给 canAlert
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      }),
    });
    const cap = await mod.restReminderCapability();
    expect(cap.canAlert).toBe(false);
  });

  it('全部开启 → canAlert=true', async () => {
    const { mod } = await loadBridge({
      plugin: statusPlugin({
        notificationsGranted: true,
        appNotificationsEnabled: true,
        channelEnabled: true,
        channelVibrates: true,
        canAlert: true,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      }),
    });
    const cap = await mod.restReminderCapability();
    expect(cap.canAlert).toBe(true);
    expect(cap.channelVibrates).toBe(true);
  });
});
