package app.motion.personal.plugins;

/**
 * 把 {@code PluginCall} 的原始 options **转换成取消/消费所需的身份**（纯 JVM，可离线测试）。
 *
 * <h2>为什么单独抽出来</h2>
 * 预审 REVIEW-1 第 1 项指出：插件里
 * {@code cancelIfCurrent(cur, token, gen, !withIdentity)} 把布尔**接反**了 ——
 * 无参 stop/finish 被当成"有身份"→ empty-token 拒绝；
 * 带陈旧身份反而被当成"无身份"→ 全清当前提醒。
 * 这类错误出在**参数转换层**，只在 {@link RestReminderState} 上断言发现不了。
 *
 * 因此把"原始 JSON 对象 → (token, generation, hasIdentity)"的转换独立成这个纯类，
 * 让测试能真实覆盖：无身份、完整身份、只有 token、只有 generation、
 * 字符串数字、非法数字等所有实际来源形态。
 */
public final class RestCallArgs {

    /** 解析后的身份参数 */
    public static final class Identity {
        /** token；非法或缺失为 null */
        public final String token;
        /** 代次；未提供时为 {@link #NO_GENERATION} */
        public final long generation;
        /** 是否构成**完整身份**（token 与 generation 都有效） */
        public final boolean hasIdentity;

        static final long NO_GENERATION = Long.MIN_VALUE;

        private Identity(String token, long generation, boolean hasIdentity) {
            this.token = token;
            this.generation = generation;
            this.hasIdentity = hasIdentity;
        }

        /** 无身份（调用方要求显式全清） */
        public static Identity none() {
            return new Identity(null, NO_GENERATION, false);
        }

        public static Identity of(String token, long generation) {
            boolean ok = token != null && !token.isEmpty() && generation != NO_GENERATION;
            return new Identity(token, generation, ok);
        }
    }

    /**
     * 从 {@code PluginCall.getData()} 的两个原始值解析身份。
     *
     * <p>规则：
     * <ul>
     *   <li>token 与 generation **都有效** → hasIdentity=true；</li>
     *   <li>任一项缺失/非法 → hasIdentity=false（此时调用方视为"显式全清"）；</li>
     *   <li>generation 接受 Number 与数字字符串（JS 侧可能是 Integer/Double/string）。</li>
     * </ul>
     *
     * @param rawToken      原始 token 对象
     * @param rawGeneration 原始 generation 对象
     */
    public static Identity parse(Object rawToken, Object rawGeneration) {
        String token = RestArgs.tokenOrNull(rawToken);
        if (token == null) return Identity.none();

        Long gen = parseGeneration(rawGeneration);
        if (gen == null) return Identity.none();

        return Identity.of(token, gen);
    }

    /** 解析 generation；接受 Number 与数字字符串，其余返回 null */
    public static Long parseGeneration(Object raw) {
        if (raw == null) return null;
        if (raw instanceof Boolean) return null;
        if (raw instanceof Number) {
            double d = ((Number) raw).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return null;
            if (d != Math.rint(d)) return null;
            return (long) d;
        }
        if (raw instanceof CharSequence) {
            String t = raw.toString().trim();
            if (t.isEmpty()) return null;
            try {
                return Long.parseLong(t);
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private RestCallArgs() {}
}
