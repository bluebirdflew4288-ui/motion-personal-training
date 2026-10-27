/* 固定 JSON 计划模板导入（第3阶段，BRIEF 第5项）。
   流程：查看/复制完整模板 → 粘贴纯 JSON 或选择文件 → 严格校验 →
   **只读预览** → 用户确认后一次 insert（atomicInsertPlan，绝不 upsert 覆盖）。

   安全口径：
   · 校验与预览**零写入**；只有确认按钮触发一次事务。
   · 在途/已成功门禁：busy 或本轮已提交 → 确认禁用；重复点击不建两份。
   · 同名计划默认拒绝并要求**明确勾选**后才允许再来一份（不合并、不覆盖）。
   · 输入非法不写；原文保留在文本框里可继续修正。
   · 失败（含事务 abort/容量）：整体回滚、既有一切不动，可重试。
   · G1（REVIEW-3）：**每一次异步读都归属"开始读时那一轮"**。文件 text()/原生 pick
     自取代次；关闭/重开、选新来源、手动改文本或点校验、开始确认都会让更早的在途读失效。
     成功/错误/取消三条返回同样守代次 + 提交锁：晚到读回既不覆盖新预览、
     也不重置 submitted 或切换提交对象；按钮与 handler 双重守卫，不永久禁用入口。
     重新打开=全新干净轮次（open 边沿复位；粘贴文本可保留、不会自动进入旧预览）。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import {
  buildPreview,
  parsePlanTemplate,
  type TemplateIssue,
  type TemplatePreview,
} from '../domain/planTemplate';
import { EXAMPLE_PLAN_TEMPLATE } from '../domain/planTemplateExample';
import { atomicInsertPlan } from '../db/tx';
import type { Plan } from '../domain/types';
import { pickBackupViaNative, usesNativeFileUi } from '../lib/backupFile';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 导入成功（事务已提交）后回调：刷新列表 */
  onImported: (plan: Plan) => void;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
}

type Stage = 'edit' | 'preview';

