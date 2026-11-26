/* 组间休息计时。
   ── 关键约束（修复 R2-01）────────────────────────────────────
   计时刻度（每 250ms）只在 <RestTimerBar> 内部维护，不通过 hook 向上冒泡，
   否则整个训练页会以 4Hz 重渲染，输入框在其中容易被抢焦点 / 打断 IME。
   hook 只保存「结束时间戳」这类低频状态，父组件仅在有操作时重渲染。
   剩余时间基于绝对时间戳计算，切后台回来仍正确（不依赖 setInterval 累加）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtCountdown } from '../lib/format';
import {
  cancelRestReminder,
  getActiveRest,
  inspectRestIdentity,
  newRestToken,
  scheduleRestReminder,
  type RestScheduleOrigin,
} from '../lib/restReminder';
import { RestScheduleController } from '../lib/restSchedule';
import {
  clearRestTimerSnapshot,
  decideRestore,
  loadRestTimerSnapshot,
  saveRestTimerSnapshot,
  type RestTimerSource,
} from '../lib/restTimerSnapshot';
import {
  clearDurableRestTimer,
  clearDurableRestTimerIfMatches,
  loadDurableRestTimer,
  reconcileRestTimerRecovery,
  saveDurableRestTimer,
  syncLoadDurableRestTimerLs,
  type DurableRestTimerRecord,
} from '../lib/restTimerDurable';
import { readMainRestoreEpoch } from '../db/idb';

export interface RestTimerApi {
  /** 当前是否在计时（含暂停态） */
  active: boolean;
  /** 结束时间戳；null 表示未启动 */
  endsAt: number | null;
  /** 暂停时冻结的剩余毫秒 */
  pausedRemaining: number | null;
  /** 本次休息的唯一 token（原生去重与身份核验用） */
  token: string | null;
  /** G3A1：当前休息归属（未知旧快照为 null） */
  source?: RestTimerSource | null;
  /**
   * 是否还有**未完成的原生取消责任**（B4-R3 F2）。
   *
   * <p>为 true 表示：用户已经暂停/停止，但原生按身份取消**失败**（例如写盘失败，
   * 身份与 alarm 被正确保留）。此时界面不能假装"已经停了" —— 提醒仍可能响，
   * 必须如实提示并给出可重试入口。
   */
  cancelPending: boolean;
  /** 最近一次取消失败的短原因；无失败为 null */
  cancelErrorReason: string | null;
  /**
   * 是否存在**已确认失败**的取消（区别于"正在取消"）。
   *
   * <p>UI 只在这个为 true 时才提示"取消未完成 + 重试"，
   * 避免刚点暂停（请求在途）就闪错误。
   */
  cancelFailed: boolean;
  start: (
    sec: number,
    source?: RestTimerSource,
    opts?: {
      token?: string;
      deadlineAtMs?: number;
      coachOperationId?: string;
      restoreEpoch?: number;
    },
  ) => void;
  pause: () => void;
  resume: () => void;
  adjust: (deltaSec: number) => void;
  stop: () => void;
  /** 手动重试未完成的精确取消（只按登记的原始身份，不会误伤新计时） */
  retryCancel: () => void;
}

