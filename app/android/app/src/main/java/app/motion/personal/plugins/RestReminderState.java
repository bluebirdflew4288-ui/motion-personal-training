package app.motion.personal.plugins;

/**
 * 组间休息提醒的**当前身份状态机**（纯 JVM，可离线测试）。
 *
 * <h2>身份 = token + generation + notifId</h2>
 * 只比 token 不够（第二轮预审 P1 #1）：同一次休息在「取消后重排」或
 * 「同 token 加长时间」时会复用同一个 token，于是**旧代次已入队的广播仍会命中新闹钟**，
 * 表现为提前响。因此每次 {@code start} 都必须推进 {@code generation}，
 * 并把 generation 一起写进 PendingIntent 的 extra；接收器端到端核验
 * token + generation 都相等才提醒。
 *
 * <h2>notifId（第二轮预审 P1 #3）</h2>
 * 固定通知 id + {@code setOnlyAlertOnce(true)} 会让"上一组通知还留在通知栏"时
 * 下一组不再震动。这里给每次排程分配一个**递增的通知 id**，
 * 保证连续两组各自独立提醒；去重靠身份核验，而不是压掉后续通知。
 *
 * <h2>不变量</h2>
 * <ul>
 *   <li>任何状态变更都由本类决定，调用方负责持久化（见 {@link RestReminderGate}）。</li>
 *   <li>取消后 generation 递增，所有旧广播/旧 consume 一律失效。</li>
 *   <li>fired 一旦为真，同一代次不再提醒（防重复投递与重建后重复）。</li>
 * </ul>
 */
public final class RestReminderState {

    /** 不可变快照 */
    public static final class Snapshot {
        /** 当前有效 token；null 表示没有进行中的提醒 */
        public final String token;
        /** 代次：每次排程/取消都 +1，用于让旧凭据失效 */
        public final long generation;
        /** 当前代次是否已提醒过 */
        public final boolean fired;
        /** 本次提醒使用的通知 id（每次排程递增，保证连续两组各自提醒） */
        public final int notifId;
        /**
         * 最近一次被接受的**用户新意图编号**（B4-R2）。
         *
         * <p>只用于一件事：区分"用户在归零后明确再加时"与"旧排程请求重放"。
         * 0 表示本次身份从未携带过新意图凭据（历史数据/旧调用）。
         * 见 {@link #startWithIntent}。
         */
        public final long lastIntentId;

        /**
         * 水位**归属的 token**（B4-R3 closure2 · D2 减时不清水位）。
         *
         * <p>为什么需要单独记：精确取消会把 {@code token} 清成 null
         * （表示"当前没有活跃身份"），但**水位仍属于那个计时**
         * （{@code lastIntentId} 必须保留，否则取消后旧编号复活）。
         * 只保留水位不保留"它属于谁"，下一次**同一 token** 的无编号排程
         * （−15 减时 / legacy）就会被当成"全新 token"而把水位重置成 0 ——
         * 于是旧正编号又能被接受（实测 FAIL：期望 3、实际 0）。
         *
         * <p>现在：取消后仍然记得水位属于哪个 token；
         * 同一 token 再次出现时继续沿用该水位（单调、不重置），
         * 真正**不同的 token** 才重新起算编号空间。
         */
        public final String lastIntentToken;

        public Snapshot(String token, long generation, boolean fired, int notifId) {
            this(token, generation, fired, notifId, 0L, null);
        }

        public Snapshot(String token, long generation, boolean fired, int notifId, long lastIntentId) {
            this(token, generation, fired, notifId, lastIntentId, null);
        }

        public Snapshot(
            String token,
            long generation,
            boolean fired,
            int notifId,
            long lastIntentId,
            String lastIntentToken
        ) {
            this.token = token;
            this.generation = generation;
            this.fired = fired;
            this.notifId = notifId;
            this.lastIntentId = lastIntentId;
            this.lastIntentToken = (lastIntentToken != null) ? lastIntentToken : token;
        }

        public static Snapshot empty() {
            return new Snapshot(null, 0L, false, 0, 0L, null);
        }
    }

