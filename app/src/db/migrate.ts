/* 备份数据迁移（R04）。
   流程：识别受支持版本 → 该旧结构校验 → 内存迁移 → 新结构严格校验 → 预览 → 原子写入
   原则：
   · 旧结构按旧规则校验（不把新字段改成可选，避免放宽新数据标准）。
   · 迁移只补齐可由旧数据确定推出的字段；推不出的标记为「未知」，不编造数值。
   · 迁移函数必须幂等：对同一份数据跑两次结果相同。
   · 失败不改现有数据库（调用方在内存阶段就返回错误）。 */

import type { Plan, GroupPlan } from '../domain/types';
import { exerciseIdFromName, resolveExerciseId } from '../domain/identity';

export const BACKUP_VERSION = 1;
/** 当前应用能读的最旧备份版本 */
export const MIN_SUPPORTED_VERSION = 1;

export type MigrationResult =
  | { ok: true; plans: unknown[]; sessions: unknown[]; settings: unknown[]; applied: string[]; warnings: string[] }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 判断一份备份是不是「v2 之前」的旧结构（缺 exerciseId / groups） */
export function detectLegacyShape(data: Record<string, unknown>): boolean {
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  for (const s of sessions) {
    if (!isObj(s) || !Array.isArray(s.exercises)) continue;
    for (const ex of s.exercises) {
      if (!isObj(ex)) continue;
      if (ex.exerciseId === undefined) return true;
      if (ex.groups === undefined) return true;
    }
  }
  const plans = Array.isArray(data.plans) ? data.plans : [];
  for (const p of plans) {
    if (!isObj(p) || !Array.isArray(p.days)) continue;
    for (const d of p.days) {
      if (!isObj(d) || !Array.isArray(d.exercises)) continue;
      for (const ex of d.exercises) {
        if (isObj(ex) && ex.exerciseId === undefined) return true;
      }
    }
  }
  return false;
}

/** 旧结构的最小校验：只检查迁移所依赖的骨架，不套用新结构规则 */
export function validateLegacyShape(data: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const plans = data.plans;
  const sessions = data.sessions;
  if (!Array.isArray(plans)) return { ok: false, error: '旧备份缺少 plans 数组' };
  if (!Array.isArray(sessions)) return { ok: false, error: '旧备份缺少 sessions 数组' };

  for (const p of plans as unknown[]) {
    if (!isObj(p)) return { ok: false, error: '旧备份里的计划不是对象' };
    if (typeof p.id !== 'string') return { ok: false, error: '旧备份里的计划缺少 id' };
    if (!Array.isArray(p.days)) return { ok: false, error: '旧备份里的计划缺少 days' };
    for (const d of p.days as unknown[]) {
      if (!isObj(d) || !Array.isArray(d.exercises)) {
        return { ok: false, error: '旧备份里的训练日结构不完整' };
      }
      for (const ex of d.exercises as unknown[]) {
        if (!isObj(ex) || !isObj(ex.target)) {
          return { ok: false, error: '旧备份里的动作缺少 target' };
        }
        if (ex.target.kind !== 'straight' && ex.target.kind !== 'dropSet') {
          return { ok: false, error: `旧备份里的动作 target.kind 不合法：${String(ex.target.kind)}` };
        }
      }
    }
  }

  for (const s of sessions as unknown[]) {
    if (!isObj(s)) return { ok: false, error: '旧备份里的训练不是对象' };
    if (typeof s.id !== 'string') return { ok: false, error: '旧备份里的训练缺少 id' };
    if (!isObj(s.day)) return { ok: false, error: '旧备份里的训练缺少 day 快照' };
    if (!Array.isArray(s.exercises)) return { ok: false, error: '旧备份里的训练缺少 exercises' };
    for (const ex of s.exercises as unknown[]) {
      if (!isObj(ex) || typeof ex.name !== 'string') {
        return { ok: false, error: '旧备份里的训练动作缺少 name' };
      }
      if (!isObj(ex.target)) return { ok: false, error: '旧备份里的训练动作缺少 target' };
      if (!Array.isArray(ex.sets)) return { ok: false, error: '旧备份里的训练动作缺少 sets' };
    }
  }
  return { ok: true };
}

