/* Wave 3B：历史详情「纠正数据」全覆盖领域函数层。
   支持：
   1) 修改训练总备注（session.note）与单动作备注（ex.note），严格校验 MAX_TEXT；
   2) 为历史力量动作「+ 补录一组 / 一轮」与删除误建的完全空白组（同步维护 ex.groups 与 roundIndex 连续不变量，绝不误删含实际输入的组）；
   3) 修正已完成有氧记录（含纯有氧与力量+有氧混合场次）的有效总时长与参数，同步规范化 segments 使其 100% 通过 validateCardioEntry 与备份深层校验。 */

import {
  newCardioId,
  normalizeCardioParams,
  validateCardioEntry,
  validateCardioParams,
} from './cardio';
import { MAX_CARDIO_MS, MAX_SET_ROWS, MAX_STRAIGHT_SETS, MAX_TEXT } from './limits';
import {
  addSetBlocker,
  addSetTo,
  dropRoundSets,
  removeSetFrom,
  setHasActualInput,
  withExercise,
} from './session';
import type { CardioEntry, CardioParams, Session, SessionExercise } from './types';

export type HistoryEditResult =
  | { ok: true; session: Session }
  | { ok: false; session: Session; message: string };

/** 更新历史训练总备注 */
export function updateHistorySessionNote(session: Session, note: string): HistoryEditResult {
  if (note.length > MAX_TEXT) {
    return { ok: false, session, message: `训练备注最多 ${MAX_TEXT} 个字符` };
  }
  return { ok: true, session: { ...session, note } };
}

/** 更新历史单动作备注 */
export function updateHistoryExerciseNote(
  session: Session,
  exId: string,
  note: string,
): HistoryEditResult {
  if (note.length > MAX_TEXT) {
    return { ok: false, session, message: `动作备注最多 ${MAX_TEXT} 个字符` };
  }
  if (!session.exercises.some((e) => e.id === exId)) {
    return { ok: false, session, message: '找不到要修改备注的动作' };
  }
  return { ok: true, session: withExercise(session, exId, { note }) };
}

/** 判断某动作在历史纠错态是否还能继续补录一组/一轮 */
export function historyAppendGroupBlocker(ex: SessionExercise): string | null {
  if (ex.target.kind === 'dropSet') {
    return addSetBlocker(ex)?.message ?? null;
  }
  if (ex.groups.length >= MAX_STRAIGHT_SETS) {
    return `已达单动作 ${MAX_STRAIGHT_SETS} 组上限，不能继续补录`;
  }
  if (ex.sets.length >= MAX_SET_ROWS) {
    return `已达单动作 ${MAX_SET_ROWS} 行上限，不能继续补录`;
  }
  return null;
}

/** 在历史动作末尾补录一个空白组/空白轮（复用 addSetTo 保持 groups 与 roundConfigs 一致） */
export function appendBlankGroupToHistoryExercise(
  session: Session,
  exId: string,
): HistoryEditResult {
  const ex = session.exercises.find((e) => e.id === exId);
  if (!ex) {
    return { ok: false, session, message: '找不到要补录的动作' };
  }
  const blocker = historyAppendGroupBlocker(ex);
  if (blocker) {
    return { ok: false, session, message: blocker };
  }
  return { ok: true, session: addSetTo(session, exId) };
}

/** 判断指定轮号在历史记录中是否为「完全空白且可安全移除」（至少保留 1 组） */
export function canRemoveBlankGroupFromHistoryExercise(
  ex: SessionExercise,
  roundIndex: number,
): boolean {
  if (ex.groups.length <= 1) return false;
  const sets = dropRoundSets(ex, roundIndex);
  if (sets.length === 0) return ex.groups.some((g) => g.index === roundIndex);
  return sets.every((s) => !setHasActualInput(s));
}

/** 删除历史动作中误补录或全空的组/轮，并重排后续 roundIndex 与 groups.index */
export function removeBlankGroupFromHistoryExercise(
  session: Session,
  exId: string,
  roundIndex: number,
): HistoryEditResult {
  const ex = session.exercises.find((e) => e.id === exId);
  if (!ex) {
    return { ok: false, session, message: '找不到对应动作' };
  }
  if (ex.groups.length <= 1) {
    return { ok: false, session, message: '至少需要保留 1 组' };
  }
  if (!canRemoveBlankGroupFromHistoryExercise(ex, roundIndex)) {
    return {
      ok: false,
      session,
      message: '该组已有次数、重量或完成状态记录；如需清空请先将状态改为未完成并清空数字',
    };
  }
  const roundSets = dropRoundSets(ex, roundIndex);
  if (roundSets.length > 0) {
    return { ok: true, session: removeSetFrom(session, exId, roundSets[0].id) };
  }
  // 兜底：无 set 行的孤立空白 group
  const keptGroups = ex.groups.filter((g) => g.index !== roundIndex);
  const reindexed = keptGroups.map((g, idx) => ({ ...g, index: idx + 1 }));
  const remap = new Map(keptGroups.map((g, idx) => [g.index, idx + 1]));
  const sets = ex.sets.map((s) => ({ ...s, roundIndex: remap.get(s.roundIndex) ?? s.roundIndex }));
  return {
    ok: true,
    session: {
      ...session,
      exercises: session.exercises.map((e) =>
        e.id === exId ? { ...e, groups: reindexed, sets } : e,
      ),
    },
  };
}

