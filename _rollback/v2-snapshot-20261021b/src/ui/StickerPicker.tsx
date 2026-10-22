/* 胸 / 背 / 腿 贴纸选择 —— 08 的记忆点，改成可访问的 tablist。
   贴纸错位角度固定但每张不同，避免机械重复；点击区域 ≥ 44px。 */

const FOCUS_META = {
  chest: { cn: '胸', label: 'CHEST' },
  back: { cn: '背', label: 'BACK' },
  legs: { cn: '腿', label: 'LEGS' },
} as const;

const TILT = { chest: -7, back: 2, legs: 8 } as const;
const OFFSET = { chest: 0, back: 10, legs: -4 } as const;

export type Focus = keyof typeof FOCUS_META;

interface Props {
  value: Focus;
  onChange: (f: Focus) => void;
  /** 该分部是否已有可用训练日，未启用时显示为可选但提示 */
  available?: Record<Focus, boolean>;
}

export function StickerPicker({ value, onChange, available }: Props) {
  const list: Focus[] = ['chest', 'back', 'legs'];
  return (
    <div
      role="tablist"
      aria-label="选择今天练哪个部位"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 8,
        padding: '6px 0 2px',
      }}
    >
      {list.map((f) => {
        const selected = value === f;
        const meta = FOCUS_META[f];
        const disabled = available ? !available[f] : false;
        return (
          <button
            key={f}
            role="tab"
            className="sticker"
            aria-selected={selected}
            aria-label={`${meta.cn}日${disabled ? '（计划中没有训练日）' : ''}`}
            onClick={() => onChange(f)}
            style={{
              transform: `rotate(${selected ? 0 : TILT[f]}deg) translateY(${selected ? 0 : OFFSET[f]}px)`,
              transition: 'transform .16s ease',
            }}
          >
            <span className="face">
              <span className="pin" aria-hidden="true" />
              <span className="cn">{meta.cn}</span>
              <span className="lab">{meta.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function focusLabel(f: Focus): string {
  return FOCUS_META[f].cn;
}
