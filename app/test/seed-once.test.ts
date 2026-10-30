/* item 5 回归：ensureSeed 只在**首次初始化**播种，之后尊重用户的空状态。

   历史缺陷（审计 data-review）：
   · 删除最后一个计划后，下次启动又注入三分化 V3.2；
   · 恢复合法空备份后，下次启动同样被重新播种。
   现在用 seeded 标记严格区分「从未初始化」与「用户主动清空」。 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DEFAULT_SETTINGS,
  deletePlan,
  ensureSeed,
  getMeta,
  listPlans,
  restoreBackup,
  savePlan,
  validateBackup,
} from '../src/db/repo';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { createV32Plan } from '../src/domain/presets/v32';
import type { BackupPayload } from '../src/db/repo';

const NOW = 1_760_000_000_000;

async function wipe() {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}

function emptyBackup(): BackupPayload {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: NOW,
    appVersion: '0.1.7',
    counts: { plans: 0, sessions: 0, activeSessions: 0 },
    data: { plans: [], sessions: [], settings: [DEFAULT_SETTINGS] },
  };
}

beforeEach(async () => {
  await wipe();
});

describe('item 5 · ensureSeed 只首次播种', () => {
  it('首次启动播种一次，重复启动不重复', async () => {
    expect(await ensureSeed()).toBe(true);
    expect(await listPlans()).toHaveLength(1);
    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(1);
  });

  it('删除最后一个计划后重启：保持为空（不再注入预设）', async () => {
    expect(await ensureSeed()).toBe(true);
    const [p] = await listPlans();
    await deletePlan(p.id);
    expect(await listPlans()).toHaveLength(0);

    // 模拟下一次启动
    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(0);
    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(0);
  });

  it('恢复合法空备份后重启：保持为空', async () => {
    expect(await ensureSeed()).toBe(true);
    const payload = emptyBackup();
    expect(validateBackup(payload).ok).toBe(true);
    await restoreBackup(payload);
    expect(await listPlans()).toHaveLength(0);

    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(0);
  });

  it('老库有旧计划但缺 seeded 标记：只补标记，不重复注入、不覆盖', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    expect(await getMeta('seeded')).toBeUndefined();

    expect(await ensureSeed()).toBe(true);
    const plans = await listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe(plan.id);
    expect(await getMeta('seeded')).toBe(true);
    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(1);
  });
});
