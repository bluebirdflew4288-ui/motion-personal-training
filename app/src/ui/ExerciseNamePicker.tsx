/* 动作名称选择器（G2A）。
   只负责「动作名称 / 真实身份 exerciseId / en」三件事：
   · 从内置库 + 已记忆配置中搜索/选择；
   · 直接输入自定义名称；
   · **绝不**把被选动作的模板配置套进当前编辑草稿（记忆自动带入属于 G2B 的
     “添加时有记忆直加”分流，不在本组件里做）。
   选择结果通过 onSelect 回传编辑器；其他参数草稿保持不变。 */

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import {
  mergeExerciseCatalog,
  searchExerciseCatalog,
} from '../domain/exerciseLibrary';
import { exerciseIdFromName } from '../domain/identity';
import type { ExerciseTemplate } from '../domain/types';

export interface ExerciseNameSelection {
  name: string;
  en?: string;
  exerciseId: string;
  /** library = 明确选择动作库身份；custom = 按最终输入名生成/匹配真实 identity */
  source: 'library' | 'custom';
}

interface Props {
  open: boolean;
  /** 打开时的当前名称（清空搜索/自定义输入用） */
  currentName?: string;
  templates?: ExerciseTemplate[];
  onSelect: (selection: ExerciseNameSelection) => void;
  onClose: () => void;
}

export function ExerciseNamePicker({ open, currentName = '', templates, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [customName, setCustomName] = useState('');

  useEffect(() => {
    if (open) {
      setQuery('');
      setCustomName(currentName);
    }
  }, [open, currentName]);

  const catalog = useMemo(() => mergeExerciseCatalog(undefined, templates ?? []), [templates]);
  const entries = useMemo(() => searchExerciseCatalog(catalog, query), [catalog, query]);

  const select = (selection: ExerciseNameSelection) => {
    onSelect(selection);
    onClose();
  };

  const applyCustom = () => {
    const name = customName.trim();
    if (!name) return;
    select({ name, exerciseId: exerciseIdFromName(name), source: 'custom' });
  };

  return (
    <Sheet open={open} title="选择动作" onClose={onClose} autoFocusPanel={false}>
      <div data-testid="exercise-name-picker" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <label htmlFor="exercise-name-search">搜索动作库</label>
          <input
            id="exercise-name-search"
            data-testid="name-search"
            className="input"
            value={query}
            placeholder="搜索名称 / 英文名 / 分组"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="exercise-name-custom">直接输入自定义名称</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="exercise-name-custom"
              data-testid="name-custom-input"
              className="input"
              value={customName}
              placeholder="例如：绳索弯举"
              onChange={(e) => setCustomName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  applyCustom();
                }
              }}
            />
            <button className="btn btn-primary" data-testid="name-custom-apply" onClick={applyCustom} disabled={!customName.trim()}>
              使用
            </button>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 6 }}>
            {query.trim() ? `搜索结果 ${entries.length} 个` : `动作库 ${entries.length} 个（拼音排序）`}
          </div>
          <div style={{ maxHeight: '42vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {entries.map((entry, index) => (
              <button
                key={entry.exerciseId}
                data-testid={`name-option-${index}`}
                className="btn btn-ghost"
                style={{ justifyContent: 'flex-start', textAlign: 'left', minHeight: 44 }}
                onClick={() => select({ name: entry.name, en: entry.en, exerciseId: entry.exerciseId, source: 'library' })}
              >
                <span style={{ overflowWrap: 'anywhere' }}>{entry.name}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-4)' }}>
                  {entry.group ?? ''}
                  {entry.hasTemplate ? ' · 已记忆' : ''}
                </span>
              </button>
            ))}
            {entries.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-3)' }}>没有匹配动作；可直接输入自定义名称。</p>
            ) : null}
          </div>
        </div>
      </div>
    </Sheet>
  );
}
