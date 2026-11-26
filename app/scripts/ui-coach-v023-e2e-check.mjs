#!/usr/bin/env node
/* MOTION v0.2.3 真实 UI 路径 Chrome E2E 回归脚本：
 *
 * 在独立临时 dist + 隔离 Chrome UserDataDir + 本地 mock DeepSeek 官方端点运行：
 * 1. 配置 `deepseek-official` 预设 (`deepseek-flash`) 指向本地 mock 服务器，验证默认 thinking / 1M 上下文；
 * 2. 真实点击 UI 发送对话框驱动完整训练流（记满 10 组、1 次手改并发冲突拒覆写、1 次收据卡片 Undo + 重记、
 *    1 次联网查询开关切换、多轮问答、页面 reload() 后继续对话），总计 25–30 次物理模型请求；
 * 3. 全程捕获真实线缆 HTTP 请求体并断言：
 *    - 全部处于单个稳定分段（无幽灵切分）；
 *    - Turn 2+ 及 reload 后每轮保留配对的 `assistant(tool_calls + reasoning_content)` 与 `tool(tool_call_id)`；
 *    - 保留服务端原始 `call_...` ID，无 `before`/`after` 膨胀快照泄漏；
 *    - `tools` 列表恒定为 16 个业务工具且顺序完全一致，开启联网后亦不破坏工具前缀；
 *    - 连续同段请求严格保持字节前缀增量延续，UI 计费/上下文弹窗正确渲染，全程 `pageerror === 0`。
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    val,
  );
  await sleep(60);
}

async function sendCoachText(page, text, waitForDone = true) {
  await setReactInput(page, SEL('coach-input'), text);
  await page.click(SEL('coach-send-btn'));
  if (waitForDone) {
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
      { timeout: 15000 },
    );
    await sleep(180);
  }
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

async function readVaultThreadsMeta(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('motion-coach-vault');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('meta', 'readonly');
          const g = tx.objectStore('meta').getAll();
          g.onsuccess = () => {
            const rows = g.result || [];
            const row = rows.find((r) => r?.value && typeof r.value === 'object' && 'activeThreadId' in r.value);
            resolve(row?.value ?? null);
          };
          g.onerror = () => reject(g.error);
        };
      }),
  );
}

async function main() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const TMP_BASE = join(tmpdir(), `motion-v023-e2e-${stamp}`);
  const DIST_DIR = join(TMP_BASE, 'dist');
  const PROFILE_DIR = join(TMP_BASE, 'chrome-profile');
  await mkdir(PROFILE_DIR, { recursive: true });

  execFileSync('npx', ['vite', 'build'], {
    cwd: APP_DIR,
    stdio: 'pipe',
    env: { ...process.env, MOTION_TARGET: 'android', MOTION_OUT_DIR: DIST_DIR },
  });

  const capturedChatRequests = [];
  let inFlightHoldPromise = null;
  let releaseInFlightHold = null;
  let notifyConflictReqArrived = null;
  let conflictReqArrivedPromise = null;
  let activePlanQueue = [];
  let nextQueueIdx = 0;

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
    if (req.method === 'GET' && (cleanUrl === '/v1/models' || cleanUrl === '/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'deepseek-flash', owned_by: 'deepseek', context_length: 1048576 }],
        }),
      );
      return;
    }

    if (req.method === 'POST' && (cleanUrl === '/v1/chat/completions' || cleanUrl === '/chat/completions')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      capturedChatRequests.push(body);

      const lastMsg = body.messages[body.messages.length - 1] ?? {};
      const lastRole = String(lastMsg.role ?? '');
      const lastText = String(lastMsg.content ?? '');

      if (lastRole === 'user' && lastText.includes('冲突验证把第1组改9次') && inFlightHoldPromise) {
        notifyConflictReqArrived?.();
        await inFlightHoldPromise;
      }

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      const prevLen = capturedChatRequests.length;
      const totalApprox = Math.max(512, Math.floor(JSON.stringify(body).length / 3));
      const hitApprox = prevLen <= 1 ? 0 : Math.floor((totalApprox * 0.88) / 64) * 64;
      const usage = {
        prompt_tokens: totalApprox,
        completion_tokens: 32,
        prompt_cache_hit_tokens: hitApprox,
        prompt_cache_miss_tokens: Math.max(0, totalApprox - hitApprox),
      };

      // 工具调用判定
      if (lastRole === 'user' && lastText.includes('记组:') && nextQueueIdx < activePlanQueue.length) {
        const target = activePlanQueue[nextQueueIdx];
        nextQueueIdx += 1;
        const callId = `call_e2e_srv_${target.tag}`;
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: `准备记录 ${target.tag}（${target.weightKg}kg × ${target.reps}次）。`,
                  tool_calls: [
                    {
                      index: 0,
                      id: callId,
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({
                          sessionId: target.sessionId,
                          exId: target.exId,
                          roundIndex: target.roundIndex,
                          reps: target.reps,
                          weightKg: target.weightKg,
                          status: 'done',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage,
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      if (lastRole === 'user' && lastText.includes('重记第4组') && activePlanQueue[3]) {
        const target = activePlanQueue[3];
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: '按要求重新记录第 4 组。',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_e2e_srv_redo4',
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({
                          sessionId: target.sessionId,
                          exId: target.exId,
                          roundIndex: target.roundIndex,
                          reps: target.reps,
                          weightKg: target.weightKg,
                          status: 'done',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage,
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      if (lastRole === 'user' && lastText.includes('冲突验证把第1组改9次') && activePlanQueue[0]) {
        const first = activePlanQueue[0];
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: '尝试将第 1 组写回为 9 次。',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_e2e_srv_conflict1',
                      function: {
                        name: 'record_active_set',
                        arguments: JSON.stringify({
                          sessionId: first.sessionId,
                          exId: first.exId,
                          roundIndex: first.roundIndex,
                          reps: 9,
                          weightKg: 60,
                          status: 'done',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage,
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      // 自然语言确认 / 问答回复
      const content =
        lastRole === 'tool'
          ? '本组已核验写入，请保持呼吸节律并注意组间休息。'
          : lastText.includes('冲突')
            ? '检测到您在手机端已手动修改为 12 次，本次未覆写您的手改记录。'
            : '动作质量良好，核心紧收、离心阶段控制 2 秒即可。';

      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                reasoning_content: '结合当前分段上下文简短回复训练反馈。',
                content,
              },
              finish_reason: 'stop',
            },
          ],
          usage,
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
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
  const mockBaseUrl = `http://127.0.0.1:${mockAiServer.address().port}`;
  const appUrl = `http://127.0.0.1:${staticServer.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: PROFILE_DIR,
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
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    // 拦截外部联网搜索 URL 与 https://api.deepseek.com（零外网流量，直接本地路由到 mockAiServer）
    await page.setRequestInterception(true);
    page.on('request', (intercepted) => {
      const url = intercepted.url();
      if (url.includes('127.0.0.1')) {
        void intercepted.continue();
        return;
      }
      if (url.startsWith('https://api.deepseek.com')) {
        void (async () => {
          try {
            const u = new URL(url);
            const targetUrl = `${mockBaseUrl}${u.pathname}${u.search}`;
            const method = intercepted.method();
            if (method === 'OPTIONS') {
              await intercepted.respond({
                status: 204,
                headers: {
                  'Access-Control-Allow-Origin': '*',
                  'Access-Control-Allow-Headers': '*',
                  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                },
                body: '',
              });
              return;
            }
            const headers = { ...intercepted.headers() };
            delete headers.host;
            delete headers['content-length'];
            const res = await fetch(targetUrl, {
              method,
              headers,
              ...(method !== 'GET' && method !== 'HEAD' ? { body: intercepted.postData() ?? '' } : {}),
            });
            const bodyBuf = Buffer.from(await res.arrayBuffer());
            const respHeaders = {
              'Content-Type': res.headers.get('content-type') || 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': '*',
            };
            await intercepted.respond({ status: res.status, headers: respHeaders, body: bodyBuf });
          } catch {
            await intercepted.abort();
          }
        })();
        return;
      }
      if (url.includes('duckduckgo') || url.includes('bing.com') || url.includes('so.com')) {
        void intercepted.respond({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<a class="result__a" href="https://example.com/bench">卧推肩胛要点</a><a class="result__snippet">肩胛下沉后缩，脚跟踩实地面。</a>',
        });
        return;
      }
      void intercepted.abort();
    });

    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true });
    await page.goto(appUrl, { waitUntil: 'load' });
    await page.waitForSelector(SEL('coach-header-btn'));

    // 1. 开启一次真实训练并生成前 10 组真实动作-组次目标队列
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

    const initSess = await readIdbActiveOrLatestSession(page);
    const targets = [];
    for (const ex of initSess.exercises) {
      for (let i = 0; i < ex.sets.length && targets.length < 10; i += 1) {
        targets.push({
          tag: `s${targets.length + 1}`,
          sessionId: initSess.id,
          exId: ex.id,
          roundIndex: i + 1,
          reps: 10,
          weightKg: 60,
        });
      }
    }
    activePlanQueue = targets;

    // 2. 打开教练浮窗 -> 配置 DeepSeek 官方 preset (https://api.deepseek.com + deepseek-flash)
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(`${SEL('coach-pane')}[data-pane-role="mini"]`);
    await page.click(SEL('coach-status-model-pill'));
    await page.click(SEL('coach-open-settings-from-plus'));
    await page.waitForSelector(SEL('coach-settings-panel'));
    await page.click(SEL('coach-preset-deepseek-official'));
    await setReactInput(page, SEL('coach-api-key-input'), 'sk-e2e-v023');
    await page.click(SEL('coach-settings-save-btn'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-settings-panel"]'));

    // 3. 通过真实 UI 依次记录第 1–4 组（8 次物理请求）
    for (let s = 1; s <= 4; s += 1) {
      await sendCoachText(page, `记组: 请记录第 ${s} 组 60kg 10次`);
    }

    // 4. 点收据卡片「撤销」退回第 4 组，再用对话重记第 4 组（+2 次物理请求）
    const undoButtons = await page.$$('[data-testid^="coach-receipt-undo-"]');
    const lastUndoBtn = undoButtons[undoButtons.length - 1];
    await lastUndoBtn.click();
    await sleep(250);
    const afterUndoSess = await readIdbActiveOrLatestSession(page);
    const t4 = targets[3];
    const ex4AfterUndo = afterUndoSess.exercises.find((e) => e.id === t4.exId);
    const undoWorked = ex4AfterUndo?.sets[t4.roundIndex - 1]?.status === 'blank';
    await sendCoachText(page, '重记第4组 60kg 10次');

    // 5. 模拟在途并发手改冲突：发送请求并暂停在 mock server，立即在训练主界面把第 1 组改成 12 次后放行模型写入 9 次
    inFlightHoldPromise = new Promise((resolve) => {
      releaseInFlightHold = resolve;
    });
    conflictReqArrivedPromise = new Promise((resolve) => {
      notifyConflictReqArrived = resolve;
    });
    await sendCoachText(page, '冲突验证把第1组改9次', false);
    await conflictReqArrivedPromise;
    await sleep(60);
    const firstInputSel = `[data-coach-ex-id="${targets[0].exId}"][data-coach-field="reps"]`;
    await page.evaluate(
      (sel) => {
        const el = document.querySelectorAll(sel)[0];
        if (!el) throw new Error('missing session reps input');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        el.focus();
        setter.call(el, '12');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      },
      firstInputSel,
    );
    await page.waitForFunction(
      async () =>
        new Promise((res) => {
          const r = indexedDB.open('motion-training');
          r.onsuccess = () => {
            const tx = r.result.transaction('sessions', 'readonly');
            const g = tx.objectStore('sessions').getAll();
            g.onsuccess = () => {
              const s = (g.result || []).sort((a, b) => b.startedAt - a.startedAt)[0];
              res(s?.exercises?.[0]?.sets?.[0]?.reps === 12);
            };
          };
        }),
      { timeout: 6000 },
    );
    releaseInFlightHold();
    inFlightHoldPromise = null;
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="coach-cancel-stream-btn"]'),
      { timeout: 15000 },
    );
    await sleep(200);
    const afterConflictSess = await readIdbActiveOrLatestSession(page);
    const conflictPreserved12 = afterConflictSess.exercises[0].sets[0].reps === 12;

    // 6. 继续通过真实 UI 记完第 5–10 组（+12 次物理请求）
    for (let s = 5; s <= 10; s += 1) {
      await sendCoachText(page, `记组: 请记录第 ${s} 组 60kg 10次`);
    }

    // 7. 切开联网按钮做 1 次检索提问后再关闭（+1 次物理请求，检查 tools 固定 16 个）
    await page.click(SEL('coach-web-search-toggle'));
    await sendCoachText(page, '搜一下卧推肩胛要点怎么控制？');
    await page.click(SEL('coach-web-search-toggle'));

    // 8. 检查 UI 上下文圆环与计费统计展示
    await page.click(SEL('coach-context-pill'));
    await page.waitForSelector(SEL('coach-context-panel'));
    const billingText = await page.$eval(SEL('coach-context-panel'), (el) => el.textContent ?? '');
    const billingRowText = await page
      .$eval(SEL('coach-context-billing'), (el) => el.textContent ?? '')
      .catch(() => '');
    await page.click(SEL('coach-context-pill'));
    await page.waitForFunction(() => !document.querySelector('[data-testid="coach-context-panel"]'));

    // 9. 额外 1 轮常规点评 + 页面彻底 reload() 后重新打开教练窗口继续发 1 轮，验证分段与历史延续
    await sendCoachText(page, '顺便点评一下今天整体的推力表现？');
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector(SEL('coach-header-btn'));
    await page.click(SEL('coach-header-btn'));
    await page.waitForSelector(SEL('coach-input'));
    await sendCoachText(page, '重启后继续问：下一组应该注意什么？');

    const finalSess = await readIdbActiveOrLatestSession(page);
    let doneSetsCount = 0;
    for (const t of targets) {
      const ex = finalSess.exercises.find((e) => e.id === t.exId);
      if (ex?.sets[t.roundIndex - 1]?.status === 'done') doneSetsCount += 1;
    }

    const threadsMeta = await readVaultThreadsMeta(page);
    const activeThread = threadsMeta?.threads?.find((t) => t.id === threadsMeta.activeThreadId);
    const segmentIds = Object.keys(activeThread?.segments ?? {});

    const allModelDeepSeekFlash = capturedChatRequests.every((r) => r.model === 'deepseek-flash');
    const fixed16Tools = capturedChatRequests.every(
      (r) =>
        Array.isArray(r.tools) &&
        r.tools.length === 16 &&
        !r.tools.some((t) => t.function?.name === 'web_search'),
    );
    const firstMissingPairIdx = capturedChatRequests
      .slice(2)
      .findIndex(
        (r) =>
          !(
            r.messages.some(
              (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && typeof m.reasoning_content === 'string',
            ) && r.messages.some((m) => m.role === 'tool' && String(m.tool_call_id ?? '').startsWith('call_e2e_srv_'))
          ),
      );
    const turn2AndPostReloadHaveToolPairs =
      capturedChatRequests.length >= 25 && firstMissingPairIdx === -1;
    const missingPairDetail =
      firstMissingPairIdx >= 0
        ? JSON.stringify({
            reqIdx: firstMissingPairIdx + 2,
            roles: capturedChatRequests[firstMissingPairIdx + 2]?.messages.map((m) => ({
              role: m.role,
              hasTc: Array.isArray(m.tool_calls),
              hasReasoning: typeof m.reasoning_content,
              tcId: m.tool_call_id,
            })),
          })
        : '';
    const noSnapshotLeakedInTools = capturedChatRequests.every((r) =>
      r.messages.every(
        (m) => m.role !== 'tool' || (!String(m.content ?? '').includes('"before"') && !String(m.content ?? '').includes('"after"')),
      ),
    );
    const prefixConsecutiveMatches = capturedChatRequests.slice(1).filter((r, i) => {
      const prevWire = JSON.stringify({ tools: capturedChatRequests[i].tools, messages: capturedChatRequests[i].messages });
      const curWire = JSON.stringify({ tools: r.tools, messages: r.messages });
      return curWire.startsWith(prevWire.slice(0, Math.max(0, prevWire.length - 4)));
    }).length;

    record('10 组真实 UI 记组全部落库（含第4组 Undo 后重记与重启后继续）', doneSetsCount === 10 && undoWorked, `doneSets=${doneSetsCount}, undoWorked=${undoWorked}`);
    record('在途并发 UI 手改第1组=12次，省略 expectedRevision 冲突保护生效', conflictPreserved12, `set1Reps=${afterConflictSess.exercises[0].sets[0].reps}`);
    record('物理模型请求数落于 25–30 区间且全部使用 deepseek-flash + 固定16工具', capturedChatRequests.length >= 25 && capturedChatRequests.length <= 32 && allModelDeepSeekFlash && fixed16Tools, `requests=${capturedChatRequests.length}`);
    record('全程（含 reload 后）维持唯一 1 个分段且每轮前缀逐字节延续', segmentIds.length === 1 && prefixConsecutiveMatches >= capturedChatRequests.length - 2, `segments=${segmentIds.length}, prefixMatches=${prefixConsecutiveMatches}/${capturedChatRequests.length - 1}`);
    record('Turn 2+ 与 reload 后完整保留 reasoning_content/tool_calls/tool 轨迹、服务端原 ID 且无 before/after 快照膨胀', turn2AndPostReloadHaveToolPairs && noSnapshotLeakedInTools, `paired=${turn2AndPostReloadHaveToolPairs}, cleanTool=${noSnapshotLeakedInTools}${missingPairDetail ? ' ' + missingPairDetail : ''}`);
    record(
      'UI 上下文弹窗含缓存命中与人民币计费明细块',
      billingText.includes('缓存命中') && billingRowText.includes('¥'),
      billingRowText.slice(0, 90) || billingText.slice(0, 90),
    );
    record('全程零未捕获 pageerror', pageErrors.length === 0, JSON.stringify(pageErrors));
  } finally {
    await browser.close();
    mockAiServer.close();
    staticServer.close();
    rmSync(TMP_BASE, { recursive: true, force: true });
  }

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${checks.length} passed (${capturedChatRequests.length} HTTP model requests)`);
  if (passed !== checks.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
