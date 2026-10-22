/* MOTION · Capacitor 原生容器配置（Android 打包专用）。
   ── 硬约束（施工要求 A/B）─────────────────────────────────────
   1. `webDir` 指向**本次 Android 专用**构建目录 `dist-android`，
      不覆盖正在服务的 dist / dist-v2…dist-v8。
   2. **不配置 `server.url`**：APK 必须自带全部资源并离线冷启动，
      不得依赖 192.168.* / localhost / 任何公网地址。
      （Capacitor 用**稳定的本地 origin**，由 WebView 内部映射到应用自带 assets，
      不是 file://；IndexedDB/localStorage 都挂在这个稳定 origin 下，覆盖安装数据仍在。）
   3. 不注册 Service Worker（原生构建由构建脚本剔除注册调用，
      这里同时把 WebView 的 SW 桥接关掉），避免旧缓存盖掉 APK 自带的新资源。
   4. 状态栏样式交给 @capacitor/status-bar；安全区（L02）：
      SystemBars 注入 `--safe-area-inset-*`，src/styles/tokens.css 用
      `var(--safe-area-inset-*, env(safe-area-inset-*, 0px))` 映射到 `--safe-*`。
      WebView>=140+cover 分支注入真实值；旧 WebView 走 native padding、注入 0，
      两个分支都只加一次，不会双加。
      （0.1.0 时 tokens.css 只用 env()、并未接这个注入 —— 本轮补上。） */

import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.motion.personal',
  appName: 'MOTION',
  webDir: 'dist-android',
  // 原生容器里不需要 zoom；页面自身已有 viewport 控制
  zoomEnabled: false,
  // 深色/浅色由应用内主题控制，WebView 背景色与纸张底色一致，避免启动白闪
  backgroundColor: '#f4efe2',
  android: {
    // 禁止把 Service Worker 请求转给 Capacitor 桥（原生包不使用 SW）
    resolveServiceWorkerRequests: false,
    // 允许 WebView 调试仅限 debug 构建；release 不开启
    webContentsDebuggingEnabled: false,
    // 安全区：保持 SystemBars 默认 insetsHandling='css'（不在此覆盖），
    // 它会把 insets 注入 --safe-area-inset-*；页面侧消费见 src/styles/tokens.css
  },
  plugins: {
    // 返回键由我们自己的 handler 统一调度（先关弹层 → 收键盘 → 页面返回）
    App: {
      disableBackButtonHandler: false,
    },
  },
};

export default config;
