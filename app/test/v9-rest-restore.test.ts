/* BRIEF 第2项：页面重建后恢复休息计时（REVIEW-1 第8项）。

   ── 覆盖 ────────────────────────────────────────────────────
   1. 运行中重建：按绝对时间戳恢复剩余，且**不重排原生**（防双提醒）
   2. 暂停中重建：恢复暂停态与剩余毫秒
   3. 已到点重建：不恢复、不提醒（避免迟到提醒），并清理快照
   4. 完成/放弃训练：clear 后重建不复活
   5. 归属校验：别的 sessionId 的快照不会被恢复（防串训练）
   6. 陈旧快照（超过 2 小时）丢弃
   7. 损坏/版本不符/字段非法：安静丢弃，不抛错

   证据边界：本文件测试**快照模块**（生产 hook 的真实依赖）。
   hook 的 React 挂载时序与真实 sessionStorage 行为需浏览器验证，见报告。 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  MAX_RESTORE_AGE_MS,
  clearRestTimerSnapshot,
  decideRestore,
  loadRestTimerSnapshot,
  saveRestTimerSnapshot,
} from '../src/lib/restTimerSnapshot';

/** 最小 sessionStorage 替身（node 环境没有） */
function installStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  });
  return map;
}

beforeEach(() => {
  installStorage();
});

describe('第8项 · 运行中重建恢复', () => {
  it('按绝对 endsAt 恢复剩余，且判定为 resume-running（不重排）', () => {
    const now = 1_700_000_000_000;
    saveRestTimerSnapshot({
      sessionId: 'sess-1',
      token: 'rest-a',
      generation: 3,
      endsAt: now + 45_000,
      pausedRemaining: null,
      status: 'running',
    });
    const snap = loadRestTimerSnapshot('sess-1', now + 5_000);
    expect(snap).not.toBeNull();
    const d = decideRestore(snap, now + 5_000);
    expect(d.kind).toBe('resume-running');
    if (d.kind === 'resume-running') {
      expect(d.remainingMs).toBe(40_000);
      expect(d.endsAt).toBe(now + 45_000);
    }
  });

  it('恢复保留 token 与 generation（重建后能正确接管/取消）', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-1',
      token: 'rest-x',
      generation: 9,
      endsAt: Date.now() + 30_000,
      pausedRemaining: null,
      status: 'running',
    });
    const snap = loadRestTimerSnapshot('sess-1');
    expect(snap?.token).toBe('rest-x');
    expect(snap?.generation).toBe(9);
  });
});

describe('第8项 · 暂停中重建恢复', () => {
  it('恢复暂停态与剩余毫秒', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-2',
      token: 'rest-b',
      generation: 1,
      endsAt: null,
      pausedRemaining: 25_000,
      status: 'paused',
    });
    const snap = loadRestTimerSnapshot('sess-2');
    const d = decideRestore(snap);
    expect(d.kind).toBe('restore-paused');
    if (d.kind === 'restore-paused') expect(d.pausedRemaining).toBe(25_000);
  });

  it('暂停剩余为 0 → 判定 expired（不复活）', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-2',
      token: 'rest-b',
      generation: 1,
      endsAt: null,
      pausedRemaining: 0,
      status: 'paused',
    });
    const d = decideRestore(loadRestTimerSnapshot('sess-2'));
    expect(d.kind).toBe('expired');
  });
});

describe('第8项 · 已到点不提醒', () => {
  it('运行中但已过期 → expired（不恢复、不提醒）', () => {
    const now = 1_700_000_000_000;
    saveRestTimerSnapshot({
      sessionId: 'sess-3',
      token: 'rest-c',
      generation: 2,
      endsAt: now - 1_000, // 已过
      pausedRemaining: null,
      status: 'running',
    });
    // savedAt 是真实 Date.now()，这里用较小 now 避免被"陈旧"规则先拦掉
    const snap = loadRestTimerSnapshot('sess-3');
    const d = decideRestore(snap, now);
    expect(d.kind).toBe('expired');
  });
});

