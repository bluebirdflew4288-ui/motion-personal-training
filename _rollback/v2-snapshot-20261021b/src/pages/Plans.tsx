/* 计划管理：新建 / 复制 / 重命名 / 删除 / 编辑训练日与动作。
   所有保存立即写库；失败会提示，不静默失败。 */

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import {
  addDay,
  addExercise,
  addWarmup,
  clonePlan,
  deleteDay,
  moveDay,
  moveExerciseInPlan,
  removeExercise,
  removeWarmup,
  renameDay,
  renamePlan,
  setDayKind,
  updateExercise,
  updateTarget,
  updateWarmup,
} from '../domain/planEdit';
import { createV32Plan } from '../domain/presets/v32';
import { targetGroupsOf } from '../domain/session';
import { DraftNumberField } from '../ui/DraftNumberField';
import { deletePlan } from '../db/repo';
import { searchExercises } from '../domain/presets/library';
import type { Plan, PlanDay } from '../domain/types';

const FOCUS_LABEL = { chest: '胸', back: '背', legs: '腿' } as const;

export function PlansPage() {
  const { plans, upsertPlan, pushToast, refreshPlans } = useStore();
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);

  async function save(next: Plan) {
    try {
      await upsertPlan(next);
    } catch (err) {
      pushToast(err instanceof Error ? `计划未保存：${err.message}` : '计划未保存', 'error');
    }
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
              await save(createV32Plan());
              pushToast('已创建 V3.2 计划。');
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
              <input
                className="input"
                style={{ minHeight: 44, fontSize: 17, fontWeight: 600, border: '1px solid transparent', background: 'transparent', paddingLeft: 0 }}
                value={plan.name}
                aria-label="计划名称"
                onChange={(e) => void save(renamePlan(plan, e.target.value))}
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
                  await save(clonePlan(plan));
                  pushToast('已复制计划。');
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
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => void save(addDay(plan))}>
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
              await save({ ...plan, name: newName.trim() || plan.name, id: `plan-${Date.now()}` });
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
    </main>
  );
}

function PlanDayRow({
  plan,
  day,
  index,
  onSave,
  onOpen,
}: {
  plan: Plan;
  day: PlanDay;
  index: number;
  onSave: (p: Plan) => Promise<void>;
  onOpen: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 0',
        borderBottom: '1px dashed var(--rule)',
      }}
    >
      <span className="mono-label" style={{ width: 22, flex: 'none' }}>
        {index + 1}
      </span>
      <input
        className="input"
        style={{ flex: 1, minWidth: 0, minHeight: 44, fontSize: 15, paddingLeft: 8 }}
        value={day.name}
        aria-label={`第 ${index + 1} 天名称`}
        onChange={(e) => void onSave(renameDay(plan, day.id, e.target.value))}
      />
      <span className="tag tag-quiet" style={{ flex: 'none' }}>
        {day.kind === 'rest' ? '休息' : `${day.exercises.length} 动作`}
      </span>
      <button className="btn btn-ghost btn-sm" style={{ flex: 'none' }} onClick={onOpen}>
        编辑
      </button>
      <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
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
      </div>
      <button
        className="btn btn-ghost"
        style={{ minWidth: 44, minHeight: 44, padding: 0, marginLeft: 10, color: 'var(--brick)', flex: 'none' }}
        aria-label="删除训练日"
        onClick={() => void onSave(deleteDay(plan, day.id))}
      >
        ×
      </button>
    </div>
  );
}

