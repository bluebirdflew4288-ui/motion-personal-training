package app.motion.personal.plugins;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * MOTION · 导出正文的私有暂存区（修复 TransactionTooLargeException）。
 *
 * <h2>为什么必须有它</h2>
 * Capacitor 8.5.3 在 {@code Plugin.startActivityForResult} 之后会把整个 PluginCall
 * 留在 {@code bridge.pluginCallForLastActivity}，并在 Activity 进入 stopped 时
 * <b>两份</b>序列化它的 options：
 *
 * <pre>
 *   Bridge.saveInstanceState(outState)
 *     outState.putString("capacitorLastPluginCallOptions", call.getData().toString());  // 第 1 份
 *     outState.putBundle("capacitorLastPluginCallBundle", plugin.saveInstanceState());  // 第 2 份
 *       Plugin.saveInstanceState() -> ret.putString("_json", callData.toString());      //   其中又一份
 * </pre>
 *
 * 实测（模拟器 Android 16 / API 36）：2.68 MB 备份文本让
 * {@code capacitorLastPluginCallOptions} 与 {@code capacitorLastPluginCallBundle}
 * 各占 5,866,684 B，合计 11,736,560 B 的 parcel，远超 binder 事务上限，
 * 进程在 {@code activityStopped} 抛 {@code TransactionTooLargeException} 被杀
 * —— 用户看到的就是「App 自己退出、无成功提示、留下 0B 文件」。
 *
 * <h2>职责边界</h2>
 * <ul>
 *   <li>正文写到 App <b>私有目录</b>下的临时文件；PluginCall 里只留<b>短 token</b>。</li>
 *   <li><b>只接受本类签发的 token 格式</b>（32 位小写十六进制），不接受任何外部路径。</li>
 *   <li>写入用「先写 .part 再原子改名」，避免读到半截文件。</li>
 *   <li><b>读取也限额</b>：读前核对文件长度，逐块累计再校验，避免 stage 后文件被放大导致整读。</li>
 *   <li>清理有 TTL：只清「合法 token 命名 + 已过期 + 不在待恢复集合」的残留，
 *       正常 pending 跨进程/跨实例恢复必须保留。</li>
 * </ul>
 *
 * <p><b>本类不 import 任何 Android 类型</b>，可用普通 javac/java 直接测试
 * （见 {@code app/android/native-test/ExportSpoolTest.java}）。
 */
public final class ExportSpool {

    /** 单次导出允许暂存的最大字节数 */
    public static final long DEFAULT_MAX_BYTES = 40L * 1024 * 1024;

    /**
     * 残留暂存文件的存活时长。
     *
     * <p>一次导出从「打开 SAF」到「用户选完位置」通常几秒到几分钟；
     * 24 小时远大于此，因此正常 pending 绝不会被误清，
     * 同时又能回收崩溃/被杀留下的孤儿文件。
     */
    public static final long DEFAULT_STALE_TTL_MS = 24L * 60 * 60 * 1000;

    private static final String SUFFIX = ".json";
    private static final String PART_SUFFIX = ".part";
    private static final char[] HEX = "0123456789abcdef".toCharArray();

    private final File dir;
    private final long maxBytes;
    private final SecureRandom random = new SecureRandom();

    /**
     * 本进程内「明确待恢复」的 token。
     *
     * <p>注意：这<b>不是</b>读权限白名单 —— {@link #read} 只校验 token 格式与文件存在，
     * 不要求 token 在本集合里。因此 Activity 重建 / 进程重启后依然能按 token 读回正文。
     * 本集合的唯一作用是让 {@link #purgeStale} 跳过正在飞行中的导出。
     */
    private final Set<String> pending = ConcurrentHashMap.newKeySet();

    /** 仅用于诊断：本进程签发过的 token（不参与读权限判定） */
    private final ConcurrentHashMap<String, Long> issued = new ConcurrentHashMap<>();

    public ExportSpool(File dir, long maxBytes) {
        if (dir == null) throw new IllegalArgumentException("暂存目录不能为空");
        this.dir = dir;
        this.maxBytes = maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    }

    public ExportSpool(File dir) {
        this(dir, DEFAULT_MAX_BYTES);
    }

    public File getDir() {
        return dir;
    }

    public long getMaxBytes() {
        return maxBytes;
    }

    /**
     * 把正文写入私有临时文件，返回短 token。
     *
     * <p>顺序：建目录 → 生成 token → 写 .part → fsync → 原子改名。
     * 只有改名成功才算签发；任何一步失败都清掉半成品并抛异常。
     */
    public String stage(String content) throws IOException {
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
        if (bytes.length == 0) throw new IOException("内容为空，无法导出");
        if (bytes.length > maxBytes) {
            throw new IOException("备份内容超过 " + (maxBytes / (1024 * 1024)) + " MB，无法导出");
        }
        ensureDir();

        String token = newToken();
        File part = new File(dir, token + SUFFIX + PART_SUFFIX);
        File target = new File(dir, token + SUFFIX);

        boolean ok = false;
        try {
            FileOutputStream out = new FileOutputStream(part);
            try {
                out.write(bytes);
                out.flush();
                out.getFD().sync();
            } finally {
                out.close();
            }
            if (!part.renameTo(target)) throw new IOException("暂存文件改名失败");
            ok = true;
            issued.put(token, (long) bytes.length);
            // 新写入的一定是待恢复的，标记为 pending 以躲过清理
            pending.add(token);
            return token;
        } finally {
            if (!ok) {
                deleteQuietly(part);
                deleteQuietly(target);
            }
        }
    }

