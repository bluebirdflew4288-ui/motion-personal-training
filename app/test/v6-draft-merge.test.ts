/* V5-01 回归：旧草稿不能换上最新 revision 整份覆盖别人的数据。
   审查 V5D09 的实际路径：
     A 只读保留整份旧草稿（第1组15 / 第2组null / baseRev1）
     → B 保存第2组20（rev2）并释放
     → A 回前台同步 rev2 并取得锁
     → A 点重试：旧实现 persist({...pending, revision: 2}) → 第2组 20 被抹成 null
   这里穷举合并规则本身（纯函数），回调链顺序由 verify-v6 的探针与浏览器脚本覆盖。 */

import { describe, expect, it } from 'vitest';
import { mergeDraftOntoFresh, type PendingDraft } from '../src/domain/draftMerge';
import type { Session, SessionSet } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function set(over: Partial<SessionSet> & { id: string; roundIndex: number }): SessionSet {
  return {
    stageIndex: 1,
    reps: null,
    weightKg: null,
    status: 'blank',
    ...over,
  } as SessionSet;
}

/** 两个动作 × 若干组的普通组 session，便于按 set id 精确控制 */
function makeSession(rev: number, opts: { g1?: Partial<SessionSet>; g2?: Partial<SessionSet> } = {}): Session {
  const setA1 = set({ id: 'set-a1', roundIndex: 1, ...opts.g1 });
  const setA2 = set({ id: 'set-a2', roundIndex: 2, ...opts.g2 });
  const setB1 = set({ id: 'set-b1', roundIndex: 1 });
  return {
    id: 'sess-merge',
    planId: 'plan-1',
    planName: '计划',
    day: { dayId: 'd1', dayName: '胸 A', focus: 'chest', round: 'A', partText: '胸 A' },
    cycleIndexAtStart: 0,
    targetSetsAtStart: 2,
    startedAt: NOW,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: [{ id: 'w1', name: '热身', unit: 'reps', targetText: '2 × 10', done: false }],
    exercises: [
      {
        id: 'ex-a',
        exerciseId: 'lib-chest-dip',
        planExerciseId: null,
        name: '双杠臂屈伸',
        restSec: 120,
        target: {
          kind: 'straight',
          sets: 2,
          setsMax: 2,
          repsMin: 8,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: null,
        },
        status: 'pending',
        groups: [
          { index: 1, stageCount: 1 },
          { index: 2, stageCount: 1 },
        ],
        sets: [setA1, setA2],
        note: '',
      },
      {
        id: 'ex-b',
        exerciseId: 'lib-barbell-bench',
        planExerciseId: null,
        name: '自由杠铃卧推',
        restSec: 180,
        target: {
          kind: 'straight',
          sets: 1,
          setsMax: 1,
          repsMin: 8,
          repsMax: 12,
          weightMode: 'external',
          suggestedWeightKg: null,
        },
        status: 'pending',
        groups: [{ index: 1, stageCount: 1 }],
        sets: [setB1],
        note: '',
      },
    ],
    note: '',
    revision: rev,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/* 便捷读取 */
function repsOf(s: Session, exId: string, setId: string) {
  return s.exercises.find((e) => e.id === exId)?.sets.find((x) => x.id === setId)?.reps ?? null;
}

describe('V5-01 三方合并：不同组 A 未存 + B 已存 → 两者都保留', () => {
  it('审查 V5D09 原场景：A 改第1组15、B 改第2组20 → 合并后 15 与 20 同时存在', () => {
    const base = makeSession(1); // 两组都空
    const mine = clone(base); // A 的草稿：第1组 15
    mine.exercises[0].sets[0].reps = 15;
    mine.exercises[0].sets[0].status = 'done';
    const fresh = clone(base); // B 之后保存：第2组 20，revision 2
    fresh.exercises[0].sets[1].reps = 20;
    fresh.exercises[0].sets[1].status = 'done';
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 核心：B 的 20 绝不能消失
    expect(repsOf(r.session, 'ex-a', 'set-a2')).toBe(20);
    // A 的 15 也被应用
    expect(repsOf(r.session, 'ex-a', 'set-a1')).toBe(15);
    // 结果基于 fresh 的 revision，由调用方显式用于 CAS
    expect(r.session.revision).toBe(2);
    expect(r.appliedFields).toContain('ex-a.set-a1.reps');
    // 未改动的动作原样保留
    expect(repsOf(r.session, 'ex-b', 'set-b1')).toBeNull();
  });

  it('两个动作各改一组：都保留，互不影响', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    mine.exercises[1].sets[0].reps = 12;
    const fresh = clone(base);
    fresh.exercises[0].sets[1].reps = 20;
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(repsOf(r.session, 'ex-a', 'set-a1')).toBe(15);
    expect(repsOf(r.session, 'ex-a', 'set-a2')).toBe(20);
    expect(repsOf(r.session, 'ex-b', 'set-b1')).toBe(12);
  });

  it('重量与次数可以来自不同页而同时保留（不同字段）', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15; // A 只改次数
    const fresh = clone(base);
    fresh.exercises[0].sets[0].weightKg = 40; // B 只改重量
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const st = r.session.exercises[0].sets[0];
    expect(st.reps).toBe(15);
    expect(st.weightKg).toBe(40);
  });
});

