/* F10：源码级契约（可静态判定、可回归）。
   本轮真实 Chrome 在沙箱内无法启动（详见交接中的 chrome-blocker 证据），
   因此把"只能在真实浏览器里看的先后关系"压缩成**可判定的源码契约**，
   防止后续改动把播放点提前、把幽灵做成可操作元素、把清理漏掉。
   这类断言不能替代真实逐帧证据，只作为回归护栏。 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(HERE, p), 'utf8');

const SESSION = read('../src/pages/Session.tsx');
const LAYER = read('../src/ui/DeleteDissolveLayer.tsx');
const MODULE = read('../src/ui/deleteDissolve.ts');
const ZINE = read('../src/styles/zine.css');

/** 取一个 useCallback 函数体（从声明到依赖数组结尾） */
function callbackBody(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `未找到 ${header}`).toBeGreaterThan(-1);
  // 依赖数组固定在两空格缩进处收尾；不能用第一个 ']);'（函数体内部也会有）
  const end = source.indexOf('\n  }, [', start);
  expect(end, `${header} 的依赖数组未闭合`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('F10 源码契约：播放点必须晚于真实保存结果', () => {
  const commitDelete = callbackBody(SESSION, 'const commitDelete = useCallback(');

  it('几何快照发生在 await 事务之前（await 之后原卡 DOM 可能已不在）', () => {
    const capture = commitDelete.indexOf('prepareDissolveGeometry(preview');
    expect(commitDelete).toContain('confirmedRevision.current');
    const awaitPaired = commitDelete.indexOf('await commitPaired(');
    expect(capture).toBeGreaterThan(-1);
    expect(awaitPaired).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(awaitPaired);
  });

  it('playDissolve 只在 r.status === "saved" 之后被调用，且全文件仅一处调用', () => {
    const savedAt = commitDelete.indexOf("r.status === 'saved'");
    const playAt = commitDelete.indexOf('playDissolve({');
    expect(savedAt).toBeGreaterThan(-1);
    expect(playAt).toBeGreaterThan(savedAt);
    // 全文件只有这一个调用点（定义是 `= useCallback(`，不计入）
    expect(SESSION.split('playDissolve(').length - 1).toBe(1);
  });

  it('失败分支先失效待生效补位批次，绝不做出假补位', () => {
    const savedAt = commitDelete.indexOf("r.status === 'saved'");
    const failAt = commitDelete.indexOf('disarmReflowPending();', savedAt);
    const returnFalse = commitDelete.indexOf('return false;', savedAt);
    expect(failAt).toBeGreaterThan(savedAt);
    expect(returnFalse).toBeGreaterThan(failAt);
  });

  it('表现层异常被就地吞掉，不能阻断已成功的删除/撤销/计时', () => {
    const playAt = commitDelete.indexOf('playDissolve({');
    const wrapStart = commitDelete.lastIndexOf('try {', playAt);
    expect(wrapStart).toBeGreaterThan(-1);
    expect(commitDelete.indexOf('catch {', playAt)).toBeGreaterThan(playAt);
  });

  it('撤销成功与点下撤销都会收尾目标效果', () => {
    const undo = callbackBody(SESSION, 'const undoDeleteEntry = useCallback(');
    expect(undo.split('endDissolveFor(').length - 1).toBe(2);
  });
});

describe('F10 源码契约：生命周期清理', () => {
  it('卸载 / 切 session / 隐藏都走同一个收尾入口', () => {
    expect(SESSION).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(SESSION).toContain('dissolveEpochRef.current += 1');
    // 清理 effect 在卸载与切 session 时调用 resetDissolve；隐藏/失锁走 invalidateFeedback
    expect(SESSION.split('resetDissolve()').length - 1).toBeGreaterThanOrEqual(3);
    expect(SESSION).toContain('invalidateFeedback');
  });

  it('补位由 useLayoutEffect 消费（绘制前先归位，不会先跳到终点）', () => {
    const at = SESSION.indexOf('useLayoutEffect(');
    expect(at).toBeGreaterThan(-1);
    const body = SESSION.slice(at, SESSION.indexOf('}, [session, canPlayDissolve', at));
    expect(body).toContain('pendingReflowRef.current');
    expect(body).toContain('applyReflowAnimation(');
  });

  it('补位时机由"已提交 Session 里条目真的消失 + 版本前进"判定，而不是任意向上位移', () => {
    const at = SESSION.indexOf('useLayoutEffect(');
    const body = SESSION.slice(at, SESSION.indexOf('}, [session, canPlayDissolve', at));
    expect(body).toContain('dissolveAttribution({');
    expect(body).toContain("if (verdict === 'wait') return;");
    expect(body).toContain("verdict === 'reject'");
    // 归属字段必须在命令发出时冻结（session / item / token / 版本）
    const armAt = SESSION.indexOf('armReflow({');
    const armBlock = SESSION.slice(armAt, SESSION.indexOf('});', armAt));
    for (const field of ['epoch:', 'token:', 'sessionId:', 'itemId:', 'kind,', 'revision:']) {
      expect(armBlock, `armReflow 缺少 ${field}`).toContain(field);
    }
  });

  it('不再用短超时丢弃待生效批次（慢事务/排队必须能等到）', () => {
    expect(SESSION.includes('reflowArmTimerRef')).toBe(false);
    const armAt = SESSION.indexOf('const armReflow = useCallback(');
    const armBody = SESSION.slice(armAt, SESSION.indexOf(']);', armAt));
    expect(armBody).not.toContain('setTimeout');
  });

  it('隐藏与失锁让已开始的捕获作废（epoch 递增），而不是只清展示层', () => {
    const at = SESSION.indexOf('const invalidateFeedback = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = SESSION.slice(at, SESSION.indexOf('});', at));
    expect(body).toContain('dissolveEpochRef.current += 1');
    expect(body).toContain('resetDissolve()');
    // 两个入口都接到同一个失效函数
    expect(SESSION).toContain('if (document.visibilityState !== \'visible\') invalidateFeedback();');
    expect(SESSION).toContain('if (lockBlocked) invalidateFeedback();');
  });

  it('减少动态 / 隐藏页 / 越页都在播放前判定（不建节点）', () => {
    expect(SESSION).toContain('prefersReducedMotion()');
    expect(SESSION).toContain("document.visibilityState !== 'visible'");
    expect(SESSION).toContain('if (epoch !== dissolveEpochRef.current) return false;');
  });
});

