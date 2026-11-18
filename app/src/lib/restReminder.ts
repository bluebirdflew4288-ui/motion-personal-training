/* 需求 2：组间休息到时提醒的 **JS ↔ 原生** 接线。
   ── 设计要点 ────────────────────────────────────────────────
   1. 原生插件是本仓库内的本地插件（android/.../RestReminderPlugin.java），
      不引入 @capacitor/local-notifications（离线无法安装，且本插件语义更贴合需求）。
   2. **页面不是提醒的唯一来源**：页面 JS interval 在后台会被节流/冻结，
      因此"到时"由原生 AlarmManager 负责；页面只负责：
        · 排程/取消/暂停/加减时间时同步原生；
        · 前台时自己判断到点（并 consume 原生提醒，避免双重震动）。
   3. 浏览器 / Web 版没有原生能力：所有函数安全降级为 no-op，
      并通过 `restReminderCapability()` 如实报告「不可用」，不假装已排程。
   4. 所有返回值都是**真实结果**：原生拒绝排程时返回 scheduled:false，
      调用方据此提示真实降级状态（不能把"弹过权限框"写成"已获准"）。 */

import { registerPlugin } from '@capacitor/core';
import { isNativeBuild, isNativePlatform } from './platform';

/** 原生插件返回的排程结果（与 Java 侧 JSObject 字段一一对应） */
export interface RestScheduleResult {
  scheduled: boolean;
  exact: boolean;
  reason?: string;
  triggerAtMs?: number;
  /**
   * 原生当前**用户意图水位**（B4-R3 closure 附加字段）。
   *
   * <p>成功排程时是本次身份的水位；被拒（尤其 `stale-intent`）时是原生
   * **现有身份**的水位。JS 用它把意图序号与原生对齐，并在落后时
   * 用「水位 + 1」重发这一次用户意图 —— 否则会出现
   * 「界面已延长、原生仍按旧截止」的静默分叉。
   *
   * <p>旧原生不返回该字段 → undefined，调用方必须容忍。
   */
  lastIntentId?: number;
  notificationsGranted?: boolean;
  dozeCaveat?: boolean;
  /**
   * 本次排程的代次：后续 cancel/consume 必须带上它，旧代次操作会被原生拒绝。
   *
   * 注意：**任何 scheduled:true 的路径都必须带它**，包括精确调度抛
   * SecurityException 后的不精确降级。缺了它控制器就认为"代次未知"，
   * 暂停/停止将无法按身份取消原生提醒（G2 接线缺口）。
   */
  generation?: number;
  /** 本次排程使用的通知 id（诊断用） */
  notifId?: number;
  /**
   * 实际走的排程路径：
   * · `exact` 精确；
   * · `inexact-no-permission` 一开始就没有精确闹钟权限（正常降级）；
   * · `exact-denied-fallback-inexact` 精确调用抛 SecurityException 后降级成功；
   * · `exact-denied-fallback-failed` 降级也失败（此时 scheduled:false）。
   */
  path?: string;
  /** 精确调用是否真的抛过 SecurityException（与"一开始就没权限"区分） */
  exactDenied?: boolean;
  appNotificationsEnabled?: boolean;
  channelEnabled?: boolean;
  channelVibrates?: boolean;
  /**
   * 当前段前台计时增强的真实结果（A2）。
   *
   * `started` = 已启用；其余值是**未启用的具体原因**
   * （`no-exact-permission` / `notifications-unreachable` / `api-too-low` /
   * `start-failed:*` / `not-attempted`）。
   * 它与 `scheduled` 是两个独立事实：排程可以成功而增强未启用。
   */
  foregroundEnhancement?: string;
}

