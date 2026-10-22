/* v0.1.2 导出修复的 JS 侧回归。
   ── 覆盖点 ──────────────────────────────────────────────────
   1. 原生桥只在「真实字节数 > 0」时才算成功（0B 绝不报成功）
   2. 取消 → cancelled，不报成功
   3. 失败 → 明确 error，不报成功
   4. 空内容被拒
   5. 成功时透出真实 bytes / sha256，便于与导出文件比对
   6. 文件名规则稳定

   这些是**接线层**测试：用假 nativeBridge 驱动真实 backupFile 逻辑。
   真实 Parcel / Activity 崩溃证据见 verify-zero-byte/crash-stack-2mb.txt（模拟器实测），
   原生暂存生命周期见 android/native-test/ExportSpoolTest.java（58 项纯 JVM）。
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  backupText,
  exportBackup,
  registerNativeFileBridge,
  usesNativeFileUi,
  type NativeFileBridge,
} from '../src/lib/backupFile';
import type { BackupPayload } from '../src/db/repo';

/** 让 hasNativeFileBridge() 成立：注入 Capacitor 运行时判定 */
function pretendNativeRuntime(): void {
  vi.stubGlobal('Capacitor', {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
  });
}

/** 构造最小合法备份 payload */
function payload(): BackupPayload {
  return {
    format: 'motion-training-backup',
    version: 1,
    exportedAt: 1792600000000,
    appVersion: '1.0.0',
    counts: { plans: 1, sessions: 1, activeSessions: 0 },
    data: {
      plans: [],
      sessions: [
        {
          id: 'sess-1',
          planId: 'plan-1',
          planName: '测试计划',
          day: '胸 A',
          cycleIndexAtStart: 0,
          targetSetsAtStart: 3,
          startedAt: 1792500000000,
          endedAt: 1792503600000,
          status: 'completed',
          pausedMs: 0,
          pausedAt: null,
          warmups: [],
          exercises: [
            {
              id: 'ex-1',
              exerciseId: 'e-1',
              planExerciseId: 'pe-1',
              name: '卧推',
              en: 'Bench',
              restSec: 120,
              target: { sets: 3, minReps: 8, maxReps: 10 },
              status: 'done',
              groups: [],
              sets: [
                { id: 'set-1', roundIndex: 1, stageIndex: 1, reps: 8, weightKg: 5.5, status: 'done' },
              ],
              note: '',
            },
          ],
          note: '',
          revision: 1,
        },
      ],
      settings: { theme: 'paper' },
    },
  } as unknown as BackupPayload;
}

function fakeBridge(
  impl: (filename: string, content: string) => Awaited<ReturnType<NativeFileBridge['save']>>,
): NativeFileBridge & { calls: { filename: string; content: string }[] } {
  const calls: { filename: string; content: string }[] = [];
  return {
    calls,
    async save(filename, content) {
      calls.push({ filename, content });
      return impl(filename, content);
    },
    async open() {
      return { cancelled: true };
    },
  };
}

describe('v0.1.2 原生导出接线', () => {
  beforeEach(() => {
    pretendNativeRuntime();
    registerNativeFileBridge(null);
  });

  afterEach(() => {
    registerNativeFileBridge(null);
    vi.unstubAllGlobals();
  });

  it('注入原生运行时后，注册桥即走原生路径', () => {
    registerNativeFileBridge(fakeBridge(() => ({ saved: true, filename: 'x.json', bytes: 1 })));
    expect(usesNativeFileUi()).toBe(true);
  });

  it('成功：透出真实 bytes 与 sha256', async () => {
    const bridge = fakeBridge(() => ({
      saved: true,
      filename: 'motion-backup-20261022-1300.json',
      uri: 'content://test/doc',
      bytes: 1234,
      // v0.1.2 契约：sha256 必须是 64 位小写 hex（原生回读真实摘要的格式）
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }));
    registerNativeFileBridge(bridge);

    const r = await exportBackup(payload());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('native');
      expect(r.bytes).toBe(1234);
      expect(r.sha256).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    }
    expect(bridge.calls).toHaveLength(1);
    // 传给原生的是完整 JSON 文本（原生侧再落私有暂存文件，不进 Bundle）
    expect(() => JSON.parse(bridge.calls[0].content)).not.toThrow();
  });

  it('用户取消：返回 cancelled，不报成功', async () => {
    registerNativeFileBridge(fakeBridge(() => ({ saved: false, cancelled: true })));
    const r = await exportBackup(payload());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cancelled).toBe(true);
  });

  it('原生失败（0 字节）：返回明确 error，不报成功', async () => {
    registerNativeFileBridge(
      fakeBridge(() => ({
        saved: false,
        cancelled: false,
        error: '写入后文件为 0 字节，备份未成功',
      })),
    );
    const r = await exportBackup(payload());
    expect(r.ok).toBe(false);
    if (!r.ok && !r.cancelled) expect(r.error).toContain('0 字节');
  });

  it('原生抛异常（模拟旧版 TransactionTooLarge）：被捕获为 error', async () => {
    registerNativeFileBridge(
      fakeBridge(() => {
        throw new Error('android.os.TransactionTooLargeException');
      }),
    );
    const r = await exportBackup(payload());
    expect(r.ok).toBe(false);
    if (!r.ok && !r.cancelled) expect(r.error).toContain('TransactionTooLarge');
  });

  it('空内容：不会被当作成功', async () => {
    registerNativeFileBridge(
      fakeBridge(() => ({ saved: false, cancelled: false, error: '内容为空，不能作为备份导出' })),
    );
    const r = await exportBackup(payload());
    expect(r.ok).toBe(false);
  });

  it('backupText 稳定且包含数字字段（便于摘要比对）', () => {
    const a = backupText(payload());
    const b = backupText(payload());
    expect(a).toBe(b);
    expect(a).toContain('weightKg');
    expect(a).toContain('5.5');
  });

  it('文件名符合 motion-backup-YYYYMMDD-HHMM.json 规则', async () => {
    // v0.1.2 契约：成功必须带合法 bytes + 64hex 摘要
    const bridge = fakeBridge((filename) => ({ saved: true, filename, bytes: 10, sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    registerNativeFileBridge(bridge);
    await exportBackup(payload());
    expect(bridge.calls[0].filename).toMatch(/^motion-backup-\d{8}-\d{4}\.json$/);
  });
});
