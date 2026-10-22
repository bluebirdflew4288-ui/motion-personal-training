/* 训练执行页 —— 本轮最重要的页面。
   优先保证：输入、查看、点击效率。
   · 每个动作显示目标、上次表现、逐组记录、完成/休息操作
   · 支持临时替换/添加/排序/跳过程，全部只影响本次
   · 所有修改立即自动保存；保存失败会明确提示 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { fmtDate, fmtDuration, fmtRest, fmtTime } from '../lib/format';
import { NumberStepper } from '../ui/Stepper';
import { ElapsedClock, RestTimerBar, useRestTimer } from '../ui/RestTimer';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import {
  hasSkippedGroupsToUnskip,
  restAfterSet,
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
  skipRemaining,
  unskipExercise,
  groupHasNoRecords,
  skippedGroupCount,
  convertExerciseToDropSet,
  convertExerciseToStraight,
  lastRoundHasRecords,
  replaceExerciseInSession,
  roundsOf,
  summarizeSession,
  withExercise,
  withSet,
} from '../domain/session';
import type { DumbbellBasis, Session, SessionExercise, SessionSet, WeightMode } from '../domain/types';

/** 递减组阶段的重量提示 */
const DROP_WEIGHT_NOTE = '哑铃 · 按单只记录';
import { EXERCISE_LIBRARY, searchExercises } from '../domain/presets/library';
import { revisionOf } from '../db/tx';
import {
  accumulateDraftIntent,
  mergeDraftOntoFresh,
  type PendingDraft,
  type PersistOutcome,
} from '../domain/draftMerge';
import { getSession } from '../db/repo';
import {
  collectMovementFragments,
  comparabilityOf,
  describeMode,
  describeMovementPerformance,
  modeOf,
} from '../domain/comparability';
import { DropSetEditor } from '../ui/DropSetEditor';
import { DraftNumberField } from '../ui/DraftNumberField';
import { mergeFlushedDropDraft, mergeFlushedValues, useDraftForm } from '../ui/draftForm';
import { MAX_STRAIGHT_SETS } from '../domain/limits';
import {
  defaultDropDraft,
  draftToDropTarget,
  straightToDropDraft,
  dropTargetToDraft,
  validateDropDraft,
  type DropSetDraft,
} from '../domain/dropSet';
import {
  acquireSessionLockDetailed,
  listenLockEvents,
  makeEditorId,
  refreshSessionLockDetailed,
  releaseSessionLock,
  takeOverSessionLock,
  takeOwnershipOnMount,
} from '../lib/lock';
import { AppLifecycleCoordinator } from '../lib/appLifecycle';
import { handleBackIntent, registerPageLeaveGuard } from '../lib/nativeBack';
import {
  ackRescueDraft,
  clearRescueDraft,
  loadRescueDraft,
  loadRescueRecord,
  publishRescueDraft,
  republishRebasedDraft,
  watchRescueDraft,
  type RescueRecord,
} from '../lib/draftRescue';

