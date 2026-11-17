package app.motion.personal.plugins;

/**
 * G04：WebView 文本选择菜单 / 原生长按 / 原生拖拽门禁的纯策略矩阵测试（纯 JVM）。
 *
 * <p>证据边界：证明 {@link WebViewSelectionPolicy} 的状态迁移与判定逻辑在各组合下符合预期，
 * 不冒充荣耀真机系统菜单/任意门验收。
 */
public final class WebViewSelectionPolicyTest {

    private static int pass = 0;
    private static int fail = 0;

    private static void check(String name, boolean cond) {
        if (cond) {
            pass++;
        } else {
            fail++;
            System.err.println("  ✘ FAIL: " + name);
        }
    }

    public static void main(String[] args) {
        final int EDIT = WebViewSelectionPolicy.HIT_TEST_EDIT_TEXT_TYPE;
        final int UNKNOWN = 0;
        final int OTHER = 5;

        check("EDIT_TEXT_TYPE 常量值为 9", EDIT == 9);

        // 1. 初始空闲态：非输入命中拒绝，输入框命中允许
        int s = 0;
        check("初始态 + UNKNOWN_TYPE → 拒绝原生选词菜单", !WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));
        check("初始态 + 图片/链接类型 → 拒绝原生选词菜单", !WebViewSelectionPolicy.allowNativeTextUi(OTHER, s));
        check("初始态 + EDIT_TEXT_TYPE（直接长按未聚焦输入框粘贴）→ 允许", WebViewSelectionPolicy.allowNativeTextUi(EDIT, s));

        // 2. 触摸落在非编辑展示区（卡片标题/空白）：即便此前有输入框焦点也必须拒绝
        s = WebViewSelectionPolicy.withFocusEditable(0, true);
        check("无活动触摸 + 输入框已聚焦 → 允许（如手柄调整后重定位菜单）", WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));

        s = WebViewSelectionPolicy.withTouchEditable(s, false);
        check("输入框仍聚焦但当前手指按在卡片展示区 → 拒绝原生菜单与拖拽", !WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));
        check("若原生 HitTest 明确为输入框则仍允许", WebViewSelectionPolicy.allowNativeTextUi(EDIT, s));

        // 3. 触摸结束/取消后恢复按当前焦点裁决
        s = WebViewSelectionPolicy.withTouchCleared(s);
        check("触摸清除后保留焦点位 → 聚焦输入框恢复允许", WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));

        s = WebViewSelectionPolicy.withFocusEditable(s, false);
        check("失焦且无触摸 → 拒绝", !WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));

        // 4. 触摸落在可编辑控件（如 contenteditable 或 input，HitTest 尚未同步为 9 时）
        s = WebViewSelectionPolicy.withTouchEditable(0, true);
        check("触摸落在可编辑控件 + UNKNOWN_TYPE → 允许", WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));
        s = WebViewSelectionPolicy.withTouchCleared(s);
        check("未聚焦下触摸抬起后回到拒绝", !WebViewSelectionPolicy.allowNativeTextUi(UNKNOWN, s));

        System.out.println("  ✔ WebViewSelectionPolicyTest: " + pass + " passed, " + fail + " failed");
        if (fail > 0) {
            System.exit(1);
        }
    }
}
