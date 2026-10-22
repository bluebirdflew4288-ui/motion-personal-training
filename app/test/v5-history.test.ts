/* V4-04 A/B 回归：同动作多片段聚合 + 完整/部分大组不许用除法。
   两类根因（独立审查实测）：

   A（F-SPLIT-LAST）：训练中把「剩余未开始的组」转成递减组后，同一次训练里留下两个
     合法的 SessionExercise（同 exerciseId + 同计量口径）：
       · 片段 1 straight，1 组已记录，groups [{1,1},{2,1,skipped},{3,1,skipped}]
       · 片段 2 dropSet，2 轮 × 3 阶段已记录，groups [{1,3},{2,3}]
     旧实现：
       · Session.tsx lastByExercise 用 `map.has(key) continue` → 下次只说「1 组」；
       · stats.buildExerciseHistory 为这一次训练返回两条 entry；
       · listTrainedExercises 把一次训练算成 2 次。
     fixture 用**真实领域函数** convertExerciseToDropSet 构造这条路径，不是手写数据。

   B（F-PARTIAL-GROUP-DISPLAY）：腿日哑铃侧平举 3 轮 × 3 阶段，每轮只完成阶段 1。
     旧 Stats.tsx 用 `Math.floor(3 行 / 3 阶段)` = 1 个完整大组 —— 凭空造出从未存在的大组。
     旧 describeLastPerformance 又把它说成「0 个完整大组 · 0 阶段」—— 明明记了 3 个阶段。 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  collectMovementFragments,
  describeGroupCounts,
  describeLastPerformance,
  describeMovementPerformance,
  modeOf,
} from '../src/domain/comparability';
import { buildExerciseHistory, listTrainedExercises } from '../src/domain/stats';
import {
  convertExerciseToDropSet,
  createSession,
  hasReps,
  summarizeSession,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { DropSetTarget, Session, SessionExercise } from '../src/domain/types';

const NOW = 1_760_000_000_000;

const plan = () => createV32Plan(NOW);
const dayOf = (p: ReturnType<typeof plan>, name: string) => p.days.find((d) => d.name === name)!;

/** 把某动作的所有 set 行按 (roundIndex, stageIndex) 记成给定的次数/重量 */
function logSets(
  session: Session,
  exId: string,
  rows: Array<{ roundIndex: number; stageIndex: number; reps: number; weightKg: number | null }>,
): Session {
  let next = session;
  for (const row of rows) {
    const ex = next.exercises.find((e) => e.id === exId)!;
    const target = ex.sets.find((s) => s.roundIndex === row.roundIndex && s.stageIndex === row.stageIndex)!;
    next = withSet(next, exId, target.id, { reps: row.reps, weightKg: row.weightKg, status: 'done' });
  }
  return next;
}

const findEx = (session: Session, name: string): SessionExercise =>
  session.exercises.find((e) => e.name === name)!;

function finish(session: Session): Session {
  return { ...session, status: 'completed', endedAt: NOW + 3_600_000 };
}

/** 递减组目标：rounds 轮 × stages 个阶段（重量逐阶段递减） */
function dropTarget(rounds: number, stageCount: number, weightMode: 'external' | 'bodyweight_plus' = 'external'): DropSetTarget {
  return {
    kind: 'dropSet',
    rounds,
    weightMode,
    restInSec: 20,
    restAfterSec: 180,
    stages: Array.from({ length: stageCount }, (_, i) => ({
      label: `第 ${i + 1} 阶段`,
      weightKg: 30 - i * 5,
      repsMin: 8,
      repsMax: 12,
      toFailure: i === stageCount - 1,
      targetText: `${30 - i * 5} kg · 8–12 次`,
    })),
  };
}

/* ══ A：同动作中途转换后，片段必须聚合 ══════════════════════════ */

/**
 * 审查 F-SPLIT-LAST 的真实路径：
 * 1. 胸 A 开始训练，双杠臂屈伸普通组第 1 组完成（40kg × 10）；
 * 2. 把剩余两组（真正未开始的）转成 3 阶段递减组；
 * 3. 后两轮每阶段 30kg × 8；
 * 4. 结束训练。
 * 用真实 convertExerciseToDropSet 构造，不做手写拼接。
 */