/** 草稿身份生成器（V6-01）：单调递增，进程内唯一 */
let draftTokenSeq = 0;
const nextDraftToken = () => {
  draftTokenSeq += 1;
  return draftTokenSeq;
};

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
  recordingPaused,
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
  /** V6-01：有待存草稿时暂停记录，输入必须真的不可用 */
  recordingPaused?: boolean;
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
            <button
              className="btn btn-sm btn-ghost"
              disabled={recordingPaused}
              onClick={() => onPatch({ status: 'blank', reps: null, weightKg: null })}
            >
              撤销
            </button>
          ) : (
            <button
              className="btn btn-sm btn-primary"
              disabled={recordingPaused}
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
            disabled={recordingPaused}
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
              disabled={recordingPaused}
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
  recordingPaused,
}: {
  ex: SessionExercise;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  lastPerformance: { date: number; summary: string; label?: string | null } | null;
  /** 累积式更新：永远基于「最新」session 计算，连续点击不会互相覆盖 */
  apply: (fn: (prev: Session) => Session) => void;
  latestRef: React.RefObject<Session | undefined>;
  timer: ReturnType<typeof useRestTimer>;
  onOpenTools: () => void;
  onRequestRemoveRound: (exId: string) => void;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
  /** V6-01：有待存草稿时暂停记录（覆盖输入、组操作、备注） */
  recordingPaused: boolean;
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
            {/* 递减组阶段明细：单独成块，允许换行（不挤进右列） */}
            {ex.target.kind === 'dropSet' ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12.5,
                  color: 'var(--ink-3)',
                  lineHeight: 1.7,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                {ex.target.stages.map((st, i) => (
                  <span key={`${st.label}-${i}`} style={{ overflowWrap: 'anywhere' }}>
                    {st.label}：{st.targetText}
                  </span>
                ))}
                <span style={{ color: 'var(--ink-4)' }}>
                  阶段间休 {fmtRest(ex.target.restInSec)} · 轮间休 {fmtRest(ex.target.restAfterSec)} ·{' '}
                  {ex.target.rounds} 轮 = {ex.target.rounds} 个正式大组
                </span>
              </div>
            ) : null}

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
              {(() => {
                const skipN = skippedGroupCount(ex);
                return skipN > 0 ? <span className="tag tag-quiet">{skipN} 组已跳过</span> : null;
              })()}
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
                  {lastPerformance.label ? (
                    <span style={{ color: 'var(--ink-4)' }}>（{lastPerformance.label}）</span>
                  ) : null}
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
              disabled={recordingPaused}
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
                        restSec={restAfterSet(ex, set)}
                        timer={timer}
                        canRemove={false}
                        onAutoRest={() => {
                          // V3-06：自动计时与手动「计时」共用同一份快照配置
                          timer.start(restAfterSet(ex, set));
                        }}
                        onPatch={(p) => patchSet(set.id, p)}
                        onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                        weightUnitNote={DROP_WEIGHT_NOTE}
                        recordingPaused={recordingPaused}
                      />
                    ))}
                  </div>
                );
              })}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minHeight: 40 }}
                  disabled={recordingPaused}
                  onClick={() => apply((prev) => addSetTo(prev, ex.id))}
                >
                  + 加一轮
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minHeight: 40 }}
                  disabled={recordingPaused}
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
                  disabled={recordingPaused}
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
                  restSec={restAfterSet(ex, set)}
                  timer={timer}
                  canRemove={ex.sets.length > 1}
                  onAutoRest={() => timer.start(restAfterSet(ex, set))}
                  onPatch={(p) => patchSet(set.id, p)}
                  onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                  weightUnitNote={
                    ex.target.kind === 'straight' && ex.target.weightMode === 'bodyweight' ? '自重动作 · 无需重量' : undefined
                  }
                  recordingPaused={recordingPaused}
                />
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={recordingPaused}
                  onClick={() => apply((prev) => addSetTo(prev, ex.id))}
                >
                  + 加一组
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={recordingPaused}
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
                  disabled={recordingPaused}
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
                  disabled={recordingPaused}
                  onClick={() => {
                    apply((prev) => skipRemaining(prev, ex.id));
                    pushToast('已跳过剩余组；已记录的组仍计入实际量。');
                  }}
                >
                  跳过剩余
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
                disabled={recordingPaused}
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
  const {
    sessions,
    plans,
    activeSession,
    syncSessionLocal,
    saveActiveSession,
    finishTrainingSession,
    discardTrainingSession,
    pushToast,
    refreshSessions,
    refreshPlans,
  } = useStore();
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
  /** C01 路径 B：训练中调整训练形式 */
  const [convertFor, setConvertFor] = useState<string | null>(null);
  const [convertForm, setConvertForm] = useState<'straight' | 'dropSet'>('dropSet');
  const [convertDraft, setConvertDraft] = useState<DropSetDraft>(defaultDropDraft());
  /**
   * V3-04：训练中「转普通组」的组数必须接真实草稿。
   * 旧实现 onCommit 为空回调，应用时又从旧 target 读组数 → 用户改的组数完全没用（审查 I02）。
   */
  const [convertStraightSets, setConvertStraightSets] = useState(3);
  const convertFormApi = useDraftForm();
  const [convertError, setConvertError] = useState<string | null>(null);
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
  /**
   * 本页面实例的编辑身份（V8-LC08 / A05）。
   *
   * 每个实例唯一。**注意：这里绝不提前 publish 到 sessionStorage。**
   * A05 的真实缺陷就是这样产生的：旧代码在本 effect 里先
   * `rememberEditorId(新 ID)`，而后续 effect 里的 reclaim 再去读“上一个持有者”，
   * 读到的已经是新 ID，于是判定“不用接手”直接返回 true —— 旧实例那把未过期的锁
   * 从未被改名，新实例随后 acquire 撞上 held-by-other，刷新/快速重进把自己锁在门外。
   *
   * 正确顺序由 takeOwnershipOnMount() 在**一个** effect 内结构固定：
   *   抓旧持有者 → 原子改名 → 才发布新 ID → 常规 acquire。
   */
  const editorId = useRef(makeEditorId());
  /** 已确认落库的 revision：每次守锁保存成功后由存储层返回（V3-01） */
  const confirmedRevision = useRef<number>(revisionOf(session));
  /** 锁丢失/冲突的准确原因，用于页面提示（不再笼统说"另一个标签页"） */
  const [lockLostReason, setLockLostReason] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  /**
   * 提交忙状态（V6-02 / V7-R07）。
   *
   * R07 的缺陷：`tryTakeOver` 只设置了自己的 `takingOver`，
   * 没有进入 `submittingRef`，于是接管自动保存正在进行时，
   * 「放弃这份改动」按钮仍是可点的，点了会清掉 pending，
   * 而在途的自动保存随后照旧提交 —— 用户已放弃，数据仍被写入。
   *
   * 现在改成**单一 busy 所有者**：
   *   · `busyOwnerRef` 记录当前是 'retry' | 'takeover' 还是 null
   *   · 入口统一用 `beginBusy(owner)` 抢占，抢不到就明确提示并返回
   *   · `finally` 里统一 `endBusy(owner)` 释放（owner 必须匹配，避免误放）
   *   · retry / takeover / discard 三个入口在 **handler 层**都检查同一个 busy
   */
  const busyOwnerRef = useRef<'retry' | 'takeover' | null>(null);
  const [busyOwner, setBusyOwner] = useState<'retry' | 'takeover' | null>(null);

  const beginBusy = useCallback(
    (owner: 'retry' | 'takeover'): boolean => {
      if (busyOwnerRef.current !== null) {
        pushToast(
          busyOwnerRef.current === 'takeover'
            ? '正在接管并保存刚才的改动，请稍候。'
            : '正在保存刚才的改动，请稍候。',
        );
        return false;
      }
      busyOwnerRef.current = owner;
      setBusyOwner(owner);
      return true;
    },
    [pushToast],
  );

  const endBusy = useCallback((owner: 'retry' | 'takeover') => {
    // 只有当前所有者才能释放，避免交错调用误清别人的忙状态
    if (busyOwnerRef.current === owner) {
      busyOwnerRef.current = null;
      setBusyOwner(null);
    }
  }, []);

  /** 是否有提交正在进行（不论谁发起） */
  const isCommittedBusy = busyOwner !== null;
  /** 本次已经主动结束/放弃：之后的心跳失败不再当作"被接管" */
  const intentionallyClosed = useRef(false);
  const finishGuard = useRef(false);
  const [finishing, setFinishing] = useState(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRestTimer(120);

  /**
   * 单活动训练编辑锁 + 页面生命周期（V3-01 / V4-02a）。
   *
   * V4-02a 修复的缺陷（审查 V4D07）：
   *   旧处理器在 visibilitychange 里**无条件** release —— hidden 时释放、visible 时又释放一次；
   *   effect 不因可见性重跑，回来时没有重新获取控制、也没有同步 revision，
   *   于是「切到别的 App / 锁屏 / 查看消息」后回到训练页，第一次输入才以 no-lock 失败。
   *   心跳现在只续「自己已有的锁」，不能复活已释放的锁。
   *
   * 本轮策略：
   *   · hidden：先排空待存队列（配合页面已有的 saveQueue），再释放锁；
   *   · visible / pageshow(bfcache)：读最新记录与锁状态后决定：
   *       - 锁空闲或已过期 → 安全重新获取，并同步 confirmedRevision；
   *       - 别人有效持锁 → **绝不偷锁**，明确只读并给出接管/继续查看路径；
   *   · 恢复后第一笔输入不能"看似可写然后失败被刷新丢掉"：
   *     未保存草稿在内存里保留（latestRef 未被清空），明确提示可重试/接管。
   *   · pagehide/bfcache 返回与普通 hash 卸载走同一套生命周期。
   */
  useEffect(() => {
    let cancelled = false;
    /**
     * V8-C：生命周期由 **AppLifecycleCoordinator** 统一调度。
     *
     * 旧实现在这里各自 addEventListener(visibilitychange/pagehide/pageshow)，
     * Android 容器里还会另外收到原生 appStateChange/pause/resume —— 两路信号
     * 各自抢/放锁，就会重演 V5-02 那个「回前台后第一笔保存 no-lock」。
     * 现在只有这一份队列，DOM 与原生信号都被归一成同一个前台布尔：
     *   · 进后台：先排空待存队列 → 再释放锁
     *   · 回前台：重新对齐记录与锁（别人有效持锁 → 只读，绝不偷锁）
     */
    const coordinator = lifecycle.current;
    let hidden = !coordinator.isForeground;

    const acquireOnMount = async () => {
      /**
       * A05：编辑权获取只走 takeOwnershipOnMount 这一个入口，顺序由它保证：
       *   ① 抓上一个实例的 editorId（此时新 ID 尚未发布）
       *   ② 原子改名给自己（atomicAdoptLock；别人有效持锁则拒绝，绝不偷锁）
       *   ③ 发布新 ID（之后刷新才接手得到它）
       *   ④ 常规 acquire 确认可写
       */
      const r = await takeOwnershipOnMount({ sessionId, editorId: editorId.current });
      if (cancelled) return;
      if (!r.ok) {
        setLockBlocked(true);
        setLockLostReason(r.message ?? '这个训练正在另一个标签页中编辑');
      }
    };
    void acquireOnMount();

    const unlisten = listenLockEvents((e) => {
      if (e.sessionId === sessionId && e.type === 'lock' && e.editorId !== editorId.current) {
        setLockBlocked(true);
        setLockLostReason('这个训练已在另一个标签页中接管');
      }
    });

    // 心跳 8 秒：续租失败立即降级只读（不允许继续写）
    const heartbeat = window.setInterval(() => {
      if (intentionallyClosed.current || hidden) return;
      void refreshSessionLockDetailed(sessionId, editorId.current).then((r) => {
        if (cancelled || intentionallyClosed.current || hidden) return;
        if (!r.ok) {
          setLockBlocked(true);
          setLockLostReason(r.message ?? '编辑锁已失效');
        }
      });
    }, 8000);

    /**
     * hidden / pause：先让待存队列真正跑完，再释放锁。
     *
     * LC08：这里 await 的是 `saveQueue.current` 的**当前速照**；
     * 队列后续追加的任务由页面卸载前的离页守卫（pageLeaveGuard）负责等待，
     * 因此“慢提交”不会因为进后台/离页而丢最后一笔。
     * 队列保证 hidden 的 release 一定排在 visible 的 acquire 之前（V5-02）。
     */
    const doHide = async (isStale: () => boolean): Promise<void> => {
      hidden = true;
      if (intentionallyClosed.current) return;
      await saveQueue.current.catch(() => undefined);
      if (isStale() || cancelled || intentionallyClosed.current) return;
      await releaseSessionLock(sessionId, editorId.current).catch(() => undefined);
    };

    /**
     * visible / resume：重新对齐编辑资格。
     * 不释放锁；只有「空闲/过期/本人」才重新获取，别人有效持锁则只读。
     */
    const doShow = async (isStale: () => boolean) => {
      hidden = false;
      if (cancelled || intentionallyClosed.current) return;

      // ① 先拉最新记录，避免用隐藏期间的旧快照继续编辑
      try {
        await refreshSessions();
        const fresh = await getSession(sessionId);
        if (cancelled || isStale()) return;
        if (fresh) {
          // V5-01：同步「已确认版本」与「基线内容」，但**不动未保存草稿的 baseRevision**
          confirmedRevision.current = revisionOf(fresh);
          baseSessionRef.current = fresh;
          latestRef.current = fresh;
          syncSessionLocal(fresh);
        }
      } catch {
        /* 读不到就沿用内存快照；下面按锁状态决定是否可写 */
      }
      if (isStale()) return;

      // ② 再看锁：空闲/过期/属于自己 → 安全重新获取；别人有效持锁 → 只读
      const r = await acquireSessionLockDetailed(sessionId, editorId.current);
      if (cancelled || isStale()) return;
      if (r.ok) {
        setLockBlocked(false);
        setLockLostReason(null);
        setSaveState((st) => (st === 'error' ? 'idle' : st));
        return;
      }
      setLockBlocked(true);
      setLockLostReason(
        r.reason === 'held-by-other'
          ? '这个训练正在另一个标签页中编辑。回到本页后仍是只读；需要在此继续请点「接管继续编辑」。'
          : (r.message ?? '回到本页后没能取得编辑锁'),
      );
    };

    const stopListening = coordinator.start({ onHide: doHide, onShow: doShow });

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      unlisten();
      stopListening();
      /**
       * LC08：真正卸载（路由离开 / 组件销毁）时**不能 fire-and-forget 释放锁** ——
       * 旧实现那条 `void releaseSessionLock(...)` 会在新实例已经接手之后才落地，
       * 是「快速重进后第一笔保存 no-lock」的直接成因。
       *
       * 现在的顺序保证：
       *   1. 离页守卫（见下方 pageLeaveGuard effect）已经等到保存队列排空、
       *      且把未保存草稿写进跨实例救援位，然后才允许卸载；
       *   2. 这里的释放走 await + 只释放自己实例的 editorId（存储层会拒绝非持有者）；
       *   3. 即使这次释放晚到，新实例已用**不同的 editorId** 持锁，不会被清掉。
       */
      void (async () => {
        await saveQueue.current.catch(() => undefined);
        await releaseSessionLock(sessionId, editorId.current).catch(() => undefined);
      })();
    };
    // refreshSessions / syncSessionLocal 来自 store，稳定；不放进依赖以免重挂 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /**
   * ── LC08 离页守卫（V8-C）──────────────────────────────────────
   *
   * 独立审查要求：训练中「有待存草稿或保存队列时先妥善处理再允许离页，
   * 不能直接卸载后释放锁导致后续保存 no-lock；不要通过静默放弃训练处理返回」。
   *
   * 这里的守卫做三件事，**顺序固定**：
   *   ① 等待保存队列排队中的写入真正落库（慢提交也等，不丢最后一笔）；
   *   ② 若有未保存草稿，把它写进**跨实例救援位**（sessionStorage），
   *      这样即使页面卸载、新实例重进，草稿也不会只留在已销毁组件的 ref 里；
   *   ③ 只有在“没有在途提交、没有未处理草稿”时才放行离页；
   *      否则给出明确提示并**阻止离开**（用户可以点“重试/放弃”后再次返回）。
   *
   * 守卫本身从不丢弃数据：救援位保留，用户可以在提示里先处理再走。
   */
  useEffect(() => {
    const guard = async (): Promise<boolean> => {
      // ① 等当前已排队的写入落地（若期间又追加了新任务，循环再等一次）
      let guardLoop = 0;
      while (guardLoop < 50) {
        guardLoop += 1;
        const pendingQueue = saveQueue.current;
        await pendingQueue.catch(() => undefined);
        if (saveQueue.current === pendingQueue) break;
      }

      // ② 提交中（retry/takeover）也不允许离页：否则提交结果无人接收
      if (busyOwnerRef.current !== null) {
        pushToast('正在保存刚才的改动，请稍候再返回。', 'error');
        return false;
      }

      // ③ 未保存草稿：确保救援位里有最新版本（新实例会接着处理），并阻止离开
      const draft = unsavedDraft.current;
      if (draft) {
        // rememberDraft 已同步发布过；这里只补一次“确保存在”（不重复升版本）
        const seq = publishRescueDraft(sessionId, draft);
        rescuedSeqRef.current = seq ?? rescuedSeqRef.current;
        if (seq !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seq);
        const rescued = seq !== null;
        if (!rescued) {
          pushToast(
            '还有改动没有写进本机，而且当前环境无法临时保存这份草稿。请先点「重试保存这次改动」或「放弃这份改动」再返回。',
            'error',
          );
          return false;
        }
        pushToast(
          '还有改动没有写进本机。已为这份草稿保留临时副本：重进这个训练会继续提示你保存；也可以直接点「重试保存这次改动」。',
          'error',
        );
        return false;
      }

      // ④ 干净状态：清掉可能残留的救援位并放行
      clearRescueDraft(sessionId);
      return true;
    };

    registerPageLeaveGuard(guard);
    return () => registerPageLeaveGuard(null);
  }, [sessionId, pushToast]);

  /**
   * 挂载时接手上一个实例遗留的草稿（V8-LC08）。
   *
   * 场景：慢提交期间按返回 → 守卫把草稿写进救援位并阻止离页；
   * 用户强行离开后快速重进 → 新实例在这里把草稿恢复成自己的 pending，
   * 并明确告知“还有改动没保存”，用户可重试或放弃。
   * 只在挂载时做一次；恢复不会自动提交（避免未经确认就写入）。
   */
  const rescueApplied = useRef(false);
  /** 本实例已经从救援位接过的最高版本号（A06：只升不降） */
  const adoptedRescueSeq = useRef(0);
  /** 本实例是否「因为有救援草稿而持有 pending」（用于区分用户自己新产生的 pending） */
  const pendingFromRescue = useRef(false);

  /**
   * 接住/升级一份救援草稿（A06）。
   *
   * 与上一版的关键区别：
   *   · **不因为“已有 pending”就整体拒绝**：如果 pending 正是上一版救援，
   *     且这次是**更新的版本**（seq 更大），必须升级到最新内容（1 → 15）。
   *   · 用户自己新输入产生的 pending（不是救援来的）不覆盖 —— 保留冲突保护。
   *   · 每次升级都更新 rescuedSeqRef，保证后续提交只确认对应版本。
   */
  const adoptRescueRecord = useCallback(
    (record: RescueRecord, source: 'mount' | 'late') => {
      if (record.seq <= adoptedRescueSeq.current) return; // 旧版本，忽略
      // 自己发布的（rememberDraft / 离页守卫）不需要再“找回”一次
      if (record.seq <= ownPublishedSeq.current) return;

      const existing = unsavedDraft.current;
      // 用户自己产生的草稿（非救援来源）→ 不回退覆盖它
      if (existing && !pendingFromRescue.current) return;

      adoptedRescueSeq.current = record.seq;
      pendingFromRescue.current = true;
      unsavedDraft.current = {
        token: record.token,
        baseRevision: record.baseRevision,
        session: record.session,
        baseSession: record.baseSession,
      };
      rescuedSeqRef.current = record.seq;
      setHasPendingDraft(true);
      setDraftConflicts(null);

      pushToast(
        source === 'late'
          ? '上次离开时那份没保存的改动刚刚被找回来了（已更新到最新内容），已恢复到本页；可以重试保存或明确放弃。'
          : '重进时发现上次离开前还有未保存的改动，已恢复到本页；可以重试保存或明确放弃。',
        'error',
      );
    },
    [pushToast],
  );

  useEffect(() => {
    if (rescueApplied.current) return;
    rescueApplied.current = true;

    // ① 挂载瞬间读一次（覆盖“救援先写入、新实例后挂载”）
    const immediate = loadRescueDraft(sessionId);
    const immediateRecord = immediate ? loadRescueRecord(sessionId) : null;
    if (immediateRecord) adoptRescueRecord(immediateRecord, 'mount');

    /**
     * ② A06：**持续**接收后续版本，不设时间上限。
     * 旧页面的慢写入可能在卸载之后很久才失败；失败路径每次 rememberDraft
     * 都会发布一个更新的版本（1 → 15），这里必须逐个升级到最新，
     * 而不是“接住第一份就 done”。
     */
    const stopWatch = watchRescueDraft(sessionId, (record) => adoptRescueRecord(record, 'late'));
    return stopWatch;
  }, [sessionId, adoptRescueRecord]);

  /** 始终指向最新 session，供「先判断再修改」的操作读取 */
  const latestRef = useRef<Session | undefined>(session);
  latestRef.current = session;

  /**
   * 保存一次改动（V3-01）。
   * · 整条链路只有一个写事务：事务内校验锁（持有者 + 未过期 + schema 合法）+ revision + 状态转换；
   * · 成功后**只更新内存**，不再调用一次无锁写（审查 D20 的第二次写已移除）；
   * · 失败要区分原因：锁丢失 → 降级只读；版本/状态冲突 → 提示刷新；
   *   存储失败 → 可重试，不清空用户的输入。
   */
  /**
   * 未保存草稿（V4-02a / V5-01）。
   *
   * V5-01 修正（审查 V5D09）：草稿必须**带着自己的 baseRevision**，
   * 不能因为重新取得锁就把 revision 换成 fresh 值 —— 那会让一份「基于旧库生成的整份快照」
   * 冒充「基于最新库生成的记录」，绕开存储层 CAS，把另一页刚保存的数据整段覆盖掉。
   *
   * 因此这里存的是 PendingDraft：
   *   · session      用户想要的最终状态
   *   · baseRevision 生成草稿时本页已确认落库的版本
   *   · baseSession  生成草稿时库里的样子（三方合并的 base 一侧）
   * 重试时由 mergeDraftOntoFresh 做「只应用本页真正改过的字段」，冲突则拒绝。
   */
  const unsavedDraft = useRef<PendingDraft | null>(null);
  /**
   * 当前 pending 对应的**救援发布版本**（A06）。
   * 只有本次提交真正覆盖的那一版才允许清除救援位；
   * 若存储里已有更新的版本（例如 1 正在提交时又来了 15），必须保留。
   */
  const rescuedSeqRef = useRef<number | null>(null);
  /**
   * 本页自己最近一次**成功落库**的那一版（A06 F1/F2）。
   *
   * 用途：同一份意图可能分两次落库（1 先成功、随后改成 15）。
   * 第二次重试时库里的 fresh 就是本页自己写的 1；用它当合并基准，
   * 才不会被误判成“另一个编辑者改了同一字段”。
   * 真正的外部改动 revision 不会出现在这里，冲突保护不受影响。
   */
  const ownPriorCommitRef = useRef<{ revision: number; intent: Session } | null>(null);
  /**
   * 本实例**自己发布过**的最高救援 seq。
   *
   * 为什么需要：rememberDraft 自己就会 publish 一次，watcher 随即会看到这个新 seq。
   * 若不做区分，watcher 会把本实例刚存下的草稿再“找回”一次 —— 内容虽然相同，
   * 但会覆盖 pendingFromRescue 状态并弹出多余的“已找回”提示。
   * 因此凡是“自己发布的”一律不 adopt。
   */
  const ownPublishedSeq = useRef(0);
  /**
   * lockBlocked 的 ref 镜像。
   * 为什么需要：setState 之后同一 handler 里的闭包仍是旧值，
   * 旧实现因此出现过「点重试但 persist 仍捕获 blocked=true」的首击失效（审查 V5D09）。
   * persist 现在读 ref（始终最新），并可被调用方用显式 ctx 覆盖。
   */
  const lockBlockedRef = useRef(false);
  lockBlockedRef.current = lockBlocked;
  /** 本页最后一次确认落库的记录内容：作为三方合并的 base 一侧 */
  const baseSessionRef = useRef<Session | null>(session ?? null);
  /** 草稿合并冲突明细（有值时在只读/错误横幅里展示，草稿保留不丢） */
  const [draftConflicts, setDraftConflicts] = useState<Array<{ path: string; message: string }> | null>(null);
  /**
   * 是否还有未落库草稿（V5-01 隐藏缺陷修复）。
   * 为什么需要单独 state：unsavedDraft 是 ref，变化不触发渲染；
   * 结果「重试保存这次改动」按钮只在 lockBlocked 横幅里出现过，
   * 一旦 visible 把 lockBlocked 置回 false，横幅连同按钮一起消失，
   * 草稿虽然还在内存里却没有任何入口可点 —— 用户的输入等于被静默吞掉。
   */
  const [hasPendingDraft, setHasPendingDraft] = useState(false);
  /**
   * 生命周期动作统一串行（V5-02 → V8-C）。
   * 类型从 LifecycleQueue 升级为 AppLifecycleCoordinator：
   * 它内部仍持有一份 LifecycleQueue（先 hidden release、后 visible acquire 的顺序不变），
   * 但把 **DOM 事件与 Capacitor 原生事件** 归一成同一套信号，避免两路各自抢/放锁。
   */
  const lifecycle = useRef(new AppLifecycleCoordinator());

  /**
   * 把一个未落库的改动登记为待存草稿（带 baseRevision / baseSession）。
   * baseRevision 取「本页最后一次确认落库的版本」，baseSession 取「那份版本对应的库内容」。
   */
  /** 本次编辑前的当前视图（用于判断"这次改了哪些字段"，V6-01 路径 B） */
  const viewBeforeRef = useRef<Session | null>(null);

  const rememberDraft = useCallback((next: Session) => {
    const existing = unsavedDraft.current;
    if (existing) {
      /**
       * V6-01 路径 B：已有草稿时**不能**用新 next 整份替换它。
       * 旧实现 `{ ...existing, session: next }` 把旧意图（例如第 1 组 15）
       * 换成基于 fresh 的整份快照（第 3 组 12），15 当场消失，之后重试也找不回来。
       *
       * 现在把 next 相对**旧草稿的会话内容**做一次三方合并再存：
       * base = 旧草稿当前 session，mine = next，fresh = 旧草稿当前 session
       * → 效果是「增量叠加」，next 里被改动的字段覆盖，其余（含 15）保留。
       */
      /**
       * V6-01 路径 B 的正确累积（见 domain/draftMerge.accumulateDraftIntent 说明）。
       *
       * 这里是**同一个用户的两批未提交意图**，没有"别人"参与，
       * 因此不能用三方 mergeDraftOntoFresh —— 那会把"同组从 1 改成 15"判成冲突并回退成 1
       * （实测：只读时连按 1→15，草稿最后只剩 1，第 1 组丢了两位数）。
       *
       * 累积规则：本次改过的字段用 next；本次没动但旧草稿有意图的字段继续保留。
       * viewBefore 用 latestRef（本次编辑前的当前视图）。
       */
      const accumulated = accumulateDraftIntent(
        existing.baseSession,
        existing.session,
        viewBeforeRef.current ?? existing.session,
        next,
      );
      unsavedDraft.current = {
        ...existing,
        session: accumulated,
        // 旧草稿的基线保持不变（这批意图仍基于那个库版本）
        baseRevision: existing.baseRevision,
        baseSession: existing.baseSession,
      };
      setHasPendingDraft(true);
      // A06：草稿一产生就**同步**发布救援意图（不依赖离页守卫被调用）
      const seq = publishRescueDraft(sessionId, unsavedDraft.current);
      rescuedSeqRef.current = seq;
      if (seq !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seq);
      return;
    }
    unsavedDraft.current = {
      token: nextDraftToken(),
      session: next,
      baseRevision: confirmedRevision.current,
      baseSession: baseSessionRef.current ?? next,
    };
    // 这是用户自己新产生的草稿（不是救援来的）：之后到达的救援版本不得覆盖它
    pendingFromRescue.current = false;
    setHasPendingDraft(true);
    // A06：同上 —— 这是“浏览器 hash 返回 / 非守卫卸载”唯一能留下草稿的时机
    const seqAgain = publishRescueDraft(sessionId, unsavedDraft.current);
    rescuedSeqRef.current = seqAgain;
    if (seqAgain !== null) ownPublishedSeq.current = Math.max(ownPublishedSeq.current, seqAgain);
  }, [sessionId]);

  /**
   * 保存一次改动（V3-01 / V5-01）。
   *
   * @param next 要写入的记录
   * @param ctx  显式上下文。**不再依赖 lockBlocked 闭包**：
   *             旧实现在 setLockBlocked(false) 之后立刻调用 persist，
   *             但同一 handler 里的 persist 仍捕获着旧的 blocked=true，
   *             于是"重试"首击只把草稿再存回、并没有真正写入（审查 V5D09 闭包说明）。
   *             现在由调用方显式告知是否可写、期望哪个版本。
   */
  const persist = useCallback(
    (
      next: Session,
      ctx?: {
        writable?: boolean;
        expectedRevision?: number;
        draftToken?: number;
        /** 本次提交对应的救援版本快照（A06 F1：调用时绑定，随队列不可变携带） */
        reservedSeq?: number | null;
        /**
         * D1 = **本次提交的原始意图快照**（A06）。
         *
         * 必须由调用方在 persist 时显式冻结，**不能用 next 冒充**：
         * applyPendingDraft 走的是 merged(base, pending.session, fresh) → expect(merged.session)，
         * 此时 next 已经掺入了别人写入的字段（例如另一组的 20），它不等于 D1。
         * D1 只能是「本次 pending 的原始救援意图」。
         */
        intentSnapshot?: Session;
      },
    ): Promise<PersistOutcome> => {
      const writable = ctx?.writable ?? !lockBlockedRef.current;
      /**
       * 期望版本分两种来源，不能混：
       * · ctx.expectedRevision 显式给出（合并/重试路径）→ 必须用它，
       *   因为那份记录是基于某个特定库版本算出来的。
       * · 否则（普通逐键输入）→ **在队列执行时**读 confirmedRevision.current。
       *   旧实现在 persist 调用时就把值拷出来，于是连续两次输入会带着同一个
       *   （第一次保存前）的 revision 入队，第二次必然 version-conflict。
       */
      const explicitExpected = ctx?.expectedRevision;

      const token = ctx?.draftToken ?? null;
      /**
       * A06 F1：**在 persist 被调用的这一刻**就把“本次提交对应哪一版救援”固定下来，
       * 随这次排队提交不可变携带。
       *
       * 缺陷重现：retry1 在途时，旧实例的 15 通过真实 watch/adopt 把 rescuedSeqRef 推进到 2。
       * 旧实现在提交成功时才读 `rescuedSeqRef.current`（已经是 2），于是这次
       * “提交 1 成功”错误地确认了第 2 版，把 15 删掉 → DB=[1,20,null]、pending/rescue 全空、
       * 第二次 retry 提示“没有待保存的改动”。
       *
       * 现在只确认**这次提交真正覆盖的那一版**。
       * 注意：这与 expectedRevision 是两件事 —— 后者仍必须在队列执行时读
       * （见下方 `expected = explicitExpected ?? confirmedRevision.current`），
       * 否则连续逐键输入会带同一个旧 revision 入队并必然 version-conflict。
       */
      /**
       * A06（F1 绑定，修正版）：**显式快照优先，且必须尊重显式 null**。
       *
       * 旧写法 `ctx?.reservedSeq ?? rescuedSeqRef.current` 有两个毛病：
       *   ① 调用方给出 null（表示“这份 pending 没有对应救援版本”）时，
       *      `??` 会回退到**当前** ref —— 那已经是别人后来推进的新版本，
       *      于是用旧 pending 去确认了新版本（正是本轮复验指出的漏口）。
       *   ② 只有真正没提供时，才该读当前 ref。
       * 因此用 `in` 判断“调用方是否表过态”，而不是用 nullish 合并。
       */
      const reservedSeq = ctx && 'reservedSeq' in ctx ? (ctx.reservedSeq ?? null) : rescuedSeqRef.current;
      /** 本次提交所基于的草稿 token（用于判断“我提交的是不是当前这份草稿”） */
      const submittedAtSeq = reservedSeq;
      /**
       * A06：D1 —— 调用时冻结的**原始意图**。
       * 普通逐键输入没有“原始救援意图”，此时退回 next（它就是本页意图本身）。
       * 重试/合并路径必须由调用方传入 pending.session，绝不能用合并后的 next。
       */
      const intentSnapshot: Session = ctx?.intentSnapshot ?? next;

      if (!writable) {
        rememberDraft(next);
        setSaveState('error');
        pushToast(
          '本页当前只读，这次改动还没有保存。取得编辑控制后可以重试保存；你的输入仍保留在本页。',
          'error',
        );
        return Promise.resolve({ status: 'not-attempted' as const });
      }
      setSaveState('saving');
      /**
       * V6-02：返回一个**可等待真实提交**的 Promise。
       * 旧实现只返回 undefined，调用方（retry/takeover）把"入队"当成"已保存"，
       * 事务真正 abort 时已经发出成功提示。现在由事务 oncomplete 的结果决定。
       */
      let settle: (o: PersistOutcome) => void = () => undefined;
      const outcome = new Promise<PersistOutcome>((res) => {
        settle = res;
      });
      saveQueue.current = saveQueue.current
        .then(async () => {
          // 队列执行时才确定期望版本（见上方说明）
          const expected = explicitExpected ?? confirmedRevision.current;
          const r = await saveActiveSession(
            { ...next, revision: expected },
            { editorId: editorId.current, expectedRevision: expected },
          );
          if (!r.ok) {
            /**
             * A06 F2：**旧版提交失败不得覆盖已经接住的更新意图**。
             *
             * 缺陷：真实 sessions.put 成功后注入 tx.abort（写入失败），
             * 此时旧实例的 15 已通过 watch/adopt 成为当前意图。
             * 旧实现无条件 rememberDraft(next=旧1)，把 pending/rescue 覆盖成 1，
             * 之后重试就把 1 落库 —— 更新的 15 被旧数据挤掉。
             *
             * 判定“已有更新意图”的两个可观测信号（任一成立即保留现状）：
             *   · 当前 pending 的 token 与本次提交的 token 不同（已换成另一份意图）
             *   · 救援位里出现比本次捕获版本更新的 seq
             */
            const rescueNow = loadRescueRecord(sessionId);
            const newerPending =
              unsavedDraft.current !== null && token !== null && unsavedDraft.current.token !== token;
            const newerRescue =
              rescueNow !== null && submittedAtSeq !== null && rescueNow.seq > submittedAtSeq;
            if (newerPending || newerRescue) {
              // 更新的意图已在内存或救援位：保留它，绝不回写成旧的这一版
              if (rescueNow) {
                unsavedDraft.current = {
                  token: rescueNow.token,
                  baseRevision: rescueNow.baseRevision,
                  session: rescueNow.session,
                  baseSession: rescueNow.baseSession,
                };
                rescuedSeqRef.current = rescueNow.seq;
                pendingFromRescue.current = true;
              }
              setHasPendingDraft(true);
            } else {
              // 失败的就是当前这份意图：正常登记草稿，不静默丢失输入
              rememberDraft(next);
            }
            if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
              setLockBlocked(true);
              setLockLostReason(r.message);
            }
            if (r.reason === 'state-conflict' || r.reason === 'version-conflict') {
              setConflictMessage(r.message);
            }
            setSaveState('error');
            pushToast(r.message, 'error');
            settle({ status: 'failed', reason: r.reason, message: r.message });
            return;
          }
          // 版本以落库结果为准；内存只做更新，不再写库
          confirmedRevision.current = r.revision;
          baseSessionRef.current = r.session;
          /**
           * V6-01 关键：**只有这次提交真的把草稿包含进去**，才清除草稿。
           * · draftToken 与当前草稿的 token 相同 → 这次提交就是草稿本身（重试/合并路径）
           * · 普通输入（无 token）→ 不得清除任何他人草稿
           */
          const cur = unsavedDraft.current;
          const includedDraft = cur !== null && token !== null && cur.token === token;
          /**
           * A06 F1：成功时**记住本页这一版已经落库**（供同一意图后续增量避免自撞冲突）。
           * 这属于普通保存路径，逐键输入也会记录，不改变任何 CAS 语义。
           */
          if (includedDraft) {
            /**
             * D1 = intentSnapshot：**原始意图**，既不是合并后的 next，
             * 也不是落库结果 r.session（后者可能含别处写入的字段）。
             */
            ownPriorCommitRef.current = { revision: r.revision, intent: intentSnapshot };
          }
          if (includedDraft || (cur === null && token === null)) {
            /**
             * A06：只确认**本次提交覆盖的那一版救援**。
             * 若救援位里已经有更新的版本（seq 更大），绝不在这里清除 ——
             * 那代表用户在提交期间又产生了新意图（1 正在存、15 已经来了）。
             * ackRescueDraft 会把更新的版本交回来，我们据此保留 pending。
             */
            // F1：只确认**调用时捕获的那一版**，不是“现在的最新版”
            // F1：只确认**调用时捕获的那一版**，不是“现在的最新版”
            const acked = ackRescueDraft(sessionId, submittedAtSeq);
            if (acked.newer) {
              /**
               * 还有更新的意图（D2）没落库 → 必须留下来，并且**按 D1 重新定基**。
               *
               * 设：
               *   D1 = 本次提交的原始意图 = next（不含别处后来写入的内容）
               *   C  = 本次提交后库里的真实结果 r.session（可能含别处写入的第 2 组 20）
               *   D2 = 晚到的更新意图（在 D1 之上继续演进，本身不含 20）
               *
               * 正确做法（审查给定边界）：
               *   ① 先 base=D1 / mine=D2 / fresh=C 合并出 M2；
               *   ② 新 pending 配成 base=C(revC) / target=M2。
               * 不能直接把 base 换成 C，否则 D2 里没有 20 会被误判成“本页删掉了 20”；
               * 也不能只换 baseRevision 而保留旧的整份 target。
               */
              const d1 = intentSnapshot; // 同一次提交的 D1，不是 next
              const d2 = acked.newer;
              const rebased = mergeDraftOntoFresh(d1, d2.session, r.session, null);
              if (rebased.ok) {
                unsavedDraft.current = {
                  token: d2.token,
                  // base 现在是**真实已提交结果 C**，所以下次重试走“整份直接保存”
                  baseRevision: r.revision,
                  baseSession: r.session,
                  session: rebased.session,
                };
              } else {
                // 真冲突（含外部改动）：保留 D2 原样，交给既有冲突提示，不静默覆盖
                unsavedDraft.current = {
                  token: d2.token,
                  baseRevision: d2.baseRevision,
                  session: d2.session,
                  baseSession: d2.baseSession,
                };
              }
              /**
               * 恢复闭环：把**已重新定基**的 pending 写回救援位。
               *
               * 若不写回，sessionStorage 里仍是旧的 D2/base0；
               * 一旦此时刷新或重挂（ownPriorCommitRef 随组件消失），
               * 新实例会把库里的 C（本页刚写的 1）当成外部改动 → 15 永远存不进去。
               * 写回后 base 就是 C，重挂后 applyPendingDraft 走「整份直接保存」即可。
               *
               * 只在记录仍是最新时写，且绝不覆盖更晚的 seq。
               */
              /**
               * 先把 rescuedSeqRef 对齐到**当前持有的这份意图**（acked.newer.seq），
               * 再尝试把 rebase 后的坐标写回救援位。
               *
               * 顺序很重要：写回属于“附加的恢复能力”，
               * 它若因任何原因失败（例如环境缺少 helper / 存储写入异常），
               * 也不能让 rescuedSeqRef 停留在旧 seq —— 否则下一次成功提交
               * 无法确认自己覆盖的那一版，pending 永远不会被清掉。
               */
              rescuedSeqRef.current = acked.newer.seq;
              if (unsavedDraft.current) {
                try {
                  const republished = republishRebasedDraft(
                    sessionId,
                    unsavedDraft.current,
                    acked.newer.seq,
                  );
                  if (republished !== null) {
                    rescuedSeqRef.current = republished;
                    ownPublishedSeq.current = Math.max(ownPublishedSeq.current, republished);
                    adoptedRescueSeq.current = Math.max(adoptedRescueSeq.current, republished);
                  }
                } catch {
                  /* 写回失败不影响主流程：本页 pending 已经是 rebase 后的正确坐标 */
                }
              }
              pendingFromRescue.current = true;
              setHasPendingDraft(true);
            } else {
              unsavedDraft.current = null;
              rescuedSeqRef.current = null;
              pendingFromRescue.current = false;
              setHasPendingDraft(false);
              setDraftConflicts(null);
            }
          }
          syncSessionLocal(r.session);
          setSaveState('idle');
          settle({ status: 'saved', revision: r.revision, includedDraft });
        })
        .catch((err: unknown) => {
          setSaveState('error');
          pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存：本地写入失败', 'error');
          settle({ status: 'failed', reason: 'storage', message: '本地写入失败' });
        });
      return outcome;
    },
    [saveActiveSession, syncSessionLocal, pushToast, rememberDraft, sessionId],
  );

  /**
   * 训练数据是否被暂停（V6-01）。
   *
   * 为什么要在 handler 层真的挡住：审查 V6A02/V6A03 证明，
   * 待存草稿存在时继续普通输入会：
   *   · 路径 A：普通保存成功 → 无条件清空 pending → 旧的第 1 组 15 永久丢失
   *   · 路径 B：rememberDraft 用 fresh 派生的整份快照替换 pending → 15 当场消失
   * 本轮采用审查给的最小安全方案：**存在 pending 时先要求重试或明确放弃**，
   * 而不是继续维护"有草稿还能照常录入"的复杂路径。
   *
   * 必须覆盖：次数/重量 Stepper、完成/撤销、加删组、跳过、备注、热身、工具操作、
   * 以及结束训练 —— 只把按钮置灰但子组件仍写库等于没修。
   */
  /**
   * 训练数据输入是否被暂停。
   *
   * 两个来源，任一成立都暂停：
   *   · hasPendingDraft —— 有待存草稿，必须先重试或明确放弃（V6-01）
   *   · lockBlocked —— 本页只读（别人持锁 / 锁失效）
   *
   * 关于只读为什么也直接禁止输入（而不是"照常录入、事后转成草稿"）：
   * 那条路径要求"只读时也能完整键入并被正确累积"，但它和草稿累积互相干扰 ——
   * 实测只读时连按 `1`→`15`，第一位之后的输入会被草稿保护逻辑挡下，
   * 最终只留下 1（用户看到 15、实际存 1，正是不能接受的"看似接受实则丢弃"）。
   * 本轮采用更简单也更安全的口径：**已知只读就从一开始不许输入**，
   * 不维护这条复杂路径。界面会说明原因与可以做什么。
   */
  const inputPaused = hasPendingDraft || lockBlocked;
  const pausedNotice = useCallback(() => {
    if (hasPendingDraft) {
      pushToast(
        '还有改动没有写进本机。请先在下方「还有改动没有写进本机」里点「重试保存这次改动」，或明确「放弃这份改动」，然后再继续记录。',
        'error',
      );
      return;
    }
    pushToast(
      '本页当前只读（这个训练正在另一个标签页中编辑，或编辑锁已失效），暂时不能记录。请回到原标签页继续，或在这里点「接管继续编辑」取得控制。',
      'error',
    );
  }, [pushToast, hasPendingDraft]);

  /** 累积式修改：fn 接收「最新」session，避免连续点击互相覆盖 */
  const applyChange = useCallback(
    (fn: (prev: Session) => Session) => {
      // V6-01：有待存草稿或本页只读时，都不允许训练数据改动进入写库路径
      if (inputPaused) {
        pausedNotice();
        return;
      }
      const prev = latestRef.current;
      if (!prev) return;
      const next = fn(prev);
      if (next === prev) return;
      // V6-01 路径 B：记录"本次编辑前的视图"，供草稿累积判断哪些字段属于本次意图
      viewBeforeRef.current = prev;
      latestRef.current = next;
      persist(next);
    },
    [persist, inputPaused, pausedNotice],
  );

  /**
   * 把待存草稿应用到当前库状态（V5-01 核心）。
   *
   * 旧实现：`persist({ ...pending, revision: freshRevision })`
   *   → 给整份旧快照换上新 revision，绕开 CAS，把另一页保存的组数据清空。
   *
   * 新实现：
   *   · pending.baseRevision === fresh.revision → 没人动过，整份直接保存（走正常 CAS）
   *   · 不同 → 用 mergeDraftOntoFresh 只应用本页真正改过的 set/field；
   *            同字段冲突或结构变化 → **拒绝并保留草稿**，不覆盖库数据
   *
   * 返回是否已提交（提交成功或明确不再尝试）。
   */
  const applyPendingDraft = useCallback(
    async (
      pending: PendingDraft,
      fresh: Session,
      /**
       * A06（F1 绑定）：与 `pending` **同一同步时刻**捕获的救援版本号。
       *
       * 必须由调用方在读取 pending 的那一行同时冻结并传入。
       * 若在 persist 内部现读 rescuedSeqRef.current，会踩到本轮的漏口：
       *   retry 入口抓到 pending=1 → await getSession 期间 watch/adopt 把 seq 推进到 2
       *   → 提交 1 成功时却确认了 seq2，把 15 删掉。
       * 显式 null 表示“这份 pending 本来就没有救援版本”，绝不回退到当前 ref。
       */
      pendingSeq: number | null,
    ): Promise<{ kind: 'saved' } | { kind: 'conflict' } | { kind: 'failed'; message: string }> => {
      const freshRev = revisionOf(fresh);

      /**
       * V6-02：**必须 await 真实提交结果**，不能入队就报成功。
       * draftToken 让 persist 知道"这次提交包含着这份草稿"，
       * 只有它真的提交成功才允许清除。
       */
      /**
       * @param session 要落库的记录（可能是 merged 结果，含 C 里别处的字段）
       *
       * A06 关键：D1（原始意图）**另行**冻结为 pending.session —— 它就是这份救援意图本身，
       * 不含别处写入的字段。绝不能用 session（合并结果）冒充 D1。
       */
      const expect = (session: Session) =>
        persist(session, {
          writable: true,
          expectedRevision: freshRev,
          draftToken: pending.token,
          /**
           * F1：把**此刻**这份草稿对应的救援版本一起冻结进这次提交。
           * 无论队列里之后又接住多少更新版本，这次提交只承认自己这一版。
           */
          reservedSeq: pendingSeq,
          /** D1：本次提交的原始救援意图（不是 merged 结果） */
          intentSnapshot: pending.session,
        });

      if (pending.baseRevision === freshRev) {
        // 没有任何别人写入：这份草稿就是基于当前库，可以整份保存
        const r = await expect({ ...pending.session, revision: freshRev });
        if (r.status === 'saved') return { kind: 'saved' };
        if (r.status === 'not-attempted') return { kind: 'failed', message: '当前不可写，草稿已保留' };
        return { kind: 'failed', message: r.message };
      }

      /**
       * 库已经前进：只应用本页实际改过的字段。
       *
       * A06 F1：把「本页自己上一次提交的那一版」也传给合并器。
       * 若库现在就是本页自己写的（1），那 1→15 是**同一意图的演进**，不是外部冲突：
       *   base=1 / mine=15 / fresh=1 → 采用 15。
       * 若无这一项（库被别人改过），仍是原来的三方冲突判定，冲突照旧拒绝。
       */
      /**
       * A06：把「本页上一次成功提交的原始意图 D1 + 它的 revision」传给合并器。
       * 当 fresh.revision === 该 revision 时，说明库当前就是我写的：
       *   base=D1 / mine=D2 / fresh=C → 同一意图的演进可正常合并；
       *   C 里由别处写入、而 D2 未包含的字段不会被误判成删除。
       * 若库被别人推进（revision 不等），合并器保持原有三方冲突判定。
       */
      const own = ownPriorCommitRef.current ?? pending.priorOwnCommit ?? null;
      const merged = mergeDraftOntoFresh(pending.baseSession, pending.session, fresh, own);

      if (!merged.ok) {
        // 冲突：拒绝整份重试，草稿原样保留，库数据不动
        setDraftConflicts(merged.conflicts.map((c) => ({ path: c.path, message: c.message })));
        setSaveState('error');
        pushToast(merged.message, 'error');
        return { kind: 'conflict' };
      }

      setDraftConflicts(null);
      const r = await expect(merged.session);
      if (r.status === 'saved') return { kind: 'saved' };
      if (r.status === 'not-attempted') return { kind: 'failed', message: '当前不可写，草稿已保留' };
      return { kind: 'failed', message: r.message };
    },
    [persist, pushToast],
  );

  /**
   * 主动接管：仅当对方租期已过（约 20 秒无心跳）才允许。
   * 接管后本页恢复可写；原标签页下一次心跳/保存会被存储层拒绝并自动转入只读。
   */
  const tryTakeOver = useCallback(async () => {
    // R07：接管必须进入与其他提交相同的忙状态，否则"放弃"会在提交期间生效
    if (!beginBusy('takeover')) return;
    try {
      const r = await takeOverSessionLock(sessionId, editorId.current);
      if (!r.ok) {
        setLockLostReason(r.message ?? '接管失败');
        pushToast(r.message ?? '接管失败', 'error');
        return;
      }
      // 重新读一遍最新记录，避免用旧快照继续编辑
      await refreshSessions();
      const loaded = await getSession(sessionId);
      if (loaded) {
        confirmedRevision.current = revisionOf(loaded);
        syncSessionLocal(loaded);
      }
      setLockBlocked(false);
      setLockLostReason(null);
      setSaveState('idle');

      /**
       * 取得控制后，把之前因只读而没保存的草稿按同一套规则应用（V5-01）。
       * 旧实现在这里 `persist({ ...pending, revision: fresh })` —— 与手点重试完全相同的覆盖缺陷。
       * 现在统一走 applyPendingDraft：baseRevision 相同才整份保存，否则三方合并/冲突拒绝。
       */
      /**
       * A06（F1 绑定，接管路径同根因）：
       * 读取 pending 的**同一同步时刻**冻结配对的救援版本号。
       * 下面还有 `await getSession`，期间 watch/adopt 可能推进当前意图；
       * 若不冻结，提交旧 pending 时会误确认新版本。
       */
      const pending = unsavedDraft.current;
      const pendingSeq = rescuedSeqRef.current;
      if (pending) {
        const fresh = await getSession(sessionId);
        if (!fresh) {
          pushToast('已接管这个训练，但读不到最新记录；刚才的改动仍保留在本页。', 'error');
        } else {
          // V6-02：等真实提交结果再决定提示，入队阶段只说"正在保存"
          const outcome = await applyPendingDraft(pending, fresh, pendingSeq);
          if (outcome.kind === 'saved') {
            pushToast('已接管这个训练，刚才的改动已保存。');
          } else if (outcome.kind === 'conflict') {
            pushToast('已接管这个训练。刚才的改动与另一页冲突，草稿保留在本页。', 'error');
          } else {
            pushToast(`已接管这个训练，但刚才的改动没有保存成功：${outcome.message}。草稿保留在本页。`, 'error');
          }
        }
      } else {
        pushToast('已接管这个训练，可以继续记录。');
      }
    } catch (err) {
      pushToast(err instanceof Error ? `接管失败：${err.message}` : '接管失败', 'error');
    } finally {
      endBusy('takeover');
    }
  }, [sessionId, refreshSessions, syncSessionLocal, pushToast, applyPendingDraft, beginBusy, endBusy]);

  /**
   * 重试保存未落库的草稿（V4-02a）。
   * 先重新核验锁：只有「空闲 / 过期 / 本人」才重试；别人有效持锁时明确只读，不偷锁。
   */
  /**
   * 明确放弃待存草稿（V6-02 / R07）。
   *
   * 这是唯一允许主动丢弃用户输入的入口。
   * **handler 层**必须检查与其他提交相同的忙状态：
   * R07 的缺陷正是"接管自动保存进行中，放弃按钮仍可点、点了真清掉 pending，
   * 而在途保存随后照旧提交"。现在不管 UI 是否禁用，这里都会拒绝。
   */
  const discardPendingDraft = useCallback(() => {
    if (busyOwnerRef.current !== null) {
      pushToast(
        busyOwnerRef.current === 'takeover'
          ? '正在接管并保存刚才的改动，请稍候再决定。'
          : '正在保存刚才的改动，请稍候再决定。',
        'error',
      );
      return;
    }
    if (!unsavedDraft.current) {
      pushToast('当前没有待保存的改动。');
      return;
    }
    unsavedDraft.current = null;
    rescuedSeqRef.current = null;
    pendingFromRescue.current = false;
    setHasPendingDraft(false);
    setDraftConflicts(null);
    setSaveState('idle');
    // 用户明确放弃：救援位也一起清掉，避免下次重进又弹出来
    clearRescueDraft(sessionId);
    pushToast('已放弃这份未保存的改动。');
  }, [pushToast, sessionId]);

  /**
   * 重试保存未落库的草稿（V4-02a → V5-01）。
   * 先重新核验锁；再按 baseRevision 决定「整份保存」还是「三方合并」。
   */
  const retryUnsaved = useCallback(async () => {
    /**
     * A06（F1 绑定关键）：
     * **在读取 pending 的同一同步时刻**捕获与它对应的救援版本号，
     * 组成不可变快照对，一路传到 applyPendingDraft → expect → persist。
     *
     * 不能等到提交时才读 rescuedSeqRef.current：这两行之间有
     * `await acquireSessionLockDetailed` / `await refreshSessions` / `await getSession`，
     * 期间 watch/adopt 完全可能把当前意图从 1 升级到 15（seq 推进）。
     * 那样“提交 1 成功”就会错误确认 15 那一版，把它删掉。
     */
    const pending = unsavedDraft.current;
    const pendingSeq = rescuedSeqRef.current;
    if (!pending) {
      pushToast('当前没有待保存的改动。');
      return;
    }
    /**
     * V6-02：忙状态覆盖整个提交期间。
     * 旧实现入队后就 pushToast('已保存')并结束 retrying，
     * 事务 abort 时已发出成功提示。现在等 applyPendingDraft 拿到真实结果。
     * 并用 submittingRef 防止同份草稿在提交中被重复触发（含"放弃"竞争）。
     */
    // 与接管共用同一忙状态：任一方在提交时，另一方不得进入
    if (!beginBusy('retry')) return;
    try {
      const acq = await acquireSessionLockDetailed(sessionId, editorId.current);
      if (!acq.ok) {
        setLockBlocked(true);
        setLockLostReason(
          acq.reason === 'held-by-other'
            ? '这个训练仍被另一个标签页编辑。请先在那个标签页停止操作，约 20 秒后此处可接管。'
            : (acq.message ?? '仍未能取得编辑锁'),
        );
        pushToast('仍然没有编辑控制，改动继续保留在本页。', 'error');
        return;
      }
      await refreshSessions();
      const fresh = await getSession(sessionId);
      if (!fresh) {
        pushToast('读不到最新记录，改动继续保留在本页。', 'error');
        return;
      }
      // 只把「可写」状态落到 UI；保存用显式 ctx，不依赖闭包
      syncSessionLocal(fresh);
      setLockBlocked(false);
      setLockLostReason(null);
      setSaveState('idle');

      // V6-02：等真实提交结果；只有 saved 才提示成功
      // A06：pendingSeq 来自入口处的同步快照，不在这里重新读 ref
      const outcome = await applyPendingDraft(pending, fresh, pendingSeq);
      if (outcome.kind === 'saved') {
        /**
         * A06：本次提交成功 ≠ 全部意图落库。
         * 若提交期间又接住了更新的版本（pending 仍存在），
         * 不能笼统说“已保存本页改动”，否则用户会以为没有遗留改动。
         */
        if (unsavedDraft.current) {
          pushToast('这一版已保存，仍有更新改动待保存。');
        } else {
          pushToast('已保存本页改动。');
        }
      } else if (outcome.kind === 'conflict') {
        // 冲突说明已由 applyPendingDraft 发出，草稿仍保留
      } else {
        pushToast(`这些改动没有保存成功：${outcome.message}。草稿仍保留在本页。`, 'error');
      }
    } catch (err) {
      pushToast(err instanceof Error ? `重试失败：${err.message}` : '重试失败', 'error');
    } finally {
      endBusy('retry');
    }
  }, [sessionId, refreshSessions, syncSessionLocal, applyPendingDraft, pushToast, beginBusy, endBusy]);

  /**
   * 「上次表现」（V3-05 + V4-04 A）。
   * · 键 = 动作身份 + 计量口径：负重 +20kg 与辅助 70kg 不再互相冒充；
   * · 递减组按「N 个完整大组 / M 阶段」表述，不把扁平阶段行叫成组（审查最后一条）；
   * · V4-04 A：同一次训练里同键的**所有**片段必须聚合。
   *   训练中把剩余未开始的组转成递减组，会在同一次训练里留下两个合法 SessionExercise
   *   （同 exerciseId + 同计量口径）。旧实现 `map.has(key) continue` 只收第一个片段，
   *   于是「普通 1 组 + 递减 2 轮 × 3 阶段」只显示「1 组」，全部递减阶段被漏掉。
   *   现在按 session 聚合同键片段后再描述（describeMovementPerformance）。
   * · 只取**最近一次**训练（同键），不跨训练合并；
   * · 数据来自历史快照，不读计划当前值。
   */
  const lastByExercise = useMemo(() => {
    const map = new Map<string, { date: number; summary: string; label: string | null }>();
    if (!session) return map;
    const finished = sessions
      .filter((s) => s.status === 'completed' && s.id !== session.id && s.endedAt)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const s of finished) {
      // 本次训练内先按「动作身份 + 计量口径」分组，同键多片段稍后聚合成一条摘要
      const groups = new Map<
        string,
        {
          exerciseId: string;
          mode: { weightMode: WeightMode; dumbbellBasis: DumbbellBasis };
          ex: SessionExercise;
        }
      >();
      for (const ex of s.exercises) {
        // 动作身份（exerciseId）保证胸 A / 胸 B 互相对照；再叠加计量口径
        const key = comparabilityOf(ex);
        // 已有更近的训练占用这个键 → 本次不再覆盖（只取最近一次）
        if (map.has(key) || groups.has(key)) continue;
        const doneSets = ex.sets.filter((st) => st.status === 'done' && hasReps(st));
        if (!doneSets.length) continue;
        groups.set(key, { exerciseId: ex.exerciseId ?? ex.name, mode: modeOf(ex), ex });
      }
      for (const [key, g] of groups) {
        // 把这次训练里同键的全部片段聚合（不合并片段自己的 roundIndex）
        const perf = collectMovementFragments(s, g.exerciseId, g.mode);
        if (!perf) continue;
        map.set(key, {
          date: s.endedAt ?? s.startedAt,
          summary: describeMovementPerformance(perf),
          label: describeMode(g.ex),
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
    // 已结束的训练不再走结束流程（数据层幂等的第一道）
    if (session.status !== 'active') return;
    if (finishGuard.current) return;
    finishGuard.current = true;
    setFinishing(true);
    try {
      // R07：先排空保存队列，避免「结束」与「最后一次改动」互相覆盖
      await saveQueue.current;

      /**
       * V3-01：
       * · 只提交「终态意图」和 endedAt，实际数据由存储层从事务内最新记录取；
       * · 计划推进由存储层在事务内用最新计划计算，这里不再传整份 plan 快照
       *   （旧实现把 UI 预算的 cursor 写回去，重试时会把游标推第二次）；
       * · 已结束记录返回原结果（alreadyTerminal），不再写、不再推进。
       */
      const ended: Session = {
        ...session,
        revision: confirmedRevision.current,
        status: 'completed',
        endedAt: Date.now(),
        advancedCycle: effectiveAdvance,
      };

      const result = await finishTrainingSession(ended, {
        editorId: editorId.current,
        expectedRevision: confirmedRevision.current,
        advanceCycle: effectiveAdvance,
        lockPolicy: 'required',
      });

      if (!result.ok) {
        finishGuard.current = false;
        if (result.reason === 'lock-lost' || result.reason === 'no-lock' || result.reason === 'corrupt-lock') {
          setLockBlocked(true);
          setLockLostReason(result.message);
        }
        // 结束失败不清空任何已记录内容，提示可重试
        pushToast(`${result.message}（可以重试）`, 'error');
        return;
      }

      intentionallyClosed.current = true;
      confirmedRevision.current = result.revision;
      await refreshSessions();
      await refreshPlans();
      setSummaryOpen(false);
      navigate(`/history/${session.id}`, true);
    } catch (err) {
      // 任何异常都要释放 guard，允许重试
      finishGuard.current = false;
      pushToast(err instanceof Error ? `结束失败：${err.message}，可重试` : '结束失败，可重试', 'error');
    } finally {
      setFinishing(false);
    }
  }

  /**
   * 页面内「返回」按钮的离页入口（与 Android 原生返回键**共用同一条守卫路径**）。
   *
   * 审查要求：Session 顶部返回按钮与原生 Back 都必须验证。
   * 这里不直接 back()：先走 handleBackIntent()，让它
   *   ① 关最上层弹层 / 收键盘（如果还开着）；
   *   ② await 页面离开守卫（排空保存队列 / 救援 pending 草稿）；
   *   ③ 守卫放行后才由那一处唯一的导航点离开。
   * 这样按钮与系统返回键不可能出现两套语义。
   */
  async function requestLeave(_source: string) {
    const outcome = await handleBackIntent();
    // 被守卫拦下时，outcome.action === 'blocked'，页面保持不动（提示已由守卫给出）
    if (outcome.action === 'exit') {
      // 首页之外理论上不会到这里；若真无路可退则回首页
      navigate('/', true);
    }
  }

  async function discard() {
    if (!session) return;
    const ended: Session = { ...session, revision: confirmedRevision.current, status: 'discarded', endedAt: Date.now() };
    try {
      const r = await discardTrainingSession(ended, {
        editorId: editorId.current,
        expectedRevision: confirmedRevision.current,
      });
      if (!r.ok) {
        if (r.reason === 'lock-lost' || r.reason === 'no-lock' || r.reason === 'corrupt-lock') {
          setLockBlocked(true);
          setLockLostReason(r.message);
        }
        pushToast(r.message, 'error');
        return;
      }
      intentionallyClosed.current = true;
      confirmedRevision.current = r.revision;
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
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void requestLeave('header-back')}
          aria-label="返回"
        >
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
          onClick={() => {
            if (inputPaused) {
              pausedNotice();
              return;
            }
            setSummaryOpen(true);
          }}
          disabled={lockBlocked}
          title={
            lockBlocked
              ? '正在另一个标签页中编辑'
              : inputPaused
                ? '请先处理未保存的改动或取得编辑控制'
                : undefined
          }
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
            lineHeight: 1.65,
          }}
        >
          <strong>本页只读，暂时不能记录。</strong>
          {lockLostReason ?? '这个训练正在另一个标签页中编辑。'}
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-2)' }}>
            为避免互相覆盖，本页不写入任何改动，<strong>次数/重量/完成/备注/热身等输入已停用</strong>
            （不会出现"看似能打字、实际没保存"）。可以在原标签页继续，或在这里接管（接管后原标签页会转入只读）。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={isCommittedBusy}
              onClick={() => void tryTakeOver()}
            >
              {busyOwner === 'takeover' ? '正在接管…' : '接管继续编辑'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={isCommittedBusy}
              onClick={() => void retryUnsaved()}
            >
              {busyOwner === 'retry' ? '正在重试…' : '重试保存这次改动'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => void refreshSessions()}>
              刷新数据看看
            </button>
          </div>
          {saveState === 'error' ? (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
              最近一次改动<strong>还没有写进本机</strong>，仍保留在本页内存中。
              取得编辑控制后点「重试保存这次改动」，或先记下来再刷新。
            </div>
          ) : null}


        </div>
      ) : null}

      {/*
        V5-01：待存草稿的常驻入口。
        不受 lockBlocked 影响 —— 只读解除后草稿仍在，必须仍然能重试。
        也不在冲突时消失（冲突时按钮会重新给出拒绝提示，草稿保留）。
      */}
      {hasPendingDraft ? (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--brick)',
            lineHeight: 1.65,
          }}
        >
          <strong>还有改动没有写进本机。</strong>
          <span style={{ color: 'var(--ink-2)' }}>
            {' '}
            这份内容仍保留在本页；确认后可以重试保存。若另一页也改过同一处，会提示冲突而不会覆盖它。
          </span>
          {/*
            V6-01：冲突明细必须**持续可见**。
            旧位置在 lockBlocked 横幅内，而 retry 会把 lockBlocked 置 false，
            于是"草稿仍在但看不到为什么没保存"。现在挂在常驻横幅上。
          */}
          {draftConflicts ? (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                background: 'var(--paper)',
                borderLeft: '3px solid var(--brick)',
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              <strong>本页草稿与另一个页面冲突，未覆盖任何数据。</strong>
              <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>
                另一页也改过下面这些内容，所以本页没有整份保存。草稿仍保留在本页：
              </div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {draftConflicts.slice(0, 6).map((c) => (
                  <li key={c.path} style={{ marginBottom: 2 }}>
                    {c.path}：{c.message}
                  </li>
                ))}
              </ul>
              {draftConflicts.length > 6 ? (
                <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>还有 {draftConflicts.length - 6} 处…</div>
              ) : null}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={isCommittedBusy}
              onClick={() => void retryUnsaved()}
            >
              {busyOwner === 'retry' ? '正在保存…' : '重试保存这次改动'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={isCommittedBusy}
              onClick={() => discardPendingDraft()}
            >
              放弃这份改动
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }}>
            处理完这份改动后才能继续记录（次数、重量、加删组、备注、热身与结束训练都已暂停）。
          </div>
        </div>
      ) : null}

      {conflictMessage ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--brick)',
            lineHeight: 1.65,
          }}
        >
          {conflictMessage}
          <div style={{ marginTop: 8 }}>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setConflictMessage(null);
                void refreshSessions();
              }}
            >
              刷新到最新数据
            </button>
          </div>
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
                  disabled={inputPaused}
                  onChange={(e) => {
                    if (inputPaused) return;
                    applyChange((prev) => ({
                      ...prev,
                      warmups: prev.warmups.map((x) => (x.id === w.id ? { ...x, done: e.target.checked } : x)),
                    }));
                  }}
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
              lastPerformance={
                lastByExercise.get(comparabilityOf(ex)) ??
                // 兼容：旧数据可能没有口径字段，退回同动作任意口径的最近一次
                [...lastByExercise.entries()].find(([k]) => k.startsWith(`${ex.exerciseId}::`))?.[1] ??
                null
              }
              apply={applyChange}
              latestRef={latestRef}
              timer={timer}
              onOpenTools={() => setToolsFor(ex.id)}
              onRequestRemoveRound={(id) => {
                pendingRemoveRound.current = id;
                setConfirmRemoveRoundOpen(true);
              }}
              pushToast={pushToast}
              recordingPaused={inputPaused}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          onClick={() => {
            if (inputPaused) {
              pausedNotice();
              return;
            }
            setPicker({ mode: 'add' });
            setAddQuery('');
          }}
          disabled={inputPaused}
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
          onClick={() => {
            if (inputPaused) {
              pausedNotice();
              return;
            }
            setSummaryOpen(true);
          }}
          disabled={lockBlocked || finishing}
        >
          {lockBlocked ? '本页只读 · 请在原标签页继续' : finishing ? '正在结束…' : `结束训练 · ${summary.completedSets} 组`}
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
                // C01 路径 B：训练中调整训练形式（只影响本次）
                setConvertFor(toolsEx.id);
                // V3-05：从普通组转递减时要保留负重模式与哑铃单只/合计
                setConvertDraft(
                  toolsEx.target.kind === 'dropSet'
                    ? dropTargetToDraft(toolsEx.target)
                    : straightToDropDraft(toolsEx.target),
                );
                setConvertForm(toolsEx.target.kind === 'dropSet' ? 'dropSet' : 'straight');
                // 组数初值：递减组按轮数，普通组按组数（用户可改，且会被真正使用）
                setConvertStraightSets(
                  toolsEx.target.kind === 'dropSet' ? toolsEx.target.rounds : toolsEx.target.sets,
                );
                setConvertError(null);
                convertFormApi.resetAll();
                setToolsFor(null);
              }}
            >
              调整训练形式（普通组 / 递减组）
            </button>
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
                  // V3-06：用「是否存在有待撤销的 skipped 组」判断，
                  // 不能用 every(skipped)——做完 1 组再跳过剩余时 every 永远为 false，
                  // 菜单会永远显示「跳过剩余组」，取消永远不可达（审查 F-UNSKIP）。
                  const canUnskip = cur ? hasSkippedGroupsToUnskip(cur) : false;
                  return canUnskip ? unskipExercise(prev, toolsEx.id) : skipRemaining(prev, toolsEx.id);
                });
                setToolsFor(null);
              }}
            >
              {hasSkippedGroupsToUnskip(toolsEx) ? '取消跳过剩余组' : '跳过剩余组'}
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
                  const targetId = toolsEx.id;
                  const prevName = toolsEx.replacedFrom!;
                  applyChange((prev) => {
                    const r = replaceExerciseInSession(prev, targetId, prevName);
                    if (!r.replaced) {
                      pushToast(r.message, 'error');
                      return prev;
                    }
                    pushToast(r.message);
                    return r.session;
                  });
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
                  const targetId = intent.sessionExerciseId;
                  applyChange((prev) => {
                    const r = replaceExerciseInSession(prev, targetId, lib.name);
                    if (!r.replaced) {
                      pushToast(r.message, 'error');
                      return prev;
                    }
                    pushToast(r.message);
                    return r.session;
                  });
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
                const targetId = intent.sessionExerciseId;
                applyChange((prev) => {
                  const r = replaceExerciseInSession(prev, targetId, name);
                  if (!r.replaced) {
                    pushToast(r.message, 'error');
                    return prev;
                  }
                  pushToast(r.message);
                  return r.session;
                });
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

      {/* C01 路径 B：训练中调整训练形式（只影响本次训练） */}
      <Sheet
        open={!!convertFor}
        title="调整训练形式"
        onClose={() => setConvertFor(null)}
        autoFocusPanel={false}
      >
        {convertFor ? (
          (() => {
            const target = session.exercises.find((e) => e.id === convertFor);
            if (!target) return null;
            const hasRecord = roundsOf(target).some((r) => !groupHasNoRecords(target, r));
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="segmented" role="group" aria-label="训练形式">
                  <button aria-pressed={convertForm === 'straight'} onClick={() => setConvertForm('straight')}>
                    普通组
                  </button>
                  <button aria-pressed={convertForm === 'dropSet'} onClick={() => setConvertForm('dropSet')}>
                    递减组
                  </button>
                </div>

                {hasRecord ? (
                  <div
                    style={{
                      padding: '8px 10px',
                      background: 'var(--paper-3)',
                      borderLeft: '3px solid var(--warn)',
                      fontSize: 12.5,
                      lineHeight: 1.6,
                    }}
                  >
                    这个动作已经有记录。转换只作用于**未开始**的组/轮，已记录的数据会保留。
                  </div>
                ) : null}

                {convertForm === 'dropSet' ? (
                  <DropSetEditor
                    draft={convertDraft}
                    onChange={setConvertDraft}
                    form={convertFormApi}
                    fieldPrefix="convert"
                  />
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
                    <DraftNumberField
                      label="组数"
                      value={convertStraightSets}
                      min={1}
                      max={MAX_STRAIGHT_SETS}
                      form={convertFormApi}
                      fieldId="convert.sets"
                      onCommit={(v) => setConvertStraightSets(v)}
                    />
                  </div>
                )}

                {convertError ? (
                  <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, lineHeight: 1.6 }}>
                    {convertError}
                  </div>
                ) : null}

                <button
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                  onClick={() => {
                    /**
                     * V4-03（修复 F4-I03）：flushAll 返回 values 之后，
                     * **必须用 values 同步构造 nextDraft 局部变量**，不能继续读
                     * convertDraft / convertStraightSets 这两个父 state ——
                     * 「文本已是 5、state 还是 3」时那会存成 3。
                     */
                    const flushed = convertFormApi.flushAll();
                    if (!flushed.ok) {
                      setConvertError(`有字段还不合法：${Object.values(flushed.errors)[0]}`);
                      return;
                    }
                    const nextDraft = mergeFlushedDropDraft(convertDraft, flushed.values, 'convert');
                    const nextSets = mergeFlushedValues({ sets: convertStraightSets }, flushed.values, {
                      sets: 'convert.sets',
                    }).sets;
                    if (convertForm === 'dropSet') {
                      const found = validateDropDraft(nextDraft);
                      if (found.length) {
                        setConvertError(`递减组配置还有 ${found.length} 处需要修正：${found[0].message}`);
                        return;
                      }
                    } else if (!Number.isInteger(nextSets) || nextSets < 1 || nextSets > MAX_STRAIGHT_SETS) {
                      setConvertError(`组数必须是 1–${MAX_STRAIGHT_SETS} 的整数`);
                      return;
                    }
                    setConvertError(null);
                    const id = convertFor;
                    if (convertForm === 'dropSet') {
                      applyChange((prev) => {
                        const r = convertExerciseToDropSet(prev, id, draftToDropTarget(nextDraft));
                        if (!r.converted) {
                          pushToast(r.message, 'error');
                          return prev;
                        }
                        pushToast(r.message);
                        return r.session;
                      });
                    } else {
                      applyChange((prev) => {
                        const cur = prev.exercises.find((e) => e.id === id);
                        if (!cur) return prev;
                        /**
                         * V3-04：组数用用户输入（nextSets，来自 flush 的当前文本草稿），
                         * 不再从旧 target 取。
                         * V3-05：计量口径原样保留 —— weightMode / dumbbellBasis /
                         * suggestedWeightKg 都从当前目标继承，不擅自改成 external。
                         */
                        const base = cur.target;
                        const firstStage = base.kind === 'dropSet' ? base.stages[0] : undefined;
                        const straight = {
                          kind: 'straight' as const,
                          sets: nextSets,
                          setsMax: nextSets,
                          repsMin: base.kind === 'dropSet' ? (firstStage?.repsMin ?? 8) : base.repsMin,
                          repsMax: base.kind === 'dropSet' ? (firstStage?.repsMax ?? 12) : base.repsMax,
                          weightMode: base.weightMode,
                          dumbbellBasis: base.dumbbellBasis,
                          suggestedWeightKg:
                            base.kind === 'dropSet' ? (firstStage?.weightKg ?? null) : base.suggestedWeightKg,
                        };
                        const r = convertExerciseToStraight(prev, id, straight);
                        if (!r.converted) {
                          pushToast(r.message, 'error');
                          return prev;
                        }
                        pushToast(r.message);
                        return r.session;
                      });
                    }
                    setConvertFor(null);
                  }}
                >
                  {convertForm === 'dropSet' ? '应用递减组' : '应用普通组'}
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%' }}
                  onClick={() => {
                    // 取消：清草稿与错误，重新进入不残留 disabled
                    convertFormApi.resetAll();
                    setConvertError(null);
                    setConvertFor(null);
                  }}
                >
                  取消
                </button>
              </div>
            );
          })()
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
            <button className="btn btn-primary btn-lg" disabled={finishing} onClick={() => void finish()}>
              {finishing ? '正在结束…' : '确认结束并保存'}
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
