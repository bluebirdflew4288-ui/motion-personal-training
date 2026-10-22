package app.motion.personal.plugins;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * ExportSpool 的纯 JVM 测试（不需要 Android SDK / 设备）。
 *
 * <p>覆盖 0.1.2 修复的关键不变量，并专门回归独立审查点名的 3 个缺陷：
 * <ul>
 *   <li><b>缺陷1</b>：purgeStale 曾无条件删除全部 .json（误删新 pending 与无关文件）
 *       → 现在只清「合法 token 命名 + 已过期 + 非待恢复」</li>
 *   <li><b>缺陷2</b>：discard(null) 曾在 Map.remove(null) 处 NPE
 *       → 现在先校验，空/非法 token 安全返回 false</li>
 *   <li><b>缺陷3</b>：readBytes 曾不执行 maxBytes 上限（文件 stage 后变大仍整读）
 *       → 现在读前核对长度 + 逐块累计限额</li>
 * </ul>
 */
public final class ExportSpoolTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("motion-spool-test");
        File dir = tmp.toFile();

        try {
            // ── 基础 ──
            testStageAndRead(dir);
            testLargeContentDoesNotBlowUp(dir);
            testEmptyRejected(dir);
            testOverLimitRejected(dir);
            testInvalidTokenRejected(dir);
            testPathTraversalRejected(dir);
            testDiscardRemovesFile(dir);
            testSurvivesMemoryLoss(dir);
            testSha256(dir);

            // ── 缺陷 1 回归：清理不能误删 ──
            testPurgeKeepsFreshPending(dir);
            testPurgeKeepsUnrelatedFiles(dir);
            testPurgeRemovesOnlyExpiredLegitTokens(dir);
            testPurgeKeepsPendingAcrossInstances(dir);

            // ── 缺陷 2 回归：discard(null) 不能崩 ──
            testDiscardNullSafe(dir);

            // ── 缺陷 3 回归：读取限额 ──
            testReadRejectsGrownFile(dir);
            testReadRejectsOversizedAtOpen(dir);
        } finally {
            deleteTree(tmp.toFile());
        }

        System.out.println("\n=== ExportSpoolTest: PASS=" + pass + " FAIL=" + fail + " ===");
        if (fail > 0) System.exit(1);
    }

    // ── 基础 ─────────────────────────────────────────────────────────────────

    private static void testStageAndRead(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "s1"));
        String content = "{\"format\":\"motion-training-backup\",\"n\":1}";
        String token = spool.stage(content);

        check("token 长度为 32（短，可安全进 Bundle）", token.length() == 32);
        check("token 只含十六进制", token.matches("[0-9a-f]{32}"));
        check("读回内容与源一致", content.equals(spool.read(token)));
        check(
                "暂存文件真实存在且非空",
                spool.stagedLength(token) == content.getBytes(StandardCharsets.UTF_8).length);
        spool.discard(token);
    }

    private static void testLargeContentDoesNotBlowUp(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "s2"));
        StringBuilder sb = new StringBuilder(2 * 1024 * 1024);
        sb.append("{\"data\":[");
        int i = 0;
        while (sb.length() < 2 * 1024 * 1024) {
            if (i > 0) sb.append(',');
            sb.append("{\"i\":").append(i).append(",\"reps\":8,\"weightKg\":5.5}");
            i++;
        }
        sb.append("]}");
        String content = sb.toString();
        int expected = content.getBytes(StandardCharsets.UTF_8).length;

        String token = spool.stage(content);
        check("2MB 内容能写入暂存（不抛异常）", token != null && token.length() == 32);
        check("暂存文件字节数 = 源 UTF-8 字节数", spool.stagedLength(token) == expected);
        check("2MB 内容读回完全一致", content.equals(spool.read(token)));
        check("token 长度 << 正文长度", token.length() < expected / 1000);
        spool.discard(token);
    }

    private static void testEmptyRejected(File dir) {
        ExportSpool spool = new ExportSpool(new File(dir, "s3"));
        check("空串被拒", throwsIO(() -> spool.stage("")));
        check("null 被拒", throwsIO(() -> spool.stage(null)));
        check("拒绝后无残留", spool.pendingCount() == 0);
    }

    private static void testOverLimitRejected(File dir) {
        ExportSpool spool = new ExportSpool(new File(dir, "s4"), 100);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200; i++) sb.append('x');
        check("超限内容被拒", throwsIO(() -> spool.stage(sb.toString())));
        check("超限拒绝后无残留", spool.pendingCount() == 0);
    }

    private static void testInvalidTokenRejected(File dir) {
        ExportSpool spool = new ExportSpool(new File(dir, "s5"));
        check("null token 读被拒", throwsIO(() -> spool.read(null)));
        check("空 token 读被拒", throwsIO(() -> spool.read("")));
        check("短 token 读被拒", throwsIO(() -> spool.read("abc")));
        check("非十六进制 token 读被拒", throwsIO(() -> spool.read("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")));
        check("含斜杠 token 读被拒", throwsIO(() -> spool.read("../../etc/passwd0000000000000000")));
        check("大写十六进制被拒（严格小写）", throwsIO(() -> spool.read("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")));
    }

    private static void testPathTraversalRejected(File dir) {
        ExportSpool spool = new ExportSpool(new File(dir, "s6"));
        String[] attacks = {
            "../secret.json",
            "/etc/passwd",
            "..\\windows\\system32",
            "0123456789abcdef0123456789abcde/",
            "0123456789abcdef0123456789abcde.",
        };
        boolean allRejected = true;
        for (String a : attacks) {
            if (!throwsIO(() -> spool.read(a))) allRejected = false;
        }
        check("所有路径穿越/非法 token 均被拒", allRejected);
    }

    private static void testDiscardRemovesFile(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "s7"));
        String token = spool.stage("{\"a\":1}");
        check("写入后有 1 个暂存", spool.pendingCount() == 1);
        check("discard 返回 true", spool.discard(token));
        check("discard 后文件不存在", spool.pendingCount() == 0);
        check("discard 后读回失败", throwsIO(() -> spool.read(token)));
    }

    /** 关键：Activity 重建 / 进程内存丢失后仍能按 token 读回（不靠内存白名单） */
    private static void testSurvivesMemoryLoss(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "s8"));
        String content = "{\"format\":\"motion-training-backup\",\"big\":\"" + repeat('x', 5000) + "\"}";
        String token = spool.stage(content);
        check("写入后已登记", spool.isIssued(token));

        spool.forgetIssuedForTest();
        check("内存记录已清空", !spool.isIssued(token));
        check("仍能从磁盘读回正文（Activity 重建可用）", content.equals(spool.read(token)));

        // 跨实例：全新 ExportSpool 指向同一目录，也应能读回
        ExportSpool other = new ExportSpool(new File(dir, "s8"));
        check("新实例也能按 token 读回（跨进程恢复）", content.equals(other.read(token)));
    }

    // ── 缺陷 1 回归 ──────────────────────────────────────────────────────────

    /** 新建的 pending 不能被立刻清掉（原实现 purgeStale 无条件删全部 .json） */
    private static void testPurgeKeepsFreshPending(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "p1"));
        String t1 = spool.stage("{\"a\":1}");
        String t2 = spool.stage("{\"b\":2}");
        check("写入后 2 个暂存", spool.pendingCount() == 2);

        int removed = spool.purgeStale();
        check("purgeStale 不删新鲜 pending（removed=0）", removed == 0);
        check("pending 仍存在", spool.pendingCount() == 2);
        check("pending 仍可读回", "{\"a\":1}".equals(spool.read(t1)));
        check("pending 仍可读回2", "{\"b\":2}".equals(spool.read(t2)));
    }

    /** 无关文件（unrelated.json 等）永不被删 */
    private static void testPurgeKeepsUnrelatedFiles(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "p2"));
        File d = new File(dir, "p2");
        spool.writeLegacyForTest("unrelated.json", "keep me".getBytes(StandardCharsets.UTF_8));
        spool.writeLegacyForTest("notes.txt", "keep".getBytes(StandardCharsets.UTF_8));
        spool.writeLegacyForTest("a.json.part", "keep".getBytes(StandardCharsets.UTF_8));
        // 造一个已过期的无关文件
        spool.ageFileForTest("unrelated.json", 48L * 3600 * 1000);

        int removed = spool.purgeStale(1000);
        check("不删无关文件 unrelated.json", new File(d, "unrelated.json").isFile());
        check("不删无关文件 notes.txt", new File(d, "notes.txt").isFile());
        check("不删非 token 命名的 a.json.part", new File(d, "a.json.part").isFile());
        check("无关文件不被计入 pendingCount", spool.pendingCount() == 0);
        check("removed=0", removed == 0);
    }

    /** 只删「合法 token 命名 + 已过期」的残留 */
    private static void testPurgeRemovesOnlyExpiredLegitTokens(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "p3"));
        String token = spool.stage("{\"x\":1}");
        // 解除 pending 并改成过期，模拟崩溃留下的孤儿
        spool.clearPending(token);
        spool.ageFileForTest(token + ".json", 48L * 3600 * 1000);

        check("清理前存在", spool.pendingCount() == 1);
        int removed = spool.purgeStale(1000);
        check("过期孤儿被清理（removed=1）", removed == 1);
        check("清理后为 0", spool.pendingCount() == 0);
    }

    /** 跨实例：新实例不应把别人的 pending 当垃圾清掉 */
    private static void testPurgeKeepsPendingAcrossInstances(File dir) throws Exception {
        File d = new File(dir, "p4");
        ExportSpool a = new ExportSpool(d);
        String token = a.stage("{\"inflight\":true}");

        // 模拟 Activity 重建：新实例接管，内存 pending 集合为空
        ExportSpool b = new ExportSpool(d);
        check("新实例 pendingCount=1", b.pendingCount() == 1);

        // 未过期 → 即便新实例不知道它是 pending，也不能删
        int removed = b.purgeStale(24L * 3600 * 1000);
        check("未过期的跨实例残留不被删（removed=0）", removed == 0);
        check("文件仍在", b.pendingCount() == 1);
        check("新实例仍能读回（恢复路径成立）", "{\"inflight\":true}".equals(b.read(token)));
    }

    // ── 缺陷 2 回归 ──────────────────────────────────────────────────────────

    /** discard(null) / discard(非法) 不能抛异常 */
    private static void testDiscardNullSafe(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "d1"));
        boolean threw = false;
        try {
            check("discard(null) 返回 false", !spool.discard(null));
            check("discard(\"\") 返回 false", !spool.discard(""));
            check("discard(\"abc\") 返回 false", !spool.discard("abc"));
            check("discard(非法 hex) 返回 false", !spool.discard("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
            check("discard(路径穿越) 返回 false", !spool.discard("../../etc/passwd0000000000000000"));
        } catch (Throwable t) {
            threw = true;
            System.out.println("    (抛出: " + t + ")");
        }
        check("discard 空/非法 token 全程不抛异常", !threw);
    }

    // ── 缺陷 3 回归 ──────────────────────────────────────────────────────────

    /** stage 后文件被放大 → 读取必须拒绝，不能整读进堆 */
    private static void testReadRejectsGrownFile(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "r1"), 1024);
        String token = spool.stage("{\"small\":true}");
        check("小内容可读", "{\"small\":true}".equals(spool.read(token)));

        // 把文件撑到远超 maxBytes
        byte[] extra = new byte[4096];
        Arrays.fill(extra, (byte) 'x');
        spool.growFileForTest(token, extra);
        check("放大后 stagedLength 已超上限", spool.stagedLength(token) > 1024);
        check("读取超限文件被拒", throwsIO(() -> spool.readBytes(token)));
    }

    /** 读前长度闸门：直接造一个超大文件 */
    private static void testReadRejectsOversizedAtOpen(File dir) throws Exception {
        ExportSpool spool = new ExportSpool(new File(dir, "r2"), 512);
        // 用合法 token 命名直接造大文件
        String token = "0123456789abcdef0123456789abcdef";
        byte[] big = new byte[2048];
        Arrays.fill(big, (byte) 'y');
        spool.writeLegacyForTest(token + ".json", big);
        check("打开前即拒绝超限文件", throwsIO(() -> spool.readBytes(token)));
    }

    // ── 其它 ─────────────────────────────────────────────────────────────────

    private static void testSha256(File dir) throws Exception {
        String empty = ExportSpool.sha256Hex(new byte[0]);
        check(
                "空串 SHA-256 正确",
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".equals(empty));

        byte[] abc = "abc".getBytes(StandardCharsets.UTF_8);
        check(
                "abc SHA-256 正确",
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
                        .equals(ExportSpool.sha256Hex(abc)));

        byte[] big = repeat('y', 10000).getBytes(StandardCharsets.UTF_8);
        check("同内容哈希稳定", ExportSpool.sha256Hex(big).equals(ExportSpool.sha256Hex(big.clone())));
    }

    // ── 工具 ─────────────────────────────────────────────────────────────────

    private interface IORun {
        void run() throws IOException;
    }

    private static boolean throwsIO(IORun r) {
        try {
            r.run();
            return false;
        } catch (IOException e) {
            return true;
        }
    }

    private static String repeat(char c, int n) {
        char[] a = new char[n];
        Arrays.fill(a, c);
        return new String(a);
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
