package app.motion.personal.plugins;

/**
 * Wave 1B.2 定向纯 JVM 测试：
 * 通知栏「取消」与页面前后台对账（cancelFromNotification + inspectIdentity）。
 *
 * <p>验证矩阵：
 * <ol>
 *   <li>active / fired 状态按身份精确返回 {@code "active"} / {@code "fired"}；</li>
 *   <li>通知栏点击取消（{@code cancelFromNotification}）记录 {@code lastUserCancelledToken}
 *       + {@code lastUserCancelledGeneration}，并推进代次、清空当前 token、保留意图水位；</li>
 *   <li>对账查询 {@code inspectIdentity} 精确返回 {@code "cancelled_by_user"}（含带代次与未知代次），
 *       而不会与应用内暂停取消（{@code "cancelled"}）混淆；</li>
 *   <li>陈旧 token / 陈旧代次 / 已 fired 下的迟到通知栏取消请求一律 NOOP，绝不误伤新提醒；</li>
 *   <li>同一 token 重新排程（如恢复继续/+15）会清除旧的 user-cancel 标记，后续应用内暂停不会误判；</li>
 *   <li>切换到新 token B 后，B 为 active，而旧 A 的精确代次仍可识别为 cancelled_by_user。</li>
 * </ol>
 */
public final class RestUserCancelReconcileTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        RestReminderState.Snapshot empty = RestReminderState.Snapshot.empty();

        // 1. 活跃态与已触发态查询
        RestReminderState.Outcome s1 =
            RestReminderState.startWithIntent(empty, "rest-A", 60_000L, 1L);
        long genA1 = s1.state.generation;
        check("A/gen1 为 active（精确代次）",
            "active".equals(RestReminderState.inspectIdentity(s1.state, "rest-A", genA1, true)));
        check("A 为 active（无代次查询）",
            "active".equals(RestReminderState.inspectIdentity(s1.state, "rest-A", 0L, false)));
        check("未知 token 返回 unknown",
            "unknown".equals(RestReminderState.inspectIdentity(s1.state, "rest-other", genA1, true)));

        // 2. 陈旧代次或错误 token 的通知栏取消一律 NOOP，不破坏活跃提醒
        RestReminderState.Outcome wrongTok =
            RestReminderState.cancelFromNotification(s1.state, "rest-wrong", genA1);
        check("错误 token 通知栏取消：NOOP",
            wrongTok.action == RestReminderState.Outcome.Action.NOOP);
        check("错误 token 后 A 仍 active",
            "active".equals(RestReminderState.inspectIdentity(wrongTok.state, "rest-A", genA1, true)));

        RestReminderState.Outcome wrongGen =
            RestReminderState.cancelFromNotification(s1.state, "rest-A", genA1 + 99L);
        check("错误代次通知栏取消：NOOP",
            wrongGen.action == RestReminderState.Outcome.Action.NOOP);
        check("错误代次后 A 仍 active",
            "active".equals(RestReminderState.inspectIdentity(wrongGen.state, "rest-A", genA1, true)));

        // 3. 真实通知栏点击取消：CANCEL + 记录精确身份 + 保留意图水位
        RestReminderState.Outcome userCancelled =
            RestReminderState.cancelFromNotification(s1.state, "rest-A", genA1);
        check("通知栏取消：CANCEL",
            userCancelled.action == RestReminderState.Outcome.Action.CANCEL);
        check("通知栏取消：reason=cancelled-by-user",
            "cancelled-by-user".equals(userCancelled.reason));
        check("通知栏取消：当前 token 置空", userCancelled.state.token == null);
        check("通知栏取消：代次递增", userCancelled.state.generation == genA1 + 1L);
        check("通知栏取消：保留意图水位 1", userCancelled.state.lastIntentId == 1L);
        check("对账 A/gen1（带代次）= cancelled_by_user",
            "cancelled_by_user".equals(
                RestReminderState.inspectIdentity(userCancelled.state, "rest-A", genA1, true)));
        check("对账 A（无代次）= cancelled_by_user",
            "cancelled_by_user".equals(
                RestReminderState.inspectIdentity(userCancelled.state, "rest-A", 0L, false)));
        check("对账 A/错误代次 != cancelled_by_user",
            !"cancelled_by_user".equals(
                RestReminderState.inspectIdentity(userCancelled.state, "rest-A", genA1 + 5L, true)));

        // 4. 应用内暂停（普通 cancelIfCurrent）必须返回 cancelled 而非 cancelled_by_user
        RestReminderState.Outcome sApp =
            RestReminderState.startWithIntent(empty, "rest-pause", 60_000L, 1L);
        long genApp = sApp.state.generation;
        RestReminderState.Outcome pausedInApp =
            RestReminderState.cancelIfCurrent(sApp.state, "rest-pause", genApp, true);
        check("应用内暂停对账 = cancelled（绝不误判为通知栏取消）",
            "cancelled".equals(
                RestReminderState.inspectIdentity(pausedInApp.state, "rest-pause", genApp, true)));

        // 5. 同 token 重新排程后，旧的 cancelled_by_user 标记被清除，再暂停不会误读旧标记
        RestReminderState.Outcome resumedSame =
            RestReminderState.startWithIntent(userCancelled.state, "rest-A", 45_000L, 2L);
        long genA2 = resumedSame.state.generation;
        check("同 token 重排后 active",
            "active".equals(RestReminderState.inspectIdentity(resumedSame.state, "rest-A", genA2, true)));
        check("同 token 重排清空旧 userCancel 标记",
            resumedSame.state.lastUserCancelledToken == null);
        RestReminderState.Outcome pausedA2 =
            RestReminderState.cancelIfCurrent(resumedSame.state, "rest-A", genA2, true);
        check("同 token 重排后再应用内暂停 = cancelled",
            "cancelled".equals(
                RestReminderState.inspectIdentity(pausedA2.state, "rest-A", genA2, true)));

        // 6. 已 fired 的提醒收到迟到通知栏取消：NOOP，保持 fired
        RestReminderState.Outcome sFiredBase =
            RestReminderState.startWithIntent(empty, "rest-fired", 30_000L, 1L);
        long genFired = sFiredBase.state.generation;
        RestReminderState.Outcome fired =
            RestReminderState.onAlarmFired(sFiredBase.state, "rest-fired", genFired);
        check("已触发对账 = fired",
            "fired".equals(RestReminderState.inspectIdentity(fired.state, "rest-fired", genFired, true)));
        RestReminderState.Outcome cancelAfterFire =
            RestReminderState.cancelFromNotification(fired.state, "rest-fired", genFired);
        check("已 fired 后迟到通知栏取消：NOOP",
            cancelAfterFire.action == RestReminderState.Outcome.Action.NOOP);
        check("已 fired 后状态仍为 fired",
            "fired".equals(
                RestReminderState.inspectIdentity(cancelAfterFire.state, "rest-fired", genFired, true)));

        // 7. 通知栏取消 A 后立即开启新休息 B：B 为 active，A 精确身份仍可对账为 cancelled_by_user
        RestReminderState.Outcome sB =
            RestReminderState.startWithIntent(userCancelled.state, "rest-B", 90_000L, 1L);
        check("新 token B 为 active",
            "active".equals(
                RestReminderState.inspectIdentity(sB.state, "rest-B", sB.state.generation, true)));
        check("旧 token A/gen1 仍对账为 cancelled_by_user",
            "cancelled_by_user".equals(
                RestReminderState.inspectIdentity(sB.state, "rest-A", genA1, true)));

        System.out.println();
        System.out.println("RestUserCancelReconcileTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestUserCancelReconcileTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestUserCancelReconcileTest 全部通过");
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