/**
 * 由旧动作的 target + 现存 sets 推出组结构（V3-02 保真修复 + V4-05 只删不加）。
 *
 * 背景一（V3-02）：旧实现按「数量」生成 1..N 连续序号，真实 v2 数据里 `removeSetFrom`
 * 会留下稀疏组号（例如 createSession → addSetTo → removeSetFrom 得到 roundIndex [1,3,4]），
 * 按数量重建就成了 [1,2,3] —— 原第 4 组不再匹配任何 group，完成量 3 变 2。
 *
 * 背景二（V4-05，审查 V4D16）：v2「目标 3 组 → 删除第 2 组」后真实 sets 只剩 roundIndex [1,3]。
 * 旧实现为了凑 target 声明的 3 组，补出 groups [1,3,4] —— 第 4 组没有任何实际行，
 * **本次安排从 2 被改成 3，被删除的组复活了**。
 *
 * 现在的规则（migrate 与 repo.rebuildGroupsFor 共用这一份实现）：
 * 1. 先取 sets 里真实出现的 roundIndex（去重、升序）作为骨架，**绝不重排已有组号**。
 * 2. **只要存在任何真实 set 行，就绝不为凑 target 声明数量补新组**。
 *    本次安排（groups）= 真实存在的轮/组；计划目标仍保留在 target 快照里，
 *    那是「计划目标」，不是「本次安排」。
 * 3. 只有「完全没有 set 行」（真正的从无到有，v2 的零组动作 / 结构缺失的老格式）
 *    才按 target 声明生成 1..declared —— 这是唯一允许凭空建结构的情况，且不编造完成值。
 * 4. 没有任何信息可用（无 set 行且 target 也没声明）时返回 []，不凭空造一个组。
 *
 * 关键不变量：`groups.length === sets 里真实不同 roundIndex 的数量`（存在真实行时）。
 * 迁移前后「完成组数」与每个 set 的 roundIndex/stageIndex 关联必须等价。
 */
export function deriveGroupsFrom(
  setsInput: unknown,
  target: Record<string, unknown> | undefined,
  stageCountHint?: number,
): GroupPlan[] {
  const sets = Array.isArray(setsInput) ? (setsInput as Record<string, unknown>[]) : [];
  const roundConfigs = target?.kind === 'dropSet' && Array.isArray(target.roundConfigs)
    ? (target.roundConfigs as Array<Record<string, unknown>>)
    : [];
  const stageCountFor = (roundIndex: number): number => {
    if (stageCountHint !== undefined) return stageCountHint;
    if (target?.kind !== 'dropSet') return 1;
    const override = roundConfigs.find((r) => Number(r.roundIndex) === roundIndex);
    const stages = override && Array.isArray(override.stages) ? override.stages : target.stages;
    return Array.isArray(stages) ? Math.max(1, stages.length) : 1;
  };

  // 1) 真实组号骨架：只保留有限的正整数，去重升序
  const realIndexes = Array.from(
    new Set(
      sets
        .map((st) => Number(st.roundIndex ?? 1))
        .filter((n) => Number.isFinite(n) && n >= 1)
        .map((n) => Math.floor(n)),
    ),
  ).sort((a, b) => a - b);

  // 2) 有真实组号：本次安排就是这些组，绝不补新组（V4-05：删掉的组不复活）
  if (realIndexes.length) return realIndexes.map((index) => ({ index, stageCount: stageCountFor(index) }));

  // 3) 完全没有 set 行：只能按 target 声明「从无到有」生成（唯一允许的情况）
  const declaredRaw = target ? (target.kind === 'dropSet' ? Number(target.rounds) : Number(target.sets)) : 0;
  const declared = Number.isFinite(declaredRaw) && declaredRaw > 0 ? Math.floor(declaredRaw) : 0;
  return Array.from({ length: declared }, (_, i) => ({ index: i + 1, stageCount: stageCountFor(i + 1) }));
}

/** 旧签名兼容：从动作对象里取 sets 与 target */
export function deriveGroups(ex: Record<string, unknown>, target: Record<string, unknown>): GroupPlan[] {
  return deriveGroupsFrom(ex.sets, target);
}

/**
 * 旧结构 → 新结构（内存）。
 * 幂等：对已含 exerciseId/groups 的数据再跑一次不改变内容。
 */
