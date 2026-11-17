package app.motion.personal.plugins;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

/**
 * F11：删除成功音/准备触感的**纯策略矩阵**测试（纯 JVM，不触碰 Android API）。
 *
 * <h2>覆盖</h2>
 * <ul>
 *   <li>正常响铃 + 勿扰全部允许 + 前台 + 系统流音量 &gt; 0 + 已加载 → 允许；</li>
 *   <li>静音、振动、勿扰（优先级/仅闹钟/完全静音）、未知过滤档、查询为 null、
 *       超范围数值 → 一律不允许，并给出稳定原因；</li>
 *   <li>后台（resumed=false/null）、音量为 0 或未知、音效未加载完 → 不允许；</li>
 *   <li>触感矩阵：无马达/静音/振动/勿扰/未知 → 不震；只有全部已知允许才震；</li>
 *   <li>常量与官方文档字面值一致（用反射对拍 AudioManager/NotificationManager 常量
 *       是设备侧的事，这里锁定"源码里写死的值"不被误改）。</li>
 * </ul>
 *
 * <p><b>证据边界</b>：本测试证明的是**判定函数**的行为，不证明 Android 运行时
 * 真的这样返回；真实设备上的铃声/勿扰听感仍需单独真机验收（本轮 UNVERIFIED）。
 * 同样，它不证明 SoundPool 真的发声。
 */
public final class DeleteFeedbackPolicyTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) throws Exception {
        // ── 允许：所有已知条件齐全 ───────────────────────────
        checkAllow("正常响铃+勿扰全部允许+前台+音量7+已加载 → 允许",
            DeleteFeedbackPolicy.decideSound(2, 1, true, 7, true));

        // ── 铃声模式 ────────────────────────────────────────
        checkSkip("静音 → 不播（ringer-silent）",
            DeleteFeedbackPolicy.decideSound(0, 1, true, 7, true),
            DeleteFeedbackPolicy.SKIP_RINGER_SILENT);
        checkSkip("振动 → 不播（ringer-vibrate）",
            DeleteFeedbackPolicy.decideSound(1, 1, true, 7, true),
            DeleteFeedbackPolicy.SKIP_RINGER_VIBRATE);
        checkSkip("铃声模式未知(null) → 不播",
            DeleteFeedbackPolicy.decideSound(null, 1, true, 7, true),
            DeleteFeedbackPolicy.SKIP_RINGER_UNKNOWN);
        checkSkip("铃声模式越界(9) → 不播",
            DeleteFeedbackPolicy.decideSound(9, 1, true, 7, true),
            DeleteFeedbackPolicy.SKIP_RINGER_UNKNOWN);

