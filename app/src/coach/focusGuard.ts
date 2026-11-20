/* 并发焦点与未落盘草稿避让守卫（阶段 2）。
   核心红线：
   · 当用户正在某个 DraftCell / NumberStepper 内编辑（处于 focus 或存在未成型 dirty raw 输入，
     如空串 / "." / "60."），教练写工具若试图改写同一字段，必须拒绝静默覆盖并提示用户先完成输入；
   · 精确到 (exId, setId, field) 粒度：用户在第 3 组输入时，允许教练修改第 2 组或其他动作。 */

export type CoachEditableField = 'reps' | 'weight' | 'note' | 'target' | 'unknown';

export interface FocusEntry {
  sessionId?: string;
  exId: string;
  setId?: string;
  field: CoachEditableField;
}

export interface FocusConflictCheck {
  sessionId?: string;
  exId: string;
  setId?: string;
  fields?: readonly CoachEditableField[];
  /** 为 true 时，同组内任意字段存在未成型 dirty raw 也阻断（防止在半空输入状态下整组标 done） */
  includeDirtyInSet?: boolean;
}

export interface FocusConflictResult {
  conflict: boolean;
  kind?: 'focus' | 'dirty-raw';
  exId?: string;
  setId?: string;
  field?: CoachEditableField;
  message?: string;
}

const focusedMap = new Map<string, FocusEntry>();
const dirtyMap = new Map<string, FocusEntry>();

let runtimeDirtyInspector: ((check: FocusConflictCheck) => FocusEntry[]) | null = null;

function keyOf(entry: FocusEntry): string {
  return `${entry.exId}::${entry.setId ?? ''}::${entry.field}`;
}

export function setRuntimeDirtyInspector(
  inspector: ((check: FocusConflictCheck) => FocusEntry[]) | null,
): void {
  runtimeDirtyInspector = inspector;
}

export function registerFocusedField(entry: FocusEntry): void {
  focusedMap.set(keyOf(entry), entry);
}

export function unregisterFocusedField(entry: FocusEntry): void {
  const k = keyOf(entry);
  const existing = focusedMap.get(k);
  if (!existing) return;
  if (entry.sessionId && existing.sessionId && existing.sessionId !== entry.sessionId) return;
  focusedMap.delete(k);
}

export function setDirtyField(entry: FocusEntry, dirty: boolean): void {
  const k = keyOf(entry);
  if (dirty) dirtyMap.set(k, entry);
  else dirtyMap.delete(k);
}

function normalizeField(raw: string | undefined): CoachEditableField {
  if (raw === 'reps' || raw === 'weight' || raw === 'note' || raw === 'target') return raw;
  return 'unknown';
}

function readDomFocusAndDirty(): Array<{ kind: 'focus' | 'dirty-raw'; entry: FocusEntry }> {
  if (typeof document === 'undefined') return [];
  const out: Array<{ kind: 'focus' | 'dirty-raw'; entry: FocusEntry }> = [];
  const active = document.activeElement;
  if (active && active instanceof HTMLElement && active.dataset.coachExId) {
    out.push({
      kind: 'focus',
      entry: {
        sessionId: active.dataset.coachSessionId || undefined,
        exId: active.dataset.coachExId,
        setId: active.dataset.coachSetId || undefined,
        field: normalizeField(active.dataset.coachField),
      },
    });
  }
  const dirtyNodes = document.querySelectorAll<HTMLElement>('[data-coach-ex-id][data-dirty-raw="true"]');
  dirtyNodes.forEach((node) => {
    const exId = node.dataset.coachExId;
    if (!exId) return;
    out.push({
      kind: 'dirty-raw',
      entry: {
        sessionId: node.dataset.coachSessionId || undefined,
        exId,
        setId: node.dataset.coachSetId || undefined,
        field: normalizeField(node.dataset.coachField),
      },
    });
  });
  return out;
}

function entryMatchesTarget(
  entry: FocusEntry,
  kind: 'focus' | 'dirty-raw',
  target: FocusConflictCheck,
): boolean {
  if (target.sessionId && entry.sessionId && target.sessionId !== entry.sessionId) return false;
  if (entry.exId !== target.exId) return false;

  // 若目标覆盖整个动作（无 setId），动作内任意焦点或未成型草稿均阻断
  if (!target.setId) return true;

  // 若激活字段作用于整个动作（如目标编辑），也阻断
  if (!entry.setId) return entry.field === 'target' || entry.field === 'unknown';

  if (entry.setId !== target.setId) return false;

  if (target.includeDirtyInSet && kind === 'dirty-raw') return true;
  if (!target.fields || target.fields.length === 0) return true;
  return entry.field === 'unknown' || target.fields.includes(entry.field);
}

function buildConflictMessage(kind: 'focus' | 'dirty-raw', entry: FocusEntry): string {
  const fieldLabel =
    entry.field === 'reps'
      ? '次数'
      : entry.field === 'weight'
        ? '重量'
        : entry.field === 'note'
          ? '备注'
          : '目标';
  return kind === 'dirty-raw'
    ? `检测到你当前有未完成的${fieldLabel}输入草稿，请先完成或清空后再由教练写入，避免覆盖当前内容。`
    : `你正在编辑该${fieldLabel}输入框，教练已避让本次写入；请先收起键盘或切出焦点后再试。`;
}

export function checkFocusConflict(target: FocusConflictCheck): FocusConflictResult {
  const candidates: Array<{ kind: 'focus' | 'dirty-raw'; entry: FocusEntry }> = [];
  for (const entry of focusedMap.values()) {
    candidates.push({ kind: 'focus', entry });
  }
  for (const entry of dirtyMap.values()) {
    candidates.push({ kind: 'dirty-raw', entry });
  }
  for (const item of readDomFocusAndDirty()) {
    candidates.push(item);
  }
  const runtimeDirtyList = runtimeDirtyInspector?.(target) ?? [];
  for (const runtimeDirty of runtimeDirtyList) {
    candidates.push({ kind: 'dirty-raw', entry: runtimeDirty });
  }

  for (const { kind, entry } of candidates) {
    if (entryMatchesTarget(entry, kind, target)) {
      return {
        conflict: true,
        kind,
        exId: entry.exId,
        setId: entry.setId,
        field: entry.field,
        message: buildConflictMessage(kind, entry),
      };
    }
  }
  return { conflict: false };
}

export function __resetFocusGuardForTest(): void {
  focusedMap.clear();
  dirtyMap.clear();
  runtimeDirtyInspector = null;
}