describe('第8项 · 完成/放弃后不复活', () => {
  it('clear 之后 load 返回 null', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-4',
      token: 'rest-d',
      generation: 1,
      endsAt: Date.now() + 60_000,
      pausedRemaining: null,
      status: 'running',
    });
    expect(loadRestTimerSnapshot('sess-4')).not.toBeNull();
    clearRestTimerSnapshot('sess-4');
    expect(loadRestTimerSnapshot('sess-4')).toBeNull();
    expect(decideRestore(null).kind).toBe('none');
  });
});

describe('第8项 · 归属校验（防串训练）', () => {
  it('别的 sessionId 的快照不会被恢复', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-A',
      token: 'rest-a',
      generation: 1,
      endsAt: Date.now() + 60_000,
      pausedRemaining: null,
      status: 'running',
    });
    expect(loadRestTimerSnapshot('sess-B')).toBeNull();
  });

  it('两个训练各自独立', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-A',
      token: 'rest-a',
      generation: 1,
      endsAt: Date.now() + 60_000,
      pausedRemaining: null,
      status: 'running',
    });
    saveRestTimerSnapshot({
      sessionId: 'sess-B',
      token: 'rest-b',
      generation: 5,
      endsAt: Date.now() + 30_000,
      pausedRemaining: null,
      status: 'running',
    });
    expect(loadRestTimerSnapshot('sess-A')?.token).toBe('rest-a');
    expect(loadRestTimerSnapshot('sess-B')?.token).toBe('rest-b');
  });
});

describe('第8项 · 陈旧与损坏数据', () => {
  it('超过 MAX_RESTORE_AGE_MS 的快照被丢弃', () => {
    saveRestTimerSnapshot({
      sessionId: 'sess-5',
      token: 'rest-e',
      generation: 1,
      endsAt: Date.now() + 60_000,
      pausedRemaining: null,
      status: 'running',
    });
    const future = Date.now() + MAX_RESTORE_AGE_MS + 1_000;
    expect(loadRestTimerSnapshot('sess-5', future)).toBeNull();
  });

  it('JSON 损坏 → 返回 null 并清理（不抛错）', () => {
    const store = installStorage();
    store.set('motion-rest-timer:sess-6', '{not json');
    expect(() => loadRestTimerSnapshot('sess-6')).not.toThrow();
    expect(loadRestTimerSnapshot('sess-6')).toBeNull();
  });

  it('版本不符 → 丢弃', () => {
    const store = installStorage();
    store.set(
      'motion-rest-timer:sess-7',
      JSON.stringify({
        v: 99,
        sessionId: 'sess-7',
        token: 'rest-f',
        status: 'running',
        endsAt: Date.now() + 1000,
        savedAt: Date.now(),
      }),
    );
    expect(loadRestTimerSnapshot('sess-7')).toBeNull();
  });

  it('字段非法（endsAt 非数字）→ 丢弃', () => {
    const store = installStorage();
    store.set(
      'motion-rest-timer:sess-8',
      JSON.stringify({
        v: 1,
        sessionId: 'sess-8',
        token: 'rest-g',
        status: 'running',
        endsAt: 'abc',
        pausedRemaining: null,
        savedAt: Date.now(),
      }),
    );
    expect(loadRestTimerSnapshot('sess-8')).toBeNull();
  });

  it('空 token → 丢弃', () => {
    const store = installStorage();
    store.set(
      'motion-rest-timer:sess-9',
      JSON.stringify({
        v: 1,
        sessionId: 'sess-9',
        token: '',
        status: 'running',
        endsAt: Date.now() + 1000,
        savedAt: Date.now(),
      }),
    );
    expect(loadRestTimerSnapshot('sess-9')).toBeNull();
  });
});
