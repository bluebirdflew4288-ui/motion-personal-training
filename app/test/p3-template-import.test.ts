/* 第3阶段 · 固定 JSON 计划模板导入：真实链测试。
   全走生产代码：parsePlanTemplate → atomicInsertPlan → repo/validate →
   createSession（力量/有氧快照）→ buildBackup/restoreBackup 往返。
   不镜像、不 mock 生产入口。 */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbPut, idbPutMany } from '../src/db/idb';
import { atomicInsertPlan } from '../src/db/tx';
import {
  buildBackup,
  getPlan,
  listPlans,
  loadSettings,
  restoreBackup,
  savePlan,
  saveSettings,
  validateBackup,
} from '../src/db/repo';
import { createSession } from '../src/domain/session';
import { sessionKindOf } from '../src/domain/sessionKind';
import type { StraightTarget } from '../src/domain/types';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  buildPreview,
  parsePlanTemplate,
  PLAN_TEMPLATE_FORMAT,
} from '../src/domain/planTemplate';
import { EXAMPLE_PLAN_TEMPLATE } from '../src/domain/planTemplateExample';
import { MAX_DAYS, MAX_PLANS, MAX_STAGES } from '../src/domain/limits';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_770_000_000_000;
const FIXTURE_FILE = fileURLToPath(new URL('./fixtures/plan-template-v1.example.json', import.meta.url));

beforeEach(async () => {
  __resetDbHandle();
  await idbClear('sessions');
  await idbClear('plans');
  await idbClear('meta');
  await idbClear('settings');
});

/* ── 1. 示例：文件与内嵌一致，都能严格解析 ── */
describe('示例模板一致性', () => {
  it('fixtures 文件与内嵌 EXAMPLE_PLAN_TEMPLATE 逐字节一致', () => {
    expect(readFileSync(FIXTURE_FILE, 'utf8').replace(/\n$/, '')).toBe(EXAMPLE_PLAN_TEMPLATE);
  });

  it('示例解析通过，覆盖三种日类型与两有氧预设', () => {
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW);
    expect(r.ok, r.ok ? '' : JSON.stringify((r as { issues: unknown[] }).issues)).toBe(true);
    if (!r.ok) return;
    const kinds = r.plan.days.map((d) => d.kind);
    expect(kinds).toEqual(['train', 'cardio', 'train', 'cardio', 'rest']);
    const p = buildPreview(r.plan);
    expect(p.trainDays).toBe(2);
    expect(p.cardioDays).toBe(2);
    expect(p.restDays).toBe(1);
    // 预览文案里含两预设参数（说明/示例/解析器一致）
    const cardioLines = p.days.flatMap((d) => d.cardioLines).join(' | ');
    expect(cardioLines).toContain('5.5 km/h');
    expect(cardioLines).toContain('坡度 12%');
    expect(cardioLines).toContain('档位 8');
  });
});

/* ── 2. 严格拒绝清单（错误位置可理解，不静默猜测/截断）── */
function parse(text: unknown) {
  return parsePlanTemplate(typeof text === 'string' ? text : JSON.stringify(text), NOW);
}
function wrap(plan: unknown): Record<string, unknown> {
  return { format: PLAN_TEMPLATE_FORMAT, version: 1, plan };
}
const trainDay = (over: Record<string, unknown> = {}) => ({
  name: '胸 A',
  kind: 'train',
  focus: 'chest',
  round: 'A',
  warmups: [],
  exercises: [
    {
      name: '双杠臂屈伸',
      restSec: 120,
      target: { kind: 'straight', sets: 4, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: null },
    },
  ],
  ...over,
});

