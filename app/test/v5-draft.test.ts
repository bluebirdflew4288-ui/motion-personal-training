/* V4-03「统一提交当前表单草稿」的纯规则验收。
   对应审查 input/review.md 的三个 P2 缺陷：

   F4-I01  力竭阶段的**重量**被错误排除统一校验
           → 力竭只意味着「不要求次数目标」，重量仍可编辑、仍须 0–999。
           旧实现三个字段一起 `st.toFailure ? undefined : form` 注销，
           于是力竭重量填 1000 只有局部红字，父 flushAll 通过 → 保存旧重量并关窗。
   F4-I02  清空必填数字后 blur 自动回填旧值
           → 外部同步 effect 里有 `|| draft === ''`，空串被改回旧值并清错误。
   F4-I03  flushAll 只校验、不提交当前解析值
           → 父 handler 拿到 values 后仍读旧父 state，存成旧值。

   项目没装 jsdom/happy-dom，因此这里只测**从组件里抽出的纯函数**；
   需要真实 DOM 的联动（Sheet 是否关闭、输入框是否 disabled）明确标注为
   「未覆盖，由 verify-v5/browser-forms-v5.mjs 覆盖」，不写假测试。 */

import { describe, expect, it } from 'vitest';
import {
  mergeFlushedDropDraft,
  mergeFlushedStraightDraft,
  mergeFlushedValues,
  parseDraftNumber,
  shouldSyncExternal,
  validateStraightDraft,
} from '../src/ui/draftForm';
import {
  defaultDropDraft,
  describeDropDraft,
  draftToDropTarget,
  dropTargetToDraft,
  updateStage,
  validateDropDraft,
  type DropSetDraft,
} from '../src/domain/dropSet';
import { stageFieldIds } from '../src/ui/DropSetEditor';
import { MAX_STRAIGHT_SETS } from '../src/domain/limits';

/* DropSetEditor 实际注册到父表单的 fieldId 前缀（已 grep 确认）：
   Plans 新增动作 = "addDrop"，Plans 既有递减组 = `ex.${exercise.id}`，
   Session 训练中转换 = "convert"。这里用一个代表性前缀跑规则。 */
const P = 'addDrop';

/** 重量字段的注册规则 —— 与 DropSetEditor 里 st.toFailure 无关，始终注册 */
const weightOpts = { min: 0, max: 999, integer: false };

describe('F4-I01 力竭阶段的重量仍受 0–999 约束（始终注册父表单）', () => {
  it('注册规则：力竭阶段的 weight 仍有 fieldId（这就是旧缺陷的判定点）', () => {
    const failing = stageFieldIds('addDrop', 2, true);
    // 旧实现这里是 undefined → 父 flushAll 根本看不到重量，1000 也能通过
    expect(failing.weight).toBe('addDrop.s2.weight');
    // 只有被 disabled 的次数框才注销
    expect(failing.repsMin).toBeUndefined();
    expect(failing.repsMax).toBeUndefined();
  });

  it('注册规则：非力竭阶段三个字段全部注册', () => {
    const normal = stageFieldIds('addDrop', 0, false);
    expect(normal.weight).toBe('addDrop.s0.weight');
    expect(normal.repsMin).toBe('addDrop.s0.repsMin');
    expect(normal.repsMax).toBe('addDrop.s0.repsMax');
  });

  it('注册规则：三个调用点的真实前缀都产出预期的 fieldId', () => {
    // Plans 新增动作 / Plans 既有递减组 / Session 训练中转换
    expect(stageFieldIds('addDrop', 1, false).weight).toBe('addDrop.s1.weight');
    expect(stageFieldIds('ex.abc', 1, false).weight).toBe('ex.abc.s1.weight');
    expect(stageFieldIds('convert', 1, true).weight).toBe('convert.s1.weight');
  });

  it('力竭阶段重量 1000 → 不合法，消息是「不能大于 999」', () => {
    const r = parseDraftNumber('1000', weightOpts);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('999');
    // 关键：字段被注册了才会走到这里；旧实现力竭时根本不注册，父表单看不到这条错误
  });

  it('力竭阶段重量 50 → 合法（力竭不等于禁用重量）', () => {
    const r = parseDraftNumber('50', weightOpts);
    expect(r.ok).toBe(true);
    expect(r.value).toBe(50);
  });

  it('力竭阶段重量允许小数（50.5）', () => {
    expect(parseDraftNumber('50.5', weightOpts)).toMatchObject({ ok: true, value: 50.5 });
  });

  it('力竭草稿：重量值能被 mergeFlushedDropDraft 覆盖进阶段副本', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    // 第 3 阶段默认就是力竭
    expect(base.stages[2].toFailure).toBe(true);
    const next = mergeFlushedDropDraft(base, { [`${P}.s2.weight`]: 50 }, P);
    expect(next.stages[2].weightKg).toBe(50);
    expect(next.stages[2].toFailure).toBe(true);
    // 原草稿不被修改（必须用副本，避免 setState 前污染父 state）
    expect(base.stages[2].weightKg).not.toBe(50);
  });

  it('力竭阶段的次数框不注册 → values 里没有它，但重量在', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    // 模拟真实注册表：力竭阶段只注册 weight，不注册 repsMin/repsMax
    const registered = {
      [`${P}.s2.weight`]: 50,
      [`${P}.rounds`]: 3,
    };
    const next = mergeFlushedDropDraft(base, registered, P);
    expect(next.stages[2].weightKg).toBe(50);
    // 力竭阶段保持 null，不被 0 覆盖
    expect(next.stages[2].repsMin).toBeNull();
    expect(next.stages[2].repsMax).toBeNull();
    expect(validateDropDraft(next)).toEqual([]);
  });

  it('力竭阶段重量 1000 被 flush 拦下时，结构校验也应报重量问题（双保险）', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const bad = updateStage(base, 2, { weightKg: 1000 });
    const issues = validateDropDraft(bad);
    expect(issues.some((i) => i.path === 'stages[2].weightKg')).toBe(true);
  });
});

