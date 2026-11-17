/* F11：删除成功音/准备触感的**可判定契约**。
   ── 这份测试证明什么、不证明什么 ─────────────────────────────
   证明：门禁顺序、每个意图至多一次、开关/归属/可见性失效、Web 与 Native
        通道互斥且各自只调自己那一套 API、异常不外溢、原生结果不做乐观推断。
   不证明：用户真的听到了声音、Android 在静音/勿扰下的真实行为。
        音频 API 的**调用与生命周期**在这里被记录，但"听到了"必须真机验收。
   所有替身都是显式的假 AudioContext / 假原生桥，不做任何跨平台猜测。 */

import { describe, expect, it } from 'vitest';
import {
  MAX_TRACKED_DELETE_SESSIONS,
  MAX_TRACKED_DELETE_TOKENS_PER_SESSION,
  createDeleteFeedbackController,
  decideDeleteFeedback,
  decideDeleteTicket,
  decidePrepareHaptic,
  deleteFeedbackKey,
  interpretNativePlayResult,
  resolveFeedbackChannel,
  type AudioBufferSourceLike,
  type AudioContextLike,
  type DeleteFeedbackDeps,
  type DeleteFeedbackNativeBridge,
  type DeleteSoundOutcome,
} from '../src/lib/deletionFeedback';

/* ── 替身 ───────────────────────────────────────────────── */

class FakeSource implements AudioBufferSourceLike {
  buffer: unknown = null;
  started = 0;
  stopped = 0;
  onended: (() => void) | null = null;
  connect = () => undefined;
  start() {
    this.started += 1;
  }
  stop() {
    this.stopped += 1;
  }
}

class FakeContext implements AudioContextLike {
  state = 'running';
  destination = { name: 'dest' };
  resumeCalls = 0;
  decodeCalls = 0;
  resumeFails = false;
  resumeTo: string | null = null;
  sources: FakeSource[] = [];
  async resume() {
    this.resumeCalls += 1;
    if (this.resumeFails) throw new Error('autoplay blocked');
    if (this.resumeTo) this.state = this.resumeTo;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData() {
    this.decodeCalls += 1;
    return { decoded: true };
  }
  get started(): number {
    return this.sources.reduce((n, s) => n + s.started, 0);
  }
  get stopped(): number {
    return this.sources.reduce((n, s) => n + s.stopped, 0);
  }
}

interface Harness {
  controller: ReturnType<typeof createDeleteFeedbackController>;
  outcomes: DeleteSoundOutcome[];
  ctx: FakeContext;
  createContextCalls: () => number;
  loadAudioCalls: () => number;
  vibrateCalls: number[];
  nativeCalls: { play: number; stop: number; prepareHaptic: number };
  setVisible(v: boolean): void;
  setBridge(b: DeleteFeedbackNativeBridge | null): void;
  setLoadGate(p: Promise<void> | null): void;
  flush(): Promise<void>;
}

interface HarnessOptions {
  channel?: 'web' | 'native';
  createContext?: () => AudioContextLike | null;
  loadDelayGate?: Promise<void>;
  visibleThrows?: boolean;
  vibrateThrows?: boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
  const ctx = new FakeContext();
  const outcomes: DeleteSoundOutcome[] = [];
  const vibrateCalls: number[] = [];
  const nativeCalls = { play: 0, stop: 0, prepareHaptic: 0 };
  let visible = true;
  let createCalls = 0;
  let loadCalls = 0;
  let bridge: DeleteFeedbackNativeBridge | null = null;
  let gate: Promise<void> | null = opts.loadDelayGate ?? null;

  const deps: DeleteFeedbackDeps = {
    channel: opts.channel ?? 'web',
    native: () => bridge,
    web: {
      createContext: () => {
        createCalls += 1;
        if (opts.createContext) return opts.createContext();
        return ctx;
      },
      loadAudio: async () => {
        loadCalls += 1;
        if (gate) await gate;
        return new ArrayBuffer(8);
      },
      url: 'audio/delete-success.wav',
    },
    vibrate: (ms: number) => {
      vibrateCalls.push(ms);
      if (opts.vibrateThrows) throw new Error('vibrate blocked');
      return true;
    },
    visible: () => {
      if (opts.visibleThrows) throw new Error('visibility unavailable');
      return visible;
    },
    onOutcome: (o) => outcomes.push(o),
  };

