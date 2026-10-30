/* 设置：主题、备份导出/导入、数据说明。
   恢复是「完整覆盖」，导入前必须先预览并显式确认，且保留恢复前快照。 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import {
  BACKUP_VERSION,
  CURRENT_APP_VERSION,
  getPreRestoreSnapshot,
  restoreBackup,
  snapshotBeforeRestore,
  validateBackup,
  type BackupPayload,
  type RestorePreview,
} from '../db/repo';
import {
  fileSizeLabel,
  parseJsonText,
  pickBackupViaNative,
  readJsonFile,
  usesNativeFileUi,
  type ExportOutcome,
} from '../lib/backupFile';
import { coordinateBackupExport } from '../lib/backupCoordinator';
import { fmtDateWithWeek, fmtTime } from '../lib/format';
import {
  installRestoredExportHandler,
  type RestoredExportResult,
} from '../lib/exportRestore';
import { isNativeBuild } from '../lib/platform';
import { AppLifecycleCoordinator } from '../lib/appLifecycle';
import { sessionKindOf } from '../domain/sessionKind';
import {
  hasRestReminder,
  openRestReminderSettings,
  setRestReminderEnabled,
  requestRestNotificationPermission,
  restReminderCapability,
  type RestReminderStatus,
  type SettingsTarget,
} from '../lib/restReminder';

/* 复用 repo 的单一真源（第4阶段对齐候选 0.1.3；不再各写一份） */
const APP_VERSION = CURRENT_APP_VERSION;

/**
 * 把原生的有界诊断行（`<atMs>|<kind>|<detail>`）翻译成一句人话。
 *
 * 只做展示：不改变、不推断、不美化。看不懂的行原样显示，
 * 免得把"没记录"误读成"没问题"。
 */
function diagLabel(line: string): string {
  const parts = line.split('|');
  const at = Number(parts[0]);
  const kind = parts[1] ?? '';
  const detail = parts[2] ?? '';
  const when = Number.isFinite(at) && at > 0 ? fmtTime(at) : '—';
  /**
   * A2 缺口 #4：`cancel` 事件带 `rejected` 时**绝不能**显示成"已取消"。
   * 旧实现无脑套 `已取消（${detail}）`，于是 cancelled=false 被读成"已取消（rejected）"，
   * 与实际相反。这里按真实结果分支，只有真取消才用"已取消"。
   */
  const text: Record<string, string> = {
    schedule: `已排程（${detail}）`,
    'schedule-failed': `排程失败（${detail}）`,
    fire: '到点广播已到达，已记录',
    'fire-rejected': `广播未处理（${detail}）`,
    'notify-ok': '已调用系统通知接口（不代表已展示或已震动）',
    'notify-blocked': `未调用通知（${detail}）`,
    'notify-error': `通知调用出错（${detail}）`,
  };
  if (kind === 'cancel') {
    return `${when} ${detail === 'rejected' ? '取消被拒绝（未取消）' : `已取消（${detail}）`}`.trim();
  }
  return `${when} ${text[kind] ?? `${kind} ${detail}`}`.trim();
}

/**
 * 休息提醒状态行（B3）。
 *
 * 未允许项右侧给**就近短按钮**；已开启项不显示"去开启"（避免重复引导）。
 * `opened` 只代表系统接受打开请求，不代表已授权 —— 本组件不写任何权限状态。
 */
