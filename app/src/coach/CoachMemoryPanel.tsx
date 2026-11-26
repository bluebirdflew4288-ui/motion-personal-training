/* Hermes 式电子教练持久记忆检查与编辑面板（透明展示、分类筛选、增删改与置顶）。 */

import React, { useMemo, useState } from 'react';
import {
  COACH_MEMORY_CATEGORY_LABEL,
  MAX_MEMORY_CONTENT_LEN,
  MAX_MEMORY_TITLE_LEN,
  removeCoachMemoryItem,
  saveCoachMemory,
  upsertCoachMemoryItem,
  type CoachMemoryCategory,
  type CoachMemoryItem,
  type CoachMemoryStore,
} from './coachMemory';
import { purgeDeletedMemoryFromCoachHistory } from './coachAgent';

export interface CoachMemoryPanelProps {
  open: boolean;
  store: CoachMemoryStore;
  onClose: () => void;
  onChange: (nextStore: CoachMemoryStore) => void;
  onToast?: (msg: string) => void;
}

const CATEGORIES = Object.keys(COACH_MEMORY_CATEGORY_LABEL) as CoachMemoryCategory[];

export const CoachMemoryPanel: React.FC<CoachMemoryPanelProps> = ({
  open,
  store,
  onClose,
  onChange,
  onToast,
}) => {
  const [filterCat, setFilterCat] = useState<'all' | CoachMemoryCategory>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [category, setCategory] = useState<CoachMemoryCategory>('preference');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);

  const visibleItems = useMemo(() => {
    const list =
      filterCat === 'all'
        ? store.items
        : store.items.filter((it) => it.category === filterCat);
    return [...list].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }, [filterCat, store.items]);

  if (!open) return null;

  const openAddForm = () => {
    setEditingId(null);
    setCategory(filterCat === 'all' ? 'preference' : filterCat);
    setTitle('');
    setContent('');
    setPinned(false);
    setFormOpen(true);
  };

  const openEditForm = (item: CoachMemoryItem) => {
    setEditingId(item.id);
    setCategory(item.category);
    setTitle(item.title);
    setContent(item.content);
    setPinned(Boolean(item.pinned));
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true);
    try {
      const updated = upsertCoachMemoryItem(store, {
        ...(editingId ? { id: editingId } : {}),
        category,
        title: title.trim(),
        content: content.trim(),
        source: 'user',
        pinned,
      });
      const persisted = await saveCoachMemory(updated.store);
      onChange(persisted);
      setFormOpen(false);
      setEditingId(null);
      setTitle('');
      setContent('');
      onToast?.(updated.created ? '已新增长期记忆' : '已更新长期记忆');
    } catch (err) {
      onToast?.(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const handleTogglePin = async (item: CoachMemoryItem) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = upsertCoachMemoryItem(store, {
        id: item.id,
        category: item.category,
        title: item.title,
        content: item.content,
        source: item.source,
        pinned: !item.pinned,
      });
      const persisted = await saveCoachMemory(updated.store);
      onChange(persisted);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const removed = removeCoachMemoryItem(store, { id });
      const persisted = await saveCoachMemory(removed.store);
      await purgeDeletedMemoryFromCoachHistory({
        memoryId: removed.removed?.id,
        memoryTitle: removed.removed?.title,
        memoryContent: removed.removed?.content,
      });
      onChange(persisted);
      onToast?.('已删除该条记忆');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="coach-memory-panel" data-testid="coach-memory-panel">
      <div className="coach-memory-head">
        <div>
          <strong>教练长期记忆</strong>
          <span className="coach-memory-sub">{store.items.length}/60 条 · 跨会话自动参考</span>
        </div>
        <div className="coach-memory-head-actions">
          <button
            type="button"
            className="coach-btn coach-btn-primary"
            data-testid="coach-memory-add-btn"
            onClick={openAddForm}
          >
            + 记一条
          </button>
          <button
            type="button"
            className="coach-btn coach-btn-ghost"
            data-testid="coach-memory-close-btn"
            onClick={onClose}
          >
            收起
          </button>
        </div>
      </div>

      <div className="coach-memory-tabs">
        <button
          type="button"
          className={`coach-memory-tab${filterCat === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilterCat('all')}
        >
          全部 ({store.items.length})
        </button>
        {CATEGORIES.map((cat) => {
          const count = store.items.filter((it) => it.category === cat).length;
          return (
            <button
              key={cat}
              type="button"
              className={`coach-memory-tab${filterCat === cat ? ' is-active' : ''}`}
              onClick={() => setFilterCat(cat)}
            >
              {COACH_MEMORY_CATEGORY_LABEL[cat]}
              {count > 0 ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>

      {formOpen && (
        <form className="coach-memory-form" onSubmit={handleSave}>
          <div className="coach-memory-form-row">
            <select
              data-testid="coach-memory-category-select"
              value={category}
              onChange={(e) => setCategory(e.target.value as CoachMemoryCategory)}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {COACH_MEMORY_CATEGORY_LABEL[cat]}
                </option>
              ))}
            </select>
            <input
              type="text"
              data-testid="coach-memory-title-input"
              maxLength={MAX_MEMORY_TITLE_LEN}
              placeholder="简短标题，如：左肩有夹挤史"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <textarea
            data-testid="coach-memory-content-input"
            maxLength={MAX_MEMORY_CONTENT_LEN}
            rows={2}
            placeholder="具体内容：教练会在对话和调计划时自动避让或复用"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="coach-memory-form-foot">
            <label className="coach-memory-pin-check">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
              />
              <span>置顶优先带入提示词</span>
            </label>
            <div className="coach-memory-form-btns">
              <button
                type="button"
                className="coach-btn coach-btn-ghost"
                onClick={() => setFormOpen(false)}
              >
                取消
              </button>
              <button
                type="submit"
                className="coach-btn coach-btn-primary"
                data-testid="coach-memory-save-btn"
                disabled={busy || !title.trim() || !content.trim()}
              >
                保存
              </button>
            </div>
          </div>
        </form>
      )}

      <div className="coach-memory-list">
        {visibleItems.length === 0 ? (
          <div className="coach-memory-empty">
            暂无长期记忆。教练在对话里了解到你的伤病、偏好或器械环境后会主动记住，你也可以点右上「+ 记一条」手动补充。
          </div>
        ) : (
          visibleItems.map((item) => (
            <div
              key={item.id}
              className={`coach-memory-item${item.pinned ? ' is-pinned' : ''}`}
              data-testid={`coach-memory-item-${item.id}`}
            >
              <div className="coach-memory-item-head">
                <span className="coach-memory-cat-badge">
                  {COACH_MEMORY_CATEGORY_LABEL[item.category]}
                </span>
                <strong>{item.title}</strong>
                {item.pinned && <span className="coach-memory-pin-badge">置顶</span>}
                <span className="coach-memory-src">{item.source === 'user' ? '手动' : '教练'}</span>
              </div>
              <p className="coach-memory-item-body">{item.content}</p>
              <div className="coach-memory-item-actions">
                <button
                  type="button"
                  data-testid={`coach-memory-pin-${item.id}`}
                  onClick={() => void handleTogglePin(item)}
                >
                  {item.pinned ? '取消置顶' : '置顶'}
                </button>
                <button
                  type="button"
                  data-testid={`coach-memory-edit-${item.id}`}
                  onClick={() => openEditForm(item)}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="is-danger"
                  data-testid={`coach-memory-delete-${item.id}`}
                  onClick={() => void handleDelete(item.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
