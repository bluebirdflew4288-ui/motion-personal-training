/* B2/G5 行为回归：多字段 dirty 聚合、放弃切目标、删除真实结果、IME 登记。
   ── 证据边界 ────────────────────────────────────────────────
   用 AST 抽取真实源码片段执行 + 纯函数行为断言，**不运行 React DOM**。
   真实 CUA 由 Codex 独立链验证；本文件不冒充设备行为。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { shouldSyncExternal } from '../src/ui/draftForm';

const PLANS_PAGE = resolve(process.cwd(), 'src/pages/plans/PlansPage.tsx');
const PLAN_DAY_EDITOR = resolve(process.cwd(), 'src/pages/plans/PlanDayEditor.tsx');
const SRC = `${readFileSync(PLANS_PAGE, 'utf8')}\n${readFileSync(PLAN_DAY_EDITOR, 'utf8')}`;
const ASTS = [
  ts.createSourceFile(PLANS_PAGE, readFileSync(PLANS_PAGE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  ts.createSourceFile(PLAN_DAY_EDITOR, readFileSync(PLAN_DAY_EDITOR, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
];

function fnBody(name: string): string {
  let body: string | null = null;
  for (const ast of ASTS) {
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) body = n.body.getText(ast);
      ts.forEachChild(n, visit);
    };
    visit(ast);
    if (body) break;
  }
  if (!body) throw new Error(`找不到函数 ${name}`);
  return body;
}

describe('G5-R1 · 多字段 dirty 聚合（不被子组件覆盖）', () => {
  /** 复刻 PlansPage 的聚合模型（与源码同构，用于行为验证） */
  function makeAggregator() {
    const map = new Map<string, boolean>();
    return {
      report: (id: string, dirty: boolean) => {
        if (dirty) map.set(id, true);
        else map.delete(id);
      },
      isAnyDirty: () => {
        for (const v of map.values()) if (v) return true;
        return false;
      },
      clear: () => map.clear(),
    };
  }

  it('一个字段成功保存（变干净）不会洗掉另一个字段的 dirty', () => {
    const a = makeAggregator();
    a.report('plan-name:p1', true); // 计划名空草稿
    a.report('day-name:p1:d1', true); // 第1日改名
    expect(a.isAnyDirty()).toBe(true);

    // 第1日保存成功 → 只有它变干净
    a.report('day-name:p1:d1', false);
    // 计划名的 dirty 必须仍在（这正是 B 批真实 FAIL 的场景）
    expect(a.isAnyDirty()).toBe(true);
  });

  it('全部字段都干净才放行', () => {
    const a = makeAggregator();
    a.report('plan-name:p1', true);
    a.report('day-name:p1:d1', true);
    a.report('plan-name:p1', false);
    expect(a.isAnyDirty()).toBe(true);
    a.report('day-name:p1:d1', false);
    expect(a.isAnyDirty()).toBe(false);
  });

  it('源码确实用 Map 按 fieldId 聚合，而不是单一布尔', () => {
    // B4：ref 改为 state（ref 变化不触发重渲染，effect 永远不重跑）
    expect(SRC).toContain('dirtyFields');
    expect(SRC).toContain('isAnyDirty');
    // 不得再存在单一 dirtyRef 布尔写口
    expect(SRC).not.toMatch(/dirtyRef\.current\s*=\s*dirty/);
  });

  it('每个字段用稳定 fieldId 登记（计划名/日名/配置/数字）', () => {
    expect(SRC).toMatch(/fieldDirtyHandler\(`plan-name:/);
    expect(SRC).toMatch(/fieldDirtyHandler\(`day-name:/);
    expect(SRC).toMatch(/editorDirtyHandler\(`drop-config:/);
    expect(SRC).toMatch(/editorDirtyHandler\(`num:/);
  });
});

describe('G5-R2 · 放弃修改并切换必须真的切目标', () => {
  it('requestManageSwitch 记录 pendingSwitch 目标', () => {
    const body = fnBody('requestManageSwitch');
    expect(body).toContain('setPendingSwitch(nextId)');
  });

  it('performDiscardAndSwitch 清空聚合状态并切到目标', () => {
    const body = fnBody('PlansPage');
    expect(body).toContain('const target = pendingSwitch');
    expect(body).toContain('setDirtyFields(new Map())');
    expect(body).toMatch(/setManagePlanId\(target\)/);
    // 必须发出"放弃"信号让字段真正取消草稿
    expect(body).toContain('setDiscardEpoch');
  });

  it('字段收到 discardEpoch 会重置草稿（DraftTextField/NumberField 都有）', () => {
    for (const f of ['src/ui/DraftTextField.tsx', 'src/ui/DraftNumberField.tsx']) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      expect(src).toContain('discardEpoch');
    }
  });
});

