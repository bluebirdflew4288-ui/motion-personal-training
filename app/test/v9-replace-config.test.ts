/* 需求 1：训练中替换动作后确认「组数」与「休息时间」。

   ── 本文件锁住的契约 ─────────────────────────────────────────
   1. 组数指**新动作本次要做的组数**，不是「原动作剩余组数」。
   2. 休息秒数只写本次 session 快照（普通组 restSec / 递减组 restAfterSec），
      **绝不回写计划**。
   3. 已有原动作数据继续归属原动作：不删除、不改名、不归到新动作。
   4. 递减组沿用原阶段结构，轮数按确认值；不把轮数当阶段数。
   5. 目标分母（targetSetsAtStart）保持开始时的快照不变。
   6. 初始值继承可承接的原动作配置（replaceConfigSeedFor）。

   证据边界：这是领域纯函数的单元测试。真机/模拟器上的 UI 行为与原生提醒
   不在本文件覆盖范围，见 verify-expansion/PHASE-1-REPORT.md 的未验证项。 */

import { describe, expect, it } from 'vitest';
import {
  checkGroupRowBudget,
  clampRestSec,
  createSession,
  exerciseCompletion,
  groupHasActualInput,
  isSetLogged,
  replaceConfigSeedFor,
  replaceExerciseInSession,
  roundsOf,
  summarizeSession,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { MAX_REST, MAX_ROUNDS, MAX_STRAIGHT_SETS } from '../src/domain/limits';
import type { DropSetTarget, Session, SessionExercise } from '../src/domain/types';

const NOW = 1_760_000_000_000;

/** 递减组只出现在「腿 A / 腿 B」（哑铃侧平举 3 轮 × 3 阶段），
    因此需要递减组的用例必须用腿日；普通组用例用胸 A 即可。 */
function setup(dayName = '胸 A') {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.name === dayName)!;
  const session = createSession(plan, day, NOW);
  return { plan, day, session };
}

function setupLegs() {
  return setup('腿 A');
}

/** 找到递减组动作（哑铃侧平举是 3 轮 × 3 阶段） */
function dropExercise(session: Session): SessionExercise {
  const ex = session.exercises.find((e) => e.target.kind === 'dropSet');
  if (!ex) throw new Error('预设里应有递减组动作');
  return ex;
}

function straightExercise(session: Session): SessionExercise {
  const ex = session.exercises.find((e) => e.target.kind === 'straight');
  if (!ex) throw new Error('预设里应有普通组动作');
  return ex;
}

describe('需求 1 · 普通组替换：组数与休息按用户确认值', () => {
  it('未开始的动作：组数用确认值，不是原组数', () => {
    const { session } = setup();
    const ex = straightExercise(session);

    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', {
      config: { sets: 5, restSec: 90 },
    });
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '史密斯推肩')!;

    expect(next.groups).toHaveLength(5);
    expect(next.restSec).toBe(90);
    expect(next.target.kind).toBe('straight');
    if (next.target.kind === 'straight') {
      expect(next.target.sets).toBe(5);
      expect(next.target.setsMax).toBe(5);
    }
    // 普通组每组 1 阶段
    expect(next.sets).toHaveLength(5);
    expect(next.sets.every((s) => s.stageIndex === 1)).toBe(true);
  });

  it('休息 0 秒是合法值，不会被当成「没填」而回退旧值', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', { config: { restSec: 0 } });
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '史密斯推肩')!;
    expect(next.restSec).toBe(0);
  });

  it('未指定配置时保持旧行为（承接组数 + 原休息）', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩');
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '史密斯推肩')!;
    expect(next.groups).toHaveLength(ex.groups.length);
    expect(next.restSec).toBe(ex.restSec);
  });

  it('组数超上限时夹紧到合法上限，不产生非法结构', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', {
      config: { sets: 9999 },
    });
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '史密斯推肩')!;
    expect(next.groups).toHaveLength(MAX_STRAIGHT_SETS);
  });
});

