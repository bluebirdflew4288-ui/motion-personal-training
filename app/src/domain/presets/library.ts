/* 动作库：用于「搜索或输入新动作」。包含 V3.2 全部动作 + 常见替代动作。
   只用于选择名称，不携带目标值（新动作由用户当场设定）。 */

export interface LibraryEntry {
  name: string;
  group: '胸' | '背' | '腿' | '肩' | '手臂' | '核心' | '其他';
  en?: string;
}

export const EXERCISE_LIBRARY: LibraryEntry[] = [
  { name: '自由杠铃卧推', group: '胸', en: 'BARBELL BENCH PRESS' },
  { name: '哑铃卧推', group: '胸', en: 'DUMBBELL BENCH PRESS' },
  { name: '双杠臂屈伸', group: '胸', en: 'CHEST DIP' },
  { name: '史密斯上斜卧推', group: '胸', en: 'SMITH INCLINE PRESS' },
  { name: '上斜哑铃卧推', group: '胸', en: 'INCLINE DB PRESS' },
  { name: '片挂式上斜推胸', group: '胸' },
  { name: '蝴蝶机夹胸', group: '胸', en: 'PEC DECK FLY' },
  { name: '绳索夹胸', group: '胸', en: 'CABLE FLYE' },
  { name: '俯卧撑', group: '胸', en: 'PUSH-UP' },
  { name: '正手宽握引体向上', group: '背', en: 'WIDE-GRIP PULL-UP' },
  { name: '反手引体向上', group: '背' },
  { name: '分体悍马划船', group: '背', en: 'HAMMER ROW' },
  { name: '胸托划船', group: '背', en: 'CHEST-SUPPORTED ROW' },
  { name: '坐姿绳索划船', group: '背' },
  { name: '杠铃划船', group: '背' },
  { name: '中立握高位下拉', group: '背', en: 'NEUTRAL-GRIP PULLDOWN' },
  { name: '宽握高位下拉', group: '背' },
  { name: '大剪刀弧线下拉', group: '背', en: 'ARC PULLDOWN' },
  { name: '绳索直臂下拉', group: '背' },
  { name: '面拉', group: '背', en: 'FACE PULL' },
  { name: '反向蝴蝶机飞鸟', group: '背' },
  { name: '正向哈克深蹲', group: '腿', en: 'HACK SQUAT' },
  { name: '倒蹬', group: '腿', en: 'LEG PRESS' },
  { name: '杠铃深蹲', group: '腿' },
  { name: '高脚杯深蹲', group: '腿' },
  { name: '坐姿腿屈伸', group: '腿', en: 'LEG EXTENSION' },
  { name: '坐姿腿弯举', group: '腿', en: 'SEATED LEG CURL' },
  { name: '俯卧腿弯举', group: '腿' },
  { name: '罗马尼亚硬拉', group: '腿' },
  { name: '哈克提踵', group: '腿', en: 'HACK SQUAT CALF RAISE' },
  { name: '站姿提踵', group: '腿' },
  { name: '坐姿髋内收机', group: '腿', en: 'HIP ADDUCTION' },
  { name: '坐姿髋外展机', group: '腿' },
  { name: '保加利亚分腿蹲', group: '腿' },
  { name: '哑铃侧平举', group: '肩', en: 'DB LATERAL RAISE' },
  { name: '器械推肩', group: '肩', en: 'MACHINE SHOULDER PRESS' },
  { name: '哑铃推肩', group: '肩' },
  { name: '反向飞鸟', group: '肩' },
  { name: '绳索下压', group: '手臂', en: 'CABLE PUSHDOWN' },
  { name: '哑铃颈后臂屈伸', group: '手臂', en: 'OVERHEAD DB EXTENSION' },
  { name: '窄距卧推', group: '手臂' },
  { name: '固定器械二头弯举', group: '手臂', en: 'MACHINE CURL' },
  { name: '哑铃锤式弯举', group: '手臂', en: 'HAMMER CURL' },
  { name: '上斜哑铃弯举', group: '手臂', en: 'INCLINE DB CURL' },
  { name: '绳索卷腹', group: '核心', en: 'CABLE CRUNCH' },
  { name: '悬垂举腿', group: '核心', en: 'HANGING LEG RAISE' },
  { name: '平板支撑', group: '核心' },
  { name: '腹轮', group: '核心' },
  { name: '正手抬腕', group: '手臂', en: 'REVERSE WRIST CURL' },
  { name: '反手抬腕', group: '手臂', en: 'WRIST CURL' },
  { name: '跑步机坡走', group: '其他', en: 'INCLINE WALK' },
  { name: '弹力带水平拉开', group: '其他', en: 'BAND PULL-APART' },
  { name: '弹力带绕肩', group: '其他' },
  { name: '跪姿肘撑肩胛控制', group: '其他' },
  { name: '动态平板支撑屈髋', group: '其他' },
  { name: '徒手深蹲', group: '腿' },
];

export function searchExercises(q: string): LibraryEntry[] {
  const key = q.trim().toLowerCase();
  if (!key) return EXERCISE_LIBRARY;
  return EXERCISE_LIBRARY.filter(
    (e) => e.name.toLowerCase().includes(key) || (e.en ?? '').toLowerCase().includes(key) || e.group.includes(key),
  );
}
