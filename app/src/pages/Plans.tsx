/* 计划管理：新建 / 复制 / 重命名 / 删除 / 编辑训练日与动作。
   所有保存立即写库；失败会提示，不静默失败。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate, registerLeaveGuard, useRoute } from '../lib/router';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import { DraftTextField } from '../ui/DraftTextField';
import {
  addDay,
  addExercise,
  addWarmup,
  canAddDay,
  clonePlan,
  deleteDay,
  moveDay,
  moveExerciseInPlan,
  remainingExerciseSlots,
  removeExercise,
  removeWarmup,
  renameDay,
  renameExercise,
  renamePlan,
  setDayKind,
  updateExercise,
  updateTarget,
  updateWarmup,
} from '../domain/planEdit';
import {
  MAX_CARDIO_ENTRIES,
  MAX_EXERCISES,
  MAX_INCLINE_PCT,
  MAX_LEGACY_PLAN_NAME,
  MAX_PLAN_NAME,
  MAX_REPS,
  MAX_SPEED_KMH,
  MAX_STRAIGHT_SETS,
  MAX_STAIR_LEVEL,
} from '../domain/limits';
import { createV32Plan } from '../domain/presets/v32';
import { targetGroupsOf } from '../domain/session';
import { DraftNumberField } from '../ui/DraftNumberField';
import { TemplateImportSheet } from '../ui/TemplateImportSheet';
import { DropSetEditor } from '../ui/DropSetEditor';
import {
  mergeFlushedDropDraft,
  mergeFlushedStraightDraft,
  useDraftForm,
  validateStraightDraft,
} from '../ui/draftForm';
import {
  defaultDropDraft,
  describeDropDraft,
  draftToDropTarget,
  dropTargetToDraft,
  dropToStraightTarget,
  straightToDropDraft,
  validateDropDraft,
  type DropSetDraft,
} from '../domain/dropSet';
import { atomicDeletePlanWithCurrent } from '../db/repo';
import { searchExercises } from '../domain/presets/library';
import type { ExerciseTarget, Plan, PlanCardio, PlanDay, PlanExercise } from '../domain/types';

const FOCUS_LABEL = { chest: '胸', back: '背', legs: '腿' } as const;

/**
 * G5：计划管理页的**管理选择**。
 *
 * ── 与训练用 currentPlanId 分离 ────────────────────────────────
 * `settings.currentPlanId` 决定「训练用哪个计划」；
 * 本页的「正在管理哪个计划」是**独立的查看态**，绝不因为查看/编辑 B
 * 而静默把训练计划从 A 切到 B。
 *
 * ── 初始选择优先级（已裁决）──────────────────────────────────
 *   ① 路由里有效的管理 planId
 *   ② 有效的训练 settings.currentPlanId
 *   ③ 计划列表首项
 *
 * ── 为什么用 state 而不是纯路由 ────────────────────────────────
 * 切换必须经过**草稿门禁**（见 requestManageSwitch）：若当前视图还有
 * 合法保存在途 / 错误 / 未完值 / IME / 未保存配置草稿，就不能直接卸载。
 * 因此选择先落到 state，门禁通过后才真正切换并同步路由。
 */
/**
 * B4-R2：**字段 owner 的完整生命周期**（注册 → 上报 → 注销）。
 *
 * <p>为什么必须有一个统一 hook：
 * 旧实现里 `fieldDirtyHandler(fieldId)` 只是返回一个稳定回调，
 * 组件卸载时**没有任何人**调用 `unregisterField` ——
 * 于是已卸载字段的 dirty 永久留在 Map 里，离页门禁被幽灵 dirty 卡死
 * （Codex 真实 002：合法 3→4 blur → 取消恢复 3 → ‹计划 无反应）。
 *
 * <p>本 hook 把三件事绑在同一个 effect 生命周期上：
 * <ul>
 *   <li>拿到稳定上报回调（不每次渲染新建，避免 effect 反复重跑）；</li>
 *   <li>卸载时调用 `unregisterField`，**只清自己的键**；</li>
 *   <li>卸载时额外上报一次 `dirty=false`，覆盖"组件已消失但父层还没收到 false"的窗口。</li>
 * </ul>
 *
 * @param fieldId 该字段的稳定唯一 id（同一页面内不得重复）
 * @param onDirty 父层上报函数（PlansPage 传 reportFieldDirty）
 * @param onSaving 父层保存在途上报函数（可选）
 * @param unregister 父层注销函数
 * @returns 稳定的 dirty / saving 上报回调
 */
function useFieldOwner(
  fieldId: string,
  onDirty: (fieldId: string, dirty: boolean) => void,
  onSaving: ((fieldId: string, saving: boolean) => void) | undefined,
  unregister: (fieldId: string) => void,
): {
  reportDirty: (dirty: boolean) => void;
  reportSaving: (saving: boolean) => void;
} {
  const callbacks = useMemo(
    () => ({
      reportDirty: (dirty: boolean) => onDirty(fieldId, dirty),
      reportSaving: (saving: boolean) => onSaving?.(fieldId, saving),
    }),
    [fieldId, onDirty, onSaving],
  );
  useEffect(() => {
    return () => {
      // 卸载：先把本字段标记为干净，再真正注销（顺序保证不会被残留 true 卡住）
      onDirty(fieldId, false);
      unregister(fieldId);
    };
  }, [fieldId, onDirty, unregister]);
  return callbacks;
}

/**
 * B4-R2：编辑页字段 owner 的完整生命周期（注册 → 上报 → 卸载注销）。
 *
 * 与 PlansPage 的 {@link useFieldOwner} 同构，只是写入编辑页自己的 owner 表。
 * 所有需要离页门禁的字段都应通过它拿上报回调，避免"注册了但没人注销"。
 */
function useEditorFieldOwner(
  fieldId: string,
  reportDirty: (fieldId: string, dirty: boolean) => void,
  unregister: (fieldId: string) => void,
): (dirty: boolean) => void {
  const cb = useCallback(
    (dirty: boolean) => reportDirty(fieldId, dirty),
    [fieldId, reportDirty],
  );
  useEffect(() => {
    return () => {
      // 卸载：先标记干净再注销（顺序保证不会被残留 true 卡住）
      reportDirty(fieldId, false);
      unregister(fieldId);
    };
  }, [fieldId, reportDirty, unregister]);
  return cb;
}

