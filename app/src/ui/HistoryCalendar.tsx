/* Wave 3D.3：历史页「月历出勤印章视图」（纸墨账本风，按本地自然日聚合）。
   印章区分：
   · 力量日（含力量+有氧混合）：实心黑墨圆章（力）
   · 纯有氧日：砖红斜纹双线章（氧）
   · 完全休息日：空心细虚线圆章（休）
   点击有记录的日期直接在下方展开当日完整记录卡片并可点入详情。 */

import { useEffect, useMemo, useState } from 'react';
import { localDateKey } from '../domain/localDate';
import { summarizeSession } from '../domain/session';
import { sessionKindOf } from '../domain/sessionKind';
import type { Session } from '../domain/types';
import { fmtDuration, fmtTime } from '../lib/format';
import { navigate } from '../lib/router';

export type DayStampKind = 'strength' | 'cardio' | 'rest';

export interface CalendarDayCell {
  dateKey: string;
  dayOfMonth: number;
  stampKind: DayStampKind | null;
  hasMixedCardio: boolean;
  workoutCount: number;
  sessions: Session[];
}

export interface MonthCalendarSummary {
  year: number;
  month: number; // 1..12
  monthKey: string; // YYYY-MM
  leadingEmptyCells: number; // 周一为首列（0..6）
  days: CalendarDayCell[];
  strengthDays: number;
  cardioOnlyDays: number;
  restDays: number;
  totalWorkouts: number;
}

export function sessionCalendarDateKey(s: Session): string {
  if (sessionKindOf(s) === 'rest' && typeof s.restDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.restDate)) {
    return s.restDate;
  }
  return localDateKey(s.startedAt);
}

/**
 * 构建指定年月的月历印章聚合数据（纯函数，周一作为每周第一列）。
 */
export function buildMonthCalendarData(
  sessions: readonly Session[],
  year: number,
  month1Based: number,
): MonthCalendarSummary {
  const mm = String(month1Based).padStart(2, '0');
  const monthPrefix = `${year}-${mm}`;
  const daysInMonth = new Date(year, month1Based, 0).getDate();
  const firstWeekdayJs = new Date(year, month1Based - 1, 1).getDay(); // 0=周日..6=周六
  const leadingEmptyCells = (firstWeekdayJs + 6) % 7; // 周一=0 .. 周日=6

  const byDate = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.status !== 'completed' || !s.endedAt) continue;
    const key = sessionCalendarDateKey(s);
    if (!key.startsWith(`${monthPrefix}-`)) continue;
    const arr = byDate.get(key) ?? [];
    arr.push(s);
    byDate.set(key, arr);
  }

  let strengthDays = 0;
  let cardioOnlyDays = 0;
  let restDays = 0;
  let totalWorkouts = 0;

  const days: CalendarDayCell[] = [];
  for (let d = 1; d <= daysInMonth; d += 1) {
    const dateKey = `${monthPrefix}-${String(d).padStart(2, '0')}`;
    const list = (byDate.get(dateKey) ?? []).slice().sort((a, b) => b.startedAt - a.startedAt);

    let hasStrength = false;
    let hasCardio = false;
    let hasRest = false;
    let workoutCount = 0;

    for (const s of list) {
      const k = sessionKindOf(s);
      if (k === 'rest') {
        hasRest = true;
      } else if (k === 'cardio') {
        hasCardio = true;
        workoutCount += 1;
      } else {
        hasStrength = true;
        workoutCount += 1;
        if ((s.cardio ?? []).some((c) => c.elapsedMs > 0 || c.segments.length > 0)) {
          hasCardio = true;
        }
      }
    }

    let stampKind: DayStampKind | null = null;
    if (hasStrength) {
      stampKind = 'strength';
      strengthDays += 1;
    } else if (hasCardio) {
      stampKind = 'cardio';
      cardioOnlyDays += 1;
    } else if (hasRest) {
      stampKind = 'rest';
      restDays += 1;
    }
    totalWorkouts += workoutCount;

    days.push({
      dateKey,
      dayOfMonth: d,
      stampKind,
      hasMixedCardio: hasStrength && hasCardio,
      workoutCount,
      sessions: list,
    });
  }

  return {
    year,
    month: month1Based,
    monthKey: monthPrefix,
    leadingEmptyCells,
    days,
    strengthDays,
    cardioOnlyDays,
    restDays,
    totalWorkouts,
  };
}

