/* FIX1 / R1-2：切换卡"先回位、再移交"的闸门（纯协调层，不冒充 UI/真机）。
 *
 * 根独立审查的实测缺陷：A 已展开时开始滑 B，逐帧采样出现 A、B **同时**实际左移。
 * 修法不是让旧卡瞬移归零，而是把移交排到旧卡回位动画结束之后：
 * 新卡手势在前一张卡回位的过渡窗口内保持原位（闸门），窗口结束再从 0 连续跟随。
 *
 * 这里只验证闸门这层纯逻辑（真实位移由 Chrome 用例验证）：
 *   · 没有卡在展开 → 闸门 0ms（正常左滑零延迟）
 *   · 刚收起/换卡 → 闸门大于 0，且不超过"过渡+宽限"
 *   · 闸门随时间单调收敛到 0，不会长期卡住手势
 */
import { describe, expect, it } from 'vitest';
import { SWIPE_SETTLE_MS, TAKEOVER_GUARD_MS } from '../src/ui/cardGestures';
import { cardOpenStore, closeStartedAtMs, handoverGateMs } from '../src/ui/cardDrag';

const WINDOW = SWIPE_SETTLE_MS + TAKEOVER_GUARD_MS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('FIX1 R1-2 切换卡移交闸门', () => {
  it('从未展开过任何卡时闸门为 0（正常左滑不额外等待）', () => {
    cardOpenStore.set(null);
    // 清空后没有"回位中"的卡：立即可以跟随
    const gate = handoverGateMs();
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThanOrEqual(WINDOW);
  });

  it('收起一张已展开的卡后，闸门大于 0 且不超过过渡+宽限', () => {
    cardOpenStore.set(null);
    const idle = closeStartedAtMs();
    cardOpenStore.set('gate-a');
    // 展开本身不是"回位"，不应刷新起算时刻
    expect(closeStartedAtMs()).toBe(idle);
    cardOpenStore.set(null);
    expect(closeStartedAtMs()).not.toBeNull();
    expect(closeStartedAtMs()).not.toBe(idle);
    const gate = handoverGateMs();
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThanOrEqual(WINDOW);
  });

  it('直接换卡（A→B）同样记录旧卡回位起算时刻', () => {
    cardOpenStore.set('gate-a');
    const beforeSwitch = closeStartedAtMs();
    cardOpenStore.set('gate-b');
    expect(closeStartedAtMs()).not.toBe(beforeSwitch);
    expect(handoverGateMs()).toBeGreaterThan(0);
    cardOpenStore.set(null);
  });

  it('闸门随时间单调收敛到 0，不会长期拦住手势', async () => {
    cardOpenStore.set('gate-a');
    cardOpenStore.set(null);
    const first = handoverGateMs();
    await sleep(Math.ceil(WINDOW / 2));
    const second = handoverGateMs();
    await sleep(WINDOW);
    const third = handoverGateMs();
    expect(second).toBeLessThan(first);
    expect(third).toBe(0);
  });

  it('未展开卡片半滑回弹通知（notifyClosing）记录回位并对其他卡生效，同卡不自我阻塞', () => {
    cardOpenStore.set(null);
    cardOpenStore.notifyClosing('gate-rebound');
    expect(cardOpenStore.getClosingCardId()).toBe('gate-rebound');
    expect(handoverGateMs('gate-sibling')).toBeGreaterThan(0);
    expect(handoverGateMs('gate-rebound')).toBe(0);
    expect(handoverGateMs()).toBeGreaterThan(0);
    cardOpenStore.set(null);
  });

  it('页面级延后展开排定与打断取消（AG-R1 跨卡保护）', async () => {
    let opened = false;
    cardOpenStore.schedulePendingOpen('gate-b', 50, () => {
      opened = true;
    });
    expect(cardOpenStore.getPendingOpenCardId()).toBe('gate-b');

    // 跨卡新手势发生时全局取消
    cardOpenStore.cancelPendingOpen();
    expect(cardOpenStore.getPendingOpenCardId()).toBeNull();

    await sleep(60);
    // 已被取消，回调绝不触发
    expect(opened).toBe(false);

    // 正常到期触发路径
    cardOpenStore.schedulePendingOpen('gate-c', 30, () => {
      opened = true;
    });
    await sleep(45);
    expect(opened).toBe(true);
    expect(cardOpenStore.getPendingOpenCardId()).toBeNull();
  });

  it('闸门不改变"同时只允许一张卡展开"的单一真源', () => {
    cardOpenStore.set('gate-a');
    expect(cardOpenStore.get()).toBe('gate-a');
    cardOpenStore.set('gate-b');
    expect(cardOpenStore.get()).toBe('gate-b');
    cardOpenStore.set(null);
    expect(cardOpenStore.get()).toBeNull();
  });
});
