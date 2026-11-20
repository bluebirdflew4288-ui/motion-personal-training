/* Wave 3C.2：杠铃配片速算器面板（纸墨账本风，零网络纯本地速算）。 */

import { useEffect, useMemo, useState } from 'react';
import {
  BAR_WEIGHT_OPTIONS,
  calculateBarbellPlates,
  type BarWeightKg,
  type StandardPlateKg,
} from '../domain/plateCalc';
import { fmtWeight } from '../lib/format';
import { Sheet } from './Sheet';

export interface PlateCalculatorSheetProps {
  open: boolean;
  initialWeightKg?: number | null;
  exerciseName?: string;
  onClose: () => void;
  onApplyWeight?: (weightKg: number) => void;
}

function plateVisualSpec(plateKg: StandardPlateKg): {
  height: number;
  width: number;
  bg: string;
  fg: string;
  border: string;
} {
  switch (plateKg) {
    case 25:
      return { height: 74, width: 20, bg: 'var(--brick)', fg: '#fbf7ec', border: 'var(--brick)' };
    case 20:
      return { height: 68, width: 19, bg: 'var(--ink)', fg: 'var(--paper-2)', border: 'var(--ink)' };
    case 15:
      return { height: 60, width: 17, bg: 'var(--ink-2)', fg: 'var(--paper-2)', border: 'var(--ink-2)' };
    case 10:
      return { height: 52, width: 16, bg: 'var(--paper-3)', fg: 'var(--ink)', border: 'var(--ink-2)' };
    case 5:
      return { height: 42, width: 14, bg: 'var(--paper-2)', fg: 'var(--ink)', border: 'var(--ink-3)' };
    case 2.5:
      return { height: 34, width: 12, bg: 'var(--paper-2)', fg: 'var(--ink-2)', border: 'var(--ink-3)' };
    case 1.25:
      return { height: 28, width: 11, bg: 'var(--paper)', fg: 'var(--ink-3)', border: 'var(--ink-4)' };
  }
}

