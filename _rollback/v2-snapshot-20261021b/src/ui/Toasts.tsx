import { useStore } from '../store';

export function Toasts() {
  const { toasts, dismissToast } = useStore();
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === 'error' ? ' toast-error' : ''}`} onClick={() => dismissToast(t.id)}>
          <span style={{ flex: 1 }}>{t.text}</span>
          <span aria-hidden="true" style={{ opacity: 0.6, fontSize: 16 }}>
            ×
          </span>
        </div>
      ))}
    </div>
  );
}
