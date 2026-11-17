#!/usr/bin/env node
/* G01/G02 真实 DOM + CDP 触摸回归（2026-11-15 0.1.10 用户拒收后的返工）。
 *
 * 覆盖：
 *  1. 卡片展示文字的有效样式：逐节点 user-select:none、touch-callout:none、
 *     非交互展示子树 pointer-events:none（触摸命中不落在文本节点）。
 *  2. 真实 CDP touch 长按：不产生选区、不弹 contextmenu、卡片浮起并拖动，
 *     松手只提交一次排序（revision 恰好 +1）。
 *  3. pointercancel/touchCancel：取消拖动、清理占位、不提交。
 *  4. 输入框/textarea：user-select:text、pointer-events:auto，编辑与选区正常。
 *  5. 按钮/纵滚/记录展开门禁：按钮触摸可点、纵滚不触发拖动、展开态禁拖。
 *  6. G02 删除按钮与 F09 就绪横幅：浅/深主题 computed 颜色 + 截图像素 +
 *     白字对比度 ≥4.5；F10 消散视觉层如出现则同步校验 danger 色。
 *
 * 使用项目现有 puppeteer-core + esbuild + pngjs，不新增依赖。
 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G1_EVIDENCE_DIR
  || join(process.env.MOTION_UI_EVIDENCE_DIR || '/private/tmp/motion-harness-gesture-red-resume-20261115-v1/ui', 'g1-selection-red');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEL = (id) => `[data-testid="${id}"]`;

function parseRgb(s) {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function srgb(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function near(actual, expected, tol = 2) {
  return actual && expected && actual.every((v, i) => Math.abs(v - expected[i]) <= tol);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, 'screens'), { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: g3bEntry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __AUDIT_STRICT__: 'false', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: '"web"' },
    nodePaths: [join(APP_DIR, 'node_modules')], logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (req.url.startsWith('/style.css')) { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (req.url.startsWith('/fonts/')) {
      try { res.end(await readFile(join(APP_DIR, 'public', req.url.split('?')[0]))); } catch { res.statusCode = 404; res.end(); }
    } else res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    userDataDir: join(OUT, 'chrome-profile'),
    args: ['--no-first-run', '--disable-extensions', '--no-sandbox'],
  });
  const result = { suite: 'g1-selection-red', cases: [], screenshots: [], errors: [] };
  let idx = 0;

  async function setupPage(page) {
    page.setDefaultTimeout(12000);
    page.on('pageerror', (e) => result.errors.push(String(e)));
    await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
    if (await page.evaluate(() => window.__bootError)) throw new Error(await page.evaluate(() => window.__bootError));
    await page.waitForSelector(SEL('exercise-card-g3b-ex-1'));
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  async function newPage() {
    const ctx = await browser.createBrowserContext();
    try { await ctx.overridePermissions(url, ['clipboard-read', 'clipboard-write']); } catch { /* 某些 headless 不支持 */ }
    const page = await ctx.newPage();
    await setupPage(page);
    return { ctx, page };
  }

  async function runCase(name, fn) {
    idx += 1;
    const entry = { name, ok: true, errors: [], screenshot: join(OUT, 'screens', `case-${String(idx).padStart(2, '0')}.png`) };
    let ctx;
    try {
      const made = await newPage();
      ctx = made.ctx;
      const evidence = await fn(made.page, entry);
      if (evidence !== undefined) entry.evidence = evidence;
      result.cases.push(entry);
      console.log('  ✔ ' + name);
    } catch (e) {
      entry.ok = false;
      entry.detail = e instanceof Error ? e.message : String(e);
      result.cases.push(entry);
      console.log('  ✘ ' + name + ' :: ' + entry.detail);
    } finally {
      try { if (ctx) { const pages = await ctx.pages(); if (pages[0]) await pages[0].screenshot({ path: entry.screenshot }).catch(() => {}); } } catch { /* ignore */ }
      if (entry.screenshot) result.screenshots.push(entry.screenshot);
      try { await ctx?.close(); } catch { /* ignore */ }
    }
  }

  const order = (page) => page.evaluate(() => window.__test.order());
  const ensureCollapsed = async (page, id) => {
    const button = SEL(`exercise-card-${id}`) + ' button[aria-expanded]';
    const expanded = await page.$eval(button, (e) => e.getAttribute('aria-expanded') === 'true');
    if (expanded) { await page.click(button); await sleep(160); }
  };
  const ensureExpanded = async (page, id) => {
    const button = SEL(`exercise-card-${id}`) + ' button[aria-expanded]';
    const expanded = await page.$eval(button, (e) => e.getAttribute('aria-expanded') === 'true');
    if (!expanded) { await page.click(button); await sleep(160); }
  };
  const cardBox = async (page, id, prefix = 'exercise-card-') => {
    const el = await page.waitForSelector(SEL(`${prefix}${id}`));
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(80);
    const b = await el.boundingBox();
    if (!b) throw new Error('no box ' + id);
    return b;
  };
  const touchStart = (client, x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
  const touchMove = (client, x, y) => client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
  const touchEnd = (client) => client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const touchCancel = (client) => client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  const touchPointsEvent = (client, type, points) => client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ radiusX: 2, radiusY: 2, force: 1, ...p })),
  });
  const tap = async (client, x, y) => { await touchStart(client, x, y); await sleep(50); await touchEnd(client); };
  const samplePixel = async (page, x, y) => {
    // 直接在整页截图上按视口坐标采样，避免 clip 与移动视口缩放的歧义。
    const buf = await page.screenshot();
    const png = PNG.sync.read(Buffer.from(buf));
    const px = Math.max(0, Math.min(png.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(png.height - 1, Math.round(y)));
    const i = (py * png.width + px) * 4;
    return { pixel: [png.data[i], png.data[i + 1], png.data[i + 2]], width: png.width, height: png.height };
  };
  const setTheme = async (page, theme) => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await sleep(120);
  };
  const openActions = async (page, id) => {
    const b = await cardBox(page, id);
    const y = b.y + 28;
    const x = b.x + b.width * 0.7;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 170, y, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction((s) => {
      const layer = document.querySelector(s)?.parentElement;
      return layer && layer.getAttribute('aria-hidden') !== 'true';
    }, { timeout: 6000 }, SEL(`exercise-card-${id}-edit`));
    await sleep(220);
  };

  // ── 1. 有效样式 + 命中层 ─────────────────────────────────────────────
  await runCase('display text is non-selectable at computed-style and hit-test layers', async (page) => {
    const id = 'exercise-card-g3b-ex-2';
    await ensureCollapsed(page, 'g3b-ex-2');
    await cardBox(page, 'g3b-ex-2');
    const report = await page.evaluate((cardSel) => {
      const card = document.querySelector(cardSel);
      const body = card.querySelector('.reorder-card-body');
      const content = card.querySelector('[data-drag-handle]');
      const h3 = card.querySelector('h3');
      const r = h3.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width * 0.3, r.y + r.height * 0.5);
      const cr = document.caretRangeFromPoint(r.x + r.width * 0.3, r.y + r.height * 0.5);
      const s = (el) => {
        const cs = getComputedStyle(el);
        return {
          userSelect: cs.userSelect, webkitUserSelect: cs.webkitUserSelect,
          webkitTouchCallout: cs.webkitTouchCallout, pointerEvents: cs.pointerEvents,
        };
      };
      return {
        cardClass: card.className,
        hasBody: Boolean(body),
        body: body ? s(body) : null,
        content: content ? s(content) : null,
        h3: s(h3),
        hitTag: at ? at.tagName : null,
        hitClass: at ? String(at.className || '') : null,
        hitIsTextNodeTarget: Boolean(at && (at === h3 || at.closest('h3'))),
        caretAtH3: cr ? {
          containerTag: cr.startContainer.nodeType === 3 ? cr.startContainer.parentElement?.tagName : cr.startContainer.tagName,
          text: cr.startContainer.textContent?.slice(0, 40),
        } : null,
      };
    }, SEL(id));
    if (!report.hasBody) throw new Error('缺少 .reorder-card-body');
    if (!/\breorder-card\b/.test(report.cardClass)) throw new Error('卡根缺少 reorder-card: ' + report.cardClass);
    for (const key of ['body', 'content', 'h3']) {
      const s = report[key];
      if (!s) throw new Error('missing ' + key);
      if (s.userSelect !== 'none' || s.webkitUserSelect !== 'none') throw new Error(`${key} user-select 不是 none: ${JSON.stringify(s)}`);
    }
    // Chrome 不实现 -webkit-touch-callout，computed 可能为空；CSS 规则存在即可，不把它当主判据。
    if (report.h3.webkitTouchCallout && report.h3.webkitTouchCallout !== 'none') throw new Error('h3 touch-callout 异常: ' + report.h3.webkitTouchCallout);
    if (report.h3.pointerEvents !== 'none') throw new Error('h3 pointer-events 不是 none');
    if (report.hitIsTextNodeTarget) throw new Error('触摸命中仍落在 h3 文本: ' + JSON.stringify(report));
    // 内容层必须仍可接收手势
    if (report.content.pointerEvents !== 'auto') throw new Error('内容层 pointer-events 不是 auto');
    // 输入控件必须恢复 text
    await ensureExpanded(page, 'g3b-ex-1');
    const input = await page.waitForSelector(SEL('exercise-card-g3b-ex-1') + ' input[aria-label*="次数"]');
    const inputStyle = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { userSelect: cs.userSelect, pointerEvents: cs.pointerEvents };
    });
    if (inputStyle.userSelect !== 'text' || inputStyle.pointerEvents !== 'auto') throw new Error('输入框未保持可选中: ' + JSON.stringify(inputStyle));
    return { ...report, inputStyle };
  });

  // ── 2. 触摸长按：无选区、无菜单、浮起拖动、只提交一次 ─────────────────
  await runCase('CDP touch long-press: no selection, floats, drags, commits exactly once', async (page) => {
    await ensureCollapsed(page, 'g3b-ex-2');
    const before = await order(page);
    const first = await page.waitForSelector(SEL('exercise-card-g3b-ex-2'));
    await first.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(100);
    const b2 = await first.boundingBox();
    const b4 = await (await page.waitForSelector(SEL('exercise-card-g3b-ex-4'))).boundingBox();
    if (!b2 || !b4) throw new Error('卡片坐标缺失');
    const client = await page.createCDPSession();
    const events = await page.evaluate(() => {
      window.__g1Events = { selectstart: 0, contextmenu: 0, selectionchange: 0, pointercancel: 0 };
      const bump = (k) => () => { window.__g1Events[k] += 1; };
      document.addEventListener('selectstart', bump('selectstart'), true);
      document.addEventListener('contextmenu', bump('contextmenu'), true);
      document.addEventListener('selectionchange', bump('selectionchange'), true);
      document.addEventListener('pointercancel', bump('pointercancel'), true);
      return window.__g1Events;
    });
    const x = b2.x + b2.width * 0.42;
    const y = b2.y + 28;
    await touchStart(client, x, y);
    await sleep(390);
    const held = await page.evaluate(() => ({
      selection: window.getSelection()?.toString() ?? '',
      rangeCount: window.getSelection()?.rangeCount ?? 0,
      dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
      events: { ...window.__g1Events },
      activeElement: document.activeElement?.tagName ?? null,
    }));
    if (!held.dragging) throw new Error('长按 390ms 后未进入拖动（340ms 阈值未生效）: ' + JSON.stringify(held));
    if (held.selection !== '' || held.rangeCount !== 0) throw new Error('长按出现选区: ' + JSON.stringify(held));
    if (held.events.selectstart !== 0 || held.events.contextmenu !== 0) throw new Error('出现 selectstart/contextmenu: ' + JSON.stringify(held.events));
    const targetY = b4.y + b4.height * 0.75;
    for (let i = 1; i <= 12; i += 1) {
      await touchMove(client, x, y + ((targetY - y) * i) / 12);
      await sleep(16);
    }
    await touchEnd(client);
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength.indexOf('g3b-ex-2') !== 1), { timeout: 6000 });
    await sleep(180);
    const after = await order(page);
    const released = await page.evaluate(() => ({
      selection: window.getSelection()?.toString() ?? '',
      rangeCount: window.getSelection()?.rangeCount ?? 0,
      events: { ...window.__g1Events },
      placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
      dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
    }));
    if (released.selection !== '' || released.rangeCount !== 0) throw new Error('松手后仍有选区: ' + JSON.stringify(released));
    if (released.placeholder || released.dragging) throw new Error('松手后拖动未清理: ' + JSON.stringify(released));
    if (after.revision !== before.revision + 1) throw new Error(`排序应只落库一次: ${before.revision} -> ${after.revision}`);
    if (after.strength.length !== before.strength.length) throw new Error('条目数量变化');
    const sig = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (sig(after.setsById) !== sig(before.setsById)) throw new Error('sets 内容被重建');
    return { held, released, beforeRevision: before.revision, afterRevision: after.revision, events };
  });

  // ── 3. pointercancel/touchCancel：不提交、清理占位 ─────────────────────
  await runCase('touchCancel during drag cleans up without commit', async (page) => {
    await ensureCollapsed(page, 'g3b-ex-2');
    const before = await order(page);
    const b = await cardBox(page, 'g3b-ex-2');
    const client = await page.createCDPSession();
    const x = b.x + b.width * 0.42;
    const y = b.y + 28;
    await page.evaluate(() => { window.__g1PointerCancel = 0; document.addEventListener('pointercancel', () => { window.__g1PointerCancel += 1; }, true); });
    await touchStart(client, x, y);
    await sleep(400);
    if (!(await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]'))))) throw new Error('未进入拖动');
    await touchMove(client, x, y + 90);
    await sleep(80);
    await touchCancel(client);
    await sleep(260);
    const after = await order(page);
    const state = await page.evaluate(() => ({
      selection: window.getSelection()?.toString() ?? '',
      dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
      placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
      pointercancel: window.__g1PointerCancel ?? 0,
    }));
    if (state.dragging || state.placeholder) throw new Error('取消后未清理: ' + JSON.stringify(state));
    if (state.pointercancel < 1) throw new Error('CDP touchCancel 未派发真实 pointercancel: ' + JSON.stringify(state));
    if (state.selection !== '') throw new Error('取消后出现选区: ' + state.selection);
    if (after.revision !== before.revision || JSON.stringify(after.strength) !== JSON.stringify(before.strength)) {
      throw new Error(`取消不应提交: rev ${before.revision}->${after.revision}; ${JSON.stringify(before.strength)} -> ${JSON.stringify(after.strength)}`);
    }
    return { state, beforeRevision: before.revision, afterRevision: after.revision };
  });

  // ── 4. 输入框/textarea 编辑、选区、复制粘贴 ──────────────────────────
  await runCase('input and textarea keep editing, selection, copy and paste', async (page) => {
    await ensureExpanded(page, 'g3b-ex-1');
    const input = await page.waitForSelector(SEL('exercise-card-g3b-ex-1') + ' input[aria-label*="次数"]');
    const inputStyle = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { userSelect: cs.userSelect, pointerEvents: cs.pointerEvents };
    });
    if (inputStyle.userSelect !== 'text' || inputStyle.pointerEvents !== 'auto') throw new Error('input 样式错误: ' + JSON.stringify(inputStyle));
    await input.click();
    await page.keyboard.type('12');
    const selected = await input.evaluate((el) => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
      return { start: el.selectionStart, end: el.selectionEnd, length: el.value.length };
    });
    if (selected.start !== 0 || selected.end !== selected.length || selected.length < 2) throw new Error('input 选区失败: ' + JSON.stringify(selected));
    // 复制：选中后执行浏览器 copy 命令（headless 没有系统剪贴板，无法读回；
    // 但命令必须可用，且页面未拦截 copy/paste 默认行为）。
    const copyOk = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement)) return false;
      el.focus(); el.setSelectionRange(0, el.value.length);
      return document.execCommand('copy');
    });
    if (!copyOk) throw new Error('input 复制命令被拦截');
    const pasteNotPrevented = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLInputElement)) return false;
      const dt = new DataTransfer(); dt.setData('text/plain', '987');
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      return el.dispatchEvent(ev); // false = 页面阻止了 paste
    });
    if (!pasteNotPrevented) throw new Error('input paste 默认行为被页面阻止');
    // 粘贴后的输入提交链由真实键盘输入覆盖（headless 无系统剪贴板，不能伪装真实 OS paste）。
    await input.evaluate((el) => { el.focus(); el.setSelectionRange(0, el.value.length); });
    await page.keyboard.type('987');
    const pasted = await input.evaluate((el) => el.value);
    if (!pasted.includes('987')) throw new Error('input 文本输入失败: ' + pasted);
    const clipboard = await page.evaluate(() => typeof navigator.clipboard);
    // 先提交 reps 草稿，避免会话级“待存草稿”把 textarea 置为 disabled。
    await page.keyboard.press('Tab');
    await sleep(350);
    // textarea
    const noteBtn = await page.evaluateHandle((s) => [...document.querySelectorAll(s + ' button')].find((b) => b.textContent.includes('备注')), SEL('exercise-card-g3b-ex-1'));
    const noteEl = noteBtn.asElement();
    if (!noteEl) throw new Error('找不到备注按钮');
    await noteEl.click();
    await sleep(160);
    const textarea = await page.waitForSelector(SEL('exercise-card-g3b-ex-1') + ' textarea');
    const taStyle = await textarea.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { userSelect: cs.userSelect, pointerEvents: cs.pointerEvents };
    });
    if (taStyle.userSelect !== 'text' || taStyle.pointerEvents !== 'auto') throw new Error('textarea 样式错误: ' + JSON.stringify(taStyle));
    await textarea.click();
    await page.keyboard.type('testnote', { delay: 60 });
    const taVal = await textarea.evaluate((el) => el.value);
    if (!taVal.includes('testnote')) throw new Error('textarea 无法编辑: ' + taVal);
    // 真正的 contenteditable 例外：在卡内展示子树插入一个 contenteditable 元素，
    // 它必须保持 user-select:text / pointer-events:auto，且可以输入。
    const ceStyle = await page.evaluate((cardSel) => {
      const card = document.querySelector(cardSel);
      const body = card.querySelector('.reorder-card-body');
      const el = document.createElement('div');
      el.setAttribute('data-g1-ce', '1');
      el.setAttribute('contenteditable', 'true');
      el.textContent = 'ce-start';
      body.appendChild(el);
      const cs = getComputedStyle(el);
      return { userSelect: cs.userSelect, pointerEvents: cs.pointerEvents };
    }, SEL('exercise-card-g3b-ex-1'));
    if (ceStyle.userSelect !== 'text' || ceStyle.pointerEvents !== 'auto') throw new Error('contenteditable 样式错误: ' + JSON.stringify(ceStyle));
    await page.click('[data-g1-ce]');
    await page.keyboard.type('X');
    const ceVal = await page.$eval('[data-g1-ce]', (el) => el.textContent);
    if (!ceVal.includes('X')) throw new Error('contenteditable 无法编辑: ' + ceVal);
    await page.evaluate(() => document.querySelector('[data-g1-ce]')?.remove());
    return { inputStyle, selected, copyOk, pasteNotPrevented, typed: pasted, clipboard, taStyle, ceStyle };
  });

  // ── 5. 按钮/纵滚/展开门禁 ──────────────────────────────────────────────
  await runCase('buttons and vertical scroll work; expanded record gate still blocks drag', async (page) => {
    const client = await page.createCDPSession();
    // 按钮触摸
    const b2 = await cardBox(page, 'g3b-ex-2');
    const btn = await page.evaluateHandle((s) => [...document.querySelectorAll(s + ' button')].find((b) => b.textContent.trim() === '记录'), SEL('exercise-card-g3b-ex-2'));
    const btnEl = btn.asElement();
    if (!btnEl) throw new Error('找不到记录按钮');
    const bb = await btnEl.boundingBox();
    await tap(client, bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(200);
    const expanded = await page.$eval(SEL('exercise-card-g3b-ex-2') + ' button[aria-expanded]', (e) => e.getAttribute('aria-expanded'));
    if (expanded !== 'true') throw new Error('触摸按钮未展开记录');
    // 展开态长按不得拖动
    const b = await cardBox(page, 'g3b-ex-2');
    await touchStart(client, b.x + b.width * 0.42, b.y + 28);
    await sleep(520);
    const expandedDrag = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    await touchEnd(client);
    if (expandedDrag) throw new Error('记录展开态仍然进入拖动');
    // 收起后纵滚
    const toggle = await page.$(SEL('exercise-card-g3b-ex-2') + ' button[aria-expanded]');
    await toggle.click();
    await sleep(160);
    const beforeScroll = await page.evaluate(() => window.scrollY);
    const b3 = await cardBox(page, 'g3b-ex-3');
    await touchStart(client, b3.x + b3.width * 0.4, b3.y + 30);
    for (let i = 1; i <= 10; i += 1) {
      await touchMove(client, b3.x + b3.width * 0.4, b3.y + 30 - i * 22);
      await sleep(14);
    }
    await touchEnd(client);
    await sleep(260);
    const afterScroll = await page.evaluate(() => window.scrollY);
    if (afterScroll <= beforeScroll) throw new Error('触摸纵滚未滚动页面');
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('纵滚触发拖动');
    // 滑杆 pointer-events
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(180);
    const slider = await page.waitForSelector('[data-testid^="cardio-panel-"] input[type="range"]');
    const sliderPE = await slider.evaluate((el) => getComputedStyle(el).pointerEvents);
    if (sliderPE !== 'auto') throw new Error('滑杆 pointer-events 不是 auto: ' + sliderPE);
    // 真实滑杆拖动：不是只看 pointer-events，必须让 value 真正变化。
    const sliderMeta = await slider.evaluate((el) => ({ value: Number(el.value), min: Number(el.min), max: Number(el.max), disabled: el.disabled, rect: el.getBoundingClientRect().toJSON(), pe: getComputedStyle(el).pointerEvents }));
    await slider.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(160);
    const sliderBox = await slider.boundingBox();
    if (!sliderBox) throw new Error('滑杆没有 bounding box');
    const targetIsMax = sliderMeta.value <= (sliderMeta.min + sliderMeta.max) / 2;
    const targetX = sliderBox.x + sliderBox.width * (targetIsMax ? 0.85 : 0.15);
    const targetY = sliderBox.y + sliderBox.height / 2;
    await page.mouse.move(sliderBox.x + sliderBox.width * 0.5, targetY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 8 });
    await page.mouse.up();
    await sleep(240);
    const sliderAfter = await slider.evaluate((el) => Number(el.value));
    if (sliderAfter === sliderMeta.value) throw new Error(`滑杆真实拖动未改变 value: ${sliderMeta.value}`);
    return { expanded, expandedDrag, beforeScroll, afterScroll, sliderPE, sliderBefore: sliderMeta.value, sliderAfter };
  });

  // ── 5b. 只读门禁 + 有氧触摸拖动 ──────────────────────────────────────
  await runCase('readonly lock gate blocks drag after external lock row', async (page) => {
    // 真实浏览器页面：把一个未过期的“别的编辑器”锁行写进 meta，再 reload 当前页；
    // 页面必须进入 readonly 门禁并拒绝长按拖动。
    await page.evaluate(() => new Promise((resolve, reject) => {
      const req = indexedDB.open('motion-training');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put({ key: 'lock:g3b-session', sessionId: 'g3b-session', editorId: 'other-editor', at: Date.now() });
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
    await page.waitForSelector(SEL('exercise-card-g3b-ex-1'));
    await page.waitForFunction((s) => document.querySelector(s)?.getAttribute('data-gesture-lock') === 'readonly', { timeout: 8000 }, SEL('exercise-card-g3b-ex-2'));
    const lock = await page.$eval(SEL('exercise-card-g3b-ex-2'), (e) => e.getAttribute('data-gesture-lock'));
    const b = await cardBox(page, 'g3b-ex-2');
    const client = await page.createCDPSession();
    await touchStart(client, b.x + b.width * 0.42, b.y + 28);
    await sleep(420);
    const dragging = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    await touchEnd(client);
    if (dragging) throw new Error('readonly 页面仍然进入拖动');
    return { lock, dragging };
  });

  await runCase('CDP touch long-press drag reorders cardio only', async (page) => {
    const before = await order(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(220);
    const first = await page.waitForSelector(SEL('cardio-card-g3b-cardio-1'));
    await first.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(100);
    const b1 = await first.boundingBox();
    const b2 = await (await page.waitForSelector(SEL('cardio-card-g3b-cardio-2'))).boundingBox();
    if (!b1 || !b2) throw new Error('有氧卡片坐标缺失');
    const client = await page.createCDPSession();
    const x = b1.x + b1.width * 0.42;
    const y = b1.y + 28;
    await touchStart(client, x, y);
    await sleep(390);
    if (!(await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]'))))) throw new Error('有氧卡长按未进入拖动');
    const targetY = b2.y + b2.height * 0.7;
    for (let i = 1; i <= 10; i += 1) {
      await touchMove(client, x, y + ((targetY - y) * i) / 10);
      await sleep(16);
    }
    await touchEnd(client);
    await page.waitForFunction(() => window.__test.order().then((o) => o.cardio[0] === 'g3b-cardio-2'), { timeout: 6000 });
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('有氧拖动改动了力量顺序');
    if (after.revision !== before.revision + 1) throw new Error('有氧拖动应只落库一次');
    if ((await page.evaluate(() => window.getSelection()?.toString() ?? '')) !== '') throw new Error('有氧拖动出现选区');
    return { beforeCardio: before.cardio, afterCardio: after.cardio, revision: after.revision };
  });

  // ── 5c. G02：危险确认弹窗（btn-danger）浅/深主题 ────────────────────
  await runCase('danger confirm button uses red token in light and dark', async (page) => {
    const rows = [];
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      const opened = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '放弃训练');
        if (!b) return false;
        b.click();
        return true;
      });
      if (!opened) throw new Error('找不到放弃训练入口');
      await page.waitForSelector('[data-testid="confirm-ok"]');
      const m = await page.$eval('[data-testid="confirm-ok"]', (el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, rect: el.getBoundingClientRect().toJSON() };
      });
      const bg = parseRgb(m.bg);
      const fg = parseRgb(m.color);
      const expected = theme === 'dark' ? [211, 47, 47] : [179, 38, 30];
      if (!near(bg, expected, 1)) throw new Error(`${theme} 危险确认按钮不是红色: ${JSON.stringify(bg)}`);
      const ratio = contrast(bg, fg);
      if (ratio < 4.5) throw new Error(`${theme} 危险确认按钮对比度不足: ${ratio.toFixed(2)}`);
      const shot = join(OUT, 'screens', `danger-confirm-${theme}.png`);
      await page.screenshot({ path: shot });
      result.screenshots.push(shot);
      rows.push({ theme, bg: m.bg, color: m.color, contrast: Number(ratio.toFixed(2)), screenshot: shot });
      await page.click('[data-testid="confirm-cancel"]');
      await sleep(160);
    }
    return rows;
  });

  // ── 6. G02：删除按钮浅/深主题 computed + 像素 ────────────────────────
  await runCase('delete action is explicit red in light and dark with >=4.5 white contrast', async (page) => {
    const measurements = [];
    for (const theme of ['light', 'dark']) {
      await setTheme(page, theme);
      await ensureCollapsed(page, 'g3b-ex-3');
      await openActions(page, 'g3b-ex-3');
      const btn = await page.waitForSelector(SEL('exercise-card-g3b-ex-3-delete'));
      const m = await btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, rect: el.getBoundingClientRect().toJSON() };
      });
      const bg = parseRgb(m.bg);
      const fg = parseRgb(m.color);
      const ratio = contrast(bg, fg);
      if (ratio < 4.5) throw new Error(`${theme} 删除按钮白字对比度不足: ${ratio.toFixed(2)} ${m.bg}`);
      const expected = theme === 'dark' ? [211, 47, 47] : [179, 38, 30];
      if (!near(bg, expected, 1)) throw new Error(`${theme} 删除按钮不是预期红色: ${JSON.stringify(bg)} expected ${JSON.stringify(expected)}`);
      const sample = await samplePixel(page, m.rect.x + m.rect.width * 0.2, m.rect.y + m.rect.height * 0.2);
      const px = sample.pixel;
      if (!near(px, expected, 2)) throw new Error(`${theme} 删除按钮像素不是红色: ${JSON.stringify(px)} rect=${JSON.stringify(m.rect)} size=${sample.width}x${sample.height}`);
      const shot = join(OUT, 'screens', `delete-${theme}.png`);
      await page.screenshot({ path: shot });
      result.screenshots.push(shot);
      measurements.push({ theme, bg: m.bg, color: m.color, contrast: Number(ratio.toFixed(2)), pixel: px });
      // 收起操作层，避免影响下一主题
      await page.mouse.click(10, 120);
      await sleep(220);
    }
    return measurements;
  });

  // ── 7. G02：F09 就绪横幅浅/深主题 + F10 消散层同步 ───────────────────
  await runCase('F09 ready banner is explicit red in both themes; F10 dissolve uses same danger token', async (page) => {
    const measurements = [];
    for (const theme of ['light', 'dark']) {
      const cardId = theme === 'dark' ? 'g3b-ex-5' : 'g3b-ex-4';
      await setTheme(page, theme);
      await ensureCollapsed(page, cardId);
      const b = await cardBox(page, cardId);
      const y = b.y + 30;
      const x = b.x + b.width * 0.7;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 220, y, { steps: 14 });
      await sleep(880); // 超过 SWIPE_READY_HOLD_MS=750
      const banner = await page.waitForSelector(SEL(`exercise-card-${cardId}-ready-banner`), { timeout: 3000 });
      const m = await banner.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, color: cs.color, rect: el.getBoundingClientRect().toJSON() };
      });
      const bg = parseRgb(m.bg);
      const fg = parseRgb(m.color);
      const ratio = contrast(bg, fg);
      if (ratio < 4.5) throw new Error(`${theme} F09 横幅对比度不足: ${ratio.toFixed(2)} ${m.bg}`);
      const expected = theme === 'dark' ? [211, 47, 47] : [179, 38, 30];
      if (!near(bg, expected, 1)) throw new Error(`${theme} F09 横幅不是预期红色: ${JSON.stringify(bg)}`);
      const sample = await samplePixel(page, m.rect.x + 4, m.rect.y + 4);
      const px = sample.pixel;
      if (!near(px, expected, 2)) throw new Error(`${theme} F09 横幅像素不是红色: ${JSON.stringify(px)} rect=${JSON.stringify(m.rect)} size=${sample.width}x${sample.height}`);
      const shot = join(OUT, 'screens', `f09-banner-${theme}.png`);
      await page.screenshot({ path: shot });
      result.screenshots.push(shot);
      measurements.push({ theme, bg: m.bg, color: m.color, contrast: Number(ratio.toFixed(2)), pixel: px });
      // 松手触发 F09 删除；立即抓 F10 消散层颜色（若有）
      await page.mouse.up();
      let dissolve = null;
      try {
        const ghost = await page.waitForSelector('.dissolve-shell', { timeout: 800 });
        dissolve = await ghost.evaluate((el) => getComputedStyle(el).backgroundColor);
      } catch { /* F10 非本次 G02 的强制项；若未出现只记录 null */ }
      if (dissolve) {
        const d = parseRgb(dissolve);
        if (!near(d, expected, 1)) throw new Error(`${theme} F10 消散层颜色不一致: ${dissolve}`);
      }
      measurements.push({ theme, dissolve });
      await sleep(350);
    }
    return measurements;
  });

  // ── 8. G03 多触点（等待前）：同卡 / 异卡 / 真卡外空白 / 交互按钮，同视口采样且不复活 ──
  await runCase('CDP multitouch before long-press threshold (same/other/outside/button) cancels and never revives', async (page) => {
    const scenarios = [];
    const client = await page.createCDPSession();

    const readDomState = () => page.evaluate(() => ({
      dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
      placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
      selection: window.getSelection()?.toString() ?? '',
      rangeCount: window.getSelection()?.rangeCount ?? 0,
    }));

    const installProbe = () => page.evaluate(() => {
      if (!window.__g3EventHooked) {
        window.__g3EventHooked = true;
        window.addEventListener('touchstart', (e) => {
          window.__g3Events?.touchstart.push({ touches: e.touches.length, changed: e.changedTouches.length });
        }, true);
        window.addEventListener('touchend', (e) => {
          window.__g3Events?.touchend.push({ touches: e.touches.length, changed: e.changedTouches.length });
        }, true);
        window.addEventListener('touchcancel', () => {
          if (window.__g3Events) window.__g3Events.touchcancel += 1;
        }, true);
        window.addEventListener('pointerdown', (e) => {
          window.__g3Events?.pointerdown.push({ id: e.pointerId, isPrimary: e.isPrimary, type: e.pointerType });
        }, true);
        window.addEventListener('pointerup', (e) => {
          window.__g3Events?.pointerup.push({ id: e.pointerId, type: e.pointerType });
        }, true);
        window.addEventListener('pointercancel', () => {
          if (window.__g3Events) window.__g3Events.pointercancel += 1;
        }, true);
      }
      window.__g3Events = { touchstart: [], touchend: [], touchcancel: 0, pointerdown: [], pointerup: [], pointercancel: 0 };
    });

    const sampleViewportTargets = async () => page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inView = (x, y) => x >= 4 && x <= vw - 4 && y >= 4 && y <= vh - 4;
      const hitInfo = (x, y) => {
        const el = document.elementFromPoint(x, y);
        const card = el?.closest('[data-reorder-id]');
        const interactive = el?.closest('button, a, input, textarea, select, label, [role="button"], [tabindex], nav');
        return {
          x,
          y,
          inViewport: inView(x, y),
          tagName: el ? el.tagName : null,
          reorderId: card ? card.getAttribute('data-reorder-id') : null,
          interactiveTag: interactive ? interactive.tagName : null,
        };
      };

      const c2 = document.querySelector('[data-testid="exercise-card-g3b-ex-2"]');
      const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
      const c4 = document.querySelector('[data-testid="exercise-card-g3b-ex-4"]');
      const btn3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"] button[aria-expanded]');
      if (!c2 || !c3 || !c4 || !btn3) throw new Error('missing cards or expand button');
      const r2 = c2.getBoundingClientRect();
      const r3 = c3.getBoundingClientRect();
      const r4 = c4.getBoundingClientRect();
      const rb3 = btn3.getBoundingClientRect();

      // 寻找真正的卡外非交互空白/标题坐标
      const outsideCandidates = [];
      const h2 = [...document.querySelectorAll('h2, h1')].find((el) => !el.closest('[data-reorder-id]') && !el.closest('button, a, nav'));
      if (h2) {
        const hr = h2.getBoundingClientRect();
        outsideCandidates.push({ x: Math.round(hr.left + 12), y: Math.round(hr.top + hr.height / 2) });
      }
      outsideCandidates.push(
        { x: 6, y: Math.round(r2.top + 32) },
        { x: Math.round(vw - 6), y: Math.round(r2.top + 32) },
      );
      const outside = outsideCandidates
        .map((pt) => hitInfo(pt.x, pt.y))
        .find((info) => info.inViewport && info.tagName && info.reorderId === null && info.interactiveTag === null);
      if (!outside) throw new Error('未找到同视口内合法的卡外非交互坐标');

      const p1 = hitInfo(Math.round(r2.left + r2.width * 0.42), Math.round(r2.top + 28));
      const sameCardP2 = hitInfo(Math.round(r2.left + r2.width * 0.68), Math.round(r2.top + 42));
      const otherCardP2 = hitInfo(Math.round(r3.left + r3.width * 0.45), Math.round(r3.top + 28));
      const buttonP2 = hitInfo(Math.round(rb3.left + rb3.width / 2), Math.round(rb3.top + rb3.height / 2));
      const moveTargetY = Math.round(r4.top + r4.height * 0.75);

      return { vw, vh, p1, sameCardP2, otherCardP2, outside, buttonP2, moveTargetY };
    });

    for (const mode of ['same-card', 'other-card', 'outside-card', 'interactive-button']) {
      await ensureCollapsed(page, 'g3b-ex-1');
      await ensureCollapsed(page, 'g3b-ex-2');
      await ensureCollapsed(page, 'g3b-ex-3');
      // 仅在触摸前做一次共同视口滚动，确保 ex-2/ex-3/ex-4 与卡外区域同时可见
      await page.evaluate(() => {
        const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
        c3?.scrollIntoView({ block: 'center' });
      });
      await sleep(120);

      const sampled = await sampleViewportTargets();
      if (!sampled.p1.inViewport || sampled.p1.reorderId !== 'g3b-ex-2' || sampled.p1.interactiveTag !== null) {
        throw new Error(`${mode}: p1 采样无效: ${JSON.stringify(sampled.p1)}`);
      }
      const targetMap = {
        'same-card': sampled.sameCardP2,
        'other-card': sampled.otherCardP2,
        'outside-card': sampled.outside,
        'interactive-button': sampled.buttonP2,
      };
      const p2Info = targetMap[mode];
      if (!p2Info.inViewport) throw new Error(`${mode}: p2 不在当前视口内: ${JSON.stringify(p2Info)}`);
      if (mode === 'same-card' && (p2Info.reorderId !== 'g3b-ex-2' || p2Info.interactiveTag !== null)) {
        throw new Error(`same-card 命中异常: ${JSON.stringify(p2Info)}`);
      }
      if (mode === 'other-card' && (p2Info.reorderId !== 'g3b-ex-3' || p2Info.interactiveTag !== null)) {
        throw new Error(`other-card 命中异常: ${JSON.stringify(p2Info)}`);
      }
      if (mode === 'outside-card' && (p2Info.reorderId !== null || p2Info.interactiveTag !== null)) {
        throw new Error(`outside-card 命中异常: ${JSON.stringify(p2Info)}`);
      }
      if (mode === 'interactive-button' && p2Info.tagName !== 'BUTTON') {
        throw new Error(`interactive-button 未命中 BUTTON: ${JSON.stringify(p2Info)}`);
      }

      const before = await order(page);
      await installProbe();
      const p1 = { id: 1, x: sampled.p1.x, y: sampled.p1.y };
      const p2 = { id: 2, x: p2Info.x, y: p2Info.y };

      await touchPointsEvent(client, 'touchStart', [p1]);
      await sleep(120);
      await touchPointsEvent(client, 'touchStart', [p1, p2]);
      await sleep(320); // 越过 340ms 阈值
      const afterThreshold = await readDomState();
      if (afterThreshold.dragging || afterThreshold.placeholder) {
        throw new Error(`${mode}: 阈值前加第二指仍进入拖动: ${JSON.stringify(afterThreshold)}`);
      }

      // 逐个释放：先抬 p1，移动并停留 p2 超过 340ms，再全部离开
      await touchPointsEvent(client, 'touchEnd', [p2]);
      const p2MoveY = Math.min(sampled.vh - 20, Math.max(20, sampled.moveTargetY));
      for (let i = 1; i <= 6; i += 1) {
        await touchPointsEvent(client, 'touchMove', [{ ...p2, y: Math.round(p2.y + ((p2MoveY - p2.y) * i) / 6) }]);
        await sleep(24);
      }
      await sleep(380);
      const duringRemaining = await readDomState();
      if (duringRemaining.dragging || duringRemaining.placeholder) {
        throw new Error(`${mode}: 剩余手指移动/停留复活了拖动: ${JSON.stringify(duringRemaining)}`);
      }
      await touchPointsEvent(client, 'touchEnd', []);
      await sleep(180);

      const events = await page.evaluate(() => window.__g3Events);
      if (!events.touchstart.some((t) => t.touches >= 2) || events.pointerdown.length < 2) {
        throw new Error(`${mode}: 未观测到真实双触点 touchstart(touches>=2): ${JSON.stringify(events)}`);
      }
      const after = await order(page);
      if (after.revision !== before.revision || JSON.stringify(after.strength) !== JSON.stringify(before.strength)) {
        throw new Error(`${mode}: 多指取消后仍改变了排序或 revision: ${before.revision}->${after.revision}`);
      }
      if (after.setsJson !== before.setsJson) {
        throw new Error(`${mode}: setsJson 被意外修改`);
      }
      scenarios.push({ mode, p1: sampled.p1, p2: p2Info, events, afterThreshold, duringRemaining, revision: after.revision });
    }
    return scenarios;
  });

  // ── 9. G03 多触点（拖动中）：同卡(视觉区)/异卡/真卡外/输入区，同视口采样立即清理 ──
  await runCase('CDP multitouch during active drag (same-visual/other/outside/input) cleans up immediately without commit', async (page) => {
    await page.evaluate(() => {
      window.__g3Probe = { touchmovePassiveFalse: new Set(), rafActive: new Set() };
      const docAdd = document.addEventListener.bind(document);
      const docRemove = document.removeEventListener.bind(document);
      document.addEventListener = function (type, fn, opts) {
        if (type === 'touchmove' && opts && opts.passive === false) window.__g3Probe.touchmovePassiveFalse.add(fn);
        return docAdd(type, fn, opts);
      };
      document.removeEventListener = function (type, fn, opts) {
        if (type === 'touchmove') window.__g3Probe.touchmovePassiveFalse.delete(fn);
        return docRemove(type, fn, opts);
      };
      const raf = window.requestAnimationFrame.bind(window);
      const caf = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = function (cb) {
        const id = raf((t) => { window.__g3Probe.rafActive.delete(id); cb(t); });
        window.__g3Probe.rafActive.add(id);
        return id;
      };
      window.cancelAnimationFrame = function (id) {
        window.__g3Probe.rafActive.delete(id);
        return caf(id);
      };
      window.addEventListener('touchstart', (e) => {
        window.__g3DragEvents?.touchstart.push({ touches: e.touches.length, changed: e.changedTouches.length });
      }, true);
      window.addEventListener('pointerdown', (e) => {
        window.__g3DragEvents?.pointerdown.push({ id: e.pointerId, isPrimary: e.isPrimary, type: e.pointerType });
      }, true);
    });

    const scenarios = [];
    const client = await page.createCDPSession();
    const readState = () => page.evaluate(() => ({
      dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
      placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
      panGuards: window.__g3Probe.touchmovePassiveFalse.size,
      rafCount: window.__g3Probe.rafActive.size,
      selection: window.getSelection()?.toString() ?? '',
    }));

    await ensureExpanded(page, 'g3b-ex-1');
    await ensureCollapsed(page, 'g3b-ex-2');
    await ensureCollapsed(page, 'g3b-ex-3');

    for (const mode of ['same-card-visual', 'other-card', 'outside-card', 'interactive-input']) {
      // 触摸前做一次共同视口滚动，确保 ex-1 的 input、ex-2、ex-3 和卡外区域同时在可见视口内
      await page.evaluate(() => {
        const c2 = document.querySelector('[data-testid="exercise-card-g3b-ex-2"]');
        c2?.scrollIntoView({ block: 'center' });
      });
      await sleep(120);

      const sampled = await page.evaluate(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const inView = (x, y) => x >= 4 && x <= vw - 4 && y >= 4 && y <= vh - 4;
        const hitInfo = (x, y) => {
          const el = document.elementFromPoint(x, y);
          const card = el?.closest('[data-reorder-id]');
          const interactive = el?.closest('button, a, input, textarea, select, label, [role="button"], [tabindex], nav');
          return {
            x,
            y,
            inViewport: inView(x, y),
            tagName: el ? el.tagName : null,
            reorderId: card ? card.getAttribute('data-reorder-id') : null,
            interactiveTag: interactive ? interactive.tagName : null,
          };
        };

        const c2 = document.querySelector('[data-testid="exercise-card-g3b-ex-2"]');
        const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
        const input = document.querySelector('[data-testid="exercise-card-g3b-ex-1"] input[aria-label*="次数"]');
        if (!c2 || !c3 || !input) throw new Error('missing ex-2, ex-3, or ex-1 input');
        const r2 = c2.getBoundingClientRect();
        const r3 = c3.getBoundingClientRect();
        const ri = input.getBoundingClientRect();

        const p1 = hitInfo(Math.round(r2.left + r2.width * 0.42), Math.round(r2.top + 28));
        const otherCardP2 = hitInfo(Math.round(r3.left + r3.width * 0.48), Math.round(r3.top + 28));
        const inputP2 = hitInfo(Math.round(ri.left + ri.width / 2), Math.round(ri.top + ri.height / 2));
        const outsideCandidates = [
          { x: 6, y: Math.round(r2.top + 28) },
          { x: Math.round(vw - 6), y: Math.round(r2.top + 28) },
          { x: 6, y: Math.round(r3.top + 28) },
        ];
        const outside = outsideCandidates
          .map((pt) => hitInfo(pt.x, pt.y))
          .find((info) => info.inViewport && info.tagName && info.reorderId === null && info.interactiveTag === null);
        if (!outside) throw new Error('未找到同视口内卡外非交互空白点');

        return {
          vw,
          vh,
          p1,
          dragMidY: Math.round(r3.top + r3.height * 0.45),
          otherCardP2,
          outside,
          inputP2,
        };
      });

      if (!sampled.p1.inViewport || sampled.p1.reorderId !== 'g3b-ex-2' || sampled.p1.interactiveTag !== null) {
        throw new Error(`${mode}: p1 采样无效: ${JSON.stringify(sampled.p1)}`);
      }
      if (mode === 'other-card' && (!sampled.otherCardP2.inViewport || sampled.otherCardP2.reorderId !== 'g3b-ex-3')) {
        throw new Error(`other-card p2 采样无效: ${JSON.stringify(sampled.otherCardP2)}`);
      }
      if (mode === 'interactive-input' && (!sampled.inputP2.inViewport || sampled.inputP2.tagName !== 'INPUT')) {
        throw new Error(`interactive-input 未命中同视口 INPUT: ${JSON.stringify(sampled.inputP2)}`);
      }

      const before = await order(page);
      await page.evaluate(() => { window.__g3DragEvents = { touchstart: [], pointerdown: [] }; });

      const p1Start = { id: 1, x: sampled.p1.x, y: sampled.p1.y };
      await touchPointsEvent(client, 'touchStart', [p1Start]);
      await sleep(390);
      const lifted = await readState();
      if (!lifted.dragging || !lifted.placeholder || lifted.panGuards !== 1) {
        throw new Error(`${mode}: 初始单指未正常浮起拖动: ${JSON.stringify(lifted)}`);
      }

      const midY = Math.min(sampled.vh - 60, sampled.dragMidY);
      const p1Mid = { ...p1Start, y: midY };
      for (let i = 1; i <= 5; i += 1) {
        await touchPointsEvent(client, 'touchMove', [{ ...p1Start, y: Math.round(p1Start.y + ((midY - p1Start.y) * i) / 5) }]);
        await sleep(16);
      }

      let p2;
      let p2Meta;
      if (mode === 'same-card-visual') {
        // 浮起卡自身 pointer-events:none；此处按其当前视觉矩形采样并如实记录底层 DOM 命中
        const liftedInspect = await page.evaluate(() => {
          const el = document.querySelector('[data-drag-source="true"]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const x = Math.round(r.left + r.width * 0.72);
          const y = Math.round(r.top + Math.min(44, r.height * 0.4));
          const under = document.elementFromPoint(x, y);
          return {
            x,
            y,
            inViewport: x >= 4 && x <= window.innerWidth - 4 && y >= 4 && y <= window.innerHeight - 4,
            insideVisualLiftedRect: x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
            liftedRect: r.toJSON(),
            underlyingTag: under ? under.tagName : null,
            underlyingPlaceholder: under?.getAttribute('data-drag-placeholder') ?? under?.closest('[data-drag-placeholder]')?.getAttribute('data-drag-placeholder') ?? null,
          };
        });
        if (!liftedInspect || !liftedInspect.inViewport || !liftedInspect.insideVisualLiftedRect) {
          throw new Error(`same-card-visual 采样不在浮起卡视觉矩形内: ${JSON.stringify(liftedInspect)}`);
        }
        p2 = { id: 2, x: liftedInspect.x, y: liftedInspect.y };
        p2Meta = liftedInspect;
      } else if (mode === 'other-card') {
        await sleep(160); // 等待邻居卡让位过渡完成，再不滚动地即时采样当前卡3标题位置
        const liveOther = await page.evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
          const h3 = c3?.querySelector('h3');
          const r = (h3 || c3)?.getBoundingClientRect();
          if (!c3 || !r) return null;
          const x = Math.round(r.left + r.width * 0.5);
          const y = Math.round(h3 ? r.top + r.height * 0.5 : r.top + 28);
          const el = document.elementFromPoint(x, y);
          const card = el?.closest('[data-reorder-id]');
          const interactive = el?.closest('button, a, input, textarea, select, label, [role="button"], [tabindex], nav');
          return {
            x,
            y,
            inViewport: x >= 4 && x <= vw - 4 && y >= 4 && y <= vh - 4,
            tagName: el ? el.tagName : null,
            reorderId: card ? card.getAttribute('data-reorder-id') : null,
            interactiveTag: interactive ? interactive.tagName : null,
          };
        });
        if (!liveOther || !liveOther.inViewport || liveOther.reorderId !== 'g3b-ex-3' || liveOther.interactiveTag !== null) {
          throw new Error(`other-card 拖动后即时复核未命中 g3b-ex-3: ${JSON.stringify(liveOther)}`);
        }
        p2 = { id: 2, x: liveOther.x, y: liveOther.y };
        p2Meta = liveOther;
      } else if (mode === 'outside-card') {
        const liveOutside = await page.evaluate((pt) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const el = document.elementFromPoint(pt.x, pt.y);
          const card = el?.closest('[data-reorder-id]');
          const interactive = el?.closest('button, a, input, textarea, select, label, [role="button"], [tabindex], nav');
          return {
            x: pt.x,
            y: pt.y,
            inViewport: pt.x >= 4 && pt.x <= vw - 4 && pt.y >= 4 && pt.y <= vh - 4,
            tagName: el ? el.tagName : null,
            reorderId: card ? card.getAttribute('data-reorder-id') : null,
            interactiveTag: interactive ? interactive.tagName : null,
          };
        }, { x: sampled.outside.x, y: sampled.outside.y });
        if (!liveOutside.inViewport || !liveOutside.tagName || liveOutside.reorderId !== null || liveOutside.interactiveTag !== null) {
          throw new Error(`outside-card 加入前即时复核失败: ${JSON.stringify(liveOutside)}`);
        }
        p2 = { id: 2, x: liveOutside.x, y: liveOutside.y };
        p2Meta = liveOutside;
      } else {
        const liveInput = await page.evaluate((pt) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const el = document.elementFromPoint(pt.x, pt.y);
          return {
            x: pt.x,
            y: pt.y,
            inViewport: pt.x >= 4 && pt.x <= vw - 4 && pt.y >= 4 && pt.y <= vh - 4,
            tagName: el ? el.tagName : null,
          };
        }, { x: sampled.inputP2.x, y: sampled.inputP2.y });
        if (!liveInput.inViewport || liveInput.tagName !== 'INPUT') {
          throw new Error(`interactive-input 加入前即时复核未命中 INPUT: ${JSON.stringify(liveInput)}`);
        }
        p2 = { id: 2, x: liveInput.x, y: liveInput.y };
        p2Meta = liveInput;
      }

      await touchPointsEvent(client, 'touchStart', [p1Mid, p2]);
      await sleep(40);
      const rightAfterSecond = await readState();
      if (rightAfterSecond.dragging || rightAfterSecond.placeholder || rightAfterSecond.panGuards !== 0 || rightAfterSecond.rafCount !== 0) {
        throw new Error(`${mode}: 拖动中加入第二触点未立即清理: ${JSON.stringify(rightAfterSecond)}`);
      }

      for (let i = 1; i <= 4; i += 1) {
        await touchPointsEvent(client, 'touchMove', [
          { ...p1Mid, y: Math.min(sampled.vh - 10, Math.round(p1Mid.y + i * 20)) },
          { ...p2, y: Math.min(sampled.vh - 10, Math.round(p2.y + i * 10)) },
        ]);
        await sleep(16);
      }
      await touchPointsEvent(client, 'touchEnd', [p1Mid]);
      await touchPointsEvent(client, 'touchMove', [{ ...p1Mid, y: Math.min(sampled.vh - 10, p1Mid.y + 80) }]);
      await sleep(380);
      const beforeFinalUp = await readState();
      if (beforeFinalUp.dragging || beforeFinalUp.placeholder) {
        throw new Error(`${mode}: 剩余手指继续移动后复活拖动: ${JSON.stringify(beforeFinalUp)}`);
      }
      await touchPointsEvent(client, 'touchEnd', []);
      await sleep(180);

      const events = await page.evaluate(() => window.__g3DragEvents);
      if (!events.touchstart.some((t) => t.touches >= 2) || events.pointerdown.length < 2) {
        throw new Error(`${mode}: 未观测到真实双触点 touchstart(touches>=2): ${JSON.stringify(events)}`);
      }
      const after = await order(page);
      if (after.revision !== before.revision || JSON.stringify(after.strength) !== JSON.stringify(before.strength)) {
        throw new Error(`${mode}: 多指取消拖动后仍提交排序: ${before.revision}->${after.revision}`);
      }
      if (after.setsJson !== before.setsJson) {
        throw new Error(`${mode}: 多指取消拖动后 setsJson 被修改`);
      }
      scenarios.push({ mode, p1: sampled.p1, p2Meta, events, lifted, rightAfterSecond, beforeFinalUp, revision: after.revision });
    }
    return scenarios;
  });

  // ── 10. G03 多触点取消 F09 就绪横幅（真卡外安全空白）+ 全部释放后单指恢复并可重读 ──
  await runCase('CDP multitouch cancels F09 ready banner without delete, then new single-finger drag recovers and persists', async (page) => {
    const client = await page.createCDPSession();
    await ensureCollapsed(page, 'g3b-ex-1');
    await ensureCollapsed(page, 'g3b-ex-2');
    await ensureCollapsed(page, 'g3b-ex-3');
    const before = await order(page);

    await page.evaluate(() => {
      const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
      c3?.scrollIntoView({ block: 'center' });
      window.__g3F09Events = { touchstart: [], pointerdown: [] };
      window.addEventListener('touchstart', (e) => {
        window.__g3F09Events.touchstart.push({ touches: e.touches.length, changed: e.changedTouches.length });
      }, true);
      window.addEventListener('pointerdown', (e) => {
        window.__g3F09Events.pointerdown.push({ id: e.pointerId, isPrimary: e.isPrimary });
      }, true);
    });
    await sleep(120);

    const f09Sample = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const c3 = document.querySelector('[data-testid="exercise-card-g3b-ex-3"]');
      if (!c3) throw new Error('missing g3b-ex-3');
      const r3 = c3.getBoundingClientRect();
      const candidates = [
        { x: 6, y: Math.round(r3.top + 30) },
        { x: Math.round(vw - 6), y: Math.round(r3.top + 30) },
      ];
      const outside = candidates
        .map((pt) => {
          const el = document.elementFromPoint(pt.x, pt.y);
          const card = el?.closest('[data-reorder-id]');
          const interactive = el?.closest('button, a, input, textarea, select, label, [role="button"], [tabindex], nav');
          return {
            ...pt,
            inViewport: pt.x >= 2 && pt.x <= vw - 2 && pt.y >= 4 && pt.y <= vh - 4,
            tagName: el ? el.tagName : null,
            reorderId: card ? card.getAttribute('data-reorder-id') : null,
            interactiveTag: interactive ? interactive.tagName : null,
          };
        })
        .find((info) => info.inViewport && info.tagName && info.reorderId === null && info.interactiveTag === null);
      if (!outside) throw new Error('未找到安全的卡外非交互空白坐标');
      return {
        swipeX: Math.round(r3.left + r3.width * 0.78),
        swipeY: Math.round(r3.top + 30),
        outside,
      };
    });

    // 1. 左滑触发 F09 就绪横幅后，加入安全卡外第二触点立即取消就绪横幅且不删除
    const swipeStart = { id: 1, x: f09Sample.swipeX, y: f09Sample.swipeY };
    await touchPointsEvent(client, 'touchStart', [swipeStart]);
    for (let i = 1; i <= 10; i += 1) {
      await touchPointsEvent(client, 'touchMove', [{ ...swipeStart, x: Math.round(swipeStart.x - (180 * i) / 10) }]);
      await sleep(16);
    }
    const swipeHeld = { ...swipeStart, x: swipeStart.x - 180 };
    await sleep(820);
    const readyBefore = await page.$(SEL('exercise-card-g3b-ex-3-ready-banner'));
    if (!readyBefore) throw new Error('左滑停留后未进入 F09 就绪态');

    const outsidePt = { id: 2, x: f09Sample.outside.x, y: f09Sample.outside.y };
    await touchPointsEvent(client, 'touchStart', [swipeHeld, outsidePt]);
    await sleep(60);
    const readyAfterSecond = await page.$(SEL('exercise-card-g3b-ex-3-ready-banner'));
    if (readyAfterSecond) throw new Error('加入第二触点后 F09 就绪横幅未立即清理');

    await touchPointsEvent(client, 'touchEnd', [swipeHeld]);
    await sleep(60);
    await touchPointsEvent(client, 'touchEnd', []);
    await sleep(220);

    const f09Events = await page.evaluate(() => window.__g3F09Events);
    if (!f09Events.touchstart.some((t) => t.touches >= 2)) {
      throw new Error(`F09 取消未观测到 touches>=2: ${JSON.stringify(f09Events)}`);
    }
    const confirmModal = await page.$('[data-testid="confirm-ok"]');
    if (confirmModal) throw new Error('多指取消 F09 后误弹删除确认');
    const afterF09Cancel = await order(page);
    if (afterF09Cancel.strength.length !== before.strength.length || afterF09Cancel.revision !== before.revision) {
      throw new Error(`多指取消 F09 后不应删除或改 revision: ${before.revision}->${afterF09Cancel.revision}`);
    }

    // 2. 全部手指离开后，新的单指长按应正常浮起、跟手、触发自动滚动并落库一次（可重读）
    const b2 = await cardBox(page, 'g3b-ex-2');
    const scrollBefore = await page.evaluate(() => window.scrollY);
    const dragPt = { id: 3, x: Math.round(b2.x + b2.width * 0.42), y: Math.round(b2.y + 28) };
    await touchPointsEvent(client, 'touchStart', [dragPt]);
    await sleep(390);
    const recoveredDrag = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    if (!recoveredDrag) throw new Error('全部手指离开后新单指长按未恢复浮起拖动');

    // 拖至底部边缘感应带，验证跟手与自动滚动
    const edgeY = 872;
    for (let i = 1; i <= 10; i += 1) {
      await touchPointsEvent(client, 'touchMove', [{ ...dragPt, y: Math.round(dragPt.y + ((edgeY - dragPt.y) * i) / 10) }]);
      await sleep(18);
    }
    await sleep(220);
    const scrollAfterEdge = await page.evaluate(() => window.scrollY);
    if (scrollAfterEdge <= scrollBefore) {
      throw new Error(`恢复拖动移至底部边缘未触发自动滚动: ${scrollBefore} -> ${scrollAfterEdge}`);
    }
    await touchPointsEvent(client, 'touchEnd', []);
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength.indexOf('g3b-ex-2') > 1), { timeout: 6000 });
    await sleep(200);

    const afterRecovery = await order(page);
    if (afterRecovery.revision !== before.revision + 1) {
      throw new Error(`恢复单指拖动应只落库一次: ${before.revision}->${afterRecovery.revision}`);
    }

    // 重读验证：reload 页面确认顺序与 revision 真实持久化
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
    await page.waitForSelector(SEL('exercise-card-g3b-ex-1'));
    const reloaded = await order(page);
    if (reloaded.revision !== afterRecovery.revision || JSON.stringify(reloaded.strength) !== JSON.stringify(afterRecovery.strength)) {
      throw new Error('恢复拖动落库后 reload 重读不一致');
    }
    return {
      beforeRevision: before.revision,
      f09SampleOutside: f09Sample.outside,
      f09Events,
      afterF09CancelRevision: afterF09Cancel.revision,
      afterRecoveryRevision: afterRecovery.revision,
      scrollBefore,
      scrollAfterEdge,
      reloadedStrengthTop4: reloaded.strength.slice(0, 4),
    };
  });

  // ── 11. G04：>650ms 原地长按不移动不掉拖、浮起坐标不击穿到 auto 选区、收起态隐藏按钮文字 + 原生输入桥精准区分 ──
  await runCase('G04 stationary >650ms hold keeps drag alive without hit-test selection hole or hidden button exposure', async (page) => {
    const client = await page.createCDPSession();
    await ensureCollapsed(page, 'g3b-ex-2');
    await ensureCollapsed(page, 'g3b-ex-3');

    await page.evaluate(() => {
      window.__nativeGuardCalls = [];
      window.__motionSelectionGuard = {
        setTouchEditable: (v) => window.__nativeGuardCalls.push({ fn: 'touch', editable: Boolean(v) }),
        clearTouch: () => window.__nativeGuardCalls.push({ fn: 'clearTouch' }),
        setFocusEditable: (v) => window.__nativeGuardCalls.push({ fn: 'focus', editable: Boolean(v) }),
      };
    });

    // 1) 收起静止态：操作层 visibility 必须为 hidden，防止系统识屏/拖拽残影抓出「编辑 删除」文字
    const closedVis = await page.$eval(SEL('exercise-card-g3b-ex-2-actions'), (el) => getComputedStyle(el).visibility);
    if (closedVis !== 'hidden') {
      throw new Error(`收起静止态操作层应为 visibility:hidden，实测=${closedVis}`);
    }

    // 2) 外层容器与分区容器 user-select 必须为 none，且非编辑区 dragstart/selectstart/contextmenu 被拦截
    const outerCheck = await page.evaluate(() => {
      const zone = document.querySelector('[data-reorder-zone="strength"]');
      const wrapper = document.querySelector('[data-testid="exercise-card-g3b-ex-2"]')?.parentElement;
      const dispatch = (el, type) => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      };
      return {
        bodySelect: getComputedStyle(document.body).userSelect,
        zoneSelect: zone ? getComputedStyle(zone).userSelect : null,
        wrapperSelect: wrapper ? getComputedStyle(wrapper).userSelect : null,
        zoneDragPrevented: zone ? dispatch(zone, 'dragstart') : false,
        zoneSelectPrevented: zone ? dispatch(zone, 'selectstart') : false,
        zoneContextPrevented: zone ? dispatch(zone, 'contextmenu') : false,
      };
    });
    if (
      outerCheck.bodySelect !== 'none' ||
      outerCheck.zoneSelect !== 'none' ||
      outerCheck.wrapperSelect !== 'none' ||
      !outerCheck.zoneDragPrevented ||
      !outerCheck.zoneSelectPrevented ||
      !outerCheck.zoneContextPrevented
    ) {
      throw new Error(`外层非输入容器未完整禁选或未拦截原生拖拽/菜单: ${JSON.stringify(outerCheck)}`);
    }

    // 3) 原地长按 700ms（超过 Android 原生 500ms 长按阈值）不移动手指：拖动保持存活、无击穿 auto 容器、无空 Range
    const before = await order(page);
    const b2 = await cardBox(page, 'g3b-ex-2');
    const b4 = await (await page.waitForSelector(SEL('exercise-card-g3b-ex-4'))).boundingBox();
    if (!b4) throw new Error('missing ex-4 box');
    const x = Math.round(b2.x + b2.width * 0.42);
    const y = Math.round(b2.y + 28);
    await touchStart(client, x, y);
    await sleep(700);

    const held700 = await page.evaluate((px, py) => {
      const under = document.elementFromPoint(px, py);
      const sel = window.getSelection();
      return {
        dragging: Boolean(document.querySelector('[data-drag-source="true"]')),
        placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
        underTag: under ? under.tagName : null,
        underUserSelect: under ? getComputedStyle(under).userSelect : null,
        rangeCount: sel ? sel.rangeCount : -1,
        guardCalls: [...window.__nativeGuardCalls],
      };
    }, x, y);
    if (!held700.dragging || !held700.placeholder) {
      throw new Error(`原地按住 700ms 后卡片未保持浮起状态: ${JSON.stringify(held700)}`);
    }
    if (held700.underUserSelect !== 'none' || held700.rangeCount !== 0) {
      throw new Error(`浮起后坐标命中仍存在选区漏洞: ${JSON.stringify(held700)}`);
    }
    if (!held700.guardCalls.some((c) => c.fn === 'touch' && c.editable === false)) {
      throw new Error(`卡片触摸未向原生桥同步 editable=false: ${JSON.stringify(held700.guardCalls)}`);
    }

    // 继续拖动到 ex-4 下半区并松手，验证 >700ms 停顿后依然正常跟手提交一次
    const targetY = Math.round(b4.y + b4.height * 0.75);
    for (let i = 1; i <= 12; i += 1) {
      await touchMove(client, x, Math.round(y + ((targetY - y) * i) / 12));
      await sleep(16);
    }
    await touchEnd(client);
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength.indexOf('g3b-ex-2') !== 1), { timeout: 6000 });
    await sleep(160);
    const afterDrag = await order(page);
    if (afterDrag.revision !== before.revision + 1) {
      throw new Error(`700ms 长按后排序应只提交一次: ${before.revision}->${afterDrag.revision}`);
    }

    // 4) 输入框触摸与聚焦：向原生桥同步 editable=true，且左滑中间态操作层立即 visible
    await ensureExpanded(page, 'g3b-ex-1');
    const input = await page.waitForSelector(SEL('exercise-card-g3b-ex-1') + ' input[aria-label*="次数"]');
    await input.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(80);
    const ib = await input.boundingBox();
    await tap(client, Math.round(ib.x + ib.width / 2), Math.round(ib.y + ib.height / 2));
    await sleep(100);
    const inputBridge = await page.evaluate(() => [...window.__nativeGuardCalls]);
    if (!inputBridge.some((c) => c.fn === 'touch' && c.editable === true) || !inputBridge.some((c) => c.fn === 'focus' && c.editable === true)) {
      throw new Error(`输入框触摸/聚焦未向原生桥同步 editable=true: ${JSON.stringify(inputBridge)}`);
    }

    return { closedVis, outerCheck, held700, afterRevision: afterDrag.revision };
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG1/G2 SELECTION+RED: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
