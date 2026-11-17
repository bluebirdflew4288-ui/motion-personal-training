#!/usr/bin/env node
/* R02 FIX2 计划配置面板（真实 DropSetEditor DOM）回归：
   · 第 1 轮独立修改（重量/次数/加阶段）只生成 roundOverrides[1]，默认模板与第 2 轮不变；
   · 合法首轮 override（默认 3 + 第 1 轮 2）在草稿 roundtrip 后仍为 [2,3]。 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.MOTION_R02_FIX2_PLAN_EVIDENCE_DIR || '/private/tmp/motion-harness-round-config-fix2-20261116-v1/tests/r02-fix2-plan';
const req = createRequire(path.join(APP, 'package.json'));
const esbuild = req('esbuild');
const puppeteer = req('puppeteer-core');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const source = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DropSetEditor } from './src/ui/DropSetEditor';
import { dropTargetToDraft, draftToDropTarget } from './src/domain/dropSet';
const st=(id,label,w,min,max,fail,rest)=>({id,label,weightKg:w,repsMin:min,repsMax:max,toFailure:fail,targetText:'',...(rest===undefined?{}:{restAfterSec:rest})});
const form = new URLSearchParams(location.search).get('form') === 'dropSet' ? 'dropSet' : 'superset';
const base = {kind:'dropSet',form,rounds:2,
  stages:[st('a','默认A',20,8,12,false,15),st('b','默认B',15,8,12,false,20),st('c','默认C',10,null,null,true)],
  roundConfigs:[{roundIndex:2,stages:[st('r2a','第二轮A',18,6,10,false,25),st('r2b','第二轮B',12,10,15,true)]}],
  restInSec:15,restAfterSec:90,weightMode:'external'};
const firstOverride = {kind:'dropSet',form,rounds:2,
  stages:[st('a','默认A',20,8,12,false,15),st('b','默认B',15,8,12,false,20),st('c','默认C',10,null,null,true)],
  roundConfigs:[{roundIndex:1,stages:[st('x','首轮X',30,7,9,false,7),st('y','首轮Y',25,10,12,true)],restInSec:7}],
  restInSec:15,restAfterSec:90,weightMode:'external'};
function Harness({target}) {
  const [draft,setDraft]=useState(()=>dropTargetToDraft(target));
  window.__draft=draft;
  window.__target=()=>draftToDropTarget(draft);
  window.__savedStages=()=>draft.stages.map(s=>({id:s.id,weightKg:s.weightKg,repsMin:s.repsMin,repsMax:s.repsMax}));
  return <DropSetEditor draft={draft} onChange={setDraft} fieldPrefix="ex" />;
}
createRoot(document.getElementById('root')).render(<Harness target={new URLSearchParams(location.search).has('first')?firstOverride:base}/>);
`;
const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(path.join(APP, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
const built = await esbuild.build({ stdin: { contents: source, resolveDir: APP, loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: '"web"' }, logLevel: 'silent' });
const server = createServer((q, r) => { if (q.url === '/app.js') { r.setHeader('Content-Type', 'application/javascript'); r.end(built.outputFiles[0].contents); } else if (q.url === '/style.css') { r.setHeader('Content-Type', 'text/css'); r.end(css); } else { r.setHeader('Content-Type', 'text/html; charset=utf-8'); r.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: path.join(OUT, 'chrome-profile'), args: ['--no-first-run', '--disable-extensions', '--no-sandbox'] });
const page = await browser.newPage();
const result = { suite: 'r02-fix2-plan-editor', cases: [], errors: [] };
page.on('pageerror', (e) => result.errors.push(String(e)));
await page.setViewport({ width: 390, height: 900 });
const sel = (id) => `[data-testid="${id}"]`;
const fill = async (id, text) => { await page.$eval(sel(id), (el) => { el.focus(); el.select(); }); await page.keyboard.type(String(text)); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => { try { await fn(); result.cases.push({ name, ok: true }); console.log('  ✔ ' + name); } catch (e) { result.cases.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }); console.log('  ✘ ' + name + ' :: ' + (e instanceof Error ? e.message : String(e))); } };
const eff = (t, r) => { const rc = (t.roundConfigs ?? []).find((x) => x.roundIndex === r); return rc ? rc.stages : t.stages; };

await page.goto(`http://127.0.0.1:${server.address().port}/?first`, { waitUntil: 'load' });
await page.waitForSelector(sel('drop-round-tab-1'));

await check('F3 首轮 override roundtrip：默认 3 + 首轮 2 → 目标仍 第1轮2 / 第2轮3', async () => {
  const t = await page.evaluate(() => window.__target());
  if (eff(t, 1).length !== 2 || eff(t, 2).length !== 3) throw new Error(`逐轮阶段数错误: 第1轮${eff(t,1).length}/第2轮${eff(t,2).length}`);
  const stages = await page.evaluate(() => window.__savedStages());
  if (stages.length !== 3) throw new Error('默认模板被首轮 override 覆盖: ' + stages.length);
  const rc1 = t.roundConfigs.find((x) => x.roundIndex === 1);
  if (!rc1 || rc1.stages.map((s) => s.id).join(',') !== 'x,y') throw new Error('首轮 override 未保留');
});

await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' });
await page.waitForSelector(sel('drop-round-tab-1'));

await check('F2 改第 1 轮重量/次数：默认模板与第 2 轮配置不变，只生成 roundOverrides[1]', async () => {
  const before = await page.evaluate(() => window.__target());
  const beforeRound2 = JSON.stringify(eff(before, 2));
  const inputs = await page.$$('[data-drop-round="1"] input.input');
  if (inputs.length < 3) throw new Error('第 1 轮输入框数量不足: ' + inputs.length);
  for (const [i, v] of [[0, '22'], [1, '7'], [2, '9']]) {
    await inputs[i].evaluate((el) => { el.focus(); el.select(); });
    await page.keyboard.type(v);
    await page.keyboard.press('Tab');
    await pause(30);
  }
  await pause(120);
  const t = await page.evaluate(() => window.__target());
  const stages = await page.evaluate(() => window.__savedStages());
  if (stages[0].weightKg !== 20 || stages[0].repsMin !== 8) throw new Error('默认模板被第 1 轮编辑改写: ' + JSON.stringify(stages[0]));
  const rc1 = t.roundConfigs.find((x) => x.roundIndex === 1);
  if (!rc1) throw new Error('第 1 轮未生成 override');
  if (rc1.stages[0].weightKg !== 22 || rc1.stages[0].repsMin !== 7 || rc1.stages[0].repsMax !== 9) throw new Error('第 1 轮独立值未保存');
  if (JSON.stringify(eff(t, 2)) !== beforeRound2) throw new Error('第 2 轮被第 1 轮编辑连带修改');
});

await check('F2 第 1 轮加阶段：第 2 轮仍 2 阶段，默认模板仍 3 阶段', async () => {
  const btn = await page.$('button.btn.btn-sm.btn-ghost');
  // 用文本定位“+ 加阶段”按钮（当前 activeRound=1）
  const handles = await page.$$('button');
  let clicked = false;
  for (const hnd of handles) {
    const text = await hnd.evaluate((e) => (e.textContent || '').trim());
    if (text === '+ 加阶段') { await hnd.click(); clicked = true; break; }
  }
  if (!clicked) throw new Error('找不到 + 加阶段');
  await pause(120);
  const t = await page.evaluate(() => window.__target());
  const stages = await page.evaluate(() => window.__savedStages());
  if (stages.length !== 3) throw new Error('默认模板阶段数被改: ' + stages.length);
  if (eff(t, 1).length !== 4) throw new Error('第 1 轮加阶段未生效: ' + eff(t, 1).length);
  if (eff(t, 2).length !== 2) throw new Error('第 2 轮被连带修改: ' + eff(t, 2).length);
});

// ---- dropSet 形式：同类检查（计划面板两种训练形式都覆盖） ----
await page.goto(`http://127.0.0.1:${server.address().port}/?first&form=dropSet`, { waitUntil: 'load' });
await page.waitForSelector(sel('drop-round-tab-1'));
await check('F3 首轮 override roundtrip（dropSet）：默认 3 + 首轮 2 → 第1轮2/第2轮3', async () => {
  const t = await page.evaluate(() => window.__target());
  if (eff(t, 1).length !== 2 || eff(t, 2).length !== 3) throw new Error(`逐轮阶段数错误: ${eff(t,1).length}/${eff(t,2).length}`);
});

await page.goto(`http://127.0.0.1:${server.address().port}/?form=dropSet`, { waitUntil: 'load' });
await page.waitForSelector(sel('drop-round-tab-1'));
await check('F2 改第 1 轮重量/次数（dropSet）：默认模板与第 2 轮配置不变', async () => {
  const before = await page.evaluate(() => window.__target());
  const beforeRound2 = JSON.stringify(eff(before, 2));
  const inputs = await page.$$('[data-drop-round="1"] input.input');
  if (inputs.length < 3) throw new Error('第 1 轮输入框数量不足: ' + inputs.length);
  for (const [i, v] of [[0, '23'], [1, '8'], [2, '10']]) {
    await inputs[i].evaluate((el) => { el.focus(); el.select(); });
    await page.keyboard.type(v);
    await page.keyboard.press('Tab');
    await pause(30);
  }
  await pause(120);
  const t = await page.evaluate(() => window.__target());
  const stages = await page.evaluate(() => window.__savedStages());
  if (stages[0].weightKg !== 20 || stages[0].repsMin !== 8) throw new Error('默认模板被第 1 轮编辑改写');
  const rc1 = t.roundConfigs.find((x) => x.roundIndex === 1);
  if (!rc1 || rc1.stages[0].weightKg !== 23 || rc1.stages[0].repsMin !== 8) throw new Error('第 1 轮独立值未保存');
  if (JSON.stringify(eff(t, 2)) !== beforeRound2) throw new Error('第 2 轮被第 1 轮编辑连带修改');
});

const failures = result.cases.filter((c) => !c.ok);
await writeFile(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
await page.screenshot({ path: path.join(OUT, 'r02-fix2-plan.png'), fullPage: true });
await browser.close();
await new Promise((r) => server.close(r));
console.log(`R02 FIX2 PLAN: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
if (failures.length || result.errors.length) process.exitCode = 1;
