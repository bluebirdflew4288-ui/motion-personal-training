import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  coordinateBackupExport,
  inspectLegacyNames,
  formatValidationErrorMessage,
  formatLegacyNamesWarning,
  formatRecordFailureMessage,
} from '../src/lib/backupCoordinator';
import type { BackupPayload } from '../src/db/repo';
import type { ExportOutcome } from '../src/lib/backupFile';

const NOW = 1_793_124_000_000;

function makeMockPayload(overrides?: Partial<BackupPayload>): BackupPayload {
  return {
    format: 'motion-training-backup',
    version: 1,
    appVersion: '0.1.7',
    exportedAt: NOW,
    counts: { plans: 1, sessions: 0, activeSessions: 0 },
    data: {
      plans: [
        {
          id: 'p1',
          name: 'Regular Plan',
          days: [],
          createdAt: NOW,
          updatedAt: NOW,
          cursor: 0,
        },
      ],
      sessions: [],
      settings: [],
    },
    ...overrides,
  };
}

describe('Backup coordinator bounded extraction behavior', () => {
  it('inspects legacy names correctly based on MAX_PLAN_NAME (200 chars)', () => {
    const normalPayload = makeMockPayload();
    expect(inspectLegacyNames(normalPayload)).toEqual({
      legacyPlanCount: 0,
      legacySessionCount: 0,
      hasLegacyNames: false,
    });

    const longName = 'A'.repeat(201);
    const legacyPayload = makeMockPayload({
      data: {
        plans: [
          {
            id: 'p1',
            name: longName,
            days: [],
            createdAt: NOW,
            updatedAt: NOW,
            cursor: 0,
          },
        ],
        sessions: [
          {
            id: 's1',
            planId: 'p1',
            planName: longName,
            day: { dayId: 'd1', dayName: 'Day 1', partText: '胸' },
            cycleIndexAtStart: 0,
            startedAt: NOW,
            endedAt: NOW + 1000,
            status: 'completed',
            pausedMs: 0,
            pausedAt: null,
            warmups: [],
            exercises: [],
            note: '',
          },
        ],
        settings: [],
      },
    });

    expect(inspectLegacyNames(legacyPayload)).toEqual({
      legacyPlanCount: 1,
      legacySessionCount: 1,
      hasLegacyNames: true,
    });
  });

  it('formats validation error messages with accurate contextual source wording', () => {
    const err = 'plans[0].name — 名称超过支持上限';
    const ordinaryMsg = formatValidationErrorMessage(err, false);
    expect(ordinaryMsg).toContain('当前数据无法生成可恢复的备份');
    expect(ordinaryMsg).toContain('请先修正（例如把超过 2000 字符的旧计划名称改短）后再导出');

    const snapshotMsg = formatValidationErrorMessage(err, true);
    expect(snapshotMsg).toContain('这份恢复前快照无法生成可恢复的备份');
    expect(snapshotMsg).toContain('快照内容保持不变；超出支持上限的旧名称不能靠修改当前计划修复');
  });

  it('formats legacy names warnings with accurate contextual wording', () => {
    const ordinaryWarning = formatLegacyNamesWarning(false);
    expect(ordinaryWarning).toContain('含超过 200 字的旧计划名称，已按原文完整保留');
    expect(ordinaryWarning).toContain('如需继续编辑该计划请在计划页显式改名，历史记录中的旧名称无需修改');

    const snapshotWarning = formatLegacyNamesWarning(true);
    expect(snapshotWarning).toContain('这份快照含超过 200 字的旧计划名称，已按原文完整保留');
    expect(snapshotWarning).toContain('这是快照自身的内容，修改当前计划不会改变它');
  });

  it('coordinates successful ordinary export, patches metadata, and notifies user', async () => {
    const payload = makeMockPayload();
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn().mockResolvedValue(undefined);
    const buildBackupFn = vi.fn().mockResolvedValue(payload);
    const validateBackupFn = vi.fn().mockReturnValue({ ok: true, value: payload });
    const exportBackupFn = vi.fn().mockResolvedValue({
      ok: true,
      filename: 'motion-backup-test.json',
      via: 'browser',
    } satisfies ExportOutcome);

    const outcome = await coordinateBackupExport({
      patchSettings,
      pushToast,
      buildBackupFn,
      validateBackupFn,
      exportBackupFn,
    });

    expect(outcome).toEqual({ ok: true, filename: 'motion-backup-test.json', via: 'browser' });
    expect(buildBackupFn).toHaveBeenCalledOnce();
    expect(validateBackupFn).toHaveBeenCalledWith(payload);
    expect(exportBackupFn).toHaveBeenCalledWith(payload);
    expect(patchSettings).toHaveBeenCalledWith({ lastExportAt: NOW });
    expect(toasts).toEqual([{ msg: '已导出 motion-backup-test.json', type: undefined }]);
  });

  it('coordinates immutable snapshot export: reuses provided payload and preserves snapshot semantics', async () => {
    const longName = 'L'.repeat(250);
    const snapshotPayload = makeMockPayload({
      exportedAt: NOW + 9999,
      data: {
        plans: [
          {
            id: 'snap-1',
            name: longName,
            days: [],
            createdAt: NOW,
            updatedAt: NOW,
            cursor: 0,
          },
        ],
        sessions: [],
        settings: [],
      },
    });
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn().mockResolvedValue(undefined);
    const buildBackupFn = vi.fn();
    const validateBackupFn = vi.fn().mockReturnValue({ ok: true, value: snapshotPayload });
    const exportBackupFn = vi.fn().mockResolvedValue({
      ok: true,
      filename: 'motion-snapshot.json',
      via: 'native',
      bytes: 1234,
    } satisfies ExportOutcome);

    const outcome = await coordinateBackupExport({
      payloadInput: snapshotPayload,
      opts: { label: '恢复前快照' },
      patchSettings,
      pushToast,
      buildBackupFn,
      validateBackupFn,
      exportBackupFn,
    });

    expect(outcome.ok).toBe(true);
    expect(buildBackupFn).not.toHaveBeenCalled(); // snapshot payload must not be rebuilt
    expect(exportBackupFn).toHaveBeenCalledWith(snapshotPayload);
    expect(patchSettings).toHaveBeenCalledWith({ lastExportAt: NOW + 9999 });
    expect(toasts).toHaveLength(2);
    expect(toasts[0].msg).toBe('恢复前快照已导出 motion-snapshot.json');
    expect(toasts[1].msg).toContain('这是快照自身的内容，修改当前计划不会改变它');
  });

  it('rejects export when validateBackup fails and emits contextual error without file writing', async () => {
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn();
    const exportBackupFn = vi.fn();
    const validateBackupFn = vi.fn().mockReturnValue({
      ok: false,
      error: '名称超过 2000 字符限制',
      issues: [{ path: 'plans[0].name', message: '名称过长' }],
    });

    const outcome = await coordinateBackupExport({
      patchSettings,
      pushToast,
      validateBackupFn,
      exportBackupFn,
    });

    expect(outcome).toEqual({ ok: false, cancelled: false, error: '名称超过 2000 字符限制' });
    expect(exportBackupFn).not.toHaveBeenCalled();
    expect(patchSettings).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].msg).toContain('当前数据无法生成可恢复的备份');
  });

  it('handles cancellation truthfully: does not update lastExportAt and toasts cancel notice', async () => {
    const payload = makeMockPayload();
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn();
    const validateBackupFn = vi.fn().mockReturnValue({ ok: true, value: payload });
    const exportBackupFn = vi.fn().mockResolvedValue({
      ok: false,
      cancelled: true,
    } satisfies ExportOutcome);

    const outcome = await coordinateBackupExport({
      patchSettings,
      pushToast,
      validateBackupFn,
      exportBackupFn,
    });

    expect(outcome).toEqual({ ok: false, cancelled: true });
    expect(patchSettings).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ msg: '已取消导出，没有写入任何文件。', type: undefined }]);
  });

  it('handles file write error truthfully: does not update metadata and reports failure', async () => {
    const payload = makeMockPayload();
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn();
    const validateBackupFn = vi.fn().mockReturnValue({ ok: true, value: payload });
    const exportBackupFn = vi.fn().mockResolvedValue({
      ok: false,
      cancelled: false,
      error: 'Disk I/O failure',
    } satisfies ExportOutcome);

    const outcome = await coordinateBackupExport({
      patchSettings,
      pushToast,
      validateBackupFn,
      exportBackupFn,
    });

    expect(outcome).toEqual({ ok: false, cancelled: false, error: 'Disk I/O failure' });
    expect(patchSettings).not.toHaveBeenCalled();
    expect(toasts).toEqual([{ msg: '导出失败：Disk I/O failure', type: 'error' }]);
  });

  it('coordination: file written ok but patchSettings rejected retains file success and gives clear metadata error', async () => {
    const payload = makeMockPayload();
    const toasts: { msg: string; type?: string }[] = [];
    const pushToast = (msg: string, type?: 'error') => toasts.push({ msg, type });
    const patchSettings = vi.fn().mockRejectedValue(new Error('IDB transaction aborted'));
    const validateBackupFn = vi.fn().mockReturnValue({ ok: true, value: payload });
    const exportBackupFn = vi.fn().mockResolvedValue({
      ok: true,
      filename: 'backup.json',
      via: 'native',
      bytes: 5678,
    } satisfies ExportOutcome);

    const outcome = await coordinateBackupExport({
      patchSettings,
      pushToast,
      validateBackupFn,
      exportBackupFn,
    });

    // File was really written: ok is true, filename and bytes preserved
    expect(outcome).toEqual({
      ok: true,
      filename: 'backup.json',
      via: 'native',
      bytes: 5678,
    });
    // Contextual record failure message emitted
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe('error');
    expect(toasts[0].msg).toBe(formatRecordFailureMessage({ filename: 'backup.json', bytes: 5678 }, new Error('IDB transaction aborted')));
    expect(toasts[0].msg).toContain('文件已写入 backup.json（5678 字节），但本地「最近备份」时间没记上：IDB transaction aborted');
  });
});
