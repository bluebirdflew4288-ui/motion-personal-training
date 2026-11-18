/* 计划管理主页（Wave 2A 模块化拆分自 Plans.tsx）：
   新建 / 复制 / 导入 / 重命名 / 删除计划，以及管理选择与训练用 currentPlanId 解耦、多字段草稿离页门禁。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { navigate, registerLeaveGuard, useRoute } from '../../lib/router';
import { Sheet } from '../../ui/Sheet';
import { Confirm } from '../../ui/Confirm';
import { DraftTextField } from '../../ui/DraftTextField';
import {
  addDay,
  canAddDay,
  clonePlan,
  deleteDay,
  moveDay,
  renameDay,
  renamePlan,
} from '../../domain/planEdit';
import { MAX_LEGACY_PLAN_NAME, MAX_PLAN_NAME } from '../../domain/limits';
import { createV32Plan } from '../../domain/presets/v32';
import { TemplateImportSheet } from '../../ui/TemplateImportSheet';
import { atomicDeletePlanWithCurrent } from '../../db/repo';
import type { Plan, PlanDay } from '../../domain/types';

/**
 * B4-R2：**字段 owner 的完整生命周期**（注册 → 上报 → 注销）。
 */
export function useFieldOwner(
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
      onDirty(fieldId, false);
      unregister(fieldId);
    };
  }, [fieldId, onDirty, unregister]);
  return callbacks;
}

