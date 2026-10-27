/* 记录类型与来源的唯一分类入口。
   ── 为什么单独成文件 ────────────────────────────────────────
   第2阶段要求「不凭动作名/空组推断日类型」。所有分类都必须经过这里，
   任何 `exercises.length === 0`、note 文本、时长是否为 0 的推断都是错误的。 */

import type { Session, SessionKind, SessionOrigin } from './types';

/** 记录类型；旧数据没有该字段 → 一律按 'strength' 解释 */
export function sessionKindOf(s: Pick<Session, 'kind'>): SessionKind {
  return s.kind ?? 'strength';
}

/** 来源；旧数据缺省按 'plan' 解释 */
export function sessionOriginOf(s: Pick<Session, 'origin'>): SessionOrigin {
  return s.origin ?? 'plan';
}

export function isRestSession(s: Pick<Session, 'kind'>): boolean {
  return sessionKindOf(s) === 'rest';
}

export function isCardioSession(s: Pick<Session, 'kind'>): boolean {
  return sessionKindOf(s) === 'cardio';
}

export function isStrengthSession(s: Pick<Session, 'kind'>): boolean {
  return sessionKindOf(s) === 'strength';
}

/** 是否含有氧内容（仅用于展示，**不用于分类**） */
export function hasCardio(s: Pick<Session, 'cardio'>): boolean {
  return (s.cardio?.length ?? 0) > 0;
}

/**
 * 界面展示用的一句话类型标签。
 * 力量 + 有氧显示「力量＋有氧」，但记录类型仍是 'strength'（不设冗余 mixed）。
 */
export function sessionTypeLabel(s: Pick<Session, 'kind' | 'cardio'>): string {
  const kind = sessionKindOf(s);
  if (kind === 'rest') return '完全休息';
  if (kind === 'cardio') return '有氧';
  return hasCardio(s) ? '力量＋有氧' : '力量';
}

/** 临时记录的 dayId 前缀（不借当前力量 dayId，避免误推进循环） */
export const ADHOC_DAY_PREFIX = 'adhoc:';

export function adhocDayId(sessionId: string): string {
  return `${ADHOC_DAY_PREFIX}${sessionId}`;
}

export function isAdhocDayId(dayId: string): boolean {
  return dayId.startsWith(ADHOC_DAY_PREFIX);
}
