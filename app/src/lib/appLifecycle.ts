/* 前台/后台生命周期的**唯一协调者**（V8 原生接线）。
   ── 为什么需要它（施工要求 C）────────────────────────────────
   Web 版只有 DOM 事件：visibilitychange / pagehide / pageshow。
   Android 原生容器里还会额外收到 Capacitor App 的 appStateChange / pause / resume。
   如果这几路信号各自独立去抢锁/放锁，就退化成 V5-02 已经修过的那个 bug
   （hidden 的 release 晚于 visible 的 acquire 落地 → 回前台后第一笔保存 no-lock），
   只是这次冲突来源变成了「DOM 事件 vs 原生事件」。

   本模块的规则：
   1. **只有一份 LifecycleQueue**：所有来源的动作都排进同一个串行队列，
      visible/resume 的 acquire 一定排在 hidden/pause 的 release 之后。
   2. **去重**：按「当前是否在前台」的布尔做边沿触发。
      DOM 的 hidden 与原生 pause 是同一件事的两个信号，只处理一次。
   3. 队列里**不做预判跳过**：动作自己在 await 之后用 isStale() 放弃过时的副作用。
   4. 本模块不碰 IndexedDB、不碰 React，纯调度，便于单测穷举顺序。

   ── A04 修正：异步订阅必须持有“代次所有权”────────────────────
   旧实现 start() 里 fire-and-forget 地 await App.addListener(...)。
   如果在第一个 addListener 的 Promise 还没 resolve 时调用 stop()，
   那么 await 之后仍然会把 3 个监听全部注册进来、一个也不移除，
   而且原生 pause 回调仍会调用已停止实例的 onHide。

   现在每次 start/stop 都推进一个 generation（代次）：
     · 订阅过程持有自己的代次；
     · **每完成一个 await 立刻复核**：代次过期 → 立即移除刚拿到 handle 并停止继续注册；
     · 事件回调先复核代次与 stopped 标记，过期就什么都不做。
   这样“停在一个 await 中间”不会留下任何活着的监听。 */

import { LifecycleQueue } from './lifecycleQueue';
import { isNativePlatform } from './platform';

export interface LifecycleHandlers {
  /** 进入后台：先排空待存队列，再释放锁 */
  onHide: (isStale: () => boolean) => Promise<void> | void;
  /** 回到前台：重新对齐编辑资格（拿锁 / 只读） */
  onShow: (isStale: () => boolean) => Promise<void> | void;
  /** 平台信号的调试记录（可选，用于诊断为什么触发） */
  onSignal?: (source: string, foreground: boolean) => void;
}

interface ListenerHandle {
  remove: () => Promise<void> | void;
}

export interface AppPluginShape {
  addListener(
    event: 'appStateChange' | 'pause' | 'resume',
    cb: (state?: { isActive?: boolean }) => void,
  ): Promise<ListenerHandle> | ListenerHandle;
}

/**
 * 测试/嵌入用注入点：默认实现是动态 import('@capacitor/app')。
 * 显式注入让「异步订阅时序」可被确定性测试，不依赖模块 mock 的注册顺序。
 */
export type NativeAppLoader = () => Promise<AppPluginShape | null>;

export interface AppLifecycleOptions {
  /** 平台判定（默认 isNativePlatform） */
  isNative?: () => boolean;
  /** 原生 App 插件加载器（默认动态 import '@capacitor/app'） */
  loadNativeApp?: NativeAppLoader;
}

export class AppLifecycleCoordinator {
  private queue = new LifecycleQueue();
  /** 当前是否在前台（唯一真源，所有信号都归一到这个布尔） */
  private foreground: boolean;
  /** 代次：每次 start/stop 递增；异步订阅用它判断自己是否已过期 */
  private generation = 0;
  private stopped = true;
  private removers: Array<() => void> = [];
  private handlers: LifecycleHandlers | null = null;

  private readonly isNative: () => boolean;
  private readonly loadNativeApp: NativeAppLoader;

  constructor(foreground?: boolean, options?: AppLifecycleOptions) {
    this.foreground = foreground ?? (typeof document === 'undefined' || document.visibilityState !== 'hidden');
    this.isNative = options?.isNative ?? isNativePlatform;
    this.loadNativeApp = options?.loadNativeApp ?? defaultNativeAppLoader;
  }

  get isForeground(): boolean {
    return this.foreground;
  }

  /** 当前代次（诊断与测试用） */
  get currentGeneration(): number {
    return this.generation;
  }

  /** 是否仍在运行 */
  get isRunning(): boolean {
    return !this.stopped;
  }

  /** 串行队列（供外部 drain / 测试） */
  get lifecycleQueue(): LifecycleQueue {
    return this.queue;
  }

