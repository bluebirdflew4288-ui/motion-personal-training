/* 「是否有真实内容」的唯一判据。
   ── 为什么需要 ──────────────────────────────────────────────
   放弃确认、完全休息冲突核验等都要判断"这次训练是否真的做了东西"。
   判据必须覆盖：partial、只填重量、真实 0、备注、热身、有氧。
   不能只看"完整有效组数"，否则 partial / 只填重量 / 仅有氧会被误判成没练。 */

import { liveElapsedMs } from './cardio';
import type { Session } from './types';

export function hasAnyRealContent(s: Session, now = Date.now()): boolean {
  // 进行中一律算有内容（未结束的训练不能被当成"没练"）
  if (s.status === 'active') return true;
  // 备注
  if (typeof s.note === 'string' && s.note.trim().length > 0) return true;
  // 热身
  if ((s.warmups ?? []).some((w) => w.done)) return true;
  // 有氧：有有效时长或已录参数段
  for (const c of s.cardio ?? []) {
    if (liveElapsedMs(c, now) > 0) return true;
    if (c.segments.length > 0) return true;
  }
  // 力量：跳过、备注、或任何实际输入（真实 0 也算）
  return (s.exercises ?? []).some(
    (ex) =>
      ex.status === 'skipped' ||
      (typeof ex.note === 'string' && ex.note.trim().length > 0) ||
      (ex.sets ?? []).some(
        (set) =>
          set.status === 'done' ||
          set.status === 'partial' ||
          (typeof set.reps === 'number' && Number.isFinite(set.reps)) ||
          (typeof set.weightKg === 'number' && Number.isFinite(set.weightKg)),
      ),
  );
}
