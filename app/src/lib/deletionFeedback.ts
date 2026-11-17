/* F11：删除成功反馈的唯一前台通道（成功短音 + F09 准备触感）。
   ── 纪律（与 F10 消散同一套归属思路，但**不共享任何业务状态**）──────
   1. **只有一个调用点**：`Session.commitDelete` 里 `status === 'saved'` 的分支。
      request-success、buildNext、点击删除、确认弹窗、F09 就绪都不许先响；
   2. **每个 session/item/intent token 至多一次**：token 进集合即结算，
      重复回调、重试、重渲染都不会放第二次。去重范围是**整个 session 生命周期**
      （见 {@link MAX_TRACKED_DELETE_TOKENS_PER_SESSION}）：**绝不**用"淘汰最旧
      token"换取有界内存 —— 那会让一个很久以前已经响过的旧意图重新可播；
   3. **归属**：必须绑定当前页面所属 session 且页面可见才算；换 session、
      离页、隐藏、卸载、失锁都由 `invalidate()` 递增世代，**迟到的**
      load/play/回调一律作废（不会把旧页面的声音放到新页面）；
   4. **异常隔离**：整个模块对外只返回结果、绝不抛出；音频/震动/原生桥
      任何失败都不能改变已成功的删除、8 秒撤销与计时收尾。**异步**失败
      （Promise 拒绝）与同步异常同样必须就地吞掉，不许漏出 unhandledRejection；
   5. **不冒充**：Web 侧只能证明"调了 Web Audio"，Android 侧只能证明
      "原生策略门禁放行并调用了系统播放"。二者都不等于"用户听到了"，
      更不能把一个 JS resolve 说成 Android 静音/勿扰策略已被遵循；
   6. **提交前凭证**（F11-FIX1）：成功音属于"这一次删除提交"。调用方必须在
      **命令发出前**用 {@link captureDeleteFeedbackIntent} 取一张凭证（当时的
      世代 + 绑定 session），并在 `saved` 出口带着它调用；提交期间只要发生过
      隐藏/失锁/离页/换 session/开关变化，凭证就失效，迟到的 saved **不会**在
      新世代下被当成一次新的成功；
   7. **清理只作用于自己的 owner**（F11-FIX1）：迟到的旧原生结果只能停
      **自己那一次**的播放。更晚的意图已经接管时，旧回调不许再发 `stop`——
      原生只有一条播放流，停别人等于掐掉新页面的声音；原生侧 `stop` 还带
      owner，只作废/停止属于自己的意图与流，不推进其它意图的序号。

   ── 通道互斥 ───────────────────────────────────────────────
   native：策略判定与播放都在原生（AudioManager/NotificationManager 真实状态），
           JS 只转发意图并**如实回报**原生结果；
   web：浏览器没有铃声/勿扰查询能力，因此只做"开关 + 可见性 + 归属"门禁，
        并在报告里写明这是 web-audio 通道（不声称遵循了系统静音策略）。 */

import { registerPlugin } from '@capacitor/core';
import { isNativeBuild, isNativePlatform } from './platform';

/**
 * 音效资源路径（相对应用根）。
 *
 * <p>放在 `public/audio/` 而不是 `src/assets/`：DOM 回归等工装用 esbuild 直接
 * bundle 源码且没有 wav loader，`import '*.wav'` 会把测试链路一起炸掉。
 * 走 public 后，Vite 把同一份字节原样复制进 dist-web 与 dist-android，
 * 运行时再由 {@link resolveDeleteSoundUrl} 拼成绝对 URL —— 依旧完全离线。
 */
export const DELETE_SOUND_PATH = 'audio/delete-success.wav';

/**
 * 由页面 base URL 拼出音效绝对地址（纯函数，便于判定）。
 *
 * <p>本应用是 **hash 路由**，`location.pathname` 不会因为导航而改变，
 * 因此 `document.baseURI` 恒为应用根：浏览器里是 `http://host:port/`，
 * Capacitor 里是 `https://localhost/`。两种目标都能取到同一份离线资源。
 */
export function resolveDeleteSoundUrl(baseUri: string): string {
  try {
    return new URL(DELETE_SOUND_PATH, baseUri).href;
  } catch {
    return DELETE_SOUND_PATH;
  }
}

