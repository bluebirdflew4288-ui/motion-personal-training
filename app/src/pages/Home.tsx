/* 首页：选择计划 → 看循环位置 → 选训练日 → 开始或继续训练。
   日期来自设备真实时间；训练日与日历解耦，不会因为隔天自动推进。
   G4：贴纸改为「每个具体 PlanDay 一张」，身份 = planId + day.id。 */

import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { coordinateBackupExport } from '../lib/backupCoordinator';
import { evaluateBackupNudge } from '../domain/backupNudge';
import { fmtDate, fmtRelativeDay, fmtWeekday } from '../lib/format';
import {
  StickerPicker,
  dayStickerKey,
  nextSelectedDayId,
  planDayStickers,
  resolveSelectedDay,
} from '../ui/StickerPicker';
import {
  createSession,
  createAdhocCardioSession,
  createRestSession,
  targetGroupsOf,
} from '../domain/session';
import { localDateKey } from '../domain/localDate';
import { sessionKindOf } from '../domain/sessionKind';
import { atomicCreateRest } from '../db/tx';
import { ExerciseOverviewRow } from '../ui/TargetLine';
import type { Plan, PlanDay, Session } from '../domain/types';
import { Sheet } from '../ui/Sheet';
import { pushCycle, skipCycle } from '../domain/cycle';
import { currentLockState } from '../lib/lock';

function currentDay(plan: Plan): PlanDay | undefined {
  return plan.days[plan.cursor];
}

