package app.motion.personal.plugins;

/**
 * v0.2.3 教练记组触发休息计时的原生身份门禁与替换测试（纯 JVM）。
 * 验证多组批次仅保留最终有效 token、取消/已触发广播拒重响、持久化门禁失败不放行。
 */
public final class RestCoachTimerIdentityTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        coachTokenLifecycleAndDedup();
        multiSetBatchReplacementRejectsStaleToken();
        cancelledCoachTimerRejectsStaleBroadcast();
        persistenceFailureBlocksScheduleAndNotify();
        postFireNewIntentAdvancesGeneration();

        System.out.println("\nRestCoachTimerIdentityTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static void coachTokenLifecycleAndDedup() {
        String token = "coach:sess1:turn1_r0_c0:1";
        RestReminderGate.Sink okSink = (s) -> true;
        RestReminderGate.Result scheduled = RestReminderGate.apply(
            okSink,
            RestReminderState.Snapshot.empty(),
            (cur) -> RestReminderState.start(cur, token, 90_000L)
        );
        check("首次教练计时排程成功且可继续", scheduled.mayProceed());
        check("首次排程 action 为 SCHEDULE", scheduled.outcome.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("generation 从 1 起算", scheduled.outcome.state.generation == 1L);

        RestReminderGate.Result fired = RestReminderGate.apply(
            okSink,
            scheduled.outcome.state,
            (cur) -> RestReminderState.onAlarmFired(cur, token, scheduled.outcome.state.generation)
        );
        check("匹配 token+generation 首次允许提醒", RestReminderGate.mayNotify(fired));

        RestReminderGate.Result dupFire = RestReminderGate.apply(
            okSink,
            fired.outcome.state,
            (cur) -> RestReminderState.onAlarmFired(cur, token, scheduled.outcome.state.generation)
        );
        check("同一代次重复广播禁止再提醒", !RestReminderGate.mayNotify(dupFire));
        check("同一 token 无新意图重放返回 already-fired",
            "already-fired".equals(RestReminderState.start(fired.outcome.state, token, 90_000L).reason));
    }

    private static void multiSetBatchReplacementRejectsStaleToken() {
        String op1Token = "coach:sess1:op1:1";
        String op2Token = "coach:sess1:op2:2";
        RestReminderState.Outcome r1 = RestReminderState.start(RestReminderState.Snapshot.empty(), op1Token, 90_000L);
        RestReminderState.Outcome r2 = RestReminderState.start(r1.state, op2Token, 120_000L);
        check("后到操作替换 token", op2Token.equals(r2.state.token));
        check("后到操作推进 generation", r2.state.generation == r1.state.generation + 1L);
        check("后到操作递增 notifId", r2.state.notifId == r1.state.notifId + 1);

        RestReminderState.Outcome staleOp1 = RestReminderState.onAlarmFired(r2.state, op1Token, r1.state.generation);
        check("被替换的旧操作广播被拦截", !RestReminderState.shouldNotify(staleOp1));

        RestReminderState.Outcome finalOp2 = RestReminderState.onAlarmFired(r2.state, op2Token, r2.state.generation);
        check("最终有效操作广播允许触发", RestReminderState.shouldNotify(finalOp2));
    }

    private static void cancelledCoachTimerRejectsStaleBroadcast() {
        String token = "coach:sess2:op9:1";
        RestReminderState.Outcome s = RestReminderState.start(RestReminderState.Snapshot.empty(), token, 60_000L);
        RestReminderState.Outcome cancelled = RestReminderState.cancel(s.state);
        check("取消后 token 清空", cancelled.state.token == null);
        check("取消后 generation 推进", cancelled.state.generation == s.state.generation + 1L);

        RestReminderState.Outcome delayed = RestReminderState.onAlarmFired(cancelled.state, token, s.state.generation);
        check("取消后的延迟广播不得提醒", !RestReminderState.shouldNotify(delayed));
    }

    private static void persistenceFailureBlocksScheduleAndNotify() {
        RestReminderGate.Sink failingSink = (s) -> false;
        RestReminderGate.Result res = RestReminderGate.apply(
            failingSink,
            RestReminderState.Snapshot.empty(),
            (cur) -> RestReminderState.start(cur, "coach:sess3:op1:1", 45_000L)
        );
        check("落盘失败禁止继续原生排程", !res.mayProceed());
        check("落盘失败不得触发通知", !RestReminderGate.mayNotify(res));
        check("失败原因为 commit-failed", "commit-failed".equals(res.failureReason));
    }

    private static void postFireNewIntentAdvancesGeneration() {
        String token = "coach:sess4:op1:1";
        RestReminderState.Snapshot fired = RestReminderState.onAlarmFired(
            RestReminderState.start(RestReminderState.Snapshot.empty(), token, 60_000L).state,
            token,
            1L
        ).state;
        RestReminderState.Outcome extended = RestReminderState.startWithIntent(fired, token, 15_000L, 1L);
        check("已到点后用户主动加时允许新建身份", extended.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新意图代次推进且 fired 复位", extended.state.generation == 2L && !extended.state.fired);

        RestReminderState.Outcome replayIntent = RestReminderState.startWithIntent(extended.state, token, 15_000L, 1L);
        check("相同正意图编号重放被 stale-intent 拦截", "stale-intent".equals(replayIntent.reason));
    }

    private static void check(String name, boolean cond) {
        if (cond) {
            pass++;
            System.out.println("  ✔ " + name);
        } else {
            fail++;
            System.out.println("  ✘ " + name);
        }
    }
}