export function migrateLegacyData(data: Record<string, unknown>): {
  plans: unknown[];
  sessions: unknown[];
  settings: unknown[];
  applied: string[];
  warnings: string[];
} {
  const applied: string[] = [];
  const warnings: string[] = [];

  const plans = (Array.isArray(data.plans) ? data.plans : []).map((rawPlan) => {
    const plan = JSON.parse(JSON.stringify(rawPlan)) as Record<string, unknown>;
    const days = Array.isArray(plan.days) ? (plan.days as Record<string, unknown>[]) : [];
    let changed = false;
    for (const day of days) {
      const exercises = Array.isArray(day.exercises) ? (day.exercises as Record<string, unknown>[]) : [];
      for (const ex of exercises) {
        if (ex.exerciseId === undefined && isObj(ex.target)) {
          ex.exerciseId = resolveExerciseId(ex as unknown as Plan['days'][0]['exercises'][0]);
          changed = true;
        }
      }
    }
    if (changed) applied.push(`plan:${String(plan.id)} 补齐 exerciseId`);
    return plan;
  });

  const sessions = (Array.isArray(data.sessions) ? data.sessions : []).map((rawSession) => {
    const session = JSON.parse(JSON.stringify(rawSession)) as Record<string, unknown>;
    const exercises = Array.isArray(session.exercises)
      ? (session.exercises as Record<string, unknown>[])
      : [];
    let changed = false;
    for (const ex of exercises) {
      // exerciseId：旧训练没有，从名称推断（预设走显式映射）
      if (ex.exerciseId === undefined && typeof ex.name === 'string') {
        ex.exerciseId = exerciseIdFromName(ex.name);
        changed = true;
      }
      // groups：从 target + 现存组数重建
      if (ex.groups === undefined && isObj(ex.target)) {
        ex.groups = deriveGroups(ex, ex.target);
        changed = true;
      }
      // 旧版本可能把「无次数的 done」写成 done：降级为 partial，不伪造有效记录
      const sets = Array.isArray(ex.sets) ? (ex.sets as Record<string, unknown>[]) : [];
      for (const st of sets) {
        if (st.status === 'done' && (st.reps === null || st.reps === undefined)) {
          st.status = 'partial';
          changed = true;
        }
        // 旧版本替换曾写入 schema 不支持的 skipped：转成 blank（该组由 groups.skipped 表达跳过）
        if (st.status === 'skipped') {
          st.status = 'blank';
          changed = true;
        }
        if (st.roundIndex === undefined) {
          st.roundIndex = 1;
          changed = true;
        }
        if (st.stageIndex === undefined) {
          st.stageIndex = 1;
          changed = true;
        }
      }
      // 状态枚举归一：旧 skipped 只在「无任何记录」时保留
      if (ex.status === 'skipped') {
        const hasRecord = sets.some(
          (st) => st.reps !== null && st.reps !== undefined,
        );
        if (hasRecord) {
          ex.status = 'done';
          changed = true;
        }
      }
    }
    if (changed) applied.push(`session:${String(session.id)} 迁移动作身份与组结构`);
    return session;
  });

  const settings = Array.isArray(data.settings) ? (data.settings as unknown[]) : [];
  for (const s of settings) {
    if (!isObj(s)) continue;
    if (s.theme !== 'light' && s.theme !== 'dark' && s.theme !== 'system') {
      warnings.push('旧备份里的主题值无法识别，已回退为 light');
    }
    if (s.currentPlanId === undefined) {
      s.currentPlanId = null;
      applied.push('settings 补齐 currentPlanId');
    }
  }

  if (!applied.length) warnings.push('未检测到需要迁移的旧字段（数据已是新结构）');
  return { plans, sessions, settings, applied, warnings };
}

/** 供测试：把迁移结果与原数据做结构等价比较（忽略已知新增字段） */
export function migrationIsIdempotent(data: Record<string, unknown>): boolean {
  const once = migrateLegacyData(data);
  const twice = migrateLegacyData({
    plans: once.plans,
    sessions: once.sessions,
    settings: once.settings,
  });
  return JSON.stringify(once.plans) === JSON.stringify(twice.plans) &&
    JSON.stringify(once.sessions) === JSON.stringify(twice.sessions);
}
