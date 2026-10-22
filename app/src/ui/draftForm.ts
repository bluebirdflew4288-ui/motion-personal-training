/* 草稿表单汇总（V3-04 / V4-03）。
   问题背景：
   1) `DraftNumberField` 内部校验失败只在自己身上报错，父表单的 draft 仍是旧值、
      保存按钮仍可用 → 用户输入 0 轮，点保存却把旧 3 轮存进去并关窗。
   2) **只校验、不提交**：flushAll 校验通过后把解析值丢掉，父保存仍读旧父 draft。
      在「合法字段还没 blur 就点保存」的路径上，字段文本是 5、父状态还是 3 → 存成 3。
      桌面点击通常会先 blur 掩盖它，但这是「提交不依赖 blur」的契约缺口。

   本轮契定：
   · 每个草稿输入把自己的 flush() 注册到父表单。
   · flushAll() 返回 **当前解析值映射 values**，父 handler 用它**同步构造一次**
     nextDraft（不 setState 后再读旧闭包），完整校验后保存。
   · 任一字段非法 → ok=false、errors 有内容、values 不含非法值，父表单阻止保存。
   · 取消时 resetAll()：丢弃本地草稿、清空错误，重新进入时不残留 disabled。 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { MAX_REPS, MAX_STRAIGHT_SETS } from '../domain/limits';

export interface DraftFieldResult {
  ok: boolean;
  value: number | null;
  message: string | null;
}

export interface DraftFieldHandle {
  /** 用当前文本草稿校验（不依赖 blur），返回结果 */
  flush: () => DraftFieldResult;
  /** 丢弃本地草稿，回到受控值 */
  reset: () => void;
}

export interface DraftFlushOutcome {
  ok: boolean;
  errors: Record<string, string>;
  /**
   * 各字段**当前文本草稿**的解析值（只含合法字段）。
   * 父 handler 必须用它构造保存对象，而不是再次读父 state —— 见文件头 (2)。
   */
  values: Record<string, number>;
}

export interface DraftFormApi {
  register: (id: string, handle: DraftFieldHandle) => void;
  unregister: (id: string) => void;
  /** 汇总校验所有已注册字段的当前文本草稿，并返回解析值映射 */
  flushAll: () => DraftFlushOutcome;
  /** 丢弃所有字段本地草稿并清空错误 */
  resetAll: () => void;
  /** 字段级错误（用于父级展示/禁用保存） */
  errors: Record<string, string>;
  /** 清空错误（不改草稿） */
  clearErrors: () => void;
}

export function useDraftForm(): DraftFormApi {
  const handles = useRef(new Map<string, DraftFieldHandle>());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const register = useCallback((id: string, handle: DraftFieldHandle) => {
    handles.current.set(id, handle);
  }, []);

  const unregister = useCallback((id: string) => {
    handles.current.delete(id);
    setErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const flushAll = useCallback((): DraftFlushOutcome => {
    const found: Record<string, string> = {};
    const values: Record<string, number> = {};
    for (const [id, handle] of handles.current) {
      const r = handle.flush();
      if (r.ok && r.value !== null && Number.isFinite(r.value)) {
        values[id] = r.value;
      } else {
        found[id] = r.message ?? '输入不合法';
      }
    }
    setErrors(found);
    return { ok: Object.keys(found).length === 0, errors: found, values };
  }, []);

  const resetAll = useCallback(() => {
    for (const handle of handles.current.values()) handle.reset();
    setErrors({});
  }, []);

  const clearErrors = useCallback(() => setErrors({}), []);

  return useMemo(
    () => ({ register, unregister, flushAll, resetAll, errors, clearErrors }),
    [register, unregister, flushAll, resetAll, errors, clearErrors],
  );
}

/* ────────────────────────────────────────────────────────────────
   V4-03 追加导出（纯函数，供 DraftNumberField 复用 + node 单测直接验证）。
   追加而非改写：上面已有签名一字未动。
   ──────────────────────────────────────────────────────────────── */

export interface ParseDraftNumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  /** 自定义校验：返回消息则判为不合法 */
  validate?: (v: number) => string | null;
}

/**
 * 文本草稿 → 数字的唯一解析规则。
 * blur 提交与父表单 flushAll 共用这一份，避免两条路径判定不一致。
 *
 * 关键点（F4-I02）：空串**必须**返回 ok:false / value:null，
 * 不允许任何上层把它当 0 或当旧值。
 */
export function parseDraftNumber(raw: string, opts: ParseDraftNumberOptions = {}): DraftFieldResult {
  const { min = 0, max = 9999, integer = true, validate } = opts;
  const t = raw.trim();
  if (t === '') return { ok: false, value: null, message: '不能为空' };
  // 允许 "-" / "7." 等中间态存在，但提交时必须是完整数字
  if (t === '-' || t === '.' || t === '-.' || t.endsWith('.')) {
    return { ok: false, value: null, message: '数字未输完' };
  }
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, value: null, message: '请输入数字' };
  if (integer && !Number.isInteger(n)) return { ok: false, value: null, message: '必须是整数' };
  if (n < min) return { ok: false, value: n, message: `不能小于 ${min}` };
  if (n > max) return { ok: false, value: n, message: `不能大于 ${max}` };
  const custom = validate?.(n);
  if (custom) return { ok: false, value: n, message: custom };
  return { ok: true, value: n, message: null };
}

