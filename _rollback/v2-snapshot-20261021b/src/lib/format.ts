/* 日期与时长格式化。所有日期来自设备真实时间，不硬编码。 */

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export function fmtDateShort(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
}

export function fmtWeekday(ts: number): string {
  return WEEKDAYS[new Date(ts).getDay()] ?? '';
}

export function fmtDateWithWeek(ts: number): string {
  return `${fmtDate(ts)} ${fmtWeekday(ts)}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 时长：12 分 30 秒 → 12:30；超过一小时 → 1:12:30 */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

/** 计时器显示：MM:SS（休息倒计时） */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

export function fmtRest(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}

/** ISO 周序号，用于「每周频率」统计（周一为一周开始） */
export function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (target.getDay() + 6) % 7; // 周一 = 0
  target.setDate(target.getDate() - dayNum + 3); // 该周周四
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${target.getFullYear()}-W${pad2(week)}`;
}

/** 同一天判定（本地时区） */
export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
  );
}

export function fmtRelativeDay(ts: number, now = Date.now()): string {
  if (isSameDay(ts, now)) return '今天';
  if (isSameDay(ts, now - 86400000)) return '昨天';
  if (isSameDay(ts, now - 2 * 86400000)) return '前天';
  return fmtDate(ts);
}

/** 重量显示：去掉多余的 .0 */
export function fmtWeight(kg: number | null): string {
  if (kg === null || kg === undefined) return '—';
  return Number.isInteger(kg) ? `${kg}` : `${Number(kg.toFixed(2))}`;
}
