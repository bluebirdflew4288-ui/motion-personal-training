#!/usr/bin/env node
/* G4-FIX1：拖动被内部取消（visibility/blur/pointercancel/卸载）后必须**立即**释放
   文档级非被动 touchmove 监听、window 监听、RAF 与占位，不等下一次 pointerup。 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G4_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g4/app-cancel';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面注入监听器/RAF 计数（只统计，不改变行为） */
const INSTRUMENT = () => {
  window.__probe = { touchmovePassiveFalse: new Set(), rafActive: new Set(), windowPointer: 0 };
  const docAdd = document.addEventListener.bind(document);
  const docRemove = document.removeEventListener.bind(document);
  document.addEventListener = function (type, fn, opts) {
    if (type === 'touchmove' && opts && opts.passive === false) window.__probe.touchmovePassiveFalse.add(fn);
    return docAdd(type, fn, opts);
  };
  document.removeEventListener = function (type, fn, opts) {
    if (type === 'touchmove') window.__probe.touchmovePassiveFalse.delete(fn);
    return docRemove(type, fn, opts);
  };
  const winAdd = window.addEventListener.bind(window);
  const winRemove = window.removeEventListener.bind(window);
  window.addEventListener = function (type, fn, opts) {
    if (type === 'pointermove' || type === 'pointerup') window.__probe.windowPointer += 1;
    return winAdd(type, fn, opts);
  };
  window.removeEventListener = function (type, fn, opts) {
    if (type === 'pointermove' || type === 'pointerup') window.__probe.windowPointer -= 1;
    return winRemove(type, fn, opts);
  };
  const raf = window.requestAnimationFrame.bind(window);
  const caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    const id = raf((t) => { window.__probe.rafActive.delete(id); cb(t); });
    window.__probe.rafActive.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { window.__probe.rafActive.delete(id); return caf(id); };
};

