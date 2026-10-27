package app.motion.personal.plugins;

/**
 * 「**已确认落盘**」身份的进程内视图（纯 JVM，可离线测试）。
 *
 * <h2>要解决的真实平台边界（B4-R3 / Codex ANDROID-COMMIT-BOUNDARY-NOTE）</h2>
 * Android 官方文档 *Durability and Consistency* 段与 AOSP
 * {@code SharedPreferencesImpl.EditorImpl.commit()} 的实现都说明：
 * <ol>
 *   <li>先 {@code commitToMemory()}：<b>内存里的 mMap 已经被改成候选值</b>；</li>
 *   <li>再 {@code enqueueDiskWrite} / {@code await writtenToDiskLatch}；</li>
 *   <li>最终 {@code return mcr.writeToDiskResult} —— <b>false 只表示写盘失败，
 *       不表示内存回滚</b>。</li>
 * </ol>
 *
 * <p>因此「{@code commit()==false} 之后仍然 {@code getSharedPreferences().getXxx()}
 * 读回候选值」是真实可达的现象。旧实现（以及旧宿主替身「失败前不改内存」的故障模型）
 * 都覆盖不到这条边界，于是会出现：
 * <ul>
 *   <li>取消的 commit 失败，但 {@code getActive()} 从内存读回「token=null」，
 *       UI/上层误认「durable 已取消」，实际磁盘上仍是旧身份；</li>
 *   <li>关闭开关的第二段 commit 失败，但 getter 从内存读回 false，
 *       造成「半关闭假成功」。</li>
 * </ul>
 *
 * <h2>本类的语义</h2>
 * 只保存**最后一次确认成功落盘**的快照；候选值只有在 {@code write()} 返回 true
 * 之后才会被采纳。读路径（排程/取消/取消补偿/状态查询）一律走这里，
 * 于是「写盘持续失败期间」系统看到的是**磁盘真实值**，而不是失败候选。
 *
 * <p><b>不夸大</b>：这不是跨 prefs 事务，也不改变 SharedPreferences 的物理行为；
 * 它只保证本进程的判定不会把「失败候选」当成「已持久化事实」。
 */
public final class RestDurableView {

    /** 读取磁盘真实值（进程首次访问时用于装载基线） */
    public interface Loader {
        RestReminderState.Snapshot load();
    }

    /** 真正的写盘出口：返回 true 才代表已持久化 */
    public interface Writer {
        boolean write(RestReminderState.Snapshot candidate);
    }

    private RestReminderState.Snapshot durable = RestReminderState.Snapshot.empty();
    private boolean loaded = false;

    /** 是否已经从磁盘装载过基线 */
    public synchronized boolean isLoaded() {
        return loaded;
    }

    /** 已确认落盘的快照（未装载时返回空快照，调用方应先 {@link #read}） */
    public synchronized RestReminderState.Snapshot durable() {
        return durable;
    }

    /**
     * 读取**已确认落盘**的身份。
     *
     * <p>首次访问时调用 {@code loader} 装载磁盘基线（此时内存=磁盘，读它是真值）；
     * 之后一律返回最后一次写入成功的值 —— 即使中途有失败的候选改了内存视图。
     */
    public synchronized RestReminderState.Snapshot read(Loader loader) {
        if (!loaded) {
            durable = loader == null ? RestReminderState.Snapshot.empty() : loader.load();
            if (durable == null) durable = RestReminderState.Snapshot.empty();
            loaded = true;
        }
        return durable;
    }

    /**
     * 尝试写入候选身份。
     *
     * @return 真实写盘结果；**只有 true 才会更新已确认视图**
     */
    public synchronized boolean write(RestReminderState.Snapshot candidate, Writer writer) {
        boolean ok;
        try {
            ok = writer != null && writer.write(candidate);
        } catch (Exception e) {
            ok = false;
        }
        if (ok && candidate != null) {
            durable = candidate;
            loaded = true;
        }
        return ok;
    }

    /**
     * 写盘失败后的**补偿**：把已确认值重新写回磁盘。
     *
     * <p>用于 O3 的两段写入（先 enabled=false、再 identity cancel）失败场景：
     * 补偿本身也可能持续失败，此时**不得**伪称持久化成功，返回值如实为 false，
     * 已确认视图保持最后一次成功值。
     */
    public synchronized boolean restore(RestReminderState.Snapshot confirmed, Writer writer) {
        if (confirmed == null) return false;
        boolean ok;
        try {
            ok = writer != null && writer.write(confirmed);
        } catch (Exception e) {
            ok = false;
        }
        if (ok) {
            durable = confirmed;
            loaded = true;
        }
        return ok;
    }

    /** 测试/诊断用：清空进程内视图（不碰磁盘） */
    public synchronized void forget() {
        durable = RestReminderState.Snapshot.empty();
        loaded = false;
    }
}
