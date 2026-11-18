/* 训练日详情与动作编排页（Wave 2A 升级版）：
   · 接入新一代统一动作编辑器 ExerciseEditor（支持普通组逐组独立配置 / 力竭 / 超级组 / 递减组逐轮覆盖 / 4 种负重口径）；
   · 接入 ExerciseNamePicker（支持拼音首字母、俗称别名检索与记忆模板一键带入）；
   · 保存动作时支持在同一笔 ['plans', 'meta'] IndexedDB 事务内原子写入 ExerciseTemplate 记忆；
   · 动作卡片接入 SwipeActionCard：长按 340ms 触感起浮拖拽排序 + 松手零残影落位 + 左滑蓝编/红删粒子消散 + 8 秒底部撤销栈；
   · 完整保留行内快捷控件与多字段草稿离页门禁（100% 兼容 B4R2 与 W02 回归契约）。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { navigate, registerLeaveGuard } from '../../lib/router';
import { Sheet } from '../../ui/Sheet';
import { Confirm } from '../../ui/Confirm';
import { DraftTextField } from '../../ui/DraftTextField';
import { DraftNumberField } from '../../ui/DraftNumberField';
import { DropSetEditor } from '../../ui/DropSetEditor';
import { ExerciseNamePicker, type ExerciseNameSelection } from '../../ui/ExerciseNamePicker';
import {
  ExerciseEditor,
  type ExerciseEditorInitial,
  type ExerciseEditorSubmitValue,
} from '../../ui/ExerciseEditor';
import { SwipeActionCard } from '../../ui/SwipeActionCard';
import { cardDrag, useCardDragSnapshot } from '../../ui/cardDrag';
import {
  applyReflowAnimation,
  buildDissolveParticles,
  captureCardTops,
  captureDeleteRect,
  dissolveTiming,
  prefersReducedMotion,
  type DissolveGhost,
  type ZoneRect,
} from '../../ui/deleteDissolve';
import { DeleteDissolveLayer } from '../../ui/DeleteDissolveLayer';
import { UndoStack } from '../../ui/UndoStack';
import {
  bindDeleteFeedback,
  captureDeleteFeedbackIntent,
  invalidateDeleteFeedback,
  notifyDeleteSucceeded,
  setDeleteFeedbackEnabled,
} from '../../lib/deletionFeedback';
import {
  addPlanExerciseEntry,
  addWarmup,
  applyEditorToPlanExercise,
  moveExerciseInPlan,
  planExerciseFromTemplate,
  remainingExerciseSlots,
  removeExercise,
  removeWarmup,
  renameExercise,
  reorderPlanExercises,
  restoreDeletedPlanExercise,
  setDayKind,
  updateExercise,
  updateTarget,
  updateWarmup,
} from '../../domain/planEdit';
import {
  exerciseTemplateFromConfig,
  groupPlanForTarget,
  trainingFormOf,
} from '../../domain/exerciseConfig';
import { resolveExerciseId, WEIGHT_MODE_LABEL } from '../../domain/identity';
import {
  MAX_CARDIO_ENTRIES,
  MAX_EXERCISES,
  MAX_INCLINE_PCT,
  MAX_SPEED_KMH,
  MAX_STAIR_LEVEL,
} from '../../domain/limits';
import { newId, targetGroupsOf } from '../../domain/session';
import {
  mergeFlushedDropDraft,
  useDraftForm,
} from '../../ui/draftForm';
import {
  defaultDropDraft,
  describeDropDraft,
  draftStagesForRound,
  draftToDropTarget,
  dropTargetToDraft,
  dropToStraightTarget,
  straightToDropDraft,
  validateDropDraft,
  type DropSetDraft,
} from '../../domain/dropSet';
import type {
  ExerciseTarget,
  Plan,
  PlanCardio,
  PlanExercise,
  StraightTarget,
} from '../../domain/types';

const FOCUS_LABEL = { chest: '胸', back: '背', legs: '腿' } as const;
const UNDO_TTL_MS = 8_000;

function defaultStraightTarget(): StraightTarget {
  return {
    kind: 'straight',
    sets: 3,
    setsMax: 3,
    repsMin: 8,
    repsMax: 12,
    weightMode: 'external',
    suggestedWeightKg: null,
  };
}

/**
 * B4-R2：编辑页字段 owner 的完整生命周期（注册 → 上报 → 卸载注销）。
 * 使用 ref 持有最新回调引用，确保仅在 fieldId 变更或组件真实卸载时执行注销，绝不因父级普通重渲染误清脏状态。
 */
function useEditorFieldOwner(
  fieldId: string,
  reportDirty: (fieldId: string, dirty: boolean) => void,
  unregister: (fieldId: string) => void,
): (dirty: boolean) => void {
  const reportRef = useRef(reportDirty);
  reportRef.current = reportDirty;
  const unregisterRef = useRef(unregister);
  unregisterRef.current = unregister;

  const cb = useCallback(
    (dirty: boolean) => reportRef.current(fieldId, dirty),
    [fieldId],
  );
  useEffect(() => {
    if (!fieldId) return undefined;
    return () => {
      reportRef.current(fieldId, false);
      unregisterRef.current(fieldId);
    };
  }, [fieldId]);
  return cb;
}

/** 草稿里的负重口径文案（V3-05：口径必须可见） */
function comparabilityLabelText(d: DropSetDraft): string {
  const mode: Record<string, string> = {
    external: '外部负重',
    bodyweight: '自重',
    bodyweight_plus: '自重+负重',
    assisted: '辅助重量',
  };
  const basis =
    d.dumbbellBasis === 'per_hand'
      ? ' · 哑铃按单只'
      : d.dumbbellBasis === 'total'
        ? ' · 哑铃按合计'
        : '';
  return `${mode[d.weightMode] ?? d.weightMode}${basis}`;
}

