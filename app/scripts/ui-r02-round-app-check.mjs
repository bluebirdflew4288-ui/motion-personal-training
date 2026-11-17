#!/usr/bin/env node
/* R02 真实 App + 独立 IndexedDB：
   用户实际序列：2 阶段动作完成前两轮 → 点击“+ 加一轮” → 点击“未完成轮沿用上一完整轮”
   → 逐阶段正确填、已填不被覆盖、重新加载仍正确。
   另：3/2 轮变量配置在训练卡可见、编辑器改第 2 轮只改目标轮、普通组回归。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_R02_APP_EVIDENCE_DIR
  ? resolve(process.env.MOTION_R02_APP_EVIDENCE_DIR, 'r02-round-app')
  : resolve(APP_DIR, '../_evidence-r02-app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id) => `[data-testid="${id}"]`;

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, listPlans, getSession } from './src/db/repo';
import { createSession } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';

async function boot() {
  await ensureSeed();
  const existing = await getSession('r02-session');
  if (!existing) {
  const plan = (await listPlans())[0];
  const session = createSession(plan, plan.days[0]);
  session.id = 'r02-session';
  const base = session.exercises[0];
  const stage = (id, label) => ({ id, label, weightKg: null, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' });
  const uniform = {
    ...structuredClone(base), id: 'r02-add', exerciseId: 'custom:r02-add', planExerciseId: null,
    name: 'R02 加轮示例', restSec: 60,
    target: { kind: 'dropSet', form: 'superset', rounds: 2, stages: [stage('a','阶段A'), stage('b','阶段B')], restInSec: 15, restAfterSec: 90, weightMode: 'external' },
    groups: [{ index: 1, stageCount: 2 }, { index: 2, stageCount: 2 }],
    sets: [1,2].flatMap((r) => [1,2].map((s) => ({ id: 'add-r'+r+'s'+s, roundIndex: r, stageIndex: s, stageId: s === 1 ? 'a' : 'b', reps: null, weightKg: null, status: 'blank' }))),
  };
  for (const s of [1,2]) {
    const x = uniform.sets.find((v) => v.roundIndex === 1 && v.stageIndex === s); x.reps = 10 + s; x.weightKg = 20 - s * 2; x.status = 'done';
    const y = uniform.sets.find((v) => v.roundIndex === 2 && v.stageIndex === s); y.reps = 20 + s; y.weightKg = 30 - s * 2; y.status = 'done';
  }
  // 另一个同结构动作：第 1 轮完成，第 2 轮阶段1 预填 99（沿用必须保留、只补空白）
  const fill = structuredClone(uniform);
  fill.id = 'r02-fill'; fill.exerciseId = 'custom:r02-fill'; fill.name = 'R02 已填保留示例';
  fill.sets = fill.sets.map((x) => x.roundIndex === 2 ? { ...x, reps: null, weightKg: null, status: 'blank' } : x);
  const pre = fill.sets.find((v) => v.roundIndex === 2 && v.stageIndex === 1); pre.reps = 99;
  const variable = {
    ...structuredClone(base), id: 'r02-var', exerciseId: 'custom:r02-var', planExerciseId: null,
    name: 'R02 三二轮示例', restSec: 60,
    target: { kind: 'dropSet', form: 'superset', rounds: 2, stages: [stage('a','阶段A'), stage('b','阶段B'), stage('c','阶段C')], roundConfigs: [{ roundIndex: 2, stages: [stage('a2','阶段A2'), stage('b2','阶段B2')] }], restInSec: 15, restAfterSec: 90, weightMode: 'external' },
    groups: [{ index: 1, stageCount: 3 }, { index: 2, stageCount: 2 }],
    sets: [1,2,3].map((s) => ({ id: 'var-r1s'+s, roundIndex: 1, stageIndex: s, stageId: ['a','b','c'][s-1], reps: 10, weightKg: 10, status: 'done' })).concat([1,2].map((s) => ({ id: 'var-r2s'+s, roundIndex: 2, stageIndex: s, stageId: s === 1 ? 'a2' : 'b2', reps: null, weightKg: null, status: 'blank' }))),
  };
  const straight = {
    ...structuredClone(base), id: 'r02-straight', exerciseId: 'custom:r02-straight', planExerciseId: null,
    name: 'R02 普通组', restSec: 60,
    target: { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: null },
    groups: [1,2,3].map((i) => ({ index: i, stageCount: 1 })),
    sets: [1,2,3].map((s) => ({ id: 'str-s'+s, roundIndex: s, stageIndex: 1, reps: null, weightKg: null, status: 'blank' })),
  };
  const bodyweight = {
    ...structuredClone(base), id: 'r02-bw', exerciseId: 'synthetic-dip', planExerciseId: null,
    name: '双杠臂屈伸', restSec: 90,
    target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'bodyweight', suggestedWeightKg: null },
    groups: [1,2].map((i) => ({ index: i, stageCount: 1 })),
    sets: [1,2].map((s) => ({ id: 'bw-s'+s, roundIndex: s, stageIndex: 1, reps: s === 1 ? 10 : null, weightKg: null, status: s === 1 ? 'done' : 'blank' })),
  };
  session.exercises = [uniform, variable, straight, bodyweight, fill];
  session.cardio = [];
  const created = await atomicCreateSession({ session });
  if (!created.ok) throw new Error('seed failed');
  }
  window.__db = { getSession };
  window.__read = async (id) => {
    const s = await getSession('r02-session');
    if (!s) return null;
    const e = s.exercises.find((x) => x.id === id);
    return e ? { name: e.name, groups: e.groups, sets: e.sets.map((x) => ({ id: x.id, roundIndex: x.roundIndex, stageIndex: x.stageIndex, stageId: x.stageId ?? null, reps: x.reps, weightKg: x.weightKg, status: x.status, note: x.note ?? null })), target: e.target } : null;
  };
  createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))));
  navigate('/session/r02-session', true);
  window.__booted = true;
}
boot().catch((err) => { window.__bootError = String(err); });
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: APP_DIR, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __AUDIT_STRICT__: 'false', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: '"web"' },
    nodePaths: [join(APP_DIR, 'node_modules')], logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = req.url.split('?')[0];
    if (url === '/app.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (url.startsWith('/fonts/')) { try { res.setHeader('Content-Type', 'font/woff2'); res.end(await readFile(join(APP_DIR, 'public', url))); } catch { res.statusCode = 404; res.end(); } }
    else if (url === '/audio/delete-success.wav') { try { res.setHeader('Content-Type', 'audio/wav'); res.end(await readFile(join(APP_DIR, 'public/audio/delete-success.wav'))); } catch { res.statusCode = 404; res.end(); } }
    else { res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(OUT, 'chrome-profile'), args: ['--no-first-run', '--disable-extensions', '--no-sandbox'] });
  const result = { suite: 'r02-round-app', browser: await browser.version(), cases: [], errors: [] };
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => result.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') result.errors.push('console: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(base);
  await page.waitForFunction(() => window.__booted || window.__bootError, { timeout: 10000 });
  await page.waitForSelector('[data-testid^="exercise-card-"]', { timeout: 8000 });
  const be = await page.evaluate(() => window.__bootError); if (be) throw new Error(be);

  const clickText = async (rootTestId, text) => {
    const ok = await page.evaluate((rootTestId, text) => {
      const root = document.querySelector(`[data-testid="${rootTestId}"]`);
      if (!root) return false;
      const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
      if (!b) return false; b.click(); return true;
    }, rootTestId, text);
    if (!ok) {
      const info = await page.evaluate((rootTestId) => {
        const root = document.querySelector(`[data-testid="${rootTestId}"]`);
        return { exists: Boolean(root), text: root ? root.innerText.slice(0, 500) : '', buttons: root ? [...root.querySelectorAll('button')].map((b) => b.textContent.trim()) : [], body: document.body.innerText.slice(0, 300) };
      }, rootTestId);
      throw new Error(`找不到按钮「${text}」于 ${rootTestId}: ${JSON.stringify(info)}`);
    }
    await sleep(120);
  };
  const check = async (name, fn) => {
    try { await fn(); result.cases.push({ name, ok: true }); console.log('  ✔ ' + name); }
    catch (e) { result.cases.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); console.log('  ✘ ' + name + ' :: ' + (e instanceof Error ? e.message : String(e))); }
  };
  const read = (id) => page.evaluate((id) => window.__read(id), id);

  await check('2 阶段动作：完成前两轮后 + 加一轮，新轮继承 2 阶段与 stageId，运行态全空白', async () => {
    if (await page.$(`[data-testid="exercise-card-r02-add"] button[aria-expanded="false"]`)) await clickText('exercise-card-r02-add', '记录');
    await clickText('exercise-card-r02-add', '+ 加一轮');
    const e = await read('r02-add');
    if (!e) throw new Error('读不到动作');
    if (JSON.stringify(e.groups.map((g) => g.stageCount)) !== JSON.stringify([2,2,2])) throw new Error('groups 错误: ' + JSON.stringify(e.groups));
    const r3 = e.sets.filter((s) => s.roundIndex === 3);
    if (r3.length !== 2) throw new Error('第三轮行数 ' + r3.length);
    if (r3.map((s) => s.stageId).join(',') !== 'a,b') throw new Error('stageId 丢失: ' + JSON.stringify(r3));
    if (!r3.every((s) => s.reps === null && s.weightKg === null && s.status === 'blank')) throw new Error('新轮复制了运行态: ' + JSON.stringify(r3));
    if (new Set(r3.map((s) => s.id)).size !== 2) throw new Error('set.id 重复');
  });

  await check('完成前两轮后加第三轮：沿用取紧邻的完整第 2 轮，逐阶段正确填且状态仍 blank', async () => {
    await clickText('exercise-card-r02-add', '未完成轮沿用上一完整轮');
    const e = await read('r02-add');
    const r3 = e.sets.filter((s) => s.roundIndex === 3).sort((a,b)=>a.stageIndex-b.stageIndex);
    if (r3[0].reps !== 21 || r3[0].weightKg !== 28) throw new Error('第3轮阶段1未取第2轮: ' + JSON.stringify(r3[0]));
    if (r3[1].reps !== 22 || r3[1].weightKg !== 26) throw new Error('第3轮阶段2未取第2轮: ' + JSON.stringify(r3[1]));
    if (!r3.every((s) => s.status === 'blank')) throw new Error('沿用后错误标记完成');
  });

  await check('已填不覆盖：第 2 轮阶段1 保留 99，只补空白字段', async () => {
    if (await page.$(`[data-testid="exercise-card-r02-fill"] button[aria-expanded="false"]`)) await clickText('exercise-card-r02-fill', '记录');
    await clickText('exercise-card-r02-fill', '+ 加一轮');
    await clickText('exercise-card-r02-fill', '未完成轮沿用上一完整轮');
    const e = await read('r02-fill');
    const r2 = e.sets.filter((s) => s.roundIndex === 2).sort((a,b)=>a.stageIndex-b.stageIndex);
    const r3 = e.sets.filter((s) => s.roundIndex === 3).sort((a,b)=>a.stageIndex-b.stageIndex);
    if (r2[0].reps !== 99) throw new Error('已填 99 被覆盖: ' + r2[0].reps);
    if (r2[0].weightKg !== 18) throw new Error('第2轮阶段1重量未补: ' + r2[0].weightKg);
    if (r2[1].reps !== 12 || r2[1].weightKg !== 16) throw new Error('第2轮阶段2补值错误: ' + JSON.stringify(r2[1]));
    if (r3[0].reps !== 11 || r3[0].weightKg !== 18) throw new Error('第3轮阶段1补值错误: ' + JSON.stringify(r3[0]));
  });

  await check('重新加载后读回：前两轮已完成值、第三轮沿用值仍在', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted || window.__bootError, { timeout: 10000 });
    const be2 = await page.evaluate(() => window.__bootError); if (be2) throw new Error('reload boot: ' + be2);
    const e = await read('r02-add');
    if (e.groups.length !== 3) throw new Error('重载后轮数丢失');
    const r3 = e.sets.filter((s) => s.roundIndex === 3).sort((a,b)=>a.stageIndex-b.stageIndex);
    if (r3[0].reps !== 21 || r3[1].reps !== 22) throw new Error('重载后沿用值丢失');
  });

  await check('3/2 轮变量配置：训练卡显示逐轮真实阶段数', async () => {
    if (await page.$(`[data-testid="exercise-card-r02-var"] button[aria-expanded="false"]`)) await clickText('exercise-card-r02-var', '记录');
    const body = await page.$eval(sel('exercise-card-r02-var'), (el) => el.innerText);
    if (!body.includes('第 1 轮（3 阶段）') || !body.includes('第 2 轮（2 阶段）')) throw new Error('卡片未显示逐轮阶段数: ' + body.slice(0, 400));
  });

  await check('编辑器改第 2 轮：只写 roundConfigs[2]，第 1 轮配置与两轮 actual 不变；保存后 IDB 读回', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="exercise-card-r02-var-edit"]').click());
    await page.waitForSelector(sel('exercise-editor'), { timeout: 3000 });
    await page.click(sel('round-tab-2'));
    const fill = async (id, text) => { await page.$eval(sel(id), (el) => { el.focus(); el.select(); }); await page.keyboard.type(text); };
    await fill('stage-r2-0-reps-min', '7'); await fill('stage-r2-0-reps-max', '9');
    await page.evaluate(() => document.querySelector('[data-testid="editor-save"]').click());
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 4000 });
    const e = await read('r02-var');
    const t = e.target;
    if (t.kind !== 'dropSet') throw new Error('target 类型错误');
    if (t.stages.length !== 3 || t.stages[0].id !== 'a') throw new Error('第 1 轮默认被改写');
    if (!t.roundConfigs || t.roundConfigs.length !== 1 || t.roundConfigs[0].roundIndex !== 2) throw new Error('roundConfigs 错误');
    if (t.roundConfigs[0].stages[0].repsMin !== 7 || t.roundConfigs[0].stages[0].repsMax !== 9) throw new Error('第 2 轮修改未保存');
    const r1 = e.sets.filter((s) => s.roundIndex === 1);
    if (r1.length !== 3 || !r1.every((s) => s.reps === 10 && s.status === 'done')) throw new Error('第 1 轮 actual 被改');
  });

  await check('普通组回归：+ 加一组仍是 1 阶段，不产生多阶段结构', async () => {
    if (await page.$(`[data-testid="exercise-card-r02-straight"] button[aria-expanded="false"]`)) await clickText('exercise-card-r02-straight', '记录');
    await clickText('exercise-card-r02-straight', '+ 加一组');
    const e = await read('r02-straight');
    if (e.groups.length !== 4 || !e.groups.every((g) => g.stageCount === 1)) throw new Error('普通组结构错误: ' + JSON.stringify(e.groups));
    const last = e.sets.filter((s) => s.roundIndex === 4);
    if (last.length !== 1 || last[0].status !== 'blank') throw new Error('普通组新增行错误');
  });

  await check('删除已有记录的轮：取消完整保留；确认只删目标轮', async () => {
    if (await page.$(`[data-testid="exercise-card-r02-add"] button[aria-expanded="false"]`)) await clickText('exercise-card-r02-add', '记录');
    await clickText('exercise-card-r02-add', '− 删一轮');
    await page.waitForSelector(sel('confirm-ok'), { timeout: 3000 });
    const bodyText = await page.$eval(sel('confirm-ok'), () => document.body.innerText);
    if (!bodyText.includes('删除这一轮')) throw new Error('缺少删除确认: ' + bodyText);
    await page.click(sel('confirm-cancel'));
    await sleep(120);
    let e = await read('r02-add');
    if (e.groups.length !== 3) throw new Error('取消后轮数被改: ' + e.groups.length);
    await clickText('exercise-card-r02-add', '− 删一轮');
    await page.waitForSelector(sel('confirm-ok'), { timeout: 3000 });
    await page.click(sel('confirm-ok'));
    await sleep(200);
    e = await read('r02-add');
    if (e.groups.length !== 2) throw new Error('确认后目标轮未删除: ' + e.groups.length);
    const r1 = e.sets.filter((s) => s.roundIndex === 1);
    if (r1.length !== 2 || r1[0].reps !== 11) throw new Error('删除误伤第 1 轮 actual');
  });

  await check('W02 真实 App：自重双杠改名为绳索夹胸并填 25kg（无四模式选择），IDB 自动跟随 external 且 actual 保留', async () => {
    const editBtn = '[data-testid="exercise-card-r02-bw-edit"]';
    await page.waitForSelector(editBtn, { timeout: 3000 });
    await page.evaluate((s) => document.querySelector(s).click(), editBtn);
    await page.waitForSelector(sel('exercise-editor'), { timeout: 4000 });
    const modeBtns = await page.$$('[data-testid^="editor-weight-mode-"]');
    if (modeBtns.length !== 0) throw new Error('编辑器仍存在四模式按钮: ' + modeBtns.length);
    const fill = async (id, text) => { await page.$eval(sel(id), (el) => { el.focus(); el.select(); }); await page.keyboard.type(text); };
    await page.click(sel('editor-name-button'));
    await page.waitForSelector(sel('name-custom-input'));
    await fill('name-custom-input', '下斜绳索夹胸');
    await page.click(sel('name-custom-apply'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
    await fill('group-0-weight', '25');
    await page.evaluate(() => document.querySelector('[data-testid="editor-save"]').click());
    // 已有记录切换身份/重量口径必须先确认（不能静默重新解释）
    await page.waitForSelector(sel('confirm-ok'), { timeout: 4000 });
    const confirmText = await page.evaluate(() => document.body.innerText);
    if (!confirmText.includes('重量口径') && !confirmText.includes('真实动作身份')) {
      throw new Error('影响确认未提示影响: ' + confirmText);
    }
    await page.click(sel('confirm-ok'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 5000 });
    const e = await read('r02-bw');
    if (e.name !== '下斜绳索夹胸') throw new Error('名称未保存: ' + e.name);
    if (e.target.kind !== 'straight' || e.target.weightMode !== 'external') throw new Error('weightMode 未保存: ' + JSON.stringify(e.target));
    if (e.target.perSetConfigs?.[0]?.suggestedWeightKg !== 25) throw new Error('25kg 未保存');
    const r1 = e.sets.find((s) => s.roundIndex === 1);
    if (r1.reps !== 10 || r1.status !== 'done') throw new Error('已有 actual 被改: ' + JSON.stringify(r1));
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close(); await new Promise((r) => server.close(r));
  console.log(`R02 APP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
