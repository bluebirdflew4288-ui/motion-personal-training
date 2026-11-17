/* 通用递减组配置面板（C01）。
   计划编辑与训练中临时调整共用同一个组件，避免两套规则漂移。
   移动端默认简洁：只在选择「递减组」时展开细项，保存前有可读预览。 */

import { useEffect, useState } from 'react';
import type { DropSetDraft } from '../domain/dropSet';
import {
  MAX_ROUNDS,
  MAX_STAGES,
  MIN_ROUNDS,
  MIN_STAGES,
  addStageToRound,
  describeDropDraft,
  setDropDraftRounds,
  draftStagesForRound,
  moveStageInRound,
  removeStageFromRound,
  updateStageInRound,
  validateDropDraft,
} from '../domain/dropSet';
import { DraftNumberField } from './DraftNumberField';
import type { DraftFormApi } from './draftForm';
import { Confirm } from './Confirm';

interface Props {
  draft: DropSetDraft;
  onChange: (next: DropSetDraft) => void;
  /** 已有实际记录时提示只影响未开始部分 */
  scopeNote?: string;
  /** 父表单句柄：所有数字字段注册进去，保存前统一校验（V3-04） */
  form?: DraftFormApi;
  /** 字段 id 前缀（同一页面有多个编辑器时必须唯一） */
  fieldPrefix?: string;
  /**
   * B4/G5-R5：把**内部 raw 状态**上报给离页门禁。
   *
   * <p>关键：外层 `draft` 是结构化对象，用户把某个阶段轮数**清空**时
   * 外层 draft 可能仍是旧值（3），但内部数字框已有"空/未完/错误"的 raw 草稿。
   * 真实失败：清空轮数并 blur 报"不能为空"，仍显示"没有改动"，点返回直接丢失。
   *
   * <p>因此本组件必须把 raw 层状态（flush 是否通过、是否有错误、是否聚焦）
   * 独立上报，不能只依赖父层比较 JSON。
   */
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * B4-R1：**外层结构化草稿**是否脏（由父层计算后传入）。
   *
   * <p>关键：结构化 draft 与内部 raw 曾经**各自往同一个 owner 写**
   * （外层报 `structuredDirty||saving`、内层报 `invalid`），
   * 内层的 false 会清掉外层仍脏的合法改动。
   * 现在两者在本组件内**合并后只上报一次**。
   */
  structuredDirty?: boolean;
}

/**
 * 阶段字段的父表单注册规则（V4-03 / F4-I01 的单一真源）。
 *
 * 力竭只意味着「不要求次数目标」，**重量仍然可编辑、仍然必须 0–999**。
 * 旧实现三个字段一起 `st.toFailure ? undefined : form` 注销，于是力竭阶段
 * 重量填 1000 只有局部红字，父表单 flushAll 看不到 → 保存旧重量并关窗。
 *
 * 因此：weight 永远有 fieldId；只有真正被 disabled 的 repsMin/repsMax 才是 undefined。
 */
export function stageFieldIds(
  fieldPrefix: string,
  stageIndex: number,
  toFailure: boolean,
  roundIndex = 1,
): { weight: string; repsMin: string | undefined; repsMax: string | undefined; rest: string } {
  const p = roundIndex === 1 ? `${fieldPrefix}.s${stageIndex}` : `${fieldPrefix}.r${roundIndex}s${stageIndex}`;
  return {
    weight: `${p}.weight`,
    repsMin: toFailure ? undefined : `${p}.repsMin`,
    repsMax: toFailure ? undefined : `${p}.repsMax`,
    rest: `${p}.rest`,
  };
}