  const controller = createDeleteFeedbackController(deps);
  return {
    controller,
    outcomes,
    ctx,
    createContextCalls: () => createCalls,
    loadAudioCalls: () => loadCalls,
    vibrateCalls,
    nativeCalls,
    setVisible: (v) => {
      visible = v;
    },
    setBridge: (b) => {
      bridge = b;
    },
    setLoadGate: (p) => {
      gate = p;
    },
    flush: async () => {
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function fakeBridge(
  calls: { play: number; stop: number; prepareHaptic: number },
  playImpl?: () => Promise<unknown>,
): DeleteFeedbackNativeBridge {
  return {
    play: () => {
      calls.play += 1;
      return playImpl ? playImpl() : Promise.resolve({ played: true, reason: 'allow-normal' });
    },
    stop: () => {
      calls.stop += 1;
      return Promise.resolve({ stopped: true });
    },
    prepareHaptic: () => {
      calls.prepareHaptic += 1;
      return Promise.resolve({ vibrated: true, reason: 'haptic-allow' });
    },
  };
}

/* ── 通道与纯判定 ───────────────────────────────────────── */

describe('F11 通道判定：native/web 互斥', () => {
  it('android 构建 + 原生容器 → native', () => {
    expect(resolveFeedbackChannel({ nativeBuild: true, nativePlatform: true })).toBe('native');
  });
  it('android 构建但跑在浏览器 → web（不假装能调原生）', () => {
    expect(resolveFeedbackChannel({ nativeBuild: true, nativePlatform: false })).toBe('web');
  });
  it('web 构建即使跑在 WebView 里 → web', () => {
    expect(resolveFeedbackChannel({ nativeBuild: false, nativePlatform: true })).toBe('web');
    expect(resolveFeedbackChannel({ nativeBuild: false, nativePlatform: false })).toBe('web');
  });
});

describe('F11 成功音门禁（纯函数，顺序稳定）', () => {
  const base = {
    enabled: true,
    boundSessionId: 's1',
    intentSessionId: 's1',
    itemId: 'i1',
    token: 't1',
    visible: true,
    playedKeys: new Set<string>(),
  };

  it('条件齐全 → allow，键为 session/item/token', () => {
    const d = decideDeleteFeedback(base);
    expect(d.play).toBe(true);
    expect(d.reason).toBe('allow');
    expect(d.key).toBe(deleteFeedbackKey('s1', 'i1', 't1'));
  });

  it('没有 token 就不是一次删除意图', () => {
    expect(decideDeleteFeedback({ ...base, token: '' }).reason).toBe('no-token');
  });

  it('关闭开关立即不播（不依赖当时是否有在途请求）', () => {
    expect(decideDeleteFeedback({ ...base, enabled: false }).play).toBe(false);
    expect(decideDeleteFeedback({ ...base, enabled: false }).reason).toBe('disabled');
  });

  it('未绑定 session（不在训练页）不播', () => {
    expect(decideDeleteFeedback({ ...base, boundSessionId: null }).reason).toBe('no-session');
  });

  it('属于别的 session 的迟到回调不播（跨 session 不串扰）', () => {
    expect(decideDeleteFeedback({ ...base, intentSessionId: 's2' }).reason).toBe('other-session');
  });

  it('页面不可见不播', () => {
    expect(decideDeleteFeedback({ ...base, visible: false }).reason).toBe('hidden');
  });

  it('同一 token 第二次不播（重复回调/重试/重渲染）', () => {
    const key = deleteFeedbackKey('s1', 'i1', 't1');
    expect(decideDeleteFeedback({ ...base, playedKeys: new Set([key]) }).reason).toBe('duplicate');
  });

  it('不同 item 或不同 token 视为不同意图', () => {
    const key = deleteFeedbackKey('s1', 'i1', 't1');
    const played = new Set([key]);
    expect(decideDeleteFeedback({ ...base, itemId: 'i2', playedKeys: played }).play).toBe(true);
    expect(decideDeleteFeedback({ ...base, token: 't2', playedKeys: played }).play).toBe(true);
  });
});

describe('F11 原生结果不做乐观推断', () => {
  it('played:true 才算走过放行路径', () => {
    expect(interpretNativePlayResult({ played: true, reason: 'allow-normal' })).toEqual({
      status: 'played',
      reason: 'allow-normal',
    });
  });
  it('played:false 是原生保守拒绝，带稳定原因', () => {
    expect(interpretNativePlayResult({ played: false, reason: 'ringer-silent' })).toEqual({
      status: 'skipped',
      reason: 'ringer-silent',
    });
  });
  it('没有结果/空对象/字符串 true/异常都不算播放', () => {
    expect(interpretNativePlayResult(undefined).status).toBe('failed');
    expect(interpretNativePlayResult(null).status).toBe('failed');
    expect(interpretNativePlayResult({}).status).toBe('failed');
    expect(interpretNativePlayResult({ played: 'true' }).status).toBe('failed');
    expect(interpretNativePlayResult(0).status).toBe('failed');
    expect(interpretNativePlayResult('played').status).toBe('failed');
  });
});

describe('F11 准备触感门禁', () => {
  it('web：有 Vibration API 才震', () => {
    expect(
      decidePrepareHaptic({
        boundSessionId: 's1',
        visible: true,
        channel: 'web',
        bridgeAvailable: false,
        webVibrateAvailable: true,
      }).vibrate,
    ).toBe(true);
    expect(
      decidePrepareHaptic({
        boundSessionId: 's1',
        visible: true,
        channel: 'web',
        bridgeAvailable: false,
        webVibrateAvailable: false,
      }).reason,
    ).toBe('no-vibrate-api');
  });
  it('native 只看原生桥（不会退回 web 震动，避免双震）', () => {
    const d = decidePrepareHaptic({
      boundSessionId: 's1',
      visible: true,
      channel: 'native',
      bridgeAvailable: true,
      webVibrateAvailable: true,
    });
    expect(d.vibrate).toBe(true);
    expect(d.reason).toBe('native-allow');
    expect(
      decidePrepareHaptic({
        boundSessionId: 's1',
        visible: true,
        channel: 'native',
        bridgeAvailable: false,
        webVibrateAvailable: true,
      }).vibrate,
    ).toBe(false);
  });
  it('不在训练页 / 不可见都不震（文字提示仍在卡片上）', () => {
    const common = { channel: 'web' as const, bridgeAvailable: false, webVibrateAvailable: true };
    expect(decidePrepareHaptic({ ...common, boundSessionId: null, visible: true }).reason).toBe('no-session');
    expect(decidePrepareHaptic({ ...common, boundSessionId: 's1', visible: false }).reason).toBe('hidden');
  });
});

/* ── Web 通道的调用与生命周期 ───────────────────────────── */

describe('F11 Web 通道：只在成功出口后才创建/加载音频', () => {
  it('绑定与就绪期间完全不碰音频 API（不存在"提前解锁"）', async () => {
    const h = harness();
    h.controller.bind('s1');
    await h.flush();
    expect(h.createContextCalls()).toBe(0);
    expect(h.loadAudioCalls()).toBe(0);
    expect(h.ctx.started).toBe(0);
  });

  it('一次成功删除 → 一次解码、一次播放', async () => {
    const h = harness();
    h.controller.bind('s1');
    const first = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    expect(first.reason).toBe('dispatched');
    await h.flush();
    expect(h.createContextCalls()).toBe(1);
    expect(h.loadAudioCalls()).toBe(1);
    expect(h.ctx.started).toBe(1);
    expect(h.outcomes.at(-1)).toEqual({ status: 'played', reason: 'web-audio', channel: 'web' });
  });

  it('音效在关闭状态下不触发任何音频调用', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.setEnabled(false);
    expect(h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }).reason).toBe('disabled');
    await h.flush();
    expect(h.createContextCalls()).toBe(0);
    expect(h.loadAudioCalls()).toBe(0);
  });

  it('同一 token 重复回调只放一次', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    const second = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(second.reason).toBe('duplicate');
    expect(h.ctx.started).toBe(1);
  });

