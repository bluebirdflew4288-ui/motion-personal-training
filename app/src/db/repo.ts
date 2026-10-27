/* 数据仓库层：计划 / 训练实例 / 设置 / 元信息。
   所有写入都走 IndexedDB 事务；失败会抛 StorageError 由 UI 显示「未保存」，
   绝不在失败后假装成功。 */

import { idbDelete, idbGet, idbGetAll, idbPut, idbReplaceAll, openDb, StorageError } from './idb';
import { createV32Plan } from '../domain/presets/v32';
import { validateDataDeep } from './validate';
import { detectLegacyShape, deriveGroupsFrom, migrateLegacyData, validateLegacyShape } from './migrate';
import { exerciseIdFromName, resolveExerciseId } from '../domain/identity';
import { targetGroupsOf } from '../domain/session';
import { findV1Contraband, isSupportedBackupVersion } from './backupCompat';
import type { GroupPlan, Plan, Session, SessionExercise } from '../domain/types';

export interface AppSettings {
  key: 'app';
  theme: 'light' | 'dark' | 'system';
  /** 当前选中的计划 ID（审计 R2-07：导航后不能丢） */
  currentPlanId: string | null;
  lastExportAt: number | null;
  lastBackupPromptAt: number | null;
  /** 已读的更新提示版本 */
  seenVersion: string | null;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export const DEFAULT_SETTINGS: AppSettings = {
  key: 'app',
  theme: 'light',
  currentPlanId: null,
  lastExportAt: null,
  lastBackupPromptAt: null,
  seenVersion: null,
};

/* ── 计划 ─────────────────────────────── */

export async function listPlans(): Promise<Plan[]> {
  const plans = await idbGetAll<Plan>('plans');
  return plans.sort((a, b) => a.createdAt - b.createdAt);
}

export async function getPlan(id: string): Promise<Plan | undefined> {
  return idbGet<Plan>('plans', id);
}

export async function savePlan(plan: Plan): Promise<Plan> {
  const next = { ...plan, updatedAt: Date.now() };
  await idbPut('plans', next);
  return next;
}

export async function deletePlan(id: string): Promise<void> {
  await idbDelete('plans', id);
}

/**
 * **删除计划 + 清理恰好匹配的 current**，在**同一笔本地事务**内完成
 * （B3/G5-R5 产品裁决）。
 *
 * ── 被修复的真实失败 ─────────────────────────────────────────
 * 旧流程：先 `deletePlan` 成功 → 再 `setCurrentPlan`（独立 IDB 写）。
 * 若第二步失败（Codex 注入 settings.put abort），结果是：
 * plans 已无 A，settings.currentPlanId 仍指向 A —— **悬空引用**，
 * UI 只能弹 toast 让用户自己重选。
 *
 * ── 现在的语义 ────────────────────────────────────────────────
 * `plans` 与 `settings` 在**同一个 IndexedDB**，因此可以在**一个 readwrite
 * 事务**里同时做两件事：事务 abort 则**两者一起回滚**，不会出现半完成。
 *
 * @param id 要删除的计划 id
 * @param decideFallback 读**最新** settings 后决定新的 current
 *        （`null` 表示没有其它计划）；返回 `undefined` 表示"不需要改 current"
 *        （即被删的不是当前训练计划 → 不动，避免覆盖并发已选的其他 current）
 */
export function atomicDeletePlanWithCurrent(
  id: string,
  decideFallback: (currentPlanId: string | null, remainingPlanIds: string[]) => string | null | undefined,
): Promise<{ ok: boolean; newCurrentPlanId?: string | null; reason?: string }> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        let settled = false;
        const done = (r: { ok: boolean; newCurrentPlanId?: string | null; reason?: string }) => {
          if (!settled) {
            settled = true;
            resolve(r);
          }
        };
        let t: IDBTransaction;
        try {
          // 同一事务覆盖两个 store：任一失败 → 整体 abort 回滚
          t = db.transaction(['plans', 'settings'], 'readwrite');
        } catch (err) {
          done({ ok: false, reason: err instanceof Error ? err.message : '事务开启失败' });
          return;
        }
        /**
         * B4/G5-R2：**成功只在 `transaction.oncomplete` 结算**。
         *
         * 旧实现在 `request.onsuccess` 就 `resolve({ok:true})` —— 但 request success
         * **不是 commit**：之后仍可能 abort（Codex 真实注入 settings.put
         * request-success 后 abort，数据确实整体回滚，却误报"已删除并回退"）。
         *
         * 现在：request 回调只**记录候选结果**，真正的 resolve 由 oncomplete 触发。
         */
        let candidate: { newCurrentPlanId?: string | null } | null = null;
        t.oncomplete = () => {
          if (candidate) {
            done({ ok: true, newCurrentPlanId: candidate.newCurrentPlanId });
          } else {
            // 完成但无候选（异常路径）：如实失败
            done({ ok: false, reason: 'no-candidate' });
          }
        };
        t.onabort = () => done({ ok: false, reason: 'transaction-aborted' });
        t.onerror = () => done({ ok: false, reason: t.error?.message ?? '事务失败' });

