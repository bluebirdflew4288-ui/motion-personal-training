package app.motion.personal.plugins;

/**
 * 持久化**成功门禁**（第二轮预审 P1 #2，纯 JVM 可测）。
 *
 * <h2>问题</h2>
 * {@code SharedPreferences.apply()} 没有返回值、也不报错。旧实现直接认为
 * "transition 返回了就算持久化成功"，于是：
 * <ul>
 *   <li>B 状态写盘失败，但 schedule 仍返回 {@code scheduled:true}；</li>
 *   <li>进程重建后读到旧的 A → B 的广播因身份不符被丢弃 → 用户**收不到任何提醒**，</li>
 *   <li>且 App 之前已经告诉用户"已排程成功"（假报 durable 成功）。</li>
 * </ul>
 *
 * <h2>解法</h2>
 * 把"写盘"抽象成 {@link Sink}，由调用方用 {@code commit()}（同步、有布尔返回值）
 * 实现真正的写盘，并把结果交给本类判定：
 * <ul>
 *   <li>写盘成功 → 允许继续排程/发通知；</li>
 *   <li>写盘失败 → **不排程、不通知**，并返回明确失败原因（调用方据此上报 scheduled:false）。</li>
 * </ul>
 * 这样"durable 成功"才是真的：任何宣称已排程的路径都保证状态已落盘。
 */
public final class RestReminderGate {

    /** 真正的持久化出口：返回 true 表示已同步写盘成功 */
    public interface Sink {
        boolean commit(RestReminderState.Snapshot snapshot);
    }

    /** 门禁结果 */
    public static final class Result {
        public final boolean durable;
        public final RestReminderState.Outcome outcome;
        public final String failureReason;

        private Result(boolean durable, RestReminderState.Outcome outcome, String failureReason) {
            this.durable = durable;
            this.outcome = outcome;
            this.failureReason = failureReason;
        }

        /** 是否允许按 outcome 执行后续副作用（排程 / 发通知） */
        public boolean mayProceed() {
            return durable;
        }
    }

    /**
     * 执行一次状态迁移并**要求写盘成功**。
     *
     * @param sink 写盘出口（生产实现用 commit()；测试可注入失败）
     * @param fn   纯状态迁移函数
     */
    public static Result apply(
        Sink sink,
        RestReminderState.Snapshot current,
        java.util.function.Function<RestReminderState.Snapshot, RestReminderState.Outcome> fn
    ) {
        RestReminderState.Outcome outcome = fn.apply(current == null ? RestReminderState.Snapshot.empty() : current);
        if (outcome == null) {
            return new Result(false, null, "null-outcome");
        }
        // NOOP 不需要落盘（状态未变），也不产生副作用
        if (outcome.action == RestReminderState.Outcome.Action.NOOP && outcome.state == current) {
            return new Result(true, outcome, null);
        }
        boolean ok;
        try {
            ok = sink.commit(outcome.state);
        } catch (Exception e) {
            return new Result(false, outcome, "commit-exception:" + e.getClass().getSimpleName());
        }
        if (!ok) {
            // 写盘失败：明确失败，调用方不得排程/通知/假报成功
            return new Result(false, outcome, "commit-failed");
        }
        return new Result(true, outcome, null);
    }

    /**
     * 仅判断"这次结果是否允许发通知"：必须同时满足
     * ① 状态迁移要求提醒（reason=fire）；② 写盘成功（fired 已 durable）。
     * 少了 ②，进程重建后 fired 丢失 → 同一代次会重复提醒。
     */
    public static boolean mayNotify(Result r) {
        return r != null && r.durable && RestReminderState.shouldNotify(r.outcome);
    }

    private RestReminderGate() {}
}
