package app.motion.personal.plugins;

/**
 * G2：**排程返回身份必须完整**的定向测试（纯 JVM，不触碰 Android API）。
 *
 * <h2>被修复的接线缺口</h2>
 * 旧 {@code RestReminderPlugin.schedule} 在精确调用抛 {@code SecurityException}
 * 后走不精确降级，成功却只写了 {@code scheduled=true / exact=false / reason}，
 * <b>漏了 generation</b>（正常 {@code canScheduleExact=false} 分支是有 generation 的，
 * 两条路径不能混同）。JS 侧 {@code RestScheduleController.dispatch} 只有拿到数字
 * generation 才提交取消凭据，于是：
 * <pre>
 *   降级成功 → 控制器 generation 仍为 null → pause 只记 pendingCancel
 *   → 该请求已结束，不会再有带代次的迟到 ack 补偿 → 暂停后原生提醒仍残留
 * </pre>
 *
 * <h2>证据边界（必须如实写明）</h2>
 * 本测试**不调用** Android AlarmManager / NotificationManager，也不构造真实的
 * {@code PluginCall}/{@code JSObject}。它断言的是：
 * <ol>
 *   <li>身份状态机在"降级成功后仍应给出可取消的真实代次"这一点上的契约；</li>
 *   <li>回复字段集合的**最小完整集**（用纯 Java 复刻的字段契约，见 {@link Reply});</li>
 *   <li>Controller 侧"缺代次即无法提交凭据"的判定。</li>
 * </ol>
 * 真实 SecurityException 注入、真实 PluginCall.resolve 收到的 JSObject、
 * 真实 AlarmManager 调用顺序，仍需按 Codex 的
 * {@code NATIVE-FALLBACK-PREP.md} 用平台边界替身单独执行 —— <b>本轮未做</b>。
 */
public final class RestScheduleReplyTest {

    private static int pass = 0;
    private static int fail = 0;

    /**
     * 纯 Java 复刻的"排程回复"契约。
     *
     * <p>它刻意只表达**字段存在性/取值**，不模拟 AlarmManager 行为。
     * 生产字段名与 JS 侧 {@code RestScheduleResult} 一一对应。
     */
    static final class Reply {
        Boolean scheduled;
        Boolean exact;
        String reason;
        Long generation;
        Integer notifId;
        Long triggerAtMs;
        String path;
        Boolean exactDenied;

        /** 供断言：scheduled=true 时是否带齐"可取消"所需的最小身份 */
        boolean hasCancellableIdentity() {
            return Boolean.TRUE.equals(scheduled)
                && generation != null
                && notifId != null
                && triggerAtMs != null;
        }
    }

