/* 有氧计时模型（第2阶段）。
   ── 唯一真源 ────────────────────────────────────────────────
   · elapsedMs      上次结算时已累计的**有效毫秒**，从 0 开始
   · runningSinceAt 运行时的**墙钟** Date.now() 锚点；未运行为 null
   · 当前有效时长 = elapsedMs + max(0, now - runningSinceAt)
   不设第二套暂停累计量；有氧总量从 entries 派生。

   ── 坐标 ────────────────────────────────────────────────────
   分段起止统一用「该 entry 从 0 开始的有效 elapsed 坐标」，
   不是 epoch，也不是经 session 总暂停修正的墙钟。

   ── 不变量（可证，见 assertCardioEntry）──────────────────────
   1. 所有端点都在 [0, liveElapsed] 内
   2. 段按 start 升序、相邻首尾相接（prev.end === next.start）、不重叠、无负时长
   3. Σ(段时长) === liveElapsed
   4. 至多一个 open 段，且仅当 status==='running'

   ── 参数规范（PHASE-2-APPROVAL §2）──────────────────────────
   坡走只用 speedKmh + inclinePct；爬楼只用 level。
   不适用的字段**缺省**（不写 null/undefined 两套）。 */

import {
  MAX_CARDIO_MS,
  MAX_CARDIO_SEGMENTS,
  MAX_INCLINE_PCT,
  MAX_SPEED_KMH,
  MAX_STAIR_LEVEL,
  MIN_INCLINE_PCT,
  MIN_SPEED_KMH,
  MIN_STAIR_LEVEL,
} from './limits';
import type {
  CardioEntry,
  CardioParams,
  CardioPreset,
  CardioSegment,
  CardioStatus,
} from './types';

export const newCardioId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/* ── 预设与参数 ─────────────────────────── */

export const CARDIO_PRESET_LABEL: Record<CardioPreset, string> = {
  'treadmill-incline': '有氧爬坡',
  'stair-climber': '爬楼机',
};

/** 某预设实际使用的参数键（唯一真源，校验与 UI 共用） */
export function paramKeysOf(preset: CardioPreset): Array<keyof CardioParams> {
  return preset === 'treadmill-incline' ? ['speedKmh', 'inclinePct'] : ['level'];
}

export interface ParamIssue {
  field: keyof CardioParams;
  message: string;
}

/**
 * 校验参数（按 preset 拒绝错误字段/单位/超限）。
 * 不做静默 clamp —— 非法值一律明确拒绝。
 */
export function validateCardioParams(
  preset: CardioPreset,
  p: CardioParams,
): ParamIssue[] {
  const issues: ParamIssue[] = [];
  const allowed = new Set(paramKeysOf(preset));

  // 不适用字段必须缺省（拒绝混用）
  for (const key of ['speedKmh', 'inclinePct', 'level'] as const) {
    const v = p[key];
    if (v === undefined) continue;
    if (!allowed.has(key)) {
      issues.push({ field: key, message: `${CARDIO_PRESET_LABEL[preset]} 不使用该参数` });
    }
  }

  const checkNum = (
    key: keyof CardioParams,
    min: number,
    max: number,
    integer: boolean,
    label: string,
  ) => {
    if (!allowed.has(key)) return;
    const v = p[key];
    if (v === undefined || v === null) {
      issues.push({ field: key, message: `${label}必须填写` });
      return;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ field: key, message: `${label}必须是有限数字` });
      return;
    }
    if (integer && !Number.isInteger(v)) {
      issues.push({ field: key, message: `${label}必须是整数` });
      return;
    }
    if (v < min || v > max) {
      issues.push({ field: key, message: `${label}必须在 ${min}–${max} 之间` });
    }
  };

  if (preset === 'treadmill-incline') {
    checkNum('speedKmh', MIN_SPEED_KMH, MAX_SPEED_KMH, false, '速度');
    checkNum('inclinePct', MIN_INCLINE_PCT, MAX_INCLINE_PCT, false, '坡度');
  } else {
    checkNum('level', MIN_STAIR_LEVEL, MAX_STAIR_LEVEL, true, '档位');
  }
  return issues;
}

/** 归一化为「只含该预设实际字段」的参数对象（缺省语义，不写 null） */
export function normalizeCardioParams(preset: CardioPreset, p: CardioParams): CardioParams {
  if (preset === 'treadmill-incline') {
    const out: CardioParams = {};
    if (typeof p.speedKmh === 'number') out.speedKmh = p.speedKmh;
    if (typeof p.inclinePct === 'number') out.inclinePct = p.inclinePct;
    return out;
  }
  const out: CardioParams = {};
  if (typeof p.level === 'number') out.level = p.level;
  return out;
}

