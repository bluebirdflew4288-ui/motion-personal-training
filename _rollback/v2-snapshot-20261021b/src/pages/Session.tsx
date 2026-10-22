/* 训练执行页 —— 本轮最重要的页面。
   优先保证：输入、查看、点击效率。
   · 每个动作显示目标、上次表现、逐组记录、完成/休息操作
   · 支持临时替换/添加/排序/跳过程，全部只影响本次
   · 所有修改立即自动保存；保存失败会明确提示 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { back, navigate } from '../lib/router';
import { fmtDate, fmtDuration, fmtRest, fmtTime, fmtWeight } from '../lib/format';
import { NumberStepper } from '../ui/Stepper';
import { ElapsedClock, RestTimerBar, useRestTimer } from '../ui/RestTimer';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import {
  addLooseExercise,
  addSetTo,
  describeTarget,
  dropRoundComplete,
  dropRoundSets,
  hasAnyData,
  hasReps,
  exerciseCompletion,
  isSetIncomplete,
  isSetLogged,
  moveExercise,
  removeSetFrom,
  removeLastRound,
  lastRoundHasRecords,
  replaceExerciseInSession,
  roundsOf,
  summarizeSession,
  withExercise,
  withSet,
} from '../domain/session';
import type { Session, SessionExercise, SessionSet } from '../domain/types';

/** 递减组阶段的重量提示 */
const DROP_WEIGHT_NOTE = '哑铃 · 按单只记录';
import { pushCycle } from '../domain/cycle';
import { EXERCISE_LIBRARY, searchExercises } from '../domain/presets/library';
import {
  acquireSessionLock,
  listenLockEvents,
  makeEditorId,
  reclaimOwnLock,
  refreshSessionLock,
  releaseSessionLock,
} from '../lib/lock';

