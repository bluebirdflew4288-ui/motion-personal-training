/* 文本草稿输入（v0.1.1 / L01-reliability）。
   ── 修的真实缺陷 ──────────────────────────────────────────────
   旧实现是「受控 value + onChange 立刻异步保存」：
     value={day.name}  onChange={e => void save(renameDay(plan, day.id, e.target.value))}
   而 domain 的 renameDay/renamePlan 都是 `name.trim() || 旧名`。
   于是真实键盘路径「全选 → 删除」会：
     1) onChange('') → renameDay('') → 返回**旧名**的 plan → 写库；
     2) 异步写完成后 store 刷新 → 受控 value 又变回旧名 → 输入框当场把旧名弹回来；
     3) 用户接着逐键输入，每次按键都撞上第 2 步的回填 → 出现
        「胸 A超级长…」「背 ASuerlirailstcEpalocou」这种**字符丢失/错序**。
   中文 IME 更糟：composition 期间被受控回写打断。

   ── 本轮契约 ────────────────────────────────────────────────
   · 输入期间只维护**本地文本草稿**：允许空串、允许中间态空格、允许 composition。
   · 只有 blur 或**非 composition** 的 Enter 才统一校验提交。
   · 提交成功才认「已保存」；失败保留草稿并显示错误，可继续改或重试。
   · 外部值变化只在「未聚焦且不是自己刚提交的值」时同步，避免打断输入。
   · 不静默把空串回填成旧值（那正是旧缺陷的表象）。

   这个组件不碰存储、不碰锁：提交动作由父级注入，父级必须**如实返回 boolean**。 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** 受控外部值（来自 store） */
  value: string;
  /** 提交：返回 true 表示真的保存成功；false 表示失败（草稿保留可重试） */
  onCommit: (next: string) => Promise<boolean> | boolean;
  /** 无障碍标签 */
  ariaLabel: string;
  /** 允许为空（例如热身目标文本可以为空）；默认不允许 */
  allowEmpty?: boolean;
  /** 空值/非法时的提示 */
  emptyMessage?: string;
  /** 最大长度（与 db/validate.ts 的约束对齐，避免提交后才被拒） */
  maxLength?: number;
  className?: string;
  /** 作用在**内部 input** 上（字号/高度/边框等外观） */
  style?: React.CSSProperties;
  /**
   * 作用在**外层 wrapper** 上（flex/width/minWidth 等容器布局）。
   * 独立出来是因为组件多了一层 div：若把 flex 等布局属性塞进 style，
   * 它们会落在 input 而不是父 flex/grid 的 item 上。
   */
  wrapperStyle?: React.CSSProperties;
  placeholder?: string;
  id?: string;
  /** 失焦后是否把非法草稿回滚成外部值（默认 false：保留草稿让用户改） */
  revertOnInvalidBlur?: boolean;
}

export function DraftTextField({
  value,
  onCommit,
  ariaLabel,
  allowEmpty = false,
  emptyMessage = '不能为空',
  maxLength,
  className = 'input',
  style,
  wrapperStyle,
  placeholder,
  id,
  revertOnInvalidBlur = false,
}: Props) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  /** composition 期间绝不提交（中文/日文 IME 的中间态不是用户意图） */
  const composing = useRef(false);
  /**
   * T11：composition 期间发生 blur 时，要记住「用户已经想提交」这件事。
   * 旧实现在 blur 里直接 return，compositionEnd 只把标志置 false ——
   * 若之后没有第二次 blur/Enter，用户以为失焦已保存，实际一次都没提交。
   */
  const pendingBlurCommit = useRef(false);
  /**
   * 始终指向最新草稿文本。
   * compositionEnd 的闭包可能仍是中间态，必须从 ref 取**最终文本**。
   */
  const draftRef = useRef(value);
  draftRef.current = draft;
  /** 最近一次确认成功的值：用来判断外部变化是不是「自己刚提交的那次」 */
  const lastCommitted = useRef(value);
  /** 提交串行化：避免 blur 与 Enter 同时触发两次写 */
  const inFlight = useRef(false);

  /**
   * 外部值变化 → 是否采纳？
   *
   * T10（独立审查）：旧实现只看 focused，于是「保存失败后父级 props 变化」会把
   * 未保存草稿与错误一起抹掉 —— 与「失败保留草稿可重试」直接冲突。
   *
   * 现在的规则：只有**干净的空闲字段**才采纳外部值。
   *   · focused          → 用户正在输入，不打断
   *   · saving           → 有在途提交，不抢
   *   · dirty（草稿≠已提交基线） → 有未保存意图，保留草稿与错误
   *   · error            → 刚失败过，保留草稿让用户重试
   * 干净的 idle 字段仍然同步外部更新（不能简单关掉这个 effect）。
   */
  useEffect(() => {
    if (focused || saving) return;
    const dirty = draft !== lastCommitted.current;
    if (dirty || error) return; // 保留本地意图与错误，不把外部值当成放弃信号
    if (value === lastCommitted.current) return;
    setDraft(value);
    lastCommitted.current = value;
  }, [value, focused, saving, draft, error]);

  const commit = async (raw: string): Promise<void> => {
    if (inFlight.current) return;
    const trimmed = raw.trim();
    if (!allowEmpty && trimmed === '') {
      setError(emptyMessage);
      if (revertOnInvalidBlur) {
        setDraft(lastCommitted.current);
        setError(null);
      }
      return;
    }
    // 没有实际变化就不写库（避免无意义的写事务）
    if (trimmed === lastCommitted.current) {
      setDraft(trimmed);
      setError(null);
      return;
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const ok = await onCommit(trimmed);
      if (ok) {
        lastCommitted.current = trimmed;
        setDraft(trimmed);
        setError(null);
      } else {
        // 失败：保留草稿，明确提示，可重试
        setError('未保存，可重试');
      }
    } catch (err) {
      setError(err instanceof Error ? `未保存：${err.message}` : '未保存，可重试');
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div style={{ minWidth: 0, ...wrapperStyle }}>
      <input
        id={id}
        className={className}
        style={{
          ...style,
          // 失败态用边框颜色提示，不改布局（避免抖动）
          ...(error ? { borderColor: 'var(--brick)' } : null),
        }}
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={saving}
        onChange={(e) => {
          // 只改本地草稿：允许空串与中间态，不写库
          draftRef.current = e.target.value;
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          // 最终文本以本次事件的值为准（此刻 React state 可能还是中间态）
          const finalText = e.currentTarget.value;
          draftRef.current = finalText;
          setDraft(finalText);
          // T11：IME 期间发生过 blur → 现在用最终文本补做那一次校验提交
          if (pendingBlurCommit.current) {
            pendingBlurCommit.current = false;
            void commit(finalText);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (composing.current) {
            // IME 还在组合中：先记下提交意图，等 compositionEnd 用最终文本补交
            pendingBlurCommit.current = true;
            return;
          }
          void commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          // 非 composition 的 Enter 才提交（输入法确认键不算）
          if (composing.current || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void commit(draft);
        }}
      />
      {error ? (
        <div role="alert" style={{ fontSize: 11.5, color: 'var(--brick)', marginTop: 2 }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
