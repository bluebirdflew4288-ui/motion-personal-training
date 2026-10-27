package app.motion.personal.plugins;

/**
 * B4-R3 独立验收后**有限补修**的原生侧回归（closure）。
 *
 * <h2>对应 Codex 独立首轮 4 个原生 FAIL 中的 2 个</h2>
 * <ol>
 *   <li>{@code D2-explicit-invalid-deadline-null}：
 *       显式 JSON {@code null} 被当成"字段没提供" → 退回 now+remainingMs
 *       伪造新截止。产品裁决：只有字段**真正缺省**才允许兼容 fallback；
 *       显式 null 与 {@code 0/true/非法字符串} 同类，必须 {@code invalid-deadline}；</li>
 *   <li>{@code D2-new-token-counter-scope-plus-and-legacy-minus}：
 *       水位全局单调 → 旧 token A 的编号 20 被新 token B 继承，
 *       B 用 1 启动后 B 自己的 +15（编号 2）被判 stale-intent。</li>
 * </ol>
 *
 * <p>纯 JVM、无 Android 依赖；真实 Plugin 接线与资源保持由
 * {@code RestR3DeadlineTest} 与应用侧结构断言共同锁住。
 */
public final class RestR3ClosureTest {

    private static int pass = 0;
    private static int fail = 0;

    /** 模拟 {@code org.json.JSONObject.NULL}：非 Number / 非 CharSequence，toString()=="null" */
    static final class JsonNull {
        @Override public String toString() { return "null"; }
    }