        const planStore = t.objectStore('plans');
        const settingsStore = t.objectStore('settings');

        const allReq = planStore.getAll();
        allReq.onerror = () => done({ ok: false, reason: allReq.error?.message ?? '读取计划失败' });
        allReq.onsuccess = () => {
          const all = (allReq.result ?? []) as Plan[];
          if (!all.some((p) => p.id === id)) {
            // 计划已不存在：不写任何东西，如实返回
            t.abort();
            done({ ok: false, reason: 'plan-not-found' });
            return;
          }
          const remaining = all.filter((p) => p.id !== id).map((p) => p.id);

          // 在**同一事务**内读最新 settings（避免用陈旧内存覆盖并发已选）
          const stReq = settingsStore.get('app');
          stReq.onerror = () => done({ ok: false, reason: stReq.error?.message ?? '读取设置失败' });
          stReq.onsuccess = () => {
            const row = (stReq.result ?? {}) as AppSettings & { key?: string };
            const currentId = (row.currentPlanId ?? null) as string | null;
            const decision = decideFallback(currentId, remaining);

            const delReq = planStore.delete(id);
            delReq.onerror = () => done({ ok: false, reason: delReq.error?.message ?? '删除失败' });
            delReq.onsuccess = () => {
              if (decision === undefined) {
                // 不需要改 current：只删计划
                candidate = { newCurrentPlanId: currentId };
                return;
              }
              const nextSettings = {
                ...DEFAULT_SETTINGS,
                ...row,
                currentPlanId: decision,
                key: 'app' as const,
              };
              const putReq = settingsStore.put(nextSettings);
              putReq.onerror = () => done({ ok: false, reason: putReq.error?.message ?? '设置写入失败' });
              putReq.onsuccess = () => {
                // 只记候选；成功要等 oncomplete
                candidate = { newCurrentPlanId: decision };
              };
            };
          };
        };
      }),
  );
}

/* ── 训练实例 ─────────────────────────── */

/**
 * 读取层**无破坏性缺省**（第2阶段）。
 *
 * 直接覆盖升级（0.1.2 → 新版）不走 restore，`listSessions` 直接读 IDB，
 * 因此所有读出口都必须补缺省，否则新代码强依赖新字段会崩。
 * **只在内存补，不回写库、不重建、不删除旧数据。**
 */
export function normalizeSession(s: Session): Session {
  return {
    ...s,
    kind: s.kind ?? 'strength',
    origin: s.origin ?? 'plan',
    cardio: s.cardio ?? [],
    cardioPausedBySession: s.cardioPausedBySession ?? [],
  };
}

export async function listSessions(): Promise<Session[]> {
  const all = await idbGetAll<Session>('sessions');
  return all.map(normalizeSession).sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id: string): Promise<Session | undefined> {
  const s = await idbGet<Session>('sessions', id);
  return s ? normalizeSession(s) : undefined;
}

export async function saveSession(session: Session): Promise<void> {
  await idbPut('sessions', session);
}

export async function deleteSession(id: string): Promise<void> {
  await idbDelete('sessions', id);
}

export async function findActiveSession(): Promise<Session | undefined> {
  const all = await idbGetAll<Session>('sessions');
  return all
    .map(normalizeSession)
    .filter((s) => s.status === 'active')
    .sort((a, b) => b.startedAt - a.startedAt)[0];
}

/* ── 设置 ─────────────────────────────── */

export async function loadSettings(): Promise<AppSettings> {
  const row = await idbGet<AppSettings>('settings', 'app');
  return { ...DEFAULT_SETTINGS, ...(row ?? {}) };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const next = { ...current, ...patch, key: 'app' as const };
  await idbPut('settings', next);
  return next;
}

/* ── 元信息（锁、版本）───────────────── */

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await idbGet<MetaRow>('meta', key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await idbPut<MetaRow>('meta', { key, value });
}

/* ── 首次启动 ─────────────────────────── */

