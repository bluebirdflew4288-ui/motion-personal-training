/* MOTION 领域模型 —— 计划、训练实例与记录。
   设计约束：
   1) 训练实例在「开始训练」时对计划日做快照，之后改计划不会回写历史。
   2) 目标值（target）与实际值（session）分属两个类型，绝不混用。
   3) 未填写用 null，实际为零用 0。 */

export type WeightMode = 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted';
export type DumbbellBasis = 'per_hand' | 'total';

/**
 * 训练形式（产品语义，G1 新增）。
 *
 * 关键设计（根决策）：**不新增 `ExerciseTarget.kind` 联合成员**。
 * 超级组与递减组在数据结构上同形（轮数 × 多阶段），因此继续使用
 * `kind: 'dropSet'` 作为底层兼容载体，用显式 `form` 字段区分
 * `'dropSet'`（递减组）与 `'superset'`（超级组）。
 * 这样既满足"明确形式"，又不会让 summary / identity / backup / 旧 UI 的
 * 既有 `kind` 分支出现 half support。普通组仍为 `kind: 'straight'`。
 */
export type TrainingForm = 'straight' | 'superset' | 'dropSet';

/**
 * 普通组中**单组**的独立配置（G1）。
 * 旧数据没有该数组时按 `StraightTarget` 全局字段读取（旧语义）。
 * `null` 表示"未设置参考次数"，与数值 `0` 严格区分。
 */
export interface StraightSetConfig {
  /** 组序号，从 1 开始；与 SessionSet.roundIndex 稳定对应 */
  setIndex: number;
  repsMin: number | null;
  repsMax: number | null;
  suggestedWeightKg: number | null;
  /** 该组独立力竭开关；力竭不注销/禁用次数输入 */
  toFailure: boolean;
}

export interface WarmupTarget {
  id: string;
  name: string;
  en?: string;
  /** 记录单位：次数 / 时间 / 呼吸。热身不记重量。 */
  unit: 'reps' | 'time' | 'breath';
  targetText: string;
  optional?: boolean;
}

export interface StraightTarget {
  kind: 'straight';
  sets: number;
  setsMax: number;
  repsMin: number;
  repsMax: number;
  weightMode: WeightMode;
  suggestedWeightKg: number | null;
  dumbbellBasis?: DumbbellBasis;
  /**
   * 全部组共用的默认力竭开关（G1，可选）。
   * 旧数据缺失 → false（旧语义）；`perSetConfigs` 中同组条目优先。
   * 力竭只表示不要求目标次数，**不注销/禁用次数输入**，也不清空已填参考范围。
   */
  toFailure?: boolean;
  /**
   * 每组独立配置（G1，可选）。存在时按 `setIndex` 覆盖全局
   * `repsMin/repsMax/suggestedWeightKg/toFailure`；`null` = 未设置。
   */
  perSetConfigs?: StraightSetConfig[];
}

export interface DropStageTarget {
  /**
   * 阶段稳定 ID（G1，可选）。
   * 新配置写入时必填；旧数据缺失时按数组位置读取（旧语义），不回写旧计划/历史。
   */
  id?: string;
  label: string;
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  /** 该阶段独立力竭开关；力竭不注销/禁用次数输入 */
  toFailure: boolean;
  /**
   * 该阶段结束后的短间歇（秒，G1，可选）。
   * 末阶段忽略此值，直接接整轮休息 `restAfterSec`（不叠加两段）。
   * 旧数据缺失 → 回退到 `restInSec`（旧语义）。
   */
  restAfterSec?: number;
  targetText: string;
}

/**
 * 多阶段动作的**逐轮覆盖**（R02，可选）。
 *
 * `DropSetTarget.stages` 是默认阶段模板；本数组只保存与默认不同的轮。
 * 旧 JSON 没有该字段 → 所有轮沿用 `stages`（旧语义），不扫描/重写历史。
 * `stages.length` 即该轮 stageCount；轮内阶段 ID 必须唯一。
 */
export interface DropRoundConfig {
  /** 轮序号，从 1 开始；必须落在 1..rounds 且不可重复 */
  roundIndex: number;
  /** 该轮完整阶段配置；替换默认 `stages` 用于该轮 */
  stages: DropStageTarget[];
  /** 该轮阶段间默认短间歇（秒）；缺省回退 `DropSetTarget.restInSec` */
  restInSec?: number;
}

