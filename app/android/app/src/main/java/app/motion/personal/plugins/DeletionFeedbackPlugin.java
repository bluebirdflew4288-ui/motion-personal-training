package app.motion.personal.plugins;

import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.SoundPool;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import app.motion.personal.R;

/**
 * F11：删除成功短音与 F09 准备触感的**最小前台交互插件**。
 *
 * <h2>边界（刻意做小）</h2>
 * <ul>
 *   <li>不碰 {@code RestReminderPlugin} / AlarmManager / 前台服务 / 通知渠道 /
 *       token-generation / 休息计时 owner —— 本插件只在页面可见时响一声或震一下；</li>
 *   <li>不申请任何权限：读铃声模式/勿扰过滤档/音量都是普通查询，VIBRATE 已因
 *       休息提醒存在于清单里；</li>
 *   <li>不改系统音量、不改勿扰、不建/改通知渠道；</li>
 *   <li>不借 {@code USAGE_ALARM} 或通知流发声：音效用
 *       {@link AudioAttributes#USAGE_ASSISTANCE_SONIFICATION}（系统提示音流）。</li>
 * </ul>
 *
 * <h2>安静时不冒充</h2>
 * 播放前用**真实** {@link AudioManager#getRingerMode()}、
 * {@link NotificationManager#getCurrentInterruptionFilter()}、
 * {@code getStreamVolume(STREAM_SYSTEM)} 与 Activity resumed 状态判定
 * （判定本身在纯 JVM 的 {@link DeleteFeedbackPolicy} 里，可离线测试）。
 * 静音/振动/勿扰/查询异常/后台/音效未加载完成 → 直接返回
 * {@code played:false} 与稳定原因，**绝不**先响再解释。
 *
 * <h2>异步与失效</h2>
 * SoundPool 的 load 与真正的 play 之间存在时间窗。每次意图带一个自增序号：
 * <ul>
 *   <li>load 完成后**重新**读一次系统状态再判定（期间换成静音/勿扰照样不播）；</li>
 *   <li>{@link #stop()} 递增序号并停止正在播放的流，因此在途意图一律作废；</li>
 *   <li>序号不匹配的迟到回调 resolve 成 {@code intent-stale}，不会补放。</li>
 * </ul>
 * JS 侧另有页面归属/可见性门禁；两层都通过才可能出声。
 *
 * <h2>F11-FIX1：清理只作用于自己的 owner</h2>
 * 每次 play/stop 都可带一个不透明的 {@code owner}（JS 侧为本次播放生成的归属凭证）：
 * <ul>
 *   <li>不带 owner 的 {@code stop()} = 页面级收手，行为与以前完全一致
 *       （推进序号、作废在途意图、停掉当前流）；</li>
 *   <li>带 owner 的 {@code stop({owner})} 只作废/停止**属于这个 owner** 的
 *       在途意图与流，并且**刻意不推进序号** —— 迟到的旧清理因此不可能让
 *       新页面的新意图失效（旧 stop 排在新的 play 之后也不会掐掉新声音）；</li>
 *   <li>归属之间互不影响：原生只有一条播放流，旧 owner 的清理绝不能停别人的流。</li>
 * </ul>
 *
 * <p><b>能力边界（不夸大）</b>：本插件能证明"策略判定放行并调用了系统播放 API"，
 * 不能证明用户真的听到了；真机声音、静音/勿扰下的实际听感仍需单独验收。
 */
@CapacitorPlugin(name = "DeletionFeedback")
public class DeletionFeedbackPlugin extends Plugin {

    /** 与 res/raw 下的文件名一致（生成脚本：app/scripts/gen-delete-sound.mjs） */
    private static final int SOUND_RES = R.raw.delete_success;

    /** 每次意图的序号；stop()/新意图都会推进它，用来作废在途回调 */
    private final AtomicInteger intentSeq = new AtomicInteger(0);

    private SoundPool pool;
    private int soundId = 0;
    private boolean soundLoaded = false;
    private boolean loadRequested = false;
    private int playingStreamId = 0;

