/* 手机反馈问题二、三：训练中「先配置后添加动作」与「从本次训练移除动作」。

   ── 本文件锁住的契约 ─────────────────────────────────────────
   A. 添加（问题二）
     1. 库内动作与自定义名走同一条配置路径，组数/每组目标次数/组间休息都由用户决定；
     2. 固定次数 = 上下限相等（沿用既有模型，不新增字段）；
     3. 新动作 actual 全空（reps/weightKg = null、status = 'blank'），
        目标次数**绝不**写成实际完成；
     4. 非法配置（空/半输入/越界/下限>上限/非整数）一律明确拒绝且不改 session；
     5. 动作数上限 MAX_EXERCISES 在领域边界拒绝，不静默截断；
     6. 只影响本次 session：原计划、历史、循环游标、既有动作记录不变。

   B. 移除（问题三）
     7. 未有实际输入/记录时按 ID 移除，其他动作身份、数据、相对顺序保持；
     8. 已有实际输入（含 0 次/0 重量/partial/备注/动作级 done/未提交 raw）必须保护；
     9. 纯跳过状态不算实际成果，可以移除，但既有语义不变；
    10. 同名不同 ID 只移除目标那一条，不按名称匹配；
    11. 最后一个动作也能移除（空态合法，可重新添加，备份/导出仍合法）；
    12. 找不到 ID / 重复移除 → 不改数据（旧回调与重试安全）。

   C. 提交语义（与替换同一套口径，纯函数）
    13. 提交身份 = sessionId + commitId；旧回调不得影响新配置；
    14. 已执行过领域操作后重试只重试保存，绝不再次追加/再次移除；
    15. 只有真实 saved 才关窗；失败/未尝试一律保留配置并报失败。

   证据边界：本文件是领域与提交语义的单元测试，不覆盖真机 UI。
   真实浏览器自查见 verify-feedback/phone-add-remove-20261027/。 */

