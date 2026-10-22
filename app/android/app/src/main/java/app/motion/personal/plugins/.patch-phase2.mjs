import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 1) releaseOperation 重置相位与 token
rep('release resets phase',
`    private void releaseOperation() {
        synchronized (this) {
            pendingOp = OP_NONE;
            pendingToken = null;
        }
    }`,
`    private void releaseOperation() {
        synchronized (this) {
            pendingOp = OP_NONE;
            pendingPhase = PHASE_NONE;
            pendingToken = null;
        }
    }`);

// 2) export 占位时设 WAITING + token
rep('export sets waiting phase',
`        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
        }`,
`        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
            pendingPhase = PHASE_WAITING;   // 还在等用户选位置
        }`);

// 3) 暂存成功后记录 token
rep('export records token',
`        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);`,
`        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        // 记录 pending token（供 saved-state 与清理判断归属）
        pendingToken = token;
        spool().markPending(token);`);

// 4) 回调拿到 URI、开始写入前切到 WRITING
rep('callback switches to writing',
`        final String displayName = queryDisplayName(uri, suggestedName);

        // 关掉 keepAlive：本 call 只等这一次结果
        call.setKeepAlive(false);`,
`        final String displayName = queryDisplayName(uri, suggestedName);

        // 已拿到 URI，进入写入相位：此后若 Activity 重建，新实例不会继承 busy
        pendingPhase = PHASE_WRITING;

        // 关掉 keepAlive：本 call 只等这一次结果
        call.setKeepAlive(false);`);

// 5) import 也设置相位（无 token，仅 WAITING）
rep('import sets waiting phase',
`            pendingOp = OP_IMPORT;
        }

        call.setKeepAlive(true);
        try {
            startActivityForResult(call, intent, "importJsonResult");`,
`            pendingOp = OP_IMPORT;
            pendingPhase = PHASE_WAITING;
        }

        call.setKeepAlive(true);
        try {
            startActivityForResult(call, intent, "importJsonResult");`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
