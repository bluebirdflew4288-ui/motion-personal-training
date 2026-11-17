package app.motion.personal.plugins;

/**
 * 当前段前台计时服务的**纯决策逻辑**（纯 JVM，可离线测试）。
 *
 * <p>把"要不要启用增强""锁该持多久""该用哪个 FGS 类型"从 Android API 里剥出来，
 * 让宿主测试能真实覆盖这些判断，而不是在报告里手写结论。
 *
 * <h2>边界（A2 裁决）</h2>
 * <ul>
 *   <li>只在**用户从可见 Activity 操作**休息开始/恢复/加时时启用；</li>
 *   <li>API 34+ 仅当**实际持有精确闹钟授权**且**通知可达**时用 systemExempted；</li>
 *   <li>不满足 → 不启用增强，保留既有 AlarmManager 路径（准确降级）；</li>
 *   <li>不使用 shortService（约 3 分钟、非 sticky，覆盖不了 180 秒再加时）；</li>
 *   <li>不通过 specialUse 绕资格、不申请电池豁免。</li>
 * </ul>
 *
 * <p><b>systemExempted 不是 Doze 豁免</b>：它只让服务在类型上合法，
 * 深 Doze 仍可能限制，本类不承诺准点。
 */
public final class RestForegroundPolicy {

    /** 增强未启用的原因（也是诊断 detail，保持稳定字符串） */
    public static final String SKIP_API_TOO_LOW = "api-too-low";
    public static final String SKIP_NO_EXACT_PERMISSION = "no-exact-permission";
    public static final String SKIP_NOTIFICATIONS_UNREACHABLE = "notifications-unreachable";
    public static final String SKIP_INVALID_REMAINING = "invalid-remaining";

    /** 决策结果 */
    public static final class Decision {
        public final boolean enable;
        /** 未启用原因；启用时为 null */
        public final String skipReason;
        /** 建议持有的 wake lock 毫秒（仅 enable 时有意义） */
        public final long wakeLockMs;

        private Decision(boolean enable, String skipReason, long wakeLockMs) {
            this.enable = enable;
            this.skipReason = skipReason;
            this.wakeLockMs = wakeLockMs;
        }

        static Decision skip(String reason) {
            return new Decision(false, reason, 0L);
        }

        static Decision enable(long wakeLockMs) {
            return new Decision(true, null, wakeLockMs);
        }
    }

    /**
     * 收尾窗口：锁在剩余时间之外只多覆盖这么久，用于到期回调与停服务的极小余量。
     * 刻意取小值，避免"锁比休息还长"的隐性能耗。
     */
    public static final long TAIL_MS = 3_000L;

    /** 单次锁的硬上限（防止异常输入导致超长持锁） */
    public static final long MAX_WAKE_LOCK_MS = RestArgs.MAX_REMAINING_MS + TAIL_MS;

    /**
     * 是否应启用当前段增强。
     *
     * @param sdkInt                Build.VERSION.SDK_INT
     * @param exactAlarmsGranted    AlarmManager.canScheduleExactAlarms()（<S 恒为 true）
     * @param notificationsReachable 通知权限 + 总开关 + 渠道 全部可达
     * @param remainingMs           当前剩余毫秒
     */
    public static Decision decide(
        int sdkInt,
        boolean exactAlarmsGranted,
        boolean notificationsReachable,
        long remainingMs
    ) {
        if (remainingMs <= 0L || remainingMs > RestArgs.MAX_REMAINING_MS) {
            return Decision.skip(SKIP_INVALID_REMAINING);
        }
        // API 34 以下没有 FGS 类型强制；本产品仍只在 26+ 提供通知渠道。
        if (sdkInt < 26) return Decision.skip(SKIP_API_TOO_LOW);
        /**
         * systemExempted 的资格条件是**实际持有精确闹钟授权**。
         * 没有资格就不能用该类型（强行 startForeground 会抛类型不允许），
         * 此时如实不启用增强，保留 AlarmManager 路径。
         * 注意：API < 31 没有该权限概念，canScheduleExactAlarms 恒视为 true。
         */
        if (sdkInt >= 31 && !exactAlarmsGranted) {
            return Decision.skip(SKIP_NO_EXACT_PERMISSION);
        }
        /**
         * 通知不可达时 FGS 通知只在 Task Manager 可见，用户看不到倒计时，
         * 也就失去了"可见后台计时"的产品意义 → 不启用。
         */
        if (!notificationsReachable) {
            return Decision.skip(SKIP_NOTIFICATIONS_UNREACHABLE);
        }
        return Decision.enable(wakeLockMsFor(remainingMs));
    }

