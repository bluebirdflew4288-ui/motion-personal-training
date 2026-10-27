package app.motion.personal.plugins;

/**
 * Capacitor {@code PluginCall} 数值参数的**安全解析**（纯 JVM，可离线测试）。
 *
 * <h2>为什么必须自己解析</h2>
 * 预审发现：Capacitor 8.5.3 的 {@code PluginCall.getLong(name)} 只接受
 * {@code java.lang.Long} 实例，其余一律返回 null（见 PluginCall.java:196-206）。
 * 而 JS 传来的 60000 / 120000 / 180000 经 JSON 解析后是 {@code Integer}，
 * 于是 {@code getLong} 恒为 null → 剩余时间被当成 0 → 判定 non-positive-delay →
 * **提醒永远排不上**。这是真实桥接缺陷，不是理论问题。
 *
 * <p>本类按"实际 JSON 可能给出的类型"逐类兼容：Integer / Long / Double / Float /
 * Short / Byte / 数字字符串，并统一做有限性、整数性、正负与上限校验。
 * 非法输入一律返回明确的 {@link Result#ok}=false，由调用方如实上报，
 * 绝不静默当成 0 或旧值。
 */
public final class RestArgs {

    /** 剩余毫秒的上限：24 小时。超过它必然是客户端算错，明确拒绝而不是排一个荒唐的闹钟。 */
    public static final long MAX_REMAINING_MS = 24L * 60L * 60L * 1000L;

    /** 解析结果：ok=false 时 message 说明具体原因（用于日志/上报，不直接给用户） */
    public static final class Result {
        public final boolean ok;
        public final long value;
        public final String message;

        private Result(boolean ok, long value, String message) {
            this.ok = ok;
            this.value = value;
            this.message = message;
        }

        static Result ok(long v) {
            return new Result(true, v, null);
        }

        static Result fail(String m) {
            return new Result(false, 0L, m);
        }
    }

    /**
     * 把"JS 可能传来的任意数字对象"解析为正的毫秒数。
     *
     * @param raw 直接来自 {@code PluginCall.getData().opt(name)} 的对象
     */
    public static Result parseRemainingMs(Object raw) {
        if (raw == null) return Result.fail("missing");
        if (raw instanceof Boolean) return Result.fail("boolean");

        double d;
        if (raw instanceof Integer) {
            d = ((Integer) raw).doubleValue();
        } else if (raw instanceof Long) {
            d = ((Long) raw).doubleValue();
        } else if (raw instanceof Short) {
            d = ((Short) raw).doubleValue();
        } else if (raw instanceof Byte) {
            d = ((Byte) raw).doubleValue();
        } else if (raw instanceof Double) {
            d = (Double) raw;
        } else if (raw instanceof Float) {
            d = ((Float) raw).doubleValue();
        } else if (raw instanceof Number) {
            // 兜底：其它 Number 实现（如 BigInteger/BigDecimal 的 doubleValue）
            d = ((Number) raw).doubleValue();
        } else if (raw instanceof CharSequence) {
            String t = raw.toString().trim();
            if (t.isEmpty()) return Result.fail("empty-string");
            try {
                d = Double.parseDouble(t);
            } catch (NumberFormatException e) {
                return Result.fail("not-a-number");
            }
        } else {
            return Result.fail("unsupported-type:" + raw.getClass().getSimpleName());
        }

        // 有限性：NaN / ±Infinity 都不能排程
        if (Double.isNaN(d) || Double.isInfinite(d)) return Result.fail("not-finite");
        // 整数性：毫秒必须是整数（6.5ms 没有意义，且说明客户端算错）
        if (d != Math.rint(d)) return Result.fail("not-integer");
        if (d <= 0d) return Result.fail("non-positive");
        if (d > (double) MAX_REMAINING_MS) return Result.fail("too-large");

        return Result.ok((long) d);
    }

