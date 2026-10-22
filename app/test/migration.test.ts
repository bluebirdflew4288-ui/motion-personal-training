import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbHandle, idbClear, idbGetAll, idbPut } from '../src/db/idb';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  ensureSeed,
  listPlans,
  listSessions,
  migratePlans,
  migrateSessions,
  restoreBackup,
  savePlan,
  saveSession,
  validateBackup,
} from '../src/db/repo';
import { createSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';
import type { Plan, Session } from '../src/domain/types';

const NOW = 1_760_000_000_000;

beforeEach(async () => {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
});

describe('数据升级（不打断进行中的训练）', () => {
  it('旧记录缺 cursor 时补 0', () => {
    const plan = createV32Plan(NOW) as unknown as Record<string, unknown>;
    delete plan.cursor;
    const [fixed] = migratePlans([plan as unknown as Plan]);
    expect(fixed.cursor).toBe(0);
  });

  it('旧记录缺 note/pausedMs 时补齐默认值', () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW) as unknown as Record<string, unknown>;
    delete session.note;
    delete session.pausedMs;
    delete session.pausedAt;
    const [fixed] = migrateSessions([session as unknown as Session]);
    expect(fixed.note).toBe('');
    expect(fixed.pausedMs).toBe(0);
    expect(fixed.pausedAt).toBeNull();
  });

  it('旧组记录缺 roundIndex/stageIndex 时按直练补齐', () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[0], NOW);
    const broken = JSON.parse(JSON.stringify(session)) as Record<string, unknown>;
    const exercises = broken.exercises as Array<Record<string, unknown>>;
    const sets = exercises[0].sets as Array<Record<string, unknown>>;
    delete sets[0].roundIndex;
    delete sets[0].stageIndex;
    const [fixed] = migrateSessions([broken as unknown as Session]);
    expect(fixed.exercises[0].sets[0].roundIndex).toBe(1);
    expect(fixed.exercises[0].sets[0].stageIndex).toBe(1);
  });

  it('进行中的训练在升级后仍可识别为 active', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    await saveSession(session);
    // 模拟旧版本写入的行
    await idbPut('sessions', { ...session, note: undefined, pausedMs: undefined });
    const all = await listSessions();
    expect(all.filter((s) => s.status === 'active')).toHaveLength(1);
  });
});

describe('恢复时的边界', () => {
  it('恢复旧版本备份成功后标记 seeded，不会再次写入预设', async () => {
    const plan = createV32Plan(NOW);
    const oldBackup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW,
      appVersion: '0.9.0',
      data: { plans: [plan], sessions: [], settings: [] },
    };
    const v = validateBackup(oldBackup);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // 应用版本不同 → 应该有提醒
    expect(v.warnings.some((w) => w.includes('0.9.0'))).toBe(true);
    await restoreBackup(v.payload);
    expect(await listPlans()).toHaveLength(1);
    expect(await ensureSeed()).toBe(false);
  });

  it('备份里没有计划时恢复后仍是空，不自动塞入预设', async () => {
    const empty = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: NOW,
      appVersion: '1.0.0',
      data: { plans: [], sessions: [], settings: [] },
    };
    const v = validateBackup(empty);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await restoreBackup(v.payload);
    expect(await listPlans()).toHaveLength(0);
    expect(await listSessions()).toHaveLength(0);
  });

  it('导出→恢复往返后数据完全一致', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[2], NOW);
    s.exercises[0].sets[0].reps = 12;
    s.exercises[0].sets[0].weightKg = 82.5;
    s.exercises[0].sets[0].status = 'done';
    s.note = '测试备注';
    await saveSession(s);

    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    await idbClear('sessions');
    await idbClear('plans');
    expect(await listSessions()).toHaveLength(0);

    const v = validateBackup(backup);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    await restoreBackup(v.payload);

    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].note).toBe('测试备注');
    expect(sessions[0].exercises[0].sets[0].reps).toBe(12);
    expect(sessions[0].exercises[0].sets[0].weightKg).toBe(82.5);
    const plans = await listPlans();
    expect(plans[0].days).toHaveLength(8);
  });
});

describe('并发写入不产生重复记录', () => {
  it('同一 session 反复保存只有一条记录', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    for (let i = 0; i < 5; i++) {
      s.exercises[0].sets[0].reps = i;
      await saveSession(s);
    }
    const all = await idbGetAll<Session>('sessions');
    expect(all).toHaveLength(1);
    expect(all[0].exercises[0].sets[0].reps).toBe(4);
  });
});
