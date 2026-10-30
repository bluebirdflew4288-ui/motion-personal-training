/* Functional R2 回归：旧长计划名称的**有限 reader 兼容**（Plan.name / Session.planName）。
 *
 * 契约（LEGACY-NAME-COMPATIBILITY-PROPOSAL + 用户 r2 返工）：
 *   · 新建/重命名/savePlan/模板新输入仍 200（MAX_PLAN_NAME），本文件不改写这些路径；
 *   · 仅受支持的全量备份（含恢复前快照）对上面两个显示名称字段接受 ≤MAX_LEGACY_PLAN_NAME（=MAX_TEXT=2000），
 *     按原文完整保留，不截断、不改写；普通名称不产生 legacy 警告；
 *   · 2001 或错类型仍拒绝；其它字段/版本约束不变；
 *   · 旧计划已产生历史、以及恢复前 snapshot 均能 export→validate→restore 原文往返。
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildBackup,
  listPlans,
  listSessions,
  restoreBackup,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import { createV32Plan } from '../src/domain/presets/v32';
import { createSession } from '../src/domain/session';
import { MAX_LEGACY_PLAN_NAME, MAX_PLAN_NAME, MAX_TEXT } from '../src/domain/limits';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;
const longName = (n: number) => '计'.repeat(n);

async function wipe() {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}

beforeEach(async () => {
  await wipe();
});

function makePlan(name: string, id: string): Plan {
  return { ...createV32Plan(NOW), id, name };
}

function makeSession(plan: Plan, planName: string, id: string): Session {
  const day = plan.days[0];
  const s = createSession(plan, day, NOW);
  s.id = id;
  s.planId = plan.id;
  s.planName = planName;
  s.status = 'completed';
  s.endedAt = NOW + 60_000;
  return s;
}

async function seed(planNameLen: number, sessionNameLen?: number) {
  const plan = makePlan(longName(planNameLen), 'legacy-plan');
  await idbPut('plans', plan);
  let session: Session | undefined;
  if (sessionNameLen !== undefined) {
    session = makeSession(plan, longName(sessionNameLen), 'legacy-session');
    await idbPut('sessions', session);
  }
  return { plan, session };
}

describe('R2 · 旧长名称有限 reader 兼容', () => {
  it('常量边界：MAX_PLAN_NAME=200、MAX_LEGACY_PLAN_NAME=MAX_TEXT=2000', () => {
    expect(MAX_PLAN_NAME).toBe(200);
    expect(MAX_TEXT).toBe(2000);
    expect(MAX_LEGACY_PLAN_NAME).toBe(MAX_TEXT);
  });

  it('普通名称（≤200）不产生 legacy 警告', async () => {
    await seed(120);
    const v = validateBackup(await buildBackup('0.1.7'));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.warnings.some((w) => w.includes('旧计划名称') || w.includes('历史记录的计划名称'))).toBe(false);
    }
  });

  for (const len of [203, 1000, 2000]) {
    it(`Plan.name ${len} 字：export→validate→restore 原文往返`, async () => {
      const { plan } = await seed(len);
      const payload = await buildBackup('0.1.7');

      // 导出前置校验：接受且原文保留，并给出 legacy 警告
      const v = validateBackup(payload);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.payload.data.plans[0].name).toBe(longName(len));
      expect(v.warnings.some((w) => w.includes('旧计划名称'))).toBe(true);

      // 恢复后原文一致
      await wipe();
      await restoreBackup(payload);
      const restored = (await listPlans())[0];
      expect(restored.name).toBe(longName(len));
      expect(restored.id).toBe(plan.id);

      // 再导出仍可校验（幂等）
      expect(validateBackup(await buildBackup('0.1.7')).ok).toBe(true);
    });

    it(`Session.planName ${len} 字：export→validate→restore 原文往返`, async () => {
      const { session } = await seed(120, len);
      const payload = await buildBackup('0.1.7');

      const v = validateBackup(payload);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.payload.data.sessions[0].planName).toBe(longName(len));
      expect(v.warnings.some((w) => w.includes('历史记录的计划名称'))).toBe(true);

      await wipe();
      await restoreBackup(payload);
      const restored = (await listSessions())[0];
      expect(restored.planName).toBe(longName(len));
      expect(restored.id).toBe(session!.id);
    });
  }

  it('Plan.name 2001 / Session.planName 2001：仍拒绝（超过有限兼容上限）', async () => {
    await seed(2001);
    const v1 = validateBackup(await buildBackup('0.1.7'));
    expect(v1.ok).toBe(false);
    if (!v1.ok) expect(v1.error).toContain(String(MAX_LEGACY_PLAN_NAME));

    await wipe();
    await seed(120, 2001);
    const v2 = validateBackup(await buildBackup('0.1.7'));
    expect(v2.ok).toBe(false);
  });

  it('错类型名称仍拒绝（Plan.name 非字符串 / Session.planName 非字符串）', async () => {
    const plan = { ...makePlan('ok', 'bad-plan'), name: 123 as unknown as string };
    await idbPut('plans', plan);
    expect(validateBackup(await buildBackup('0.1.7')).ok).toBe(false);

    await wipe();
    const p = makePlan('普通计划', 'p2');
    await idbPut('plans', p);
    const s = makeSession(p, 'x', 'bad-sess');
    (s as unknown as { planName: unknown }).planName = 456;
    await idbPut('sessions', s);
    expect(validateBackup(await buildBackup('0.1.7')).ok).toBe(false);
  });

  it('旧长计划 + 历史：只把当前计划改名，备份仍有效并恢复历史原文（R1 失败场景转正）', async () => {
    const { plan, session } = await seed(203, 203);

    // 用户按提示把**当前计划**改名到 200 内（历史快照不改写）
    const renamed: Plan = { ...plan, name: longName(MAX_PLAN_NAME) };
    await savePlan(renamed);

    const payload = await buildBackup('0.1.7');
    const v = validateBackup(payload);
    // 关键：历史 Session.planName 仍是 203，不再导致整份备份被拒
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.payload.data.sessions[0].planName).toBe(longName(203));
    expect(v.payload.data.plans[0].name).toBe(longName(MAX_PLAN_NAME));

    // 恢复后历史原文保留，当前计划为新短名
    await wipe();
    await restoreBackup(payload);
    expect((await listPlans())[0].name).toBe(longName(MAX_PLAN_NAME));
    expect((await listSessions())[0].planName).toBe(longName(203));
    expect(session).toBeTruthy();
  });

  it('恢复前快照：export（validate）不改当前数据；用快照回退后原文精确还原', async () => {
    // 1) 构造一份含 203 旧计划/历史的「恢复前快照」内容
    await seed(203, 203);
    const snapshot = await buildBackup('0.1.7');

    // 2) 改动当前数据为另一份合法数据（模拟用户之后的操作）
    await wipe();
    const other = makePlan('新的短计划', 'new-plan');
    await idbPut('plans', other);

    // 3) 导出快照前：validateBackup 是纯函数，不改当前数据
    const v = validateBackup(snapshot);
    expect(v.ok).toBe(true);
    expect((await listPlans())[0].name).toBe('新的短计划');
    if (v.ok) {
      expect(v.payload.data.plans[0].name).toBe(longName(203));
      expect(v.payload.data.sessions[0].planName).toBe(longName(203));
      expect(v.warnings.some((w) => w.includes('旧计划名称'))).toBe(true);
      expect(v.warnings.some((w) => w.includes('历史记录的计划名称'))).toBe(true);
    }

    // 4) 用快照回退 → 原文精确还原
    await restoreBackup(snapshot);
    expect((await listPlans())[0].name).toBe(longName(203));
    expect((await listSessions())[0].planName).toBe(longName(203));

    // 5) 回退后再导出仍可校验
    expect(validateBackup(await buildBackup('0.1.7')).ok).toBe(true);
  });
});
