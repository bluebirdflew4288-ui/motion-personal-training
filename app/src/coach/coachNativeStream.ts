/* Android 原生后台保活流式网络桥（通过 Capacitor CoachStream 插件）。
   解决问题：
   1. 手机切后台/锁屏时，Android WebView 的 JS fetch SSE 连接会被系统冻结或直接断开；
   2. 原生 CoachStreamService（dataSync FGS + WakeLock + HttpURLConnection）在后台持续拉取流并按 seq 缓冲；
   3. 前台切回时（visibilitychange / appStateChange）立即调用 drainEvents(requestId, lastSeq) 补齐积压分片，实现断点无损续传；
   4. 非流式请求（GET /models、联网搜索）同走原生 HttpURLConnection，避开 WebView CORS 限制。 */

import { App } from '@capacitor/app';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface CoachStreamDeltaEvent {
  requestId: string;
  seq: number;
  type: 'status' | 'chunk' | 'done' | 'error';
  status?: number;
  statusText?: string;
  chunk?: string;
  error?: string;
}

export interface CoachStreamPluginShape {
  startStream(opts: {
    requestId: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ requestId: string }>;
  drainEvents(opts: {
    requestId: string;
    afterSeq: number;
  }): Promise<{ events: CoachStreamDeltaEvent[]; finished: boolean }>;
  abortStream(opts: { requestId: string }): Promise<{ aborted: boolean }>;
  fetchText(opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; statusText: string; body: string }>;
  addListener(
    eventName: 'coachStreamEvent',
    listener: (ev: CoachStreamDeltaEvent) => void,
  ): Promise<PluginListenerHandle>;
}

export interface CoachStreamLifecycleHooks {
  onResume: (cb: () => void) => () => void;
}

let cachedNativePlugin: CoachStreamPluginShape | null = null;

function getNativeCoachStreamPlugin(): CoachStreamPluginShape | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return null;
    }
    if (!cachedNativePlugin) {
      cachedNativePlugin = registerPlugin<CoachStreamPluginShape>('CoachStream');
    }
    return cachedNativePlugin;
  } catch {
    return null;
  }
}

function defaultLifecycleHooks(): CoachStreamLifecycleHooks {
  return {
    onResume: (cb) => {
      const cleanups: Array<() => void> = [];
      if (typeof document !== 'undefined') {
        const onVis = () => {
          if (document.visibilityState === 'visible') cb();
        };
        document.addEventListener('visibilitychange', onVis);
        cleanups.push(() => document.removeEventListener('visibilitychange', onVis));
      }
      try {
        const listenerPromise = App.addListener('appStateChange', (st) => {
          if (st.isActive) cb();
        });
        cleanups.push(() => {
          void listenerPromise.then((h) => h.remove()).catch(() => {});
        });
      } catch {
        /* ignore outside Capacitor runtime */
      }
      return () => {
        for (const fn of cleanups) fn();
      };
    },
  };
}

