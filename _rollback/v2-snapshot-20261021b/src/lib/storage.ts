/* 键盘与视口处理：让底部固定按钮不被软键盘盖住。
   iOS Safari 不缩小视口时用 visualViewport 计算键盘占位。 */

let cleanup: (() => void) | null = null;

export function installViewportGuard(): () => void {
  if (cleanup) return cleanup;
  const root = document.documentElement;

  const update = () => {
    const vv = window.visualViewport;
    let inset = 0;
    if (vv) {
      // 键盘高度 ≈ 布局视口高度 - 可视视口高度 - 页面滚动偏移
      const diff = window.innerHeight - vv.height - vv.offsetTop;
      inset = Math.max(0, Math.round(diff));
      if (inset < 80) inset = 0; // 浏览器工具栏滚动也会产生小差值，忽略
    }
    root.style.setProperty('--kb-inset', `${inset}px`);
  };

  update();
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('resize', update);

  cleanup = () => {
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    window.removeEventListener('orientationchange', update);
    window.removeEventListener('resize', update);
    root.style.removeProperty('--kb-inset');
    cleanup = null;
  };
  return cleanup;
}
