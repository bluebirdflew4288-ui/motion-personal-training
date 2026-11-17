/* G04：应用级非输入区选区、原生拖拽与 Android WebView 文本菜单守卫。
   ── 职责边界 ─────────────────────────────────────────────────
   · 仅对真正可编辑文本控件（文本/数字类 input、textarea、contenteditable）放行
     选区、长按菜单与复制粘贴；
   · 在文档级统一拦截非编辑目标的 selectstart / contextmenu / dragstart，
     并清理意外落在非编辑容器上的空 Range（防止外层容器选区唤出系统浮动菜单或任意门）；
   · 若运行在 MOTION Android WebView 内，同步将当前触摸/焦点是否处于文本输入控件
     实时通知原生层（window.__motionSelectionGuard），由原生层协同阻断非编辑区的
     performLongClick / startActionMode / startDragAndDrop。 */

export interface NativeSelectionGuardBridge {
  setTouchEditable?: (editable: boolean) => void;
  clearTouch?: () => void;
  setFocusEditable?: (editable: boolean) => void;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

function getNativeBridge(): NativeSelectionGuardBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { __motionSelectionGuard?: NativeSelectionGuardBridge };
  return w.__motionSelectionGuard ?? null;
}

function elementFromNode(node: EventTarget | Node | null | undefined): Element | null {
  if (!node) return null;
  if (typeof Element !== 'undefined' && node instanceof Element) return node;
  if (typeof Node !== 'undefined' && node instanceof Node) return node.parentElement;
  return null;
}

/** 判定元素本身或其祖先是否为允许文本选区/系统复制粘贴的输入控件 */
export function isTextEditableElement(el: Element | null): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  const host = el.closest(EDITABLE_SELECTOR);
  if (!host) return false;
  if (host.tagName === 'INPUT') {
    const type = (host.getAttribute('type') || 'text').trim().toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return true;
}

export function isTextEditableTarget(target: EventTarget | null): boolean {
  return isTextEditableElement(elementFromNode(target));
}

export function selectionWithinEditable(sel: Selection | null): boolean {
  if (!sel || sel.rangeCount === 0) return true;
  const anchorOk = isTextEditableElement(elementFromNode(sel.anchorNode));
  const focusOk = isTextEditableElement(elementFromNode(sel.focusNode));
  return anchorOk || focusOk;
}

function syncNativeTouch(editable: boolean): void {
  try {
    getNativeBridge()?.setTouchEditable?.(editable);
  } catch {
    /* 原生桥异常不阻断前端交互 */
  }
}

function syncNativeTouchClear(): void {
  try {
    getNativeBridge()?.clearTouch?.();
  } catch {
    /* ignore */
  }
}

function syncNativeFocus(editable: boolean): void {
  try {
    getNativeBridge()?.setFocusEditable?.(editable);
  } catch {
    /* ignore */
  }
}

let refCount = 0;
let teardownSingleton: (() => void) | null = null;

/**
 * 安装全局非输入区选区/拖拽守卫（引用计数单例：App 根与卡片协调器重复挂载只装一份监听）。
 */
export function installSelectionGuard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  refCount += 1;
  if (refCount === 1 && !teardownSingleton) {
    const onPointerDown = (ev: PointerEvent) => {
      syncNativeTouch(isTextEditableTarget(ev.target));
    };
    const onTouchStart = (ev: TouchEvent) => {
      syncNativeTouch(isTextEditableTarget(ev.target));
    };
    const onPointerEnd = (ev: PointerEvent) => {
      if (ev.pointerType !== 'touch') syncNativeTouchClear();
    };
    const onTouchEnd = (ev: TouchEvent) => {
      if (ev.touches.length === 0) syncNativeTouchClear();
    };
    const onFocusIn = (ev: FocusEvent) => {
      syncNativeFocus(isTextEditableTarget(ev.target) || isTextEditableElement(document.activeElement));
    };
    const onFocusOut = (ev: FocusEvent) => {
      const next = ev.relatedTarget;
      if (next) {
        syncNativeFocus(isTextEditableTarget(next));
      } else {
        queueMicrotask(() => {
          if (typeof document !== 'undefined') {
            syncNativeFocus(isTextEditableElement(document.activeElement));
          }
        });
      }
    };
    const onBlur = () => {
      syncNativeTouchClear();
      syncNativeFocus(isTextEditableElement(document.activeElement));
    };
    const blockIfNonEditable = (ev: Event) => {
      if (isTextEditableTarget(ev.target)) return;
      ev.preventDefault();
    };
    const onSelectionChange = () => {
      if (isTextEditableElement(document.activeElement)) return;
      const sel = window.getSelection?.() ?? null;
      if (sel && sel.rangeCount > 0 && !selectionWithinEditable(sel)) {
        try {
          sel.removeAllRanges();
        } catch {
          /* ignore */
        }
      }
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerEnd, true);
    document.addEventListener('pointercancel', onPointerEnd, true);
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('selectstart', blockIfNonEditable, true);
    document.addEventListener('dragstart', blockIfNonEditable, true);
    document.addEventListener('contextmenu', blockIfNonEditable, true);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('blur', onBlur);

    syncNativeFocus(isTextEditableElement(document.activeElement));

    teardownSingleton = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerEnd, true);
      document.removeEventListener('pointercancel', onPointerEnd, true);
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('selectstart', blockIfNonEditable, true);
      document.removeEventListener('dragstart', blockIfNonEditable, true);
      document.removeEventListener('contextmenu', blockIfNonEditable, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('blur', onBlur);
      syncNativeTouchClear();
      syncNativeFocus(false);
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0) {
      teardownSingleton?.();
      teardownSingleton = null;
    }
  };
}
