package app.motion.personal.plugins;

/**
 * B4-R3 F2/O3：**commit 失败 ≠ 内存回滚**（Codex ANDROID-COMMIT-BOUNDARY-NOTE）。
 *
 * <h2>真实平台模型</h2>
 * Android {@code SharedPreferencesImpl.EditorImpl.commit()}：
 * ① {@code commitToMemory()} 先把新值写进 mMap；② 再 enqueue/await 磁盘写；
 * ③ 返回 {@code writeToDiskResult}。写盘失败**不回滚内存**。
 * 因此旧宿主替身「failCommitWhenKeys 命中时先 return false、不改内存」
 * **不是**真实边界的充分模型。
 *
 * <h2>本文件锁住的三件事</h2>
 * <ol>
 *   <li>MemoryFirstFailure：写盘持续失败，但内存已被改成候选值 →
 *       {@link RestDurableView} 读回的是**磁盘真实值**，不是失败候选；</li>
 *   <li>恢复：故障解除后写入成功，视图前进到新值（可重试）；</li>
 *   <li>补偿：补偿写盘本身失败时如实返回 false，绝不伪称已持久化。</li>
 * </ol>
 * 同样覆盖 enabled 布尔视图（O3 第一段写入）。
 */
public final class RestR3DurableTest {

    private static int pass = 0;
    private static int fail = 0;

    /** 真实 Android 语义的替身：内存先改，磁盘写失败不回滚内存 */
    static final class MemoryFirstPrefs {
        RestReminderState.Snapshot memory;
        RestReminderState.Snapshot disk;
        boolean diskFail = false;
        int commits = 0;
        int failures = 0;

        MemoryFirstPrefs(RestReminderState.Snapshot init) {
            this.memory = init;
            this.disk = init;
        }

        /** 模拟 Editor.commit()：先 commitToMemory，再写盘 */
        boolean commit(RestReminderState.Snapshot candidate) {
            commits += 1;
            memory = candidate;          // ① commitToMemory：内存立刻变
            if (diskFail) {              // ②③ 写盘失败 → 返回 false，但内存没回滚
                failures += 1;
                return false;
            }
            disk = candidate;
            return true;
        }

        RestReminderState.Snapshot loadFromDisk() {
            return disk;
        }
    }