/** 原生能力与授权状态 */
export interface RestReminderStatus {
  /** 本次构建是否带原生能力（android 构建 + 运行时确实在原生容器） */
  available: boolean;
  /** 通知运行时权限（Android 13+） */
  notificationsGranted: boolean;
  /** App 通知总开关（系统设置里关掉整个 App 的通知） */
  appNotificationsEnabled: boolean;
  /** 渠道未被关闭（IMPORTANCE_NONE 视为关闭） */
  channelEnabled: boolean;
  /** 渠道允许震动 */
  channelVibrates: boolean;
  /**
   * 渠道**配置了声音**（B4-R2：用户明确要"声音＋震动"）。
   *
   * 与 canSound 分开：这是渠道真实配置值（用户可在系统里单独关掉），
   * 不能因为"我们建渠道时设了提示音"就当成已就绪。
   */
  channelSound: boolean;
  /**
   * 到点是否可能**出声**（权限 + 总开关 + 渠道 + 渠道声音）。
   *
   * 与 canVibrate 对称；都不等于"一定会响/一定震动"。
   */
  canSound: boolean;
  /**
   * 用户**提醒总开关意图**（B4-R2）。
   *
   * 与"系统是否就绪"是两个独立事实：checked 不代表已授权，
   * 权限允许也不代表用户想被提醒。UI 必须分开展示。
   */
  reminderEnabled: boolean;
  /** 综合：后台提醒是否真正可能触达用户（权限 + 总开关 + 渠道） */
  canAlert: boolean;
  /**
   * 到点是否可能**震动**（渠道允许震动 + 渠道未被关 + 总开关开着）。
   *
   * 与 canAlert 分开：旧实现只把 canAlert 说成"可以提醒"，
   * 用户已开通知与震动却仍可能只看到通知不震动，因此必须单独说清。
   */
  canVibrate: boolean;
  /**
   * 原生是否**保证**到点送达/震动 —— 恒为 false。
   *
   * 保留这个字段是为了让 UI 不能把"权限都开着"写成"一定会提醒"：
   * 系统 Doze 频率限制、OEM 后台策略、渠道震动被单独关闭、DND
   * 都可能让提醒推迟或无声。
   */
  deliveryGuaranteed: false;
  /** 最近的本机有界诊断事件（时刻/类型/短原因，不含 token 或训练内容） */
  recentDiag: string[];
  /** 精确闹钟授权（关闭时降级为不精确调度） */
  exactAlarmsGranted: boolean;
  sdkInt: number;
  /** 深度 Doze 下系统会限制 allowWhileIdle 闹钟频率，不能承诺准点 */
  dozeCaveat: boolean;
}

interface RestReminderPluginShape {
  getActive(): Promise<{
    active: boolean;
    token: string | null;
    generation: number;
    fired: boolean;
    /** 附加字段（旧原生可能没有）：当前身份的用户意图水位 */
    lastIntentId?: number;
  }>;
  /** Wave 1B.2：按身份对账持久化状态（识别用户在系统通知栏主动点「取消」） */
  inspectIdentity?: (options: {
    token: string;
    generation?: number | null;
  }) => Promise<{
    status?: string;
    token?: string | null;
    generation?: number;
    fired?: boolean;
  }>;
  getStatus(): Promise<{
    notificationsGranted: boolean;
    appNotificationsEnabled?: boolean;
    channelEnabled?: boolean;
    channelVibrates?: boolean;
    channelSound?: boolean;
    canSound?: boolean;
    reminderEnabled?: boolean;
    canAlert?: boolean;
    exactAlarmsGranted: boolean;
    sdkInt: number;
    dozeCaveat: boolean;
    canVibrate?: boolean;
    deliveryGuaranteed?: boolean;
    recentDiag?: string[];
  }>;
  requestNotificationPermission(): Promise<{ notificationsGranted: boolean }>;
  /** B4-R2：提醒总开关（意图）。关闭时原生会 durable 取消并让旧到达无声无震。 */
  setReminderEnabled?: (o: { enabled: boolean }) => Promise<{
    ok: boolean;
    enabled: boolean;
    cancelled?: boolean;
    reason?: string;
  }>;
  getReminderEnabled?: () => Promise<{ enabled: boolean }>;
  schedule(options: {
    token: string;
    remainingMs: number;
    origin?: RestScheduleOrigin;
    /**
     * B4-R2：**发起时的绝对目标截止**（墙钟毫秒）。
     *
     * 传了它，原生必须尊重它（扣掉 JS→Plugin 排队耗时），
     * 不再用"入口时刻 + remainingMs"重新起算。
     */
    deadlineAtMs?: number;
    /**
     * B4-R2：**用户新意图编号**（严格递增）。
     *
     * 0/缺省表示"不是明确的用户新意图"——原生会保持 already-fired 门禁。
     * 归零后用户明确加时必须携带更大的编号，原生才会在同一 token 上
     * 建立新的可投递身份；旧编号重放一律被拒。
     */
    intentId?: number;
  }): Promise<RestScheduleResult>;
  cancel(options?: { token?: string; generation?: number }): Promise<{
    cancelled: boolean;
    reason?: string;
  }>;
  vibrateNow(): Promise<{ vibrated: boolean }>;
  /** B3：打开系统设置页（受限目标枚举） */
  openRestReminderSettings?: (o: { target: SettingsTarget }) => Promise<{
    opened: boolean;
    requestedTarget?: string | null;
    actualTarget?: string | null;
    reason?: string;
  }>;
}

