#!/usr/bin/env node
/* 阶段 1 · 真实 Chrome 交互与荣耀小窗手感回归：
   1. 覆盖首页、计划、计划日、历史、统计、设置与真实训练页的顶栏入口与 48dp 独立热区；
   2. 真实训练页打开小窗：无全屏遮罩，窗外训练表第一次点击直接生效；
   3. 标题栏拖拽移动、底部把手上滑缩小/下拉放大（等比缩放、48dp 互换热区不随内容缩小）；
   4. 最小化为侧边入口与原位恢复；
   5. 生成中一键互换主屏↔小窗：训练页绝不卸载（计时/输入/滚动完整保留），教练草稿/流式/滚动完整保留，小窗态 --safe-top:0px；
   6. 独立语义（关闭/取消生成/撤销示例）、显式复制、图片大图预览、深色主题截图证据。 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist-stage1-check');
const OUT = join(APP_DIR, 'verify-self/stage1-coach-shell');
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

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, 'screens'), { recursive: true });

  // 构建最新 Android 目标产物（无 SW，贴近真机 WebView 资源）
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

    // 1. 主要页面均具备 ≥48×48 顶栏入口按钮
    const routeList = ['/#/', '/#/plans', '/#/history', '/#/stats', '/#/settings'];
    const routeBoxes = [];
    for (const r of routeList) {
      await page.evaluate((hash) => { window.location.hash = hash.slice(1); }, r);
      await page.waitForSelector(SEL('coach-header-btn'));
      await sleep(120);
      const box = await page.$eval(SEL('coach-header-btn'), (el) => {
        const rc = el.getBoundingClientRect();
        return { w: rc.width, h: rc.height };
      });
      routeBoxes.push({ r, ...box });
    }
    const allHeader48 = routeBoxes.every((b) => b.w >= 48 && b.h >= 48);
    record('主要页面顶栏均具 ≥48px 教练入口热区', allHeader48, JSON.stringify(routeBoxes));

    // 回首页，开启小窗并截首页小窗图
    await page.evaluate(() => { window.location.hash = '#/'; });
    await page.waitForSelector(SEL('coach-header-btn'));
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(220);
    await page.screenshot({ path: join(OUT, 'screens/01-home-with-mini.png') });

    // 先通过顶部横条菜单关闭教练，再从首页进入真实训练页（点训练日卡 → 点弹层内「开始训练」）
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-handle-menu'));
    await page.click(SEL('floating-close-btn'));
    await sleep(220);
    await page.evaluate(() => {
      const slipBtn = Array.from(document.querySelectorAll('button.slip')).find((b) =>
        b.textContent?.includes('组'),
      );
      if (slipBtn) slipBtn.click();
    });
    await sleep(150);
    const started = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const startBtn = btns.find((b) => b.textContent?.trim() === '开始训练');
      if (startBtn) {
        startBtn.click();
        return true;
      }
      return false;
    });
    if (!started) throw new Error('首页弹层未找到「开始训练」按钮');
    await page.waitForFunction(() => window.location.hash.startsWith('#/session/'), { timeout: 10000 });
    await page.waitForSelector(SEL('coach-header-btn'));
    await sleep(250);

    // 2. 在训练页操作第一组：展开卡片 / 点「完成」触发 RestTimer / 修改重量或次数 / 滚动
    await page.evaluate(() => window.scrollTo(0, 120));
    await sleep(120);
    const scrollBeforeOpen = await page.evaluate(() => window.scrollY);
    // 打开教练小窗
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(220);
    await page.screenshot({ path: join(OUT, 'screens/02-session-with-mini.png') });

    // 2b. P1.1：开着教练小窗时点击训练页「结束」打开业务模态 Sheet，确认 Sheet z-index 高于小窗且确认按钮不被小窗遮挡
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('[data-testid="business-pane"] header button')).find(
        (b) => b.textContent?.trim() === '结束',
      );
      btn?.click();
    });
    await page.waitForSelector('.sheet-backdrop');
    await sleep(100);
    const sheetStackCheck = await page.evaluate(() => {
      const backdrop = document.querySelector('.sheet-backdrop');
      const mini = document.querySelector('[data-testid="coach-pane"]');
      const sheetClose = document.querySelector('.sheet-panel button[aria-label="关闭"]');
      const bz = backdrop ? Number(getComputedStyle(backdrop).zIndex) : 0;
      const mz = mini ? Number(getComputedStyle(mini).zIndex) : 0;
      const cr = sheetClose?.getBoundingClientRect();
      const hit = cr ? document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2) : null;
      return {
        bz,
        mz,
        hitInsideSheet: Boolean(hit && backdrop?.contains(hit) && !mini?.contains(hit)),
      };
    });
    record(
      '业务模态 Sheet z-index 严格高于教练小窗且控件不被遮挡',
      sheetStackCheck.bz > sheetStackCheck.mz && sheetStackCheck.hitInsideSheet,
      JSON.stringify(sheetStackCheck),
    );
    await page.click('.sheet-panel button[aria-label="关闭"]');
    await sleep(100);

    // 3. 验证无全屏遮罩：直接点击窗口外训练页的「完成」/「+15」或「+」按钮，第一下必须直接生效！
    const firstTapApplied = await page.evaluate(() => {
      const mini = document.querySelector('[data-testid="coach-pane"]');
      const mr = mini.getBoundingClientRect();
      const buttons = Array.from(document.querySelectorAll('[data-testid="business-pane"] button'));
      // 找一个明显在小窗矩形之外的按钮（例如训练卡片内展开或完成/步进按钮）
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const outside = r.right < mr.left || r.left > mr.right || r.bottom < mr.top || r.top > mr.bottom;
        if (outside && (b.textContent?.includes('✓') || b.textContent?.trim() === '+' || b.getAttribute('aria-label')?.includes('完成'))) {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit && !mini.contains(hit)) {
            b.click();
            return { clicked: b.textContent?.trim() || b.getAttribute('aria-label'), ok: true };
          }
        }
      }
      return { ok: false };
    });
    await sleep(150);
    record('小窗开启时无遮罩，窗外业务控件第一下直接可点', firstTapApplied.ok, JSON.stringify(firstTapApplied));

    // 4. 去重极简横条：默认顶栏无常驻按钮，拖拽平稳移动、轻点顶部横条弹出菜单、轻点底部横条切换大小、上下拖动无极缩放
    const chromeAudit = await page.evaluate(() => {
      const cPane = document.querySelector('[data-testid="coach-pane"]');
      const chrome = cPane?.querySelector('[data-testid="coach-drag-handle"]');
      const permanentBtns = chrome ? chrome.querySelectorAll('button').length : -1;
      const menuInitiallyOpen = Boolean(cPane?.querySelector('[data-testid="floating-handle-menu"]'));
      return { permanentBtns, menuInitiallyOpen };
    });

    const rectInitial = await page.$eval(SEL('coach-pane'), (el) => {
      const r = el.getBoundingClientRect();
      const stage = el.querySelector('[data-pane-stage="true"]');
      return { x: r.left, y: r.top, w: r.width, h: r.height, scale: Number(stage.getAttribute('data-pane-scale')) };
    });

    const dragBox = await page.$eval(SEL('coach-drag-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(dragBox.cx, dragBox.cy);
    await page.mouse.down();
    await page.mouse.move(dragBox.cx - 48, dragBox.cy + 64, { steps: 6 });
    await page.mouse.up();
    await sleep(220);

    const rectAfterDrag = await page.$eval(SEL('coach-pane'), (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const dragMoved = rectAfterDrag.x < rectInitial.x - 15 && rectAfterDrag.y > rectInitial.y + 15;
    record(
      '极简顶栏去重、拖拽平稳移动小窗且未误触菜单',
      chromeAudit.permanentBtns === 0 && !chromeAudit.menuInitiallyOpen && dragMoved,
      `${JSON.stringify(chromeAudit)} (${rectInitial.x},${rectInitial.y}) -> (${rectAfterDrag.x},${rectAfterDrag.y})`,
    );

    // 轻点底部横条在标准宽度与放大视图间平滑切换
    await page.click(SEL('floating-resize-handle'));
    await sleep(240);
    const widthAfterBottomTap = await page.$eval(SEL('coach-pane'), (el) => el.getBoundingClientRect().width);
    await page.click(SEL('floating-resize-handle'));
    await sleep(240);
    const widthAfterBottomTapBack = await page.$eval(SEL('coach-pane'), (el) => el.getBoundingClientRect().width);

    // 轻点顶部横条弹出选项菜单并检查菜单项热区（完整 4 项：互换/最大化/最小化/关闭，已去掉重复的大小调节项）
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-handle-menu'));
    await sleep(180);
    const menuAudit = await page.$eval(SEL('coach-pane'), (el) => {
      const r = el.getBoundingClientRect();
      const stage = el.querySelector('[data-pane-stage="true"]');
      const swapR = el.querySelector('[data-testid="floating-swap-btn"]').getBoundingClientRect();
      const maxR = el.querySelector('[data-testid="floating-maximize-btn"]')?.getBoundingClientRect();
      const hasOldReset = Boolean(el.querySelector('[data-testid="floating-reset-size-btn"]'));
      const menuCount = el.querySelectorAll('[data-testid="floating-handle-menu"] button').length;
      return {
        w: r.width,
        scale: Number(stage.getAttribute('data-pane-scale')),
        swapW: swapR.width,
        swapH: swapR.height,
        hasMaxBtn: Boolean(maxR),
        hasOldReset,
        menuOpen: Boolean(el.querySelector('[data-testid="floating-handle-menu"]')),
        menuCount,
      };
    });
    await page.screenshot({ path: join(OUT, 'screens/03-mini-resized-small.png') });
    // 再点一次顶部横条收起菜单
    await page.click(SEL('coach-drag-handle'));
    await sleep(100);

    // 拖到右上角触发迷你悬浮窗（出现抬手进入感应角），松手进入 112px 迷你窗，再轻点复原
    const pipDragBox = await page.$eval(SEL('coach-drag-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(pipDragBox.cx, pipDragBox.cy);
    await page.mouse.down();
    await page.mouse.move(350, 26, { steps: 8 });
    await page.waitForSelector(SEL('floating-corner-pip-zone'));
    const cornerZoneText = await page.$eval(SEL('floating-corner-pip-zone'), (el) => el.textContent?.trim() ?? '');
    await page.mouse.up();
    await sleep(240);
    const pipEnteredState = await page.$eval(SEL('coach-pane'), (el) => ({
      w: Math.round(el.getBoundingClientRect().width),
      isPipClass: el.classList.contains('is-mini-pip'),
      hasShield: Boolean(el.querySelector('[data-testid="floating-pip-restore-shield"]')),
    }));
    await page.click(SEL('floating-pip-restore-shield'));
    await sleep(240);
    const pipRestoredState = await page.$eval(SEL('coach-pane'), (el) => ({
      w: Math.round(el.getBoundingClientRect().width),
      isPipClass: el.classList.contains('is-mini-pip'),
    }));

    // 上滑底部小横条：应立即关闭小窗
    const swipeCloseBox = await page.$eval(SEL('floating-resize-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(swipeCloseBox.cx, swipeCloseBox.cy);
    await page.mouse.down();
    await page.mouse.move(swipeCloseBox.cx, swipeCloseBox.cy - 64, { steps: 6 });
    await page.mouse.up();
    await sleep(240);
    const roleAfterSwipeUpClose = await page.$eval(SEL('coach-pane'), (el) => el.getAttribute('data-pane-role'));

    // 重新打开教练小窗
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(240);

    record(
      '底部横条轻点切换/上滑立即关闭 + 顶横条菜单4项含最大化 + 拖顶角进入迷你窗点按复原',
      widthAfterBottomTap - rectInitial.w >= 32 &&
        Math.abs(widthAfterBottomTapBack - rectInitial.w) <= 2 &&
        roleAfterSwipeUpClose === 'hidden' &&
        menuAudit.menuOpen &&
        menuAudit.menuCount === 4 &&
        menuAudit.hasMaxBtn &&
        !menuAudit.hasOldReset &&
        menuAudit.swapW >= 120 &&
        menuAudit.swapH >= 44 &&
        cornerZoneText.includes('抬手进入') &&
        pipEnteredState.w === 112 &&
        pipEnteredState.isPipClass &&
        pipEnteredState.hasShield &&
        !pipRestoredState.isPipClass &&
        Math.abs(pipRestoredState.w - rectInitial.w) <= 2,
      JSON.stringify({
        initialW: rectInitial.w,
        widthAfterBottomTap,
        widthAfterBottomTapBack,
        roleAfterSwipeUpClose,
        menuAudit,
        cornerZoneText,
        pipEnteredState,
        pipRestoredState,
      }),
    );

    // 下拉底部横条无极放大
    const resizeBox2 = await page.$eval(SEL('floating-resize-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(resizeBox2.cx, resizeBox2.cy);
    await page.mouse.down();
    await page.mouse.move(resizeBox2.cx, resizeBox2.cy + 140, { steps: 6 });
    await page.mouse.up();
    await sleep(220);

    const afterGrow = await page.$eval(SEL('coach-pane'), (el) => {
      const r = el.getBoundingClientRect();
      const stage = el.querySelector('[data-pane-stage="true"]');
      return { x: r.left, y: r.top, w: r.width, scale: Number(stage.getAttribute('data-pane-scale')) };
    });
    record('把手下拉等比放大', afterGrow.w > rectInitial.w && afterGrow.scale > rectInitial.scale, JSON.stringify(afterGrow));

    // 5. 通过顶部横条菜单最小化为侧边入口并原位恢复
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-handle-menu'));
    await page.click(SEL('floating-minimize-btn'));
    await page.waitForSelector(SEL('coach-minimized-pill'));
    await sleep(220);
    await page.screenshot({ path: join(OUT, 'screens/04-minimized-pill.png') });
    await page.click(SEL('coach-minimized-pill'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(240);
    const afterRestore = await page.$eval(SEL('coach-pane'), (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width };
    });
    record(
      '最小化为侧边入口后点击原位恢复',
      Math.abs(afterRestore.x - afterGrow.x) <= 2 && Math.abs(afterRestore.y - afterGrow.y) <= 2 && Math.abs(afterRestore.w - afterGrow.w) <= 2,
      JSON.stringify({ before: afterGrow, after: afterRestore }),
    );

    // 6. 教练输入草稿 + 触发流式回复 + 业务页滚动 + 生成中通过顶部横条菜单一键互换（不卸载训练页、保草稿与滚动）
    await page.evaluate(() => window.scrollTo(0, 160));
    await sleep(100);
    const scrollBeforeSwap = await page.evaluate(() => window.scrollY);
    await page.type(SEL('coach-input'), '卧推第3组感觉不错');
    await page.click(SEL('coach-send-btn'));
    await sleep(180);
    await page.evaluate(() => {
      const ta = document.querySelector('[data-testid="coach-input"]');
      if (ta) ta.focus();
    });
    await page.type(SEL('coach-input'), '继续下一组');

    const sessionHashBeforeSwap = await page.evaluate(() => window.location.hash);
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-handle-menu'));
    await page.click(SEL('floating-swap-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="primary"]`);
    await page.waitForSelector(`${SEL('business-pane')}[data-pane-role="mini"]`);
    await sleep(240);
    await page.screenshot({ path: join(OUT, 'screens/05-coach-primary-business-mini.png') });

    // 6b. P1.3：趁流式回复仍在进行中，立即验证按回车不重复发送（防重入），然后再验证业务小窗 4 项菜单与最小化胶囊
    const msgCountDuringStream = await page.$$eval('[data-testid^="coach-msg-"]', (els) => els.length);
    await page.focus(SEL('coach-input'));
    await page.keyboard.press('Enter');
    await sleep(60);
    const msgCountAfterEnter = await page.$$eval('[data-testid^="coach-msg-"]', (els) => els.length);

    // 轻点业务小窗顶部横条验证两端完全对称：业务小窗菜单同样具备完整 4 项（互换/大小/最小化/关闭），且可最小化为「训练」胶囊消除遮挡
    await page.click(SEL('business-drag-handle'));
    await page.waitForSelector(`${SEL('business-pane')} ${SEL('floating-handle-menu')}`);
    await sleep(120);
    const swappedCheck = await page.evaluate(() => {
      const bPane = document.querySelector('[data-testid="business-pane"]');
      const bStage = bPane?.querySelector('[data-pane-stage="true"]');
      const safeTopVal = bStage ? getComputedStyle(bStage).getPropertyValue('--safe-top').trim() : '';
      const scale = bStage ? Number(bStage.getAttribute('data-pane-scale')) : 1;
      const draftVal = document.querySelector('[data-testid="coach-input"]')?.value ?? '';
      const stopBtn = document.querySelector('[data-testid="coach-cancel-stream-btn"]');
      const bScroll = bPane?.querySelector('[data-pane-scroll="true"]');
      const bHasMinBtn = Boolean(bPane?.querySelector('[data-testid="floating-minimize-btn"]'));
      const bHasCloseBtn = Boolean(bPane?.querySelector('[data-testid="floating-close-btn"]'));
      const bHasSwapBtn = Boolean(bPane?.querySelector('[data-testid="floating-swap-btn"]'));
      const bHasMaxBtn = Boolean(bPane?.querySelector('[data-testid="floating-maximize-btn"]'));
      const cardLockAttr = bPane?.querySelector('[data-mini-pane-lock="true"]')?.getAttribute('data-mini-pane-lock') ?? null;
      return {
        hash: window.location.hash,
        scale,
        safeTopVal,
        draftVal,
        hasStopBtn: Boolean(stopBtn),
        businessScrollTop: bScroll ? bScroll.scrollTop : -1,
        bHasMinBtn,
        bHasCloseBtn,
        bHasSwapBtn,
        bHasMaxBtn,
        cardLockAttr,
      };
    });

    if (swappedCheck.hasStopBtn) {
      await page.click(SEL('coach-cancel-stream-btn'));
      await sleep(100);
    }
    const stillPrimaryAfterStop = await page.$eval(SEL('coach-pane'), (el) => el.getAttribute('data-pane-role'));

    // 在教练主屏下将业务小窗最小化为侧边「训练」胶囊，验证教练保持主屏无遮挡，再点胶囊恢复业务小窗
    await page.click(SEL('business-drag-handle'));
    await page.waitForSelector(`${SEL('business-pane')} ${SEL('floating-handle-menu')}`);
    await page.click(`${SEL('business-pane')} ${SEL('floating-minimize-btn')}`);
    await page.waitForSelector(SEL('coach-minimized-pill'));
    await sleep(220);
    const businessMinimizedState = await page.evaluate(() => ({
      coachRole: document.querySelector('[data-testid="coach-pane"]')?.getAttribute('data-pane-role') ?? null,
      businessRole: document.querySelector('[data-testid="business-pane"]')?.getAttribute('data-pane-role') ?? null,
      pillText: document.querySelector('[data-testid="coach-minimized-pill"]')?.textContent?.trim() ?? '',
    }));
    await page.click(SEL('coach-minimized-pill'));
    await page.waitForSelector(`${SEL('business-pane')}[data-pane-role="mini"]`);
    await sleep(240);

    record(
      '生成中互换：业务小窗同样具完整4项菜单(含最大化)与最小化胶囊+禁左滑+safe-top清零+滚动与草稿保留',
      swappedCheck.hash === sessionHashBeforeSwap &&
        swappedCheck.scale < 1 &&
        swappedCheck.safeTopVal === '0px' &&
        swappedCheck.draftVal === '继续下一组' &&
        swappedCheck.hasStopBtn &&
        swappedCheck.bHasMinBtn &&
        swappedCheck.bHasCloseBtn &&
        swappedCheck.bHasSwapBtn &&
        swappedCheck.bHasMaxBtn &&
        businessMinimizedState.coachRole === 'primary' &&
        businessMinimizedState.businessRole === 'hidden' &&
        businessMinimizedState.pillText.includes('训练') &&
        swappedCheck.cardLockAttr === 'true' &&
        scrollBeforeSwap > 50 &&
        Math.abs(swappedCheck.businessScrollTop - scrollBeforeSwap) <= 2,
      JSON.stringify({ ...swappedCheck, businessMinimizedState, scrollBeforeSwap }),
    );

    const miniBusinessClickOk = await page.evaluate(() => {
      const bPane = document.querySelector('[data-testid="business-pane"]');
      const plusBtn = Array.from(bPane?.querySelectorAll('button') ?? []).find(
        (b) => b.textContent?.trim() === '+',
      );
      if (!plusBtn) return false;
      plusBtn.click();
      return true;
    });
    await sleep(80);
    record(
      '生成中按回车不重复发送，且业务小窗内按钮可直接点击',
      msgCountDuringStream === msgCountAfterEnter && miniBusinessClickOk,
      JSON.stringify({ msgCountDuringStream, msgCountAfterEnter, miniBusinessClickOk }),
    );

    // 7. 独立语义：把业务小窗切回标准大小并拖到顶部右侧，再点撤销示例不关窗；大图预览；复制；关闭回业务主屏且保持滚动位置
    await page.click(SEL('floating-resize-handle'));
    await sleep(240);
    const bDrag = await page.$eval(SEL('business-drag-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(bDrag.cx, bDrag.cy);
    await page.mouse.down();
    await page.mouse.move(bDrag.cx, 78, { steps: 6 });
    await page.mouse.up();
    await sleep(180);

    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="coach-messages-scroll"]');
      if (box) box.scrollTop = 140;
    });
    await sleep(80);
    await page.click(SEL('coach-window-actions'));
    await page.click(SEL('coach-window-example-btn'));
    await page.evaluate(() => document.querySelector('[data-testid="coach-undo-demo-btn"]')?.click());
    await sleep(80);
    const undoText = await page.$eval(SEL('coach-undo-demo-btn'), (el) => el.textContent?.trim());
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="coach-att-preview-demo-u1"]');
      btn?.scrollIntoView({ block: 'start' });
      btn?.click();
    });
    await page.waitForSelector(SEL('coach-image-preview'));
    await page.click(SEL('coach-image-preview-close'));
    await sleep(80);
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="coach-copy-btn"]');
      btn?.scrollIntoView({ block: 'start' });
      btn?.click();
    });
    await sleep(80);

    // 深色主题截图（在教练主屏+业务小窗态下切 dark 验证可读性）
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(120);
    await page.screenshot({ path: join(OUT, 'screens/06-dark-mode-dual.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

    // 教练为主屏时点击关闭 -> 业务页回到主屏并保持滚动位置，且教练仅隐藏不卸载（再开保留记录与草稿）
    const msgCountBeforeClose = await page.$$eval('[data-testid^="coach-msg-"]', (els) => els.length);
    await page.click(SEL('coach-window-actions'));
    await page.click(SEL('coach-primary-close-btn'));
    await page.waitForSelector(`${SEL('business-pane')}[data-pane-role="primary"]`);
    await sleep(100);
    const businessRestored = await page.evaluate(() => ({
      role: document.querySelector('[data-testid="business-pane"]')?.getAttribute('data-pane-role') ?? null,
      coachRole: document.querySelector('[data-testid="coach-pane"]')?.getAttribute('data-pane-role') ?? null,
      scrollY: window.scrollY,
    }));

    // 重新打开教练小窗：原有聊天记录与草稿必须完整保留
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(100);
    const reopenedState = await page.evaluate(() => ({
      msgCount: document.querySelectorAll('[data-testid^="coach-msg-"]').length,
      draftVal: document.querySelector('[data-testid="coach-input"]')?.value ?? '',
    }));

    // 阶段 1 P2 收尾：小窗内开启图片预览后通过顶部横条菜单最小化再恢复，预览弹层应已自动清理不残留 backStack
    await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="coach-att-preview-demo-u1"]');
      btn?.scrollIntoView({ block: 'start' });
      btn?.click();
    });
    await page.waitForSelector(SEL('coach-image-preview'));
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-handle-menu'));
    await page.click(SEL('floating-minimize-btn'));
    await page.waitForSelector(SEL('coach-minimized-pill'));
    await sleep(220);
    await page.click(SEL('coach-minimized-pill'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(220);
    const previewAfterMinimizeRestore = await page.evaluate(
      () => document.querySelector('[data-testid="coach-image-preview"]') !== null,
    );

    // 阶段 1 新增：按住顶部横条拖到屏幕顶部中央，校验放大预览背板与松手全屏最大化，并支持从全屏左上角重开业务小窗
    const maxDragBox = await page.$eval(SEL('coach-drag-handle'), (el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    });
    await page.mouse.move(maxDragBox.cx, maxDragBox.cy);
    await page.mouse.down();
    await page.mouse.move(195, 26, { steps: 8 });
    await page.waitForSelector(SEL('floating-maximize-preview'));
    const maxPreviewText = await page.$eval(SEL('floating-maximize-preview'), (el) => el.textContent?.trim() ?? '');
    await page.mouse.up();
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="primary"]`);
    await sleep(220);
    const maximizedRoles = await page.evaluate(() => ({
      coachRole: document.querySelector('[data-testid="coach-pane"]')?.getAttribute('data-pane-role') ?? null,
      businessRole: document.querySelector('[data-testid="business-pane"]')?.getAttribute('data-pane-role') ?? null,
      headerText: document.querySelector('[data-testid="coach-primary-swap-btn"]')?.textContent?.trim() ?? '',
    }));
    await page.click(SEL('coach-primary-swap-btn'));
    await page.waitForSelector(`${SEL('business-pane')}[data-pane-role="mini"]`);
    await sleep(150);

    record(
      '停止生成/撤销示例/大图预览隐藏释放/关闭复用/回主屏保滚动/拖顶中松手最大化',
      stillPrimaryAfterStop === 'primary' &&
        undoText === '恢复示例' &&
        businessRestored.role === 'primary' &&
        businessRestored.coachRole === 'hidden' &&
        Math.abs(businessRestored.scrollY - scrollBeforeSwap) <= 2 &&
        reopenedState.msgCount === msgCountBeforeClose &&
        reopenedState.draftVal === '继续下一组' &&
        previewAfterMinimizeRestore === false &&
        maxPreviewText.includes('松手最大化') &&
        maximizedRoles.coachRole === 'primary' &&
        maximizedRoles.businessRole === 'hidden' &&
        maximizedRoles.headerText.includes('小窗'),
      JSON.stringify({
        stillPrimaryAfterStop,
        undoText,
        businessRestored,
        scrollBeforeSwap,
        msgCountBeforeClose,
        reopenedState,
        previewAfterMinimizeRestore,
        maxPreviewText,
        maximizedRoles,
      }),
    );

    record('无未捕获浏览器异常', pageErrors.length === 0, pageErrors.join(' | '));

    await writeFile(
      join(OUT, 'RESULTS.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), checks, pageErrors }, null, 2),
    );

    const failed = checks.filter((c) => !c.ok);
    console.log(`\nSTAGE 1 CHROME CHECK: ${checks.length - failed.length}/${checks.length} passed; errors=${pageErrors.length}`);
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
