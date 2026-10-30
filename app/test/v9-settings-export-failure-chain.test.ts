import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import React, { act, useEffect } from 'react';
import ReactDOMClient from 'react-dom/client';
import { StoreProvider, useStore } from '../src/store';
import { idbClear } from '../src/db/idb';
import { buildBackup, CURRENT_APP_VERSION, loadSettings, saveSettings } from '../src/db/repo';
import { coordinateBackupExport } from '../src/lib/backupCoordinator';
import { parseRestoredExportEvent, type RestoredExportResult } from '../src/lib/exportRestore';
import type { ExportOutcome } from '../src/lib/backupFile';

const NOW = 1_793_124_000_000;
const SHA = 'b'.repeat(64);

function makeElement(tag = 'DIV'): any {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: [],
    ownerDocument: null,
    parentNode: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    style: {},
    appendChild(child: any) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    removeChild(child: any) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) this.childNodes.splice(i, 1);
      return child;
    },
    insertBefore(child: any) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
  };
}

let doc: any;
let rootEl: any;
let root: any;

function initDom() {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).HTMLIFrameElement = class {};
  (globalThis as any).Element = class {};
  (globalThis as any).Node = class {};
  (globalThis as any).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  doc = {
    nodeType: 9,
    createElement: (tag: string) => {
      const el = makeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    createElementNS: (_ns: string, tag: string) => {
      const el = makeElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, ownerDocument: doc, parentNode: null }),
    createComment: () => ({ nodeType: 8, ownerDocument: doc, parentNode: null }),
    documentElement: makeElement('HTML'),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
    defaultView: globalThis,
  };
  doc.documentElement.ownerDocument = doc;
  rootEl = makeElement('DIV');
  rootEl.ownerDocument = doc;

  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', doc);
  root = ReactDOMClient.createRoot(rootEl);
}

let currentStore: ReturnType<typeof useStore> | null = null;

function Probe({ onStore }: { onStore: (store: ReturnType<typeof useStore>) => void }) {
  const store = useStore();
  useEffect(() => {
    onStore(store);
  }, [store, onStore]);
  return null;
}