let plugin: RestReminderPluginShape | null = null;
let registered = false;

/** 原生提醒是否可用：构建目标 android 且运行时在原生容器里 */
export function hasRestReminder(): boolean {
  return isNativeBuild && isNativePlatform();
}

function getPlugin(): RestReminderPluginShape | null {
  if (!hasRestReminder()) return null;
  if (registered) return plugin;
  registered = true;
  try {
    plugin = registerPlugin<RestReminderPluginShape>('RestReminder');
  } catch {
    plugin = null; // 插件不可用：保持 no-op，不假装成功
  }
  return plugin;
}

/** 读取真实授权状态；不可用时返回 available:false（调用方必须如实展示） */
export async function restReminderCapability(): Promise<RestReminderStatus> {
  const unavailable: RestReminderStatus = {
    available: false,
    notificationsGranted: false,
    appNotificationsEnabled: false,
    channelEnabled: false,
    channelVibrates: false,
    channelSound: false,
    canSound: false,
    reminderEnabled: true,
    canAlert: false,
    canVibrate: false,
    deliveryGuaranteed: false,
    recentDiag: [],
    exactAlarmsGranted: false,
    sdkInt: 0,
    dozeCaveat: true,
  };
  const p = getPlugin();
  if (!p) return unavailable;
  try {
    const s = await p.getStatus();
    const perm = Boolean(s.notificationsGranted);
    const appOn = Boolean(s.appNotificationsEnabled);
    const chOn = Boolean(s.channelEnabled);
    const chVib = Boolean(s.channelVibrates);
    const chSound = Boolean(s.channelSound);
    return {
      available: true,
      notificationsGranted: perm,
      appNotificationsEnabled: appOn,
      channelEnabled: chOn,
      channelVibrates: chVib,
      channelSound: chSound,
      canSound: typeof s.canSound === 'boolean' ? s.canSound : perm && appOn && chOn && chSound,
      reminderEnabled: typeof s.reminderEnabled === 'boolean' ? s.reminderEnabled : true,
      // 以原生 canAlert 为准；原生未提供时按三项合取计算，绝不乐观默认 true
      canAlert: typeof s.canAlert === 'boolean' ? s.canAlert : perm && appOn && chOn,
      /**
       * A2 缺口 #5：震动能力必须**包含通知许可交集**。
       *
       * 通知整体不可达（无 POST_NOTIFICATIONS / 总开关关 / 渠道关）时，
       * 到点不会有任何通知，自然也不能声称"可能会震动"。
       * 旧实现漏了 perm，受控组合下会得出 canAlert=false 却 canVibrate=true 的矛盾结论。
       */
      canVibrate:
        typeof s.canVibrate === 'boolean' ? s.canVibrate : perm && appOn && chOn && chVib,
      deliveryGuaranteed: false,
      recentDiag: Array.isArray(s.recentDiag)
        ? s.recentDiag.filter((x): x is string => typeof x === 'string').slice(-16)
        : [],
      exactAlarmsGranted: Boolean(s.exactAlarmsGranted),
      sdkInt: Number(s.sdkInt) || 0,
      dozeCaveat: Boolean(s.dozeCaveat),
    };
  } catch {
    return unavailable;
  }
}

