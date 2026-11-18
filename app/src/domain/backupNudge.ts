/* 本地数据备份温和提醒判定（Wave 2D）。
   ── 规则边界 ────────────────────────────────────────────────────
   · 零 Schema 改动：复用 AppSettings 已预留的 `lastExportAt` 与 `lastBackupPromptAt`；
   · 仅统计已完成且非「完全休息」的真实训练记录（`status === 'completed' && endedAt && kind !== 'rest'`）；
   · 触发条件：
     1. 累计已完成非休息训练数 `>= 5`；
     2. 距上次点击「稍后」（`lastBackupPromptAt`）已满 7 天（或从未点击）；
     3. 满足以下其一：
        - 从未导出备份（`lastExportAt === null`）；
        - 距上次成功导出（`lastExportAt`）已满 14 天，且在 `lastExportAt` 之后新增了 `>= 3` 次已完成训练。 */

import type { Session } from './types';
import { sessionKindOf } from './sessionKind';

export const BACKUP_MIN_TOTAL_SESSIONS = 5;
export const BACKUP_STALE_MS = 14 * 86_400_000;
export const BACKUP_MIN_NEW_SINCE_EXPORT = 3;
export const BACKUP_SNOOZE_MS = 7 * 86_400_000;

export interface BackupNudgeState {
  shouldShow: boolean;
  reason: 'never-exported' | 'stale-export' | null;
  totalCompleted: number;
  unbackedCount: number;
}

export function evaluateBackupNudge(
  sessions: readonly Session[],
  settings: { lastExportAt: number | null; lastBackupPromptAt: number | null },
  now = Date.now(),
): BackupNudgeState {
  const completed = sessions.filter(
    (s) => s.status === 'completed' && Boolean(s.endedAt) && sessionKindOf(s) !== 'rest',
  );
  const totalCompleted = completed.length;

  if (totalCompleted < BACKUP_MIN_TOTAL_SESSIONS) {
    return { shouldShow: false, reason: null, totalCompleted, unbackedCount: 0 };
  }

  if (
    typeof settings.lastBackupPromptAt === 'number' &&
    Number.isFinite(settings.lastBackupPromptAt) &&
    now - settings.lastBackupPromptAt < BACKUP_SNOOZE_MS
  ) {
    return { shouldShow: false, reason: null, totalCompleted, unbackedCount: 0 };
  }

  if (settings.lastExportAt === null || !Number.isFinite(settings.lastExportAt)) {
    return {
      shouldShow: true,
      reason: 'never-exported',
      totalCompleted,
      unbackedCount: totalCompleted,
    };
  }

  const lastExportAt = settings.lastExportAt;
  const newSinceExport = completed.filter((s) => (s.endedAt ?? s.startedAt) > lastExportAt).length;
  if (now - lastExportAt >= BACKUP_STALE_MS && newSinceExport >= BACKUP_MIN_NEW_SINCE_EXPORT) {
    return {
      shouldShow: true,
      reason: 'stale-export',
      totalCompleted,
      unbackedCount: newSinceExport,
    };
  }

  return { shouldShow: false, reason: null, totalCompleted, unbackedCount: newSinceExport };
}
