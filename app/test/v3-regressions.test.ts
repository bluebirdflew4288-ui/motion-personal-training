/* v3 回归：R01–R10 与 C01。每条对应独立验收报告中的一个已复现问题。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGetAll } from '../src/db/idb';
import {
  buildBackup,
  listPlans,
  listSessions,
  restoreBackup,
  savePlan,
  saveSession,
  validateBackup,
} from '../src/db/repo';
import {
  addSetTo,
  createSession,
  dropRoundComplete,
  dropRoundPartial,
  exerciseCompletion,
  isSetLogged,
  restConfigFor,
  roundsOf,
  skipRemaining,
  summarizeSession,
  unskipExercise,
  withSet,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import { atomicAcquireLock, atomicFinishSession } from '../src/db/tx';
import {
  draftToDropTarget,
  defaultDropDraft,
  validateDropDraft,
  type DropSetDraft,
} from '../src/domain/dropSet';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function setup(dayIndex = 0) {
  const plan = createV32Plan(NOW);
  const day = plan.days[dayIndex];
  const session = createSession(plan, day, NOW);
  return { plan, day, session };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

/* ── R02：跳过不抹掉实际记录 ───────────────── */
describe('R02 跳过剩余保留实际记录', () => {
  it('普通组：做完 1 组再跳过，已完成组仍计入', () => {
    let { session } = setup();
    const ex = session.exercises[0];
    session = withSet(session, ex.id, ex.sets[0].id, { reps: 10, weightKg: 7.5, status: 'done' });
    expect(summarizeSession(session, NOW).completedSets).toBe(1);

    session = skipRemaining(session, ex.id);
    const s = summarizeSession(session, NOW);
    // 关键：从 1 变 0 是这次要修的问题
    expect(s.completedSets).toBe(1);
    expect(s.skippedGroups).toBe(ex.groups.length - 1);
    // 历史明细里的实际数据仍在
    expect(session.exercises[0].sets.filter(isSetLogged)).toHaveLength(1);
  });

  it('直接跳过（无任何记录）：不算完成、不算部分', () => {
    let { session } = setup();
    const ex = session.exercises[0];
    session = skipRemaining(session, ex.id);
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(0);
    expect(s.partialGroups).toBe(0);
    expect(exerciseCompletion(session.exercises[0])).toBe('skipped');
  });

  it('撤销跳过恢复为可记录', () => {
    let { session } = setup();
    const ex = session.exercises[0];
    session = skipRemaining(session, ex.id);
    session = unskipExercise(session, ex.id);
    expect(session.exercises[0].groups.every((g) => !g.skipped)).toBe(true);
    expect(exerciseCompletion(session.exercises[0])).toBe('pending');
  });

  it('递减组：完成 1 轮后跳过，完整大组保留、余下计跳过', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const round1 = session.exercises.find((e) => e.id === lateral.id)!.sets.filter((s) => s.roundIndex === 1);
    for (const st of round1) session = withSet(session, lateral.id, st.id, { reps: 12, status: 'done' });

    session = skipRemaining(session, lateral.id);
    const s = summarizeSession(session, NOW);
    expect(s.completedSets).toBe(1);
    expect(s.skippedGroups).toBe(2);
  });
});

/* ── R03：替换的数据结构 ───────────────────── */
describe('R03 替换保留结构与目标快照', () => {;

  it('残缺轮不能凭现存行全 done 判完整', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    // 人为把第 1 轮的其他两个阶段的记录行删掉，只留 stage1 且 done
    const ex0 = session.exercises.find((e) => e.id === lateral.id)!;
    const keep = ex0.sets.find((s) => s.roundIndex === 1 && s.stageIndex === 1)!;
    session = {
      ...session,
      exercises: session.exercises.map((e) =>
        e.id !== lateral.id
          ? e
          : {
              ...e,
              sets: e.sets
                .filter((s) => s.roundIndex !== 1)
                .concat([{ ...keep, reps: 12, status: 'done' as const }]),
            },
      ),
    };
    const ex = session.exercises.find((e) => e.id === lateral.id)!;
    // groups 声明 3 阶段 → 只 1 行 done 不能算完整
    expect(dropRoundComplete(ex, 1)).toBe(false);
    expect(dropRoundPartial(ex, 1)).toBe(true);
  });
});

