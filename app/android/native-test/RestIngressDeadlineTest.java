package app.motion.personal.plugins;

/**
 * B4-R2 优先级一 #1（原生侧）：按**发起目标截止**扣掉 JS→Plugin 排队耗时。
 *
 * <p>旧语义 {@code now + remainingMs} 会把桥接排队耗时原样加进休息时长，
 * 表现为"UI 已归零、过一会才响"。本测试锁住：
 * <ul>
 *   <li>合法截止 → 真实剩余 = 截止 − 入口时刻（扣掉排队耗时）；</li>
 *   <li>未提供/非法截止 → 原样返回 remainingMs（旧语义兼容，不破坏既有路径）；</li>
 *   <li>截止已过 → 返回 0（上层按"已到点"处理，不补假提醒）；</li>
 *   <li>解析层：NaN/Infinity/0/负/超上限/非法类型 → null（不建荒唐闹钟）。</li>
 * </ul>
 */
public final class RestIngressDeadlineTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        effectiveRemainingCases();
        parseRejectsInvalid();
        parseAcceptsValid();
        System.out.println("\nRestIngressDeadlineTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    private static void effectiveRemainingCases() {
        long now = 1_800_000_000_000L;

        // 无截止：旧语义原样返回
        check("无截止：原样返回 remainingMs",
            RestArgs.effectiveRemaining(60_000L, null, now) == 60_000L);

        // 截止 = 点击时刻 + 60s，入口延迟 1000ms → 真实剩余 59s（扣掉排队）
        check("入口延迟 1000ms：剩余扣成 59000（不是 60000）",
            RestArgs.effectiveRemaining(60_000L, now + 60_000L, now + 1000L) == 59_000L);

        // 入口延迟 0：与旧语义一致
        check("入口延迟 0：剩余仍是 60000",
            RestArgs.effectiveRemaining(60_000L, now + 60_000L, now) == 60_000L);

        // 恰好到点：0
        check("恰好到点：返回 0",
            RestArgs.effectiveRemaining(60_000L, now, now) == 0L);

        // 已过期：0（不是负数，也不是夹成 1ms 的假提醒）
        check("已过期 5s：返回 0（不补假提醒）",
            RestArgs.effectiveRemaining(60_000L, now - 5_000L, now) == 0L);

        // 大延迟：扣掉后仍正确
        check("入口延迟 8s：剩余 52000",
            RestArgs.effectiveRemaining(60_000L, now + 60_000L, now + 8_000L) == 52_000L);

        // 加时场景：剩余 15000，入口延迟 300ms
        check("加时 15s + 延迟 300ms：剩余 14700",
            RestArgs.effectiveRemaining(15_000L, now + 15_000L, now + 300L) == 14_700L);
    }

    private static void parseRejectsInvalid() {
        check("null → null", RestArgs.parseDeadlineAtMsOrNull(null) == null);
        check("NaN → null", RestArgs.parseDeadlineAtMsOrNull(Double.NaN) == null);
        check("Infinity → null", RestArgs.parseDeadlineAtMsOrNull(Double.POSITIVE_INFINITY) == null);
        check("0 → null", RestArgs.parseDeadlineAtMsOrNull(0) == null);
        check("-1 → null", RestArgs.parseDeadlineAtMsOrNull(-1) == null);
        check("Boolean → null", RestArgs.parseDeadlineAtMsOrNull(Boolean.TRUE) == null);
        check("空串 → null", RestArgs.parseDeadlineAtMsOrNull("") == null);
        check("非数字串 → null", RestArgs.parseDeadlineAtMsOrNull("abc") == null);
        // 远超上限（当前 + 24h）→ 拒绝
        long tooFar = System.currentTimeMillis() + RestArgs.MAX_REMAINING_MS * 3L;
        check("超过 24h 上限 → null", RestArgs.parseDeadlineAtMsOrNull(tooFar) == null);
    }

    private static void parseAcceptsValid() {
        long soon = System.currentTimeMillis() + 60_000L;
        Long parsed = RestArgs.parseDeadlineAtMsOrNull(soon);
        check("合法墙钟毫秒 → 解析成功", parsed != null && parsed == soon);
        Long parsedStr = RestArgs.parseDeadlineAtMsOrNull(String.valueOf(soon));
        check("数字字符串 → 解析成功", parsedStr != null && parsedStr == soon);
        Long parsedInt = RestArgs.parseDeadlineAtMsOrNull((int) soon);
        check("Integer 形态 → 解析成功", parsedInt != null);
        Long parsedDouble = RestArgs.parseDeadlineAtMsOrNull((double) soon);
        check("Double 形态 → 解析成功", parsedDouble != null && parsedDouble == soon);
    }

    private static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  PASS " + name); }
        else { fail++; System.out.println("  FAIL " + name); }
    }
}