/** 参数深比较（同值不增段） */
export function paramsEqual(a: CardioParams, b: CardioParams): boolean {
  return (
    a.speedKmh === b.speedKmh && a.inclinePct === b.inclinePct && a.level === b.level
  );
}

/** 参数的一句话展示（单位清楚） */
export function describeCardioParams(preset: CardioPreset, p: CardioParams): string {
  if (preset === 'treadmill-incline') {
    const sp = typeof p.speedKmh === 'number' ? `${p.speedKmh} km/h` : '—';
    const inc = typeof p.inclinePct === 'number' ? `坡度 ${p.inclinePct}%` : '坡度 —';
    return `${sp} · ${inc}`;
  }
  return typeof p.level === 'number' ? `档位 ${p.level}` : '档位 —';
}

/* ── 计时 ───────────────────────────────── */

/**
 * 当前有效毫秒。
 *
 * 墙钟 `Date.now()` **不是单调时钟**：用户改系统时间可能让增量为负。
 * 负增量按 0 处理（不倒扣已累计时间），非法锚点视为未运行。
 */
export function liveElapsedMs(e: CardioEntry, now = Date.now()): number {
  const base = Number.isFinite(e.elapsedMs) && e.elapsedMs > 0 ? e.elapsedMs : 0;
  if (e.status !== 'running') return base;
  if (e.runningSinceAt === null || !Number.isFinite(e.runningSinceAt)) return base;
  const delta = now - e.runningSinceAt;
  if (!Number.isFinite(delta) || delta <= 0) return base;
  return Math.min(MAX_CARDIO_MS, base + delta);
}

/** 当前 open 段（没有则 null） */
export function openSegment(e: CardioEntry): CardioSegment | null {
  for (let i = e.segments.length - 1; i >= 0; i -= 1) {
    if (e.segments[i].endElapsedMs === null) return e.segments[i];
  }
  return null;
}

function closeOpen(e: CardioEntry, elapsed: number): CardioSegment[] {
  return e.segments.map((seg) =>
    seg.endElapsedMs === null ? { ...seg, endElapsedMs: elapsed } : seg,
  );
}

/** 创建新 entry（从 0 开始，未启动） */
export function createCardioEntry(args: {
  preset: CardioPreset;
  name: string;
  params: CardioParams;
  planCardioId?: string | null;
  target?: CardioParams | null;
}): CardioEntry {
  return {
    id: newCardioId('cardio'),
    preset: args.preset,
    name: args.name,
    planCardioId: args.planCardioId ?? null,
    target: args.target ?? null,
    elapsedMs: 0,
    runningSinceAt: null,
    status: 'pending',
    currentParams: normalizeCardioParams(args.preset, args.params),
    segments: [],
  };
}

/**
 * 开始计时（00:00 起，无目标时长）。
 * 已运行时重复调用是幂等的（不重复开段）。
 */
export function startCardio(e: CardioEntry, now = Date.now()): CardioEntry {
  if (e.status === 'running') return e;
  const elapsed = liveElapsedMs(e, now);
  const base = closeOpen(e, elapsed);
  // 从当前有效端点开第一段
  const seg: CardioSegment = {
    id: newCardioId('cseg'),
    startElapsedMs: elapsed,
    endElapsedMs: null,
    params: { ...e.currentParams },
  };
  return {
    ...e,
    status: 'running',
    elapsedMs: elapsed,
    runningSinceAt: now,
    segments: [...base, seg],
  };
}

/**
 * 提交参数（滑杆松手 / 精确输入确认）。
 *
 * · 同值 → **不增段**
 * · 参数变化**不暂停、不重置计时**
 * · 达段数上限 → 拒绝（返回 { ok:false }），currentParams 与已有段均不改，计时继续
 */
export function commitCardioParams(
  e: CardioEntry,
  params: CardioParams,
  now = Date.now(),
): { ok: true; entry: CardioEntry } | { ok: false; reason: string } {
  const nextParams = normalizeCardioParams(e.preset, params);
  if (paramsEqual(nextParams, e.currentParams)) {
    // 同值：不产生新段（计时继续）
    return { ok: true, entry: e };
  }
  if (e.segments.length >= MAX_CARDIO_SEGMENTS) {
    /**
     * 上限：拒绝需要新段的参数变化。
     * currentParams 与已有段都不改，计时继续 —— 不能偷偷改变强度。
     */
    return { ok: false, reason: `分段已达上限 ${MAX_CARDIO_SEGMENTS}，无法再记录新的参数变化` };
  }

  if (e.status !== 'running') {
    // 暂停/未开始时改参数：只更新 currentParams，不开段、不计时
    return { ok: true, entry: { ...e, currentParams: nextParams } };
  }

  const elapsed = liveElapsedMs(e, now);
  const base = closeOpen(e, elapsed);
  const seg: CardioSegment = {
    id: newCardioId('cseg'),
    startElapsedMs: elapsed,
    endElapsedMs: null,
    params: { ...nextParams },
  };
  return {
    ok: true,
    entry: {
      ...e,
      currentParams: nextParams,
      elapsedMs: elapsed,
      runningSinceAt: now,
      segments: [...base, seg],
    },
  };
}

