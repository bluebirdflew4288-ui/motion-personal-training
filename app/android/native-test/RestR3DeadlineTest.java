package app.motion.personal.plugins;

/**
 * B4-R3 D2：**非法/过期/旧意图**请求一律只拒绝自己，不破坏当前好提醒。
 *
 * <h2>三个真实缺口（旧实现）</h2>
 * <ol>
 *   <li><b>D2-invalid-deadline</b>：{@code parseDeadlineAtMsOrNull} 把"没传"与
 *       "传了非法"都折成 null → 显式非法（{@code 'not-a-number'}）被静默当成缺省，
 *       退回 now+remainingMs 重新起算，等于用非法输入伪造新截止；</li>
 *   <li><b>D2-expired-old-request</b>：过期分支执行 {@code State.cancel(cur)} +
 *       无条件 {@code cancelAlarmOnly()}，一条早已过期的旧请求能 full-clear
 *       用户当前这条好提醒；</li>
 *   <li><b>D2-stale-intent-while-unfired</b>：未 fired 分支不核验意图水位，
 *       已消费过的旧编号仍被接受并覆盖当前截止；且 Plugin 在判定 outcome 之前
 *       就 {@code cancelAlarmOnly()}，NOOP 也会清掉好 alarm。</li>
 * </ol>
 *
 * <p>本文件覆盖前两项的**纯逻辑部分**（三态解析 + 状态机不变量）。
 * Plugin 的资源副作用顺序由 JS 侧真实链与 Codex 后继宿主验证。
 */
