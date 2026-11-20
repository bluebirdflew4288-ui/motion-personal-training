/* 统计页：只用真实记录算，样本不足时不画趋势。
   Wave 2B：分离有氧与力量均组口径、连续 8 自然周补 0、单动作按部位/拼音筛选与同口径纯 SVG 纸墨折线图。 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { fmtDate, fmtDateShort, fmtDuration, fmtWeight } from '../lib/format';
import {
  buildExerciseHistory,
  buildOverview,
  filterTrainedExercises,
  listTrainedExercises,
  type ExerciseHistory,
  type ExerciseHistoryEntry,
} from '../domain/stats';
import { listComparabilityModes, describeGroupCounts } from '../domain/comparability';
import type { DumbbellBasis, WeightMode } from '../domain/types';
import { CoachHeaderButton } from '../coach/CoachHeaderButton';

type TrendMetric = 'weight' | 'totalReps' | 'bestReps';

const GROUP_ORDER = ['胸', '背', '腿', '肩', '手臂', '核心', '其他'] as const;

export function StatsPage({ focusExercise }: { focusExercise?: string }) {
  const { sessions, historyHydrated, ensureFullHistory } = useStore();
  const [exerciseKey, setExerciseKey] = useState<string | null>(focusExercise ?? null);
  /** V3-05：计量口径必须可见、可切换；不同口径不合并成一条曲线 */
  const [modeKey, setModeKey] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [trendMetric, setTrendMetric] = useState<TrendMetric | null>(null);

  useEffect(() => {
    if (!historyHydrated) {
      void ensureFullHistory();
    }
  }, [historyHydrated, ensureFullHistory]);

  const overview = useMemo(() => buildOverview(sessions, Date.now()), [sessions]);
  const trained = useMemo(() => listTrainedExercises(sessions), [sessions]);
  const availableGroups = useMemo(() => {
    const present = new Set(trained.map((t) => t.group ?? '其他'));
    return GROUP_ORDER.filter((g) => present.has(g));
  }, [trained]);
  const filteredTrained = useMemo(
    () => filterTrainedExercises(trained, { group: groupFilter, query: searchQuery }),
    [trained, groupFilter, searchQuery],
  );

  const selectedKey = useMemo(() => {
    if (exerciseKey && filteredTrained.some((t) => t.key === exerciseKey)) {
      return exerciseKey;
    }
    if (!searchQuery.trim() && groupFilter === 'all' && exerciseKey && trained.some((t) => t.key === exerciseKey)) {
      return exerciseKey;
    }
    return filteredTrained[0]?.key ?? null;
  }, [exerciseKey, filteredTrained, groupFilter, searchQuery, trained]);

  const modes = useMemo(
    () => (selectedKey ? listComparabilityModes(sessions, selectedKey) : []),
    [sessions, selectedKey],
  );
  const selectedMode = useMemo(() => {
    if (!modes.length) return undefined;
    const hit = modes.find((m) => `${m.weightMode}::${m.dumbbellBasis}` === modeKey);
    return hit ?? modes[0];
  }, [modes, modeKey]);
  const exercise = useMemo(
    () =>
      selectedKey
        ? buildExerciseHistory(
            sessions,
            selectedKey,
            selectedMode
              ? {
                  weightMode: selectedMode.weightMode as WeightMode,
                  dumbbellBasis: selectedMode.dumbbellBasis as DumbbellBasis,
                }
              : undefined,
          )
        : null,
    [sessions, selectedKey, selectedMode],
  );

  const maxWeekCount = Math.max(1, ...overview.weeks.map((w) => w.count));
  const hasCardioOverview = overview.cardioSessions > 0 || overview.totalCardioMs > 0;

  const overviewItems = [
    { k: '训练次数', v: `${overview.totalSessions}`, u: '次' },
    { k: '正式组总数', v: `${overview.totalSets}`, u: '组' },
    { k: '平均时长', v: fmtDuration(overview.avgDurationMs), u: '' },
    {
      k: hasCardioOverview ? '力量场均组数' : '平均组数',
      v: `${overview.avgSetsPerSession}`,
      u: '组/次',
    },
    ...(hasCardioOverview
      ? [
          { k: '有氧场次', v: `${overview.cardioSessions}`, u: '次' },
          { k: '累计有氧', v: fmtDuration(overview.totalCardioMs), u: '' },
        ]
      : []),
  ];

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          统计
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="mono-label">仅统计已完成记录</span>
          <CoachHeaderButton compact />
        </div>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      {!historyHydrated ? (
        <div className="empty" style={{ marginTop: 24 }} role="status" data-testid="stats-hydrating">
          <div className="empty-title">正在读取全部训练记录…</div>
          <p className="empty-body">统计只基于完整本机记录计算，读取完成后会自动显示。</p>
        </div>
      ) : !overview.totalSessions ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <div className="empty-mark">0</div>
          <h2 className="empty-title">还没有可统计的数据</h2>
          <p className="empty-body">
            完成至少一次训练后，这里会显示训练次数、每周频率、时长、正式组数和单个动作的历史表现。数据不足时不画趋势。
          </p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/')}>
            去训练
          </button>
        </div>
      ) : (
        <>
          {/* 概览 */}
          <section
            style={{
              marginTop: 14,
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
            }}
          >
            {overviewItems.map((item) => (
              <div key={item.k} className="slip" style={{ padding: '12px 14px' }}>
                <div className="mono-label">{item.k}</div>
                <div style={{ fontFamily: 'var(--f-num)', fontSize: 26, fontWeight: 700, marginTop: 2 }}>
                  {item.v}
                  {item.u ? <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 3 }}>{item.u}</span> : null}
                </div>
              </div>
            ))}
          </section>

          {/* 每周频率（连续 8 个自然周，空缺周显式补 0） */}
          <section style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">每周训练频率</h2>
              <span className="mono-label">连续 {overview.weeks.length} 周</span>
            </div>
            <div className="slip" style={{ marginTop: 8, padding: '14px 14px 10px' }} data-testid="stats-weekly-bars">
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 96 }}>
                {overview.weeks.map((w) => (
                  <div
                    key={w.key}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: 'var(--f-num)',
                        fontWeight: 700,
                        color: w.count ? 'var(--ink)' : 'var(--ink-4)',
                      }}
                    >
                      {w.count}
                    </span>
                    <div
                      style={{
                        width: '100%',
                        maxWidth: 40,
                        height: w.count ? Math.max(8, (w.count / maxWeekCount) * 58) : 4,
                        background: w.count ? 'var(--brick)' : 'var(--rule-strong, var(--rule))',
                        opacity: w.count ? 1 : 0.45,
                      }}
                      aria-label={`第 ${w.label} 周 ${w.count} 次`}
                    />
                    <span className="mono-label" style={{ fontSize: 10 }}>
                      {w.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 各训练日次数 */}
          <section style={{ marginTop: 20 }}>
            <h2 className="h-section">各训练日次数</h2>
            <div className="rows" style={{ marginTop: 4 }}>
              {overview.byDayName.map((d) => (
                <div key={d.name} className="row" style={{ cursor: 'default' }}>
                  <span className="row-main">
                    <span className="row-title">{d.name}</span>
                  </span>
                  <span className="row-sub" style={{ flex: 'none', margin: 0 }}>
                    {d.sets} 组
                  </span>
                  <span className="row-end" style={{ marginLeft: 12 }}>
                    {d.count} 次
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* 单动作表现 */}
          <section style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <h2 className="h-section">单个动作表现</h2>
              <select
                className="input"
                style={{ flex: '0 0 auto', maxWidth: 210, minHeight: 40, fontSize: 14 }}
                value={selectedKey ?? ''}
                onChange={(e) => {
                  setExerciseKey(e.target.value);
                  setModeKey(null);
                  setTrendMetric(null);
                }}
                aria-label="选择动作"
              >
                {filteredTrained.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}（{t.count} 次）
                  </option>
                ))}
              </select>
            </div>

            {trained.length > 4 ? (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  className="input"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="快速检索已练动作：名称 / 拼音或首字母（如 wt、wo、yin）/ 俗称"
                  aria-label="搜索已练动作"
                  data-testid="stats-exercise-search"
                  style={{ minHeight: 38, fontSize: 13 }}
                />
                {availableGroups.length > 1 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="按部位筛选动作">
                    {(['all', ...availableGroups] as const).map((g) => {
                      const active = groupFilter === g;
                      return (
                        <button
                          key={g}
                          type="button"
                          className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
                          style={{ minHeight: 32, padding: '0 10px', fontSize: 12 }}
                          onClick={() => setGroupFilter(g)}
                        >
                          {g === 'all' ? '全部' : g}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {modes.length > 1 ? (
              <div style={{ marginTop: 8 }}>
                <div className="mono-label" style={{ marginBottom: 4 }}>
                  计量口径（不同口径分开统计，不混成一条曲线）
                </div>
                <div className="segmented" role="group" aria-label="计量口径">
                  {modes.map((m) => (
                    <button
                      key={`${m.weightMode}::${m.dumbbellBasis}`}
                      aria-pressed={
                        `${m.weightMode}::${m.dumbbellBasis}` ===
                        `${selectedMode?.weightMode}::${selectedMode?.dumbbellBasis}`
                      }
                      onClick={() => {
                        setModeKey(`${m.weightMode}::${m.dumbbellBasis}`);
                        setTrendMetric(null);
                      }}
                      style={{ fontSize: 12 }}
                    >
                      {m.label}（{m.count}）
                    </button>
                  ))}
                </div>
              </div>
            ) : modes.length === 1 ? (
              <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }}>
                计量口径：{modes[0].label}
              </div>
            ) : null}

            {exercise ? (
              <div className="slip" style={{ marginTop: 8, padding: '12px 14px' }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <div className="mono-label">
                      {exercise.weightMode === 'assisted' ? '最佳辅助' : '最高重量'}
                      {exercise.label ? `（${exercise.label}）` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                      {exercise.bestWeightKg !== null ? `${fmtWeight(exercise.bestWeightKg)} kg` : '未记录重量'}
                    </div>
                  </div>
                  <div>
                    <div className="mono-label">单组最多次数</div>
                    <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>{exercise.bestReps}</div>
                  </div>
                  <div>
                    <div className="mono-label">记录次数</div>
                    <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>{exercise.entries.length}</div>
                  </div>
                </div>

                {exercise.entries.length >= 2 ? (
                  <ExerciseTrendChart
                    exercise={exercise}
                    preferredMetric={trendMetric}
                    onChangeMetric={setTrendMetric}
                  />
                ) : null}

                <div style={{ marginTop: 12, borderTop: '1px solid var(--rule)', paddingTop: 8 }}>
                  {exercise.entries.length < 2 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-3)' }}>
                      只有 1 次记录，还不足以看出变化。多记录几次后再回来看。
                    </p>
                  ) : null}
                  {[...exercise.entries].reverse().map((e) => (
                    <button
                      key={e.sessionId}
                      className="row"
                      style={{ borderBottom: '1px dashed var(--rule)', paddingTop: 8, paddingBottom: 8 }}
                      onClick={() => navigate(`/history/${e.sessionId}`)}
                    >
                      <span className="row-main">
                        <span className="row-title" style={{ fontSize: 14 }}>
                          {fmtDate(e.at)} · {e.dayName}
                        </span>
                        <span className="row-sub" style={{ fontFamily: 'var(--f-mono)', fontSize: 12 }}>
                          {setRowsText(e)}
                          {e.fragments.some((f) => f.kind === 'dropSet') ? (
                            <span style={{ color: 'var(--ink-4)', marginLeft: 6 }}>
                              （{describeGroupCounts(e.fragments)}）
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <span className="row-end" style={{ color: 'var(--ink-4)' }}>
                        ›
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : filteredTrained.length === 0 && trained.length > 0 ? (
              <p style={{ fontSize: 13.5, color: 'var(--ink-3)', marginTop: 10 }}>
                当前筛选条件下没有匹配的已练动作。
              </p>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--ink-3)' }}>还没有记录过任何动作。</p>
            )}
          </section>

          <p
            style={{
              marginTop: 24,
              marginBottom: 0,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
              fontSize: 12.5,
              color: 'var(--ink-3)',
              lineHeight: 1.75,
            }}
          >
            口径：热身不计入正式组；计划内未完成的组不算完成组；递减组按大组计数；部分完成的大组单独标注；纯有氧场次不计入力量场均组数分母。
            不同动作、不同重量含义（自重 / 外加负重 / 辅助 / 哑铃单只）不合并成一个力量分数。
            {overview.firstSessionAt
              ? ` 数据范围 ${fmtDateShort(overview.firstSessionAt)} – ${fmtDateShort(overview.lastSessionAt ?? Date.now())}。`
              : ''}
          </p>
        </>
      )}
    </main>
  );
}

/** 同动作同口径纯 SVG 纸墨折线图（Wave 2B.3 / 0.1.18 升级：中间日期刻度 + 点击节点查看当次日期与重量/有效次数） */
function ExerciseTrendChart({
  exercise,
  preferredMetric,
  onChangeMetric,
}: {
  exercise: ExerciseHistory;
  preferredMetric: TrendMetric | null;
  onChangeMetric: (m: TrendMetric) => void;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const isAssisted = exercise.weightMode === 'assisted';
  const weightPointCount = exercise.entries.filter((e) => e.bestWeightKg !== null).length;
  const hasWeightSeries = weightPointCount >= 2;

  const activeMetric: TrendMetric =
    preferredMetric === 'weight' && !hasWeightSeries
      ? 'bestReps'
      : preferredMetric ?? (hasWeightSeries ? 'weight' : 'bestReps');

  const recentEntries = exercise.entries.slice(-16);
  interface TrendPoint {
    at: number;
    value: number;
    sessionId: string;
    dayName: string;
    bestWeightKg: number | null;
    totalReps: number;
    bestReps: number;
  }
  const points = recentEntries
    .map((entry): TrendPoint | null => {
      const value =
        activeMetric === 'weight'
          ? entry.bestWeightKg
          : activeMetric === 'totalReps'
            ? entry.totalReps
            : entry.bestReps;
      return value === null
        ? null
        : {
            at: entry.at,
            value,
            sessionId: entry.sessionId,
            dayName: entry.dayName,
            bestWeightKg: entry.bestWeightKg,
            totalReps: entry.totalReps,
            bestReps: entry.bestReps,
          };
    })
    .filter((p): p is TrendPoint => p !== null);

  if (points.length < 2) return null;

  const values = points.map((p) => p.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const span = maxVal - minVal;
  const invertY = activeMetric === 'weight' && isAssisted;

  const W = 340;
  const H = 152;
  const padLeft = 38;
  const padRight = 18;
  const padTop = 20;
  const padBottom = 28;
  const plotW = W - padLeft - padRight;
  const plotH = H - padTop - padBottom;

  const coords = points.map((p, idx) => {
    const x = padLeft + (points.length === 1 ? plotW / 2 : (idx / (points.length - 1)) * plotW);
    const ratio = span === 0 ? 0.5 : (p.value - minVal) / span;
    const progressRatio = invertY ? 1 - ratio : ratio;
    const y = padTop + (1 - progressRatio) * plotH;
    return { ...p, idx, x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  });

  const selectedCoord =
    coords.find((c) => c.sessionId === selectedSessionId) ?? coords[coords.length - 1];

  const tickIndices: number[] = (() => {
    if (coords.length <= 5) {
      return coords.map((_, i) => i);
    }
    const count = 5;
    const set = new Set<number>();
    for (let k = 0; k < count; k++) {
      set.add(Math.round((k * (coords.length - 1)) / (count - 1)));
    }
    return [...set].sort((a, b) => a - b);
  })();

  const polyline = coords.map((c) => `${c.x},${c.y}`).join(' ');
  const unit = activeMetric === 'weight' ? 'kg' : '次';
  const fmtVal = (v: number) => (activeMetric === 'weight' ? `${fmtWeight(v)}${unit}` : `${v}${unit}`);
  const fmtAxisVal = (v: number) => (activeMetric === 'weight' ? fmtWeight(v) : String(Math.round(v)));
  const topAxisVal = invertY ? minVal : maxVal;
  const botAxisVal = invertY ? maxVal : minVal;
  const midAxisVal = (minVal + maxVal) / 2;

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 10,
        borderTop: '1px solid var(--rule)',
      }}
      data-testid="stats-trend-block"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span className="mono-label">
          同口径趋势（最近 {points.length} 次 · 点按节点看详情）
        </span>
        <div className="segmented" role="group" aria-label="趋势指标" style={{ maxWidth: 260 }}>
          {hasWeightSeries ? (
            <button
              type="button"
              aria-pressed={activeMetric === 'weight'}
              onClick={() => onChangeMetric('weight')}
              style={{ fontSize: 11.5, padding: '4px 8px' }}
            >
              {isAssisted ? '最佳辅助' : '最佳重量'}
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={activeMetric === 'totalReps'}
            onClick={() => onChangeMetric('totalReps')}
            style={{ fontSize: 11.5, padding: '4px 8px' }}
          >
            有效总次数
          </button>
          {!hasWeightSeries ? (
            <button
              type="button"
              aria-pressed={activeMetric === 'bestReps'}
              onClick={() => onChangeMetric('bestReps')}
              style={{ fontSize: 11.5, padding: '4px 8px' }}
            >
              单组最高次
            </button>
          ) : null}
        </div>
      </div>

      {/* 选中节点无框素雅墨字行（默认最新一次，点按任意圆点即时变实心红点并切换详情，不设背景色块） */}
      <div
        data-testid="stats-trend-selected-info"
        style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          fontSize: 12.5,
          color: 'var(--ink-2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--f-mono)', color: 'var(--ink)', fontWeight: 600 }}>
            {fmtDate(selectedCoord.at)}
          </span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span style={{ color: 'var(--ink-3)', fontSize: 12 }}>{selectedCoord.dayName}</span>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <strong style={{ fontFamily: 'var(--f-num)', color: 'var(--brick)' }}>
            {selectedCoord.bestWeightKg !== null
              ? `${isAssisted ? '辅助 ' : ''}${fmtWeight(selectedCoord.bestWeightKg)} kg`
              : '未填重量'}
          </strong>
          <span style={{ color: 'var(--ink-4)' }}>·</span>
          <span style={{ fontFamily: 'var(--f-mono)', color: 'var(--ink-3)', fontSize: 12 }}>
            有效 {selectedCoord.totalReps} 次（最高 {selectedCoord.bestReps}）
          </span>
        </div>
        <button
          type="button"
          onClick={() => navigate(`/history/${selectedCoord.sessionId}`)}
          style={{
            appearance: 'none',
            border: 0,
            background: 'transparent',
            padding: '2px 0',
            fontSize: 12,
            color: 'var(--ink-3)',
            cursor: 'pointer',
            flex: 'none',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          查看 ›
        </button>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="152"
        role="img"
        aria-label={`${exercise.name}趋势折线图`}
        data-testid="stats-trend-svg"
        style={{
          display: 'block',
          marginTop: 4,
          overflow: 'visible',
          WebkitTapHighlightColor: 'transparent',
          outline: 'none',
        }}
      >
        {/* Y 轴纸墨参考线与刻度 */}
        <line
          x1={padLeft}
          y1={padTop}
          x2={W - padRight}
          y2={padTop}
          stroke="var(--rule)"
          strokeDasharray="3 3"
          strokeWidth="1"
        />
        {span > 0 ? (
          <line
            x1={padLeft}
            y1={padTop + plotH / 2}
            x2={W - padRight}
            y2={padTop + plotH / 2}
            stroke="var(--rule)"
            strokeDasharray="3 3"
            strokeWidth="1"
          />
        ) : null}
        <line
          x1={padLeft}
          y1={padTop + plotH}
          x2={W - padRight}
          y2={padTop + plotH}
          stroke="var(--rule)"
          strokeWidth="1"
        />

        {span > 0 ? (
          <>
            <text
              x={padLeft - 5}
              y={padTop + 3.5}
              textAnchor="end"
              fontSize="9.5"
              fontFamily="var(--f-num)"
              fill="var(--ink-4)"
            >
              {fmtAxisVal(topAxisVal)}
            </text>
            <text
              x={padLeft - 5}
              y={padTop + plotH / 2 + 3.5}
              textAnchor="end"
              fontSize="9.5"
              fontFamily="var(--f-num)"
              fill="var(--ink-4)"
            >
              {fmtAxisVal(midAxisVal)}
            </text>
            <text
              x={padLeft - 5}
              y={padTop + plotH + 3.5}
              textAnchor="end"
              fontSize="9.5"
              fontFamily="var(--f-num)"
              fill="var(--ink-4)"
            >
              {fmtAxisVal(botAxisVal)}
            </text>
          </>
        ) : (
          <text
            x={padLeft - 5}
            y={padTop + plotH / 2 + 3.5}
            textAnchor="end"
            fontSize="9.5"
            fontFamily="var(--f-num)"
            fill="var(--ink-4)"
          >
            {fmtAxisVal(minVal)}
          </text>
        )}

        {/* 选中点垂直游标线 */}
        <line
          x1={selectedCoord.x}
          y1={padTop}
          x2={selectedCoord.x}
          y2={padTop + plotH}
          stroke="var(--brick)"
          strokeOpacity="0.42"
          strokeDasharray="2 2"
          strokeWidth="1"
        />

        {/* 趋势折线 */}
        <polyline
          fill="none"
          stroke="var(--brick)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />

        {/* X 轴起始、中间与结束日期刻度 */}
        <g data-testid="stats-trend-xticks">
          {tickIndices.map((idx) => {
            const c = coords[idx];
            const isSelected = c.sessionId === selectedCoord.sessionId;
            const anchor =
              idx === 0 ? 'start' : idx === coords.length - 1 ? 'end' : 'middle';
            return (
              <g key={`xtick-${c.sessionId}`}>
                <line
                  x1={c.x}
                  y1={padTop + plotH}
                  x2={c.x}
                  y2={padTop + plotH + 4}
                  stroke={isSelected ? 'var(--brick)' : 'var(--rule-strong, var(--rule))'}
                  strokeWidth="1"
                />
                <text
                  x={c.x}
                  y={H - 6}
                  textAnchor={anchor}
                  fontSize="9.5"
                  fontFamily="var(--f-mono)"
                  fontWeight={isSelected ? '700' : '400'}
                  fill={isSelected ? 'var(--ink)' : 'var(--ink-4)'}
                >
                  {fmtDateShort(c.at)}
                </text>
              </g>
            );
          })}
        </g>

        {/* 选中点顶部数值标签 */}
        <text
          x={selectedCoord.x}
          y={Math.max(12, selectedCoord.y - 8)}
          textAnchor={
            selectedCoord.idx === 0
              ? 'start'
              : selectedCoord.idx === coords.length - 1
                ? 'end'
                : 'middle'
          }
          fontSize="10.5"
          fontFamily="var(--f-num)"
          fontWeight="700"
          fill="var(--brick)"
        >
          {fmtVal(selectedCoord.value)}
        </text>

        {/* 数据节点：未选中为空心圆点，点按选中直接变为实心红点（无外框、无焦点环） */}
        {coords.map((c) => {
          const isSelected = c.sessionId === selectedCoord.sessionId;
          return (
            <g key={c.sessionId}>
              <circle
                cx={c.x}
                cy={c.y}
                r={isSelected ? '4.4' : '3.5'}
                fill={isSelected ? 'var(--brick)' : 'var(--paper-2)'}
                stroke="var(--brick)"
                strokeWidth="2"
                data-selected={isSelected ? '1' : '0'}
              />
              <circle
                cx={c.x}
                cy={c.y}
                r="15"
                fill="transparent"
                data-testid={`stats-trend-point-${c.idx}`}
                style={{
                  cursor: 'pointer',
                  outline: 'none',
                  WebkitTapHighlightColor: 'transparent',
                }}
                onClick={() => setSelectedSessionId(c.sessionId)}
              />
            </g>
          );
        })}
      </svg>

      {invertY ? (
        <div style={{ fontSize: 11.5, color: 'var(--ink-4)', marginTop: 2 }}>
          注：辅助重量越少代表自身力量越强，折线向上表示辅助减少（进步）。
        </div>
      ) : null}
    </div>
  );
}

/**
 * 一次训练的逐行记录文案。
 * 普通组只写「次数 × 重量」；递减组写「R轮S阶段 次数 × 重量」。
 */
export function setRowsText(
  e: Pick<ExerciseHistoryEntry, 'fragments' | 'sets'> & Partial<ExerciseHistoryEntry>,
): string {
  type Row = { reps: number | null; weightKg: number | null; roundIndex: number; stageIndex: number };
  const fmtSet = (s: Row, withRound: boolean): string => {
    const reps = s.reps ?? '—';
    const weight = typeof s.weightKg === 'number' && Number.isFinite(s.weightKg) ? `×${fmtWeight(s.weightKg)}` : '';
    return withRound ? `R${s.roundIndex}S${s.stageIndex} ${reps}${weight}` : `${reps}${weight}`;
  };
  const drop = e.fragments.some((f) => f.kind === 'dropSet');
  if (e.fragments.length <= 1) {
    return e.sets.map((s) => fmtSet(s, drop)).join(' · ');
  }
  return e.fragments
    .map((f) => {
      const rows = f.sets.map((s) => fmtSet(s, f.kind === 'dropSet')).join(' · ');
      return f.kind === 'dropSet' ? `递减：${rows}` : `普通：${rows}`;
    })
    .join(' ＋ ');
}
