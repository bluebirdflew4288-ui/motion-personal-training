/* v0.1.2：Activity/进程重建后的导出结果恢复通道。
   ── 为什么需要它 ────────────────────────────────────────────
   Capacitor 8.5.3 的真实恢复顺序是：
     PluginHandle.load()  →  …  →  Bridge.restoreInstanceState()
   后者会用「顶层小 options」重建一个 pluginCallForLastActivity。
   如果重建时原 JS promise 已不存在（WebView 重载 / 进程回收），
   原生 SAF 回调的结果就不会再回到那个 promise，而是通过
   `App.addListener('appRestoredResult', …)` 一次性送达。

   ── 真实 event 形状（本地 Cap 8.5.3 依赖实测，不是猜测）──────
   @capacitor/app definitions.d.ts 的 RestoredListenerEvent：
     { pluginId, methodName, success, data?, error? }
   MessageHandler.sendResponseMessage：
     · resolve → { success: true,  data: <PluginResult> }
     · reject  → { success: false, error: <PluginResult> }
   PluginResult 自身把 success / data / error 并列包装。

   因此**必须先看外层 success/error**，再看 data。
   旧实现只 parse(event.data)，原生 reject 会被静默吞掉。

   本模块只处理 NativeFileBridge / exportJson（本改动范围），
   成功后更新「最近备份」并提示；取消/失败一律不报成功；
   **不触碰训练库**（只写 settings.lastExportAt 与 toast）。
 */

import { App } from '@capacitor/app';
import type { PluginListenerHandle } from '@capacitor/core';
import { isFinitePositiveInt, isSha256Hex } from './exportContract';

/** 恢复回来的导出结果（来自原生 resolve / reject 的序列化形式） */
export interface RestoredExportResult {
  /** 是否成功写入并校验通过 */
  saved: boolean;
  cancelled: boolean;
  filename?: string;
  uri?: string;
  bytes?: number;
  sha256?: string;
  error?: string;
}

/* 校验函数统一来自 lib/exportContract.ts，避免普通路径与恢复路径分叉。
   注意：只验格式，不等于 JS 已独立校验文件内容（真实验证在原生回读）。 */
export { isFinitePositiveInt, isSha256Hex };

/** 从 PluginResult 形状里取可读 message（容错各种包装） */
function readMessage(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  if (typeof n.message === 'string' && n.message) return n.message;
  // PluginResult 里可能嵌一层 error
  if (n.error && typeof n.error === 'object') {
    const inner = readMessage(n.error);
    if (inner) return inner;
  }
  if (typeof n.code === 'string' && n.code) return n.code;
  return undefined;
}

/**
 * 解析原生送达的 appRestoredResult **event**（不是只 event.data）。
 *
 * @returns null 表示「不是本插件的结果」或无法识别（调用方应忽略）
 */
export function parseRestoredExportEvent(event: unknown): RestoredExportResult | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  // 只处理本插件本方法
  if (e.pluginId !== 'NativeFileBridge') return null;
  if (e.methodName !== 'exportJson') return null;

  // ── 先看外层 success/error（关键修复）──────────────────────────
  if (e.success === false) {
    const msg = readMessage(e.error) ?? '导出失败';
    return { saved: false, cancelled: false, error: msg };
  }

  // resolve 分支：data 才是业务结果
  const data = e.data;
  if (!data || typeof data !== 'object') {
    // 外层没有 error 也没有有效 data：明确失败，不静默 return
    return {
      saved: false,
      cancelled: false,
      error: readMessage(e.error) ?? '导出结果缺少有效数据',
    };
  }

  return parseRestoredExport(data);
}

/**
 * 解析业务 data（原生 resolve 的 JSObject / 包装后的 PluginResult）。
 */
