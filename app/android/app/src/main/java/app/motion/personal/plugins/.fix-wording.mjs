import { readFileSync, writeFileSync } from 'node:fs';
const p = 'NativeFileBridgePlugin.java';
let s = readFileSync(p, 'utf8');
const log = [];
function rep(name, from, to) {
  if (!s.includes(from)) { log.push(`SKIP ${name}`); return; }
  s = s.replace(from, to);
  log.push(`OK   ${name}`);
}

// B 文案修正：Activity 重建不必然杀死旧线程
rep('phase doc wording',
`     * <p>两种相位恢复语义完全不同：
     * <ul>
     *   <li>{@code PHASE_WAITING}：等用户选位置。重建后原 promise 已消失，
     *       结果不会再回到它 → 恢复为「未完成、可重试」，不能永久 busy。</li>
     *   <li>{@code PHASE_WRITING}：写入线程属于旧实例。新实例无法接管那个线程，
     *       也不应假装它成功 → 同样恢复为「未完成、可重试」，并明确提示。</li>
     * </ul>
     * 两种都不把 busy 原样继承，因此新实例永远不会永久 busy。`,
`     * <p>两种相位恢复语义完全不同：
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
     * {@code lastPluginCallId} 导致旧回调拿错 call。`);

// 恢复分支注释同步
rep('restore branch comment',
`        if (hasOp && writing) {
            // 写入期：writer 已随旧实例消失 → 明确中断，可重试
            restoredInterrupted = true;`,
`        if (hasOp && writing) {
            // 处理期：新实例无法接管/确认上一操作结果。
            // 不断言旧线程已死（重建不必然杀死线程），只说结果未确认、可重试。
            restoredInterrupted = true;`);

// consume 文案
rep('consume wording',
`        // 写入期被中断（明确失败，可重试）
        ret.put("interrupted", restoredInterrupted);`,
`        // 处理期结果未确认（可重试；不声称文件必然未写入）
        ret.put("interrupted", restoredInterrupted);`);

writeFileSync(p, s, 'utf8');
console.log(log.join('\n'));
