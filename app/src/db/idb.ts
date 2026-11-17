/* 极简 IndexedDB 封装。
   选择理由：
   · 训练记录会持续增长，结构化查询（按日期/动作）用 objectStore + index 比一个超大 JSON 字符串更稳。
   · 每次修改都在一个 readwrite 事务里完成，浏览器保证原子性；中断不会写出半条记录。
   · 单条记录 = 单个 key，写入量小，不会像 localStorage 那样每次全量序列化整段历史。 */

export interface StoreDef {
  name: string;
  keyPath: string;
  indexes?: Array<{ name: string; keyPath: string | string[]; unique?: boolean }>;
}

const DB_NAME = 'motion-training';
const DB_VERSION = 1;

const STORES: StoreDef[] = [
  { name: 'meta', keyPath: 'key' },
  {
    name: 'plans',
    keyPath: 'id',
    indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  },
  {
    name: 'sessions',
    keyPath: 'id',
    indexes: [
      { name: 'startedAt', keyPath: 'startedAt' },
      { name: 'status', keyPath: 'status' },
      { name: 'endedAt', keyPath: 'endedAt' },
    ],
  },
  { name: 'settings', keyPath: 'key' },
];

let dbPromise: Promise<IDBDatabase> | null = null;

export class StorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'StorageError';
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StorageError('当前浏览器不支持本地数据库（IndexedDB）'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const def of STORES) {
        if (!db.objectStoreNames.contains(def.name)) {
          const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
          for (const idx of def.indexes ?? []) {
            store.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('打开本地数据库失败', req.error));
    req.onblocked = () => reject(new StorageError('数据库被其他标签页占用，请关闭其它 MOTION 标签页后重试'));
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T> | T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let result: T;
        let settled = false;
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        t.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve(result);
          }
        };
        t.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new StorageError(`写入失败：${t.error?.message ?? '未知错误'}`, t.error));
          }
        };
        t.onabort = () => {
          if (!settled) {
            settled = true;
            reject(new StorageError('事务被中止，数据未保存', t.error));
          }
        };
        Promise.resolve(run(s))
          .then((r) => {
            result = r;
          })
          .catch((err) => {
            settled = true;
            try {
              t.abort();
            } catch {
              /* ignore */
            }
            reject(err instanceof StorageError ? err : new StorageError('写入失败', err));
          });
      }),
  );
}

const reqToPromise = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new StorageError('读取失败', req.error));
  });

export function idbPut<T>(store: string, value: T): Promise<void> {
  return tx(store, 'readwrite', (s) => reqToPromise(s.put(value as unknown as object)).then(() => undefined));
}

export function idbPutMany<T>(store: string, values: T[]): Promise<void> {
  return tx(store, 'readwrite', async (s) => {
    for (const v of values) await reqToPromise(s.put(v as unknown as object));
  });
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return tx(store, 'readonly', (s) => reqToPromise(s.get(key) as IDBRequest<T | undefined>));
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return tx(store, 'readonly', (s) => reqToPromise(s.getAll() as IDBRequest<T[]>));
}

export function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return tx(store, 'readwrite', (s) => reqToPromise(s.delete(key)).then(() => undefined));
}

export function idbClear(store: string): Promise<void> {
  return tx(store, 'readwrite', (s) => reqToPromise(s.clear()).then(() => undefined));
}

export function idbGetAllByIndex<T>(store: string, index: string, query: IDBValidKey | IDBKeyRange): Promise<T[]> {
  return tx(store, 'readonly', (s) => reqToPromise(s.index(index).getAll(query) as IDBRequest<T[]>));
}

/** 原子替换多个 store 的全部数据（用于「完整恢复」）。要么全部生效，要么全部回滚。 */
export function idbReplaceAll(payload: Record<string, unknown[]>): Promise<void> {
  const stores = Object.keys(payload);
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(stores, 'readwrite');
        t.oncomplete = () => resolve();
        t.onerror = () => reject(new StorageError('恢复失败，已回滚到原有数据', t.error));
        t.onabort = () => reject(new StorageError('恢复被中止，原有数据未改变', t.error));
        try {
          for (const store of stores) {
            const s = t.objectStore(store);
            s.clear();
            for (const row of payload[store]) s.put(row as object);
          }
        } catch (err) {
          try {
            t.abort();
          } catch {
            /* ignore */
          }
          reject(new StorageError('恢复过程中出错，已回滚', err));
        }
      }),
  );
}

/** 供测试使用：重置连接以便换库 */
export function __resetDbHandle(): void {
  dbPromise = null;
}

/**
 * G1：全量恢复（plans / sessions / settings / 动作模板）的原子入口。
 *
 * 关键边界：
 * · **绝不把整个 meta store 交给通用 clear**：只删除 `exercise-template:` 前缀的行；
 *   锁（lock:*）、播种（seeded）、恢复前快照（pre-restore-snapshot）等无关元数据
 *   完整保留。恢复成功后在同一事务内写 `seeded = true`（恢复即视为已初始化）。
 * · plans / sessions / settings 与模板在一笔 readwrite 事务里替换，
 *   任一步失败整体 abort（原有数据不变）。
 */
