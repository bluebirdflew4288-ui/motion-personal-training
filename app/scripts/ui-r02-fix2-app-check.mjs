#!/usr/bin/env node
/* R02 FIX2 真实 App + IndexedDB 回归：
   训练中 3/2 → 点击“+ 加一轮” → 3/2/2 → 打开训练编辑器**无改保存**仍 3/2/2；
   刷新后仍保持；再只改第 1 轮阶段名，第 2/3 轮配置不被连带修改。
   覆盖 superset / dropSet 两种训练形式。 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { r02Fix2Entry } from './dom-regression/r02-fix2-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_R02_FIX2_APP_EVIDENCE_DIR || '/private/tmp/motion-harness-round-config-fix2-20261116-v1/tests/r02-fix2-app';
const SHOTS = join(OUT, 'screens');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const effStages = (target, round) => {
  if (!target || target.kind !== 'dropSet') return [];
  const rc = (target.roundConfigs ?? []).find((r) => r.roundIndex === round);
  return rc ? rc.stages : target.stages;
};
const stageView = (list) =>
  list.map((s) => ({
    id: s.id,
    label: s.label,
    weightKg: s.weightKg,
    repsMin: s.repsMin,
    repsMax: s.repsMax,
    toFailure: s.toFailure,
    restAfterSec: s.restAfterSec ?? null,
  }));

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: r02Fix2Entry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __AUDIT_STRICT__: 'false', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: JSON.stringify('web') },
    nodePaths: [join(APP_DIR, 'node_modules')],
    logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
    } else if (req.url.startsWith('/style.css')) {
      res.setHeader('Content-Type', 'text/css');
      res.end(css);
    } else if (req.url.startsWith('/fonts/')) {
      try {
        const buf = await readFile(join(APP_DIR, 'public', req.url.split('?')[0]));
        res.setHeader('Content-Type', 'font/woff2');
        res.end(buf);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    } else {
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(OUT, 'chrome-profile'),
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox'],
  });
  const result = { suite: 'r02-fix2-app', cases: [], screenshots: [], errors: [] };
  let idx = 0;

  const makeHelpers = (page) => {
    const sel = (id) => `[data-testid="${id}"]`;
    const waitId = (id, timeout = 8000) => page.waitForSelector(sel(id), { visible: true, timeout });
    const hit = async (selector) => {
      const el = await page.waitForSelector(selector, { visible: true, timeout: 8000 });
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.waitForFunction((selText) => {
        const target = document.querySelector(selText);
        if (!target || target.disabled) return false;
        const r = target.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(at && (target === at || target.contains(at)));
      }, { timeout: 6000 }, selector);
      await el.click();
      await sleep(60);
    };
    const clickId = (id) => hit(sel(id));
    const clickText = async (text) => {
      const handles = (await page.$$('button')).reverse();
      for (const h of handles) {
        const label = await h.evaluate((x) => (x.textContent || '').trim());
        if (label !== text) continue;
        await h.evaluate((x) => x.scrollIntoView({ block: 'center', inline: 'center' }));
        await page.waitForFunction((el) => {
          const r = el.getBoundingClientRect();
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !el.disabled && Boolean(at && (el === at || el.contains(at)));
        }, { timeout: 6000 }, h);
        await h.click();
        await sleep(80);
        return;
      }
      throw new Error(`找不到可点击按钮: ${text}`);
    };
    const typeId = async (id, value) => {
      await clickId(id);
      const el = await page.$(sel(id));
      const n = (await el.evaluate((x) => x.value)).length + 1;
      for (let i = 0; i < n; i += 1) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < n; i += 1) await page.keyboard.press('Backspace');
      const cleared = await el.evaluate((x) => x.value);
      if (cleared !== '') throw new Error(`键盘清空失败 ${id}: ${JSON.stringify(cleared)}`);
      await page.keyboard.type(String(value), { delay: 8 });
      await sleep(30);
    };
    const valueOf = (id) => page.$eval(sel(id), (e) => e.value);
    const session = (id) => page.evaluate(async (sid) => await window.__db.getSession(sid), id);
    const navigate = (sid) => page.evaluate(async (s) => await window.__test.navigate(s), sid);
    const openEditorBySwipe = async (exId) => {
      await page.evaluate((x) => { window.__step = 'swipe:collapse ' + x; }, exId);
      const expanded = await page.$(`[data-testid="exercise-card-${exId}"] button[aria-expanded="true"]`);
      if (expanded) { await expanded.click(); await sleep(120); }
      await page.evaluate((x) => { window.__step = 'swipe:header ' + x; }, exId);
      const header = await page.waitForSelector(sel(`exercise-card-${exId}`) + ' h3', { visible: true, timeout: 8000 });
      await header.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      const b = await header.boundingBox();
      if (!b) throw new Error('卡片标题无 boundingBox');
      const x = b.x + b.width * 0.8;
      const y = b.y + b.height * 0.5;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 145, y, { steps: 10 });
      await page.mouse.up();
      const edit = `[data-testid="exercise-card-${exId}-edit"]`;
      await page.evaluate((x) => { window.__step = 'swipe:wait-edit ' + x; }, exId);
      await page.waitForFunction((selText) => {
        const e = document.querySelector(selText);
        if (!e) return false;
        const r = e.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(at && (e === at || e.contains(at)));
      }, { timeout: 6000 }, edit);
      await page.evaluate((x) => { window.__step = 'swipe:click-edit ' + x; }, exId);
      await clickId(`exercise-card-${exId}-edit`);
      await page.evaluate((x) => { window.__step = 'swipe:wait-editor ' + x; }, exId);
      await waitId('exercise-editor');
    };
    const saveEditor = async () => {
      await clickId('editor-save');
      await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 8000 });
      await sleep(160);
    };
    return { page, sel, waitId, clickId, clickText, typeId, valueOf, session, navigate, openEditorBySwipe, saveEditor };
  };

  const runCase = async (name, fn) => {
    idx += 1;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const shot = join(SHOTS, `case-${String(idx).padStart(2, '0')}.png`);
    const entry = { name, ok: true, errors, screenshot: shot };
    try {
      await page.setViewport({ width: 430, height: 940, hasTouch: true, isMobile: true });
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      if (await page.evaluate(() => window.__bootError)) throw new Error('boot error: ' + await page.evaluate(() => window.__bootError));
      await fn(makeHelpers(page));
      result.cases.push(entry);
      console.log('  ✔ ' + name);
    } catch (e) {
      entry.ok = false;
      let step = '';
      try { step = await page.evaluate(() => window.__step || ''); } catch { /* ignore */ }
      entry.detail = (e instanceof Error ? e.message : String(e)) + (step ? ' | step=' + step : '');
      result.cases.push(entry);
      console.log('  ✘ ' + name + ' :: ' + entry.detail);
    } finally {
      try { await page.screenshot({ path: shot }); result.screenshots.push(shot); } catch { /* ignore */ }
      await context.close();
    }
  };

  const formCase = async (form) => {
    await runCase(`训练中 3/2 → 加第 3 轮 → 编辑器无改保存仍 3/2/2（${form}）`, async (h) => {
      const mark = async (s) => { await h.page.evaluate((x) => { window.__step = x; }, s); };
      await mark('read-ids');
      const sid = await h.page.evaluate((f) => window.__test.ids[f], form);
      const exId = `r02-fix2-ex-${form}`;
      const before = await h.session(sid);
      const beforeIds = new Set(before.exercises[0].sets.map((s) => s.id));
      if (before.exercises[0].groups.map((g) => g.stageCount).join(',') !== '3,2') throw new Error('初始结构不是 3/2');
      await mark('navigate-initial');
      await h.navigate(sid);
      await h.waitId(`exercise-card-${exId}`);
      await mark('add-round-click');
      await h.clickText('+ 加一轮');
      await h.page.waitForFunction(async (id) => {
        const s = await window.__db.getSession(id);
        return s && s.exercises[0].groups.length === 3;
      }, { timeout: 8000 }, sid);
      const added = await h.session(sid);
      const ex = added.exercises[0];
      if (ex.groups.map((g) => g.stageCount).join(',') !== '3,2,2') throw new Error('加轮后 groups 不是 3/2/2: ' + ex.groups.map((g) => g.stageCount));
      if (ex.target.rounds !== 3) throw new Error('加轮后 target.rounds 不是 3: ' + ex.target.rounds);
      if (effStages(ex.target, 1).length !== 3 || effStages(ex.target, 2).length !== 2 || effStages(ex.target, 3).length !== 2) throw new Error('加轮后逐轮配置不是 3/2/2');
      const r3 = ex.sets.filter((s) => s.roundIndex === 3);
      if (r3.length !== 2) throw new Error('第 3 轮 set 行数不是 2');
      if (r3.some((s) => s.reps !== null || s.weightKg !== null || s.status !== 'blank' || (s.note && s.note !== ''))) throw new Error('第 3 轮复制了运行态');
      if (r3.some((s) => beforeIds.has(s.id))) throw new Error('第 3 轮复用了旧 set.id');
      if (new Set(ex.sets.map((s) => s.id)).size !== ex.sets.length) throw new Error('set.id 不唯一');

      // 打开训练编辑器，无改动直接保存。
      await mark('open-editor-noop');
      await h.openEditorBySwipe(exId);
      await mark('check-editor-rounds');
      if ((await h.valueOf('editor-rounds')) !== '3') throw new Error('编辑器未按实际 3 轮显示');
      const tab3 = await h.page.$eval(h.sel('round-tab-3'), (el) => el.textContent || '');
      if (!tab3.includes('2 阶段')) throw new Error('编辑器第 3 轮不是继承的 2 阶段: ' + tab3);
      await h.page.screenshot({ path: join(SHOTS, `case-${String(idx).padStart(2, '0')}-editor-${form}.png`), fullPage: false }).catch(() => {});
      await mark('save-editor-noop');
      await h.saveEditor();
      await mark('read-saved');

      const saved = await h.session(sid);
      const sex = saved.exercises[0];
      if (sex.groups.map((g) => g.stageCount).join(',') !== '3,2,2') throw new Error('无改保存后 groups 被改: ' + sex.groups.map((g) => g.stageCount));
      if (sex.target.rounds !== 3) throw new Error('无改保存后 target.rounds 被改: ' + sex.target.rounds);
      if (effStages(sex.target, 1).length !== 3 || effStages(sex.target, 2).length !== 2 || effStages(sex.target, 3).length !== 2) throw new Error('无改保存后逐轮配置丢失');
      if (sex.sets.filter((s) => s.roundIndex === 3).length !== 2) throw new Error('无改保存后第 3 轮行数丢失');

      // 刷新（IDB 持久化 + boot 不重建已存在 session）后仍保持。
      await mark('reload');
      await h.page.reload({ waitUntil: 'load' });
      await h.page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      await mark('navigate-after-reload');
      await h.navigate(sid);
      await h.waitId(`exercise-card-${exId}`);
      const reloaded = await h.session(sid);
      const rex = reloaded.exercises[0];
      if (rex.groups.map((g) => g.stageCount).join(',') !== '3,2,2') throw new Error('刷新后 groups 丢失: ' + rex.groups.map((g) => g.stageCount));
      if (effStages(rex.target, 3).length !== 2) throw new Error('刷新后第 3 轮配置丢失');
      const r3After = rex.sets.filter((s) => s.roundIndex === 3);
      if (r3After.length !== 2 || r3After.some((s) => s.status !== 'blank' || s.reps !== null || s.weightKg !== null)) throw new Error('刷新后第 3 轮运行态异常');
    });
  };

  const editFirstCase = async (form) => {
    await runCase(`只改第 1 轮阶段名：第 2 轮配置不被连带修改（${form}）`, async (h) => {
      const mark = async (s) => { await h.page.evaluate((x) => { window.__step = x; }, s); };
      const sid = await h.page.evaluate((f) => window.__test.ids[f], form);
      const exId = `r02-fix2-ex-${form}`;
      await mark('edit-first:navigate');
      await h.navigate(sid);
      await h.waitId(`exercise-card-${exId}`);
      const before = await h.session(sid);
      const beforeRound2 = stageView(effStages(before.exercises[0].target, 2));
      const beforeGroups = before.exercises[0].groups.map((g) => g.stageCount);
      await mark('edit-first:open-editor');
      await h.openEditorBySwipe(exId);
      await mark('edit-first:type');
      await h.typeId('stage-0-label', 'ONLY-FIRST');
      await mark('edit-first:save');
      await h.saveEditor();
      const after = await h.session(sid);
      const aex = after.exercises[0];
      if (effStages(aex.target, 1)[0].label !== 'ONLY-FIRST') throw new Error('第 1 轮 label 未保存');
      const afterRound2 = stageView(effStages(aex.target, 2));
      if (JSON.stringify(afterRound2) !== JSON.stringify(beforeRound2)) {
        throw new Error('改第 1 轮连带修改了第 2 轮: ' + JSON.stringify({ beforeRound2, afterRound2 }));
      }
      if (JSON.stringify(aex.groups.map((g) => g.stageCount)) !== JSON.stringify(beforeGroups)) {
        throw new Error('改第 1 轮后结构被改: ' + aex.groups.map((g) => g.stageCount));
      }
    });
  };

  await formCase('superset');
  await formCase('dropSet');
  await editFirstCase('superset');
  await editFirstCase('dropSet');

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nR02 FIX2 APP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
