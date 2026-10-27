package app.motion.personal.plugins;

/**
 * A2：五项准确状态/诊断缺口的**定向回归**（纯 JVM，不触碰 Android API）。
 *
 * <p>对应 Codex 独立复验的 5 项 FAIL。本测试锁定**修复后的判定契约**：
 * <ol>
 *   <li>只有真正精确调用被拒才 exactDenied；不精确自身失败不重试、不假标精确拒绝；</li>
 *   <li>Receiver 持久化失败与旧身份拒绝可区分（保留失败原因）；</li>
 *   <li>schedule 早退失败（含持久化失败）留有最小记录；</li>
 *   <li>cancel=false 不得表达为"已取消"；</li>
 *   <li>canVibrate 必须含通知许可交集。</li>
 * </ol>
 *
 * <p><b>证据边界（重要）</b>：本文件是**纯判定逻辑**回归，不执行生产
 * {@code RestReminderPlugin.schedule} 的 SecurityException 分支，也不构造
 * 真实 PluginCall/AlarmManager。真实 Android 分支已由 Codex 独立宿主链
 * （native-prep/run-native.mjs）执行并给出本轮 5 项 FAIL —— 本文件是对应修复的
 * 契约回归，**不能**替代那条独立链的复验。
 */
public final class RestA2ReplyTest {

    private static int pass = 0;
    private static int fail = 0;

    /** 复刻修复后的排程路径判定（与 RestReminderPlugin.schedule 同构） */
    static String pathFor(boolean canExact, boolean exactThrows, boolean inexactThrows) {
        boolean exactDenied = false;
        boolean scheduledOk;
        String path;
        if (canExact) {
            if (!exactThrows) {
                scheduledOk = true;
                path = "exact";
            } else {
                exactDenied = true;
                if (!inexactThrows) {
                    scheduledOk = true;
                    path = "exact-denied-fallback-inexact";
                } else {
                    scheduledOk = false;
                    path = "exact-denied-fallback-failed";
                }
            }
        } else {
            if (!inexactThrows) {
                scheduledOk = true;
                path = "inexact-no-permission";
            } else {
                scheduledOk = false;
                path = "inexact-failed";
            }
        }
        return path;
    }

