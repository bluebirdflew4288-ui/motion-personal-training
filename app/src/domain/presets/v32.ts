/* 三分化训练计划 V3.2 —— 唯一数据来源：正式 PDF
   deliver/FashionEditorial_V3.2_Final.pdf（P01 循环 / P02 热身 / P03–P08 六个训练日 / P09 侧平举）

   逐条核对记录（PDF → 本文件）：
   · 组数下界求和与 PDF 标注一致：胸A 17 / 背A 16–17 / 腿A 20 / 胸B 17 / 背B 17–20 / 腿B 20
   · 侧平举「3 轮」按 3 个正式大组计入（PDF P09：三轮 = 三个正式大组，不是九个普通正式组）
   · 所有热身不计入正式组数 */

import type { Plan, PlanDay, PlanExercise, WarmupTarget } from '../types';
import { exerciseIdFromName } from '../identity';

const uid = (s: string) => s;

const rest = (sec: number) => sec;

/* ── 热身（PDF P02）───────────────────────── */

const CHEST_WARMUP: WarmupTarget[] = [
  { id: uid('w-chest-1'), name: '弹力带水平拉开', en: 'BAND PULL-APART', unit: 'reps', targetText: '2 × 10–15' },
  { id: uid('w-chest-2'), name: '弹力带绕肩', en: 'BAND PASS-THROUGH', unit: 'reps', targetText: '1–2 × 8–12' },
  { id: uid('w-chest-3'), name: '辅助双杠臂屈伸', en: 'ASSISTED DIP', unit: 'reps', targetText: '1 × 5–8' },
  { id: uid('w-chest-4'), name: '卧推轻重量递增', en: 'BENCH RAMP-UP', unit: 'reps', targetText: '1–2 组 · 按需', optional: true },
];

const BACK_WARMUP: WarmupTarget[] = [
  { id: uid('w-back-1'), name: '跪姿肘撑肩胛控制', en: 'KNEELING SCAPULAR', unit: 'breath', targetText: '2 组 × 约 10 次呼吸' },
  { id: uid('w-back-2'), name: '动态平板支撑屈髋', en: 'PLANK HIP FLEXION', unit: 'reps', targetText: '2 × 15' },
];

const LEGS_WARMUP: WarmupTarget[] = [
  { id: uid('w-legs-1'), name: '跑步机坡走', en: 'INCLINE WALK', unit: 'time', targetText: '5–8 分钟' },
  { id: uid('w-legs-2'), name: '徒手深蹲', en: 'BODYWEIGHT SQUAT', unit: 'reps', targetText: '1 × 8–12 · 按需', optional: true },
  { id: uid('w-legs-3'), name: '哈克 / 倒蹬递增热身', en: 'RAMP-UP SETS', unit: 'reps', targetText: '40–50%×8–10 → 60–70%×4–6 → 80–85%×2–3' },
];

/* ── 动作构造器 ───────────────────────────── */

function straight(
  id: string,
  name: string,
  en: string,
  sets: number,
  setsMax: number,
  repsMin: number,
  repsMax: number,
  restSec: number,
  opts: Partial<Pick<PlanExercise, 'note' | 'substitutes'>> & {
    weightMode?: 'external' | 'bodyweight' | 'bodyweight_plus' | 'assisted';
    suggestedWeightKg?: number | null;
    dumbbellBasis?: 'per_hand' | 'total';
  } = {},
): PlanExercise {
  return {
    id,
    exerciseId: exerciseIdFromName(name),
    name,
    en,
    restSec,
    note: opts.note,
    substitutes: opts.substitutes,
    target: {
      kind: 'straight',
      sets,
      setsMax,
      repsMin,
      repsMax,
      weightMode: opts.weightMode ?? 'external',
      suggestedWeightKg: opts.suggestedWeightKg ?? null,
      dumbbellBasis: opts.dumbbellBasis,
    },
  };
}

