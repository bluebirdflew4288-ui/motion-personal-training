import app.motion.personal.plugins.BackupIo;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 纯 JVM 测试（不需要 Android SDK / Gradle / 设备）。
 *
 * <p>直接验证独立静态审查点名的两条实现缺陷：
 * <ul>
 *   <li>A01：write/flush 成功但 <b>close 抛异常</b> → 绝不能出现成功回调</li>
 *   <li>A02：超过上限的流 → 必须<b>中途停止读取</b>，且不产生成功结果</li>
 * </ul>
 *
 * 运行：javac -d out BackupIo.java BackupIoTest.java && java -cp out BackupIoTest
 */
public class BackupIoTest {

    private static int passed = 0;
    private static final List<String> failures = new ArrayList<>();

    public static void main(String[] args) throws Exception {
        testA01ExportSuccessAfterClose();
        testA01CloseThrowsNoSuccess();
        testA01WriteThrowsNoSuccess();
        testA01FlushThrowsNoSuccess();
        testA01NullStreamFails();
        testA02SmallInputOk();
        testA02OversizedStopsReadingEarly();
        testA02ExactLimitOk();
        testA02NullStreamFails();

        System.out.println();
        System.out.println("PASS=" + passed + " FAIL=" + failures.size());
        for (String f : failures) System.out.println("FAIL: " + f);
        if (!failures.isEmpty()) System.exit(1);
        System.out.println("ALL NATIVE IO TESTS PASSED");
    }

    // ── A01：导出成功必须晚于 close ──────────────────────────────

    /** 正常流：write+flush+close 全成功 → 恰好一次 success，字节数与内容正确 */
    private static void testA01ExportSuccessAfterClose() {
        final boolean[] closed = { false };
        final ByteArrayOutputStream sinkBytes = new ByteArrayOutputStream();
        OutputStream out = new OutputStream() {
            @Override public void write(int b) { sinkBytes.write(b); }
            @Override public void write(byte[] b, int off, int len) { sinkBytes.write(b, off, len); }
            @Override public void flush() { }
            @Override public void close() { closed[0] = true; }
        };
        Recorder rec = new Recorder();
        byte[] content = "{\"format\":\"motion-training-backup\"}".getBytes(StandardCharsets.UTF_8);
        BackupIo.exportTo(out, content, rec);

        check("A01 正常导出：close 已执行", closed[0]);
        check("A01 正常导出：恰好一次 success", rec.successes == 1);
        check("A01 正常导出：无 failure", rec.failureCodes.isEmpty());
        check("A01 正常导出：字节数正确", rec.successBytes == content.length);
        check("A01 正常导出：内容写入完整", sinkBytes.size() == content.length);
    }

    /**
     * A01 核心用例：write 与 flush 都成功，**close 抛 I/O 异常**。
     * 修复前：success 在 try-with-resources 内先发出 → JS 已收到 saved=true。
     * 修复后：只能有 failure(CLOSE_FAILED)，success 次数必须为 0。
     */
    private static void testA01CloseThrowsNoSuccess() {
        OutputStream out = new OutputStream() {
            @Override public void write(int b) { }
            @Override public void write(byte[] b, int off, int len) { }
            @Override public void flush() { /* 成功 */ }
            @Override public void close() throws IOException { throw new IOException("provider commit failed"); }
        };
        Recorder rec = new Recorder();
        BackupIo.exportTo(out, "{\"a\":1}".getBytes(StandardCharsets.UTF_8), rec);

        check("A01 close 抛异常：success 次数为 0", rec.successes == 0);
        check("A01 close 抛异常：恰好一次 failure", rec.failureCodes.size() == 1);
        check("A01 close 抛异常：错误码是 CLOSE_FAILED", "CLOSE_FAILED".equals(rec.lastCode()));
        check("A01 close 抛异常：错误消息含原始原因", rec.lastMessage().contains("provider commit failed"));
    }

    /** write 失败 → 无 success，报 WRITE_FAILED */
    private static void testA01WriteThrowsNoSuccess() {
        OutputStream out = new OutputStream() {
            @Override public void write(int b) throws IOException { throw new IOException("disk full"); }
        };
        Recorder rec = new Recorder();
        BackupIo.exportTo(out, new byte[] { 1, 2, 3 }, rec);
        check("A01 write 失败：success 次数为 0", rec.successes == 0);
        check("A01 write 失败：错误码是 WRITE_FAILED", "WRITE_FAILED".equals(rec.lastCode()));
    }