describe('F4-I02 空串必须保留，不被外部同步回填旧值', () => {
  it("parseDraftNumber('') → ok:false，消息含「不能为空」", () => {
    const r = parseDraftNumber('');
    expect(r.ok).toBe(false);
    expect(r.value).toBeNull();
    expect(r.message).toContain('不能为空');
  });

  it('纯空白串同样视为空', () => {
    expect(parseDraftNumber('   ').message).toContain('不能为空');
  });

  it('shouldSyncExternal：draft 为空串但 value 未变 → 不同步（这就是回填 bug 的判定点）', () => {
    // 场景：值一直是 3，用户清空 → blur。旧代码 `draft === ''` 为 true → 回填 3。
    expect(shouldSyncExternal(3, 3, '')).toBe(false);
    // 反向对照：旧条件 `value !== last || draft === ''` 在这里会是 true
    expect(3 !== 3 || '' === '').toBe(true);
  });

  it('shouldSyncExternal：真正的外部更新（value 变了）才同步', () => {
    expect(shouldSyncExternal(5, 3, '3')).toBe(true);
    // 焦点内输入不应被覆盖，由 effect 里的 focused 提前 return 负责（DOM 侧，
    // 未覆盖，由浏览器脚本的逐键输入用例覆盖）
  });

  it('空串在任何 min/max 组合下都返回 null 值，不会被当 0', () => {
    for (const opts of [{}, { min: 1, max: 30 }, { min: 0, max: 999, integer: false }]) {
      const r = parseDraftNumber('', opts);
      expect(r.ok).toBe(false);
      expect(r.value).toBeNull();
    }
  });

  it('中间态 "7." 报「数字未输完」而不是被截成 7', () => {
    expect(parseDraftNumber('7.')).toMatchObject({ ok: false, value: null });
    expect(parseDraftNumber('7.').message).toContain('未输完');
  });

  it('逐键小数 7 → 7. → 7.5 与 0 → 0. → 0.5（回归：不破坏小数输入）', () => {
    expect(parseDraftNumber('7', { integer: false })).toMatchObject({ ok: true, value: 7 });
    expect(parseDraftNumber('7.', { integer: false }).ok).toBe(false);
    expect(parseDraftNumber('7.5', { integer: false })).toMatchObject({ ok: true, value: 7.5 });
    expect(parseDraftNumber('0', { integer: false })).toMatchObject({ ok: true, value: 0 });
    expect(parseDraftNumber('0.', { integer: false }).ok).toBe(false);
    expect(parseDraftNumber('0.5', { integer: false })).toMatchObject({ ok: true, value: 0.5 });
  });
});

