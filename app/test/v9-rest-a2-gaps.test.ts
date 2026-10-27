/* A2：五项准确状态/诊断缺口的 JS 侧回归（对应 Codex 独立复验 5 项 FAIL）。

   ── 覆盖 ────────────────────────────────────────────────────
   1. 只有真正精确被拒才 exactDenied；不精确自身失败不重试、不假标；
   2. Receiver 持久化失败 vs 旧身份拒绝可区分（native 侧见 RestA2ReplyTest）；
   3. schedule 早退失败有记录（native 侧）；
   4. cancel=false 不得显示"已取消"（AST 抽取真实 diagLabel 执行）；
   5. canVibrate 必须含通知许可交集（native + JS fallback 双侧）。

   证据边界：diagLabel 用 AST 从真实 Settings.tsx 抽取后执行（不是复制文案）；
   canVibrate 走真实 restReminder.ts 桥接。**不运行 React DOM**，
   也不证明 Android 实际投递/震动。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import vm from 'node:vm';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const SETTINGS = resolve(process.cwd(), 'src/pages/Settings.tsx');
const AST = ts.createSourceFile(SETTINGS, readFileSync(SETTINGS, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 抽取真实 diagLabel 函数体并执行 */
function loadDiagLabel(): (line: string) => string {
  let src: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === 'diagLabel') src = n.getText(AST);
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!src) throw new Error('Settings.tsx 里找不到 diagLabel');
  const code = ts.transpileModule(`${src}\nmodule.exports = diagLabel;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod: { exports: unknown } = { exports: null };
  vm.runInNewContext(code, { module: mod, fmtTime: () => 'TIME', console });
  return mod.exports as (line: string) => string;
}

describe('A2 缺口 #4 · cancel=false 不得显示"已取消"', () => {
  it('cancel|rejected 显示"取消被拒绝（未取消）"，绝不出现"已取消"', () => {
    const label = loadDiagLabel();
    const out = label('1700000000000|cancel|rejected');
    expect(out).toContain('未取消');
    expect(out).not.toContain('已取消');
  });

  it('cancel|with-identity 才显示"已取消"', () => {
    const label = loadDiagLabel();
    const out = label('1700000000000|cancel|with-identity');
    expect(out).toContain('已取消');
  });

  it('cancel|full-clear 显示"已取消"', () => {
    const label = loadDiagLabel();
    expect(label('1700000000000|cancel|full-clear')).toContain('已取消');
  });
});

describe('A2 · notify 语义不得写成"已送达/已震动"', () => {
  it('notify-ok 只说明已调用系统接口', () => {
    const label = loadDiagLabel();
    const out = label('1700000000000|notify-ok|5');
    expect(out).toContain('调用');
    // 只能是"调用成功"，不得断言送达/震动；否定式说明（"不代表已…"）是允许的
    expect(out).not.toMatch(/已送达(?!或)/);
    expect(out).toMatch(/不代表|不保证/);
    // 关键：绝不能出现肯定式"已震动"/"已送达"表述
    expect(out).not.toContain('已震动。');
    expect(out).not.toContain('已送达。');
  });

  it('notify-blocked 说明未调用通知', () => {
    const label = loadDiagLabel();
    const out = label('1700000000000|notify-blocked|app-notifications-off');
    expect(out).toContain('未调用通知');
  });
});

describe('A2 缺口 #5 · canVibrate 必须含通知许可交集（JS fallback）', () => {
  async function load(opts: { native?: boolean; status?: Record<string, unknown> }) {
    vi.resetModules();
    if (opts.native !== false) {
      vi.doMock('@capacitor/core', () => ({
        registerPlugin: () => ({
          getStatus: async () => opts.status,
          requestNotificationPermission: async () => ({ notificationsGranted: true }),
          schedule: async () => ({ scheduled: true, exact: true, generation: 1 }),
          cancel: async () => ({ cancelled: true }),
          vibrateNow: async () => ({ vibrated: true }),
        }),
      }));
      vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    }
    return await import('../src/lib/restReminder');
  }

  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@capacitor/core');
    vi.resetModules();
  });

  it('无通知许可 → canVibrate=false（即使渠道允许震动）', async () => {
    const mod = await load({
      status: {
        notificationsGranted: false,
        appNotificationsEnabled: true,
        channelEnabled: true,
        channelVibrates: true,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      },
    });
    const cap = await mod.restReminderCapability();
    // 独立复验给的正是这个受控组合：旧实现 canAlert=false 但 canVibrate=true
    expect(cap.canAlert).toBe(false);
    expect(cap.canVibrate).toBe(false);
  });

  it('四项齐全才 canVibrate=true', async () => {
    const mod = await load({
      status: {
        notificationsGranted: true,
        appNotificationsEnabled: true,
        channelEnabled: true,
        channelVibrates: true,
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      },
    });
    const cap = await mod.restReminderCapability();
    expect(cap.canVibrate).toBe(true);
  });

  it('原生给了 canVibrate 字段时以原生为准（但仍不可强于 canAlert）', async () => {
    const mod = await load({
      status: {
        notificationsGranted: false,
        appNotificationsEnabled: true,
        channelEnabled: true,
        channelVibrates: true,
        canAlert: false,
        canVibrate: false, // native 已修正为含 perm 交集
        exactAlarmsGranted: true,
        sdkInt: 34,
        dozeCaveat: true,
      },
    });
    const cap = await mod.restReminderCapability();
    expect(cap.canAlert).toBe(false);
    expect(cap.canVibrate).toBe(false);
  });
});

describe('A2 · foregroundEnhancement 与 scheduled 是两个独立事实', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('@capacitor/core');
    vi.resetModules();
  });

  it('排程成功但增强未启用 → 两个字段分别如实上报', async () => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: () => ({
        getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: false, sdkInt: 34, dozeCaveat: true }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({
          scheduled: true,
          exact: false,
          generation: 4,
          path: 'inexact-no-permission',
          foregroundEnhancement: 'no-exact-permission',
        }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
        stopForegroundTimer: async () => ({ stopped: true }),
      }),
    }));
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    const mod = await import('../src/lib/restReminder');
    const r = await mod.scheduleRestReminder('rest-A', 15000);
    // 基础排程成功
    expect(r.scheduled).toBe(true);
    expect(r.generation).toBe(4);
    // 增强未启用，原因明确 —— 不能因为增强失败就报排程失败，反之亦然
    expect(r.foregroundEnhancement).toBe('no-exact-permission');
  });

  it('stopForegroundRestTimer 无身份 → fail-closed（A4 #2 契约变更）', async () => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: () => ({
        getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: true, sdkInt: 34, dozeCaveat: true }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true, generation: 1 }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
        stopForegroundTimer: async () => ({ stopped: true }),
      }),
    }));
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    const mod = await import('../src/lib/restReminder');
    // 无身份：必须拒绝且不产生副作用（A4 #2）
    await expect(mod.stopForegroundRestTimer('paused')).resolves.toBe(false);
  });

  it('stopForegroundRestTimer 带身份 → 透传真实结果', async () => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: () => ({
        getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: true, sdkInt: 34, dozeCaveat: true }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true, generation: 1 }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
        stopForegroundTimer: async () => ({ stopped: true }),
      }),
    }));
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    const mod = await import('../src/lib/restReminder');
    await expect(
      mod.stopForegroundRestTimer('paused', { token: 'rest-A', generation: 1 }),
    ).resolves.toBe(true);
  });

  it('插件没有该接口时安全返回 false（不抛错）', async () => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      registerPlugin: () => ({
        getStatus: async () => ({ notificationsGranted: true, exactAlarmsGranted: true, sdkInt: 34, dozeCaveat: true }),
        requestNotificationPermission: async () => ({ notificationsGranted: true }),
        schedule: async () => ({ scheduled: true, exact: true, generation: 1 }),
        cancel: async () => ({ cancelled: true }),
        vibrateNow: async () => ({ vibrated: true }),
      }),
    }));
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
    const mod = await import('../src/lib/restReminder');
    await expect(
      mod.stopForegroundRestTimer('stopped', { token: 'rest-A', generation: 1 }),
    ).resolves.toBe(false);
  });
});
