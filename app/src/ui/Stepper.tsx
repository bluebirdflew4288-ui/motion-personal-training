/* 次数 / 重量的加减与直接输入。
   关键设计（真机实测修正）：
   · 受控输入在多位数输入时，React 重渲染会把光标选区重置为「全选」，
     导致第二位数字替换第一位（20 → 0）。因此聚焦期间使用本地草稿字符串，
     只把解析后的数值向上提交；失焦时再与外部值对齐。
   · 不依赖长距离滚动的 select，数字键盘 + 步进按钮，单手持机可完成。 */

import { useEffect, useRef, useState } from 'react';

interface NumberFieldProps {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  placeholder?: string;
  ariaLabel: string;
  unit?: string;
  compact?: boolean;
  /**
   * 明确禁用（V6-01）。
   * 存在待存草稿时，训练数据输入必须真的不可写，
   * 不能"看起来接受了数字但实际被丢掉"。
   */
  disabled?: boolean;
}

export function NumberStepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 999,
  decimals = 0,
  placeholder = '—',
  ariaLabel,
  unit,
  compact,
  disabled = false,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const round = (n: number) => {
    const p = 10 ** decimals;
    return Math.round(n * p) / p;
  };
  const clamp = (n: number) => Math.min(max, Math.max(min, round(n)));

  // 外部值变化（撤销、沿用、步进按钮）时同步草稿——但聚焦输入期间不打断用户
  useEffect(() => {
    if (focused) return;
    setDraft(value === null ? '' : String(value));
  }, [value, focused]);

  const commit = (raw: string) => {
    const cleaned = raw.replace(/[^\d.]/g, '');
    const firstDot = cleaned.indexOf('.');
    const normalized =
      firstDot < 0 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
    setDraft(normalized);
    if (normalized === '' || normalized === '.') {
      onChange(null);
      return;
    }
    const n = Number(normalized);
    if (Number.isFinite(n)) onChange(clamp(n));
  };

  const bump = (dir: 1 | -1) => {
    const base = value ?? min;
    const next = clamp(base + dir * step);
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 4, minWidth: 0 }}>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ minWidth: 44, minHeight: 48, padding: 0, fontSize: 20, flex: 'none' }}
        disabled={disabled}
        onClick={() => bump(-1)}
        aria-label={`${ariaLabel} 减少`}
      >
        −
      </button>
      <div style={{ position: 'relative', flex: 1, minWidth: 56 }}>
        <input
          ref={inputRef}
          className="input input-num"
          style={
            compact
              ? {
                  minHeight: 50,
                  height: 50,
                  // 不用 line-height 撑高：SpaceGrotesk 的 ascent 偏大，行高等于高度会裁掉上缘
                  lineHeight: 'normal',
                  fontSize: 19,
                  paddingTop: 8,
                  paddingBottom: 6,
                  paddingLeft: 6,
                  paddingRight: unit ? 30 : 6,
                  fontFamily: 'var(--f-num)',
                  fontWeight: 500,
                  fontVariantNumeric: 'tabular-nums',
                }
              : { paddingRight: unit ? 26 : 10 }
          }
          type="text"
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          value={draft}
          placeholder={placeholder}
          aria-label={ariaLabel}
          disabled={disabled}
          readOnly={disabled}
          onFocus={(e) => {
            if (disabled) return;
            setFocused(true);
            // 同步全选：rAF 延迟会在用户已开始输入后再选中全部，
            // 导致第二位输入替换第一位（7.5 → .5）。这里用同步 select。
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            setDraft(value === null ? '' : String(value));
          }}
          onChange={(e) => {
            if (disabled) return;
            commit(e.target.value);
          }}
        />
        {unit ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 7,
              bottom: 5,
              fontSize: 10,
              color: 'var(--ink-4)',
              pointerEvents: 'none',
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ minWidth: 44, minHeight: 48, padding: 0, fontSize: 20, flex: 'none' }}
        disabled={disabled}
        onClick={() => bump(1)}
        aria-label={`${ariaLabel} 增加`}
      >
        +
      </button>
    </div>
  );
}
