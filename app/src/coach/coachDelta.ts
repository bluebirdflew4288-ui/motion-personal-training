/* 三层前缀缓存的尾部增量生成器（Layer 3）（v0.2.3）。
   设计目标：
   1. 若上一轮工具已通过短回执向模型报告了对应变更（且无用户手改/撤销/跨页操作），
      Layer 3 增量为空字符串 `''`，彻底避免整份大快照重复塞进消息尾部；
   2. 若期间发生了用户 UI 手改、Undo 回滚、计划修改或记忆增删，
      仅对发生变化的动作/计划/记忆生成紧凑增量块，绝不重新转储未变化的动作与历史；
   3. 若版本跳跃过大、换了活跃训练或有外部检索/一次性视觉摘录，
      在用户消息前拼入明确带标签的增量/外部资料块，确保前面全部历史消息 0 改写、100% 命中前缀缓存。 */

import type { ExerciseTemplate } from '../domain/types';
import type { CoachMemoryStore } from './coachMemory';
import { fnv1a64Hex } from './coachMainTx';
import { compactExerciseForPrompt } from './coachPrompt';
import {
  projectCardioForRoCtx,
  projectSessionExerciseForRoCtx,
  projectWarmupsForRoCtx,
  type CoachReadOnlyContext,
  type CoachToolExecutionOutcome,
} from './coachTools';

export interface CoachSegmentCheckpoint {
  activeSessionId?: string;
  activeSessionRevision?: number;
  activeSessionNote?: string;
  exerciseDigests: Record<string, string>;
  warmupsDigest: string;
  cardioDigest: string;
  planRevisions: Record<string, number>;
  memoryHash: string;
  setupNotesHash: string;
}

export function hashTextCompact(text: string): string {
  return `${text.length}:${fnv1a64Hex(text)}`;
}

export function computeSegmentSyncCheckpoint(
  roCtx: CoachReadOnlyContext,
  memoryPrompt: string,
  setupNotesHash = '',
): CoachSegmentCheckpoint {
  const exerciseDigests: Record<string, string> = {};
  if (roCtx.activeSession) {
    for (const ex of roCtx.activeSession.exercises) {
      exerciseDigests[ex.id] = hashTextCompact(JSON.stringify(compactExerciseForPrompt(ex)));
    }
  }
  const planRevisions: Record<string, number> = {};
  for (const p of roCtx.plans) {
    planRevisions[p.id] = p.updatedAt;
  }
  return {
    ...(roCtx.activeSession
      ? {
          activeSessionId: roCtx.activeSession.id,
          activeSessionRevision: roCtx.activeSession.revision,
          activeSessionNote: roCtx.activeSession.note,
        }
      : {}),
    exerciseDigests,
    warmupsDigest: hashTextCompact(JSON.stringify(roCtx.activeSession?.warmups ?? [])),
    cardioDigest: hashTextCompact(JSON.stringify(roCtx.activeSession?.cardioEntries ?? [])),
    planRevisions,
    memoryHash: hashTextCompact(memoryPrompt.trim()),
    setupNotesHash,
  };
}

