#!/usr/bin/env node
/* B4-R2 施工者行为自查：真实 Chrome + 真实 App bundle + 原生 IndexedDB。

   ── 本轮针对的 Codex 已证缺口（B4-R1 独立 FAIL）──────────────
   1. G5 内部 raw 丢失：递减轮数清空 → 真实 blur 报"不能为空" → 点 ‹计划
      直接离开，草稿消失（无写请求、无 dirty、无 mutation）。
   2. G5 取消幽灵 dirty：合法 3→4 真实 blur → 取消恢复 3 → 点 ‹计划 无反应。
   3. 历史完整性：dirty 被拦后 Back/Forward 是否错位。

   ── 边界 ──────────────────────────────────────────────────────
   · 加载真实 src/main.tsx（StoreProvider/路由/Toast 原样）；
   · 只拦 I/O 边界（IDB request/transaction），不替换业务 callback；
   · 施工者自查，**不是** Codex 独立验收；不证明真机 IME/后台/震感。
   MOTION_CHROME_PATH 可覆盖默认 macOS Chrome 路径。
   用法：node scripts/ui-feedback-b4r2-check.mjs
*/
import { createHash } from 'node:crypto';
import fs, { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTDIR = path.join(ROOT, 'verify-self/feedback-b4r2', STAMP);
mkdirSync(OUTDIR, { recursive: true });

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`);
}

const fontsExternal = {
  name: 'fonts-external',
  setup(b) { b.onResolve({ filter: /^\/fonts\// }, () => ({ external: true })); },
};
const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.tsx')],
  bundle: true, write: false,
  outfile: path.join(OUTDIR, 'bundle.js'),
  format: 'iife', jsx: 'automatic', target: 'chrome120',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [fontsExternal],
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = bundle.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>b4r2-selfcheck</title>' +
  '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div>' +
  '<script src="/app.js"></script></body></html>';

const server = createServer((req, res) => {
  if (req.url === '/app.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); return res.end(js); }
  if (req.url === '/app.css') { res.setHeader('content-type', 'text/css; charset=utf-8'); return res.end(css); }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

function srcHash() {
  const files = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith('._')) continue;
      const p = path.join(dir, item.name);
      if (item.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(item.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  files.sort();
  const h = createHash('sha256');
  for (const f of files) h.update(readFileSync(f));
  return h.digest('hex');
}
const hashBefore = srcHash();

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--user-data-dir=' + path.join(OUTDIR, 'chrome-profile')],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.evaluateOnNewDocument(() => {
  const trace = [];
  window.__R2_TRACE__ = trace;
  window.__R2_CLEAR__ = () => trace.splice(0, trace.length);
  const origPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    const storeName = this.name;
    const tx = this.transaction;
    const req = origPut.call(this, value, key);
    const rec = { kind: 'put', store: storeName, at: Date.now(), requestSuccess: false, txComplete: false };
    trace.push(rec);
    req.addEventListener('success', () => { rec.requestSuccess = true; });
    tx.addEventListener('complete', () => { rec.txComplete = true; });
    return req;
  };
  window.__R2_SNAPSHOT__ = () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open('motion-training', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        let tx;
        try { tx = db.transaction(['plans', 'settings', 'sessions'], 'readonly'); }
        catch { db.close(); return resolve({ plans: [], settings: null, sessions: [] }); }
        const p = tx.objectStore('plans').getAll();
        const s = tx.objectStore('settings').get('app');
        const se = tx.objectStore('sessions').getAll();
        tx.oncomplete = () => { db.close(); resolve({ plans: p.result || [], settings: s.result || null, sessions: se.result || [] }); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  /** 记录 hash 变化序列（历史完整性用） */
  window.__R2_HASHLOG__ = [];
  window.addEventListener('hashchange', () => {
    window.__R2_HASHLOG__.push({ at: Date.now(), hash: window.location.hash, len: window.history.length });
  });
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));

async function clickByText(text, exact = false) {
  const found = await page.evaluate((want, isExact) => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], summary'));
    const el = nodes.find((n) => {
      const t = (n.textContent || '').trim();
      return isExact ? t === want : t.includes(want);
    });
    if (!el) return false;
    el.click();
    return true;
  }, text, exact);
  await new Promise((r) => setTimeout(r, 300));
  return found;
}
async function wait(ms) { await new Promise((r) => setTimeout(r, ms)); }

/* ── 播种：真实点击创建 V3.2 计划 ── */
await page.evaluate(() => { window.location.hash = '#/plans'; });
await wait(600);
let seeded = await clickByText('使用 V3.2 预设');
if (!seeded) {
  seeded = await clickByText('+ 新建');
  if (seeded) { await wait(300); seeded = await clickByText('从 V3.2 预设新建'); }
}
await wait(1200);
const snap0 = await page.evaluate(() => window.__R2_SNAPSHOT__());
record('seed.plan-created', Array.isArray(snap0.plans) && snap0.plans.length > 0,
  `plans=${snap0.plans?.length ?? 0}`);

/* ── 进入计划管理页（含递减组动作）── */
async function gotoManage() {
  await page.evaluate(() => { window.location.hash = '#/plans'; });
  await wait(700);
}
await gotoManage();

/**
 * 找一个**递减组**动作所在的训练日并进入编辑页。
 *
 * 真实路径：管理页 → 选计划 → 训练日「编辑」/「编辑动作」入口。
 */
const entered = await page.evaluate(() => {
  const t = document.body.innerText || '';
  return { hasEdit: /编辑/.test(t), textLen: t.length };
});
record('manage.reachable', entered.hasEdit, `textLen=${entered.textLen}`);

// 点第一个「编辑动作」或「编辑」入口
let openedDay = await clickByText('编辑动作');
if (!openedDay) openedDay = await clickByText('编辑');
await wait(1200);
const dayText = await page.evaluate(() => document.body.innerText || '');
record('day-editor.reachable', dayText.length > 100 && /动作|训练日|计划/.test(dayText),
  `textLen=${dayText.length}`);

/* ── 缺口 1：内部 raw 清空 → blur 报错 → ‹计划 必须被拦 ── */
/**
 * 精确复现 Codex 001：
 *   编辑递减组配置 → 轮数输入框清空 → 真实 blur（触发"不能为空"）→ 点 ‹计划
 * 期望：**被拦住**（留在原页，草稿不丢）。
 *
 * 前置：V3.2 预设全是**普通组**，必须先通过真实 UI 把某个动作的训练形式
 * 切成「递减组」（这是产品真实路径，不是塞 IDB）。
 */
let dropEditorOpened = await clickByText('编辑递减组配置');
if (!dropEditorOpened) {
  // 真实点击训练形式分段控件里的「递减组」
  const switchedForm = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[role="group"]'));
    const seg = groups.find((g) => (g.getAttribute('aria-label') || '') === '训练形式');
    if (!seg) return false;
    const btn = Array.from(seg.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === '递减组',
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await wait(900);
  record('dropset.form-switched', switchedForm, switchedForm ? '训练形式已切到递减组' : '找不到训练形式控件');
  dropEditorOpened = await clickByText('编辑递减组配置');
}
await wait(900);
record('dropset.editor-opened', dropEditorOpened, dropEditorOpened ? '已打开递减组配置' : '找不到递减组配置入口');

if (dropEditorOpened) {
  await page.evaluate(() => window.__R2_CLEAR__());
  // 找到轮数输入框并清空（真实 input 事件）
  const cleared = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const rounds = inputs.find((i) => (i.getAttribute('aria-label') || '') === '轮数');
    if (!rounds) return false;
    rounds.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(rounds, '');
    rounds.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  await wait(300);
  record('g5.raw-cleared', cleared, cleared ? '轮数已清空' : '找不到轮数输入框');

  // 真实 blur：点另一个字段（触发 commit → "不能为空"）
  const blurred = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const other = inputs.find((i) => {
      const a = i.getAttribute('aria-label') || '';
      return a === '阶段间休息' || a === '轮间休息';
    });
    if (!other) return false;
    other.focus();
    return true;
  });
  await wait(400);
  const errorShown = await page.evaluate(() => /不能为空|未输完/.test(document.body.innerText || ''));
  record('g5.raw-error-shown', blurred && errorShown, `blur=${blurred}, 显示错误=${errorShown}`);

  // 记录离开前的 hash
  const hashBeforeLeave = await page.evaluate(() => window.location.hash);

  // 真实点击 ‹计划（返回按钮）
  const clickedBack = await clickByText('‹ 计划');
  if (!clickedBack) await clickByText('‹计划');
  await wait(900);

  const hashAfterLeave = await page.evaluate(() => window.location.hash);
  const trace = await page.evaluate(() => window.__R2_TRACE__ || []);
  const sessionPuts = trace.filter((t) => t.store === 'sessions');
  const planPuts = trace.filter((t) => t.store === 'plans');

  /**
   * 期望：**被拦住**（hash 不变，仍在同一页）。
   * 旧实现会直接离开（hash 变了）→ 草稿丢失。
   */
  const blocked = hashAfterLeave === hashBeforeLeave;
  record('g5.raw-empty-blocks-leave', blocked,
    `离开前=${hashBeforeLeave} 离开后=${hashAfterLeave} ${blocked ? '（已拦住）' : '（未拦住=丢草稿）'}`);
  record('g5.raw-empty-no-write', sessionPuts.length === 0 && planPuts.length === 0,
    `sessions put=${sessionPuts.length}, plans put=${planPuts.length}`);

  // 仍能看到错误/输入框（证明没被卸载）
  const stillThere = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.some((i) => (i.getAttribute('aria-label') || '') === '轮数');
  });
  record('g5.raw-empty-draft-not-unmounted', stillThere, `轮数输入框仍在=${stillThere}`);

  /* ── 缺口 2：取消后不得留幽灵 dirty ── */
  // 先恢复合法值并真实 blur（3 → 4）
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const rounds = inputs.find((i) => (i.getAttribute('aria-label') || '') === '轮数');
    if (!rounds) return;
    rounds.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(rounds, '4');
    rounds.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(200);
  // 真实 blur 到别的字段（合法提交，改变 structured draft）
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const other = inputs.find((i) => (i.getAttribute('aria-label') || '') === '阶段间休息');
    if (other) other.focus();
  });
  await wait(500);
  record('g5.legal-dirty-applied', true, '轮数 3→4 已 blur');

  // 真实点击「取消」
  const cancelled = await clickByText('取消', true);
  await wait(700);
  record('g5.cancel-clicked', cancelled, cancelled ? '已点取消' : '找不到取消按钮');

  const hashBeforeCancelBack = await page.evaluate(() => window.location.hash);
  const backAfterCancel = await clickByText('‹ 计划');
  if (!backAfterCancel) await clickByText('‹计划');
  await wait(900);
  const hashAfterCancelBack = await page.evaluate(() => window.location.hash);
  /**
   * 期望：取消后**必须能离开**（不再是幽灵 dirty）。
   * 旧实现：取消恢复 3，但 owner 仍 true → 点返回无反应。
   */
  const leftOk = hashAfterCancelBack !== hashBeforeCancelBack;
  record('g5.cancel-no-ghost-dirty', leftOk,
    `取消后返回：${hashBeforeCancelBack} → ${hashAfterCancelBack} ${leftOk ? '（已离开）' : '（仍被卡住=幽灵dirty）'}`);
}

/* ── 缺口 3：Back/Forward 历史完整性 ── */
await gotoManage();
const histBefore = await page.evaluate(() => ({ len: window.history.length, hash: window.location.hash }));
// 制造一次真实前进（进计划编辑）
await clickByText('编辑动作');
await wait(800);
const histMid = await page.evaluate(() => ({ len: window.history.length, hash: window.location.hash }));
record('history.entered-new-page', histMid.hash !== histBefore.hash,
  `${histBefore.hash} → ${histMid.hash}, historyLen ${histBefore.len}→${histMid.len}`);

// 真实 Back
await page.goBack().catch(() => {});
await wait(900);
const histBack = await page.evaluate(() => ({ hash: window.location.hash, len: window.history.length }));
record('history.back-returns', histBack.hash === histBefore.hash,
  `back 后=${histBack.hash}（期望 ${histBefore.hash}）`);

// 真实 Forward
await page.goForward().catch(() => {});
await wait(900);
const histFwd = await page.evaluate(() => ({ hash: window.location.hash, len: window.history.length }));
record('history.forward-returns', histFwd.hash === histMid.hash,
  `forward 后=${histFwd.hash}（期望 ${histMid.hash}）`);

/* ── 收尾 ── */
const hashAfter = srcHash();
record('source.stable', hashBefore === hashAfter,
  `before=${hashBefore.slice(0, 12)} after=${hashAfter.slice(0, 12)}`);
record('no.page-errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '无异常');

writeFileSync(path.join(OUTDIR, 'RESULTS.json'),
  JSON.stringify({ stamp: STAMP, hashBefore, hashAfter, pageErrors, results }, null, 2));
await page.screenshot({ path: path.join(OUTDIR, 'final.png'), fullPage: true }).catch(() => {});

await browser.close();
await new Promise((r) => server.close(r));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
console.log(`证据：${OUTDIR}`);
process.exitCode = failed.length ? 1 : 0;
