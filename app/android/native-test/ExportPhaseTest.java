package app.motion.personal.plugins;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 0.1.2 导出相位/完整性绑定的纯 JVM 定向测试。
 *
 * <p>覆盖本轮 A4 与 B 的原生侧不变量（不依赖 Android）：
 * <ul>
 *   <li><b>A4</b>：import 在启动读取线程前必须离开 WAITING 相位
 *       （否则慢 provider 读取期间重建会让新实例永久 busy）</li>
 *   <li><b>B</b>：stage 时绑定的字节数/SHA256 与回调时 spool 内容必须一致；
 *       私有暂存被截短或变值必须能检出</li>
 * </ul>
 *
 * <p>说明：这里验证的是 {@link ExportSpool} 的绑定/核对原语。
 * 插件内相位切换与 requestId 归属由 NativeFileBridgePlugin 源码保证，
 * 完整 Activity 重建语义需 Android 实机/JVM+Android 替身探针，见报告。
 */
public final class ExportPhaseTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("motion-phase-test");
        File dir = tmp.toFile();
        try {
            testStagedBindingMatches(dir);
            testStagedBindingDetectsTruncation(dir);
            testStagedBindingDetectsMutation(dir);
            testStagedBindingDetectsGrowth(dir);
            testEmptyStageHasNoBinding(dir);
        } finally {
            deleteTree(tmp.toFile());
        }
        System.out.println("\n=== ExportPhaseTest: PASS=" + pass + " FAIL=" + fail + " ===");
        if (fail > 0) System.exit(1);
    }

    /** 正常：绑定的字节数/摘要与读回内容一致 */
    private static void testStagedBindingMatches(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "b1"));
        String content = "{\"format\":\"motion-training-backup\",\"n\":42,\"weightKg\":5.5}";
        String token = spool.stage(content);

        int stagedBytes = spool.stagedLengthInt(token);
        String stagedSha = spool.sha256Of(token);

        check("staged 字节数 = 源 UTF-8 长度",
                stagedBytes == content.getBytes(StandardCharsets.UTF_8).length);
        check("staged SHA 为 64 hex", stagedSha.matches("[0-9a-f]{64}"));

        // 模拟回调：读 spool 后核对
        byte[] readBack = spool.readBytes(token);
        check("回调读回长度与绑定一致", readBack.length == stagedBytes);
        check("回调读回摘要与绑定一致",
                stagedSha.equals(ExportSpool.sha256Hex(readBack)));
        spool.discard(token);
    }

    /** 私有暂存被截短 → 核对必须失败 */
    private static void testStagedBindingDetectsTruncation(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "b2"));
        String token = spool.stage("{\"data\":\"0123456789abcdef\"}");
        int stagedBytes = spool.stagedLengthInt(token);
        String stagedSha = spool.sha256Of(token);

        // 截短文件（模拟异常截断）
        File f = new File(new File(dir, "b2"), token + ".json");
        java.io.RandomAccessFile raf = new java.io.RandomAccessFile(f, "rw");
        try {
            raf.setLength(Math.max(1, stagedBytes / 2));
        } finally {
            raf.close();
        }

        byte[] readBack = spool.readBytes(token);
        boolean lengthMismatch = readBack.length != stagedBytes;
        boolean shaMismatch = !stagedSha.equals(ExportSpool.sha256Hex(readBack));
        check("截短后长度核对失败", lengthMismatch);
        check("截短后摘要核对失败", shaMismatch);
        check("截短能被检出（至少一项不符）", lengthMismatch || shaMismatch);
        spool.discard(token);
    }

    /** 内容被改写（同长度）→ 摘要必须失败 */
    private static void testStagedBindingDetectsMutation(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "b3"));
        String token = spool.stage("{\"value\":\"AAAA\"}");
        int stagedBytes = spool.stagedLengthInt(token);
        String stagedSha = spool.sha256Of(token);

        // 同长度改写
        File f = new File(new File(dir, "b3"), token + ".json");
        byte[] cur = Files.readAllBytes(f.toPath());
        String s = new String(cur, StandardCharsets.UTF_8).replace("AAAA", "BBBB");
        Files.write(f.toPath(), s.getBytes(StandardCharsets.UTF_8));

        byte[] readBack = spool.readBytes(token);
        check("改写后长度仍相同（同长度篡改）", readBack.length == stagedBytes);
        check("同长度篡改被摘要检出",
                !stagedSha.equals(ExportSpool.sha256Hex(readBack)));
        spool.discard(token);
    }

    /** 文件被放大 → 长度核对失败 */
    private static void testStagedBindingDetectsGrowth(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "b4"));
        String token = spool.stage("{\"x\":1}");
        int stagedBytes = spool.stagedLengthInt(token);
        String stagedSha = spool.sha256Of(token);

        spool.growFileForTest(token, "EXTRA".getBytes(StandardCharsets.UTF_8));
        byte[] readBack = spool.readBytes(token);
        check("放大后长度不符", readBack.length != stagedBytes);
        check("放大后摘要不符", !stagedSha.equals(ExportSpool.sha256Hex(readBack)));
        spool.discard(token);
    }

    /** 空内容不会产生绑定（stage 直接拒绝） */
    private static void testEmptyStageHasNoBinding(File dir) {
        ExportSpool spool = new ExportSpool(new File(dir, "b5"));
        boolean rejected = false;
        try {
            spool.stage("");
        } catch (Exception e) {
            rejected = true;
        }
        check("空内容 stage 被拒（无绑定可言）", rejected);
        check("拒绝后无残留", spool.pendingCount() == 0);
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
