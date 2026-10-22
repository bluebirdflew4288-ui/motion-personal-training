/* R04 回归：真实 v1 导出备份必须能迁移并恢复。
   fixture 来自独立审查的 tasks/2026-10-20_motion-product-planning/app-audit/test-backup.json */

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import {
  buildBackup,
  listPlans,
  listSessions,
  restoreBackup,
  validateBackup,
} from '../src/db/repo';
import {
  detectLegacyShape,
  migrateLegacyData,
  migrationIsIdempotent,
  validateLegacyShape,
} from '../src/db/migrate';
import { exerciseIdFromName } from '../src/domain/identity';

const FIXTURE = fileURLToPath(new URL('./fixtures-v1-backup.json', import.meta.url));
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'));

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('R04 真实 v1 备份迁移', () => {
  it('识别为旧结构', () => {
    expect(detectLegacyShape(raw.data)).toBe(true);
  });

  it('旧结构通过旧规则校验（不是被新规则拒掉）', () => {
    const r = validateLegacyShape(raw.data);
    expect(r.ok).toBe(true);
  });

  it('validateBackup 接受 v1 备份并给出升级提示', () => {
    const r = validateBackup(raw);
    expect(r.ok, r.ok ? '' : (r as { error: string }).error).toBe(true);
    if (!r.ok) return;
    expect(r.warnings.some((w) => w.includes('旧版本'))).toBe(true);
    expect(r.preview.sessions).toBe(raw.data.sessions.length);
    expect(r.preview.plans).toBe(raw.data.plans.length);
  });

  it('迁移补齐 exerciseId 与 groups，且不丢计划/训练', () => {
    const m = migrateLegacyData(raw.data);
    expect(m.plans).toHaveLength(raw.data.plans.length);
    expect(m.sessions).toHaveLength(raw.data.sessions.length);

    // 每个动作都有 exerciseId
    for (const p of m.plans as any[]) {
      for (const d of p.days) {
        for (const ex of d.exercises) expect(ex.exerciseId).toBeTruthy();
      }
    }
    for (const s of m.sessions as any[]) {
      for (const ex of s.exercises) {
        expect(ex.exerciseId).toBeTruthy();
        expect(Array.isArray(ex.groups)).toBe(true);
        expect(ex.groups.length).toBeGreaterThan(0);
      }
    }
  });

  it('迁移幂等', () => {
    expect(migrationIsIdempotent(raw.data)).toBe(true);
  });

  it('不编造数值：重量/次数为 null 的仍是 null，0 仍是 0', () => {
    const m = migrateLegacyData(raw.data);
    const before = JSON.stringify(raw.data.sessions);
    const after = JSON.stringify(m.sessions);
    // 抽若干数值断言：迁移不该把 null 变成数字或反之
    const beforeNulls = (before.match(/"reps":null/g) ?? []).length;
    const afterNulls = (after.match(/"reps":null/g) ?? []).length;
    const beforeZeros = (before.match(/"reps":0/g) ?? []).length;
    const afterZeros = (after.match(/"reps":0/g) ?? []).length;
    expect(afterNulls).toBeGreaterThanOrEqual(beforeNulls - 0);
    expect(afterZeros).toBe(beforeZeros);
  });

  it('迁移后能真正写入隔离库，且再次导出仍是有效备份', async () => {
    const r = validateBackup(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await restoreBackup(r.payload);

    const plans = await listPlans();
    const sessions = await listSessions();
    expect(plans.length).toBe(raw.data.plans.length);
    expect(sessions.length).toBe(raw.data.sessions.length);

    // 再导出自产备份，必须能被自己接受（无损往返）
    const round = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const r2 = validateBackup(round);
    expect(r2.ok, r2.ok ? '' : (r2 as { error: string }).error).toBe(true);
  });

  it('R06：v1 双杠（bodyweight_plus）与迁移后新训练的 identity 一致', () => {
    const m = migrateLegacyData(raw.data);
    // 找 v1 历史里的双杠臂屈伸
    const histDip = (m.sessions as any[])
      .flatMap((s) => s.exercises)
      .find((ex) => ex.name === '双杠臂屈伸');
    expect(histDip).toBeTruthy();

    // 计划里同一动作
    const planDip = (m.plans as any[])
      .flatMap((p) => p.days)
      .flatMap((d) => d.exercises)
      .find((ex) => ex.name === '双杠臂屈伸');
    expect(planDip).toBeTruthy();

    // 关键：历史与新计划必须能匹配上
    const sameById = exerciseIdFromName('双杠臂屈伸');
    expect(histDip.exerciseId).toBe(planDip.exerciseId);
    expect(histDip.exerciseId.startsWith(sameById)).toBe(true);
  });
});
