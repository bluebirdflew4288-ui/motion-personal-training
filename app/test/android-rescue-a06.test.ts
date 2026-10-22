/* A06 回归：救援位必须是**可区分版本**的持续数据流，而不是一次性的单发。
   ── 独立审查第二轮探针复现的真实缺陷（比第一轮更严重）──────────
     saveOutcomes: ["lock-lost","lock-lost"]      ← 两笔慢写都失败
     consumerBeforeRetry: 1                        ← 新实例只接住了第一版
     rescueBeforeRetry: 15                         ← 存储里其实已经是 15
     consumerMessages: [..., "已保存本页改动。"]
     finalStoredReps: 1                            ← 重试把 1 写进库
     finalRescue: null                             ← 并且把 15 清掉了
   即：接住第一份就 done，后续更新送不到；提交 1 成功后无条件 clear，
   把已经存在的 15 一并抹掉 —— 用户看到“已保存”，实际丢的是 15。

   修正后的契约（本文件验证）：
     ① 每次发布都有单调递增 seq；订阅者持续收到，不限时间；
     ② 提交成功只确认**自己覆盖的那一版 seq**；
     ③ 若存储里已有更新的版本 → 不清除、返回 newer，调用方继续保留 pending；
     ④ 更新的版本在旧版提交期间到达 → 那次提交绝不能清掉它。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ackRescueDraft,
  clearRescueDraft,
  loadRescueDraft,
  loadRescueRecord,
  publishRescueDraft,
  saveRescueDraft,
  subscribeRescueDraft,
  watchRescueDraft,
} from '../src/lib/draftRescue';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import type { PendingDraft } from '../src/domain/draftMerge';
import type { Session } from '../src/domain/types';

const SID = 'a06-session';

function makeStorage() {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
  (globalThis as unknown as { sessionStorage: typeof storage }).sessionStorage = storage;
  return storage;
}

function makeDraftWithReps(reps: number, token = 1): PendingDraft {
  const plan = createV32Plan(1_760_000_000_000);
  const session = createSession(plan, plan.days[0], 1_760_000_000_000);
  const edited: Session = {
    ...session,
    exercises: session.exercises.map((ex, i) =>
      i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? { ...st, reps } : st)) } : ex,
    ),
  };
  return { token, session: edited, baseRevision: 0, baseSession: session };
}

const repsOf = (d: PendingDraft | null): number | null =>
  d ? ((d.session.exercises[0].sets[0].reps as number | null) ?? null) : null;

describe('A06 · 版本化救援位（生产模块）', () => {
  let storage: ReturnType<typeof makeStorage>;

  beforeEach(() => {
    storage = makeStorage();
    storage.clear();
    clearRescueDraft(SID);
  });

  it('每次发布分配单调递增的 seq，且内容可读回', () => {
    const seq1 = publishRescueDraft(SID, makeDraftWithReps(1));
    const seq2 = publishRescueDraft(SID, makeDraftWithReps(15));
    expect(seq1).not.toBeNull();
    expect(seq2).not.toBeNull();
    expect(seq2 as number).toBeGreaterThan(seq1 as number);
    expect(repsOf(loadRescueDraft(SID))).toBe(15);
    expect(loadRescueRecord(SID)?.seq).toBe(seq2);
  });

  it('订阅者收到**每一次**发布（不只第一次）', () => {
    const seen: Array<number | null> = [];
    const off = subscribeRescueDraft(SID, (r) => seen.push(r ? (r.session.exercises[0].sets[0].reps as number) : null));
    publishRescueDraft(SID, makeDraftWithReps(1));
    publishRescueDraft(SID, makeDraftWithReps(15));
    off();
    expect(seen).toEqual([1, 15]);
  });

  it('watchRescueDraft 持续接收更新版本，且不设时间上限', async () => {
    const seen: number[] = [];
    const stop = watchRescueDraft(SID, (r) => seen.push(r.session.exercises[0].sets[0].reps as number), {
      intervalMs: 15,
    });

    publishRescueDraft(SID, makeDraftWithReps(1));
    await new Promise((r) => setTimeout(r, 40)); // 明显超过一个轮询周期
    publishRescueDraft(SID, makeDraftWithReps(15));
    await new Promise((r) => setTimeout(r, 120)); // 旧的 4 秒截断在这里会失效
    stop();

    expect(seen).toEqual([1, 15]); // 两版都收到，且顺序正确
  });

  it('提交成功只确认自己那一版：更新版本存在时不清除并返回 newer', () => {
    const seq1 = publishRescueDraft(SID, makeDraftWithReps(1)) as number;
    const seq15 = publishRescueDraft(SID, makeDraftWithReps(15)) as number;
    expect(seq15).toBeGreaterThan(seq1);

    // 场景：正在提交的是第 1 版（seq1），但存储里已经是 15（seq15）
    const acked = ackRescueDraft(SID, seq1);
    expect(acked.cleared).toBe(false);
    expect(acked.newer).not.toBeNull();
    expect(repsOf(acked.newer ? { ...makeDraftWithReps(0), session: acked.newer.session } : null)).toBe(15);
    // 关键：15 仍在存储里，没被这次提交清掉
    expect(repsOf(loadRescueDraft(SID))).toBe(15);
  });

  it('确认的正是最新版本时才真正清除', () => {
    publishRescueDraft(SID, makeDraftWithReps(1));
    const seq15 = publishRescueDraft(SID, makeDraftWithReps(15)) as number;
    const acked = ackRescueDraft(SID, seq15);
    expect(acked.cleared).toBe(true);
    expect(acked.newer).toBeNull();
    expect(loadRescueDraft(SID)).toBeNull();
  });

  it('ackedSeq 为 null（本次提交不覆盖任何救援）时绝不清除', () => {
    publishRescueDraft(SID, makeDraftWithReps(15));
    const acked = ackRescueDraft(SID, null);
    expect(acked.cleared).toBe(false);
    expect(repsOf(loadRescueDraft(SID))).toBe(15);
  });

  it('救援位损坏 / 旧格式时安全忽略（返回 null，不抛错）', () => {
    (globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }).sessionStorage.setItem(
      `motion-pending-draft:${SID}`,
      '{not json',
    );
    expect(loadRescueDraft(SID)).toBeNull();

    // v1 旧格式（无 seq）必须被忽略，不能误当有效记录
    (globalThis as unknown as { sessionStorage: { setItem: (k: string, v: string) => void } }).sessionStorage.setItem(
      `motion-pending-draft:${SID}`,
      JSON.stringify({ v: 1, token: 1, baseRevision: 0, session: {}, baseSession: {} }),
    );
    expect(loadRescueDraft(SID)).toBeNull();
  });

  it('saveRescueDraft 兼容封装与 publish 语义一致', () => {
    expect(saveRescueDraft(SID, makeDraftWithReps(15))).toBe(true);
    expect(repsOf(loadRescueDraft(SID))).toBe(15);
    expect(saveRescueDraft(SID, null)).toBe(true);
    expect(loadRescueDraft(SID)).toBeNull();
  });

  it('明确放弃后清除，之后不再有救援', () => {
    publishRescueDraft(SID, makeDraftWithReps(15));
    clearRescueDraft(SID);
    expect(loadRescueDraft(SID)).toBeNull();
    expect(storage.size).toBe(0);
  });
});

/* ── A06 修复不得放宽真正的外部冲突 ────────────────────────────────
   同一意图 1→15 属于内部演进（允许合并）；
   但“另一个编辑者写了同一个字段”仍必须是冲突并被拒绝。
   本组直接用生产 mergeDraftOntoFresh 验证边界未被削弱。 */