function splitSession(): { session: Session; straight: SessionExercise; drop: SessionExercise } {
  const p = plan();
  let session = createSession(p, dayOf(p, '胸 A'), NOW);
  const dipId = findEx(session, '双杠臂屈伸').id;

  // ① 普通组第 1 组完成 40kg × 10（bodyweight_plus 口径，weightKg 是外加负重）
  session = logSets(session, dipId, [{ roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 40 }]);

  // ② 把剩余两组转成 3 阶段递减组（真实领域函数：会插入第二个 SessionExercise）
  const r = convertExerciseToDropSet(session, dipId, dropTarget(2, 3, 'bodyweight_plus'));
  expect(r.converted).toBe(true);
  session = r.session;

  const sameName = session.exercises.filter((e) => e.name === '双杠臂屈伸');
  // fixture 自证：同一次训练里确实有两个合法片段（同 exerciseId + 同口径）
  expect(sameName).toHaveLength(2);
  expect(sameName[0].target.kind).toBe('straight');
  expect(sameName[1].target.kind).toBe('dropSet');
  expect(sameName[0].exerciseId).toBe(sameName[1].exerciseId);
  expect(modeOf(sameName[0])).toEqual(modeOf(sameName[1]));

  // ③ 后两轮每阶段 30kg × 8
  const dropId = sameName[1].id;
  session = logSets(
    session,
    dropId,
    Array.from({ length: 2 }, (_, ri) =>
      Array.from({ length: 3 }, (_, si) => ({
        roundIndex: ri + 1,
        stageIndex: si + 1,
        reps: 8,
        weightKg: 30,
      })),
    ).flat(),
  );

  return {
    session: finish(session),
    straight: session.exercises.find((e) => e.target.kind === 'straight')!,
    drop: session.exercises.find((e) => e.target.kind === 'dropSet')!,
  };
}

