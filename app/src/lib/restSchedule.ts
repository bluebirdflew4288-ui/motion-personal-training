/* 组间休息原生提醒的**排程协调器**（纯逻辑，可注入依赖，便于真实序列测试）。
   ── 要解决的问题（REVIEW-1 #2）────────────────────────────────
   旧实现只在 promise 返回时记 generation，导致：
   1. start(A) 后原生响应尚未回来就 pause → 用旧/0 generation 取消 → 取消失败，
      暂停后仍会提醒；
   2. 迟到的排程响应不做补偿 → 暂停/跳过之后提醒照样响；
   3. 旧排程响应会更新**新计时**的凭据（乱序响应污染）；
   4. 已有 A 时 start(0) 不排程也不取消 A → 旧提醒仍响。

   本协调器用「意图序号 + 已知代次 + 迟到补偿」三件套解决：
   · 每次 start/resume/adjust 产生一个**意图**（intentSeq 递增）；
   · 只有「仍是最新意图且未被取消」的响应才能提交它的 generation；
   · 任何被取代/被取消的意图，其**迟到响应**都会用自己返回的 generation
     做一次精确补偿取消（cancelIfCurrent 语义：不会误伤更新的提醒）；
   · disarm 时若代次已知 → 立即按身份取消；若未知（pending）→ 标记取消，
     由迟到响应的补偿兜底。这样不依赖"无身份全清"这种会误杀新提醒的副作用。
   · start(0) 明确走 disarm，保证已有提醒被取消。 */

/** 原生操作注入点（生产环境为 restReminder.ts；测试可注入可控 Promise） */
export interface RestScheduleOps {
  /**
   * 排一个到时提醒；返回真实结果与代次。
   *
   * @param deadlineAtMs **发起时的绝对目标截止**（墙钟毫秒）。
   *   传入它时原生必须尊重它、扣掉 JS→Plugin 的排队耗时，
   *   而不是用"入口时刻 + remainingMs"重新起算（否则提醒会被向后推，
   *   表现为"UI 已归零、过一会才响"）。不传时退回旧的剩余量语义。
   */
  schedule: (
    token: string,
    remainingMs: number,
    deadlineAtMs?: number,
    intentId?: number,
  ) => Promise<{
    scheduled: boolean;
    generation?: number;
    /** 实际排程路径（诊断用；原生未提供时为 undefined） */
    path?: string;
    /** 拒绝原因（原生提供时；用于识别 stale-intent 并可自愈重发） */
    reason?: string;
    /**
     * 原生当前**用户意图水位**（附加字段，旧原生为 undefined）。
     * 用于：排程成功后对齐 JS 序号；被 stale-intent 拒绝时自愈重发。
     */
    lastIntentId?: number;
  }>;
  /** 按身份取消；不传身份表示显式全清 */
  cancel: (identity?: { token: string; generation: number }) => Promise<boolean>;
  /**
   * 向原生核实当前持有的提醒身份（REVIEW-3 #1）。
   * 可选：未提供时，未知代次按"无法核实"处理。
   */
  getActive?: () => Promise<{
    available: boolean;
    active: boolean;
    token: string | null;
    generation: number;
    fired: boolean;
    /**
     * 当前身份的**用户意图水位**（附加字段，B4-R3 closure）。
     *
     * <p>生产实现来自原生 `getActive`；旧原生不返回 → undefined。
     * 用途：重挂后若快照没有水位（旧数据），用它把 JS 意图序号抬到原生水平。
     */
    lastIntentId?: number;
  }>;
  /**
   * Wave 1B.2：按身份对账持久化状态（识别用户在系统通知栏主动点「取消」）。
   */
  inspectIdentity?: (identity: {
    token: string;
    generation?: number | null;
  }) => Promise<{
    available: boolean;
    status: 'active' | 'fired' | 'cancelled_by_user' | 'cancelled' | 'unknown';
  }>;
}

/** 一次排程意图 */
interface Intent {
  seq: number;
  token: string;
  /** 原生返回的代次；未知时为 null（响应尚未回来） */
  generation: number | null;
  /** 该意图是否已被取消/取代 */
  superseded: boolean;
  /**
   * 该意图是否**已被原生真正接受**（B4-R3 closure · F2 责任结清证据）。
   *
   * <p>只有 {@code schedule} 返回 {@code scheduled:true} 且代次被提交，
   * 或恢复时按已知代次 adopt，才算证明"新身份确实存在"。
   * **排程被拒绝（scheduled:false）的意图不算证据** ——
   * 旧实现只看 {@code current.seq/token} 就结清旧取消责任，
   * 于是 A 的取消失败被一个"从未成功的新 B"抹掉，
   * 实际原生/持久态仍是 A（用户以为停了，其实还会响）。
   */
  accepted: boolean;
  /**
   * 是否已经因 `stale-intent` 自愈重发过一次（B4-R3 closure · D2 旧快照窗口）。
   *
   * <p>旧 v1 快照没有水位时，`getActive` 还在途中用户就可能点 +15：
   * 那次请求会带一个落后于原生水位的编号，被如实拒绝。
   * 允许**一次**基于原生回报水位的重发，避免死循环也不丢用户意图。
   */
  staleRetried?: boolean;
  /**
   * 本次意图的**绝对目标截止**（墙钟毫秒）。
   *
   * 由调用方在"用户点击那一刻"算好并随意图一起携带：
   * 排程请求真正到达原生时可能已经过了几十/上百毫秒，
   * 只有带着发起目标截止，原生才能扣掉这段排队耗时，
   * 不会把提醒向后推（B4-R2 优先级一 #1）。
   */
  deadlineAtMs: number | null;
  /**
   * 本次意图的**新意图编号**（B4-R2 优先级一 #3）。
   *
   * 0 表示"不是明确的用户新意图"（自动恢复/接管/adopt 等），
   * 原生会保持 already-fired 门禁：同 token 已 fired 时拒绝重排。
   * 归零后用户点 +15 这类**明确新意图**会给一个严格递增的编号，
   * 让原生能在同一 token 上建立新的可投递身份，同时旧请求重放仍被拒。
   */
  intentId: number;
}

