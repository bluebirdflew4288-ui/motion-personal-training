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
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const lastCommitted = useRef(value);
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
    if (shouldSyncExternal(value, lastCommitted.current, draft)) {
      setDraft(String(value));
      setError(null);
      lastCommitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

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
        setDraft(String(valueRef.current));
        setError(null);
        lastCommitted.current = valueRef.current;
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
    if (r.value !== value) void onCommit(r.value!);
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
            setDraft(e.target.value.replace(/[^\d.\-]/g, ''));
            setError(null);
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
