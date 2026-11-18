/* 训练动作配置的统一领域函数（G1 数据契约）。
   ── 为什么单独一份 ────────────────────────────────────────────
   G2 的统一编辑器、模板记忆、备份校验都必须共用同一套
   「解析 / 应用 / 校验」规则。旧实现只有 `validateDropDraft` 与
   `restAfterSet` 等零散入口，普通组没有按组配置，力竭与次数又互相注销。
   本模块是 G1 的单一真源：

   · 保留 `ExerciseTarget.kind = 'straight' | 'dropSet'` 的旧兼容形状；
     超级组用 `form: 'superset'` 显式区分（不新增 union 成员）。
   · 普通组支持 `perSetConfigs`（每组独立力竭/参考次数）；
     多阶段支持 `stages[].id`（稳定身份）与 `stages[].restAfterSec`（独立短间歇）。
   · `null` = 未设置；`0` 是明确数值。力竭不注销/禁用次数。
   · 应用配置时保留 `SessionSet.id` 与全部 actual；删除已输入组/阶段
     必须返回明确影响信息，确认后才执行，不静默丢记录。 */

import type {
  DropRoundConfig,
  DropSetTarget,
  DropStageTarget,
  ExerciseTarget,
  GroupPlan,
  SessionExercise,
  SessionSet,
  StraightTarget,
  TrainingForm,
  ExerciseTemplate,
} from './types';
import {
  MAX_REPS,
  MAX_REST,
  MAX_REST_IN_SEC,
  MAX_ROUNDS,
  MAX_SET_ROWS,
  MAX_STAGES,
  MAX_STAGES_ACCEPTED,
  MAX_STRAIGHT_SETS,
  MAX_WEIGHT,
  MIN_ROUNDS,
  MIN_STAGES,
} from './limits';
import { WEIGHT_MODE_LABEL } from './identity';

export interface ConfigIssue {
  path: string;
  message: string;
}

const newLocalId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ── 形式 / 结构 ─────────────────────────── */

/** 显式训练形式：普通组 / 超级组 / 递减组 */
export function trainingFormOf(t: ExerciseTarget): TrainingForm {
  if (t.kind === 'straight') return 'straight';
  return t.form === 'superset' ? 'superset' : 'dropSet';
}

export function trainingFormLabel(form: TrainingForm): string {
  switch (form) {
    case 'superset':
      return '超级组';
    case 'dropSet':
      return '递减组';
    default:
      return '普通组';
  }
}

/** 目标的大组数（普通组=组数；多阶段=轮数） */
export function targetGroupCount(t: ExerciseTarget): number {
  return t.kind === 'straight' ? t.sets : t.rounds;
}

/** 目标的每大组阶段数（普通组恒为 1） */
export function targetStageCount(t: ExerciseTarget): number {
  return t.kind === 'straight' ? 1 : Math.max(1, t.stages.length);
}

/**
 * 某轮实际生效的阶段配置（R02 单一真源）：
 * · 普通组恒为 1 阶段；
 * · 多阶段优先匹配 `roundConfigs[roundIndex]`；
 * · 没有显式覆盖的已声明轮（1..rounds）回退默认 `stages`（旧语义）；
 * · 训练中新增、超出计划 rounds 的轮（只可能来自旧数据/旧 addSetTo 未物化配置）
 *   按**最后声明的轮**（rounds）回退，绝不搜索任意更早的 override 冒充“紧邻上一轮”。
 *   新代码在 addSetTo / 编辑器保存时会把新增轮配置物化为显式 roundConfig。
 *
 * 旧 JSON 没有 `roundConfigs` → 所有轮与旧行为完全一致，不产生幽灵阶段。
 */
export function roundStagesOf(t: ExerciseTarget, groupIndex: number): DropStageTarget[] {
  if (t.kind !== 'dropSet') return [];
  const override = t.roundConfigs?.find((r) => r.roundIndex === groupIndex);
  if (override) return override.stages;
  const lastDeclared = Math.max(1, t.rounds);
  if (groupIndex > lastDeclared) {
    // 兼容旧 addSetTo 产生的额外轮：上一“声明”轮是 rounds，只能是它的生效配置；
    // 若连 rounds 都没有显式覆盖，则回到默认 stages（旧语义）。
    const lastOverride = t.roundConfigs?.find((r) => r.roundIndex === lastDeclared);
    return lastOverride?.stages ?? t.stages;
  }
  return t.stages;
}

/** 某轮实际阶段数（普通组=1；多阶段按逐轮覆盖解析） */
export function targetStageCountForGroup(t: ExerciseTarget, groupIndex: number): number {
  return t.kind === 'straight' ? 1 : Math.max(1, roundStagesOf(t, groupIndex).length);
}

/** 由目标推导组结构（供 session 启动 / 应用配置共用；逐轮 stageCount） */
export function groupPlanForTarget(t: ExerciseTarget): GroupPlan[] {
  const groupCount = Math.max(0, targetGroupCount(t));
  return Array.from({ length: groupCount }, (_, i) => ({
    index: i + 1,
    stageCount: t.kind === 'straight' ? 1 : targetStageCountForGroup(t, i + 1),
  }));
}

/** 某轮的阶段间默认短间歇（R02：逐轮可覆盖，缺省回退 target.restInSec） */
export function roundRestInSecOf(t: ExerciseTarget, groupIndex: number): number {
  if (t.kind !== 'dropSet') return 0;
  const override = t.roundConfigs?.find((r) => r.roundIndex === groupIndex);
  if (override?.restInSec !== undefined) return override.restInSec;
  const lastDeclared = Math.max(1, t.rounds);
  if (groupIndex > lastDeclared) {
    // 与 roundStagesOf 同一口径：额外轮只回退最后声明轮，不跨轮搜索更早 override。
    const lastOverride = t.roundConfigs?.find((r) => r.roundIndex === lastDeclared);
    if (lastOverride?.restInSec !== undefined) return lastOverride.restInSec;
  }
  return t.restInSec;
}

/* ── 稳定阶段身份（R02 FIX3 统一口径）───────────────────────
 *
 * 一个阶段在「默认模板 / 各轮 override / 会话行 / 编辑草稿」之间必须使用
 * **同一套**身份解析，否则仅改配置就会把同位置阶段拆成两套互不相交的 ID，
 * 导致“未完成轮沿用上一完整轮”整轮失败。
 *
 * 解析优先级（绝不把不可证明的不同阶段按位置强行合并）：
 * 1. 阶段自身有非空 `id` → 原样保留（已有显式身份最高优先）。
 * 2. 默认模板阶段缺 id → 确定性位置身份 `stage-pos-N`（旧数据兼容）。
 * 3. override 阶段缺 id：
 *    a. 名称与默认模板中**唯一一个**阶段名称相同 → 采用该阶段身份（可证明重排）；
 *    b. 名称为空，或与该轮同位置默认阶段名称相同 → 采用同位置默认身份
 *       （旧模板/旧备份的“同位置约定”）；
 *    c. 其余无法证明 → 轮内确定性兜底身份 `stage-pos-<轮>-<阶段>`，
 *       与默认轮身份**保持不同**；且避让该目标内任何可信显式身份
 *       （默认模板 / 其它轮 override / 已生成身份），避免被误认为同源。
 *       沿用上一轮时这些阶段保持空白并提示。
 *
 * 兜底身份是确定性的：同一目标反复转换/序列化不会随机分裂。
 * 显式 ID 即使彼此互不对应也绝不按位置合并 —— 那是无法证明的不同阶段。
 */
export type StageIdentityConfidence = 'explicit' | 'inferred' | 'fallback';

export interface ResolvedStageIdentity {
  stageIndex: number;
  id: string;
  confidence: StageIdentityConfidence;
  basis: 'explicit' | 'position' | 'label' | 'default' | 'round';
}

const normalizeStageLabel = (label: string | undefined): string => (label ?? '').trim().replace(/\s+/g, ' ');