describe('需求 1 · 已有记录：原数据归属原动作', () => {
  it('已做 1 组后替换：原动作保留记录，新动作按确认组数', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const firstSet = ex.sets[0];
    const s = withSet(session, ex.id, firstSet.id, { reps: 10, weightKg: 60, status: 'done' });

    const r = replaceExerciseInSession(s, ex.id, '史密斯推肩', {
      config: { sets: 2, restSec: 75 },
    });
    expect(r.replaced).toBe(true);

    const kept = r.session.exercises.find((e) => e.name === ex.name)!;
    const fresh = r.session.exercises.find((e) => e.name === '史密斯推肩')!;

    // 原动作：记录仍在、仍归属原名与原 exerciseId
    expect(kept.sets.filter(isSetLogged)).toHaveLength(1);
    expect(kept.exerciseId).toBe(ex.exerciseId);
    expect(kept.name).toBe(ex.name);
    // 未开始的组被标记跳过（不删除已有数据）
    expect(kept.groups.some((g) => g.skipped)).toBe(true);

    // 新动作：组数=确认值（不是「剩余组数」）
    expect(fresh.groups).toHaveLength(2);
    expect(fresh.restSec).toBe(75);
    expect(fresh.sets.every((x) => x.status === 'blank')).toBe(true);
    expect(fresh.exerciseId).not.toBe(kept.exerciseId);

    // 顺序：原动作在前，新动作紧随其后（位置不变）
    const iKept = r.session.exercises.findIndex((e) => e.id === kept.id);
    const iFresh = r.session.exercises.findIndex((e) => e.id === fresh.id);
    expect(iFresh).toBe(iKept + 1);
  });

  it('原动作的部分组不会被改名或迁移到新动作', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    // 第 1 组只填重量没填次数 → partial，属于「已开始但未完成」
    const s = withSet(session, ex.id, ex.sets[0].id, { weightKg: 42.5, status: 'partial' });

    const r = replaceExerciseInSession(s, ex.id, '史密斯推肩', { config: { sets: 3 } });
    expect(r.replaced).toBe(true);

    const kept = r.session.exercises.find((e) => e.name === ex.name)!;
    const fresh = r.session.exercises.find((e) => e.name === '史密斯推肩')!;

    // 部分组的重量记录留在原动作
    expect(kept.sets.some((x) => x.weightKg === 42.5)).toBe(true);
    // 新动作不含任何原动作的数值
    expect(fresh.sets.every((x) => x.weightKg === null && x.reps === null)).toBe(true);
    // 原动作的 exerciseId 不被新动作顶替
    expect(kept.exerciseId).toBe(ex.exerciseId);
  });

  it('全部组都已开始记录时拒绝替换，且不产生任何数据改动', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    let s = session;
    for (const st of ex.sets) {
      s = withSet(s, ex.id, st.id, { reps: 8, status: 'done' });
    }
    const before = JSON.stringify(s);
    const r = replaceExerciseInSession(s, ex.id, '史密斯推肩', { config: { sets: 2 } });
    expect(r.replaced).toBe(false);
    expect(r.message).toContain('没有可承接');
    expect(JSON.stringify(r.session)).toBe(before);
  });
});

describe('需求 1 · 递减组替换沿用阶段结构', () => {
  it('轮数按确认值，阶段结构保持原样（不把轮数当阶段数）', () => {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const stages = (ex.target as DropSetTarget).stages.length;

    const r = replaceExerciseInSession(session, ex.id, '器械推胸', {
      config: { sets: 4, restSec: 150 },
    });
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '器械推胸')!;

    expect(next.target.kind).toBe('dropSet');
    if (next.target.kind === 'dropSet') {
      expect(next.target.rounds).toBe(4);
      expect(next.target.stages).toHaveLength(stages); // 阶段数不变
      expect(next.target.restAfterSec).toBe(150); // 整轮后休息按确认值
    }
    expect(next.groups).toHaveLength(4);
    expect(next.groups.every((g) => g.stageCount === stages)).toBe(true);
    expect(next.sets).toHaveLength(4 * stages);
  });

  it('递减组已做 1 阶段后替换：原记录留在原动作，新动作承接', () => {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const st1 = ex.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    const s = withSet(session, ex.id, st1.id, { reps: 12, weightKg: 7.5, status: 'done' });

    const r = replaceExerciseInSession(s, ex.id, '器械推胸', { config: { sets: 2 } });
    expect(r.replaced).toBe(true);

    const kept = r.session.exercises.find((e) => e.name === ex.name)!;
    const fresh = r.session.exercises.find((e) => e.name === '器械推胸')!;

    expect(kept.sets.filter(isSetLogged)).toHaveLength(1);
    expect(kept.exerciseId).toBe(ex.exerciseId);
    expect(fresh.groups).toHaveLength(2);
    // 承接的轮仍是完整阶段结构
    expect(fresh.groups.every((g) => g.stageCount === (ex.target as DropSetTarget).stages.length)).toBe(true);
  });

  it('递减组轮数超上限时夹紧到 MAX_ROUNDS', () => {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '器械推胸', { config: { sets: 500 } });
    expect(r.replaced).toBe(true);
    const next = r.session.exercises.find((e) => e.name === '器械推胸')!;
    expect(next.groups).toHaveLength(MAX_ROUNDS);
  });
});