import { describe, expect, it } from 'vitest';
import {
  addConfiguredLooseExercise,
  addLooseExercise,
  checkLooseExerciseConfig,
  createSession,
  exerciseCompletion,
  exerciseRemovalProtection,
  isSetLogged,
  removeExerciseFromSession,
  roundsOf,
  setHasActualInput,
  skipRemaining,
  summarizeSession,
  withExercise,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { MAX_EXERCISES, MAX_REPS, MAX_REST, MAX_STRAIGHT_SETS } from '../src/domain/limits';
import { validateDataDeep } from '../src/db/validate';
import {
  ADD_EXERCISE_DEFAULTS,
  canCloseCommitSheet,
  canConfirmCommit,
  commitPhaseAfterOutcome,
  decideCommitRetry,
  isStaleCommit,
  newCommitId,
  ownsCommit,
} from '../src/lib/exerciseCommit';
import type { Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function chestSession() {
  const plan = createV32Plan(NOW);
  const day = plan.days.find((d) => d.name === '胸 A')!;
  return { plan, day, session: createSession(plan, day, NOW) };
}

/** 库内两个真实动作名（施工单点名） */
const LIB_BENCH = '杠铃卧推';
const LIB_WRIST = '反手抬腕';

describe('问题二 A · 按配置添加：组数/次数/休息由用户决定', () => {
  it('库内动作「杠铃卧推」按确认的 5 组 × 6 次 × 休息 90 秒添加', () => {
    const { session } = chestSession();
    const r = addConfiguredLooseExercise(session, {
      name: LIB_BENCH,
      sets: 5,
      repsMin: 6,
      repsMax: 6,
      restSec: 90,
    });
    expect(r.added).toBe(true);
    const added = r.session.exercises[r.session.exercises.length - 1];
    expect(added.name).toBe(LIB_BENCH);
    expect(added.added).toBe(true);
    expect(added.groups).toHaveLength(5);
    expect(added.sets).toHaveLength(5);
    expect(added.restSec).toBe(90);
    expect(added.target.kind).toBe('straight');
    if (added.target.kind === 'straight') {
      expect(added.target.sets).toBe(5);
      expect(added.target.setsMax).toBe(5);
      // 固定次数用上下限相等表示（不新增字段）
      expect(added.target.repsMin).toBe(6);
      expect(added.target.repsMax).toBe(6);
    }
    expect(r.message).toContain(LIB_BENCH);
  });

  it('自定义名「反手抬腕」走同一条路径，次数区间 10–15 保留为区间', () => {
    const { session } = chestSession();
    const r = addConfiguredLooseExercise(session, {
      name: LIB_WRIST,
      sets: 2,
      repsMin: 10,
      repsMax: 15,
      restSec: 60,
    });
    expect(r.added).toBe(true);
    const added = r.session.exercises[r.session.exercises.length - 1];
    expect(added.name).toBe(LIB_WRIST);
    if (added.target.kind === 'straight') {
      expect(added.target.repsMin).toBe(10);
      expect(added.target.repsMax).toBe(15);
    }
    expect(added.groups).toHaveLength(2);
  });

  it('新动作 actual 全空：目标次数不会被写成实际完成', () => {
    const { session } = chestSession();
    const r = addConfiguredLooseExercise(session, {
      name: LIB_BENCH,
      sets: 4,
      repsMin: 8,
      repsMax: 12,
      restSec: 120,
    });
    const added = r.session.exercises[r.session.exercises.length - 1];
    expect(added.sets.every((s) => s.reps === null)).toBe(true);
    expect(added.sets.every((s) => s.weightKg === null)).toBe(true);
    expect(added.sets.every((s) => s.status === 'blank')).toBe(true);
    expect(added.sets.filter(isSetLogged)).toHaveLength(0);
    expect(exerciseCompletion(added)).toBe('pending');
    // 统计：完成量为 0（目标不是完成量）
    expect(summarizeSession(r.session, NOW).completedSets).toBe(
      summarizeSession(session, NOW).completedSets,
    );
  });

  it('休息 0 秒是合法值（不休息），不会被当成「没填」', () => {
    const { session } = chestSession();
    const r = addConfiguredLooseExercise(session, {
      name: '自定义休息零',
      sets: 1,
      repsMin: 0,
      repsMax: 0,
      restSec: 0,
    });
    expect(r.added).toBe(true);
    const added = r.session.exercises[r.session.exercises.length - 1];
    expect(added.restSec).toBe(0);
    if (added.target.kind === 'straight') {
      expect(added.target.repsMin).toBe(0);
      expect(added.target.repsMax).toBe(0);
    }
  });

  it('默认预填值与旧行为一致（3 组 / 8–12 次 / 120 秒），但可被用户覆盖', () => {
    expect(ADD_EXERCISE_DEFAULTS.sets).toBe(3);
    expect(ADD_EXERCISE_DEFAULTS.repsMin).toBe(8);
    expect(ADD_EXERCISE_DEFAULTS.repsMax).toBe(12);
    expect(ADD_EXERCISE_DEFAULTS.restSec).toBe(120);

    const { session } = chestSession();
    const r = addConfiguredLooseExercise(session, { ...ADD_EXERCISE_DEFAULTS, name: '默认值动作' });
    const added = r.session.exercises[r.session.exercises.length - 1];
    expect(added.groups).toHaveLength(3);
    expect(added.restSec).toBe(120);
  });
});

describe('问题二 A · 非法配置一律拒绝，且不产生任何改动', () => {
  const cases: Array<[string, Parameters<typeof checkLooseExerciseConfig>[0]]> = [
    ['空名', { name: '   ', sets: 3, repsMin: 8, repsMax: 12, restSec: 120 }],
    ['组数 0', { name: 'x', sets: 0, repsMin: 8, repsMax: 12, restSec: 120 }],
    ['组数超上限', { name: 'x', sets: MAX_STRAIGHT_SETS + 1, repsMin: 8, repsMax: 12, restSec: 120 }],
    ['组数小数', { name: 'x', sets: 2.5, repsMin: 8, repsMax: 12, restSec: 120 }],
    ['次数超上限', { name: 'x', sets: 3, repsMin: 8, repsMax: MAX_REPS + 1, restSec: 120 }],
    ['次数负数', { name: 'x', sets: 3, repsMin: -1, repsMax: 12, restSec: 120 }],
    ['下限>上限', { name: 'x', sets: 3, repsMin: 15, repsMax: 12, restSec: 120 }],
    ['休息超上限', { name: 'x', sets: 3, repsMin: 8, repsMax: 12, restSec: MAX_REST + 1 }],
    ['休息负数', { name: 'x', sets: 3, repsMin: 8, repsMax: 12, restSec: -1 }],
    ['休息小数', { name: 'x', sets: 3, repsMin: 8, repsMax: 12, restSec: 12.5 }],
    ['NaN 组数', { name: 'x', sets: Number.NaN, repsMin: 8, repsMax: 12, restSec: 120 }],
  ];

  for (const [label, cfg] of cases) {
    it(`${label} → 明确拒绝且 session 完全不变`, () => {
      const { session } = chestSession();
      const before = JSON.stringify(session);
      const checked = checkLooseExerciseConfig(cfg);
      expect(checked.ok).toBe(false);
      const r = addConfiguredLooseExercise(session, cfg);
      expect(r.added).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.session)).toBe(before);
    });
  }

  it('名字两端空白被裁剪后再校验（不会把 "  " 当合法名）', () => {
    const r = checkLooseExerciseConfig({ name: '  杠铃卧推  ', sets: 3, repsMin: 8, repsMax: 12, restSec: 120 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.name).toBe(LIB_BENCH);
  });

  it('边界值本身合法（1 组 / 0 次 / 0 秒 / 上限值）', () => {
    expect(checkLooseExerciseConfig({ name: 'x', sets: 1, repsMin: 0, repsMax: 0, restSec: 0 }).ok).toBe(true);
    expect(
      checkLooseExerciseConfig({
        name: 'x',
        sets: MAX_STRAIGHT_SETS,
        repsMin: MAX_REPS,
        repsMax: MAX_REPS,
        restSec: MAX_REST,
      }).ok,
    ).toBe(true);
  });
});

describe('问题二 A · 动作数上限：领域边界拒绝而非静默截断', () => {
  it(`已有 ${MAX_EXERCISES} 个动作时拒绝添加，且 session 不变`, () => {
    const { session } = chestSession();
    // 用真实领域函数把动作数填到上限（不走 UI）
    let full: Session = session;
    while (full.exercises.length < MAX_EXERCISES) {
      const r = addConfiguredLooseExercise(full, {
        name: `填充动作 ${full.exercises.length}`,
        sets: 1,
        repsMin: 1,
        repsMax: 1,
        restSec: 0,
      });
      expect(r.added).toBe(true);
      full = r.session;
    }
    expect(full.exercises).toHaveLength(MAX_EXERCISES);

    const before = JSON.stringify(full);
    const r = addConfiguredLooseExercise(full, { ...ADD_EXERCISE_DEFAULTS, name: '超限动作' });
    expect(r.added).toBe(false);
    expect(r.message).toContain(String(MAX_EXERCISES));
    expect(JSON.stringify(r.session)).toBe(before);
  });

  it('上限内的动作数可通过备份校验（应用能生成的都能恢复）', () => {
    const { plan, session } = chestSession();
    let full: Session = session;
    while (full.exercises.length < MAX_EXERCISES) {
      full = addConfiguredLooseExercise(full, {
        name: `填充动作 ${full.exercises.length}`,
        sets: 2,
        repsMin: 5,
        repsMax: 8,
        restSec: 60,
      }).session;
    }
    const data = {
      plans: [plan],
      sessions: [{ ...full, revision: 0 }],
      settings: [],
    };
    const v = validateDataDeep(data);
    expect(v.ok).toBe(true);
  });

  it('旧签名 addLooseExercise 同样受上限约束（不会偷偷超过 60）', () => {
    const { session } = chestSession();
    let full: Session = session;
    while (full.exercises.length < MAX_EXERCISES) {
      full = addLooseExercise(full, `旧签名 ${full.exercises.length}`);
    }
    expect(full.exercises).toHaveLength(MAX_EXERCISES);
    const before = full.exercises.length;
    const after = addLooseExercise(full, '再一个');
    expect(after.exercises).toHaveLength(before);
  });
});

describe('问题二 A · 只影响本次 session：计划/历史/游标不变', () => {
  it('添加不改原计划、不改游标、不改既有动作记录', () => {
    const { plan, session } = chestSession();
    // 先给第一个动作填一条实际记录，确认它不受影响
    const first = session.exercises[0];
    const withData = withSet(session, first.id, first.sets[0].id, { reps: 9, weightKg: 60, status: 'done' });

    const planBefore = JSON.stringify(plan);
    const r = addConfiguredLooseExercise(withData, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH });

    // 计划未变（添加函数不接收 plan，这里核验调用前后 plan 对象内容一致）
    expect(JSON.stringify(plan)).toBe(planBefore);
    // 游标快照未变
    expect(r.session.cycleIndexAtStart).toBe(withData.cycleIndexAtStart);
    expect(r.session.day.dayId).toBe(withData.day.dayId);
    // 既有动作记录未变
    const keptFirst = r.session.exercises[0];
    expect(keptFirst.id).toBe(first.id);
    expect(keptFirst.sets.filter(isSetLogged)).toHaveLength(1);
    // 顺序：新动作追加在末尾
    expect(r.session.exercises[r.session.exercises.length - 1].name).toBe(LIB_BENCH);
  });

  it('两次独立添加产生两个不同的动作身份（不合并、不覆盖）', () => {
    const { session } = chestSession();
    const a = addConfiguredLooseExercise(session, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH }).session;
    const b = addConfiguredLooseExercise(a, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH }).session;
    const ids = b.exercises.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 同名两条都在（按 ID 区分，不按名称合并）
    expect(b.exercises.filter((e) => e.name === LIB_BENCH)).toHaveLength(2);
  });
});