/** 同一阶段数组内已显式声明的身份集合（用于生成身份时避让）。 */
function explicitStageIdSet(stages: DropStageTarget[]): Set<string> {
  const ids = new Set<string>();
  for (const st of stages) {
    const id = typeof st.id === 'string' ? st.id.trim() : '';
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * 生成不与该数组显式 id 冲突的确定性身份。
 * 只用于旧数据缺失 id 的兼容身份；显式 id 永远原样保留。
 */
function uniqueGeneratedStageId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
}

/** 某个阶段持久化的稳定 ID（旧数据缺失时返回 null；兼容读取请用 stageIdentityAt） */
export function stageIdAt(t: ExerciseTarget, stageIndex: number): string | null {
  if (t.kind !== 'dropSet') return null;
  return t.stages[stageIndex - 1]?.id ?? null;
}

/** 默认阶段模板的稳定身份：显式 id 原样保留；旧数据无 id 用 stage-pos-N。 */
export function defaultStageIdentityAt(t: ExerciseTarget, stageIndex: number): ResolvedStageIdentity | null {
  if (t.kind !== 'dropSet') return null;
  const st = t.stages[stageIndex - 1];
  if (!st) return null;
  const explicit = typeof st.id === 'string' ? st.id.trim() : '';
  if (explicit) return { stageIndex, id: explicit, confidence: 'explicit', basis: 'explicit' };
  // 旧数据无 id：位置身份不能与同数组里已有显式 id 撞车（例如显式 stage-pos-2）。
  const used = explicitStageIdSet(t.stages);
  return {
    stageIndex,
    id: uniqueGeneratedStageId(`stage-pos-${stageIndex}`, used),
    confidence: 'inferred',
    basis: 'position',
  };
}

/**
 * 目标内全部**可信或已生成**的阶段身份（默认模板 + 各轮 override 的显式 id）。
 * 默认模板缺 id 时的位置身份（stage-pos-N）同样属于可信身份。
 */
function collectTrustedStageIds(
  defaultStages: DropStageTarget[],
  roundStageLists: ReadonlyArray<ReadonlyArray<DropStageTarget>>,
): Set<string> {
  const trusted = explicitStageIdSet(defaultStages);
  for (const stages of roundStageLists) {
    for (const st of stages) {
      const id = typeof st.id === 'string' ? st.id.trim() : '';
      if (id) trusted.add(id);
    }
  }
  // 默认模板缺 id 时生成的位置身份也是“可证明身份”，fallback 必须避让。
  const usedDefault = explicitStageIdSet(defaultStages);
  defaultStages.forEach((st, i) => {
    const explicit = typeof st.id === 'string' ? st.id.trim() : '';
    if (!explicit) trusted.add(uniqueGeneratedStageId(`stage-pos-${i + 1}`, usedDefault));
  });
  return trusted;
}

/**
 * 目标全量可信阶段身份保留集合（统一身份解析 / ensureStageIds / 草稿共用）。
 * 不可信 fallback 身份不得与该集合中任何 id 相同，否则会被误认为同源。
 */
export function reservedStageIdsForTarget(t: ExerciseTarget): Set<string> {
  if (t.kind !== 'dropSet') return new Set<string>();
  return collectTrustedStageIds(t.stages, (t.roundConfigs ?? []).map((rc) => rc.stages ?? []));
}

/** 尚未落库的候选目标（草稿 → 目标）按同一目标口径计算可信身份保留集合。 */
export function reservedStageIdsForStages(
  defaultStages: DropStageTarget[],
  roundStageLists: ReadonlyArray<ReadonlyArray<DropStageTarget>>,
): Set<string> {
  return collectTrustedStageIds(defaultStages, roundStageLists);
}

/**
 * 纯算法：给定默认阶段模板与某一轮的阶段数组，解析该轮每个阶段的身份。
 * 目标无需预先补齐 id，因此旧 JSON / 旧备份 / 旧计划可以直接得到同一套口径。
 *
 * `reservedStageIds` 为该目标内全部可信身份（默认模板 + 其它轮 override 的显式 id）。
 * 不可信 fallback 身份必须避让它们：fallback 只是“无法证明同源”的临时身份，
 * 一旦与来源中的可信 id 相同，就会被继承逻辑误认为同源并错误沿用 actual。
 */
export function inferRoundStageIdentities(
  defaultStages: DropStageTarget[],
  roundStages: DropStageTarget[],
  roundIndex: number,
  reservedStageIds: Iterable<string> = [],
): ResolvedStageIdentity[] {
  const usedDefaultIds = explicitStageIdSet(defaultStages);
  const defaultIdentities = defaultStages.map((st, i) => {
    const explicit = typeof st.id === 'string' ? st.id.trim() : '';
    return explicit
      ? { stageIndex: i + 1, id: explicit, confidence: 'explicit' as const, basis: 'explicit' as const }
      : {
          stageIndex: i + 1,
          id: uniqueGeneratedStageId(`stage-pos-${i + 1}`, usedDefaultIds),
          confidence: 'inferred' as const,
          basis: 'position' as const,
        };
  });
  const defaultLabels = defaultStages.map((st) => normalizeStageLabel(st.label));
  const roundLabels = roundStages.map((st) => normalizeStageLabel(st.label));
  const explicitIds = roundStages
    .map((st) => (typeof st.id === 'string' ? st.id.trim() : ''))
    .filter(Boolean);
  const missingIdCount = roundStages.length - explicitIds.length;
  const mixed = explicitIds.length > 0 && missingIdCount > 0;
  const defaultIdentityIds = new Set(defaultIdentities.map((d) => d.id));
  // 混合轮里有“认不出的显式 id”时，位置/同下标名称都不再可靠：
  // 显式 id 可能表示重排或另一阶段，不能把缺失阶段悄悄硬配给默认同位置。
  const hasUnrecognizedExplicit = explicitIds.some((id) => !defaultIdentityIds.has(id));
  // 本轮已经占用的身份：显式 id + 已推断/已生成的 id，生成兜底身份时统一避让。
  const usedRoundIds = new Set(explicitIds);
  // 兜底身份（fallback）还要避让全目标可信身份：默认模板与其它轮 override 的
  // 显式/位置身份。它们不在本轮 usedRoundIds 里，但撞上同样会被继承误认同源。
  const fallbackUsedIds = new Set(usedRoundIds);
  for (const raw of reservedStageIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id) fallbackUsedIds.add(id);
  }
  return roundStages.map((st, i) => {
    const explicit = typeof st.id === 'string' ? st.id.trim() : '';
    if (explicit) return { stageIndex: i + 1, id: explicit, confidence: 'explicit', basis: 'explicit' };
    const label = roundLabels[i];
    if (label) {
      const matches: number[] = [];
      defaultLabels.forEach((l, j) => {
        if (l === label) matches.push(j);
      });
      const sameLabelCount = roundLabels.filter((l) => l === label).length;
      if (matches.length === 1 && sameLabelCount === 1) {
        const matched = defaultIdentities[matches[0]];
        if (!usedRoundIds.has(matched.id) && (!mixed || !hasUnrecognizedExplicit)) {
          usedRoundIds.add(matched.id);
          fallbackUsedIds.add(matched.id);
          return { stageIndex: i + 1, id: matched.id, confidence: 'inferred', basis: 'label' };
        }
      }
      // 名称非空但对不上唯一默认阶段：不能用位置强行合并
      // （重复名称/删首/重排都可能是不同阶段，无法证明时保持独立身份）。
    }
    // “同位置约定”只用于整轮都没有名称/没有显式 id 的旧数据。
    // 只要名称非空但不唯一/不匹配，就不能按位置猜。
    if (!label && !mixed) {
      const sameIndex = defaultIdentities[i];
      if (sameIndex) {
        usedRoundIds.add(sameIndex.id);
        fallbackUsedIds.add(sameIndex.id);
        return { stageIndex: i + 1, id: sameIndex.id, confidence: 'inferred', basis: 'position' };
      }
    }
    const fallbackId = uniqueGeneratedStageId(`stage-pos-${roundIndex}-${i + 1}`, fallbackUsedIds);
    usedRoundIds.add(fallbackId);
    return {
      stageIndex: i + 1,
      id: fallbackId,
      confidence: 'fallback',
      basis: 'round',
    };
  });
}

/**
 * 某轮实际生效阶段配置的稳定身份（全 App 唯一解析入口）。
 * 与 `roundStagesOf` 同一回退路径：额外轮取最后声明轮的真实配置。
 */
