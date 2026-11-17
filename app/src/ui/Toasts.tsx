import { useStore } from '../store';

/**
 * 全局提示条。
 *
 * R02 FIX3（Toast 交互收口）：
 * · 纯文本 ok/info 提示本体**不拦截**下方控件：`pointer-events: none`
 *   由 CSS 的 `.toast` 基础规则提供，气泡仍可见（含 aria-live 语义），
 *   但在 Sheet 底部勾选框上点击会真实落到勾选框，不再被气泡吃掉第一次点击。
 * · 关闭按钮是唯一明确可点的区域（`pointer-events: auto`），仍可关闭提示。
 * · error 气泡保持整条可点关闭（真正需要用户注意/操作），不被全局
 *   pointer-events:none 误伤；UndoStack 的按钮同理保持可点（见 zine.css）。
 */
export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.kind === 'error' ? ' toast-error' : ''}`}
          onClick={t.kind === 'error' ? () => dismissToast(t.id) : undefined}
        >
          <span className="toast-text" style={{ flex: 1 }}>
            {t.text}
          </span>
          <button
            type="button"
            className="toast-dismiss"
            data-testid="toast-dismiss"
            aria-label="关闭提示"
            onClick={(e) => {
              e.stopPropagation();
              dismissToast(t.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}