/* 目标文案的排版组件（审计 R2-02 / R2-10）。
   规则：
   · 动作名永远是主轴，不因为长目标被压缩（不用 nowrap + minWidth:0 硬塞）。
   · 普通动作：名称一行 + 短目标一行。
   · 递减组等复杂目标：名称一行 + 「三轮递减」摘要一行，阶段明细另起一块可换行。
   · 绝不把整段阶段链塞进不可收缩的右列。 */

import type { PlanExercise } from '../domain/types';

export function targetSummary(ex: PlanExercise): string {
  const t = ex.target;
  if (t.kind === 'dropSet') {
    return `${t.rounds} 轮递减组`;
  }
  const sets = t.setsMax > t.sets ? `${t.sets}–${t.setsMax}` : `${t.sets}`;
  if (t.sets === 0 && t.setsMax === 0) return '可选 · 未安排';
  return `${sets} 组 × ${t.repsMin}–${t.repsMax} 次`;
}

/** 递减组阶段明细（单独成块，允许换行） */
export function DropStageList({ ex }: { ex: PlanExercise }) {
  const t = ex.target;
  if (t.kind !== 'dropSet') return null;
  return (
    <div
      style={{
        marginTop: 6,
        fontSize: 12.5,
        color: 'var(--ink-3)',
        lineHeight: 1.65,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      {t.stages.map((st, i) => (
        <span key={`${st.label}-${i}`} style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {st.label}：{st.targetText}
        </span>
      ))}
      <span style={{ color: 'var(--ink-4)' }}>
        三轮 = 三个正式大组；阶段间休 {Math.round(t.restInSec)} 秒，轮间休 {Math.round(t.restAfterSec / 60)} 分钟
      </span>
    </div>
  );
}

/** 概览里的一行动作：名称在上，目标在下，任何长度都换行而不溢出 */
export function ExerciseOverviewRow({ ex }: { ex: PlanExercise }) {
  const isDrop = ex.target.kind === 'dropSet';
  return (
    <li
      style={{
        padding: '8px 0',
        borderBottom: '1px dashed var(--rule)',
        listStyle: 'none',
        minWidth: 0,
      }}
    >
      <span
        style={{
          display: 'block',
          fontSize: 15,
          fontWeight: 500,
          lineHeight: 1.4,
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {ex.name}
      </span>
      <span
        style={{
          display: 'block',
          fontSize: 13,
          color: 'var(--ink-3)',
          marginTop: 2,
          lineHeight: 1.5,
          whiteSpace: 'normal',
          overflowWrap: 'anywhere',
        }}
      >
        {targetSummary(ex)}
        {isDrop ? ' · 详见阶段' : ''}
      </span>
      {isDrop ? <DropStageList ex={ex} /> : null}
    </li>
  );
}