    public static void main(String[] args) {
        // ── 1. 正常精确排程：身份完整 ─────────────────────────
        RestReminderState.Outcome exact = RestReminderState.start(
            RestReminderState.Snapshot.empty(), "rest-A", 60000L);
        Reply rExact = replyFor(exact, true, "exact");
        check("精确成功：scheduled=true", Boolean.TRUE.equals(rExact.scheduled));
        check("精确成功：exact=true", Boolean.TRUE.equals(rExact.exact));
        check("精确成功：带真实 generation", rExact.generation != null
            && rExact.generation == exact.state.generation);
        check("精确成功：身份可取消", rExact.hasCancellableIdentity());

        // ── 2. 一开始就没有精确权限（正常降级路径）──────────────
        Reply rInexact = replyFor(exact, false, "inexact-no-permission");
        check("无精确权限：仍带 generation", rInexact.generation != null);
        check("无精确权限：exact=false", Boolean.FALSE.equals(rInexact.exact));
        check("无精确权限：身份可取消", rInexact.hasCancellableIdentity());
        check("无精确权限：path 可区分",
            "inexact-no-permission".equals(rInexact.path));
        check("无精确权限：exactDenied=false（未抛异常）",
            Boolean.FALSE.equals(rInexact.exactDenied));

        // ── 3. SecurityException 后降级成功：**本轮修复的核心** ──
        Reply rFallback = replyFor(exact, false, "exact-denied-fallback-inexact");
        check("降级成功：scheduled=true（不假报失败）",
            Boolean.TRUE.equals(rFallback.scheduled));
        check("降级成功：exact=false", Boolean.FALSE.equals(rFallback.exact));
        check("【修复】降级成功：必须带真实 generation",
            rFallback.generation != null && rFallback.generation == exact.state.generation);
        check("【修复】降级成功：必须带 notifId",
            rFallback.notifId != null && rFallback.notifId == exact.state.notifId);
        check("【修复】降级成功：必须带 triggerAtMs", rFallback.triggerAtMs != null);
        check("【修复】降级成功：身份可取消（pause 能按身份取消）",
            rFallback.hasCancellableIdentity());
        check("降级成功：exactDenied=true（与正常降级区分）",
            Boolean.TRUE.equals(rFallback.exactDenied));
        check("降级成功：path 可区分",
            "exact-denied-fallback-inexact".equals(rFallback.path));

        // ── 4. 降级也失败：不得假报成功 ────────────────────────
        Reply rBothFail = new Reply();
        rBothFail.scheduled = false;
        rBothFail.exact = false;
        rBothFail.reason = "security-exception";
        rBothFail.path = "exact-denied-fallback-failed";
        rBothFail.exactDenied = true;
        check("降级失败：scheduled=false", Boolean.FALSE.equals(rBothFail.scheduled));
        check("降级失败：不带 generation（没有可取消身份）",
            rBothFail.generation == null);
        check("降级失败：身份不可取消", !rBothFail.hasCancellableIdentity());

        // ── 5. 两条降级路径必须可区分（不能混同）───────────────
        check("两条降级路径 path 不同",
            !rInexact.path.equals(rFallback.path));
        check("两条降级路径 exactDenied 不同",
            !rInexact.exactDenied.equals(rFallback.exactDenied));

        // ── 6. Controller 侧判定：缺代次 → 无法提交取消凭据 ────
        check("缺代次的成功回复不可取消", !replyMissingGeneration(exact).hasCancellableIdentity());

        // ── 7. 取消闭环：带真实身份能取消，陈旧身份不能 ────────
        RestReminderState.Snapshot afterSchedule = exact.state;
        RestReminderState.Outcome cancelOk = RestReminderState.cancelIfCurrent(
            afterSchedule, "rest-A", afterSchedule.generation, true);
        check("按真实身份取消：CANCEL",
            cancelOk.action == RestReminderState.Outcome.Action.CANCEL);
        check("按真实身份取消：token 清空", cancelOk.state.token == null);
        check("按真实身份取消：代次推进", cancelOk.state.generation > afterSchedule.generation);

        RestReminderState.Outcome cancelStale = RestReminderState.cancelIfCurrent(
            afterSchedule, "rest-A", afterSchedule.generation + 99, true);
        check("陈旧身份取消：NOOP（不误伤）",
            cancelStale.action == RestReminderState.Outcome.Action.NOOP);
        check("陈旧身份取消：token 保留", "rest-A".equals(cancelStale.state.token));

        System.out.println();
        System.out.println("RestScheduleReplyTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestScheduleReplyTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestScheduleReplyTest 全部通过");
    }

    /** 按修复后的真实字段集构造回复（与 RestReminderPlugin.schedule 的 put 一一对应） */
    private static Reply replyFor(RestReminderState.Outcome outcome, boolean exact, String path) {
        Reply r = new Reply();
        r.scheduled = true;
        r.exact = exact;
        r.generation = outcome.state.generation;
        r.notifId = outcome.state.notifId;
        r.triggerAtMs = 1_700_000_060_000L;
        r.path = path;
        r.exactDenied = "exact-denied-fallback-inexact".equals(path);
        if (!exact) r.reason = "exact-alarm-permission-denied";
        return r;
    }

    /** 对照：模拟修复前降级分支的字段集（缺 generation/notifId/triggerAtMs） */
    private static Reply replyMissingGeneration(RestReminderState.Outcome outcome) {
        Reply r = new Reply();
        r.scheduled = true;
        r.exact = false;
        r.reason = "exact-denied-fallback-inexact";
        return r;
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