async function mountRealStoreProvider(): Promise<ReturnType<typeof useStore>> {
  await act(async () => {
    root.render(
      React.createElement(
        StoreProvider,
        null,
        React.createElement(Probe, {
          onStore: (s) => {
            currentStore = s;
          },
        }),
      ),
    );
  });
  // Wait until store is ready
  for (let i = 0; i < 30; i++) {
    if (currentStore?.ready) break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  expect(currentStore?.ready).toBe(true);
  return currentStore!;
}

beforeEach(async () => {
  for (const store of ['plans', 'sessions', 'settings', 'meta']) await idbClear(store);
  initDom();
  currentStore = null;
});

afterEach(() => {
  if (root) {
    try {
      act(() => {
        root.unmount();
      });
    } catch {}
  }
  vi.unstubAllGlobals();
});

describe('Real StoreProvider export failure chain & atomicity behavior', () => {
  it('direct patchSettings rejects on persistence failure, keeps memory/DB unchanged, and retries cleanly', async () => {
    await saveSettings({ lastExportAt: NOW, theme: 'light' });
    const store = await mountRealStoreProvider();
    expect(currentStore!.settings.lastExportAt).toBe(NOW);

    // Inject failure into settings put
    const origPut = IDBObjectStore.prototype.put;
    let injected = true;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (injected && this.name === 'settings' && (value as any)?.key === 'app') {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      }
      return key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
    };

    try {
      // Must reject directly to caller; no optimistic memory update, no generic toast
      await expect(store.patchSettings({ lastExportAt: NOW + 10000 })).rejects.toBeInstanceOf(Error);
      expect(currentStore!.settings.lastExportAt).toBe(NOW);
      expect((await loadSettings()).lastExportAt).toBe(NOW);
      expect(currentStore!.toasts).toHaveLength(0); // no duplicate generic toast pushed by patchSettings

      // Remove failure injection; retry succeeds
      injected = false;
      await act(async () => {
        await currentStore!.patchSettings({ lastExportAt: NOW + 10000 });
      });

      expect(currentStore!.settings.lastExportAt).toBe(NOW + 10000);
      expect((await loadSettings()).lastExportAt).toBe(NOW + 10000);
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
  });

  it('ordinary export: file written ok but settings put fails leaves file success ok, timestamp unchanged, and contextual error', async () => {
    await saveSettings({ lastExportAt: NOW });
    await mountRealStoreProvider();

    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'settings' && (value as any)?.key === 'app') {
        throw new DOMException('Transaction abort on settings put', 'AbortError');
      }
      return key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
    };

    try {
      const exportBackupFn = vi.fn().mockResolvedValue({
        ok: true,
        filename: 'motion-backup-test.json',
        via: 'native',
        bytes: 2048,
        sha256: SHA,
      } satisfies ExportOutcome);

      const outcome = await act(async () => {
        return await coordinateBackupExport({
          patchSettings: currentStore!.patchSettings,
          pushToast: currentStore!.pushToast,
          exportBackupFn,
        });
      });

      // File outcome is truthful: file was saved
      expect(outcome.ok).toBe(true);
      expect((outcome as any).filename).toBe('motion-backup-test.json');
      expect((outcome as any).bytes).toBe(2048);

      // Memory and DB timestamps must not falsely advance
      expect(currentStore!.settings.lastExportAt).toBe(NOW);
      expect((await loadSettings()).lastExportAt).toBe(NOW);

      // Unique error message shown, no generic success
      expect(currentStore!.toasts.length).toBeGreaterThanOrEqual(1);
      const errorToast = currentStore!.toasts.find((t) => t.kind === 'error');
      expect(errorToast).toBeDefined();
      expect(errorToast!.text).toContain('文件已写入 motion-backup-test.json（2048 字节），但本地「最近备份」时间没记上');
      expect(currentStore!.toasts.some((t) => t.text.includes('已导出 motion-backup-test.json') && t.kind !== 'error')).toBe(false);
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
  });

  it('snapshot export: file written ok but settings put aborts preserves snapshot, file ok, and contextual error', async () => {
    await saveSettings({ lastExportAt: NOW });
    await mountRealStoreProvider();

    const origPut = IDBObjectStore.prototype.put;
    let aborted = false;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const req = key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
      if (this.name === 'settings' && (value as any)?.key === 'app') {
        const tx = this.transaction;
        req.addEventListener(
          'success',
          () => {
            aborted = true;
            tx.abort();
          },
          { once: true },
        );
      }
      return req;
    };

    try {
      const basePayload = await buildBackup(CURRENT_APP_VERSION);
      const snapshotPayload = {
        ...basePayload,
        exportedAt: NOW + 3000,
      };

      const exportBackupFn = vi.fn().mockResolvedValue({
        ok: true,
        filename: 'motion-snapshot-pre.json',
        via: 'native',
        bytes: 1024,
      } satisfies ExportOutcome);

      const outcome = await act(async () => {
        return await coordinateBackupExport({
          payloadInput: snapshotPayload,
          opts: { label: '恢复前快照' },
          patchSettings: currentStore!.patchSettings,
          pushToast: currentStore!.pushToast,
          exportBackupFn,
        });
      });

      expect(aborted).toBe(true);
      expect(outcome.ok).toBe(true);
      expect(currentStore!.settings.lastExportAt).toBe(NOW);
      expect((await loadSettings()).lastExportAt).toBe(NOW);

      const errToast = currentStore!.toasts.find((t) => t.kind === 'error');
      expect(errToast).toBeDefined();
      expect(errToast!.text).toContain('文件已写入 motion-snapshot-pre.json（1024 字节），但本地「最近备份」时间没记上');
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
  });

  it('restored native export event: onSaved rejects into onSavedButNotRecorded when settings put fails', async () => {
    await saveSettings({ lastExportAt: NOW });
    await mountRealStoreProvider();

    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'settings' && (value as any)?.key === 'app') {
        throw new DOMException('Simulated put failure', 'DataError');
      }
      return key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
    };

    try {
      const toasts: { msg: string; type?: string }[] = [];
      const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });

      // Simulate the exact onSaved and onSavedButNotRecorded handlers installed in Settings.tsx
      const handlers = {
        async onSaved(result: RestoredExportResult) {
          await currentStore!.patchSettings({ lastExportAt: Date.now() });
          pushToast(result.filename ? `已导出 ${result.filename}（${result.bytes} 字节，已校验）` : '已导出');
        },
        onSavedButNotRecorded(result: RestoredExportResult, error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          pushToast(
            `文件已写入${result.filename ? ' ' + result.filename : ''}（${result.bytes} 字节），但本地「最近备份」时间没记上：${msg}`,
            'error',
          );
        },
      };

      const parsed = parseRestoredExportEvent({
        pluginId: 'NativeFileBridge',
        methodName: 'exportJson',
        success: true,
        data: { saved: true, cancelled: false, bytes: 4096, sha256: SHA, filename: 'motion-restored.json' },
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.saved).toBe(true);

      // Invoke real onSaved with real patchSettings
      let onSavedRejected = false;
      try {
        await handlers.onSaved(parsed as RestoredExportResult);
      } catch (err) {
        onSavedRejected = true;
        handlers.onSavedButNotRecorded(parsed as RestoredExportResult, err);
      }

      expect(onSavedRejected).toBe(true); // patchSettings must reject into caller
      expect(currentStore!.settings.lastExportAt).toBe(NOW);
      expect((await loadSettings()).lastExportAt).toBe(NOW);

      expect(toasts).toHaveLength(1);
      expect(toasts[0].type).toBe('error');
      expect(toasts[0].msg).toContain('文件已写入 motion-restored.json（4096 字节），但本地「最近备份」时间没记上');
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
  });

  it('concurrent independent fields: theme update survives even if lastExportAt put fails', async () => {
    await saveSettings({ lastExportAt: NOW, theme: 'light' });
    await mountRealStoreProvider();

    // Hook settings put to only fail if lastExportAt is being updated
    const origPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'settings' && (value as any)?.lastExportAt !== NOW) {
        throw new DOMException('Metadata update failure', 'QuotaExceededError');
      }
      return key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
    };

    try {
      // Concurrently update theme and patch lastExportAt
      const [themeRes, exportRes] = await act(async () => {
        return await Promise.allSettled([
          currentStore!.setTheme('dark'),
          currentStore!.patchSettings({ lastExportAt: NOW + 9999 }),
        ]);
      });

      expect(themeRes.status).toBe('fulfilled');
      expect(exportRes.status).toBe('rejected');

      // Theme succeeded and is preserved in memory and DB
      expect(currentStore!.settings.theme).toBe('dark');
      expect((await loadSettings()).theme).toBe('dark');
      // lastExportAt remained NOW
      expect(currentStore!.settings.lastExportAt).toBe(NOW);
      expect((await loadSettings()).lastExportAt).toBe(NOW);
    } finally {
      IDBObjectStore.prototype.put = origPut;
    }
  });
});