/** 一条**取消责任**：某个已知 (token, generation) 的取消失败，尚未清理完成。 */
export interface PendingCancelDuty {
  /** 精确身份 token；空串表示**通配责任**（无身份全清失败） */
  token: string;
  /** 精确代次；通配责任为 -1 */
  generation: number;
  /** 最近一次失败原因（cancel-false / cancel-threw / …）；in-flight 时为发起来源 */
  reason: string;
  /** 已尝试次数（含首次） */
  attempts: number;
  /** 登记时的意图序号（水位）：用于判断责任是否已被更新的意图取代 */
  seqAt: number;
  /**
   * 生命周期（B4-R3 closure · F2 可见状态）。
   *
   * <ul>
   *   <li>{@code in-flight}：取消请求已发出、结果还没回来 ——
   *       **不能**当成"失败"展示（旧 UI 把 in-flight 原因当失败，出现假告警）；</li>
   *   <li>{@code failed}：已确认取消未成功（返回 false / 抛异常），
   *       原生可能仍持有该提醒 → 必须可见 + 可重试。</li>
   * </ul>
   */
  state: 'in-flight' | 'failed';
}

export interface RestScheduleSnapshot {
  /** 当前是否有活跃意图 */
  active: boolean;
  token: string | null;
  generation: number | null;
  /** 是否还有排程响应未回来 */
  pending: boolean;
  /**
   * 尚未完成的**精确取消责任**数量（B4-R3 F2）。
   *
   * >0 表示：原生提醒可能仍然活着，而控制器还没能把它按身份取消掉。
   * 上层必须据此如实提示/重试，**不能**把它当成"已静默 inactive"。
   */
  pendingCancels: number;
  /**
   * 是否存在**已确认失败**的取消责任（in-flight 不算）。
   *
   * <p>与 {@link pendingCancels} 分开：pending 含"正在取消"，
   * error 只表示"确实失败且需要用户可见/重试"。旧实现把两者混为一谈，
   * 于是刚点暂停就会闪一条"失败"提示。
   */
  cancelError: boolean;
  /** 最近一次**已确认失败**的原因；无失败时为 null */
  cancelErrorReason: string | null;
  /** 其中已确认失败的责任数（用于决定是否展示重试入口） */
  cancelFailed: number;
}

/**
 * 协调器：管理"当前计时"与原生排程之间的归属关系。
 * 所有方法都是同步的（内部处理异步），调用方不需要 await。
 */
export class RestScheduleController {
  private ops: RestScheduleOps;
  /**
   * 排程成功、代次被正式提交时的回调（REVIEW-2 #1）。
   *
   * 为什么必须有：start() 里写快照时原生还没回，generation 必然是 null；
   * 若不在 ack 后回写，快照会永远停在 null，
   * 重建恢复后就没有凭据可用来取消原生提醒（真实 Chrome 链路已证明该失败）。
   */
  private onCommit: ((token: string, generation: number) => void) | null;
  private seq = 0;
  private current: Intent | null = null;
  /** 诊断：补偿取消次数（测试断言用） */
  private compensations = 0;
  /**
   * 核对期间的"待执行取消意图"（REVIEW-3 #1）。
   *
   * 当恢复时 generation 未知、且原生核对尚未返回，用户可能已经 pause/stop。
   * 这些意图不能丢：核对拿到真实代次后必须**按身份补取消**，
   * 否则暂停了却仍会提醒。
   */
  private pendingCancel: { token: string } | null = null;
  /**
   * **精确取消责任表**（B4-R3 F2：pending-cancel / late-ACK / commit-failure）。
   *
   * <h2>旧实现的真实缺口</h2>
   * {@code disarm()} 先把 {@code current} 置 null，再用 {@code void ops.cancel(...)}
   * 把取消**发出去就不管了**。于是：
   * <ul>
   *   <li>cancel 返回 false（原生写盘失败，身份被正确保留）→ 控制器完全不知道；</li>
   *   <li>controller 已经"inactive"，而原生提醒仍然活着、到点照样响；</li>
   *   <li>{@code snapshot.pending} 只看 {@code current.generation===null}，
   *       一旦 current 被清空就再也表达不出"取消失败还在挂着"。</li>
   * </ul>
   *
   * <h2>现在的语义</h2>
   * 每次按身份取消都登记一条责任（token + generation 精确绑定）：
   * <ul>
   *   <li>cancel 返回 true → 责任完成，立即移除；</li>
   *   <li>cancel 返回 false / 抛异常 → 责任**保留**，并计入
   *       {@code snapshot.pendingCancels / cancelError}，由上层如实展示；</li>
   *   <li>只有"已确认成功"或"已被更新的身份安全取代"才终结对应责任 ——
   *       绝不能因为失败就悄悄丢掉，也不能让旧责任的重试误伤新 B。</li>
   * </ul>
   * 重试入口见 {@link #retryPendingCancels}，它只按**登记的原始身份**重试，
   * 因此不会误取消后来建立的新身份。
   */
  private duties: PendingCancelDuty[] = [];
  /** 责任变化回调（UI 刷新用；同步 getter 不会触发渲染） */
  private onDutyChange: (() => void) | null;
  /** 原生水位回调（意图序号与原生对齐用） */
  private onWatermark: ((lastIntentId: number) => void) | null;
  /** 已完成的精确取消次数（诊断） */
  private cancelSuccesses = 0;
  /** 取消明确失败次数（诊断） */
  private cancelFailures = 0;
  /** 因"已被新身份取代 / 目标已不存在"而**安全终结**的责任数（诊断） */
  private dutiesResolvedByReconcile = 0;
  /** 因 stale-intent 而用原生水位自愈重发的次数（诊断） */
  private staleResyncs = 0;
  /** 因**已失去归属（disposed）**而被禁止自愈重发的次数（诊断） */
  private staleResyncsBlocked = 0;
  /**
   * 本实例是否已失效（组件卸载，REVIEW-4 #1）。
   *
   * 卸载后**只阻断本实例的回写**（ack/query 结果不再改快照/UI），
   * **不取消**原生提醒 —— 因为提醒可能正被新页面接管。
   * 这解决了"旧 onCommit 把新页面已暂停的快照改回 running"，
   * 同时不误伤新页面。
   */
  private disposed = false;
  /** 诊断：因迟到而被丢弃的响应数 */
  private staleResponses = 0;
  /**
   * 诊断：原生报"已排程"但**没给数字代次**的次数。
   *
   * 这是 G2 接线缺口的可观测信号：出现它就意味着本次排程没有可用取消凭据，
   * 之后 pause/stop 只能走 pendingCancel，原生提醒可能残留。
   * 只在内存里计数（不落盘、不外发），供诊断/状态提示使用。
   */
  private identityGaps = 0;
  /** 最近一次排程的真实路径（exact / inexact-no-permission / 降级…），诊断用 */
  private lastPath: string | null = null;
  /** 是否出现过"已排程但缺代次"的活跃意图（见 dispatch） */
  private identityGapPending = false;

