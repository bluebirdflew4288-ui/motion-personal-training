package app.motion.personal.plugins;

/**
 * A2 补充验收边界（4 项）的定向回归 —— 纯 JVM，不触碰 Android API。
 *
 * <p>对应 root 补充的验收边界，不是对已交付源码的失败判定，而是把这些
 * **容易写错且后果严重**的时序/身份边界用可执行断言固定下来：
 * <ol>
 *   <li>服务收到 start 较晚时不得延长休息：必须沿用排程入口定死的单调 deadline；</li>
 *   <li>旧持续通知的取消 PendingIntent 必须保留自己的 token/generation，
 *       避免旧按钮误清新代次；</li>
 *   <li>旧 startId/超时/清理不得停止新段；消费+通知只经一个出口；</li>
 *   <li>持续计时通知用独立 ID，收尾 stopForeground 不得删除到期通知。</li>
 * </ol>
 *
 * <p><b>证据边界</b>：本文件执行的是 {@link RestForegroundPolicy} 的纯逻辑，
 * 不启动真实 Service、不创建真实 PendingIntent、不调用 stopForeground。
 * Android 实际时序仍需真机/独立链验证。
 */
public final class RestA2BoundaryTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ══ 边界 #1：晚到不得延长休息 ══════════════════════════════
        // 排程入口在 T=0 定死 deadline = 0 + 30000 = 30000
        final long deadline = 30_000L;

        // 情况 A：服务准时收到（T=0）→ 真实剩余 30000
        check("准时收到：剩余=原剩余", RestForegroundPolicy.effectiveRemaining(deadline, 0L) == 30_000L);
        // 情况 B：服务晚到 8 秒（T=8000）→ 剩余必须变 22000，**不是** 30000
        check("晚到 8s：剩余=22000（不延长）",
            RestForegroundPolicy.effectiveRemaining(deadline, 8_000L) == 22_000L);
        check("晚到 8s：不等于原剩余（旧 bug 会得到 30000）",
            RestForegroundPolicy.effectiveRemaining(deadline, 8_000L) != 30_000L);
        // 情况 C：晚到 20 秒 → 剩余 10000
        check("晚到 20s：剩余=10000",
            RestForegroundPolicy.effectiveRemaining(deadline, 20_000L) == 10_000L);
        // 情况 D：已经过期 → 0（调用方应直接走到期消费，不再起服务）
        check("已过期：剩余=0", RestForegroundPolicy.effectiveRemaining(deadline, 30_000L) == 0L);
        check("已过期更多：仍夹到 0", RestForegroundPolicy.effectiveRemaining(deadline, 99_000L) == 0L);
        // 情况 E：没有 deadline（旧调用形态）→ 0，调用方必须自行降级并记录
        check("缺 deadline：返回 0（不猜）", RestForegroundPolicy.effectiveRemaining(0L, 5_000L) == 0L);
        check("负 deadline：返回 0", RestForegroundPolicy.effectiveRemaining(-1L, 5_000L) == 0L);

        /**
         * 反证：若按"接收时刻 + 原剩余"（旧写法），晚到 8s 会算出 8000+30000=38000，
         * 而正确剩余只有 22000 —— 差 16000ms（= 原剩余 30000 被整体重加了一遍，
         * 其中 8000 是迟到时间、另外 8000 是"本该已过去却没过去"的重复计算）。
         * 关键点：旧写法得到的剩余 **大于** 原剩余，即休息被延长。
         */
        long oldBuggy = 8_000L + 30_000L;
        check("反证：旧写法会算出 38000", oldBuggy == 38_000L);
        check("反证：旧写法剩余 > 原剩余（休息被延长）", oldBuggy > 30_000L);
        check("反证：新写法剩余 <= 原剩余（不延长）",
            RestForegroundPolicy.effectiveRemaining(deadline, 8_000L) <= 30_000L);
        check("反证：两者相差 16000ms", oldBuggy
            - RestForegroundPolicy.effectiveRemaining(deadline, 8_000L) == 16_000L);

        // ══ 边界 #2：取消按钮身份随代次变化 ════════════════════════
        int rcGen1 = RestForegroundPolicy.cancelRequestCode(1L);
        int rcGen2 = RestForegroundPolicy.cancelRequestCode(2L);
        int rcGen3 = RestForegroundPolicy.cancelRequestCode(3L);
        check("代次不同 → requestCode 不同（旧句柄不被覆盖）", rcGen1 != rcGen2);
        check("代次 2/3 也不同", rcGen2 != rcGen3);
        check("requestCode 与代次一致可复现",
            rcGen1 == RestForegroundPolicy.cancelRequestCode(1L));
        check("requestCode 以基数为起点", rcGen1 == RestForegroundPolicy.CANCEL_REQUEST_BASE + 1);
        // 负数/0 代次不得产生非法 requestCode
        check("代次 0 合法", RestForegroundPolicy.cancelRequestCode(0L) == RestForegroundPolicy.CANCEL_REQUEST_BASE);
        check("负代次夹到 0", RestForegroundPolicy.cancelRequestCode(-5L) == RestForegroundPolicy.CANCEL_REQUEST_BASE);
        // 同一代次重复调用必须稳定（否则 PendingIntent 会不断新建）
        check("同代次稳定", RestForegroundPolicy.cancelRequestCode(7L) == RestForegroundPolicy.cancelRequestCode(7L));
        // 陈旧身份取消被状态机拒绝 → 不会误清新代次
        RestReminderState.Snapshot current = new RestReminderState.Snapshot("rest-NEW", 9L, false, 3);
        RestReminderState.Outcome staleCancel =
            RestReminderState.cancelIfCurrent(current, "rest-OLD", 8L, true);
        check("【边界#2】旧代次按钮点击 → NOOP（不清新代次）",
            staleCancel.action == RestReminderState.Outcome.Action.NOOP);
        check("【边界#2】新代次仍在", "rest-NEW".equals(staleCancel.state.token));
        RestReminderState.Outcome newCancel =
            RestReminderState.cancelIfCurrent(current, "rest-NEW", 9L, true);
        check("【边界#2】新代次按钮点击 → 真取消",
            newCancel.action == RestReminderState.Outcome.Action.CANCEL);

        // ══ 边界 #3：旧段收尾不得停新段 ════════════════════════════
        check("旧段(1) vs 当前(2) → 不得停", !RestForegroundPolicy.mayStopSegment(1, 2));
        check("当前段(2) vs 当前(2) → 可以停", RestForegroundPolicy.mayStopSegment(2, 2));
        check("无条件(-1) → 可以停", RestForegroundPolicy.mayStopSegment(-1, 5));
        check("旧段(0) vs 当前(1) → 不得停", !RestForegroundPolicy.mayStopSegment(0, 1));
        // 场景推演：段 1 的到期回调在新段 2 生效后到达
        int currentSegment = 2;
        check("【边界#3】段1迟到到期不影响段2", !RestForegroundPolicy.mayStopSegment(1, currentSegment));
        check("【边界#3】段2自己到期正常收尾", RestForegroundPolicy.mayStopSegment(2, currentSegment));

        // ══ 边界 #4：独立通知 ID（收尾不删到期通知）════════════════
        /**
         * 持续计时通知 id 固定为 4210；到期提醒用排程分配的 notifId（递增）。
         * 二者必须不同，否则 stopForeground(REMOVE) 会把刚发的到期通知一起删掉。
         */
        final int ongoingId = 4210;
        /**
         * 请求码基数 4200 与持续通知 id 4210 取自生产源码的字面值
         * （RestReminderPlugin.REQUEST_CODE_BASE / RestCountdownService.NOTIFICATION_ID）。
         * 这里不引用那两个类：它们依赖 Android API，纯 JVM 无法加载。
         * 若生产改了这两个常量，本断言需要同步 —— 这是刻意的显式契约。
         */
        final int requestCodeBase = 4200;
        check("【边界#4】持续通知 id 与请求码基数错开", ongoingId != requestCodeBase);
        check("【边界#4】持续通知 id 与取消按钮请求码错开",
            ongoingId != RestForegroundPolicy.cancelRequestCode(1L));
        // 到期通知 id 由状态机递增分配，从 1 开始，远小于 4210
        RestReminderState.Outcome first =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60_000L);
        check("【边界#4】到期通知 id 与持续通知 id 不同",
            first.state.notifId != ongoingId);
        check("【边界#4】到期通知 id 不会撞到 4210（递增且远小）",
            first.state.notifId < ongoingId);

        // ══ 边界 #3 补充：消费+通知单出口的语义（状态机层）════════
        // 两个竞争源对同一身份：第一个消费成功，第二个被 already-fired 拒绝
        RestReminderState.Snapshot s0 =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-X", 60_000L).state;
        RestReminderState.Outcome firstConsume =
            RestReminderState.onAlarmFired(s0, "rest-X", s0.generation);
        check("【边界#3】第一个竞争源消费成功", RestReminderState.shouldNotify(firstConsume));
        RestReminderState.Outcome secondConsume =
            RestReminderState.onAlarmFired(firstConsume.state, "rest-X", s0.generation);
        check("【边界#3】第二个竞争源被拒绝（不双响）",
            !RestReminderState.shouldNotify(secondConsume));
        check("【边界#3】第二个原因 already-fired",
            "already-fired".equals(secondConsume.reason));

        System.out.println();
        System.out.println("RestA2BoundaryTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestA2BoundaryTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestA2BoundaryTest 全部通过");
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