function RestStatusRow({
  label,
  value,
  ok,
  action,
  busy,
  onOpen,
}: {
  label: string;
  value: string;
  ok: boolean;
  action: { text: string; target: SettingsTarget } | null;
  busy: SettingsTarget | null;
  onOpen: (t: SettingsTarget) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        fontSize: 14,
        marginTop: 4,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ color: 'var(--ink-3)' }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
        <span style={{ color: ok ? undefined : 'var(--brick)' }}>{value}</span>
        {action ? (
          <button
            className="btn btn-ghost btn-sm"
            style={{ minHeight: 32, fontSize: 12, padding: '0 8px' }}
            disabled={busy !== null}
            onClick={() => onOpen(action.target)}
            aria-label={`${label}：${action.text}（打开系统设置）`}
          >
            {busy === action.target ? '打开中…' : action.text}
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function SettingsPage() {
  const { settings, setTheme, patchSettings, refreshSettings, pushToast, sessions, plans, refreshPlans, refreshSessions } =
    useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  /** 需求 2：休息提醒的真实授权/渠道状态（不可用时如实显示，不假装已开启） */
  const [restCap, setRestCap] = useState<RestReminderStatus | null>(null);
  const [restAsking, setRestAsking] = useState(false);
  /**
   * B3：系统设置跳转的真实状态。
   *
   * `opened` **只表示系统接受打开请求**，绝不据此把权限置 true。
   * busy 防重入并 finally 释放；打开/返回/刷新均不触碰提醒状态。
   */
  const [settingsBusy, setSettingsBusy] = useState<SettingsTarget | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  /**
   * 打开系统设置页并给出**如实**提示。
   *
   * 关键：`opened` 不代表已授权；返回前台后由既有 visibility/focus 刷新真实 getStatus。
   */
  const openSettings = useCallback(
    async (target: SettingsTarget) => {
      if (settingsBusy) return; // 防重入
      setSettingsBusy(target);
      setSettingsMsg(null);
      try {
        const r = await openRestReminderSettings(target);
        if (!r.opened) {
          setSettingsMsg(
            r.reason === 'activity-not-visible'
              ? '请保持 App 在前台再点一次。'
              : r.reason === 'not-native' || r.reason === 'not-implemented'
                ? '当前版本不支持直接跳转，请手动到系统设置中调整。'
                : '没能打开系统设置页，请手动到系统设置中调整。',
          );
          return;
        }
        // 实际目标与请求不同 → 如实说明去了哪
        if (r.actualTarget && r.actualTarget !== r.requestedTarget) {
          setSettingsMsg(
            r.actualTarget === 'app-details'
              ? '已打开本应用详情页（该目标在当前系统不可直达），请在其中的通知/权限里调整。'
              : '已打开本应用的通知设置页，请在其中的对应项目里调整。',
          );
        } else {
          setSettingsMsg('已打开系统设置页；返回本页后会自动重新读取真实状态。');
        }
      } finally {
        setSettingsBusy(null);
      }
    },
    [settingsBusy],
  );

  /**
   * 读取真实能力状态。
   *
   * REVIEW-1 #4：用户可能去系统设置关掉通知渠道再回到本页（页面并未卸载），
   * 只在挂载时读一次会显示过期状态。这里：
   *   · 挂载时读一次；
   *   · 每次回到前台（visibilitychange → visible）重新读；
   *   · 用**请求序号**防止旧的异步结果覆盖最新查询（乱序响应）。
   */
  const capReqSeq = useRef(0);
  /**
   * B4-R2：本页实例**是否仍然活着**（真正卸载即 false）。
   *
   * <p>为什么需要（真实失败 005）：受控 Capacitor + 真实 Settings React，
   * nativeShow 之后**同一个 tick** 真正 Root.unmount，listener 已 remove、DOM 已空，
   * 但仍发出了一次 `getStatus`（seq 20）。
   *
   * <p>根因：`onShow(isStale)` 里的 `isStale` 来自 **LifecycleQueue 自己的代次**，
   * 而 `coordinator.stop()` 推进的是 **coordinator 的另一个代次**，不推进队列、
   * 也不撤销已排队的闭包 —— 于是"已排队 onShow + 同 tick 卸载"时 isStale 仍为 false。
   *
   * <p>最小修法（合同允许的最小范围）：本 effect 自持 alive 守卫，
   * cleanup 先标记失效；`onShow` 与 `refreshRestCap` 都检查它。
   * **不改共享 LifecycleQueue 的排队语义**（Session 隐藏动作必须先排空保存）。
   */
  const aliveRef = useRef(true);
  const refreshRestCap = useCallback(async (): Promise<RestReminderStatus> => {
    const mySeq = ++capReqSeq.current;
    const cap = await restReminderCapability();
    // 只有最新一次请求的结果才能落到 state（旧响应不覆盖新查询）
    if (mySeq === capReqSeq.current && aliveRef.current) setRestCap(cap);
    return cap;
  }, []);

  /**
   * B4-R2：提醒总开关（用户意图）与"系统是否就绪"分开维护。
   *
   * `restCap.reminderEnabled` 是原生真源读回的意图；
   * `toggleBusy` 防重入；失败时**回读真实值**，绝不假报成功。
   */
  const [toggleBusy, setToggleBusy] = useState(false);

  /**
   * 用户切换提醒总开关。
   *
   * 语义（与原生/合同一致）：
   *  · 只写用户意图，**不**在这里申请权限；
   *  · 关闭：原生 durable 取消当前提醒 + 停静默服务 → 旧到达无声无震；计时不受影响；
   *  · 打开：先读真实系统状态；需要 POST_NOTIFICATIONS 就调用既有 runtime 请求；
   *    若 App 通知总开关/渠道关闭则**只打开一个**对应系统页（不连环弹）；
   *  · 持久化失败 → 回读真实值并明确提示失败，不显示成"已关闭"。
   */
  const onToggleReminder = useCallback(
    async (next: boolean) => {
      if (toggleBusy) return;
      setToggleBusy(true);
      setSettingsMsg(null);
      try {
        const r = await setRestReminderEnabled(next);
        if (!r.ok) {
          pushToast(
            r.reason === 'not-native' || r.reason === 'not-implemented'
              ? '当前版本不支持这个开关。'
              : '提醒设置没有保存成功，请重试。',
            'error',
          );
          await refreshRestCap();
          return;
        }
        if (!next) {
          // 关闭成功：不弹权限，不改计时；只刷新真实状态
          pushToast('已关闭休息提醒（倒计时仍会照常走）。', 'ok');
          await refreshRestCap();
          return;
        }
        /**
         * 打开是**明确用户动作**：按真实状态分流，最多打开一个系统页。
         *
         * 顺序固定：先 runtime 权限（可弹系统授权框）→ 再总开关 → 再渠道。
         * 不绕过用户已关掉的渠道/勿扰，不删渠道、不换 ID 强开。
         */
        let cap = await refreshRestCap();
        if (!cap.notificationsGranted) {
          const granted = await requestRestNotificationPermission();
          cap = await refreshRestCap();
          if (!granted) {
            setSettingsMsg(
              '已打开提醒，但系统还没允许通知。请点下面的「去允许」，或到系统设置里允许后再回到本页。',
            );
            return;
          }
        }
        if (!cap.appNotificationsEnabled) {
          setSettingsMsg('已打开提醒，但系统里本应用的通知总开关是关闭的，正在为你打开系统设置。');
          await openSettings('app-notifications');
          return;
        }
        if (!cap.channelEnabled) {
          setSettingsMsg('已打开提醒，但「组间休息」渠道被关闭了，正在为你打开该渠道设置。');
          await openSettings('rest-channel');
          return;
        }
        if (!cap.channelSound || !cap.channelVibrates) {
          // 渠道已开但声音/震动被单独关掉：只提示 + 就近入口，不冒充已就绪
          setSettingsMsg(
            !cap.channelSound && !cap.channelVibrates
              ? '渠道已开启，但声音和震动都在系统里被关掉了。可在「组间休息」渠道里重新开启。'
              : !cap.channelSound
                ? '渠道已开启，但声音在系统里被关掉了。可在「组间休息」渠道里重新开启。'
                : '渠道已开启，但震动在系统里被关掉了。可在「组间休息」渠道里重新开启。',
          );
          return;
        }
        pushToast('休息提醒已开启：声音＋震动（系统省电策略仍可能延迟）。', 'ok');
      } finally {
        setToggleBusy(false);
      }
    },
    [toggleBusy, refreshRestCap, openSettings, pushToast],
  );

  useEffect(() => {
    void refreshRestCap();
    /**
     * B4-R1：**删除 DOM 直连刷新旁路**。
     *
     * 旧实现同时有 DOM `visibilitychange/focus` 直连 `refreshRestCap`
     * 和 coordinator 的 `onShow` 刷新 —— 两条路各刷一次，绕过 coordinator 的去重，
     * 造成重复 getStatus（Codex 静态审查指出）。
     *
     * 现在只保留 coordinator 一条路径：它内部把 DOM 与 native 信号归一，
     * 重复事件由串行队列去重。
     */
    /**
     * B4/G5-R6：**必须同时接原生 resume**。
     *
     * 真实失败：点"去系统设置"后把边界状态改全允许，仅发 native pause/resume
     * 与 appStateChange 时 `getStatus` 不增、UI 仍全拒；只有 DOM focus 才刷新。
     * 根因是本页只监听 DOM 事件，没有接 Capacitor 原生生命周期。
     *
     * 复用既有 `AppLifecycleCoordinator`（不新增依赖、不加轮询）：
     * 它把 DOM 与 native 信号归一到"前台"，重复事件由内部串行队列去重。
     */
    aliveRef.current = true;
    const coordinator = new AppLifecycleCoordinator();
    const stopLifecycle = coordinator.start({
      onShow: (isStale) => {
        /**
         * B4-R1：检查队列自身的 isStale（被更新的前台边沿取代）。
         *
         * B4-R2：**再检查本 effect 的 alive 守卫**。
         * `isStale` 只反映 LifecycleQueue 的代次，不覆盖 coordinator.stop；
         * 同 tick 卸载时它仍可能为 false，必须在发请求前拦住。
         */
        if (isStale()) return;
        if (!aliveRef.current) return;
        void refreshRestCap();
      },
      onHide: () => {
        // 进入后台：什么都不做（不清状态、不猜权限）
      },
    });
    return () => {
      /**
       * 顺序固定：**先**标记失效（让已排队的 onShow/在途响应立即作废），
       * **再**停 coordinator、推进请求序号。
       */
      aliveRef.current = false;
      stopLifecycle();
      // 卸载时让在途请求的结果失效
      capReqSeq.current += 1;
    };
  }, [refreshRestCap]);
  const [preview, setPreview] = useState<{ payload: BackupPayload; preview: RestorePreview; warnings: string[]; size: number } | null>(null);
  const [badFile, setBadFile] = useState<string | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<BackupPayload | null>(null);
  /**
   * v0.1.2：导出防重入。
   * 旧实现没有 busy 状态，连点会并发发起两次 SAF 调用，两份内容互相串。
   * 现在同一时刻只允许一个导出在飞行中，按钮同时显示进行中文案。
   */
  const [exporting, setExporting] = useState(false);
  /**
   * 同步占位用的 ref。
   * useState 的更新不会同步影响已捕获的旧 render 闭包，普通导出与快照导出
   * 共用同一个 doExport 闭包时，仅靠 state 挡不住并发。这里在**任何 await 之前**
   * 用 ref 同步 compare-and-set，finally 释放；state 只负责按钮文案/禁用。
   */
  const exportingRef = useRef(false);

  /**
   * v0.1.2：Activity/进程重建后的导出结果通道。
   *
   * 重建时原 JS promise 已不存在，原生 SAF 的结果会走 appRestoredResult。
   * 这里只消费 NativeFileBridge/exportJson：
   *   · 成功（已校验 bytes>0 且有 sha256）→ 更新最近备份 + 提示
   *   · 取消 / 失败 → 不报成功、不更新时间
   * 训练库不受影响（只 patchSettings.lastExportAt）。
   */
  useEffect(() => {
    if (!isNativeBuild) return;
    let dispose: (() => Promise<void>) | null = null;
    let cancelled = false;

    void installRestoredExportHandler({
      /**
       * 成功：**串联真实 patchSettings Promise**。
       *
       * 旧实现 void patchSettings 后立刻弹成功，patchSettings 拒绝会变成
       * unhandled rejection，而用户已经看到「已导出」。
       * 现在：await 真实写入；只有写成功才提示成功。
       */
      async onSaved(result: RestoredExportResult) {
        if (cancelled) return;
        await patchSettings({ lastExportAt: Date.now() });
        if (cancelled) return;
        pushToast(
          result.filename
            ? `已导出 ${result.filename}（${result.bytes} 字节，已校验）`
            : `已导出（${result.bytes} 字节，已校验）`,
        );
      },
      /**
       * 文件已写出成功，但本地「最近备份」记录更新失败。
       * 必须与「文件失败」区分：文件在，只是时间没记上。
       */
      onSavedButNotRecorded(result: RestoredExportResult, error: unknown) {
        if (cancelled) return;
        const msg = error instanceof Error ? error.message : String(error);
        pushToast(
          `文件已写入${result.filename ? ' ' + result.filename : ''}（${result.bytes} 字节），但本地「最近备份」时间没记上：${msg}`,
          'error',
        );
      },
      onCancelled() {
        if (cancelled) return;
        pushToast('已取消导出，没有写入任何文件。');
      },
      onFailed(error: string) {
        if (cancelled) return;
        pushToast(`导出失败：${error}`, 'error');
      },
    }).then((d) => {
      if (cancelled) {
        void d();
        return;
      }
      dispose = d;
    });

    return () => {
      cancelled = true;
      if (dispose) void dispose();
    };
  }, [patchSettings, pushToast]);

  // 训练次数排除完全休息（第2阶段统计口径）
  const completed = sessions.filter(
    (s) => s.status === 'completed' && sessionKindOf(s) !== 'rest',
  ).length;
  /** 完全休息记录数（单独展示，不混入训练次数） */
  const restCount = sessions.filter(
    (s) => s.status === 'completed' && sessionKindOf(s) === 'rest',
  ).length;
  const active = sessions.filter((s) => s.status === 'active').length;

  /**
   * 导出备份（普通备份与「恢复前快照」共用同一条路径）。
   *
   * V8-D 关键约束：
   *   · Android 上走系统「创建文档」界面，**必须等真实写入结果**；
   *   · 用户取消 → 不提示成功、**不更新 lastExportAt**；
   *   · 写入失败 → 明确报错，同样不更新 lastExportAt。
   * 旧实现是「先写 lastExportAt，再调 downloadBackup(payload) 并直接提示已导出」，
   * 在 WebView 里那个 a.download 可能什么都没发生，等于报告了一个假成功。
   */
  async function doExport(payloadInput?: BackupPayload, opts?: { label?: string }): Promise<ExportOutcome> {
    // v0.1.2：并发点击只处理一次。
    // 用 ref 做同步 CAS —— 必须在任何 await 之前占位，否则两个入口
    // （普通导出 / 快照导出）会在同一 render 闭包里同时通过检查。
    if (exportingRef.current) {
      pushToast('正在导出，请等待当前导出完成。');
      return { ok: false, cancelled: false, error: '正在导出' };
    }
    exportingRef.current = true;
    setExporting(true);
    try {
      return await coordinateBackupExport({
        payloadInput,
        opts,
        patchSettings,
        pushToast,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      pushToast(`导出失败：${message}`, 'error');
      return { ok: false, cancelled: false, error: message };
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }

  /** 统一的「拿到 JSON 文本 → 深度校验 → 预览」入口（原生与网页共用） */
  async function acceptBackupText(text: string, size: number) {
    try {
      const raw = parseJsonText(text);
      const result = validateBackup(raw);
      if (!result.ok) {
        setBadFile(result.error);
        return;
      }
      setPreview({ payload: result.payload, preview: result.preview, warnings: result.warnings, size });
    } catch (err) {
      setBadFile(err instanceof Error ? err.message : '读取文件失败');
    }
  }

  async function onPickFile(file: File) {
    try {
      const raw = await readJsonFile(file);
      const result = validateBackup(raw);
      if (!result.ok) {
        setBadFile(result.error);
        return;
      }
      setPreview({ payload: result.payload, preview: result.preview, warnings: result.warnings, size: file.size });
    } catch (err) {
      setBadFile(err instanceof Error ? err.message : '读取文件失败');
    }
  }

  /**
   * 「从文件恢复」入口。
   * 原生容器里走系统文档选择器；用户取消 → 不改数据、不报错。
   * 浏览器里退回隐藏的 <input type=file>（原行为）。
   */
  async function beginRestore() {
    if (!usesNativeFileUi()) {
      fileRef.current?.click();
      return;
    }
    const picked = await pickBackupViaNative();
    if (!picked.ok) {
      if (!picked.cancelled) setBadFile(picked.error);
      return;
    }
    await acceptBackupText(picked.text, picked.size);
  }

  async function doRestore(payload: BackupPayload) {
    try {
      await snapshotBeforeRestore(APP_VERSION);
      await restoreBackup(payload);
      await Promise.all([refreshPlans(), refreshSessions(), refreshSettings()]);
      setPreview(null);
      pushToast('恢复完成，已载入备份数据。');
      navigate('/', true);
    } catch (err) {
      pushToast(err instanceof Error ? `恢复失败：${err.message}` : '恢复失败', 'error');
    }
  }

  return (
    <main className="page page-top page-bottom-space">
      <h1 className="h-serif" style={{ fontSize: 26 }}>
        设置
      </h1>
      <hr className="rule-line" style={{ marginTop: 8 }} />

      {/* 主题 */}
      <section style={{ marginTop: 18 }}>
        <h2 className="h-section">主题</h2>
        <div className="segmented" style={{ marginTop: 8 }} role="group" aria-label="主题">
          {(
            [
              ['light', '纸张'],
              ['dark', '深色'],
              ['system', '跟随系统'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} aria-pressed={settings.theme === v} onClick={() => void setTheme(v)}>
              {label}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginTop: 6 }}>
          偏好保存在本机；深色主题单独调整了纸张、油墨与强调色。
        </p>
      </section>

      {/* 备份 */}
      <section style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <h2 className="h-section">备份与恢复</h2>
          <span className="mono-label">格式 v{BACKUP_VERSION}</span>
        </div>
        <div className="slip" style={{ marginTop: 8, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span style={{ color: 'var(--ink-3)' }}>本地数据</span>
            <span>
              {plans.length} 个计划 · {completed} 次完成
              {restCount ? ` · ${restCount} 天完全休息` : ''} · {active} 个进行中
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 4 }}>
            <span style={{ color: 'var(--ink-3)' }}>最近导出</span>
            <span>
              {settings.lastExportAt
                ? `${fmtDateWithWeek(settings.lastExportAt)} ${fmtTime(settings.lastExportAt)}`
                : '从未导出'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void doExport()}
              disabled={exporting}
              aria-busy={exporting}
            >
              {exporting ? '正在导出…' : '导出 JSON 备份'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void beginRestore()}>
              从文件恢复
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                const snap = await getPreRestoreSnapshot();
                if (!snap) {
                  pushToast('还没有恢复前快照。做一次恢复后这里会保留上一份数据。');
                  return;
                }
                setSnapshot(snap);
                setSnapOpen(true);
              }}
            >
              恢复前快照
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPickFile(f);
            }}
          />

          <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.7, marginTop: 12, marginBottom: 0 }}>
            备份包含计划、训练历史、未结束的训练与设置。恢复是<strong>完整覆盖</strong>，不做合并。
            浏览器本地数据不是永久存储：换设备、清理站点数据或卸载浏览器都可能丢失，请定期导出。
          </p>
        </div>
      </section>

      {/* 需求 2：组间休息提醒的真实状态 */}
      <section style={{ marginTop: 22 }}>
        <h2 className="h-section">组间休息提醒</h2>
        <div className="slip" style={{ marginTop: 8, padding: 14 }}>
          {!hasRestReminder() ? (
            <p style={{ fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.7, margin: 0 }}>
              当前是网页版，组间休息到时提醒不可用。安装 Android 版本后，休息结束会在后台/锁屏时提醒。
            </p>
          ) : !restCap ? (
            <p style={{ fontSize: 13, color: 'var(--ink-3)', margin: 0 }}>正在读取系统状态…</p>
          ) : !restCap.available ? (
            /**
             * B4/G5-R7：**读取失败 ≠ 全部拒绝**。
             *
             * 真实失败：status API 真实 throw 时，UI 把五项全判"未允许"并给五个"去允许"，
             * 把"读不到"当成了"确实被拒"。现在必须显示未知/失败并给重试。
             */
            <div>
              <p
                role="alert"
                style={{ fontSize: 13, color: 'var(--brick)', lineHeight: 1.7, margin: 0 }}
              >
                没能读取系统通知状态（可能是系统繁忙或权限查询受限）。
                这不代表权限被拒绝 —— 请稍后重试，或手动到系统设置查看。
              </p>
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 10 }}
                onClick={() => void refreshRestCap()}
              >
                重试读取
              </button>
            </div>
          ) : (
            <>
              {/*
                B4-R2：**提醒总开关**（用户意图）与"系统是否就绪"分开呈现。
                checked 只代表用户想被提醒，绝不代表系统已允许；
                系统就绪状态仍由下面逐项真实值展示。
              */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingBottom: 10,
                  marginBottom: 6,
                  borderBottom: '1px solid var(--rule)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>休息结束提醒</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.5, marginTop: 2 }}>
                    声音＋震动。关闭后不再提醒（倒计时仍照常走）。
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  role="switch"
                  aria-checked={restCap.reminderEnabled}
                  aria-label="休息结束提醒开关"
                  disabled={toggleBusy}
                  style={{
                    minWidth: 64,
                    minHeight: 34,
                    flex: 'none',
                    background: restCap.reminderEnabled ? 'var(--brick)' : 'var(--paper-3)',
                    color: restCap.reminderEnabled ? 'var(--paper)' : 'var(--ink-3)',
                    border: '1px solid var(--rule-strong)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                  onClick={() => void onToggleReminder(!restCap.reminderEnabled)}
                >
                  {toggleBusy ? '…' : restCap.reminderEnabled ? '已开启' : '已关闭'}
                </button>
              </div>
              {/*
                意图已开但系统没就绪 → 明确区分两个事实，不把 checked 当已授权。
              */}
              {restCap.reminderEnabled && !restCap.canAlert ? (
                <p
                  role="status"
                  style={{
                    fontSize: 12.5,
                    color: 'var(--ink-2)',
                    lineHeight: 1.6,
                    margin: '0 0 8px',
                  }}
                >
                  开关已打开，但系统侧还没就绪（见下方逐项）。到点暂时不会提醒。
                </p>
              ) : null}
              {/*
                逐项展示真实状态，避免"权限已允许"被误读成"提醒已就绪"。
                B3：**未允许项就近给短按钮**跳系统设置；已开启项不显示"去开启"。
              */}
              <RestStatusRow
                label="通知权限"
                value={restCap.notificationsGranted ? '已允许' : '未允许'}
                ok={restCap.notificationsGranted}
                action={
                  restCap.notificationsGranted
                    ? null
                    : { text: '去允许', target: 'app-notifications' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              <RestStatusRow
                label="App 通知总开关"
                value={restCap.appNotificationsEnabled ? '已开启' : '已关闭'}
                ok={restCap.appNotificationsEnabled}
                action={
                  restCap.appNotificationsEnabled
                    ? null
                    : { text: '去开启', target: 'app-notifications' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              <RestStatusRow
                label="休息提醒渠道"
                value={restCap.channelEnabled ? '已开启' : '已关闭'}
                ok={restCap.channelEnabled}
                action={
                  restCap.channelEnabled ? null : { text: '去开启', target: 'rest-channel' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              <RestStatusRow
                label="震动"
                value={restCap.channelVibrates ? '已开启' : '已关闭'}
                ok={restCap.channelVibrates}
                action={
                  restCap.channelVibrates ? null : { text: '去设置', target: 'rest-channel' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              <RestStatusRow
                label="精确调度"
                value={restCap.exactAlarmsGranted ? '已允许' : '未允许（到时会不精确）'}
                ok={restCap.exactAlarmsGranted}
                action={
                  restCap.exactAlarmsGranted ? null : { text: '去设置', target: 'exact-alarm' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              <RestStatusRow
                label="声音"
                value={restCap.channelSound ? '已开启' : '已关闭'}
                ok={restCap.channelSound}
                action={
                  restCap.channelSound ? null : { text: '去设置', target: 'rest-channel' }
                }
                busy={settingsBusy}
                onOpen={openSettings}
              />
              {/* 声音/震动单独一行：通知开着不等于会响/会震（渠道可被单独关掉） */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 4 }}>
                <span style={{ color: 'var(--ink-3)' }}>到点声音</span>
                <span>{restCap.canSound ? '可能会响' : '不会响'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 4 }}>
                <span style={{ color: 'var(--ink-3)' }}>到点震动</span>
                <span>{restCap.canVibrate ? '可能会震动' : '不会震动'}</span>
              </div>

              {/*
                B3：跳转结果提示 + **常驻**"系统通知设置"辅助入口。
                常驻入口让用户在系统不再弹权限框时也能自助。
              */}
              {settingsMsg ? (
                <p
                  role="status"
                  style={{
                    fontSize: 12.5,
                    color: 'var(--ink-2)',
                    lineHeight: 1.6,
                    margin: '8px 0 0',
                  }}
                >
                  {settingsMsg}
                </p>
              ) : null}
              <button
                className="btn btn-ghost btn-sm"
                style={{ marginTop: 8, minHeight: 32, fontSize: 12 }}
                disabled={settingsBusy !== null}
                onClick={() => openSettings('app-notifications')}
              >
                {settingsBusy === 'app-notifications' ? '打开中…' : '系统通知设置'}
              </button>

              {/*
                结论区：只有 canAlert 为真才说"可以提醒"。
                渠道/总开关关闭时，即使权限已允许也**不得**宣称离开 App 也能提醒（P2 #3）。
              */}
              {restCap.canAlert ? (
                <p style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.7, marginTop: 10, marginBottom: 0 }}>
                  通知权限与「组间休息」渠道已开启，系统仍可能延迟或拦截提醒。
                  {restCap.canSound ? '' : ' 「组间休息」渠道的声音被关闭了，到时不会响。'}
                  {restCap.canVibrate ? '' : ' 「组间休息」渠道的震动被关闭了，到时不会震动。'}
                  {' '}深度省电（Doze）与厂商后台策略都可能推迟甚至拦截，
                  <strong>因此不保证每一组都准点送达或震动</strong>。
                </p>
              ) : (
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 10px',
                    background: 'var(--paper-3)',
                    borderLeft: '3px solid var(--brick)',
                    fontSize: 12.5,
                    lineHeight: 1.7,
                  }}
                >
                  <strong>现在不会提醒。</strong>
                  {!restCap.notificationsGranted
                    ? ' 通知权限未允许。'
                    : !restCap.appNotificationsEnabled
                      ? ' 系统设置里 MOTION 的通知被关闭了。'
                      : !restCap.channelEnabled
                        ? ' 「组间休息」通知渠道被关闭了。'
                        : ' 提醒当前不可用。'}
                  {!restCap.channelVibrates && restCap.channelEnabled
                    ? ' 震动也被关闭了，到时不会有震动。'
                    : ''}
                  {' '}请在系统设置中开启后回到本页查看。
                </div>
              )}

              {/*
                最小本地诊断（G2）：只显示**本机**最近几条排程/触发/通知结果，
                用来区分"排程没成功 / 广播没到 / 通知被拦 / 通知抛错"。
                不含 token、不含训练内容、不联网、不外发。
              */}
              {restCap.recentDiag.length > 0 ? (
                <details style={{ marginTop: 10 }}>
                  <summary style={{ fontSize: 12.5, color: 'var(--ink-2)', cursor: 'pointer' }}>
                    最近提醒记录（本机，仅用于排查）
                  </summary>
                  <ul
                    style={{
                      fontSize: 11.5,
                      color: 'var(--ink-3)',
                      lineHeight: 1.6,
                      margin: '6px 0 0',
                      paddingLeft: 16,
                      fontFamily: 'var(--f-mono)',
                    }}
                  >
                    {restCap.recentDiag.slice(-8).map((line, i) => (
                      <li key={`${i}-${line}`}>{diagLabel(line)}</li>
                    ))}
                  </ul>
                  <p style={{ fontSize: 11.5, color: 'var(--ink-3)', lineHeight: 1.6, margin: '6px 0 0' }}>
                    这些记录只说明系统有没有接受排程、广播有没有到、通知有没有发出去；
                    不证明系统一定按时送达或一定震动。
                  </p>
                </details>
              ) : null}

              {!restCap.notificationsGranted ? (
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginTop: 10 }}
                  disabled={restAsking}
                  onClick={async () => {
                    setRestAsking(true);
                    const granted = await requestRestNotificationPermission();
                    // 刷新后直接用返回的最新状态判断，避免再读一次造成竞态
                    const cap = await refreshRestCap();
                    setRestAsking(false);
                    // 只按**完整能力**报告，不因权限通过就宣称已就绪
                    if (cap.canAlert) {
                      // 只承诺"通知通道已打开"，不承诺"每组都准点/一定震动"
                      pushToast(
                        cap.canVibrate
                          ? '通知权限与渠道已开启；系统省电策略仍可能延迟或拦截。'
                          : '通知已开启，但渠道震动被关闭，到时不会震动。',
                        'ok',
                      );
                    } else if (granted) {
                      pushToast('通知权限已允许，但通知总开关或提醒渠道仍关闭，现在不会提醒。', 'error');
                    } else {
                      pushToast('仍未允许通知；到时不会提醒。', 'error');
                    }
                  }}
                >
                  {restAsking ? '正在请求…' : '请求通知权限'}
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* 数据与隐私 */}
      <section style={{ marginTop: 22 }}>
        <h2 className="h-section">数据</h2>
        <div className="rows" style={{ marginTop: 4 }}>
          <div className="row" style={{ cursor: 'default' }}>
            <span className="row-main">
              <span className="row-title" style={{ fontSize: 15 }}>
                存储位置
              </span>
              <span className="row-sub">本机 IndexedDB，不上传任何服务器</span>
            </span>
          </div>
          <div className="row" style={{ cursor: 'default' }}>
            <span className="row-main">
              <span className="row-title" style={{ fontSize: 15 }}>
                应用版本
              </span>
              <span className="row-sub">{APP_VERSION} · 备份格式 v{BACKUP_VERSION}</span>
            </span>
          </div>
          <button className="row" onClick={() => navigate('/stats')}>
            <span className="row-main">
              <span className="row-title" style={{ fontSize: 15 }}>
                统计口径
              </span>
              <span className="row-sub">热身不计组 · 递减组按大组 · 部分完成单独标注</span>
            </span>
            <span className="row-end">›</span>
          </button>
        </div>
      </section>

      <p style={{ marginTop: 22, fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.7 }}>
        MOTION 是本地优先的个人训练记录工具。没有账号、没有后端、没有同步；
        同一浏览器的不同地址（协议 / 域名 / 端口）会各自拥有独立的本地数据，迁移测试数据请用备份导出再导入。
      </p>

      {/* 恢复预览 */}
      <Sheet
        open={!!preview}
        title="确认恢复"
        onClose={() => setPreview(null)}
        footer={
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPreview(null)}>
              取消
            </button>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => preview && void doRestore(preview.payload)}>
              覆盖并恢复
            </button>
          </div>
        }
      >
        {preview ? (
          <div style={{ display: 'grid', gap: 8, fontSize: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ink-3)' }}>导出时间</span>
              <span>{preview.preview.exportedAt ? `${fmtDateWithWeek(preview.preview.exportedAt)} ${fmtTime(preview.preview.exportedAt)}` : '未知'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ink-3)' }}>计划 / 训练</span>
              <span>
                {preview.preview.plans} 个计划 · {preview.preview.sessions} 次记录
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ink-3)' }}>未结束训练</span>
              <span>{preview.preview.activeSessions} 个</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ink-3)' }}>文件大小</span>
              <span>{fileSizeLabel(preview.size)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--ink-3)' }}>来源版本</span>
              <span>
                {preview.preview.appVersion} · 格式 v{preview.payload.version}
              </span>
            </div>
            {preview.warnings.length ? (
              <div style={{ marginTop: 4, padding: 10, background: 'var(--paper-3)', fontSize: 13, lineHeight: 1.6 }}>
                {preview.warnings.map((w) => (
                  <div key={w}>· {w}</div>
                ))}
              </div>
            ) : null}
            <div style={{ marginTop: 6, padding: 10, background: 'var(--brick-soft)', borderLeft: '3px solid var(--brick)', fontSize: 13, lineHeight: 1.65 }}>
              恢复会<strong>覆盖当前全部数据</strong>（{plans.length} 个计划 / {sessions.length} 条记录）。
              当前数据会先保存成「恢复前快照」，可从这里取回。
            </div>
          </div>
        ) : null}
      </Sheet>

      <Confirm
        open={!!badFile}
        title="无法恢复这个文件"
        body={badFile ?? ''}
        confirmText="知道了"
        onCancel={() => setBadFile(null)}
        onConfirm={() => setBadFile(null)}
      />

      <Sheet open={snapOpen} title="恢复前快照" onClose={() => setSnapOpen(false)}>
        {snapshot ? (
          <div style={{ display: 'grid', gap: 10, fontSize: 14 }}>
            <div>
              生成于 {fmtDateWithWeek(snapshot.exportedAt)} {fmtTime(snapshot.exportedAt)}
            </div>
            <div style={{ color: 'var(--ink-3)' }}>
              {snapshot.data.plans.length} 个计划 · {snapshot.data.sessions.length} 条记录
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  if (!snapshot) return;
                  // 与普通导出走同一条路径：等真实写入结果，取消/失败不算导出成功
                  void doExport(snapshot, { label: '快照' });
                }}
                disabled={exporting}
                aria-busy={exporting}
              >
                {exporting ? '正在导出…' : '导出这份快照'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void doRestore(snapshot);
                  setSnapOpen(false);
                }}
              >
                用快照回退
              </button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </main>
  );
}
