import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// export 回调：归属校验
rep('export callback ownership',
`        final String token = call.getString(OPT_TOKEN);
        final String suggestedName = call.getString(OPT_FILENAME);

        // 请求与 token 归属核对：只接受本插件签发的合法 token 格式。
        // 非法 token 一律当「状态丢失」处理，不去碰任何文件。
        if (token != null && !ExportSpool.isValidToken(token)) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("导出状态无效，无法写入", "INVALID_TOKEN");
            return;
        }`,
`        final String token = call.getString(OPT_TOKEN);
        final String suggestedName = call.getString(OPT_FILENAME);
        final String requestId = call.getString(OPT_REQUEST_ID);

        // ── 归属校验（关键）──────────────────────────────────────────────
        // Capacitor 8.5.3 的 startActivityForResult 共用 lastPluginCallId，
        // 迟到/异属的回调可能拿到不属于它的 call。这里必须确认：
        //   1) 当前确实有一个 export 在等待
        //   2) 回调携带的 requestId 与当前 pending 一致
        //   3) token 是合法格式
        // 任一不满足 → 不处理、不解锁、不删任何文件（避免误释放另一个任务）。
        if (!OP_EXPORT.equals(pendingOp)) {
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
        }
        if (token == null || !ExportSpool.isValidToken(token)) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("导出状态无效，无法写入", "INVALID_TOKEN");
            return;
        }`);

// import 回调：归属校验（import 无 token，用 pendingOp 判定）
rep('import callback ownership',
`    private void importJsonResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {`,
`    private void importJsonResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        // 归属校验：只有当前确实在等 import 才处理（避免把 export 的结果当 import）
        if (!OP_IMPORT.equals(pendingOp)) {
            call.setKeepAlive(false);
            JSObject ignore = new JSObject();
            ignore.put("ignored", true);
            ignore.put("reason", "no_pending_import");
            call.resolve(ignore);
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