/** 运行时 base URL（拿不到就退回相对路径，绝不拼远程地址） */
function runtimeBaseUri(): string {
  try {
    if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  } catch {
    /* 忽略：下面走相对路径 */
  }
  return './';
}

/** 反馈通道（构建期+运行期共同决定，绝不混用） */
export type FeedbackChannel = 'native' | 'web';

/**
 * 通道判定（纯函数，四个组合都可判定）。
 * 与 `platform.ts` 的既有约定一致：只有"android 构建产物"**且**"确实在原生容器里"
 * 才走原生桥；两者任一不成立都退回 Web 通道，绝不在浏览器里假装调原生。
 */
export function resolveFeedbackChannel(input: {
  nativeBuild: boolean;
  nativePlatform: boolean;
}): FeedbackChannel {
  return input.nativeBuild && input.nativePlatform ? 'native' : 'web';
}

/** 一次成功音的最终结果（`played` 只代表**调用成功**，不代表用户听到） */
export interface DeleteSoundOutcome {
  status: 'played' | 'skipped' | 'failed';
  reason: string;
  channel: FeedbackChannel;
}

export interface PrepareHapticOutcome {
  vibrated: boolean;
  reason: string;
  channel: FeedbackChannel;
}

/* ── 纯判定：能不能放这次成功音 ───────────────────────────── */

export interface DeleteFeedbackDecisionInput {
  enabled: boolean;
  /** 当前页面绑定的 session（null 表示不在训练页） */
  boundSessionId: string | null;
  intentSessionId: string;
  itemId: string;
  token: string;
  visible: boolean;
  playedKeys: ReadonlySet<string>;
}

export interface DeleteFeedbackDecision {
  play: boolean;
  reason: string;
  /** 去重键：session + item + intent token */
  key: string;
}

/** 去重键生成（同一对象同一次意图才相等） */
export function deleteFeedbackKey(sessionId: string, itemId: string, token: string): string {
  return `${sessionId}\u0000${itemId}\u0000${token}`;
}

/**
 * 成功音的唯一门禁。
 *
 * <p>顺序固定且互相独立：没有 token 的调用本身就不是一次真实删除意图；
 * 关闭／未绑定／属于别的 session／页面不可见都属于"此刻不该响"；
 * 最后才看去重集合 —— 这样重试与重复回调都会被如实记为 `duplicate`。
 */
export function decideDeleteFeedback(input: DeleteFeedbackDecisionInput): DeleteFeedbackDecision {
  const key = deleteFeedbackKey(input.intentSessionId, input.itemId, input.token);
  if (!input.token) return { play: false, reason: 'no-token', key };
  if (!input.enabled) return { play: false, reason: 'disabled', key };
  if (!input.boundSessionId) return { play: false, reason: 'no-session', key };
  if (input.intentSessionId !== input.boundSessionId) return { play: false, reason: 'other-session', key };
  if (!input.visible) return { play: false, reason: 'hidden', key };
  if (input.playedKeys.has(key)) return { play: false, reason: 'duplicate', key };
  return { play: true, reason: 'allow', key };
}

/**
 * 原生播放结果 → 报告（**绝不**把"没有结果"当成已播放）。
 *
 * <p>这是 Android 侧"策略遵循"的唯一入口：只有原生明确回 `played === true`
 * 才算走过放行路径；`false` 是原生保守拒绝（静音/勿扰/后台/未加载好）；
 * 其它一切（undefined、异常、非布尔、桥不存在）都算失败，不允许乐观推断。
 */
export function interpretNativePlayResult(raw: unknown): { status: 'played' | 'skipped' | 'failed'; reason: string } {
  if (raw && typeof raw === 'object') {
    const rec = raw as { played?: unknown; reason?: unknown };
    const reason = typeof rec.reason === 'string' && rec.reason ? rec.reason : 'native-allowed';
    if (rec.played === true) return { status: 'played', reason };
    if (rec.played === false) return { status: 'skipped', reason };
  }
  return { status: 'failed', reason: 'native-no-result' };
}

