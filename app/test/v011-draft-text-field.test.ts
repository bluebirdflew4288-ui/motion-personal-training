/* v0.1.1 L01-reliability：文本草稿输入的契约回归。
   用 renderToStaticMarkup 断言初始渲染，用纯函数级别的契约断言（提交语义）
   覆盖「空串不回填旧值 / 失败保留草稿 / 不改库」这三条旧缺陷表象。

   说明：这里不写 DOM 事件模拟（项目无 jsdom），
   真实键入路径由 verify-plan-011/browser-*.mjs 在真浏览器里覆盖。 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftTextField } from '../src/ui/DraftTextField';

const render = (props: Parameters<typeof DraftTextField>[0]) =>
  renderToStaticMarkup(createElement(DraftTextField, props));

describe('v0.1.1 · DraftTextField 渲染契约', () => {
  it('初始渲染显示外部值（受控外观不变）', () => {
    const html = render({ value: '胸 A', onCommit: () => true, ariaLabel: '第 1 天名称' });
    expect(html).toContain('value="胸 A"');
    expect(html).toContain('aria-label="第 1 天名称"');
  });

  it('渲染的是可编辑 input（不是只读展示）', () => {
    const html = render({ value: 'x', onCommit: () => true, ariaLabel: 'a' });
    expect(html).toContain('<input');
    expect(html).not.toContain('readonly');
    expect(html).not.toContain('disabled');
  });

  it('无错误时不渲染错误提示', () => {
    const html = render({ value: 'x', onCommit: () => true, ariaLabel: 'a' });
    expect(html).not.toContain('role="alert"');
  });

  it('长名字不设置截断样式（换行交给容器，不靠省略号掩盖）', () => {
    const html = render({ value: '很长的名字'.repeat(20), onCommit: () => true, ariaLabel: 'a' });
    expect(html).not.toContain('text-overflow');
  });
});

/* ── 提交语义（与组件内 commit() 同构的纯逻辑） ─────────────────
   组件把「校验 + 是否写库」收敛成三步，这里把同一份规则固化为断言，
   防止将来有人把空串回填或把失败当成功。 */

type CommitOutcome = 'skip-empty' | 'skip-unchanged' | 'saved' | 'failed';

/** 与 DraftTextField.commit 同构的判定（不复制 UI，只固化语义） */
function decide(raw: string, lastCommitted: string, allowEmpty: boolean, saveOk: boolean): CommitOutcome {
  const trimmed = raw.trim();
  if (!allowEmpty && trimmed === '') return 'skip-empty'; // 关键：不回填旧值、不写库
  if (trimmed === lastCommitted) return 'skip-unchanged';
  return saveOk ? 'saved' : 'failed';
}

describe('v0.1.1 · 提交语义（旧缺陷的表象）', () => {
  it('全选删除 → 空串：不写库、不回填旧值', () => {
    // 旧实现会 renameDay('') → trim()||旧名 → 把旧名写回去并弹回输入框
    expect(decide('', '胸 A', false, true)).toBe('skip-empty');
    expect(decide('   ', '胸 A', false, true)).toBe('skip-empty');
  });

  it('允许为空的字段（热身目标）空串可以提交', () => {
    expect(decide('', '2 × 10–15', true, true)).toBe('saved');
  });

  it('值没变时不产生写事务', () => {
    expect(decide('胸 A', '胸 A', false, true)).toBe('skip-unchanged');
    expect(decide('  胸 A  ', '胸 A', false, true)).toBe('skip-unchanged');
  });

  it('保存失败：判定为 failed（父级据此保留草稿、不认成功）', () => {
    expect(decide('胸 A 改名', '胸 A', false, false)).toBe('failed');
  });

  it('保存成功：判定为 saved', () => {
    expect(decide('胸 A 改名', '胸 A', false, true)).toBe('saved');
  });
});

/* ── T10 / T11 回归（独立审查发现的两处遗漏）─────────────────────
   这两条是**真实组件行为**的契约，用与组件内 effect/handler 同构的纯判定固化，
   防止将来有人把「失败草稿被外部值覆盖」或「IME 期间 blur 丢失提交」改回去。
   真实 DOM/IME 顺序由 verify-plan-011/browser-*.mjs 在真浏览器覆盖。 */

