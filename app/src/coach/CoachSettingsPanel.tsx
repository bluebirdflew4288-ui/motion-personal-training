/* CC Switch 风格电子教练模型配置面板（协议 / Base URL / 获取模型 / 常用清单 / 手动兜底）。 */

import { useMemo, useState } from 'react';
import {
  COACH_THINKING_LEVELS, coachModelKey, coachThinkingLabel, coachThinkingLevels, fetchProviderModels,
  type CoachThinkingDepth,
  type CoachProviderKind,
  type CoachRemoteModel,
} from './providerAdapter';

export interface CoachSettingsPanelProps {
  kind: CoachProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  onChangeKind: (kind: CoachProviderKind) => void;
  onChangeBaseUrl: (url: string) => void;
  onChangeApiKey: (key: string) => void;
  onSelectModel: (modelId: string) => void;
  onChangeModels: (nextModels: string[]) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  capabilitiesByModel: Record<string, CoachThinkingDepth[]>;
  onCapabilities: React.Dispatch<React.SetStateAction<Record<string, CoachThinkingDepth[]>>>;
}

export function CoachSettingsPanel({
  kind,
  baseUrl,
  apiKey,
  model,
  models,
  onChangeKind,
  onChangeBaseUrl,
  onChangeApiKey,
  onSelectModel,
  onChangeModels,
  onClose,
  onSave,
  capabilitiesByModel,
  onCapabilities,
}: CoachSettingsPanelProps) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<CoachRemoteModel[]>([]);
  const [remoteSearch, setRemoteSearch] = useState('');
  const [manualModelInput, setManualModelInput] = useState('');

  const identity = { kind, baseUrl, model };
  const modelKey = coachModelKey(identity);
  const availableLevels = capabilitiesByModel[modelKey] ?? coachThinkingLevels(identity);
  const savedSet = useMemo(() => new Set(models), [models]);
  const filteredRemote = useMemo(() => {
    const q = remoteSearch.trim().toLowerCase();
    if (!q) return remoteModels;
    return remoteModels.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        Boolean(m.displayName && m.displayName.toLowerCase().includes(q)),
    );
  }, [remoteModels, remoteSearch]);

  const handleFetchModels = async () => {
    if (fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      const list = await fetchProviderModels({
        kind,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
      });
      setRemoteModels(list);
      if (!list.length) setFetchError('接口未返回模型，可以手动添加。');
      onCapabilities((prev) => {
        const next = { ...prev };
        for (const item of list) {
          const key = coachModelKey({ kind, baseUrl, model: item.id });
          if (item.thinkingLevels && !Object.hasOwn(prev, key) && !coachThinkingLevels({ kind, baseUrl, model: item.id }).length) {
            next[key] = item.thinkingLevels;
          }
        }
        return next;
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : '获取模型列表失败');
    } finally {
      setFetching(false);
    }
  };

  const toggleSavedModel = (id: string) => {
    if (savedSet.has(id)) {
      const next = models.filter((m) => m !== id);
      onChangeModels(next);
      if (model.trim() === id) {
        onSelectModel(next[0] ?? '');
      }
      return;
    }
    const next = [...models, id];
    onChangeModels(next);
    if (!model.trim()) {
      onSelectModel(id);
    }
  };

  const handleAddManualModel = () => {
    const id = manualModelInput.trim();
    if (!id) return;
    if (!savedSet.has(id)) {
      onChangeModels([...models, id]);
    }
    onSelectModel(id);
    setManualModelInput('');
  };

  return (
    <section className="coach-settings-panel" data-testid="coach-settings-panel">
      <h2>模型设置</h2>
      <div className="coach-settings-grid">
        <label className="coach-settings-span2">
          <span>协议</span>
          <select value={kind} onChange={(e) => onChangeKind(e.target.value as CoachProviderKind)}>
            <option value="openai-compatible">OpenAI-Compatible</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label className="coach-settings-span2">
          <span>接口地址</span>
          <input
            type="url"
            data-testid="coach-base-url-input"
            placeholder={
              kind === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta'
                : 'https://api.openai.com/v1'
            }
            value={baseUrl}
            onChange={(e) => onChangeBaseUrl(e.target.value)}
          />
        </label>
        <label className="coach-settings-span2">
          <span>API Key · 保存在本机</span>
          <input
            type="password"
            data-testid="coach-api-key-input"
            placeholder="留空则使用本地引擎"
            value={apiKey}
            onChange={(e) => onChangeApiKey(e.target.value)}
          />
        </label>
      </div>

      <div className="coach-models-toolbar">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="coach-fetch-models-btn"
          disabled={fetching || !baseUrl.trim()}
          onClick={() => void handleFetchModels()}
        >
          {fetching ? '拉取中…' : '获取模型'}
        </button>

      </div>

      {fetchError ? <div className="coach-settings-error" role="alert">{fetchError}</div> : null}

      {remoteModels.length > 0 ? (
        <div className="coach-remote-models-box">
          <div className="coach-remote-models-head">
            <span>远端可选模型（{remoteModels.length}）</span>
            <input
              type="text"
              data-testid="coach-remote-model-search"
              placeholder="搜索模型名…"
              value={remoteSearch}
              onChange={(e) => setRemoteSearch(e.target.value)}
            />
          </div>
          <div className="coach-remote-models-list" data-testid="coach-remote-models-list">
            {filteredRemote.length === 0 ? (
              <div className="coach-remote-empty">没有匹配的模型</div>
            ) : (
              filteredRemote.map((rm) => {
                const added = savedSet.has(rm.id);
                return (
                  <button
                    key={rm.id}
                    type="button"
                    className={`coach-remote-model-item${added ? ' is-added' : ''}`}
                    data-testid={`coach-remote-model-item-${rm.id}`}
                    onClick={() => toggleSavedModel(rm.id)}
                  >
                    <span className="coach-remote-model-name">
                      <strong>{rm.id}</strong>
                      {rm.displayName ? <small>{rm.displayName}</small> : null}
                    </span>
                    <span className="coach-remote-model-badge">{added ? '✓ 已添加' : '+ 添加'}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}

      <div className="coach-saved-models-section">
        <div className="coach-saved-models-label">常用模型</div>
        {models.length === 0 ? (
          null
        ) : (
          <div className="coach-saved-models" data-testid="coach-saved-models">
            {models.map((id) => {
              const active = model.trim() === id;
              return (
                <div key={id} className={`coach-saved-chip${active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="coach-saved-chip-select"
                    data-testid={`coach-saved-model-select-${id}`}
                    onClick={() => onSelectModel(id)}
                  >
                    {active ? '● ' : ''}
                    {id}
                  </button>
                  <button
                    type="button"
                    className="coach-saved-chip-remove"
                    data-testid={`coach-saved-model-remove-${id}`}
                    aria-label={`移除模型 ${id}`}
                    onClick={() => toggleSavedModel(id)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <details className="coach-settings-advanced">
        <summary>手动添加模型 / 档位设置</summary>
        <label>当前模型 ID
          <input value={model} data-testid="coach-model-id-input" onChange={(e) => onSelectModel(e.target.value)} />
        </label>
        <div className="coach-manual-add">
          <input data-testid="coach-manual-model-input" aria-label="要添加的模型 ID" placeholder="模型 ID"
            value={manualModelInput} onChange={(e) => setManualModelInput(e.target.value)} />
          <button type="button" className="btn btn-sm btn-ghost" data-testid="coach-manual-model-add-btn"
            disabled={!manualModelInput.trim()} onClick={handleAddManualModel}>添加</button>
        </div>
        {model.trim() && baseUrl.trim() && (
          <fieldset>
            <legend>可选档位</legend>
            {COACH_THINKING_LEVELS.filter((level) => kind !== 'gemini' || (level !== 'xhigh' && level !== 'max' && !(/^gemini-3/.test(model) && level === 'off'))).map((level) => (
              <label key={level}>
                <input type="checkbox" checked={availableLevels.includes(level)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    onCapabilities((prev) => ({
                      ...prev,
                      [modelKey]: COACH_THINKING_LEVELS.filter((value) =>
                        value === level ? checked : availableLevels.includes(value)),
                    }));
                  }} />
                {coachThinkingLabel(level)}
              </label>
            ))}
          </fieldset>
        )}
      </details>
      {!apiKey.trim() && <small>留空使用本地教练</small>}
      {apiKey.trim() && !model.trim() && <small>在线服务会收到发送的消息、附件和相关训练摘要。</small>}

      <div className="coach-settings-actions">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
          收起
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          data-testid="coach-settings-save-btn"
          onClick={() => void onSave()}
        >
          保存设置
        </button>
      </div>
    </section>
  );
}
