/* B3：休息提示"去系统设置"跳转的契约与安全边界。
   ── 证据边界 ────────────────────────────────────────────────
   验证 JS 桥接契约、受限目标、失败语义、以及"打开设置不触碰提醒状态"。
   **不执行**真实 Android Intent（宿主无法启动系统页），
   真机 MagicOS 页面可达性由 Codex 独立链/用户真机验证。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

async function loadBridge(plugin: Record<string, unknown> | null) {
  vi.resetModules();
  vi.doMock('@capacitor/core', () => ({ registerPlugin: () => plugin }));
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

describe('B3 · 跳转目标严格受限', () => {
  it('只接受三个目标，且原样传给原生', async () => {
    const calls: Array<{ target: string }> = [];
    const mod = await loadBridge({
      openRestReminderSettings: async (o: { target: string }) => {
        calls.push(o);
        return { opened: true, requestedTarget: o.target, actualTarget: o.target };
      },
    });
    await mod.openRestReminderSettings('app-notifications');
    await mod.openRestReminderSettings('rest-channel');
    await mod.openRestReminderSettings('exact-alarm');
    expect(calls.map((c) => c.target)).toEqual([
      'app-notifications',
      'rest-channel',
      'exact-alarm',
    ]);
  });

  it('JS 侧类型只允许这三个值（不允许任意 action/URI）', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/restReminder.ts'), 'utf8');
    expect(src).toContain(
      "export type SettingsTarget = 'app-notifications' | 'rest-channel' | 'exact-alarm';",
    );
    // 不得把任意字符串直接塞进 Intent
    expect(src).not.toContain('ACTION_APP_NOTIFICATION_SETTINGS');
  });
});

describe('B3 · opened 只代表请求被接受，不是授权', () => {
  it('opened=true 不携带任何"已允许"语义', async () => {
    const mod = await loadBridge({
      openRestReminderSettings: async () => ({ opened: true, actualTarget: 'app-notifications' }),
    });
    const r = await mod.openRestReminderSettings('app-notifications');
    expect(r.opened).toBe(true);
    // 返回体里不应有 granted/permitted 这类授权字段
    expect(Object.keys(r)).not.toContain('granted');
    expect(Object.keys(r)).not.toContain('permitted');
  });

  it('原生不可用 → opened:false + not-native', async () => {
    vi.resetModules();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false, getPlatform: () => 'web' });
    const mod = await import('../src/lib/restReminder');
    const r = await mod.openRestReminderSettings('app-notifications');
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('not-native');
  });

  it('插件没有该方法 → not-implemented（不假称支持）', async () => {
    const mod = await loadBridge({});
    const r = await mod.openRestReminderSettings('rest-channel');
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('not-implemented');
  });

  it('插件抛错 → plugin-error，不崩溃', async () => {
    const mod = await loadBridge({
      openRestReminderSettings: async () => {
        throw new Error('boom');
      },
    });
    const r = await mod.openRestReminderSettings('exact-alarm');
    expect(r.opened).toBe(false);
    expect(r.reason).toBe('plugin-error');
  });
});

describe('B3 · fallback 与真实目标如实上报', () => {
  it('实际目标与请求不同 → 透传 actualTarget 供 UI 说明', async () => {
    const mod = await loadBridge({
      openRestReminderSettings: async () => ({
        opened: true,
        requestedTarget: 'rest-channel',
        actualTarget: 'app-details',
      }),
    });
    const r = await mod.openRestReminderSettings('rest-channel');
    expect(r.opened).toBe(true);
    expect(r.requestedTarget).toBe('rest-channel');
    expect(r.actualTarget).toBe('app-details');
  });

  it('全部失败 → opened:false 且带原因（不谎称已打开）', async () => {
    const mod = await loadBridge({
      openRestReminderSettings: async () => ({
        opened: false,
        requestedTarget: 'exact-alarm',
        actualTarget: null,
        reason: 'all-failed:ActivityNotFoundException',
      }),
    });
    const r = await mod.openRestReminderSettings('exact-alarm');
    expect(r.opened).toBe(false);
    expect(r.actualTarget).toBeNull();
    expect(r.reason).toContain('all-failed');
  });
});

describe('B3 · 打开设置不得触碰提醒状态', () => {
  it('跳转实现里没有任何 schedule/cancel/vibrate 调用', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/lib/restReminder.ts'), 'utf8');
    const idx = src.indexOf('export async function openRestReminderSettings');
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, src.indexOf('/** 生成一次休息的唯一 token', idx));
    for (const forbidden of ['schedule(', 'cancel(', 'vibrateNow(', 'newRestToken(']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('原生侧只发 Intent，不改 token/generation/deadline', () => {
    const java = readFileSync(
      resolve(
        process.cwd(),
        'android/app/src/main/java/app/motion/personal/plugins/RestReminderPlugin.java',
      ),
      'utf8',
    );
    const idx = java.indexOf('public void openRestReminderSettings');
    expect(idx).toBeGreaterThan(-1);
    // 枚举已抽到纯类 RestSettingsTargets；此处只截到"打开结果类"为止
    const endMark = java.indexOf('/** 打开结果：opened 只代表系统接受请求，不是授权 */', idx);
    const body = java.slice(idx, endMark > idx ? endMark : idx + 4000);
    expect(body).not.toContain('RestReminderStore.transition');
    expect(body).not.toContain('cancelAlarmOnly');
    expect(body).not.toContain('RestCountdownService');
  });
});
