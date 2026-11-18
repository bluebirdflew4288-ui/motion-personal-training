/* Wave 1A.1：长按拖拽起浮轻触感桥接。
   · Android 侧通过 MotionWebView.__motionHaptics.dragLift() 调用
     View.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)，
     无需额外系统权限，且天然服从系统「触摸反馈/触感」总开关；
   · Web / 桌面浏览器安全降级为 no-op（不调用 navigator.vibrate，遵守 F11 单通道约束）。 */

interface NativeHapticsBridge {
  dragLift?: () => void;
}

export function triggerDragLiftHaptic(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = (window as unknown as { __motionHaptics?: NativeHapticsBridge }).__motionHaptics;
  if (!bridge || typeof bridge.dragLift !== 'function') return false;
  try {
    bridge.dragLift();
    return true;
  } catch {
    return false;
  }
}