    /**
     * 有界锁时限 = 当前余量 + 极小收尾窗口，并夹到硬上限。
     *
     * <p>加时/更新时**按新的剩余重新计算**（延展），不是累加，避免无限延长。
     */
    public static long wakeLockMsFor(long remainingMs) {
        if (remainingMs <= 0L) return 0L;
        long total = remainingMs + TAIL_MS;
        return Math.min(total, MAX_WAKE_LOCK_MS);
    }

    /**
     * API 34+ 的 FGS 类型常量。
     *
     * <p>用**字面值**而不是 {@code ServiceInfo.FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED}，
     * 是为了让纯 JVM 测试能在没有 android.jar 的宿主里执行本类；
     * 数值取自官方 ServiceInfo（API 34 新增）。manifest 里用的是 XML 名称，
     * 二者必须一致，见 RestCountdownService。
     */
    public static final int TYPE_SYSTEM_EXEMPTED = 0x00000400;

    /**
     * 倒计时格式化（服务持续通知显示用）。
     *
     * <p>放在纯 JVM 类里而不是 Service 里，是为了让宿主测试能真实执行它
     * （Service 依赖 Android API，无法在纯 JVM 中编译运行）。
     */
    public static String fmtCountdown(long ms) {
        long total = Math.max(0L, ms) / 1000L;
        long m = total / 60L;
        long s = total % 60L;
        return String.format(java.util.Locale.US, "%02d:%02d", m, s);
    }

    /**
     * 由"排程入口定死的单调截止"换算**当前真实剩余**（补充验收 #1）。
     *
     * <p>这是本批最关键的一条边界：服务收到 start 的时间可能比排程时刻晚
     * （系统排队、冷启动、后台限制重试）。旧实现用"接收时刻 + 原 remainingMs"
     * 重算，等于把休息**越推越晚**。
     *
     * @param deadlineElapsed 排程入口一次确定的 elapsedRealtime 截止
     * @param nowElapsed      当前 elapsedRealtime
     * @return 真实剩余毫秒；已过期返回 0（调用方应直接走到期消费，不再起服务）
     */
    public static long effectiveRemaining(long deadlineElapsed, long nowElapsed) {
        if (deadlineElapsed <= 0L) return 0L;
        return Math.max(0L, deadlineElapsed - nowElapsed);
    }

    /**
     * 取消按钮的 requestCode 必须随代次变化（补充验收 #2）。
     *
     * <p>固定 requestCode + FLAG_UPDATE_CURRENT 会让新代次改写旧句柄的 extras，
     * 使通知栏里那条"旧"取消按钮携带新身份 —— 点它就会误清新代次。
     * `FLAG_IMMUTABLE` 只约束**外部应用**，不阻止创建者自己更新。
     */
    public static int cancelRequestCode(long generation) {
        long g = generation < 0L ? 0L : generation;
        return CANCEL_REQUEST_BASE + (int) (g % 1000L);
    }

    /** 与 Service 内的请求码基数保持一致 */
    public static final int CANCEL_REQUEST_BASE = 5200;

    /**
     * 持续通知“正文点击打开/带回应用”的 Activity requestCode 基数（N01）。
     *
     * <p>与取消按钮的 requestCode（{@link #CANCEL_REQUEST_BASE} 起、随代次变化、
     * 覆盖 [5200, 6199]）落在**互不相交**的区间。取消是 {@code getService} 的
     * Service PendingIntent，正文是 {@code getActivity} 的 Activity PendingIntent，
     * 本就不同组件；这里再用独立基数，语义清晰且避免任何意外覆盖。
     *
     * <p>正文只负责打开应用、不携带代次身份，因此 requestCode 固定，不随 generation 变化。
     */
    public static final int CONTENT_REQUEST_BASE = 7300;