/** F09 准备触感的门禁（与成功音开关无关；触感不可用只保留文字提示） */
export function decidePrepareHaptic(input: {
  boundSessionId: string | null;
  visible: boolean;
  channel: FeedbackChannel;
  bridgeAvailable: boolean;
  webVibrateAvailable: boolean;
}): { vibrate: boolean; reason: string } {
  if (!input.boundSessionId) return { vibrate: false, reason: 'no-session' };
  if (!input.visible) return { vibrate: false, reason: 'hidden' };
  if (input.channel === 'native') {
    return input.bridgeAvailable ? { vibrate: true, reason: 'native-allow' } : { vibrate: false, reason: 'no-bridge' };
  }
  return input.webVibrateAvailable ? { vibrate: true, reason: 'web-allow' } : { vibrate: false, reason: 'no-vibrate-api' };
}

/* ── 依赖注入点（生产用默认实现，测试用替身）──────────────── */

/** 最小 AudioContext 形状（避免测试里伪造整个浏览器音频栈） */
export interface AudioContextLike {
  state: string;
  resume(): Promise<void>;
  createBufferSource(): AudioBufferSourceLike;
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  destination: unknown;
}

export interface AudioBufferSourceLike {
  buffer: unknown;
  connect: (dest: unknown) => unknown;
  start(when?: number): void;
  stop(): void;
  onended: (() => void) | null;
}

/**
 * 原生桥形状（方法名与 DeletionFeedbackPlugin 的 @PluginMethod 一一对应）。
 *
 * <p>`owner`：本次播放/停止的**归属凭证**（F11-FIX1）。原生只允许"停自己"——
 * 一次迟到的旧 `stop({ owner })` 既不会推进别的意图的序号，也不会停掉新页面的流；
 * 页面级作废（离页/隐藏/关闭开关）仍然发不带 owner 的 `stop()`（整页收手）。
 */
export interface DeleteFeedbackNativeBridge {
  play: (options?: { owner?: string }) => Promise<unknown>;
  stop: (options?: { owner?: string }) => Promise<unknown>;
  prepareHaptic: () => Promise<unknown>;
}

export interface DeleteFeedbackDeps {
  channel: FeedbackChannel;
  /** 原生桥（延迟解析；channel==='native' 且解析失败 → null） */
  native: () => DeleteFeedbackNativeBridge | null;
  web: {
    createContext: () => AudioContextLike | null;
    loadAudio: () => Promise<ArrayBuffer>;
    /** 仅用于诊断展示，不参与判定 */
    url: string;
  };
  vibrate: ((ms: number) => boolean) | null;
  visible: () => boolean;
  onOutcome?: (outcome: DeleteSoundOutcome) => void;
}

/* ── 提交前凭证：成功音只属于"这一次删除提交" ───────────────── */

/**
 * 一次删除提交开始时捕获的音频归属凭证（F11-FIX1）。
 *
 * <p>为什么需要它：控制器只在 `notifySucceeded` **被调用时**捕获世代。若"删除
 * 事务开始 → 页面隐藏/失锁或离页 → 恢复同一 session → 旧 saved 才完成"，
 * 晚到的成功回调会拿到**新的**世代，被当成一次全新的成功音。凭证把"开始"
 * 那一刻的世代与绑定 session 固定下来，`saved` 出口必须带着它回来核对。
 *
 * <p>与 F10 的 `dissolveEpochAtStart` 同一套归属思路，但**不共享任何业务状态**：
 * 减少动态/消散是否播放与本凭证无关（`prefers-reduced-motion` 不是静音开关）。
 */
export interface DeleteFeedbackTicket {
  /** 捕获那一刻的控制器世代 */
  readonly epoch: number;
  /** 捕获那一刻绑定的 session（null = 当时不在训练页） */
  readonly sessionId: string | null;
  /** 本次提交的唯一凭证标识（仅用于诊断与日志，不参与去重） */
  readonly owner: string;
}

export interface DeleteTicketDecisionInput {
  /** 提交前捕获的凭证；缺省表示调用方没有捕获（按调用时刻兜底，见 notifySucceeded） */
  ticket: DeleteFeedbackTicket | null | undefined;
  /** 当前控制器世代 */
  currentEpoch: number;
  boundSessionId: string | null;
}

/**
 * 凭证是否仍然有效（纯函数，可离线判定）。
 *
 * <p>两条都必须成立：世代没变、绑定 session 没变。任何一条不成立都说明
 * "这次提交期间页面归属变过"，迟到的 saved 不能再响一次。
 *
 * <p>意图自己声明的 session 是否等于绑定 session，仍由
 * {@link decideDeleteFeedback} 的 `other-session` 判定负责（原因码保持稳定）。
 */
