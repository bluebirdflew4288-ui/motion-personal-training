/* G5 回归：计划管理顶部选择框、管理/训练分离、路由与删除回退。
   ── 证据边界 ────────────────────────────────────────────────
   本文件用 **AST 抽取真实 Plans.tsx 的源码片段**做结构断言 + 纯函数级验证，
   不运行 React DOM。真实点击/IME/事务时序由 Codex 独立 CUA 链验证。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE = resolve(process.cwd(), 'src/pages/Plans.tsx');
const SRC = readFileSync(FILE, 'utf8');
const AST = ts.createSourceFile(FILE, SRC, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** 取某函数声明体文本 */
function fnBody(name: string): string {
  let body: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) {
      body = n.body.getText(AST);
    }
    ts.forEachChild(n, visit);
  };
  visit(AST);
  if (!body) throw new Error(`找不到函数 ${name}`);
  return body;
}

describe('G5 · 管理选择与训练 current 分离', () => {
  it('存在独立的管理 planId 状态（不是直接复用 settings.currentPlanId）', () => {
    expect(SRC).toContain('managePlanId');
    expect(SRC).toContain('setManagePlanId');
  });

  it('初始优先级：路由 → 训练 current → 首项', () => {
    const body = fnBody('PlansPage');
    // 三个优先级分支都要出现，且顺序正确
    const routeIdx = body.indexOf('routeValid');
    const currentIdx = body.indexOf('currentValid');
    const firstIdx = body.indexOf('plans[0]?.id');
    expect(routeIdx).toBeGreaterThan(-1);
    expect(currentIdx).toBeGreaterThan(routeIdx);
    expect(firstIdx).toBeGreaterThan(currentIdx);
  });

  it('切换管理计划**不**调用训练 current setter', () => {
    const body = fnBody('requestManageSwitch');
    // 管理切换绝不能顺手改训练计划
    expect(body).not.toContain('setCurrentPlan(');
  });

  it('路由同步只写 plan query，不改训练设置', () => {
    expect(SRC).toMatch(/navigate\(`\/plans\?plan=/);
  });
});

describe('G5 · 切换必须经过草稿门禁', () => {
  it('requestManageSwitch 在 dirty 时**不切换**，且记录目标（B2 修复 G5-R1/R2）', () => {
    const body = fnBody('requestManageSwitch');
    // B2：单布尔 dirtyRef 已改为按 fieldId 聚合的 isAnyDirty()
    // B3：判定包含"合法保存在途"与"脏"两种
    expect(body).toMatch(/isAnySaving\(\)\s*\|\|\s*isAnyDirty\(\)/);
    // dirty 分支必须先 return，不能继续 setManagePlanId
    expect(body).toMatch(/isAnyDirty\(\)[\s\S]*?return;/);
    // 必须记录目标，否则"放弃并切换"无目标可切（G5-R2 真实 FAIL）
    expect(body).toContain('setPendingSwitch(nextId)');
    // 且给出可见提示而不是静默丢弃
    expect(body).toContain('setSwitchBlocked(true)');
  });

  it('只有干净状态才真正 setManagePlanId', () => {
    const body = fnBody('requestManageSwitch');
    const setIdx = body.indexOf('setManagePlanId(nextId)');
    expect(setIdx).toBeGreaterThan(-1);
    // setManagePlanId 出现在 dirty 判定之后
    expect(setIdx).toBeGreaterThan(body.indexOf('isAnyDirty()'));
  });

  it('提供"放弃修改并切换"的显式出口，且**真的切换**（B2 修复 G5-R2）', () => {
    expect(SRC).toContain('放弃修改并切换');
    const body = fnBody('PlansPage');
    // 必须存在真正执行放弃并切换的实现
    expect(body).toContain('performDiscardAndSwitch');
    // 该实现必须真的切到目标
    expect(body).toMatch(/const target = pendingSwitch/);
    expect(body).toMatch(/setManagePlanId\(target\)/);
  });
});

describe('G5 · 主体只展示所选计划', () => {
  it('不再对所有 plans 直接 map 展开整份详情', () => {
    // 旧实现 `{plans.map((plan) => (` 展开全部；现在只渲染 managedPlan
    expect(SRC).toContain('managedPlan');
    expect(SRC).not.toMatch(/\{plans\.map\(\(plan\)\s*=>\s*\(\s*\n\s*<section key=\{plan\.id\}/);
  });

  it('新建/导入入口常驻（不受所选计划影响）', () => {
    expect(SRC).toContain('+ 新建');
    expect(SRC).toContain('导入');
  });
});

describe('G5 · 编辑返回保留管理 ID', () => {
  it('PlanDayEditor 返回按钮带回 plan 参数', () => {
    const body = fnBody('PlanDayEditor');
    expect(body).toMatch(/navigate\(`\/plans\?plan=\$\{encodeURIComponent\(planId\)\}`\)/);
  });

  it('计划已不存在时回退不指向失效 ID', () => {
    const body = fnBody('PlanDayEditor');
    // 回退用不带 plan 的 /plans，让管理页按优先级重算
    expect(body).toContain("navigate('/plans', true)");
  });
});

describe('G5 · 删除只在成功后清理匹配引用', () => {
  it('删除改用**单笔原子事务**（B3 裁决），不再是先删后独立写 settings', () => {
    expect(SRC).toContain('atomicDeletePlanWithCurrent');
    // 旧的分离写法必须消失
    expect(SRC).not.toContain('await deletePlan(deletedId)');
    // 事务结果决定是否回退
    const idx = SRC.indexOf('if (!r.ok)');
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.indexOf('managePlanId === deletedId', idx)).toBeGreaterThan(idx);
  });

  it('只在 current 恰好等于被删 ID 时才清理训练引用（事务内判定）', () => {
    // 判定移入事务回调：currentId !== deletedId → undefined（不动 current）
    expect(SRC).toContain('if (currentId !== deletedId) return undefined;');
  });

  it('失败分支不假删、不先清 current', () => {
    const idx = SRC.indexOf('await deletePlan(deletedId)');
    const catchIdx = SRC.indexOf('删除失败', idx);
    expect(catchIdx).toBeGreaterThan(idx);
    // catch 里不应调用 setCurrentPlan
    const catchBlock = SRC.slice(catchIdx, catchIdx + 200);
    expect(catchBlock).not.toContain('setCurrentPlan(');
  });
});
