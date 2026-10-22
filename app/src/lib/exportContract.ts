/* v0.1.2：原生导出结果的统一契约校验。
   ── 为什么单独成文件 ────────────────────────────────────────
   普通路径（nativeFileBridge → backupFile）与恢复路径（exportRestore）
   必须用**同一套**成功判据，否则会出现「恢复通道严格、普通通道宽松」的分叉。
   Codex 最终窄审确认：普通出口此前只比较 bytes<=0，
   NaN / Infinity / 1.5 / sha256='junk' / 缺 sha 都能返回 ok=true。

   ── 契约（原生侧 exportJson 的承诺）──────────────────────────
   · bytes：有限**正整数**（Java 侧是真实写入并被回读确认的字节数）
   · sha256：64 位小写十六进制（原生 close 后回读内容计算）

   注意：这里只做**格式契约校验**。它不等于 JS 已独立验证文件内容 ——
   真正的完整性验证发生在原生：写入后重新打开目标 URI 回读，
   比对长度与 SHA-256（见 BackupIo.exportToVerified）。
   ────────────────────────────────────────────────────────── */

/** 有限正整数（拒绝 0 / 负数 / 小数 / NaN / Infinity / 字符串） */
export function isFinitePositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
}

/** 64 位小写十六进制摘要 */
export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** 校验通过的原生成功结果 */
export interface VerifiedNativeExport {
  bytes: number;
  sha256: string;
  filename?: string;
  uri?: string;
}

/**
 * 校验原生成功结果的契约字段。
 *
 * @returns 通过时返回规范化结果；不通过时返回可读错误
 */
export function verifyNativeExportResult(input: {
  bytes?: unknown;
  sha256?: unknown;
  filename?: unknown;
  uri?: unknown;
}): { ok: true; value: VerifiedNativeExport } | { ok: false; error: string } {
  const { bytes, sha256 } = input;
  if (!isFinitePositiveInt(bytes)) {
    return {
      ok: false,
      error:
        typeof bytes === 'number' && bytes <= 0
          ? '写入结果为 0 字节，备份未成功'
          : '写入字节数无效，备份未成功',
    };
  }
  if (!isSha256Hex(sha256)) {
    return { ok: false, error: '缺少有效的内容校验摘要，无法确认备份完整' };
  }
  return {
    ok: true,
    value: {
      bytes,
      sha256,
      filename: typeof input.filename === 'string' ? input.filename : undefined,
      uri: typeof input.uri === 'string' ? input.uri : undefined,
    },
  };
}
