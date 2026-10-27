package app.motion.personal.plugins;

/**
 * B4-R3 closure2 原生侧回归（第二次独立验收后的两个原生 FAIL）。
 *
 * <h2>1. D2：−15 经精确取消后不得清掉同一计时的意图水位</h2>
 * Codex 真实 Java corroboration（runs/2026-10-26T14-55-13-048Z）：
 * start(编号3) → 精确 cancel（token 变 null、水位 3 仍在）→ 同 token 的无编号 −15
 * → 旧实现把它当"全新 token"把水位重置为 0 → 之后**旧正编号 2 又能被接受**。
 * 期望：水位保持 3、无编号排程被接受、旧编号 2 仍 stale-intent。
 *
 * <h2>2. D1：原生处理耗时不得被加进绝对截止</h2>
 * Codex 探针（runs/2026-10-26T15-12-57-520Z）在 identity commit 里注入 150ms：
 * 旧实现闹钟与 service 单调截止都晚 163ms（阈值 15ms）。
 * 这里锁住**纯换算**：目标墙钟在入口定死，单调截止用派发时刻的真实剩余换算。
 */
public final class RestR3Closure2Test {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        minusAfterPreciseCancelKeepsWatermark();
        differentTokenStillRestartsNumbering();
        targetWallIgnoresProcessingTime();
        monotonicDeadlineTracksSameTarget();
        missingDeadlineKeepsCompatFallback();
        pluginWiresAbsoluteTarget();

