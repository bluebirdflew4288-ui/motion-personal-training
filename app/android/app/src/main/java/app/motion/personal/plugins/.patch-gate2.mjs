import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 1) load() 不再清理：真实恢复顺序是 load 先于 restoreInstanceState，
//    此时还不知道是否有 pending 要恢复，清残留会误删。
rep('load defers purge',
`    public void load() {
        // 启动兜底：**只**清「本插件合法 token 命名 + 已过期 + 非待恢复」的残留。
        // 不能在这里无条件清全部 .json —— 那会删掉正在飞行的导出
        // （SAF 打开期间 Activity 可能重建，重建后还要按 token 把正文读回来），
        // 也会误删目录里的无关文件。TTL 见 ExportSpool.DEFAULT_STALE_TTL_MS。
        try {
            spool().purgeStale();
        } catch (Exception ignored) {
            // 清理失败不影响正常使用
        }
    }`,
`    public void load() {
        // 注意：这里**不做**任何清理。
        //
        // Capacitor 8.5.3 的真实顺序是 PluginHandle.load() → … → Bridge.restoreInstanceState()。
        // load 执行时我们还不知道本次启动是否要恢复一个 pending 导出
        // （token 在 restoreState 才拿到），此时清残留可能把待恢复的正文删掉。
        // 因此清理推迟到「恢复状态已知」之后，见 maybePurgeAfterRestore()。
    }

    /**
     * 恢复状态已知之后再清残留。
     *
     * <p>判定依据是 {@link #pendingOp} 与 {@link #pendingToken}（来自 restoreState
     * 或本进程的实时状态），而不是 load 时的进程内集合。
     * 只有「没有 pending 操作」时才清理过期孤儿。
     */
    private void maybePurgeAfterRestore() {
        if (!OP_NONE.equals(pendingOp)) return;      // 有在飞行的操作，别动
        if (pendingToken != null) return;            // 有待恢复 token，别动
        try {
            spool().purgeStale();
        } catch (Exception ignored) {
            // 清理失败不影响正常使用
        }
    }

    /**
     * 在插件 ready 后执行延迟清理。
     *
     * <p>Capacitor 在 restoreInstanceState 之后才允许插件正常调用，
     * 这里用 handleOnStart 作为「恢复已完成」的时机点。
     */
    @Override
    protected void handleOnStart() {
        maybePurgeAfterRestore();
    }`);

// 2) exportJson 用统一门禁
rep('export gate',
`        // 并发防串：同一时刻只处理一个导出
        synchronized (this) {
            if (exportInFlight) {
                call.reject("正在导出，请等待当前导出完成", "EXPORT_IN_PROGRESS");
                return;
            }
            exportInFlight = true;
        }`,
`        // 统一门禁：export / import 单飞（见 pendingOp 注释）
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
        }`);

// 3) export 各失败路径释放门禁
s = s.split('            exportInFlight = false;\n            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);')
     .join('            releaseOperation();\n            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);');

s = s.split(`            spool().discard(token);
            exportInFlight = false;
            call.setKeepAlive(false);
            call.reject("无法打开系统保存界面：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);`)
     .join(`            spool().discard(token);
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("无法打开系统保存界面：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
