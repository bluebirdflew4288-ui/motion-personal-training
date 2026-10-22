/* 通用递减组配置面板（C01）。
   计划编辑与训练中临时调整共用同一个组件，避免两套规则漂移。
   移动端默认简洁：只在选择「递减组」时展开细项，保存前有可读预览。 */

import { useState } from 'react';
import type { DropSetDraft } from '../domain/dropSet';
import {
  MAX_ROUNDS,
  MAX_STAGES,
  MIN_ROUNDS,
  MIN_STAGES,
  addStage,
  describeDropDraft,
  moveStage,
  removeStage,
  updateStage,
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
): { weight: string; repsMin: string | undefined; repsMax: string | undefined } {
  const p = `${fieldPrefix}.s${stageIndex}`;
  return {
    weight: `${p}.weight`,
    repsMin: toFailure ? undefined : `${p}.repsMin`,
    repsMax: toFailure ? undefined : `${p}.repsMax`,
  };
}

export function DropSetEditor({ draft, onChange, scopeNote, form, fieldPrefix = 'drop' }: Props) {
  /**
   * L03：删除递减阶段前必须确认（严格「是 / 否」）。
   *
   * 关键约束：确认流程**只作用于本地配置草稿**，取消不丢任何未保存数字。
   * 这里记的是「待删除阶段的索引」，不在弹窗期间改动 draft；
   * 只有点「是」才 onChange(removeStage(...))，随后仍需用户按
   * 「保存这个配置」才真正落库 —— 与既有语义一致。
   */
  const [stageToDelete, setStageToDelete] = useState<number | null>(null);

  const issues = validateDropDraft(draft);
  const issueFor = (path: string) => issues.find((i) => i.path === path)?.message ?? null;

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
          onCommit={(v) => onChange({ ...draft, rounds: v })}
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

      <div className="segmented" role="group" aria-label="负重口径">
        {(
          [
            ['external', '外部负重'],
            ['bodyweight', '自重'],
            ['bodyweight_plus', '自重+负重'],
            ['assisted', '辅助'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            aria-pressed={draft.weightMode === v}
            onClick={() => onChange({ ...draft, weightMode: v })}
            style={{ fontSize: 12 }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 阶段 */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>阶段（{draft.stages.length}）</strong>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm btn-ghost"
              disabled={draft.stages.length >= MAX_STAGES}
              onClick={() => onChange(addStage(draft))}
            >
              + 加阶段
            </button>
          </div>
        </div>

        {draft.stages.map((st, i) => {
          const ids = stageFieldIds(fieldPrefix, i, st.toFailure);
          return (
          <div
            key={i}
            data-drop-stage={i}
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
                  onClick={() => onChange(moveStage(draft, i, -1))}
                >
                  ↑
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minWidth: 44, padding: 0 }}
                  disabled={i === draft.stages.length - 1}
                  aria-label={`阶段 ${i + 1} 下移`}
                  onClick={() => onChange(moveStage(draft, i, 1))}
                >
                  ↓
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  style={{ minWidth: 44, minHeight: 44, padding: 0, color: 'var(--brick)' }}
                  disabled={draft.stages.length <= MIN_STAGES}
                  aria-label={`删除阶段 ${i + 1}`}
                  onClick={() => setStageToDelete(i)}
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
                value={st.weightKg ?? 0}
                min={0}
                max={999}
                integer={false}
                unit="kg"
                form={form}
                fieldId={ids.weight}
                onCommit={(v) => onChange(updateStage(draft, i, { weightKg: v }))}
              />
              <DraftNumberField
                label="次数下限"
                value={st.repsMin ?? 0}
                min={0}
                max={500}
                disabled={st.toFailure}
                form={ids.repsMin ? form : undefined}
                fieldId={ids.repsMin}
                onCommit={(v) => onChange(updateStage(draft, i, { repsMin: v, ...(st.toFailure ? { toFailure: false } : {}) }))}
              />
              <DraftNumberField
                label="次数上限"
                value={st.repsMax ?? 0}
                min={0}
                max={500}
                disabled={st.toFailure}
                form={ids.repsMax ? form : undefined}
                fieldId={ids.repsMax}
                onCommit={(v) => onChange(updateStage(draft, i, { repsMax: v, ...(st.toFailure ? { toFailure: false } : {}) }))}
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
                  onChange(updateStage(draft, i, next));
                }}
                style={{ width: 20, height: 20, accentColor: 'var(--brick)' }}
              />
              本阶段目标为技术性力竭（实际仍记录真实次数）
            </label>

            {issueFor(`stages[${i}].reps`) ? (
              <div role="alert" style={{ color: 'var(--brick)', fontSize: 12, marginTop: 2 }}>
                {issueFor(`stages[${i}].reps`)}
              </div>
            ) : null}
            {issueFor(`stages[${i}].weightKg`) ? (
              <div role="alert" style={{ color: 'var(--brick)', fontSize: 12, marginTop: 2 }}>
                {issueFor(`stages[${i}].weightKg`)}
              </div>
            ) : null}
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
            ? `将删除第 ${stageToDelete + 1} 阶段。当前还没保存的数字会保留在草稿里。`
            : ''
        }
        confirmText="是"
        cancelText="否"
        danger
        onCancel={() => setStageToDelete(null)}
        onConfirm={() => {
          if (stageToDelete === null) return;
          const idx = stageToDelete;
          setStageToDelete(null);
          // 只有这里是唯一改动点；取消路径不会走到
          if (idx >= 0 && idx < draft.stages.length && draft.stages.length > MIN_STAGES) {
            onChange(removeStage(draft, idx));
          }
        }}
      />
    </div>
  );
}
