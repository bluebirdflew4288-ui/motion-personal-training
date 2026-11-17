/* 冻结副本（测试夹具，不是运行时代码）。
   来源：Project Root HEAD 219f971e6e1a39540f6d14f90b879586347cba88
   · app/src/db/backupCompat.ts 的 isSupportedBackupVersion（只允许 1|2）
   · app/src/db/repo.ts 的 BACKUP_VERSION = 2 与 validateBackup 版本门
   用途：为 ACCEPTANCE P07「当前 0.1.8 解析 v3 明确拒绝」提供可执行证据。
   不要更新本文件来"适配"新版本；新代码的兼容性由当前实现测试覆盖。 */

export const LEGACY_0_1_8_BACKUP_VERSION = 2;

export function legacyIsSupportedBackupVersion(v: unknown): v is 1 | 2 {
  return v === 1 || v === 2;
}

/** 与 0.1.8 validateBackup 的版本判定分支逐行一致。 */
export function legacyValidateBackupVersionGate(version: number): { ok: boolean; error?: string } {
  if (!legacyIsSupportedBackupVersion(version)) {
    if (version > LEGACY_0_1_8_BACKUP_VERSION) {
      return {
        ok: false,
        error: `备份版本 ${version} 高于当前应用支持的 ${LEGACY_0_1_8_BACKUP_VERSION}，请先升级应用`,
      };
    }
    return { ok: false, error: `不支持的备份版本 ${version}` };
  }
  return { ok: true };
}