        // ── 勿扰过滤档 ──────────────────────────────────────
        checkSkip("勿扰=优先级(2) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 2, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_ACTIVE);
        checkSkip("勿扰=完全静音(3) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 3, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_ACTIVE);
        checkSkip("勿扰=仅闹钟(4) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 4, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_ACTIVE);
        checkSkip("勿扰=未知(0) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 0, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_UNKNOWN);
        checkSkip("勿扰查询失败(null) → 不播",
            DeleteFeedbackPolicy.decideSound(2, null, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_UNKNOWN);
        checkSkip("勿扰返回越界(7) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 7, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_UNKNOWN);
        checkSkip("勿扰返回负数(-1) → 不播",
            DeleteFeedbackPolicy.decideSound(2, -1, true, 7, true),
            DeleteFeedbackPolicy.SKIP_DND_UNKNOWN);

        // ── 前台 ───────────────────────────────────────────
        checkSkip("有声音但 Activity 已不在前台 → 不播",
            DeleteFeedbackPolicy.decideSound(2, 1, false, 7, true),
            DeleteFeedbackPolicy.SKIP_ACTIVITY_NOT_RESUMED);
        checkSkip("前台状态未知(null) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 1, null, 7, true),
            DeleteFeedbackPolicy.SKIP_ACTIVITY_NOT_RESUMED);

        // ── 音量 ───────────────────────────────────────────
        checkSkip("系统流音量为 0 → 不播",
            DeleteFeedbackPolicy.decideSound(2, 1, true, 0, true),
            DeleteFeedbackPolicy.SKIP_VOLUME_ZERO);
        checkSkip("音量未知(null) → 不播",
            DeleteFeedbackPolicy.decideSound(2, 1, true, null, true),
            DeleteFeedbackPolicy.SKIP_VOLUME_UNKNOWN);

        // ── 加载态 ─────────────────────────────────────────
        checkSkip("音效尚未加载完成 → 不播（先加载，不抢跑）",
            DeleteFeedbackPolicy.decideSound(2, 1, true, 7, false),
            DeleteFeedbackPolicy.SKIP_SOUND_NOT_READY);

        // ── 多因素同时不满足：顺序稳定（前台优先）───────────
        checkSkip("后台+静音 → 先报前台原因",
            DeleteFeedbackPolicy.decideSound(0, 3, false, 0, false),
            DeleteFeedbackPolicy.SKIP_ACTIVITY_NOT_RESUMED);
        checkSkip("静音+勿扰 → 先报铃声原因",
            DeleteFeedbackPolicy.decideSound(0, 3, true, 7, true),
            DeleteFeedbackPolicy.SKIP_RINGER_SILENT);

        // ── 触感矩阵 ───────────────────────────────────────
        DeleteFeedbackPolicy.Decision hapticOk =
            DeleteFeedbackPolicy.decideHaptic(2, 1, true, true);
        check("触感：全部已知允许 → 震", hapticOk.allow);
        check("触感：允许原因稳定", DeleteFeedbackPolicy.HAPTIC_ALLOW.equals(hapticOk.reason));
        checkSkip("触感：无马达 → 不震",
            DeleteFeedbackPolicy.decideHaptic(2, 1, true, false),
            DeleteFeedbackPolicy.HAPTIC_SKIP_NO_VIBRATOR);
        checkSkip("触感：静音 → 不震",
            DeleteFeedbackPolicy.decideHaptic(0, 1, true, true),
            DeleteFeedbackPolicy.HAPTIC_SKIP_RINGER_SILENT);
        checkSkip("触感：振动模式 → 未知态不震（保守）",
            DeleteFeedbackPolicy.decideHaptic(1, 1, true, true),
            DeleteFeedbackPolicy.HAPTIC_SKIP_STATE_UNKNOWN);
        checkSkip("触感：勿扰 → 不震",
            DeleteFeedbackPolicy.decideHaptic(2, 2, true, true),
            DeleteFeedbackPolicy.HAPTIC_SKIP_DND_ACTIVE);
        checkSkip("触感：后台 → 不震",
            DeleteFeedbackPolicy.decideHaptic(2, 1, false, true),
            DeleteFeedbackPolicy.HAPTIC_SKIP_ACTIVITY_NOT_RESUMED);
        checkSkip("触感：状态未知 → 不震",
            DeleteFeedbackPolicy.decideHaptic(null, null, true, true),
            DeleteFeedbackPolicy.HAPTIC_SKIP_STATE_UNKNOWN);
        check("触感时长 = 20ms（一次轻震）", DeleteFeedbackPolicy.PREPARE_VIBRATE_MS == 20);

        // ── 常量锁定（被误改会导致判定与官方值不符）──────────
        check("RINGER_SILENT=0", DeleteFeedbackPolicy.RINGER_SILENT == 0);
        check("RINGER_VIBRATE=1", DeleteFeedbackPolicy.RINGER_VIBRATE == 1);
        check("RINGER_NORMAL=2", DeleteFeedbackPolicy.RINGER_NORMAL == 2);
        check("FILTER_ALL=1", DeleteFeedbackPolicy.FILTER_ALL == 1);
        check("FILTER_PRIORITY=2", DeleteFeedbackPolicy.FILTER_PRIORITY == 2);
        check("FILTER_NONE=3", DeleteFeedbackPolicy.FILTER_NONE == 3);
        check("FILTER_ALARMS=4", DeleteFeedbackPolicy.FILTER_ALARMS == 4);
        check("FILTER_UNKNOWN=0（getCurrentInterruptionFilter 的未知值）",
            DeleteFeedbackPolicy.FILTER_UNKNOWN == 0);

        // ── 纯判定类不得持有 Android 依赖（可离线编译的前提）──
        Method[] methods = DeleteFeedbackPolicy.class.getDeclaredMethods();
        boolean hasAndroidParam = false;
        for (Method m : methods) {
            for (Class<?> p : m.getParameterTypes()) {
                if (p.getName().startsWith("android.")) hasAndroidParam = true;
            }
            if (!Modifier.isStatic(m.getModifiers()) && !m.isSynthetic()) {
                // 只允许私有构造之外的实例方法为空（本类是纯静态工具）
                check("策略类不暴露实例方法: " + m.getName(), false);
            }
        }
        check("判定方法不含 android.* 参数（纯 JVM 可测）", !hasAndroidParam);

        System.out.println();
        System.out.println("DeleteFeedbackPolicyTest: pass=" + pass + " fail=" + fail);
        if (fail > 0) {
            System.out.println("✘ DeleteFeedbackPolicyTest 失败 " + fail + " 项");
            System.exit(1);
        }
        System.out.println("✔ DeleteFeedbackPolicyTest 全部通过");
    }

    private static void checkAllow(String name, DeleteFeedbackPolicy.Decision d) {
        check(name, d.allow && DeleteFeedbackPolicy.ALLOW.equals(d.reason));
    }

    private static void checkSkip(String name, DeleteFeedbackPolicy.Decision d, String expected) {
        check(name + "（实际：" + d.reason + "）", !d.allow && expected.equals(d.reason));
    }

    private static void check(String name, boolean ok) {
        if (ok) {
            pass++;
            System.out.println("  ✔ " + name);
        } else {
            fail++;
            System.out.println("  ✘ " + name);
        }
    }
}