    /** 正在等待加载完成的那一次意图 */
    private int pendingSeq = -1;
    private PluginCall pendingCall;
    /** 在途（等待加载）那一次意图的 owner（F11-FIX1，null = 未带归属） */
    private String pendingOwner = null;
    /** 当前正在播放的那条流属于谁（F11-FIX1，null = 未带归属） */
    private String playingOwner = null;
    /**
     * 已被"只作废自己"的 stop 标记的 owner。
     *
     * <p>覆盖 play 已进队、startPlay 还没在主线程跑起来的那段窗口：进入 startPlay
     * 时立即消费（{@link #takeCancelled}），因此集合不会随播放次数增长。
     */
    private final Set<String> cancelledOwners =
        Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    /**
     * 是否处于前台（可见）。
     *
     * <p>与 {@code RestReminderPlugin} 同一套生命周期约定：插件 load 发生在首次
     * onResume **之前**，所以默认必须是 false，由 handleOnResume 置 true；
     * 不在 load() 里凭"Activity 存在"猜 true。
     */
    private volatile boolean activityResumed = false;

    @Override
    public void load() {
        // 不在这里建 SoundPool / 不预热音频：音频只在用户真正删除成功后按需加载。
    }

    @Override
    protected void handleOnResume() {
        activityResumed = true;
        super.handleOnResume();
    }

    @Override
    protected void handleOnPause() {
        activityResumed = false;
        /**
         * 后台即收手：停掉正在播放的那一声，并让在途意图作废。
         *
         * <p>不这样做的话，加载/判定排队期间用户切走，声音仍可能在后台响出来；
         * 恢复前台也不补放（成功音只属于它自己那次可见的删除）。
         */
        stopPlayback();
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
        stopPlayback();
        releasePool();
        super.handleOnDestroy();
    }

    /* ── 成功音 ─────────────────────────────────────────────── */

    /**
     * 播放一次删除成功音。
     *
     * <p>JS 只在**真实删除事务 saved 之后**调用，且每个意图至多一次；
     * 本方法仍然自己做完整判定 —— 页面可能在提交期间被切走或静音。
     */
    @PluginMethod
    public void play(PluginCall call) {
        final String owner = readOwner(call);
        if (getBridge() == null) {
            resolveSkip(call, "no-bridge");
            return;
        }
        // 播放、停止、加载回调的全部可变状态归主线程所有。
        // 若 stop 在 HandlerThread 先回报成功、而主线程仍在判定旧 play，
        // 就会出现“已停止之后才开始播放”。同一队列内完成操作后才 resolve。
        getBridge().executeOnMainThread(() -> {
            final int seq = intentSeq.incrementAndGet();
            if (owner != null) cancelledOwners.remove(owner);
            startPlay(seq, owner, call);
        });
    }

    /** 主线程：读真实系统状态 → 判定 → 必要时先加载 → 播放 */
    private void startPlay(int seq, String owner, PluginCall call) {
        if (seq != intentSeq.get()) {
            resolveSkip(call, DeleteFeedbackPolicy.SKIP_INTENT_STALE);
            return;
        }
        // 只属于自己的旧清理要求作废这一次播放（不推进序号，绝不影响其它 owner）
        if (takeCancelled(owner)) {
            resolveSkip(call, DeleteFeedbackPolicy.SKIP_INTENT_STALE);
            return;
        }
        AudioManager am = audioManager();
        if (am == null) {
            resolveSkip(call, DeleteFeedbackPolicy.SKIP_NO_AUDIO_SERVICE);
            return;
        }
        Integer ringer = readRingerMode(am);
        Integer filter = readInterruptionFilter();
        Integer volume = readSystemStreamVolume(am);
        boolean resumed = isActivityVisible();
        DeleteFeedbackPolicy.Decision d =
            DeleteFeedbackPolicy.decideSound(ringer, filter, resumed, volume, soundLoaded);
        if (!d.allow) {
            if (DeleteFeedbackPolicy.SKIP_SOUND_NOT_READY.equals(d.reason)) {
                // 其余条件此刻都已满足，只差音效没加载完：启动加载，完成后再判定一次。
                ensureLoad(seq, owner, call);
                return;
            }
            resolveSkip(call, d.reason, ringer, filter, volume, resumed);
            return;
        }
        int stream = 0;
        try {
            // 只保留一条活动成功音，停止/退后台时不会漏掉前一次短音。
            if (playingStreamId != 0) pool.stop(playingStreamId);
            playingStreamId = 0;
            playingOwner = null;
            stream = pool.play(soundId, 1f, 1f, 1, 0, 1f);
        } catch (Exception e) {
            stream = 0;
        }
        if (stream == 0) {
            resolveSkip(call, "play-failed", ringer, filter, volume, resumed);
            return;
        }
        playingStreamId = stream;
        playingOwner = owner;
        JSObject ret = baseReport(ringer, filter, volume, resumed);
        ret.put("played", true);
        ret.put("reason", d.reason);
        call.resolve(ret);
    }

