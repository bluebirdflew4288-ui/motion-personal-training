import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 1) 替换旧的 restoredUnfinished 字段组为新语义字段
rep('restore flags',
`    /** 上次实例遗留了未完成操作（供上层提示/诊断） */
    private volatile boolean restoredUnfinished = false;
    private volatile String restoredUnfinishedToken = null;
    private volatile String restoredUnfinishedPhase = PHASE_NONE;`,
`    /** 恢复时仍在等待系统结果（门禁与归属已恢复，不清） */
    private volatile boolean restoredWaiting = false;

    /** 恢复时发现写入期被中断（writer 随旧实例消失，可重试） */
    private volatile boolean restoredInterrupted = false;
    private volatile String restoredInterruptedToken = null;

    /**
     * 当前操作的请求标识（用于回调归属校验）。
     *
     * <p>每次发起 export/import 生成一个新的 requestId 并写进 options；
     * 回调里比对 {@code call} 携带的 requestId 与当前 pendingRequestId：
     * <ul>
     *   <li>一致 → 是本请求的结果，正常处理并按匹配释放</li>
     *   <li>不一致（迟到 / 异属回调）→ <b>不处理、不解锁、不删别的任务</b></li>
     * </ul>
     * 这样即便 Capacitor 因 {@code lastPluginCallId} 复用而把结果投递给错误的 call，
     * 也不会误释放另一个任务的门禁或删掉它的暂存文件。
     */
    private volatile String pendingRequestId = null;`);

// 2) 发起 export 时生成 requestId
rep('export requestId',
`        // 统一门禁：export / import 单飞（见 pendingOp 注释）
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
            pendingPhase = PHASE_WAITING;   // 还在等用户选位置
        }`,
`        // 统一门禁：export / import 单飞（见 pendingOp 注释）
        final String requestId = newRequestId();
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
            pendingPhase = PHASE_WAITING;   // 还在等用户选位置
            pendingRequestId = requestId;
        }`);

// 3) requestId 写进 options（小字符串，可进 Bundle）
rep('export options requestId',
`        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        // 记录 pending token（供 saved-state 与清理判断归属）
        pendingToken = token;
        spool().markPending(token);`,
`        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        call.getData().put(OPT_REQUEST_ID, requestId);
        // 记录 pending token（供 saved-state 与清理判断归属）
        pendingToken = token;
        spool().markPending(token);`);

// 4) OPT_REQUEST_ID 常量
rep('OPT_REQUEST_ID constant',
`    /** 原始建议文件名（小字符串，可安全进 Bundle） */
    static final String OPT_FILENAME = "filename";`,
`    /** 原始建议文件名（小字符串，可安全进 Bundle） */
    static final String OPT_FILENAME = "filename";
    /** 请求标识（归属校验用，小字符串） */
    static final String OPT_REQUEST_ID = "requestId";`);

// 5) saveInstanceState 也保存 requestId
rep('save requestId',
`        ret.putString("motionPendingOp", pendingOp);
        ret.putString("motionPendingPhase", pendingPhase);`,
`        ret.putString("motionPendingOp", pendingOp);
        ret.putString("motionPendingPhase", pendingPhase);
        String rid = pendingRequestId;
        if (rid != null) ret.putString("motionPendingRequestId", rid);`);

// 6) restoreState 恢复 requestId（WAITING 分支）
rep('restore requestId',
`            pendingOp = op;
            pendingPhase = PHASE_WAITING;
            if (t != null && ExportSpool.isValidToken(t)) {`,
`            pendingOp = op;
            pendingPhase = PHASE_WAITING;
            String rid = state.getString("motionPendingRequestId");
            if (rid != null) pendingRequestId = rid;
            if (t != null && ExportSpool.isValidToken(t)) {`);

// 7) releaseOperation 清 requestId
rep('release clears requestId',
`    private void releaseOperation() {
        synchronized (this) {
            pendingOp = OP_NONE;
            pendingPhase = PHASE_NONE;
            pendingToken = null;
        }
    }`,
`    private void releaseOperation() {
        synchronized (this) {
            pendingOp = OP_NONE;
            pendingPhase = PHASE_NONE;
            pendingToken = null;
            pendingRequestId = null;
        }
    }

    /** 生成请求标识（随机十六进制，短字符串） */
    private String newRequestId() {
        return Long.toHexString(System.nanoTime()) + "-" + Long.toHexString(Double.doubleToLongBits(Math.random()));
    }`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
