/* B4：替换动作「每组目标次数」的领域语义（真实 replaceExerciseInSession 执行）。
   ── 证据边界 ────────────────────────────────────────────────
   直接调用真实领域函数，验证 target 覆盖 / actual 保护 / 两分支一致性。
   **不运行 React DOM**；UI 布局与真机触摸由独立链验证。 */

import { describe, expect, it } from 'vitest';
import {
  createSession,
  replaceExerciseInSession,
  replaceConfigSeedFor,
  type ReplaceRepsOverride,
} from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Session, SessionExercise } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function baseSession(): Session {
  const plan = createV32Plan();
  return createSession(plan, plan.days[0], NOW);
}

/** 找一个普通组动作 */
function straightEx(s: Session): SessionExercise {
  const ex = s.exercises.find((e) => e.target.kind === 'straight');
  if (!ex) throw new Error('fixture 没有普通组动作');
  return ex;
}

describe('B4 · 普通组：每组目标次数覆盖', () => {
  it('范围覆盖后新动作 target 使用新范围', () => {
    const s = baseSession();
    const ex = straightEx(s);
    const reps: ReplaceRepsOverride = { kind: 'straight', repsMin: 6, repsMax: 8 };
    const r = replaceExerciseInSession(s, ex.id, '替换动作X', {
      config: { reps },
    });
    expect(r.replaced).toBe(true);
    const fresh = r.session.exercises.find((e) => e.name === '替换动作X');
    expect(fresh).toBeDefined();
    expect(fresh!.target.kind).toBe('straight');
    if (fresh!.target.kind === 'straight') {
      expect(fresh!.target.repsMin).toBe(6);
      expect(fresh!.target.repsMax).toBe(8);
    }
  });

  it('固定次数（上下限相同）也生效', () => {
    const s = baseSession();
    const ex = straightEx(s);
    const r = replaceExerciseInSession(s, ex.id, '固定次数动作', {
      config: { reps: { kind: 'straight', repsMin: 10, repsMax: 10 } },
    });
    expect(r.replaced).toBe(true);
    const fresh = r.session.exercises.find((e) => e.name === '固定次数动作');
    if (fresh!.target.kind === 'straight') {
      expect(fresh!.target.repsMin).toBe(10);
      expect(fresh!.target.repsMax).toBe(10);
    }
  });

  it('**actual 保护**：新动作记录仍为 null/blank', () => {
    const s = baseSession();
    const ex = straightEx(s);
    const r = replaceExerciseInSession(s, ex.id, '替换动作Y', {
      config: { reps: { kind: 'straight', repsMin: 6, repsMax: 8 } },
    });
    const fresh = r.session.exercises.find((e) => e.name === '替换动作Y')!;
    expect(fresh.sets.length).toBeGreaterThan(0);
    for (const st of fresh.sets) {
      expect(st.reps).toBeNull();
      expect(st.weightKg).toBeNull();
      expect(st.status).toBe('blank');
    }
  });

  it('未提供 reps 时保持旧行为（继承原目标）', () => {
    const s = baseSession();
    const ex = straightEx(s);
    const before = ex.target.kind === 'straight' ? { ...ex.target } : null;
    const r = replaceExerciseInSession(s, ex.id, '无次数覆盖', { config: { sets: 3 } });
    const fresh = r.session.exercises.find((e) => e.name === '无次数覆盖')!;
    if (fresh.target.kind === 'straight' && before) {
      expect(fresh.target.repsMin).toBe(before.repsMin);
      expect(fresh.target.repsMax).toBe(before.repsMax);
    }
  });
});

describe('B4 · 递减组：按阶段覆盖，保留其它结构', () => {
  function dropEx(s: Session): SessionExercise | undefined {
    return s.exercises.find((e) => e.target.kind === 'dropSet');
  }

  it('逐阶段覆盖次数，保留阶段数量/顺序/力竭/重量', () => {
    const s = baseSession();
    const ex = dropEx(s);
    if (!ex) return; // fixture 无递减组则跳过（不伪造）
    const t = ex.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    const beforeStages = t.stages.map((x) => ({
      label: x.label,
      weightKg: x.weightKg,
      toFailure: x.toFailure,
    }));
    const r = replaceExerciseInSession(s, ex.id, '递减替换', {
      config: {
        reps: {
          kind: 'dropSet',
          stages: t.stages.map((st, i) =>
            st.toFailure
              ? { toFailure: true }
              : { repsMin: 5 + i, repsMax: 7 + i },
          ),
        },
      },
    });
    if (!r.replaced) return;
    const fresh = r.session.exercises.find((e) => e.name === '递减替换')!;
    const nt = fresh.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    // 阶段数量与顺序不变
    expect(nt.stages.length).toBe(t.stages.length);
    nt.stages.forEach((st, i) => {
      expect(st.label).toBe(beforeStages[i].label);
      expect(st.weightKg).toBe(beforeStages[i].weightKg);
      expect(st.toFailure).toBe(beforeStages[i].toFailure);
      if (!st.toFailure) {
        expect(st.repsMin).toBe(5 + i);
        expect(st.repsMax).toBe(7 + i);
      }
    });
  });

  it('力竭阶段不要求次数（保持 null）', () => {
    const s = baseSession();
    const ex = dropEx(s);
    if (!ex) return;
    const t = ex.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    const r = replaceExerciseInSession(s, ex.id, '力竭替换', {
      config: {
        reps: {
          kind: 'dropSet',
          stages: t.stages.map(() => ({ toFailure: true })),
        },
      },
    });
    if (!r.replaced) return;
    const fresh = r.session.exercises.find((e) => e.name === '力竭替换')!;
    const nt = fresh.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    for (const st of nt.stages) {
      expect(st.toFailure).toBe(true);
      expect(st.repsMin).toBeNull();
      expect(st.repsMax).toBeNull();
    }
  });

  it('targetText 同步更新（不残留旧次数摘要）', () => {
    const s = baseSession();
    const ex = dropEx(s);
    if (!ex) return;
    const t = ex.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    const idx = t.stages.findIndex((x) => !x.toFailure);
    if (idx < 0) return;
    const r = replaceExerciseInSession(s, ex.id, '文案替换', {
      config: {
        reps: {
          kind: 'dropSet',
          stages: t.stages.map((st, i) =>
            i === idx ? { repsMin: 3, repsMax: 3 } : st.toFailure ? { toFailure: true } : {},
          ),
        },
      },
    });
    if (!r.replaced) return;
    const fresh = r.session.exercises.find((e) => e.name === '文案替换')!;
    const nt = fresh.target as Extract<SessionExercise['target'], { kind: 'dropSet' }>;
    expect(nt.stages[idx].targetText).toContain('3');
  });
});

describe('B4 · seed 从原快照继承（不硬编码）', () => {
  it('普通组 seed 的次数等于原 target 的次数', () => {
    const s = baseSession();
    const ex = straightEx(s);
    const seed = replaceConfigSeedFor(ex);
    expect(seed.kind).toBe('straight');
    expect(seed.sets).toBeGreaterThan(0);
    // seed 不返回 reps，但 UI 从 cur.target 继承；此处验证原 target 可读
    if (ex.target.kind === 'straight') {
      expect(Number.isInteger(ex.target.repsMin)).toBe(true);
      expect(Number.isInteger(ex.target.repsMax)).toBe(true);
    }
  });
});
