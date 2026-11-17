#!/usr/bin/env node
/* G2A 真实 DOM 验证（R6 修正版）：
   · 载入**真实样式**（tokens/base/zine 原文件，经 /style.css 注入）；
   · 导入实际 ExerciseEditor 组件；
   · 每个用例重置 submitMode/pending/计数器；
   · 聚焦 + 键盘输入（不是只改 value setter）；
   · 覆盖 legit 8 阶段、嵌套 Esc、composition、同实例 key 切换与 remount。
   任一断言失败 → 非零退出。 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g2aEntry } from './dom-regression/g2a-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G2A_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g2a/dom';
const SHOTS = join(OUT, 'screens');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(SHOTS, { recursive: true });
  await mkdir(join(OUT, 'chrome-profile'), { recursive: true });

  const css = (
    await Promise.all(['tokens', 'base', 'zine'].map((n) => readFile(join(APP_DIR, 'src/styles', `${n}.css`), 'utf8')))
  ).join('\n');

  const built = await esbuild.build({
    stdin: { contents: g2aEntry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __AUDIT_STRICT__: process.env.MOTION_G2A_STRICT === '1' ? 'true' : 'false',
      __MOTION_NATIVE__: 'false',
      __MOTION_BUILD_TARGET__: JSON.stringify('web'),
    },
    nodePaths: [join(APP_DIR, 'node_modules')],
    logLevel: 'silent',
  });
  const js = built.outputFiles[0].contents;
  await writeFile(join(OUT, 'harness.js'), js);

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
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      );
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
  const result = { suite: 'g2a-exercise-editor', stylesLoaded: true, cases: [], screenshots: [], errors: [] };
  const page = await browser.newPage();
  page.on('pageerror', (e) => result.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') result.errors.push('console: ' + m.text()); });
  await page.setViewport({ width: 390, height: 844 });

  const sel = (id) => `[data-testid="${id}"]`;
  const pause = (ms) => sleep(ms);
  const openCase = async (name, { remount = true, mode = 'ok' } = {}) => {
    await page.evaluate((c, r, m) => { window.__audit.reset(m); window.__audit.open(c, r); }, name, remount, mode);
    await page.waitForSelector(sel('exercise-editor'), { timeout: 4000 });
    await pause(40);
  };
  const fill = async (id, text) => {
    await page.$eval(sel(id), (el) => { el.focus(); el.select(); });
    await page.keyboard.type(text);
  };
  const val = (id) => page.$eval(sel(id), (el) => el.value);
  const checked = (id) => page.$eval(sel(id), (el) => el.checked);
  const click = async (id) => { await page.waitForSelector(sel(id), { timeout: 3000 }); await page.click(sel(id)); };
  const save = () => page.evaluate(() => document.querySelector('[data-testid="editor-save"]').click());
  const calls = () => page.evaluate(() => window.__audit.calls());
  const closes = () => page.evaluate(() => window.__audit.closes());
  const openKey = () => page.evaluate(() => window.__audit.openCase());
  const has = async (id) => (await page.$(sel(id))) !== null;
  const textOf = (id) => page.$eval(sel(id), (el) => el.textContent || '');
  const shot = async (name) => { await page.screenshot({ path: join(SHOTS, name), fullPage: false }); result.screenshots.push(join(SHOTS, name)); };

  const check = async (name, fn) => {
    try {
      await fn();
      result.cases.push({ name, ok: true });
      console.log('  ✔ ' + name);
    } catch (err) {
      let debug = {};
      try {
        debug = await page.evaluate(() => ({
          open: window.__audit.openCase(),
          calls: window.__audit.calls().length, lastCall: window.__audit.calls().at(-1),
          closes: window.__audit.closes(),
          pending: window.__audit.pendingCount(),
          body: (document.body.innerText || '').slice(0, 200),
        }));
      } catch { /* ignore */ }
      result.cases.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err), debug });
      console.log('  ✘ ' + name + ' :: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__audit);

  // ── 真实样式生效（R6/R7）：列名可见、输入框有项目样式
  await check('真实样式已载入：可见列名 + 输入框项目样式', async () => {
    await openCase('multi');
    const body = await page.evaluate(() => document.body.innerText);
    for (const label of ['重量 kg', '次数下限', '次数上限']) {
      if (!body.includes(label)) throw new Error('缺少可见列名: ' + label);
    }
    const bg = await page.$eval(sel('stage-0-weight'), (el) => getComputedStyle(el).borderRadius + '|' + getComputedStyle(el).fontSize);
    if (bg.startsWith('0px') && !bg.includes('16px')) throw new Error('输入框未套用项目样式: ' + bg);
    await shot('01-editor-real-styles.png');
  });

  await check('R1 旧数据：阶段身份 stage-pos-N + 短间歇回退 restInSec=15，保存后 actual/set.id 全保留', async () => {
    await openCase('legacy');
    if ((await val('stage-0-rest')) !== '15') throw new Error('旧阶段短间歇应回退 15，实际 ' + (await val('stage-0-rest')));
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    const ids = call.payload.target.stages.map((s) => s.id);
    if (JSON.stringify(ids) !== JSON.stringify(['stage-pos-1', 'stage-pos-2', 'stage-pos-3'])) {
      throw new Error('旧阶段身份应为 stage-pos-N，实际 ' + JSON.stringify(ids));
    }
    const applied = await page.evaluate((p) => window.__audit.apply(p), call.payload);
    if (!applied.applied) throw new Error('应用配置被影响确认拦截');
    if (applied.impact.removedWithData.length) throw new Error('误判删除已输入阶段');
    const sets = applied.exercise.sets.map((s) => ({ id: s.id, reps: s.reps }));
    if (JSON.stringify(sets) !== JSON.stringify([1, 2, 3].map((i) => ({ id: 'actual-' + i, reps: 10 + i })))) {
      throw new Error('actual/set.id 丢失: ' + JSON.stringify(sets));
    }
  });

  await check('R1 旧数据仅改名称/休息保存：阶段与 actual 不受影响（无影响确认）', async () => {
    await openCase('legacy');
    await fill('stage-0-label', '上半程');
    await fill('stage-0-rest', '20');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    const applied = await page.evaluate((p) => window.__audit.apply(p), call.payload);
    if (!applied.applied || applied.impact.needsConfirmation) throw new Error('仅改名/休息却要求确认删除');
    if (applied.exercise.sets.length !== 3) throw new Error('阶段数变化');
  });

  await check('R3 聚焦末字段未 blur 直接保存：payload 为 20–25', async () => {
    await openCase('multi');
    await fill('stage-0-reps-min', '20');
    await fill('stage-0-reps-max', '25');
    const focused = await page.$eval(sel('stage-0-reps-max'), (el) => document.activeElement === el);
    if (!focused) throw new Error('末字段未保持聚焦');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.target.stages[0].repsMin !== 20 || call.payload.target.stages[0].repsMax !== 25) {
      throw new Error('未 blur 的输入未进入 payload');
    }
  });

  await check('R3 未完成小数 "7." 阻止提交并保留 raw', async () => {
    await openCase('multi');
    await fill('stage-0-weight', '7.');
    await save();
    await pause(120);
    if ((await calls()).length !== 0) throw new Error('未完成小数被提交');
    if ((await val('stage-0-weight')) !== '7.') throw new Error('raw 丢失');
    if (!(await has('exercise-editor'))) throw new Error('编辑器被关闭');
  });

  await check('R3 composition 中禁止提交；完成后保存 label 完整', async () => {
    await openCase('multi');
    await page.focus(sel('stage-0-label'));
    await page.$eval(sel('stage-0-label'), (el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '上半程组合');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '上半程组合', isComposing: true }));
    });
    await save();
    await pause(120);
    if ((await calls()).length !== 0) throw new Error('组合中仍提交');
    if (!(await has('editor-submit-error'))) throw new Error('缺少组合中提示');
    await page.$eval(sel('stage-0-label'), (el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '上半程组合' }));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: '上半程组合' }));
    });
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.target.stages[0].label !== '上半程组合') throw new Error('组合结束后 label 不完整');
  });

  for (const remount of [false, true]) {
    await check(`R2 迟到成功不关闭/不锁定 B（${remount ? 'remount' : 'same-instance-key'}）`, async () => {
      await openCase('a', { mode: 'manual' });
      await save();
      await page.waitForFunction(() => window.__audit.pendingCount() === 1, { timeout: 2000 });
      if (remount) await page.evaluate(() => window.__audit.open('b', true));
      else await page.evaluate(() => window.__audit.switchKey('b'));
      await page.waitForFunction(() => (window.__audit.openCase() || '').includes('b'));
      await page.evaluate(() => window.__audit.resolve({ ok: true }));
      await pause(150);
      if ((await closes()).length !== 0) throw new Error('迟到成功关闭了 B');
      if (!(await has('exercise-editor'))) throw new Error('B 被关闭');
      await page.evaluate(() => window.__audit.setMode('ok'));
      await save();
      await page.waitForFunction(() => window.__audit.calls().length === 2, { timeout: 2000 });
      const list = await calls();
      if (!list[1].origin.includes('b')) throw new Error('B 第二次提交归属错误: ' + list[1].origin);
      if (await has('exercise-editor')) throw new Error('B 保存成功后应关闭');
    });
  }

  await check('R2 迟到失败不污染 B 的错误状态', async () => {
    await openCase('a', { mode: 'manual' });
    await save();
    await page.waitForFunction(() => window.__audit.pendingCount() === 1, { timeout: 2000 });
    await page.evaluate(() => window.__audit.switchKey('b'));
    await page.waitForFunction(() => (window.__audit.openCase() || '').includes('b'));
    await page.evaluate(() => window.__audit.resolve({ ok: false, message: 'A 的迟到失败' }));
    await pause(150);
    if (await has('editor-submit-error')) throw new Error('A 的失败提示污染了 B');
    if ((await closes()).length !== 0) throw new Error('A 的失败关闭了 B');
  });

  await check('R2 关闭后重新打开同 key：初始化为调用方最新值', async () => {
    await openCase('straight4');
    await fill('editor-sets', '5');
    await page.evaluate(() => window.__audit.hide());
    await pause(60);
    await page.evaluate(() => window.__audit.reset('ok'));
    await page.evaluate(() => window.__audit.open('straight4', false));
    await page.waitForSelector(sel('exercise-editor'));
    await pause(60);
    if ((await val('editor-sets')) !== '4') throw new Error('同 key 重开未回到最新初始值: ' + (await val('editor-sets')));
  });

  await check('R2 父级 tick 同 key：保留 raw', async () => {
    await openCase('multi');
    await fill('stage-0-label', '父级tick测试');
    await page.evaluate(() => window.__audit.tick(true));
    await pause(250);
    if ((await val('stage-0-label')) !== '父级tick测试') throw new Error('tick 后 raw 丢失');
    await page.evaluate(() => window.__audit.tick(false));
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.target.stages[0].label !== '父级tick测试') throw new Error('tick 后保存值错误');
  });

  await check('R4 合法旧 8 阶段无改动可保存且不截断', async () => {
    await openCase('eight');
    const rows = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (rows !== 8) throw new Error('阶段行数应为 8，实际 ' + rows);
    if (await has('editor-target-errors')) throw new Error('8 阶段被校验拒绝');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.target.stages.length !== 8) throw new Error('保存后阶段数被截断');
    await shot('02-editor-eight-stages.png');
  });

  await check('R4 新增阶段 UI 上限仍为 6（超过则不出现新行）', async () => {
    await openCase('multi');
    const before = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (before !== 3) throw new Error('初始阶段数异常');
    for (let i = 0; i < 5; i += 1) {
      if (await has('editor-add-stage')) await click('editor-add-stage').catch(() => {});
    }
    const after = await page.$$eval('[data-testid^="stage-row-"]', (a) => a.length);
    if (after > 6) throw new Error('新增阶段超过 6: ' + after);
  });

  await check('R5 嵌套 Esc 只关最上层：picker → leave → leave，dirty 保留', async () => {
    await openCase('multi');
    await fill('stage-0-label', '上半程');
    await click('editor-name-button');
    await page.waitForSelector(sel('exercise-name-picker'));
    await page.keyboard.press('Escape');
    await pause(120);
    if (await has('exercise-name-picker')) throw new Error('Esc 未关闭名称选择器');
    if (await has('leave-continue')) throw new Error('一次 Esc 同时打开了离开确认层');
    if ((await openKey()) === null) throw new Error('名称选择器关闭时把编辑器一起关了');
    await page.keyboard.press('Escape');
    await page.waitForSelector(sel('leave-continue'));
    await page.keyboard.press('Escape');
    await pause(120);
    if (await has('leave-continue')) throw new Error('第二次 Esc 未关闭离开确认层');
    if ((await openKey()) === null) throw new Error('离开确认层关闭时把编辑器一起关了');
    if ((await val('stage-0-label')) !== '上半程') throw new Error('dirty raw 丢失');
  });

  await check('R5 遮罩点击同样只处理一层', async () => {
    await openCase('multi');
    await fill('stage-0-label', '遮罩层测试');
    await page.evaluate(() => {
      const backdrops = document.querySelectorAll('.sheet-backdrop');
      const last = backdrops[backdrops.length - 1];
      if (last) last.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForSelector(sel('leave-continue'));
    if ((await openKey()) === null) throw new Error('遮罩关闭把编辑器一起关了');
    await click('leave-continue');
    if ((await val('stage-0-label')) !== '遮罩层测试') throw new Error('继续编辑后 raw 丢失');
  });

  await check('组快照末阶段休息：第1阶段15，末阶段90', async () => {
    await openCase('legacy');
    const rests = await page.evaluate(() => window.__audit.snapshotRest());
    if (JSON.stringify(rests) !== JSON.stringify([15, 90])) throw new Error('组快照休息错误: ' + JSON.stringify(rests));
  });

  await check('R7 记忆勾选计入 dirty：取消离开不绕过保护', async () => {
    await openCase('multi');
    await click('editor-remember');
    if (!(await checked('editor-remember'))) throw new Error('记忆勾选失败');
    await click('editor-cancel');
    await page.waitForSelector(sel('leave-continue'), { timeout: 2000 });
    await click('leave-continue');
  });

  await check('各阶段力竭独立 + null 参考次数显示空且可编辑', async () => {
    await openCase('multi');
    if ((await val('stage-2-reps-min')) !== '') throw new Error('第3阶段下限应为空');
    if (!(await checked('stage-2-failure'))) throw new Error('第3阶段力竭应为开');
    const disabled = await page.$eval(sel('stage-2-reps-min'), (el) => el.disabled);
    if (disabled) throw new Error('力竭阶段次数输入被禁用');
    await click('stage-0-failure');
    if (!(await checked('stage-0-failure'))) throw new Error('第1阶段力竭开关失败');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    const flags = call.payload.target.stages.map((s) => s.toFailure);
    if (JSON.stringify(flags) !== JSON.stringify([true, true, true])) throw new Error('阶段力竭不独立: ' + JSON.stringify(flags));
  });

  await check('名称选择只改名称/身份，不覆盖其他参数；自定义名称与过长提示', async () => {
    await openCase('straight4');
    await fill('group-0-reps-min', '6');
    await fill('group-0-reps-max', '9');
    await click('editor-name-button');
    await page.waitForSelector(sel('exercise-name-picker'));
    await fill('name-search', '卧推');
    await page.waitForSelector(sel('name-option-0'));
    await click('name-option-0');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
    if ((await val('group-0-reps-min')) !== '6' || (await val('group-0-reps-max')) !== '9') throw new Error('名称选择覆盖了参数');
    await click('editor-name-button');
    await fill('name-custom-input', '自定义测试动作');
    await click('name-custom-apply');
    await page.waitForFunction(() => !document.querySelector('[data-testid="exercise-name-picker"]'));
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.name !== '自定义测试动作') throw new Error('自定义名称未保存');

    await openCase('long');
    await save();
    await pause(120);
    if (!(await has('error-name'))) throw new Error('过长名称缺少普通提示');
    if (!(await textOf('error-name')).includes('名称过长')) throw new Error('提示应为“名称过长”');
    if ((await calls()).length !== 0) throw new Error('过长名称仍提交');
  });

  await check('普通组各组力竭独立 + 形式切换保口径不倍增 + 初始 4 组不丢', async () => {
    await openCase('straight4');
    await click('group-0-failure');
    await click('group-1-failure');
    if ((await val('editor-sets')) !== '4') throw new Error('初始组数应来自实际安排 4');
    await click('editor-form-dropSet');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call] = await calls();
    if (call.payload.target.weightMode !== 'assisted' || call.payload.target.dumbbellBasis !== 'per_hand') throw new Error('重量口径丢失');
    if (call.payload.target.rounds !== 4) throw new Error('轮数倍增: ' + call.payload.target.rounds);

    await openCase('straight4');
    await click('group-0-failure');
    await click('group-1-failure');
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    const [call2] = await calls();
    const flags = call2.payload.target.perSetConfigs.map((c) => c.toFailure);
    if (JSON.stringify(flags) !== JSON.stringify([true, true, false, false])) throw new Error('每组力竭不独立: ' + JSON.stringify(flags));
    if (call2.payload.target.perSetConfigs.length !== 4) throw new Error('第4组被删');
  });

  await check('连点保存只调用一次；失败保留草稿可重试', async () => {
    await openCase('straight4');
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="editor-save"]');
      b.click(); b.click(); b.click();
    });
    await page.waitForFunction(() => window.__audit.calls().length === 1, { timeout: 2000 });
    if ((await calls()).length !== 1) throw new Error('连点重复提交');

    await openCase('straight4', { mode: 'fail' });
    await fill('group-0-reps-min', '6');
    await save();
    await page.waitForSelector(sel('editor-submit-error'), { timeout: 2000 });
    if ((await val('group-0-reps-min')) !== '6') throw new Error('失败后 raw 丢失');
    await page.evaluate(() => window.__audit.setMode('ok'));
    await save();
    await page.waitForFunction(() => window.__audit.calls().length === 2, { timeout: 2000 });
  });

  await check('390px 窄屏长名称：可滚动、无横向溢出、按钮完整', async () => {
    await openCase('long');
    const metrics = await page.$eval(sel('exercise-editor'), (el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      width: el.getBoundingClientRect().width,
      docWidth: document.documentElement.scrollWidth,
    }));
    if (metrics.width > 390 || metrics.docWidth > 390) throw new Error('横向溢出: ' + JSON.stringify(metrics));
    if (metrics.clientHeight <= 0) throw new Error('编辑器不可见');
    const btn = await page.$eval(sel('editor-save'), (el) => el.getBoundingClientRect().width);
    if (btn < 80) throw new Error('保存按钮被截断');
    await shot('03-narrow-long-real-styles.png');
  });

  const failures = result.cases.filter((c) => !c.ok);
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
  console.log(`\nG2A DOM: ${result.cases.length - failures.length}/${result.cases.length} passed; screenshots=${result.screenshots.length}; errors=${result.errors.length}`);
  if (failures.length || result.errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
