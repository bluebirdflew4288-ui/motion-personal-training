package app.motion.personal;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import app.motion.personal.plugins.NativeFileBridgePlugin;

/**
 * MOTION 原生入口。
 *
 * <p>这里只做两件事：
 * <ol>
 *   <li>注册本地插件 {@link NativeFileBridgePlugin}（JSON 备份的系统文件保存/选择）。</li>
 *   <li>让 WebView 的硬件加速与输入行为保持默认（不做 captureInput，避免中文 IME 组合输入异常）。</li>
 * </ol>
 *
 * <p>返回键不在这里拦截：统一由 {@code @capacitor/app} 的 backButton 事件交给网页调度，
 * 这样“先关最上层弹层、再收键盘、最后页面返回”的优先级只存在一处真源。
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // 必须在 super.onCreate 之前注册：BridgeActivity.onCreate 里会加载插件表
        registerPlugin(NativeFileBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
