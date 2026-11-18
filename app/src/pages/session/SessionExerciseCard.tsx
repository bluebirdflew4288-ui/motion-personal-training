/* 训练执行页单动作卡片与逐组记录行（Wave 1C.1 拆分 + Wave 1C.2 React.memo 细粒度重渲染隔离）。
   ── 隔离机制 ────────────────────────────────────────────────────
   · 回调全部参数化为稳定引用（以 ex.id 调用），不再每次父层渲染都生成新闭包；
   · `areExerciseCardPropsEqual` 在 IndexedDB 事务返回全新反序列化 Session 克隆后，
     对未变动的兄弟动作做 O(sets) 值比对，确保录入第 1 个动作时其余 7 张动作卡 0 次重渲染。 */

import { memo, useCallback, useState } from 'react';
import type { RefObject } from 'react';
import { resolveGroupConfig } from '../../domain/exerciseConfig';
import {
  addSetBlocker,
  addSetTo,
  describeTarget,
  dropRoundComplete,
  dropRoundSets,
  exerciseCompletion,
  hasReps,
  inheritPreviousCompleteRound,
  inheritPreviousCompleteRoundForExercise,
  isSetIncomplete,
  isSetLogged,
  lastRoundHasRecords,
  needsWeight,
  removeLastRound,
  removeSetFrom,
  requiredStages,
  restAfterSet,
  roundsOf,
  skipRemaining,
  skippedGroupCount,
  withExercise,
  withSet,
  withSetAndPrefillFollowingWeight,
} from '../../domain/session';
import type { Session, SessionExercise, SessionSet } from '../../domain/types';
import { fmtDate, fmtRest } from '../../lib/format';
import type { CardDragSnapshot } from '../../ui/cardDrag';
import type { useRestTimer } from '../../ui/RestTimer';
import { NumberStepper } from '../../ui/Stepper';
import { SwipeActionCard } from '../../ui/SwipeActionCard';

/** 递减组阶段的重量提示 */
const dropWeightNote = (basis: 'per_hand' | 'total' | undefined): string | undefined =>
  basis === 'per_hand' ? '哑铃 · 按单只记录' : basis === 'total' ? '哑铃 · 按合计记录' : undefined;

export interface LastPerformanceSummary {
  date: number;
  summary: string;
  label?: string | null;
}

function SetRow({
  set,
  showWeight,
  onPatch,
  onRemove,
  canRemove,
  timer,
  restSec,
  label,
  source,
  onAutoRest,
  weightUnitNote,
  recordingPaused,
  onRawRisk,
  rawDraftFor,
  onRawDraft,
  onOpenPlateCalc,
  plateCalcTestId,
}: {
  set: SessionSet;
  showWeight: boolean;
  onPatch: (patch: Partial<SessionSet>) => void;
  onRemove: () => void;
  canRemove: boolean;
  timer: ReturnType<typeof useRestTimer>;
  restSec: number;
  label: string;
  source: { sessionExerciseId: string; setId?: string };
  onAutoRest: () => void;
  weightUnitNote?: string;
  recordingPaused?: boolean;
  onRawRisk?: (fieldId: string, risky: boolean) => void;
  rawDraftFor?: (fieldId: string) => string | undefined;
  onRawDraft?: (fieldId: string, raw: string | null) => void;
  onOpenPlateCalc?: () => void;
  plateCalcTestId?: string;
}) {
  const done = set.status === 'done';
  const partial = set.status === 'partial';
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
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => timer.start(restSec, source)}
              aria-label="开始组间休息计时"
            >
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
            onRawRisk={onRawRisk ? (risky) => onRawRisk(`${set.id}:reps`, risky) : undefined}
            rawDraft={rawDraftFor?.(`${set.id}:reps`)}
            onRawDraftChange={onRawDraft ? (raw) => onRawDraft(`${set.id}:reps`, raw) : undefined}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 13, color: 'var(--ink-3)', flex: 'none', width: 30 }}>重量</span>
        {showWeight ? (
          <>
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
                onRawRisk={onRawRisk ? (risky) => onRawRisk(`${set.id}:weight`, risky) : undefined}
                rawDraft={rawDraftFor?.(`${set.id}:weight`)}
                onRawDraftChange={onRawDraft ? (raw) => onRawDraft(`${set.id}:weight`, raw) : undefined}
              />
            </div>
            {onOpenPlateCalc ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid={plateCalcTestId}
                onClick={onOpenPlateCalc}
                aria-label={`${label}杠铃配片速算`}
                style={{ minHeight: 34, padding: '0 8px', fontSize: 12, flex: 'none' }}
              >
                配片
              </button>
            ) : null}
          </>
        ) : (
          <span style={{ fontSize: 12.5, color: 'var(--ink-4)' }}>{weightUnitNote ?? '不记重量'}</span>
        )}
      </div>
    </div>
  );
}