export interface DropSetTarget {
  kind: 'dropSet';
  /**
   * 显式训练形式（G1，可选）：缺省 = 'dropSet'（旧数据语义）。
   * 'superset' = 超级组，仍共用本多阶段结构，避免新增 kind 联合成员。
   */
  form?: 'dropSet' | 'superset';
  rounds: number;
  /** 默认阶段配置；没有逐轮覆盖的轮沿用这里（旧语义唯一来源） */
  stages: DropStageTarget[];
  /** 逐轮覆盖（R02，可选）：同一组第一轮 3 阶段、第二轮 2 阶段时只写差异轮 */
  roundConfigs?: DropRoundConfig[];
  /** 阶段间默认短间歇（旧字段；单阶段 `restAfterSec` 优先） */
  restInSec: number;
  /** 整轮休息（完成最后一阶段后触发，替代末阶段短间歇） */
  restAfterSec: number;
  weightMode: WeightMode;
  dumbbellBasis?: DumbbellBasis;
}

export type ExerciseTarget = StraightTarget | DropSetTarget;

/**
 * 动作配置记忆（G1）。
 *
 * 只保存**纯配置原型**，不得包含 actual / status / runningSinceAt /
 * planExerciseId 等运行态或历史归属字段。持久化在 meta store 的
 * `exercise-template:<exerciseId>` 键下。
 */
export interface ExerciseTemplate {
  /** 存储键：`exercise-template:` + exerciseId（与 meta row 的 key 一致） */
  key: string;
  schemaVersion: 1;
  exerciseId: string;
  name: string;
  en?: string;
  /** 完整纯配置；阶段必须带稳定 id */
  target: ExerciseTarget;
  restSec: number;
  setupNote?: string;
  /** 模板 revision：每次显式更新 +1，用于 expected revision 冲突保护 */
  revision: number;
  updatedAt: number;
}

export interface PlanExercise {
  /** 计划条目 ID（planExerciseId 的来源） */
  id: string;
  /** 动作身份（exerciseId）；旧数据可能缺失，读取时补齐 */
  exerciseId?: string;
  name: string;
  en?: string;
  restSec: number;
  target: ExerciseTarget;
  note?: string;
  setupNote?: string;
  /** V3.2 中被标记为可替代的动作 */
  substitutes?: string[];
  /** 多动作超级组配对标识（合法 UUID v4，仅在 >=2 个动作配对时有效） */
  pairId?: string;
}

export const LEGACY_TRAINING_FOCUSES = ['chest', 'back', 'legs'] as const;
export const TRAINING_FOCUSES = [
  ...LEGACY_TRAINING_FOCUSES, 'shoulders', 'arms', 'core', 'upper', 'lower', 'full',
] as const;
export type TrainingFocus = (typeof TRAINING_FOCUSES)[number];

export const TRAINING_FOCUS_LABEL: Record<TrainingFocus, string> = {
  chest: '胸',
  back: '背',
  legs: '腿',
  shoulders: '肩',
  arms: '手臂',
  core: '核心',
  upper: '上肢',
  lower: '下肢',
  full: '全身',
};

export interface PlanDay {
  id: string;
  /** 训练日名称，例如 胸 A */
  name: string;
  /**
   * 力量训练日的分部标签。
   * 仅 `kind === 'train'`（力量日）适用；有氧/休息日不伪造该字段。
   */
  focus?: TrainingFocus;
  /** A/B 轮。同样仅力量日适用。 */
  round?: 'A' | 'B';
  /**
   * 日类型（三态）：
   * · train  力量日（旧值，缺省）
   * · cardio 计划内明确安排的有氧日
   * · rest   休息日
   * 旧数据只有 train/rest，原样合法，不做归一化改写。
   */
  kind: 'train' | 'cardio' | 'rest';
  restNote?: string;
  warmups: WarmupTarget[];
  exercises: PlanExercise[];
  /** 计划内有氧目标（仅 kind==='cardio' 有意义）。只存目标/初始值，不含实际记录。 */
  cardio?: PlanCardio[];
}

export interface Plan {
  id: string;
  name: string;
  /** 八日循环内的训练日顺序 */
  days: PlanDay[];
  /** 循环游标：指向 days 中的位置。与日历日期完全解耦。 */
  cursor: number;
  createdAt: number;
  updatedAt: number;
  presetId?: string;
}

/* ── 有氧（第2阶段）───────────────────────── */

export const LEGACY_CARDIO_PRESETS = ['treadmill-incline', 'stair-climber'] as const;
export const CARDIO_PRESETS = [
  ...LEGACY_CARDIO_PRESETS, 'stationary-bike', 'elliptical', 'rowing-machine', 'free-cardio',
] as const;
export type CardioPreset = (typeof CARDIO_PRESETS)[number];

/**
 * 有氧参数。
 *
 * **按 preset 严格区分使用字段**（PHASE-2-APPROVAL §2）：
 * 每个预设的字段、范围和必填性由 cardio.ts 中的 CARDIO_FIELDS 定义。
 * 不适用的字段**缺省**（不写 undefined，也不写 null —— 新记录统一"缺省"这一种输出）。
 */
