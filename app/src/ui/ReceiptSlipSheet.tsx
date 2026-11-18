/* Wave 3D.2：纸墨账本风「完赛总结小票」弹层 + 纯本地 Canvas PNG 导出。 */

import { useMemo, useState } from 'react';
import { detectSessionPRs } from '../domain/prDetector';
import type { Session } from '../domain/types';
import { exportPngFile } from '../lib/backupFile';
import { buildReceiptDataModel, renderReceiptPng } from '../lib/receiptCanvas';
import { Sheet } from './Sheet';

let pendingFinishReceiptSessionId: string | null = null;

/** 结束训练成功并即将跳转到历史详情页时登记一次性完赛小票弹出意图 */
export function markPendingFinishReceipt(sessionId: string): void {
  pendingFinishReceiptSessionId = sessionId;
}

/** 历史详情页消费一次性完赛小票弹出意图（读取即清除，刷页或重进不重复弹出） */
export function consumePendingFinishReceipt(sessionId: string): boolean {
  if (pendingFinishReceiptSessionId === sessionId) {
    pendingFinishReceiptSessionId = null;
    return true;
  }
  return false;
}

export interface ReceiptSlipSheetProps {
  open: boolean;
  session: Session;
  allSessions: readonly Session[];
  onClose: () => void;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
}

export function ReceiptSlipSheet({
  open,
  session,
  allSessions,
  onClose,
  pushToast,
}: ReceiptSlipSheetProps) {
  const [exporting, setExporting] = useState(false);

  const prReport = useMemo(
    () => detectSessionPRs(allSessions, session),
    [allSessions, session],
  );
  const model = useMemo(
    () => buildReceiptDataModel(session, prReport),
    [session, prReport],
  );

  const handleSaveImage = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const rendered = await renderReceiptPng(model);
      const out = await exportPngFile(model.filename, rendered.base64, rendered.blob);
      if (out.ok) {
        pushToast(`小票图片已保存（${out.filename}）`, 'ok');
      } else if (!out.cancelled) {
        pushToast(out.error || '保存小票图片未成功', 'error');
      }
    } catch (err) {
      pushToast(err instanceof Error ? `生成小票图片失败：${err.message}` : '生成小票图片失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="完赛总结小票"
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="receipt-export-png"
            disabled={exporting}
            style={{ flex: 1 }}
            onClick={() => void handleSaveImage()}
          >
            {exporting ? '正在生成图片…' : '保存小票图片'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="receipt-close"
            style={{ flex: '0 0 88px' }}
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      }
    >
      <div
        data-testid="receipt-slip-card"
        style={{
          background: 'var(--paper-2)',
          border: '1px solid var(--rule-strong)',
          borderTop: '3px double var(--ink)',
          borderBottom: '3px double var(--ink)',
          padding: '16px 16px 14px',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            fontFamily: 'var(--f-mono)',
            fontSize: 10.5,
            color: 'var(--ink-4)',
            letterSpacing: '0.06em',
          }}
        >
          <span>MOTION · RECEIPT</span>
          <span>{model.dateLine}</span>
        </div>

        <div
          style={{
            marginTop: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--f-serif)',
                fontSize: 22,
                fontWeight: 700,
                lineHeight: 1.25,
                color: 'var(--ink)',
              }}
            >
              {model.title}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 3 }}>{model.planLine}</div>
          </div>

          <span
            data-testid="receipt-stamp"
            style={{
              flex: 'none',
              display: 'inline-block',
              padding: '3px 9px',
              border: `2px solid ${model.prs.length > 0 ? 'var(--brick)' : 'var(--ink-2)'}`,
              color: model.prs.length > 0 ? 'var(--brick)' : 'var(--ink-2)',
              fontFamily: 'var(--f-mono)',
              fontSize: 11.5,
              fontWeight: 700,
              transform: 'rotate(-5deg)',
              letterSpacing: '0.04em',
            }}
          >
            {model.prs.length > 0 ? `PR × ${model.prs.length}` : 'LOGGED'}
          </span>
        </div>

        <div
          style={{
            marginTop: 12,
            padding: '10px 0',
            borderTop: '1.5px solid var(--ink)',
            borderBottom: '1px dashed var(--rule-strong)',
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div className="mono-label">训练时长</div>
            <div style={{ fontFamily: 'var(--f-num)', fontSize: 19, fontWeight: 700 }}>
              {model.durationLabel}
            </div>
          </div>
          <div>
            <div className="mono-label">完成规模</div>
            <div style={{ fontFamily: 'var(--f-num)', fontSize: 19, fontWeight: 700 }}>
              {model.setsLabel}
            </div>
          </div>
          {model.cardioLabel ? (
            <div>
              <div className="mono-label">有氧有效</div>
              <div style={{ fontFamily: 'var(--f-num)', fontSize: 19, fontWeight: 700 }}>
                {model.cardioLabel}
              </div>
            </div>
          ) : null}
        </div>

        {model.prs.length > 0 ? (
          <div
            data-testid="receipt-pr-section"
            style={{
              marginTop: 10,
              paddingBottom: 10,
              borderBottom: '1px dashed var(--rule-strong)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--brick)',
                marginBottom: 6,
              }}
            >
              ★ 本次刷新同口径个人纪录（{model.prs.length} 项）
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {model.prs.map((pr, idx) => (
                <div key={`${pr.exerciseName}-${pr.stampLabel}-${idx}`} style={{ fontSize: 13 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ color: 'var(--ink)' }}>{pr.exerciseName}</strong>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '1px 6px',
                        border: '1px solid var(--brick)',
                        color: 'var(--brick)',
                      }}
                    >
                      {pr.stampLabel}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 1 }}>{pr.detailText}</div>
                </div>
              ))}
            </div>
          </div>
        ) : model.firstRecordCount > 0 ? (
          <div
            style={{
              marginTop: 10,
              paddingBottom: 8,
              borderBottom: '1px dashed var(--rule-strong)',
              fontSize: 12,
              color: 'var(--ink-3)',
            }}
          >
            ● 本次首次建立 {model.firstRecordCount} 个动作的同口径基准记录
          </div>
        ) : null}

        <div style={{ marginTop: 10 }}>
          <div className="mono-label" style={{ marginBottom: 6 }}>
            动作与有氧明细
          </div>
          {model.items.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-4)' }}>本次未录入有效正式组或有氧时长</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {model.items.map((it, idx) => (
                <div
                  key={`${it.name}-${idx}`}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 10,
                    fontSize: 13,
                  }}
                >
                  <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{it.name}</span>
                  <span
                    style={{
                      fontFamily: 'var(--f-num)',
                      fontSize: 12.5,
                      color: it.prBadge ? 'var(--brick)' : 'var(--ink-2)',
                      textAlign: 'right',
                      flex: 'none',
                    }}
                  >
                    {it.summary}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {model.note ? (
          <div
            style={{
              marginTop: 10,
              paddingTop: 8,
              borderTop: '1px dashed var(--rule)',
              fontSize: 12.5,
              color: 'var(--ink-2)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
            }}
          >
            备注：{model.note}
          </div>
        ) : null}

        <div
          style={{
            marginTop: 12,
            textAlign: 'center',
            fontFamily: 'var(--f-mono)',
            fontSize: 10,
            color: 'var(--ink-4)',
            letterSpacing: '0.06em',
          }}
        >
          LOCAL LEDGER · ZERO NETWORK · OFFLINE FIRST
        </div>
      </div>
    </Sheet>
  );
}
