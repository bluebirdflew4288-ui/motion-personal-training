package app.motion.personal.plugins;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.SystemClock;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 需求 2：组间休息到时的**原生**提醒（后台 / 锁屏可靠）。
 *
 * <h2>为什么必须是原生</h2>
 * 页面 JS interval 在后台会被节流/冻结，靠它数到 0 再震动，锁屏/切走后必然不准时。
 * 这里用 {@link AlarmManager} 在绝对时刻投递广播，由 {@link RestAlarmReceiver} 提醒，
 * 与页面是否存活无关。
 *
 * <h2>能力边界（不夸大）</h2>
 * <ul>
 *   <li><b>普通后台/锁屏</b>：{@code setExactAndAllowWhileIdle} + 精确闹钟权限可提高准点概率，
 *       <b>但不存在"秒级可靠"保证</b> —— allowWhileIdle 受系统频率限制，
 *       深 Doze/OEM 后台策略仍可能推迟甚至拦截。本条按 A2 复核修正措辞。</li>
 *   <li><b>深度 Doze</b>：系统限制 allowWhileIdle 闹钟频率（约 9 分钟/应用），
 *       60–180 秒连续准点<b>不能承诺</b>；本插件如实返回 {@code dozeCaveat:true}。</li>
 *   <li><b>通知不可达</b>：见 {@link RestAlarmReceiver} —— 后台震动不是可靠兜底，
 *       不宣称"拒绝通知后仍能震动"。</li>
 * </ul>
 *
 * <h2>一致性（第二轮预审 P1 #1/#2/#3）</h2>
 * <ul>
 *   <li>每次排程推进 generation 并写入 PendingIntent，接收器端到端核验
 *       token + generation，旧代次广播一律丢弃；</li>
 *   <li>状态变更必须 {@code commit()} 写盘成功才继续（{@link RestReminderGate}），
 *       否则不排程并返回真实失败；</li>
 *   <li>每次排程使用**递增通知 id**，连续两组各自提醒，不靠压制后续通知去重。</li>
 * </ul>
 */