    /**
     * 作废在途意图并停止正在播放的流（关闭开关 / 离页 / 隐藏 / 失锁 / 切 session）。
     *
     * <p>两种语义（F11-FIX1）：
     * <ul>
     *   <li><b>不带 owner</b>：页面级收手 —— 推进序号，任何迟到的 load 完成回调都会被
     *       判成 stale，不会补放；</li>
     *   <li><b>带 owner</b>：只作废/停止属于这个 owner 的那一次，**不推进序号** ——
     *       旧页面迟到的旧清理因此不会让新页面的新意图失效。</li>
     * </ul>
     */
    @PluginMethod
    public void stop(PluginCall call) {
        final String owner = readOwner(call);
        if (getBridge() == null) {
            JSObject ret = new JSObject();
            ret.put("stopped", false);
            ret.put("reason", "no-bridge");
            call.resolve(ret);
            return;
        }
        getBridge().executeOnMainThread(() -> {
            if (owner == null) {
                stopPlayback();
            } else {
                stopOwnedPlayback(owner);
            }
            JSObject ret = new JSObject();
            ret.put("stopped", true);
            if (owner != null) ret.put("owner", owner);
            call.resolve(ret);
        });
    }

    /**
     * 停掉当前播放并作废在途意图（关闭开关 / 离页 / 失锁 / 切 session / 退到后台 / 销毁）。
     *
     * <p>序号推进后，任何迟到的 load 完成回调都会被判成 stale，不会补放；
     * 等待中的 JS 调用也会被如实 resolve 成 {@code intent-stale}（不留悬挂 Promise）。
     */
    private void stopPlayback() {
        intentSeq.incrementAndGet();
        PluginCall pending = takePending();
        if (pending != null) resolveSkip(pending, DeleteFeedbackPolicy.SKIP_INTENT_STALE);
        if (pool != null && playingStreamId != 0) {
            try {
                pool.stop(playingStreamId);
            } catch (Exception ignored) {
                // 停止失败不影响"已作废"的结论
            }
        }
        playingStreamId = 0;
        playingOwner = null;
        cancelledOwners.clear();
    }

    /**
     * 只作废/停止**属于该 owner** 的在途意图与播放流（F11-FIX1）。
     *
     * <p>刻意**不**推进 {@link #intentSeq}：旧 owner 的迟到清理绝不能把新 owner
     * 刚发出的意图判成 stale（那正是"新页面没声音"的成因）。别人的流也不许停。
     */
    private void stopOwnedPlayback(String owner) {
        if (owner == null) return;
        boolean handled = false;
        if (owner.equals(pendingOwner)) {
            PluginCall pending = takePending();
            if (pending != null) {
                handled = true;
                resolveSkip(pending, DeleteFeedbackPolicy.SKIP_INTENT_STALE);
            }
        }
        if (playingStreamId != 0 && owner.equals(playingOwner)) {
            try {
                pool.stop(playingStreamId);
            } catch (Exception ignored) {
                // 停止失败不影响"已作废"的结论
            }
            playingStreamId = 0;
            playingOwner = null;
            handled = true;
        }
        // 只有"play 已进队、startPlay 还没跑"这种没被就地处理的情况才需要留下取消标记；
        // 标记在 startPlay 入口消费，因此本集合不会随播放次数增长。
        if (!handled) cancelledOwners.add(owner);
    }

    /**
     * 读取本次调用的归属凭证；没有/空串都当作"未带 owner"（页面级语义）。
     *
     * <p>读不到 options 也不抛：非法调用降级为页面级行为，绝不因此崩溃。
     */
    private String readOwner(PluginCall call) {
        try {
            String owner = call == null ? null : call.getString("owner");
            return owner == null || owner.isEmpty() ? null : owner;
        } catch (Exception e) {
            return null;
        }
    }

    /** 消费"只作废自己"的取消标记（同一 owner 只看一次） */
    private boolean takeCancelled(String owner) {
        return owner != null && cancelledOwners.remove(owner);
    }

