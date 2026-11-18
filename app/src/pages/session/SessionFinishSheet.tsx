/* 训练执行页「结束训练」摘要与确认面板（Wave 1C.1 模块拆分）。 */

import type { summarizeSession } from '../../domain/session';
import type { PlanSyncDiff } from '../../domain/sessionToPlanSync';
import type { Session } from '../../domain/types';
import { fmtDuration } from '../../lib/format';
import { Sheet } from '../../ui/Sheet';

export interface SessionFinishSheetProps {
  open: boolean;
  session: Session;
  summary: ReturnType<typeof summarizeSession>;
  effectiveAdvance: boolean;
  isCurrentCycleDay: boolean;
  finishing: boolean;
  planSyncDiff?: PlanSyncDiff | null;
  syncBackToPlanDay?: boolean;
  onSyncBackToPlanDayChange?: (checked: boolean) => void;
  onClose: () => void;
  onAdvanceChange: (checked: boolean) => void;
  onConfirmFinish: () => void;
  applyChange: (fn: (prev: Session) => Session) => unknown;
}

export function SessionFinishSheet({
  open,
  session,
  summary,
  effectiveAdvance,
  isCurrentCycleDay,
  finishing,
  planSyncDiff,
  syncBackToPlanDay = false,
  onSyncBackToPlanDayChange,
  onClose,
  onAdvanceChange,
  onConfirmFinish,
  applyChange,
}: SessionFinishSheetProps) {
  return (
    <Sheet
      open={open}
      title="结束训练"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {planSyncDiff?.eligible && onSyncBackToPlanDayChange ? (
            <label
              data-testid="finish-sync-plan-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                background: 'var(--paper-3)',
                borderLeft: syncBackToPlanDay ? '3px solid var(--brick)' : '3px solid var(--rule-strong)',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              <input
                type="checkbox"
                data-testid="finish-sync-plan-checkbox"
                checked={syncBackToPlanDay}
                onChange={(e) => onSyncBackToPlanDayChange(e.target.checked)}
                style={{ width: 20, height: 20, accentColor: 'var(--brick)', flex: 'none' }}
              />
              <span style={{ lineHeight: 1.5 }}>
                同时将今日动作编排更新回计划「{planSyncDiff.planName} · {planSyncDiff.dayName}」
                <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                  检测到本次编排变化：{planSyncDiff.summaryText}（只同步纯配置与顺序，不带入当次组记录）
                </span>
              </span>
            </label>
          ) : null}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              background: 'var(--paper-3)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            <input
              type="checkbox"
              checked={effectiveAdvance}
              onChange={(e) => onAdvanceChange(e.target.checked)}
              style={{ width: 20, height: 20, accentColor: 'var(--brick)', flex: 'none' }}
            />
            <span style={{ lineHeight: 1.5 }}>
              结束后推进一个循环位置
              <span style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                {isCurrentCycleDay
                  ? `本次训练的就是循环当前日（${session.day.dayName}），默认推进`
                  : `本次是临时训练「${session.day.dayName}」，不在循环当前位置，默认不推进`}
              </span>
            </span>
          </label>
          <button className="btn btn-primary btn-lg" disabled={finishing} onClick={onConfirmFinish}>
            {finishing ? '正在结束…' : '确认结束并保存'}
          </button>
          <button className="btn btn-ghost" style={{ width: '100%' }} onClick={onClose}>
            继续训练
          </button>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
          <span style={{ color: 'var(--ink-3)' }}>时长</span>
          <strong style={{ fontFamily: 'var(--f-num)' }}>{fmtDuration(summary.durationMs)}</strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
          <span style={{ color: 'var(--ink-3)' }}>实际完成组</span>
          <strong>
            {summary.completedSets}
            <span style={{ fontSize: 13, color: 'var(--ink-3)' }}> （计划 {summary.targetSets}）</span>
          </strong>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
          <span style={{ color: 'var(--ink-3)' }}>本次安排组数</span>
          <strong>{summary.plannedSets}</strong>
        </div>
        {summary.incompleteSets || summary.partialGroups ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
            <span style={{ color: 'var(--ink-3)' }}>缺数据 / 部分</span>
            <strong>
              {summary.incompleteSets} 组缺次数
              {summary.partialGroups ? ` · ${summary.partialGroups} 个部分大组` : ''}
            </strong>
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
          <span style={{ color: 'var(--ink-3)' }}>动作</span>
          <strong>
            完成 {summary.exercisesDone} · 部分 {summary.exercisesPartial} · 跳过 {summary.exercisesSkipped} · 未记录{' '}
            {summary.exercisesPending}
          </strong>
        </div>
        <div>
          <div className="mono-label" style={{ marginBottom: 4 }}>
            未完成 / 跳过
          </div>
          <div style={{ fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>
            {session.exercises
              .filter((ex) => ex.status !== 'done')
              .map((ex) => `${ex.name}${ex.status === 'skipped' ? '（跳过）' : ''}`)
              .join('、') || '无'}
          </div>
        </div>
        <div className="field">
          <label htmlFor="sess-note">训练备注</label>
          <textarea
            id="sess-note"
            className="input"
            value={session.note}
            placeholder="整体感受、状态、器械情况…"
            onChange={(e) => applyChange((prev) => ({ ...prev, note: e.target.value }))}
          />
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0, lineHeight: 1.6 }}>
          未填写的组不会被当成已完成；部分完成会保留并标注。结束后可在历史里纠正。
        </p>
      </div>
    </Sheet>
  );
}
