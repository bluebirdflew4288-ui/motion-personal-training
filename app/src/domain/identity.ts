/* 动作身份（exerciseId）与计划条目（planExerciseId）的分离。
   问题背景（审计 R1-06）：胸 A / 胸 B 的「双杠臂屈伸」在计划里是两个条目
   （ex-ca-1 / ex-cb-1），旧代码用条目 ID 查历史，导致跨 A/B 找不到上次表现。
   规则：
   · exerciseId 指向「动作本身」，跨计划、跨 A/B 稳定。
   · planExerciseId 只是它在某个训练日里的位置，可随计划编辑而变。
   · 自定义动作按「规范化名称」生成稳定 ID；不确定的相似名称不合并。 */

import type { Plan, PlanExercise } from './types';

/** 名称规范化：去空白、全角括号转半角、统一大小写 */
export function normalizeExerciseName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** 预设动作的显式身份映射（V3.2 定稿动作，跨 A/B 同身份） */
export const PRESET_EXERCISE_IDS: Record<string, string> = {
  // 胸 / 肩 / 三头
  双杠臂屈伸: 'lib-chest-dip',
  自由杠铃卧推: 'lib-barbell-bench',
  史密斯上斜卧推: 'lib-smith-incline',
  蝴蝶机夹胸: 'lib-pec-deck',
  器械推肩: 'lib-machine-shoulder-press',
  绳索下压: 'lib-cable-pushdown',
  哑铃颈后臂屈伸: 'lib-overhead-db-ext',
  绳索卷腹: 'lib-cable-crunch',
  悬垂举腿: 'lib-hanging-leg-raise',
  // 背
  正手宽握引体向上: 'lib-pull-up',
  分体悍马划船: 'lib-hammer-row',
  胸托划船: 'lib-chest-supported-row',
  中立握高位下拉: 'lib-neutral-pulldown',
  大剪刀弧线下拉: 'lib-arc-pulldown',
  绳索直臂下拉: 'lib-straight-arm-pulldown',
  面拉: 'lib-face-pull',
  反向蝴蝶机飞鸟: 'lib-reverse-pec-deck',
  固定器械二头弯举: 'lib-machine-curl',
  哑铃锤式弯举: 'lib-hammer-curl',
  上斜哑铃弯举: 'lib-incline-db-curl',
  // 腿
  正向哈克深蹲: 'lib-hack-squat',
  倒蹬: 'lib-leg-press',
  坐姿腿屈伸: 'lib-leg-extension',
  坐姿腿弯举: 'lib-seated-leg-curl',
  哈克提踵: 'lib-calf-raise',
  坐姿髋内收机: 'lib-hip-adduction',
  哑铃侧平举: 'lib-lateral-raise',
  正手抬腕: 'lib-reverse-wrist-curl',
  反手抬腕: 'lib-wrist-curl',
};

/**
 * 计量口径（R06）：负重模式与哑铃单只/合计描述「怎么算」，不是「是什么动作」。
 * 身份（exerciseId）只回答「是不是同一个动作」；是否可比较由 comparabilityKey 决定。
 * 这样 v1 历史（无模式字段）与迁移后计划（有模式）能对上同一个动作，
 * 同时避免把「自重引体」和「负重引体」的重量混成一条曲线。
 */
export const WEIGHT_MODE_LABEL: Record<string, string> = {
  external: '外部负重',
  bodyweight: '自重',
  bodyweight_plus: '自重 + 外加负重',
  assisted: '辅助重量',
};

/**
 * 解析一个计划动作的 exerciseId。
 * 优先用显式预设映射；否则用规范化名称（+ 重量模式）派生，保证跨计划稳定。
 */
/**
 * 动作身份：只由「动作本身」决定，与负重模式、单只/合计无关。
 * 因此 v1 历史与迁移后计划得到同一个 exerciseId（R06 修复点）。
 */
export function resolveExerciseId(ex: PlanExercise): string {
  const preset = PRESET_EXERCISE_IDS[ex.name.trim()];
  if (preset) return preset;
  return `custom:${normalizeExerciseName(ex.name)}`;
}

/** 计量口径：用于判断两次记录是否可以放在一起比较 */
export function comparabilityKey(exerciseId: string, target: ExerciseTargetLike): string {
  if (target.kind === 'dropSet') {
    return `${exerciseId}::${target.weightMode}::${target.dumbbellBasis ?? 'total'}`;
  }
  return `${exerciseId}::${target.weightMode}::${target.dumbbellBasis ?? 'total'}`;
}

/** 供 UI 显示的口径说明，例如「哑铃 · 按单只记录」 */
export function comparabilityLabel(target: ExerciseTargetLike): string | null {
  const mode = WEIGHT_MODE_LABEL[target.weightMode] ?? null;
  const basis = target.dumbbellBasis === 'per_hand' ? '哑铃按单只' : target.dumbbellBasis === 'total' ? '哑铃按合计' : null;
  const parts = [mode, basis].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

interface ExerciseTargetLike {
  kind: 'straight' | 'dropSet';
  weightMode: string;
  dumbbellBasis?: 'per_hand' | 'total';
}

/** 为计划中所有动作补齐 exerciseId（幂等） */
export function ensurePlanExerciseIds(plan: Plan): Plan {
  let changed = false;
  const days = plan.days.map((day) => {
    const exercises = day.exercises.map((ex) => {
      const id = ex.exerciseId ?? resolveExerciseId(ex);
      if (ex.exerciseId === id) return ex;
      changed = true;
      return { ...ex, exerciseId: id };
    });
    return changed ? { ...day, exercises } : day;
  });
  return changed ? { ...plan, days } : plan;
}

/**
 * 由名称直接推断身份（临时添加 / 手动输入 / 旧训练迁移）。
 * 只按名称，不掺重量模式 —— 与 resolveExerciseId 保持一致（R06）。
 */
export function exerciseIdFromName(name: string): string {
  const preset = PRESET_EXERCISE_IDS[name.trim()];
  if (preset) return preset;
  return `custom:${normalizeExerciseName(name)}`;
}