    /**
     * 解析"发起时的绝对目标截止"（B4-R2 优先级一 #1，可选参数）。
     *
     * <p>为什么需要：JS 侧在**用户点击那一刻**就开始倒计时，而插件在自己的
     * 执行时刻才用 {@code System.currentTimeMillis() + remainingMs} 建截止，
     * 于是 JS→Plugin 的排队耗时被原样加进休息时长 —— 用户看到"UI 已归零、
     * 过一会才响"。带上发起目标截止后，原生按它扣掉排队耗时。
     *
     * <p>校验必须严格：非有限/非正/远超上限一律视为**不可用**（返回 null），
     * 由调用方退回"剩余量"旧语义，绝不拿荒唐值去建闹钟。
     *
     * @return 合法的墙钟毫秒；null 表示未提供或不可用
     */
    public static Long parseDeadlineAtMsOrNull(Object raw) {
        if (raw == null) return null;
        double d;
        if (raw instanceof Number) {
            d = ((Number) raw).doubleValue();
        } else if (raw instanceof CharSequence) {
            String t = raw.toString().trim();
            if (t.isEmpty()) return null;
            try {
                d = Double.parseDouble(t);
            } catch (NumberFormatException e) {
                return null;
            }
        } else {
            return null;
        }
        if (Double.isNaN(d) || Double.isInfinite(d)) return null;
        if (d <= 0d) return null;
        // 上限：当前墙钟 + 24h 的宽松边界（超出必然是客户端算错）
        long now = System.currentTimeMillis();
        if (d > (double) (now + MAX_REMAINING_MS)) return null;
        return (long) d;
    }

    /**
     * 截止参数的**三态**（B4-R3 D2-invalid-deadline）。
     *
     * <h2>为什么不能只用 {@link #parseDeadlineAtMsOrNull}</h2>
     * 旧实现把「**没传**」和「**传了但非法**」都折成 {@code null}，
     * 于是显式非法截止（例如字符串 {@code "not-a-number"}）会被静默当成缺省，
     * 退回「入口时刻 + remainingMs」重新起算 —— 等于**用非法输入伪造了一条新截止**，
     * 还顺带清掉当前好提醒。真值语义必须区分：
     * <ul>
     *   <li>{@link DeadlineKind#ABSENT}：调用方确实没给（旧调用/自动恢复）→ 允许兼容 fallback；</li>
     *   <li>{@link DeadlineKind#VALID}：给了合法值 → 必须尊重它；</li>
     *   <li>{@link DeadlineKind#INVALID}：**给了但不可用**（含显式 JSON null）→ 必须显式拒绝，不 fallback。</li>
     * </ul>
     *
     * <p>JSON 的 {@code null} 视同缺省（{@code JSONObject.NULL} 的 {@code toString()} 是
     * {@code "null"}，且它既不是 Number 也不是 CharSequence），
     * 这样「客户端显式写 null」不会被误判成非法值。
     */
    public enum DeadlineKind { ABSENT, VALID, INVALID }

    /** 截止解析结果（三态 + 合法值） */
    public static final class Deadline {
        public final DeadlineKind kind;
        /** 仅 kind=VALID 时非 null */
        public final Long value;

        private Deadline(DeadlineKind kind, Long value) {
            this.kind = kind;
            this.value = value;
        }

        public boolean isAbsent() {
            return kind == DeadlineKind.ABSENT;
        }

        public boolean isInvalid() {
            return kind == DeadlineKind.INVALID;
        }
    }

    /**
     * 区分「缺省 / 合法 / 显式非法」。
     *
     * <p>规则（纯 JVM，可离线测试）：
     * <ul>
     *   <li><b>Java {@code null}</b>（字段**根本没提供**）→ ABSENT；</li>
     *   <li><b>JSON {@code null}</b>（字段提供了、值就是 null）→ <b>INVALID</b>；</li>
     *   <li>能被 {@link #parseDeadlineAtMsOrNull} 解析成合法墙钟 → VALID；</li>
     *   <li>其余（非法字符串、Boolean、NaN、0、负数、超上限、对象/数组）→ INVALID。</li>
     * </ul>
     *
     * <h2>为什么 JSON null 必须算 INVALID（Codex 产品裁决）</h2>
     * 旧实现把 JSON null 也折成"没提供"，于是 {@code deadlineAtMs:null}
     * 会退回"入口时刻 + remainingMs"重新起算 —— 等于用**一个不可用的值**
     * 悄悄伪造了一条新截止，还会覆盖当前好提醒。
     * 产品裁决：<b>只有字段真正缺省才允许兼容 fallback</b>；
     * 显式给了 null 与 {@code 0 / true / 非法字符串} 同类，应明确拒绝并保留当前好身份。
     *
     * <p>区分方式（不依赖 org.json，保持本类纯 JVM）：Capacitor 的
     * {@code JSONObject.opt(name)} 在"字段不存在"时返回 Java null，
     * 在"字段存在但为 null"时返回 {@code JSONObject.NULL}（一个非 Number、
     * 非 CharSequence 且 {@code toString()} 为 {@code "null"} 的单例对象）。
     * 因此：Java null → ABSENT；其余一切非标量对象（含 JSON NULL）→ INVALID。
     */
    public static Deadline classifyDeadline(Object raw) {
        // 字段不存在：唯一允许兼容 fallback 的情形
        if (raw == null) return new Deadline(DeadlineKind.ABSENT, null);
        Long v = parseDeadlineAtMsOrNull(raw);
        return v != null
            ? new Deadline(DeadlineKind.VALID, v)
            : new Deadline(DeadlineKind.INVALID, null);
    }

