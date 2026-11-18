package app.motion.personal.plugins;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * MOTION · 本地 JSON 备份的原生文件桥。
 *
 * <h2>两条入口</h2>
 * <ul>
 *   <li>{@code exportJson} → SAF「创建文档」：用户选好位置后真正写入并<b>回读校验</b>。</li>
 *   <li>{@code importJson} → SAF「打开文档」：读到文本后交回网页，复用既有校验/预览/覆盖。</li>
 * </ul>
 *
 * <h2>0.1.2 修复：正文不进 Activity saved-state</h2>
 * 旧实现把整份 {@code content} 留在 {@link PluginCall} 里等 SAF 返回。
 * Capacitor 8.5.3 会在 Activity stopped 时把该 call 的 options 序列化<b>两份</b>
 * 进 Bundle（{@code capacitorLastPluginCallOptions} 与 {@code capacitorLastPluginCallBundle._json}），
 * 大备份直接触发 {@code TransactionTooLargeException} → 进程被杀 →
 * 用户看到「App 自己退出、无成功提示、留下 0B 文件」。
 *
 * <p>现在的做法：
 * <ol>
 *   <li>打开 SAF <b>之前</b>，把正文写进 App 私有暂存目录（{@link ExportSpool}），拿到短 token。</li>
 *   <li>{@code call.getData().remove("content")} —— <b>关键</b>：从 options 里真正删掉正文，
 *       只留 token 与小元数据。这样两份 saved-state 都只有几十字节。</li>
 *   <li>SAF 回调按 token 从磁盘读回正文（因此 Activity 重建 / 进程回收后依然可用，
 *       不依赖内存字段或静态 map）。</li>
 *   <li>写入后重新打开目标 URI 回读，比较长度与 SHA-256，一致才 resolve(saved=true)。</li>
 *   <li>成功 / 取消 / 失败都清理暂存文件。</li>
 * </ol>
 *
 * <p>权限边界：只用 SAF 按次授权。不申请任何存储权限。
 */
@CapacitorPlugin(name = "NativeFileBridge")
public class NativeFileBridgePlugin extends Plugin {

    /** PluginCall options 里承载 token 的键 */
    static final String OPT_TOKEN = "spoolToken";
    /** 原始建议文件名（小字符串，可安全进 Bundle） */
    static final String OPT_FILENAME = "filename";
    /** 请求标识（归属校验用，小字符串） */
    static final String OPT_REQUEST_ID = "requestId";
    /** stage 时的原始字节数（完整性绑定，小数字） */
    static final String OPT_STAGED_BYTES = "stagedBytes";
    /** stage 时的原始 SHA-256（完整性绑定，64 hex） */
    static final String OPT_STAGED_SHA = "stagedSha256";

    /** 暂存目录名（App 私有 cache 下） */
    private static final String SPOOL_DIR = "motion-export";

    private ExportSpool spool;

    /**
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
     *   <li>{@code PHASE_WAITING}：等用户选位置。系统结果尚未产生，
     *       Capacitor 会用顶层 options 重建 dangling call，结果仍会送到新实例
     *       → <b>必须恢复门禁与归属，继续等原系统回调</b>。</li>
     *   <li>{@code PHASE_WRITING}：已拿到 URI、正在读写。
     *       注意 Activity 重建<b>不会必然</b>杀死旧实例的 writer/reader 线程
     *       （本任务的 JVM 探针实测旧 reader 在新实例创建后仍能正常结束）；
     *       但新实例<b>无法接管、也无法确认</b>上一操作的结果。
     *       → 按「结果未确认、可重试」处理，不假装成功，也不断言文件必然未写入。</li>
     * </ul>
     * 只有 WRITING 不继承 busy；WAITING 必须保留归属，避免新操作覆盖
     * {@code lastPluginCallId} 导致旧回调拿错 call。
     */
    private static final String PHASE_NONE = "";
    private static final String PHASE_WAITING = "waiting";
    private static final String PHASE_WRITING = "writing";

    private volatile String pendingPhase = PHASE_NONE;

