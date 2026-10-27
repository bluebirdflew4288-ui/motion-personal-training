package app.motion.personal.plugins;

/**
 * 预审 P1 #1 的定向测试：Capacitor 桥接的真实数值类型。
 *
 * <p>缺陷背景：{@code PluginCall.getLong} 只接受 {@code java.lang.Long}
 * （PluginCall.java:196-206），而 JS 传 60000/120000/180000 经 JSON 解析是
 * {@code Integer} → getLong 返回 null → 剩余时间被当 0 → 永远排不上提醒。
 *
 * <p>本测试用**真实 JSON 解析**（org.json，Android 内置同款 API 在 JVM 侧由
 * 我们手写等价断言）验证：Integer / Long / Double / String 各种实际来源都能解析。
 * 这里不依赖 Android 运行时，直接构造这些装箱类型。
 */
public final class RestArgsTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ── JS 最常见的三个休息值（JSON 解析为 Integer）──────────
        check("Integer 60000 可解析", RestArgs.parseRemainingMs(Integer.valueOf(60000)).value == 60000L);
        check("Integer 120000 可解析", RestArgs.parseRemainingMs(Integer.valueOf(120000)).value == 120000L);
        check("Integer 180000 可解析", RestArgs.parseRemainingMs(Integer.valueOf(180000)).value == 180000L);
        check("Integer 解析结果为 ok", RestArgs.parseRemainingMs(Integer.valueOf(60000)).ok);

        // ── 其它实际可能出现的类型 ─────────────────────────────
        check("Long 可解析", RestArgs.parseRemainingMs(Long.valueOf(90000L)).value == 90000L);
        check("Double 整数可解析", RestArgs.parseRemainingMs(Double.valueOf(45000d)).value == 45000L);
        check("Float 整数可解析", RestArgs.parseRemainingMs(Float.valueOf(30000f)).value == 30000L);
        check("Short 可解析", RestArgs.parseRemainingMs(Short.valueOf((short) 1000)).value == 1000L);
        check("数字字符串可解析", RestArgs.parseRemainingMs("75000").value == 75000L);
        check("带空格字符串可解析", RestArgs.parseRemainingMs(" 75000 ").value == 75000L);

        // ── 必须拒绝的输入（不得静默当 0）───────────────────────
        check("null 拒绝", !RestArgs.parseRemainingMs(null).ok);
        check("null 原因是 missing", "missing".equals(RestArgs.parseRemainingMs(null).message));
        check("0 拒绝", !RestArgs.parseRemainingMs(Integer.valueOf(0)).ok);
        check("0 原因是 non-positive", "non-positive".equals(RestArgs.parseRemainingMs(Integer.valueOf(0)).message));
        check("负数拒绝", !RestArgs.parseRemainingMs(Integer.valueOf(-5000)).ok);
        check("NaN 拒绝", !RestArgs.parseRemainingMs(Double.valueOf(Double.NaN)).ok);
        check("Infinity 拒绝", !RestArgs.parseRemainingMs(Double.valueOf(Double.POSITIVE_INFINITY)).ok);
        check("小数毫秒拒绝", !RestArgs.parseRemainingMs(Double.valueOf(1500.5)).ok);
        check("小数原因 not-integer", "not-integer".equals(RestArgs.parseRemainingMs(Double.valueOf(1.5)).message));
        check("布尔拒绝", !RestArgs.parseRemainingMs(Boolean.TRUE).ok);
        check("空串拒绝", !RestArgs.parseRemainingMs("").ok);
        check("非数字串拒绝", !RestArgs.parseRemainingMs("abc").ok);
        check("超 24 小时拒绝", !RestArgs.parseRemainingMs(Long.valueOf(RestArgs.MAX_REMAINING_MS + 1)).ok);
        check("恰好 24 小时允许", RestArgs.parseRemainingMs(Long.valueOf(RestArgs.MAX_REMAINING_MS)).ok);

        // ── token 校验 ─────────────────────────────────────────
        check("正常 token", "rest-abc".equals(RestArgs.tokenOrNull("rest-abc")));
        check("token 去空格", "rest-abc".equals(RestArgs.tokenOrNull("  rest-abc ")));
        check("空 token 拒绝", RestArgs.tokenOrNull("") == null);
        check("null token 拒绝", RestArgs.tokenOrNull(null) == null);
        check("非字符串 token 拒绝", RestArgs.tokenOrNull(Integer.valueOf(5)) == null);
        StringBuilder longTok = new StringBuilder();
        for (int i = 0; i < RestArgs.MAX_TOKEN_LEN + 5; i++) longTok.append('x');
        check("超长 token 拒绝", RestArgs.tokenOrNull(longTok.toString()) == null);

        System.out.println();
        System.out.println("RestArgsTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestArgsTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestArgsTest 全部通过");
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
