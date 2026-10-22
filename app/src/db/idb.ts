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
