/* 设置：主题、备份导出/导入、数据说明。
   恢复是「完整覆盖」，导入前必须先预览并显式确认，且保留恢复前快照。 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { navigate } from '../lib/router';
import { Sheet } from '../ui/Sheet';
import { Confirm } from '../ui/Confirm';
import {
  BACKUP_VERSION,
  buildBackup,
  getPreRestoreSnapshot,
  restoreBackup,
  snapshotBeforeRestore,
  validateBackup,
  type BackupPayload,
  type RestorePreview,
} from '../db/repo';
import {
  exportBackup,
  fileSizeLabel,
  parseJsonText,
  pickBackupViaNative,
  readJsonFile,
  usesNativeFileUi,
  type ExportOutcome,
} from '../lib/backupFile';
import { fmtDateWithWeek, fmtTime } from '../lib/format';
import {
  installRestoredExportHandler,
  type RestoredExportResult,
} from '../lib/exportRestore';
import { isNativeBuild } from '../lib/platform';

const APP_VERSION = '1.0.0';

export function SettingsPage() {
  const { settings, setTheme, patchSettings, refreshSettings, pushToast, sessions, plans, refreshPlans, refreshSessions } =
    useStore();
  const fileRef = useRef<HTMLInputElement>(null);
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

  const completed = sessions.filter((s) => s.status === 'completed').length;
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
      // 打包完成后再记录导出时间：备份文件自身也带上这个时间
      const payload = payloadInput ?? (await buildBackup(APP_VERSION));
      const result = await exportBackup(payload);

      if (result.ok) {
        // 文件已经真实写出（原生 close 后回读过长度与摘要）。
        // 接下来只是更新「最近备份时间」这个本地记录 —— 两者必须分开处理：
        //   · 记录成功 → 正常成功提示
        //   · 记录失败 → 明确「文件已写入，但时间没记上」，
        //     **不得**把已成功的文件回报成「导出失败」，也不能产生 unhandled rejection。
        // 返回值始终是真实的文件保存结果（ok:true），不因本地记录失败而反转。
        try {
          await patchSettings({ lastExportAt: payload.exportedAt });
          pushToast(
            opts?.label ? `${opts.label}已导出 ${result.filename}` : `已导出 ${result.filename}`,
          );
        } catch (recordErr) {
          const msg = recordErr instanceof Error ? recordErr.message : String(recordErr);
          pushToast(
            `文件已写入${result.filename ? ' ' + result.filename : ''}${
              typeof result.bytes === 'number' ? `（${result.bytes} 字节）` : ''
            }，但本地「最近备份」时间没记上：${msg}`,
            'error',
          );
        }
        return result;
      }
      if (result.cancelled) {
        // 用户取消：什么都不改，也不提示“已导出”
        pushToast('已取消导出，没有写入任何文件。');
        return result;
      }
      pushToast(`导出失败：${result.error}`, 'error');
      return result;
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
              {plans.length} 个计划 · {completed} 次完成 · {active} 个进行中
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
