import { Sheet } from './Sheet';

interface Props {
  open: boolean;
  title: string;
  body: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
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
  onConfirm,
  onCancel,
}: Props) {
  return (
    <Sheet
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            style={{ flex: 1 }}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      }
    >
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--ink-2)' }}>{body}</p>
    </Sheet>
  );
}