export function resolveRoundStageIdentities(t: ExerciseTarget, groupIndex: number): ResolvedStageIdentity[] {
  if (t.kind !== 'dropSet') return [];
  const lastDeclared = Math.max(1, t.rounds);
  const exactOverride = t.roundConfigs?.find((r) => r.roundIndex === groupIndex);
  const inheritedOverride =
    !exactOverride && groupIndex > lastDeclared
      ? t.roundConfigs?.find((r) => r.roundIndex === lastDeclared)
      : undefined;
  const stages = roundStagesOf(t, groupIndex);
  if (!exactOverride && !inheritedOverride) {
    // 默认轮 / 没有显式覆盖：全部轮共享默认模板身份（旧数据 stage-pos-N）。
    return stages.map((_, i) => {
      const d = defaultStageIdentityAt(t, i + 1);
      return {
        stageIndex: i + 1,
        id: d?.id ?? `stage-pos-${i + 1}`,
        confidence: d?.confidence ?? 'inferred',
        basis: 'default',
      };
    });
  }
  return inferRoundStageIdentities(
    t.stages,
    stages,
    (exactOverride ?? inheritedOverride!).roundIndex,
    reservedStageIdsForTarget(t),
  );
}

/** 某轮某阶段的稳定身份（旧数据缺失时给出确定性兼容身份；非多阶段返回 null）。 */
export function stageIdentityAtForGroup(
  t: ExerciseTarget,
  groupIndex: number,
  stageIndex: number,
): string | null {
  if (t.kind !== 'dropSet') return null;
  return resolveRoundStageIdentities(t, groupIndex)[stageIndex - 1]?.id ?? null;
}

export function stageIdentityAt(t: ExerciseTarget, stageIndex: number): string | null {
  return stageIdentityAtForGroup(t, 1, stageIndex);
}

/**
 * 为缺失阶段 ID 的多阶段目标补齐稳定 ID（深复制，不修改入参）。
 * 只用于**新写入**（新会话快照 / 模板记忆 / 应用新配置），
 * 不用于扫描重写旧计划或旧历史。
 *
 * 可证明同源的 override 与默认轮共享身份；无法证明的阶段使用
 * 轮内确定性兜底 ID（已避让全目标可信身份；或调用方显式 `makeId`），绝不随机分裂。
 */
export function ensureStageIds(
  t: ExerciseTarget,
  makeId?: (stageIndex: number, roundIndex?: number) => string,
): ExerciseTarget {
  const clone = structuredClone(t) as ExerciseTarget;
  if (clone.kind !== 'dropSet') return clone;
  clone.stages = clone.stages.map((st, i) => ({
    ...st,
    id: typeof st.id === 'string' && st.id.trim() ? st.id : (defaultStageIdentityAt(t, i + 1)?.id ?? `stage-pos-${i + 1}`),
  }));
  if (Array.isArray(clone.roundConfigs)) {
    clone.roundConfigs = clone.roundConfigs.map((rc) => {
      const identities = resolveRoundStageIdentities(t, rc.roundIndex);
      return {
        ...rc,
        stages: (rc.stages ?? []).map((st, i) => {
          if (typeof st.id === 'string' && st.id.trim()) return { ...st, id: st.id };
          const identity = identities[i];
          if (identity && identity.confidence !== 'fallback') return { ...st, id: identity.id };
          // fallback 使用统一解析出的**避让后**身份，不能退回裸 base：
          // 否则 stage-pos-2-1 会再次撞上默认/其它轮的可信显式 ID。
          const fallbackId = identity?.id ?? `stage-pos-${rc.roundIndex}-${i + 1}`;
          return { ...st, id: makeId ? makeId(i + 1, rc.roundIndex) : fallbackId };
        }),
      };
    });
  }
  return clone;
}

/**
 * 把可证明的稳定身份持久化到目标（用于计划模板导入等**新写入**）。
 * 默认轮补齐 stage-pos-N；override 只补能证明同源的阶段，
 * 无法证明的不同阶段保持无 id（运行时用确定性兜底身份，绝不按位置合并）。
 */
export function stabilizeDropTargetStageIds(t: ExerciseTarget): ExerciseTarget {
  if (t.kind !== 'dropSet') return t;
  const clone = structuredClone(t) as DropSetTarget;
  clone.stages = clone.stages.map((st, i) => ({
    ...st,
    id:
      typeof st.id === 'string' && st.id.trim()
        ? st.id
        : (defaultStageIdentityAt(t, i + 1)?.id ?? `stage-pos-${i + 1}`),
  }));
  if (Array.isArray(clone.roundConfigs)) {
    clone.roundConfigs = clone.roundConfigs.map((rc) => {
      const identities = resolveRoundStageIdentities(t, rc.roundIndex);
      return {
        ...rc,
        stages: rc.stages.map((st, i) => {
          if (typeof st.id === 'string' && st.id.trim()) return { ...st, id: st.id };
          const identity = identities[i];
          return identity && identity.confidence !== 'fallback' ? { ...st, id: identity.id } : { ...st };
        }),
      };
    });
  }
  return clone;
}

/* ── 解析：每组 / 每阶段的独立配置 ─────────── */

export interface ResolvedGroupConfig {
  groupIndex: number;
  stageIndex: number;
  /** 阶段稳定 ID；普通组 / 旧数据缺失 = null */
  stageId: string | null;
  /** 阶段名；普通组 / 无配置 = null（R02 逐轮显示用） */
  label: string | null;
  /** null = 未设置参考次数（不是 0） */
  repsMin: number | null;
  repsMax: number | null;
  weightKg: number | null;
  /** 该组/阶段独立力竭；力竭不注销/禁用次数 */
  toFailure: boolean;
  /**
   * 该组/阶段结束后的短间歇（秒）。
   * null = 使用整轮/组间休息（普通组、或末阶段直接接整轮休息）。
   */
  restAfterSec: number | null;
}

/**
 * 统一解析某组某阶段的最终配置。
 *
 * 普通组：优先 `perSetConfigs[setIndex]`，否则回退全局字段（旧语义）。
 * 多阶段：按 `stages[stageIndex-1]` 读取；`restAfterSec` 末阶段返回 null
 *         （代表直接接 `target.restAfterSec`，不叠加短间歇）。
 */
export function resolveGroupConfig(
  t: ExerciseTarget,
  groupIndex: number,
  stageIndex = 1,
): ResolvedGroupConfig {
  if (t.kind === 'straight') {
    const per = t.perSetConfigs?.find((c) => c.setIndex === groupIndex);
    if (per) {
      return {
        groupIndex,
        stageIndex: 1,
        stageId: null,
        label: null,
        repsMin: per.repsMin,
        repsMax: per.repsMax,
        weightKg: per.suggestedWeightKg,
        toFailure: per.toFailure,
        restAfterSec: null,
      };
    }
    return {
      groupIndex,
      stageIndex: 1,
      stageId: null,
      label: null,
      repsMin: t.repsMin,
      repsMax: t.repsMax,
      weightKg: t.suggestedWeightKg,
      toFailure: t.toFailure ?? false,
      restAfterSec: null,
    };
  }
  const stages = roundStagesOf(t, groupIndex);
  const st = stages[stageIndex - 1];
  if (!st) {
    return {
      groupIndex,
      stageIndex,
      stageId: null,
      label: null,
      repsMin: null,
      repsMax: null,
      weightKg: null,
      toFailure: false,
      restAfterSec: null,
    };
  }
  const isLast = stageIndex >= stages.length;
  return {
    groupIndex,
    stageIndex,
    stageId: st.id ?? null,
    label: st.label ?? null,
    repsMin: st.repsMin,
    repsMax: st.repsMax,
    weightKg: st.weightKg,
    toFailure: st.toFailure,
    restAfterSec: isLast ? null : (st.restAfterSec ?? roundRestInSecOf(t, groupIndex)),
  };
}

/**
 * 某 set 完成后应休息的秒数（单一真源；session.restAfterSet 委托到这里）。
 * 普通组 → `groupRestSec`（= ex.restSec）。
 * 多阶段 → 末阶段用 `target.restAfterSec`；非末阶段用该阶段独立值与 `restInSec`。
 */
