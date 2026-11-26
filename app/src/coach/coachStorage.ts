/* 电子教练独立存储域（motion-coach-vault，阶段 2）。
   安全与隔离红线：
   · 聊天记录、压缩图片（<= 1MB，去 EXIF）、模型设置/API Key 与操作回执一律落在本独立库中；
   · 绝不写入 motion-training 主库（plans / sessions / settings / meta），绝不污染 BackupPayload v4；
   · restoreEpoch 随 Backup v4 恢复递增，使恢复前历史回执自动失效，防止把回执撤销打到已覆盖的历史态上。 */

import type { ExerciseTarget, ExerciseTemplate, Plan, Session, SessionSet } from '../domain/types';
import {
  COACH_OP_META_PREFIX,
  idbGet,
  readMainRestoreEpoch,
  syncMainRestoreEpoch,
} from '../db/idb';
import type { CoachMainOpLogRecord } from './coachMainTx';
import type { CoachSegmentCheckpoint } from './coachDelta';
import type { CoachMemoryStore } from './coachMemory';
import type { CoachFrozenView } from './coachTools';
import {
  canonicalizeEndpointBaseUrl,
  type CoachProviderKind,
  type CoachThinkingDepth,
} from './providerAdapter';
import { computeDeploymentId } from './providerCapabilities';

export const COACH_VAULT_DB_NAME = 'motion-coach-vault';
export const COACH_VAULT_DB_VERSION = 2;
export const DEFAULT_COACH_THREAD_ID = 'default';
const MAX_STORED_IMAGE_MESSAGES = 16;

export type CoachToolName =
  | 'adjust_active_target'
  | 'record_active_set'
  | 'configure_superset'
  | 'correct_history_session'
  | 'create_plan_from_draft'
  | 'modify_existing_plan'
  | 'sync_session_to_plan'
  | 'manage_active_exercise'
  | 'update_active_note'
  | 'finish_active_session'
  | 'manage_active_warmup'
  | 'manage_active_cardio'
  | 'update_setup_note'
  | 'manage_coach_memory';

export type CoachReceiptScope = 'session' | 'history' | 'plan' | 'session+plan' | 'memory';

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
  beforeRestSec?: number;
  afterRestSec?: number;
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

export interface CoachReceiptSessionSnapshotTouched {
  kind: 'session-snapshot';
  sessionId: string;
  beforeSession: Session;
  afterSession: Session;
}

export interface CoachReceiptSetupNoteTouched {
  kind: 'setup-note';
  sessionId?: string;
  exId?: string;
  exerciseId: string;
  beforeSessionNote?: string;
  afterSessionNote?: string;
  beforeTemplate?: ExerciseTemplate;
  afterTemplate?: ExerciseTemplate;
}

export interface CoachReceiptMemoryTouched {
  kind: 'coach-memory';
  beforeMemory: CoachMemoryStore;
  afterMemory: CoachMemoryStore;
}

export type CoachReceiptTouchedTarget =
  | CoachReceiptSetTouched
  | CoachReceiptExerciseTargetTouched
  | CoachReceiptSupersetTouched
  | CoachReceiptHistoryTouched
  | CoachReceiptPlanCreatedTouched
  | CoachReceiptPlanDayTouched
  | CoachReceiptSessionSnapshotTouched
  | CoachReceiptSetupNoteTouched
  | CoachReceiptMemoryTouched;

export interface CoachOperationReceipt {
  id: string;
  operationId: string;
  schemaVersion?: 1 | 2;
  toolName: CoachToolName;
  createdAt: number;
  scope: CoachReceiptScope;
  summary: string;
  entityType: 'session' | 'plan' | 'session+plan' | 'memory';
  entityId: string;
  planId?: string;
  beforeRevision: number;
  afterRevision: number;
  beforePlanRevision?: number;
  afterPlanRevision?: number;
  restoreEpoch: number;
  undone: boolean;
  undoneAt?: number;
  undoable?: boolean;
  undoBlockedReason?: string;
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
  citations?: Array<{ title: string; url: string }>;
  thinkingFallback?: boolean;
  compressed?: boolean;
  isDemo?: boolean;
}

export interface CoachThreadUsage {
  promptTokens: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  ttftMs?: number;
  durationMs?: number;
  tokensPerSec?: number;
  rounds?: number;
  estimated?: boolean;
  updatedAt: number;
}

export interface CoachProtocolToolCall {
  id: string;
  index: number;
  name: string;
  argumentsText: string;
  thoughtSignature?: string;
}

export interface CoachProtocolEntry {
  id: string;
  threadId: string;
  segmentId: string;
  seq: number;
  createdAt: number;
  kind: 'user' | 'assistant' | 'tool';
  /** 手动压缩承接写入时保留原消息 ID，便于追踪归属与幂等性 */
  sourceMessageId?: string;
  wireText?: string;
  attachments?: CoachStoredAttachment[];
  mediaStripped?: boolean;
  assistantText?: string;
  reasoningText?: string;
  anthropicBlocks?: Array<Record<string, unknown>>;
  geminiParts?: Array<Record<string, unknown>>;
  toolCalls?: CoachProtocolToolCall[];
  toolCallId?: string;
  toolName?: string;
  toolResultText?: string;
  toolError?: boolean;
  isControlMarker?: boolean;
  quarantinedFromReplay?: boolean;
  quarantineReason?: string;
  quarantinedAt?: number;
}

export type CoachPendingTurnStatus =
  | 'running_model'
  | 'awaiting_tools'
  | 'awaiting_followup_model'
  | 'awaiting_confirmation'
  | 'failed'
  | 'completed';

export type CoachFrozenTargetPrecondition =
  | {
      kind: 'set';
      sessionId: string;
      exId: string;
      setId: string;
      beforeExName: string;
      beforeTargetJson: string;
      beforeStatus: SessionSet['status'];
      beforeReps: number | null;
      beforeWeightKg: number | null;
      beforeToFailure?: boolean;
      beforeNote: string;
      touchedFields: Array<'status' | 'reps' | 'weightKg' | 'toFailure' | 'note'>;
    }
  | {
      kind: 'session-note';
      sessionId: string;
      beforeNote: string;
    }
  | {
      kind: 'exercise-note';
      sessionId: string;
      exId: string;
      beforeNote: string;
    }
  | {
      kind: 'exercise-target';
      sessionId: string;
      exId: string;
      beforeExName: string;
      beforeTargetJson: string;
      beforeRestSec: number;
    }
  | {
      kind: 'exercise-structure';
      sessionId: string;
      exId: string;
      beforeExerciseJson: string;
    }
  | {
      kind: 'exercise-list';
      sessionId: string;
      beforeExIds: string[];
      insertAfterExId?: string;
    }
  | {
      kind: 'superset';
      sessionId: string;
      beforeExercisesJson: string;
    }
  | {
      kind: 'warmup';
      sessionId: string;
      warmupId?: string;
      beforeWarmupJson: string;
    }
  | {
      kind: 'warmup-list';
      sessionId: string;
      beforeWarmupsJson: string;
    }
  | {
      kind: 'cardio';
      sessionId: string;
      cardioId?: string;
      beforeCardioJson: string;
    }
  | {
      kind: 'cardio-list';
      sessionId: string;
      beforeCardioJson: string;
    }
  | {
      kind: 'setup-note';
      sessionId?: string;
      exId?: string;
      exerciseId: string;
      beforeSessionSetupNote?: string;
      beforeTemplateNote?: string;
    }
  | {
      kind: 'session-strict';
      sessionId: string;
    }
  | {
      kind: 'plan';
      planId: string;
      beforeUpdatedAt: number;
    };

export interface CoachPendingPlannedToolCall {
  toolCallId: string;
  index: number;
  operationId: string;
  name: string;
  argumentsText: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
  expectedRevision?: number;
  expectedPlanRevision?: number;
  modelExpectedRevision?: number;
  modelExpectedPlanRevision?: number;
  expectedEpoch?: number;
  frozenPrecondition?: CoachFrozenTargetPrecondition;
  priorBatchOpIds?: string[];
  strictSessionRevision?: boolean;
  toolEntrySeq?: number;
  afterRevision?: number;
  status: 'pending' | 'committed' | 'failed';
  receiptId?: string;
  outcomeJson?: string;
  errorText?: string;
}

