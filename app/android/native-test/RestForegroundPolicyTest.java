package app.motion.personal.plugins;

/**
 * A2：当前段前台增强的**纯决策逻辑**测试（纯 JVM，不触碰 Android API）。
 *
 * <p>覆盖 A2 裁决的关键条件：
 * <ul>
 *   <li>API 34+ 只在**实际持有精确闹钟授权**且**通知可达**时才启用；</li>
 *   <li>无资格/通知不可达 → 明确不启用并给出稳定原因（保留 AlarmManager 路径）；</li>
 *   <li>wake lock 有界：= 余量 + 小收尾窗口，且有硬上限；</li>
 *   <li>API 34+ 需要显式类型，34 以下不需要。</li>
 * </ul>
 *
 * <p><b>证据边界</b>：本测试不启动真实 Service、不申请 wake lock、不调用
 * startForeground。Android 实际能否进入前台、systemExempted 是否被系统接受，
 * 仍需真机/Android 运行时验证 —— 本轮未做。
 */
public final class RestForegroundPolicyTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ── API 34+：资格齐全才启用 ─────────────────────────────
        RestForegroundPolicy.Decision ok34 = RestForegroundPolicy.decide(34, true, true, 180_000L);
        check("API34 有精确授权+通知可达 → 启用", ok34.enable);
        check("API34 启用时无 skip 原因", ok34.skipReason == null);
        check("API34 锁时限 = 余量+收尾窗口",
            ok34.wakeLockMs == 180_000L + RestForegroundPolicy.TAIL_MS);

        // ── API 34+：无精确授权 → 不启用（systemExempted 无资格）──
        RestForegroundPolicy.Decision noExact = RestForegroundPolicy.decide(34, false, true, 180_000L);
        check("API34 无精确授权 → 不启用", !noExact.enable);
        check("API34 无精确授权 → 原因 no-exact-permission",
            RestForegroundPolicy.SKIP_NO_EXACT_PERMISSION.equals(noExact.skipReason));
        check("API34 无精确授权 → 不持锁", noExact.wakeLockMs == 0L);

        // ── 通知不可达 → 不启用（用户看不到可见计时）─────────────
        RestForegroundPolicy.Decision noNotif = RestForegroundPolicy.decide(34, true, false, 60_000L);
        check("通知不可达 → 不启用", !noNotif.enable);
        check("通知不可达 → 原因 notifications-unreachable",
            RestForegroundPolicy.SKIP_NOTIFICATIONS_UNREACHABLE.equals(noNotif.skipReason));

        // ── 旧系统：API<31 无精确权限概念，按通知可达判断 ────────
        RestForegroundPolicy.Decision api26 = RestForegroundPolicy.decide(26, false, true, 60_000L);
        check("API26 不因“无精确授权”被拦（该版本无此概念）", api26.enable);
        RestForegroundPolicy.Decision api25 = RestForegroundPolicy.decide(25, true, true, 60_000L);
        check("API25 → 不启用（无通知渠道支持）", !api25.enable);
        check("API25 → 原因 api-too-low",
            RestForegroundPolicy.SKIP_API_TOO_LOW.equals(api25.skipReason));

        // ── 非法余量 → 不启用，绝不持锁 ─────────────────────────
        check("余量 0 → 不启用", !RestForegroundPolicy.decide(34, true, true, 0L).enable);
        check("余量负数 → 不启用", !RestForegroundPolicy.decide(34, true, true, -5L).enable);
        check("余量超上限 → 不启用",
            !RestForegroundPolicy.decide(34, true, true, RestArgs.MAX_REMAINING_MS + 1L).enable);

        // ── 锁时限有界（硬上限，防异常超长持锁）───────────────────
        long capped = RestForegroundPolicy.wakeLockMsFor(RestArgs.MAX_REMAINING_MS);
        check("锁时限不超过硬上限", capped <= RestForegroundPolicy.MAX_WAKE_LOCK_MS);
        check("锁时限=0 当余量<=0", RestForegroundPolicy.wakeLockMsFor(0L) == 0L);
        check("加时延展：更长余量得到更长锁",
            RestForegroundPolicy.wakeLockMsFor(200_000L)
                > RestForegroundPolicy.wakeLockMsFor(100_000L));
        check("加时不是累加（不会无限增长）",
            RestForegroundPolicy.wakeLockMsFor(100_000L)
                == 100_000L + RestForegroundPolicy.TAIL_MS);

        // ── FGS 类型：34+ 必须显式，以下不需要 ───────────────────
        check("API34 需要显式类型", RestForegroundPolicy.requiresExplicitType(34));
        check("API35 需要显式类型", RestForegroundPolicy.requiresExplicitType(35));
        check("API33 不需要显式类型", !RestForegroundPolicy.requiresExplicitType(33));
        check("API26 不需要显式类型", !RestForegroundPolicy.requiresExplicitType(26));
        // 数值必须与官方 ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED 一致
        check("systemExempted 常量 = 0x400",
            RestForegroundPolicy.TYPE_SYSTEM_EXEMPTED == 0x00000400);

        // ── 倒计时格式化（服务通知用）────────────────────────────
        check("格式化 180000ms = 03:00", "03:00".equals(RestForegroundPolicy.fmtCountdown(180_000L)));
        check("格式化 15000ms = 00:15", "00:15".equals(RestForegroundPolicy.fmtCountdown(15_000L)));
        check("格式化 0ms = 00:00", "00:00".equals(RestForegroundPolicy.fmtCountdown(0L)));
        check("格式化负数夹 0", "00:00".equals(RestForegroundPolicy.fmtCountdown(-1_000L)));

        System.out.println();
        System.out.println("RestForegroundPolicyTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestForegroundPolicyTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestForegroundPolicyTest 全部通过");
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
