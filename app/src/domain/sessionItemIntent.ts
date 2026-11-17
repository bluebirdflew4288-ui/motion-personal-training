/* G3A1：按稳定实例 ID 的删除/撤销“业务意图”纯函数。
   只做预览、确认后删除、空白误删撤销；不做 UI、不写库、不发布 undo。
   调用者必须在真实保存成功后 consume undo；本模块不谎报落库。 */

import { MAX_CARDIO_ENTRIES, MAX_EXERCISES } from './limits';
import type { CardioEntry, Session, SessionExercise } from './types';
import { exerciseRemovalProtection, removeExerciseFromSession } from './session';

export type DeleteItemKind = 'exercise' | 'cardio';

export interface DeleteItemPreview {
  token: string;
  sessionId: string;
  kind: DeleteItemKind;
  itemId: string;
  name: string;
  index: number;
  hasData: boolean;
  requiresConfirm: boolean;
  /** 当前风险的稳定签名（UI raw 风险也进入此签名） */
  riskSignature: string;
  reasons: string[];
  snapshot: SessionExercise | CardioEntry;
  neighborBeforeId: string | null;
  neighborAfterId: string | null;
  /**
   * F08：删除发生前**同分区**的完整 ID 顺序。
   * 多条撤销要能"按任意顺序恢复原相对顺序"，单靠前后邻居不够：
   * 先后删掉 B、C 后，C 的邻居里已经没有 B，只按邻居插回会得到 A,C,B。
   */
  orderBefore: string[];
}

export type DeletePreviewResult =
  | { ok: true; preview: DeleteItemPreview }
  | { ok: false; reason: 'not-active' | 'missing'; message: string };

export interface DeleteUndoRecord {
  token: string;
  sessionId: string;
  kind: DeleteItemKind;
  itemId: string;
  item: SessionExercise | CardioEntry;
  index: number;
  neighborBeforeId: string | null;
  neighborAfterId: string | null;
  expiresAt: number;
  /** F08：删除前的同分区顺序（撤销排序参照，见 previewDeleteItem.orderBefore） */
  orderBefore?: string[];
}

export type DeleteApplyResult =
  | { ok: true; session: Session; undo: DeleteUndoRecord | null }
  | { ok: false; reason: 'not-active' | 'missing' | 'confirm-required' | 'conflict' | 'risk-changed'; message: string; reasons?: string[] };

export type DeleteUndoResult =
  | { ok: true; session: Session }
  | { ok: false; reason: 'not-active' | 'expired' | 'duplicate' | 'capacity'; message: string };

const clone = <T>(v: T): T => structuredClone(v);
function findItem(session: Session, id: string): { kind: DeleteItemKind; item: SessionExercise | CardioEntry; index: number } | null {
  const ei = session.exercises.findIndex((e) => e.id === id);
  if (ei >= 0) return { kind: 'exercise', item: session.exercises[ei], index: ei };
  const ci = (session.cardio ?? []).findIndex((c) => c.id === id);
  if (ci >= 0) return { kind: 'cardio', item: (session.cardio ?? [])[ci], index: ci };
  return null;
}

function listOf(session: Session, kind: DeleteItemKind): Array<SessionExercise | CardioEntry> {
  return kind === 'exercise' ? session.exercises : (session.cardio ?? []);
}

function cardioHasData(entry: CardioEntry): boolean {
  return entry.elapsedMs > 0 || entry.segments.length > 0 || entry.runningSinceAt !== null || entry.status !== 'pending' || Boolean((entry.note ?? '').trim());
}