export interface CardioParams {
  /** 坡走：速度 km/h（必填，有限数字） */
  speedKmh?: number;
  /** 坡走：坡度 %（必填，有限数字） */
  inclinePct?: number;
  /** 爬楼机：器械档位（必填，整数） */
  level?: number;
  resistanceLevel?: number;
  cadenceRpm?: number;
  damperLevel?: number;
  splitSecPer500m?: number;
}

/**
 * 参数分段。
 *
 * 起止统一用**该 entry 从 0 开始的有效 elapsed 坐标**（毫秒），
 * 不是 epoch 时间，也不是经 session 总暂停修正的墙钟。
 */
export interface CardioSegment {
  id: string;
  startElapsedMs: number;
  /** null = 该段仍 open（仅 status==='running' 时允许） */
  endElapsedMs: number | null;
  params: CardioParams;
  note?: string;
}

export type CardioStatus = 'pending' | 'running' | 'paused' | 'done';

/**
 * 一次训练里的一个有氧项目（entry）。
 *
 * 计时模型（唯一真源）：
 * · `elapsedMs`：上次结算时已累计的**有效毫秒**，从 0 开始
 * · `runningSinceAt`：运行时的**墙钟** Date.now() 锚点；未运行为 null
 * · 当前有效时长 = elapsedMs + max(0, now - runningSinceAt)
 * 不设第二套暂停累计量。
 */
export interface CardioEntry {
  id: string;
  preset: CardioPreset;
  name: string;
  /** 计划内来源的稳定 ID；临时为 null（不伪造计划身份） */
  planCardioId: string | null;
  /** 计划内目标快照（临时为 null）；改计划不影响它 */
  target: CardioParams | null;
  elapsedMs: number;
  runningSinceAt: number | null;
  status: CardioStatus;
  currentParams: CardioParams;
  segments: CardioSegment[];
  note?: string;
}

/** 计划侧有氧目标（不可变目标快照来源） */
export interface PlanCardio {
  id: string;
  preset: CardioPreset;
  name: string;
  target: CardioParams;
  note?: string;
}

/* ── 训练实例 ─────────────────────────────── */

/**
 * 组记录状态：
 * blank   未填写（什么都没有）
 * done    完整有效（次数已填，重量按动作类型可选）
 * partial 已做但缺关键数据（如没填次数）——不计入完整有效组
 */
export type SetStatus = 'blank' | 'done' | 'partial';

export interface SessionSet {
  id: string;
  /** 直练：组序号从 1 开始。递减组：roundIndex 从 1 开始 */
  roundIndex: number;
  /** 递减组阶段序号从 1 开始；直练恒为 1 */
  stageIndex: number;
  /**
   * 阶段稳定 ID（G1，可选）：与 target.stages[].id 对应。
   * 旧数据缺失时按 roundIndex/stageIndex 位置读取（旧语义）。
   */
  stageId?: string;
  /** 实际次数。null = 未填写；0 = 实际做了 0 次 */
  reps: number | null;
  /** 实际重量（kg）。null = 未记录。自重动作可为 null */
  weightKg: number | null;
  status: SetStatus;
  /** 递减组阶段是否属于「技术性力竭」目标 */
  toFailure?: boolean;
  note?: string;
}

export type SessionExerciseStatus = 'pending' | 'done' | 'skipped';

/**
 * 一个「组」的结构快照。
 * · 普通动作：每 1 组 = 1 阶段
 * · 递减组：每 1 轮 = N 阶段（N 由训练开始时的结构决定，不能靠现存 set 行数推断）
 *
 * 这是判定「完整大组 / 部分大组 / 未开始」的唯一依据（R03.4 / R10）。
 */
export interface GroupPlan {
  /** 组序号，从 1 开始（普通组=组号，递减组=轮号） */
  index: number;
  /** 该组必需的阶段数 */
  stageCount: number;
  /** 该组是否被用户跳过（跳过后不再要求完成，但不抹掉已有记录） */
  skipped?: boolean;
}

export interface SessionExercise {
  setupNote?: string;
  /** 本次训练中的动作实例 ID（sessionExerciseId） */
  id: string;
  /**
   * 动作身份（exerciseId）：跨计划、跨 A/B 轮指向「同一个动作」。
   * 用于「上次表现」「动作历史」。与 planExerciseId 严格区分。
   * 旧数据缺失时由迁移按名称映射补齐。
   */
  exerciseId: string;
  /** 动作在该计划训练日里的条目 ID；临时新增/替换后为 null */
  planExerciseId: string | null;
  name: string;
  en?: string;
  restSec: number;
  target: ExerciseTarget;
  status: SessionExerciseStatus;
  /**
   * 本次训练该动作的组结构快照。长度 = 本次安排的组数；每组的 stageCount 来自开始时的结构。
   * 增删组/轮只改这里与对应 sets；判定完整组必须同时满足 stageCount 与全部完成。
   */
  groups: GroupPlan[];
  sets: SessionSet[];
  note?: string;
  /** 临时替换时记录原动作名 */
  replacedFrom?: string;
  /** 是否本次临时新增 */
  added?: boolean;
  /** 多动作超级组配对标识（合法 UUID v4，仅在 >=2 个动作配对时有效） */
  pairId?: string;
}

