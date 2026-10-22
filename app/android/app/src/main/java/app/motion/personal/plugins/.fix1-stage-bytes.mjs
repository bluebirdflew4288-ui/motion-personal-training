import { readFileSync, writeFileSync } from 'node:fs';
const log = [];

// ── ExportSpool: 新增 stageBytes(byte[])，stage(String) 委托 ──
{
  const p = 'ExportSpool.java';
  let s = readFileSync(p, 'utf8');
  const from = `    public String stage(String content) throws IOException {
        if (content == null) throw new IOException("内容为空，无法导出");
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0) throw new IOException("内容为空，无法导出");`;
  const to = `    public String stage(String content) throws IOException {
        if (content == null) throw new IOException("内容为空，无法导出");
        return stageBytes(content.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 用调用方提供的**同一份字节**落盘，返回短 token。
     *
     * <p>为什么需要它：导出时要同时
     * <ol>
     *   <li>把正文写入私有暂存文件</li>
     *   <li>把「最初正文」的长度与 SHA-256 作为 expected 绑定到短元数据</li>
     * </ol>
     * 这两件事必须用<b>同一个 byte[]</b>。若先 stage 再回读磁盘算 expected，
     * 那么「stage 完成、metadata 生成前」这段窗口里文件被等长改写或非空截短，
     * expected 会跟着错误内容一起变化，完整性承诺就失效了。
     *
     * @param bytes 原始正文的 UTF-8 字节（调用方持有，不会被本类修改）
     */
    public String stageBytes(byte[] bytes) throws IOException {
        if (bytes == null) throw new IOException("内容为空，无法导出");
        if (bytes.length == 0) throw new IOException("内容为空，无法导出");`;
  if (!s.includes(from)) { log.push('SKIP spool stageBytes'); }
  else { s = s.replace(from, to); writeFileSync(p, s, 'utf8'); log.push('OK   spool stageBytes'); }
}

// ── 插件：一次算字节，同一份用于 stage 与 expected ──
{
  const p = 'NativeFileBridgePlugin.java';
  let s = readFileSync(p, 'utf8');
  const from = `        // ① 正文写私有暂存文件，拿到短 token
        final String token;
        try {
            token = spool().stage(content);
        } catch (Exception e) {
            releaseOperation();
            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);
            return;
        }

        // ② 关键：从 options 里真正移除正文，只留 token + 文件名
        // B 完整性防护：把 stage 时的原始字节数与 SHA256 绑到短元数据。
        // 回调读 spool 后先核对，避免「私有暂存被意外截短/变值」也被报 verified。
        // 这些都是小字符串/数字，不会让 Bundle 变大。
        final int stagedBytes;
        final String stagedSha;
        try {
            stagedBytes = spool().stagedLengthInt(token);
            stagedSha = spool().sha256Of(token);
        } catch (Exception e) {
            spool().discard(token);
            releaseOperation();
            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_HASH_FAILED", e);
            return;
        }`;
  const to = `        // ① 先把正文转成 UTF-8 字节 —— 这是「最初正文」的唯一权威副本。
        //    expected 长度/摘要必须由**这份字节**生成，绝不能回读 spool 再算：
        //    否则在「stage 完成、metadata 生成前」的窗口里，
        //    文件被等长改写或非空截短时 expected 会跟着错误内容一起变化，
        //    完整性承诺就失效了（Codex T4/T5 已确认该缺口）。
        final byte[] originalBytes;
        try {
            originalBytes = content.getBytes("UTF-8");
        } catch (Exception e) {
            releaseOperation();
            call.reject("内容编码失败：" + BackupIo.describe(e), "ENCODE_FAILED", e);
            return;
        }
        if (originalBytes.length == 0) {
            releaseOperation();
            call.reject("内容为空，不能作为备份导出", "EMPTY_CONTENT");
            return;
        }

        // ② 用**同一份字节**落盘，拿到短 token
        final String token;
        try {
            token = spool().stageBytes(originalBytes);
        } catch (Exception e) {
            releaseOperation();
            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);
            return;
        }

        // ③ 关键：从 options 里真正移除正文，只留 token + 文件名
        // B 完整性防护：expected 直接来自上面那份 originalBytes（最初正文），
        // 与写入磁盘的内容同源，因此不随暂存文件被改动而变化。
        // 这些都是小字符串/数字，不会让 Bundle 变大。
        final int stagedBytes = originalBytes.length;
        final String stagedSha = BackupIo.sha256Hex(originalBytes);`;
  if (!s.includes(from)) { log.push('SKIP plugin original-bytes binding'); }
  else { s = s.replace(from, to); writeFileSync(p, s, 'utf8'); log.push('OK   plugin original-bytes binding'); }
}

console.log(log.join('\n'));
