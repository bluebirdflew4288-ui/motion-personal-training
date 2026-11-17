#!/usr/bin/env node
/* F11 真实 Chrome 验证：删除成功音的**调用边界**与设置开关。
   ── 这份脚本证明什么、不证明什么 ─────────────────────────────
   证明：在真实浏览器 + 真实 IndexedDB 下，
     · 只有真实删除保存成功后才调用 Web Audio（且每个意图一次）；
     · 关闭开关后删除照样成功，但一次都不调用音频；
     · 连续删除两项 → 两次；F09 满位停留 → 一次触感调用，松手后一次成功音；
     · 设置页开关真实落库、文案明确，且休息提醒区块仍在（互不影响）；
     · 音效只请求本站离线资源，没有任何外部网络音频请求。
   不证明：用户听到了声音（headless 无音频输出），也不代表 Android 静音/勿扰行为。
   AudioContext 被替换为**计数器替身**，因此"调用了几次"可判定，"响了没有"不可判定。

   用法：MOTION_UI_EVIDENCE_DIR=<绝对目录> node scripts/ui-f11-feedback-check.mjs
*/
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g3bEntry } from './dom-regression/g3b-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_UI_EVIDENCE_DIR
  ? resolve(process.env.MOTION_UI_EVIDENCE_DIR, 'f11-feedback')
  : resolve(APP_DIR, '../_evidence-f11');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id) => `[data-testid="${id}"]`;

/** 音频替身：只记录"被调用了几次"，不产生任何声音 */
const AUDIO_STUB = `
window.__soundLog = { contexts: 0, resumes: 0, decodes: 0, starts: 0, stops: 0, vibrates: 0, lastStartAt: 0 };
class FakeSource {
  constructor() { this.buffer = null; this.onended = null; }
  connect() { return undefined; }
  start() { window.__soundLog.starts += 1; window.__soundLog.lastStartAt = Date.now(); }
  stop() { window.__soundLog.stops += 1; }
}
class FakeAudioContext {
  constructor() { window.__soundLog.contexts += 1; this.state = 'running'; this.destination = {}; }
  async resume() { window.__soundLog.resumes += 1; this.state = 'running'; }
  createBufferSource() { return new FakeSource(); }
  async decodeAudioData() { window.__soundLog.decodes += 1; return {}; }
}
window.AudioContext = FakeAudioContext;
window.webkitAudioContext = FakeAudioContext;
navigator.vibrate = () => { window.__soundLog.vibrates += 1; return true; };
`;

/**
 * 在**本脚本内**给既有 fixture 补上设置读写入口（不改动共享 fixture 文件）。
 * 两处替换都必须命中，否则直接失败：宁可报错，也不要静默跑一个什么都没验证的用例。
 */
