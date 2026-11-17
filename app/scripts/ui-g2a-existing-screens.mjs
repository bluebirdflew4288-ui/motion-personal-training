#!/usr/bin/env node
/* G2A：采集现有训练页 / 工具 / 临时添加配置流程截图（隔离 profile + 合成数据）。
   仅用于 G2B 接线对照，不是验收；失败非零退出。 */

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { g2aExistingEntry } from './dom-regression/g2a-entry.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.MOTION_G2A_EVIDENCE_DIR || '/private/tmp/motion-editor-20261031/g2a/existing';
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
    stdin: { contents: g2aExistingEntry, resolveDir: APP_DIR, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), __AUDIT_STRICT__: 'false', __MOTION_NATIVE__: 'false', __MOTION_BUILD_TARGET__: JSON.stringify('web') },
    nodePaths: [join(APP_DIR, 'node_modules')], logLevel: 'silent',
    plugins: [{
      name: 'external-fonts',
      setup(b) { b.onResolve({ filter: /^\/fonts\// }, (args) => ({ path: args.path, external: true })); },
    }],
  });
  const js = built.outputFiles[0].contents;
  await writeFile(join(OUT, 'harness.js'), js);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/app.js')) { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (req.url.startsWith('/style.css')) { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (req.url.startsWith('/fonts/')) {
      try {
        const buf = await readFile(join(APP_DIR, 'public', req.url.split('?')[0]));
        res.setHeader('Content-Type', 'font/woff2');
        res.end(buf);
      } catch { res.statusCode = 404; res.end(); }
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: join(OUT, 'chrome-profile'), args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__booted === true || window.__bootError, { timeout: 20000 });
  await page.waitForFunction(() => (document.body.innerText || '').includes('工具'), { timeout: 8000 });
  await sleep(300);
  const shots = [];
  const shot = async (name) => { await page.screenshot({ path: join(SHOTS, name) }); shots.push(join(SHOTS, name)); };
  await shot('existing-01-training-page.png');
  const clickText = async (text) => page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('button'));
    const el = all.find((b) => (b.textContent || '').trim() === t);
    if (!el) throw new Error('button not found: ' + t);
    el.click();
  }, text);
  await clickText('工具');
  await sleep(300);
  await shot('existing-02-tools.png');
  const addBtn = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button'));
    const el = all.find((b) => (b.textContent || '').includes('临时加动作'));
    if (!el) return false;
    el.click();
    return true;
  });
  if (!addBtn) throw new Error('临时加动作 button not found');
  await sleep(300);
  await shot('existing-03-add-picker.png');
  const picked = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.sheet-panel .row'));
    if (!rows.length) return false;
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  });
  if (!picked) throw new Error('picker row not found');
  await sleep(300);
  await shot('existing-04-add-config.png');
  const styled = await page.evaluate(() => {
    const btn = document.querySelector('button.btn');
    const sheet = document.querySelector('.sheet-panel');
    return {
      hasBtnStyle: btn ? getComputedStyle(btn).fontFamily.includes('PingFang') || getComputedStyle(btn).borderRadius !== '2px' : false,
      hasSheetStyle: sheet ? getComputedStyle(sheet).position === 'fixed' || getComputedStyle(sheet).borderRadius !== '0px' : false,
    };
  });
  const result = { suite: 'g2a-existing-screens', ok: errors.length === 0, stylesLoaded: true, styleProbe: styled, errors, screenshots: shots };
  await writeFile(join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close();
  server.close();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
