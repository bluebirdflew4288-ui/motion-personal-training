/* 共用动作编辑器（G2A）。
   ── 定位 ────────────────────────────────────────────────────
   添加首次配置与已有动作编辑共用同一组件；差别只有初始值、按钮文案与提交意图，
   由 props 传入，不复制两套表单。
   本轮只做组件与隔离真实 DOM 验证，不接生产 Session.tsx 入口；G2B 统一接线。

   ── 草稿契约（关键）─────────────────────────────────────────
   · raw（本地字符串）与结构化 target 分开；保存时**同步收集当前所有输入**，
     不依赖 blur 后异步 setState、也不依赖旧闭包。
   · 数字字段允许中间态（空 / "7." / 未完成小数）；保存前统一解析，非法即阻止并保留 raw。
   · 空参考次数显示空字符串，绝不用 0/0 假装未设置；0 仍是明确数值。
   · 字段以稳定键登记（普通组按 setIndex；阶段按稳定 stageId），不用数组 index。
   · 初始组数读 `arrangedGroups`（本次实际安排）而不是 target.sets，避免临时加组被重置。
   · 重渲染 / 父级 tick 不重建草稿；只有 initial.key 变化才重新初始化。
   · onSubmit 异步成功才请求关闭；同步 ref 防连点；失败保留全部 raw 与错误可重试。
   · 旧异步回调不会关闭随后打开的另一个编辑对象（实例内状态隔离）。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { ExerciseNamePicker, type ExerciseNameSelection } from './ExerciseNamePicker';
import { exerciseIdFromName } from '../domain/identity';
import {
  MAX_EXERCISE_ID,
  MAX_PLAN_NAME,
  MAX_REPS,
  MAX_REST,
  MAX_REST_IN_SEC,
  MAX_ROUNDS,
  MAX_STAGES,
  MAX_STAGES_ACCEPTED,
  MAX_STRAIGHT_SETS,
  MAX_WEIGHT,
  MIN_ROUNDS,
  MIN_STAGES,
} from '../domain/limits';
import {
  exerciseTemplateFromConfig,
  validateExerciseTarget,
  type ConfigIssue,
} from '../domain/exerciseConfig';
import { newStageId } from '../domain/dropSet';
import type {
  DropRoundConfig,
  DropStageTarget,
  DumbbellBasis,
  ExerciseTarget,
  ExerciseTemplate,
  StraightSetConfig,
  TrainingForm,
  WeightMode,
} from '../domain/types';
import {
  buildEditorState,
  buildTemplateApplyDraft,
  cloneConfigBaseline,
  cloneEditorState,
  cloneStageRows,
  computeBaselineMeta,
  resolveTemplateForSelection,
  type AppliedTemplateNotice,
  type AppliedTemplateUndoSnapshot,
  type ConfigBaseline,
  type EditorState,
  type ExerciseEditorInitial,
  type ExerciseEditorSubmitValue,
  type StageRow,
  type StraightRow,
} from './exerciseEditorDraft';

export type { ExerciseEditorInitial, ExerciseEditorSubmitValue };

interface Props {
  open: boolean;
  mode: 'add' | 'edit';
  initial: ExerciseEditorInitial;
  onSubmit: (value: ExerciseEditorSubmitValue) => Promise<{ ok: boolean; message?: string }>;
  onClose: (reason?: 'saved' | 'discarded' | 'closed') => void;
  onDirtyChange?: (dirty: boolean) => void;
  templates?: ExerciseTemplate[];
  templateError?: string | null;
}

type ParseResult = { ok: true; value: number | null } | { ok: false; message: string };

function parseField(
  raw: string,
  opts: { label: string; min: number; max: number; integer: boolean; nullable?: boolean },
): ParseResult {
  const text = raw.trim();
  if (text === '') {
    return opts.nullable ? { ok: true, value: null } : { ok: false, message: `${opts.label}不能为空` };
  }
  // 未完成的小数（"7." / "."）不是合法提交值，保留 raw 让用户继续输入
  if (text.endsWith('.') || text === '.' || text === '-' || text === '+') {
    return { ok: false, message: `${opts.label}不是完整数字` };
  }
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, message: `${opts.label}必须是数字` };
  if (opts.integer && !Number.isInteger(n)) return { ok: false, message: `${opts.label}必须是整数` };
  if (n < opts.min || n > opts.max) return { ok: false, message: `${opts.label}必须在 ${opts.min}–${opts.max} 之间` };
  return { ok: true, value: n };
}

function parseRepsPair(
  minRaw: string,
  maxRaw: string,
  label: string,
): { ok: true; repsMin: number | null; repsMax: number | null } | { ok: false; message: string } {
  const min = parseField(minRaw, { label: `${label}下限`, min: 0, max: MAX_REPS, integer: true, nullable: true });
  if (!min.ok) return min;
  const max = parseField(maxRaw, { label: `${label}上限`, min: 0, max: MAX_REPS, integer: true, nullable: true });
  if (!max.ok) return max;
  if ((min.value === null) !== (max.value === null)) {
    return { ok: false, message: `${label}参考次数必须同时填写上下限，或同时留空` };
  }
  if (min.value !== null && max.value !== null && min.value > max.value) {
    return { ok: false, message: `${label}下限不能大于上限` };
  }
  return { ok: true, repsMin: min.value, repsMax: max.value };
}

export function ExerciseEditor({
  open,
  mode,
  initial,
  onSubmit,
  onClose,
  onDirtyChange,
  templates,
  templateError,
}: Props) {
  const initialKey = initial.key ?? 'default';
  const boot = useMemo(() => buildEditorState(initial), [initialKey]);
  const initialBaseline = useMemo<ConfigBaseline>(
    () => ({
      target: structuredClone(initial.target),
      restSec: initial.restSec,
      ...(initial.arrangedGroups
        ? { arrangedGroups: initial.arrangedGroups.map((g) => ({ ...g })) }
        : {}),
    }),
    [initialKey],
  );

  const [name, setName] = useState(boot.name);
  const [en, setEn] = useState(boot.en);
  const [exerciseId, setExerciseId] = useState(boot.exerciseId);
  const [form, setForm] = useState<TrainingForm>(boot.form);
  const [setsRaw, setSetsRaw] = useState(boot.setsRaw);
  const [restRaw, setRestRaw] = useState(boot.restRaw);
  const [straightRows, setStraightRows] = useState<StraightRow[]>(boot.straightRows);
  const [roundsRaw, setRoundsRaw] = useState(boot.roundsRaw);
  const [stages, setStages] = useState<StageRow[]>(boot.stages);
  const [stageOverrides, setStageOverrides] = useState<Record<number, StageRow[]>>(boot.stageOverrides);
  const [roundRestInSecOverrides, setRoundRestInSecOverrides] = useState<Record<number, number>>(boot.roundRestInSecOverrides);
  const [activeRound, setActiveRound] = useState(1);
  const [roundRestRaw, setRoundRestRaw] = useState(boot.roundRestRaw);
  const [roundRestEdited, setRoundRestEdited] = useState(boot.roundRestEdited);
  const [weightMode, setWeightMode] = useState<WeightMode>(boot.weightMode);
  const [dumbbellBasis, setDumbbellBasis] = useState<DumbbellBasis | undefined>(boot.dumbbellBasis);
  const [remember, setRemember] = useState(boot.remember);
  /** 记忆元数据必须随最终名称/身份变化（不能用原身份的 mode/revision 套新身份） */
  const [memory, setMemory] = useState<NonNullable<ExerciseEditorInitial['memory']>>(
    initial.memory ?? { mode: 'none', revision: null },
  );
  /** M02：配置基准随带入的记忆 B 或撤销快照切换，不再把 A 的阶段上限/全局回退带给 B */
  const [configBaseline, setConfigBaseline] = useState<ConfigBaseline>(initialBaseline);
  const baselineMeta = useMemo(() => computeBaselineMeta(configBaseline), [configBaseline]);
  const [appliedNotice, setAppliedNotice] = useState<AppliedTemplateNotice | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<AppliedTemplateUndoSnapshot | null>(null);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [targetIssues, setTargetIssues] = useState<ConfigIssue[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const submittingRef = useRef(false);
  const dirtyRef = useRef(false);
  const mountedRef = useRef(true);
  /**
   * R2：编辑生命周期世代。`initial.key` 变化（同实例切到另一个编辑对象）
   * 或组件卸载都会推进该值；异步提交回来时世代不同 → 一律丢弃，
   * 不能关掉/污染随后打开的另一个编辑对象，也不能锁住它。
   */
  const epochRef = useRef(0);

  // StrictMode：setup 必须重新置 true，否则 dev 双挂载后永久判定为已卸载
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * open=false 时让所有在途提交失效：父级已关闭（但组件未卸载）时，
   * 迟到的成功/失败都不能再操作已关闭的草稿或把它重新打开。
   */
  useEffect(() => {
    if (!open) {
      epochRef.current += 1;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [open]);

  /** R3：正在输入法组合中的字段键（组合期间禁止提交，避免把半成品当真值） */
  const composingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    onDirtyChange?.(dirty);
    dirtyRef.current = dirty;
  }, [dirty, onDirtyChange]);

  const applyEditorState = (
    next: EditorState,
    opts: {
      activeRound: number;
      memory: NonNullable<ExerciseEditorInitial['memory']>;
      baseline: ConfigBaseline;
    },
  ) => {
    setName(next.name);
    setEn(next.en);
    setExerciseId(next.exerciseId);
    setForm(next.form);
    setSetsRaw(next.setsRaw);
    setRestRaw(next.restRaw);
    setStraightRows(next.straightRows);
    setRoundsRaw(next.roundsRaw);
    setStages(next.stages);
    setStageOverrides(next.stageOverrides);
    setRoundRestInSecOverrides(next.roundRestInSecOverrides);
    setActiveRound(opts.activeRound);
    setRoundRestRaw(next.roundRestRaw);
    setRoundRestEdited(next.roundRestEdited);
    setWeightMode(next.weightMode);
    setDumbbellBasis(next.dumbbellBasis);
    setRemember(next.remember);
    setMemory(opts.memory);
    setConfigBaseline(opts.baseline);
  };

  /**
   * 草稿重建时机（R2）：
   * · `initial.key` 变化 = 切到另一个编辑对象；
   * · 关闭后**重新打开**（即使同 key）= 用调用方最新值重新初始化。
   * 父级同 key 的普通重渲染 / tick 不重建，保留用户 raw。
   */
  const wasOpenRef = useRef(open);
  const lastInitKeyRef = useRef(initialKey);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    const keyChanged = initialKey !== lastInitKeyRef.current;
    lastInitKeyRef.current = initialKey;
    if (!justOpened && !keyChanged) return;
    epochRef.current += 1;
    submittingRef.current = false;
    composingRef.current.clear();
    const next = buildEditorState(initial);
    const nextBaseline: ConfigBaseline = {
      target: structuredClone(initial.target),
      restSec: initial.restSec,
      ...(initial.arrangedGroups
        ? { arrangedGroups: initial.arrangedGroups.map((g) => ({ ...g })) }
        : {}),
    };
    applyEditorState(next, {
      activeRound: 1,
      memory: initial.memory ?? { mode: 'none', revision: null },
      baseline: nextBaseline,
    });
    setAppliedNotice(null);
    setUndoSnapshot(null);
    setTemplateLoadError(null);
    setErrors({});
    setTargetIssues([]);
    setSubmitError(null);
    setDirty(false);
    dirtyRef.current = false;
    setLeaveOpen(false);
    setPickerOpen(false);
    setSubmitting(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKey]);

  const markDirty = () => {
    dirtyRef.current = true;
    setDirty(true);
  };
  const clearErr = (key: string) => setErrors((prev) => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    return next;
  });

  const changeSets = (next: string) => {
    setSetsRaw(next);
    markDirty();
    clearErr('sets');
    const parsed = parseField(next, { label: '组数', min: 1, max: MAX_STRAIGHT_SETS, integer: true });
    if (parsed.ok && parsed.value !== null) {
      setStraightRows((rows) => {
        const count = parsed.value as number;
        const out = rows.slice(0, count);
        while (out.length < count) {
          out.push({ setIndex: out.length + 1, weight: '', repsMin: '', repsMax: '', toFailure: false });
        }
        return out.map((row, i) => ({ ...row, setIndex: i + 1 }));
      });
    }
  };

  const parseRoundCount = (raw: string): number | null => {
    const parsed = parseField(raw, { label: '轮数', min: MIN_ROUNDS, max: MAX_ROUNDS, integer: true });
    return parsed.ok ? parsed.value : null;
  };
  /** R02：多阶段编辑器按轮展示；当前输入不合法时沿用当前配置基准轮数，避免 UI 抖动 */
  const effectiveRounds = form === 'straight' ? 1 : parseRoundCount(roundsRaw) ?? baselineMeta.fallbackRounds;
  const stagesForRound = (roundIndex: number): StageRow[] =>
    stageOverrides[roundIndex] ?? cloneStageRows(stages);
  const stageLimitForRound = (roundIndex: number): number => {
    const baseCount = baselineMeta.roundStageCounts[roundIndex - 1] ?? 0;
    return Math.max(MAX_STAGES, Math.min(MAX_STAGES_ACCEPTED, baseCount));
  };
  const stageMinForRound = (roundIndex: number): number => {
    const baseCount = baselineMeta.roundStageCounts[roundIndex - 1] ?? 0;
    return Math.min(MIN_STAGES, Math.max(1, baseCount));
  };

  const changeRounds = (next: string) => {
    setRoundsRaw(next);
    markDirty();
    clearErr('rounds');
    const parsed = parseRoundCount(next);
    if (parsed === null) return;
    const current = effectiveRounds;
    if (parsed < current) {
      setStageOverrides((prev) => {
        const out: Record<number, StageRow[]> = {};
        for (const [k, v] of Object.entries(prev)) if (Number(k) <= parsed) out[Number(k)] = v;
        return out;
      });
      setRoundRestInSecOverrides((prev) => {
        const out: Record<number, number> = {};
        for (const [k, v] of Object.entries(prev)) if (Number(k) <= parsed) out[Number(k)] = v;
        return out;
      });
      setActiveRound((r) => Math.min(r, parsed));
    } else if (parsed > current) {
      // R02：新增轮默认继承**紧邻上一轮**的结构（不是最初全局默认）
      setStageOverrides((prev) => {
        const out = { ...prev };
        const effective = (r: number): StageRow[] => out[r] ?? cloneStageRows(stages);
        for (let r = current + 1; r <= parsed; r += 1) {
          out[r] = cloneStageRows(effective(r - 1));
        }
        return out;
      });
      setRoundRestInSecOverrides((prev) => {
        const out = { ...prev };
        for (let r = current + 1; r <= parsed; r += 1) {
          if (out[r - 1] !== undefined) out[r] = out[r - 1];
        }
        return out;
      });
    }
  };

  const updateStraightRow = (setIndex: number, patch: Partial<StraightRow>) => {
    setStraightRows((rows) => rows.map((row) => (row.setIndex === setIndex ? { ...row, ...patch } : row)));
    markDirty();
  };

  const updateStage = (roundIndex: number, id: string, patch: Partial<StageRow>) => {
    // R02 FIX2（F2）：每一轮（含第 1 轮）都写自己的 override，绝不改共享默认模板。
    setStageOverrides((prev) => {
      const rows = prev[roundIndex] ?? cloneStageRows(stages);
      return { ...prev, [roundIndex]: rows.map((row) => (row.id === id ? { ...row, ...patch } : row)) };
    });
    markDirty();
  };

  const addStage = (roundIndex: number) => {
    if (stagesForRound(roundIndex).length >= stageLimitForRound(roundIndex)) return;
    setStageOverrides((prev) => {
      const rows = prev[roundIndex] ?? cloneStageRows(stages);
      return {
        ...prev,
        [roundIndex]: [
          ...rows,
          { id: newStageId(), label: `第 ${rows.length + 1} 阶段`, weight: '', repsMin: '', repsMax: '', toFailure: false, rest: '15' },
        ],
      };
    });
    markDirty();
  };

  const removeStage = (roundIndex: number, id: string) => {
    if (submittingRef.current) return;
    if (composingRef.current.size > 0) {
      setSubmitError('输入法仍在组合中，请先完成当前字/词再调整阶段');
      return;
    }
    if (stagesForRound(roundIndex).length <= stageMinForRound(roundIndex)) return;
    setStageOverrides((prev) => {
      const rows = prev[roundIndex] ?? cloneStageRows(stages);
      return { ...prev, [roundIndex]: rows.filter((row) => row.id !== id) };
    });
    markDirty();
  };

  const compositionHandlers = (key: string) => ({
    onCompositionStart: () => { composingRef.current.add(key); },
    onCompositionEnd: () => {
      composingRef.current.delete(key);
      setSubmitError(null);
    },
  });

  const switchForm = (next: TrainingForm) => {
    if (next === form) return;
    /**
     * 切形式不得把当前形式的未完成/非法 raw 隐藏后丢失：
     * 先按当前形式完整校验（同名/同 target 校验），不合法则留在原形式并定位错误；
     * 合法才切换，另一形式自己的草稿数组原样保留。
     */
    const current = buildPayload();
    if (!current) {
      setSubmitError('当前形式还有未完成或非法输入，请先修正后再切换形式');
      return;
    }
    setSubmitError(null);
    setForm(next);
    markDirty();
  };

  const selectName = (selection: ExerciseNameSelection) => {
    if (submittingRef.current) return;
    const finalExerciseId = selection.exerciseId;
    const initialExerciseId = initial.exerciseId ?? exerciseIdFromName(initial.name);

    // 同身份再选：只允许调整显示名，绝不重置 raw、结构、勾选或已捕获 revision
    if (finalExerciseId === exerciseId) {
      const nextEn = selection.en ?? '';
      const changedDisplay = selection.name !== name || nextEn !== en;
      setName(selection.name);
      setEn(nextEn);
      if (changedDisplay) markDirty();
      clearErr('name');
      return;
    }

    if (composingRef.current.size > 0) {
      setSubmitError('输入法仍在组合中，请先完成当前字/词再切换动作');
      return;
    }

    const resolution = resolveTemplateForSelection({
      templates,
      exerciseId: finalExerciseId,
      templateError,
      exerciseName: selection.name,
    });

    // F1：记忆读取异常或损坏时绝不切换身份/来源，也绝不清除原动作的记忆意图
    if (resolution.kind === 'error') {
      setTemplateLoadError(resolution.message);
      return;
    }

    if (resolution.kind === 'found') {
      const snapshot: AppliedTemplateUndoSnapshot = {
        state: cloneEditorState({
          name,
          en,
          exerciseId,
          form,
          setsRaw,
          restRaw,
          straightRows,
          roundsRaw,
          stages,
          stageOverrides,
          roundRestInSecOverrides,
          roundRestRaw,
          roundRestEdited,
          weightMode,
          dumbbellBasis,
          remember,
        }),
        activeRound,
        memory: { ...memory },
        configBaseline: cloneConfigBaseline(configBaseline),
        dirty: dirtyRef.current,
        errors: { ...errors },
        targetIssues: [...targetIssues],
        submitError,
        templateLoadError,
      };
      const applied = buildTemplateApplyDraft({
        selection,
        template: resolution.template,
        key: initialKey,
      });
      composingRef.current.clear();
      applyEditorState(applied.state, {
        activeRound: 1,
        memory: applied.memory,
        baseline: applied.baseline,
      });
      setUndoSnapshot(snapshot);
      setAppliedNotice({
        exerciseId: finalExerciseId,
        exerciseName: selection.name,
      });
      setTemplateLoadError(null);
      setErrors({});
      setTargetIssues([]);
      setSubmitError(null);
      markDirty();
      return;
    }

    setName(selection.name);
    setEn(selection.en ?? '');
    setExerciseId(finalExerciseId);
    if (finalExerciseId === initialExerciseId) setWeightMode(initial.target.weightMode);
    else setWeightMode('external');
    setAppliedNotice(null);
    setUndoSnapshot(null);
    // 无记忆 B：保留当前配置/raw，进入首次记住语义
    setMemory({ mode: 'first', revision: null });
    setRemember(true);
    setTemplateLoadError(null);
    markDirty();
    clearErr('name');
  };

  const undoAppliedTemplate = () => {
    if (submittingRef.current || !undoSnapshot) return;
    if (composingRef.current.size > 0) {
      setSubmitError('输入法仍在组合中，请先完成当前字/词再撤销带入');
      return;
    }
    composingRef.current.clear();
    applyEditorState(cloneEditorState(undoSnapshot.state), {
      activeRound: undoSnapshot.activeRound,
      memory: { ...undoSnapshot.memory },
      baseline: cloneConfigBaseline(undoSnapshot.configBaseline),
    });
    setErrors({ ...undoSnapshot.errors });
    setTargetIssues([...undoSnapshot.targetIssues]);
    setSubmitError(undoSnapshot.submitError);
    setTemplateLoadError(undoSnapshot.templateLoadError);
    dirtyRef.current = undoSnapshot.dirty;
    setDirty(undoSnapshot.dirty);
    setAppliedNotice(null);
    setUndoSnapshot(null);
  };

  const buildPayload = (): ExerciseEditorSubmitValue | null => {
    /**
     * R3：输入法组合中不得提交（也绝不把旧值/截断值当成本次输入）。
     * 组合结束后用户再点保存即可。
     */
    if (composingRef.current.size > 0) {
      setSubmitError('输入法仍在组合中，请先完成当前字/词再保存');
      return null;
    }
    const nextErrors: Record<string, string> = {};
    const trimmedName = name.trim();
    if (!trimmedName) nextErrors.name = '动作名不能为空';
    else if (trimmedName.length > MAX_PLAN_NAME) nextErrors.name = `动作名最多 ${MAX_PLAN_NAME} 个字符`;
    else if (exerciseId.length > MAX_EXERCISE_ID) {
      nextErrors.name = `名称过长：生成的动作身份超出可存储上限（最多 ${MAX_EXERCISE_ID} 字符）`;
    }

    let target: ExerciseTarget | null = null;
    let restSec = configBaseline.restSec;

    if (form === 'straight') {
      const setsParsed = parseField(setsRaw, { label: '组数', min: 1, max: MAX_STRAIGHT_SETS, integer: true });
      if (!setsParsed.ok) nextErrors.sets = setsParsed.message;
      const restParsed = parseField(restRaw, { label: '组间休息', min: 0, max: MAX_REST, integer: true });
      if (!restParsed.ok) nextErrors.rest = restParsed.message;

      const count = setsParsed.ok && setsParsed.value !== null ? setsParsed.value : 0;
      const perSetConfigs: StraightSetConfig[] = [];
      let firstPair: { repsMin: number | null; repsMax: number | null } | null = null;
      let firstWeight: number | null = null;
      for (let i = 0; i < count; i += 1) {
        const row = straightRows[i] ?? { setIndex: i + 1, weight: '', repsMin: '', repsMax: '', toFailure: false };
        const weight = parseField(row.weight, { label: `第 ${i + 1} 组重量`, min: 0, max: MAX_WEIGHT, integer: false, nullable: true });
        if (!weight.ok) nextErrors[`group-${i}-weight`] = weight.message;
        const pair = parseRepsPair(row.repsMin, row.repsMax, `第 ${i + 1} 组`);
        if (!pair.ok) nextErrors[`group-${i}-reps`] = pair.message;
        if (i === 0) {
          firstPair = pair.ok ? { repsMin: pair.repsMin, repsMax: pair.repsMax } : null;
          firstWeight = weight.ok ? weight.value : null;
        }
        perSetConfigs.push({
          setIndex: i + 1,
          repsMin: pair.ok ? pair.repsMin : null,
          repsMax: pair.ok ? pair.repsMax : null,
          suggestedWeightKg: weight.ok ? weight.value : null,
          toFailure: row.toFailure,
        });
      }
      if (count > 0) {
        const base = configBaseline.target.kind === 'straight' ? configBaseline.target : null;
        const globalMin = firstPair?.repsMin ?? base?.repsMin ?? 8;
        const globalMax = firstPair?.repsMax ?? base?.repsMax ?? 12;
        target = {
          kind: 'straight',
          sets: count,
          setsMax: count,
          repsMin: globalMin,
          repsMax: globalMax,
          weightMode,
          ...(dumbbellBasis ? { dumbbellBasis } : {}),
          suggestedWeightKg: firstWeight,
          perSetConfigs,
        };
      }
      if (restParsed.ok && restParsed.value !== null) restSec = restParsed.value;
    } else {
      const roundsParsed = parseField(roundsRaw, { label: '轮数', min: MIN_ROUNDS, max: MAX_ROUNDS, integer: true });
      if (!roundsParsed.ok) nextErrors.rounds = roundsParsed.message;
      const roundRestParsed = parseField(roundRestRaw, { label: '整轮休息', min: 0, max: MAX_REST, integer: true });
      if (!roundRestParsed.ok) nextErrors.roundRest = roundRestParsed.message;
      const buildStageRows = (rows: StageRow[], keyPrefix: string): StageRowBuilt[] => {
        const outStages: StageRowBuilt[] = [];
        rows.forEach((stage, i) => {
          const key = `${keyPrefix}-${i}`;
          const label = stage.label.trim();
          if (!label) nextErrors[`${key}-label`] = '阶段名不能为空';
          else if (label.length > 100) nextErrors[`${key}-label`] = '阶段名最多 100 个字符';
          const weight = parseField(stage.weight, { label: `第 ${i + 1} 阶段重量`, min: 0, max: MAX_WEIGHT, integer: false, nullable: true });
          if (!weight.ok) nextErrors[`${key}-weight`] = weight.message;
          const pair = parseRepsPair(stage.repsMin, stage.repsMax, `第 ${i + 1} 阶段`);
          if (!pair.ok) nextErrors[`${key}-reps`] = pair.message;
          let restAfterSec: number | undefined;
          if (i < rows.length - 1) {
            const rest = parseField(stage.rest, { label: `第 ${i + 1} 阶段短间歇`, min: 0, max: MAX_REST_IN_SEC, integer: true });
            if (!rest.ok) nextErrors[`${key}-rest`] = rest.message;
            else if (rest.value !== null) restAfterSec = rest.value;
          }
          outStages.push({
            id: stage.id,
            label,
            weightKg: weight.ok ? weight.value : null,
            repsMin: pair.ok ? pair.repsMin : null,
            repsMax: pair.ok ? pair.repsMax : null,
            toFailure: stage.toFailure,
            ...(restAfterSec !== undefined ? { restAfterSec } : {}),
          });
        });
        return outStages;
      };
      const builtByRound: StageRowBuilt[][] = [];
      const roundCount = roundsParsed.ok && roundsParsed.value !== null ? roundsParsed.value : 0;
      for (let r = 1; r <= roundCount; r += 1) {
        builtByRound.push(buildStageRows(stagesForRound(r), r === 1 ? 'stage' : `stage-r${r}`));
      }
      /**
       * R02 FIX2（F2/F3）：默认模板与第 1 轮生效视图分离。
       * · 单轮且当前配置基准没有第 1 轮 override：第 1 轮就是默认模板，编辑直接落到 stages；
       * · 其它情况：`stages` 状态是默认模板，所有与默认不同的轮（含第 1 轮）
       *   逐轮写成 roundConfigs，保存时绝不改写其他默认轮。
       */
      const defaultBuilt =
        roundCount === 1 && !baselineMeta.hasRound1Override
          ? builtByRound[0]
          : buildStageRows(stages, 'default-stage');
      if (roundsParsed.ok && roundRestParsed.ok && roundsParsed.value !== null && roundRestParsed.value !== null && builtByRound.length) {
        const defaultStages: DropStageTarget[] = defaultBuilt.map((s) => ({ ...s, targetText: '' }));
        const roundConfigs: DropRoundConfig[] = [];
        const signature = (list: StageRowBuilt[]) => JSON.stringify(list.map((s) => ({ ...s, targetText: '' })));
        const defaultSignature = signature(defaultBuilt);
        const firstRest = defaultStages[0]?.restAfterSec ?? 0;
        const baseRestInSec = configBaseline.target.kind === 'dropSet' ? configBaseline.target.restInSec : firstRest;
        for (let r = 1; r <= builtByRound.length; r += 1) {
          const roundRestInSec = roundRestInSecOverrides[r];
          const stagesChanged = signature(builtByRound[r - 1]) !== defaultSignature;
          const restInSecChanged = roundRestInSec !== undefined && roundRestInSec !== baseRestInSec;
          // 只把与默认模板不同（或有独立逐轮 restInSec 覆盖）的轮写成覆盖，绝不重写未修改的其他轮。
          if (stagesChanged || restInSecChanged) {
            roundConfigs.push({
              roundIndex: r,
              ...(roundRestInSec !== undefined ? { restInSec: roundRestInSec } : {}),
              stages: builtByRound[r - 1].map((s) => ({ ...s, targetText: '' })),
            });
          }
        }
        target = {
          kind: 'dropSet',
          ...(form === 'superset' ? { form: 'superset' as const } : {}),
          rounds: roundsParsed.value,
          stages: defaultStages,
          ...(roundConfigs.length ? { roundConfigs } : {}),
          restInSec: baseRestInSec,
          restAfterSec: roundRestParsed.value,
          weightMode,
          ...(dumbbellBasis ? { dumbbellBasis } : {}),
        };
        const keepBaselineRestSec =
          configBaseline.target.kind === 'dropSet' &&
          !roundRestEdited &&
          roundRestParsed.value === configBaseline.target.restAfterSec;
        restSec = keepBaselineRestSec ? configBaseline.restSec : roundRestParsed.value;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !target) return null;
    const maxAllowedStages = Math.max(MAX_STAGES, ...baselineMeta.roundStageCounts);
    const targetIssuesNow = validateExerciseTarget(target, {
      minStages: Math.min(MIN_STAGES, Math.max(1, baselineMeta.minStageCount)),
      maxStages: Math.min(MAX_STAGES_ACCEPTED, maxAllowedStages),
    });
    setTargetIssues(targetIssuesNow);
    if (targetIssuesNow.length > 0) return null;

    const shouldRemember = memory.mode !== 'none' && remember;
    // F2：打开后若记忆变为读取异常/损坏，拒绝携带写默认保存，保留全部草稿与用户勾选
    if (shouldRemember && templateError) {
      setSubmitError(
        memory.mode === 'first'
          ? `动作配置记忆异常（${templateError}），暂不能保存为默认配置；已保留全部草稿，不会覆盖记忆。`
          : `动作配置记忆异常（${templateError}），无法同时更新默认配置；请先取消勾选仅保存本次调整，或修复后再重试。已保留全部草稿。`,
      );
      return null;
    }
    if (shouldRemember && templates?.some((t) => t.exerciseId === exerciseId)) {
      const currentResolution = resolveTemplateForSelection({
        templates,
        exerciseId,
        templateError: null,
        exerciseName: trimmedName,
      });
      if (currentResolution.kind === 'error') {
        setSubmitError(`${currentResolution.message}。无法同时写入默认配置，已保留全部草稿。`);
        return null;
      }
    }
    const templateExpectedRevision = shouldRemember && memory.mode === 'exists' ? memory.revision : null;
    return {
      name: trimmedName,
      ...(en.trim() ? { en: en.trim() } : {}),
      exerciseId,
      target,
      restSec,
      remember: shouldRemember,
      templateExpectedRevision,
      ...(shouldRemember
        ? {
            template: exerciseTemplateFromConfig({
              exerciseId,
              name: trimmedName,
              ...(en.trim() ? { en: en.trim() } : {}),
              target,
              restSec,
            }),
          }
        : {}),
    };
  };

  const submit = async () => {
    if (submittingRef.current) return;
    const payload = buildPayload();
    if (!payload) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const myEpoch = epochRef.current;
    /** 结果是否仍属于当前这次编辑（卸载 / 切到另一个编辑对象后一律作废） */
    const belongs = () => mountedRef.current && epochRef.current === myEpoch;
    try {
      const result = await onSubmit(payload);
      if (!belongs()) return;
      if (result.ok) {
        dirtyRef.current = false;
        setDirty(false);
        onDirtyChange?.(false);
        onClose('saved');
      } else {
        setSubmitError(result.message ?? '保存失败，请重试');
      }
    } catch (err) {
      if (!belongs()) return;
      setSubmitError(err instanceof Error ? err.message : '保存失败，请重试');
    } finally {
      if (belongs()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const requestClose = () => {
    if (submittingRef.current) return;
    if (dirtyRef.current) {
      setLeaveOpen(true);
      return;
    }
    onClose('closed');
  };

  const discardAndClose = () => {
    const next = buildEditorState(initial);
    const nextBaseline: ConfigBaseline = {
      target: structuredClone(initial.target),
      restSec: initial.restSec,
      ...(initial.arrangedGroups
        ? { arrangedGroups: initial.arrangedGroups.map((g) => ({ ...g })) }
        : {}),
    };
    applyEditorState(next, {
      activeRound: 1,
      memory: initial.memory ?? { mode: 'none', revision: null },
      baseline: nextBaseline,
    });
    setAppliedNotice(null);
    setUndoSnapshot(null);
    setTemplateLoadError(null);
    setErrors({});
    setTargetIssues([]);
    setSubmitError(null);
    dirtyRef.current = false;
    setDirty(false);
    setLeaveOpen(false);
    onClose('discarded');
  };

  const errText = (key: string) => errors[key];
  const visibleTemplateError =
    templateLoadError ??
    (templateError ? `动作配置记忆异常（${templateError}），暂不自动带入且不会覆盖记忆` : null);

  return (
    <>
      <Sheet
        open={open}
        title={mode === 'add' ? '添加动作' : '编辑动作'}
        onClose={requestClose}
        autoFocusPanel={false}
        footer={
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} data-testid="editor-cancel" onClick={requestClose} disabled={submitting}>
              取消
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} data-testid="editor-save" onClick={() => void submit()} disabled={submitting}>
              {submitting ? '保存中…' : mode === 'add' ? '添加' : '保存'}
            </button>
          </div>
        }
      >
        <div
          data-testid="exercise-editor"
          style={{ maxHeight: '62vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}
        >
          <div className="field">
            <label>动作名称</label>
            <button
              type="button"
              data-testid="editor-name-button"
              className="input"
              style={{ textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
              disabled={submitting}
              onClick={() => {
                if (submittingRef.current) return;
                if (composingRef.current.size > 0) {
                  setSubmitError('输入法仍在组合中，请先完成当前字/词再选择动作');
                  return;
                }
                setPickerOpen(true);
              }}
            >
              <span style={{ overflowWrap: 'anywhere' }}>{name || '选择或输入动作'}</span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink-4)' }}>选择 ›</span>
            </button>
            {errText('name') ? <span data-testid="error-name" style={{ color: 'var(--brick)', fontSize: 12 }}>{errText('name')}</span> : null}
          </div>

          {appliedNotice ? (
            <div
              data-testid="editor-template-applied"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '8px 10px',
                border: '1px solid var(--rule)',
                fontSize: 12,
                color: 'var(--ink-2)',
              }}
            >
              <span style={{ overflowWrap: 'anywhere' }}>
                已带入「{appliedNotice.exerciseName}」的默认配置
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="editor-undo-apply"
                onClick={undoAppliedTemplate}
                disabled={submitting}
                style={{ whiteSpace: 'nowrap' }}
              >
                撤销带入
              </button>
            </div>
          ) : null}

          {visibleTemplateError ? (
            <div
              data-testid="editor-template-error"
              style={{
                padding: '8px 10px',
                border: '1px solid var(--brick)',
                color: 'var(--brick)',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {visibleTemplateError}
            </div>
          ) : null}

          <div className="field">
            <label>训练形式</label>
            <div className="segmented">
              {(['straight', 'superset', 'dropSet'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`editor-form-${value}`}
                  aria-pressed={form === value}
                  onClick={() => switchForm(value)}
                >
                  {value === 'straight' ? '普通组' : value === 'superset' ? '超级组' : '递减组'}
                </button>
              ))}
            </div>
          </div>

          {/* W02：取消四模式选择；统一直接填重量（kg），仅旧 assisted 展示非阻塞兼容来源说明 */}
          {weightMode === 'assisted' ? (
            <div data-testid="editor-legacy-assisted-note" style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5 }}>
              沿用历史辅助重量口径（统计与普通负重分开；直接填写器械重量 kg 即可）
            </div>
          ) : null}

          <div className="field">
            <label>哑铃口径（仅哑铃动作）</label>
            <div className="segmented" role="group" aria-label="哑铃口径">
              {(
                [
                  ['per_hand', '按单只'],
                  ['total', '按合计'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`editor-dumbbell-basis-${value}`}
                  aria-pressed={(dumbbellBasis ?? 'total') === value}
                  onClick={() => {
                    if ((dumbbellBasis ?? 'total') === value) return;
                    setDumbbellBasis(value);
                    markDirty();
                  }}
                  style={{ fontSize: 12 }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {form === 'straight' ? (
            <div data-testid="editor-straight" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="editor-sets">组数</label>
                  <input
                    id="editor-sets"
                    data-testid="editor-sets"
                    className="input input-num"
                    inputMode="numeric"
                    value={setsRaw}
                    {...compositionHandlers('editor-sets')}
                    onChange={(e) => changeSets(e.target.value)}
                  />
                  {errText('sets') ? <span style={{ color: 'var(--brick)', fontSize: 12 }}>{errText('sets')}</span> : null}
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="editor-rest">组间休息（秒）</label>
                  <input
                    id="editor-rest"
                    data-testid="editor-rest"
                    className="input input-num"
                    inputMode="numeric"
                    value={restRaw}
                    {...compositionHandlers('editor-rest')}
                    onChange={(e) => { setRestRaw(e.target.value); markDirty(); clearErr('rest'); }}
                  />
                  {errText('rest') ? <span style={{ color: 'var(--brick)', fontSize: 12 }}>{errText('rest')}</span> : null}
                </div>
              </div>
              {straightRows.map((row, i) => (
                <div key={row.setIndex} data-testid={`group-row-${i}`} style={{ border: '1px solid var(--rule)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 13 }}>第 {i + 1} 组</strong>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                      <input
                        type="checkbox"
                        data-testid={`group-${i}-failure`}
                        checked={row.toFailure}
                        onChange={(e) => updateStraightRow(row.setIndex, { toFailure: e.target.checked })}
                      />
                      力竭
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>重量 kg</span>
                      <input
                        className="input"
                        data-testid={`group-${i}-weight`}
                        aria-label={`第 ${i + 1} 组重量`}
                        placeholder="—"
                        inputMode="decimal"
                        value={row.weight}
                        {...compositionHandlers(`group-${i}-weight`)}
                        onChange={(e) => { updateStraightRow(row.setIndex, { weight: e.target.value }); clearErr(`group-${i}-weight`); }}
                      />
                    </label>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>次数下限</span>
                      <input
                        className="input"
                        data-testid={`group-${i}-reps-min`}
                        aria-label={`第 ${i + 1} 组参考次数下限`}
                        placeholder="—"
                        inputMode="numeric"
                        value={row.repsMin}
                        {...compositionHandlers(`group-${i}-reps-min`)}
                        onChange={(e) => { updateStraightRow(row.setIndex, { repsMin: e.target.value }); clearErr(`group-${i}-reps`); }}
                      />
                    </label>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>次数上限</span>
                      <input
                        className="input"
                        data-testid={`group-${i}-reps-max`}
                        aria-label={`第 ${i + 1} 组参考次数上限`}
                        placeholder="—"
                        inputMode="numeric"
                        value={row.repsMax}
                        {...compositionHandlers(`group-${i}-reps-max`)}
                        onChange={(e) => { updateStraightRow(row.setIndex, { repsMax: e.target.value }); clearErr(`group-${i}-reps`); }}
                      />
                    </label>
                  </div>
                  {errText(`group-${i}-weight`) || errText(`group-${i}-reps`) ? (
                    <span style={{ color: 'var(--brick)', fontSize: 12 }}>
                      {errText(`group-${i}-weight`) ?? ''} {errText(`group-${i}-reps`) ?? ''}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <div data-testid="editor-multi" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="editor-rounds">轮数</label>
                  <input
                    id="editor-rounds"
                    data-testid="editor-rounds"
                    className="input input-num"
                    inputMode="numeric"
                    value={roundsRaw}
                    {...compositionHandlers('editor-rounds')}
                    onChange={(e) => changeRounds(e.target.value)}
                  />
                  {errText('rounds') ? <span style={{ color: 'var(--brick)', fontSize: 12 }}>{errText('rounds')}</span> : null}
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label htmlFor="editor-round-rest">整轮休息（秒）</label>
                  <input
                    id="editor-round-rest"
                    data-testid="editor-round-rest"
                    className="input input-num"
                    inputMode="numeric"
                    value={roundRestRaw}
                    {...compositionHandlers('editor-round-rest')}
                    onChange={(e) => { setRoundRestRaw(e.target.value); setRoundRestEdited(true); markDirty(); clearErr('roundRest'); }}
                  />
                  {errText('roundRest') ? <span style={{ color: 'var(--brick)', fontSize: 12 }}>{errText('roundRest')}</span> : null}
                </div>
              </div>
              {effectiveRounds > 1 ? (
                <div className="segmented" role="group" aria-label="逐轮配置" style={{ flexWrap: 'wrap' }}>
                  {Array.from({ length: effectiveRounds }, (_, idx) => idx + 1).map((r) => (
                    <button
                      key={r}
                      type="button"
                      data-testid={`round-tab-${r}`}
                      aria-pressed={activeRound === r}
                      onClick={() => setActiveRound(r)}
                      style={{ fontSize: 12, minWidth: 72 }}
                    >
                      第 {r} 轮 · {stagesForRound(r).length} 阶段
                    </button>
                  ))}
                </div>
              ) : null}
              {stagesForRound(activeRound).map((stage, i) => {
                const r = activeRound;
                const rows = stagesForRound(r);
                const p = r === 1 ? `stage-${i}` : `stage-r${r}-${i}`;
                return (
                <div key={stage.id} data-testid={r === 1 ? `stage-row-${i}` : `stage-row-r${r}-${i}`} style={{ border: '1px solid var(--rule)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      className="input"
                      data-testid={`${p}-label`}
                      aria-label={`第 ${i + 1} 阶段名称`}
                      placeholder="阶段名（如 上半程）"
                      value={stage.label}
                      {...compositionHandlers(`${p}-label`)}
                      onChange={(e) => { updateStage(r, stage.id, { label: e.target.value }); clearErr(`${p}-label`); }}
                    />
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        data-testid={`${p}-failure`}
                        checked={stage.toFailure}
                        onChange={(e) => updateStage(r, stage.id, { toFailure: e.target.checked })}
                      />
                      力竭
                    </label>
                    <button type="button" className="btn btn-ghost btn-sm" data-testid={`${p}-remove`} onClick={() => removeStage(r, stage.id)} disabled={rows.length <= stageMinForRound(r)}>
                      删
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>重量 kg</span>
                      <input
                        className="input"
                        data-testid={`${p}-weight`}
                        aria-label={`第 ${i + 1} 阶段重量`}
                        placeholder="—"
                        inputMode="decimal"
                        value={stage.weight}
                        {...compositionHandlers(`${p}-weight`)}
                        onChange={(e) => { updateStage(r, stage.id, { weight: e.target.value }); clearErr(`${p}-weight`); }}
                      />
                    </label>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>次数下限</span>
                      <input
                        className="input"
                        data-testid={`${p}-reps-min`}
                        aria-label={`第 ${i + 1} 阶段参考次数下限`}
                        placeholder="—"
                        inputMode="numeric"
                        value={stage.repsMin}
                        {...compositionHandlers(`${p}-reps-min`)}
                        onChange={(e) => { updateStage(r, stage.id, { repsMin: e.target.value }); clearErr(`${p}-reps`); }}
                      />
                    </label>
                    <label style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>次数上限</span>
                      <input
                        className="input"
                        data-testid={`${p}-reps-max`}
                        aria-label={`第 ${i + 1} 阶段参考次数上限`}
                        placeholder="—"
                        inputMode="numeric"
                        value={stage.repsMax}
                        {...compositionHandlers(`${p}-reps-max`)}
                        onChange={(e) => { updateStage(r, stage.id, { repsMax: e.target.value }); clearErr(`${p}-reps`); }}
                      />
                    </label>
                  </div>
                  {i < rows.length - 1 ? (
                    <div className="field">
                      <label htmlFor={`${p}-rest`}>短间歇（秒）</label>
                      <input
                        id={`${p}-rest`}
                        data-testid={`${p}-rest`}
                        className="input input-num"
                        inputMode="numeric"
                        value={stage.rest}
                        {...compositionHandlers(`${p}-rest`)}
                        onChange={(e) => { updateStage(r, stage.id, { rest: e.target.value }); clearErr(`${p}-rest`); }}
                      />
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>末阶段直接接整轮休息（不叠加短间歇）</span>
                  )}
                  {errText(`${p}-label`) || errText(`${p}-weight`) || errText(`${p}-reps`) || errText(`${p}-rest`) ? (
                    <span style={{ color: 'var(--brick)', fontSize: 12 }}>
                      {errText(`${p}-label`) ?? ''} {errText(`${p}-weight`) ?? ''} {errText(`${p}-reps`) ?? ''} {errText(`${p}-rest`) ?? ''}
                    </span>
                  ) : null}
                </div>
                );
              })}
              <button
                type="button"
                className="btn btn-ghost"
                data-testid={activeRound === 1 ? 'editor-add-stage' : `stage-r${activeRound}-add-stage`}
                onClick={() => addStage(activeRound)}
                disabled={stagesForRound(activeRound).length >= stageLimitForRound(activeRound)}
              >
                + 添加阶段
              </button>
            </div>
          )}

          {/*
            F05 / M01：首次没有"可选"这回事——不再放灰色禁用复选框冒充控件，
            改为静态说明；首次保存仍然**原子**写入训练与这份配置记忆。
            已有记忆时才出现真正的可选复选框，默认**不勾**（不勾只保存训练、不覆盖旧记忆）。
          */}
          {memory.mode === 'first' ? (
            <p
              data-testid="editor-remember-static"
              style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55 }}
            >
              首次保存后，这套配置将作为此动作的默认配置，添加或替换时自动带入
            </p>
          ) : memory.mode === 'exists' ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                data-testid="editor-remember"
                checked={remember}
                onChange={(e) => { setRemember(e.target.checked); markDirty(); }}
              />
              将当前配置设为此动作的默认配置
            </label>
          ) : null}

          {targetIssues.length ? (
            <div data-testid="editor-target-errors" style={{ color: 'var(--brick)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {targetIssues.map((issue) => (
                <span key={`${issue.path}-${issue.message}`}>{issue.path}：{issue.message}</span>
              ))}
            </div>
          ) : null}
          {submitError ? (
            <div data-testid="editor-submit-error" style={{ color: 'var(--brick)', fontSize: 13 }}>{submitError}</div>
          ) : null}
        </div>
      </Sheet>

      <ExerciseNamePicker
        open={pickerOpen}
        currentName={name}
        templates={templates}
        onSelect={selectName}
        onClose={() => setPickerOpen(false)}
      />

      <Sheet
        open={leaveOpen}
        title="放弃未保存的修改？"
        onClose={() => setLeaveOpen(false)}
        footer={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} data-testid="leave-continue" onClick={() => setLeaveOpen(false)}>
              继续编辑
            </button>
            <button className="btn btn-ghost" style={{ flex: 1 }} data-testid="leave-discard" onClick={discardAndClose}>
              放弃
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} data-testid="leave-save" onClick={() => { setLeaveOpen(false); void submit(); }}>
              保存
            </button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)' }}>当前编辑还有未保存内容。选择保存、放弃，或继续编辑。</p>
      </Sheet>
    </>
  );
}

interface StageRowBuilt {
  id: string;
  label: string;
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  toFailure: boolean;
  restAfterSec?: number;
}
