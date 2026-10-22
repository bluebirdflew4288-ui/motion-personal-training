import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 核心语义修正：WAITING 恢复门禁与归属；只有 WRITING 算中断
rep('restoreState correct semantics',
`    protected void restoreState(Bundle state) {
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
    }`,
`    /**
     * 恢复 saved-state。
     *
     * <p><b>语义分两种，不能一刀切</b>：
     *
     * <ul>
     *   <li><b>WAITING（等用户选位置）</b>：原 JS promise 消失 <b>不等于</b>系统操作无法继续。
     *       Capacitor 的 Bridge 会用顶层小 options 重建一个 dangling PluginCall，
     *       用户选完后系统结果仍会送到<b>新实例</b>的回调，再由 Capacitor 以
     *       {@code appRestoredResult} 交付。因此这里必须<b>恢复门禁与归属</b>
     *       （pendingOp / pendingToken），继续等原来的 SAF。
     *       若此时放开，新发起的 import 会覆盖 {@code lastPluginCallId}，
     *       旧 export 回调会拿到新 call 并误释放新 operation。</li>
     *   <li><b>WRITING（已拿到 URI、旧实例正在写）</b>：writer 线程随旧实例消失，
     *       新实例无法接管 → 按<b>明确中断</b>处理：释放门禁、标记可重试，
     *       绝不让新实例永久 busy。</li>
     * </ul>
     */
    protected void restoreState(Bundle state) {
        if (state == null) return;
        String op = state.getString("motionPendingOp");
        String phase = state.getString("motionPendingPhase");
        String t = state.getString("motionPendingToken");

        boolean hasOp = op != null && !OP_NONE.equals(op);
        boolean waiting = PHASE_WAITING.equals(phase);
        boolean writing = PHASE_WRITING.equals(phase);

        if (hasOp && waiting) {
            // 等待期：原样恢复门禁与归属，继续等系统结果
            pendingOp = op;
            pendingPhase = PHASE_WAITING;
            if (t != null && ExportSpool.isValidToken(t)) {
                pendingToken = t;
                // 明确待恢复：清理必须跳过它
                spool().markPending(t);
            }
            // 记录「恢复中」，供 consume 提示，但不清归属
            restoredWaiting = true;
            return;
        }

        if (hasOp && writing) {
            // 写入期：writer 已随旧实例消失 → 明确中断，可重试
            restoredInterrupted = true;
            restoredInterruptedToken = (t != null && ExportSpool.isValidToken(t)) ? t : null;
            if (restoredInterruptedToken != null) {
                // 保留文件以免误删（用户可重试/诊断），但不再占用门禁
                spool().markPending(restoredInterruptedToken);
            }
            pendingOp = OP_NONE;
            pendingPhase = PHASE_NONE;
            pendingToken = null;
            return;
        }

        // 没有可恢复的操作：保持干净
        pendingOp = OP_NONE;
        pendingPhase = PHASE_NONE;
        pendingToken = null;
    }`);

// 替换 consumeRestoredExport 为不清归属的版本
rep('consumeRestoredExport',
`    public void consumeRestoredExport(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("unfinished", restoredUnfinished || restoredUnfinishedToken != null);
        ret.put("phase", restoredUnfinishedPhase == null ? PHASE_NONE : restoredUnfinishedPhase);
        ret.put("hasToken", restoredUnfinishedToken != null);
        restoredUnfinished = false;
        restoredUnfinishedToken = null;
        restoredUnfinishedPhase = PHASE_NONE;
        call.resolve(ret);
    }`,
`    public void consumeRestoredExport(PluginCall call) {
        JSObject ret = new JSObject();
        // 写入期被中断（明确失败，可重试）
        ret.put("interrupted", restoredInterrupted);
        ret.put("phase", restoredInterrupted ? PHASE_WRITING : (restoredWaiting ? PHASE_WAITING : PHASE_NONE));
        // 仍在等待系统结果：门禁与归属**不清**，JS 侧应继续等，不要提示失败
        ret.put("stillWaiting", restoredWaiting && !OP_NONE.equals(pendingOp));
        ret.put("busy", !OP_NONE.equals(pendingOp));
        restoredInterrupted = false;
        restoredInterruptedToken = null;
        // 注意：restoredWaiting 只用于提示，不清 pendingOp / pendingToken
        call.resolve(ret);
    }`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
