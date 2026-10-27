/* 每个 PlanDay 一张贴纸（G4）—— 08 的记忆点，保留贴纸风格与可访问语义。
   ── 为什么重写 ────────────────────────────────────────────────
   旧实现是写死的胸/背/腿三个 focus 贴纸（FOCUS_META），
   无法表达二/四/五分化或任意自定义训练日。
   现在：**每个具体 PlanDay 一张**，身份是 `planId + day.id`，
   名称/数量/顺序直接来自计划，不按名字/focus/round 合并。

   ── 边界（已裁决）────────────────────────────────────────────
   · 上肢/下肢两日 → 恰好两张，**不自动补 A/B**；
   · 同名不同 ID 的两日 → 分别可选，各命中具体 day；
   · cardio/rest 日按计划出现（不伪造）；
   · 选择本身**不推进 cursor**（本组件只上报 onChange）；
   · 循环当前高亮由父级传入，本组件只做视觉区分。 */

import type { CSSProperties } from 'react';
import type { Plan, PlanDay } from '../domain/types';

/** 日类型的中文短标签（不参与身份，仅用于可读性） */
const KIND_LABEL: Record<PlanDay['kind'], string> = {
  train: '力量',
  cardio: '有氧',
  rest: '休息',
};

/**
 * 贴纸倾斜/错位：按**索引**取值而不是按 focus。
 * 索引来自计划里的真实顺序，因此任意分化都有稳定的视觉节奏。
 */
const TILT = [-7, 2, 8, -4, 5, -9, 3, 7];
const OFFSET = [0, 10, -4, 6, -2, 8, -6, 4];

function tiltOf(i: number): number {
  return TILT[i % TILT.length] as number;
}
function offsetOf(i: number): number {
  return OFFSET[i % OFFSET.length] as number;
}

/**
 * 长名可读：不截断成省略号（那会让"同名不同 ID"更难分辨），
 * 而是允许换行并把字号**按字数阶梯下调**；连续拉丁字母用 wordBreak 保证不溢出。
 */
export function cnFontSize(name: string): number {
  const n = Array.from(name).length;
  if (n <= 2) return 26;
  if (n <= 3) return 19;
  if (n <= 4) return 16;
  if (n <= 6) return 13;
  if (n <= 9) return 11.5;
  return 10.5;
}

function nameStyle(name: string): CSSProperties {
  return {
    fontSize: cnFontSize(name),
    lineHeight: 1.2,
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
    textAlign: 'center',
  };
}

interface Props {
  /** 贴纸列表（由 planDayStickers 生成，顺序即 plan.days 顺序） */
  items: DaySticker[];
  /** 当前选中的**身份键**（planId::dayId） */
  value: string | null;
  /** 循环当前日的身份键（仅高亮，不改变选择语义） */
  cycleKey?: string | null;
  /** 选择回调：只上报具体贴纸，不推进 cursor、不写库 */
  onSelect: (item: DaySticker) => void;
}