export function restSecondsForSet(
  t: ExerciseTarget,
  groupIndex: number,
  stageIndex: number,
  groupRestSec: number,
): number {
  if (t.kind === 'straight') return groupRestSec;
  const stages = roundStagesOf(t, groupIndex);
  const isLast = stageIndex >= Math.max(1, stages.length);
  if (isLast) return t.restAfterSec;
  return stages[stageIndex - 1]?.restAfterSec ?? roundRestInSecOf(t, groupIndex);
}

/** 只把缺失/不可信的 run-time 阶段 ID 通过配置唯一对应补齐时的结果 */
export interface StageIdResolution {
  /** 该轮能否从配置构造出**唯一**的 stageIndex → stageId 映射 */
  ok: boolean;
  /** stageIndex(1-based) → stageId；ok=false 时为空 */
  byIndex: Map<number, string>;
}

/**
 * 从**目标配置**解析某轮的唯一 stageId 映射（R02 legacy 兼容核心）。
 *
 * 仅当以下条件全部满足才返回 ok：
 * 1. 该轮是合法的 `GroupPlan`，stageCount 与配置解析出的真实阶段数一致；
 * 2. 该轮配置的每个阶段都有**非空且轮内唯一**的稳定 id；
 * 3. 快照行的 stageIndex 恰好覆盖 1..stageCount 且无重复（由调用方保证）。
 *
 * 任何“配置阶段数与快照不一致 / id 缺失或重复 / 混合”的情况都不可证明唯一，
 * 返回 ok=false —— 绝不用位置把不同动作/不同结构的阶段硬配。
 */
export function resolveStageIdsFromConfigForRound(
  t: ExerciseTarget,
  groupIndex: number,
  stageCount: number,
): StageIdResolution {
  const empty = { ok: false, byIndex: new Map<number, string>() };
  if (t.kind !== 'dropSet') return empty;
  const stages = roundStagesOf(t, groupIndex);
  if (stages.length !== stageCount) return empty;
  // 与 stageIdentityAtForGroup 共用同一口径：显式 id 保留；旧无 id 数据按
  // “唯一名称 / 无名称同位置约定”推断。无法证明的阶段使用轮内兜底身份：
  // 它**不会**与其它轮的身份相同，因此沿用上一轮时这些阶段仍保持空白；
  // 但同轮里可证明的阶段可以正常按身份对应（部分沿用 + 明确提示）。
  const resolved = resolveRoundStageIdentities(t, groupIndex);
  if (resolved.length !== stageCount) return empty;
  const ids = resolved.map((r) => r.id);
  if (ids.some((id) => !id)) return empty;
  if (new Set(ids).size !== ids.length) return empty;
  const byIndex = new Map<number, string>();
  ids.forEach((id, i) => byIndex.set(i + 1, id));
  return { ok: true, byIndex };
}

/* ── 校验：统一配置校验（G2 保存前 / 模板写入 / 备份读取共用）── */

function pushRepsRangeIssues(
  issues: ConfigIssue[],
  path: string,
  repsMin: number | null,
  repsMax: number | null,
): void {
  if (repsMin === null && repsMax === null) return; // 可选参考次数：未设置
  if (repsMin === null || repsMax === null) {
    issues.push({ path, message: '参考次数必须同时填写上下限，或同时留空（不能半填）' });
    return;
  }
  if (!Number.isInteger(repsMin) || !Number.isInteger(repsMax)) {
    issues.push({ path, message: `参考次数必须是 0–${MAX_REPS} 的整数` });
    return;
  }
  if (repsMin < 0 || repsMax > MAX_REPS) {
    issues.push({ path, message: `参考次数必须在 0–${MAX_REPS} 之间` });
    return;
  }
  if (repsMin > repsMax) {
    issues.push({ path, message: `参考次数下限 ${repsMin} 大于上限 ${repsMax}` });
  }
}

function validateWeight(issues: ConfigIssue[], path: string, weightKg: number | null): void {
  if (weightKg === null) return;
  if (!Number.isFinite(weightKg) || weightKg < 0 || weightKg > MAX_WEIGHT) {
    issues.push({ path, message: `重量必须是 0–${MAX_WEIGHT} 的数值` });
  }
}

function validateRest(issues: ConfigIssue[], path: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    issues.push({ path, message: `休息必须是 0–${max} 秒的整数` });
  }
}

function validateStageRows(
  issues: ConfigIssue[],
  stages: DropStageTarget[],
  path: string,
  minStages: number,
  maxStages: number,
): void {
  if (stages.length < minStages) {
    issues.push({ path, message: `至少需要 ${minStages} 个阶段` });
  }
  if (stages.length > maxStages) {
    issues.push({ path, message: `最多 ${maxStages} 个阶段` });
  }
  const stageIds = new Set<string>();
  stages.forEach((st, i) => {
    const p = `${path}[${i}]`;
    const label = (st.label ?? '').trim();
    if (!label) issues.push({ path: `${p}.label`, message: '阶段名不能为空' });
    if (label.length > 100) issues.push({ path: `${p}.label`, message: '阶段名最多 100 个字符' });
    if (st.id !== undefined) {
      if (typeof st.id !== 'string' || !st.id.trim()) {
        issues.push({ path: `${p}.id`, message: '阶段 ID 必须是非空文本' });
      } else if (stageIds.has(st.id)) {
        issues.push({ path: `${p}.id`, message: `阶段 ID 重复：${st.id}` });
      } else {
        stageIds.add(st.id);
      }
    }
    validateWeight(issues, `${p}.weightKg`, st.weightKg);
    pushRepsRangeIssues(issues, `${p}.reps`, st.repsMin, st.repsMax);
    if (st.restAfterSec !== undefined) {
      validateRest(issues, `${p}.restAfterSec`, st.restAfterSec, MAX_REST_IN_SEC);
    }
  });
}

/**
 * 校验一份完整目标配置（纯函数，返回全部问题）。
 * 与旧 `validateDropDraft` 的差异（均为 G1 需求）：
 * · 力竭**不**跳过次数范围校验（填写时仍需合法；空表示未设置）；
 * · 普通组支持 perSetConfigs 的逐组校验；
 * · 支持阶段 label / id / restAfterSec 与 superset form；
 * · R02：支持逐轮 `roundConfigs`，总行数按各轮真实 stageCount 求和。
 */