    public static void main(String[] args) {
        explicitJsonNullIsInvalid();
        javaNullStaysAbsent();
        newTokenContinuesItsOwnNumbering();
        sameTokenOldNumberStillRejected();
        legacyAndMinusDoNotAdvanceWatermark();
        firedGateStillRequiresNewIntent();

        System.out.println("\nRestR3ClosureTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** ① 显式 JSON null → INVALID（不是 ABSENT），因此不会 fallback */
    private static void explicitJsonNullIsInvalid() {
        RestArgs.Deadline d = RestArgs.classifyDeadline(new JsonNull());
        check("显式 JSON null → INVALID", d.isInvalid());
        check("显式 JSON null → value 为 null", d.value == null);
        check("显式 JSON null **不是** ABSENT（不再静默 fallback）", !d.isAbsent());

        // 与其余不可用值同类
        check("0 → INVALID", RestArgs.classifyDeadline(0).isInvalid());
        check("true → INVALID", RestArgs.classifyDeadline(Boolean.TRUE).isInvalid());
        check("非法字符串 → INVALID", RestArgs.classifyDeadline("not-a-number").isInvalid());

        // 对照：合法值仍是 VALID（没有把有效值误伤成非法）
        long soon = System.currentTimeMillis() + 60_000L;
        check("合法墙钟 → VALID", RestArgs.classifyDeadline(soon).kind
            == RestArgs.DeadlineKind.VALID);
    }

    /** ① 对照：Java null（字段真正缺省）仍是 ABSENT → 保留兼容 fallback */
    private static void javaNullStaysAbsent() {
        check("Java null → ABSENT", RestArgs.classifyDeadline(null).isAbsent());
        check("ABSENT 时 value 为 null", RestArgs.classifyDeadline(null).value == null);
        check("ABSENT 且非 INVALID", !RestArgs.classifyDeadline(null).isInvalid());
        // 缺省路径仍按旧语义（入口时刻 + remainingMs）
        check("缺省截止仍原样使用 remainingMs",
            RestArgs.effectiveRemaining(5_000L, null, System.currentTimeMillis()) == 5_000L);
    }

    /** ② Codex 原样场景：old-A(20) → new-B(1) → new-B(2) → new-B 无编号 全部接受 */
    private static void newTokenContinuesItsOwnNumbering() {
        RestReminderState.Outcome a = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "old-A", 60_000L, 20L);
        check("old-A 编号 20 被接受", a.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("old-A 水位 20", a.state.lastIntentId == 20L);

        RestReminderState.Outcome b = RestReminderState.startWithIntent(
            a.state, "new-B", 15_000L, 1L);
        check("新 token B 编号 1 被接受",
            b.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token B 水位从 1 起算", b.state.lastIntentId == 1L);

        RestReminderState.Outcome plus = RestReminderState.startWithIntent(
            b.state, "new-B", 30_000L, 2L);
        check("★ B 自己 +15（编号 2）必须被接受（独立验收 FAIL 修复点）",
            plus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("B 连续加时水位前进到 2", plus.state.lastIntentId == 2L);
        check("B 身份保持", "new-B".equals(plus.state.token));
        check("B 代次推进", plus.state.generation == b.state.generation + 1);

        RestReminderState.Outcome minus = RestReminderState.startWithIntent(
            plus.state, "new-B", 15_000L, 0L);
        check("★ B 的 −15（无编号）必须被接受",
            minus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("−15 不推进水位（仍 2）", minus.state.lastIntentId == 2L);
    }

    /** ② 对照：同 token 的旧正编号仍然拒绝（含相等） */
    private static void sameTokenOldNumberStillRejected() {
        RestReminderState.Snapshot s = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "new-B", 30_000L, 5L).state;
        long genBefore = s.generation;

        RestReminderState.Outcome equal = RestReminderState.startWithIntent(s, "new-B", 5_000L, 5L);
        check("同 token 相等编号 → stale-intent", "stale-intent".equals(equal.reason));
        check("同 token 相等编号 → NOOP", equal.action == RestReminderState.Outcome.Action.NOOP);
        check("同 token 相等编号 → 代次不动", equal.state.generation == genBefore);

        RestReminderState.Outcome older = RestReminderState.startWithIntent(s, "new-B", 5_000L, 3L);
        check("同 token 更旧编号 → stale-intent", "stale-intent".equals(older.reason));
        check("同 token 更旧编号 → 代次不动", older.state.generation == genBefore);
    }

    /** ② 对照：legacy（无编号）与 −15 都不推进水位，且不被拒 */
    private static void legacyAndMinusDoNotAdvanceWatermark() {
        RestReminderState.Snapshot s = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "rest-A", 60_000L, 7L).state;

        RestReminderState.Outcome legacy = RestReminderState.startWithIntent(s, "rest-A", 45_000L, 0L);
        check("legacy 无编号 → SCHEDULE",
            legacy.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("legacy 不推进水位", legacy.state.lastIntentId == 7L);

        RestReminderState.Outcome minus = RestReminderState.startWithIntent(
            legacy.state, "rest-A", 30_000L, 0L);
        check("连续 −15 → SCHEDULE",
            minus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("连续 −15 水位不动", minus.state.lastIntentId == 7L);

        // 之后同 token 的编号 8 仍是"新意图"
        RestReminderState.Outcome plus = RestReminderState.startWithIntent(
            minus.state, "rest-A", 45_000L, 8L);
        check("减时后编号 8 → SCHEDULE",
            plus.action == RestReminderState.Outcome.Action.SCHEDULE);
    }

    /** ② 对照：fired 后仍只接受**更新**的明确意图 */
    private static void firedGateStillRequiresNewIntent() {
        RestReminderState.Snapshot s = RestReminderState.startWithIntent(
            RestReminderState.Snapshot.empty(), "fired-A", 15_000L, 4L).state;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "fired-A", s.generation).state;
        check("前置：已 fired", fired.fired);

        RestReminderState.Outcome noIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 0L);
        check("fired + 无编号 → already-fired", "already-fired".equals(noIntent.reason));
        RestReminderState.Outcome sameIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 4L);
        check("fired + 同编号 → stale-intent", "stale-intent".equals(sameIntent.reason));
        RestReminderState.Outcome newerIntent =
            RestReminderState.startWithIntent(fired, "fired-A", 15_000L, 5L);
        check("fired + 更新编号 → SCHEDULE",
            newerIntent.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("fired + 更新编号 → 新身份可投递",
            !newerIntent.state.fired && newerIntent.state.generation == fired.generation + 1);
    }

    private static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  PASS " + name); }
        else { fail++; System.out.println("  FAIL " + name); }
    }
}
