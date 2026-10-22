import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/zine.css';
import { App } from './App';
import { StoreProvider } from './store';
import { registerSW } from './swRegister';
import { isNativeBuild } from './lib/platform';
import { installNativeFileBridge } from './lib/nativeFileBridge';
import { installNativeBackHandler } from './lib/nativeBack';

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 挂载点');

/**
 * 构建目标差异（施工要求 A/B）：
 *  · Android 原生包**不注册 Service Worker** —— APK 已自带本次构建的全部资源，
 *    再注册 SW 只会让上一次安装留下的旧缓存盖掉新资源。
 *    注意这里不是“清缓存”：不 unregister、不删 caches，只是本次构建不注册。
 *  · Web 版保持原有行为（含离线预缓存）。
 */
if (!isNativeBuild) {
  registerSW();
}

// 原生文件桥（JSON 备份的系统保存/选择）：浏览器里是空操作
installNativeFileBridge();

/**
 * Android 原生返回键：先关最上层弹层 → 收键盘 → 页面离开守卫 → 页面返回 → 首页退出。
 * 导航**只发生在 nativeBack.handleBackIntent 的最后一处**（A03）：
 * 这里不再注册任何“栈空就导航”的页面兜底，避免绕过离页守卫。
 */
installNativeBackHandler();

createRoot(el).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