describe('严格拒绝', () => {
  it('备份误投 → 指路到恢复入口', () => {
    const r = parse({ format: 'motion-training-backup', version: 2, data: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('全量备份');
  });

  it('未来版本 → 明确拒绝', () => {
    const r = parse(wrap({ name: 'X', days: [trainDay()], version: 99, __v: 99 }));
    expect(r.ok).toBe(false);
    const r2 = parse({ format: PLAN_TEMPLATE_FORMAT, version: 2, plan: { name: 'X', days: [trainDay()] } });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.issues.some((i) => i.path === 'version' && i.message.includes('高于'))).toBe(true);
  });

  it('未知字段带位置拒绝', () => {
    const r = parse(wrap({ name: 'X', days: [trainDay({ extra: 1 })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.path === 'plan.days[0].extra')).toBe(true);
  });

  it('身份/时间/cursor/segments 等存储字段拒绝且区分原因', () => {
    const r = parse(wrap({ name: 'X', cursor: 3, days: [trainDay({ id: 'day-x', createdAt: 1 })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.path === 'plan.cursor' && i.message.includes('存储字段'))).toBe(true);
    expect(r.issues.some((i) => i.path === 'plan.days[0].id' && i.message.includes('存储字段'))).toBe(true);
  });

  it('有氧 entry 里实际计时 segments/elapsedMs 拒绝', () => {
    const day = {
      name: '有氧',
      kind: 'cardio',
      cardio: [{ preset: 'stair-climber', name: '爬楼', target: { level: 5, segments: [], elapsedMs: 100 } }],
    };
    const r = parse(wrap({ name: 'X', days: [day] }));
    expect(r.ok).toBe(false);
  });

  it('类型不适用字段：休息日带 cardio / 有氧日带 focus+exercises / 力量日带 restNote', () => {
    for (const d of [
      { name: '休息', kind: 'rest', cardio: [] },
      { name: '有氧', kind: 'cardio', focus: 'chest', cardio: [{ preset: 'stair-climber', name: '爬楼', target: { level: 5 } }], exercises: [trainDay().exercises[0]] },
      trainDay({ restNote: '不该出现' }),
    ]) {
      const r = parse(wrap({ name: 'X', days: [d] }));
      expect(r.ok, JSON.stringify(d)).toBe(false);
    }
  });

  it('错误单位：字符串数字、非整数次数/档位、0.15 速度、超上限', () => {
    const cases: unknown[] = [
      wrap({ name: 'X', days: [{ ...trainDay(), exercises: [{ name: 'a', restSec: '120', target: trainDay().exercises[0].target }] }] }),
      wrap({ name: 'X', days: [{ ...trainDay(), exercises: [{ name: 'a', restSec: 120, target: { kind: 'straight', sets: 4, repsMin: 8.5, repsMax: 12, weightMode: 'external', suggestedWeightKg: null } }] }] }),
      wrap({ name: 'X', days: [{ name: '有氧', kind: 'cardio', cardio: [{ preset: 'stair-climber', name: '爬楼', target: { level: 5.5 } }] }] }),
      wrap({ name: 'X', days: [{ name: '有氧', kind: 'cardio', cardio: [{ preset: 'treadmill-incline', name: '坡走', target: { speedKmh: 0.15, inclinePct: 12 } }] }] }),
      wrap({ name: 'X', days: [{ ...trainDay(), exercises: [{ name: 'a', restSec: 4000, target: trainDay().exercises[0].target }] }] }),
    ];
    for (const c of cases) {
      const r = parse(c);
      expect(r.ok, JSON.stringify(c)).toBe(false);
    }
  });

  it('递减阶段 2–6 是模板能力：7 阶段拒绝（12 阶段旧备份容忍不外溢）', () => {
    const stages = Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ weightKg: 40 - i * 5, repsMin: 8, repsMax: 10, toFailure: false }));
    const ex = { name: '夹胸', restSec: 90, target: { kind: 'dropSet', rounds: 2, stages, restInSec: 20, restAfterSec: 120, weightMode: 'external' } };
    const r = parse(wrap({ name: 'X', days: [trainDay({ exercises: [ex] })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.message.includes('编辑器能力') || i.message.includes('2–6'))).toBe(true);
  });

  it('超限与非法结构：空 days / 61 日 / 反向次数 / setsMax<sets / 无 plan', () => {
    expect(parse(wrap({ name: 'X', days: [] })).ok).toBe(false);
    const manyDays = Array.from({ length: MAX_DAYS + 1 }, (_, i) => ({ ...trainDay(), name: `日${i}` }));
    const rDays = parse(wrap({ name: 'X', days: manyDays }));
    expect(rDays.ok).toBe(false);
    const rRange = parse(wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'a', restSec: 60, target: { kind: 'straight', sets: 3, repsMin: 12, repsMax: 8, weightMode: 'external', suggestedWeightKg: null } }] })] }));
    expect(rRange.ok).toBe(false);
    expect(parse(wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'a', restSec: 60, target: { kind: 'straight', sets: 5, setsMax: 3, repsMin: 1, repsMax: 8, weightMode: 'external', suggestedWeightKg: null } }] })] })).ok).toBe(false);
    expect(parse({ format: PLAN_TEMPLATE_FORMAT, version: 1 }).ok).toBe(false);
  });

  it('非法 JSON 明确报错并保留原文（调用方文本不被吞）', () => {
    const r = parse('{"format": "motion-plan-template", version=1,}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].path).toBe('(文件)');
    expect(r.issues[0].message).toContain('不是有效的 JSON');
  });

  it('建议重量 0 是实际值（不被当"没填"），null 才是未填', () => {
    const zero = parse(wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'a', restSec: 60, target: { kind: 'straight', sets: 3, repsMin: 5, repsMax: 5, weightMode: 'external', suggestedWeightKg: 0 } }] })] }));
    expect(zero.ok).toBe(true);
    if (zero.ok) expect(JSON.stringify(zero.plan.days[0].exercises[0].target)).toContain('"suggestedWeightKg":0');
    const nulled = parse(wrap({ name: 'X', days: [trainDay()] }));
    expect(nulled.ok).toBe(true);
  });
});

