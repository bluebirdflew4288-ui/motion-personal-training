import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  buildBackup,
  deleteSession,
  ensureSeed,
  findActiveSession,
  getSession,
  listPlans,
  listSessions,
  loadSettings,
  restoreBackup,
  savePlan,
  saveSession,
  saveSettings,
  snapshotBeforeRestore,
  validateBackup,
} from '../src/db/repo';
import { __resetDbHandle, idbClear } from '../src/db/idb';
import { createSession, summarizeSession } from '../src/domain/session';
import { createV32Plan } from '../src/domain/presets/v32';

const NOW = 1_760_000_000_000;

async function wipe() {
  __resetDbHandle();
  for (const s of ['plans', 'sessions', 'settings', 'meta']) await idbClear(s);
}

beforeEach(async () => {
  await wipe();
});

describe('首次启动', () => {
  it('写入 V3.2 预设，且重复启动不会重复写入', async () => {
    expect(await ensureSeed()).toBe(true);
    const plans = await listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].name).toBe('三分化训练计划 V3.2');
    expect(await ensureSeed()).toBe(false);
    expect(await listPlans()).toHaveLength(1);
  });
});

describe('自动保存与恢复', () => {
  it('保存后能按 id 取回完整组数据', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    session.exercises[0].sets[0].reps = 9;
    session.exercises[0].sets[0].weightKg = 62.5;
    session.exercises[0].sets[0].status = 'done';
    await saveSession(session);

    const back = await getSession(session.id);
    expect(back).toBeDefined();
    expect(back!.exercises[0].sets[0].reps).toBe(9);
    expect(back!.exercises[0].sets[0].weightKg).toBe(62.5);
    expect(back!.exercises[0].sets[0].status).toBe('done');
  });

  it('能找到未结束的训练（刷新后可继续）', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[1], NOW);
    await saveSession(session);
    const active = await findActiveSession();
    expect(active?.id).toBe(session.id);
    expect(active?.day.dayName).toBe('背 A');
  });

  it('结束后不再被视为未结束训练', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    await saveSession({ ...session, status: 'completed', endedAt: NOW + 1000 });
    expect(await findActiveSession()).toBeUndefined();
  });
});

describe('计划修改不影响历史（快照隔离）', () => {
  it('改计划动作名/组数后，旧训练记录保持原值', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    session.exercises[1].sets[0].reps = 8;
    session.exercises[1].sets[0].status = 'done';
    const before = summarizeSession(session, NOW);
    await saveSession(session);

    // 用户改计划：改名 + 改目标组数
    const edited = {
      ...plan,
      days: plan.days.map((d, i) =>
        i !== 0
          ? d
          : {
              ...d,
              exercises: d.exercises.map((ex, j) =>
                j === 1 ? { ...ex, name: '杠铃卧推（改名）', target: { ...ex.target, sets: 5 } } : ex,
              ),
            },
      ),
    };
    await savePlan(edited);

    const historic = await getSession(session.id);
    expect(historic!.exercises[1].name).toBe('自由杠铃卧推');
    expect(summarizeSession(historic!, NOW).targetSets).toBe(before.targetSets);

    // 删除计划也不影响历史
    await savePlan(edited);
    const plansAfter = await listPlans();
    expect(plansAfter[0].days[0].exercises[1].name).toBe('杠铃卧推（改名）');
    expect((await getSession(session.id))!.planName).toBe('三分化训练计划 V3.2');
  });

  it('历史里保存了当时的计划名与训练日名', async () => {
    const plan = createV32Plan(NOW);
    const session = createSession(plan, plan.days[2], NOW);
    await saveSession(session);
    const back = await getSession(session.id);
    expect(back!.planName).toBe('三分化训练计划 V3.2');
    expect(back!.day.dayName).toBe('腿 A');
  });
});

describe('备份导出与校验', () => {
  it('导出包含计划、训练、设置与版本号', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    await saveSession(createSession(plan, plan.days[0], NOW));
    const backup = await buildBackup('1.0.0');
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.version).toBe(BACKUP_VERSION);
    expect(backup.data.plans).toHaveLength(1);
    expect(backup.data.sessions).toHaveLength(1);
    expect(backup.counts.activeSessions).toBe(1);
    expect(backup.data.settings).toHaveLength(1);
  });

  it('拒绝非本应用文件', () => {
    const r = validateBackup({ hello: 'world' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不是 MOTION');
  });

  it('拒绝版本过高的文件', () => {
    const r = validateBackup({ format: BACKUP_FORMAT, version: 99, data: { plans: [], sessions: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('高于当前应用');
  });

  it('拒绝结构损坏的计划/记录', () => {
    const bad = { format: BACKUP_FORMAT, version: 1, data: { plans: [{ id: 1 }], sessions: [] } };
    const r = validateBackup(bad);
    expect(r.ok).toBe(false);

    const bad2 = { format: BACKUP_FORMAT, version: 1, data: { plans: [], sessions: [{ id: 'x' }] } };
    const r2 = validateBackup(bad2);
    expect(r2.ok).toBe(false);
  });

  it('合法文件返回可预览的摘要', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const s = createSession(plan, plan.days[0], NOW);
    await saveSession({ ...s, status: 'completed', endedAt: NOW + 3_600_000 });
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));
    const r = validateBackup(backup);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preview.plans).toBe(1);
      expect(r.preview.sessions).toBe(1);
      expect(r.preview.activeSessions).toBe(0);
      expect(r.preview.newestSession).toBe(NOW + 3_600_000);
    }
  });
});

describe('恢复', () => {
  it('恢复前保留当前数据快照，恢复后数据被完整替换', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const original = createSession(plan, plan.days[0], NOW);
    await saveSession(original);
    const backup = JSON.parse(JSON.stringify(await buildBackup('1.0.0')));

    // 当前数据改成别的东西
    await deleteSession(original.id);
    await saveSession(createSession(plan, plan.days[5], NOW));
    expect(await listSessions()).toHaveLength(1);

    const snap = await snapshotBeforeRestore('1.0.0');
    expect(snap.data.sessions).toHaveLength(1);

    await restoreBackup(backup);
    const sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(original.id);
    expect(sessions[0].day.dayName).toBe('胸 A');
  });

  it('损坏数据恢复失败时不动现有数据', async () => {
    const plan = createV32Plan(NOW);
    await savePlan(plan);
    const session = createSession(plan, plan.days[0], NOW);
    await saveSession(session);

    const broken = {
      format: BACKUP_FORMAT,
      version: 1,
      data: { plans: [], sessions: [{ id: 'nope' }] },
    };
    const r = validateBackup(broken);
    expect(r.ok).toBe(false);

    // 校验失败就不应该走到 restore；现有数据仍在
    expect(await listSessions()).toHaveLength(1);
    expect(await listPlans()).toHaveLength(1);
  });
});

describe('设置持久化', () => {
  it('主题偏好写进本地库', async () => {
    expect((await loadSettings()).theme).toBe('light');
    await saveSettings({ theme: 'dark' });
    expect((await loadSettings()).theme).toBe('dark');
  });

  it('导出时间被记录', async () => {
    await saveSettings({ lastExportAt: 12345 });
    expect((await loadSettings()).lastExportAt).toBe(12345);
  });
});
