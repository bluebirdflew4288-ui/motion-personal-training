package app.motion.personal.plugins;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * 当前一段休息的**可见前台计时服务**（A2 批准的最小普通后台增强）。
 *
 * <h2>它解决什么 / 不解决什么</h2>
 * 改善普通后台与短时熄屏下的计时条件：不再依赖 WebView interval，也不必只靠
 * {@code allowWhileIdle} 的系统频率配额。
 * <b>不保证深 Doze、OEM 后台策略或物理震感</b> —— 这些仍未验证。
 *
 * <h2>严格边界（对应 A2 裁决）</h2>
 * <ul>
 *   <li><b>只在用户可见操作引发</b>的休息开始/恢复/加时时启动/更新；
 *       快照恢复、开机、定时复活一律不启动。</li>
 *   <li>非导出服务；安静持续通知（无声音、无全屏、不强制亮屏）。</li>
 *   <li>API 34+ 用最窄的 {@code systemExempted} 类型，**前提是实际持有精确闹钟授权**
 *       且通知可达；不满足就不启动，保留既有 AlarmManager 路径。</li>
 *   <li>wake lock **显式有界**：只覆盖当前余量 + 极小收尾窗口，更新时按新余量延展。</li>
 *   <li>暂停/取消/跳过/完成/替换/异常 → 一律释放锁并停服务，绝不留孤儿。</li>
 *   <li>到期与备用闹钟**共用** {@link RestReminderStore} 的 token+generation 与
 *       持久化消费门禁，因此两个竞争源只会通知一次。</li>
 * </ul>
 *
 * <h2>为什么不用 shortService</h2>
 * 它约 3 分钟上限且非 sticky，而一次休息可以是 180 秒再加时，越界即被系统停掉，
 * 语义不成立。也不使用 specialUse 去绕过资格要求。
 */
public class RestCountdownService extends Service {

    /** 通知渠道：静默（无声音、无震动），与"到点提醒"渠道刻意分开 */
    /**
     * 持续计时通知使用**独立渠道与独立 ID**（补充验收 #4）。
     *
     * <p>关键原因：收尾时 {@code stopForeground(STOP_FOREGROUND_REMOVE)} 会按
     * **前台通知自己的 id** 删除通知。若到期提醒复用同一个 id，就会把刚刚发出的
     * "休息结束"通知一起删掉 —— 用户什么都看不到。因此两者 id 必须不同，
     * 且到期通知由 Receiver 用排程时分配的 notifId 发出。
     */
    static final String CHANNEL_ID = "motion-rest-countdown";
    /** 持续计时通知 id：与到期提醒的通知 id（notifId 递增）刻意错开 */
    /**
     * 持续计时通知 id：落在 {@link RestForegroundPolicy#ONGOING_ID_BASE} 起的
     * **独立区间**，与到期提醒 id 永久不相交（A3 #8）。
     */
    static final int NOTIFICATION_ID = RestForegroundPolicy.ONGOING_ID_BASE + 1;
    /** 请求码基数统一由 RestForegroundPolicy 提供（便于宿主测试） */
    private static int cancelRequestBase() {
        return RestForegroundPolicy.CANCEL_REQUEST_BASE;
    }

    /** 动作：启动/更新当前段 */
    static final String ACTION_START_OR_UPDATE = "app.motion.personal.REST_FGS_START";
    /** 动作：停止当前段（暂停/跳过/完成/替换） */
    static final String ACTION_STOP = "app.motion.personal.REST_FGS_STOP";
    /** 动作：用户在持续通知上点"取消" */
    static final String ACTION_CANCEL_FROM_NOTIFICATION = "app.motion.personal.REST_FGS_CANCEL";

