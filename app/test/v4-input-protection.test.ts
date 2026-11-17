/* V3-03「保护未打勾的实际输入」+ V3-06「两个剩余操作」的纯域函数验收。
   每条用例对应审查报告里的一个已复现失败路径：
   · F-REPS-LOSS：填了次数但没打勾的组，在替换/转换时被当空白整条重建 → 数据消失
   · F-UNSKIP  ：做完 1 组再跳过剩余，groups.every(g => g.skipped) 永远 false → 取消不可达
   · R09 残留  ：手动「计时」按钮用硬编码 20 / ex.restSec，而不是本次训练快照

   约定：全部用真实域函数构造（createV32Plan → createSession → withSet …），
   不手写假 fixture，避免「测试自己编的数据结构」掩盖真实缺陷。 */

import { describe, expect, it } from 'vitest';
import { createV32Plan } from '../src/domain/presets/v32';
import { draftToDropTarget } from '../src/domain/dropSet';
import {
  createSession,
  exerciseCompletion,
  groupHasActualInput,
  groupHasNoRecords,
  hasSkippedGroupsToUnskip,
  isSetLogged,
  requiredStages,
  restAfterSet,
  roundsOf,
  setHasActualInput,
  skipRemaining,
  summarizeSession,
  unskipExercise,
  withSet,
} from '../src/domain/session';
import type {
  PlanDay,
  Session,
  SessionExercise,
  SessionSet,
} from '../src/domain/types';

const NOW = 1_760_000_000_000;

/** 胸 A：第 1 个动作是双杠臂屈伸（3 组普通组，自重 + 负重） */
function chestSession() {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.name === '胸 A')!;
  return { plan, day, session: createSession(plan, day, NOW) };
}

/** 腿 A：哑铃侧平举是 3 轮 × 3 阶段递减组（默认 restInSec 20 / restAfterSec 180） */
function legsSession() {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.name === '腿 A')!;
  return { plan, day, session: createSession(plan, day, NOW) };
}

/** 在 session 里按 sessionExercise.id 取动作 */
function exOf(session: Session, id: string): SessionExercise {
  return session.exercises.find((e) => e.id === id)!;
}



/** 只填 reps、不打勾、不填重量 —— 自重动作最常见也最容易丢的状态 */
function repsOnly(reps = 12): Partial<SessionSet> {
  return { reps, weightKg: null, status: 'blank' };
}

/* ── 1. 「有实际输入」判定 ─────────────────────────── */

describe('V3-03 有实际输入判定（与「计入完成量」严格分开）', () => {
  it('1. 普通组只填 reps=12、重量 null、status blank → 算已输入', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const next = withSet(session, ex.id, ex.sets[0].id, repsOnly(12));
    const after = exOf(next, ex.id);

    expect(after.sets[0].reps).toBe(12);
    expect(after.sets[0].weightKg).toBeNull();
    expect(after.sets[0].status).toBe('blank');
    // 关键：旧实现只看 logged/incomplete/weight，这一行被判成「完全空白」
    expect(setHasActualInput(after.sets[0])).toBe(true);
    expect(groupHasActualInput(after, 1)).toBe(true);
    expect(groupHasNoRecords(after, 1)).toBe(false);
    // 但「计入完成量」仍然必须是 false —— 两件事不能混
    expect(isSetLogged(after.sets[0])).toBe(false);
  });

  it('4. 只填重量（reps=null, weightKg=20, blank）→ 同样受保护', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const next = withSet(session, ex.id, ex.sets[0].id, { weightKg: 20 });
    const after = exOf(next, ex.id);
    expect(after.sets[0].reps).toBeNull();
    expect(setHasActualInput(after.sets[0])).toBe(true);
    expect(groupHasActualInput(after, 1)).toBe(true);
  });

  it('5. reps=0 也算实际输入（0 是「做了 0 次」，不是「没填」）', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const next = withSet(session, ex.id, ex.sets[0].id, { reps: 0, weightKg: null, status: 'blank' });
    const after = exOf(next, ex.id);
    expect(after.sets[0].reps).toBe(0);
    expect(setHasActualInput(after.sets[0])).toBe(true);
    expect(groupHasActualInput(after, 1)).toBe(true);
  });

  it('6b. 结构自带 toFailure 的空行不算「已输入」（否则递减组永远无法转换）', () => {
    const { session } = legsSession();
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const stage3 = exOf(session, lateral.id).sets.find(
      (s) => s.roundIndex === 1 && s.stageIndex === 3,
    )!;
    expect(stage3.toFailure).toBe(true);       // 空行上就有 toFailure
    expect(stage3.reps).toBeNull();
    expect(setHasActualInput(stage3)).toBe(false);
    expect(groupHasActualInput(exOf(session, lateral.id), 1)).toBe(false);
  });
});

