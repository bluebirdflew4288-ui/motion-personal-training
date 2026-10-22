/* 计划管理：新建 / 复制 / 重命名 / 删除 / 编辑训练日与动作。
   所有保存立即写库；失败会提示，不静默失败。 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
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
import { MAX_EXERCISES, MAX_REPS, MAX_STRAIGHT_SETS } from '../domain/limits';
import { createV32Plan } from '../domain/presets/v32';
import { targetGroupsOf } from '../domain/session';
import { DraftNumberField } from '../ui/DraftNumberField';
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
import { deletePlan } from '../db/repo';
import { searchExercises } from '../domain/presets/library';
import type { ExerciseTarget, Plan, PlanDay, PlanExercise } from '../domain/types';

const FOCUS_LABEL = { chest: '胸', back: '背', legs: '腿' } as const;

export function PlansPage() {
  const { plans, upsertPlan, pushToast, refreshPlans } = useStore();
  const [newOpen, setNewOpen] = useState(false);
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

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <h1 className="h-serif" style={{ fontSize: 26 }}>
          训练计划
        </h1>
        <button className="btn btn-sm btn-primary" onClick={() => setNewOpen(true)}>
          + 新建
        </button>
      </header>
      <hr className="rule-line" style={{ marginTop: 8 }} />

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

      {plans.map((plan) => (
        <section key={plan.id} className="slip" style={{ marginTop: 14, padding: '14px 14px 10px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <DraftTextField
                className="input"
                style={{ minHeight: 44, fontSize: 17, fontWeight: 600, border: '1px solid transparent', background: 'transparent', paddingLeft: 0 }}
                value={plan.name}
                ariaLabel="计划名称"
                maxLength={200}
                onCommit={(next) => save(renamePlan(currentPlan(plan.id), next))}
              />
              <div style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 2 }}>
                {plan.days.length} 天 · {plan.days.filter((d) => d.kind === 'train').length} 个训练日 · 循环位置{' '}
                {plan.cursor + 1}
              </div>
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
      ))}

      <Sheet open={newOpen} title="新建计划" onClose={() => setNewOpen(false)}>
        <div className="field">
          <label htmlFor="new-plan-name">计划名称</label>
          <input
            id="new-plan-name"
            className="input"
            value={newName}
            placeholder="例如：三分化训练计划 V3.2"
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const plan = createV32Plan();
              const ok = await save({ ...plan, name: newName.trim() || plan.name, id: `plan-${Date.now()}` });
              if (!ok) return; // 失败保留弹层与输入，可重试
              setNewName('');
              setNewOpen(false);
              pushToast('已新建计划。');
            }}
          >
            从 V3.2 预设新建
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              const now = Date.now();
              // 空白计划 = 一个空训练日，动作与热身都为空（审计 R2-08）
              const blank: Plan = {
                id: `plan-${now}`,
                name: newName.trim() || '空白计划',
                cursor: 0,
                createdAt: now,
                updatedAt: now,
                days: [
                  {
                    id: `day-${now}`,
                    name: '训练日 1',
                    focus: 'chest',
                    round: 'A',
                    kind: 'train',
                    warmups: [],
                    exercises: [],
                  },
                ],
              };
              void save(blank);
              setNewName('');
              setNewOpen(false);
            }}
          >
            新建空白计划（一个空训练日）
          </button>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.6, margin: 0 }}>
            修改计划不会影响已经保存的历史训练。
          </p>
        </div>
      </Sheet>

      <Confirm
        open={!!deleteTarget}
        title="删除计划？"
        body="计划会被删除，但已经保存的训练历史不受影响。"
        confirmText="删除计划"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deletePlan(deleteTarget.id);
            await refreshPlans();
            setDeleteTarget(null);
            pushToast('计划已删除，历史记录未受影响。');
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
}: {
  plan: Plan;
  day: PlanDay;
  index: number;
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
          {day.kind === 'rest' ? '休息' : `${day.exercises.length} 动作`}
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
}: {
  plan: Plan;
  dayId: string;
  exercise: PlanExercise;
  /** 必须如实返回是否成功：失败时编辑器要保留草稿，不能静默关窗 */
  onSave: (p: Plan) => Promise<boolean>;
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
            const nextDraft = mergeFlushedDropDraft(draft, flushed.values, `ex.${exercise.id}`);
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

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/plans')}>
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
        <button
          className={`btn btn-sm ${day.kind === 'rest' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => void save(setDayKind(plan, day.id, day.kind === 'rest' ? 'train' : 'rest'))}
        >
          {day.kind === 'rest' ? '休息日' : '设为休息日'}
        </button>
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
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginTop: 8 }}>
                    <DraftNumberField
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
                      label="休息秒"
                      value={ex.restSec}
                      min={0}
                      max={3600}
                      unit="秒"
                      onCommit={(v) => void save(updateExercise(plan, day.id, ex.id, { restSec: v }))}
                    />
                    <DraftNumberField
                      label="建议重量"
                      value={ex.target.suggestedWeightKg ?? 0}
                      min={0}
                      max={9999}
                      integer={false}
                      unit="kg"
                      onCommit={(v) =>
                        void save(
                          updateTarget(plan, day.id, ex.id, { suggestedWeightKg: v > 0 ? v : null }),
                        )
                      }
                    />
                  </div>
                ) : (
                  <div style={{ marginTop: 8 }}>
                    <ExistingDropEditor
                      plan={plan}
                      dayId={day.id}
                      exercise={ex}
                      onSave={save}
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
                  label="组数"
                  value={addStraightDraft.sets}
                  min={1}
                  max={MAX_STRAIGHT_SETS}
                  form={addFormApi}
                  fieldId="add.sets"
                  onCommit={(v) => setAddStraightDraft((d) => ({ ...d, sets: v }))}
                />
                <DraftNumberField
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
              <DropSetEditor draft={addDropDraft} onChange={setAddDropDraft} form={addFormApi} fieldPrefix="addDrop" />
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

                      const nextDrop = mergeFlushedDropDraft(addDropDraft, flushed.values, 'addDrop');
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
