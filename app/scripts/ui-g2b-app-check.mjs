#!/usr/bin/env node
/* G2B-FIX2 真实生产 App 集成验证：
   · 每个用例使用独立 browser context（独立 IndexedDB），finally 关闭 context；
   · 点击统一走真实鼠标坐标 + elementFromPoint 命中诊断，失败保留输入/命中信息；
   · 键盘输入走 page.keyboard；programmatic 事件只在显式标注的用例里做逻辑探针。
   证据输出默认 /private/tmp/motion-editor-20261031/g2b-fix2/app。 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g2bFix2Entry } from './dom-regression/g2b-fix2-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G2B_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g2b-fix2/app';
const SHOTS = join(OUT, 'screens');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: g2bFix2Entry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __AUDIT_STRICT__: 'false', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: JSON.stringify('web') },
    nodePaths: [join(APP_DIR, 'node_modules')], logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (req.url.startsWith('/style.css')) { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (req.url.startsWith('/fonts/')) {
      try { const buf = await readFile(join(APP_DIR, 'public', req.url.split('?')[0])); res.setHeader('Content-Type', 'font/woff2'); res.end(buf); } catch { res.statusCode = 404; res.end(); }
    } else res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, 'chrome-profile'), args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox'] });
  const result = { suite: 'g2b-fix2-app', cases: [], screenshots: [], errors: [] };
  let idx = 0;

  const makeHelpers = (page) => {
    const sel = (id) => `[data-testid="${id}"]`;
    const exists = async (id) => (await page.$(sel(id))) !== null;
    const waitId = (id, timeout = 6000) => page.waitForSelector(sel(id), { visible: true, timeout });
    const hit = async (selector, label) => {
      const el = await page.waitForSelector(selector, { visible: true, timeout: 6000 });
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
      // 根脚本同款：实时等待 elementFromPoint 真正命中，再执行真实 el.click
      await page.waitForFunction((selText) => {
        const target = document.querySelector(selText);
        if (!target || target.disabled) return false;
        const r = target.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(at && (target === at || target.contains(at)));
      }, { timeout: 5000 }, selector);
      await el.click();
      await sleep(50);
    };
    const clickId = (id) => hit(sel(id), id);
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
        }, { timeout: 5000 }, h);
        await h.click();
        await sleep(70);
        return;
      }
      throw new Error(`找不到可点击按钮: ${text}`);
    };
    const clickSelector = (selector) => hit(selector, selector);
    const typeId = async (id, value) => {
      await clickId(id);
      const el = await page.$(sel(id));
      const n = (await el.evaluate((x) => x.value)).length + 1;
      for (let i = 0; i < n; i += 1) await page.keyboard.press('ArrowRight');
      for (let i = 0; i < n; i += 1) await page.keyboard.press('Backspace');
      const cleared = await el.evaluate((x) => x.value);
      if (cleared !== '') throw new Error(`键盘清空失败 ${id}: ${JSON.stringify(cleared)}`);
      await page.keyboard.type(String(value), { delay: 8 });
      const typed = await el.evaluate((x) => x.value);
      if (typed !== String(value)) throw new Error(`键盘输入不一致 ${id}: ${JSON.stringify(typed)} != ${JSON.stringify(value)}`);
      await sleep(20);
    };
    const valueOf = (id) => page.$eval(sel(id), (e) => e.value);
    const checkedOf = (id) => page.$eval(sel(id), (e) => e.checked);
    const session = (id = 'g2a-existing-session') => page.evaluate(async (sid) => await window.__db.getSession(sid), id);
    const templates = async () => (await page.evaluate(async () => await window.__db.getTemplates())).templates;
    const restFor = (exId, stage) => page.evaluate(async ([e, s]) => await window.__db.restFor(e, s), [exId, stage]);
    const completionFor = (sid, exId) => page.evaluate(async ([s, e]) => await window.__db.completionFor(s, e), [sid, exId]);
    const navigate = (sid) => page.evaluate(async (s) => await window.__test.navigate(s), sid);
    const openEditorBySwipe = async (exId) => {
      // 当前会话默认展开第一个未完成动作；卡片展开时左滑被锁定（产品既有行为）。
      // 真实验收需先收起再左滑，避免把“已展开→不可滑”误报成编辑入口缺失。
      const expanded = await page.$(`[data-testid="exercise-card-${exId}"] button[aria-expanded="true"]`);
      if (expanded) { await expanded.click(); await sleep(100); }
      const header = await page.waitForSelector(sel(`exercise-card-${exId}`) + ' h3', { visible: true, timeout: 6000 });
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
      await page.waitForFunction((selText) => {
        const e = document.querySelector(selText);
        if (!e) return false;
        const r = e.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(at && (e === at || e.contains(at)));
      }, { timeout: 5000 }, edit);
      await clickSelector(edit);
      await waitId('exercise-editor');
      return 'real-mouse';
    };
    const openAddPicker = async () => { await clickText('+ 临时加动作'); await waitId('exercise-name-picker'); };
    const pickCustom = async (name) => { await typeId('name-custom-input', name); await clickId('name-custom-apply'); };
    const pickLibrary = async (search, name) => {
      await typeId('name-search', search);
      await sleep(120);
      const index = await page.evaluate((n) => {
        const buttons = [...document.querySelectorAll('[data-testid^="name-option-"]')];
        return buttons.findIndex((b) => (b.textContent || '').includes(n));
      }, name);
      if (index < 0) throw new Error(`动作库无 ${name}`);
      await clickId(`name-option-${index}`);
    };
    const saveEditor = async (waitClose = true) => {
      await clickId('editor-save');
      if (waitClose) await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 6000 });
    };
    const confirm = async (yes) => {
      await waitId(yes ? 'confirm-ok' : 'confirm-cancel');
      await clickId(yes ? 'confirm-ok' : 'confirm-cancel');
      await sleep(120);
    };
    const bodyText = () => page.evaluate(() => document.body.innerText || '');
    return { page, sel, exists, waitId, hit, clickId, clickText, clickSelector, typeId, valueOf, checkedOf, session, templates, restFor, completionFor, navigate, openEditorBySwipe, openAddPicker, pickCustom, pickLibrary, saveEditor, confirm, bodyText };
  };

  const runCase = async (name, inputMode, fn) => {
    idx += 1;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const shot = join(SHOTS, `case-${String(idx).padStart(2, '0')}.png`);
    const entry = { name, inputMode, ok: true, errors, screenshot: shot };
    try {
      await page.setViewport({ width: 430, height: 900, hasTouch: true, isMobile: true });
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      if (await page.evaluate(() => window.__bootError)) throw new Error('boot error: ' + await page.evaluate(() => window.__bootError));
      await page.waitForFunction(() => (document.body.innerText || '').includes('工具'), { timeout: 8000 });
      await fn(makeHelpers(page));
      result.cases.push(entry);
      console.log('  ✔ ' + name);
    } catch (e) {
      entry.ok = false;
      entry.detail = e instanceof Error ? e.message : String(e);
      result.cases.push(entry);
      console.log('  ✘ ' + name + ' :: ' + entry.detail);
    } finally {
      try { await page.screenshot({ path: shot }); result.screenshots.push(shot); } catch { /* ignore */ }
      await context.close();
    }
  };

  await runCase('真实训练页加载 + 旧替换/形式工具入口不可达；skip 保留', 'real-mouse', async (h) => {
    if (!(await h.exists('exercise-card-g2b-multi'))) throw new Error('训练卡未渲染');
    await h.clickText('工具');
    const body = await h.bodyText();
    if (body.includes('调整训练形式')) throw new Error('仍存在“调整训练形式”工具入口');
    if (body.includes('用另一个动作替换')) throw new Error('仍存在“用另一个动作替换”工具入口');
    if (!body.includes('跳过剩余组')) throw new Error('非重复工具被误删');
  });

  await runCase('真实鼠标左滑露出蓝编辑/红删除，点击编辑打开共用编辑器并带实际 groups', 'real-mouse', async (h) => {
    await h.openEditorBySwipe('g2b-multi');
    const rows = await h.page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (rows !== 3) throw new Error('编辑器不是实际 3 阶段: ' + rows);
    const deleteVisible = await h.exists('exercise-card-g2b-multi-delete');
    if (!deleteVisible) throw new Error('左滑删除按钮缺失');
  });

  await runCase('阶段自定义 label / 短间歇15-20 / 整轮90 保存，记录行使用 label', 'real-keyboard+mouse', async (h) => {
    await h.openEditorBySwipe('g2b-multi');
    await h.typeId('stage-0-label', '上半程改');
    await h.typeId('stage-1-label', '下半程改');
    await h.typeId('stage-0-rest', '15');
    await h.typeId('stage-1-rest', '20');
    await h.typeId('editor-round-rest', '90');
    await h.saveEditor(false);
    if (await h.exists('confirm-ok')) await h.confirm(true);
    await h.page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 6000 });
    const s = await h.session();
    const ex = s.exercises.find((e) => e.id === 'g2b-multi');
    if (ex.target.stages[0].label !== '上半程改' || ex.target.stages[1].label !== '下半程改') throw new Error('阶段 label 未落库');
    if (ex.target.stages[0].restAfterSec !== 15 || ex.target.stages[1].restAfterSec !== 20 || ex.target.restAfterSec !== 90) throw new Error('15/20/90 休息未落库');
    if (await h.restFor('g2b-multi', 1) !== 15 || await h.restFor('g2b-multi', 2) !== 20 || await h.restFor('g2b-multi', 3) !== 90) throw new Error('restAfterSet 取值不正确');
    await h.clickSelector('[data-testid="exercise-card-g2b-multi"] button[aria-expanded]');
    const card = await h.page.$eval(h.sel('exercise-card-g2b-multi'), (e) => e.innerText);
    if (!card.includes('上半程改')) throw new Error('记录行未使用自定义阶段 label: ' + card.slice(0, 300));
    if (card.includes('阶段 1') || card.includes('阶段 2')) throw new Error('记录行仍显示固定阶段名: ' + card.slice(0, 300));
    const body = await h.bodyText();
    if (!body.includes('整轮休息') || !body.includes('阶段间歇')) throw new Error('休息摘要未区分短间歇/整轮休息');
  });

  await runCase('身份-库选择替换：取消不变；确认后同卡ID/actual保留/identity变更/planExerciseId=null/不拆卡', 'real-mouse+keyboard', async (h) => {
    await h.navigate('g2b-identity-session');
    const before = await h.session('g2b-identity-session');
    const origin = before.exercises.find((e) => e.id === 'identity-ex');
    await h.openEditorBySwipe('identity-ex');
    await h.clickId('editor-name-button');
    await h.waitId('exercise-name-picker');
    await h.pickLibrary('哑铃卧推', '哑铃卧推');
    await h.saveEditor(false);
    await h.waitId('confirm-ok');
    const confirmBody = await h.bodyText();
    if (!confirmBody.includes('确认修改影响')) throw new Error('身份变化未出现影响确认');
    await h.confirm(false);
    if (!(await h.exists('exercise-editor'))) throw new Error('取消后编辑器被关闭');
    const canceled = await h.session('g2b-identity-session');
    const canceledEx = canceled.exercises.find((e) => e.id === 'identity-ex');
    if (canceledEx.exerciseId !== origin.exerciseId || canceledEx.planExerciseId !== origin.planExerciseId) throw new Error('取消后身份/来源改变');
    if (JSON.stringify(canceledEx.sets) !== JSON.stringify(origin.sets)) throw new Error('取消后 actual 改变');
    await h.saveEditor(false);
    await h.waitId('confirm-ok');
    await h.confirm(true);
    await h.page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 6000 });
    const after = await h.session('g2b-identity-session');
    if (after.exercises.length !== before.exercises.length) throw new Error('替换拆卡/改变了动作数量');
    const changed = after.exercises.find((e) => e.id === 'identity-ex');
    if (!changed) throw new Error('原卡消失');
    if (changed.exerciseId === origin.exerciseId) throw new Error('真实 identity 未改变');
    if (changed.planExerciseId !== null) throw new Error('planExerciseId 未置 null');
    if (JSON.stringify(changed.sets) !== JSON.stringify(origin.sets)) throw new Error('actual/set 未保留');
  });

  await runCase('身份-自定义输入替换：确认后同卡、actual保留、identity变更、planExerciseId=null', 'real-mouse+keyboard', async (h) => {
    await h.navigate('g2b-identity-session');
    const before = await h.session('g2b-identity-session');
    const origin = before.exercises.find((e) => e.id === 'identity-ex');
    await h.openEditorBySwipe('identity-ex');
    await h.clickId('editor-name-button');
    await h.waitId('exercise-name-picker');
    await h.pickCustom('器械推胸自定义');
    await h.saveEditor(false);
    await h.waitId('confirm-ok');
    await h.confirm(true);
    await h.page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 6000 });
    const after = await h.session('g2b-identity-session');
    if (after.exercises.length !== before.exercises.length) throw new Error('自定义替换拆卡');
    const changed = after.exercises.find((e) => e.id === 'identity-ex');
    if (!changed || changed.exerciseId === origin.exerciseId || changed.planExerciseId !== null) throw new Error('自定义 identity/来源未按预期变化');
    if (JSON.stringify(changed.sets) !== JSON.stringify(origin.sets)) throw new Error('自定义替换 actual 丢失');
  });

  await runCase('身份-同 normalized identity 保留 planExerciseId', 'real-mouse+keyboard', async (h) => {
    await h.navigate('g2b-identity-custom-session');
    const before = await h.session('g2b-identity-custom-session');
    const origin = before.exercises.find((e) => e.id === 'identity-custom-ex');
    await h.openEditorBySwipe('identity-custom-ex');
    await h.clickId('editor-name-button');
    await h.waitId('exercise-name-picker');
    await h.pickCustom(' 卧推 自定 ');
    await h.saveEditor();
    const after = await h.session('g2b-identity-custom-session');
    const got = after.exercises.find((e) => e.id === 'identity-custom-ex');
    if (got.exerciseId !== 'custom:卧推自定') throw new Error('规范化 identity 错误: ' + got.exerciseId);
    if (got.planExerciseId !== origin.planExerciseId) throw new Error('同 identity 误清 planExerciseId');
  });

  await runCase('首次添加自定义名称自动记忆；二次同身份直加；实例独立ID/actual空', 'real-mouse+keyboard', async (h) => {
    const before = await h.session();
    await h.openAddPicker();
    await h.pickCustom('FIX2记忆动作');
    await h.waitId('exercise-editor');
    await h.saveEditor();
    const after = await h.session();
    if (after.exercises.length !== before.exercises.length + 1) throw new Error('首次添加未新增一个动作');
    await h.openAddPicker();
    await h.pickCustom('FIX2记忆动作');
    await sleep(300);
    if (await h.exists('exercise-editor')) throw new Error('已有记忆仍打开配置页');
    const after2 = await h.session();
    if (after2.exercises.length !== after.exercises.length + 1) throw new Error('二次直加未新增动作');
    const added = after2.exercises.filter((e) => e.name === 'FIX2记忆动作');
    if (added.length !== 2 || added[0].id === added[1].id) throw new Error('同身份重复实例 ID 未独立');
    if (added.some((e) => e.sets.some((s) => s.reps !== null || s.weightKg !== null || s.status !== 'blank'))) throw new Error('新实例继承 actual');
  });

  await runCase('无记忆内置动作：先进入共用编辑器，取消不产生幽灵', 'real-mouse+keyboard', async (h) => {
    const before = await h.session();
    const templatesBefore = (await h.templates()).length;
    await h.openAddPicker();
    await h.pickLibrary('史密斯上斜卧推', '史密斯上斜卧推');
    await h.waitId('exercise-editor');
    await h.clickId('editor-cancel');
    if (await h.exists('leave-discard')) await h.clickId('leave-discard');
    await sleep(150);
    const after = await h.session();
    if (after.exercises.length !== before.exercises.length) throw new Error('取消后出现幽灵动作');
    if ((await h.templates()).length !== templatesBefore) throw new Error('取消后写入记忆');
  });

  await runCase('已有记忆编辑：未勾只改本次；勾选更新模板', 'real-mouse+keyboard', async (h) => {
    await h.openAddPicker(); await h.pickCustom('模板更新动作'); await h.waitId('exercise-editor'); await h.saveEditor();
    let s = await h.session();
    const first = s.exercises.find((e) => e.name === '模板更新动作');
    await h.openEditorBySwipe(first.id);
    if (!(await h.exists('editor-remember'))) throw new Error('编辑已有记忆动作无记住选项');
    if (await h.checkedOf('editor-remember')) throw new Error('已有记忆默认不应勾选');
    await h.typeId('editor-rest', '61');
    await h.saveEditor();
    // 未勾选：新建的另一实例仍使用旧记忆（不是 61）
    await h.openAddPicker(); await h.pickCustom('模板更新动作'); await sleep(300);
    s = await h.session();
    const copies = s.exercises.filter((e) => e.name === '模板更新动作');
    if (copies.length !== 2) throw new Error('未勾选添加未直接复用记忆');
    const untouched = copies.find((e) => e.id !== first.id);
    if (untouched.restSec !== 120) throw new Error('未勾选却更新了记忆: ' + untouched.restSec);
    // 勾选：真实点击 checkbox 后保存，下一实例应使用 62
    await h.openEditorBySwipe(first.id);
    const wasChecked = await h.checkedOf('editor-remember');
    await h.clickId('editor-remember');
    await h.page.waitForFunction(([id, before]) => {
      const el = document.querySelector('[data-testid="' + id + '"]');
      return el && el.checked !== before;
    }, {}, ['editor-remember', wasChecked]);
    if (!(await h.checkedOf('editor-remember'))) throw new Error('真实点击 checkbox 后未 checked');
    await h.typeId('editor-rest', '62');
    await h.saveEditor();
    await h.openAddPicker(); await h.pickCustom('模板更新动作'); await sleep(300);
    s = await h.session();
    const third = s.exercises.filter((e) => e.name === '模板更新动作').find((e) => e.id !== first.id && e.id !== untouched.id);
    if (!third || third.restSec !== 62) throw new Error('勾选后新实例未使用更新记忆: ' + (third && third.restSec));
  });

  await runCase('目标3轮但当前结构4轮：编辑器按4轮显示并保留结构', 'real-mouse', async (h) => {
    await h.openEditorBySwipe('root-four');
    const rounds = await h.valueOf('editor-rounds');
    if (rounds !== '4') throw new Error('编辑器未按实际4轮显示: ' + rounds);
    await h.saveEditor();
    const s = await h.session();
    const ex = s.exercises.find((e) => e.id === 'root-four');
    if (ex.target.rounds !== 4) throw new Error('保存后目标轮数不是当前结构: ' + ex.target.rounds);
    if (ex.groups.length !== 4) throw new Error('保存后组结构丢失');
  });

  await runCase('3组已做2组，记录页删第3空组后 groups2/target3/actual不变', 'real-mouse', async (h) => {
    const before = await h.session();
    const ex0 = before.exercises.find((e) => e.id === 'root-three');
    await h.clickSelector(h.sel('exercise-card-root-three') + ' button[aria-expanded]');
    await h.clickSelector(h.sel('exercise-card-root-three') + ' button[aria-label="删除第 3 组"]');
    await h.page.waitForFunction(() => window.__db.getSession('g2a-existing-session').then((s) => s.exercises.find((e) => e.id === 'root-three').sets.length === 2));
    const after = await h.session();
    const ex = after.exercises.find((e) => e.id === 'root-three');
    if (ex.groups.length !== 2) throw new Error('groups 未变 2: ' + ex.groups.length);
    if (ex.target.sets !== 3) throw new Error('原计划目标快照被改写: ' + ex.target.sets);
    if (JSON.stringify(ex.sets) !== JSON.stringify(ex0.sets.slice(0, 2))) throw new Error('前2组 actual/set 改变');
  });

  await runCase('快速输入 7. 后切形式被阻止并保留 raw', 'real-mouse+keyboard', async (h) => {
    await h.navigate('g2b-identity-session');
    await h.openEditorBySwipe('identity-ex');
    await h.clickId('group-0-reps-min');
    await h.page.keyboard.down('Meta'); await h.page.keyboard.press('KeyA'); await h.page.keyboard.up('Meta'); await h.page.keyboard.press('Backspace');
    await h.page.keyboard.type('7.');
    await h.clickId('editor-form-superset');
    await sleep(100);
    const stillStraight = await h.page.$eval(h.sel('editor-form-straight'), (e) => e.getAttribute('aria-pressed'));
    if (stillStraight !== 'true') throw new Error('非法 raw 时仍切换了形式');
    const body = await h.bodyText();
    if (!body.includes('未完成') && !body.includes('不合法')) throw new Error('切形式未给出错误提示');
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG2B-FIX2 APP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