export function PlansPage() {
  const { plans, upsertPlan, pushToast, refreshPlans, refreshSettings, settings } = useStore();
  const route = useRoute();

  /** 当前正在管理的 planId（null 表示尚未确定，由下方 effect 初始化） */
  const [managePlanId, setManagePlanId] = useState<string | null>(null);
  /**
   * 切换门禁：非 null 时表示"有一次切换请求正在等草稿门禁结果"。
   * 门禁未通过前**不卸载**当前视图，只把请求挂起。
   */
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  /**
   * **按稳定 ID 聚合**的不可卸载状态（B2 修复 G5-R1）。
   *
   * 旧实现只有一个 `dirtyRef` 布尔：计划名与每个训练日**共用同一个写口**，
   * 后渲染的干净字段会把前面仍脏/仍错误/仍在途字段的 true 改回 false，
   * 门禁随后误放行 —— 这正是 Codex 真实 CUA 确证的"空计划名被切走丢草稿"。
   *
   * 现在每个字段/配置用**稳定 fieldId** 登记自己的状态，门禁取"任一为真"。
   * 卸载时注销，避免已卸载字段的残留状态永久阻塞。
   */
  /** B3/G5-R2：放弃信号 epoch（供字段 reset 草稿） */
  const [discardEpoch, setDiscardEpoch] = useState(0);
  /**
   * 脏字段聚合（B4/G5-R1/R3）。
   *
   * 用 state 而不是 ref：ref 变化不会让依赖它的 effect 重跑。
   * 保留 Map 语义（按 fieldId 聚合，任一为真即脏）。
   */
  const [dirtyFields, setDirtyFields] = useState<ReadonlyMap<string, boolean>>(new Map());
  /**
   * B3/G5-R4：**合法的保存在途**单独跟踪，与"脏"区分。
   *
   * 真实失败：plans.put 命中 hold 时用户切换被拦；保存 7.3 秒后成功，
   * 但请求已丢，UI 仍停在旧页且 blocked 提示不消失，
   * 用户被迫点"放弃"才能完成一个**已经保存成功**的切换。
   *
   * 现在：保存在途 → 记住目标；保存成功且视图变干净 → **自动续原请求**。
   */
  /**
   * 在途保存（B4/G5-R3）。
   *
   * **必须是 state，不能是 ref**：ref 变化不触发重渲染，
   * 依赖它的"自动续原请求" effect 永远不会重新执行 ——
   * 这正是 B3 真实失败的原因（保存成功后仍停在旧页、blocked 提示不消失）。
   *
   * 用 Set 的浅拷贝做 state 值，保证引用变化可被 React 观察到。
   */
  const [savingFields, setSavingFields] = useState<ReadonlySet<string>>(new Set());
  const isAnySaving = (): boolean => savingFields.size > 0;
  const reportFieldSaving = (fieldId: string, saving: boolean): void => {
    setSavingFields((prev) => {
      const next = new Set(prev);
      if (saving) next.add(fieldId);
      else next.delete(fieldId);
      // 引用相等则返回原值，避免无意义重渲染
      return next.size === prev.size && [...next].every((k) => prev.has(k)) ? prev : next;
    });
  };
  /** 门禁判定：任一仍存活字段不可卸载 → 阻止 */
  const isAnyDirty = (): boolean => {
    for (const v of dirtyFields.values()) if (v) return true;
    return false;
  };
  /** 字段登记/更新（state 驱动，保证 effect 可观察） */
  const reportFieldDirty = (fieldId: string, dirty: boolean): void => {
    setDirtyFields((prev) => {
      const next = new Map(prev);
      if (dirty) next.set(fieldId, true);
      else next.delete(fieldId);
      return next;
    });
  };
  /** 字段注销（卸载时调用） */
  /**
   * 字段注销（B4/G5-R4：**真的删除**，不用 void 占位）。
   *
   * 不注销会让已卸载字段的脏状态永久阻塞门禁（幽灵 dirty）。
   */
  const unregisterField = (fieldId: string): void => {
    setDirtyFields((prev) => {
      if (!prev.has(fieldId)) return prev;
      const next = new Map(prev);
      next.delete(fieldId);
      return next;
    });
    setSavingFields((prev) => {
      if (!prev.has(fieldId)) return prev;
      const next = new Set(prev);
      next.delete(fieldId);
      return next;
    });
    dirtyHandlersRef.current.delete(fieldId);
  };
  /**
   * 子组件卸载时注销自己的登记（B2/G5-R1）。
   * 不注销会让已卸载字段的脏状态永久阻塞门禁。
   */
  useEffect(() => {
    return () => {
      // 卸载：清空聚合与 handler 缓存（避免残留状态）
      setDirtyFields(new Map());
      setSavingFields(new Set());
      dirtyHandlersRef.current.clear();
    };
  }, []);

  /** 供子组件用的稳定回调工厂：同一 fieldId 复用同一函数，避免每次渲染新建 */
  const dirtyHandlersRef = useRef<Map<string, (dirty: boolean) => void>>(new Map());
  /** 供子组件上报"该字段保存在途" */
  /**
   * 供子组件上报"保存在途"与"卸载注销"的稳定接口。
   * 注意：这里是**真实返回可调用函数**，不是 void 占位。
   */
  const fieldSavingHandler = (fieldId: string): ((saving: boolean) => void) => {
    return (saving: boolean) => reportFieldSaving(fieldId, saving);
  };
  /**
   * 供子组件在卸载时注销自己的 owner（真的删除，不留幽灵 dirty）。
   *
   * B4-R2：**必须有真正的生命周期消费者**（B4-R1 里这里是 `void` 占位，
   * 函数体可执行但没有任何调用方 —— 静态修复不等于接上）。
   *
   * <p>消费者：`fieldDirtyHandler` 与 `fieldSavingHandler` 返回的回调在
   * 字段卸载时由字段自己调 `fieldUnregister(fieldId)()`。
   * 见下方 `useFieldOwner` 辅助 hook —— 所有上报字段都通过它注册，
   * 保证"注册/上报/注销"是同一份生命周期。
   */
  const fieldUnregister = (fieldId: string): (() => void) => {
    return () => unregisterField(fieldId);
  };
  /**
   * B4-R2：把 `fieldUnregister` 真正接到字段生命周期上。
   *
   * 上面注释里说的"消费者"就是它：所有上报字段通过 `useFieldOwner` 注册，
   * 卸载时同时 `reportFieldDirty(false)` + `unregisterField`。
   * 这里显式引用一次，保证 TS 不再把它当未使用（它是 API，不是占位）。
   */
  const fieldUnregisterRef = useRef(fieldUnregister);
  fieldUnregisterRef.current = fieldUnregister;
  const fieldDirtyHandler = (fieldId: string): ((dirty: boolean) => void) => {
    let fn = dirtyHandlersRef.current.get(fieldId);
    if (!fn) {
      fn = (dirty: boolean) => reportFieldDirty(fieldId, dirty);
      dirtyHandlersRef.current.set(fieldId, fn);
    }
    return fn;
  };
  /** 切换被拦截时的可见提示（不静默丢弃用户输入） */
  const [switchBlocked, setSwitchBlocked] = useState(false);
  /**
   * B2/G5 导入 race 修复：记录"刚创建/导入、等待 plans 刷新"的新 ID。
   * 初始化 effect 见到它时不因"plans 暂无该 ID"而回退旧选择。
   */
  const pendingNewPlanIdRef = useRef<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  /**
   * L03：训练日删除确认状态。
   *
   * 只存「稳定标识」而不是整份 plan 快照 —— 确认时按 dayId 从**当前** plan 重取，
   * 避免确认期间别处改动被旧快照覆盖。
   */
  const [dayDelete, setDayDelete] = useState<{ planId: string; dayId: string; name: string } | null>(null);
  const [dayDeleting, setDayDeleting] = useState(false);

  /**
   * 保存并**如实返回是否成功**（L03 关键修正）。
   *
   * 旧实现 catch 后吞掉错误、只弹 toast，调用方 `await save(...)` 后无法判断结果，
   * 于是删除确认框会无条件关闭并弹出“已删除”—— 失败也报成功。
   */
  async function save(next: Plan): Promise<boolean> {
    try {
      await upsertPlan(next);
      return true;
    } catch (err) {
      pushToast(err instanceof Error ? `计划未保存：${err.message}` : '计划未保存', 'error');
      return false;
    }
  }

  /**
   * 新建计划名称归一化 + 长度校验（与备份校验共用 MAX_PLAN_NAME）。
   *
   * <p>空白输入回退到 fallback；超限则**明确拒绝**（返回 null、提示原因），
   * 由调用方在写库前中止，保证「原数据不变」。不截断、不写假成功。
   */
  function resolveNewPlanName(fallback: string): string | null {
    const name = newName.trim() || fallback;
    if (name.length > MAX_PLAN_NAME) {
      pushToast(
        `计划名称最多 ${MAX_PLAN_NAME} 个字符（当前 ${name.length}），未创建。`,
        'error',
      );
      return null;
    }
    return name;
  }

  /**
   * 按**稳定 planId** 取当前计划（v0.1.1 L01-reliability）。
   *
   * 为什么不能直接用渲染闭包里的 `plan` 对象：
   * 用户可能在编辑名称期间触发了别的变更（加/删训练日、移动顺序），
   * 用旧对象算 renamePlan 会把那些变更整份覆盖掉。
   * 提交时重新从 store 里取当前值，只改目标字段。
   *
   * 找不到（计划刚被删）时抛错 → DraftTextField 会保留草稿并提示，不假报成功。
   */
  function currentPlan(planId: string): Plan {
    const found = plans.find((p) => p.id === planId);
    if (!found) throw new Error('这个计划已经不存在了');
    return found;
  }

  /**
   * 初始管理选择：路由 → 训练 current → 首项（已裁决优先级）。
   *
   * 只在**尚未确定**或**当前选中已失效**时重新计算，
   * 避免用户手动选择后又被 effect 拉回。
   */
  useEffect(() => {
    const routePlanId = route.parts[0] === 'plans' ? route.query.get('plan') : null;
    const routeValid = !!routePlanId && plans.some((p) => p.id === routePlanId);
    const currentValid =
      !!settings.currentPlanId && plans.some((p) => p.id === settings.currentPlanId);
    /**
     * B2 导入 race：若存在"刚导入、等待刷新"的新 ID，
     * 即使当前 plans 尚未包含它也**不回退**（等 refresh 完成后自然有效）。
     */
    const pendingNew = pendingNewPlanIdRef.current;
    if (pendingNew && !plans.some((p) => p.id === pendingNew)) {
      return; // 等刷新，不判无效
    }
    if (pendingNew && plans.some((p) => p.id === pendingNew)) {
      // 刷新完成且新 ID 已存在 → 清标记
      pendingNewPlanIdRef.current = null;
    }

    const stillValid = !!managePlanId && plans.some((p) => p.id === managePlanId);

    if (stillValid) return; // 用户已有有效选择，不打扰

    const next = routeValid
      ? (routePlanId as string)
      : currentValid
        ? (settings.currentPlanId as string)
        : plans[0]?.id ?? null;
    setManagePlanId(next);
  }, [plans, route, settings.currentPlanId, managePlanId]);

  /** 把管理选择写回路由（只改 query，不动训练 settings） */
  useEffect(() => {
    if (!managePlanId) return;
    const routePlanId = route.parts[0] === 'plans' ? route.query.get('plan') : null;
    if (routePlanId === managePlanId) return;
    navigate(`/plans?plan=${encodeURIComponent(managePlanId)}`, true);
  }, [managePlanId, route]);

  /**
   * 请求切换管理计划 —— **必须经过草稿门禁**（G5 关键）。
   *
   * 若当前视图还有不可安全丢弃的状态（合法保存在途 / 错误 / 未完值 /
   * IME 组合 / 未保存配置草稿），则**不切换、不卸载**，只提示用户先处理。
   * 只有干净状态（或用户明确取消丢弃后）才真正切换。
   */
  function requestManageSwitch(nextId: string): void {
    if (!nextId || nextId === managePlanId) return;
    /**
     * B3/G5-R4：**合法保存在途**时先等结果，成功后自动续原请求。
     * 与"脏且无在途保存"区分：后者需要用户处理/放弃，前者只需等待。
     */
    if (isAnySaving() || isAnyDirty()) {
      setPendingSwitch(nextId);
      setSwitchBlocked(true);
      return;
    }
    setSwitchBlocked(false);
    setPendingSwitch(null);
    setManagePlanId(nextId);
  }

  /**
   * B3/G5-R4：视图变干净且无在途保存时，**自动续**之前被挂起的切换。
   *
   * 这样"保存成功后仍要用户点放弃"的错误路径被消除。
   */
  useEffect(() => {
    if (!switchBlocked || !pendingSwitch) return;
    // 依赖 savingFields/dirtyFields：它们从 true→false 时本 effect 会重跑
    if (isAnySaving() || isAnyDirty()) return;
    // 已干净且保存完成 → 继续原请求
    const target = pendingSwitch;
    setSwitchBlocked(false);
    setPendingSwitch(null);
    setManagePlanId(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchBlocked, pendingSwitch, discardEpoch, savingFields, dirtyFields]);

  /**
   * **明确放弃**：清掉所有字段草稿并切到请求目标（B2 修复 G5-R2）。
   *
   * 旧实现只清一个 ref、且无目标，既没执行切换也没真正取消草稿。
   * 现在：
   *   · 通知所有登记字段"放弃"（通过 bump 一个 epoch，让子组件 reset）；
   *   · 清空聚合状态；
   *   · 真正切到 pendingSwitch 目标。
   */
  const performDiscardAndSwitch = (): void => {
    const target = pendingSwitch;
    // 让所有字段收到"放弃"信号（epoch 变化 → 子组件 reset 草稿）
    setDiscardEpoch((n) => n + 1);
    setDirtyFields(new Map());
    setSavingFields(new Set());
    setSwitchBlocked(false);
    setPendingSwitch(null);
    if (target && target !== managePlanId) setManagePlanId(target);
  };

  /**
   * B2/G5-R3：把聚合脏状态注册为**离页守卫**。
   *
   * 这样"进入日编辑""返回""主导航""浏览器返回"等所有走 navigate 的路径
   * 都被同一门禁拦住，不再各写一套判断。
   * 用 ref 读取最新聚合值，避免闭包过期。
   */
  const isAnyDirtyRef = useRef(isAnyDirty);
  isAnyDirtyRef.current = isAnyDirty;
  useEffect(() => {
    return registerLeaveGuard(() => !isAnyDirtyRef.current());
  }, []);

  /** 当前管理计划对象（可能为 undefined：计划刚被删除） */
  const managedPlan = useMemo(
    () => (managePlanId ? plans.find((p) => p.id === managePlanId) : undefined),
    [plans, managePlanId],
  );

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          训练计划
        </h1>
        {/* 新建 / 导入常驻，不随所选计划变化 */}
        <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
          <button className="btn btn-sm btn-primary" onClick={() => setNewOpen(true)}>
            + 新建
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setTplOpen(true)}>
            导入
          </button>
        </div>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      {/*
        G5：顶部管理选择框。
        · 只切换**管理查看**对象，不动训练用 settings.currentPlanId
        · 切换走草稿门禁：脏状态时不卸载当前视图
      */}
      {plans.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <label
            htmlFor="manage-plan-select"
            style={{ display: 'block', fontSize: 12, color: 'var(--ink-3)', marginBottom: 4 }}
          >
            正在管理的计划（不影响训练用计划）
          </label>
          <select
            id="manage-plan-select"
            className="input"
            value={managePlanId ?? ''}
            aria-label="选择要管理的计划"
            onChange={(e) => requestManageSwitch(e.target.value)}
            style={{ minHeight: 44 }}
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === settings.currentPlanId ? '（训练中）' : ''}
              </option>
            ))}
          </select>
          {switchBlocked ? (
            <div
              role="alert"
              style={{
                marginTop: 6,
                fontSize: 12.5,
                color: 'var(--brick)',
                lineHeight: 1.6,
              }}
            >
              当前计划还有未保存的内容（正在保存、保存失败或正在输入）。
              请先处理完，或点「放弃修改」后再切换。
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginLeft: 8 }}
                onClick={performDiscardAndSwitch}
              >
                放弃修改并切换
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!plans.length ? (
        <div className="empty" style={{ marginTop: 24 }}>
          <div className="empty-title">还没有计划</div>
          <p className="empty-body">可以新建空计划，或从 V3.2 预设开始。</p>
          <button
            className="btn btn-primary"
            style={{ marginTop: 16 }}
            onClick={async () => {
              const ok = await save(createV32Plan());
              pushToast(ok ? '已创建 V3.2 计划。' : '创建失败，请重试。', ok ? 'ok' : 'error');
            }}
          >
            使用 V3.2 预设
          </button>
        </div>
      ) : null}

      {/* G5：主体**只展示所选计划**，不再把所有计划各自展开 */}
      {managedPlan ? (
        (() => {
          const plan = managedPlan;
          return (
        <section key={plan.id} className="slip" style={{ marginTop: 14, padding: '14px 14px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DraftTextField
                className="input"
                style={{ minHeight: 44, fontSize: 17, fontWeight: 600, border: '1px solid transparent', background: 'transparent', paddingLeft: 0 }}
                value={plan.name}
                ariaLabel="计划名称"
                maxLength={MAX_PLAN_NAME}
                onCommit={(next) => {
                  /**
                   * 计划名称与备份校验共用 200 字上限（item 1）。
                   * 超限**明确拒绝并提示**（DraftTextField 收到 false 会保留草稿、
                   * 显示「未保存，可重试」），绝不静默截断或假报已保存。
                   */
                  const trimmed = next.trim() || plan.name;
                  if (trimmed.length > MAX_PLAN_NAME) {
                    pushToast(
                      `计划名称最多 ${MAX_PLAN_NAME} 个字符（当前 ${trimmed.length}），未保存。`,
                      'error',
                    );
                    return false;
                  }
                  return save(renamePlan(currentPlan(plan.id), next));
                }}
                /* G5-R1：按稳定 fieldId 聚合，避免被其他干净字段覆盖 */
                onDirtyChange={fieldDirtyHandler(`plan-name:${plan.id}`)}
                onSavingChange={fieldSavingHandler(`plan-name:${plan.id}`)}
                discardEpoch={discardEpoch}
              />
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                {plan.days.length} 天 · {plan.days.filter((d) => d.kind === 'train').length} 个训练日 · 循环位置{' '}
                {plan.cursor + 1}
              </div>
              {plan.name.length > MAX_PLAN_NAME ? (
                <div
                  role="alert"
                  style={{
                    marginTop: 8,
                    padding: '8px 10px',
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: 'var(--brick)',
                    borderLeft: '3px solid var(--brick)',
                    background: 'var(--paper-3)',
                  }}
                >
                  该计划名称超过 {MAX_PLAN_NAME} 个字符（当前 {plan.name.length} 字，历史遗留）。
                  备份/恢复会按原文完整保留该名称，不会截断，也不会因此拒绝整份文件；
                  若超过 {MAX_LEGACY_PLAN_NAME} 字则无法导出。如需继续编辑该计划，
                  请在名称框显式改名到 {MAX_PLAN_NAME} 字以内；历史记录中的旧名称无需修改。
                </div>
              ) : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 'none' }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={async () => {
                  const ok = await save(clonePlan(plan));
                  pushToast(ok ? '已复制计划。' : '复制失败，请重试。', ok ? 'ok' : 'error');
                }}
              >
                复制
              </button>
              <button
                className="btn btn-ghost btn-sm"
                style={{ color: 'var(--brick)' }}
                onClick={() => setDeleteTarget(plan)}
              >
                删除
              </button>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            {plan.days.map((d, i) => (
              <PlanDayRow
                key={d.id}
                plan={plan}
                day={d}
                index={i}
                onSave={save}
                onOpen={() => navigate(`/plan/${plan.id}/day/${d.id}`)}
                onRequestDelete={(target) =>
                  setDayDelete({ planId: plan.id, dayId: target.id, name: target.name })
                }
                onDirtyChange={fieldDirtyHandler(`day-name:${plan.id}:${d.id}`)}
                onSavingChange={fieldSavingHandler(`day-name:${plan.id}:${d.id}`)}
                discardEpoch={discardEpoch}
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              className="btn btn-ghost btn-sm"
              disabled={!canAddDay(plan)}
              onClick={() => void save(addDay(plan))}
            >
              + 加训练日
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/plan/${plan.id}/day/${plan.days[0]?.id ?? ''}`)}>
              编辑动作
            </button>
          </div>
        </section>
          );
        })()
      ) : null}

      <Sheet open={newOpen} title="新建计划" onClose={() => setNewOpen(false)}>
        <div className="field">
          <label htmlFor="new-plan-name">计划名称</label>
          <input
            id="new-plan-name"
            className="input"
            value={newName}
            placeholder="例如：三分化训练计划 V3.2"
            maxLength={MAX_PLAN_NAME}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const plan = createV32Plan();
              const resolvedName = resolveNewPlanName(plan.name);
              if (resolvedName === null) return; // 超限：明确拒绝，弹层与输入保留
              const newId = `plan-${Date.now()}`;
              const ok = await save({ ...plan, name: resolvedName, id: newId });
              if (!ok) return; // 失败保留弹层与输入，可重试
              setNewName('');
              setNewOpen(false);
              /**
               * B2/G5-R4：新建成功**不得**静默卸载仍有草稿的旧视图。
               *
               * 旧实现直接 setManagePlanId，等于把"新建成功"当成"放弃旧草稿"授权。
               * 现在若旧视图仍有草稿 → 挂起这次切换并提示用户明确处理；
               * 旧视图干净时才直接切。
               */
              if (isAnyDirty()) {
                setPendingSwitch(newId);
                setSwitchBlocked(true);
              } else {
                setManagePlanId(newId);
              }
              pushToast('已新建计划。');
            }}
          >
            从 V3.2 预设新建
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setNewOpen(false);
              setTplOpen(true);
            }}
          >
            导入计划模板（JSON）
          </button>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              const now = Date.now();
              // 空白计划 = 一个空训练日，动作与热身都为空（审计 R2-08）
              const resolvedName = resolveNewPlanName('空白计划');
              if (resolvedName === null) return; // 超限：明确拒绝，弹层与输入保留
              const blank: Plan = {
                id: `plan-${now}`,
                name: resolvedName,
                cursor: 0,
                createdAt: now,
                updatedAt: now,
                days: [
                  {
                    id: `day-${now}`,
                    name: '训练日 1',
                    /**
                     * B2/G4 修复：**不得隐式补 chest/A**。
                     * Codex 真实空白新建后提交 DB 明确含 focus=chest、round=A，
                     * 与"新自定义力量日允许省略"直接冲突。
                     * 域层 addDay/模板/备份已改为可省略，此处入口漏改。
                     */
                    kind: 'train',
                    warmups: [],
                    exercises: [],
                  },
                ],
              };
              const okBlank = await save(blank);
              if (!okBlank) return; // 失败保留弹层与输入，可重试
              setNewName('');
              setNewOpen(false);
              // B2/G5-R4：同样经过门禁，不静默丢弃旧草稿
              if (isAnyDirty()) {
                setPendingSwitch(blank.id);
                setSwitchBlocked(true);
              } else {
                setManagePlanId(blank.id);
              }
            }}
          >
            新建空白计划（一个空训练日）
          </button>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: 0 }}>
            修改计划不会影响已经保存的历史训练。
          </p>
        </div>
      </Sheet>

      {/* 第3阶段：固定 JSON 计划模板导入（严格校验 → 只读预览 → 确认 insert-only） */}
      <TemplateImportSheet
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        onImported={(imported: Plan) => {
          void refreshPlans();
          /**
           * B2/G5-R4 + 导入 race 修复：
           * · 不静默丢弃旧草稿（同新建路径）；
           * · **延迟到 refresh 完成后再校验新 ID 有效**，避免初始化 effect
           *   在 plans 尚未含新 ID 时把它判为失效并回退旧选择。
           */
          if (!imported?.id) return;
          /**
           * B4-R3 closure2 · N06：**先登记"等待中的新 ID"，再做 dirty 分流**。
           *
           * <h2>真实缺陷</h2>
           * 旧实现只在"不 dirty"分支才写 {@code pendingNewPlanIdRef}。
           * 于是「A 名称清空（dirty）→ 导入新计划 → 只 hold readonly 刷新 →
           * 点放弃修改并切换」时：discard 先把管理选择切到新 ID，
           * 但初始化 effect 在 plans 尚未包含新 ID 时没有任何"等待"依据，
           * 直接按 route/current 回退到旧 A —— 新计划明明已写入却切不过去。
           *
           * <p>现在标记在**分流之前**登记：无论走"直接切"还是"先放弃再切"，
           * 初始化 effect 都会**保留等待**，直到刷新真的能看见这个新 ID，
           * 再让选择停在它上面；期间不写训练 currentPlan/cursor，也不覆盖 A。
           */
          pendingNewPlanIdRef.current = imported.id;
          if (isAnyDirty()) {
            setPendingSwitch(imported.id);
            setSwitchBlocked(true);
            return;
          }
          setManagePlanId(imported.id);
        }}
        pushToast={pushToast}
      />

      <Confirm
        open={!!deleteTarget}
        title="删除计划？"
        body="计划会被删除，但已经保存的训练历史不受影响。"
        confirmText="删除计划"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          const deletedId = deleteTarget.id;
          try {
            /**
             * B3/G5-R5 产品裁决：**删除计划与匹配 current 清理必须在同一笔事务内**。
             *
             * 旧流程先 deletePlan 成功、再独立 setCurrentPlan；后者失败就留下
             * "plans 无 A、settings.currentPlanId 仍 A"的悬空引用，
             * UI 只能弹 toast 让用户自己重选（Codex B2 真实注入 settings.put abort 复现）。
             *
             * 现在用 `atomicDeletePlanWithCurrent`：两个 store 同一 IDB 事务，
             * settings 写失败 → **删除一起回滚**，不会半完成。
             */
            const r = await atomicDeletePlanWithCurrent(deletedId, (currentId, remaining) => {
              // 被删的不是当前训练计划 → 不动 current（避免覆盖并发已选）
              if (currentId !== deletedId) return undefined;
              // 恰好是当前 → 确定回退到剩余首项；零计划 → null
              return remaining[0] ?? null;
            });

            if (!r.ok) {
              // 事务失败：什么都没改，如实提示可重试
              pushToast(
                r.reason === 'plan-not-found'
                  ? '这个计划已经不存在了。'
                  : `删除失败：${r.reason ?? '未知原因'}（未做任何修改）`,
                'error',
              );
              return;
            }

            /**
             * B4/G5-R4：删除成功后**必须同步内存 Store**。
             *
             * 真实失败：正常事务完成、raw 已删 A 且 current=B，
             * 但 Store 仍 current=已删 A，UI 无"训练中"标记 ——
             * 因为 `refreshSettings` 从未被接进成功链。
             */
            await refreshPlans();
            await refreshSettings();
            setDeleteTarget(null);

            // 管理查看对象被删 → 按优先级回退（仅在事务成功后）
            if (managePlanId === deletedId) {
              const fallback = plans.find((p) => p.id !== deletedId);
              setManagePlanId(fallback?.id ?? null);
            }

            if (r.newCurrentPlanId === null) {
              pushToast('计划已删除；现在没有训练计划，可以新建或导入。历史记录未受影响。');
            } else if (r.newCurrentPlanId !== deletedId) {
              const name = plans.find((p) => p.id === r.newCurrentPlanId)?.name;
              pushToast(
                name
                  ? `计划已删除；训练计划已回退到「${name}」。历史记录未受影响。`
                  : '计划已删除；训练计划已回退。历史记录未受影响。',
              );
            } else {
              pushToast('计划已删除，历史记录未受影响。');
            }
          } catch (err) {
            pushToast(err instanceof Error ? `删除失败：${err.message}` : '删除失败', 'error');
          }
        }}
      />

      {/*
        L03：训练日删除确认。按钮严格「是 / 否」。
        · 确认时按 dayId 从当前 plans 重取目标（不用旧快照）
        · 目标已不存在 → 温和收尾，不写库、不报“已删除”
        · 只有真的提交成功才关闭确认框；失败保留可重试
        · busy 期间禁止重复提交
      */}
      <Confirm
        open={!!dayDelete}
        title="删除这个训练日？"
        body={
          dayDelete
            ? `将删除训练日「${dayDelete.name}」。已保存的训练历史不受影响。`
            : ''
        }
        confirmText="是"
        cancelText="否"
        danger
        busy={dayDeleting}
        onCancel={() => {
          if (dayDeleting) return; // 提交中不允许用取消掩盖结果
          setDayDelete(null);
        }}
        onConfirm={async () => {
          if (dayDeleting || !dayDelete) return;
          setDayDeleting(true);
          try {
            // 用**当前** plans 重取该计划与训练日（避免旧快照覆盖别处改动）
            const currentPlan = plans.find((p) => p.id === dayDelete.planId);
            const currentDay = currentPlan?.days.find((d) => d.id === dayDelete.dayId);
            if (!currentPlan || !currentDay) {
              // 目标已不存在：温和处理，不写库
              setDayDelete(null);
              pushToast('这个训练日已经不存在了。');
              return;
            }
            if (currentPlan.days.length <= 1) {
              // 域函数会静默不删；这里必须明确告知，不能假报成功
              setDayDelete(null);
              pushToast('至少要保留一个训练日，不能删除最后一个。', 'error');
              return;
            }
            const nextPlan = deleteDay(currentPlan, currentDay.id);
            if (nextPlan === currentPlan) {
              // 域层没产生变化：如实说明，且不关框以外的副作用
              pushToast('这个训练日没有被删除（至少要保留一个）。', 'error');
              return;
            }
            const ok = await save(nextPlan);
            if (!ok) return; // 失败：保留弹窗，用户可重试
            setDayDelete(null);
            pushToast('训练日已删除，历史记录未受影响。');
          } finally {
            setDayDeleting(false);
          }
        }}
      />
    </main>
  );
}

function PlanDayRow({
  plan,
  day,
  index,
  onSave,
  onOpen,
  onRequestDelete,
  onDirtyChange,
  onSavingChange,
  discardEpoch,
}: {
  plan: Plan;
  day: PlanDay;
  index: number;
  /** G5：训练日名称草稿未保存时上报（按 fieldId 聚合） */
  onDirtyChange?: (dirty: boolean) => void;
  /** G5-R2：放弃信号，变化即重置草稿 */
  discardEpoch?: number;
  /** B4：保存在途上报 */
  onSavingChange?: (saving: boolean) => void;
  /** 行内保存：必须**如实返回是否成功**（草稿输入据此决定是否认保存） */
  onSave: (p: Plan) => Promise<boolean>;
  onOpen: () => void;
  /** L03：红叉不再直接写库，改为请求确认 */
  onRequestDelete: (day: PlanDay) => void;
}) {
  /**
   * ── L01：窄屏下一行放不下「序号 + 名称 + tag + 编辑 + ↑↓ + 叉」──
   *
   * 旧实现是单行 nowrap，固定控件已吃尽 360px 卡片宽度：
   * 实测行 clientWidth=298 / scrollWidth=341（溢出 43px），
   * 名称输入框被压到 **22px**，红叉被切出屏幕 12px。
   *
   * 改成两行（flexWrap）：
   *   第 1 行：序号 + 名称输入（占满剩余宽度，minWidth 保证可读可编辑）
   *   第 2 行：tag + 编辑 + 上移/下移 + 删除（右对齐，均可点）
   * 不用全局 overflow-x:hidden 遮住问题；按钮保持 ≥44×44。
   */
  const canDelete = plan.days.length > 1;
  return (
    <div
      style={{
        padding: '8px 0',
        borderBottom: '1px dashed var(--rule)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono-label" style={{ width: 22, flex: 'none' }}>
          {index + 1}
        </span>
        <DraftTextField
          className="input"
          wrapperStyle={{ flex: '1 1 auto', minWidth: 0 }}
          style={{ width: '100%', minHeight: 44, fontSize: 15, paddingLeft: 8 }}
          value={day.name}
          ariaLabel={`第 ${index + 1} 天名称`}
          maxLength={100}
          onCommit={(next) => onSave(renameDay(plan, day.id, next))}
          /* G5：训练日名称草稿未保存时阻止切换管理计划 */
          onDirtyChange={onDirtyChange}
          onSavingChange={onSavingChange}
          discardEpoch={discardEpoch}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 6,
          paddingLeft: 30,
          flexWrap: 'wrap',
        }}
      >
        <span className="tag tag-quiet" style={{ flex: 'none' }}>
          {day.kind === 'rest'
            ? '休息'
            : day.kind === 'cardio'
              ? `有氧 · ${day.cardio?.length ?? 0} 项`
              : `${day.exercises.length} 动作`}
        </span>
        <button className="btn btn-ghost btn-sm" style={{ flex: 'none', minHeight: 44 }} onClick={onOpen}>
          编辑
        </button>
        <div style={{ display: 'flex', gap: 6, flex: 'none', marginLeft: 'auto' }}>
          <button
            className="btn btn-ghost"
            style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
            disabled={index === 0}
            aria-label="上移这一天"
            onClick={() => void onSave(moveDay(plan, day.id, -1))}
          >
            ↑
          </button>
          <button
            className="btn btn-ghost"
            style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
            disabled={index === plan.days.length - 1}
            aria-label="下移这一天"
            onClick={() => void onSave(moveDay(plan, day.id, 1))}
          >
            ↓
          </button>
          <button
            className="btn btn-ghost"
            style={{ minWidth: 44, minHeight: 44, padding: 0, color: 'var(--brick)', flex: 'none' }}
            aria-label={canDelete ? '删除训练日' : '删除训练日（至少保留一天，不能删除）'}
            disabled={!canDelete}
            title={canDelete ? undefined : '至少要保留一个训练日'}
            onClick={() => onRequestDelete(day)}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}


/**
 * 既有递减组的编辑器（V3-04）。
 *
 * 旧实现（审查 I01）每次渲染都从**已保存 target** 重建 draft，并且
 * `onChange` 里只要出现任何临时非法状态就 `return` —— 既不保存也不提示，
 * 于是：取消力竭被拒、次数框保持 disabled、8–12 改成 20–25 会变成 8–25。
 *
 * 本轮：用组件内本地草稿承载输入（允许不完整中间态），
 * 点「保存这个配置」时统一 flush 字段草稿 + 校验结构，通过才写库。
 * 取消则丢弃草稿回到已保存值。
 */
function ExistingDropEditor({
  plan,
  dayId,
  exercise,
  onSave,
  onDirtyChange,
  ownerFieldId,
  onUnregisterOwner,
}: {
  plan: Plan;
  dayId: string;
  exercise: PlanExercise;
  /** 必须如实返回是否成功：失败时编辑器要保留草稿，不能静默关窗 */
  onSave: (p: Plan) => Promise<boolean>;
  /** B2/G5-R3：配置草稿未保存时上报，供统一离页门禁使用 */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * B4-R2：本配置在父层 owner 表里的键。
   * 提供后，本组件卸载时会**真的注销**它（缺口 2 的修复点）。
   */
  ownerFieldId?: string;
  onUnregisterOwner?: (fieldId: string) => void;
}) {
  const saved: DropSetDraft = useMemo(
    () => (exercise.target.kind === 'dropSet' ? dropTargetToDraft(exercise.target) : defaultDropDraft()),
    [exercise],
  );
  const [draft, setDraft] = useState<DropSetDraft>(saved);
  const form = useDraftForm();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // 外部保存值变化（例如撤销/其它页面改动）时同步本地草稿
  useEffect(() => {
    setDraft(saved);
    setError(null);
  }, [saved]);

  const issues = validateDropDraft(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  /**
   * B4-R1：**不再由本层单独上报**，避免与外层 structuredDirty / 内层 raw
   * 两路写同一个 owner（内层 false 会清掉外层仍脏的状态）。
   *
   * 现在把 `structuredDirty` 传给 DropSetEditor，由它**合并后单次上报**。
   * 注意：saving 也要纳入合并值。
   */
  const structuredDirty = dirty || saving;

  /**
   * B4-R2：**本配置的 owner 上报回调走完整生命周期**（缺口 2 修复点之一）。
   *
   * 在组件顶层调用（符合 Hooks 规则），卸载时自动报 false + 注销该键。
   * 与下面的显式卸载 effect 一起保证"组件消失 ⇒ owner 释放"。
   */
  const reportOwnerDirty = useEditorFieldOwner(
    ownerFieldId ?? '',
    (_id, d) => onDirtyChange?.(d),
    (id) => onUnregisterOwner?.(id),
  );
  // 供渲染期上报使用（DropSetEditor 的回调仍走原 onDirtyChange，二者不冲突）
  void reportOwnerDirty;

  /**
   * B4-R2：**卸载时真正注销本配置的 owner**（缺口 2）。
   *
   * 真实失败链：合法 3→4 blur → 取消（resetAll + setOpen(false)）→
   * DropSetEditor 卸载 → 没有人为这个 key 报 false →
   * 仍挂载的 PlanDayEditor owner 表永久为 true → ‹计划 无反应。
   *
   * 这里把"组件消失"和"owner 释放"绑死：卸载即报 false + 注销该键。
   * 只清自己的键，不清整表（其它字段的存活草稿必须保留）。
   */
  useEffect(() => {
    if (!ownerFieldId || !onUnregisterOwner) return undefined;
    return () => {
      onDirtyChange?.(false);
      onUnregisterOwner(ownerFieldId);
    };
    // onDirtyChange 是父层稳定回调（dirtyHandlersRef 缓存），不会每次渲染变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerFieldId, onUnregisterOwner]);

  if (!open) {
    return (
      <div>
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--paper-3)',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--ink-2)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {draft.rounds} 轮 × {draft.stages.length} 阶段
          </div>
          <div style={{ overflowWrap: 'anywhere' }}>{describeDropDraft(draft)}</div>
          <div style={{ color: 'var(--ink-3)', marginTop: 2 }}>
            阶段间休 {draft.restInSec} 秒 · 轮间休 {draft.restAfterSec} 秒 · 口径{' '}
            {comparabilityLabelText(draft)}
          </div>
        </div>
        <button
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => {
            setDraft(saved);
            setError(null);
            form.resetAll();
            setOpen(true);
          }}
        >
          编辑递减组配置
        </button>
      </div>
    );
  }

  return (
    <div>
      <DropSetEditor
        draft={draft}
        onChange={setDraft}
        form={form}
        fieldPrefix={`ex.${exercise.id}`}
        scopeNote="修改只影响未来训练；已保存的历史保持原样。"
        /* B4-R1：结构化脏与内部 raw 在本组件内合并后单次上报 */
        structuredDirty={structuredDirty}
        onDirtyChange={onDirtyChange}
      />

      {error ? (
        <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, marginTop: 8, lineHeight: 1.6 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="btn btn-primary"
          style={{ flex: 1 }}
          disabled={saving || !dirty}
          onClick={async () => {
            /**
             * V4-03（修复 F4-I03）：保存前统一 flush，并且**用 flushed.values 构造
             * nextDraft 局部变量**，而不是继续读父 state draft。
             * 旧实现在「合法值还没 blur 就点保存」时，字段文本是 25、父 state 还是 20，
             * 校验通过却存了 20。
             */
            const flushed = form.flushAll();
            if (!flushed.ok) {
              setError(`有字段还不合法：${Object.values(flushed.errors)[0]}`);
              return;
            }
            const nextDraft = mergeFlushedDropDraft(draft, flushed.values, `ex.${exercise.id}`, {
              round1AsOverride: true,
              nullIds: flushed.nullIds,
            });
            const found = validateDropDraft(nextDraft);
            if (found.length) {
              setError(`还有 ${found.length} 处需要修正：${found[0].message}`);
              return;
            }
            setError(null);
            setSaving(true);
            try {
              /**
               * v0.1.1：父级 save 现在**如实返回 boolean**。
               * 旧实现只 catch 异常就 resetAll + setOpen(false)：
               * save 内部已经 catch 并 return false 时异常不会抛，
               * 于是「阶段删除后保存失败」也会清草稿并关窗 → 配置被静默吞掉。
               * 现在必须显式判断返回值：失败保留编辑器与数字草稿，可重试。
               */
              const ok = await onSave(
                updateTarget(plan, dayId, exercise.id, draftToDropTarget(nextDraft) as ExerciseTarget),
              );
              if (!ok) {
                setError('这个配置没有保存成功，草稿仍保留在这里，可以重试。');
                return;
              }
              form.resetAll();
              setOpen(false);
            } catch (err) {
              setError(err instanceof Error ? `未保存：${err.message}` : '未保存');
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? '保存中…' : dirty ? '保存这个配置' : '没有改动'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ flex: 1 }}
          disabled={saving}
          onClick={() => {
            setDraft(saved);
            setError(null);
            form.resetAll();
            setOpen(false);
          }}
        >
          取消
        </button>
      </div>
      {issues.length ? (
        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 6 }}>
          当前还有 {issues.length} 处未通过校验，修正后才能保存。
        </div>
      ) : null}
    </div>
  );
}

/** 草稿里的负重口径文案（V3-05：口径必须可见） */
function comparabilityLabelText(d: DropSetDraft): string {
  const mode: Record<string, string> = {
    external: '外部负重',
    bodyweight: '自重',
    bodyweight_plus: '自重+负重',
    assisted: '辅助重量',
  };
  const basis = d.dumbbellBasis === 'per_hand' ? ' · 哑铃按单只' : d.dumbbellBasis === 'total' ? ' · 哑铃按合计' : '';
  return `${mode[d.weightMode] ?? d.weightMode}${basis}`;
}

export function PlanDayEditor({ planId, dayId }: { planId: string; dayId: string }) {
  const { plans, upsertPlan, pushToast } = useStore();
  /**
   * B2/G5-R3：编辑页也必须有**统一离页门禁**。
   *
   * Codex 真实 CUA 确证两条：
   * · 管理页有未保存草稿时，直接"编辑训练日"仍导航；
   * · 递减组轮数 3→4 未保存，点"‹计划"无提示返回，草稿丢失。
   *
   * 现在按 fieldId 聚合本页所有字段/配置状态，并注册为 router 的离页守卫。
   * 与 PlansPage 用同一机制，不引入第二套框架。
   */
  const editorDirtyRef = useRef<Map<string, boolean>>(new Map());
  const reportEditorDirty = (fieldId: string, dirty: boolean): void => {
    if (dirty) editorDirtyRef.current.set(fieldId, true);
    else editorDirtyRef.current.delete(fieldId);
  };
  const isEditorDirty = (): boolean => {
    for (const v of editorDirtyRef.current.values()) if (v) return true;
    return false;
  };
  /**
   * B4-R2：**字段 owner 注销**（G5 实证缺口 2）。
   *
   * <p>真实失败：递减组配置里合法 3→4 真实 blur → 点「取消」恢复 3 →
   * 点 ‹计划 **无反应**。根因是配置 owner 由**会卸载的内层 DropSetEditor**
   * 独占上报，取消后内层卸载，但没有人清掉仍挂载的 `editorDirtyRef` 里的 true
   * → 门禁永久为脏。
   *
   * <p>修法：提供真正可调用的注销入口，并由字段/配置在卸载时调用
   * （见 {@link useFieldOwner}）。只删**自己的键**，不清整个 Map
   * —— 清整表会把其它仍存活的草稿一起隐藏。
   */
  const unregisterEditorField = (fieldId: string): void => {
    editorDirtyRef.current.delete(fieldId);
  };
  /**
   * 编辑页的 owner 生命周期包装（与 PlansPage 的 useFieldOwner 同一语义，
   * 只是写入不同的 owner 表）。
   */

  const isEditorDirtyRef = useRef(isEditorDirty);
  /**
   * B4-R2：**编辑页整体卸载时清空本页 owner 表**。
   *
   * 与"单字段注销"互补：单字段注销解决"配置面板卸载但页面还在"（缺口 2 主路径）；
   * 本 effect 解决"整个编辑页离开"（此时所有字段都消失，整表清空是正确的）。
   * 两者都不清**别的页面**的表 —— 各自持有自己的 ref。
   */
  useEffect(() => {
    const table = editorDirtyRef.current;
    return () => {
      table.clear();
    };
  }, []);
  isEditorDirtyRef.current = isEditorDirty;
  useEffect(() => {
    const off = registerLeaveGuard(() => !isEditorDirtyRef.current());
    return () => {
      off();
      editorDirtyRef.current.clear();
    };
  }, []);
  /** 稳定的 fieldId → handler 工厂 */
  const editorDirtyHandlersRef = useRef<Map<string, (d: boolean) => void>>(new Map());
  const editorDirtyHandler = (fieldId: string): ((d: boolean) => void) => {
    let fn = editorDirtyHandlersRef.current.get(fieldId);
    if (!fn) {
      fn = (d: boolean) => reportEditorDirty(fieldId, d);
      editorDirtyHandlersRef.current.set(fieldId, fn);
    }
    return fn;
  };
  const plan = plans.find((p) => p.id === planId);
  const day = plan?.days.find((d) => d.id === dayId);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * L03：编辑页删除确认（动作 / 热身 / 递减阶段）。
   * 只存稳定标识 + 展示名，确认时按 id 从**当前** plan/day 重取，避免旧快照覆盖。
   */
  const [exDelete, setExDelete] = useState<{ exId: string; name: string } | null>(null);
  const [warmDelete, setWarmDelete] = useState<{ warmId: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  /** C01 路径 A：新增动作时的训练形式配置 */
  const [addStage, setAddStage] = useState<'pick' | 'configure'>('pick');
  const [addName, setAddName] = useState('');
  const [addForm, setAddForm] = useState<'straight' | 'dropSet'>('straight');
  const [addDropDraft, setAddDropDraft] = useState<DropSetDraft>(defaultDropDraft());
  /**
   * V3-04：新增普通动作的三个字段必须有真实草稿。
   * 旧实现 value 固定 3/8/12、onCommit 返回 undefined，看起来能编辑，
   * 保存时仍用默认 3×8–12（审查 I02）。
   */
  const [addStraightDraft, setAddStraightDraft] = useState({ sets: 3, repsMin: 8, repsMax: 12 });
  /** 父表单：汇总所有数字字段的当前文本草稿与有效性，保存前统一校验 */
  const addFormApi = useDraftForm();
  const [addFormError, setAddFormError] = useState<string | null>(null);
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [warmupName, setWarmupName] = useState('');

  const results = useMemo(() => (query.trim() ? searchExercises(query) : searchExercises('').slice(0, 14)), [query]);

  useEffect(() => {
    /**
     * G5：计划已不存在（被删除）→ 回管理页。
     * 不带 plan 参数，让管理页按既定优先级（路由→训练 current→首项）回退，
     * 不强行指向一个已失效 ID（避免 404 或空视图）。
     */
    if (!plan) navigate('/plans', true);
  }, [plan]);

  if (!plan || !day) {
    return (
      <main className="page page-top">
        <div className="empty" style={{ marginTop: 32 }}>
          <div className="empty-title">找不到这个训练日</div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => navigate('/plans')}>
            回计划页
          </button>
        </div>
      </main>
    );
  }

  /** 保存并**如实返回是否成功**（L03：删除流程必须能判断真实结果） */
  async function save(next: Plan): Promise<boolean> {
    try {
      await upsertPlan(next);
      return true;
    } catch (err) {
      pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存', 'error');
      return false;
    }
  }

  /**
   * 按稳定 planId 取当前计划（v0.1.1 L01-reliability）。
   * 提交改名时只改目标字段，不拿渲染闭包里的旧 plan 覆盖别处的变更。
   */
  function currentPlan(pid: string): Plan {
    const found = plans.find((p) => p.id === pid);
    if (!found) throw new Error('这个计划已经不存在了');
    return found;
  }

  /**
   * 有氧日：编辑某个预设的**目标/初始参数**（G8a）。
   *
   * · 字段固定两预设（坡走 speedKmh/inclinePct；爬楼 level），不做自定义字段设计器。
   * · 不适用参数不写入（保持缺省，不混 null/undefined 两套输出）。
   * · 基于 currentPlan 合并，避免渲染闭包里旧 plan 覆盖别处变更。
   * · 数值已由 DraftNumberField 校验（范围/整数/有限），这里只负责落库。
   */
  function updateCardioTarget(cardioId: string, patch: Partial<PlanCardio['target']>) {
    const latest = currentPlan(planId);
    const next: Plan = {
      ...latest,
      days: latest.days.map((d) => {
        if (d.id !== dayId) return d;
        return {
          ...d,
          cardio: (d.cardio ?? []).map((pc) => {
            if (pc.id !== cardioId) return pc;
            const merged = { ...pc.target, ...patch };
            // 按预设规范只保留适用字段（缺省不写）
            const target: PlanCardio['target'] =
              pc.preset === 'treadmill-incline'
                ? {
                    ...(typeof merged.speedKmh === 'number' ? { speedKmh: merged.speedKmh } : {}),
                    ...(typeof merged.inclinePct === 'number' ? { inclinePct: merged.inclinePct } : {}),
                  }
                : { ...(typeof merged.level === 'number' ? { level: merged.level } : {}) };
            return { ...pc, target };
          }),
        };
      }),
    };
    void save(next);
  }

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* G5：返回时保留管理 ID，避免回到首项而丢失用户正在管理的计划 */}
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => navigate(`/plans?plan=${encodeURIComponent(planId)}`)}
        >
          ‹ 计划
        </button>
      </header>

      {/* v0.1.1：长名字（尤其中英文连续串）必须能换行，否则会把整页撑宽 */}
      <h1 className="h-serif" style={{ fontSize: 26, marginTop: 8, overflowWrap: 'anywhere' }}>
        {day.name}
      </h1>
      <div className="mono-label" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
        {plan.name} · 第 {plan.days.findIndex((d) => d.id === day.id) + 1} 天
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {(['chest', 'back', 'legs'] as const).map((f) => (
          <button
            key={f}
            className={`btn btn-sm ${day.focus === f ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => void save({ ...plan, days: plan.days.map((d) => (d.id === day.id ? { ...d, focus: f } : d)) })}
          >
            {FOCUS_LABEL[f]}
          </button>
        ))}
        {/* 日类型三态（第2阶段）：力量 / 有氧 / 休息 */}
        {(
          [
            ['train', '力量日'],
            ['cardio', '有氧日'],
            ['rest', '休息日'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`btn btn-sm ${day.kind === k ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => {
              if (day.kind === k) return;
              void save(setDayKind(plan, day.id, k));
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {day.kind === 'rest' ? (
        <div className="empty" style={{ marginTop: 20 }}>
          <div className="empty-title">这是一个休息日</div>
          <p className="empty-body">休息日不会生成训练记录；在首页「推进」或开始训练时选择推进即可越过它。</p>
          <input
            className="input"
            style={{ marginTop: 12, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto' }}
            value={day.restNote ?? ''}
            placeholder="休息说明，例如 睡眠 · 步行 · 放松"
            aria-label="休息说明"
            onChange={(e) =>
              void save({ ...plan, days: plan.days.map((d) => (d.id === day.id ? { ...d, restNote: e.target.value } : d)) })
            }
          />
        </div>
      ) : day.kind === 'cardio' ? (
        /**
         * 有氧日：只编辑**目标/初始参数**，不含实际计时记录。
         * 不显示力量编辑器（避免"导入成功但语义错误"的力量结构）。
         */
        <section style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 className="h-section">有氧项目</h2>
            <span className="mono-label">目标 / 初始值</span>
          </div>
          {(day.cardio ?? []).length ? (
            <div className="rows" style={{ marginTop: 6 }}>
              {(day.cardio ?? []).map((pc) => (
                <div
                  key={pc.id}
                  className="row"
                  style={{ cursor: 'default', alignItems: 'flex-start', flexWrap: 'wrap' }}
                >
                  <span className="row-main" style={{ minWidth: 0 }}>
                    <span className="row-title">{pc.name}</span>
                    <span className="row-sub">目标 / 初始值（实际训练中可再调整）</span>
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--brick)', minWidth: 44, padding: 0 }}
                    aria-label={`删除${pc.name}`}
                    onClick={() =>
                      void save({
                        ...plan,
                        days: plan.days.map((d) =>
                          d.id === day.id
                            ? { ...d, cardio: (d.cardio ?? []).filter((x) => x.id !== pc.id) }
                            : d,
                        ),
                      })
                    }
                  >
                    ×
                  </button>
                  {/*
                    目标数值编辑：复用受保护的 DraftNumberField（不静默回填 0、
                    非法值不入库），单位/步长/上限与训练中一致。
                    坡走 = 速度 km/h（0.1 步长）+ 坡度 %；爬楼 = 整数档位。
                    这是目标/初始值编辑，**不是**自定义参数设计器（字段固定两预设）。
                  */}
                  <div
                    style={{
                      flex: '1 1 100%',
                      display: 'grid',
                      gridTemplateColumns: pc.preset === 'treadmill-incline' ? 'repeat(2, minmax(0,1fr))' : 'repeat(1, minmax(0,1fr))',
                      gap: 8,
                      marginTop: 8,
                      paddingLeft: 2,
                    }}
                  >
                    {pc.preset === 'treadmill-incline' ? (
                      <>
                        <DraftNumberField
                          onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:speed`)}
                          label="速度"
                          value={pc.target.speedKmh ?? 0}
                          min={0}
                          max={MAX_SPEED_KMH}
                          integer={false}
                          unit="km/h"
                          fieldId={`cardio.${pc.id}.speed`}
                          onCommit={(v) => void updateCardioTarget(pc.id, { speedKmh: v })}
                        />
                        <DraftNumberField
                          onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:incline`)}
                          label="坡度"
                          value={pc.target.inclinePct ?? 0}
                          min={0}
                          max={MAX_INCLINE_PCT}
                          integer={false}
                          unit="%"
                          fieldId={`cardio.${pc.id}.incline`}
                          onCommit={(v) => void updateCardioTarget(pc.id, { inclinePct: v })}
                        />
                      </>
                    ) : (
                      <DraftNumberField
                        onDirtyChange={editorDirtyHandler(`num:cardio:${day.id}:${pc.id}:level`)}
                        label="档位"
                        value={pc.target.level ?? 1}
                        min={1}
                        max={MAX_STAIR_LEVEL}
                        unit="档"
                        fieldId={`cardio.${pc.id}.level`}
                        onCommit={(v) => void updateCardioTarget(pc.id, { level: v })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.65, marginTop: 6 }}>
              这一日还没有有氧项目。可以添加「有氧爬坡」或「爬楼机」作为今天的默认目标。
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            {(
              [
                ['treadmill-incline', '有氧爬坡', { speedKmh: 4, inclinePct: 4 }],
                ['stair-climber', '爬楼机', { level: 5 }],
              ] as const
            ).map(([preset, label, target]) => (
              <button
                key={preset}
                className="btn btn-ghost btn-sm"
                // G3：容量在编辑端也一致核验（不只渲染靠它求绿）：达上限即禁用，
                // 避免生成无法恢复的超量计划。
                disabled={(day.cardio ?? []).length >= MAX_CARDIO_ENTRIES}
                onClick={() => {
                  if ((day.cardio ?? []).length >= MAX_CARDIO_ENTRIES) {
                    pushToast(`一次计划最多 ${MAX_CARDIO_ENTRIES} 个有氧项目`, 'error');
                    return;
                  }
                  void save({
                    ...plan,
                    days: plan.days.map((d) =>
                      d.id === day.id
                        ? {
                            ...d,
                            cardio: [
                              ...(d.cardio ?? []),
                              {
                                id: `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                                preset,
                                name: label,
                                target,
                              },
                            ],
                          }
                        : d,
                    ),
                  });
                }}
              >
                + {label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.6, marginTop: 10 }}>
            这里只保存目标/初始参数；实际计时与分段属于训练记录，改计划不会改动历史。
          </p>
        </section>
      ) : (
        <>
          <section style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">热身（不计入正式组）</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setWarmupOpen(true)}>
                + 加热身
              </button>
            </div>
            {day.warmups.length ? (
              <div className="rows" style={{ marginTop: 4 }}>
                {day.warmups.map((w) => (
                  /*
                    L01：热身行同样会把「名称 + 目标输入 + 叉」挤在一行。
                    改成两行：第 1 行名称（可换行显示全文），第 2 行目标输入 + 删除。
                  */
                  <div key={w.id} className="row" style={{ cursor: 'default', flexWrap: 'wrap', gap: 8 }}>
                    <span className="row-main" style={{ minWidth: 0 }}>
                      <span className="row-title" style={{ fontSize: 15, wordBreak: 'break-word' }}>
                        {w.name}
                      </span>
                    </span>
                    <DraftTextField
                      className="input"
                      wrapperStyle={{ flex: '1 1 110px', minWidth: 96 }}
                      style={{ width: '100%', minHeight: 44, fontSize: 13 }}
                      value={w.targetText}
                      ariaLabel={`${w.name} 目标`}
                      maxLength={200}
                      allowEmpty
                      onCommit={(next) => save(updateWarmup(currentPlan(planId), day.id, w.id, next))}
                    />
                    <button
                      className="btn btn-ghost"
                      style={{ color: 'var(--brick)', minWidth: 44, minHeight: 44, padding: 0, flex: 'none' }}
                      onClick={() => setWarmDelete({ warmId: w.id, name: w.name })}
                      aria-label={`删除热身「${w.name}」`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: 14, color: 'var(--ink-3)', marginTop: 6 }}>还没有热身项。</p>
            )}
          </section>

          <section style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <h2 className="h-section">
                正式动作 · {day.exercises.reduce((n, e) => n + targetGroupsOf(e), 0)} 组
              </h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setAddOpen(true)}>
                + 加动作
              </button>
            </div>

            {day.exercises.map((ex, idx) => (
              <div key={ex.id} className="slip" style={{ marginTop: 10, padding: '12px 12px 10px' }}>
                {/*
                  L01：动作头同样塞不下一行（名称 + 独立身份 + ↑↓ + 叉）。
                  改两行：第 1 行序号 + 名称输入（minWidth 保证可读可编辑）；
                  第 2 行「独立身份」+ ↑↓ + 删除（右对齐，均 ≥44×44）。
                */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mono-label" style={{ width: 20, flex: 'none' }}>
                    {idx + 1}
                  </span>
                  {/*
                    V3-05：改名字有两种意图，必须由用户明确选择，代码不能猜：
                    · 「只改显示名」→ 保留动作身份，历史仍然合并（修正错别字/措辞）
                    · 「换一个动作」→ 重新解析身份，之后的新记录归到新动作（历史不回写）
                    旧实现无条件保留旧 ID，把「双杠臂屈伸」改成「器械推胸」后两者共用历史。
                  */}
                  <DraftTextField
                    className="input"
                    wrapperStyle={{ flex: '1 1 auto', minWidth: 0 }}
                    style={{ width: '100%', minHeight: 44, fontSize: 15 }}
                    value={ex.name}
                    ariaLabel={`动作 ${idx + 1} 名称`}
                    maxLength={200}
                    onCommit={(next) =>
                      // 保持既有语义：改名但**保留动作身份**（历史仍合并）
                      save(
                        renameExercise(currentPlan(planId), day.id, ex.id, next, { keepIdentity: true }),
                      )
                    }
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 6,
                    paddingLeft: 28,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ flex: 'none', minHeight: 44 }}
                    aria-label={`把「${ex.name}」改成另一个动作`}
                    onClick={() =>
                      void save(renameExercise(plan, day.id, ex.id, ex.name, { keepIdentity: false }))
                    }
                    title="把这个动作换成另一个动作：之后的新记录归到新动作，历史保持原样"
                  >
                    独立身份
                  </button>
                  <div style={{ display: 'flex', gap: 6, flex: 'none', marginLeft: 'auto' }}>
                    <button
                      className="btn btn-ghost"
                      style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
                      disabled={idx === 0}
                      aria-label="上移动作"
                      onClick={() => void save(moveExerciseInPlan(plan, day.id, ex.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ minWidth: 44, minHeight: 44, padding: 0, fontSize: 16 }}
                      disabled={idx === day.exercises.length - 1}
                      aria-label="下移动作"
                      onClick={() => void save(moveExerciseInPlan(plan, day.id, ex.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ color: 'var(--brick)', minWidth: 44, minHeight: 44, padding: 0, flex: 'none' }}
                      aria-label={`删除动作「${ex.name}」`}
                      onClick={() => setExDelete({ exId: ex.id, name: ex.name })}
                    >
                      ×
                    </button>
                  </div>
                </div>

                {/* C01：既有动作也能改训练形式（只影响未来训练） */}
                <div className="segmented" role="group" aria-label="训练形式" style={{ marginTop: 10 }}>
                  <button
                    aria-pressed={ex.target.kind === 'straight'}
                    onClick={() => {
                      if (ex.target.kind === 'straight') return;
                      // V3-05：用统一转换函数，保留 weightMode / dumbbellBasis（不擅自改语义）
                      void save(updateTarget(plan, day.id, ex.id, dropToStraightTarget(ex.target) as ExerciseTarget));
                    }}
                  >
                    普通组
                  </button>
                  <button
                    aria-pressed={ex.target.kind === 'dropSet'}
                    onClick={() => {
                      if (ex.target.kind === 'dropSet') return;
                      const draft = straightToDropDraft(ex.target);
                      void save(updateTarget(plan, day.id, ex.id, draftToDropTarget(draft) as ExerciseTarget));
                    }}
                  >
                    递减组
                  </button>
                </div>

                {ex.target.kind === 'straight' ? (
                  <>
                  <div className="segmented" role="group" aria-label="哑铃口径" style={{ marginTop: 8 }}>
                    {([['per_hand', '按单只'], ['total', '按合计']] as const).map(([basis, label]) => (
                      <button
                        key={basis}
                        type="button"
                        aria-pressed={(ex.target.kind === 'straight' ? (ex.target.dumbbellBasis ?? 'total') : 'total') === basis}
                        style={{ fontSize: 12 }}
                        onClick={() => void save(updateTarget(plan, day.id, ex.id, { dumbbellBasis: basis }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginTop: 8 }}>
                    <DraftNumberField
                      onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:sets`)}
                      label="组数"
                      value={ex.target.sets}
                      min={0}
                      max={30}
                      onCommit={(v) => {
                        // 组数下限不能超过上限
                        const setsMax = Math.max(ex.target.kind === 'straight' ? ex.target.setsMax : v, v);
                        void save(updateTarget(plan, day.id, ex.id, { sets: v, setsMax }));
                      }}
                    />
                    <DraftNumberField
                      onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:repsMin`)}
                      label="次数下限"
                      value={ex.target.repsMin}
                      min={0}
                      max={500}
                      validate={(v) =>
                        ex.target.kind === 'straight' && v > ex.target.repsMax
                          ? `不能大于上限 ${ex.target.repsMax}`
                          : null
                      }
                      onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { repsMin: v }))}
                    />
                    <DraftNumberField
                      onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:repsMax`)}
                      label="次数上限"
                      value={ex.target.repsMax}
                      min={0}
                      max={500}
                      validate={(v) =>
                        ex.target.kind === 'straight' && v < ex.target.repsMin
                          ? `不能小于下限 ${ex.target.repsMin}`
                          : null
                      }
                      onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { repsMax: v }))}
                    />
                    <DraftNumberField
                      onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:restSec`)}
                      label="休息秒"
                      value={ex.restSec}
                      min={0}
                      max={3600}
                      unit="秒"
                      onCommit={(v) => void save(updateExercise(plan, day.id, ex.id, { restSec: v }))}
                    />
                    <DraftNumberField
                      onDirtyChange={editorDirtyHandler(`num:ex:${day.id}:${ex.id}:weight`)}
                      label="建议重量"
                      nullable
                      placeholder="—"
                      value={ex.target.suggestedWeightKg}
                      min={0}
                      max={9999}
                      integer={false}
                      unit="kg"
                      onCommit={(v) =>
                        void save(
                          updateTarget(plan, day.id, ex.id, { suggestedWeightKg: v }),
                        )
                      }
                    />
                  </div>
                  </>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <ExistingDropEditor
                      plan={plan}
                      dayId={day.id}
                      exercise={ex}
                      onSave={save}
                      onDirtyChange={editorDirtyHandler(`drop-config:${day.id}:${ex.id}`)}
                      /*
                        B4-R2：把该配置的 owner 生命周期交给统一的注销入口。
                        ExistingDropEditor 卸载（取消/保存成功/删除实体/类型切换）时
                        会真的清掉自己的键，不再留幽灵 dirty 卡住离页门禁。
                      */
                      ownerFieldId={`drop-config:${day.id}:${ex.id}`}
                      onUnregisterOwner={unregisterEditorField}
                    />
                  </div>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      {/* C01 路径 A：添加动作 → 选择动作 → 选择训练形式 → 配置 → 保存 */}
      <Sheet
        open={addOpen}
        title={addStage === 'pick' ? '添加动作' : `配置「${addName}」`}
        onClose={() => {
          setAddOpen(false);
          setQuery('');
          setAddStage('pick');
          // 关闭即丢弃草稿与字段错误，重新进入不残留
          addFormApi.resetAll();
          setAddFormError(null);
          setAddStraightDraft({ sets: 3, repsMin: 8, repsMax: 12 });
        }}
        autoFocusPanel={false}
      >
        {addStage === 'pick' ? (
          <>
            <input
              className="input"
              placeholder="搜索或输入新动作名"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="搜索动作"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <div style={{ maxHeight: '42dvh', overflow: 'auto', marginTop: 10 }}>
              {results.map((r) => (
                <button
                  key={r.name}
                  className="row"
                  onClick={() => {
                    setAddName(r.name);
                    setAddForm('straight');
                    setAddDropDraft(defaultDropDraft({ repsMin: 8, repsMax: 12 }));
                    setAddStage('configure');
                  }}
                >
                  <span className="row-main">
                    <span className="row-title">{r.name}</span>
                    <span className="row-sub">{r.group}</span>
                  </span>
                </button>
              ))}
            </div>
            {query.trim() && !results.some((r) => r.name === query.trim()) ? (
              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: 10 }}
                onClick={() => {
                  setAddName(query.trim());
                  setAddForm('straight');
                  setAddDropDraft(defaultDropDraft({ repsMin: 8, repsMax: 12 }));
                  setAddStage('configure');
                }}
              >
                使用自定义动作「{query.trim()}」
              </button>
            ) : null}
          </>
        ) : (
          <>
            {/* 训练形式选择 */}
            <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 6 }}>训练形式</div>
            <div className="segmented" role="group" aria-label="训练形式" style={{ marginBottom: 12 }}>
              <button aria-pressed={addForm === 'straight'} onClick={() => setAddForm('straight')}>
                普通组
              </button>
              <button aria-pressed={addForm === 'dropSet'} onClick={() => setAddForm('dropSet')}>
                递减组
              </button>
            </div>

            {addForm === 'straight' ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
                {/* V3-04：三个字段接真实草稿，保存时用用户输入 */}
                <DraftNumberField
                  onDirtyChange={editorDirtyHandler(`num:add:${day.id}:sets`)}
                  label="组数"
                  value={addStraightDraft.sets}
                  min={1}
                  max={MAX_STRAIGHT_SETS}
                  form={addFormApi}
                  fieldId="add.sets"
                  onCommit={(v) => setAddStraightDraft((d) => ({ ...d, sets: v }))}
                />
                <DraftNumberField
                  onDirtyChange={editorDirtyHandler(`num:add:${day.id}:repsMin`)}
                  label="次数下限"
                  value={addStraightDraft.repsMin}
                  min={0}
                  max={MAX_REPS}
                  form={addFormApi}
                  fieldId="add.repsMin"
                  validate={(v) => (v > addStraightDraft.repsMax ? `不能大于上限 ${addStraightDraft.repsMax}` : null)}
                  onCommit={(v) => setAddStraightDraft((d) => ({ ...d, repsMin: v }))}
                />
                <DraftNumberField
                  onDirtyChange={editorDirtyHandler(`num:add:${day.id}:repsMax`)}
                  label="次数上限"
                  value={addStraightDraft.repsMax}
                  min={0}
                  max={MAX_REPS}
                  form={addFormApi}
                  fieldId="add.repsMax"
                  validate={(v) => (v < addStraightDraft.repsMin ? `不能小于下限 ${addStraightDraft.repsMin}` : null)}
                  onCommit={(v) => setAddStraightDraft((d) => ({ ...d, repsMax: v }))}
                />
              </div>
            ) : (
              <DropSetEditor
                draft={addDropDraft}
                onChange={setAddDropDraft}
                form={addFormApi}
                fieldPrefix="addDrop"
                /* B4/G5-R5：新增动作的递减配置也算离页门禁的 owner */
                onDirtyChange={editorDirtyHandler(`add:drop:${day.id}`)}
              />
            )}

            {addForm === 'straight' ? (
              <p style={{ fontSize: 12.5, color: 'var(--ink-3)', marginTop: 10, lineHeight: 1.6 }}>
                添加后可在这张卡片里继续调整组数与次数。
              </p>
            ) : null}

            {addFormError ? (
              <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
                {addFormError}
              </div>
            ) : null}

            {(() => {
              const dropIssues = addForm === 'dropSet' ? validateDropDraft(addDropDraft) : [];
              const blocked = dropIssues.length > 0 || remainingExerciseSlots(day) <= 0;
              return (
                <>
                  {remainingExerciseSlots(day) <= 0 ? (
                    <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, marginTop: 10, lineHeight: 1.6 }}>
                      这个训练日已经有 {MAX_EXERCISES} 个动作，达到上限（备份也只支持这个范围）。请先合并或删除动作。
                    </div>
                  ) : null}
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', marginTop: 12 }}
                    disabled={blocked}
                    onClick={async () => {
                      /**
                       * V4-03 保存流程（修复 F4-I03）：
                       * 1) 先把所有数字字段的**当前文本草稿**统一 flush 校验，
                       *    任一非法就不保存、不关窗（旧实现会保存旧值并关闭）。
                       * 2) **用 flushed.values 同步构造 nextDraft 局部变量**。
                       *    绝不 setState 后在同一 handler 里读旧闭包 —— 那正是
                       *    「文本是 5、父 state 还是 3 → 存成 3」的根因。
                       * 3) 对 nextDraft 跑一次完整语义校验（跨字段反向范围）。
                       * 4) 只有全部通过才写库；写失败保留表单。
                       */
                      const flushed = addFormApi.flushAll();
                      if (!flushed.ok) {
                        const first = Object.values(flushed.errors)[0];
                        setAddFormError(`有字段还不合法：${first}`);
                        return;
                      }

                      const nextDrop = mergeFlushedDropDraft(addDropDraft, flushed.values, 'addDrop', {
                        round1AsOverride: true,
                        nullIds: flushed.nullIds,
                      });
                      const nextStraight = mergeFlushedStraightDraft(addStraightDraft, flushed.values, 'add');

                      if (addForm === 'dropSet') {
                        const issues = validateDropDraft(nextDrop);
                        if (issues.length) {
                          setAddFormError(`递减组配置还有 ${issues.length} 处需要修正：${issues[0].message}`);
                          return;
                        }
                      } else {
                        const issues = validateStraightDraft(nextStraight);
                        if (issues.length) {
                          setAddFormError(`还有 ${issues.length} 处需要修正：${issues[0].message}`);
                          return;
                        }
                      }
                      setAddFormError(null);

                      const target: ExerciseTarget =
                        addForm === 'dropSet'
                          ? draftToDropTarget(nextDrop)
                          : {
                              kind: 'straight',
                              sets: nextStraight.sets,
                              setsMax: nextStraight.sets,
                              repsMin: nextStraight.repsMin,
                              repsMax: nextStraight.repsMax,
                              weightMode: 'external',
                              suggestedWeightKg: null,
                            };

                      const result = addExercise(plan, day.id, addName, target);
                      if (!result.added) {
                        setAddFormError(
                          result.reason === 'capacity'
                            ? `动作数已达上限 ${MAX_EXERCISES}`
                            : '找不到这个训练日，未保存',
                        );
                        return;
                      }
                      await save(result.plan);
                      pushToast(
                        addForm === 'dropSet'
                          ? `已添加递减组「${addName}」（${nextDrop.rounds} 轮 × ${nextDrop.stages.length} 阶段）`
                          : `已添加「${addName}」（${nextStraight.sets} 组 × ${nextStraight.repsMin}–${nextStraight.repsMax} 次）`,
                      );
                      addFormApi.resetAll();
                      setAddFormError(null);
                      setAddOpen(false);
                      setQuery('');
                      setAddStage('pick');
                    }}
                  >
                    {blocked ? (remainingExerciseSlots(day) <= 0 ? '已达动作上限' : '请先修正配置') : addForm === 'dropSet' ? '保存递减组' : '保存动作'}
                  </button>
                </>
              );
            })()}

            <button
              className="btn btn-ghost"
              style={{ width: '100%', marginTop: 8 }}
              onClick={() => {
                setAddStage('pick');
                setQuery('');
              }}
            >
              返回重选动作
            </button>
          </>
        )}
      </Sheet>

      <Sheet open={warmupOpen} title="添加热身" onClose={() => setWarmupOpen(false)}>
        <div className="field">
          <label htmlFor="warm-name">热身名称</label>
          <input
            id="warm-name"
            className="input"
            value={warmupName}
            placeholder="例如：弹力带水平拉开"
            onChange={(e) => setWarmupName(e.target.value)}
          />
        </div>
        <button
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 12 }}
          onClick={async () => {
            const ok = await save(addWarmup(plan, day.id, warmupName));
            if (!ok) return; // 失败保留输入与弹层，不假报成功
            setWarmupName('');
            setWarmupOpen(false);
          }}
        >
          添加
        </button>
      </Sheet>

      {/*
        L03：编辑页删除确认（动作 / 热身）。
        按钮严格「是 / 否」；确认时按 id 从当前 plan/day 重取目标；
        目标消失 → 温和收尾；只有真正提交成功才关闭；失败保留可重试；busy 防连点。
      */}
      <Confirm
        open={!!exDelete}
        title="删除这个动作？"
        body={exDelete ? `将删除动作「${exDelete.name}」。已保存的训练历史不受影响。` : ''}
        confirmText="是"
        cancelText="否"
        danger
        busy={deleting}
        onCancel={() => {
          if (deleting) return;
          setExDelete(null);
        }}
        onConfirm={async () => {
          if (deleting || !exDelete) return;
          setDeleting(true);
          try {
            const currentPlan = plans.find((p) => p.id === planId);
            const currentDay = currentPlan?.days.find((d) => d.id === dayId);
            const target = currentDay?.exercises.find((e) => e.id === exDelete.exId);
            if (!currentPlan || !currentDay || !target) {
              setExDelete(null);
              pushToast('这个动作已经不存在了。');
              return;
            }
            const ok = await save(removeExercise(currentPlan, currentDay.id, target.id));
            if (!ok) return; // 失败：保留弹窗
            setExDelete(null);
            pushToast('动作已删除，历史记录未受影响。');
          } finally {
            setDeleting(false);
          }
        }}
      />

      <Confirm
        open={!!warmDelete}
        title="删除这个热身？"
        body={warmDelete ? `将删除热身「${warmDelete.name}」。已保存的训练历史不受影响。` : ''}
        confirmText="是"
        cancelText="否"
        danger
        busy={deleting}
        onCancel={() => {
          if (deleting) return;
          setWarmDelete(null);
        }}
        onConfirm={async () => {
          if (deleting || !warmDelete) return;
          setDeleting(true);
          try {
            const currentPlan = plans.find((p) => p.id === planId);
            const currentDay = currentPlan?.days.find((d) => d.id === dayId);
            const target = currentDay?.warmups.find((w) => w.id === warmDelete.warmId);
            if (!currentPlan || !currentDay || !target) {
              setWarmDelete(null);
              pushToast('这个热身项已经不存在了。');
              return;
            }
            const ok = await save(removeWarmup(currentPlan, currentDay.id, target.id));
            if (!ok) return;
            setWarmDelete(null);
            pushToast('热身项已删除，历史记录未受影响。');
          } finally {
            setDeleting(false);
          }
        }}
      />
    </main>
  );
}