function buildEntry() {
  const withApi = g3bEntry
    .replace(
      "import { ensureSeed, listPlans, getSession } from './src/db/repo';",
      "import { ensureSeed, listPlans, getSession, loadSettings, saveSettings } from './src/db/repo';",
    )
    .replace(
      'window.__booted = true;',
      'window.__settingsApi = async () => ({ loadSettings, saveSettings });\n  window.__booted = true;',
    );
  if (withApi === g3bEntry || !withApi.includes('__settingsApi')) {
    throw new Error('fixture 注入失败：g3b-entry 结构已变化，请更新本脚本的替换锚点');
  }
  return withApi;
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
  const audioBytes = await readFile(join(APP_DIR, 'public/audio/delete-success.wav'));

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
      try {
        res.setHeader('Content-Type', 'font/woff2');
        res.end(await readFile(join(APP_DIR, 'public', url)));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    } else if (url === '/audio/delete-success.wav') {
      res.setHeader('Content-Type', 'audio/wav');
      res.end(audioBytes);
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
    args: ['--no-first-run', '--disable-extensions'],
  });

  const results = { suite: 'f11-delete-feedback', browser: await browser.version(), cases: [], scope: 'Web Audio 调用边界与开关；不证明用户听到声音' };

  async function newPage() {
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('request', (r) => requests.push(r.url()));
    await page.evaluateOnNewDocument(AUDIO_STUB);
    await page.setViewport({ width: 360, height: 760, isMobile: true, hasTouch: true });
    await page.goto(base);
    await page.waitForFunction(() => window.__booted || window.__bootError);
    const bootError = await page.evaluate(() => window.__bootError);
    if (bootError) throw new Error(bootError);
    /**
     * T01：等真实训练页首张卡**真正渲染**后再返回本页，确保后续操作都发生在 App 可用之后。
     *
     * <p>只等 `window.__booted` 不够：`__booted` 在 `createRoot.render(...)` 之后同步置位，
     * 而 React 的 `useRoute` effect 是异步挂载的。若此时立刻改 hash 到设置页，
     * 首次 `useRoute` 的初值会解析成 `#/settings`，但模块级 `currentHash` 仍被 fixture 的
     * `navigate('/session/...')` 种成 session。随后「返回训练页」命中
     * `targetHash === currentHash` 早退：URL 显示 `#/session/...`，视图却停在设置页（DOM 不更新）。
     * 这是**自动化在 App 可用前抢跳**造成的竞态，不是生产 router 缺陷（真实用户无法在首绘前操作）。
     *
     * <p>因此这里只多等一次**真实卡片出现**（条件等待，不是固定 sleep），
     * 不删任何断言、不改变生产 router，也不掩盖任何产品行为。
     */
    await page.waitForSelector(sel('exercise-card-g3b-ex-2'), { timeout: 8000 });
    return { ctx, page, errors, requests };
  }

  /**
   * 真实鼠标左滑打开某张卡的操作区。
   *
   * 坐标与步进沿用本仓库已放行的 G3B 手势套件（同一 fixture、同一 Chrome），
   * 并且**断言操作层真的可点**：没打开就明确失败，绝不"点了没反应还算通过"。
   */
  async function swipeOpen(page, testId) {
    const el = await page.$(sel(`exercise-card-${testId}`));
    if (!el) throw new Error(`找不到卡片 ${testId}`);
    await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await sleep(150);
    const box = await el.boundingBox();
    const y = box.y + 20;
    const x = box.x + box.width * 0.7;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 150, y, { steps: 12 });
    await page.mouse.up();
    await sleep(360);
    const pe = await page.$eval(sel(`exercise-card-${testId}-delete`), (b) => getComputedStyle(b.parentElement).pointerEvents);
    if (pe !== 'auto') throw new Error(`左滑未打开操作区（pointerEvents=${pe}）`);
  }

  async function waitForUndo(page, timeout = 4000) {
    await page.waitForSelector(sel('delete-undo-stack'), { timeout });
  }

  async function soundLog(page) {
    return page.evaluate(() => window.__soundLog);
  }

  /* ── case 1：空白动作点击删除 → 只有 saved 之后一次成功音 ── */
  {
    const { ctx, page, errors, requests } = await newPage();
    const record = { case: 'F11-A1-blank-click-delete-plays-once', errors, ok: false };
    try {
      // 删除前：一次音频调用都没有（不存在提前解锁）
      const before = await soundLog(page);
      record.before = before;
      if (before.contexts !== 0 || before.starts !== 0) throw new Error('删除前已经碰过音频 API');

      const exists = await page.evaluate(async () => {
        const s = await window.__db.getSession('g3b-session');
        return s.exercises.some((e) => e.id === 'g3b-ex-2');
      });
      if (!exists) throw new Error('种子卡不存在');

      await swipeOpen(page, 'g3b-ex-2');
      await page.click(sel('exercise-card-g3b-ex-2-delete'));
      await waitForUndo(page);
      await sleep(400);
      const after = await soundLog(page);
      record.after = after;
      record.undoRows = await page.$$eval(sel('delete-undo-row'), (n) => n.length);
      record.gone = await page.evaluate(async () => {
        const s = await window.__db.getSession('g3b-session');
        return !s.exercises.some((e) => e.id === 'g3b-ex-2');
      });
      record.audioRequests = requests.filter((u) => u.includes('/audio/delete-success.wav'));
      // 只统计真正的网络请求：data:/blob: 是本页内联资源，不是外部依赖
      record.externalRequests = requests.filter((u) => /^https?:/i.test(u) && !u.startsWith(base));
      record.ok =
        after.starts === 1 &&
        after.decodes === 1 &&
        record.undoRows === 1 &&
        record.gone === true &&
        record.audioRequests.length === 1 &&
        record.externalRequests.length === 0 &&
        errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── case 2：关闭开关 → 删除照样成功，但零次音频 ── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'F11-A2-disabled-still-deletes-but-silent', errors, ok: false };
    try {
      // 走真实设置页关闭（而不是直接改库），顺带验证开关落库
      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });
      await page.waitForFunction(() => document.body.innerText.includes('删除成功音效'), { timeout: 4000 });
      const toggle = await page.$('[aria-label="删除成功音效开关"]');
      if (!toggle) throw new Error('找不到音效开关');
      record.beforeLabel = await page.$eval('[aria-label="删除成功音效开关"]', (e) => e.textContent);
      await toggle.click();
      await sleep(400);
      record.afterLabel = await page.$eval('[aria-label="删除成功音效开关"]', (e) => e.textContent);
      record.persisted = await page.evaluate(async () => {
        const { loadSettings } = await window.__settingsApi();
        return (await loadSettings()).soundEnabled;
      });
      // 回到训练页删除
      await page.evaluate(() => {
        window.location.hash = '#/session/g3b-session';
      });
      await page.waitForSelector(sel('exercise-card-g3b-ex-2'), { timeout: 4000 });
      await swipeOpen(page, 'g3b-ex-2');
      await page.click(sel('exercise-card-g3b-ex-2-delete'));
      await waitForUndo(page);
      await sleep(400);
      const log = await soundLog(page);
      record.soundLog = log;
      record.gone = await page.evaluate(async () => {
        const s = await window.__db.getSession('g3b-session');
        return !s.exercises.some((e) => e.id === 'g3b-ex-2');
      });
      record.ok =
        record.beforeLabel === '已开启' &&
        record.afterLabel === '已关闭' &&
        record.persisted === false &&
        log.starts === 0 &&
        log.contexts === 0 &&
        record.gone === true &&
        errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── case 3：连续删除两项 → 两次 ── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'F11-A3-two-consecutive-deletes-two-sounds', errors, ok: false };
    try {
      for (const id of ['g3b-ex-2', 'g3b-ex-3']) {
        await swipeOpen(page, id);
        await page.click(sel(`exercise-card-${id}-delete`));
        await waitForUndo(page);
        await sleep(350);
      }
      const log = await soundLog(page);
      record.soundLog = log;
      record.undoRows = await page.$$eval(sel('delete-undo-row'), (n) => n.length);
      record.counts = await page.$eval(sel('delete-undo-counts'), (e) => e.textContent);
      record.ok = log.starts === 2 && record.undoRows === 2 && errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── case 4：F09 满位停留 → 一次触感；松手 → 一次成功音 ── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'F11-A4-f09-hold-single-haptic-then-one-sound', errors, ok: false };
    try {
      const el = await page.$(sel('exercise-card-g3b-ex-2'));
      await el.evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await sleep(150);
      const box = await el.boundingBox();
      const y = box.y + 20;
      const x = box.x + box.width * 0.7;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 150, y, { steps: 12 });
      await sleep(900); // 超过 750ms 就绪阈值
      const mid = await soundLog(page);
      record.vibratesBeforeRelease = mid.vibrates;
      record.readyBanner = await page.$(sel('exercise-card-g3b-ex-2-ready-banner')) !== null;
      record.startsBeforeRelease = mid.starts;
      await page.mouse.up();
      await sleep(600);
      const after = await soundLog(page);
      record.soundLog = after;
      record.ok =
        mid.vibrates === 1 &&
        record.readyBanner === true &&
        mid.starts === 0 &&
        after.starts === 1 &&
        errors.length === 0;
      if (!record.ok) throw new Error('断言未通过');
    } catch (e) {
      record.failure = String(e);
    }
    results.cases.push(record);
    await ctx.close();
  }

  /* ── case 5：设置页开关往返 + 休息提醒区块仍在（互不影响） ── */
  {
    const { ctx, page, errors } = await newPage();
    const record = { case: 'F11-A5-settings-toggle-roundtrip-independent', errors, ok: false };
    try {
      await page.evaluate(() => {
        window.location.hash = '#/settings';
      });
      await page.waitForFunction(() => document.body.innerText.includes('交互反馈'), { timeout: 4000 });
      const text = await page.evaluate(() => document.body.innerText);
      record.hasIndependentCopy = text.includes('不影响') && text.includes('组间休息提醒');
      record.hasSection = text.includes('删除成功音效');
      const readLabel = () => page.$eval('[aria-label="删除成功音效开关"]', (e) => e.textContent);
      record.labelStart = await readLabel();
      await (await page.$('[aria-label="删除成功音效开关"]')).click();
      await sleep(350);
      record.labelOff = await readLabel();
      record.persistedOff = await page.evaluate(async () => {
        const { loadSettings } = await window.__settingsApi();
        return (await loadSettings()).soundEnabled;
      });
      await (await page.$('[aria-label="删除成功音效开关"]')).click();
      await sleep(350);
      record.labelOn = await readLabel();
      record.persistedOn = await page.evaluate(async () => {
        const { loadSettings } = await window.__settingsApi();
        return (await loadSettings()).soundEnabled;
      });
      record.ok =
        record.labelStart === '已开启' &&
        record.labelOff === '已关闭' &&
        record.persistedOff === false &&
        record.labelOn === '已开启' &&
        record.persistedOn === true &&
        record.hasSection === true &&
        record.hasIndependentCopy === true &&
        errors.length === 0;
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
  console.log(`\nF11 VERIFICATION: ${results.summary} passed.`);
  console.log(`证据：${OUT}`);
  if (passed !== results.cases.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