export function areSessionExercisesEqual(a: SessionExercise, b: SessionExercise): boolean {
  if (a === b) return true;
  if (
    a.id !== b.id ||
    a.name !== b.name ||
    a.en !== b.en ||
    a.exerciseId !== b.exerciseId ||
    a.planExerciseId !== b.planExerciseId ||
    a.replacedFrom !== b.replacedFrom ||
    a.added !== b.added ||
    a.restSec !== b.restSec ||
    a.status !== b.status ||
    a.note !== b.note
  ) {
    return false;
  }
  if (a.sets.length !== b.sets.length) return false;
  for (let i = 0; i < a.sets.length; i++) {
    const sa = a.sets[i];
    const sb = b.sets[i];
    if (
      sa !== sb &&
      (sa.id !== sb.id ||
        sa.roundIndex !== sb.roundIndex ||
        sa.stageIndex !== sb.stageIndex ||
        sa.reps !== sb.reps ||
        sa.weightKg !== sb.weightKg ||
        sa.status !== sb.status)
    ) {
      return false;
    }
  }
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) {
    if (
      a.groups[i].index !== b.groups[i].index ||
      a.groups[i].stageCount !== b.groups[i].stageCount
    ) {
      return false;
    }
  }
  if (a.target !== b.target && JSON.stringify(a.target) !== JSON.stringify(b.target)) {
    return false;
  }
  return true;
}

export interface SessionExerciseCardProps {
  ex: SessionExercise;
  index: number;
  expanded: boolean;
  historyHydrated?: boolean;
  onToggle: (exId: string) => void;
  lastPerformance: LastPerformanceSummary | null;
  progressionHint?: string | null;
  onOpenPlateCalc?: (exId: string, weightKg: number | null, setId?: string) => void;
  apply: (fn: (prev: Session) => Session) => unknown;
  latestRef: RefObject<Session | undefined>;
  timer: ReturnType<typeof useRestTimer>;
  onOpenTools: (exId: string) => void;
  onEditExercise: (exId: string) => void;
  onDeleteExercise: (exId: string) => void;
  checkDeleteRequiresConfirm: (exId: string) => boolean;
  onRequestRemoveRound: (exId: string) => void;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
  recordingPaused: boolean;
  onRawRisk?: (exId: string, fieldId: string, risky: boolean) => void;
  onRawDraft?: (exId: string, fieldId: string, raw: string | null) => void;
  rawDraftFor?: (exId: string, fieldId: string) => string | undefined;
  rawResetToken?: number;
  hasRawRisk?: boolean;
  onDiscardRawDraft?: (exId: string) => void;
  reorderIds?: string[];
  drag?: CardDragSnapshot | null;
  onReorderCommit?: (orderedIds: string[], startIds: string[] | null) => void | Promise<unknown>;
  /** 测试探针：仅测试传入以统计单卡真实渲染次数 */
  onRenderCard?: (exId: string) => void;
}

function areLastPerfEqual(
  a: LastPerformanceSummary | null,
  b: LastPerformanceSummary | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.date === b.date && a.summary === b.summary && (a.label ?? null) === (b.label ?? null);
}