describe('V4-04 A 同动作中途转换后片段聚合', () => {
  it('fixture 自证：普通 1 组已记 + 递减 2 轮 × 3 阶段已记，roundIndex 各自从 1 开始', () => {
    const { session, straight, drop } = splitSession();
    expect(straight.sets.filter((s) => s.status === 'done')).toHaveLength(1);
    expect(drop.sets.filter((s) => s.status === 'done')).toHaveLength(6);
    // 关键：两个片段的 roundIndex 都从 1 开始 → 聚合时必须保留片段独立编号
    expect(straight.sets.filter(hasReps).map((s) => s.roundIndex)).toEqual([1]);
    expect([...new Set(drop.sets.filter(hasReps).map((s) => s.roundIndex))]).toEqual([1, 2]);
    expect(session.exercises.filter((e) => e.name === '双杠臂屈伸')).toHaveLength(2);
  });

  it('collectMovementFragments 聚合成一条，fragments 保留各自 roundIndex 不合并', () => {
    const { session, straight } = splitSession();
    const perf = collectMovementFragments(session, straight.exerciseId, modeOf(straight))!;
    expect(perf).not.toBeNull();

    // 两个片段都在，且各自保留自己的组号（不跨片段合并成 [1,2,3]）
    expect(perf.fragments).toHaveLength(2);
    expect(perf.fragments.map((f) => f.kind)).toEqual(['straight', 'dropSet']);
    expect(perf.fragments[0].groups.map((g) => g.index)).toEqual([1, 2, 3]);
    expect(perf.fragments[1].groups.map((g) => g.index)).toEqual([1, 2]);
    expect(perf.fragments[1].groups.map((g) => g.stageCount)).toEqual([3, 3]);

    // 求和口径：普通 1 组 + 递减 2 完整大组；已记阶段 1 + 6 = 7
    expect(perf.completeGroups).toBe(3); // 1 普通组 + 2 递减大组
    expect(perf.loggedStages).toBe(7);
    expect(perf.loggedStraightSets).toBe(1);
    expect(perf.maxWeightKg).toBe(40);
    expect(perf.totalReps).toBe(10 + 6 * 8);
  });

  it('describeMovementPerformance 同时读出普通组数 + 递减完整大组/阶段数（旧实现只说「1 组」）', () => {
    const { session, straight } = splitSession();
    const perf = collectMovementFragments(session, straight.exerciseId, modeOf(straight))!;
    const text = describeMovementPerformance(perf);
    // 旧实现（只取第一个片段）在这里会得到「40kg · 1 组 · 10 次」
    expect(text).toContain('普通 1 组');
    expect(text).toContain('递减');
    expect(text).toContain('2 个完整大组');
    expect(text).toContain('6 阶段');
    expect(text).toContain('40kg');
    expect(text).toContain('30kg');
    expect(text).not.toBe('40kg · 1 组 · 10 次');
  });

  it('buildExerciseHistory：一次训练只产生一条 entry，sets 聚合两段共 7 行', () => {
    const { session, straight } = splitSession();
    const h = buildExerciseHistory([session], straight.exerciseId, modeOf(straight))!;
    // 旧实现这里是 2 条（片段各一条）
    expect(h.entries).toHaveLength(1);
    const e = h.entries[0];
    expect(e.fragments).toHaveLength(2);
    expect(e.sets).toHaveLength(7);
    expect(e.completeGroups).toBe(3);
    expect(e.loggedStages).toBe(7);
    expect(e.partialGroups).toBe(0);
    // 每行仍带轮/阶段归属
    expect(e.sets.every((s) => typeof s.roundIndex === 'number' && typeof s.stageIndex === 'number')).toBe(true);
    // 递减片段存在 → 按大组措辞
    expect(e.targetKind).toBe('dropSet');
  });

  it('listTrainedExercises：count 是「练过多少个训练」，不是片段数', () => {
    const { session } = splitSession();
    const list = listTrainedExercises([session]);
    const dip = list.find((x) => x.key === 'lib-chest-dip')!;
    // 旧实现这里是 2（两个片段各 +1）
    expect(dip.count).toBe(1);
  });

  it('跨两次训练时 entries 各自一条，count 为 2（不跨训练合并）', () => {
    const first = splitSession().session;
    const second = splitSession().session;
    const key = 'lib-chest-dip';
    const h = buildExerciseHistory([first, second], key, { weightMode: 'bodyweight_plus', dumbbellBasis: 'total' })!;
    expect(h.entries).toHaveLength(2);
    expect(listTrainedExercises([first, second]).find((x) => x.key === key)!.count).toBe(2);
  });

  it('跨计量口径仍分开：负重双杠 +40kg 与辅助双杠 70kg 不进同一条历史', () => {
    const p = plan();
    let a = createSession(p, dayOf(p, '胸 A'), NOW);
    const dipA = findEx(a, '双杠臂屈伸');
    a = logSets(a, dipA.id, [{ roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 40 }]);
    a = finish(a);

    let b = createSession(p, dayOf(p, '胸 A'), NOW + 10_000);
    const dipB = findEx(b, '双杠臂屈伸');
    // 辅助口径：同一个 exerciseId，但 weightMode 不同
    b = {
      ...b,
      exercises: b.exercises.map((e) =>
        e.id === dipB.id ? { ...e, target: { ...e.target, weightMode: 'assisted' as const } } : e,
      ),
    };
    b = logSets(b, dipB.id, [{ roundIndex: 1, stageIndex: 1, reps: 6, weightKg: 70 }]);
    b = finish(b);

    const h = buildExerciseHistory([a, b], 'lib-chest-dip', {
      weightMode: 'bodyweight_plus',
      dumbbellBasis: 'total',
    })!;
    expect(h.entries).toHaveLength(1);
    expect(h.maxWeightKg).toBe(40);
  });
});

/* ══ B：完整/部分大组不许用除法 ═════════════════════════════════ */

/**
 * 腿 A 的哑铃侧平举：真实预设是 3 轮 × 3 阶段。
 * 传不同的 stageCount / rounds 时，先把**结构**（target.stages + groups + 空白 sets）
 * 改成目标结构，再写入记录 —— 顺序不能反，否则不存在的阶段行无从记录。
 */