const WEEKDAY_HEADERS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export function HistoryCalendar({
  sessions,
  initialMonthKey,
}: {
  sessions: readonly Session[];
  initialMonthKey?: string;
}) {
  const defaultYm = useMemo(() => {
    if (initialMonthKey && /^\d{4}-\d{2}$/.test(initialMonthKey)) {
      const [y, m] = initialMonthKey.split('-').map(Number);
      return { year: y, month: m };
    }
    const latest = sessions.find((s) => s.status === 'completed' && s.endedAt);
    const refDate = latest ? new Date(latest.startedAt) : new Date();
    return { year: refDate.getFullYear(), month: refDate.getMonth() + 1 };
  }, [initialMonthKey, sessions]);

  const [ym, setYm] = useState(defaultYm);

  useEffect(() => {
    if (initialMonthKey && /^\d{4}-\d{2}$/.test(initialMonthKey)) {
      const [y, m] = initialMonthKey.split('-').map(Number);
      setYm({ year: y, month: m });
    }
  }, [initialMonthKey]);

  const cal = useMemo(
    () => buildMonthCalendarData(sessions, ym.year, ym.month),
    [sessions, ym.year, ym.month],
  );

  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);

  useEffect(() => {
    // 切换月份时默认选中该月最近一个有记录的日期
    const stamped = cal.days.filter((d) => d.sessions.length > 0);
    setSelectedDateKey(stamped.length > 0 ? stamped[stamped.length - 1].dateKey : null);
  }, [cal.monthKey, cal.days]);

  const selectedCell = useMemo(
    () => cal.days.find((d) => d.dateKey === selectedDateKey) ?? null,
    [cal.days, selectedDateKey],
  );

  const shiftMonth = (delta: -1 | 1) => {
    setYm((cur) => {
      let m = cur.month + delta;
      let y = cur.year;
      if (m < 1) {
        m = 12;
        y -= 1;
      } else if (m > 12) {
        m = 1;
        y += 1;
      }
      return { year: y, month: m };
    });
  };

  return (
    <div data-testid="history-calendar-view" style={{ marginTop: 14 }}>
      <section className="slip" style={{ padding: '14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="calendar-prev-month"
            aria-label="上一个月"
            onClick={() => shiftMonth(-1)}
            style={{ minWidth: 42 }}
          >
            ‹
          </button>
          <div style={{ textAlign: 'center' }}>
            <div
              data-testid="calendar-month-label"
              style={{ fontFamily: 'var(--f-serif)', fontSize: 18, fontWeight: 700 }}
            >
              {cal.year} 年 {String(cal.month).padStart(2, '0')} 月
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>
              力量 {cal.strengthDays} 天 · 纯有氧 {cal.cardioOnlyDays} 天 · 休息 {cal.restDays} 天
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="calendar-next-month"
            aria-label="下一个月"
            onClick={() => shiftMonth(1)}
            style={{ minWidth: 42 }}
          >
            ›
          </button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            gap: 4,
            marginTop: 12,
            paddingBottom: 6,
            borderBottom: '1px solid var(--rule)',
            textAlign: 'center',
          }}
        >
          {WEEKDAY_HEADERS.map((w) => (
            <span key={w} className="mono-label" style={{ fontSize: 11 }}>
              {w}
            </span>
          ))}
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            gap: 4,
            marginTop: 8,
          }}
        >
          {Array.from({ length: cal.leadingEmptyCells }, (_, idx) => (
            <div key={`empty-${idx}`} style={{ minHeight: 52 }} />
          ))}

          {cal.days.map((cell) => {
            const hasEntries = cell.sessions.length > 0;
            const selected = cell.dateKey === selectedDateKey;
            return (
              <button
                key={cell.dateKey}
                type="button"
                data-testid={`calendar-day-${cell.dateKey}`}
                data-stamp={cell.stampKind ?? 'none'}
                disabled={!hasEntries}
                onClick={() => setSelectedDateKey(cell.dateKey)}
                style={{
                  minHeight: 52,
                  padding: '4px 2px',
                  border: selected ? '1.5px solid var(--brick)' : '1px solid transparent',
                  background: selected ? 'var(--paper-3)' : 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: hasEntries ? 'pointer' : 'default',
                  position: 'relative',
                  color: 'var(--ink)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--f-num)',
                    fontSize: 11.5,
                    color: hasEntries ? 'var(--ink)' : 'var(--ink-4)',
                    fontWeight: hasEntries ? 600 : 400,
                  }}
                >
                  {cell.dayOfMonth}
                </span>

                {cell.stampKind === 'strength' ? (
                  <span
                    title="力量训练"
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      background: 'var(--ink)',
                      color: 'var(--paper-2)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                      position: 'relative',
                    }}
                  >
                    力
                    {cell.hasMixedCardio ? (
                      <span
                        style={{
                          position: 'absolute',
                          right: -2,
                          bottom: -2,
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: 'var(--brick)',
                          border: '1px solid var(--paper-2)',
                        }}
                      />
                    ) : null}
                  </span>
                ) : cell.stampKind === 'cardio' ? (
                  <span
                    title="纯有氧训练"
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: '1.5px solid var(--brick)',
                      color: 'var(--brick)',
                      background:
                        'repeating-linear-gradient(-45deg, rgba(163,59,36,0.13) 0px, rgba(163,59,36,0.13) 2px, transparent 2px, transparent 5px)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    氧
                  </span>
                ) : cell.stampKind === 'rest' ? (
                  <span
                    title="完全休息"
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      border: '1px dashed var(--ink-3)',
                      color: 'var(--ink-3)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11,
                    }}
                  >
                    休
                  </span>
                ) : (
                  <span style={{ width: 24, height: 24 }} />
                )}

                {cell.sessions.length >= 2 ? (
                  <span
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      fontFamily: 'var(--f-mono)',
                      fontSize: 9.5,
                      color: 'var(--brick)',
                      fontWeight: 700,
                    }}
                  >
                    ×{cell.sessions.length}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 12,
            paddingTop: 8,
            borderTop: '1px dashed var(--rule)',
            display: 'flex',
            gap: 14,
            flexWrap: 'wrap',
            fontSize: 11.5,
            color: 'var(--ink-3)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: 'var(--ink)',
                display: 'inline-block',
              }}
            />
            实心墨章 · 力量
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '1.5px solid var(--brick)',
                background:
                  'repeating-linear-gradient(-45deg, rgba(163,59,36,0.18) 0px, rgba(163,59,36,0.18) 2px, transparent 2px, transparent 4px)',
                display: 'inline-block',
              }}
            />
            砖红斜纹章 · 纯有氧
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '1px dashed var(--ink-3)',
                display: 'inline-block',
              }}
            />
            空心细章 · 完全休息
          </span>
        </div>
      </section>

      {selectedCell && selectedCell.sessions.length > 0 ? (
        <section style={{ marginTop: 14 }} data-testid="calendar-selected-day-list">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section" style={{ fontSize: 15 }}>
              {selectedCell.dateKey} 记录明细
            </h2>
            <span className="mono-label">
              {selectedCell.workoutCount > 0 ? `${selectedCell.workoutCount} 次训练` : '完全休息'}
            </span>
          </div>
          <div className="rows" style={{ marginTop: 4 }}>
            {selectedCell.sessions.map((s) => {
              const sum = summarizeSession(s, s.endedAt ?? Date.now());
              const kind = sessionKindOf(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  className="row"
                  data-testid="history-calendar-session-row"
                  onClick={() => navigate(`/history/${s.id}`)}
                >
                  <span
                    style={{
                      flex: 'none',
                      width: 46,
                      fontFamily: 'var(--f-serif)',
                      fontSize: 17,
                      fontWeight: 700,
                      color: 'var(--brick)',
                    }}
                  >
                    {fmtTime(s.startedAt)}
                  </span>
                  <span className="row-main">
                    <span className="row-title">{s.day.dayName}</span>
                    <span className="row-sub">
                      {kind === 'rest' ? (
                        <>完全休息 · 不计入训练次数</>
                      ) : (
                        <>
                          {sum.completedSets > 0 ? `${sum.completedSets} 组 · ` : ''}
                          {fmtDuration(sum.durationMs)}
                          {sum.cardioMs > 0 ? ` · 有氧 ${fmtDuration(sum.cardioMs)}` : ''}
                          {s.note ? ' · 有备注' : ''}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="row-end" style={{ color: 'var(--ink-4)' }}>
                    ›
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--ink-4)', textAlign: 'center' }}>
          本月暂无记录，点击上方箭头可切换其他月份查看。
        </div>
      )}
    </div>
  );
}