/* ── 3. 本地身份/时间/cursor=0 + insert-only ── */
describe('确认后写入：本地身份与保真', () => {
  it('App 生成本地 ID/时间，exerciseId 走既有身份解析，cursor=0；重读逐字段保真', async () => {
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plan = r.plan;
    expect(plan.id.startsWith('plan-')).toBe(true);
    expect(plan.cursor).toBe(0);
    expect(plan.createdAt).toBe(NOW);
    // 所有嵌套条目都有 ID
    for (const d of plan.days) {
      expect(d.id).toBeTruthy();
      for (const e of d.exercises) {
        expect(e.id).toBeTruthy();
        // 预设动作 → 稳定预设身份（既有映射表）
        expect(e.exerciseId).toBe(
          {
            双杠臂屈伸: 'lib-chest-dip',
            蝴蝶机夹胸: 'lib-pec-deck',
            正手宽握引体向上: 'lib-pull-up',
            分体悍马划船: 'lib-hammer-row',
          }[e.name] ?? `custom:${e.name}`,
        );
      }
    }
    const ins = await atomicInsertPlan(plan);
    expect(ins.ok).toBe(true);
    const back = await getPlan(plan.id);
    expect(back).toBeDefined();
    if (!back) return;
    // 逐字段重读保真（结构、目标、参数、备注）
    expect(back.days.length).toBe(plan.days.length);
    expect(JSON.parse(JSON.stringify({ ...back, updatedAt: 0, createdAt: 0 }))).toEqual(
      JSON.parse(JSON.stringify({ ...plan, updatedAt: 0, createdAt: 0 })),
    );
  });

  it('atomicInsertPlan 不覆盖同 id 旧计划（insert-only 硬边界）', async () => {
    const existing = createV32Plan(NOW);
    await idbPut('plans', existing);
    const r = await atomicInsertPlan({ ...existing, name: '被替换?' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('duplicate-id');
    const after = await getPlan(existing.id);
    expect(after!.name).toBe(existing.name); // 旧数据没有被覆盖
  });

  it('同名默认拒绝，明确 allowDuplicateName 才新增独立一份（不合并）', async () => {
    const a = createV32Plan(NOW);
    await savePlan({ ...a, name: '同名计划', id: 'plan-old' });
    const r1 = parsePlanTemplate(
      EXAMPLE_PLAN_TEMPLATE.replace('示例：四日循环（力量+有氧+休息）', '同名计划'),
      NOW + 1,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const d1 = await atomicInsertPlan(r1.plan);
    expect(d1.ok).toBe(false);
    if (d1.ok) return;
    expect(d1.reason).toBe('duplicate-name');
    const d2 = await atomicInsertPlan(r1.plan, { allowDuplicateName: true });
    expect(d2.ok).toBe(true);
    const list = await listPlans();
    expect(list.filter((p) => p.name === '同名计划').length).toBe(2);
    expect(list.find((p) => p.id === 'plan-old')).toBeDefined(); // 旧的那份原样
  });

  it('容量与并发：满 MAX_PLANS 拒绝；两并发同名同内容也只会有一份成功路径', async () => {
    const filler: Plan[] = Array.from({ length: MAX_PLANS }, (_, i) => ({
      ...createV32Plan(NOW),
      id: `fill-${i}`,
      name: `F${i}`,
    }));
    await idbPutMany('plans', filler);
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW + 5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cap = await atomicInsertPlan(r.plan);
    expect(cap.ok).toBe(false);
    if (cap.ok) return;
    expect(cap.reason).toBe('capacity');
    expect(await listPlans()).toHaveLength(MAX_PLANS); // 没有半份
  });

  it('并发双 insert：第二条被身份/容量门禁挡住，不建双份', async () => {
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [a, b] = await Promise.all([atomicInsertPlan(r.plan), atomicInsertPlan(r.plan)]);
    const okCount = [a, b].filter((x) => x.ok).length;
    expect(okCount).toBe(1);
    const list = await listPlans();
    expect(list.filter((p) => p.id === r.plan.id)).toHaveLength(1);
  });
});

/* ── 4. 预览/校验零写入；确认失败/abort 零残留 ── */
describe('零写入承诺', () => {
  it('校验+预览阶段什么都不写（含旧计划/历史/设置保持）', async () => {
    const old = createV32Plan(NOW);
    await savePlan(old);
    const sess: Session = { ...createSession(old, old.days[0], NOW), status: 'active' };
    await idbPut('sessions', sess);
    await saveSettings({ theme: 'dark' });

    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW + 9);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    buildPreview(r.plan); // 只读预览

    expect(await listPlans()).toHaveLength(1); // 只有旧计划
    expect((await getPlan(old.id))!.name).toBe(old.name);
    const active = await import('../src/db/repo').then((m) => m.findActiveSession());
    expect(active!.id).toBe(sess.id); // 进行中训练没被触碰
    expect((await loadSettings()).theme).toBe('dark');
  });

  it('非法输入 → 库里零新增', async () => {
    const before = await listPlans();
    const r = parse(wrap({ name: 'X', days: [trainDay({ kind: 'nope' })] }));
    expect(r.ok).toBe(false);
    const after = await listPlans();
    expect(after).toEqual(before);
  });

  it('事务 abort：提交被中止 → 返回失败且不落库', async () => {
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { openDb } = await import('../src/db/idb');
    const db = await openDb();
    const orig = db.transaction.bind(db);
    let fired = false;
    // 故障注入：只劫持 plans 的 readwrite 事务（模拟提交前 abort / 原生磁盘错），
    // 读事务与其它 store 不受影响
    db.transaction = ((names: string | string[], mode?: string) => {
      const t = (orig as (n: string | string[], m?: string) => IDBTransaction)(names, mode);
      const isPlansWrite = JSON.stringify(names) === '["plans"]' && mode === 'readwrite';
      if (!fired && isPlansWrite) {
        fired = true;
        queueMicrotask(() => {
          try {
            t.abort();
          } catch {
            /* 已结束 */
          }
        });
      }
      return t;
    }) as typeof db.transaction;
    const res = await atomicInsertPlan(r.plan);
    expect(res.ok).toBe(false);
    const list = await listPlans();
    expect(list.find((p) => p.id === r.plan.id)).toBeUndefined(); // 没有半份
    db.transaction = orig;
  });
});

/* ── 5. 导入后可编辑 + 生成正确快照 + 进入 v2 备份往返 ── */
describe('导入后的完整生命周期', () => {
  async function importedPlan(): Promise<Plan> {
    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW);
    if (!r.ok) throw new Error('example must parse');
    const ins = await atomicInsertPlan(r.plan);
    if (!ins.ok) throw new Error('insert must succeed');
    return ins.plan;
  }

  it('编辑器路径能继续编辑（走既有 upsert，不是模板路径）', async () => {
    const plan = await importedPlan();
    const edited: Plan = { ...plan, name: '改名后的导入计划', days: plan.days.map((d) => (d.kind === 'train' ? { ...d, round: 'B' } : d)) };
    const saved = await savePlan(edited);
    const back = await getPlan(plan.id);
    expect(back!.name).toBe('改名后的导入计划');
    expect(saved.days[0].round).toBe('B');
  });

  it('力量日/有氧日/休息日按类型生成正确快照', async () => {
    const plan = await importedPlan();
    const train = plan.days.find((d) => d.kind === 'train')!;
    const sTrain = createSession(plan, train, NOW + 1000);
    expect(sessionKindOf(sTrain)).toBe('strength');
    expect(sTrain.exercises.length).toBe(2);
    expect(sTrain.exercises[0].target.kind).toBe('straight');
    expect((sTrain.exercises[0].target as StraightTarget).sets).toBe(4);
    // 递减组：组=轮，行=轮×阶段
    const drop = sTrain.exercises[1];
    expect(drop.groups.length).toBe(2);
    expect(drop.groups[0].stageCount).toBe(3);
    expect(drop.sets.length).toBe(6);
    expect(sTrain.cardio).toEqual([]);

    const cardioDay = plan.days.find((d) => d.kind === 'cardio')!;
    const sCardio = createSession(plan, cardioDay, NOW + 2000);
    expect(sessionKindOf(sCardio)).toBe('cardio');
    expect(sCardio.exercises).toEqual([]);
    expect(sCardio.cardio!.length).toBe(1);
    const entry = sCardio.cardio![0];
    expect(entry.status).toBe('pending');
    expect(entry.currentParams).toEqual({ speedKmh: 5.5, inclinePct: 12 });
    expect(entry.target).toEqual({ speedKmh: 5.5, inclinePct: 12 });
    expect(entry.planCardioId).toBe(cardioDay.cardio![0].id);
    expect(entry.elapsedMs).toBe(0);
    expect(entry.segments).toEqual([]);
  });

  it('导入的新计划进入全量 v2 备份 → 校验 → 恢复 → 重读保真', async () => {
    const plan = await importedPlan();
    const bak = await buildBackup('2.0.0');
    expect(bak.version).toBe(2);
    const v = validateBackup(JSON.parse(JSON.stringify(bak)));
    expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
    if (!v.ok) return;
    await idbClear('plans');
    await restoreBackup(v.payload);
    const back = await getPlan(plan.id);
    expect(back).toBeDefined();
    if (!back) return;
    expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(plan)));
  });

  it('cursor=0 且与日历日期解耦（开始第一天，不是"今天的日期"）', async () => {
    const plan = await importedPlan();
    expect(plan.cursor).toBe(0);
    const s = createSession(plan, plan.days[0], NOW + 777);
    expect(s.day.dayId).toBe(plan.days[0].id);
    expect(s.cycleIndexAtStart).toBe(0);
  });
});

