/* 组间休息计时。
   ── 关键约束（修复 R2-01）────────────────────────────────────
   计时刻度（每 250ms）只在 <RestTimerBar> 内部维护，不通过 hook 向上冒泡，
   否则整个训练页会以 4Hz 重渲染，输入框在其中容易被抢焦点 / 打断 IME。
   hook 只保存「结束时间戳」这类低频状态，父组件仅在有操作时重渲染。
   剩余时间基于绝对时间戳计算，切后台回来仍正确（不依赖 setInterval 累加）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtCountdown } from '../lib/format';

export interface RestTimerApi {
  /** 当前是否在计时（含暂停态） */
  active: boolean;
  /** 结束时间戳；null 表示未启动 */
  endsAt: number | null;
  /** 暂停时冻结的剩余毫秒 */
  pausedRemaining: number | null;
  start: (sec: number) => void;
  pause: () => void;
  resume: () => void;
  adjust: (deltaSec: number) => void;
  stop: () => void;
}

export function useRestTimer(defaultSec: number): RestTimerApi {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [pausedRemaining, setPausedRemaining] = useState<number | null>(null);
  const defaultRef = useRef(defaultSec);
  defaultRef.current = defaultSec;

  const start = useCallback((sec?: number) => {
    setPausedRemaining(null);
    setEndsAt(Date.now() + (sec ?? defaultRef.current) * 1000);
  }, []);

  const pause = useCallback(() => {
    setEndsAt((prev) => {
      if (prev === null) return null;
      setPausedRemaining(Math.max(0, prev - Date.now()));
      return null;
    });
  }, []);

  const resume = useCallback(() => {
    setPausedRemaining((prev) => {
      if (prev === null) return null;
      setEndsAt(Date.now() + prev);
      return null;
    });
  }, []);

  const adjust = useCallback((deltaSec: number) => {
    setPausedRemaining((prevPaused) => {
      if (prevPaused !== null) return Math.max(0, prevPaused + deltaSec * 1000);
      setEndsAt((prev) => (prev === null ? null : Math.max(Date.now(), prev + deltaSec * 1000)));
      return null;
    });
  }, []);

  const stop = useCallback(() => {
    setEndsAt(null);
    setPausedRemaining(null);
  }, []);

  const active = endsAt !== null || pausedRemaining !== null;

  return useMemo(
    () => ({ active, endsAt, pausedRemaining, start, pause, resume, adjust, stop }),
    [active, endsAt, pausedRemaining, start, pause, resume, adjust, stop],
  );
}

/** 计时读数：自己 tick，不牵动父组件 */
function useTick(active: boolean, intervalMs: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return tick;
}

export function RestTimerBar({ timer }: { timer: RestTimerApi }) {
  const running = timer.endsAt !== null;
  const active = timer.active;
  const tick = useTick(active, 250);
  const doneFired = useRef(false);

  const remainingMs = useMemo(() => {
    void tick;
    if (timer.pausedRemaining !== null) return timer.pausedRemaining;
    if (timer.endsAt === null) return null;
    return Math.max(0, timer.endsAt - Date.now());
  }, [timer.endsAt, timer.pausedRemaining, tick]);

  useEffect(() => {
    if (remainingMs === 0) doneFired.current = true;
  }, [remainingMs]);

  if (!active || remainingMs === null) return null;

  const done = remainingMs === 0;
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: done ? 'var(--brick)' : 'var(--ink)',
        color: 'var(--paper)',
        padding: '8px 12px',
        margin: '0 -16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
      role="timer"
      aria-live="off"
    >
      <span
        style={{
          fontFamily: 'var(--f-mono)',
          fontSize: 12,
          opacity: 0.8,
          letterSpacing: '0.04em',
          flex: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {done ? '休息结束' : '组间休息'}
      </span>
      <span
        style={{
          fontFamily: 'var(--f-mono)',
          fontSize: 24,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          flex: 'none',
          letterSpacing: '0.02em',
        }}
        aria-label={`剩余 ${fmtCountdown(remainingMs)}`}
      >
        {fmtCountdown(remainingMs)}
      </span>
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flex: 'none' }}>
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={() => timer.adjust(-15)}
          aria-label="减少 15 秒"
        >
          −15
        </button>
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={() => timer.adjust(15)}
          aria-label="增加 15 秒"
        >
          +15
        </button>
        {running ? (
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
            onClick={timer.pause}
          >
            暂停
          </button>
        ) : (
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
            onClick={timer.resume}
          >
            继续
          </button>
        )}
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={timer.stop}
        >
          跳过
        </button>
      </div>
    </div>
  );
}

/** 已用时长：自己 tick，避免父组件每秒重渲染 */
export function ElapsedClock({
  startedAt,
  pausedMs,
  pausedAt,
  endedAt,
}: {
  startedAt: number;
  pausedMs: number;
  pausedAt: number | null;
  endedAt: number | null;
}) {
  const tick = useTick(endedAt === null, 1000);
  const text = useMemo(() => {
    void tick;
    const end = endedAt ?? Date.now();
    let paused = pausedMs;
    if (pausedAt) paused += Math.max(0, Date.now() - pausedAt);
    const ms = Math.max(0, end - startedAt - paused);
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }, [tick, startedAt, pausedMs, pausedAt, endedAt]);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>;
}