describe('问题三 B · 移除：无记录时按 ID 移除，其余保持', () => {
  it('移除中间一项：其他动作身份、数据、相对顺序不变', () => {
    const { session } = chestSession();
    expect(session.exercises.length).toBeGreaterThanOrEqual(3);
    const idsBefore = session.exercises.map((e) => e.id);
    const targetId = idsBefore[1];

    const r = removeExerciseFromSession(session, targetId);
    expect(r.removed).toBe(true);
    expect(r.name).toBe(session.exercises[1].name);
    expect(r.session.exercises.map((e) => e.id)).toEqual(idsBefore.filter((id) => id !== targetId));
    // 剩余动作的组/记录完全没被改动
    for (const ex of r.session.exercises) {
      const before = session.exercises.find((e) => e.id === ex.id)!;
      expect(JSON.stringify(ex)).toBe(JSON.stringify(before));
    }
  });

  it('临时添加的动作（added=true）与原计划快照中的动作都能移除', () => {
    const { session } = chestSession();
    const added = addConfiguredLooseExercise(session, { ...ADD_EXERCISE_DEFAULTS, name: LIB_WRIST }).session;
    const adhocId = added.exercises[added.exercises.length - 1].id;
    const plannedId = added.exercises[0].id;

    const afterAdhoc = removeExerciseFromSession(added, adhocId);
    expect(afterAdhoc.removed).toBe(true);
    expect(afterAdhoc.session.exercises.some((e) => e.id === adhocId)).toBe(false);

    const afterPlanned = removeExerciseFromSession(afterAdhoc.session, plannedId);
    expect(afterPlanned.removed).toBe(true);
    expect(afterPlanned.session.exercises.some((e) => e.id === plannedId)).toBe(false);
  });

  it('同名不同 ID：只移除目标那一条，不按名称误删', () => {
    const { session } = chestSession();
    // 两条同名动作（真实路径：同一动作被临时添加两次）
    let s = addConfiguredLooseExercise(session, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH }).session;
    s = addConfiguredLooseExercise(s, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH }).session;
    const same = s.exercises.filter((e) => e.name === LIB_BENCH);
    expect(same).toHaveLength(2);
    const [firstId, secondId] = [same[0].id, same[1].id];

    const r = removeExerciseFromSession(s, secondId);
    expect(r.removed).toBe(true);
    expect(r.session.exercises.filter((e) => e.name === LIB_BENCH)).toHaveLength(1);
    expect(r.session.exercises.find((e) => e.name === LIB_BENCH)!.id).toBe(firstId);
  });

  it('最后一个动作也能移除：空态合法，可重新添加，导出/恢复仍合法', () => {
    const { plan, session } = chestSession();
    let s: Session = session;
    for (const ex of session.exercises) {
      const r = removeExerciseFromSession(s, ex.id);
      expect(r.removed).toBe(true);
      s = r.session;
    }
    expect(s.exercises).toHaveLength(0);
    // 空态统计不报错
    const summary = summarizeSession(s, NOW);
    expect(summary.completedSets).toBe(0);
    expect(summary.arrangedGroups).toBe(0);

    // 空态可重新添加
    const readded = addConfiguredLooseExercise(s, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH });
    expect(readded.added).toBe(true);
    expect(readded.session.exercises).toHaveLength(1);

    // 空态与重新添加后都能通过备份校验
    expect(validateDataDeep({ plans: [plan], sessions: [{ ...s, revision: 0 }], settings: [] }).ok).toBe(true);
    expect(
      validateDataDeep({ plans: [plan], sessions: [{ ...readded.session, revision: 0 }], settings: [] }).ok,
    ).toBe(true);
  });

  it('找不到 ID 或重复移除 → 不改数据（旧回调/重试安全）', () => {
    const { session } = chestSession();
    const before = JSON.stringify(session);
    const missing = removeExerciseFromSession(session, 'sex-does-not-exist');
    expect(missing.removed).toBe(false);
    expect(JSON.stringify(missing.session)).toBe(before);

    const id = session.exercises[0].id;
    const once = removeExerciseFromSession(session, id);
    expect(once.removed).toBe(true);
    const twice = removeExerciseFromSession(once.session, id);
    expect(twice.removed).toBe(false);
    expect(JSON.stringify(twice.session)).toBe(JSON.stringify(once.session));
  });
});

