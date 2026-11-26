#!/usr/bin/env node
/* 0.2.2 电子教练真实 Chrome E2E 回归：
   1. 解锁本地全权限执行：替换动作（双杠臂屈伸 -> 21响礼炮）、训练中备注、热身新增、器械档位备忘、直接完训（且完训回执不显示撤销按钮）；
   2. Hermes 长期记忆 UI 面板：打开、新增、数量角标更新与持久化；
   3. 联网开关（默认关）+ 模型设置中联网服务（Tavily）与 Key 保存持久化 + 真实 context_length 采集；
   4. Markdown 气泡排版（标题/表格/代码块/`3*10*12` 不误转斜体/`javascript:` 拦截）与实时上下文占用条/接口实测弹窗。 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist-coach-v2-check');
const OUT = join(APP_DIR, 'verify-self/coach-v2-check');
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

async function setReactInput(page, selector, val) {
  await page.waitForSelector(selector);
  await page.evaluate(
    (s, v) => {
      const el = document.querySelector(s);
      if (!el) throw new Error(`input not found: ${s}`);
      const proto =
        el.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    val,
  );
  await sleep(60);
}

async function sendCoachText(page, text) {
  await setReactInput(page, SEL('coach-input'), text);
  await page.click(SEL('coach-send-btn'));
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
    { timeout: 10000 },
  );
  await sleep(220);
}

async function readIdbActiveOrLatestSession(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('motion-training');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('sessions', 'readonly');
          const getAll = tx.objectStore('sessions').getAll();
          getAll.onsuccess = () => {
            const list = getAll.result || [];
            list.sort((a, b) => b.startedAt - a.startedAt);
            resolve(list[0] ?? null);
          };
          getAll.onerror = () => reject(getAll.error);
        };
      }),
  );
}

async function main() {
  rmSync(join(OUT, 'chrome-profile'), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, 'screens'), { recursive: true });

  execFileSync('npx', ['vite', 'build'], {
    cwd: APP_DIR,
    stdio: 'pipe',
    env: { ...process.env, MOTION_TARGET: 'android', MOTION_OUT_DIR: DIST_DIR },
  });

  const capturedChatRequests = [];
  const mockAiServer = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const cleanUrl = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && cleanUrl === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'coach-v2-mock',
              owned_by: 'mock',
              context_length: 131072,
              effort: { supported_levels: ['low', 'high'] },
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && cleanUrl === '/v1/chat/completions') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      capturedChatRequests.push(body);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');

      const isTitleCall = String(body.messages?.[0]?.content || '').includes('只输出标题');
      if (isTitleCall) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Markdown测试' } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      const mdReply = [
        '## 今日训练安排',
        '',
        '- 卧推做 **3*10*12**，注意 *控制离心*',
        '',
        '| 动作 | 重量 |',
        '| --- | --- |',
        '| 划船 | 60kg |',
        '',
        '```ts',
        'const sets = 3;',
        '```',
        '',
        '[安全参考](https://exrx.net) 与 [恶意链接](javascript:alert(1))',
      ].join('\n');

      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: mdReply }, finish_reason: 'stop' }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 3456,
            completion_tokens: 120,
            total_tokens: 3576,
            prompt_cache_hit_tokens: 2048,
            completion_tokens_details: { reasoning_tokens: 48 },
          },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('Not found');
  });

  const staticServer = createServer(async (req, res) => {
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

  await new Promise((r) => mockAiServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => staticServer.listen(0, '127.0.0.1', r));
  const mockBaseUrl = `http://127.0.0.1:${mockAiServer.address().port}/v1`;
  const appUrl = `http://127.0.0.1:${staticServer.address().port}`;

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
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.waitForSelector(SEL('coach-header-btn'));

    // 1. 开启一次真实训练
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

    // 打开教练小窗
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await sleep(160);

    // 2. 验证解锁的本地写入能力：换动作(->21响礼炮)、备注、热身、器械档位、直接完训(无撤销按钮)
    await sendCoachText(page, '把双杠臂屈伸换成21响礼炮');
    await sendCoachText(page, '给今天训练加个备注：左肩热身充分');
    await sendCoachText(page, '添加热身：肩袖激活 5分钟');
    await sendCoachText(page, '把21响礼炮的器械档位备忘改成座椅第 5 格');
    await sendCoachText(page, '帮我直接结束这次训练');

    const latestSess = await readIdbActiveOrLatestSession(page);
    const uiAfterFinish = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-testid^="coach-receipt-card-"]'));
      const lastCard = cards[cards.length - 1];
      const hasUndoOnFinish = lastCard
        ? lastCard.querySelector('[data-testid^="coach-receipt-undo-"]') !== null
        : true;
      return {
        receiptCount: cards.length,
        lastCardText: lastCard?.textContent ?? '',
        hasUndoOnFinish,
      };
    });
    const replaced21 = latestSess?.exercises?.find((e) => e.name === '21响礼炮');
    record(
      '全权限本地执行：换21响礼炮 + 备注 + 热身 + 档位备忘 + 直接完训(无撤销按钮)',
      Boolean(
        replaced21 &&
          replaced21.target?.kind === 'dropSet' &&
          replaced21.setupNote === '座椅第 5 格' &&
          latestSess?.note?.includes('左肩热身充分') &&
          latestSess?.warmups?.some((w) => w.name.includes('肩袖激活')) &&
          latestSess?.status === 'completed' &&
          uiAfterFinish.receiptCount === 5 &&
          !uiAfterFinish.hasUndoOnFinish,
      ),
      JSON.stringify({
        status: latestSess?.status,
        has21: Boolean(replaced21),
        setupNote: replaced21?.setupNote,
        receipts: uiAfterFinish.receiptCount,
        hasUndoOnFinish: uiAfterFinish.hasUndoOnFinish,
      }),
    );

    // 切换到主屏测完整窗口功能
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-swap-btn'));
    await page.click(SEL('floating-swap-btn'));
    await sleep(200);

    // 3. 底栏隐藏记忆入口，长期记忆改从右上角「···」及设置页管理
    const hasBottomMemory = Boolean(await page.$(SEL('coach-memory-btn')));
    await page.click(SEL('coach-window-actions'));
    await page.waitForSelector(SEL('coach-window-memory-btn'));
    await page.click(SEL('coach-window-memory-btn'));
    await page.waitForSelector(SEL('coach-memory-panel'));
    await page.click(SEL('coach-memory-add-btn'));
    await setReactInput(page, SEL('coach-memory-title-input'), '右肩不适');
    await setReactInput(page, SEL('coach-memory-content-input'), '大重量推举改用哑铃中立握');
    await page.click(SEL('coach-memory-save-btn'));
    await page.waitForSelector('[data-testid^="coach-memory-item-"]');
    const memState = await page.$eval(SEL('coach-memory-panel'), (el) => el.textContent ?? '');
    await page.click(SEL('coach-memory-close-btn'));
    await page.click(SEL('coach-window-actions'));
    await page.waitForSelector(SEL('coach-window-memory-btn'));
    const windowMenuMemText = await page.$eval(SEL('coach-window-memory-btn'), (el) => el.textContent ?? '');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-window-memory-btn"]'));
    record(
      'Hermes 长期记忆从「···」菜单与设置管理，底栏保持干净',
      !hasBottomMemory && memState.includes('右肩不适') && windowMenuMemText.includes('1'),
      JSON.stringify({ hasBottomMemory, windowMenuMemText }),
    );

    // 4. 紧凑地球联网图标免提示开启 + 设置页内置联网默认项 / 记忆入口 / 1M 上下文预设保存
    const webDefault = await page.$eval(SEL('coach-web-search-toggle'), (el) => ({
      pressed: el.getAttribute('aria-pressed'),
      text: (el.textContent ?? '').trim(),
    }));
    await page.click(SEL('coach-web-search-toggle'));
    const webAfterOn = await page.$eval(SEL('coach-web-search-toggle'), (el) => el.getAttribute('aria-pressed'));

    await page.click(SEL('coach-status-model-pill'));
    await page.click(SEL('coach-open-settings-from-plus'));
    await page.waitForSelector(SEL('coach-settings-panel'));
    const settingsCaps = await page.evaluate(() => {
      const opts = Array.from(document.querySelectorAll('[data-testid="coach-protocol-select"] option')).map((o) =>
        o.getAttribute('value'),
      );
      return {
        protocols: opts,
        hasDeepSeekPreset: Boolean(document.querySelector('[data-testid="coach-preset-deepseek-official"]')),
        hasBailianPreset: Boolean(document.querySelector('[data-testid="coach-preset-bailian-deepseek"]')),
      };
    });
    const defaultSearchVal = await page.$eval(SEL('coach-web-search-provider'), (el) => el.value);
    const hasSettingsMemBtn = Boolean(await page.$(SEL('coach-settings-memory-btn')));
    await setReactInput(page, SEL('coach-base-url-input'), mockBaseUrl);
    await setReactInput(page, SEL('coach-api-key-input'), 'sk-v2-mock');
    await page.click(SEL('coach-fetch-models-btn'));
    await page.waitForSelector(SEL('coach-remote-model-item-coach-v2-mock'));
    await page.click(SEL('coach-remote-model-item-coach-v2-mock'));
    await page.evaluate(() => {
      const adv = document.querySelector('.coach-settings-advanced');
      if (adv) adv.setAttribute('open', '');
    });
    await page.click(SEL('coach-context-preset-1M'));
    await page.click(SEL('coach-settings-save-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-settings-panel"]'));

    record(
      '联网地球图标默认关可免 Key 一键开 + 1M 上下文预设、三协议与快捷部署预设',
      defaultSearchVal === 'builtin' &&
        hasSettingsMemBtn &&
        webDefault.pressed === 'false' &&
        webDefault.text === '' &&
        webAfterOn === 'true' &&
        settingsCaps.protocols.includes('anthropic') &&
        settingsCaps.protocols.includes('gemini') &&
        settingsCaps.protocols.includes('openai-compatible') &&
        settingsCaps.hasDeepSeekPreset &&
        settingsCaps.hasBailianPreset,
      JSON.stringify({ defaultSearchVal, hasSettingsMemBtn, webDefault, webAfterOn, settingsCaps }),
    );

    // 5. 发送在线消息验证 Markdown 排版（标题/表格/代码块/`3*10*12`/无 `javascript:`）+ 增强上下文圆环/弹窗 + 点击空白收起
    await sendCoachText(page, '帮我用表格排一下今天的辅助训练');
    const mdDom = await page.evaluate(() => {
      const mdEls = Array.from(document.querySelectorAll('.coach-msg-body .coach-md'));
      const lastMd = mdEls[mdEls.length - 1];
      return {
        hasH2: Boolean(lastMd?.querySelector('h2')),
        hasTable: Boolean(lastMd?.querySelector('table')),
        hasPreCode: Boolean(lastMd?.querySelector('pre code')),
        hasStrong: Boolean(lastMd?.querySelector('strong')),
        hasSafeLink: Boolean(lastMd?.querySelector('a[href="https://exrx.net"]')),
        hasUnsafeLink: Boolean(lastMd?.querySelector('a[href^="javascript:"]')),
        html: lastMd?.innerHTML ?? '',
      };
    });
    const ctxPillText = await page.$eval(SEL('coach-context-pill'), (el) => el.textContent ?? '');
    await page.click(SEL('coach-context-pill'));
    await page.waitForSelector(SEL('coach-context-panel'));
    const ctxPanelText = await page.$eval(SEL('coach-context-panel'), (el) => el.textContent ?? '');
    const hasCtxCloseBtn = await page.$eval(SEL('coach-context-panel'), (el) =>
      Array.from(el.querySelectorAll('button')).some((b) => b.textContent?.trim() === '收起'),
    );
    await page.screenshot({ path: join(OUT, 'screens/coach-v2-primary.png') });

    // 点击聊天空白处收起上下文弹窗；再展开模型/档位弹层并点击聊天空白处收起
    await page.click(SEL('coach-messages-scroll'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-context-panel"]'));
    await page.click(SEL('coach-status-model-pill'));
    await page.waitForSelector(SEL('coach-model-panel'));
    await page.click(SEL('coach-messages-scroll'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-model-panel"]'));

    record(
      'Markdown 富文本排版与 3*10*12 保护 + 恶意链接拦截',
      mdDom.hasH2 &&
        mdDom.hasTable &&
        mdDom.hasPreCode &&
        mdDom.hasStrong &&
        mdDom.hasSafeLink &&
        !mdDom.hasUnsafeLink &&
        mdDom.html.includes('3*10*12') &&
        !mdDom.html.includes('<em>10</em>'),
      JSON.stringify({
        hasH2: mdDom.hasH2,
        hasTable: mdDom.hasTable,
        hasPreCode: mdDom.hasPreCode,
        hasSafeLink: mdDom.hasSafeLink,
        hasUnsafeLink: mdDom.hasUnsafeLink,
      }),
    );

    record(
      '增强上下文圆环 (0.3%) + 详情(实测/1M/缓存命中/tok/s/无收起按钮) + 点击空白自动收起 + 固定16业务工具集',
      ctxPillText.trim() === '0.3%' &&
        ctxPanelText.includes('接口实测') &&
        ctxPanelText.includes('3.5k / 1M') &&
        ctxPanelText.includes('缓存命中') &&
        ctxPanelText.includes('tok/s') &&
        !hasCtxCloseBtn &&
        capturedChatRequests.some(
          (r) =>
            Array.isArray(r.tools) &&
            r.tools.length === 16 &&
            !r.tools.some((t) => t.function?.name === 'web_search'),
        ),
      JSON.stringify({ ctxPillText, hasCtxCloseBtn, ctxPanelText }),
    );

    record('全程无未捕获 pageerror', pageErrors.length === 0, JSON.stringify(pageErrors));
  } finally {
    await browser.close();
    mockAiServer.close();
    staticServer.close();
    rmSync(DIST_DIR, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} passed`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
