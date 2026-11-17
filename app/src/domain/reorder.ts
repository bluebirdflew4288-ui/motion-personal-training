/* G3B：训练页卡片排序（力量 / 有氧各自分区，按稳定实例 ID）。
   ── 边界 ─────────────────────────────────────────────────────
   · 只调整**顺序**：不重建 sets、不改 cardio entry 内容、不碰 raw/模板/计划/历史/游标；
   · 必须 active 才可编辑；终态/未知 ID/集合不一致（增删）一律明确拒绝；
   · 顺序未变化时 changed=false，调用方不应发起落库。 */

import type { Session } from './types';

export type ReorderKind = 'strength' | 'cardio';

export type ReorderResult =
  | { ok: true; session: Session; changed: boolean }
  | { ok: false; reason: 'not-active' | 'unknown-id' | 'mismatch'; message: string };

function currentIds(session: Session, kind: ReorderKind): string[] {
  return kind === 'strength'
    ? session.exercises.map((e) => e.id)
    : (session.cardio ?? []).map((c) => c.id);
}

/**
 * 按给定 ID 顺序重排某个分区。
 *
 * 只接受**同一集合的排列**：既不能借此增删条目，也不能跨分区移动。
 * 返回的新 Session 只替换对应数组的顺序，元素对象引用保持不变。
 */
export function reorderSessionItems(
  session: Session,
  kind: ReorderKind,
  orderedIds: readonly string[],
): ReorderResult {
  if (session.status !== 'active') {
    return { ok: false, reason: 'not-active', message: '训练已结束，不能调整顺序' };
  }
  const before = currentIds(session, kind);
  if (orderedIds.length !== before.length) {
    return { ok: false, reason: 'mismatch', message: '顺序数量与当前训练不一致，请刷新后重试' };
  }
  const beforeSet = new Set(before);
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (!beforeSet.has(id)) return { ok: false, reason: 'unknown-id', message: '要排序的条目已不在本次训练里' };
    if (seen.has(id)) return { ok: false, reason: 'mismatch', message: '排序结果里有重复条目' };
    seen.add(id);
  }
  if (orderedIds.every((id, i) => id === before[i])) {
    return { ok: true, session, changed: false };
  }

  if (kind === 'strength') {
    const byId = new Map(session.exercises.map((e) => [e.id, e]));
    const exercises = orderedIds.map((id) => byId.get(id)!);
    return { ok: true, session: { ...session, exercises }, changed: true };
  }
  const cardioList = session.cardio ?? [];
  const byId = new Map(cardioList.map((c) => [c.id, c]));
  const cardio = orderedIds.map((id) => byId.get(id)!);
  return { ok: true, session: { ...session, cardio }, changed: true };
}
