#!/usr/bin/env node
/* R01 真实 Chrome + 真实 IndexedDB 行为验证：
   多阶段（超级组/递减组）动作工具栏的「未完成轮沿用上一完整轮」。
   ── 这份脚本证明什么、不证明什么 ─────────────────────────────
   证明：在真实浏览器 + 真实 IndexedDB 下，
     · 超级组：前一轮三阶段各值不同 → 点按钮后未完成轮**逐阶段对应**沿用，
       不把最后一阶段套到全部阶段；补值轮 status 仍是 blank（不自动完成）；
     · 递减组：只补空白字段、保留已填（部分已填次数 99 保留）、0 是有效值、
       来源重量 null 不被凭空补；跳过轮不被修改；
     · 按钮是**真实可点**的工具按钮：点击后数据落库（getSession 读回），
       且不会触发左滑删除手势（没有出现撤销条、卡片仍在）；
     · 点击不产生计时副作用（没有 [role=timer] 出现）。
   不证明：保存失败注入/整页重载后的端到端表现（由领域测试 + 既有持久化链路覆盖，
   本脚本只验证真实点击→落库读回）；也不证明任何原生/手机行为。

   用法：MOTION_UI_EVIDENCE_DIR=<绝对目录> node scripts/ui-r01-inherit-check.mjs
*/
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_UI_EVIDENCE_DIR
  ? resolve(process.env.MOTION_UI_EVIDENCE_DIR, 'r01-inherit')
  : resolve(APP_DIR, '../_evidence-r01');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id) => `[data-testid="${id}"]`;

/** 真实 App 入口：3 轮 × 3 阶段的多阶段动作（超级组 + 递减组），隔离 IndexedDB。 */
const r01Entry = `
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
  const plans = await listPlans();
  const plan = plans[0];
  const day = plan.days[0];
  const session = createSession(plan, day);
  session.id = 'r01-session';
  const base = session.exercises[0];
  const stageTarget = (form) => ({
    kind: 'dropSet', form, rounds: 3, restInSec: 30, restAfterSec: 90, weightMode: 'external',
    stages: [1,2,3].map((n) => ({ id: 'st' + n, label: '阶段' + n, weightKg: null, repsMin: 8, repsMax: 10, toFailure: false, targetText: '' })),
  });
  const dropEx = (id, name, form) => ({
    ...structuredClone(base),
    id, name, exerciseId: 'custom:' + id, planExerciseId: null, restSec: 60,
    target: stageTarget(form),
    groups: [1,2,3].map((i) => ({ index: i, stageCount: 3 })),
    sets: [1,2,3].flatMap((r) => [1,2,3].map((s) => ({ id: id + '-r' + r + 's' + s, roundIndex: r, stageIndex: s, stageId: 'st' + s, reps: null, weightKg: null, status: 'blank' }))),
  });
  const superEx = dropEx('r01-super', '超级组示例', 'superset');
  const dropOnly = dropEx('r01-drop', '递减组示例', 'dropSet');
  const doneEx = dropEx('r01-done', '已完成阶段示例', 'dropSet');
  const setv = (ex, r, s, reps, w, status) => { const t = ex.sets.find((x) => x.roundIndex === r && x.stageIndex === s); t.reps = reps; t.weightKg = w; t.status = status; };
  // 超级组：第 1 轮三阶段各值不同、已完成；第 2/3 轮空白
  setv(superEx, 1, 1, 10, 20, 'done'); setv(superEx, 1, 2, 12, 15, 'done'); setv(superEx, 1, 3, 15, 10, 'done');
  // 递减组：第 1 轮完成（阶段1 重量 0、阶段2 重量 null、阶段3 次数 0）；第 2 轮阶段1 已填次数 99；第 3 轮跳过
  setv(dropOnly, 1, 1, 8, 0, 'done'); setv(dropOnly, 1, 2, 12, null, 'done'); setv(dropOnly, 1, 3, 0, 30, 'done');
  setv(dropOnly, 2, 1, 99, null, 'blank');
  dropOnly.groups = dropOnly.groups.map((g) => (g.index === 3 ? { ...g, skipped: true } : g));
  // 已完成阶段示例：第 1 轮完成；第 2 轮 stage2 已 done(reps=4) 但 weight=null（不得被补）
  setv(doneEx, 1, 1, 10, 20, 'done'); setv(doneEx, 1, 2, 11, 21, 'done'); setv(doneEx, 1, 3, 12, 22, 'done');
  setv(doneEx, 2, 2, 4, null, 'done');
  session.exercises = [superEx, dropOnly, doneEx];
  session.cardio = [];
  const created = await atomicCreateSession({ session });
  if (!created.ok) throw new Error('seed failed');
  window.__db = { getSession };
  window.__r01 = {
    read: async (id) => {
      const s = await getSession(id);
      return s.exercises.map((e) => ({
        id: e.id,
        form: e.target.kind === 'dropSet' ? e.target.form : e.target.kind,
        groups: e.groups,
        sets: e.sets.map((x) => ({ id: x.id, roundIndex: x.roundIndex, stageIndex: x.stageIndex, reps: x.reps, weightKg: x.weightKg, status: x.status })),
      }));
    },
  };
  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  navigate('/session/' + session.id, true);
  window.__booted = true;
}
boot().catch((err) => { window.__bootError = String(err); });
`;

