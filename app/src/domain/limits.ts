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
/* 递减组「阶段间休息」沿用编辑器能力（DropSetEditor max=600 / validateDropDraft 0–600），
   「轮间休息」才 0–3600。备份校验层对旧数据更宽容不在此收紧。 */
export const MAX_REST_IN_SEC = 600;

/** 文本长度（备注 / 名称 / 说明） */
export const MAX_TEXT = 2000;

/**
 * 动作稳定身份 exerciseId 的最大长度（单一真源）。
 * 与 SessionExercise / PlanExercise 的备份校验边界一致：
 * 模板库能接受的合法配置，添加成训练后必须仍能被完整备份恢复。
 */
export const MAX_EXERCISE_ID = 160;

/**
 * 计划名称上限（单一真源）。
 *
 * <p>新建 / 重命名 / 复制 / 保存入口与备份校验（validate.ts 的 plan.name `{max:200}`）
 * 必须共用这一个数字，避免「应用能生成、备份却恢复不了」——
 * 200 字合法计划复制后变成 203 字曾使整份备份不可恢复。
 */
export const MAX_PLAN_NAME = 200;

/**
 * 全量备份 **reader** 对两个「旧显示名称」字段的有限兼容上限。
 *
 * <p>严格区分两个概念（不要混为「同一个 200」）：
 *   · **新编辑上限** `MAX_PLAN_NAME = 200`：新建 / 重命名 / savePlan / 模板新输入一律 200，
 *     超限明确拒绝，不截断。
 *   · **旧数据 reader 兼容上限** `MAX_LEGACY_PLAN_NAME`：仅用于**受支持的全量备份**
 *     （含恢复前不可变快照）读取 `Plan.name` 与 `Session.planName` 这两个历史显示名称字段。
 *     旧版本曾允许任意长度，故 reader 复用既有 `MAX_TEXT = 2000` 作为**有界**兼容边界：
 *     201–2000 字按原文完整保留（不截断、不改写），>2000 或错类型仍拒绝。
 *
 * <p>这不是把所有文本上限无限放大：其它字段、版本、身份、数量、安全约束保持现有边界；
 * 当前数据库旧值、历史快照都不在这里被重写，reader 只负责「能读、原文往返」。
 */
export const MAX_LEGACY_PLAN_NAME = MAX_TEXT;

/* ── 有氧（第2阶段）──────────────────────────
   与其它上限一样：只在这里定义；超限明确拒绝，不静默 clamp/slice。 */

/** 单次训练的有氧项目数 */
export const MAX_CARDIO_ENTRIES = 8;
/** 单个有氧项目的分段数上限（到上限后拒绝需要新段的参数变化，但暂停/完成/保存照常） */
export const MAX_CARDIO_SEGMENTS = 200;

/** 坡走速度 km/h */
export const MIN_SPEED_KMH = 0;
export const MAX_SPEED_KMH = 30;
export const SPEED_STEP_KMH = 0.1;

/** 坡走坡度 %（滑杆可较粗，精确输入不受粗步进限制） */
export const MIN_INCLINE_PCT = 0;
export const MAX_INCLINE_PCT = 40;
export const INCLINE_STEP_PCT = 0.1;

/** 爬楼机档位（整数） */
export const MIN_STAIR_LEVEL = 1;
export const MAX_STAIR_LEVEL = 100;

/** 单个有氧项目的有效时长上限（24 小时） */
export const MAX_CARDIO_MS = 24 * 60 * 60 * 1000;
