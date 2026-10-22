/* 草稿式数字输入（修复审计 R2-06 与 K-7）。
   问题：旧实现每次 onChange 立刻写库，且用 `+value || 0` 把空串回填成 0，
   导致「想把 10 改成 20」时中间态被立刻改写成 0，而且非法范围能存进去。
   做法：
   · 输入期间只维护本地字符串草稿，不写库、不回填。
   · 失焦 / 回车 / 点外部时校验并提交；校验失败给出行内错误并保留草稿。
   · 支持 min/max/integer，校验消息明确。 */

import { useEffect, useRef, useState } from 'react';

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
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const lastCommitted = useRef(value);

  // 外部值变化（其它地方改了）时同步草稿，但不打断正在输入
  useEffect(() => {
    if (focused) return;
    if (value !== lastCommitted.current || draft === '') {
      setDraft(String(value));
      setError(null);
      lastCommitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused]);

  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      setError('不能为空');
      setDraft(String(value));
      setError(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setError('请输入数字');
      return;
    }
    if (integer && !Number.isInteger(n)) {
      setError('必须是整数');
      return;
    }
    if (n < min) {
      setError(`不能小于 ${min}`);
      return;
    }
    if (n > max) {
      setError(`不能大于 ${max}`);
      return;
    }
    const custom = validate?.(n);
    if (custom) {
      setError(custom);
      return;
    }
    setError(null);
    lastCommitted.current = n;
    setDraft(String(n));
    if (n !== value) void onCommit(n);
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
            setDraft(e.target.value.replace(/[^\d.]/g, ''));
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