/* ── 2. 替换动作保留未打勾的输入 ───────────────────── */

describe('V3-03 替换动作：未打勾的输入必须留在原动作上', () => {

  it('8. 未打勾的输入不计完成组、也不算跳过组', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const s = withSet(session, ex.id, ex.sets[0].id, repsOnly(12));
    const before = summarizeSession(s, NOW);
    expect(before.completedSets).toBe(0);   // 未打勾 ≠ 完成
    expect(before.skippedGroups).toBe(0);   // 有输入 ≠ 跳过
    expect(before.arrangedGroups).toBe(s.exercises.reduce((n, e) => n + roundsOf(e).length, 0));

    // 跳过剩余时，这一组也不会被标成 skipped（有输入就不跳过）
    const after = skipRemaining(s, ex.id);
    const exAfter = exOf(after, ex.id);
    expect(exAfter.groups[0].skipped).toBe(false);
    const sum = summarizeSession(after, NOW);
    expect(sum.completedSets).toBe(0);
    expect(sum.skippedGroups).toBe(exAfter.groups.length - 1);
  });

  it('8b. 被跳过的组后来填了 reps（未打勾）→ 计入 partialGroups，不算 skippedGroups', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    // 先全部跳过，再回头给第 2 组补 reps=12（UI 允许在跳过组上继续补记录）
    let s = skipRemaining(session, ex.id);
    const skippedSet = exOf(s, ex.id).sets.find((st) => st.roundIndex === 2)!;
    expect(exOf(s, ex.id).groups.find((g) => g.index === 2)!.skipped).toBe(true);
    s = withSet(s, ex.id, skippedSet.id, repsOnly(12));

    const sum = summarizeSession(s, NOW);
    expect(sum.completedSets).toBe(0);        // 未打勾 → 不是完成组
    expect(sum.skippedGroups).toBe(2);        // 第 1、3 组仍是「真跳过」
    expect(sum.partialGroups).toBe(1);        // 第 2 组有输入 → 部分完成
  });
});

/* ── 3. 转换结构保留未打勾的输入 ───────────────────── */

describe('V3-03 转换结构：未打勾的输入必须留在原动作上', () => {


  it('9b. 整场训练的 arrangedGroups 不再虚增', () => {
    const plan = createV32Plan(NOW);
    const backB = plan.days.find((d) => d.name === '背 B')!;
    const session = createSession(plan, backB, NOW);
    const expected = session.exercises.reduce(
      (n, e) => n + (e.groups.length ? e.groups.length : new Set(e.sets.map((s) => s.roundIndex)).size),
      0,
    );
    const s = summarizeSession(session, NOW);
    expect(s.arrangedGroups).toBe(expected);
    expect(s.plannedSets).toBe(expected);
    // 零组动作确实存在，且没有贡献 1 组
    const zero = session.exercises.filter((e) => e.groups.length === 0);
    expect(zero.length).toBeGreaterThan(0);
    expect(zero.every((e) => roundsOf(e).length === 0)).toBe(true);
  });
});

/* ── 5. 取消跳过可达性 ─────────────────────────────── */

