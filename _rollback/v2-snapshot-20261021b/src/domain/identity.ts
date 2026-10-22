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

/** 同名但计量不同（单只/合计、自重/辅助）不能混用的动作：按名称+模式区分身份 */
const WEIGHT_MODE_SUFFIX: Record<string, string> = {
  bodyweight: 'bw',
  bodyweight_plus: 'bw+',
  assisted: 'asst',
};

/**
 * 解析一个计划动作的 exerciseId。
 * 优先用显式预设映射；否则用规范化名称（+ 重量模式）派生，保证跨计划稳定。
 */
export function resolveExerciseId(ex: PlanExercise): string {
  const mode = ex.target.kind === 'straight' ? ex.target.weightMode : 'external';
  const suffix = WEIGHT_MODE_SUFFIX[mode];
  // 只有确实影响可比性的模式才拼接（自重 / 自重+负重 / 辅助），避免把普通动作拆散
  const modePart = suffix ? `__${suffix}` : '';
  const preset = PRESET_EXERCISE_IDS[ex.name.trim()];
  if (preset) return `${preset}${modePart}`;
  return `custom:${normalizeExerciseName(ex.name)}${modePart}`;
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

/** 由名称直接推断身份（临时添加 / 手动输入的动作） */
export function exerciseIdFromName(name: string): string {
  const preset = PRESET_EXERCISE_IDS[name.trim()];
  if (preset) return preset;
  return `custom:${normalizeExerciseName(name)}`;
}
