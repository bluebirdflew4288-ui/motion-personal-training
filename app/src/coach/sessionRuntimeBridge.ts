/* 训练执行页与教练引擎之间的轻量运行时桥接（阶段 2）。
   目的：
   · 让教练事务复用当前挂起训练页的 editorId、先排空未提交保存队列，并在提交后立即对齐内存态；
   · 提供 RestTimer 诚实联动接口（仅未完成 -> 已完成时触发，绝不因改目标或纠错历史数字打断倒计时）；
   · 暴露折叠卡片后的跨重挂 rawRisk 检查与未确认草稿状态。 */

import { useEffect, useRef } from 'react';
import type { Session } from '../domain/types';
import { setRuntimeDirtyInspector, type CoachEditableField, type FocusEntry } from './focusGuard';

export interface ActiveSessionRuntime {
  sessionId: string;
  editorId: string;
  awaitPendingWrites: () => Promise<void>;
  applyCommittedSession: (committed: Session) => void;
  hasBlockingDrafts: () => boolean;
  startRestTimer: (sec: number, source: { sessionExerciseId: string; setId?: string }) => void;
  listRawRiskEntries?: (exId: string) => FocusEntry[];
}

let currentRuntime: ActiveSessionRuntime | null = null;

export function getActiveSessionRuntime(sessionId?: string): ActiveSessionRuntime | null {
  if (!currentRuntime) return null;
  if (sessionId && currentRuntime.sessionId !== sessionId) return null;
  return currentRuntime;
}

export function registerSessionRuntime(runtime: ActiveSessionRuntime | null): void {
  currentRuntime = runtime;
  if (runtime?.listRawRiskEntries) {
    const fn = runtime.listRawRiskEntries;
    setRuntimeDirtyInspector((check) => fn(check.exId));
  } else {
    setRuntimeDirtyInspector(null);
  }
}

export function parseRawRiskField(
  exId: string,
  rawFieldId: string,
  sessionId?: string,
): FocusEntry | null {
  const colonIdx = rawFieldId.indexOf(':');
  if (colonIdx <= 0) {
    return { sessionId, exId, field: 'unknown' };
  }
  const setId = rawFieldId.slice(0, colonIdx);
  const rawField = rawFieldId.slice(colonIdx + 1);
  const field: CoachEditableField =
    rawField === 'reps' || rawField === 'weight' || rawField === 'note' || rawField === 'target'
      ? rawField
      : 'unknown';
  return { sessionId, exId, setId, field };
}

/**
 * 固定槽位 Hook：必须在 SessionPage 任何 early return 之前调用，避免触犯 Hooks 顺序红线。
 */
export function useSessionRuntimeRegistration(runtime: ActiveSessionRuntime | null): void {
  const runtimeRef = useRef<ActiveSessionRuntime | null>(runtime);
  runtimeRef.current = runtime;
  const activeKey = runtime?.sessionId ?? null;

  useEffect(() => {
    if (!activeKey || !runtimeRef.current) {
      registerSessionRuntime(null);
      return undefined;
    }
    const wrapper: ActiveSessionRuntime = {
      get sessionId() {
        return runtimeRef.current?.sessionId ?? activeKey;
      },
      get editorId() {
        return runtimeRef.current?.editorId ?? '';
      },
      awaitPendingWrites: () => runtimeRef.current?.awaitPendingWrites() ?? Promise.resolve(),
      applyCommittedSession: (committed) => runtimeRef.current?.applyCommittedSession(committed),
      hasBlockingDrafts: () => runtimeRef.current?.hasBlockingDrafts() ?? false,
      startRestTimer: (sec, source) => runtimeRef.current?.startRestTimer(sec, source),
      listRawRiskEntries: (exId) => runtimeRef.current?.listRawRiskEntries?.(exId) ?? [],
    };
    registerSessionRuntime(wrapper);
    return () => {
      if (currentRuntime === wrapper) {
        registerSessionRuntime(null);
      }
    };
  }, [activeKey]);
}