  it('连续删除两个不同项目 → 各放一次', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i2', token: 't2' });
    await h.flush();
    expect(h.ctx.started).toBe(2);
  });

  it('去重范围是 session 生命周期（不靠"小容量淘汰旧 token"换取内存）', () => {
    // F11-FIX1：旧实现用 64 条 LRU，超过 64 次删除后最早的旧 token 会被淘汰，
    // 于是"已经响过的意图"能被重放 —— 这是错的行为，不是可接受的省内存方式。
    expect(MAX_TRACKED_DELETE_TOKENS_PER_SESSION).toBeGreaterThanOrEqual(1000);
    expect(MAX_TRACKED_DELETE_SESSIONS).toBeGreaterThan(0);
  });

  it('加载途中被作废（离页/隐藏/卸载）→ 解码后不播放', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = harness({ loadDelayGate: gate });
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.loadAudioCalls()).toBe(1);
    h.controller.invalidate('page-hidden');
    release();
    await h.flush();
    expect(h.ctx.started).toBe(0);
    expect(h.outcomes.at(-1)?.status).toBe('skipped');
    expect(h.outcomes.at(-1)?.reason).toBe('invalidated-before-decode');
  });

  it('已经开始播放时关闭开关 → 立即停止该次播放', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.ctx.started).toBe(1);
    h.controller.setEnabled(false);
    expect(h.ctx.stopped).toBe(1);
  });

  it('AudioContext 被自动播放策略挂起且 resume 失败 → 如实报告失败，不伪造播放', async () => {
    const h = harness();
    h.ctx.state = 'suspended';
    h.ctx.resumeFails = true;
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.ctx.resumeCalls).toBe(1);
    expect(h.ctx.started).toBe(0);
    expect(h.outcomes.at(-1)).toEqual({
      status: 'failed',
      reason: 'audio-context-not-running',
      channel: 'web',
    });
  });

  it('resume 成功则继续播放', async () => {
    const h = harness();
    h.ctx.state = 'suspended';
    h.ctx.resumeTo = 'running';
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.ctx.resumeCalls).toBe(1);
    expect(h.ctx.started).toBe(1);
  });

  it('没有 Web Audio 实现 → 失败但不抛错、不影响调用方', async () => {
    const h = harness({ createContext: () => null });
    h.controller.bind('s1');
    expect(() =>
      h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }),
    ).not.toThrow();
    await h.flush();
    expect(h.outcomes.at(-1)?.reason).toBe('no-web-audio');
  });

  it('音频栈抛异常被就地吞掉（不会冒泡到删除流程）', async () => {
    const h = harness({
      createContext: () => {
        throw new Error('audio subsystem exploded');
      },
    });
    h.controller.bind('s1');
    expect(() =>
      h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }),
    ).not.toThrow();
    await h.flush();
    expect(h.outcomes.at(-1)?.status).toBe('failed');
    expect(h.outcomes.at(-1)?.reason.startsWith('audio-error:')).toBe(true);
  });

  it('可见性查询本身抛异常 → 保守当作不可见', async () => {
    const h = harness({ visibleThrows: true });
    h.controller.bind('s1');
    expect(h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }).reason).toBe('hidden');
    await h.flush();
    expect(h.ctx.started).toBe(0);
  });
});