export interface CardioCorrectionPatch {
  /** 修正后的有效总秒数（整数 0 .. MAX_CARDIO_MS/1000） */
  durationSec?: number;
  /** 修正后的参数补丁（与原 currentParams 合并后按 preset 归一化校验） */
  params?: Partial<CardioParams>;
  /** 可选项目备注 */
  note?: string;
}

/**
 * 修正历史记录中单个 `CardioEntry` 的有效总时长与/或关键参数，并重整连续封口 segments。
 */
export function correctHistoryCardioEntry(
  session: Session,
  entryId: string,
  patch: CardioCorrectionPatch,
): HistoryEditResult {
  const list = session.cardio ?? [];
  const idx = list.findIndex((c) => c.id === entryId);
  if (idx < 0) {
    return { ok: false, session, message: '找不到要修改的有氧项目' };
  }
  const entry = list[idx];

  const nextElapsedMs =
    patch.durationSec !== undefined
      ? Math.round(patch.durationSec * 1000)
      : Math.round(entry.elapsedMs);

  if (!Number.isFinite(nextElapsedMs) || nextElapsedMs < 0 || nextElapsedMs > MAX_CARDIO_MS) {
    return {
      ok: false,
      session,
      message: `有氧有效时长必须在 0 到 ${Math.floor(MAX_CARDIO_MS / 3_600_000)} 小时之间`,
    };
  }

  const mergedRawParams: CardioParams =
    patch.params !== undefined
      ? { ...entry.currentParams, ...patch.params }
      : { ...entry.currentParams };
  const nextParams = normalizeCardioParams(entry.preset, mergedRawParams);
  const paramIssues = validateCardioParams(entry.preset, nextParams);
  if (paramIssues.length > 0) {
    return { ok: false, session, message: paramIssues[0].message };
  }

  if (patch.note !== undefined && patch.note.length > MAX_TEXT) {
    return { ok: false, session, message: `有氧备注最多 ${MAX_TEXT} 个字符` };
  }

  let nextSegments: CardioEntry['segments'];
  if (nextElapsedMs === 0) {
    nextSegments = [];
  } else if (patch.params !== undefined || entry.segments.length <= 1 || entry.elapsedMs <= 0) {
    nextSegments = [
      {
        id: entry.segments[0]?.id ?? newCardioId('cseg'),
        startElapsedMs: 0,
        endElapsedMs: nextElapsedMs,
        params: { ...nextParams },
      },
    ];
  } else {
    // 仅修正总时长且原记录有多段参数变化：按原比例缩放各封口段端点，严保首尾相接且总和精确等于 nextElapsedMs
    const origLastEnd =
      entry.segments[entry.segments.length - 1]?.endElapsedMs ?? entry.elapsedMs;
    const denom = origLastEnd > 0 ? origLastEnd : entry.elapsedMs;
    let cursor = 0;
    nextSegments = entry.segments.map((seg, sIdx) => {
      const isLast = sIdx === entry.segments.length - 1;
      const origEnd = seg.endElapsedMs ?? denom;
      const scaledEnd = isLast
        ? nextElapsedMs
        : Math.min(nextElapsedMs, Math.max(cursor, Math.round((origEnd / denom) * nextElapsedMs)));
      const built = {
        id: seg.id,
        startElapsedMs: cursor,
        endElapsedMs: scaledEnd,
        params: normalizeCardioParams(entry.preset, seg.params),
      };
      cursor = scaledEnd;
      return built;
    });
  }

  const updatedEntry: CardioEntry = {
    ...entry,
    status: 'done',
    runningSinceAt: null,
    elapsedMs: nextElapsedMs,
    currentParams: nextParams,
    segments: nextSegments,
    ...(patch.note !== undefined
      ? patch.note
        ? { note: patch.note }
        : { note: undefined }
      : {}),
  };
  if (updatedEntry.note === undefined) {
    delete updatedEntry.note;
  }

  const entryIssues = validateCardioEntry(updatedEntry, session.endedAt ?? Date.now());
  if (entryIssues.length > 0) {
    return {
      ok: false,
      session,
      message: `有氧数据校验未通过：${entryIssues[0].message}`,
    };
  }

  const nextCardio = list.map((c, i) => (i === idx ? updatedEntry : c));
  return {
    ok: true,
    session: {
      ...session,
      cardio: nextCardio,
    },
  };
}