function areExerciseCardPropsEqual(
  prev: SessionExerciseCardProps,
  next: SessionExerciseCardProps,
): boolean {
  if (
    prev.index !== next.index ||
    prev.expanded !== next.expanded ||
    (prev.historyHydrated ?? true) !== (next.historyHydrated ?? true) ||
    (prev.progressionHint ?? null) !== (next.progressionHint ?? null) ||
    prev.onOpenPlateCalc !== next.onOpenPlateCalc ||
    prev.recordingPaused !== next.recordingPaused ||
    (prev.rawResetToken ?? 0) !== (next.rawResetToken ?? 0) ||
    Boolean(prev.hasRawRisk) !== Boolean(next.hasRawRisk) ||
    prev.timer !== next.timer ||
    prev.drag !== next.drag ||
    prev.reorderIds !== next.reorderIds ||
    prev.onToggle !== next.onToggle ||
    prev.onOpenTools !== next.onOpenTools ||
    prev.onEditExercise !== next.onEditExercise ||
    prev.onDeleteExercise !== next.onDeleteExercise ||
    prev.checkDeleteRequiresConfirm !== next.checkDeleteRequiresConfirm ||
    prev.onRequestRemoveRound !== next.onRequestRemoveRound ||
    prev.onDiscardRawDraft !== next.onDiscardRawDraft ||
    prev.onReorderCommit !== next.onReorderCommit ||
    prev.apply !== next.apply ||
    prev.pushToast !== next.pushToast ||
    prev.onRawRisk !== next.onRawRisk ||
    prev.onRawDraft !== next.onRawDraft ||
    prev.rawDraftFor !== next.rawDraftFor ||
    prev.onRenderCard !== next.onRenderCard
  ) {
    return false;
  }
  if (!areLastPerfEqual(prev.lastPerformance, next.lastPerformance)) return false;
  return areSessionExercisesEqual(prev.ex, next.ex);
}