/** 首次启动写入 V3.2 预设；已有计划时不动。返回是否初始化过。 */
export async function ensureSeed(): Promise<boolean> {
  const meta = await getMeta<boolean>('seeded');
  const plans = await listPlans();
  if (meta && plans.length) return false;
  if (!plans.length) {
    await savePlan(createV32Plan());
  }
  await setMeta('seeded', true);
  return true;
}

/* ── 备份 / 恢复 ─────────────────────── */

export const BACKUP_FORMAT = 'motion-training-backup';
export const BACKUP_VERSION = 2;

export interface BackupPayload {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  appVersion: string;
  counts: { plans: number; sessions: number; activeSessions: number };
  data: {
    plans: Plan[];
    sessions: Session[];
    settings: AppSettings[];
  };
}

export async function buildBackup(appVersion: string): Promise<BackupPayload> {
  const plans = await listPlans();
  const sessions = await listSessions();
  const settings = [await loadSettings()];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    appVersion,
    counts: {
      plans: plans.length,
      sessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === 'active').length,
    },
    data: { plans, sessions, settings },
  };
}

export interface RestorePreview {
  exportedAt: number;
  appVersion: string;
  plans: number;
  sessions: number;
  activeSessions: number;
  oldestSession: number | null;
  newestSession: number | null;
  theme: string | null;
}

export type ValidateResult =
  | { ok: true; payload: BackupPayload; preview: RestorePreview; warnings: string[] }
  | { ok: false; error: string; issues?: Array<{ path: string; message: string }> };

/*
 * 应用显示版本 + **新导出备份写入的 appVersion 元数据**（第5阶段候选）。
 * 历史值曾是 Web 期 '1.0.0'；本轮与候选包 0.1.7 对齐，避免设置页与包版本矛盾。
 * 旧备份里的 1.0.0 元数据仍按现有规则**只提示不拒绝**（validateBackup 的
 * warnings：srcVersion !== currentAppVersion），冻结/历史文件不改。
 */
export const CURRENT_APP_VERSION = '0.1.7';