describe('需求 1 · 目标分母与统计口径不变', () => {
  it('替换不改变 targetSetsAtStart 快照', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const before = summarizeSession(session, NOW).targetSets;
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', {
      config: { sets: 6, restSec: 45 },
    });
    expect(r.replaced).toBe(true);
    expect(summarizeSession(r.session, NOW).targetSets).toBe(before);
    // 但本次安排确实按用户确认的组数变化
    expect(r.session.exercises.find((e) => e.name === '史密斯推肩')!.groups).toHaveLength(6);
  });

  it('替换后不做任何组时完成量仍为 0（不凭空造训练量）', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', { config: { sets: 4 } });
    expect(r.replaced).toBe(true);
    const summary = summarizeSession(r.session, NOW);
    expect(summary.completedSets).toBe(0);
    expect(summary.partialGroups).toBe(0);
  });

  it('已有完整组计入完成量，且不因替换丢失', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    let s = session;
    for (const st of ex.sets.slice(0, 2)) {
      s = withSet(s, ex.id, st.id, { reps: 10, status: 'done' });
    }
    const beforeCompleted = summarizeSession(s, NOW).completedSets;
    const r = replaceExerciseInSession(s, ex.id, '史密斯推肩', { config: { sets: 2 } });
    expect(r.replaced).toBe(true);
    expect(summarizeSession(r.session, NOW).completedSets).toBe(beforeCompleted);
  });
});

describe('需求 1 · 初始值继承（replaceConfigSeedFor）', () => {
  it('未开始动作：组数=可承接组数，休息=原动作休息', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const seed = replaceConfigSeedFor(ex);
    expect(seed.kind).toBe('straight');
    expect(seed.carriedCount).toBe(ex.groups.length);
    expect(seed.sets).toBe(ex.groups.length);
    expect(seed.restSec).toBe(ex.restSec);
  });

  it('已做 1 组：可承接数 = 剩余组数', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, status: 'done' });
    const updated = s.exercises.find((e) => e.id === ex.id)!;
    const seed = replaceConfigSeedFor(updated);
    expect(seed.carriedCount).toBe(ex.groups.length - 1);
    expect(seed.sets).toBe(ex.groups.length - 1);
  });

  it('递减组：休息取 restAfterSec（完成整轮后的休息）', () => {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const seed = replaceConfigSeedFor(ex);
    expect(seed.kind).toBe('dropSet');
    expect(seed.restSec).toBe((ex.target as DropSetTarget).restAfterSec);
    expect(seed.sets).toBe(ex.groups.length);
  });

  it('全部已开始：carriedCount 为 0（UI 据此拒绝进入配置步骤）', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    let s = session;
    for (const st of ex.sets) s = withSet(s, ex.id, st.id, { reps: 5, status: 'done' });
    const seed = replaceConfigSeedFor(s.exercises.find((e) => e.id === ex.id)!);
    expect(seed.carriedCount).toBe(0);
  });
});

describe('需求 1 · 休息秒数合法化', () => {
  it('clampRestSec 接受 0，拒绝负数/小数/超限/NaN', () => {
    expect(clampRestSec(0)).toBe(0);
    expect(clampRestSec(90)).toBe(90);
    expect(clampRestSec(-5)).toBe(0);
    expect(clampRestSec(12.9)).toBe(12);
    expect(clampRestSec(MAX_REST + 100)).toBe(MAX_REST);
    expect(clampRestSec(Number.NaN)).toBe(0);
  });

  it('替换时超限休息被夹紧，不写入非法值', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', {
      config: { restSec: MAX_REST + 5000 },
    });
    expect(r.replaced).toBe(true);
    expect(r.session.exercises.find((e) => e.name === '史密斯推肩')!.restSec).toBe(MAX_REST);
  });
});

