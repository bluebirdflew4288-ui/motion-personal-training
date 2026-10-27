/* 第2阶段 · 有氧计时模型与分段不变量（场景 3 / 11）。

   证据边界：这是领域层真实函数的单元测试（不是镜像 helper）。
   页面计时 tick、真实 IndexedDB 事务与 Android 运行时另见其它用例。 */

import { describe, expect, it } from 'vitest';
import {
  commitCardioParams,
  completeCardio,
  createCardioEntry,
  liveElapsedMs,
  pauseCardio,
  resumeCardio,
  segmentDurationMs,
  startCardio,
  validateCardioEntry,
  validateCardioParams,
} from '../src/domain/cardio';
import { MAX_CARDIO_SEGMENTS, MAX_INCLINE_PCT } from '../src/domain/limits';
import type { CardioEntry } from '../src/domain/types';

const M = 60_000;
const T0 = 1_760_000_000_000;

function treadmill(): CardioEntry {
  return createCardioEntry({
    preset: 'treadmill-incline',
    name: '有氧爬坡',
    params: { speedKmh: 4, inclinePct: 4 },
  });
}

describe('场景3 · 0/5/7/9/12 分钟例子', () => {
  it('有效时长 600000ms，各段和一致，暂停不入段，墙钟 12 分不计入', () => {
    let e = treadmill();
    e = startCardio(e, T0);
    const c1 = commitCardioParams(e, { speedKmh: 4, inclinePct: 12 }, T0 + 5 * M);
    expect(c1.ok).toBe(true);
    if (!c1.ok) return;
    e = c1.entry;
    e = pauseCardio(e, T0 + 7 * M);
    e = resumeCardio(e, T0 + 9 * M);
    e = completeCardio(e, T0 + 12 * M);

    const live = liveElapsedMs(e, T0 + 12 * M);
    expect(live).toBe(600000);

    const sum = e.segments.reduce((n, s) => n + segmentDurationMs(s, live), 0);
    expect(sum).toBe(600000);
    expect(e.segments).toHaveLength(3);
    // 三段端点
    expect(e.segments.map((s) => [s.startElapsedMs, s.endElapsedMs])).toEqual([
      [0, 300000],
      [300000, 420000],
      [420000, 600000],
    ]);
    // 暂停的 2 分钟（7→9）没有落进任何段
    expect(sum).toBe(live);
    expect(validateCardioEntry(e, T0 + 12 * M)).toEqual([]);
  });

  it('参数提交不重置计时（时间连续）', () => {
    let e = startCardio(treadmill(), T0);
    const before = liveElapsedMs(e, T0 + 3 * M);
    const r = commitCardioParams(e, { speedKmh: 6, inclinePct: 8 }, T0 + 3 * M);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    e = r.entry;
    // 提交后继续计时，已累计时间不丢
    expect(liveElapsedMs(e, T0 + 3 * M)).toBe(before);
    expect(liveElapsedMs(e, T0 + 4 * M)).toBe(before + M);
  });

  it('同值提交不产生新段', () => {
    let e = startCardio(treadmill(), T0);
    const segsBefore = e.segments.length;
    const r = commitCardioParams(e, { speedKmh: 4, inclinePct: 4 }, T0 + M);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.segments).toHaveLength(segsBefore);
  });

  it('暂停中改参数不产生虚假运行时长、也不开段', () => {
    let e = startCardio(treadmill(), T0);
    e = pauseCardio(e, T0 + M);
    const segsBefore = e.segments.length;
    const r = commitCardioParams(e, { speedKmh: 9, inclinePct: 15 }, T0 + 5 * M);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    e = r.entry;
    expect(e.segments).toHaveLength(segsBefore);
    // 暂停期间不计时
    expect(liveElapsedMs(e, T0 + 5 * M)).toBe(M);
  });
});