export function validateBackup(raw: unknown, currentAppVersion = CURRENT_APP_VERSION): ValidateResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: '文件不是有效的 JSON 对象' };
  const obj = raw as Partial<BackupPayload>;
  if (obj.format !== BACKUP_FORMAT) return { ok: false, error: '这不是 MOTION 的备份文件（format 不匹配）' };
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version)) {
    return { ok: false, error: '备份文件缺少有效版本号' };
  }
  // 版本按**明示支持的整数集合**判断；非法/未来版本不猜测读取
  if (!isSupportedBackupVersion(obj.version)) {
    if (obj.version > BACKUP_VERSION) {
      return {
        ok: false,
        error: `备份版本 ${obj.version} 高于当前应用支持的 ${BACKUP_VERSION}，请先升级应用`,
      };
    }
    return { ok: false, error: `不支持的备份版本 ${obj.version}` };
  }
  const data = obj.data;
  if (!data || typeof data !== 'object') {
    return { ok: false, error: '备份缺少 data 内容' };
  }

  /**
   * v1 备份**只允许旧字段**。
   * 夹带新结构（计划日类型/有氧目标、会话 kind/origin/cardio/restDate、
   * 以及嵌套 cardio entry）必须明确拒绝，不能经已知字段重建后报成功。
   */
  if (obj.version === 1) {
    const contraband = findV1Contraband(data);
    if (contraband.length) {
      const first = contraband[0];
      return {
        ok: false,
        error: `v1 备份包含新版结构，已拒绝：${first.path} — ${first.message}`,
        issues: contraband,
      };
    }
  }

  // ── 顶层元数据校验（R05）：appVersion / exportedAt / theme 必须是合法运行时类型 ──
  const metaIssues: Array<{ path: string; message: string }> = [];
  if (obj.appVersion !== undefined && typeof obj.appVersion !== 'string') {
    metaIssues.push({ path: 'appVersion', message: '应用版本必须是文本' });
  }
  if (obj.exportedAt !== undefined) {
    if (typeof obj.exportedAt !== 'number' || !Number.isFinite(obj.exportedAt)) {
      metaIssues.push({ path: 'exportedAt', message: '导出时间必须是有限数字' });
    } else if (obj.exportedAt < 946684800000 || obj.exportedAt > 4102444800000) {
      metaIssues.push({ path: 'exportedAt', message: '导出时间不在合理区间' });
    }
  }
  const rawSettings = Array.isArray((data as { settings?: unknown[] }).settings)
    ? ((data as { settings: unknown[] }).settings)
    : [];
  for (let i = 0; i < rawSettings.length; i++) {
    const st = rawSettings[i];
    if (typeof st !== 'object' || st === null) {
      metaIssues.push({ path: `data.settings[${i}]`, message: '设置项必须是对象' });
      continue;
    }
    const theme = (st as { theme?: unknown }).theme;
    if (theme !== undefined && theme !== 'light' && theme !== 'dark' && theme !== 'system') {
      metaIssues.push({ path: `data.settings[${i}].theme`, message: `主题取值不合法：${String(theme)}` });
    }
    const lastExport = (st as { lastExportAt?: unknown }).lastExportAt;
    if (lastExport !== undefined && lastExport !== null) {
      if (typeof lastExport !== 'number' || !Number.isFinite(lastExport)) {
        metaIssues.push({ path: `data.settings[${i}].lastExportAt`, message: '导出时间戳必须是有限数字' });
      }
    }
  }
  if (metaIssues.length) {
    return {
      ok: false,
      error: `备份元数据不合法：${metaIssues[0].path} — ${metaIssues[0].message}`,
      issues: metaIssues,
    };
  }

  // ── R04：旧结构先按旧规则校验，再在内存迁移，最后用新结构严格校验 ──
  const legacy = detectLegacyShape(data as Record<string, unknown>);
  let workingData = data as Record<string, unknown>;
  let migrationNotes: string[] = [];
  if (legacy) {
    const legacyCheck = validateLegacyShape(workingData);
    if (!legacyCheck.ok) {
      return { ok: false, error: `旧版备份结构不合法：${legacyCheck.error}` };
    }
    const migrated = migrateLegacyData(workingData);
    workingData = {
      plans: migrated.plans,
      sessions: migrated.sessions,
      settings: migrated.settings,
    };
    migrationNotes = migrated.warnings;
  }

  // ── 完整深度校验：任何结构损坏都在这里被拒绝，不触碰数据库 ──
  const deep = validateDataDeep(workingData);
  if (!deep.ok) {
    const first = deep.issues[0];
    return {
      ok: false,
      error: `备份结构损坏，已拒绝导入：${first ? `${first.path} — ${first.message}` : '结构不合法'}`,
      issues: deep.issues,
    };
  }

  const plans = deep.value.plans;
  const sessions = deep.value.sessions;
  const settings = deep.value.settings as AppSettings[];
  const warnings = [...deep.warnings, ...migrationNotes];
  if (legacy) {
    warnings.unshift('这份备份来自旧版本，已自动升级到当前数据结构（原文件不动，仅本次导入使用升级结果）');
  }

  const ended = sessions.filter((s) => s.endedAt).map((s) => s.endedAt as number);
  if (obj.version < BACKUP_VERSION) {
    warnings.push(`备份数据格式为 v${obj.version}，比当前 v${BACKUP_VERSION} 旧，导入时会自动升级`);
  }
  const srcVersion = obj.appVersion ?? 'unknown';
  if (srcVersion !== currentAppVersion) {
    warnings.push(`备份来自应用 ${srcVersion}，当前为 ${currentAppVersion}；如出现异常可用恢复前快照回退`);
  }

  const payload: BackupPayload = {
    format: BACKUP_FORMAT,
    version: obj.version,
    exportedAt: obj.exportedAt ?? 0,
    appVersion: srcVersion,
    counts: {
      plans: plans.length,
      sessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === 'active').length,
    },
    data: { plans, sessions, settings: settings.length ? settings : [DEFAULT_SETTINGS] },
  };

  const preview: RestorePreview = {
    exportedAt: obj.exportedAt ?? 0,
    appVersion: srcVersion,
    plans: plans.length,
    sessions: sessions.length,
    activeSessions: sessions.filter((s) => s.status === 'active').length,
    oldestSession: ended.length ? Math.min(...ended) : null,
    newestSession: ended.length ? Math.max(...ended) : null,
    theme: settings[0]?.theme ?? null,
  };
  return { ok: true, payload, preview, warnings };
}

/** 恢复前把当前数据另存一份「恢复前快照」，便于回退 */
export async function snapshotBeforeRestore(appVersion: string): Promise<BackupPayload> {
  const snap = await buildBackup(appVersion);
  await setMeta('pre-restore-snapshot', snap);
  return snap;
}

export async function getPreRestoreSnapshot(): Promise<BackupPayload | undefined> {
  return getMeta<BackupPayload>('pre-restore-snapshot');
}