    /* ── F09 准备触感（native/web 互斥的单一通道）──────────────── */

    /**
     * 一次准备手势的轻震（至多一次由 JS 侧手势状态保证）。
     *
     * <p>不用通知渠道、不用闹钟流、不改系统设置；静音/勿扰/后台/无马达时不震，
     * 页面上的"松开手指可删除"文字提示照样保留。
     */
    @PluginMethod
    public void prepareHaptic(PluginCall call) {
        if (getBridge() == null) {
            resolveHaptic(call, false, "no-bridge");
            return;
        }
        getBridge().executeOnMainThread(() -> {
            Vibrator vibrator = vibrator();
            boolean has = vibrator != null && vibrator.hasVibrator();
            AudioManager am = audioManager();
            DeleteFeedbackPolicy.Decision d = DeleteFeedbackPolicy.decideHaptic(
                am == null ? null : readRingerMode(am),
                readInterruptionFilter(),
                isActivityVisible(),
                has);
            if (!d.allow || vibrator == null) {
                resolveHaptic(call, false, d.reason);
                return;
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createOneShot(
                        DeleteFeedbackPolicy.PREPARE_VIBRATE_MS,
                        VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    vibrator.vibrate(DeleteFeedbackPolicy.PREPARE_VIBRATE_MS);
                }
                resolveHaptic(call, true, d.reason);
            } catch (Exception e) {
                // 某些机型/权限下震动会抛异常：如实返回，不假装震过
                resolveHaptic(call, false, "haptic-error");
            }
        });
    }

    /* ── 只读诊断（不产生任何副作用）────────────────────────── */

    /**
     * 读取当前真实策略状态（设置页/审查用）。
     *
     * <p>只查询、不播放、不改设置；返回的 {@code wouldPlay} 说明"如果此刻有一次
     * 成功删除，会不会出声"，可用于人工核验静音/勿扰下的行为。
     */
    @PluginMethod
    public void getPolicy(PluginCall call) {
        if (getBridge() == null) {
            JSObject ret = new JSObject();
            ret.put("reason", "no-bridge");
            call.resolve(ret);
            return;
        }
        getBridge().executeOnMainThread(() -> {
            AudioManager am = audioManager();
            JSObject ret = new JSObject();
            if (am == null) {
                ret.put("reason", DeleteFeedbackPolicy.SKIP_NO_AUDIO_SERVICE);
                call.resolve(ret);
                return;
            }
            Integer ringer = readRingerMode(am);
            Integer filter = readInterruptionFilter();
            Integer volume = readSystemStreamVolume(am);
            boolean resumed = isActivityVisible();
            DeleteFeedbackPolicy.Decision d =
                DeleteFeedbackPolicy.decideSound(ringer, filter, resumed, volume, true);
            ret = baseReport(ringer, filter, volume, resumed);
            ret.put("wouldPlay", d.allow);
            ret.put("reason", d.reason);
            ret.put("soundLoaded", soundLoaded);
            ret.put("sdkInt", Build.VERSION.SDK_INT);
            call.resolve(ret);
        });
    }

    /* ── 内部：系统状态读取 ─────────────────────────────────── */

