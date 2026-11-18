import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { findV4Contraband } from '../src/db/backupCompat';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { atomicSavePlanWithTemplate, buildBackup, getPlan, getSession, restoreBackup, savePlan, validateBackup } from '../src/db/repo';
import { listExerciseTemplates } from '../src/db/templates';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSessionWithTemplate, revisionOf } from '../src/db/tx';
import {
  CARDIO_PRESET_CHOICES,
  commitCardioParams,
  completeCardio,
  createCardioEntry,
  markFreeCardioSegment,
  startCardio,
  validateCardioEntry,
  validateCardioParams,
} from '../src/domain/cardio';
import { extractExerciseTemplate, sessionExerciseFromTemplate } from '../src/domain/exerciseConfig';
import { correctHistoryCardioEntry } from '../src/domain/historyEdit';
import { planExerciseFromTemplate } from '../src/domain/planEdit';
import { parsePlanTemplate } from '../src/domain/planTemplate';
import { EXAMPLE_PLAN_TEMPLATE } from '../src/domain/planTemplateExample';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession, withCardioEntry } from '../src/domain/session';
import { parseSetupNote, setupNoteFor, withSetupNote } from '../src/domain/setupNote';
import type { CardioParams, CardioPreset } from '../src/domain/types';

const NOW = 1_800_000_000_000;

beforeEach(async () => {
  __resetDbHandle();
  for (const store of ['plans', 'sessions', 'settings', 'meta']) {
    await idbClear(store);
  }
});

describe('Wave 4 versioned data contracts', () => {
  it('validates each preset using the same fields for plan goals, live entries and backups', async () => {
    const plan = structuredClone(createV32Plan(NOW));
    plan.days[0].focus = 'shoulders';
    plan.days[0].exercises[0].setupNote = '座椅 4';
    plan.days.push({
      id: 'wave4-cardio-day', name: '器械有氧', kind: 'cardio', exercises: [], warmups: [],
      cardio: CARDIO_PRESET_CHOICES.map(({ preset, label, params }) => ({
        id: `goal-${preset}`, preset, name: label, target: params,
      })),
    });
    await savePlan(plan);
    let session = createSession(plan, plan.days[0], NOW);
    for (const { preset, label, params } of CARDIO_PRESET_CHOICES) {
      expect(validateCardioParams(preset, params)).toEqual([]);
      let entry = startCardio(createCardioEntry({ preset, name: label, params }), NOW);
      if (preset === 'free-cardio') {
        const marked = markFreeCardioSegment(entry, '户外第一段', NOW + 1_000);
        if (!marked.ok) throw new Error(marked.reason);
        entry = marked.entry;
      }
      entry = completeCardio(entry, NOW + 2_000);
      expect(validateCardioEntry(entry, NOW + 2_000)).toEqual([]);
      session = withCardioEntry(session, entry);
    }
    await atomicCreateSession({ session });
    const backup = await buildBackup('0.2.0');
    expect(backup.version).toBe(4);
    const parsed = validateBackup(JSON.parse(JSON.stringify(backup)));
    if (!parsed.ok) throw new Error(parsed.error);
    await restoreBackup(parsed.payload);
    const restoredPlan = await getPlan(plan.id);
    const restored = await getSession(session.id);
    expect(restoredPlan?.days[0].focus).toBe('shoulders');
    expect(restoredPlan?.days[0].exercises[0].setupNote).toBe('座椅 4');
    expect(restoredPlan?.days.at(-1)?.cardio?.map((item) => item.preset)).toEqual(CARDIO_PRESET_CHOICES.map((item) => item.preset));
    expect(restored?.day.focus).toBe('shoulders');
    expect(restored?.exercises[0].setupNote).toBe('座椅 4');
    expect(restored?.cardio?.find((item) => item.preset === 'free-cardio')?.segments[0].note).toBe('户外第一段');
  });

  it.each([1, 2, 3])('rejects v%s with new data before legacy normalization', (version) => {
    const data = {
      plans: [{ days: [{ focus: 'upper', exercises: [{ setupNote: '' }], cardio: [{ preset: 'elliptical' }] }] }],
      sessions: [{ day: { focus: 'core' }, exercises: [{ setupNote: '座椅 4' }], cardio: [{
        preset: 'free-cardio', currentParams: { resistanceLevel: 5 },
        segments: [{ params: { cadenceRpm: 80 }, note: '一段' }],
      }] }],
      exerciseTemplates: [{ setupNote: '胸垫 2' }],
    };
    expect(findV4Contraband(data).map((item) => item.path)).toEqual([
      'plans[0].days[0].focus', 'plans[0].days[0].exercises[0].setupNote', 'plans[0].days[0].cardio[0].preset',
      'sessions[0].day.focus', 'sessions[0].exercises[0].setupNote', 'sessions[0].cardio[0].preset',
      'sessions[0].cardio[0].currentParams.resistanceLevel', 'sessions[0].cardio[0].segments[0].params.cadenceRpm',
      'sessions[0].cardio[0].segments[0].note', 'exerciseTemplates[0].setupNote',
    ]);
    const result = validateBackup({ format: 'motion-training-backup', version, data });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('包含 v4 结构');
  });

  it('imports v1 and v2 plan templates with the appropriate version boundary', () => {
    expect(parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW).ok).toBe(true);
    const document = JSON.parse(EXAMPLE_PLAN_TEMPLATE);
    document.plan.days[0].focus = 'full';
    document.plan.days[0].exercises[0].setupNote = '握距 2';
    document.plan.days.push({ name: '单车', kind: 'cardio', cardio: [
      { preset: 'stationary-bike', name: '动感单车', target: { resistanceLevel: 25, cadenceRpm: 85 } },
    ] });
    expect(parsePlanTemplate(JSON.stringify(document), NOW).ok).toBe(false);
    document.version = 2;
    const result = parsePlanTemplate(JSON.stringify(document), NOW);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.plan.days[0].focus).toBe('full');
    expect(result.plan.days[0].exercises[0].setupNote).toBe('握距 2');
    expect(result.plan.days.at(-1)?.cardio?.[0].target).toEqual({ resistanceLevel: 25, cadenceRpm: 85 });
  });

  it.each<[CardioPreset, CardioParams]>([
    ['stationary-bike', { resistanceLevel: 0 }],
    ['stationary-bike', { resistanceLevel: 5, cadenceRpm: 251 }],
    ['elliptical', { resistanceLevel: 8, inclinePct: 41 }],
    ['rowing-machine', { damperLevel: 4.5 }],
    ['rowing-machine', { damperLevel: 4, splitSecPer500m: 59 }],
    ['free-cardio', { speedKmh: 4 }],
    ['treadmill-incline', { speedKmh: 4, inclinePct: 8, cadenceRpm: 80 }],
  ])('rejects out-of-range or foreign fields in %s', (preset, params) => {
    expect(validateCardioParams(preset, params)).not.toEqual([]);
  });

  it('starts a new segment when optional fields change and preserves free-cardio notes on duration correction', () => {
    const bike = startCardio(createCardioEntry({ preset: 'stationary-bike', name: '单车', params: { resistanceLevel: 5 } }), NOW);
    const changed = commitCardioParams(bike, { resistanceLevel: 5, cadenceRpm: 85 }, NOW + 1_000);
    if (!changed.ok) throw new Error(changed.reason);
    expect(changed.entry.segments).toHaveLength(2);
    expect(changed.entry.segments[1].params.cadenceRpm).toBe(85);
    const cleared = commitCardioParams(changed.entry, { resistanceLevel: 5 }, NOW + 2_000);
    if (!cleared.ok) throw new Error(cleared.reason);
    expect(cleared.entry.segments[2].params).toEqual({ resistanceLevel: 5 });
    let free = startCardio(createCardioEntry({ preset: 'free-cardio', name: '户外', params: {} }), NOW);
    const marked = markFreeCardioSegment(free, '跑步', NOW + 1_000);
    if (!marked.ok) throw new Error(marked.reason);
    free = completeCardio(marked.entry, NOW + 2_000);
    const plan = createV32Plan(NOW);
    const session = { ...withCardioEntry(createSession(plan, plan.days[0], NOW), free), endedAt: NOW + 2_000 };
    const corrected = correctHistoryCardioEntry(session, free.id, { durationSec: 4 });
    if (!corrected.ok) throw new Error(corrected.message);
    const [first, second] = corrected.session.cardio![0].segments;
    expect(first).toMatchObject({ endElapsedMs: 2_000, note: '跑步' });
    expect(second).toMatchObject({ startElapsedMs: 2_000, endElapsedMs: 4_000 });
  });
});

