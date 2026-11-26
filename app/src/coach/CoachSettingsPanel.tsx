/* CC Switch 风格电子教练模型配置面板（协议 / Base URL / 获取模型 / 常用清单 / 手动兜底）。 */

import { useMemo, useState } from 'react';
import { resolveModelContextWindow } from './coachContext';
import { normalizeWebSearchProvider, type CoachWebSearchProvider } from './coachStorage';
import {
  COACH_THINKING_LEVELS, coachModelKey, coachThinkingLabel, coachThinkingLevels, fetchProviderModels,
  type CoachThinkingDepth,
  type CoachProviderKind,
  type CoachRemoteModel,
} from './providerAdapter';
import {
  COACH_PROVIDER_PRESETS,
  probeDeploymentCapabilities,
  resolveProviderCapabilities,
} from './providerCapabilities';

export interface CoachSettingsPanelProps {
  kind: CoachProviderKind;
  presetId?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  models: string[];
  onChangeKind: (kind: CoachProviderKind) => void;
  onSelectPreset?: (presetId: string) => void;
  onChangeBaseUrl: (url: string) => void;
  onChangeApiKey: (key: string) => void;
  onSelectModel: (modelId: string) => void;
  onChangeModels: (nextModels: string[]) => void;
  onClose: () => void;
  onSave: () => void | Promise<void>;
  capabilitiesByModel: Record<string, CoachThinkingDepth[]>;
  onCapabilities: React.Dispatch<React.SetStateAction<Record<string, CoachThinkingDepth[]>>>;
  webSearchProvider?: CoachWebSearchProvider;
  webSearchApiKey?: string;
  onChangeWebSearchProvider?: (provider: CoachWebSearchProvider) => void;
  onChangeWebSearchApiKey?: (key: string) => void;
  contextWindowByModel?: Record<string, number>;
  onContextWindows?: (windows: Record<string, number>) => void;
  onOpenMemory?: () => void;
  memoryCount?: number;
}