describe('F10 源码契约：幽灵不是业务卡', () => {
  it('展示层没有按钮/输入/链接，也没有 id 与内联脚本', () => {
    for (const tag of ['<button', '<input', '<textarea', '<select', '<a ', 'dangerouslySetInnerHTML']) {
      expect(LAYER.includes(tag), `展示层不应包含 ${tag}`).toBe(false);
    }
    expect(LAYER).toContain('aria-hidden="true"');
    expect(LAYER).toContain('data-dissolve-token');
  });

  it('样式把效果限制在所属卡自身盒内且不截获输入', () => {
    const layerBlock = ZINE.slice(ZINE.indexOf('.dissolve-layer {'), ZINE.indexOf('.dissolve-shell {'));
    expect(layerBlock).toContain('position: absolute');
    expect(layerBlock).toContain('pointer-events: none');
    const ghostBlock = ZINE.slice(ZINE.indexOf('.dissolve-ghost {'), ZINE.indexOf('.dissolve-label {'));
    expect(ghostBlock).toContain('overflow: hidden');
    expect(ghostBlock).toContain('pointer-events: none');
  });

  it('表现层模块无任何外部依赖（不引库、不碰业务模块）', () => {
    expect(/^\s*import\s/m.test(MODULE)).toBe(false);
  });
});
