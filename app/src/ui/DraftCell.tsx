/* 历史纠错用的单元格输入（R01）。
   问题：旧实现每个字符立即 Number(raw)，"7." 的小数点被丢掉 → 变成 75。
   做法：输入期间只存文本草稿（保留 "7."、""、"-" 等中间态）；
        失焦/保存时才校验并提交有限数值。
   约束：
   · 空 vs 0 分开（"" → null，0 → 0）。
   · NaN / Infinity / 负数 / 超范围一律拒绝并给出字段级错误。
   · 不在输入过程中重新挂载或抢焦点，中文 IME 组合不被打断。 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  value: number | null;
  onCommit: (v: number | null) => void;
  integer?: boolean;
  min?: number;
  max?: number;
  ariaLabel: string;
  /** 外部校验失败时由父组件登记 */
  onValidityChange?: (valid: boolean) => void;
  width?: number;
  unit?: string;
}

export function DraftCell({
  value,
  onCommit,
  integer = false,
  min = 0,
  max = 9999,
  ariaLabel,
  onValidityChange,
  width = 80,
  unit,
}: Props) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const committed = useRef(value);

  // 外部值变化（取消编辑、撤销）时同步，但绝不打断正在输入的草稿
  useEffect(() => {
    if (focused) return;
    if (value !== committed.current) {
      committed.current = value;
      setText(value === null ? '' : String(value));
      setError(null);
      onValidityChange?.(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const validateText = (raw: string): { ok: true; v: number | null } | { ok: false; msg: string } => {
    const t = raw.trim();
    if (t === '') return { ok: true, v: null };
    // 只允许可选的负号 + 数字 + 可选小数点（是否允许负由 min 决定）
    if (!/^-?\d*\.?\d*$/.test(t)) return { ok: false, msg: '只能输入数字' };
    if (t === '-' || t === '.' || t === '-.') return { ok: false, msg: '数字未输完' };
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, msg: '不是有效数字' };
    if (integer && !Number.isInteger(n)) return { ok: false, msg: '必须是整数' };
    if (n < min) return { ok: false, msg: `不能小于 ${min}` };
    if (n > max) return { ok: false, msg: `不能大于 ${max}` };
    return { ok: true, v: n };
  };

  const commit = () => {
    const r = validateText(text);
    if (!r.ok) {
      setError(r.msg);
      onValidityChange?.(false);
      return;
    }
    setError(null);
    onValidityChange?.(true);
    if (r.v !== value) {
      committed.current = r.v;
      onCommit(r.v);
    }
  };

  return (
    <span style={{ display: 'inline-block', width, verticalAlign: 'top' }}>
      <span style={{ position: 'relative', display: 'block' }}>
        <input
          className="input"
          style={{
            width: '100%',
            minHeight: 44,
            fontSize: 15,
            textAlign: 'center',
            borderColor: error ? 'var(--brick)' : undefined,
            paddingRight: unit ? 18 : 4,
          }}
          type="text"
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={text}
          aria-label={ariaLabel}
          aria-invalid={!!error}
          onFocus={(e) => {
            setFocused(true);
            e.currentTarget.select();
          }}
          onChange={(e) => {
            // 只过滤明显非法字符，保留 "." 与空串等中间态
            const next = e.target.value.replace(/[^\d.\-]/g, '');
            setText(next);
            setError(null);
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              setText(value === null ? '' : String(value));
              setError(null);
              onValidityChange?.(true);
              e.currentTarget.blur();
            }
          }}
        />
        {unit ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 3,
              bottom: 3,
              fontSize: 10,
              color: 'var(--ink-4)',
              pointerEvents: 'none',
            }}
          >
            {unit}
          </span>
        ) : null}
      </span>
      {error ? (
        <span
          role="alert"
          style={{ display: 'block', color: 'var(--brick)', fontSize: 10.5, lineHeight: 1.3, marginTop: 2 }}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
