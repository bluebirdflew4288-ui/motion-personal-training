#!/usr/bin/env node
/* G3B 真实 Chrome 手势验证：鼠标序列与 CDP touch 序列**分开记录**。
   · 不用 dispatchEvent(PointerEvent) 冒充触摸；
   · 每个用例独立 browser context + 隔离 IDB；
   · 断言落库顺序/次数、scrollTop、计时与 actual 保真。 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G3B_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g3b/app';
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
  const result = { suite: 'g3b-gestures', cases: [], screenshots: [], errors: [] };
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
      await fn(page);
      result.cases.push(entry);
      console.log('  ✔ ' + name);
    } catch (e) {
      entry.ok = false;
      entry.detail = e instanceof Error ? e.message : String(e);
      result.cases.push(entry);
      console.log('  ✘ ' + name + ' :: ' + entry.detail);
    } finally {
      try { await page.screenshot({ path: entry.screenshot }); result.screenshots.push(entry.screenshot); } catch { /* ignore */ }
      await ctx.close();
    }
  }

  const cardBox = async (page, id, prefix = 'exercise-card-') => {
    const el = await page.waitForSelector(sel(`${prefix}${id}`));
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    const b = await el.boundingBox();
    if (!b) throw new Error('no box ' + id);
    return b;
  };
  /** 一次性测量多张卡（避免逐张 scrollIntoView 使先前坐标失效） */
  const cardBoxes = async (page, ids, prefix = 'exercise-card-') => {
    await page.evaluate((firstSel) => {
      document.querySelector(firstSel)?.scrollIntoView({ block: 'center' });
    }, sel(prefix + ids[0]));
    await sleep(60);
    const out = {};
    for (const id of ids) {
      const el = await page.$(sel(prefix + id));
      const b = await el.boundingBox();
      if (!b) throw new Error('no box ' + id);
      out[id] = b;
    }
    return out;
  };
  const order = (page) => page.evaluate(() => window.__test.order());
  const settle = async (page) => { await sleep(120); await page.waitForFunction(() => true); };
  /**
   * F06/F12（2026-11-03 新需求）：记录**展开**的动作卡不再允许左滑、也不再允许长按拖动排序。
   * 训练页进入时默认展开第 1 个动作，因此需要先收起它，才能验证"收起后仍然可拖"。
   * 这不是放宽断言：同一次运行的第 4/5 个用例仍在验证收起态手势与取消路径。
   */
  const ensureCollapsed = async (page, id) => {
    const button = sel(`exercise-card-${id}`) + ' button[aria-expanded]';
    const expanded = await page.$eval(button, (e) => e.getAttribute('aria-expanded') === 'true');
    if (expanded) { await page.click(button); await sleep(140); }
  };

  // 1. 鼠标长按拖动：第 1 张拖到第 3 张之后
  await runCase('mouse long-press drag moves card 1 below card 3', 'real-mouse', async (page) => {
    // F12：第 1 张卡默认是展开态（记录已展开），必须先收起才能长按排序
    await ensureCollapsed(page, 'g3b-ex-1');
    const before = await order(page);
    const boxes = await cardBoxes(page, ['g3b-ex-1', 'g3b-ex-3']);
    const b1 = boxes['g3b-ex-1'];
    const b3 = boxes['g3b-ex-3'];
    await page.mouse.move(b1.x + b1.width * 0.5, b1.y + 24);
    await page.mouse.down();
    await sleep(520); // 超过 LONG_PRESS_MS，进入拖动
    await page.mouse.move(b1.x + b1.width * 0.5, b3.y + b3.height - 4, { steps: 12 });
    await sleep(80);
    await page.mouse.up();
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength[0] !== 'g3b-ex-1'), { timeout: 5000 });
    const after = await order(page);
    // 落点在 card3 之后（±1 由指针精度/卡高决定）；关键是"不再排第一且只在卡 2/3 之后"
    const pos = after.strength.indexOf('g3b-ex-1');
    if (pos < 2 || pos > 3) throw new Error('落点错误: ' + JSON.stringify(after.strength));
    if (after.strength.length !== before.strength.length) throw new Error('条目数量变化');
    // 顺序变化后数组顺序也变，必须按 ID 逐条比较 actual
    // 键顺序会随排序变化，按 ID 排序后比较内容
    const sig = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (sig(after.setsById) !== sig(before.setsById)) {
      const diff = Object.keys(before.setsById).filter((k) => before.setsById[k] !== after.setsById[k]).map((k) => `${k}: ${before.setsById[k]} -> ${after.setsById[k]}`);
      throw new Error('sets 实际内容被重建 :: ' + diff.slice(0, 2).join(' || '));
    }
    if (after.revision !== before.revision + 1) throw new Error('应只落库一次: ' + before.revision + ' -> ' + after.revision);
  });

  // 2. 正常纵向滚动不触发拖动/左滑
  await runCase('vertical wheel scroll does not start drag or swipe', 'real-mouse', async (page) => {
    const before = await order(page);
    await page.mouse.move(200, 500);
    await page.mouse.wheel({ deltaY: 600 });
    await sleep(300);
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('滚动改变了顺序');
    const opened = await page.$$eval('[data-reorder-id] [aria-hidden="false"]', (a) => a.length);
    if (opened) throw new Error('滚动后出现左滑操作层');
    const scrolled = await page.evaluate(() => window.scrollY);
    if (scrolled <= 0) throw new Error('页面未滚动，无法证明纵滚');
  });

  // 3. 左滑仍可用；收起时按钮不可点/不可聚焦
  await runCase('horizontal swipe opens actions; hidden buttons are not clickable', 'real-mouse', async (page) => {
    const b = await cardBox(page, 'g3b-ex-2');
    // 收起时：不可 Tab 聚焦、且被内容层覆盖（不可点击穿透）
    const closedState = await page.$eval(sel('exercise-card-g3b-ex-2-edit'), (e) => {
      const r = e.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { tabIndex: e.tabIndex, ariaHidden: e.parentElement?.getAttribute('aria-hidden'), covered: at !== e && !e.contains(at) };
    });
    if (closedState.tabIndex !== -1) throw new Error('收起时操作按钮仍可 Tab 聚焦');
    if (closedState.ariaHidden !== 'true') throw new Error('收起时操作层未标记 aria-hidden');
    if (!closedState.covered) throw new Error('收起时操作按钮可被点击穿透');
    await page.mouse.move(b.x + b.width * 0.7, b.y + 20);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.7 - 150, b.y + 20, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction((s) => {
      const e = document.querySelector(s);
      return e && e.getAttribute('aria-hidden') !== 'true' && e.parentElement?.getAttribute('aria-hidden') === 'false';
    }, { timeout: 4000 }, sel('exercise-card-g3b-ex-2-edit'));
    const visible = await page.$eval(sel('exercise-card-g3b-ex-2-edit'), (e) => {
      const r = e.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return Boolean(at && (e === at || e.contains(at)));
    });
    if (!visible) throw new Error('左滑后编辑按钮不可见');
  });

  // 4. 输入框不抢手势：聚焦并键入不触发拖动
  await runCase('typing in reps input does not start drag', 'real-keyboard', async (page) => {
    const before = await order(page);
    await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    }, sel('exercise-card-g3b-ex-1') + ' button[aria-expanded]');
    const input = await page.waitForSelector(sel('exercise-card-g3b-ex-1') + ' input[aria-label*="次数"]');
    await input.click();
    await page.keyboard.type('12');
    await page.keyboard.press('Tab');
    await sleep(250);
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('输入触发了排序');
    if (!after.setsJson.includes('12')) throw new Error('输入未落库: ' + after.setsJson.slice(0, 120));
  });

  // 5. 取消（pointercancel）不提交排序
  await runCase('pointercancel during drag does not commit order', 'real-mouse', async (page) => {
    const before = await order(page);
    const boxes = await cardBoxes(page, ['g3b-ex-1', 'g3b-ex-3']);
    const b1 = boxes['g3b-ex-1'];
    const b3 = boxes['g3b-ex-3'];
    await page.mouse.move(b1.x + b1.width * 0.5, b1.y + 24);
    await page.mouse.down();
    await sleep(520);
    await page.mouse.move(b1.x + b1.width * 0.5, b3.y + b3.height * 0.8, { steps: 10 });
    // 用 window blur 触发协调器取消（真实取消路径之一）
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(120);
    await page.mouse.up();
    await sleep(250);
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('取消后仍提交了排序');
    if (after.revision !== before.revision) throw new Error('取消不应落库');
  });

  // 6. 有氧分区拖动
  await runCase('cardio drag reorders cardio only', 'real-mouse', async (page) => {
    const before = await order(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(120);
    const zones = await page.evaluate(() => ({
      cardio: document.querySelectorAll('[data-reorder-kind="cardio"][data-reorder-id]').length,
      strength: document.querySelectorAll('[data-reorder-kind="strength"][data-reorder-id]').length,
    }));
    if (zones.cardio !== 2) throw new Error('有氧排序区未挂载: ' + JSON.stringify(zones));
    const boxes = await cardBoxes(page, ['g3b-cardio-1', 'g3b-cardio-2'], 'cardio-card-');
    const b1 = boxes['g3b-cardio-1'];
    const b2 = boxes['g3b-cardio-2'];
    const startY = b1.y + 24;
    await page.mouse.move(b1.x + b1.width * 0.5, startY);
    await page.mouse.down();
    await sleep(520);
    const dragging = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    if (!dragging) throw new Error('有氧卡片未进入拖动（长按未激活）');
    const dbg = async () => page.evaluate(() => {
      const el = document.querySelector('[data-drag-source="true"]');
      return {
        transform: el ? getComputedStyle(el).transform : null,
        id: el ? el.getAttribute('data-testid') : null,
        scrollY: window.scrollY,
        footerHit: (() => {
          const r = el?.getBoundingClientRect();
          if (!r) return null;
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + 24);
          return at ? (at.getAttribute('data-testid') || at.className || at.tagName) : null;
        })(),
      };
    });
    await page.mouse.move(b1.x + b1.width * 0.5, b2.y + b2.height - 4, { steps: 12 });
    await sleep(80);
    const moved = await dbg();
    await page.mouse.up();
    try {
      await page.waitForFunction(() => window.__test.order().then((o) => o.cardio[0] === 'g3b-cardio-2'), { timeout: 6000 });
    } catch {
      const o = await order(page);
      const body = await page.evaluate(() => document.body.innerText.slice(-160));
      throw new Error('有氧拖动未生效: ' + JSON.stringify(o.cardio) + ' moved=' + JSON.stringify(moved) + ' body=' + body.replace(/\n/g, ' | '));
    }
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('有氧拖动改动了力量顺序');
    if (after.revision !== before.revision + 1) throw new Error('有氧排序应只落库一次');
  });

  // 7. CDP touch 长按拖动
  await runCase('CDP touch long-press drag reorders (touch sequence)', 'cdp-touch', async (page) => {
    const before = await order(page);
    const client = await page.createCDPSession();
    const boxes = await cardBoxes(page, ['g3b-ex-2', 'g3b-ex-4']);
    const b1 = boxes['g3b-ex-2'];
    const b4 = boxes['g3b-ex-4'];
    const x = b1.x + b1.width * 0.5;
    const y = b1.y + 24;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 2, radiusY: 2, force: 1 }] });
    await sleep(560);
    const touchDragging = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    if (!touchDragging) throw new Error('触摸长按未激活拖动（pointer 未到达卡片展示区）');
    for (let i = 1; i <= 10; i += 1) {
      const ty = y + ((b4.y + b4.height * 0.8 - y) * i) / 10;
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: ty, radiusX: 2, radiusY: 2, force: 1 }] });
      await sleep(16);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    try {
      await page.waitForFunction(() => window.__test.order().then((o) => o.strength[1] !== 'g3b-ex-2'), { timeout: 6000 });
    } catch {
      const o = await order(page);
      throw new Error('触摸拖动未生效: ' + JSON.stringify(o.strength));
    }
    const after = await order(page);
    if (after.strength.length !== before.strength.length) throw new Error('触摸拖动改变了条目数量');
    if (after.revision !== before.revision + 1) throw new Error('触摸拖动应只落库一次');
  });

  // 8. 自动滚动：拖到底部边缘持续滚动
  await runCase('drag near bottom edge auto-scrolls and commits', 'real-mouse', async (page) => {
    // F12：展开态禁拖，先收起第 1 张卡再验证边缘自动滚动
    await ensureCollapsed(page, 'g3b-ex-1');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(120);
    const before = await order(page);
    const b1 = await cardBox(page, 'g3b-ex-1');
    await page.mouse.move(b1.x + b1.width * 0.5, b1.y + 24);
    await page.mouse.down();
    await sleep(520);
    const startScroll = await page.evaluate(() => window.scrollY);
    await page.mouse.move(b1.x + b1.width * 0.5, 890, { steps: 8 });
    await sleep(700); // 边缘感应带内保持，等待 RAF 自动滚动
    const midScroll = await page.evaluate(() => window.scrollY);
    if (midScroll <= startScroll) throw new Error('靠近底边未自动滚动: ' + startScroll + ' -> ' + midScroll);
    await page.mouse.up();
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength[0] !== 'g3b-ex-1'), { timeout: 5000 });
    const after = await order(page);
    if (after.revision !== before.revision + 1) throw new Error('自动滚动落位应只落库一次');
    const sig2 = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (sig2(after.setsById) !== sig2(before.setsById)) throw new Error('sets 实际内容被重建');
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG3B GESTURES: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
