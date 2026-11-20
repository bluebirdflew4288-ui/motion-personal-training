/* 电子教练独立存储域（motion-coach-vault，阶段 2）。
   安全与隔离红线：
   · 聊天记录、压缩图片（<= 1MB，去 EXIF）、模型设置/API Key 与操作回执一律落在本独立库中；
   · 绝不写入 motion-training 主库（plans / sessions / settings / meta），绝不污染 BackupPayload v4；
   · restoreEpoch 随 Backup v4 恢复递增，使恢复前历史回执自动失效，防止把回执撤销打到已覆盖的历史态上。 */

import type { ExerciseTarget, Plan, Session, SessionSet } from '../domain/types';
import type { CoachProviderKind, CoachThinkingDepth } from './providerAdapter';

export const COACH_VAULT_DB_NAME = 'motion-coach-vault';
const COACH_VAULT_DB_VERSION = 1;
export const DEFAULT_COACH_THREAD_ID = 'default';
const MAX_STORED_MESSAGES = 240;
const MAX_STORED_IMAGE_MESSAGES = 16;

export type CoachToolName =
  | 'adjust_active_target'
  | 'record_active_set'
  | 'configure_superset'
  | 'correct_history_session'
  | 'create_plan_from_draft'
  | 'modify_existing_plan'
  | 'sync_session_to_plan';

export type CoachReceiptScope = 'session' | 'history' | 'plan' | 'session+plan';

export interface CoachReceiptSetTouched {
  kind: 'session-set';
  sessionId: string;
  exId: string;
  setId: string;
  beforeSet: SessionSet;
  afterSet: SessionSet;
  /** 本次操作连带自动预填的后续组（用于字段级撤销同步回滚未被用户二次修改的预填项） */
  prefilledSets?: Array<{
    setId: string;
    beforeWeightKg: number | null;
    afterWeightKg: number | null;
  }>;
}

export interface CoachReceiptExerciseTargetTouched {
  kind: 'exercise-target';
  sessionId: string;
  exId: string;
  beforeTarget: ExerciseTarget;
  afterTarget: ExerciseTarget;
  beforeSets: SessionSet[];
  afterSets: SessionSet[];
}

export interface CoachReceiptSupersetTouched {
  kind: 'exercise-superset';
  sessionId: string;
  beforeSession: Session;
  afterSession: Session;
}

export interface CoachReceiptHistoryTouched {
  kind: 'history-edit';
  sessionId: string;
  beforeSession: Session;
  afterSession: Session;
}

export interface CoachReceiptPlanCreatedTouched {
  kind: 'plan-created';
  planId: string;
}

export interface CoachReceiptPlanDayTouched {
  kind: 'plan-day';
  planId: string;
  beforePlan: Plan;
  afterPlan: Plan;
}

export type CoachReceiptTouchedTarget =
  | CoachReceiptSetTouched
  | CoachReceiptExerciseTargetTouched
  | CoachReceiptSupersetTouched
  | CoachReceiptHistoryTouched
  | CoachReceiptPlanCreatedTouched
  | CoachReceiptPlanDayTouched;

export interface CoachOperationReceipt {
  id: string;
  operationId: string;
  toolName: CoachToolName;
  createdAt: number;
  scope: CoachReceiptScope;
  summary: string;
  entityType: 'session' | 'plan' | 'session+plan';
  entityId: string;
  planId?: string;
  beforeRevision: number;
  afterRevision: number;
  beforePlanRevision?: number;
  afterPlanRevision?: number;
  restoreEpoch: number;
  undone: boolean;
  undoneAt?: number;
  timerStarted?: boolean;
  touchedTargets: CoachReceiptTouchedTarget[];
}

export interface CoachStoredAttachment {
  id: string;
  kind?: 'image' | 'video';
  name: string;
  mimeType: string;
  dataBase64: string;
  width: number;
  height: number;
  sizeBytes: number;
  durationSec?: number;
  posterDataUrl?: string;
  exifStripped?: boolean;
}

export interface CoachPlanDraftStage {
  label: string;
  repsMin: number;
  repsMax: number;
  weightKg: number | null;
}

export interface CoachPlanDraftExercise {
  name: string;
  kind: 'straight' | 'dropSet';
  form?: 'drop' | 'superset';
  sets: number;
  repsMin: number;
  repsMax: number;
  weightMode: 'external' | 'bodyweight';
  suggestedWeightKg: number | null;
  dumbbellBasis?: 'per_hand' | 'total';
  pairGroup?: string;
  stages?: CoachPlanDraftStage[];
}