/* ── Native 通道 ───────────────────────────────────────── */

describe('F11 Native 通道：只转发意图、如实回报原生结论', () => {
  function nativeHarness(playImpl?: () => Promise<unknown>) {
    const h = harness({ channel: 'native' });
    h.setBridge(fakeBridge(h.nativeCalls, playImpl));
    return h;
  }

  it('原生放行 → 报告 played，且不碰 Web Audio', async () => {
    const h = nativeHarness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.nativeCalls.play).toBe(1);
    expect(h.createContextCalls()).toBe(0);
    expect(h.outcomes.at(-1)).toEqual({
      status: 'played',
      reason: 'allow-normal',
      channel: 'native',
    });
  });

  it('原生因静音/勿扰拒绝 → skipped，JS 不升级成"已遵循"或"已出声"', async () => {
    const h = nativeHarness(() => Promise.resolve({ played: false, reason: 'ringer-silent' }));
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.outcomes.at(-1)).toEqual({ status: 'skipped', reason: 'ringer-silent', channel: 'native' });
  });

  it('原生桥返回空 → failed（不乐观推断）', async () => {
    const h = nativeHarness(() => Promise.resolve(undefined));
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.outcomes.at(-1)).toEqual({ status: 'failed', reason: 'native-no-result', channel: 'native' });
  });

  it('原生桥抛异常 → failed 且不影响调用方', async () => {
    const h = nativeHarness(() => Promise.reject(new Error('bridge down')));
    h.controller.bind('s1');
    expect(() =>
      h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }),
    ).not.toThrow();
    await h.flush();
    expect(h.outcomes.at(-1)?.status).toBe('failed');
    expect(h.outcomes.at(-1)?.reason.startsWith('native-error:')).toBe(true);
  });

  it('没有原生桥 → failed 而不是静默成功', async () => {
    const h = harness({ channel: 'native' });
    h.setBridge(null);
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(h.outcomes.at(-1)).toEqual({ status: 'failed', reason: 'no-native-bridge', channel: 'native' });
  });

  it('原生结果迟到且页面已作废 → 报告 invalidated 并请求原生停止', async () => {
    let release: (v: unknown) => void = () => undefined;
    const h = nativeHarness(() => new Promise((r) => (release = r)));
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await new Promise((r) => setTimeout(r, 0));
    h.controller.invalidate('session-unbind');
    release({ played: true, reason: 'allow-normal' });
    await h.flush();
    expect(h.outcomes.at(-1)?.reason).toBe('invalidated-after-native');
    expect(h.nativeCalls.stop).toBeGreaterThanOrEqual(1);
  });

  it('作废时（未在播放）也会通知原生 stop，避免残留', async () => {
    const h = nativeHarness();
    h.controller.bind('s1');
    h.controller.invalidate('page-hidden');
    await h.flush();
    expect(h.nativeCalls.stop).toBe(1);
  });
});