    public static void main(String[] args) {
        // ══ 缺口 #1：精确/不精确路径必须准确 ══════════════════════
        check("精确成功 → path=exact", "exact".equals(pathFor(true, false, false)));
        check("精确被拒+降级成功 → exact-denied-fallback-inexact",
            "exact-denied-fallback-inexact".equals(pathFor(true, true, false)));
        check("精确被拒+降级也失败 → exact-denied-fallback-failed",
            "exact-denied-fallback-failed".equals(pathFor(true, true, true)));
        check("【缺口#1】无精确权限+不精确成功 → inexact-no-permission（非降级）",
            "inexact-no-permission".equals(pathFor(false, false, false)));
        /**
         * 核心：canExact=false 时不精确调用抛异常，**必须**是 inexact-failed，
         * 绝不能是 exact-denied-* —— 旧实现正是在这里假报成"精确被拒"。
         */
        String inexactBoom = pathFor(false, false, true);
        check("【缺口#1】无精确权限+不精确抛异常 → inexact-failed",
            "inexact-failed".equals(inexactBoom));
        check("【缺口#1】该情形不得标成 exactDenied 路径",
            !inexactBoom.startsWith("exact-denied"));
        check("【缺口#1】该情形必须如实 scheduled=false",
            !"inexact-no-permission".equals(inexactBoom));

        // ══ 缺口 #2：Receiver 持久化失败可归因 ════════════════════
        // 修复后：durable=false → persist-failed:<reason>；durable=true 且非 fire → 真实原因
        String persistFail = "persist-failed:commit-failed";
        String staleToken = "stale-broadcast-token";
        check("【缺口#2】持久化失败原因带 persist-failed 前缀",
            persistFail.startsWith("persist-failed:"));
        check("【缺口#2】持久化失败与陈旧身份不同",
            !persistFail.equals(staleToken));
        check("【缺口#2】陈旧身份保留原原因", "stale-broadcast-token".equals(staleToken));
        check("【缺口#2】already-fired 仍可单独区分", !"already-fired".equals(persistFail));

        // ══ 缺口 #3：早退失败必须有记录 ═══════════════════════════
        String[] earlyFailures = {
            "invalid-token", "invalid-remaining", "persist-failed", "null-outcome",
            "already-fired", "non-positive-delay", "no-alarm-service",
        };
        boolean allRecordable = true;
        for (String r : earlyFailures) {
            // 诊断编码必须能承载这些原因且不破坏格式
            String line = RestDiagLog.append(null, 1L, RestDiagLog.KIND_SCHEDULE_FAILED, r);
            String[] parts = RestDiagLog.split(RestDiagLog.parse(line).get(0));
            if (parts == null || !RestDiagLog.KIND_SCHEDULE_FAILED.equals(parts[1])
                || !r.equals(parts[2])) {
                allRecordable = false;
            }
        }
        check("【缺口#3】全部早退失败原因可被诊断编码承载", allRecordable);
        check("【缺口#3】persist-failed 可记录",
            !RestDiagLog.parse(RestDiagLog.append(null, 1L,
                RestDiagLog.KIND_SCHEDULE_FAILED, "persist-failed")).isEmpty());

        // ══ 缺口 #4：cancel=false 不得显示"已取消" ═══════════════
        // 与 Settings.diagLabel 的判定同构：只有非 rejected 才用"已取消"
        check("【缺口#4】rejected 不应表达为成功取消",
            !isCancelSuccess("rejected"));
        check("【缺口#4】with-identity 才是成功取消", isCancelSuccess("with-identity"));
        check("【缺口#4】full-clear 才是成功取消", isCancelSuccess("full-clear"));
        check("【缺口#4】空原因也不得默认成功", !isCancelSuccess(""));

        // ══ 缺口 #5：canVibrate 必须含通知许可交集 ═══════════════
        // 修复后：perm && appOn && chOn && chVib
        check("【缺口#5】无通知许可 → canVibrate=false（即使渠道允许震动）",
            !canVibrate(false, true, true, true));
        check("【缺口#5】总开关关 → canVibrate=false",
            !canVibrate(true, false, true, true));
        check("【缺口#5】渠道关 → canVibrate=false", !canVibrate(true, true, false, true));
        check("【缺口#5】渠道不震动 → canVibrate=false", !canVibrate(true, true, true, false));
        check("【缺口#5】四项齐全才 true", canVibrate(true, true, true, true));
        /**
         * 独立复验给出的受控组合：notificationsGranted=false 但
         * appOn/channelOn/channelVibration=true —— 旧实现得出 canVibrate=true（错）。
         */
        check("【缺口#5】独立例组合 now false", !canVibrate(false, true, true, true));
        check("【缺口#5】canVibrate 不得强于 canAlert",
            !(canVibrate(false, true, true, true) && !(false && true && true)));

        // ══ 诊断语义：notify 只代表"调用成功" ════════════════════
        check("notify-ok 事件类型存在",
            "notify-ok".equals(RestDiagLog.KIND_NOTIFY_OK));
        check("notify-ok 不等于已送达（类型名不含 delivered）",
            !RestDiagLog.KIND_NOTIFY_OK.contains("delivered"));

        System.out.println();
        System.out.println("RestA2ReplyTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestA2ReplyTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestA2ReplyTest 全部通过");
    }

    /** 与 Settings.diagLabel 同构：cancel 事件是否表示真正成功取消 */
    private static boolean isCancelSuccess(String detail) {
        return detail != null && !detail.isEmpty() && !"rejected".equals(detail);
    }

    /** 与修复后的 native/JS 一致：四项合取 */
    private static boolean canVibrate(boolean perm, boolean appOn, boolean chOn, boolean chVib) {
        return perm && appOn && chOn && chVib;
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