/** 原生侧当前持有的提醒身份（REVIEW-3 #1：恢复时核验未知代次用） */
export interface RestActiveIdentity {
  available: boolean;
  active: boolean;
  token: string | null;
  generation: number;
  fired: boolean;
  /**
   * 当前身份的**用户意图水位**（B4-R3 closure 附加字段）。
   *
   * <p>旧原生不返回该字段 → undefined，调用方必须容忍（不能据此误判）。
   * 用途：页面重挂后若快照没有水位（旧数据），用它把 JS 的意图序号抬到原生水平，
   * 否则下一次 +15 会被原生判成旧意图重放。
   */
  lastIntentId?: number;
}

/**
 * 向原生核实"当前是否真的有一条提醒、它的 token 与代次是什么"。
 *
 * 用途：页面在 `start()` 写快照时 ack 尚未返回，快照里 generation 可能是 null；
 * 若此时重建，必须**向原生核对**才能安全接管或按身份取消，
 * 而不是"保守地什么都不做"（那会导致暂停后仍提醒）。
 */
export async function getActiveRest(): Promise<RestActiveIdentity> {
  const p = getPlugin();
  if (!p) {
    return { available: false, active: false, token: null, generation: 0, fired: false };
  }
  try {
    const r = await p.getActive();
    return {
      available: true,
      active: Boolean(r.active),
      token: typeof r.token === 'string' && r.token ? r.token : null,
      generation: typeof r.generation === 'number' && Number.isFinite(r.generation) ? r.generation : 0,
      fired: Boolean(r.fired),
      /**
       * 只透传有限非负整数；缺失/非法一律 undefined（旧原生兼容）。
       * 绝不默认成 0 之外的猜测值。
       */
      lastIntentId:
        typeof r.lastIntentId === 'number' &&
        Number.isFinite(r.lastIntentId) &&
        r.lastIntentId > 0
          ? Math.floor(r.lastIntentId)
          : undefined,
    };
  } catch {
    return { available: false, active: false, token: null, generation: 0, fired: false };
  }
}

export type RestIdentityStatus =
  | 'active'
  | 'fired'
  | 'cancelled_by_user'
  | 'cancelled'
  | 'unknown';

/**
 * Wave 1B.2：向原生对账指定 (token, generation) 是否已被用户在通知栏主动取消。
 */
export async function inspectRestIdentity(identity: {
  token: string;
  generation?: number | null;
}): Promise<{ available: boolean; status: RestIdentityStatus }> {
  const p = getPlugin();
  if (!p || typeof p.inspectIdentity !== 'function' || !identity.token) {
    return { available: false, status: 'unknown' };
  }
  try {
    const payload: { token: string; generation?: number } = { token: identity.token };
    if (typeof identity.generation === 'number' && Number.isFinite(identity.generation) && identity.generation >= 0) {
      payload.generation = Math.floor(identity.generation);
    }
    const r = await p.inspectIdentity(payload);
    const s = r.status;
    if (
      s === 'active' ||
      s === 'fired' ||
      s === 'cancelled_by_user' ||
      s === 'cancelled' ||
      s === 'unknown'
    ) {
      return { available: true, status: s };
    }
    return { available: true, status: 'unknown' };
  } catch {
    return { available: false, status: 'unknown' };
  }
}

/** 请求通知权限（Android 13+）；返回真实结果，不假设用户已同意 */
export async function requestRestNotificationPermission(): Promise<boolean> {
  const p = getPlugin();
  if (!p) return false;
  try {
    const r = await p.requestNotificationPermission();
    return Boolean(r.notificationsGranted);
  } catch {
    return false;
  }
}

/**
 * 排一个到时提醒。
 * @returns 真实排程结果；原生不可用时 scheduled:false 且 reason='not-native'
 */
/**
 * 排程来源（A3 #3）：只有 `user-*` 才允许启动当前段前台增强。
 *
 * 自动恢复（snapshot-restore）、adopt、focus/getActive 查询都必须传非 user 值，
 * 否则就是"后台偷偷启动前台服务"。
 */
export type RestScheduleOrigin =
  | 'user-start'
  | 'user-resume'
  | 'user-adjust'
  | 'snapshot-restore'
  | 'adopt'
  | 'query';

