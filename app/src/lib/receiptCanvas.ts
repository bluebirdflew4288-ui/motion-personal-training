/* Wave 3D.2：完赛总结小票纯本地 HTML5 Canvas 高清纸墨 PNG 渲染器。
   零外部依赖、零网络请求、100% 本地离线生成。 */

import { CARDIO_PRESET_LABEL, describeCardioParams } from '../domain/cardio';
import { modeOf } from '../domain/comparability';
import type { SessionPRReport } from '../domain/prDetector';
import { dropRoundComplete, isSetLogged, roundsOf, summarizeSession } from '../domain/session';
import { sessionKindOf } from '../domain/sessionKind';
import type { Session, SessionExercise } from '../domain/types';
import { fmtDate, fmtDuration, fmtTime, fmtWeight } from './format';

export interface ReceiptLedgerItem {
  name: string;
  summary: string;
  prBadge?: string;
}

export interface ReceiptDataModel {
  filename: string;
  title: string;
  planLine: string;
  dateLine: string;
  durationLabel: string;
  setsLabel: string;
  cardioLabel: string | null;
  prs: Array<{ exerciseName: string; stampLabel: string; detailText: string }>;
  firstRecordCount: number;
  items: ReceiptLedgerItem[];
  note: string;
}

function summarizeExerciseBestLine(ex: SessionExercise): string | null {
  const logged = ex.sets.filter(isSetLogged);
  if (logged.length === 0) return null;
  const completedRounds = roundsOf(ex).filter((r) => dropRoundComplete(ex, r)).length;
  const { weightMode } = modeOf(ex);

  let best = logged[0];
  for (const st of logged) {
    const rA = st.reps ?? 0;
    const rB = best.reps ?? 0;
    if (weightMode === 'bodyweight') {
      if (rA > rB) best = st;
    } else if (weightMode === 'assisted') {
      if (
        st.weightKg !== null &&
        (best.weightKg === null ||
          st.weightKg < best.weightKg ||
          (st.weightKg === best.weightKg && rA > rB))
      ) {
        best = st;
      }
    } else if (
      st.weightKg !== null &&
      (best.weightKg === null ||
        st.weightKg > best.weightKg ||
        (st.weightKg === best.weightKg && rA > rB))
    ) {
      best = st;
    }
  }

  const groupWord = ex.target.kind === 'dropSet' ? `${completedRounds || 1} 轮` : `${logged.length} 组`;
  if (best.weightKg !== null && weightMode !== 'bodyweight') {
    const prefix = weightMode === 'assisted' ? '辅助 ' : '';
    return `${groupWord} · 最佳 ${prefix}${fmtWeight(best.weightKg)}kg × ${best.reps ?? 0}`;
  }
  return `${groupWord} · 最佳 ${best.reps ?? 0} 次`;
}

