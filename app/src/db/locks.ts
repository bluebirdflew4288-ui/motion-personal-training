/* 编辑锁的唯一 schema 与唯一读写入口（V3-01）。
   问题背景（独立审查 D12/D13）：
   · `tx.atomicAcquireLock` 把锁写成扁平记录 `{key,sessionId,editorId,at}`；
   · `lib/lock` 的续租/释放却经 `repo.getMeta/setMeta` 写成 `{key,value:{...}}`（nested）。
   于是普通训练在 8 秒心跳后格式就被换掉，另一个标签页把它当「无锁」抢走，
   旧标签页的陈旧保存还能成功覆盖新数据。这不是「第一次获取」能测出来的。

   本轮规则：
   · 锁只有一种 schema，就是本文件定义的 `LockRow`，扁平存在 meta 表。
   · 获取 / 续租 / 释放 / (保存时)校验，全部在同一个 readwrite 事务里读当前行再决定。
   · 非持有者不得释放、不得覆盖；锁缺失 / 损坏 / 过期一律「无写入资格」，不默认放行。
   · 事务内不做「读-算-写」以外的异步操作，保证原子性。

   meta 表 keyPath 是 'key'，所以整行就是锁记录本身，不再套 value。 */

import { openDb, StorageError } from './idb';

/** 锁记录：meta 表里 `key = lock:<sessionId>` 的那一行 */
export interface LockRow {
  key: string;
  /** 冗余存一份 sessionId，便于自检与调试 */
  sessionId: string;
  /** 空字符串 = 已释放（保留行，便于观察最近一次释放者） */
  editorId: string;
  /** 最后一次心跳的毫秒时间戳；释放时写 0 */
  at: number;
}

export const DEFAULT_LOCK_TTL_MS = 20_000;

export function lockKey(sessionId: string): string {
  return `lock:${sessionId}`;
}

/** 判断一条 meta 行是否是**结构合法**的锁；损坏/嵌套/缺字段都返回 false */
export function isLockRow(v: unknown): v is LockRow {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.key === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.editorId === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  );
}

export type LockState =
  | { kind: 'free' }
  | { kind: 'held'; editorId: string; at: number; expired: boolean }
  | { kind: 'corrupt'; raw: unknown };

/** 纯函数：把一条 meta 行解释成锁状态（不读库，便于单测） */
export function interpretLock(raw: unknown, now: number, ttlMs: number): LockState {
  if (raw === undefined || raw === null) return { kind: 'free' };
  if (!isLockRow(raw)) return { kind: 'corrupt', raw };
  if (!raw.editorId) return { kind: 'free' };
  return { kind: 'held', editorId: raw.editorId, at: raw.at, expired: now - raw.at > ttlMs };
}

/** 当前调用方是否**有权写入**：必须持有、未过期、且结构合法 */
export function lockGrantsWrite(raw: unknown, editorId: string, now: number, ttlMs: number): boolean {
  const st = interpretLock(raw, now, ttlMs);
  return st.kind === 'held' && st.editorId === editorId && !st.expired;
}

export interface LockOpResult {
  /** 是否成功（获取/续租/释放都表示「操作被原子地接受」） */
  ok: boolean;
  /** 被谁占着（ok=false 时有效） */
  heldBy?: string;
  /** 失败原因，便于 UI 给准确提示 */
  reason?: 'held-by-other' | 'not-owner' | 'corrupt' | 'storage' | 'expired';
  message?: string;
}

/* 在 meta store 上跑一个 readwrite 事务，事务内完成「读当前锁 → 决定 → 写」。
   注意：IndexedDB 事务会在没有 pending request 且回到事件循环时自动提交，
   所以这里所有判断都必须在 onsuccess 回调里**同步**完成，不能 await。 */