function lateralSession(loggedRounds: number[][], stageCount = 3, rounds = 3): Session {
  const p = plan();
  let session = createSession(p, dayOf(p, '腿 A'), NOW);
  const lateral = findEx(session, '哑铃侧平举');

  if (stageCount !== 3 || rounds !== 3) {
    session = {
      ...session,
      exercises: session.exercises.map((e) => {
        if (e.id !== lateral.id) return e;
        const old = e.target as DropSetTarget;
        const stages = Array.from({ length: stageCount }, (_, i) => ({
          ...old.stages[Math.min(i, old.stages.length - 1)],
          label: `第 ${i + 1} 阶段`,
          toFailure: i === stageCount - 1,
        }));
        const groups = Array.from({ length: rounds }, (_, i) => ({ index: i + 1, stageCount }));
        const sets = groups.flatMap((g) =>
          Array.from({ length: g.stageCount }, (_, si) => ({
            id: `set-lat-${g.index}-${si + 1}`,
            roundIndex: g.index,
            stageIndex: si + 1,
            reps: null,
            weightKg: null,
            status: 'blank' as const,
          })),
        );
        return { ...e, target: { ...old, rounds, stages }, groups, sets };
      }),
    };
  }

  const rows = loggedRounds.flatMap((stages, ri) =>
    stages.map((reps, si) => ({ roundIndex: ri + 1, stageIndex: si + 1, reps, weightKg: 7.5 })),
  );
  session = logSets(session, lateral.id, rows);
  return finish(session);
}

describe('V4-04 B 完整/部分大组按结构判定，不用除法', () => {
  it('3 轮各只完成阶段 1 → 完整 0、部分 3、已记 3 阶段（旧实现算出 1 个完整大组）', () => {
    const session = lateralSession([[12], [11], [10]]);
    const lateral = findEx(session, '哑铃侧平举');
    const perf = collectMovementFragments(session, 'lib-lateral-raise', modeOf(lateral))!;
    expect(perf.completeGroups).toBe(0);
    expect(perf.partialGroups).toBe(3);
    expect(perf.loggedStages).toBe(3);

    const e = buildExerciseHistory([session], 'lib-lateral-raise', modeOf(lateral))!.entries[0];
    // 旧 Stats.tsx：Math.floor(3 / 3) = 1 个完整大组
    expect(e.completeGroups).toBe(0);
    expect(e.partialGroups).toBe(3);
    expect(e.loggedStages).toBe(3);
    // 领域汇总口径一致（不修改 session.ts，只验证同一结论）
    expect(summarizeSession(session, NOW).completedSets).toBe(0);
    expect(summarizeSession(session, NOW).partialGroups).toBe(3);
  });

  it('describeLastPerformance 的「阶段数」= 已记录阶段数（旧实现说 0 阶段）', () => {
    const session = lateralSession([[12], [11], [10]]);
    const text = describeLastPerformance(findEx(session, '哑铃侧平举'));
    expect(text).toContain('0 个完整大组');
    // 旧实现：complete(0) × stageCount(3) = 0 阶段
    expect(text).toContain('3 阶段');
    expect(text).toContain('3 个部分大组');
    expect(text).not.toContain('0 阶段');
  });

  it('1 轮完整 + 2 轮各只做阶段 1 → 完整 1、部分 2、已记 5 阶段', () => {
    const session = lateralSession([
      [12, 10, 8], // 完整一轮
      [11], // 只做阶段 1
      [10], // 只做阶段 1
    ]);
    const lateral = findEx(session, '哑铃侧平举');
    const perf = collectMovementFragments(session, 'lib-lateral-raise', modeOf(lateral))!;
    expect(perf.completeGroups).toBe(1);
    expect(perf.partialGroups).toBe(2);
    expect(perf.loggedStages).toBe(5);
    // 旧除法：floor(5 / 3) = 1 个「大组」——数字碰巧对，但 2 个部分大组从未被识别
    expect(describeLastPerformance(lateral)).toContain('5 阶段');
  });

  it('不同阶段数（2 / 4 / 6）的完整/部分判定正确', () => {
    const cases: Array<{ stageCount: number; rounds: number; logged: number[][]; complete: number; partial: number; stages: number }> = [
      // 2 阶段：2 轮完整 + 1 轮只做阶段 1
      { stageCount: 2, rounds: 3, logged: [[10, 8], [10, 8], [9]], complete: 2, partial: 1, stages: 5 },
      // 4 阶段：1 轮完整 + 1 轮做 2 阶段
      { stageCount: 4, rounds: 2, logged: [[10, 9, 8, 7], [10, 9]], complete: 1, partial: 1, stages: 6 },
      // 6 阶段：只做阶段 1（每轮都缺 5 个阶段 → 全部是部分大组）
      { stageCount: 6, rounds: 2, logged: [[10], [9]], complete: 0, partial: 2, stages: 2 },
      // 6 阶段：1 轮完整
      { stageCount: 6, rounds: 1, logged: [[10, 9, 8, 7, 6, 5]], complete: 1, partial: 0, stages: 6 },
    ];
    for (const c of cases) {
      const session = lateralSession(c.logged, c.stageCount, c.rounds);
      const lateral = findEx(session, '哑铃侧平举');
      const perf = collectMovementFragments(session, 'lib-lateral-raise', modeOf(lateral))!;
      const label = `${c.stageCount} 阶段 × ${c.rounds} 轮`;
      expect(perf.completeGroups, label).toBe(c.complete);
      expect(perf.partialGroups, label).toBe(c.partial);
      expect(perf.loggedStages, label).toBe(c.stages);
      // 结构必须来自 groups 快照，而不是现存行数
      expect(perf.fragments[0].groups.every((g) => g.stageCount === c.stageCount), label).toBe(true);
    }
  });

  it('跳过的组不算完整也不算部分（与 session.ts 的 dropRoundPartial 同规则）', () => {
    const session = lateralSession([[12], [11], [10]]);
    const lateral = findEx(session, '哑铃侧平举');
    const skipped: Session = {
      ...session,
      exercises: session.exercises.map((e) =>
        e.id === lateral.id
          ? { ...e, groups: e.groups.map((g) => (g.index === 3 ? { ...g, skipped: true } : g)) }
          : e,
      ),
    };
    const perf = collectMovementFragments(skipped, 'lib-lateral-raise', modeOf(lateral))!;
    expect(perf.completeGroups).toBe(0);
    // 第 1、2 轮是部分大组；第 3 轮被跳过 → 不计入部分
    expect(perf.partialGroups).toBe(2);
    expect(perf.loggedStages).toBe(3);
  });

  it('普通 + 递减合法片段混合（A 场景）在历史与上次表现里都正确', () => {
    const { session, straight } = splitSession();
    const perf = collectMovementFragments(session, straight.exerciseId, modeOf(straight))!;
    const e = buildExerciseHistory([session], straight.exerciseId, modeOf(straight))!.entries[0];
    // 两条路径的数字必须一致
    expect(e.completeGroups).toBe(perf.completeGroups);
    expect(e.loggedStages).toBe(perf.loggedStages);
    expect(e.partialGroups).toBe(perf.partialGroups);
    expect(describeMovementPerformance(perf)).toBe(describeMovementPerformance(perf));
    // 普通片段没有「部分大组」被误报
    expect(e.partialGroups).toBe(0);
    // 递减部分 2 完整大组 / 6 阶段；普通部分 1 组
    expect(describeMovementPerformance(perf)).toContain('2 个完整大组');
    expect(describeMovementPerformance(perf)).toContain('6 阶段');
  });

  it('没有任何记录的片段不产生摘要（不显示空壳「0 组」）', () => {
    const p = plan();
    const session = createSession(p, dayOf(p, '胸 A'), NOW);
    const dip = findEx(session, '双杠臂屈伸');
    expect(collectMovementFragments(finish(session), dip.exerciseId, modeOf(dip))).toBeNull();
  });
});

