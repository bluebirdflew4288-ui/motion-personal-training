/* F10：删除消散/补位的纯表现层规则。
   这些断言只覆盖**可判定的表现层约束**（时长范围、粒子确定性、补位方向），
   不代表真实浏览器里的逐帧效果；后者由 stage 证据与 Codex 独立复验。 */
import { describe, expect, it } from 'vitest';
import {
  DISSOLVE_MS,
  DISSOLVE_PARTICLE_COUNT,
  buildDissolveParticles,
  dissolveAttribution,
  dissolveTiming,
  hashSeed,
  reflowShift,
  sessionHasItem,
} from '../src/ui/deleteDissolve';

describe('F10 dissolve timing', () => {
  it('普通模式消散时长落在方案要求的 200–300ms', () => {
    const { ghostMs } = dissolveTiming(false);
    expect(ghostMs).toBe(DISSOLVE_MS);
    expect(ghostMs).toBeGreaterThanOrEqual(200);
    expect(ghostMs).toBeLessThanOrEqual(300);
  });

  it('减少动态时不派时长，调用方据此完全不建节点', () => {
    expect(dissolveTiming(true).ghostMs).toBe(0);
  });
});

describe('F10 particles', () => {
  it('同一 token 得到同一组粒子（截图/逐帧可比较，不会每次重排）', () => {
    const a = buildDissolveParticles('delete-abc-123');
    const b = buildDissolveParticles('delete-abc-123');
    expect(a).toEqual(b);
    expect(a).toHaveLength(DISSOLVE_PARTICLE_COUNT);
  });

  it('不同 token 得到不同分布（连续删除各自归属，不叠同一形状）', () => {
    const a = buildDissolveParticles('delete-one');
    const b = buildDissolveParticles('delete-two');
    expect(a).not.toEqual(b);
  });

  it('粒子全部向上飘、留在这张卡自己的盒内范围，尺寸与透明度有限', () => {
    for (const token of ['delete-x1', 'delete-x2', 'delete-x3', 'delete-x4']) {
      for (const p of buildDissolveParticles(token)) {
        // 只向上：绝不压到下方邻卡
        expect(p.dy).toBeLessThan(0);
        // 横向位移有界（盒内 clip，不产生横向溢出滚动）
        expect(Math.abs(p.dx)).toBeLessThanOrEqual(18);
        expect(p.xPct).toBeGreaterThanOrEqual(0);
        expect(p.xPct).toBeLessThanOrEqual(100);
        expect(p.yPct).toBeGreaterThanOrEqual(0);
        expect(p.yPct).toBeLessThanOrEqual(100);
        expect(p.size).toBeGreaterThan(0);
        expect(p.size).toBeLessThanOrEqual(6);
        expect(p.opacity).toBeGreaterThan(0);
        expect(p.opacity).toBeLessThanOrEqual(1);
        expect(p.durationMs).toBeGreaterThan(0);
        expect(p.durationMs).toBeLessThanOrEqual(DISSOLVE_MS);
        expect(p.delayMs).toBeGreaterThanOrEqual(0);
        expect(['brick', 'ink']).toContain(p.tone);
      }
    }
  });

  it('粒子数可裁剪且有下限保护（不会因为传 0 而空动画）', () => {
    expect(buildDissolveParticles('t', 0)).toHaveLength(1);
    expect(buildDissolveParticles('t', 4)).toHaveLength(4);
    expect(buildDissolveParticles('t', 999).length).toBeLessThanOrEqual(24);
  });

  it('hashSeed 稳定且区分大小写输入', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abC'));
  });
});

