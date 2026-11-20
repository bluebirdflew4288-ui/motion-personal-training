import type { CoachPlanDraft, CoachPlanDraftExercise } from './coachStorage';

interface Props {
  draft: CoachPlanDraft;
  busy: boolean;
  error?: string;
  onChange: (draft: CoachPlanDraft) => void;
  onConfirm: (draft: CoachPlanDraft) => void;
}

export function CoachDraftCard({ draft, busy, error, onChange, onConfirm }: Props) {
  const disabled = busy || Boolean(draft.confirmedPlanId);
  const editExercise = (dayIndex: number, exerciseIndex: number, patch: Partial<CoachPlanDraftExercise>) => {
    onChange({
      ...draft,
      days: draft.days.map((day, index) => index !== dayIndex ? day : {
        ...day,
        exercises: day.exercises.map((ex, i) => i === exerciseIndex ? { ...ex, ...patch } : ex),
      }),
    });
  };

  return (
    <section className="coach-draft-card" data-testid="coach-plan-draft-card">
      <strong>{draft.confirmedPlanId ? '已创建计划' : '计划草稿'}</strong>
      <label className="coach-draft-field">
        <span>计划名称</span>
        <input data-testid="coach-draft-plan-name" value={draft.planName} disabled={disabled}
          onChange={(e) => onChange({ ...draft, planName: e.target.value })} />
      </label>
      {draft.warnings?.length ? <ul>{draft.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      {draft.days.map((day, di) => (
        <div key={di} className="coach-draft-day">
          <label className="coach-draft-field">
            <span>训练日 {di + 1}</span>
            <input value={day.dayName} disabled={disabled}
              onChange={(e) => onChange({
                ...draft,
                days: draft.days.map((item, i) => i === di ? { ...item, dayName: e.target.value } : item),
              })} />
          </label>
          {day.exercises.map((ex, ei) => (
            <details key={ei} className="coach-draft-exercise">
              <summary>
                {ex.name || '待填动作'} · {ex.sets || '待填'}{ex.kind === 'dropSet' ? ' 轮' : ' 组'}
                {ex.kind === 'straight' && ' × ' + (ex.repsMin || '待填') + '–' + (ex.repsMax || '待填')}
                {ex.weightMode === 'bodyweight' ? ' · 自重' : ex.suggestedWeightKg != null && ex.kind === 'straight'
                  ? ' · ' + ex.suggestedWeightKg + ' kg' + (ex.dumbbellBasis === 'per_hand' ? '／每手' : ex.dumbbellBasis === 'total' ? '／合计' : '')
                  : ''}
              </summary>
              <fieldset disabled={disabled}>
                <label>动作<input value={ex.name} onChange={(e) => editExercise(di, ei, { name: e.target.value })} /></label>
                <label>{ex.kind === 'dropSet' ? '轮数' : '组数'}
                  <input type="number" min={1} value={ex.sets || ''}
                    onChange={(e) => editExercise(di, ei, { sets: Number(e.target.value) })} />
                </label>
                <label>负重方式
                  <select value={ex.weightMode}
                    onChange={(e) => editExercise(di, ei, { weightMode: e.target.value === 'bodyweight' ? 'bodyweight' : 'external' })}>
                    <option value="external">负重</option><option value="bodyweight">自重</option>
                  </select>
                </label>
                {ex.weightMode === 'external' && (
                  <label>重量口径
                    <select value={ex.dumbbellBasis ?? ''} onChange={(e) => editExercise(di, ei, {
                      dumbbellBasis: e.target.value === 'per_hand' || e.target.value === 'total' ? e.target.value : undefined,
                    })}>
                      <option value="">未指定</option><option value="per_hand">每手</option><option value="total">合计</option>
                    </select>
                  </label>
                )}
                {ex.kind === 'straight' ? (
                  <>
                    <label>最少次数<input type="number" min={1} value={ex.repsMin || ''}
                      onChange={(e) => editExercise(di, ei, { repsMin: Number(e.target.value) })} /></label>
                    <label>最多次数<input type="number" min={1} value={ex.repsMax || ''}
                      onChange={(e) => editExercise(di, ei, { repsMax: Number(e.target.value) })} /></label>
                    {ex.weightMode === 'external' && (
                      <label>重量（kg）<input type="number" min={0} step="any" placeholder="未填" value={ex.suggestedWeightKg ?? ''}
                        onChange={(e) => editExercise(di, ei, {
                          suggestedWeightKg: e.target.value === '' ? null : Number(e.target.value),
                        })} /></label>
                    )}
                  </>
                ) : ex.stages?.map((stage, si) => {
                  const editStage = (patch: Partial<typeof stage>) => editExercise(di, ei, {
                    stages: ex.stages?.map((item, i) => i === si ? { ...item, ...patch } : item),
                  });
                  return (
                    <div key={si} className="coach-draft-stage">
                      <label>阶段 {si + 1}<input value={stage.label} onChange={(e) => editStage({ label: e.target.value })} /></label>
                      <label>最少次数<input type="number" min={1} value={stage.repsMin || ''}
                        onChange={(e) => editStage({ repsMin: Number(e.target.value) })} /></label>
                      <label>最多次数<input type="number" min={1} value={stage.repsMax || ''}
                        onChange={(e) => editStage({ repsMax: Number(e.target.value) })} /></label>
                      {ex.weightMode === 'external' && (
                        <label>重量（kg）<input type="number" min={0} step="any" placeholder="未填" value={stage.weightKg ?? ''}
                          onChange={(e) => editStage({ weightKg: e.target.value === '' ? null : Number(e.target.value) })} /></label>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            </details>
          ))}
        </div>
      ))}
      {error && <p role="alert" className="coach-receipt-error">{error}</p>}
      {!draft.confirmedPlanId && (
        <div className="coach-draft-actions">
          <button type="button" className="btn btn-sm btn-primary" disabled={busy}
            data-testid="coach-plan-draft-confirm-btn" onClick={() => onConfirm(draft)}>
            {busy ? '创建中…' : '创建计划'}
          </button>
        </div>
      )}
    </section>
  );
}