export interface CoachPlanDraftDay {
  dayName: string;
  exercises: CoachPlanDraftExercise[];
}

export interface CoachPlanDraft {
  id: string;
  planName: string;
  days: CoachPlanDraftDay[];
  warnings?: string[];
  confirmedPlanId?: string;
}

export interface CoachStoredMessage {
  id: string;
  threadId?: string;
  role: 'user' | 'assistant';
  createdAt: number;
  text: string;
  reasoning?: string;
  attachments?: CoachStoredAttachment[];
  receiptIds?: string[];
  draftPlan?: CoachPlanDraft;
  thinkingFallback?: boolean;
  compressed?: boolean;
  isDemo?: boolean;
}

export interface CoachThreadMeta {
  id: string;
  title: string;
  titleSource?: 'placeholder' | 'auto' | 'manual';
  createdAt: number;
  updatedAt: number;
  contextSummary?: string;
  compressedCount?: number;
}

export interface CoachThreadsState {
  activeThreadId: string;
  threads: CoachThreadMeta[];
}

export interface CoachStoredProviderConfig {
  key: 'provider';
  kind: CoachProviderKind;
  baseUrl: string;
  model: string;
  models?: string[];
  thinkingDepth?: CoachThinkingDepth;
  thinkingByModel?: Record<string, CoachThinkingDepth>;
  capabilitiesByModel?: Record<string, CoachThinkingDepth[]>;
  apiKey: string;
  updatedAt: number;
}

let vaultDbPromise: Promise<IDBDatabase> | null = null;
let cachedRestoreEpoch = 0;

// IDB 不可用时的内存回退仓（如 SSR / 极简环境）
const memoryMessages = new Map<string, CoachStoredMessage>();
const memoryReceipts = new Map<string, CoachOperationReceipt>();
const memoryConfig = new Map<string, CoachStoredProviderConfig>();
let memoryThreadsState: CoachThreadsState | null = null;

function openVaultDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('indexedDB unavailable'));
  }
  if (vaultDbPromise) return vaultDbPromise;
  vaultDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(COACH_VAULT_DB_NAME, COACH_VAULT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('receipts')) {
        const receipts = db.createObjectStore('receipts', { keyPath: 'id' });
        receipts.createIndex('operationId', 'operationId', { unique: true });
      }
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        vaultDbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      vaultDbPromise = null;
      reject(req.error ?? new Error('Failed to open motion-coach-vault'));
    };
  });
  return vaultDbPromise;
}

