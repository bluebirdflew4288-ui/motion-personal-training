/* 运行环境判定与原生能力探测。
   ── 为什么单独成文件 ──────────────────────────────────────
   1. 构建期常量 `__MOTION_NATIVE__`（vite define）只说明“这次产物是打进 APK 的”，
      不代表当前一定跑在能力完整的原生容器里；
   2. 运行期还要看 Capacitor 是否真的可用（Web 版 / 浏览器里没有 Capacitor 对象）。
   两者**都要**成立才走原生文件桥，否则退回网页既有实现。
   这样同一份源码在浏览器里行为不变，不会因为“看起来像原生”而误调不存在的插件。 */

/** 本次构建是否是 Android 原生容器构建（编译期决定） */
export const isNativeBuild: boolean = typeof __MOTION_NATIVE__ !== 'undefined' ? __MOTION_NATIVE__ : false;

/** 构建目标名（'web' | 'android'），用于设置页展示与诊断 */
export const buildTarget: 'web' | 'android' =
  typeof __MOTION_BUILD_TARGET__ !== 'undefined' ? __MOTION_BUILD_TARGET__ : 'web';

interface CapacitorLike {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function cap(): CapacitorLike | undefined {
  return (globalThis as { Capacitor?: CapacitorLike }).Capacitor;
}

/** 当前是否真的运行在原生容器里（运行时判定，不是构建期猜测） */
export function isNativePlatform(): boolean {
  const c = cap();
  if (!c || typeof c.isNativePlatform !== 'function') return false;
  try {
    return c.isNativePlatform() === true;
  } catch {
    return false;
  }
}

/** 原生文件桥是否可用：构建目标是 android 且运行期确实在原生容器里 */
export function hasNativeFileBridge(): boolean {
  return isNativeBuild && isNativePlatform();
}

/** 当前平台名（'android' / 'ios' / 'web'），仅用于文案与日志 */
export function platformName(): string {
  const c = cap();
  if (!c || typeof c.getPlatform !== 'function') return 'web';
  try {
    return c.getPlatform() ?? 'web';
  } catch {
    return 'web';
  }
}
