#!/usr/bin/env node
/* 真实 Chrome 端到端回归：杠铃配片自动预填 + 删空重量 + 删除重加组 + 未完成的组沿用已填数值。 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist-plate-check');
const OUT = join(APP_DIR, 'verify-self/plate-inherit-regression');
const CHROME =
  process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEL = (id) => `[data-testid="${id}"]`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

async function setInputValue(page, selector, val) {
  await page.waitForSelector(selector);
  await page.evaluate(
    (s, nextVal) => {
      const el = document.querySelector(s);
      if (!(el instanceof HTMLInputElement)) throw new Error(`input not found: ${s}`);
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, nextVal);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    val,
  );
  await sleep(80);
}

async function clickButtonByText(page, text) {
  const clicked = await page.evaluate((targetText) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find((b) => b.textContent?.trim() === targetText);
    if (!btn || btn.disabled) return false;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  }, text);
  await sleep(160);
  return clicked;
}

async function applyPlateWeight(page, btnSelector, kgText) {
  await page.waitForSelector(btnSelector);
  await page.evaluate((s) => {
    const btn = document.querySelector(s);
    btn?.scrollIntoView({ block: 'center' });
    btn?.click();
  }, btnSelector);
  await page.waitForSelector(SEL('plate-calc-input'));
  await setInputValue(page, SEL('plate-calc-input'), kgText);
  await page.waitForSelector(SEL('plate-calc-apply'));
  await page.click(SEL('plate-calc-apply'));
  await sleep(220);
}

async function typeNthField(page, field, index, value) {
  const selector = `[data-testid="business-pane"] [data-coach-field="${field}"]`;
  await page.evaluate(
    (sel, idx) => {
      const el = document.querySelectorAll(sel)[idx];
      if (!(el instanceof HTMLInputElement)) throw new Error(`${sel}[${idx}] missing`);
      el.scrollIntoView({ block: 'center' });
      el.focus();
    },
    selector,
    index,
  );
  await sleep(50);
  const len = await page.evaluate(
    (sel, idx) => document.querySelectorAll(sel)[idx]?.value?.length ?? 0,
    selector,
    index,
  );
  for (let i = 0; i < len + 1; i++) {
    await page.keyboard.press('Backspace');
  }
  if (value) {
    await page.keyboard.type(value);
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await sleep(150);
}

async function readSetInputs(page, count = 3) {
  return page.evaluate((n) => {
    const reps = Array.from(
      document.querySelectorAll('[data-testid="business-pane"] [data-coach-field="reps"]'),
    )
      .slice(0, n)
      .map((el) => el.value);
    const weights = Array.from(
      document.querySelectorAll('[data-testid="business-pane"] [data-coach-field="weight"]'),
    )
      .slice(0, n)
      .map((el) => el.value);
    const dirtyWeight = Array.from(
      document.querySelectorAll('[data-testid="business-pane"] [data-coach-field="weight"]'),
    )
      .slice(0, n)
      .map((el) => el.getAttribute('data-dirty-raw') === 'true');
    const inheritDisabled = Boolean(
      Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === '未完成的组沿用已填数值',
      )?.disabled,
    );
    const timerActive = document.querySelector('[aria-label="增加 15 秒"]') !== null;
    return { reps, weights, dirtyWeight, inheritDisabled, timerActive };
  }, count);
}

async function main() {
  rmSync(join(OUT, 'chrome-profile'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  execFileSync('npx', ['vite', 'build'], {
    cwd: APP_DIR,
    stdio: 'pipe',
    env: { ...process.env, MOTION_TARGET: 'android', MOTION_OUT_DIR: DIST_DIR },
  });

  const server = createServer(async (req, res) => {
    const cleanPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = join(DIST_DIR, cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, ''));
    if (!existsSync(filePath)) filePath = join(DIST_DIR, 'index.html');
    try {
      const body = await readFile(filePath);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(OUT, 'chrome-profile'),
    args: ['--no-first-run', '--disable-extensions', '--no-sandbox'],
  });

  const checks = [];
  const pageErrors = [];
  const record = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector(SEL('coach-header-btn'));

    // 1. 进入训练页
    await page.evaluate(() => {
      const slipBtn = Array.from(document.querySelectorAll('button.slip')).find((b) =>
        b.textContent?.includes('组'),
      );
      slipBtn?.click();
    });
    await sleep(160);
    await clickButtonByText(page, '开始训练');
    await page.waitForFunction(() => window.location.hash.startsWith('#/session/'), { timeout: 10000 });
    await page.waitForSelector('[data-coach-ex-id][data-coach-field="reps"]');
    await sleep(160);

    // 展开带有「配片」功能的「自由杠铃卧推」动作卡片（第 1 个默认展开的动作是 bodyweight_plus 双杠臂屈伸）
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid^="exercise-card-"]'));
      const bench = cards.find((c) => c.textContent?.includes('自由杠铃卧推'));
      if (!bench) throw new Error('自由杠铃卧推 card not found');
      const toggleBtn = Array.from(bench.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === '记录',
      );
      toggleBtn?.scrollIntoView({ block: 'center' });
      toggleBtn?.click();
    });
    await page.waitForSelector('[data-testid^="plate-calc-btn-"]');
    await sleep(200);

    const plateBtnSel = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid^="plate-calc-btn-"]');
      return btn ? `[data-testid="${btn.getAttribute('data-testid')}"]` : null;
    });
    if (!plateBtnSel) throw new Error('plate-calc-btn not found');

    // 2. 第 1 组点配片填入 60kg → 自动预填第 2、3 组为 60kg；再给第 1 组填 4 次，点击「未完成的组沿用已填数值」
    await applyPlateWeight(page, plateBtnSel, '60');
    const afterPrefill = await readSetInputs(page, 3);
    record(
      '首组配片 60kg 自动预填第 1~3 组',
      afterPrefill.weights.every((w) => w === '60'),
      JSON.stringify(afterPrefill),
    );

    await typeNthField(page, 'reps', 0, '4');
    const clickedInherit1 = await clickButtonByText(page, '未完成的组沿用已填数值');
    const afterInherit1 = await readSetInputs(page, 3);
    record(
      '复现1：配片预填 60kg + 首组填 4 次后，沿用可正确补齐第 2/3 组为 60kg / 4次且不误触发计时',
      clickedInherit1 &&
        afterInherit1.reps.every((r) => r === '4') &&
        afterInherit1.weights.every((w) => w === '60') &&
        !afterInherit1.timerActive,
      JSON.stringify(afterInherit1),
    );

    // 3. 把第 2、3 组的 60kg 手动删空，再点「未完成的组沿用已填数值」→ 必须恢复 60kg 且清掉陈旧 rawDraft
    await typeNthField(page, 'weight', 1, '');
    await typeNthField(page, 'weight', 2, '');
    const afterClearWeights = await readSetInputs(page, 3);
    const clickedInherit2 = await clickButtonByText(page, '未完成的组沿用已填数值');
    const afterRecover = await readSetInputs(page, 3);
    record(
      '复现1b：手动删空第 2/3 组 60kg 后不假阻断，沿用可恢复全部为 60kg / 4次',
      !afterClearWeights.inheritDisabled &&
        afterClearWeights.weights[1] === '' &&
        afterClearWeights.weights[2] === '' &&
        clickedInherit2 &&
        afterRecover.weights.every((w) => w === '60') &&
        afterRecover.reps.every((r) => r === '4') &&
        afterRecover.dirtyWeight.every((d) => !d),
      JSON.stringify({ afterClearWeights, afterRecover }),
    );

    // 4. 删掉第 2、3 组再「+ 加一组」加回两遍 → 配片 65kg → 再沿用
    for (const aria of ['删除第 3 组', '删除第 2 组']) {
      await page.evaluate((label) => {
        const b = document.querySelector(`[aria-label="${label}"]`);
        b?.scrollIntoView({ block: 'center' });
        b?.click();
      }, aria);
      await sleep(120);
    }
    await clickButtonByText(page, '+ 加一组');
    await clickButtonByText(page, '+ 加一组');
    await applyPlateWeight(page, plateBtnSel, '65');
    const afterReaddPrefill = await readSetInputs(page, 3);
    const clickedInherit3 = await clickButtonByText(page, '未完成的组沿用已填数值');
    const afterReaddInherit = await readSetInputs(page, 3);
    record(
      '复现2：删除第 2/3 组重加并再次配片 65kg 后，沿用依然恢复第 2/3 组为 65kg / 4次',
      afterReaddPrefill.weights.every((w) => w === '65') &&
        clickedInherit3 &&
        afterReaddInherit.weights.every((w) => w === '65') &&
        afterReaddInherit.reps.every((r) => r === '4'),
      JSON.stringify({ afterReaddPrefill, afterReaddInherit }),
    );

    // 4b. 第 2 组次数与重量都删空（留下 "" rawDraft），此时点配片 70kg → 第 2 组立即恢复显示 70kg，再沿用恢复 4 次
    await typeNthField(page, 'reps', 1, '');
    await typeNthField(page, 'weight', 1, '');
    await applyPlateWeight(page, plateBtnSel, '70');
    const afterBlankThenPlate = await readSetInputs(page, 3);
    const clickedInheritAfter70 = await clickButtonByText(page, '未完成的组沿用已填数值');
    const afterInherit70 = await readSetInputs(page, 3);
    record(
      '复现补充：第 2 组删空后存在 "" rawDraft 时，第 1 组配片 70kg 仍可直接预填刷新且沿用补回 4 次',
      afterBlankThenPlate.weights[1] === '70' &&
        !afterBlankThenPlate.dirtyWeight[1] &&
        clickedInheritAfter70 &&
        afterInherit70.weights[1] === '70' &&
        afterInherit70.reps[1] === '4',
      JSON.stringify({ afterBlankThenPlate, afterInherit70 }),
    );

    // 5. 未成型小数 "." 依然严格阻断沿用，「放弃未完成输入」后解除阻断，随后沿用可补回 4 次
    await typeNthField(page, 'reps', 1, '.');
    const whileDot = await readSetInputs(page, 3);
    await clickButtonByText(page, '放弃未完成输入');
    const afterDiscardDot = await readSetInputs(page, 3);
    const clickedAfterDiscard = await clickButtonByText(page, '未完成的组沿用已填数值');
    const afterRecoverFromDot = await readSetInputs(page, 3);
    record(
      '安全红线：输入未成型小数 "." 时沿用按钮禁用保护，放弃未完成输入后解除并可正常沿用恢复',
      whileDot.inheritDisabled &&
        !afterDiscardDot.inheritDisabled &&
        afterDiscardDot.reps[1] === '' &&
        clickedAfterDiscard &&
        afterRecoverFromDot.reps[1] === '4',
      JSON.stringify({ whileDot, afterDiscardDot, afterRecoverFromDot }),
    );

    record('零 runtime pageerror', pageErrors.length === 0, JSON.stringify(pageErrors));
  } finally {
    await browser.close();
    server.close();
    rmSync(DIST_DIR, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n共 ${checks.length} 项检查，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
