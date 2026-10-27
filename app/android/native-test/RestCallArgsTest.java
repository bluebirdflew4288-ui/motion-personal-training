package app.motion.personal.plugins;

/**
 * REVIEW-1 #1 的定向测试：**参数转换层**的布尔方向。
 *
 * <p>缺陷：插件把 {@code cancelIfCurrent(..., !withIdentity)} 接反 →
 * 无参 stop/finish 被 empty-token 拒绝；带陈旧身份反而全清当前提醒。
 * 这类错误只断言 {@link RestReminderState} 发现不了，必须测**转换层**。
 *
 * <p>本测试覆盖真实 JSON 可能的形态（Integer/Double/String/缺失），
 * 并用转换结果驱动真实 State 迁移，验证端到端方向正确。
 */
public final class RestCallArgsTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        // ── 无身份：两个参数都缺失 ─────────────────────────────
        RestCallArgs.Identity none = RestCallArgs.parse(null, null);
        check("无参：hasIdentity=false", !none.hasIdentity);
        check("无参：token 为 null", none.token == null);
        check("无参：generation 为 NO_GENERATION",
            none.generation == RestCallArgs.Identity.NO_GENERATION);

        // ── 完整身份（JS 传 Integer 是常见情况）────────────────
        RestCallArgs.Identity full = RestCallArgs.parse("rest-A", Integer.valueOf(7));
        check("完整身份：hasIdentity=true", full.hasIdentity);
        check("完整身份：token 正确", "rest-A".equals(full.token));
        check("完整身份：generation=7", full.generation == 7L);

        // ── 只有 token（无 generation）→ 不构成身份 ────────────
        RestCallArgs.Identity tokenOnly = RestCallArgs.parse("rest-A", null);
        check("只有 token：hasIdentity=false", !tokenOnly.hasIdentity);

        // ── 只有 generation（无 token）→ 不构成身份 ────────────
        RestCallArgs.Identity genOnly = RestCallArgs.parse(null, Integer.valueOf(7));
        check("只有 generation：hasIdentity=false", !genOnly.hasIdentity);

        // ── 空 token → 不构成身份 ──────────────────────────────
        check("空 token：hasIdentity=false", !RestCallArgs.parse("", Integer.valueOf(7)).hasIdentity);
        check("空 token 带空格：hasIdentity=false",
            !RestCallArgs.parse("   ", Integer.valueOf(7)).hasIdentity);

        // ── generation 的各种真实形态 ──────────────────────────
        check("generation 字符串可解析", RestCallArgs.parseGeneration("12") != null
            && RestCallArgs.parseGeneration("12") == 12L);
        check("generation 带空格字符串", RestCallArgs.parseGeneration(" 12 ") == 12L);
        check("generation Double 整数", RestCallArgs.parseGeneration(Double.valueOf(5d)) == 5L);
        check("generation Long", RestCallArgs.parseGeneration(Long.valueOf(9L)) == 9L);
        check("generation 非数字串 → null", RestCallArgs.parseGeneration("abc") == null);
        check("generation 小数 → null", RestCallArgs.parseGeneration(Double.valueOf(1.5)) == null);
        check("generation NaN → null", RestCallArgs.parseGeneration(Double.valueOf(Double.NaN)) == null);
        check("generation 布尔 → null", RestCallArgs.parseGeneration(Boolean.TRUE) == null);

        // ── 端到端：转换结果驱动 State（验证布尔方向）──────────
        RestReminderState.Snapshot active =
            new RestReminderState.Snapshot("rest-B", 9L, false, 2);

        // ① 无身份取消（stop/finish）必须**真的取消**当前提醒
        RestCallArgs.Identity stopId = RestCallArgs.parse(null, null);
        RestReminderState.Outcome stopOutcome = RestReminderState.cancelIfCurrent(
            active, stopId.token, stopId.generation, stopId.hasIdentity);
        check("无参 stop：真正取消当前提醒",
            stopOutcome.action == RestReminderState.Outcome.Action.CANCEL);
        check("无参 stop：token 清空", stopOutcome.state.token == null);

        // ② 带完整身份且匹配 → 取消
        RestCallArgs.Identity matchId = RestCallArgs.parse("rest-B", Integer.valueOf(9));
        RestReminderState.Outcome matchOutcome = RestReminderState.cancelIfCurrent(
            active, matchId.token, matchId.generation, matchId.hasIdentity);
        check("匹配身份：取消", matchOutcome.action == RestReminderState.Outcome.Action.CANCEL);

        // ③ 带陈旧身份 → 绝不取消当前提醒
        RestCallArgs.Identity staleId = RestCallArgs.parse("rest-A", Integer.valueOf(3));
        RestReminderState.Outcome staleOutcome = RestReminderState.cancelIfCurrent(
            active, staleId.token, staleId.generation, staleId.hasIdentity);
        check("陈旧身份：不取消", staleOutcome.action == RestReminderState.Outcome.Action.NOOP);
        check("陈旧身份：当前提醒保留", "rest-B".equals(staleOutcome.state.token));
        check("陈旧身份原因 stale-token", "stale-token".equals(staleOutcome.reason));

        // ④ 同 token 但旧代次 → 不取消
        RestCallArgs.Identity oldGenId = RestCallArgs.parse("rest-B", Integer.valueOf(8));
        RestReminderState.Outcome oldGenOutcome = RestReminderState.cancelIfCurrent(
            active, oldGenId.token, oldGenId.generation, oldGenId.hasIdentity);
        check("同 token 旧代次：不取消",
            oldGenOutcome.action == RestReminderState.Outcome.Action.NOOP);
        check("同 token 旧代次原因 stale-generation",
            "stale-generation".equals(oldGenOutcome.reason));

        System.out.println();
        System.out.println("RestCallArgsTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ RestCallArgsTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ RestCallArgsTest 全部通过");
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
