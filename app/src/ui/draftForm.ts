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
  /**
   * B4-R2：**当前字段是否不可安全卸载**（被动读，不写 state）。
   *
   * <p>必须覆盖四类状态，不能只看 invalid：
   * 合法但**未提交**的 raw、空、未完（`7.`）、IME 组合态、以及保存中。
   * 缺任一类都会出现"草稿看起来干净、实际丢失"的真实失败。
   *
   * 未提供时退回 {@link flush} 的 ok 判定（兼容旧字段）。
   */
  isUnsafeToUnmount?: () => boolean;
  /**
   * G3A2：**被动**读取当前精确输入原文（不 flush、不写 state、不丢草稿）。
   *
   * 供删除预览/提交时的风险签名使用：同一字段 `7.` → `8.` 必须产生不同签名，
   * 不能只用"是否 unsafe"的布尔。
   */
  rawSignature?: () => string;
}

export interface DraftFlushOutcome {
  ok: boolean;
  errors: Record<string, string>;
  /**
   * 各字段**当前文本草稿**的解析值（只含合法非空数值字段）。
   * 父 handler 必须用它构造保存对象，而不是再次读父 state —— 见文件头 (2)。
   */
  values: Record<string, number>;
  /** 明确清空为 null 的可选数字字段（如 W02 可选重量） */
  nullIds?: Set<string>;
}

export interface DraftFormApi {
  register: (id: string, handle: DraftFieldHandle) => void;
  unregister: (id: string) => void;
  /**
   * B4-R2：订阅**字段集合的被动变化**。
   *
   * <p>为什么必须有订阅（G5 实证缺口 1 的根因）：
   * `probeRawValid()` 只是"读一次快照"，纯读不产生任何通知。
   * 子字段清空/报错/IME 只改**自己的**本地 state，父层的 `draft` 与 `form`
   * 身份都不变 → 依赖 `[draft, form]` 的 effect **永远不会重跑**，
   * 于是 `rawInvalid` 一直是 false，离页门禁放行、草稿丢失。
   *
   * <p>现在字段在"不可卸载状态"真正变化时**主动通知**父层；
   * 父层据此重算并上报，不再依赖 draft/form 身份变化。
   *
   * @returns 取消订阅函数
   */
  subscribe: (listener: () => void) => () => void;
  /**
   * B4-R2：**被动**汇总当前是否有字段不可安全卸载（不写 state）。
   *
   * 与 `probeRawValid` 的区别：后者只判 raw 合法性，
   * 本方法还包含"合法未提交""IME 组合态""保存中"。
   */
  hasUnsafeField: () => boolean;
  /**
   * B4-R2：字段级不可卸载状态（供父层按 fieldId 精确聚合，避免互相覆盖）。
   */
  unsafeFieldIds: () => string[];
  /** 当前已注册字段 id（诊断/注销核对用） */
  registeredIds: () => string[];
  /**
   * 字段侧上报入口（B4-R2）：把"我是否不可安全卸载"告诉父表单。
   *
   * 字段必须在 raw/error/IME/saving **真实变化**时调用，
   * 不能只在 render 里调用一次（那样仍不会产生被动通知）。
   */
  _reportUnsafe?: (id: string, unsafe: boolean) => void;
  /**
   * G3A2：**被动**汇总当前所有字段的精确原文/错误/IME 状态签名。
   *
   * 与 `flushAll` 的区别：只读，不 `setErrors`、不提交、不改字段状态，
   * 因此可在渲染/预览/队列执行时安全调用。
   */
  probeRawSignature: () => string;
  /** 汇总校验所有已注册字段的当前文本草稿，并返回解析值映射 */
  flushAll: () => DraftFlushOutcome;
  /**
   * **被动**合法性探测：只读，**不写 state**。
   *
   * <p>与 `flushAll` 的区别：flushAll 会 `setErrors` 并驱动 form 重建，
   * 在 effect 里调用会造成自激循环。本函数专供"观察内部 raw 是否干净"使用。
   *
   * @returns true 表示全部已注册字段 raw 合法
   */
  probeRawValid: () => boolean;
  /** 丢弃所有字段本地草稿并清空错误 */
  resetAll: () => void;
  /** 字段级错误（用于父级展示/禁用保存） */
  errors: Record<string, string>;
  /** 清空错误（不改草稿） */
  clearErrors: () => void;
}

