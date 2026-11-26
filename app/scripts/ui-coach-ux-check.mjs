#!/usr/bin/env node
/* 真实 Chrome 回归。使用本机模拟 API 与合成附件验证模型、会话与识图确认。 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_DIR, 'dist-coach-ux-check');
const OUT = join(APP_DIR, 'verify-self/coach-ux-check');
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
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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

async function sendText(page, text) {
  await setReactInput(page, SEL('coach-input'), text);
  await page.waitForFunction(
    (sel) => {
      const btn = document.querySelector(sel);
      return Boolean(btn && !btn.disabled);
    },
    { timeout: 10000 },
    SEL('coach-send-btn'),
  );
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
  const videoPath = join(OUT, 'sample-lift.mp4');
  await writeFile(videoPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]));

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
            { id: 'coach-reasoner-v2', owned_by: 'mock', effort: { supported_levels: ['low', 'high', 'xhigh', 'max'] } },
            { id: 'coach-vision-fast', owned_by: 'mock' },
            { id: 'other-unused-model', owned_by: 'mock' },
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
      const lastUser = body.messages?.[body.messages.length - 1];
      const userPreview =
        typeof lastUser?.content === 'string'
          ? lastUser.content
          : Array.isArray(lastUser?.content)
            ? lastUser.content.map((p) => p.type).join('+')
            : '';
      if (body.tools?.length && typeof lastUser?.content === 'string' && lastUser.content === '延迟回复测试') {
        await sleep(2000);
      }
      if (body.tools?.length && typeof lastUser?.content === 'string' && lastUser.content.includes('晚到回调测试')) {
        await sleep(850);
      }
      const contentText = typeof lastUser?.content === 'string' ? lastUser.content :
        lastUser?.content?.find?.((part) => part.type === 'text')?.text ?? '';
      if (body.tools?.length && lastUser?.role === 'user' && contentText.includes('测试识图建计划')) {
        const draft = { planName: '识图专项计划', days: [{ dayName: '推日', exercises: [{
          name: '哑铃卧推', kind: 'straight', sets: 3, repsMin: 8, repsMax: 10,
          weightMode: 'external', suggestedWeightKg: 8, dumbbellBasis: 'total',
        }] }] };
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: 'mock-draft', function: { name: 'create_plan_from_draft', arguments: JSON.stringify({ draft }) },
        }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      const isTitleCall = String(body.messages?.[0]?.content || '').includes('只输出标题');
      if (isTitleCall) {
        await sleep(550);
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '训练动作分析' } }] }) + '\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      const isSummaryCall = String(body.messages?.[0]?.content || '').includes('摘要');
      const reply = isSummaryCall
        ? '【模型摘要】用户咨询卧推节奏并提交测试视频，建议稳定离心。'
        : `收到（${body.model}）：${userPreview.slice(0, 32)}`;
      if (!isSummaryCall) {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `深度推演(${body.reasoning_effort ?? 'default'})` } }] })}\n\n`,
        );
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: 'stop' }] })}\n\n`);
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

    const inspectVault = () =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('motion-coach-vault');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction(['meta', 'messages'], 'readonly');
              const metaReq = tx.objectStore('meta').get('threads');
              const msgReq = tx.objectStore('messages').getAll();
              tx.oncomplete = () => {
                db.close();
                resolve({
                  threadsState: metaReq.result?.value ?? null,
                  messages: msgReq.result ?? [],
                });
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error);
              };
            };
          }),
      );

    // 1. 打开教练小窗验证小窗铅笔入口打开单空白草稿且不建空历史，再切主屏验证示例与配置模型
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await page.click(SEL('coach-mini-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    const miniDraftVault = await inspectVault();
    const miniDraftCountOk = !miniDraftVault.threadsState || miniDraftVault.threadsState.threads.length <= 1;
    // 点顶部栏互换切到主屏再测（小窗/主屏都能设）
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-swap-btn'));
    await page.click(SEL('floating-swap-btn'));
    await page.click(SEL('coach-threads-btn'));
    await page.waitForSelector(SEL('coach-threads-panel'));
    await page.click(SEL('coach-thread-item-default'));
    await page.waitForSelector(SEL('coach-examples-btn'));
    const hasDefaultExamplesBtn = Boolean(await page.$(SEL('coach-examples-btn')));
    await page.click(SEL('coach-status-model-pill'));
    await page.click(SEL('coach-open-settings-from-plus'));
    await page.waitForSelector(SEL('coach-settings-panel'));
    await setReactInput(page, SEL('coach-base-url-input'), mockBaseUrl);
    await setReactInput(page, SEL('coach-api-key-input'), 'sk-mock-123');
    await page.click(SEL('coach-fetch-models-btn'));
    await page.waitForSelector(SEL('coach-remote-models-list'));

    await setReactInput(page, SEL('coach-remote-model-search'), 'coach-');
    await page.click(SEL('coach-remote-model-item-coach-reasoner-v2'));
    await page.click(SEL('coach-remote-model-item-coach-vision-fast'));
    await page.click(SEL('coach-settings-save-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-settings-panel"]'));

    const savedStatus = await page.$eval(SEL('coach-status-model-pill'), (el) => el.textContent ?? '');
    record(
      'CC Switch 获取模型 + 搜索添加双模型并生效',
      savedStatus.includes('coach-reasoner-v2'),
      savedStatus,
    );

    // 2. 验证旧“图”按钮已替换为“+”，打开二级菜单并检验 4 项功能入口
    await page.click(SEL('coach-plus-btn'));
    await page.waitForSelector(SEL('coach-plus-menu'));
    const menuItems = await page.evaluate(() => ({
      plusBtnText: document.querySelector('[data-testid="coach-plus-btn"]')?.textContent?.trim(),
      hasPickImage: Boolean(document.querySelector('[data-testid="coach-pick-image-btn"]')),
      hasPickVideo: Boolean(document.querySelector('[data-testid="coach-pick-video-btn"]')),
      hasThinking: Boolean(document.querySelector('[data-testid="coach-plus-thinking-btn"]')),
      hasModelSwitch: Boolean(document.querySelector('[data-testid="coach-plus-model-btn"]')),
    }));
    record(
      '输入框「+」二级弹出菜单提供照片和视频',
      menuItems.hasPickImage && menuItems.hasPickVideo && !menuItems.hasThinking && !menuItems.hasModelSwitch,
      JSON.stringify(menuItems),
    );

    // 3. 在「+」菜单里切思考深度为「高」并发送一条对话，核对 reasoning_effort 与思考折叠框
    await page.click(SEL('coach-status-model-pill'));
    await page.click(SEL('coach-plus-thinking-btn'));
    await page.waitForSelector(SEL('coach-thinking-selector'));
    await page.click(SEL('coach-thinking-opt-high'));
    const thinkingPill = await page.$eval(SEL('coach-status-model-pill'), (el) => el.textContent ?? '');
    await sendText(page, '分析一下今日卧推容量');
    const afterThinkingMsg = await page.evaluate(() => ({
      hasThinkingBox: Boolean(document.querySelector('[data-testid="coach-thinking-box"]')),
      thinkingBody: document.querySelector('.coach-thinking-body')?.textContent ?? '',
    }));
    record(
      '在模型入口切到 High后发送：请求带 reasoning_effort=high 且展示可折叠思考过程',
      thinkingPill.includes('High') &&
        capturedChatRequests[0]?.reasoning_effort === 'high' &&
        afterThinkingMsg.hasThinkingBox &&
        afterThinkingMsg.thinkingBody.includes('深度推演(high)'),
      JSON.stringify({ thinkingPill, reqEffort: capturedChatRequests[0]?.reasoning_effort, ...afterThinkingMsg }),
    );

    // 4. 在「+」菜单里通过「模型切换」直接切到 coach-vision-fast 并上传视频
    await page.click(SEL('coach-status-model-pill'));
    await page.click(SEL('coach-plus-model-btn'));
    await page.waitForSelector(SEL('coach-model-switcher'));
    await page.click(SEL('coach-quick-model-coach-vision-fast'));
    const switchedModelPill = await page.$eval(SEL('coach-status-model-pill'), (el) => el.textContent ?? '');

    const videoInput = await page.$(SEL('coach-video-input'));
    await videoInput.uploadFile(videoPath);
    await page.waitForSelector(SEL('coach-pending-attachment'));
    const pendingVideoText = await page.$eval(SEL('coach-pending-attachment'), (el) => el.textContent ?? '');
    await sendText(page, '请看下这个视频的深蹲深度');

    const lastReq = capturedChatRequests.findLast((request) => request.tools?.length);
    const hasVideoUrlPart = Boolean(
      Array.isArray(lastReq?.messages?.[lastReq.messages.length - 1]?.content) &&
        lastReq.messages[lastReq.messages.length - 1].content.some((p) => p.type === 'video_url'),
    );
    record(
      '从模型入口切换模型 + 「添加视频」直发模型 video_url',
      switchedModelPill.includes('coach-vision-fast') &&
        pendingVideoText.includes('sample-lift.mp4') &&
        lastReq?.model === 'coach-vision-fast' &&
        hasVideoUrlPart,
      JSON.stringify({ switchedModelPill, pendingVideoText, reqModel: lastReq?.model, hasVideoUrlPart }),
    );

    // 5. #7 单空白草稿：连点铅笔不清空、列表不占行、切换旧会话再点铅笔保留草稿+视频、刷新无空历史
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    await setReactInput(page, SEL('coach-input'), '草稿保留文本');
    const draftVid = await page.$(SEL('coach-video-input'));
    await draftVid.uploadFile(videoPath);
    await page.waitForSelector(SEL('coach-pending-attachment'));
    await page.click(SEL('coach-new-thread-btn'));
    await page.click(SEL('coach-new-thread-btn'));
    const afterRepeatedPencilText = await page.$eval(SEL('coach-input'), (el) => el.value);
    const afterRepeatedPencilVid = await page.$eval(SEL('coach-pending-attachment'), (el) => el.textContent ?? '');

    await page.click(SEL('coach-threads-btn'));
    await page.waitForSelector(SEL('coach-threads-panel'));
    const drawerRowsDuringDraft = await page.$$eval('[data-testid^="coach-thread-item-"]', (els) =>
      els.map((el) => el.dataset.testid),
    );
    const vaultDuringDraft = await inspectVault();
    await page.click(SEL('coach-thread-item-default'));
    await page.waitForFunction(() => document.querySelector('.coach-messages')?.textContent.includes('卧推容量'));
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    const afterSwitchBackText = await page.$eval(SEL('coach-input'), (el) => el.value);
    const afterSwitchBackVid = await page.$eval(SEL('coach-pending-attachment'), (el) => el.textContent ?? '');
    record(
      '单空白草稿不占列表/Vault 行，连点铅笔及切去旧会话再点铅笔回来保留文字与视频',
      hasDefaultExamplesBtn &&
        miniDraftCountOk &&
        afterRepeatedPencilText === '草稿保留文本' &&
        afterRepeatedPencilVid.includes('sample-lift.mp4') &&
        drawerRowsDuringDraft.length === 1 &&
        vaultDuringDraft.threadsState?.threads.length === 1 &&
        afterSwitchBackText === '草稿保留文本' &&
        afterSwitchBackVid.includes('sample-lift.mp4'),
      JSON.stringify({
        hasDefaultExamplesBtn,
        miniDraftCountOk,
        drawerRowsDuringDraft,
        vaultThreadCount: vaultDuringDraft.threadsState?.threads.length,
        afterSwitchBackText,
      }),
    );

    // 刷新页面：退出重进不产生空历史，且 default 保留已有真实对话
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector(SEL('coach-header-btn'));
    const vaultAfterReload = await inspectVault();
    const zeroEmptyAfterReload =
      Boolean(vaultAfterReload.threadsState?.threads.length === 1) &&
      vaultAfterReload.threadsState.threads.every((t) =>
        vaultAfterReload.messages.some((m) => (m.threadId ?? 'default') === t.id),
      );
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await page.click(SEL('coach-drag-handle'));
    await page.waitForSelector(SEL('floating-swap-btn'));
    await page.click(SEL('floating-swap-btn'));

    // 6. 仅附件首条双连点发送互斥锁 + 纯文本首条隔离 + 手动压缩
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    const attOnlyInput = await page.$(SEL('coach-video-input'));
    await attOnlyInput.uploadFile(videoPath);
    await page.waitForSelector(SEL('coach-pending-attachment'));
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      btn.click();
      btn.click();
    }, SEL('coach-send-btn'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
      { timeout: 10000 },
    );
    await sleep(650);
    const vaultAfterAttSend = await inspectVault();
    const attThreads = vaultAfterAttSend.threadsState?.threads.filter((t) => t.id !== 'default') ?? [];
    const attThreadId = attThreads[0]?.id;
    const attThreadMsgs = vaultAfterAttSend.messages.filter((m) => m.threadId === attThreadId);
    const attUserMsgs = attThreadMsgs.filter((m) => m.role === 'user');
    record(
      '刷新不建空历史 + 仅附件首条并发连点只建 1 个线程且零重复首消息',
      zeroEmptyAfterReload &&
        attThreads.length === 1 &&
        attUserMsgs.length === 1 &&
        attThreadMsgs.length === 2,
      JSON.stringify({
        zeroEmptyAfterReload,
        attThreadCount: attThreads.length,
        attUserMsgsCount: attUserMsgs.length,
        attThreadMsgsCount: attThreadMsgs.length,
      }),
    );

    // 7. 「新开对话」空白隔离 + 多轮后「压缩早期上下文」
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    await sendText(page, '新话题第 1 问：肩推怎么热身？');
    await sendText(page, '新话题第 2 问：每组做多少次？');
    const reqInNewThread = capturedChatRequests.findLast((request) => request.tools?.length);
    const newThreadPolluted = JSON.stringify(reqInNewThread).includes('卧推容量');

    await page.click(SEL('coach-threads-btn'));
    await page.waitForSelector(SEL('coach-threads-panel'));
    await page.click(SEL('coach-compress-ctx-btn'));
    await page.waitForSelector(SEL('coach-context-summary'));
    const summaryText = await page.$eval(SEL('coach-context-summary'), (el) => el.textContent ?? '');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await sleep(120);
    await page.screenshot({ path: join(OUT, 'screens/coach-ux-dark.png') });

    record(
      '「新开对话」彻底隔离旧上下文 + 「压缩当前上下文」生成摘要且深色可渲染',
      !newThreadPolluted && summaryText.includes('已压缩') && summaryText.includes('模型摘要'),
      JSON.stringify({ newThreadPolluted, summaryText }),
    );

    // 8. 他线程流式回复中切入单一草稿 + 晚到异步回调不踢出草稿 + 通过铅笔回到草稿仍保留文字与视频
    await page.click(SEL('coach-threads-panel') + ' .coach-threads-head button');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    await setReactInput(page, SEL('coach-input'), '晚到回调测试：深蹲离心如何控制');
    await page.click(SEL('coach-send-btn'));
    await page.waitForSelector(SEL('coach-cancel-stream-btn'));
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    await setReactInput(page, SEL('coach-input'), '晚到回复期间草稿');
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('[data-testid="coach-send-btn"]');
        return Boolean(btn && !btn.disabled);
      },
      { timeout: 10000 },
    );
    await sleep(200);
    const stayedInDraftDuringLateReply = Boolean(await page.$(SEL('coach-thread-empty')));
    const draftDuringLateReply = await page.$eval(SEL('coach-input'), (el) => el.value);
    const vaultAfterLateReply = await inspectVault();
    const lateThread = vaultAfterLateReply.threadsState?.threads.find((t) =>
      vaultAfterLateReply.messages.some(
        (m) => m.threadId === t.id && m.role === 'user' && m.text.includes('晚到回调测试'),
      ),
    );
    const lateThreadDone = Boolean(
      lateThread &&
        lateThread.title !== '新对话' &&
        vaultAfterLateReply.messages.some(
          (m) => m.threadId === lateThread.id && m.role === 'assistant' && m.text.includes('收到'),
        ),
    );
    record(
      '晚到异步回复/标题回调仅更新正式线程，不打断也不清空当前空白草稿',
      stayedInDraftDuringLateReply && draftDuringLateReply === '晚到回复期间草稿' && lateThreadDone,
      JSON.stringify({
        stayedInDraftDuringLateReply,
        draftDuringLateReply,
        lateThreadTitle: lateThread?.title,
        lateThreadDone,
      }),
    );

    await setReactInput(page, SEL('coach-input'), '延迟回复测试');
    await page.click(SEL('coach-send-btn'));
    await page.waitForSelector(SEL('coach-cancel-stream-btn'));
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    await setReactInput(page, SEL('coach-input'), '留在第二条的未发草稿');
    const pending = await page.$(SEL('coach-video-input'));
    await pending.uploadFile(videoPath);
    await page.waitForSelector(SEL('coach-pending-attachment'));
    const blocked = await page.$eval(SEL('coach-send-btn'), (button) => button.disabled);
    await page.click(SEL('coach-threads-btn'));
    const rows = await page.$$('[data-testid^="coach-thread-item-"]');
    const runningThreadId = (await rows[0].evaluate((el) => el.dataset.testid)).replace('coach-thread-item-', '');
    await page.click(SEL('coach-thread-item-' + runningThreadId));
    await page.waitForFunction(() => document.querySelector('.coach-messages')?.textContent.includes('收到'));
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
      { timeout: 10000 },
    );
    await sleep(200);
    await page.click(SEL('coach-threads-btn'));
    await page.click(SEL('coach-thread-menu-' + runningThreadId));
    await page.click('.coach-thread-menu-actions button:first-child');
    await setReactInput(page, '.coach-thread-form input', '新对话 · 我的标题');
    await page.click('.coach-thread-form button[type=submit]');
    await page.click(SEL('coach-threads-panel') + ' .coach-threads-head button');
    await page.click(SEL('coach-new-thread-btn'));
    await page.waitForSelector(SEL('coach-thread-empty'));
    const restored = await page.$eval(SEL('coach-input'), (el) => el.value);
    const restoredAttachment = await page.$eval(SEL('coach-pending-attachment'), (el) => el.textContent);
    record(
      '他线程流式/改名后点铅笔回到单草稿仍保留文字与视频',
      blocked &&
        restored === '留在第二条的未发草稿' &&
        restoredAttachment.includes('sample-lift.mp4'),
    );

    await page.click(SEL('coach-threads-btn'));
    await page.waitForFunction((selector) => document.querySelector(selector)?.textContent.includes('我的标题'), {}, SEL('coach-thread-item-' + runningThreadId));
    await page.click(SEL('coach-thread-menu-' + runningThreadId));
    await page.click('.coach-thread-menu-actions button:last-child');
    await page.waitForSelector('.coach-thread-form');
    await page.click('.coach-thread-form button[type=button]');
    const cancelled = Boolean(await page.$(SEL('coach-thread-item-' + runningThreadId)));
    await page.click(SEL('coach-thread-menu-' + runningThreadId));
    await page.click('.coach-thread-menu-actions button:last-child');
    await page.click('.coach-thread-form button[type=submit]');
    await page.waitForFunction((selector) => !document.querySelector(selector), {}, SEL('coach-thread-item-' + runningThreadId));
    const thatThreadDeleted = await page.evaluate((id) => new Promise((resolve, reject) => {
      const request = indexedDB.open('motion-coach-vault');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const rows = db.transaction('messages').objectStore('messages').getAll();
        rows.onsuccess = () => { db.close(); resolve(!rows.result.some((message) => message.threadId === id)); };
        rows.onerror = () => reject(rows.error);
      };
    }), runningThreadId);
    record('取消删除保留会话，确认删除清理消息且手改标题有效', cancelled && thatThreadDeleted);

    await page.click(SEL('coach-threads-panel') + ' .coach-threads-head button');
    await page.click(SEL('coach-new-thread-btn'));
    await sendText(page, '测试识图建计划');
    await page.waitForSelector(SEL('coach-plan-draft-card'));
    const findPlans = () => page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('motion-training', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const plans = db.transaction('plans').objectStore('plans').getAll();
        plans.onsuccess = () => { db.close(); resolve(plans.result.filter((plan) => plan.name === '识图专项计划')); };
        plans.onerror = () => reject(plans.error);
      };
    }));
    const beforeConfirm = await findPlans();
    await page.click('.coach-draft-exercise summary');
    await page.select('.coach-draft-exercise label:nth-of-type(4) select', 'per_hand');
    await page.evaluate((selector) => {
      document.querySelector(selector).click();
      document.querySelector(selector)?.click();
    }, SEL('coach-plan-draft-confirm-btn'));
    await page.waitForFunction(() => document.querySelector('[data-testid="coach-plan-draft-card"]')?.textContent.includes('已创建计划'));
    const afterConfirm = await findPlans();
    record('在线工具先显示编辑草稿，确认只建一个计划且保存每手口径', beforeConfirm.length === 0 &&
      afterConfirm.length === 1 && afterConfirm[0].days[0].exercises[0].target.dumbbellBasis === 'per_hand');

    const finalVault = await inspectVault();
    const noEmptyThreadsFinal = Boolean(finalVault.threadsState?.threads.length) &&
      finalVault.threadsState.threads.every((t) =>
        finalVault.messages.some((m) => (m.threadId ?? 'default') === t.id),
      );
    record('全流程结束 Vault 无任何空会话残留', noEmptyThreadsFinal, `threads=${finalVault.threadsState?.threads.length}`);

    record('无未捕获浏览器异常', pageErrors.length === 0, pageErrors.join(' | '));
    const failed = checks.filter((c) => !c.ok);
    console.log(`\nCOACH UX CHROME CHECK: ${checks.length - failed.length}/${checks.length} passed; errors=${pageErrors.length}`);
    if (failed.length || pageErrors.length) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    mockAiServer.closeAllConnections?.();
    staticServer.closeAllConnections?.();
    await Promise.all([
      new Promise((r) => mockAiServer.close(r)),
      new Promise((r) => staticServer.close(r)),
    ]);
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