/* ══ 页面文案口径（Stats.tsx 每行、Session.tsx 折叠态）══════════ */

describe('V4-04 B 页面组数文案：按轮结构，不用除法', () => {
  it('3 轮各只做阶段 1 → 显示「0 完整大组 / 3 阶段 / 3 部分大组」（旧页面显示 1 大组）', () => {
    const session = lateralSession([[12], [11], [10]]);
    const e = buildExerciseHistory([session], 'lib-lateral-raise', { weightMode: 'external', dumbbellBasis: 'per_hand' })!
      .entries[0];
    const text = describeGroupCounts(e.fragments);
    expect(text).toContain('0 完整大组');
    expect(text).toContain('3 阶段');
    expect(text).toContain('3 部分大组');
    // 旧实现 Math.floor(3 / 3) 会写出「1 大组 / 3 阶段」
    expect(text).not.toContain('1 完整大组');
  });

  it('纯普通组片段显示「N 组」而不是大组措辞', () => {
    const p = plan();
    let session = createSession(p, dayOf(p, '胸 A'), NOW);
    const dip = findEx(session, '双杠臂屈伸');
    session = logSets(session, dip.id, [
      { roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 40 },
      { roundIndex: 2, stageIndex: 1, reps: 8, weightKg: 40 },
    ]);
    const perf = collectMovementFragments(finish(session), dip.exerciseId, modeOf(dip))!;
    expect(describeGroupCounts(perf.fragments)).toBe('2 组');
  });

  it('普通 + 递减混合片段显示「普通 1 组 + 递减 2 完整大组 / 6 阶段」', () => {
    const { session, straight } = splitSession();
    const perf = collectMovementFragments(session, straight.exerciseId, modeOf(straight))!;
    const text = describeGroupCounts(perf.fragments);
    expect(text).toBe('普通 1 组 + 递减 2 完整大组 / 6 阶段');
  });
});

