package app.motion.personal.plugins;

/**
 * 系统设置跳转的**受限目标枚举**（纯 JVM，可离线测试）。
 *
 * <h2>为什么单独抽出来</h2>
 * 宿主测试无法加载 {@code RestReminderPlugin}（它依赖 Android API）。
 * 把"目标枚举 + wire 解析 + fallback 顺序"这些**安全关键判定**放在纯类里，
 * 就能在 JVM 上真实执行，而不是在报告里手写结论。
 *
 * <h2>安全边界</h2>
 * <ul>
 *   <li>只接受三个对外 wire 值；未知/空/任意 action/URI **一律 fail closed**；</li>
 *   <li>{@link #DETAILS_FALLBACK} 是**内部兜底**，不接受外部请求
 *       （否则可绕过"先目标再兜底"的顺序直跳详情页）；</li>
 *   <li>包名与渠道名不在此处传入，由 Plugin 固定取本 App 常量。</li>
 * </ul>
 */
public final class RestSettingsTargets {

    /** 对外可请求的目标 */
    public enum Target {
        APP_NOTIFICATIONS("app-notifications"),
        REST_CHANNEL("rest-channel"),
        EXACT_ALARM("exact-alarm"),
        /**
         * 内部兜底：本 App 详情页。
         * **不接受** JS 传入（见 {@link #fromWire}）。
         */
        DETAILS_FALLBACK("app-details");

        public final String wire;

        Target(String wire) {
            this.wire = wire;
        }
    }

    /** 解析 JS 传入的 wire 目标；任何非法输入返回 null（fail closed） */
    public static Target fromWire(String raw) {
        if (raw == null) return null;
        if (DETAILS_FALLBACK_WIRE.equals(raw)) return null; // 内部目标不对外
        for (Target t : Target.values()) {
            if (t.wire.equals(raw)) return t;
        }
        return null;
    }

    private static final String DETAILS_FALLBACK_WIRE = "app-details";

    /**
     * fallback 候选链（按优先级）。
     *
     * <p>规则：目标 → （非通知页时）App 通知页 → 本 App 详情页。
     * 这样低 SDK 或缺目标时仍有合理降级，且**实际打开的目标会如实返回**。
     */
    public static Target[] fallbackChain(Target target) {
        if (target == Target.DETAILS_FALLBACK) {
            return new Target[] { Target.DETAILS_FALLBACK };
        }
        if (target == Target.APP_NOTIFICATIONS) {
            return new Target[] { Target.APP_NOTIFICATIONS, Target.DETAILS_FALLBACK };
        }
        return new Target[] { target, Target.APP_NOTIFICATIONS, Target.DETAILS_FALLBACK };
    }

    private RestSettingsTargets() {}
}