export function PlansPage() {
  const { plans, upsertPlan, pushToast, refreshPlans, refreshSettings, settings } = useStore();
  const route = useRoute();

  /** 当前正在管理的 planId（null 表示尚未确定，由下方 effect 初始化） */
  const [managePlanId, setManagePlanId] = useState<string | null>(null);
  /** 切换门禁：非 null 时表示"有一次切换请求正在等草稿门禁结果"。 */
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  /** B3/G5-R2：放弃信号 epoch（供字段 reset 草稿） */
  const [discardEpoch, setDiscardEpoch] = useState(0);
  /** 脏字段聚合（B4/G5-R1/R3）：用 state 驱动，保证依赖它的自动续请求 effect 可重跑 */
  const [dirtyFields, setDirtyFields] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 在途保存（B4/G5-R3）：用 Set 浅拷贝做 state 值 */
  const [savingFields, setSavingFields] = useState<ReadonlySet<string>>(new Set());

  const isAnySaving = (): boolean => savingFields.size > 0;
  const reportFieldSaving = (fieldId: string, saving: boolean): void => {
    setSavingFields((prev) => {
      const next = new Set(prev);
      if (saving) next.add(fieldId);
      else next.delete(fieldId);
      return next.size === prev.size && [...next].every((k) => prev.has(k)) ? prev : next;
    });
  };
  const isAnyDirty = (): boolean => {
    for (const v of dirtyFields.values()) if (v) return true;
    return false;
  };
  const reportFieldDirty = (fieldId: string, dirty: boolean): void => {
    setDirtyFields((prev) => {
      const next = new Map(prev);
      if (dirty) next.set(fieldId, true);
      else next.delete(fieldId);
      return next;
    });
  };
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

  useEffect(() => {
    return () => {
      setDirtyFields(new Map());
      setSavingFields(new Set());
      dirtyHandlersRef.current.clear();
    };
  }, []);

  const dirtyHandlersRef = useRef<Map<string, (dirty: boolean) => void>>(new Map());
  const fieldSavingHandler = (fieldId: string): ((saving: boolean) => void) => {
    return (saving: boolean) => reportFieldSaving(fieldId, saving);
  };
  const fieldUnregister = (fieldId: string): (() => void) => {
    return () => unregisterField(fieldId);
  };
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

  const [switchBlocked, setSwitchBlocked] = useState(false);
  const pendingNewPlanIdRef = useRef<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  const [dayDelete, setDayDelete] = useState<{ planId: string; dayId: string; name: string } | null>(null);
  const [dayDeleting, setDayDeleting] = useState(false);

  async function save(next: Plan): Promise<boolean> {
    try {
      await upsertPlan(next);
      return true;
    } catch (err) {
      pushToast(err instanceof Error ? `计划未保存：${err.message}` : '计划未保存', 'error');
      return false;
    }
  }

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

  function currentPlan(planId: string): Plan {
    const found = plans.find((p) => p.id === planId);
    if (!found) throw new Error('这个计划已经不存在了');
    return found;
  }

  /**
   * 初始管理选择：路由 → 训练 current → 首项（已裁决优先级）。
   */
  useEffect(() => {
    const routePlanId = route.parts[0] === 'plans' ? route.query.get('plan') : null;
    const routeValid = !!routePlanId && plans.some((p) => p.id === routePlanId);
    const currentValid =
      !!settings.currentPlanId && plans.some((p) => p.id === settings.currentPlanId);
    const pendingNew = pendingNewPlanIdRef.current;
    if (pendingNew && !plans.some((p) => p.id === pendingNew)) {
      return; // 等刷新，不判无效
    }
    if (pendingNew && plans.some((p) => p.id === pendingNew)) {
      pendingNewPlanIdRef.current = null;
    }

    const stillValid = !!managePlanId && plans.some((p) => p.id === managePlanId);
    if (stillValid) return;

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

  /** 请求切换管理计划 —— 必须经过草稿门禁 */
  function requestManageSwitch(nextId: string): void {
    if (!nextId || nextId === managePlanId) return;
    if (isAnySaving() || isAnyDirty()) {
      setPendingSwitch(nextId);
      setSwitchBlocked(true);
      return;
    }
    setSwitchBlocked(false);
    setPendingSwitch(null);
    setManagePlanId(nextId);
  }

  /** 视图变干净且无在途保存时，自动续之前被挂起的切换 */
  useEffect(() => {
    if (!switchBlocked || !pendingSwitch) return;
    if (isAnySaving() || isAnyDirty()) return;
    const target = pendingSwitch;
    setSwitchBlocked(false);
    setPendingSwitch(null);
    setManagePlanId(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switchBlocked, pendingSwitch, discardEpoch, savingFields, dirtyFields]);

  const performDiscardAndSwitch = (): void => {
    const target = pendingSwitch;
    setDiscardEpoch((n) => n + 1);
    setDirtyFields(new Map());
    setSavingFields(new Set());
    setSwitchBlocked(false);
    setPendingSwitch(null);
    if (target && target !== managePlanId) setManagePlanId(target);
  };

  const isAnyDirtyRef = useRef(isAnyDirty);
  isAnyDirtyRef.current = isAnyDirty;
  useEffect(() => {
    return registerLeaveGuard(() => !isAnyDirtyRef.current());
  }, []);

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

      {managedPlan ? (
        (() => {
          const plan = managedPlan;
          return (
            <section key={plan.id} className="slip" style={{ marginTop: 14, padding: '14px 14px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <DraftTextField
                    className="input"
                    style={{
                      minHeight: 44,
                      fontSize: 17,
                      fontWeight: 600,
                      border: '1px solid transparent',
                      background: 'transparent',
                      paddingLeft: 0,
                    }}
                    value={plan.name}
                    ariaLabel="计划名称"
                    maxLength={MAX_PLAN_NAME}
                    onCommit={(next) => {
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
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigate(`/plan/${plan.id}/day/${plan.days[0]?.id ?? ''}`)}
                >
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
              if (resolvedName === null) return;
              const newId = `plan-${Date.now()}`;
              const ok = await save({ ...plan, name: resolvedName, id: newId });
              if (!ok) return;
              setNewName('');
              setNewOpen(false);
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
              const resolvedName = resolveNewPlanName('空白计划');
              if (resolvedName === null) return;
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
                    kind: 'train',
                    warmups: [],
                    exercises: [],
                  },
                ],
              };
              const okBlank = await save(blank);
              if (!okBlank) return;
              setNewName('');
              setNewOpen(false);
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

      <TemplateImportSheet
        open={tplOpen}
        onClose={() => setTplOpen(false)}
        onImported={(imported: Plan) => {
          void refreshPlans();
          if (!imported?.id) return;
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
            const r = await atomicDeletePlanWithCurrent(deletedId, (currentId, remaining) => {
              if (currentId !== deletedId) return undefined;
              return remaining[0] ?? null;
            });

            if (!r.ok) {
              pushToast(
                r.reason === 'plan-not-found'
                  ? '这个计划已经不存在了。'
                  : `删除失败：${r.reason ?? '未知原因'}（未做任何修改）`,
                'error',
              );
              return;
            }

            await refreshPlans();
            await refreshSettings();
            setDeleteTarget(null);

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
          if (dayDeleting) return;
          setDayDelete(null);
        }}
        onConfirm={async () => {
          if (dayDeleting || !dayDelete) return;
          setDayDeleting(true);
          try {
            const currentPlan = plans.find((p) => p.id === dayDelete.planId);
            const currentDay = currentPlan?.days.find((d) => d.id === dayDelete.dayId);
            if (!currentPlan || !currentDay) {
              setDayDelete(null);
              pushToast('这个训练日已经不存在了。');
              return;
            }
            if (currentPlan.days.length <= 1) {
              setDayDelete(null);
              pushToast('至少要保留一个训练日，不能删除最后一个。', 'error');
              return;
            }
            const nextPlan = deleteDay(currentPlan, currentDay.id);
            if (nextPlan === currentPlan) {
              pushToast('这个训练日没有被删除（至少要保留一个）。', 'error');
              return;
            }
            const ok = await save(nextPlan);
            if (!ok) return;
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
  onDirtyChange?: (dirty: boolean) => void;
  discardEpoch?: number;
  onSavingChange?: (saving: boolean) => void;
  onSave: (p: Plan) => Promise<boolean>;
  onOpen: () => void;
  onRequestDelete: (day: PlanDay) => void;
}) {
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