export function useDraftForm(): DraftFormApi {
  const handles = useRef(new Map<string, DraftFieldHandle>());
  /**
   * B4-R2：每个字段**最后一次上报的不可卸载状态**。
   *
   * 用 Map 而不是单个布尔：某个字段恢复干净时只能清**它自己**，
   * 绝不能把其它仍脏字段的状态一起清掉（"全清 Map 掩盖存活草稿"是被明确禁止的）。
   */
  const unsafeRef = useRef(new Map<string, boolean>());
  /** 被动变化订阅者（父层 effect 用它重算聚合） */
  const listenersRef = useRef(new Set<() => void>());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const notify = useCallback(() => {
    for (const fn of Array.from(listenersRef.current)) {
      try {
        fn();
      } catch {
        // 单个订阅者异常不影响其它订阅者
      }
    }
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const register = useCallback((id: string, handle: DraftFieldHandle) => {
    handles.current.set(id, handle);
    // 新注册字段先按"干净"起步，随后由字段自己上报真实状态
    if (!unsafeRef.current.has(id)) unsafeRef.current.set(id, false);
  }, []);

  const unregister = useCallback(
    (id: string) => {
      handles.current.delete(id);
      // 注销必须**同时**清掉该字段的不可卸载登记，否则已卸载字段会永久阻塞门禁
      const hadUnsafe = unsafeRef.current.delete(id);
      setErrors((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (hadUnsafe) notify();
    },
    [notify],
  );

  /**
   * B4-R2：字段主动上报"我是否不可安全卸载"。
   *
   * 这是 raw/error/IME/saving 变化的**唯一入口**：
   * 字段在真实状态变化时调用它 → 父层收到被动通知 → 聚合重算。
   */
  const reportUnsafe = useCallback(
    (id: string, unsafe: boolean) => {
      const prev = unsafeRef.current.get(id) ?? false;
      if (prev === unsafe) return;
      unsafeRef.current.set(id, unsafe);
      notify();
    },
    [notify],
  );

  const hasUnsafeField = useCallback((): boolean => {
    for (const v of unsafeRef.current.values()) if (v) return true;
    // 兜底：未上报过的字段用 isUnsafeToUnmount/flush 判定
    for (const [id, handle] of handles.current) {
      if (unsafeRef.current.has(id)) continue;
      try {
        if (handle.isUnsafeToUnmount ? handle.isUnsafeToUnmount() : !handle.flush().ok) return true;
      } catch {
        return true; // 探测失败按脏处理（保守）
      }
    }
    return false;
  }, []);

  const unsafeFieldIds = useCallback((): string[] => {
    const out: string[] = [];
    for (const [id, v] of unsafeRef.current) if (v) out.push(id);
    return out;
  }, []);

  const registeredIds = useCallback((): string[] => Array.from(handles.current.keys()), []);

  const flushAll = useCallback((): DraftFlushOutcome => {
    const found: Record<string, string> = {};
    const values: Record<string, number> = {};
    const nullIds = new Set<string>();
    for (const [id, handle] of handles.current) {
      const r = handle.flush();
      if (r.ok && r.value !== null && Number.isFinite(r.value)) {
        values[id] = r.value;
      } else if (r.ok && r.value === null) {
        nullIds.add(id);
      } else {
        found[id] = r.message ?? '输入不合法';
      }
    }
    setErrors(found);
    return { ok: Object.keys(found).length === 0, errors: found, values, nullIds };
  }, []);

  /**
   * **被动**合法性探测（B4-R1 修复循环风险）。
   *
   * <p>`flushAll()` 会无条件 `setErrors(新对象)`，而 form 的 useMemo 依赖 errors，
   * 于是在 effect 里调用它就会形成
   * `effect → setErrors → 新 form → effect` 的**自激循环**
   * （Codex 静态审查指出的真实可达回归）。
   *
   * <p>本函数只读各字段当前 raw 文本并解析，**不写任何 state**，
   * 因此可以安全地在 effect / 渲染期用于"内部 raw 是否干净"的观察。
   *
   * @returns true 表示所有已注册字段的 raw 都合法（无空/未完/非法）
   */
  const probeRawValid = useCallback((): boolean => {
    for (const handle of handles.current.values()) {
      try {
        const r = handle.flush();
        if (!r.ok) return false;
      } catch {
        return false;
      }
    }
    return true;
  }, []);

  const probeRawSignature = useCallback((): string => {
    const parts: string[] = [];
    for (const [id, handle] of handles.current) {
      let raw = '';
      try {
        raw = handle.rawSignature ? handle.rawSignature() : '';
      } catch {
        raw = '!probe-error';
      }
      // 干净字段的 raw 为空串：不进入签名，避免把“无草稿”误判成有未提交输入
      if (raw) parts.push(`${id}\u0000${raw}`);
    }
    parts.sort();
    return parts.join('\u0001');
  }, []);

  const resetAll = useCallback(() => {
    for (const handle of handles.current.values()) handle.reset();
    setErrors({});
  }, []);

  const clearErrors = useCallback(() => setErrors({}), []);

  /**
   * B4-R2：把 `reportUnsafe` 挂到返回对象上（字段侧调用）。
   *
   * 单独命名 `_reportUnsafe` 避免与公开 API 混淆；字段组件通过
   * `form._reportUnsafe?.(fieldId, unsafe)` 上报。
   */
  return useMemo(
    () => ({
      register,
      unregister,
      flushAll,
      probeRawSignature,
      probeRawValid,
      resetAll,
      errors,
      clearErrors,
      subscribe,
      hasUnsafeField,
      unsafeFieldIds,
      registeredIds,
      _reportUnsafe: reportUnsafe,
    }),
    [
      register,
      unregister,
      flushAll,
      probeRawSignature,
      probeRawValid,
      resetAll,
      errors,
      clearErrors,
      subscribe,
      hasUnsafeField,
      unsafeFieldIds,
      registeredIds,
      reportUnsafe,
    ],
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
  /** W02：重量字段允许留空为 null，与显式 0 严格区分；其余必填数字默认 false */
  nullable?: boolean;
  /** 自定义校验：返回消息则判为不合法 */
  validate?: (v: number) => string | null;
}

/**
 * 文本草稿 → 数字的唯一解析规则。
 * blur 提交与父表单 flushAll 共用这一份，避免两条路径判定不一致。
 *
 * 关键点（F4-I02）：默认空串**必须**返回 ok:false / value:null，
 * 不允许任何上层把它当 0 或当旧值；仅显式 `nullable: true` 时空串返回 ok:true / value:null。
 */
export function parseDraftNumber(raw: string, opts: ParseDraftNumberOptions = {}): DraftFieldResult {
  const { min = 0, max = 9999, integer = true, nullable = false, validate } = opts;
  const t = raw.trim();
  if (t === '') {
    return nullable ? { ok: true, value: null, message: null } : { ok: false, value: null, message: '不能为空' };
  }
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
/**
 * 外部 value 变化时，是否应当**采纳**并覆盖本地草稿。
 *
 * ── B2/G3 修复的真实缺陷（Codex 真实 CUA 确证）──────────────
 * 旧实现 `void draft` —— **完全忽略草稿内容**，只要 `value !== lastCommitted`
 * 就无条件采纳。于是真实路径：
 *   用户在精确框输入未完 `7.` → 点 range 拖动 → 输入框失焦（focused=false）
 *   → range 的 onChange 让外部 value 从 5.5 变 15.5
 *   → 本函数返回 true → 草稿被改成 `15.5`、**错误被清** → 后续提交写新段。
 * 用户的未完/非法输入被静默吞掉。
 *
 * ── 现在的规则 ────────────────────────────────────────────────
 * 只有**干净草稿**（用户没有未提交意图）才采纳外部值：
 *   · 草稿与已提交基线一致 → 干净 → 采纳（保持外部同步）；
 *   · 草稿为空串、未完（`7.`）、非法、或与基线不同 → **保留草稿**，不采纳。
 * 空串的保留语义与既有 F4-I02 修复一致（不能把"清空必填项"洗回旧值）。
 */
export function shouldSyncExternal(value: number | null, lastCommitted: number | null, draft: string): boolean {
  // 外部值没变：不需要同步
  if (value === lastCommitted) return false;
  // 草稿与已提交基线一致 = 用户没有未提交意图 → 可以采纳外部更新
  const baseline = lastCommitted === null ? '' : String(lastCommitted);
  if (draft === baseline) return true;
  /**
   * 草稿非空但与基线不同 → 用户有未提交意图（含未完 `7.`、非法 `99999`）→ 保留。
   * 草稿为空 → 也保留（既有 F4-I02 语义：空串要留到用户修正）。
   */
  return false;
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
export interface DropDraftStageLike {
  weightKg: number | null;
  repsMin: number | null;
  repsMax: number | null;
  toFailure: boolean;
  restAfterSec?: number;
}

export interface DropDraftLike {
  rounds: number;
  restInSec: number;
  restAfterSec: number;
  stages: DropDraftStageLike[];
  /** R02 逐轮覆盖（1..N 轮）；字段 id 用 `${prefix}.r{round}s{i}.*`，第 1 轮沿用 `${prefix}.s{i}.*` */
  roundOverrides?: { roundIndex: number; stages: DropDraftStageLike[]; restInSec?: number }[];
}

export interface MergeFlushedDropDraftOptions {
  /**
   * R02 FIX2：第 1 轮字段（`${prefix}.s{i}.*`）是否应写入 `roundOverrides[1]` 而不是
   * 共享默认 `stages`。真实计划编辑器必须传 true：第 1 轮与其它轮相互独立，
   * 修改第 1 轮不能改写未覆盖的默认轮。旧测试/旧调用不传时保持原有 flush 语义。
   */
  round1AsOverride?: boolean;
  /** W02：flushAll 明确清空为 null 的字段集合（用于保留空白重量而不沿用旧值） */
  nullIds?: Set<string>;
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
function mergeDropStageValues<T extends DropDraftStageLike>(
  st: T,
  values: Record<string, number>,
  p: string,
  nullIds?: Set<string>,
): T {
  const weightCleared = nullIds?.has(`${p}.weight`) ?? false;
  const weight = values[`${p}.weight`];
  const lo = values[`${p}.repsMin`];
  const hi = values[`${p}.repsMax`];
  const rest = values[`${p}.rest`];
  return {
    ...st,
    weightKg: weightCleared ? null : typeof weight === 'number' && Number.isFinite(weight) ? weight : st.weightKg,
    repsMin: typeof lo === 'number' && Number.isFinite(lo) ? lo : st.repsMin,
    repsMax: typeof hi === 'number' && Number.isFinite(hi) ? hi : st.repsMax,
    ...(typeof rest === 'number' && Number.isFinite(rest) ? { restAfterSec: rest } : {}),
  };
}

export function mergeFlushedDropDraft<T extends DropDraftLike>(
  base: T,
  values: Record<string, number>,
  prefix: string,
  opts: MergeFlushedDropDraftOptions = {},
): T {
  const nullIds = opts.nullIds;
  const next = mergeFlushedValues(base, values, {
    rounds: `${prefix}.rounds`,
    restInSec: `${prefix}.restIn`,
    restAfterSec: `${prefix}.restAfter`,
  });
  let overrides = (base.roundOverrides ?? []).map((ov) => ({
    ...ov,
    stages: ov.stages.map((st, i) => mergeDropStageValues(st, values, `${prefix}.r${ov.roundIndex}s${i}`, nullIds)),
  }));
  let stages: DropDraftStageLike[];
  if (opts.round1AsOverride) {
    // 第 1 轮是独立轮：s{i} 字段写入 roundOverrides[1]；默认 stages 不动。
    stages = base.stages.map((st) => ({ ...st }));
    const existing1 = overrides.find((o) => o.roundIndex === 1);
    if (existing1) {
      existing1.stages = existing1.stages.map((st, i) => mergeDropStageValues(st, values, `${prefix}.s${i}`, nullIds));
    } else {
      overrides.push({
        roundIndex: 1,
        stages: base.stages.map((st, i) => mergeDropStageValues(st, values, `${prefix}.s${i}`, nullIds)),
      });
    }
  } else {
    stages = base.stages.map((st, i) => mergeDropStageValues(st, values, `${prefix}.s${i}`, nullIds));
  }
  // 第 2..N 轮若字段已被 flush（用户还在聚焦未 blur），但 base 尚无 override：
  // 用默认行克隆出该轮再应用 flush 值，避免“保存旧值并关窗”（V4-03 同类缺陷）。
  const knownRounds = new Set(overrides.map((o) => o.roundIndex));
  for (let r = 2; r <= Math.max(1, base.rounds); r += 1) {
    if (knownRounds.has(r)) continue;
    const roundPrefix = `${prefix}.r${r}s`;
    const hasFlushed =
      Object.keys(values).some((k) => k.startsWith(roundPrefix)) ||
      Array.from(nullIds ?? []).some((k) => k.startsWith(roundPrefix));
    if (!hasFlushed) continue;
    overrides.push({
      roundIndex: r,
      stages: base.stages.map((st, i) => mergeDropStageValues(st, values, `${roundPrefix}${i}`, nullIds)),
    });
  }
  // 轮数 flush 也可能尚未 blur：结构新增轮必须复制紧邻上一轮，不能只把数字改大。
  const nextRounds = typeof next.rounds === 'number' && Number.isInteger(next.rounds) ? next.rounds : base.rounds;
  if (nextRounds < base.rounds) overrides = overrides.filter((o) => o.roundIndex <= nextRounds);
  const stagesForRound = (r: number) => overrides.find((o) => o.roundIndex === r)?.stages ?? stages;
  const knownAfter = new Set(overrides.map((o) => o.roundIndex));
  for (let r = base.rounds + 1; r <= nextRounds; r += 1) {
    if (knownAfter.has(r)) continue;
    overrides.push({ roundIndex: r, stages: stagesForRound(r - 1).map((st) => ({ ...st })) });
  }
  return overrides.length
    ? ({ ...next, stages, roundOverrides: overrides.sort((a, b) => a.roundIndex - b.roundIndex) } as T)
    : ({ ...next, stages } as T);
}