export function validateExerciseTarget(
  t: ExerciseTarget,
  opts: { minStages?: number; maxStages?: number } = {},
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const minStages = opts.minStages ?? MIN_STAGES;
  const maxStages = opts.maxStages ?? MAX_STAGES;
  if (t.kind === 'straight') {
    // 0 组是历史合法的「可选零组动作」，保留兼容；新编辑器默认不会产生 0。
    if (!Number.isInteger(t.sets) || t.sets < 0 || t.sets > MAX_STRAIGHT_SETS) {
      issues.push({ path: 'sets', message: `组数必须是 0–${MAX_STRAIGHT_SETS} 的整数` });
    }
    if (!Number.isInteger(t.setsMax) || t.setsMax < t.sets || t.setsMax > MAX_STRAIGHT_SETS) {
      issues.push({ path: 'setsMax', message: '组数上限必须不小于组数且不超过上限' });
    }
    pushRepsRangeIssues(issues, 'reps', t.repsMin, t.repsMax);
    validateWeight(issues, 'suggestedWeightKg', t.suggestedWeightKg);
    if (t.perSetConfigs) {
      const seen = new Set<number>();
      t.perSetConfigs.forEach((c, i) => {
        const p = `perSetConfigs[${i}]`;
        if (!Number.isInteger(c.setIndex) || c.setIndex < 1 || c.setIndex > Math.max(1, t.sets)) {
          issues.push({ path: `${p}.setIndex`, message: '组序号超出本次组数范围' });
        }
        if (seen.has(c.setIndex)) issues.push({ path: `${p}.setIndex`, message: `组序号重复：${c.setIndex}` });
        seen.add(c.setIndex);
        pushRepsRangeIssues(issues, `${p}.reps`, c.repsMin, c.repsMax);
        validateWeight(issues, `${p}.suggestedWeightKg`, c.suggestedWeightKg);
      });
    }
    return issues;
  }

  // 多阶段（递减组 / 超级组）
  const form = t.form ?? 'dropSet';
  if (form !== 'dropSet' && form !== 'superset') {
    issues.push({ path: 'form', message: '训练形式只能是 dropSet 或 superset' });
  }
  if (!Number.isInteger(t.rounds) || t.rounds < MIN_ROUNDS || t.rounds > MAX_ROUNDS) {
    issues.push({ path: 'rounds', message: `轮数必须是 ${MIN_ROUNDS}–${MAX_ROUNDS} 的整数` });
  }
  validateStageRows(issues, t.stages, 'stages', minStages, maxStages);
  // R02 逐轮覆盖：白名单/范围/唯一性/总行数
  const roundConfigs = Array.isArray(t.roundConfigs) ? t.roundConfigs : [];
  if (t.roundConfigs !== undefined && !Array.isArray(t.roundConfigs)) {
    issues.push({ path: 'roundConfigs', message: '逐轮配置必须是数组' });
  }
  const seenRounds = new Set<number>();
  const roundsForRows = Number.isInteger(t.rounds) && t.rounds > 0 ? Math.min(t.rounds, MAX_ROUNDS) : 1;
  roundConfigs.forEach((rc, i) => {
    const p = `roundConfigs[${i}]`;
    if (!Number.isInteger(rc.roundIndex) || rc.roundIndex < 1 || rc.roundIndex > Math.max(1, roundsForRows)) {
      issues.push({ path: `${p}.roundIndex`, message: '轮序号超出本次轮数范围' });
    } else if (seenRounds.has(rc.roundIndex)) {
      issues.push({ path: `${p}.roundIndex`, message: `轮序号重复：${rc.roundIndex}` });
    } else {
      seenRounds.add(rc.roundIndex);
    }
    if (!Array.isArray(rc.stages)) {
      issues.push({ path: `${p}.stages`, message: '每轮阶段配置必须是数组' });
      return;
    }
    // 已有合法大阶段（旧数据 7–12）也要能通过；新建能力由编辑器单独限制。
    validateStageRows(issues, rc.stages, `${p}.stages`, Math.min(minStages, rc.stages.length || 1), Math.max(maxStages, MAX_STAGES_ACCEPTED));
    if (rc.restInSec !== undefined) {
      validateRest(issues, `${p}.restInSec`, rc.restInSec, MAX_REST_IN_SEC);
    }
  });

  let rows = 0;
  for (let gi = 1; gi <= Math.max(1, roundsForRows); gi += 1) {
    const override = roundConfigs.find((r) => r.roundIndex === gi);
    const count = override && Array.isArray(override.stages) ? override.stages.length : t.stages.length;
    rows += Math.max(1, count);
  }
  if (rows > MAX_SET_ROWS) {
    issues.push({ path: 'rounds', message: `组结构会生成 ${rows} 行，超过单动作上限 ${MAX_SET_ROWS} 行` });
  }
  validateRest(issues, 'restInSec', t.restInSec, MAX_REST_IN_SEC);
  validateRest(issues, 'restAfterSec', t.restAfterSec, MAX_REST);
  return issues;
}

/* ── 应用：把配置应用到当前动作（保留 actual / set.id）──────── */

export interface RemovedRecordImpact {
  groupIndex: number;
  stageIndex: number;
  set: SessionSet;
  reason: string;
}

export interface TargetApplyImpact {
  formBefore: TrainingForm;
  formAfter: TrainingForm;
  groupCountBefore: number;
  groupCountAfter: number;
  stageCountBefore: number;
  stageCountAfter: number;
  /** R02：逐轮阶段数（用于影响预览，例如第 1 轮 3、第 2 轮 2） */
  roundStageCountsBefore: Array<{ index: number; stageCount: number }>;
  roundStageCountsAfter: Array<{ roundIndex: number; stageCount: number }>;
  /** W01：重量口径变化（已有数值时需确认） */
  weightModeBefore: ExerciseTarget['weightMode'];
  weightModeAfter: ExerciseTarget['weightMode'];
  dumbbellBasisBefore: 'per_hand' | 'total';
  dumbbellBasisAfter: 'per_hand' | 'total';
  /** 会被删除且**含实际输入**的组/阶段记录（明确列给用户确认） */
  removedWithData: RemovedRecordImpact[];
  removedBlankCount: number;
  addedBlankCount: number;
  /** true = 必须先向用户展示影响并确认，不能静默执行 */
  needsConfirmation: boolean;
  messages: string[];
  /** 配置本身不合法时的明确问题（apply 会拒绝执行） */
  validationIssues: ConfigIssue[];
}

export type ApplyTargetResult =
  | { applied: false; exercise: SessionExercise; impact: TargetApplyImpact }
  | { applied: true; exercise: SessionExercise; impact: TargetApplyImpact };

function setHasInput(s: SessionSet): boolean {
  if (typeof s.reps === 'number' && Number.isFinite(s.reps)) return true;
  if (typeof s.weightKg === 'number' && Number.isFinite(s.weightKg)) return true;
  if (s.status !== 'blank') return true;
  return Boolean(s.note && s.note.trim());
}

function describeSetImpact(s: SessionSet): string {
  const bits: string[] = [];
  if (typeof s.reps === 'number') bits.push(`${s.reps} 次`);
  if (typeof s.weightKg === 'number') bits.push(`${s.weightKg} kg`);
  if (s.status !== 'blank') bits.push(s.status === 'done' ? '已完成' : '部分完成');
  if (s.note && s.note.trim()) bits.push('有备注');
  return bits.join(' · ') || '有输入';
}

function blankSetFor(
  roundIndex: number,
  stageIndex: number,
  toFailure: boolean,
  stageId: string | null = null,
): SessionSet {
  return {
    id: newLocalId('set'),
    roundIndex,
    stageIndex,
    ...(stageId ? { stageId } : {}),
    reps: null,
    weightKg: null,
    status: 'blank',
    ...(toFailure ? { toFailure: true } : {}),
  };
}

/**
 * 计算「把 nextTarget 应用到 ex」的结构影响，不写任何东西。
 * UI 先展示影响 → 用户确认 → 再调用 applyTargetToExercise(..., {confirmImpact:true})。
 */