  /**
   * 开始监听。**幂等**：重复调用不会重复注册。
   * @returns 停止函数
   */
  start(handlers: LifecycleHandlers): () => void {
    this.handlers = handlers;
    if (!this.stopped) return () => this.stop();

    this.stopped = false;
    this.generation += 1;
    const myGeneration = this.generation;

    /** 该代次是否仍然有效（未被 stop、且没被更新的一次 start 取代） */
    const stillValid = () => !this.stopped && this.generation === myGeneration;

    const goBackground = (source: string) => {
      if (!stillValid()) return; // A04：过期代次的回调不得触发任何动作
      if (!this.foreground) return; // 去重
      this.foreground = false;
      const h = this.handlers;
      h?.onSignal?.(source, false);
      if (h) this.queue.schedule('hidden', (isStale) => h.onHide(isStale));
    };

    const goForeground = (source: string) => {
      if (!stillValid()) return; // A04
      if (this.foreground) return; // 去重
      this.foreground = true;
      const h = this.handlers;
      h?.onSignal?.(source, true);
      if (h) this.queue.schedule('visible', (isStale) => h.onShow(isStale));
    };

    // ── DOM 信号 ──────────────────────────────────────────────
    const onVisibility = () => {
      if (!stillValid()) return;
      if (document.visibilityState === 'hidden') goBackground('visibilitychange');
      else goForeground('visibilitychange');
    };
    const onPageHide = () => goBackground('pagehide');
    const onPageShow = (e: PageTransitionEvent) => {
      goForeground(e.persisted ? 'pageshow-bfcache' : 'pageshow');
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    this.removers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    });

    // ── 原生信号（只有真的在原生容器里才订阅）──────────────────
    if (this.isNative()) {
      void this.attachNativeApp(stillValid, goBackground, goForeground);
    }

    return () => this.stop();
  }

  /**
   * 订阅 Capacitor App 的生命周期事件。
   *
   * A04 关键：**每个 await 之后都复核代次**。过期就立刻把刚拿到的 handle 移除，
   * 并且不再继续注册后面的监听 —— 否则 stop() 之后仍会留下一整套活监听。
   */
  private async attachNativeApp(
    stillValid: () => boolean,
    goBackground: (source: string) => void,
    goForeground: (source: string) => void,
  ): Promise<void> {
    /** 已经拿到、但可能因为过期需要立刻丢弃的 handle */
    const acquire = async (
      event: 'appStateChange' | 'pause' | 'resume',
      cb: (state?: { isActive?: boolean }) => void,
    ): Promise<ListenerHandle | null> => {
      let plugin: AppPluginShape | null;
      try {
        plugin = await this.loadNativeApp();
      } catch {
        return null;
      }
      // await 之后：代次已过期 → 一个监听都不注册
      if (!stillValid() || !plugin) return null;

      let handle: ListenerHandle;
      try {
        handle = await Promise.resolve(plugin.addListener(event, cb));
      } catch {
        return null;
      }
      // 第二个 await 之后：代次已过期 → 立刻移除刚拿到的 handle
      if (!stillValid()) {
        void safeRemove(handle);
        return null;
      }
      // 仍有效：登记为可移除（stop() 时统一清理）
      this.removers.push(() => void safeRemove(handle));
      return handle;
    };

    // 顺序注册：任何一个环节发现过期都会在内部清掉自己并返回，后续注册自然停止
    const stateHandle = await acquire('appStateChange', (state) => {
      if (!state) return;
      if (typeof state.isActive !== 'boolean') return;
      if (state.isActive) goForeground('appStateChange');
      else goBackground('appStateChange');
    });
    if (!stateHandle || !stillValid()) return;

    const pauseHandle = await acquire('pause', () => goBackground('native-pause'));
    if (!pauseHandle || !stillValid()) return;

    await acquire('resume', () => goForeground('native-resume'));
  }

  /** 停止监听并等待队列排空（卸载/测试清理用） */
  stop(): void {
    // 推进代次：任何正在 await 中的订阅都会在下一行复核处失效
    this.generation += 1;
    this.stopped = true;
    this.handlers = null;

    for (const off of this.removers) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.removers = [];
  }

  /** 等待当前已登记的队列动作全部完成 */
  async drain(): Promise<void> {
    await this.queue.drain();
  }
}

/** 默认加载器：动态 import，失败即视为“原生事件不可用” */
async function defaultNativeAppLoader(): Promise<AppPluginShape | null> {
  try {
    const mod = await import('@capacitor/app');
    return (mod.App as unknown as AppPluginShape) ?? null;
  } catch {
    return null;
  }
}

/** 移除 handle 且绝不因它抛错而中断清理 */
async function safeRemove(handle: ListenerHandle | null): Promise<void> {
  if (!handle) return;
  try {
    await Promise.resolve(handle.remove());
  } catch {
    /* ignore */
  }
}
