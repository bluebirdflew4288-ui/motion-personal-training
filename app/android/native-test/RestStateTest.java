package app.motion.personal.plugins;

/**
 * 预审 P1 #1/#3 的定向测试：代次端到端核验 + 通知 id 递增。
 *
 * <p>核心场景（旧实现只比 token，会提前响）：
 * <pre>
 *   schedule(A) → 旧 A 广播已入队 → cancel → resume/schedule(A) → 旧 A 到达
 * </pre>
 * 此时 token 仍是 A，只有 generation 变了；必须靠 generation 把旧广播挡掉。
 */
public final class RestStateTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        RestReminderState.Snapshot empty = RestReminderState.Snapshot.empty();

        // ── 正常开始 ───────────────────────────────────────────
        RestReminderState.Outcome s1 = RestReminderState.start(empty, "rest-A", 60000L);
        check("开始 A：SCHEDULE", s1.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("开始 A：token 记录", "rest-A".equals(s1.state.token));
        check("开始 A：未 fired", !s1.state.fired);
        check("开始 A：代次推进", s1.state.generation == empty.generation + 1);
        check("开始 A：通知 id 递增", s1.state.notifId > empty.notifId);

        // ── P1 #1 核心：取消后重排同一 token，旧代次广播必须失效 ──
        RestReminderState.Outcome cancelled = RestReminderState.cancel(s1.state);
        check("取消：CANCEL", cancelled.action == RestReminderState.Outcome.Action.CANCEL);
        check("取消：token 清空", cancelled.state.token == null);
        check("取消：代次递增", cancelled.state.generation > s1.state.generation);

        RestReminderState.Outcome restarted =
            RestReminderState.start(cancelled.state, "rest-A", 60000L);
        check("重排同一 token A：SCHEDULE", restarted.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("重排同一 token：代次再次递增", restarted.state.generation > cancelled.state.generation);

        // 旧代次广播（携带 s1 的 generation）到达 → 必须丢弃
        RestReminderState.Outcome staleGen =
            RestReminderState.onAlarmFired(restarted.state, "rest-A", s1.state.generation);
        check("旧代次广播：不提醒", !RestReminderState.shouldNotify(staleGen));
        check("旧代次原因 stale-broadcast-generation",
            "stale-broadcast-generation".equals(staleGen.reason));

        // 当前代次广播 → 正常提醒
        RestReminderState.Outcome freshGen =
            RestReminderState.onAlarmFired(restarted.state, "rest-A", restarted.state.generation);
        check("当前代次广播：提醒", RestReminderState.shouldNotify(freshGen));
        check("当前代次：fired=true", freshGen.state.fired);

        // ── 同 token 加长时间：旧广播同样失效 ──────────────────
        RestReminderState.Outcome base = RestReminderState.start(empty, "rest-B", 60000L);
        RestReminderState.Outcome extended =
            RestReminderState.start(base.state, "rest-B", 120000L);
        check("同 token 加时间：代次递增", extended.state.generation > base.state.generation);
        check("同 token 加时间：旧广播不提醒",
            !RestReminderState.shouldNotify(
                RestReminderState.onAlarmFired(extended.state, "rest-B", base.state.generation)));
        check("同 token 加时间：新广播提醒",
            RestReminderState.shouldNotify(
                RestReminderState.onAlarmFired(extended.state, "rest-B", extended.state.generation)));

        // ── token 不匹配 ───────────────────────────────────────
        check("错误 token：不提醒",
            !RestReminderState.shouldNotify(
                RestReminderState.onAlarmFired(extended.state, "rest-Z", extended.state.generation)));
        check("错误 token 原因 stale-broadcast-token",
            "stale-broadcast-token".equals(
                RestReminderState.onAlarmFired(extended.state, "rest-Z", extended.state.generation).reason));

        // ── 重复投递 ───────────────────────────────────────────
        RestReminderState.Outcome once = RestReminderState.start(empty, "rest-C", 60000L);
        RestReminderState.Outcome fired =
            RestReminderState.onAlarmFired(once.state, "rest-C", once.state.generation);
        RestReminderState.Outcome twice =
            RestReminderState.onAlarmFired(fired.state, "rest-C", once.state.generation);
        check("重复投递：不提醒", !RestReminderState.shouldNotify(twice));
        check("重复投递原因 already-fired", "already-fired".equals(twice.reason));

        // ── 重建后（从持久化读回）仍不重复 ─────────────────────
        RestReminderState.Snapshot restored = new RestReminderState.Snapshot(
            fired.state.token, fired.state.generation, fired.state.fired, fired.state.notifId);
        check("重建后同代次：不提醒",
            !RestReminderState.shouldNotify(
                RestReminderState.onAlarmFired(restored, "rest-C", restored.generation)));

        // ── 已 fired 的 token 重排被拒（防重建后重复）─────────
        RestReminderState.Outcome reAfterFired =
            RestReminderState.start(fired.state, "rest-C", 30000L);
        check("已 fired 重排：NOOP", reAfterFired.action == RestReminderState.Outcome.Action.NOOP);
        check("已 fired 重排原因 already-fired", "already-fired".equals(reAfterFired.reason));

        // ── P1 #3：连续两组各自有新通知 id ────────────────────
        RestReminderState.Outcome g1 = RestReminderState.start(empty, "rest-1", 60000L);
        RestReminderState.Outcome g1done =
            RestReminderState.onAlarmFired(g1.state, "rest-1", g1.state.generation);
        RestReminderState.Outcome g2 = RestReminderState.start(g1done.state, "rest-2", 60000L);
        check("连续两组：通知 id 不同", g2.state.notifId != g1.state.notifId);
        check("连续两组：第二组 id 更大", g2.state.notifId > g1.state.notifId);

        // ── 非正剩余时间 ───────────────────────────────────────
        RestReminderState.Outcome zero = RestReminderState.start(g2.state, "rest-3", 0L);
        check("零剩余：CANCEL", zero.action == RestReminderState.Outcome.Action.CANCEL);
        check("零剩余：token 清空", zero.state.token == null);

        // ── 非法输入 ───────────────────────────────────────────
        check("空 token 开始：NOOP",
            RestReminderState.start(empty, "", 60000L).action == RestReminderState.Outcome.Action.NOOP);
        check("空 token 广播：不提醒",
            !RestReminderState.shouldNotify(
                RestReminderState.onAlarmFired(g1.state, "", g1.state.generation)));

        // ── REVIEW-1 #3：consume API 已移除（假门禁），用反射确认不存在 ──
        boolean hasConsume = false;
        for (java.lang.reflect.Method m : RestReminderState.class.getDeclaredMethods()) {
            if (m.getName().equals("consume")) hasConsume = true;
        }
        check("consume API 已移除（避免假门禁）", !hasConsume);

        System.out.println();
        System.out.println("RestStateTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestStateTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestStateTest 全部通过");
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