function buildEntry() {
  return r01Entry;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: buildEntry(), resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': '"production"',
      __AUDIT_STRICT__: 'false',
      __MOTION_NATIVE__: 'false',
      __MOTION_BUILD_TARGET__: '"web"',
    },
    nodePaths: [join(APP_DIR, 'node_modules')],
    logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const url = req.url.split('?')[0];
    if (url === '/app.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(js);
    } else if (url === '/style.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(css);
    } else if (url.startsWith('/fonts/')) {
      try { res.setHeader('Content-Type', 'font/woff2'); res.end(await readFile(join(APP_DIR, 'public', url))); }
      catch { res.statusCode = 404; res.end(); }
    } else if (url === '/audio/delete-success.wav') {
      try { res.setHeader('Content-Type', 'audio/wav'); res.end(await readFile(join(APP_DIR, 'public/audio/delete-success.wav'))); }
      catch { res.statusCode = 404; res.end(); }
    } else {
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(OUT, 'chrome-profile'),
    args: ['--no-first-run', '--disable-extensions', '--no-sandbox'],
  });

  const results = { suite: 'r01-inherit-prev-round', browser: await browser.version(), cases: [], scope: '真实 App+IDB 点击→落库；不证明保存失败注入/重载与原生行为' };

  async function newPage() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewport({ width: 390, height: 820, isMobile: true, hasTouch: true });
    await page.goto(base);
    await page.waitForFunction(() => window.__booted || window.__bootError, { timeout: 8000 });
    const bootError = await page.evaluate(() => window.__bootError);
    if (bootError) throw new Error(bootError);
    return { ctx, page, errors };
  }

  async function clickByText(page, rootTestId, text) {
    const ok = await page.evaluate((rootTestId, text) => {
      const root = document.querySelector(`[data-testid="${rootTestId}"]`);
      if (!root) return false;
      const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim() === text);
      if (!b) return false;
      b.click();
      return true;
    }, rootTestId, text);
    if (!ok) throw new Error(`找不到按钮「${text}」于 ${rootTestId}`);
  }

  async function hasButton(page, rootTestId, text) {
    return page.evaluate((rootTestId, text) => {
      const root = document.querySelector(`[data-testid="${rootTestId}"]`);
      if (!root) return false;
      return [...root.querySelectorAll('button')].some((b) => b.textContent.trim() === text);
    }, rootTestId, text);
  }

  /** 确保动作卡展开（首张卡可能默认展开，此时按钮是「收起」） */
  async function ensureExpanded(page, rootTestId) {
    if (await hasButton(page, rootTestId, '未完成轮沿用上一完整轮')) return;
    await clickByText(page, rootTestId, '记录');
    // 轮询等待真实渲染出沿用按钮（不盲加固定 sleep）
    const ok = await page
      .waitForFunction(
        (rootTestId) => {
          const root = document.querySelector(`[data-testid="${rootTestId}"]`);
          if (!root) return false;
          return [...root.querySelectorAll('button')].some(
            (b) => b.textContent.trim() === '未完成轮沿用上一完整轮',
          );
        },
        { timeout: 4000 },
        rootTestId,
      )
      .then(() => true)
      .catch(() => false);
    if (!ok) throw new Error('展开后仍找不到「未完成轮沿用上一完整轮」按钮');
  }

  async function readEx(page, exId) {
    return page.evaluate(async (exId) => {
      const list = await window.__r01.read('r01-session');
      return list.find((e) => e.id === exId) || null;
    }, exId);
  }

  function setOf(ex, round, stage) {
    return ex.sets.find((s) => s.roundIndex === round && s.stageIndex === stage);
  }

  /** 轮询等待落库后的条件成立（真实保存是异步的） */
  async function waitForDb(page, exId, predicateDesc, predicate, timeout = 6000) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      const ex = await readEx(page, exId);
      last = ex;
      if (ex && predicate(ex)) return ex;
      await sleep(150);
    }
    throw new Error(`等待落库超时（${predicateDesc}）：${JSON.stringify(last)}`);
  }

  /* ── 场景 1：超级组 ── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'R01-super-per-stage-inherit', errors, ok: false };
    try {
      record.hasEntryBeforeClick = await page.$eval(
        sel('exercise-card-r01-super'),
        (root) => !!root,
      );
      // 展开卡片显示工具栏（首张可能默认已展开）
      await ensureExpanded(page, 'exercise-card-r01-super');
      // 计时副作用基线：点击前不应有正在运行的计时条
      record.timerBefore = await page.evaluate(() => !!document.querySelector('[role="timer"]'));
      // 真实点击「未完成轮沿用上一完整轮」
      await clickByText(page, 'exercise-card-r01-super', '未完成轮沿用上一完整轮');
      // 等待落库：第 2 轮阶段1 次数应变为 10
      const ex = await waitForDb(page, 'r01-super', '第2轮阶段1次数=10', (e) => setOf(e, 2, 1).reps === 10);
      record.after = ex.sets.filter((s) => s.roundIndex === 2 || s.roundIndex === 3);
      // 逐阶段对应（不是最后一阶段套全部）
      record.perStageOk =
        setOf(ex, 2, 1).reps === 10 && setOf(ex, 2, 1).weightKg === 20 &&
        setOf(ex, 2, 2).reps === 12 && setOf(ex, 2, 2).weightKg === 15 &&
        setOf(ex, 2, 3).reps === 15 && setOf(ex, 2, 3).weightKg === 10;
      // 第 3 轮同样来自第 1 轮（第 2 轮仍 blank 未完成）
      record.round3Ok =
        setOf(ex, 3, 1).reps === 10 && setOf(ex, 3, 2).reps === 12 && setOf(ex, 3, 3).reps === 15;
      // 补值轮 status 仍 blank
      record.statusBlank = [2, 3].every((r) => [1, 2, 3].every((s) => setOf(ex, r, s).status === 'blank'));
      // 第 1 轮未被改动
      record.round1Untouched =
        setOf(ex, 1, 1).reps === 10 && setOf(ex, 1, 1).status === 'done';
      // 无计时副作用 + 无删除手势（没有撤销条，卡片仍在）
      record.timerAfter = await page.evaluate(() => !!document.querySelector('[role="timer"]'));
      record.hasUndo = await page.evaluate(() => !!document.querySelector('[data-testid="delete-undo-stack"]'));
      record.cardStillThere = await page.evaluate(() => !!document.querySelector('[data-testid="exercise-card-r01-super"]'));
      record.ok =
        record.perStageOk && record.round3Ok && record.statusBlank && record.round1Untouched &&
        record.timerBefore === false && record.timerAfter === false &&
        record.hasUndo === false && record.cardStillThere === true && errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── 场景 2：递减组（只补空白 / 保留已填 / 0 有效 / 来源 null 不补 / 跳过轮不改）── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'R01-drop-blank-only-and-guards', errors, ok: false };
    try {
      await ensureExpanded(page, 'exercise-card-r01-drop');
      record.timerBefore = await page.evaluate(() => !!document.querySelector('[role="timer"]'));
      await clickByText(page, 'exercise-card-r01-drop', '未完成轮沿用上一完整轮');
      // 等待落库：第 2 轮阶段3 次数应变为 0
      const ex = await waitForDb(page, 'r01-drop', '第2轮阶段3次数=0', (e) => setOf(e, 2, 3).reps === 0);
      record.round2 = ex.sets.filter((s) => s.roundIndex === 2);
      // 阶段1：已填次数 99 保留；重量 null → 0（0 有效）
      record.partialPreserved = setOf(ex, 2, 1).reps === 99 && setOf(ex, 2, 1).weightKg === 0;
      // 阶段2：次数 null → 12；来源重量 null → 保持 null（不凭空补）
      record.nullWeightNotFaked = setOf(ex, 2, 2).reps === 12 && setOf(ex, 2, 2).weightKg === null;
      // 阶段3：次数 null → 0（0 有效）；重量 null → 30
      record.zeroIsValue = setOf(ex, 2, 3).reps === 0 && setOf(ex, 2, 3).weightKg === 30;
      // 跳过轮（第 3 轮）不被修改
      record.skippedUntouched = [1, 2, 3].every((s) => setOf(ex, 3, s).reps === null && setOf(ex, 3, s).weightKg === null);
      record.statusBlank = [1, 2, 3].every((s) => setOf(ex, 2, s).status === 'blank');
      record.timerAfter = await page.evaluate(() => !!document.querySelector('[role="timer"]'));
      record.hasUndo = await page.evaluate(() => !!document.querySelector('[data-testid="delete-undo-stack"]'));
      record.ok =
        record.partialPreserved && record.nullWeightNotFaked && record.zeroIsValue &&
        record.skippedUntouched && record.statusBlank &&
        record.timerBefore === false && record.timerAfter === false &&
        record.hasUndo === false && errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── 场景 3：已完成(done)阶段整条不动（done 阶段 null weight 不补）── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'R01-done-stage-not-touched', errors, ok: false };
    try {
      await ensureExpanded(page, 'exercise-card-r01-done');
      await clickByText(page, 'exercise-card-r01-done', '未完成轮沿用上一完整轮');
      const ex = await waitForDb(page, 'r01-done', '第2轮阶段1次数=10', (e) => setOf(e, 2, 1).reps === 10);
      record.doneStage = setOf(ex, 2, 2);
      record.doneStageUntouched =
        setOf(ex, 2, 2).reps === 4 && setOf(ex, 2, 2).weightKg === null && setOf(ex, 2, 2).status === 'done';
      record.stage1Filled = setOf(ex, 2, 1).reps === 10 && setOf(ex, 2, 1).weightKg === 20;
      record.stage3Filled = setOf(ex, 2, 3).reps === 12 && setOf(ex, 2, 3).weightKg === 22;
      record.timerAfter = await page.evaluate(() => !!document.querySelector('[role="timer"]'));
      record.hasUndo = await page.evaluate(() => !!document.querySelector('[data-testid="delete-undo-stack"]'));
      record.ok =
        record.doneStageUntouched && record.stage1Filled && record.stage3Filled &&
        record.timerAfter === false && record.hasUndo === false && errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  await browser.close();
  server.close();
  const passed = results.cases.filter((c) => c.ok).length;
  results.summary = `${passed}/${results.cases.length}`;
  await writeFile(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  for (const c of results.cases) {
    console.log(`${c.ok ? '✔' : '✘'} ${c.case}${c.failure ? ` — ${c.failure}` : ''}`);
  }
  console.log(`\nR01 VERIFICATION: ${results.summary} passed.`);
  console.log(`证据：${OUT}`);
  if (passed !== results.cases.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
