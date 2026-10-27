package app.motion.personal.plugins;

/**
 * 预审 P1 #2 的定向测试：持久化成功门禁。
 *
 * <p>缺陷场景：B 状态写盘失败，但 schedule 仍返回 true →
 * 进程重建后读回旧的 A → B 的广播因身份不符被丢弃 → 用户收不到任何提醒，
 * 而 App 之前已经假报"已排程"。
 *
 * <p>本测试用可注入失败的 Sink 验证：写盘失败时**不排程、不通知、不假报 durable**。
 */
public final class RestGateTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        RestReminderState.Snapshot empty = RestReminderState.Snapshot.empty();

        // ── 写盘成功：允许继续 ─────────────────────────────────
        RestReminderGate.Result ok = RestReminderGate.apply(
            snap -> true,
            empty,
            cur -> RestReminderState.start(cur, "rest-A", 60000L)
        );
        check("写盘成功：durable=true", ok.durable);
        check("写盘成功：mayProceed", ok.mayProceed());
        check("写盘成功：action=SCHEDULE",
            ok.outcome.action == RestReminderState.Outcome.Action.SCHEDULE);

        // ── 写盘失败：不得排程 ─────────────────────────────────
        RestReminderGate.Result failed = RestReminderGate.apply(
            snap -> false,
            empty,
            cur -> RestReminderState.start(cur, "rest-B", 60000L)
        );
        check("写盘失败：durable=false", !failed.durable);
        check("写盘失败：mayProceed=false（不排程）", !failed.mayProceed());
        check("写盘失败：原因 commit-failed", "commit-failed".equals(failed.failureReason));

        // ── 写盘抛异常：同样不得排程 ───────────────────────────
        RestReminderGate.Result threw = RestReminderGate.apply(
            snap -> {
                throw new IllegalStateException("disk full");
            },
            empty,
            cur -> RestReminderState.start(cur, "rest-C", 60000L)
        );
        check("写盘异常：durable=false", !threw.durable);
        check("写盘异常：原因是 commit-exception",
            threw.failureReason != null && threw.failureReason.startsWith("commit-exception"));

        // ── 通知门禁：必须 durable 且确实要求提醒 ──────────────
        RestReminderState.Outcome firedOutcome = RestReminderState.onAlarmFired(
            new RestReminderState.Snapshot("rest-D", 5L, false, 1),
            "rest-D",
            5L
        );
        check("到点判定：reason=fire", "fire".equals(firedOutcome.reason));

        RestReminderGate.Result notifyOk = RestReminderGate.apply(
            snap -> true,
            new RestReminderState.Snapshot("rest-D", 5L, false, 1),
            cur -> RestReminderState.onAlarmFired(cur, "rest-D", 5L)
        );
        check("fired 写盘成功：允许通知", RestReminderGate.mayNotify(notifyOk));

        RestReminderGate.Result notifyFail = RestReminderGate.apply(
            snap -> false,
            new RestReminderState.Snapshot("rest-D", 5L, false, 1),
            cur -> RestReminderState.onAlarmFired(cur, "rest-D", 5L)
        );
        check("fired 写盘失败：不发通知", !RestReminderGate.mayNotify(notifyFail));

        // ── 陈旧广播即使写盘成功也不通知 ──────────────────────
        RestReminderGate.Result staleOk = RestReminderGate.apply(
            snap -> true,
            new RestReminderState.Snapshot("rest-E", 7L, false, 1),
            cur -> RestReminderState.onAlarmFired(cur, "rest-E", 6L) // 旧代次
        );
        check("陈旧代次写盘成功：仍不通知", !RestReminderGate.mayNotify(staleOk));

        // ── 已 fired 再投递：不通知 ────────────────────────────
        RestReminderGate.Result dupOk = RestReminderGate.apply(
            snap -> true,
            new RestReminderState.Snapshot("rest-F", 9L, true, 1),
            cur -> RestReminderState.onAlarmFired(cur, "rest-F", 9L)
        );
        check("已 fired 重复投递：不通知", !RestReminderGate.mayNotify(dupOk));

        // ── null 迁移函数：明确失败 ────────────────────────────
        RestReminderGate.Result nullOut = RestReminderGate.apply(snap -> true, empty, cur -> null);
        check("null outcome：durable=false", !nullOut.durable);
        check("null outcome 原因 null-outcome", "null-outcome".equals(nullOut.failureReason));

        // ── 补充 P1 #2：取消也必须过写盘门禁 ──────────────────
        RestReminderState.Snapshot active =
            new RestReminderState.Snapshot("rest-K", 11L, false, 3);
        RestReminderGate.Result cancelFail = RestReminderGate.apply(
            snap -> false,
            active,
            cur -> RestReminderState.cancel(cur)
        );
        check("取消写盘失败：durable=false", !cancelFail.durable);
        check("取消写盘失败：不得报成功", !cancelFail.mayProceed());
        check("取消写盘失败原因 commit-failed", "commit-failed".equals(cancelFail.failureReason));

        RestReminderGate.Result cancelOk = RestReminderGate.apply(
            snap -> true,
            active,
            cur -> RestReminderState.cancel(cur)
        );
        check("取消写盘成功：durable=true", cancelOk.durable);
        check("取消写盘成功：CANCEL",
            cancelOk.outcome.action == RestReminderState.Outcome.Action.CANCEL);

        // 陈旧取消即使写盘成功也不应产生副作用（NOOP）
        RestReminderState.Snapshot other =
            new RestReminderState.Snapshot("rest-L", 12L, false, 4);
        RestReminderGate.Result staleCancelGate = RestReminderGate.apply(
            snap -> true,
            other,
            cur -> RestReminderState.cancelIfCurrent(cur, "rest-K", 11L, true)
        );
        check("陈旧取消写盘成功：仍 NOOP",
            staleCancelGate.outcome.action == RestReminderState.Outcome.Action.NOOP);
        check("陈旧取消：不通知", !RestReminderGate.mayNotify(staleCancelGate));

        System.out.println();
        System.out.println("RestGateTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestGateTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestGateTest 全部通过");
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
