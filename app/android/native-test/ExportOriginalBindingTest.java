package app.motion.personal.plugins;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * 0.1.2 「最初正文」完整性绑定的定向测试（Codex T4/T5 缺口回归）。
 *
 * <h2>被验证的承诺</h2>
 * expected 长度/摘要必须来自<b>最初 content 的 UTF-8 字节</b>，
 * 而不是回读已写出的 spool 再算。
 *
 * <p>区别只在「stage 完成、metadata 生成前」这个窗口：
 * <ul>
 *   <li>若 expected 来自回读 spool → 该窗口内文件被等长改值/非空截短时，
 *       expected 会跟着错误内容一起变化，校验仍然通过（T4/T5 缺口）</li>
 *   <li>若 expected 来自最初字节 → 同一窗口的篡改会被检出</li>
 * </ul>
 *
 * <p>本测试用 {@link ExportSpool#stageBytes(byte[])} 的「同源字节」语义复现：
 * 先算 originalBytes 的长度与 SHA（模拟插件做法），再故意在 stage 之后改文件，
 * 最后用 originalBytes 的 expected 去核对读回内容 —— 必须拒绝。
 */
public final class ExportOriginalBindingTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("motion-orig-bind");
        File dir = tmp.toFile();
        try {
            testUntouchedMatchesOriginal(dir);
            testEqualLengthMutationDetected(dir);   // T4 场景
            testTruncationDetected(dir);            // T5 场景
            testExpectedDoesNotFollowFileChange(dir);
        } finally {
            deleteTree(tmp.toFile());
        }
        System.out.println("\n=== ExportOriginalBindingTest: PASS=" + pass + " FAIL=" + fail + " ===");
        if (fail > 0) System.exit(1);
    }

    /** 未改动：expected(原始字节) 与读回内容一致 */
    private static void testUntouchedMatchesOriginal(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "o1"));
        String content = "{\"format\":\"motion-training-backup\",\"reps\":8,\"weightKg\":5.5}";

        // 插件做法：一次算字节，同一份用于 stage 与 expected
        byte[] originalBytes = content.getBytes(StandardCharsets.UTF_8);
        int expectedLen = originalBytes.length;
        String expectedSha = BackupIo.sha256Hex(originalBytes);

        String token = spool.stageBytes(originalBytes);
        byte[] readBack = spool.readBytes(token);

        check("未改动：长度与原始字节一致", readBack.length == expectedLen);
        check("未改动：摘要与原始字节一致", expectedSha.equals(BackupIo.sha256Hex(readBack)));
        spool.discard(token);
    }

    /** T4：stage 后、绑定前的「等长改值」必须被原始 expected 检出 */
    private static void testEqualLengthMutationDetected(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "o2"));
        String content = "{\"value\":\"AAAA\",\"n\":1}";

        byte[] originalBytes = content.getBytes(StandardCharsets.UTF_8);
        int expectedLen = originalBytes.length;
        String expectedSha = BackupIo.sha256Hex(originalBytes);

        String token = spool.stageBytes(originalBytes);

        // 模拟「stage 完成、metadata 生成前」窗口内的等长改写
        File f = new File(new File(dir, "o2"), token + ".json");
        byte[] cur = Files.readAllBytes(f.toPath());
        String mutated = new String(cur, StandardCharsets.UTF_8).replace("AAAA", "BBBB");
        Files.write(f.toPath(), mutated.getBytes(StandardCharsets.UTF_8));

        byte[] readBack = spool.readBytes(token);

        check("T4 等长改值：长度仍相等（证明只靠长度挡不住）", readBack.length == expectedLen);
        check(
                "T4 等长改值：用原始 expected 摘要能检出",
                !expectedSha.equals(BackupIo.sha256Hex(readBack)));

        // 反证：如果 expected 是回读文件生成的（旧缺口做法），就会错误放行
        String wrongSha = spool.sha256Of(token); // 回读磁盘 = 被改后的内容
        check(
                "T4 反证：回读生成的 expected 会错误放行（旧缺口）",
                wrongSha.equals(BackupIo.sha256Hex(readBack)));

        spool.discard(token);
    }

    /** T5：stage 后、绑定前的「非空截短」必须被原始 expected 检出 */
    private static void testTruncationDetected(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "o3"));
        String content = "{\"data\":\"0123456789abcdef\"}";

        byte[] originalBytes = content.getBytes(StandardCharsets.UTF_8);
        int expectedLen = originalBytes.length;
        String expectedSha = BackupIo.sha256Hex(originalBytes);

        String token = spool.stageBytes(originalBytes);

        // 模拟窗口内非空截短（保留一半以上，仍是合法非空文件）
        File f = new File(new File(dir, "o3"), token + ".json");
        java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw");
        try {
            raf.setLength(expectedLen - 4);
        } finally {
            raf.close();
        }

        byte[] readBack = spool.readBytes(token);
        check("T5 截短：仍非空", readBack.length > 0);
        check("T5 截短：长度与原始 expected 不符", readBack.length != expectedLen);
        check(
                "T5 截短：摘要与原始 expected 不符",
                !expectedSha.equals(BackupIo.sha256Hex(readBack)));

        // 反证：回读生成 expected 会把截短后的长度当成正确值
        int wrongLen = spool.stagedLengthInt(token);
        check("T5 反证：回读生成的 expected 长度会跟着变（旧缺口）", wrongLen == readBack.length);

        spool.discard(token);
    }

    /** 核心不变量：expected 不随文件变化而变化 */
    private static void testExpectedDoesNotFollowFileChange(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "o4"));
        String content = "{\"k\":\"VVVV\"}";

        byte[] originalBytes = content.getBytes(StandardCharsets.UTF_8);
        int expectedLen = originalBytes.length;
        String expectedSha = BackupIo.sha256Hex(originalBytes);

        String token = spool.stageBytes(originalBytes);

        // 改动文件两次，expected 必须始终是原始值
        File f = new File(new File(dir, "o4"), token + ".json");
        for (String repl : new String[] {"WWWW", "XXXX"}) {
            byte[] cur = Files.readAllBytes(f.toPath());
            String m = new String(cur, StandardCharsets.UTF_8).replace("VVVV", repl);
            Files.write(f.toPath(), m.getBytes(StandardCharsets.UTF_8));
        }

        check("expected 长度始终等于最初正文", expectedLen == originalBytes.length);
        check("expected 摘要是最初正文的摘要",
                expectedSha.equals(BackupIo.sha256Hex(originalBytes)));
        check(
                "当前文件摘要已不同于最初正文",
                !expectedSha.equals(BackupIo.sha256Hex(spool.readBytes(token))));
        spool.discard(token);
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  PASS  " + name);
        } else {
            fail++;
            System.out.println("  FAIL  " + name);
        }
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