/** 暂停：封口 + 清锚点（暂停不计时） */
export function pauseCardio(e: CardioEntry, now = Date.now()): CardioEntry {
  if (e.status !== 'running') return e;
  const elapsed = liveElapsedMs(e, now);
  return {
    ...e,
    status: 'paused',
    elapsedMs: elapsed,
    runningSinceAt: null,
    segments: closeOpen(e, elapsed),
  };
}

/**
 * 继续：**必须明确重开同参段**（不能保持封口却假装有 open 段）。
 * 若暂停中改过参数，则按新参数开段。
 */
export function resumeCardio(e: CardioEntry, now = Date.now()): CardioEntry {
  if (e.status === 'running') return e;
  const elapsed = liveElapsedMs(e, now);
  const base = closeOpen(e, elapsed);

  /**
   * 段数已达上限时**复用最后一段**（同 id，end 重新置 open），
   * 而不是新增第 201 段 —— 否则用户会因为上限无法继续/完成
   * （PHASE-2-APPROVAL §1：暂停/完成必须始终可保存）。
   */
  if (base.length >= MAX_CARDIO_SEGMENTS) {
    const lastIdx = base.length - 1;
    const last = base[lastIdx];
    const reused: CardioSegment = {
      ...last,
      endElapsedMs: null,
      params: { ...e.currentParams },
    };
    const segments = base.map((s, i) => (i === lastIdx ? reused : s));
    return {
      ...e,
      status: 'running',
      elapsedMs: elapsed,
      runningSinceAt: now,
      segments,
    };
  }

  const seg: CardioSegment = {
    id: newCardioId('cseg'),
    startElapsedMs: elapsed,
    endElapsedMs: null,
    params: { ...e.currentParams },
  };
  return {
    ...e,
    status: 'running',
    elapsedMs: elapsed,
    runningSinceAt: now,
    segments: [...base, seg],
  };
}

/** 完成：封口并终结（不推进循环） */
export function completeCardio(e: CardioEntry, now = Date.now()): CardioEntry {
  const elapsed = liveElapsedMs(e, now);
  return {
    ...e,
    status: 'done',
    elapsedMs: elapsed,
    runningSinceAt: null,
    segments: closeOpen(e, elapsed),
  };
}

/**
 * finish 结算（在事务内对**库内 current** 调用）。
 * · running → 结算并封口
 * · paused  → 保留已有有效量并终结（不改时长）
 * · pending → 不伪造时长
 */
export function finalizeCardioForFinish(e: CardioEntry, now = Date.now()): CardioEntry {
  if (e.status === 'running') return completeCardio(e, now);
  if (e.status === 'done') return e;
  // paused / pending：保留现有 elapsed，仅终结状态并确保没有 open 段
  return {
    ...e,
    status: 'done',
    runningSinceAt: null,
    segments: closeOpen(e, liveElapsedMs(e, now)),
  };
}

/** 有氧总量（从 entries 派生，不设冗余真源） */
export function cardioTotalMs(entries: CardioEntry[] | undefined, now = Date.now()): number {
  if (!entries || !entries.length) return 0;
  return entries.reduce((n, e) => n + liveElapsedMs(e, now), 0);
}

/** 段时长（open 段按当前有效时长计） */
export function segmentDurationMs(seg: CardioSegment, liveElapsed: number): number {
  const end = seg.endElapsedMs === null ? liveElapsed : seg.endElapsedMs;
  return Math.max(0, end - seg.startElapsedMs);
}

export interface CardioIssue {
  path: string;
  message: string;
}

/**
 * 校验 entry 的不变量（运行时与备份校验共用）。
 * 返回空数组表示通过。
 */