/* 哑铃侧平举 —— PDF P09 特殊结构 */
const LATERAL_RAISE: PlanExercise = {
  id: 'ex-lateral',
  exerciseId: 'lib-lateral-raise',
  name: '哑铃侧平举',
  en: 'DB LATERAL RAISE',
  restSec: rest(180),
  note: '三轮 = 三个正式大组；阶段间休 10–30 秒，轮间至少 3 分钟。侧平举专项热身不计入正式组。',
  target: {
    kind: 'dropSet',
    rounds: 3,
    weightMode: 'external',
    dumbbellBasis: 'per_hand',
    restInSec: 20,
    restAfterSec: 180,
    stages: [
      { label: '第一阶段', weightKg: 7.5, repsMin: 10, repsMax: 16, toFailure: false, targetText: '7.5 kg · 10–16 次' },
      { label: '第二阶段', weightKg: 5, repsMin: 10, repsMax: 16, toFailure: false, targetText: '5 kg · 10–16 次' },
      { label: '第三阶段', weightKg: 5, repsMin: null, repsMax: null, toFailure: true, targetText: '5 kg · 技术性力竭' },
    ],
  },
};

/* ── 六个训练日（PDF P03–P08）─────────────── */

const CHEST_A: PlanDay = {
  id: 'day-chest-a',
  name: '胸 A',
  focus: 'chest',
  round: 'A',
  kind: 'train',
  warmups: CHEST_WARMUP,
  exercises: [
    straight('ex-ca-1', '双杠臂屈伸', 'CHEST DIP', 3, 3, 6, 10, rest(150), { weightMode: 'bodyweight_plus' }),
    straight('ex-ca-2', '自由杠铃卧推', 'BARBELL BENCH PRESS', 3, 3, 6, 10, rest(180), {
      substitutes: ['哑铃卧推'],
    }),
    straight('ex-ca-3', '史密斯上斜卧推', 'SMITH INCLINE PRESS', 2, 2, 8, 12, rest(120), {
      substitutes: ['上斜哑铃卧推'],
    }),
    straight('ex-ca-4', '蝴蝶机夹胸', 'PEC DECK FLY', 1, 1, 12, 15, rest(75)),
    straight('ex-ca-5', '器械推肩', 'MACHINE SHOULDER PRESS', 2, 2, 10, 12, rest(90)),
    straight('ex-ca-6', '绳索下压', 'CABLE PUSHDOWN', 2, 2, 10, 15, rest(75)),
    straight('ex-ca-7', '哑铃颈后臂屈伸', 'OVERHEAD DB EXTENSION', 2, 2, 10, 15, rest(90), { dumbbellBasis: 'per_hand' }),
    straight('ex-ca-8', '绳索卷腹', 'CABLE CRUNCH', 2, 2, 15, 25, rest(60)),
  ],
};

const CHEST_B: PlanDay = {
  id: 'day-chest-b',
  name: '胸 B',
  focus: 'chest',
  round: 'B',
  kind: 'train',
  warmups: CHEST_WARMUP,
  exercises: [
    straight('ex-cb-1', '双杠臂屈伸', 'CHEST DIP', 2, 2, 8, 12, rest(120), { weightMode: 'bodyweight_plus' }),
    straight('ex-cb-2', '自由杠铃卧推', 'BARBELL BENCH PRESS', 3, 3, 8, 12, rest(150), {
      substitutes: ['哑铃卧推'],
    }),
    straight('ex-cb-3', '史密斯上斜卧推', 'SMITH INCLINE PRESS', 2, 2, 10, 15, rest(90), {
      substitutes: ['片挂式上斜推胸'],
    }),
    straight('ex-cb-4', '蝴蝶机夹胸', 'PEC DECK FLY', 2, 2, 12, 20, rest(75)),
    straight('ex-cb-5', '器械推肩', 'MACHINE SHOULDER PRESS', 2, 2, 12, 15, rest(90)),
    straight('ex-cb-6', '绳索下压', 'CABLE PUSHDOWN', 2, 2, 12, 15, rest(75)),
    straight('ex-cb-7', '哑铃颈后臂屈伸', 'OVERHEAD DB EXTENSION', 2, 2, 12, 15, rest(90), { dumbbellBasis: 'per_hand' }),
    straight('ex-cb-8', '悬垂举腿', 'HANGING LEG RAISE', 2, 2, 10, 15, rest(60), { weightMode: 'bodyweight' }),
  ],
};