export function DropSetEditor({
  draft,
  onChange,
  scopeNote,
  form,
  fieldPrefix = 'drop',
  onDirtyChange,
  structuredDirty = false,
}: Props) {
  /**
   * B4/G5-R5：**内部 raw 脏状态**。
   *
   * 判定来源：
   *   · 结构 draft 与外部不一致（原有）；
   *   · **或** 父表单 flush 不通过（存在空/未完/非法/IME 的 raw 草稿）。
   *
   * 用 state 而非 ref，保证父级 effect 能观察到 true→false 变化。
   */
  const [rawInvalid, setRawInvalid] = useState(false);
  /**
   * B4-R2（G5 实证缺口 1 的修复核心）：**订阅字段被动变化**。
   *
   * <p>B4-R1 用 `probeRawValid()` 消除了自激循环，但它只是"读一次快照"：
   * 子字段清空/报错/IME 只改自己的本地 state，父层 `draft` 与 `form` 身份都不变，
   * 依赖 `[draft, form]` 的 effect **永远不会重跑** → rawInvalid 一直 false
   * → 离页门禁放行 → 草稿丢失（Codex 真实 001 实证）。
   *
   * <p>现在：字段在不可卸载状态真实变化时通过 `form._reportUnsafe` 主动通知，
   * 本组件订阅该通知并重算聚合。**不再依赖 draft/form 身份变化**。
   */
  useEffect(() => {
    if (!form) return undefined;
    /**
     * 重算聚合：任一字段不可安全卸载即视为 raw 层不干净。
     *
     * 用 `hasUnsafeField()`（含合法未提交/空/`7.`/IME/错误），
     * 不是只看 invalid —— 合法但未 blur 的草稿同样不能被静默卸载。
     */
    const recompute = () => {
      let unsafe = false;
      try {
        unsafe = form.hasUnsafeField();
      } catch {
        unsafe = true; // 探测失败按脏处理（保守）
      }
      setRawInvalid(unsafe);
    };
    recompute(); // 首次同步一次（覆盖已挂载字段的当前状态）
    return form.subscribe(recompute);
  }, [form]);

  /**
   * 结构化草稿与内部 raw **合并后只上报一次**（B4-R1）。
   * 取 OR：任一为真即脏，避免内层 false 清掉外层仍脏的合法改动。
   *
   * B4-R2：`draft` 变化时也重算一次（结构化改动本身可能改变字段基线）。
   */
  useEffect(() => {
    if (!onDirtyChange) return;
    onDirtyChange(structuredDirty || rawInvalid);
  }, [structuredDirty, rawInvalid, onDirtyChange]);

  /**
   * B4-R2：**真正卸载时注销自己的 owner**（G5 实证缺口 2：取消幽灵 dirty）。
   *
   * <p>真实失败：合法 3→4 真实 blur → 取消恢复 3 → 点 ‹计划 无反应。
   * 根因：配置 owner 由**会卸载的内层**独占，内层卸载后没有人清 false，
   * 外层 PlanDayEditor 的 owner Map 永久为 true。
   *
   * <p>这里在 cleanup 里显式上报 false（本次编辑不再持有任何脏状态），
   * 让门禁随组件消失而释放。**只清自己的键**，不动其它存活字段。
   */
  useEffect(() => {
    if (!onDirtyChange) return undefined;
    return () => {
      onDirtyChange(false);
    };
  }, [onDirtyChange]);

  /**
   * L03：删除递减阶段前必须确认（严格「是 / 否」）。
   *
   * 关键约束：确认流程**只作用于本地配置草稿**，取消不丢任何未保存数字。
   * 这里记的是「待删除阶段的索引」，不在弹窗期间改动 draft；
   * 只有点「是」才 onChange(removeStage(...))，随后仍需用户按
   * 「保存这个配置」才真正落库 —— 与既有语义一致。
   */
  const [stageToDelete, setStageToDelete] = useState<{ round: number; index: number } | null>(null);
  const [activeRound, setActiveRound] = useState(1);

  const issues = validateDropDraft(draft);
  const issueFor = (path: string) => issues.find((i) => i.path === path)?.message ?? null;
  const effectiveRound = Math.min(Math.max(1, activeRound), Math.max(1, draft.rounds));
  const currentStages = draftStagesForRound(draft, effectiveRound);
  const roundStageCounts = Array.from({ length: Math.max(1, draft.rounds) }, (_, i) => draftStagesForRound(draft, i + 1).length);
  /**
   * R02 FIX3：`validateDropDraft` 对逐轮覆盖返回的 path 是
   * `roundOverrides[<数组下标>].stages[i].xxx`，而旧行内错误只查 `stages[i]`，
   * 于是第 1 轮 override / 其它轮的错误全部丢失。这里按**当前渲染轮**计算
   * 它在 roundOverrides 中的真实下标；未覆盖的默认轮回退查 `stages[i]`。
   */
  const currentOverrideIdx = draft.roundOverrides?.findIndex((o) => o.roundIndex === effectiveRound) ?? -1;
  const stageIssuePath = (i: number) =>
    currentOverrideIdx >= 0 ? `roundOverrides[${currentOverrideIdx}].stages[${i}]` : `stages[${i}]`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {scopeNote ? (
        <div
          style={{
            padding: '8px 10px',
            background: 'var(--paper-3)',
            borderLeft: '3px solid var(--warn)',
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--ink-2)',
          }}
        >
          {scopeNote}
        </div>
      ) : null}

      {/* 轮数与休息 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
        <DraftNumberField
          label="轮数"
          value={draft.rounds}
          min={MIN_ROUNDS}
          max={MAX_ROUNDS}
          form={form}
          fieldId={`${fieldPrefix}.rounds`}
          onCommit={(v) => { onChange(setDropDraftRounds(draft, v)); setActiveRound((r) => Math.min(r, Math.max(1, v))); }}
        />
        <DraftNumberField
          label="阶段间休息"
          value={draft.restInSec}
          min={0}
          max={600}
          unit="秒"
          form={form}
          fieldId={`${fieldPrefix}.restIn`}
          onCommit={(v) => onChange({ ...draft, restInSec: v })}
        />
        <DraftNumberField
          label="轮间休息"
          value={draft.restAfterSec}
          min={0}
          max={3600}
          unit="秒"
          form={form}
          fieldId={`${fieldPrefix}.restAfter`}
          onCommit={(v) => onChange({ ...draft, restAfterSec: v })}
        />
      </div>
      {issueFor('rounds') ? (
        <div role="alert" data-testid="drop-rounds-error" style={{ color: 'var(--brick)', fontSize: 12 }}>
          {issueFor('rounds')}
        </div>
      ) : null}

      {/* R02：逐轮阶段（默认 stages 为第 1 轮；其它轮可独立配置） */}
      {draft.rounds > 1 ? (
        <div className="segmented" role="group" aria-label="逐轮阶段配置" style={{ flexWrap: 'wrap' }}>
          {roundStageCounts.map((count, i) => (
            <button
              key={i}
              type="button"
              data-testid={`drop-round-tab-${i + 1}`}
              aria-pressed={effectiveRound === i + 1}
              onClick={() => setActiveRound(i + 1)}
              style={{ fontSize: 12, minWidth: 72 }}
            >
              第 {i + 1} 轮 · {count} 阶段
            </button>
          ))}
        </div>
      ) : null}

      {/* 阶段 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>{effectiveRound === 1 ? '阶段' : `第 ${effectiveRound} 轮阶段`}（{currentStages.length}）</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm btn-ghost"
              disabled={currentStages.length >= MAX_STAGES}
              onClick={() => onChange(addStageToRound(draft, effectiveRound))}
            >
              + 加阶段
            </button>
          </div>
        </div>

        {currentStages.map((st, i) => {
          const ids = stageFieldIds(fieldPrefix, i, st.toFailure, effectiveRound);
          return (
          <div
            key={`${effectiveRound}-${i}`}
            data-drop-stage={i}
            data-drop-round={effectiveRound}
            data-drop-prefix={fieldPrefix}
            data-to-failure={st.toFailure ? '1' : '0'}
            style={{
              padding: '10px 0',
              borderTop: i === 0 ? '1.5px solid var(--rule-strong)' : '1px dashed var(--rule)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--f-mono)', fontSize: 12, color: 'var(--ink-4)', minWidth: 52 }}>
                阶段 {i + 1}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minWidth: 44, padding: 0 }}
                  disabled={i === 0}
                  aria-label={`阶段 ${i + 1} 上移`}
                  onClick={() => onChange(moveStageInRound(draft, effectiveRound, i, -1))}
                >
                  ↑
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minWidth: 44, padding: 0 }}
                  disabled={i === currentStages.length - 1}
                  aria-label={`阶段 ${i + 1} 下移`}
                  onClick={() => onChange(moveStageInRound(draft, effectiveRound, i, 1))}
                >
                  ↓
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minWidth: 44, minHeight: 44, padding: 0, color: 'var(--brick)' }}
                  disabled={currentStages.length <= MIN_STAGES}
                  aria-label={`删除阶段 ${i + 1}`}
                  onClick={() => setStageToDelete({ round: effectiveRound, index: i })}
                >
                  ×
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8 }}>
              {/*
                V4-03 修复 F4-I01：力竭只意味着「不要求次数目标」，重量仍然可编辑，
                仍然必须满足 0–999。旧实现把三个字段一起用 `st.toFailure ? undefined : form`
                注销，于是力竭阶段重量填 1000 只有局部红字，父 flushAll 通过 →
                保存旧重量并关窗。现在「重量」始终注册 form/fieldId，
                只有真正被 disabled 的次数下限/上限才不注册。
              */}
              <DraftNumberField
                label="重量"
                nullable
                placeholder="—"
                value={st.weightKg}
                min={0}
                max={999}
                integer={false}
                unit="kg"
                form={form}
                fieldId={ids.weight}
                onCommit={(v) => onChange(updateStageInRound(draft, effectiveRound, i, { weightKg: v }))}
              />
              <DraftNumberField
                label="次数下限"
                value={st.repsMin ?? 0}
                min={0}
                max={500}
                disabled={st.toFailure}
                form={ids.repsMin ? form : undefined}
                fieldId={ids.repsMin}
                onCommit={(v) => onChange(updateStageInRound(draft, effectiveRound, i, { repsMin: v, ...(st.toFailure ? { toFailure: false } : {}) }))}
              />
              <DraftNumberField
                label="次数上限"
                value={st.repsMax ?? 0}
                min={0}
                max={500}
                disabled={st.toFailure}
                form={ids.repsMax ? form : undefined}
                fieldId={ids.repsMax}
                onCommit={(v) => onChange(updateStageInRound(draft, effectiveRound, i, { repsMax: v, ...(st.toFailure ? { toFailure: false } : {}) }))}
              />
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 8,
                fontSize: 12.5,
                color: 'var(--ink-3)',
                minHeight: 32,
              }}
            >
              <input
                type="checkbox"
                checked={st.toFailure}
                onChange={(e) => {
                  /**
                   * V3-04 关键修复：
                   * 取消力竭时必须同时给出一组合法次数范围，否则「非力竭阶段必须有次数范围」
                   * 的校验会把这次变更退回去，用户永远改不成普通次数（审查 I01）。
                   * 这里先填「上次范围」或合理默认 8–12，再允许用户编辑。
                   */
                  const next = e.target.checked
                    ? { toFailure: true }
                    : {
                        toFailure: false,
                        repsMin: st.repsMin ?? 8,
                        repsMax: st.repsMax ?? 12,
                      };
                  onChange(updateStageInRound(draft, effectiveRound, i, next));
                }}
                style={{ width: 20, height: 20, accentColor: 'var(--brick)' }}
              />
              本阶段目标为技术性力竭（实际仍记录真实次数）
            </label>

            {issueFor(`${stageIssuePath(i)}.reps`) ? (
              <div role="alert" data-drop-error="reps" style={{ color: 'var(--brick)', fontSize: 12, marginTop: 2 }}>
                {issueFor(`${stageIssuePath(i)}.reps`)}
              </div>
            ) : null}
            {issueFor(`${stageIssuePath(i)}.weightKg`) ? (
              <div role="alert" data-drop-error="weight" style={{ color: 'var(--brick)', fontSize: 12, marginTop: 2 }}>
                {issueFor(`${stageIssuePath(i)}.weightKg`)}
              </div>
            ) : null}
            {i < currentStages.length - 1 ? (
              <div className="field" style={{ marginTop: 6 }}>
                <label htmlFor={ids.rest}>短间歇（秒）</label>
                <DraftNumberField
                  label="短间歇"
                  value={st.restAfterSec ?? draft.restInSec}
                  min={0}
                  max={600}
                  unit="秒"
                  form={form}
                  fieldId={ids.rest}
                  onCommit={(v) => onChange(updateStageInRound(draft, effectiveRound, i, { restAfterSec: v }))}
                />
                {issueFor(`${stageIssuePath(i)}.restAfterSec`) ? (
                  <div role="alert" data-drop-error="rest" style={{ color: 'var(--brick)', fontSize: 12 }}>
                    {issueFor(`${stageIssuePath(i)}.restAfterSec`)}
                  </div>
                ) : null}
              </div>
            ) : (
              <span style={{ display: 'block', marginTop: 6, fontSize: 12, color: 'var(--ink-3)' }}>
                末阶段直接接整轮休息（不叠加短间歇）
              </span>
            )}
          </div>
          );
        })}
      </div>

      {/* 预览 */}
      <div
        style={{
          padding: '10px 12px',
          background: 'var(--paper-3)',
          fontSize: 12.5,
          lineHeight: 1.65,
          color: 'var(--ink-2)',
        }}
      >
        <strong style={{ display: 'block', marginBottom: 2 }}>预览</strong>
        <span style={{ overflowWrap: 'anywhere' }}>{describeDropDraft(draft)}</span>
        <div style={{ marginTop: 4, color: 'var(--ink-3)' }}>
          阶段间休 {draft.restInSec} 秒，轮间休 {Math.round(draft.restAfterSec / 60)} 分钟；
          {draft.rounds} 轮 = {draft.rounds} 个正式大组
        </div>
      </div>

      {issues.length ? (
        <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5 }}>
          还有 {issues.length} 处需要修正才能保存
        </div>
      ) : null}

      {/*
        L03：删除阶段确认。取消 = 什么都不改（草稿里的数字全部保留）；
        确认 = 只改本地配置草稿，仍然要按「保存这个配置」才落库。
      */}
      <Confirm
        open={stageToDelete !== null}
        title="删除这个阶段？"
        body={
          stageToDelete !== null
            ? `将删除第 ${stageToDelete.round} 轮的第 ${stageToDelete.index + 1} 阶段。当前还没保存的数字会保留在草稿里。`
            : ''
        }
        confirmText="是"
        cancelText="否"
        danger
        onCancel={() => setStageToDelete(null)}
        onConfirm={() => {
          if (stageToDelete === null) return;
          const { round, index } = stageToDelete;
          setStageToDelete(null);
          // 只有这里是唯一改动点；取消路径不会走到
          if (index >= 0 && index < draftStagesForRound(draft, round).length) {
            onChange(removeStageFromRound(draft, round, index));
          }
        }}
      />
    </div>
  );
}