export interface CoachPendingTurn {
  turnId: string;
  threadId: string;
  segmentId: string;
  status: CoachPendingTurnStatus;
  round: number;
  userMessageId: string;
  userPromptText: string;
  createdAt: number;
  updatedAt: number;
  restoreEpoch: number;
  providerKind: CoachProviderKind;
  presetId?: string;
  baseUrl?: string;
  deploymentId: string;
  model: string;
  thinkingDepth?: CoachThinkingDepth;
  webSearchUsed?: boolean;
  frozenView?: CoachFrozenView;
  assistantEntrySeq?: number;
  assistantEntrySnapshot?: Omit<CoachProtocolEntry, 'id' | 'threadId' | 'segmentId' | 'seq'>;
  plannedToolCalls?: CoachPendingPlannedToolCall[];
  pendingDraftPlan?: CoachPlanDraft;
  lastError?: string;
}

export type CoachBillingMetricSource = 'measured' | 'estimated' | 'unknown';

export interface CoachCostBounds {
  min: number;
  max: number;
}

export interface CoachCurrencySubtotal {
  requests: number;
  loggedSetsCount: number;
  measuredUsageRequests: number;
  measuredCacheDetailRequests: number;
  unknownCacheInputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  totalCost: number | null;
  costBounds: CoachCostBounds | null;
  costPerLoggedSet: number | null;
}

export type CoachBillingRequestSource = 'model' | 'external_search';

export interface CoachBillingRecord {
  id: string;
  threadId: string;
  segmentId: string;
  turnId?: string;
  round: number;
  purpose:
    | 'coach_turn'
    | 'compact_summary'
    | 'title_gen'
    | 'vision_extract'
    | 'capability_probe'
    | 'web_search';
  /** 请求来源区分：仅模型请求计入模型缓存/模型费用，独立外部检索单独列账 */
  requestSource?: CoachBillingRequestSource;
  /** 独立外部检索服务来源（如 builtin / tavily / bocha / brave） */
  searchProvider?: CoachWebSearchProvider;
  createdAt: number;
  providerKind: CoachProviderKind;
  deploymentId: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  uncachedInputTokens: number;
  unknownCacheInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  source: CoachBillingMetricSource;
  cacheDetailSource?: 'measured' | 'unknown';
  providerReportedCostUsd?: number;
  computedCostUsd: number | null;
  costBounds?: CoachCostBounds | null;
  currency: 'USD' | 'CNY' | 'unknown';
  cacheHitRatio: number | null;
  prefixDigest?: string;
  systemPromptDigest?: string;
  toolsDigest?: string;
  prefixByteLength?: number;
  exactPrefixMatchedPrevRound?: boolean;
  durationMs?: number;
  ttftMs?: number;
  rawUsage?: Record<string, unknown>;
  operationIdsCompleted?: string[];
  loggedSetsCount?: number;
}

export type CoachSegmentReason =
  | 'initial'
  | 'new_session'
  | 'compaction'
  | 'manual_reset'
  | 'restore_epoch'
  | 'restore_backup'
  | 'protocol_or_deployment_switch'
  | 'thinking_replay_boundary';

export interface CoachSegmentState {
  segmentId: string;
  startedAt: number;
  reason: CoachSegmentReason;
  restoreEpoch?: number;
  deploymentId: string;
  providerKind: CoachProviderKind;
  baseUrl?: string;
  model: string;
  thinkingModeKey: string;
  baselineSnapshotJson: string;
  baselineSnapshotHash: string;
  lastSyncedSessionId?: string;
  lastSyncedSessionRevision?: number;
  lastSyncedPlanId?: string;
  lastSyncedPlanUpdatedAt?: number;
  lastSyncedPlanRevisions?: Record<string, number>;
  lastSyncedHistoryKey?: string;
  lastSyncedMemoryHash?: string;
  lastSyncedSetupNotesHash?: string;
  lastSyncedFocusJson?: string;
  lastSyncedCheckpoint?: CoachSegmentCheckpoint;
  nextSeq: number;
  containsAssistantWithoutReasoning?: boolean;
  /** 本段由哪一次手动压缩快照承接开启（防止同摘要同字节重放或重复消费） */
  manualCompactionId?: string;
}

export interface CoachThreadBillingTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  unknownCacheInputTokens?: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalCostUsd: number | null;
  costBounds?: CoachCostBounds | null;
  currency: 'USD' | 'CNY' | 'mixed' | 'unknown';
  unknownUsageRequests: number;
  unknownCacheDetailRequests?: number;
  loggedSetsCount: number;
  missPerLoggedSet?: number | null;
  costPerLoggedSet?: number | null;
  subtotalsByCurrency?: Partial<Record<'USD' | 'CNY', CoachCurrencySubtotal>>;
  /** 独立外部检索调用次数（不计入模型 requests / 模型缓存 / 模型费用） */
  externalSearchRequests?: number;
  /** 口径版本号（v2 起明确隔离模型请求与独立外部检索；缺失时触发按 ledger 重算刷新） */
  summarySchemaVersion?: number;
}

export interface CoachManualCompactionKeptMessage {
  id: string;
  role: 'user' | 'assistant';
  createdAt: number;
  text: string;
}

export interface CoachManualCompactionRecord {
  compactionId: string;
  summary: string;
  summaryHash: string;
  keptMessages: CoachManualCompactionKeptMessage[];
  createdAt: number;
  consumedBySegmentId?: string;
}

export interface CoachThreadMeta {
  id: string;
  title: string;
  titleSource?: 'placeholder' | 'auto' | 'manual';
  createdAt: number;
  updatedAt: number;
  contextSummary?: string;
  compressedCount?: number;
  lastUsage?: CoachThreadUsage;
  activeSegmentId?: string;
  segments?: Record<string, CoachSegmentState>;
  billingTotals?: CoachThreadBillingTotals;
  manualCompaction?: CoachManualCompactionRecord;
}

export interface CoachThreadsState {
  activeThreadId: string;
  threads: CoachThreadMeta[];
}

export type CoachWebSearchProvider = 'builtin' | 'tavily' | 'bocha' | 'brave' | 'off' | 'none';

/** 将旧版或未配置的 `'none'` 平滑归一化为 `'builtin'`（免 Key 内置联网），保留显式 `'off'` 与第三方搜索。 */
export function normalizeWebSearchProvider(
  raw?: CoachWebSearchProvider,
): Exclude<CoachWebSearchProvider, 'none'> {
  if (!raw || raw === 'none') return 'builtin';
  return raw;
}

export interface CoachStoredProviderConfig {
  key: 'provider';
  kind: CoachProviderKind;
  presetId?: string;
  deploymentId?: string;
  baseUrl: string;
  model: string;
  models?: string[];
  thinkingDepth?: CoachThinkingDepth;
  thinkingByModel?: Record<string, CoachThinkingDepth>;
  capabilitiesByModel?: Record<string, CoachThinkingDepth[]>;
  contextWindowByModel?: Record<string, number>;
  detectedCapabilities?: Record<string, Record<string, unknown>>;
  visionFallbackMode?: 'one_shot' | 'native';
  webSearchProvider?: CoachWebSearchProvider;
  webSearchApiKey?: string;
  apiKey: string;
  updatedAt: number;
}

type VaultStoreName =
  | 'messages'
  | 'receipts'
  | 'config'
  | 'meta'
  | 'protocolEntries'
  | 'pendingTurns'
  | 'billingLedger';

let vaultDbPromise: Promise<IDBDatabase> | null = null;
let cachedRestoreEpoch = 0;