export function parseRestoredExport(data: unknown): RestoredExportResult | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  // 兼容 { data: {...} } 的再包一层
  const inner =
    d.data && typeof d.data === 'object' ? (d.data as Record<string, unknown>) : d;

  // 业务层 reject 也可能以 error 形式出现
  const errMsg = readMessage(d.error) ?? (typeof d.message === 'string' ? d.message : undefined);
  if (errMsg && inner.saved !== true && inner.cancelled !== true) {
    return { saved: false, cancelled: false, error: errMsg };
  }

  const cancelled = inner.cancelled === true;
  if (cancelled) return { saved: false, cancelled: true };

  const saved = inner.saved === true;
  if (!saved) {
    return { saved: false, cancelled: false, error: errMsg ?? '导出没有完成' };
  }

  // ── 成功必须可验证 ────────────────────────────────────────────
  const bytes = inner.bytes;
  if (!isFinitePositiveInt(bytes)) {
    return { saved: false, cancelled: false, error: '恢复结果字节数无效，备份未成功' };
  }
  const sha256 = inner.sha256;
  if (!isSha256Hex(sha256)) {
    return { saved: false, cancelled: false, error: '恢复结果缺少有效内容校验，无法确认备份完整' };
  }

  return {
    saved: true,
    cancelled: false,
    filename: typeof inner.filename === 'string' ? inner.filename : undefined,
    uri: typeof inner.uri === 'string' ? inner.uri : undefined,
    bytes,
    sha256,
  };
}

/** 恢复结果的应用副作用（由 Settings 注入，避免本模块依赖 store） */
export interface RestoredExportHandlers {
  /**
   * 成功：更新最近备份时间 + 提示。
   * **可以返回 Promise**（Settings 的真实 patchSettings 就是异步的）。
   * 本模块会 await 并捕获拒绝，把「文件已写成功但本地记录失败」准确告知用户。
   */
  onSaved(result: RestoredExportResult): void | Promise<void>;
  /** 用户取消：只提示取消，不更新任何时间 */
  onCancelled(): void;
  /** 失败：提示可读错误，不更新任何时间 */
  onFailed(error: string): void;
  /**
   * 可选：成功但本地记录更新失败时的提示。
   * 与 onFailed 区分：文件本身已经写好，只是「最近备份时间」没记上。
   */
  onSavedButNotRecorded?(result: RestoredExportResult, error: unknown): void;
}

/**
 * 注册 appRestoredResult 消费。
 *
 * <p>只关心 {@code pluginId === 'NativeFileBridge' && methodName === 'exportJson'}，
 * 其它插件的恢复结果一律忽略（不做全局生命周期改造）。
 *
 * <p><b>监听所有权</b>：每次调用都用自己的局部 handle，
 * 返回的清理函数只移除自己、可重复调用。不使用模块级共享 handle，
 * 避免 installA/installB 交错时 cleanupA 移除 B 并留下 A 的孤儿监听。
 *
 * @returns 卸载函数（只清自己，幂等）
 */
export async function installRestoredExportHandler(
  handlers: RestoredExportHandlers,
): Promise<() => Promise<void>> {
  // 每次安装独享的局部 handle
  let localHandle: PluginListenerHandle | null = null;
  let disposed = false;

  try {
    const h = await App.addListener('appRestoredResult', (event) => {
      if (disposed) return;

      const parsed = parseRestoredExportEvent(event);
      if (!parsed) return; // 非本插件结果：忽略

      if (parsed.cancelled) {
        handlers.onCancelled();
        return;
      }
      if (!parsed.saved) {
        handlers.onFailed(parsed.error ?? '导出失败');
        return;
      }

      // 成功：必须串联真实 Promise 并捕获拒绝
      let ret: void | Promise<void>;
      try {
        ret = handlers.onSaved(parsed);
      } catch (err) {
        handlers.onSavedButNotRecorded?.(parsed, err);
        return;
      }
      void Promise.resolve(ret).catch((err: unknown) => {
        // 文件已写出成功，但本地「最近备份」记录失败 —— 准确区分，不谎报文件失败
        handlers.onSavedButNotRecorded?.(parsed, err);
      });
    });
    localHandle = h;
  } catch {
    // 监听注册失败：不影响正常（非重建）路径
    return async () => {};
  }

  // 清理闭包只持有本次安装的 handle
  return async () => {
    if (disposed) return;
    disposed = true;
    const h = localHandle;
    localHandle = null;
    try {
      await h?.remove();
    } catch {
      // 卸载失败无需处理
    }
  };
}
