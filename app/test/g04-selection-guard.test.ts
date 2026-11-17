/* G04：非输入区防选词/防原生拖拽残影 + Android MotionWebView 接线契约测试。 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isTextEditableElement } from '../src/ui/selectionGuard';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const readApp = (p: string) => readFileSync(resolve(APP, p), 'utf8');

interface FakeNode {
  tagName: string;
  getAttribute(k: string): string | null;
  closest(selector: string): FakeNode | null;
}

function fakeEl(tag: string, attrs: Record<string, string> = {}, parent: FakeNode | null = null): FakeNode {
  const upper = tag.toUpperCase();
  const node: FakeNode = {
    tagName: upper,
    getAttribute(k: string): string | null {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    closest(selector: string): FakeNode | null {
      const matchSelf = (): boolean => {
        if (upper === 'INPUT' && selector.includes('input')) return true;
        if (upper === 'TEXTAREA' && selector.includes('textarea')) return true;
        const ce = attrs.contenteditable;
        if (ce !== undefined && (ce === '' || ce === 'true' || ce === 'plaintext-only')) {
          return selector.includes('contenteditable');
        }
        return false;
      };
      if (matchSelf()) return node;
      return parent ? parent.closest(selector) : null;
    },
  };
  return node;
}

describe('G04 isTextEditableElement 控件分类', () => {
  it('允许文本/数字/搜索类 input、textarea 与 contenteditable（含子节点）', () => {
    expect(isTextEditableElement(fakeEl('input') as unknown as Element)).toBe(true);
    expect(isTextEditableElement(fakeEl('input', { type: 'text' }) as unknown as Element)).toBe(true);
    expect(isTextEditableElement(fakeEl('input', { type: 'number' }) as unknown as Element)).toBe(true);
    expect(isTextEditableElement(fakeEl('input', { type: 'search' }) as unknown as Element)).toBe(true);
    expect(isTextEditableElement(fakeEl('textarea') as unknown as Element)).toBe(true);
    const ce = fakeEl('div', { contenteditable: 'true' });
    const innerSpan = fakeEl('span', {}, ce);
    expect(isTextEditableElement(ce as unknown as Element)).toBe(true);
    expect(isTextEditableElement(innerSpan as unknown as Element)).toBe(true);
  });

  it('拒绝滑杆、复选框、按钮与普通展示元素', () => {
    expect(isTextEditableElement(fakeEl('input', { type: 'range' }) as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('input', { type: 'checkbox' }) as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('input', { type: 'radio' }) as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('input', { type: 'button' }) as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('button') as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('h3') as unknown as Element)).toBe(false);
    expect(isTextEditableElement(fakeEl('div') as unknown as Element)).toBe(false);
    expect(isTextEditableElement(null)).toBe(false);
  });
});

describe('G04 Web + Android 原生 WebView 门禁源码契约', () => {
  const baseCss = readApp('src/styles/base.css');
  const appTsx = readApp('src/App.tsx');
  const cardTsx = readApp('src/ui/SwipeActionCard.tsx');
  const dragTs = readApp('src/ui/cardDrag.ts');
  const policyJava = readApp('android/app/src/main/java/app/motion/personal/plugins/WebViewSelectionPolicy.java');
  const webViewJava = readApp('android/app/src/main/java/app/motion/personal/MotionWebView.java');
  const mainActivityJava = readApp('android/app/src/main/java/app/motion/personal/MainActivity.java');
  const bridgeLayoutPath = resolve(APP, 'android/app/src/main/res/layout/capacitor_bridge_layout_main.xml');

  it('全局外壳与排序容器默认 user-select:none，杜绝浮起卡片击穿到可选父容器', () => {
    expect(baseCss).toContain('.app-shell,');
    expect(baseCss).toContain('[data-reorder-zone],');
    expect(baseCss).toContain('[data-drag-placeholder],');
    expect(appTsx).toContain('installSelectionGuard()');
    expect(dragTs).toContain('installSelectionGuard()');
  });

  it('卡片收起态操作层隐藏，不再常驻暴露隐藏按钮文字；panGuard 与全局取消收口到协调器', () => {
    expect(cardTsx).toContain("visibility: actionsExposed ? 'visible' : 'hidden'");
    expect(cardTsx).not.toContain('panGuardRef');
    expect(dragTs).toContain('armPanGuard()');
    expect(dragTs).toContain('disarmPanGuard()');
  });

  it('Android 布局覆盖使用 MotionWebView，且原生层拦截非输入区长按、ActionMode 与 startDragAndDrop', () => {
    expect(existsSync(bridgeLayoutPath)).toBe(true);
    const layoutXml = readFileSync(bridgeLayoutPath, 'utf8');
    expect(layoutXml).toContain('<app.motion.personal.MotionWebView');
    expect(layoutXml).toContain('android:id="@+id/webview"');

    expect(webViewJava).toContain('extends CapacitorWebView');
    expect(webViewJava).toContain('__motionSelectionGuard');
    expect(webViewJava).toContain('performLongClick');
    expect(webViewJava).toContain('startActionMode');
    expect(webViewJava).toContain('dispatchDragEvent');
    expect(webViewJava).toContain('cancelDragAndDrop');
    expect(mainActivityJava).toContain('onActionModeStarted');
    expect(policyJava).not.toContain('import android.');
  });
});