/* ── 归零/归属 ─────────────────────────────────────────── */

describe('F11 归属：换 session / 解绑使旧意图失效', () => {
  it('换 session 后旧 session 的迟到 saved 不播', async () => {
    const h = harness();
    h.controller.bind('s2');
    await h.flush();
    const d = decideDeleteFeedback({
      enabled: true,
      boundSessionId: 's2',
      intentSessionId: 's1',
      itemId: 'i1',
      token: 't1',
      visible: true,
      playedKeys: new Set(),
    });
    expect(d.reason).toBe('other-session');
    expect(h.createContextCalls()).toBe(0);
  });

  it('解绑后（离开训练页）任何成功回调都不播', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.unbind();
    expect(h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }).reason).toBe('no-session');
    await h.flush();
    expect(h.createContextCalls()).toBe(0);
  });

  it('重新绑定同一 session 不重置已播放集合（不会补放）', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    h.controller.unbind();
    h.controller.bind('s1');
    expect(h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }).reason).toBe('duplicate');
    await h.flush();
    expect(h.ctx.started).toBe(1);
  });
});

/* ── 触感单通道 ───────────────────────────────────────── */

describe('F11 F09 准备触感：一次手势只走一条通道', () => {
  it('web 只调 Vibration API 一次', () => {
    const h = harness();
    h.controller.bind('s1');
    const r = h.controller.prepareHaptic();
    expect(r.vibrated).toBe(true);
    expect(h.vibrateCalls).toEqual([20]);
    expect(h.nativeCalls.prepareHaptic).toBe(0);
  });

  it('native 只调原生方法一次，绝不触发 web 震动（消除双震）', async () => {
    const h = harness({ channel: 'native' });
    h.setBridge(fakeBridge(h.nativeCalls));
    h.controller.bind('s1');
    const r = h.controller.prepareHaptic();
    expect(r.vibrated).toBe(true);
    expect(h.vibrateCalls).toEqual([]);
    expect(h.nativeCalls.prepareHaptic).toBe(1);
    await h.flush();
    expect(h.vibrateCalls).toEqual([]);
  });

  it('Vibration API 抛异常 → 返回未震动，绝不冒泡', () => {
    const h = harness({ vibrateThrows: true });
    h.controller.bind('s1');
    expect(() => h.controller.prepareHaptic()).not.toThrow();
    expect(h.controller.prepareHaptic().vibrated).toBe(false);
  });

  it('不在训练页/不可见时不震（保留文字提示）', () => {
    const h = harness();
    expect(h.controller.prepareHaptic().reason).toBe('no-session');
    h.controller.bind('s1');
    h.setVisible(false);
    expect(h.controller.prepareHaptic().reason).toBe('hidden');
    expect(h.vibrateCalls).toEqual([]);
  });
});

/* ── F11-FIX1：归属清理、异步失败隔离、长序列去重、提交凭证 ────────── */