// IDB 不可用时的内存回退仓（如 SSR / 极简环境）
const memoryMessages = new Map<string, CoachStoredMessage>();
const memoryReceipts = new Map<string, CoachOperationReceipt>();
const memoryConfig = new Map<string, CoachStoredProviderConfig>();
const memoryMeta = new Map<string, unknown>();
const memoryProtocolEntries = new Map<string, CoachProtocolEntry>();
const memoryPendingTurns = new Map<string, CoachPendingTurn>();
const memoryBillingLedger = new Map<string, CoachBillingRecord>();
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
      if (!db.objectStoreNames.contains('protocolEntries')) {
        const entries = db.createObjectStore('protocolEntries', { keyPath: 'id' });
        entries.createIndex('threadId', 'threadId', { unique: false });
        entries.createIndex('threadSegment', ['threadId', 'segmentId'], { unique: false });
      }
      if (!db.objectStoreNames.contains('pendingTurns')) {
        const turns = db.createObjectStore('pendingTurns', { keyPath: 'turnId' });
        turns.createIndex('threadId', 'threadId', { unique: false });
      }
      if (!db.objectStoreNames.contains('billingLedger')) {
        const billing = db.createObjectStore('billingLedger', { keyPath: 'id' });
        billing.createIndex('threadId', 'threadId', { unique: false });
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
  storeName: VaultStoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore, tx: IDBTransaction) => Promise<T> | T,
  additionalStores?: VaultStoreName | VaultStoreName[],
): Promise<T> {
  const db = await openVaultDb();
  const extra = Array.isArray(additionalStores)
    ? additionalStores
    : additionalStores
      ? [additionalStores]
      : [];
  const stores = Array.from(new Set<VaultStoreName>([storeName, ...extra]));
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
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

function sanitizeStoredMessageForVault(msg: CoachStoredMessage): CoachStoredMessage {
  if (!msg.attachments?.length) return msg;
  // 视频仅保留轻量元数据与首帧缩略图，剥离大体积原始 base64，防止撑爆独立库
  const sanitized = msg.attachments.map((att) =>
    att.kind === 'video' ? { ...att, dataBase64: '' } : att,
  );
  return { ...msg, attachments: sanitized };
}

function hasStoredImageAttachment(msg: CoachStoredMessage): boolean {
  return Boolean(msg.attachments?.some((att) => att.kind !== 'video'));
}

function trimMessages(list: readonly CoachStoredMessage[]): CoachStoredMessage[] {
  const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt).map(sanitizeStoredMessageForVault);
  // 控制含大图片附件的消息总数，防止单库无限膨胀；不再对文本历史做 200/240 条硬裁剪
  let imageCount = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const msg = sorted[i];
    if (hasStoredImageAttachment(msg)) {
      imageCount += 1;
      if (imageCount > MAX_STORED_IMAGE_MESSAGES) {
        sorted[i] = { ...msg, attachments: undefined };
      }
    }
  }
  return sorted;
}

/**
 * 仅在新增/更新消息包含图片时，按既有 MAX_STORED_IMAGE_MESSAGES=16 预算计算需要写入的条目：
 * · 仅重写本次传入条目以及因超出预算被裁剪掉图片附件的更早消息；
 * · 绝不 clear 整库，保留所有旧消息文本与其余会话条目。
 */
function computeImageBudgetUpserts(
  existingAll: readonly CoachStoredMessage[],
  incoming: readonly CoachStoredMessage[],
): CoachStoredMessage[] {
  if (!incoming.length) return [];
  if (!incoming.some(hasStoredImageAttachment)) {
    return [...incoming];
  }
  const existingById = new Map(existingAll.map((m) => [m.id, m]));
  const merged = new Map(existingById);
  for (const m of incoming) {
    merged.set(m.id, m);
  }
  const bounded = trimMessages(Array.from(merged.values()));
  const incomingIds = new Set(incoming.map((m) => m.id));
  const upserts: CoachStoredMessage[] = [];
  for (const m of bounded) {
    if (incomingIds.has(m.id)) {
      upserts.push(m);
      continue;
    }
    const prev = existingById.get(m.id);
    if (prev && prev.attachments !== undefined && m.attachments === undefined) {
      upserts.push(m);
    }
  }
  return upserts;
}

