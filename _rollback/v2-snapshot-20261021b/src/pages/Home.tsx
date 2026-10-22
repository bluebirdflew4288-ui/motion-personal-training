/* 首页：选择计划 → 看循环位置 → 选部位/训练日 → 开始或继续训练。
   日期来自设备真实时间；训练日与日历解耦，不会因为隔天自动推进。 */

import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { fmtDate, fmtRelativeDay, fmtWeekday } from '../lib/format';
import { StickerPicker, type Focus } from '../ui/StickerPicker';
import { createSession, targetGroupsOf } from '../domain/session';
import { ExerciseOverviewRow } from '../ui/TargetLine';
import type { Plan, PlanDay, Session } from '../domain/types';
import { Sheet } from '../ui/Sheet';
import { pushCycle, skipCycle } from '../domain/cycle';

function currentDay(plan: Plan): PlanDay | undefined {
  return plan.days[plan.cursor];
}

export function Home() {
  const {
    plans,
    settings,
    activeSession,
    activeSessions,
    updateSession,
    completeSession,
    upsertPlan,
    setCurrentPlan,
    pushToast,
    sessions,
    refreshSessions,
  } = useStore();
  // 当前计划持久化在 settings 里（审计 R2-07：导航/刷新后不能回到默认）

  const [focus, setFocus] = useState<Focus>('chest');
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<PlanDay | null>(null);
  /** 已有未结束训练时的冲突引导（任务 F） */
  const [conflict, setConflict] = useState<{ targetDay: PlanDay; existing: Session } | null>(null);

  const plan = useMemo(() => {
    const byId = settings.currentPlanId ? plans.find((p) => p.id === settings.currentPlanId) : undefined;
    return byId ?? plans[0];
  }, [plans, settings.currentPlanId]);
  const today = Date.now();

  const focusDays = useMemo(
    () => (plan ? plan.days.filter((d) => d.kind === 'train' && d.focus === focus) : []),
    [plan, focus],
  );
  const available = useMemo(() => {
    const map = { chest: false, back: false, legs: false } as Record<Focus, boolean>;
    if (plan) for (const d of plan.days) if (d.kind === 'train') map[d.focus] = true;
    return map;
  }, [plan]);

  const recentSessions = useMemo(
    () => sessions.filter((s) => s.status === 'completed').slice(0, 3),
    [sessions],
  );

  if (!plan) {
    return (
      <main className="page page-top page-bottom-space">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">MOTION</div>
          <h2 className="empty-title">还没有训练计划</h2>
          <p className="empty-body">先建立或导入一份计划，然后就能开始记录今天的训练。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/plans')}>
            去计划页
          </button>
        </div>
      </main>
    );
  }

  const cycleDay = currentDay(plan);
  const canStart = true;
  // 旧数据可能残留多条未结束训练：全部列出来让用户逐条处理（任务 F）
  const orphanActives = activeSessions;

  /**
   * 开始训练。
   * 审计任务 F/G：
   * · 只生成记录，**不推进循环**（循环推进只在结束时由用户决定）。
   * · 已有未结束训练时先引导处理，不静默产生第二条 active。
   */
  async function startTraining(day: PlanDay) {
    if (!plan) return;
    if (day.kind === 'rest') {
      pushToast('这一日是休息日，不生成训练记录。', 'info');
      return;
    }
    const existing = activeSessions[0];
    if (existing) {
      // 由 UI 的引导弹层处理，这里只负责兜底阻止
      setConflict({ targetDay: day, existing });
      return;
    }
    const session = createSession(plan, day);
    try {
      await updateSession(session);
      navigate(`/session/${session.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? `无法开始训练：${err.message}` : '无法开始训练', 'error');
    }
  }

  /** 结束已有训练后继续开始新的 */
  async function finishExistingThenStart(endAction: 'complete' | 'discard') {
    const existing = conflict?.existing;
    const target = conflict?.targetDay;
    if (!existing || !target) return;
    try {
      const ended: Session = {
        ...existing,
        status: endAction === 'complete' ? 'completed' : 'discarded',
        endedAt: Date.now(),
        cycleIndexAfter: existing.cycleIndexAtStart,
      };
      await completeSession(ended);
      await refreshSessions();
      setConflict(null);
      // 结束旧训练后不推进循环，由新训练结束时决定
      const session = createSession(plan!, target);
      await updateSession(session);
      navigate(`/session/${session.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? `处理失败：${err.message}` : '处理失败', 'error');
    }
  }

  return (
    <main className="page page-top page-bottom-space">
      {/* ── 刊头 ─────────────────────── */}
      <header style={{ position: 'relative', paddingTop: 6 }}>
        <div className="tape" style={{ left: 52, top: 0, width: 92, height: 20, transform: 'rotate(-3deg)' }} />
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
          <h1 className="h-display" style={{ transform: 'rotate(-1deg)' }}>
            MOTION
          </h1>
          <div style={{ textAlign: 'right', paddingBottom: 4 }}>
            <div className="mono-label" style={{ color: 'var(--brick)', fontWeight: 500 }}>
              {fmtWeekday(today)} · {fmtDate(today)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>今日训练</div>
          </div>
        </div>
        <hr className="rule-line" style={{ marginTop: 10 }} />
      </header>

      {/* ── 计划 + 循环位置 ───────────── */}
      <section style={{ marginTop: 12 }}>
        <button
          className="row"
          style={{ borderBottom: '1px solid var(--rule)', paddingTop: 8, paddingBottom: 8 }}
          onClick={() => setPlanPickerOpen(true)}
          aria-label="切换当前计划"
        >
          <span className="row-main">
            <span className="mono-label" style={{ display: 'block' }}>
              当前计划
            </span>
            <span className="row-title" style={{ marginTop: 2 }}>
              {plan.name}
            </span>
          </span>
          <span className="row-end" style={{ color: 'var(--ink-3)', fontSize: 13 }}>
            切换 ›
          </span>
        </button>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            borderLeft: '3px solid var(--brick)',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div className="mono-label">循环位置 {plan.cursor + 1} / {plan.days.length}</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
              {cycleDay?.kind === 'rest' ? `${cycleDay.name}日` : `下一练 · ${cycleDay?.name}`}
            </div>
            {cycleDay?.kind === 'rest' && cycleDay.restNote ? (
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>{cycleDay.restNote}</div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  await upsertPlan(skipCycle(plan));
                  pushToast(`已跳过「${cycleDay?.name}」，循环前进一位。`);
                } catch (e) {
                  pushToast(e instanceof Error ? e.message : '跳过失败', 'error');
                }
              }}
            >
              跳过
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  await upsertPlan(pushCycle(plan));
                  pushToast('循环已前进一位。');
                } catch (e) {
                  pushToast(e instanceof Error ? e.message : '推进失败', 'error');
                }
              }}
            >
              推进
            </button>
          </div>
        </div>
      </section>

      {/* ── 继续未结束训练 ───────────── */}
      {activeSession ? (
        <section style={{ marginTop: 14 }}>
          <div
            className="slip torn-bottom"
            style={{ padding: 14, borderColor: 'var(--brick)', borderWidth: 1.5 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div className="mono-label" style={{ color: 'var(--brick)' }}>
                  进行中
                </div>
                <div style={{ fontFamily: 'var(--f-serif)', fontSize: 19, fontWeight: 700, marginTop: 2 }}>
                  {activeSession.day.dayName}
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                  {fmtRelativeDay(activeSession.startedAt)}开始 · {activeSession.planName}
                </div>
              </div>
              <button
                className="btn btn-primary"
                onClick={() => navigate(`/session/${activeSession.id}`)}
                style={{ flex: 'none' }}
              >
                继续
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── 部位贴纸 ─────────────────── */}
      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">今天练什么</h2>
          <span className="mono-label">点贴纸切换</span>
        </div>
        <StickerPicker value={focus} onChange={setFocus} available={available} />
      </section>

      {/* ── 训练日选择 ───────────────── */}
      <section style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {focusDays.map((d) => {
            const isCycle = cycleDay?.id === d.id;
            const total = d.exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0);
            return (
              <button
                key={d.id}
                className="slip"
                onClick={() => setPendingStart(d)}
                style={{
                  flex: '1 1 46%',
                  minWidth: 0,
                  padding: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderWidth: isCycle ? 1.5 : 1,
                  borderColor: isCycle ? 'var(--brick)' : 'var(--rule)',
                  background: 'var(--paper-2)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--f-serif)', fontSize: 19, fontWeight: 700 }}>{d.name}</span>
                  <span className="mono-label" style={{ fontSize: 11 }}>
                    {d.round} 轮
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
                  {d.exercises.length} 个动作 · {total} 组
                </div>
                {isCycle ? (
                  <span className="tag tag-brick" style={{ marginTop: 8 }}>
                    循环当前
                  </span>
                ) : null}
              </button>
            );
          })}
          {!focusDays.length ? (
            <div className="empty" style={{ width: '100%' }}>
              <div className="empty-title" style={{ padding: 20 }}>这个部位在计划里还没有训练日</div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── 今日动作概览 ─────────────── */}
      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">动作概览</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setDayPickerOpen(true)}>
            全部训练日
          </button>
        </div>
        <div className="slip" style={{ marginTop: 8 }}>
          {focusDays.map((d) => (
            <div key={d.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{d.name}</span>
                <span className="mono-label" style={{ fontSize: 11 }}>
                  {d.exercises.length} 个动作
                </span>
              </div>
              <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
                {d.exercises.map((ex) => (
                  <ExerciseOverviewRow key={ex.id} ex={ex} />
                ))}
              </ul>
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => setPendingStart(d)}
              >
                开始 {d.name}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* ── 最近完成 ─────────────────── */}
      {recentSessions.length ? (
        <section style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section">最近完成</h2>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/history')}>
              全部历史
            </button>
          </div>
          <div className="rows" style={{ marginTop: 4 }}>
            {recentSessions.map((s) => (
              <button key={s.id} className="row" onClick={() => navigate(`/history/${s.id}`)}>
                <span className="row-main">
                  <span className="row-title">{s.day.dayName}</span>
                  <span className="row-sub">
                    {fmtRelativeDay(s.endedAt ?? s.startedAt)} · {s.exercises.length} 个动作
                  </span>
                </span>
                <span className="row-end">›</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* 未结束训练列表：正常情况下最多 1 条，旧数据可能更多（任务 F） */}
      {orphanActives.length > 1 ? (
        <section style={{ marginTop: 14 }}>
          <div className="slip" style={{ padding: 14, borderColor: 'var(--warn)', borderWidth: 1.5 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--warn)' }}>
              有 {orphanActives.length} 个未结束的训练
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '6px 0 10px', lineHeight: 1.6 }}>
              这个版本一次只允许进行一个训练。请逐条处理：继续其中一个，其余结束或放弃。数据不会被删除。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {orphanActives.map((s) => (
                <div
                  key={s.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 0',
                    borderTop: '1px dashed var(--rule)',
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ flex: '1 1 120px', fontSize: 14 }}>
                    {s.day.dayName}
                    <span style={{ color: 'var(--ink-4)', marginLeft: 6, fontSize: 12 }}>
                      {fmtRelativeDay(s.startedAt)}
                    </span>
                  </span>
                  <button className="btn btn-sm btn-primary" onClick={() => navigate(`/session/${s.id}`)}>
                    继续
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      await completeSession({ ...s, status: 'completed', endedAt: Date.now() });
                      await refreshSessions();
                      pushToast('已结束该训练。');
                    }}
                  >
                    结束
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ color: 'var(--brick)' }}
                    onClick={async () => {
                      await completeSession({ ...s, status: 'discarded', endedAt: Date.now() });
                      await refreshSessions();
                      pushToast('已放弃该训练。');
                    }}
                  >
                    放弃
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* 单活动训练冲突引导 */}
      <Sheet
        open={!!conflict}
        title="已有未结束的训练"
        onClose={() => setConflict(null)}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => {
                const id = conflict?.existing.id;
                setConflict(null);
                if (id) navigate(`/session/${id}`);
              }}
            >
              继续原训练（{conflict?.existing.day.dayName}）
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => void finishExistingThenStart('complete')}>
              结束原训练，再开始 {conflict?.targetDay.name}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%', color: 'var(--brick)' }}
              onClick={() => void finishExistingThenStart('discard')}
            >
              放弃原训练，再开始 {conflict?.targetDay.name}
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => setConflict(null)}>
              取消
            </button>
          </div>
        }
      >
        <div style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--ink-2)' }}>
          你正在进行
          <strong> {conflict?.existing.day.dayName}</strong>
          （{conflict?.existing ? fmtRelativeDay(conflict.existing.startedAt) : ''}开始）。
          这个版本一次只允许一个训练进行中。请选择如何处理原训练，再开始
          <strong> {conflict?.targetDay.name}</strong>。
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-3)' }}>
            放弃会丢弃原训练已记录的内容，且不能撤销。
          </div>
        </div>
      </Sheet>

      {/* 计划选择 */}
      <Sheet open={planPickerOpen} title="选择计划" onClose={() => setPlanPickerOpen(false)}>
        <div className="rows">
          {plans.map((p) => (
            <button
              key={p.id}
              className="row"
              onClick={() => {
                void setCurrentPlan(p.id);
                setPlanPickerOpen(false);
              }}
            >
              <span className="row-main">
                <span className="row-title">{p.name}</span>
                <span className="row-sub">
                  {p.days.length} 天循环 · {p.days.filter((d) => d.kind === 'train').length} 个训练日
                </span>
              </span>
              {p.id === plan.id ? <span className="row-end tag tag-brick">当前</span> : null}
            </button>
          ))}
        </div>
        <button className="btn btn-ghost" style={{ marginTop: 12, width: '100%' }} onClick={() => navigate('/plans')}>
          管理计划
        </button>
      </Sheet>

      {/* 全部训练日 */}
      <Sheet open={dayPickerOpen} title="全部训练日" onClose={() => setDayPickerOpen(false)}>
        <div className="rows">
          {plan.days.map((d, i) => (
            <button
              key={d.id}
              className="row"
              onClick={() => {
                setDayPickerOpen(false);
                if (d.kind === 'rest') {
                  pushToast('休息日不生成训练记录，可在首页「推进」循环。');
                  return;
                }
                setPendingStart(d);
              }}
            >
              <span className="row-main">
                <span className="row-title">
                  {i + 1}. {d.name}
                  {d.kind === 'rest' ? '（休息）' : ''}
                </span>
                <span className="row-sub">
                  {d.kind === 'rest' ? d.restNote : `${d.exercises.length} 个动作`}
                </span>
              </span>
              {i === plan.cursor ? <span className="row-end tag tag-brick">当前</span> : null}
            </button>
          ))}
        </div>
      </Sheet>

      {/* 开始前确认：是否推进循环 */}
      <Sheet
        open={!!pendingStart}
        title={pendingStart ? `开始 ${pendingStart.name}` : ''}
        onClose={() => setPendingStart(null)}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              disabled={!canStart}
              onClick={() => {
                const d = pendingStart!;
                setPendingStart(null);
                void startTraining(d);
              }}
            >
              开始训练
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => setPendingStart(null)}>
              取消
            </button>
          </div>
        }
      >
        {pendingStart ? (
          <>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>
              计划：{plan.name}
              <br />
              动作：{pendingStart.exercises.length} 个 ·{' '}
              {pendingStart.exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0)} 组
              <br />
              热身：{pendingStart.warmups.length} 项（不计入正式组）
            </div>
            <div
              style={{
                marginTop: 12,
                padding: 10,
                background: 'var(--paper-3)',
                fontSize: 13,
                lineHeight: 1.6,
                color: 'var(--ink-2)',
              }}
            >
              {cycleDay?.id === pendingStart.id
                ? '这是循环当前位置。结束后可选择是否推进。'
                : `这不是循环当前位置（当前是「${cycleDay?.name}」）。开始后循环位置不会自动改变。`}
            </div>
          </>
        ) : null}
      </Sheet>

    </main>
  );
}