    /** 按 token 读回正文（Activity 重建 / 跨实例同样可用，因为正文在磁盘上）。 */
    public String read(String token) throws IOException {
        byte[] bytes = readBytes(token);
        if (bytes.length == 0) throw new IOException("暂存内容为空，无法写入");
        return new String(bytes, StandardCharsets.UTF_8);
    }

    /** 暂存文件当前字节数（int 版；供短元数据绑定） */
    public int stagedLengthInt(String token) throws IOException {
        long n = stagedLength(token);
        if (n > Integer.MAX_VALUE) throw new IOException("暂存文件过大");
        return (int) n;
    }

    /** 暂存文件内容的 SHA-256（供短元数据绑定，写入后完整性核对） */
    public String sha256Of(String token) throws IOException {
        return sha256Hex(readBytes(token));
    }

    /**
     * 读取暂存文件真实字节（写入后回读校验用）。
     *
     * <p><b>读取也限额</b>：stage 之后文件仍可能被放大（异常、外部写入、磁盘损坏），
     * 因此这里先核对文件长度，再逐块累计并在超限时立刻中止，
     * 不会把超大文件整体读进堆。
     */
    public byte[] readBytes(String token) throws IOException {
        File f = fileForToken(token);
        if (!f.isFile()) throw new IOException("暂存内容已不存在，无法写入");
        return readCapped(f, maxBytes);
    }

    /**
     * 清理指定 token；返回是否已删除。
     *
     * <p><b>空/非法 token 一律安全返回 false</b>（取消、缺 token 等路径不能崩）。
     */
    public boolean discard(String token) {
        // 先校验：null / 非法 token 直接安全返回，绝不进入 Map/文件操作
        if (!isValidToken(token)) return false;
        pending.remove(token);
        issued.remove(token);
        File f;
        try {
            f = fileForToken(token);
        } catch (IOException e) {
            return false;
        }
        return deleteQuietly(f) || !f.exists();
    }

    /** 显式标记某 token 为待恢复（防止清理误删） */
    public void markPending(String token) {
        if (isValidToken(token)) pending.add(token);
    }

    /** 解除待恢复标记（成功/失败/取消后） */
    public void clearPending(String token) {
        if (isValidToken(token)) pending.remove(token);
    }

    /** 当前是否被标记为待恢复 */
    public boolean isPending(String token) {
        return isValidToken(token) && pending.contains(token);
    }

    public int purgeStale() {
        return purgeStale(DEFAULT_STALE_TTL_MS);
    }

    /**
     * 清理过期残留暂存文件。
     *
     * <p><b>只删同时满足以下三条的文件</b>：
     * <ol>
     *   <li>文件名是本插件的合法 token 命名（{@code <32hex>.json} 或 {@code <32hex>.json.part}）</li>
     *   <li>修改时间早于 {@code now - ttlMs}（已过期）</li>
     *   <li>不属于当前待恢复集合（{@link #pending}）</li>
     * </ol>
     *
     * <p>因此：<b>无关文件（如 {@code unrelated.json}）永不删除</b>；
     * 正常 pending 的暂存（含跨实例恢复的场景）在 TTL 内保留。
     *
     * @param ttlMs 存活时长；小于 0 视为 0
     * @return 实际删除的文件数
     */
    public int purgeStale(long ttlMs) {
        if (!dir.isDirectory()) return 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;

        long now = System.currentTimeMillis();
        long ttl = Math.max(0, ttlMs);
        int removed = 0;

        for (File f : files) {
            if (!f.isFile()) continue;
            String name = f.getName();
            String token = tokenOfLegitName(name);
            // 不是本插件的合法命名 → 一律不碰
            if (token == null) continue;
            // 正在待恢复 → 保留
            if (pending.contains(token)) continue;
            // 未过期 → 保留
            long age = now - f.lastModified();
            if (age < ttl) continue;
            if (deleteQuietly(f)) removed++;
        }
        return removed;
    }

    /** 当前遗留暂存文件数（只统计本插件合法命名，诊断用） */
    public int pendingCount() {
        if (!dir.isDirectory()) return 0;
        File[] files = dir.listFiles();
        if (files == null) return 0;
        int n = 0;
        for (File f : files) {
            if (f.isFile() && tokenOfLegitName(f.getName()) != null) n++;
        }
        return n;
    }

