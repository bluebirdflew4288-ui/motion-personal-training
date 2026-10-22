import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];

// 1) 所有残留 exportInFlight = false → releaseOperation()
const before = (s.match(/exportInFlight = false;/g) || []).length;
s = s.split('exportInFlight = false;').join('releaseOperation();');
log.push(`replaced ${before} release points -> releaseOperation()`);

// 2) 加 releaseOperation() 辅助方法
const anchor = `    private ExportSpool spool() {`;
if (s.includes(anchor)) {
  s = s.replace(anchor, `    /** 统一释放 pending operation（结束 / 取消 / 失败都走这里） */
    private void releaseOperation() {
        synchronized (this) {
            pendingOp = OP_NONE;
            pendingToken = null;
        }
    }

` + anchor);
  log.push('OK   added releaseOperation()');
} else {
  log.push('SKIP releaseOperation()');
}

// 3) importJson 接入统一门禁
const importAnchor = `        call.setKeepAlive(true);
        startActivityForResult(call, intent, "importJsonResult");`;
if (s.includes(importAnchor)) {
  s = s.replace(importAnchor, `        // 统一门禁：import 也必须单飞，否则会覆盖 export 的 lastPluginCallId
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_IMPORT;
        }

        call.setKeepAlive(true);
        try {
            startActivityForResult(call, intent, "importJsonResult");
        } catch (Exception e) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("无法打开系统文件选择器：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);
        }`);
  log.push('OK   importJson gated');
} else {
  log.push('SKIP importJson gate');
}

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