export function ExistingDropEditor({
  plan,
  dayId,
  exercise,
  onSave,
  onDirtyChange,
  ownerFieldId,
  onUnregisterOwner,
  onOpenChange,
  onOpenFullEdit,
}: {
  plan: Plan;
  dayId: string;
  exercise: PlanExercise;
  onSave: (p: Plan) => Promise<boolean>;
  onDirtyChange?: (dirty: boolean) => void;
  ownerFieldId?: string;
  onUnregisterOwner?: (fieldId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenFullEdit?: () => void;
}) {
  const saved: DropSetDraft = useMemo(
    () => (exercise.target.kind === 'dropSet' ? dropTargetToDraft(exercise.target) : defaultDropDraft()),
    [exercise],
  );
  const isSuperset = exercise.target.kind === 'dropSet' && exercise.target.form === 'superset';
  const [draft, setDraft] = useState<DropSetDraft>(saved);
  const form = useDraftForm();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    onOpenChangeRef.current?.(open);
  }, [open]);

  useEffect(() => {
    return () => {
      onOpenChangeRef.current?.(false);
    };
  }, []);

  const issues = validateDropDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const structuredDirty = dirty || saving;

  const reportOwnerDirty = useEditorFieldOwner(
    ownerFieldId ?? '',
    (_id, d) => onDirtyChange?.(d),
    (id) => onUnregisterOwner?.(id),
  );
  void reportOwnerDirty;

  useEffect(() => {
    if (!ownerFieldId || !onUnregisterOwner) return undefined;
    return () => {
      onDirtyChange?.(false);
      onUnregisterOwner(ownerFieldId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerFieldId, onUnregisterOwner]);

  if (!open) {
    return (
      <div>
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--ink-2)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {draft.rounds} 轮 × {draft.stages.length} 阶段
            {isSuperset ? '（超级组）' : ''}
          </div>
          <div style={{ overflowWrap: 'anywhere' }}>{describeDropDraft(draft)}</div>
          <div style={{ color: 'var(--ink-3)', marginTop: 2 }}>
            阶段间休 {draft.restInSec} 秒 · 轮间休 {draft.restAfterSec} 秒 · 口径{' '}
            {comparabilityLabelText(draft)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setDraft(saved);
              setError(null);
              form.resetAll();
              setOpen(true);
            }}
          >
            {isSuperset ? '编辑超级组配置' : '编辑递减组配置'}
          </button>
          {onOpenFullEdit ? (
            <button
              type="button"
              className="btn btn-sm"
              style={{
                border: '1px solid var(--ink-2)',
                background: 'var(--paper-2)',
                color: 'var(--ink)',
                fontWeight: 600,
              }}
              onClick={onOpenFullEdit}
            >
              完整编排（阶段名/记忆）
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <DropSetEditor
        draft={draft}
        onChange={setDraft}
        form={form}
        fieldPrefix={`ex.${exercise.id}`}
        scopeNote="修改只影响未来训练；已保存的历史保持原样。"
        structuredDirty={structuredDirty}
        onDirtyChange={onDirtyChange}
      />

      {error ? (
        <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={saving || !dirty}
          onClick={async () => {
            const flushed = form.flushAll();
            if (!flushed.ok) {
              setError(`有字段还不合法：${Object.values(flushed.errors)[0]}`);
              return;
            }
            const r1Now = draftStagesForRound(draft, 1);
            const r1Rest = draft.roundOverrides?.find((x) => x.roundIndex === 1)?.restInSec;
            const followRounds: number[] = [];
            for (let r = 2; r <= Math.max(1, draft.rounds); r += 1) {
              const rr = draftStagesForRound(draft, r);
              const rrRest = draft.roundOverrides?.find((x) => x.roundIndex === r)?.restInSec;
              if (
                rr.length === r1Now.length &&
                rrRest === r1Rest &&
                rr.every(
                  (st, i) =>
                    (st.label ?? '') === (r1Now[i].label ?? '') &&
                    st.weightKg === r1Now[i].weightKg &&
                    st.repsMin === r1Now[i].repsMin &&
                    st.repsMax === r1Now[i].repsMax &&
                    st.toFailure === r1Now[i].toFailure &&
                    (st.restAfterSec ?? null) === (r1Now[i].restAfterSec ?? null),
                )
              ) {
                followRounds.push(r);
              }
            }
            const nextDraft = mergeFlushedDropDraft(draft, flushed.values, `ex.${exercise.id}`, {
              round1AsOverride: true,
              nullIds: flushed.nullIds,
              syncRound1ToRounds: followRounds,
            });
            const found = validateDropDraft(nextDraft);
            if (found.length) {
              setError(`还有 ${found.length} 处需要修正：${found[0].message}`);
              return;
            }
            setError(null);
            setSaving(true);
            try {
              const builtTarget = draftToDropTarget(nextDraft);
              const nextTarget: ExerciseTarget = isSuperset
                ? { ...builtTarget, form: 'superset' }
                : builtTarget;
              const ok = await onSave(
                updateTarget(plan, dayId, exercise.id, nextTarget),
              );
              if (!ok) {
                setError('这个配置没有保存成功，草稿仍保留在这里，可以重试。');
                return;
              }
              form.resetAll();
              setOpen(false);
            } catch (err) {
              setError(err instanceof Error ? `未保存：${err.message}` : '未保存');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中…' : dirty ? '保存这个配置' : '没有改动'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          disabled={saving}
          onClick={() => {
            setDraft(saved);
            setError(null);
            form.resetAll();
            setOpen(false);
          }}
        >
          取消
        </button>
      </div>
      {issues.length ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
          当前还有 {issues.length} 处未通过校验，修正后才能保存。
        </div>
      ) : null}
    </div>
  );
}

interface PlanUndoEntry {
  token: string;
  dayId: string;
  exercise: PlanExercise;
  orderBefore: string[];
  index: number;
  until: number;
}

interface UnifiedEditorState {
  key: string;
  mode: 'add' | 'edit';
  exId: string | null;
  initial: ExerciseEditorInitial;
}

export function PlanDayEditor({ planId, dayId }: { planId: string; dayId: string }) {
  const {
    plans,
    upsertPlan,
    upsertPlanWithTemplate,
    pushToast,
    exerciseTemplates,
    exerciseTemplateError,
    settings,
  } = useStore();

  const plansRef = useRef<Plan[]>(plans);
  plansRef.current = plans;

  /* ── 离页草稿门禁（B2/G5-R3 & B4-R2）──────────────────────── */
  const editorDirtyRef = useRef<Map<string, boolean>>(new Map());
  const reportEditorDirty = (fieldId: string, dirty: boolean): void => {
    if (dirty) editorDirtyRef.current.set(fieldId, true);
    else editorDirtyRef.current.delete(fieldId);
  };
  const isEditorDirty = (): boolean => {
    for (const v of editorDirtyRef.current.values()) if (v) return true;
    return false;
  };
  const unregisterEditorField = useCallback((fieldId: string): void => {
    editorDirtyRef.current.delete(fieldId);
  }, []);

  const isEditorDirtyRef = useRef(isEditorDirty);
  useEffect(() => {
    const table = editorDirtyRef.current;
    return () => {
      table.clear();
    };
  }, []);
  isEditorDirtyRef.current = isEditorDirty;
  useEffect(() => {
    const off = registerLeaveGuard(() => !isEditorDirtyRef.current());
    return () => {
      off();
      editorDirtyRef.current.clear();
    };
  }, []);

  const editorDirtyHandlersRef = useRef<Map<string, (d: boolean) => void>>(new Map());
  const editorDirtyHandler = (fieldId: string): ((d: boolean) => void) => {
    let fn = editorDirtyHandlersRef.current.get(fieldId);
    if (!fn) {
      fn = (d: boolean) => reportEditorDirty(fieldId, d);
      editorDirtyHandlersRef.current.set(fieldId, fn);
    }
    return fn;
  };

  const hasCardDirty = useCallback(
    (exId: string): boolean => {
      const needle = `:${dayId}:${exId}`;
      for (const [k, v] of editorDirtyRef.current.entries()) {
        if (v && k.includes(needle)) return true;
      }
      return false;
    },
    [dayId],
  );

  const plan = plans.find((p) => p.id === planId);
  const day = plan?.days.find((d) => d.id === dayId);

  /* ── 统一动作选择器与编辑器状态（Wave 2A）──────────────────── */
  const [addNameOpen, setAddNameOpen] = useState(false);
  const [editorState, setEditorState] = useState<UnifiedEditorState | null>(null);
  const editorSeqRef = useRef(0);
  const addCommitRef = useRef<{ dayId: string; exercise: PlanExercise } | null>(null);
  const addInFlightRef = useRef<string | null>(null);

  /* ── 行内展开锁定、删除消散与 8 秒撤销栈 ────────────────────── */
  const [openDropIds, setOpenDropIds] = useState<ReadonlySet<string>>(new Set());
  const [exDelete, setExDelete] = useState<{ exId: string; name: string } | null>(null);
  const [warmDelete, setWarmDelete] = useState<{ warmId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [warmupName, setWarmupName] = useState('');

  const [dissolveGhosts, setDissolveGhosts] = useState<DissolveGhost[]>([]);
  const dissolveTimersRef = useRef<Map<string, number>>(new Map());
  const reflowCleanupRef = useRef<(() => void) | null>(null);
  const pendingReflowTopsRef = useRef<{ itemId: string; prevTops: Map<string, number> } | null>(null);

  const [deleteUndoStack, setDeleteUndoStack] = useState<PlanUndoEntry[]>([]);
  const deleteUndoStackRef = useRef<PlanUndoEntry[]>([]);
  const deleteBatchOrderRef = useRef<string[] | null>(null);
  const deleteConsumedRef = useRef<Set<string>>(new Set());
  const [deleteUndoneCount, setDeleteUndoneCount] = useState(0);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const setDeleteUndoStackBoth = useCallback((next: PlanUndoEntry[]) => {
    deleteUndoStackRef.current = next;
    setDeleteUndoStack(next);
  }, []);

  const soundEnabled = settings.soundEnabled !== false;
  const feedbackScope = `plan-day:${planId}:${dayId}`;
  useEffect(() => {
    setDeleteFeedbackEnabled(soundEnabled);
  }, [soundEnabled]);
  useEffect(() => {
    bindDeleteFeedback(feedbackScope);
    return () => {
      invalidateDeleteFeedback('unmount');
    };
  }, [feedbackScope]);

  const clearAllDissolves = useCallback(() => {
    for (const timer of dissolveTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    dissolveTimersRef.current.clear();
    setDissolveGhosts([]);
    pendingReflowTopsRef.current = null;
    reflowCleanupRef.current?.();
    reflowCleanupRef.current = null;
  }, []);

  const endDissolveFor = useCallback((match: { token?: string; itemId?: string }) => {
    setDissolveGhosts((list) => {
      const keep: DissolveGhost[] = [];
      for (const g of list) {
        const hit =
          (match.token && g.token === match.token) ||
          (match.itemId && g.itemId === match.itemId);
        if (hit) {
          const timer = dissolveTimersRef.current.get(g.token);
          if (timer !== undefined) {
            window.clearTimeout(timer);
            dissolveTimersRef.current.delete(g.token);
          }
        } else {
          keep.push(g);
        }
      }
      return keep.length === list.length ? list : keep;
    });
  }, []);

  const playDissolve = useCallback(
    (token: string, itemId: string, name: string, rect: ZoneRect | null) => {
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const { ghostMs } = dissolveTiming(prefersReducedMotion());
      if (ghostMs <= 0) return;
      const ghost: DissolveGhost = {
        token,
        itemId,
        kind: 'exercise',
        name,
        rect,
        startedAt: Date.now(),
        durationMs: ghostMs,
        particles: buildDissolveParticles(token),
      };
      setDissolveGhosts((prev) =>
        prev.some((g) => g.token === token) ? prev : [...prev, ghost],
      );
      const timer = window.setTimeout(() => {
        dissolveTimersRef.current.delete(token);
        setDissolveGhosts((prev) => prev.filter((g) => g.token !== token));
      }, ghostMs + 40);
      dissolveTimersRef.current.set(token, timer);
    },
    [],
  );

  useEffect(() => {
    return () => {
      clearAllDissolves();
    };
  }, [clearAllDissolves]);

  /* ── 拖拽排序快照与零残影同步释放 ───────────────────────────── */
  const dragSnapshot = useCardDragSnapshot();
  const exerciseIdsKey = day ? day.exercises.map((e) => e.id).join('\u0000') : '';
  const exerciseIds = useMemo(
    () => (exerciseIdsKey ? exerciseIdsKey.split('\u0000') : []),
    [exerciseIdsKey],
  );

  useLayoutEffect(() => {
    cardDrag.releaseCommitHold();
    const pending = pendingReflowTopsRef.current;
    if (pending && day && !day.exercises.some((e) => e.id === pending.itemId)) {
      pendingReflowTopsRef.current = null;
      if (!prefersReducedMotion()) {
        reflowCleanupRef.current?.();
        reflowCleanupRef.current = applyReflowAnimation(pending.prevTops);
      }
    }
  }, [exerciseIdsKey, day]);

  useEffect(() => {
    return () => {
      cardDrag.releaseCommitHold();
    };
  }, []);

  /* ── 8 秒撤销栈自动过期清理 ─────────────────────────────────── */
  useEffect(() => {
    if (!deleteUndoStack.length) return undefined;
    const nextDeadline = Math.min(...deleteUndoStack.map((it) => it.until));
    const timeout = window.setTimeout(() => {
      const at = Date.now();
      const live = deleteUndoStackRef.current.filter((it) => it.until > at);
      if (live.length === deleteUndoStackRef.current.length) return;
      setDeleteUndoStackBoth(live);
      if (!live.length) {
        deleteBatchOrderRef.current = null;
        setDeleteUndoneCount(0);
      }
    }, Math.max(0, nextDeadline - Date.now()) + 16);
    return () => window.clearTimeout(timeout);
  }, [deleteUndoStack, setDeleteUndoStackBoth]);

  useEffect(() => {
    if (!plan) navigate('/plans', true);
  }, [plan]);

  const save = useCallback(
    async (next: Plan): Promise<boolean> => {
      try {
        await upsertPlan(next);
        return true;
      } catch (err) {
        pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存', 'error');
        return false;
      }
    },
    [pushToast, upsertPlan],
  );

  const currentPlan = useCallback((pid: string): Plan => {
    const found = plansRef.current.find((p) => p.id === pid);
    if (!found) throw new Error('这个计划已经不存在了');
    return found;
  }, []);

  const memoryFor = useCallback(
    (exerciseId: string): NonNullable<ExerciseEditorInitial['memory']> => {
      if (exerciseTemplateError) return { mode: 'none', revision: null };
      const tpl = exerciseTemplates.find((t) => t.exerciseId === exerciseId);
      return tpl ? { mode: 'exists', revision: tpl.revision } : { mode: 'first', revision: null };
    },
    [exerciseTemplateError, exerciseTemplates],
  );

  const openEditEditor = useCallback(
    (exId: string) => {
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        pushToast('这个计划已经不存在了', 'error');
        return;
      }
      const latestDay = latestPlan.days.find((d) => d.id === dayId);
      const ex = latestDay?.exercises.find((e) => e.id === exId);
      if (!ex) {
        pushToast('这个动作已经不在该训练日里了', 'error');
        return;
      }
      if (hasCardDirty(exId)) {
        pushToast('这个动作还有未完成的行内输入；请先提交或取消行内修改，再打开完整编排。', 'error');
        return;
      }
      const resolvedId = resolveExerciseId(ex);
      editorSeqRef.current += 1;
      const key = `plan-edit:${exId}:${editorSeqRef.current}`;
      setEditorState({
        key,
        mode: 'edit',
        exId,
        initial: {
          key,
          name: ex.name,
          ...(ex.en !== undefined ? { en: ex.en } : {}),
          exerciseId: resolvedId,
          target: structuredClone(ex.target),
          restSec: ex.restSec,
          arrangedGroups: groupPlanForTarget(ex.target),
          memory: memoryFor(resolvedId),
        },
      });
    },
    [currentPlan, dayId, hasCardDirty, memoryFor, planId, pushToast],
  );

  const handleAddName = useCallback(
    (selection: ExerciseNameSelection) => {
      setAddNameOpen(false);
      if (exerciseTemplateError) {
        addInFlightRef.current = null;
        pushToast(`动作配置记忆读取异常：${exerciseTemplateError}`, 'error');
        return;
      }
      if (addInFlightRef.current) return;
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        pushToast('这个计划已经不存在了', 'error');
        return;
      }
      const latestDay = latestPlan.days.find((d) => d.id === dayId);
      if (!latestDay) return;
      if (remainingExerciseSlots(latestDay) <= 0) {
        pushToast(`动作数已达上限 ${MAX_EXERCISES}`, 'error');
        return;
      }

      const tpl = exerciseTemplates.find((t) => t.exerciseId === selection.exerciseId);
      if (tpl) {
        const exercise = planExerciseFromTemplate(tpl);
        addInFlightRef.current = exercise.id;
        const added = addPlanExerciseEntry(latestPlan, dayId, exercise);
        if (!added.added) {
          addInFlightRef.current = null;
          pushToast(
            added.reason === 'capacity' ? `动作数已达上限 ${MAX_EXERCISES}` : '找不到这个训练日',
            'error',
          );
          return;
        }
        void save(added.plan)
          .then((ok) => {
            if (ok) {
              pushToast(`已按记忆配置添加「${exercise.name}」`);
            }
          })
          .finally(() => {
            addInFlightRef.current = null;
          });
        return;
      }

      editorSeqRef.current += 1;
      const key = `plan-add:${selection.exerciseId}:${editorSeqRef.current}`;
      const target = defaultStraightTarget();
      setEditorState({
        key,
        mode: 'add',
        exId: null,
        initial: {
          key,
          name: selection.name,
          ...(selection.en !== undefined ? { en: selection.en } : {}),
          exerciseId: selection.exerciseId,
          target,
          restSec: 120,
          arrangedGroups: groupPlanForTarget(target),
          memory: { mode: 'first', revision: null },
        },
      });
    },
    [currentPlan, dayId, exerciseTemplateError, exerciseTemplates, planId, pushToast, save],
  );

  const handleEditorSubmit = useCallback(
    async (payload: ExerciseEditorSubmitValue): Promise<{ ok: boolean; message?: string }> => {
      if (!editorState) return { ok: false, message: '编辑器状态已失效' };
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        return { ok: false, message: '这个计划已经不存在了' };
      }

      const templateWrite =
        payload.remember && payload.template
          ? { template: payload.template, expectedRevision: payload.templateExpectedRevision }
          : undefined;

      if (editorState.mode === 'add') {
        const tpl = exerciseTemplateFromConfig({
          exerciseId: payload.exerciseId,
          name: payload.name,
          ...(payload.en !== undefined ? { en: payload.en } : {}),
          target: payload.target,
          restSec: payload.restSec,
        });
        const built = planExerciseFromTemplate(tpl);
        const existing = addCommitRef.current;
        const exercise =
          existing && existing.dayId === dayId ? { ...built, id: existing.exercise.id } : built;
        addCommitRef.current = { dayId, exercise };

        const added = addPlanExerciseEntry(latestPlan, dayId, exercise);
        if (!added.added) {
          return {
            ok: false,
            message:
              added.reason === 'capacity'
                ? `动作数已达上限 ${MAX_EXERCISES}`
                : '找不到这个训练日，未保存',
          };
        }

        const res = await upsertPlanWithTemplate(added.plan, templateWrite);
        if (!res.ok) {
          pushToast(`添加没有保存成功：${res.message}。配置已保留，可重试。`, 'error');
          return { ok: false, message: res.message };
        }
        addCommitRef.current = null;
        pushToast(
          payload.remember
            ? `已添加「${exercise.name}」，并设为此动作的默认配置`
            : `已添加「${exercise.name}」`,
        );
        return { ok: true };
      }

      const exId = editorState.exId;
      if (!exId) return { ok: false, message: '找不到要编辑的动作' };
      const applied = applyEditorToPlanExercise(latestPlan, dayId, exId, {
        name: payload.name,
        ...(payload.en !== undefined ? { en: payload.en } : {}),
        exerciseId: payload.exerciseId,
        target: payload.target,
        restSec: payload.restSec,
      });
      if (!applied.ok) {
        return { ok: false, message: applied.message };
      }
      const res = await upsertPlanWithTemplate(applied.plan, templateWrite);
      if (!res.ok) {
        pushToast(`保存没有成功：${res.message}。草稿已保留。`, 'error');
        return { ok: false, message: res.message };
      }
      if (!payload.remember) {
        pushToast(`已保存计划动作（「${payload.name}」）`);
      } else if (payload.templateExpectedRevision === null) {
        pushToast(`已保存「${payload.name}」，并设为此动作的默认配置`);
      } else {
        pushToast(`已保存，并更新此动作的默认配置（「${payload.name}」）`);
      }
      return { ok: true };
    },
    [currentPlan, dayId, editorState, planId, pushToast, upsertPlanWithTemplate],
  );

  const handleReorderExercises = useCallback(
    async (orderedIds: string[], startIds: string[] | null) => {
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        pushToast('这个计划已经不存在了', 'error');
        return;
      }
      const latestDay = latestPlan.days.find((d) => d.id === dayId);
      if (!latestDay) return;
      const currentIds = latestDay.exercises.map((e) => e.id);
      if (startIds && JSON.stringify(currentIds) !== JSON.stringify(startIds)) {
        pushToast('拖动期间动作列表已变化，请重新拖动', 'error');
        return;
      }
      const res = reorderPlanExercises(latestPlan, dayId, orderedIds);
      if (!res.ok) {
        pushToast(res.message, 'error');
        return;
      }
      if (!res.changed) return;
      const ok = await save(res.plan);
      if (ok) pushToast('动作顺序已保存');
    },
    [currentPlan, dayId, planId, pushToast, save],
  );

  const executeDeleteExercise = useCallback(
    async (exId: string): Promise<boolean> => {
      if (deleteBusy) return false;
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        pushToast('这个计划已经不存在了', 'error');
        return false;
      }
      const latestDay = latestPlan.days.find((d) => d.id === dayId);
      const idx = latestDay ? latestDay.exercises.findIndex((e) => e.id === exId) : -1;
      const target = idx >= 0 && latestDay ? latestDay.exercises[idx] : undefined;
      if (!latestDay || !target) {
        pushToast('这个动作已经不存在了。');
        return false;
      }

      const token = newId('pdel');
      const rect = captureDeleteRect(target.id, 'exercise');
      const prevTops = captureCardTops(
        typeof document !== 'undefined'
          ? document.querySelector('[data-reorder-zone="strength"]')
          : null,
      );
      const orderBefore = latestDay.exercises.map((e) => e.id);
      const feedbackTicket = captureDeleteFeedbackIntent();

      setDeleteBusy(true);
      pendingReflowTopsRef.current = { itemId: target.id, prevTops };
      try {
        const ok = await save(removeExercise(latestPlan, latestDay.id, target.id));
        if (!ok) {
          pendingReflowTopsRef.current = null;
          return false;
        }
        unregisterEditorField(`drop-config:${dayId}:${target.id}`);
        playDissolve(token, target.id, target.name, rect);
        try {
          notifyDeleteSucceeded(
            { sessionId: feedbackScope, itemId: target.id, token },
            feedbackTicket,
          );
        } catch {
          /* 音效失败不影响删除结果 */
        }

        const now = Date.now();
        const live = deleteUndoStackRef.current.filter((it) => it.until > now);
        if (!live.length) {
          deleteBatchOrderRef.current = orderBefore;
          setDeleteUndoneCount(0);
        }
        const entry: PlanUndoEntry = {
          token,
          dayId: latestDay.id,
          exercise: structuredClone(target) as PlanExercise,
          orderBefore: deleteBatchOrderRef.current ?? orderBefore,
          index: idx,
          until: now + UNDO_TTL_MS,
        };
        setDeleteUndoStackBoth([...live, entry]);
        return true;
      } finally {
        setDeleteBusy(false);
      }
    },
    [
      currentPlan,
      dayId,
      deleteBusy,
      feedbackScope,
      planId,
      playDissolve,
      pushToast,
      save,
      setDeleteUndoStackBoth,
      unregisterEditorField,
    ],
  );

  const requestSwipeDeleteExercise = useCallback(
    (exId: string) => {
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        return;
      }
      const ex = latestPlan.days.find((d) => d.id === dayId)?.exercises.find((e) => e.id === exId);
      if (!ex) return;
      if (hasCardDirty(exId)) {
        setExDelete({ exId: ex.id, name: ex.name });
        return;
      }
      void executeDeleteExercise(ex.id);
    },
    [currentPlan, dayId, executeDeleteExercise, hasCardDirty, planId],
  );

  const undoDeleteExercise = useCallback(
    async (token: string) => {
      if (deleteBusy) return;
      const entry = deleteUndoStackRef.current.find((it) => it.token === token);
      if (!entry) return;
      if (deleteConsumedRef.current.has(token) || Date.now() > entry.until) {
        const left = deleteUndoStackRef.current.filter((it) => it.token !== token);
        setDeleteUndoStackBoth(left);
        if (!left.length) {
          deleteBatchOrderRef.current = null;
          setDeleteUndoneCount(0);
        }
        pushToast('撤销已过期', 'error');
        return;
      }
      let latestPlan: Plan;
      try {
        latestPlan = currentPlan(planId);
      } catch {
        return;
      }
      const restored = restoreDeletedPlanExercise(
        latestPlan,
        entry.dayId,
        entry.exercise,
        entry.orderBefore,
        entry.index,
      );
      if (!restored.ok) {
        pushToast(restored.message, 'error');
        return;
      }
      setDeleteBusy(true);
      endDissolveFor({ token: entry.token, itemId: entry.exercise.id });
      pendingReflowTopsRef.current = null;
      try {
        const ok = await save(restored.plan);
        if (!ok) return;
        deleteConsumedRef.current.add(token);
        const left = deleteUndoStackRef.current.filter((it) => it.token !== token);
        setDeleteUndoStackBoth(left);
        if (left.length) setDeleteUndoneCount((n) => n + 1);
        else {
          deleteBatchOrderRef.current = null;
          setDeleteUndoneCount(0);
        }
        pushToast(`已撤销删除「${entry.exercise.name}」`);
      } finally {
        setDeleteBusy(false);
      }
    },
    [currentPlan, deleteBusy, endDissolveFor, planId, pushToast, save, setDeleteUndoStackBoth],
  );

  if (!plan || !day) {
    return (
      <main className="page page-top">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-title">找不到这个训练日</div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => navigate('/plans')}>
            回计划页
          </button>
        </div>
      </main>
    );
  }

  function updateCardioTarget(cardioId: string, patch: Partial<PlanCardio['target']>) {
    const latest = currentPlan(planId);
    const next: Plan = {
      ...latest,
      days: latest.days.map((d) => {
        if (d.id !== dayId) return d;
        return {
          ...d,
          cardio: (d.cardio ?? []).map((pc) => {
            if (pc.id !== cardioId) return pc;
            const merged = { ...pc.target, ...patch };
            const target: PlanCardio['target'] =
              pc.preset === 'treadmill-incline'
                ? {
                    ...(typeof merged.speedKmh === 'number' ? { speedKmh: merged.speedKmh } : {}),
                    ...(typeof merged.inclinePct === 'number' ? { inclinePct: merged.inclinePct } : {}),
                  }
                : { ...(typeof merged.level === 'number' ? { level: merged.level } : {}) };
            return { ...pc, target };
          }),
        };
      }),
    };
    void save(next);
  }

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`/plans?plan=${encodeURIComponent(planId)}`)}
        >
          ‹ 计划
        </button>
      </header>

      <h1 className="h-serif" style={{ fontSize: 26, marginTop: 8, overflowWrap: 'anywhere' }}>
        {day.name}
      </h1>
      <div className="mono-label" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
        {plan.name} · 第 {plan.days.findIndex((d) => d.id === day.id) + 1} 天
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {(['chest', 'back', 'legs'] as const).map((f) => (
          <button
            key={f}
            className={`btn btn-sm ${day.focus === f ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() =>
              void save({
                ...plan,
                days: plan.days.map((d) => (d.id === day.id ? { ...d, focus: f } : d)),
              })
            }
          >
            {FOCUS_LABEL[f]}
          </button>
        ))}
        {(
          [
            ['train', '力量日'],
            ['cardio', '有氧日'],
            ['rest', '休息日'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`btn btn-sm ${day.kind === k ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              if (day.kind === k) return;
              void save(setDayKind(plan, day.id, k));
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {day.kind === 'rest' ? (
        <div className="empty" style={{ marginTop: 20 }}>
          <div className="empty-title">这是一个休息日</div>
          <p className="empty-body">休息日不会生成训练记录；在首页「推进」或开始训练时选择推进即可越过它。</p>
          <input
            className="input"
            style={{ marginTop: 12, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto' }}
            value={day.restNote ?? ''}
            placeholder="休息说明，例如 睡眠 · 步行 · 放松"
            aria-label="休息说明"
            onChange={(e) =>
              void save({
                ...plan,
                days: plan.days.map((d) => (d.id === day.id ? { ...d, restNote: e.target.value } : d)),
              })
            }
          />
        </div>
      ) : day.kind === 'cardio' ? (
        <section style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section">有氧项目</h2>
            <span className="mono-label">目标 / 初始值</span>
          </div>
          {(day.cardio ?? []).length ? (
            <div className="rows" style={{ marginTop: 6 }}>
              {(day.cardio ?? []).map((pc) => (
                <div
                  key={pc.id}
                  className="row"
                  style={{ cursor: 'default', alignItems: 'flex-start', flexWrap: 'wrap' }}
                >
                  <span className="row-main" style={{ minWidth: 0 }}>
                    <span className="row-title">{pc.name}</span>
                    <span className="row-sub">目标 / 初始值（实际训练中可再调整）</span>
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--brick)', minWidth: 44, padding: 0 }}
                    aria-label={`删除${pc.name}`}
                    onClick={() =>
                      void save({
                        ...plan,
                        days: plan.days.map((d) =>
                          d.id === day.id
                            ? { ...d, cardio: (d.cardio ?? []).filter((x) => x.id !== pc.id) }
                            : d,
                        ),
                      })
                    }
                  >
                    ×
                  </button>
                  <div
                    style={{
                      flex: '1 1 100%',
                      display: 'grid',
                      gridTemplateColumns:
                        pc.preset === 'treadmill-incline'
                          ? 'repeat(2, minmax(0,1fr))'
                          : 'repeat(1, minmax(0,1fr))',
                      gap: 8,
                      marginTop: 8,
                      paddingLeft: 2,
                    }}
                  >
                    {pc.preset === 'treadmill-incline' ? (
                      <>
                        <DraftNumberField
                          onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:speed`)}
                          label="速度"
                          value={pc.target.speedKmh ?? 0}
                          min={0}
                          max={MAX_SPEED_KMH}
                          integer={false}
                          unit="km/h"
                          fieldId={`cardio.${pc.id}.speed`}
                          onCommit={(v) => void updateCardioTarget(pc.id, { speedKmh: v })}
                        />
                        <DraftNumberField
                          onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:incline`)}
                          label="坡度"
                          value={pc.target.inclinePct ?? 0}
                          min={0}
                          max={MAX_INCLINE_PCT}
                          integer={false}
                          unit="%"
                          fieldId={`cardio.${pc.id}.incline`}
                          onCommit={(v) => void updateCardioTarget(pc.id, { inclinePct: v })}
                        />
                      </>
                    ) : (
                      <DraftNumberField
                        onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:level`)}
                        label="档位"
                        value={pc.target.level ?? 1}
                        min={1}
                        max={MAX_STAIR_LEVEL}
                        unit="档"
                        fieldId={`cardio.${pc.id}.level`}
                        onCommit={(v) => void updateCardioTarget(pc.id, { level: v })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.65, marginTop: 6 }}>
              这一日还没有有氧项目。可以添加「有氧爬坡」或「爬楼机」作为今天的默认目标。
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {(
              [
                ['treadmill-incline', '有氧爬坡', { speedKmh: 4, inclinePct: 4 }],
                ['stair-climber', '爬楼机', { level: 5 }],
              ] as const
            ).map(([preset, label, target]) => (
              <button
                key={preset}
                className="btn btn-ghost btn-sm"
                disabled={(day.cardio ?? []).length >= MAX_CARDIO_ENTRIES}
                onClick={() => {
                  if ((day.cardio ?? []).length >= MAX_CARDIO_ENTRIES) {
                    pushToast(`一次计划最多 ${MAX_CARDIO_ENTRIES} 个有氧项目`, 'error');
                    return;
                  }
                  void save({
                    ...plan,
                    days: plan.days.map((d) =>
                      d.id === day.id
                        ? {
                            ...d,
                            cardio: [
                              ...(d.cardio ?? []),
                              {
                                id: `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                                preset,
                                name: label,
                                target,
                              },
                            ],
                          }
                        : d,
                    ),
                  });
                }}
              >
                + {label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.6, marginTop: 10 }}>
            这里只保存目标/初始参数；实际计时与分段属于训练记录，改计划不会改动历史。
          </p>
        </section>
      ) : (
        <>
          <section style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">热身（不计入正式组）</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setWarmupOpen(true)}>
                + 加热身
              </button>
            </div>
            {day.warmups.length ? (
              <div className="rows" style={{ marginTop: 4 }}>
                {day.warmups.map((w) => (
                  <div key={w.id} className="row" style={{ cursor: 'default', flexWrap: 'wrap', gap: 8 }}>
                    <span className="row-main" style={{ minWidth: 0 }}>
                      <span className="row-title" style={{ fontSize: 15, wordBreak: 'break-word' }}>
                        {w.name}
                      </span>
                    </span>
                    <DraftTextField
                      className="input"
                      wrapperStyle={{ flex: '1 1 110px', minWidth: 96 }}
                      style={{ width: '100%', minHeight: 44, fontSize: 13 }}
                      value={w.targetText}
                      ariaLabel={`${w.name} 目标`}
                      maxLength={200}
                      allowEmpty
                      onCommit={(next) => save(updateWarmup(currentPlan(planId), day.id, w.id, next))}
                    />
                    <button
                      className="btn btn-ghost"
                      style={{ color: 'var(--brick)', minWidth: 44, minHeight: 44, padding: 0, flex: 'none' }}
                      onClick={() => setWarmDelete({ warmId: w.id, name: w.name })}
                      aria-label={`删除热身「${w.name}」`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--ink-3)', marginTop: 6 }}>还没有热身项。</p>
            )}
          </section>

          <section style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">
                正式动作 · {day.exercises.reduce((n, e) => n + targetGroupsOf(e), 0)} 组
              </h2>
              <button
                className="btn btn-ghost btn-sm"
                data-testid="plan-add-exercise-btn"
                onClick={() => {
                  if (remainingExerciseSlots(day) <= 0) {
                    pushToast(
                      `这个训练日已经有 ${MAX_EXERCISES} 个动作，达到上限（备份也只支持这个范围）。请先合并或删除动作。`,
                      'error',
                    );
                    return;
                  }
                  setAddNameOpen(true);
                }}
              >
                + 加动作
              </button>
            </div>

            {day.exercises.length > 1 ? (
              <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 4 }}>
                长按卡片可拖拽调整顺序 · 左滑可打开完整编排或删除
              </div>
            ) : null}

            <div style={{ position: 'relative' }} data-reorder-zone="strength">
              <DeleteDissolveLayer ghosts={dissolveGhosts} />
              {day.exercises.map((ex, idx) => {
                const formKind = trainingFormOf(ex.target);
                const hasPerSet =
                  ex.target.kind === 'straight' && Boolean(ex.target.perSetConfigs?.length);
                const hasFailure =
                  ex.target.kind === 'straight' &&
                  Boolean(
                    ex.target.toFailure || ex.target.perSetConfigs?.some((c) => c.toFailure),
                  );
                const hasRoundOverride =
                  ex.target.kind === 'dropSet' && Boolean(ex.target.roundConfigs?.length);
                const hasRemembered = exerciseTemplates.some(
                  (t) => t.exerciseId === resolveExerciseId(ex),
                );

                return (
                  <div key={ex.id} style={{ marginTop: 10 }}>
                    <SwipeActionCard
                      testId={`plan-exercise-card-${ex.id}`}
                      reorderId={ex.id}
                      reorderKind="strength"
                      reorderIndex={idx}
                      reorderIds={exerciseIds}
                      drag={dragSnapshot}
                      locked={openDropIds.has(ex.id)}
                      onReorderCommit={handleReorderExercises}
                      onEdit={() => openEditEditor(ex.id)}
                      onDelete={() => requestSwipeDeleteExercise(ex.id)}
                      deleteRequiresConfirm={() => hasCardDirty(ex.id)}
                    >
                      <div className="slip" style={{ padding: '12px 12px 10px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="mono-label" style={{ width: 20, flex: 'none' }}>
                            {idx + 1}
                          </span>
                          <DraftTextField
                            className="input"
                            wrapperStyle={{ flex: '1 1 auto', minWidth: 0 }}
                            style={{ width: '100%', minHeight: 44, fontSize: 15 }}
                            value={ex.name}
                            ariaLabel={`动作 ${idx + 1} 名称`}
                            maxLength={200}
                            onCommit={(next) =>
                              save(
                                renameExercise(currentPlan(planId), day.id, ex.id, next, {
                                  keepIdentity: true,
                                }),
                              )
                            }
                          />
                        </div>

                        {ex.target.weightMode !== 'external' ||
                        hasPerSet ||
                        hasFailure ||
                        hasRoundOverride ||
                        hasRemembered ? (
                          <div
                            style={{
                              display: 'flex',
                              gap: 6,
                              flexWrap: 'wrap',
                              marginTop: 6,
                              paddingLeft: 28,
                            }}
                          >
                            {ex.target.weightMode !== 'external' ? (
                              <span className="tag tag-quiet">
                                {WEIGHT_MODE_LABEL[ex.target.weightMode]}
                              </span>
                            ) : null}
                            {hasPerSet ? <span className="tag tag-quiet">逐组独立配置</span> : null}
                            {hasFailure ? <span className="tag tag-quiet">含力竭</span> : null}
                            {hasRoundOverride ? <span className="tag tag-quiet">含逐轮覆盖</span> : null}
                            {hasRemembered ? <span className="tag tag-quiet">已记忆</span> : null}
                          </div>
                        ) : null}

                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            marginTop: 6,
                            paddingLeft: 28,
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{
                              flex: 'none',
                              minHeight: 40,
                              padding: '0 12px',
                              border: '1.5px solid var(--ink)',
                              background: 'var(--paper-2)',
                              color: 'var(--ink)',
                              fontWeight: 600,
                            }}
                            data-testid={`plan-ex-full-edit-${ex.id}`}
                            aria-label={`完整编排「${ex.name}」`}
                            onClick={() => openEditEditor(ex.id)}
                          >
                            完整编排
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ flex: 'none', minHeight: 44 }}
                            aria-label={`把「${ex.name}」改成另一个动作`}
                            onClick={() =>
                              void save(
                                renameExercise(plan, day.id, ex.id, ex.name, { keepIdentity: false }),
                              )
                            }
                            title="把这个动作换成另一个动作：之后的新记录归到新动作，历史保持原样"
                          >
                            独立身份
                          </button>
                          <div style={{ display: 'flex', gap: 6, flex: 'none', marginLeft: 'auto' }}>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
                              disabled={idx === 0}
                              aria-label="上移动作"
                              onClick={() => void save(moveExerciseInPlan(plan, day.id, ex.id, -1))}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
                              disabled={idx === day.exercises.length - 1}
                              aria-label="下移动作"
                              onClick={() => void save(moveExerciseInPlan(plan, day.id, ex.id, 1))}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{
                                color: 'var(--brick)',
                                minWidth: 44,
                                minHeight: 44,
                                padding: 0,
                                flex: 'none',
                              }}
                              aria-label={`删除动作「${ex.name}」`}
                              onClick={() => setExDelete({ exId: ex.id, name: ex.name })}
                            >
                              ×
                            </button>
                          </div>
                        </div>

                        <div className="segmented" role="group" aria-label="训练形式" style={{ marginTop: 10 }}>
                          <button
                            type="button"
                            aria-pressed={formKind === 'straight'}
                            onClick={() => {
                              if (formKind === 'straight') return;
                              if (ex.target.kind === 'dropSet') {
                                void save(
                                  updateTarget(
                                    plan,
                                    day.id,
                                    ex.id,
                                    dropToStraightTarget(ex.target) as ExerciseTarget,
                                  ),
                                );
                              }
                            }}
                          >
                            普通组
                          </button>
                          <button
                            type="button"
                            aria-pressed={formKind === 'superset'}
                            onClick={() => {
                              if (formKind === 'superset') return;
                              if (ex.target.kind === 'dropSet') {
                                void save(
                                  updateTarget(plan, day.id, ex.id, {
                                    ...ex.target,
                                    form: 'superset',
                                  } as ExerciseTarget),
                                );
                              } else {
                                const draft = straightToDropDraft(ex.target);
                                void save(
                                  updateTarget(plan, day.id, ex.id, {
                                    ...draftToDropTarget(draft),
                                    form: 'superset',
                                  } as ExerciseTarget),
                                );
                              }
                            }}
                          >
                            超级组
                          </button>
                          <button
                            type="button"
                            aria-pressed={formKind === 'dropSet'}
                            onClick={() => {
                              if (formKind === 'dropSet') return;
                              if (ex.target.kind === 'dropSet') {
                                const cloned = { ...ex.target };
                                delete cloned.form;
                                void save(updateTarget(plan, day.id, ex.id, cloned as ExerciseTarget));
                              } else {
                                const draft = straightToDropDraft(ex.target);
                                void save(
                                  updateTarget(
                                    plan,
                                    day.id,
                                    ex.id,
                                    draftToDropTarget(draft) as ExerciseTarget,
                                  ),
                                );
                              }
                            }}
                          >
                            递减组
                          </button>
                        </div>

                        {ex.target.kind === 'straight' ? (
                          <>
                            <div
                              className="segmented"
                              role="group"
                              aria-label="哑铃口径"
                              style={{ marginTop: 8 }}
                            >
                              {(
                                [
                                  ['per_hand', '按单只'],
                                  ['total', '按合计'],
                                ] as const
                              ).map(([basis, label]) => (
                                <button
                                  key={basis}
                                  type="button"
                                  aria-pressed={
                                    (ex.target.kind === 'straight'
                                      ? (ex.target.dumbbellBasis ?? 'total')
                                      : 'total') === basis
                                  }
                                  style={{ fontSize: 12 }}
                                  onClick={() =>
                                    void save(updateTarget(plan, day.id, ex.id, { dumbbellBasis: basis }))
                                  }
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(3, minmax(0,1fr))',
                                gap: 8,
                                marginTop: 8,
                              }}
                            >
                              <DraftNumberField
                                onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:sets`)}
                                label="组数"
                                value={ex.target.sets}
                                min={0}
                                max={30}
                                onCommit={(v) => {
                                  const setsMax = Math.max(
                                    ex.target.kind === 'straight' ? ex.target.setsMax : v,
                                    v,
                                  );
                                  void save(updateTarget(plan, day.id, ex.id, { sets: v, setsMax }));
                                }}
                              />
                              <DraftNumberField
                                onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:repsMin`)}
                                label="次数下限"
                                value={ex.target.repsMin}
                                min={0}
                                max={500}
                                validate={(v) =>
                                  ex.target.kind === 'straight' && v > ex.target.repsMax
                                    ? `不能大于上限 ${ex.target.repsMax}`
                                    : null
                                }
                                onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { repsMin: v }))}
                              />
                              <DraftNumberField
                                onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:repsMax`)}
                                label="次数上限"
                                value={ex.target.repsMax}
                                min={0}
                                max={500}
                                validate={(v) =>
                                  ex.target.kind === 'straight' && v < ex.target.repsMin
                                    ? `不能小于下限 ${ex.target.repsMin}`
                                    : null
                                }
                                onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { repsMax: v }))}
                              />
                              <DraftNumberField
                                onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:restSec`)}
                                label="休息秒"
                                value={ex.restSec}
                                min={0}
                                max={3600}
                                unit="秒"
                                onCommit={(v) => void save(updateExercise(plan, day.id, ex.id, { restSec: v }))}
                              />
                              <DraftNumberField
                                onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:weight`)}
                                label="建议重量"
                                nullable
                                placeholder="—"
                                value={ex.target.suggestedWeightKg}
                                min={0}
                                max={9999}
                                integer={false}
                                unit="kg"
                                onCommit={(v) =>
                                  void save(updateTarget(plan, day.id, ex.id, { suggestedWeightKg: v }))
                                }
                              />
                            </div>
                          </>
                        ) : (
                          <div style={{ marginTop: 8 }}>
                            <ExistingDropEditor
                              plan={plan}
                              dayId={day.id}
                              exercise={ex}
                              onSave={save}
                              onDirtyChange={editorDirtyHandler(`drop-config:${day.id}:${ex.id}`)}
                              ownerFieldId={`drop-config:${day.id}:${ex.id}`}
                              onUnregisterOwner={unregisterEditorField}
                              onOpenFullEdit={() => openEditEditor(ex.id)}
                              onOpenChange={(isOpen) => {
                                setOpenDropIds((prev) => {
                                  if (isOpen && prev.has(ex.id)) return prev;
                                  if (!isOpen && !prev.has(ex.id)) return prev;
                                  const next = new Set(prev);
                                  if (isOpen) next.add(ex.id);
                                  else next.delete(ex.id);
                                  return next;
                                });
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </SwipeActionCard>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      <ExerciseNamePicker
        open={addNameOpen}
        templates={exerciseTemplates}
        onSelect={handleAddName}
        onClose={() => setAddNameOpen(false)}
      />

      {editorState ? (
        <ExerciseEditor
          key={editorState.key}
          open
          mode={editorState.mode}
          initial={editorState.initial}
          templates={exerciseTemplates}
          templateError={exerciseTemplateError}
          onSubmit={handleEditorSubmit}
          onDirtyChange={editorDirtyHandler(`unified-editor:${day.id}`)}
          onClose={() => {
            unregisterEditorField(`unified-editor:${day.id}`);
            setEditorState(null);
            addCommitRef.current = null;
            addInFlightRef.current = null;
          }}
        />
      ) : null}

      <UndoStack
        items={deleteUndoStack.map((it) => ({
          token: it.token,
          name: it.exercise.name,
          until: it.until,
        }))}
        undoneCount={deleteUndoneCount}
        busy={deleteBusy}
        onUndo={(token) => void undoDeleteExercise(token)}
      />

      <Sheet open={warmupOpen} title="添加热身" onClose={() => setWarmupOpen(false)}>
        <div className="field">
          <label htmlFor="warm-name">热身名称</label>
          <input
            id="warm-name"
            className="input"
            value={warmupName}
            placeholder="例如：弹力带水平拉开"
            onChange={(e) => setWarmupName(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 12 }}
          onClick={async () => {
            const ok = await save(addWarmup(plan, day.id, warmupName));
            if (!ok) return;
            setWarmupName('');
            setWarmupOpen(false);
          }}
        >
          添加
        </button>
      </Sheet>

      <Confirm
        open={!!exDelete}
        title="删除这个动作？"
        body={exDelete ? `将删除动作「${exDelete.name}」。已保存的训练历史不受影响。` : ''}
        confirmText="是"
        cancelText="否"
        danger
        busy={deleting || deleteBusy}
        onCancel={() => {
          if (deleting || deleteBusy) return;
          setExDelete(null);
        }}
        onConfirm={async () => {
          if (deleting || deleteBusy || !exDelete) return;
          setDeleting(true);
          try {
            const ok = await executeDeleteExercise(exDelete.exId);
            if (!ok) return;
            setExDelete(null);
          } finally {
            setDeleting(false);
          }
        }}
      />

      <Confirm
        open={!!warmDelete}
        title="删除这个热身？"
        body={warmDelete ? `将删除热身「${warmDelete.name}」。已保存的训练历史不受影响。` : ''}
        confirmText="是"
        cancelText="否"
        danger
        busy={deleting}
        onCancel={() => {
          if (deleting) return;
          setWarmDelete(null);
        }}
        onConfirm={async () => {
          if (deleting || !warmDelete) return;
          setDeleting(true);
          try {
            const latestPlan = plans.find((p) => p.id === planId);
            const latestDay = latestPlan?.days.find((d) => d.id === dayId);
            const target = latestDay?.warmups.find((w) => w.id === warmDelete.warmId);
            if (!latestPlan || !latestDay || !target) {
              setWarmDelete(null);
              pushToast('这个热身项已经不存在了。');
              return;
            }
            const ok = await save(removeWarmup(latestPlan, latestDay.id, target.id));
            if (!ok) return;
            setWarmDelete(null);
            pushToast('热身项已删除，历史记录未受影响。');
          } finally {
            setDeleting(false);
          }
        }}
      />
    </main>
  );
}