describe('A06 · 外部同字段冲突仍被拒绝（保护性）', () => {
  it('别人把同一组改成 12、本页草稿是 15 → 冲突且不覆盖', async () => {
    const { mergeDraftOntoFresh } = await import('../src/domain/draftMerge');
    const plan = createV32Plan(1_760_000_000_000);
    const base = createSession(plan, plan.days[0], 1_760_000_000_000);
    const patch = (s: Session, reps: number): Session => ({
      ...s,
      exercises: s.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? { ...st, reps } : st)) } : ex,
      ),
    });

    const mine = patch(base, 15); // 本页意图
    const fresh = patch(base, 12); // 另一个编辑者写了 12（同一字段）

    // 不传 priorOwnCommit：库变化不是本页造成的 → 走原三方冲突判定
    const r = mergeDraftOntoFresh(base, mine, fresh, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.conflicts.length).toBeGreaterThan(0);
      expect(r.conflicts.some((c) => c.path.includes('次数') || c.path.includes('组'))).toBe(true);
    }
  });

  it('即使传了 priorOwnCommit，但 revision 对不上（库被别人推进）→ 仍是冲突', async () => {
    const { mergeDraftOntoFresh } = await import('../src/domain/draftMerge');
    const plan = createV32Plan(1_760_000_000_000);
    const base = createSession(plan, plan.days[0], 1_760_000_000_000);
    const patch = (s: Session, reps: number): Session => ({
      ...s,
      exercises: s.exercises.map((ex, i) =>
        i === 0 ? { ...ex, sets: ex.sets.map((st, j) => (j === 0 ? { ...st, reps } : st)) } : ex,
      ),
    });

    const d1 = patch(base, 1); // 本页上一次提交的原始意图
    const mine = patch(base, 15); // 本页当前意图
    const fresh = patch(base, 12); // 库被别人写成 12（revision 不是本页那次）

    const r = mergeDraftOntoFresh(base, mine, fresh, { revision: 999, intent: d1 });
    expect(r.ok).toBe(false); // priorOwnCommit 的 revision 不符 → 不启用演进路径
  });
});
