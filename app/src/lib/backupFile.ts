/* 备份文件的读写。
   ── 两条路径，行为明确分开 ──────────────────────────────────
   浏览器（Web 版 / 局域网预览）：导出用 Blob + <a download>；导入用 file input。
   Android 原生容器：导出走系统「创建文档」界面（SAF ACTION_CREATE_DOCUMENT），
   导入走系统文档选择器（ACTION_OPEN_DOCUMENT）。**必须等真实写入结果**，
   用户取消或写入失败都不得提示“已导出”。

   原生能力通过 registerNativeFileBridge() 注入，避免本模块反向依赖 React，
   也避免在浏览器里误调不存在的插件。 */

import type { BackupPayload } from '../db/repo';
import { hasNativeFileBridge } from './platform';
import { verifyNativeExportResult } from './exportContract';

/** 原生文件桥的最小接口（由 lib/nativeFileBridge.ts 实现并注册） */
export interface NativeFileBridge {
  /** 打开系统保存界面；只有真写入成功才 ok:true，用户取消返回 cancelled:true */
  save(
    filename: string,
    content: string,
  ): Promise<
    | { saved: true; filename: string; uri?: string; bytes?: number; sha256?: string }
    | { saved: false; cancelled: true }
    | { saved: false; cancelled: false; error: string }
  >;
  /** 打开系统文档选择器；用户取消返回 cancelled:true */
  open(): Promise<
    | { cancelled: false; content: string; filename: string; bytes: number }
    | { cancelled: true }
    | { cancelled: false; error: string }
  >;
}

let nativeBridge: NativeFileBridge | null = null;

/** 由原生接线层在启动时注册（浏览器构建下不会注册） */
export function registerNativeFileBridge(bridge: NativeFileBridge | null): void {
  nativeBridge = bridge;
}

/** 当前导出/导入是否会走原生系统文件入口 */
export function usesNativeFileUi(): boolean {
  return hasNativeFileBridge() && nativeBridge !== null;
}

/** 生成备份文件名（Web 与原生共用同一命名规则） */
export function backupFileName(exportedAt: number): string {
  const stamp = new Date(exportedAt);
  return `motion-backup-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(
    stamp.getDate(),
  ).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.json`;
}

/** 备份 JSON 文本（原生导出写入的内容，与网页导出完全一致） */
export function backupText(payload: BackupPayload): string {
  return JSON.stringify(payload, null, 2);
}

export type ExportOutcome =
  | {
      ok: true;
      filename: string;
      via: 'native' | 'browser';
      /** 真实写入字节数（原生回读校验后的值；浏览器路径不提供） */
      bytes?: number;
      /** 原生写入后回读内容的 SHA-256（v0.1.2 起） */
      sha256?: string;
    }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * 导出备份。
 *
 * 原生：**等待用户在系统界面里选完位置并真实写入**，成功才返回 ok。
 * 浏览器：沿用原来的 Blob 下载（立即返回成功，因为浏览器不提供写入确认）。
 */
export async function exportBackup(payload: BackupPayload): Promise<ExportOutcome> {
  const name = backupFileName(payload.exportedAt);
  if (usesNativeFileUi() && nativeBridge) {
    try {
      const r = await nativeBridge.save(name, backupText(payload));
      if (r.saved) {
        // v0.1.2：与恢复通道**同一套**契约校验（有限正整数 + 64hex 摘要）。
        // 绝不把 0 字节、NaN、非整数或缺失摘要当成备份成功。
        const verdict = verifyNativeExportResult({
          bytes: r.bytes,
          sha256: r.sha256,
          filename: r.filename,
        });
        if (!verdict.ok) {
          return { ok: false, cancelled: false, error: verdict.error };
        }
        return {
          ok: true,
          filename: verdict.value.filename || name,
          via: 'native',
          bytes: verdict.value.bytes,
          sha256: verdict.value.sha256,
        };
      }
      if (r.cancelled) return { ok: false, cancelled: true };
      return { ok: false, cancelled: false, error: r.error };
    } catch (err) {
      return { ok: false, cancelled: false, error: err instanceof Error ? err.message : '写入文件失败' };
    }
  }
  downloadBackupInBrowser(payload);
  return { ok: true, filename: name, via: 'browser' };
}

/** 浏览器下载（原实现，行为不变） */
export function downloadBackupInBrowser(payload: BackupPayload): string {
  const name = backupFileName(payload.exportedAt);
  const blob = new Blob([backupText(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}

export type ImportPickOutcome =
  | { ok: true; text: string; name: string; size: number; via: 'native' | 'browser' }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * 取用户选中的备份文件内容。
 *
 * 原生：系统文档选择器 → 文本。用户取消不改动任何数据。
 * 浏览器：由调用方用 <input type=file> 拿到 File 后调 readJsonFile。
 */
export async function pickBackupViaNative(): Promise<ImportPickOutcome> {
  if (!usesNativeFileUi() || !nativeBridge) {
    return { ok: false, cancelled: false, error: '当前环境没有原生文件选择器' };
  }
  try {
    const r = await nativeBridge.open();
    if (r.cancelled) return { ok: false, cancelled: true };
    if ('error' in r) return { ok: false, cancelled: false, error: r.error };
    return { ok: true, text: r.content, name: r.filename, size: r.bytes, via: 'native' };
  } catch (err) {
    return { ok: false, cancelled: false, error: err instanceof Error ? err.message : '读取文件失败' };
  }
}

/** 解析备份文本（Web 与原生共用同一校验前置） */
export function parseJsonText(text: string): unknown {
  if (text.length > 40 * 1024 * 1024) throw new Error('文件超过 40 MB，可能不是备份文件');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，无法解析');
  }
}

export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  return parseJsonText(text);
}

export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
