/* F11：成功音的**真实 I/O 时序**契约（fake-indexeddb + 真实 atomic 事务 + 真实 domain）。
   ── 这份测试证明什么 ──────────────────────────────────────
   用真实的删除事务（applyDeleteItem → commitPairedSession → atomicSaveSession）
   走一遍 saved / 版本冲突 / 无锁 / domain 冲突 / 存储异常 / 慢提交 / 连续删 / 撤销，
   并证明只有 `status === 'saved'` 那一条路径会让反馈通道真正开始播放。
   这正是 Session.commitDelete 的结构（源码契约见 f11-source-contract.test.ts）。

   不证明：用户听到了声音；真机静音/勿扰行为；真实浏览器逐帧时序。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { atomicAcquireLock, atomicCreateSession, atomicSaveSession } from '../src/db/tx';
import { getSession } from '../src/db/repo';
import { commitPairedSession, type PairedOutcome } from '../src/lib/pairedCommit';
import { createSession } from '../src/domain/session';
import {
  applyDeleteItem,
  previewDeleteItem,
  undoDeleteItem,
  type DeleteItemPreview,
  type DeleteUndoRecord,
} from '../src/domain/sessionItemIntent';
import {
  createDeleteFeedbackController,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type DeleteFeedbackDeps,
} from '../src/lib/deletionFeedback';
import type { Plan, PlanDay, Session, StraightTarget } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function straight(): StraightTarget {
  return { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 };
}

function makePlan(): Plan {
  const day: PlanDay = {
    id: 'd1',
    name: '推',
    kind: 'train',
    warmups: [],
    exercises: [
      { id: 'pe1', exerciseId: 'lib-barbell-bench', name: '卧推', restSec: 120, target: straight() },
      { id: 'pe2', exerciseId: 'lib-overhead-press', name: '推举', restSec: 90, target: straight() },
    ],
  };
  return { id: 'p1', name: '计划', days: [day], cursor: 0, createdAt: NOW, updatedAt: NOW };
}

/* ── 反馈通道替身（沿用 f11-delete-sound 的最小假实现）────────── */