    public static void main(String[] args) {
        failedCommitKeepsDurableTruth();
        persistentFailureNeverLeaksCandidate();
        recoveryAfterFaultClears();
        compensationFailureIsHonest();
        enabledFlagSameBoundary();
        oldEnabledMustBeCapturedBeforeAnyWrite();
        diagIsolationNote();

        System.out.println("\nRestR3DurableTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) System.exit(1);
    }

    /** 单次 commit 失败 → 视图停在磁盘真值，不跟随失败候选 */
    private static void failedCommitKeepsDurableTruth() {
        RestReminderState.Snapshot good =
            new RestReminderState.Snapshot("good-A", 5L, false, 2, 20L);
        MemoryFirstPrefs prefs = new MemoryFirstPrefs(good);
        RestDurableView view = new RestDurableView();

        RestReminderState.Snapshot loaded = view.read(prefs::loadFromDisk);
        check("首次装载 = 磁盘真值", "good-A".equals(loaded.token));

        // 尝试取消（候选 token=null）
        RestReminderState.Snapshot candidate =
            RestReminderState.cancel(good).state;
        prefs.diskFail = true;
        boolean ok = view.write(candidate, prefs::commit);
        check("写盘失败如实返回 false", !ok);
        check("内存确实已被改成候选（真实 Android 语义）", prefs.memory.token == null);
        check("磁盘仍是旧身份", "good-A".equals(prefs.disk.token));

        // 关键断言：视图必须等于磁盘真值，而不是内存候选
        RestReminderState.Snapshot after = view.read(prefs::loadFromDisk);
        check("失败后视图 = 磁盘真值（未误认已取消）", "good-A".equals(after.token));
        check("失败后视图 generation = 旧值", after.generation == 5L);
        check("失败后视图 lastIntentId 保留", after.lastIntentId == 20L);
    }

    /** 持续失败多次：视图始终不前进 */
    private static void persistentFailureNeverLeaksCandidate() {
        RestReminderState.Snapshot good =
            new RestReminderState.Snapshot("good-A", 5L, false, 2, 20L);
        MemoryFirstPrefs prefs = new MemoryFirstPrefs(good);
        RestDurableView view = new RestDurableView();
        view.read(prefs::loadFromDisk);

        prefs.diskFail = true;
        for (int i = 0; i < 5; i++) {
            RestReminderState.Snapshot candidate =
                new RestReminderState.Snapshot(null, 6L + i, false, 0, 20L);
            view.write(candidate, prefs::commit);
        }
        check("持续失败：commit 尝试 5 次", prefs.commits == 5);
        check("持续失败：5 次都失败", prefs.failures == 5);
        RestReminderState.Snapshot after = view.read(prefs::loadFromDisk);
        check("持续失败：视图仍是 good-A", "good-A".equals(after.token));
        check("持续失败：generation 未前进", after.generation == 5L);

        // 用 getActive 语义读它：仍然 active
        check("持续失败：getActive 仍报 active",
            after.token != null && !after.fired);
    }

    /** 故障解除后重试成功 → 清理生效 */
    private static void recoveryAfterFaultClears() {
        RestReminderState.Snapshot good =
            new RestReminderState.Snapshot("good-A", 5L, false, 2, 20L);
        MemoryFirstPrefs prefs = new MemoryFirstPrefs(good);
        RestDurableView view = new RestDurableView();
        view.read(prefs::loadFromDisk);

        prefs.diskFail = true;
        RestReminderState.Snapshot cancelled = RestReminderState.cancel(good).state;
        check("故障中断言失败", !view.write(cancelled, prefs::commit));
        check("故障中未清理", view.read(prefs::loadFromDisk).token != null);

        // 故障解除 → 重试同一取消
        prefs.diskFail = false;
        boolean retried = view.write(cancelled, prefs::commit);
        check("解除故障后重试成功", retried);
        RestReminderState.Snapshot after = view.read(prefs::loadFromDisk);
        check("重试成功后身份已清", after.token == null);
        check("重试成功后磁盘一致", prefs.disk.token == null);
        check("重试成功后 generation 前进", after.generation == 6L);
    }

    /** 补偿写盘本身失败：如实 false，不伪称恢复 */
    private static void compensationFailureIsHonest() {
        RestReminderState.Snapshot good =
            new RestReminderState.Snapshot("good-A", 5L, false, 2, 20L);
        MemoryFirstPrefs prefs = new MemoryFirstPrefs(good);
        RestDurableView view = new RestDurableView();
        view.read(prefs::loadFromDisk);

        prefs.diskFail = true;
        RestReminderState.Snapshot candidate = RestReminderState.cancel(good).state;
        view.write(candidate, prefs::commit);
        RestReminderState.Snapshot confirmed = view.durable();

        // 补偿也失败
        boolean compensated = view.restore(confirmed, prefs::commit);
        check("补偿写盘失败 → false", !compensated);
        check("补偿失败后已确认值不变", "good-A".equals(view.durable().token));

        // 故障解除 → 补偿成功
        prefs.diskFail = false;
        boolean compensated2 = view.restore(view.durable(), prefs::commit);
        check("故障解除后补偿成功", compensated2);
        check("补偿成功后磁盘回到已确认值", "good-A".equals(prefs.disk.token));
    }

    /** enabled 布尔视图同样边界：失败候选不得被 getter 当成真值 */
    private static void enabledFlagSameBoundary() {
        final boolean[] memory = {true};
        final boolean[] disk = {true};
        final boolean[] fail = {true};
        RestDurableFlag flag = new RestDurableFlag();

        boolean initial = flag.read(() -> disk[0], true);
        check("enabled 首次装载 = true", initial);

        // 关闭：内存先改 false，写盘失败
        memory[0] = false;
        boolean ok = flag.write(false, v -> {
            memory[0] = v;
            if (fail[0]) return false;
            disk[0] = v;
            return true;
        });
        check("enabled 写盘失败 → false", !ok);
        check("enabled 内存已改（真实语义）", !memory[0]);
        check("enabled 磁盘仍 true", disk[0]);
        check("enabled getter 仍 true（不读失败候选）",
            flag.read(() -> disk[0], true));

        // 故障解除后重试
        fail[0] = false;
        boolean retried = flag.write(false, v -> {
            memory[0] = v;
            disk[0] = v;
            return true;
        });
        check("enabled 故障解除后重试成功", retried);
        check("enabled 重试后 getter = false", !flag.read(() -> disk[0], true));
        check("enabled 重试后磁盘 = false", !disk[0]);
    }

    /**
     * O3 修点①：补偿基线必须是**任何首次写入之前**的值。
     *
     * <h2>审源发现的具体反例</h2>
     * 旧写法在第一段 {@code enabledFlag.write(false)} **成功之后**才去读
     * "当前已确认值"来补偿 —— 那时它已经是 {@code false}，
     * 所谓"恢复"写回的仍是 false，关闭失败就变成真正无法回退的半提交。
     *
     * <p>正确做法：进入 {@code setReminderEnabled} 后**第一件事**就是读并保存
     * {@code oldEnabled}（同时完成冷装载），补偿显式写回 oldEnabled。
     */
    private static void oldEnabledMustBeCapturedBeforeAnyWrite() {
        // ── 反例：写成功后读数 → 补偿无效 ──────────────────────
        final boolean[] disk = {true};
        final boolean[] mem = {true};
        RestDurableFlag flag = new RestDurableFlag();
        flag.read(() -> disk[0], true);

        boolean first = flag.write(false, v -> { mem[0] = v; disk[0] = v; return true; });
        check("反例：第一段写 false 成功", first);
        boolean wrongBaseline = flag.read(() -> disk[0], true);
        check("反例：写成功后读到的值已是 false（不能当基线）", !wrongBaseline);
        flag.write(wrongBaseline, v -> { mem[0] = v; disk[0] = v; return true; });
        check("反例：用新值补偿 → 磁盘仍是 false（半提交未被修复）", !disk[0]);

        // ── 正确：写入前保存 oldEnabled ─────────────────────────
        final boolean[] disk2 = {true};
        final boolean[] mem2 = {true};
        RestDurableFlag f2 = new RestDurableFlag();
        boolean oldEnabled = f2.read(() -> disk2[0], true);
        check("正确：写入前读到 oldEnabled=true（冷装载磁盘真值）", oldEnabled);

        // 第一段 enabled=false 成功
        check("正确：第一段写 false 成功",
            f2.write(false, v -> { mem2[0] = v; disk2[0] = v; return true; }));
        check("正确：第一段后磁盘 false", !disk2[0]);

        // 第二段（identity cancel）失败 → 补偿写回 oldEnabled
        boolean compensated = f2.write(oldEnabled, v -> { mem2[0] = v; disk2[0] = v; return true; });
        check("正确：补偿写回 oldEnabled 成功", compensated);
        check("正确：磁盘真正回到 true（不再半提交）", disk2[0]);
        check("正确：getter 也回到 true", f2.read(() -> disk2[0], true));

        // ── 补偿本身持续失败：必须如实 false，不伪称恢复 ─────────
        final boolean[] disk3 = {true};
        final boolean[] mem3 = {true};
        final boolean[] fail = {false};
        RestDurableFlag f3 = new RestDurableFlag();
        boolean old3 = f3.read(() -> disk3[0], true);
        f3.write(false, v -> { mem3[0] = v; disk3[0] = v; return true; });
        fail[0] = true; // 第二段起持续失败
        boolean bad2 = f3.write(old3, v -> { mem3[0] = v; if (fail[0]) return false; disk3[0] = v; return true; });
        check("补偿持续失败 → 如实 false", !bad2);
        check("补偿持续失败 → 磁盘仍是 false（如实暴露半提交）", !disk3[0]);
        check("补偿持续失败 → 已确认值仍是 false（不伪称 true）",
            !f3.read(() -> disk3[0], true));

        // 故障解除后重试成功
        fail[0] = false;
        boolean ok3 = f3.write(old3, v -> { mem3[0] = v; disk3[0] = v; return true; });
        check("故障解除后补偿重试成功", ok3);
        check("故障解除后磁盘回到 oldEnabled=true", disk3[0]);
    }

    /**
     * 诊断旁路的隔离断言（结构性质，不需要 Android）。
     *
     * <p>{@code RestReminderStore.diag()} 必须写**独立 prefs 文件**：
     * 若与身份共用文件，一次 {@code apply()} 会把该文件当时的整张内存表
     * （含失败候选）序列化到磁盘，等于把失败身份偷偷落盘。
     *
     * <p>为什么用源码扫描而不是反射：{@code RestReminderStore} 依赖 Android
     * {@code Context}，不在纯 JVM 编译单元里。这里直接读**生产源码文本**，
     * 断言两个常量名存在且取值不同 —— 是结构事实，不是复制业务公式。
     */
    private static void diagIsolationNote() {
        String text = readStoreSource();
        if (text == null) {
            check("能读到 RestReminderStore.java（cwd=" +
                System.getProperty("user.dir") + "）", false);
            return;
        }
        String storePrefs = constantOf(text, "PREFS");
        String diagPrefs = constantOf(text, "PREFS_DIAG");
        check("身份 prefs 常量存在", storePrefs != null && !storePrefs.isEmpty());
        check("诊断 prefs 常量存在", diagPrefs != null && !diagPrefs.isEmpty());
        check("诊断与身份**不同**文件（旁路不可能回灌失败候选）",
            storePrefs != null && diagPrefs != null && !storePrefs.equals(diagPrefs));
        check("身份 prefs 仍是 motion_rest_reminder（迁移/兼容未变）",
            "motion_rest_reminder".equals(storePrefs));
        check("诊断写独立 diag 文件", diagPrefs != null && diagPrefs.endsWith("_diag"));
        check("diag 使用 diagPrefs（不走身份 prefs）",
            text.contains("diagPrefs(ctx)"));
        check("readDiag 使用 diagPrefs（读取侧同样隔离）",
            text.contains("RestDiagLog.parse(diagPrefs(ctx)"));
    }

    /**
     * 定位并读取 {@code RestReminderStore.java} 的源码文本。
     *
     * <p>测试可能从 app 目录、仓库根或 native-test 目录启动，
     * 因此按已知相对位置逐个尝试；都找不到才判失败（不静默跳过）。
     */
    private static String readStoreSource() {
        String rel = "android/app/src/main/java/app/motion/personal/plugins/RestReminderStore.java";
        java.nio.file.Path cwd = java.nio.file.Paths.get(System.getProperty("user.dir"));
        java.util.List<java.nio.file.Path> candidates = new java.util.ArrayList<>();
        candidates.add(cwd.resolve(rel));
        candidates.add(cwd.resolve("app").resolve(rel));
        candidates.add(cwd.resolve("..").resolve(rel));
        candidates.add(cwd.resolve("../..").resolve(rel));
        candidates.add(cwd.resolve("../../app").resolve(rel));
        for (java.nio.file.Path p : candidates) {
            try {
                if (java.nio.file.Files.isReadable(p)) {
                    return new String(java.nio.file.Files.readAllBytes(p),
                        java.nio.charset.StandardCharsets.UTF_8);
                }
            } catch (Exception ignored) {
                // 继续尝试下一个候选
            }
        }
        return null;
    }

    /** 从源码文本里抽取 {@code static final String NAME = "value";} 的 value */
    private static String constantOf(String text, String name) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
            "String\\s+" + name + "\\s*=\\s*\"([^\"]*)\"").matcher(text);
        return m.find() ? m.group(1) : null;
    }

    private static void check(String name, boolean ok) {
        if (ok) { pass++; System.out.println("  PASS " + name); }
        else { fail++; System.out.println("  FAIL " + name); }
    }
}