export function decideDeleteTicket(input: DeleteTicketDecisionInput): { ok: boolean; reason: string } {
  if (!input.ticket) return { ok: false, reason: 'no-ticket' };
  if (input.ticket.epoch !== input.currentEpoch) return { ok: false, reason: 'stale-epoch' };
  if (input.ticket.sessionId !== input.boundSessionId) return { ok: false, reason: 'stale-session' };
  return { ok: true, reason: 'allow' };
}

/* ── 去重范围：session 生命周期，而不是固定小容量 ─────────────── */

/**
 * 同时保留多少个 session 的去重记录（最近使用的若干个）。
 *
 * <p>按 **session** 淘汰，绝不按 token 淘汰：淘汰 session 只影响那个很久以前的
 * 页面，而淘汰单个旧 token 会让"已经响过的意图"重新可播（正是 F11-FIX1 的
 * 长序列失败）。有界性仍成立：session 数 ≤ 本值。
 */
export const MAX_TRACKED_DELETE_SESSIONS = 8;

/**
 * 单个 session 内最多精确记住多少个成功意图。
 *
 * <p>正常训练一次删除数远小于此值。真的超过时不淘汰旧 token、也不无限增长，
 * 而是**保守封顶**：此后新意图不再出声（fail-closed），因此"至多一次"永远成立，
 * 内存也永远有界。宁可少响一声，也不允许同一个意图响两声。
 */
export const MAX_TRACKED_DELETE_TOKENS_PER_SESSION = 4096;

/** 一个 session 的去重状态 */
interface SessionConsumption {
  /** 已经结算过的意图键（session + item + token） */
  keys: Set<string>;
  /** 超过上限后封顶：不再记录新键，也不再出声（绝不淘汰旧键造成重放） */
  saturated: boolean;
}

/** 空集合（未记录过的 session 用同一个只读空集合，避免每次分配） */
const NO_CONSUMED_KEYS: ReadonlySet<string> = new Set<string>();

/** 一次删除成功意图（token 由删除流程生成，同一意图同值） */
export interface DeleteFeedbackIntent {
  sessionId: string;
  itemId: string;
  token: string;
}

export interface DeleteFeedbackController {
  bind(sessionId: string): void;
  unbind(): void;
  setEnabled(value: boolean): void;
  isEnabled(): boolean;
  /**
   * 在**删除命令发出前**捕获本次提交的归属凭证。
   *
   * <p>调用方必须把它带到 `saved` 出口；控制器用它在真正出声前核对
   * "这次提交期间页面归属有没有变过"。
   */
  captureIntent(): DeleteFeedbackTicket;
  /**
   * 成功出口：只有真实 saved 后调用；同步返回判定结果，内部异步播放。
   *
   * @param ticket 提交前捕获的凭证；缺失时按调用时刻兜底（仅测试/历史调用方，
   *               生产接线必须传，见 f11-source-contract）。
   */
  notifySucceeded(intent: DeleteFeedbackIntent, ticket?: DeleteFeedbackTicket): DeleteSoundOutcome;
  /** 作废未播放/正在播放的反馈（离页、隐藏、卸载、失锁、切 session、关闭开关） */
  invalidate(reason: string): void;
  prepareHaptic(): PrepareHapticOutcome;
  lastOutcome(): DeleteSoundOutcome | null;
  /** 当前世代（诊断用；业务判定不得依赖它） */
  epochValue(): number;
  channel(): FeedbackChannel;
}