/** 手动 resolve/reject 的 Promise（模拟真实异步窗口） */
function deferred<T = unknown>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('F11-FIX1 归属清理：旧回调只能停自己那一次', () => {
  it('旧页面 play 迟到返回 → 绝不停止新页面的原生播放（root 第三例）', async () => {
    // 复刻根执行器的真实顺序：旧页 play 悬而未决 → invalidate/unbind 旧页 →
    // bind 新 session 并 play 新意图 → 旧 Promise 迟到返回。
    const gate = deferred();
    let plays = 0;
    let current = 0;
    const stopped: number[] = [];
    const bridge: DeleteFeedbackNativeBridge = {
      play: () => {
        current = ++plays;
        return plays === 1 ? gate.promise : Promise.resolve({ played: true, reason: 'allow-normal' });
      },
      stop: () => {
        stopped.push(current);
        current = 0;
        return Promise.resolve({ stopped: true });
      },
      prepareHaptic: () => Promise.resolve({ vibrated: true, reason: 'haptic-allow' }),
    };
    const h = harness({ channel: 'native' });
    h.setBridge(bridge);
    h.controller.bind('A');
    h.controller.notifySucceeded({ sessionId: 'A', itemId: 'item-old', token: 'old' });
    h.controller.invalidate('route-leave');
    h.controller.unbind();
    h.controller.bind('B');
    h.controller.notifySucceeded({ sessionId: 'B', itemId: 'item-new', token: 'new' });
    await h.flush();
    gate.resolve({ played: false, reason: 'intent-stale' });
    await h.flush();

    expect(plays).toBe(2);
    // 离页时的页面级收手只停了旧页那一条（stopped=[1]），旧回调迟到后**没有**再停一次：
    // 新页面的声音仍然在播（current 仍是 2，而不是被清零）
    expect(stopped).toEqual([1]);
    expect(stopped).not.toContain(2);
    expect(current).toBe(2);
  });

  it('自己仍是当前 owner 时，迟到结果只发带 owner 的定向停止', async () => {
    const gate = deferred();
    const stopCalls: Array<{ owner?: string } | undefined> = [];
    const bridge: DeleteFeedbackNativeBridge = {
      play: () => gate.promise,
      stop: (options?: { owner?: string }) => {
        stopCalls.push(options);
        return Promise.resolve({ stopped: true });
      },
      prepareHaptic: () => Promise.resolve({}),
    };
    const h = harness({ channel: 'native' });
    h.setBridge(bridge);
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    // 页面在这一刻变为不可见（还没走到 invalidate）：旧回调必须只清自己
    h.setVisible(false);
    gate.resolve({ played: true, reason: 'allow-normal' });
    await h.flush();

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.owner).toMatch(/^native-\d+$/);
    expect(h.outcomes.at(-1)?.reason).toBe('invalidated-after-native');
  });

  it('页面级作废已经收手后，迟到的旧结果不再补发 stop（不重复停）', async () => {
    const gate = deferred();
    const stopCalls: Array<{ owner?: string } | undefined> = [];
    const bridge: DeleteFeedbackNativeBridge = {
      play: () => gate.promise,
      stop: (options?: { owner?: string }) => {
        stopCalls.push(options);
        return Promise.resolve({ stopped: true });
      },
      prepareHaptic: () => Promise.resolve({}),
    };
    const h = harness({ channel: 'native' });
    h.setBridge(bridge);
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    h.controller.invalidate('hidden');
    gate.resolve({ played: true, reason: 'allow-normal' });
    await h.flush();

    // 只有 invalidate 那一次（不带 owner = 整页收手）
    expect(stopCalls).toEqual([undefined]);
  });

  it('新意图不会被旧 owner 的清理波及：两次派发各有自己的 owner', async () => {
    const owners: Array<string | undefined> = [];
    const bridge: DeleteFeedbackNativeBridge = {
      play: (options?: { owner?: string }) => {
        owners.push(options?.owner);
        return Promise.resolve({ played: true, reason: 'allow-normal' });
      },
      stop: () => Promise.resolve({ stopped: true }),
      prepareHaptic: () => Promise.resolve({}),
    };
    const h = harness({ channel: 'native' });
    h.setBridge(bridge);
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i2', token: 't2' });
    await h.flush();

    expect(owners).toHaveLength(2);
    expect(owners[0]).toBeTruthy();
    expect(owners[1]).toBeTruthy();
    // 每次派发一个**新的**归属凭证，旧凭证不可能被新意图继承
    expect(owners[0]).not.toBe(owners[1]);
  });
});

