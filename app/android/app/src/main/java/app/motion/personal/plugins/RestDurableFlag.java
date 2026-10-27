package app.motion.personal.plugins;

/**
 * 「**已确认落盘**」的布尔设置视图（纯 JVM，可离线测试）。
 *
 * <p>与 {@link RestDurableView} 同一个原因：Android 的
 * {@code SharedPreferences.Editor.commit()} 先把新值写进内存 mMap，
 * 再写盘；写盘失败只返回 false，**不会回滚内存**。
 * 因此「commit 返回 false，但紧接着 getBoolean() 读到新值」是真实可达的。
 *
 * <h2>影响</h2>
 * 提醒总开关（{@code motion_rest_reminder_prefs/reminderEnabled}）如果直接用
 * {@code getBoolean} 读「当前值」，持续写盘失败时会读回**未落盘的候选值**：
 * <ul>
 *   <li>关闭开关的写盘失败 → 读回 false → 界面/接口显示「已关闭」，
 *       实际磁盘仍是 true（重建后又会变回开）；</li>
 *   <li>投递期门禁也会因为读到 false 而静音，用户以为关了其实没关；
 *       或者反过来，用户以为开着却静默。</li>
 * </ul>
 *
 * <p>本类只暴露**最后一次确认写入成功**的值；失败候选不采纳。
 * 不改变存储位置、不引入第二套 enabled 真源。
 */
public final class RestDurableFlag {

    /** 从磁盘真实读值（进程首次访问时装载基线） */
    public interface Loader {
        Boolean load();
    }

    /** 真正写盘：返回 true 才代表已持久化 */
    public interface Writer {
        boolean write(boolean value);
    }

    private Boolean durable = null;
    private boolean loaded = false;

    /** 已确认落盘的值；未装载时返回 null */
    public synchronized Boolean confirmed() {
        return durable;
    }

    public synchronized boolean isLoaded() {
        return loaded;
    }

    /**
     * 读取**已确认落盘**的值。
     *
     * @param fallback 从未装载且 loader 返回 null 时使用的缺省值
     */
    public synchronized boolean read(Loader loader, boolean fallback) {
        if (!loaded) {
            Boolean v = null;
            try {
                v = loader == null ? null : loader.load();
            } catch (Exception e) {
                v = null;
            }
            durable = v == null ? Boolean.valueOf(fallback) : v;
            loaded = true;
        }
        return durable.booleanValue();
    }

    /** 尝试写入；只有真正写盘成功才更新已确认值 */
    public synchronized boolean write(boolean value, Writer writer) {
        boolean ok;
        try {
            ok = writer != null && writer.write(value);
        } catch (Exception e) {
            ok = false;
        }
        if (ok) {
            durable = Boolean.valueOf(value);
            loaded = true;
        }
        return ok;
    }

    /** 测试/诊断用：清空进程内视图（不碰磁盘） */
    public synchronized void forget() {
        durable = null;
        loaded = false;
    }
}
