#!/usr/bin/env node
/* G4：排序事务/失败/冲突/raw/计时/生命周期 的直接 App 证据（真实鼠标 + 隔离 IDB）。 */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G4_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g4/app-reorder';
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
  const result = { suite: 'g4-reorder-safety', cases: [], screenshots: [], errors: [] };
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
      if (entry.errors.length) {
        // 门禁：出现 pageerror 的用例不得记为 PASS
        throw new Error('pageerror: ' + entry.errors.join(' | '));
      }
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

  const order = (page) => page.evaluate(() => window.__test.order());
  const boxOf = async (page, id) => {
    const el = await page.waitForSelector(sel(`exercise-card-${id}`));
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    const b = await el.boundingBox();
    if (!b) throw new Error('no box ' + id);
    return b;
  };
  /** 一次滚动内测量多张卡，避免逐张 scrollIntoView 让先前坐标失效 */
  const boxesOf = async (page, ids) => {
    await page.evaluate((firstSel) => document.querySelector(firstSel)?.scrollIntoView({ block: 'center' }), sel(`exercise-card-${ids[0]}`));
    await sleep(80);
    const out = {};
    for (const id of ids) {
      const el = await page.$(sel(`exercise-card-${id}`));
      const b = await el.boundingBox();
      if (!b) throw new Error('no box ' + id);
      out[id] = b;
    }
    return out;
  };
  /**
   * F06/F12（2026-11-03 新需求）：记录**展开**的动作卡不再允许左滑与长按拖动排序。
   * 训练页进入时默认展开第 1 个动作，所以凡是要拖第 1 张卡的用例，必须先收起。
   * 这是新交互口径下的必要前置，不是放宽保护断言：
   * 排错/取消/计时不变等断言本身全部保留。
   */
  const ensureCollapsed = async (page, id) => {
    const button = sel(`exercise-card-${id}`) + ' button[aria-expanded]';
    const expanded = await page.$eval(button, (e) => e.getAttribute('aria-expanded') === 'true');
    if (expanded) { await page.click(button); await sleep(140); }
  };

  /** 从 fromId 拖到 targetId 的下缘（插入其后） */
  const dragToCard = async (page, fromId, targetId, { holdMs = 520, release = true } = {}) => {
    const boxes = await boxesOf(page, [fromId, targetId]);
    const b = boxes[fromId];
    const t = boxes[targetId];
    const x = b.x + b.width * 0.5;
    const y = b.y + 24;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(holdMs);
    await page.mouse.move(x, t.y + t.height - 4, { steps: 12 });
    await sleep(120);
    if (release) await page.mouse.up();
  };

  // 1. 存储写入异常（put 前 throw QuotaExceededError，不是 transaction.abort）：必须保留原顺序、不假报保存
  await runCase('storage put failure keeps original order and reports failure', 'real-mouse', async (page) => {
    await ensureCollapsed(page, 'g3b-ex-1'); // F12：展开态禁拖，先收起
    const before = await order(page);
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      window.__origPut = put;
      IDBObjectStore.prototype.put = function (v, k) {
        if (this.name === 'sessions') throw new DOMException('g4-injected-abort', 'QuotaExceededError');
        return k === undefined ? put.call(this, v) : put.call(this, v, k);
      };
    });
    await dragToCard(page, 'g3b-ex-1', 'g3b-ex-3');
    await page.waitForFunction(() => document.body.innerText.includes('没有保存') || document.body.innerText.includes('失败'), { timeout: 6000 });
    const after = await order(page);
    await page.evaluate(() => { IDBObjectStore.prototype.put = window.__origPut; });
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('失败却改变了顺序');
    if (after.revision !== before.revision) throw new Error('失败却推进 revision');
    if (await page.evaluate(() => document.body.innerText.includes('顺序已保存'))) throw new Error('失败却提示已保存');
  });

  // 2. 拖动期间外部改顺序 → 提交被拒绝（不覆盖新排序）
  await runCase('stale drag intent rejected when order changed externally', 'real-mouse', async (page) => {
    const before = await order(page);
    const boxes = await boxesOf(page, ['g3b-ex-1', 'g3b-ex-3']);
    const b = boxes['g3b-ex-1'];
    const t = boxes['g3b-ex-3'];
    await page.mouse.move(b.x + b.width * 0.5, b.y + 24);
    await page.mouse.down();
    await sleep(520);
    await page.mouse.move(b.x + b.width * 0.5, t.y + t.height - 4, { steps: 10 });
    await sleep(100);
    // 外部（另一页）改顺序：交换最后两张并 +1 revision
    await page.evaluate(async () => {
      const open = indexedDB.open('motion-training', 1);
      const db = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
      await new Promise((res, rej) => {
        const tx = db.transaction('sessions', 'readwrite');
        const st = tx.objectStore('sessions');
        const q = st.get('g3b-session');
        q.onsuccess = () => {
          const v = q.result;
          const arr = v.exercises;
          const last = arr.pop();
          arr.unshift(last);
          v.revision += 1;
          st.put(v);
        };
        tx.oncomplete = res; tx.onabort = () => rej(tx.error);
      });
      db.close();
    });
    await page.mouse.up();
    await sleep(500);
    const after = await order(page);
    // 外部顺序（ex-10 在首位）必须保留，不能被旧拖动意图覆盖
    if (after.strength[0] !== 'g3b-ex-10') throw new Error('旧拖动覆盖了外部新顺序: ' + JSON.stringify(after.strength.slice(0, 3)));
    if (after.revision !== before.revision + 1) throw new Error('不应再落库一次: ' + before.revision + ' -> ' + after.revision);
  });

  // 3. 显式 blur 后 raw 保留 + actual/ID 不变（真正未 blur 由根独立用例覆盖）
  await runCase('explicit-blur raw and actuals survive a reorder', 'real-mouse+keyboard', async (page) => {
    await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    }, sel('exercise-card-g3b-ex-2') + ' button[aria-expanded]');
    const input = await page.waitForSelector(sel('exercise-card-g3b-ex-2') + ' input[aria-label*="次数"]');
    await input.click();
    await page.keyboard.type('7.'); // 未完成小数
    // 先显式 blur 一次（非法草稿会被保留、不写库），隔离出"排序"这一个变量
    await page.mouse.click(5, 5);
    await sleep(150);
    const before = await order(page);
    const revAfterTyping = before.revision;
    await dragToCard(page, 'g3b-ex-1', 'g3b-ex-3');
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength[0] !== 'g3b-ex-1'), { timeout: 6000 });
    const rawNow = await page.$eval(sel('exercise-card-g3b-ex-2') + ' input[aria-label*="次数"]', (e) => e.value);
    if (rawNow !== '7.') throw new Error('显式 blur 后的 raw 丢失: ' + rawNow);
    const after = await order(page);
    const sig = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (sig(after.setsById) !== sig(before.setsById)) throw new Error('actual/set 被改动');
    if (after.revision !== revAfterTyping + 1) throw new Error('排序应只落库一次: ' + revAfterTyping + ' -> ' + after.revision);
  });

  // 4. 当前休息计时 token/deadline 不因排序改变
  await runCase('active rest timer token and deadline unchanged by reorder', 'real-mouse', async (page) => {
    await page.evaluate((s) => {
      const btn = document.querySelector(s);
      if (btn && btn.getAttribute('aria-expanded') === 'false') btn.click();
    }, sel('exercise-card-g3b-ex-1') + ' button[aria-expanded]');
    // 手动"计时"按钮只在组已完成时出现：先点该组"完成"
    const doneHandle = await page.evaluateHandle((c) =>
      [...document.querySelectorAll(c + ' button')].find((b) => b.textContent.trim() === '完成') || null,
      sel('exercise-card-g3b-ex-1'));
    const doneEl = doneHandle.asElement();
    if (!doneEl) throw new Error('找不到「完成」按钮');
    await doneEl.click();
    await sleep(200);
    const startBtn = await page.waitForSelector(sel('exercise-card-g3b-ex-1') + ' button[aria-label="开始组间休息计时"]');
    await startBtn.click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('motion-rest-timer:g3b-session') || 'null')?.token);
    const beforeSnap = await page.evaluate(() => JSON.parse(sessionStorage.getItem('motion-rest-timer:g3b-session')));
    // F12：计时启动后必须先收起该动作的记录，才允许长按排序（计时本身不受收起影响）
    await ensureCollapsed(page, 'g3b-ex-1');
    await dragToCard(page, 'g3b-ex-1', 'g3b-ex-3');
    await page.waitForFunction(() => window.__test.order().then((o) => o.strength[0] !== 'g3b-ex-1'), { timeout: 6000 });
    const afterSnap = await page.evaluate(() => JSON.parse(sessionStorage.getItem('motion-rest-timer:g3b-session')));
    if (!afterSnap) throw new Error('排序清掉了休息计时');
    if (afterSnap.token !== beforeSnap.token) throw new Error('token 被重置');
    if (afterSnap.endsAt !== beforeSnap.endsAt) throw new Error('deadline 被重置');
  });

  // 5. 拖动中 blur → 取消、不提交、不遗留自动滚动
  await runCase('blur during drag cancels and leaves no autoscroll', 'real-mouse', async (page) => {
    const before = await order(page);
    const vhB = await page.evaluate(() => window.innerHeight);
    const b1 = await boxOf(page, 'g3b-ex-1');
    await page.mouse.move(b1.x + b1.width * 0.5, b1.y + 24);
    await page.mouse.down();
    await sleep(520);
    await page.mouse.move(b1.x + b1.width * 0.5, vhB - 8, { steps: 8 });
    await sleep(120);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await sleep(150);
    const y1 = await page.evaluate(() => window.scrollY);
    await sleep(500);
    const y2 = await page.evaluate(() => window.scrollY);
    await page.mouse.up();
    await sleep(200);
    const after = await order(page);
    if (JSON.stringify(after.strength) !== JSON.stringify(before.strength)) throw new Error('取消后仍提交了排序');
    if (y2 !== y1) throw new Error('取消后仍在自动滚动: ' + y1 + ' -> ' + y2);
  });

  // 6. 离边停止自动滚动
  await runCase('leaving the edge stops autoscroll', 'real-mouse', async (page) => {
    await ensureCollapsed(page, 'g3b-ex-1'); // F12：展开态禁拖，先收起
    const b = await boxOf(page, 'g3b-ex-1');
    await page.mouse.move(b.x + b.width * 0.5, b.y + 24);
    await page.mouse.down();
    await sleep(520);
    const dragging = await page.evaluate(() => Boolean(document.querySelector('[data-drag-source="true"]')));
    if (!dragging) throw new Error('长按未进入拖动');
    // 视口高度在不同 deviceScale 下会变：按真实 innerHeight 计算边缘点
    const vh = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(b.x + b.width * 0.5, vh - 8, { steps: 6 });
    await sleep(700);
    const edgeY = await page.evaluate(() => window.scrollY);
    if (edgeY <= 0) {
      const diag = await page.evaluate(() => ({
        innerHeight: window.innerHeight,
        scrollY: window.scrollY,
        scrollHeight: document.scrollingElement ? document.scrollingElement.scrollHeight : -1,
        bodyOverflow: document.body.style.overflow,
        drag: Boolean(document.querySelector('[data-drag-source="true"]')),
      }));
      throw new Error('边缘未自动滚动 ' + JSON.stringify(diag));
    }
    const vh2 = await page.evaluate(() => window.innerHeight);
    await page.mouse.move(b.x + b.width * 0.5, Math.round(vh2 / 2), { steps: 6 });
    await sleep(400);
    const y1 = await page.evaluate(() => window.scrollY);
    await sleep(400);
    const y2 = await page.evaluate(() => window.scrollY);
    await page.mouse.up();
    if (y2 !== y1) throw new Error('离开边缘后仍在滚动: ' + y1 + ' -> ' + y2);
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG4 REORDER SAFETY: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
