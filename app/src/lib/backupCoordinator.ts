/**
 * 备份导出协调器（Settings 备份导出的有界职责提取）。
 *
 * <p>职责划分：
 *   · Settings 页面组件：保留 UI 状态（exporting）、同步 CAS 门禁（exportingRef）与 Toast 展现；
 *   · 本协调模块：负责备份数据构建/不可变快照复用、同 reader（validateBackup）校验与准确措辞、
 *     长计划名称（新名 200 / 旧名 2000）上下文提示判定，以及「文件写入真实结果」与
 *     「本地最近备份时间更新（patchSettings）」的两阶段解耦协调。
 *
 * <p>不变量约束：
 *   · 普通导出与恢复前快照共用同一条受约束路径；
 *   · 恢复前快照不可变，不重新调用 buildBackup，不篡改快照时间与内容；
 *   · 真实文件写入成功后，本地最近备份时间记录失败绝不反转真实文件成功结果；
 *   · 失败/取消不更新本地最近备份时间，不误报成功。
 */

import { buildBackup, validateBackup, type BackupPayload, type AppSettings, CURRENT_APP_VERSION } from '../db/repo';
import { MAX_PLAN_NAME, MAX_LEGACY_PLAN_NAME } from '../domain/limits';
import { exportBackup, type ExportOutcome } from './backupFile';

export interface LegacyNameStats {
  legacyPlanCount: number;
  legacySessionCount: number;
  hasLegacyNames: boolean;
}

/** 检查备份数据中是否存在超过 MAX_PLAN_NAME 的长名称（受支持旧备份） */
export function inspectLegacyNames(payload: BackupPayload): LegacyNameStats {
  const legacyPlanCount = payload.data.plans.filter((p) => p.name.length > MAX_PLAN_NAME).length;
  const legacySessionCount = payload.data.sessions.filter((s) => s.planName.length > MAX_PLAN_NAME).length;
  return {
    legacyPlanCount,
    legacySessionCount,
    hasLegacyNames: legacyPlanCount + legacySessionCount > 0,
  };
}

/** 格式化同 reader 校验失败时的准确来源措辞 */
export function formatValidationErrorMessage(errorDetail: string, isSnapshotExport: boolean): string {
  return isSnapshotExport
    ? `这份恢复前快照无法生成可恢复的备份：${errorDetail}。快照内容保持不变；超出支持上限的旧名称不能靠修改当前计划修复。`
    : `当前数据无法生成可恢复的备份：${errorDetail}。请先修正（例如把超过 ${MAX_LEGACY_PLAN_NAME} 字符的旧计划名称改短）后再导出。`;
}

/** 格式化包含合法长旧名称时的提示措辞 */
export function formatLegacyNamesWarning(isSnapshotExport: boolean): string {
  return isSnapshotExport
    ? `这份快照含超过 ${MAX_PLAN_NAME} 字的旧计划名称，已按原文完整保留；这是快照自身的内容，修改当前计划不会改变它。`
    : `含超过 ${MAX_PLAN_NAME} 字的旧计划名称，已按原文完整保留；如需继续编辑该计划请在计划页显式改名，历史记录中的旧名称无需修改。`;
}

/** 格式化文件已保存但本地最近备份时间记录失败时的明确错误提示 */
export function formatRecordFailureMessage(result: { filename?: string; bytes?: number }, error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return `文件已写入${result.filename ? ' ' + result.filename : ''}${
    typeof result.bytes === 'number' ? `（${result.bytes} 字节）` : ''
  }，但本地「最近备份」时间没记上：${msg}`;
}

export interface CoordinateBackupExportParams {
  /** 可选快照输入；存在时为「恢复前快照」导出，不可变 */
  payloadInput?: BackupPayload;
  opts?: { label?: string };
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  pushToast: (msg: string, type?: 'error') => void;
  /** 可选依赖注入，便于行为单测隔离 */
  buildBackupFn?: (version: string) => Promise<BackupPayload>;
  validateBackupFn?: (raw: unknown) => ReturnType<typeof validateBackup>;
  exportBackupFn?: (payload: BackupPayload) => Promise<ExportOutcome>;
}

/**
 * 协调执行一次备份导出流程
 */
export async function coordinateBackupExport(params: CoordinateBackupExportParams): Promise<ExportOutcome> {
  const {
    payloadInput,
    opts,
    patchSettings,
    pushToast,
    buildBackupFn = buildBackup,
    validateBackupFn = validateBackup,
    exportBackupFn = exportBackup,
  } = params;

  const isSnapshotExport = !!payloadInput;
  const payload = payloadInput ?? (await buildBackupFn(CURRENT_APP_VERSION));
  const { hasLegacyNames } = inspectLegacyNames(payload);

  // item 1：导出前用与恢复完全相同的校验确认「这份文件将来可恢复」
  const verify = validateBackupFn(payload);
  if (!verify.ok) {
    const first = verify.issues?.[0];
    const detail = first ? `${first.path} — ${first.message}` : verify.error;
    pushToast(formatValidationErrorMessage(detail, isSnapshotExport), 'error');
    return { ok: false, cancelled: false, error: verify.error };
  }

  const result = await exportBackupFn(payload);

  if (result.ok) {
    // 文件已经真实写出（原生 close 后回读过长度与摘要）。
    // 接下来只是更新「最近备份时间」这个本地记录 —— 两者必须分开处理：
    //   · 记录成功 → 正常成功提示
    //   · 记录失败 → 明确「文件已写入，但时间没记上」，
    //     不得把已成功的文件回报成「导出失败」，也不能产生 unhandled rejection。
    // 返回值始终是真实的文件保存结果（ok:true），不因本地记录失败而反转。
    try {
      await patchSettings({ lastExportAt: payload.exportedAt });
      pushToast(
        opts?.label ? `${opts.label}已导出 ${result.filename}` : `已导出 ${result.filename}`,
      );
      if (hasLegacyNames) {
        pushToast(formatLegacyNamesWarning(isSnapshotExport));
      }
    } catch (recordErr) {
      pushToast(formatRecordFailureMessage(result, recordErr), 'error');
    }
    return result;
  }

  if (result.cancelled) {
    // 用户取消：什么都不改，也不提示“已导出”
    pushToast('已取消导出，没有写入任何文件。');
    return result;
  }

  pushToast(`导出失败：${result.error}`, 'error');
  return result;
}
