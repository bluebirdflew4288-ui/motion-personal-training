package app.motion.personal.plugins;

/**
 * F11 删除成功音的**纯策略判定**（纯 JVM，不 import Android API，可离线单测）。
 *
 * <h2>为什么把判定从插件里剥出来</h2>
 * "现在能不能真的出声"由多个真实系统事实共同决定：铃声模式、勿扰过滤档、
 * 当前 Activity 是否还在前台、对应音频流的真实音量、音效是否已经加载完成。
 * 把这些事实作为**入参**交给本类，宿主测试就能覆盖完整矩阵，
 * 而不是在报告里手写"应该没问题"。
 *
 * <h2>保守原则</h2>
 * 只有**已知允许**才 allow：
 * <ul>
 *   <li>铃声模式必须是 {@link #RINGER_NORMAL}（静音/振动都不出声）；</li>
 *   <li>勿扰过滤档必须是 {@link #FILTER_ALL}（优先级/仅闹钟/完全静音都算未全部允许）；</li>
 *   <li>查询返回 null 或未知值（{@link #FILTER_UNKNOWN}、超范围数值）一律当作不允许；</li>
 *   <li>对应音频流音量必须**已知且大于 0**；</li>
 *   <li>Activity 必须在 resumed 状态（后台不补放）；</li>
 *   <li>音效必须已经加载完成（加载中不得先响）。</li>
 * </ul>
 * 任何一项查不到 → 不播。宁可少一声，也不能在静音/勿扰/后台里擅自出声。
 *
 * <p><b>边界</b>：本类只做判定，不读系统、不改音量、不改勿扰、不改渠道。
 * 常量用字面值而不是 {@code AudioManager.RINGER_MODE_*} / {@code NotificationManager.INTERRUPTION_FILTER_*}，
 * 是为了让纯 JVM 测试在没有 android.jar 的宿主上也能编译运行；
 * 数值取自官方文档，插件侧用 Android 常量对照（见 DeleteFeedbackPolicyTest 的对照断言）。
 */
public final class DeleteFeedbackPolicy {

    // ── AudioManager.RINGER_MODE_*（官方文档字面值）──────────────
    public static final int RINGER_SILENT = 0;
    public static final int RINGER_VIBRATE = 1;
    public static final int RINGER_NORMAL = 2;

    // ── NotificationManager.INTERRUPTION_FILTER_*（官方文档字面值）──
    /** {@code getCurrentInterruptionFilter()} 无法判定时的返回值（官方：unknown） */
    public static final int FILTER_UNKNOWN = 0;
    public static final int FILTER_ALL = 1;
    public static final int FILTER_PRIORITY = 2;
    public static final int FILTER_NONE = 3;
    public static final int FILTER_ALARMS = 4;

    /** 允许播放（已知全部条件满足） */
    public static final String ALLOW = "allow-normal";

    public static final String SKIP_ACTIVITY_NOT_RESUMED = "activity-not-resumed";
    public static final String SKIP_RINGER_UNKNOWN = "ringer-unknown";
    public static final String SKIP_RINGER_SILENT = "ringer-silent";
    public static final String SKIP_RINGER_VIBRATE = "ringer-vibrate";
    public static final String SKIP_DND_UNKNOWN = "dnd-unknown";
    public static final String SKIP_DND_ACTIVE = "dnd-active";
    public static final String SKIP_VOLUME_UNKNOWN = "stream-volume-unknown";
    public static final String SKIP_VOLUME_ZERO = "stream-volume-zero";
    public static final String SKIP_SOUND_NOT_READY = "sound-not-ready";
    public static final String SKIP_INTENT_STALE = "intent-stale";
    public static final String SKIP_NO_AUDIO_SERVICE = "no-audio-service";

    // ── 触感（F09 准备震动）──────────────
    public static final String HAPTIC_ALLOW = "haptic-allow";
    public static final String HAPTIC_SKIP_NO_VIBRATOR = "no-vibrator";
    public static final String HAPTIC_SKIP_ACTIVITY_NOT_RESUMED = "haptic-activity-not-resumed";
    public static final String HAPTIC_SKIP_RINGER_SILENT = "haptic-ringer-silent";
    public static final String HAPTIC_SKIP_STATE_UNKNOWN = "haptic-state-unknown";
    public static final String HAPTIC_SKIP_DND_ACTIVE = "haptic-dnd-active";

