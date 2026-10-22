/* 备份文件的读写。导出用 Blob + <a download>；导入用 file input。
   不依赖任何后端。 */

import type { BackupPayload } from '../db/repo';

export function downloadBackup(payload: BackupPayload): string {
  const stamp = new Date(payload.exportedAt);
  const name = `motion-backup-${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, '0')}${String(
    stamp.getDate(),
  ).padStart(2, '0')}-${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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

export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  if (text.length > 40 * 1024 * 1024) throw new Error('文件超过 40 MB，可能不是备份文件');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，无法解析');
  }
}

export function fileSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