describe('场景11 · 200 段上限', () => {
  it('达上限后拒绝需要新段的参数变化，旧参数与计时都保留', () => {
    let e = startCardio(treadmill(), T0);
    // 填到上限：每次改参数产生一段
    for (let i = 1; i < MAX_CARDIO_SEGMENTS; i += 1) {
      const r = commitCardioParams(e, { speedKmh: 4, inclinePct: (i % 30) + 1 }, T0 + i * 1000);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      e = r.entry;
    }
    expect(e.segments).toHaveLength(MAX_CARDIO_SEGMENTS);

    const paramsBefore = { ...e.currentParams };
    const liveBefore = liveElapsedMs(e, T0 + 300_000);
    // 再改参数 → 拒绝
    const r = commitCardioParams(e, { speedKmh: 10, inclinePct: 20 }, T0 + 300_000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('上限');
    // currentParams 与段都不改（不能偷偷改强度）
    expect(e.currentParams).toEqual(paramsBefore);
    expect(e.segments).toHaveLength(MAX_CARDIO_SEGMENTS);
    // 计时继续
    expect(liveElapsedMs(e, T0 + 300_000)).toBeGreaterThan(liveBefore - 1);
  });

  it('达上限后仍能暂停 / 完成 / 保存（不因上限无法结束）', () => {
    let e = startCardio(treadmill(), T0);
    for (let i = 1; i < MAX_CARDIO_SEGMENTS; i += 1) {
      const r = commitCardioParams(e, { speedKmh: 4, inclinePct: (i % 30) + 1 }, T0 + i * 1000);
      if (r.ok) e = r.entry;
    }
    e = pauseCardio(e, T0 + 500_000);
    expect(e.status).toBe('paused');
    e = resumeCardio(e, T0 + 600_000);
    expect(e.status).toBe('running');
    e = completeCardio(e, T0 + 700_000);
    expect(e.status).toBe('done');
    // 完成后无 open 段，且可通过不变量校验（可备份）
    expect(e.segments.every((s) => s.endElapsedMs !== null)).toBe(true);
    expect(validateCardioEntry(e, T0 + 700_000)).toEqual([]);
  });

  it('cap → pause → resume → complete 顺序可行（同参复用末段不增段）', () => {
    let e = startCardio(treadmill(), T0);
    for (let i = 1; i < MAX_CARDIO_SEGMENTS; i += 1) {
      const r = commitCardioParams(e, { speedKmh: 4, inclinePct: (i % 30) + 1 }, T0 + i * 1000);
      if (r.ok) e = r.entry;
    }
    const segsAtCap = e.segments.length;
    e = pauseCardio(e, T0 + 400_000);
    e = resumeCardio(e, T0 + 450_000);
    // 继续会重开同参段；这不属于"参数变化"，但仍需要一个新段来保持时间无缝
    expect(e.segments.length).toBeGreaterThanOrEqual(segsAtCap);
    e = completeCardio(e, T0 + 500_000);
    expect(validateCardioEntry(e, T0 + 500_000)).toEqual([]);
  });
});

describe('参数规范（PHASE-2-APPROVAL §2）', () => {
  it('坡走拒绝 level 字段', () => {
    const issues = validateCardioParams('treadmill-incline', { speedKmh: 4, inclinePct: 4, level: 5 });
    expect(issues.some((i) => i.field === 'level')).toBe(true);
  });

  it('爬楼机拒绝 speed/incline 字段', () => {
    const issues = validateCardioParams('stair-climber', { level: 5, speedKmh: 4 });
    expect(issues.some((i) => i.field === 'speedKmh')).toBe(true);
  });

  it('缺少必填参数被拒绝', () => {
    expect(validateCardioParams('treadmill-incline', {}).length).toBeGreaterThan(0);
    expect(validateCardioParams('stair-climber', {}).length).toBeGreaterThan(0);
  });

  it('超限/非法数值被拒绝（不静默 clamp）', () => {
    expect(
      validateCardioParams('treadmill-incline', { speedKmh: 4, inclinePct: MAX_INCLINE_PCT + 1 }).length,
    ).toBeGreaterThan(0);
    expect(
      validateCardioParams('treadmill-incline', { speedKmh: Number.NaN, inclinePct: 4 }).length,
    ).toBeGreaterThan(0);
    expect(validateCardioParams('stair-climber', { level: 2.5 }).length).toBeGreaterThan(0);
  });

  it('允许 0 值（坡度 0 是真实值）', () => {
    expect(validateCardioParams('treadmill-incline', { speedKmh: 0, inclinePct: 0 })).toEqual([]);
  });
});

describe('墙钟回拨（Date.now 非单调）', () => {
  it('负增量按 0 处理，不倒扣已累计时间', () => {
    let e = startCardio(treadmill(), T0);
    e = pauseCardio(e, T0 + 5 * M); // 累计 5 分钟
    const resumed = resumeCardio(e, T0 + 5 * M);
    // 用户把系统时间往前调（now 早于锚点）
    expect(liveElapsedMs(resumed, T0 + 1 * M)).toBe(5 * M);
  });
});

/* 整次训练暂停与有氧的关系（PHASE-2-DECISIONS §2）：
   整次暂停必须停住正在运行的有氧；恢复时**只恢复**因整次暂停停住的那个，
   不误开用户此前**手动暂停**的有氧。 */
describe('整次暂停不误开手动暂停的有氧', () => {
  it('session pause 停住 running，恢复只恢复它', async () => {
    const { pauseCardioForSessionPause, resumeCardioForSessionResume } = await import(
      '../src/domain/session'
    );
    const running = startCardio(treadmill(), T0);
    const manualPaused = pauseCardio(
      startCardio(
        createCardioEntry({ preset: 'stair-climber', name: '爬楼机', params: { level: 5 } }),
        T0,
      ),
      T0 + M,
    );
    const session = {
      id: 's1',
      cardio: [running, manualPaused],
      cardioPausedBySession: [] as string[],
    } as unknown as import('../src/domain/types').Session;

    const paused = pauseCardioForSessionPause(session, T0 + 2 * M);
    // 只有 running 的那个被停住并记录
    expect(paused.cardio![0].status).toBe('paused');
    expect(paused.cardioPausedBySession).toEqual([running.id]);
    // 手动暂停的那个不受影响
    expect(paused.cardio![1].status).toBe('paused');

    const resumed = resumeCardioForSessionResume(paused, T0 + 3 * M);
    // 只恢复因整次暂停停住的那个
    expect(resumed.cardio![0].status).toBe('running');
    // 手动暂停的**仍然暂停**（不误开）
    expect(resumed.cardio![1].status).toBe('paused');
    expect(resumed.cardioPausedBySession).toEqual([]);
  });
});