export async function scheduleRestReminder(
  token: string,
  remainingMs: number,
  origin: RestScheduleOrigin = 'query',
  /**
   * B4-R2 优先级一 #1：**发起时的绝对目标截止**。
   *
   * 缺省不传时退回旧的"剩余量"语义（原生用入口时刻 + remainingMs），
   * 那条路径会把桥接排队耗时算进休息时长，表现为"UI 归零后过一会才响"。
   * 所有用户可见的计时入口都必须传它。
   */
  deadlineAtMs?: number,
  intentId?: number,
): Promise<RestScheduleResult> {
  const p = getPlugin();
  if (!p) return { scheduled: false, exact: false, reason: 'not-native' };
  try {
    const payload: {
      token: string;
      remainingMs: number;
      origin: RestScheduleOrigin;
      deadlineAtMs?: number;
      intentId?: number;
    } = {
      token,
      remainingMs: Math.max(0, Math.round(remainingMs)),
      /**
       * 缺省 `query` 是**刻意保守**：调用点必须显式声明这是用户操作，
       * 否则不授予 FGS 启动许可。
       */
      origin,
    };
    // 只透传有限正数；NaN/Infinity/0/负值一律不传，避免原生建出荒唐截止
    if (typeof deadlineAtMs === 'number' && Number.isFinite(deadlineAtMs) && deadlineAtMs > 0) {
      payload.deadlineAtMs = Math.round(deadlineAtMs);
    }
    /**
     * B4-R2：意图编号同样只透传有限正整数。
     * 不传 = 原生保持旧门禁（同 token 已 fired 一律拒绝），
     * 从而"旧请求重放"不会重新响铃。
     */
    if (typeof intentId === 'number' && Number.isFinite(intentId) && intentId > 0) {
      payload.intentId = Math.floor(intentId);
    }
    return await p.schedule(payload);
  } catch {
    return { scheduled: false, exact: false, reason: 'plugin-error' };
  }
}

/**
 * 取消提醒（暂停 / 跳过 / 结束训练 / 新一轮）。
 *
 * 传入 identity 时只有**当前代次**才会真正取消：旧 A 的取消请求延迟到达时
 * 不会误取消已经排好的 B（第二轮补充 P1 #1）。
 * 不传 identity 表示显式全清（结束训练等）。
 *
 * @returns 是否真的取消了（写盘失败或陈旧请求都会返回 false）
 */
export async function cancelRestReminder(identity?: {
  token: string;
  generation: number;
}): Promise<boolean> {
  const p = getPlugin();
  if (!p) return false;
  try {
    const r = await p.cancel(
      identity ? { token: identity.token, generation: identity.generation } : {},
    );
    return Boolean(r.cancelled);
  } catch {
    return false;
  }
}

/*
  说明：consumeRestReminder 已移除（REVIEW-1 #3）。
  页面到点只更新界面，提醒完全由原生 receiver 按身份发出；
  原 API 在原生侧从当前状态自补代次，无法核验调用者凭据，属假门禁。
  如将来需要，必须携带 token + generation 并核验。
*/

/** 立即震动（前台路径） */
export async function vibrateNow(): Promise<void> {
  const p = getPlugin();
  if (!p) return;
  try {
    await p.vibrateNow();
  } catch {
    // 震动不可用不阻断 UI
  }
}

/**
 * 停止"当前段前台计时增强"（暂停 / 跳过 / 完成 / 替换 / 结束训练）。
 *
 * <p>只停可见计时服务与有界锁；**不影响**原有取消/提醒语义，
 * 失败也不阻断 UI 流程（原生侧服务可能本来就没启动）。
 */
export async function stopForegroundRestTimer(
  reason: string,
  identity?: { token: string; generation: number },
): Promise<boolean> {
  /**
   * A4 #2：**fail-closed** —— 没有合法身份就拒绝，不再无身份清当前资源。
   *
   * <p>实证的失败序列正是通过这个入口在"cancel 持久化失败、身份被正确保留"之后
   * 无条件停掉 FGS 与锁。现在必须带身份；无身份一律返回 false 且不产生副作用。
   * 显式全清走原有的 cancel(full-clear) 路径，不经这里。
   */
  if (!identity || typeof identity.token !== 'string' || !identity.token
      || typeof identity.generation !== 'number' || !Number.isFinite(identity.generation)) {
    return false;
  }
  const p = getPlugin();
  if (!p) return false;
  const withStop = p as RestReminderPluginShape & {
    stopForegroundTimer?: (o: {
      reason: string;
      token: string;
      generation: number;
    }) => Promise<{ stopped: boolean }>;
  };
  if (typeof withStop.stopForegroundTimer !== 'function') return false;
  try {
    const r = await withStop.stopForegroundTimer({
      reason,
      token: identity.token,
      generation: identity.generation,
    });
    return Boolean(r.stopped);
  } catch {
    return false;
  }
}