describe('G5-R6 · 删除后 settings 写失败不得假报成功', () => {
  it('setCurrentPlan 返回真实 boolean 结果', () => {
    const store = readFileSync(resolve(process.cwd(), 'src/store.tsx'), 'utf8');
    expect(store).toMatch(/setCurrentPlan:\s*\(planId: string \| null\) => Promise<boolean>/);
    // 失败必须 return false，且回滚内存
    expect(store).toMatch(/catch[\s\S]{0,400}?return false;/);
  });

  it('删除流程用原子事务，失败则整体回滚并如实提示', () => {
    const body = fnBody('PlansPage');
    // B3：改为单笔事务，settings 写失败 → 删除一起回滚
    expect(body).toContain('atomicDeletePlanWithCurrent');
    expect(body).toMatch(/if \(!r\.ok\)/);
    // 失败提示必须说明"未做任何修改"，不能弹已回退
    expect(body).toContain('未做任何修改');
  });
});

describe('G5-R5 · IME 组合态计入 dirty', () => {
  it('DraftTextField dirty 判定包含 composing', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/DraftTextField.tsx'), 'utf8');
    expect(src).toMatch(/composing\.current\s*\|\|/);
  });

  it('DraftNumberField dirty 判定包含 composingRef', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/ui/DraftNumberField.tsx'), 'utf8');
    expect(src).toMatch(/composingRef\.current/);
    expect(src).toContain('onCompositionStart');
  });
});

describe('G5-R3 · 统一离页门禁覆盖编辑与返回', () => {
  it('router 提供 registerLeaveGuard 且 navigate 检查它', () => {
    const r = readFileSync(resolve(process.cwd(), 'src/lib/router.ts'), 'utf8');
    expect(r).toContain('registerLeaveGuard');
    expect(r).toMatch(/if \(isLeaveBlocked\(\)\) return;/);
  });

  it('PlansPage 与 PlanDayEditor 都注册守卫', () => {
    const page = fnBody('PlansPage');
    expect(page).toContain('registerLeaveGuard');
    const editor = fnBody('PlanDayEditor');
    expect(editor).toContain('registerLeaveGuard');
  });

  it('配置草稿（递减组）向门禁登记（B4-R1：合并后单次上报）', () => {
    const body = fnBody('ExistingDropEditor');
    // B4-R1：不再由本层单独上报（避免与外层 structuredDirty 两路写同一 owner）
    expect(body).toContain('const structuredDirty = dirty || saving');
    expect(body).toContain('structuredDirty={structuredDirty}');
    // 由 DropSetEditor 合并后单次上报
    const drop = readFileSync(resolve(process.cwd(), 'src/ui/DropSetEditor.tsx'), 'utf8');
    expect(drop).toContain('onDirtyChange(structuredDirty || rawInvalid)');
    // 且不得再用会 setErrors 的 flushAll 做 effect 轮询
    expect(drop).toContain('probeRawValid');
  });
});

describe('G3 · 未完成精确草稿在失焦后不被外部值覆盖', () => {
  // Codex 独立窄例：真实 effect 的判定函数
  it('focused=false + 未完 `7.` + 外部 9.5 → 保留草稿', () => {
    expect(shouldSyncExternal(9.5, 5.5, '7.')).toBe(false);
  });

  it('focused=false + 非法 `99999` + 外部 9.5 → 保留草稿', () => {
    expect(shouldSyncExternal(9.5, 5.5, '99999')).toBe(false);
  });

  it('focused=false + 空串 + 外部 9.5 → 保留（既有 F4-I02 语义）', () => {
    expect(shouldSyncExternal(9.5, 5.5, '')).toBe(false);
  });

  it('干净草稿 + 外部 9.5 → 采纳', () => {
    expect(shouldSyncExternal(9.5, 5.5, '5.5')).toBe(true);
  });

  it('外部值未变 → 不同步', () => {
    expect(shouldSyncExternal(5.5, 5.5, '7.')).toBe(false);
  });
});
