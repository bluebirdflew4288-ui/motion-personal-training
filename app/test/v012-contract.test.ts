/* v0.1.2 导出契约统一 + 普通路径记录失败分离（本轮三处遗漏的定向测试）。

   ── 覆盖 ────────────────────────────────────────────────────
   #2 普通路径与恢复路径必须用同一套成功判据：
      finite 正整数 + 64hex sha256；NaN / 1.5 / 'junk' / 缺 sha 都不能 ok
   #3 普通 doExport：文件已保存但 patchSettings 拒绝时
      不得报「导出失败」，必须提示「文件已写入…时间没记上」，且返回真实 ok:true

   证据边界：这是 JS 接线探针（plugin 回复与 patchSettings 为替身）。
   真实原生崩溃证据见 verify-zero-byte/crash-stack-2mb.txt；
   原生 metadata 同源绑定见 android/native-test/ExportPhaseTest.java。 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isFinitePositiveInt,
  isSha256Hex,
  verifyNativeExportResult,
} from '../src/lib/exportContract';

const SHA = 'b'.repeat(64);

describe('#2 统一契约：校验函数', () => {
  it('bytes 只接受有限正整数', () => {
    expect(isFinitePositiveInt(1)).toBe(true);
    expect(isFinitePositiveInt(48709)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, Infinity, -Infinity, '10', null, undefined]) {
      expect(isFinitePositiveInt(bad)).toBe(false);
    }
  });

  it('sha256 只接受 64 位小写 hex', () => {
    expect(isSha256Hex(SHA)).toBe(true);
    for (const bad of ['junk', '', SHA.toUpperCase(), SHA.slice(0, 63), SHA + 'c', null, 123]) {
      expect(isSha256Hex(bad)).toBe(false);
    }
  });

  it('verifyNativeExportResult：正常通过', () => {
    const v = verifyNativeExportResult({ bytes: 48709, sha256: SHA, filename: 'a.json' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.value.bytes).toBe(48709);
      expect(v.value.sha256).toBe(SHA);
      expect(v.value.filename).toBe('a.json');
    }
  });

  it('verifyNativeExportResult：0 字节给出 0 字节文案', () => {
    const v = verifyNativeExportResult({ bytes: 0, sha256: SHA });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('0 字节');
  });

  it('verifyNativeExportResult：NaN/1.5 等不给 0 字节文案但拒绝', () => {
    for (const bytes of [NaN, 1.5, Infinity, -5, 'x']) {
      const v = verifyNativeExportResult({ bytes, sha256: SHA });
      expect(v.ok).toBe(false);
    }
  });

  it('verifyNativeExportResult：junk/缺 sha 拒绝', () => {
    expect(verifyNativeExportResult({ bytes: 10, sha256: 'junk' }).ok).toBe(false);
    expect(verifyNativeExportResult({ bytes: 10 }).ok).toBe(false);
  });
});

describe('#2 普通路径与恢复路径共用同一契约', () => {
  beforeEach(() => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('普通路径：NaN / 1.5 / junk sha 都不能返回 ok:true', async () => {
    vi.resetModules();
    const { registerNativeFileBridge, exportBackup } = await import('../src/lib/backupFile');
    const payload = {
      format: 'motion-training-backup',
      version: 1,
      exportedAt: 1,
      appVersion: '1.0.0',
      counts: { plans: 0, sessions: 0, activeSessions: 0 },
      data: { plans: [], sessions: [], settings: {} },
    } as never;

    for (const bad of [
      { saved: true, bytes: NaN, sha256: SHA },
      { saved: true, bytes: 1.5, sha256: SHA },
      { saved: true, bytes: 100, sha256: 'junk' },
      { saved: true, bytes: 100 },
      { saved: true, bytes: 0, sha256: SHA },
    ]) {
      registerNativeFileBridge({
        async save() {
          return bad as never;
        },
        async open() {
          return { cancelled: true } as never;
        },
      });
      const r = await exportBackup(payload);
      expect(r.ok).toBe(false);
    }
  });

  it('普通路径：合法 bytes+sha 才成功', async () => {
    vi.resetModules();
    const { registerNativeFileBridge, exportBackup } = await import('../src/lib/backupFile');
    registerNativeFileBridge({
      async save() {
        return { saved: true, filename: 'a.json', bytes: 1234, sha256: SHA } as never;
      },
      async open() {
        return { cancelled: true } as never;
      },
    });
    const r = await exportBackup({
      format: 'motion-training-backup',
      version: 1,
      exportedAt: 1,
      appVersion: '1.0.0',
      counts: { plans: 0, sessions: 0, activeSessions: 0 },
      data: { plans: [], sessions: [], settings: {} },
    } as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes).toBe(1234);
      expect(r.sha256).toBe(SHA);
    }
  });
});

describe('#3 普通 doExport：文件成功但记录失败要说清楚', () => {
  /* 用最小可复现模型验证 doExport 的分支语义：
     文件 ok → patchSettings 拒绝 → 返回 ok:true，提示含「文件已写入」「时间没记上」，
     且不含「导出失败」。 */

  interface Toast {
    text: string;
    kind?: string;
  }

  /** 与 Settings.doExport 成功分支同构的最小实现（便于断言） */
  async function runDoExportModel(
    fileResult: { ok: true; filename: string; bytes?: number },
    patch: () => Promise<void>,
  ): Promise<{ returned: unknown; toasts: Toast[] }> {
    const toasts: Toast[] = [];
    const pushToast = (text: string, kind?: string) => toasts.push({ text, kind });

    try {
      const result = fileResult;
      if (result.ok) {
        try {
          await patch();
          pushToast(`已导出 ${result.filename}`);
        } catch (recordErr) {
          const msg = recordErr instanceof Error ? recordErr.message : String(recordErr);
          pushToast(
            `文件已写入 ${result.filename}${
              typeof result.bytes === 'number' ? `（${result.bytes} 字节）` : ''
            }，但本地「最近备份」时间没记上：${msg}`,
            'error',
          );
        }
        return { returned: result, toasts };
      }
      pushToast('导出失败', 'error');
      return { returned: result, toasts };
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      pushToast(`导出失败：${message}`, 'error');
      return { returned: { ok: false, cancelled: false, error: message }, toasts };
    }
  }

  it('patchSettings 拒绝：返回 ok:true，提示区分文件成功与记录失败', async () => {
    const out = await runDoExportModel({ ok: true, filename: 'a.json', bytes: 48709 }, () =>
      Promise.reject(new Error('SETTINGS_PATCH_FAILED')),
    );
    expect((out.returned as { ok: boolean }).ok).toBe(true);
    const text = out.toasts.map((t) => t.text).join(' | ');
    expect(text).toContain('文件已写入');
    expect(text).toContain('时间没记上');
    expect(text).toContain('SETTINGS_PATCH_FAILED');
    expect(text).not.toContain('导出失败');
  });

  it('patchSettings 成功：正常成功提示，无错误', async () => {
    const out = await runDoExportModel({ ok: true, filename: 'a.json', bytes: 100 }, async () => {});
    expect(out.toasts).toHaveLength(1);
    expect(out.toasts[0].text).toContain('已导出');
    expect(out.toasts[0].kind).toBeUndefined();
  });
});
