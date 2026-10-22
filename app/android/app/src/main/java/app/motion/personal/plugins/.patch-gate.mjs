import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// 1) 把 exportInFlight 布尔换成统一 pending operation
rep('pending op fields',
`    /** 防重入：同一时刻只允许一个导出在飞行中 */
    private volatile boolean exportInFlight = false;`,
`    /**
     * 统一 pending operation 门禁。
     *
     * <p>为什么导出和导入必须共用同一个门禁：Capacitor 8.5.3 的
     * {@code Plugin.startActivityForResult} 把所有 ActivityCallback 都挂在
     * <b>同一个 {@code lastPluginCallId}</b> 上。如果 export 在飞行中又发起 import，
     * 后发的 import 会覆盖 lastPluginCallId —— export 返回时拿到的会是 import 的 call，
     * 于是报 MISSING_TOKEN，原导出请求悬空（永远不 resolve/reject）。
     *
     * <p>所以这里用<b>单一</b> pending operation：export / import 均单飞，
     * 恢复（appRestoredResult）期间也算占用，结束/取消/失败统一释放。
     */
    private static final String OP_NONE = "";
    private static final String OP_EXPORT = "export";
    private static final String OP_IMPORT = "import";

    /** 当前在飞行的操作类型（OP_NONE / OP_EXPORT / OP_IMPORT） */
    private volatile String pendingOp = OP_NONE;

    /** 当前 pending 的导出 token（供恢复/清理判断归属） */
    private volatile String pendingToken = null;`);

// 2) saveInstanceState 保存 pendingOp / token（都是小字符串，不含正文）
rep('saveInstanceState body',
`    protected Bundle saveInstanceState() {
        Bundle ret = new Bundle();
        // 只保存 token 级别的元数据；正文永远在磁盘上
        ret.putBoolean("motionExportInFlight", exportInFlight);
        return ret;
    }`,
`    protected Bundle saveInstanceState() {
        Bundle ret = new Bundle();
        // 只保存 token 级别的元数据；正文永远在磁盘上，不进 Bundle
        ret.putString("motionPendingOp", pendingOp);
        String t = pendingToken;
        if (t != null) ret.putString("motionPendingToken", t);
        return ret;
    }`);

// 3) restoreState 恢复 pendingOp / token（不再靠进程内集合）
rep('restoreState body',
`    protected void restoreState(Bundle state) {
        if (state != null) {
            exportInFlight = state.getBoolean("motionExportInFlight", false);
        }
    }`,
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
    }`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
