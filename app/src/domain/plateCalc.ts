/* Wave 3C.2：杠铃配片速算器（纯函数，整数克精度防浮点误差）。
   支持杆重：20 kg（标准奥杆）/ 15 kg（女杆）/ 10 kg（曲杆）/ 0 kg（空载/纯配重）
   标准片规格（单侧）：25 / 20 / 15 / 10 / 5 / 2.5 / 1.25 kg（双侧最小总步进 2.5 kg）。 */

export type BarWeightKg = 20 | 15 | 10 | 0;

export const BAR_WEIGHT_OPTIONS: ReadonlyArray<{ value: BarWeightKg; label: string; sub: string }> = [
  { value: 20, label: '20 kg', sub: '标准杆' },
  { value: 15, label: '15 kg', sub: '女杆' },
  { value: 10, label: '10 kg', sub: '曲杆' },
  { value: 0, label: '0 kg', sub: '仅算片' },
];

export const STANDARD_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25] as const;
export type StandardPlateKg = (typeof STANDARD_PLATES_KG)[number];

const STANDARD_PLATES_GRAMS = [25000, 20000, 15000, 10000, 5000, 2500, 1250] as const;
/** 双侧最小总递增量：1.25 kg × 2 = 2.5 kg = 2500 g */
const TOTAL_STEP_GRAMS = 2500;

export interface PlateCount {
  plateKg: StandardPlateKg;
  count: number;
}

export interface PlateCalcResult {
  status: 'invalid' | 'below-bar' | 'empty-bar' | 'exact' | 'nearest';
  exact: boolean;
  requestedTotalKg: number;
  barKg: BarWeightKg;
  /** 当前拆解方案实际拼出的总重量（精确匹配时 = requestedTotalKg；无法整除时 = nearestLowerKg） */
  achievedTotalKg: number;
  /** 单侧挂片总重量 */
  perSideKg: number;
  /** 单侧贪心配片明细（从大片到小片） */
  platesPerSide: PlateCount[];
  /** 单侧展开后的片序列（用于图形化渲染，最多截断保护在 UI 层处理） */
  expandedPerSide: StandardPlateKg[];
  /** 请求总重与当前可拼下界之间的差值（kg） */
  remainderKg: number;
  nearestLowerKg: number | null;
  nearestUpperKg: number | null;
}

function decomposePerSideGrams(perSideGrams: number): {
  counts: PlateCount[];
  expanded: StandardPlateKg[];
} {
  let rem = Math.max(0, Math.round(perSideGrams));
  const counts: PlateCount[] = [];
  const expanded: StandardPlateKg[] = [];

  for (let i = 0; i < STANDARD_PLATES_GRAMS.length; i += 1) {
    const g = STANDARD_PLATES_GRAMS[i];
    const plateKg = STANDARD_PLATES_KG[i];
    if (rem >= g) {
      const c = Math.floor(rem / g);
      rem -= c * g;
      counts.push({ plateKg, count: c });
      for (let k = 0; k < c; k += 1) {
        expanded.push(plateKg);
      }
    }
  }
  return { counts, expanded };
}

/**
 * 计算指定总重量与杆重下的单侧杠铃片组合。
 */
export function calculateBarbellPlates(
  totalKg: number,
  barKg: BarWeightKg = 20,
): PlateCalcResult {
  if (typeof totalKg !== 'number' || !Number.isFinite(totalKg) || totalKg < 0 || totalKg > 9999) {
    return {
      status: 'invalid',
      exact: false,
      requestedTotalKg: 0,
      barKg,
      achievedTotalKg: barKg,
      perSideKg: 0,
      platesPerSide: [],
      expandedPerSide: [],
      remainderKg: 0,
      nearestLowerKg: null,
      nearestUpperKg: null,
    };
  }

  const totalGrams = Math.round(totalKg * 1000);
  const barGrams = Math.round(barKg * 1000);

  if (totalGrams < barGrams) {
    return {
      status: 'below-bar',
      exact: false,
      requestedTotalKg: totalGrams / 1000,
      barKg,
      achievedTotalKg: barKg,
      perSideKg: 0,
      platesPerSide: [],
      expandedPerSide: [],
      remainderKg: (barGrams - totalGrams) / 1000,
      nearestLowerKg: null,
      nearestUpperKg: barKg,
    };
  }

  const loadGrams = totalGrams - barGrams;
  if (loadGrams === 0) {
    return {
      status: 'empty-bar',
      exact: true,
      requestedTotalKg: barKg,
      barKg,
      achievedTotalKg: barKg,
      perSideKg: 0,
      platesPerSide: [],
      expandedPerSide: [],
      remainderKg: 0,
      nearestLowerKg: barKg,
      nearestUpperKg: barKg,
    };
  }

  const remainderGrams = loadGrams % TOTAL_STEP_GRAMS;
  if (remainderGrams === 0) {
    const perSideGrams = loadGrams / 2;
    const { counts, expanded } = decomposePerSideGrams(perSideGrams);
    return {
      status: 'exact',
      exact: true,
      requestedTotalKg: totalGrams / 1000,
      barKg,
      achievedTotalKg: totalGrams / 1000,
      perSideKg: perSideGrams / 1000,
      platesPerSide: counts,
      expandedPerSide: expanded,
      remainderKg: 0,
      nearestLowerKg: totalGrams / 1000,
      nearestUpperKg: totalGrams / 1000,
    };
  }

  const lowerLoadGrams = Math.floor(loadGrams / TOTAL_STEP_GRAMS) * TOTAL_STEP_GRAMS;
  const upperLoadGrams = lowerLoadGrams + TOTAL_STEP_GRAMS;
  const lowerTotalGrams = barGrams + lowerLoadGrams;
  const upperTotalGrams = barGrams + upperLoadGrams;
  const perSideGrams = lowerLoadGrams / 2;
  const { counts, expanded } = decomposePerSideGrams(perSideGrams);

  return {
    status: 'nearest',
    exact: false,
    requestedTotalKg: totalGrams / 1000,
    barKg,
    achievedTotalKg: lowerTotalGrams / 1000,
    perSideKg: perSideGrams / 1000,
    platesPerSide: counts,
    expandedPerSide: expanded,
    remainderKg: (totalGrams - lowerTotalGrams) / 1000,
    nearestLowerKg: lowerTotalGrams / 1000,
    nearestUpperKg: upperTotalGrams / 1000,
  };
}