export interface SessionWarmup {
  id: string;
  name: string;
  unit: 'reps' | 'time' | 'breath';
  targetText: string;
  done: boolean;
}

export interface SessionSnapshotDay {
  dayId: string;
  dayName: string;
  /** 仅力量训练快照适用；有氧/休息不伪造。旧数据已有值原样保留。 */
  focus?: TrainingFocus;
  round?: 'A' | 'B';
  partText: string;
}

export type SessionStatus = 'active' | 'completed' | 'discarded';

/**
 * 记录类型（三态）。缺省 = 'strength'（0.1.2 只可能产生力量记录）。
 * 力量追加有氧仍是 'strength'，不设冗余 mixed 枚举。
 */
export type SessionKind = 'strength' | 'cardio' | 'rest';

/** 来源：仅区分计划内 / 临时。缺省 = 'plan'。 */
export type SessionOrigin = 'plan' | 'temporary';

export interface Session {
  id: string;
  planId: string;
  /** 快照：即使计划被改名、改动作、删除，历史仍可读 */
  planName: string;
  day: SessionSnapshotDay;
  /** 开始训练时循环游标所在位置（0-based） */
  cycleIndexAtStart: number;
  /**
   * 本次训练开始时的计划目标组数快照（R03.3）。
   * 替换动作、临时加组、改结构都不会改动它，因此「目标分母」始终等于原计划。
   * 旧数据没有该字段时回退到按当前动作计算。
   */
  targetSetsAtStart?: number;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  pausedMs: number;
  pausedAt: number | null;
  warmups: SessionWarmup[];
  exercises: SessionExercise[];
  note: string;
  /** 结束后是否推进了循环 */
  advancedCycle?: boolean;
  /** 结束时循环落在的位置 */
  cycleIndexAfter?: number;
  /**
   * 单调递增的记录版本（V3-01）。
   * 每次成功写入由存储层 +1；写入方必须带 expectedRevision 与之比对，
   * 不一致说明自己拿的是旧快照，必须放弃写入并提示刷新。
   * 旧数据没有该字段 → 视为 0（迁移补齐）。
   */
  revision?: number;

  /* ── 第2阶段扩展（全部可选；旧数据缺省即合法）── */
  /** 记录类型。缺省 = 'strength' */
  kind?: SessionKind;
  /** 来源。缺省 = 'plan' */
  origin?: SessionOrigin;
  /** 有氧项目（力量追加或独立有氧共用同一结构）。缺省 = [] */
  cardio?: CardioEntry[];
  /** 完全休息：本地日期 'YYYY-MM-DD'，创建时固定。仅 kind==='rest' 时存在 */
  restDate?: string;
  /**
   * 因**整次训练暂停**而被动停住的有氧 entry id。
   * 恢复训练时只恢复这些；不误开用户手动暂停的有氧。缺省 = []
   */
  cardioPausedBySession?: string[];
}

/* ── 统计口径 ─────────────────────────────── */

export interface SessionSummary {
  /** 本次实际安排的组数（groups.length 之和） */
  arrangedGroups: number;
  /** 其中被跳过的组数 */
  skippedGroups: number;
  /** 实际完成的完整有效正式组数（不受原计划组数封顶） */
  completedSets: number;
  /** R02：完整大组对应的真实阶段行数（按每个完整轮自己的 stageCount 求和） */
  completedStages: number;
  /** 已做但缺数据、不计入完整有效组的组数 */
  incompleteSets: number;
  /** 部分完成的递减大组数 */
  partialGroups: number;
  /** 原计划目标组数（快照，不随临时加组改变） */
  targetSets: number;
  /** 本次实际安排的组数（含临时加组、减去临时删组） */
  plannedSets: number;
  /** R02：本次实际安排的阶段行数（按各轮真实 stageCount 求和） */
  plannedStages: number;
  /** 动作：完整有效完成 / 部分完成 / 跳过 / 未记录 */
  exercisesDone: number;
  exercisesPartial: number;
  exercisesSkipped: number;
  exercisesPending: number;
  /** 总时长（减去暂停） */
  durationMs: number;
  totalSets: number;
  /** 有氧有效总时长（从 entries 派生；与 durationMs 分别计算、不相加） */
  cardioMs: number;
}

/** 单个动作的完成状态（与汇总使用同一判定来源） */
export type ExerciseCompletion = 'done' | 'partial' | 'skipped' | 'pending';