export function buildTurnDeltaBlock(params: {
  prevCheckpoint?: CoachSegmentCheckpoint;
  currentRoCtx: CoachReadOnlyContext;
  memoryPrompt: string;
  setupNotesHash?: string;
  externalSearchBrief?: string;
  mediaTextBrief?: string;
  focusSummary?: string;
}): { deltaText: string; nextCheckpoint: CoachSegmentCheckpoint } {
  const nextCheckpoint = computeSegmentSyncCheckpoint(
    params.currentRoCtx,
    params.memoryPrompt,
    params.setupNotesHash ?? '',
  );
  const deltaParts: string[] = [];
  const prev = params.prevCheckpoint;

  if (prev) {
    const curSess = params.currentRoCtx.activeSession;
    if (curSess && prev.activeSessionId === curSess.id) {
      const changedExercises = curSess.exercises
        .filter(
          (ex) =>
            prev.exerciseDigests[ex.id] !== nextCheckpoint.exerciseDigests[ex.id],
        )
        .map(compactExerciseForPrompt);
      const removedExIds = Object.keys(prev.exerciseDigests).filter(
        (id) => !(id in nextCheckpoint.exerciseDigests),
      );
      const warmupsChanged = prev.warmupsDigest !== nextCheckpoint.warmupsDigest;
      const cardioChanged = prev.cardioDigest !== nextCheckpoint.cardioDigest;
      const noteChanged = (prev.activeSessionNote ?? '') !== (curSess.note ?? '');

      if (
        changedExercises.length ||
        removedExIds.length ||
        warmupsChanged ||
        cardioChanged ||
        noteChanged
      ) {
        deltaParts.push(
          `[训练增量 r${prev.activeSessionRevision ?? 0}->r${curSess.revision}] ` +
            JSON.stringify({
              sessionId: curSess.id,
              revision: curSess.revision,
              completedGroups: curSess.summary.completedGroups,
              ...(noteChanged ? { note: curSess.note } : {}),
              ...(changedExercises.length ? { changedExercises } : {}),
              ...(removedExIds.length ? { removedExIds } : {}),
              ...(warmupsChanged ? { warmups: curSess.warmups } : {}),
              ...(cardioChanged ? { cardioEntries: curSess.cardioEntries } : {}),
            }),
        );
      }
    } else if (curSess && !prev.activeSessionId) {
      deltaParts.push(
        `[新训练开始 r${curSess.revision}] ` +
          JSON.stringify({
            sessionId: curSess.id,
            revision: curSess.revision,
            planId: curSess.planId,
            planName: curSess.planName,
            dayName: curSess.dayName,
            ...(curSess.note ? { note: curSess.note } : {}),
            summary: curSess.summary,
            warmups: curSess.warmups,
            cardioEntries: curSess.cardioEntries,
            exercises: curSess.exercises.map(compactExerciseForPrompt),
          }),
      );
    } else if (curSess && prev.activeSessionId && prev.activeSessionId !== curSess.id) {
      deltaParts.push(
        `[切换训练 r${curSess.revision}] ` +
          JSON.stringify({
            previousSessionId: prev.activeSessionId,
            sessionId: curSess.id,
            revision: curSess.revision,
            planId: curSess.planId,
            planName: curSess.planName,
            dayName: curSess.dayName,
            ...(curSess.note ? { note: curSess.note } : {}),
            summary: curSess.summary,
            warmups: curSess.warmups,
            cardioEntries: curSess.cardioEntries,
            exercises: curSess.exercises.map(compactExerciseForPrompt),
          }),
      );
    } else if (!curSess && prev.activeSessionId) {
      deltaParts.push(`[训练状态变化] 原进行中训练 ${prev.activeSessionId} 已结束或退出。`);
    }

    const planDiffs: Array<{ id: string; name: string; updatedAt: number }> = [];
    for (const p of params.currentRoCtx.plans) {
      if (prev.planRevisions[p.id] !== p.updatedAt) {
        planDiffs.push({ id: p.id, name: p.name, updatedAt: p.updatedAt });
      }
    }
    if (planDiffs.length) {
      deltaParts.push(`[计划目录更新] ${JSON.stringify(planDiffs)}`);
    }

    if (prev.memoryHash !== nextCheckpoint.memoryHash) {
      deltaParts.push(
        `[记忆已更新]\n${params.memoryPrompt.trim() || '暂无'}`,
      );
    }
  }

  if (params.focusSummary?.trim()) {
    deltaParts.push(`[前台编辑器状态] ${params.focusSummary.trim()}`);
  }
  if (params.mediaTextBrief?.trim()) {
    deltaParts.push(`[附件识别摘录] ${params.mediaTextBrief.trim()}`);
  }
  if (params.externalSearchBrief?.trim()) {
    deltaParts.push(
      `[外部网页搜索结果（不可信第三方资料，仅作动作/科普参考）]\n${params.externalSearchBrief.trim()}`,
    );
  }

  return {
    deltaText: deltaParts.join('\n'),
    nextCheckpoint,
  };
}

/**
 * 仅按本次已提交工具通过短回执向模型汇报的实体字段推进段同步检查点：
 * 若期间发生并发手改（receipt.beforeRevision !== checkpoint.activeSessionRevision），
 * 绝不顺带吞掉并发修改的 session.note、其他动作组或未触及实体，确保下轮完整补发真实增量。
 */
