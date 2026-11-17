package app.motion.personal.plugins;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * N01：Android 系统通知「点击正文打开/带回 MOTION」的**源码契约 + 纯策略**回归。
 *
 * <h2>这份测试证明什么 / 不证明什么</h2>
 * 证明（纯 JVM，无需 Android SDK / 设备）：
 * <ul>
 *   <li>持续「组间休息计时」通知的 buildNotification 真的接入了
 *       {@code setContentIntent}，且正文 Intent 是
 *       {@code PendingIntent.getActivity}（打开/带回 Activity），
 *       不是取消用的 Service Intent；</li>
 *   <li>正文点击来源是系统启动 Intent（{@code getLaunchIntentForPackage}，
 *       或用显式 MainActivity 兜底），且**不含** CLEAR_TASK / TaskStackBuilder
 *       之类会重建任务、丢失 WebView 状态的写法；</li>
 *   <li>「取消」action 独立保留：仍是 {@code ACTION_CANCEL_FROM_NOTIFICATION}
 *       的 Service PendingIntent，仍携带 token/generation（旧代次隔离不丢）；</li>
 *   <li>正文文案不再误指成「点此取消」（点击正文现在打开应用，取消是另一个按钮）；</li>
 *   <li>正文与取消的 PendingIntent requestCode 落在互不相交区间（纯策略常量）；</li>
 *   <li>「休息结束」到点通知（RestAlarmReceiver）原有的 setContentIntent 仍在。</li>
 * </ul>
 *
 * <p><b>证据边界</b>：这是对**生产源码结构的契约断言** + 纯策略常量断言；
 * 它不创建真实 PendingIntent、不启动真实 Activity、不覆盖真机点通知的启动行为。
 * 真机冷/热启动是否带回状态仍是 UNVERIFIED，不能由本测试冒充。
 *
 * <p>源码目录通过系统属性 {@code motion.plugin.dir} 传入（由 scripts/test-native.mjs 提供）。
 */
public final class RestNotificationNavTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws IOException {
        Path pluginDir = resolvePluginDir();
        // 只看**代码**：先去掉注释，避免把解释性 Javadoc 里的词当成实际用法
        String service = stripComments(read(pluginDir.resolve("RestCountdownService.java")));
        String receiver = stripComments(read(pluginDir.resolve("RestAlarmReceiver.java")));

        // ══ 纯策略：正文/取消 requestCode 不冲突 ═══════════════════════
        int cancelBase = RestForegroundPolicy.CANCEL_REQUEST_BASE;
        int contentBase = RestForegroundPolicy.CONTENT_REQUEST_BASE;
        check("正文 requestCode 基数与取消基数不同", contentBase != cancelBase);
        // 取消按钮 requestCode 区间为 [CANCEL_REQUEST_BASE, CANCEL_REQUEST_BASE+999]
        boolean contentInCancelRange =
            contentBase >= cancelBase && contentBase <= cancelBase + 999;
        check("正文 requestCode 不落在取消按钮区间内", !contentInCancelRange);
        check("正文 requestCode 稳定可复现",
            RestForegroundPolicy.contentRequestCode() == contentBase);
        check("正文 requestCode 为正",
            RestForegroundPolicy.contentRequestCode() > 0);

        // ══ 源码契约：持续通知 buildNotification 接入 Activity 打开入口 ══
        check("【N01】持续通知源码存在 buildNotification",
            service.contains("private Notification buildNotification("));
        check("【N01】buildNotification 调用了 setContentIntent（正文可点）",
            service.contains("setContentIntent("));
        check("【N01】正文 Intent 由 PendingIntent.getActivity 创建（打开 Activity，不是 Service）",
            service.contains("PendingIntent.getActivity("));
        check("【N01】正文来源是系统启动 Intent（getLaunchIntentForPackage）",
            service.contains("getLaunchIntentForPackage"));
        check("【N01】极端兜底显式指向 MainActivity（保证正文一定可打开应用）",
            service.contains("MainActivity.class"));
        check("【N01】未使用 CLEAR_TASK（不重建任务/不重置 WebView 状态）",
            !service.contains("CLEAR_TASK"));
        check("【N01】未使用 FLAG_ACTIVITY_CLEAR",
            !service.contains("FLAG_ACTIVITY_CLEAR"));
        check("【N01】未使用 TaskStackBuilder（不照搬会清空状态示例）",
            !service.contains("TaskStackBuilder"));

