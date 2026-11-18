/* 动作库：用于「搜索或输入新动作」。包含 V3.2 全部动作 + 常见替代动作。
   只用于选择名称，不携带目标值（新动作由用户当场设定）。
   Wave 2C：补充健身房常见俗称别名 aliases，并接入零依赖拼音首字母检索。 */

import { matchesPinyinInitials } from '../pinyinInitials';

export interface LibraryEntry {
  name: string;
  group: '胸' | '背' | '腿' | '肩' | '手臂' | '核心' | '其他';
  en?: string;
  /** 健身房常见俗称 / 简称（仅用于检索召回，不改变标准动作名与稳定 exerciseId） */
  aliases?: string[];
}

export const EXERCISE_LIBRARY: LibraryEntry[] = [
  { name: '自由杠铃卧推', group: '胸', en: 'BARBELL BENCH PRESS', aliases: ['平板卧推', '杠铃卧推', '平推'] },
  { name: '哑铃卧推', group: '胸', en: 'DUMBBELL BENCH PRESS', aliases: ['平板哑铃卧推', '哑铃平推'] },
  { name: '双杠臂屈伸', group: '胸', en: 'CHEST DIP', aliases: ['双杠', '臂屈伸', '辅助双杠'] },
  { name: '史密斯上斜卧推', group: '胸', en: 'SMITH INCLINE PRESS', aliases: ['史密斯上斜', '上斜史密斯'] },
  { name: '上斜哑铃卧推', group: '胸', en: 'INCLINE DB PRESS', aliases: ['上斜哑铃', '哑铃上斜'] },
  { name: '片挂式上斜推胸', group: '胸', aliases: ['挂片上斜推胸', '悍马上斜推胸', '器械上斜推胸'] },
  { name: '蝴蝶机夹胸', group: '胸', en: 'PEC DECK FLY', aliases: ['蝴蝶机', '坐姿夹胸', '夹胸机'] },
  { name: '绳索夹胸', group: '胸', en: 'CABLE FLYE', aliases: ['龙门架夹胸', '拉索夹胸', '大飞鸟'] },
  { name: '俯卧撑', group: '胸', en: 'PUSH-UP' },
  { name: '正手宽握引体向上', group: '背', en: 'WIDE-GRIP PULL-UP', aliases: ['引体向上', '宽握引体', '正手引体', '辅助引体'] },
  { name: '反手引体向上', group: '背', aliases: ['反握引体', '窄握引体', 'CHIN-UP'] },
  { name: '分体悍马划船', group: '背', en: 'HAMMER ROW', aliases: ['悍马划船', '悍马机划船', '挂片划船'] },
  { name: '胸托划船', group: '背', en: 'CHEST-SUPPORTED ROW', aliases: ['俯身胸托划船', '器械划船', 'T杆胸托划船'] },
  { name: '坐姿绳索划船', group: '背', aliases: ['坐姿划船', '拉索划船', '龙门架划船'] },
  { name: '杠铃划船', group: '背', aliases: ['俯身杠铃划船', '俯身划船', '潘德雷划船'] },
  { name: '中立握高位下拉', group: '背', en: 'NEUTRAL-GRIP PULLDOWN', aliases: ['对握下拉', '对握高位下拉', '窄握下拉', 'V把下拉'] },
  { name: '宽握高位下拉', group: '背', aliases: ['高位下拉', '正手高位下拉', '背阔肌下拉'] },
  { name: '大剪刀弧线下拉', group: '背', en: 'ARC PULLDOWN', aliases: ['弧线下拉', '单臂弧线下拉', '悍马下拉'] },
  { name: '绳索直臂下拉', group: '背', aliases: ['直臂下压', '直臂下拉', '龙门架直臂下压'] },
  { name: '面拉', group: '背', en: 'FACE PULL', aliases: ['绳索面拉', '龙门架面拉'] },
  { name: '反向蝴蝶机飞鸟', group: '背', aliases: ['蝴蝶机反向飞鸟', '后束蝴蝶机', '坐姿反向飞鸟'] },
  { name: '正向哈克深蹲', group: '腿', en: 'HACK SQUAT', aliases: ['哈克蹲', '哈克深蹲', '哈克机深蹲'] },
  { name: '倒蹬', group: '腿', en: 'LEG PRESS', aliases: ['腿举', '45度倒蹬', '器械腿举'] },
  { name: '杠铃深蹲', group: '腿', aliases: ['自由深蹲', '颈后深蹲', '高杠深蹲', '低杠深蹲'] },
  { name: '高脚杯深蹲', group: '腿', aliases: ['哑铃深蹲', '壶铃深蹲'] },
  { name: '坐姿腿屈伸', group: '腿', en: 'LEG EXTENSION', aliases: ['腿屈伸', '踢腿机', '股四头伸展'] },
  { name: '坐姿腿弯举', group: '腿', en: 'SEATED LEG CURL', aliases: ['腿弯举', '腘绳肌弯举'] },
  { name: '俯卧腿弯举', group: '腿', aliases: ['趴姿腿弯举', '卧姿腿弯举'] },
  { name: '罗马尼亚硬拉', group: '腿', aliases: ['RDL', '直腿硬拉', '杠铃RDL', '哑铃RDL'] },
  { name: '哈克提踵', group: '腿', en: 'HACK SQUAT CALF RAISE', aliases: ['小腿提踵', '器械提踵'] },
  { name: '站姿提踵', group: '腿', aliases: ['提踵', '小腿站姿提踵'] },
  { name: '坐姿髋内收机', group: '腿', en: 'HIP ADDUCTION', aliases: ['夹腿', '夹腿机', '大腿内侧机'] },
  { name: '坐姿髋外展机', group: '腿', aliases: ['外展机', '臀外展', '分腿机'] },
  { name: '保加利亚分腿蹲', group: '腿', aliases: ['保加利亚蹲', '单腿深蹲', '后脚抬高分腿蹲'] },
  { name: '哑铃侧平举', group: '肩', en: 'DB LATERAL RAISE', aliases: ['侧平举', '飞鸟侧平举'] },
  { name: '器械推肩', group: '肩', en: 'MACHINE SHOULDER PRESS', aliases: ['推肩机', '坐姿器械推肩', '肩推机'] },
  { name: '哑铃推肩', group: '肩', aliases: ['坐姿哑铃推肩', '哑铃肩推', '推举'] },
  { name: '反向飞鸟', group: '肩', aliases: ['俯身飞鸟', '哑铃后束飞鸟', '后束飞鸟'] },
  { name: '绳索下压', group: '手臂', en: 'CABLE PUSHDOWN', aliases: ['三头下压', '龙门架下压', '直杆下压'] },
  { name: '哑铃颈后臂屈伸', group: '手臂', en: 'OVERHEAD DB EXTENSION', aliases: ['颈后臂屈伸', '过顶臂屈伸', '三头臂屈伸'] },
  { name: '窄距卧推', group: '手臂', aliases: ['窄握卧推', '三头卧推'] },
  { name: '固定器械二头弯举', group: '手臂', en: 'MACHINE CURL', aliases: ['牧师凳弯举', '器械弯举', '二头弯举机'] },
  { name: '哑铃锤式弯举', group: '手臂', en: 'HAMMER CURL', aliases: ['锤式弯举', '对握弯举'] },
  { name: '上斜哑铃弯举', group: '手臂', en: 'INCLINE DB CURL', aliases: ['上斜弯举', '二头弯举'] },
  { name: '绳索卷腹', group: '核心', en: 'CABLE CRUNCH', aliases: ['龙门架卷腹', '跪姿卷腹'] },
  { name: '悬垂举腿', group: '核心', en: 'HANGING LEG RAISE', aliases: ['单杠举腿', '悬垂提膝'] },
  { name: '平板支撑', group: '核心', aliases: ['PLANK'] },
  { name: '腹轮', group: '核心', aliases: ['健腹轮'] },
  { name: '正手抬腕', group: '手臂', en: 'REVERSE WRIST CURL', aliases: ['反握腕弯举', '前臂伸肌'] },
  { name: '反手抬腕', group: '手臂', en: 'WRIST CURL', aliases: ['腕弯举', '小臂弯举'] },
  { name: '跑步机坡走', group: '其他', en: 'INCLINE WALK', aliases: ['爬坡', '坡度走'] },
  { name: '弹力带水平拉开', group: '其他', en: 'BAND PULL-APART', aliases: ['弹力带拉开'] },
  { name: '弹力带绕肩', group: '其他', aliases: ['弹力带肩绕环'] },
  { name: '跪姿肘撑肩胛控制', group: '其他', aliases: ['前锯肌激活', '肩胛前引'] },
  { name: '动态平板支撑屈髋', group: '其他' },
  { name: '徒手深蹲', group: '腿', aliases: ['自重深蹲', '空手深蹲'] },
];

export function searchExercises(q: string): LibraryEntry[] {
  const raw = q.trim();
  if (!raw) return EXERCISE_LIBRARY;
  const key = raw.toLowerCase();
  const scored: Array<{ entry: LibraryEntry; tier: number; idx: number }> = [];
  EXERCISE_LIBRARY.forEach((e, idx) => {
    const nameLower = e.name.toLowerCase();
    let tier = 99;
    if (nameLower.startsWith(key)) {
      tier = 0;
    } else if (nameLower.includes(key)) {
      tier = 1;
    } else if (matchesPinyinInitials(e.name, raw)) {
      tier = 2;
    } else if (e.aliases?.some((a) => a.toLowerCase().includes(key) || matchesPinyinInitials(a, raw))) {
      tier = 3;
    } else if (e.group.includes(raw)) {
      tier = 4;
    } else if ((e.en ?? '').toLowerCase().includes(key)) {
      tier = 5;
    }
    if (tier < 99) scored.push({ entry: e, tier, idx });
  });
  scored.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.idx - b.idx));
  return scored.map((s) => s.entry);
}
