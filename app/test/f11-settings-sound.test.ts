/* F11：音效开关的持久化、备份兼容与「独立于休息提醒」。
   用真实 fake-indexeddb + 真实 repo 读写，不走假设的算法。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGet, idbPut } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEFAULT_SETTINGS,
  buildBackup,
  loadSettings,
  restoreBackup,
  saveSettings,
  validateBackup,
  type AppSettings,
  type BackupPayload,
} from '../src/db/repo';

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('F11 音效开关：默认值与持久化', () => {
  it('默认开启（删除成功音是默认体验，不需要用户先去打开）', () => {
    expect(DEFAULT_SETTINGS.soundEnabled).toBe(true);
  });

  it('首次读取（没有任何 settings 行）→ 开启', async () => {
    const s = await loadSettings();
    expect(s.soundEnabled).toBe(true);
  });

  it('旧版本设置行（没有该字段）→ 补默认值，不回写、不破坏其他字段', async () => {
    const legacy = { key: 'app', theme: 'dark', currentPlanId: 'p9', lastExportAt: 123, lastBackupPromptAt: null, seenVersion: '0.1.8' };
    await idbPut('settings', legacy);
    const s = await loadSettings();
    expect(s.soundEnabled).toBe(true);
    expect(s.theme).toBe('dark');
    expect(s.currentPlanId).toBe('p9');
    expect(s.lastExportAt).toBe(123);
    // 存储里仍是旧行：读取层补缺省，不做隐式迁移
    const raw = (await idbGet<Record<string, unknown>>('settings', 'app'))!;
    expect('soundEnabled' in raw).toBe(false);
  });

  it('关闭后真实落库，重新读取仍为关闭', async () => {
    await saveSettings({ soundEnabled: false });
    expect((await loadSettings()).soundEnabled).toBe(false);
  });

  it('保存其他设置不会把音效开关重置', async () => {
    await saveSettings({ soundEnabled: false });
    await saveSettings({ theme: 'dark' });
    const s = await loadSettings();
    expect(s.soundEnabled).toBe(false);
    expect(s.theme).toBe('dark');
  });

  it('再次开启也真实落库', async () => {
    await saveSettings({ soundEnabled: false });
    await saveSettings({ soundEnabled: true });
    expect((await loadSettings()).soundEnabled).toBe(true);
  });

  it('开关与休息提醒的存储互不相干（设置里没有提醒渠道/权限字段）', () => {
    const keys = Object.keys(DEFAULT_SETTINGS);
    expect(keys).toContain('soundEnabled');
    for (const forbidden of ['reminderEnabled', 'channelEnabled', 'canSound', 'notificationsGranted', 'exactAlarmsGranted']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});

describe('F11 音效开关与备份兼容', () => {
  it('导出备份带上该字段（向前兼容，字段缺失也能读）', async () => {
    await saveSettings({ soundEnabled: false });
    const backup = await buildBackup('0.1.9');
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.data.settings[0].soundEnabled).toBe(false);
  });

  it('旧备份（没有该字段）仍然可以校验通过', () => {
    const legacy = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: 1_700_000_000_000,
      appVersion: '0.1.8',
      counts: { plans: 0, sessions: 0, activeSessions: 0, exerciseTemplates: 0 },
      data: {
        plans: [],
        sessions: [],
        settings: [{ key: 'app', theme: 'light', currentPlanId: null, lastExportAt: null, lastBackupPromptAt: null, seenVersion: null }],
        exerciseTemplates: [],
      },
    };
    const r = validateBackup(legacy);
    expect(r.ok).toBe(true);
  });

  it('当前备份版本同时保留 F11 本地音效偏好契约', () => {
    expect(BACKUP_VERSION).toBe(4);
  });

  it('恢复备份不覆盖本机音效开关（本机交互偏好），但主题仍然按备份恢复', async () => {
    await saveSettings({ soundEnabled: false, theme: 'light' });
    const payload: BackupPayload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: 1_700_000_000_000,
      appVersion: '0.1.9',
      counts: { plans: 0, sessions: 0, activeSessions: 0, exerciseTemplates: 0 },
      data: {
        plans: [],
        sessions: [],
        settings: [{ ...DEFAULT_SETTINGS, theme: 'dark', soundEnabled: true } as AppSettings],
        exerciseTemplates: [],
      },
    };
    await restoreBackup(payload);
    const after = await loadSettings();
    // 主题：备份说了算（既有语义）
    expect(after.theme).toBe('dark');
    // 音效：保持本机选择，不被旧备份打开
    expect(after.soundEnabled).toBe(false);
  });

  it('恢复后本机开启状态同样保留', async () => {
    await saveSettings({ soundEnabled: true });
    const payload: BackupPayload = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: 1_700_000_000_000,
      appVersion: '0.1.9',
      counts: { plans: 0, sessions: 0, activeSessions: 0, exerciseTemplates: 0 },
      data: {
        plans: [],
        sessions: [],
        settings: [{ ...DEFAULT_SETTINGS, soundEnabled: false } as AppSettings],
        exerciseTemplates: [],
      },
    };
    await restoreBackup(payload);
    expect((await loadSettings()).soundEnabled).toBe(true);
  });
});
