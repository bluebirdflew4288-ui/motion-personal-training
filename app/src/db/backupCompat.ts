/* 备份版本兼容判定（G1：v3）。
   ── 边界 ────────────────────────────────────────────────────
   · v3：当前格式，含动作配置记忆（exerciseTemplates）与 G1 新字段
     （superSet form / perSetConfigs / stage id / stage restAfterSec）
   · v2：第2阶段格式；合法旧备份接受，缺省空模板
   · v1：0.1.2 旧格式，只允许旧字段；若夹带任何新结构 → 明确拒绝
   · >3 或非整数 → 拒绝，不猜测读取
   · v1/v2 若夹带 G1 新字段 → 明确拒绝，不能被"按已知字段重建"吞掉后报导入成功

   旧 0.1.8 的 validator 在 `obj.version > 2` 处拒绝 → v3 被旧 App 拒的边界成立。 */

/** v1 中**不允许出现**的新字段（计划侧 + 会话侧 + 嵌套 entry） */
const FORBIDDEN_IN_V1 = {
  planDay: ['cardio'],
  plan: [],
  session: ['kind', 'origin', 'cardio', 'restDate', 'cardioPausedBySession'],
} as const;

/** v1 允许的 PlanDay.kind 取值（旧二态） */
const V1_DAY_KINDS = new Set(['train', 'rest']);

/** G1 新增字段：v1/v2 旧备份不允许夹带（必须用 v3 表达） */
const G1_STRAIGHT_TARGET_KEYS = ['toFailure', 'perSetConfigs', 'form'] as const;
const G1_DROP_TARGET_KEYS = ['form', 'roundConfigs'] as const;
const G1_STAGE_KEYS = ['id', 'restAfterSec'] as const;

export interface CompatIssue {
  path: string;
  message: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 检查 v1 备份里是否夹带新结构。
 * 返回问题列表；空数组 = 干净的 v1。
 */
export function findV1Contraband(data: unknown): CompatIssue[] {
  const issues: CompatIssue[] = [];
  if (!isObj(data)) return issues;

  const plans = Array.isArray(data.plans) ? data.plans : [];
  plans.forEach((p, pi) => {
    if (!isObj(p)) return;
    for (const key of FORBIDDEN_IN_V1.plan) {
      if (key in p) issues.push({ path: `plans[${pi}].${key}`, message: 'v1 备份不允许包含该字段' });
    }
    const days = Array.isArray(p.days) ? p.days : [];
    days.forEach((d, di) => {
      if (!isObj(d)) return;
      for (const key of FORBIDDEN_IN_V1.planDay) {
        if (key in d) {
          issues.push({
            path: `plans[${pi}].days[${di}].${key}`,
            message: 'v1 备份的计划日不允许包含有氧结构',
          });
        }
      }
      // 新日类型值 'cardio' 在 v1 中非法
      const kind = d.kind;
      if (typeof kind === 'string' && !V1_DAY_KINDS.has(kind)) {
        issues.push({
          path: `plans[${pi}].days[${di}].kind`,
          message: `v1 备份的计划日类型只能是 train/rest，收到 ${kind}`,
        });
      }
    });
  });

  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  sessions.forEach((s, si) => {
    if (!isObj(s)) return;
    for (const key of FORBIDDEN_IN_V1.session) {
      if (key in s) {
        issues.push({ path: `sessions[${si}].${key}`, message: 'v1 备份不允许包含该字段' });
      }
    }
    // 嵌套 entry 也检查（即便外层已拒绝，仍给出精确位置）
    if (Array.isArray(s.cardio)) {
      (s.cardio as unknown[]).forEach((c, ci) => {
        if (isObj(c)) {
          issues.push({
            path: `sessions[${si}].cardio[${ci}]`,
            message: 'v1 备份不允许包含有氧项目',
          });
        }
      });
    }
  });

  return issues;
}

/**
 * G1 新字段 contraband：v1/v2 旧备份中出现即拒绝。
 * 目的：新字段不能被伪装成旧版本、再被"按已知字段重建"静默吞掉。
 */
export function findG1Contraband(data: unknown): CompatIssue[] {
  const issues: CompatIssue[] = [];
  if (!isObj(data)) return issues;
  if ('exerciseTemplates' in data) {
    issues.push({ path: 'data.exerciseTemplates', message: 'v1/v2 备份不允许包含动作配置记忆（需使用 v3）' });
  }

  const checkTarget = (target: unknown, path: string) => {
    if (!isObj(target)) return;
    const kind = target.kind;
    if (kind === 'straight') {
      for (const key of G1_STRAIGHT_TARGET_KEYS) {
        if (key in target) {
          issues.push({ path: `${path}.${key}`, message: '旧版本备份不允许包含 G1 新字段（需使用 v3）' });
        }
      }
    } else if (kind === 'dropSet') {
      for (const key of G1_DROP_TARGET_KEYS) {
        if (key in target) {
          issues.push({ path: `${path}.${key}`, message: '旧版本备份不允许包含 G1 新字段（需使用 v3）' });
        }
      }
      const stages = Array.isArray(target.stages) ? target.stages : [];
      stages.forEach((st, si) => {
        if (!isObj(st)) return;
        for (const key of G1_STAGE_KEYS) {
          if (key in st) {
            issues.push({
              path: `${path}.stages[${si}].${key}`,
              message: '旧版本备份不允许包含 G1 阶段新字段（需使用 v3）',
            });
          }
        }
      });
    }
  };

  const plans = Array.isArray(data.plans) ? data.plans : [];
  plans.forEach((p, pi) => {
    if (!isObj(p) || !Array.isArray(p.days)) return;
    p.days.forEach((d, di) => {
      if (!isObj(d) || !Array.isArray(d.exercises)) return;
      d.exercises.forEach((ex, ei) => {
        if (!isObj(ex)) return;
        checkTarget(ex.target, `plans[${pi}].days[${di}].exercises[${ei}].target`);
      });
    });
  });
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  sessions.forEach((s, si) => {
    if (!isObj(s) || !Array.isArray(s.exercises)) return;
    s.exercises.forEach((ex, ei) => {
      if (!isObj(ex)) return;
      checkTarget(ex.target, `sessions[${si}].exercises[${ei}].target`);
    });
  });
  return issues;
}

/** 版本号必须是 1、2 或 3 的整数 */
export function isSupportedBackupVersion(v: unknown): v is 1 | 2 | 3 {
  return v === 1 || v === 2 || v === 3;
}
