package app.motion.personal;

import android.os.Bundle;
import android.view.ActionMode;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

import app.motion.personal.plugins.CoachStreamPlugin;
import app.motion.personal.plugins.NativeFileBridgePlugin;
import app.motion.personal.plugins.RestReminderPlugin;
import app.motion.personal.plugins.DeletionFeedbackPlugin;

/**
 * MOTION 原生入口。
 *
 * <p>职责：
 * <ol>
 *   <li>注册本地插件 {@link NativeFileBridgePlugin}、{@link RestReminderPlugin}、{@link DeletionFeedbackPlugin}、{@link CoachStreamPlugin}。</li>
 *   <li>保持 WebView 硬件加速与默认 InputConnection（不做 captureInput，保证中文 IME 组合输入正常）。</li>
 *   <li>配合 {@link MotionWebView} 为非输入展示区提供 Activity 级 ActionMode 二次兜底。</li>
 * </ol>
 *
 * <p>返回键统一由 {@code @capacitor/app} 的 backButton 事件交给网页调度。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity.onCreate 里会加载插件表
        registerPlugin(NativeFileBridgePlugin.class);
        // 需求 2：组间休息到时的原生提醒（AlarmManager + 震动 + 通知）
        registerPlugin(RestReminderPlugin.class);
        // F11: 独立删除反馈插件
        registerPlugin(DeletionFeedbackPlugin.class);
        // 0.2.2：电子教练切后台保活原生流式请求桥
        registerPlugin(CoachStreamPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onActionModeStarted(ActionMode mode) {
        super.onActionModeStarted(mode);
        if (mode == null) {
            return;
        }
        Bridge currentBridge = getBridge();
        WebView webView = currentBridge != null ? currentBridge.getWebView() : null;
        if (webView instanceof MotionWebView && !((MotionWebView) webView).isNativeTextUiAllowed()) {
            mode.finish();
        }
    }
}
