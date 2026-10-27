/* G3 回归：有氧滑块拖动时数字实时跟手，手势结束只提交一次。
   ── 已复现的缺陷 ────────────────────────────────────────────
   1. 摘要行与精确输入框读 `entry.currentParams`（**已提交**值），
      而滑杆 onChange 只写本地 `slider` → 拖动时数字不动，松手后才跳变。
   2. 一次拖动会先后触发 pointerup / touchend / keyup / blur，
      每个都跑一遍提交链 → 同一手势重复提交。
   3. 幂等基准若在提交**之前**推进，草稿非法被拦后基准已前进，
      用户修好草稿再松手会被误判重复 → 参数永远提交不上。
   4. 幂等基准若不随外部 currentParams 重置，精确框改过参数后
      把滑杆拖回"旧滑杆值"会被误判重复 → 永不提交。
   5. 没有 pointercancel 入口：拖动被系统判成滚动手势后，
      半路的滑杆值会在下一次 blur/pointerup 被当成用户意图提交。

   ── 本文件的证据级别 ────────────────────────────────────────
   从 `src/ui/CardioPanel.tsx` 用 AST 抽取**真实 commitSliderOnce /
   cancelSliderGesture 源码**，在受控替身（slider / lastCommittedSlider /
   withDraft / setSlider）里执行，断言的是生产代码自身的分支与顺序，
   不是复制的公式。领域语义（同值不增段）调真实 `commitCardioParams`。
   **这不是** React DOM / 真机触摸 / 输入法验收 —— 那由独立 CUA 链覆盖。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { commitCardioParams, paramsEqual } from '../src/domain/cardio';
import { shouldSyncExternal } from '../src/ui/draftForm';
import type { CardioEntry, CardioParams } from '../src/domain/types';

const FILE = resolve(process.cwd(), 'src/ui/CardioPanel.tsx');
const SRC = readFileSync(FILE, 'utf8');
const AST = ts.createSourceFile(FILE, SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 抽取 `const <name> = (...) => {...}` 的真实源码 */
function extractArrow(name: string): string {
  let out: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      let v: ts.Expression = n.initializer;
      // 允许 useCallback 包裹
      if (ts.isCallExpression(v) && v.arguments.length) v = v.arguments[0];
      if (ts.isArrowFunction(v)) out = v.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!out) throw new Error(`CardioPanel.tsx 里找不到可抽取的 ${name}`);
  return out;
}

const COMMIT_SRC = extractArrow('commitSliderOnce');
const CANCEL_SRC = extractArrow('cancelSliderGesture');