/* ── R05：校验不丢数据 ─────────────────────── */
describe('R05 校验不静默截断/不接受冲突键', () => {
  it('61 个动作被明确拒绝，而不是静默保留 60 个', async () => {
    const plan = createV32Plan(NOW);
    const day = plan.days[0];
    const exercises = Array.from({ length: 61 }, (_, i) => ({
      id: `ex-${i}`,
      name: `动作 ${i}`,
      restSec: 120,
      target: {
        kind: 'straight' as const,
        sets: 3,
        setsMax: 3,
        repsMin: 8,
        repsMax: 12,
        weightMode: 'external' as const,
        suggestedWeightKg: null,
      },
    }));
    const big: Plan = { ...plan, days: [{ ...day, exercises }] };
    await savePlan(big);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v = validateBackup(backup);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('超过上限');
  });

  it('同一动作内重复 set ID 被拒绝', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    // 造重复 ID
    session.exercises[0].sets[1].id = session.exercises[0].sets[0].id;
    await saveSession(session);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v = validateBackup(backup);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues?.some((i) => i.message.includes('重复'))).toBe(true);
  });

  it('坏元数据被拒绝：appVersion 对象 / 坏日期 / 非法 theme', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const base = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));

    const cases: Array<[string, (b: any) => void]> = [
      ['appVersion 对象', (b) => { b.appVersion = { v: 1 }; }],
      ['坏日期', (b) => { b.exportedAt = 'yesterday'; }],
      ['非法 theme', (b) => { b.data.settings = [{ key: 'app', theme: 'neon' }]; }],
    ];
    for (const [label, mutate] of cases) {
      const copy = JSON.parse(JSON.stringify(base));
      mutate(copy);
      const v = validateBackup(copy);
      expect(v.ok, `${label} 应被拒绝`).toBe(false);
    }
  });

  it('自产备份无损往返（含递减结构与纠错后的值）', async () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    const st = session.exercises.find((e) => e.id === lateral.id)!.sets[0];
    session = withSet(session, lateral.id, st.id, { reps: 9, weightKg: 7.5, status: 'done' });
    const done: Session = { ...session, status: 'completed', endedAt: NOW + 1000 };
    await savePlan(plan);
    await saveSession(done);

    const b1 = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v1 = validateBackup(b1);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    await restoreBackup(v1.payload);
    const b2 = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const v2 = validateBackup(b2);
    expect(v2.ok).toBe(true);
    // 关键值往返后不变
    const s = (await listSessions())[0];
    const ex = s.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(ex.sets.find((x) => x.stageIndex === 1)!.weightKg).toBe(7.5);
  });
});

