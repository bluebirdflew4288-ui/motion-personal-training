/* 历史：按日期浏览 → 详情 → 纠正误录 / 删除。
   示例数据不会混进真实记录：这里只读 IndexedDB 里 status='completed' 的记录。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import {
  back,
  navigate,
  registerLeaveGuard,
  type BlockedNavigation,
} from '../lib/router';
import { handleBackIntent, registerPageLeaveGuard } from '../lib/nativeBack';
import { Sheet } from '../ui/Sheet';
import { fmtDateWithWeek, fmtDuration, fmtTime, fmtWeight } from '../lib/format';
import type { CardioEntry, Session, SessionSet } from '../domain/types';
import {
  MAX_INCLINE_PCT,
  MAX_SPEED_KMH,
  MAX_STAIR_LEVEL,
  MAX_TEXT,
  MIN_INCLINE_PCT,
  MIN_SPEED_KMH,
  MIN_STAIR_LEVEL,
} from '../domain/limits';
import { isSetLogged, summarizeSession, withSet } from '../domain/session';
import { sessionKindOf } from '../domain/sessionKind';
import { describeCardioParams, liveElapsedMs, validateCardioList } from '../domain/cardio';
import {
  appendBlankGroupToHistoryExercise,
  canRemoveBlankGroupFromHistoryExercise,
  correctHistoryCardioEntry,
  historyAppendGroupBlocker,
  removeBlankGroupFromHistoryExercise,
  updateHistoryExerciseNote,
  updateHistorySessionNote,
} from '../domain/historyEdit';
import { detectSessionPRs } from '../domain/prDetector';
import { Confirm } from '../ui/Confirm';
import { DraftCell } from '../ui/DraftCell';
import { HistoryCalendar } from '../ui/HistoryCalendar';
import { consumePendingFinishReceipt, ReceiptSlipSheet } from '../ui/ReceiptSlipSheet';
import { deleteSession } from '../db/repo';
import { atomicDeleteRest, revisionOf } from '../db/tx';

export const HISTORY_BATCH_SIZE = 30;

export function HistoryPage() {
  const { sessions, historyHydrated, ensureFullHistory } = useStore();
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const [visibleCount, setVisibleCount] = useState<number>(HISTORY_BATCH_SIZE);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!historyHydrated) {
      void ensureFullHistory();
    }
  }, [historyHydrated, ensureFullHistory]);

  useEffect(() => {
    setVisibleCount(HISTORY_BATCH_SIZE);
  }, [month, query]);

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
  }, [completedAll]);

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

  /** 日级训练次数基于完整筛选集计算，避免分页边界把同一天的 2 次训练暂时拆成“1 次” */
  const dayTrainCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of filtered) {
      const key = fmtDateWithWeek(s.startedAt);
      const prev = counts.get(key) ?? 0;
      counts.set(key, sessionKindOf(s) !== 'rest' ? prev + 1 : prev);
    }
    return counts;
  }, [filtered]);

  const visibleItems = useMemo(
    () => filtered.slice(0, visibleCount),
    [filtered, visibleCount],
  );
  const remainingCount = Math.max(0, filtered.length - visibleItems.length);

  useEffect(() => {
    if (remainingCount <= 0) return undefined;
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((cur) => Math.min(filtered.length, cur + HISTORY_BATCH_SIZE));
        }
      },
      { rootMargin: '240px 0px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [remainingCount, filtered.length]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof visibleItems>();
    for (const s of visibleItems) {
      const key = fmtDateWithWeek(s.startedAt);
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [visibleItems]);

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          训练历史
        </h1>
        <span className="mono-label">
          {!historyHydrated ? '正在读取…' : `${completed.length} 次完成`}
        </span>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: '1 1 160px', minHeight: 42, fontSize: 15 }}
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
        <div className="segmented" role="group" aria-label="历史浏览视图" style={{ flex: '0 0 auto' }}>
          <button
            type="button"
            data-testid="history-view-list"
            aria-pressed={viewMode === 'list'}
            onClick={() => setViewMode('list')}
            style={{ fontSize: 13, padding: '0 12px', minHeight: 38 }}
          >
            列表
          </button>
          <button
            type="button"
            data-testid="history-view-calendar"
            aria-pressed={viewMode === 'calendar'}
            onClick={() => setViewMode('calendar')}
            style={{ fontSize: 13, padding: '0 12px', minHeight: 38 }}
          >
            月历
          </button>
        </div>
      </div>

      {/* G2：只有休息记录时也不能显示 EMPTY —— 休息是可见记录，可查看/撤销。
          空态以"可展示记录"为准；上方的训练次数仍排除休息。 */}
      {!completedAll.length && !historyHydrated ? (
        <div className="empty" style={{ marginTop: 24 }} role="status">
          <div className="empty-title">正在读取训练历史…</div>
        </div>
      ) : !completedAll.length ? (
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
      ) : viewMode === 'calendar' ? (
        <HistoryCalendar
          sessions={query.trim() ? filtered : completedAll}
          initialMonthKey={month !== 'all' ? month : undefined}
        />
      ) : !filtered.length ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <div className="empty-title">没有符合条件的记录</div>
          <p className="empty-body">换个关键词或清空筛选看看。</p>
        </div>
      ) : (
        <>
          {grouped.map(([day, list]) => (
            <section key={day} style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <h2 className="h-section" style={{ fontSize: 15 }}>
                  {day}
                </h2>
                {/* 日级"次数"同样排除休息，避免把休息显示成"1 次"训练 */}
                <span className="mono-label">
                  {dayTrainCounts.get(day) ?? list.filter((x) => sessionKindOf(x) !== 'rest').length} 次
                </span>
              </div>
              <div className="rows" style={{ marginTop: 2 }}>
                {list.map((s) => {
                  const sum = summarizeSession(s, s.endedAt ?? Date.now());
                  const kind = sessionKindOf(s);
                  return (
                    <button
                      key={s.id}
                      className="row"
                      data-testid="history-session-row"
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
          ))}
          {remainingCount > 0 ? (
            <div ref={loadMoreRef} style={{ marginTop: 18, textAlign: 'center' }}>
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="history-load-more"
                style={{ width: '100%' }}
                onClick={() =>
                  setVisibleCount((cur) => Math.min(filtered.length, cur + HISTORY_BATCH_SIZE))
                }
              >
                加载更多（剩余 {remainingCount} 条）
              </button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

export function HistoryDetailPage({ id }: { id: string }) {
  const { sessions, historyHydrated, ensureFullHistory, refreshSessions, pushToast, saveHistorySession } =
    useStore();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const deletingRef = useRef(false);
  const session = sessions.find((s) => s.id === id);

  useEffect(() => {
    if (!session && !historyHydrated) {
      void ensureFullHistory();
    }
  }, [session, historyHydrated, ensureFullHistory]);

  useEffect(() => {
    if (session && sessionKindOf(session) !== 'rest' && consumePendingFinishReceipt(id)) {
      setReceiptOpen(true);
    }
  }, [id, session]);

  /** 编辑草稿：编辑期间不动正式历史，保存才写库（审计任务 H） */
  const [draft, setDraft] = useState<Session | null>(null);
  const [openExNotes, setOpenExNotes] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  /** 离页守卫弹层：**本次**被拦下的导航意图（保存 / 放弃 / 留下 三选一） */
  const [leavePrompt, setLeavePrompt] = useState<BlockedNavigation | null>(null);
  /** 保存并离开进行中：避免重复点击/重复导航 */
  const [leaveBusy, setLeaveBusy] = useState(false);
  /** 进入纠错时的原始字节快照：用于判断草稿是否 dirty（dirty 时不许静默离页） */
  const baselineRef = useRef<string>('');
  /**
   * 草稿的**同步镜像**：guard 与保存读取它，而不是可能滞后一拍的 React state。
   * 这正是「合法 raw 的 blur 提交 与 dirty effect 竞态」导致离页丢 25 的修复点。
   */
  const draftRef = useRef<Session | null>(null);
  /** 保存中的同步镜像（不要用渲染期 state 覆盖它，否则会重现竞态） */
  const savingRef = useRef(false);
  /** 进入纠错时的记录版本：保存必须带它，冲突时不覆盖别人（V3-01） */
  const [draftRevision, setDraftRevision] = useState<number>(0);
  /**
   * 单元格级校验状态：任一非法则禁止保存（R01）。
   * V3-04：这套状态必须跟草稿同生命周期 —— 取消/重新进入纠错时要清空。
   */
  const [cellErrors, setCellErrors] = useState<Record<string, boolean>>({});
  /** 已提交字段的非法错误（同步镜像，guard 读取） */
  const cellErrorsRef = useRef<Record<string, boolean>>({});
  /**
   * 每个数值单元的 raw 状态（同步镜像）：
   *   dirty = 文本与最近提交值不同（合法未提交 / 非法 / 空 / 未完）；
   *   valid = 当前文本可解析为合法值。
   * 让「还没 blur 提交」的 raw 也能被离页守卫看到，避免被静默丢弃。
   */
  const rawStateRef = useRef<Map<string, { dirty: boolean; valid: boolean }>>(new Map());

  /**
   * 重置草稿与离页相关的所有页面级状态（同步 ref + React state）。
   * 成功保存、丢弃草稿、取消编辑、以及数据库删除确认成功后统一复用，避免状态漏清。
   */
  const resetDraftState = () => {
    cellErrorsRef.current = {};
    rawStateRef.current.clear();
    draftRef.current = null;
    baselineRef.current = '';
    setDraft(null);
    setOpenExNotes({});
    setCellErrors({});
    setLeavePrompt(null);
    setLeaveBusy(false);
  };

  const setCellValid = (key: string, ok: boolean) => {
    const prev = cellErrorsRef.current;
    if (ok) {
      if (!(key in prev)) return;
      const next = { ...prev };
      delete next[key];
      cellErrorsRef.current = next;
      setCellErrors(next);
    } else {
      if (prev[key]) return;
      const next = { ...prev, [key]: true };
      cellErrorsRef.current = next;
      setCellErrors(next);
    }
  };
  const setCellRaw = (key: string, dirty: boolean, valid: boolean) => {
    const prev = rawStateRef.current.get(key);
    if (prev && prev.dirty === dirty && prev.valid === valid) return;
    rawStateRef.current.set(key, { dirty, valid });
  };
  const hasCellErrors = Object.keys(cellErrors).length > 0;
  const editing = draft !== null;
  const view = draft ?? session;
  const prReport = useMemo(
    () => (view && sessionKindOf(view) !== 'rest' ? detectSessionPRs(sessions, view) : null),
    [sessions, view],
  );

  const clearCellKeysWithPrefix = (prefix: string) => {
    const prevErr = cellErrorsRef.current;
    let errChanged = false;
    const nextErr = { ...prevErr };
    for (const k of Object.keys(nextErr)) {
      if (k.startsWith(prefix)) {
        delete nextErr[k];
        errChanged = true;
      }
    }
    if (errChanged) {
      cellErrorsRef.current = nextErr;
      setCellErrors(nextErr);
    }
    for (const k of Array.from(rawStateRef.current.keys())) {
      if (k.startsWith(prefix)) {
        rawStateRef.current.delete(k);
      }
    }
  };

  /**
   * **同步**判断当前是否不可安全离页（全部读 ref，不看可能滞后的 React state）：
   *   · 记录不存在（已删除或初始不存在）：绝不挂不可见守卫，允许直接退出；
   *   · 保存中；
   *   · 草稿已提交内容与进入纠错时不同（dirty）；
   *   · 任一数值单元已提交但非法；
   *   · 任一数值单元有未提交 raw（合法或非法）。
   * 未改或改回原值时全部为假 → 允许干净离页。
   */
  const isUnsafeNow = (): boolean => {
    if (!session) return false;
    if (savingRef.current) return true;
    const d = draftRef.current;
    if (!d) return false;
    if (JSON.stringify(d) !== baselineRef.current) return true;
    if (Object.keys(cellErrorsRef.current).length > 0) return true;
    for (const s of rawStateRef.current.values()) if (s.dirty || !s.valid) return true;
    return false;
  };

  /** 当前是否有非法 raw（「保存并离开」必须拒绝：不能把非法输入当已保存） */
  const hasInvalidRawNow = (): boolean => {
    if (Object.keys(cellErrorsRef.current).length > 0) return true;
    for (const s of rawStateRef.current.values()) if (!s.valid) return true;
    return false;
  };

  /** 若记录已从外部或前置事务中删除，及时重置残留草稿，不挂不可见守卫、不保存孤儿草稿 */
  useEffect(() => {
    if (!session && draftRef.current !== null) {
      resetDraftState();
    }
  }, [session]);

  /**
   * 路由离页门禁（复用 router.registerLeaveGuard）：覆盖底部 Tab、页内返回、
   * 统计跳转、浏览器 Back/Forward。守卫从参数拿到**本次**导航意图并存入本页弹层，
   * 取消/失败只清本页弹层，不会污染下一次。
   */
  useEffect(() => {
    return registerLeaveGuard((intent) => {
      if (!isUnsafeNow()) return true;
      setLeavePrompt(intent ?? { kind: 'back' });
      return false;
    });
    // isUnsafeNow 只读稳定 ref，无需依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 原生返回门禁（复用 nativeBack.registerPageLeaveGuard）：语义与路由门禁一致。
   */
  useEffect(() => {
    registerPageLeaveGuard(() => {
      if (!isUnsafeNow()) return true;
      setLeavePrompt({ kind: 'native-back' });
      return false;
    });
    return () => registerPageLeaveGuard(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!session) {
    if (!historyHydrated) {
      return (
        <main className="page page-top page-bottom-space">
          <div className="empty" style={{ marginTop: 32 }} role="status">
            <div className="empty-title">正在读取记录…</div>
          </div>
        </main>
      );
    }
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

  /** 更新草稿里的某个组（不写库）。同步更新 draftRef，保证 blur→click 的守卫读到本次修改。 */
  const updateDraftSet = (exId: string, setId: string, patch: Partial<SessionSet>) => {
    const d = draftRef.current;
    if (!d) return;
    const next = withSet(d, exId, setId, patch);
    draftRef.current = next;
    setDraft(next);
  };

  /** Wave 3B：更新单动作备注 */
  const updateDraftExerciseNote = (exId: string, note: string) => {
    const d = draftRef.current;
    if (!d) return;
    const res = updateHistoryExerciseNote(d, exId, note);
    if (!res.ok) {
      pushToast(res.message, 'error');
      return;
    }
    draftRef.current = res.session;
    setDraft(res.session);
  };

  /** Wave 3B：在历史动作末尾补录一组 / 一轮 */
  const handleAppendBlankGroup = (exId: string) => {
    const d = draftRef.current;
    if (!d) return;
    const res = appendBlankGroupToHistoryExercise(d, exId);
    if (!res.ok) {
      pushToast(res.message, 'error');
      return;
    }
    draftRef.current = res.session;
    setDraft(res.session);
  };

  /** Wave 3B：移除误建的完全空白组 / 轮 */
  const handleRemoveBlankGroup = (exId: string, roundIndex: number) => {
    const d = draftRef.current;
    if (!d) return;
    const prevEx = d.exercises.find((e) => e.id === exId);
    const removedSetIds = prevEx
      ? prevEx.sets.filter((s) => s.roundIndex === roundIndex).map((s) => s.id)
      : [];
    const res = removeBlankGroupFromHistoryExercise(d, exId, roundIndex);
    if (!res.ok) {
      pushToast(res.message, 'error');
      return;
    }
    for (const sid of removedSetIds) {
      clearCellKeysWithPrefix(`${sid}:`);
    }
    draftRef.current = res.session;
    setDraft(res.session);
  };

  /** Wave 3B：修正历史有氧记录的有效时长或关键参数 */
  const updateDraftCardio = (
    entry: CardioEntry,
    patch: Parameters<typeof correctHistoryCardioEntry>[2],
  ) => {
    const d = draftRef.current;
    if (!d) return;
    const res = correctHistoryCardioEntry(d, entry.id, patch);
    if (!res.ok) {
      pushToast(res.message, 'error');
      return;
    }
    draftRef.current = res.session;
    setDraft(res.session);
  };

  /** 保存草稿 → 正式历史；返回 true=已写库。失败保留草稿不丢输入。
   *  （V3-01：受约束入口 + revision 冲突保护） */
  const saveDraft = async (): Promise<boolean> => {
    // 先把仍聚焦的合法 raw 输入 blur 提交掉，避免「还没 blur 就点保存」把新值丢成旧值
    if (typeof document !== 'undefined') {
      const ae = document.activeElement;
      if (ae instanceof HTMLElement && ae.tagName === 'INPUT') ae.blur();
    }
    await Promise.resolve();
    const d = draftRef.current;
    if (!d) return false;
    // 非法 raw / 已提交非法：一律阻止保存，保留可修正输入（不把旧值当保存值）
    if (hasInvalidRawNow()) {
      pushToast('有未完成或不合法的数字输入，已阻止保存。请先修正。', 'error');
      return false;
    }
    if ((d.note ?? '').length > MAX_TEXT) {
      pushToast(`训练备注最多 ${MAX_TEXT} 个字符，已阻止保存。`, 'error');
      return false;
    }
    // R01：保存前统一校验所有数值，NaN/Infinity/负数/非整数一律拒绝
    for (const ex of d.exercises) {
      if ((ex.note ?? '').length > MAX_TEXT) {
        pushToast(`「${ex.name}」的动作备注超过 ${MAX_TEXT} 字上限，已阻止保存。`, 'error');
        return false;
      }
      for (const st of ex.sets) {
        if (st.reps !== null && (!Number.isFinite(st.reps) || st.reps < 0 || !Number.isInteger(st.reps))) {
          pushToast(`「${ex.name}」有一组的次数不是合法整数，已阻止保存。`, 'error');
          return false;
        }
        if (st.weightKg !== null && (!Number.isFinite(st.weightKg) || st.weightKg < 0)) {
          pushToast(`「${ex.name}」有一组的重量不是合法数值，已阻止保存。`, 'error');
          return false;
        }
      }
    }
    if ((d.cardio ?? []).length > 0) {
      const cardioIssues = validateCardioList(d.cardio, d.endedAt ?? Date.now());
      if (cardioIssues.length > 0) {
        pushToast(`有氧记录校验未通过：${cardioIssues[0].message}`, 'error');
        return false;
      }
    }
    setSaving(true);
    savingRef.current = true;
    try {
      const r = await saveHistorySession({ ...d, revision: draftRevision }, draftRevision);
      if (!r.ok) {
        // 冲突时保留草稿，让用户自己决定是否放弃重来（不静默覆盖、不丢输入）
        pushToast(r.message, 'error');
        return false;
      }
      await refreshSessions();
      // 成功保存 → 草稿与各类错误/raw 一起清空
      resetDraftState();
      pushToast('已保存修改，统计已更新。');
      return true;
    } catch (err) {
      pushToast(err instanceof Error ? `保存失败：${err.message}` : '保存失败', 'error');
      return false;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  /** 进入纠错：克隆当前记录 + 记录版本 + 清空上一次残留的字段错误/raw。 */
  const startEditing = () => {
    cellErrorsRef.current = {};
    setCellErrors({});
    setOpenExNotes({});
    rawStateRef.current.clear();
    setDraftRevision(revisionOf(session));
    // 记录进入纠错时的原始字节：用于 dirty 判定
    baselineRef.current = JSON.stringify(session);
    const clone = structuredClone(session);
    draftRef.current = clone;
    setDraft(clone);
  };

  /** 取消纠错：丢弃草稿并清空字段错误/raw，重新进入时不会残留 disabled（审查 I04） */
  const cancelEditing = () => {
    resetDraftState();
  };

  /** 页内导航（返回历史 / 统计 / 动作表现）：直接交给 router 门禁。
   *  脏/保存中时门禁会把**本次**意图传进守卫并弹三选一，不静默丢草稿。 */
  const requestLeaveNav = (target: string) => {
    navigate(target);
  };

  /** 真正执行**本次**被拦下的导航（路由 / 浏览器 POP / 原生 Back）。 */
  const performLeave = (intent: BlockedNavigation | null) => {
    if (!intent) return;
    if (intent.kind === 'nav') {
      navigate(intent.path, intent.replace);
      return;
    }
    if (intent.kind === 'native-back') {
      // 跳过我们自己的弹层（仍在返回栈里），直接走页面级守卫后的导航
      void handleBackIntent({ handleLayer: false });
      return;
    }
    if (intent.kind === 'pop') {
      // 用户确认后继续浏览器原本的方向（Forward 继续向前，Back 继续后退）
      try {
        window.history.go(intent.delta);
      } catch {
        /* 忽略：极端环境无 history */
      }
      return;
    }
    // 'back'：程序化后退
    back(intent.fallback);
  };

  /** 选择「放弃修改并离开」：丢弃草稿后继续**本次**导航（不重放旧意图）。 */
  const discardAndLeave = async () => {
    if (leaveBusy) return;
    const intent = leavePrompt;
    setLeaveBusy(true);
    try {
      resetDraftState();
      // 等一拍让引用状态稳定后继续导航
      await Promise.resolve();
      performLeave(intent);
    } finally {
      setLeaveBusy(false);
    }
  };

  /** 选择「保存修改并离开」：保存成功才离开；失败/非法保留草稿、留在本页。 */
  const saveAndLeave = async () => {
    if (leaveBusy) return;
    if (hasInvalidRawNow()) {
      // 非法 raw：拒绝保存并离开，保留可修正输入
      pushToast('有未完成或不合法的数字输入，不能保存并离开；请先修正或选择「放弃修改并离开」。', 'error');
      return;
    }
    const intent = leavePrompt;
    setLeaveBusy(true);
    try {
      const ok = await saveDraft();
      if (!ok) {
        // 保存失败/冲突：草稿保留，不离页（明确提示已由 saveDraft 给出）
        setLeavePrompt(null);
        return;
      }
      setLeavePrompt(null);
      performLeave(intent);
    } finally {
      setLeaveBusy(false);
    }
  };

  const sum = summarizeSession(view!, view!.endedAt ?? Date.now());
  const activeExercises = view!.exercises.filter(
    (e) => e.status !== 'skipped' && e.sets.some((st) => isSetLogged(st)),
  );
  const kind = sessionKindOf(session);
  const canCorrect = kind !== 'rest';
  const cardioList = view!.cardio ?? [];

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => requestLeaveNav('/history')}>
          ‹ 历史
        </button>
        <div style={{ flex: 1 }} />
        {canCorrect ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="history-open-receipt"
            onClick={() => setReceiptOpen(true)}
          >
            小票
          </button>
        ) : null}
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: 'var(--brick)' }}
          disabled={saving || deleting}
          onClick={() => {
            if (savingRef.current || saving || deletingRef.current || deleting) return;
            setConfirmDelete(true);
          }}
        >
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

      {/* 有氧明细：与力量同一条历史，时长单列（不并入总时长）；Wave 3B 支持修正时长与参数 */}
      {cardioList.length || kind === 'cardio' ? (
        <section style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <h2 className="h-section">有氧</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mono-label">共 {fmtDuration(sum.cardioMs)}</span>
              {kind === 'cardio' ? (
                editing ? (
                  <span className="tag tag-brick">编辑中</span>
                ) : (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={startEditing}
                    style={{ minHeight: 44 }}
                  >
                    纠正数据
                  </button>
                )
              ) : null}
            </div>
          </div>

          {kind === 'cardio' && editing ? (
            <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: '6px 0 0', lineHeight: 1.6 }}>
              可修正忘关计时器导致的异常时长或器械参数。修改只影响本条历史记录。
            </p>
          ) : null}

          {cardioList.map((c) => {
            const totalSec = Math.max(
              0,
              Math.round(liveElapsedMs(c, view!.endedAt ?? Date.now()) / 1000),
            );
            const curMin = Math.floor(totalSec / 60);
            const curSec = totalSec % 60;
            return (
              <div key={c.id} className="slip" style={{ marginTop: 8, padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <span className="mono-label">
                    {fmtDuration(liveElapsedMs(c, view!.endedAt ?? Date.now()))}
                  </span>
                </div>

                {!editing ? (
                  <>
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
                  </>
                ) : (
                  <div
                    data-testid={`history-cardio-edit-${c.id}`}
                    style={{
                      marginTop: 8,
                      paddingTop: 8,
                      borderTop: '1px dashed var(--rule)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-3)', width: 56, flex: 'none' }}>
                        有效时长
                      </span>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                        <DraftCell
                          value={curMin}
                          integer
                          min={0}
                          max={1440}
                          width={74}
                          unit="分"
                          ariaLabel={`${c.name} 分钟`}
                          onValidityChange={(ok) => setCellValid(`cardio:${c.id}:min`, ok)}
                          onDraftState={(dirty, valid) => setCellRaw(`cardio:${c.id}:min`, dirty, valid)}
                          onCommit={(v) => {
                            const nextMin = v ?? 0;
                            const nextSec = nextMin === 1440 ? 0 : curSec;
                            updateDraftCardio(c, { durationSec: nextMin * 60 + nextSec });
                          }}
                        />
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                        <DraftCell
                          value={curSec}
                          integer
                          min={0}
                          max={curMin >= 1440 ? 0 : 59}
                          width={68}
                          unit="秒"
                          ariaLabel={`${c.name} 秒`}
                          onValidityChange={(ok) => setCellValid(`cardio:${c.id}:sec`, ok)}
                          onDraftState={(dirty, valid) => setCellRaw(`cardio:${c.id}:sec`, dirty, valid)}
                          onCommit={(v) => {
                            const nextSec = v ?? 0;
                            updateDraftCardio(c, { durationSec: curMin * 60 + nextSec });
                          }}
                        />
                      </label>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12.5, color: 'var(--ink-3)', width: 56, flex: 'none' }}>
                        强度参数
                      </span>
                      {c.preset === 'treadmill-incline' ? (
                        <>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                            速度
                            <DraftCell
                              value={c.currentParams.speedKmh ?? null}
                              required
                              min={MIN_SPEED_KMH}
                              max={MAX_SPEED_KMH}
                              width={78}
                              unit="km/h"
                              ariaLabel={`${c.name} 速度`}
                              onValidityChange={(ok) => setCellValid(`cardio:${c.id}:speed`, ok)}
                              onDraftState={(dirty, valid) => setCellRaw(`cardio:${c.id}:speed`, dirty, valid)}
                              onCommit={(v) => {
                                if (v === null) return;
                                updateDraftCardio(c, { params: { speedKmh: v } });
                              }}
                            />
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                            坡度
                            <DraftCell
                              value={c.currentParams.inclinePct ?? null}
                              required
                              min={MIN_INCLINE_PCT}
                              max={MAX_INCLINE_PCT}
                              width={74}
                              unit="%"
                              ariaLabel={`${c.name} 坡度`}
                              onValidityChange={(ok) => setCellValid(`cardio:${c.id}:incline`, ok)}
                              onDraftState={(dirty, valid) => setCellRaw(`cardio:${c.id}:incline`, dirty, valid)}
                              onCommit={(v) => {
                                if (v === null) return;
                                updateDraftCardio(c, { params: { inclinePct: v } });
                              }}
                            />
                          </label>
                        </>
                      ) : (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--ink-3)' }}>
                          档位
                          <DraftCell
                            value={c.currentParams.level ?? null}
                            integer
                            required
                            min={MIN_STAIR_LEVEL}
                            max={MAX_STAIR_LEVEL}
                            width={76}
                            ariaLabel={`${c.name} 档位`}
                            onValidityChange={(ok) => setCellValid(`cardio:${c.id}:level`, ok)}
                            onDraftState={(dirty, valid) => setCellRaw(`cardio:${c.id}:level`, dirty, valid)}
                            onCommit={(v) => {
                              if (v === null) return;
                              updateDraftCardio(c, { params: { level: v } });
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
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
          const achievements = prReport?.bySessionExerciseId.get(ex.id) ?? [];
          const appendBlocker = editing ? historyAppendGroupBlocker(ex) : null;
          return (
            <div key={ex.id} className="slip" style={{ marginTop: 10, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: 'var(--f-sans)',
                      fontSize: 16,
                      fontWeight: 600,
                      lineHeight: 1.4,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {ex.name}
                  </span>
                  {achievements.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                      {achievements.map((ach, aIdx) => (
                        <span
                          key={`${ach.kind}-${aIdx}`}
                          data-testid={ach.isPr ? `history-pr-stamp-${ex.id}` : `history-first-stamp-${ex.id}`}
                          title={ach.detailText}
                          style={
                            ach.isPr
                              ? {
                                  display: 'inline-block',
                                  padding: '1px 6px',
                                  border: '1px solid var(--brick)',
                                  color: 'var(--brick)',
                                  fontFamily: 'var(--f-sans)',
                                  fontSize: 11,
                                  fontWeight: 700,
                                }
                              : {
                                  display: 'inline-block',
                                  padding: '1px 6px',
                                  border: '1px solid var(--rule-strong)',
                                  color: 'var(--ink-3)',
                                  fontSize: 11,
                                }
                          }
                        >
                          {ach.stampLabel}
                          {ach.isPr ? ` · ${ach.detailText}` : ''}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
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
                        {typeof st.weightKg === 'number' && Number.isFinite(st.weightKg) ? ` × ${fmtWeight(st.weightKg)} kg` : ''}
                      </span>
                    ))}
                  </div>
                ) : null
              ) : (
                /* 编辑态：逐组改次数 / 重量 / 完成状态 + 补录组 / 删除空白组 + 单动作备注 */
                <div style={{ marginTop: 8 }}>
                  {ex.sets.map((st) => {
                    const showRemoveBlank =
                      st.stageIndex === 1 && canRemoveBlankGroupFromHistoryExercise(ex, st.roundIndex);
                    return (
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
                            onDraftState={(dirty, valid) => setCellRaw(`${st.id}:reps`, dirty, valid)}
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
                            onDraftState={(dirty, valid) => setCellRaw(`${st.id}:weight`, dirty, valid)}
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
                        {showRemoveBlank ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            data-testid={`history-remove-blank-group-${ex.id}-${st.roundIndex}`}
                            style={{ color: 'var(--brick)', minHeight: 38, fontSize: 12 }}
                            onClick={() => handleRemoveBlankGroup(ex.id, st.roundIndex)}
                          >
                            {ex.target.kind === 'dropSet' ? '删空轮' : '删空组'}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid={`history-append-group-${ex.id}`}
                      disabled={Boolean(appendBlocker)}
                      title={appendBlocker ?? undefined}
                      onClick={() => handleAppendBlankGroup(ex.id)}
                    >
                      {ex.target.kind === 'dropSet' ? '+ 补录一轮' : '+ 补录一组'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid={`history-toggle-ex-note-${ex.id}`}
                      onClick={() =>
                        setOpenExNotes((prev) => ({ ...prev, [ex.id]: !prev[ex.id] }))
                      }
                    >
                      {openExNotes[ex.id]
                        ? '收起动作备注'
                        : ex.note
                          ? '编辑动作备注'
                          : '+ 动作备注'}
                    </button>
                  </div>

                  {openExNotes[ex.id] ? (
                    <div style={{ marginTop: 8 }}>
                      <textarea
                        className="input"
                        data-testid={`history-ex-note-${ex.id}`}
                        aria-label={`${ex.name} 动作备注`}
                        placeholder={`${ex.name} 的动作备注（可选）`}
                        value={ex.note ?? ''}
                        style={{ minHeight: 54, fontSize: 13.5 }}
                        onChange={(e) => updateDraftExerciseNote(ex.id, e.target.value)}
                      />
                    </div>
                  ) : ex.note ? (
                    <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                      {ex.note}
                    </div>
                  ) : null}
                </div>
              )}

              {!editing && ex.note ? (
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--ink-3)', fontStyle: 'italic' }}>{ex.note}</div>
              ) : null}
            </div>
          );
        })}
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
            onChange={(e) => {
              const d = draftRef.current;
              if (!d) return;
              const res = updateHistorySessionNote(d, e.target.value);
              if (!res.ok) {
                pushToast(res.message, 'error');
                return;
              }
              draftRef.current = res.session;
              setDraft(res.session);
            }}
          />
        ) : (
          <p style={{ fontSize: 14, color: session.note ? 'var(--ink-2)' : 'var(--ink-4)', marginTop: 6 }}>
            {session.note || '没有备注'}
          </p>
        )}
      </section>

      {editing && canCorrect ? (
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

      <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => requestLeaveNav('/stats')}>
          查看统计
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => {
            const first = activeExercises[0];
            // 用动作身份而不是计划条目：跨 A/B 也能看到同一动作的历史
            if (first) requestLeaveNav(`/stats?exercise=${encodeURIComponent(first.exerciseId)}`);
            else requestLeaveNav('/stats');
          }}
        >
          动作表现
        </button>
      </div>

      {/*
        item 3：历史纠错的离页确认（复用 router / nativeBack 门禁）。
        未保存（dirty）或保存中时，任何离页（底部 Tab、页内返回、统计跳转、
        浏览器/原生 Back）都会先到这里：保存并离开 / 放弃修改并离开 / 留在此页。
        保存失败保留草稿留在本页；保存成功后直接续上原导航，不会再弹一次。
      */}
      <Sheet
        open={leavePrompt !== null}
        title="离开前确认"
        onClose={() => {
          if (!leaveBusy) setLeavePrompt(null);
        }}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              className="btn btn-primary"
              disabled={saving || leaveBusy || hasCellErrors}
              onClick={() => void saveAndLeave()}
            >
              {leaveBusy ? '保存中…' : '保存修改并离开'}
            </button>
            <button
              className="btn btn-ghost"
              style={{ color: 'var(--brick)' }}
              disabled={saving || leaveBusy}
              onClick={() => void discardAndLeave()}
            >
              放弃修改并离开
            </button>
            <button className="btn btn-ghost" disabled={leaveBusy} onClick={() => setLeavePrompt(null)}>
              留在此页
            </button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--ink-2)' }}>
          {saving
            ? '正在保存修改，请稍候……保存完成后可再选择离开。'
            : '当前记录还有未保存的修改。要保存后离开、放弃修改后离开，还是留在此页？'}
        </p>
      </Sheet>

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
        busy={deleting || saving}
        onCancel={() => {
          if (!deleting) setConfirmDelete(false);
        }}
        onConfirm={async () => {
          if (savingRef.current || saving || deletingRef.current || deleting) {
            pushToast('正在保存中，请稍后再操作', 'error');
            return;
          }
          setDeleting(true);
          deletingRef.current = true;
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
                // 等待事务真实结果：失败不关窗、不假报已撤销、保留可重试草稿
                pushToast(r.message, 'error');
                return;
              }
            } else {
              await deleteSession(session.id);
            }
            // 只有数据库事务确认成功后，清理本页草稿/raw/errors/leave意图，使随后refresh和navigate可正常回到历史列表，后续Tab也可用
            resetDraftState();
            setConfirmDelete(false);
            await refreshSessions();
            pushToast(
              sessionKindOf(session) === 'rest'
                ? '已撤销这条完全休息记录。'
                : '记录已删除，统计已同步更新。',
            );
            navigate('/history');
          } catch (err) {
            // 删除失败保持原草稿/raw/确认窗，解除故障后可重试
            pushToast(err instanceof Error ? `删除失败：${err.message}` : '删除失败', 'error');
          } finally {
            setDeleting(false);
            deletingRef.current = false;
          }
        }}
      />

      {canCorrect ? (
        <ReceiptSlipSheet
          open={receiptOpen}
          session={view!}
          allSessions={sessions}
          onClose={() => setReceiptOpen(false)}
          pushToast={pushToast}
        />
      ) : null}
    </main>
  );
}
