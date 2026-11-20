/* 训练执行页顶部栏、只读/待存/冲突横幅与进度摘要（Wave 1C.1 模块拆分）。 */

import type { summarizeSession } from '../../domain/session';
import type { Session } from '../../domain/types';
import { fmtTime } from '../../lib/format';
import { ElapsedClock } from '../../ui/RestTimer';
import { CoachHeaderButton } from '../../coach/CoachHeaderButton';

export interface SessionHeaderProps {
  session: Session;
  summary: ReturnType<typeof summarizeSession>;
  saveState: 'idle' | 'saving' | 'error';
  lockBlocked: boolean;
  lockLostReason: string | null;
  hasPendingDraft: boolean;
  draftConflicts: Array<{ path: string; message: string }> | null;
  conflictMessage: string | null;
  inputPaused: boolean;
  isCommittedBusy: boolean;
  busyOwner: 'retry' | 'takeover' | null;
  onBack: () => void;
  onRequestOpenSummary: () => void;
  onTakeOver: () => void;
  onRetryUnsaved: () => void;
  onDiscardPendingDraft: () => void;
  onRefreshSessions: () => void;
  onClearConflictAndRefresh: () => void;
}

export function SessionHeader({
  session,
  summary,
  saveState,
  lockBlocked,
  lockLostReason,
  hasPendingDraft,
  draftConflicts,
  conflictMessage,
  inputPaused,
  isCommittedBusy,
  busyOwner,
  onBack,
  onRequestOpenSummary,
  onTakeOver,
  onRetryUnsaved,
  onDiscardPendingDraft,
  onRefreshSessions,
  onClearConflictAndRefresh,
}: SessionHeaderProps) {
  return (
    <>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 4 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack} aria-label="返回">
          ‹ 返回
        </button>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--f-serif)', fontSize: 17, fontWeight: 700 }}>{session.day.dayName}</div>
          <div className="mono-label" style={{ fontSize: 11 }}>
            {fmtTime(session.startedAt)} 开始 ·{' '}
            <ElapsedClock
              startedAt={session.startedAt}
              pausedMs={session.pausedMs}
              pausedAt={session.pausedAt}
              endedAt={session.endedAt}
            />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <CoachHeaderButton compact />
          <button
            className="btn btn-sm btn-primary"
            onClick={onRequestOpenSummary}
            disabled={lockBlocked}
            title={
              lockBlocked
                ? '正在另一个标签页中编辑'
                : inputPaused
                  ? '请先处理未保存的改动或取得编辑控制'
                  : undefined
            }
          >
            结束
          </button>
        </div>
      </header>

      {saveState === 'error' ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: '#2a1109',
            color: '#ffe9e2',
            fontSize: 14,
            borderLeft: '3px solid #d8452a',
          }}
        >
          本地保存失败，最近的修改可能没有写入。请检查浏览器存储空间，或先导出备份再重试。
        </div>
      ) : null}

      {lockBlocked ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--warn)',
            lineHeight: 1.65,
          }}
        >
          <strong>本页只读，暂时不能记录。</strong>
          {lockLostReason ?? '这个训练正在另一个标签页中编辑。'}
          <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ink-2)' }}>
            为避免互相覆盖，本页不写入任何改动，<strong>次数/重量/完成/备注/热身等输入已停用</strong>
            （不会出现"看似能打字、实际没保存"）。可以在原标签页继续，或在这里接管（接管后原标签页会转入只读）。
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={isCommittedBusy}
              onClick={onTakeOver}
            >
              {busyOwner === 'takeover' ? '正在接管…' : '接管继续编辑'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={isCommittedBusy}
              onClick={onRetryUnsaved}
            >
              {busyOwner === 'retry' ? '正在重试…' : '重试保存这次改动'}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onRefreshSessions}>
              刷新数据看看
            </button>
          </div>
          {saveState === 'error' ? (
            <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-2)' }}>
              最近一次改动<strong>还没有写进本机</strong>，仍保留在本页内存中。
              取得编辑控制后点「重试保存这次改动」，或先记下来再刷新。
            </div>
          ) : null}
        </div>
      ) : null}

      {hasPendingDraft ? (
        <div
          role="status"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--brick)',
            lineHeight: 1.65,
          }}
        >
          <strong>还有改动没有写进本机。</strong>
          <span style={{ color: 'var(--ink-2)' }}>
            {' '}
            这份内容仍保留在本页；确认后可以重试保存。若另一页也改过同一处，会提示冲突而不会覆盖它。
          </span>
          {draftConflicts ? (
            <div
              style={{
                marginTop: 10,
                padding: '8px 10px',
                background: 'var(--paper)',
                borderLeft: '3px solid var(--brick)',
                fontSize: 12.5,
                lineHeight: 1.7,
              }}
            >
              <strong>本页草稿与另一个页面冲突，未覆盖任何数据。</strong>
              <div style={{ marginTop: 4, color: 'var(--ink-2)' }}>
                另一页也改过下面这些内容，所以本页没有整份保存。草稿仍保留在本页：
              </div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {draftConflicts.slice(0, 6).map((c) => (
                  <li key={c.path} style={{ marginBottom: 2 }}>
                    {c.path}：{c.message}
                  </li>
                ))}
              </ul>
              {draftConflicts.length > 6 ? (
                <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>还有 {draftConflicts.length - 6} 处…</div>
              ) : null}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={isCommittedBusy}
              onClick={onRetryUnsaved}
            >
              {busyOwner === 'retry' ? '正在保存…' : '重试保存这次改动'}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              disabled={isCommittedBusy}
              onClick={onDiscardPendingDraft}
            >
              放弃这份改动
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--ink-3)' }}>
            处理完这份改动后才能继续记录（次数、重量、加删组、备注、热身与结束训练都已暂停）。
          </div>
        </div>
      ) : null}

      {conflictMessage ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 14,
            borderLeft: '3px solid var(--brick)',
            lineHeight: 1.65,
          }}
        >
          {conflictMessage}
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-sm btn-ghost" onClick={onClearConflictAndRefresh}>
              刷新到最新数据
            </button>
          </div>
        </div>
      ) : null}

      <div
        style={{
          marginTop: 12,
          padding: '10px 12px',
          background: 'var(--paper-3)',
          display: 'flex',
          gap: 16,
          alignItems: 'baseline',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ fontFamily: 'var(--f-num)', fontSize: 22, fontWeight: 700 }}>
          {summary.completedSets}
          <span style={{ fontSize: 13, fontFamily: 'var(--f-sans)', color: 'var(--ink-3)', marginLeft: 3 }}>
            / {summary.targetSets} 组
          </span>
        </span>
        {summary.partialGroups > 0 ? (
          <span className="tag tag-warn">{summary.partialGroups} 个部分大组</span>
        ) : null}
        {summary.incompleteSets > 0 ? (
          <span className="tag tag-warn">{summary.incompleteSets} 组缺次数</span>
        ) : null}
        <span style={{ fontSize: 13, color: 'var(--ink-3)' }}>
          {summary.exercisesDone} 完成 · {summary.exercisesPartial} 部分 · {summary.exercisesSkipped} 跳过 ·{' '}
          {summary.exercisesPending} 未记录
        </span>
      </div>
    </>
  );
}
