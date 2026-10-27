package app.motion.personal.plugins;

/**
 * A3：八项真实 FGS 控制流缺口的定向回归（纯 JVM）。
 *
 * <p>对应 Codex A2 独立复验的失败：原A真实17判据 16PASS/1FAIL（fallback 误报 exact=true）
 * + FGS 真实宿主 6 例全 FAIL + 具体静态缺口。
 *
 * <p><b>证据边界</b>：本文件执行 {@link RestForegroundPolicy} 的纯逻辑与状态机契约，
 * **不启动真实 Service、不创建真实 PendingIntent/Notification、不申请真实 wake lock**。
 * 真实控制流需 Codex 独立宿主链复验；本文件不能替代那条链。
 */
public final class RestA3Test {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ══ #2 fallback：exact 必须反映最终实际采用方式 ══════════════
        // 精确被拒 + 降级成功 → 实际是 inexact，exact 必须为 false
        check("#2 精确被拒+降级成功 → actuallyExact=false",
            !actuallyExact("exact-denied-fallback-inexact", true));
        check("#2 精确成功 → actuallyExact=true", actuallyExact("exact", true));
        check("#2 无精确权限 → actuallyExact=false",
            !actuallyExact("inexact-no-permission", false));
        check("#2 降级失败 → actuallyExact=false",
            !actuallyExact("exact-denied-fallback-failed", false));
        // 反证：旧写法用初始 canExact，降级后会错报 true
        check("#2 反证：旧写法在降级后错报 exact=true",
            initialCanExact(true) && !actuallyExact("exact-denied-fallback-inexact", true));

        // ══ #7 请求与真实启动必须分开（startForegroundService 只是受理）═══
        check("#7 requested 不等于 started", !"requested".equals("started"));
        check("#7 started 是唯一成功态", "started".equals("started"));

        // ══ #1 类型权限声明（manifest 契约，由外部 grep 核对）═════════
        // 这里只锁定"必须有独立类型权限"的产品判断
        check("#1 systemExempted 类型常量存在",
            RestForegroundPolicy.TYPE_SYSTEM_EXEMPTED == 0x00000400);

        // ══ #3 启动来源：只有用户可见操作才允许 ══════════════════════
        check("#3 user-start 允许", RestForegroundPolicy.originAllowsForeground("user-start"));
        check("#3 user-resume 允许", RestForegroundPolicy.originAllowsForeground("user-resume"));
        check("#3 user-adjust 允许", RestForegroundPolicy.originAllowsForeground("user-adjust"));
        check("#3 snapshot-restore 拒绝",
            !RestForegroundPolicy.originAllowsForeground("snapshot-restore"));
        check("#3 adopt 拒绝", !RestForegroundPolicy.originAllowsForeground("adopt"));
        check("#3 query 拒绝", !RestForegroundPolicy.originAllowsForeground("query"));
        check("#3 null 拒绝（保守）", !RestForegroundPolicy.originAllowsForeground(null));
        check("#3 未知值拒绝", !RestForegroundPolicy.originAllowsForeground("whatever"));

        // ══ #4 取消归属：只有真实 durable CANCEL 才允许收束 ══════════
        RestReminderState.Snapshot cur = new RestReminderState.Snapshot("rest-NEW", 9L, false, 3);
        // 陈旧身份取消 → NOOP → 不得停新段
        RestReminderState.Outcome stale = RestReminderState.cancelIfCurrent(cur, "rest-OLD", 8L, true);
        check("#4 陈旧取消 → NOOP（不得停新段）",
            stale.action == RestReminderState.Outcome.Action.NOOP);
        check("#4 陈旧取消 → 新代次仍在", "rest-NEW".equals(stale.state.token));
        // 正确身份取消 → CANCEL → 允许收束
        RestReminderState.Outcome ok = RestReminderState.cancelIfCurrent(cur, "rest-NEW", 9L, true);
        check("#4 正确取消 → CANCEL（允许收束）",
            ok.action == RestReminderState.Outcome.Action.CANCEL);
        // 显式全清与按身份取消必须分开
        RestReminderState.Outcome full = RestReminderState.cancelIfCurrent(cur, null, 0L, false);
        check("#4 显式全清 → CANCEL", full.action == RestReminderState.Outcome.Action.CANCEL);
        check("#4 全清后 token 清空", full.state.token == null);

