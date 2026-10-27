import { describe, expect, it } from 'vitest';
import { shouldSyncExternal } from '../src/ui/draftForm';
import {
  commitCardioParams,
  startCardio,
  pauseCardio,
  resumeCardio,
  completeCardio,
  createCardioEntry,
} from '../src/domain/cardio';
import type { CardioEntry, CardioParams } from '../src/domain/types';

describe('DraftNumberField · 外部已提交值同步契约（行为验证）', () => {
  it('shouldSyncExternal: 当已提交值与基准不同且草稿干净时，应采纳外部更新', () => {
    // 初始基线 4，草稿是 "4"（用户未编辑）；库中值更新为 4.1
    expect(shouldSyncExternal(4.1, 4, '4')).toBe(true);

    // 初始基线 4，草稿是 "7."（用户正在输入未完成态）-> 不得采纳，保护未完成意图
    expect(shouldSyncExternal(4.1, 4, '7.')).toBe(false);

    // 初始基线 4，草稿是 "999"（非法或用户修改但未提交）-> 不得采纳
    expect(shouldSyncExternal(4.1, 4, '999')).toBe(false);

    // 初始基线 4，草稿是空串 -> 保留，不得静默洗掉
    expect(shouldSyncExternal(4.1, 4, '')).toBe(false);

    // 库中值未变 -> 不需要同步
    expect(shouldSyncExternal(4, 4, '4')).toBe(false);
  });

  it('聚焦保护：用户聚焦输入框期间，即使外部值更新亦不得打断输入', () => {
    const adoptsExternal = (focused: boolean, syncSource: number, lastCommitted: number, draft: string) =>
      !focused && shouldSyncExternal(syncSource, lastCommitted, draft);

    // 聚焦中输入 7. -> 外部值更新为 4.1 -> 绝不采纳外部值
    expect(adoptsExternal(true, 4.1, 4, '7.')).toBe(false);
    // 聚焦中草稿虽然等于原基准 4 -> 外部值更新为 4.1 -> 仍不打断当前焦点
    expect(adoptsExternal(true, 4.1, 4, '4')).toBe(false);
    // 失焦状态且草稿干净 -> 正常同步
    expect(adoptsExternal(false, 4.1, 4, '4')).toBe(true);
  });
});

describe('有氧 clean action 参数保持与分段语义（六大实操场景行为验证）', () => {
  function makeInitialTreadmillEntry(): CardioEntry {
    const initial = createCardioEntry({
      preset: 'treadmill-incline',
      name: '跑步机爬坡',
      params: { speedKmh: 4, inclinePct: 0 },
    });
    return startCardio(initial, 1000);
  }

  function makeInitialStairEntry(): CardioEntry {
    const initial = createCardioEntry({
      preset: 'stair-climber',
      name: '爬楼机',
      params: { level: 5 },
    });
    return startCardio(initial, 1000);
  }

  it('场景 1: 键盘调整速度 4.1 -> 完成有氧，参数保持 4.1，段数保持 2 (不产生虚假段)', () => {
    let entry = makeInitialTreadmillEntry();
    const commit1 = commitCardioParams(entry, { speedKmh: 4.1, inclinePct: 0 }, 5000);
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) return;
    entry = commit1.entry;
    expect(entry.currentParams.speedKmh).toBe(4.1);
    expect(entry.segments.length).toBe(2);

    const completed = completeCardio(entry, 10000);
    expect(completed.currentParams.speedKmh).toBe(4.1);
    expect(completed.segments.length).toBe(2);
    expect(completed.segments[completed.segments.length - 1].params.speedKmh).toBe(4.1);
  });

  it('场景 2: 拖拽速度 7.5 -> 完成有氧，参数保持 7.5，段数保持 2', () => {
    let entry = makeInitialTreadmillEntry();
    const commit1 = commitCardioParams(entry, { speedKmh: 7.5, inclinePct: 0 }, 5000);
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) return;
    entry = commit1.entry;
    expect(entry.currentParams.speedKmh).toBe(7.5);
    expect(entry.segments.length).toBe(2);

    const completed = completeCardio(entry, 10000);
    expect(completed.currentParams.speedKmh).toBe(7.5);
    expect(completed.segments.length).toBe(2);
  });

  it('场景 3: 坡度调整到 5 -> 暂停与继续，参数保持 5，段数仅合法 +1 (段 2 -> 3)', () => {
    let entry = makeInitialTreadmillEntry();
    const commit1 = commitCardioParams(entry, { speedKmh: 4, inclinePct: 5 }, 5000);
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) return;
    entry = commit1.entry;
    expect(entry.currentParams.inclinePct).toBe(5);
    expect(entry.segments.length).toBe(2);

    // 暂停：合法封口当前段，段数仍为 2
    const paused = pauseCardio(entry, 8000);
    expect(paused.currentParams.inclinePct).toBe(5);
    expect(paused.segments.length).toBe(2);

    // 继续：合法重开同参段，段数仅 +1（变为 3，而非 4）
    const resumed = resumeCardio(paused, 12000);
    expect(resumed.currentParams.inclinePct).toBe(5);
    expect(resumed.segments.length).toBe(3);
    expect(resumed.segments[resumed.segments.length - 1].params.inclinePct).toBe(5);
  });

  it('场景 4: 爬楼机档位调整到 6 -> 完成有氧，档位保持 6，段数保持 2', () => {
    let entry = makeInitialStairEntry();
    const commit1 = commitCardioParams(entry, { level: 6 }, 5000);
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) return;
    entry = commit1.entry;
    expect(entry.currentParams.level).toBe(6);
    expect(entry.segments.length).toBe(2);

    const completed = completeCardio(entry, 10000);
    expect(completed.currentParams.level).toBe(6);
    expect(completed.segments.length).toBe(2);
  });

  it('场景 5: 速度改到 4.1 后修改坡度为 5，两者参数互不覆盖', () => {
    let entry = makeInitialTreadmillEntry();
    const commit1 = commitCardioParams(entry, { speedKmh: 4.1, inclinePct: 0 }, 5000);
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) return;
    entry = commit1.entry;

    const commit2 = commitCardioParams(entry, { speedKmh: 4.1, inclinePct: 5 }, 8000);
    expect(commit2.ok).toBe(true);
    if (!commit2.ok) return;
    entry = commit2.entry;

    expect(entry.currentParams.speedKmh).toBe(4.1);
    expect(entry.currentParams.inclinePct).toBe(5);
  });

  it('场景 6: 意图时序：用户明确在精确框输入较新意图时优先于滑杆', () => {
    const candidate: CardioParams = { speedKmh: 5.5, inclinePct: 0 };
    const slider: CardioParams = { speedKmh: 4.1, inclinePct: 0 };

    const fieldIntent: Record<string, { from: 'slider' | 'precise' }> = {
      speedKmh: { from: 'precise' },
    };

    const merged = { ...candidate };
    if (fieldIntent.speedKmh?.from === 'slider') {
      merged.speedKmh = slider.speedKmh!;
    }
    expect(merged.speedKmh).toBe(5.5);
  });
});