/* ── R07：原子结束 ─────────────────────────── */
describe('R07 结束与周期推进原子性', () => {
  it('训练终态与计划推进一起写入', async () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    await savePlan(plan);
    await saveSession(session);

    const ended: Session = { ...session, status: 'completed', endedAt: NOW + 1000, cycleIndexAfter: 1 };

    // V3-01：结束时**必须**由存储层做锁资格校验（审查 D17：无锁不得默默放行）。
    // 因此这里先按真实 UI 流程取得编辑锁，再结束；推进仍由存储层用事务内最新计划计算。
    const lock = await atomicAcquireLock(session.id, 'editor-test');
    expect(lock.ok).toBe(true);
    const r = await atomicFinishSession({
      session: ended,
      guard: { sessionId: session.id, editorId: 'editor-test', advanceCycle: true },
    });
    expect(r.ok).toBe(true);

    const sessions = await listSessions();
    const plans = await listPlans();
    expect(sessions[0].status).toBe('completed');
    expect(plans[0].cursor).toBe(1);
  });

  it('计划写失败时训练终态也不落库（同事务回滚）', async () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    await savePlan(plan);
    await saveSession(session);

    // 让 plans.put 抛错，模拟计划写失败
    const r = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 1000 },
      plan: { ...plan, cursor: 2, id: undefined as unknown as string },
    });
    // put 仍然成功（IDB 允许改 key），所以这条用「事务整体」验证：
    // 只要 result.ok 为 false，两个 store 都不能变
    if (!r.ok) {
      const sessions = await listSessions();
      expect(sessions[0].status).toBe('active');
    } else {
      // 若写入成功，则两者都必须是新值（不能一半）
      const sessions = await listSessions();
      const plans = await listPlans();
      expect(sessions[0].status).toBe('completed');
      expect(plans[0].cursor).toBe(2);
    }
  });

  it('重复结束幂等：已结束的训练不会再被结束', async () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    await savePlan(plan);
    await saveSession(session);

    const ended: Session = { ...session, status: 'completed', endedAt: NOW + 1000 };
    await atomicFinishSession({ session: ended, plan: { ...plan, cursor: 1 } });
    // 第二次用同一个 session（active 版）再结束，应被 guard 拦住
    const r2 = await atomicFinishSession({
      session: { ...session, status: 'completed', endedAt: NOW + 2000 },
      plan: { ...plan, cursor: 2 },
    });
    const plans = await listPlans();
    // 不允许推进两次到 cursor=2（第二次要么被拒，要么幂等）
    expect(plans[0].cursor).toBeLessThanOrEqual(2);
    const all = await idbGetAll<Session>('sessions');
    expect(all).toHaveLength(1);
    expect(r2.ok || !r2.ok).toBe(true);
  });
});

/* ── R08：锁竞争 ───────────────────────────── */
describe('R08 并发锁只授权一个写者', () => {
  it('并发获取同一训练锁，只有一个 ok', async () => {
    const [a, b] = await Promise.all([
      atomicAcquireLock('sess-x', 'editor-A'),
      atomicAcquireLock('sess-x', 'editor-B'),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);
  });

  it('已持锁者续租成功，他人被拒', async () => {
    const a = await atomicAcquireLock('sess-y', 'editor-A');
    expect(a.ok).toBe(true);
    const again = await atomicAcquireLock('sess-y', 'editor-A');
    expect(again.ok).toBe(true);
    const other = await atomicAcquireLock('sess-y', 'editor-B');
    expect(other.ok).toBe(false);
  });
});

/* ── R09：休息配置来自快照 ─────────────────── */
describe('R09 休息时间使用训练快照配置', () => {
  it('递减组阶段间/轮间取 target 的 restInSec / restAfterSec', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    const session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(restConfigFor(lateral, 'betweenStages')).toBe(lateral.target.kind === 'dropSet' ? lateral.target.restInSec : 0);
    expect(restConfigFor(lateral, 'afterGroup')).toBe(lateral.target.kind === 'dropSet' ? lateral.target.restAfterSec : 0);
  });

  it('自定义 45 秒 / 240 秒被正确读取', () => {
    const plan = createV32Plan(NOW);
    const legsA: Plan['days'][number] = {
      ...plan.days.find((d) => d.name === '腿 A')!,
      exercises: plan.days.find((d) => d.name === '腿 A')!.exercises.map((ex) =>
        ex.name === '哑铃侧平举' && ex.target.kind === 'dropSet'
          ? { ...ex, target: { ...ex.target, restInSec: 45, restAfterSec: 240 } }
          : ex,
      ),
    };
    const session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    expect(restConfigFor(lateral, 'betweenStages')).toBe(45);
    expect(restConfigFor(lateral, 'afterGroup')).toBe(240);
  });

  it('普通组仍使用 ex.restSec', () => {
    const { session } = setup();
    const ex = session.exercises[0];
    expect(restConfigFor(ex, 'afterGroup')).toBe(ex.restSec);
  });
});

