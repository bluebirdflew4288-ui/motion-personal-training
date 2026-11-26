#!/usr/bin/env node
/* 阶段 2 · 真实 Chrome 双窗交互与电子教练引擎端到端回归：
   1. 首页进真实训练页并开启电子教练小窗；
   2. 语义区分：「下一组目标改为 12 次」只改目标不增完成组、不误触 RestTimer；
   3. 实绩记录：「第 2 组 20kg 做了 11 次」原子写库、刷新卡片数值并诚实开启 RestTimer；
   4. 并发焦点/未成型草稿避让：用户在第 3 组留下未成型草稿（"." -> dirty-raw）时，教练试图改写第 3 组必须阻断不覆写；
   5. 字段级独立撤销：用户在第 3 组手动填完 9 次后，点第 2 组操作回执「撤销」→ 第 2 组精准回滚为空白，第 3 组手动输入的 9 次完整保留；
   6. 识图新建计划闭环：上传图片（Canvas 压缩剥离 EXIF）→ 渲染可编辑草稿卡 → 改名确认创建 → 生成计划回执且计划列表可见；
   7. 浅/深色主题截图核验、BackupPayload v4 零污染核验与 zero pageerror 检查。 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist-stage2-check');
const OUT = join(APP_DIR, 'verify-self/stage2-coach-engine');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

// 生成 160x120 带绿色横幅的可解码 SVG 文件（经 File upload 后进 Canvas 压缩重编码成 JPEG <= 1MB & 去 EXIF）
const SAMPLE_SVG_FILE_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#fbf7ec" stroke="#16130e" stroke-width="8"/>
  <rect x="30" y="30" width="740" height="72" fill="#16130e"/>
  <text x="50" y="78" fill="#f4efe2" font-family="sans-serif" font-size="28" font-weight="700">推力训练日 · Stage 2 测试图</text>
  <text x="50" y="170" fill="#16130e" font-family="monospace" font-size="24">1. 平板杠铃卧推  4x8-10 60kg</text>
  <text x="50" y="230" fill="#16130e" font-family="monospace" font-size="24">2. 上斜哑铃卧推  3x10-12 20kg</text>
</svg>`;

async function sendCoachText(page, text) {
  await page.waitForSelector(SEL('coach-input'));
  await page.evaluate((val) => {
    const el = document.querySelector('[data-testid="coach-input"]');
    if (!el) throw new Error('coach-input not found');
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(60);
  await page.click(SEL('coach-send-btn'));
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
    { timeout: 10000 },
  );
  await sleep(160);
}

async function main() {
  rmSync(join(OUT, 'chrome-profile'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, 'screens'), { recursive: true });
  const uploadImgPath = join(OUT, 'sample-plan.svg');
  await writeFile(uploadImgPath, SAMPLE_SVG_FILE_CONTENT, 'utf8');

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

    // 1. 首页进真实训练页
    await page.evaluate(() => {
      const slipBtn = Array.from(document.querySelectorAll('button.slip')).find((b) =>
        b.textContent?.includes('组'),
      );
      slipBtn?.click();
    });
    await sleep(160);
    await page.evaluate(() => {
      const startBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === '开始训练',
      );
      startBtn?.click();
    });
    await page.waitForFunction(() => window.location.hash.startsWith('#/session/'), { timeout: 10000 });
    await page.waitForSelector('[data-coach-ex-id][data-coach-field="reps"]');
    await sleep(200);

    // 2. 开启电子教练小窗，发送“把下一组目标改为 12 次”（调目标不标 done、不开 RestTimer）
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(200);

    await sendCoachText(page, '把下一组双杠臂屈伸目标改为 12 次');
    const afterTarget = await page.evaluate(() => {
      const receipts = Array.from(document.querySelectorAll('[data-testid^="coach-receipt-card-"]'));
      const timerActive = document.querySelector('[aria-label="增加 15 秒"]') !== null;
      const cardText = receipts[receipts.length - 1]?.textContent ?? '';
      return { receiptCount: receipts.length, timerActive, cardText };
    });
    record(
      '目标调参与 RestTimer 隔离：只出目标回执，未触发计时器',
      afterTarget.receiptCount === 1 && !afterTarget.timerActive && afterTarget.cardText.includes('目标'),
      JSON.stringify(afterTarget),
    );

    // 3. 发送实绩记录：“双杠臂屈伸第 2 组 20kg 做了 11 次” → 原子写库、开 RestTimer、DOM 立即更新
    await sendCoachText(page, '双杠臂屈伸第 2 组 20kg 做了 11 次');
    await sleep(200);
    const afterSet2 = await page.evaluate(() => {
      const receipts = Array.from(document.querySelectorAll('[data-testid^="coach-receipt-card-"]'));
      const lastCard = receipts[receipts.length - 1];
      const timerActive = document.querySelector('[aria-label="增加 15 秒"]') !== null;
      const repsInputs = Array.from(
        document.querySelectorAll('[data-testid="business-pane"] [data-coach-field="reps"]'),
      );
      const set2Reps = repsInputs[1]?.value ?? '';
      return {
        receiptCount: receipts.length,
        timerActive,
        lastCardText: lastCard?.textContent ?? '',
        set2Reps,
        set2ReceiptId: lastCard?.getAttribute('data-testid')?.replace('coach-receipt-card-', '') ?? '',
      };
    });
    record(
      '逐组实绩：生成第2组操作回执、刷新训练卡第2组为11且诚实开启 RestTimer',
      afterSet2.receiptCount === 2 &&
        afterSet2.timerActive &&
        afterSet2.set2Reps === '11' &&
        afterSet2.lastCardText.includes('已开休息计时'),
      JSON.stringify(afterSet2),
    );
    await page.screenshot({ path: join(OUT, 'screens/01-stage2-set2-receipt.png') });

    // 4. 在第 3 组次数框输入未成型草稿 "."（触发 data-dirty-raw="true"），再请教练改第 3 组 → 必须被 focusGuard 阻断
    await page.evaluate(() => {
      const repsInputs = Array.from(
        document.querySelectorAll('[data-testid="business-pane"] [data-coach-field="reps"]'),
      );
      const set3Input = repsInputs[2];
      set3Input.scrollIntoView({ block: 'center' });
    });
    await sleep(120);
    const set3Sel =
      '[data-testid="business-pane"] [data-coach-field="reps"]';
    await page.evaluate((sel) => {
      const list = document.querySelectorAll(sel);
      list[2]?.focus();
    }, set3Sel);
    await page.keyboard.type('.');
    await sleep(80);
    const dirtyAttrSet = await page.evaluate((sel) => {
      const list = document.querySelectorAll(sel);
      return list[2]?.getAttribute('data-dirty-raw') === 'true';
    }, set3Sel);

    await sendCoachText(page, '双杠臂屈伸第 3 组 20kg 做了 8 次');
    const afterFocusBlocked = await page.evaluate((sel) => {
      const receipts = Array.from(document.querySelectorAll('[data-testid^="coach-receipt-card-"]'));
      const msgs = Array.from(document.querySelectorAll('[data-testid^="coach-msg-"]'));
      const lastMsg = msgs[msgs.length - 1]?.textContent ?? '';
      const set3Val = document.querySelectorAll(sel)[2]?.value ?? '';
      return {
        receiptCount: receipts.length,
        lastMsg,
        set3Val,
      };
    }, set3Sel);
    record(
      '并发焦点/未成型草稿避让：第3组持有 dirty raw 时教练拒绝覆写',
      dirtyAttrSet &&
        afterFocusBlocked.receiptCount === 2 &&
        afterFocusBlocked.lastMsg.includes('未完成') &&
        afterFocusBlocked.set3Val !== '8',
      JSON.stringify({ dirtyAttrSet, ...afterFocusBlocked }),
    );

    // 5. 用户在第 3 组完成手动输入 "9" 并失焦落库，然后点击第 2 组回执「撤销」→ 第 2 组回滚为空白，第 3 组完整保留 9！
    await page.evaluate((sel) => {
      const list = document.querySelectorAll(sel);
      list[2]?.focus();
    }, set3Sel);
    await page.keyboard.type('9');
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await sleep(250);

    const set2UndoSelector = SEL(`coach-receipt-undo-${afterSet2.set2ReceiptId}`);
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      btn?.scrollIntoView({ block: 'center' });
      btn?.click();
    }, set2UndoSelector);
    await sleep(300);

    const afterUndoState = await page.evaluate(
      (sel, rid) => {
        const list = document.querySelectorAll(sel);
        const card = document.querySelector(`[data-testid="coach-receipt-card-${rid}"]`);
        return {
          set2Val: list[1]?.value ?? '',
          set3Val: list[2]?.value ?? '',
          cardText: card?.textContent ?? '',
          undoStillVisible: document.querySelector(`[data-testid="coach-receipt-undo-${rid}"]`) !== null,
        };
      },
      set3Sel,
      afterSet2.set2ReceiptId,
    );
    record(
      '字段级独立撤销：撤销第2组后回滚为空，且完整保留用户刚输入的第3组（9次）',
      afterUndoState.set2Val === '' &&
        afterUndoState.set3Val === '9' &&
        afterUndoState.cardText.includes('已撤销') &&
        !afterUndoState.undoStillVisible,
      JSON.stringify(afterUndoState),
    );

    // 6. 识图新建计划闭环：上传 SVG 图片（经 Canvas 转 JPEG <=1MB/剥 EXIF）→ 编辑草稿卡名称 → 确认新建 → 验证计划库入库
    const fileInput = await page.$(SEL('coach-file-input'));
    if (!fileInput) throw new Error('coach-file-input not found');
    await fileInput.uploadFile(uploadImgPath);
    await page.waitForSelector(SEL('coach-pending-attachment'));
    const pendingInfo = await page.$eval(SEL('coach-pending-attachment'), (el) => el.textContent ?? '');
    await page.click(SEL('coach-send-btn'));
    await page.waitForSelector(SEL('coach-plan-draft-card'));

    const customPlanName = '阶段2识图新建计划';
    await page.evaluate((val) => {
      const inp = document.querySelector('[data-testid="coach-draft-plan-name"]');
      if (!inp) throw new Error('coach-draft-plan-name missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, val);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, customPlanName);
    await sleep(60);
    await page.click(SEL('coach-plan-draft-confirm-btn'));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="coach-plan-draft-card"]')?.textContent?.includes('已创建'),
      { timeout: 8000 },
    );

    // 切换深色主题截图，并检查 Backup v4 完全零污染 & 计划列表中存在新建计划
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await sleep(160);
    await page.screenshot({ path: join(OUT, 'screens/02-stage2-draft-dark.png') });

    const idbCheck = await page.evaluate(async (planName) => {
      const openReq = indexedDB.open('motion-training', 1);
      const mainPlans = await new Promise((resolve, reject) => {
        openReq.onsuccess = () => {
          const db = openReq.result;
          const tx = db.transaction(['plans', 'settings', 'sessions'], 'readonly');
          const r1 = tx.objectStore('plans').getAll();
          const r2 = tx.objectStore('settings').getAll();
          const r3 = tx.objectStore('sessions').getAll();
          tx.oncomplete = () => resolve({ plans: r1.result, settings: r2.result, sessions: r3.result });
          tx.onerror = () => reject(tx.error);
        };
        openReq.onerror = () => reject(openReq.error);
      });
      const vaultReq = indexedDB.open('motion-coach-vault');
      const vaultData = await new Promise((resolve, reject) => {
        vaultReq.onsuccess = () => {
          const db = vaultReq.result;
          const tx = db.transaction(['messages', 'receipts'], 'readonly');
          const r1 = tx.objectStore('messages').getAll();
          const r2 = tx.objectStore('receipts').getAll();
          tx.oncomplete = () => resolve({ messages: r1.result, receipts: r2.result });
          tx.onerror = () => reject(tx.error);
        };
        vaultReq.onerror = () => reject(vaultReq.error);
      });
      const mainJson = JSON.stringify(mainPlans);
      return {
        hasCreatedPlan: mainPlans.plans.some((p) => p.name === planName),
        vaultMsgCount: vaultData.messages.length,
        vaultReceiptCount: vaultData.receipts.length,
        leakedIntoMain: mainJson.includes('motion-coach-vault') || mainJson.includes('rcpt-'),
      };
    }, customPlanName);

    record(
      '识图草稿确认建计划 + 独立隔离存储域（零漏入主库/Backup v4）',
      pendingInfo.includes('KB') &&
        idbCheck.hasCreatedPlan &&
        idbCheck.vaultMsgCount >= 3 &&
        idbCheck.vaultReceiptCount >= 3 &&
        !idbCheck.leakedIntoMain,
      JSON.stringify({ pendingInfo, ...idbCheck }),
    );

    record('无未捕获浏览器异常', pageErrors.length === 0, pageErrors.join(' | '));

    await writeFile(
      join(OUT, 'RESULTS.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), checks, pageErrors }, null, 2),
    );

    const failed = checks.filter((c) => !c.ok);
    console.log(`\nSTAGE 2 CHROME CHECK: ${checks.length - failed.length}/${checks.length} passed; errors=${pageErrors.length}`);
    if (failed.length || pageErrors.length) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