async function main() {
  await mkdir(OUT, { recursive: true }); await mkdir(join(OUT, 'screens'), { recursive: true });
  const css = (await Promise.all(['tokens','base','zine'].map((n) => readFile(join(APP_DIR,'src/styles',`${n}.css`),'utf8')))).join('\n');
  const built = await esbuild.build({ stdin:{contents:g3bEntry,resolveDir:APP_DIR,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',__AUDIT_STRICT__:'false',__MOTION_NATIVE__:'false',__MOTION_BUILD_TARGET__:'"web"'},nodePaths:[join(APP_DIR,'node_modules')],logLevel:'silent' });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if (req.url.startsWith('/app.js')) { res.setHeader('Content-Type','application/javascript'); res.end(js); }
    else if (req.url.startsWith('/style.css')) { res.setHeader('Content-Type','text/css'); res.end(css); }
    else res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT,'chrome-profile'), args: ['--no-first-run','--disable-extensions'] });
  const result = { suite: 'g4-cancel-cleanup', cases: [], screenshots: [], errors: [] };
  let idx = 0;
  const sel = (id) => `[data-testid="${id}"]`;

  async function runCase(name, mode, fn) {
    idx += 1;
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const entry = { name, inputMode: mode, ok: true, errors, screenshot: join(OUT,'screens',`case-${String(idx).padStart(2,'0')}.png`) };
    try {
      await page.evaluateOnNewDocument(INSTRUMENT);
      await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      await page.waitForSelector(sel('exercise-card-g3b-ex-1'));
      await page.evaluate(() => document.fonts.ready);
      await fn(page);
      if (entry.errors.length) throw new Error('pageerror: ' + entry.errors.join(' | '));
      result.cases.push(entry);
      console.log('  ✔ ' + name);
    } catch (e) {
      entry.ok = false; entry.detail = e instanceof Error ? e.message : String(e);
      result.cases.push(entry);
      console.log('  ✘ ' + name + ' :: ' + entry.detail);
    } finally {
      try { await page.screenshot({ path: entry.screenshot }); result.screenshots.push(entry.screenshot); } catch { /* ignore */ }
      for (const e of entry.errors) result.errors.push(`${name}: ${e}`);
      await ctx.close();
    }
  }

  /**
   * F06/F12（2026-11-03 新需求）：记录展开的动作卡禁止长按拖动。
   * 本套件全部用例都以第 1 张卡为目标，而它进入训练页时默认是展开态，
   * 因此开始拖动前必须收起（清理/守卫断言本身保持不变）。
   */
  const startDrag = async (page, id = 'g3b-ex-1') => {
    const el = await page.waitForSelector(sel(`exercise-card-${id}`));
    await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (btn && btn.getAttribute('aria-expanded') === 'true') btn.click();
    }, sel(`exercise-card-${id}`) + ' button[aria-expanded]');
    await sleep(160);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(60);
    const b = await el.boundingBox();
    const x = b.x + b.width * 0.5;
    const y = b.y + 24;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(520);
    const vh = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(x, vh - 8, { steps: 6 });
    await sleep(150);
    return { x, y };
  };
  const probe = (page) => page.evaluate(() => ({
    touchmove: window.__probe.touchmovePassiveFalse.size,
    windowPointer: window.__probe.windowPointer,
    raf: window.__probe.rafActive.size,
    dragSource: Boolean(document.querySelector('[data-drag-source="true"]')),
    placeholder: Boolean(document.querySelector('[data-drag-placeholder]')),
  }));

  await runCase('visibility hidden releases pan guard and RAF immediately', 'real-mouse', async (page) => {
    const before = await probe(page);
    if (before.touchmove !== 0) throw new Error('基线 touchmove 监听非 0: ' + JSON.stringify(before));
    await startDrag(page);
    const during = await probe(page);
    if (during.touchmove !== 1) throw new Error('拖动中应有 1 个非被动 touchmove 监听: ' + JSON.stringify(during));
    if (!during.dragSource) throw new Error('拖动未激活');
    // 切后台（真实 visibilitychange，不需要 pointerup）
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(200);
    const after = await probe(page);
    if (after.touchmove !== 0) throw new Error('切后台后 touchmove pan guard 残留: ' + JSON.stringify(after));
    if (after.windowPointer !== 0) throw new Error('切后台后 window 指针监听残留: ' + JSON.stringify(after));
    if (after.raf !== 0) throw new Error('切后台后 RAF 残留: ' + JSON.stringify(after));
    if (after.dragSource) throw new Error('切后台后仍处于拖动态');
    if (after.placeholder) throw new Error('切后台后占位未清理');
  });

  await runCase('blur releases pan guard and window listeners immediately', 'real-mouse', async (page) => {
    await startDrag(page);
    const during = await probe(page);
    if (during.touchmove !== 1) throw new Error('拖动中 pan guard 未挂载: ' + JSON.stringify(during));
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(200);
    const after = await probe(page);
    if (after.touchmove !== 0 || after.windowPointer !== 0 || after.raf !== 0) throw new Error('blur 后资源残留: ' + JSON.stringify(after));
    if (after.placeholder) throw new Error('blur 后占位未清理');
  });

  await runCase('pointercancel releases pan guard immediately', 'real-mouse', async (page) => {
    await startDrag(page);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
    await sleep(200);
    const after = await probe(page);
    if (after.touchmove !== 0 || after.windowPointer !== 0 || after.raf !== 0) throw new Error('pointercancel 后资源残留: ' + JSON.stringify(after));
  });

  await runCase('unmount while dragging releases everything', 'real-mouse', async (page) => {
    await startDrag(page);
    const during = await probe(page);
    if (during.touchmove !== 1) throw new Error('拖动中 pan guard 未挂载');
    // 卸载整棵页面（真实 unmount）
    await page.evaluate(() => { document.getElementById('root').remove(); });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(250);
    const after = await page.evaluate(() => ({
      touchmove: window.__probe.touchmovePassiveFalse.size,
      windowPointer: window.__probe.windowPointer,
      raf: window.__probe.rafActive.size,
    }));
    if (after.touchmove !== 0) throw new Error('卸载后 pan guard 残留: ' + JSON.stringify(after));
    if (after.windowPointer !== 0) throw new Error('卸载后 window 监听残留: ' + JSON.stringify(after));
    if (after.raf !== 0) throw new Error('卸载后 RAF 残留: ' + JSON.stringify(after));
  });

  await runCase('normal drop also releases pan guard and listeners', 'real-mouse', async (page) => {
    await startDrag(page);
    await page.mouse.up();
    await sleep(250);
    const after = await probe(page);
    if (after.touchmove !== 0 || after.windowPointer !== 0 || after.raf !== 0) throw new Error('松手后资源残留: ' + JSON.stringify(after));
    if (after.placeholder) throw new Error('松手后占位未清理');
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG4 CANCEL CLEANUP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