describe('需求 1 · 与既有判定函数一致', () => {
  it('替换后的新动作初始为 pending，不误判为 done/skipped', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', { config: { sets: 3 } });
    const fresh = r.session.exercises.find((e) => e.name === '史密斯推肩')!;
    expect(exerciseCompletion(fresh)).toBe('pending');
    expect(fresh.groups.every((g) => !g.skipped)).toBe(true);
  });

  it('替换后原动作仍有记录的组不被判为「跳过且无记录」', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, status: 'done' });
    const r = replaceExerciseInSession(s, ex.id, '史密斯推肩', { config: { sets: 2 } });
    const kept = r.session.exercises.find((e) => e.name === ex.name)!;
    const recordedRound = kept.groups.find((g) => g.index === 1)!;
    expect(recordedRound.skipped).toBeFalsy();
    expect(groupHasActualInput(kept, 1)).toBe(true);
  });

  it('组结构与 sets 行数始终自洽（stageCount 之和 = sets 行数）', () => {
    const straightSession = setup().session;
    const dropSession = setupLegs().session;
    for (const kind of ['straight', 'dropSet'] as const) {
      const session = kind === 'straight' ? straightSession : dropSession;
      const ex = kind === 'straight' ? straightExercise(session) : dropExercise(session);
      const r = replaceExerciseInSession(session, ex.id, `测试动作-${kind}`, {
        config: { sets: 3, restSec: 60 },
      });
      const next = r.session.exercises.find((e) => e.name === `测试动作-${kind}`)!;
      const expectedRows = next.groups.reduce((n, g) => n + g.stageCount, 0);
      expect(next.sets).toHaveLength(expectedRows);
      expect(roundsOf(next)).toHaveLength(next.groups.length);
      // 每组都应是完整阶段（行数与 stageCount 一致）
      for (const g of next.groups) {
        const rows = next.sets.filter((s) => s.roundIndex === g.index);
        expect(rows).toHaveLength(g.stageCount);
      }
    }
  });
});

/* ── 预审反馈 3：缺省休息必须按目标类型取实际字段 ────────────────
   复现条件：递减组 old.restSec=120（历史遗留、实际不参与计时），
   target.restAfterSec=90（真正用于「完成整轮」后的休息）。
   旧实现缺省取 old.restSec → 会把轮间休息从 90 无意改成 120。
   注意预设里两者恰好都是 180，因此必须**手工构造**这个差异才测得出来。 */
describe('预审3 · 递减组缺省休息取 restAfterSec 而不是 restSec', () => {
  /** 把腿 A 的递减组改成 restSec 与 restAfterSec 不一致 */
  function withMismatchedRest() {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const patched: Session = {
      ...session,
      exercises: session.exercises.map((e) =>
        e.id !== ex.id
          ? e
          : {
              ...e,
              // 历史遗留值：普通组字段，递减组计时不用它
              restSec: 120,
              target: { ...(e.target as DropSetTarget), restInSec: 20, restAfterSec: 90 },
            },
      ),
    };
    return { session: patched, exId: ex.id, exName: ex.name };
  }

  it('未传 restSec 时，轮间休息保持 90（不被 restSec=120 覆盖）', () => {
    const { session, exId } = withMismatchedRest();
    const r = replaceExerciseInSession(session, exId, '器械推胸', { config: { sets: 2 } });
    expect(r.replaced).toBe(true);
    const fresh = r.session.exercises.find((e) => e.name === '器械推胸')!;
    expect(fresh.target.kind).toBe('dropSet');
    if (fresh.target.kind === 'dropSet') {
      expect(fresh.target.restAfterSec).toBe(90);   // 真正用于轮间休息的字段
      expect(fresh.target.restInSec).toBe(20);      // 阶段间休息原样保留
      expect(fresh.target.stages).toHaveLength(3);  // 阶段结构/参数不变
    }
  });

  it('seed 与 replace 的缺省取法一致（同一份规则，不分叉）', () => {
    const { session, exId } = withMismatchedRest();
    const seed = replaceConfigSeedFor(session.exercises.find((e) => e.id === exId)!);
    expect(seed.restSec).toBe(90);
    const r = replaceExerciseInSession(session, exId, '器械推胸');
    const fresh = r.session.exercises.find((e) => e.name === '器械推胸')!;
    expect(fresh.restSec).toBe(seed.restSec);
    if (fresh.target.kind === 'dropSet') expect(fresh.target.restAfterSec).toBe(seed.restSec);
  });

  it('显式传 restSec 时以用户值为准（覆盖缺省）', () => {
    const { session, exId } = withMismatchedRest();
    const r = replaceExerciseInSession(session, exId, '器械推胸', { config: { restSec: 150 } });
    const fresh = r.session.exercises.find((e) => e.name === '器械推胸')!;
    expect(fresh.restSec).toBe(150);
    if (fresh.target.kind === 'dropSet') expect(fresh.target.restAfterSec).toBe(150);
  });

  it('普通组缺省仍取 ex.restSec（不因递减组修正而改变）', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩');
    const fresh = r.session.exercises.find((e) => e.name === '史密斯推肩')!;
    expect(fresh.restSec).toBe(ex.restSec);
  });
});

