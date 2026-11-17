/* 统计页：只用真实记录算，样本不足时不画趋势。 */

import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { fmtDate, fmtDateShort, fmtDuration, fmtWeight } from '../lib/format';
import { buildExerciseHistory, buildOverview, listTrainedExercises } from '../domain/stats';
import type { ExerciseHistoryEntry } from '../domain/stats';
import { listComparabilityModes, describeGroupCounts } from '../domain/comparability';
import type { DumbbellBasis, WeightMode } from '../domain/types';

export function StatsPage({ focusExercise }: { focusExercise?: string }) {
  const { sessions } = useStore();
  const [exerciseKey, setExerciseKey] = useState<string | null>(focusExercise ?? null);
  /** V3-05：计量口径必须可见、可切换；不同口径不合并成一条曲线 */
  const [modeKey, setModeKey] = useState<string | null>(null);

  const overview = useMemo(() => buildOverview(sessions), [sessions]);
  const trained = useMemo(() => listTrainedExercises(sessions), [sessions]);
  const selectedKey = exerciseKey ?? trained[0]?.key ?? null;
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

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          统计
        </h1>
        <span className="mono-label">仅统计已完成记录</span>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      {!overview.totalSessions ? (
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
            {[
              { k: '训练次数', v: `${overview.totalSessions}`, u: '次' },
              { k: '正式组总数', v: `${overview.totalSets}`, u: '组' },
              { k: '平均时长', v: fmtDuration(overview.avgDurationMs), u: '' },
              { k: '平均组数', v: `${overview.avgSetsPerSession}`, u: '组/次' },
            ].map((item) => (
              <div key={item.k} className="slip" style={{ padding: '12px 14px' }}>
                <div className="mono-label">{item.k}</div>
                <div style={{ fontFamily: 'var(--f-num)', fontSize: 26, fontWeight: 700, marginTop: 2 }}>
                  {item.v}
                  {item.u ? <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 3 }}>{item.u}</span> : null}
                </div>
              </div>
            ))}
          </section>

          {/* 每周频率 */}
          <section style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">每周训练频率</h2>
              <span className="mono-label">最近 {overview.weeks.length} 周</span>
            </div>
            <div className="slip" style={{ marginTop: 8, padding: '14px 14px 10px' }}>
              {overview.weeks.length < 2 ? (
                <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>
                  本周完成 <strong style={{ fontFamily: 'var(--f-num)', fontSize: 17 }}>{overview.weeks[0]?.count ?? 0}</strong> 次。
                  至少累计两周数据后，这里才会出现周对比。
                </p>
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 96 }}>
                  {overview.weeks.map((w) => (
                    <div
                      key={w.key}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 0 }}
                    >
                      <span style={{ fontSize: 12, fontFamily: 'var(--f-num)', fontWeight: 700 }}>{w.count}</span>
                      <div
                        style={{
                          width: '100%',
                          maxWidth: 40,
                          height: Math.max(6, (w.count / maxWeekCount) * 58),
                          background: 'var(--brick)',
                          opacity: w.count ? 1 : 0.2,
                        }}
                        aria-label={`第 ${w.label} 周 ${w.count} 次`}
                      />
                      <span className="mono-label" style={{ fontSize: 10 }}>{w.label}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* 分部次数 */}
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
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
              <h2 className="h-section">单个动作表现</h2>
              <select
                className="input"
                style={{ flex: '0 0 auto', maxWidth: 190, minHeight: 40, fontSize: 14 }}
                value={selectedKey ?? ''}
                onChange={(e) => {
                  setExerciseKey(e.target.value);
                  setModeKey(null);
                }}
                aria-label="选择动作"
              >
                {trained.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}（{t.count} 次）
                  </option>
                ))}
              </select>
            </div>

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
                      onClick={() => setModeKey(`${m.weightMode}::${m.dumbbellBasis}`)}
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
                      最高重量{exercise.label ? `（${exercise.label}）` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                      {exercise.maxWeightKg !== null ? `${fmtWeight(exercise.maxWeightKg)} kg` : '未记录重量'}
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
                          {/*
                            V4-04 B：**不许用除法**。
                            旧实现 `Math.floor(e.sets.length / e.stageCount)` 会把
                            「3 轮各只做阶段 1」的 3 行除以 3 阶段算成 1 个完整大组，
                            凭空造出从未存在过的大组。这里直接用按轮结构判定出的
                            completeGroups / partialGroups / loggedStages（describeGroupCounts）。
                          */}
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
            口径：热身不计入正式组；计划内未完成的组不算完成组；递减组按大组计数；部分完成的大组单独标注。
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

/**
 * 一次训练的逐行记录文案。
 * 普通组只写「次数 × 重量」；递减组写「R轮S阶段 次数 × 重量」。
 * V4-04 A：同一次训练可能有多个片段（普通 + 递减），**每个片段各自从 R1 开始编号**，
 * 因此必须按片段分组显示；若把它们的行拍平，会出现两个 `R1S1` 互相矛盾。
 * 纯单片段时保持原来的单行格式（不改变既有观感）。
 */
export function setRowsText(e: ExerciseHistoryEntry): string {
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
  // 多片段：按片段分别列出，片段间用「 + 」分隔（各片段保留自己的轮/阶段编号）
  return e.fragments
    .map((f) => {
      const rows = f.sets.map((s) => fmtSet(s, f.kind === 'dropSet')).join(' · ');
      return f.kind === 'dropSet' ? `递减：${rows}` : `普通：${rows}`;
    })
    .join(' ＋ ');
}