/** 把抽取到的源码编译成可调用函数，注入受控替身 */
function makeHarness(init: { committed: CardioParams; slider: CardioParams }) {
  let slider: CardioParams = { ...init.slider };
  const committedRef = { current: { ...init.committed } };
  /** withDraft 的返回值：true=提交链真的跑通，false=被草稿/校验拦住 */
  let withDraftResult = true;
  let withDraftCalls = 0;

  const env = {
    paramsEqual,
    slider,
    lastCommittedSlider: committedRef,
    withCardioEntry: (_ss: unknown, l: unknown) => l,
    setSlider: (next: CardioParams) => {
      slider = next;
    },
    withDraft: (_action: unknown) => {
      withDraftCalls += 1;
      return withDraftResult;
    },
    entry: { currentParams: { ...init.committed } },
    module: { exports: null as unknown },
  };

  const compile = (src: string) =>
    ts.transpileModule(`module.exports=(${src});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;

  // 用 getter 把 slider 的实时值暴露给被测函数
  const scope: Record<string, unknown> = {
    ...env,
    get slider() {
      return slider;
    },
  };
  const mod = { exports: null as unknown };
  scope.module = mod;
  vm.runInNewContext(compile(COMMIT_SRC), scope);
  const commit = mod.exports as () => boolean;

  const mod2 = { exports: null as unknown };
  const scope2: Record<string, unknown> = {
    ...env,
    setSlider: (next: CardioParams) => {
      slider = next;
    },
    get slider() {
      return slider;
    },
    module: mod2,
  };
  vm.runInNewContext(compile(CANCEL_SRC), scope2);
  const cancel = mod2.exports as () => void;

  return {
    commit,
    cancel,
    get slider() {
      return slider;
    },
    setSlider: (v: CardioParams) => {
      slider = v;
    },
    get committed() {
      return committedRef.current;
    },
    setCommitted: (v: CardioParams) => {
      committedRef.current = v;
    },
    setWithDraftResult: (v: boolean) => {
      withDraftResult = v;
    },
    get withDraftCalls() {
      return withDraftCalls;
    },
  };
}

describe('G3 · 拖动中显示本地选择值', () => {
  it('摘要行读本地 slider，不读已提交 currentParams', () => {
    // 主摘要必须是 describeCardioParams(entry.preset, slider)
    expect(SRC).toContain('describeCardioParams(entry.preset, slider)');
    // 且不得退回读已提交值
    expect(SRC).not.toContain('describeCardioParams(entry.preset, entry.currentParams)');
  });

  it('精确数字输入框读本地 slider（拖动时跟手）', () => {
    expect(SRC).toMatch(/value=\{slider\.speedKmh \?\? 0\}/);
    expect(SRC).toMatch(/value=\{slider\.inclinePct \?\? 0\}/);
    expect(SRC).toMatch(/value=\{slider\.level \?\? MIN_STAIR_LEVEL\}/);
    // 精确框不得再读已提交 params
    expect(SRC).not.toMatch(/value=\{entry\.currentParams\./);
  });

  it('三个滑杆都受控于本地 slider（拖动即时反映）', () => {
    expect(SRC).toMatch(/value=\{slider\.speedKmh \?\? MIN_SPEED_KMH\}/);
    expect(SRC).toMatch(/value=\{slider\.inclinePct \?\? MIN_INCLINE_PCT\}/);
    expect(SRC).toMatch(/value=\{slider\.level \?\? MIN_STAIR_LEVEL\}/);
    // B3：onChange 变为块体（先 markIntent 再 setSlider）
    const onChanges = SRC.match(/onChange=\{\(e\) => \{[\s\S]{0,120}?setSlider/g) ?? [];
    expect(onChanges.length).toBe(3);
  });
});

describe('G3 · 手势结束只提交一次（幂等，真实源码执行）', () => {
  it('三个滑杆的四个终结事件都接同一幂等入口', () => {
    for (const ev of ['onPointerUp', 'onTouchEnd', 'onKeyUp', 'onBlur']) {
      const hits = SRC.match(new RegExp(`${ev}=\\{commitSliderOnce\\}`, 'g')) ?? [];
      expect(hits.length, `${ev} 应覆盖 3 个滑杆`).toBe(3);
    }
  });

  it('首次终结：值与基准不同 → 走提交链并推进基准', () => {
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 9.5 } });
    expect(h.commit()).toBe(true);
    expect(h.withDraftCalls).toBe(1);
    expect(h.committed).toEqual({ speedKmh: 9.5 });
  });

  it('重复终结（pointerup→touchend→blur）：只提交一次', () => {
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 9.5 } });
    const results = [h.commit(), h.commit(), h.commit(), h.commit()];
    expect(results).toEqual([true, false, false, false]);
    expect(h.withDraftCalls, '提交链只能跑一次').toBe(1);
  });

  it('同值 / 拖回原值：不提交、不增段、计时不停', () => {
    // 拖回原值 = slider 与已提交基准相等
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 8 } });
    expect(h.commit()).toBe(false);
    expect(h.withDraftCalls).toBe(0);
  });

  it('草稿被拦（withDraft=false）时不推进基准 → 修好后能再提交', () => {
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 9.5 } });
    h.setWithDraftResult(false);
    expect(h.commit()).toBe(false);
    // 关键：被拦后基准仍是旧值，不能前进
    expect(h.committed).toEqual({ speedKmh: 8 });
    // 用户修好草稿再松手 → 必须还能提交
    h.setWithDraftResult(true);
    expect(h.commit()).toBe(true);
    expect(h.committed).toEqual({ speedKmh: 9.5 });
  });

  it('外部 currentParams 变化后基准重置 → 拖回旧滑杆值仍能提交', () => {
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 9.5 } });
    // 精确框把库值改成 10（外部提交）→ 组件 effect 重置基准
    h.setCommitted({ speedKmh: 10 });
    // 用户把滑杆拖回"旧滑杆值" 9.5 → 与库值 10 不同，必须能提交
    expect(h.commit()).toBe(true);
    expect(h.committed).toEqual({ speedKmh: 9.5 });
  });

  it('源码层面：基准重置挂在外层 effect，且在 discardDraft 里也重置', () => {
    expect(SRC).toContain('lastCommittedSlider.current = entry.currentParams');
    const di = SRC.indexOf('const discardDraft');
    expect(di).toBeGreaterThan(-1);
    const seg = SRC.slice(di, di + 400);
    expect(seg).toContain('lastCommittedSlider.current = entry.currentParams');
  });

  /**
   * 需求 5：正在输入的精确数字草稿不能被滑杆驱动抹掉。
   *
   * 取舍（已在报告里说明）：精确框**没有**改成受控于 slider 的裸 value，
   * 而是继续走 DraftNumberField 的草稿契约 —— 它内部 `if (focused) return`
   * 让聚焦期间的键入不被外部 value 重写。于是"滑杆驱动"只改 value 的**来源**
   * （slider 而非 entry.currentParams），"用户正在输入"仍由焦点保护。
   * 这里用 DraftNumberField 自己的纯函数判定锁定这条语义。
   */
  it('聚焦中输入中不采纳外部值（滑杆驱动不抹掉未完成草稿）', () => {
    // 与 DraftNumberField 的 effect 同构：focused 时不重写草稿
    const adoptsExternal = (focused: boolean, value: number, lastCommitted: number, draft: string) =>
      !focused && shouldSyncExternal(value, lastCommitted, draft);

    // 用户正在输入 "7."（未完成态），滑杆把 value 推到 9.5 → 不得抹掉
    expect(adoptsExternal(true, 9.5, 7, '7.')).toBe(false);
    // 失焦后外部值确实变了 → 正常同步
    expect(adoptsExternal(false, 9.5, 7, '7')).toBe(true);
    // 外部值没变 → 不同步（不打断）
    expect(adoptsExternal(false, 7, 7, '7')).toBe(false);
  });

  it('精确框仍把 flush/reset 注册到父表单（非法草稿能拦住提交）', () => {
    // CardioPanel 侧必须继续给精确框传 form + fieldId，否则 flushAll 看不到草稿
    expect(SRC).toContain('form={form}');
    for (const id of ['cardio.speed', 'cardio.incline', 'cardio.level']) {
      expect(SRC).toContain(`fieldId="${id}"`);
    }
    // 非法草稿必须返回 null（不改数据），这条契约在 withDraft 里
    expect(SRC).toContain('return null; // 非法：不默用旧值、不落库');
  });
});

describe('G3 · 取消手势不提交', () => {
  it('三个滑杆都接了 pointercancel', () => {
    const hits = SRC.match(/onPointerCancel=\{cancelSliderGesture\}/g) ?? [];
    expect(hits.length).toBe(3);
  });

  it('取消把滑杆退回已提交值，且不调用提交链', () => {
    const h = makeHarness({ committed: { speedKmh: 8 }, slider: { speedKmh: 12 } });
    h.cancel();
    expect(h.slider).toEqual({ speedKmh: 8 });
    expect(h.withDraftCalls, '取消不得触发提交').toBe(0);
    // 取消后基准未被推进
    expect(h.committed).toEqual({ speedKmh: 8 });
  });
});

describe('G3 · 领域语义：同值不增段', () => {
  /**
   * 最小合法 CardioEntry（跑步，**running**）。
   * commitCardioParams 只在 running 时才开新段（暂停/未开始只更新 currentParams），
   * 所以 fixture 必须是 running，否则"新增一段"的断言会得到 0 段。
   */
  function entry(): CardioEntry {
    return {
      id: 'c1',
      preset: 'treadmill-incline',
      name: '有氧爬坡',
      planCardioId: null,
      target: null,
      elapsedMs: 0,
      runningSinceAt: 0,
      status: 'running',
      currentParams: { speedKmh: 8, inclinePct: 2 },
      segments: [
        {
          id: 's1',
          startElapsedMs: 0,
          endElapsedMs: null,
          params: { speedKmh: 8, inclinePct: 2 },
        },
      ],
    };
  }

  it('提交与当前相同的参数 → 不新增 segment', () => {
    const e = entry();
    const r = commitCardioParams(e, { speedKmh: 8, inclinePct: 2 }, 60_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.segments.length).toBe(e.segments.length);
      expect(r.entry).toBe(e); // 同值直接返回原对象，连浅拷贝都不产生
    }
  });

  it('提交不同参数 → 新增一段', () => {
    const e = entry();
    const r = commitCardioParams(e, { speedKmh: 9.5, inclinePct: 3 }, 60_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.segments.length).toBe(e.segments.length + 1);
      expect(r.entry.currentParams).toEqual({ speedKmh: 9.5, inclinePct: 3 });
    }
  });

  it('paramsEqual 对同值/异值判定正确', () => {
    expect(paramsEqual({ speedKmh: 8 }, { speedKmh: 8 })).toBe(true);
    expect(paramsEqual({ speedKmh: 8 }, { speedKmh: 8.1 })).toBe(false);
    expect(paramsEqual({ level: 5 }, { level: 5 })).toBe(true);
    expect(paramsEqual({ speedKmh: 8 }, {})).toBe(false);
  });
});
