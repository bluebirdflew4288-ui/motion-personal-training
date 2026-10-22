/* 设置：主题、备份导出/导入、数据说明。
   恢复是「完整覆盖」，导入前必须先预览并显式确认，且保留恢复前快照。 */

import { useRef, useState } from 'react';
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
import { downloadBackup, fileSizeLabel, readJsonFile } from '../lib/backupFile';
import { fmtDateWithWeek, fmtTime } from '../lib/format';

const APP_VERSION = '1.0.0';

export function SettingsPage() {
  const { settings, setTheme, patchSettings, refreshSettings, pushToast, sessions, plans, refreshPlans, refreshSessions } =
    useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ payload: BackupPayload; preview: RestorePreview; warnings: string[]; size: number } | null>(null);
  const [badFile, setBadFile] = useState<string | null>(null);
  const [snapOpen, setSnapOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<BackupPayload | null>(null);

  const completed = sessions.filter((s) => s.status === 'completed').length;
  const active = sessions.filter((s) => s.status === 'active').length;

  async function doExport() {
    try {
      // 先记录导出时间，再打包：这样备份文件本身也带上导出时间
      const stamp = Date.now();
      await patchSettings({ lastExportAt: stamp });
      const payload = await buildBackup(APP_VERSION);
      const name = downloadBackup(payload);
      pushToast(`已导出 ${name}`);
    } catch (err) {
      pushToast(err instanceof Error ? `导出失败：${err.message}` : '导出失败', 'error');
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
            <button className="btn btn-primary btn-sm" onClick={() => void doExport()}>
              导出 JSON 备份
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
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
                  downloadBackup(snapshot);
                  pushToast('快照已导出。');
                }}
              >
                导出这份快照
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
