/* 通用递减组构造（C01）。
   目标：任意动作都能被配置成递减组，不依赖名称或预设。
   两条入口共用这里的纯函数：
   A. 计划编辑（影响未来训练）
   B. 正在训练（只影响本次）

   约束：
   · 阶段数 2–6（超限明确报错，不静默裁剪）
   · 每阶段：建议重量、次数范围 或 技术性力竭
   · 阶段间休息 + 轮间休息
   · 已有实际记录的结构修改只能作用于「未开始的完整组/轮」
   · R02：同一递减组/超级组支持逐轮不同阶段数（默认 stages + roundOverrides） */

import type { DropRoundConfig, DropSetTarget, DropStageTarget, ExerciseTarget, StraightTarget } from './types';
import { MAX_REST_IN_SEC, MAX_ROUNDS, MAX_SET_ROWS, MAX_STAGES, MAX_STRAIGHT_SETS, MIN_ROUNDS, MIN_STAGES } from './limits';
import {
  defaultStageIdentityAt,
  inferRoundStageIdentities,
  reservedStageIdsForStages,
  resolveRoundStageIdentities,
  roundStagesOf,
} from './exerciseConfig';

export { MAX_ROUNDS, MAX_STAGES, MIN_ROUNDS, MIN_STAGES };

/** 新阶段稳定 ID（仅用于新配置/新会话快照，不回写旧计划与旧历史） */
export function newStageId(): string {
  return `stage-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface StageDraft {
  /** 阶段稳定 ID（新配置写入时生成；编辑已有目标时沿用） */
  id?: string;
  /** 自定义阶段名（如 上半程 / 下半程 / 全程）；缺省由序号生成旧默认名 */
  label?: string;
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  toFailure: boolean;
  /** 该阶段后的独立短间歇（秒）；末阶段忽略，直接接整轮休息 */
  restAfterSec?: number;
}

/** R02 逐轮草稿：只保存与默认 stages 不同的轮（计划/训练编辑器共用） */
export interface DropRoundDraft {
  roundIndex: number;
  stages: StageDraft[];
  /** 该轮阶段间默认短间歇；缺省回退 DropSetDraft.restInSec */
  restInSec?: number;
}

export interface DropSetDraft {
  /** 显式形式：缺省 'dropSet'（旧语义）；'superset' = 超级组 */
  form?: 'dropSet' | 'superset';
  rounds: number;
  /** 第一轮/默认阶段配置；第 2..N 轮没有覆盖时沿用这里 */
  stages: StageDraft[];
  /** 逐轮覆盖（R02，可选）：只写与默认不同的轮 */
  roundOverrides?: DropRoundDraft[];
  restInSec: number;
  restAfterSec: number;
  weightMode: StraightTarget['weightMode'];
  dumbbellBasis?: StraightTarget['dumbbellBasis'];
  /** 从普通组转换时的原组数（仅用于界面提示「N 组 → N 轮」），不写入目标 */
  sourceSets?: number;
}

export interface DraftIssue {
  path: string;
  message: string;
}

/** 默认 3 阶段配置（最常见的递减结构，但用户可以改成 2–6） */
export function defaultDropDraft(base?: { weightKg?: number | null; repsMin?: number; repsMax?: number }): DropSetDraft {
  const w = base?.weightKg ?? null;
  const lo = base?.repsMin ?? 8;
  const hi = base?.repsMax ?? 12;
  return {
    rounds: 3,
    stages: [
      { id: newStageId(), weightKg: w, repsMin: lo, repsMax: hi, toFailure: false },
      {
        id: newStageId(),
        weightKg: w !== null ? Math.max(0, w * 0.8) : null,
        repsMin: lo,
        repsMax: hi,
        toFailure: false,
      },
      { id: newStageId(), weightKg: w !== null ? Math.max(0, w * 0.6) : null, repsMin: null, repsMax: null, toFailure: true },
    ],
    restInSec: 15,
    restAfterSec: 180,
    weightMode: 'external',
  };
}

/**
 * 把普通组目标转成递减组草稿。
 * V3-05：必须保留计量口径（weightMode / dumbbellBasis）——
 * 旧实现走 defaultDropDraft，把辅助 70kg 变成外部负重、并丢掉「哑铃按单只」，
 * 用户没有明确改口径，含义却被改变了（审查 F-MODE-CONVERT）。
 * 同时保留普通组的组数意图（作为递减轮数的初值），并在草稿里记住来源组数，
 * 便于 UI 明确展示「这次转换会变成几轮」。
 */
export function straightToDropDraft(t: StraightTarget): DropSetDraft {
  const base = defaultDropDraft({
    weightKg: t.suggestedWeightKg,
    repsMin: t.repsMin,
    repsMax: t.repsMax,
  });
  return {
    ...base,
    // 组数 → 轮数：普通 3 组转递减默认 3 轮，用户仍可改
    rounds: Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, t.sets || base.rounds)),
    weightMode: t.weightMode,
    dumbbellBasis: t.dumbbellBasis,
    sourceSets: t.sets,
  };
}

/** 目标某轮的真实阶段配置（R02 单一真源；包含“额外轮按最后声明轮回退”的兼容口径） */
export function roundStagesOfTarget(t: DropSetTarget, roundIndex: number): DropStageTarget[] {
  return roundStagesOf(t, roundIndex);
}

/** 递减组目标转普通组目标（V3-05：同样保留计量口径；R02 取第一轮真实阶段） */
export function dropToStraightTarget(t: DropSetTarget): StraightTarget {
  const first = roundStagesOfTarget(t, 1)[0];
  return {
    kind: 'straight',
    sets: Math.min(MAX_STRAIGHT_SETS, Math.max(1, t.rounds)),
    setsMax: Math.min(MAX_STRAIGHT_SETS, Math.max(1, t.rounds)),
    repsMin: first?.repsMin ?? 8,
    repsMax: first?.repsMax ?? 12,
    weightMode: t.weightMode,
    suggestedWeightKg: first?.weightKg ?? null,
    dumbbellBasis: t.dumbbellBasis,
  };
}

function validateStageDraftList(issues: DraftIssue[], stages: StageDraft[], path: string): void {
  if (stages.length < MIN_STAGES) {
    issues.push({ path, message: `递减组至少需要 ${MIN_STAGES} 个阶段` });
  }
  if (stages.length > MAX_STAGES) {
    issues.push({ path, message: `最多 ${MAX_STAGES} 个阶段` });
  }
  stages.forEach((st, i) => {
    const p = `${path}[${i}]`;
    if (st.weightKg !== null) {
      if (!Number.isFinite(st.weightKg) || st.weightKg < 0 || st.weightKg > 999) {
        issues.push({ path: `${p}.weightKg`, message: '重量必须是 0–999 的数值' });
      }
    }
    if (st.restAfterSec !== undefined) {
      if (!Number.isInteger(st.restAfterSec) || st.restAfterSec < 0 || st.restAfterSec > MAX_REST_IN_SEC) {
        issues.push({ path: `${p}.restAfterSec`, message: `阶段间歇必须是 0–${MAX_REST_IN_SEC} 秒的整数` });
      }
    }
    if (st.toFailure) {
      // 技术性力竭：允许不填次数目标
      return;
    }
    if (st.repsMin === null || st.repsMax === null) {
      issues.push({ path: `${p}.reps`, message: '非力竭阶段必须填次数范围' });
      return;
    }
    if (!Number.isInteger(st.repsMin) || !Number.isInteger(st.repsMax)) {
      issues.push({ path: `${p}.reps`, message: '次数必须是整数' });
      return;
    }
    if (st.repsMin < 0 || st.repsMax > 500) {
      issues.push({ path: `${p}.reps`, message: '次数必须在 0–500 之间' });
    }
    // R10：禁止 20–10 这类反向范围
    if (st.repsMin > st.repsMax) {
      issues.push({ path: `${p}.reps`, message: `次数下限 ${st.repsMin} 大于上限 ${st.repsMax}` });
    }
  });
}

/** 校验草稿，返回全部问题（用于保存前定位字段） */
export function validateDropDraft(d: DropSetDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (!Number.isInteger(d.rounds) || d.rounds < MIN_ROUNDS || d.rounds > MAX_ROUNDS) {
    issues.push({ path: 'rounds', message: `轮数必须是 ${MIN_ROUNDS}–${MAX_ROUNDS} 的整数` });
  }
  validateStageDraftList(issues, d.stages, 'stages');
  const overrides = d.roundOverrides ?? [];
  const seenRounds = new Set<number>();
  for (const [i, rc] of overrides.entries()) {
    const p = `roundOverrides[${i}]`;
    if (!Number.isInteger(rc.roundIndex) || rc.roundIndex < 1 || rc.roundIndex > Math.max(1, d.rounds)) {
      issues.push({ path: `${p}.roundIndex`, message: '逐轮配置的轮序号超出范围（1..轮数）' });
    } else if (seenRounds.has(rc.roundIndex)) {
      issues.push({ path: `${p}.roundIndex`, message: `轮序号重复：${rc.roundIndex}` });
    } else {
      seenRounds.add(rc.roundIndex);
    }
    validateStageDraftList(issues, rc.stages, `${p}.stages`);
    if (rc.restInSec !== undefined && (!Number.isInteger(rc.restInSec) || rc.restInSec < 0 || rc.restInSec > MAX_REST_IN_SEC)) {
      issues.push({ path: `${p}.restInSec`, message: `阶段间歇必须是 0–${MAX_REST_IN_SEC} 秒的整数` });
    }
  }
  // R02：总行数按各轮真实 stageCount 求和，不能 rounds × 默认阶段数
  let rows = 0;
  for (let r = 1; r <= Math.max(1, d.rounds); r += 1) {
    const override = overrides.find((x) => x.roundIndex === r);
    rows += (override?.stages ?? d.stages).length;
  }
  if (rows > MAX_SET_ROWS) {
    issues.push({ path: 'rounds', message: `组结构会生成 ${rows} 行，超过单动作上限 ${MAX_SET_ROWS} 行` });
  }
  if (!Number.isInteger(d.restInSec) || d.restInSec < 0 || d.restInSec > 600) {
    issues.push({ path: 'restInSec', message: '阶段间休息必须是 0–600 秒的整数' });
  }
  if (!Number.isInteger(d.restAfterSec) || d.restAfterSec < 0 || d.restAfterSec > 3600) {
    issues.push({ path: 'restAfterSec', message: '轮间休息必须是 0–3600 秒的整数' });
  }
  return issues;
}

function draftStageAsTarget(st: StageDraft, i: number): DropStageTarget {
  return {
    ...(st.id ? { id: st.id } : {}),
    label: (st.label ?? '').trim() || `第 ${i + 1} 阶段`,
    weightKg: st.weightKg,
    repsMin: st.repsMin,
    repsMax: st.repsMax,
    toFailure: st.toFailure,
    ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
    targetText: '',
  };
}

function stageDraftsToTarget(stages: StageDraft[], fallbackId: (i: number) => string): DropStageTarget[] {
  return stages.map((st, i) => {
    const toFailure = st.toFailure;
    return {
      id: st.id ?? fallbackId(i),
      label: (st.label ?? '').trim() || `第 ${i + 1} 阶段`,
      weightKg: st.weightKg,
      repsMin: st.repsMin,
      repsMax: st.repsMax,
      toFailure,
      ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
      targetText: st.toFailure
        ? `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}技术性力竭`
        : `${st.weightKg !== null ? `${trimNum(st.weightKg)} kg · ` : ''}${
            st.repsMin !== null && st.repsMax !== null
              ? `${st.repsMin}–${st.repsMax} 次`
              : '次数未设'
          }`,
    };
  });
}

function stagesDiffer(a: StageDraft[], b: StageDraft[]): boolean {
  const norm = (list: StageDraft[]) =>
    list.map((st) => ({
      id: st.id ?? '',
      label: st.label ?? '',
      weightKg: st.weightKg,
      repsMin: st.repsMin,
      repsMax: st.repsMax,
      toFailure: st.toFailure,
      restAfterSec: st.restAfterSec ?? null,
    }));
  return JSON.stringify(norm(a)) !== JSON.stringify(norm(b));
}

/** 草稿 → 领域目标（只在校验通过后调用）
 *
 * R02 FIX2：`d.stages` 是**默认阶段模板**，不是“第 1 轮的生效配置”。
 * 任何一轮（包括第 1 轮）只要与默认模板不同，就必须写成显式 `roundConfigs`，
 * 这样修改第 1 轮不会改写其他默认轮；第 2..N 轮没有覆盖时继续沿用默认模板。
 */
export function draftToDropTarget(d: DropSetDraft): DropSetTarget {
  // R02 FIX3：身份在草稿建立/新增阶段时就已确定；这里只做确定性补齐，
  // 绝不 newStageId() 随机分裂。默认轮缺 id → stage-pos-N；
  // override 缺 id → 先按统一规则推断可证明的同源身份，否则用轮内兜底 ID。
  const defaultProbe = d.stages.map((st, i) => draftStageAsTarget(st, i));
  const stages = stageDraftsToTarget(defaultProbe, (i) => `stage-pos-${i + 1}`);
  // 全目标可信身份（默认模板 + 所有轮 override 的显式 id）：生成 fallback 身份时统一避让。
  // 草稿保存与运行期解析必须同一口径，否则保存后仍会撞上来源 id 被误认同源。
  const reservedIds = reservedStageIdsForStages(
    defaultProbe,
    (d.roundOverrides ?? []).map((o) => o.stages.map((st, i) => draftStageAsTarget(st, i))),
  );
  const roundConfigs: DropRoundConfig[] = [];
  for (let r = 1; r <= d.rounds; r += 1) {
    const override = d.roundOverrides?.find((x) => x.roundIndex === r);
    if (!override) continue;
    const differs = stagesDiffer(override.stages, d.stages) || override.restInSec !== undefined;
    if (!differs) continue;
    const overrideProbe = override.stages.map((st, i) => draftStageAsTarget(st, i));
    const identities = inferRoundStageIdentities(defaultProbe, overrideProbe, r, reservedIds);
    roundConfigs.push({
      roundIndex: r,
      stages: stageDraftsToTarget(overrideProbe, (i) => identities[i]?.id ?? `stage-pos-${r}-${i + 1}`),
      ...(override.restInSec !== undefined ? { restInSec: override.restInSec } : {}),
    });
  }
  return {
    kind: 'dropSet',
    ...(d.form === 'superset' ? { form: 'superset' as const } : {}),
    rounds: d.rounds,
    stages,
    ...(roundConfigs.length ? { roundConfigs } : {}),
    restInSec: d.restInSec,
    restAfterSec: d.restAfterSec,
    weightMode: d.weightMode,
    dumbbellBasis: d.dumbbellBasis,
  };
}

/** 领域目标 → 草稿（用于「修改已存在的递减组」）
 *
 * R02 FIX2（F3）：默认模板必须从 `t.stages` 读取，不能拿第 1 轮的生效数组
 * （`roundStagesOfTarget(t,1)`）冒充默认，否则“默认 3 阶段 + 第 1 轮 override 2 阶段”
 * 会在无操作保存时把第 2 轮也变成 2 阶段。第 1 轮的显式覆盖原样放入
 * `roundOverrides`（允许 roundIndex=1），保存时可完整还原。
 */
export function dropTargetToDraft(t: DropSetTarget): DropSetDraft {
  const defaultStages = t.stages.map((st, i) => ({
    // 旧目标缺少阶段 ID 时，用统一身份解析一次性稳定化到编辑草稿；
    // 默认轮的身份是跨轮共享的 `stage-pos-N`。
    id: defaultStageIdentityAt(t, i + 1)?.id ?? `stage-pos-${i + 1}`,
    label: st.label,
    weightKg: st.weightKg,
    repsMin: st.repsMin,
    repsMax: st.repsMax,
    toFailure: st.toFailure,
    ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
  }));
  const overrides: DropRoundDraft[] = [];
  const roundConfigs = [...(t.roundConfigs ?? [])].sort((a, b) => a.roundIndex - b.roundIndex);
  for (const rc of roundConfigs) {
    if (!Number.isInteger(rc.roundIndex) || rc.roundIndex < 1 || rc.roundIndex > MAX_ROUNDS) continue;
    const identities = resolveRoundStageIdentities(t, rc.roundIndex);
    overrides.push({
      roundIndex: rc.roundIndex,
      stages: rc.stages.map((st, i) => ({
        id: identities[i]?.id ?? `stage-pos-${rc.roundIndex}-${i + 1}`,
        label: st.label,
        weightKg: st.weightKg,
        repsMin: st.repsMin,
        repsMax: st.repsMax,
        toFailure: st.toFailure,
        ...(st.restAfterSec !== undefined ? { restAfterSec: st.restAfterSec } : {}),
      })),
      ...(rc.restInSec !== undefined ? { restInSec: rc.restInSec } : {}),
    });
  }
  return {
    ...(t.form === 'superset' ? { form: 'superset' as const } : {}),
    rounds: t.rounds,
    stages: defaultStages,
    ...(overrides.length ? { roundOverrides: overrides } : {}),
    restInSec: t.restInSec,
    restAfterSec: t.restAfterSec,
    weightMode: t.weightMode,
    dumbbellBasis: t.dumbbellBasis,
  };
}

/** 由任意目标取出一份草稿（普通组按默认值生成） */
export function draftFromTarget(t: ExerciseTarget): DropSetDraft {
  return t.kind === 'dropSet' ? dropTargetToDraft(t) : straightToDropDraft(t);
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** 结构摘要，用于 UI 预览（保存前给用户看；逐轮不同时显示真实轮阶段数） */
export function describeDropDraft(d: DropSetDraft): string {
  const roundCounts: number[] = [];
  for (let r = 1; r <= d.rounds; r += 1) {
    roundCounts.push((d.roundOverrides?.find((x) => x.roundIndex === r)?.stages ?? d.stages).length);
  }
  const uniform = roundCounts.every((n) => n === roundCounts[0]);
  const firstRoundStages = draftStagesForRound(d, 1);
  const parts = firstRoundStages.map((st) => {
    const w = st.weightKg !== null ? `${trimNum(st.weightKg)}kg` : '—';
    if (st.toFailure) return `${w} 力竭`;
    return `${w} × ${st.repsMin ?? 0}–${st.repsMax ?? 0}`;
  });
  const structure = uniform
    ? `${d.rounds} 轮 × ${d.stages.length} 阶段`
    : `${d.rounds} 轮 · 每轮阶段 ${roundCounts.join('/')}`;
  return `${structure}｜${parts.join(' → ')}`;
}

/** 草稿某轮的实际阶段（没有覆盖时回退默认 stages） */
export function draftStagesForRound(d: DropSetDraft, roundIndex: number): StageDraft[] {
  return d.roundOverrides?.find((x) => x.roundIndex === roundIndex)?.stages ?? d.stages;
}

/** 修改草稿某轮的阶段列表（每一轮都写独立 override；默认模板只在显式编辑默认时改）
 *
 * R02 FIX2（F2）：第 1 轮也必须是独立轮——写 `roundOverrides[1]`，
 * 绝不能直接替换共享 `stages`，否则其他默认轮会一起被改。
 */
export function updateRoundStages(d: DropSetDraft, roundIndex: number, stages: StageDraft[]): DropSetDraft {
  if (!Number.isInteger(roundIndex) || roundIndex < 1) return d;
  const rest = d.roundOverrides ?? [];
  const existing = rest.find((x) => x.roundIndex === roundIndex);
  const next: DropRoundDraft = { ...(existing ?? { roundIndex }), roundIndex, stages };
  return { ...d, roundOverrides: [...rest.filter((x) => x.roundIndex !== roundIndex), next].sort((a, b) => a.roundIndex - b.roundIndex) };
}

/** 新增/删除/排序阶段（纯函数，供 UI 调用） */
export function addStage(d: DropSetDraft): DropSetDraft {
  if (d.stages.length >= MAX_STAGES) return d;
  const last = d.stages[d.stages.length - 1];
  const next: StageDraft = {
    id: newStageId(),
    weightKg: last?.weightKg !== null && last?.weightKg !== undefined ? Math.max(0, last.weightKg - 2.5) : null,
    repsMin: last?.repsMin ?? 8,
    repsMax: last?.repsMax ?? 12,
    toFailure: false,
  };
  return { ...d, stages: [...d.stages, next] };
}

export function removeStage(d: DropSetDraft, index: number): DropSetDraft {
  if (d.stages.length <= MIN_STAGES) return d;
  return { ...d, stages: d.stages.filter((_, i) => i !== index) };
}

export function moveStage(d: DropSetDraft, index: number, dir: -1 | 1): DropSetDraft {
  const target = index + dir;
  if (index < 0 || target < 0 || target >= d.stages.length) return d;
  const stages = [...d.stages];
  const a = stages[index];
  stages[index] = stages[target];
  stages[target] = a;
  return { ...d, stages };
}

export function updateStage(d: DropSetDraft, index: number, patch: Partial<StageDraft>): DropSetDraft {
  return {
    ...d,
    stages: d.stages.map((st, i) => (i === index ? { ...st, ...patch } : st)),
  };
}

/* ── R02 逐轮编辑辅助（计划配置面板使用；第 1 轮写默认 stages）── */

export function addStageToRound(d: DropSetDraft, roundIndex: number): DropSetDraft {
  const rows = draftStagesForRound(d, roundIndex);
  if (rows.length >= MAX_STAGES) return d;
  const last = rows[rows.length - 1];
  const next: StageDraft = {
    id: newStageId(),
    weightKg: last?.weightKg !== null && last?.weightKg !== undefined ? Math.max(0, last.weightKg - 2.5) : null,
    repsMin: last?.repsMin ?? 8,
    repsMax: last?.repsMax ?? 12,
    toFailure: false,
  };
  return updateRoundStages(d, roundIndex, [...rows, next]);
}

export function removeStageFromRound(d: DropSetDraft, roundIndex: number, index: number): DropSetDraft {
  const rows = draftStagesForRound(d, roundIndex);
  if (rows.length <= MIN_STAGES) return d;
  return updateRoundStages(d, roundIndex, rows.filter((_, i) => i !== index));
}

export function moveStageInRound(d: DropSetDraft, roundIndex: number, index: number, dir: -1 | 1): DropSetDraft {
  const rows = [...draftStagesForRound(d, roundIndex)];
  const target = index + dir;
  if (index < 0 || target < 0 || target >= rows.length) return d;
  const a = rows[index];
  rows[index] = rows[target];
  rows[target] = a;
  return updateRoundStages(d, roundIndex, rows);
}

export function updateStageInRound(
  d: DropSetDraft,
  roundIndex: number,
  index: number,
  patch: Partial<StageDraft>,
): DropSetDraft {
  const rows = draftStagesForRound(d, roundIndex);
  return updateRoundStages(
    d,
    roundIndex,
    rows.map((st, i) => (i === index ? { ...st, ...patch } : st)),
  );
}

/** R02：调整轮数。新增轮默认继承紧邻上一轮结构；减少轮时丢弃被删轮的覆盖。 */
export function setDropDraftRounds(d: DropSetDraft, nextRounds: number): DropSetDraft {
  const next = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.floor(nextRounds)));
  if (next === d.rounds) return d;
  let out: DropSetDraft = {
    ...d,
    rounds: next,
    ...(d.roundOverrides
      ? { roundOverrides: d.roundOverrides.filter((r) => r.roundIndex <= next) }
      : {}),
  };
  if (next > d.rounds) {
    for (let r = d.rounds + 1; r <= next; r += 1) {
      const prev = draftStagesForRound(out, r - 1).map((st) => ({ ...st }));
      out = updateRoundStages(out, r, prev);
    }
  }
  return out;
}