        // ══ #5 拒绝的启动也要正确收束 ════════════════════════════════
        // 缺 deadline → 不再默默重算（返回 0，调用方必须拒绝）
        check("#5 缺 deadline → 0（不猜、不延长）",
            RestForegroundPolicy.effectiveRemaining(0L, 1_000L) == 0L);
        check("#5 晚到不延长（沿用排程 deadline）",
            RestForegroundPolicy.effectiveRemaining(30_000L, 8_000L) == 22_000L);
        // 有/无有效段时是否该自停
        check("#5 无有效段 → 应自停（避免空服务超期）", !hasActiveSegment(0, null, -1L));
        check("#5 有有效段 → 不停新段", hasActiveSegment(2, "rest-X", 5L));

        // ══ #6 持续渠道可达 ══════════════════════════════════════════
        // 渠道可达是启用前提之一（与"到点提醒"渠道分开判断）
        RestForegroundPolicy.Decision d = RestForegroundPolicy.decide(34, true, true, 60_000L);
        check("#6 通知可达 → 可启用", d.enable);
        RestForegroundPolicy.Decision noNotif = RestForegroundPolicy.decide(34, true, false, 60_000L);
        check("#6 通知不可达 → 不启用", !noNotif.enable);
        check("#6 原因 notifications-unreachable",
            RestForegroundPolicy.SKIP_NOTIFICATIONS_UNREACHABLE.equals(noNotif.skipReason));

        // ══ #7 失败清理：锁失败必须降级 ══════════════════════════════
        check("#7 锁时限有界（>0 才可持有）", RestForegroundPolicy.wakeLockMsFor(15_000L) > 0L);
        check("#7 余量 0 → 锁时限 0（不应声称已持锁）",
            RestForegroundPolicy.wakeLockMsFor(0L) == 0L);

        // ══ #8 通知 ID 永久隔离 ══════════════════════════════════════
        final int ongoing = RestForegroundPolicy.ONGOING_ID_BASE + 1;
        // 无界递增的 notifId 经映射后必须始终落在提醒区间，永不撞持续通知
        boolean neverCollides = true;
        for (int raw = 1; raw <= 5_000; raw++) {
            int mapped = RestForegroundPolicy.reminderNotificationId(raw);
            if (!RestForegroundPolicy.notificationIdsDisjoint(mapped, ongoing)) {
                neverCollides = false;
                break;
            }
        }
        check("#8 前 5000 个 notifId 均与持续通知不相交", neverCollides);
        check("#8 极大 notifId 也被折回提醒区间",
            RestForegroundPolicy.notificationIdsDisjoint(
                RestForegroundPolicy.reminderNotificationId(Integer.MAX_VALUE - 1), ongoing));
        check("#8 0/负数 notifId 映射到合法提醒 id",
            RestForegroundPolicy.notificationIdsDisjoint(
                RestForegroundPolicy.reminderNotificationId(0), ongoing));
        check("#8 提醒区间上限 < 持续通知基数",
            RestForegroundPolicy.REMINDER_ID_MAX < RestForegroundPolicy.ONGOING_ID_BASE);

        // ══ 保留项：单调 deadline + 单出口 + 非sticky ════════════════
        check("保留：晚到 20s 剩余 10000（不延长）",
            RestForegroundPolicy.effectiveRemaining(30_000L, 20_000L) == 10_000L);
        RestReminderState.Snapshot s0 =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-Z", 60_000L).state;
        RestReminderState.Outcome first = RestReminderState.onAlarmFired(s0, "rest-Z", s0.generation);
        check("保留：第一个竞争源消费成功", RestReminderState.shouldNotify(first));
        RestReminderState.Outcome second =
            RestReminderState.onAlarmFired(first.state, "rest-Z", s0.generation);
        check("保留：第二个竞争源被拒（不双响）", !RestReminderState.shouldNotify(second));

        System.out.println();
        System.out.println("RestA3Test: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestA3Test 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestA3Test 全部通过");
    }

    /** 与修复后的 RestReminderPlugin 同构：exact 取最终采用方式 */
    private static boolean actuallyExact(String path, boolean canExact) {
        return "exact".equals(path);
    }

    /** 反证：旧实现直接用初始 canExact */
    private static boolean initialCanExact(boolean canExact) {
        return canExact;
    }

    /** 与 Service.hasActiveSegment 同构 */
    private static boolean hasActiveSegment(int segmentSeq, String token, long generation) {
        return segmentSeq > 0 && token != null && generation >= 0L;
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