export async function restoreBackup(payload: BackupPayload): Promise<void> {
  const plans = migratePlans(payload.data.plans);
  const sessions = migrateSessions(payload.data.sessions);
  const incoming = payload.data.settings?.[0];

  // 主题来自备份；但「本机最近导出时间」属于当前设备状态，不应被旧备份抹掉
  const current = await loadSettings();
  const merged: AppSettings = {
    key: 'app',
    theme: incoming?.theme ?? current.theme,
    // 恢复后如果原选中计划还在，保持选择；否则回到第一条
    currentPlanId: plans.some((p) => p.id === current.currentPlanId)
      ? current.currentPlanId
      : (plans[0]?.id ?? null),
    lastExportAt: current.lastExportAt ?? incoming?.lastExportAt ?? null,
    lastBackupPromptAt: current.lastBackupPromptAt ?? null,
    seenVersion: current.seenVersion ?? null,
  };
  const settings = [merged];

  try {
    await idbReplaceAll({ plans, sessions, settings });
  } catch (err) {
    throw err instanceof StorageError ? err : new StorageError('恢复失败', err);
  }
  await setMeta('seeded', true);
}

/* ── 数据升级（不打断进行中的训练）─────── */

export function migratePlans(plans: Plan[]): Plan[] {
  return plans.map((p) => ({
    ...p,
    cursor: typeof p.cursor === 'number' ? p.cursor : 0,
    days: p.days.map((d) => ({
      ...d,
      warmups: d.warmups ?? [],
      exercises: (d.exercises ?? []).map((ex) => ({
        ...ex,
        // 旧计划没有 exerciseId：按显式预设映射或规范化名称补齐
        exerciseId: ex.exerciseId ?? resolveExerciseId(ex),
      })),
      kind: d.kind ?? 'train',
    })),
  }));
}

/**
 * 重建一个动作的组结构（仅在 groups 字段**不存在**时使用）。
 * V3-02：保留真实 roundIndex，不按长度重排。
 * V4-05：有真实 set 行时**绝不为凑 target 声明数量补新组**（删掉的组不能复活）；
 *        只有完全没有任何 set 行才按 target 声明「从无到有」。
 * 规则与 db/migrate.ts 的 deriveGroups 完全一致 —— 直接复用同一份实现，避免两处漂移。
 */
function rebuildGroupsFor(ex: SessionExercise): GroupPlan[] {
  const stageCount = ex.target?.kind === 'dropSet' ? Math.max(1, ex.target.stages.length) : 1;
  return deriveGroupsFrom(ex.sets ?? [], ex.target as unknown as Record<string, unknown>, stageCount);
}

export function migrateSessions(sessions: Session[]): Session[] {
  return sessions.map((s) => ({
    ...s,
    // V3-01：旧数据没有 revision → 视为 0（幂等：已有数字则原样保留）
    revision: typeof s.revision === 'number' ? s.revision : 0,
    // 旧训练没有开始时目标快照：按现存动作推算（仅用于显示分母，不改变任何记录）
    targetSetsAtStart:
      s.targetSetsAtStart ??
      (s.exercises ?? []).reduce((n, ex) => n + targetGroupsOf(ex), 0),
    note: s.note ?? '',
    pausedMs: s.pausedMs ?? 0,
    pausedAt: s.pausedAt ?? null,
    warmups: s.warmups ?? [],
    exercises: (s.exercises ?? []).map((ex) => ({
      ...ex,
      // 旧训练没有 exerciseId：从快照名称推断（预设走显式映射，自定义走规范化名称）
      exerciseId: ex.exerciseId ?? exerciseIdFromName(ex.name),
      status: ex.status ?? 'pending',
      note: ex.note ?? '',
      // V3-02：必须区分「字段不存在」与「合法的空数组」。
      // 旧实现用 `ex.groups?.length ? ... : 重建`，把 v3 合法的 `groups: []`
      // （背 B 的可选零组动作）当成缺失，凭空造出 {index:1,stageCount:1} 幽灵组。
      groups: Array.isArray(ex.groups) ? ex.groups : rebuildGroupsFor(ex),
      sets: (ex.sets ?? []).map((st) => ({
        ...st,
        roundIndex: st.roundIndex ?? 1,
        stageIndex: st.stageIndex ?? 1,
        // 旧数据的 done 若没有次数，降级为 partial：不再伪装成完整有效记录（审计 R1-02）
        status:
          st.status === 'done' && (st.reps === null || st.reps === undefined)
            ? ('partial' as const)
            : (st.status ?? ('blank' as const)),
      })),
    })),
  }));
}
