import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { idbClear, idbGetAll } from '../src/db/idb';
import {
  atomicDeletePlanWithCurrent,
  DEFAULT_SETTINGS,
  listPlans,
  loadSettings,
  savePlan,
  saveSettings,
} from '../src/db/repo';
import { createV32Plan } from '../src/domain/presets/v32';

const NOW = 1_793_124_000_000;

beforeEach(async () => {
  for (const store of ['plans', 'sessions', 'settings', 'meta']) await idbClear(store);
});

async function seedPlanSettings() {
  await savePlan({ ...createV32Plan(NOW), id: 'A' });
  await savePlan({ ...createV32Plan(NOW + 1), id: 'B' });
  return saveSettings({
    currentPlanId: 'A', theme: 'light', lastExportAt: NOW,
    lastBackupPromptAt: NOW - 1000, seenVersion: 'existing-sentinel',
  });
}

describe('Permanent settings behavior contract', () => {
  it('fills defaults, preserves untouched fields and stores explicit null in exactly one app row', async () => {
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    const created = await saveSettings({ theme: 'dark', currentPlanId: 'A', lastExportAt: NOW });
    expect(created).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', currentPlanId: 'A', lastExportAt: NOW });
    const patched = await saveSettings({ currentPlanId: null, lastExportAt: null });
    expect(patched).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', currentPlanId: null, lastExportAt: null });
    expect(await loadSettings()).toEqual(patched);
    expect(await idbGetAll('settings')).toEqual([patched]);
  });

  it('retains all acknowledged distinct-field patches when they overlap', async () => {
    await seedPlanSettings();
    const results = await Promise.all([
      saveSettings({ theme: 'dark' }),
      saveSettings({ currentPlanId: 'B' }),
      saveSettings({ lastExportAt: NOW + 5000 }),
      saveSettings({ lastBackupPromptAt: null }),
      saveSettings({ seenVersion: 'new-sentinel' }),
    ]);
    expect(results[0].theme).toBe('dark');
    expect(results[1].currentPlanId).toBe('B');
    expect(results[2].lastExportAt).toBe(NOW + 5000);
    expect(results[3].lastBackupPromptAt).toBeNull();
    expect(results[4].seenVersion).toBe('new-sentinel');
    expect(await loadSettings()).toEqual({
      ...DEFAULT_SETTINGS, theme: 'dark', currentPlanId: 'B',
      lastExportAt: NOW + 5000, lastBackupPromptAt: null, seenVersion: 'new-sentinel',
    });
  });

  it.each(['patch-first', 'delete-first'])('%s preserves the atomic current-plan fallback and unrelated values', async (order) => {
    await seedPlanSettings();
    const patch = () => saveSettings({ theme: 'dark' });
    const del = () => atomicDeletePlanWithCurrent('A', (current, remaining) => current === 'A' ? remaining[0] ?? null : undefined);
    const result = await Promise.all(order === 'patch-first' ? [patch(), del()] : [del(), patch()]);
    const deletion = result[order === 'patch-first' ? 1 : 0] as { ok: boolean; newCurrentPlanId?: string | null };
    expect(deletion.ok).toBe(true);
    expect(deletion.newCurrentPlanId).toBe('B');
    expect((await listPlans()).map((plan) => plan.id)).toEqual(['B']);
    expect(await loadSettings()).toEqual({
      ...DEFAULT_SETTINGS, theme: 'dark', currentPlanId: 'B', lastExportAt: NOW,
      lastBackupPromptAt: NOW - 1000, seenVersion: 'existing-sentinel',
    });
  });

  it('rejects transaction abort after settings put request success and preserves the old committed row', async () => {
    const before = await seedPlanSettings();
    const originalPut = IDBObjectStore.prototype.put;
    let requestSuccesses = 0;
    let inducedAborts = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      if (this.name === 'settings' && (value as { key?: string })?.key === 'app') {
        const transaction = this.transaction;
        request.addEventListener('success', () => {
          requestSuccesses += 1;
          transaction.abort();
          inducedAborts += 1;
        }, { once: true });
      }
      return request;
    };
    try {
      await expect(saveSettings({ lastExportAt: NOW + 5000 })).rejects.toBeInstanceOf(Error);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(requestSuccesses).toBe(1);
    expect(inducedAborts).toBe(1);
    expect(await loadSettings()).toEqual(before);
    const retried = await saveSettings({ lastExportAt: NOW + 5000 });
    expect(retried.lastExportAt).toBe(NOW + 5000);
    expect(await loadSettings()).toEqual(retried);
  });

  it('propagates synchronous settings storage failure without mutation and permits a later retry', async () => {
    const before = await seedPlanSettings();
    const originalPut = IDBObjectStore.prototype.put;
    let injectedFailures = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'settings' && (value as { key?: string })?.key === 'app') {
        injectedFailures += 1;
        throw new DOMException('Independent settings quota failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
      await expect(saveSettings({ theme: 'dark' })).rejects.toBeInstanceOf(Error);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(injectedFailures).toBe(1);
    expect(await loadSettings()).toEqual(before);
    const retried = await saveSettings({ theme: 'dark' });
    expect(retried.theme).toBe('dark');
    expect(retried.lastExportAt).toBe(before.lastExportAt);
    expect(await loadSettings()).toEqual(retried);
  });
});