describe('F4-I03 flushAll 的 values 必须真的被用上（不依赖 blur）', () => {
  it('普通组：state 是 3、当前文本是 5 → nextDraft.sets 必须是 5', () => {
    const base = { sets: 3, repsMin: 8, repsMax: 12 };
    // 模拟「文本已改成 5，但还没 blur，所以父 state 仍是 3」
    const next = mergeFlushedStraightDraft(base, { 'add.sets': 5 }, 'add');
    expect(next.sets).toBe(5);
    expect(next).not.toBe(base);
    expect(base.sets).toBe(3); // 原 state 未被修改
  });

  it('普通组：三个字段一起覆盖（5 × 10–15）', () => {
    const base = { sets: 3, repsMin: 8, repsMax: 12 };
    const next = mergeFlushedStraightDraft(
      base,
      { 'add.sets': 5, 'add.repsMin': 10, 'add.repsMax': 15 },
      'add',
    );
    expect(next).toEqual({ sets: 5, repsMin: 10, repsMax: 15 });
    expect(validateStraightDraft(next)).toEqual([]);
  });

  it('普通组：values 里缺失的字段保留 base 值（不是被抹成 undefined）', () => {
    const base = { sets: 3, repsMin: 8, repsMax: 12 };
    const next = mergeFlushedStraightDraft(base, { 'add.sets': 5 }, 'add');
    expect(next.repsMin).toBe(8);
    expect(next.repsMax).toBe(12);
  });

  it('值 0 是合法值，不能被当成「没有值」而回退到旧值', () => {
    const base = { sets: 3, repsMin: 8, repsMax: 12 };
    const next = mergeFlushedStraightDraft(base, { 'add.sets': 0 }, 'add');
    // 关键：如果实现写成 `if (!v) continue`，这里会得到 3（=旧值），
    // 正是「轮数填 0 却保存了旧 3」的静默路径。
    expect(next.sets).toBe(0);
  });

  it('无 blur + 非法：sets 为 0 时上层语义校验必须拒绝（不能落库）', () => {
    const base = { sets: 3, repsMin: 8, repsMax: 12 };
    const next = mergeFlushedStraightDraft(base, { 'add.sets': 0 }, 'add');
    const issues = validateStraightDraft(next);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path === 'sets')).toBe(true);
  });

  it('无 blur + 非法：反向范围 20–10 被跨字段校验拒绝', () => {
    const next = mergeFlushedStraightDraft(
      { sets: 3, repsMin: 8, repsMax: 12 },
      { 'add.sets': 3, 'add.repsMin': 20, 'add.repsMax': 10 },
      'add',
    );
    const issues = validateStraightDraft(next);
    expect(issues.some((i) => i.message.includes('不能大于'))).toBe(true);
  });

  it('组数超过上限（31）被拒绝', () => {
    const next = mergeFlushedStraightDraft(
      { sets: 3, repsMin: 8, repsMax: 12 },
      { 'add.sets': MAX_STRAIGHT_SETS + 1 },
      'add',
    );
    expect(validateStraightDraft(next).some((i) => i.path === 'sets')).toBe(true);
  });

  it('递减组：父 state 的 rounds 是 3、当前文本是 5 → nextDraft.rounds 是 5', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    expect(base.rounds).toBe(3);
    const next = mergeFlushedDropDraft(base, { [`${P}.rounds`]: 5 }, P);
    expect(next.rounds).toBe(5);
    expect(base.rounds).toBe(3);
  });

  it('递减组：轮数填 0 不会被静默回退成旧值 3，且被结构校验拦下', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const next = mergeFlushedDropDraft(base, { [`${P}.rounds`]: 0 }, P);
    expect(next.rounds).toBe(0);
    const issues = validateDropDraft(next);
    expect(issues.some((i) => i.path === 'rounds')).toBe(true);
  });

  it('递减组：休息字段按 fieldId 精确落位（restIn / restAfter 不串位）', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const next = mergeFlushedDropDraft(base, { [`${P}.restIn`]: 30, [`${P}.restAfter`]: 240 }, P);
    expect(next.restInSec).toBe(30);
    expect(next.restAfterSec).toBe(240);
  });

  it('递减组：阶段字段按 sN 索引精确落位（不会全写到第 0 阶段）', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const next = mergeFlushedDropDraft(
      base,
      {
        [`${P}.s0.weight`]: 40,
        [`${P}.s1.weight`]: 30,
        [`${P}.s1.repsMin`]: 10,
        [`${P}.s1.repsMax`]: 12,
      },
      P,
    );
    expect(next.stages[0].weightKg).toBe(40);
    expect(next.stages[1].weightKg).toBe(30);
    expect(next.stages[1].repsMin).toBe(10);
    expect(next.stages[1].repsMax).toBe(12);
  });

  it('递减组：用 nextDraft 生成的目标带着新值（不是旧值）', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const next = mergeFlushedDropDraft(base, { [`${P}.rounds`]: 4, [`${P}.s2.weight`]: 50 }, P);
    const target = draftToDropTarget(next);
    expect(target.rounds).toBe(4);
    expect(target.stages[2].weightKg).toBe(50);
    expect(target.stages[2].toFailure).toBe(true);
  });

  it('mergeFlushedValues：未知 fieldId 不会凭空写入 base', () => {
    const base = { a: 1 };
    const next = mergeFlushedValues(base, { 'nope.x': 9 }, { a: 'a.b' });
    expect(next).toEqual({ a: 1 });
  });
});