        System.out.println("\nRestR3Closure2Test: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** Codex 原样场景：start(id3) → 精确 cancel → 无编号 −15 → 旧编号 2 仍被拒 */
    private static void minusAfterPreciseCancelKeepsWatermark() {
        RestReminderState.Snapshot good = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "minus-A", 60_000L, 3L).state;
        check("start(编号3) 被接受", "minus-A".equals(good.token) && good.lastIntentId == 3L);

        RestReminderState.Snapshot cancelled =
            RestReminderState.cancelIfCurrent(good, "minus-A", good.generation, true).state;
        check("精确取消：token 清空", cancelled.token == null);
        check("精确取消：水位保留 3", cancelled.lastIntentId == 3L);
        check("精确取消：**水位归属 token 保留**（closure2 新增）",
            "minus-A".equals(cancelled.lastIntentToken));

        // 同一 token 的无编号 −15：必须被接受，且**不得**把水位清成 0
        RestReminderState.Outcome minus =
            RestReminderState.startWithIntent(cancelled, "minus-A", 45_000L, 0L);
        check("−15（无编号）→ SCHEDULE",
            minus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("−15 后水位仍 3（不清水位）", minus.state.lastIntentId == 3L);
        check("−15 后水位归属仍是同一 token",
            "minus-A".equals(minus.state.lastIntentToken));

        // 旧正编号 2 重放：必须仍被判旧意图
        RestReminderState.Outcome replay =
            RestReminderState.startWithIntent(minus.state, "minus-A", 10_000L, 2L);
        check("旧编号 2 重放 → stale-intent", "stale-intent".equals(replay.reason));
        check("旧编号 2 重放 → NOOP",
            replay.action == RestReminderState.Outcome.Action.NOOP);
        check("旧编号 2 重放 → 状态不变",
            replay.state.lastIntentId == 3L && replay.state.generation == minus.state.generation);
    }

    /** 对照：真正**不同的 token** 仍从 1 起算（新 B 连续 1/2 合法） */
    private static void differentTokenStillRestartsNumbering() {
        RestReminderState.Snapshot a = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "old-A", 60_000L, 20L).state;
        RestReminderState.Snapshot cancelled =
            RestReminderState.cancelIfCurrent(a, "old-A", a.generation, true).state;

        RestReminderState.Outcome b = RestReminderState.startWithIntent(
            cancelled, "new-B", 15_000L, 1L);
        check("新 token B 编号 1 被接受",
            b.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token B 水位从 1 起算", b.state.lastIntentId == 1L);
        check("新 token B 水位归属切换", "new-B".equals(b.state.lastIntentToken));

        RestReminderState.Outcome plus =
            RestReminderState.startWithIntent(b.state, "new-B", 30_000L, 2L);
        check("新 token B 的 +15（编号2）被接受",
            plus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token B 连续加时水位前进", plus.state.lastIntentId == 2L);
    }

    /** D1：目标墙钟在入口定死 —— 处理耗时不得改变它 */
    private static void targetWallIgnoresProcessingTime() {
        long entry = 1_800_000_000_000L;
        long remaining = 15_000L;
        long deadline = entry + 1_000L + remaining; // JS 点击时刻 + 15000，入口已有 1000ms 排队
        check("带 deadline：目标 = 调用方绝对截止",
            RestArgs.targetWallAt(entry, remaining, deadline) == deadline);
        // 处理耗时 150ms 之后计算，目标仍然不变
        long laterEntry = entry + 150L;
        check("处理耗时不影响目标",
            RestArgs.targetWallAt(laterEntry, remaining, deadline) == deadline);
        // 缺省：入口时刻 + remainingMs（旧语义，但在入口定死）
        check("缺省截止：入口 + remainingMs",
            RestArgs.targetWallAt(entry, remaining, null) == entry + remaining);
        check("缺省截止也不受后续处理耗时影响",
            RestArgs.targetWallAt(entry, remaining, null)
                == RestArgs.targetWallAt(entry, remaining, null));
    }

    /** D1：单调截止必须以**派发时刻的真实剩余**换算，才与同一墙钟目标对应 */
    private static void monotonicDeadlineTracksSameTarget() {
        long entryWall = 1_800_000_000_000L;
        long entryElapsed = 500_000L;
        long target = entryWall + 15_000L;

        // 无处理耗时
        long fast = RestArgs.monotonicDeadlineAt(entryWall, entryElapsed, target);
        check("无耗时：单调截止 = 入口 elapsed + 剩余",
            fast == entryElapsed + 15_000L);

        // 处理耗时 150ms（commit 注入）：单调截止仍对应**同一个墙钟目标**
        long commitLatency = 150L;
        long slow = RestArgs.monotonicDeadlineAt(
            entryWall + commitLatency, entryElapsed + commitLatency, target);
        check("有 150ms 耗时：单调截止与目标一致",
            slow == entryElapsed + 15_000L);
        check("耗时不会把剩余抬高（无 drift）",
            slow - fast == 0L);

        // 交叉验证：两条时钟的“还能走多久”必须相等（这是 D1 判据的核心）
        long wallRemainingAtDispatch = target - (entryWall + commitLatency);
        long monoRemainingAtDispatch = slow - (entryElapsed + commitLatency);
        check("wall 剩余 == mono 剩余（同一目标）",
            wallRemainingAtDispatch == monoRemainingAtDispatch);

        // 目标已过：夹到 0，不产生负剩余
        long past = RestArgs.monotonicDeadlineAt(entryWall + 20_000L, entryElapsed + 20_000L, target);
        check("目标已过 → 单调截止不早于当前（夹 0）", past == entryElapsed + 20_000L);
    }

    /** D1：字段缺省仍兼容 fallback；显式坏值在此之前已被拒绝（不进入本换算） */
    private static void missingDeadlineKeepsCompatFallback() {
        long entry = 1_800_000_000_000L;
        check("缺省(null) → fallback 入口+remaining",
            RestArgs.targetWallAt(entry, 45_000L, null) == entry + 45_000L);
        // 显式 JSON null 是 INVALID（由 classifyDeadline 拒绝），不会走到换算
        check("显式 JSON null → INVALID（不 fallback）",
            RestArgs.classifyDeadline(new Object() {
                @Override public String toString() { return "null"; }
            }).isInvalid());
        check("非法字符串 → INVALID", RestArgs.classifyDeadline("bad").isInvalid());
        /**
         * 注意：{@code parseDeadlineAtMsOrNull} 有"当前墙钟 + 24h"的宽松上限，
         * 因此这里必须用**真实当前时刻**的相对值，不能用合成常量测 VALID。
         */
        long realNow = System.currentTimeMillis();
        check("合法值 → VALID",
            RestArgs.classifyDeadline(realNow + 60_000L).kind == RestArgs.DeadlineKind.VALID);
        check("超出 24h 上限 → INVALID",
            RestArgs.classifyDeadline(realNow + 25L * 60L * 60L * 1000L).isInvalid());
    }

    /**
     * D1 的**接线**在 Android Plugin 里（纯 JVM 无法实例化），
     * 因此用生产源码结构锁定：目标在入口定死、闹钟/服务都从它派生。
     */
    private static void pluginWiresAbsoluteTarget() {
        String src = readSource(
            "android/app/src/main/java/app/motion/personal/plugins/RestReminderPlugin.java");
        check("schedule 入口先取 entryWallMs",
            src.contains("final long entryWallMs = System.currentTimeMillis();"));
        check("目标墙钟只算一次（入口时刻 + deadline/remaining）",
            src.contains("final long targetWallMs = RestArgs.targetWallAt(entryWallMs, remainingMs, deadlineAtMs);"));
        check("闹钟 when = 目标墙钟（不再 now + scheduledMs）",
            src.contains("long triggerAtMs = targetWall;"));
        check("不再有 now + scheduledMs 的旧算式",
            !src.contains("long triggerAtMs = System.currentTimeMillis() + scheduledMs;"));
        check("不再有 elapsed + scheduledMs 的旧算式",
            !src.contains("long deadlineElapsed = SystemClock.elapsedRealtime() + scheduledMs;"));
        check("service 单调截止由同一目标换算",
            src.contains("RestArgs.monotonicDeadlineAt(nowWallAtDispatch, nowElapsedAtDispatch, targetWall)"));
        check("FGS 资格判定用派发时刻剩余（不用早期 scheduledMs）",
            src.contains("tryStartForegroundEnhancement(\n                    token, generation, leftAtDispatch, deadlineElapsed);"));
    }

    private static String readSource(String rel) {
        try {
            return new String(java.nio.file.Files.readAllBytes(
                java.nio.file.Paths.get(rel)), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  PASS " + name); }
        else { fail++; System.out.println("  FAIL " + name); }
    }
}