describe('问题三 B · 有实际输入/记录必须保护', () => {
  function firstStraight(session: Session) {
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    return ex;
  }

  it('完全空白 → 不保护（可移除）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const check = exerciseRemovalProtection(ex);
    expect(check.protected).toBe(false);
    expect(check.reasons).toHaveLength(0);
  });

  it('次数 0 也算实际输入（不能当「还没做」删掉）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 0 });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('重量 0 也算实际输入', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { weightKg: 0 });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('partial（已做但缺数据）受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { weightKg: 42.5, status: 'partial' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('组备注受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { note: '肩有点紧' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('动作备注受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withExercise(session, ex.id, { note: '器械调到 3 档' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
    expect(check.reasons.some((r) => r.includes('备注'))).toBe(true);
  });

  it('动作级标记完成受保护', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withExercise(session, ex.id, { status: 'done' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === ex.id)!);
    expect(check.protected).toBe(true);
  });

  it('未提交 raw 草稿受保护（由 UI 传入）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const check = exerciseRemovalProtection(ex, { hasRawDraft: true });
    expect(check.protected).toBe(true);
    expect(check.reasons.some((r) => r.includes('草稿'))).toBe(true);
  });

  it('递减组：某一阶段有记录也受保护（不是只看完成轮数）', () => {
    const plan = createV32Plan(NOW);
    const day = plan.days.find((d) => d.name === '腿 A')!;
    const session = createSession(plan, day, NOW);
    const drop = session.exercises.find((e) => e.target.kind === 'dropSet')!;
    // 只填第 1 轮第 1 阶段
    const stage1 = drop.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    const s = withSet(session, drop.id, stage1.id, { reps: 12, weightKg: 7.5, status: 'done' });
    const check = exerciseRemovalProtection(s.exercises.find((e) => e.id === drop.id)!);
    expect(check.protected).toBe(true);
  });

  it('受保护时移除函数仍只按 ID 生效，但 UI 会先拒绝（这里核验判据与数据一致）', () => {
    const { session } = chestSession();
    const ex = firstStraight(session);
    const s = withSet(session, ex.id, ex.sets[0].id, { reps: 10, status: 'done' });
    const cur = s.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseRemovalProtection(cur).protected).toBe(true);
    // 记录确实存在（保护不是空判据）
    expect(cur.sets.some(setHasActualInput)).toBe(true);
  });
});