/** 打开预览：实时读取当前 Session；不修改数据。 */
export function previewDeleteItem(
  session: Session,
  itemId: string,
  opts: { hasRawDraft?: boolean; rawSignature?: string; now?: number } = {},
): DeletePreviewResult {
  if (session.status !== 'active') return { ok: false, reason: 'not-active', message: '训练已结束，不能删除动作' };
  const found = findItem(session, itemId);
  if (!found) return { ok: false, reason: 'missing', message: '这个项目已经不在本次训练里了' };
  const list = listOf(session, found.kind);
  const reasons: string[] = [];
  if (found.kind === 'exercise') {
    const protectedInfo = exerciseRemovalProtection(found.item as SessionExercise, { hasRawDraft: opts.hasRawDraft });
    reasons.push(...protectedInfo.reasons);
  } else {
    const entry = found.item as CardioEntry;
    if (cardioHasData(entry)) reasons.push('有氧已有有效时长/分段/运行或暂停状态');
    if ((entry.note ?? '').trim()) reasons.push('有氧备注非空');
    if (opts.hasRawDraft || opts.rawSignature) reasons.push('还有未提交的输入草稿');
  }
  const hasData = reasons.length > 0;
  return {
    ok: true,
    preview: {
      token: `delete-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: session.id,
      kind: found.kind,
      itemId,
      name: found.kind === 'exercise' ? (found.item as SessionExercise).name : (found.item as CardioEntry).name,
      index: found.index,
      hasData,
      requiresConfirm: hasData,
      riskSignature: JSON.stringify({ hasData, reasons: reasons.slice().sort(), raw: opts.rawSignature ?? '' }),
      reasons,
      snapshot: clone(found.item),
      neighborBeforeId: found.index > 0 ? list[found.index - 1].id : null,
      neighborAfterId: found.index + 1 < list.length ? list[found.index + 1].id : null,
      orderBefore: list.map((entry) => entry.id),
    },
  };
}

/** 确认后执行删除；preview 的 snapshot 必须仍与当前最新对象一致。 */
export function applyDeleteItem(
  session: Session,
  preview: DeleteItemPreview,
  opts: { confirmed?: boolean; hasRawDraft?: boolean; rawSignature?: string; now?: number; undoTtlMs?: number } = {},
): DeleteApplyResult {
  if (session.status !== 'active') return { ok: false, reason: 'not-active', message: '训练已结束，不能删除动作' };
  if (session.id !== preview.sessionId) return { ok: false, reason: 'conflict', message: '训练对象已变化，请重新确认' };
  const found = findItem(session, preview.itemId);
  if (!found) return { ok: false, reason: 'missing', message: '这个项目已经不在本次训练里了' };
  if (JSON.stringify(found.item) !== JSON.stringify(preview.snapshot)) {
    return { ok: false, reason: 'conflict', message: '这个项目在确认期间发生了变化，请重新预览影响' };
  }
  // 当前风险以本次应用时的真实 raw 登记重新计算；旧 preview 看不到后来出现的 raw。
  const currentReasons = found.kind === 'exercise'
    ? exerciseRemovalProtection(found.item as SessionExercise, { hasRawDraft: opts.hasRawDraft }).reasons
    : [
        ...(cardioHasData(found.item as CardioEntry) ? ['有氧已有有效时长/分段/运行或暂停状态'] : []),
        ...((found.item as CardioEntry).note ?? '').trim() ? ['有氧备注非空'] : [],
        ...(opts.hasRawDraft || opts.rawSignature ? ['还有未提交的输入草稿'] : []),
      ];
  const currentData = currentReasons.length > 0;
  const currentRiskSignature = JSON.stringify({ hasData: currentData, reasons: currentReasons.slice().sort(), raw: opts.rawSignature ?? '' });
  // 同时比较完整风险签名，已有 actual 时后来新增 raw 也必须使旧确认失效
  if (currentRiskSignature !== preview.riskSignature) {
    return { ok: false, reason: 'risk-changed', message: '项目的当前输入风险与预览时不同，请重新预览影响' };
  }
  if (currentData && !opts.confirmed) {
    return { ok: false, reason: 'confirm-required', message: currentReasons.join('、'), reasons: currentReasons };
  }
  let next: Session;
  if (preview.kind === 'exercise') {
    next = removeExerciseFromSession(session, preview.itemId).session;
  } else {
    const entryId = preview.itemId;
    next = {
      ...session,
      cardio: (session.cardio ?? []).filter((c) => c.id !== entryId),
      cardioPausedBySession: (session.cardioPausedBySession ?? []).filter((id) => id !== entryId),
    };
  }
  const undo = preview.hasData
    ? null
    : {
        token: preview.token,
        sessionId: preview.sessionId,
        kind: preview.kind,
        itemId: preview.itemId,
        item: clone(preview.snapshot),
        index: preview.index,
        neighborBeforeId: preview.neighborBeforeId,
        neighborAfterId: preview.neighborAfterId,
        orderBefore: preview.orderBefore,
        expiresAt: (opts.now ?? Date.now()) + (opts.undoTtlMs ?? 8_000),
      };
  return { ok: true, session: next, undo };
}

/**
 * 按一份**参照顺序**（同批删除开始时该分区的顺序）计算插回下标。
 *
 * 规则：优先落回参照顺序里它之后仍存活的第一项之前；若后面全没了，
 * 就落回它之前仍存活的最后一项之后；都没有锚点才回退到旧下标。
 * 这样"同一批删掉多项后按任意顺序撤销"都能恢复原相对顺序，
 * 而后续被用户主动排序/新增的项仍是合并到最新状态（以当前列表为准）。
 */
function indexFromOrderRef(
  currentIds: string[],
  ref: string[],
  itemId: string,
  fallbackIndex: number,
): { index: number; placed: boolean } {
  const pos = ref.indexOf(itemId);
  if (pos < 0) return { index: fallbackIndex, placed: false };
  for (let i = pos + 1; i < ref.length; i += 1) {
    const at = currentIds.indexOf(ref[i]);
    if (at >= 0) return { index: at, placed: true };
  }
  for (let i = pos - 1; i >= 0; i -= 1) {
    const at = currentIds.indexOf(ref[i]);
    if (at >= 0) return { index: at + 1, placed: true };
  }
  return { index: fallbackIndex, placed: false };
}

/** 把空白误删条目合并回最新 Session；不整份回滚，不恢复运行计时。 */
export function undoDeleteItem(
  session: Session,
  undo: DeleteUndoRecord,
  now = Date.now(),
  opts: { orderRef?: string[] } = {},
): DeleteUndoResult {
  if (session.status !== 'active') return { ok: false, reason: 'not-active', message: '训练已结束，不能撤销删除' };
  if (now > undo.expiresAt) return { ok: false, reason: 'expired', message: '撤销已过期' };
  if (session.id !== undo.sessionId) return { ok: false, reason: 'not-active', message: '训练对象不匹配' };
  if (findItem(session, undo.itemId)) return { ok: false, reason: 'duplicate', message: '这个项目已经存在' };
  const current = undo.kind === 'exercise' ? session.exercises.length : (session.cardio ?? []).length;
  const max = undo.kind === 'exercise' ? MAX_EXERCISES : MAX_CARDIO_ENTRIES;
  if (current >= max) return { ok: false, reason: 'capacity', message: '已达到容量上限，不能撤销恢复' };
  let index = Math.max(0, Math.min(undo.index, current));
  let placed = false;
  // F08：同批多条删除按参照顺序恢复原相对顺序（未提供参照时保持原有邻居逻辑）
  const orderRef = opts.orderRef ?? undo.orderBefore;
  if (orderRef && orderRef.length) {
    const currentIds = listOf(session, undo.kind).map((e) => e.id);
    const byRef = indexFromOrderRef(currentIds, orderRef, undo.itemId, index);
    index = byRef.index;
    placed = byRef.placed;
  }
  if (!placed && undo.neighborBeforeId) {
    const bi = listOf(session, undo.kind).findIndex((e) => e.id === undo.neighborBeforeId);
    if (bi >= 0) { index = bi + 1; placed = true; }
  }
  // 前邻居消失时仍优先回到存活的后邻居之前，不能直接落回旧索引
  if (!placed && undo.neighborAfterId) {
    const ai = listOf(session, undo.kind).findIndex((e) => e.id === undo.neighborAfterId);
    if (ai >= 0) { index = ai; placed = true; }
  }
  const item = clone(undo.item);
  if (undo.kind === 'exercise') {
    const exercises = [...session.exercises];
    exercises.splice(index, 0, item as SessionExercise);
    return { ok: true, session: { ...session, exercises } };
  }
  const entry = clone(item as CardioEntry);
  // 不恢复运行：撤销只恢复被删快照，绝不把旧 running 计时复活。
  if (entry.status === 'running') {
    entry.status = 'paused';
    entry.runningSinceAt = null;
  }
  const cardio = [...(session.cardio ?? [])];
  cardio.splice(index, 0, entry);
  return { ok: true, session: { ...session, cardio } };
}
