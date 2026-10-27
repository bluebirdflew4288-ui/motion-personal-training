/* 草稿式数字输入（修复审计 R2-06 / K-7 / V3-04）。
   历史问题：
   1) 每次 onChange 立刻写库，且用 `+value || 0` 把空串回填成 0；
   2) 校验失败只在自己身上报错，**父表单不知道**，于是父 draft 还是旧值、
      保存按钮仍可用 → 用户填 0 轮，点保存却把旧 3 轮存进去并关窗（审查 I03）。

   本轮做法：
   · 输入期间只维护本地字符串草稿，不写库、不回填，允许中间态（"7." / ""）。
   · 失焦 / 回车时校验并提交；失败显示行内错误并保留草稿。
   · 提供 registerField 时，把 flush()/reset() 注册到父表单：
       flush() 用**当前文本草稿**校验（不依赖 blur 是否发生、也不依赖组件是否还挂着）；
       reset() 丢弃本地草稿回到受控值。
     父表单在保存前统一 flushAll()，任一非法就阻止保存（不静默用旧值）。
   · focused 期间不跟随父值重写，保证逐键输入（7.5 / 0.5）与焦点稳定。 */

import { useEffect, useRef, useState } from 'react';
import type { DraftFieldHandle, DraftFormApi } from './draftForm';
import { parseDraftNumber, shouldSyncExternal } from './draftForm';

interface Props {
  label: string;
  value: number;
  onCommit: (v: number) => void | Promise<void>;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  /** 自定义校验：返回错误消息则拒绝提交 */
  validate?: (v: number) => string | null;
  disabled?: boolean;
  /** 字段标识：提供后会把 flush/reset 注册到父表单（V3-04） */
  fieldId?: string;
  /** 父表单句柄：保存前用它汇总校验所有字段 */
  form?: DraftFormApi;
  /**
   * G5：把"当前是否不可安全卸载"上报给父级（切换管理计划时的草稿门禁）。
   *
   * 不可安全卸载 = 有未提交的草稿（draft ≠ 外部 value）或 有错误待修正。
   * 与 DraftTextField 的 onDirtyChange 语义一致，父级可统一汇总。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * B2/G5-R2：**明确放弃**信号。数值变化即把草稿重置回外部 value 并清错误。
   *
   * 供"放弃修改并切换"真正取消字段草稿 —— 旧实现只清一个 ref，
   * 字段草稿根本没被取消。
   */
  discardEpoch?: number;
  /**
   * B3/G3：用户**真实输入**时上报（用于字段级意图时序）。
   *
   * 与 onDirtyChange 不同：这里只表示"这个字段刚被用户精确编辑"，
   * 让上层知道精确意图**晚于**此前的滑杆意图。
   */
  onInputIntent?: () => void;
  /**
   * B4/G3：**真实已持久值**（可选）。
   *
   * <p>关键区别：`value` 可能是**本地预览**（如滑杆尚未提交的选择值），
   * 而 `persistedValue` 是库里真实已保存的值。提交判定必须用后者，
   * 否则会出现"修正值恰好等于本地预览 → 判定无变化 → 漏存"的真实失败：
   * 用户 `7.`→拖 15.5 被拦→精确修 15.5 并 blur，UI 显示 15.5 但 DB 仍是 7.5。
   */
  persistedValue?: number;
}

export interface ParsedDraft {
  ok: boolean;
  value: number | null;
  message: string | null;
}