export const SessionExerciseCard = memo(function SessionExerciseCard({
  ex,
  index,
  expanded,
  historyHydrated = true,
  onToggle,
  lastPerformance,
  progressionHint,
  onOpenPlateCalc,
  apply,
  latestRef,
  timer,
  onOpenTools,
  onEditExercise,
  onDeleteExercise,
  checkDeleteRequiresConfirm,
  onRequestRemoveRound,
  pushToast,
  recordingPaused,
  onRawRisk,
  onRawDraft,
  rawDraftFor,
  rawResetToken,
  hasRawRisk,
  onDiscardRawDraft,
  reorderIds,
  drag,
  onReorderCommit,
  onRenderCard,
}: SessionExerciseCardProps) {
  onRenderCard?.(ex.id);
  const [noteOpen, setNoteOpen] = useState(false);
  const isDrop = ex.target.kind === 'dropSet';
  const addSetBlock = isDrop ? addSetBlocker(ex) : null;
  const dropTarget = ex.target.kind === 'dropSet' ? ex.target : null;
  const straightTarget = ex.target.kind === 'straight' ? ex.target : null;
  const showWeight = needsWeight(ex);
  const completion = exerciseCompletion(ex);
  const done = completion === 'done';
  const partial = completion === 'partial';
  const skipped = completion === 'skipped';
  const validSets = ex.sets.filter(isSetLogged).length;
  const incompleteSets = ex.sets.filter(isSetIncomplete).length;

  const patchSet = (setId: string, patch: Partial<SessionSet>) =>
    apply((prev) =>
      withSetAndPrefillFollowingWeight(
        prev,
        ex.id,
        setId,
        patch,
        rawDraftFor ? (otherId) => rawDraftFor(ex.id, `${otherId}:weight`) !== undefined : undefined,
      ),
    );

  const handleEdit = useCallback(() => onEditExercise(ex.id), [onEditExercise, ex.id]);
  const handleDelete = useCallback(() => onDeleteExercise(ex.id), [onDeleteExercise, ex.id]);
  const handleCheckConfirm = useCallback(
    () => checkDeleteRequiresConfirm(ex.id),
    [checkDeleteRequiresConfirm, ex.id],
  );
  const handleToggle = useCallback(() => onToggle(ex.id), [onToggle, ex.id]);
  const handleOpenTools = useCallback(() => onOpenTools(ex.id), [onOpenTools, ex.id]);
  const handleDiscardRaw = useCallback(() => onDiscardRawDraft?.(ex.id), [onDiscardRawDraft, ex.id]);

  return (
    <SwipeActionCard
      testId={`exercise-card-${ex.id}`}
      onEdit={handleEdit}
      onDelete={handleDelete}
      deleteRequiresConfirm={handleCheckConfirm}
      disabled={recordingPaused}
      locked={expanded}
      reorderId={ex.id}
      reorderKind="strength"
      reorderIndex={index}
      reorderIds={reorderIds}
      drag={drag}
      onReorderCommit={onReorderCommit}
    >
      <section
        className="slip"
        style={{
          opacity: skipped ? 0.62 : 1,
          borderColor: done ? 'var(--brick)' : 'var(--rule)',
        }}
      >
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
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 3, lineHeight: 1.5 }}>
                {describeTarget({ id: ex.id, name: ex.name, restSec: ex.restSec, target: ex.target })}
                <span style={{ color: 'var(--ink-4)' }}> · 休息 {fmtRest(ex.restSec)}</span>
                {progressionHint ? (
                  <span
                    data-testid={`progression-hint-${ex.id}`}
                    style={{
                      display: 'inline-block',
                      marginLeft: 6,
                      padding: '0 6px',
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: 'var(--ink)',
                      background: 'var(--paper-3)',
                      border: '1px solid var(--rule-strong)',
                    }}
                  >
                    {progressionHint}
                  </span>
                ) : null}
              </div>
              {dropTarget ? (
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
                  {dropTarget.roundConfigs?.length ? (
                    roundsOf(ex).map((round) => {
                      const need = requiredStages(ex, round);
                      const parts = Array.from({ length: need }, (_, i) => {
                        const r = resolveGroupConfig(dropTarget, round, i + 1);
                        const reps =
                          r.repsMin === null && r.repsMax === null
                            ? '参考次数未设'
                            : `${r.repsMin}–${r.repsMax} 次`;
                        return `${r.label ?? `阶段${i + 1}`} ${r.weightKg !== null ? `${r.weightKg}kg · ` : ''}${r.toFailure ? '力竭' : reps}`;
                      });
                      return (
                        <span key={`round-${round}`} style={{ overflowWrap: 'anywhere' }}>
                          第 {round} 轮（{need} 阶段）：{parts.join(' / ')}
                        </span>
                      );
                    })
                  ) : (
                    dropTarget.stages.map((st, i) => {
                      const r = resolveGroupConfig(dropTarget, 1, i + 1);
                      const reps =
                        r.repsMin === null && r.repsMax === null
                          ? '参考次数未设'
                          : `${r.repsMin}–${r.repsMax} 次`;
                      return (
                        <span key={`${st.label}-${i}`} style={{ overflowWrap: 'anywhere' }}>
                          {st.label}：{r.weightKg !== null ? `${r.weightKg} kg · ` : ''}
                          {r.toFailure ? '力竭' : reps}
                        </span>
                      );
                    })
                  )}
                  <span style={{ color: 'var(--ink-4)' }}>
                    阶段间歇{' '}
                    {(() => {
                      const shortRests = dropTarget.roundConfigs?.length
                        ? Array.from({ length: requiredStages(ex, 1) }, (_, i) =>
                            resolveGroupConfig(dropTarget, 1, i + 1),
                          )
                            .slice(0, -1)
                            .map((r) => fmtRest(r.restAfterSec ?? dropTarget.restInSec))
                        : dropTarget.stages
                            .slice(0, -1)
                            .map((_, i) =>
                              fmtRest(
                                resolveGroupConfig(dropTarget, 1, i + 1).restAfterSec ??
                                  dropTarget.restInSec,
                              ),
                            );
                      return shortRests.length ? shortRests.join(' / ') : '无';
                    })()}{' '}
                    · 整轮休息 {fmtRest(dropTarget.restAfterSec)} · {dropTarget.rounds} 轮 ={' '}
                    {dropTarget.rounds} 个正式大组
                  </span>
                </div>
              ) : straightTarget?.perSetConfigs?.length ? (
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
                  {straightTarget.perSetConfigs
                    .slice()
                    .sort((a, b) => a.setIndex - b.setIndex)
                    .map((c) => {
                      const r = resolveGroupConfig(straightTarget, c.setIndex, 1);
                      const reps =
                        r.repsMin === null && r.repsMax === null
                          ? '参考次数未设'
                          : `${r.repsMin}–${r.repsMax} 次`;
                      return (
                        <span key={c.setIndex} style={{ overflowWrap: 'anywhere' }}>
                          第 {c.setIndex} 组：{r.weightKg !== null ? `${r.weightKg} kg · ` : ''}
                          {r.toFailure ? '力竭' : reps}
                        </span>
                      );
                    })}
                </div>
              ) : null}

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
                ) : !historyHydrated ? (
                  '正在读取历史…'
                ) : (
                  '暂无历史记录'
                )}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 'none' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleToggle}
                aria-expanded={expanded}
                style={{ minWidth: 58, minHeight: 38 }}
              >
                {expanded ? '收起' : '记录'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                data-testid={`session-ex-edit-${ex.id}`}
                disabled={recordingPaused}
                onClick={handleEdit}
                aria-label={`编辑${ex.name}配置`}
                style={{
                  minWidth: 58,
                  minHeight: 36,
                  padding: '0 8px',
                  border: '1px solid var(--ink-3)',
                  background: 'var(--paper-2)',
                  color: 'var(--ink)',
                  fontWeight: 600,
                }}
              >
                编辑
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={recordingPaused}
                onClick={handleOpenTools}
                aria-label={`${ex.name} 更多操作`}
                style={{ minWidth: 58, minHeight: 36 }}
              >
                工具
              </button>
            </div>
          </div>
        </div>

        {expanded ? (
          <div style={{ padding: '0 14px 12px' }}>
            {hasRawRisk ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginTop: 8,
                  padding: '8px 10px',
                  background: 'var(--paper-3)',
                  borderLeft: '3px solid var(--warn)',
                }}
              >
                <span style={{ fontSize: 12, lineHeight: 1.5 }}>
                  有未完成输入；放弃只清除未完成文本，已记录的数据会保留。
                </span>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={recordingPaused}
                  onClick={handleDiscardRaw}
                  style={{ minHeight: 40, flex: 'none' }}
                >
                  放弃未完成输入
                </button>
              </div>
            ) : null}
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
                          key={`${set.id}:${rawResetToken ?? 0}`}
                          set={set}
                          showWeight={showWeight}
                          label={
                            resolveGroupConfig(dropTarget!, set.roundIndex, set.stageIndex).label ??
                            `阶段 ${set.stageIndex}`
                          }
                          restSec={restAfterSet(ex, set)}
                          timer={timer}
                          source={{ sessionExerciseId: ex.id, setId: set.id }}
                          canRemove={false}
                          onAutoRest={() => {
                            timer.start(restAfterSet(ex, set), {
                              sessionExerciseId: ex.id,
                              setId: set.id,
                            });
                          }}
                          onPatch={(p) => patchSet(set.id, p)}
                          onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                          weightUnitNote={dropWeightNote(ex.target.dumbbellBasis)}
                          recordingPaused={recordingPaused}
                          onRawRisk={onRawRisk ? (fid, r) => onRawRisk(ex.id, fid, r) : undefined}
                          rawDraftFor={rawDraftFor ? (fid) => rawDraftFor(ex.id, fid) : undefined}
                          onRawDraft={onRawDraft ? (fid, raw) => onRawDraft(ex.id, fid, raw) : undefined}
                          onOpenPlateCalc={
                            onOpenPlateCalc && ex.target.weightMode === 'external'
                              ? () =>
                                  onOpenPlateCalc(
                                    ex.id,
                                    set.weightKg ??
                                      resolveGroupConfig(dropTarget!, set.roundIndex, set.stageIndex).weightKg,
                                    set.id,
                                  )
                              : undefined
                          }
                          plateCalcTestId={
                            round === 1 && set.stageIndex === 1 ? `plate-calc-btn-${ex.id}` : undefined
                          }
                        />
                      ))}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ minHeight: 40 }}
                    disabled={recordingPaused || Boolean(addSetBlock)}
                    title={addSetBlock?.message}
                    aria-describedby={addSetBlock ? `add-set-block-${ex.id}` : undefined}
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
                        const cur = prev.exercises.find((e) => e.id === ex.id);
                        if (!cur) return prev;
                        const targetRound = roundsOf(cur).find((r) => !dropRoundComplete(cur, r));
                        if (targetRound === undefined) return prev;
                        let next = prev;
                        for (const st of dropRoundSets(cur, targetRound)) {
                          next = withSet(next, ex.id, st.id, { status: 'done' });
                        }
                        return next;
                      })
                    }
                  >
                    本轮全部标记完成
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={recordingPaused || Boolean(hasRawRisk)}
                    onClick={() => {
                      if (recordingPaused) return;
                      if (hasRawRisk) {
                        pushToast('有未提交输入，请先确认或放弃后再沿用上一轮。', 'error');
                        return;
                      }
                      const cur = latestRef.current?.exercises.find((e) => e.id === ex.id);
                      if (!cur) return;
                      const preview = inheritPreviousCompleteRoundForExercise(cur);
                      const skipNotes: string[] = [];
                      if (preview.mismatchRounds.length) {
                        skipNotes.push(
                          `第 ${preview.mismatchRounds.join('、')} 轮阶段身份或结构无法可靠对应（保持空白）`,
                        );
                      }
                      if (preview.noSourceRounds.length) {
                        skipNotes.push(`第 ${preview.noSourceRounds.join('、')} 轮无完整来源`);
                      }
                      if (preview.unmatchedStages > 0) {
                        skipNotes.push(`有 ${preview.unmatchedStages} 个目标阶段无可靠来源，保持空白`);
                      }
                      const skipText = skipNotes.length ? `${skipNotes.join('；')}。` : '';
                      if (preview.filledFields === 0) {
                        if (skipText) {
                          pushToast(`${skipText}请手动填写。`, 'error');
                        } else {
                          pushToast('未完成的轮里没有空白字段需要沿用（已填内容已保留）。', 'info');
                        }
                        return;
                      }
                      apply((prev) => inheritPreviousCompleteRound(prev, ex.id).session);
                      pushToast(
                        `已按阶段沿用上一完整轮：补 ${preview.filledFields} 个空白字段，保留已填内容。` +
                          (skipText ? ` 另有：${skipText}` : ''),
                        skipNotes.length ? 'info' : 'ok',
                      );
                    }}
                    style={{ minHeight: 40 }}
                  >
                    未完成轮沿用上一完整轮
                  </button>
                </div>
                {addSetBlock ? (
                  <div
                    id={`add-set-block-${ex.id}`}
                    role="status"
                    data-testid="add-round-blocked"
                    style={{ marginTop: 6, color: 'var(--brick)', fontSize: 12.5, lineHeight: 1.6 }}
                  >
                    不能再加一轮：{addSetBlock.message}
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                {ex.sets.map((set) => (
                  <SetRow
                    key={`${set.id}:${rawResetToken ?? 0}`}
                    set={set}
                    showWeight={showWeight}
                    label={`第 ${set.roundIndex} 组`}
                    restSec={restAfterSet(ex, set)}
                    timer={timer}
                    source={{ sessionExerciseId: ex.id, setId: set.id }}
                    canRemove={ex.sets.length > 1}
                    onAutoRest={() =>
                      timer.start(restAfterSet(ex, set), {
                        sessionExerciseId: ex.id,
                        setId: set.id,
                      })
                    }
                    onPatch={(p) => patchSet(set.id, p)}
                    onRemove={() => apply((prev) => removeSetFrom(prev, ex.id, set.id))}
                    recordingPaused={recordingPaused}
                    onRawRisk={onRawRisk ? (fid, r) => onRawRisk(ex.id, fid, r) : undefined}
                    rawDraftFor={rawDraftFor ? (fid) => rawDraftFor(ex.id, fid) : undefined}
                    onRawDraft={onRawDraft ? (fid, raw) => onRawDraft(ex.id, fid, raw) : undefined}
                    onOpenPlateCalc={
                      onOpenPlateCalc && ex.target.weightMode === 'external'
                        ? () =>
                            onOpenPlateCalc(
                              ex.id,
                              set.weightKg ?? straightTarget?.suggestedWeightKg ?? null,
                              set.id,
                            )
                        : undefined
                    }
                    plateCalcTestId={set.roundIndex === 1 ? `plate-calc-btn-${ex.id}` : undefined}
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
                      const cur = latestRef.current?.exercises.find((e) => e.id === ex.id);
                      const source = cur
                        ? [...cur.sets].reverse().find((st) => hasReps(st) || st.weightKg !== null)
                        : undefined;
                      if (!source) {
                        pushToast('这一动作还没有填写过数值，无法沿用。');
                        return;
                      }
                      apply((prev) => {
                        const c = prev.exercises.find((e) => e.id === ex.id);
                        if (!c) return prev;
                        let next = prev;
                        for (const st of c.sets) {
                          if (st.status === 'done') continue;
                          next = withSet(next, ex.id, st.id, {
                            reps: source.reps,
                            weightKg: source.weightKg,
                          });
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
    </SwipeActionCard>
  );
}, areExerciseCardPropsEqual);