class FakeSource implements AudioBufferSourceLike {
  buffer: unknown = null;
  started = 0;
  stopped = 0;
  onended: (() => void) | null = null;
  connect = () => undefined;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeContext implements AudioContextLike {
  state = 'running';
  destination = {};
  sources: FakeSource[] = [];
  async resume() {
    this.state = 'running';
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData() {
    return {};
  }
  get started(): number {
    return this.sources.reduce((n, s) => n + s.started, 0);
  }
}

function feedbackHarness() {
  const ctx = new FakeContext();
  let visible = true;
  let loadCalls = 0;
  const deps: DeleteFeedbackDeps = {
    channel: 'web',
    native: () => null,
    web: {
      createContext: () => ctx,
      loadAudio: async () => {
        loadCalls += 1;
        return new ArrayBuffer(8);
      },
      url: 'audio/delete-success.wav',
    },
    vibrate: () => true,
    visible: () => visible,
  };
  const controller = createDeleteFeedbackController(deps);
  return {
    controller,
    ctx,
    loadCalls: () => loadCalls,
    setVisible: (v: boolean) => {
      visible = v;
    },
  };
}

/* ── 真实事务 + 生产同构的成功出口 ─────────────────────────── */

interface DeleteRun {
  outcome: PairedOutcome;
  undo: DeleteUndoRecord | null;
}

/**
 * 与 `Session.commitDelete` 同构：**只有** status==='saved' 才调用反馈通道。
 * 源码契约测试会断言生产文件用的是同一个条件、同一个调用点。
 */
async function runDelete(
  args: {
    sessionId: string;
    editorId: string;
    preview: DeleteItemPreview;
    confirmed: boolean;
    controller: ReturnType<typeof feedbackHarness>['controller'];
    expectedRevision?: number;
    saveDelayGate?: Promise<void>;
    forceSaveThrow?: Error;
    onAfterAwait?: () => void;
  },
): Promise<DeleteRun> {
  let builtUndo: DeleteUndoRecord | null = null;
  const outcome = await commitPairedSession({
    sessionId: args.sessionId,
    editorId: args.editorId,
    buildNext: (fresh) => {
      const applied = applyDeleteItem(fresh, args.preview, { confirmed: args.confirmed });
      if (!applied.ok) throw new Error(applied.message);
      builtUndo = applied.undo;
      return applied.session;
    },
    deps: {
      getSession,
      save: async (session: Session, guard: { editorId: string; expectedRevision: number }) => {
        if (args.saveDelayGate) await args.saveDelayGate;
        if (args.forceSaveThrow) throw args.forceSaveThrow;
        return atomicSaveSession({
          session,
          guard: {
            sessionId: session.id,
            editorId: guard.editorId,
            expectedVersion:
              args.expectedRevision === undefined ? guard.expectedRevision : args.expectedRevision,
          },
        });
      },
    },
  });

  if (outcome.status === 'saved') {
    args.onAfterAwait?.();
    args.controller.notifySucceeded({
      sessionId: args.preview.sessionId,
      itemId: args.preview.itemId,
      token: args.preview.token,
    });
  }
  // 与生产一致：撤销记录只在 saved 分支被使用（失败不会出现撤销横幅）
  return { outcome, undo: outcome.status === 'saved' ? builtUndo : null };
}

async function seed(): Promise<{ session: Session; editorId: string }> {
  const plan = makePlan();
  const session = createSession(plan, plan.days[0], NOW);
  await atomicCreateSession({ session });
  const fresh = (await getSession(session.id))!;
  const editorId = 'editor-f11';
  const lock = await atomicAcquireLock(fresh.id, editorId);
  expect(lock.ok).toBe(true);
  return { session: fresh, editorId };
}

function preview(session: Session, itemId: string, opts: { hasRawDraft?: boolean } = {}): DeleteItemPreview {
  const p = previewDeleteItem(session, itemId, opts);
  if (!p.ok) throw new Error(`预览失败：${p.message}`);
  return p.preview;
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('F11 只有真实 saved 才播放', () => {
  it('saved：项目真的从库里消失，成功音恰好一次', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r.outcome.status).toBe('saved');
    expect(r.undo).not.toBeNull();
    const after = (await getSession(session.id))!;
    expect(after.exercises.some((e) => e.id === target)).toBe(false);
    expect(fb.ctx.started).toBe(1);
    expect(fb.loadCalls()).toBe(1);
  });

  it('版本冲突：不播放，库内容不变', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
      expectedRevision: (session.revision ?? 0) + 5,
    });
    await flush();
    expect(r.outcome.status).toBe('failed');
    const after = (await getSession(session.id))!;
    expect(after.exercises.some((e) => e.id === target)).toBe(true);
    expect(fb.ctx.started).toBe(0);
  });

  it('无锁：不播放，项目保留', async () => {
    const { session } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId: 'editor-other',
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r.outcome.status).toBe('failed');
    expect(((await getSession(session.id))!).exercises.some((e) => e.id === target)).toBe(true);
    expect(fb.ctx.started).toBe(0);
  });

  it('domain 冲突（预览后对象变了）：不播放', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const stale = preview(session, target);
    // 预览之后、提交之前对象被改（模拟确认期间的变化）
    const changed = structuredClone(session);
    changed.exercises[0].note = '刚写的备注';
    await atomicSaveSession({ session: changed, guard: { editorId, expectedVersion: session.revision } });
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: stale,
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r.outcome.status).toBe('failed');
    expect(fb.ctx.started).toBe(0);
  });

  it('存储异常（写失败/abort）：不播放、不留假撤销', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
      forceSaveThrow: new Error('注入：IndexedDB abort'),
    });
    await flush();
    expect(r.outcome.status).toBe('failed');
    expect(r.undo).toBeNull();
    expect(((await getSession(session.id))!).exercises.some((e) => e.id === target)).toBe(true);
    expect(fb.ctx.started).toBe(0);
  });

  it('有记录的项目未确认 → domain 拒绝，不播放', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const withData = structuredClone(session);
    withData.exercises[0].sets[0] = { ...withData.exercises[0].sets[0], status: 'done', reps: 10 };
    await atomicSaveSession({ session: withData, guard: { editorId, expectedVersion: session.revision } });
    const fresh = (await getSession(session.id))!;
    const p = preview(fresh, target);
    expect(p.requiresConfirm).toBe(true);
    const denied = await runDelete({
      sessionId: session.id,
      editorId,
      preview: p,
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(denied.outcome.status).toBe('failed');
    expect(fb.ctx.started).toBe(0);

    // 确认后才成功且只响一次
    const ok = await runDelete({
      sessionId: session.id,
      editorId,
      preview: p,
      confirmed: true,
      controller: fb.controller,
    });
    await flush();
    expect(ok.outcome.status).toBe('saved');
    expect(fb.ctx.started).toBe(1);
  });
});

