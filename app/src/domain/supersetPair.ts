/* 多动作超级组配对（pairId UUID v4 + 孤立自动清理）与混合超级组防串算口径。
   设计边界：
   1. 两张或多张独立动作卡配对成超级组时，共享同一合法 UUID v4 `pairId`；
      拆散或删剩仅 1 个动作时自动清除孤立 `pairId`。
   2. 若由单一动作卡原地转为多阶段（form: 'superset'）卡片：
      · 未开始记录：分配独立组合身份 `superset:<m1>+<m2>`，绝不复用单动作 exerciseId；
      · 已有部分实绩（如已单练 2 组）：保留原卡已做组与单动作身份，剩余轮拆为独立组合卡。
   3. 对历史/旧数据中「复用单动作 exerciseId 的多阶段超级组」，在 PR / 可比历史 /
      统计趋势 / 渐进提示中按阶段归属过滤或排除歧义阶段，杜绝跨动作串算。 */

import { MAX_EXERCISE_ID, MAX_ROUNDS, MAX_STAGES } from './limits';
import { exerciseIdFromName, normalizeExerciseName, PRESET_EXERCISE_IDS } from './identity';
import { ensureStageIds, resolveGroupConfig } from './exerciseConfig';
import type {
  DropSetTarget,
  DropStageTarget,
  DumbbellBasis,
  Session,
  SessionExercise,
  SessionSet,
  WeightMode,
} from './types';