/** 剪贴板：优先 navigator.clipboard，WebView 回退到临时 textarea + execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function TemplateImportSheet({ open, onClose, onImported, pushToast }: Props) {
  /* 所有 hooks 必须在任何提前 return 之前（第2阶段 REVIEW-2 的教训）。 */
  const [stage, setStage] = useState<Stage>('edit');
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<TemplateIssue[]>([]);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [parsedPlan, setParsedPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  /** 本轮确认门禁：在途/已成功 → 不允许再提交（重复点击不建两份） */
  const [submitted, setSubmitted] = useState(false);
  /** 同名拒绝后，用户明确勾选「确认新增同名计划」 */
  const [allowDupName, setAllowDupName] = useState(false);
  const [dupPrompt, setDupPrompt] = useState<string | null>(null);
  const [showTpl, setShowTpl] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /**
   * G1（REVIEW-3）：读取代次归属。
   * · startRead()：开始一次异步读（文件 text()/原生 pick）时取一个新代次。
   * · 任何边界（选新来源、手动改文本/点校验、关闭/重开、开始确认）调 bump()
   *   使**所有更早的在途读失效**；读回时只有代次仍是最新才应用。
   * · 成功/错误/取消**三条返回**都过这道闸：过期结果既不覆盖新预览，也不
   *   把错误气泡打进已关闭/新轮；确认在途时读回结果无法重置 submitted/换提交对象。
   * · 不永久禁用入口：过期只是丢弃，用户可继续重新发起。
   */
  const genRef = useRef(0);
  const bump = useCallback(() => {
    genRef.current += 1;
  }, []);
  const startRead = useCallback(() => {
    genRef.current += 1;
    return genRef.current;
  }, []);
  const isCurrent = useCallback((g: number) => g === genRef.current, []);
  /**
   * 确认在途 / 已成功守卫用 **ref**（异步回调读到当下值，而非渲染闭包里的陈旧 busy/submitted）。
   * 一旦开始确认写入，任何**更新的读回**（哪怕是新选文件拿到最新代次）都不得：
   * · 重置 submitted · 切换当前提交对象 · 把预览改回别的内容。
   * 入口按钮同步禁用（双保险）；不永久禁用——失败后 activeRef 归还可继续/重试。
   */
  const activeRef = useRef(false); // 正在确认写入
  const submittedRef = useRef(false); // 本轮已成功提交

  /**
   * 打开边沿复位：每一次重新打开都是**全新导入轮次**。
   * 复位会作废上一轮的一切在途读回（genRef++）并清成功/在途锁，
   * 因此成功关窗后留下的 submittedRef 不会污染下一轮；上一轮的慢读
   * 即便在这之后才返回，也因代次过期被丢弃。取消/关闭后可重新发起。
   */
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      genRef.current += 1;
      activeRef.current = false;
      submittedRef.current = false;
      setStage('edit');
      setIssues([]);
      setPreview(null);
      setParsedPlan(null);
      setSubmitted(false);
      setAllowDupName(false);
      setDupPrompt(null);
      setBusy(false);
    }
    prevOpen.current = open;
  }, [open]);

  const resetAll = useCallback(() => {
    genRef.current += 1; // 关闭/重开使旧轮在途读失效
    activeRef.current = false;
    submittedRef.current = false;
    setStage('edit');
    setIssues([]);
    setPreview(null);
    setParsedPlan(null);
    setSubmitted(false);
    setAllowDupName(false);
    setDupPrompt(null);
    setBusy(false);
  }, []);

  const validate = useCallback((raw: string) => {
    // 确认在途 / 已成功：晚到的读回不得重新进入预览、重置 submitted 或换提交对象
    if (activeRef.current || submittedRef.current) return;
    const trimmed = raw.trim();
    if (!trimmed) {
      setIssues([{ path: '(输入)', message: '还没有内容：粘贴 JSON、选择文件，或先复制完整模板' }]);
      setPreview(null);
      setParsedPlan(null);
      setStage('edit');
      return;
    }
    const r = parsePlanTemplate(trimmed);
    if (!r.ok) {
      setIssues(r.issues);
      setPreview(null);
      setParsedPlan(null);
      setStage('edit');
      return;
    }
    // 校验通过 → 进入**只读预览**（这一步仍然零写入）
    setParsedPlan(r.plan);
    setPreview(buildPreview(r.plan));
    setIssues([]);
    setSubmitted(false);
    setAllowDupName(false);
    setDupPrompt(null);
    setStage('preview');
  }, []);

  const onPickFile = useCallback(async () => {
    if (activeRef.current || submittedRef.current) return; // 入口守卫（按钮同时禁用）
    // 原生环境优先系统文件选择器；Web 用隐藏 <input type=file>
    if (usesNativeFileUi()) {
      const gen = startRead();
      let pick;
      try {
        pick = await pickBackupViaNative();
      } catch (err) {
        // 错误返回同样守归属：过期轮次/确认在途的错误不污染
        if (isCurrent(gen) && !activeRef.current && !submittedRef.current) {
          pushToast(err instanceof Error ? `读取文件失败：${err.message}` : '读取文件失败', 'error');
        }
        return;
      }
      if (!isCurrent(gen)) return; // 取消/错误/成功都要先看代次是否仍是本轮
      if (activeRef.current || submittedRef.current) return; // 确认在途：晚到读回不换对象
      if (!pick.ok) {
        if (!pick.cancelled) pushToast(pick.error, 'error');
        return;
      }
      setText(pick.text);
      validate(pick.text);
      return;
    }
    // Web：点「选择文件」= 选择新来源，先作废此前在途读，再触发系统文件框
    startRead();
    fileRef.current?.click();
  }, [pushToast, validate, startRead, isCurrent]);

  const onFileChosen = useCallback(
    async (file: File | null) => {
      // 一次真实文件读 = 一个新代次（含程序化选择也自取，保证归属正确）
      const gen = startRead();
      if (!file) return; // 取消系统文件框：新代次已作废此前在途，无需其它动作
      try {
        const raw = await file.text();
        // 慢读期间可能已被手动校验 / 关闭重开 / 选新文件 / 开始确认作废
        // → 过期即丢弃：成功、错误、取消三条返回都不覆盖更新的结果
        if (!isCurrent(gen)) return;
        if (activeRef.current || submittedRef.current) return; // 确认在途：不重置、不换提交对象
        setText(raw);
        validate(raw);
      } catch (err) {
        if (!isCurrent(gen)) return; // 过期错误不污染已关闭/新轮
        if (activeRef.current || submittedRef.current) return; // 确认在途：不打扰提交
        pushToast(err instanceof Error ? `读取文件失败：${err.message}` : '读取文件失败', 'error');
      }
    },
    [pushToast, validate, isCurrent, startRead],
  );

  const confirmInsert = useCallback(async () => {
    if (!parsedPlan || busy || submitted || activeRef.current || submittedRef.current) return;
    // 开始确认：作废一切在途读回，锁定当前预览/提交对象（写入期间内容稳定）
    genRef.current += 1;
    activeRef.current = true;
    setBusy(true);
    try {
      const r = await atomicInsertPlan(parsedPlan, { allowDuplicateName: allowDupName });
      if (r.ok) {
        submittedRef.current = true;
        setSubmitted(true);
        activeRef.current = false; // 让 finally 不误清 submittedRef；成功锁定到 onClose
        onImported(r.plan);
        pushToast(`已新增计划「${r.plan.name}」（${r.plan.days.length} 个训练日）。既有计划、历史和设置都没有变动。`, 'ok');
        // 注意：成功路径**不**调 resetAll()（它会清 submittedRef，留下"提交后晚到读回
        // 又能改预览"的窗口）。直接关窗；下次 open 变化时才由下方 open effect 复位。
        onClose();
        return;
      }
      if (r.reason === 'duplicate-name') {
        /**
         * 明确门禁：只在弹层内**内联**展示原因与勾选框。
         * 不再 pushToast —— 底部气泡（fixed, z-index:90, 6.2 秒）会盖住
         * 弹层底部的勾选框，真人也得先点掉气泡才能确认（真实 Chrome 自查发现）。
         * 内联提示就在按钮上方，离交互最近、不遮挡。
         */
        setDupPrompt(r.message);
        return;
      }
      pushToast(r.message, 'error');
    } catch (err) {
      pushToast(err instanceof Error ? `导入失败：${err.message}` : '导入失败', 'error');
    } finally {
      activeRef.current = false; // 失败可继续/重试；成功已关窗（resetAll 已清），归还即可
      setBusy(false);
    }
  }, [parsedPlan, busy, submitted, allowDupName, onImported, pushToast, onClose, resetAll]);

  return (
    <Sheet
      open={open}
      title="导入计划模板"
      onClose={() => {
        if (busy) return; // 在途时不关窗掩盖结果
        resetAll();
        onClose();
      }}
      footer={
        stage === 'preview' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {dupPrompt ? (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: 10,
                  background: 'var(--paper-3)',
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              >
                <input
                  type="checkbox"
                  checked={allowDupName}
                  onChange={(e) => setAllowDupName(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  {dupPrompt}
                  <br />
                  <b>确认新增同名计划</b>（两个计划各自独立，不会合并或覆盖）
                </span>
              </label>
            ) : null}
            <button className="btn btn-primary btn-lg" disabled={busy || submitted} onClick={() => void confirmInsert()}>
              {busy ? '正在导入…' : submitted ? '本次已提交' : '确认新增这个计划'}
            </button>
            <button className="btn btn-ghost" style={{ width: '100%' }} disabled={busy} onClick={() => setStage('edit')}>
              返回修改
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              disabled={busy || !text.trim()}
              onClick={() => {
                bump(); // 手动校验 = 当前意图，作废仍在途的旧文件/原生读
                validate(text);
              }}
            >
              校验并预览
            </button>
            <button
              className="btn btn-ghost"
              style={{ width: '100%' }}
              disabled={busy}
              onClick={() => {
                resetAll();
                onClose();
              }}
            >
              取消
            </button>
          </div>
        )
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        aria-label="选择计划模板文件"
        disabled={busy || submitted}
        onChange={(e) => {
          void onFileChosen(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />

      <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.65, margin: '0 0 10px' }}>
        模板是<b>新增一个计划</b>：只读取内容、校验并预览，<b>确认后才写入一次</b>。
        不会覆盖或合并任何已有计划，也不改变当前进行中的训练和历史。
        格式：<span className="mono">format=motion-plan-template · version=1 · 单个 plan</span>。
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setShowTpl((v) => !v)}
          aria-expanded={showTpl}
        >
          {showTpl ? '收起完整模板' : '查看完整模板'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={async () => {
            const ok = await copyToClipboard(EXAMPLE_PLAN_TEMPLATE);
            pushToast(ok ? '完整模板已复制，可直接粘贴到下方或存成 .json' : '复制失败：请展开模板手动全选复制', ok ? 'ok' : 'error');
          }}
        >
          复制示例模板
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={busy || submitted}
          onClick={() => void onPickFile()}
        >
          选择 JSON 文件
        </button>
      </div>

      {showTpl ? (
        <pre
          style={{
            fontSize: 11.5,
            lineHeight: 1.5,
            background: 'var(--paper-3)',
            padding: 10,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 220,
            marginBottom: 10,
          }}
        >
          {EXAMPLE_PLAN_TEMPLATE}
        </pre>
      ) : null}

      {stage === 'edit' ? (
        <>
          <textarea
            className="input"
            style={{ minHeight: 160, fontFamily: 'var(--f-num), monospace', fontSize: 12.5 }}
            value={text}
            aria-label="粘贴计划模板 JSON"
            placeholder={'粘贴纯 JSON，例如：\n{\n  "format": "motion-plan-template",\n  "version": 1,\n  "plan": { "name": "…", "days": [ … ] }\n}'}
            onChange={(e) => {
              bump(); // 手动输入新文本 → 旧文件读回不再覆盖
              setText(e.target.value);
            }}
            disabled={busy}
          />
          {issues.length ? (
            <div role="alert" style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--brick)' }}>
                校验未通过（共 {issues.length} 处，未写入任何内容）
              </div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: 'var(--ink-2)' }}>
                {issues.slice(0, 12).map((it, i) => (
                  <li key={i}>
                    <span className="mono">{it.path}</span>：{it.message}
                  </li>
                ))}
                {issues.length > 12 ? <li>…其余 {issues.length - 12} 处同类问题</li> : null}
              </ul>
            </div>
          ) : null}
        </>
      ) : preview ? (
        <div>
          <div style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 8 }}>
            以下只是<b>只读预览</b>，还没有写入。确认后才新增计划。
          </div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{preview.planName}</div>
          <div className="mono-label" style={{ marginTop: 2 }}>
            {preview.dayCount} 个训练日 · 力量 {preview.trainDays} · 有氧 {preview.cardioDays} · 休息 {preview.restDays}
          </div>
          <div className="rows" style={{ marginTop: 10 }}>
            {preview.days.map((d) => (
              <div key={d.order} className="row" style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <span className="row-main" style={{ minWidth: 0 }}>
                  <span className="row-title">
                    {d.order}. {d.name}
                    {d.focusLabel ? `（${d.focusLabel}${d.roundLabel ? ` ${d.roundLabel}` : ''}）` : ''}
                    {d.kind === 'cardio' ? '（有氧）' : d.kind === 'rest' ? '（休息）' : ''}
                  </span>
                  {d.kind === 'train' ? (
                    <>
                      <span className="row-sub">
                        {d.exerciseLines.length} 个动作 · 目标 {d.targetSets} 组
                        {d.warmupCount ? ` · 热身 ${d.warmupCount} 项` : ''}
                      </span>
                      {d.exerciseLines.map((line, i) => (
                        <div key={i} style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                          {line}
                        </div>
                      ))}
                    </>
                  ) : d.kind === 'cardio' ? (
                    d.cardioLines.map((line, i) => (
                      <div key={i} style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>
                        {line}
                      </div>
                    ))
                  ) : (
                    <span className="row-sub">{d.restNote ?? '完全休息'}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