/* IMPLEMENT §验证：确认成功后**旧计划 / 历史 / 设置 / active 全部保持不变**。 */
describe('确认导入不触碰既有数据', () => {
  it('成功 insert 后旧计划、历史、进行中训练、设置逐字段原样', async () => {
    // 既有：一个旧计划 + 一条历史（completed）+ 一条 active + 一份设置
    const old = createV32Plan(NOW);
    await savePlan({ ...old, id: 'plan-old', name: '旧计划' });
    const hist = { ...createSession(old, old.days[0], NOW - 5000), status: 'completed', endedAt: NOW - 4000 } as Session;
    await idbPut('sessions', hist);
    const active = { ...createSession(old, old.days[0], NOW - 1000), status: 'active' } as Session;
    await idbPut('sessions', active);
    await saveSettings({ theme: 'dark', currentPlanId: 'plan-old' });
    const settingsBefore = await loadSettings();

    const r = parsePlanTemplate(EXAMPLE_PLAN_TEMPLATE, NOW + 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ins = await atomicInsertPlan(r.plan);
    expect(ins.ok).toBe(true);

    // 旧计划原样
    const oldAfter = await getPlan('plan-old');
    // savePlan 会盖 updatedAt=Date.now()（合法行为）；比较内容时把时间戳归零
    const norm = (x: Plan) => JSON.parse(JSON.stringify({ ...x, createdAt: 0, updatedAt: 0 }));
    expect(norm(oldAfter!)).toEqual(norm({ ...old, id: 'plan-old', name: '旧计划' }));
    // 历史不受影响
    const histAfter = await import('../src/db/repo').then((m) => m.getSession(hist.id));
    expect(histAfter!.status).toBe('completed');
    // active 仍是同一条、没被结束/清除
    const actAfter = await import('../src/db/repo').then((m) => m.findActiveSession());
    expect(actAfter!.id).toBe(active.id);
    expect(actAfter!.status).toBe('active');
    // 设置不变（currentPlanId 没被模板导入改掉）
    expect(await loadSettings()).toEqual(settingsBefore);
    // 新增的是一份独立计划，cursor=0
    expect((await listPlans()).length).toBe(2);
    expect((await getPlan(r.plan.id))!.cursor).toBe(0);
  });
});

/* ── G2（REVIEW-3）：非力量日按“键是否出现”拒绝，不静默丢弃 ── */
describe('G2 · 不适用键按出现拒绝', () => {
  const cardioDay = (over: Record<string, unknown> = {}) => ({
    name: '有氧',
    kind: 'cardio',
    cardio: [{ preset: 'stair-climber', name: '爬楼', target: { level: 5 } }],
    ...over,
  });
  it('rest + warmups 对象（含隐藏内容）→ 拒绝且带精确路径', () => {
    const r = parse(wrap({ name: 'X', days: [{ name: '休息', kind: 'rest', warmups: { id: 'illegal-hidden-warmup' } }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.path === 'plan.days[0].warmups')).toBe(true);
  });
  it('cardio + exercises 对象 + 合法 cardio 项 → 拒绝（不得重建为 []）', () => {
    const r = parse(wrap({ name: 'X', days: [cardioDay({ exercises: { id: 'illegal-hidden-exercise' } })] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.path === 'plan.days[0].exercises')).toBe(true);
  });
  it('rest + exercises:42 / 空数组 / 字符串 → 全部拒绝', () => {
    for (const bad of [42, [], '']) {
      const r = parse(wrap({ name: 'X', days: [{ name: '休息', kind: 'rest', exercises: bad }] }));
      expect(r.ok, `rest.exercises=${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it('cardio + warmups 空数组 / 对象 → 拒绝', () => {
    for (const bad of [[], { a: 1 }]) {
      const r = parse(wrap({ name: 'X', days: [cardioDay({ warmups: bad })] }));
      expect(r.ok, `cardio.warmups=${JSON.stringify(bad)}`).toBe(false);
    }
  });
  it('null 同样算“出现”（不静默通过）；但缺省（不写键）仍合法', () => {
    expect(parse(wrap({ name: 'X', days: [{ name: '休息', kind: 'rest', exercises: null }] })).ok).toBe(false);
    expect(parse(wrap({ name: 'X', days: [{ name: '休息', kind: 'rest' }] })).ok).toBe(true);
  });
  it('train 合法空数组仍可用；非法输入零写入', async () => {
    const before = await listPlans();
    const okEmpty = parse(wrap({ name: 'X', days: [trainDay({ warmups: [], exercises: [] })] }));
    expect(okEmpty.ok).toBe(true);
    const r = parse(wrap({ name: 'X', days: [{ name: '休息', kind: 'rest', exercises: [] }] }));
    expect(r.ok).toBe(false);
    expect(await listPlans()).toEqual(before);
  });
});

/* ── G3（REVIEW-3）：重量沿用编辑器精度、阶段间休息沿用 600 ── */
describe('G3 · 重量精度与递减休息上限', () => {
  it('合法小配重 1.25/0.75/2.5 原样保真（不再因 0.1 步长被拒）', () => {
    const exStraight = (w: number) => ({ name: 'a', restSec: 60, target: { kind: 'straight', sets: 3, repsMin: 5, repsMax: 8, weightMode: 'external', suggestedWeightKg: w } });
    for (const w of [1.25, 0.75, 2.5]) {
      const r = parse(wrap({ name: 'X', days: [trainDay({ exercises: [exStraight(w)] })] }));
      expect(r.ok, `suggested ${w}`).toBe(true);
      if (r.ok) expect((r.plan.days[0].exercises[0].target as StraightTarget).suggestedWeightKg).toBe(w);
    }
    const drop = { name: 'd', restSec: 60, target: { kind: 'dropSet', rounds: 2, stages: [{ weightKg: 1.25, repsMin: 5, repsMax: 8, toFailure: false }, { weightKg: 0.75, repsMin: 5, repsMax: 8, toFailure: false }], restInSec: 20, restAfterSec: 120, weightMode: 'external' } };
    const rd = parse(wrap({ name: 'X', days: [trainDay({ exercises: [drop] })] }));
    expect(rd.ok).toBe(true);
    if (rd.ok) {
      const t = rd.plan.days[0].exercises[0].target;
      expect(t.kind === 'dropSet' && t.stages.map((st) => st.weightKg)).toEqual([1.25, 0.75]);
    }
  });

  it('重量仍守范围与有限性（0–9999 / 阶段 0–999，字符串与 NaN 拒绝），但不设步长', () => {
    expect(parse(wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'a', restSec: 60, target: { kind: 'straight', sets: 3, repsMin: 5, repsMax: 8, weightMode: 'external', suggestedWeightKg: 10000 } }] })] })).ok).toBe(false);
    expect(parse(wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'a', restSec: 60, target: { kind: 'straight', sets: 3, repsMin: 5, repsMax: 8, weightMode: 'external', suggestedWeightKg: '1.25' } }] })] })).ok).toBe(false);
  });

  it('阶段间休息 600 接受 / 601 拒绝；轮间 restAfterSec 3600 仍可用', () => {
    const dropDay = (restIn: number, restAfter: number) =>
      wrap({ name: 'X', days: [trainDay({ exercises: [{ name: 'd', restSec: 60, target: { kind: 'dropSet', rounds: 2, stages: [{ weightKg: 20, repsMin: 5, repsMax: 8, toFailure: false }, { weightKg: 10, repsMin: 5, repsMax: 8, toFailure: false }], restInSec: restIn, restAfterSec: restAfter, weightMode: 'external' } }] })] });
    expect(parse(dropDay(600, 120)).ok).toBe(true);
    const bad = parse(dropDay(601, 120));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.some((i) => i.path.endsWith('restInSec'))).toBe(true);
    expect(parse(dropDay(20, 3600)).ok).toBe(true);
    expect(parse(dropDay(20, 3601)).ok).toBe(false);
  });

  it('速度/坡度 0.1、爬楼整数仍是审定规则（0.15 速度拒绝、5.5 档位拒绝）', () => {
    expect(parse(wrap({ name: 'X', days: [{ name: '有氧', kind: 'cardio', cardio: [{ preset: 'treadmill-incline', name: '坡走', target: { speedKmh: 0.15, inclinePct: 12 } }] }] })).ok).toBe(false);
    expect(parse(wrap({ name: 'X', days: [{ name: '有氧', kind: 'cardio', cardio: [{ preset: 'stair-climber', name: '爬楼', target: { level: 5.5 } }] }] })).ok).toBe(false);
  });
});
