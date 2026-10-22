/* 单活动训练编辑者。
   场景：同一浏览器开两个标签页进同一个训练，不能让两边静默互相覆盖。
   做法：
   · 每个标签页一个 editorId，写入 IndexedDB meta: lock:<sessionId>
   · 抢占时若发现未过期且不是自己的锁 → 判定为「被别人占用」
   · 心跳每 8 秒刷新自己的时间戳，页面隐藏/关闭时释放
   · 只在真正拿不到锁时进入只读；锁过期（20 秒无心跳）后允许接管 */

import { getMeta, setMeta } from '../db/repo';

interface LockRecord {
  sessionId: string;
  editorId: string;
  at: number;
}

const LOCK_TTL_MS = 20_000;
const CHANNEL = 'motion-training-lock';
/** 刷新后要在 sessionStorage 里找回自己的 editorId，否则会被自己留下的锁挡在门外 */
const SS_KEY = 'motion-editor-id';

export function makeEditorId(): string {
  try {
    const existing = sessionStorage.getItem(SS_KEY);
    if (existing) return existing;
  } catch {
    /* 隐私模式下可能不可用 */
  }
  const id = `ed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    sessionStorage.setItem(SS_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}

/** 刷新后接管自己上一次留下的锁（同一标签页） */
export async function reclaimOwnLock(sessionId: string): Promise<void> {
  let prev: string | null = null;
  try {
    prev = sessionStorage.getItem(SS_KEY);
  } catch {
    /* ignore */
  }
  if (!prev) return;
  const key = `lock:${sessionId}`;
  const existing = await getMeta<LockRecord>(key);
  if (existing && existing.editorId === prev) {
    await setMeta(key, { sessionId, editorId: prev, at: Date.now() } as LockRecord);
  }
}

export type LockResult = { ok: true } | { ok: false; heldBy: string };

export async function acquireSessionLock(sessionId: string, editorId: string): Promise<LockResult> {
  const key = `lock:${sessionId}`;
  const existing = await getMeta<LockRecord>(key);
  const now = Date.now();

  // 自己的锁：直接续期
  if (existing && existing.editorId === editorId) {
    await setMeta(key, { sessionId, editorId, at: now } as LockRecord);
    return { ok: true };
  }

  // 别人持有且未过期
  if (existing && existing.editorId && existing.editorId !== editorId && now - existing.at < LOCK_TTL_MS) {
    return { ok: false, heldBy: existing.editorId };
  }

  // 无锁或已过期 → 接管
  await setMeta(key, { sessionId, editorId, at: now } as LockRecord);
  broadcast({ type: 'lock', sessionId, editorId });
  return { ok: true };
}

export async function refreshSessionLock(sessionId: string, editorId: string): Promise<boolean> {
  const key = `lock:${sessionId}`;
  const existing = await getMeta<LockRecord>(key);
  const now = Date.now();
  // 锁已被别人接管 → 通知调用方降级为只读
  if (existing && existing.editorId && existing.editorId !== editorId && now - existing.at < LOCK_TTL_MS) {
    return false;
  }
  await setMeta(key, { sessionId, editorId, at: now } as LockRecord);
  return true;
}

export async function releaseSessionLock(sessionId: string, editorId: string): Promise<void> {
  const key = `lock:${sessionId}`;
  const existing = await getMeta<LockRecord>(key);
  if (!existing || existing.editorId === editorId) {
    await setMeta(key, { sessionId, editorId: '', at: 0 } as LockRecord);
    broadcast({ type: 'release', sessionId, editorId });
  }
}

function broadcast(msg: { type: string; sessionId: string; editorId: string }) {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage(msg);
    ch.close();
  } catch {
    /* BroadcastChannel 不可用时不影响主流程 */
  }
}

/** 别的标签页抢锁/释放时的通知 */
export function listenLockEvents(
  onEvent: (e: { type: string; sessionId: string; editorId: string }) => void,
): () => void {
  let ch: BroadcastChannel | null = null;
  try {
    ch = new BroadcastChannel(CHANNEL);
    ch.onmessage = (ev) => {
      const data = ev.data as { type?: string; sessionId?: string; editorId?: string };
      if (data?.type && data.sessionId && data.editorId) {
        onEvent({ type: data.type, sessionId: data.sessionId, editorId: data.editorId });
      }
    };
  } catch {
    return () => undefined;
  }
  return () => ch?.close();
}