describe('F11-FIX1 异步停止失败必须被隔离（不产生 unhandledRejection）', () => {
  const withRejectionWatch = async (run: () => Promise<void>) => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on('unhandledRejection', onRejection);
    try {
      await run();
      // 给 Node 一个队列轮次让潜在拒绝真正触发
      await sleep(0);
      await sleep(0);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
    }
    return rejections;
  };

  it('stop 返回拒绝的 Promise：关闭开关 / 作废 / 解绑 / 换绑都不外泄', async () => {
    const rejections = await withRejectionWatch(async () => {
      const h = harness({ channel: 'native' });
      h.setBridge({
        play: () => Promise.resolve({ played: true, reason: 'allow-normal' }),
        stop: () => Promise.reject(new Error('stop unavailable')),
        prepareHaptic: () => Promise.resolve({}),
      });
      h.controller.bind('A');
      h.controller.setEnabled(false);
      h.controller.invalidate('hidden');
      h.controller.setEnabled(true);
      h.controller.unbind();
      h.controller.bind('B');
      h.controller.invalidate('session-unbind');
      await h.flush();
    });
    expect(rejections).toEqual([]);
  });

  it('stop 同步抛错：同样隔离，调用方不被影响', async () => {
    const h = harness({ channel: 'native' });
    h.setBridge({
      play: () => Promise.resolve({ played: true, reason: 'allow-normal' }),
      stop: () => {
        throw new Error('bridge closed');
      },
      prepareHaptic: () => Promise.resolve({}),
    });
    h.controller.bind('A');
    expect(() => h.controller.setEnabled(false)).not.toThrow();
    expect(() => h.controller.invalidate('page-hidden')).not.toThrow();
    await h.flush();
    expect(h.controller.isEnabled()).toBe(false);
  });

  it('prepareHaptic 的拒绝也被隔离（触感失败不影响任何业务结果）', async () => {
    const rejections = await withRejectionWatch(async () => {
      const h = harness({ channel: 'native' });
      h.setBridge({
        play: () => Promise.resolve({ played: true, reason: 'allow-normal' }),
        stop: () => Promise.resolve({ stopped: true }),
        prepareHaptic: () => Promise.reject(new Error('vibrator unavailable')),
      });
      h.controller.bind('s1');
      expect(h.controller.prepareHaptic().vibrated).toBe(true);
      await h.flush();
    });
    expect(rejections).toEqual([]);
  });
});

describe('F11-FIX1 长序列：session 内每个意图至多一次', () => {
  it('同 session 连续 100 个不同意图后，再通知第一个旧 token → 仍是 duplicate', async () => {
    const h = harness();
    h.controller.bind('s1');
    for (let i = 0; i < 100; i++) {
      h.controller.notifySucceeded({ sessionId: 's1', itemId: `item-seq-${i}`, token: `seq-${i}` });
    }
    await h.flush();
    expect(h.ctx.started).toBe(100);

    const replay = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'item-seq-0', token: 'seq-0' });
    await h.flush();
    expect(replay.reason).toBe('duplicate');
    expect(h.ctx.started).toBe(100);
  });

  it('去重封顶（超过精确记录上限）后保守不出声，且旧 token 仍不可重放', async () => {
    const cap = MAX_TRACKED_DELETE_TOKENS_PER_SESSION;
    const h = harness({ channel: 'native' });
    h.setBridge(fakeBridge(h.nativeCalls));
    h.controller.bind('s1');
    for (let i = 0; i <= cap; i++) {
      h.controller.notifySucceeded({ sessionId: 's1', itemId: `i${i}`, token: `t${i}` });
    }
    await h.flush();
    // 封顶后不再记录新键，也不再出声（fail-closed：宁可少一声，不可响两声）
    const beyond = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'beyond', token: 'beyond' });
    expect(beyond.reason).toBe('dedup-saturated');
    // 最早那个旧 token 依旧被记住（没有因为容量压力被淘汰）
    const replay = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i0', token: 't0' });
    expect(replay.reason).toBe('duplicate');
    await h.flush();
  });

  it('跨 session 不串扰：换 session 后旧 token 的迟到回调属于 other-session', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    h.controller.unbind();
    h.controller.bind('s2');
    const late = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    expect(late.reason).toBe('other-session');
    await h.flush();
    expect(h.ctx.started).toBe(1);
  });

  it('回到同一 session 时旧意图不复活（新 token 照常可播）', async () => {
    const h = harness();
    h.controller.bind('s1');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    h.controller.unbind();
    h.controller.invalidate('session-unbind');
    h.controller.bind('s1');
    expect(h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }).reason).toBe('duplicate');
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i2', token: 't2' });
    await h.flush();
    expect(h.ctx.started).toBe(2);
  });
});