    /** extra：本次休息 token */
    static final String EXTRA_TOKEN = "token";
    /** extra：本次休息代次（身份核验，旧操作不得清掉新代次） */
    static final String EXTRA_GENERATION = "generation";
    /** extra：剩余毫秒（仅在没有 deadline 时作为退化输入） */
    static final String EXTRA_REMAINING_MS = "remainingMs";
    /**
     * extra：**排程入口一次确定的单调截止**（elapsedRealtime 基准）。
     *
     * <p>服务只据此换算剩余，不再"接收时刻 + remainingMs"，避免晚到即延长。
     */
    static final String EXTRA_DEADLINE_ELAPSED = "deadlineElapsed";
    /** extra：停止原因（诊断用，短字符串） */
    static final String EXTRA_STOP_REASON = "stopReason";
    /**
     * A5：停止命令必须携带**归属身份**（刚被 durable 取消的旧 token/generation）。
     *
     * <p>只带 reason 的 stop 无法在执行端核对归属，旧命令可能停掉新段。
     */
    static final String EXTRA_STOP_TOKEN = "stopToken";
    static final String EXTRA_STOP_GENERATION = "stopGeneration";
    /**
     * A5：取消水位。全清（无身份）时携带本次成功取消后的 generation，
     * 执行端若发现持久态/本地段已推进到该水位之后，则拒绝这条旧全清。
     */
    static final String EXTRA_CANCEL_WATERMARK = "cancelWatermark";

    /** wake lock 固定匿名 tag（官方建议：不要用会泄露用户信息的 tag） */
    private static final String WAKE_LOCK_TAG = "motion:rest-countdown";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    /** 本次前台段的身份（用于拒绝旧代次的操作） */
    private String token;
    private long generation = -1L;
    /** 最新一次 onStartCommand 的 startId */
    private int lastStartId = -1;
    /**
     * **当前有效段**的归属标记（补充验收 #3）。
     *
     * <p>每次成功启动/更新一段时递增。旧段的到期回调/超时/清理携带的是**旧标记**，
     * 与当前标记不符 → 一律不停止服务、不释放新段的锁。
     * 只靠 {@code stopSelf(startId)} 不够：新段到来时 lastStartId 已变成新值，
     * 旧回调传旧 id 反而"恰好"能停掉新段。必须显式比较段标记。
     */
    private int segmentSeq = 0;
    /** 单调时钟下的截止时刻（elapsedRealtime） */
    private long deadlineElapsed = -1L;

    /** 当前进程内是否已有一段**成功进入前台**的有效计时（A3 #5 用） */
    private boolean hasActiveSegment() {
        return segmentSeq > 0 && token != null && generation >= 0L;
    }

    /** 到期回调（携带段标记：旧段的回调不得影响新段） */
    private Runnable expiryRunnable;

    @Override
    public IBinder onBind(Intent intent) {
        // 非导出、非绑定服务
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        if (intent == null) {
            /**
             * A3 #5：null intent（系统重启，START_NOT_STICKY 下正常不会发生）
             * 不猜状态、直接收束；若恰有新段在跑也不影响它（段标记校验）。
             */
            stopSelfSafely("null-intent");
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            handleStopCommand(intent);
            return START_NOT_STICKY;
        }
        if (ACTION_CANCEL_FROM_NOTIFICATION.equals(action)) {
            handleCancelFromNotification(intent);
            return START_NOT_STICKY;
        }
        if (ACTION_START_OR_UPDATE.equals(action)) {
            handleStartOrUpdate(intent);
            return START_NOT_STICKY;
        }
        stopSelfSafely("unknown-action");
        return START_NOT_STICKY;
    }