export function idbRestoreAll(payload: {
  plans: unknown[];
  sessions: unknown[];
  settings: unknown[];
  exerciseTemplates: unknown[];
}): Promise<void> {
  const TEMPLATE_PREFIX = 'exercise-template:';
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(['plans', 'sessions', 'settings', 'meta'], 'readwrite');
        } catch (err) {
          reject(new StorageError('恢复失败，原有数据未改变', err));
          return;
        }
        let failed = false;
        const fail = (cause: unknown) => {
          if (failed) return;
          failed = true;
          try {
            t.abort();
          } catch {
            /* ignore */
          }
          reject(cause instanceof StorageError ? cause : new StorageError('恢复失败，原有数据未改变', cause));
        };
        t.oncomplete = () => {
          if (!failed) resolve();
        };
        t.onerror = () => fail(t.error);
        t.onabort = () => fail(new StorageError('恢复被中止，原有数据未改变', t.error));
        try {
          const plansStore = t.objectStore('plans');
          const sessionsStore = t.objectStore('sessions');
          const settingsStore = t.objectStore('settings');
          const metaStore = t.objectStore('meta');
          plansStore.clear();
          sessionsStore.clear();
          settingsStore.clear();
          for (const row of payload.plans) plansStore.put(row as object);
          for (const row of payload.sessions) sessionsStore.put(row as object);
          for (const row of payload.settings) settingsStore.put(row as object);

          // 只定向清理模板前缀；其它 meta（锁/seed/恢复前快照等）原样保留
          const keysReq = metaStore.getAllKeys();
          keysReq.onerror = () => fail(keysReq.error);
          keysReq.onsuccess = () => {
            try {
              for (const key of keysReq.result) {
                if (typeof key === 'string' && key.startsWith(TEMPLATE_PREFIX)) metaStore.delete(key);
              }
              for (const tpl of payload.exerciseTemplates) {
                const row = tpl as { exerciseId?: unknown };
                if (typeof row.exerciseId !== 'string' || !row.exerciseId) {
                  throw new StorageError('动作模板缺少 exerciseId，恢复已取消');
                }
                metaStore.put({ key: `${TEMPLATE_PREFIX}${row.exerciseId}`, value: tpl });
              }
              metaStore.put({ key: 'seeded', value: true });
            } catch (err) {
              fail(err);
            }
          };
        } catch (err) {
          fail(err);
        }
      }),
  );
}

/**
 * G1：单笔只读事务读取完整备份所需的所有 store（plans / sessions / settings / meta）。
 *
 * 为什么必须同一事务：buildBackup 若依次 await 多个独立事务，
 * Session+模板的原子更新可能在两次读取之间提交，导出会拼出
 * 「旧 Session + 新模板」的不一致快照。同一 readonly 事务保证看到同一提交点。
 */
export interface DbSnapshot {
  plans: unknown[];
  sessions: unknown[];
  settings: unknown[];
  meta: Array<{ key: unknown; value: unknown }>;
}

export function idbSnapshotAll(): Promise<DbSnapshot> {
  return openDb().then(
    (db) =>
      new Promise<DbSnapshot>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(['plans', 'sessions', 'settings', 'meta'], 'readonly');
        } catch (err) {
          reject(new StorageError('读取备份快照失败', err));
          return;
        }
        let plans: unknown[] = [];
        let sessions: unknown[] = [];
        let settings: unknown[] = [];
        let meta: Array<{ key: unknown; value: unknown }> = [];
        let pending = 4;
        let settled = false;
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          reject(cause instanceof StorageError ? cause : new StorageError('读取备份快照失败', cause));
        };
        const done = () => {
          pending -= 1;
          if (pending === 0 && !settled) {
            settled = true;
            resolve({ plans, sessions, settings, meta });
          }
        };
        t.onerror = () => fail(t.error);
        t.onabort = () => fail(t.error);
        try {
          const rPlans = t.objectStore('plans').getAll();
          rPlans.onsuccess = () => { plans = rPlans.result as unknown[]; done(); };
          rPlans.onerror = () => fail(rPlans.error);
          const rSessions = t.objectStore('sessions').getAll();
          rSessions.onsuccess = () => { sessions = rSessions.result as unknown[]; done(); };
          rSessions.onerror = () => fail(rSessions.error);
          const rSettings = t.objectStore('settings').getAll();
          rSettings.onsuccess = () => { settings = rSettings.result as unknown[]; done(); };
          rSettings.onerror = () => fail(rSettings.error);
          const rMeta = t.objectStore('meta').getAll();
          rMeta.onsuccess = () => { meta = rMeta.result as Array<{ key: unknown; value: unknown }>; done(); };
          rMeta.onerror = () => fail(rMeta.error);
        } catch (err) {
          fail(err);
        }
      }),
  );
}
