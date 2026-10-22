import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 两个构建目标：
 *   web     —— 普通网页/PWA（保持原有 Service Worker 行为，默认值）
 *   android —— Capacitor 原生容器（MOTION_TARGET=android）
 *
 * 原生构建的差异只有一处编译期常量 `__MOTION_NATIVE__`：
 *   入口不再注册 Service Worker（APK 已自带全部资源，旧缓存不得盖掉新资源）。
 * 其余业务逻辑、视觉与数据层完全共用同一份源码。
 */
const TARGET = process.env.MOTION_TARGET === 'android' ? 'android' : 'web';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __MOTION_NATIVE__: JSON.stringify(TARGET === 'android'),
    __MOTION_BUILD_TARGET__: JSON.stringify(TARGET),
  },
  build: {
    target: 'es2020',
    // 返工期间：修复版输出到独立目录，避免覆盖正在服务的 dist（v1）
    outDir: process.env.MOTION_OUT_DIR || 'dist-v3',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { host: '0.0.0.0', port: 5199, strictPort: true },
  preview: { host: '0.0.0.0', port: 5199, strictPort: true },
});
