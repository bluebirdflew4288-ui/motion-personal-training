/* 跨进程/冷启动耐久的休息计时持久化与恢复判定（v0.2.3）。
   背景：
   · sessionStorage 在 Android WebView 进程被回收/强杀后会丢失；
   · 教练记组提交的同时会在 motion-training.meta 写入 `rest-timer-state:<sessionId>`，
     若提交后 UI 或进程在原生闹钟排程前中断，下次进入仍需按原 deadlineAtMs 与 token 恢复。
   · Backup v4 恢复会在同一主库事务中递增 `coach-restore-epoch` 并删除所有
     `rest-timer-state:*`，防止恢复历史数据后旧休息闹钟复活。 */

import type { RestTimerSource } from './restTimerSnapshot';
import {
  idbDelete,
  idbDeleteIf,
  idbGet,
  idbPut,
  REST_TIMER_STATE_META_PREFIX,
} from '../db/idb';

const DURABLE_LS_PREFIX = 'motion-rest-timer-durable:';

export interface CoachRestTimerDirective {
  operationId: string;
  restSec: number;
  source: RestTimerSource;
  token: string;
  deadlineAtMs: number;
  createdAt: number;
  restoreEpoch: number;
}

export interface DurableRestTimerRecord {
  v: 1;
  sessionId: string;
  token: string;
  source: RestTimerSource | null;
  generation: number | null;
  intentWatermark: number;
  endsAt: number | null;
  pausedRemaining: number | null;
  status: 'running' | 'paused';
  savedAt: number;
  restoreEpoch: number;
  coachOperationId?: string;
  nativeScheduled?: boolean;
}

export function restTimerDurableMetaKey(sessionId: string): string {
  return `${REST_TIMER_STATE_META_PREFIX}${sessionId}`;
}

export function buildDurableRecordFromCoachDirective(
  sessionId: string,
  directive: CoachRestTimerDirective,
): DurableRestTimerRecord {
  return {
    v: 1,
    sessionId,
    token: directive.token,
    source: directive.source,
    generation: null,
    intentWatermark: 0,
    endsAt: directive.deadlineAtMs,
    pausedRemaining: null,
    status: 'running',
    savedAt: directive.createdAt,
    restoreEpoch: directive.restoreEpoch,
    coachOperationId: directive.operationId,
    nativeScheduled: false,
  };
}

function getLocalStorageSafe(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = `${DURABLE_LS_PREFIX}__probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}

function isValidRecord(raw: unknown, expectedSessionId: string): raw is DurableRestTimerRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.sessionId !== expectedSessionId) return false;
  if (typeof r.token !== 'string' || !r.token) return false;
  if (r.status !== 'running' && r.status !== 'paused') return false;
  if (typeof r.savedAt !== 'number' || !Number.isFinite(r.savedAt)) return false;
  if (typeof r.restoreEpoch !== 'number' || !Number.isFinite(r.restoreEpoch)) return false;
  return true;
}

export function syncSaveDurableRestTimerLs(record: DurableRestTimerRecord): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    ls.setItem(`${DURABLE_LS_PREFIX}${record.sessionId}`, JSON.stringify(record));
  } catch {
    /* quota / private mode */
  }
}

export function syncLoadDurableRestTimerLs(sessionId: string): DurableRestTimerRecord | null {
  const ls = getLocalStorageSafe();
  if (!ls) return null;
  try {
    const raw = ls.getItem(`${DURABLE_LS_PREFIX}${sessionId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isValidRecord(parsed, sessionId) ? parsed : null;
  } catch {
    return null;
  }
}

export function syncClearDurableRestTimerLs(sessionId: string): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    ls.removeItem(`${DURABLE_LS_PREFIX}${sessionId}`);
  } catch {
    /* ignore */
  }
}

export function clearAllDurableRestTimersLs(): void {
  const ls = getLocalStorageSafe();
  if (!ls) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < ls.length; i += 1) {
      const k = ls.key(i);
      if (k && k.startsWith(DURABLE_LS_PREFIX)) toRemove.push(k);
    }
    for (const k of toRemove) ls.removeItem(k);
  } catch {
    /* ignore */
  }
}

export async function saveDurableRestTimer(record: DurableRestTimerRecord): Promise<void> {
  syncSaveDurableRestTimerLs(record);
  if (typeof indexedDB === 'undefined') return;
  try {
    await idbPut('meta', { key: restTimerDurableMetaKey(record.sessionId), value: record });
  } catch {
    /* localStorage still preserves best-effort state */
  }
}

export async function loadDurableRestTimer(
  sessionId: string,
): Promise<DurableRestTimerRecord | null> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const row = await idbGet<{ key: string; value: unknown }>(
        'meta',
        restTimerDurableMetaKey(sessionId),
      );
      if (row && isValidRecord(row.value, sessionId)) {
        syncSaveDurableRestTimerLs(row.value);
        return row.value;
      }
      if (row && row.value) {
        return null;
      }
    } catch {
      /* fallback to localStorage */
    }
  }
  return syncLoadDurableRestTimerLs(sessionId);
}

export async function clearDurableRestTimer(sessionId: string): Promise<void> {
  syncClearDurableRestTimerLs(sessionId);
  if (typeof indexedDB === 'undefined') return;
  try {
    await idbDelete('meta', restTimerDurableMetaKey(sessionId));
  } catch {
    /* ignore */
  }
}

