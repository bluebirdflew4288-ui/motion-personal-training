/* G1 动作配置记忆与原子保存（ACCEPTANCE M01–M06 / P01–P03）。
   使用 fake-indexeddb 隔离库；故障注入使用真实 IDB 事务 abort。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import {
  atomicAcquireLock,
  atomicCreateSession,
  atomicFinishSession,
  atomicSaveSessionWithTemplate,
} from '../src/db/tx';
import { getSession } from '../src/db/repo';
import {
  deleteExerciseTemplate,
  exerciseTemplateKey,
  listExerciseTemplates,
  putExerciseTemplate,
  readExerciseTemplates,
  validateExerciseTemplate,
} from '../src/db/templates';
import {
  applyTargetToSessionExercise,
  createSession,
} from '../src/domain/session';
import {
  exerciseTemplateFromConfig,
  extractExerciseTemplate,
  sessionExerciseFromTemplate,
} from '../src/domain/exerciseConfig';
import {
  mergeExerciseCatalog,
  searchExerciseCatalog,
  sortExerciseCatalog,
  type ExerciseCatalogEntry,
} from '../src/domain/exerciseLibrary';
import type { ExerciseTarget, ExerciseTemplate, Plan, PlanDay, Session, StraightTarget } from '../src/domain/types';

const NOW = 1_760_000_000_000;

function straightTarget(over: Partial<StraightTarget> = {}): StraightTarget {
  return {
    kind: 'straight',
    sets: 3,
    setsMax: 3,
    repsMin: 8,
    repsMax: 12,
    weightMode: 'external',
    suggestedWeightKg: 60,
    ...over,
  };
}

function makePlan(): Plan {
  const day: PlanDay = {
    id: 'd1',
    name: '胸 A',
    kind: 'train',
    warmups: [],
    exercises: [
      { id: 'pe1', exerciseId: 'lib-barbell-bench', name: '自由杠铃卧推', restSec: 120, target: straightTarget() },
    ],
  };
  return { id: 'p1', name: '测试计划', days: [day], cursor: 0, createdAt: NOW, updatedAt: NOW };
}

async function seedActiveSession(): Promise<{ session: Session; editorId: string }> {
  const plan = makePlan();
  const session = createSession(plan, plan.days[0], NOW);
  const created = await atomicCreateSession({ session });
  expect(created.ok).toBe(true);
  const editorId = 'editor-A';
  const lock = await atomicAcquireLock(session.id, editorId);
  expect(lock.ok).toBe(true);
  return { session, editorId };
}

function addOneExercise(session: Session, name = '自定义弯举'): { session: Session; exId: string } {
  const tpl = exerciseTemplateFromConfig({
    exerciseId: `custom:${name}`,
    name,
    target: { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: null },
    restSec: 100,
  });
  const ex = sessionExerciseFromTemplate(tpl);
  return { session: { ...session, exercises: [...session.exercises, ex] }, exId: ex.id };
}

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('M01 首次创建记忆', () => {
  it('首次自定义动作成功保存：模板出现一次，保存全套纯配置', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW, (i) => `stage-${i}`);

    const r = await putExerciseTemplate(tpl, null);
    expect(r.ok).toBe(true);
    expect(r.ok && r.template.revision).toBe(1);

    const list = await listExerciseTemplates();
    expect(list).toHaveLength(1);
    expect(list[0].exerciseId).toBe(ex.exerciseId);
    expect(list[0].name).toBe('自定义弯举');
    expect(list[0].restSec).toBe(100);
    expect(list[0].target.kind).toBe('straight');
    // 纯配置：不含 actual/status
    expect('sets' in list[0]).toBe(false);
    expect('status' in list[0]).toBe(false);
  });

  it('取消/非法/写入失败都不生成半条模板', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];
    const tpl = extractExerciseTemplate(ex, 1, NOW);

    const invalid = { ...tpl, restSec: -1 };
    const bad = await putExerciseTemplate(invalid, null);
    expect(bad.ok).toBe(false);
    expect(await listExerciseTemplates()).toHaveLength(0);

    const originalPut = IDBObjectStore.prototype.put;
    let injected = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'meta' && (value as { key?: string })?.key?.startsWith('exercise-template:')) {
        injected += 1;
        throw new DOMException('injected template quota failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
      const failed = await putExerciseTemplate(tpl, null);
      expect(failed.ok).toBe(false);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(injected).toBe(1);
    expect(await listExerciseTemplates()).toHaveLength(0);
  });
});

describe('M02 修改但未勾“记住本次配置”', () => {
  it('只改当前训练，下次添加仍用原记忆', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex0 = withEx.exercises.find((e) => e.id === exId)!;
    await putExerciseTemplate(extractExerciseTemplate(ex0, 1, NOW), null);
    const before = (await listExerciseTemplates())[0];

    const r = applyTargetToSessionExercise(withEx, exId, straightTarget({ sets: 4, setsMax: 4, repsMin: 5, repsMax: 8 }));
    expect(r.applied).toBe(true);
    // 没有模板写入 → 记忆不变
    const after = (await listExerciseTemplates())[0];
    expect(after.revision).toBe(before.revision);
    expect(after.target.kind === 'straight' && after.target.repsMin).toBe(8);

    const nextInstance = sessionExerciseFromTemplate(after);
    expect(nextInstance.target.kind === 'straight' && nextInstance.target.sets).toBe(3);
    expect(nextInstance.target.kind === 'straight' && nextInstance.target.repsMin).toBe(8);
  });
});

describe('M03 勾记忆并保存后再次添加', () => {
  it('新实例带入最新配置；其他实例与历史不变', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex0 = withEx.exercises.find((e) => e.id === exId)!;
    const first = await putExerciseTemplate(extractExerciseTemplate(ex0, 1, NOW), null);
    expect(first.ok).toBe(true);

    const modified = applyTargetToSessionExercise(withEx, exId, straightTarget({ sets: 4, setsMax: 4, repsMin: 5, repsMax: 8 }));
    const exNew = modified.session.exercises.find((e) => e.id === exId)!;
    const updatedTpl = extractExerciseTemplate(exNew, 2, NOW + 1);
    const saved = await putExerciseTemplate(updatedTpl, 1);
    expect(saved.ok).toBe(true);
    expect(saved.ok && saved.template.revision).toBe(2);

    const next = sessionExerciseFromTemplate((await listExerciseTemplates())[0]);
    expect(next.target.kind === 'straight' && next.target.sets).toBe(4);
    expect(next.target.kind === 'straight' && next.target.repsMin).toBe(5);
    // 原实例（withEx 中的旧 ex）没有被修改
    expect(ex0.target.kind === 'straight' && ex0.target.sets).toBe(3);
    expect(editorId).toBe('editor-A');
  });
});

describe('M04 新实例深复制，不继承 actual/status/计时/来源', () => {
  it('新 sessionExerciseId 与 set ID；全部 blank；无 plan 来源；深复制无共享引用', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    // 在原实例上留下实际数据，不应被模板/新实例继承
    const tpl = extractExerciseTemplate(ex, 1, NOW);

    const a = sessionExerciseFromTemplate(tpl);
    const b = sessionExerciseFromTemplate(tpl);
    expect(a.id).not.toBe(b.id);
    expect(a.planExerciseId).toBeNull();
    expect(a.status).toBe('pending');
    expect(a.sets.every((s) => s.status === 'blank' && s.reps === null && s.weightKg === null)).toBe(true);
    expect(a.sets.map((s) => s.id)).not.toEqual(b.sets.map((s) => s.id));

    // 深复制：改 a 不影响 b 与模板
    if (a.target.kind === 'straight') a.target.sets = 99;
    expect(b.target.kind === 'straight' && b.target.sets).toBe(3);
    expect(tpl.target.kind === 'straight' && tpl.target.sets).toBe(3);
  });
});

describe('M05 身份去重与同次训练多实例', () => {
  it('内置名与记忆按 exerciseId 去重；同名前后空格不产生第二条', () => {
    const tpl = {
      key: exerciseTemplateKey('lib-barbell-bench'),
      schemaVersion: 1 as const,
      exerciseId: 'lib-barbell-bench',
      name: ' 自由杠铃卧推 ',
      target: straightTarget(),
      restSec: 120,
      revision: 2,
      updatedAt: NOW,
    };
    const catalog = mergeExerciseCatalog(undefined, [tpl]);
    const bench = catalog.filter((e) => e.exerciseId === 'lib-barbell-bench');
    expect(bench).toHaveLength(1);
    expect(bench[0].hasTemplate).toBe(true);
    expect(bench[0].templateRevision).toBe(2);

    const whitespace = { ...tpl, key: exerciseTemplateKey('custom:我的动作'), exerciseId: 'custom:我的动作', name: '  我的动作  ' };
    const catalog2 = mergeExerciseCatalog(undefined, [tpl, whitespace]);
    expect(catalog2.filter((e) => e.exerciseId === 'custom:我的动作')).toHaveLength(1);
  });

  it('同一次训练两个实例仍有独立 ID', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW);
    const i1 = sessionExerciseFromTemplate(tpl);
    const i2 = sessionExerciseFromTemplate(tpl);
    expect(i1.id).not.toBe(i2.id);
    expect(i1.exerciseId).toBe(i2.exerciseId);
  });
});

describe('M06 拼音排序、搜索与重启保留', () => {
  it('中文按拼音首字母稳定排序，英文/数字前缀不被强制分类', () => {
    const names = ['卧推', '深蹲', '引体向上', '硬拉', '弯举', '100次'];
    const entries: ExerciseCatalogEntry[] = names.map((name, i) => ({
      exerciseId: `custom:${i}`,
      name,
      builtin: false,
      hasTemplate: false,
      templateRevision: null,
    }));
    expect(sortExerciseCatalog(entries).map((e) => e.name)).toEqual(['100次', '深蹲', '弯举', '卧推', '引体向上', '硬拉']);
  });

  it('搜索可找到中文、英文与分组', () => {
    const catalog = mergeExerciseCatalog();
    expect(searchExerciseCatalog(catalog, '卧推').some((e) => e.name.includes('卧推'))).toBe(true);
    expect(searchExerciseCatalog(catalog, 'BENCH').some((e) => (e.en ?? '').includes('BENCH'))).toBe(true);
    expect(searchExerciseCatalog(catalog, '胸').every((e) => e.group === '胸' || e.name.includes('胸'))).toBe(true);
  });

  it('重启后记忆仍在（重新打开数据库连接）', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    await putExerciseTemplate(extractExerciseTemplate(ex, 1, NOW), null);
    __resetDbHandle(); // 模拟应用重启
    const list = await listExerciseTemplates();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('自定义弯举');
  });
});

describe('P01 session + 模板原子性（abort 全回滚）', () => {
  it('模板写入抛错：session 与模板都不变，草稿可由调用方保留后重试成功', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW);

    const originalPut = IDBObjectStore.prototype.put;
    let injected = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'meta' && (value as { key?: string })?.key?.startsWith('exercise-template:')) {
        injected += 1;
        throw new DOMException('injected template failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    let failed: Awaited<ReturnType<typeof atomicSaveSessionWithTemplate>>;
    try {
      failed = await atomicSaveSessionWithTemplate({
        session: withEx,
        guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
        template: tpl,
        templateExpectedRevision: null,
      });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(injected).toBe(1);
    expect(failed.ok).toBe(false);
    const after = await getSession(withEx.id);
    expect(after!.revision).toBe(1);
    expect(after!.exercises).toHaveLength(1);
    expect(await listExerciseTemplates()).toHaveLength(0);

    // 重试（同一份草稿）成功
    const retried = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: tpl,
      templateExpectedRevision: null,
    });
    expect(retried.ok).toBe(true);
    expect((await listExerciseTemplates())[0].revision).toBe(1);
  });

  it('session put 请求成功后再 abort：session 不被误报成功，模板也不落库', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW);

    const originalPut = IDBObjectStore.prototype.put;
    let aborts = 0;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      if (this.name === 'sessions') {
        const transaction = this.transaction;
        request.addEventListener(
          'success',
          () => {
            aborts += 1;
            transaction.abort();
          },
          { once: true },
        );
      }
      return request;
    };
    let r: Awaited<ReturnType<typeof atomicSaveSessionWithTemplate>>;
    try {
      r = await atomicSaveSessionWithTemplate({
        session: withEx,
        guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
        template: tpl,
        templateExpectedRevision: null,
      });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect(aborts).toBeGreaterThan(0);
    expect(r.ok).toBe(false);
    expect((await getSession(withEx.id))!.revision).toBe(1);
    expect(await listExerciseTemplates()).toHaveLength(0);
  });
});

describe('P02 重复意图 / 保存失败重试 / 迟到回调', () => {
  it('连点确认：第二次同期望版本被拒绝，不会重复追加', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW);

    const first = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: tpl,
      templateExpectedRevision: null,
    });
    expect(first.ok).toBe(true);

    const second = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: tpl,
      templateExpectedRevision: null,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('version-conflict');
    expect((await getSession(withEx.id))!.exercises).toHaveLength(2);
    expect((await listExerciseTemplates())[0].revision).toBe(1);
  });

  it('模板 expected revision 冲突 → 整体失败；之后用正确 revision 重试只追加一次', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    // 预先存在 rev1 记忆 → 首次创建（null）冲突
    await putExerciseTemplate(extractExerciseTemplate(ex, 1, NOW), null);

    const conflict = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: extractExerciseTemplate(ex, 1, NOW + 1),
      templateExpectedRevision: null,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.reason).toBe('version-conflict');
    expect((await getSession(withEx.id))!.revision).toBe(1);
    expect((await listExerciseTemplates())[0].revision).toBe(1);

    const retried = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: extractExerciseTemplate(ex, 2, NOW + 2),
      templateExpectedRevision: 1,
    });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.template?.revision).toBe(2);
    expect((await getSession(withEx.id))!.exercises).toHaveLength(2);
  });

  it('迟到回调：旧 expectedRevision 不覆盖新数据', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const ok = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: extractExerciseTemplate(ex, 1, NOW),
      templateExpectedRevision: null,
    });
    expect(ok.ok).toBe(true);

    const stale = await atomicSaveSessionWithTemplate({
      session: { ...withEx, note: '迟到的旧编辑' },
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: extractExerciseTemplate(ex, 1, NOW),
      templateExpectedRevision: null,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('version-conflict');
    expect((await getSession(withEx.id))!.note).toBe('');
  });
});

describe('P03 锁 / revision / 终态', () => {
  it('非持锁者写入被拒绝，不覆盖任何数据', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];
    const r = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId: 'editor-B', expectedVersion: 1 },
      template: extractExerciseTemplate(ex, 1, NOW),
      templateExpectedRevision: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['lock-lost', 'no-lock']).toContain(r.reason);
    expect((await getSession(withEx.id))!.revision).toBe(1);
  });

  it('revision 冲突与终态后旧编辑均明确失败', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];

    const stale = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 0 },
      template: extractExerciseTemplate(ex, 1, NOW),
      templateExpectedRevision: null,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toBe('version-conflict');

    const finish = await atomicFinishSession({
      session: { ...withEx, endedAt: NOW + 1000 },
      guard: { editorId, advanceCycle: false },
    });
    expect(finish.ok).toBe(true);

    const afterTerminal = await atomicSaveSessionWithTemplate({
      session: withEx,
      guard: { sessionId: withEx.id, editorId, expectedVersion: 2 },
      template: extractExerciseTemplate(ex, 1, NOW),
      templateExpectedRevision: null,
    });
    expect(afterTerminal.ok).toBe(false);
    if (!afterTerminal.ok) expect(afterTerminal.reason).toBe('state-conflict');
  });

  it('G1-PRE-REVIEW #3 原子入口拒绝非法模板（空名称/错误 key），session/meta 不变', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const good = extractExerciseTemplate(ex, 1, NOW);

    for (const bad of [{ ...good, name: '' }, { ...good, key: 'wrong-meta-key' }]) {
      const r = await atomicSaveSessionWithTemplate({
        session: withEx,
        guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
        template: bad,
        templateExpectedRevision: null,
      });
      expect(r.ok).toBe(false);
      expect((await getSession(withEx.id))!.revision).toBe(1);
      expect((await getSession(withEx.id))!.exercises).toHaveLength(1);
      expect(await listExerciseTemplates()).toHaveLength(0);
    }
  });
});

describe('G1-PRE-REVIEW #5 模板不可信输入边界', () => {
  function staticTpl(over: Partial<ExerciseTemplate> = {}): ExerciseTemplate {
    return {
      key: exerciseTemplateKey('lib-barbell-bench'),
      schemaVersion: 1,
      exerciseId: 'lib-barbell-bench',
      name: '自由杠铃卧推',
      target: straightTarget(),
      restSec: 120,
      revision: 1,
      updatedAt: NOW,
      ...over,
    };
  }
  const multi = {
    kind: 'dropSet',
    rounds: 2,
    stages: [
      { id: 'a', label: 'A', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
      { id: 'b', label: 'B', weightKg: 5, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
    ],
    restInSec: 20,
    restAfterSec: 120,
    weightMode: 'external',
  };

  const cases: Array<[string, unknown]> = [
    ['unknown kind', { ...staticTpl(), target: { kind: 'alien' } }],
    ['stages 非数组', { ...staticTpl(), target: { ...multi, stages: 'nope' } }],
    ['label 数字', { ...staticTpl(), target: { ...multi, stages: [{ id: 'a', label: 123, weightKg: 10, toFailure: false }, multi.stages[1]] } }],
    ['perSetConfigs 非数组', { ...staticTpl(), target: { ...straightTarget(), perSetConfigs: 'nope' } }],
    ['weightMode 非枚举', { ...staticTpl(), target: { ...straightTarget(), weightMode: 'magic' } }],
    ['嵌套 actual 运行态', { ...staticTpl(), target: { ...straightTarget(), actual: { reps: 10 } } }],
    ['name 超 200', { ...staticTpl(), name: 'A'.repeat(201) }],
    ['错误 key 前缀', { ...staticTpl(), key: 'other-meta-key' }],
    ['target 非对象', { ...staticTpl(), target: 'nope' }],
  ];

  it.each(cases)('%s：返回 issues 而不是 throw，也不接受', (_label, raw) => {
    let parsed: ReturnType<typeof validateExerciseTemplate> | null = null;
    expect(() => {
      parsed = validateExerciseTemplate(raw);
    }).not.toThrow();
    expect(parsed!.ok).toBe(false);
  });

  it('合法模板仍接受（对照组）', () => {
    expect(validateExerciseTemplate(staticTpl()).ok).toBe(true);
  });
});

describe('G1-FIX1 模板身份长度与安全 revision 边界', () => {
  function tplWith(over: Partial<ExerciseTemplate> = {}): ExerciseTemplate {
    return {
      key: exerciseTemplateKey('custom:bound'),
      schemaVersion: 1,
      exerciseId: 'custom:bound',
      name: '边界动作',
      target: straightTarget(),
      restSec: 90,
      revision: 1,
      updatedAt: NOW,
      ...over,
    };
  }

  it('exerciseId 最多 160（与 Session 主数据一致）：160 接受、161 拒绝', () => {
    const ok = tplWith({ exerciseId: 'x'.repeat(160), key: exerciseTemplateKey('x'.repeat(160)) });
    expect(validateExerciseTemplate(ok).ok).toBe(true);
    const bad = tplWith({ exerciseId: 'x'.repeat(161), key: exerciseTemplateKey('x'.repeat(161)) });
    const parsedBad = validateExerciseTemplate(bad);
    expect(parsedBad.ok).toBe(false);
    if (!parsedBad.ok) {
      expect(parsedBad.issues.some((i) => i.path === 'exerciseId')).toBe(true);
    }
  });

  it('revision 必须是正的 safe integer：MAX_SAFE_INTEGER 接受、MAX_SAFE_INTEGER+1 拒绝', () => {
    expect(validateExerciseTemplate(tplWith({ revision: Number.MAX_SAFE_INTEGER })).ok).toBe(true);
    expect(validateExerciseTemplate(tplWith({ revision: Number.MAX_SAFE_INTEGER + 1 })).ok).toBe(false);
    expect(validateExerciseTemplate(tplWith({ revision: 0 })).ok).toBe(false);
    expect(validateExerciseTemplate(tplWith({ revision: 1.5 })).ok).toBe(false);
  });

  it('独立 put：expectedRevision=MAX_SAFE_INTEGER 无法安全递增时明确拒绝，原模板不变', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];
    const tpl = extractExerciseTemplate(ex, 1, NOW);
    await idbPut('meta', { key: tpl.key, value: { ...tpl, revision: Number.MAX_SAFE_INTEGER } });

    const r = await putExerciseTemplate({ ...tpl, revision: 1 }, Number.MAX_SAFE_INTEGER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('安全整数上限');
    const rows = await listExerciseTemplates();
    expect(rows.find((x) => x.exerciseId === tpl.exerciseId)?.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('成对原子保存：模板 revision 溢出时整个事务失败，Session/revision/meta 均不变', async () => {
    const { session, editorId } = await seedActiveSession();
    const { session: withEx, exId } = addOneExercise(session);
    const ex = withEx.exercises.find((e) => e.id === exId)!;
    const tpl = extractExerciseTemplate(ex, 1, NOW);
    await idbPut('meta', { key: tpl.key, value: { ...tpl, revision: Number.MAX_SAFE_INTEGER } });

    const beforeSession = await getSession(withEx.id);
    const r = await atomicSaveSessionWithTemplate({
      session: { ...withEx, note: '不应写入' },
      guard: { sessionId: withEx.id, editorId, expectedVersion: 1 },
      template: tpl,
      templateExpectedRevision: Number.MAX_SAFE_INTEGER,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('version-conflict');
    const afterSession = await getSession(withEx.id);
    expect(afterSession?.note).toBe(beforeSession?.note);
    expect(afterSession?.revision).toBe(beforeSession?.revision);
    expect((await listExerciseTemplates()).find((x) => x.exerciseId === tpl.exerciseId)?.revision).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});

describe('模板仓库边界', () => {
  it('坏模板行明确报出，不被静默丢弃', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];
    const tpl = extractExerciseTemplate(ex, 1, NOW);
    await putExerciseTemplate(tpl, null);

    // 直接污染 meta：模拟磁盘/旧版本产生的坏模板
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('motion-training');
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction('meta', 'readwrite');
          t.objectStore('meta').put({ key: exerciseTemplateKey('bad'), value: { nonsense: true } });
          t.oncomplete = () => resolve();
          t.onerror = () => reject(t.error);
        };
        req.onerror = () => reject(req.error);
      });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    const snap = await readExerciseTemplates();
    expect(snap.invalid.some((x) => x.key === exerciseTemplateKey('bad'))).toBe(true);
    const parsed = validateExerciseTemplate({ nonsense: true });
    expect(parsed.ok).toBe(false);
  });

  it('模板仓库保留 null / 0 语义（阶段参考次数未设置 vs 明确 0、重量 0、间歇 0）', async () => {
    const { session } = await seedActiveSession();
    const tpl: ExerciseTemplate = {
      key: exerciseTemplateKey('lib-custom-multi'),
      schemaVersion: 1,
      exerciseId: 'lib-custom-multi',
      name: '多阶段动作',
      target: {
        kind: 'dropSet',
        form: 'superset',
        rounds: 2,
        stages: [
          { id: 'a', label: 'A', weightKg: 0, repsMin: null, repsMax: null, toFailure: true, restAfterSec: 0, targetText: '' },
          { id: 'b', label: 'B', weightKg: 10, repsMin: 0, repsMax: 0, toFailure: false, restAfterSec: 5, targetText: '' },
        ],
        restInSec: 0,
        restAfterSec: 0,
        weightMode: 'external',
      },
      restSec: 0,
      revision: 1,
      updatedAt: NOW,
    };
    const put = await putExerciseTemplate(tpl, null);
    expect(put.ok).toBe(true);
    const got = (await listExerciseTemplates()).find((x) => x.exerciseId === 'lib-custom-multi')!;
    if (got.target.kind !== 'dropSet') throw new Error('expected dropSet');
    expect(got.target.stages[0].repsMin).toBeNull();
    expect(got.target.stages[0].weightKg).toBe(0);
    expect(got.target.stages[0].restAfterSec).toBe(0);
    expect(got.target.stages[1].repsMin).toBe(0);
    expect(got.target.stages[1].repsMax).toBe(0);
    expect(session.id).toBeTruthy();
  });

  it('删除带 expected revision 的模板：revision 不符不删除', async () => {
    const { session } = await seedActiveSession();
    const { session: withEx } = addOneExercise(session);
    const ex = withEx.exercises[0];
    await putExerciseTemplate(extractExerciseTemplate(ex, 1, NOW), null);
    const wrong = await deleteExerciseTemplate(ex.exerciseId, 2);
    expect(wrong.ok).toBe(false);
    expect(await listExerciseTemplates()).toHaveLength(1);
    const okDel = await deleteExerciseTemplate(ex.exerciseId, 1);
    expect(okDel.ok).toBe(true);
    expect(await listExerciseTemplates()).toHaveLength(0);
  });
});

// 让 TypeScript 知道 ExerciseTarget 在本文件被使用（模板 target 类型断言场景）
const _typeProbe: ExerciseTarget['kind'] = 'straight';
void _typeProbe;
