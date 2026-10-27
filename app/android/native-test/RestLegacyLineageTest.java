package app.motion.personal.plugins;

/**
 * B4-R3 legacy-lineage 单项修复的原生测试。
 *
 * <p>覆盖范围：
 * <ol>
 *   <li>旧版本磁盘持久化了活跃 token "legacy-A" 和 lastIntentId=3，但缺少 lastIntentToken 键：
 *       首次 cancel 后进行同 A 的合法 -15（无编号）排程，意图水位 3 必须完好保留，
 *       后续旧意图编号 2 重放必须如实以 stale-intent 拒绝，新意图 4 以及新 token B 正常接受；</li>
 *   <li>旧版本磁盘本身 token=null 且归属缺省：不得凭空捏造归属，新 token 到来时不套用旧水位；</li>
 *   <li>旧构造器（4 参 / 5 参）向后兼容归属正规化；</li>
 *   <li>单点正规化不变量：仅在 active token 存在且归属未指定时正规化，显式归属不被覆盖；</li>
 *   <li>持久化门禁：读取旧 schema 时只在内存构建正规化 Snapshot，绝不触发写盘；
 *       写盘故障时确认视图与真实失败保持一致，解除故障后方可成功写入。</li>
 * </ol>
 */
public final class RestLegacyLineageTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        testLegacyActiveTokenWatermarkPreserved();
        testLegacyInactiveTokenNoFabrication();
        testLegacyConstructorsCompatibility();
        testSingleNormalizationPointInvariants();
        testDurableGateAndNoWriteOnRead();

        System.out.println("\nRestLegacyLineageTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /**
     * 1. 旧 schema 存在活跃 token 但无 lastIntentToken 字段：
     * 精确取消 -> 合法减时（-15）-> 水位 3 完好保留，旧意图 2 拒绝，新意图 4 / 新 token 正常。
     */
    private static void testLegacyActiveTokenWatermarkPreserved() {
        // 模拟从缺少 lastIntentToken 的旧磁盘加载进来的活跃 Snapshot
        RestReminderState.Snapshot oldDisk = new RestReminderState.Snapshot(
            "legacy-A", 4L, false, 1, 3L, null
        );
        check("旧 schema 活跃 token 归属自动补齐为自身 token",
            "legacy-A".equals(oldDisk.lastIntentToken));
        check("旧 schema 水位正确读取为 3", oldDisk.lastIntentId == 3L);

        // 精确取消
        RestReminderState.Outcome cancel = RestReminderState.cancelIfCurrent(
            oldDisk, "legacy-A", 4L, true
        );
        check("精确取消成功", cancel.action == RestReminderState.Outcome.Action.CANCEL);
        check("取消后 token 变 null", cancel.state.token == null);
        check("取消后 generation 前进", cancel.state.generation == 5L);
        check("取消后水位保留 3", cancel.state.lastIntentId == 3L);
        check("取消后水位归属 token 完整传承为 legacy-A",
            "legacy-A".equals(cancel.state.lastIntentToken));

        // 同一 token 的合法 -15（无编号，intentId=0）
        RestReminderState.Outcome minus = RestReminderState.startWithIntent(
            cancel.state, "legacy-A", 45000L, 0L
        );
        check("-15 减时被成功接受", minus.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("-15 减时后 token 恢复为 legacy-A", "legacy-A".equals(minus.state.token));
        check("-15 减时后 generation 前进", minus.state.generation == 6L);
        check("-15 减时后水位完好保留 3（不被清零）", minus.state.lastIntentId == 3L);
        check("-15 减时后水位归属仍为 legacy-A", "legacy-A".equals(minus.state.lastIntentToken));

        // 旧正编号 2 重放：必须被 stale-intent 拒绝
        RestReminderState.Outcome replay = RestReminderState.startWithIntent(
            minus.state, "legacy-A", 15000L, 2L
        );
        check("旧编号 2 重放判定为 stale-intent", "stale-intent".equals(replay.reason));
        check("旧编号 2 重放动作为 NOOP", replay.action == RestReminderState.Outcome.Action.NOOP);
        check("旧编号 2 重放后水位保持 3", replay.state.lastIntentId == 3L);
        check("旧编号 2 重放后代次不动", replay.state.generation == 6L);

        // 新意图编号 4：必须被正常接受，水位前进
        RestReminderState.Outcome newer = RestReminderState.startWithIntent(
            minus.state, "legacy-A", 60000L, 4L
        );
        check("新意图编号 4 被接受", newer.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新意图编号 4 推进水位至 4", newer.state.lastIntentId == 4L);
        check("新意图编号 4 代次推进至 7", newer.state.generation == 7L);

        // 真正不同的新 token B，编号从 1 开始
        RestReminderState.Outcome newB = RestReminderState.startWithIntent(
            newer.state, "new-B", 15000L, 1L
        );
        check("新 token B 编号 1 被接受", newB.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token B 编号起算为 1", newB.state.lastIntentId == 1L);
        check("新 token B 归属切换为 new-B", "new-B".equals(newB.state.lastIntentToken));

        // 新 token B 后续 +15（编号 2）继续合法
        RestReminderState.Outcome plusB = RestReminderState.startWithIntent(
            newB.state, "new-B", 30000L, 2L
        );
        check("新 token B 编号 2 被接受", plusB.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token B 水位前进至 2", plusB.state.lastIntentId == 2L);
    }

    /**
     * 2. 旧 schema 本身 token=null 且归属缺省：
     * 绝不凭空捏造归属，不把历史旧水位套用到全新的 token 上。
     */
    private static void testLegacyInactiveTokenNoFabrication() {
        // 旧 schema 磁盘上处于取消态（无活跃 token，亦无 lastIntentToken 字段）
        RestReminderState.Snapshot oldInactive = new RestReminderState.Snapshot(
            null, 4L, false, 1, 3L, null
        );
        check("无活跃 token 且缺省归属时，归属保持 null（不捏造）",
            oldInactive.lastIntentToken == null);
        check("旧 inactive 水位数值读取为 3", oldInactive.lastIntentId == 3L);

        // 新 token X（无编号）到达：不应被当成 sameLineage
        RestReminderState.Outcome startX = RestReminderState.startWithIntent(
            oldInactive, "token-X", 30000L, 0L
        );
        check("新 token X 启动成功", startX.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token X 未继承旧水位 3（按新 token 起算为 0）", startX.state.lastIntentId == 0L);
        check("新 token X 归属正规化为 token-X", "token-X".equals(startX.state.lastIntentToken));

        // 另一个新 token Y（带编号 1）到达：起算为 1，不被旧水位 3 误挡
        RestReminderState.Outcome startY = RestReminderState.startWithIntent(
            oldInactive, "token-Y", 30000L, 1L
        );
        check("新 token Y 启动成功", startY.action == RestReminderState.Outcome.Action.SCHEDULE);
        check("新 token Y 编号为 1（未被旧水位 3 判定为 stale-intent）", startY.state.lastIntentId == 1L);
        check("新 token Y 归属正规化为 token-Y", "token-Y".equals(startY.state.lastIntentToken));
    }

    /**
     * 3. 旧构造器（4 参 / 5 参）向后兼容性验证。
     */
    private static void testLegacyConstructorsCompatibility() {
        RestReminderState.Snapshot s4 = new RestReminderState.Snapshot("compat-A", 1L, false, 1);
        check("4 参构造器正规化活跃 token 归属", "compat-A".equals(s4.lastIntentToken));
        check("4 参构造器默认水位为 0", s4.lastIntentId == 0L);

        RestReminderState.Snapshot s4Null = new RestReminderState.Snapshot(null, 1L, false, 1);
        check("4 参构造器 null token 归属为 null", s4Null.lastIntentToken == null);

        RestReminderState.Snapshot s5 = new RestReminderState.Snapshot("compat-B", 2L, false, 2, 7L);
        check("5 参构造器正规化活跃 token 归属", "compat-B".equals(s5.lastIntentToken));
        check("5 参构造器保留水位 7", s5.lastIntentId == 7L);

        RestReminderState.Snapshot s5Null = new RestReminderState.Snapshot(null, 2L, false, 2, 7L);
        check("5 参构造器 null token 归属为 null", s5Null.lastIntentToken == null);

        RestReminderState.Snapshot empty = RestReminderState.Snapshot.empty();
        check("empty() 实例归属为 null", empty.lastIntentToken == null);
        check("empty() 实例 token 为 null", empty.token == null);
        check("empty() 实例水位为 0", empty.lastIntentId == 0L);
    }

    /**
     * 4. 单点正规化不变量核验：
     * 仅当 lastIntentToken 为 null 时才回退到 token；
     * 若显式传入了非空 lastIntentToken，绝不被 token 覆盖。
     */
    private static void testSingleNormalizationPointInvariants() {
        RestReminderState.Snapshot explicit = new RestReminderState.Snapshot(
            "active-token", 1L, false, 1, 5L, "custom-lineage"
        );
        check("显式指定的 lastIntentToken 优先级高于 token",
            "custom-lineage".equals(explicit.lastIntentToken));
        check("active-token 仍然保持在 token 字段",
            "active-token".equals(explicit.token));

        RestReminderState.Snapshot explicitNullToken = new RestReminderState.Snapshot(
            null, 1L, false, 1, 5L, "inherited-lineage"
        );
        check("token 为 null 时显式 lineage 正常保留",
            "inherited-lineage".equals(explicitNullToken.lastIntentToken));
    }

    /**
     * 5. 持久化门禁与读取行为：
     * 读取旧 schema 时内存构建正规化 Snapshot，但不触发写盘；
     * 写盘失败时确认视图不被污染。
     */
    private static void testDurableGateAndNoWriteOnRead() {
        RestDurableView view = new RestDurableView();

        // 模拟读取旧磁盘（无 lastIntentToken）
        RestReminderState.Snapshot readSnap = view.read(() ->
            new RestReminderState.Snapshot("stored-A", 10L, false, 1, 5L, null)
        );
        check("读取旧 schema 时内存 Snapshot 归属已补齐",
            "stored-A".equals(readSnap.lastIntentToken));
        check("此时 confirmed durable 视图与读入值一致",
            view.durable() != null && "stored-A".equals(view.durable().lastIntentToken));

        // 模拟写盘失败的场景
        RestReminderState.Snapshot badCandidate = new RestReminderState.Snapshot(
            null, 11L, false, 1, 5L, "stored-A"
        );
        boolean writeFailed = view.write(badCandidate, cand -> false);
        check("写盘失败时 write 返回 false", !writeFailed);
        check("写盘失败后 confirmed 视图未被改成失败候选",
            "stored-A".equals(view.durable().token));
        check("写盘失败后 generation 仍为旧值",
            view.durable().generation == 10L);

        // 模拟写盘成功恢复
        boolean writeSucceeded = view.write(badCandidate, cand -> true);
        check("写盘成功时 write 返回 true", writeSucceeded);
        check("写盘成功后 confirmed 视图更新",
            view.durable().token == null && view.durable().generation == 11L);
        check("写盘成功后 confirmed 视图 lineage 保留",
            "stored-A".equals(view.durable().lastIntentToken));
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  PASS " + name);
        } else {
            fail++;
            System.out.println("  FAIL " + name);
        }
    }
}