    /** 操作结果：state 是**新状态**，action 告诉调用方要做什么 */
    public static final class Outcome {
        public enum Action {
            /** 需要排闹钟 */
            SCHEDULE,
            /** 需要取消闹钟 */
            CANCEL,
            /** 什么都不用做（陈旧/非法/已提醒） */
            NOOP,
        }

        public final Action action;
        public final Snapshot state;
        public final String reason;

        private Outcome(Action action, Snapshot state, String reason) {
            this.action = action;
            this.state = state;
            this.reason = reason;
        }

        static Outcome schedule(Snapshot s) {
            return new Outcome(Action.SCHEDULE, s, "ok");
        }

        static Outcome cancel(Snapshot s, String reason) {
            return new Outcome(Action.CANCEL, s, reason);
        }

        static Outcome noop(Snapshot s, String reason) {
            return new Outcome(Action.NOOP, s, reason);
        }
    }

    /**
     * 开始（或重排）一次休息提醒。
     *
     * <p>**每次调用都推进 generation**（P1 #1）：这样即使 token 不变
     * （同一次休息加时间、取消后重排），之前已入队/已排程的旧闹钟也会因代次不符被丢弃。
     */
    public static Outcome start(Snapshot cur, String token, long remainingMs) {
        return startWithIntent(cur, token, remainingMs, 0L);
    }

