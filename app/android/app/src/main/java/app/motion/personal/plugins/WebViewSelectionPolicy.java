package app.motion.personal.plugins;

/**
 * WebView 文本选择菜单、原生长按与系统拖拽门禁的纯策略判定（不依赖 Android API，纯 JVM 可测）。
 *
 * <p>设计目标：
 * <ul>
 *   <li>非输入展示区（卡片、标题、热身、空白容器等）：阻断 Android WebView 的原生长按、
 *       浮动文本选择菜单（ActionMode：复制/全选/AI 帮写）与原生拖拽（startDragAndDrop / 荣耀任意门），
 *       避免 500ms 系统长按打断网页 340ms 卡片拖拽排序或残留空选区。</li>
 *   <li>文本输入控件（input / textarea / contenteditable）：完整放行原生长按选词、复制粘贴菜单与中文输入法。</li>
 * </ul>
 */
public final class WebViewSelectionPolicy {

    /** 对应 {@code android.webkit.WebView.HitTestResult.EDIT_TEXT_TYPE} 的稳定常量值。 */
    public static final int HIT_TEST_EDIT_TEXT_TYPE = 9;

    public static final int STATE_TOUCH_ACTIVE = 1;
    public static final int STATE_TOUCH_EDITABLE = 1 << 1;
    public static final int STATE_FOCUS_EDITABLE = 1 << 2;

    private WebViewSelectionPolicy() {}

    /** 记录一次触摸落点是否位于可编辑文本控件上（原子更新触摸位，保留焦点位）。 */
    public static int withTouchEditable(int currentState, boolean editable) {
        int next = currentState | STATE_TOUCH_ACTIVE;
        if (editable) {
            next |= STATE_TOUCH_EDITABLE;
        } else {
            next &= ~STATE_TOUCH_EDITABLE;
        }
        return next;
    }

    /** 触摸结束或取消时清除当前触摸标志（保留焦点位）。 */
    public static int withTouchCleared(int currentState) {
        return currentState & ~(STATE_TOUCH_ACTIVE | STATE_TOUCH_EDITABLE);
    }

    /** 更新当前 DOM 焦点是否位于可编辑文本控件上（保留触摸位）。 */
    public static int withFocusEditable(int currentState, boolean editable) {
        if (editable) {
            return currentState | STATE_FOCUS_EDITABLE;
        }
        return currentState & ~STATE_FOCUS_EDITABLE;
    }

    /**
     * 判定当前是否允许触发原生文本选择菜单 / 原生长按 / 原生拖拽。
     *
     * @param hitTestType WebView.getHitTestResult().getType()
     * @param state       由 {@code withTouchEditable / withTouchCleared / withFocusEditable} 维护的位掩码
     */
    public static boolean allowNativeTextUi(int hitTestType, int state) {
        // 1. 原生命中测试已确认落在输入框（含尚未获得焦点的 input/textarea 直接长按粘贴）：一律放行
        if (hitTestType == HIT_TEST_EDIT_TEXT_TYPE) {
            return true;
        }
        // 2. 当前有进行中的触摸序列：严格按本次触摸落点是否为可编辑控件裁决
        //    （避免此前某个输入框仍聚焦时，用户直接去长按另一张卡片展示区却误放行系统菜单）
        if ((state & STATE_TOUCH_ACTIVE) != 0) {
            return (state & STATE_TOUCH_EDITABLE) != 0;
        }
        // 3. 无活动触摸记录（如松手后选择手柄调整重定位菜单、外接键盘/无障碍触发）：按当前焦点裁决
        return (state & STATE_FOCUS_EDITABLE) != 0;
    }
}
