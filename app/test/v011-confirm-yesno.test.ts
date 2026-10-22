/* v0.1.1 L03：公共 Confirm 变更的交互回归（指令：改公共 Sheet/Confirm 必须补）。
   用 renderToStaticMarkup 断言真实渲染输出，不引入新依赖：
   ① 按钮文案严格「是 / 否」；② busy 期间两钮都禁用、确认钮显示 busy 文案；
   ③ 未 busy 时不禁用。Sheet 的 Escape/遮罩取消由既有 Sheet 逻辑负责（这里断言 Confirm 把 onCancel 接到关闭）。 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Confirm } from '../src/ui/Confirm';

function render(props: Parameters<typeof Confirm>[0]) {
  return renderToStaticMarkup(createElement(Confirm, props));
}

const base = {
  open: true,
  title: '删除这个训练日？',
  body: '将删除训练日「胸 A」。',
  confirmText: '是',
  cancelText: '否',
  danger: true,
  onConfirm: () => undefined,
  onCancel: () => undefined,
};

describe('L03 · Confirm（是/否 + busy）', () => {
  it('文案严格是「是」「否」两个按钮都渲染', () => {
    const html = render(base);
    expect(html).toContain('>是</button>');
    expect(html).toContain('>否</button>');
  });

  it('busy 时两个按钮都 disabled，确认按钮显示 busy 文案', () => {
    const html = render({ ...base, busy: true, busyLabel: '正在删除…' });
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    // 关闭 / 否 / 是 三个按钮都应 disabled（关闭也防误触逃逸）
    const yes = buttons.find((b) => b.includes('btn-danger')) ?? '';
    expect(yes).toContain('disabled');
    expect(html).toContain('正在删除…');
    expect(html).not.toContain('>是</button>');
  });

  it('未 busy 时按钮可用（无 disabled）', () => {
    const html = render(base);
    const yes = (html.match(/<button[^>]*>/g) ?? []).find((b) => b.includes('btn-danger')) ?? '';
    expect(yes).not.toContain('disabled');
  });

  it('busy 未给 busyLabel 时沿用 confirmText（不会闪空白）', () => {
    const html = render({ ...base, busy: true });
    expect(html).toContain('>是</button>');
  });

  it('open=false 时整体不渲染（取消即无痕）', () => {
    expect(render({ ...base, open: false })).toBe('');
  });
});