    /** flush 失败 → 无 success，报 FLUSH_FAILED，且仍尝试关闭资源 */
    private static void testA01FlushThrowsNoSuccess() {
        final boolean[] closed = { false };
        OutputStream out = new OutputStream() {
            @Override public void write(int b) { }
            @Override public void flush() throws IOException { throw new IOException("flush broke"); }
            @Override public void close() { closed[0] = true; }
        };
        Recorder rec = new Recorder();
        BackupIo.exportTo(out, new byte[] { 1 }, rec);
        check("A01 flush 失败：success 次数为 0", rec.successes == 0);
        check("A01 flush 失败：错误码是 FLUSH_FAILED", "FLUSH_FAILED".equals(rec.lastCode()));
        check("A01 flush 失败：资源仍被关闭", closed[0]);
    }

    /** 打不开流（SAF 拒绝）→ 无 success */
    private static void testA01NullStreamFails() {
        Recorder rec = new Recorder();
        BackupIo.exportTo(null, new byte[] { 1 }, rec);
        check("A01 空流：success 次数为 0", rec.successes == 0);
        check("A01 空流：错误码是 OPEN_FAILED", "OPEN_FAILED".equals(rec.lastCode()));
    }

    // ── A02：导入必须边读边限 ────────────────────────────────────

    /** 正常小文件读完 */
    private static void testA02SmallInputOk() throws Exception {
        byte[] data = "{\"tiny\":true}".getBytes(StandardCharsets.UTF_8);
        byte[] got = BackupIo.readCapped(new java.io.ByteArrayInputStream(data), 1024);
        check("A02 小文件：内容一致", new String(got, StandardCharsets.UTF_8).equals("{\"tiny\":true}"));
    }

    /** 恰好等于上限：允许（边界包含） */
    private static void testA02ExactLimitOk() throws Exception {
        byte[] data = new byte[1024];
        byte[] got = BackupIo.readCapped(new java.io.ByteArrayInputStream(data), 1024);
        check("A02 恰好等于上限：允许读完", got.length == 1024);
    }

    /**
     * A02 核心用例：计数流 + 远超上限。
     * 断言：抛 TooLargeException、无成功、**读取量远小于总长度**（证明没有读完）。
     */
    private static void testA02OversizedStopsReadingEarly() {
        final int limit = 4096;
        final long totalLength = 512L * 1024 * 1024; // 512MB 假流：真读完会很慢/爆内存
        CountingStream in = new CountingStream(totalLength);

        boolean threw = false;
        String message = "";
        try {
            BackupIo.readCapped(in, limit);
        } catch (BackupIo.TooLargeException e) {
            threw = true;
            message = e.getMessage();
        } catch (Exception e) {
            check("A02 超限：抛的是 TooLargeException（实际 " + e.getClass().getSimpleName() + "）", false);
        }

        check("A02 超限：抛 TooLargeException", threw);
        check("A02 超限：错误消息说明上限", message.contains("48") || message.contains("MB"));
        check("A02 超限：读取量未超过 上限+单块 (实际 " + in.totalRead + ")", in.totalRead <= limit + 8192);
        check("A02 超限：远未读完整个流 (读了 " + in.totalRead + " / " + totalLength + ")", in.totalRead < totalLength / 100);
        check("A02 超限：没有产生成功结果", threw);
    }

    /** 打不开流 → IOException，不是成功 */
    private static void testA02NullStreamFails() {
        boolean threw = false;
        try {
            BackupIo.readCapped(null, 1024);
        } catch (IOException e) {
            threw = true;
        }
        check("A02 空流：抛 IOException", threw);
    }

    // ── 工具 ────────────────────────────────────────────────────

    /** 记录导出回调；同时校验“成功与失败互斥” */
    static class Recorder implements BackupIo.ExportSink {
        int successes = 0;
        int successBytes = -1;
        final List<String> failureCodes = new ArrayList<>();
        final List<String> failureMessages = new ArrayList<>();

        @Override public void success(int bytesWritten) {
            successes++;
            successBytes = bytesWritten;
        }

        @Override public void failure(String code, String msg, Exception cause) {
            failureCodes.add(code);
            failureMessages.add(msg == null ? "" : msg);
        }

        String lastCode() { return failureCodes.isEmpty() ? "" : failureCodes.get(failureCodes.size() - 1); }
        String lastMessage() { return failureMessages.isEmpty() ? "" : failureMessages.get(failureMessages.size() - 1); }
    }

    /** 可统计读取量的流：永远有数据、绝不自然结束 */
    static class CountingStream extends InputStream {
        final long length;
        long totalRead = 0;
        long pos = 0;

        CountingStream(long length) { this.length = length; }

        @Override public int read() {
            if (pos >= length) return -1;
            pos++; totalRead++;
            return 0x41;
        }

        @Override public int read(byte[] b, int off, int len) {
            if (pos >= length) return -1;
            int n = (int) Math.min(len, length - pos);
            for (int i = 0; i < n; i++) b[off + i] = 0x41;
            pos += n; totalRead += n;
            return n;
        }
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            passed++;
            System.out.println("PASS " + name);
        } else {
            failures.add(name);
            System.out.println("FAIL " + name);
        }
    }
}