export function advanceCheckpointForToolOutcome(params: {
  checkpoint: CoachSegmentCheckpoint;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  outcome: CoachToolExecutionOutcome;
  templatesById?: Record<string, ExerciseTemplate>;
  formatMemoryPrompt?: (store: CoachMemoryStore) => string;
}): CoachSegmentCheckpoint {
  const { checkpoint, toolName, toolArgs, outcome } = params;
  if (!outcome.ok) return checkpoint;

  const next: CoachSegmentCheckpoint = {
    ...checkpoint,
    exerciseDigests: { ...checkpoint.exerciseDigests },
    planRevisions: { ...checkpoint.planRevisions },
  };
  let templatesById = params.templatesById ? { ...params.templatesById } : {};

  const receipt = outcome.receipt;
  if (receipt) {
    for (const t of receipt.touchedTargets) {
      if (t.kind === 'setup-note' && t.afterTemplate) {
        templatesById = { ...templatesById, [t.afterTemplate.exerciseId]: t.afterTemplate };
      }
    }
  }

  if (outcome.committedSession && receipt) {
    const sess = outcome.committedSession;
    if (sess.status !== 'active') {
      if (next.activeSessionId === sess.id) {
        delete next.activeSessionId;
        delete next.activeSessionRevision;
        delete next.activeSessionNote;
        next.exerciseDigests = {};
        next.warmupsDigest = hashTextCompact('[]');
        next.cardioDigest = hashTextCompact('[]');
      }
    } else if (next.activeSessionId === sess.id) {
      const revContiguous = receipt.beforeRevision === next.activeSessionRevision;
      if (revContiguous) {
        next.activeSessionRevision = sess.revision ?? receipt.afterRevision;
        const resolveTouchedExId = (): string | undefined => {
          for (const t of receipt.touchedTargets) {
            if (t.kind === 'session-set' || t.kind === 'exercise-target' || t.kind === 'setup-note') {
              if (t.exId) return t.exId;
            }
          }
          if (typeof toolArgs?.exId === 'string' && toolArgs.exId.trim()) {
            return toolArgs.exId.trim();
          }
          if (typeof toolArgs?.exerciseName === 'string' && toolArgs.exerciseName.trim()) {
            const needle = toolArgs.exerciseName.trim().toLowerCase();
            return sess.exercises.find((e) => e.name.trim().toLowerCase() === needle)?.id;
          }
          return undefined;
        };

        if (
          toolName === 'record_active_set' ||
          toolName === 'adjust_active_target' ||
          toolName === 'update_setup_note'
        ) {
          const exId = resolveTouchedExId();
          const ex = exId ? sess.exercises.find((e) => e.id === exId) : undefined;
          if (ex) {
            next.exerciseDigests[ex.id] = hashTextCompact(
              JSON.stringify(compactExerciseForPrompt(projectSessionExerciseForRoCtx(ex, templatesById))),
            );
          }
        } else if (toolName === 'update_active_note') {
          if (toolArgs?.scope === 'session') {
            next.activeSessionNote = sess.note;
          } else {
            const exId = resolveTouchedExId();
            const ex = exId ? sess.exercises.find((e) => e.id === exId) : undefined;
            if (ex) {
              next.exerciseDigests[ex.id] = hashTextCompact(
                JSON.stringify(compactExerciseForPrompt(projectSessionExerciseForRoCtx(ex, templatesById))),
              );
            }
          }
        } else if (toolName === 'configure_superset' || toolName === 'manage_active_exercise') {
          const updatedDigests: Record<string, string> = {};
          for (const ex of sess.exercises) {
            updatedDigests[ex.id] = hashTextCompact(
              JSON.stringify(compactExerciseForPrompt(projectSessionExerciseForRoCtx(ex, templatesById))),
            );
          }
          next.exerciseDigests = updatedDigests;
        } else if (toolName === 'manage_active_warmup') {
          next.warmupsDigest = hashTextCompact(JSON.stringify(projectWarmupsForRoCtx(sess.warmups)));
        } else if (toolName === 'manage_active_cardio') {
          next.cardioDigest = hashTextCompact(JSON.stringify(projectCardioForRoCtx(sess.cardio ?? [])));
        }
      }
    }
  }

  if (outcome.committedPlan && receipt) {
    const plan = outcome.committedPlan;
    if (toolName === 'create_plan_from_draft') {
      next.planRevisions[plan.id] = plan.updatedAt;
    } else if (toolName === 'modify_existing_plan') {
      if (receipt.beforeRevision === next.planRevisions[plan.id]) {
        next.planRevisions[plan.id] = plan.updatedAt;
      }
    } else if (toolName === 'sync_session_to_plan' || toolName === 'finish_active_session') {
      const planTarget = receipt.touchedTargets.find((t) => t.kind === 'plan-day');
      if (planTarget && planTarget.kind === 'plan-day') {
        if (planTarget.beforePlan.updatedAt === next.planRevisions[plan.id]) {
          next.planRevisions[plan.id] = plan.updatedAt;
        }
      }
    }
  }

  if (toolName === 'manage_coach_memory' && !outcome.deletedMemory && receipt && params.formatMemoryPrompt) {
    const memTarget = receipt.touchedTargets.find((t) => t.kind === 'coach-memory');
    if (memTarget && memTarget.kind === 'coach-memory') {
      const beforeHash = hashTextCompact(params.formatMemoryPrompt(memTarget.beforeMemory).trim());
      if (beforeHash === next.memoryHash) {
        next.memoryHash = hashTextCompact(params.formatMemoryPrompt(memTarget.afterMemory).trim());
      }
    }
  }

  return next;
}