function SetRow({
  set,
  showWeight,
  onPatch,
  onRemove,
  canRemove,
  timer,
  restSec,
  label,
  onAutoRest,
  weightUnitNote,
}: {
  set: SessionSet;
  showWeight: boolean;
  onPatch: (patch: Partial<SessionSet>) => void;
  onRemove: () => void;
  canRemove: boolean;
  timer: ReturnType<typeof useRestTimer>;
  restSec: number;
  label: string;
  onAutoRest: () => void;
  weightUnitNote?: string;
}) {
  const done = set.status === 'done';
  const partial = set.status === 'partial';
  // partial = 已做但缺数据（点了完成却没填次数）：显示为「缺次数」，不计入完整组
  const missingReps = partial || (done && !hasReps(set));

  return (
    <div
      style={{
        padding: '10px 8px 12px',
        margin: '0 -8px',
        borderBottom: '1px dashed var(--rule)',
        background: done ? 'var(--brick-soft)' : partial ? 'rgba(138,90,18,.10)' : 'transparent',
      }}
    >
      {/* 组号 + 完成/撤销 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span
          style={{
            fontFamily: 'var(--f-mono)',
            fontSize: 12,
            color: done ? 'var(--brick)' : partial ? 'var(--warn)' : 'var(--ink-4)',
            flex: 'none',
          }}
        >
          {label}
        </span>
        {missingReps ? <span className="tag tag-warn">缺次数 · 不计入</span> : null}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {done || partial ? (
            <button className="btn btn-sm btn-ghost" onClick={() => onPatch({ status: 'blank', reps: null, weightKg: null })}>
              撤销
            </button>
          ) : (
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                onPatch({ status: 'done' });
                onAutoRest();
              }}
              style={{ minWidth: 72 }}
            >
              完成
            </button>
          )}
          {done || partial ? (
            <button className="btn btn-sm btn-ghost" onClick={() => timer.start(restSec)} aria-label="开始组间休息计时">
              计时
            </button>
          ) : null}
          {canRemove ? (
            <button
              className="btn btn-sm btn-ghost"
              onClick={onRemove}
              aria-label={`删除${label}`}
              style={{ color: 'var(--ink-3)', minWidth: 44, padding: 0 }}
            >
              ×
            </button>
          ) : null}
        </span>
      </div>

      {/* 次数（整行宽，保证两位数/小数可见） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, color: 'var(--ink-3)', flex: 'none', width: 30 }}>次数</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <NumberStepper
            value={set.reps}
            onChange={(v) => onPatch({ reps: v })}
            min={0}
            max={999}
            ariaLabel={`${label}次数`}
            unit="次"
            compact
          />
        </div>
      </div>

      {/* 重量（整行宽） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--ink-3)', flex: 'none', width: 30 }}>重量</span>
        {showWeight ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <NumberStepper
              value={set.weightKg}
              onChange={(v) => onPatch({ weightKg: v })}
              step={2.5}
              decimals={2}
              min={0}
              max={999}
              ariaLabel={`${label}重量`}
              unit="kg"
              compact
            />
          </div>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>{weightUnitNote ?? '不记重量'}</span>
        )}
      </div>
    </div>
  );
}

function ExerciseCard({
  ex,
  index,
  expanded,
  onToggle,
  lastPerformance,
  apply,
  latestRef,
  timer,
  onOpenTools,
  onRequestRemoveRound,
  pushToast,
}: {
  ex: SessionExercise;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  lastPerformance: { date: number; summary: string } | null;
  /** 累积式更新：永远基于「最新」session 计算，连续点击不会互相覆盖 */
  apply: (fn: (prev: Session) => Session) => void;
  latestRef: React.RefObject<Session | undefined>;
  timer: ReturnType<typeof useRestTimer>;
  onOpenTools: () => void;
  onRequestRemoveRound: (exId: string) => void;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const isDrop = ex.target.kind === 'dropSet';
  const showWeight = ex.target.kind === 'straight' ? ex.target.weightMode !== 'bodyweight' : true;
  const completion = exerciseCompletion(ex);
  const done = completion === 'done';
  const partial = completion === 'partial';
  const skipped = completion === 'skipped';
  const validSets = ex.sets.filter(isSetLogged).length;
  const incompleteSets = ex.sets.filter(isSetIncomplete).length;

  const patchSet = (setId: string, patch: Partial<SessionSet>) =>
    apply((prev) => withSet(prev, ex.id, setId, patch));

  return (
    <section
      className="slip"
      style={{
        marginTop: 14,
        opacity: skipped ? 0.62 : 1,
        borderColor: done ? 'var(--brick)' : 'var(--rule)',
      }}
    >
      {/* 卡片头：默认折叠，只展开当前动作（审计：8 个动作全展开约 6.7 屏） */}
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span
            style={{
              flex: 'none',
              fontFamily: 'var(--f-mono)',
              fontSize: 12,
              color: 'var(--ink-4)',
              paddingTop: 2,
              width: 18,
            }}
            aria-hidden="true"
          >
            {index + 1}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* 动作名：完整显示，可换行，不被目标挤压 */}
            <h3
              style={{
                margin: 0,
                fontFamily: 'var(--f-sans)',
                fontSize: 17,
                fontWeight: 600,
                lineHeight: 1.35,
                letterSpacing: '0.01em',
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
              }}
            >
              {ex.name}
            </h3>
            {/* 目标：独立一行，短摘要 */}
            <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.5 }}>
              {describeTarget({ id: ex.id, name: ex.name, restSec: ex.restSec, target: ex.target })}
              <span style={{ color: 'var(--ink-4)' }}> · 休息 {fmtRest(ex.restSec)}</span>
            </div>

            {/* 状态与进度摘要（含完成数、缺数据数） */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {done ? <span className="tag tag-ok">已完成</span> : null}
              {partial ? <span className="tag tag-warn">部分完成</span> : null}
              {skipped ? <span className="tag tag-quiet">已跳过</span> : null}
              {ex.added ? <span className="tag tag-quiet">临时添加</span> : null}
              {ex.replacedFrom ? (
                <span className="tag tag-quiet" style={{ whiteSpace: 'normal' }}>
                  替换自 {ex.replacedFrom}
                </span>
              ) : null}
              {validSets > 0 ? (
                <span className="tag tag-quiet">
                  {isDrop ? `${validSets} 阶段已记` : `${validSets} 组已记`}
                </span>
              ) : null}
              {incompleteSets > 0 ? <span className="tag tag-warn">{incompleteSets} 组缺次数</span> : null}
            </div>

            {/* 上次表现：折叠时也显示，方便直接对照 */}
            <div
              style={{
                fontSize: 12.5,
                color: lastPerformance ? 'var(--ink-2)' : 'var(--ink-4)',
                marginTop: 6,
                lineHeight: 1.5,
              }}
            >
              {lastPerformance ? (
                <>
                  <span style={{ color: 'var(--ink-4)' }}>上次 {fmtDate(lastPerformance.date)} · </span>
                  {lastPerformance.summary}
                </>
              ) : (
                '暂无历史记录'
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onToggle}
              aria-expanded={expanded}
              style={{ minWidth: 56, minHeight: 44 }}
            >
              {expanded ? '收起' : '记录'}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onOpenTools}
              aria-label={`${ex.name} 更多操作`}
              style={{ minWidth: 56, minHeight: 44 }}
            >
              工具
            </button>
          </div>
        </div>
      </div>

      {expanded ? (
        <div style={{ padding: '0 14px 12px' }}>
          {isDrop ? (
            <div style={{ marginTop: 10 }}>
              {roundsOf(ex).map((round) => {
                const sets = dropRoundSets(ex, round);
                const complete = dropRoundComplete(ex, round);
                return (
                  <div key={round} style={{ marginTop: round === 1 ? 0 : 10 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        paddingTop: 6,
                        borderTop: '1.5px solid var(--rule-strong)',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--f-serif)', fontSize: 15, fontWeight: 700 }}>
                        第 {round} 轮
                      </span>
                      <span className="mono-label" style={{ fontSize: 11 }}>
                        1 个正式大组
                      </span>
                      {complete ? <span className="tag tag-ok">完整</span> : null}
                    </div>
                    {sets.map((set) => (
                      <SetRow
                        key={set.id}
                        set={set}
                        showWeight
                        label={`阶段 ${set.stageIndex}`}
                        restSec={set.stageIndex === sets.length ? ex.restSec : 20}
                        timer={timer}
                        canRemove={false}
                        onAutoRest={() => {
                          const stageCount = sets.length;
                          const isLast = set.stageIndex === stageCount;
                          timer.start(isLast ? ex.restSec : 20);
                        }}
                        onPatch={(p) => patchSet(set.id, p)}
                        onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                        weightUnitNote={DROP_WEIGHT_NOTE}
                      />
                    ))}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minHeight: 40 }}
                  onClick={() => apply((prev) => addSetTo(prev, ex.id))}
                >
                  + 加一轮
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minHeight: 40 }}
                  onClick={() => {
                    const cur = latestRef.current?.exercises.find((e) => e.id === ex.id);
                    if (!cur) return;
                    if (roundsOf(cur).length <= 1) {
                      pushToast('至少保留一轮。');
                      return;
                    }
                    if (lastRoundHasRecords(cur)) {
                      onRequestRemoveRound(ex.id);
                      return;
                    }
                    apply((prev) => removeLastRound(prev, ex.id));
                  }}
                >
                  − 删一轮
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() =>
                    apply((prev) => {
                      // 基于最新状态找第一个未完成的轮，把该轮所有阶段标记完成
                      const cur = prev.exercises.find((e) => e.id === ex.id);
                      if (!cur) return prev;
                      const targetRound = roundsOf(cur).find((r) => !dropRoundComplete(cur, r));
                      if (targetRound === undefined) return prev;
                      let next = prev;
                      for (const st of dropRoundSets(cur, targetRound)) {
                        // withSet 会把「无次数的 done」归一化为 partial，不会伪造有效记录
                        next = withSet(next, ex.id, st.id, { status: 'done' });
                      }
                      return next;
                    })
                  }
                >
                  本轮全部标记完成
                </button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 8 }}>
              {ex.sets.map((set) => (
                <SetRow
                  key={set.id}
                  set={set}
                  showWeight={showWeight}
                  label={`第 ${set.roundIndex} 组`}
                  restSec={ex.restSec}
                  timer={timer}
                  canRemove={ex.sets.length > 1}
                  onAutoRest={() => timer.start(ex.restSec)}
                  onPatch={(p) => patchSet(set.id, p)}
                  onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                  weightUnitNote={
                    ex.target.kind === 'straight' && ex.target.weightMode === 'bodyweight' ? '自重动作 · 无需重量' : undefined
                  }
                />
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-ghost" onClick={() => apply((prev) => addSetTo(prev, ex.id))}>
                  + 加一组
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    // 用最新状态判断是否有可沿用的值
                    const cur = latestRef.current?.exercises.find((e) => e.id === ex.id);
                    const source = cur ? [...cur.sets].reverse().find((st) => hasReps(st) || st.weightKg !== null) : undefined;
                    if (!source) {
                      pushToast('这一动作还没有填写过数值，无法沿用。');
                      return;
                    }
                    apply((prev) => {
                      const c = prev.exercises.find((e) => e.id === ex.id);
                      if (!c) return prev;
                      let next = prev;
                      for (const st of c.sets) {
                        if (st.status === 'done') continue; // 不覆盖已完成的组
                        next = withSet(next, ex.id, st.id, { reps: source.reps, weightKg: source.weightKg });
                      }
                      return next;
                    });
                  }}
                >
                  未完成的组沿用已填数值
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    // 只标记动作级状态；空白组仍是空白，不会变成有效记录
                    apply((prev) => withExercise(prev, ex.id, { status: 'done' }));
                    pushToast('已标记动作完成。空白组不会被计入完成组。');
                  }}
                >
                  标记动作完成
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => apply((prev) => withExercise(prev, ex.id, { status: 'skipped' }))}
                >
                  跳过
                </button>
              </div>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => setNoteOpen((o) => !o)}>
              {noteOpen ? '收起备注' : ex.note ? '编辑备注' : '加备注'}
            </button>
            {noteOpen || ex.note ? (
              <textarea
                className="input"
                style={{ marginTop: 8, minHeight: 64, fontSize: 15 }}
                value={ex.note ?? ''}
                placeholder="这次的动作感受、器械设置、临时调整…"
                aria-label={`${ex.name} 备注`}
                onChange={(e) => apply((prev) => withExercise(prev, ex.id, { note: e.target.value }))}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const { sessions, plans, activeSession, updateSession, completeSession, upsertPlan, pushToast, refreshSessions } =
    useStore();
  const session = useMemo(
    () => sessions.find((s) => s.id === sessionId) ?? (activeSession?.id === sessionId ? activeSession : undefined),
    [sessions, activeSession, sessionId],
  );
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [toolsFor, setToolsFor] = useState<string | null>(null);
  /** 当前操作的动作：默认只展开一个，减少滚动（审计：训练页密度过高） */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const defaultExpandedApplied = useRef(false);
  const [confirmRemoveRoundOpen, setConfirmRemoveRoundOpen] = useState(false);
  const pendingRemoveRound = useRef<string | null>(null);
  /** 动作选择弹层的明确意图（审计 R2-03：原来进入选择前清空 toolsFor 导致替换变追加） */
  const [picker, setPicker] = useState<
    { mode: 'add' } | { mode: 'replace'; sessionExerciseId: string } | null
  >(null);
  const [addQuery, setAddQuery] = useState('');
  const [lockBlocked, setLockBlocked] = useState(false);
  const [advanceCycleTouched, setAdvanceCycleTouched] = useState(false);
  const [advanceCycle, setAdvanceCycle] = useState(true);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const editorId = useRef(makeEditorId());
  const finishGuard = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRestTimer(120);

  // 单活动训练编辑锁
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 刷新后先认领自己上一次的锁，再尝试抢占
      await reclaimOwnLock(sessionId);
      const r = await acquireSessionLock(sessionId, editorId.current);
      if (!cancelled && !r.ok) setLockBlocked(true);
    })();
    const unlisten = listenLockEvents((e) => {
      if (e.sessionId === sessionId && e.type === 'lock' && e.editorId !== editorId.current) {
        setLockBlocked(true);
      }
    });
    const heartbeat = window.setInterval(() => {
      void refreshSessionLock(sessionId, editorId.current).then((stillMine) => {
        if (!stillMine && !cancelled) setLockBlocked(true);
      });
    }, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      unlisten();
      void releaseSessionLock(sessionId, editorId.current);
    };
  }, [sessionId]);

  /** 始终指向最新 session，供「先判断再修改」的操作读取 */
  const latestRef = useRef<Session | undefined>(session);
  latestRef.current = session;

  const persist = useCallback(
    (next: Session) => {
      // 未持有编辑锁时不允许写入，避免两个标签页静默互相覆盖
      if (lockBlocked) {
        pushToast('这个训练正在另一个标签页中编辑，本页不会写入。请回到那个标签页继续。', 'error');
        return;
      }
      setSaveState('saving');
      saveQueue.current = saveQueue.current
        .then(() => updateSession(next))
        .then(() => setSaveState('idle'))
        .catch((err: unknown) => {
          setSaveState('error');
          pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存：本地写入失败', 'error');
        });
    },
    [updateSession, pushToast, lockBlocked],
  );

  /** 累积式修改：fn 接收「最新」session，避免连续点击互相覆盖 */
  const applyChange = useCallback(
    (fn: (prev: Session) => Session) => {
      const prev = latestRef.current;
      if (!prev) return;
      const next = fn(prev);
      if (next === prev) return;
      latestRef.current = next;
      persist(next);
    },
    [persist],
  );

  const lastByExercise = useMemo(() => {
    const map = new Map<string, { date: number; summary: string }>();
    if (!session) return map;
    const finished = sessions
      .filter((s) => s.status === 'completed' && s.id !== session.id && s.endedAt)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const s of finished) {
      for (const ex of s.exercises) {
        // 用动作身份（exerciseId）而不是计划条目 ID：胸 A / 胸 B 能互相对照
        const key = ex.exerciseId ?? ex.name;
        if (map.has(key)) continue;
        const doneSets = ex.sets.filter((st) => st.status === 'done' && hasReps(st));
        if (!doneSets.length) continue;
        const reps = doneSets.map((st) => st.reps).join('/');
        const weights = [...new Set(doneSets.map((st) => st.weightKg).filter((w): w is number => w !== null))];
        const weightText = weights.length ? `${weights.map((w) => `${fmtWeight(w)}kg`).join('/')} · ` : '';
        map.set(key, {
          date: s.endedAt ?? s.startedAt,
          summary: `${weightText}${doneSets.length} 组 · ${reps} 次`,
        });
      }
    }
    return map;
  }, [sessions, session]);

  // ⚠ 所有 hook 必须在任何 early return 之前，否则 session 状态变化会导致
  // hook 数量不一致（React #300）。这个 effect 原来是放在 return 之后的，已上移。
  // 首次进入时展开第一个「还没完成」的动作；用户之后的手动切换不被覆盖
  useEffect(() => {
    if (!session || defaultExpandedApplied.current) return;
    if (!session.exercises.length) return;
    const first = session.exercises.find((e) => e.status !== 'skipped' && exerciseCompletion(e) !== 'done');
    setExpandedId((first ?? session.exercises[0]).id);
    defaultExpandedApplied.current = true;
  }, [session]);

  if (!session) {
    return (
      <main className="page page-top">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">?</div>
          <h2 className="empty-title">找不到这次训练</h2>
          <p className="empty-body">可能已经被结束或删除。回到首页看看当前状态。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('/')}>
            回首页
          </button>
        </div>
      </main>
    );
  }

  if (session.status !== 'active') {
    return (
      <main className="page page-top page-bottom-space">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-mark">END</div>
          <h2 className="empty-title">这次训练已结束</h2>
          <p className="empty-body">可以去历史里查看或纠正数据。</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => navigate(`/history/${session.id}`)}>
            查看详情
          </button>
        </div>
      </main>
    );
  }

  // 默认值：练的是「当前循环日」→ 默认推进；临时练其他日 → 默认不推进（任务 G）
  const planForCycle = plans.find((p) => p.id === session?.planId);
  const isCurrentCycleDay =
    !!planForCycle && !!session && planForCycle.days[planForCycle.cursor]?.id === session.day.dayId;
  const effectiveAdvance = advanceCycleTouched ? advanceCycle : isCurrentCycleDay;

  const summary = summarizeSession(session);
  const toolsEx = session.exercises.find((e) => e.id === toolsFor);
  const libraryResults = addQuery.trim() ? searchExercises(addQuery) : EXERCISE_LIBRARY.slice(0, 12);

  async function finish() {
    if (!session) return;
    // 防重复：已结束的训练不再走结束流程
    if (session.status !== 'active') return;
    if (finishGuard.current) return;
    finishGuard.current = true;
    if (saveState === 'saving') {
      pushToast('正在保存，请稍候再结束。');
      return;
    }
    const ended: Session = {
      ...session,
      status: 'completed',
      endedAt: Date.now(),
      advancedCycle: advanceCycle,
    };
    try {
      // 先决定循环落点，再一次性写入终态：避免「结束→再写回」把记录塞回 active
      const plan = plans.find((p) => p.id === ended.planId);
      if (effectiveAdvance && plan && !session.advancedCycle) {
        const moved = pushCycle(plan);
        await upsertPlan(moved);
        ended.cycleIndexAfter = moved.cursor;
      } else {
        ended.cycleIndexAfter = session.cycleIndexAtStart;
      }
      await completeSession(ended);
      await refreshSessions();
      setSummaryOpen(false);
      navigate(`/history/${ended.id}`, true);
    } catch (err) {
      finishGuard.current = false;
      pushToast(err instanceof Error ? `结束失败：${err.message}` : '结束失败：记录未保存', 'error');
    }
  }

  async function discard() {
    if (!session) return;
    const ended: Session = { ...session, status: 'discarded', endedAt: Date.now() };
    try {
      await completeSession(ended);
      await refreshSessions();
      setDiscardOpen(false);
      navigate('/', true);
    } catch (err) {
      pushToast(err instanceof Error ? `放弃失败：${err.message}` : '放弃失败', 'error');
    }
  }

  return (
    <main
      className="page page-top"
      style={{ paddingBottom: 'calc(32px + var(--safe-bottom) + var(--kb-inset, 0px))' }}
    >
      <RestTimerBar timer={timer} />

      {/* 顶部条 */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => back('/')} aria-label="返回">
          ‹ 返回
        </button>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--f-serif)', fontSize: 17, fontWeight: 700 }}>{session.day.dayName}</div>
          <div className="mono-label" style={{ fontSize: 11 }}>
            {fmtTime(session.startedAt)} 开始 ·{' '}
            <ElapsedClock
              startedAt={session.startedAt}
              pausedMs={session.pausedMs}
              pausedAt={session.pausedAt}
              endedAt={session.endedAt}
            />
          </div>
        </div>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setSummaryOpen(true)}
          disabled={lockBlocked}
          title={lockBlocked ? '正在另一个标签页中编辑' : undefined}
        >
          结束
        </button>
      </header>

      {saveState === 'error' ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: '#2a1109',
            color: '#ffe9e2',
            fontSize: 14,
            borderLeft: '3px solid #d8452a',
          }}
        >
          本地保存失败，最近的修改可能没有写入。请检查浏览器存储空间，或先导出备份再重试。
        </div>
      ) : null}

      {lockBlocked ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--warn)',
          }}
        >
          这个训练正在另一个标签页中编辑。为避免互相覆盖，本页暂不写入。请回到那个标签页，或关闭其它 MOTION 标签页后刷新。
        </div>
      ) : null}

      {/* 进度摘要 */}
      <div
        style={{
          marginTop: 12,
          padding: '10px 12px',
          background: 'var(--paper-3)',
          display: 'flex',
          gap: 16,
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
          {summary.completedSets}
          <span style={{ fontSize: 13, fontFamily: 'var(--f-sans)', color: 'var(--ink-3)', marginLeft: 3 }}>
            / {summary.targetSets} 组
          </span>
        </span>
        {summary.partialGroups > 0 ? (
          <span className="tag tag-warn">{summary.partialGroups} 个部分大组</span>
        ) : null}
        {summary.incompleteSets > 0 ? (
          <span className="tag tag-warn">{summary.incompleteSets} 组缺次数</span>
        ) : null}
        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          {summary.exercisesDone} 完成 · {summary.exercisesPartial} 部分 · {summary.exercisesSkipped} 跳过 ·{' '}
          {summary.exercisesPending} 未记录
        </span>
      </div>

      {/* 热身 */}
      {session.warmups.length ? (
        <section style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section">热身</h2>
            <span className="mono-label">不计入正式组</span>
          </div>
          <div className="slip" style={{ marginTop: 8, padding: '4px 14px' }}>
            {session.warmups.map((w) => (
              <label
                key={w.id}
                className="row"
                style={{ borderBottom: '1px dashed var(--rule)', minHeight: 48, cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={w.done}
                  onChange={(e) =>
                    applyChange((prev) => ({
                      ...prev,
                      warmups: prev.warmups.map((x) => (x.id === w.id ? { ...x, done: e.target.checked } : x)),
                    }))
                  }
                  style={{ width: 22, height: 22, accentColor: 'var(--brick)', flex: 'none' }}
                />
                <span className="row-main">
                  <span className="row-title" style={{ fontWeight: 500 }}>
                    {w.name}
                  </span>
                  <span className="row-sub">{w.targetText}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {/* 动作 */}
      <div style={{ marginTop: 6 }}>
        {session.exercises.map((ex, i) => (
          <div key={ex.id}>
            <ExerciseCard
              ex={ex}
              index={i}
              expanded={expandedId === ex.id}
              onToggle={() => setExpandedId((cur) => (cur === ex.id ? null : ex.id))}
              lastPerformance={lastByExercise.get(ex.exerciseId) ?? null}
              apply={applyChange}
              latestRef={latestRef}
              timer={timer}
              onOpenTools={() => setToolsFor(ex.id)}
              onRequestRemoveRound={(id) => {
                pendingRemoveRound.current = id;
                setConfirmRemoveRoundOpen(true);
              }}
              pushToast={pushToast}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => {
            setPicker({ mode: 'add' });
            setAddQuery('');
          }}
        >
          + 临时加动作
        </button>
        <button className="btn btn-ghost" style={{ flex: 1, color: 'var(--brick)' }} onClick={() => setDiscardOpen(true)}>
          放弃训练
        </button>
      </div>

      {/* 底部主操作：跟随文档流（sticky 在视口底部但不覆盖输入），彻底避免点击穿透 */}
      <div style={{ marginTop: 18 }}>
        <button
          className="btn btn-primary btn-lg"
          onClick={() => setSummaryOpen(true)}
          disabled={lockBlocked}
        >
          {lockBlocked ? '本页只读 · 请在原标签页继续' : `结束训练 · ${summary.completedSets} 组`}
        </button>
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: 'var(--ink-4)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          每次修改都会立即保存到本机。未填写的组不会计入完成组。
        </p>
      </div>

      {/* 动作工具面板 */}
      <Sheet open={!!toolsEx} title={toolsEx ? toolsEx.name : ''} onClose={() => setToolsFor(null)}>
        {toolsEx ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                disabled={session.exercises.findIndex((e) => e.id === toolsEx.id) === 0}
                onClick={() => applyChange((prev) => moveExercise(prev, toolsEx.id, -1))}
              >
                ↑ 上移
              </button>
              <button
                className="btn btn-ghost"
                style={{ flex: 1 }}
                disabled={session.exercises.findIndex((e) => e.id === toolsEx.id) === session.exercises.length - 1}
                onClick={() => applyChange((prev) => moveExercise(prev, toolsEx.id, 1))}
              >
                ↓ 下移
              </button>
            </div>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                // 关键：把「要替换谁」明确带进选择状态，而不是清空后当成新增
                setPicker({ mode: 'replace', sessionExerciseId: toolsEx.id });
                setAddQuery('');
                setToolsFor(null);
              }}
            >
              用另一个动作替换
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                applyChange((prev) => {
                  const cur = prev.exercises.find((e) => e.id === toolsEx.id);
                  return withExercise(prev, toolsEx.id, { status: cur?.status === 'skipped' ? 'pending' : 'skipped' });
                });
                setToolsFor(null);
              }}
            >
              {toolsEx.status === 'skipped' ? '取消跳过' : '跳过这个动作'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              onClick={() => {
                applyChange((prev) => withExercise(prev, toolsEx.id, { status: 'pending' }));
                setToolsFor(null);
              }}
            >
              重置为未完成
            </button>
            {toolsEx.replacedFrom ? (
              <button
                className="btn btn-ghost"
                style={{ width: '100%' }}
                onClick={() => {
                  applyChange((prev) => replaceExerciseInSession(prev, toolsEx.id, toolsEx.replacedFrom!));
                  setToolsFor(null);
                }}
              >
                恢复原动作「{toolsEx.replacedFrom}」
              </button>
            ) : null}
            <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '4px 0 0' }}>
              这里的改动只影响本次训练，不会改计划。需要长期修改请到「计划」页。
            </p>
          </div>
        ) : null}
      </Sheet>

      {/* 动作选择弹层：add / replace 意图明确，取消不改变训练 */}
      <Sheet
        open={picker !== null}
        title={picker?.mode === 'replace' ? '替换为' : '添加动作'}
        onClose={() => {
          setPicker(null);
          setAddQuery('');
        }}
        autoFocusPanel={false}
      >
        <input
          className="input"
          placeholder="搜索或输入新动作名"
          value={addQuery}
          onChange={(e) => setAddQuery(e.target.value)}
          aria-label="搜索动作"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {picker?.mode === 'replace' ? (
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: '8px 0 0' }}>
            将替换「{session.exercises.find((e) => e.id === picker.sessionExerciseId)?.name ?? ''}」，动作位置不变。
            若该动作已有实际记录，原记录会保留，只替换剩余未完成部分。
          </p>
        ) : null}
        <div style={{ maxHeight: '46dvh', overflow: 'auto', marginTop: 10 }}>
          {libraryResults.map((lib) => (
            <button
              key={lib.name}
              className="row"
              style={{ borderBottom: '1px dashed var(--rule)', alignItems: 'flex-start', minHeight: 52 }}
              onClick={() => {
                const intent = picker;
                if (!intent) return;
                if (intent.mode === 'replace') {
                  applyChange((prev) => replaceExerciseInSession(prev, intent.sessionExerciseId, lib.name));
                  pushToast(`已替换为「${lib.name}」`);
                } else {
                  applyChange((prev) => addLooseExercise(prev, lib.name));
                  pushToast(`已添加「${lib.name}」`);
                }
                setPicker(null);
                setAddQuery('');
              }}
            >
              <span className="row-main" style={{ minWidth: 0 }}>
                <span className="row-title" style={{ display: 'block', whiteSpace: 'normal' }}>
                  {lib.name}
                </span>
                <span className="row-sub" style={{ display: 'block', marginTop: 3 }}>
                  {lib.group}
                </span>
              </span>
            </button>
          ))}
        </div>
        {addQuery.trim() && !libraryResults.some((x) => x.name === addQuery.trim()) ? (
          <button
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 10 }}
            onClick={() => {
              const name = addQuery.trim();
              const intent = picker;
              if (!intent) return;
              if (intent.mode === 'replace') {
                applyChange((prev) => replaceExerciseInSession(prev, intent.sessionExerciseId, name));
                pushToast(`已替换为「${name}」`);
              } else {
                applyChange((prev) => addLooseExercise(prev, name));
                pushToast(`已添加「${name}」`);
              }
              setPicker(null);
              setAddQuery('');
            }}
          >
            使用「{addQuery.trim()}」
          </button>
        ) : null}
      </Sheet>

      {/* 结束摘要 */}
      <Sheet
        open={summaryOpen}
        title="结束训练"
        onClose={() => setSummaryOpen(false)}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                background: 'var(--paper-3)',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                checked={effectiveAdvance}
                onChange={(e) => {
                  setAdvanceCycleTouched(true);
                  setAdvanceCycle(e.target.checked);
                }}
                style={{ width: 20, height: 20, accentColor: 'var(--brick)', flex: 'none' }}
              />
              <span style={{ lineHeight: 1.5 }}>
                结束后推进一个循环位置
                <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                  {isCurrentCycleDay
                    ? `本次训练的就是循环当前日（${session?.day.dayName}），默认推进`
                    : `本次是临时训练「${session?.day.dayName}」，不在循环当前位置，默认不推进`}
                </span>
              </span>
            </label>
            <button className="btn btn-primary btn-lg" onClick={() => void finish()}>
              确认结束并保存
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} onClick={() => setSummaryOpen(false)}>
              继续训练
            </button>
          </div>
        }
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--ink-3)' }}>时长</span>
            <strong style={{ fontFamily: 'var(--f-num)' }}>{fmtDuration(summary.durationMs)}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--ink-3)' }}>实际完成组</span>
            <strong>
              {summary.completedSets}
              <span style={{ fontSize: 13, color: 'var(--ink-3)' }}> （计划 {summary.targetSets}）</span>
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--ink-3)' }}>本次安排组数</span>
            <strong>{summary.plannedSets}</strong>
          </div>
          {summary.incompleteSets || summary.partialGroups ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
              <span style={{ color: 'var(--ink-3)' }}>缺数据 / 部分</span>
              <strong>
                {summary.incompleteSets} 组缺次数
                {summary.partialGroups ? ` · ${summary.partialGroups} 个部分大组` : ''}
              </strong>
            </div>
          ) : null}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--ink-3)' }}>动作</span>
            <strong>
              完成 {summary.exercisesDone} · 部分 {summary.exercisesPartial} · 跳过 {summary.exercisesSkipped} · 未记录{' '}
              {summary.exercisesPending}
            </strong>
          </div>
          <div>
            <div className="mono-label" style={{ marginBottom: 4 }}>
              未完成 / 跳过
            </div>
            <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>
              {session.exercises
                .filter((ex) => ex.status !== 'done')
                .map((ex) => `${ex.name}${ex.status === 'skipped' ? '（跳过）' : ''}`)
                .join('、') || '无'}
            </div>
          </div>
          <div className="field">
            <label htmlFor="sess-note">训练备注</label>
            <textarea
              id="sess-note"
              className="input"
              value={session.note}
              placeholder="整体感受、状态、器械情况…"
              onChange={(e) => applyChange((prev) => ({ ...prev, note: e.target.value }))}
            />
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0, lineHeight: 1.6 }}>
            未填写的组不会被当成已完成；部分完成会保留并标注。结束后可在历史里纠正。
          </p>
        </div>
      </Sheet>

      <Confirm
        open={confirmRemoveRoundOpen}
        title="删除这一轮？"
        body="这一轮已经记录了数据。删除后该轮的重量与次数会一并移除，且不会计入统计。"
        confirmText="删除这一轮"
        danger
        onCancel={() => {
          setConfirmRemoveRoundOpen(false);
          pendingRemoveRound.current = null;
        }}
        onConfirm={() => {
          const id = pendingRemoveRound.current;
          if (id) applyChange((prev) => removeLastRound(prev, id));
          setConfirmRemoveRoundOpen(false);
          pendingRemoveRound.current = null;
        }}
      />

      <Confirm
        open={discardOpen}
        title="放弃这次训练？"
        body={
          hasAnyData(session)
            ? '已记录的内容会被丢弃，且不会出现在历史里。这个操作不能撤销。'
            : '这次训练还没有记录任何内容，放弃不会影响历史。'
        }
        confirmText="放弃训练"
        danger
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => void discard()}
      />
    </main>
  );
}