describe('问题三 B · 纯跳过不算实际成果，但语义不变', () => {
  it('跳过剩余组后：无实际输入 → 可移除；有记录的组仍计入实际量', () => {
    const { session } = chestSession();
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    const skipped = skipRemaining(session, ex.id);
    const skippedEx = skipped.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseCompletion(skippedEx)).toBe('skipped');
    // 纯跳过（无任何实际输入）→ 不保护
    expect(exerciseRemovalProtection(skippedEx).protected).toBe(false);

    // 先做 1 组再跳过剩余：已有实际输入 → 受保护
    const first = ex.sets[0];
    const withOne = withSet(session, ex.id, first.id, { reps: 10, status: 'done' });
    const mixed = skipRemaining(withOne, ex.id);
    const mixedEx = mixed.exercises.find((e) => e.id === ex.id)!;
    expect(exerciseRemovalProtection(mixedEx).protected).toBe(true);
    // 既有语义不变：已记录的组仍计入完成量
    expect(summarizeSession(mixed, NOW).completedSets).toBeGreaterThanOrEqual(1);
  });

  it('移除一个纯跳过动作后，其余动作与统计口径不受影响', () => {
    const { session } = chestSession();
    const ex = session.exercises.find((e) => e.target.kind === 'straight')!;
    const skipped = skipRemaining(session, ex.id);
    const before = summarizeSession(skipped, NOW);
    const r = removeExerciseFromSession(skipped, ex.id);
    const after = summarizeSession(r.session, NOW);
    expect(after.completedSets).toBe(before.completedSets);
    expect(after.exercisesSkipped).toBe(before.exercisesSkipped - 1);
    expect(roundsOf(r.session.exercises[0]).length).toBe(roundsOf(session.exercises[0]).length);
  });
});

