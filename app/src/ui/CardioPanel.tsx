/* 有氧计时面板（第2阶段）。
   ── 关键约束（G7 重写）──────────────────────────────────────
   1. 计时 tick 只在本组件内部（不牵动整个训练页重渲染）。
   2. 滑杆中间值与精确输入草稿走**同一套草稿契约**：
      每次「开始 / 继续 / 完成 / 参数确认」之前先 flushAll 当前草稿，
      并对**最新 entry**（不是渲染闭包里预算的旧 entry）计算：
        · 草稿有效 → 先提交参数再执行动作；
        · 草稿非法 → 保持可纠正或让用户明确「放弃这次修改」；
          **不默用旧值、不静默隐藏**非法输入。
      唯一例外是「暂停」：暂停只是封口，不能因参数草稿而困住保存/封口，
      因此暂停忽略非法草稿直接封口（草稿保留可随后修正）。
   3. 参数提交不暂停、不重置计时；同值不增段。
   4. 达分段上限时拒绝需要新段的参数变化，但暂停/完成/保存照常。
   5. 完成（done）后仍可查看分段明细（不隐藏唯一展开入口）。
   6. 会话级不变量（最多一个 running、8 项上限）在 apply 里核验。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CARDIO_PRESET_LABEL,
  commitCardioParams,
  completeCardio,
  describeCardioParams,
  liveElapsedMs,
  paramsEqual,
  pauseCardio,
  resumeCardio,
  segmentDurationMs,
  startCardio,
  validateCardioParams,
} from '../domain/cardio';
import {
  MAX_INCLINE_PCT,
  MAX_SPEED_KMH,
  MAX_STAIR_LEVEL,
  MIN_INCLINE_PCT,
  MIN_SPEED_KMH,
  MIN_STAIR_LEVEL,
} from '../domain/limits';
import { fmtCountdown } from '../lib/format';
import type { CardioEntry, CardioParams, Session } from '../domain/types';
import { withCardioEntry } from '../domain/session';
import { DraftNumberField } from './DraftNumberField';
import { useDraftForm } from './draftForm';

/** 毫秒 → m:ss（正计时，无目标时长） */
function fmtElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 计时读数：自己 tick，不牵动父组件 */
function useElapsedTick(running: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(id);
  }, [running]);
  return tick;
}

interface Props {
  entry: CardioEntry;
  /**
   * 累积式更新（与训练页同一保存链路）。
   * fn 收到**最新** entry 与 session（G7：不用渲染闭包里的旧 entry），
   * 返回 null 表示拒绝写入（此时不改任何数据）。
   */
  apply: (fn: (latest: CardioEntry, session: Session) => Session | null) => void;
  /** 输入是否被暂停（待存草稿/只读） */
  disabled?: boolean;
  pushToast: (text: string, kind?: 'info' | 'error' | 'ok') => void;
  /**
   * G7（补充）：把「先处理当前草稿」的能力登记给父页。
   * 父页的「整次结束训练」也要走一遍，不只是 Panel 自己的按钮。
   * 登记 flush 时传函数，卸载时传 null。
   */
  registerFlush?: (entryId: string, flush: (() => boolean) | null) => void;
  /** G3A2：父页注册“实时读取当前草稿签名”的 getter（队列执行时调用，不依赖重渲染） */
  registerRawSignature?: (getter: (() => string | undefined) | null) => void;
}

