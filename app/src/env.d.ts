/* 构建期注入的编译常量（见 vite.config.ts 的 define）。
   __MOTION_NATIVE__ = true 表示本次产物是打进 APK 的原生容器构建。 */

declare const __MOTION_NATIVE__: boolean;
declare const __MOTION_BUILD_TARGET__: 'web' | 'android';
