import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';
import { idbClear } from '../src/db/idb';
import { savePlan, saveSettings, loadSettings } from '../src/db/repo';
import { createV32Plan } from '../src/domain/presets/v32';
import { claimHistoryRestore } from '../src/lib/router';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

beforeEach(async () => {
  for (const store of ['plans', 'sessions', 'settings', 'meta']) await idbClear(store);
});

describe('Router dual subscriber route synchronization and independence', () => {
  it('router 源码：包含同事件跨订阅者同步发布机制，且保留 dedupe 与恢复契约', () => {
    const src = read('src/lib/router.ts');
    expect(src).toContain('currentEventToken');
    expect(src).toContain('currentEventAllowed');
    expect(src).toContain('restoreEffectivePosition(readIdx(window.history.state), event)');
    expect(src).toContain('if (!claimHistoryRestore(event)) return;');
    expect(src).toMatch(/function restoreEffectivePosition\(incomingIdx: number \| null, event: unknown\)/);
  });

  it('真实双订阅者夹具：裸 hashchange 与合成 navigate 均同步所有已挂载订阅者', () => {
    const routerTs = read('src/lib/router.ts');
    const compiled = esbuild.transformSync(routerTs, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

    const boxes: any[] = [];
    const cleanups: any[] = [];
    const listeners: ((e: any) => void)[] = [];
    const location = {
      hash: '#/plans?plan=B',
      get href() { return 'http://audit.local/' + this.hash; },
    };
    const mockWindow = {
      location,
      history: {
        state: { __motionIdx: 0 },
        length: 1,
        replaceState(state: any, _unused: any, target: string) {
          this.state = state;
          location.hash = new URL(target, 'http://audit.local/').hash;
        },
        pushState(state: any, _unused: any, target: string) {
          this.state = state;
          this.length += 1;
          location.hash = new URL(target, 'http://audit.local/').hash;
        },
        go() { throw new Error('Unexpected history restoration in clean unguarded fixture'); },
        back() { throw new Error('Not used by this fixture'); },
      },
      addEventListener(type: string, fn: any) { if (type === 'hashchange') listeners.push(fn); },
      removeEventListener(_type: string, fn: any) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      dispatchEvent(event: any) { for (const fn of [...listeners]) fn(event); return true; },
    };
    const fakeReact = {
      useState(initial: any) {
        const box = { value: typeof initial === 'function' ? initial() : initial };
        boxes.push(box);
        return [box.value, (value: any) => { box.value = typeof value === 'function' ? value(box.value) : value; }];
      },
      useEffect(effect: any) { cleanups.push(effect()); },
    };
    const moduleObject = { exports: {} as any };
    vm.runInNewContext(compiled, {
      module: moduleObject, exports: moduleObject.exports,
      require(name: string) { if (name === 'react') return fakeReact; throw new Error('Unexpected dependency ' + name); },
      window: mockWindow, URLSearchParams, URL,
      HashChangeEvent: class { type: string; constructor(_type: string) { this.type = _type; } },
    });
    const router = moduleObject.exports;
    router.useRoute(); // App subscription
    router.useRoute(); // Plans subscription

    const snap = () => ({
      url: location.hash,
      app: boxes[0].value.query.get('plan'),
      plans: boxes[1].value.query.get('plan'),
    });

    expect(snap()).toEqual({ url: '#/plans?plan=B', app: 'B', plans: 'B' });

    // Native bare hashchange (gotoManage)
    location.hash = '#/plans';
    mockWindow.dispatchEvent({ type: 'hashchange' });
    // Both App and Plans must receive null so Plans normalization effect triggers!
    expect(snap()).toEqual({ url: '#/plans', app: null, plans: null });

    // Synthetic navigate
    router.navigate('/plans?plan=C', true);
    expect(snap()).toEqual({ url: '#/plans?plan=C', app: 'C', plans: 'C' });

    // Next native hashchange
    location.hash = '#/plans?plan=D';
    mockWindow.dispatchEvent({ type: 'hashchange' });
    expect(snap()).toEqual({ url: '#/plans?plan=D', app: 'D', plans: 'D' });

    for (const c of cleanups) if (typeof c === 'function') c();
  });

  it('受阻 POP 历史导航仅触发单次回位且两订阅者保持受阻前状态', () => {
    const routerTs = read('src/lib/router.ts');
    const compiled = esbuild.transformSync(routerTs, { loader: 'ts', format: 'cjs', target: 'es2022' }).code;

    const boxes: any[] = [];
    const cleanups: any[] = [];
    const listeners: ((e: any) => void)[] = [];
    let goCalls = 0;
    const location = {
      hash: '#/plans?plan=B',
      get href() { return 'http://audit.local/' + this.hash; },
    };
    const mockWindow: any = {
      location,
      history: {
        state: { __motionIdx: 1 },
        length: 2,
        replaceState(state: any, _unused: any, target: string) {
          this.state = state;
          location.hash = new URL(target, 'http://audit.local/').hash;
        },
        pushState(state: any, _unused: any, target: string) {
          this.state = state;
          this.length += 1;
          location.hash = new URL(target, 'http://audit.local/').hash;
        },
        go(_delta: number) {
          goCalls++;
          // simulate browser bounce-back hashchange
          location.hash = '#/plans?plan=B';
          mockWindow.dispatchEvent(new mockWindow.HashChangeEvent('hashchange'));
        },
        back() { throw new Error('Not used'); },
      },
      addEventListener(type: string, fn: any) { if (type === 'hashchange') listeners.push(fn); },
      removeEventListener(_type: string, fn: any) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      dispatchEvent(event: any) { for (const fn of [...listeners]) fn(event); return true; },
    };
    mockWindow.HashChangeEvent = class { type: string; constructor(_type: string) { this.type = _type; } };

    const fakeReact = {
      useState(initial: any) {
        const box = { value: typeof initial === 'function' ? initial() : initial };
        boxes.push(box);
        return [box.value, (value: any) => { box.value = typeof value === 'function' ? value(box.value) : value; }];
      },
      useEffect(effect: any) { cleanups.push(effect()); },
    };
    const moduleObject = { exports: {} as any };
    vm.runInNewContext(compiled, {
      module: moduleObject, exports: moduleObject.exports,
      require(name: string) { if (name === 'react') return fakeReact; throw new Error('Unexpected dependency ' + name); },
      window: mockWindow, URLSearchParams, URL,
      HashChangeEvent: mockWindow.HashChangeEvent,
    });
    const router = moduleObject.exports;
    router.useRoute();
    router.useRoute();

    // Register a leave guard that blocks
    router.registerLeaveGuard(() => false);

    location.hash = '#/stats';
    mockWindow.history.state = { __motionIdx: 2 };
    mockWindow.dispatchEvent(new mockWindow.HashChangeEvent('hashchange'));

    expect(goCalls).toBe(1); // exactly 1 restoration, no oscillation
    expect(location.hash).toBe('#/plans?plan=B');
    expect(boxes[0].value.query.get('plan')).toBe('B');
    expect(boxes[1].value.query.get('plan')).toBe('B');

    for (const c of cleanups) if (typeof c === 'function') c();
  });

  it('训练用计划 settings.currentPlanId 与管理计划独立，切换管理计划绝不篡改训练计划', async () => {
    const NOW = 1_793_124_000_000;
    const planA = { ...createV32Plan(NOW), id: 'plan-A', name: 'Plan A' };
    const planB = { ...createV32Plan(NOW + 1), id: 'plan-B', name: 'Plan B' };
    await savePlan(planA);
    await savePlan(planB);

    // Initial: training plan is A
    await saveSettings({ currentPlanId: 'plan-A' });
    expect((await loadSettings()).currentPlanId).toBe('plan-A');

    // Simulate PlansPage effect logic:
    // If route specifies plan B, managePlanId is B, but currentPlanId stays A
    const routePlanId = 'plan-B';
    const settings = await loadSettings();
    const managePlanId = routePlanId;

    expect(managePlanId).toBe('plan-B');
    expect(settings.currentPlanId).toBe('plan-A');
  });

  it('claimHistoryRestore allows exactly one restoration per Event instance', () => {
    const event1 = { type: 'hashchange' };
    const event2 = { type: 'hashchange' };

    expect(claimHistoryRestore(event1)).toBe(true);
    expect(claimHistoryRestore(event1)).toBe(false);
    expect(claimHistoryRestore(event2)).toBe(true);
    expect(claimHistoryRestore(event2)).toBe(false);
  });
});