export function Home() {
  const {
    plans,
    settings,
    activeSession,
    activeSessions,
    createTrainingSession,
    finishTrainingSession,
    discardTrainingSession,
    upsertPlan,
    setCurrentPlan,
    pushToast,
    sessions,
    historyHydrated,
    patchSettings,
    refreshSessions,
    refreshPlans,
  } = useStore();
  // 当前计划持久化在 settings 里（审计 R2-07：导航/刷新后不能回到默认）

  /** 选中的具体计划日（G4）：只存 day.id，不存名字/focus/round，也不落库 */
  const [selectedDayId, setSelectedDayId] = useState<string | null>(null);
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  const [planPickerOpen, setPlanPickerOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<PlanDay | null>(null);
  /** 计划内休息日（第2阶段 G8b）：待确认「记录休息」+ 是否推进循环 */
  const [pendingRest, setPendingRest] = useState<PlanDay | null>(null);
  const [restAdvance, setRestAdvance] = useState(false);
  const [restBusy, setRestBusy] = useState(false);
  /** 已有未结束训练时的冲突引导（任务 F） */
  const [conflict, setConflict] = useState<{ targetDay: PlanDay; existing: Session } | null>(null);
  /** 冲突处理中（避免重复点击）+ 被另一标签页持锁时的明确提示 */
  const [conflictBusy, setConflictBusy] = useState(false);
  const [conflictLockedBy, setConflictLockedBy] = useState<string | null>(null);
  const [backupExporting, setBackupExporting] = useState(false);
  const backupExportingRef = useRef(false);

  const backupNudge = useMemo(
    () => (historyHydrated ? evaluateBackupNudge(sessions, settings) : null),
    [historyHydrated, sessions, settings],
  );

  async function handleQuickBackupExport() {
    if (backupExportingRef.current) return;
    backupExportingRef.current = true;
    setBackupExporting(true);
    try {
      await coordinateBackupExport({
        patchSettings,
        pushToast,
      });
    } catch (err) {
      pushToast(`导出失败：${err instanceof Error ? err.message : '未知原因'}`, 'error');
    } finally {
      backupExportingRef.current = false;
      setBackupExporting(false);
    }
  }

  async function handleSnoozeBackupNudge() {
    try {
      await patchSettings({ lastBackupPromptAt: Date.now() });
    } catch (err) {
      pushToast(err instanceof Error ? `未能保存提醒设置：${err.message}` : '未能保存提醒设置', 'error');
    }
  }

  const plan = useMemo(() => {
    const byId = settings.currentPlanId ? plans.find((p) => p.id === settings.currentPlanId) : undefined;
    return byId ?? plans[0];
  }, [plans, settings.currentPlanId]);
  const today = Date.now();

  /**
   * 每个具体计划日一张贴纸（G4）。
   * 名称 / 数量 / 顺序**直接来自 plan.days**，不按名字 / focus / round 合并，
   * 也不自动补 A/B —— 两天就是两张。
   */
  const stickers = useMemo(() => planDayStickers(plan), [plan]);

  const recentSessions = useMemo(
    () =>
      sessions
        // 最近完成只显示训练（完全休息不混入训练列表）
        .filter((s) => s.status === 'completed' && sessionKindOf(s) !== 'rest')
        .slice(0, 3),
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
   * 选中日解析（G4）：只认 `day.id`，**不按名字 / focus / round 匹配**。
   *
   * · 选中项随计划内容失效（计划被改/被删）时自动回落到循环当前位置，不报错；
   * · 回落只影响「本页显示」，**不写库、不改 cursor**（选择本身永不推进循环）。
   */
  const selectedDay: PlanDay | undefined = resolveSelectedDay(plan, selectedDayId);
  const selectedKey = selectedDay ? dayStickerKey(plan.id, selectedDay.id) : null;
  const cycleKey = cycleDay ? dayStickerKey(plan.id, cycleDay.id) : null;
  /** 选中日的展示区（力量/有氧/休息统一走这一个来源，不再按 focus 过滤） */
  const selectedDays: PlanDay[] = selectedDay ? [selectedDay] : [];

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
      const r = await createTrainingSession(session);
      if (!r.ok) {
        pushToast(r.message, 'error');
        return;
      }
      navigate(`/session/${session.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? `无法开始训练：${err.message}` : '无法开始训练', 'error');
    }
  }

  /**
   * 开始**临时独立有氧**（第2阶段）。
   *
   * · 不借当前力量 dayId（用 adhoc:<sessionId>），因此默认**不推进**循环
   * · 已有未结束训练时先引导处理
   */
  async function startAdhocCardio(preset: 'treadmill-incline' | 'stair-climber') {
    if (!plan) return;
    const existing = activeSessions[0];
    if (existing) {
      pushToast('还有一次训练没有结束，请先结束或放弃它。', 'error');
      return;
    }
    const params = preset === 'treadmill-incline' ? { speedKmh: 4, inclinePct: 4 } : { level: 5 };
    const session = createAdhocCardioSession({ plan, preset, params });
    try {
      const r = await createTrainingSession(session);
      if (!r.ok) {
        pushToast(r.message, 'error');
        return;
      }
      navigate(`/session/${session.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? `无法开始有氧：${err.message}` : '无法开始有氧', 'error');
    }
  }

  /**
   * 记录**完全休息**（第2阶段）。
   *
   * 同日去重/冲突核验/循环推进都在 create-rest 事务内完成；
   * 与 active/实际训练强互斥（不能把真实训练标成没练）。
   */
  async function recordFullRest() {
    if (!plan) return;
    const restDate = localDateKey();
    const existing = activeSessions[0];
    if (existing) {
      pushToast('还有一次训练没有结束，请先结束或放弃它，再记录完全休息。', 'error');
      return;
    }
    const session = createRestSession({ plan, restDate, origin: 'temporary' });
    try {
      const r = await atomicCreateRest({ session, restDate, advanceCycle: false });
      if (!r.ok) {
        pushToast(r.message, 'error');
        return;
      }
      await refreshSessions();
      await refreshPlans();
      pushToast('已记录今天完全休息。');
    } catch (err) {
      pushToast(err instanceof Error ? `记录失败：${err.message}` : '记录失败', 'error');
    }
  }

  /**
   * 记录**计划内休息日**（G8b）。
   *
   * · 走受约束的 create-rest 事务：同日去重、与 active/实际训练互斥、
   *   读最新计划、按明确选择推进一次，全在一个事务内完成。
   * · stay/advance 由用户在确认面板里明确选择（不默认推进）。
   * · 与临时休息不同：origin='plan'，dayId 用计划日自身（不借力量日 ID）。
   */
  async function recordPlanRest(day: PlanDay, advance: boolean) {
    if (!plan) return;
    const restDate = localDateKey();
    const existing = activeSessions[0];
    if (existing) {
      pushToast('还有一次训练没有结束，请先结束或放弃它，再记录休息。', 'error');
      return;
    }
    const session = createRestSession({ plan, restDate, origin: 'plan' });
    // 计划内休息：快照里带上该休息日的名字/说明，历史可读
    session.day = {
      dayId: day.id,
      dayName: day.name,
      partText: day.restNote ?? '休息',
    };
    session.cycleIndexAtStart = plan.cursor;
    setRestBusy(true);
    try {
      const r = await atomicCreateRest({ session, restDate, advanceCycle: advance });
      if (!r.ok) {
        pushToast(r.message, 'error');
        return;
      }
      await refreshSessions();
      if (advance) await refreshPlans();
      setPendingRest(null);
      pushToast(advance ? '已记录休息，循环已前进一位。' : '已记录休息，循环位置保持不变。');
    } catch (err) {
      pushToast(err instanceof Error ? `记录失败：${err.message}` : '记录失败', 'error');
    } finally {
      setRestBusy(false);
    }
  }

  /**
   * 结束已有训练后继续开始新的。
   * V3-01 / D19：不拿首页这份旧快照去覆盖别页刚保存的记录。
   *   · finish/discard 由存储层在**事务内读最新记录**后只应用终态字段；
   *   · 若训练正被另一个标签页持锁编辑，先明确提示、让用户选「继续原训练」或稍后接管，
   *     不静默用旧快照结束（避免把别页刚填的次数回退）。
   */
  async function finishExistingThenStart(endAction: 'complete' | 'discard') {
    const existing = conflict?.existing;
    const target = conflict?.targetDay;
    if (!existing || !target) return;
    setConflictBusy(true);
    try {
      /**
       * V4-02b：**不要在事务外把「读锁」当作授权依据**。
       * 旧实现先 currentLockState 再 optional 结束，两步之间存在竞争窗口：
       * 另一页可以在这两步之间拿到锁，随后我们的 optional 结束照样成功（审查 V4D11）。
       *
       * 现在把「锁空闲 / 已过期 / 属于本人」的核验放进**同一个写事务**
       * （tx.atomicWriteSession 的 optional 分支已经这么做），
       * 这里只负责把事务返回的准确原因展示给用户。
       * 事务外的这次预读仅用于**提前给出友好提示**，不再作为是否继续的依据。
       */
      const r =
        endAction === 'complete'
          ? await finishTrainingSession(existing, { advanceCycle: false, lockPolicy: 'optional' })
          : await discardTrainingSession(existing, { lockPolicy: 'optional' });

      if (!r.ok) {
        if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
          // 事务内发现别人有效持锁：明确只读，不静默结束
          const st = await currentLockState(existing.id).catch(() => null);
          setConflictLockedBy(st && st.kind === 'held' ? st.editorId : 'another-tab');
          setConflictBusy(false);
          return;
        }
        pushToast(r.message, 'error');
        setConflictBusy(false);
        return;
      }

      await refreshSessions();
      setConflict(null);
      setConflictLockedBy(null);
      // 结束旧训练后不推进循环，由新训练结束时决定
      const session = createSession(plan!, target);
      const created = await createTrainingSession(session);
      if (!created.ok) {
        pushToast(created.message, 'error');
        setConflictBusy(false);
        return;
      }
      navigate(`/session/${session.id}`);
    } catch (err) {
      pushToast(err instanceof Error ? `处理失败：${err.message}` : '处理失败', 'error');
    } finally {
      setConflictBusy(false);
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
              {cycleDay?.kind === 'rest'
                ? `${cycleDay.name}日`
                : cycleDay?.kind === 'cardio'
                  ? `下一练 · ${cycleDay.name}（有氧）`
                  : `下一练 · ${cycleDay?.name}`}
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

      {/* ── 本地备份温和提醒条（Wave 2D：零 Schema 改动，取消保存绝不误写 lastExportAt） ── */}
      {backupNudge?.shouldShow ? (
        <section style={{ marginTop: 12 }} data-testid="backup-nudge-banner">
          <div
            className="slip"
            style={{
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
              background: 'var(--paper-2)',
              borderLeft: '3px solid var(--ink-2)',
            }}
          >
            <div style={{ flex: '1 1 200px', fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>
              {backupNudge.reason === 'never-exported'
                ? `本地已有 ${backupNudge.unbackedCount} 次训练尚未导出备份`
                : `距上次备份已超 14 天，新增 ${backupNudge.unbackedCount} 次训练尚未导出备份`}
            </div>
            <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="backup-nudge-export"
                disabled={backupExporting}
                onClick={() => void handleQuickBackupExport()}
              >
                {backupExporting ? '导出中…' : '立即导出'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-testid="backup-nudge-snooze"
                disabled={backupExporting}
                onClick={() => void handleSnoozeBackupNudge()}
              >
                稍后
              </button>
            </div>
          </div>
        </section>
      ) : null}

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

      {/* ── 计划日贴纸（G4：每个 PlanDay 一张）───── */}
      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">今天练什么</h2>
          <span className="mono-label">点贴纸切换</span>
        </div>
        {/* 贴纸数量/名称/顺序 = plan.days 原样（不按 focus 合并、不补 A/B）。
            选中只改本页 state：不写库、不改 cursor（nextSelectedDayId 只回传 day.id）。 */}
        <StickerPicker
          items={stickers}
          value={selectedKey}
          cycleKey={cycleKey}
          onSelect={(item) => setSelectedDayId(nextSelectedDayId(item.dayId))}
        />

        {/* ── 有氧 / 完全休息入口（第2阶段）── */}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void startAdhocCardio('treadmill-incline')}
            disabled={!!activeSessions[0]}
          >
            有氧爬坡
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void startAdhocCardio('stair-climber')}
            disabled={!!activeSessions[0]}
          >
            爬楼机
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => void recordFullRest()}
            disabled={!!activeSessions[0]}
          >
            今天完全休息
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.6, marginTop: 6, marginBottom: 0 }}>
          临时有氧/完全休息默认不改变循环位置；有氧与力量可以保存在同一次训练里。
        </p>
      </section>

      {/* ── 选中的计划日 ─────────────── */}
      <section style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {selectedDays.map((d) => {
            const isCycle = cycleDay?.id === d.id;
            const total = d.exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0);
            return (
              <button
                key={d.id}
                className="slip"
                onClick={() => {
                  if (d.kind === 'rest') {
                    setRestAdvance(false);
                    setPendingRest(d);
                    return;
                  }
                  setPendingStart(d);
                }}
                style={{
                  flex: '1 1 100%',
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
                  <span
                    style={{
                      fontFamily: 'var(--f-serif)',
                      fontSize: 19,
                      fontWeight: 700,
                      whiteSpace: 'normal',
                      overflowWrap: 'anywhere',
                      minWidth: 0,
                    }}
                  >
                    {d.name}
                  </span>
                  <span className="mono-label" style={{ fontSize: 11, flex: 'none' }}>
                    {d.kind === 'rest' ? '休息日' : d.kind === 'cardio' ? '有氧日' : d.round ? `${d.round} 轮` : '力量日'}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 4 }}>
                  {d.kind === 'rest'
                    ? (d.restNote ?? '休息日 · 可记录完全休息')
                    : d.kind === 'cardio'
                      ? `${(d.cardio ?? []).length} 个有氧项目`
                      : `${d.exercises.length} 个动作 · ${total} 组`}
                </div>
                {isCycle ? (
                  <span className="tag tag-brick" style={{ marginTop: 8 }}>
                    循环当前
                  </span>
                ) : null}
                <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 8 }}>
                  {d.kind === 'rest' ? '点按记录休息 ›' : d.kind === 'cardio' ? '点按开始有氧 ›' : '点按开始训练 ›'}
                </div>
              </button>
            );
          })}
          {!selectedDays.length ? (
            <div className="empty" style={{ width: '100%' }}>
              <div className="empty-title" style={{ padding: 20 }}>计划里还没有训练日</div>
            </div>
          ) : null}
        </div>
      </section>

      {/* ── 选中日内容概览 ─────────────── */}
      <section style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">{selectedDay ? `${selectedDay.name} · 内容` : '动作概览'}</h2>
          <button className="btn btn-ghost btn-sm" onClick={() => setDayPickerOpen(true)}>
            全部训练日
          </button>
        </div>
        <div className="slip" style={{ marginTop: 8 }}>
          {selectedDays.map((d) => (
            <div key={d.id} style={{ padding: '12px 14px', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    whiteSpace: 'normal',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                  }}
                >
                  {d.name}
                </span>
                <span className="mono-label" style={{ fontSize: 11, flex: 'none' }}>
                  {d.kind === 'rest'
                    ? '休息'
                    : d.kind === 'cardio'
                      ? `${(d.cardio ?? []).length} 个有氧项目`
                      : `${d.exercises.length} 个动作`}
                </span>
              </div>
              {d.kind === 'rest' ? (
                <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 0', lineHeight: 1.6 }}>
                  {d.restNote ?? '休息日：不生成训练记录，可选记录「完全休息」。'}
                </p>
              ) : d.kind === 'cardio' ? (
                <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
                  {(d.cardio ?? []).length ? (
                    (d.cardio ?? []).map((pc) => (
                      <li
                        key={pc.id}
                        style={{
                          padding: '8px 0',
                          borderBottom: '1px dashed var(--rule)',
                          fontSize: 14,
                          whiteSpace: 'normal',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {pc.name}
                        <span style={{ color: 'var(--ink-4)', marginLeft: 6, fontSize: 12 }}>
                          {pc.preset === 'treadmill-incline'
                            ? `${pc.target.speedKmh ?? '—'} km/h · ${pc.target.inclinePct ?? '—'}%`
                            : `档位 ${pc.target.level ?? '—'}`}
                        </span>
                      </li>
                    ))
                  ) : (
                    <li style={{ fontSize: 13, color: 'var(--ink-3)', padding: '6px 0' }}>
                      这一日还没有有氧项目（可到计划页添加）。
                    </li>
                  )}
                </ul>
              ) : (
                <ul style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
                  {d.exercises.map((ex) => (
                    <ExerciseOverviewRow key={ex.id} ex={ex} />
                  ))}
                </ul>
              )}
              <button
                className="btn btn-primary btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => {
                  if (d.kind === 'rest') {
                    setRestAdvance(false);
                    setPendingRest(d);
                    return;
                  }
                  setPendingStart(d);
                }}
              >
                {d.kind === 'rest' ? `记录休息 · ${d.name}` : d.kind === 'cardio' ? `开始有氧 · ${d.name}` : `开始 ${d.name}`}
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
                      /**
                       * V4-02b：孤儿列表同样是 optional，但 optional 现在**不再无视别人的有效锁**。
                       * 事务内会核验「空闲 / 过期 / 本人」，被占用时返回 lock-lost 并给出原因。
                       */
                      const r = await finishTrainingSession(
                        { ...s, status: 'completed', endedAt: Date.now() },
                        { advanceCycle: false, lockPolicy: 'optional' },
                      );
                      if (!r.ok) {
                        pushToast(
                          r.reason === 'lock-lost'
                            ? '这条训练正在另一个标签页中编辑，本页不会结束它。请回到那个标签页操作。'
                            : r.message,
                          'error',
                        );
                        return;
                      }
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
                      // V4-02b：与结束同规则 —— optional 不等于可以无视别人的有效锁
                      const r = await discardTrainingSession(
                        { ...s, status: 'discarded', endedAt: Date.now() },
                        { lockPolicy: 'optional' },
                      );
                      if (!r.ok) {
                        pushToast(
                          r.reason === 'lock-lost'
                            ? '这条训练正在另一个标签页中编辑，本页不会放弃它。请回到那个标签页操作。'
                            : r.message,
                          'error',
                        );
                        return;
                      }
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
        onClose={() => {
          setConflict(null);
          setConflictLockedBy(null);
        }}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => {
                const id = conflict?.existing.id;
                setConflict(null);
                setConflictLockedBy(null);
                if (id) navigate(`/session/${id}`);
              }}
            >
              继续原训练（{conflict?.existing.day.dayName}）
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              disabled={conflictBusy || conflictLockedBy !== null}
              onClick={() => void finishExistingThenStart('complete')}
            >
              {conflictBusy ? '正在处理…' : `结束原训练，再开始 ${conflict?.targetDay.name}`}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%', color: 'var(--brick)' }}
              disabled={conflictBusy || conflictLockedBy !== null}
              onClick={() => void finishExistingThenStart('discard')}
            >
              {conflictBusy ? '正在处理…' : `放弃原训练，再开始 ${conflict?.targetDay.name}`}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                setConflict(null);
                setConflictLockedBy(null);
              }}
            >
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

        {conflictLockedBy !== null ? (
          <div
            role="alert"
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'var(--paper-3)',
              borderLeft: '3px solid var(--warn)',
              fontSize: 13,
              lineHeight: 1.65,
            }}
          >
            原训练正在<strong>另一个标签页</strong>中编辑，页面上的数据可能不是最新的。
            这里不会用旧快照把它结束掉。请先回到那个标签页停止操作
            （或直接在那里结束/放弃），约 20 秒后本页可以再试。
            <div style={{ marginTop: 8 }}>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  setConflictLockedBy(null);
                  void finishExistingThenStart('complete');
                }}
              >
                重新检查并结束
              </button>
            </div>
          </div>
        ) : null}
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
                  // 计划内休息日：给出明确的「记录休息 + stay/advance」入口（G8b）
                  setRestAdvance(false);
                  setPendingRest(d);
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
                  {d.kind === 'rest'
                    ? (d.restNote ?? '休息日 · 可记录完全休息')
                    : d.kind === 'cardio'
                      ? `${(d.cardio ?? []).length} 个有氧项目`
                      : `${d.exercises.length} 个动作`}
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
        title={pendingStart ? `开始 ${pendingStart.kind === 'cardio' ? '有氧' : '训练'} · ${pendingStart.name}` : ''}
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
              {pendingStart?.kind === 'cardio' ? '开始有氧' : '开始训练'}
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
              {pendingStart.kind === 'cardio' ? (
                /* 有氧日：显示有氧项目与目标参数（非力量不显示动作/组数/轮次，避免“0 动作”误导） */
                <>
                  {(pendingStart.cardio ?? []).length
                    ? (pendingStart.cardio ?? []).map((pc) => (
                        <span key={pc.id}>
                          {pc.name}：
                          {pc.preset === 'treadmill-incline'
                            ? `速度 ${pc.target.speedKmh ?? '—'} km/h · 坡度 ${pc.target.inclinePct ?? '—'}%`
                            : `档位 ${pc.target.level ?? '—'}`}
                          <br />
                        </span>
                      ))
                    : '这一日还没有有氧项目（可到计划页添加）。'}
                </>
              ) : (
                <>
                  动作：{pendingStart.exercises.length} 个 ·{' '}
                  {pendingStart.exercises.reduce((n, ex) => n + targetGroupsOf(ex), 0)} 组
                  <br />
                  热身：{pendingStart.warmups.length} 项（不计入正式组）
                </>
              )}
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

      {/* 计划内休息日确认：记录完全休息 + 明确 stay/advance（G8b）。
          同日去重、与训练互斥、事务内一次推进都由 create-rest 保证。 */}
      <Sheet
        open={!!pendingRest}
        title={pendingRest ? `记录休息 · ${pendingRest.name}` : ''}
        onClose={() => setPendingRest(null)}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              disabled={restBusy}
              onClick={() => {
                const d = pendingRest!;
                void recordPlanRest(d, restAdvance);
              }}
            >
              {restBusy ? '正在记录…' : restAdvance ? '记录休息并推进循环' : '记录休息（保持循环位置）'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              disabled={restBusy}
              onClick={() => setRestAdvance((v) => !v)}
              aria-pressed={restAdvance}
            >
              {restAdvance ? '✓ 结束后推进循环' : '不推进循环（点按切换）'}
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => setPendingRest(null)}>
              取消
            </button>
          </div>
        }
      >
        {pendingRest ? (
          <>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.65 }}>
              {pendingRest.restNote ? `${pendingRest.restNote}` : '休息日'}
              <br />
              今天将记录为「完全休息」。休息不计入训练次数、时长、组数或有氧量。
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
              {cycleDay?.id === pendingRest.id
                ? '这是循环当前位置。记录时可选择推进一次或不推进。'
                : `这不是循环当前位置（当前是「${cycleDay?.name}」）。默认不推进。`}
            </div>
          </>
        ) : null}
      </Sheet>

    </main>
  );
}