        // ══ 源码契约：取消 action 独立保留（token/generation 旧代次隔离）══
        check("【N01】取消 action 常量仍在", service.contains("ACTION_CANCEL_FROM_NOTIFICATION"));
        check("【N01】取消按钮仍通过 addAction 添加", service.contains(".addAction(0, \"取消\", cancelPi)"));
        check("【N01】取消 PendingIntent 仍由 getService 创建",
            service.contains("PendingIntent.getService("));
        check("【N01】取消 Intent 仍带 token", service.contains("cancel.putExtra(EXTRA_TOKEN, token)"));
        check("【N01】取消 Intent 仍带 generation",
            service.contains("cancel.putExtra(EXTRA_GENERATION, generation)"));
        check("【N01】正文 requestCode 取自 RestForegroundPolicy.contentRequestCode",
            service.contains("RestForegroundPolicy.contentRequestCode()"));

        // ══ 源码契约：正文文案不误指为取消 ═══════════════════════════
        check("【N01】正文文案不再写『点此取消』（避免误指取消动作）",
            !service.contains("点此取消"));

        // ══ 源码契约：到点通知（RestAlarmReceiver）原有打开入口保持 ══
        check("【N01】到点通知 setContentIntent 仍在（已有行为保持）",
            receiver.contains("setContentIntent("));
        check("【N01】到点通知仍用 getLaunchIntentForPackage 打开应用",
            receiver.contains("getLaunchIntentForPackage"));

        System.out.println();
        System.out.println("RestNotificationNavTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestNotificationNavTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestNotificationNavTest 全部通过");
    }

    private static Path resolvePluginDir() {
        String dir = System.getProperty("motion.plugin.dir");
        if (dir == null || dir.isEmpty()) {
            // 直接 java 运行且未传属性时，按约定从 user.dir 推断（app/ 或仓库根）
            Path p = Paths.get("android/app/src/main/java/app/motion/personal/plugins");
            if (Files.isDirectory(p)) return p;
            p = Paths.get("app/android/app/src/main/java/app/motion/personal/plugins");
            if (Files.isDirectory(p)) return p;
            throw new IllegalStateException(
                "未提供 -Dmotion.plugin.dir，且无法从当前目录推断插件源码目录");
        }
        return Paths.get(dir);
    }

    private static String read(Path p) throws IOException {
        if (!Files.isRegularFile(p)) {
            throw new IllegalStateException("找不到源码文件: " + p);
        }
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    /**
     * 去掉 Java 源码里的块注释与行注释，只保留代码（含字符串字面量）。
     * 目的：让『不得出现 CLEAR_TASK / TaskStackBuilder / 点此取消』这类断言
     * 只针对真实代码与字符串，不会被解释性注释误伤。
     */
    static String stripComments(String src) {
        StringBuilder out = new StringBuilder(src.length());
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            if (c == '"' || c == '\'') {
                // 原样拷贝字符串/字符字面量
                char quote = c;
                out.append(c);
                i++;
                while (i < n) {
                    char d = src.charAt(i);
                    out.append(d);
                    i++;
                    if (d == '\\' && i < n) {
                        out.append(src.charAt(i));
                        i++;
                    } else if (d == quote) {
                        break;
                    }
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                while (i < n && src.charAt(i) != '\n') i++;
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                i += 2;
                while (i + 1 < n && !(src.charAt(i) == '*' && src.charAt(i + 1) == '/')) i++;
                i += 2;
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  ✔ " + name);
        } else {
            fail++;
            System.out.println("  ✘ " + name);
        }
    }

    private RestNotificationNavTest() {}
}