export function createDeleteFeedbackController(deps: DeleteFeedbackDeps): DeleteFeedbackController {
  let enabled = true;
  let boundSessionId: string | null = null;
  let epoch = 0;
  let lastOutcome: DeleteSoundOutcome | null = null;
  /** 提交凭证序号（只用于区分是哪一次提交，不参与去重） */
  let ticketSeq = 0;
  /** 原生播放归属序号（每次派发一个 owner，清理只认自己那个） */
  let nativeOwnerSeq = 0;
  /**
   * 当前仍归本控制器所有的那一次原生播放。
   *
   * <p>null = 没有在途的原生播放、或页面级作废已经整页收手。迟到的旧结果只有
   * 在自己仍是当前 owner 时才允许发 `stop`，否则会停掉新页面的声音。
   */
  let activeNativeOwner: string | null = null;
  /**
   * 按 session 结算的成功意图（Map 插入顺序 = 最近一次使用顺序）。
   *
   * <p>**不按 token 淘汰**：旧 token 一旦被淘汰就能被重放，那是错的行为。
   * 有界性由"最多保留 {@link MAX_TRACKED_DELETE_SESSIONS} 个 session"提供。
   */
  const consumedBySession = new Map<string, SessionConsumption>();

  let context: AudioContextLike | null = null;
  let buffer: unknown = null;
  let source: AudioBufferSourceLike | null = null;

  const finish = (outcome: DeleteSoundOutcome): DeleteSoundOutcome => {
    lastOutcome = outcome;
    try {
      deps.onOutcome?.(outcome);
    } catch {
      /* 观察者失败不影响反馈本身 */
    }
    return outcome;
  };

  const channel = (): FeedbackChannel => deps.channel;

  /** 世代/开关/归属/可见性全部仍有效才算"还没被作废" */
  const stillValid = (epochAtStart: number, sessionAtStart: string | null): boolean => {
    if (epoch !== epochAtStart) return false;
    if (!enabled) return false;
    if (boundSessionId === null || boundSessionId !== sessionAtStart) return false;
    try {
      return deps.visible();
    } catch {
      return false;
    }
  };

  const stopWeb = () => {
    const current = source;
    source = null;
    if (!current) return;
    try {
      current.stop();
    } catch {
      /* 已结束/已停止：忽略 */
    }
  };

  /**
   * 原生停止（页面级 / 归属级）——**同步异常与异步拒绝都必须就地吞掉**。
   *
   * <p>不裸 `void bridge.stop()`：`stop` 的 Promise 拒绝（插件已销毁、桥队列关闭、
   * 机型不支持）只能说明"这一声没停住"，绝不允许漏成 unhandledRejection 去污染
   * 删除事务、8 秒撤销与计时收尾。
   *
   * @param owner 传入时只停/作废**该 owner 自己**的意图与流；不传 = 整页收手
   */
  const stopNativeQuietly = (owner?: string): void => {
    if (deps.channel !== 'native') return;
    try {
      const bridge = deps.native();
      if (!bridge) return;
      const result = owner === undefined ? bridge.stop() : bridge.stop({ owner });
      // Promise.resolve 同时覆盖"返回 Promise"与"返回普通值/undefined"两种桥实现
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      /* 同步抛错同样隔离：停止失败不改变"已作废/已关闭"的语义 */
    }
  };

  /** 某个 session 已结算的意图键（没记录过就是同一个只读空集合） */
  const consumedKeysFor = (sessionId: string): ReadonlySet<string> =>
    consumedBySession.get(sessionId)?.keys ?? NO_CONSUMED_KEYS;

  /** 该 session 是否已封顶（超过精确记录上限后保守不再出声，绝不重放旧键） */
  const isConsumptionSaturated = (sessionId: string): boolean =>
    consumedBySession.get(sessionId)?.saturated === true;

  /**
   * 结算一个意图键：**先结算再播放**（即使随后播放失败也不再重试，避免"重试 → 两声"）。
   *
   * <p>淘汰只发生在 session 之间；同一个 session 内的旧键永不淘汰，
   * 因此"很久以前响过的意图"不会因为容量压力重新变成可播。
   */
  const rememberConsumed = (sessionId: string, key: string): void => {
    let entry = consumedBySession.get(sessionId);
    if (entry) consumedBySession.delete(sessionId);
    else entry = { keys: new Set<string>(), saturated: false };
    entry.keys.add(key);
    if (entry.keys.size > MAX_TRACKED_DELETE_TOKENS_PER_SESSION) entry.saturated = true;
    consumedBySession.set(sessionId, entry);
    while (consumedBySession.size > MAX_TRACKED_DELETE_SESSIONS) {
      const oldest = consumedBySession.keys().next();
      if (oldest.done) break;
      consumedBySession.delete(oldest.value);
    }
  };

  const playWeb = async (
    epochAtStart: number,
    sessionAtStart: string | null,
  ): Promise<DeleteSoundOutcome> => {
    let attemptSource: AudioBufferSourceLike | null = null;
    try {
      // 音频上下文与解码**只在成功出口内**创建：任何手势/挂载期都不预热，
      // 因此系统里不存在"提前解锁好的音频"可以冒充成功音。
      if (!context) {
        const created = deps.web.createContext();
        if (!created) return finish({ status: 'failed', reason: 'no-web-audio', channel: 'web' });
        context = created;
      }
      const ctx = context;
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /* 下面按真实 state 判定 */
        }
      }
      if (!stillValid(epochAtStart, sessionAtStart)) {
        return finish({ status: 'skipped', reason: 'invalidated', channel: 'web' });
      }
      if (ctx.state !== 'running') {
        return finish({ status: 'failed', reason: 'audio-context-not-running', channel: 'web' });
      }
      if (!buffer) {
        const bytes = await deps.web.loadAudio();
        if (!stillValid(epochAtStart, sessionAtStart)) {
          return finish({ status: 'skipped', reason: 'invalidated-before-decode', channel: 'web' });
        }
        buffer = await ctx.decodeAudioData(bytes);
      }
      if (!stillValid(epochAtStart, sessionAtStart)) {
        return finish({ status: 'skipped', reason: 'invalidated-after-load', channel: 'web' });
      }
      const node = ctx.createBufferSource();
      attemptSource = node;
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.onended = () => {
        if (source === node) source = null;
      };
      // 成功音只保留一个活动音源，页面清理不能漏掉前一声。
      stopWeb();
      source = node;
      node.start(0);
      return finish({ status: 'played', reason: 'web-audio', channel: 'web' });
    } catch (err) {
      // 旧的加载/解码失败只清理自己的音源，不能掐掉更晚的成功音。
      if (attemptSource !== null && source === attemptSource) stopWeb();
      return finish({
        status: 'failed',
        reason: `audio-error:${err instanceof Error ? err.message : 'unknown'}`,
        channel: 'web',
      });
    }
  };

  const playNative = async (
    epochAtStart: number,
    sessionAtStart: string | null,
    owner: string,
  ): Promise<DeleteSoundOutcome> => {
    try {
      const bridge = deps.native();
      if (!bridge) return finish({ status: 'failed', reason: 'no-native-bridge', channel: 'native' });
      if (!stillValid(epochAtStart, sessionAtStart)) {
        // 连 play 都没发出去：这个 owner 在原生侧不存在任何流，不发 stop
        if (activeNativeOwner === owner) activeNativeOwner = null;
        return finish({ status: 'skipped', reason: 'invalidated', channel: 'native' });
      }
      const raw = await bridge.play({ owner });
      // 原生侧在**实际播放时刻**重核策略并二次确认，迟到结果同样按世代作废。
      if (!stillValid(epochAtStart, sessionAtStart)) {
        /**
         * F11-FIX1：迟到的旧结果只能清理**自己那一次**。
         *
         * <p>native 只有一条播放流：如果更晚的意图已经接管（activeNativeOwner
         * 已不是自己），此时再发 stop 掐掉的就是**新页面**的声音 —— 这正是
         * root F11 第三例 stopped=[1,2]、新 owner current=0 的成因。
         * 因此只有"自己仍是当前 owner"时才发带 owner 的定向停止。
         */
        if (activeNativeOwner === owner) {
          activeNativeOwner = null;
          stopNativeQuietly(owner);
        }
        return finish({ status: 'skipped', reason: 'invalidated-after-native', channel: 'native' });
      }
      if (activeNativeOwner === owner) activeNativeOwner = null;
      const interpreted = interpretNativePlayResult(raw);
      return finish({ ...interpreted, channel: 'native' });
    } catch (err) {
      if (activeNativeOwner === owner) activeNativeOwner = null;
      return finish({
        status: 'failed',
        reason: `native-error:${err instanceof Error ? err.message : 'unknown'}`,
        channel: 'native',
      });
    }
  };

  return {
    bind(sessionId: string) {
      if (boundSessionId === sessionId) return;
      boundSessionId = sessionId;
      epoch += 1;
      stopWeb();
      // 归属换代：旧页面的在途原生播放不再被本控制器认领（清理只认自己的 owner）
      activeNativeOwner = null;
    },
    unbind() {
      boundSessionId = null;
      epoch += 1;
      stopWeb();
      activeNativeOwner = null;
    },
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      // 关闭/重开都推进世代：提交期间开关变过，旧凭证一律失效（不会补响）
      epoch += 1;
      stopWeb();
      // 页面级收手：不带 owner，意味着"整页这一次都不要出声了"
      activeNativeOwner = null;
      if (!value) stopNativeQuietly();
    },
    isEnabled: () => enabled,
    captureIntent() {
      ticketSeq += 1;
      return { epoch, sessionId: boundSessionId, owner: `delete-feedback-${ticketSeq}` };
    },
    notifySucceeded(intent: DeleteFeedbackIntent, ticket?: DeleteFeedbackTicket) {
      try {
        /**
         * F11-FIX1 凭证门禁：先核对"这次提交开始时的归属"。
         *
         * <p>没带凭证的调用（历史/测试替身）按调用时刻兜底，行为与旧实现一致；
         * 生产接线由 Session 在命令发出前捕获并带回来（见 f11-source-contract）。
         */
        const ticketDecision = decideDeleteTicket({
          ticket: ticket ?? { epoch, sessionId: boundSessionId, owner: 'implicit-at-call' },
          currentEpoch: epoch,
          boundSessionId,
        });
        if (!ticketDecision.ok) {
          return finish({ status: 'skipped', reason: ticketDecision.reason, channel: deps.channel });
        }
        const decision = decideDeleteFeedback({
          enabled,
          boundSessionId,
          intentSessionId: intent.sessionId,
          itemId: intent.itemId,
          token: intent.token,
          visible: (() => {
            try {
              return deps.visible();
            } catch {
              return false;
            }
          })(),
          playedKeys: consumedKeysFor(intent.sessionId),
        });
        if (!decision.play) {
          return finish({ status: 'skipped', reason: decision.reason, channel: deps.channel });
        }
        // 封顶后的 session 宁可少响一声，也绝不淘汰旧键造成"同一意图响两次"
        if (isConsumptionSaturated(intent.sessionId)) {
          return finish({ status: 'skipped', reason: 'dedup-saturated', channel: deps.channel });
        }
        // 先结算 token：即使随后播放失败也不再重试，避免"重试 → 两声"
        rememberConsumed(intent.sessionId, decision.key);
        const epochAtStart = epoch;
        const sessionAtStart = boundSessionId;
        if (deps.channel === 'native') {
          nativeOwnerSeq += 1;
          const owner = `native-${nativeOwnerSeq}`;
          activeNativeOwner = owner;
          void playNative(epochAtStart, sessionAtStart, owner);
        } else {
          void playWeb(epochAtStart, sessionAtStart);
        }
        return { status: 'played', reason: 'dispatched', channel: deps.channel };
      } catch (err) {
        return finish({
          status: 'failed',
          reason: `dispatch-error:${err instanceof Error ? err.message : 'unknown'}`,
          channel: deps.channel,
        });
      }
    },
    invalidate(reason: string) {
      epoch += 1;
      stopWeb();
      // 整页作废：本控制器不再认领任何在途原生播放，并让原生整页收手
      activeNativeOwner = null;
      stopNativeQuietly();
      // 只记录"为什么作废"，不产生假播放结论
      lastOutcome = { status: 'skipped', reason: `invalidated:${reason}`, channel: deps.channel };
    },
    prepareHaptic() {
      try {
        const bridge = deps.channel === 'native' ? deps.native() : null;
        const decision = decidePrepareHaptic({
          boundSessionId,
          visible: (() => {
            try {
              return deps.visible();
            } catch {
              return false;
            }
          })(),
          channel: deps.channel,
          bridgeAvailable: Boolean(bridge),
          webVibrateAvailable: typeof deps.vibrate === 'function',
        });
        if (!decision.vibrate) {
          return { vibrated: false, reason: decision.reason, channel: deps.channel };
        }
        if (deps.channel === 'native') {
          // 原生：策略在 Java 侧用真实 AudioManager/NotificationManager 判定。
          // Promise.resolve 覆盖"返回 Promise / 返回普通值"两种桥实现，拒绝一律隔离。
          void Promise.resolve(bridge?.prepareHaptic()).catch(() => undefined);
          return { vibrated: true, reason: decision.reason, channel: 'native' };
        }
        let ok = false;
        try {
          ok = deps.vibrate ? deps.vibrate(20) === true : false;
        } catch {
          ok = false;
        }
        return { vibrated: ok, reason: ok ? 'web-vibrate' : 'web-vibrate-failed', channel: 'web' };
      } catch (err) {
        return {
          vibrated: false,
          reason: `haptic-error:${err instanceof Error ? err.message : 'unknown'}`,
          channel: deps.channel,
        };
      }
    },
    lastOutcome: () => lastOutcome,
    epochValue: () => epoch,
    channel,
  };
}