export function PlateCalculatorSheet({
  open,
  initialWeightKg,
  exerciseName,
  onClose,
  onApplyWeight,
}: PlateCalculatorSheetProps) {
  const [barKg, setBarKg] = useState<BarWeightKg>(20);
  const [rawWeight, setRawWeight] = useState<string>('60');

  useEffect(() => {
    if (!open) return;
    if (typeof initialWeightKg === 'number' && Number.isFinite(initialWeightKg) && initialWeightKg > 0) {
      setRawWeight(fmtWeight(initialWeightKg));
    } else {
      setRawWeight('60');
    }
  }, [open, initialWeightKg]);

  const parsedWeight = useMemo(() => {
    const trimmed = rawWeight.trim();
    if (!trimmed) return NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : NaN;
  }, [rawWeight]);

  const calc = useMemo(() => calculateBarbellPlates(parsedWeight, barKg), [parsedWeight, barKg]);

  const adjustWeight = (delta: number) => {
    const base = Number.isFinite(parsedWeight) ? parsedWeight : barKg || 20;
    const next = Math.max(0, Math.min(999, Math.round((base + delta) * 100) / 100));
    setRawWeight(fmtWeight(next));
  };

  const visualPlates = calc.expandedPerSide.slice(0, 10);
  const hiddenExtraPlates = Math.max(0, calc.expandedPerSide.length - visualPlates.length);

  return (
    <Sheet
      open={open}
      title={exerciseName ? `配片速算 · ${exerciseName}` : '杠铃配片速算'}
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8 }}>
          {onApplyWeight && Number.isFinite(parsedWeight) && parsedWeight >= 0 && parsedWeight <= 999 ? (
            (() => {
              const applyKg = Math.round((calc.exact ? calc.achievedTotalKg : parsedWeight) * 100) / 100;
              return (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="plate-calc-apply"
                  style={{ flex: 1 }}
                  onClick={() => {
                    onApplyWeight(applyKg);
                    onClose();
                  }}
                >
                  填入 {fmtWeight(applyKg)} kg
                </button>
              );
            })()
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ flex: 1 }}
            onClick={onClose}
          >
            关闭
          </button>
        </div>
      }
    >
      <div data-testid="plate-calculator-sheet" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div className="mono-label" style={{ marginBottom: 6 }}>
            空杆重量
          </div>
          <div className="segmented" role="group" aria-label="选择杠铃杆重量">
            {BAR_WEIGHT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                data-testid={`plate-bar-${opt.value}`}
                aria-pressed={barKg === opt.value}
                onClick={() => setBarKg(opt.value)}
                style={{ fontSize: 12, lineHeight: 1.25, padding: '6px 4px' }}
              >
                <span style={{ display: 'block', fontFamily: 'var(--f-num)', fontWeight: 700 }}>
                  {opt.label}
                </span>
                <span style={{ display: 'block', fontSize: 10.5, opacity: 0.8 }}>{opt.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mono-label" htmlFor="plate-calc-total-input" style={{ display: 'block', marginBottom: 6 }}>
            目标总重量（kg，含杆重）
          </label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => adjustWeight(-5)}
              style={{ minWidth: 44 }}
            >
              −5
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => adjustWeight(-2.5)}
              style={{ minWidth: 48 }}
            >
              −2.5
            </button>
            <input
              id="plate-calc-total-input"
              data-testid="plate-calc-input"
              className="input"
              type="number"
              inputMode="decimal"
              step="2.5"
              min="0"
              max="999"
              value={rawWeight}
              onChange={(e) => setRawWeight(e.target.value)}
              style={{
                flex: 1,
                textAlign: 'center',
                fontFamily: 'var(--f-num)',
                fontSize: 19,
                fontWeight: 700,
              }}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => adjustWeight(2.5)}
              style={{ minWidth: 48 }}
            >
              +2.5
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => adjustWeight(5)}
              style={{ minWidth: 44 }}
            >
              +5
            </button>
          </div>
        </div>

        <div
          className="slip"
          data-testid="plate-calc-result"
          style={{ padding: '12px 14px', background: 'var(--paper-2)' }}
        >
          {calc.status === 'invalid' ? (
            <div style={{ fontSize: 13.5, color: 'var(--ink-3)' }}>请输入有效的目标总重量（0–999 kg）。</div>
          ) : calc.status === 'below-bar' ? (
            <div style={{ fontSize: 13.5, color: 'var(--brick)', lineHeight: 1.6 }}>
              目标重量（{fmtWeight(calc.requestedTotalKg)} kg）小于当前空杆重量（{barKg} kg）。可切换更轻的杆或「0 kg 仅算片」。
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <span className="mono-label">单侧装片（左右各同）</span>
                <span style={{ fontFamily: 'var(--f-num)', fontSize: 16, fontWeight: 700 }}>
                  每侧 {fmtWeight(calc.perSideKg)} kg
                </span>
              </div>

              {/* 杠铃轴头单侧片序示意 */}
              <div
                aria-hidden="true"
                style={{
                  marginTop: 12,
                  marginBottom: 10,
                  minHeight: 82,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  background: 'var(--paper)',
                  border: '1px dashed var(--rule)',
                  overflowX: 'auto',
                }}
              >
                {/* 轴杆与挡圈 */}
                <div
                  style={{
                    width: 22,
                    height: 8,
                    background: 'var(--ink-3)',
                    flex: 'none',
                  }}
                />
                <div
                  style={{
                    width: 7,
                    height: 28,
                    background: 'var(--ink)',
                    flex: 'none',
                    marginRight: 3,
                  }}
                />
                {visualPlates.length === 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--ink-4)', marginLeft: 8 }}>
                    空杆，无需挂片
                  </span>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    {visualPlates.map((p, idx) => {
                      const spec = plateVisualSpec(p);
                      return (
                        <div
                          key={`${p}-${idx}`}
                          style={{
                            height: spec.height,
                            minWidth: spec.width,
                            padding: '0 2px',
                            background: spec.bg,
                            color: spec.fg,
                            border: `1.5px solid ${spec.border}`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontFamily: 'var(--f-num)',
                            fontSize: 9.5,
                            fontWeight: 700,
                            writingMode: 'vertical-rl',
                            textOrientation: 'mixed',
                            letterSpacing: '-0.02em',
                            flex: 'none',
                          }}
                        >
                          {fmtWeight(p)}
                        </div>
                      );
                    })}
                    {hiddenExtraPlates > 0 ? (
                      <span style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: 'var(--ink-3)', marginLeft: 4 }}>
                        +{hiddenExtraPlates}片
                      </span>
                    ) : null}
                  </div>
                )}
                <div
                  style={{
                    flex: 1,
                    minWidth: 16,
                    height: 10,
                    background: 'var(--rule-strong)',
                  }}
                />
              </div>

              {calc.platesPerSide.length === 0 ? (
                <div data-testid="plate-calc-breakdown" style={{ fontSize: 14, color: 'var(--ink-2)' }}>
                  无需挂片（空杆 {barKg} kg）
                </div>
              ) : (
                <div
                  data-testid="plate-calc-breakdown"
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 6,
                  }}
                >
                  {calc.platesPerSide.map((item) => (
                    <span
                      key={item.plateKg}
                      style={{
                        fontFamily: 'var(--f-num)',
                        fontSize: 13.5,
                        fontWeight: 600,
                        padding: '3px 8px',
                        border: '1px solid var(--rule-strong)',
                        background: 'var(--paper)',
                        color: 'var(--ink)',
                      }}
                    >
                      {fmtWeight(item.plateKg)} kg × {item.count}
                    </span>
                  ))}
                </div>
              )}

              {calc.status === 'nearest' ? (
                <div
                  data-testid="plate-calc-nearest-hint"
                  style={{
                    marginTop: 10,
                    paddingTop: 8,
                    borderTop: '1px dashed var(--rule)',
                    fontSize: 12.5,
                    color: 'var(--ink-2)',
                    lineHeight: 1.6,
                  }}
                >
                  <div>
                    标准最小片为单侧 <strong style={{ fontFamily: 'var(--f-num)' }}>1.25 kg</strong>（双侧步进 2.5 kg），
                    <strong style={{ fontFamily: 'var(--f-num)' }}> {fmtWeight(calc.requestedTotalKg)} kg </strong>
                    还差 <strong style={{ fontFamily: 'var(--f-num)', color: 'var(--brick)' }}>{fmtWeight(calc.remainderKg)} kg</strong> 无法由标准片整除；上方展示最近下界{' '}
                    <strong style={{ fontFamily: 'var(--f-num)' }}>{fmtWeight(calc.achievedTotalKg)} kg</strong>。
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                    {calc.nearestLowerKg !== null ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        data-testid="plate-calc-pick-lower"
                        onClick={() => setRawWeight(fmtWeight(calc.nearestLowerKg!))}
                      >
                        改用 {fmtWeight(calc.nearestLowerKg)} kg
                      </button>
                    ) : null}
                    {calc.nearestUpperKg !== null ? (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        data-testid="plate-calc-pick-upper"
                        onClick={() => setRawWeight(fmtWeight(calc.nearestUpperKg!))}
                      >
                        改用 {fmtWeight(calc.nearestUpperKg)} kg
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-4)' }}>
                  杆 {barKg} kg + 两侧各 {fmtWeight(calc.perSideKg)} kg = 总计 {fmtWeight(calc.achievedTotalKg)} kg
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Sheet>
  );
}
