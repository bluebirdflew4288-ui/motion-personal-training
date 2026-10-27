/* 本地日期键（完全休息的归属日）。
   ── 为什么不能用 UTC ────────────────────────────────────────
   `new Date().toISOString().slice(0, 10)` 得到的是 UTC 日期；
   在中国（UTC+8）凌晨 0–8 点会得到"昨天"，导致同日本地日去重失效。
   这里用**本地时区**的 y/m/d 拼出 'YYYY-MM-DD'。 */

export function localDateKey(ms: number = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 校验 'YYYY-MM-DD' 形状（不推断时区，只校验格式） */
export function isLocalDateKey(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  return true;
}
