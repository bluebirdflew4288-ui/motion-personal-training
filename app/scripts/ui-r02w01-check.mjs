#!/usr/bin/env node
/* W02 真实 ExerciseEditor DOM 验收脚本（由原 R02W01 契约按 W02 需求更新）。
   覆盖：
   1. 编辑器无四模式按钮，哑铃口径在旧 bodyweight 下也不隐藏；A(bodyweight)->B 新动作自动跟随 external；
   2. 同身份编辑保留原 weightMode（不迁移），显式 0kg 与空白 null 严格区分；
   3. A(assisted)->B(普通) 与 A(external)->B(已记忆 assisted) 来源不串；保存失败保留草稿；改名保留已填次数草稿。 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.MOTION_R02W01_EVIDENCE_DIR || '/private/tmp/motion-harness-round-weight-20261115-v1/tests/r02w01';
const req = createRequire(path.join(APP, 'package.json'));
const esbuild = req('esbuild');
const puppeteer = req('puppeteer-core');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const source = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ExerciseEditor } from './src/ui/ExerciseEditor';
import { needsWeight } from './src/domain/session';
const cases = {
  bw: {
    key: 'w02-bw',
    name: '双杠臂屈伸',
    exerciseId: 'synthetic-dip',
    restSec: 90,
    target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'bodyweight', suggestedWeightKg: null },
    arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
    memory: { mode: 'none', revision: null },
  },
  assisted: {
    key: 'w02-assisted',
    name: '辅助引体向上',
    exerciseId: 'custom:辅助引体向上',
    restSec: 90,
    target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'assisted', suggestedWeightKg: 40 },
    arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
    memory: { mode: 'none', revision: null },
  },
  external: {
    key: 'w02-external',
    name: '自由杠铃卧推',
    exerciseId: 'lib-barbell-bench',
    restSec: 120,
    target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 60 },
    arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
    memory: { mode: 'none', revision: null },
  },
};
const templates = [
  {
    key: 'exercise-template:custom:辅助双杠',
    schemaVersion: 1,
    exerciseId: 'custom:辅助双杠',
    name: '辅助双杠',
    restSec: 90,
    target: { kind: 'straight', sets: 3, setsMax: 3, repsMin: 8, repsMax: 12, weightMode: 'assisted', suggestedWeightKg: 35 },
    revision: 4,
    updatedAt: 1000,
  },
];
let submitMode = 'ok';
function Host() {
  const [which, setWhich] = useState('bw');
  window.__openCase = setWhich;
  return (
    <ExerciseEditor
      open
      mode="edit"
      initial={cases[which]}
      templates={templates}
      onClose={() => {}}
      onSubmit={async (payload) => {
        window.__lastPayload = structuredClone(payload);
        window.__lastShowWeight = needsWeight({ target: payload.target });
        if (submitMode === 'fail') return { ok: false, message: '注入保存失败' };
        return { ok: true };
      }}
    />
  );
}
createRoot(document.getElementById('root')).render(<Host />);
window.__setSubmitMode = (m) => { submitMode = m; };
window.__resetPayload = () => { window.__lastPayload = null; window.__lastShowWeight = null; };
`;

const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(path.join(APP, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
const built = await esbuild.build({
  stdin: { contents: source, resolveDir: APP, loader: 'tsx' },
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: '"web"' },
  logLevel: 'silent',
});
const server = createServer((q, r) => {
  if (q.url === '/app.js') {
    r.setHeader('Content-Type', 'application/javascript');
    r.end(built.outputFiles[0].contents);
  } else if (q.url === '/style.css') {
    r.setHeader('Content-Type', 'text/css');
    r.end(css);
  } else {
    r.setHeader('Content-Type', 'text/html; charset=utf-8');
    r.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--disable-extensions', '--no-sandbox'] });
const result = { suite: 'w02-exercise-editor', cases: [], errors: [], payloads: [] };
const page = await browser.newPage();
page.on('pageerror', (e) => result.errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') result.errors.push('console: ' + m.text()); });
await page.setViewport({ width: 390, height: 900 });
const sel = (id) => `[data-testid="${id}"]`;
const click = async (id) => { await page.waitForSelector(sel(id), { timeout: 3000 }); await page.click(sel(id)); };
const fill = async (id, text) => { await page.$eval(sel(id), (el) => { el.focus(); el.select(); }); await page.keyboard.type(text); };
const has = async (id) => (await page.$(sel(id))) !== null;
const val = (id) => page.$eval(sel(id), (el) => el.value);
const save = () => page.evaluate(() => document.querySelector('[data-testid="editor-save"]').click());

const check = async (name, fn) => {
  try {
    await fn();
    result.cases.push({ name, ok: true });
    console.log('  ✔ ' + name);
  } catch (err) {
    result.cases.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    console.log('  ✘ ' + name + ' :: ' + (err instanceof Error ? err.message : String(err)));
  }
};

await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector(sel('exercise-editor'));

await check('无四模式选择；旧 bodyweight 重命名后自动按 external + 25kg 保存且 needsWeight=true', async () => {
  await page.evaluate(() => { window.__resetPayload(); window.__setSubmitMode('ok'); });
  for (const m of ['external', 'bodyweight', 'bodyweight_plus', 'assisted']) {
    if (await has(`editor-weight-mode-${m}`)) throw new Error(`不应再渲染四模式按钮 ${m}`);
  }
  if (!(await has('editor-dumbbell-basis-per_hand'))) throw new Error('旧 bodyweight 下哑铃口径不应被隐藏');
  await click('editor-name-button');
  await page.waitForSelector(sel('name-custom-input'));
  await fill('name-custom-input', '下斜绳索夹胸');
  await click('name-custom-apply');
  await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
  await fill('group-0-weight', '25');
  await save();
  await page.waitForFunction(() => Boolean(window.__lastPayload), { timeout: 2500 });
  const out = await page.evaluate(() => ({ payload: window.__lastPayload, showWeight: window.__lastShowWeight }));
  result.payloads.push(out);
  const t = out.payload.target;
  if (out.payload.name !== '下斜绳索夹胸') throw new Error('名称未保存');
  if (t.weightMode !== 'external') throw new Error(`payload.weightMode 仍是 ${t.weightMode}（应 external）`);
  if (t.perSetConfigs?.[0]?.suggestedWeightKg !== 25) throw new Error('25kg 未保存到第一组');
  if (out.showWeight !== true) throw new Error('训练页 needsWeight 仍为 false');
});

await check('同身份旧 bodyweight 填 0kg 与空白区分保存，且保留原 weightMode 与哑铃口径', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector(sel('exercise-editor'));
  await page.evaluate(() => { window.__resetPayload(); window.__setSubmitMode('ok'); });
  await fill('group-0-weight', '0');
  await click('editor-dumbbell-basis-per_hand');
  await save();
  await page.waitForFunction(() => Boolean(window.__lastPayload), { timeout: 2500 });
  const out = await page.evaluate(() => ({ payload: window.__lastPayload, showWeight: window.__lastShowWeight }));
  result.payloads.push(out);
  const t = out.payload.target;
  if (t.weightMode !== 'bodyweight') throw new Error(`同身份不应迁移旧 weightMode，实际 ${t.weightMode}`);
  if (t.dumbbellBasis !== 'per_hand') throw new Error('哑铃口径未保存 per_hand');
  if (t.perSetConfigs?.[0]?.suggestedWeightKg !== 0) throw new Error('显式 0kg 被丢弃');
  if (t.perSetConfigs?.[1]?.suggestedWeightKg !== null) throw new Error('未填组不应变成 0');
  if (out.showWeight !== true) throw new Error('训练页 needsWeight 应为 true');
});

await check('A(assisted)→B(普通) 与 A(external)→B(已记忆assisted) 来源不串；保存失败与改名保留草稿', async () => {
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector(sel('exercise-editor'));
  await page.evaluate(() => window.__openCase('assisted'));
  await page.waitForSelector(sel('editor-legacy-assisted-note'));
  await page.evaluate(() => { window.__resetPayload(); window.__setSubmitMode('fail'); });
  await fill('group-0-reps-min', '6');
  await click('editor-name-button');
  await page.waitForSelector(sel('name-custom-input'));
  await fill('name-custom-input', '普通划船');
  await click('name-custom-apply');
  await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
  if ((await val('group-0-reps-min')) !== '6') throw new Error('改名覆盖了已填次数草稿');
  if (await has('editor-legacy-assisted-note')) throw new Error('A(assisted)→B(普通) 后仍显示 assisted 说明');
  await save();
  await page.waitForSelector(sel('editor-submit-error'), { timeout: 2500 });
  if ((await val('group-0-reps-min')) !== '6') throw new Error('保存失败后次数草稿丢失');
  await page.evaluate(() => window.__setSubmitMode('ok'));
  await save();
  await page.waitForFunction(() => Boolean(window.__lastPayload), { timeout: 2500 });
  const p1 = await page.evaluate(() => window.__lastPayload);
  if (p1.target.weightMode !== 'external') throw new Error(`A(assisted)→B(普通) 串为 ${p1.target.weightMode}`);

  await page.evaluate(() => { window.__resetPayload(); window.__openCase('external'); });
  await page.waitForFunction(() => document.querySelector('[data-testid="editor-name-button"]').textContent.includes('自由杠铃卧推'));
  await click('editor-name-button');
  await page.waitForSelector(sel('name-custom-input'));
  await fill('name-custom-input', '辅助双杠');
  await click('name-custom-apply');
  await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
  await page.waitForSelector(sel('editor-legacy-assisted-note'));
  await save();
  await page.waitForFunction(() => Boolean(window.__lastPayload), { timeout: 2500 });
  const p2 = await page.evaluate(() => window.__lastPayload);
  if (p2.target.weightMode !== 'assisted') throw new Error(`A(external)→B(tpl assisted) 未跟随为 ${p2.target.weightMode}`);
});

const failures = result.cases.filter((c) => !c.ok);
await writeFile(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
await browser.close();
await new Promise((r) => server.close(r));
console.log(`R02W01/W02 DOM: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
if (failures.length || result.errors.length) process.exitCode = 1;