export function receiptFileName(session: Session): string {
  const d = new Date(session.endedAt ?? session.startedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `motion-slip-${y}${m}${day}-${hh}${mm}.png`;
}

/**
 * 构建小票展示与 Canvas 绘图共用的数据结构（纯函数，可在无 DOM 单测中断言）。
 */
export function buildReceiptDataModel(session: Session, prReport: SessionPRReport): ReceiptDataModel {
  const kind = sessionKindOf(session);
  const endTs = session.endedAt ?? Date.now();
  const summary = summarizeSession(session, endTs);
  const cardioList = session.cardio ?? [];

  const items: ReceiptLedgerItem[] = [];
  for (const ex of session.exercises) {
    const line = summarizeExerciseBestLine(ex);
    if (!line) continue;
    const achs = prReport.bySessionExerciseId.get(ex.id) ?? [];
    const topPr = achs.find((a) => a.isPr);
    items.push({
      name: ex.name,
      summary: line,
      ...(topPr ? { prBadge: topPr.stampLabel } : {}),
    });
  }

  for (const c of cardioList) {
    if (c.elapsedMs <= 0 && c.segments.length === 0) continue;
    const label = c.name || CARDIO_PRESET_LABEL[c.preset];
    items.push({
      name: label,
      summary: `${fmtDuration(c.elapsedMs)} · ${describeCardioParams(c.preset, c.currentParams)}`,
    });
  }

  return {
    filename: receiptFileName(session),
    title: session.day.dayName,
    planLine: session.origin === 'temporary' ? '临时训练' : session.planName,
    dateLine: `${fmtDate(session.startedAt)} ${fmtTime(session.startedAt)}`,
    durationLabel: fmtDuration(kind === 'cardio' && summary.cardioMs > 0 ? summary.cardioMs : summary.durationMs),
    setsLabel: kind === 'cardio' ? `${cardioList.length} 项有氧` : `${summary.completedSets} 组`,
    cardioLabel: summary.cardioMs > 0 ? fmtDuration(summary.cardioMs) : null,
    prs: prReport.prs.map((p) => ({
      exerciseName: p.exerciseName,
      stampLabel: p.stampLabel,
      detailText: p.detailText,
    })),
    firstRecordCount: prReport.firstRecords.length,
    items,
    note: (session.note ?? '').trim(),
  };
}

function wrapCanvasLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines = 3,
): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === '\n') {
      lines.push(current);
      current = '';
      if (lines.length >= maxLines) break;
      continue;
    }
    const candidate = current + ch;
    if (ctx.measureText(candidate).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, -1)}…`;
        return lines;
      }
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  return lines;
}

/**
 * 在本地离屏 Canvas 上绘制纸墨账本风小票并返回 PNG Base64 与 Blob。
 */
export async function renderReceiptPng(
  model: ReceiptDataModel,
): Promise<{ base64: string; blob: Blob | null; width: number; height: number }> {
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持本地画布导出');
  }

  const scale = 2;
  const width = 420;
  const padX = 28;
  const innerW = width - padX * 2;

  const displayItems = model.items.slice(0, 12);
  const extraItemCount = Math.max(0, model.items.length - displayItems.length);
  const prRows = model.prs.slice(0, 6);

  // 预估总高度
  let height = 246;
  if (prRows.length > 0) {
    height += 44 + prRows.length * 42;
  } else if (model.firstRecordCount > 0) {
    height += 34;
  }
  height += 36 + Math.max(1, displayItems.length) * 34 + (extraItemCount > 0 ? 24 : 0);
  if (model.note) {
    height += 68;
  }
  height += 66;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法初始化本地画布上下文');
  }
  ctx.scale(scale, scale);

  // 背景底色（深暖灰衬底凸显撕边纸张）
  ctx.fillStyle = '#e7e0cf';
  ctx.fillRect(0, 0, width, height);

  // 纸张主体与锯齿撕边
  const paperTop = 14;
  const paperBottom = height - 14;
  ctx.fillStyle = '#fbf7ec';
  ctx.strokeStyle = '#cfc6b1';
  ctx.lineWidth = 1;

  ctx.beginPath();
  const toothW = 10;
  const toothH = 5;
  ctx.moveTo(14, paperTop + toothH);
  for (let x = 14; x < width - 14; x += toothW) {
    const mid = Math.min(width - 14, x + toothW / 2);
    const next = Math.min(width - 14, x + toothW);
    ctx.lineTo(mid, paperTop);
    ctx.lineTo(next, paperTop + toothH);
  }
  ctx.lineTo(width - 14, paperBottom - toothH);
  for (let x = width - 14; x > 14; x -= toothW) {
    const mid = Math.max(14, x - toothW / 2);
    const next = Math.max(14, x - toothW);
    ctx.lineTo(mid, paperBottom);
    ctx.lineTo(next, paperBottom - toothH);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const fontSans = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", sans-serif';
  const fontSerif = '"Songti SC", "Noto Serif CJK SC", Georgia, serif';
  const fontMono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  let y = paperTop + 30;

  // 顶栏纪要标头
  ctx.fillStyle = '#7a7265';
  ctx.font = `600 11px ${fontMono}`;
  ctx.fillText('MOTION · TRAINING RECEIPT', padX, y);
  ctx.textAlign = 'right';
  ctx.fillText(model.dateLine, width - padX, y);
  ctx.textAlign = 'left';

  y += 28;
  ctx.fillStyle = '#1f1c16';
  ctx.font = `700 23px ${fontSerif}`;
  ctx.fillText(model.title.slice(0, 16), padX, y);

  y += 20;
  ctx.fillStyle = '#5c5549';
  ctx.font = `400 12.5px ${fontSans}`;
  ctx.fillText(model.planLine.slice(0, 28), padX, y);

  // 右上角盖章（若有 PR 盖砖红 PR 印章，否则盖墨色 DONE 章）
  ctx.save();
  ctx.translate(width - padX - 42, paperTop + 56);
  ctx.rotate(-0.11);
  const hasPr = prRows.length > 0;
  ctx.strokeStyle = hasPr ? '#a33b24' : '#3a352c';
  ctx.lineWidth = 2;
  ctx.strokeRect(-38, -15, 76, 30);
  ctx.fillStyle = hasPr ? '#a33b24' : '#3a352c';
  ctx.font = `700 12px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.fillText(hasPr ? `PR × ${model.prs.length}` : 'LOGGED', 0, 4);
  ctx.restore();
  ctx.textAlign = 'left';

  y += 16;
  ctx.strokeStyle = '#1f1c16';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padX, y);
  ctx.lineTo(width - padX, y);
  ctx.stroke();

  // 核心指标栏
  y += 22;
  const cols = model.cardioLabel
    ? [
        { k: '训练时长', v: model.durationLabel },
        { k: '完成规模', v: model.setsLabel },
        { k: '有氧有效', v: model.cardioLabel },
      ]
    : [
        { k: '训练时长', v: model.durationLabel },
        { k: '正式完成', v: model.setsLabel },
      ];
  const colW = innerW / cols.length;
  cols.forEach((c, idx) => {
    const cx = padX + idx * colW;
    ctx.fillStyle = '#7a7265';
    ctx.font = `500 11px ${fontSans}`;
    ctx.fillText(c.k, cx, y);
    ctx.fillStyle = '#1f1c16';
    ctx.font = `700 18px ${fontMono}`;
    ctx.fillText(c.v, cx, y + 22);
  });

  y += 38;
  ctx.strokeStyle = '#d6ceba';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(padX, y);
  ctx.lineTo(width - padX, y);
  ctx.stroke();
  ctx.setLineDash([]);

  // PR 印章区块
  if (prRows.length > 0) {
    y += 22;
    ctx.fillStyle = '#a33b24';
    ctx.font = `700 12px ${fontSans}`;
    ctx.fillText(`★ 本次刷新个人纪录（${model.prs.length} 项同口径 PR）`, padX, y);
    y += 10;
    for (const pr of prRows) {
      y += 18;
      ctx.fillStyle = '#1f1c16';
      ctx.font = `600 13px ${fontSans}`;
      ctx.fillText(`${pr.exerciseName.slice(0, 16)} · ${pr.stampLabel}`, padX, y);
      y += 16;
      ctx.fillStyle = '#a33b24';
      ctx.font = `500 11.5px ${fontSans}`;
      ctx.fillText(pr.detailText.slice(0, 34), padX, y);
      y += 6;
    }
    y += 8;
    ctx.strokeStyle = '#d6ceba';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (model.firstRecordCount > 0) {
    y += 22;
    ctx.fillStyle = '#5c5549';
    ctx.font = `500 12px ${fontSans}`;
    ctx.fillText(`● 首次建立 ${model.firstRecordCount} 个动作的历史同口径基准`, padX, y);
    y += 12;
  }

  // 动作明细表
  y += 22;
  ctx.fillStyle = '#7a7265';
  ctx.font = `600 11px ${fontMono}`;
  ctx.fillText('ITEMS / 动作与有氧明细', padX, y);
  y += 8;

  if (displayItems.length === 0) {
    y += 22;
    ctx.fillStyle = '#7a7265';
    ctx.font = `400 12.5px ${fontSans}`;
    ctx.fillText('本次未录入有效正式组或有氧时长', padX, y);
  } else {
    for (const it of displayItems) {
      y += 26;
      ctx.fillStyle = '#1f1c16';
      ctx.font = `600 13px ${fontSans}`;
      const leftText = it.name.length > 13 ? `${it.name.slice(0, 12)}…` : it.name;
      ctx.fillText(leftText, padX, y);

      ctx.textAlign = 'right';
      ctx.fillStyle = it.prBadge ? '#a33b24' : '#4a443a';
      ctx.font = `500 12px ${fontSans}`;
      ctx.fillText(it.summary, width - padX, y);
      ctx.textAlign = 'left';
    }
    if (extraItemCount > 0) {
      y += 22;
      ctx.fillStyle = '#7a7265';
      ctx.font = `400 11.5px ${fontSans}`;
      ctx.fillText(`… 另有 ${extraItemCount} 项记录见应用内详情`, padX, y);
    }
  }

  if (model.note) {
    y += 18;
    ctx.strokeStyle = '#d6ceba';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
    ctx.stroke();
    ctx.setLineDash([]);

    y += 20;
    ctx.fillStyle = '#5c5549';
    ctx.font = `400 12px ${fontSans}`;
    const noteLines = wrapCanvasLines(ctx, `备注：${model.note}`, innerW, 2);
    for (const line of noteLines) {
      ctx.fillText(line, padX, y);
      y += 17;
    }
  }

  // 页脚
  ctx.fillStyle = '#8b8273';
  ctx.font = `500 10px ${fontMono}`;
  ctx.textAlign = 'center';
  ctx.fillText('MOTION PERSONAL TRAINING LEDGER · LOCAL & OFFLINE', width / 2, paperBottom - 16);
  ctx.textAlign = 'left';

  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  const blob = await new Promise<Blob | null>((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((b) => resolve(b), 'image/png');
  });

  return { base64, blob, width, height };
}