export function CoachSettingsPanel({
  kind,
  presetId,
  baseUrl,
  apiKey,
  model,
  models,
  onChangeKind,
  onSelectPreset,
  onChangeBaseUrl,
  onChangeApiKey,
  onSelectModel,
  onChangeModels,
  onClose,
  onSave,
  capabilitiesByModel,
  onCapabilities,
  webSearchProvider = 'builtin',
  webSearchApiKey = '',
  onChangeWebSearchProvider,
  onChangeWebSearchApiKey,
  contextWindowByModel = {},
  onContextWindows,
  onOpenMemory,
  memoryCount = 0,
}: CoachSettingsPanelProps) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<CoachRemoteModel[]>([]);
  const [remoteSearch, setRemoteSearch] = useState('');
  const [manualModelInput, setManualModelInput] = useState('');
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);

  const identity = { kind, presetId, baseUrl, model };
  const modelKey = coachModelKey(identity);
  const availableLevels = capabilitiesByModel[modelKey] ?? coachThinkingLevels(identity);
  const effectiveSearchProvider = normalizeWebSearchProvider(webSearchProvider);
  const needsSearchApiKey =
    effectiveSearchProvider === 'tavily' ||
    effectiveSearchProvider === 'bocha' ||
    effectiveSearchProvider === 'brave';
  const autoContextWindow = resolveModelContextWindow(model);
  const customContextWindow = contextWindowByModel[modelKey];
  const resolvedCaps = useMemo(
    () =>
      resolveProviderCapabilities({
        kind,
        presetId,
        baseUrl,
        model,
        contextWindowOverride: customContextWindow,
      }),
    [kind, presetId, baseUrl, model, customContextWindow],
  );
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
      if (onContextWindows) {
        const winMap: Record<string, number> = {};
        for (const item of list) {
          if (typeof item.contextLength === 'number' && item.contextLength >= 4096) {
            winMap[coachModelKey({ kind, baseUrl, model: item.id })] = Math.round(item.contextLength);
          }
        }
        if (Object.keys(winMap).length) onContextWindows(winMap);
      }
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
      <div className="coach-presets-row" data-testid="coach-provider-presets">
        {COACH_PROVIDER_PRESETS.map((p) => {
          const active =
            presetId === p.id ||
            (!presetId &&
              p.kind === kind &&
              baseUrl.trim().replace(/\/+$/, '') === p.defaultBaseUrl.replace(/\/+$/, ''));
          return (
            <button
              key={p.id}
              type="button"
              className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`}
              data-testid={`coach-preset-${p.id}`}
              title={p.description}
              onClick={() => {
                onChangeKind(p.kind);
                onChangeBaseUrl(p.defaultBaseUrl);
                onSelectModel(p.defaultModel);
                if (!savedSet.has(p.defaultModel)) {
                  onChangeModels([...models, p.defaultModel]);
                }
                onSelectPreset?.(p.id);
                setProbeNote(null);
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="coach-settings-grid">
        <label className="coach-settings-span2">
          <span>协议</span>
          <select
            data-testid="coach-protocol-select"
            value={kind}
            onChange={(e) => onChangeKind(e.target.value as CoachProviderKind)}
          >
            <option value="openai-compatible">OpenAI-Compatible</option>
            <option value="anthropic">Anthropic Messages</option>
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
                : kind === 'anthropic'
                  ? 'https://api.anthropic.com/v1'
                  : 'https://api.deepseek.com'
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
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="coach-probe-capabilities-btn"
          disabled={probing || !baseUrl.trim() || !model.trim()}
          onClick={() => {
            if (probing) return;
            setProbing(true);
            setProbeNote(null);
            void probeDeploymentCapabilities({
              kind,
              presetId,
              baseUrl: baseUrl.trim(),
              model: model.trim(),
              apiKey: apiKey.trim() || undefined,
            })
              .then((out) => setProbeNote(out.probeNotes ?? '探测完成'))
              .catch((err) => setProbeNote(err instanceof Error ? err.message : '探测失败'))
              .finally(() => setProbing(false));
          }}
        >
          {probing ? '探测中…' : '探测端点能力'}
        </button>
      </div>

      {(baseUrl.trim() || model.trim()) ? (
        <div className="coach-settings-caps-info" data-testid="coach-capabilities-summary">
          <small>
            部署能力：{resolvedCaps.displayName} · 缓存：
            {resolvedCaps.cacheMechanism === 'implicit_prefix'
              ? '隐式前缀'
              : resolvedCaps.cacheMechanism === 'explicit_breakpoints'
                ? '显式 ephemeral 断点'
                : resolvedCaps.cacheMechanism === 'implicit_or_explicit'
                  ? '隐式/显式'
                  : '未知保守'}
            {resolvedCaps.requiresReasoningReplayWithTools ? ' · 跨轮回传思考' : ''}
            {resolvedCaps.supportsNativeVision ? ' · 原生识图' : ' · 纯文本摘要识图'}
            {resolvedCaps.pricing.currency !== 'unknown'
              ? ` · 费率 ${resolvedCaps.pricing.currency}${
                  resolvedCaps.pricing.pricingWindow === 'peak'
                    ? '(高峰)'
                    : resolvedCaps.pricing.pricingWindow === 'off_peak'
                      ? '(空闲)'
                      : ''
                }`
              : ' · 费率 unknown'}
          </small>
          {probeNote ? <small data-testid="coach-probe-note"> · 实测：{probeNote}</small> : null}
        </div>
      ) : null}

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
            {COACH_THINKING_LEVELS.filter((level) =>
              kind === 'gemini'
                ? level !== 'xhigh' && level !== 'max' && !(/^gemini-3/.test(model) && level === 'off')
                : kind === 'anthropic'
                  ? level !== 'minimal' && level !== 'xhigh'
                  : true,
            ).map((level) => (
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
        {model.trim() && baseUrl.trim() && onContextWindows ? (
          <div className="coach-settings-ctx-box">
            <label>
              上下文窗口上限（Tokens）
              <input
                type="number"
                min={4096}
                step={1024}
                data-testid="coach-context-window-input"
                placeholder={`自动识别（当前 ${autoContextWindow.toLocaleString()}）`}
                value={customContextWindow ?? ''}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  if (!e.target.value.trim()) {
                    onContextWindows({ [modelKey]: 0 });
                  } else if (Number.isFinite(raw) && raw >= 4096) {
                    onContextWindows({ [modelKey]: Math.round(raw) });
                  }
                }}
              />
            </label>
            <div className="coach-ctx-presets">
              {[
                { label: '128K', val: 131_072 },
                { label: '200K', val: 200_000 },
                { label: '512K', val: 524_288 },
                { label: '1M', val: 1_048_576 },
                { label: '自动', val: 0 },
              ].map((preset) => {
                const isActive =
                  preset.val === 0
                    ? customContextWindow === undefined
                    : customContextWindow === preset.val;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`coach-ctx-preset-btn${isActive ? ' is-active' : ''}`}
                    data-testid={`coach-context-preset-${preset.label}`}
                    onClick={() => onContextWindows({ [modelKey]: preset.val })}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </details>

      {onChangeWebSearchProvider && (
        <div className="coach-settings-search">
          <label>
            联网搜索服务
            <select
              data-testid="coach-web-search-provider"
              value={effectiveSearchProvider}
              onChange={(e) => onChangeWebSearchProvider(e.target.value as CoachWebSearchProvider)}
            >
              <option value="builtin">内置联网（免 Key · 任意模型可用）</option>
              <option value="tavily">Tavily Search（需 Key）</option>
              <option value="bocha">博查 Bocha AI（中文检索 · 需 Key）</option>
              <option value="brave">Brave Search（需 Key）</option>
              <option value="off">关闭外网搜索（仅 Gemini 原生）</option>
            </select>
          </label>
          {needsSearchApiKey && onChangeWebSearchApiKey && (
            <label>
              搜索 API Key
              <input
                type="password"
                data-testid="coach-web-search-key"
                placeholder="填写搜索服务商 Key（留空则不可用）"
                value={webSearchApiKey}
                onChange={(e) => onChangeWebSearchApiKey(e.target.value)}
              />
            </label>
          )}
        </div>
      )}

      {onOpenMemory && (
        <div className="coach-settings-memory-row">
          <div className="coach-settings-memory-meta">
            <strong>教练长期记忆</strong>
            <small>保存训练偏好、伤病避让与器械经验（{memoryCount} 条）</small>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-testid="coach-settings-memory-btn"
            onClick={onOpenMemory}
          >
            管理记忆
          </button>
        </div>
      )}

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
