/* Android 返回键 / 系统返回手势的**唯一调度点**（施工要求 C）。
   ── 为什么不能用「广播 Escape」────────────────────────────────
   网页里 Sheet 各自监听 document 的 keydown Escape。若把原生返回键实现成
   “document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))”：
     · 所有打开的 Sheet 会**同时**收到 Escape，一次返回把多层弹层一起关掉；
     · 该事件也会被输入框的 Escape（取消编辑）等其它监听器收到，产生副作用；
     · 无法表达「键盘先收起，其次页面返回」的优先级。
   施工要求明确：**先把最上层弹层关掉，其次是收键盘 / 页面返回**。

   ── 本模块做法 ────────────────────────────────────────────────
   维护一个**栈**：每个可被返回键关闭的东西（弹层、抽屉、确认框、训练中的弹层等）
   在打开时 push 一个 handler，关闭时由它自己的 effect 清理函数 pop。
   原生返回键到达时：
     1. 栈非空 → 只调用**最上面那一个** handler（返回 false 才继续往下）；
     2. 栈空但焦点在输入框 → 收键盘，消费掉；
     3. 都没有 → 返回 'none'，**交给调用方**去处理「页面返回」。

   ── A03 修正（本模块只做“层”的消费，绝不自己导航）────────────────
   旧实现把第 3 步写成“栈空时调用 pageFallback（→ back('/')）”，
   而 nativeBack.handleBackIntent 是先调 consume()、**之后**才 await 页面离开守卫。
   于是真实执行顺序是 [navigate, guard:false] —— 守卫说 false 也拦不住，
   导航已经发生了。现在：
     · consumeLayerOnly() 只负责「最上层 / 键盘」，永不导航；
     · 页面返回由 nativeBack 在 **await 守卫通过之后** 执行且只执行一次。
   这条边界是硬约定：本模块不认识路由，也不认识 history。 */

export interface BackHandler {
  /** 标识，仅用于诊断 */
  id: string;
  /** 返回 true 表示这次返回已被消费（不再继续向下） */
  handle: () => boolean | void;
}

type Listener = () => void;

class BackStack {
  private stack: BackHandler[] = [];
  private listeners = new Set<Listener>();
  /** 压入一个可被返回键关闭的层；返回 pop 函数（在 effect 清理里调用） */
  push(handler: BackHandler): () => void {
    // 同一个 id 重复压入时先移除旧的，避免 effect 抖动导致栈里堆同名项
    this.stack = this.stack.filter((h) => h.id !== handler.id);
    this.stack.push(handler);
    this.emit();
    let popped = false;
    return () => {
      if (popped) return;
      popped = true;
      this.stack = this.stack.filter((h) => h !== handler);
      this.emit();
    };
  }

  /** 当前栈深度（诊断与测试用） */
  get depth(): number {
    return this.stack.length;
  }

  /** 栈顶 handler 的 id（诊断与测试用） */
  get topId(): string | null {
    return this.stack.length ? this.stack[this.stack.length - 1].id : null;
  }

  /**
   * 只消费「最上层弹层」或「键盘」，**绝不导航**（A03）。
   *
   * @returns 'layer' 关了最上层；'keyboard' 收了键盘；'none' 本模块无事可做
   */
  consumeLayerOnly(): 'layer' | 'keyboard' | 'none' {
    const top = this.stack[this.stack.length - 1];
    if (top) {
      const consumed = top.handle();
      // handler 显式返回 false 才继续往下（默认视为已消费）
      if (consumed !== false) return 'layer';
    }
    if (this.dismissKeyboard()) return 'keyboard';
    return 'none';
  }

  /**
   * 收起软键盘：只在焦点确实在可输入元素上时才动手。
   *
   * 用**结构化判定**而不是 `instanceof HTMLElement`：
   * 后者依赖全局构造器存在（某些 WebView / 测试环境里没有），
   * 而且挡不住跨 window 的元素（不同 Realm 的 HTMLElement 不共享原型链）。
   */
  dismissKeyboard(): boolean {
    if (typeof document === 'undefined') return false;
    const active = document.activeElement as
      | { tagName?: string; isContentEditable?: boolean; blur?: () => void }
      | null
      | undefined;
    if (!active || typeof active !== 'object') return false;
    const tag = String(active.tagName ?? '').toUpperCase();
    const isEditable =
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable === true;
    if (!isEditable) return false;
    if (typeof active.blur !== 'function') return false;
    active.blur();
    return true;
  }

  /** 订阅栈变化（键盘高度/遮罩等 UI 可据此更新） */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 单个订阅者异常不影响返回调度 */
      }
    }
  }

  /** 仅供测试：清空栈 */
  __resetForTest(): void {
    this.stack = [];
    this.listeners.clear();
  }
}

/** 全局唯一返回栈（页面与弹层共用同一份） */
export const backStack = new BackStack();