    /**
     * 开始/重排，并携带**用户新意图编号**（B4-R2 优先级一 #3）。
     *
     * <h2>要解决的问题</h2>
     * 归零后原生已经 fired（{@code fired=true}），用户点 +15。JS 侧控制器会先
     * 异步 cancel 旧身份再重排；但那条 cancel 是 fire-and-forget，**排程请求可能先到**。
     * 此时原生看到的是「同 token + fired=true」，旧规则一律 {@code already-fired} 拒绝，
     * 于是用户明确加出来的 15 秒**永远排不上**（真实失败路径）。
     *
     * <h2>为什么不能直接放开 already-fired</h2>
     * 直接放开会让**旧排程请求重放**也重新建立身份并再次响铃
     * （同一段休息被重复投递），这正是必须保住的门禁。
     *
     * <h2>本方法的规则（最小、可验证）</h2>
     * <ul>
     *   <li>{@code intentId <= 0}：没有明确新意图凭据 → **完全退回旧语义**，
     *       同 token + fired 仍然 {@code already-fired} 拒绝；</li>
     *   <li>{@code intentId > base.lastIntentId}：这是**更新的明确用户意图**
     *       → 允许在已 fired 的同一 token 上建立**新的可投递身份**
     *       （generation+1、fired=false、notifId+1），旧代次广播仍被代次核验挡掉；</li>
     *   <li>{@code intentId <= base.lastIntentId}：**旧请求重放/迟到请求**
     *       → {@code stale-intent} 拒绝，绝不重新响铃。</li>
     * </ul>
     *
     * <p>非 fired 的常规路径行为与 {@link #start} 完全一致（不改变既有语义），
     * 只额外记录本次意图编号，供后续重放判定。
     */
    public static Outcome startWithIntent(
        Snapshot cur, String token, long remainingMs, long intentId
    ) {
        Snapshot base = cur == null ? Snapshot.empty() : cur;
        if (token == null || token.isEmpty()) return Outcome.noop(base, "empty-token");
        if (remainingMs <= 0L) {
            // 已到点/非法：取消旧提醒，不建立新身份
            return Outcome.cancel(
                new Snapshot(null, base.generation + 1, false, base.notifId,
                    base.lastIntentId, base.lastIntentToken),
                "non-positive-delay"
            );
        }
        boolean sameToken = token.equals(base.token);
        if (sameToken && base.fired) {
            /**
             * 已 fired 的同 token：只有**更新的明确用户意图**才能建立新身份。
             * 没有凭据或凭据不更新 → 保持旧门禁（旧请求不得重新响铃）。
             */
            if (intentId <= 0L) return Outcome.noop(base, "already-fired");
            if (intentId <= base.lastIntentId) return Outcome.noop(base, "stale-intent");
            return Outcome.schedule(
                new Snapshot(token, base.generation + 1, false, base.notifId + 1,
                    intentId, token)
            );
        }
        /**
         * **未 fired 的同 token 重排**（B4-R3 D2-stale-intent-while-unfired）。
         *
         * <h2>旧实现的真实缺口</h2>
         * 旧代码只在 `fired` 时核验意图水位，未 fired 分支一律 SCHEDULE，
         * 于是**已消费过的旧编号**（同 token、编号 ≤ 水位）在这条路径上仍被接受，
         * 会覆盖当前好提醒的截止/代次 —— 旧请求重放换了个时机就能生效。
         *
         * <h2>现在的判定（与用户裁决一致）</h2>
         * <ul>
         *   <li>{@code intentId <= 0}：**没有编号** —— 这是 legacy 调用、自动恢复/接管，
         *       以及 **−15 减时**（JS 侧负加时明确不携带编号）的合法路径 →
         *       保持原有"允许重排"语义，绝不因为缺编号而拒绝；</li>
         *   <li>{@code intentId > 0 && intentId <= base.lastIntentId}：
         *       **显式携带了不更新的正编号**（等于或低于水位）→ 明确判定为旧意图重放，
         *       {@code stale-intent} 拒绝，**不动** token/generation/deadline；
         *       注意"**相等**"也算旧意图：水位一旦被消费，同编号不再代表新的用户意图；</li>
         *   <li>{@code intentId > base.lastIntentId}：真正的新意图 → 正常重排并推进水位。</li>
         * </ul>
         *
         * <p>这样「编号作用域」是明确的：**编号只对携带它的请求生效**，
         * 无编号路径（减时/legacy/恢复）不受影响，两者不会互相机械拒绝。
         */
        /**
         * **水位归属**（B4-R3 closure2 · D2）：
         * 精确取消把 {@code token} 清成 null，但水位仍属于**同一个计时的 token**。
         * 因此"同 token"与"取消后才回来的同 token（lineage）"都算同一编号空间：
         * 旧的**正编号重放**必须继续被拒，无编号的 −15/legacy 则照常允许。
         */
        boolean sameLineage = !sameToken
            && base.token == null
            && base.lastIntentToken != null
            && token.equals(base.lastIntentToken);
        if (intentId > 0L && (sameToken || sameLineage) && intentId <= base.lastIntentId) {
            return Outcome.noop(base, "stale-intent");
        }
        /**
         * 水位**按 token 作用域**（B4-R3 closure · D2 新 token 连续意图）。
         *
         * <h2>旧实现的真实缺口</h2>
         * 水位是全局单调的：旧 token A 的用户意图编号 20 会被
         * **新 token B** 继承。于是 B 用编号 1 合法启动后，
         * B 自己下一次 +15 的编号 2 仍被判成"≤ 水位 20" → {@code stale-intent}，
         * 用户在新一轮休息里**第一次加时就被拒**，而 UI 已经把截止延长
         * （界面 75s / 原生 60s 的实测分叉）。
         *
         * <h2>现在的语义</h2>
         * <ul>
         *   <li><b>换成新 token</b>（真正的新身份）→ 水位从**该 token 自己的编号**起算：
         *       携带编号则记该编号，未携带（legacy/自动恢复）则记 0。
         *       新身份不受旧 token 的历史编号约束；</li>
         *   <li><b>同 token</b> → 水位保持单调前进（旧编号一律拒绝，
         *       包括"相等"——那仍是旧意图重放）；</li>
         *   <li>无编号（{@code intentId <= 0}，含 −15 减时与 legacy 调用）→ **不推进水位**。</li>
         * </ul>
         *
         * <p>这不弱化 same-token 的旧请求防护，也不是"为旧 token 重放清水位"：
         * 旧 token 的正编号请求在**它自己那一轮**仍然会被拒；
         * 只是新 token 的编号空间从 1 重新开始。
         */
        long nextIntent;
        if (!sameToken && !sameLineage) {
            // 真正**不同的 token**：编号作用域跟着新 token 走
            nextIntent = intentId > 0L ? intentId : 0L;
        } else {
            // 同一编号空间（含取消后回流的同 token）：水位单调，不清零
            nextIntent = intentId > base.lastIntentId ? intentId : base.lastIntentId;
        }
        return Outcome.schedule(
            new Snapshot(token, base.generation + 1, false, base.notifId + 1,
                nextIntent, token)
        );
    }