    private AudioManager audioManager() {
        try {
            return (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        } catch (Exception e) {
            return null;
        }
    }

    /** AudioManager.getRingerMode()；异常返回 null（保守：按未知处理，不播） */
    private Integer readRingerMode(AudioManager am) {
        try {
            return am.getRingerMode();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * NotificationManager.getCurrentInterruptionFilter()（勿扰过滤档）。
     *
     * <p>拿不到或不认识的值都返回 null，交给策略类按"未知 → 不播"处理。
     */
    private Integer readInterruptionFilter() {
        try {
            NotificationManager nm =
                (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return null;
            return nm.getCurrentInterruptionFilter();
        } catch (Exception e) {
            return null;
        }
    }

    /** 系统提示音流（USAGE_ASSISTANCE_SONIFICATION → STREAM_SYSTEM）的当前音量 */
    private Integer readSystemStreamVolume(AudioManager am) {
        try {
            return am.getStreamVolume(AudioManager.STREAM_SYSTEM);
        } catch (Exception e) {
            return null;
        }
    }

    private Vibrator vibrator() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager manager =
                    (VibratorManager) getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                return manager == null ? null : manager.getDefaultVibrator();
            }
            return (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        } catch (Exception e) {
            return null;
        }
    }

    /** 前台可见判定：resumed + Activity 仍在且未 finishing/destroyed */
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

    /* ── 内部：SoundPool 生命周期 ───────────────────────────── */

    private void ensurePool() {
        if (pool != null) return;
        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        pool = new SoundPool.Builder().setMaxStreams(2).setAudioAttributes(attrs).build();
        pool.setOnLoadCompleteListener((soundPool, sampleId, status) -> {
            if (getBridge() == null) return;
            getBridge().executeOnMainThread(() -> {
                // 包括读取/清空 pending 在内都必须与 stop/play 串行。
                // 销毁后的旧 SoundPool 回调不能修改新实例的加载状态。
                if (pool != soundPool || sampleId != soundId) return;
                boolean ok = status == 0;
                soundLoaded = ok;
                loadRequested = false;
                final int seq = pendingSeq;
                final String owner = pendingOwner;
                final PluginCall pending = takePending();
                if (pending == null) return;
                if (seq != intentSeq.get()) {
                    // 加载期间被作废（关闭开关/离页/新意图）：不补放，如实回报
                    resolveSkip(pending, DeleteFeedbackPolicy.SKIP_INTENT_STALE);
                    return;
                }
                if (!ok) {
                    resolveSkip(pending, "load-failed");
                    return;
                }
                // 重新读一次系统状态再播：加载窗口里可能已经切到静音/勿扰/后台
                startPlay(seq, owner, pending);
            });
        });
    }

    /** 请求加载音效；同一时刻只保留一次在途意图 */
    private void ensureLoad(int seq, String owner, PluginCall call) {
        ensurePool();
        if (loadRequested) {
            // 已有加载在途：替换等待者（旧等待者如实作废，不能悬挂）
            PluginCall previous = pendingCall;
            pendingCall = call;
            pendingSeq = seq;
            pendingOwner = owner;
            if (previous != null) resolveSkip(previous, "superseded");
            return;
        }
        loadRequested = true;
        pendingCall = call;
        pendingSeq = seq;
        pendingOwner = owner;
        soundId = pool.load(getContext(), SOUND_RES, 1);
        if (soundId == 0) {
            // load 返回 0 = 立刻失败，不会有回调
            PluginCall pending = takePending();
            loadRequested = false;
            if (pending != null) resolveSkip(pending, "load-failed");
        }
    }

    private PluginCall takePending() {
        PluginCall call = pendingCall;
        pendingCall = null;
        pendingSeq = -1;
        pendingOwner = null;
        return call;
    }

    private void releasePool() {
        if (pool == null) return;
        try {
            pool.release();
        } catch (Exception ignored) {
            // 释放失败不影响进程退出
        }
        pool = null;
        soundId = 0;
        soundLoaded = false;
        loadRequested = false;
        playingStreamId = 0;
        playingOwner = null;
        pendingOwner = null;
        cancelledOwners.clear();
    }

    /* ── 内部：回复构造 ─────────────────────────────────────── */

    private JSObject baseReport(Integer ringer, Integer filter, Integer volume, boolean resumed) {
        JSObject ret = new JSObject();
        // 只回报状态码，不含任何训练内容/用户数据
        ret.put("ringerMode", ringer == null ? -1 : ringer);
        ret.put("interruptionFilter", filter == null ? -1 : filter);
        ret.put("systemStreamVolume", volume == null ? -1 : volume);
        ret.put("activityResumed", resumed);
        ret.put("channel", "native");
        return ret;
    }

    private void resolveSkip(PluginCall call, String reason) {
        resolveSkip(call, reason, null, null, null, isActivityVisible());
    }

    private void resolveSkip(
        PluginCall call, String reason, Integer ringer, Integer filter, Integer volume, boolean resumed) {
        JSObject ret = baseReport(ringer, filter, volume, resumed);
        ret.put("played", false);
        ret.put("reason", reason);
        call.resolve(ret);
    }

    private void resolveHaptic(PluginCall call, boolean vibrated, String reason) {
        JSObject ret = new JSObject();
        ret.put("vibrated", vibrated);
        ret.put("reason", reason);
        ret.put("channel", "native");
        call.resolve(ret);
    }
}