    /** 当前 pending 的导出 token（供恢复/清理判断归属） */
    private volatile String pendingToken = null;

    /** 统一释放 pending operation（结束 / 取消 / 失败都走这里） */
    private void releaseOperation() {
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
    }

    private ExportSpool spool() {
        if (spool == null) {
            spool = new ExportSpool(new File(getContext().getCacheDir(), SPOOL_DIR));
        }
        return spool;
    }

    @Override
    public void load() {
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
    }

    /**
     * 关键修复点 2/2：覆盖 Capacitor 的默认 saved-state 逻辑。
     *
     * <p>即使我们已从 options 删掉正文，这里仍然显式只回写「无正文」的最小 Bundle，
     * 确保任何情况下 {@code capacitorLastPluginCallBundle._json} 都不携带大内容。
     * （注意：仅覆盖本方法<b>不够</b> —— {@code Bridge.saveInstanceState} 还会独立
     * 序列化 {@code call.getData()}，所以必须同时在 {@link #exportJson} 里删掉 content。）
     */
    @Override
    protected Bundle saveInstanceState() {
        Bundle ret = new Bundle();
        // 只保存 token 级别的元数据；正文永远在磁盘上，不进 Bundle
        ret.putString("motionPendingOp", pendingOp);
        ret.putString("motionPendingPhase", pendingPhase);
        String rid = pendingRequestId;
        if (rid != null) ret.putString("motionPendingRequestId", rid);
        String t = pendingToken;
        if (t != null) ret.putString("motionPendingToken", t);
        return ret;
    }

    @Override
    /**
     * 恢复时<b>不继承 busy</b>。
     *
     * <p>旧实例的 writer 线程/原 JS promise 都随实例消失，新实例无法接管。
     * 因此这里只记录「上次有个未完成的导出，token=X」，把相位标为可重试，
     * 并把 token 标记为待恢复（避免清理误删），然后<b>立即释放门禁</b>。
     * 这样新实例可以重新发起导出，不会永久 busy。
     */
    /**
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
            String rid = state.getString("motionPendingRequestId");
            if (rid != null) pendingRequestId = rid;
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
            // 处理期：新实例无法接管/确认上一操作结果。
            // 不断言旧线程已死（重建不必然杀死线程），只说结果未确认、可重试。
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
    }

    /** 恢复时仍在等待系统结果（门禁与归属已恢复，不清） */
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
    private volatile String pendingRequestId = null;

    /**
     * 取走「上次未完成」的状态（一次性）。
     *
     * <p>JS 侧可在启动后调用 {@code consumeRestoredExport()} 得知需要提示
     * 「上次导出未完成，请重试」；返回后本标记清空，不会重复提示。
     */
    @PluginMethod
    public void consumeRestoredExport(PluginCall call) {
        JSObject ret = new JSObject();
        // 处理期结果未确认（可重试；不声称文件必然未写入）
        ret.put("interrupted", restoredInterrupted);
        ret.put("phase", restoredInterrupted ? PHASE_WRITING : (restoredWaiting ? PHASE_WAITING : PHASE_NONE));
        // 仍在等待系统结果：门禁与归属**不清**，JS 侧应继续等，不要提示失败
        ret.put("stillWaiting", restoredWaiting && !OP_NONE.equals(pendingOp));
        ret.put("busy", !OP_NONE.equals(pendingOp));
        restoredInterrupted = false;
        restoredInterruptedToken = null;
        // 注意：restoredWaiting 只用于提示，不清 pendingOp / pendingToken
        call.resolve(ret);
    }