const BACK_A: PlanDay = {
  id: 'day-back-a',
  name: '背 A',
  focus: 'back',
  round: 'A',
  kind: 'train',
  warmups: BACK_WARMUP,
  exercises: [
    straight('ex-ba-1', '正手宽握引体向上', 'WIDE-GRIP PULL-UP', 4, 4, 8, 12, rest(210), { weightMode: 'bodyweight_plus' }),
    straight('ex-ba-2', '分体悍马划船', 'HAMMER ROW', 3, 3, 8, 12, rest(120), {
      substitutes: ['胸托划船', '坐姿绳索划船'],
    }),
    straight('ex-ba-3', '中立握高位下拉', 'NEUTRAL-GRIP PULLDOWN', 1, 2, 10, 12, rest(120)),
    straight('ex-ba-4', '面拉', 'FACE PULL', 2, 2, 12, 20, rest(75)),
    straight('ex-ba-5', '固定器械二头弯举', 'MACHINE CURL', 2, 2, 10, 12, rest(90)),
    straight('ex-ba-6', '哑铃锤式弯举', 'HAMMER CURL', 2, 2, 10, 15, rest(90), { dumbbellBasis: 'per_hand' }),
    straight('ex-ba-7', '悬垂举腿', 'HANGING LEG RAISE', 2, 2, 10, 15, rest(60), { weightMode: 'bodyweight' }),
  ],
};

const BACK_B: PlanDay = {
  id: 'day-back-b',
  name: '背 B',
  focus: 'back',
  round: 'B',
  kind: 'train',
  warmups: BACK_WARMUP,
  exercises: [
    straight('ex-bb-1', '正手宽握引体向上', 'WIDE-GRIP PULL-UP', 4, 4, 8, 12, rest(210), { weightMode: 'bodyweight_plus' }),
    straight('ex-bb-2', '胸托划船', 'CHEST-SUPPORTED ROW', 3, 3, 10, 12, rest(120), {
      substitutes: ['分体悍马划船'],
    }),
    straight('ex-bb-3', '大剪刀弧线下拉', 'ARC PULLDOWN', 1, 2, 12, 15, rest(120)),
    straight('ex-bb-4', '绳索直臂下拉', 'STRAIGHT-ARM PULLDOWN', 0, 2, 12, 15, rest(90), {
      note: '不是必须完成，按当天状态决定是否增加。',
    }),
    straight('ex-bb-5', '反向蝴蝶机飞鸟', 'REVERSE PEC DECK', 3, 3, 12, 20, rest(75)),
    straight('ex-bb-6', '上斜哑铃弯举', 'INCLINE DB CURL', 2, 2, 10, 15, rest(90), { dumbbellBasis: 'per_hand' }),
    straight('ex-bb-7', '哑铃锤式弯举', 'HAMMER CURL', 2, 2, 12, 15, rest(90), { dumbbellBasis: 'per_hand' }),
    straight('ex-bb-8', '绳索卷腹', 'CABLE CRUNCH', 2, 2, 15, 25, rest(60)),
  ],
};