function normalizeHeaders(raw?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (raw instanceof Headers) {
    raw.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(raw)) {
    for (const [k, v] of raw) out[String(k)] = String(v);
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

function isStreamingRequest(url: string, bodyText?: string): boolean {
  if (/:streamGenerateContent/i.test(url)) return true;
  if (!bodyText) return false;
  try {
    const parsed = JSON.parse(bodyText) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/**
 * 工厂函数（便于单元测试注入 mock 原生插件与前后台切换钩子）。
 */
export function createNativeStreamFetch(
  plugin: CoachStreamPluginShape,
  lifecycle: CoachStreamLifecycleHooks = defaultLifecycleHooks(),
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = normalizeHeaders(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bodyText =
      typeof init?.body === 'string'
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : undefined;
    const signal = init?.signal ?? undefined;

    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (!isStreamingRequest(url, bodyText)) {
      const abortPromise = new Promise<never>((_, reject) => {
        if (!signal) return;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
      const res = await Promise.race([
        plugin.fetchText({ url, method, headers, ...(bodyText !== undefined ? { body: bodyText } : {}) }),
        ...(signal ? [abortPromise] : []),
      ]);
      return new Response(res.body ?? '', {
        status: res.status,
        statusText: res.statusText || '',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const requestId = `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const encoder = new TextEncoder();

    return await new Promise<Response>((resolveResponse, rejectResponse) => {
      let lastSeq = 0;
      let responseResolved = false;
      let finished = false;
      let draining = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let listenerHandle: PluginListenerHandle | null = null;
      let unlistenResume: (() => void) | null = null;
      let fallbackTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (fallbackTimer !== null) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
        unlistenResume?.();
        unlistenResume = null;
        if (listenerHandle) {
          void listenerHandle.remove().catch(() => {});
          listenerHandle = null;
        }
        signal?.removeEventListener('abort', onAbort);
      };

      const finishError = (err: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (!responseResolved) {
          responseResolved = true;
          rejectResponse(err);
        } else {
          try {
            streamController?.error(err);
          } catch {
            /* ignore */
          }
        }
      };

      const ensureResponseOpened = (status: number, statusText: string) => {
        if (responseResolved) return;
        responseResolved = true;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
          },
          cancel() {
            finished = true;
            cleanup();
            void plugin.abortStream({ requestId }).catch(() => {});
          },
        });
        resolveResponse(
          new Response(body, {
            status,
            statusText,
            headers: {
              'Content-Type': status >= 200 && status < 300 ? 'text/event-stream; charset=utf-8' : 'text/plain; charset=utf-8',
            },
          }),
        );
      };

      const applyEvent = (ev: CoachStreamDeltaEvent) => {
        if (!ev || ev.requestId !== requestId || finished) return;
        if (ev.seq <= lastSeq) return;
        lastSeq = ev.seq;

        if (ev.type === 'status') {
          ensureResponseOpened(ev.status ?? 200, ev.statusText ?? '');
          return;
        }
        if (ev.type === 'chunk') {
          ensureResponseOpened(200, 'OK');
          if (ev.chunk && streamController) {
            streamController.enqueue(encoder.encode(ev.chunk));
          }
          return;
        }
        if (ev.type === 'done') {
          ensureResponseOpened(200, 'OK');
          finished = true;
          cleanup();
          try {
            streamController?.close();
          } catch {
            /* ignore */
          }
          return;
        }
        if (ev.type === 'error') {
          finishError(new Error(ev.error || '原生流式连接中断'));
        }
      };

      const drainMissed = async () => {
        if (finished || draining) return;
        draining = true;
        try {
          const res = await plugin.drainEvents({ requestId, afterSeq: lastSeq });
          const ordered = [...(res.events ?? [])].sort((a, b) => a.seq - b.seq);
          for (const ev of ordered) {
            applyEvent(ev);
          }
          if (res.finished && !finished) {
            ensureResponseOpened(200, 'OK');
            finished = true;
            cleanup();
            try {
              streamController?.close();
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore transient drain failure while active */
        } finally {
          draining = false;
        }
      };

      const onAbort = () => {
        void plugin.abortStream({ requestId }).catch(() => {});
        finishError(new DOMException('Aborted', 'AbortError'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      unlistenResume = lifecycle.onResume(() => {
        void drainMissed();
      });

      // 兜底低频补拉：仅在长耗时无事件推送时确保切后台恢复不丢包
      fallbackTimer = setInterval(() => {
        if (!finished) void drainMissed();
      }, 4500);

      void plugin
        .addListener('coachStreamEvent', (ev) => {
          applyEvent(ev);
        })
        .then((handle) => {
          if (finished) {
            void handle.remove().catch(() => {});
            return null;
          }
          listenerHandle = handle;
          return plugin.startStream({
            requestId,
            url,
            method,
            headers,
            ...(bodyText !== undefined ? { body: bodyText } : {}),
          });
        })
        .then((started) => {
          if (started && !finished) {
            return drainMissed();
          }
          return undefined;
        })
        .catch((err) => {
          finishError(err instanceof Error ? err : new Error(String(err)));
        });
    });
  };
}

let cachedCoachFetch: typeof fetch | null = null;

/**
 * 获取供电子教练使用的默认 fetch：
 * · Android 原生包自动启用 CoachStream 原生后台保活流式桥；
 * · Web / 浏览器回归 / Vitest 保持 globalThis.fetch 不变。
 */
export function getCoachFetch(): typeof fetch {
  const plugin = getNativeCoachStreamPlugin();
  if (plugin) {
    if (!cachedCoachFetch) {
      cachedCoachFetch = createNativeStreamFetch(plugin);
    }
    return cachedCoachFetch;
  }
  return globalThis.fetch;
}