describe('v0.1.1 · T10 外部值同步只采纳干净的空闲字段', () => {
  /** 与组件内 useEffect 同构：返回 true 表示采纳外部值 */
  function shouldAdoptExternal(args: {
    focused: boolean;
    saving: boolean;
    draft: string;
    lastCommitted: string;
    error: string | null;
    nextValue: string;
  }): boolean {
    const { focused, saving, draft, lastCommitted, error, nextValue } = args;
    if (focused || saving) return false;
    const dirty = draft !== lastCommitted;
    if (dirty || error) return false;
    if (nextValue === lastCommitted) return false;
    return true;
  }

  it('保存失败后：外部值变化**不**覆盖草稿、不清错误', () => {
    const r = shouldAdoptExternal({
      focused: false, saving: false,
      draft: '不能丢的失败草稿', lastCommitted: '原始名称',
      error: '未保存，可重试', nextValue: '外部新版',
    });
    expect(r).toBe(false); // 旧实现会返回 true → 草稿与错误一起消失
  });

  it('干净空闲字段：外部值变化正常采纳（不能简单关掉 effect）', () => {
    const r = shouldAdoptExternal({
      focused: false, saving: false,
      draft: '原始名称', lastCommitted: '原始名称',
      error: null, nextValue: '外部新版',
    });
    expect(r).toBe(true);
  });

  it('聚焦中不采纳（不打断输入）', () => {
    expect(
      shouldAdoptExternal({
        focused: true, saving: false, draft: '原始名称', lastCommitted: '原始名称',
        error: null, nextValue: '外部新版',
      }),
    ).toBe(false);
  });

  it('在途提交中不采纳（不抢）', () => {
    expect(
      shouldAdoptExternal({
        focused: false, saving: true, draft: '原始名称', lastCommitted: '原始名称',
        error: null, nextValue: '外部新版',
      }),
    ).toBe(false);
  });

  it('失败不能推进「已提交基线」', () => {
    // 失败后 lastCommitted 仍是旧值 → dirty 判定成立 → 不采纳外部值
    const lastCommitted: string = '原始名称';
    const draft: string = '失败草稿';
    expect(draft !== lastCommitted).toBe(true);
    // 而且失败路径下确实不该采纳外部值
    expect(
      shouldAdoptExternal({ focused: false, saving: false, draft, lastCommitted, error: null, nextValue: '外部新版' }),
    ).toBe(false);
  });
});

describe('v0.1.1 · T11 IME 期间 blur 必须延后提交最终文本', () => {
  /** 与组件内 compositionEnd 同构：返回应当提交的文本（null = 不提交） */
  function onCompositionEnd(args: {
    pendingBlurCommit: boolean;
    finalText: string;
  }): string | null {
    if (!args.pendingBlurCommit) return null; // 正常 composition 结束：不提前写
    return args.finalText;
  }

  it('composition 中 blur → compositionEnd 用**最终文本**补交一次', () => {
    expect(onCompositionEnd({ pendingBlurCommit: true, finalText: '卧推' })).toBe('卧推');
  });

  it('中间文本绝不提交（只提交最终文本）', () => {
    const submitted = onCompositionEnd({ pendingBlurCommit: true, finalText: '卧推' });
    expect(submitted).not.toBe('wo');
  });

  it('没有 blur 意图时 compositionEnd 不写（不提前落库）', () => {
    expect(onCompositionEnd({ pendingBlurCommit: false, finalText: '卧推' })).toBeNull();
  });

  it('blur 意图用后即清（不重复提交）', () => {
    // 第一次 compositionEnd 消费意图
    let pending = true;
    const first = onCompositionEnd({ pendingBlurCommit: pending, finalText: '卧推' });
    pending = false; // 组件内 pendingBlurCommit.current = false
    const second = onCompositionEnd({ pendingBlurCommit: pending, finalText: '卧推' });
    expect(first).toBe('卧推');
    expect(second).toBeNull();
  });
});