export function StickerPicker({ items, value, cycleKey, onSelect }: Props) {
  if (!items.length) {
    return (
      <div className="empty" style={{ width: '100%' }}>
        <div className="empty-title" style={{ padding: 16 }}>计划里还没有训练日</div>
      </div>
    );
  }
  return (
    <div
      role="tablist"
      aria-label="选择今天练哪一天"
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap: 8,
        padding: '10px 0 2px',
        flexWrap: 'wrap',
      }}
    >
      {items.map((item, i) => {
        const selected = value === item.key;
        const isCycle = cycleKey === item.key;
        return (
          <button
            key={item.key}
            role="tab"
            className="sticker"
            aria-selected={selected}
            /* 无障碍名包含类型与循环状态，便于读屏区分同名日 */
            aria-label={`${item.name}（${KIND_LABEL[item.kind]}${isCycle ? '，循环当前' : ''}）`}
            title={`${item.name} · ${KIND_LABEL[item.kind]}日${isCycle ? ' · 循环当前' : ''}`}
            data-day-id={item.dayId}
            data-sticker-key={item.key}
            onClick={() => onSelect(item)}
            style={{
              transform: `rotate(${selected ? 0 : tiltOf(i)}deg) translateY(${selected ? 0 : offsetOf(i)}px)`,
              transition: 'transform .16s ease',
              /* 长名可读：给足宽度而不是压扁 */
              minWidth: 64,
              maxWidth: 110,
              minHeight: 44,
            }}
          >
            <span
              className="face"
              style={{
                /* 允许长名把贴纸撑高，而不是把字压到看不清 */
                height: 'auto',
                minHeight: 74,
                padding: '10px 6px 18px',
              }}
            >
              <span className="pin" aria-hidden="true" />
              <span className="cn" style={nameStyle(item.name)}>
                {item.name}
              </span>
              <span className="lab">{KIND_LABEL[item.kind]}</span>
            </span>
            {isCycle ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  zIndex: 4,
                  background: 'var(--brick)',
                  color: 'var(--paper)',
                  fontFamily: 'var(--f-mono)',
                  fontSize: 9,
                  letterSpacing: '0.06em',
                  lineHeight: 1.5,
                  padding: '1px 4px',
                  whiteSpace: 'nowrap',
                  boxShadow: '1px 1px 0 rgba(0, 0, 0, 0.3)',
                }}
              >
                当前
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 贴纸显示名。
 *
 * 保留导出是因为既有代码可能用它做标签；现在它不再依赖 focus 枚举，
 * 任意 day.name 都可直接显示。
 */
export function dayLabel(item: DaySticker): string {
  return item.name;
}

/**
 * 贴纸的身份键：`planId + day.id`（G4 已裁决）。
 *
 * 用 key 而不是名字/focus/round，保证：
 * · 同名不同 ID 的两日各自独立；
 * · 重命名不改变身份（选中保持）；
 * · 换序不改变身份（选中保持）。
 */
export function dayStickerKey(planId: string, dayId: string): string {
  return `${planId}::${dayId}`;
}

/** 一张贴纸的展示模型（父级据此渲染，不含任何身份推断） */
export interface DaySticker {
  /** 稳定身份键：planId::dayId */
  key: string;
  planId: string;
  dayId: string;
  /** 显示名，直接来自 PlanDay.name */
  name: string;
  kind: PlanDay['kind'];
  /** 该日动作数（仅展示用） */
  exerciseCount: number;
  /** 是否为循环当前日（只影响高亮，不改变选择） */
  isCycle: boolean;
}

/**
 * 由计划生成**每个 PlanDay 一张**贴纸的列表。
 *
 * <p>关键：**不做任何合并**。不按 name 合并、不按 focus 合并、不按 round 合并，
 * 也不补 A/B；顺序完全来自 `plan.days` 数组。
 */
export function planDayStickers(
  plan: { id: string; days: PlanDay[] } | null | undefined,
  cycleDayId?: string | null,
): DaySticker[] {
  if (!plan) return [];
  return plan.days.map((d) => ({
    key: dayStickerKey(plan.id, d.id),
    planId: plan.id,
    dayId: d.id,
    name: d.name,
    kind: d.kind,
    exerciseCount: d.exercises.length,
    isCycle: cycleDayId === d.id,
  }));
}

/* ── 纯选择逻辑（G4：选择不写库、不改 cursor）───────────────
   抽成纯函数是为了让「选择只落在内存」这件事可被测试直接锁住：
   输入是 (plan, 当前选中 id, 被点中的 dayId)，输出只是「选中哪个 day」。
   签名里没有 Plan 返回、没有 cursor 写入、没有存储入口 —— 想写库都写不进去。 */

/**
 * 解析「当前应该显示哪一天」。
 *
 * · 选中 id 仍存在于 `plan.days` → 用它（**只按 id 匹配**，不看名字/focus/round）；
 * · 选中 id 失效（计划被改/被删/换了计划）→ 回落到循环当前位置，不报错；
 * · 计划没有 days → undefined。
 *
 * 回落只影响显示，**不写库、不改 cursor**。
 */
export function resolveSelectedDay(
  plan: { days: PlanDay[]; cursor: number } | null | undefined,
  selectedDayId: string | null | undefined,
): PlanDay | undefined {
  if (!plan || !plan.days.length) return undefined;
  const picked = selectedDayId ? plan.days.find((d) => d.id === selectedDayId) : undefined;
  if (picked) return picked;
  return plan.days[plan.cursor] ?? plan.days[0];
}

/**
 * 点贴纸之后新的选中 id（纯函数）。
 *
 * 明确**不读也不写 cursor**：这里只传递 day.id。
 * 循环位置仍只由用户显式动作改变（推进 / 跳过 / 结束训练时选择）。
 */
export function nextSelectedDayId(clickedDayId: string): string {
  return clickedDayId;
}

/** 选中项是否就是循环当前（只用于提示文案，不改变任何状态） */
export function isCycleDay(
  plan: Pick<Plan, 'cursor' | 'days'> | null | undefined,
  dayId: string | null | undefined,
): boolean {
  if (!plan || !dayId) return false;
  const cur = plan.days[plan.cursor];
  return !!cur && cur.id === dayId;
}
