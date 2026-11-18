import { useCallback, useMemo, useState } from 'react';
import { exerciseTemplateFromConfig } from '../../domain/exerciseConfig';
import { setupNoteFor, withSetupNote } from '../../domain/setupNote';
import type { ExerciseTemplate, Session, SessionExercise } from '../../domain/types';
import type { PairedOutcome } from '../../lib/pairedCommit';
import { SetupNoteSheet } from '../../ui/SetupNoteSheet';

export function useSetupNoteTarget(templates: ExerciseTemplate[]) {
  const [setupNoteForId, setSetupNoteForId] = useState<string | null>(null);
  const templatesById = useMemo(() => new Map(templates.map((item) => [item.exerciseId, item])), [templates]);
  const openSetupNote = useCallback((id: string) => setSetupNoteForId(id), []);
  const closeSetupNote = useCallback(() => setSetupNoteForId(null), []);
  return { setupNoteForId, openSetupNote, closeSetupNote, templatesById };
}

interface Props {
  exercise: SessionExercise;
  memory?: ExerciseTemplate;
  blocked: boolean;
  templateError?: string | null;
  onClose: () => void;
  commit: (
    buildNext: (fresh: Session) => Session,
    templateWrite: { template: ExerciseTemplate; expectedRevision: number | null },
  ) => Promise<PairedOutcome>;
}

export function SessionSetupNote({ exercise, memory, blocked, templateError, onClose, commit }: Props) {
  return (
    <SetupNoteSheet
      exerciseName={exercise.name}
      initial={setupNoteFor(exercise, memory)}
      revision={memory?.revision}
      onClose={onClose}
      onSave={async (note) => {
        if (blocked) return { ok: false, message: '训练暂时不可编辑' };
        if (templateError) return { ok: false, message: templateError };
        const template = memory ?? exerciseTemplateFromConfig(exercise);
        const result = await commit((fresh) => {
          const target = fresh.exercises.find((item) => item.id === exercise.id);
          if (!target || target.exerciseId !== exercise.exerciseId) throw new Error('动作已变化，请重新打开');
          return {
            ...fresh,
            exercises: fresh.exercises.map((item) => item === target ? withSetupNote(item, note) : item),
          };
        }, { template: withSetupNote(template, note), expectedRevision: memory?.revision ?? null });
        if (result.status === 'saved') return { ok: true };
        return { ok: false, message: result.message };
      }}
    />
  );
}
