package app.motion.personal.plugins;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * 需求 2：休息到时的广播接收器。
 *
 * <h2>单一提醒出口（第二轮预审 P1 #3/#4）</h2>
 * 只发**一条带震动的通知**，由系统按用户设置决定是否震/响：
 * <ul>
 *   <li>API 26+：震动由通知渠道 {@code enableVibration + vibrationPattern} 控制；</li>
 *   <li>API 24–25：没有通知渠道，必须由通知自身配置 —— 这里设置
 *       {@code setVibrate(...)} + {@code DEFAULT_VIBRATE}，否则 Android 7.x 完全不震。</li>
 * </ul>
 * 不再额外手动调用 Vibrator：官方无 usage 参数的重载只保证前台震动，
 * 后台不可靠，且会与通知震动重复。
 *
 * <h2>身份核验（P1 #1）</h2>
 * 广播必须同时匹配 token **与 generation**，且当前代次未提醒过；
 * 因此"取消后重排"或"同 token 加时间"产生的旧广播一律被丢弃，不会提前响。
 *
 * <h2>持久化门禁（P1 #2）</h2>
 * fired 标记必须 {@code commit()} 写盘成功才允许发通知；
 * 否则进程重建后 fired 丢失会导致重复提醒。
 *
 * <h2>通知 id 递增（P1 #3）</h2>
 * 每次排程分配新的通知 id，连续两组各自独立提醒；
 * 不用固定 id + setOnlyAlertOnce 去"压掉"后续通知。
 */
public class RestAlarmReceiver extends BroadcastReceiver {

    /** 通知 id（由排程时分配并随广播传递） */
    static final String EXTRA_NOTIF_ID = "notifId";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (!RestReminderPlugin.ACTION_REST_DONE.equals(intent.getAction())) return;

        String token = RestArgs.tokenOrNull(intent.getStringExtra(RestReminderPlugin.EXTRA_TOKEN));
        if (token == null) return;
        long generation = intent.getLongExtra(RestReminderPlugin.EXTRA_GENERATION, Long.MIN_VALUE);
        int notifId = intent.getIntExtra(EXTRA_NOTIF_ID, 0);
        if (notifId <= 0) notifId = RestReminderPlugin.REQUEST_CODE_BASE;
        /**
         * A3 #8：到期提醒 id 必须经**同一映射**折回提醒区间，
         * 保证与持续通知 id（ONGOING_ID_BASE 起）永久不相交。
         */
        notifId = RestForegroundPolicy.reminderNotificationId(notifId);

        final int finalNotifId = notifId;