describe('F10 reflow shift', () => {
  it('卡片真的向上移动时给出位移（补位动画依据）', () => {
    expect(reflowShift(400, 268)).toBe(132);
  });

  it('向下移动不算补位：失败横幅把卡片往下推时绝不假装删除成功', () => {
    expect(reflowShift(268, 400)).toBe(0);
  });

  it('不足 2px 的抖动与非法输入都忽略', () => {
    expect(reflowShift(300, 299)).toBe(0);
    expect(reflowShift(Number.NaN, 100)).toBe(0);
    expect(reflowShift(100, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

/* ── F10-FIX1：补位的成功归属 ─────────────────────────────────
   慢事务（真实 IDB 提交 2s+）期间列表本来就可能因折叠/输入而移动。
   补位只能由"本删除对象已从对应已提交 Session 移除"触发。 */
type FakeSession = {
  id: string;
  revision?: number;
  exercises: Array<{ id: string }>;
  cardio?: Array<{ id: string }>;
};

const baseSession = (over: Partial<FakeSession> = {}): FakeSession => ({
  id: 's-1',
  revision: 3,
  exercises: [{ id: 'ex-1' }, { id: 'ex-2' }],
  cardio: [{ id: 'cardio-1' }],
  ...over,
});

const pendingOf = (over: Record<string, unknown> = {}) => ({
  epoch: 7,
  token: 'delete-token-1',
  sessionId: 's-1',
  itemId: 'ex-2',
  kind: 'exercise' as const,
  revision: 2,
  ...over,
});

describe('F10-FIX1 补位归属：条目仍在就不是删除成功', () => {
  it('对象仍在已提交 Session 里 → wait（慢提交期间任何布局变化都不得假补位）', () => {
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: baseSession() })).toBe('wait');
  });

  it('对象仍在时，即使版本已经前进（例如期间保存了其它输入）也只是 wait', () => {
    expect(
      dissolveAttribution({ pending: pendingOf({ revision: 1 }), epoch: 7, session: baseSession({ revision: 9 }) }),
    ).toBe('wait');
  });

  it('对象已移除且版本前进 → match（这才是本删除的已提交状态）', () => {
    const removed = baseSession({ exercises: [{ id: 'ex-1' }], revision: 4 });
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: removed })).toBe('match');
  });

  it('对象已移除但版本没有前进 → reject（旧快照重放，不假补位）', () => {
    const removed = baseSession({ exercises: [{ id: 'ex-1' }], revision: 2 });
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: removed })).toBe('reject');
  });

  it('换成另一个 Session → reject（越页/切 session 的效果不串页）', () => {
    const other = baseSession({ id: 's-2', exercises: [{ id: 'ex-1' }], revision: 9 });
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: other })).toBe('reject');
  });

  it('捕获世代失效（卸载/切 session/隐藏/失锁）→ reject，即使数据看起来已经删掉', () => {
    const removed = baseSession({ exercises: [{ id: 'ex-1' }], revision: 9 });
    expect(dissolveAttribution({ pending: pendingOf({ epoch: 6 }), epoch: 7, session: removed })).toBe('reject');
  });

  it('Session 缺失 → reject', () => {
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: undefined })).toBe('reject');
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: null })).toBe('reject');
  });

  it('有氧对象按 cardio 列表判定，不被同名 strength 条目冒充', () => {
    const cardioPending = pendingOf({ itemId: 'cardio-1', kind: 'cardio' });
    expect(dissolveAttribution({ pending: cardioPending, epoch: 7, session: baseSession() })).toBe('wait');
    const cardioRemoved = baseSession({ cardio: [], revision: 5 });
    expect(dissolveAttribution({ pending: cardioPending, epoch: 7, session: cardioRemoved })).toBe('match');
  });

  it('版本缺省时以"条目已移除"为准（不因缺少 revision 就永远不补位）', () => {
    const removed = baseSession({ exercises: [{ id: 'ex-1' }], revision: undefined });
    expect(dissolveAttribution({ pending: pendingOf(), epoch: 7, session: removed })).toBe('match');
  });
});

describe('F10-FIX1 sessionHasItem', () => {
  it('区分分区、缺失 Session 一律 false', () => {
    expect(sessionHasItem(baseSession(), 'exercise', 'ex-1')).toBe(true);
    expect(sessionHasItem(baseSession(), 'exercise', 'cardio-1')).toBe(false);
    expect(sessionHasItem(baseSession(), 'cardio', 'cardio-1')).toBe(true);
    expect(sessionHasItem(baseSession({ cardio: undefined }), 'cardio', 'cardio-1')).toBe(false);
    expect(sessionHasItem(undefined, 'exercise', 'ex-1')).toBe(false);
  });
});
