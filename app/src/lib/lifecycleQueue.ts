/* 页面生命周期动作的串行控制（V5-02）。
   ── 问题背景（审查 V5D08）────────────────────────────────────
   hidden 与 visible 各自独立跑异步链：

       onHidden  : await saveQueue  →  release          （链 A）
       onVisible : await refresh    →  acquire          （链 B）

   如果 saveQueue 还没完成就回到前台，链 B 先跑完并宣告"可写"，
   随后链 A 才执行 release，把刚拿到的锁清掉 → 用户第一笔保存 no-lock。
   反过来"等 hidden 完全做完再 visible"是正常的，所以这个问题只在
   慢保存 / 快速返回的顺序下出现。

   ── 本轮做法 ────────────────────────────────────────────────
   1. **单一串行队列**：所有生命周期动作排队执行，前一个跑完才开始下一个。
      这样 visible 的 acquire 一定发生在 hidden 的 release 之后。
   2. **代次（generation）取消**：每次登记新动作就 +1 并记下期望代次；
      动作在 await 之后重新核对代次与"是否仍是最新意图"，
      过时的动作不再改动锁/UI。
   3. 队列里**不吞异常**：单个动作失败不影响后续动作。
   4. 不使用固定延迟；所有等待都是对真实 Promise 的等待。

   这个模块不碰 IndexedDB、不碰 React，纯调度，便于单测穷举顺序。 */

export interface ScheduledLifecycle {
  /** 本次动作的代次（越大越新） */
  generation: number;
  /** 执行完成（成功或失败）后 resolve */
  done: Promise<void>;
}

export class LifecycleQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  /** 最近一次登记的"意图"：用于判断动作是否已过时 */
  private latestIntent: string | null = null;

  /** 当前代次 */
  get currentGeneration(): number {
    return this.generation;
  }

  /** 最近一次登记的意图名（如 'visible' / 'hidden'） */
  get currentIntent(): string | null {
    return this.latestIntent;
  }

  /**
   * 登记一个生命周期动作。
   * @param intent 意图名，用于过时判断
   * @param run 实际工作；会收到一个 `isStale()` 供在 await 后自查
   */
  schedule(intent: string, run: (isStale: () => boolean) => Promise<void> | void): ScheduledLifecycle {
    this.generation += 1;
    const myGeneration = this.generation;
    this.latestIntent = intent;
    const isStale = () => myGeneration !== this.generation;

    const done = this.tail
      .catch(() => undefined)
      .then(async () => {
        /**
         * 注意：这里**不做**「排队期间就被取代 → 整个跳过」的预判。
         * 预判会让动作连 await 之前该做的事都不做（例如 hidden 必须先排空 saveQueue，
         * 那一笔保存不能因为随后回到前台就被丢掉）。
         * 正确的粒度是：动作自己在其每个 await 之后调用 isStale()，
         * 只放弃**过时的副作用**（主要是 release / acquire / 改 UI）。
         */
        try {
          await run(isStale);
        } catch {
          /* 单个动作失败不阻塞后续生命周期动作 */
        }
      });

    this.tail = done;
    return { generation: myGeneration, done };
  }

  /** 等待当前已登记的动作全部跑完（测试与卸载清理用） */
  async drain(): Promise<void> {
    await this.tail.catch(() => undefined);
  }
}
