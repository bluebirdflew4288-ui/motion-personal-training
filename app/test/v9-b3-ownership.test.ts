/* B3 行为回归：G3 精确值归属、原子删除、字段稳定 ID、历史导航门禁。
   ── 证据边界 ────────────────────────────────────────────────
   源码结构断言 + 领域/事务语义验证，**不运行 React DOM**。
   真实 CUA 由 Codex 独立链验证；本文件不冒充设备行为。 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const PLANS = `${read('src/pages/plans/PlansPage.tsx')}\n${read('src/pages/plans/PlanDayEditor.tsx')}`;
const CARDIO = read('src/ui/CardioPanel.tsx');
const ROUTER = read('src/lib/router.ts');
const REPO = read('src/db/repo.ts');

describe('B3/G3 · 最新精确意图必须胜过旧滑杆意图', () => {
  it('存在字段级意图时序', () => {
    expect(CARDIO).toContain('fieldIntentRef');
    expect(CARDIO).toContain('markIntent');
  });

  it('三个精确框都标记 precise 意图', () => {
    expect(CARDIO).toContain("markIntent('speedKmh', 'precise')");
    expect(CARDIO).toContain("markIntent('inclinePct', 'precise')");
    expect(CARDIO).toContain("markIntent('level', 'precise')");
  });

  it('三个滑杆都标记 slider 意图', () => {
    expect(CARDIO).toContain("markIntent('speedKmh', 'slider')");
    expect(CARDIO).toContain("markIntent('inclinePct', 'slider')");
    expect(CARDIO).toContain("markIntent('level', 'slider')");
  });

  it('合并时 precise 意图字段跳过滑杆值（continue）', () => {
    const idx = CARDIO.indexOf("if (intent?.from === 'precise')");
    expect(idx).toBeGreaterThan(-1);
    expect(CARDIO.slice(idx, idx + 120)).toContain('continue');
  });

  it('不再无条件整块展开 slider', () => {
    expect(CARDIO).not.toContain('...candidate, ...sliderDelta');
  });

  it('被草稿门禁拦住后回退滑杆本地值（B2 真实 FAIL 修复点）', () => {
    expect(CARDIO).toContain('被拦后必须回退本地待提交意图');
    const idx = CARDIO.indexOf('被拦后必须回退本地待提交意图');
    const seg = CARDIO.slice(idx, idx + 800);
    expect(seg).toContain('setSlider');
    expect(seg).toContain('latest.currentParams');
    expect(seg).toContain('delete fieldIntentRef.current');
  });
});

describe('B3/G5 · 浏览器 Back 也过门禁', () => {
  it('hashchange 监听检查守卫', () => {
    expect(ROUTER).toContain('isLeaveBlocked()');
    expect(ROUTER).toContain('currentHash');
  });

  it('回滚用 replaceState，不新增历史项（避免回退循环）', () => {
    expect(ROUTER).toContain('replaceState');
  });

  it('back() 显式过门禁（history.back 不经 navigate）', () => {
    const idx = ROUTER.indexOf('export function back');
    const body = ROUTER.slice(idx, idx + 300);
    expect(body).toContain('isLeaveBlocked()');
    expect(body).toContain('return');
  });
});

describe('B3/G5 · 合法保存在途成功后自动续原请求', () => {
  it('区分 saving 与 dirty', () => {
    // B4：必须是 state（savingFields），ref 不会让 effect 重跑
    expect(PLANS).toContain('savingFields');
    expect(PLANS).toContain('isAnySaving');
  });

  it('requestManageSwitch 同时检查 saving 与 dirty', () => {
    const idx = PLANS.indexOf('function requestManageSwitch');
    const body = PLANS.slice(idx, idx + 600);
    expect(body).toContain('isAnySaving()');
    expect(body).toContain('isAnyDirty()');
    expect(body).toContain('setPendingSwitch(nextId)');
  });

  it('变干净后自动续（不需用户点放弃）', () => {
    expect(PLANS).toContain('if (!switchBlocked || !pendingSwitch) return;');
    expect(PLANS).toContain('setManagePlanId(target)');
  });
});

describe('B3/G5 · 删除与 current 清理原子化', () => {
  it('repo 提供单事务 API（plans + settings 同一事务）', () => {
    expect(REPO).toContain('atomicDeletePlanWithCurrent');
    expect(REPO).toContain("db.transaction(['plans', 'settings'], 'readwrite')");
  });

  it('事务内读最新 settings，不用陈旧内存', () => {
    const idx = REPO.indexOf('atomicDeletePlanWithCurrent');
    const seg = REPO.slice(idx, idx + 4000);
    expect(seg).toContain("settingsStore.get('app')");
    expect(seg).toContain('decideFallback(currentId, remaining)');
  });

  it('settings put 失败 → done(ok:false) 让事务整体 abort', () => {
    const idx = REPO.indexOf('atomicDeletePlanWithCurrent');
    const seg = REPO.slice(idx, idx + 4000);
    expect(seg).toContain('putReq.onerror');
    expect(seg).toContain('ok: false');
  });

  it('被删的不是 current → 不动 current（避免覆盖并发已选）', () => {
    expect(PLANS).toContain('if (currentId !== deletedId) return undefined;');
  });

  it('事务失败如实提示"未做任何修改"', () => {
    // 从实际调用点开始找（import 行在前面）
    const idx = PLANS.indexOf('const r = await atomicDeletePlanWithCurrent');
    const seg = PLANS.slice(idx, idx + 2000);
    expect(seg).toContain('if (!r.ok)');
    expect(seg).toContain('未做任何修改');
  });
});

describe('B3/G5 · 字段 ID 用实体稳定 ID（不用源码行号）', () => {
  it('数字字段 ID 含实体 ID', () => {
    expect(PLANS).toContain('num:cardio:${day.id}:${pc.id}:speed');
    expect(PLANS).toContain('num:ex:${day.id}:${ex.id}:sets');
  });

  it('不得再出现源码行号形式的 ID（如 @1289）', () => {
    const bad = PLANS.match(/num:[^`]*@\d+/g) ?? [];
    expect(bad).toEqual([]);
  });
});