describe('器械档位', () => {
  it('cleans empty notes and rejects long or multiline notes', () => {
    expect(parseSetupNote('   ')).toEqual({ ok: true });
    expect(parseSetupNote('座椅 4\n握距 2').ok).toBe(false);
    expect(parseSetupNote('档'.repeat(201)).ok).toBe(false);
  });

  it('commits changes and template revision together, and an outdated revision cannot overwrite either', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days[0];
    await savePlan(plan);
    const session = createSession(plan, day, NOW);
    const [exercise] = session.exercises;
    const updated = withSetupNote(exercise, '握距 3');
    const remembered = extractExerciseTemplate(updated);
    const candidate = { ...plan, days: plan.days.map((item) => item !== day ? item : {
      ...item, exercises: item.exercises.map((ex, i) => i === 0 ? withSetupNote(ex, '握距 3') : ex),
    }) };
    expect((await atomicSavePlanWithTemplate(candidate, { template: remembered, expectedRevision: null })).ok).toBe(true);
    expect((await getPlan(plan.id))?.days[0].exercises[0].setupNote).toBe('握距 3');
    expect(planExerciseFromTemplate(remembered).setupNote).toBe('握距 3');
    expect(sessionExerciseFromTemplate(remembered).setupNote).toBe('握距 3');

    await atomicCreateSession({ session });
    await atomicAcquireLock(session.id, 'wave4-editor');
    const saved = (await getSession(session.id))!;
    const save = (expected: number, note: string | undefined) => atomicSaveSessionWithTemplate({
      session: { ...saved, exercises: saved.exercises.map((ex, i) => i === 0 ? withSetupNote(ex, note) : ex) },
      guard: { editorId: 'wave4-editor', expectedVersion: revisionOf(saved) },
      template: withSetupNote(remembered, note),
      templateExpectedRevision: expected,
    });
    expect((await save(0, '过期写入')).ok).toBe(false);
    expect((await getSession(session.id))?.exercises[0].setupNote).toBe(saved.exercises[0].setupNote);
    expect((await listExerciseTemplates())[0].setupNote).toBe('握距 3');
    const exported = validateBackup(JSON.parse(JSON.stringify(await buildBackup('0.2.0'))));
    if (!exported.ok) throw new Error(exported.error);
    expect(exported.payload.data.exerciseTemplates[0].setupNote).toBe('握距 3');
    expect((await save(1, undefined)).ok).toBe(true);
    const [cleared] = await listExerciseTemplates();
    expect(cleared).not.toHaveProperty('setupNote');
    expect((await getSession(session.id))?.exercises[0].setupNote).toBeUndefined();
    expect(setupNoteFor(updated, cleared)).toBeUndefined();
  });
});
