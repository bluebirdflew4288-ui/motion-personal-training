import { useRef, useState } from 'react';
import { MAX_SETUP_NOTE } from '../domain/limits';
import { parseSetupNote } from '../domain/setupNote';
import { Sheet } from './Sheet';

export function SetupNoteTag({
  note,
  onClick,
}: {
  note: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      data-testid="setup-note-tag"
      aria-label={`编辑器械档位 ${note}`}
      onClick={onClick}
      style={{
        display: 'block',
        maxWidth: '100%',
        minHeight: 28,
        marginTop: 2,
        padding: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textAlign: 'left',
        fontSize: 12,
        color: 'var(--ink-3)',
      }}
    >
      {note}
    </button>
  );
}

export function SetupNoteSheet({
  exerciseName,
  initial,
  revision,
  onClose,
  onSave,
}: {
  exerciseName: string;
  initial?: string;
  revision?: number;
  onClose: () => void;
  onSave: (note: string | undefined) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const openedRevision = useRef(revision).current;

  async function save() {
    if (savingRef.current) return;
    if (revision !== openedRevision) {
      setError('这条档位备忘已更新，请重新打开');
      return;
    }
    const parsed = parseSetupNote(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await onSave(parsed.note);
      if (result.ok) onClose();
      else setError(result.message ?? '保存失败，请重试');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <Sheet open title={`器械档位 · ${exerciseName}`} onClose={() => {
      if (!savingRef.current) onClose();
    }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label htmlFor="setup-note-input" className="mono-label">档位备忘</label>
        <input
          id="setup-note-input"
          className="input"
          type="text"
          maxLength={MAX_SETUP_NOTE}
          placeholder="例如 座椅 4 · 胸垫 2"
          value={text}
          disabled={saving}
          onChange={(event) => setText(event.target.value)}
          style={{ width: '100%', minHeight: 44, marginTop: 6 }}
        />
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>同一个动作会在其他计划里显示这条备忘。清空后保存即可移除。</p>
        {error && <p role="alert" style={{ color: 'var(--brick)' }}>{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? '保存中…' : '保存器械档位'}
        </button>
      </form>
    </Sheet>
  );
}
