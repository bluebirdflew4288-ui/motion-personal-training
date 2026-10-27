package app.motion.personal.plugins;

/**
 * G2：最小本地有界诊断的定向测试。
 *
 * <p>缺陷背景：用户反馈"同机同设置，后台有时提醒有时不提醒"，而
 * <ul>
 *   <li>{@code fired=true} 只表示身份已被消费，不表示通知已发出；</li>
 *   <li>Receiver 先 commit fired 再 notify，notify 失败被静默吞掉；</li>
 *   <li>精确调度抛 SecurityException 后降级、与一开始就没精确权限，是两条不同路径。</li>
 * </ul>
 * 三者都无法从既有返回值/状态里区分，所以补这条**旁路、有界、本地、无内容**的诊断。
 *
 * <p>本测试只覆盖纯 JVM 的编码/有界/脱敏规则。
 * <b>不证明</b> Android 实际投递、通知是否被系统拦截或实体震动 —— 那些仍未验证。
 */
public final class RestDiagTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ── 基本追加与格式 ─────────────────────────────────────
        String one = RestDiagLog.append(null, 1_700_000_000_000L,
            RestDiagLog.KIND_SCHEDULE, "exact");
        check("空输入可追加一条", RestDiagLog.parse(one).size() == 1);
        String[] parts = RestDiagLog.split(RestDiagLog.parse(one).get(0));
        check("事件可解析为三元组", parts != null && parts.length == 3);
        check("时刻保真", parts != null && "1700000000000".equals(parts[0]));
        check("类型保真", parts != null && RestDiagLog.KIND_SCHEDULE.equals(parts[1]));
        check("原因保真", parts != null && "exact".equals(parts[2]));

        // ── 有界：只留最近 MAX_EVENTS 条 ──────────────────────
        String many = null;
        for (int i = 0; i < RestDiagLog.MAX_EVENTS * 3; i++) {
            many = RestDiagLog.append(many, 1_700_000_000_000L + i,
                RestDiagLog.KIND_FIRE, String.valueOf(i));
        }
        java.util.List<String> lines = RestDiagLog.parse(many);
        check("有界：条数不超过 MAX_EVENTS", lines.size() == RestDiagLog.MAX_EVENTS);
        String[] last = RestDiagLog.split(lines.get(lines.size() - 1));
        String[] first = RestDiagLog.split(lines.get(0));
        check("有界：保留最新一条", last != null
            && String.valueOf(RestDiagLog.MAX_EVENTS * 3 - 1).equals(last[2]));
        check("有界：丢弃最旧一条", first != null
            && String.valueOf(RestDiagLog.MAX_EVENTS * 2).equals(first[2]));

        // ── 不记 token / 训练内容：调用方不传就绝不会出现 ──────
        String noToken = RestDiagLog.append(null, 1L, RestDiagLog.KIND_NOTIFY_OK, "7");
        check("诊断行不含 token 前缀", !noToken.contains("rest-"));
        check("诊断行不含换行污染", !noToken.contains("\n"));

        // ── 编码自保护：分隔符/换行/控制字符不得破坏格式 ───────
        String dirty = RestDiagLog.append(null, 2L, RestDiagLog.KIND_NOTIFY_ERROR,
            "Bad|Thing\nWith\rBreaks\tAnd\u0001Ctl");
        String[] dp = RestDiagLog.split(RestDiagLog.parse(dirty).get(0));
        check("脏 detail 仍能解析为三元组", dp != null && dp.length == 3);
        check("竖线被替换", dp != null && !dp[2].contains("|"));
        check("换行被替换", dp != null && !dp[2].contains("\n"));
        check("控制字符被丢弃", dp != null && dp[2].indexOf('\u0001') < 0);

        // ── detail 截断（有界）─────────────────────────────────
        StringBuilder longDetail = new StringBuilder();
        for (int i = 0; i < 500; i++) longDetail.append('x');
        String truncated = RestDiagLog.append(null, 3L, RestDiagLog.KIND_SCHEDULE_FAILED,
            longDetail.toString());
        String[] tp = RestDiagLog.split(RestDiagLog.parse(truncated).get(0));
        check("超长 detail 被截断", tp != null && tp[2].length() == RestDiagLog.MAX_DETAIL_LEN);

        // ── 容错：坏输入不抛异常 ───────────────────────────────
        check("null 解析为空列表", RestDiagLog.parse(null).isEmpty());
        check("空串解析为空列表", RestDiagLog.parse("").isEmpty());
        check("纯空白行被跳过", RestDiagLog.parse("  \n \n").isEmpty());
        check("split(null) 返回 null", RestDiagLog.split(null) == null);
        check("split(无分隔符) 返回 null", RestDiagLog.split("justonefield") == null);
        check("两段式事件仍可解析", RestDiagLog.split("123|fire") != null);

        // ── 事件类型常量是稳定契约（设置页按这些值解释）─────────
        String[] kinds = {
            RestDiagLog.KIND_SCHEDULE, RestDiagLog.KIND_SCHEDULE_FAILED, RestDiagLog.KIND_CANCEL,
            RestDiagLog.KIND_FIRE, RestDiagLog.KIND_FIRE_REJECTED, RestDiagLog.KIND_NOTIFY_OK,
            RestDiagLog.KIND_NOTIFY_BLOCKED, RestDiagLog.KIND_NOTIFY_ERROR,
        };
        boolean allClean = true;
        for (String k : kinds) {
            if (k.contains("|") || k.contains("\n")) allClean = false;
        }
        check("类型常量不含分隔符", allClean);

        System.out.println();
        System.out.println("RestDiagTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestDiagTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestDiagTest 全部通过");
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  ✔ " + name);
        } else {
            fail++;
            System.out.println("  ✘ " + name);
        }
    }
}