export function DraftNumberField({
  label,
  value,
  onCommit,
  min = 0,
  max = 9999,
  integer = true,
  unit,
  validate,
  disabled,
  fieldId,
  form,
  onDirtyChange,
  discardEpoch,
  onInputIntent,
  persistedValue,
}: Props) {
  const [draft, setDraft] = useState(String(persistedValue !== undefined ? persistedValue : value));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  /** B2/G5-R5：IME 组合态也算不可卸载（组合中草稿可能与已提交值相同） */
  const composingRef = useRef(false);
  /**
   * B4-R2：错误与持久基准的同步镜像。
   *
   * 被动判定（`isUnsafeToUnmount`）会在**非渲染时机**被父层调用，
   * 那时闭包里的 `error`/`persistedValue` 可能已过期，必须读 ref 的最新值。
   */
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;
  const persistedRef = useRef(persistedValue !== undefined ? persistedValue : value);
  persistedRef.current = persistedValue !== undefined ? persistedValue : value;
  /**
   * G5：上报不可卸载状态。
   * 判据：草稿文本与外部值不一致（含未完成/非法输入），或有错误待修正。
   */
  useEffect(() => {
    /**
     * B4-R2：不可卸载的**统一判定**（与 isUnsafeToUnmount 同一套规则）。
     *
     * 注意 `value` 可能是本地预览，判"未提交"必须用持久基准 persistedValue，
     * 否则滑杆预览变化会被当成用户未保存草稿（或反过来漏报）。
     */
    const baseline = String(persistedValue !== undefined ? persistedValue : value);
    const unsafe = composingRef.current || !!error || draft !== baseline || !parse(draft).ok;
    onDirtyChange?.(unsafe);
    /**
     * **被动订阅链的关键一步**：真实状态变化时主动通知父表单。
     * 只读快照（probeRawValid）不产生通知，父层 effect 永远不会重跑。
     */
    if (form && fieldId) form._reportUnsafe?.(fieldId, unsafe);
    // parse 依赖 props，用依赖数组覆盖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, value, error, onDirtyChange, form, fieldId, persistedValue]);

  /** B2/G5-R2：收到放弃信号 → 真正取消草稿 */
  useEffect(() => {
    if (discardEpoch === undefined) return;
    composingRef.current = false;
    const fallbackVal = persistedValue !== undefined ? persistedValue : value;
    setDraft(String(fallbackVal));
    setError(null);
    lastCommitted.current = fallbackVal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discardEpoch]);
  const lastCommitted = useRef(persistedValue !== undefined ? persistedValue : value);
  /** Escape 取消后需要抑制紧接着的 blur 提交（否则会把拟取消值又写回去） */
  const suppressCommit = useRef(false);

  /** 校验规则与父表单 flushAll 共用同一份纯函数（V4-03 抽出到 draftForm.ts） */
  const parse = (raw: string): ParsedDraft =>
    parseDraftNumber(raw, { min, max, integer, validate });

  // 外部值变化（其它地方改了）时同步草稿，但不打断正在输入。
  //
  // V4-03 修复 F4-I02：旧条件里还有 `|| draft === ''`。
  // 「清空必填项 → blur」时 commit() 先报「不能为空」，紧接着 focused 变 false
  // 触发本 effect，看到空串就把可见草稿改回旧值 3 并清掉错误；
  // 父 flushAll 随后读到 3 判合法 → 静默保存旧值并关窗。
  // 现在只处理真正的外部更新，空串保留到用户修正或显式 reset()。
  useEffect(() => {
    if (focused) return;
    /**
     * B4/G3：外部同步也以**持久值**为基准（若提供）。
     * 滑杆预览变化不应被当作"外部数据更新"去覆盖用户草稿。
     *
     * B4-R3 closure3 / cardio-clean-actions 修复：
     * 当真实持久基准 persistedValue 在外部（如滑杆提交或后台完成）更新时，
     * 若当前草稿是干净的（draft === lastCommitted），必须将草稿与 lastCommitted 同步至 syncSource；
     * 依赖项必须包含 persistedValue 与 draft，否则库值更新时 effect 不执行，干净草稿卡在旧值。
     */
    const syncSource = persistedValue !== undefined ? persistedValue : value;
    if (shouldSyncExternal(syncSource, lastCommitted.current, draft)) {
      setDraft(String(syncSource));
      setError(null);
      lastCommitted.current = syncSource;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused, persistedValue, draft]);

  // 注册到父表单（V3-04）：flush 用当前文本草稿，reset 丢弃本地草稿
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!form || !fieldId) return undefined;
    const handle: DraftFieldHandle = {
      flush: () => {
        const r = parse(draftRef.current);
        return { ok: r.ok, value: r.value, message: r.message };
      },
      reset: () => {
        const resetVal = persistedRef.current !== undefined ? persistedRef.current : valueRef.current;
        setDraft(String(resetVal));
        setError(null);
        lastCommitted.current = resetVal;
      },
      /**
       * B4-R2：**被动**判定本字段是否不可安全卸载。
       *
       * 覆盖四类状态（缺任一类都会造成"看起来干净、实际丢草稿"）：
       *   ① 合法但**未提交**的 raw（draft ≠ 已提交基线）；
       *   ② 空 / 未完（`7.`）/ 非法；
       *   ③ IME 组合态；
       *   ④ 有错误待修正。
       */
      isUnsafeToUnmount: () => {
        if (composingRef.current) return true;
        if (errorRef.current) return true;
        const draftNow = draftRef.current;
        const baseline = String(persistedRef.current);
        if (draftNow !== baseline) return true;
        return !parse(draftNow).ok;
      },
    };
    form.register(fieldId, handle);
    return () => form.unregister(fieldId);
    // parse 依赖 min/max/validate，这些都来自 props，用 value/fieldId 变化重建即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, fieldId, value, min, max, integer]);

  const commit = () => {
    const r = parse(draftRef.current);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setError(null);
    lastCommitted.current = r.value!;
    setDraft(String(r.value));
    /**
     * B4/G3：用**真实持久基准**判断是否需要提交。
     *
     * 旧实现比较的是 `value`（可能是本地预览），于是"修正值恰好等于预览"
     * 时被判定"无变化"→ **漏存**（真实 CUA 已复现：UI 15.5、DB 7.5）。
     * 未提供 persistedValue 时回退到 value（保持既有调用方行为）。
     */
    const baseline = persistedValue !== undefined ? persistedValue : value;
    if (r.value !== baseline) void onCommit(r.value!);
  };

  return (
    <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', minWidth: 0 }}>
      <span style={{ display: 'block' }}>{label}</span>
      <div style={{ position: 'relative' }}>
        <input
          className="input"
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          style={{
            minHeight: 44,
            fontSize: 15,
            marginTop: 2,
            paddingRight: unit ? 30 : 8,
            borderColor: error ? 'var(--brick)' : undefined,
          }}
          value={draft}
          disabled={disabled}
          aria-label={label}
          aria-invalid={!!error}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            // 只过滤明显非法字符，保留 "." / "-" 等中间态（不在这里回填 0）
            onInputIntent?.();
            setDraft(e.target.value.replace(/[^\d.\-]/g, ''));
            setError(null);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            onDirtyChange?.(true);
            if (form && fieldId) form._reportUnsafe?.(fieldId, true);
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            // 组合结束后按真实草稿重算（可能仍脏）
            const baseline = String(persistedRef.current);
            const unsafe = !!errorRef.current || draftRef.current !== baseline;
            onDirtyChange?.(unsafe);
            if (form && fieldId) form._reportUnsafe?.(fieldId, unsafe);
          }}
          onBlur={() => {
            setFocused(false);
            if (suppressCommit.current) {
              suppressCommit.current = false;
              return;
            }
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              // 明确取消：用受控值覆盖草稿，并标记 suppress 避免 blur 把拟取消值提交
              suppressCommit.current = true;
              setDraft(String(value));
              setError(null);
              e.currentTarget.blur();
            }
          }}
        />
        {unit ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              color: 'var(--ink-4)',
              pointerEvents: 'none',
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>
      {error ? (
        <span role="alert" style={{ display: 'block', color: 'var(--brick)', fontSize: 11.5, marginTop: 2 }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}
