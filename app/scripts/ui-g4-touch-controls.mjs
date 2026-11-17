#!/usr/bin/env node
/* G4：真实 CDP 触摸下的滑杆/按钮/纵滚/斜滑/输入焦点，与 mouse 分开记录。 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G4_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g4/app-touch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true }); await mkdir(join(OUT, 'screens'), { recursive: true });
  const css = (await Promise.all(['tokens','base','zine'].map((n) => readFile(join(APP_DIR,'src/styles',`${n}.css`),'utf8')))).join('\n');
  const built = await esbuild.build({ stdin:{contents:g3bEntry,resolveDir:APP_DIR,loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"',__AUDIT_STRICT__:'false',__MOTION_NATIVE__:'false',__MOTION_BUILD_TARGET__:'"web"'},nodePaths:[join(APP_DIR,'node_modules')],logLevel:'silent' });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    if (req.url.startsWith('/app.js')) { res.setHeader('Content-Type','application/javascript'); res.end(js); }
    else if (req.url.startsWith('/style.css')) { res.setHeader('Content-Type','text/css'); res.end(css); }
    else if (req.url.startsWith('/fonts/')) { try { const buf = await readFile(join(APP_DIR,'public',req.url.split('?')[0])); res.setHeader('Content-Type','font/woff2'); res.end(buf); } catch { res.statusCode = 404; res.end(); } }
    else res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT,'chrome-profile'), args: ['--no-first-run','--disable-extensions'] });
  const result = { suite: 'g4-touch-controls', cases: [], screenshots: [], errors: [] };
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
      await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      if (await page.evaluate(() => window.__bootError)) throw new Error(await page.evaluate(() => window.__bootError));
      await page.waitForSelector(sel('exercise-card-g3b-ex-1'));
      await page.evaluate(() => document.fonts.ready);
      await fn(page, await page.createCDPSession());
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

  const touchSwipe = async (client, x, y, dy, steps = 12) => {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    for (let i = 1; i <= steps; i += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps, radiusX: 2, radiusY: 2, force: 1 }] });
      await sleep(12);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const touchTap = async (client, x, y) => {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    await sleep(40);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const centerOf = async (page, selector) => {
    const el = await page.waitForSelector(selector, { visible: true, timeout: 6000 });
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(60);
    const b = await el.boundingBox();
    if (!b) throw new Error('no box ' + selector);
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b };
  };

  // 1. 触摸纵滚：页面滚动、不触发拖动/左滑
  await runCase('touch vertical pan scrolls page without starting drag', 'cdp-touch', async (page, client) => {
    const before = await page.evaluate(() => window.__test.order());
    const { x, y } = await centerOf(page, sel('exercise-card-g3b-ex-3'));
    await touchSwipe(client, x, y, -420);
    await sleep(250);
    const scrollY = await page.evaluate(() => window.scrollY);
    if (scrollY <= 0) throw new Error('触摸纵滚未滚动页面: ' + scrollY);
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('纵滚触发了拖动');
    const after = await page.evaluate(() => window.__test.order());
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('纵滚改变了顺序');
  });

  // 2. 触摸斜滑：不拖动、不展开操作层
  await runCase('touch diagonal pan does not drag or open actions', 'cdp-touch', async (page, client) => {
    const before = await page.evaluate(() => window.__test.order());
    const { x, y } = await centerOf(page, sel('exercise-card-g3b-ex-2'));
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    for (let i = 1; i <= 10; i += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 4, y: y - i * 9, radiusX: 2, radiusY: 2, force: 1 }] });
      await sleep(12);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('斜滑触发了拖动');
    /**
     * F01（2026-11-03 新需求）：操作层不再用 visibility 开关，而是**始终绘制**、
     * 露出量由内容层真实位移决定（拖动中间态就能看到按钮，不允许"先空白后弹按钮"）。
     * 因此"是否展开"不能再按 visibility 判定，必须看真实位移/交互态：
     * 位移 >1px、aria-hidden 暴露、或操作层接受点击，任一成立才算展开。
     */
    const openCount = await page.evaluate(() => [...document.querySelectorAll('[data-testid$="-edit"]')]
      .filter((e) => {
        const card = e.closest('.reorder-card');
        const content = card && card.lastElementChild;
        const actions = e.parentElement;
        const offset = content ? new DOMMatrix(getComputedStyle(content).transform).m41 : 0;
        return Math.abs(offset) > 1
          || actions.getAttribute('aria-hidden') !== 'true'
          || getComputedStyle(actions).pointerEvents === 'auto';
      }).length);
    if (openCount > 0) throw new Error('斜滑展开了操作层');
    const after = await page.evaluate(() => window.__test.order());
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('斜滑改变了顺序');
  });

  // 3. 触摸按钮：完成按钮生效且不触发拖动
  await runCase('touch tap on done button works without starting drag', 'cdp-touch', async (page, client) => {
    const card = sel('exercise-card-g3b-ex-1');
    const expand = await page.$(card + ' button[aria-expanded]');
    if ((await expand.evaluate((e) => e.getAttribute('aria-expanded'))) === 'false') await expand.click();
    await sleep(150);
    const btn = await page.waitForSelector(card + ' button');
    // 找到"完成"按钮
    const done = await page.evaluateHandle((c) => [...document.querySelectorAll(c + ' button')].find((b) => b.textContent.trim() === '完成'), card);
    const el = done.asElement();
    if (!el) throw new Error('完成按钮不存在');
    const b = await el.boundingBox();
    await touchTap(client, b.x + b.width / 2, b.y + b.height / 2);
    await sleep(400);
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('点按钮触发了拖动');
    const db = await page.evaluate(() => window.__test.order());
    if (db.revision < 1) throw new Error('点完成没有落库');
  });

  // 4. 触摸滑杆：拖滑杆改变参数且不触发卡片拖动
  await runCase('touch drag on cardio slider changes params without card drag', 'cdp-touch', async (page, client) => {
    const sliderSel = sel('cardio-panel-g3b-cardio-1') + ' input[type="range"]';
    const el = await page.waitForSelector(sliderSel);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    await sleep(80);
    const b = await el.boundingBox();
    const before = await page.evaluate(() => window.__test.order());
    const x = b.x + b.width * 0.3;
    const y = b.y + b.height / 2;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    for (let i = 1; i <= 8; i += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (b.width * 0.5 * i) / 8, y, radiusX: 2, radiusY: 2, force: 1 }] });
      await sleep(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(350);
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('滑杆手势触发了卡片拖动');
    const after = await page.evaluate(() => window.__test.order());
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('滑杆手势改变了卡片顺序');
    const changed = await page.evaluate(() => window.__test.order().then((o) => o.revision >= 1));
    if (!changed) throw new Error('滑杆未提交');
  });

  // 5. 触摸聚焦输入框后键入：不触发拖动
  await runCase('touch focus input then type does not start drag', 'cdp-touch+keyboard', async (page, client) => {
    const card = sel('exercise-card-g3b-ex-2');
    const expand = await page.$(card + ' button[aria-expanded]');
    if ((await expand.evaluate((e) => e.getAttribute('aria-expanded'))) === 'false') await expand.click();
    await sleep(150);
    const input = await page.waitForSelector(card + ' input[aria-label*="次数"]');
    const b = await input.boundingBox();
    await touchTap(client, b.x + b.width / 2, b.y + b.height / 2);
    await sleep(200);
    await page.keyboard.type('9');
    await sleep(200);
    if (await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')))) throw new Error('输入触发了拖动');
    const val = await input.evaluate((e) => e.value);
    if (!val.includes('9')) throw new Error('触摸聚焦后键入失败: ' + val);
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG4 TOUCH CONTROLS: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
