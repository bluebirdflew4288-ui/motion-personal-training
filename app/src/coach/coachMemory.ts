/* Hermes 式透明持久记忆与跨会话检索（隔离存储于 motion-coach-vault）。
   设计原则：
   1. 透明可审查：按分类保存用户画像、训练偏好、伤病避让、器械环境与经验教训；
   2. 严格隔离：只写入 motion-coach-vault 的 meta store，绝不进入主库与 BackupPayload v4；
   3. 有界预算：单条与总条数设硬上限，系统提示词按置顶+近期优先裁剪在 maxChars 内；
   4. 零成本检索：无需外置向量库或额外模型调用，本地切词检索记忆与跨会话历史片段。 */

import {
  DEFAULT_COACH_THREAD_ID,
  loadCoachMessages,
  loadCoachThreadsState,
  loadCoachVaultMeta,
  saveCoachVaultMeta,
} from './coachStorage';

export const COACH_MEMORY_META_KEY = 'coach_memory_v1';
export const MAX_MEMORY_ITEMS = 60;
export const MAX_MEMORY_TITLE_LEN = 40;
export const MAX_MEMORY_CONTENT_LEN = 240;

export type CoachMemoryCategory =
  | 'profile'
  | 'preference'
  | 'injury'
  | 'equipment'
  | 'habit'
  | 'lesson';

export const COACH_MEMORY_CATEGORY_LABEL: Record<CoachMemoryCategory, string> = {
  profile: '身体情况',
  preference: '训练偏好',
  injury: '伤病避让',
  equipment: '器械环境',
  habit: '表达习惯',
  lesson: '经验教训',
};

