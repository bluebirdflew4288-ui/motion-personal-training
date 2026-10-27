/* B4-R2 已证缺口 4：`replaceExerciseInSession` 的 reps override kind 不匹配必须早拒。

   ── Codex 独立已证（22 例 20 PASS / 2 FAIL）─────────────────
   1. 普通 target + 合法 dropSet override → 直接 TypeError（读 stages.length）；
   2. dropSet target + 合法 straight override → replaced:true 但**忽略**用户目标。

   两者都是公开 union 的合法成员组合。本文件锁住：早拒 + 返回原 session + 明确失败，
   绝不盲 catch、不改既有断言、不把失败说成成功。

   证据边界：纯 domain 模块级证据（真实生产导出函数），
   普通 UI 是否可达该组合**未证明**，不声称是真实 UI 崩溃。 */

import { describe, expect, it } from 'vitest';
import { replaceExerciseInSession } from '../src/domain/session';
import type { Session, SessionExercise } from '../src/domain/types';

function straightExercise(): SessionExercise {
  return {
    id: 'ex-1',
    name: '卧推',
    restSec: 120,
    target: { kind: 'straight', sets: 3, repsMin: 8, repsMax: 12 },
    groups: [
      { index: 1, stageCount: 1 },
      { index: 2, stageCount: 1 },
      { index: 3, stageCount: 1 },
    ],
    sets: [],
    status: 'pending',
  } as unknown as SessionExercise;
}

function dropExercise(): SessionExercise {
  return {
    id: 'ex-2',
    name: '侧平举',
    restSec: 90,
    target: {
      kind: 'dropSet',
      rounds: 2,
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
      stages: [
        { weightKg: 12, repsMin: 12, repsMax: 12, toFailure: false, targetText: '12 次' },
        { weightKg: 8, repsMin: 10, repsMax: 10, toFailure: false, targetText: '10 次' },
      ],
    },
    groups: [
      { index: 1, stageCount: 2 },
      { index: 2, stageCount: 2 },
    ],
    sets: [],
    status: 'pending',
  } as unknown as SessionExercise;
}

function sessionWith(ex: SessionExercise): Session {
  return {
    id: 's-1',
    planId: 'p-1',
    startedAt: 1,
    endedAt: null,
    exercises: [ex],
    activeSession: null,
    history: [],
  } as unknown as Session;
}

describe('B4-R2 · reps override kind 不匹配必须早拒', () => {
  it('普通 target + dropSet override → replaced:false，不抛 TypeError', () => {
    const session = sessionWith(straightExercise());
    let threw: unknown = null;
    let out: ReturnType<typeof replaceExerciseInSession> | null = null;
    try {
      out = replaceExerciseInSession(session, 'ex-1', '新动作', {
        config: {
          reps: {
            kind: 'dropSet',
            stages: [{ repsMin: 10, repsMax: 10 }],
          },
        },
      } as never);
    } catch (e) {
      threw = e;
    }
    // 关键：不得抛 TypeError（旧实现的真实失败）
    expect(threw).toBeNull();
    expect(out).not.toBeNull();
    expect(out!.replaced).toBe(false);
    // 返回原 session（同一个对象引用即可，语义上不能改动）
    expect(out!.session.exercises[0].target).toEqual(session.exercises[0].target);
    expect(out!.message).toContain('不一致');
  });

  it('dropSet target + straight override → replaced:false，不得假报成功', () => {
    const session = sessionWith(dropExercise());
    const out = replaceExerciseInSession(session, 'ex-2', '新动作', {
      config: { reps: { kind: 'straight', repsMin: 10, repsMax: 10 } },
    } as never);
    expect(out.replaced).toBe(false);
    expect(out.message).toContain('不一致');
    // 不得把用户目标静默丢弃后仍说成功
    expect(out.session.exercises[0].target).toEqual(session.exercises[0].target);
  });

  it('kind 匹配的合法覆盖仍正常生效（不误伤既有通过项）', () => {
    const session = sessionWith(straightExercise());
    const out = replaceExerciseInSession(session, 'ex-1', '新动作', {
      config: { reps: { kind: 'straight', repsMin: 10, repsMax: 10 } },
    } as never);
    expect(out.replaced).toBe(true);
    const target = out.session.exercises[0].target as { kind: string; repsMin: number; repsMax: number };
    expect(target.kind).toBe('straight');
    expect(target.repsMin).toBe(10);
    expect(target.repsMax).toBe(10);
  });

  it('dropSet 匹配覆盖：逐阶段生效且阶段数量校验仍有效', () => {
    const session = sessionWith(dropExercise());
    const ok = replaceExerciseInSession(session, 'ex-2', '新动作', {
      config: {
        reps: {
          kind: 'dropSet',
          stages: [
            { repsMin: 15, repsMax: 15 },
            { repsMin: 12, repsMax: 12 },
          ],
        },
      },
    } as never);
    expect(ok.replaced).toBe(true);
    const t = ok.session.exercises[0].target as { stages: Array<{ repsMin: number | null; repsMax: number | null }> };
    expect(t.stages[0].repsMin).toBe(15);
    expect(t.stages[1].repsMin).toBe(12);

    // 阶段数量不匹配仍必须拒绝（既有断言不变）
    const bad = replaceExerciseInSession(session, 'ex-2', '新动作', {
      config: { reps: { kind: 'dropSet', stages: [{ repsMin: 10, repsMax: 10 }] } },
    } as never);
    expect(bad.replaced).toBe(false);
  });
});