  constructor(
    ops: RestScheduleOps,
    onCommit?: (token: string, generation: number) => void,
    /**
     * 取消责任发生变化时的通知（B4-R3 closure · F2 可见状态）。
     *
     * <p>责任表是同步 getter，不会触发 React 渲染；旧实现靠"暂停后一个
     * microtask + useMemo"刷新，于是晚 ACK 的失败、stop 后的 inactive、
     * 会话切换等路径都不会再刷新，失败被静默。
     * 现在每次登记/失败/清理都回调，UI 能准确跟随真实状态。
     */
    onDutyChange?: () => void,
    /**
     * 原生回报水位时的通知（B4-R3 closure）。
     *
     * <p>hook 用它把内存里的意图序号抬到与原生一致；
     * 每次排程（成功或被拒）都会回报，因此**不依赖**异步 getActive 是否已返回。
     */
    onWatermark?: (lastIntentId: number) => void,
  ) {
    this.ops = ops;
    this.onCommit = onCommit ?? null;
    this.onDutyChange = onDutyChange ?? null;
    this.onWatermark = onWatermark ?? null;
  }

  private notifyDutyChange(): void {
    try {
      this.onDutyChange?.();
    } catch {
      // 通知失败绝不影响取消/排程语义
    }
  }

  get snapshot(): RestScheduleSnapshot {
    const failed = this.duties.filter((d) => d.state === 'failed');
    const lastFailed = failed.length ? failed[failed.length - 1] : null;
    return {
      active: this.current !== null,
      token: this.current?.token ?? null,
      generation: this.current?.generation ?? null,
      pending: this.current !== null && this.current.generation === null,
      pendingCancels: this.duties.length,
      cancelError: failed.length > 0,
      cancelErrorReason: lastFailed ? lastFailed.reason : null,
      cancelFailed: failed.length,
    };
  }

  /** 尚未完成的精确取消责任（只读副本，供诊断/上层展示） */
  get pendingCancelDuties(): PendingCancelDuty[] {
    return this.duties.map((d) => ({ ...d }));
  }

  get cancelSuccessCount(): number {
    return this.cancelSuccesses;
  }

  get cancelFailureCount(): number {
    return this.cancelFailures;
  }

  /** 安全终结的责任数（被新身份取代 / 原生证实目标已不存在） */
  get reconciledDutyCount(): number {
    return this.dutiesResolvedByReconcile;
  }

  /** stale-intent 自愈重发次数（诊断；正常路径应为 0，旧快照窗口可能 1） */
  get staleResyncCount(): number {
    return this.staleResyncs;
  }

  /**
   * 因失去归属（disposed）而**被禁止**自愈的次数（诊断）。
   *
   * <p>&gt;0 表示确实发生过"旧 controller 收到迟到 stale ACK"的场景，
   * 且我们**没有**去覆盖新身份 —— 这是正确行为，不是错误。
   */
  get staleResyncBlockedCount(): number {
    return this.staleResyncsBlocked;
  }

  get compensationCount(): number {
    return this.compensations;
  }

  get staleResponseCount(): number {
    return this.staleResponses;
  }

  /** 原生报已排程但缺代次的次数（>0 表示出现了取消凭据缺口） */
  get identityGapCount(): number {
    return this.identityGaps;
  }

  /** 最近一次排程的实际路径（诊断用；未排程过为 null） */
  get lastSchedulePath(): string | null {
    return this.lastPath;
  }

  /**
   * 是否存在"原生已排程但没有取消凭据"的活跃意图。
   *
   * 为 true 时上层应当**如实提示**提醒可能无法被暂停/取消，
   * 而不是假装一切正常（G2 要求准确状态提示）。
   */
  get hasIdentityGap(): boolean {
    return this.identityGapPending && this.current !== null && this.current.generation === null;
  }

