import { Sheet } from './Sheet';

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /**
   * 提交中：两个按钮都禁用，确认按钮显示 busyLabel。
   * 用于删除等异步动作，避免“连续点是”造成重复提交。
   */
  busy?: boolean;
  /** 提交中确认按钮的文案（默认沿用 confirmText） */
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({
  open,
  title,
  body,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Sheet
      data-testid="confirm-sheet"
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" data-testid="confirm-cancel" style={{ flex: 1 }} onClick={onCancel} disabled={busy}>
            {cancelText}
          </button>
          <button
            data-testid="confirm-ok"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            style={{ flex: 1 }}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? confirmText) : confirmText}
          </button>
        </div>
      }
    >
      {/* v0.1.1：正文常含被删对象的名字，长名必须换行而不是把弹层撑宽 */}
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>
        {body}
      </p>
    </Sheet>
  );
}
