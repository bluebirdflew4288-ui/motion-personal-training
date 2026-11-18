/* 训练执行页热身检查列表（Wave 1C.1 模块拆分 + memo 隔离）。 */

import { memo } from 'react';
import type { Session, SessionWarmup } from '../../domain/types';

export interface SessionWarmupSectionProps {
  warmups: SessionWarmup[];
  inputPaused: boolean;
  applyChange: (fn: (prev: Session) => Session) => unknown;
}

function areWarmupPropsEqual(prev: SessionWarmupSectionProps, next: SessionWarmupSectionProps): boolean {
  if (prev.inputPaused !== next.inputPaused) return false;
  if (prev.applyChange !== next.applyChange) return false;
  if (prev.warmups === next.warmups) return true;
  if (prev.warmups.length !== next.warmups.length) return false;
  for (let i = 0; i < prev.warmups.length; i++) {
    const a = prev.warmups[i];
    const b = next.warmups[i];
    if (a.id !== b.id || a.done !== b.done || a.name !== b.name || a.targetText !== b.targetText) {
      return false;
    }
  }
  return true;
}

export const SessionWarmupSection = memo(function SessionWarmupSection({
  warmups,
  inputPaused,
  applyChange,
}: SessionWarmupSectionProps) {
  if (!warmups.length) return null;
  return (
    <section style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 className="h-section">热身</h2>
        <span className="mono-label">不计入正式组</span>
      </div>
      <div className="slip" style={{ marginTop: 8, padding: '4px 14px' }}>
        {warmups.map((w) => (
          <label
            key={w.id}
            className="row"
            style={{ borderBottom: '1px dashed var(--rule)', minHeight: 48, cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={w.done}
              disabled={inputPaused}
              onChange={(e) => {
                if (inputPaused) return;
                applyChange((prev) => ({
                  ...prev,
                  warmups: prev.warmups.map((x) => (x.id === w.id ? { ...x, done: e.target.checked } : x)),
                }));
              }}
              style={{ width: 22, height: 22, accentColor: 'var(--brick)', flex: 'none' }}
            />
            <span className="row-main">
              <span className="row-title" style={{ fontWeight: 500 }}>
                {w.name}
              </span>
              <span className="row-sub">{w.targetText}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}, areWarmupPropsEqual);