export function planTargetApply(ex: SessionExercise, nextTarget: ExerciseTarget): TargetApplyImpact {
  const formBefore = trainingFormOf(ex.target);
  const formAfter = trainingFormOf(nextTarget);
  const afterGroups = groupPlanForTarget(nextTarget);
  const groupCountAfter = afterGroups.length;
  const stageCountAfter = afterGroups.length ? Math.max(...afterGroups.map((g) => g.stageCount)) : targetStageCount(nextTarget);
  const beforeGroups = ex.groups.length
    ? ex.groups.map((g) => ({ index: g.index, stageCount: g.stageCount }))
    : groupPlanForTarget(ex.target);

  const keptSetIds = new Set<string>();
  let addedBlankCount = 0;
  for (const group of afterGroups) {
    for (let si = 1; si <= group.stageCount; si += 1) {
      const nextStageId = stageIdentityAtForGroup(nextTarget, group.index, si);
      // 稳定阶段 ID 优先；旧数据用确定性的位置 ID（第一轮 stage-pos-N）做一次性兼容。
      // 不能直接按 stageIndex 位置匹配，否则删除首/中阶段或重排会把 actual 串到别的阶段。
      const old = ex.sets.find((s) => {
        if (s.roundIndex !== group.index) return false;
        if (nextStageId !== null) {
          return (s.stageId ?? stageIdentityAtForGroup(ex.target, s.roundIndex, s.stageIndex)) === nextStageId;
        }
        return s.stageIndex === si;
      });
      if (old) keptSetIds.add(old.id);
      else addedBlankCount += 1;
    }
  }

  const removedWithData: RemovedRecordImpact[] = [];
  let removedBlankCount = 0;
  for (const s of ex.sets) {
    if (keptSetIds.has(s.id)) continue;
    if (setHasInput(s)) {
      removedWithData.push({
        groupIndex: s.roundIndex,
        stageIndex: s.stageIndex,
        set: s,
        reason: describeSetImpact(s),
      });
    } else {
      removedBlankCount += 1;
    }
  }

  const messages: string[] = [];
  if (formBefore !== formAfter) {
    messages.push(`训练形式将从「${trainingFormLabel(formBefore)}」改为「${trainingFormLabel(formAfter)}」`);
  }
  // R02：逐轮阶段数变化必须明确展示（例如 3/3 → 3/2），不能只说整体阶段数
  const changedRounds: string[] = [];
  const maxRound = Math.max(beforeGroups.length, afterGroups.length);
  for (let gi = 1; gi <= maxRound; gi += 1) {
    const b = beforeGroups.find((g) => g.index === gi)?.stageCount ?? 0;
    const a = afterGroups.find((g) => g.index === gi)?.stageCount ?? 0;
    if (b !== a) changedRounds.push(`第 ${gi} 轮 ${b || '—'}→${a || '—'} 阶段`);
  }
  if (changedRounds.length) messages.push(changedRounds.join('，'));

  // W01：重量口径变化（同一动作的已有数值不得被无提示重新解释）
  const modeBefore = ex.target.weightMode;
  const modeAfter = nextTarget.weightMode;
  const basisBefore = ex.target.dumbbellBasis ?? 'total';
  const basisAfter = nextTarget.dumbbellBasis ?? 'total';
  const actualSets = ex.sets.filter(setHasInput);
  const modeChanged = modeBefore !== modeAfter || basisBefore !== basisAfter;
  if (modeChanged) {
    const actualGroups = Array.from(new Set(actualSets.map((s) => s.roundIndex))).sort((a, b) => a - b);
    const modeText = `重量口径将从「${WEIGHT_MODE_LABEL[modeBefore] ?? modeBefore}」改为「${
      WEIGHT_MODE_LABEL[modeAfter] ?? modeAfter
    }」${basisBefore !== basisAfter ? `（哑铃口径 ${basisBefore} → ${basisAfter}）` : ''}`;
    messages.push(
      actualSets.length
        ? `${modeText}；当前动作已有 ${actualSets.length} 条记录（组 ${actualGroups.join('、')}）会按新口径解释，数值本身不会被改写。确认后才能保存。`
        : `${modeText}（本次尚无实际记录）`,
    );
  }

  if (removedWithData.length) {
    messages.push(
      `将删除 ${removedWithData.length} 条已输入记录（组/阶段：${removedWithData
        .map((r) => `${r.groupIndex}-${r.stageIndex}`)
        .join('、')}）。确认后才能执行，取消则完整保留。`,
    );
  }
  if (removedBlankCount) messages.push(`将移除 ${removedBlankCount} 条空白记录`);

  return {
    formBefore,
    formAfter,
    groupCountBefore: beforeGroups.length,
    groupCountAfter,
    stageCountBefore: beforeGroups.length ? Math.max(...beforeGroups.map((g) => g.stageCount)) : 1,
    stageCountAfter,
    roundStageCountsBefore: beforeGroups,
    roundStageCountsAfter: afterGroups.map((g) => ({ roundIndex: g.index, stageCount: g.stageCount })),
    weightModeBefore: modeBefore,
    weightModeAfter: modeAfter,
    dumbbellBasisBefore: basisBefore,
    dumbbellBasisAfter: basisAfter,
    removedWithData,
    removedBlankCount,
    addedBlankCount,
    needsConfirmation: removedWithData.length > 0 || (modeChanged && actualSets.length > 0),
    messages,
    validationIssues: [],
  };
}

/**
 * 把目标配置应用到当前动作。
 *
 * · 保留所有仍在新结构内的 `SessionSet.id` 与 actual（reps/weight/status/note）；
 * · 删除含实际输入的组/阶段时，若未 `confirmImpact: true` → 不执行并返回影响；
 * · 删除空白组/阶段 → 直接执行（仍返回影响供提示）；
 * · **绝不自动拆卡**；原计划 target / 历史由调用方保证不写回。
 */
export function applyTargetToExercise(
  ex: SessionExercise,
  nextTarget: ExerciseTarget,
  opts: { confirmImpact?: boolean; makeSetId?: (roundIndex: number, stageIndex: number) => string } = {},
): ApplyTargetResult {
  /**
   * 统一校验是 apply 的第一道门（PRE-REVIEW 后续检查项）：
   * 非法目标（空 label / 反向次数 / 超限等）直接拒绝，session 原样返回。
   */
  const validationIssues = validateExerciseTarget(nextTarget);
  const impact = planTargetApply(ex, nextTarget);
  impact.validationIssues = validationIssues;
  if (validationIssues.length) {
    impact.messages = [
      `配置不合法，未应用：${validationIssues.map((i) => `${i.path} ${i.message}`).join('；')}`,
      ...impact.messages,
    ];
    return { applied: false, exercise: ex, impact };
  }
  if (impact.needsConfirmation && !opts.confirmImpact) {
    return { applied: false, exercise: ex, impact };
  }

  // 缺失阶段 ID 用统一身份解析补齐，保证 impact 计算与实际执行使用同一套映射。
  // 无法证明同源的 override 阶段使用轮内确定性兜底 ID，绝不与默认轮按位置合并；
  // 不再传入裸 `stage-pos-<轮>-<阶段>` 生成器，避免覆盖解析器已避让可信身份的兜底 ID。
  const target = ensureStageIds(structuredClone(nextTarget) as ExerciseTarget);
  const afterGroups = groupPlanForTarget(target);
  const groups: GroupPlan[] = [];
  const sets: SessionSet[] = [];
  const oldGroups = new Map(ex.groups.map((g) => [g.index, g]));

  for (const group of afterGroups) {
    const gi = group.index;
    const stageCount = group.stageCount;
    // G1-PRE-REVIEW #2：仅改名称/次数/阶段名时必须保留既有 skipped；
    // 新增组默认未跳过；已删除的组自然消失。
    groups.push({ index: gi, stageCount, ...(oldGroups.get(gi)?.skipped ? { skipped: true } : {}) });
    for (let si = 1; si <= stageCount; si += 1) {
      const resolved = resolveGroupConfig(target, gi, si);
      const nextStageId = stageIdentityAtForGroup(target, gi, si);
      const old = ex.sets.find((s) => {
        if (s.roundIndex !== gi) return false;
        if (nextStageId !== null) {
          return (s.stageId ?? stageIdentityAtForGroup(ex.target, s.roundIndex, s.stageIndex)) === nextStageId;
        }
        return s.stageIndex === si;
      });
      if (old) {
        const next: SessionSet = {
          id: old.id,
          roundIndex: gi,
          stageIndex: si,
          ...(nextStageId ? { stageId: nextStageId } : old.stageId ? { stageId: old.stageId } : {}),
          reps: old.reps,
          weightKg: old.weightKg,
          status: old.status,
          ...(resolved.toFailure ? { toFailure: true } : {}),
          ...(old.note !== undefined ? { note: old.note } : {}),
        };
        sets.push(next);
      } else {
        const id = opts.makeSetId?.(gi, si);
        const blank = blankSetFor(gi, si, resolved.toFailure, nextStageId);
        sets.push(id ? { ...blank, id } : blank);
      }
    }
  }

  const nextExercise: SessionExercise = {
    ...ex,
    target,
    groups,
    sets,
    status: ex.status === 'skipped' ? 'skipped' : ex.status,
  };
  return { applied: true, exercise: nextExercise, impact };
}

/* ── 动作身份变更影响（供 G2 确认）────────── */

export interface IdentityChangeImpact {
  changed: boolean;
  fromExerciseId: string;
  toExerciseId: string;
  hasActual: boolean;
  affectedGroups: number[];
  affectedSetCount: number;
  message: string;
}

/**
 * 评估「真实动作身份」变更的影响。
 * 名称显示修正（exerciseId 不变）不触发；真实身份变更且已有 actual 时
 * 必须让用户确认或按 R14 新增另一动作，不能静默串历史。
 */
export function assessExerciseIdentityChange(
  ex: SessionExercise,
  nextExerciseId: string,
  nextName?: string,
): IdentityChangeImpact {
  const changed = nextExerciseId !== ex.exerciseId;
  const actualSets = ex.sets.filter(setHasInput);
  const affectedGroups = Array.from(new Set(actualSets.map((s) => s.roundIndex))).sort((a, b) => a - b);
  const hasActual = actualSets.length > 0;
  const label = nextName?.trim() || nextExerciseId;
  const message = !changed
    ? '动作身份未变化（只改显示名不影响历史归属）'
    : hasActual
      ? `把真实动作身份改为「${label}」会影响已输入的 ${affectedGroups.length} 组记录（组 ${affectedGroups.join('、')}）。请确认，或按 R14 新增另一动作；不会自动拆卡。`
      : `动作身份将改为「${label}」（本次尚无实际记录）`;
  return {
    changed,
    fromExerciseId: ex.exerciseId,
    toExerciseId: nextExerciseId,
    hasActual,
    affectedGroups,
    affectedSetCount: actualSets.length,
    message,
  };
}