    /** 持续通知正文的 Activity requestCode（固定） */
    public static int contentRequestCode() {
        return CONTENT_REQUEST_BASE;
    }

    /**
     * 收尾时是否允许真正停止服务（补充验收 #3）。
     *
     * @param stopForSegment 触发收尾的段标记；-1 表示无条件（用户明确意图）
     * @param currentSegment 当前有效段标记
     * @return true 表示属于当前段，可以停；false 表示旧段的迟到收尾，必须忽略
     */
    public static boolean mayStopSegment(int stopForSegment, int currentSegment) {
        return stopForSegment < 0 || stopForSegment == currentSegment;
    }

    /**
     * 通知 id 的**永久隔离区间**（A3 #8）。
     *
     * <p>旧方案的"起点错开"不足：持续通知固定 4210，而
     * {@link RestReminderState} 的 notifId 是**无界递增**的，最终必然撞上。
     * 一旦撞上，`stopForeground(STOP_FOREGROUND_REMOVE)` 就会把刚发出的
     * "休息结束"通知一起删掉。
     *
     * <p>方案：把两类 id 放进**互不相交的区间**，并由分配函数显式跳过。
     * <ul>
     *   <li>到期提醒（状态机分配）：1 … {@link #REMINDER_ID_MAX}</li>
     *   <li>持续计时通知：{@link #ONGOING_ID_BASE} 起（远大于提醒区间）</li>
     * </ul>
     */
    public static final int REMINDER_ID_MAX = 100_000;
    /** 持续计时通知 id 基数（与提醒区间永久不相交） */
    public static final int ONGOING_ID_BASE = 1_000_000;

    /**
     * 把状态机给出的 notifId 映射为**到期提醒通知 id**，保证落在提醒区间内。
     *
     * <p>用取模把无界递增折回区间，且**跳过**持续通知区间。
     */
    public static int reminderNotificationId(int rawNotifId) {
        if (rawNotifId <= 0) return 1;
        return (rawNotifId % REMINDER_ID_MAX) + 1;
    }

    /**
     * 判断两个通知 id 是否可能互相覆盖（用于边界断言与诊断）。
     */
    public static boolean notificationIdsDisjoint(int reminderId, int ongoingId) {
        return reminderId >= 1 && reminderId <= REMINDER_ID_MAX
            && ongoingId >= ONGOING_ID_BASE;
    }

    // ── A3 #3：启动来源必须区分"用户可见操作"与"自动恢复" ──────────
    /** 用户在可见界面上主动开始休息 */
    public static final String ORIGIN_USER_START = "user-start";
    /** 用户在可见界面上点继续 */
    public static final String ORIGIN_USER_RESUME = "user-resume";
    /** 用户在可见界面上加时（正调整） */
    public static final String ORIGIN_USER_ADJUST = "user-adjust";
    /** 页面重建后按快照自动恢复 —— **不得**授予 FGS 启动许可 */
    public static final String ORIGIN_SNAPSHOT_RESTORE = "snapshot-restore";
    /** adopt / 接管已有原生提醒 —— 不得授予启动许可 */
    public static final String ORIGIN_ADOPT = "adopt";
    /** focus / getActive 等只读核对 —— 不得授予启动许可 */
    public static final String ORIGIN_QUERY = "query";

    /**
     * 该来源是否**允许**启动/更新当前段前台增强（A3 #3）。
     *
     * <p>排程成功 ≠ 此刻有用户在看着屏幕操作。自动恢复、adopt、focus 查询
     * 都可能间接走到 schedule，但它们**不是**用户可见操作，
     * 不能借此偷偷拉起前台服务。
     */
    public static boolean originAllowsForeground(String origin) {
        if (origin == null) return false;
        return ORIGIN_USER_START.equals(origin)
            || ORIGIN_USER_RESUME.equals(origin)
            || ORIGIN_USER_ADJUST.equals(origin);
    }

    /** 该 SDK 是否需要显式类型（API 34+ 必须） */
    public static boolean requiresExplicitType(int sdkInt) {
        return sdkInt >= 34;
    }

    private RestForegroundPolicy() {}
}
