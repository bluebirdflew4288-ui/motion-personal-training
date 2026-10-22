import { readFileSync, writeFileSync } from 'node:fs';
const log = [];

// 1) ExportSpool: 加 stagedLengthInt / sha256Of
{
  const p = 'ExportSpool.java';
  let s = readFileSync(p, 'utf8');
  const anchor = `    /** 读取暂存文件真实字节（写入后回读校验用）。 */`;
  const insert = `    /** 暂存文件当前字节数（int 版；供短元数据绑定） */
    public int stagedLengthInt(String token) throws IOException {
        long n = stagedLength(token);
        if (n > Integer.MAX_VALUE) throw new IOException("暂存文件过大");
        return (int) n;
    }

    /** 暂存文件内容的 SHA-256（供短元数据绑定，写入后完整性核对） */
    public String sha256Of(String token) throws IOException {
        return sha256Hex(readBytes(token));
    }

`;
  if (!s.includes(anchor)) { log.push('SKIP spool helpers'); }
  else { s = s.replace(anchor, insert + anchor); writeFileSync(p, s, 'utf8'); log.push('OK   spool helpers'); }
}

// 2) 插件回调：核对绑定摘要
{
  const p = 'NativeFileBridgePlugin.java';
  let s = readFileSync(p, 'utf8');
  const from = `                            byte[] bytes;
                            try {
                                // 按 token 从磁盘读回正文（Activity 重建后依然有效）
                                bytes = spool().readBytes(token);
                            } catch (Exception e) {
                                releaseOperation();
                                spool().discard(token);
                                call.reject("读取暂存内容失败：" + BackupIo.describe(e), "SPOOL_READ_FAILED", e);
                                return;
                            }`;
  const to = `                            byte[] bytes;
                            try {
                                // 按 token 从磁盘读回正文（Activity 重建后依然有效）
                                bytes = spool().readBytes(token);
                                // B 完整性核对：与 stage 时绑定的字节数/摘要比对。
                                // 私有暂存若被截短或变值，这里就拒绝，不会写出「看似 verified」的坏备份。
                                int expectBytes = call.getInt(OPT_STAGED_BYTES, -1);
                                String expectSha = call.getString(OPT_STAGED_SHA);
                                if (expectBytes <= 0 || expectSha == null) {
                                    releaseOperation();
                                    spool().discard(token);
                                    call.reject("导出元数据缺失，无法确认内容完整", "STAGE_META_MISSING");
                                    return;
                                }
                                if (bytes.length != expectBytes
                                        || !expectSha.equals(ExportSpool.sha256Hex(bytes))) {
                                    releaseOperation();
                                    spool().discard(token);
                                    call.reject(
                                            "暂存内容与导出时不一致，已中止写入", "SPOOL_CORRUPTED");
                                    return;
                                }
                            } catch (Exception e) {
                                releaseOperation();
                                spool().discard(token);
                                call.reject("读取暂存内容失败：" + BackupIo.describe(e), "SPOOL_READ_FAILED", e);
                                return;
                            }`;
  if (!s.includes(from)) { log.push('SKIP callback digest verify'); }
  else { s = s.replace(from, to); writeFileSync(p, s, 'utf8'); log.push('OK   callback digest verify'); }
}

console.log(log.join('\n'));
