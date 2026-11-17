/* F11：源码级契约（可静态判定、可回归）。
   ── 为什么需要这一层 ─────────────────────────────────────
   行为测试（f11-delete-sound / f11-delete-flow）证明的是**模块**行为；
   这里锁定**生产接线**不许被后续改动破坏：
   · 成功出口只能有一个，且必须晚于 `status === 'saved'`；
   · 音效/触感只能有一条通道（不许恢复 navigator.vibrate + 缺失原生的双调用）；
   · 原生插件必须真的实现 JS 调用的方法、必须用真实系统 API、不许加权限/改设置/借 Alarm 流；
   · 音效资产必须可复现、双目标同源、离线。
   这类断言不能替代真机验证，只作为回归护栏。 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const read = (p: string) => readFileSync(resolve(HERE, p), 'utf8');
const readApp = (p: string) => readFileSync(resolve(APP, p), 'utf8');

const SESSION = read('../src/pages/Session.tsx');
const SETTINGS = read('../src/pages/Settings.tsx');
const CARD = read('../src/ui/SwipeActionCard.tsx');
const FEEDBACK = read('../src/lib/deletionFeedback.ts');
const MAIN_ACTIVITY = readApp('android/app/src/main/java/app/motion/personal/MainActivity.java');
const PLUGIN = readApp('android/app/src/main/java/app/motion/personal/plugins/DeletionFeedbackPlugin.java');
const POLICY = readApp('android/app/src/main/java/app/motion/personal/plugins/DeleteFeedbackPolicy.java');
const REST_PLUGIN = readApp('android/app/src/main/java/app/motion/personal/plugins/RestReminderPlugin.java');

function callbackBody(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `未找到 ${header}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }, [', start);
  expect(end, `${header} 的依赖数组未闭合`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const countOf = (source: string, needle: string) => source.split(needle).length - 1;

/**
 * 去掉注释后再做"禁止出现"类断言。
 *
 * 说明文档里**允许**提到被禁用的 API（例如解释"旧实现曾同时调 X 和 Y"），
 * 但代码里不允许真的调用。断言必须针对代码，不能把注释当成违规。
 */
const stripBlockComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const stripComments = (source: string) =>
  stripBlockComments(source).replace(/(^|[^:])\/\/.*$/gm, '$1');

const CARD_CODE = stripComments(CARD);
const PLUGIN_CODE = stripComments(PLUGIN);