describe('提交语义 C · 身份、幂等与结果映射（纯函数）', () => {
  it('commitId + sessionId 双重归属：旧回调不得影响新配置', () => {
    const current = { sessionId: 'sess-A', commitId: 'add-1' };
    expect(ownsCommit('sess-A', 'add-1', current)).toBe(true);
    // 同一 session 但旧 commitId
    expect(ownsCommit('sess-A', 'add-0', current)).toBe(false);
    // 同一 commitId 但另一训练（跨训练旧回调）
    expect(ownsCommit('sess-B', 'add-1', current)).toBe(false);
    expect(ownsCommit('sess-A', 'add-1', null)).toBe(false);
    expect(isStaleCommit('sess-A', 'add-0', current)).toBe(true);
  });

  it('提交中禁止再次确认，也禁止用户关闭', () => {
    expect(canConfirmCommit({ phase: 'editing' })).toBe(true);
    expect(canConfirmCommit({ phase: 'submitting' })).toBe(false);
    expect(canConfirmCommit(null)).toBe(false);
    expect(canCloseCommitSheet({ phase: 'submitting' }, 'user')).toBe(false);
    // 结果已确定（settled）时允许收窗
    expect(canCloseCommitSheet({ phase: 'submitting' }, 'settled')).toBe(true);
    expect(canCloseCommitSheet({ phase: 'editing' }, 'user')).toBe(true);
  });

  it('已执行过领域操作后重试只重试保存（绝不重复追加）', () => {
    expect(decideCommitRetry({ phase: 'submitting', submitted: true }, '添加').action).toBe('reject-busy');
    expect(decideCommitRetry({ phase: 'editing', submitted: false }, '添加').action).toBe('submit');
    expect(decideCommitRetry({ phase: 'failed', submitted: true }, '添加').action).toBe('retry-save-only');
    expect(decideCommitRetry({ phase: 'failed', submitted: true }, '移除').action).toBe('retry-save-only');
    expect(decideCommitRetry({ phase: 'failed', submitted: false }, '添加').action).toBe('submit');
    expect(decideCommitRetry(null, '添加').action).toBe('reject-busy');
  });

  it('只有真实 saved 才关窗；failed / not-attempted 保留配置且标记已写入', () => {
    const base = { phase: 'submitting' as const, submitted: false };

    const saved = commitPhaseAfterOutcome(base, { kind: 'saved' }, '添加');
    expect(saved.close).toBe(true);
    expect(saved.next).toBeNull();
    expect(saved.error).toBeNull();

    const failed = commitPhaseAfterOutcome(base, { kind: 'failed', message: '本地写入失败' }, '添加');
    expect(failed.close).toBe(false);
    expect(failed.submitted).toBe(true);
    expect(failed.next).toEqual({ phase: 'failed', submitted: true });
    expect(failed.error).toContain('本地写入失败');

    const notAttempted = commitPhaseAfterOutcome(base, { kind: 'not-attempted' }, '添加');
    expect(notAttempted.close).toBe(false);
    expect(notAttempted.submitted).toBe(true);

    const rejected = commitPhaseAfterOutcome(base, { kind: 'domain-rejected', message: '达到上限' }, '添加');
    expect(rejected.close).toBe(false);
    // 领域拒绝 = 没有写入，回到可编辑态
    expect(rejected.submitted).toBe(false);
    expect(rejected.next).toEqual({ phase: 'editing', submitted: false });
    expect(rejected.error).toBe('达到上限');
  });

  it('失败后重试链：submitted=true 的重试不会再次产生领域操作（同一意图只追加一次）', () => {
    /**
     * 模拟 UI 的真实决策序列：
     *   确认（editing,submitted=false）→ 领域执行一次 → 保存失败
     *   → failed,submitted=true → 用户再点确认 → 必须只重试保存
     * 断言：整个序列里领域「添加」只被调用 1 次。
     */
    const { session } = chestSession();
    let domainCalls = 0;
    let s = session;
    const addOnce = () => {
      domainCalls += 1;
      s = addConfiguredLooseExercise(s, { ...ADD_EXERCISE_DEFAULTS, name: LIB_BENCH }).session;
    };

    let state: { phase: 'editing' | 'submitting' | 'failed'; submitted: boolean } = {
      phase: 'editing',
      submitted: false,
    };

    // 第一次确认
    expect(decideCommitRetry(state, '添加').action).toBe('submit');
    addOnce();
    state = { phase: 'submitting', submitted: true };
    const afterFail = commitPhaseAfterOutcome(state, { kind: 'failed', message: '本地写入失败' }, '添加');
    state = afterFail.next!;
    expect(state).toEqual({ phase: 'failed', submitted: true });

    // 用户连点两次重试，两次都失败（最坏情况）
    for (let i = 0; i < 2; i += 1) {
      const decision = decideCommitRetry(state, '添加');
      expect(decision.action).toBe('retry-save-only');
      // 只重试保存：绝不再次调用领域添加
      if (decision.action === 'submit') addOnce();
      state = { phase: 'submitting', submitted: true };
      const again = commitPhaseAfterOutcome(state, { kind: 'failed', message: '本地写入失败' }, '添加');
      expect(again.close).toBe(false);
      state = again.next!;
    }
    // 第三次终于保存成功
    expect(decideCommitRetry(state, '添加').action).toBe('retry-save-only');
    const finalEffect = commitPhaseAfterOutcome(
      { phase: 'submitting', submitted: true },
      { kind: 'saved' },
      '添加',
    );
    expect(finalEffect.close).toBe(true);
    expect(finalEffect.next).toBeNull();

    // 整个序列里领域「添加」只执行过 1 次 → 只可能有一个新动作
    expect(domainCalls).toBe(1);
    expect(s.exercises.filter((e) => e.name === LIB_BENCH)).toHaveLength(1);
  });

  it('newCommitId 生成互不相同的稳定 ID，前缀可区分添加/移除', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newCommitId('add')));
    expect(ids.size).toBe(50);
    expect(newCommitId('add').startsWith('add-')).toBe(true);
    expect(newCommitId('remove').startsWith('remove-')).toBe(true);
  });
});