export function useRestTimer(
  defaultSec: number,
  /**
   * 归属的训练实例 ID。传入后计时会按 session 持久化，
   * 页面重建（切后台被回收 / 重新进入）可恢复（BRIEF 第2项）。
   */
  sessionId?: string,
  /**
   * G3A2：已知 source 是否仍存在于当前训练（重建时精确清理幽灵归属）。
   * 返回 false 表示快照 source 指向的目标已删除 → 不恢复该计时并清理快照。
   */
  hasSource?: (source: RestTimerSource) => boolean,
): RestTimerApi {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [pausedRemaining, setPausedRemaining] = useState<number | null>(null);
  /** 本次休息的身份：原生提醒与页面状态共用同一个 token */
  const [token, setToken] = useState<string | null>(null);
  const [source, setSource] = useState<RestTimerSource | null>(null);
  const sourceRef = useRef<RestTimerSource | null>(null);
  const defaultRef = useRef(defaultSec);
  defaultRef.current = defaultSec;
  /** 当前 token 的同步镜像：供 async 回调读到最新值（避免闭包过期） */
  const tokenRef = useRef<string | null>(null);
  /** 当前代次：由控制器在响应归属判定后提交，取消/消费必须带上 */
  const genRef = useRef<number>(0);
  /**
   * B4-R3 F2：未完成的**原生取消责任**镜像。
   *
   * <p>控制器的责任表是权威事实，但它是同步 getter、不会触发 React 渲染。
   * 这里用一个轻量 tick 把"责任数量/失败原因"反映到界面，
   * 让"暂停了但原生取消失败"不再是静默现象。
   */
  const [cancelDutyTick, setCancelDutyTick] = useState(0);
  const bumpCancelDuty = useCallback(() => setCancelDutyTick((n) => n + 1), []);
  /** sessionId 的同步镜像（供回调读取最新值） */
  const sessionRef = useRef<string | undefined>(sessionId);
  sessionRef.current = sessionId;
  const hasSourceRef = useRef(hasSource);
  hasSourceRef.current = hasSource;
  const nativeScheduledRef = useRef<boolean>(false);
  const restoreEpochRef = useRef<number>(0);
  const coachOperationIdRef = useRef<string | undefined>(undefined);
  const userActionSeqRef = useRef<number>(0);

  /**
   * 排程协调器：负责异步响应的归属、迟到补偿与代次提交（REVIEW-1 #2）。
   * 用 ref 持有，保证整个页面实例只有一份。
   */
  /** 最近一次写入快照的输入（onCommit 回写时需要复用同样的 endsAt/paused/status） */
  const lastPersistRef = useRef<{
    token: string;
    status: 'running' | 'paused';
    endsAt: number | null;
    pausedRemaining: number | null;
  } | null>(null);

  /**
   * 原生确认排程成功 → **立刻把代次回写进快照**（REVIEW-2 #1 断点一）。
   *
   * start() 写快照时原生还没回，generation 只能是 null；
   * 若不在 ack 后回写，快照永久停在 null，重建后无凭据可取消原生提醒
   * （真实 Chrome 链路已复现该失败）。
   */
  /**
   * 当前实例的**实时状态镜像**（用于 ack 回写时判断真实 UI 状态）。
   *
   * REVIEW-3 #1 指出：旧组件（或本次休息已被暂停/取代）的迟到 ack
   * 不能把**新组件已暂停**的同 token 快照回写成 running。
   * 因此回写必须基于"此刻真实的 UI 状态"，而不是某次 persist 的历史快照。
   */
  const liveStateRef = useRef<{
    token: string | null;
    status: 'running' | 'paused';
    endsAt: number | null;
    pausedRemaining: number | null;
  }>({ token: null, status: 'running', endsAt: null, pausedRemaining: null });

  const onScheduleCommitted = useCallback(
    (committedToken: string, generation: number) => {
      /**
       * REVIEW-4 #1：**旧实例卸载后必须真正失效回写**。
       *
       * 旧实现只比较本实例自己的 liveStateRef —— 它永远认为自己在 running，
       * 根本不知道新页面已经 paused，于是迟到的 ack 会把真实快照改回 running。
       * 这里用 controller 的 disposed 门禁（组件卸载时置位）阻断旧实例回写；
       * 注意**只阻断回写，不取消原生提醒**（提醒可能正被新页面接管）。
       */
      if (controller.isDisposed) return;
      const sid = sessionRef.current;
      if (!sid) return;
      // 只处理「当前这次休息」：旧 token 的迟到 ack 一律忽略
      if (tokenRef.current !== committedToken) return;
      const live = liveStateRef.current;
      if (live.token !== committedToken) return;
      /**
       * 关键：ack 只补 generation，**不改写 status**。
       * 若此刻已暂停，就保持 paused（不能回写成 running）。
       */
      genRef.current = generation;
      nativeScheduledRef.current = true;
      saveRestTimerSnapshot({
        sessionId: sid,
        token: committedToken,
        source: sourceRef.current,
        generation,
        intentWatermark: intentSeqRef.current,
        endsAt: live.status === 'running' ? live.endsAt : null,
        pausedRemaining: live.status === 'paused' ? live.pausedRemaining : null,
        status: live.status,
      });
      void saveDurableRestTimer({
        v: 1,
        sessionId: sid,
        token: committedToken,
        source: sourceRef.current,
        generation,
        intentWatermark: intentSeqRef.current,
        endsAt: live.status === 'running' ? live.endsAt : null,
        pausedRemaining: live.status === 'paused' ? live.pausedRemaining : null,
        status: live.status,
        savedAt: Date.now(),
        restoreEpoch: restoreEpochRef.current,
        ...(coachOperationIdRef.current ? { coachOperationId: coachOperationIdRef.current } : {}),
        nativeScheduled: true,
      });
    },
    [],
  );

  /**
   * 最近一次**用户操作**的来源（A3 #3）。
   *
   * 只有 start / resume / 非零用户调整会写 user-*；自动恢复与 adopt 保持非 user，
   * 因此不会给原生"偷偷启动前台服务"的许可。
   */
  const pendingOriginRef = useRef<RestScheduleOrigin>('query');
  /**
   * B4-R2 优先级一 #3：**明确用户新意图**的单调递增编号。
   *
   * 只有"用户真的点了动作"（开始/继续/+15）才 +1；
   * 自动恢复、adopt、核对查询都不推进 —— 它们必须保持原生的
   * already-fired 门禁，否则旧请求重放会重新响铃。
   */
  const intentSeqRef = useRef(0);
  const nextIntentId = (): number => {
    intentSeqRef.current += 1;
    return intentSeqRef.current;
  };
  const controllerRef = useRef<RestScheduleController | null>(null);
  /** onCommit 的 ref 间接层：控制器在首次渲染前就要构造，此时 callback 尚未定义 */
  const onCommitRef = useRef<((token: string, generation: number) => void) | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new RestScheduleController(
      {
        // origin 由每次 arm 的意图决定（见 armWithOrigin）；默认保守为 query
        /**
         * B4-R2 优先级一 #1：把**发起目标截止**一起送进原生。
         *
         * 旧实现只送 remainingMs，原生在自己的执行时刻重新 now+remainingMs，
         * 于是桥接排队耗时被加进休息时长 → "UI 归零了、过一会才响"。
         */
        schedule: (t, ms, deadlineAtMs, intentId) =>
          scheduleRestReminder(t, ms, pendingOriginRef.current, deadlineAtMs, intentId),
        cancel: (identity) => cancelRestReminder(identity),
        getActive: () => getActiveRest(),
        inspectIdentity: (identity) => inspectRestIdentity(identity),
      },
      (t, g) => onCommitRef.current?.(t, g),
      /**
       * B4-R3 closure · F2 可见状态：责任表变化即刷新。
       *
       * <p>旧实现只在 pause/stop 后挂一个 microtask，于是**晚 ACK 的失败**、
       * stop 之后的 inactive、会话切换等路径都不会再刷新，失败被静默。
       * 现在由控制器在每次登记/失败/清理时回调，UI 与真实责任保持同步。
       */
      () => bumpCancelDuty(),
      /**
       * B4-R3 closure · 水位对齐：原生每次排程都会回报当前水位。
       * 把它抬进内存序号，**不依赖**异步 getActive 是否已返回 ——
       * 这样旧 v1 快照（没有水位）在查询晚到时也不会拿落后编号去排程；
       * 万一仍被拒（stale-intent），controller 会用回报水位重发一次。
       */
      (lastIntentId) => {
        if (controllerRef.current?.isDisposed) return;
        if (Number.isFinite(lastIntentId) && lastIntentId > intentSeqRef.current) {
          intentSeqRef.current = Math.floor(lastIntentId);
        }
      },
    );
  }
  const controller = controllerRef.current;
  onCommitRef.current = onScheduleCommitted;

  /** 把当前状态写入快照（页面重建后恢复用） */
  const persist = useCallback((snap: {
    token: string | null;
    status: 'running' | 'paused';
    endsAt: number | null;
    pausedRemaining: number | null;
  }, opts?: { fromMountRestore?: boolean }) => {
    if (!opts?.fromMountRestore) {
      userActionSeqRef.current += 1;
    }
    // 先更新实时镜像（ack 回写要用它判断此刻真实状态）
    liveStateRef.current = {
      token: snap.token,
      status: snap.status,
      endsAt: snap.endsAt,
      pausedRemaining: snap.pausedRemaining,
    };
    const sid = sessionRef.current;
    if (!sid) return;
    if (!snap.token) {
      lastPersistRef.current = null;
      nativeScheduledRef.current = false;
      coachOperationIdRef.current = undefined;
      clearRestTimerSnapshot(sid);
      void clearDurableRestTimer(sid);
      return;
    }
    lastPersistRef.current = {
      token: snap.token,
      status: snap.status,
      endsAt: snap.endsAt,
      pausedRemaining: snap.pausedRemaining,
    };
    saveRestTimerSnapshot({
      sessionId: sid,
      token: snap.token,
      source: sourceRef.current,
      generation: controller.snapshot.generation,
      /**
       * B4-R3 closure · 重挂连续性：**水位随快照持久化**。
       *
       * 组件重挂会把内存里的 intentSeqRef 归零；不落水位的话，
       * 恢复后第一次 +15 会带 ≤ 原生水位的编号被拒，
       * 于是「界面已延长、原生按旧截止」（dev/prod 实测 75s vs 60s）。
       */
      intentWatermark: intentSeqRef.current,
      endsAt: snap.endsAt,
      pausedRemaining: snap.pausedRemaining,
      status: snap.status,
    });
    void saveDurableRestTimer({
      v: 1,
      sessionId: sid,
      token: snap.token,
      source: sourceRef.current,
      generation: controller.snapshot.generation,
      intentWatermark: intentSeqRef.current,
      endsAt: snap.endsAt,
      pausedRemaining: snap.pausedRemaining,
      status: snap.status,
      savedAt: Date.now(),
      restoreEpoch: restoreEpochRef.current,
      ...(coachOperationIdRef.current ? { coachOperationId: coachOperationIdRef.current } : {}),
      nativeScheduled: nativeScheduledRef.current,
    });
  }, [controller]);

  const start = useCallback(
    (
      sec?: number,
      nextSource?: RestTimerSource,
      opts?: {
        token?: string;
        deadlineAtMs?: number;
        coachOperationId?: string;
        restoreEpoch?: number;
      },
    ) => {
      sourceRef.current = nextSource ?? null;
      setSource(nextSource ?? null);
      pendingOriginRef.current = 'user-start';
      const nextToken = opts?.token || newRestToken();
      const clickNow = Date.now();
      const targetDeadline =
        typeof opts?.deadlineAtMs === 'number' && Number.isFinite(opts.deadlineAtMs)
          ? opts.deadlineAtMs
          : clickNow + Math.max(0, (sec ?? defaultRef.current) * 1000);
      const ms =
        opts?.deadlineAtMs !== undefined
          ? Math.max(0, targetDeadline - clickNow)
          : Math.max(0, (sec ?? defaultRef.current) * 1000);
      nativeScheduledRef.current = false;
      coachOperationIdRef.current = opts?.coachOperationId;
      if (typeof opts?.restoreEpoch === 'number' && Number.isFinite(opts.restoreEpoch)) {
        restoreEpochRef.current = opts.restoreEpoch;
      } else {
        void readMainRestoreEpoch().then((ep) => {
          if (ep !== null && tokenRef.current === nextToken) restoreEpochRef.current = ep;
        });
      }
      tokenRef.current = nextToken;
      setToken(nextToken);
      setPausedRemaining(null);

      controller.arm(nextToken, ms, targetDeadline, ms > 0 ? nextIntentId() : 0);

      if (ms <= 0) {
        // 归零：UI 上不显示计时
        setEndsAt(null);
        tokenRef.current = null;
        setToken(null);
        genRef.current = 0;
        sourceRef.current = null;
        setSource(null);
        persist({ token: null, status: 'running', endsAt: null, pausedRemaining: null });
        return;
      }

      // 与交给原生的 deadline 用**同一个** targetDeadline，UI 与原生不产生分叉
      const nextEndsAt = targetDeadline;
      setEndsAt(nextEndsAt);
      persist({ token: nextToken, status: 'running', endsAt: nextEndsAt, pausedRemaining: null });
    },
    [controller, persist],
  );

  const pause = useCallback(() => {
    const prev = liveStateRef.current.endsAt;
    if (prev === null) return;
    const remaining = Math.max(0, prev - Date.now());
    setPausedRemaining(remaining);
    setEndsAt(null);
    // 暂停：协调器按身份取消（响应在途时由迟到补偿兜底，REVIEW-1 #2）
    /**
     * A4 #2：**删除**这里的 reason-only stop。
     *
     * <p>实证可达序列：FGS 运行中 → cancel 的身份 commit 失败 →
     * Plugin.cancel=false（正确保留身份/alarm/FGS）→ 但真实 hook 仍调用
     * 无身份的 stopForegroundTimer('paused') → 该入口无条件停 FGS 并放锁。
     * 于是"取消失败"反而把服务停了，与"正确保留"矛盾。
     *
     * <p>现在只让**统一 native cancel 的 durable + 身份结果**决定收束：
     * disarm(false) 按身份取消；Plugin.cancel 在真正 durable 成功时才停匹配服务。
     */
    controller.disarm(false);
    // F2：取消结果异步返回；无论成功还是失败都要刷新"责任"镜像
    void Promise.resolve().then(bumpCancelDuty);
    const t = tokenRef.current;
    persist({
      token: t,
      status: 'paused',
      endsAt: null,
      pausedRemaining: remaining,
    });
  }, [controller, persist, bumpCancelDuty]);

  const resume = useCallback(() => {
    const prev = liveStateRef.current.pausedRemaining;
    if (prev === null) return;
    const resumeNow = Date.now();
    const nextEndsAt = resumeNow + prev;
    setEndsAt(nextEndsAt);
    setPausedRemaining(null);
    const t = tokenRef.current;
    pendingOriginRef.current = 'user-resume';
    if (t && prev > 0) {
      // 继续：同一 token 重排（协调器推进意图，旧响应不会污染）
      // B4-R2：携带点击时刻的绝对截止，原生不得再重新 now+remainingMs
      controller.arm(t, prev, nextEndsAt, nextIntentId());
    }
    persist({ token: t, status: 'running', endsAt: nextEndsAt, pausedRemaining: null });
  }, [controller, persist]);

  /**
   * 加减时间。
   *
   * ── 截止时间基准（修复 G1：归零后 +15 只剩 12/7 秒或计时条消失）──────
   * 旧实现：`Math.max(Date.now(), prev + deltaSec * 1000)` —— `prev` 是**旧截止时刻**。
   * 到期后界面只把显示剩余夹到 0，并没有把截止时间推到"现在"，于是：
   *   · 过期 d 秒再 +15 → 截止 = 旧 endsAt+15 = 现在 + (15-d)，只剩 max(0, 15-d) 秒；
   *   · d ≥ 15 → 剩余算成 0 → 走归零分支清 token/快照，计时条消失；
   *   · 真实 Controller 经 JS 桥送出的 remainingMs 同样缩短（12000/7000），
   *     过期较久则取消旧提醒且不再排新的 —— 后台提醒跟着一起丢。
   *
   * 现在的规则（与用户确认的接受标准一致）：
   *   · **仍有余量**（运行中未到点）→ 当前余量 + delta，等价于旧截止 + delta；
   *   · **已归零/已过期**（余量 ≤ 0）→ 从**点按当时**重新给完整 delta 秒；
   *   · **暂停态** → 只改冻结余量，保持暂停，不排闹钟（继续时统一按余量排）。
   * 减法（−15）在归零后不会把剩余算成负数并清掉计时条，最少夹到 0 仍保持 active，
   * 让用户还能继续 +15 或跳过。
   */
  const adjust = useCallback((deltaSec: number) => {
    const current = liveStateRef.current;
    if (current.pausedRemaining !== null) {
      const nextRemaining = Math.max(0, current.pausedRemaining + deltaSec * 1000);
      setPausedRemaining(nextRemaining);
      // 暂停态调整：不排闹钟，恢复时统一按剩余时间排
      const t = tokenRef.current;
      persist({
        token: t,
        status: 'paused',
        endsAt: null,
        pausedRemaining: nextRemaining,
      });
      return;
    }
    const prev = current.endsAt;
    if (prev === null) return;
    const now = Date.now();
    const currentRemaining = Math.max(0, prev - now);
    /**
     * 关键：以**当前真实余量**为基准，而不是旧的绝对截止时刻。
     * 已到期时 currentRemaining=0 → 基准退化为 now，于是给出完整 delta 秒。
     */
    const nextRemaining = currentRemaining + deltaSec * 1000;
    const t = tokenRef.current;
    if (!t) {
      // 没有 token（理论上不该出现）：只更新界面余量，不碰原生
      const nextEndsAt = nextRemaining > 0 ? now + nextRemaining : prev;
      setEndsAt(nextEndsAt);
      persist({ token: null, status: 'running', endsAt: nextEndsAt, pausedRemaining: null });
      return;
    }
    if (nextRemaining > 0) {
      const nextEndsAt = now + nextRemaining;
      // 正负非零的显式调整来自用户点击；零调整保留保守 query 来源。
      pendingOriginRef.current = deltaSec === 0 ? 'query' : 'user-adjust';
      /**
       * B4-R2：±15 同样必须携带**本次点击算出的绝对截止**。
       * 否则"减 15"这类用户操作也会被排队耗时抵消掉一部分，
       * 表现就是"±15 与实际不符"。
       */
      /**
       * B4-R2：**只有正加时**才是"用户明确要求更多可投递时间"的新意图。
       * −15 不放宽已 fired 门禁（减时间不该让已响过的提醒再响一次）。
       */
      controller.arm(t, nextRemaining, nextEndsAt, deltaSec > 0 ? nextIntentId() : 0);
      setEndsAt(nextEndsAt);
      persist({ token: t, status: 'running', endsAt: nextEndsAt, pausedRemaining: null });
      return;
    }
    /**
     * 减到 0 及以下：保持 active（计时条不消失），只是剩余为 0，
     * 让用户能继续 +15 或跳过。原生提醒按身份取消（不排新的）。
     * 旧实现在这里清 token/快照并 return null → 计时条消失，正是 G1 的"消失"。
     */
    controller.arm(t, 0);
    const frozenEndsAt = now;
    setEndsAt(frozenEndsAt);
    persist({ token: t, status: 'running', endsAt: frozenEndsAt, pausedRemaining: null });
  }, [controller, persist]);

  const stop = useCallback(() => {
    setEndsAt(null);
    setPausedRemaining(null);
    tokenRef.current = null;
    setToken(null);
    sourceRef.current = null;
    setSource(null);
    genRef.current = 0;
    // 跳过/结束：显式全清（不带身份），旧 token 凭据随即失效
    /**
     * A4 #2：显式全清仍由这条**明确 cancel(full-clear)** 路径处理
     * （disarm(true) → 无身份全清 → Plugin.cancel durable 成功后停服务）。
     * 不再额外发无身份 stop，避免第二个旁路。
     */
    controller.disarm(true);
    void Promise.resolve().then(bumpCancelDuty);
    persist({ token: null, status: 'running', endsAt: null, pausedRemaining: null });
  }, [controller, persist, bumpCancelDuty]);

  /**
   * Wave 1B.2：用户在系统持续通知栏点击「取消」后的前后台对账收口。
   *
   * 仅当当前处于 running 态且原生按精确 (token, generation) 确认 `cancelled_by_user` 时，
   * 静默收起页面计时条并清理快照（不再补发冗余 cancel IPC，不闪「提醒未取消」横幅）。
   */
  const reconcileUserCancel = useCallback(async () => {
    if (controller.isDisposed) return;
    const tokBefore = tokenRef.current;
    if (!tokBefore || liveStateRef.current.status !== 'running') return;
    const outcome = await controller.reconcileForeground();
    if (outcome !== 'cancelled_by_user') return;
    if (
      controller.isDisposed ||
      tokenRef.current !== tokBefore ||
      liveStateRef.current.status !== 'running'
    ) {
      return;
    }
    setEndsAt(null);
    setPausedRemaining(null);
    tokenRef.current = null;
    setToken(null);
    sourceRef.current = null;
    setSource(null);
    genRef.current = 0;
    persist({ token: null, status: 'running', endsAt: null, pausedRemaining: null });
    bumpCancelDuty();
  }, [controller, persist, bumpCancelDuty]);

  /**
   * 重建恢复（BRIEF 第2项）。
   *
   * 只在**首次挂载**执行一次；恢复后：
   * · running 且未到点 → 恢复 UI 与 token，**不重排原生**（原生闹钟本就在，重复排会双提醒）；
   * · 已到点 → 不恢复、不提醒（避免迟到提醒），清理快照；
   * · paused → 恢复暂停态，不排原生。
   */
  /**
   * 已绑定的训练实例（REVIEW-2 收尾 P2）。
   *
   * 旧实现用 `restoredRef` 只跑一次：同一组件实例的 sessionId 从 A 变 B 时
   * 不会重新绑定 → 仍显示 A 的计时，随后 pause 还会把 A 的 token 写进 B 的快照
   * （跨训练污染）。现在按 sessionId 变化重新绑定：
   *   · 先把旧实例的计时清空（不写入新实例快照）；
   *   · 再按新实例的快照恢复。
   */
  const boundSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const sid = sessionRef.current;
    /**
     * REVIEW-4 / StrictMode：同 sessionId 的重放也要**重新接管**。
     *
     * 旧逻辑在这里直接 return，于是 StrictMode 的 cleanup→setup 之后
     * controller 归属没有被重新建立（恢复快照的路径会失效）。
     * 现在：仅当「同 sessionId 且 controller 仍持有当前意图」时才跳过；
     * 否则继续走下面的恢复/接管逻辑（幂等，不会重复排程）。
     */
    let cancelled = false;
    const mountActionSeq = userActionSeqRef.current;
    const cleanup = () => {
      cancelled = true;
    };
    const sameSession = boundSessionRef.current === sid;
    const controllerHoldsIntent =
      controller.snapshot.active && controller.snapshot.token === tokenRef.current;
    if (sameSession && controllerHoldsIntent) return cleanup;
    const prevSid = boundSessionRef.current;
    boundSessionRef.current = sid;

    /**
     * 切换训练实例：清空本实例的计时状态与控制器归属。
     * 注意**不清除**旧实例的快照（它属于旧训练，可能之后还要恢复），
     * 只清本组件内存态，避免把 A 的 token 写进 B。
     */
    if (prevSid !== undefined && prevSid !== sid) {
      // 仅真正切换训练实例时才清空归属
      tokenRef.current = null;
      setToken(null);
      setEndsAt(null);
      setPausedRemaining(null);
      genRef.current = 0;
      sourceRef.current = null;
      setSource(null);
      lastPersistRef.current = null;
      liveStateRef.current = { token: null, status: 'running', endsAt: null, pausedRemaining: null };
      // 旧实例的原生提醒不应由新实例的控制器持有（只清内存归属，不碰原生与旧快照）
      controller.reset();
    }
    if (!sid) return cleanup;
    const syncDurableFallback = (): DurableRestTimerRecord | null => syncLoadDurableRestTimerLs(sid);
    const durableFromLs = syncDurableFallback();
    const snap =
      loadRestTimerSnapshot(sid) ??
      (durableFromLs
        ? {
            v: 1 as const,
            sessionId: durableFromLs.sessionId,
            token: durableFromLs.token,
            generation: durableFromLs.generation,
            source: durableFromLs.source,
            endsAt: durableFromLs.endsAt,
            pausedRemaining: durableFromLs.pausedRemaining,
            status: durableFromLs.status,
            intentWatermark: durableFromLs.intentWatermark,
            savedAt: durableFromLs.savedAt,
          }
        : null);
    if (durableFromLs) {
      restoreEpochRef.current = durableFromLs.restoreEpoch;
      coachOperationIdRef.current = durableFromLs.coachOperationId;
      nativeScheduledRef.current = durableFromLs.nativeScheduled ?? durableFromLs.generation !== null;
    }

    const restoreFromDurableAsync = async () => {
      try {
        const [durableRec, mainEpoch, nativeInfo] = await Promise.all([
          loadDurableRestTimer(sid),
          readMainRestoreEpoch(),
          getActiveRest().catch(() => null),
        ]);
        if (
          cancelled ||
          controller.isDisposed ||
          sessionRef.current !== sid ||
          userActionSeqRef.current !== mountActionSeq
        ) {
          return;
        }
        const recovery = reconcileRestTimerRecovery({
          record: durableRec,
          nativeActive: nativeInfo
            ? {
                ...nativeInfo,
                token: nativeInfo.token ?? undefined,
              }
            : null,
          currentRestoreEpoch: mainEpoch ?? undefined,
        });
        if (recovery.kind === 'stale-epoch' || recovery.kind === 'expired') {
          if (durableRec && tokenRef.current === durableRec.token) {
            tokenRef.current = null;
            setToken(null);
            setEndsAt(null);
            setPausedRemaining(null);
            sourceRef.current = null;
            setSource(null);
            liveStateRef.current = { token: null, status: 'running', endsAt: null, pausedRemaining: null };
          }
          if (durableRec) {
            const snapCur = loadRestTimerSnapshot(sid);
            if (!snapCur || snapCur.token === durableRec.token) {
              clearRestTimerSnapshot(sid);
            }
            if (
              nativeInfo?.active &&
              nativeInfo.token === durableRec.token &&
              typeof (nativeInfo.generation ?? durableRec.generation) === 'number'
            ) {
              void cancelRestReminder({
                token: durableRec.token,
                generation: nativeInfo.generation ?? durableRec.generation ?? 0,
              }).catch(() => {});
            }
            await clearDurableRestTimerIfMatches(sid, {
              token: durableRec.token,
              restoreEpoch: durableRec.restoreEpoch,
            });
          }
          return;
        }
        if (recovery.kind === 'none') return;
        if (tokenRef.current !== null && tokenRef.current !== recovery.record.token) return;
        const checkSrc = hasSourceRef.current;
        if (recovery.record.source && checkSrc && !checkSrc(recovery.record.source)) {
          await clearDurableRestTimerIfMatches(sid, {
            token: recovery.record.token,
            restoreEpoch: recovery.record.restoreEpoch,
          });
          return;
        }
        if (tokenRef.current === null) {
          tokenRef.current = recovery.record.token;
          setToken(recovery.record.token);
          sourceRef.current = recovery.record.source;
          setSource(recovery.record.source);
          genRef.current = recovery.record.generation ?? 0;
          restoreEpochRef.current = recovery.record.restoreEpoch;
          coachOperationIdRef.current = recovery.record.coachOperationId;
          nativeScheduledRef.current = recovery.record.nativeScheduled ?? false;
          if (recovery.kind === 'restore-paused') {
            liveStateRef.current = {
              token: recovery.record.token,
              status: 'paused',
              endsAt: null,
              pausedRemaining: recovery.pausedRemaining,
            };
            controller.adopt(recovery.record.token, recovery.record.generation);
            setEndsAt(null);
            setPausedRemaining(recovery.pausedRemaining);
            persist(
              {
                token: recovery.record.token,
                status: 'paused',
                endsAt: null,
                pausedRemaining: recovery.pausedRemaining,
              },
              { fromMountRestore: true },
            );
          } else if (recovery.kind === 'schedule-pending-native') {
            liveStateRef.current = {
              token: recovery.record.token,
              status: 'running',
              endsAt: recovery.endsAt,
              pausedRemaining: null,
            };
            pendingOriginRef.current = 'snapshot-restore';
            controller.arm(recovery.record.token, recovery.remainingMs, recovery.endsAt, nextIntentId());
            setEndsAt(recovery.endsAt);
            setPausedRemaining(null);
            persist(
              {
                token: recovery.record.token,
                status: 'running',
                endsAt: recovery.endsAt,
                pausedRemaining: null,
              },
              { fromMountRestore: true },
            );
          } else if (recovery.kind === 'adopt-native' || recovery.kind === 'restore-running') {
            liveStateRef.current = {
              token: recovery.record.token,
              status: 'running',
              endsAt: recovery.endsAt,
              pausedRemaining: null,
            };
            pendingOriginRef.current = 'snapshot-restore';
            controller.adopt(
              recovery.record.token,
              recovery.kind === 'adopt-native' ? recovery.generation : recovery.record.generation,
            );
            setEndsAt(recovery.endsAt);
            setPausedRemaining(null);
            persist(
              {
                token: recovery.record.token,
                status: 'running',
                endsAt: recovery.endsAt,
                pausedRemaining: null,
              },
              { fromMountRestore: true },
            );
          }
        }
      } catch {
        /* fallback safely */
      }
    };

    const decision = decideRestore(snap);
    if (decision.kind === 'none') {
      void restoreFromDurableAsync();
      return () => {
        cancelled = true;
      };
    }
    if (decision.kind === 'expired') {
      const expiredToken = snap?.token;
      clearRestTimerSnapshot(sid);
      void clearDurableRestTimerIfMatches(sid, {
        token: expiredToken,
      }).finally(() => {
        if (
          !cancelled &&
          !controller.isDisposed &&
          sessionRef.current === sid &&
          userActionSeqRef.current === mountActionSeq
        ) {
          void restoreFromDurableAsync();
        }
      });
      return () => {
        cancelled = true;
      };
    }
    if (!snap) {
      return () => {
        cancelled = true;
      };
    }
    void restoreFromDurableAsync();
    /**
     * G3A2：已知 source 但目标已不存在 → 精确清理，不恢复幽灵计时。
     * 旧快照 source 缺失（unknown）保持原兼容策略：照常恢复，由 UI 提示归属未知。
     */
    const src = snap.source ?? null;
    const checkSource = hasSourceRef.current;
    if (src && checkSource && !checkSource(src)) {
      /**
       * G3A2-FIX1：已知 source 但目标已被删除（T02 阻断项）。
       *
       * 只清快照会让原生闹钟继续存在 —— 必须通过既有 controller
       * **按精确身份**取消；generation 未知时先接管再核对，由迟到补偿补取消，
       * 失败责任保留可见并可 retryCancel，绝不无身份全清（会误伤其他计时）。
       */
      if (snap.generation !== null) {
        controller.adopt(snap.token, snap.generation);
        controller.disarm(false);
      } else {
        controller.adopt(snap.token, null);
        controller.disarm(false);
        void controller.adoptVerified(snap.token).then((r) => {
          if (r.generation !== null) {
            // 核对到真实代次：按身份精确补取消（disarm 已在 pendingCancel 登记）
            controller.adopt(snap.token, r.generation);
            controller.disarm(false);
          }
          void Promise.resolve().then(bumpCancelDuty);
        }).catch(() => {
          void Promise.resolve().then(bumpCancelDuty);
        });
      }
      clearRestTimerSnapshot(sid);
      tokenRef.current = null;
      setToken(null);
      setEndsAt(null);
      setPausedRemaining(null);
      sourceRef.current = null;
      setSource(null);
      liveStateRef.current = { token: null, status: 'running', endsAt: null, pausedRemaining: null };
      void Promise.resolve().then(bumpCancelDuty);
      return cleanup;
    }

    tokenRef.current = snap.token;
    setToken(snap.token);
    sourceRef.current = snap.source ?? null;
    setSource(snap.source ?? null);
    genRef.current = snap.generation ?? 0;
    /**
     * B4-R3 closure · **重挂后的编号连续性**。
     *
     * <p>组件重挂会让 hook 内存里的意图序号归零；恢复时必须先把水位抬回
     * 「快照里记录的水位」，否则下一次 +15 会带一个 ≤ 原生水位的编号，
     * 被原生判成 {@code stale-intent} 拒绝 —— 表现就是
     * **界面截止延长了、原生仍按旧截止响**（dev/prod 实测 75s vs 60s）。
     *
     * <p>兼容旧数据：旧快照没有水位（读成 0）时，向原生 getActive 取
     * 当前身份的 {@code lastIntentId} 兜底（该字段是附加字段，旧原生无则忽略）。
     */
    const restoreWatermark = (value: number | null | undefined): void => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
      if (value > intentSeqRef.current) intentSeqRef.current = Math.floor(value);
    };
    restoreWatermark(snap.intentWatermark);
    if (!snap.intentWatermark) {
      /**
       * 旧 v1 快照兜底：向原生取当前水位。
       *
       * **归属约束**（Codex 只读审源要求）：结果只允许作用在
       * "仍是同一个 token、仍是同一个 session、本实例仍存活"的计时上，
       * 绝不拿旧查询去污染新计时。
       *
       * 即使查询还没回来用户就点了 +15，也不会产生"UI 延长、原生没排上"：
       * 那次请求若被判 stale-intent，controller 会用原生回报的水位
       * **重发一次**（见 dispatch），用户意图不会丢。
       */
      const watermarkToken = snap.token;
      const watermarkSession = sessionRef.current;
      void getActiveRest()
        .then((info) => {
          if (controller.isDisposed) return;
          if (sessionRef.current !== watermarkSession) return;
          if (tokenRef.current !== watermarkToken) return;
          restoreWatermark(info.lastIntentId);
        })
        .catch(() => {
          // 取不到水位不阻塞恢复；stale-intent 自愈与原生门禁仍是兜底
        });
    }

    /**
     * REVIEW-2 #1 断点二：把**已持有的原生提醒交给控制器**。
     *
     * 旧实现只写进 UI 的 ref，控制器仍以为"没有活跃意图"；
     * 于是恢复后 pause/adjust/stop 全部走空分支 → 原生提醒永远不被取消
     * （真实 Chrome 链路已复现：cancel 调用数 0、active A/gen1 残留）。
     *
     * adopt 之后，暂停/加减/停止与新建路径**完全一致**。
     * 注意：这里**不重排**原生（闹钟本就挂着），也不做全清掩盖。
     */
    /**
     * REVIEW-3 #1：快照 generation 可能为 null —— 这不是"旧版本兼容"，
     * 而是**正常生命周期窗口**：start() 写快照时原生 ack 还没回来。
     * 此时必须向原生**实际核对**当前 token/代次，再安全接管；
     * 不能"保守什么都不做"（那样暂停后仍会提醒）。
     */
    const needVerify = snap.generation === null || snap.generation === undefined;

    if (decision.kind === 'resume-running') {
      /**
       * item 4（REVIEW-5）：**先同步初始化内存实时状态，再异步核对原生身份**。
       *
       * <p>旧实现只恢复 React 显示状态（setEndsAt/setToken），liveStateRef 仍为
       * 初始的 endsAt=null，而 pause()/adjust() 都从 liveStateRef 读值并命中 null
       * 守卫 → 恢复后暂停、加减全部失效。Web 没有原生 generation，这个窗口是
       * **永久性**的（真实 start → reload → pause 已复现）。
       *
       * <p>这里在启动任何异步核对之前就把 liveStateRef 设成快照的真实运行态；
       * 异步 adoptVerified 只负责补充/核实 generation，不改变归属与取消门禁：
       * 未知代次仍走 pendingCancel 的按身份补取消，绝不靠全清原生提醒掩盖。
       */
      liveStateRef.current = {
        token: snap.token,
        status: 'running',
        endsAt: decision.endsAt,
        pausedRemaining: null,
      };
      if (needVerify) {
        void controller.adoptVerified(snap.token).then((r) => {
          /**
           * REVIEW-4 补充：**陈旧 query 不得控制新计时的 UI/快照**。
           * owned=false 表示核对期间用户已换计时/暂停/停止，或本实例已卸载 →
           * 直接丢弃结果（否则会清掉新 B 的界面，而原生 B 仍 active）。
           */
          if (!r.owned || controller.isDisposed) return;
          // 核对期间用户已暂停/停止 → 保持用户的当前状态，不覆盖
          if (liveStateRef.current.status === 'paused') return;
          if (tokenRef.current !== snap.token) return;
          if (r.generation !== null) {
            genRef.current = r.generation;
            // 用核实到的真实代次回写快照，后续 pause 才能按身份取消
            persist(
              {
                token: snap.token,
                status: 'running',
                endsAt: decision.endsAt,
                pausedRemaining: null,
              },
              { fromMountRestore: true },
            );
            return;
          }
          /**
           * 原生确实没有这条活跃提醒（已触发/被清）且仍属当前意图 →
           * 说明这次休息已结束，清 UI 与快照。
           */
          if (r.verified && !r.active) {
            tokenRef.current = null;
            setToken(null);
            setEndsAt(null);
            setPausedRemaining(null);
            genRef.current = 0;
            liveStateRef.current = { token: null, status: 'running', endsAt: null, pausedRemaining: null };
            const sidNow = sessionRef.current;
            if (sidNow) {
              clearRestTimerSnapshot(sidNow);
              void clearDurableRestTimer(sidNow);
            }
          }
        });
      } else {
        // 自动恢复：明确非用户操作，不授予 FGS 启动许可
        pendingOriginRef.current = 'snapshot-restore';
        controller.adopt(snap.token, snap.generation);
      }
      setEndsAt(decision.endsAt);
      setPausedRemaining(null);
      if (!needVerify) {
        persist(
          {
            token: snap.token,
            status: 'running',
            endsAt: decision.endsAt,
            pausedRemaining: null,
          },
          { fromMountRestore: true },
        );
        void reconcileUserCancel();
      }
      return cleanup;
    }
    controller.adopt(snap.token, snap.generation);
    setEndsAt(null);
    setPausedRemaining(decision.pausedRemaining);
    persist(
      {
        token: snap.token,
        status: 'paused',
        endsAt: null,
        pausedRemaining: decision.pausedRemaining,
      },
      { fromMountRestore: true },
    );
    return cleanup;
    // sessionId 必须进依赖：否则 prop 从 A 变 B 时 effect 不重跑，
    // 会继续显示 A 的计时（REVIEW-2 收尾 P2 的真实失败原因）
  }, [controller, persist, reconcileUserCancel, sessionId]);

  /**
   * Wave 1B.2：监听页面回前台（visibilitychange / focus）与原生即时广播
   * （motion:rest-user-cancelled），把通知栏「取消」同步回页面计时态。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void reconcileUserCancel();
      }
    };
    const onFocus = () => {
      void reconcileUserCancel();
    };
    const onUserCancelled = () => {
      void reconcileUserCancel();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    window.addEventListener('motion:rest-user-cancelled', onUserCancelled);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('motion:rest-user-cancelled', onUserCancelled);
    };
  }, [reconcileUserCancel]);

  /**
   * controller 生命周期与 effect setup/cleanup **正确配对**（REVIEW-4 修正）。
   *
   * 背景：React 开发态 StrictMode 会做 setup → cleanup → setup（复用同一
   * controller 与 refs）。旧实现 cleanup 无条件 `dispose()` 且不再恢复，
   * 于是重放后的 ack 回写被永久阻断（generation 无法持久化）。
   *
   * 现在：
   *   · setup  → `activate()`：清除失效标记，迟到 ack / query 结果可正常回写；
   *   · cleanup → `dispose()`：只阻断本实例回写，**不取消原生提醒**
   *     （可能正被新页面接管），**也不清空归属**（重放后要能继续用）。
   *
   * 真正卸载后不会再有 setup，失效标记保持 → 旧实例回写仍被阻断。
   * 不依赖延迟秒数、不做环境跳过、不移除 StrictMode。
   */
  useEffect(() => {
    controller.activate();
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const active = endsAt !== null || pausedRemaining !== null;

  /**
   * B4-R3 F2：**可达的重试入口**。
   *
   * <p>只重试控制器里登记的原始 (token, generation)，因此不会误取消后来建立的
   * 新计时；成功后责任释放、`cancelPending` 归 false。
   */
  const retryCancel = useCallback(() => {
    void controller.retryPendingCancels().then(() => bumpCancelDuty());
  }, [controller, bumpCancelDuty]);

  /** 取消责任镜像（读取 tick 以保证依赖变化时重算） */
  const cancelState = useMemo(() => {
    void cancelDutyTick;
    const snap = controller.snapshot;
    return {
      pending: snap.pendingCancels > 0,
      failed: snap.cancelFailed > 0,
      reason: snap.cancelErrorReason,
    };
  }, [controller, cancelDutyTick]);

  return useMemo(
    () => ({
      active,
      endsAt,
      pausedRemaining,
      token,
      source,
      cancelPending: cancelState.pending,
      cancelErrorReason: cancelState.reason,
      cancelFailed: cancelState.failed,
      start,
      pause,
      resume,
      adjust,
      stop,
      retryCancel,
    }),
    [
      active,
      endsAt,
      pausedRemaining,
      token,
      cancelState.pending,
      cancelState.failed,
      cancelState.reason,
      start,
      pause,
      resume,
      adjust,
      stop,
      retryCancel,
    ],
  );
}

/** 计时读数：自己 tick，不牵动父组件 */
function useTick(active: boolean, intervalMs: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return tick;
}

export function RestTimerBar({ timer }: { timer: RestTimerApi }) {
  /** G3A2：旧快照/手动计时没有归属时明确提示，不猜名称、不全停。 */
  const unknownOwner = timer.active && !timer.source;
  const running = timer.endsAt !== null;
  const active = timer.active;
  const tick = useTick(active, 250);
  const doneFired = useRef(false);

  const remainingMs = useMemo(() => {
    void tick;
    if (timer.pausedRemaining !== null) return timer.pausedRemaining;
    if (timer.endsAt === null) return null;
    return Math.max(0, timer.endsAt - Date.now());
  }, [timer.endsAt, timer.pausedRemaining, tick]);

  /**
   * 到点时**只更新界面状态**，绝不 consume 原生提醒（第二轮预审 P1 #5）。
   *
   * 曾经的错误做法：页面倒计时归零就调用 consumeRestReminder，
   * 而原生 consume 会取消闹钟并标记已消费 —— 但**唯一的提醒出口是 receiver 的通知**，
   * 于是页面先归零就把尚未发出的通知吞掉了，用户完全不震。
   * （也不能靠"后台 effect 不会跑"来保护：前台+非精确调度下页面同样会先归零。）
   *
   * 现在的规则：
   *   · 页面归零 → 只把 UI 标成"休息结束"（doneFired），不碰原生；
   *   · 原生 receiver 到时 → 由它自己按身份核验发**一次**通知；
   *   · 去重完全由原生身份（token + generation + fired）保证，不依赖页面配合。
   * 因此"页面先归零、原生广播稍后到达"仍会正常提醒，且只提醒一次。
   */
  useEffect(() => {
    if (remainingMs !== 0) return;
    doneFired.current = true;
  }, [remainingMs]);

  // 新一轮休息（token 变化）时允许界面再次进入"休息结束"态
  useEffect(() => {
    doneFired.current = false;
  }, [timer.token]);

  /**
   * B4-R3 closure · **F2 真实可见的取消失败与重试入口**。
   *
   * <h2>旧实现的真实缺口（dev/prod 独立验收均 FAIL）</h2>
   * hook 已经能把 {@code cancelPending} 说出来，但实际 {@code RestTimerBar}
   * 里**没有任何可见说明，也没有可点的重试**；而且旧条在
   * {@code !active} 时直接 {@code return null} —— 一旦用户「跳过/结束训练」
   * 让计时条消失，未完成的取消责任就再也看不见（静默丢失）。
   *
   * <h2>现在的行为</h2>
   * <ul>
   *   <li>只在**已确认失败**时提示"取消未完成，提醒可能仍会响"（产品语言，
   *       不向用户暴露 commit/durable 等实现词）；请求还在途时不闪错误；</li>
   *   <li>提供**真实可点**的「重试取消」按钮，走 identity 精确重试；</li>
   *   <li>即使计时条本身不显示（已停止/无剩余），这段提示仍然可见 ——
   *       责任不能因为条消失就静默。</li>
   * </ul>
   */
  const standaloneNotice = !active || remainingMs === null;
  const cancelNotice =
    timer.cancelFailed && timer.cancelPending ? (
      <div
        role="status"
        data-rest-cancel-notice="failed"
        style={{
          ...(standaloneNotice
            ? {
                position: 'sticky' as const,
                top: 0,
                zIndex: 31,
                padding: 'calc(8px + var(--safe-top, 0px)) 12px 8px',
                margin: 'calc(-1 * var(--safe-top, 0px)) -16px 0',
              }
            : {
                padding: '8px 12px',
              }),
          background: 'var(--brick)',
          color: 'var(--paper)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <span>提醒未取消，仍可能响。</span>
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 72 }}
          onClick={timer.retryCancel}
          aria-label="重试取消提醒"
        >
          重试取消
        </button>
      </div>
    ) : null;

  if (!active || remainingMs === null) return cancelNotice;

  const done = remainingMs === 0;
  const bar = (
    <div
      data-rest-sticky-bar="true"
      style={{
        ...(cancelNotice
          ? {
              padding: 'calc(8px + var(--safe-top, 0px)) 12px 8px',
            }
          : {
              position: 'sticky' as const,
              top: 0,
              zIndex: 30,
              padding: 'calc(8px + var(--safe-top, 0px)) 12px 8px',
              margin: 'calc(-1 * var(--safe-top, 0px)) -16px 0',
            }),
        background: done ? 'var(--brick)' : 'var(--ink)',
        color: 'var(--paper)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
      role="timer"
      aria-live="off"
    >
      <span
        style={{
          fontFamily: 'var(--f-mono)',
          fontSize: 12,
          opacity: 0.8,
          letterSpacing: '0.04em',
          flex: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        {done ? '休息结束' : '组间休息'}
      </span>
      <span
        style={{
          fontFamily: 'var(--f-mono)',
          fontSize: 24,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          flex: 'none',
          letterSpacing: '0.02em',
        }}
        aria-label={`剩余 ${fmtCountdown(remainingMs)}`}
      >
        {fmtCountdown(remainingMs)}
      </span>
      {unknownOwner ? (
        <span
          data-testid="rest-unknown-owner"
          style={{ fontSize: 11, opacity: 0.82, flex: 'none' }}
        >
          归属未知 · 可手动停止
        </span>
      ) : null}
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flex: 'none' }}>
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={() => timer.adjust(-15)}
          aria-label="减少 15 秒"
        >
          −15
        </button>
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={() => timer.adjust(15)}
          aria-label="增加 15 秒"
        >
          +15
        </button>
        {running ? (
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
            onClick={timer.pause}
          >
            暂停
          </button>
        ) : (
          <button
            className="btn btn-sm btn-ghost"
            style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
            onClick={timer.resume}
          >
            继续
          </button>
        )}
        <button
          className="btn btn-sm btn-ghost"
          style={{ color: 'inherit', borderColor: 'rgba(255,255,255,.42)', minWidth: 48, padding: '0 6px' }}
          onClick={timer.stop}
        >
          跳过
        </button>
      </div>
    </div>
  );

  // 计时条与取消失败提示可能同时存在（暂停后取消失败就是这种状态）：合并在同一吸顶容器内，避免两层 top:0 互相覆盖
  if (!cancelNotice) return bar;
  return (
    <div
      data-rest-sticky-stack="true"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 31,
        margin: 'calc(-1 * var(--safe-top, 0px)) -16px 0',
      }}
    >
      {bar}
      {cancelNotice}
    </div>
  );
}

/** 已用时长：自己 tick，避免父组件每秒重渲染 */
export function ElapsedClock({
  startedAt,
  pausedMs,
  pausedAt,
  endedAt,
}: {
  startedAt: number;
  pausedMs: number;
  pausedAt: number | null;
  endedAt: number | null;
}) {
  const tick = useTick(endedAt === null, 1000);
  const text = useMemo(() => {
    void tick;
    const end = endedAt ?? Date.now();
    let paused = pausedMs;
    if (pausedAt) paused += Math.max(0, Date.now() - pausedAt);
    const ms = Math.max(0, end - startedAt - paused);
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }, [tick, startedAt, pausedMs, pausedAt, endedAt]);
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>;
}
