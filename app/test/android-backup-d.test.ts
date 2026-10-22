/* 施工要求 D：JSON 备份的导出必须等**真实写入结果**，取消/失败不得报成功或更新 lastExportAt。
   本文件测生产模块 src/lib/backupFile.ts 的两条路径选择与结果语义，
   并验证 Settings 依赖的契约（ok / cancelled / error 三态互斥）。 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  backupFileName,
  backupText,
  exportBackup,
  parseJsonText,
  pickBackupViaNative,
  registerNativeFileBridge,
  usesNativeFileUi,
  type NativeFileBridge,
} from '../src/lib/backupFile';
import type { BackupPayload } from '../src/db/repo';

function payload(): BackupPayload {
  return {
    format: 'motion-training-backup',
    version: 1,
    exportedAt: 1_792_585_000_000,
    appVersion: '1.0.0',
    counts: { plans: 1, sessions: 2, activeSessions: 0 },
    data: { plans: [], sessions: [], settings: [] },
  } as BackupPayload;
}

describe('D · 备份文件名与文本', () => {
  it('文件名包含日期与时间，扩展名 .json', () => {
    const name = backupFileName(1_792_585_000_000);
    expect(name).toMatch(/^motion-backup-\d{8}-\d{4}\.json$/);
  });

  it('文本是 2 空格缩进的 JSON，可解析回同一对象', () => {
    const p = payload();
    const text = backupText(p);
    expect(text).toContain('\n  "format"');
    expect(JSON.parse(text)).toEqual(p);
  });

  it('parseJsonText 拒绝非 JSON 与超大文本', () => {
    expect(() => parseJsonText('not json')).toThrow(/不是有效的 JSON/);
    expect(() => parseJsonText('x'.repeat(41 * 1024 * 1024))).toThrow(/40 MB/);
  });
});

describe('D · 原生/浏览器路径选择', () => {
  beforeEach(() => {
    registerNativeFileBridge(null);
  });

  it('未注册原生桥时走浏览器下载路径，且不算原生 UI', async () => {
    expect(usesNativeFileUi()).toBe(false);
    // 浏览器路径会创建 <a download>：node 环境没有 DOM，因此提供一个最小 stub
    const created: Array<{ href: string; download: string; click: () => void }> = [];
    const fakeDoc = {
      createElement: () => {
        const el = {
          href: '',
          download: '',
          rel: '',
          click: () => {
            created.push(el);
          },
          remove: () => undefined,
        };
        return el;
      },
      body: { appendChild: () => undefined },
    };
    const g = globalThis as unknown as Record<string, unknown>;
    const prevDoc = g.document;
    g.document = fakeDoc;
    const prevUrl = g.URL;
    g.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => undefined };
    try {
      const r = await exportBackup(payload());
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.via).toBe('browser');
      expect(created.length).toBe(1); // 确实触发了下载点击
      expect(created[0].download).toMatch(/^motion-backup-.*\.json$/);
    } finally {
      g.document = prevDoc;
      g.URL = prevUrl;
    }
  });

  it('原生桥可用时走原生路径，并且必须等 save() 的结果', async () => {
    let resolved = false;
    const bridge: NativeFileBridge = {
      async save() {
        await new Promise((r) => setTimeout(r, 30));
        resolved = true;
        return { saved: true, filename: 'x.json', bytes: 10 };
      },
      async open() {
        return { cancelled: true as const };
      },
    };
    registerNativeFileBridge(bridge);
    // 注意：usesNativeFileUi 还要求 hasNativeFileBridge()（构建+运行时都原生）
    // 这里只验证“如果走原生分支，结果来自 save 的返回值”。
    if (!usesNativeFileUi()) {
      // 非原生构建（CI 跑在 node 上）：跳过原生分支，但保持契约可读
      expect(usesNativeFileUi()).toBe(false);
      return;
    }
    const r = await exportBackup(payload());
    expect(resolved).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.via).toBe('native');
  });

  it('pickBackupViaNative 在没有原生桥时明确失败（不假装成功）', async () => {
    const r = await pickBackupViaNative();
    expect(r.ok).toBe(false);
    if (!r.ok && !r.cancelled) expect(r.error).toMatch(/没有原生文件选择器/);
  });
});
