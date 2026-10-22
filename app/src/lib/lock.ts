/* 单活动训练编辑者（V3-01 修复版）。
   场景：同一浏览器开两个标签页进同一个训练，不能让两边静默互相覆盖。

   历史缺陷（独立审查 D12/D13）：
   · 获取锁写扁平记录 `{key,sessionId,editorId,at}`；
   · 心跳/释放却经 repo.getMeta/setMeta 写 `{key,value:{...}}` 嵌套记录。
   → 普通训练 8 秒后锁 schema 就被换掉，另一个标签页把它当「无锁」抢走，
     旧标签页的陈旧保存还能覆盖新数据；A 甚至能释放 B 的锁。

   本轮规则：
   · 锁只有一种 schema，读写只有 db/locks.ts 一个入口（扁平行，meta key = lock:<sessionId>）。
   · 获取 / 续租 / 释放都在原子事务里核对当前持有者；非持有者不得释放或覆盖。
   · 锁缺失 / 损坏 / 过期 => 无写入资格（不默认放行），由 UI 明确提示。
   · 心跳 8 秒；租期 20 秒（8 秒心跳下能容忍一次丢帧）。 */

import {
  atomicAcquireOrRenew,
  atomicAdoptLock,
  atomicRelease,
  atomicRenew,
  readLockState,
  DEFAULT_LOCK_TTL_MS,
  type LockOpResult,
  type LockState,
} from '../db/locks';

export const LOCK_TTL_MS = DEFAULT_LOCK_TTL_MS;
const CHANNEL = 'motion-training-lock';
/** 刷新后要在 sessionStorage 里找回自己的 editorId，否则会被自己留下的锁挡在门外 */
const SS_KEY = 'motion-editor-id';

/**
 * 生成**每个页面实例独立**的 editorId（V8-LC08）。
 *
 * 旧实现的做法是：sessionStorage 里已有就复用。
 * 这样同一 WebView 里「离开训练页 → 快速重进」得到**同一个 editorId**，
 * 旧实例卸载时那条 fire-and-forget 的 release（它无法被 await）
 * 会在新实例已经拿到锁之后才落地，而 atomicRelease 只检查 editorId 相同，
 * 于是把新实例刚拿到的锁清掉 → 之后第一笔保存 no-lock。这就是 LC08。
 *
 * 现在：
 *   · 每个页面实例都生成新的 editorId（`instance` 递增序号 + 随机后缀）；
 *   · 上一个实例的 editorId 只用于 **原子接手**（atomicAdoptLock），不直接复用；
 *   · 旧实例晚到的 release 因为 editorId 不匹配被存储层拒绝，伤不到新实例。
 *
 * 刷新页面后「自己的锁不挡自己」仍由 reclaimOwnLock 处理：它按 sessionStorage
 * 里的上一个 editorId 做一次原子接手，而不是假设两者同名。
 */
let instanceSeq = 0;