describe('F11 慢提交与生命周期', () => {
  it('慢提交（250ms）在完成后才播放一次', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const target = session.exercises[0].id;
    const pending = runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
      saveDelayGate: gate,
    });
    await new Promise((r) => setTimeout(r, 5));
    // 提交还没完成：一声都不能有
    expect(fb.ctx.started).toBe(0);
    release();
    const r = await pending;
    await flush();
    expect(r.outcome.status).toBe('saved');
    expect(fb.ctx.started).toBe(1);
  });

  it('慢提交期间离页/隐藏：真实提交仍然成功，但迟到的成功音被作废', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const target = session.exercises[0].id;
    const pending = runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
      saveDelayGate: gate,
      // 生产里 visibilitychange 会先走 invalidateFeedback；这里对应页面隐藏
      onAfterAwait: () => {
        fb.setVisible(false);
        fb.controller.invalidate('page-hidden');
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    release();
    const r = await pending;
    await flush();
    // 业务结果不受反馈影响
    expect(r.outcome.status).toBe('saved');
    expect(((await getSession(session.id))!).exercises.some((e) => e.id === target)).toBe(false);
    // 一声都没有
    expect(fb.ctx.started).toBe(0);
  });

  it('慢提交期间切到别的 session：旧意图不响', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind('another-session');
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r.outcome.status).toBe('saved');
    expect(fb.ctx.started).toBe(0);
  });

  it('重复回调（同一 token 通知两次）只响一次', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const p = preview(session, target);
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: p,
      confirmed: false,
      controller: fb.controller,
    });
    expect(r.outcome.status).toBe('saved');
    // 模拟保存出口被重复触发（重试/重渲染）
    fb.controller.notifySucceeded({ sessionId: session.id, itemId: p.itemId, token: p.token });
    await flush();
    expect(fb.ctx.started).toBe(1);
  });

  it('连续删除两项：各响一次（每意图一次）', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const first = (await getSession(session.id))!.exercises[0].id;
    const r1 = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview((await getSession(session.id))!, first),
      confirmed: false,
      controller: fb.controller,
    });
    expect(r1.outcome.status).toBe('saved');
    const second = (await getSession(session.id))!.exercises[0].id;
    const r2 = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview((await getSession(session.id))!, second),
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r2.outcome.status).toBe('saved');
    expect(fb.ctx.started).toBe(2);
  });

  it('撤销走另一条保存路径：不会再响一次', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
    });
    expect(r.outcome.status).toBe('saved');
    await flush();
    expect(fb.ctx.started).toBe(1);

    const undo = r.undo!;
    const restored = await commitPairedSession({
      sessionId: session.id,
      editorId,
      buildNext: (fresh) => {
        const applied = undoDeleteItem(fresh, undo, Date.now(), { orderRef: undo.orderBefore });
        if (!applied.ok) throw new Error(applied.message);
        return applied.session;
      },
      deps: {
        getSession,
        save: async (s: Session, guard: { editorId: string; expectedRevision: number }) =>
          atomicSaveSession({
            session: s,
            guard: { sessionId: s.id, editorId: guard.editorId, expectedVersion: guard.expectedRevision },
          }),
      },
    });
    await flush();
    expect(restored.status).toBe('saved');
    expect(((await getSession(session.id))!).exercises.some((e) => e.id === target)).toBe(true);
    // 撤销不是删除成功：不产生第二声
    expect(fb.ctx.started).toBe(1);
  });

  it('关闭开关后真实删除仍然成功（反馈失败绝不回滚业务）', async () => {
    const { session, editorId } = await seed();
    const fb = feedbackHarness();
    fb.controller.bind(session.id);
    fb.controller.setEnabled(false);
    const target = session.exercises[0].id;
    const r = await runDelete({
      sessionId: session.id,
      editorId,
      preview: preview(session, target),
      confirmed: false,
      controller: fb.controller,
    });
    await flush();
    expect(r.outcome.status).toBe('saved');
    expect(r.undo).not.toBeNull();
    expect(((await getSession(session.id))!).exercises.some((e) => e.id === target)).toBe(false);
    expect(fb.ctx.started).toBe(0);
  });
});