describe('V3-06 取消跳过判定（F-UNSKIP）', () => {
  it('10. 做完 1 组再跳过剩余 → 有可撤销的跳过，groups 为 [false,true,true]', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    let s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, weightKg: 7.5, status: 'done' });
    expect(summarizeSession(s, NOW).completedSets).toBe(1);

    s = skipRemaining(s, ex.id);
    const after = exOf(s, ex.id);
    expect(after.groups.map((g) => Boolean(g.skipped))).toEqual([false, true, true]);
    // 关键：不能用 every(g => g.skipped) 判断可撤销（那样这里永远是 false）
    expect(after.groups.every((g) => g.skipped)).toBe(false);
    expect(hasSkippedGroupsToUnskip(after)).toBe(true);
  });

  it('11. unskipExercise 只清 skipped：已做数据与 completedSets 不变', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    let s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, weightKg: 7.5, status: 'done' });
    s = skipRemaining(s, ex.id);
    const beforeSkipSummary = summarizeSession(s, NOW);

    s = unskipExercise(s, ex.id);
    const after = exOf(s, ex.id);
    expect(after.groups.every((g) => !g.skipped)).toBe(true);
    expect(hasSkippedGroupsToUnskip(after)).toBe(false);
    // 已做数据一行不动
    expect(after.sets[0].reps).toBe(10);
    expect(after.sets[0].weightKg).toBe(7.5);
    expect(after.sets[0].status).toBe('done');
    expect(after.sets.filter(isSetLogged)).toHaveLength(1);
    // 完成量不变
    expect(summarizeSession(s, NOW).completedSets).toBe(beforeSkipSummary.completedSets);
    expect(summarizeSession(s, NOW).completedSets).toBe(1);
    // 动作级 status 按实际记录重算，不能无脑回落成 pending
    expect(after.status).toBe('done');
    expect(exerciseCompletion(after)).toBe('partial'); // 有记录但没做完全部组
  });

  it('12. 全跳过（无任何记录）→ 可撤销，且动作状态是 skipped', () => {
    const { session } = chestSession();
    const ex = session.exercises[0];
    const s = skipRemaining(session, ex.id);
    const after = exOf(s, ex.id);
    expect(after.groups.every((g) => g.skipped)).toBe(true);
    expect(hasSkippedGroupsToUnskip(after)).toBe(true);
    expect(exerciseCompletion(after)).toBe('skipped');
    // 撤销后回到 pending（没有任何实际记录）
    const back = exOf(unskipExercise(s, ex.id), ex.id);
    expect(hasSkippedGroupsToUnskip(back)).toBe(false);
    expect(back.status).toBe('pending');
    expect(exerciseCompletion(back)).toBe('pending');
  });

  it('12b. 没有任何跳过的动作 → false（菜单应显示「跳过剩余组」）', () => {
    const { session } = chestSession();
    expect(hasSkippedGroupsToUnskip(session.exercises[0])).toBe(false);
  });
});

/* ── 6. 休息快照统一来源（R09 残留）────────────────── */

