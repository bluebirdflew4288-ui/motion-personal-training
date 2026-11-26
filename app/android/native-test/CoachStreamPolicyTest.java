package app.motion.personal.plugins;

import java.util.List;

/**
 * 0.2.2：电子教练后台保活网络策略与分片缓冲的纯 JVM 单元测试。
 *
 * <p>覆盖关键不变式：
 * <ul>
 *   <li>URL/HTTP Method/Header 校验（拒绝 file://、javascript:、CRLF 注入）；</li>
 *   <li>{@link CoachStreamPolicy.StreamBuffer} 单调递增 seq 与 {@code drainSince(afterSeq)} 断点续传；</li>
 *   <li>4MB 总缓冲上限淘汰与保留终结事件不丢失；</li>
 *   <li>多并发流 {@link CoachStreamPolicy.ActiveRefCounter} 0→1 启动 / 2→1 保持 / 1→0 停止；</li>
 *   <li>通知 ID 与请求码区间与 {@link RestForegroundPolicy} 永久不相交。</li>
 * </ul>
 */
public final class CoachStreamPolicyTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // 1. URL / Method / Header 校验
        check("允许 https URL", CoachStreamPolicy.isValidUrl("https://api.deepseek.com/v1/chat/completions"));
        check("允许 http URL", CoachStreamPolicy.isValidUrl("http://127.0.0.1:8080/v1/models"));
        check("拒绝 file URL", !CoachStreamPolicy.isValidUrl("file:///etc/passwd"));
        check("拒绝 javascript URL", !CoachStreamPolicy.isValidUrl("javascript:alert(1)"));
        check("拒绝空 URL", !CoachStreamPolicy.isValidUrl("  "));
        check("拒绝 CRLF URL", !CoachStreamPolicy.isValidUrl("https://example.com/\r\nX: y"));
        check("规范化方法 post -> POST", "POST".equals(CoachStreamPolicy.normalizeMethod(" post ")));
        check("拒绝非法方法 TRACE", CoachStreamPolicy.normalizeMethod("TRACE") == null);
        check("总体校验 validateRequest", CoachStreamPolicy.validateRequest("https://api.openai.com/v1/models", "get"));
        check("拒绝头换行注入", CoachStreamPolicy.sanitizeHeader("Authorization", "Bearer a\r\nb") == null);
        check("拒绝头名含冒号", CoachStreamPolicy.sanitizeHeader("Bad:Key", "val") == null);
        check("清洗合法头", CoachStreamPolicy.sanitizeHeader(" Content-Type ", "application/json") != null);

        // 2. StreamBuffer 单调 seq + 断点补拉
        CoachStreamPolicy.StreamBuffer buf = new CoachStreamPolicy.StreamBuffer();
        buf.register("req-1");
        CoachStreamPolicy.StreamEvent st = buf.appendStatus("req-1", 200, "OK");
        CoachStreamPolicy.StreamEvent c1 = buf.appendChunk("req-1", "你好");
        CoachStreamPolicy.StreamEvent c2 = buf.appendChunk("req-1", "世界");
        CoachStreamPolicy.StreamEvent dn = buf.appendDone("req-1");
        check("seq 单调递增 1..4", st.seq == 1 && c1.seq == 2 && c2.seq == 3 && dn.seq == 4);

        CoachStreamPolicy.DrainResult partial = buf.drainSince("req-1", 1L);
        check("afterSeq=1 返回后 3 条且 finished=true",
            partial.events.size() == 3 && partial.finished && partial.events.get(0).seq == 2);
        CoachStreamPolicy.DrainResult tail = buf.drainSince("req-1", 4L);
        check("afterSeq=4 返回空且 finished=true", tail.events.isEmpty() && tail.finished);

        // 重复 appendDone 不重复产生事件
        check("重复 done 被幂等忽略", buf.appendDone("req-1") == null);

        // 3. 缓冲字节上限强制淘汰与保留终结状态
        CoachStreamPolicy.StreamBuffer smallBuf = new CoachStreamPolicy.StreamBuffer(8192, 8);
        smallBuf.register("big");
        smallBuf.appendStatus("big", 200, "OK");
        String chunk2k = "A".repeat(1000);
        for (int i = 0; i < 12; i += 1) {
            smallBuf.appendChunk("big", chunk2k);
        }
        smallBuf.appendDone("big");
        check("总缓冲字节被钳制不超过阈值太多", smallBuf.totalBytes() <= 8192);
        CoachStreamPolicy.DrainResult survived = smallBuf.drainSince("big", 0L);
        List<CoachStreamPolicy.StreamEvent> survivedEvs = survived.events;
        check("超限淘汰后仍保留完结标识与最新 done 事件",
            survived.finished && !survivedEvs.isEmpty() && "done".equals(survivedEvs.get(survivedEvs.size() - 1).type));

        // 4. 多路流 ActiveRefCounter
        CoachStreamPolicy.ActiveRefCounter refs = new CoachStreamPolicy.ActiveRefCounter();
        check("0->1 需要启动前台保活", refs.increment("s1"));
        check("1->2 不重复触发启动", !refs.increment("s2"));
        check("计数为 2", refs.count() == 2);
        check("2->1 仍需维持保活", !refs.decrement("s1"));
        check("1->0 允许停止保活", refs.decrement("s2"));
        check("归零后计数为 0", refs.count() == 0);

        // 5. 通知 ID / RequestCode 区间与 RestForegroundPolicy 隔离
        check("NOTIFICATION_ID 避开 RestForegroundPolicy 正向区间",
            CoachStreamPolicy.NOTIFICATION_ID > RestForegroundPolicy.ONGOING_ID_BASE + 1000);
        check("CONTENT_REQUEST_CODE 避开 RestForegroundPolicy 请求码区间",
            CoachStreamPolicy.CONTENT_REQUEST_CODE != RestForegroundPolicy.contentRequestCode()
                && CoachStreamPolicy.CONTENT_REQUEST_CODE > RestForegroundPolicy.CANCEL_REQUEST_BASE + 100);
        check("后台优雅停服窗口在 5..30 秒区间内",
            CoachStreamPolicy.STOP_GRACE_MS >= 5_000L && CoachStreamPolicy.STOP_GRACE_MS <= 30_000L);

        System.out.println("CoachStreamPolicyTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static void check(String name, boolean cond) {
        if (cond) {
            pass += 1;
        } else {
            fail += 1;
            System.err.println("FAIL: " + name);
        }
    }
}
