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

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 电子教练后台保活网络服务（dataSync ForegroundService + WakeLock + 原生 HttpURLConnection）。
 *
 * <p>为什么需要它：
 * <ul>
 *   <li>当模型回复长内容/深度思考中途用户切后台或熄屏时，Android WebView JS 层的 fetch 流会被冻结或断开；</li>
 *   <li>通过进程内静态协调器 + dataSync FGS + 有界 Partial WakeLock 在原生线程池持续读取 HTTP 分片并写入
 *       {@link CoachStreamPolicy.StreamBuffer}；</li>
 *   <li>大请求体（如带图片 base64）保存在进程内静态表，不塞进 Intent extras，避免 Android Binder 1MB {@code TransactionTooLargeException}；</li>
 *   <li>前台恢复时由 {@link CoachStreamPlugin#drainEvents} 补拉遗漏分片实现无损续传。</li>
 * </ul>
 */
public class CoachStreamService extends Service {

    static final String ACTION_START = "app.motion.personal.COACH_STREAM_START";
    static final String ACTION_STOP = "app.motion.personal.COACH_STREAM_STOP";
    static final String ACTION_STOP_NOW = "app.motion.personal.COACH_STREAM_STOP_NOW";
    private static final String WAKE_LOCK_TAG = "motion:coach-stream";

    public interface StreamEventSink {
        void onStreamEvent(CoachStreamPolicy.StreamEvent event);
    }

    public static final class StreamRequestSpec {
        public final String requestId;
        public final String url;
        public final String method;
        public final Map<String, String> headers;
        public final String body;

        public StreamRequestSpec(
            String requestId,
            String url,
            String method,
            Map<String, String> headers,
            String body
        ) {
            this.requestId = requestId;
            this.url = url;
            this.method = method;
            this.headers = headers;
            this.body = body;
        }
    }

    public static final class TextHttpResult {
        public final int status;
        public final String statusText;
        public final String body;

        public TextHttpResult(int status, String statusText, String body) {
            this.status = status;
            this.statusText = statusText;
            this.body = body;
        }
    }

    private static final CoachStreamPolicy.StreamBuffer BUFFER = new CoachStreamPolicy.StreamBuffer();
    private static final CoachStreamPolicy.ActiveRefCounter ACTIVE_REFS = new CoachStreamPolicy.ActiveRefCounter();
    private static final ConcurrentHashMap<String, RunningTask> RUNNING_TASKS = new ConcurrentHashMap<>();
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();

    private static volatile StreamEventSink eventSink;
    private static volatile CoachStreamService runningInstance;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private Runnable pendingStopRunnable;
    private int latestStartId = -1;
    private volatile boolean inForeground = false;
    private volatile boolean destroyed = false;

    private static final class RunningTask {
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile HttpURLConnection connection;
        volatile Future<?> future;
    }

    static void setEventSink(StreamEventSink sink) {
        eventSink = sink;
    }

    static CoachStreamPolicy.DrainResult drainSince(String requestId, long afterSeq) {
        return BUFFER.drainSince(requestId, afterSeq);
    }

    /** 启动一条后台保活的流式请求（进程内提交给线程池，同时按引用计数复用或拉起 dataSync FGS）。 */
    static void startStream(Context context, StreamRequestSpec spec) {
        BUFFER.register(spec.requestId);
        RunningTask task = new RunningTask();
        RUNNING_TASKS.put(spec.requestId, task);

        boolean becameActive = ACTIVE_REFS.increment(spec.requestId);
        CoachStreamService inst = runningInstance;
        if (inst != null && inst.tryKeepAliveForNewStream()) {
            // 复用仍在运行的 dataSync FGS，避免后台多轮切换触发 startForegroundService DENY
        } else if (becameActive) {
            sendServiceAction(context.getApplicationContext(), ACTION_START);
        }

        task.future = EXECUTOR.submit(() -> executeStreamTask(context.getApplicationContext(), spec, task));
    }

    static boolean abortStream(Context context, String requestId) {
        if (requestId == null || requestId.trim().isEmpty()) return false;
        RunningTask task = RUNNING_TASKS.get(requestId);
        if (task == null) {
            return false;
        }
        task.cancelled.set(true);
        HttpURLConnection conn = task.connection;
        if (conn != null) {
            EXECUTOR.execute(() -> {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            });
        }
        Future<?> future = task.future;
        if (future != null) {
            future.cancel(true);
        }
        emitErrorAndRelease(context.getApplicationContext(), requestId, "aborted", true);
        return true;
    }

    /** 非流式文本请求（用于获取模型列表、Tavily/博查/Brave 搜索），避开 WebView CORS；若已在保活会话内则延展 FGS。 */
    static TextHttpResult fetchTextSync(Context appContext, StreamRequestSpec spec) throws IOException {
        boolean heldKeepAlive = false;
        CoachStreamService inst = runningInstance;
        if (inst != null && inst.isForegroundAlive()) {
            ACTIVE_REFS.increment(spec.requestId);
            inst.tryKeepAliveForNewStream();
            heldKeepAlive = true;
        }
        HttpURLConnection conn = null;
        try {
            conn = openConnection(spec, 20_000, 45_000);
            int status = conn.getResponseCode();
            String statusText = conn.getResponseMessage();
            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            StringBuilder sb = new StringBuilder();
            if (stream != null) {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                    char[] buf = new char[4096];
                    int n;
                    while ((n = reader.read(buf, 0, buf.length)) != -1) {
                        sb.append(buf, 0, n);
                        if (sb.length() > CoachStreamPolicy.MAX_BUFFER_BYTES) {
                            break;
                        }
                    }
                }
            }
            return new TextHttpResult(status, statusText == null ? "" : statusText, sb.toString());
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
            if (heldKeepAlive && ACTIVE_REFS.decrement(spec.requestId)) {
                sendServiceAction(appContext, ACTION_STOP);
            }
        }
    }

    private static HttpURLConnection openConnection(
        StreamRequestSpec spec,
        int connectTimeoutMs,
        int readTimeoutMs
    ) throws IOException {
        String method = CoachStreamPolicy.normalizeMethod(spec.method);
        if (!CoachStreamPolicy.isValidUrl(spec.url) || method == null) {
            throw new IOException("非法请求地址或方法");
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(spec.url).openConnection();
        conn.setConnectTimeout(connectTimeoutMs);
        conn.setReadTimeout(readTimeoutMs);
        conn.setUseCaches(false);
        conn.setDoInput(true);
        conn.setRequestMethod(method);
        conn.setRequestProperty("Accept-Encoding", "identity");

        if (spec.headers != null) {
            for (Map.Entry<String, String> entry : spec.headers.entrySet()) {
                String[] clean = CoachStreamPolicy.sanitizeHeader(entry.getKey(), entry.getValue());
                if (clean != null) {
                    conn.setRequestProperty(clean[0], clean[1]);
                }
            }
        }

        if (spec.body != null && ("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method))) {
            conn.setDoOutput(true);
            byte[] bytes = spec.body.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
                os.flush();
            }
        }
        return conn;
    }

    private static void executeStreamTask(Context appContext, StreamRequestSpec spec, RunningTask task) {
        HttpURLConnection conn = null;
        try {
            if (task.cancelled.get()) {
                emitErrorAndRelease(appContext, spec.requestId, "aborted");
                return;
            }
            conn = openConnection(spec, 20_000, 120_000);
            task.connection = conn;
            if (task.cancelled.get()) {
                emitErrorAndRelease(appContext, spec.requestId, "aborted");
                return;
            }

            int status = conn.getResponseCode();
            String statusText = conn.getResponseMessage();
            notifySink(BUFFER.appendStatus(spec.requestId, status, statusText));

            InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (stream != null) {
                try (InputStreamReader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
                    char[] buf = new char[2048];
                    int n;
                    while (!task.cancelled.get() && (n = reader.read(buf, 0, buf.length)) != -1) {
                        if (n > 0) {
                            notifySink(BUFFER.appendChunk(spec.requestId, new String(buf, 0, n)));
                        }
                    }
                }
            }

            if (task.cancelled.get()) {
                emitErrorAndRelease(appContext, spec.requestId, "aborted");
            } else {
                emitDoneAndRelease(appContext, spec.requestId);
            }
        } catch (Exception e) {
            String msg = task.cancelled.get() ? "aborted" : (e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
            emitErrorAndRelease(appContext, spec.requestId, msg);
        } finally {
            RUNNING_TASKS.remove(spec.requestId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static void emitDoneAndRelease(Context appContext, String requestId) {
        CoachStreamPolicy.StreamEvent done = BUFFER.appendDone(requestId);
        if (done != null) notifySink(done);
        if (ACTIVE_REFS.decrement(requestId)) {
            sendServiceAction(appContext, ACTION_STOP);
        }
    }

    private static void emitErrorAndRelease(Context appContext, String requestId, String error) {
        emitErrorAndRelease(appContext, requestId, error, false);
    }

    private static void emitErrorAndRelease(Context appContext, String requestId, String error, boolean immediate) {
        CoachStreamPolicy.StreamEvent err = BUFFER.appendError(requestId, error);
        if (err != null) notifySink(err);
        if (ACTIVE_REFS.decrement(requestId)) {
            sendServiceAction(appContext, immediate ? ACTION_STOP_NOW : ACTION_STOP);
        }
    }

    private static void notifySink(CoachStreamPolicy.StreamEvent ev) {
        if (ev == null) return;
        StreamEventSink sink = eventSink;
        if (sink != null) {
            try {
                sink.onStreamEvent(ev);
            } catch (Exception ignored) {
            }
        }
    }

    private static void sendServiceAction(Context appContext, String action) {
        try {
            Intent intent = new Intent(appContext, CoachStreamService.class);
            intent.setAction(action);
            if (ACTION_START.equals(action)) {
                ContextCompat.startForegroundService(appContext, intent);
            } else if (runningInstance != null) {
                appContext.startService(intent);
            }
        } catch (Exception ignored) {
            // 若系统暂时限制后台拉起前台服务，不阻断线程池内的直接 HTTP 请求
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        runningInstance = this;
        ensureChannel();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP_NOW.equals(action)) {
            if (ACTIVE_REFS.count() == 0) {
                stopForegroundAndSelf(startId, false);
            }
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            if (ACTIVE_REFS.count() == 0) {
                if (inForeground) {
                    scheduleGracefulStop(startId);
                } else {
                    stopSelf(startId);
                }
            }
            return START_NOT_STICKY;
        }

        // 先按 Android 12+ 规则立即 promote 到前台，防止任务极快结束导致 ForegroundServiceDidNotStartInTimeException
        cancelPendingStop();
        promoteForeground();
        acquireWakeLock();
        if (ACTIVE_REFS.count() == 0) {
            scheduleGracefulStop(startId);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15+ dataSync 前台服务时长触限安全收尾
        List<String> lingering = ACTIVE_REFS.snapshotIds();
        for (String id : lingering) {
            RunningTask task = RUNNING_TASKS.get(id);
            if (task != null) task.cancelled.set(true);
            emitErrorAndRelease(getApplicationContext(), id, "service-timeout", true);
        }
        stopForegroundAndSelf(startId, true);
    }

    @Override
    public void onDestroy() {
        synchronized (this) {
            destroyed = true;
            cancelPendingStop();
            releaseWakeLock();
            inForeground = false;
        }
        if (runningInstance == this) {
            runningInstance = null;
        }
        super.onDestroy();
    }

    synchronized boolean isForegroundAlive() {
        return inForeground && !destroyed;
    }

    synchronized boolean tryKeepAliveForNewStream() {
        if (!inForeground || destroyed) return false;
        cancelPendingStop();
        acquireWakeLock();
        return true;
    }

    private synchronized void cancelPendingStop() {
        if (pendingStopRunnable != null) {
            mainHandler.removeCallbacks(pendingStopRunnable);
            pendingStopRunnable = null;
        }
    }

    private synchronized void scheduleGracefulStop(int startId) {
        cancelPendingStop();
        latestStartId = startId;
        pendingStopRunnable = () -> {
            if (ACTIVE_REFS.count() == 0) {
                stopForegroundAndSelf(latestStartId, false);
            }
        };
        mainHandler.postDelayed(pendingStopRunnable, CoachStreamPolicy.STOP_GRACE_MS);
    }

    private void promoteForeground() {
        try {
            Notification n = buildNotification();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    CoachStreamPolicy.NOTIFICATION_ID,
                    n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(CoachStreamPolicy.NOTIFICATION_ID, n);
            }
            inForeground = true;
        } catch (Exception ignored) {
            inForeground = false;
        }
    }

    private synchronized void stopForegroundAndSelf(int startId, boolean force) {
        if (!force && ACTIVE_REFS.count() > 0) {
            return;
        }
        cancelPendingStop();
        releaseWakeLock();
        try {
            if (inForeground) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                } else {
                    stopForeground(true);
                }
                inForeground = false;
            }
        } catch (Exception ignored) {
        }
        stopSelf(startId);
    }

    private synchronized void acquireWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(CoachStreamPolicy.WAKE_LOCK_TIMEOUT_MS);
        } catch (Exception ignored) {
        }
    }

    private synchronized void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {
        } finally {
            wakeLock = null;
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel existing = nm.getNotificationChannel(CoachStreamPolicy.CHANNEL_ID);
        if (existing != null) return;
        NotificationChannel ch = new NotificationChannel(
            CoachStreamPolicy.CHANNEL_ID,
            "电子教练后台回复接收",
            NotificationManager.IMPORTANCE_LOW
        );
        ch.setDescription("切后台或锁屏时保持模型回复持续接收");
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private Notification buildNotification() {
        ensureChannel();
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) {
            launch = new Intent(this, app.motion.personal.MainActivity.class);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentPi = PendingIntent.getActivity(
            this,
            CoachStreamPolicy.CONTENT_REQUEST_CODE,
            launch,
            flags
        );
        return new NotificationCompat.Builder(this, CoachStreamPolicy.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("MOTION 电子教练")
            .setContentText("后台持续接收回复中，切回即可查看")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(contentPi)
            .build();
    }
}