function runLockTx(
  sessionId: string,
  decide: (
    raw: unknown,
    now: number,
  ) => { write?: LockRow | null; result: LockOpResult },
  ttlMs: number,
): Promise<LockOpResult> {
  return openDb().then(
    (db) =>
      new Promise<LockOpResult>((resolve) => {
        let settled = false;
        const done = (r: LockOpResult) => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        let t: IDBTransaction;
        try {
          t = db.transaction('meta', 'readwrite');
        } catch (err) {
          done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '事务开启失败' });
          return;
        }
        const store = t.objectStore('meta');
        const key = lockKey(sessionId);
        const req = store.get(key);
        let decided: { write?: LockRow | null; result: LockOpResult } | null = null;

        req.onsuccess = () => {
          const now = Date.now();
          try {
            decided = decide(req.result, now);
          } catch (err) {
            done({ ok: false, reason: 'storage', message: err instanceof Error ? err.message : '锁判定失败' });
            try {
              t.abort();
            } catch {
              /* ignore */
            }
            return;
          }
          const w = decided.write;
          if (w) store.put(w);
        };
        req.onerror = () => {
          done({ ok: false, reason: 'storage', message: '无法读取编辑锁' });
          try {
            t.abort();
          } catch {
            /* ignore */
          }
        };
        t.oncomplete = () => done(decided ? decided.result : { ok: false, reason: 'storage', message: '锁事务未产生结果' });
        t.onabort = () => done({ ok: false, reason: 'storage', message: '锁事务被中止' });
        t.onerror = () => done({ ok: false, reason: 'storage', message: t.error?.message ?? '锁写入失败' });
        void ttlMs;
      }),
  );
}

/**
 * 获取或续租锁（同一操作：如果锁本来就是自己的，刷新时间戳）。
 * 原子：读当前锁与写入在同一个事务里，两个标签页不会同时成功。
 */