export function CardioPanel({ entry, apply, disabled, pushToast, registerFlush, registerRawSignature }: Props) {
  const running = entry.status === 'running';
  const done = entry.status === 'done';
  const tick = useElapsedTick(running);
  const form = useDraftForm();
  const [paramError, setParamError] = useState<string | null>(null);
  const [showSegments, setShowSegments] = useState(false);
  /** 有未纠正的草稿时置 true：done 后也保留参数区以便纠正/放弃 */
  const [draftPending, setDraftPending] = useState(false);

  /** 滑杆中间值：只存本地，提交才落库 */
  const [slider, setSlider] = useState<CardioParams>(entry.currentParams);
  useEffect(() => {
    setSlider(entry.currentParams);
  }, [entry.currentParams]);
  /**
   * G3：手势终结的**幂等保护**。
   *
   * 一次拖动可能先后触发 pointerup / touchend / keyup / blur 多个终结事件。
   * 旧实现每个事件都跑一遍提交链，虽然 commitCardioParams 内部有同值判断，
   * 但重复跑仍会重复 flush 草稿与重复校验。这里用"已提交的滑杆快照"挡掉
   * 同一手势的后续终结，保证**只提交一次**。
   *
   * 注意：这里只挡重复终结，不改变"同值不增段"的领域语义。
   */
  /**
   * 上次**成功提交**的滑杆值（幂等基准）。
   *
   * 修复点（G3 复核）：
   * · 必须随外部 currentParams 变化重置 —— 否则精确框改过参数后，
   *   把滑杆拖回"旧滑杆值"会被误判成重复终结而**永不提交**；
   * · 只能在**提交成功之后**推进 —— 否则草稿非法被拦时快照已前进，
   *   用户修好草稿再松手会被误判重复，参数永远提交不上。
   */
  const lastCommittedSlider = useRef<CardioParams>(entry.currentParams);
  /**
   * **字段级意图时序**（B3/G3 真实 CUA 修复）。
   *
   * ── 被修复的真实失败 ─────────────────────────────────────────
   * 用户输入未完 `7.` → 拖滑杆到 15.5（被草稿门禁拦住，**未提交**）
   * → 用户把精确框改成合法 `7.5` 并失焦 → **实际存成 15.5**。
   *
   * 根因：合并时把整个滑杆对象展开覆盖到 candidate 上 —— 滑杆的 pending 值
   * **无条件**压过精确框的 candidate，即使精确意图**更晚**。
   *
   * ── 修复：每个字段记录"最近一次用户意图"的序号与来源 ──────────
   * 提交时逐字段比较：**较新的意图胜出**。
   * 精确框输入 → 该字段 slider 意图作废（回退到库值），精确值优先；
   * 滑杆拖动 → 该字段精确草稿若无更新，则滑杆优先。
   */
  const fieldIntentRef = useRef<{
    speedKmh?: { seq: number; from: 'slider' | 'precise' };
    inclinePct?: { seq: number; from: 'slider' | 'precise' };
    level?: { seq: number; from: 'slider' | 'precise' };
  }>({});
  const intentSeqRef = useRef(0);
  /** 标记某字段的最新意图来源 */
  const markIntent = (field: 'speedKmh' | 'inclinePct' | 'level', from: 'slider' | 'precise') => {
    intentSeqRef.current += 1;
    fieldIntentRef.current[field] = { seq: intentSeqRef.current, from };
  };
  /** 外部已提交值变化时同步基准（精确框提交、暂停封口、丢弃草稿等都会走到） */
  useEffect(() => {
    lastCommittedSlider.current = entry.currentParams;
  }, [entry.currentParams]);

  /**
   * 滑杆手势终结：仅当本地值与**已成功提交**的基准不同才走提交链。
   * 快照只在 withDraft 真正成功（未被 blocked）后推进。
   * @returns 是否真的执行了提交
   */
  const commitSliderOnce = (): boolean => {
    if (paramsEqual(slider, lastCommittedSlider.current)) {
      // 同一手势的重复终结，或用户拖回原值 → 不提交、不增段
      return false;
    }
    const pending = slider;
    const ok = withDraft((l, ss) => withCardioEntry(ss, l));
    // 只有真的没被草稿/校验拦住，才把基准推进到本次值
    if (ok) lastCommittedSlider.current = pending;
    return ok;
  };

  /**
   * G3：手势**取消**（pointercancel / 系统抢占触摸）→ 不提交、不增段、计时不停。
   *
   * 旧实现没有取消入口：浏览器把拖动判成滚动手势而 pointercancel 时，
   * 本地 slider 仍停在半路的值，之后任意一次 blur/pointerup 会把它当作用户意图提交，
   * 悄悄记一段用户并没有确认的强度。取消只把滑杆退回**库里的已提交值**，
   * 不改 entry、不 flush 草稿、不推进幂等基准。
   */
  const cancelSliderGesture = (): void => {
    setSlider(entry.currentParams);
  };

  const live = useMemo(() => {
    void tick;
    return liveElapsedMs(entry);
  }, [entry, tick]);

  const isTreadmill = entry.preset === 'treadmill-incline';
  const showParams = !done || draftPending;

  /**
   * G3A2：把**实时 getter** 交给父页（删除预览/队列执行时调用）。
   *
   * 不用 state 快照：子字段 raw 文本变化（7.→8.）不会触发 Panel 重渲染，
   * 快照签名会过期。getter 每次现读注册字段原文 + 滑杆/草稿态，只读不 flush。
   */
  const sliderRef = useRef(slider);
  sliderRef.current = slider;
  const draftPendingRef = useRef(draftPending);
  draftPendingRef.current = draftPending;
  useEffect(() => {
    if (!registerRawSignature) return undefined;
    const getter = () => {
      const exact = form.probeRawSignature();
      const unsafe = [...form.unsafeFieldIds()].sort();
      /**
       * G3A2-FIX1：**pending slider** 也算未提交风险。
       * 不能只在 exact/unsafe/draftPending 非空时才看滑杆 —— 用户拖了滑杆
       * 但还没提交（或提交被草稿拦住）时，删除必须重新确认。
       */
      const sliderPending = !paramsEqual(sliderRef.current, entry.currentParams);
      if (!exact && !unsafe.length && !draftPendingRef.current && !sliderPending) return undefined;
      return JSON.stringify({ exact, unsafe, slider: sliderRef.current, draftPending: draftPendingRef.current });
    };
    registerRawSignature(getter);
    return () => registerRawSignature(null);
  }, [form, registerRawSignature]);

  /** 用 flushAll 的解析值 + 滑杆值合成候选参数（滑杆未提交也纳入） */
  const mergeDraftTo = (latest: CardioEntry, values: Record<string, number>): CardioParams => {
    const sp = values['cardio.speed'];
    const inc = values['cardio.incline'];
    const lv = values['cardio.level'];
    return {
      ...latest.currentParams,
      ...(typeof sp === 'number' ? { speedKmh: sp } : {}),
      ...(typeof inc === 'number' ? { inclinePct: inc } : {}),
      ...(typeof lv === 'number' ? { level: lv } : {}),
    };
  };

  /**
   * 统一入口：先处理草稿，再对**最新 entry**执行 action。
   * @param unsafeOk 暂停=true：非法草稿也直接执行（不困住封口/保存）
   */
  const withDraft = (
    action: (latest: CardioEntry, session: Session) => Session | null,
    unsafeOk = false,
  ): boolean => {
    const flushed = form.flushAll();
    if (!flushed.ok && unsafeOk) {
      // 暂停：忽略非法草稿直接封口，草稿仍保留可随后修正
      apply(action);
      return true;
    }

    let blocked = false;
    apply((latest, session) => {
      // 草稿非法且不是暂停 → 保持可纠正，不改数据
      if (!flushed.ok) {
        blocked = true;
        setParamError(
          `有氧参数还没输完或不合法：${Object.values(flushed.errors)[0]}。请修正，或点「放弃这次修改」。`,
        );
        setDraftPending(true);
        return null;
      }

      const candidate = mergeDraftTo(latest, flushed.values);
      /**
       * 滑杆未提交值纳入候选 —— 但**必须逐字段只取"与库值不同"的键**。
       *
       * 修复点（G3 复核）：旧实现把整个 slider 对象整块展开覆盖 candidate，
       * 于是"滑杆停在 9、用户刚在精确框把坡度改成 5"时，
       * 滑杆里**过期**的 inclinePct=2 会把 5 盖回去 → 精确输入静默丢失。
       * 现在只让"用户真正动过的滑杆字段"参与，其余保留 candidate（精确框的值）。
       */
      /**
       * **逐字段按意图时序决定胜者**（B3 修复）。
       *
       * 旧实现无条件把滑杆对象展开覆盖，滑杆永远压过精确框。
       * 现在对每个字段：
       *   · 该字段最近意图来自 `precise` → 用 candidate（精确值）**且丢弃**滑杆 pending；
       *   · 该字段最近意图来自 `slider` → 用 slider 值（但仅当与库值不同）；
       *   · 无意图记录 → 用 candidate（保持原语义）。
       */
      const merged: CardioParams = { ...candidate };
      const fields: Array<{
        key: 'speedKmh' | 'inclinePct' | 'level';
        sliderVal: number | undefined;
        baseVal: number | undefined;
      }> = [
        { key: 'speedKmh', sliderVal: slider.speedKmh, baseVal: latest.currentParams.speedKmh },
        { key: 'inclinePct', sliderVal: slider.inclinePct, baseVal: latest.currentParams.inclinePct },
        { key: 'level', sliderVal: slider.level, baseVal: latest.currentParams.level },
      ];
      for (const f of fields) {
        const intent = fieldIntentRef.current[f.key];
        const sliderChanged = f.sliderVal !== undefined && f.sliderVal !== f.baseVal;
        if (intent?.from === 'precise') {
          // 精确意图更新：精确值优先，**不**让滑杆 pending 覆盖
          continue;
        }
        if (intent?.from === 'slider' && sliderChanged) {
          merged[f.key] = f.sliderVal as number;
        }
      }

      let working = latest;
      if (!paramsEqual(merged, latest.currentParams)) {
        const issues = validateCardioParams(latest.preset, merged);
        if (issues.length) {
          blocked = true;
          setParamError(issues[0].message);
          setDraftPending(true);
          /**
           * B3/G3：**被拦后必须回退本地待提交意图**。
           *
           * 真实失败链：未完 `7.` → 拖滑杆 15.5 被拦 → 用户改精确 `7.5` 失焦
           * → 旧实现仍存 15.5，因为滑杆 pending 15.5 一直挂在那里。
           *
           * 现在被拦即把**滑杆本地值回退到库值**并清除该字段意图，
           * 让后续精确输入成为唯一意图来源。
           */
          setSlider((sl) => {
            const reverted = { ...sl };
            if (sl.speedKmh !== latest.currentParams.speedKmh) {
              reverted.speedKmh = latest.currentParams.speedKmh;
              delete fieldIntentRef.current.speedKmh;
            }
            if (sl.inclinePct !== latest.currentParams.inclinePct) {
              reverted.inclinePct = latest.currentParams.inclinePct;
              delete fieldIntentRef.current.inclinePct;
            }
            if (sl.level !== latest.currentParams.level) {
              reverted.level = latest.currentParams.level;
              delete fieldIntentRef.current.level;
            }
            return reverted;
          });
          return null; // 非法：不默用旧值、不落库
        }
        const r = commitCardioParams(latest, merged);
        if (!r.ok) {
          // 达上限：拒绝新段，但两项数据都不改；不困住动作本身
          setParamError(r.reason);
          pushToast(r.reason, 'error');
          return action(latest, session);
        }
        working = r.entry;
      }
      setParamError(null);
      setDraftPending(false);
      return action(working, session);
    });
    return !blocked;
  };

  const startFn = (latest: CardioEntry, session: Session): Session | null => {
    const others = (session.cardio ?? []).filter((c) => c.id !== latest.id && c.status === 'running');
    if (others.length) {
      pushToast('已经有一个有氧在计时，请先暂停或完成它再开始下一个。', 'error');
      return null;
    }
    return withCardioEntry(session, startCardio(latest));
  };
  const resumeFn = (latest: CardioEntry, session: Session): Session | null => {
    const others = (session.cardio ?? []).filter((c) => c.id !== latest.id && c.status === 'running');
    if (others.length) {
      pushToast('已经有一个有氧在计时，请先暂停或完成它再继续。', 'error');
      return null;
    }
    return withCardioEntry(session, resumeCardio(latest));
  };

  /**
   * 只处理草稿、不附带动作：有效草稿提交参数，非法草稿保持可纠错。
   * 父页结束训练与 Panel 自己的按钮共用这一条契约。
   */
  const flushDraft = () => withDraft((l, ss) => withCardioEntry(ss, l));
  /** 稳定登记（用 ref 避免闭包过期） */
  /** 返回 true = 草稿干净并已处理；false = 非法草稿被拦（父页据此不打开结束摘要） */
  const flushRef = useRef(flushDraft);
  flushRef.current = flushDraft;
  useEffect(() => {
    registerFlush?.(entry.id, () => flushRef.current());
    return () => registerFlush?.(entry.id, null);
  }, [registerFlush, entry.id]);

  const discardDraft = () => {
    form.resetAll();
    setSlider(entry.currentParams);
    // 丢弃草稿后基准回到库值，否则拖回原值会被误判重复
    lastCommittedSlider.current = entry.currentParams;
    setParamError(null);
    setDraftPending(false);
  };

  const statusText = done ? '已完成' : running ? '进行中' : entry.status === 'paused' ? '已暂停' : '未开始';

  return (
    <section className="slip" data-testid={`cardio-panel-${entry.id}`}>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span className="h-serif" style={{ fontSize: 17 }}>
            {entry.name}
          </span>
          <span className="mono-label" style={{ fontSize: 11 }}>
            {CARDIO_PRESET_LABEL[entry.preset]}
          </span>
          <span className="tag" style={{ marginLeft: 'auto' }}>
            {statusText}
          </span>
        </div>

        <div
          style={{
            fontFamily: 'var(--f-mono)',
            fontSize: 34,
            fontVariantNumeric: 'tabular-nums',
            marginTop: 8,
            letterSpacing: '0.02em',
          }}
          aria-label={`有氧已用 ${fmtElapsed(live)}`}
          role="timer"
        >
          {fmtElapsed(live)}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
          <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
            {/*
              G3：拖动中必须显示**当前本地选择值**。
              旧实现读 entry.currentParams（已提交值），于是拖动时数字不动，
              松手后才变 —— 用户反馈的"不跟手"。
              slider 在 onChange 已更新，这里直接用它；提交仍只发生在手势结束。
            */}
            {describeCardioParams(entry.preset, slider)}
          </div>
          {/* 分段展开入口：done 后也保留 */}
          <button
            className="btn btn-ghost btn-sm"
            style={{ marginLeft: 'auto', minHeight: 32, fontSize: 12 }}
            onClick={() => setShowSegments((v) => !v)}
          >
            {showSegments ? '收起分段' : `分段 ${entry.segments.length}`}
          </button>
        </div>

        {!done ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {entry.status === 'pending' ? (
              <button className="btn btn-primary btn-sm" disabled={disabled} onClick={() => withDraft(startFn)}>
                开始
              </button>
            ) : running ? (
              <button
                className="btn btn-ghost btn-sm"
                disabled={disabled}
                onClick={() => withDraft((l, ss) => withCardioEntry(ss, pauseCardio(l)), true)}
              >
                暂停
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" disabled={disabled} onClick={() => withDraft(resumeFn)}>
                继续
              </button>
            )}
            <button
              className="btn btn-ghost btn-sm"
              disabled={disabled}
              onClick={() => withDraft((l, ss) => withCardioEntry(ss, completeCardio(l)))}
            >
              完成这项有氧
            </button>
          </div>
        ) : null}

        {showParams ? (
          <div style={{ marginTop: 14 }}>
            <div className="mono-label" style={{ fontSize: 11 }}>
              参数
            </div>

            {isTreadmill ? (
              <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block' }}>
                  <span style={{ display: 'block' }}>速度（km/h）</span>
                  <input
                    type="range"
                    min={MIN_SPEED_KMH}
                    max={MAX_SPEED_KMH}
                    step={0.1}
                    value={slider.speedKmh ?? MIN_SPEED_KMH}
                    disabled={disabled || done}
                    aria-label="速度滑杆"
                    onChange={(e) => {
                      markIntent('speedKmh', 'slider');
                      setSlider((sl) => ({ ...sl, speedKmh: Number(e.target.value) }));
                    }}
                    onPointerUp={commitSliderOnce}
                    onTouchEnd={commitSliderOnce}
                    onKeyUp={commitSliderOnce}
                    onBlur={commitSliderOnce}
                    onPointerCancel={cancelSliderGesture}
                    style={{ width: '100%', minHeight: 32 }}
                  />
                </label>
                <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block' }}>
                  <span style={{ display: 'block' }}>坡度（%）</span>
                  <input
                    type="range"
                    min={MIN_INCLINE_PCT}
                    max={MAX_INCLINE_PCT}
                    step={1}
                    value={slider.inclinePct ?? MIN_INCLINE_PCT}
                    disabled={disabled || done}
                    aria-label="坡度滑杆"
                    onChange={(e) => {
                      markIntent('inclinePct', 'slider');
                      setSlider((sl) => ({ ...sl, inclinePct: Number(e.target.value) }));
                    }}
                    onPointerUp={commitSliderOnce}
                    onTouchEnd={commitSliderOnce}
                    onKeyUp={commitSliderOnce}
                    onBlur={commitSliderOnce}
                    onPointerCancel={cancelSliderGesture}
                    style={{ width: '100%', minHeight: 32 }}
                  />
                </label>
              </div>
            ) : (
              <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginTop: 8 }}>
                <span style={{ display: 'block' }}>器械档位</span>
                <input
                  type="range"
                  min={MIN_STAIR_LEVEL}
                  max={MAX_STAIR_LEVEL}
                  step={1}
                  value={slider.level ?? MIN_STAIR_LEVEL}
                  disabled={disabled || done}
                  aria-label="档位滑杆"
                  onChange={(e) => {
                    markIntent('level', 'slider');
                    setSlider((sl) => ({ ...sl, level: Number(e.target.value) }));
                  }}
                  onPointerUp={commitSliderOnce}
                  onTouchEnd={commitSliderOnce}
                  onKeyUp={commitSliderOnce}
                  onBlur={commitSliderOnce}
                  onPointerCancel={cancelSliderGesture}
                  style={{ width: '100%', minHeight: 32 }}
                />
              </label>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8, marginTop: 8 }}>
              {isTreadmill ? (
                <>
                  <DraftNumberField
                    label="速度精确值"
                    onInputIntent={() => markIntent('speedKmh', 'precise')}
                    persistedValue={entry.currentParams.speedKmh ?? 0}
                    value={slider.speedKmh ?? 0}
                    min={MIN_SPEED_KMH}
                    max={MAX_SPEED_KMH}
                    integer={false}
                    unit="km/h"
                    disabled={disabled || done}
                    form={form}
                    fieldId="cardio.speed"
                    onCommit={() => {
                      withDraft((l, ss) => withCardioEntry(ss, l));
                    }}
                  />
                  <DraftNumberField
                    label="坡度精确值"
                    onInputIntent={() => markIntent('inclinePct', 'precise')}
                    persistedValue={entry.currentParams.inclinePct ?? 0}
                    value={slider.inclinePct ?? 0}
                    min={MIN_INCLINE_PCT}
                    max={MAX_INCLINE_PCT}
                    integer={false}
                    unit="%"
                    disabled={disabled || done}
                    form={form}
                    fieldId="cardio.incline"
                    onCommit={() => {
                      withDraft((l, ss) => withCardioEntry(ss, l));
                    }}
                  />
                </>
              ) : (
                <DraftNumberField
                  label="档位精确值"
                  onInputIntent={() => markIntent('level', 'precise')}
                    persistedValue={entry.currentParams.level ?? MIN_STAIR_LEVEL}
                  value={slider.level ?? MIN_STAIR_LEVEL}
                  min={MIN_STAIR_LEVEL}
                  max={MAX_STAIR_LEVEL}
                  unit="档"
                  disabled={disabled || done}
                  form={form}
                  fieldId="cardio.level"
                  onCommit={() => {
                      withDraft((l, ss) => withCardioEntry(ss, l));
                    }}
                />
              )}
            </div>

            {paramError ? (
              <div role="alert" style={{ color: 'var(--brick)', fontSize: 12.5, marginTop: 6 }}>
                {paramError}
              </div>
            ) : null}
            {draftPending ? (
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={discardDraft}>
                放弃这次修改
              </button>
            ) : null}
            {!done ? (
              <p style={{ fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.6, marginTop: 8, marginBottom: 0 }}>
                改参数不会重置计时；只有参数真正变化时才记录新的一段。
              </p>
            ) : null}
          </div>
        ) : null}

        {showSegments && entry.segments.length ? (
          <div style={{ marginTop: 10 }}>
            <div className="mono-label" style={{ fontSize: 11, marginBottom: 4 }}>
              分段记录
            </div>
            {entry.segments.map((seg) => (
              <div
                key={seg.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 8,
                  fontSize: 12.5,
                  padding: '4px 0',
                  borderBottom: '1px dashed var(--rule)',
                  color: 'var(--ink-2)',
                }}
              >
                <span style={{ fontFamily: 'var(--f-mono)' }}>
                  {fmtElapsed(seg.startElapsedMs)} –{' '}
                  {seg.endElapsedMs === null ? '进行中' : fmtElapsed(seg.endElapsedMs)}
                </span>
                <span style={{ textAlign: 'right' }}>
                  {describeCardioParams(entry.preset, seg.params)}
                  <span style={{ color: 'var(--ink-4)' }}> · {fmtCountdown(segmentDurationMs(seg, live))}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
