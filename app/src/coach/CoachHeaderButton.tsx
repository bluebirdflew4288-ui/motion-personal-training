/* 顶栏统一的 MOTION 风格「教练 / 小窗 / 恢复 / 互换」入口按钮。
   · 触摸热区固定 ≥48×48 CSS px（与内部内容缩放完全解耦）；
   · 当前悬浮小窗已展开时：点按直接执行主次互换；
   · 当前悬浮小窗已最小化或关闭时：点按在当前主屏上打开/原位恢复对应小窗。 */

import { useOptionalDualWindow } from './windowState';

export function CoachHeaderButton({ compact = false }: { compact?: boolean }) {
  const dual = useOptionalDualWindow();
  if (!dual) return null;

  const isMiniOpen = dual.miniVisibility === 'mini';
  const isMinimized = dual.miniVisibility === 'minimized';
  const isCoachPrimary = dual.primaryPane === 'coach';

  const label = isMiniOpen
    ? '互换'
    : isMinimized
      ? '恢复'
      : isCoachPrimary
        ? '小窗'
        : '教练';
  const ariaLabel = isMiniOpen
    ? '互换主屏与小窗'
    : isMinimized
      ? isCoachPrimary
        ? '原位恢复训练小窗'
        : '原位恢复电子教练小窗'
      : isCoachPrimary
        ? '打开训练小窗'
        : '打开电子教练小窗';

  return (
    <button
      type="button"
      className={`coach-header-btn${isMiniOpen ? ' is-swap' : ''}${compact ? ' is-compact' : ''}`}
      data-testid="coach-header-btn"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => {
        if (isMiniOpen) {
          dual.swapPanes();
        } else if (isMinimized) {
          dual.restoreFromMinimized();
        } else {
          dual.openMiniWindow();
        }
      }}
    >
      <span className="coach-header-ico" aria-hidden="true">
        {isMiniOpen ? '⇄' : '✦'}
      </span>
      <span className="coach-header-txt">{label}</span>
    </button>
  );
}