export function atomicAcquireOrRenew(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockOpResult> {
  return runLockTx(
    sessionId,
    (raw, now) => {
      const st = interpretLock(raw, now, ttlMs);
      if (st.kind === 'corrupt') {
        // 损坏的锁不能默认放行：要求人工处理（刷新页面重新认领）
        return { result: { ok: false, reason: 'corrupt', message: '编辑锁记录已损坏，请刷新页面重新取得控制' } };
      }
      if (st.kind === 'held' && st.editorId !== editorId && !st.expired) {
        return { result: { ok: false, heldBy: st.editorId, reason: 'held-by-other', message: '这个训练正在另一个标签页中编辑' } };
      }
      return {
        write: { key: lockKey(sessionId), sessionId, editorId, at: now },
        result: { ok: true },
      };
    },
    ttlMs,
  );
}

/**
 * 心跳续租：**只延长自己已持有的锁**。
 *
 * 关键约束（浏览器双标签实测发现）：续租绝不能创建锁。
 * 如果续租在「锁为空」时也写入，那一个只读标签页的 8 秒心跳会在持有者
 * 离开并释放锁的瞬间把它悄悄抢走 —— 表现为「A 释放后锁立刻又被占用」，
 * 这与「只读页不得取得控制」直接冲突，也会让首页的冲突判断误判。
 * 想取得控制必须显式调用 acquire（用户点击「接管」或重新进入训练页）。
 */
export async function atomicRenew(
  sessionId: string,
  editorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockOpResult> {
  return runLockTx(
    sessionId,
    (raw, now) => {
      const st = interpretLock(raw, now, ttlMs);
      if (st.kind === 'corrupt') {
        return { result: { ok: false, reason: 'corrupt', message: '编辑锁记录已损坏' } };
      }
      if (st.kind === 'free') {
        return {
          result: { ok: false, reason: 'not-owner', message: '本页当前没有编辑锁，不能续租；请重新进入这个训练' },
        };
      }
      if (st.editorId !== editorId) {
        return {
          result: {
            ok: false,
            heldBy: st.editorId,
            reason: st.expired ? 'expired' : 'held-by-other',
            message: '这个训练已被另一个标签页接管',
          },
        };
      }
      if (st.expired) {
        // 自己的锁已过期：必须重新 acquire（由 UI 决定是重新认领还是提示接管）
        return { result: { ok: false, reason: 'expired', message: '编辑锁已过期，请重新取得控制' } };
      }
      return {
        write: { key: lockKey(sessionId), sessionId, editorId, at: now },
        result: { ok: true },
      };
    },
    ttlMs,
  );
}

/**
 * 释放锁。只有持有者能释放；非持有者调用不做任何写入
 * （这是审查 D13 的直接问题：A 释放了 B 的锁，随后 A 还能写）。
 */
export function atomicRelease(sessionId: string, editorId: string): Promise<LockOpResult> {
  return runLockTx(
    sessionId,
    (raw) => {
      const st = interpretLock(raw, Date.now(), DEFAULT_LOCK_TTL_MS);
      if (st.kind === 'corrupt') {
        // 损坏的锁无法判定归属：不写，交由上层提示
        return { result: { ok: false, reason: 'corrupt', message: '编辑锁记录已损坏' } };
      }
      if (st.kind === 'free') {
        // 本来就是空的：视为已释放，不写
        return { result: { ok: true } };
      }
      if (st.editorId !== editorId) {
        return { result: { ok: false, heldBy: st.editorId, reason: 'not-owner', message: '当前标签页不是锁的持有者' } };
      }
      return {
        write: { key: lockKey(sessionId), sessionId, editorId: '', at: 0 },
        result: { ok: true },
      };
    },
    DEFAULT_LOCK_TTL_MS,
  );
}

/**
 * 把自己的锁原子地交给**同一个标签页的新实例**（V8-LC08）。
 *
 * ── 为什么必须存在 ────────────────────────────────────────────
 * LC08 的根因不是「慢」，而是**锁的身份粒度不对**：
 * `makeEditorId()` 把 editorId 存在 sessionStorage 里，于是同一个 WebView 里
 * 「离开训练页 → 立刻重进」拿到的是**同一个 editorId**。
 * 旧页面的卸载清理里那句 fire-and-forget 的 release，
 * 在新页面已经 acquire 之后才落地，`atomicRelease` 一看 editorId 相同就认为
 * “是我的锁”，把它清掉 —— 新页面随即变成 no-lock，之后第一笔输入保存失败。
 *
 * 修法是给每次「页面实例」一个独立 editorId，并且把「接手上一个实例的锁」
 * 做成一个**原子操作**：只有当前持锁者确实是本标签页的上一个实例时才换名，
 * 否则一律拒绝（别人有效持锁 → 不偷锁）。
 *
 * 这样旧实例晚到的 release 会因为 editorId 不再匹配而被存储层拒绝，
 * 不会伤到新实例的锁。
 */
export function atomicAdoptLock(
  sessionId: string,
  fromEditorId: string,
  toEditorId: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockOpResult> {
  return runLockTx(
    sessionId,
    (raw, now) => {
      const st = interpretLock(raw, now, ttlMs);
      if (st.kind === 'corrupt') {
        return { result: { ok: false, reason: 'corrupt', message: '编辑锁记录已损坏，请刷新页面重新取得控制' } };
      }
      // 只允许从「本标签页的上一个实例」接手；free/过期也可直接落名
      const canAdopt =
        st.kind === 'free' || st.editorId === fromEditorId || (st.kind === 'held' && st.expired);
      if (!canAdopt) {
        return {
          result: {
            ok: false,
            heldBy: st.kind === 'held' ? st.editorId : undefined,
            reason: 'held-by-other',
            message: '这个训练正在另一个标签页中编辑',
          },
        };
      }
      return {
        write: { key: lockKey(sessionId), sessionId, editorId: toEditorId, at: now },
        result: { ok: true },
      };
    },
    ttlMs,
  );
}

/** 读取当前锁状态（只读，供 UI 判断是否需要接管） */
export async function readLockState(sessionId: string, ttlMs = DEFAULT_LOCK_TTL_MS): Promise<LockState> {
  const db = await openDb();
  const raw = await new Promise<unknown>((resolve, reject) => {
    const t = db.transaction('meta', 'readonly');
    const req = t.objectStore('meta').get(lockKey(sessionId));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('无法读取编辑锁', req.error));
  });
  return interpretLock(raw, Date.now(), ttlMs);
}