/* ── 模板：纯配置提取 / 新实例深复制 ───────── */

/**
 * 从当前动作提取纯配置模板。
 * 只取 name/en/target/restSec；**不含 actual、status、runningSinceAt、plan 来源**。
 * 阶段 ID 若缺失则补齐（模板是新写入，不重写旧历史）。
 */
export function extractExerciseTemplate(
  ex: SessionExercise,
  revision = 1,
  now = Date.now(),
  makeStageId?: (stageIndex: number) => string,
): ExerciseTemplate {
  const target = ensureStageIds(structuredClone(ex.target) as ExerciseTarget, makeStageId);
  return {
    key: `exercise-template:${ex.exerciseId}`,
    schemaVersion: 1,
    exerciseId: ex.exerciseId,
    name: ex.name,
    ...(ex.en !== undefined ? { en: ex.en } : {}),
    target,
    restSec: ex.restSec,
    ...(ex.setupNote ? { setupNote: ex.setupNote } : {}),
    revision,
    updatedAt: now,
  };
}

/**
 * 由编辑器纯配置直接构建模板（G2A 输出用；不依赖 SessionExercise/actual）。
 * 仍复用 extractExerciseTemplate 的纯配置与阶段 ID 逻辑。
 */
export function exerciseTemplateFromConfig(cfg: {
  exerciseId: string;
  name: string;
  en?: string;
  target: ExerciseTarget;
  restSec: number;
  setupNote?: string;
  revision?: number;
  now?: number;
  makeStageId?: (stageIndex: number) => string;
}): ExerciseTemplate {
  const synthetic: SessionExercise = {
    id: 'editor-synthetic',
    exerciseId: cfg.exerciseId,
    planExerciseId: null,
    name: cfg.name,
    ...(cfg.en !== undefined ? { en: cfg.en } : {}),
    restSec: cfg.restSec,
    ...(cfg.setupNote ? { setupNote: cfg.setupNote } : {}),
    target: cfg.target,
    status: 'pending',
    groups: [],
    sets: [],
  };
  return extractExerciseTemplate(synthetic, cfg.revision ?? 1, cfg.now ?? Date.now(), cfg.makeStageId);
}

/**
 * 由模板生成**全新训练实例**：新 sessionExerciseId、新 set ID，
 * 不继承 actual / status / 计时 / 计划来源（R12 / M04）。
 * `target` 深复制，调用方修改新实例不会影响模板或其他实例。
 */
export function sessionExerciseFromTemplate(
  tpl: ExerciseTemplate,
  makeSetId?: (roundIndex: number, stageIndex: number) => string,
): SessionExercise {
  const target = ensureStageIds(structuredClone(tpl.target) as ExerciseTarget);
  const groups = groupPlanForTarget(target);
  const sets: SessionSet[] = [];
  for (const g of groups) {
    for (let si = 1; si <= g.stageCount; si += 1) {
      const resolved = resolveGroupConfig(target, g.index, si);
      const id = makeSetId?.(g.index, si) ?? newLocalId('set');
      sets.push({
        id,
        roundIndex: g.index,
        stageIndex: si,
        ...(resolved.stageId ? { stageId: resolved.stageId } : {}),
        reps: null,
        weightKg: null,
        status: 'blank',
        ...(resolved.toFailure ? { toFailure: true } : {}),
      });
    }
  }
  return {
    id: newLocalId('sex'),
    exerciseId: tpl.exerciseId,
    planExerciseId: null,
    name: tpl.name,
    ...(tpl.en !== undefined ? { en: tpl.en } : {}),
    restSec: tpl.restSec,
    ...(tpl.setupNote ? { setupNote: tpl.setupNote } : {}),
    target,
    status: 'pending',
    groups,
    sets,
    note: '',
    added: true,
  };
}

/* ── 不可信输入的健壮解析（模板 / 备份 / 旧数据边界）────────
   G1-PRE-REVIEW #5：不能把 unknown 直接 cast 成 ExerciseTarget 后调用 typed
   validator —— 未知 kind、stages 非数组、label 数字、perSetConfigs 非数组
   可能 throw 或被错误接受。这里逐字段白名单解析，坏输入返回 issues。 */

const WEIGHT_MODES = ['external', 'bodyweight', 'bodyweight_plus', 'assisted'] as const;
const DUMBBELL_BASES = ['per_hand', 'total'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: ConfigIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `不允许的字段（模板/纯配置白名单）：${key}` });
    }
  }
}

function readIntField(
  v: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigIssue[],
): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    issues.push({ path, message: `必须是 ${min}–${max} 的整数` });
    return null;
  }
  if (v < min || v > max) {
    issues.push({ path, message: `必须在 ${min}–${max} 之间` });
    return null;
  }
  return v;
}

function readNullableNumberField(
  v: unknown,
  path: string,
  min: number,
  max: number,
  issues: ConfigIssue[],
): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.push({ path, message: '必须是有限数字或 null' });
    return null;
  }
  if (v < min || v > max) {
    issues.push({ path, message: `必须在 ${min}–${max} 之间` });
    return null;
  }
  return v;
}

function oneOfString<T extends string>(
  v: unknown,
  path: string,
  allowed: readonly T[],
  issues: ConfigIssue[],
): T | null {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    issues.push({ path, message: `必须是 ${allowed.join(' / ')} 之一` });
    return null;
  }
  return v as T;
}

function parseStageUnknown(stage: unknown, path: string, issues: ConfigIssue[]): DropStageTarget {
  if (!isPlainObject(stage)) {
    issues.push({ path, message: '阶段必须是对象' });
    return { label: '', weightKg: null, repsMin: null, repsMax: null, toFailure: false, targetText: '' };
  }
  rejectUnknownKeys(stage, ['id', 'label', 'weightKg', 'repsMin', 'repsMax', 'toFailure', 'restAfterSec', 'targetText'], path, issues);
  const label = typeof stage.label === 'string' ? stage.label : '';
  if (typeof stage.label !== 'string') issues.push({ path: `${path}.label`, message: '阶段名必须是文本' });
  if (stage.id !== undefined && (typeof stage.id !== 'string' || !stage.id.trim())) {
    issues.push({ path: `${path}.id`, message: '阶段 ID 必须是非空文本' });
  }
  const targetText = typeof stage.targetText === 'string' ? stage.targetText : '';
  if (stage.targetText !== undefined && typeof stage.targetText !== 'string') {
    issues.push({ path: `${path}.targetText`, message: 'targetText 必须是文本' });
  }
  return {
    ...(typeof stage.id === 'string' && stage.id.trim() ? { id: stage.id } : {}),
    label,
    weightKg: readNullableNumberField(stage.weightKg, `${path}.weightKg`, 0, MAX_WEIGHT, issues),
    repsMin: readIntField(stage.repsMin, `${path}.repsMin`, 0, MAX_REPS, issues),
    repsMax: readIntField(stage.repsMax, `${path}.repsMax`, 0, MAX_REPS, issues),
    toFailure: (() => {
      if (stage.toFailure === undefined) return false;
      if (typeof stage.toFailure !== 'boolean') {
        issues.push({ path: `${path}.toFailure`, message: '必须是布尔值' });
        return false;
      }
      return stage.toFailure;
    })(),
    ...(stage.restAfterSec !== undefined
      ? { restAfterSec: readIntField(stage.restAfterSec, `${path}.restAfterSec`, 0, MAX_REST_IN_SEC, issues) ?? 0 }
      : {}),
    targetText,
  };
}

/**
 * 健壮解析一个 unknown 的 ExerciseTarget。
 * 只保留白名单字段并重建普通对象；未知字段（含 actual/status/runtime）明确报错。
 */