/* ── 生产默认实例 ─────────────────────────────────────────── */

let bridgeInstance: DeleteFeedbackNativeBridge | null = null;
let bridgeResolved = false;

/** 解析原生桥（与 RestReminder 一样：只有 android 构建 + 原生容器才注册） */
function resolveNativeBridge(): DeleteFeedbackNativeBridge | null {
  if (bridgeResolved) return bridgeInstance;
  bridgeResolved = true;
  if (!(isNativeBuild && isNativePlatform())) {
    bridgeInstance = null;
    return null;
  }
  try {
    bridgeInstance = registerPlugin<DeleteFeedbackNativeBridge>('DeletionFeedback');
  } catch {
    bridgeInstance = null;
  }
  return bridgeInstance;
}

function defaultDeps(): DeleteFeedbackDeps {
  const webAudio = globalThis as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  return {
    channel: resolveFeedbackChannel({ nativeBuild: isNativeBuild, nativePlatform: isNativePlatform() }),
    native: resolveNativeBridge,
    web: {
      createContext: () => {
        const Ctor = webAudio.AudioContext ?? webAudio.webkitAudioContext;
        if (!Ctor) return null;
        try {
          return new Ctor();
        } catch {
          return null;
        }
      },
      loadAudio: async () => {
        const res = await fetch(resolveDeleteSoundUrl(runtimeBaseUri()));
        if (!res.ok) throw new Error(`音频资源读取失败（HTTP ${res.status}）`);
        return res.arrayBuffer();
      },
      url: DELETE_SOUND_PATH,
    },
    vibrate:
      typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
        ? (ms: number) => navigator.vibrate(ms)
        : null,
    visible: () => (typeof document === 'undefined' ? false : document.visibilityState === 'visible'),
  };
}