    /** 计算 SHA-256（回读比对用）。 */
    public static String sha256Hex(byte[] bytes) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(bytes);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) {
                sb.append(HEX[(b >> 4) & 0xf]).append(HEX[b & 0xf]);
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    /** token 是否合法（32 位小写十六进制） */
    public static boolean isValidToken(String token) {
        if (token == null || token.length() != 32) return false;
        for (int i = 0; i < token.length(); i++) {
            char c = token.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) return false;
        }
        return true;
    }

    // ── 内部 ────────────────────────────────────────────────────────────────

    /**
     * 合法暂存文件名 → token；不是本插件的命名则返回 null。
     *
     * <p>严格白名单：只有 {@code <32hex>.json} 与 {@code <32hex>.json.part}。
     * 因此 {@code unrelated.json}、{@code notes.txt} 等永远不会被当作暂存清理。
     */
    static String tokenOfLegitName(String name) {
        if (name == null) return null;
        String base;
        if (name.endsWith(SUFFIX + PART_SUFFIX)) {
            base = name.substring(0, name.length() - (SUFFIX + PART_SUFFIX).length());
        } else if (name.endsWith(SUFFIX)) {
            base = name.substring(0, name.length() - SUFFIX.length());
        } else {
            return null;
        }
        return isValidToken(base) ? base : null;
    }

    /**
     * token -> 受控文件。
     *
     * <p>安全要点：token 必须是合法十六进制；白名单校验后拼路径，
     * 并确认父目录就是受控目录，因此 {@code ../}、绝对路径、分隔符都无法生效。
     */
    private File fileForToken(String token) throws IOException {
        if (!isValidToken(token)) throw new IOException("无效的暂存标识");
        File f = new File(dir, token + SUFFIX);
        File parent = f.getParentFile();
        if (parent == null || !parent.getAbsoluteFile().equals(dir.getAbsoluteFile())) {
            throw new IOException("暂存路径越界");
        }
        return f;
    }

    private String newToken() {
        byte[] b = new byte[16];
        random.nextBytes(b);
        StringBuilder sb = new StringBuilder(32);
        for (byte x : b) {
            sb.append(HEX[(x >> 4) & 0xf]).append(HEX[x & 0xf]);
        }
        return sb.toString();
    }

    private void ensureDir() throws IOException {
        if (dir.isDirectory()) return;
        if (!dir.mkdirs() && !dir.isDirectory()) throw new IOException("无法创建暂存目录");
    }

    /**
     * 限额读取：读前核对长度，逐块累计超限即中止。
     *
     * <p>两道闸门：
     * <ol>
     *   <li>打开前用 {@code file.length()} 快速拒绝明显超限的文件</li>
     *   <li>读取过程中累计字节数，一旦超过上限立刻抛异常（防止读取期间文件继续变大）</li>
     * </ol>
     */
    private static byte[] readCapped(File f, long maxBytes) throws IOException {
        long declared = f.length();
        if (declared > maxBytes) {
            throw new IOException("暂存内容超过上限（" + declared + " > " + maxBytes + " 字节），拒绝读取");
        }
        int initial = (int) Math.min(Math.max(declared, 64), Integer.MAX_VALUE - 8);
        ByteArrayOutputStream buf = new ByteArrayOutputStream(initial);
        InputStream in = new FileInputStream(f);
        try {
            byte[] chunk = new byte[8 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > maxBytes) {
                    throw new IOException("暂存内容超过上限（>" + maxBytes + " 字节），拒绝读取");
                }
                buf.write(chunk, 0, n);
            }
            return buf.toByteArray();
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 读取阶段 close 失败不影响已读到的内容
            }
        }
    }

    private static boolean deleteQuietly(File f) {
        if (f == null) return false;
        try {
            return f.delete();
        } catch (Exception e) {
            return false;
        }
    }

    // ── 仅测试可见 ───────────────────────────────────────────────────────────

    boolean isIssued(String token) {
        return token != null && issued.containsKey(token);
    }

    int issuedCount() {
        return issued.size();
    }

    /** 模拟「进程重启后内存记录丢失，但磁盘文件仍在」 */
    void forgetIssuedForTest() {
        issued.clear();
        pending.clear();
    }

    long stagedLength(String token) throws IOException {
        return fileForToken(token).length();
    }

    File dirForTest() {
        return dir;
    }

    void writeLegacyForTest(String name, byte[] bytes) throws IOException {
        ensureDir();
        FileOutputStream out = new FileOutputStream(new File(dir, name));
        try {
            out.write(bytes);
        } finally {
            out.close();
        }
    }

    /** 测试用：把文件修改时间改成指定毫秒前（模拟过期） */
    void ageFileForTest(String name, long ageMs) {
        File f = new File(dir, name);
        if (f.isFile()) f.setLastModified(System.currentTimeMillis() - ageMs);
    }

    /** 测试用：把合法 token 文件追加字节（模拟 stage 后被放大） */
    void growFileForTest(String token, byte[] extra) throws IOException {
        File f = fileForToken(token);
        FileOutputStream out = new FileOutputStream(f, true);
        try {
            out.write(extra);
        } finally {
            out.close();
        }
    }
}