describe('F11 成功出口：唯一、晚于 saved、异常隔离', () => {
  const commitDelete = callbackBody(SESSION, 'const commitDelete = useCallback(');

  it('成功音全文件只有一个调用点', () => {
    expect(countOf(SESSION, 'notifyDeleteSucceeded(')).toBe(1);
  });

  it('调用点在 await commitPaired 之后、且在 r.status === "saved" 分支内', () => {
    const awaited = commitDelete.indexOf('await commitPaired(');
    const savedAt = commitDelete.indexOf("r.status === 'saved'");
    const notifyAt = commitDelete.indexOf('notifyDeleteSucceeded(');
    expect(awaited).toBeGreaterThan(-1);
    expect(savedAt).toBeGreaterThan(awaited);
    expect(notifyAt).toBeGreaterThan(savedAt);
  });

  it('saved 分支内没有任何提前返回，失败分支在它之后（没有第二条成功路径）', () => {
    const savedAt = commitDelete.indexOf("r.status === 'saved'");
    const notifyAt = commitDelete.indexOf('notifyDeleteSucceeded(');
    const returnTrue = commitDelete.indexOf('return true;', notifyAt);
    expect(returnTrue).toBeGreaterThan(notifyAt);
    // saved 分支从进入到播放点之间不允许出现任何 return（否则存在绕过播放的路径）
    expect(commitDelete.slice(savedAt, notifyAt)).not.toContain('return');
    // 非 saved 的失败返回在该分支之后
    expect(commitDelete.indexOf('return false;', returnTrue)).toBeGreaterThan(returnTrue);
  });

  it('播放被自己的 try/catch 包住：音频异常不能影响删除/撤销/计时', () => {
    const notifyAt = commitDelete.indexOf('notifyDeleteSucceeded(');
    const tryBefore = commitDelete.lastIndexOf('try {', notifyAt);
    const catchAfter = commitDelete.indexOf('} catch {', notifyAt);
    expect(tryBefore).toBeGreaterThan(-1);
    expect(catchAfter).toBeGreaterThan(notifyAt);
    // try 与 notify 之间只允许空行与注释
    const between = commitDelete.slice(tryBefore, notifyAt);
    expect(between.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toBe('try {');
  });

  it('F10 的消散仍然只有一个播放点且未被本次改动移动（保护保持）', () => {
    expect(countOf(SESSION, 'playDissolve(')).toBe(1);
    expect(SESSION).toContain('dissolveAttribution');
    expect(SESSION).toContain('armReflow');
  });

  it('空白直删/确认删除/点击/F09 松手都汇入同一个 commitDelete（没有第二条成功路径）', () => {
    // 三条入口都以 commitDelete 为终点
    expect(SESSION).toContain('void commitDelete(p.preview, false)');
    expect(SESSION).toContain('void commitDelete(preview, true)');
    // 两条真实入口（空白直删 / 确认后删除）；F09 松手经 onDelete → requestDeleteItem 复用它们
    expect(countOf(SESSION, 'void commitDelete(')).toBe(2);
    // F09 松手走的是 onDelete → requestDeleteItem，不另写一套成功处理
    expect(CARD).toContain('onDelete?.()');
  });
});

describe('F11 页面归属与失效接线', () => {
  it('训练页绑定自己的 session，并在卸载/切 session 时解绑', () => {
    expect(SESSION).toContain('bindDeleteFeedback(sessionId);');
    expect(SESSION).toContain("invalidateDeleteFeedback('session-unbind')");
  });

  it('页面隐藏/失锁统一走 invalidateFeedback，同时作废音频', () => {
    const body = SESSION.slice(
      SESSION.indexOf('const invalidateFeedback = useCallback('),
      SESSION.indexOf("}, [resetDissolve]);", SESSION.indexOf('const invalidateFeedback = useCallback(')),
    );
    expect(body).toContain('invalidateDeleteFeedback(');
    expect(SESSION).toContain("if (document.visibilityState !== 'visible') invalidateFeedback();");
    expect(SESSION).toContain('if (lockBlocked) invalidateFeedback();');
  });

  it('音效开关跟随设置，并在关闭时即刻生效', () => {
    expect(SESSION).toContain('setDeleteFeedbackEnabled(soundEnabled);');
    expect(SESSION).toContain('const soundEnabled = settings.soundEnabled !== false;');
  });
});

describe('F11 F09 准备触感：单通道、每手势一次', () => {
  it('不再出现 navigator.vibrate 与 restReminder.vibrateNow 的双调用', () => {
    expect(CARD_CODE).not.toContain('navigator.vibrate');
    expect(CARD_CODE).not.toContain('vibrateNow');
    expect(CARD_CODE).not.toContain("from '../lib/restReminder'");
  });

  it('只调用 playPrepareHaptic 一次（定义处以外仅一个调用点）', () => {
    expect(countOf(CARD, 'playPrepareHaptic()')).toBe(1);
  });

  it('同一手势至多一次：就绪震动受 hapticFiredRef 守卫，且随手势取消复位', () => {
    expect(CARD).toContain('hapticFiredRef.current = false');
    expect(CARD).toContain('if (!hapticFiredRef.current)');
    expect(CARD).toContain('hapticFiredRef.current = true');
    expect(CARD).toContain('triggerF09Haptic();');
  });

  it('触感不可用不影响手势：文字提示仍在（准备横幅保留）', () => {
    expect(CARD).toContain('SWIPE_PROMPT_BLANK');
    expect(CARD).toContain('SWIPE_PROMPT_CONFIRM');
  });

  it('全应用不再有生产代码调用那个原生未实现的 vibrateNow', () => {
    const sources = [
      read('../src/pages/Session.tsx'),
      read('../src/pages/Settings.tsx'),
      read('../src/ui/SwipeActionCard.tsx'),
      read('../src/lib/deletionFeedback.ts'),
    ];
    for (const s of sources) expect(stripComments(s)).not.toContain('vibrateNow(');
  });

  it('F11 没有扩展休息提醒插件（vibrateNow 仍未实现，交由独立插件负责触感）', () => {
    expect(REST_PLUGIN).not.toContain('vibrateNow');
  });
});

describe('F11 设置页：清楚的中文独立开关', () => {
  it('有独立区块与开关文案（不与休息提醒混在一起）', () => {
    expect(SETTINGS).toContain('交互反馈');
    expect(SETTINGS).toContain('删除成功音效');
    expect(SETTINGS).toContain('aria-label="删除成功音效开关"');
    expect(SETTINGS).toContain('aria-pressed={soundEnabled}');
  });

  it('关闭时先让通道停止，再持久化（避免关掉的瞬间漏出一声）', () => {
    const stopAt = SETTINGS.indexOf('setDeleteFeedbackEnabled(next);');
    const persistAt = SETTINGS.indexOf('await patchSettings({ soundEnabled: next });');
    expect(stopAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(stopAt);
  });

  it('持久化失败会回滚通道状态并如实提示', () => {
    expect(SETTINGS).toContain('setDeleteFeedbackEnabled(!next);');
    expect(SETTINGS).toContain('音效开关未保存');
  });

  it('明确写出与组间休息提醒互不影响', () => {
    expect(SETTINGS).toContain('不影响');
    expect(SETTINGS).toContain('组间休息提醒');
  });
});

describe('F11 原生接线：真实注册、真实系统 API、最小权限面', () => {
  it('MainActivity 注册了独立插件，且原有插件保持注册', () => {
    expect(MAIN_ACTIVITY).toContain('registerPlugin(DeletionFeedbackPlugin.class);');
    expect(MAIN_ACTIVITY).toContain('registerPlugin(RestReminderPlugin.class);');
    expect(MAIN_ACTIVITY).toContain('registerPlugin(NativeFileBridgePlugin.class);');
    // 注册必须在 super.onCreate 之前（Capacitor 在 onCreate 里加载插件表）
    expect(MAIN_ACTIVITY.indexOf('registerPlugin(DeletionFeedbackPlugin.class);')).toBeLessThan(
      MAIN_ACTIVITY.indexOf('super.onCreate(savedInstanceState);'),
    );
  });

  it('JS 调用的每个方法在原生都有 @PluginMethod 实现', () => {
    for (const method of ['play', 'stop', 'prepareHaptic']) {
      expect(FEEDBACK).toContain(`${method}:`);
      const pattern = new RegExp(`@PluginMethod\\s+public void ${method}\\(`);
      expect(pattern.test(PLUGIN), `原生缺少 ${method}`).toBe(true);
    }
    expect(PLUGIN).toContain('name = "DeletionFeedback"');
    expect(FEEDBACK).toContain("registerPlugin<DeleteFeedbackNativeBridge>('DeletionFeedback')");
  });

  it('用真实系统 API 判定（铃声模式 / 勿扰过滤档 / 系统流音量 / 前台）', () => {
    expect(PLUGIN).toContain('am.getRingerMode()');
    expect(PLUGIN).toContain('nm.getCurrentInterruptionFilter()');
    expect(PLUGIN).toContain('am.getStreamVolume(AudioManager.STREAM_SYSTEM)');
    expect(PLUGIN).toContain('isActivityVisible()');
    expect(PLUGIN).toContain('DeleteFeedbackPolicy.decideSound(');
  });

  it('播放使用 USAGE_ASSISTANCE_SONIFICATION（不借 Alarm / 通知流）', () => {
    expect(PLUGIN).toContain('AudioAttributes.USAGE_ASSISTANCE_SONIFICATION');
    expect(PLUGIN_CODE).not.toContain('USAGE_ALARM');
    expect(PLUGIN_CODE).not.toContain('USAGE_NOTIFICATION');
    expect(PLUGIN_CODE).not.toContain('RingtoneManager');
  });

  it('不改系统状态、不申请权限、不碰休息提醒的资源', () => {
    for (const forbidden of [
      'setStreamVolume',
      'setRingerMode',
      'setInterruptionFilter',
      'createNotificationChannel',
      'NotificationChannel',
      'AlarmManager',
      'requestPermissionForAlias',
      'requestPermissions',
      'startForeground',
      'WakeLock',
      'RestReminder',
    ]) {
      expect(PLUGIN_CODE.includes(forbidden), `不应出现 ${forbidden}`).toBe(false);
    }
    expect(PLUGIN_CODE).not.toContain('permissions = {');
  });

  it('异步窗口（加载/延迟播放）在真正出声前重新判定，并被序号作废', () => {
    expect(PLUGIN).toContain('intentSeq.incrementAndGet()');
    expect(PLUGIN).toContain('DeleteFeedbackPolicy.SKIP_INTENT_STALE');
    expect(PLUGIN).toContain('setOnLoadCompleteListener');
    // 加载完成后重新走 startPlay（重新读状态再判一次）
    expect(countOf(PLUGIN, 'startPlay(')).toBeGreaterThanOrEqual(3);
  });

  it('pause/destroy/stop 都清理播放器并作废在途意图（后台不补放）', () => {
    const pauseIdx = PLUGIN.indexOf('protected void handleOnPause()');
    const pauseBody = PLUGIN.slice(pauseIdx, PLUGIN.indexOf('protected void handleOnStop()', pauseIdx));
    expect(pauseBody).toContain('stopPlayback()');
    const destroyIdx = PLUGIN.indexOf('protected void handleOnDestroy()');
    const destroyBody = PLUGIN.slice(destroyIdx, PLUGIN.indexOf('/* ── 成功音', destroyIdx));
    expect(destroyBody).toContain('stopPlayback()');
    expect(destroyBody).toContain('releasePool()');
    // stop() 复用同一段清理（一个真源）
    const stopIdx = PLUGIN_CODE.indexOf('public void stop(PluginCall call)');
    const stopEnd = PLUGIN_CODE.indexOf('private void stopPlayback()', stopIdx);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopEnd).toBeGreaterThan(stopIdx);
    expect(PLUGIN_CODE.slice(stopIdx, stopEnd)).toContain('stopPlayback()');
    // 清理本身：推进序号 + 停流 + 如实回复等待者
    expect(PLUGIN).toContain('intentSeq.incrementAndGet();');
    expect(PLUGIN).toContain('pool.stop(playingStreamId)');
  });

  it('保守失败：未知/异常一律不播（策略类逐项拒绝）', () => {
    expect(POLICY).toContain('SKIP_RINGER_UNKNOWN');
    expect(POLICY).toContain('SKIP_DND_UNKNOWN');
    expect(POLICY).toContain('SKIP_VOLUME_UNKNOWN');
    expect(POLICY).toContain('SKIP_ACTIVITY_NOT_RESUMED');
    expect(POLICY).toContain('SKIP_SOUND_NOT_READY');
    // 判定类不 import Android（纯 JVM 可测的前提）
    expect(POLICY).not.toContain('import android.');
  });

  it('原生音效来自 res/raw 的离线 WAV（不是系统音效、不是网络）', () => {
    expect(PLUGIN).toContain('R.raw.delete_success');
    expect(PLUGIN_CODE).not.toContain('DEFAULT_NOTIFICATION_URI');
    expect(PLUGIN_CODE).not.toContain('Ringtone');
  });
});

describe('F11 音效资产：可复现、双目标同源、离线', () => {
  const webAsset = resolve(APP, 'public/audio/delete-success.wav');
  const nativeAsset = resolve(APP, 'android/app/src/main/res/raw/delete_success.wav');

  it('两个目标都存在且逐字节相同（同源）', () => {
    expect(existsSync(webAsset)).toBe(true);
    expect(existsSync(nativeAsset)).toBe(true);
    const a = readFileSync(webAsset);
    const b = readFileSync(nativeAsset);
    expect(a.equals(b)).toBe(true);
    const sha = createHash('sha256').update(a).digest('hex');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash('sha256').update(b).digest('hex')).toBe(sha);
  });

  it('是合法 PCM WAV：单声道 / 16bit / 44100Hz / 轻短（≤200ms）', () => {
    const buf = readFileSync(webAsset);
    expect(buf.length).toBeGreaterThan(44);
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(44100);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    const dataBytes = buf.readUInt32LE(40);
    const durationMs = (dataBytes / 2 / 44100) * 1000;
    expect(durationMs).toBeGreaterThan(40);
    expect(durationMs).toBeLessThanOrEqual(200);
    // 峰值有界：不是满刻度的刺耳提示音
    let peak = 0;
    for (let i = 44; i + 1 < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
    expect(peak / 32767).toBeLessThan(0.5);
    expect(peak).toBeGreaterThan(1000);
  });

  it('产物与源码公式完全一致（拒绝手改 wav 字节）', () => {
    // 用真实生成器自检：--check 只比较、不写文件
    const out = execFileSync(process.execPath, [resolve(APP, 'scripts/gen-delete-sound.mjs'), '--check'], {
      encoding: 'utf8',
      cwd: APP,
    });
    expect(out).toContain('OK');
    expect(out).not.toContain('DIFF');
  });

  it('运行时不需要联网取音频（相对应用根拼 URL，不走任何远程地址）', () => {
    expect(FEEDBACK).toContain("DELETE_SOUND_PATH = 'audio/delete-success.wav'");
    expect(FEEDBACK).toContain('resolveDeleteSoundUrl');
    // 注释里允许出现示例地址；只看代码
    expect(stripBlockComments(FEEDBACK)).not.toMatch(/https?:\/\//);
    expect(FEEDBACK).not.toContain('XMLHttpRequest');
    expect(FEEDBACK).not.toContain('wss://');
  });

  it('资源放在 public/ 下（构建原样复制，测试工具无需 wav loader）', () => {
    expect(existsSync(resolve(APP, 'public/audio/delete-success.wav'))).toBe(true);
    expect(existsSync(resolve(APP, 'src/assets/audio/delete-success.wav'))).toBe(false);
    // 不允许回到 bundler asset import：那会让 esbuild 工装整体失败
    expect(FEEDBACK).not.toMatch(/from '\.\.\/assets\//);
    expect(FEEDBACK).not.toContain('?url');
  });
});

/* ── F11-FIX1：提交凭证 / 归属清理 / 去重范围 的静态接线护栏 ───────── */

describe('F11-FIX1 源码接线：凭证必须在提交前捕获', () => {
  const commitDelete = callbackBody(SESSION, 'const commitDelete = useCallback(');

  it('Session 在命令发出前捕获音频凭证，并在 saved 出口带回去验证', () => {
    expect(countOf(SESSION, 'captureDeleteFeedbackIntent(')).toBe(1);
    const captureAt = commitDelete.indexOf('captureDeleteFeedbackIntent()');
    const commitAt = commitDelete.indexOf('await commitPaired(');
    const notifyAt = commitDelete.indexOf('notifyDeleteSucceeded(');
    expect(captureAt, '未在 commitDelete 内捕获凭证').toBeGreaterThan(-1);
    // 捕获必须早于真正提交：否则慢事务期间的隐藏/失锁无法被记录
    expect(commitAt).toBeGreaterThan(captureAt);
    expect(notifyAt).toBeGreaterThan(commitAt);
    expect(commitDelete.slice(notifyAt)).toContain('feedbackTicketAtStart');
  });

  it('凭证在保存后仍会被控制器核对（纯函数可离线判定）', () => {
    expect(FEEDBACK).toContain('decideDeleteTicket');
    expect(FEEDBACK).toContain('stale-epoch');
    expect(FEEDBACK).toContain('stale-session');
  });

  it('减少动态不是静音开关：反馈模块从不读 prefers-reduced-motion', () => {
    // F10 的消散可以因减少动态而跳过；F11 的成功音只由开关/归属/可见性/凭证决定
    expect(FEEDBACK).not.toContain('prefersReducedMotion');
    expect(FEEDBACK).not.toContain('matchMedia');
    expect(FEEDBACK).not.toContain('reducedMotion');
  });
});

describe('F11-FIX1 源码接线：清理只作用于自己的 owner', () => {
  it('JS 派发/定向清理都带 owner，页面级收手不带 owner', () => {
    expect(FEEDBACK).toContain('bridge.play({ owner })');
    expect(FEEDBACK).toContain('bridge.stop({ owner })');
    expect(FEEDBACK).toContain('activeNativeOwner');
    // 迟到的旧结果只有在"自己仍是当前 owner"时才允许清理
    expect(FEEDBACK).toContain('if (activeNativeOwner === owner)');
  });

  it('原生 stop 的 owner 分支不推进 intentSeq（旧清理不得作废新意图）', () => {
    const idx = PLUGIN.indexOf('private void stopOwnedPlayback(String owner)');
    expect(idx).toBeGreaterThan(-1);
    const body = PLUGIN.slice(idx, PLUGIN.indexOf('private String readOwner(', idx));
    expect(body).not.toContain('intentSeq.incrementAndGet()');
    expect(PLUGIN).toContain('readOwner(call)');
    expect(PLUGIN).toContain('call.getString("owner")');
    // 页面级语义仍在：不带 owner 的 stop 依旧走完整的 stopPlayback
    expect(body).toContain('takePending()');
    expect(body).toContain('pool.stop(playingStreamId)');
  });

  it('所有清理路径的异步失败都被就地吞掉（不再裸 void bridge.stop()）', () => {
    const code = stripComments(FEEDBACK);
    expect(code).not.toContain('void bridge.stop()');
    expect(code).not.toContain('void bridge?.prepareHaptic()');
    expect(code).toContain('Promise.resolve(result).catch(');
  });
});

describe('F11-FIX1 源码接线：去重不再用小容量淘汰旧 token', () => {
  it('去重按 session 生命周期保留，且封顶时不淘汰旧键', () => {
    expect(FEEDBACK).toContain('MAX_TRACKED_DELETE_TOKENS_PER_SESSION');
    expect(FEEDBACK).toContain('MAX_TRACKED_DELETE_SESSIONS');
    expect(FEEDBACK).toContain('consumedBySession');
    // 旧实现按插入顺序淘汰最旧一个 token —— 那正是"旧成功意图被重放"的成因
    expect(FEEDBACK).not.toContain('playedKeys.values().next()');
    expect(FEEDBACK).toContain('dedup-saturated');
  });
});
