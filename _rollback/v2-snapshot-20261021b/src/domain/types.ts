/* MOTION 领域模型 —— 计划、训练实例与记录。
   设计约束：
   1) 训练实例在「开始训练」时对计划日做快照，之后改计划不会回写历史。
   2) 目标值（target）与实际值（session）分属两个类型，绝不混用。
   3) 未填写用 null，实际为零用 0。 */

export type WeightMode = 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted';
export type DumbbellBasis = 'per_hand' | 'total';

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
}

export interface DropStageTarget {
  label: string;
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  /** 目标是「技术性力竭」时，实际仍记录完成次数 */
  toFailure: boolean;
  targetText: string;
}

export interface DropSetTarget {
  kind: 'dropSet';
  rounds: number;
  stages: DropStageTarget[];
  restInSec: number;
  restAfterSec: number;
  weightMode: WeightMode;
  dumbbellBasis?: DumbbellBasis;
}

export type ExerciseTarget = StraightTarget | DropSetTarget;

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
  /** V3.2 中被标记为可替代的动作 */
  substitutes?: string[];
}

export interface PlanDay {
  id: string;
  /** 训练日名称，例如 胸 A */
  name: string;
  /** 分部：胸 / 背 / 腿，用于贴纸选择与配色 */
  focus: 'chest' | 'back' | 'legs';
  round: 'A' | 'B';
  kind: 'train' | 'rest';
  restNote?: string;
  warmups: WarmupTarget[];
  exercises: PlanExercise[];
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

export interface SessionExercise {
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
  sets: SessionSet[];
  note?: string;
  /** 临时替换时记录原动作名 */
  replacedFrom?: string;
  /** 是否本次临时新增 */
  added?: boolean;
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
  focus: 'chest' | 'back' | 'legs';
  round: 'A' | 'B';
  partText: string;
}

export type SessionStatus = 'active' | 'completed' | 'discarded';

export interface Session {
  id: string;
  planId: string;
  /** 快照：即使计划被改名、改动作、删除，历史仍可读 */
  planName: string;
  day: SessionSnapshotDay;
  /** 开始训练时循环游标所在位置（0-based） */
  cycleIndexAtStart: number;
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
}

/* ── 统计口径 ─────────────────────────────── */

export interface SessionSummary {
  /** 实际完成的完整有效正式组数（不受原计划组数封顶） */
  completedSets: number;
  /** 已做但缺数据、不计入完整有效组的组数 */
  incompleteSets: number;
  /** 部分完成的递减大组数 */
  partialGroups: number;
  /** 原计划目标组数（快照，不随临时加组改变） */
  targetSets: number;
  /** 本次实际安排的组数（含临时加组、减去临时删组） */
  plannedSets: number;
  /** 动作：完整有效完成 / 部分完成 / 跳过 / 未记录 */
  exercisesDone: number;
  exercisesPartial: number;
  exercisesSkipped: number;
  exercisesPending: number;
  /** 总时长（减去暂停） */
  durationMs: number;
  totalSets: number;
}

/** 单个动作的完成状态（与汇总使用同一判定来源） */
export type ExerciseCompletion = 'done' | 'partial' | 'skipped' | 'pending';