export function makeEditorId(): string {
  instanceSeq += 1;
  return `ed-${Date.now().toString(36)}-${instanceSeq.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 记录当前实例的 editorId，供下一次刷新/重进时原子接手 */
export function rememberEditorId(editorId: string): void {
  try {
    sessionStorage.setItem(SS_KEY, editorId);
  } catch {
    /* 隐私模式下可能不可用：只影响刷新后自动接手，不影响本次编辑 */
  }
}

/** 读取上一次（刷新前）实例的 editorId */
export function previousEditorId(): string | null {
  try {
    return sessionStorage.getItem(SS_KEY);
  } catch {
    return null;
  }
}

export type LockResult = { ok: true } | { ok: false; heldBy: string };

/**
 * 获取/续租锁。读与写在同一 IndexedDB 事务里完成，
 * 否则两个标签页会同时读到「无锁」并都返回 ok=true。
 */
export async function acquireSessionLock(sessionId: string, editorId: string): Promise<LockResult> {
  const r = await atomicAcquireOrRenew(sessionId, editorId, LOCK_TTL_MS);
  if (r.ok) broadcast({ type: 'lock', sessionId, editorId });
  return r.ok ? { ok: true } : { ok: false, heldBy: r.heldBy ?? 'unknown' };
}

/** 带失败原因的获取（UI 用来区分「被占用 / 锁损坏 / 存储失败」） */
export async function acquireSessionLockDetailed(sessionId: string, editorId: string): Promise<LockOpResult> {
  const r = await atomicAcquireOrRenew(sessionId, editorId, LOCK_TTL_MS);
  if (r.ok) broadcast({ type: 'lock', sessionId, editorId });
  return r;
}

/**
 * 刷新 / 快速重进后，把自己上一次留下的锁**原子地改名**给当前实例。
 *
 * V8-LC08：改名必须原子，且只在「持锁者确实是本标签页的上一个实例」时成立。
 *
 * ── A05 修正：上一个持有者必须由调用方**在覆盖 sessionStorage 之前**捕获 ──
 * 旧签名内部读 previousEditorId()，看起来方便，但它把自己交给了调用顺序：
 * 只要调用方先 rememberEditorId(新 ID) 再调用本函数，
 * previousEditorId() 读到的就是**新 ID**，于是 prev === editorId 直接返回 true，
 * 真正的 atomicAdoptLock 根本没跑 —— 旧实例那把未过期的锁原封不动留在库里，
 * 新实例随后 acquire 撞上「held-by-other」，刷新/快速重进把自己锁在门外。
 *
 * 现在改为显式传入 `previousOwner`（调用方在发布新 ID 之前抓到的那一个），
 * 顺序错不了：本函数只做「原子改名」，绝不读也不写 sessionStorage。
 *
 * @param previousOwner 上一个实例的 editorId（可为 null）
 * @returns 是否接手成功（false 表示锁在别人手里 / 已损坏，调用方应走正常 acquire）
 */
export async function reclaimOwnLock(
  sessionId: string,
  editorId: string,
  previousOwner: string | null,
): Promise<boolean> {
  if (!previousOwner) return false;
  // 同一个 ID 不需要改名（正常不应发生：实例 ID 唯一）
  if (previousOwner === editorId) return false;
  const r = await atomicAdoptLock(sessionId, previousOwner, editorId, LOCK_TTL_MS);
  if (r.ok) broadcast({ type: 'lock', sessionId, editorId });
  return r.ok;
}

/**
 * 取得本页编辑权的完整顺序（V8-LC08 / A05 的**唯一**入口）。
 *
 * 顺序在这里被**结构固定**，调用方无法弄错：
 *   ① 先抓上一个实例的 editorId（还没发布新 ID，读到的一定是旧的）；
 *   ② 若确实有旧持有者，原子改名给自己（atomicAdoptLock，别人持锁则拒绝）；
 *   ③ **改名成功之后**才把新 ID 写进 sessionStorage（供下一次刷新接手）；
 *   ④ 最后按常规 acquire 确认可写。
 *
 * @returns 最终是否可写，以及失败原因（供 UI 显示只读横幅）
 */
export async function takeOwnershipOnMount(args: {
  sessionId: string;
  /** 本实例的 editorId（调用方已生成） */
  editorId: string;
}): Promise<LockOpResult> {
  const { sessionId, editorId } = args;

  // ① 捕获真正的上一个持有者 —— 必须早于任何 rememberEditorId
  const previousOwner = previousEditorId();

  // ② 原子接手（只在「本标签页上一个实例」时成立）
  const adopted = await reclaimOwnLock(sessionId, editorId, previousOwner);

  // ③ 现在才发布新 ID
  rememberEditorId(editorId);

  // ④ 常规获取；adopted 只是提前把旧锁改名，仍以 acquire 的结论为准
  const r = await acquireSessionLockDetailed(sessionId, editorId);
  if (r.ok) return r;

  // acquire 失败但接手成功：说明锁被第三方抢占（例如另一标签页），如实返回失败
  void adopted;
  return r;
}

/**
 * 心跳续租。只有当前持有者能续上；
 * 返回 false 表示已失去锁，调用方必须降级为只读并停止写入。
 */
export async function refreshSessionLock(sessionId: string, editorId: string): Promise<boolean> {
  const r = await atomicRenew(sessionId, editorId, LOCK_TTL_MS);
  return r.ok;
}

/** 心跳（带原因版本） */
export async function refreshSessionLockDetailed(sessionId: string, editorId: string): Promise<LockOpResult> {
  return atomicRenew(sessionId, editorId, LOCK_TTL_MS);
}

/** 主动接管：先确认对方租期是否已过；过期才允许抢占（UI 用它做「接管继续」） */
export async function takeOverSessionLock(sessionId: string, editorId: string): Promise<LockOpResult> {
  const st = await readLockState(sessionId, LOCK_TTL_MS);
  if (st.kind === 'held' && st.editorId !== editorId && !st.expired) {
    return {
      ok: false,
      heldBy: st.editorId,
      reason: 'held-by-other',
      message: '另一个标签页仍在编辑，等它停止心跳（约 20 秒）后可以接管',
    };
  }
  if (st.kind === 'corrupt') {
    return { ok: false, reason: 'corrupt', message: '编辑锁记录已损坏，请刷新页面重新取得控制' };
  }
  const r = await atomicAcquireOrRenew(sessionId, editorId, LOCK_TTL_MS);
  if (r.ok) broadcast({ type: 'lock', sessionId, editorId });
  return r;
}

/**
 * 释放锁。只有持有者能释放；非持有者调用不做任何写入
 * （这是审查 D13 的直接问题：A 释放了 B 的锁，随后 A 还能写）。
 */
export async function releaseSessionLock(sessionId: string, editorId: string): Promise<boolean> {
  const r = await atomicRelease(sessionId, editorId);
  if (r.ok) broadcast({ type: 'release', sessionId, editorId });
  return r.ok;
}

/** 只读查询当前锁状态（供 UI 展示冲突详情） */
export async function currentLockState(sessionId: string): Promise<LockState> {
  return readLockState(sessionId, LOCK_TTL_MS);
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