        /**
         * **唯一**消费 + 通知出口（补充验收 #3）。
         *
         * <p>AlarmManager 广播与当前段前台服务是两个竞争源，二者都必须走这一个方法：
         * 一次 durable 消费 → 一次通知。绝不能"服务先消费、再让 receiver 二次消费"
         * —— 那样第二次会被 already-fired 门禁吞掉，用户反而收不到通知。
         */
        consumeAndNotify(context, token, generation, finalNotifId);
    }

    /**
     * 唯一的"消费 + 通知"出口。
     *
     * <p>顺序固定：原子核验身份 → 持久化 fired（durable 才继续）→ 发通知。
     * 两个竞争源里**先到的那一个**消费成功并发通知，后到的被
     * {@link RestReminderState#onAlarmFired} 判为 already-fired 而静默丢弃，
     * 因此不会双响，也不会出现"被自己吞掉"。
     *
     * @return true 表示本次真的发出了通知尝试
     */
    static boolean consumeAndNotify(Context context, String token, long generation, int notifId) {
        RestReminderGate.Result gate = RestReminderStore.transition(
            context,
            cur -> RestReminderState.onAlarmFired(cur, token, generation)
        );

        /**
         * 旁路诊断：广播真的到了。
         *
         * <p><b>语义必须说准</b>：{@code fire} **只表示身份已被消费且 fired 已落盘**，
         * 不表示通知已发出 —— 通知结果由下面的 notify-* 事件单独记录。
         *
         * <p><b>A2 缺口 #2</b>：旧实现把"持久化失败"和"旧身份被拒"都写成同一个
         * {@code fire-rejected|fire}，事后无法归因。现在分开：
         * <ul>
         *   <li>{@code durable=false} → 记录 {@code persist-failed:<reason>}；</li>
         *   <li>{@code durable=true} 但迁移不是 fire → 记录真实的陈旧/重复原因。</li>
         * </ul>
         * 仍然 **commit-before-notify**：持久化失败就不通知（防重复），
         * 诊断只旁路记录，绝不改变这个顺序，也不重试。
         */
        if (!gate.durable) {
            // 持久化失败：与旧身份拒绝区分开，并保留真实失败原因
            RestReminderStore.diag(context, RestDiagLog.KIND_FIRE_REJECTED,
                "persist-failed:" + gate.failureReason);
            return false;
        }
        if (!RestReminderGate.mayNotify(gate)) {
            String outcomeReason = gate.outcome == null ? "null-outcome" : gate.outcome.reason;
            RestReminderStore.diag(context, RestDiagLog.KIND_FIRE_REJECTED, outcomeReason);
            return false;
        }
        /**
         * B4-R2：**投递期总开关门禁**（用户已关闭提醒）。
         *
         * <p>为什么必须在投递期再判一次：关闭提醒时虽然会 durable 取消 + 清闹钟，
         * 但已经入队的旧广播、或系统延迟投递的广播仍可能到达。
         * 用户明确关掉提醒后，这些到达**必须无声无震**。
         *
         * <p>注意：身份已被上面 durable 消费（fired=true），因此不会因为本门禁
         * 而导致同一段休息被重复提醒；这里只是不发出感知。
         */
        if (!RestReminderPlugin.reminderEnabled(context)) {
            RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_BLOCKED,
                "reminder-disabled");
            return false;
        }
        RestReminderStore.diag(context, RestDiagLog.KIND_FIRE, String.valueOf(notifId));
        postNotification(context, notifId);
        return true;
    }

    /**
     * 单一通知出口：AlarmManager 广播与当前段前台服务**共用**。
     *
     * <p>这样"到点提醒"只有一处实现，两个竞争源走同一个出口，
     * 不会出现两套文案或两套去重逻辑。
     */
    static void postNotification(Context context, int notifId) {
        try {
            /**
             * B4-R2：唯一通知出口的**最后一道**总开关门禁。
             * 两个竞争源（AlarmManager 广播 / 前台服务到期）共用本方法，
             * 因此这里判一次即可覆盖全部投递路径。
             */
            if (!RestReminderPlugin.reminderEnabled(context)) {
                RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_BLOCKED,
                    "reminder-disabled");
                return;
            }
            // 通知整体不可达 → 不提醒（也不假装震动成功）
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                // 明确记下"没尝试"，与"尝试了但失败"区分开
                RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_BLOCKED,
                    "app-notifications-off");
                return;
            }

            Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent contentIntent = open == null
                ? null
                : PendingIntent.getActivity(context, notifId, open, flags);

            NotificationCompat.Builder b =
                new NotificationCompat.Builder(context, RestReminderPlugin.CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("休息结束")
                    .setContentText("可以开始下一组了")
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER)
                    .setAutoCancel(true)
                    // 每次用新的通知 id，因此不需要 setOnlyAlertOnce（那会压掉后续提醒的震动）
                    .setOnlyAlertOnce(false);

            /**
             * API 24–25 没有通知渠道，**声音与震动都只能由通知自身声明**。
             * 26+ 由渠道配置（渠道优先级更高），重复设置无害。
             *
             * B4-R2（用户明确选择"声音＋震动"）：24–25 必须同时声明
             * DEFAULT_SOUND，否则老系统上完全不响 —— 这正是"到点不响"的一种成因。
             * 最终是否出声仍由系统音量/勿扰/渠道策略决定，不在这里承诺。
             */
            b.setVibrate(new long[] { 0, 220, 120, 220 });
            b.setDefaults(NotificationCompat.DEFAULT_VIBRATE | NotificationCompat.DEFAULT_SOUND);

            if (contentIntent != null) b.setContentIntent(contentIntent);

            NotificationManager nm =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_BLOCKED, "no-notification-service");
                return;
            }
            Notification n = b.build();
            nm.notify(notifId, n);
            /**
             * notify() 返回即"已提交给系统"，**不是**"用户已看到/已震动"：
             * 渠道震动、DND、OEM 策略仍可能压掉感知。这里只如实记"提交成功"。
             */
            RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_OK, String.valueOf(notifId));
        } catch (Exception e) {
            /**
             * 旧实现静默吞掉：用户反馈"有时不响"时完全无从判断是这里失败。
             * 现在只记录**异常类名**（不含消息，避免把路径/内容带进诊断）。
             * 仍不重试 —— commit-before-notify 的防重复顺序保持不变，避免双响。
             */
            RestReminderStore.diag(context, RestDiagLog.KIND_NOTIFY_ERROR,
                e.getClass().getSimpleName());
        }
    }
}