describe('V3-06 restAfterSet：自动计时与手动「计时」共用快照', () => {
  it('13. 普通组取 ex.restSec（不是硬编码 20）', () => {
    const plan = createV32Plan(NOW);
    const chestA = plan.days.find((d) => d.name === '胸 A')!;
    const day: PlanDay = {
      ...chestA,
      exercises: chestA.exercises.map((e) =>
        e.name === '双杠臂屈伸' ? { ...e, restSec: 45 } : e,
      ),
    };
    const session = createSession(plan, day, NOW);
    const ex = session.exercises.find((e) => e.name === '双杠臂屈伸')!;
    expect(ex.restSec).toBe(45);
    for (const st of ex.sets) expect(restAfterSet(ex, st)).toBe(45);
    expect(restAfterSet(ex, ex.sets[0])).not.toBe(20);
  });

  it('14. 递减组 3 阶段：阶段 1/2 用 restInSec，最后阶段用 restAfterSec', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const day: PlanDay = {
      ...legsA,
      exercises: legsA.exercises.map((e) =>
        e.name === '哑铃侧平举' && e.target.kind === 'dropSet'
          ? { ...e, target: { ...e.target, restInSec: 45, restAfterSec: 240 } }
          : e,
      ),
    };
    const session = createSession(plan, day, NOW);
    const ex = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(requiredStages(ex, 1)).toBe(3);
    const round = ex.sets
      .filter((s) => s.roundIndex === 1)
      .sort((a, b) => a.stageIndex - b.stageIndex);
    expect(restAfterSet(ex, round[0])).toBe(45);   // 阶段 1 → 阶段间
    expect(restAfterSet(ex, round[1])).toBe(45);   // 阶段 2 → 阶段间
    expect(restAfterSet(ex, round[2])).toBe(240);  // 阶段 3 = 本轮最后阶段 → 轮间
    // 旧 UI 的写法在最后阶段返回的是 ex.restSec（180），这正是要修的偏差
    expect(restAfterSet(ex, round[2])).not.toBe(ex.restSec);
  });

  it('15. 递减组 4 阶段：阶段 1/2/3 用 restInSec，阶段 4 用 restAfterSec', () => {
    const target = draftToDropTarget({
      rounds: 2,
      stages: Array.from({ length: 4 }, (_, i) => ({
        weightKg: 20 - i * 5,
        repsMin: 8,
        repsMax: 12,
        toFailure: false,
      })),
      restInSec: 45,
      restAfterSec: 240,
      weightMode: 'external',
    });
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const day: PlanDay = {
      ...legsA,
      exercises: legsA.exercises.map((e) =>
        e.name === '哑铃侧平举' ? { ...e, target } : e,
      ),
    };
    const session = createSession(plan, day, NOW);
    const ex = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(requiredStages(ex, 1)).toBe(4);
    expect(ex.sets.filter((s) => s.roundIndex === 1)).toHaveLength(4);

    const round = ex.sets
      .filter((s) => s.roundIndex === 1)
      .sort((a, b) => a.stageIndex - b.stageIndex);
    expect(round.map((st) => restAfterSet(ex, st))).toEqual([45, 45, 45, 240]);
    // 第 2 轮同样是「最后阶段才用轮间休息」
    const round2 = ex.sets
      .filter((s) => s.roundIndex === 2)
      .sort((a, b) => a.stageIndex - b.stageIndex);
    expect(round2.map((st) => restAfterSet(ex, st))).toEqual([45, 45, 45, 240]);
  });

  it('16. 训练开始后改计划里的休息值，不影响本次快照', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const day: PlanDay = {
      ...legsA,
      exercises: legsA.exercises.map((e) =>
        e.name === '哑铃侧平举' && e.target.kind === 'dropSet'
          ? { ...e, target: { ...e.target, restInSec: 45, restAfterSec: 240 } }
          : e,
      ),
    };
    const session = createSession(plan, day, NOW);
    const ex = session.exercises.find((e) => e.name === '哑铃侧平举')!;

    // 训练已经开始，之后把计划里的休息改成别的值
    const mutatedDay: PlanDay = {
      ...day,
      exercises: day.exercises.map((e) =>
        e.name === '哑铃侧平举' && e.target.kind === 'dropSet'
          ? { ...e, target: { ...e.target, restInSec: 999, restAfterSec: 999 } }
          : e,
      ),
    };
    const planAfter: typeof plan = {
      ...plan,
      days: plan.days.map((d) => (d.id === day.id ? mutatedDay : d)),
    };
    const changed = planAfter.days.find((d) => d.id === day.id)!;
    expect(changed.exercises.find((e) => e.name === '哑铃侧平举')!.target.kind).toBe('dropSet');

    const round = ex.sets
      .filter((s) => s.roundIndex === 1)
      .sort((a, b) => a.stageIndex - b.stageIndex);
    expect(restAfterSet(ex, round[0])).toBe(45);
    expect(restAfterSet(ex, round[2])).toBe(240);
    expect(restAfterSet(ex, round[0])).not.toBe(999);
  });
});
