/* Capacitor 原生文件桥的接线实现（只在 Android 容器里生效）。
   ── 设计要点 ────────────────────────────────────────────────
   1. 插件是**本仓库内的本地插件**（android/app/src/main/java/.../NativeFileBridgePlugin.java），
      不引入任何后台服务器、不新增网络请求。
   2. 动态 import：浏览器构建里 @capacitor/core 存在但没有原生实现，
      我们用 Capacitor.isNativePlatform() 先判定，再 registerPlugin。
   3. 导出/导入的**结果必须真实**：取消 → cancelled:true；失败 → error。
      调用方（Settings）据此决定是否更新 lastExportAt 与是否提示成功。
   4. v0.1.2：原生侧只在 PluginCall 里保留**短 token**，正文写 App 私有暂存文件。
      因此这里**照旧传 content**（JS 不感知暂存细节），但原生不再把它留在
      Activity saved-state 里 —— 这修掉了大备份导出时
      TransactionTooLargeException 导致 App 自己退出、留下 0B 文件的问题。 */

import { registerPlugin } from '@capacitor/core';
import type { NativeFileBridge } from './backupFile';
import { registerNativeFileBridge } from './backupFile';
import { hasNativeFileBridge } from './platform';
import { verifyNativeExportResult } from './exportContract';

interface NativeFileBridgePluginShape {
  exportJson(options: { filename: string; content: string }): Promise<{
    saved: boolean;
    cancelled: boolean;
    filename?: string;
    uri?: string;
    bytes?: number;
    /** 原生写入后回读校验得到的 SHA-256（v0.1.2 起返回） */
    sha256?: string;
  }>;
  importJson(options?: { suggestedName?: string }): Promise<{
    cancelled: boolean;
    content?: string;
    filename?: string;
    uri?: string;
    bytes?: number;
  }>;
}

let registered = false;

/**
 * 启动时调用一次：在 Android 原生容器里把本地插件接到 backupFile 的抽象上。
 * 浏览器 / Web 版调用它不会有任何副作用。
 */
export function installNativeFileBridge(): void {
  if (registered) return;
  if (!hasNativeFileBridge()) return;

  let plugin: NativeFileBridgePluginShape;
  try {
    plugin = registerPlugin<NativeFileBridgePluginShape>('NativeFileBridge');
  } catch {
    return; // 插件不可用：保持网页实现，不假装成功
  }

  const bridge: NativeFileBridge = {
    async save(filename, content) {
      const r = await plugin.exportJson({ filename, content });
      if (r.cancelled) return { saved: false, cancelled: true };
      if (!r.saved) return { saved: false, cancelled: false, error: '系统没有确认写入完成' };
      // v0.1.2：与恢复通道**同一套**契约校验（有限正整数 + 64hex 摘要）。
      // 原生已回读校验过内容；这里再挡掉坏/不匹配插件结果（NaN/1.5/junk sha 等）。
      const verdict = verifyNativeExportResult({
        bytes: r.bytes,
        sha256: r.sha256,
        filename: r.filename,
        uri: r.uri,
      });
      if (!verdict.ok) {
        return { saved: false, cancelled: false, error: verdict.error };
      }
      return {
        saved: true,
        filename: verdict.value.filename ?? filename,
        uri: verdict.value.uri,
        bytes: verdict.value.bytes,
        sha256: verdict.value.sha256,
      };
    },
    async open() {
      const r = await plugin.importJson();
      if (r.cancelled) return { cancelled: true };
      if (typeof r.content !== 'string') {
        return { cancelled: false, error: '系统没有返回文件内容' };
      }
      return {
        cancelled: false,
        content: r.content,
        filename: r.filename ?? 'backup.json',
        bytes: r.bytes ?? r.content.length,
      };
    },
  };

  registerNativeFileBridge(bridge);
  registered = true;
}
