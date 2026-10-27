package app.motion.personal.plugins;

/**
 * B3：系统设置跳转**受限目标契约**测试（纯 JVM）。
 *
 * <p>验证安全关键判定：只接受三个对外目标、未知 fail closed、
 * 内部兜底不对外、fallback 顺序正确。
 *
 * <p><b>证据边界</b>：本测试不构造真实 Android Intent、不调用 startActivity、
 * 不验证系统页面可达性。Intent action/extras 与真机页面由 Codex 独立链/真机验证。
 */
public final class RestSettingsNavTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ── 三个对外目标可解析 ───────────────────────────────────
        check("app-notifications 可解析",
            RestSettingsTargets.fromWire("app-notifications") == RestSettingsTargets.Target.APP_NOTIFICATIONS);
        check("rest-channel 可解析",
            RestSettingsTargets.fromWire("rest-channel") == RestSettingsTargets.Target.REST_CHANNEL);
        check("exact-alarm 可解析",
            RestSettingsTargets.fromWire("exact-alarm") == RestSettingsTargets.Target.EXACT_ALARM);

        // ── fail closed ─────────────────────────────────────────
        check("null → null", RestSettingsTargets.fromWire(null) == null);
        check("空串 → null", RestSettingsTargets.fromWire("") == null);
        check("未知目标 → null", RestSettingsTargets.fromWire("settings") == null);
        check("任意 action 形态 → null",
            RestSettingsTargets.fromWire("android.settings.APPLICATION_DETAILS_SETTINGS") == null);
        check("任意 URI 形态 → null",
            RestSettingsTargets.fromWire("package:com.evil") == null);
        check("任意 package 形态 → null",
            RestSettingsTargets.fromWire("com.evil.app") == null);

        /**
         * 关键：内部兜底目标**不得**由外部直接请求，
         * 否则可绕过"先目标再兜底"的顺序直跳详情页。
         */
        check("内部兜底 app-details 不被接受",
            RestSettingsTargets.fromWire("app-details") == null);

        // ── 枚举结构 ────────────────────────────────────────────
        check("枚举共 4 项（3 对外 + 1 内部）",
            RestSettingsTargets.Target.values().length == 4);
        java.util.Set<String> wires = new java.util.HashSet<>();
        for (RestSettingsTargets.Target t : RestSettingsTargets.Target.values()) wires.add(t.wire);
        check("wire 值互不重复", wires.size() == 4);

        // ── fallback 链顺序 ─────────────────────────────────────
        RestSettingsTargets.Target[] c1 =
            RestSettingsTargets.fallbackChain(RestSettingsTargets.Target.EXACT_ALARM);
        check("精确闹钟链：目标 → 通知页 → 详情页", c1.length == 3
            && c1[0] == RestSettingsTargets.Target.EXACT_ALARM
            && c1[1] == RestSettingsTargets.Target.APP_NOTIFICATIONS
            && c1[2] == RestSettingsTargets.Target.DETAILS_FALLBACK);

        RestSettingsTargets.Target[] c2 =
            RestSettingsTargets.fallbackChain(RestSettingsTargets.Target.REST_CHANNEL);
        check("渠道链：目标 → 通知页 → 详情页", c2.length == 3
            && c2[0] == RestSettingsTargets.Target.REST_CHANNEL
            && c2[2] == RestSettingsTargets.Target.DETAILS_FALLBACK);

        RestSettingsTargets.Target[] c3 =
            RestSettingsTargets.fallbackChain(RestSettingsTargets.Target.APP_NOTIFICATIONS);
        check("通知页链：通知页 → 详情页（不重复自身）", c3.length == 2
            && c3[0] == RestSettingsTargets.Target.APP_NOTIFICATIONS
            && c3[1] == RestSettingsTargets.Target.DETAILS_FALLBACK);

        RestSettingsTargets.Target[] c4 =
            RestSettingsTargets.fallbackChain(RestSettingsTargets.Target.DETAILS_FALLBACK);
        check("详情页链：仅自身", c4.length == 1
            && c4[0] == RestSettingsTargets.Target.DETAILS_FALLBACK);

        // ── 每条链都以详情页兜底 ────────────────────────────────
        boolean allEndWithFallback = true;
        for (RestSettingsTargets.Target t : RestSettingsTargets.Target.values()) {
            RestSettingsTargets.Target[] chain = RestSettingsTargets.fallbackChain(t);
            if (chain[chain.length - 1] != RestSettingsTargets.Target.DETAILS_FALLBACK) {
                allEndWithFallback = false;
            }
        }
        check("每条 fallback 链都以详情页兜底", allEndWithFallback);

        System.out.println();
        System.out.println("RestSettingsNavTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestSettingsNavTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestSettingsNavTest 全部通过");
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
}
