import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 1) 增加相位常量
rep('phase constants',
`    /** 当前在飞行的操作类型（OP_NONE / OP_EXPORT / OP_IMPORT） */
    private volatile String pendingOp = OP_NONE;`,
`    /** 当前在飞行的操作类型（OP_NONE / OP_EXPORT / OP_IMPORT） */
    private volatile String pendingOp = OP_NONE;

    /**
     * 操作相位。区分「还在等用户选位置」与「已经拿到 URI、正在写文件」：
     *
     * <p>Capacitor 8.5.3 的 {@code Bridge.onActivityResult} 里，
     * {@code pluginCallForLastActivity} 的清除发生在 {@code handleOnActivityResult} <b>之后</b>
     * （见 Bridge.java 第 1303 行附近）。因此回调已经开始后台写入、但尚未结束时，
     * Activity 若重建，saved-state 里仍会带上「有 pending 操作」。
     *
     * <p>两种相位恢复语义完全不同：
     * <ul>
     *   <li>{@code PHASE_WAITING}：等用户选位置。重建后原 promise 已消失，
     *       结果不会再回到它 → 恢复为「未完成、可重试」，不能永久 busy。</li>
     *   <li>{@code PHASE_WRITING}：写入线程属于旧实例。新实例无法接管那个线程，
     *       也不应假装它成功 → 同样恢复为「未完成、可重试」，并明确提示。</li>
     * </ul>
     * 两种都不把 busy 原样继承，因此新实例永远不会永久 busy。
     */
    private static final String PHASE_NONE = "";
    private static final String PHASE_WAITING = "waiting";
    private static final String PHASE_WRITING = "writing";

    private volatile String pendingPhase = PHASE_NONE;`);

// 2) saveInstanceState 记录相位
rep('save phase',
`        ret.putString("motionPendingOp", pendingOp);
        String t = pendingToken;
        if (t != null) ret.putString("motionPendingToken", t);
        return ret;`,
`        ret.putString("motionPendingOp", pendingOp);
        ret.putString("motionPendingPhase", pendingPhase);
        String t = pendingToken;
        if (t != null) ret.putString("motionPendingToken", t);
        return ret;`);

// 3) restoreState：不继承 busy，改为标记可重试
rep('restore does not inherit busy',
`    protected void restoreState(Bundle state) {
        if (state == null) return;
        String op = state.getString("motionPendingOp");
        if (op != null) pendingOp = op;
        String t = state.getString("motionPendingToken");
        if (t != null) {
            pendingToken = t;
            // 恢复出来的 token 是明确待恢复的，标记它以免被清理误删
            spool().markPending(t);
        }
    }`,
`    /**
     * 恢复时<b>不继承 busy</b>。
     *
     * <p>旧实例的 writer 线程/原 JS promise 都随实例消失，新实例无法接管。
     * 因此这里只记录「上次有个未完成的导出，token=X」，把相位标为可重试，
     * 并把 token 标记为待恢复（避免清理误删），然后<b>立即释放门禁</b>。
     * 这样新实例可以重新发起导出，不会永久 busy。
     */
    protected void restoreState(Bundle state) {
        if (state == null) return;
        String op = state.getString("motionPendingOp");
        String phase = state.getString("motionPendingPhase");
        String t = state.getString("motionPendingToken");

        if (t != null && ExportSpool.isValidToken(t)) {
            // 保留 token 让清理跳过它；但不再占用门禁
            spool().markPending(t);
            restoredUnfinishedToken = t;
            restoredUnfinishedPhase = phase == null ? PHASE_NONE : phase;
        }
        // 关键：不把 pendingOp 恢复成 export/import —— 旧实例的操作已无法继续
        if (op != null && !OP_NONE.equals(op)) {
            restoredUnfinished = true;
        }
        pendingOp = OP_NONE;
        pendingPhase = PHASE_NONE;
        pendingToken = null;
    }

    /** 上次实例遗留了未完成操作（供上层提示/诊断） */
    private volatile boolean restoredUnfinished = false;
    private volatile String restoredUnfinishedToken = null;
    private volatile String restoredUnfinishedPhase = PHASE_NONE;

    /**
     * 取走「上次未完成」的状态（一次性）。
     *
     * <p>JS 侧可在启动后调用 {@code consumeRestoredExport()} 得知需要提示
     * 「上次导出未完成，请重试」；返回后本标记清空，不会重复提示。
     */
    @PluginMethod
    public void consumeRestoredExport(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("unfinished", restoredUnfinished || restoredUnfinishedToken != null);
        ret.put("phase", restoredUnfinishedPhase == null ? PHASE_NONE : restoredUnfinishedPhase);
        ret.put("hasToken", restoredUnfinishedToken != null);
        restoredUnfinished = false;
        restoredUnfinishedToken = null;
        restoredUnfinishedPhase = PHASE_NONE;
        call.resolve(ret);
    }`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
