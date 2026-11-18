package app.motion.personal;

import android.annotation.SuppressLint;
import android.content.Context;
import android.util.AttributeSet;
import android.view.ActionMode;
import android.view.DragEvent;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.webkit.JavascriptInterface;

import com.getcapacitor.CapacitorWebView;

import java.util.concurrent.atomic.AtomicInteger;

import app.motion.personal.plugins.WebViewSelectionPolicy;

/**
 * MOTION 专用 WebView：继承 {@link CapacitorWebView} 完整保留其中文 IME 与插件桥行为，
 * 仅针对非文本输入区阻断原生长按、系统浮动选词菜单（ActionMode）与原生拖拽（如荣耀任意门）。
 */
public class MotionWebView extends CapacitorWebView {

    private final AtomicInteger selectionGuardState = new AtomicInteger(0);

    public MotionWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        initSelectionGuard();
    }

    @SuppressLint("JavascriptInterface")
    private void initSelectionGuard() {
        addJavascriptInterface(new JsSelectionGuard(), "__motionSelectionGuard");
        addJavascriptInterface(new JsHapticsBridge(), "__motionHaptics");
    }

    /** 判定当前操作是否位于允许原生选词/复制粘贴的文本输入控件中。 */
    public boolean isNativeTextUiAllowed() {
        int hitType = HitTestResult.UNKNOWN_TYPE;
        try {
            HitTestResult hit = getHitTestResult();
            if (hit != null) {
                hitType = hit.getType();
            }
        } catch (Throwable ignored) {
            // 保守回退到前端同步状态
        }
        return WebViewSelectionPolicy.allowNativeTextUi(hitType, selectionGuardState.get());
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        boolean handled = super.onTouchEvent(event);
        if (event != null) {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                selectionGuardState.updateAndGet(WebViewSelectionPolicy::withTouchCleared);
            }
        }
        return handled;
    }

    @Override
    public boolean performLongClick() {
        if (!isNativeTextUiAllowed()) {
            return true;
        }
        return super.performLongClick();
    }

    @Override
    public boolean performLongClick(float x, float y) {
        if (!isNativeTextUiAllowed()) {
            return true;
        }
        return super.performLongClick(x, y);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback) {
        if (!isNativeTextUiAllowed()) {
            clearDomSelectionQuietly();
            return null;
        }
        return super.startActionMode(callback);
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
        if (!isNativeTextUiAllowed()) {
            clearDomSelectionQuietly();
            return null;
        }
        return super.startActionMode(callback, type);
    }

    @Override
    public boolean dispatchDragEvent(DragEvent event) {
        if (!isNativeTextUiAllowed()) {
            try {
                cancelDragAndDrop();
            } catch (Throwable ignored) {
                // 无活动本视图拖拽时忽略
            }
            return false;
        }
        return super.dispatchDragEvent(event);
    }

    private void clearDomSelectionQuietly() {
        post(() -> {
            try {
                evaluateJavascript(
                    "try{var s=window.getSelection();if(s&&s.rangeCount)s.removeAllRanges();}catch(e){}",
                    null
                );
            } catch (Throwable ignored) {
                // WebView 销毁期间忽略
            }
        });
    }

    private final class JsSelectionGuard {
        @JavascriptInterface
        public void setTouchEditable(boolean editable) {
            selectionGuardState.updateAndGet(s -> WebViewSelectionPolicy.withTouchEditable(s, editable));
        }

        @JavascriptInterface
        public void clearTouch() {
            selectionGuardState.updateAndGet(WebViewSelectionPolicy::withTouchCleared);
        }

        @JavascriptInterface
        public void setFocusEditable(boolean editable) {
            selectionGuardState.updateAndGet(s -> WebViewSelectionPolicy.withFocusEditable(s, editable));
        }
    }

    private final class JsHapticsBridge {
        @JavascriptInterface
        public void dragLift() {
            post(() -> {
                try {
                    if (isAttachedToWindow() && getWindowVisibility() == VISIBLE) {
                        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
                    }
                } catch (Throwable ignored) {
                    // 系统触感不可用时静默忽略
                }
            });
        }
    }
}
