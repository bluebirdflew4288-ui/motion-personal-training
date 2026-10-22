/* v0.1.2 导出恢复通道（appRestoredResult）测试。
   ── 真实形状依据（本地 Cap 8.5.3 依赖实测）─────────────────
   @capacitor/app definitions.d.ts：RestoredListenerEvent =
     { pluginId, methodName, success, data?, error? }
   MessageHandler.sendResponseMessage：
     resolve → { success: true,  data }
     reject  → { success: false, error }

   覆盖本轮 A1/A2/A3 与 B 的 JS 侧：
     A1 外层 success:false / error 必须交给 onFailed（旧实现只读 data 会静默吞掉）
     A2 onSaved 的 Promise 必须 await 并捕获拒绝，且区分「文件已写成功」
     A3 每次 install 的清理只移除自己（不误删另一份监听）
     B  bytes 必须有限正整数；sha256 必须 64 hex

   证据边界：这些是 JS 接线探针（React/App 事件/DB 为替身），
   不等于真实 Activity 重建或真机 SAF；真实原生崩溃见 crash-stack-2mb.txt。 */

import { describe, expect, it, vi } from 'vitest';
import {
  parseRestoredExport,
  parseRestoredExportEvent,
  isFinitePositiveInt,
  isSha256Hex,
} from '../src/lib/exportRestore';

const SHA = 'a'.repeat(64);

describe('A1 外层 event 形状（真实 Cap 8.5.3）', () => {
  it('原生 reject：外层 success:false + error → onFailed 拿到可读信息', () => {
    const r = parseRestoredExportEvent({
      pluginId: 'NativeFileBridge',
      methodName: 'exportJson',
      success: false,
      error: { message: 'PROVIDER_WRITE_FAILED' },
      data: null,
    });
    expect(r).not.toBeNull();
    expect(r!.saved).toBe(false);
    expect(r!.error).toContain('PROVIDER_WRITE_FAILED');
  });

  it('原生 reject：error 是字符串也要给出失败', () => {
    const r = parseRestoredExportEvent({
      pluginId: 'NativeFileBridge',
      methodName: 'exportJson',
      success: false,
      error: 'boom',
    });
    expect(r!.saved).toBe(false);
    expect(r!.error).toBeTruthy();
  });

  it('success:true 且 data 有效 → 成功', () => {
    const r = parseRestoredExportEvent({
      pluginId: 'NativeFileBridge',
      methodName: 'exportJson',
      success: true,
      data: { saved: true, cancelled: false, bytes: 48709, sha256: SHA, filename: 'a.json' },
    });
    expect(r!.saved).toBe(true);
    expect(r!.bytes).toBe(48709);
  });

  it('success:true 但 data 缺失 → 明确失败，不静默 return', () => {
    const r = parseRestoredExportEvent({
      pluginId: 'NativeFileBridge',
      methodName: 'exportJson',
      success: true,
      data: null,
    });
    expect(r).not.toBeNull();
    expect(r!.saved).toBe(false);
    expect(r!.error).toBeTruthy();
  });

  it('其它插件/方法 → 忽略（返回 null）', () => {
    expect(
      parseRestoredExportEvent({ pluginId: 'Camera', methodName: 'getPhoto', success: true, data: {} }),
    ).toBeNull();
    expect(
      parseRestoredExportEvent({
        pluginId: 'NativeFileBridge',
        methodName: 'importJson',
        success: true,
        data: {},
      }),
    ).toBeNull();
  });
});

describe('A1 业务 data 解析', () => {
  it('取消 → cancelled', () => {
    const r = parseRestoredExport({ saved: false, cancelled: true });
    expect(r!.cancelled).toBe(true);
  });

  it('兼容 { data: {...} } 再包一层', () => {
    const r = parseRestoredExport({ data: { saved: true, bytes: 100, sha256: SHA } });
    expect(r!.saved).toBe(true);
  });
});

describe('B 防御性格式校验', () => {
  it('bytes 必须是有限正整数', () => {
    expect(isFinitePositiveInt(1)).toBe(true);
    expect(isFinitePositiveInt(48709)).toBe(true);
    for (const bad of [0, -1, 1.5, NaN, Infinity, '10', null, undefined]) {
      expect(isFinitePositiveInt(bad)).toBe(false);
    }
  });

  it('0 / NaN / Infinity / 小数 都不能当成功', () => {
    for (const bytes of [0, NaN, Infinity, 1.5, -5]) {
      const r = parseRestoredExport({ saved: true, bytes, sha256: SHA });
      expect(r!.saved).toBe(false);
    }
  });

  it('sha256 必须是 64 位小写 hex', () => {
    expect(isSha256Hex(SHA)).toBe(true);
    for (const bad of ['junk', '', SHA.toUpperCase(), SHA.slice(0, 63), SHA + 'a', null]) {
      expect(isSha256Hex(bad)).toBe(false);
    }
  });

  it('缺 sha256 或格式错 → 不成功', () => {
    expect(parseRestoredExport({ saved: true, bytes: 10 })!.saved).toBe(false);
    expect(parseRestoredExport({ saved: true, bytes: 10, sha256: 'junk' })!.saved).toBe(false);
  });
});

describe('A2 onSaved 的 Promise 必须被串联', () => {
  it('onSaved 返回拒绝 → 不产生 unhandled，走 onSavedButNotRecorded', async () => {
    const onSavedButNotRecorded = vi.fn();
    const onFailed = vi.fn();

    // 用假的 App.addListener 捕获注册的 listener
    let captured: ((e: unknown) => void) | null = null;
    vi.doMock('@capacitor/app', () => ({
      App: {
        addListener: async (_name: string, cb: (e: unknown) => void) => {
          captured = cb;
          return { remove: async () => {} };
        },
      },
    }));
    vi.resetModules();
    const mod = await import('../src/lib/exportRestore');
    const dispose = await mod.installRestoredExportHandler({
      onSaved: () => Promise.reject(new Error('PERSISTENCE_FAILED')),
      onCancelled: () => {},
      onFailed,
      onSavedButNotRecorded,
    });

    captured!({
      pluginId: 'NativeFileBridge',
      methodName: 'exportJson',
      success: true,
      data: { saved: true, bytes: 100, sha256: SHA },
    });

    // 等微任务队列排空
    await new Promise((r) => setTimeout(r, 10));
    expect(onSavedButNotRecorded).toHaveBeenCalledTimes(1);
    expect(onFailed).not.toHaveBeenCalled();
    await dispose();
    vi.doUnmock('@capacitor/app');
  });
});

describe('A3 监听所有权：每次 install 只清自己', () => {
  it('installA/installB 交错，cleanupA 只移除 A', async () => {
    const removed: number[] = [];
    let id = 0;
    vi.doMock('@capacitor/app', () => ({
      App: {
        addListener: async () => {
          const myId = ++id;
          return {
            remove: async () => {
              removed.push(myId);
            },
          };
        },
      },
    }));
    vi.resetModules();
    const mod = await import('../src/lib/exportRestore');

    const h = {
      onSaved: () => {},
      onCancelled: () => {},
      onFailed: () => {},
    };
    const disposeA = await mod.installRestoredExportHandler(h);
    const disposeB = await mod.installRestoredExportHandler(h);

    await disposeA();
    expect(removed).toEqual([1]); // 只移除 A
    await disposeB();
    expect(removed).toEqual([1, 2]);
    // 幂等：再清一次不重复移除
    await disposeA();
    expect(removed).toEqual([1, 2]);
    vi.doUnmock('@capacitor/app');
  });
});