async function runVaultTx<T>(
  storeName: 'messages' | 'receipts' | 'config' | 'meta',
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T> | T,
  additionalStore?: 'meta',
): Promise<T> {
  const db = await openVaultDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(additionalStore ? [storeName, additionalStore] : storeName, mode);
    const store = tx.objectStore(storeName);
    let result!: T;
    let settled = false;
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error('Vault transaction failed'));
      }
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(tx.error ?? new Error('Vault transaction aborted'));
      }
    };
    Promise.resolve().then(() => fn(store, tx))
      .then((val) => {
        result = val;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch {
          /* ignore */
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function trimMessages(list: readonly CoachStoredMessage[]): CoachStoredMessage[] {
  const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
  const sliced = (sorted.length > MAX_STORED_MESSAGES ? sorted.slice(-MAX_STORED_MESSAGES) : sorted).map((msg) => {
    if (!msg.attachments?.length) return msg;
    // 视频仅保留轻量元数据与首帧缩略图，剥离大体积原始 base64，防止撑爆独立库
    const sanitized = msg.attachments.map((att) =>
      att.kind === 'video' ? { ...att, dataBase64: '' } : att,
    );
    return { ...msg, attachments: sanitized };
  });
  // 控制含大图片附件的消息总数，防止单库无限膨胀
  let imageCount = 0;
  for (let i = sliced.length - 1; i >= 0; i -= 1) {
    const msg = sliced[i];
    if (msg.attachments?.some((att) => att.kind !== 'video')) {
      imageCount += 1;
      if (imageCount > MAX_STORED_IMAGE_MESSAGES) {
        sliced[i] = { ...msg, attachments: undefined };
      }
    }
  }
  return sliced;
}

export async function getCoachRestoreEpoch(): Promise<number> {
  if (typeof indexedDB === 'undefined') return cachedRestoreEpoch;
  try {
    const rec = await runVaultTx<{ key: string; value: number } | undefined>('meta', 'readonly', (s) =>
      reqToPromise(s.get('restoreEpoch')),
    );
    const stored = typeof rec?.value === 'number' && Number.isFinite(rec.value) ? rec.value : 0;
    if (stored > cachedRestoreEpoch) cachedRestoreEpoch = stored;
    return cachedRestoreEpoch;
  } catch {
    return cachedRestoreEpoch;
  }
}

export async function bumpCoachRestoreEpoch(): Promise<number> {
  const current = await getCoachRestoreEpoch();
  const next = Math.max(cachedRestoreEpoch, current) + 1;
  cachedRestoreEpoch = next;
  if (typeof indexedDB !== 'undefined') {
    try {
      await runVaultTx('meta', 'readwrite', (s) =>
        reqToPromise(s.put({ key: 'restoreEpoch', value: next })),
      );
    } catch {
      /* ignore if vault cannot open in test */
    }
  }
  return next;
}

export async function saveCoachMessages(messages: readonly CoachStoredMessage[]): Promise<void> {
  const bounded = trimMessages(messages);
  memoryMessages.clear();
  for (const m of bounded) memoryMessages.set(m.id, m);
  if (typeof indexedDB === 'undefined') return;
  try {
    await runVaultTx('messages', 'readwrite', async (s) => {
      await reqToPromise(s.clear());
      for (const m of bounded) {
        await reqToPromise(s.put(m));
      }
    });
  } catch {
    /* keep memory fallback */
  }
}

export async function loadCoachMessages(): Promise<CoachStoredMessage[]> {
  if (typeof indexedDB === 'undefined') {
    return trimMessages(Array.from(memoryMessages.values()));
  }
  try {
    const all = await runVaultTx<CoachStoredMessage[]>('messages', 'readonly', (s) =>
      reqToPromise(s.getAll()),
    );
    const sorted = trimMessages(all);
    memoryMessages.clear();
    for (const m of sorted) memoryMessages.set(m.id, m);
    return sorted;
  } catch {
    return trimMessages(Array.from(memoryMessages.values()));
  }
}

export async function saveCoachReceipt(receipt: CoachOperationReceipt): Promise<void> {
  memoryReceipts.set(receipt.id, receipt);
  if (typeof indexedDB === 'undefined') return;
  try {
    await runVaultTx('receipts', 'readwrite', (s) => reqToPromise(s.put(receipt)));
  } catch {
    /* keep memory fallback */
  }
}

export async function getCoachReceipt(id: string): Promise<CoachOperationReceipt | undefined> {
  if (typeof indexedDB === 'undefined') return memoryReceipts.get(id);
  try {
    const rec = await runVaultTx<CoachOperationReceipt | undefined>('receipts', 'readonly', (s) =>
      reqToPromise(s.get(id)),
    );
    return rec ?? memoryReceipts.get(id);
  } catch {
    return memoryReceipts.get(id);
  }
}

export async function getCoachReceiptByOperationId(
  operationId: string,
): Promise<CoachOperationReceipt | undefined> {
  for (const r of memoryReceipts.values()) {
    if (r.operationId === operationId) return r;
  }
  if (typeof indexedDB === 'undefined') return undefined;
  try {
    return await runVaultTx<CoachOperationReceipt | undefined>('receipts', 'readonly', (s) =>
      reqToPromise(s.index('operationId').get(operationId)),
    );
  } catch {
    return undefined;
  }
}

export async function listCoachReceipts(): Promise<CoachOperationReceipt[]> {
  if (typeof indexedDB === 'undefined') {
    return Array.from(memoryReceipts.values()).sort((a, b) => a.createdAt - b.createdAt);
  }
  try {
    const all = await runVaultTx<CoachOperationReceipt[]>('receipts', 'readonly', (s) =>
      reqToPromise(s.getAll()),
    );
    return all.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return Array.from(memoryReceipts.values()).sort((a, b) => a.createdAt - b.createdAt);
  }
}

export async function saveCoachProviderConfig(
  cfg: Omit<CoachStoredProviderConfig, 'key' | 'updatedAt'>,
): Promise<CoachStoredProviderConfig> {
  const full: CoachStoredProviderConfig = {
    key: 'provider',
    ...cfg,
    updatedAt: Date.now(),
  };
  memoryConfig.set('provider', full);
  if (typeof indexedDB === 'undefined') return full;
  try {
    await runVaultTx('config', 'readwrite', (s) => reqToPromise(s.put(full)));
  } catch {
    /* keep memory fallback */
  }
  return full;
}

export async function loadCoachProviderConfig(): Promise<CoachStoredProviderConfig | null> {
  if (typeof indexedDB === 'undefined') return memoryConfig.get('provider') ?? null;
  try {
    const rec = await runVaultTx<CoachStoredProviderConfig | undefined>('config', 'readonly', (s) =>
      reqToPromise(s.get('provider')),
    );
    return rec ?? memoryConfig.get('provider') ?? null;
  } catch {
    return memoryConfig.get('provider') ?? null;
  }
}

export function createDefaultCoachThreadsState(): CoachThreadsState {
  return {
    activeThreadId: DEFAULT_COACH_THREAD_ID,
    threads: [
      {
        id: DEFAULT_COACH_THREAD_ID,
        title: '默认对话',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

function normalizeThreadsState(state: CoachThreadsState | null | undefined): CoachThreadsState {
  if (!state || !Array.isArray(state.threads) || !state.threads.length) {
    return createDefaultCoachThreadsState();
  }
  const seen = new Set<string>();
  const threads: CoachThreadMeta[] = [];
  for (const t of state.threads) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    threads.push({
      id: t.id,
      title: t.title?.trim() || '新对话',
      ...(t.titleSource ? { titleSource: t.titleSource } : {}),
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : Date.now(),
      updatedAt: Number.isFinite(t.updatedAt) ? t.updatedAt : Date.now(),
      ...(t.contextSummary ? { contextSummary: t.contextSummary } : {}),
      ...(typeof t.compressedCount === 'number' && t.compressedCount > 0
        ? { compressedCount: t.compressedCount }
        : {}),
    });
  }
  if (!threads.length) return createDefaultCoachThreadsState();
  const activeThreadId = seen.has(state.activeThreadId) ? state.activeThreadId : threads[0].id;
  return { activeThreadId, threads };
}

export async function loadCoachThreadsState(): Promise<CoachThreadsState> {
  if (typeof indexedDB === 'undefined') {
    return normalizeThreadsState(memoryThreadsState);
  }
  try {
    const rec = await runVaultTx<{ key: string; value: CoachThreadsState } | undefined>(
      'meta',
      'readonly',
      (s) => reqToPromise(s.get('threads')),
    );
    const normalized = normalizeThreadsState(rec?.value ?? memoryThreadsState);
    memoryThreadsState = normalized;
    return normalized;
  } catch {
    return normalizeThreadsState(memoryThreadsState);
  }
}

export async function saveCoachThreadsState(state: CoachThreadsState): Promise<CoachThreadsState> {
  const normalized = normalizeThreadsState(state);
  memoryThreadsState = normalized;
  if (typeof indexedDB === 'undefined') return normalized;
  try {
    await runVaultTx('meta', 'readwrite', (s) =>
      reqToPromise(s.put({ key: 'threads', value: normalized })),
    );
  } catch {
    /* keep memory fallback */
  }
  return normalized;
}

export async function deleteCoachThread(
  threadId: string,
  nextState: CoachThreadsState,
): Promise<void> {
  const normalized = normalizeThreadsState(nextState);
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx('messages', 'readwrite', async (store, tx) => {
      const messages = (await reqToPromise(store.getAll())) as CoachStoredMessage[];
      await Promise.all([
        ...messages
          .filter((message) => (message.threadId ?? DEFAULT_COACH_THREAD_ID) === threadId)
          .map((message) => reqToPromise(store.delete(message.id))),
        reqToPromise(tx.objectStore('meta').put({ key: 'threads', value: normalized })),
      ]);
    }, 'meta');
  }
  for (const [id, message] of memoryMessages) {
    if ((message.threadId ?? DEFAULT_COACH_THREAD_ID) === threadId) memoryMessages.delete(id);
  }
  memoryThreadsState = normalized;
}

export async function clearCoachVault(): Promise<void> {
  memoryMessages.clear();
  memoryReceipts.clear();
  memoryConfig.clear();
  memoryThreadsState = null;
  if (typeof indexedDB === 'undefined') return;
  try {
    await runVaultTx('messages', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('receipts', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('config', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('meta', 'readwrite', (s) => reqToPromise(s.clear()));
    cachedRestoreEpoch = 0;
  } catch {
    cachedRestoreEpoch = 0;
  }
}

export async function resetCoachVaultForTest(): Promise<void> {
  memoryMessages.clear();
  memoryReceipts.clear();
  memoryConfig.clear();
  memoryThreadsState = null;
  cachedRestoreEpoch = 0;
  if (vaultDbPromise) {
    try {
      const db = await vaultDbPromise;
      db.close();
    } catch {
      /* ignore */
    }
    vaultDbPromise = null;
  }
  if (typeof indexedDB !== 'undefined') {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(COACH_VAULT_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}