export async function getCoachVaultRestoreEpoch(): Promise<number> {
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

export async function setCoachVaultRestoreEpoch(epoch: number): Promise<number> {
  const normalized = Number.isFinite(epoch) && epoch >= 0 ? Math.trunc(epoch) : 0;
  cachedRestoreEpoch = Math.max(cachedRestoreEpoch, normalized);
  memoryMeta.set('restoreEpoch', normalized);
  if (typeof indexedDB !== 'undefined') {
    try {
      await runVaultTx('meta', 'readwrite', (s) =>
        reqToPromise(s.put({ key: 'restoreEpoch', value: normalized })),
      );
    } catch {
      /* ignore if vault cannot open in isolated recovery tests */
    }
  }
  return normalized;
}

export async function getCoachRestoreEpoch(): Promise<number> {
  if (typeof indexedDB === 'undefined') return cachedRestoreEpoch;
  const mainEpoch = await readMainRestoreEpoch();
  if (mainEpoch !== null) {
    cachedRestoreEpoch = mainEpoch;
    return mainEpoch;
  }
  const vaultEpoch = await getCoachVaultRestoreEpoch();
  if (vaultEpoch > 0) {
    cachedRestoreEpoch = vaultEpoch;
  }
  return vaultEpoch;
}

export async function bumpCoachRestoreEpoch(): Promise<number> {
  const current = await getCoachRestoreEpoch();
  const next = Math.max(cachedRestoreEpoch, current) + 1;
  cachedRestoreEpoch = next;
  await syncMainRestoreEpoch(next);
  await setCoachVaultRestoreEpoch(next);
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

/**
 * 局部增量写入或更新指定消息，绝不清全库或连带覆盖其他会话/已有历史。
 */
export async function upsertCoachMessages(messages: readonly CoachStoredMessage[]): Promise<void> {
  if (!messages.length) return;
  const sanitized = messages.map(sanitizeStoredMessageForVault);
  const needsImageBudget = sanitized.some(hasStoredImageAttachment);
  if (typeof indexedDB !== 'undefined') {
    const committedUpserts = await runVaultTx<CoachStoredMessage[]>('messages', 'readwrite', async (s) => {
      let toPut = sanitized;
      if (needsImageBudget) {
        const existingAll = (await reqToPromise(s.getAll())) as CoachStoredMessage[];
        toPut = computeImageBudgetUpserts(existingAll, sanitized);
      }
      for (const m of toPut) {
        await reqToPromise(s.put(m));
      }
      return toPut;
    });
    for (const m of committedUpserts) {
      memoryMessages.set(m.id, m);
    }
    return;
  }
  const toStore = needsImageBudget
    ? computeImageBudgetUpserts(Array.from(memoryMessages.values()), sanitized)
    : sanitized;
  for (const m of toStore) {
    memoryMessages.set(m.id, m);
  }
}

export async function deleteCoachMessagesByIds(ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx('messages', 'readwrite', async (s) => {
      for (const id of ids) {
        await reqToPromise(s.delete(id));
      }
    });
  }
  for (const id of ids) memoryMessages.delete(id);
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

export async function saveCoachReceiptStrict(receipt: CoachOperationReceipt): Promise<void> {
  const stored: CoachOperationReceipt = { ...receipt };
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx('receipts', 'readwrite', (s) => reqToPromise(s.put(stored)));
  }
  memoryReceipts.set(stored.id, stored);
}

export async function saveCoachReceipt(receipt: CoachOperationReceipt): Promise<void> {
  const stored: CoachOperationReceipt = { ...receipt };
  memoryReceipts.set(stored.id, stored);
  if (typeof indexedDB === 'undefined') return;
  try {
    await runVaultTx('receipts', 'readwrite', (s) => reqToPromise(s.put(stored)));
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
    const fromVault = await runVaultTx<CoachOperationReceipt | undefined>('receipts', 'readonly', (s) =>
      reqToPromise(s.index('operationId').get(operationId)),
    );
    if (fromVault) return fromVault;
  } catch {
    /* fallback to main DB authoritative opLog */
  }
  try {
    const mainRow = await idbGet<{ key: string; value?: CoachMainOpLogRecord }>(
      'meta',
      `${COACH_OP_META_PREFIX}${operationId}`,
    );
    const op = mainRow?.value;
    if (op && op.operationId === operationId) {
      const rebuilt: CoachOperationReceipt = {
        id: op.receiptId,
        operationId: op.operationId,
        schemaVersion: 2,
        toolName: op.toolName,
        createdAt: op.createdAt,
        scope: op.scope,
        summary: op.summary,
        entityType: op.entityType,
        entityId: op.entityId,
        ...(op.planId ? { planId: op.planId } : {}),
        beforeRevision: op.beforeRevision,
        afterRevision: op.afterRevision,
        ...(op.beforePlanRevision !== undefined ? { beforePlanRevision: op.beforePlanRevision } : {}),
        ...(op.afterPlanRevision !== undefined ? { afterPlanRevision: op.afterPlanRevision } : {}),
        restoreEpoch: op.restoreEpoch,
        undone: op.undone,
        ...(op.undoneAt !== undefined ? { undoneAt: op.undoneAt } : {}),
        undoable: op.undoable,
        ...(op.timerStarted ? { timerStarted: true } : {}),
        touchedTargets: op.touchedTargets,
      };
      return rebuilt;
    }
  } catch {
    /* ignore */
  }
  return undefined;
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

const ROUTE_PROFILE_PREFIX = 'route:';
const MAX_SAVED_ROUTE_PROFILES = 12;

function buildProviderRouteProfileKey(cfg: {
  kind: CoachProviderKind;
  baseUrl: string;
  model: string;
}): string {
  const canonicalUrl = canonicalizeEndpointBaseUrl(cfg.kind, cfg.baseUrl);
  return `${ROUTE_PROFILE_PREFIX}${cfg.kind}|${canonicalUrl}|${cfg.model.trim()}`;
}

export async function saveCoachProviderConfig(
  cfg: Omit<CoachStoredProviderConfig, 'key' | 'updatedAt'>,
): Promise<CoachStoredProviderConfig> {
  const now = Date.now();
  const full: CoachStoredProviderConfig = {
    key: 'provider',
    ...cfg,
    updatedAt: now,
  };
  const routeKey = buildProviderRouteProfileKey(cfg);
  const hasValidKey = Boolean(cfg.apiKey.trim() && cfg.baseUrl.trim() && cfg.model.trim());
  memoryConfig.set('provider', full);
  if (hasValidKey) {
    memoryConfig.set(routeKey, { ...full, key: routeKey as unknown as 'provider' });
  } else {
    memoryConfig.delete(routeKey);
  }
  if (typeof indexedDB === 'undefined') return full;
  try {
    await runVaultTx('config', 'readwrite', async (s) => {
      await reqToPromise(s.put(full));
      if (hasValidKey) {
        await reqToPromise(s.put({ ...full, key: routeKey }));
        const all = (await reqToPromise(s.getAll())) as Array<CoachStoredProviderConfig & { key: string }>;
        const profiles = all
          .filter((r) => typeof r?.key === 'string' && r.key.startsWith(ROUTE_PROFILE_PREFIX))
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        for (const stale of profiles.slice(MAX_SAVED_ROUTE_PROFILES)) {
          memoryConfig.delete(stale.key);
          await reqToPromise(s.delete(stale.key));
        }
      } else {
        await reqToPromise(s.delete(routeKey));
      }
    });
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

export async function findSavedProviderConfigForRoute(target: {
  kind: CoachProviderKind;
  baseUrl?: string;
  deploymentId?: string;
  model: string;
}): Promise<CoachStoredProviderConfig | null> {
  const expectedModel = target.model.trim();
  const expectedBaseUrl = target.baseUrl
    ? canonicalizeEndpointBaseUrl(target.kind, target.baseUrl)
    : '';
  const matchesTarget = (cand: CoachStoredProviderConfig | null | undefined): cand is CoachStoredProviderConfig => {
    if (!cand || !cand.apiKey.trim() || !cand.baseUrl.trim() || !cand.model.trim()) return false;
    if (cand.kind !== target.kind) return false;
    if (cand.model.trim() !== expectedModel) return false;
    const candDep = computeDeploymentId(cand);
    if (target.deploymentId && candDep !== target.deploymentId) return false;
    if (expectedBaseUrl) {
      return canonicalizeEndpointBaseUrl(cand.kind, cand.baseUrl) === expectedBaseUrl;
    }
    return true;
  };

  let candidates: CoachStoredProviderConfig[] = Array.from(memoryConfig.values());
  if (typeof indexedDB !== 'undefined') {
    try {
      const all = await runVaultTx<CoachStoredProviderConfig[]>('config', 'readonly', (s) =>
        reqToPromise(s.getAll()),
      );
      if (all.length) candidates = all;
    } catch {
      /* fallback to memoryConfig */
    }
  }
  const matched = candidates
    .filter(matchesTarget)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  if (!matched.length) return null;
  return { ...matched[0], key: 'provider' };
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
      ...(t.lastUsage && typeof t.lastUsage.promptTokens === 'number'
        ? { lastUsage: t.lastUsage }
        : {}),
      ...(t.activeSegmentId ? { activeSegmentId: t.activeSegmentId } : {}),
      ...(t.segments ? { segments: t.segments } : {}),
      ...(t.billingTotals ? { billingTotals: t.billingTotals } : {}),
      ...(t.manualCompaction && t.manualCompaction.compactionId
        ? { manualCompaction: t.manualCompaction }
        : {}),
    });
  }
  if (!threads.length) return createDefaultCoachThreadsState();
  const activeThreadId = seen.has(state.activeThreadId) ? state.activeThreadId : threads[0].id;
  return { activeThreadId, threads };
}

let threadsStateWriteQueue: Promise<CoachThreadsState> | null = null;

function enqueueThreadsMutation(fn: () => Promise<CoachThreadsState>): Promise<CoachThreadsState> {
  const prev = threadsStateWriteQueue ?? Promise.resolve(createDefaultCoachThreadsState());
  const next = prev.catch(() => createDefaultCoachThreadsState()).then(fn);
  threadsStateWriteQueue = next;
  return next;
}

async function readLatestThreadsStateUnlocked(): Promise<CoachThreadsState> {
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

async function writeThreadsStateUnlocked(state: CoachThreadsState): Promise<CoachThreadsState> {
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

export async function loadCoachThreadsState(): Promise<CoachThreadsState> {
  if (threadsStateWriteQueue) {
    await threadsStateWriteQueue.catch(() => undefined);
  }
  return readLatestThreadsStateUnlocked();
}

export async function saveCoachThreadsState(state: CoachThreadsState): Promise<CoachThreadsState> {
  return enqueueThreadsMutation(() => writeThreadsStateUnlocked(state));
}

/** 串行读取最新 IDB 线程状态并原子应用补丁，避免多个并发写入互相覆盖 */
export async function patchCoachThreadsState(
  updater: (latest: CoachThreadsState) => CoachThreadsState,
): Promise<CoachThreadsState> {
  return enqueueThreadsMutation(async () => {
    const latest = await readLatestThreadsStateUnlocked();
    const updated = updater(latest);
    return writeThreadsStateUnlocked(updated);
  });
}

export type CoachThreadUiOwnedPatch = Partial<
  Pick<
    CoachThreadMeta,
    'title' | 'titleSource' | 'updatedAt' | 'lastUsage' | 'contextSummary' | 'compressedCount'
  >
>;

/**
 * UI 仅可原子更新自身拥有的字段（标题/更新时间/lastUsage/摘要标记），
 * 严禁覆盖由引擎独占的 activeSegmentId / segments / billingTotals。
 */
export async function patchCoachThreadUiFields(
  threadId: string,
  updater:
    | CoachThreadUiOwnedPatch
    | ((current: CoachThreadMeta) => CoachThreadUiOwnedPatch | null | undefined),
): Promise<CoachThreadsState> {
  return patchCoachThreadsState((latest) => {
    let changed = false;
    const threads = latest.threads.map((t) => {
      if (t.id !== threadId) return t;
      const rawPatch = typeof updater === 'function' ? updater(t) : updater;
      if (!rawPatch) return t;
      changed = true;
      return {
        ...t,
        ...(rawPatch.title !== undefined ? { title: rawPatch.title } : {}),
        ...(rawPatch.titleSource !== undefined ? { titleSource: rawPatch.titleSource } : {}),
        ...(rawPatch.updatedAt !== undefined ? { updatedAt: rawPatch.updatedAt } : {}),
        ...('lastUsage' in rawPatch ? { lastUsage: rawPatch.lastUsage } : {}),
        ...('contextSummary' in rawPatch ? { contextSummary: rawPatch.contextSummary } : {}),
        ...('compressedCount' in rawPatch ? { compressedCount: rawPatch.compressedCount } : {}),
      };
    });
    return changed ? { ...latest, threads } : latest;
  });
}

/**
 * UI 修改会话列表布局（新建/切换/删除）时保留最新持久化态中各线程的引擎字段（activeSegmentId / segments / billingTotals）。
 */
export async function saveCoachThreadsUiLayout(nextState: CoachThreadsState): Promise<CoachThreadsState> {
  return patchCoachThreadsState((latest) => {
    const latestById = new Map(latest.threads.map((t) => [t.id, t]));
    const mergedThreads = nextState.threads.map((uiThread) => {
      const persisted = latestById.get(uiThread.id);
      if (!persisted) return uiThread;
      return {
        ...persisted,
        title: uiThread.title,
        ...(uiThread.titleSource ? { titleSource: uiThread.titleSource } : {}),
        updatedAt: Math.max(persisted.updatedAt, uiThread.updatedAt),
        ...(uiThread.lastUsage ? { lastUsage: uiThread.lastUsage } : {}),
        ...(uiThread.contextSummary !== undefined ? { contextSummary: uiThread.contextSummary } : {}),
        ...(uiThread.compressedCount !== undefined ? { compressedCount: uiThread.compressedCount } : {}),
      };
    });
    return {
      activeThreadId: nextState.activeThreadId,
      threads: mergedThreads,
    };
  });
}

/**
 * 仅切换持久化 activeThreadId，不整包覆盖或吞掉并发创建的其他会话及引擎字段。
 */
export async function switchActiveCoachThreadInVault(threadId: string): Promise<CoachThreadsState> {
  return patchCoachThreadsState((latest) => {
    if (!latest.threads.some((t) => t.id === threadId)) return latest;
    return { ...latest, activeThreadId: threadId };
  });
}

/**
 * 在单一串行锁与 IDB readwrite 事务内创建正式线程与首条用户消息（零重复 ID，不清全库）：
 * 用于空白草稿首条有效文本或仅附件发送落库；失败则抛错且不留空线程。
 */
function isSameFirstMessageRequest(
  existing: CoachStoredMessage,
  candidate: CoachStoredMessage,
  expectedThreadId: string,
): boolean {
  return (
    (existing.threadId ?? DEFAULT_COACH_THREAD_ID) === expectedThreadId &&
    existing.role === candidate.role &&
    existing.text === candidate.text
  );
}

export async function createCoachThreadWithFirstMessageInVault(params: {
  thread: CoachThreadMeta;
  firstMessage: CoachStoredMessage;
}): Promise<CoachThreadsState> {
  const cleanMsg = sanitizeStoredMessageForVault({
    ...params.firstMessage,
    threadId: params.thread.id,
  });
  const needsImageBudget = hasStoredImageAttachment(cleanMsg);
  return enqueueThreadsMutation(async () => {
    if (typeof indexedDB === 'undefined') {
      const existingMem = memoryMessages.get(cleanMsg.id);
      if (existingMem && !isSameFirstMessageRequest(existingMem, cleanMsg, params.thread.id)) {
        throw new Error('首条消息 ID 与既有会话冲突');
      }
      const latest = normalizeThreadsState(memoryThreadsState);
      const exists = latest.threads.some((t) => t.id === params.thread.id);
      const nextState = normalizeThreadsState({
        activeThreadId: params.thread.id,
        threads: exists ? latest.threads : [params.thread, ...latest.threads],
      });
      memoryThreadsState = nextState;
      if (!existingMem) {
        const upserts = needsImageBudget
          ? computeImageBudgetUpserts(Array.from(memoryMessages.values()), [cleanMsg])
          : [cleanMsg];
        for (const m of upserts) {
          memoryMessages.set(m.id, m);
        }
      }
      return nextState;
    }

    const committed = await runVaultTx<{
      nextState: CoachThreadsState;
      upsertedMessages: CoachStoredMessage[];
    }>(
      'meta',
      'readwrite',
      async (metaStore, tx) => {
        const msgStore = tx.objectStore('messages');
        const threadsRec = (await reqToPromise(metaStore.get('threads'))) as
          | { key: string; value: CoachThreadsState }
          | undefined;
        const latest = normalizeThreadsState(threadsRec?.value ?? memoryThreadsState);
        const exists = latest.threads.some((t) => t.id === params.thread.id);
        const nextState = normalizeThreadsState({
          activeThreadId: params.thread.id,
          threads: exists ? latest.threads : [params.thread, ...latest.threads],
        });
        const existingMsg = (await reqToPromise(msgStore.get(cleanMsg.id))) as
          | CoachStoredMessage
          | undefined;
        if (existingMsg && !isSameFirstMessageRequest(existingMsg, cleanMsg, params.thread.id)) {
          throw new Error('首条消息 ID 与既有会话冲突');
        }
        await reqToPromise(metaStore.put({ key: 'threads', value: nextState }));
        let upsertedMessages: CoachStoredMessage[] = [];
        if (!existingMsg) {
          if (needsImageBudget) {
            const existingAll = (await reqToPromise(msgStore.getAll())) as CoachStoredMessage[];
            upsertedMessages = computeImageBudgetUpserts(existingAll, [cleanMsg]);
          } else {
            upsertedMessages = [cleanMsg];
          }
          for (const m of upsertedMessages) {
            await reqToPromise(msgStore.put(m));
          }
        }
        return { nextState, upsertedMessages };
      },
      ['messages'],
    );
    memoryThreadsState = committed.nextState;
    for (const m of committed.upsertedMessages) {
      memoryMessages.set(m.id, m);
    }
    return committed.nextState;
  });
}

/**
 * 在同一串行锁与单个 IDB readwrite 事务内原子校验状态并提交手动压缩结果：
 * · 全部读取与 isStale 校验（threads / 本线程 messages / 本线程 pendingTurns）均在同一 readwrite 事务内完成，消除 readonly->readwrite 竞态；
 * · 绝不清全库 messages，也不合并覆盖其他线程消息，只局部更新本线程本次确定的 compressedIds（及本线程尚缺的快照条目）。
 */
export async function commitManualCompactionInVault(params: {
  threadId: string;
  compressedIds: readonly string[];
  compressedCount: number;
  summary: string;
  manualCompaction: CoachManualCompactionRecord;
  snapshotMessages?: readonly CoachStoredMessage[];
  isStale?: (
    latestThreads: CoachThreadsState,
    latestThreadMessages: CoachStoredMessage[],
    latestThreadPendings: CoachPendingTurn[],
  ) => boolean;
}): Promise<{ committed: boolean; staleIgnored?: boolean; threadsState: CoachThreadsState }> {
  let committed = false;
  let staleIgnored = false;
  const targetThreadId = params.threadId || DEFAULT_COACH_THREAD_ID;
  const compressedSet = new Set(params.compressedIds);
  const belongsToTarget = (m: CoachStoredMessage) =>
    (m.threadId ?? DEFAULT_COACH_THREAD_ID) === targetThreadId;

  const threadsState = await enqueueThreadsMutation(async () => {
    if (typeof indexedDB === 'undefined') {
      const latest = normalizeThreadsState(memoryThreadsState);
      const targetThread = latest.threads.find((t) => t.id === targetThreadId);
      const latestThreadMsgs = trimMessages(
        Array.from(memoryMessages.values()).filter(belongsToTarget),
      );
      const latestThreadPendings = Array.from(memoryPendingTurns.values()).filter(
        (p) => p.threadId === targetThreadId,
      );
      if (!targetThread || params.isStale?.(latest, latestThreadMsgs, latestThreadPendings)) {
        staleIgnored = true;
        return latest;
      }
      const existingById = new Map(latestThreadMsgs.map((m) => [m.id, m]));
      for (const sm of params.snapshotMessages ?? []) {
        if (!belongsToTarget(sm)) continue;
        const cur = existingById.get(sm.id);
        if (cur) {
          if (compressedSet.has(sm.id) && !cur.compressed) {
            memoryMessages.set(sm.id, { ...cur, compressed: true });
          }
        } else {
          memoryMessages.set(sm.id, compressedSet.has(sm.id) ? { ...sm, compressed: true } : sm);
        }
      }
      for (const cid of compressedSet) {
        const cur = existingById.get(cid);
        if (cur && !cur.compressed) {
          memoryMessages.set(cid, { ...cur, compressed: true });
        }
      }
      const nextThreadsState = normalizeThreadsState({
        ...latest,
        threads: latest.threads.map((t) =>
          t.id === targetThreadId
            ? {
                ...t,
                contextSummary: params.summary,
                compressedCount: (t.compressedCount ?? 0) + params.compressedCount,
                lastUsage: undefined,
                manualCompaction: params.manualCompaction,
                updatedAt: Math.max(t.updatedAt, params.manualCompaction.createdAt),
              }
            : t,
        ),
      });
      memoryThreadsState = nextThreadsState;
      committed = true;
      return nextThreadsState;
    }

    return runVaultTx<CoachThreadsState>(
      'meta',
      'readwrite',
      async (metaStore, tx) => {
        const msgStore = tx.objectStore('messages');
        const pendingStore = tx.objectStore('pendingTurns');
        const threadsRec = (await reqToPromise(metaStore.get('threads'))) as
          | { key: string; value: CoachThreadsState }
          | undefined;
        const latest = normalizeThreadsState(threadsRec?.value ?? memoryThreadsState);
        const targetThread = latest.threads.find((t) => t.id === targetThreadId);

        const allMsgs = (await reqToPromise(msgStore.getAll())) as CoachStoredMessage[];
        const latestThreadMsgs = trimMessages(allMsgs.filter(belongsToTarget));
        const latestThreadPendings = (await reqToPromise(
          pendingStore.index('threadId').getAll(targetThreadId),
        )) as CoachPendingTurn[];

        if (!targetThread || params.isStale?.(latest, latestThreadMsgs, latestThreadPendings)) {
          staleIgnored = true;
          memoryThreadsState = latest;
          return latest;
        }

        const existingById = new Map(latestThreadMsgs.map((m) => [m.id, m]));
        const putsForThread: CoachStoredMessage[] = [];
        const seenPutIds = new Set<string>();
        for (const cid of compressedSet) {
          const cur = existingById.get(cid);
          if (cur) {
            if (!cur.compressed) {
              putsForThread.push({ ...cur, compressed: true });
              seenPutIds.add(cid);
            }
          } else {
            const seed = params.snapshotMessages?.find(
              (sm) => sm.id === cid && belongsToTarget(sm),
            );
            if (seed) {
              putsForThread.push({ ...seed, compressed: true });
              seenPutIds.add(cid);
            }
          }
        }
        for (const sm of params.snapshotMessages ?? []) {
          if (!belongsToTarget(sm) || seenPutIds.has(sm.id)) continue;
          if (!existingById.has(sm.id)) {
            putsForThread.push(compressedSet.has(sm.id) ? { ...sm, compressed: true } : sm);
            seenPutIds.add(sm.id);
          }
        }

        const nextThreadsState = normalizeThreadsState({
          ...latest,
          threads: latest.threads.map((t) =>
            t.id === targetThreadId
              ? {
                  ...t,
                  contextSummary: params.summary,
                  compressedCount: (t.compressedCount ?? 0) + params.compressedCount,
                  lastUsage: undefined,
                  manualCompaction: params.manualCompaction,
                  updatedAt: Math.max(t.updatedAt, params.manualCompaction.createdAt),
                }
              : t,
          ),
        });

        await reqToPromise(metaStore.put({ key: 'threads', value: nextThreadsState }));
        for (const msg of putsForThread) {
          await reqToPromise(msgStore.put(msg));
          memoryMessages.set(msg.id, msg);
        }
        memoryThreadsState = nextThreadsState;
        committed = true;
        return nextThreadsState;
      },
      ['messages', 'pendingTurns'],
    );
  });

  return { committed, ...(staleIgnored ? { staleIgnored: true } : {}), threadsState };
}

export async function deleteCoachThread(
  threadId: string,
  nextState: CoachThreadsState,
): Promise<void> {
  const normalized = normalizeThreadsState(nextState);
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx(
      'messages',
      'readwrite',
      async (store, tx) => {
        const [messages, entries, turns, bills] = await Promise.all([
          reqToPromise(store.getAll()) as Promise<CoachStoredMessage[]>,
          reqToPromise(tx.objectStore('protocolEntries').getAll()) as Promise<CoachProtocolEntry[]>,
          reqToPromise(tx.objectStore('pendingTurns').getAll()) as Promise<CoachPendingTurn[]>,
          reqToPromise(tx.objectStore('billingLedger').getAll()) as Promise<CoachBillingRecord[]>,
        ]);
        const entryStore = tx.objectStore('protocolEntries');
        const turnStore = tx.objectStore('pendingTurns');
        const billingStore = tx.objectStore('billingLedger');
        await Promise.all([
          ...messages
            .filter((message) => (message.threadId ?? DEFAULT_COACH_THREAD_ID) === threadId)
            .map((message) => reqToPromise(store.delete(message.id))),
          ...entries
            .filter((entry) => entry.threadId === threadId)
            .map((entry) => reqToPromise(entryStore.delete(entry.id))),
          ...turns
            .filter((turn) => turn.threadId === threadId)
            .map((turn) => reqToPromise(turnStore.delete(turn.turnId))),
          ...bills
            .filter((bill) => bill.threadId === threadId)
            .map((bill) => reqToPromise(billingStore.delete(bill.id))),
          reqToPromise(tx.objectStore('meta').put({ key: 'threads', value: normalized })),
        ]);
      },
      ['protocolEntries', 'pendingTurns', 'billingLedger', 'meta'],
    );
  }
  for (const [id, message] of memoryMessages) {
    if ((message.threadId ?? DEFAULT_COACH_THREAD_ID) === threadId) memoryMessages.delete(id);
  }
  for (const [id, entry] of memoryProtocolEntries) {
    if (entry.threadId === threadId) memoryProtocolEntries.delete(id);
  }
  for (const [id, turn] of memoryPendingTurns) {
    if (turn.threadId === threadId) memoryPendingTurns.delete(id);
  }
  for (const [id, bill] of memoryBillingLedger) {
    if (bill.threadId === threadId) memoryBillingLedger.delete(id);
  }
  memoryThreadsState = normalized;
}

export async function savePendingTurnStrict(turn: CoachPendingTurn): Promise<CoachPendingTurn> {
  const next: CoachPendingTurn = { ...turn, updatedAt: Date.now() };
  memoryPendingTurns.set(next.turnId, next);
  if (typeof indexedDB === 'undefined') return next;
  await runVaultTx('pendingTurns', 'readwrite', (s) => reqToPromise(s.put(next)));
  return next;
}

export async function getPendingTurn(turnId: string): Promise<CoachPendingTurn | undefined> {
  if (typeof indexedDB === 'undefined') return memoryPendingTurns.get(turnId);
  try {
    const rec = await runVaultTx<CoachPendingTurn | undefined>('pendingTurns', 'readonly', (s) =>
      reqToPromise(s.get(turnId)),
    );
    if (rec) memoryPendingTurns.set(rec.turnId, rec);
    return rec ?? memoryPendingTurns.get(turnId);
  } catch {
    return memoryPendingTurns.get(turnId);
  }
}

export async function listPendingTurns(threadId?: string): Promise<CoachPendingTurn[]> {
  let list: CoachPendingTurn[];
  if (typeof indexedDB === 'undefined') {
    list = Array.from(memoryPendingTurns.values());
  } else {
    try {
      list = await runVaultTx<CoachPendingTurn[]>('pendingTurns', 'readonly', (s) =>
        reqToPromise(s.getAll()),
      );
      memoryPendingTurns.clear();
      for (const item of list) memoryPendingTurns.set(item.turnId, item);
    } catch {
      list = Array.from(memoryPendingTurns.values());
    }
  }
  return list
    .filter((t) => !threadId || t.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function deletePendingTurnStrict(turnId: string): Promise<void> {
  memoryPendingTurns.delete(turnId);
  if (typeof indexedDB === 'undefined') return;
  await runVaultTx('pendingTurns', 'readwrite', (s) => reqToPromise(s.delete(turnId)));
}

export async function findVaultReceiptByOperationIdStrict(
  operationId: string,
): Promise<CoachOperationReceipt | undefined> {
  if (typeof indexedDB === 'undefined') {
    for (const r of memoryReceipts.values()) {
      if (r.operationId === operationId) return r;
    }
    return undefined;
  }
  const fromVault = await runVaultTx<CoachOperationReceipt | undefined>('receipts', 'readonly', (s) =>
    reqToPromise(s.index('operationId').get(operationId)),
  );
  if (fromVault) {
    memoryReceipts.set(fromVault.id, fromVault);
  }
  return fromVault;
}

function mergeSegmentUpdateIntoThreads(
  latest: CoachThreadsState,
  update: {
    threadId: string;
    segment: CoachSegmentState;
    summaryOverride?: string;
  },
): CoachThreadsState {
  if (!latest.threads.some((t) => t.id === update.threadId)) return latest;
  return {
    ...latest,
    threads: latest.threads.map((t) =>
      t.id === update.threadId
        ? {
            ...t,
            activeSegmentId: update.segment.segmentId,
            ...(update.summaryOverride !== undefined ? { contextSummary: update.summaryOverride } : {}),
            segments: {
              ...(t.segments ?? {}),
              [update.segment.segmentId]: update.segment,
            },
            updatedAt: Date.now(),
          }
        : t,
    ),
  };
}

/**
 * 在第一项工具副作用前，将可恢复完整意图（pendingTurn）、原 assistant 协议条目
 * 与段推进（nextSeq）在单笔 motion-coach-vault 事务中原子落盘。
 */
export async function commitToolBatchIntentAtomic(params: {
  pendingTurn: CoachPendingTurn;
  entries: readonly CoachProtocolEntry[];
  segmentUpdate?: {
    threadId: string;
    segment: CoachSegmentState;
    summaryOverride?: string;
  };
}): Promise<CoachPendingTurn> {
  const nextPending: CoachPendingTurn = { ...params.pendingTurn, updatedAt: Date.now() };
  const commitMemory = (nextThreads?: CoachThreadsState) => {
    for (const entry of params.entries) {
      memoryProtocolEntries.set(entry.id, entry);
    }
    memoryPendingTurns.set(nextPending.turnId, nextPending);
    if (nextThreads) {
      memoryThreadsState = nextThreads;
    }
  };

  if (typeof indexedDB === 'undefined') {
    const nextThreads = params.segmentUpdate
      ? mergeSegmentUpdateIntoThreads(normalizeThreadsState(memoryThreadsState), params.segmentUpdate)
      : undefined;
    commitMemory(nextThreads);
    return nextPending;
  }

  if (params.segmentUpdate) {
    const segUpd = params.segmentUpdate;
    await enqueueThreadsMutation(async () => {
      let updatedThreads = normalizeThreadsState(memoryThreadsState);
      await runVaultTx(
        'pendingTurns',
        'readwrite',
        async (pendingStore, tx) => {
          const metaStore = tx.objectStore('meta');
          const entryStore = tx.objectStore('protocolEntries');
          const rec = (await reqToPromise(metaStore.get('threads'))) as
            | { key: string; value: CoachThreadsState }
            | undefined;
          const latest = normalizeThreadsState(rec?.value ?? memoryThreadsState);
          updatedThreads = normalizeThreadsState(mergeSegmentUpdateIntoThreads(latest, segUpd));
          await reqToPromise(metaStore.put({ key: 'threads', value: updatedThreads }));
          for (const entry of params.entries) {
            await reqToPromise(entryStore.put(entry));
          }
          await reqToPromise(pendingStore.put(nextPending));
        },
        ['protocolEntries', 'meta'],
      );
      commitMemory(updatedThreads);
      return updatedThreads;
    });
    return nextPending;
  }

  await runVaultTx(
    'pendingTurns',
    'readwrite',
    async (pendingStore, tx) => {
      const entryStore = tx.objectStore('protocolEntries');
      for (const entry of params.entries) {
        await reqToPromise(entryStore.put(entry));
      }
      await reqToPromise(pendingStore.put(nextPending));
    },
    ['protocolEntries'],
  );
  commitMemory();
  return nextPending;
}

/**
 * 单步工具执行完成后，将工具结果协议条目与 pendingTurn 进度原子写入同一事务。
 */
export async function commitToolStepOutcomeAtomic(params: {
  entries: readonly CoachProtocolEntry[];
  pendingTurn: CoachPendingTurn;
}): Promise<CoachPendingTurn> {
  const nextPending: CoachPendingTurn = { ...params.pendingTurn, updatedAt: Date.now() };
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx(
      'pendingTurns',
      'readwrite',
      async (pendingStore, tx) => {
        const entryStore = tx.objectStore('protocolEntries');
        for (const entry of params.entries) {
          await reqToPromise(entryStore.put(entry));
        }
        await reqToPromise(pendingStore.put(nextPending));
      },
      ['protocolEntries'],
    );
  }
  for (const entry of params.entries) {
    memoryProtocolEntries.set(entry.id, entry);
  }
  memoryPendingTurns.set(nextPending.turnId, nextPending);
  return nextPending;
}

/**
 * 放弃收尾原子提交：在同一 motion-coach-vault 事务内完成
 * 协议条目补齐/隔离标记、缺失回执镜像、段 nextSeq 更新与 pendingTurn 清理。
 * 任一步失败整体回滚，保留可重试现场。
 */
export async function commitAbandonReconciliationAtomic(params: {
  upsertEntries?: readonly CoachProtocolEntry[];
  upsertReceipts?: readonly CoachOperationReceipt[];
  deletePendingTurnIds?: readonly string[];
  segmentUpdate?: {
    threadId: string;
    segmentId: string;
    nextSeq: number;
  };
}): Promise<void> {
  const entries = params.upsertEntries ?? [];
  const receipts = params.upsertReceipts ?? [];
  const deleteIds = params.deletePendingTurnIds ?? [];

  const applyMemory = (nextThreads?: CoachThreadsState) => {
    for (const e of entries) memoryProtocolEntries.set(e.id, e);
    for (const r of receipts) memoryReceipts.set(r.id, r);
    for (const id of deleteIds) memoryPendingTurns.delete(id);
    if (nextThreads) memoryThreadsState = nextThreads;
  };

  const applySegmentNextSeq = (latest: CoachThreadsState): CoachThreadsState => {
    if (!params.segmentUpdate) return latest;
    const { threadId, segmentId, nextSeq } = params.segmentUpdate;
    return {
      ...latest,
      threads: latest.threads.map((t) => {
        if (t.id !== threadId || !t.segments?.[segmentId]) return t;
        const curSeg = t.segments[segmentId];
        return {
          ...t,
          segments: {
            ...t.segments,
            [segmentId]: {
              ...curSeg,
              nextSeq: Math.max(curSeg.nextSeq ?? 1, nextSeq),
            },
          },
          updatedAt: Date.now(),
        };
      }),
    };
  };

  if (typeof indexedDB === 'undefined') {
    const nextThreads = params.segmentUpdate
      ? applySegmentNextSeq(normalizeThreadsState(memoryThreadsState))
      : undefined;
    applyMemory(nextThreads);
    return;
  }

  const runCoreTx = async (withThreadsMeta: boolean): Promise<CoachThreadsState | undefined> => {
    let updatedThreads: CoachThreadsState | undefined;
    const extraStores: VaultStoreName[] = ['protocolEntries', 'receipts'];
    if (withThreadsMeta) extraStores.push('meta');
    await runVaultTx(
      'pendingTurns',
      'readwrite',
      async (pendingStore, tx) => {
        const entryStore = tx.objectStore('protocolEntries');
        const receiptStore = tx.objectStore('receipts');
        if (withThreadsMeta && params.segmentUpdate) {
          const metaStore = tx.objectStore('meta');
          const rec = (await reqToPromise(metaStore.get('threads'))) as
            | { key: string; value: CoachThreadsState }
            | undefined;
          const latest = normalizeThreadsState(rec?.value ?? memoryThreadsState);
          updatedThreads = normalizeThreadsState(applySegmentNextSeq(latest));
          await reqToPromise(metaStore.put({ key: 'threads', value: updatedThreads }));
        }
        for (const entry of entries) {
          await reqToPromise(entryStore.put(entry));
        }
        for (const r of receipts) {
          const existingByOp = (await reqToPromise(
            receiptStore.index('operationId').get(r.operationId),
          )) as CoachOperationReceipt | undefined;
          if (!existingByOp || existingByOp.id === r.id) {
            await reqToPromise(receiptStore.put({ ...r }));
          }
        }
        for (const tid of deleteIds) {
          await reqToPromise(pendingStore.delete(tid));
        }
      },
      extraStores,
    );
    return updatedThreads;
  };

  if (params.segmentUpdate) {
    await enqueueThreadsMutation(async () => {
      const nextThreads = (await runCoreTx(true)) ?? normalizeThreadsState(memoryThreadsState);
      applyMemory(nextThreads);
      return nextThreads;
    });
    return;
  }

  await runCoreTx(false);
  applyMemory();
}

export async function appendProtocolEntriesStrict(
  entries: readonly CoachProtocolEntry[],
): Promise<void> {
  if (!entries.length) return;
  for (const entry of entries) memoryProtocolEntries.set(entry.id, entry);
  if (typeof indexedDB === 'undefined') return;
  await runVaultTx('protocolEntries', 'readwrite', async (s) => {
    for (const entry of entries) {
      await reqToPromise(s.put(entry));
    }
  });
}

export async function replaceProtocolEntriesForThread(
  threadId: string,
  entries: readonly CoachProtocolEntry[],
): Promise<void> {
  for (const [id, item] of memoryProtocolEntries) {
    if (item.threadId === threadId) memoryProtocolEntries.delete(id);
  }
  for (const entry of entries) memoryProtocolEntries.set(entry.id, entry);
  if (typeof indexedDB === 'undefined') return;
  await runVaultTx('protocolEntries', 'readwrite', async (s) => {
    const all = (await reqToPromise(s.getAll())) as CoachProtocolEntry[];
    for (const existing of all) {
      if (existing.threadId === threadId) {
        await reqToPromise(s.delete(existing.id));
      }
    }
    for (const entry of entries) {
      await reqToPromise(s.put(entry));
    }
  });
}

export async function listProtocolEntries(
  threadId: string,
  segmentId?: string,
): Promise<CoachProtocolEntry[]> {
  let all: CoachProtocolEntry[];
  if (typeof indexedDB === 'undefined') {
    all = Array.from(memoryProtocolEntries.values());
  } else {
    try {
      all = await runVaultTx<CoachProtocolEntry[]>('protocolEntries', 'readonly', (s) =>
        reqToPromise(s.index('threadId').getAll(threadId)),
      );
    } catch {
      all = Array.from(memoryProtocolEntries.values());
    }
  }
  return all
    .filter((e) => e.threadId === threadId && (!segmentId || e.segmentId === segmentId))
    .sort((a, b) => a.seq - b.seq);
}

export async function saveBillingRecordStrict(record: CoachBillingRecord): Promise<CoachBillingRecord> {
  memoryBillingLedger.set(record.id, record);
  if (typeof indexedDB === 'undefined') return record;
  await runVaultTx('billingLedger', 'readwrite', (s) => reqToPromise(s.put(record)));
  return record;
}

export async function listBillingRecords(threadId?: string): Promise<CoachBillingRecord[]> {
  let list: CoachBillingRecord[];
  if (typeof indexedDB === 'undefined') {
    list = Array.from(memoryBillingLedger.values());
  } else {
    try {
      list = await runVaultTx<CoachBillingRecord[]>('billingLedger', 'readonly', (s) =>
        reqToPromise(s.getAll()),
      );
      memoryBillingLedger.clear();
      for (const item of list) memoryBillingLedger.set(item.id, item);
    } catch {
      list = Array.from(memoryBillingLedger.values());
    }
  }
  return list
    .filter((b) => !threadId || b.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 在单个 motion-coach-vault readwrite 事务中原子写入长期记忆与回执 */
export async function runCoachMemoryVaultTx<T>(params: {
  memoryKey: string;
  nextMemory: CoachMemoryStore;
  receipt: CoachOperationReceipt;
  value?: T;
}): Promise<T | undefined> {
  const storedReceipt: CoachOperationReceipt = {
    schemaVersion: params.receipt.schemaVersion ?? 2,
    ...params.receipt,
  };
  if (typeof indexedDB !== 'undefined') {
    await runVaultTx(
      'meta',
      'readwrite',
      async (metaStore, tx) => {
        await reqToPromise(metaStore.put({ key: params.memoryKey, value: params.nextMemory }));
        await reqToPromise(tx.objectStore('receipts').put(storedReceipt));
      },
      ['receipts'],
    );
  }
  memoryMeta.set(params.memoryKey, params.nextMemory);
  memoryReceipts.set(storedReceipt.id, storedReceipt);
  return params.value;
}

export async function loadCoachVaultMeta<T>(key: string): Promise<T | null> {
  if (typeof indexedDB === 'undefined') {
    return (memoryMeta.get(key) as T | undefined) ?? null;
  }
  try {
    const rec = await runVaultTx<{ key: string; value: T } | undefined>(
      'meta',
      'readonly',
      (s) => reqToPromise(s.get(key)),
    );
    if (rec && rec.value !== undefined) {
      memoryMeta.set(key, rec.value);
      return rec.value;
    }
    return (memoryMeta.get(key) as T | undefined) ?? null;
  } catch {
    return (memoryMeta.get(key) as T | undefined) ?? null;
  }
}

export async function saveCoachVaultMeta<T>(key: string, value: T): Promise<T> {
  memoryMeta.set(key, value);
  if (typeof indexedDB === 'undefined') return value;
  try {
    await runVaultTx('meta', 'readwrite', (s) => reqToPromise(s.put({ key, value })));
  } catch {
    /* keep memory fallback */
  }
  return value;
}

export async function clearCoachVault(): Promise<void> {
  memoryMessages.clear();
  memoryReceipts.clear();
  memoryConfig.clear();
  memoryMeta.clear();
  memoryProtocolEntries.clear();
  memoryPendingTurns.clear();
  memoryBillingLedger.clear();
  memoryThreadsState = null;
  if (typeof indexedDB === 'undefined') return;
  try {
    await runVaultTx('messages', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('receipts', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('config', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('meta', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('protocolEntries', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('pendingTurns', 'readwrite', (s) => reqToPromise(s.clear()));
    await runVaultTx('billingLedger', 'readwrite', (s) => reqToPromise(s.clear()));
    cachedRestoreEpoch = 0;
  } catch {
    cachedRestoreEpoch = 0;
  }
}

export async function resetCoachVaultForTest(): Promise<void> {
  memoryMessages.clear();
  memoryReceipts.clear();
  memoryConfig.clear();
  memoryMeta.clear();
  memoryProtocolEntries.clear();
  memoryPendingTurns.clear();
  memoryBillingLedger.clear();
  memoryThreadsState = null;
  threadsStateWriteQueue = null;
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
