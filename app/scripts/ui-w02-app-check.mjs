#!/usr/bin/env node
/* W02 真实全量 App + IndexedDB Chrome DOM 验收脚本：
   1. PlansPage / PlanDayEditor：
      - 普通组编辑器与 DropSetEditor 均无四模式选择器；
      - 旧 bodyweight 下哑铃口径仍可见可切换；
      - 普通组「建议重量」null 显示空白不显示 0，填 0 持久化为 0（不变成 null），清空恢复 null，且原 weightMode 不迁移；
      - DropSetEditor 阶段 weightKg=null 显示空白，填 0 持久化为 0，原 weightMode 保留；
      - nullable 重量 IME 组合中间空串按 Enter / flushAll 探针：17.5 → compositionstart → input("") → Enter 不得写入 null、flushAll 拒绝；compositionend 后明确清空再 blur 才写 null；
   2. SessionPage：
      - 旧 bodyweight 动作在训练中显示重量输入（无「自重动作 · 无需重量」），第 1 组填 0kg 完成、第 2 组空白完成保持 weightKg=null，随后第 2 组可改填 10kg 持久化；
      - 同身份编辑（assisted）保留原 weightMode='assisted'；
      - A(assisted)→B(普通) 已有 actual 触发影响确认，取消完整保留 A，确认后变为 B 且 weightMode='external'；
   3. HistoryPage & StatsPage：
      - 历史详情与统计页可见实际 0kg（× 0 kg / ×0 / 最高重量 0 kg），未填重量（null）不冒充 0；
      - 同名 assisted (70kg) 与 external (20kg) 在 Stats 页口径切换器隔离显示，不混算最高重量。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_UI_EVIDENCE_DIR
  ? resolve(process.env.MOTION_UI_EVIDENCE_DIR, 'w02-app')
  : resolve(APP_DIR, '../_evidence-w02-app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id) => `[data-testid="${id}"]`;

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, getPlan, getSession, listPlans, savePlan, saveSession } from './src/db/repo';
import { createSession } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { navigate } from './src/lib/router';
import { DraftNumberField } from './src/ui/DraftNumberField';
import { useDraftForm } from './src/ui/draftForm';

function NullableWeightImeProbe() {
  const form = useDraftForm();
  const [val, setVal] = useState(17.5);
  const [commits, setCommits] = useState([]);
  const [lastFlush, setLastFlush] = useState(null);
  return (
    <div data-testid="ime-probe" style={{ padding: 12 }}>
      <DraftNumberField
        label="探针重量"
        nullable
        placeholder="—"
        value={val}
        min={0}
        max={999}
        integer={false}
        unit="kg"
        form={form}
        fieldId="probe.weight"
        onCommit={(v) => {
          setCommits((c) => [...c, v]);
          setVal(v);
        }}
      />
      <button
        type="button"
        data-testid="probe-flush"
        onClick={() => {
          const r = form.flushAll();
          setLastFlush({ ok: r.ok, errors: r.errors, values: r.values, nullIds: [...(r.nullIds ?? [])] });
        }}
      >
        flush
      </button>
      <pre data-testid="probe-state">{JSON.stringify({ val, commits, lastFlush })}</pre>
    </div>
  );
}

async function boot() {
  if (new URLSearchParams(location.search).get('probe') === 'ime') {
    createRoot(document.getElementById('root')).render(React.createElement(NullableWeightImeProbe));
    window.__booted = true;
    return;
  }
  await ensureSeed();
  const plans = await listPlans();
  const plan = structuredClone(plans[0]);
  plan.id = 'w02-plan';
  const day = plan.days[0];
  day.id = 'w02-day';
  day.exercises = [
    {
      id: 'plan-bw',
      exerciseId: 'lib-hanging-leg-raise',
      name: '悬垂举腿',
      restSec: 60,
      target: {
        kind: 'straight',
        sets: 2,
        setsMax: 2,
        repsMin: 10,
        repsMax: 15,
        weightMode: 'bodyweight',
        suggestedWeightKg: null,
      },
    },
    {
      id: 'plan-drop',
      exerciseId: 'custom:w02-drop',
      name: 'W02 递减测试',
      restSec: 90,
      target: {
        kind: 'dropSet',
        rounds: 2,
        stages: [
          { id: 's1', label: '阶段1', weightKg: null, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
          { id: 's2', label: '阶段2', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
        ],
        restInSec: 15,
        restAfterSec: 90,
        weightMode: 'assisted',
      },
    },
  ];
  await savePlan(plan);

  const now = Date.now();
  const doneZero = createSession(plan, day, now - 300_000);
  doneZero.id = 'w02-hist-zero';
  doneZero.status = 'completed';
  doneZero.endedAt = now - 250_000;
  doneZero.exercises = [
    {
      ...doneZero.exercises[0],
      id: 'hz-ex',
      sets: [
        { id: 'hz-s1', roundIndex: 1, stageIndex: 1, reps: 12, weightKg: 0, status: 'done' },
        { id: 'hz-s2', roundIndex: 2, stageIndex: 1, reps: 10, weightKg: null, status: 'done' },
      ],
    },
  ];
  await saveSession(doneZero);

  const doneAss = createSession(plan, day, now - 200_000);
  doneAss.id = 'w02-hist-ass';
  doneAss.status = 'completed';
  doneAss.endedAt = now - 150_000;
  doneAss.exercises = [
    {
      id: 'ha-ex',
      exerciseId: 'lib-pull-up',
      planExerciseId: null,
      name: '正手宽握引体向上',
      restSec: 120,
      target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'assisted', suggestedWeightKg: 70 },
      status: 'done',
      groups: [{ index: 1, stageCount: 1 }],
      sets: [{ id: 'ha-s1', roundIndex: 1, stageIndex: 1, reps: 8, weightKg: 70, status: 'done' }],
      note: '',
    },
  ];
  await saveSession(doneAss);

  const doneExt = createSession(plan, day, now - 100_000);
  doneExt.id = 'w02-hist-ext';
  doneExt.status = 'completed';
  doneExt.endedAt = now - 50_000;
  doneExt.exercises = [
    {
      id: 'he-ex',
      exerciseId: 'lib-pull-up',
      planExerciseId: null,
      name: '正手宽握引体向上',
      restSec: 120,
      target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 20 },
      status: 'done',
      groups: [{ index: 1, stageCount: 1 }],
      sets: [{ id: 'he-s1', roundIndex: 1, stageIndex: 1, reps: 8, weightKg: 20, status: 'done' }],
      note: '',
    },
  ];
  await saveSession(doneExt);

  const active = createSession(plan, day, now);
  active.id = 'w02-active';
  active.exercises = [
    {
      id: 'act-bw',
      exerciseId: 'lib-hanging-leg-raise',
      planExerciseId: 'plan-bw',
      name: '悬垂举腿',
      restSec: 60,
      target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 10, repsMax: 15, weightMode: 'bodyweight', suggestedWeightKg: null },
      status: 'pending',
      groups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
      sets: [
        { id: 'act-bw-1', roundIndex: 1, stageIndex: 1, reps: null, weightKg: null, status: 'blank' },
        { id: 'act-bw-2', roundIndex: 2, stageIndex: 1, reps: 10, weightKg: null, status: 'blank' },
      ],
      note: '',
    },
    {
      id: 'act-ass',
      exerciseId: 'custom:辅助双杠',
      planExerciseId: null,
      name: '辅助双杠',
      restSec: 90,
      target: { kind: 'straight', sets: 1, setsMax: 1, repsMin: 8, repsMax: 12, weightMode: 'assisted', suggestedWeightKg: 40 },
      status: 'pending',
      groups: [{ index: 1, stageCount: 1 }],
      sets: [{ id: 'act-ass-1', roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 40, status: 'done' }],
      note: '',
    },
  ];
  const created = await atomicCreateSession({ session: active });
  if (!created.ok) throw new Error('seed active failed');

  window.__w02 = {
    getPlan: () => getPlan('w02-plan'),
    listPlans: () => listPlans(),
    getSession: (id) => getSession(id),
    go: (route) => navigate(route, true),
  };
  navigate('/plan/w02-plan/day/w02-day', true);
  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  window.__booted = true;
}
boot().catch((e) => { window.__bootError = String(e); });
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: '"web"' },
    logLevel: 'silent',
  });
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(built.outputFiles[0].contents);
    } else if (req.url.startsWith('/style.css')) {
      res.setHeader('Content-Type', 'text/css');
      res.end(css);
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-sandbox'] });
  const page = await browser.newPage();
  const result = { suite: 'w02-full-app', cases: [], errors: [], diagnostics: [] };
  page.on('pageerror', (e) => result.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') result.errors.push('console: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844 });

  let failIdx = 0;
  const check = async (name, fn) => {
    try {
      await fn();
      result.cases.push({ name, ok: true });
      console.log('  ✔ ' + name);
    } catch (err) {
      failIdx += 1;
      const detail = err instanceof Error ? err.message : String(err);
      let diag = null;
      try {
        diag = await page.evaluate(async () => ({
          hash: location.hash,
          bodyText: document.body.innerText.slice(0, 800),
          plans: window.__w02 ? (await window.__w02.listPlans()).map((p) => ({ id: p.id, days: p.days.map((d) => d.id) })) : null,
          w02Plan: window.__w02 ? Boolean(await window.__w02.getPlan()) : null,
        }));
        await page.screenshot({ path: join(OUT, `fail-${failIdx}.png`) });
      } catch {
        // ignore diag error
      }
      result.diagnostics.push({ failIdx, name, detail, diag });
      result.cases.push({ name, ok: false, detail });
      console.log('  ✘ ' + name + ' :: ' + detail);
    }
  };

  // 1. 先跑 nullable 重量 IME 中间空串 Enter / flushAll 真实 DOM 探针
  await page.goto(`${url}/?probe=ime`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__booted || window.__bootError, { timeout: 10000 });
  await check('IME 探针：nullable 重量 17.5 在 compositionstart→原生空串 input→按 Enter/flushAll 不写 null，compositionend 后明确清空才写 null', async () => {
    await page.waitForSelector('input[aria-label="探针重量"]', { timeout: 3000 });
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="探针重量"]');
      input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.keyboard.press('Enter');
    await sleep(60);
    const afterEnter = await page.evaluate(() => ({
      activeTag: document.activeElement?.getAttribute('aria-label') ?? null,
      state: JSON.parse(document.querySelector('[data-testid="probe-state"]').textContent),
    }));
    if (afterEnter.activeTag !== '探针重量') {
      throw new Error('IME 组合期按 Enter 意外 blur 丢失焦点/组合态: ' + JSON.stringify(afterEnter));
    }
    if (afterEnter.state.val !== 17.5 || afterEnter.state.commits.length !== 0) {
      throw new Error('IME 组合期按 Enter 误提交了 null/改写了原值: ' + JSON.stringify(afterEnter));
    }
    await page.$eval(sel('probe-flush'), (el) => el.click());
    await sleep(40);
    const duringIme = await page.evaluate(() => JSON.parse(document.querySelector('[data-testid="probe-state"]').textContent));
    if (duringIme.val !== 17.5 || duringIme.commits.length !== 0) {
      throw new Error('IME 组合期 flush 后误提交了 null: ' + JSON.stringify(duringIme));
    }
    if (!duringIme.lastFlush || duringIme.lastFlush.ok !== false) {
      throw new Error('IME 组合期 flushAll 未阻止保存中间空串: ' + JSON.stringify(duringIme.lastFlush));
    }

    // compositionend 后不清空仍保留（这里明确清空并 blur，应提交 null）
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="探针重量"]');
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    await sleep(60);
    const afterEnd = await page.evaluate(() => JSON.parse(document.querySelector('[data-testid="probe-state"]').textContent));
    if (afterEnd.val !== null || JSON.stringify(afterEnd.commits) !== '[null]') {
      throw new Error('compositionend 后明确清空并 blur 未提交 null: ' + JSON.stringify(afterEnd));
    }
  });

  // 2. 启动完整 App
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__booted || window.__bootError, { timeout: 10000 });
  const bootErr = await page.evaluate(() => window.__bootError || null);
  if (bootErr) throw new Error('boot failed: ' + bootErr);

  await check('Plans 普通组无四模式选择；建议重量 null 显空、填 0 保存 0、清空恢复 null，且原 bodyweight 不迁移', async () => {
    await page.waitForSelector('input[aria-label="建议重量"]', { timeout: 8000 });
    const modeCount = await page.$$eval('[role="group"][aria-label="重量模式"]', (els) => els.length);
    if (modeCount !== 0) throw new Error('Plans 仍存在重量模式选择器: ' + modeCount);
    const basisVisible = await page.$$eval('[role="group"][aria-label="哑铃口径"]', (els) => els.length);
    if (basisVisible === 0) throw new Error('旧 bodyweight 动作的哑铃口径被隐藏');
    const weightVal = await page.$eval('input[aria-label="建议重量"]', (el) => el.value);
    if (weightVal !== '') throw new Error(`建议重量 null 应显空，实际 "${weightVal}"`);

    await page.click('input[aria-label="建议重量"]');
    await page.keyboard.type('0', { delay: 15 });
    await page.$eval('input[aria-label="建议重量"]', (el) => el.blur());
    await page.waitForFunction(async () => (await window.__w02.getPlan())?.days[0]?.exercises[0]?.target?.suggestedWeightKg === 0, { timeout: 5000 });
    let p = await page.evaluate(() => window.__w02.getPlan());
    let bwTarget = p.days[0].exercises[0].target;
    if (bwTarget.weightMode !== 'bodyweight') throw new Error('Plans 保存不应迁移 weightMode: ' + bwTarget.weightMode);

    await page.click('input[aria-label="建议重量"]');
    await page.$eval('input[aria-label="建议重量"]', (el) => el.select());
    await page.keyboard.press('Backspace');
    await page.$eval('input[aria-label="建议重量"]', (el) => el.blur());
    await page.waitForFunction(async () => (await window.__w02.getPlan())?.days[0]?.exercises[0]?.target?.suggestedWeightKg === null, { timeout: 5000 });
  });

  await check('Plans DropSetEditor 无负重口径选择；null 显空且填 0 保存 0，保留原 assisted', async () => {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '编辑递减组配置');
      if (!btn) throw new Error('找不到编辑递减组配置按钮');
      btn.click();
    });
    await page.waitForSelector('[data-drop-stage="0"] input[aria-label="重量"]', { timeout: 5000 });
    const modeCount = await page.$$eval('[role="group"][aria-label="负重口径"]', (els) => els.length);
    if (modeCount !== 0) throw new Error('DropSetEditor 仍存在负重口径选择器');
    const firstStageWeight = await page.$eval('[data-drop-stage="0"] input[aria-label="重量"]', (el) => el.value);
    if (firstStageWeight !== '') throw new Error(`阶段1 null 应显空，实际 "${firstStageWeight}"`);
    await page.$eval('[data-drop-stage="0"] input[aria-label="重量"]', (el) => {
      el.scrollIntoView({ block: 'center' });
      el.focus();
      el.select();
    });
    await page.keyboard.type('0', { delay: 15 });
    await page.$eval('[data-drop-stage="0"] input[aria-label="重量"]', (el) => el.blur());
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存这个配置'), { timeout: 3000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存这个配置');
      btn.scrollIntoView({ block: 'center' });
      btn.click();
    });
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存这个配置'), { timeout: 5000 });
    const p = await page.evaluate(() => window.__w02.getPlan());
    const dropTarget = p.days[0].exercises[1].target;
    if (dropTarget.weightMode !== 'assisted') throw new Error('DropSet 原 assisted 被改写: ' + dropTarget.weightMode);
    if (dropTarget.roundConfigs?.find((r) => r.roundIndex === 1)?.stages?.[0]?.weightKg !== 0) {
      throw new Error('DropSet 阶段1 显式 0 未保存: ' + JSON.stringify(dropTarget));
    }
  });

  await check('Session 旧 bodyweight 开放重量输入（可填 0 与 10），空白完成不伪造 0', async () => {
    await page.evaluate(() => window.__w02.go('/session/w02-active'));
    await page.waitForSelector(sel('exercise-card-act-bw'), { timeout: 5000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (bodyText.includes('自重动作 · 无需重量')) throw new Error('仍出现旧提示「自重动作 · 无需重量」');

    const toggle = await page.$('[data-testid="exercise-card-act-bw"] button[aria-expanded]');
    const exp = await page.evaluate((el) => el.getAttribute('aria-expanded'), toggle);
    if (exp !== 'true') await toggle.click();
    await page.waitForSelector('input[aria-label="第 1 组重量"]', { timeout: 3000 });

    // 第 1 组填 12 次 × 0kg，逐项等持久化
    await page.$eval('input[aria-label="第 1 组次数"]', (el) => { el.focus(); el.select(); });
    await page.keyboard.type('12', { delay: 25 });
    await page.waitForFunction(async () => (await window.__w02.getSession('w02-active'))?.exercises.find((e) => e.id === 'act-bw')?.sets[0]?.reps === 12, { timeout: 5000 });

    await page.$eval('input[aria-label="第 1 组重量"]', (el) => { el.focus(); el.select(); });
    await page.keyboard.type('0', { delay: 25 });
    await page.$eval('input[aria-label="第 1 组重量"]', (el) => el.blur());
    await page.waitForFunction(async () => (await window.__w02.getSession('w02-active'))?.exercises.find((e) => e.id === 'act-bw')?.sets[0]?.weightKg === 0, { timeout: 5000 });

    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="exercise-card-act-bw"]');
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '完成');
      btn.click();
    });
    await page.waitForFunction(async () => (await window.__w02.getSession('w02-active'))?.exercises.find((e) => e.id === 'act-bw')?.sets[0]?.status === 'done', { timeout: 5000 });

    // 第 2 组不填重量直接点「完成」→ weightKg 必须保持 null
    await page.evaluate(() => {
      const card = document.querySelector('[data-testid="exercise-card-act-bw"]');
      const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '完成');
      btn.click();
    });
    await page.waitForFunction(async () => (await window.__w02.getSession('w02-active'))?.exercises.find((e) => e.id === 'act-bw')?.sets[1]?.status === 'done', { timeout: 5000 });
    let s = await page.evaluate(() => window.__w02.getSession('w02-active'));
    let bw = s.exercises.find((e) => e.id === 'act-bw');
    if (bw.sets[1].weightKg !== null) throw new Error('第 2 组空白完成不应伪造成 0: ' + JSON.stringify(bw.sets[1]));

    // 第 2 组再填 10kg 挂重，验证旧 bodyweight 可填挂重
    await page.$eval('input[aria-label="第 2 组重量"]', (el) => { el.focus(); el.select(); });
    await page.keyboard.type('10', { delay: 25 });
    await page.$eval('input[aria-label="第 2 组重量"]', (el) => el.blur());
    await page.waitForFunction(async () => (await window.__w02.getSession('w02-active'))?.exercises.find((e) => e.id === 'act-bw')?.sets[1]?.weightKg === 10, { timeout: 5000 });
  });

  await check('Session 同身份保存 assisted 不变；A(assisted)→B(普通) 已有 actual 取消不变、确认变 external', async () => {
    await page.evaluate(() => document.querySelector('[data-testid="exercise-card-act-ass-edit"]').click());
    await page.waitForSelector(sel('exercise-editor'), { timeout: 3000 });
    await page.waitForSelector(sel('editor-legacy-assisted-note'));
    await page.$eval(sel('editor-rest'), (el) => { el.focus(); el.select(); });
    await page.keyboard.type('105');
    await page.click(sel('editor-save'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 4000 });
    let s = await page.evaluate(() => window.__w02.getSession('w02-active'));
    let ass = s.exercises.find((e) => e.id === 'act-ass');
    if (ass.target.weightMode !== 'assisted' || ass.restSec !== 105) throw new Error('同身份未保留 assisted: ' + JSON.stringify(ass));

    await page.evaluate(() => document.querySelector('[data-testid="exercise-card-act-ass-edit"]').click());
    await page.waitForSelector(sel('exercise-editor'), { timeout: 3000 });
    await page.click(sel('editor-name-button'));
    await page.waitForSelector(sel('name-custom-input'));
    await page.$eval(sel('name-custom-input'), (el) => { el.focus(); el.select(); });
    await page.keyboard.type('普通新动作');
    await page.click(sel('name-custom-apply'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'), { timeout: 3000 });
    await page.click(sel('editor-save'));
    await page.waitForSelector(sel('confirm-cancel'), { timeout: 3000 });
    await page.click(sel('confirm-cancel'));
    await sleep(150);
    s = await page.evaluate(() => window.__w02.getSession('w02-active'));
    ass = s.exercises.find((e) => e.id === 'act-ass');
    if (ass.name !== '辅助双杠' || ass.target.weightMode !== 'assisted') throw new Error('取消后原动作被修改');

    await page.click(sel('editor-save'));
    await page.waitForSelector(sel('confirm-ok'), { timeout: 3000 });
    await page.click(sel('confirm-ok'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'), { timeout: 4000 });
    s = await page.evaluate(() => window.__w02.getSession('w02-active'));
    ass = s.exercises.find((e) => e.id === 'act-ass');
    if (ass.name !== '普通新动作' || ass.target.weightMode !== 'external') {
      throw new Error('确认后 B 未按 external 保存: ' + JSON.stringify(ass));
    }
  });

  await check('History 详情与 Stats 页可见实际 0kg 且 null 不冒充 0；assisted 与 external 统计隔离', async () => {
    await page.evaluate(() => window.__w02.go('/history/w02-hist-zero'));
    await page.waitForFunction(() => document.body.innerText.includes('悬垂举腿'), { timeout: 4000 });
    const histText = await page.evaluate(() => document.body.innerText);
    if (!histText.includes('#1 · 12 次 × 0 kg')) throw new Error('History 未显示 0 kg: ' + histText);
    if (!histText.includes('#2 · 10 次') || histText.includes('#2 · 10 次 × 0')) {
      throw new Error('History 空白重量被伪造成 0: ' + histText);
    }

    await page.evaluate(() => window.__w02.go('/stats'));
    await page.waitForSelector('select[aria-label="选择动作"]', { timeout: 4000 });
    await page.select('select[aria-label="选择动作"]', 'lib-hanging-leg-raise');
    await sleep(100);
    const zeroStats = await page.evaluate(() => document.body.innerText);
    if (!zeroStats.includes('0 kg') || !zeroStats.includes('12×0 · 10')) {
      throw new Error('Stats 未正确区分 0kg 与 null: ' + zeroStats);
    }

    await page.select('select[aria-label="选择动作"]', 'lib-pull-up');
    await sleep(100);
    const pullStats = await page.evaluate(() => document.body.innerText);
    if (!pullStats.includes('20 kg') || pullStats.includes('70 kg')) {
      throw new Error('Stats 未隔离 assisted 70kg 与 external 20kg: ' + pullStats);
    }
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[role="group"][aria-label="计量口径"] button')].find((b) =>
        b.textContent.includes('辅助'),
      );
      if (!btn) throw new Error('缺少辅助口径切换按钮');
      btn.click();
    });
    await sleep(100);
    const assStats = await page.evaluate(() => document.body.innerText);
    if (!assStats.includes('70 kg')) throw new Error('切换辅助口径后未显示 70 kg: ' + assStats);
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`W02 APP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