describe('V5-01 同字段冲突：不静默选本页旧值', () => {
  it('同一组次数两边改成不同值 → 拒绝整次重试，库值不被覆盖', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15; // A 写 15
    const fresh = clone(base);
    fresh.exercises[0].sets[0].reps = 20; // B 写 20
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.length).toBeGreaterThan(0);
    expect(r.conflicts[0].path).toContain('次数');
    expect(r.conflicts[0].mine).toBe(15);
    expect(r.conflicts[0].theirs).toBe(20);
    // 提示必须说明草稿仍保留
    expect(r.message).toContain('草稿仍保留');
  });

  it('同一组次数改成相同值 → 不算冲突，可以继续', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    const fresh = clone(base);
    fresh.exercises[0].sets[0].reps = 15; // 正好相同
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(repsOf(r.session, 'ex-a', 'set-a1')).toBe(15);
  });

  it('本页没改的字段即使别人改了也采用库值（不误报冲突）', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15; // A 只改第1组次数
    const fresh = clone(base);
    fresh.exercises[0].sets[1].reps = 20; // B 改的是另一组的另一字段
    fresh.exercises[1].sets[0].reps = 9;
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(repsOf(r.session, 'ex-a', 'set-a1')).toBe(15);
    expect(repsOf(r.session, 'ex-a', 'set-a2')).toBe(20);
    expect(repsOf(r.session, 'ex-b', 'set-b1')).toBe(9);
  });

  it('训练备注同字段冲突也拒绝（不选本页值）', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.note = 'A 的备注';
    const fresh = clone(base);
    fresh.note = 'B 的备注';
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.some((c) => c.path.includes('备注'))).toBe(true);
  });

  it('重量与次数互为不同字段：A 改次数 15、B 改同一组次数 20 之外还改重量 → 只报次数冲突', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    const fresh = clone(base);
    fresh.exercises[0].sets[0].reps = 20;
    fresh.exercises[0].sets[0].weightKg = 40;
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].path).toContain('次数');
  });
});

describe('V5-01 结构变化：不用旧整动作替换新库', () => {
  it('本页增删过组结构 → 冲突拒绝', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].groups.push({ index: 3, stageCount: 1 });
    mine.exercises[0].sets.push(set({ id: 'set-a3', roundIndex: 3 }));
    const fresh = clone(base);
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.some((c) => c.path.includes('组结构'))).toBe(true);
  });

  it('另一页改过组结构 → 冲突拒绝', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    const fresh = clone(base);
    fresh.exercises[0].groups = [{ index: 1, stageCount: 1 }];
    fresh.exercises[0].sets = [set({ id: 'set-a1', roundIndex: 1 })];
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts.some((c) => c.path.includes('组结构'))).toBe(true);
  });

  it('动作集合被改动（增删动作）→ 冲突拒绝', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises.push({ ...clone(base.exercises[1]), id: 'ex-c', name: '新动作' });
    const fresh = clone(base);
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.conflicts[0].path).toContain('动作列表');
  });
});

describe('V5-01 无冲突：正常重试', () => {
  it('没人改过库（baseRevision === fresh revision）时调用方直接整份保存，不经合并', () => {
    // 这条断言的是「调用方的判定分支」：相等就整份保存。
    // mergeDraftOntoFresh 自身对相同 base/fresh 也应得到等价结果。
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    const fresh = clone(base); // revision 仍 1

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(repsOf(r.session, 'ex-a', 'set-a1')).toBe(15);
    expect(r.session.revision).toBe(1);
  });

  it('多组多动作混合修改全部应用', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    mine.exercises[0].sets[0].weightKg = 40;
    mine.exercises[0].sets[0].status = 'done';
    mine.exercises[1].sets[0].reps = 12;
    mine.warmups[0].done = true;
    const fresh = clone(base);
    fresh.revision = 3;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const st = r.session.exercises[0].sets[0];
    expect(st.reps).toBe(15);
    expect(st.weightKg).toBe(40);
    expect(st.status).toBe('done');
    expect(repsOf(r.session, 'ex-b', 'set-b1')).toBe(12);
    expect(r.session.warmups[0].done).toBe(true);
  });

  it('partial 状态与 note 也参与三方合并', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].status = 'partial';
    mine.exercises[0].sets[0].note = '本页备注';
    const fresh = clone(base);
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.exercises[0].sets[0].status).toBe('partial');
    expect(r.session.exercises[0].sets[0].note).toBe('本页备注');
  });

  it('终态/时间戳等会话级字段一律以 fresh 为准（草稿不能改）', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.status = 'completed';
    mine.endedAt = NOW + 5000;
    mine.startedAt = NOW - 9999;
    const fresh = clone(base);
    fresh.revision = 2;
    fresh.pausedMs = 1234;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.status).toBe(fresh.status);
    expect(r.session.endedAt).toBe(fresh.endedAt);
    expect(r.session.startedAt).toBe(fresh.startedAt);
    expect(r.session.pausedMs).toBe(1234);
  });

  it('0 与 null 被区分：0 是实际值，不会被当"没填"', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 0; // 明确做了 0 次
    const fresh = clone(base);
    fresh.revision = 2;

    const r = mergeDraftOntoFresh(base, mine, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.exercises[0].sets[0].reps).toBe(0);
    expect(r.session.exercises[0].sets[0].reps).not.toBeNull();
  });
});

describe('V5-01 PendingDraft 契约', () => {
  it('PendingDraft 必须自带 baseRevision 与 baseSession（类型层面约束基线不被替换）', () => {
    const base = makeSession(1);
    const mine = clone(base);
    mine.exercises[0].sets[0].reps = 15;
    const d: PendingDraft = { token: 1, session: mine, baseRevision: 1, baseSession: base };
    // 使用 baseSession + baseRevision 做合并，而不是用 fresh 充当 base
    const fresh = clone(base);
    fresh.exercises[0].sets[1].reps = 20;
    fresh.revision = 2;
    const r = mergeDraftOntoFresh(d.baseSession, d.session, fresh);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(repsOf(r.session, 'ex-a', 'set-a2')).toBe(20);
    expect(d.baseRevision).toBe(1); // 不被当成 fresh revision
  });
});