describe('F11-FIX1 提交凭证：慢事务期间归属变过就不能补响', () => {
  it('凭证纯判定：无凭证/世代变/绑定变都拒绝，且不夺走既有原因码', () => {
    const ticket = { epoch: 3, sessionId: 's1', owner: 'delete-feedback-1' };
    expect(decideDeleteTicket({ ticket: undefined, currentEpoch: 3, boundSessionId: 's1' })).toEqual({
      ok: false,
      reason: 'no-ticket',
    });
    expect(decideDeleteTicket({ ticket, currentEpoch: 4, boundSessionId: 's1' })).toEqual({
      ok: false,
      reason: 'stale-epoch',
    });
    expect(decideDeleteTicket({ ticket, currentEpoch: 3, boundSessionId: 's2' })).toEqual({
      ok: false,
      reason: 'stale-session',
    });
    expect(decideDeleteTicket({ ticket, currentEpoch: 3, boundSessionId: 's1' })).toEqual({
      ok: true,
      reason: 'allow',
    });
  });

  it('真实 I/O 时序：提交 2.2s、期间隐藏 150ms 后恢复可见 → 音频一次都不 start', async () => {
    const h = harness();
    h.controller.bind('s1');
    const ticket = h.controller.captureIntent();

    // 真实慢事务（不用假时钟）：2.2 秒后才 saved
    const commit = sleep(2200);
    await sleep(150);
    // 隐藏 → 页面统一走 invalidateFeedback（Session 的 visibilitychange 接线）
    h.setVisible(false);
    h.controller.invalidate('hidden-or-lock-lost');
    await sleep(120);
    h.setVisible(true);
    await commit;

    const stale = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }, ticket);
    await h.flush();
    expect(stale.status).toBe('skipped');
    expect(stale.reason).toBe('stale-epoch');
    expect(h.ctx.started).toBe(0);
    expect(h.outcomes.at(-1)?.status).toBe('skipped');

    // 恢复后的一次**新**删除（重新捕获凭证）照常出声
    const fresh = h.controller.captureIntent();
    const ok = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i2', token: 't2' }, fresh);
    await h.flush();
    expect(ok.reason).toBe('dispatched');
    expect(h.ctx.started).toBe(1);
  });

  it('提交期间离页并回到同一 session（同 session 重新进入）→ 旧 saved 不响', async () => {
    const h = harness();
    h.controller.bind('s1');
    const ticket = h.controller.captureIntent();
    // 卸载：Session 的 effect cleanup
    h.controller.invalidate('session-unbind');
    // 重新进入同一 session
    h.controller.bind('s1');
    const stale = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }, ticket);
    await h.flush();
    expect(stale.reason).toBe('stale-epoch');
    expect(h.ctx.started).toBe(0);
  });

  it('提交期间关闭再打开音效开关 → 旧 saved 不响，新删除照常响', async () => {
    const h = harness();
    h.controller.bind('s1');
    const ticket = h.controller.captureIntent();
    h.controller.setEnabled(false);
    h.controller.setEnabled(true);
    const stale = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' }, ticket);
    await h.flush();
    expect(stale.reason).toBe('stale-epoch');
    expect(h.ctx.started).toBe(0);

    const fresh = h.controller.captureIntent();
    h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i2', token: 't2' }, fresh);
    await h.flush();
    expect(h.ctx.started).toBe(1);
  });

  it('凭证有效但意图属于别的 session → 仍按既有的 other-session 拒绝', async () => {
    const h = harness();
    h.controller.bind('s1');
    const ticket = h.controller.captureIntent();
    const other = h.controller.notifySucceeded({ sessionId: 's2', itemId: 'i1', token: 't1' }, ticket);
    await h.flush();
    expect(other.reason).toBe('other-session');
    expect(h.ctx.started).toBe(0);
  });

  it('未带凭证的调用按调用时刻判定（根执行器/历史调用方兼容，生产接线必须传）', async () => {
    const h = harness();
    h.controller.bind('s1');
    const outcome = h.controller.notifySucceeded({ sessionId: 's1', itemId: 'i1', token: 't1' });
    await h.flush();
    expect(outcome.reason).toBe('dispatched');
    expect(h.ctx.started).toBe(1);
  });
});