    /** 判定结果 */
    public static final class Decision {
        public final boolean allow;
        /** allow 时为 {@link #ALLOW} / {@link #HAPTIC_ALLOW}；否则是稳定原因字符串 */
        public final String reason;

        private Decision(boolean allow, String reason) {
            this.allow = allow;
            this.reason = reason;
        }

        static Decision allow(String reason) {
            return new Decision(true, reason);
        }

        static Decision skip(String reason) {
            return new Decision(false, reason);
        }
    }

    /**
     * 成功音是否允许播放。
     *
     * @param ringerMode           AudioManager.getRingerMode()；未知传 null
     * @param interruptionFilter   NotificationManager.getCurrentInterruptionFilter()；未知传 null
     * @param activityResumed      Activity 是否处于 resumed（前台）
     * @param systemStreamVolume   AudioManager.getStreamVolume(STREAM_SYSTEM)；未知传 null
     * @param soundReady           SoundPool 是否已 load 完成
     */
    public static Decision decideSound(
        Integer ringerMode,
        Integer interruptionFilter,
        Boolean activityResumed,
        Integer systemStreamVolume,
        boolean soundReady
    ) {
        if (!Boolean.TRUE.equals(activityResumed)) return Decision.skip(SKIP_ACTIVITY_NOT_RESUMED);
        if (ringerMode == null) return Decision.skip(SKIP_RINGER_UNKNOWN);
        if (ringerMode == RINGER_SILENT) return Decision.skip(SKIP_RINGER_SILENT);
        if (ringerMode == RINGER_VIBRATE) return Decision.skip(SKIP_RINGER_VIBRATE);
        if (ringerMode != RINGER_NORMAL) return Decision.skip(SKIP_RINGER_UNKNOWN);
        if (interruptionFilter == null) return Decision.skip(SKIP_DND_UNKNOWN);
        if (interruptionFilter == FILTER_ALL) {
            // 通过
        } else if (interruptionFilter == FILTER_UNKNOWN
            || interruptionFilter < FILTER_ALL
            || interruptionFilter > FILTER_ALARMS) {
            return Decision.skip(SKIP_DND_UNKNOWN);
        } else {
            return Decision.skip(SKIP_DND_ACTIVE);
        }
        if (systemStreamVolume == null) return Decision.skip(SKIP_VOLUME_UNKNOWN);
        if (systemStreamVolume <= 0) return Decision.skip(SKIP_VOLUME_ZERO);
        if (!soundReady) return Decision.skip(SKIP_SOUND_NOT_READY);
        return Decision.allow(ALLOW);
    }

    /**
     * F09 准备触感是否允许。
     *
     * <p>比成功音保守得多的理由：触感是"手势已就绪"的辅助提示，
     * 静音/勿扰下用户已经明确表示不要被打断，所以只在铃声正常且勿扰全部放行时才震；
     * 未知状态一律不震（页面上仍有明确的文字提示）。
     */
    public static Decision decideHaptic(
        Integer ringerMode,
        Integer interruptionFilter,
        Boolean activityResumed,
        boolean hasVibrator
    ) {
        if (!hasVibrator) return Decision.skip(HAPTIC_SKIP_NO_VIBRATOR);
        if (!Boolean.TRUE.equals(activityResumed)) return Decision.skip(HAPTIC_SKIP_ACTIVITY_NOT_RESUMED);
        if (ringerMode == null) return Decision.skip(HAPTIC_SKIP_STATE_UNKNOWN);
        if (ringerMode == RINGER_SILENT) return Decision.skip(HAPTIC_SKIP_RINGER_SILENT);
        if (ringerMode != RINGER_NORMAL) return Decision.skip(HAPTIC_SKIP_STATE_UNKNOWN);
        if (interruptionFilter == null) return Decision.skip(HAPTIC_SKIP_STATE_UNKNOWN);
        if (interruptionFilter == FILTER_ALL) return Decision.allow(HAPTIC_ALLOW);
        if (interruptionFilter == FILTER_UNKNOWN
            || interruptionFilter < FILTER_ALL
            || interruptionFilter > FILTER_ALARMS) {
            return Decision.skip(HAPTIC_SKIP_STATE_UNKNOWN);
        }
        return Decision.skip(HAPTIC_SKIP_DND_ACTIVE);
    }

    /** 准备触感的震动时长（毫秒）；与 F09 方案一致：轻、短、一次 */
    public static final int PREPARE_VIBRATE_MS = 20;

    private DeleteFeedbackPolicy() {}
}