/**
 * 按身份（token + restoreEpoch）安全清理持久化计时记录：
 * 仅当主库/localStorage 中的记录与待清理目标身份匹配时才删除，
 * 避免过期本地快照把同场训练中已提交的新 token 误清空。
 */
export async function clearDurableRestTimerIfMatches(
  sessionId: string,
  match: { token?: string; restoreEpoch?: number },
): Promise<boolean> {
  const matchesTarget = (rec: DurableRestTimerRecord): boolean => {
    if (match.token && rec.token !== match.token) return false;
    if (
      typeof match.restoreEpoch === 'number' &&
      rec.restoreEpoch > match.restoreEpoch
    ) {
      return false;
    }
    return true;
  };

  let idbDeleted = false;
  if (typeof indexedDB !== 'undefined') {
    try {
      idbDeleted = await idbDeleteIf<{ key: string; value?: unknown }>(
        'meta',
        restTimerDurableMetaKey(sessionId),
        (row) => {
          if (!row || !isValidRecord(row.value, sessionId)) return false;
          return matchesTarget(row.value);
        },
      );
    } catch {
      /* fallback to localStorage reconciliation */
    }
  }

  // 在单笔 IDB readwrite 原子比对删除之后再按身份清理 localStorage 镜像，
  // 若并发期间已写入更新的 token/epoch，则 matchesTarget(lsRec) 为 false，绝不误删新计时。
  const lsRec = syncLoadDurableRestTimerLs(sessionId);
  let lsCleared = false;
  if (lsRec && matchesTarget(lsRec)) {
    syncClearDurableRestTimerLs(sessionId);
    lsCleared = true;
  }
  return idbDeleted || lsCleared;
}

export function shouldDispatchCoachOpTimer(params: {
  replayed: boolean;
  nativeScheduled?: boolean;
  isFinalTimerInBatch: boolean;
}): boolean {
  if (!params.isFinalTimerInBatch) return false;
  if (!params.replayed) return true;
  // 若同 opId 的首次提交已写库但在 UI/原生排程前中断（nativeScheduled === false），允许续跑补排一次
  return params.nativeScheduled === false;
}

export interface NativeActiveRestInfo {
  active: boolean;
  token?: string;
  generation?: number | null;
  remainingMs?: number;
  deadlineAtMs?: number;
  lastIntentId?: number;
}

export type DurableRestRecoveryAction =
  | { kind: 'none' }
  | { kind: 'stale-epoch' }
  | { kind: 'expired' }
  | { kind: 'restore-paused'; pausedRemaining: number; record: DurableRestTimerRecord }
  | {
      kind: 'adopt-native';
      endsAt: number;
      remainingMs: number;
      generation: number | null;
      intentWatermark: number;
      record: DurableRestTimerRecord;
    }
  | {
      kind: 'schedule-pending-native';
      endsAt: number;
      remainingMs: number;
      record: DurableRestTimerRecord;
    }
  | {
      kind: 'restore-running';
      endsAt: number;
      remainingMs: number;
      record: DurableRestTimerRecord;
    };

export function reconcileRestTimerRecovery(params: {
  record: DurableRestTimerRecord | null;
  nativeActive: NativeActiveRestInfo | null;
  now?: number;
  currentRestoreEpoch?: number;
}): DurableRestRecoveryAction {
  const { record, nativeActive } = params;
  const now = params.now ?? Date.now();
  if (!record) return { kind: 'none' };
  if (
    typeof params.currentRestoreEpoch === 'number' &&
    params.currentRestoreEpoch > 0 &&
    record.restoreEpoch !== params.currentRestoreEpoch
  ) {
    return { kind: 'stale-epoch' };
  }
  if (record.status === 'paused') {
    if (typeof record.pausedRemaining !== 'number' || record.pausedRemaining <= 0) {
      return { kind: 'expired' };
    }
    return {
      kind: 'restore-paused',
      pausedRemaining: record.pausedRemaining,
      record,
    };
  }
  if (typeof record.endsAt !== 'number' || !Number.isFinite(record.endsAt)) {
    return { kind: 'none' };
  }
  const remainingMs = record.endsAt - now;
  if (remainingMs <= 0) return { kind: 'expired' };

  if (nativeActive?.active && nativeActive.token === record.token) {
    const adoptedEndsAt =
      typeof nativeActive.deadlineAtMs === 'number' && nativeActive.deadlineAtMs > now
        ? nativeActive.deadlineAtMs
        : record.endsAt;
    return {
      kind: 'adopt-native',
      endsAt: adoptedEndsAt,
      remainingMs: Math.max(0, adoptedEndsAt - now),
      generation:
        typeof nativeActive.generation === 'number' ? nativeActive.generation : record.generation,
      intentWatermark: Math.max(record.intentWatermark, nativeActive.lastIntentId ?? 0),
      record,
    };
  }

  if (record.nativeScheduled === false) {
    return {
      kind: 'schedule-pending-native',
      endsAt: record.endsAt,
      remainingMs,
      record,
    };
  }

  return {
    kind: 'restore-running',
    endsAt: record.endsAt,
    remainingMs,
    record,
  };
}