public final class RestR3DeadlineTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        invalidDeadlineIsExplicit();
        absentDeadlineKeepsCompatPath();
        expiredRequestNeverTouchesIdentity();
        staleIntentWhileUnfiredRejected();
        unnumberedPathsStillAccepted();
        minusFifteenUnnumberedAccepted();
        firedGateStillHolds();
        newTokenAndNewIntentScope();
        cancelPreservesWatermark();

        System.out.println("\nRestR3DeadlineTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** 显式非法截止 → 必须 INVALID（而不是被当成缺省） */
    private static void invalidDeadlineIsExplicit() {
        check("字符串 not-a-number → INVALID",
            RestArgs.classifyDeadline("not-a-number").isInvalid());
        check("空串 → INVALID（显式给了但为空）",
            RestArgs.classifyDeadline("").isInvalid());
        check("Boolean → INVALID", RestArgs.classifyDeadline(Boolean.TRUE).isInvalid());
        check("NaN → INVALID", RestArgs.classifyDeadline(Double.NaN).isInvalid());
        check("Infinity → INVALID", RestArgs.classifyDeadline(Double.POSITIVE_INFINITY).isInvalid());
        check("0 → INVALID", RestArgs.classifyDeadline(0).isInvalid());
        check("负数 → INVALID", RestArgs.classifyDeadline(-1).isInvalid());
        check("超 24h 上限 → INVALID",
            RestArgs.classifyDeadline(System.currentTimeMillis() + RestArgs.MAX_REMAINING_MS * 3L)
                .isInvalid());
        check("对象 → INVALID", RestArgs.classifyDeadline(new Object()).isInvalid());
        check("INVALID 时 value 为 null",
            RestArgs.classifyDeadline("abc").value == null);
    }

    /** 真正缺省（没传 / JSON null）→ 保留兼容 fallback */
    private static void absentDeadlineKeepsCompatPath() {
        check("null → ABSENT", RestArgs.classifyDeadline(null).isAbsent());
        check("不传（opt 返回 null）→ ABSENT", RestArgs.classifyDeadline(null).isAbsent());
        RestArgs.Deadline ok = RestArgs.classifyDeadline(
            System.currentTimeMillis() + 60_000L);
        check("合法值 → VALID", ok.kind == RestArgs.DeadlineKind.VALID);
        check("合法值保留原值", ok.value != null && ok.value > 0L);
        RestArgs.Deadline fromString = RestArgs.classifyDeadline(
            String.valueOf(System.currentTimeMillis() + 60_000L));
        check("数字字符串 → VALID", fromString.kind == RestArgs.DeadlineKind.VALID);
    }

    /** 过期请求只拒绝它自己：当前好身份的 token/generation/when 一字不变 */
    private static void expiredRequestNeverTouchesIdentity() {
        RestReminderState.Snapshot good =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "good-A", 60_000L, 20L).state;
        check("好提醒已建立", "good-A".equals(good.token) && !good.fired);

        long genBefore = good.generation;
        int notifBefore = good.notifId;
        long intentBefore = good.lastIntentId;

        // 过期请求的剩余算出来是 0：状态机返回 CANCEL 只作用于**它自己**的候选快照，
        // 并不代表 Plugin 可以拿它去 full-clear 当前好提醒。
        long effective = RestArgs.effectiveRemaining(
            60_000L, System.currentTimeMillis() - 1_000L, System.currentTimeMillis());
        check("过期请求 effectiveRemaining=0（不夹 1ms 补假提醒）", effective == 0L);

        // 关键不变量：好身份没有被这条过期请求改动
        check("过期后好身份 token 不变", "good-A".equals(good.token));
        check("过期后好身份 generation 不变", good.generation == genBefore);
        check("过期后好身份 notifId 不变", good.notifId == notifBefore);
        check("过期后好身份 lastIntentId 不变", good.lastIntentId == intentBefore);
        check("过期后好身份仍可投递", !good.fired);
        RestReminderState.Outcome fire =
            RestReminderState.onAlarmFired(good, "good-A", genBefore);
        check("过期请求不影响好身份的正常投递", RestReminderState.shouldNotify(fire));
    }

    /** 未 fired 时，携带**已消费过的正编号** → stale-intent 拒绝，档案不变 */
    private static void staleIntentWhileUnfiredRejected() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "good-A", 60_000L, 20L).state;
        check("初始水位 20", s.lastIntentId == 20L);

        long genBefore = s.generation;

        RestReminderState.Outcome equal =
            RestReminderState.startWithIntent(s, "good-A", 5_000L, 20L);
        check("未 fired + 相同编号 → NOOP", equal.action == RestReminderState.Outcome.Action.NOOP);
        check("未 fired + 相同编号 → stale-intent", "stale-intent".equals(equal.reason));
        check("未 fired + 相同编号 → 代次不变", equal.state.generation == genBefore);
        check("未 fired + 相同编号 → token 不变", "good-A".equals(equal.state.token));
        check("未 fired + 相同编号 → 水位不变", equal.state.lastIntentId == 20L);

        RestReminderState.Outcome older =
            RestReminderState.startWithIntent(s, "good-A", 5_000L, 10L);
        check("未 fired + 更旧编号 → NOOP", older.action == RestReminderState.Outcome.Action.NOOP);
        check("未 fired + 更旧编号 → stale-intent", "stale-intent".equals(older.reason));
        check("未 fired + 更旧编号 → 代次不变", older.state.generation == genBefore);

        RestReminderState.Outcome newer =
            RestReminderState.startWithIntent(s, "good-A", 65_000L, 21L);
        check("未 fired + 更新编号 → SCHEDULE",
            newer.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("未 fired + 更新编号 → 代次推进", newer.state.generation == genBefore + 1);
        check("未 fired + 更新编号 → 水位前进", newer.state.lastIntentId == 21L);
    }

    /** 无编号 legacy / 自动恢复：不受水位门禁影响，仍可重排 */
    private static void unnumberedPathsStillAccepted() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "good-A", 60_000L, 20L).state;
        RestReminderState.Outcome legacy = RestReminderState.startWithIntent(s, "good-A", 30_000L, 0L);
        check("无编号 legacy → SCHEDULE（不被水位误拒）",
            legacy.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("无编号 legacy → 代次推进", legacy.state.generation == s.generation + 1);
        check("无编号 legacy → 水位不回退", legacy.state.lastIntentId == 20L);

        RestReminderState.Outcome plain = RestReminderState.start(s, "good-A", 45_000L);
        check("旧 start() 入口 → SCHEDULE",
            plain.action == RestReminderState.Outcome.Action.SCHEDULE);
    }

    /** −15 减时（JS 侧明确不携带编号）→ 必须允许，不能被水位机械拒绝 */
    private static void minusFifteenUnnumberedAccepted() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "good-A", 60_000L, 7L).state;
        long genBefore = s.generation;

        // 连续减时：全部无编号，全部必须被接受并推进代次
        RestReminderState.Snapshot cur = s;
        boolean allAccepted = true;
        for (int i = 0; i < 3; i++) {
            RestReminderState.Outcome minus =
                RestReminderState.startWithIntent(cur, "good-A", 45_000L - i * 15_000L, 0L);
            if (minus.action != RestReminderState.Outcome.Action.SCHEDULE) allAccepted = false;
            cur = minus.state;
        }
        check("连续 −15（无编号）全部接受", allAccepted);
        check("连续 −15 后水位不回退", cur.lastIntentId == 7L);
        check("连续 −15 后代次持续推进", cur.generation == genBefore + 3);

        // 快速 +,+,- 混合：编号只由 + 携带
        RestReminderState.Snapshot mixed = s;
        mixed = RestReminderState.startWithIntent(mixed, "good-A", 75_000L, 8L).state; // +
        mixed = RestReminderState.startWithIntent(mixed, "good-A", 90_000L, 9L).state; // +
        RestReminderState.Outcome minusLast =
            RestReminderState.startWithIntent(mixed, "good-A", 75_000L, 0L); // -
        check("+,+,- 的 − 被接受", minusLast.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("+,+,- 后水位保持 9", minusLast.state.lastIntentId == 9L);
    }

    /** same-token fired 的无新意图门禁必须保留 */
    private static void firedGateStillHolds() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "fired-A", 15_000L, 5L).state;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "fired-A", s.generation).state;
        check("fired 前置成立", fired.fired);

        RestReminderState.Outcome noIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 0L);
        check("fired + 无编号 → NOOP", noIntent.action == RestReminderState.Outcome.Action.NOOP);
        check("fired + 无编号 → already-fired", "already-fired".equals(noIntent.reason));

        RestReminderState.Outcome sameIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 5L);
        check("fired + 相同编号 → stale-intent", "stale-intent".equals(sameIntent.reason));

        RestReminderState.Outcome newIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 6L);
        check("fired + 更新编号 → SCHEDULE",
            newIntent.action == RestReminderState.Outcome.Action.SCHEDULE);
    }

    /** 新 token 合法启动 + 后续编号作用域 */
    private static void newTokenAndNewIntentScope() {
        RestReminderState.Snapshot a =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "rest-A", 60_000L, 30L).state;

        // 新 token 用**比旧 token 水位更小的编号**：编号作用域跟着 token 走 → 合法
        RestReminderState.Outcome b =
            RestReminderState.startWithIntent(a, "rest-B", 30_000L, 1L);
        check("新 token + 小编号 → SCHEDULE",
            b.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token 身份切换", "rest-B".equals(b.state.token));
        check("新 token 水位从自己的编号起算（=1）", b.state.lastIntentId == 1L);

        // 同一新 token 的下一次合法加时（编号 2）必须被接受（closure 缺口修复点）
        RestReminderState.Outcome bPlus =
            RestReminderState.startWithIntent(b.state, "rest-B", 45_000L, 2L);
        check("新 token 连续 +15（编号 2）→ SCHEDULE",
            bPlus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token 连续 +15 水位前进到 2", bPlus.state.lastIntentId == 2L);

        // 而同一 token 的旧编号重放仍必须被拒
        RestReminderState.Outcome bReplay =
            RestReminderState.startWithIntent(bPlus.state, "rest-B", 5_000L, 1L);
        check("同 token 旧编号（1）→ stale-intent", "stale-intent".equals(bReplay.reason));

        // 无编号（−15 减时/legacy）不推进水位，也不会被拒
        RestReminderState.Outcome bMinus =
            RestReminderState.startWithIntent(bPlus.state, "rest-B", 30_000L, 0L);
        check("新 token 无编号减时 → SCHEDULE",
            bMinus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("无编号减时不推进水位（仍 2）", bMinus.state.lastIntentId == 2L);

        /**
         * 编号作用域是**当前身份（同 token）**：切到 rest-A 属于**新 token 启动**，
         * 即使编号等于历史水位也是合法业务路径（不能机械拒绝），
         * 但水位仍然只单调前进、不回退。
         */
        RestReminderState.Outcome backA =
            RestReminderState.startWithIntent(b.state, "rest-A", 20_000L, 30L);
        check("换回另一 token → SCHEDULE（编号作用域限于同 token）",
            backA.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("换回另一 token → 身份切换", "rest-A".equals(backA.state.token));
        check("换回另一 token → 水位不回退", backA.state.lastIntentId == 30L);

        // 而一旦身份就是 rest-A，同一个已消费编号的重排必须被拒
        RestReminderState.Outcome replayOnA =
            RestReminderState.startWithIntent(backA.state, "rest-A", 5_000L, 30L);
        check("同 token + 已消费编号 → stale-intent",
            "stale-intent".equals(replayOnA.reason));
        check("同 token + 已消费编号 → 代次不变",
            replayOnA.state.generation == backA.state.generation);
    }

    /** 取消保留水位：取消后旧编号重放仍被拒 */
    private static void cancelPreservesWatermark() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(
                RestReminderState.Snapshot.empty(), "rest-A", 60_000L, 12L).state;
        RestReminderState.Snapshot cancelled = RestReminderState.cancel(s).state;
        check("取消后水位保留", cancelled.lastIntentId == 12L);
        check("取消后 token 清空", cancelled.token == null);

        /**
         * B4-R3 closure2：取消保留"水位 + 水位归属 token"。
         * 同一 token 回来时仍是同一编号空间 → 旧正编号重放必须拒绝；
         * 更新编号或**无编号**（−15/legacy）才是合法重排。
         */
        RestReminderState.Outcome replayOld =
            RestReminderState.startWithIntent(cancelled, "rest-A", 60_000L, 12L);
        check("取消后旧编号重放 → stale-intent", "stale-intent".equals(replayOld.reason));

        RestReminderState.Outcome newer =
            RestReminderState.startWithIntent(cancelled, "rest-A", 60_000L, 13L);
        check("取消后新编号 → SCHEDULE",
            newer.action == RestReminderState.Outcome.Action.SCHEDULE);

        RestReminderState.Outcome minusAfterCancel =
            RestReminderState.startWithIntent(cancelled, "rest-A", 45_000L, 0L);
        check("取消后无编号（−15）→ SCHEDULE",
            minusAfterCancel.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("取消后无编号不清水位", minusAfterCancel.state.lastIntentId == 12L);
    }

    private static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  PASS " + name); }
        else { fail++; System.out.println("  FAIL " + name); }
    }
}
