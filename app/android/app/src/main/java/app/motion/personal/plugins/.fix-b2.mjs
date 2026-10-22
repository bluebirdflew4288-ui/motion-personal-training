import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// B: export 异属/迟到回调同样不结算
rep('export foreign callback no settle',
`        if (!OP_EXPORT.equals(pendingOp)) {
            // 没有在等的导出：这不是我们的结果
            call.setKeepAlive(false);
            JSObject ignore = new JSObject();
            ignore.put("ignored", true);
            ignore.put("reason", "no_pending_export");
            call.resolve(ignore);
            return;
        }
        if (requestId == null || !requestId.equals(pendingRequestId)) {
            // 异属/迟到回调：绝不释放当前门禁，也不动当前暂存
            call.setKeepAlive(false);
            JSObject ignore = new JSObject();
            ignore.put("ignored", true);
            ignore.put("reason", "request_mismatch");
            call.resolve(ignore);
            return;
        }`,
`        // 异属/迟到回调：**不 resolve、不 reject、不改 keepAlive**，
        // 也不解锁、不删别的任务 —— 由该 call 真正所属的请求结算它。
        // 用「ignored 成功」结算会提前结束错误的 promise。
        if (!OP_EXPORT.equals(pendingOp)) {
            return;
        }
        if (requestId == null || !requestId.equals(pendingRequestId)) {
            return;
        }`);

// B: stage 时把原始字节数 + SHA256 绑定到短元数据
rep('stage binds length+sha',
`        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        call.getData().put(OPT_REQUEST_ID, requestId);`,
`        // B 完整性防护：把 stage 时的原始字节数与 SHA256 绑到短元数据。
        // 回调读 spool 后先核对，避免「私有暂存被意外截短/变值」也被报 verified。
        // 这些都是小字符串/数字，不会让 Bundle 变大。
        final int stagedBytes = spool().stagedLengthInt(token);
        final String stagedSha;
        try {
            stagedSha = spool().sha256Of(token);
        } catch (Exception e) {
            spool().discard(token);
            releaseOperation();
            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_HASH_FAILED", e);
            return;
        }

        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        call.getData().put(OPT_REQUEST_ID, requestId);
        call.getData().put(OPT_STAGED_BYTES, stagedBytes);
        call.getData().put(OPT_STAGED_SHA, stagedSha);`);

// 常量
rep('OPT staged constants',
`    /** 请求标识（归属校验用，小字符串） */
    static final String OPT_REQUEST_ID = "requestId";`,
`    /** 请求标识（归属校验用，小字符串） */
    static final String OPT_REQUEST_ID = "requestId";
    /** stage 时的原始字节数（完整性绑定，小数字） */
    static final String OPT_STAGED_BYTES = "stagedBytes";
    /** stage 时的原始 SHA-256（完整性绑定，64 hex） */
    static final String OPT_STAGED_SHA = "stagedSha256";`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
