/* 电子教练回复轻量 Markdown 渲染器（纯 React 节点，零 dangerouslySetInnerHTML）。
   特性：
   · 支持标题、段落、无序/有序列表、引用、分割线、围栏代码块（流式未闭合时平滑兜底）、GFM 横向滚动表格、行内代码、加粗、斜体、删除线与安全链接；
   · 专门保护训练写法（如 `3*10`、`3*10*12`、`2*15kg`）不被误判成斜体；
   · 仅允许 http/https 链接协议，拦截 javascript:/data: 等不安全协议。 */

import React from 'react';

export interface CoachMarkdownProps {
  text: string;
  streaming?: boolean;
  className?: string;
}

type MdBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; content: string }
  | { type: 'paragraph'; content: string }
  | { type: 'code'; lang: string; content: string; unclosed?: boolean }
  | { type: 'blockquote'; blocks: MdBlock[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' };

function isSafeHttpUrl(raw: string): string | null {
  const clean = raw.trim();
  if (!/^https?:\/\//i.test(clean)) return null;
  return clean;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[A-Za-z0-9]/.test(ch);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  const cells = splitTableRow(trimmed);
  return cells.length >= 2 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function isTableCandidateLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && trimmed.replace(/[^|]/g, '').length >= 1;
}

function isHrLine(line: string): boolean {
  return /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function matchHeading(line: string): { level: 1 | 2 | 3 | 4; content: string } | null {
  const m = line.match(/^ {0,3}(#{1,4})\s+(.+?)\s*#*$/);
  if (!m) return null;
  return { level: m[1].length as 1 | 2 | 3 | 4, content: m[2].trim() };
}

function matchUnorderedItem(line: string): string | null {
  const m = line.match(/^ {0,3}(?:[-*+]|•)\s+(.+)$/);
  return m ? m[1] : null;
}

function matchOrderedItem(line: string): string | null {
  const m = line.match(/^ {0,3}\d+[.)]\s+(.+)$/);
  return m ? m[1] : null;
}

function parseBlocks(source: string, streaming = false): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 1. 围栏代码块（支持流式未闭合兜底）
    const fenceMatch = line.match(/^ {0,3}```([^\s`]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? '';
      i += 1;
      const codeLines: string[] = [];
      let closed = false;
      while (i < lines.length) {
        if (/^ {0,3}```\s*$/.test(lines[i])) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      if (!closed && !streaming && codeLines.length === 0) {
        blocks.push({ type: 'code', lang, content: '', unclosed: false });
      } else {
        blocks.push({ type: 'code', lang, content: codeLines.join('\n'), unclosed: !closed });
      }
      continue;
    }

    // 2. 分割线
    if (isHrLine(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 3. 标题
    const heading = matchHeading(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading.level, content: heading.content });
      i += 1;
      continue;
    }

    // 4. 引用块
    if (/^ {0,3}>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^ {0,3}>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', blocks: parseBlocks(quoteLines.join('\n'), streaming) });
      continue;
    }

    // 5. GFM 表格（表头行 + 分隔行）
    if (
      i + 1 < lines.length &&
      isTableCandidateLine(line) &&
      isTableSeparatorLine(lines[i + 1])
    ) {
      const headers = splitTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && isTableCandidateLine(lines[i])) {
        const rawCells = splitTableRow(lines[i]);
        const padded = headers.map((_, idx) => rawCells[idx] ?? '');
        rows.push(padded);
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // 6. 无序列表
    const ulFirst = matchUnorderedItem(line);
    if (ulFirst !== null) {
      const items: string[] = [ulFirst];
      i += 1;
      while (i < lines.length) {
        const nextUl = matchUnorderedItem(lines[i]);
        if (nextUl !== null) {
          items.push(nextUl);
          i += 1;
        } else if (/^ {2,}\S/.test(lines[i]) && !matchOrderedItem(lines[i])) {
          items[items.length - 1] += '\n' + lines[i].trim();
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // 7. 有序列表
    const olFirst = matchOrderedItem(line);
    if (olFirst !== null) {
      const items: string[] = [olFirst];
      i += 1;
      while (i < lines.length) {
        const nextOl = matchOrderedItem(lines[i]);
        if (nextOl !== null) {
          items.push(nextOl);
          i += 1;
        } else if (/^ {2,}\S/.test(lines[i]) && matchUnorderedItem(lines[i]) === null) {
          items[items.length - 1] += '\n' + lines[i].trim();
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // 8. 普通段落
    const paraLines: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^ {0,3}```/.test(lines[i]) &&
      !isHrLine(lines[i]) &&
      !matchHeading(lines[i]) &&
      !/^ {0,3}>\s?/.test(lines[i]) &&
      matchUnorderedItem(lines[i]) === null &&
      matchOrderedItem(lines[i]) === null &&
      !(i + 1 < lines.length && isTableCandidateLine(lines[i]) && isTableSeparatorLine(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
  }

  return blocks;
}

function renderInline(text: string, depth = 0): React.ReactNode[] {
  if (!text) return [];
  if (depth > 5) return [text];

  const out: React.ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  let keySeq = 0;

  const flushPlain = (endIdx: number) => {
    if (endIdx > plainStart) {
      const slice = text.slice(plainStart, endIdx);
      const segments = slice.split('\n');
      for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
        if (segments[sIdx]) out.push(segments[sIdx]);
        if (sIdx < segments.length - 1) {
          out.push(<br key={`br-${keySeq++}`} />);
        }
      }
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // 1. 行内代码
    if (ch === '`') {
      const closeIdx = text.indexOf('`', i + 1);
      if (closeIdx > i + 1 && !text.slice(i + 1, closeIdx).includes('\n')) {
        flushPlain(i);
        out.push(
          <code key={`ic-${keySeq++}`} className="coach-md-inline-code">
            {text.slice(i + 1, closeIdx)}
          </code>,
        );
        i = closeIdx + 1;
        plainStart = i;
        continue;
      }
    }

    // 2. Markdown 链接 [label](url)
    if (ch === '[') {
      const mid = text.indexOf('](', i + 1);
      if (mid > i + 1) {
        const end = text.indexOf(')', mid + 2);
        const label = text.slice(i + 1, mid);
        const rawUrl = end > mid + 2 ? text.slice(mid + 2, end) : '';
        if (end > mid + 2 && !label.includes('\n') && !rawUrl.includes('\n')) {
          const safeUrl = isSafeHttpUrl(rawUrl);
          flushPlain(i);
          if (safeUrl) {
            out.push(
              <a
                key={`lnk-${keySeq++}`}
                className="coach-md-link"
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {renderInline(label, depth + 1)}
              </a>,
            );
          } else {
            out.push(label);
          }
          i = end + 1;
          plainStart = i;
          continue;
        }
      }
    }

    // 3. 加粗 **...**
    if (ch === '*' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('**', i + 2);
      if (closeIdx > i + 2 && !text.slice(i + 2, closeIdx).includes('\n')) {
        const inner = text.slice(i + 2, closeIdx);
        if (inner.trim()) {
          flushPlain(i);
          out.push(
            <strong key={`b-${keySeq++}`} className="coach-md-strong">
              {renderInline(inner, depth + 1)}
            </strong>,
          );
          i = closeIdx + 2;
          plainStart = i;
          continue;
        }
      }
    }

    // 4. 删除线 ~~...~~
    if (ch === '~' && text[i + 1] === '~') {
      const closeIdx = text.indexOf('~~', i + 2);
      if (closeIdx > i + 2 && !text.slice(i + 2, closeIdx).includes('\n')) {
        const inner = text.slice(i + 2, closeIdx);
        if (inner.trim()) {
          flushPlain(i);
          out.push(
            <del key={`del-${keySeq++}`} className="coach-md-del">
              {renderInline(inner, depth + 1)}
            </del>,
          );
          i = closeIdx + 2;
          plainStart = i;
          continue;
        }
      }
    }

    // 5. 斜体 *...*（严禁误伤 `3*10` / `3*10*12` 等乘号表达式）
    if (ch === '*' && text[i + 1] !== '*' && !isWordBoundaryChar(text[i - 1])) {
      const nextChar = text[i + 1];
      if (nextChar && !/\s/.test(nextChar)) {
        let searchFrom = i + 1;
        let closeIdx = -1;
        while (searchFrom < text.length) {
          const candidate = text.indexOf('*', searchFrom);
          if (candidate < 0) break;
          if (
            text[candidate + 1] !== '*' &&
            text[candidate - 1] !== '*' &&
            !/\s/.test(text[candidate - 1] ?? '') &&
            !isWordBoundaryChar(text[candidate + 1])
          ) {
            closeIdx = candidate;
            break;
          }
          searchFrom = candidate + 1;
        }
        if (closeIdx > i + 1 && !text.slice(i + 1, closeIdx).includes('\n')) {
          const inner = text.slice(i + 1, closeIdx);
          flushPlain(i);
          out.push(
            <em key={`em-${keySeq++}`} className="coach-md-em">
              {renderInline(inner, depth + 1)}
            </em>,
          );
          i = closeIdx + 1;
          plainStart = i;
          continue;
        }
      }
    }

    i += 1;
  }

  flushPlain(text.length);
  return out;
}

function renderBlocks(blocks: MdBlock[], keyPrefix = 'b'): React.ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (block.type) {
      case 'heading': {
        const cls = `coach-md-h${block.level}`;
        const children = renderInline(block.content);
        if (block.level === 1) return <h1 key={key} className={cls}>{children}</h1>;
        if (block.level === 2) return <h2 key={key} className={cls}>{children}</h2>;
        if (block.level === 3) return <h3 key={key} className={cls}>{children}</h3>;
        return <h4 key={key} className={cls}>{children}</h4>;
      }
      case 'paragraph':
        return (
          <p key={key} className="coach-md-p">
            {renderInline(block.content)}
          </p>
        );
      case 'code':
        return (
          <pre key={key} className={`coach-md-pre${block.unclosed ? ' is-streaming' : ''}`}>
            {block.lang ? <div className="coach-md-code-lang">{block.lang}</div> : null}
            <code className="coach-md-code">{block.content}</code>
          </pre>
        );
      case 'blockquote':
        return (
          <blockquote key={key} className="coach-md-quote">
            {renderBlocks(block.blocks, `${key}-q`)}
          </blockquote>
        );
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag key={key} className={`coach-md-list${block.ordered ? ' is-ordered' : ''}`}>
            {block.items.map((item, itemIdx) => (
              <li key={`${key}-li-${itemIdx}`} className="coach-md-li">
                {renderInline(item)}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={key} className="coach-md-table-wrap">
            <table className="coach-md-table">
              <thead>
                <tr>
                  {block.headers.map((h, hIdx) => (
                    <th key={`${key}-th-${hIdx}`}>{renderInline(h)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rIdx) => (
                  <tr key={`${key}-tr-${rIdx}`}>
                    {row.map((cell, cIdx) => (
                      <td key={`${key}-td-${rIdx}-${cIdx}`}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'hr':
        return <hr key={key} className="coach-md-hr" />;
    }
  });
}

export const CoachMarkdown: React.FC<CoachMarkdownProps> = ({ text, streaming, className }) => {
  if (!text) return null;
  const blocks = parseBlocks(text, streaming);
  return <div className={`coach-md${className ? ` ${className}` : ''}`}>{renderBlocks(blocks)}</div>;
};
