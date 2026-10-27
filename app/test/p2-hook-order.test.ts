/* REVIEW-2 #1 回归守卫：SessionPage 的提前 return 之后不得再出现 hook 调用。
   React 要求每次渲染 hook 数量/顺序一致。新增的 cardio hooks 若位于
   `if (!session)` / 终态提示 return 之后，正常完成后重渲染会
   "Rendered fewer hooks than expected"（真实 Chrome 已复现）。

   实现：用 TS AST 找 SessionPage 函数体，按语句扫描——一旦遇到
   `if (...) return ...` 形式的提前 return，其后（任意深度）出现
   use*() 调用即失败。另断言三个新 hooks 的字面位置早于 `if (!session) {`。
   不依赖行号偏移，重构移动安全。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE = resolve(process.cwd(), 'src/pages/Session.tsx');

describe('REVIEW-2 #1 · SessionPage hook 顺序守卫', () => {
  it('提前 return 之后没有任何 hook 调用', () => {
    const src = readFileSync(FILE, 'utf8');
    const sf = ts.createSourceFile('Session.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    let body: ts.Block | undefined;
    const findFn = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'SessionPage') {
        body = node.body;
        return;
      }
      ts.forEachChild(node, findFn);
    };
    findFn(sf);
    expect(body, '找不到 SessionPage 函数体').toBeDefined();

    const isHookCall = (n: ts.CallExpression): boolean =>
      ts.isIdentifier(n.expression) && /^use[A-Z]/.test(n.expression.text);

    const containsReturn = (node: ts.Node): boolean => {
      let has = false;
      const v = (n: ts.Node) => {
        if (ts.isReturnStatement(n)) has = true;
        ts.forEachChild(n, v);
      };
      v(node);
      return has;
    };

    const violations: string[] = [];
    let pastEarlyReturn = false;
    const scan = (n: ts.Node) => {
      if (pastEarlyReturn && ts.isCallExpression(n) && isHookCall(n)) {
        violations.push(src.slice(n.getStart(sf), n.getEnd()).split('(')[0]);
      }
      ts.forEachChild(n, scan);
    };

    for (const st of body!.statements) {
      if (!pastEarlyReturn && ts.isIfStatement(st) && containsReturn(st)) {
        // 组件守卫式提前 return（if (!session) / if (status!==active)）
        pastEarlyReturn = true;
        continue;
      }
      scan(st);
    }
    expect(pastEarlyReturn, 'SessionPage 应存在提前 return（守卫结构）').toBe(true);
    expect(violations, `提前 return 后仍有 hook 调用: ${violations.join(', ')}`).toEqual([]);
  });

  it('G7 的三个 cardio hooks 位于 `if (!session)` 之前', () => {
    const src = readFileSync(FILE, 'utf8');
    const early = src.indexOf('if (!session) {');
    expect(early).toBeGreaterThan(-1);
    for (const id of ['const cardioFlushers', 'const registerCardioFlush', 'const requestOpenSummary']) {
      const idx = src.indexOf(id);
      expect(idx, `${id} 缺失`).toBeGreaterThan(-1);
      expect(idx, `${id} 必须在提前 return 之前`).toBeLessThan(early);
    }
  });
});