export function PlanDayEditor({ planId, dayId }: { planId: string; dayId: string }) {
  const { plans, upsertPlan, pushToast } = useStore();
  const plan = plans.find((p) => p.id === planId);
  const day = plan?.days.find((d) => d.id === dayId);
  const [addOpen, setAddOpen] = useState(false);
  const [query, setQuery] = useState('');
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

  async function save(next: Plan) {
    try {
      await upsertPlan(next);
    } catch (err) {
      pushToast(err instanceof Error ? `未保存：${err.message}` : '未保存', 'error');
    }
  }

  return (
    <main className="page page-top page-bottom-space">
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/plans')}>
          ‹ 计划
        </button>
      </header>

      <h1 className="h-serif" style={{ fontSize: 26, marginTop: 8 }}>
        {day.name}
      </h1>
      <div className="mono-label" style={{ marginTop: 2 }}>
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
                  <div key={w.id} className="row" style={{ cursor: 'default' }}>
                    <span className="row-main">
                      <span className="row-title" style={{ fontSize: 15 }}>
                        {w.name}
                      </span>
                    </span>
                    <input
                      className="input"
                      style={{ width: 120, minHeight: 36, fontSize: 13 }}
                      value={w.targetText}
                      aria-label={`${w.name} 目标`}
                      onChange={(e) => void save(updateWarmup(plan, day.id, w.id, e.target.value))}
                    />
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--brick)' }}
                      onClick={() => void save(removeWarmup(plan, day.id, w.id))}
                      aria-label={`删除 ${w.name}`}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mono-label" style={{ width: 20, flex: 'none' }}>
                    {idx + 1}
                  </span>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 0, minHeight: 40, fontSize: 15 }}
                    value={ex.name}
                    aria-label={`动作 ${idx + 1} 名称`}
                    onChange={(e) => void save(updateExercise(plan, day.id, ex.id, { name: e.target.value }))}
                  />
                  <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
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
                  </div>
                  <button
                    className="btn btn-ghost"
                    style={{ color: 'var(--brick)', minWidth: 44, minHeight: 44, padding: 0, flex: 'none', marginLeft: 10 }}
                    aria-label="删除动作"
                    onClick={() => void save(removeExercise(plan, day.id, ex.id))}
                  >
                    ×
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
                  <div style={{ marginTop: 8, padding: 10, background: 'var(--paper-3)' }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                      递减组：<strong>{ex.target.rounds} 轮</strong> × {ex.target.stages.length} 阶段（按大组计数）
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8, marginTop: 8 }}>
                      <DraftNumberField
                        label="轮数"
                        value={ex.target.rounds}
                        min={1}
                        max={20}
                        onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { rounds: v }))}
                      />
                      <DraftNumberField
                        label="阶段间休息"
                        value={ex.target.restInSec}
                        min={0}
                        max={600}
                        unit="秒"
                        onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { restInSec: v }))}
                      />
                      <DraftNumberField
                        label="轮间休息"
                        value={ex.target.restAfterSec}
                        min={0}
                        max={3600}
                        unit="秒"
                        onCommit={(v) => void save(updateTarget(plan, day.id, ex.id, { restAfterSec: v }))}
                      />
                    </div>

                    {/* 每个阶段：重量目标 + 次数目标（技术性力竭则只记重量） */}
                    {ex.target.stages.map((st, si) => (
                      <div
                        key={`${st.label}-${si}`}
                        style={{
                          marginTop: 8,
                          paddingTop: 8,
                          borderTop: '1px dashed var(--rule)',
                        }}
                      >
                        <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 4 }}>{st.label}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
                          <DraftNumberField
                            label="重量"
                            value={st.weightKg ?? 0}
                            min={0}
                            max={999}
                            integer={false}
                            unit="kg"
                            onCommit={(v) => {
                              const stages = ex.target.kind === 'dropSet' ? ex.target.stages.map((x, i) =>
                                i === si ? { ...x, weightKg: v, targetText: `${v} kg · ${x.toFailure ? '技术性力竭' : `${x.repsMin ?? 0}–${x.repsMax ?? 0} 次`}` } : x,
                              ) : [];
                              void save(updateTarget(plan, day.id, ex.id, { stages }));
                            }}
                          />
                          <DraftNumberField
                            label="次数下限"
                            value={st.repsMin ?? 0}
                            min={0}
                            max={500}
                            onCommit={(v) => {
                              const stages = ex.target.kind === 'dropSet' ? ex.target.stages.map((x, i) =>
                                i === si ? { ...x, repsMin: v, targetText: `${x.weightKg ?? 0} kg · ${x.toFailure ? '技术性力竭' : `${v}–${x.repsMax ?? 0} 次`}` } : x,
                              ) : [];
                              void save(updateTarget(plan, day.id, ex.id, { stages }));
                            }}
                          />
                          <DraftNumberField
                            label="次数上限"
                            value={st.repsMax ?? 0}
                            min={0}
                            max={500}
                            onCommit={(v) => {
                              const stages = ex.target.kind === 'dropSet' ? ex.target.stages.map((x, i) =>
                                i === si ? { ...x, repsMax: v, targetText: `${x.weightKg ?? 0} kg · ${x.toFailure ? '技术性力竭' : `${x.repsMin ?? 0}–${v} 次`}` } : x,
                              ) : [];
                              void save(updateTarget(plan, day.id, ex.id, { stages }));
                            }}
                          />
                        </div>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 12, color: 'var(--ink-3)' }}>
                          <input
                            type="checkbox"
                            checked={st.toFailure}
                            onChange={(e) => {
                              const stages = ex.target.kind === 'dropSet' ? ex.target.stages.map((x, i) =>
                                i === si ? {
                                  ...x,
                                  toFailure: e.target.checked,
                                  targetText: e.target.checked
                                    ? `${x.weightKg ?? 0} kg · 技术性力竭`
                                    : `${x.weightKg ?? 0} kg · ${x.repsMin ?? 0}–${x.repsMax ?? 0} 次`,
                                } : x,
                              ) : [];
                              void save(updateTarget(plan, day.id, ex.id, { stages }));
                            }}
                            style={{ width: 20, height: 20, accentColor: 'var(--brick)' }}
                          />
                          目标是技术性力竭（实际仍记录完成次数）
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </section>
        </>
      )}

      <Sheet open={addOpen} title="添加动作" onClose={() => setAddOpen(false)}>
        <input
          className="input"
          placeholder="搜索或输入新动作名"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索动作"
        />
        <div style={{ maxHeight: '42dvh', overflow: 'auto', marginTop: 10 }}>
          {results.map((r) => (
            <button
              key={r.name}
              className="row"
              onClick={async () => {
                await save(addExercise(plan, day.id, r.name));
                setAddOpen(false);
                setQuery('');
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
            onClick={async () => {
              await save(addExercise(plan, day.id, query.trim()));
              setAddOpen(false);
              setQuery('');
            }}
          >
            使用「{query.trim()}」
          </button>
        ) : null}
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
            await save(addWarmup(plan, day.id, warmupName));
            setWarmupName('');
            setWarmupOpen(false);
          }}
        >
          添加
        </button>
      </Sheet>
    </main>
  );
}
