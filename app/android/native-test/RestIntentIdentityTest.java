package app.motion.personal.plugins;

/**
 * B4-R2 优先级一 #3：归零且原生已 fired 后，用户明确 +15 必须能建立
 * <b>新的可投递身份</b>；同时旧排程请求重放必须仍被拒绝（不得重新响铃）。
 *
 * <h2>真实失败背景</h2>
 * 归零后 {@code fired=true}，用户点 +15。JS 控制器会先异步 cancel 旧身份再重排，
 * 但 cancel 是 fire-and-forget —— 排程请求可能先到原生。旧规则一律
 * {@code already-fired} 拒绝，于是用户明确加出来的时间永远排不上。
 *
 * <h2>本测试锁住的边界（也是用户明确要求的身份守卫）</h2>
 * <ul>
 *   <li>不带意图编号（0）→ 保持旧门禁：同 token + fired 仍 already-fired；</li>
 *   <li>带**更新的**意图编号 → 允许新身份（generation+1 / fired=false / notifId+1）；</li>
 *   <li>带**相同或更旧**的意图编号（旧请求重放）→ stale-intent 拒绝，绝不重响；</li>
 *   <li>取消不清意图水位 → 取消后旧编号重放仍被拒；</li>
 *   <li>新身份的旧代次广播仍被代次核验挡掉（不会旧时点补响）。</li>
 * </ul>
 */