/**
 * 可跳转的系统设置目标（B3）。
 *
 * **严格受限**：JS 只能传这三个值；不能传任意 Intent action/URI/package/channelId。
 * 包名与渠道名由原生侧固定取本 App 常量。
 */
export type SettingsTarget = 'app-notifications' | 'rest-channel' | 'exact-alarm';

export interface OpenSettingsResult {
  /**
   * **只表示系统接受了打开请求**，不是授权结果。
   * 绝不能据此把任何权限字段置为 true 或提示"已允许"。
   */
  opened: boolean;
  requestedTarget?: string | null;
  /** 实际打开的目标（可能因 fallback 与请求不同） */
  actualTarget?: string | null;
  /** 失败/降级原因（短字符串，供 UI 决定提示） */
  reason?: string;
}

/**
 * 打开休息提醒相关的系统设置页。
 *
 * <p>只发受限 Intent，**不触碰**任何提醒状态：不 schedule/cancel、
 * 不改 token/generation/deadline、不启停 FGS、不持锁、不改训练数据。
 *
 * @returns 真实结果；原生不可用/无该方法时 `opened:false` + `reason:'not-native'`
 */
export async function openRestReminderSettings(
  target: SettingsTarget,
): Promise<OpenSettingsResult> {
  const p = getPlugin();
  if (!p) return { opened: false, reason: 'not-native' };
  const fn = (p as RestReminderPluginShape).openRestReminderSettings;
  if (typeof fn !== 'function') return { opened: false, reason: 'not-implemented' };
  try {
    const r = await fn({ target });
    return {
      opened: Boolean(r.opened),
      requestedTarget: r.requestedTarget ?? target,
      actualTarget: r.actualTarget ?? null,
      reason: r.reason,
    };
  } catch {
    return { opened: false, requestedTarget: target, reason: 'plugin-error' };
  }
}

/**
 * B4-R2：设置**提醒总开关**（用户意图）。
 *
 * <p>语义边界（与原生一致，UI 必须照此展示）：
 * <ul>
 *   <li>只写意图，**不申请权限**、不打开系统页；</li>
 *   <li>关闭时原生 durable 取消当前提醒并停静默服务，
 *       已排队的旧 receiver / 旧 FGS 到期后无声无震；</li>
 *   <li>关闭**不影响倒计时**；</li>
 *   <li>持久化失败返回 ok:false 且 enabled 是**真实**当前值，绝不假报成功。</li>
 * </ul>
 *
 * @returns 真实结果；原生不可用时 ok:false / reason:'not-native'
 */
export async function setRestReminderEnabled(enabled: boolean): Promise<{
  ok: boolean;
  enabled: boolean;
  cancelled?: boolean;
  reason?: string;
}> {
  const p = getPlugin();
  if (!p) return { ok: false, enabled: !enabled ? true : false, reason: 'not-native' };
  const fn = p.setReminderEnabled;
  if (typeof fn !== 'function') {
    return { ok: false, enabled: true, reason: 'not-implemented' };
  }
  try {
    const r = await fn({ enabled });
    return {
      ok: Boolean(r.ok),
      enabled: Boolean(r.enabled),
      cancelled: typeof r.cancelled === 'boolean' ? r.cancelled : undefined,
      reason: r.reason,
    };
  } catch {
    return { ok: false, enabled: true, reason: 'plugin-error' };
  }
}

/** 读取当前提醒总开关意图（原生真源） */
export async function getRestReminderEnabled(): Promise<boolean | null> {
  const p = getPlugin();
  if (!p) return null;
  const fn = p.getReminderEnabled;
  if (typeof fn !== 'function') return null;
  try {
    const r = await fn();
    return Boolean(r.enabled);
  } catch {
    return null;
  }
}

/** 生成一次休息的唯一 token（与原生侧去重配合） */
export function newRestToken(): string {
  return `rest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
