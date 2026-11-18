package app.motion.personal.plugins;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 组间休息提醒状态的**持久化**（进程回收 / 页面重建后仍有效）。
 *
 * <p><b>写盘必须有成功结果</b>（第二轮预审 P1 #2）：
 * {@code SharedPreferences.apply()} 是异步且无返回值，用它无法判断是否真的落盘。
 * 这里改用 {@code commit()}（同步、返回布尔），把真实结果交给
 * {@link RestReminderGate} 判定 —— 写盘失败时调用方**不得**排程或发通知，
 * 从而不会出现"App 说已排程、重建后却丢失"的假成功。
 *
 * <p>并发：所有"读-判定-写"都在 {@link #lock} 上同步，保证原子性。
 */
public final class RestReminderStore {

    private static final String PREFS = "motion_rest_reminder";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_GENERATION = "generation";
    private static final String KEY_FIRED = "fired";
    private static final String KEY_NOTIF_ID = "notifId";
    /**
     * 用户新意图水位（B4-R2 优先级一 #3）。
     *
     * <p>只用于区分"归零后用户明确再加时"与"旧排程请求重放"，
     * 不是权限、不是代次、不参与投递判定以外的任何语义。
     */
    private static final String KEY_LAST_INTENT = "lastIntentId";
    /**
     * 水位**归属的 token**（B4-R3 closure2）。
     *
     * <p>精确取消会把 token 清空但保留水位；若不同时记住"水位属于哪个计时"，
     * 取消后同一 token 的 −15/legacy 排程会被当成全新 token 把水位重置，
     * 让旧正编号重新可被接受。缺省 null 与旧数据兼容。
     */
    private static final String KEY_LAST_INTENT_TOKEN = "lastIntentToken";
    private static final String KEY_LAST_USER_CANCEL_TOKEN = "lastUserCancelledToken";
    private static final String KEY_LAST_USER_CANCEL_GEN = "lastUserCancelledGeneration";

    /** 同进程内通知栏点击「取消」时的即时唤醒钩子（页面仍可见未触发 visibilitychange 时秒级同步） */
    public interface UserCancelListener {
        void onUserCancelled(String token, long generation);
    }

    private static volatile UserCancelListener userCancelListener;

    public static void setUserCancelListener(UserCancelListener listener) {
        userCancelListener = listener;
    }

    public static void notifyUserCancelled(String token, long generation) {
        UserCancelListener l = userCancelListener;
        if (l != null && token != null && generation >= 0L) {
            try {
                l.onUserCancelled(token, generation);
            } catch (Exception ignored) {
                // 旁路唤醒异常不影响已落盘的取消结果
            }
        }
    }
    /**
     * 最小本地诊断（有界、不含 token/训练内容）。
     *
     * <p>与身份状态放在同一个 SharedPreferences 里，但**独立成键**：
     * 诊断写入失败绝不能影响身份迁移，反之亦然。
     */
    private static final String KEY_DIAG = "diagLog";

    /**
     * 诊断事件的**独立 prefs 文件**（B4-R3 / Codex ANDROID-COMMIT-BOUNDARY-NOTE）。
     *
     * <p>为什么必须与身份分开文件：{@code apply()} / {@code commit()} 写盘时会把
     * **该 prefs 文件当时的整张内存表**序列化到磁盘。身份 commit 失败后，
     * 候选身份仍留在 {@code motion_rest_reminder} 的内存表里（AOSP 的
     * {@code commitToMemory()} 先改 mMap，写盘失败不回滚）。此时若诊断仍写同一个文件，
     * 一次旁路 {@code apply()} 就可能把**失败的候选身份偷偷回灌到磁盘**，
     * 于是"写盘失败"被稀释成"其实写成功了"。
     *
     * <p>分开文件后，诊断成为真正的旁路：它永远碰不到身份表。
     */
    private static final String PREFS_DIAG = "motion_rest_reminder_diag";

    /** 进程内锁：保证"读-判定-写"原子（接收器与插件调用可能并发） */
    private static final Object lock = new Object();

    /**
     * **已确认落盘**的身份视图（B4-R3 F2/O3）。
     *
     * <p>只采纳 {@code commit()==true} 的候选。持续写盘失败期间，
     * 本进程看到的是**磁盘真实值**，而不是失败候选 —— 否则
     * 「取消的 commit 失败但内存已改成 token=null」会被 getActive/恢复路径
     * 当成"durable 已取消"，从而错误地清掉原生资源或误报已关闭。
     */
    private static final RestDurableView view = new RestDurableView();

    private RestReminderStore() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SharedPreferences diagPrefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS_DIAG, Context.MODE_PRIVATE);
    }

    /** 直接从存储读候选值（**仅供首次装载基线**；业务读取一律走 {@link #read}） */
    private static RestReminderState.Snapshot readStored(Context ctx) {
        SharedPreferences p = prefs(ctx);
        return new RestReminderState.Snapshot(
            p.getString(KEY_TOKEN, null),
            p.getLong(KEY_GENERATION, 0L),
            p.getBoolean(KEY_FIRED, false),
            p.getInt(KEY_NOTIF_ID, 0),
            p.getLong(KEY_LAST_INTENT, 0L),
            p.getString(KEY_LAST_INTENT_TOKEN, null),
            p.getString(KEY_LAST_USER_CANCEL_TOKEN, null),
            p.getLong(KEY_LAST_USER_CANCEL_GEN, -1L)
        );
    }

    /**
     * 读取**已确认落盘**的当前快照。
     *
     * <p>B4-R3：不再是"直接读 SharedPreferences"。Android 的 commit 先改内存再写盘，
     * 写盘失败不回滚内存（AOSP {@code SharedPreferencesImpl.EditorImpl.commit()}），
     * 因此持续失败时会读回失败候选。这里只返回最后一次确认成功的值，
     * 让"写盘失败"在本进程内保持为失败事实。
     */
    public static RestReminderState.Snapshot read(Context ctx) {
        synchronized (lock) {
            return view.read(() -> readStored(ctx));
        }
    }

    /** 同步写盘（真实成功门禁）。返回 false 表示未持久化成功。 */
    public static boolean commit(Context ctx, RestReminderState.Snapshot snap) {
        if (snap == null) return false;
        synchronized (lock) {
            return view.write(snap, candidate -> commitStored(ctx, candidate));
        }
    }

    /** 真正的磁盘写入（不更新已确认视图） */
    private static boolean commitStored(Context ctx, RestReminderState.Snapshot snap) {
        if (snap == null) return false;
        try {
            return prefs(ctx)
                .edit()
                .putString(KEY_TOKEN, snap.token)
                .putLong(KEY_GENERATION, snap.generation)
                .putBoolean(KEY_FIRED, snap.fired)
                .putInt(KEY_NOTIF_ID, snap.notifId)
                .putLong(KEY_LAST_INTENT, snap.lastIntentId)
                .putString(KEY_LAST_INTENT_TOKEN, snap.lastIntentToken)
                .putString(KEY_LAST_USER_CANCEL_TOKEN, snap.lastUserCancelledToken)
                .putLong(KEY_LAST_USER_CANCEL_GEN, snap.lastUserCancelledGeneration)
                .commit();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 写盘失败后的**补偿**：把已确认的身份重新写回磁盘。
     *
     * <p>补偿本身也可能持续失败 —— 此时如实返回 false，绝不伪称已恢复。
     */
    public static boolean restoreConfirmed(Context ctx) {
        synchronized (lock) {
            java.util.function.Supplier<RestReminderState.Snapshot> confirmed = view::durable;
            RestReminderState.Snapshot snap = confirmed.get();
            if (snap == null) return false;
            return view.restore(snap, candidate -> commitStored(ctx, candidate));
        }
    }

    /**
     * 原子"读-判定-写（commit）"：把真实写盘结果经 {@link RestReminderGate} 返回。
     *
     * <p>这是插件与接收器唯一允许改变状态的入口。
     */
    public static RestReminderGate.Result transition(
        Context ctx,
        java.util.function.Function<RestReminderState.Snapshot, RestReminderState.Outcome> fn
    ) {
        synchronized (lock) {
            RestReminderState.Snapshot cur = read(ctx);
            return RestReminderGate.apply(snapshot -> commit(ctx, snapshot), cur, fn);
        }
    }

    /**
     * 追加一条**有界本地诊断**事件（不影响身份状态，失败静默）。
     *
     * <p>为什么单独一个入口：诊断是旁路观测，绝不能因为写诊断失败而让
     * 真正的排程/取消/通知失败或成功被误报。
     */
    public static void diag(Context ctx, String kind, String detail) {
        if (ctx == null || kind == null) return;
        synchronized (lock) {
            try {
                // B4-R3：诊断写**独立文件**，绝不触碰身份表的整表刷盘
                SharedPreferences p = diagPrefs(ctx);
                String next = RestDiagLog.append(
                    p.getString(KEY_DIAG, null), System.currentTimeMillis(), kind, detail);
                p.edit().putString(KEY_DIAG, next).apply();
            } catch (Exception ignored) {
                // 诊断失败不影响任何投递语义
            }
        }
    }

    /** 读取当前诊断事件行（只读，供设置页/状态接口展示） */
    public static java.util.List<String> readDiag(Context ctx) {
        if (ctx == null) return java.util.Collections.emptyList();
        synchronized (lock) {
            try {
                return RestDiagLog.parse(diagPrefs(ctx).getString(KEY_DIAG, null));
            } catch (Exception e) {
                return java.util.Collections.emptyList();
            }
        }
    }

    /** 测试/诊断用：清除持久化状态 */
    public static boolean clear(Context ctx) {
        synchronized (lock) {
            try {
                boolean ok = prefs(ctx).edit().clear().commit();
                // 只有真正清盘成功才把已确认视图同步为空；失败时保持磁盘真值
                if (ok) view.forget();
                return ok;
            } catch (Exception e) {
                return false;
            }
        }
    }
}
