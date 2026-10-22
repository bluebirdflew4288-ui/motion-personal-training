/* 容量上限的唯一真源（V3-02）。
   问题背景：备份校验里计划动作有 60 上限，训练动作却被 slice 截断；
   计划编辑器又能无限加动作，于是「应用能生成、备份却恢复不了」。
   规则：
   · 所有上限只在这里定义，编辑器和备份校验都引用同一组数字。
   · 超限时「明确拒绝 / 禁止继续添加」，绝不静默裁剪（裁剪=成功却丢内容）。
   · 应用可生成的合法数据必须能完整恢复。 */

/** 计划 / 训练记录条数 */
export const MAX_PLANS = 200;
export const MAX_SESSIONS = 20000;

/** 一个计划里的训练日数量 */
export const MAX_DAYS = 60;

/** 一个训练日 / 一次训练里的动作数量（编辑器与备份一致） */
export const MAX_EXERCISES = 60;

/** 单个动作的组记录行数（普通组=行数；递减组=轮数×阶段数） */
export const MAX_SET_ROWS = 200;

/** 递减组轮数 */
export const MIN_ROUNDS = 1;
export const MAX_ROUNDS = 20;

/** 递减组阶段数：编辑器可生成 2–6；校验层额外容忍到 12（历史数据不误杀） */
export const MIN_STAGES = 2;
export const MAX_STAGES = 6;
export const MAX_STAGES_ACCEPTED = 12;

/** 普通组组数 */
export const MAX_STRAIGHT_SETS = 30;

/** 次数目标 / 实际记录次数 */
export const MAX_REPS = 500;
export const MAX_LOGGED_REPS = 9999;

/** 重量（kg）与休息秒数 */
export const MAX_WEIGHT = 9999;
export const MAX_REST = 3600;

/** 文本长度（备注 / 名称 / 说明） */
export const MAX_TEXT = 2000;
