/* F10：补位（FLIP）的生命周期契约 —— 用最小 DOM 替身直接执行生产函数。
   这里证明的是**可判定的行为契约**（只动向上位移、先归位再过渡、
   任何收尾都不留 translate/transition、非删除位移一律不动），
   不是真实浏览器的逐帧渲染证据；后者由真实 Chrome 证据与 Codex 独立复验负责。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFLOW_MS, applyReflowAnimation } from '../src/ui/deleteDissolve';

interface FakeStyle {
  props: Map<string, string>;
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
  getPropertyValue(name: string): string;
}

class FakeElement {
  style: FakeStyle;
  isConnected = true;
  constructor(public id: string, public top: number) {
    const props = new Map<string, string>();
    this.style = {
      props,
      setProperty: (name, value) => {
        props.set(name, value);
      },
      removeProperty: (name) => {
        props.delete(name);
      },
      getPropertyValue: (name) => props.get(name) ?? '',
    };
  }
  getAttribute(name: string): string | null {
    return name === 'data-reorder-id' ? this.id : null;
  }
  getBoundingClientRect() {
    return { top: this.top, left: 0, width: 320, height: 132 } as DOMRect;
  }
}

interface Harness {
  elements: FakeElement[];
  listeners: Array<{ type: string; fn: () => void }>;
  rafQueue: Array<() => void>;
  timeoutQueue: Array<() => void>;
  flushRaf(): void;
  flushTimeout(): void;
  dispatchDoc(type: string): void;
  restore(): void;
}

function installDom(elements: FakeElement[]): Harness {
  const listeners: Array<{ type: string; fn: () => void }> = [];
  const rafQueue: Array<() => void> = [];
  const timeoutQueue: Array<() => void> = [];
  let rafSeq = 0;
  const rafIds = new Map<number, () => void>();
  const savedDocument = (globalThis as { document?: unknown }).document;
  const savedWindow = (globalThis as { window?: unknown }).window;

  const doc = {
    body: { offsetHeight: 1000 },
    querySelectorAll: (sel: string) => (sel === '[data-reorder-id]' ? elements : []),
    addEventListener: (type: string, fn: () => void) => {
      listeners.push({ type, fn });
    },
    removeEventListener: (type: string, fn: () => void) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const win = {
    scrollY: 0,
    requestAnimationFrame: (cb: () => void) => {
      rafSeq += 1;
      rafIds.set(rafSeq, cb);
      rafQueue.push(cb);
      return rafSeq;
    },
    cancelAnimationFrame: (id: number) => {
      const cb = rafIds.get(id);
      rafIds.delete(id);
      if (cb) {
        const i = rafQueue.indexOf(cb);
        if (i >= 0) rafQueue.splice(i, 1);
      }
    },
    setTimeout: (cb: () => void) => {
      timeoutQueue.push(cb);
      return timeoutQueue.length;
    },
    clearTimeout: () => undefined,
  };
  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { window?: unknown }).window = win;

  return {
    elements,
    listeners,
    rafQueue,
    timeoutQueue,
    flushRaf() {
      const queued = rafQueue.splice(0, rafQueue.length);
      for (const cb of queued) cb();
    },
    flushTimeout() {
      const queued = timeoutQueue.splice(0, timeoutQueue.length);
      for (const cb of queued) cb();
    },
    dispatchDoc(type: string) {
      for (const l of [...listeners]) if (l.type === type) l.fn();
    },
    restore() {
      (globalThis as { document?: unknown }).document = savedDocument;
      (globalThis as { window?: unknown }).window = savedWindow;
    },
  };
}

let harness: Harness | null = null;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe('F10 补位：只对真实向上位移生效', () => {
  it('删除前的旧顶端被还原成反向 translate，下一帧才过渡到 0', () => {
    const card = new FakeElement('ex-3', 268); // 删除后已在最终位置
    const still = new FakeElement('ex-1', 100);
    harness = installDom([card, still]);
    const prevTops = new Map([
      ['ex-1', 100], // 没动
      ['ex-3', 400], // 原位置，被删除的卡顶上去 132px
    ]);

    const cleanup = applyReflowAnimation(prevTops);
    expect(cleanup).toBeTypeOf('function');
    // 第一帧：先落在旧位置，且不能带过渡（否则会瞬移到终点）
    expect(card.style.getPropertyValue('translate')).toBe('0 132px');
    expect(card.style.getPropertyValue('transition')).toBe('none');
    // 没有移动的卡完全不动
    expect(still.style.getPropertyValue('translate')).toBe('');
    expect(still.style.getPropertyValue('transition')).toBe('');

    harness.flushRaf();
    expect(card.style.getPropertyValue('translate')).toBe('0 0');
    expect(card.style.getPropertyValue('transition')).toBe(`translate ${REFLOW_MS}ms cubic-bezier(.22,.61,.36,1)`);
    cleanup?.();
  });

  it('向下移动（例如失败横幅把列表推下去）不产生任何补位', () => {
    const card = new FakeElement('ex-2', 400);
    harness = installDom([card]);
    const cleanup = applyReflowAnimation(new Map([['ex-2', 268]]));
    expect(cleanup).toBeNull();
    expect(card.style.getPropertyValue('translate')).toBe('');
  });

  it('没有任何卡移动时返回 null（调用方据此保留待生效批次）', () => {
    const card = new FakeElement('ex-1', 100);
    harness = installDom([card]);
    expect(applyReflowAnimation(new Map([['ex-1', 100]]))).toBeNull();
  });

  it('空快照直接返回 null，不做任何 DOM 写入', () => {
    const card = new FakeElement('ex-1', 100);
    harness = installDom([card]);
    expect(applyReflowAnimation(new Map())).toBeNull();
  });
});

describe('F10 补位：收尾不留残留', () => {
  it('用户一按下就立即收尾：translate/transition 与监听全部清掉', () => {
    const card = new FakeElement('ex-3', 268);
    harness = installDom([card]);
    const cleanup = applyReflowAnimation(new Map([['ex-3', 400]]));
    harness.flushRaf();
    expect(harness.listeners.map((l) => l.type).sort()).toEqual(['pointerdown', 'touchstart']);

    harness.dispatchDoc('pointerdown');
    expect(card.style.getPropertyValue('translate')).toBe('');
    expect(card.style.getPropertyValue('transition')).toBe('');
    expect(harness.listeners).toHaveLength(0);
    cleanup?.();
  });

  it('超时也会收尾，且重复收尾幂等', () => {
    const card = new FakeElement('ex-3', 268);
    harness = installDom([card]);
    const cleanup = applyReflowAnimation(new Map([['ex-3', 400]]));
    harness.flushTimeout();
    expect(card.style.getPropertyValue('translate')).toBe('');
    expect(harness.listeners).toHaveLength(0);
    cleanup?.();
    cleanup?.();
    expect(card.style.getPropertyValue('translate')).toBe('');
  });

  it('已经卸载/被替换的卡不再被写样式（撤销恢复出的新卡不受旧回调影响）', () => {
    const card = new FakeElement('ex-3', 268);
    harness = installDom([card]);
    const cleanup = applyReflowAnimation(new Map([['ex-3', 400]]));
    card.isConnected = false;
    harness.flushRaf();
    expect(card.style.getPropertyValue('translate')).toBe('0 132px');
    cleanup?.();
    // 未连接的元素即使有残留也只会被跳过，不会清掉别人的样式
    expect(card.style.getPropertyValue('transition')).toBe('none');
  });
});
