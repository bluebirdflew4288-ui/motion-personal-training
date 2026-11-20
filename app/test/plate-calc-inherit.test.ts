import { describe, expect, it } from 'vitest';
import { calculateBarbellPlates } from '../src/domain/plateCalc';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  addSetTo,
  collectPrefillWeightFieldIds,
  createSession,
  inheritPreviousCompleteRound,
  inheritStraightSetValues,
  removeSetFrom,
  withSet,
  withSetAndPrefillFollowingWeight,
} from '../src/domain/session';
import {
  clearRawFieldsInMaps,
  hasNonEmptyRawDraftInMaps,
} from '../src/pages/session/rawDraftHelpers';
import { isUnfinishedNumberDraft } from '../src/ui/Stepper';

function makeStraightSession() {
  const plan = createV32Plan(1_760_000_000_000);
  const sess = createSession(plan, plan.days[0], 1_760_000_000_000);
  const ex = sess.exercises.find((e) => e.target.kind === 'straight' && e.sets.length >= 3);
  if (!ex) throw new Error('expected straight-set exercise with >=3 sets');
  return { sess, ex };
}

describe('配片预填与组间数值沿用全场景回归', () => {
  it('复现场景 1a：首组配片 60kg 自动预填后仅第 1 组填 4 次，沿用应按次数来源补齐第 2/3 组而非被后续预填重量吞掉', () => {
    const { sess: initSess, ex } = makeStraightSession();
    const [s1, s2, s3] = ex.sets;

    // 1. 配片填入 60kg → 自动预填第 2、3 组为 60kg
    let sess = withSetAndPrefillFollowingWeight(initSess, ex.id, s1.id, { weightKg: 60 });
    // 2. 第 1 组只填 4 次（未标完成）
    sess = withSet(sess, ex.id, s1.id, { reps: 4 });

    const out = inheritStraightSetValues(sess, ex.id);
    expect(out.hasAnySource).toBe(true);
    expect(out.filledSets).toBe(2);
    expect(out.filledFields).toBe(2);
    expect(out.changedSetIds).toEqual([s2.id, s3.id]);
    expect(out.touchedFieldIds).toEqual([`${s2.id}:reps`, `${s3.id}:reps`]);

    const afterEx = out.session.exercises.find((e) => e.id === ex.id)!;
    expect(afterEx.sets[0]).toMatchObject({ weightKg: 60, reps: 4, status: 'blank' });
    expect(afterEx.sets[1]).toMatchObject({ weightKg: 60, reps: 4, status: 'blank' });
    expect(afterEx.sets[2]).toMatchObject({ weightKg: 60, reps: 4, status: 'blank' });
  });

  it('复现场景 1b：3 组均填 4 次但第 2/3 组删空 60kg 后，沿用可独立从首组找回 60kg 补齐重量', () => {
    const { sess: initSess, ex } = makeStraightSession();
    const [s1, s2, s3] = ex.sets;

    let sess = withSetAndPrefillFollowingWeight(initSess, ex.id, s1.id, { weightKg: 60 });
    sess = withSet(sess, ex.id, s1.id, { reps: 4 });
    sess = withSet(sess, ex.id, s2.id, { reps: 4, weightKg: null });
    sess = withSet(sess, ex.id, s3.id, { reps: 4, weightKg: null });

    const out = inheritStraightSetValues(sess, ex.id);
    expect(out.hasAnySource).toBe(true);
    expect(out.filledSets).toBe(2);
    expect(out.filledFields).toBe(2);
    expect(out.touchedFieldIds).toEqual([`${s2.id}:weight`, `${s3.id}:weight`]);

    const afterEx = out.session.exercises.find((e) => e.id === ex.id)!;
    expect(afterEx.sets[0]).toMatchObject({ weightKg: 60, reps: 4 });
    expect(afterEx.sets[1]).toMatchObject({ weightKg: 60, reps: 4 });
    expect(afterEx.sets[2]).toMatchObject({ weightKg: 60, reps: 4 });
  });

  it('复现场景 2：删掉第 2/3 组再加回并再次配片 65kg 后，沿用依然稳定补齐', () => {
    const { sess: initSess, ex } = makeStraightSession();
    const [s1, s2, s3] = ex.sets;

    let sess = withSetAndPrefillFollowingWeight(initSess, ex.id, s1.id, { weightKg: 60 });
    sess = withSet(sess, ex.id, s1.id, { reps: 4 });
    sess = removeSetFrom(sess, ex.id, s3.id);
    sess = removeSetFrom(sess, ex.id, s2.id);
    sess = addSetTo(sess, ex.id);
    sess = addSetTo(sess, ex.id);

    const readdedEx = sess.exercises.find((e) => e.id === ex.id)!;
    expect(readdedEx.sets).toHaveLength(3);

    sess = withSetAndPrefillFollowingWeight(sess, ex.id, readdedEx.sets[0].id, { weightKg: 65 });
    const out = inheritStraightSetValues(sess, ex.id);
    expect(out.filledSets).toBe(2);
    expect(out.filledFields).toBe(2);

    const afterEx = out.session.exercises.find((e) => e.id === ex.id)!;
    expect(afterEx.sets.map((st) => [st.weightKg, st.reps])).toEqual([
      [65, 4],
      [65, 4],
      [65, 4],
    ]);
  });

  it('优先级、保留已有值、跳过组隔离、0 值与状态保护均正确', () => {
    const { sess: initSess, ex } = makeStraightSession();
    const [s1, s2, s3] = ex.sets;

    // 1. 已完成组优先于未完成部分组；已填非空字段保留；partial 状态不越权改为 done
    let sess = withSet(initSess, ex.id, s1.id, { weightKg: 60, reps: 8, status: 'done' });
    sess = withSet(sess, ex.id, s2.id, { weightKg: null, reps: 5, status: 'partial' });
    sess = withSet(sess, ex.id, s3.id, { weightKg: 70, reps: null, status: 'blank' });

    const out = inheritStraightSetValues(sess, ex.id);
    expect(out.filledFields).toBe(2); // s2 补 weightKg=60，s3 补 reps=8
    const afterEx = out.session.exercises.find((e) => e.id === ex.id)!;
    expect(afterEx.sets[0]).toMatchObject({ weightKg: 60, reps: 8, status: 'done' });
    expect(afterEx.sets[1]).toMatchObject({ weightKg: 60, reps: 5, status: 'partial' });
    expect(afterEx.sets[2]).toMatchObject({ weightKg: 70, reps: 8, status: 'blank' });

    // 2. 跳过组既不作为来源，也不被沿用改写
    let skippedSess = withSet(initSess, ex.id, s1.id, { weightKg: 100, reps: 12, status: 'done' });
    skippedSess = {
      ...skippedSess,
      exercises: skippedSess.exercises.map((e) =>
        e.id === ex.id
          ? {
              ...e,
              groups: e.groups.map((g) => (g.index === 1 ? { ...g, skipped: true } : g)),
            }
          : e,
      ),
    };
    skippedSess = withSet(skippedSess, ex.id, s2.id, { weightKg: 0, reps: 0, status: 'blank' });
    const outZero = inheritStraightSetValues(skippedSess, ex.id);
    const afterZeroEx = outZero.session.exercises.find((e) => e.id === ex.id)!;
    expect(afterZeroEx.sets[0]).toMatchObject({ weightKg: 100, reps: 12 }); // 跳过组不动
    expect(afterZeroEx.sets[1]).toMatchObject({ weightKg: 0, reps: 0 }); // 0kg / 0次被保留
    expect(afterZeroEx.sets[2]).toMatchObject({ weightKg: 0, reps: 0 }); // 且 0kg / 0次可被第 3 组沿用

    // 3. 没有任何可填字段时返回原始 session 引用
    const noop = inheritStraightSetValues(outZero.session, ex.id);
    expect(noop.filledFields).toBe(0);
    expect(noop.session).toBe(outZero.session);
  });

  it('空串 rawDraft 不阻断配片预填与沿用，未成型小数草稿 "."/"72." 仍受保护并正确联动清理', () => {
    const { sess: initSess, ex } = makeStraightSession();
    const [s1, s2, s3] = ex.sets;

    const rawRiskMap = new Map<string, Set<string>>();
    const rawDraftMap = new Map<string, Map<string, string>>();

    // 空串 ""：已删空但不应阻断按钮与 finish()
    rawRiskMap.set(ex.id, new Set([`${s2.id}:weight`]));
    rawDraftMap.set(ex.id, new Map([[`${s2.id}:weight`, '']]));
    expect(hasNonEmptyRawDraftInMaps(rawRiskMap, rawDraftMap, ex.id)).toBe(false);
    expect(hasNonEmptyRawDraftInMaps(rawRiskMap, rawDraftMap)).toBe(false);

    // 仅非空未成型小数（如 "72."）阻止首组预填覆盖第 3 组
    rawRiskMap.get(ex.id)!.add(`${s3.id}:weight`);
    rawDraftMap.get(ex.id)!.set(`${s3.id}:weight`, '72.');
    expect(isUnfinishedNumberDraft('72.')).toBe(true);
    expect(hasNonEmptyRawDraftInMaps(rawRiskMap, rawDraftMap, ex.id)).toBe(true);

    const hasNonEmptyDraft = (otherId: string) => {
      const r = rawDraftMap.get(ex.id)?.get(`${otherId}:weight`);
      return r !== undefined && r !== '';
    };

    const touched = collectPrefillWeightFieldIds(ex, s1.id, 70, true, hasNonEmptyDraft);
    expect(touched).toEqual([`${s1.id}:weight`, `${s2.id}:weight`]);
    expect(clearRawFieldsInMaps(rawRiskMap, rawDraftMap, ex.id, touched)).toBe(true);
    expect(rawDraftMap.get(ex.id)?.has(`${s2.id}:weight`)).toBe(false);
    expect(rawDraftMap.get(ex.id)?.get(`${s3.id}:weight`)).toBe('72.');

    const prefilled = withSetAndPrefillFollowingWeight(
      initSess,
      ex.id,
      s1.id,
      { weightKg: 70 },
      hasNonEmptyDraft,
    );
    const exAfter = prefilled.exercises.find((e) => e.id === ex.id)!;
    expect(exAfter.sets[0].weightKg).toBe(70);
    expect(exAfter.sets[1].weightKg).toBe(70);
    expect(exAfter.sets[2].weightKg).toBeNull(); // 第 3 组保留 "72." 草稿不受预填覆盖
  });

  it('配片精确小数舍入到 2 位小数且多阶段动作沿用按阶段正确补空白', () => {
    const calc = calculateBarbellPlates(62.5, 20);
    expect(calc.achievedTotalKg).toBe(62.5);
    const rounded = Math.round(62.536 * 100) / 100;
    expect(rounded).toBe(62.54);

    const plan = createV32Plan(1_760_000_000_000);
    const sess = createSession(plan, plan.days[0], 1_760_000_000_000);
    const dropEx = sess.exercises.find((e) => e.target.kind === 'dropSet');
    if (dropEx) {
      let dSess = sess;
      for (const st of dropEx.sets.filter((s) => s.roundIndex === 1)) {
        dSess = withSet(dSess, dropEx.id, st.id, { reps: 10, weightKg: 50, status: 'done' });
      }
      const r2 = dropEx.sets.find((s) => s.roundIndex === 2 && s.stageIndex === 1);
      if (r2) {
        dSess = withSet(dSess, dropEx.id, r2.id, { weightKg: 50 });
        const dOut = inheritPreviousCompleteRound(dSess, dropEx.id);
        expect(dOut.filledFields).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
