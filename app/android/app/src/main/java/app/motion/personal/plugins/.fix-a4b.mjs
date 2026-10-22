import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// ── A4-1: importJson 生成并保存 requestId，写入 options ──
rep('import generates requestId',
`        // 统一门禁：import 也必须单飞，否则会覆盖 export 的 lastPluginCallId
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_IMPORT;
            pendingPhase = PHASE_WAITING;
        }

        call.setKeepAlive(true);`,
`        // 统一门禁：import 也必须单飞，否则会覆盖 export 的 lastPluginCallId
        final String requestId = newRequestId();
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_IMPORT;
            pendingPhase = PHASE_WAITING;
            pendingRequestId = requestId;
        }
        // 与 export 对称：requestId 也进 options（小字符串，可安全进 Bundle）
        call.getData().put(OPT_REQUEST_ID, requestId);

        call.setKeepAlive(true);`);

// ── B-1: 异属回调不得结算他属 call（import 分支）──
rep('import foreign callback no settle',
`        // 归属校验：只有当前确实在等 import 才处理（避免把 export 的结果当 import）
        if (!OP_IMPORT.equals(pendingOp)) {
            call.setKeepAlive(false);
            JSObject ignore = new JSObject();
            ignore.put("ignored", true);
            ignore.put("reason", "no_pending_import");
            call.resolve(ignore);
            return;
        }`,
`        // ── 归属校验（关键）──────────────────────────────────────────────
        // 异属/迟到回调：**不 resolve、不 reject、不改 keepAlive**，
        // 也不解锁、不删别的任务。直接静默返回 —— 该 call 属于另一个请求，
        // 由那个请求自己结算。用「ignored 成功」结算它会提前结束错误的 promise。
        final String reqId = call.getString(OPT_REQUEST_ID);
        if (!OP_IMPORT.equals(pendingOp)) {
            return;
        }
        if (reqId == null || !reqId.equals(pendingRequestId)) {
            return;
        }`);

// ── A4-2: 读取前切 PROCESSING 相位 ──
rep('import switches phase before read',
`        final String displayName = queryDisplayName(uri, "backup.json");
        call.setKeepAlive(false);

        new Thread(`,
`        final String displayName = queryDisplayName(uri, "backup.json");

        // A4 关键：系统结果已消费、即将启动后台读取。
        // 此刻若 Activity 重建，新实例**不能**再按 WAITING 恢复
        // （系统结果不会再产生一份，会永久 busy）。
        // 切到处理相位 → 恢复时按「结果未确认、可重试」处理。
        pendingPhase = PHASE_WRITING;

        call.setKeepAlive(false);

        new Thread(`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
