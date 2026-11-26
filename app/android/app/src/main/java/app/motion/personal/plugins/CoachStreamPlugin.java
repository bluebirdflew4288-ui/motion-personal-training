package app.motion.personal.plugins;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 电子教练后台保活网络 Capacitor 插件：
 * · startStream：交由 {@link CoachStreamService} 在 dataSync FGS + WakeLock 下运行 HTTP SSE 读取；
 * · drainEvents：WebView 前台恢复后按 afterSeq 补齐积压分片；
 * · abortStream：用户主动停止生成时立即切断原生连接；
 * · fetchText：非流式请求（模型列表 / 联网搜索）同走原生 HttpURLConnection，规避 WebView CORS。
 */
@CapacitorPlugin(name = "CoachStream")
public class CoachStreamPlugin extends Plugin {

    private static final ExecutorService FETCH_EXECUTOR = Executors.newCachedThreadPool();

    @Override
    public void load() {
        CoachStreamService.setEventSink(this::dispatchStreamEvent);
    }

    @Override
    protected void handleOnDestroy() {
        CoachStreamService.setEventSink(null);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startStream(PluginCall call) {
        String requestId = call.getString("requestId", "");
        String url = call.getString("url", "");
        String method = call.getString("method", "POST");
        String body = call.getString("body", null);

        if (requestId == null || requestId.trim().isEmpty()) {
            call.reject("missing requestId");
            return;
        }
        if (!CoachStreamPolicy.validateRequest(url, method)) {
            call.reject("invalid url or method");
            return;
        }

        Map<String, String> headers = parseHeaders(call.getObject("headers"));
        CoachStreamService.StreamRequestSpec spec = new CoachStreamService.StreamRequestSpec(
            requestId.trim(),
            url.trim(),
            method,
            headers,
            body
        );
        CoachStreamService.startStream(getContext(), spec);

        JSObject res = new JSObject();
        res.put("requestId", spec.requestId);
        call.resolve(res);
    }

    @PluginMethod
    public void drainEvents(PluginCall call) {
        String requestId = call.getString("requestId", "");
        if (requestId == null || requestId.trim().isEmpty()) {
            call.reject("missing requestId");
            return;
        }
        long afterSeq = 0L;
        Double rawSeq = call.getDouble("afterSeq");
        if (rawSeq != null && rawSeq.longValue() > 0L) {
            afterSeq = rawSeq.longValue();
        }

        CoachStreamPolicy.DrainResult drained = CoachStreamService.drainSince(requestId.trim(), afterSeq);
        JSArray arr = new JSArray();
        for (CoachStreamPolicy.StreamEvent ev : drained.events) {
            arr.put(toJsObject(ev));
        }

        JSObject res = new JSObject();
        res.put("events", arr);
        res.put("finished", drained.finished);
        call.resolve(res);
    }

    @PluginMethod
    public void abortStream(PluginCall call) {
        String requestId = call.getString("requestId", "");
        boolean aborted = CoachStreamService.abortStream(getContext(), requestId);
        JSObject res = new JSObject();
        res.put("aborted", aborted);
        call.resolve(res);
    }

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String body = call.getString("body", null);
        if (!CoachStreamPolicy.validateRequest(url, method)) {
            call.reject("invalid url or method");
            return;
        }
        Map<String, String> headers = parseHeaders(call.getObject("headers"));
        CoachStreamService.StreamRequestSpec spec = new CoachStreamService.StreamRequestSpec(
            "fetch-" + System.nanoTime(),
            url.trim(),
            method,
            headers,
            body
        );

        FETCH_EXECUTOR.submit(() -> {
            try {
                CoachStreamService.TextHttpResult result =
                    CoachStreamService.fetchTextSync(getContext().getApplicationContext(), spec);
                JSObject res = new JSObject();
                res.put("status", result.status);
                res.put("statusText", result.statusText);
                res.put("body", result.body);
                call.resolve(res);
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
            }
        });
    }

    private void dispatchStreamEvent(CoachStreamPolicy.StreamEvent ev) {
        com.getcapacitor.Bridge bridge = getBridge();
        if (bridge == null) return;
        JSObject payload = toJsObject(ev);
        bridge.executeOnMainThread(() -> {
            try {
                notifyListeners("coachStreamEvent", payload);
            } catch (Exception ignored) {
            }
        });
    }

    private static JSObject toJsObject(CoachStreamPolicy.StreamEvent ev) {
        JSObject obj = new JSObject();
        obj.put("requestId", ev.requestId);
        obj.put("seq", ev.seq);
        obj.put("type", ev.type);
        if ("status".equals(ev.type)) {
            obj.put("status", ev.status);
            obj.put("statusText", ev.statusText);
        } else if ("chunk".equals(ev.type)) {
            obj.put("chunk", ev.chunk);
        } else if ("error".equals(ev.type)) {
            obj.put("error", ev.error);
        }
        return obj;
    }

    private static Map<String, String> parseHeaders(JSObject raw) {
        Map<String, String> headers = new HashMap<>();
        if (raw == null) return headers;
        Iterator<String> keys = raw.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            String v = raw.getString(k);
            if (v != null) headers.put(k, v);
        }
        return headers;
    }
}