/* ── 预审反馈 4：轮数 × 阶段数 的 200 行联合上限 ─────────────────
   MAX_ROUNDS=20 与 MAX_STAGES_ACCEPTED=12 各自合法，但 20×12=240 行 > MAX_SET_ROWS=200，
   会生成新备份无法恢复的记录（validate.ts 以「组记录行数超过上限」整份拒绝）。 */
describe('预审4 · 轮数×阶段数联合上限（MAX_SET_ROWS）', () => {
  /** 构造一个 12 阶段（历史合法上限）的递减组动作 */
  function withTwelveStages() {
    const { session } = setupLegs();
    const ex = dropExercise(session);
    const base = ex.target as DropSetTarget;
    const stages = Array.from({ length: 12 }, (_, i) => ({
      ...base.stages[i % base.stages.length],
      label: `阶段 ${i + 1}`,
    }));
    const patched: Session = {
      ...session,
      exercises: session.exercises.map((e) =>
        e.id !== ex.id
          ? e
          : {
              ...e,
              target: { ...base, stages, rounds: 3 },
              // 组结构同步成 3 轮 × 12 阶段
              groups: [1, 2, 3].map((i) => ({ index: i, stageCount: 12 })),
              sets: [1, 2, 3].flatMap((round) =>
                Array.from({ length: 12 }, (_, si) => ({
                  id: `s-${round}-${si + 1}`,
                  roundIndex: round,
                  stageIndex: si + 1,
                  reps: null,
                  weightKg: null,
                  status: 'blank' as const,
                })),
              ),
            },
      ),
    };
    return { session: patched, exId: ex.id };
  }

  it('20 轮 × 12 阶段 = 240 行 → 明确拒绝，且 session 完全不变', () => {
    const { session, exId } = withTwelveStages();
    const before = JSON.stringify(session);
    const r = replaceExerciseInSession(session, exId, '器械推胸', { config: { sets: 20 } });
    expect(r.replaced).toBe(false);
    expect(r.message).toContain('超过单动作上限');
    expect(r.message).toContain('200');
    // 拒绝且不改数据
    expect(JSON.stringify(r.session)).toBe(before);
  });

  it('16 轮 × 12 阶段 = 192 行 → 允许（恰好在上限内）', () => {
    const { session, exId } = withTwelveStages();
    const r = replaceExerciseInSession(session, exId, '器械推胸', { config: { sets: 16 } });
    expect(r.replaced).toBe(true);
    const fresh = r.session.exercises.find((e) => e.name === '器械推胸')!;
    expect(fresh.sets).toHaveLength(192);
    expect(fresh.sets.length).toBeLessThanOrEqual(200);
  });

  it('普通组不会触发该上限（1 阶段 × 最多 30 组）', () => {
    const { session } = setup();
    const ex = straightExercise(session);
    const r = replaceExerciseInSession(session, ex.id, '史密斯推肩', { config: { sets: 30 } });
    expect(r.replaced).toBe(true);
    expect(r.session.exercises.find((e) => e.name === '史密斯推肩')!.sets).toHaveLength(30);
  });

  it('checkGroupRowBudget 直接校验边界', () => {
    expect(checkGroupRowBudget(20, new Array(20).fill(10)).ok).toBe(true);   // 200
    expect(checkGroupRowBudget(20, new Array(20).fill(11)).ok).toBe(false);  // 220
    expect(checkGroupRowBudget(1, [12]).ok).toBe(true);
  });
});