const LEGS_A: PlanDay = {
  id: 'day-legs-a',
  name: '腿 A',
  focus: 'legs',
  round: 'A',
  kind: 'train',
  warmups: LEGS_WARMUP,
  exercises: [
    straight('ex-la-1', '正向哈克深蹲', 'HACK SQUAT', 3, 3, 6, 10, rest(150)),
    straight('ex-la-2', '坐姿腿屈伸', 'LEG EXTENSION', 2, 2, 10, 12, rest(90)),
    straight('ex-la-3', '坐姿腿弯举', 'SEATED LEG CURL', 3, 3, 10, 12, rest(90)),
    straight('ex-la-4', '哈克提踵', 'HACK SQUAT CALF RAISE', 2, 2, 10, 15, rest(75)),
    straight('ex-la-5', '坐姿髋内收机', 'HIP ADDUCTION', 2, 2, 10, 15, rest(75)),
    { ...LATERAL_RAISE },
    straight('ex-la-7', '绳索卷腹', 'CABLE CRUNCH', 2, 2, 15, 25, rest(60)),
    straight('ex-la-8', '正手抬腕', 'REVERSE WRIST CURL', 3, 3, 15, 20, rest(75)),
  ],
};

const LEGS_B: PlanDay = {
  id: 'day-legs-b',
  name: '腿 B',
  focus: 'legs',
  round: 'B',
  kind: 'train',
  warmups: LEGS_WARMUP,
  exercises: [
    straight('ex-lb-1', '倒蹬', 'LEG PRESS', 3, 3, 10, 15, rest(120)),
    straight('ex-lb-2', '坐姿腿屈伸', 'LEG EXTENSION', 2, 2, 12, 15, rest(90)),
    straight('ex-lb-3', '坐姿腿弯举', 'SEATED LEG CURL', 3, 3, 12, 15, rest(90)),
    straight('ex-lb-4', '哈克提踵', 'HACK SQUAT CALF RAISE', 2, 2, 12, 20, rest(75)),
    straight('ex-lb-5', '坐姿髋内收机', 'HIP ADDUCTION', 2, 2, 12, 20, rest(75)),
    { ...LATERAL_RAISE, id: 'ex-lateral-b' },
    straight('ex-lb-7', '悬垂举腿', 'HANGING LEG RAISE', 2, 2, 10, 15, rest(60), { weightMode: 'bodyweight' }),
    straight('ex-lb-8', '反手抬腕', 'WRIST CURL', 3, 3, 15, 25, rest(75)),
  ],
};

/* 恢复 / 休息（PDF P01 第 04、08 日） */
const REST_DAY: PlanDay = {
  id: 'day-rest',
  name: '恢复',
  focus: 'chest',
  round: 'A',
  kind: 'rest',
  restNote: '睡眠 · 步行 · 放松，不做抗阻训练。',
  warmups: [],
  exercises: [],
};

const FULL_REST_DAY: PlanDay = {
  id: 'day-full-rest',
  name: '完全休息',
  focus: 'chest',
  round: 'A',
  kind: 'rest',
  restNote: '不做抗阻训练。',
  warmups: [],
  exercises: [],
};

export const V32_PRESET_ID = 'v3.2';

export function createV32Plan(now = Date.now()): Plan {
  return {
    id: 'plan-v32',
    name: '三分化训练计划 V3.2',
    presetId: V32_PRESET_ID,
    cursor: 0,
    createdAt: now,
    updatedAt: now,
    days: [
      CHEST_A,
      BACK_A,
      LEGS_A,
      { ...REST_DAY, id: 'day-rest-1', name: '恢复' },
      CHEST_B,
      BACK_B,
      LEGS_B,
      { ...FULL_REST_DAY, id: 'day-rest-2', name: '完全休息' },
    ],
  };
}

/** 供测试与文档使用：按 PDF 标注核对各日目标正式组数（下限/上限） */
export function expectedSetRange(day: PlanDay): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const ex of day.exercises) {
    if (ex.target.kind === 'straight') {
      min += ex.target.sets;
      max += ex.target.setsMax;
    } else {
      // 递减组：轮数即正式大组数
      min += ex.target.rounds;
      max += ex.target.rounds;
    }
  }
  return { min, max };
}