export function validateCardioEntry(
  e: CardioEntry,
  now = Date.now(),
): CardioIssue[] {
  const issues: CardioIssue[] = [];
  const live = liveElapsedMs(e, now);

  if (!Number.isFinite(e.elapsedMs) || e.elapsedMs < 0) {
    issues.push({ path: 'elapsedMs', message: '已累计时长必须是非负有限数字' });
  }
  if (e.elapsedMs > MAX_CARDIO_MS) {
    issues.push({ path: 'elapsedMs', message: '已累计时长超过上限' });
  }
  if (e.status === 'running') {
    if (e.runningSinceAt === null || !Number.isFinite(e.runningSinceAt)) {
      issues.push({ path: 'runningSinceAt', message: '运行中必须有有效墙钟锚点' });
    }
  } else if (e.runningSinceAt !== null) {
    issues.push({ path: 'runningSinceAt', message: '非运行状态不应保留锚点' });
  }

  if (e.segments.length > MAX_CARDIO_SEGMENTS) {
    issues.push({ path: 'segments', message: `分段数超过上限 ${MAX_CARDIO_SEGMENTS}` });
  }

  let openCount = 0;
  let prevEnd: number | null = null;
  let sum = 0;
  for (let i = 0; i < e.segments.length; i += 1) {
    const seg = e.segments[i];
    const p = `segments[${i}]`;
    if (!Number.isFinite(seg.startElapsedMs) || seg.startElapsedMs < 0) {
      issues.push({ path: `${p}.startElapsedMs`, message: '起点必须是非负有限数字' });
    }
    if (seg.endElapsedMs !== null) {
      if (!Number.isFinite(seg.endElapsedMs)) {
        issues.push({ path: `${p}.endElapsedMs`, message: '终点必须是有限数字' });
      } else if (seg.endElapsedMs < seg.startElapsedMs) {
        issues.push({ path: `${p}.endElapsedMs`, message: '终点早于起点（负时长）' });
      }
    } else {
      openCount += 1;
    }
    // 相邻必须首尾相接
    if (prevEnd !== null && seg.startElapsedMs !== prevEnd) {
      issues.push({
        path: `${p}.startElapsedMs`,
        message: `分段必须首尾相接（上一段结束 ${prevEnd}，本段开始 ${seg.startElapsedMs}）`,
      });
    }
    prevEnd = seg.endElapsedMs === null ? null : seg.endElapsedMs;
    sum += segmentDurationMs(seg, live);
    // 参数合法
    for (const issue of validateCardioParams(e.preset, seg.params)) {
      issues.push({ path: `${p}.params.${issue.field}`, message: issue.message });
    }
  }

  if (openCount > 1) {
    issues.push({ path: 'segments', message: '同时存在多个未封口分段' });
  }
  if (openCount === 1 && e.status !== 'running') {
    issues.push({ path: 'segments', message: '非运行状态不应有未封口分段' });
  }
  if (e.status === 'running' && openCount === 0) {
    issues.push({ path: 'segments', message: '运行中必须有未封口分段' });
  }
  if (e.segments.length > 0) {
    const last = e.segments[e.segments.length - 1];
    if (last.endElapsedMs !== null && last.endElapsedMs > live) {
      issues.push({ path: 'segments', message: '分段终点超过当前有效时长' });
    }
    // 段总和 === 有效时长
    if (Math.abs(sum - live) > 1) {
      issues.push({
        path: 'segments',
        message: `分段时长之和 ${sum} 与有效时长 ${live} 不一致`,
      });
    }
  } else if (live > 0) {
    issues.push({ path: 'segments', message: '有有效时长但没有任何分段' });
  }

  // 参数规范
  for (const issue of validateCardioParams(e.preset, e.currentParams)) {
    issues.push({ path: `currentParams.${issue.field}`, message: issue.message });
  }
  return issues;
}

/** 会话级不变量：至多一个 running 有氧项目 */
export function runningCardioCount(entries: CardioEntry[] | undefined): number {
  if (!entries) return 0;
  return entries.filter((e) => e.status === 'running').length;
}

export function validateCardioList(entries: CardioEntry[] | undefined, now = Date.now()): CardioIssue[] {
  const issues: CardioIssue[] = [];
  if (!entries || !entries.length) return issues;
  for (let i = 0; i < entries.length; i += 1) {
    for (const issue of validateCardioEntry(entries[i], now)) {
      issues.push({ path: `cardio[${i}].${issue.path}`, message: issue.message });
    }
  }
  if (runningCardioCount(entries) > 1) {
    issues.push({ path: 'cardio', message: '同一次训练最多只能有一个正在运行的有氧项目' });
  }
  return issues;
}

/** 有氧状态的中文标签 */
export function cardioStatusLabel(s: CardioStatus): string {
  switch (s) {
    case 'pending':
      return '未开始';
    case 'running':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'done':
      return '已完成';
  }
}