  /**
   * 开始（或重排）一次休息。
   *
   * @param token 本次休息的 token
   * @param remainingMs 剩余毫秒；<=0 表示"已归零/跳过"，此时只取消旧提醒、不排新的
   */
  arm(token: string, remainingMs: number, deadlineAtMs?: number, intentId?: number): void {
    // 新意图诞生：旧意图一律作废（其迟到响应会被补偿）
    this.pendingCancel = null;
    this.supersedeCurrent();
    this.seq += 1;
    /**
     * 只有**正的、有限**的目标截止才携带；否则退回旧语义（按剩余量排），
     * 绝不把 NaN/Infinity/0 送进原生。
     */
    const deadline =
      typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs) && deadlineAtMs > 0
        ? deadlineAtMs
        : null;
    const intent: Intent = {
      seq: this.seq,
      token,
      generation: null,
      superseded: false,
      accepted: false,
      deadlineAtMs: deadline,
      /**
       * 只有有限正整数才作为"明确用户新意图"透传；其余一律 0（保持旧门禁）。
       */
      intentId:
        typeof intentId === 'number' && Number.isFinite(intentId) && intentId > 0
          ? Math.floor(intentId)
          : 0,
    };

    if (remainingMs <= 0) {
      // start(0)/归零：不排新的，但必须确保旧提醒已被取消
      this.current = null;
      this.fullClear();
      return;
    }