    /** 导出：先把正文落到私有暂存文件，再打开系统「创建文档」界面。 */
    @PluginMethod
    public void exportJson(PluginCall call) {
        String filename = call.getString(OPT_FILENAME);
        String content = call.getString("content");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("缺少文件名", "MISSING_FILENAME");
            return;
        }
        if (content == null) {
            call.reject("缺少要写入的内容", "MISSING_CONTENT");
            return;
        }
        if (content.isEmpty()) {
            call.reject("内容为空，不能作为备份导出", "EMPTY_CONTENT");
            return;
        }
        // 统一门禁：export / import 单飞（见 pendingOp 注释）
        final String requestId = newRequestId();
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
            pendingPhase = PHASE_WAITING;   // 还在等用户选位置
            pendingRequestId = requestId;
        }

        // ① 先把正文转成 UTF-8 字节 —— 这是「最初正文」的唯一权威副本。
        //    expected 长度/摘要必须由**这份字节**生成，绝不能回读 spool 再算：
        //    否则在「stage 完成、metadata 生成前」的窗口里，
        //    文件被等长改写或非空截短时 expected 会跟着错误内容一起变化，
        //    完整性承诺就失效了（Codex T4/T5 已确认该缺口）。
        final byte[] originalBytes;
        try {
            originalBytes = content.getBytes("UTF-8");
        } catch (Exception e) {
            releaseOperation();
            call.reject("内容编码失败：" + BackupIo.describe(e), "ENCODE_FAILED", e);
            return;
        }
        if (originalBytes.length == 0) {
            releaseOperation();
            call.reject("内容为空，不能作为备份导出", "EMPTY_CONTENT");
            return;
        }

        // ② 用**同一份字节**落盘，拿到短 token
        final String token;
        try {
            token = spool().stageBytes(originalBytes);
        } catch (Exception e) {
            releaseOperation();
            call.reject("准备导出失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);
            return;
        }

        // ③ 关键：从 options 里真正移除正文，只留 token + 文件名
        // B 完整性防护：expected 直接来自上面那份 originalBytes（最初正文），
        // 与写入磁盘的内容同源，因此不随暂存文件被改动而变化。
        // 这些都是小字符串/数字，不会让 Bundle 变大。
        final int stagedBytes = originalBytes.length;
        final String stagedSha = BackupIo.sha256Hex(originalBytes);

        call.getData().remove("content");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        call.getData().put(OPT_REQUEST_ID, requestId);
        call.getData().put(OPT_STAGED_BYTES, stagedBytes);
        call.getData().put(OPT_STAGED_SHA, stagedSha);
        // 记录 pending token（供 saved-state 与清理判断归属）
        pendingToken = token;
        spool().markPending(token);

        call.setKeepAlive(true);

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, filename);

        try {
            startActivityForResult(call, intent, "exportJsonResult");
        } catch (Exception e) {
            // 启动失败：清暂存并放行
            spool().discard(token);
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("无法打开系统保存界面：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);
        }
    }

    /**
     * Wave 3D.2：导出本地生成的 PNG 小票图片（SAF 创建文档 + 暂存防大 Bundle + 写入回读 SHA-256 校验）。
     * 零网络请求、零额外存储权限。
     */
    @PluginMethod
    public void exportPng(PluginCall call) {
        String filename = call.getString(OPT_FILENAME);
        String base64 = call.getString("base64");

        if (filename == null || filename.trim().isEmpty()) {
            call.reject("缺少文件名", "MISSING_FILENAME");
            return;
        }
        if (base64 == null || base64.trim().isEmpty()) {
            call.reject("缺少要写入的图片数据", "MISSING_CONTENT");
            return;
        }

        final String requestId = newRequestId();
        synchronized (this) {
            if (!OP_NONE.equals(pendingOp)) {
                call.reject("正在处理另一个文件操作，请稍后再试", "OPERATION_IN_PROGRESS");
                return;
            }
            pendingOp = OP_EXPORT;
            pendingPhase = PHASE_WAITING;
            pendingRequestId = requestId;
        }

        final byte[] originalBytes;
        try {
            int commaIdx = base64.indexOf(',');
            String payload = commaIdx >= 0 ? base64.substring(commaIdx + 1) : base64;
            originalBytes = Base64.decode(payload, Base64.DEFAULT);
        } catch (Exception e) {
            releaseOperation();
            call.reject("图片数据解码失败：" + BackupIo.describe(e), "ENCODE_FAILED", e);
            return;
        }

        // 校验非空且具备标准 PNG 文件头（89 50 4E 47 0D 0A 1A 0A）
        if (originalBytes == null
                || originalBytes.length < 8
                || (originalBytes[0] & 0xFF) != 0x89
                || originalBytes[1] != 0x50
                || originalBytes[2] != 0x4E
                || originalBytes[3] != 0x47) {
            releaseOperation();
            call.reject("生成的图片格式不完整，已取消保存", "INVALID_PNG");
            return;
        }

        final String token;
        try {
            token = spool().stageBytes(originalBytes);
        } catch (Exception e) {
            releaseOperation();
            call.reject("准备导出图片失败：" + BackupIo.describe(e), "SPOOL_FAILED", e);
            return;
        }

        final int stagedBytes = originalBytes.length;
        final String stagedSha = BackupIo.sha256Hex(originalBytes);

        // 关键：从 PluginCall options 中移除 Base64 大串，避免 Activity stopped 时触发 TransactionTooLargeException
        call.getData().remove("base64");
        call.getData().put(OPT_TOKEN, token);
        call.getData().put(OPT_FILENAME, filename);
        call.getData().put(OPT_REQUEST_ID, requestId);
        call.getData().put(OPT_STAGED_BYTES, stagedBytes);
        call.getData().put(OPT_STAGED_SHA, stagedSha);
        pendingToken = token;
        spool().markPending(token);

        call.setKeepAlive(true);

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/png");
        intent.putExtra(Intent.EXTRA_TITLE, filename);

        try {
            startActivityForResult(call, intent, "exportJsonResult");
        } catch (Exception e) {
            spool().discard(token);
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("无法打开系统保存界面：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);
        }
    }

    /**
     * 系统「创建文档」返回。
     *
     * <p>只有 write → flush → close → <b>回读校验</b> 全过才 resolve(saved=true)。
     */
    @ActivityCallback
    private void exportJsonResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            releaseOperation();
            return;
        }

        final String token = call.getString(OPT_TOKEN);
        final String suggestedName = call.getString(OPT_FILENAME);
        final String requestId = call.getString(OPT_REQUEST_ID);

        // ── 归属校验（关键）──────────────────────────────────────────────
        // Capacitor 8.5.3 的 startActivityForResult 共用 lastPluginCallId，
        // 迟到/异属的回调可能拿到不属于它的 call。这里必须确认：
        //   1) 当前确实有一个 export 在等待
        //   2) 回调携带的 requestId 与当前 pending 一致
        //   3) token 是合法格式
        // 任一不满足 → 不处理、不解锁、不删任何文件（避免误释放另一个任务）。
        // 异属/迟到回调：**不 resolve、不 reject、不改 keepAlive**，
        // 也不解锁、不删别的任务 —— 由该 call 真正所属的请求结算它。
        // 用「ignored 成功」结算会提前结束错误的 promise。
        if (!OP_EXPORT.equals(pendingOp)) {
            return;
        }
        if (requestId == null || !requestId.equals(pendingRequestId)) {
            return;
        }
        if (token == null || !ExportSpool.isValidToken(token)) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("导出状态无效，无法写入", "INVALID_TOKEN");
            return;
        }

        // 用户取消 / 返回键：不写库、不报成功、清暂存
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            if (token != null) spool().discard(token);
            releaseOperation();
            call.setKeepAlive(false);
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            cancelled.put("saved", false);
            call.resolve(cancelled);
            return;
        }

        final Uri uri = result.getData().getData();
        if (uri == null) {
            if (token != null) spool().discard(token);
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("系统没有返回可写入的位置", "NO_URI");
            return;
        }
        if (token == null) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("导出状态已丢失，无法写入", "MISSING_TOKEN");
            return;
        }

        final String displayName = queryDisplayName(uri, suggestedName);

        // 已拿到 URI，进入写入相位：此后若 Activity 重建，新实例不会继承 busy
        pendingPhase = PHASE_WRITING;

        // 关掉 keepAlive：本 call 只等这一次结果
        call.setKeepAlive(false);

        new Thread(
                        () -> {
                            byte[] bytes;
                            try {
                                // 按 token 从磁盘读回正文（Activity 重建后依然有效）
                                bytes = spool().readBytes(token);
                                // B 完整性核对：与 stage 时绑定的字节数/摘要比对。
                                // 私有暂存若被截短或变值，这里就拒绝，不会写出「看似 verified」的坏备份。
                                int expectBytes = call.getInt(OPT_STAGED_BYTES, -1);
                                String expectSha = call.getString(OPT_STAGED_SHA);
                                if (expectBytes <= 0 || expectSha == null) {
                                    releaseOperation();
                                    spool().discard(token);
                                    call.reject("导出元数据缺失，无法确认内容完整", "STAGE_META_MISSING");
                                    return;
                                }
                                if (bytes.length != expectBytes
                                        || !expectSha.equals(ExportSpool.sha256Hex(bytes))) {
                                    releaseOperation();
                                    spool().discard(token);
                                    call.reject(
                                            "暂存内容与导出时不一致，已中止写入", "SPOOL_CORRUPTED");
                                    return;
                                }
                            } catch (Exception e) {
                                releaseOperation();
                                spool().discard(token);
                                call.reject("读取暂存内容失败：" + BackupIo.describe(e), "SPOOL_READ_FAILED", e);
                                return;
                            }

                            OutputStream out = openOutput(uri);
                            BackupIo.exportToVerified(
                                    out,
                                    bytes,
                                    () -> readBackBytes(uri),
                                    new BackupIo.VerifiedExportSink() {
                                        @Override
                                        public void success(BackupIo.VerifiedExport verified) {
                                            releaseOperation();
                                            // 成功：清暂存
                                            boolean cleaned = spool().discard(token);
                                            JSObject ret = new JSObject();
                                            ret.put("saved", true);
                                            ret.put("cancelled", false);
                                            ret.put("filename", displayName);
                                            ret.put("uri", uri.toString());
                                            ret.put("bytes", verified.getBytes());
                                            ret.put("sha256", verified.getSha256());
                                            ret.put("spoolCleaned", cleaned);
                                            call.resolve(ret);
                                        }

                                        @Override
                                        public void failure(
                                                String code, String message, Exception cause) {
                                            releaseOperation();
                                            // 失败：清暂存 + 精确清理本次新建的空占位
                                            spool().discard(token);
                                            boolean removed = deleteIfEmpty(uri);
                                            JSObject detail = new JSObject();
                                            detail.put("cleanedEmptyTarget", removed);
                                            call.reject(
                                                    message
                                                            + (removed
                                                                    ? "（已清理 0 字节占位文件）"
                                                                    : ""),
                                                    code,
                                                    cause);
                                        }
                                    });
                        })
                .start();
    }

    /** 导入：打开系统文档选择器。 */
    @PluginMethod
    public void importJson(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(
                Intent.EXTRA_MIME_TYPES,
                new String[] { "application/json", "text/plain", "application/octet-stream" });

        // 统一门禁：import 也必须单飞，否则会覆盖 export 的 lastPluginCallId
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

        call.setKeepAlive(true);
        try {
            startActivityForResult(call, intent, "importJsonResult");
        } catch (Exception e) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("无法打开系统文件选择器：" + BackupIo.describe(e), "SAF_LAUNCH_FAILED", e);
        }
    }

    /**
     * 系统文档选择器返回。
     *
     * <p>读取时边读边限，超过上限立刻中止并 reject，不会读完整个流。
     */
    @ActivityCallback
    private void importJsonResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        // ── 归属校验（关键）──────────────────────────────────────────────
        // 异属/迟到回调：**不 resolve、不 reject、不改 keepAlive**，
        // 也不解锁、不删别的任务。直接静默返回 —— 该 call 属于另一个请求，
        // 由那个请求自己结算。用「ignored 成功」结算它会提前结束错误的 promise。
        final String reqId = call.getString(OPT_REQUEST_ID);
        if (!OP_IMPORT.equals(pendingOp)) {
            return;
        }
        if (reqId == null || !reqId.equals(pendingRequestId)) {
            return;
        }

        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            releaseOperation();
            call.setKeepAlive(false);
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        final Uri uri = result.getData().getData();
        if (uri == null) {
            releaseOperation();
            call.setKeepAlive(false);
            call.reject("系统没有返回可读取的文件", "NO_URI");
            return;
        }

        final String displayName = queryDisplayName(uri, "backup.json");

        // A4 关键：系统结果已消费、即将启动后台读取。
        // 此刻若 Activity 重建，新实例**不能**再按 WAITING 恢复
        // （系统结果不会再产生一份，会永久 busy）。
        // 切到处理相位 → 恢复时按「结果未确认、可重试」处理。
        pendingPhase = PHASE_WRITING;

        call.setKeepAlive(false);

        new Thread(
                        () -> {
                            try (InputStream in = openInput(uri)) {
                                byte[] bytes = BackupIo.readCapped(in, BackupIo.DEFAULT_MAX_IMPORT_BYTES);
                                JSObject ret = new JSObject();
                                ret.put("cancelled", false);
                                ret.put("content", new String(bytes, "UTF-8"));
                                ret.put("filename", displayName);
                                ret.put("uri", uri.toString());
                                ret.put("bytes", bytes.length);
                                call.resolve(ret);
                            } catch (BackupIo.TooLargeException e) {
                                releaseOperation();
                                call.reject(e.getMessage(), "TOO_LARGE", e);
                            } catch (Exception e) {
                                releaseOperation();
                                call.reject("读取文件失败：" + BackupIo.describe(e), "READ_FAILED", e);
                            } finally {
                                releaseOperation();
                            }
                        })
                .start();
    }

    // ── 内部工具 ─────────────────────────────────────────────────────────────

    private OutputStream openOutput(Uri uri) {
        try {
            ContentResolver cr = getContext().getContentResolver();
            return cr.openOutputStream(uri, "wt");
        } catch (Exception e) {
            try {
                ContentResolver cr = getContext().getContentResolver();
                return cr.openOutputStream(uri);
            } catch (Exception ignored) {
                return null;
            }
        }
    }

    private InputStream openInput(Uri uri) {
        try {
            return getContext().getContentResolver().openInputStream(uri);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 回读目标 URI 的真实内容（写入后校验用）。
     *
     * @return 真实字节；无法打开/读取时返回 null（调用方据此判定不可校验）
     */
    private byte[] readBackBytes(Uri uri) throws IOException {
        InputStream in = openInput(uri);
        if (in == null) return null;
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8 * 1024];
            int n;
            long total = 0;
            while ((n = in.read(chunk)) != -1) {
                total += n;
                if (total > BackupIo.DEFAULT_MAX_IMPORT_BYTES) return null;
                buf.write(chunk, 0, n);
            }
            return buf.toByteArray();
        } finally {
            try {
                in.close();
            } catch (IOException ignored) {
                // 读取阶段 close 失败不影响已读内容
            }
        }
    }

    /**
     * 只在目标确实是 0 字节时删除它（清理本次新建的失败占位）。
     *
     * <p>绝不删除有内容的文件 —— 避免误删用户已有备份。
     */
    private boolean deleteIfEmpty(Uri uri) {
        try {
            byte[] probe = readBackBytes(uri);
            if (probe != null && probe.length == 0) {
                return getContext().getContentResolver().delete(uri, null, null) > 0;
            }
        } catch (Exception ignored) {
            // 删不掉就如实返回 false，由 JS 侧提示
        }
        return false;
    }

    /** 从 SAF URI 取用户可见文件名（取不到就退回建议名）。 */
    private String queryDisplayName(Uri uri, String fallback) {
        try (android.database.Cursor c =
                getContext()
                        .getContentResolver()
                        .query(
                                uri,
                                new String[] {android.provider.OpenableColumns.DISPLAY_NAME},
                                null,
                                null,
                                null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String name = c.getString(idx);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // 查询失败不影响流程：用建议名
        }
        return fallback == null ? "" : fallback;
    }
}
