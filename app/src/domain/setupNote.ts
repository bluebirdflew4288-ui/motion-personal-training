import { MAX_SETUP_NOTE } from './limits';

export function parseSetupNote(value: unknown):
  | { ok: true; note?: string }
  | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== 'string' || /[\r\n\u2028\u2029]/.test(value)) {
    return { ok: false, message: '器械档位必须是单行文字' };
  }
  if (value.length > MAX_SETUP_NOTE) {
    return { ok: false, message: `器械档位最多 ${MAX_SETUP_NOTE} 字` };
  }
  const note = value.trim();
  return note ? { ok: true, note } : { ok: true };
}

export function withSetupNote<T extends { setupNote?: string }>(value: T, note: string | undefined): T {
  const next = { ...value };
  if (note) next.setupNote = note;
  else delete next.setupNote;
  return next;
}

export function setupNoteFor(
  exercise: { setupNote?: string },
  template: { setupNote?: string } | undefined,
): string | undefined {
  return template ? template.setupNote : exercise.setupNote;
}