/** 全应用唯一实例（Session 页绑定/解绑；设置页可随时关闭） */
export const deleteFeedback: DeleteFeedbackController = createDeleteFeedbackController(defaultDeps());

/**
 * 便捷别名：成功出口（唯一调用点在 Session 的 saved 分支）。
 *
 * <p>生产接线必须带上 {@link captureDeleteFeedbackIntent} 在**命令发出前**取到的
 * 凭证，迟到 saved 才不会在新世代下被当成一次新的成功。
 */
export function notifyDeleteSucceeded(
  intent: DeleteFeedbackIntent,
  ticket?: DeleteFeedbackTicket,
): DeleteSoundOutcome {
  return deleteFeedback.notifySucceeded(intent, ticket);
}

/**
 * 便捷别名：删除命令**发出前**捕获本次提交的音频归属凭证。
 *
 * <p>纯读、无副作用、不碰音频；取不到也不影响删除本身（控制器会保守判定为失效）。
 */
export function captureDeleteFeedbackIntent(): DeleteFeedbackTicket {
  return deleteFeedback.captureIntent();
}

/** 便捷别名：作废未播放反馈 */
export function invalidateDeleteFeedback(reason: string): void {
  deleteFeedback.invalidate(reason);
}

/** 便捷别名：同步音效开关（关闭时内部会立即停止） */
export function setDeleteFeedbackEnabled(value: boolean): void {
  deleteFeedback.setEnabled(value);
}

/** 便捷别名：F09 准备触感（native/web 互斥，单通道） */
export function playPrepareHaptic(): PrepareHapticOutcome {
  return deleteFeedback.prepareHaptic();
}

/** 诊断用：当前实际通道 */
export function deleteFeedbackChannel(): FeedbackChannel {
  return deleteFeedback.channel();
}

/** 便捷别名：绑定当前页面所属 session（换 session/卸载时由调用方解绑） */
export function bindDeleteFeedback(sessionId: string): void {
  deleteFeedback.bind(sessionId);
}