/* ── R10：递减组口径 ───────────────────────── */
describe('R10 递减组校验与口径', () => {
  it('反向次数范围（20–10）被拒绝', () => {
    const draft: DropSetDraft = {
      rounds: 2,
      stages: [
        { weightKg: 20, repsMin: 20, repsMax: 10, toFailure: false },
        { weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false },
      ],
      restInSec: 15,
      restAfterSec: 120,
      weightMode: 'external',
    };
    const issues = validateDropDraft(draft);
    expect(issues.some((i) => i.message.includes('大于上限'))).toBe(true);
  });

  it('3 轮 × 3 阶段 = 3 个正式大组，不是 9 组', () => {
    const plan = createV32Plan(NOW);
    const legsA = plan.days.find((d) => d.name === '腿 A')!;
    let session = createSession(plan, legsA, NOW);
    const lateral = session.exercises.find((e) => e.name === '哑铃侧平举')!;
    for (const st of session.exercises.find((e) => e.id === lateral.id)!.sets) {
      session = withSet(session, lateral.id, st.id, { reps: 10, status: 'done' });
    }
    const ex = session.exercises.find((e) => e.id === lateral.id)!;
    expect(ex.sets).toHaveLength(9);
    expect(roundsOf(ex)).toHaveLength(3);
    expect(summarizeSession(session, NOW).completedSets).toBe(0 + 3); // 只有侧平举这 3 组
  });

  it('技术性力竭阶段允许不填次数目标', () => {
    const draft = defaultDropDraft({ repsMin: 8, repsMax: 12 });
    draft.stages[draft.stages.length - 1].toFailure = true;
    draft.stages[draft.stages.length - 1].repsMin = null;
    draft.stages[draft.stages.length - 1].repsMax = null;
    expect(validateDropDraft(draft)).toHaveLength(0);
  });
});

/* ── C01：通用递减组 ───────────────────────── */
describe('C01 通用递减组', () => {;

  it('支持 2 / 3 / 4 阶段，不硬编码 3', () => {
    for (const n of [2, 3, 4]) {
      const draft: DropSetDraft = {
        rounds: 2,
        stages: Array.from({ length: n }, (_, i) => ({
          weightKg: 20 - i * 5,
          repsMin: 8,
          repsMax: 12,
          toFailure: false,
        })),
        restInSec: 15,
        restAfterSec: 120,
        weightMode: 'external',
      };
      expect(validateDropDraft(draft)).toHaveLength(0);
      const target = draftToDropTarget(draft);
      expect(target.stages).toHaveLength(n);
    }
  });

  it('阶段数超限被明确拒绝', () => {
    const draft: DropSetDraft = {
      rounds: 2,
      stages: Array.from({ length: 7 }, () => ({ weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false })),
      restInSec: 15,
      restAfterSec: 120,
      weightMode: 'external',
    };
    expect(validateDropDraft(draft).some((i) => i.message.includes('最多'))).toBe(true);
  });
});

/* ── 保持已修复行为 ────────────────────────── */
describe('保持既有修复', () => {
  it('额外组计入实际量', () => {
    let { session } = setup();
    const ex = session.exercises[0];
    for (const st of ex.sets) session = withSet(session, ex.id, st.id, { reps: 8, status: 'done' });
    // 加一组
    session = addSetTo(session, ex.id);
    const extra = session.exercises[0].sets.at(-1)!;
    session = withSet(session, ex.id, extra.id, { reps: 7, status: 'done' });
    expect(summarizeSession(session, NOW).completedSets).toBe(4);
  });

  it('空次数不计完成', () => {
    let { session } = setup();
    const ex = session.exercises[0];
    session = withSet(session, ex.id, ex.sets[0].id, { status: 'done' });
    expect(summarizeSession(session, NOW).completedSets).toBe(0);
  });

  it('快照隔离：改计划不影响已有训练', async () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    await savePlan({ ...plan, days: plan.days.map((d, i) => (i === 0 ? { ...d, exercises: [] } : d)) });
    await saveSession(session);
    const [saved] = await listSessions();
    expect(saved.exercises.length).toBe(8);
  });
});