@CapacitorPlugin(
    name = "RestReminder",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class RestReminderPlugin extends Plugin {

    /** 通知渠道：只震动、不强制声音 */
    static final String CHANNEL_ID = "motion-rest-timer";
    /** 广播 action */
    static final String ACTION_REST_DONE = "app.motion.personal.REST_DONE";
    /** Intent extra：休息 token */
    static final String EXTRA_TOKEN = "token";
    /** Intent extra：代次（端到端核验，防旧广播命中新闹钟） */
    static final String EXTRA_GENERATION = "generation";
    /** 请求码基数：每个代次用不同 requestCode，避免 PendingIntent 互相覆盖 */
    static final int REQUEST_CODE_BASE = 4200;

    @Override
    public void load() {
        ensureChannel();
        RestReminderStore.setUserCancelListener((cancelledToken, cancelledGen) -> {
            if (getBridge() == null) return;
            getBridge().executeOnMainThread(() -> {
                try {
                    JSObject ev = new JSObject();
                    ev.put("token", cancelledToken);
                    ev.put("generation", cancelledGen);
                    notifyListeners("userCancelled", ev);
                    if (getBridge().getWebView() != null) {
                        String safeTok = org.json.JSONObject.quote(cancelledToken);
                        getBridge().getWebView().evaluateJavascript(
                            "try{window.dispatchEvent(new CustomEvent('motion:rest-user-cancelled',{detail:{token:"
                                + safeTok + ",generation:" + cancelledGen + "}}));}catch(e){}",
                            null
                        );
                    }
                } catch (Exception ignored) {
                    // 唤醒通知失败不影响持久化状态，前台对账仍可由 inspectIdentity 兜底
                }
            });
        });
    }

    /**
     * 建立通知渠道（幂等）。
     *
     * <p><b>Android 7.x 兼容（第二轮预审 P1 #4）</b>：API 24–25 没有通知渠道，
     * 震动必须由通知自身配置。{@link RestAlarmReceiver} 在 API < 26 时
     * 给 builder 设置 {@code setVibrate} + {@code DEFAULT_VIBRATE}，
     * 保证 Android 7.0/7.1 也有震动。
     */
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID,
            "组间休息",
            NotificationManager.IMPORTANCE_HIGH
        );
        ch.setDescription("组间休息结束提醒");
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] { 0, 220, 120, 220 });
        /**
         * B4-R2（用户明确选择"声音＋震动"）：**新建**渠道默认使用系统提示音。
         *
         * <p>关键边界：<b>已存在的渠道无法由代码改行为</b>（官方文档明确只有用户
         * 能在系统设置里改已建渠道）。因此这里只影响"首次创建"，
         * 已有渠道一律原样保留 —— 绝不删渠道、不换 ID 去强开用户已关掉的声音。
         * 渠道真实声音状态由 {@link #channelSoundEnabled()} 读出并如实展示。
         */
        ch.setSound(android.provider.Settings.System.DEFAULT_NOTIFICATION_URI,
            new android.media.AudioAttributes.Builder()
                .setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    /**
     * B4-R2：**提醒总开关**（用户意图）的持久化键。
     *
     * <p>为什么放在原生而不是只放 JS/IndexedDB：
     * <ul>
     *   <li>到点投递发生在 {@link RestAlarmReceiver}/{@link RestCountdownService}，
     *       它们**没有 JS**，必须在原生侧也能读到"用户已关闭提醒"；</li>
     *   <li>关闭后必须让**已排队的旧 receiver / 旧 FGS 到期**无声无震，
     *       这是投递期门禁，不是 UI 状态。</li>
     * </ul>
     *
     * <p>默认 true（沿用既有用户的提醒意图，不因为升级而静默关掉）。
     * 与"系统是否就绪"（权限/渠道）是**两个独立事实**，绝不互相冒充。
     */
    static final String PREFS_REMINDER = "motion_rest_reminder_prefs";
    static final String KEY_REMINDER_ENABLED = "reminderEnabled";

    /**
     * 总开关的**已确认落盘**视图（B4-R3 O3）。
     *
     * <p>原因与 {@code RestReminderStore} 相同：Android 的
     * {@code SharedPreferences.Editor.commit()} 先改内存再写盘，写盘失败不回滚内存。
     * 若直接用 {@code getBoolean} 读"当前值"，持续写盘失败时会读回**未落盘的候选**，
     * 于是 getter / getStatus / 投递期门禁全都按"其实没写成功"的值行事 ——
     * 关闭失败被显示成已关闭（半提交假成功）。
     *
     * <p>这里只暴露最后一次确认写入成功的值；不改变存储位置，
     * 仍然是唯一一套 enabled 真源（{@code motion_rest_reminder_prefs/reminderEnabled}）。
     */
    private static final RestDurableFlag enabledFlag = new RestDurableFlag();

    /** 直接读磁盘候选值（**仅供首次装载基线**） */
    private static Boolean readStoredEnabled(Context ctx) {
        try {
            return ctx.getApplicationContext()
                .getSharedPreferences(PREFS_REMINDER, Context.MODE_PRIVATE)
                .getBoolean(KEY_REMINDER_ENABLED, true);
        } catch (Exception e) {
            return null;
        }
    }

    /** 写 enabled（真实 commit 结果；不更新已确认视图由 flag 负责） */
    private static boolean commitStoredEnabled(Context ctx, boolean value) {
        try {
            return ctx.getApplicationContext()
                .getSharedPreferences(PREFS_REMINDER, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_REMINDER_ENABLED, value)
                .commit();
        } catch (Exception e) {
            return false;
        }
    }

    /** 读取用户提醒总开关意图（默认开启；只读**已确认落盘**的值） */
    static boolean reminderEnabled(Context ctx) {
        // 读不到/无基线时按"开启"处理（保守：不静默吞掉用户既有提醒意图）
        return enabledFlag.read(() -> readStoredEnabled(ctx), true);
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean appNotificationsEnabled() {
        try {
            return NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        } catch (Exception e) {
            return false;
        }
    }

    private boolean channelEnabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private boolean channelVibrates() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        return ch == null || ch.shouldVibrate();
    }

    /**
     * 完成渠道**是否真的会有声音**（B4-R2 用户明确要"声音＋震动"）。
     *
     * <p>必须读渠道真实值，不能用"我建渠道时设了声音"代替：
     * 用户可以在系统设置里单独关掉这个渠道的声音，
     * 而 API 26+ 不允许 App 改回已建渠道的行为。
     *
     * <p>API 24–25 没有渠道，声音由通知自身 {@code DEFAULT_SOUND} 决定，
     * 这里返回 true（通知构建时会带默认提示音，最终仍由系统音量/勿扰决定）。
     *
     * @return true 表示渠道当前配置了声音（不证明到点一定会响）
     */
    private boolean channelSoundEnabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return false;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        // 渠道尚未创建：首次创建会带上默认提示音 → 视为有声音
        if (ch == null) return true;
        return ch.getSound() != null;
    }

    private boolean canScheduleExact() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** 真实授权与渠道状态（拒绝时如实上报，不把"弹过框"写成"已获准"） */
    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret = new JSObject();
        boolean perm = hasNotificationPermission();
        boolean appOn = appNotificationsEnabled();
        boolean chOn = channelEnabled();
        boolean chVib = channelVibrates();
        ret.put("notificationsGranted", perm);
        ret.put("appNotificationsEnabled", appOn);
        ret.put("channelEnabled", chOn);
        ret.put("channelVibrates", chVib);
        ret.put("exactAlarmsGranted", canScheduleExact());
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("dozeCaveat", true);
        // 后台提醒真正可能触达用户 = 权限 + 总开关 + 渠道未被关
        ret.put("canAlert", perm && appOn && chOn);
        /**
         * 准确状态提示所需的事实：canAlert 只说明"通知通道没被关"，
         * **不证明**到点时一定送达、更不证明一定震动（渠道可单独关震动，
         * Doze/OEM 仍可能推迟）。这里把"能不能保证"明确交出去。
         */
        /**
         * A2 缺口 #5：到点能否震动必须**包含通知许可交集**。
         * 通知整体不可达时（无 POST_NOTIFICATIONS / 总开关关 / 渠道关）
         * 就绝不能声称"可能会震动" —— 旧实现漏了 perm 这一项。
         */
        ret.put("canVibrate", perm && appOn && chOn && chVib);
        /**
         * B4-R2：声音必须与震动分开如实上报。
         *
         * <p>{@code channelSound} 是渠道真实配置（用户可在系统里单独关）；
         * {@code canSound} 是"到点是否可能出声"的交集结论。
         * 两者都不能当成"一定会响"。
         */
        boolean chSound = channelSoundEnabled();
        ret.put("channelSound", chSound);
        ret.put("canSound", perm && appOn && chOn && chSound);
        /**
         * 用户**意图**（总开关）与系统**就绪**（权限/渠道）分开上报。
         * UI 必须分别展示，不得把 checked 当成"已就绪"。
         */
        ret.put("reminderEnabled", reminderEnabled(getContext()));
        ret.put("deliveryGuaranteed", false);
        /**
         * 最小本地诊断（有界，最近 N 条，只含时刻/类型/短原因，不含 token 或训练内容）。
         * 供设置页显示"最近一次排程/触发/通知结果"，用于区分断在哪一环。
         */
        JSArray diag = new JSArray();
        for (String ev : RestReminderStore.readDiag(getContext())) diag.put(ev);
        ret.put("recentDiag", diag);
        call.resolve(ret);
    }

    /**
     * 查询**原生侧当前持有的提醒身份**（REVIEW-3 #1）。
     *
     * <p>为什么需要：页面在 `start()` 时写快照，那时原生 ack 还没回来，
     * 快照里的 generation 只能是 null。若此时页面被重建，恢复出来的就是
     * "有 token、无代次"的状态 —— 这是**正常生命周期窗口**，不是旧版本兼容问题。
     *
     * <p>没有这个入口时，恢复后 pause 只能"保守不做全清"，结果就是
     * **暂停了却仍会提醒**，不满足"未知凭据要有实际核对/安全处理"。
     *
     * <p>返回的是 SharedPreferences 里持久化的真实状态（与排程/取消同一真源），
     * 因此进程重建后依然可核验。
     */
    @PluginMethod
    public void getActive(PluginCall call) {
        RestReminderState.Snapshot cur = RestReminderStore.read(getContext());
        JSObject ret = new JSObject();
        ret.put("active", cur.token != null && !cur.fired);
        ret.put("token", cur.token);
        ret.put("generation", cur.generation);
        ret.put("fired", cur.fired);
        /**
         * B4-R3 closure · 重挂后的**编号连续性**（附加字段，向后兼容）。
         *
         * <p>页面重挂后 JS 的意图序号会从 0 重新开始；若旧快照没有存水位
         * （旧数据/旧版本写入），下一次 +15 会带着 ≤ 水位的编号到达原生 →
         * 被判 {@code stale-intent}，于是「界面已延长、原生仍按旧截止」。
         *
         * <p>这里把**当前身份的水位**一起交出去，供恢复路径取 max 使用。
         * 只新增字段，不改任何既有字段语义。
         */
        ret.put("lastIntentId", cur.lastIntentId);
        call.resolve(ret);
    }

    /**
     * Wave 1B.2：按身份查询持久化提醒状态（用于下拉通知栏点「取消」后返回前台对账）。
     *
     * <p>返回 {@code status}: {@code active | fired | cancelled_by_user | cancelled | unknown}。
     */
    @PluginMethod
    public void inspectIdentity(PluginCall call) {
        String token = call.getData() != null
            ? RestArgs.tokenOrNull(call.getData().opt("token")) : null;
        Object rawGen = call.getData() != null ? call.getData().opt("generation") : null;
        if (org.json.JSONObject.NULL.equals(rawGen)) {
            rawGen = null;
        }
        Long gen = RestCallArgs.parseGeneration(rawGen);
        boolean hasGen = gen != null;
        RestReminderState.Snapshot cur = RestReminderStore.read(getContext());
        String status = RestReminderState.inspectIdentity(
            cur,
            token,
            hasGen ? gen : -1L,
            hasGen
        );
        JSObject ret = new JSObject();
        ret.put("status", status);
        ret.put("token", cur.token);
        ret.put("generation", cur.generation);
        ret.put("fired", cur.fired);
        ret.put("lastUserCancelledToken", cur.lastUserCancelledToken);
        ret.put("lastUserCancelledGeneration", cur.lastUserCancelledGeneration);
        call.resolve(ret);
    }

    /**
     * B4-R2：设置**提醒总开关**（用户意图）。
     *
     * <p>语义边界（必须准确）：
     * <ul>
     *   <li>本方法只写"用户意图"，**不申请任何权限**、不打开系统页、
     *       不因为打开就声称"已就绪"；</li>
     *   <li>关闭时必须**durable 取消**当前提醒并停掉静默计时服务，
     *       使已排队的旧 receiver / 旧 FGS 到期后无声无震；</li>
     *   <li>关闭**不影响**倒计时本身（计时按真实截止继续走）；</li>
     *   <li>持久化失败**不假报**关闭成功（返回真实 enabled 与失败原因）。</li>
     * </ul>
     */
    @PluginMethod
    public void setReminderEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        Object raw = call.getData() != null ? call.getData().opt("enabled") : null;
        if (!(raw instanceof Boolean)) {
            ret.put("ok", false);
            ret.put("reason", "invalid-enabled");
            ret.put("enabled", reminderEnabled(getContext()));
            call.resolve(ret);
            return;
        }
        boolean enabled = (Boolean) raw;
        /**
         * **在任何首次写入之前**读取并保存关闭/打开前的真实值（O3 补偿基线）。
         *
         * <p>为什么必须在最前面：补偿必须写回「**用户操作之前**的值」。
         * 旧写法在第一次写入**成功之后**才去读"当前已确认值"——
         * 那时它已经是新值（例如 false），所谓"恢复"其实什么都没恢复，
         * 关闭失败就变成了真正无法回退的半提交。
         *
         * <p>这次读取同时完成 {@link #enabledFlag} 的**冷装载**：
         * 首次访问时从磁盘装载基线（此时内存=磁盘，是唯一可信的读取时机），
         * 之后即使出现写盘失败改了内存，也不会再被当成真值。
         */
        final boolean oldEnabled = reminderEnabled(getContext());
        /**
         * 写入开关意图（**唯一 enabled 真源**，仍是 motion_rest_reminder_prefs/reminderEnabled）。
         *
         * <p>B4-R3：判定用 {@link #enabledFlag} 的**已确认落盘**值，
         * 而不是直接读 SharedPreferences —— 后者在写盘失败后会读回失败候选
         * （AOSP commitToMemory 先改 mMap，写盘失败不回滚）。
         */
        boolean durable = writeEnabledIntent(enabled);
        if (!durable) {
            /**
             * 写盘失败：**不假报成功**。
             *
             * <p>真实 Android 边界下内存视图可能已被改成候选值。为了让
             * 返回 / getter / 投递期门禁与**磁盘真实值**一致，这里做一次补偿写入
             * （把 **oldEnabled** 写回），并如实上报补偿结果；补偿再失败也不伪称成功。
             */
            boolean compensated = writeEnabledIntent(oldEnabled);
            ret.put("ok", false);
            ret.put("reason", "persist-failed");
            ret.put("enabled", reminderEnabled(getContext()));
            ret.put("compensated", compensated);
            ret.put("compensationFailed", !compensated);
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                compensated ? "reminder-toggle-persist-failed" : "reminder-toggle-persist-failed-uncompensated");
            call.resolve(ret);
            return;
        }
        if (!enabled) {
            /**
             * 关闭：**两段写入**，必须显式承认它们不是跨 prefs 原子事务。
             *
             * <ol>
             *   <li>第一段（已成功）：enabled=false；</li>
             *   <li>第二段：identity 取消（token/generation/fired/notifId/lastIntentId）。</li>
             * </ol>
             *
             * <p>第二段失败时**不得**继续清 alarm/service，也不得 ok:true
             * （否则就是"半提交假成功"：界面显示已关闭，原生身份/闹钟还在，
             * 而且重建后 enabled=false 与残留身份并存）。
             * 此时补偿回 enabled=原值，力求回到"关闭前"的一致状态；
             * 补偿再失败则如实暴露半提交（halfCommit），并让 getter 反映真值。
             */
            RestReminderGate.Result gate = RestReminderStore.transition(
                getContext(), cur -> RestReminderState.cancel(cur));
            boolean cancelled = gate.durable;
            if (!cancelled) {
                // 补偿目标必须是**操作前**的 oldEnabled，不是写入后的新值
                boolean restoredEnabled = writeEnabledIntent(oldEnabled);
                // 身份表的失败候选也可能残留在内存里：把已确认身份写回磁盘（best effort）
                boolean restoredIdentity = RestReminderStore.restoreConfirmed(getContext());
                boolean halfCommit = !restoredEnabled;
                ret.put("ok", false);
                ret.put("enabled", reminderEnabled(getContext()));
                ret.put("cancelled", false);
                ret.put("reason", halfCommit
                    ? "identity-persist-failed-uncompensated"
                    : "identity-persist-failed");
                ret.put("compensated", restoredEnabled);
                ret.put("compensationFailed", halfCommit);
                ret.put("halfCommit", halfCommit);
                ret.put("identityRestored", restoredIdentity);
                ret.put("stage", "enabled-committed;identity-persist-failed");
                RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                    halfCommit ? "reminder-off-identity-uncompensated" : "reminder-off-identity-failed");
                // 关键：不清 alarm、不停 service、不持锁改变 —— 保持两边一致可重试
                call.resolve(ret);
                return;
            }
            cancelAlarmOnly();
            try {
                long watermark = gate.outcome != null ? gate.outcome.state.generation : -1L;
                RestCountdownService.stop(getContext(), "reminder-disabled",
                    null, -1L, watermark);
            } catch (Exception ignored) {
                // 停服务失败不影响"不再提醒"的结论（投递期还有门禁）
            }
            ret.put("ok", true);
            ret.put("enabled", false);
            ret.put("cancelled", true);
            ret.put("stage", "enabled-committed;identity-cancelled");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_CANCEL,
                "reminder-disabled");
        } else {
            /**
             * 打开：**只**更新意图。不在这里自动排程/启 FGS ——
             * 当前计时的衔接由用户下一次操作（开始/继续/加时）按真实剩余排，
             * 绝不在后台偷偷启动前台服务。
             */
            ret.put("ok", true);
            ret.put("enabled", true);
            ret.put("stage", "enabled-committed");
        }
        call.resolve(ret);
    }

    /**
     * 写入开关意图（真实 commit 结果；只有成功才推进已确认值）。
     *
     * <p>补偿也走这里：目标值必须由调用方显式给出（**操作前的 oldEnabled**），
     * 绝不能靠"再读一次当前值"—— 那次读取在成功写入后已经是新值了。
     *
     * @return 是否真的写盘成功；持续失败时如实返回 false
     */
    private boolean writeEnabledIntent(boolean value) {
        return enabledFlag.write(value, v -> commitStoredEnabled(getContext(), v));
    }

    /** 读取当前提醒总开关意图（与系统就绪状态分开上报） */
    @PluginMethod
    public void getReminderEnabled(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("enabled", reminderEnabled(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (hasNotificationPermission() || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            JSObject ret = new JSObject();
            ret.put("notificationsGranted", hasNotificationPermission());
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermCallback");
    }

    @PermissionCallback
    private void notificationPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("notificationsGranted", hasNotificationPermission());
        call.resolve(ret);
    }

    /**
     * 排一个到时提醒。
     *
     * <p>参数 {@code token}、{@code remainingMs}。
     * 数值解析走 {@link RestArgs}（不依赖只认 Long 的 {@code PluginCall.getLong}）。
     * 状态写盘失败时**不排程**并返回真实失败原因（P1 #2）。
     */
    @PluginMethod
    public void schedule(PluginCall call) {
        JSObject ret = new JSObject();
        /**
         * B4-R3 closure2 · D1：**入口时刻**必须在任何 commit/写盘之前取。
         *
         * <p>旧实现把"现在"取在身份写盘之后，于是这段原生处理耗时被加进休息；
         * 实测 commit 注入 150ms 时闹钟与 service 单调截止都晚 163ms。
         */
        final long entryWallMs = System.currentTimeMillis();
        String token = RestArgs.tokenOrNull(call.getData().opt("token"));
        RestArgs.Result parsed = RestArgs.parseRemainingMs(call.getData().opt("remainingMs"));

        if (token == null) {
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "invalid-token");
            ret.put("path", "rejected-invalid-token");
            // 早退失败也要留最小有界记录（A2 缺口 #3）
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED, "invalid-token");
            call.resolve(ret);
            return;
        }
        if (!parsed.ok) {
            /**
             * 第二轮补充 P1 #2：非法参数**不得顺带取消**一条有效的新提醒。
             * 旧实现无条件 cancel —— 一次参数错误的调用就会把用户正在进行的休息提醒清掉。
             * 这里只拒绝本次请求，完全不动既有状态；并如实上报原因。
             */
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "invalid-remaining:" + parsed.message);
            ret.put("path", "rejected-invalid-remaining");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                "invalid-remaining");
            call.resolve(ret);
            return;
        }

        long remainingMs = parsed.value;
        /**
         * B4-R2 优先级一 #1：**扣掉 JS→Plugin 的排队耗时**。
         *
         * <p>JS 在用户点击那一刻就开始倒计时（UI 的 endsAt 已定），
         * 而本方法在自己的执行时刻才建截止。若直接用 {@code now + remainingMs}，
         * 排队耗时 D 会原样加进休息时长 —— 表现就是"UI 归零了、过一会才响"。
         *
         * <p>现在：JS 带上**发起目标截止**时按它算真实剩余；未带时退回旧语义。
         * 已过期（left<=0）时按"已到点"处理（取消旧提醒、不建新身份），
         * 不夹成 1ms 去补一个假提醒。
         */
        /**
         * B4-R3 D2-invalid-deadline：**显式非法截止必须拒绝，不得 fallback**。
         *
         * <p>旧实现把"没传"和"传了非法"都当 {@code null}，于是
         * {@code deadlineAtMs:'not-a-number'} 会静默退回"入口时刻 + remainingMs"
         * 重新起算 —— 用非法输入伪造了一条新截止，还顺带清掉当前好提醒。
         *
         * <p>现在三态区分（{@link RestArgs#classifyDeadline}）：
         * 只有**真正缺省**才允许兼容 fallback；显式非法立即拒绝，
         * 早于任何 Store transition / alarm / service 副作用。
         */
        RestArgs.Deadline deadline = RestArgs.classifyDeadline(
            call.getData() != null ? call.getData().opt("deadlineAtMs") : null);
        if (deadline.isInvalid()) {
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "invalid-deadline");
            ret.put("path", "rejected-invalid-deadline");
            ret.put("deadlineKind", "invalid");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                "invalid-deadline");
            call.resolve(ret);
            return;
        }
        Long deadlineAtMs = deadline.value;
        long effectiveMs = RestArgs.effectiveRemaining(
            remainingMs, deadlineAtMs, System.currentTimeMillis());
        if (deadlineAtMs != null && effectiveMs <= 0L) {
            /**
             * B4-R3 D2-expired-old-request：**过期请求只拒绝它自己**。
             *
             * <p>旧实现走 {@code State.cancel(cur)} + 无条件 {@code cancelAlarmOnly()}
             * + durable 后停服务 —— 也就是一条**早已过期的旧请求**能把用户
             * 当前这条好提醒（以及它的 alarm/service/lock）整个 full-clear。
             *
             * <p>现在：不改身份、不动 alarm、不停服务、不夹 1ms 补假提醒。
             * 返回值如实说明拒绝原因；当前好提醒的 token/generation/deadline 一字不变。
             */
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "deadline-already-passed");
            ret.put("path", "rejected-deadline-passed");
            ret.put("deadlineAtMs", deadlineAtMs);
            ret.put("serverNowMs", System.currentTimeMillis());
            ret.put("deadlineKind", "expired");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                "deadline-already-passed");
            call.resolve(ret);
            return;
        }
        /**
         * 用**新的 final 变量**承载扣减后的剩余量。
         *
         * <p>不能直接给 `remainingMs` 重新赋值：它会被下面的 lambda 捕获，
         * 而 lambda 只能捕获 effectively-final 变量（Gradle javac 会直接报错）。
         * 后面所有使用点（triggerAtMs / deadlineElapsed / FGS 启动参数）
         * 都读 `scheduledMs`，语义与"用扣减后的值"完全一致。
         */
        final long scheduledMs = effectiveMs;
        /**
         * **目标绝对墙钟**：带合法 deadline 时就是调用方点击那一刻定的截止；
         * 缺省时按"入口时刻 + remainingMs"（旧语义，但同样在入口定死）。
         * 之后无论身份写盘/降级/排队耗时多少，闹钟与服务都对应**同一个目标**。
         */
        final long targetWallMs = RestArgs.targetWallAt(entryWallMs, remainingMs, deadlineAtMs);
        /**
         * B4-R2 优先级一 #3：**用户新意图编号**（可选）。
         *
         * <p>归零后原生已 fired，用户点 +15 时 JS 会先异步 cancel 再重排，
         * 但 cancel 是 fire-and-forget，排程可能先到 —— 旧规则会把它当
         * already-fired 拒绝，导致用户明确加出来的时间排不上。
         *
         * <p>这里只**透传**调用方给出的明确意图编号给状态机；
         * 是否接受由 {@link RestReminderState#startWithIntent} 判定：
         * 没有编号（0）或编号不更新 → 仍按旧门禁拒绝（旧请求不得重放）。
         */
        long intentId = 0L;
        Object rawIntent = call.getData().opt("intentId");
        if (rawIntent instanceof Number) {
            double d = ((Number) rawIntent).doubleValue();
            if (!Double.isNaN(d) && !Double.isInfinite(d) && d >= 0d) intentId = (long) d;
        }
        final long fIntentId = intentId;
        RestReminderGate.Result gate = RestReminderStore.transition(
            getContext(),
            cur -> RestReminderState.startWithIntent(cur, token, scheduledMs, fIntentId)
        );

        // 写盘失败 → 不排程、不假报成功
        if (!gate.durable) {
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "persist-failed:" + gate.failureReason);
            ret.put("path", "rejected-persist-failed");
            /**
             * A2 缺口 #3：这条早退路径此前**完全没有记录**（recentDiag 为空），
             * 于是"排程没成功"在事后无从判断。现在记录一个最小原因；
             * 诊断自身写失败仍是旁路问题（diag() 内部已吞异常），
             * 绝不因此改变"不排程、不假报 durable"的业务结论。
             */
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED,
                "persist-failed");
            call.resolve(ret);
            return;
        }

        RestReminderState.Outcome outcome = gate.outcome;
        if (outcome == null || outcome.action != RestReminderState.Outcome.Action.SCHEDULE) {
            /**
             * B4-R3 D2-stale-intent-while-unfired【第二修点】：**NOOP 必须保留全部资源**。
             *
             * <p>旧实现在这里之前就无条件 {@code cancelAlarmOnly()}（注释写的是
             * "无论结果如何先清掉旧闹钟"）—— 于是一条被状态机判定为
             * {@code stale-intent} / {@code already-fired} 的 **NOOP 请求**
             * 虽然没改身份，却把用户当前这条好提醒的 alarm 清掉了：
             * 状态里 token/generation/when 都还在，实际已经不会响。
             *
             * <p>现在：只有真正被接受的 SCHEDULE / CANCEL 才产生资源副作用；
             * NOOP 一律不碰 alarm / service / lock。这也让"拒绝"成为可观测的纯拒绝。
             */
            String why = outcome == null ? "null-outcome" : outcome.reason;
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", why);
            ret.put("path", "rejected-state-" + why);
            ret.put("outcomeAction", outcome == null ? "null" : outcome.action.name());
            /**
             * B4-R3 closure · **水位同步信号**（附加字段，向后兼容）。
             *
             * <p>页面重挂/旧快照没有水位时，JS 的意图序号可能落后于原生水位。
             * 这时发出的请求会被这里判成 {@code stale-intent}（如实拒绝，不改状态）；
             * 把**当前身份的水位**一并带回，JS 就能：
             * <ul>
             *   <li>把握水抬到真实值，</li>
             *   <li>用 {@code 水位 + 1} 重发这一次用户意图。</li>
             * </ul>
             * 这样"UI 已延长、原生仍按旧截止"的分叉在**同一次点击内**被纠正，
             * 而不是留下一个乐观但错误的界面。
             */
            ret.put("lastIntentId", outcome == null ? -1L : outcome.state.lastIntentId);
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED, why);
            call.resolve(ret);
            return;
        }

        // 真正被接受的 SCHEDULE：此时才清旧闹钟（避免过期残留），随后排新的
        cancelAlarmOnly();

        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            ret.put("scheduled", false);
            ret.put("exact", false);
            ret.put("reason", "no-alarm-service");
            ret.put("path", "rejected-no-alarm-service");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_SCHEDULE_FAILED, "no-alarm-service");
            call.resolve(ret);
            return;
        }

        /**
         * B4-R3 closure2 · D1：闹钟用**绝对墙钟目标**，服务用**由同一目标换算的单调截止**。
         *
         * <p>旧实现在这里写 {@code now + scheduledMs} / {@code elapsed + scheduledMs}，
         * 等于把"取参数到真正设闹钟"之间的处理耗时（含身份写盘）又加了一遍：
         * 实测 commit 150ms → 两者都晚 163ms，ingress 1000ms → drift 16ms。
         *
         * <p>现在：
         * <ul>
         *   <li>{@code triggerAtMs = targetWallMs}（不做任何再加）；</li>
         *   <li>{@code deadlineElapsed = elapsedNow + (targetWallMs - wallNow)} ——
         *       用**派发时刻的真实剩余**换算，因此与同一墙钟目标严格对应；</li>
         *   <li>{@code leftAtDispatch} 是同一时刻的剩余量，供 FGS 资格判定使用。</li>
         * </ul>
         */
        long nowWallAtDispatch = System.currentTimeMillis();
        long nowElapsedAtDispatch = SystemClock.elapsedRealtime();
        long targetWall = targetWallMs;
        long triggerAtMs = targetWall;
        long leftAtDispatch = Math.max(0L, targetWall - nowWallAtDispatch);
        long deadlineElapsed =
            RestArgs.monotonicDeadlineAt(nowWallAtDispatch, nowElapsedAtDispatch, targetWall);
        long generation = outcome.state.generation;
        int notifId = outcome.state.notifId;
        PendingIntent pi = buildPendingIntent(token, generation, notifId);
        boolean exact = canScheduleExact();
        /**
         * 精确/不精确两条路径必须**分开**处理（A2 缺口 #1）。
         *
         * <p>旧实现的错误：把 {@code exact=false} 分支的不精确调用也放在同一个
         * try 里，于是**不精确调用本身**抛 SecurityException 时会被 catch 误判成
         * "精确被拒"（exactDenied=true），并且再执行一次**同一个**不精确调用。
         * 结果既假报了路径，又重复了失败调用。
         *
         * <p>现在的规则：
         * <ul>
         *   <li>只有**真正调用了 setExactAndAllowWhileIdle 并被拒**才算 exactDenied；</li>
         *   <li>降级只发生在"精确被拒"之后，且**只降一次**；</li>
         *   <li>不精确调用自己失败 → 直接如实失败，**不重试同一 API**。</li>
         * </ul>
         */
        boolean exactDenied = false;
        boolean scheduledOk = false;
        String path;
        if (exact) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                scheduledOk = true;
                path = "exact";
            } catch (SecurityException exactRejected) {
                // 真正精确调用被拒 → 这里才允许降级一次
                exactDenied = true;
                try {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    scheduledOk = true;
                    path = "exact-denied-fallback-inexact";
                } catch (Exception fallbackFailed) {
                    scheduledOk = false;
                    path = "exact-denied-fallback-failed";
                }
            }
        } else {
            // 一开始就没有精确权限：这是**正常**不精确路径，不是"被拒后降级"
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                scheduledOk = true;
                path = "inexact-no-permission";
            } catch (Exception inexactFailed) {
                // 不精确调用自己失败：如实失败，不再重复调用同一 API
                scheduledOk = false;
                path = "inexact-failed";
            }
        }

        /**
         * A3 #2：`exact` 必须反映**最终实际采用**的方式，不是最初的 canExact。
         *
         * <p>旧实现的 bug：精确调用抛 SecurityException 后降级成功，
         * 但 `exact` 变量仍是最初的 canExact=true，于是 ACK 回 `exact:true`
         * —— 与真实采用的 inexact 相反。原 A 真实 17 判据的 1 项 FAIL 正是它。
         */
        boolean actuallyExact = scheduledOk && "exact".equals(path);
        ret.put("scheduled", scheduledOk);
        ret.put("exact", actuallyExact);
        ret.put("path", path);
        ret.put("exactDenied", exactDenied);
        if (scheduledOk) {
            /**
             * 身份必须回传（降级分支漏 generation 的接线缺口，A 批已修，此处保持）。
             *
             * <p>JS 侧 {@code RestScheduleController.dispatch} 只有拿到**数字**
             * generation 才提交取消凭据；缺了它 → 控制器认为"代次未知"，
             * 之后 pause/stop 只能记 pendingCancel，而该请求已经结束，
             * 不会再有一次带代次的迟到 ack 来补偿 → 暂停了原生提醒仍然残留。
             */
            ret.put("generation", generation);
            ret.put("notifId", notifId);
            ret.put("triggerAtMs", triggerAtMs);
            // B4-R3 closure：成功也回报水位，JS 每次排程后都能与原生对齐
            ret.put("lastIntentId", outcome.state.lastIntentId);
            ret.put("notificationsGranted", hasNotificationPermission());
            ret.put("appNotificationsEnabled", appNotificationsEnabled());
            ret.put("channelEnabled", channelEnabled());
            ret.put("channelVibrates", channelVibrates());
            ret.put("dozeCaveat", true);
            if ("exact-denied-fallback-inexact".equals(path)) {
                ret.put("reason", "exact-denied-fallback-inexact");
            } else if ("inexact-no-permission".equals(path)) {
                ret.put("reason", "exact-alarm-permission-denied");
            }
        } else {
            /**
             * 排不上：状态里已有 token/generation（写盘成功），但没有任何闹钟。
             * 必须如实告知失败，且**不重复调用**同一平台 API。
             */
            ret.put("reason", "exact-denied-fallback-failed".equals(path)
                ? "exact-denied-fallback-failed" : "inexact-failed");
        }
        /**
         * 旁路诊断（最小、有界、本地、无训练内容）：只记录**真实路径与结果**，
         * 让"后台有时不响"能区分排程没成功、降级了、还是排上了但广播/通知出问题。
         */
        RestReminderStore.diag(getContext(),
            scheduledOk ? RestDiagLog.KIND_SCHEDULE : RestDiagLog.KIND_SCHEDULE_FAILED,
            path);

        /**
         * 当前段前台增强（A2 批准）：**只**在真正排程成功后尝试，
         * 且只在满足最窄资格时启用；不满足就准确降级、保留 AlarmManager 路径。
         *
         * <p>注意这里不改变 {@code scheduled} 的语义：基础排程成功与
         * "当前段增强是否启用"是两个独立事实，分别上报。
         */
        if (scheduledOk) {
            /**
             * A3 #3：只有**用户可见操作**引发的排程才允许启动当前段增强。
             * origin 由 JS 侧在用户交互路径上显式传入；缺省视为"非用户操作"。
             */
            String origin = call.getData() != null
                ? call.getData().optString("origin", null) : null;
            if (!RestForegroundPolicy.originAllowsForeground(origin)) {
                RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                    "origin-not-user:" + (origin == null ? "absent" : origin));
                ret.put("foregroundEnhancement", "origin-not-user");
            } else {
                String enhanced = tryStartForegroundEnhancement(
                    token, generation, leftAtDispatch, deadlineElapsed);
                ret.put("foregroundEnhancement", enhanced);
            }
        } else {
            ret.put("foregroundEnhancement", "not-attempted");
        }
        call.resolve(ret);
    }

    /**
     * 取消当前提醒。
     *
     * <p>可选参数 {@code token} + {@code generation}（第二轮补充 P1 #1）：
     * 带上身份时只有**当前代次**才真正取消 —— 旧 A 的取消延迟到达时不会误取消 B。
     * 不带身份表示调用方明确要求全清（例如结束训练）。
     *
     * <p>第二轮补充 P1 #2：取消同样必须**写盘成功**才算成功。
     * 旧实现忽略 durable 结果就报 cancelled:true，一旦写盘失败，
     * 进程重建后仍读回旧状态 → 旧提醒可能又活过来。
     */
    @PluginMethod
    public void cancel(PluginCall call) {
        JSObject ret = new JSObject();
        // 参数转换走 RestCallArgs（纯类，可离线测试；REVIEW-1 #1 的接线错误在此层）
        RestCallArgs.Identity id =
            RestCallArgs.parse(call.getData().opt("token"), call.getData().opt("generation"));

        RestReminderGate.Result gate = RestReminderStore.transition(
            getContext(),
            cur -> RestReminderState.cancelIfCurrent(cur, id.token, id.generation, id.hasIdentity)
        );

        if (!gate.durable) {
            // 写盘失败：不假报取消成功，也不动闹钟（状态与闹钟保持一致）
            ret.put("cancelled", false);
            ret.put("reason", "persist-failed:" + gate.failureReason);
            call.resolve(ret);
            return;
        }
        boolean didCancel = gate.outcome != null
            && gate.outcome.action == RestReminderState.Outcome.Action.CANCEL;
        if (didCancel) {
            cancelAlarmOnly();
            /**
             * A3 #4/R8 + A5 #1：取消成功后统一停掉匹配的当前段服务。
             *
             * <p>**A5 关键**：必须传"**刚被 durable 取消的旧身份**"。
             * 取消之后持久态已是 token=null、generation+1，
             * 若从取消后的状态构造目标身份就会指向错误对象（甚至空）。
             * 因此这里用调用时携带的原始身份 + 取消前快照。
             */
            try {
                if (id.hasIdentity) {
                    // 按身份取消：目标就是刚取消的那个 token/generation
                    RestCountdownService.stop(getContext(), "cancelled-by-plugin",
                        id.token, id.generation, -1L);
                } else {
                    // 显式全清：携带本次成功取消后的 generation 作为水位
                    long watermark = gate.outcome != null ? gate.outcome.state.generation : -1L;
                    RestCountdownService.stop(getContext(), "full-clear-by-plugin",
                        null, -1L, watermark);
                }
            } catch (Exception ignored) {
                // 停服务失败不影响取消语义
            }
        }
        ret.put("cancelled", didCancel);
        if (!didCancel) {
            ret.put("reason", gate.outcome == null ? "null-outcome" : gate.outcome.reason);
        }
        RestReminderStore.diag(getContext(), RestDiagLog.KIND_CANCEL,
            didCancel ? (id.hasIdentity ? "with-identity" : "full-clear") : "rejected");
        call.resolve(ret);
    }

    /**
     * 说明：原先的 `consume` 方法已**移除**（REVIEW-1 #3）。
     *
     * 它从 {@code cur.generation} 自补代次，而不是核验调用者携带的 generation，
     * 因此旧 consume(A/gen1) 能消费同 token 重排后的 gen2 —— 是假门禁。
     * 而 JS 侧归零后已不再调用它（提醒完全由 receiver 按身份发出），
     * 保留一个未被使用、又无法正确核验的 API 只会误导后续维护。
     *
     * 若将来确实需要"页面确认已提醒"，必须新增**携带 token + generation**
     * 并核验当前身份的接口，而不是复用这个自补版本。
     */

    /**
     * 尝试启用"当前段可见前台计时"增强。
     *
     * @return 稳定字符串：`started` / 具体未启用原因 / `start-failed`
     *
     * <p>资格判断交给纯 JVM 的 {@link RestForegroundPolicy}（可被宿主测试覆盖），
     * 这里只负责把 Android 真实状态喂给它，并按结果如实上报。
     */
    private String tryStartForegroundEnhancement(
        String token, long generation, long remainingMs, long deadlineElapsed) {
        boolean exactGranted = canScheduleExact();
        /**
         * A3 #6：持续计时用的是**独立渠道** motion-rest-countdown，
         * 不能用"到点提醒"渠道的 channelEnabled() 代替。
         * 持续渠道被用户单独关掉时，可见增强实际不可见 → 必须判定为不可达。
         */
        boolean notificationsReachable = hasNotificationPermission()
            && appNotificationsEnabled()
            && channelEnabled()
            && RestCountdownService.ongoingChannelReachable(getContext());
        RestForegroundPolicy.Decision d = RestForegroundPolicy.decide(
            Build.VERSION.SDK_INT, exactGranted, notificationsReachable, remainingMs);
        if (!d.enable) {
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED, d.skipReason);
            return d.skipReason;
        }
        /**
         * A3 #3：native 侧**再核对一次**当前 Activity 是否可见/有效。
         *
         * <p>类型有资格不代表产品允许后台偷偷启动。即使用户操作路径传了 origin，
         * 若此刻 Activity 已不可见（刚切走），也不启动增强。
         */
        if (!isActivityVisible()) {
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                "activity-not-visible");
            return "activity-not-visible";
        }
        try {
            /**
             * **A4 补充：跨线程竞态修复（只读复核发现）**。
             *
             * <p>插件方法运行在 Capacitor 的 `taskHandler`（HandlerThread，
             * Bridge.java:217/860），而 `handleOnPause` 由**主线程直接调用**
             * （Bridge.java:1370–1372，无 post）。于是上面的
             * `isActivityVisible()` 检查与这里的启动之间**不是原子的** ——
             * 用户可能在两者之间切走，仍然启动 FGS。
             *
             * <p>修复：把启动投递到主线程，并在 runnable **实际执行时**
             * 重新核验"仍是 resumed + 仍是当前持久身份 + 仍是同一 deadline"。
             * 排队期间发生 pause / 换代次 / 已过期 → 一律不启动（不复活旧请求）。
             * 注意：排队**不重新赠送剩余时间**，deadline 始终用排程入口那一个。
             */
            final String fToken = token;
            final long fGen = generation;
            final long fRemaining = remainingMs;
            final long fDeadline = deadlineElapsed;
            final long fQueuedAt = SystemClock.elapsedRealtime();
            if (getBridge() != null) {
                getBridge().executeOnMainThread(() -> {
                    // ① 主线程实时重核可见性
                    if (!isActivityVisible()) {
                        RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                            "activity-not-visible-at-exec");
                        return;
                    }
                    // ② 重核当前持久身份（旧代次不得复活）
                    RestReminderState.Snapshot now = RestReminderStore.read(getContext());
                    if (now.token == null || !fToken.equals(now.token) || fGen != now.generation) {
                        RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                            "stale-identity-at-exec");
                        return;
                    }
                    // ③ 按原 deadline 重算剩余（绝不重新赠送）
                    long left = RestForegroundPolicy.effectiveRemaining(
                        fDeadline, SystemClock.elapsedRealtime());
                    if (left <= 0L) {
                        RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                            "expired-at-exec");
                        return;
                    }
                    /**
                     * ④ A5 #4：执行时**重新核对实际精确资格与两个渠道**。
                     *
                     * <p>入队前只查过一次；排队期间用户可能撤销精确闹钟授权、
                     * 关闭结束渠道或持续渠道。任一不满足 → 不启动增强，
                     * **保留基础 alarm**。
                     */
                    boolean exactNow = canScheduleExact();
                    boolean channelsNow = hasNotificationPermission()
                        && appNotificationsEnabled()
                        && channelEnabled()
                        && RestCountdownService.ongoingChannelReachable(getContext());
                    RestForegroundPolicy.Decision dNow = RestForegroundPolicy.decide(
                        Build.VERSION.SDK_INT, exactNow, channelsNow, left);
                    if (!dNow.enable) {
                        RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_SKIPPED,
                            "recheck-at-exec:" + dNow.skipReason);
                        return;
                    }
                    try {
                        RestCountdownService.startOrUpdate(
                            getContext(), fToken, fGen, left, fDeadline);
                    } catch (Exception e) {
                        RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_FAILED,
                            "start-failed-at-exec:" + e.getClass().getSimpleName());
                    }
                });
            }
            /**
             * A3 #7：`startForegroundService()` 只是**请求被受理**，
             * 不代表服务真的进入前台并持有锁；且本次还经过了主线程排队，
             * 更不能用入队当成功。
             *
             * <p>现在只回 `requested`：真实结果以服务侧诊断
             * （fgs-started / fgs-failed / fgs-stopped）为准。
             */
            return "requested";
        } catch (Exception e) {
            /**
             * 后台启动限制 / 系统拒绝：**绝不吞掉原有闹钟**。
             * 排程已经成功，这里只是增强未启用，如实记录并返回原因。
             */
            String reason = "start-failed:" + e.getClass().getSimpleName();
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_FAILED, reason);
            return reason;
        }
    }

    /**
     * 停止当前段前台增强（暂停 / 跳过 / 完成 / 替换 / 结束训练）。
     *
     * <p>JS 侧在 pause/stop 时调用；失败不影响原有取消语义。
     */
    /**
     * 停止当前段前台增强（遗留入口）。
     *
     * <p><b>A4 #2：必须带合法身份，缺身份 fail-closed。</b>
     *
     * <p>实证失败序列：cancel 的身份 commit 失败 → Plugin.cancel=false（身份正确保留）
     * → 但 JS 仍调用本入口的**无身份**形式 → 无条件停 FGS/放锁，
     * 与"取消失败应保留"矛盾。
     *
     * <p>现在要求 token+generation 且必须匹配**当前持久化身份**；
     * 不匹配（陈旧/缺失）一律拒绝且**不产生任何副作用**（不停服务、不放锁）。
     * 显式全清走原有 cancel(full-clear) 路径，不经这里。
     */
    @PluginMethod
    public void stopForegroundTimer(PluginCall call) {
        JSObject ret = new JSObject();
        String reason = call.getData() != null
            ? call.getData().optString("reason", "user-stop") : "user-stop";
        RestCallArgs.Identity id = RestCallArgs.parse(
            call.getData() != null ? call.getData().opt("token") : null,
            call.getData() != null ? call.getData().opt("generation") : null);
        if (!id.hasIdentity) {
            // 无身份：fail-closed，绝不清当前资源
            ret.put("stopped", false);
            ret.put("reason", "identity-required");
            RestReminderStore.diag(getContext(), RestDiagLog.KIND_FGS_FAILED,
                "stop-without-identity-rejected");
            call.resolve(ret);
            return;
        }
        RestReminderState.Snapshot cur = RestReminderStore.read(getContext());
        boolean matches = cur.token != null
            && cur.token.equals(id.token)
            && cur.generation == id.generation;
        if (!matches) {
            // 陈旧/不匹配：只拒绝，不停当前新段
            ret.put("stopped", false);
            ret.put("reason", "stale-identity");
            call.resolve(ret);
            return;
        }
        try {
            // A5 #1：合法遗留停止入口同样携带其目标身份
            RestCountdownService.stop(getContext(), reason, id.token, id.generation, -1L);
            ret.put("stopped", true);
        } catch (Exception e) {
            ret.put("stopped", false);
            ret.put("reason", e.getClass().getSimpleName());
        }
        call.resolve(ret);
    }

    /**
     * 本插件实例是否处于**真正 resumed**（用户可交互）状态。
     *
     * <p><b>A4 #1：不能用"Activity 未 finish/未 destroy"当可见。</b>
     * 后台但存活的 Activity 完全满足那两个条件，于是旧实现把"活着"误当"可见"，
     * 在后台仍可启动 FGS —— 这正是独立验收 FGS 7 例里的那 1 项 FAIL。
     *
     * <p>也不能只用 {@code bridge.getApp().isActive()}：按其真实实现
     * （@capacitor/android 8.5.3，App.java:27–30,55–59；BridgeActivity.java:104–109），
     * onPause **不清**该字段，直到 onStop 才 false —— paused 阶段仍为 true。
     *
     * <p>因此改用 Capacitor 现成的真实生命周期 hook
     * （Plugin.java:989/994/999/1004 的 handleOnResume/handleOnPause/handleOnStop/handleOnDestroy，
     * 由 Bridge.java:1357–1372 真实转发）维护本实例状态。
     *
     * <p><b>初次时序</b>：插件 load 发生在首次 Activity onResume **之前**
     * （PluginHandle.java:63–65,98–116），所以默认必须是 false，
     * 绝不能在 load() 里凭"Activity 存在"猜 true；也不能让首次使用永远 false ——
     * 首次 resume 时 hook 会把它置 true。
     */
    private volatile boolean activityResumed = false;

    @Override
    protected void handleOnResume() {
        activityResumed = true;
        super.handleOnResume();
    }

    @Override
    protected void handleOnPause() {
        // paused 就不再是"用户正在操作"，立即撤销许可（不等到 onStop）
        activityResumed = false;
        super.handleOnPause();
    }

    @Override
    protected void handleOnStop() {
        activityResumed = false;
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        activityResumed = false;
        RestReminderStore.setUserCancelListener(null);
        super.handleOnDestroy();
    }

    /**
     * 当前是否真正允许启动增强：真实 resumed **且** Activity 仍有效。
     *
     * <p>两者都要：resumed 保证用户在看；非 null/非 finishing 保证不是正在销毁。
     * 无法判断时保守返回 false（宁可不启用，也不后台偷偷启动）。
     */
    private boolean isActivityVisible() {
        if (!activityResumed) return false;
        try {
            if (getActivity() == null) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
                return !getActivity().isFinishing() && !getActivity().isDestroyed();
            }
            return !getActivity().isFinishing();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 打开系统设置页（B3：休息提示卡片"去系统设置"）。
     *
     * <h2>严格受限目标</h2>
     * 只接受 {@link RestSettingsTargets.Target} 枚举里的三个值，**不接受**任意 action/URI/package/channelId。
     * 包名一律取自本 App Context，渠道一律用本类既有 {@link #CHANNEL_ID} 常量。
     *
     * <h2>语义边界（必须说准）</h2>
     * <ul>
     *   <li>{@code opened} **只表示系统接受了打开请求**，<b>不是授权结果</b>；
     *       绝不把任何权限字段本地置 true；</li>
     *   <li>主线程执行，且**真实 Activity 可见**才响应；排队后已暂停则不后台拉起；</li>
     *   <li>打开设置/返回/刷新**不得** schedule/cancel 提醒、改 token/generation/deadline、
     *       启停 FGS 或持锁 —— 本方法只发 Intent，不触碰任何提醒状态。</li>
     * </ul>
     */
    @PluginMethod
    public void openRestReminderSettings(PluginCall call) {
        JSObject ret = new JSObject();
        String raw = call.getData() != null ? call.getData().optString("target", null) : null;
        RestSettingsTargets.Target target = RestSettingsTargets.fromWire(raw);
        if (target == null) {
            // 未知目标：fail closed，绝不猜
            ret.put("opened", false);
            ret.put("requestedTarget", raw);
            ret.put("actualTarget", (String) null);
            ret.put("reason", "unknown-target");
            call.resolve(ret);
            return;
        }
        // 主线程执行 + 执行时复核可见性（排队后已暂停则不拉起）
        getBridge().executeOnMainThread(() -> {
            JSObject out = new JSObject();
            out.put("requestedTarget", target.wire);
            if (!isActivityVisible()) {
                out.put("opened", false);
                out.put("actualTarget", (String) null);
                out.put("reason", "activity-not-visible");
                call.resolve(out);
                return;
            }
            OpenedResult r = openSettingsTarget(target);
            out.put("opened", r.opened);
            out.put("actualTarget", r.actualTarget);
            if (!r.opened) out.put("reason", r.reason);
            call.resolve(out);
        });
    }

    /** 打开结果：opened 只代表系统接受请求，不是授权 */
    static final class OpenedResult {
        final boolean opened;
        final String actualTarget;
        final String reason;

        OpenedResult(boolean opened, String actualTarget, String reason) {
            this.opened = opened;
            this.actualTarget = actualTarget;
            this.reason = reason;
        }
    }

    /**
     * 按标准入口打开目标，失败时按合理顺序 fallback，返回**实际**打开的目标。
     *
     * <p>顺序：目标页 → 本 App 通知页 → 本 App 详情页；SDK 不支持时直接降级。
     */
    private OpenedResult openSettingsTarget(RestSettingsTargets.Target target) {
        String pkg = getContext().getPackageName();
        // 依次尝试的候选（target → 通知页 → 详情页）
        java.util.List<OpenedResult> attempts = new java.util.ArrayList<>();
        for (RestSettingsTargets.Target t : RestSettingsTargets.fallbackChain(target)) {
            Intent i = buildSettingsIntent(t, pkg);
            if (i == null) continue;
            try {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                // 记录实际打开的目标
                return new OpenedResult(true, t.wire, null);
            } catch (Exception e) {
                attempts.add(new OpenedResult(false, t.wire, e.getClass().getSimpleName()));
            }
        }
        // 全部失败：如实返回，让 UI 给手动指路
        String lastReason = attempts.isEmpty() ? "no-candidate"
            : attempts.get(attempts.size() - 1).reason;
        return new OpenedResult(false, null, "all-failed:" + lastReason);
    }

    /** 目标 → 候选链（含 fallback），已按优先级排序 */
    private java.util.List<RestSettingsTargets.Target> fallbackChain(RestSettingsTargets.Target target) {
        java.util.List<RestSettingsTargets.Target> chain = new java.util.ArrayList<>();
        chain.add(target);
        // 精确闹钟不可达时，退回 App 通知页再退回详情页
        if (target != RestSettingsTargets.Target.APP_NOTIFICATIONS) {
            chain.add(RestSettingsTargets.Target.APP_NOTIFICATIONS);
        }
        chain.add(RestSettingsTargets.Target.DETAILS_FALLBACK);
        return chain;
    }

    /**
     * 构造标准 Intent；SDK 不支持该入口时返回 null（让调用方继续 fallback）。
     *
     * <p>只用官方常量与固定本包名/渠道，不接受外部传入。
     */
    private Intent buildSettingsIntent(RestSettingsTargets.Target t, String pkg) {
        int sdk = Build.VERSION.SDK_INT;
        switch (t) {
            case APP_NOTIFICATIONS:
                if (sdk < 26) return null; // API24–25 无该入口 → 走详情页兜底
                {
                    Intent i = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                    i.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, pkg);
                    return i;
                }
            case REST_CHANNEL:
                if (sdk < 26) return null; // 无渠道概念 → 通知页/详情页
                {
                    Intent i = new Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
                    i.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, pkg);
                    i.putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, CHANNEL_ID);
                    return i;
                }
            case EXACT_ALARM:
                if (sdk < 31) return null; // 该权限概念从 31 起
                {
                    Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                    i.setData(android.net.Uri.parse("package:" + pkg));
                    return i;
                }
            case DETAILS_FALLBACK:
                {
                    Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    i.setData(android.net.Uri.parse("package:" + pkg));
                    return i;
                }
            default:
                return null;
        }
    }

    private void cancelAlarmOnly() {
        AlarmManager am = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            // 取消所有代次可能留下的闹钟：用 FLAG_UPDATE_CURRENT 的同一 action 逐个取消不可行，
            // 因此这里按"当前已知代次附近"清理（见 cancelAllKnownAlarms）。
            cancelAllKnownAlarms(am);
        } catch (Exception ignored) {
            // 取消失败：接收器侧仍有 generation 核验兜底
        }
    }

    /** 清理当前及最近若干代次的闹钟（每代次 requestCode 不同，必须逐个取消） */
    private void cancelAllKnownAlarms(AlarmManager am) {
        RestReminderState.Snapshot cur = RestReminderStore.read(getContext());
        for (int i = 0; i <= 8; i++) {
            long gen = cur.generation - i;
            if (gen < 0) break;
            try {
                am.cancel(buildPendingIntent(null, gen, 0));
            } catch (Exception ignored) {
                // 单个代次取消失败不影响其余
            }
        }
    }

    private PendingIntent buildPendingIntent(String token, long generation, int notifId) {
        Intent intent = new Intent(getContext(), RestAlarmReceiver.class);
        intent.setAction(ACTION_REST_DONE);
        if (token != null) intent.putExtra(EXTRA_TOKEN, token);
        intent.putExtra(EXTRA_GENERATION, generation);
        intent.putExtra(RestAlarmReceiver.EXTRA_NOTIF_ID, notifId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        // requestCode 随代次变化，避免不同代次的 PendingIntent 互相覆盖
        int requestCode = REQUEST_CODE_BASE + (int) (generation % 1000);
        return PendingIntent.getBroadcast(getContext(), requestCode, intent, flags);
    }
}