    /**
     * 计算**目标绝对墙钟时刻**（B4-R3 closure2 · D1）。
     *
     * <h2>要解决的第二个耗时来源</h2>
     * 旧实现先算 {@code effectiveRemaining}（已扣掉 JS→Plugin 排队耗时），
     * 但随后在**身份 commit / 写盘之后**才用 {@code now + scheduledMs} 建闹钟、
     * 用 {@code elapsedRealtime() + scheduledMs} 建服务单调截止 ——
     * 于是这段**原生处理耗时**又被加回休息时长
     * （实测：commit 注入 150ms → 闹钟与 service 都晚 163ms；ingress 1000ms → drift 16ms）。
     *
     * <p>规则（与产品裁决一致）：
     * <ul>
     *   <li>带合法 {@code deadlineAtMs}：目标就是它本身（调用方点击时刻定的绝对截止）；</li>
     *   <li>字段缺省（兼容 fallback）：{@code 入口时刻 + remainingMs}，同样在**入口处**定死，
     *       后续处理耗时不再累加；</li>
     *   <li>显式 null / 坏值：由 {@link #classifyDeadline} 在更早处拒绝，不会走到这里。</li>
     * </ul>
     *
     * @param entryWallMs 方法入口时刻的墙钟毫秒（在任何 commit/写盘之前取）
     * @param remainingMs 调用方给出的剩余毫秒
     * @param deadlineAtMs 合法绝对截止；null 表示字段缺省
     */
    public static long targetWallAt(long entryWallMs, long remainingMs, Long deadlineAtMs) {
        if (deadlineAtMs != null) return deadlineAtMs.longValue();
        return entryWallMs + remainingMs;
    }

    /**
     * 由目标绝对墙钟换算**服务单调截止**（elapsedRealtime 基准）。
     *
     * <p>必须用"派发时刻的实际剩余"换算，才能与同一个墙钟目标对应；
     * 直接 {@code elapsedNow + 早期剩余量} 会把处理耗时加回来。
     */
    public static long monotonicDeadlineAt(long nowWallMs, long nowElapsedMs, long targetWallMs) {
        long left = targetWallMs - nowWallMs;
        if (left < 0L) left = 0L;
        return nowElapsedMs + left;
    }

    /**
     * 按**发起目标截止**算出真正要用的剩余量，并扣掉入口排队耗时。
     *
     * <p>规则：
     * <ul>
     *   <li>未提供合法截止 → 原样返回 remainingMs（旧语义，兼容路径）；</li>
     *   <li>截止早于入口时刻（已过期）→ 返回 0，让上层按"已到点"处理，
     *       <b>不得</b>把剩余量夹成 1ms 去补一个假提醒；</li>
     *   <li>否则 → {@code deadline - now}，即扣掉排队耗时后的真实剩余。</li>
     * </ul>
     *
     * <p>注意：返回值只用于**建闹钟/服务截止**，状态机里的身份仍由
     * {@code RestReminderState} 决定，两者不混。
     */
    public static long effectiveRemaining(long remainingMs, Long deadlineAtMs, long nowWallMs) {
        if (deadlineAtMs == null) return remainingMs;
        long left = deadlineAtMs - nowWallMs;
        if (left <= 0L) return 0L;
        return left;
    }

    /** token 长度上限：防止异常长的 extra 撑爆 Intent / Bundle */
    public static final int MAX_TOKEN_LEN = 128;

    /**
     * 解析 token：必须是非空、长度受限的字符串。
     * 返回 null 表示非法（调用方必须据此拒绝，而不是继续用空 token 排程）。
     */
    public static String tokenOrNull(Object raw) {
        if (raw == null || !(raw instanceof CharSequence)) return null;
        String t = raw.toString().trim();
        if (t.isEmpty() || t.length() > MAX_TOKEN_LEN) return null;
        return t;
    }

    private RestArgs() {}
}