public final class RestIntentIdentityTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        firedSameTokenWithoutIntentKeepsGate();
        firedSameTokenWithNewIntentAllowsNewDeliverable();
        staleIntentReplayRejected();
        cancelKeepsIntentWatermark();
        oldGenerationBroadcastStillRejectedAfterNewIntent();
        ordinaryRescheduleUnchanged();
        nonPositiveStillCancels();

        System.out.println("\nRestIntentIdentityTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** 不带意图编号：保持旧 already-fired 门禁（防重复投递/重建重复） */
    private static void firedSameTokenWithoutIntentKeepsGate() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "rest-A", s.generation).state;
        check("fire 后 fired=true", fired.fired);

        RestReminderState.Outcome o = RestReminderState.startWithIntent(fired, "rest-A", 15000L, 0L);
        check("无意图编号：仍是 NOOP", o.action == RestReminderState.Outcome.Action.NOOP);
        check("无意图编号：原因是 already-fired", "already-fired".equals(o.reason));
        check("无意图编号：代次不推进", o.state.generation == fired.generation);
        check("无意图编号：fired 保持 true", o.state.fired);
    }

    /** 带更新的意图编号：允许新身份，且是可投递的（fired=false、新代次、新通知 id） */
    private static void firedSameTokenWithNewIntentAllowsNewDeliverable() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "rest-A", s.generation).state;

        RestReminderState.Outcome o = RestReminderState.startWithIntent(fired, "rest-A", 15000L, 1L);
        check("新意图：SCHEDULE", o.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新意图：同 token 保留", "rest-A".equals(o.state.token));
        check("新意图：fired 复位为 false", !o.state.fired);
        check("新意图：代次推进", o.state.generation == fired.generation + 1);
        check("新意图：通知 id 递增（不会被上一组压掉）", o.state.notifId == fired.notifId + 1);
        check("新意图：水位记录", o.state.lastIntentId == 1L);

        // 新身份确实可投递：该代次广播会被接受
        RestReminderState.Outcome fire2 = RestReminderState.onAlarmFired(o.state, "rest-A", o.state.generation);
        check("新身份：可再次触发一次", RestReminderState.shouldNotify(fire2));
    }

    /** 旧请求重放：编号不更新 → stale-intent，绝不重响 */
    private static void staleIntentReplayRejected() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "rest-A", s.generation).state;
        RestReminderState.Outcome first =
            RestReminderState.startWithIntent(fired, "rest-A", 15000L, 7L);
        RestReminderState.Snapshot firedAgain =
            RestReminderState.onAlarmFired(first.state, "rest-A", first.state.generation).state;

        // 同编号重放
        RestReminderState.Outcome replaySame =
            RestReminderState.startWithIntent(firedAgain, "rest-A", 15000L, 7L);
        check("同编号重放：NOOP", replaySame.action == RestReminderState.Outcome.Action.NOOP);
        check("同编号重放：stale-intent", "stale-intent".equals(replaySame.reason));
        check("同编号重放：fired 仍 true（不会重响）", replaySame.state.fired);
        check("同编号重放：代次不推进", replaySame.state.generation == firedAgain.generation);

        // 更旧编号重放
        RestReminderState.Outcome replayOlder =
            RestReminderState.startWithIntent(firedAgain, "rest-A", 15000L, 3L);
        check("更旧编号重放：NOOP", replayOlder.action == RestReminderState.Outcome.Action.NOOP);
        check("更旧编号重放：stale-intent", "stale-intent".equals(replayOlder.reason));
        check("更旧编号重放：fired 仍 true", replayOlder.state.fired);
    }

    /** 取消保留意图水位：取消后旧编号重放仍被拒（水位只能单调前进） */
    private static void cancelKeepsIntentWatermark() {
        RestReminderState.Snapshot s =
            RestReminderState.startWithIntent(RestReminderState.Snapshot.empty(), "rest-A", 60000L, 5L).state;
        check("start 记录水位 5", s.lastIntentId == 5L);
        RestReminderState.Snapshot cancelled = RestReminderState.cancel(s).state;
        check("取消：token 清空", cancelled.token == null);
        check("取消：水位保留 5", cancelled.lastIntentId == 5L);

        /**
         * B4-R3 closure2 产品裁决（取代本测试原先的"取消后重排一律接受"）：
         * 精确取消只清"当前身份"，**不清用户意图水位**，也不清"水位属于哪个 token"。
         * 因此同一 token 再出现时：
         *   · 携带**旧正编号**（≤ 水位）→ 仍是旧意图重放，拒绝（否则取消一次就能让旧编号复活）；
         *   · 携带**更新编号** → 合法重排；
         *   · **无编号**（−15/legacy）→ 合法重排，且水位保持不变。
         */
        RestReminderState.Outcome replayOld =
            RestReminderState.startWithIntent(cancelled, "rest-A", 60000L, 5L);
        check("取消后用旧编号重排：stale-intent", "stale-intent".equals(replayOld.reason));
        check("取消后用旧编号重排：NOOP",
            replayOld.action == RestReminderState.Outcome.Action.NOOP);
        check("取消后用旧编号重排：水位仍 5", replayOld.state.lastIntentId == 5L);

        RestReminderState.Outcome restart =
            RestReminderState.startWithIntent(cancelled, "rest-A", 60000L, 6L);
        check("取消后用**更新编号**重排：SCHEDULE",
            restart.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("取消后用更新编号重排：水位前进", restart.state.lastIntentId == 6L);

        RestReminderState.Outcome unnumbered =
            RestReminderState.startWithIntent(cancelled, "rest-A", 60000L, 0L);
        check("取消后**无编号**重排：SCHEDULE（−15/legacy 路径）",
            unnumbered.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("取消后无编号重排：水位不被清零", unnumbered.state.lastIntentId == 5L);
    }

    /** 新意图建立后，旧代次广播仍必须被挡掉（旧时点不补响） */
    private static void oldGenerationBroadcastStillRejectedAfterNewIntent() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        long oldGen = s.generation;
        RestReminderState.Snapshot fired =
            RestReminderState.onAlarmFired(s, "rest-A", oldGen).state;
        RestReminderState.Snapshot next =
            RestReminderState.startWithIntent(fired, "rest-A", 15000L, 2L).state;

        RestReminderState.Outcome staleBroadcast =
            RestReminderState.onAlarmFired(next, "rest-A", oldGen);
        check("旧代次广播：NOOP", staleBroadcast.action == RestReminderState.Outcome.Action.NOOP);
        check("旧代次广播：stale-broadcast-generation",
            "stale-broadcast-generation".equals(staleBroadcast.reason));
        check("旧代次广播：新身份未被消费", !staleBroadcast.state.fired);
    }

    /** 非 fired 的常规重排语义完全不变 */
    private static void ordinaryRescheduleUnchanged() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        RestReminderState.Outcome more = RestReminderState.start(s, "rest-A", 75000L);
        check("常规加时：SCHEDULE", more.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("常规加时：代次推进", more.state.generation == s.generation + 1);
        check("常规加时：fired=false", !more.state.fired);

        RestReminderState.Outcome other = RestReminderState.start(more.state, "rest-B", 30000L);
        check("换 token：SCHEDULE", other.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("换 token：身份切换", "rest-B".equals(other.state.token));
    }

    /** 非正剩余仍走取消（不建身份） */
    private static void nonPositiveStillCancels() {
        RestReminderState.Snapshot s =
            RestReminderState.start(RestReminderState.Snapshot.empty(), "rest-A", 60000L).state;
        RestReminderState.Outcome zero = RestReminderState.startWithIntent(s, "rest-A", 0L, 9L);
        check("剩余 0：CANCEL", zero.action == RestReminderState.Outcome.Action.CANCEL);
        check("剩余 0：token 清空", zero.state.token == null);
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  PASS " + name);
        } else {
            fail++;
            System.out.println("  FAIL " + name);
        }
    }
}