    private void handleStartOrUpdate(Intent intent) {
        String inToken = RestArgs.tokenOrNull(intent.getStringExtra(EXTRA_TOKEN));
        long inGen = intent.getLongExtra(EXTRA_GENERATION, -1L);
        long remainingMs = intent.getLongExtra(EXTRA_REMAINING_MS, 0L);
        if (inToken == null || inGen < 0L || remainingMs <= 0L) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED, "invalid-start-args");
            stopSelfSafely("invalid-start-args");
            return;
        }

        /**
         * 身份门禁：只接受**当前持久化身份**的启动/更新。
         * 旧代次的迟到更新不得覆盖新代次（否则旧操作会清掉新计时）。
         */
        RestReminderState.Snapshot cur = RestReminderStore.read(this);
        if (cur.token == null || !inToken.equals(cur.token) || inGen != cur.generation) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED, "stale-identity");
            /**
             * A3 #5：被拒绝的启动**必须正确收束**。
             *
             * <p>旧实现直接 `return`，于是一个刚被 startForegroundService 创建、
             * 尚未 promote 的空服务既不进入前台也不停止 —— 会撞上系统的
             * "启动后必须在期限内进入前台"限制（ANR/被杀），还可能拖累进程。
             *
             * <p>规则：
             * <ul>
             *   <li>已有**新有效段**在跑 → 只拒绝本次，**不得停新段**；</li>
             *   <li>没有有效段（本进程从未成功 promote）→ 立即自停，不留空服务。</li>
             * </ul>
             */
            /**
             * A3 #5：**必须**收束，不能只是 return。
             * 若已有新有效段 → 只拒绝本次（不停新段）；
             * 否则（空服务/本进程从未 promote）→ 立即自停，避免超期崩溃。
             */
            if (!hasActiveSegment()) {
                stopSelfSafely("rejected-stale-no-segment");
            }
            return;
        }

        token = inToken;
        generation = inGen;
        /**
         * 截止时刻**必须沿用排程入口一次确定的值**（补充验收 #1）。
         *
         * <p>旧实现用 `接收时刻 + remainingMs` 重算，服务启动稍晚（系统排队、
         * 冷启动、后台限制重试）就会把休息**越推越晚** —— 这是实打实的延长 bug。
         *
         * <p>现在由插件在排程时用单调时钟算好 `deadlineElapsed` 一并传入；
         * 服务只做"还剩多久"的换算，绝不重新加剩余量。若上游没给（旧调用形态），
         * 退化为按到达时刻换算但**记录诊断**，便于发现调用方遗漏。
         */
        long inDeadline = intent.getLongExtra(EXTRA_DEADLINE_ELAPSED, -1L);
        long nowElapsed = SystemClock.elapsedRealtime();
        if (inDeadline <= 0L) {
            /**
             * A3 #5：缺 deadline **不再**默默用"接收时刻 + remainingMs"重算。
             *
             * <p>那正是"晚到即延长"的老 bug。所有生产调用点都必须传一次算好的
             * deadline；缺了就明确拒绝并收束，绝不猜。
             */
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED, "deadline-missing");
            if (!hasActiveSegment()) stopSelfSafely("rejected-deadline-missing");
            return;
        }
        deadlineElapsed = inDeadline;
        // 真实剩余以单调截止为准：避免"晚到即延长"
        long effectiveRemaining = RestForegroundPolicy.effectiveRemaining(deadlineElapsed, nowElapsed);
        if (effectiveRemaining <= 0L) {
            // 已经过期：不再起服务，直接走一次到期消费（仍是同一门禁）
            segmentSeq += 1;
            onSegmentExpired(segmentSeq);
            return;
        }

        if (!enterForeground(effectiveRemaining)) {
            // 进入前台失败：准确降级（诊断已记录），绝不吞掉既有闹钟路径
            stopSelfSafely("start-foreground-failed");
            return;
        }

        // 本段正式生效：分配段标记（旧段的迟到收尾会因标记不符而被忽略）
        segmentSeq += 1;
        final int mySegment = segmentSeq;
        /**
         * A3 #7：wake lock 申请失败必须**准确降级**。
         *
         * <p>旧实现无论 acquire 是否成功都记 `fgs-started`，并保持前台通知，
         * 等于宣称"增强已启用"但实际没有锁保护 —— 状态与实际不符。
         *
         * <p>现在：失败则移除到期回调、释放已持有的锁、移除持续通知并停本段，
         * **保留基础 AlarmManager 路径**，如实记录 `wake-lock-failed`。
         */
        if (!acquireBoundedWakeLock(effectiveRemaining)) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED, "wake-lock-failed");
            stopSelfSafely("wake-lock-failed", mySegment);
            return;
        }
        scheduleExpiry(effectiveRemaining, mySegment);
        RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STARTED, "systemExempted");
    }

    /**
     * 合法、及时地进入前台。
     *
     * @return false 表示进入前台失败（已记录真实原因）
     */
    private boolean enterForeground(long remainingMs) {
        try {
            Notification n = buildNotification(remainingMs);
            if (RestForegroundPolicy.requiresExplicitType(Build.VERSION.SDK_INT)) {
                /**
                 * API 34+ 必须带类型。这里用最窄的 systemExempted ——
                 * 它的资格条件（实际持有精确闹钟授权）已由上层
                 * {@link RestForegroundPolicy#decide} 校验过；无资格时会抛异常，
                 * 我们如实降级而不是换更宽的类型硬闯。
                 */
                startForeground(NOTIFICATION_ID, n, RestForegroundPolicy.TYPE_SYSTEM_EXEMPTED);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            return true;
        } catch (Exception e) {
            // 类型不允许 / 通知渠道不可用 / 系统拒绝：只记录异常类名
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED,
                "start-foreground:" + e.getClass().getSimpleName());
            return false;
        }
    }

    /**
     * 有界 wake lock：明确超时，绝不无限持有。
     *
     * @return true 表示确实持有了锁；false 表示未能持有（调用方必须降级）
     */
    private boolean acquireBoundedWakeLock(long remainingMs) {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            releaseWakeLock();
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wakeLock.setReferenceCounted(false);
            long ms = RestForegroundPolicy.wakeLockMsFor(remainingMs);
            if (ms <= 0L) return false;
            wakeLock.acquire(ms);
            return wakeLock != null && wakeLock.isHeld();
        } catch (Exception e) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED,
                "wake-lock:" + e.getClass().getSimpleName());
            return false;
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // 释放失败不应阻断停服务
        } finally {
            wakeLock = null;
        }
    }

    private void scheduleExpiry(long remainingMs, final int forSegment) {
        if (expiryRunnable != null) handler.removeCallbacks(expiryRunnable);
        expiryRunnable = new Runnable() {
            @Override
            public void run() {
                // 旧段回调：新段已接管 → 什么都不做（不停服务、不释放新锁、不消费）
                if (!RestForegroundPolicy.mayStopSegment(forSegment, segmentSeq)) {
                    RestReminderStore.diag(RestCountdownService.this,
                        RestDiagLog.KIND_FGS_STOPPED, "stale-expiry-ignored");
                    return;
                }
                onSegmentExpired(forSegment);
            }
        };
        handler.postDelayed(expiryRunnable, Math.max(0L, remainingMs));
    }

    /**
     * 到期：与备用 AlarmManager **共用同一个消费门禁**。
     *
     * <p>两个竞争源都调用 {@link RestReminderState#onAlarmFired}，由持久化状态决定
     * 谁真正消费 —— 因此只会通知一次。这里不另造第二套训练状态。
     */
    private void onSegmentExpired(int forSegment) {
        try {
            /**
             * **必须走唯一出口**（补充验收 #3）。
             *
             * <p>旧实现自己在服务里 `transition(onAlarmFired)` 消费一次，然后调用
             * Receiver 的 postNotificationFor —— 但 postNotificationFor 只负责发通知、
             * **不消费**。看起来是"一次消费+一次通知"，可一旦被改成"服务消费后再让
             * receiver 二次消费"，第二次就会被 already-fired 门禁吞掉，通知发不出去。
             * 这里统一调用 {@link RestAlarmReceiver#consumeAndNotify}：
             * 消费与通知在同一次调用里完成，两个竞争源行为完全一致。
             */
            int notifId = RestForegroundPolicy.reminderNotificationId(
                RestReminderStore.read(this).notifId);
            RestAlarmReceiver.consumeAndNotify(this, token, generation, notifId);
        } catch (Exception e) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FIRE_REJECTED,
                "fgs-expiry:" + e.getClass().getSimpleName());
        } finally {
            /**
             * 到期收尾：这里**只移除持续通知**。
             * 因为持续通知用独立 id（见 NOTIFICATION_ID 注释），
             * stopForeground(REMOVE) 不会删掉刚发出的"休息结束"通知。
             */
            stopSelfSafely("expired", forSegment);
        }
    }

    /** 用户在持续通知上点"取消"：必须按**当前身份**取消，不误伤新代次 */
    /**
     * 用户在持续通知上点"取消"。
     *
     * <p><b>A3 #4：只有真实 durable 取消当前身份成功，才允许收束本段。</b>
     *
     * <p>旧实现用 `finally { stopSelfSafely(...) }` —— 于是**取消失败也会停服务**：
     * <ul>
     *   <li>旧通知的按钮被点（cancelIfCurrent 判为陈旧 → NOOP）→ 会误停新段；</li>
     *   <li>持久化失败 → 状态没变却停了服务，基础 alarm 也可能被误清。</li>
     * </ul>
     * 现在：只有 CANCEL 且 durable 才停；被拒绝时**只记录、不动服务**。
     */
    private void handleCancelFromNotification(Intent intent) {
        String inToken = RestArgs.tokenOrNull(intent.getStringExtra(EXTRA_TOKEN));
        long inGen = intent.getLongExtra(EXTRA_GENERATION, -1L);
        if (inToken == null || inGen < 0L) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED, "cancel-invalid-identity");
            // 身份都没给：不猜、不动服务
            return;
        }
        RestReminderGate.Result gate;
        try {
            gate = RestReminderStore.transition(this,
                cur -> RestReminderState.cancelFromNotification(cur, inToken, inGen));
        } catch (Exception e) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED,
                "cancel:" + e.getClass().getSimpleName());
            return; // 异常同样不擅自动服务
        }
        boolean cancelled = gate.durable
            && gate.outcome != null
            && gate.outcome.action == RestReminderState.Outcome.Action.CANCEL;
        if (!cancelled) {
            /**
             * 取消未被接受（陈旧身份 / 持久化失败）：**不得**停当前段、不得清基础 alarm。
             * 这条正是 A3 #4 要求的"旧通知不能误清新代次"。
             */
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_FAILED,
                "cancel-rejected:" + (gate.durable ? "stale-or-noop" : "persist-failed"));
            return;
        }
        // 真正取消成功：取消基础 alarm（按旧身份）并停本段，同时唤醒同进程前端对账
        try {
            cancelBaseAlarmFor(inToken, inGen);
        } catch (Exception ignored) {
            // 取消失败不阻断停服务
        }
        stopSelfSafely("cancelled-from-notification");
        RestReminderStore.notifyUserCancelled(inToken, inGen);
    }

    /**
     * 取消基础 AlarmManager 提醒（按身份，不误伤新代次）。
     *
     * <p>A3 #4 要求"取消成功才取消其基础 alarm"，因此只在 durable 取消后调用。
     */
    private void cancelBaseAlarmFor(String tok, long gen) {
        android.app.AlarmManager am =
            (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        android.content.Intent i = new android.content.Intent(this, RestAlarmReceiver.class);
        i.setAction(RestReminderPlugin.ACTION_REST_DONE);
        int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
        }
        int requestCode = RestReminderPlugin.REQUEST_CODE_BASE + (int) (gen % 1000);
        android.app.PendingIntent pi =
            android.app.PendingIntent.getBroadcast(this, requestCode, i, flags);
        try {
            am.cancel(pi);
        } catch (Exception ignored) {
            // 无残留时 cancel 无副作用
        }
    }

    /** 统一收尾：释放锁 → 移除通知 → 停服务，任何路径都走这里 */
    private void stopSelfSafely(String reason) {
        stopSelfSafely(reason, -1);
    }

    /**
     * 统一收尾（带段归属校验）。
     *
     * @param forSegment 触发本次收尾的段标记；-1 表示"无条件收尾"
     *                   （用户主动暂停/跳过、onTaskRemoved 等明确意图）
     */
    private void stopSelfSafely(String reason, int forSegment) {
        /**
         * 关键：旧段（forSegment 与当前 segmentSeq 不符）**不得停止新段**。
         * 典型场景：上一段休息的到期回调迟到，而用户已经开始了新一段休息。
         */
        if (!RestForegroundPolicy.mayStopSegment(forSegment, segmentSeq)) {
            RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STOPPED, "stale-stop-ignored");
            return;
        }
        if (expiryRunnable != null) handler.removeCallbacks(expiryRunnable);
        releaseWakeLock();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                //noinspection deprecation
                stopForeground(true);
            }
        } catch (Exception ignored) {
            // 停前台失败不阻断 stopSelf
        }
        RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STOPPED, reason == null ? "unknown" : reason);
        // 段已确认属于当前：正常停止（startId 已是本段最新值）
        stopSelf();
        token = null;
        generation = -1L;
        deadlineElapsed = -1L;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(expiryRunnable);
        releaseWakeLock();
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务移除：尊重用户意图，立刻收尾，不做复活
        stopSelfSafely("task-removed");
        super.onTaskRemoved(rootIntent);
    }

    /**
     * 安静持续通知：显示倒计时与"取消"，无声音、无全屏、不强制亮屏。
     *
     * <p><b>取消按钮的身份必须随代次变化</b>（补充验收 #2）。
     *
     * <p>旧实现用**固定 requestCode + FLAG_UPDATE_CURRENT**：当新代次更新通知时，
     * 系统会把**同一个 PendingIntent 句柄**的 extras 改写成新代次 —— 于是通知栏里
     * 那条"旧"取消按钮实际上携带了新身份。`FLAG_IMMUTABLE` 只阻止**外部应用**修改，
     * **不阻止创建者自己用 UPDATE_CURRENT 更新**，所以它并不能防住这个问题。
     *
     * <p>现在的做法：requestCode 随 `generation` 变化，并且**不使用 UPDATE_CURRENT**
     * （改用 `FLAG_CANCEL_CURRENT` 显式重建）。旧代次的按钮保留旧 token/generation，
     * 点它会被 {@link RestReminderState#cancelIfCurrent} 判为陈旧而拒绝，
     * **不会误清新代次**。
     */
    private Notification buildNotification(long remainingMs) {
        ensureChannel();
        Intent cancel = new Intent(this, RestCountdownService.class);
        cancel.setAction(ACTION_CANCEL_FROM_NOTIFICATION);
        cancel.putExtra(EXTRA_TOKEN, token);
        cancel.putExtra(EXTRA_GENERATION, generation);
        int flags = PendingIntent.FLAG_CANCEL_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        // requestCode 随代次变化：旧代次句柄不会被新代次覆盖
        int requestCode = RestForegroundPolicy.cancelRequestCode(generation);
        PendingIntent cancelPi = PendingIntent.getService(this, requestCode, cancel, flags);

        /**
         * N01：正文点击 → 打开/带回**已有**的 MOTION Activity（与「取消」是不同动作）。
         *
         * <p>用系统启动 Intent 指向本应用唯一 MainActivity（launchMode=singleTask）：
         * 应用已在后台则把原任务带回前台，保留 WebView 与会话状态；不 CLEAR_TASK、
         * 不重建任务、不跳到具体训练卡。取消仍是下方独立 action，两者互不复用。
         */
        PendingIntent contentPi = buildContentIntent();

        /**
         * A5 #4：正文**不再写固定的初始数字**（旧实现写死"剩余 00:15"，
         * 与系统 chronometer 的实时值并列矛盾）。实时数值由 chronometer 承担。
         *
         * N01：正文点击现在**打开/带回应用**（见 {@link #buildContentIntent()}），
         * 取消是下方独立 action 按钮；因此正文不能再写「点此取消」，避免误指取消动作。
         */
        String text = "休息进行中（点此返回应用）";
        /**
         * A3 #6：必须用**系统倒计时**（chronometer）而不是静态文本。
         *
         * <p>旧实现只写启动那一刻的"剩余 00:15"，通知不会自己走；
         * 推进 3 秒后仍显示 00:15。`setUsesChronometer(true)` +
         * `setChronometerCountDown(true)`（API24+）由系统绘制每秒递减，
         * **不需要** App 侧任何 1Hz 轮询，也不触碰父组件渲染约束。
         *
         * <p>`setWhen(System.currentTimeMillis() + remainingMs)` 给出目标时刻，
         * 系统据此倒计时；API24 以下没有 countDown 支持，退化为静态文本。
         */
        long endsAtWallClock = System.currentTimeMillis() + Math.max(0L, remainingMs);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("组间休息计时")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .addAction(0, "取消", cancelPi);
        /**
         * N01：正文点击打开/带回应用（Activity PendingIntent）。
         * 与「取消」是不同动作：取消走上面的 getService + ACTION_CANCEL_FROM_NOTIFICATION。
         */
        if (contentPi != null) b.setContentIntent(contentPi);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // 系统自己走秒：无需 App 轮询
            b.setUsesChronometer(true)
                .setChronometerCountDown(true)
                .setShowWhen(true)
                .setWhen(endsAtWallClock);
        } else {
            // 旧系统无倒计时能力：退回静态文本（如实，不假装动态）
            b.setShowWhen(false);
        }
        return b.build();
    }

    /**
     * N01：构造「点击通知正文 → 打开/带回 MOTION」的 Activity PendingIntent。
     *
     * <h2>为什么这样写</h2>
     * <ul>
     *   <li>用系统的启动 Intent（{@link android.content.pm.PackageManager#getLaunchIntentForPackage}）
     *       指向本应用唯一 {@code MainActivity}（manifest 里 {@code launchMode=singleTask}）。
     *       应用已在后台时，会把原任务带回前台并投递 onNewIntent，**保留 WebView 与会话状态**。</li>
     *   <li>**不**使用 {@code CLEAR_TASK} / {@code TaskStackBuilder} / {@code FLAG_ACTIVITY_CLEAR}
     *       —— 那类示例会清空/重建任务，等于把正在计时的训练页重置掉。</li>
     *   <li>不新增到具体训练卡的深链：正文只回到应用，由应用自身恢复当前路由。</li>
     *   <li>极端情况下拿不到启动 Intent 时，兜底显式指向 {@code MainActivity}，
     *       保证正文一定有可打开的应用入口（不会出现“点了没反应”）。</li>
     * </ul>
     *
     * <p><b>与取消的区别</b>：取消是 {@code getService} + {@link #ACTION_CANCEL_FROM_NOTIFICATION}
     * 且携带 token/generation；本方法只是打开应用，不取消、不启动/停止计时、不改当前代次。
     *
     * @return 始终非 null 的 Activity PendingIntent（用于 {@code setContentIntent}）
     */
    private PendingIntent buildContentIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) {
            // 兜底：显式指向唯一 MainActivity，确保正文一定有打开入口
            launch = new Intent(this, app.motion.personal.MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(
            this, RestForegroundPolicy.contentRequestCode(), launch, flags);
    }

    /**
     * 持续计时渠道本身是否**可达**（A3 #6）。
     *
     * <p>旧实现只检查"到点提醒"渠道（`channelEnabled()`），于是持续渠道被用户
     * 单独关掉时仍宣称"可见增强已启用" —— 用户其实看不到倒计时。
     */
    static boolean ongoingChannelReachable(Context ctx) {
        try {
            NotificationManagerCompat nmc = NotificationManagerCompat.from(ctx);
            if (!nmc.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
            NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
            // 渠道未创建时，启动后会创建为 IMPORTANCE_LOW，视为可达
            return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
        } catch (Exception e) {
            return false;
        }
    }

    /** 静默渠道（无声音、无震动），与"到点提醒"渠道分开 */
    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "休息计时中", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("休息进行中的静默倒计时");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    /** 倒计时格式化：委托纯 JVM 的 Policy，便于宿主测试真实执行 */
    static String fmtCountdown(long ms) {
        return RestForegroundPolicy.fmtCountdown(ms);
    }

    // ── 供插件调用（静态入口，避免插件直接持有 Service 实例）──────────

    /** 启动/更新当前段（仅由可见 Activity 的用户操作路径调用） */
    static void startOrUpdate(
        Context ctx, String token, long generation, long remainingMs, long deadlineElapsed) {
        Intent i = new Intent(ctx, RestCountdownService.class);
        i.setAction(ACTION_START_OR_UPDATE);
        i.putExtra(EXTRA_TOKEN, token);
        i.putExtra(EXTRA_GENERATION, generation);
        i.putExtra(EXTRA_REMAINING_MS, remainingMs);
        // 排程入口定死的单调截止：服务只据此换算剩余，不再"接收时刻+剩余"
        i.putExtra(EXTRA_DEADLINE_ELAPSED, deadlineElapsed);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }

    /**
     * 执行端核对停止命令的归属（A5 #1/#2）。
     *
     * <p>规则：
     * <ul>
     *   <li>带身份（token+generation）：必须等于**当前本地段**身份才停；
     *       陈旧 → 只拒绝，不停新段、不放新锁；</li>
     *   <li>无身份但带取消水位：若当前段 generation **已推进到水位之后** →
     *       拒绝这条延迟的旧全清；否则按明确全清收束；</li>
     *   <li>两者都缺：fail-closed，不停任何有效段；空服务则自停收束。</li>
     * </ul>
     */
    private void handleStopCommand(Intent intent) {
        String reason = intent.getStringExtra(EXTRA_STOP_REASON);
        String inToken = RestArgs.tokenOrNull(intent.getStringExtra(EXTRA_STOP_TOKEN));
        long inGen = intent.getLongExtra(EXTRA_STOP_GENERATION, -1L);
        long watermark = intent.getLongExtra(EXTRA_CANCEL_WATERMARK, -1L);

        if (inToken != null && inGen >= 0L) {
            // 按身份停止：只接受与当前段一致的
            if (token != null && inToken.equals(token) && inGen == generation) {
                stopSelfSafely(reason == null ? "stopped" : reason);
            } else {
                RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STOPPED,
                    "stale-stop-rejected");
                if (!hasActiveSegment()) stopSelfSafely("stale-stop-empty-service");
            }
            return;
        }
        if (watermark >= 0L) {
            /**
             * 延迟的旧全清：若当前段（或持久态）已推进到水位之后，
             * 说明这是"旧世代的全清"，不得停掉其后新启动的段。
             */
            RestReminderState.Snapshot cur = RestReminderStore.read(this);
            boolean advanced = (generation >= 0L && generation > watermark)
                || (cur.generation > watermark);
            if (advanced) {
                RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STOPPED,
                    "stale-fullclear-rejected");
                if (!hasActiveSegment()) stopSelfSafely("stale-fullclear-empty-service");
                return;
            }
            stopSelfSafely(reason == null ? "full-clear" : reason);
            return;
        }
        // 无身份也无水位：fail-closed
        RestReminderStore.diag(this, RestDiagLog.KIND_FGS_STOPPED, "stop-without-identity");
        if (!hasActiveSegment()) stopSelfSafely("stop-without-identity-empty-service");
    }

    /**
     * 停止当前段（暂停/跳过/完成/替换/异常）。
     *
     * @param identity 目标身份（按身份停止时必填）；null 表示显式全清
     * @param watermark 全清时的取消水位（-1 表示不适用）
     */
    static void stop(Context ctx, String reason,
                     String token, long generation, long watermark) {
        Intent i = new Intent(ctx, RestCountdownService.class);
        i.setAction(ACTION_STOP);
        i.putExtra(EXTRA_STOP_REASON, reason);
        if (token != null) i.putExtra(EXTRA_STOP_TOKEN, token);
        if (generation >= 0L) i.putExtra(EXTRA_STOP_GENERATION, generation);
        if (watermark >= 0L) i.putExtra(EXTRA_CANCEL_WATERMARK, watermark);
        try {
            ctx.startService(i);
        } catch (Exception ignored) {
            // 服务已停/系统拒绝：没有孤儿需要清理
        }
    }
}
