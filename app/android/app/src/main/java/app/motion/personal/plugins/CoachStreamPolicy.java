package app.motion.personal.plugins;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 电子教练后台流式网络策略与内存分片缓冲区（纯 JVM，无 android.* 依赖，可脱离设备跑单元回归）。
 *
 * <p>核心职责：
 * <ul>
 *   <li>校验 URL 仅允许 http/https、非空 HTTP 方法及无 CRLF 注入的请求头；</li>
 *   <li>按 {@code requestId} 维护单调递增 {@code seq} 的分片队列，支持 WebView 切回前台按 {@code afterSeq} 增量补拉；</li>
 *   <li>强制 {@value #MAX_BUFFER_BYTES} 上限与最多 {@value #MAX_STREAM_HISTORY} 条近期流记录淘汰，防止大长文撑爆内存；</li>
 *   <li>用引用计数严格界定多路并发流下 {@code dataSync} 前台服务与 WakeLock 的启停时机。</li>
 * </ul>
 */
public final class CoachStreamPolicy {

    /** 通知与请求码区间刻意避开 RestCountdownService / RestForegroundPolicy（1..100000 及 1000000+） */
    public static final int NOTIFICATION_ID = 2_000_001;
    public static final int CONTENT_REQUEST_CODE = 8400;
    public static final String CHANNEL_ID = "motion-coach-stream";

    /** android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC */
    public static final int TYPE_DATA_SYNC = 0x00000001;

    /** 单条/多条流共享的总分片字符缓冲上限（按 UTF-16 2 字节折算，约 4MB） */
    public static final int MAX_BUFFER_BYTES = 4 * 1024 * 1024;
    /** 近期完成流保留上限，超过后淘汰最老的已完成流 */
    public static final int MAX_STREAM_HISTORY = 32;
    /** 单次持有 WakeLock 的硬上限（10 分钟） */
    public static final long WAKE_LOCK_TIMEOUT_MS = 10L * 60L * 1000L;
    /** 流结束后短暂保留 dataSync 前台服务（12 秒），确保后台多轮工具调用 / 联网搜索 / 自动标题续接不触发 Android 12+ 后台拉起限制 */
    public static final long STOP_GRACE_MS = 12_000L;

    private CoachStreamPolicy() {}

    public static boolean isValidUrl(String url) {
        if (url == null) return false;
        String trimmed = url.trim();
        if (trimmed.isEmpty()) return false;
        String lower = trimmed.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("https://") && !lower.startsWith("http://")) {
            return false;
        }
        if (trimmed.indexOf('\r') >= 0 || trimmed.indexOf('\n') >= 0) {
            return false;
        }
        return lower.length() > "https://".length();
    }

    public static String normalizeMethod(String method) {
        if (method == null) return "GET";
        String clean = method.trim().toUpperCase(Locale.ROOT);
        if (clean.isEmpty()) return "GET";
        if ("GET".equals(clean)
            || "POST".equals(clean)
            || "PUT".equals(clean)
            || "PATCH".equals(clean)
            || "DELETE".equals(clean)
            || "HEAD".equals(clean)) {
            return clean;
        }
        return null;
    }

    public static boolean validateRequest(String url, String method) {
        return isValidUrl(url) && normalizeMethod(method) != null;
    }

    public static String[] sanitizeHeader(String key, String value) {
        if (key == null || value == null) return null;
        String k = key.trim();
        if (k.isEmpty()) return null;
        if (k.indexOf('\r') >= 0 || k.indexOf('\n') >= 0 || k.indexOf(':') >= 0) {
            return null;
        }
        if (value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
            return null;
        }
        return new String[] { k, value };
    }

    public static final class StreamEvent {
        public final String requestId;
        public final long seq;
        public final String type;
        public final int status;
        public final String statusText;
        public final String chunk;
        public final String error;

        private StreamEvent(
            String requestId,
            long seq,
            String type,
            int status,
            String statusText,
            String chunk,
            String error
        ) {
            this.requestId = requestId;
            this.seq = seq;
            this.type = type;
            this.status = status;
            this.statusText = statusText;
            this.chunk = chunk;
            this.error = error;
        }

        public static StreamEvent statusEvent(String requestId, long seq, int status, String statusText) {
            return new StreamEvent(requestId, seq, "status", status, statusText == null ? "" : statusText, null, null);
        }

        public static StreamEvent chunkEvent(String requestId, long seq, String chunk) {
            return new StreamEvent(requestId, seq, "chunk", 0, null, chunk == null ? "" : chunk, null);
        }

        public static StreamEvent doneEvent(String requestId, long seq) {
            return new StreamEvent(requestId, seq, "done", 0, null, null, null);
        }

        public static StreamEvent errorEvent(String requestId, long seq, String error) {
            return new StreamEvent(requestId, seq, "error", 0, null, null, error == null ? "stream-error" : error);
        }

        int approxBytes() {
            int chars = 24;
            if (chunk != null) chars += chunk.length();
            if (error != null) chars += error.length();
            if (statusText != null) chars += statusText.length();
            return chars * 2;
        }
    }

    public static final class DrainResult {
        public final List<StreamEvent> events;
        public final boolean finished;

        public DrainResult(List<StreamEvent> events, boolean finished) {
            this.events = events;
            this.finished = finished;
        }
    }

    private static final class StreamEntry {
        final List<StreamEvent> events = new ArrayList<>();
        long nextSeq = 1L;
        long lastDrainedSeq = 0L;
        boolean finished = false;
    }

    /** 线程安全的后台流式事件缓冲，支持断点按 seq 补拉与总字节上限淘汰。 */
    public static final class StreamBuffer {
        private final int maxBufferBytes;
        private final int maxStreams;
        private final Map<String, StreamEntry> streams = new LinkedHashMap<>();
        private int totalBytes = 0;

        public StreamBuffer() {
            this(MAX_BUFFER_BYTES, MAX_STREAM_HISTORY);
        }

        public StreamBuffer(int maxBufferBytes, int maxStreams) {
            this.maxBufferBytes = Math.max(4096, maxBufferBytes);
            this.maxStreams = Math.max(2, maxStreams);
        }

        public synchronized void register(String requestId) {
            if (requestId == null || requestId.trim().isEmpty()) return;
            StreamEntry prev = streams.remove(requestId);
            if (prev != null) {
                for (StreamEvent ev : prev.events) totalBytes -= ev.approxBytes();
            }
            streams.put(requestId, new StreamEntry());
            pruneOldFinishedStreams();
        }

        public synchronized StreamEvent appendStatus(String requestId, int status, String statusText) {
            StreamEntry entry = ensureEntry(requestId);
            StreamEvent ev = StreamEvent.statusEvent(requestId, entry.nextSeq++, status, statusText);
            addEvent(entry, ev);
            return ev;
        }

        public synchronized StreamEvent appendChunk(String requestId, String chunk) {
            StreamEntry entry = ensureEntry(requestId);
            if (chunk == null || chunk.isEmpty()) return null;
            StreamEvent ev = StreamEvent.chunkEvent(requestId, entry.nextSeq++, chunk);
            addEvent(entry, ev);
            return ev;
        }

        public synchronized StreamEvent appendDone(String requestId) {
            StreamEntry entry = ensureEntry(requestId);
            if (entry.finished) return null;
            entry.finished = true;
            StreamEvent ev = StreamEvent.doneEvent(requestId, entry.nextSeq++);
            addEvent(entry, ev);
            return ev;
        }

        public synchronized StreamEvent appendError(String requestId, String error) {
            StreamEntry entry = ensureEntry(requestId);
            if (entry.finished) return null;
            entry.finished = true;
            StreamEvent ev = StreamEvent.errorEvent(requestId, entry.nextSeq++, error);
            addEvent(entry, ev);
            return ev;
        }

        public synchronized DrainResult drainSince(String requestId, long afterSeq) {
            StreamEntry entry = streams.get(requestId);
            if (entry == null) {
                return new DrainResult(new ArrayList<>(), true);
            }
            List<StreamEvent> out = new ArrayList<>();
            long highest = entry.lastDrainedSeq;
            for (StreamEvent ev : entry.events) {
                if (ev.seq > afterSeq) {
                    out.add(ev);
                    if (ev.seq > highest) highest = ev.seq;
                }
            }
            entry.lastDrainedSeq = highest;
            return new DrainResult(out, entry.finished);
        }

        public synchronized boolean isFinished(String requestId) {
            StreamEntry entry = streams.get(requestId);
            return entry == null || entry.finished;
        }

        public synchronized int totalBytes() {
            return Math.max(0, totalBytes);
        }

        public synchronized int streamCount() {
            return streams.size();
        }

        private StreamEntry ensureEntry(String requestId) {
            StreamEntry entry = streams.get(requestId);
            if (entry == null) {
                entry = new StreamEntry();
                streams.put(requestId, entry);
                pruneOldFinishedStreams();
            }
            return entry;
        }

        private void addEvent(StreamEntry entry, StreamEvent ev) {
            entry.events.add(ev);
            totalBytes += ev.approxBytes();
            enforceByteCap(ev);
        }

        private void enforceByteCap(StreamEvent newest) {
            if (totalBytes <= maxBufferBytes) return;
            // 第一轮优先回收已完成且已经被读取走的历史流
            Iterator<Map.Entry<String, StreamEntry>> finishedIt = streams.entrySet().iterator();
            while (totalBytes > maxBufferBytes && finishedIt.hasNext()) {
                StreamEntry e = finishedIt.next().getValue();
                if (e.finished && (e.events.isEmpty() || e.lastDrainedSeq >= e.nextSeq - 1L)) {
                    for (StreamEvent ev : e.events) totalBytes -= ev.approxBytes();
                    finishedIt.remove();
                }
            }
            // 第二轮回收各流中已经被 drainSince 消费过的旧分片（保留终结/状态事件）
            for (StreamEntry e : streams.values()) {
                if (totalBytes <= maxBufferBytes) break;
                Iterator<StreamEvent> it = e.events.iterator();
                while (totalBytes > maxBufferBytes && it.hasNext()) {
                    StreamEvent ev = it.next();
                    if (ev != newest && "chunk".equals(ev.type) && ev.seq <= e.lastDrainedSeq) {
                        totalBytes -= ev.approxBytes();
                        it.remove();
                    }
                }
            }
            // 第三轮兜底：若单一超长未读流超过上限，淘汰最老 chunk 防止 OOM
            for (StreamEntry e : streams.values()) {
                if (totalBytes <= maxBufferBytes) break;
                Iterator<StreamEvent> it = e.events.iterator();
                while (totalBytes > maxBufferBytes && it.hasNext()) {
                    StreamEvent ev = it.next();
                    if (ev != newest && "chunk".equals(ev.type)) {
                        totalBytes -= ev.approxBytes();
                        it.remove();
                    }
                }
            }
            if (totalBytes < 0) totalBytes = 0;
        }

        private void pruneOldFinishedStreams() {
            if (streams.size() <= maxStreams) return;
            Iterator<Map.Entry<String, StreamEntry>> it = streams.entrySet().iterator();
            while (streams.size() > maxStreams && it.hasNext()) {
                StreamEntry e = it.next().getValue();
                if (e.finished) {
                    for (StreamEvent ev : e.events) totalBytes -= ev.approxBytes();
                    it.remove();
                }
            }
            if (totalBytes < 0) totalBytes = 0;
        }
    }

    /** 活跃流引用计数：0 -> 1 时需要开启前台保活，1 -> 0 时允许收尾停服。 */
    public static final class ActiveRefCounter {
        private final Set<String> activeIds = new HashSet<>();

        public synchronized boolean increment(String requestId) {
            if (requestId == null || requestId.trim().isEmpty()) return false;
            boolean wasEmpty = activeIds.isEmpty();
            boolean added = activeIds.add(requestId);
            return wasEmpty && added;
        }

        public synchronized boolean decrement(String requestId) {
            if (requestId == null || requestId.trim().isEmpty()) return false;
            boolean removed = activeIds.remove(requestId);
            return removed && activeIds.isEmpty();
        }

        public synchronized int count() {
            return activeIds.size();
        }

        public synchronized List<String> snapshotIds() {
            return new ArrayList<>(activeIds);
        }
    }
}
