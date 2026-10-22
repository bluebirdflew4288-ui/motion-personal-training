package app.motion.personal.plugins;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * MOTION 备份文件的原生 I/O 核心。
 *
 * <p><b>本类刻意不 import 任何 Android 类型</b>，因此可以用普通 {@code javac}/{@code java}
 * 在没有任何 Android SDK 的机器上直接编译并跑测试（见
 * {@code app/android/native-test/BackupIoTest.java}）。文件桥插件只负责把系统 SAF 的
 * 流交给这里，并把它返回的结果翻译成 JS 回调。
 *
 * <p>它承担两条被独立审查点名过的硬约束：
 *
 * <ul>
 *   <li><b>A01（导出：成功回调必须晚于全部写出动作）</b><br>
 *       旧实现在 try-with-resources 内部就 {@code resolve(saved=true)}，随后才 close。
 *       某些 SAF provider 在 close 时才真正提交数据，close 抛 I/O 异常时 JS 已经收到
 *       “已保存”，事后再 reject 也无法撤回。现在 {@link #exportTo} 只有
 *       write → flush → close **全部成功**才调用 {@link ExportSink#success}；
 *       任何一步失败都走 {@link ExportSink#failure}，绝无成功回调。</li>
 *   <li><b>A02（导入：边读边限，不在校验前耗尽堆）</b><br>
 *       旧实现先把整个流缓存成 byte[]，最后才比较 48MB 上限——超大文件能在限额检查前
 *       就把堆吃干，而 {@code OutOfMemoryError} 并不是 {@code Exception}，catch 不住。
 *       现在 {@link #readCapped} 每读一块就累计，一旦超过上限立刻抛
 *       {@link TooLargeException} 并停止读取（不会读完整个流）。</li>
 * </ul>
 */
public final class BackupIo {

    /** 单次导入的字节上限（与网页侧 40MB 校验留余量） */
    public static final int DEFAULT_MAX_IMPORT_BYTES = 48 * 1024 * 1024;

    private BackupIo() {}

    /** 文件超过导入上限 */
    public static class TooLargeException extends IOException {
        private final long limitBytes;

        public TooLargeException(long limitBytes) {
            super("文件超过 " + (limitBytes / (1024 * 1024)) + " MB，可能不是备份文件");
            this.limitBytes = limitBytes;
        }

        public long getLimitBytes() {
            return limitBytes;
        }
    }

    /** 导出结果的唯一出口；成功回调只能由 {@link #exportTo} 在 close 成功后调用。 */
    public interface ExportSink {
        /** 数据已完整写出并关闭；此时才可以告诉 JS “保存成功”。 */
        void success(int bytesWritten);

        /** 任何一步失败；不会再有 success 回调。 */
        void failure(String code, String message, Exception cause);
    }

    /**
     * 把 {@code content} 写入 {@code out}，**成功回调严格晚于 close**。
     *
     * <p>顺序固定为 write → flush → close。每一步失败都会关闭剩余资源并只报失败，
     * 保证不会出现「JS 收到成功、文件其实没写完」的状态。
     *
     * @param out     目标流（调用方通过 SAF 打开）
     * @param content 要写入的字节
     * @param sink    结果出口
     */
    public static void exportTo(OutputStream out, byte[] content, ExportSink sink) {
        if (out == null) {
            sink.failure("OPEN_FAILED", "无法打开所选位置进行写入", null);
            return;
        }
        if (content == null) {
            closeQuietly(out);
            sink.failure("MISSING_CONTENT", "内容已丢失，无法写入", null);
            return;
        }

        // ① write
        try {
            out.write(content);
        } catch (Exception e) {
            closeQuietly(out);
            sink.failure("WRITE_FAILED", "写入文件失败：" + describe(e), e);
            return;
        }

        // ② flush
        try {
            out.flush();
        } catch (Exception e) {
            closeQuietly(out);
            sink.failure("FLUSH_FAILED", "刷新文件缓冲失败：" + describe(e), e);
            return;
        }

        // ③ close —— 这是 SAF provider 真正提交数据的时刻，必须在成功之前完成
        try {
            out.close();
        } catch (Exception e) {
            sink.failure("CLOSE_FAILED", "关闭文件失败：" + describe(e), e);
            return;
        }

        // 四步全过：此时才允许报成功
        sink.success(content.length);
    }

    /**
     * 边读边限：累计超过 {@code maxBytes} 立即中止，不读完整个流。
     *
     * @param in       源流（调用方通过 SAF 打开）
     * @param maxBytes 上限字节数
     * @return 读取到的完整内容
     * @throws TooLargeException 超过上限（此时已停止读取）
     */
    public static byte[] readCapped(InputStream in, int maxBytes) throws IOException {
        if (in == null) throw new IOException("无法打开所选文件");
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(chunk)) != -1) {
            total += n;
            // 关键顺序：先判定上限，再写入缓冲。超额时既不继续读，也不再占更多内存。
            if (total > maxBytes) {
                throw new TooLargeException(maxBytes);
            }
            buf.write(chunk, 0, n);
        }
        return buf.toByteArray();
    }

    /** 默认上限版本 */
    public static byte[] readCapped(InputStream in) throws IOException {
        return readCapped(in, DEFAULT_MAX_IMPORT_BYTES);
    }

    // ── 写入后回读校验（修复「把创建 URI 当写入成功」）────────────────────

    /**
     * 导出结果的可验证信息。{@link #exportToVerified} 只有在
     * write -> flush -> close -> <b>回读校验</b> 全部通过后才产出它。
     */
    public static final class VerifiedExport {
        private final int bytes;
        private final String sha256;

        VerifiedExport(int bytes, String sha256) {
            this.bytes = bytes;
            this.sha256 = sha256;
        }

        /** 真实写入并被回读确认的字节数 */
        public int getBytes() {
            return bytes;
        }

        /** 回读内容的 SHA-256（十六进制） */
        public String getSha256() {
            return sha256;
        }
    }

    /** 回读结果出口；与 {@link ExportSink} 一样保证不会既成功又失败。 */
    public interface VerifiedExportSink {
        void success(VerifiedExport result);

        void failure(String code, String message, Exception cause);
    }

    /**
     * 写入 + <b>回读校验</b>，只有字节数与 SHA-256 都对得上才报成功。
     *
     * <p>为什么需要回读：SAF provider 可能接受 write/flush/close 却只落地 0 字节
     * （用户看到的就是「0B 文件」）。旧实现把「拿到 URI 并 openOutputStream 成功」
     * 当成写入成功，因此空文件也会提示已导出。现在：
     *
     * <ol>
     *   <li>write → flush → close（沿用 {@link #exportTo} 的严格顺序）</li>
     *   <li>用 {@code reReader} 重新打开同一 URI 读回全部字节</li>
     *   <li>比较长度与 SHA-256；不一致即判失败，<b>不</b>报成功</li>
     * </ol>
     *
     * @param out      目标流
     * @param content  要写入的字节
     * @param reReader 回读器：返回该 URI 当前真实内容的字节；不可回读时返回 null
     * @param sink     结果出口
     */
    public static void exportToVerified(
            OutputStream out, byte[] content, ReReader reReader, VerifiedExportSink sink) {
        if (content == null || content.length == 0) {
            closeQuietly(out);
            sink.failure("EMPTY_CONTENT", "内容为空，不能作为备份写出", null);
            return;
        }
        // 先按原有严格顺序写
        final Exception[] failure = new Exception[1];
        final String[] failCode = new String[1];
        final String[] failMsg = new String[1];
        exportTo(
                out,
                content,
                new ExportSink() {
                    @Override
                    public void success(int bytesWritten) {
                        // 写入阶段通过，继续回读校验
                    }

                    @Override
                    public void failure(String code, String message, Exception cause) {
                        failCode[0] = code;
                        failMsg[0] = message;
                        failure[0] = cause == null ? new IOException(message) : cause;
                    }
                });
        if (failCode[0] != null) {
            sink.failure(failCode[0], failMsg[0], failure[0]);
            return;
        }

        // 回读校验
        byte[] readBack;
        try {
            readBack = reReader == null ? null : reReader.readBack();
        } catch (Exception e) {
            sink.failure("VERIFY_READ_FAILED", "写入后无法回读校验：" + describe(e), e);
            return;
        }
        if (readBack == null) {
            // 该 provider 不支持回读：不能声称“已验证”，但写入本身已成功
            sink.failure(
                    "VERIFY_UNSUPPORTED",
                    "该位置不支持写入后校验，无法确认备份完整",
                    null);
            return;
        }
        if (readBack.length == 0) {
            sink.failure("VERIFY_EMPTY", "写入后文件为 0 字节，备份未成功", null);
            return;
        }
        if (readBack.length != content.length) {
            sink.failure(
                    "VERIFY_SIZE_MISMATCH",
                    "写入字节数与源不一致（写入 " + content.length + "，回读 " + readBack.length + "）",
                    null);
            return;
        }
        String srcHash = sha256Hex(content);
        String dstHash = sha256Hex(readBack);
        if (!srcHash.equals(dstHash)) {
            sink.failure("VERIFY_HASH_MISMATCH", "写入内容与源不一致，备份可能损坏", null);
            return;
        }
        sink.success(new VerifiedExport(readBack.length, dstHash));
    }

    /** 回读器：重新打开目标 URI 读取真实内容 */
    public interface ReReader {
        /** @return 真实字节；无法回读时返回 null */
        byte[] readBack() throws IOException;
    }

    /** 计算 SHA-256 十六进制 */
    public static String sha256Hex(byte[] bytes) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(bytes);
            StringBuilder sb = new StringBuilder(d.length * 2);
            final char[] hex = "0123456789abcdef".toCharArray();
            for (byte b : d) {
                sb.append(hex[(b >> 4) & 0xf]).append(hex[b & 0xf]);
            }
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    static void closeQuietly(OutputStream out) {
        try {
            out.close();
        } catch (Exception ignored) {
            // 已经在失败路径上，不再覆盖原始失败原因
        }
    }

    static String describe(Exception e) {
        String m = e.getMessage();
        return (m == null || m.isEmpty()) ? e.getClass().getSimpleName() : m;
    }
}