export function parseExerciseTargetUnknown(
  raw: unknown,
): { ok: true; target: ExerciseTarget } | { ok: false; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: 'target', message: 'target 必须是对象' }] };
  }
  const kind = raw.kind;
  if (kind !== 'straight' && kind !== 'dropSet') {
    return { ok: false, issues: [{ path: 'target.kind', message: 'target.kind 只能是 straight 或 dropSet' }] };
  }

  if (kind === 'straight') {
    rejectUnknownKeys(
      raw,
      ['kind', 'sets', 'setsMax', 'repsMin', 'repsMax', 'weightMode', 'suggestedWeightKg', 'dumbbellBasis', 'toFailure', 'perSetConfigs'],
      'target',
      issues,
    );
    const sets = readIntField(raw.sets, 'target.sets', 0, MAX_STRAIGHT_SETS, issues) ?? 0;
    const setsMax = readIntField(raw.setsMax, 'target.setsMax', 0, MAX_STRAIGHT_SETS, issues) ?? sets;
    if (setsMax < sets) issues.push({ path: 'target.setsMax', message: '组数上限不能小于组数' });
    const repsMin = readIntField(raw.repsMin, 'target.repsMin', 0, MAX_REPS, issues) ?? 0;
    const repsMax = readIntField(raw.repsMax, 'target.repsMax', 0, MAX_REPS, issues) ?? 0;
    if (repsMax < repsMin) issues.push({ path: 'target.repsMax', message: '次数上限不能小于下限' });
    const weightMode = oneOfString(raw.weightMode, 'target.weightMode', WEIGHT_MODES, issues) ?? 'external';
    const target: StraightTarget = {
      kind: 'straight',
      sets,
      setsMax,
      repsMin,
      repsMax,
      weightMode,
      suggestedWeightKg: readNullableNumberField(raw.suggestedWeightKg, 'target.suggestedWeightKg', 0, MAX_WEIGHT, issues),
    };
    if (raw.dumbbellBasis !== undefined) {
      const basis = oneOfString(raw.dumbbellBasis, 'target.dumbbellBasis', DUMBBELL_BASES, issues);
      if (basis) target.dumbbellBasis = basis;
    }
    if (raw.toFailure !== undefined) {
      if (typeof raw.toFailure !== 'boolean') issues.push({ path: 'target.toFailure', message: '必须是布尔值' });
      else target.toFailure = raw.toFailure;
    }
    if (raw.perSetConfigs !== undefined) {
      if (!Array.isArray(raw.perSetConfigs)) {
        issues.push({ path: 'target.perSetConfigs', message: '必须是数组' });
      } else {
        target.perSetConfigs = raw.perSetConfigs.map((entry, i) => {
          const p = `target.perSetConfigs[${i}]`;
          if (!isPlainObject(entry)) {
            issues.push({ path: p, message: '每组配置必须是对象' });
            return { setIndex: i + 1, repsMin: null, repsMax: null, suggestedWeightKg: null, toFailure: false };
          }
          rejectUnknownKeys(entry, ['setIndex', 'repsMin', 'repsMax', 'suggestedWeightKg', 'toFailure'], p, issues);
          const setIndex = readIntField(entry.setIndex, `${p}.setIndex`, 1, MAX_STRAIGHT_SETS, issues) ?? i + 1;
          return {
            setIndex,
            repsMin: readIntField(entry.repsMin, `${p}.repsMin`, 0, MAX_REPS, issues),
            repsMax: readIntField(entry.repsMax, `${p}.repsMax`, 0, MAX_REPS, issues),
            suggestedWeightKg: readNullableNumberField(entry.suggestedWeightKg, `${p}.suggestedWeightKg`, 0, MAX_WEIGHT, issues),
            toFailure: (() => {
              if (entry.toFailure === undefined) return false;
              if (typeof entry.toFailure !== 'boolean') {
                issues.push({ path: `${p}.toFailure`, message: '必须是布尔值' });
                return false;
              }
              return entry.toFailure;
            })(),
          };
        });
      }
    }
    return issues.length ? { ok: false, issues } : { ok: true, target };
  }

  // dropSet / superset
  rejectUnknownKeys(
    raw,
    ['kind', 'form', 'rounds', 'stages', 'roundConfigs', 'restInSec', 'restAfterSec', 'weightMode', 'dumbbellBasis'],
    'target',
    issues,
  );
  const target: DropSetTarget = {
    kind: 'dropSet',
    rounds: readIntField(raw.rounds, 'target.rounds', 1, MAX_ROUNDS, issues) ?? 1,
    stages: [],
    restInSec: readIntField(raw.restInSec, 'target.restInSec', 0, MAX_REST_IN_SEC, issues) ?? 0,
    restAfterSec: readIntField(raw.restAfterSec, 'target.restAfterSec', 0, MAX_REST, issues) ?? 0,
    weightMode: oneOfString(raw.weightMode, 'target.weightMode', WEIGHT_MODES, issues) ?? 'external',
  };
  if (raw.form !== undefined) {
    const form = oneOfString(raw.form, 'target.form', ['dropSet', 'superset'] as const, issues);
    if (form) target.form = form;
  }
  if (raw.dumbbellBasis !== undefined) {
    const basis = oneOfString(raw.dumbbellBasis, 'target.dumbbellBasis', DUMBBELL_BASES, issues);
    if (basis) target.dumbbellBasis = basis;
  }
  if (!Array.isArray(raw.stages)) {
    issues.push({ path: 'target.stages', message: 'stages 必须是数组' });
  } else if (raw.stages.length > MAX_STAGES_ACCEPTED) {
    issues.push({ path: 'target.stages', message: `阶段数不能超过 ${MAX_STAGES_ACCEPTED}` });
  } else {
    target.stages = raw.stages.map((stage, i) => parseStageUnknown(stage, `target.stages[${i}]`, issues));
  }
  if (raw.roundConfigs !== undefined) {
    if (!Array.isArray(raw.roundConfigs)) {
      issues.push({ path: 'target.roundConfigs', message: 'roundConfigs 必须是数组' });
    } else if (raw.roundConfigs.length > MAX_ROUNDS) {
      issues.push({ path: 'target.roundConfigs', message: `逐轮配置不能超过 ${MAX_ROUNDS} 项` });
    } else {
      target.roundConfigs = raw.roundConfigs.map((entry, i): DropRoundConfig => {
        const p = `target.roundConfigs[${i}]`;
        if (!isPlainObject(entry)) {
          issues.push({ path: p, message: '逐轮配置必须是对象' });
          return { roundIndex: i + 1, stages: [] };
        }
        rejectUnknownKeys(entry, ['roundIndex', 'stages', 'restInSec'], p, issues);
        const roundIndex = readIntField(entry.roundIndex, `${p}.roundIndex`, 1, MAX_ROUNDS, issues) ?? i + 1;
        let stages: DropStageTarget[] = [];
        if (!Array.isArray(entry.stages)) {
          issues.push({ path: `${p}.stages`, message: '每轮阶段配置必须是数组' });
        } else if (entry.stages.length > MAX_STAGES_ACCEPTED) {
          issues.push({ path: `${p}.stages`, message: `阶段数不能超过 ${MAX_STAGES_ACCEPTED}` });
        } else {
          stages = entry.stages.map((stage, si) => parseStageUnknown(stage, `${p}.stages[${si}]`, issues));
        }
        return {
          roundIndex,
          stages,
          ...(entry.restInSec !== undefined
            ? { restInSec: readIntField(entry.restInSec, `${p}.restInSec`, 0, MAX_REST_IN_SEC, issues) ?? 0 }
            : {}),
        };
      });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, target };
}

/* ── 备份/模板合法性：禁止运行态混入模板 ───── */

const TEMPLATE_FORBIDDEN_KEYS = [
  'sets',
  'actual',
  'actuals',
  'status',
  'runningSinceAt',
  'elapsedMs',
  'segments',
  'planExerciseId',
  'planCardioId',
  'sessionId',
  'groups',
] as const;

/** 扫描模板内是否混入运行态/历史字段（模板必须是纯配置） */
export function findTemplateContraband(tpl: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (typeof tpl !== 'object' || tpl === null) return issues;
  for (const key of TEMPLATE_FORBIDDEN_KEYS) {
    if (key in (tpl as Record<string, unknown>)) {
      issues.push({ path: key, message: '动作模板只能保存纯配置，不能包含运行态/实际记录字段' });
    }
  }
  return issues;
}