function setHasInput(s: SessionSet): boolean {
  if (typeof s.reps === 'number' && Number.isFinite(s.reps)) return true;
  if (typeof s.weightKg === 'number' && Number.isFinite(s.weightKg)) return true;
  if (s.status !== 'blank') return true;
  return Boolean(s.note && s.note.trim());
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERIC_STAGE_LABEL_RE = /^(第?\s*\d+\s*阶段|阶段\s*[-\s]*\d+|stage\s*\d+|)$/i;

export function isValidUuidV4(val: unknown): val is string {
  return typeof val === 'string' && UUID_V4_RE.test(val.trim());
}

export function generateUuidV4(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    const id = globalThis.crypto.randomUUID();
    if (isValidUuidV4(id)) return id.toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // RFC 4122 v4: version=4, variant=10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * 清理列表中所有非法或出现次数 < 2 的孤立 `pairId`（Plans 与 Sessions 共用）。
 * 返回新数组（若无改动也保证不修改入参对象）。
 */
export function cleanOrphanPairIds<T extends { pairId?: string }>(exercises: readonly T[]): T[] {
  const counts = new Map<string, number>();
  for (const ex of exercises) {
    if (isValidUuidV4(ex.pairId)) {
      const normalized = ex.pairId.trim().toLowerCase();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  let anyChanged = false;
  const next = exercises.map((ex) => {
    if (ex.pairId === undefined) return ex;
    if (!isValidUuidV4(ex.pairId)) {
      anyChanged = true;
      const copy = { ...ex };
      delete copy.pairId;
      return copy;
    }
    const normalized = ex.pairId.trim().toLowerCase();
    if ((counts.get(normalized) ?? 0) < 2) {
      anyChanged = true;
      const copy = { ...ex };
      delete copy.pairId;
      return copy;
    }
    if (ex.pairId !== normalized) {
      anyChanged = true;
      return { ...ex, pairId: normalized };
    }
    return ex;
  });
  return anyChanged ? next : (exercises as T[]);
}

/**
 * 将列表中的 2 个及以上动作配对为同一超级组，赋予合法 UUID v4 `pairId`。
 */
export function pairExercisesAsSuperset<T extends { id: string; pairId?: string }>(
  exercises: readonly T[],
  targetIds: readonly string[],
  pairId?: string,
): { ok: true; exercises: T[]; pairId: string } | { ok: false; message: string } {
  const uniqueIds = Array.from(new Set(targetIds));
  if (uniqueIds.length < 2) {
    return { ok: false, message: '超级组至少需要配对 2 个动作' };
  }
  const existingSet = new Set(exercises.map((e) => e.id));
  for (const id of uniqueIds) {
    if (!existingSet.has(id)) {
      return { ok: false, message: '配对的目标动作不存在于当前列表中' };
    }
  }
  const chosenPairId = pairId && isValidUuidV4(pairId) ? pairId.trim().toLowerCase() : generateUuidV4();
  const targetSet = new Set(uniqueIds);
  const updated = exercises.map((ex) =>
    targetSet.has(ex.id) ? { ...ex, pairId: chosenPairId } : ex,
  );
  return {
    ok: true,
    exercises: cleanOrphanPairIds(updated),
    pairId: chosenPairId,
  };
}

/**
 * 拆散指定动作或指定 `pairId` 的超级组配对，并自动清理孤立 `pairId`。
 */
export function unpairSupersetExercises<T extends { id: string; pairId?: string }>(
  exercises: readonly T[],
  opts: { exerciseIds?: readonly string[]; pairId?: string },
): T[] {
  const idSet = new Set(opts.exerciseIds ?? []);
  const pairTarget = opts.pairId?.trim().toLowerCase();
  const updated = exercises.map((ex) => {
    const matchId = idSet.has(ex.id);
    const matchPair = pairTarget && ex.pairId?.trim().toLowerCase() === pairTarget;
    if (!matchId && !matchPair) return ex;
    const copy = { ...ex };
    delete copy.pairId;
    return copy;
  });
  return cleanOrphanPairIds(updated);
}

/** 生成多动作组合的稳定 `exerciseId`，绝不复用单一成员动作的 `exerciseId` */
export function supersetCompositeExerciseId(memberIds: readonly string[]): string {
  const raw = `superset:${memberIds.join('+')}`;
  if (raw.length <= MAX_EXERCISE_ID) return raw;
  // 确定性截断 + 短哈希后缀，保持 <= MAX_EXERCISE_ID
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = `-${(hash >>> 0).toString(36)}`;
  return `${raw.slice(0, MAX_EXERCISE_ID - suffix.length)}${suffix}`;
}

export interface SupersetMemberSpec {
  name: string;
  exerciseId?: string;
  weightKg?: number | null;
  repsMin?: number | null;
  repsMax?: number | null;
  toFailure?: boolean;
  restAfterSec?: number;
}

/**
 * 将单动作卡（全部空白或部分已完成）转换为具名多阶段超级组：
 * · 若原动作尚无任何实绩：原地转换为带组合身份的多阶段超级组；
 * · 若原动作已有部分实绩（如已单练 2 组）：保留原已做组与单动作身份，剩余未做轮拆为新组合超级组卡。
 */
export function convertExerciseToMultiStageSuperset(
  session: Session,
  exId: string,
  members: readonly SupersetMemberSpec[],
  opts: {
    rounds?: number;
    restInSec?: number;
    restAfterSec?: number;
    weightMode?: WeightMode;
    dumbbellBasis?: DumbbellBasis;
    makeId?: (prefix: string) => string;
  } = {},
): { ok: true; session: Session; supersetExerciseId: string; preservedCompletedSets: number } | { ok: false; message: string } {
  const idx = session.exercises.findIndex((e) => e.id === exId);
  if (idx < 0) return { ok: false, message: '找不到要转为超级组的动作' };
  if (members.length < 2 || members.length > MAX_STAGES) {
    return { ok: false, message: `超级组阶段数必须在 2 到 ${MAX_STAGES} 之间` };
  }
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, Math.round(opts.rounds ?? 3)));
  const source = session.exercises[idx];
  const makeId = opts.makeId ?? ((p: string) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const memberIds = members.map((m) => m.exerciseId ?? exerciseIdFromName(m.name));
  const compositeId = supersetCompositeExerciseId(memberIds);
  const compositeName = members.map((m) => m.name.trim()).join(' + ');
  const stages: DropStageTarget[] = members.map((m, i) => ({
    id: `stage-${i + 1}`,
    label: m.name.trim(),
    weightKg: m.weightKg ?? null,
    repsMin: m.repsMin ?? 8,
    repsMax: m.repsMax ?? 12,
    toFailure: Boolean(m.toFailure),
    ...(m.restAfterSec !== undefined ? { restAfterSec: m.restAfterSec } : {}),
    targetText: '',
  }));

  const weightMode = opts.weightMode ?? source.target.weightMode;
  const dumbbellBasis = opts.dumbbellBasis ?? source.target.dumbbellBasis;
  const target: DropSetTarget = ensureStageIds({
    kind: 'dropSet',
    form: 'superset',
    rounds,
    stages,
    restInSec: opts.restInSec ?? 15,
    restAfterSec: opts.restAfterSec ?? source.restSec ?? 90,
    weightMode,
    ...(dumbbellBasis ? { dumbbellBasis } : {}),
  }) as DropSetTarget;

  const groups = Array.from({ length: rounds }, (_, r) => ({
    index: r + 1,
    stageCount: stages.length,
  }));
  const sets: SessionSet[] = [];
  for (let r = 1; r <= rounds; r += 1) {
    for (let s = 1; s <= stages.length; s += 1) {
      const st = stages[s - 1];
      sets.push({
        id: makeId('set'),
        roundIndex: r,
        stageIndex: s,
        ...(st.id ? { stageId: st.id } : {}),
        reps: null,
        weightKg: null,
        status: 'blank',
        ...(st.toFailure ? { toFailure: true } : {}),
      });
    }
  }

  const startedGroups = source.groups.filter((g) =>
    source.sets.some((s) => s.roundIndex === g.index && setHasInput(s)),
  );

  if (startedGroups.length === 0) {
    // 原动作尚无任何输入：直接就地转为独立组合超级组（绝不保留单动作 exerciseId）
    const converted: SessionExercise = {
      ...source,
      exerciseId: compositeId,
      planExerciseId: null,
      name: compositeName,
      target,
      groups,
      sets,
      status: 'pending',
    };
    const nextExercises = session.exercises.map((e, i) => (i === idx ? converted : e));
    return {
      ok: true,
      session: { ...session, exercises: cleanOrphanPairIds(nextExercises) },
      supersetExerciseId: converted.id,
      preservedCompletedSets: 0,
    };
  }

  // 已有部分组完成或开始输入：保留已开始轮次的原动作身份与实绩，剩余编排拆成独立组合卡
  const keptIndices = new Set(startedGroups.map((g) => g.index));
  const preservedSets = source.sets.filter((s) => keptIndices.has(s.roundIndex));
  const preservedGroups = startedGroups.map((g, i) => ({
    ...g,
    index: i + 1,
  }));
  const remap = new Map(startedGroups.map((g, i) => [g.index, i + 1]));
  const reindexedPreservedSets = preservedSets.map((s) => ({
    ...s,
    roundIndex: remap.get(s.roundIndex) ?? s.roundIndex,
  }));
  const preservedTarget =
    source.target.kind === 'straight'
      ? {
          ...source.target,
          sets: preservedGroups.length,
          setsMax: Math.max(preservedGroups.length, source.target.setsMax),
        }
      : {
          ...source.target,
          rounds: Math.max(1, preservedGroups.length),
        };
  const keptSource: SessionExercise = {
    ...source,
    target: preservedTarget,
    groups: preservedGroups,
    sets: reindexedPreservedSets,
    status: 'done',
  };

  const newSupersetCard: SessionExercise = {
    id: makeId('sex'),
    exerciseId: compositeId,
    planExerciseId: null,
    name: compositeName,
    restSec: opts.restAfterSec ?? source.restSec ?? 90,
    target,
    status: 'pending',
    groups,
    sets,
    note: '',
    added: true,
  };

  const nextExercises = [
    ...session.exercises.slice(0, idx),
    keptSource,
    newSupersetCard,
    ...session.exercises.slice(idx + 1),
  ];

  return {
    ok: true,
    session: { ...session, exercises: cleanOrphanPairIds(nextExercises) },
    supersetExerciseId: newSupersetCard.id,
    preservedCompletedSets: preservedGroups.length,
  };
}

function stageMatchesSingleExercise(stageLabel: string | null | undefined, ex: SessionExercise): boolean {
  const trimmed = (stageLabel ?? '').trim();
  if (!trimmed || GENERIC_STAGE_LABEL_RE.test(trimmed)) return false;
  const stageResolvedId = exerciseIdFromName(trimmed);
  if (stageResolvedId === ex.exerciseId) return true;
  if (normalizeExerciseName(trimmed) === normalizeExerciseName(ex.name)) return true;
  return false;
}

/**
 * 过滤多阶段超级组（form === 'superset'）用于**单动作**可比/PR/趋势统计的集合：
 * · 普通组与普通递减组（form !== 'superset'）原样保留全部 sets；
 * · 拥有独立组合身份（`exerciseId.startsWith('superset:')`）的原样保留全部 sets；
 * · 旧数据/手工复用单动作 `exerciseId` 的超级组：
 *   - 若各阶段带明确动作名（如「哑铃飞鸟」「哑铃卧推」），只保留与当前宿主 `exerciseId`/`name` 一致的阶段，
 *     排除异动作阶段（避免卧推 12kg 污染飞鸟 PR 与曲线）；
 *   - 若阶段全为泛化名称（如「第 1 阶段」）且在上下文中存在同 ID 的普通直练记录或预设动作身份，
 *     则整个片段视为歧义超级组予以排除。
 */
export function filterComparableSetsForExercise(
  ex: SessionExercise,
  opts?: { hasSingleStraightHistory?: boolean },
): { eligibleSets: SessionSet[]; excludedAmbiguous: boolean } {
  if (ex.target.kind !== 'dropSet' || ex.target.form !== 'superset') {
    return { eligibleSets: ex.sets, excludedAmbiguous: false };
  }
  if (ex.exerciseId.startsWith('superset:')) {
    return { eligibleSets: ex.sets, excludedAmbiguous: false };
  }

  const stageLabels = ex.sets.map((s) => resolveGroupConfig(ex.target, s.roundIndex, s.stageIndex).label);
  const hasAnyMatchingLabel = stageLabels.some((lbl) => stageMatchesSingleExercise(lbl, ex));
  if (hasAnyMatchingLabel) {
    const eligibleSets = ex.sets.filter((s) =>
      stageMatchesSingleExercise(resolveGroupConfig(ex.target, s.roundIndex, s.stageIndex).label, ex),
    );
    return {
      eligibleSets,
      excludedAmbiguous: eligibleSets.length < ex.sets.length,
    };
  }

  // 检查是否包含非泛化且全部指向其他动作的明确标签
  const explicitNonGeneric = stageLabels.filter((lbl): lbl is string => {
    const t = (lbl ?? '').trim();
    return Boolean(t) && !GENERIC_STAGE_LABEL_RE.test(t);
  });
  const anyMatchesPresetOrDifferentName = explicitNonGeneric.some(
    (lbl) => Boolean(PRESET_EXERCISE_IDS[lbl.trim()]) && exerciseIdFromName(lbl) !== ex.exerciseId,
  );
  if (anyMatchesPresetOrDifferentName) {
    return { eligibleSets: [], excludedAmbiguous: true };
  }

  // 泛化阶段名 + 同 ID 存在普通单练上下文或预设单动作身份 -> 歧义片段，不混入单动作比较
  const allGeneric = stageLabels.every((lbl) => GENERIC_STAGE_LABEL_RE.test((lbl ?? '').trim()));
  const isPresetSingleId = Object.values(PRESET_EXERCISE_IDS).includes(ex.exerciseId);
  if (allGeneric && (opts?.hasSingleStraightHistory || isPresetSingleId)) {
    return { eligibleSets: [], excludedAmbiguous: true };
  }

  return { eligibleSets: ex.sets, excludedAmbiguous: false };
}

/** 收集在会话集合中以「非超级组（straight / dropSet）」形态出现过的 exerciseId，用于判定歧义 */
export function collectSingleMovementIds(sessions: readonly Session[]): Set<string> {
  const ids = new Set<string>();
  for (const s of sessions) {
    for (const ex of s.exercises) {
      if (ex.target.kind === 'straight' || (ex.target.kind === 'dropSet' && ex.target.form !== 'superset')) {
        ids.add(ex.exerciseId ?? ex.name);
      }
    }
  }
  return ids;
}