/**
 * 受控值变化时，是否要用父值重写本地可见草稿（F4-I02 的判定本身）。
 *
 * 只有「真正的外部更新」才同步：`value !== lastCommitted`。
 * 旧实现额外写了 `|| draft === ''`，于是「清空必填项 → blur」这条路径上
 * 空串会被回填成旧值、错误也被清掉，父 flushAll 随后读到旧值判定合法 → 静默保存旧值。
 *
 * 空串必须保留到用户修正或显式 reset()。
 */
export function shouldSyncExternal(value: number, lastCommitted: number, draft: string): boolean {
  void draft;
  return value !== lastCommitted;
}

/**
 * 用 flushAll() 返回的 values **同步**覆盖父 draft 的副本（F4-I03）。
 *
 * 父 handler 绝不能 setState 后在同一个闭包里读旧 state；必须先用这个函数
 * 算出 nextDraft 局部变量，再对它做语义校验、再保存。
 *
 * @param base   父 state 里的当前 draft（只读，不修改）
 * @param values flushAll().values
 * @param keyMap base 的字段名 → 该字段注册的 fieldId
 */
export function mergeFlushedValues<T extends object>(
  base: T,
  values: Record<string, number>,
  keyMap: { [K in keyof T]?: string },
): T {
  const next = { ...base };
  for (const key of Object.keys(keyMap) as (keyof T)[]) {
    const id = keyMap[key];
    if (!id) continue;
    const v = values[id];
    // 注意 0 是合法值：不能写 `if (!v)`，否则「组数/休息填 0」会被旧值覆盖
    if (typeof v === 'number' && Number.isFinite(v)) next[key] = v as T[keyof T];
  }
  return next;
}

/** 普通组草稿：{ sets, repsMin, repsMax } */
export interface StraightDraftLike {
  sets: number;
  repsMin: number;
  repsMax: number;
}

/**
 * 普通组：把 flush 结果并进 draft 副本。
 * fieldId 约定：`${prefix}.sets` / `${prefix}.repsMin` / `${prefix}.repsMax`
 * （Plans 新增动作用 prefix="add"，Session 转换用 "convert"）。
 */
export function mergeFlushedStraightDraft<T extends StraightDraftLike>(
  base: T,
  values: Record<string, number>,
  prefix: string,
): T {
  return mergeFlushedValues(base, values, {
    sets: `${prefix}.sets`,
    repsMin: `${prefix}.repsMin`,
    repsMax: `${prefix}.repsMax`,
  });
}

/**
 * 普通组草稿的语义校验（跨字段）。flushAll 只保证「单字段自身合法」，
 * 反向范围 / 组数上限这类规则必须在这里再跑一次。
 */
export function validateStraightDraft(d: StraightDraftLike): DraftIssueLike[] {
  const issues: DraftIssueLike[] = [];
  if (!Number.isInteger(d.sets) || d.sets < 1 || d.sets > MAX_STRAIGHT_SETS) {
    issues.push({ path: 'sets', message: `组数必须是 1–${MAX_STRAIGHT_SETS} 的整数` });
  }
  for (const [path, label] of [
    ['repsMin', '次数下限'],
    ['repsMax', '次数上限'],
  ] as const) {
    const v = d[path];
    if (!Number.isInteger(v) || v < 0 || v > MAX_REPS) {
      issues.push({ path, message: `${label}必须是 0–${MAX_REPS} 的整数` });
    }
  }
  if (d.repsMin > d.repsMax) {
    issues.push({ path: 'reps', message: `次数下限 ${d.repsMin} 不能大于上限 ${d.repsMax}` });
  }
  return issues;
}

export interface DraftIssueLike {
  path: string;
  message: string;
}

/** 递减组草稿的形状（结构兼容 domain/dropSet 的 DropSetDraft，避免 ui→domain 循环依赖） */
export interface DropDraftLike {
  rounds: number;
  restInSec: number;
  restAfterSec: number;
  stages: { weightKg: number | null; repsMin: number | null; repsMax: number | null; toFailure: boolean }[];
}

/**
 * 递减组：把 flush 结果并进 draft **副本**。
 * fieldId 约定（DropSetEditor 实际注册的字符串，已 grep 确认）：
 *   `${prefix}.rounds` / `${prefix}.restIn` / `${prefix}.restAfter`
 *   `${prefix}.s{i}.weight` / `${prefix}.s{i}.repsMin` / `${prefix}.s{i}.repsMax`
 *
 * 力竭阶段的 weight 也会出现在 values 里（F4-I01：重量始终注册），
 * 而 repsMin/repsMax 在力竭时是 disabled、不注册，因此不会覆盖。
 */
export function mergeFlushedDropDraft<T extends DropDraftLike>(
  base: T,
  values: Record<string, number>,
  prefix: string,
): T {
  const next = mergeFlushedValues(base, values, {
    rounds: `${prefix}.rounds`,
    restInSec: `${prefix}.restIn`,
    restAfterSec: `${prefix}.restAfter`,
  });
  const stages = base.stages.map((st, i) => {
    const p = `${prefix}.s${i}`;
    const weight = values[`${p}.weight`];
    const lo = values[`${p}.repsMin`];
    const hi = values[`${p}.repsMax`];
    return {
      ...st,
      weightKg: typeof weight === 'number' && Number.isFinite(weight) ? weight : st.weightKg,
      repsMin: typeof lo === 'number' && Number.isFinite(lo) ? lo : st.repsMin,
      repsMax: typeof hi === 'number' && Number.isFinite(hi) ? hi : st.repsMax,
    };
  });
  return { ...next, stages };
}
