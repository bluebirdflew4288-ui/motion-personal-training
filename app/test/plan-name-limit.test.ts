/* item 1 回归：计划名称 200 字约束在新建 / 重命名 / 复制 / 保存 / 导出全链共用。

   历史缺陷（审计 data-review）：
   · 200 字合法计划复制后变成 203 字 → buildBackup 成功但 validateBackup 拒绝整份文件；
   · 新建输入接受 201 字 → 同样导出即不可恢复。
   本用例断言：超限明确拒绝且原数据不变；复制为后缀预留长度；
   export → validate → restore 闭环可用；旧超限数据保留原样、不被截断。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildBackup,
  listPlans,
  restoreBackup,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import { __resetDbHandle, idbClear, idbPut } from '../src/db/idb';
import { createV32Plan } from '../src/domain/presets/v32';
import {
  clonePlan,
  isPlanNameWithinLimit,
  normalizePlanName,
  renamePlan,
} from '../src/domain/planEdit';
import { MAX_PLAN_NAME } from '../src/domain/limits';
import type { Plan } from '../src/domain/types';

const NOW = 1_760_000_000_000;
const longName = (n: number) => '计'.repeat(n);

async function wipe() {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}

beforeEach(async () => {
  await wipe();
});

function planNamed(name: string, id = 'p1'): Plan {
  const p = createV32Plan(NOW);
  return { ...p, id, name };
}

describe('item 1 · 计划名称长度约束', () => {
  it('MAX_PLAN_NAME 为 200，与备份校验一致', () => {
    expect(MAX_PLAN_NAME).toBe(200);
    expect(isPlanNameWithinLimit(longName(200))).toBe(true);
    expect(isPlanNameWithinLimit(longName(201))).toBe(false);
  });

  it('复制 200 字合法计划：为后缀预留长度，结果 ≤200 且可被备份恢复', () => {
    const source = planNamed(longName(200));
    const snapshot = JSON.stringify(source);
    const copy = clonePlan(source);
    expect(copy.name.length).toBeLessThanOrEqual(MAX_PLAN_NAME);
    expect(copy.name.endsWith(' 副本')).toBe(true);
    // 源计划字节未被修改（复制不改来源）
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it('重命名超限：明确拒绝（返回原计划，名称不变）；200 字正常保存', () => {
    const plan = planNamed(longName(200));
    expect(renamePlan(plan, longName(201))).toBe(plan);
    expect(normalizePlanName(plan, longName(201)).length).toBe(201);
    const ok = renamePlan(plan, longName(200));
    expect(ok.name.length).toBe(200);
  });

  it('保存入口拒绝 201 / 1000 字名称，原数据不变', async () => {
    await expect(savePlan(planNamed(longName(201), 'a201'))).rejects.toThrow();
    await expect(savePlan(planNamed(longName(1000), 'a1000'))).rejects.toThrow();
    expect(await listPlans()).toHaveLength(0);
  });

  it('export → validate → restore 闭环：复制产生的计划可完整恢复', async () => {
    const source = planNamed(longName(200), 'src');
    await savePlan(source);
    const copy = clonePlan(source, '副本');
    await savePlan(copy);
    expect(await listPlans()).toHaveLength(2);

    const payload = await buildBackup('0.1.7');
    const verdict = validateBackup(payload);
    expect(verdict.ok).toBe(true);

    // 清空后恢复，两个计划（含复制）都回来且名称未变
    await wipe();
    await restoreBackup(payload);
    const restored = await listPlans();
    expect(restored.map((p) => p.id).sort()).toEqual(['src', copy.id].sort());
    const restoredCopy = restored.find((p) => p.id === copy.id)!;
    expect(restoredCopy.name).toBe(copy.name);
  });

  it('旧超限数据（≤MAX_TEXT）：保留原样不截断；导出可通过并原文往返；>MAX_TEXT 仍拒绝', async () => {
    // 直接写库模拟历史遗留（绕过保存入口）
    const legacy = planNamed(longName(203), 'legacy');
    await idbPut('plans', { ...legacy, updatedAt: NOW });

    const stored = (await listPlans())[0];
    expect(stored.name.length).toBe(203);

    // R2 reader 兼容：203 字旧计划在受支持全量备份下接受（原文保留 + legacy 警告），不再拒绝整份文件
    const payload = await buildBackup('0.1.7');
    const verdict = validateBackup(payload);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.payload.data.plans[0].name).toBe(longName(203));
      expect(verdict.warnings.some((w) => w.includes('200'))).toBe(true);
    }

    // 改短当前计划仍然可用（继续编辑路径不变）；历史旧值不受影响
    await savePlan(renamePlan(stored, longName(200)));
    const fixed = (await listPlans())[0];
    expect(fixed.name.length).toBe(200);
    expect(validateBackup(await buildBackup('0.1.7')).ok).toBe(true);

    // 超过有限兼容上限（>MAX_TEXT）仍明确拒绝
    await idbClear('plans');
    await idbPut('plans', { ...planNamed(longName(2001), 'too-long'), updatedAt: NOW });
    const tooLong = validateBackup(await buildBackup('0.1.7'));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.error).toContain('2000');
  });
});
