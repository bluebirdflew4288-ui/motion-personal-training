/* 备份版本兼容判定（第2阶段）。
   ── 边界 ────────────────────────────────────────────────────
   · v2：当前格式，含计划日类型/有氧目标、会话 kind/origin/cardio/restDate 等
   · v1：0.1.2 旧格式，**只允许旧字段**；若夹带任何新结构 → 明确拒绝
     （不能被"按已知字段重建"吞掉后报导入成功）
   · >2 或非整数 → 拒绝，不猜测读取

   0.1.2 的 validator 在 `obj.version > 1` 处拒绝 → 旧 App 拒新文件边界成立。 */

/** v1 中**不允许出现**的新字段（计划侧 + 会话侧 + 嵌套 entry） */
const FORBIDDEN_IN_V1 = {
  planDay: ['cardio'],
  plan: [],
  session: ['kind', 'origin', 'cardio', 'restDate', 'cardioPausedBySession'],
} as const;

/** v1 允许的 PlanDay.kind 取值（旧二态） */
const V1_DAY_KINDS = new Set(['train', 'rest']);

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

/** 版本号必须是 1 或 2 的整数 */
export function isSupportedBackupVersion(v: unknown): v is 1 | 2 {
  return v === 1 || v === 2;
}