    /**
     * 取消（暂停 / 跳过 / 结束训练）。
     * generation 递增 → 所有旧广播失效。
     */
    public static Outcome cancel(Snapshot cur) {
        Snapshot base = cur == null ? Snapshot.empty() : cur;
        /**
         * 保留 lastIntentId：取消只让**代次**失效，不清除"用户意图水位"。
         * 若清掉，取消后重排同一 token 的旧意图编号会再次被当作"新意图"接受，
         * 削弱重放防护。水位只能单调前进。
         */
        return Outcome.cancel(
            new Snapshot(null, base.generation + 1, false, base.notifId,
                base.lastIntentId, base.lastIntentToken),
            "cancelled"
        );
    }

    /**
     * 接收器收到广播时判断是否该真的提醒（P1 #1 端到端核验）。
     *
     * <p>四重核验，缺一不可：
     * <ol>
     *   <li>当前存在有效 token；</li>
     *   <li>广播 token 与当前 token **一致**；</li>
     *   <li>广播 generation 与当前 generation **一致**（旧代次广播丢弃）；</li>
     *   <li>当前代次尚未提醒过。</li>
     * </ol>
     * 通过后返回 fired=true 的新状态，调用方必须**持久化成功**才允许发通知。
     */
    public static Outcome onAlarmFired(Snapshot cur, String incomingToken, long incomingGeneration) {
        Snapshot base = cur == null ? Snapshot.empty() : cur;
        if (incomingToken == null || incomingToken.isEmpty()) return Outcome.noop(base, "empty-token");
        if (base.token == null) return Outcome.noop(base, "no-active-token");
        if (!base.token.equals(incomingToken)) return Outcome.noop(base, "stale-broadcast-token");
        if (incomingGeneration != base.generation) return Outcome.noop(base, "stale-broadcast-generation");
        if (base.fired) return Outcome.noop(base, "already-fired");
        return new Outcome(
            Outcome.Action.NOOP, // 接收器无需再排/取消，只需持久化 fired
            new Snapshot(base.token, base.generation, true, base.notifId,
                base.lastIntentId, base.lastIntentToken),
            "fire"
        );
    }

    /**
     * **带身份的取消**（REVIEW-1 #1 / 第二轮 P1 #1）。
     *
     * <p>无参数 cancel 的问题：旧 A 的取消请求延迟到达时，B 可能已经排程，
     * 于是"取消 A"实际取消了 B。这里要求调用方携带 token + generation：
     * <ul>
     *   <li>两者都匹配当前代次 → 真正取消（代次 +1）；</li>
     *   <li>不匹配（陈旧请求）→ NOOP，**绝不动当前提醒**；</li>
     *   <li>未提供身份（hasIdentity=false）→ 按"取消当前"处理，供结束训练等显式全清。</li>
     * </ul>
     *
     * <p><b>参数方向必须与调用方一致</b>：插件侧传的是 {@code id.hasIdentity}，
     * 曾因写成 {@code !withIdentity} 导致无参 stop 被拒、陈旧身份反而全清（REVIEW-1 #1）。
     * {@code RestCallArgsTest} 用真实参数形态锁住了这个方向。
     */
    public static Outcome cancelIfCurrent(
        Snapshot cur,
        String token,
        long generation,
        boolean hasIdentity
    ) {
        Snapshot base = cur == null ? Snapshot.empty() : cur;
        if (!hasIdentity) {
            // 显式无身份取消：取消当前（调用方明确要求全清）
            return cancel(base);
        }
        if (token == null || token.isEmpty()) return Outcome.noop(base, "empty-token");
        if (base.token == null) return Outcome.noop(base, "no-active-token");
        if (!base.token.equals(token)) return Outcome.noop(base, "stale-token");
        if (generation != base.generation) return Outcome.noop(base, "stale-generation");
        return cancel(base);
    }

    /** 该结果是否表示"应当真的发通知" */
    public static boolean shouldNotify(Outcome o) {
        return o != null && "fire".equals(o.reason);
    }

    private RestReminderState() {}
}