export interface CoachMemoryItem {
  id: string;
  category: CoachMemoryCategory;
  title: string;
  content: string;
  source: 'coach' | 'user';
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CoachMemoryStore {
  version: 1;
  updatedAt: number;
  items: CoachMemoryItem[];
}

export function createEmptyCoachMemory(): CoachMemoryStore {
  return { version: 1, updatedAt: 0, items: [] };
}

function makeMemoryId(): string {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeTitleKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

function clampMemoryText(text: string, maxLen: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > maxLen ? `${clean.slice(0, maxLen - 1)}…` : clean;
}

export function normalizeCoachMemoryStore(raw: unknown): CoachMemoryStore {
  if (!raw || typeof raw !== 'object') return createEmptyCoachMemory();
  const obj = raw as Partial<CoachMemoryStore>;
  if (!Array.isArray(obj.items)) return createEmptyCoachMemory();
  const validCategories = new Set<CoachMemoryCategory>([
    'profile',
    'preference',
    'injury',
    'equipment',
    'habit',
    'lesson',
  ]);
  const seen = new Set<string>();
  const items: CoachMemoryItem[] = [];
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') continue;
    const id = typeof it.id === 'string' && it.id.trim() ? it.id.trim() : makeMemoryId();
    if (seen.has(id)) continue;
    seen.add(id);
    const category: CoachMemoryCategory = validCategories.has(it.category) ? it.category : 'preference';
    const title = clampMemoryText(typeof it.title === 'string' ? it.title : '', MAX_MEMORY_TITLE_LEN);
    const content = clampMemoryText(
      typeof it.content === 'string' ? it.content : '',
      MAX_MEMORY_CONTENT_LEN,
    );
    if (!title || !content) continue;
    items.push({
      id,
      category,
      title,
      content,
      source: it.source === 'user' ? 'user' : 'coach',
      ...(it.pinned ? { pinned: true } : {}),
      createdAt: typeof it.createdAt === 'number' && Number.isFinite(it.createdAt) ? it.createdAt : Date.now(),
      updatedAt: typeof it.updatedAt === 'number' && Number.isFinite(it.updatedAt) ? it.updatedAt : Date.now(),
    });
  }
  return {
    version: 1,
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : 0,
    items: items.slice(0, MAX_MEMORY_ITEMS),
  };
}

export async function loadCoachMemory(): Promise<CoachMemoryStore> {
  const raw = await loadCoachVaultMeta<CoachMemoryStore>(COACH_MEMORY_META_KEY);
  return normalizeCoachMemoryStore(raw);
}

export async function saveCoachMemory(store: CoachMemoryStore): Promise<CoachMemoryStore> {
  const normalized = normalizeCoachMemoryStore(store);
  const next: CoachMemoryStore = {
    ...normalized,
    updatedAt: Math.max(Date.now(), normalized.updatedAt),
  };
  await saveCoachVaultMeta(COACH_MEMORY_META_KEY, next);
  return next;
}

export function upsertCoachMemoryItem(
  store: CoachMemoryStore,
  input: {
    id?: string;
    category: CoachMemoryCategory;
    title: string;
    content: string;
    source?: 'coach' | 'user';
    pinned?: boolean;
  },
  now = Date.now(),
): { store: CoachMemoryStore; item: CoachMemoryItem; created: boolean } {
  const title = clampMemoryText(input.title, MAX_MEMORY_TITLE_LEN);
  const content = clampMemoryText(input.content, MAX_MEMORY_CONTENT_LEN);
  if (!title || !content) {
    throw new Error('记忆标题和内容都不能为空');
  }
  const titleKey = normalizeTitleKey(title);
  const existingIdx = store.items.findIndex(
    (it) =>
      (input.id && it.id === input.id) ||
      (it.category === input.category && normalizeTitleKey(it.title) === titleKey),
  );

  if (existingIdx >= 0) {
    const prev = store.items[existingIdx];
    const updated: CoachMemoryItem = {
      ...prev,
      category: input.category,
      title,
      content,
      source: input.source ?? prev.source,
      ...(input.pinned !== undefined ? { pinned: input.pinned } : prev.pinned ? { pinned: true } : {}),
      updatedAt: now,
    };
    const nextItems = store.items.map((it, idx) => (idx === existingIdx ? updated : it));
    return {
      store: { version: 1, updatedAt: now, items: nextItems },
      item: updated,
      created: false,
    };
  }

  const createdItem: CoachMemoryItem = {
    id: input.id?.trim() || makeMemoryId(),
    category: input.category,
    title,
    content,
    source: input.source ?? 'coach',
    ...(input.pinned ? { pinned: true } : {}),
    createdAt: now,
    updatedAt: now,
  };

  const nextItems = [...store.items, createdItem];
  if (nextItems.length > MAX_MEMORY_ITEMS) {
    // 淘汰最早更新的未置顶项，优先保住置顶与新记忆
    const removable = nextItems
      .map((it, idx) => ({ it, idx }))
      .filter((x) => x.it.id !== createdItem.id && !x.it.pinned)
      .sort((a, b) => a.it.updatedAt - b.it.updatedAt);
    const victimIdx = removable[0]?.idx ?? 0;
    nextItems.splice(victimIdx, 1);
  }

  return {
    store: { version: 1, updatedAt: now, items: nextItems },
    item: createdItem,
    created: true,
  };
}

export function removeCoachMemoryItem(
  store: CoachMemoryStore,
  selector: { id?: string; title?: string },
  now = Date.now(),
): { store: CoachMemoryStore; removed: CoachMemoryItem | null } {
  const idTarget = selector.id?.trim();
  const titleTarget = selector.title ? normalizeTitleKey(selector.title) : '';
  const idx = store.items.findIndex(
    (it) =>
      (idTarget && it.id === idTarget) ||
      (!idTarget && titleTarget && normalizeTitleKey(it.title) === titleTarget),
  );
  if (idx < 0) {
    return { store, removed: null };
  }
  const removed = store.items[idx];
  const nextItems = store.items.filter((_, i) => i !== idx);
  return {
    store: { version: 1, updatedAt: now, items: nextItems },
    removed,
  };
}

export function formatCoachMemoryForPrompt(store: CoachMemoryStore, maxChars = 1200): string {
  if (!store.items.length) return '';
  const sorted = [...store.items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const groups = new Map<CoachMemoryCategory, string[]>();
  let totalChars = 0;
  for (const item of sorted) {
    const line = `- [${item.id}] ${item.title}：${item.content}${item.pinned ? '（置顶）' : ''}`;
    if (totalChars + line.length + 18 > maxChars && groups.size > 0) break;
    const list = groups.get(item.category) ?? [];
    list.push(line);
    groups.set(item.category, list);
    totalChars += line.length + 18;
  }

  const sections: string[] = [];
  for (const [cat, lines] of groups) {
    sections.push(`【${COACH_MEMORY_CATEGORY_LABEL[cat]}】\n${lines.join('\n')}`);
  }
  const combined = sections.join('\n');
  return combined.length > maxChars ? `${combined.slice(0, maxChars - 1)}…` : combined;
}

function tokenizeQuery(query: string): string[] {
  const clean = query.trim().toLowerCase();
  if (!clean) return [];
  const rawParts = clean.split(/[\s,，。、；;：:！？!?]+/).filter(Boolean);
  const tokens = new Set<string>();
  for (const part of rawParts) {
    tokens.add(part);
    // 对长中文词拆出双字片段提升召回
    if (/[\u4e00-\u9fff]/.test(part) && part.length > 2) {
      for (let i = 0; i <= part.length - 2; i += 1) {
        tokens.add(part.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens);
}

function scoreText(text: string, tokens: string[], rawQuery: string): number {
  const lower = text.toLowerCase();
  let score = lower.includes(rawQuery) ? 10 : 0;
  for (const tok of tokens) {
    if (lower.includes(tok)) {
      score += tok.length >= 3 ? 3 : 1;
    }
  }
  return score;
}

export interface CoachHistorySearchResult {
  memories: Array<{
    id: string;
    category: CoachMemoryCategory;
    title: string;
    content: string;
    pinned: boolean;
    score: number;
  }>;
  messages: Array<{
    threadId: string;
    threadTitle: string;
    role: 'user' | 'assistant';
    createdAt: number;
    snippet: string;
    score: number;
  }>;
}

export async function searchCoachMemoryAndThreads(
  query: string,
  opts?: { limit?: number; excludeThreadId?: string },
): Promise<CoachHistorySearchResult> {
  const limit = Math.max(1, Math.min(20, opts?.limit ?? 8));
  const rawQuery = query.trim().toLowerCase();
  const tokens = tokenizeQuery(query);
  const [memoryStore, allMessages, threadsState] = await Promise.all([
    loadCoachMemory(),
    loadCoachMessages(),
    loadCoachThreadsState(),
  ]);

  if (!rawQuery) {
    return {
      memories: memoryStore.items.slice(0, limit).map((it) => ({
        id: it.id,
        category: it.category,
        title: it.title,
        content: it.content,
        pinned: Boolean(it.pinned),
        score: it.pinned ? 2 : 1,
      })),
      messages: [],
    };
  }

  const memories = memoryStore.items
    .map((it) => ({
      id: it.id,
      category: it.category,
      title: it.title,
      content: it.content,
      pinned: Boolean(it.pinned),
      score: scoreText(`${it.title} ${it.content}`, tokens, rawQuery) + (it.pinned ? 1 : 0),
    }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const threadTitleMap = new Map(threadsState.threads.map((t) => [t.id, t.title]));
  const messages = allMessages
    .filter((m) => !m.isDemo && m.text.trim())
    .filter((m) => !opts?.excludeThreadId || (m.threadId ?? DEFAULT_COACH_THREAD_ID) !== opts.excludeThreadId)
    .map((m) => {
      const tid = m.threadId ?? DEFAULT_COACH_THREAD_ID;
      const clean = m.text.replace(/\s+/g, ' ').trim();
      const score = scoreText(clean, tokens, rawQuery);
      return {
        threadId: tid,
        threadTitle: threadTitleMap.get(tid) ?? '历史对话',
        role: m.role,
        createdAt: m.createdAt,
        snippet: clean.length > 160 ? `${clean.slice(0, 160)}…` : clean,
        score,
      };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt)
    .slice(0, limit);

  return { memories, messages };
}
