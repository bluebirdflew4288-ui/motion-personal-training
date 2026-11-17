#!/usr/bin/env node
/* M02 真实 Chrome + IndexedDB 端到端行为验证脚本：
   - ?probe=editor：挂载真实 ExerciseEditor 组件，覆盖 M02-01..06、1/8 阶段基准切换、
     撤销带入（含非法 raw "7." 与 dirty 一致）、同身份不改 revision、F1 错误不换身份、
     F2 动态 templateError 阻断写默认、F3 IME 门禁与提交锁。
   - 默认全量 App + StoreProvider + 真实 IndexedDB：覆盖替换 B 与临时添加 B 同源深复制、
     仅保存本次 vs 更新默认提示区分、A→B→C 只写 C、CAS 冲突保留草稿、已有 actual 确认/取消、
     损坏模板行阻断。
   证据默认写入 MOTION_M02_EVIDENCE_DIR 或 OUT/evidence/m02-app。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_M02_EVIDENCE_DIR || resolve(APP_DIR, '../_evidence-m02-app');
const SHOTS = join(OUT, 'screens');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id) => `[data-testid="${id}"]`;

const entry = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider } from './src/store';
import { App } from './src/App';
import { ensureSeed, getSession, listPlans } from './src/db/repo';
import { idbPut } from './src/db/idb';
import { createSession } from './src/domain/session';
import { atomicCreateSession } from './src/db/tx';
import { putExerciseTemplate, readExerciseTemplates } from './src/db/templates';
import { exerciseTemplateFromConfig, roundRestInSecOf } from './src/domain/exerciseConfig';
import { exerciseIdFromName } from './src/domain/identity';
import { navigate } from './src/lib/router';
import { ExerciseEditor } from './src/ui/ExerciseEditor';

function makeTemplates() {
  const bSuper = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('胸托超级组'),
    name: '胸托超级组',
    target: {
      kind: 'dropSet',
      form: 'superset',
      rounds: 2,
      stages: [
        { id: 'def-1', label: '默认一', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
        { id: 'def-2', label: '默认二', weightKg: 0, repsMin: null, repsMax: null, toFailure: true, restAfterSec: 20, targetText: '' },
        { id: 'def-3', label: '默认三', weightKg: null, repsMin: 10, repsMax: 15, toFailure: false, targetText: '' },
      ],
      roundConfigs: [
        {
          roundIndex: 1,
          restInSec: 22,
          stages: [
            { id: 'r1-1', label: '首轮一', weightKg: 0, repsMin: 6, repsMax: 8, toFailure: false, targetText: '' },
            { id: 'r1-2', label: '首轮二', weightKg: null, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
          ],
        },
        {
          roundIndex: 2,
          restInSec: 25,
          stages: [
            { id: 'r2-1', label: '次轮一', weightKg: 25, repsMin: 8, repsMax: 10, toFailure: false, targetText: '' },
            { id: 'r2-2', label: '次轮二', weightKg: 15, repsMin: 10, repsMax: 12, toFailure: true, targetText: '' },
          ],
        },
      ],
      restInSec: 15,
      restAfterSec: 105,
      weightMode: 'assisted',
      dumbbellBasis: 'per_hand',
    },
    restSec: 105,
    revision: 2,
  });

  const bEight = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('八阶段老动作'),
    name: '八阶段老动作',
    target: {
      kind: 'dropSet',
      rounds: 1,
      stages: Array.from({ length: 8 }, (_, i) => ({
        id: 'e-' + (i + 1),
        label: '八阶' + (i + 1),
        weightKg: 10,
        repsMin: 8,
        repsMax: 12,
        toFailure: false,
        targetText: '',
      })),
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    },
    restSec: 90,
    revision: 1,
  });

  const bTwo = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('二阶段新动作'),
    name: '二阶段新动作',
    target: {
      kind: 'dropSet',
      rounds: 1,
      stages: [
        { id: 't-1', label: '二阶一', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, targetText: '' },
        { id: 't-2', label: '二阶二', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: true, targetText: '' },
      ],
      restInSec: 15,
      restAfterSec: 90,
      weightMode: 'external',
    },
    restSec: 90,
    revision: 1,
  });

  const bStraight = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('普通三组B'),
    name: '普通三组B',
    target: {
      kind: 'straight',
      sets: 3,
      setsMax: 3,
      repsMin: 10,
      repsMax: 12,
      weightMode: 'external',
      suggestedWeightKg: 42.5,
      perSetConfigs: [
        { setIndex: 1, repsMin: 10, repsMax: 12, suggestedWeightKg: 42.5, toFailure: false },
        { setIndex: 2, repsMin: 10, repsMax: 12, suggestedWeightKg: 0, toFailure: false },
        { setIndex: 3, repsMin: null, repsMax: null, suggestedWeightKg: null, toFailure: true },
      ],
    },
    restSec: 137,
    revision: 3,
  });

  const bSplitRest = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('独立休息多阶段M'),
    name: '独立休息多阶段M',
    target: {
      kind: 'dropSet',
      rounds: 1,
      stages: [
        { id: 'm-1', label: '阶段一', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
        { id: 'm-2', label: '阶段二', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: true, targetText: '' },
      ],
      restInSec: 15,
      restAfterSec: 151,
      weightMode: 'external',
    },
    restSec: 211,
    revision: 1,
  });

  return [bSuper, bEight, bTwo, bStraight, bSplitRest];
}

function EditorProbe() {
  const [state, setState] = useState({
    open: false,
    key: 'init',
    initial: {
      key: 'init',
      name: '动作A',
      exerciseId: exerciseIdFromName('动作A'),
      restSec: 60,
      target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 30 },
      arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
      memory: { mode: 'exists', revision: 1 },
    },
    templates: makeTemplates(),
    templateError: null,
    tick: 0,
  });
  const calls = useRef([]);
  const closes = useRef([]);
  const submitModeRef = useRef('ok');
  const pendingRef = useRef([]);

  useEffect(() => {
    window.__m02Probe = {
      openCase(kind) {
        calls.current = [];
        closes.current = [];
        submitModeRef.current = 'ok';
        pendingRef.current = [];
        const all = makeTemplates();
        if (kind === 'straightA') {
          setState({
            open: true,
            key: 'straightA-' + Date.now(),
            initial: {
              key: 'straightA-' + Date.now(),
              name: '动作A',
              exerciseId: exerciseIdFromName('动作A'),
              restSec: 60,
              target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 30 },
              arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
              memory: { mode: 'exists', revision: 1 },
            },
            templates: all,
            templateError: null,
            tick: 0,
          });
        } else if (kind === 'eightA') {
          const t = all.find((x) => x.exerciseId === exerciseIdFromName('八阶段老动作'));
          setState({
            open: true,
            key: 'eightA-' + Date.now(),
            initial: {
              key: 'eightA-' + Date.now(),
              name: t.name,
              exerciseId: t.exerciseId,
              restSec: t.restSec,
              target: structuredClone(t.target),
              arrangedGroups: [{ index: 1, stageCount: 8 }],
              memory: { mode: 'exists', revision: 1 },
            },
            templates: all,
            templateError: null,
            tick: 0,
          });
        } else if (kind === 'threeRoundA') {
          setState({
            open: true,
            key: 'threeRoundA-' + Date.now(),
            initial: {
              key: 'threeRoundA-' + Date.now(),
              name: '三轮原动作A',
              exerciseId: exerciseIdFromName('三轮原动作A'),
              restSec: 90,
              target: {
                kind: 'dropSet',
                rounds: 3,
                stages: [
                  { id: 't3-1', label: 'A1', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
                  { id: 't3-2', label: 'A2', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: true, targetText: '' },
                ],
                restInSec: 15,
                restAfterSec: 90,
                weightMode: 'external',
              },
              arrangedGroups: [{ index: 1, stageCount: 2 }, { index: 2, stageCount: 2 }, { index: 3, stageCount: 2 }],
              memory: { mode: 'exists', revision: 1 },
            },
            templates: all,
            templateError: null,
            tick: 0,
          });
        } else if (kind === 'twoRoundA') {
          setState({
            open: true,
            key: 'twoRoundA-' + Date.now(),
            initial: {
              key: 'twoRoundA-' + Date.now(),
              name: '两轮原动作A',
              exerciseId: exerciseIdFromName('两轮原动作A'),
              restSec: 90,
              target: {
                kind: 'dropSet',
                rounds: 2,
                stages: [
                  { id: 'a1', label: 'A阶1', weightKg: 20, repsMin: 8, repsMax: 12, toFailure: false, restAfterSec: 15, targetText: '' },
                  { id: 'a2', label: 'A阶2', weightKg: 10, repsMin: 8, repsMax: 12, toFailure: true, targetText: '' },
                ],
                restInSec: 15,
                restAfterSec: 90,
                weightMode: 'assisted',
              },
              arrangedGroups: [{ index: 1, stageCount: 2 }, { index: 2, stageCount: 2 }],
              memory: { mode: 'exists', revision: 5 },
            },
            templates: all,
            templateError: null,
            tick: 0,
          });
        } else if (kind === 'corruptTpl') {
          const bad = { ...structuredClone(all[3]), restSec: -10 };
          setState({
            open: true,
            key: 'corrupt-' + Date.now(),
            initial: {
              key: 'corrupt-' + Date.now(),
              name: '原动作A',
              exerciseId: exerciseIdFromName('原动作A'),
              restSec: 60,
              target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'assisted', suggestedWeightKg: 30 },
              arrangedGroups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
              memory: { mode: 'exists', revision: 4 },
            },
            templates: [bad],
            templateError: null,
            tick: 0,
          });
        }
      },
      bumpRevision(nameOrId, nextRev) {
        const targetId = nameOrId.includes(':') || nameOrId.startsWith('lib-') ? nameOrId : exerciseIdFromName(nameOrId);
        setState((s) => ({
          ...s,
          tick: s.tick + 1,
          templates: s.templates.map((t) => (t.exerciseId === targetId ? { ...t, revision: nextRev } : t)),
        }));
      },
      setTemplateError(err) {
        setState((s) => ({ ...s, templateError: err }));
      },
      setSubmitMode(m) {
        submitModeRef.current = m;
      },
      resolvePending(res) {
        const fn = pendingRef.current.shift();
        if (fn) fn(res);
      },
      calls() { return calls.current; },
      closes() { return closes.current; },
    };
  }, []);

  return (
    <ExerciseEditor
      open={state.open}
      mode="edit"
      initial={state.initial}
      templates={state.templates}
      templateError={state.templateError}
      onSubmit={async (payload) => {
        calls.current.push(structuredClone(payload));
        if (submitModeRef.current === 'manual') {
          return new Promise((r) => pendingRef.current.push(r));
        }
        return { ok: true };
      }}
      onClose={(reason) => {
        closes.current.push(reason || 'closed');
        setState((s) => ({ ...s, open: false }));
      }}
    />
  );
}

async function boot() {
  if (new URLSearchParams(location.search).get('probe') === 'editor') {
    createRoot(document.getElementById('root')).render(<EditorProbe />);
    window.__booted = true;
    return;
  }

  await ensureSeed();
  const plans = await listPlans();
  const plan = plans[0];
  const day = plan.days[0];
  const session = createSession(plan, day);
  session.id = 'm02-session';
  // A1: 无 actual 的普通动作
  session.exercises = [
    {
      id: 'ex-clean',
      exerciseId: exerciseIdFromName('原动作无记录'),
      planExerciseId: null,
      name: '原动作无记录',
      en: 'Old English Name',
      restSec: 60,
      target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 30 },
      status: 'pending',
      groups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
      sets: [
        { id: 'c-s1', roundIndex: 1, stageIndex: 1, reps: null, weightKg: null, status: 'blank' },
        { id: 'c-s2', roundIndex: 2, stageIndex: 1, reps: null, weightKg: null, status: 'blank' },
      ],
      note: '',
    },
    {
      id: 'ex-actual',
      exerciseId: exerciseIdFromName('已有记录A'),
      planExerciseId: 'pe-m02-1',
      name: '已有记录A',
      restSec: 90,
      target: { kind: 'straight', sets: 2, setsMax: 2, repsMin: 8, repsMax: 12, weightMode: 'external', suggestedWeightKg: 50 },
      status: 'pending',
      groups: [{ index: 1, stageCount: 1 }, { index: 2, stageCount: 1 }],
      sets: [
        { id: 'act-1', roundIndex: 1, stageIndex: 1, reps: 10, weightKg: 50, status: 'done' },
        { id: 'act-2', roundIndex: 2, stageIndex: 1, reps: null, weightKg: null, status: 'blank' },
      ],
      note: '',
    },
  ];
  await atomicCreateSession({ session });

  const bTpl = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('胸托划船'),
    name: '胸托划船',
    target: {
      kind: 'dropSet',
      form: 'superset',
      rounds: 2,
      stages: [
        { id: 'row-s1', label: '宽握', weightKg: 40, repsMin: 8, repsMax: 10, toFailure: false, restAfterSec: 15, targetText: '' },
        { id: 'row-s2', label: '窄握', weightKg: 0, repsMin: null, repsMax: null, toFailure: true, restAfterSec: 20, targetText: '' },
        { id: 'row-s3', label: '离心', weightKg: null, repsMin: 10, repsMax: 12, toFailure: false, targetText: '' },
      ],
      roundConfigs: [
        {
          roundIndex: 2,
          restInSec: 25,
          stages: [
            { id: 'row-s1', label: '宽握', weightKg: 35, repsMin: 8, repsMax: 10, toFailure: false, targetText: '' },
            { id: 'row-s2', label: '窄握', weightKg: 0, repsMin: null, repsMax: null, toFailure: true, targetText: '' },
          ],
        },
      ],
      restInSec: 15,
      restAfterSec: 105,
      weightMode: 'external',
    },
    restSec: 105,
    revision: 1,
  });
  await putExerciseTemplate(bTpl, null);

  const cTpl = exerciseTemplateFromConfig({
    exerciseId: exerciseIdFromName('目标C动作'),
    name: '目标C动作',
    target: {
      kind: 'straight',
      sets: 4,
      setsMax: 4,
      repsMin: 6,
      repsMax: 8,
      weightMode: 'external',
      suggestedWeightKg: 80,
      perSetConfigs: [1, 2, 3, 4].map((i) => ({ setIndex: i, repsMin: 6, repsMax: 8, suggestedWeightKg: 80, toFailure: false })),
    },
    restSec: 150,
    revision: 1,
  });
  await putExerciseTemplate(cTpl, null);

  if (new URLSearchParams(location.search).get('corrupt') === '1') {
    await idbPut('meta', { key: 'exercise-template:custom:坏模板', value: { broken: true } });
  }

  window.__m02App = {
    getSession: (id = 'm02-session') => getSession(id),
    getTemplates: () => readExerciseTemplates(),
    putTemplate: (t, rev) => putExerciseTemplate(t, rev),
    roundRestInSecOf,
    exerciseIdFromName,
  };

  createRoot(document.getElementById('root')).render(
    React.createElement(React.StrictMode, null, React.createElement(StoreProvider, null, React.createElement(App))),
  );
  navigate('/session/m02-session', true);
  window.__booted = true;
}
boot().catch((e) => { window.__bootError = String(e); });
`;

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  const css = (await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))).join('\n');
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: JSON.stringify('web') },
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
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(OUT, 'chrome-profile'),
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--no-sandbox'],
  });

  const result = { suite: 'm02-app-check', cases: [], screenshots: [], errors: [] };
  let idx = 0;

  const makeHelpers = (page) => {
    const exists = async (id) => (await page.$(sel(id))) !== null;
    const waitId = (id, timeout = 6000) => page.waitForSelector(sel(id), { visible: true, timeout });
    const hit = async (selector) => {
      const el = await page.waitForSelector(selector, { visible: true, timeout: 6000 });
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.waitForFunction((selText) => {
        const t = document.querySelector(selText);
        if (!t || t.disabled) return false;
        const r = t.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return Boolean(at && (t === at || t.contains(at)));
      }, { timeout: 5000 }, selector);
      await el.click();
      await sleep(50);
    };
    const clickId = (id) => hit(sel(id));
    const clickText = async (text) => {
      const handles = (await page.$$('button')).reverse();
      for (const h of handles) {
        const label = await h.evaluate((x) => (x.textContent || '').trim());
        if (label !== text) continue;
        await h.evaluate((x) => x.scrollIntoView({ block: 'center', inline: 'center' }));
        await h.click();
        await sleep(60);
        return;
      }
      throw new Error('找不到按钮: ' + text);
    };
    const fillId = async (id, val) => {
      await waitId(id);
      await page.$eval(sel(id), (el) => { el.focus(); el.select(); });
      await page.keyboard.type(String(val));
      await sleep(20);
    };
    const val = (id) => page.$eval(sel(id), (e) => e.value);
    const checked = (id) => page.$eval(sel(id), (e) => e.checked);
    const text = (id) => page.$eval(sel(id), (e) => e.textContent || '');
    const bodyText = () => page.evaluate(() => document.body.innerText || '');
    const pickCustom = async (name) => {
      await clickId('editor-name-button');
      await waitId('exercise-name-picker');
      await fillId('name-custom-input', name);
      await clickId('name-custom-apply');
      await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
    };
    const openEditorBySwipe = async (exId) => {
      const expanded = await page.$(`[data-testid="exercise-card-${exId}"] button[aria-expanded="true"]`);
      if (expanded) { await expanded.click(); await sleep(100); }
      const header = await page.waitForSelector(sel(`exercise-card-${exId}`) + ' h3', { visible: true, timeout: 6000 });
      await header.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      const b = await header.boundingBox();
      await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.8 - 145, b.y + b.height * 0.5, { steps: 10 });
      await page.mouse.up();
      const editBtn = `[data-testid="exercise-card-${exId}-edit"]`;
      await page.waitForSelector(editBtn, { visible: true, timeout: 5000 });
      await hit(editBtn);
      await waitId('exercise-editor');
    };
    return { exists, waitId, hit, clickId, clickText, fillId, val, checked, text, bodyText, pickCustom, openEditorBySwipe };
  };

  const runCase = async (name, urlSuffix, fn) => {
    idx += 1;
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const shot = join(SHOTS, `m02-${String(idx).padStart(2, '0')}.png`);
    const entry = { name, ok: true, errors, screenshot: shot };
    try {
      await page.setViewport({ width: 410, height: 900, hasTouch: true, isMobile: true });
      await page.goto(`${baseUrl}${urlSuffix}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
      if (await page.evaluate(() => window.__bootError)) throw new Error('boot error: ' + await page.evaluate(() => window.__bootError));
      await fn(makeHelpers(page), page);
      if (errors.length) throw new Error('页面报错: ' + errors.join(' | '));
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

  await runCase('E01 替换B带入3/2异构+第1轮覆盖+逐轮restInSec+0/null+文案默认不勾', '/?probe=editor', async (h, page) => {
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('胸托超级组');
    await h.waitId('editor-template-applied');
    if (!(await h.text('editor-template-applied')).includes('已带入「胸托超级组」的默认配置')) throw new Error('缺少带入状态提示');
    if (await h.checked('editor-remember')) throw new Error('已有记忆默认不应勾选');
    if (!(await h.bodyText()).includes('将当前配置设为此动作的默认配置')) throw new Error('复选框文案未更新');
    if ((await h.val('editor-rounds')) !== '2') throw new Error('轮数应带入 2');
    // 第1轮来自 round1 override (2 阶段)
    const r1Rows = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (r1Rows !== 2) throw new Error('第1轮覆盖阶段数应为 2，实际 ' + r1Rows);
    if ((await h.val('stage-0-weight')) !== '0' || (await h.val('stage-0-rest')) !== '22') throw new Error('第1轮 0kg 或 round1 restInSec=22 未带入');
    await h.clickId('round-tab-2');
    if ((await h.val('stage-r2-0-rest')) !== '25') throw new Error('第2轮 restInSec=25 未带入');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
    const payload = await page.evaluate(() => window.__m02Probe.calls()[0]);
    if (payload.remember !== false) throw new Error('未勾更新却 remember=true');
    if (payload.target.form !== 'superset' || payload.target.stages.length !== 3) throw new Error('默认模板 stages 未与第1轮覆盖保持分离');
    if (payload.target.roundConfigs.length !== 2 || payload.target.roundConfigs[0].restInSec !== 22 || payload.target.roundConfigs[1].restInSec !== 25) {
      throw new Error('逐轮 restInSec 丢失: ' + JSON.stringify(payload.target.roundConfigs));
    }
    if (payload.target.weightMode !== 'assisted' || payload.target.dumbbellBasis !== 'per_hand') throw new Error('兼容口径未带入');
  });

  await runCase('E02 A→B 基准切换：普通→8阶段可保存；8阶段→2阶段不可继承8阶段加阶段额度', '/?probe=editor', async (h, page) => {
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('八阶段老动作');
    const eightRows = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (eightRows !== 8) throw new Error('8阶段老动作未完整带入: ' + eightRows);
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);

    await page.evaluate(() => window.__m02Probe.openCase('eightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('二阶段新动作');
    const twoRows = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (twoRows !== 2) throw new Error('2阶段动作行数错误: ' + twoRows);
    for (let i = 0; i < 6; i += 1) {
      const disabled = await page.$eval(sel('editor-add-stage'), (e) => e.disabled);
      if (disabled) break;
      await h.clickId('editor-add-stage');
    }
    const capped = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (capped !== 6) throw new Error('A(8阶段)→B(2阶段) 继承了旧8阶段额度: ' + capped);
  });

  await runCase('E03 撤销带入恢复完整快照（活动轮2、非法raw 7.、revision/remember、dirty一致）', '/?probe=editor', async (h, page) => {
    // 子例1：dirty=false 打开 → 选 B → 撤销带入 → 回到 clean，取消直接关闭
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('普通三组B');
    await h.waitId('editor-undo-apply');
    await h.clickId('editor-undo-apply');
    if (await h.exists('editor-template-applied')) throw new Error('撤销后提示条未消失');
    await h.clickId('editor-cancel');
    await sleep(60);
    if (await h.exists('leave-continue')) throw new Error('clean 撤销后不应触发离页确认');

    // 子例2：活动轮2 + 非法raw "7." + 勾选 remember → 选 B → 撤销带入 → 全量恢复
    await page.evaluate(() => window.__m02Probe.openCase('twoRoundA'));
    await h.waitId('exercise-editor');
    await h.clickId('round-tab-2');
    await h.fillId('stage-r2-0-weight', '7.');
    await h.clickId('editor-remember');
    await h.pickCustom('普通三组B');
    if ((await h.val('editor-sets')) !== '3') throw new Error('B 未带入');
    await h.clickId('editor-undo-apply');
    if ((await h.val('stage-r2-0-weight')) !== '7.') throw new Error('撤销未恢复第2轮非法 raw "7."');
    if (!(await h.checked('editor-remember'))) throw new Error('撤销未恢复勾选状态');
    await h.clickId('editor-save');
    await sleep(60);
    if ((await page.evaluate(() => window.__m02Probe.calls().length)) !== 0) throw new Error('恢复非法 raw 后竟然可提交');
  });

  await runCase('E04 同身份重选+缓存刷新不改revision；A→B→无记忆C清理撤销条与首次文案', '/?probe=editor', async (h, page) => {
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('普通三组B');
    await h.fillId('editor-rest', '141');
    await h.clickId('editor-remember');
    // 后台缓存刷新将 B revision 推进到 99
    await page.evaluate(() => window.__m02Probe.bumpRevision('普通三组B', 99));
    await sleep(40);
    if ((await h.val('editor-rest')) !== '141') throw new Error('缓存刷新覆盖了用户 raw');
    // 重新选同一 B
    await h.pickCustom('普通三组B');
    if ((await h.val('editor-rest')) !== '141') throw new Error('同身份重选重置了 raw');
    if (!(await h.checked('editor-remember'))) throw new Error('同身份重选重置了勾选');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
    const p1 = await page.evaluate(() => window.__m02Probe.calls()[0]);
    if (p1.templateExpectedRevision !== 3) throw new Error('同身份重选偷偷改了已捕获 revision: ' + p1.templateExpectedRevision);

    // A → B → 无记忆 C
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('普通三组B');
    await h.waitId('editor-undo-apply');
    await h.pickCustom('全新无记忆C');
    if (await h.exists('editor-template-applied')) throw new Error('切到无记忆 C 未清理不适用撤销条');
    if (!(await h.text('editor-remember-static')).includes('首次保存后，这套配置将作为此动作的默认配置，添加或替换时自动带入')) {
      throw new Error('首次说明文案不匹配');
    }
  });

  await runCase('E05 F1错误不换身份与记忆意图；F2动态templateError阻断写默认；F3 IME阻断切换', '/?probe=editor', async (h, page) => {
    // F1: 坏模板不换 B、不清 A 的勾选/revision/raw
    await page.evaluate(() => window.__m02Probe.openCase('corruptTpl'));
    await h.waitId('exercise-editor');
    await h.clickId('editor-remember');
    await h.fillId('group-0-weight', '55');
    await h.pickCustom('普通三组B');
    await h.waitId('editor-template-error');
    if (!(await h.text('editor-template-error')).includes('本次未替换')) throw new Error('F1 错误未说明本次未替换');
    if (!(await h.text('editor-name-button')).includes('原动作A')) throw new Error('F1 仍把身份换成了 B');
    if ((await h.val('group-0-weight')) !== '55' || !(await h.checked('editor-remember'))) throw new Error('F1 丢失草稿或清了勾选');

    // F2: 打开后动态出现 templateError → 拒绝携带写默认提交，保留勾选；取消勾选后允许只保存本次
    await page.evaluate(() => window.__m02Probe.setTemplateError('读取异常'));
    await h.waitId('editor-template-error');
    await h.clickId('editor-save');
    await h.waitId('editor-submit-error');
    if ((await page.evaluate(() => window.__m02Probe.calls().length)) !== 0) throw new Error('F2 动态错误期间仍提交了默认写入');
    if (!(await h.checked('editor-remember'))) throw new Error('F2 拒绝时静默取消了用户勾选');
    await h.clickId('editor-remember');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
    const savedOnly = await page.evaluate(() => window.__m02Probe.calls()[0]);
    if (savedOnly.remember !== false || savedOnly.exerciseId !== 'custom:原动作a') throw new Error('F2 仅保存本次异常');

    // F3: IME 组合中阻止切动作，结束后切换并清空旧字段 key，B 可正常保存
    await page.evaluate(() => window.__m02Probe.openCase('twoRoundA'));
    await h.waitId('exercise-editor');
    await page.focus(sel('stage-0-label'));
    await page.$eval(sel('stage-0-label'), (el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '未完成');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '未完成', isComposing: true }));
    });
    await h.clickId('editor-name-button');
    await h.waitId('editor-submit-error');
    if (await h.exists('exercise-name-picker')) throw new Error('F3 IME 组合中仍打开了名称选择器');
    if ((await h.val('stage-0-label')) !== '未完成') throw new Error('F3 IME 未完成 raw 丢失');
    await page.$eval(sel('stage-0-label'), (el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '未完成' }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '未完成' }));
    });
    await h.pickCustom('普通三组B');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
  });

  await runCase('E06 F3独立restSec(211!=151)未改整轮休息保留与明确修改同步；F4未完成轮数7.不伪造7轮也不回A', '/?probe=editor', async (h, page) => {
    // F3-1: 带入 M (restSec=211, restAfterSec=151)，不改整轮休息直接保存 → 保留 restSec=211
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('独立休息多阶段M');
    if ((await h.val('editor-round-rest')) !== '151') throw new Error('M 的 restAfterSec 未显示 151');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
    const m1 = await page.evaluate(() => window.__m02Probe.calls()[0]);
    if (m1.restSec !== 211 || m1.target.restAfterSec !== 151) {
      throw new Error(`F3 未改整轮休息却丢了独立 restSec: restSec=${m1.restSec}, restAfterSec=${m1.target.restAfterSec}`);
    }

    // F3-2: 明确修改整轮休息 151→180 → restSec 与 restAfterSec 同步为 180
    await page.evaluate(() => window.__m02Probe.openCase('straightA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('独立休息多阶段M');
    await h.fillId('editor-round-rest', '180');
    await h.clickId('editor-save');
    await page.waitForFunction(() => window.__m02Probe.calls().length === 1);
    const m2 = await page.evaluate(() => window.__m02Probe.calls()[0]);
    if (m2.restSec !== 180 || m2.target.restAfterSec !== 180) {
      throw new Error(`F3 明确修改整轮休息后未同步: restSec=${m2.restSec}, restAfterSec=${m2.target.restAfterSec}`);
    }

    // F4: 从 3 轮 A 切到 1 轮/8 阶段 B，输入未完成 "7." → raw 保留 "7."，不出现 7 轮也不回退到 A 的 3 轮，且阻止提交
    await page.evaluate(() => window.__m02Probe.openCase('threeRoundA'));
    await h.waitId('exercise-editor');
    await h.pickCustom('八阶段老动作');
    if ((await h.val('editor-rounds')) !== '1') throw new Error('B 应带入 1 轮');
    await h.fillId('editor-rounds', '7.');
    if ((await h.val('editor-rounds')) !== '7.') throw new Error('未完成轮数 raw "7." 丢失');
    const roundTabs = await page.$$eval('[data-testid^="round-tab-"]', (a) => a.length);
    if (roundTabs !== 0) throw new Error('未完成轮数 "7." 不应生成轮次 tab，实际 ' + roundTabs);
    await h.clickId('editor-save');
    await sleep(60);
    if ((await page.evaluate(() => window.__m02Probe.calls().length)) !== 0) throw new Error('未完成轮数 "7." 竟然允许提交');
  });

  await runCase('A01 真实App替换B与临时添加B同源深复制+保存仅本次vs更新默认反馈与持久化', '/', async (h, page) => {
    await h.openEditorBySwipe('ex-clean');
    await h.pickCustom('胸托划船');
    await h.waitId('editor-template-applied');
    await h.clickId('editor-save');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'));
    await sleep(120);
    if (!(await h.bodyText()).includes('已保存本次调整')) throw new Error('未提示“已保存本次调整”');

    let s = await page.evaluate(() => window.__m02App.getSession());
    const rowId = await page.evaluate(() => window.__m02App.exerciseIdFromName('胸托划船'));
    const replaced = s.exercises.find((e) => e.id === 'ex-clean');
    if (!replaced || replaced.exerciseId !== rowId || replaced.restSec !== 105 || replaced.en) {
      throw new Error('替换后数据错误: ' + JSON.stringify(replaced));
    }
    const r2Rest = await page.evaluate(async () => {
      const sess = await window.__m02App.getSession();
      const ex = sess.exercises.find((e) => e.id === 'ex-clean');
      return window.__m02App.roundRestInSecOf(ex.target, 2);
    });
    if (r2Rest !== 25) throw new Error('落库后第2轮 restInSec 丢失: ' + r2Rest);
    const tpls1 = await page.evaluate(async () => (await window.__m02App.getTemplates()).templates);
    const rowTpl1 = tpls1.find((t) => t.exerciseId === rowId);
    if (rowTpl1.revision !== 1 || rowTpl1.restSec !== 105) throw new Error('未勾更新却改动了动作默认模板');

    // 重新打开勾选更新默认 → 改整轮休息 112 → 提示更新默认 → 临时添加同 B 用 112
    await h.openEditorBySwipe('ex-clean');
    await h.fillId('editor-round-rest', '112');
    await h.clickId('editor-remember');
    await h.clickId('editor-save');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'));
    await sleep(120);
    if (!(await h.bodyText()).includes('已保存，并更新此动作的默认配置')) throw new Error('未提示更新默认配置');

    await h.clickText('+ 临时加动作');
    await h.waitId('exercise-name-picker');
    await h.fillId('name-custom-input', '胸托划船');
    await h.clickId('name-custom-apply');
    await sleep(250);
    s = await page.evaluate(() => window.__m02App.getSession());
    const added = s.exercises.filter((e) => e.exerciseId === rowId);
    if (added.length !== 2 || added[0].id === added[1].id) throw new Error('临时添加与替换实例 ID 未独立');
    if (added[1].restSec !== 112) throw new Error('更新默认后临时添加未带入 112: ' + added[1].restSec);
    if (added[1].sets.some((x) => x.reps !== null || x.weightKg !== null || x.status !== 'blank')) throw new Error('新实例未保持空 actual');
  });

  await runCase('A02 真实App A→B→C只写C + CAS冲突保草稿 + 已有actual影响确认/取消', '/', async (h, page) => {
    // 1) A → B(胸托划船) → C(目标C动作) 勾选更新 → 只写 C，不动 B
    await h.openEditorBySwipe('ex-clean');
    await h.pickCustom('胸托划船');
    await h.pickCustom('目标C动作');
    await h.fillId('editor-rest', '155');
    await h.clickId('editor-remember');
    await h.clickId('editor-save');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'));
    const rowId = await page.evaluate(() => window.__m02App.exerciseIdFromName('胸托划船'));
    const cId = await page.evaluate(() => window.__m02App.exerciseIdFromName('目标C动作'));
    const tpls = await page.evaluate(async () => (await window.__m02App.getTemplates()).templates);
    const bTpl = tpls.find((t) => t.exerciseId === rowId);
    const cTpl = tpls.find((t) => t.exerciseId === cId);
    if (bTpl.revision !== 1 || cTpl.revision !== 2 || cTpl.restSec !== 155) throw new Error('A→B→C 写入对象错误');

    // 2) CAS 冲突：打开 C（捕获 rev=2）→ 后台写 rev=3 → 勾选更新保存 → 冲突失败保草稿
    await h.openEditorBySwipe('ex-clean');
    await page.evaluate(async (targetCId) => {
      const snap = await window.__m02App.getTemplates();
      const c = snap.templates.find((t) => t.exerciseId === targetCId);
      await window.__m02App.putTemplate({ ...c, restSec: 166 }, c.revision);
    }, cId);
    await h.fillId('editor-rest', '177');
    await h.clickId('editor-remember');
    await h.clickId('editor-save');
    await h.waitId('editor-submit-error');
    if ((await h.val('editor-rest')) !== '177') throw new Error('CAS 冲突后草稿丢失');
    await h.clickId('editor-cancel');
    await h.waitId('leave-discard');
    await h.clickId('leave-discard');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'));

    // 3) 已有 actual 替换：选名不写库；确认影响取消不变，确认后同卡保留 actual
    await h.openEditorBySwipe('ex-actual');
    await h.pickCustom('目标C动作');
    const beforeConfirm = await page.evaluate(async () => (await window.__m02App.getSession()).exercises.find((e) => e.id === 'ex-actual'));
    if (beforeConfirm.name !== '已有记录A') throw new Error('选名阶段竟然写库');
    await h.clickId('editor-save');
    await h.waitId('confirm-cancel');
    await h.clickId('confirm-cancel');
    if (!(await h.exists('exercise-editor'))) throw new Error('影响确认取消后关闭了编辑器');
    await h.clickId('editor-save');
    await h.waitId('confirm-ok');
    await h.clickId('confirm-ok');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-editor"]'));
    const after = await page.evaluate(async () => (await window.__m02App.getSession()).exercises.find((e) => e.id === 'ex-actual'));
    if (after.exerciseId !== cId || after.planExerciseId !== null || after.replacedFrom !== '已有记录A') {
      throw new Error('确认后身份/来源未更新: ' + JSON.stringify(after));
    }
    const r1s1 = after.sets.find((x) => x.roundIndex === 1 && x.stageIndex === 1);
    if (!r1s1 || r1s1.id !== 'act-1' || r1s1.reps !== 10 || r1s1.weightKg !== 50) {
      throw new Error('确认后既有 actual/set ID 未保留: ' + JSON.stringify(r1s1));
    }
  });

  await runCase('A03 真实IDB存在损坏模板行：禁止静默当first并阻断错误替换', '/?corrupt=1', async (h, page) => {
    await h.openEditorBySwipe('ex-clean');
    await h.waitId('editor-template-error');
    await h.pickCustom('胸托划船');
    const nameText = await h.text('editor-name-button');
    if (!nameText.includes('原动作无记录')) throw new Error('坏模板条件下仍替换成了 B: ' + nameText);
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nM02 APP: ${result.cases.length - failures.length}/${result.cases.length} passed; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
