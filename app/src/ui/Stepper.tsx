/* 次数 / 重量的加减与直接输入。
   关键设计（真机实测修正）：
   · 受控输入在多位数输入时，React 重渲染会把光标选区重置为「全选」，
     导致第二位数字替换第一位（20 → 0）。因此聚焦期间使用本地草稿字符串，
     只把解析后的数值向上提交；失焦时再与外部值对齐。
   · 不依赖长距离滚动的 select，数字键盘 + 步进按钮，单手持机可完成。

   ── 可选的「未提交 raw 风险」上报（用户反馈问题三，最小增量）──────────
   本组件在**每次按键**就 onChange 已解析值：输入 `12` 会立刻提交 12，
   但输入 `.` / 空串时会 onChange(null)（把该字段清空），而失焦又把文本草稿
   重置成外部值 —— 也就是说「用户正在输入、且这次输入没有形成干净数字」
   这一事实在 blur 之后就**没有任何痕迹**了。

   删除/移除类操作需要知道这件事（不能把「用户刚动过这个字段」当成空白删除）。
   因此增加一个**可选**回调 `onRawRisk`：
   · 空串、`.`、尾随小数点和非法输入上报 true；干净数字或 ± 步进上报 false；
   · **失焦不清除风险**（这正是「点工具按钮触发 blur 后风险不能先丢」的要求）；
   · 训练页可选接线把 raw 与风险一起交给父层，折叠卸载后可恢复；普通 Stepper 保留旧卸载清理。

   这不是第二套解析规则：判据仍复用下面 commit() 的同一次解析结果，
   不改变任何既有的步进/解析/提交语义。 */

import { useEffect, useRef, useState } from 'react';
import {
  registerFocusedField,
  setDirtyField,
  unregisterFocusedField,
  type CoachEditableField,
} from '../coach/focusGuard';

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
  /**
   * 可选的「未提交 raw 风险」上报（问题三）。
   * 见文件头：只在输入仍可继续编辑时为 true，
   * 训练页可同时持有 raw 文本，使风险跨折叠重挂；普通用法仍在卸载时清理。
   */
  onRawRisk?: (risky: boolean) => void;
  rawDraft?: string;
  onRawDraftChange?: (raw: string | null) => void;
  coachExId?: string;
  coachSetId?: string;
  coachField?: CoachEditableField;
}

/** `7.` 尚可继续输入小数，不能把它当作已结束的 raw 字段。 */
export function isUnfinishedNumberDraft(raw: string): boolean {
  return raw === '' || raw === '.' || raw.endsWith('.');
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
  onRawRisk,
  rawDraft,
  onRawDraftChange,
  coachExId,
  coachSetId,
  coachField,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(rawDraft ?? (value === null ? '' : String(value)));
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Wave 1C.2：步进器的同步乐观基准。
   * 解决连续快速连点 + / − 时，在异步 IDB 落库重渲染回来前重复读取旧 props `value`
   * 导致 `8 -> 9 -> 9` 丢步的问题。外部 `value` 或 `disabled` 变化时自动对齐。
   */
  const optimisticValueRef = useRef<number | null>(value);

  const round = (n: number) => {
    const p = 10 ** decimals;
    return Math.round(n * p) / p;
  };
  const clamp = (n: number) => Math.min(max, Math.max(min, round(n)));

  useEffect(() => {
    optimisticValueRef.current = value;
  }, [value, disabled]);

  // 外部值变化（撤销、沿用、步进按钮）时同步草稿——但聚焦输入期间不打断用户
  useEffect(() => {
    if (focused) return;
    setDraft(rawDraft ?? (value === null ? '' : String(value)));
  }, [value, focused, rawDraft]);

  /**
   * 未提交 raw 风险（问题三）。
   * 用 ref 记录已上报的值，避免每次按键都触发父级重渲染/重复登记。
   */
  const rawRiskRef = useRef(false);
  const reportRawRisk = (risky: boolean) => {
    if (coachExId) {
      setDirtyField(
        { exId: coachExId, setId: coachSetId, field: coachField ?? 'unknown' },
        risky,
      );
    }
    if (rawRiskRef.current === risky) return;
    rawRiskRef.current = risky;
    onRawRisk?.(risky);
  };
  /** 父层按字段身份恢复风险；此组件卸载不清除训练页登记。 */
  useEffect(() => {
    reportRawRisk(rawDraft !== undefined);
  }, [rawDraft]);

  useEffect(
    () => () => {
      if (coachExId) {
        unregisterFocusedField({
          exId: coachExId,
          setId: coachSetId,
          field: coachField ?? 'unknown',
        });
        if (!onRawDraftChange) {
          setDirtyField(
            { exId: coachExId, setId: coachSetId, field: coachField ?? 'unknown' },
            false,
          );
        }
      }
      if (onRawDraftChange || !rawRiskRef.current) return;
      rawRiskRef.current = false;
      onRawRisk?.(false);
    },
    // 未接 rawDraftChange 的普通 Stepper 保留旧清理；训练页由父层按字段 ID 管理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coachExId, coachSetId, coachField],
  );

  const commit = (raw: string) => {
    const cleaned = raw.replace(/[^\d.]/g, '');
    const firstDot = cleaned.indexOf('.');
    const normalized =
      firstDot < 0 ? cleaned : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
    setDraft(normalized);
    if (normalized === '' || normalized === '.') {
      // 空串 / 单个小数点：本次输入**没有**形成干净数字 → 登记风险
      optimisticValueRef.current = null;
      reportRawRisk(true);
      onRawDraftChange?.(normalized);
      onChange(null);
      return;
    }
    const n = Number(normalized);
    if (Number.isFinite(n)) {
      // 尾随小数点仍是可继续输入的 raw（如 7.）；actual 数值提交规则不变。
      const incompleteDecimal = isUnfinishedNumberDraft(normalized);
      const clamped = clamp(n);
      optimisticValueRef.current = clamped;
      reportRawRisk(incompleteDecimal);
      onRawDraftChange?.(incompleteDecimal ? normalized : null);
      onChange(clamped);
      return;
    }
    // 解析失败（例如 "1.2.3" 归一后仍非法）：同样登记风险
    reportRawRisk(true);
    onRawDraftChange?.(normalized);
  };

  const bump = (dir: 1 | -1) => {
    if (disabled) return;
    const base = optimisticValueRef.current ?? value ?? min;
    const next = clamp(base + dir * step);
    optimisticValueRef.current = next;
    setDraft(String(next));
    // 步进一定产生干净数字 → 风险解除
    reportRawRisk(false);
    onRawDraftChange?.(null);
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
          data-coach-ex-id={coachExId}
          data-coach-set-id={coachSetId}
          data-coach-field={coachField}
          data-dirty-raw={rawDraft !== undefined ? 'true' : undefined}
          onFocus={(e) => {
            if (disabled) return;
            setFocused(true);
            if (coachExId) {
              registerFocusedField({
                exId: coachExId,
                setId: coachSetId,
                field: coachField ?? 'unknown',
              });
            }
            // 同步全选：rAF 延迟会在用户已开始输入后再选中全部，
            // 导致第二位输入替换第一位（7.5 → .5）。这里用同步 select。
            e.currentTarget.select();
          }}
          onBlur={() => {
            setFocused(false);
            if (coachExId) {
              unregisterFocusedField({
                exId: coachExId,
                setId: coachSetId,
                field: coachField ?? 'unknown',
              });
            }
            setDraft(rawDraft ?? (value === null ? '' : String(value)));
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