describe('保留用例（已有有效修复不得回归）', () => {
  it('既有递减编辑 20 → 25 中间态：先下限 20、再上限 25，最终 20–25', () => {
    // 起点 8–12（审查现场）
    let d: DropSetDraft = defaultDropDraft({ weightKg: 40 });
    d = updateStage(d, 0, { repsMin: 20 });
    // 中间态：20–12 反向，此时结构校验应当报错（不能静默吞掉）
    expect(validateDropDraft(d).some((i) => i.path === 'stages[0].reps')).toBe(true);
    d = updateStage(d, 0, { repsMax: 25 });
    // 最终 20–25 合法
    expect(validateDropDraft(d)).toEqual([]);
    expect(d.stages[0].repsMin).toBe(20);
    expect(d.stages[0].repsMax).toBe(25);
  });

  it('20 → 25 中间态走 flush 路径同样成立（两个字段都在 values 里）', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const mid = mergeFlushedDropDraft(base, { [`${P}.s0.repsMin`]: 20 }, P);
    expect(validateDropDraft(mid).some((i) => i.path === 'stages[0].reps')).toBe(true);
    const done = mergeFlushedDropDraft(mid, { [`${P}.s0.repsMin`]: 20, [`${P}.s0.repsMax`]: 25 }, P);
    expect(validateDropDraft(done)).toEqual([]);
    expect([done.stages[0].repsMin, done.stages[0].repsMax]).toEqual([20, 25]);
  });

  it('取消力竭 → 自动补 8–12 默认范围，且结构校验通过', () => {
    const d = defaultDropDraft({ weightKg: 40 });
    expect(d.stages[2].toFailure).toBe(true);
    // 复刻 DropSetEditor checkbox 的 onChange 逻辑
    const st = d.stages[2];
    const next = updateStage(d, 2, {
      toFailure: false,
      repsMin: st.repsMin ?? 8,
      repsMax: st.repsMax ?? 12,
    });
    expect(next.stages[2].toFailure).toBe(false);
    expect(next.stages[2].repsMin).toBe(8);
    expect(next.stages[2].repsMax).toBe(12);
    expect(validateDropDraft(next)).toEqual([]);
  });

  it('取消力竭后再改次数范围仍然成立（不残留 disabled 语义）', () => {
    const d = defaultDropDraft({ weightKg: 40 });
    const un = updateStage(d, 2, { toFailure: false, repsMin: 8, repsMax: 12 });
    const edited = updateStage(un, 2, { repsMin: 10, repsMax: 15 });
    expect(validateDropDraft(edited)).toEqual([]);
    expect([edited.stages[2].repsMin, edited.stages[2].repsMax]).toEqual([10, 15]);
  });

  it('新增普通动作 5 组 × 10–15 用用户输入', () => {
    const next = mergeFlushedStraightDraft(
      { sets: 3, repsMin: 8, repsMax: 12 },
      { 'add.sets': 5, 'add.repsMin': 10, 'add.repsMax': 15 },
      'add',
    );
    expect(validateStraightDraft(next)).toEqual([]);
    expect(next).toEqual({ sets: 5, repsMin: 10, repsMax: 15 });
  });

  it('轮数填 0 阻止保存（结构校验）且 0 不被替换成旧值', () => {
    const base = defaultDropDraft({ weightKg: 40 });
    const next = mergeFlushedDropDraft(base, { [`${P}.rounds`]: 0 }, P);
    expect(next.rounds).toBe(0);
    expect(validateDropDraft(next).some((i) => i.path === 'rounds')).toBe(true);
  });

  it('域往返：dropTargetToDraft(draftToDropTarget(d)) 不丢字段', () => {
    const d = defaultDropDraft({ weightKg: 42.5 });
    const back = dropTargetToDraft(draftToDropTarget(d));
    expect(back.rounds).toBe(d.rounds);
    expect(back.stages.map((s) => s.weightKg)).toEqual(d.stages.map((s) => s.weightKg));
    expect(back.stages.map((s) => s.toFailure)).toEqual(d.stages.map((s) => s.toFailure));
  });

  it('描述文本随草稿值更新（预览与保存值一致）', () => {
    const d = mergeFlushedDropDraft(defaultDropDraft({ weightKg: 40 }), { [`${P}.s2.weight`]: 50 }, P);
    expect(describeDropDraft(d)).toContain('50kg');
  });
});

/* ── 明确未覆盖（需要真实 DOM，由 verify-v5/browser-forms-v5.mjs 覆盖）──
   1. 清空「组数」→ 点保存 → Sheet 是否保持打开、错误提示是否出现、动作数是否不变。
   2. 力竭阶段重量填 1000 → 保存是否被阻止且未落库；改成 50 → 是否成功落库 50。
   3. 原生 value setter + input 事件改值、**不触发 blur**、直接点保存 → 落库是否为新值。
   4. 焦点期间逐键输入不被父值覆盖、disabled 联动、Escape 真取消（suppressCommit）。
   这些依赖 React 受控输入与 Sheet 的挂载/卸载，node 环境无法验证。 */
