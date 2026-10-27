package app.motion.personal.plugins;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 休息提醒的**最小本地有界诊断**（纯 JVM，可离线测试；不联网、不外发、不含训练内容）。
 *
 * <h2>要解决什么</h2>
 * 用户反馈"同机同设置，后台有时提醒有时不提醒"，而现有返回值与持久化状态都回答不了
 * 下面这条链断在哪一环：
 * <pre>
 *   schedule（排程请求） -> alarm/fire（广播真的到了） -> notify（通知尝试 / 失败）
 * </pre>
 * 特别是：
 * <ul>
 *   <li>{@code fired=true} 只表示**身份已被消费**，不表示通知已发出；</li>
 *   <li>精确调度抛 SecurityException 后降级成功、与一开始就没精确权限，是两条不同路径；</li>
 *   <li>Receiver 先 commit fired 再 notify，notify 失败被吞掉，事后无从判断。</li>
 * </ul>
 *
 * <h2>边界（刻意收紧）</h2>
 * <ul>
 *   <li><b>有界</b>：只保留最近 {@link #MAX_EVENTS} 条，超出丢弃最旧的；</li>
 *   <li><b>本地</b>：只写本机 SharedPreferences，不联网、不上报、不进备份；</li>
 *   <li><b>无内容</b>：只记时间戳 / 事件类型 / 短原因，<b>不记 token、不记训练内容</b>；</li>
 *   <li><b>不改变投递语义</b>：只旁路记录，不重试、不改 commit-before-notify 顺序，
 *       因此不会造成双响。</li>
 * </ul>
 *
 * <h2>编码</h2>
 * 单行一条，用 {@code |} 分隔：{@code <atMs>|<kind>|<detail>}。
 * kind/detail 里的分隔符与换行会被替换掉，保证解析不会被用户数据破坏。
 */
public final class RestDiagLog {

    /** 最多保留的事件条数（有界，防止无限增长） */
    public static final int MAX_EVENTS = 16;

    /** 单条 detail 的最大长度（防止异常信息把存储撑大） */
    public static final int MAX_DETAIL_LEN = 48;

    // ── 事件类型（JS/设置页按这些值解释，不要随意改名）─────────────
    /** 排程成功（detail=exact / inexact-no-permission / exact-denied-fallback-inexact） */
    public static final String KIND_SCHEDULE = "schedule";
    /** 排程失败（detail=短原因） */
    public static final String KIND_SCHEDULE_FAILED = "schedule-failed";
    /** 取消（detail=with-identity / full-clear） */
    public static final String KIND_CANCEL = "cancel";
    /** 广播到达且身份核验通过、fired 已持久化（detail=notifId） */
    public static final String KIND_FIRE = "fire";
    /** 广播被丢弃（detail=stale-token / stale-generation / already-fired / ...） */
    public static final String KIND_FIRE_REJECTED = "fire-rejected";
    /** 通知已提交给系统（detail=notifId） */
    public static final String KIND_NOTIFY_OK = "notify-ok";
    /** 通知未尝试（detail=app-notifications-off / no-notification-service） */
    public static final String KIND_NOTIFY_BLOCKED = "notify-blocked";
    /** 通知抛异常（detail=异常类名） */
    public static final String KIND_NOTIFY_ERROR = "notify-error";

    // ── A2：当前段前台计时服务（普通后台增强）────────────────────
    /** 当前段服务启动成功（detail=type / type-fallback） */
    public static final String KIND_FGS_STARTED = "fgs-started";
    /** 当前段服务启动失败并已退回 AlarmManager（detail=短原因） */
    public static final String KIND_FGS_FAILED = "fgs-failed";
    /** 当前段服务已停止并释放锁（detail=paused/cancelled/completed/replaced/error） */
    public static final String KIND_FGS_STOPPED = "fgs-stopped";
    /** 当前段增强未启用（detail=no-exact-permission / notifications-unreachable / api-too-low） */
    public static final String KIND_FGS_SKIPPED = "fgs-skipped";

    private static final String SEP = "|";

    private RestDiagLog() {}

    /**
     * 追加一条事件并保持有界。纯函数：输入旧编码串，返回新编码串。
     *
     * @param raw    旧编码串（null / 空表示还没有事件）
     * @param atMs   事件时刻（{@link System#currentTimeMillis()}）
     * @param kind   事件类型（见上面的常量）
     * @param detail 短原因；可为 null
     * @return 新的编码串（最多 {@link #MAX_EVENTS} 行）
     */
    public static String append(String raw, long atMs, String kind, String detail) {
        List<String> events = new ArrayList<>(parse(raw));
        events.add(atMs + SEP + clean(kind, 16) + SEP + clean(detail, MAX_DETAIL_LEN));
        // 有界：只留最近 MAX_EVENTS 条
        if (events.size() > MAX_EVENTS) {
            events = new ArrayList<>(events.subList(events.size() - MAX_EVENTS, events.size()));
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < events.size(); i++) {
            if (i > 0) sb.append('\n');
            sb.append(events.get(i));
        }
        return sb.toString();
    }

    /** 解析编码串为事件行列表；非法/空输入返回空列表（不抛错） */
    public static List<String> parse(String raw) {
        if (raw == null || raw.isEmpty()) return Collections.emptyList();
        List<String> out = new ArrayList<>();
        for (String line : raw.split("\n")) {
            if (line == null) continue;
            String t = line.trim();
            if (t.isEmpty()) continue;
            out.add(t);
        }
        return out;
    }

    /** 解析单条事件为 [atMs, kind, detail]；格式非法返回 null */
    public static String[] split(String event) {
        if (event == null) return null;
        String[] parts = event.split("\\" + SEP, 3);
        if (parts.length < 2) return null;
        return new String[] { parts[0], parts[1], parts.length > 2 ? parts[2] : "" };
    }

    /** 清掉分隔符/控制字符并截断，保证编码不会被破坏 */
    private static String clean(String s, int maxLen) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length() && sb.length() < maxLen; i++) {
            char c = s.charAt(i);
            if (c == '|' || c == '\n' || c == '\r' || c == '\t') {
                sb.append('_');
            } else if (c < 0x20) {
                // 其它控制字符直接丢弃
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
