/* 历史：按日期浏览 → 详情 → 纠正误录 / 删除。
   示例数据不会混进真实记录：这里只读 IndexedDB 里 status='completed' 的记录。 */

import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { fmtDateWithWeek, fmtDuration, fmtTime, fmtWeight } from '../lib/format';
import type { Session, SessionSet } from '../domain/types';
import { isSetLogged, summarizeSession, withSet } from '../domain/session';
import { sessionKindOf } from '../domain/sessionKind';
import { describeCardioParams, liveElapsedMs } from '../domain/cardio';
import { Confirm } from '../ui/Confirm';
import { DraftCell } from '../ui/DraftCell';
import { deleteSession } from '../db/repo';
import { atomicDeleteRest, revisionOf } from '../db/tx';

export function HistoryPage() {
  const { sessions } = useStore();
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState<string>('all');

  /**
   * 历史列表包含完全休息记录（可见），
   * 但「X 次完成」这类**训练次数**必须排除 rest（第2阶段统计口径）。
   */
  const completedAll = useMemo(
    () => sessions.filter((s) => s.status === 'completed' && s.endedAt),
    [sessions],
  );
  const completed = useMemo(
    () => completedAll.filter((s) => sessionKindOf(s) !== 'rest'),
    [completedAll],
  );

  const months = useMemo(() => {
    const set = new Set<string>();
    for (const s of completedAll) {
      const d = new Date(s.startedAt);
      set.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return [...set].sort().reverse();
  }, [completed]);

  /** 列表展示**包含**休息记录（历史可见），但训练次数统计排除 */
  const filtered = useMemo(() => {
    let list = completedAll;
    if (month !== 'all') {
      list = list.filter((s) => {
        const d = new Date(s.startedAt);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month;
      });
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (s) =>
          s.day.dayName.toLowerCase().includes(q) ||
          s.planName.toLowerCase().includes(q) ||
          s.exercises.some((e) => e.name.toLowerCase().includes(q)) ||
          s.note.toLowerCase().includes(q),
      );
    }
    return list;
  }, [completedAll, month, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const key = fmtDateWithWeek(s.startedAt);
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          训练历史
        </h1>
        <span className="mono-label">{completed.length} 次完成</span>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: '1 1 180px', minHeight: 42, fontSize: 15 }}
          placeholder="搜索日期 / 动作 / 备注"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索历史"
        />
        <select className="input" style={{ flex: '0 0 auto', minHeight: 42, fontSize: 15 }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="按月份筛选">
          <option value="all">全部月份</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m.replace('-', ' 年 ')} 月
            </option>
          ))}
        </select>
      </div>

      {/* G2：只有休息记录时也不能显示 EMPTY —— 休息是可见记录，可查看/撤销。
          空态以"可展示记录"为准；上方的训练次数仍排除休息。 */}
      {!completedAll.length ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <div className="empty-mark">EMPTY</div>
          <h2 className="empty-title">还没有任何记录</h2>
          <p className="empty-body">
            在首页选一个训练日，记录并结束第一次训练后，这里会按日期出现完整记录。未结束的训练不会出现在历史里。
          </p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/')}>
            去开始训练
          </button>
        </div>
      ) : !filtered.length ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <div className="empty-title">没有符合条件的记录</div>
          <p className="empty-body">换个关键词或清空筛选看看。</p>
        </div>
      ) : (
        grouped.map(([day, list]) => (
          <section key={day} style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section" style={{ fontSize: 15 }}>
                {day}
              </h2>
              {/* 日级"次数"同样排除休息，避免把休息显示成"1 次"训练 */}
              <span className="mono-label">
                {list.filter((x) => sessionKindOf(x) !== 'rest').length} 次
              </span>
            </div>
            <div className="rows" style={{ marginTop: 2 }}>
              {list.map((s) => {
                const sum = summarizeSession(s, s.endedAt ?? Date.now());
                const kind = sessionKindOf(s);
                return (
                  <button key={s.id} className="row" onClick={() => navigate(`/history/${s.id}`)}>
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
                      <span className="row-title">
                        {s.day.dayName}
                        {s.cycleIndexAtStart !== undefined ? '' : ''}
                      </span>
                      <span className="row-sub">
                        {kind === 'rest' ? (
                          <>完全休息 · 不计入训练次数</>
                        ) : (
                          <>
                            {sum.completedSets > 0 ? `${sum.completedSets} 组 · ` : ''}
                            {fmtDuration(sum.durationMs)}
                            {sum.cardioMs > 0 ? ` · 有氧 ${fmtDuration(sum.cardioMs)}` : ''}
                            {sum.partialGroups ? ` · ${sum.partialGroups} 部分` : ''}
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
        ))
      )}
    </main>
  );
}

export function HistoryDetailPage({ id }: { id: string }) {
  const { sessions, refreshSessions, pushToast, saveHistorySession } = useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const session = sessions.find((s) => s.id === id);

  /** 编辑草稿：编辑期间不动正式历史，保存才写库（审计任务 H） */
  const [draft, setDraft] = useState<Session | null>(null);
  const [saving, setSaving] = useState(false);
  /** 进入纠错时的记录版本：保存必须带它，冲突时不覆盖别人（V3-01） */
  const [draftRevision, setDraftRevision] = useState<number>(0);
  /**
   * 单元格级校验状态：任一非法则禁止保存（R01）。
   * V3-04：这套状态必须跟草稿同生命周期 ——
   * 取消/重新进入纠错时要清空，否则子输入已卸载、父级还记着旧错误，
   * 保存按钮会一直是 disabled（审查 I04）。
   */
  const [cellErrors, setCellErrors] = useState<Record<string, boolean>>({});
  const setCellValid = (key: string, ok: boolean) =>
    setCellErrors((prev) => {
      if (ok) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key]) return prev;
      return { ...prev, [key]: true };
    });
  const hasCellErrors = Object.keys(cellErrors).length > 0;
  const editing = draft !== null;
  const view = draft ?? session;

  if (!session) {
    return (
      <main className="page page-top page-bottom-space">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-title">找不到这条记录</div>
          <p className="empty-body">它可能已经被删除。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/history')}>
            返回历史
          </button>
        </div>
      </main>
    );
  }

  /** 更新草稿里的某个组（不写库） */
  const updateDraftSet = (exId: string, setId: string, patch: Partial<SessionSet>) => {
    setDraft((d) => (d ? withSet(d, exId, setId, patch) : d));
  };

  /** 保存草稿 → 正式历史；统计与上次表现随后刷新（V3-01：受约束入口 + revision 冲突保护） */
  const saveDraft = async () => {
    if (!draft) return;
    // R01：保存前统一校验所有数值，NaN/Infinity/负数/非整数一律拒绝
    for (const ex of draft.exercises) {
      for (const st of ex.sets) {
        if (st.reps !== null && (!Number.isFinite(st.reps) || st.reps < 0 || !Number.isInteger(st.reps))) {
          pushToast(`「${ex.name}」有一组的次数不是合法整数，已阻止保存。`, 'error');
          return;
        }
        if (st.weightKg !== null && (!Number.isFinite(st.weightKg) || st.weightKg < 0)) {
          pushToast(`「${ex.name}」有一组的重量不是合法数值，已阻止保存。`, 'error');
          return;
        }
      }
    }
    setSaving(true);
    try {
      const r = await saveHistorySession({ ...draft, revision: draftRevision }, draftRevision);
      if (!r.ok) {
        // 冲突时保留草稿，让用户自己决定是否放弃重来（不静默覆盖、不丢输入）
        pushToast(r.message, 'error');
        return;
      }
      await refreshSessions();
      // 成功保存 → 草稿与错误一起清空
      setDraft(null);
      setCellErrors({});
      pushToast('已保存修改，统计已更新。');
    } catch (err) {
      pushToast(err instanceof Error ? `保存失败：${err.message}` : '保存失败', 'error');
    } finally {
      setSaving(false);
    }
  };

  /** 进入纠错：克隆当前记录 + 记录版本 + 清空上一次残留的字段错误 */
  const startEditing = () => {
    setCellErrors({});
    setDraftRevision(revisionOf(session));
    setDraft(structuredClone(session));
  };

  /** 取消纠错：丢弃草稿并清空字段错误，重新进入时不会残留 disabled（审查 I04） */
  const cancelEditing = () => {
    setCellErrors({});
    setDraft(null);
  };

  const sum = summarizeSession(view!, view!.endedAt ?? Date.now());
  const activeExercises = view!.exercises.filter(
    (e) => e.status !== 'skipped' && e.sets.some((st) => isSetLogged(st)),
  );

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/history')}>
          ‹ 历史
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--brick)' }} onClick={() => setConfirmDelete(true)}>
          删除
        </button>
      </header>

      <section className="slip torn-bottom" style={{ marginTop: 12, padding: '16px 16px 24px' }}>
        <div className="mono-label">{fmtDateWithWeek(session.startedAt)}</div>
        <h1 className="h-serif" style={{ fontSize: 30, marginTop: 4 }}>
          {session.day.dayName}
        </h1>
        <div style={{ fontSize: 14, color: 'var(--ink-3)', marginTop: 4 }}>
          {session.planName} · {fmtTime(session.startedAt)} – {session.endedAt ? fmtTime(session.endedAt) : '—'}
        </div>

        {/*
          顶部摘要按类型显示（第2阶段 G8）：
          · 休息 → 完全不显示力量摘要（下方有专门的「完全休息」区块）
          · 纯有氧（无力量动作）→ 只显示总用时与有氧时长，不显示伪 0/0 完成组、动作分母
          · 力量 / 力量+有氧 → 保留原有三项（完成组 / 时长 / 动作）
        */}
        {sessionKindOf(session) === 'rest' ? null : sessionKindOf(session) === 'cardio' ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 10,
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--rule)',
            }}
          >
            <div>
              <div className="mono-label">总用时</div>
              <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                {fmtDuration(sum.durationMs)}
              </div>
            </div>
            <div>
              <div className="mono-label">有氧时长</div>
              <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                {fmtDuration(sum.cardioMs)}
              </div>
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10,
                marginTop: 14,
                paddingTop: 12,
                borderTop: '1px solid var(--rule)',
              }}
            >
              <div>
                <div className="mono-label">完成组</div>
                <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                  {sum.completedSets}
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>/{sum.targetSets}</span>
                </div>
              </div>
              <div>
                <div className="mono-label">时长</div>
                <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                  {fmtDuration(sum.durationMs)}
                </div>
              </div>
              <div>
                <div className="mono-label">动作</div>
                <div style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
                  {sum.exercisesDone}
                  <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>/{session.exercises.length}</span>
                </div>
              </div>
            </div>
            {sum.cardioMs > 0 ? (
              <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-3)' }}>
                其中有氧 {fmtDuration(sum.cardioMs)}（与总用时分别统计，不相加）
              </div>
            ) : null}
            {sum.partialGroups ? (
              <div style={{ marginTop: 10 }}>
                <span className="tag tag-warn">{sum.partialGroups} 个部分完成大组（未按完整组统计）</span>
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* 完全休息：不展示力量摘要，明确标注不计入训练次数 */}
      {sessionKindOf(session) === 'rest' ? (
        <section style={{ marginTop: 16 }}>
          <h2 className="h-section">完全休息</h2>
          <div
            style={{
              marginTop: 8,
              padding: '10px 12px',
              background: 'var(--paper-3)',
              borderLeft: '3px solid var(--rule-strong)',
              fontSize: 13,
              lineHeight: 1.7,
              color: 'var(--ink-2)',
            }}
          >
            这一天记录为完全休息（{session.restDate ?? '日期未知'}）。
            不计入训练次数、时长、力量组数或有氧量。
          </div>
        </section>
      ) : null}

      {/* 有氧明细：与力量同一条历史，时长单列（不并入总时长） */}
      {(session.cardio ?? []).length ? (
        <section style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section">有氧</h2>
            <span className="mono-label">共 {fmtDuration(sum.cardioMs)}</span>
          </div>
          {(session.cardio ?? []).map((c) => (
            <div key={c.id} className="slip" style={{ marginTop: 8, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontWeight: 600 }}>{c.name}</span>
                <span className="mono-label">{fmtDuration(liveElapsedMs(c, session.endedAt ?? Date.now()))}</span>
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 4 }}>
                {describeCardioParams(c.preset, c.currentParams)} · {c.segments.length} 段
              </div>
              {c.segments.map((seg) => (
                <div
                  key={seg.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 12,
                    color: 'var(--ink-2)',
                    padding: '3px 0',
                    borderBottom: '1px dashed var(--rule)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--f-mono)' }}>
                    {fmtDuration(seg.startElapsedMs)} –{' '}
                    {seg.endElapsedMs === null ? '进行中' : fmtDuration(seg.endElapsedMs)}
                  </span>
                  <span>{describeCardioParams(c.preset, seg.params)}</span>
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : null}

      {session.warmups.length ? (
        <section style={{ marginTop: 16 }}>
          <h2 className="h-section">热身</h2>
          <div style={{ fontSize: 14, color: 'var(--ink-3)', marginTop: 4 }}>
            {session.warmups.filter((w) => w.done).length} / {session.warmups.length} 项已做（不计入正式组）
          </div>
        </section>
      ) : null}

      {/* 动作明细只适用于力量记录（含力量+有氧的 mixed）。
          休息 / 纯有氧没有力量 set 编辑器，不显示空区避免误导（G8）。 */}
      {sessionKindOf(session) !== 'strength' ? null : (
      <section style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <h2 className="h-section">动作明细</h2>
          {editing ? (
            <span className="tag tag-brick">编辑中</span>
          ) : (
            <button
              className="btn btn-ghost btn-sm"
              onClick={startEditing}
              style={{ minHeight: 44 }}
            >
              纠正数据
            </button>
          )}
        </div>

        {editing ? (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 0', lineHeight: 1.6 }}>
            修改只影响这条历史记录，不会改动训练计划。保存后统计与「上次表现」会同步更新。
          </p>
        ) : null}

        {view!.exercises.map((ex) => {
          const validSets = ex.sets.filter(isSetLogged);
          return (
            <div key={ex.id} className="slip" style={{ marginTop: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <span
                  style={{
                    fontFamily: 'var(--f-sans)',
                    fontSize: 16,
                    fontWeight: 600,
                    lineHeight: 1.4,
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                  }}
                >
                  {ex.name}
                </span>
                {ex.status === 'skipped' ? (
                  <span className="tag tag-quiet" style={{ flex: 'none' }}>跳过</span>
                ) : validSets.length ? (
                  <span className="tag tag-ok" style={{ flex: 'none' }}>
                    {ex.target.kind === 'dropSet' ? `${validSets.length} 阶段` : `${validSets.length} 组`}
                  </span>
                ) : (
                  <span className="tag tag-quiet" style={{ flex: 'none' }}>未记录</span>
                )}
              </div>

              {!editing ? (
                validSets.length ? (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {validSets.map((st) => (
                      <span key={st.id} className="tag tag-quiet" style={{ fontFamily: 'var(--f-num)', fontSize: 12 }}>
                        {ex.target.kind === 'dropSet' ? `R${st.roundIndex}S${st.stageIndex}` : `#${st.roundIndex}`}
                        {' · '}
                        {st.reps} 次
                        {st.weightKg !== null && st.weightKg > 0 ? ` × ${fmtWeight(st.weightKg)} kg` : ''}
                      </span>
                    ))}
                  </div>
                ) : null
              ) : (
                /* 编辑态：逐组改次数 / 重量 / 完成状态 */
                <div style={{ marginTop: 8 }}>
                  {ex.sets.map((st) => (
                    <div
                      key={st.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 0',
                        borderTop: '1px dashed var(--rule)',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--ink-4)', width: 56, flex: 'none' }}>
                        {ex.target.kind === 'dropSet' ? `R${st.roundIndex}S${st.stageIndex}` : `第 ${st.roundIndex} 组`}
                      </span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                        次数
                        <DraftCell
                          value={st.reps}
                          integer
                          min={0}
                          max={9999}
                          width={74}
                          ariaLabel={`${ex.name} 第 ${st.roundIndex} 轮 阶段 ${st.stageIndex} 次数`}
                          onValidityChange={(ok) => setCellValid(`${st.id}:reps`, ok)}
                          onCommit={(v) => updateDraftSet(ex.id, st.id, { reps: v })}
                        />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                        重量
                        <DraftCell
                          value={st.weightKg}
                          min={0}
                          max={9999}
                          width={84}
                          unit="kg"
                          ariaLabel={`${ex.name} 第 ${st.roundIndex} 轮 阶段 ${st.stageIndex} 重量`}
                          onValidityChange={(ok) => setCellValid(`${st.id}:weight`, ok)}
                          onCommit={(v) => updateDraftSet(ex.id, st.id, { weightKg: v })}
                        />
                      </label>
                      <button
                        className={`btn btn-sm ${st.status === 'done' ? 'btn-primary' : 'btn-ghost'}`}
                        style={{ minWidth: 72, minHeight: 44 }}
                        onClick={() =>
                          updateDraftSet(ex.id, st.id, {
                            status: st.status === 'done' ? 'blank' : 'done',
                          })
                        }
                      >
                        {st.status === 'done' ? '已完成' : '未完成'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {ex.note ? (
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>{ex.note}</div>
              ) : null}
            </div>
          );
        })}

        {editing ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1, minHeight: 48 }}
              disabled={saving || hasCellErrors}
              onClick={() => void saveDraft()}
            >
              {saving ? '保存中…' : hasCellErrors ? '请先修正红框字段' : '保存修改'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ flex: 1, minHeight: 48 }}
              disabled={saving}
              onClick={cancelEditing}
            >
              取消
            </button>
          </div>
        ) : null}
      </section>
      )}

      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">训练备注</h2>
          <span className="mono-label" style={{ fontSize: 12 }}>
            随「纠正数据」一起保存
          </span>
        </div>
        {editing ? (
          <textarea
            className="input"
            style={{ marginTop: 8 }}
            value={view!.note}
            aria-label="训练备注"
            placeholder="训练备注"
            onChange={(e) => setDraft((d) => (d ? { ...d, note: e.target.value } : d))}
          />
        ) : (
          <p style={{ fontSize: 14, color: session.note ? 'var(--ink-2)' : 'var(--ink-4)', marginTop: 6 }}>
            {session.note || '没有备注'}
          </p>
        )}
      </section>

      <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => navigate('/stats')}>
          查看统计
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => {
            const first = activeExercises[0];
            // 用动作身份而不是计划条目：跨 A/B 也能看到同一动作的历史
            if (first) navigate(`/stats?exercise=${encodeURIComponent(first.exerciseId)}`);
            else navigate('/stats');
          }}
        >
          动作表现
        </button>
      </div>

      <Confirm
        open={confirmDelete}
        title={sessionKindOf(session) === 'rest' ? '撤销这条完全休息记录？' : '删除这条训练记录？'}
        body={
          sessionKindOf(session) === 'rest'
            ? '撤销只影响这条休息记录，不会删除任何真实训练，也不会回退循环位置。'
            : '删除后这条记录不再计入统计，也不能恢复。建议先导出备份。'
        }
        confirmText="删除"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            /**
             * G2：撤销完全休息必须走**受约束事务入口**（atomicDeleteRest），
             * 而不是裸 `deleteSession`。它按稳定身份（session.id + kind + 固定
             * restDate）核验，别页已改动/重建同日记录时返回冲突，
             * 且只删该 rest、不碰真实训练、不回退 cursor。
             */
            if (sessionKindOf(session) === 'rest') {
              const r = await atomicDeleteRest({
                session,
                restDate: session.restDate ?? '',
              });
              if (!r.ok) {
                // 等待事务真实结果：失败不关窗、不假报已撤销
                pushToast(r.message, 'error');
                return;
              }
            } else {
              await deleteSession(session.id);
            }
            await refreshSessions();
            setConfirmDelete(false);
            pushToast(
              sessionKindOf(session) === 'rest'
                ? '已撤销这条完全休息记录。'
                : '记录已删除，统计已同步更新。',
            );
            navigate('/history');
          } catch (err) {
            pushToast(err instanceof Error ? `删除失败：${err.message}` : '删除失败', 'error');
          }
        }}
      />
    </main>
  );
}