/* ══ 页面逐行文案：多片段时不能出现两个矛盾的 R1S1 ══════════ */

describe('V4-04 A 统计页逐行文案按片段分组', () => {
  it('多片段时按片段分别列出（各片段保留自己的 R1 起点）', async () => {
    const { setRowsText } = await import('../src/pages/Stats');
    const { session, straight } = splitSession();
    const e = buildExerciseHistory([session], straight.exerciseId, modeOf(straight))!.entries[0];
    const text = setRowsText(e);
    // 普通片段只有 1 行，递减片段 6 行，两段各自从 R1S1 开始
    expect(text).toContain('普通：');
    expect(text).toContain('递减：');
    expect(text).toContain('＋');
    // 旧实现把行拍平后会得到两个 R1S1 且无法区分
    const r1s1Count = (text.match(/R1S1/g) ?? []).length;
    expect(r1s1Count).toBe(1); // 普通片段不带 R/S 前缀，只有递减片段出现一次 R1S1
    expect(text).toContain('R2S3');
  });

  it('单片段时保持原来的单行格式（不回归既有观感）', () => {
    // 动态 import 在 node 环境可用；这里用 require 风格不可行，改为函数级复用
    return import('../src/pages/Stats').then(({ setRowsText }) => {
      const session = lateralSession([[12], [11], [10]]);
      const e = buildExerciseHistory([session], 'lib-lateral-raise', {
        weightMode: 'external',
        dumbbellBasis: 'per_hand',
      })!.entries[0];
      const text = setRowsText(e);
      expect(text).toBe('R1S1 12×7.5 · R2S1 11×7.5 · R3S1 10×7.5');
    });
  });
});

describe('V4-04 A 口径选择器的次数按训练计', () => {
  it('同一次训练里普通 + 递减两个片段只算练过 1 次', async () => {
    const { listComparabilityModes } = await import('../src/domain/comparability');
    const { session } = splitSession();
    const modes = listComparabilityModes([session], 'lib-chest-dip');
    expect(modes).toHaveLength(1);
    // 旧实现这里是 2（两个片段各 +1）
    expect(modes[0].count).toBe(1);
    expect(modes[0].weightMode).toBe('bodyweight_plus');
  });
});

describe('V4-04 A4 旧签名兼容', () => {
  it('按动作名称查询与按 exerciseId 查询命中同一批记录', () => {
    const { session } = splitSession();
    const byId = buildExerciseHistory([session], 'lib-chest-dip', {
      weightMode: 'bodyweight_plus',
      dumbbellBasis: 'total',
    })!;
    const byName = buildExerciseHistory([session], '双杠臂屈伸', {
      weightMode: 'bodyweight_plus',
      dumbbellBasis: 'total',
    })!;
    expect(byName.entries).toHaveLength(byId.entries.length);
    expect(byName.entries[0].loggedStages).toBe(byId.entries[0].loggedStages);
  });

  it('mode 可选：不传时取最近一次记录的口径，仍然一次训练一条 entry', () => {
    const { session } = splitSession();
    const h = buildExerciseHistory([session], 'lib-chest-dip')!;
    expect(h).not.toBeNull();
    expect(h.entries).toHaveLength(1);
    expect(h.weightMode).toBe('bodyweight_plus');
  });

  it('查一个从未练过的动作返回 null', () => {
    const { session } = splitSession();
    expect(buildExerciseHistory([session], 'lib-never-trained')).toBeNull();
  });
});