    this.current = intent;
    void this.dispatch(intent, remainingMs);
  }

  /**
   * **按原生真实身份接管**，用于恢复时快照 generation 未知（REVIEW-3 #1）。
   *
   * 语义：
   * <ol>
   *   <li>向原生查询当前身份；</li>
   *   <li>若原生确有同一 token 的活跃提醒 → 用**原生的真实代次**接管，
   *       之后 pause/stop/adjust 都能按身份正确取消；</li>
   *   <li>若原生没有该提醒（已触发/已被清） → 接管为"无活跃意图"，
   *       并让调用方据此清理 UI；</li>
   *   <li>若无法核实（原生不可用/查询失败） → 记下**待定意图**：
   *       期间发生的 pause/stop 会被记住，核对完成后按真实代次补取消。
   *       绝不用全清或重排掩盖。</li>
   * </ol>
   *
   * @returns 核实结果，调用方据此决定 UI
   */
  async adoptVerified(token: string): Promise<{
    verified: boolean;
    active: boolean;
    generation: number | null;
    fired: boolean;
    /**
     * 这次核对结果是否**仍属于调用时的那个意图**（REVIEW-4 补充）。
     *
     * false 表示：核对期间用户已经换了计时 / 暂停 / 停止 / 组件已卸载，
     * 调用方**不得**用这个结果去改 UI 或快照 —— 否则陈旧 query
     * 会清掉新计时的界面（真实 13 项里的 query-pending-replaced-by-B）。
     */
    owned: boolean;
  }> {
    if (!token) {
      return { verified: false, active: false, generation: null, fired: false, owned: false };
    }
    this.seq += 1;
    const seq = this.seq;
    // 先登记"待定意图"：核对期间的 pause/stop 会作用在它上面
    this.current = {
      seq,
      token,
      generation: null,
      superseded: false,
      accepted: false,
      deadlineAtMs: null,
      intentId: 0,
    };

    if (!this.ops.getActive) {
      // 没有核对能力：保持待定，不假装已接管
      return { verified: false, active: true, generation: null, fired: false, owned: true };
    }

    let info: {
      available: boolean;
      active: boolean;
      token: string | null;
      generation: number;
      fired: boolean;
    };
    try {
      info = await this.ops.getActive();
    } catch {
      const still = this.current !== null && this.current.seq === seq;
      return { verified: false, active: true, generation: null, fired: false, owned: still };
    }

    /**
     * 核对期间意图可能已被**取代**（新计时）或**取消**（用户 pause/stop）。
     * 两者处理不同：
     *   · 被新计时取代 → 核对结果不得覆盖新意图，直接返回；
     *   · 被 pause/stop 取消 → 必须继续走下面的"补取消"逻辑（pendingCancel），
     *     否则会"暂停了却仍提醒"。
     */
    /**
     * 本实例已失效（真正卸载）→ 结果不属于调用方，不得控制 UI/快照。
     * StrictMode 重放会由 setup 的 activate() 清除该标记，因此不影响开发态。
     */
    if (this.disposed) {
      return {
        verified: info.available,
        active: false,
        generation: null,
        fired: false,
        owned: false,
      };
    }

    const cancelledWhileVerifying =
      this.pendingCancel !== null && this.pendingCancel.token === token;
    const stillCurrent = this.current !== null && this.current.seq === seq;
    if (!stillCurrent && !cancelledWhileVerifying) {
      // 已被取代：结果不属于调用方，绝不能拿它改 UI/快照
      return {
        verified: info.available,
        active: false,
        generation: null,
        fired: false,
        owned: false,
      };
    }

    if (!info.available) {
      // 无法核实：保持待定（后续 pause/stop 会在 resolvePending 时补取消）
      return { verified: false, active: true, generation: null, fired: false, owned: true };
    }

    const sameToken = info.token === token;
    if (!info.active || !sameToken || info.fired) {
      /**
       * 原生没有这条活跃提醒。
       * **注意**：这只说明"原生侧没有活跃闹钟"，并不代表"页面计时已失效" ——
       * 合法的暂停状态本来就没有活跃闹钟（REVIEW-4 #2）。
       * 因此这里只清空 controller 归属，**不替调用方决定清 UI**；
       * 由调用方按自己的当前意图（owned + 状态）判断。
       */
      this.current = null;
      return { verified: true, active: false, generation: null, fired: info.fired, owned: true };
    }

    /**
     * 核对期间用户已经 pause/stop → 现在拿到真实代次，按身份补取消。
     * 这是"未知凭据要有实际核对/安全处理"的关键闭环。
     */
    const pending = this.pendingCancel;
    if (pending && pending.token === token) {
      this.pendingCancel = null;
      this.current = null;
      this.cancelByIdentity(token, info.generation, 'adopt-cancel');
      return {
        verified: true,
        active: false,
        generation: info.generation,
        fired: false,
        owned: true,
      };
    }

    // 核实成功：用真实代次接管
    this.current = {
      seq,
      token,
      generation: info.generation,
      superseded: false,
      // 原生已持有并核实过这条身份 → 视为已接受（不是"未决意图"）
      accepted: true,
      deadlineAtMs: null,
      intentId: 0,
    };
    return {
      verified: true,
      active: true,
      generation: info.generation,
      fired: false,
      owned: true,
    };
  }

  /**
   * 标记本实例失效（effect cleanup 调用）：只阻断后续回写，不动原生。
   *
   * **不清理 `current` / 不推进 seq**（REVIEW-4 修正）：
   * React 开发态 StrictMode 的 effect 重放是 setup → cleanup → setup，
   * 复用同一个 controller。若 cleanup 把归属清空，重放后的 setup 无法恢复
   * 已接管的提醒（恢复快照后 pause 会失效）。
   * 归属的清空由 `reset()` 负责（训练实例切换时显式调用）。
   */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * 重新取得本实例的所有权（effect setup 调用）。
   *
   * 与 {@link dispose} 配对：StrictMode 重放时 cleanup→setup 紧邻发生，
   * setup 清除失效标记，于是迟到 ack / query 结果仍能正确回写；
   * 而**真正卸载**后不会再有 setup，失效标记保持，旧实例回写依旧被阻断。
   */
  activate(): void {
    this.disposed = false;
  }

  /** 本实例是否已失效 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * 清空控制器状态（训练实例切换时用，REVIEW-2 收尾 P2）。
   *
   * 只清**内存**里的归属，不碰原生提醒与快照：
   * 旧训练的提醒与快照属于旧训练，应由旧训练自己的生命周期处理。
   */
  reset(): void {
    this.seq += 1;
    this.current = null;
    this.pendingCancel = null;
    this.identityGapPending = false;
    /**
     * 训练实例切换：**保留未完成的取消责任**（B4-R3 closure · F2 不可静默丢）。
     *
     * <p>为什么不再清空：责任是**精确身份绑定**的（token + generation），
     * 重试只会去取消"那一条"原生提醒，不会碰到新训练刚建的身份；
     * 而清空等于把"提醒可能还会响"这件事悄悄抹掉 ——
     * 旧实现正是在 stop 后 inactive / 无计时条 / 会话切换这些路径上
     * 把失败变成不可见。
     *
     * <p>不清原生（旧提醒属于旧训练），也不改新训练的任何状态。
     */
    this.notifyDutyChange();
  }

  /**
   * **接管**一条已存在的原生提醒（页面重建恢复时用，REVIEW-2 #1）。
   *
   * 为什么需要：重建后原生提醒本来就还挂着，页面上没有"新建"过它；
   * 若只把 token/generation 放进 UI 的 ref、不交给控制器，
   * 之后 pause/adjust/stop 都会走"没有活跃意图"的分支 → 原生提醒永远不被取消。
   *
   * 接管后所有路径（暂停/加减/停止）与新建路径**完全一致**。
   *
   * @param token 快照里的 token
   * @param generation 已核实的代次；null 表示无法确认（调用方应先尝试向原生核对）
   */
  adopt(token: string, generation: number | null): void {
    if (!token) return;
    this.seq += 1;
    this.current = {
      seq: this.seq,
      token,
      generation,
      superseded: false,
      // 已知代次 = 原生确实持有这条身份；null 代次仍属未核实（不算接受）
      accepted: generation !== null,
      deadlineAtMs: null,
      intentId: 0,
    };
  }

  /**
   * Wave 1B.2：页面回前台 / 收到通知栏取消事件时向原生对账当前活动休息段。
   *
   * 仅当原生明确回报该 (token, generation) 为 `cancelled_by_user`、且本控制器当前仍持有
   * 该意图（未被用户切换/暂停/卸载）时：
   *   · 静默释放本控制器归属（不再补发冗余 cancel IPC，避免误触发「提醒未取消」横幅）；
   *   · 结清与该 token 匹配的旧取消责任；
   *   · 返回 `'cancelled_by_user'` 供上层 Hook 静默收束页面倒计时并清理本地快照。
   */
  async reconcileForeground(): Promise<'cancelled_by_user' | 'unchanged'> {
    if (this.disposed || !this.current || !this.ops.inspectIdentity) {
      return 'unchanged';
    }
    const seqAtStart = this.current.seq;
    const tok = this.current.token;
    const gen = this.current.generation;
    let res: {
      available: boolean;
      status: 'active' | 'fired' | 'cancelled_by_user' | 'cancelled' | 'unknown';
    };
    try {
      res = await this.ops.inspectIdentity({ token: tok, generation: gen });
    } catch {
      return 'unchanged';
    }
    if (this.disposed || !this.current || this.current.seq !== seqAtStart || this.current.token !== tok) {
      return 'unchanged';
    }
    if (res.available && res.status === 'cancelled_by_user') {
      this.current = null;
      this.pendingCancel = null;
      this.identityGapPending = false;
      const before = this.duties.length;
      if (before > 0) {
        this.duties = this.duties.filter(
          (d) => !(d.token === tok && (gen === null || d.generation === gen)),
        );
        if (this.duties.length !== before) {
          this.dutiesResolvedByReconcile += before - this.duties.length;
          this.notifyDutyChange();
        }
      }
      return 'cancelled_by_user';
    }
    return 'unchanged';
  }

  /**
   * 停止提醒（暂停 / 跳过 / 结束训练）。
   *
   * @param fullClear true=显式全清（结束训练，不带身份）；false=按身份取消当前
   */
  disarm(fullClear: boolean): void {
    const intent = this.current;
    this.current = null;
    this.identityGapPending = false;
    if (!intent) {
      // 没有活跃意图：全清时仍清一次，保证不留残留
      if (fullClear) this.fullClear();
      return;
    }
    intent.superseded = true;
    if (intent.generation !== null) {
      // 代次已知：精确取消（不会误伤更新的提醒），并登记失败责任
      this.cancelByIdentity(intent.token, intent.generation, 'disarm');
      return;
    }
    /**
     * 代次未知：两种来源
     *   · 排程响应在途 → 迟到响应会自行补偿取消；
     *   · 恢复时 generation 未知 → 记下待执行取消，等核对结果补做（REVIEW-3 #1）。
     */
    this.pendingCancel = { token: intent.token };
    if (fullClear) this.fullClear();
  }

  /** 显式全清（不带身份）：仅用于结束训练等"确定没有后续提醒"的场景 */
  private fullClear(): void {
    /**
     * 无身份全清的**失败同样不能静默**（F2）。
     *
     * 全清没有精确身份可登记，因此失败时用一个通配责任表示
     * "还有未完成的清理"，由 {@link #retryPendingCancels} 用无身份全清重试。
     * token 用空串 + generation -1 明确表达"非精确身份"。
     */
    const token = '';
    const generation = -1;
    void (async () => {
      try {
        const ok = await this.ops.cancel();
        if (ok) {
          this.cancelSuccesses += 1;
          return;
        }
        /**
         * B4-R3 closure2 · F2：**已确认失败**必须直接以 `failed` 登记。
         *
         * <p>旧实现这里用 {@code registerDuty(...)}，而登记默认状态是
         * {@code in-flight} —— 于是一条**已经拿到真实 cancel=false 的失败**
         * 在 snapshot 里只表现为"正在取消"：`pendingCancels=1` 但
         * `cancelError=false`、`cancelErrorReason=null`、`cancelFailed=0`，
         * UI 也就不会出现"取消未完成/可重试"。真实失败被静默。
         *
         * <p>现在用 {@code markDutyFailed}：状态=failed、attempts 计数、
         * 触发责任变化回调，`cancelError` 立即为 true 并可重试。
         */
        this.markDutyFailed(token, generation, 'full-clear-false');
      } catch {
        this.markDutyFailed(token, generation, 'full-clear-threw');
      }
    })();
  }

  /**
   * 按精确身份取消，并把**失败**登记成未完成责任（F2 核心）。
   *
   * <p>成功 → 责任立即释放；失败/抛异常 → 保留责任并计入 snapshot，
   * 由上层展示与 {@link #retryPendingCancels} 重试。
   */
  private cancelByIdentity(token: string, generation: number, source: string): void {
    this.registerDuty(token, generation, 'in-flight:' + source);
    void (async () => {
      try {
        const ok = await this.ops.cancel({ token, generation });
        if (ok) {
          this.cancelSuccesses += 1;
          this.clearDuty(token, generation);
          return;
        }
        this.markDutyFailed(token, generation, 'cancel-false:' + source);
      } catch {
        this.markDutyFailed(token, generation, 'cancel-threw:' + source);
      }
    })();
  }

  private dutyIndex(token: string, generation: number): number {
    return this.duties.findIndex((d) => d.token === token && d.generation === generation);
  }

  private registerDuty(token: string, generation: number, reason: string): void {
    const i = this.dutyIndex(token, generation);
    if (i >= 0) {
      this.duties[i] = { ...this.duties[i], reason, state: 'in-flight' };
      this.notifyDutyChange();
      return;
    }
    this.duties.push({ token, generation, reason, attempts: 0, seqAt: this.seq, state: 'in-flight' });
    this.notifyDutyChange();
  }

  private clearDuty(token: string, generation: number): void {
    const i = this.dutyIndex(token, generation);
    if (i >= 0) {
      this.duties.splice(i, 1);
      this.notifyDutyChange();
    }
  }

  private markDutyFailed(token: string, generation: number, reason: string): void {
    this.cancelFailures += 1;
    const i = this.dutyIndex(token, generation);
    if (i >= 0) {
      this.duties[i] = {
        ...this.duties[i],
        reason,
        attempts: this.duties[i].attempts + 1,
        state: 'failed',
      };
      this.notifyDutyChange();
      return;
    }
    this.duties.push({ token, generation, reason, attempts: 1, seqAt: this.seq, state: 'failed' });
    this.notifyDutyChange();
  }

  /**
   * **重试未完成的精确取消**（F2 的"可达重试"）。
   *
   * <p>规则：
   * <ul>
   *   <li>只按**登记的原始身份**（token + generation）重试 →
   *       绝不会误取消后来建立的新 B；</li>
   *   <li>每条责任成功后立即释放；失败则保留并累计 attempts；</li>
   *   <li>通配责任（token 为空）走无身份全清；</li>
   *   <li>返回本次是否**全部**清理干净（true = 没有剩余责任）。</li>
   * </ul>
   *
   * @returns 重试后是否已无未完成责任
   */
  async retryPendingCancels(): Promise<boolean> {
    const pending = this.duties.slice();
    for (const duty of pending) {
      /**
       * ① **先做安全终结判定**（B4-R3 修点②）：过时责任绝不能变成杀新 B 的刀。
       *
       * <p>两类风险：
       * <ul>
       *   <li><b>通配责任</b>（无身份全清失败）：重试会再次发 {@code cancel()} 无身份全清，
       *       若用户在失败之后已经 arm 了新 B，这条全清会**直接杀掉 B**；</li>
       *   <li><b>精确责任</b>（旧 A 的 token/gen）：原生 {@code cancelIfCurrent} 会拒绝
       *       陈旧身份，因此不会误伤 B —— 但若 B 恰好在同一 token 上换了代次，
       *       这条责任会永远取消不掉、把"取消失败"永久挂在 B 头上。</li>
       * </ul>
       *
       * <p>现在：责任若已被更新的意图取代（或被原生证实目标身份已不存在），
       * 直接**安全终结**（移除责任，不产生任何原生副作用）。
       */
      if (this.isDutyObsolete(duty)) {
        this.dutiesResolvedByReconcile += 1;
        this.clearDuty(duty.token, duty.generation);
        continue;
      }

      // ② 精确责任：先用 getActive 核实目标身份是否还存在
      if (duty.token !== '' && this.ops.getActive) {
        const reconciled = await this.reconcileDutyWithNative(duty);
        if (reconciled === 'gone') continue; // 已被安全终结
      }

      // ③ 仍有效：按**登记的原始身份**重试（精确责任永不误伤新 B）
      try {
        const ok =
          duty.token === ''
            ? await this.ops.cancel()
            : await this.ops.cancel({ token: duty.token, generation: duty.generation });
        if (ok) {
          this.cancelSuccesses += 1;
          this.clearDuty(duty.token, duty.generation);
        } else {
          // 失败后立刻再核实一次：可能刚好被新身份替换掉了
          if (duty.token !== '' && this.ops.getActive) {
            const again = await this.reconcileDutyWithNative(duty);
            if (again === 'gone') continue;
          }
          this.markDutyFailed(duty.token, duty.generation, 'cancel-false:retry');
        }
      } catch {
        this.markDutyFailed(duty.token, duty.generation, 'cancel-threw:retry');
      }
    }
    return this.duties.length === 0;
  }

  /**
   * 责任是否**已被更新意图安全取代**（结清条件）。
   *
   * <h2>必须要求"新意图已被真正接受"（B4-R3 closure · Gap 3）</h2>
   * 旧实现只看 {@code current.seq / token}，于是出现已证实的假结清：
   * <pre>
   *   A 取消失败 → 责任保留
   *   arm(B) → 原生排程被拒（scheduled:false，B 从未存在）
   *   retryPendingCancels() → 仅凭"current 变成 B"就把 A 的责任清掉
   *   实际：native / durable 仍是 A，用户以为停了，其实还会响
   * </pre>
   *
   * <p>现在只有**两类正向证据**可以结清：
   * <ol>
   *   <li>{@code cur.accepted === true}：新身份确实被原生接受
   *       （schedule 返回成功且代次已提交，或按已知代次 adopt）。
   *       此时：通配责任必须终结（否则重试会无身份全清杀掉新 B）；
   *       精确责任在 token 不同时终结（同 token 仍按原身份重试，不会误伤）；</li>
   *   <li>原生核实目标身份已不存在（见 {@link #reconcileDutyWithNative}）。</li>
   * </ol>
   *
   * <p>被拒/未决的新意图**不是**证据：责任保留，snapshot 继续
   * 报 {@code pendingCancels/cancelError}，故障解除后重试才真正清理。
   */
  private isDutyObsolete(duty: PendingCancelDuty): boolean {
    const cur = this.current;
    if (!cur || cur.seq <= duty.seqAt) return false;
    // 关键：未成功的新意图不能当证据（Gap 3 修复点）
    if (!cur.accepted) return false;
    if (duty.token === '') return true; // 通配责任 + 已接受新身份 → 必须终结
    // 精确责任：新身份已接受且 token 不同 → 旧身份不可能再被需要
    return cur.token !== duty.token;
  }

  /**
   * 向原生核实责任目标身份是否还存在。
   *
   * @returns 'gone' 表示目标已不存在（责任可安全终结）；'live' 表示仍在
   */
  private async reconcileDutyWithNative(
    duty: PendingCancelDuty,
  ): Promise<'gone' | 'live'> {
    if (!this.ops.getActive) return 'live';
    let info: { available: boolean; active: boolean; token: string | null; generation: number; fired: boolean };
    try {
      info = await this.ops.getActive();
    } catch {
      return 'live'; // 无法核实 → 保守保留责任，不擅自终结
    }
    if (!info.available) return 'live';
    const goneAtNative =
      !info.active || info.token !== duty.token || info.generation !== duty.generation;
    if (!goneAtNative) return 'live';
    this.dutiesResolvedByReconcile += 1;
    this.clearDuty(duty.token, duty.generation);
    return 'gone';
  }

  /** 把当前意图标记为作废，并（若代次已知）精确取消它 */
  private supersedeCurrent(): void {
    const intent = this.current;
    if (!intent) return;
    intent.superseded = true;
    if (intent.generation !== null) {
      this.cancelByIdentity(intent.token, intent.generation, 'supersede');
    }
  }

  /** 发出排程请求并处理响应归属 */
  private async dispatch(intent: Intent, remainingMs: number): Promise<void> {
    let result: {
      scheduled: boolean;
      generation?: number;
      path?: string;
      reason?: string;
      lastIntentId?: number;
    };
    try {
      /**
       * **携带发起目标截止**（B4-R2 优先级一 #1）。
       *
       * 不传的话原生会用"入口时刻 + remainingMs"重算，
       * 把桥接排队耗时加进休息时长 —— 这正是用户反馈的"归零后过一会才响"。
       */
      if (intent.deadlineAtMs !== null) {
        result = await this.ops.schedule(
          intent.token,
          remainingMs,
          intent.deadlineAtMs,
          intent.intentId,
        );
      } else if (intent.intentId > 0) {
        result = await this.ops.schedule(
          intent.token,
          remainingMs,
          undefined,
          intent.intentId,
        );
      } else {
        result = await this.ops.schedule(intent.token, remainingMs);
      }
    } catch {
      return;
    }
    const gen = result.generation;
    if (typeof result.path === 'string') this.lastPath = result.path;

    /**
     * **水位对齐**（B4-R3 closure · D2）：原生每次排程都回报当前用户意图水位。
     * 先把它交给上层（hook 抬内存序号），再处理本意图的归属。
     */
    if (typeof result.lastIntentId === 'number' && Number.isFinite(result.lastIntentId)) {
      try {
        this.onWatermark?.(Math.max(0, Math.floor(result.lastIntentId)));
      } catch {
        // 水位通知失败不影响排程语义
      }
    }
    /**
     * **stale-intent 自愈**（旧 v1 快照窗口）：
     *
     * 旧快照没有水位、`getActive` 尚未返回时，用户先点了 +15 →
     * 请求带着落后编号到达 → 原生如实拒绝并回报它**当前**的水位。
     * 只要这次意图仍是最新的、未被取消，就用「原生水位 + 1」**重发一次**，
     * 使用户这一次 +15 真正落在原生上（而不是出现 UI 75s / native 60s 的分叉）。
     *
     * 只重发一次（`staleRetried`），避免任何死循环；原生未回报水位时
     * 保持"如实失败"（不猜测、不伪造编号）。
     */
    if (
      !result.scheduled &&
      result.reason === 'stale-intent' &&
      typeof result.lastIntentId === 'number' &&
      Number.isFinite(result.lastIntentId) &&
      !intent.staleRetried
    ) {
      /**
       * **生命周期归属门禁**（B4-R3 closure · Codex 审源第 3 节）。
       *
       * <p>真实反例：原生先有 A（水位 20）；旧 controller 用编号 1 排 A，
       * 原生**如实拒绝**（stale-intent / lastIntentId=20），但**ACK 延迟**回到 JS；
       * 旧页面 dispose 后用户已经排好新 B；迟到的 A 拒绝 ACK 到达旧 controller。
       * 若此时仍自愈，旧 controller 会把 A 提号到 21 重新发排程 ——
       * 原生会**正确接受**这个"不同 token 的新请求"，于是**覆盖掉 B**。
       * `onCommit` 的旧 UI 回写门禁拦不住这种**原生副作用**。
       *
       * <p>因此：**失去所有权（disposed）的 controller 一律不再主动发重试**。
       * StrictMode 的 cleanup→setup 会调用 {@link #activate} 恢复所有权，
       * 此后迟到 ACK 的自愈仍照常工作（不被误杀）。
       */
      const isLatestForRetry =
        !this.disposed &&
        this.current !== null &&
        this.current.seq === intent.seq &&
        !intent.superseded;
      if (!isLatestForRetry && this.disposed) {
        this.staleResyncsBlocked += 1;
      }
      if (isLatestForRetry) {
        intent.staleRetried = true;
        intent.intentId = Math.max(intent.intentId, Math.floor(result.lastIntentId)) + 1;
        this.staleResyncs += 1;
        await this.dispatch(intent, remainingMs);
        return;
      }
    }

    /**
     * **接线缺口的显式记录**（G2）：原生说"排上了"却没给数字代次。
     *
     * 旧行为是静默跳过提交分支，于是：
     *   · `current.generation` 永远停在 null → `snapshot.pending` 永远为 true；
     *   · 之后 pause/stop 走 `disarm(false)` 的"代次未知"分支，只记 pendingCancel；
     *   · 而这次请求已经结束，不会再有带代次的迟到 ack 来补偿 →
     *     **暂停了原生提醒仍然残留**。
     *
     * 这里**不伪造代次**（那会让取消误伤/误报），但把缺口记成可观测事实，
     * 并让归属意图明确标记为"无凭据"，避免上层误以为已经提交。
     */
    if (result.scheduled && typeof gen !== 'number') {
      this.identityGaps += 1;
      if (intent.seq === this.current?.seq && !intent.superseded) {
        // 意图仍是最新的：把"已排程但无凭据"如实暴露出来
        this.identityGapPending = true;
      }
    }

    // 归属判定：只有「仍是最新意图」且「未被作废」才能提交凭据
    const isLatest = this.current !== null && this.current.seq === intent.seq;
    if (isLatest && !intent.superseded && result.scheduled && typeof gen === 'number') {
      intent.generation = gen;
      /**
       * 原生**确实接受了**这条新身份 → 这是 F2 结清旧责任的唯一排程类证据。
       * 排程被拒（scheduled:false）时保持 accepted=false，责任必须继续保留。
       */
      intent.accepted = true;
      // 已拿到真实代次：取消凭据缺口随之消失
      this.identityGapPending = false;
      /**
       * 代次正式提交 → 通知上层回写快照（REVIEW-2 #1）。
       * 但**已失效的实例**（真正卸载后、且没有 setup 重新 activate）不得回写，
       * 否则旧实例会把新页面已暂停的快照改回 running（REVIEW-4 #1）。
       * 注意：这里只阻断**回写**，不影响原生提醒本身。
       */
      if (!this.disposed) this.onCommit?.(intent.token, gen);
      return;
    }

    // 迟到/被取代的响应：绝不污染新计时的凭据
    if (intent.seq !== this.current?.seq) this.staleResponses += 1;

    /**
     * 补偿：如果这次请求其实已经成功排上（scheduled=true 且有代次），
     * 但它已不属于当前计时 → 用它**自己的代次**精确取消，
     * 避免"暂停后仍提醒"。用代次取消不会误伤更新的提醒。
     */
    if (result.scheduled && typeof gen === 'number') {
      this.compensations += 1;
      this.cancelByIdentity(intent.token, gen, 'late-ack-compensation');
    }
  }
}
