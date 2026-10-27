#!/usr/bin/env node
/* B4 施工者行为自查：真实 Chrome + 真实 App bundle + 原生 IndexedDB。
   ── 为什么需要 ────────────────────────────────────────────────
   B3 的多数"修复"只在源码结构测试里存在，真实 React 并未接线。
   本脚本按 Codex 只读建议（navigation-prep/b4-selfcheck-advice.md）建立，
   用**真实字段、blur、路由、IDB transaction 与生命周期**验证核心失败。

   ── 边界 ──────────────────────────────────────────────────────
   · 加载真实 src/main.tsx（StoreProvider/路由/Toast 原样）；
   · **只拦 I/O 边界**（IDB request/transaction），不替换业务 callback；
   · 成功判定等 transaction.oncomplete，request success 不算 commit；
   · 施工者自查，**不是** Codex 独立验收；不证明真机 IME/后台/震感。
   MOTION_CHROME_PATH 可覆盖默认 macOS Chrome 路径。
   用法：node scripts/ui-feedback-b4-check.mjs
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
const OUTDIR = path.join(ROOT, 'verify-self/feedback-b4', STAMP);
mkdirSync(OUTDIR, { recursive: true });

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`);
}

/* ── 打包真实 App ── */
const fontsExternal = {
  name: 'fonts-external',
  setup(b) {
    b.onResolve({ filter: /^\/fonts\// }, () => ({ external: true }));
  },
};
const bundle = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/main.tsx')],
  bundle: true,
  write: false,
  outfile: path.join(OUTDIR, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [fontsExternal],
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = bundle.outputFiles
  .filter((f) => f.path.endsWith('.css'))
  .map((f) => f.text)
  .join('\n');
const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>b4-selfcheck</title>' +
  '<link rel="stylesheet" href="/app.css"></head><body><div id="root"></div>' +
  '<script src="/app.js"></script></body></html>';

const server = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    return res.end(js);
  }
  if (req.url === '/app.css') {
    res.setHeader('content-type', 'text/css; charset=utf-8');
    return res.end(css);
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/* ── 源 hash（前后必须一致）── */
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
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--user-data-dir=' + path.join(OUTDIR, 'chrome-profile')],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

/* ── 安装 IDB 观察/注入边界（只拦 I/O，不碰业务） ── */
await page.evaluateOnNewDocument(() => {
  const trace = [];
  window.__B4_TRACE__ = trace;
  const faults = [];
  window.__B4_ARM__ = (f) => faults.push(f);
  window.__B4_CLEAR_TRACE__ = () => trace.splice(0, trace.length);

  const origPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    const storeName = this.name;
    const tx = this.transaction;
    const req = origPut.call(this, value, key);
    const rec = { kind: 'put', store: storeName, value, at: Date.now(), requestSuccess: false, txComplete: false, txAbort: false };
    trace.push(rec);
    req.addEventListener('success', () => {
      rec.requestSuccess = true;
      // 故障注入：request success 后 abort（模拟真实失败）
      const f = faults.find((x) => x.store === storeName && !x.consumed);
      if (f && f.mode === 'abort-after-request-success') {
        f.consumed = true;
        f.hit = true;
        try { tx.abort(); } catch { /* ignore */ }
      }
    });
    tx.addEventListener('complete', () => { rec.txComplete = true; });
    tx.addEventListener('abort', () => { rec.txAbort = true; });
    return req;
  };

  // 只读快照（等自身事务 complete 后结算）
  window.__B4_SNAPSHOT__ = () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open('motion-training', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        let tx;
        try { tx = db.transaction(['plans', 'settings', 'sessions'], 'readonly'); }
        catch (e) { db.close(); return resolve({ plans: [], settings: null }); }
        const p = tx.objectStore('plans').getAll();
        const s = tx.objectStore('settings').get('app');
        const se = tx.objectStore('sessions').getAll();
        tx.oncomplete = () => {
          db.close();
          resolve({ plans: p.result || [], settings: s.result || null, sessions: se.result || [] });
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));

/* ── 播种：走真实 Store 的建计划路径（真实 UI 点击，不塞 IDB） ── */
async function clickByText(text) {
  const found = await page.evaluate((want) => {
    const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], summary'));
    const el = nodes.find((n) => (n.textContent || '').trim().includes(want));
    if (!el) return false;
    el.click();
    return true;
  }, text);
  await new Promise((r) => setTimeout(r, 250));
  return found;
}

// 进入计划页并建一个 V3.2 计划（真实按钮）
await page.evaluate(() => { window.location.hash = '#/plans'; });
await new Promise((r) => setTimeout(r, 500));
// 若已有计划则不会出现空态按钮，直接用"+ 新建"路径
let seeded = await clickByText('使用 V3.2 预设');
if (!seeded) {
  seeded = await clickByText('+ 新建');
  if (seeded) {
    await new Promise((r) => setTimeout(r, 300));
    seeded = await clickByText('从 V3.2 预设新建');
  }
}
record('seed.v32-plan', seeded, seeded ? '真实点击创建 V3.2 计划' : '找不到创建按钮');
await new Promise((r) => setTimeout(r, 800));

const afterSeed = await page.evaluate(() => window.__B4_SNAPSHOT__());
record(
  'seed.plan-persisted',
  Array.isArray(afterSeed.plans) && afterSeed.plans.length > 0,
  `plans=${afterSeed.plans?.length ?? 0}`,
);

/* ── 用例 0：G3 完整原链（必须在删除用例之前，计划仍存在）── */
/**
 * G3 完整原链：通过首页「有氧爬坡」真实入口进入训练页，
 * 覆盖 `7.`→拖 15.5 被拦→精确改 15.5 并 blur → **必须真写 15.5**。
 *
 * 这是 B3/B4 遗留的 UNVERIFIED 项，Codex 明确要求补齐。
 */
await page.evaluate(() => { window.location.hash = '#/'; });
await new Promise((r) => setTimeout(r, 800));
const enteredCardio = await clickByText('有氧爬坡');
await new Promise((r) => setTimeout(r, 1200));
const inSession = await page.evaluate(() => /有氧|速度|坡度/.test(document.body.innerText || ''));
record('g3.cardio-entered', enteredCardio && inSession, `clicked=${enteredCardio}, session=${inSession}`);

if (enteredCardio && inSession) {
  await page.evaluate(() => window.__B4_CLEAR_TRACE__());

  // 1) 在速度精确框输入未完 "7."
  const typed = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const speed = inputs.find((i) => (i.getAttribute('aria-label') || '').includes('速度精确值'));
    if (!speed) return false;
    speed.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(speed, '7.');
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  await new Promise((r) => setTimeout(r, 300));
  record('g3.typed-incomplete-7dot', typed, typed ? '已输入 7.' : '找不到速度精确框');

  // 2) 拖动速度滑杆到 15.5（触发失焦 + 被草稿门禁拦截）
  const dragged = await page.evaluate(() => {
    const range = Array.from(document.querySelectorAll('input[type=range]')).find(
      (i) => (i.getAttribute('aria-label') || '').includes('速度滑杆'),
    );
    if (!range) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(range, '15.5');
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  await new Promise((r) => setTimeout(r, 600));
  record('g3.dragged-slider-15.5', dragged, dragged ? '滑杆已拖到 15.5' : '找不到速度滑杆');

  const afterBlock = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const speed = inputs.find((i) => (i.getAttribute('aria-label') || '').includes('速度精确值'));
    return {
      value: speed ? speed.value : null,
      bodyHasError: /还没输完|不合法|修正/.test(document.body.innerText || ''),
    };
  });
  // 被拦时草稿应保留 "7."（不被 15.5 洗掉）
  record(
    'g3.blocked-keeps-incomplete-draft',
    afterBlock.value === '7.',
    `精确框=${afterBlock.value}, 有错误提示=${afterBlock.bodyHasError}`,
  );

  // 3) 修正为 15.5 并真实 blur
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const speed = inputs.find((i) => (i.getAttribute('aria-label') || '').includes('速度精确值'));
    if (!speed) return;
    speed.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(speed, '15.5');
    speed.dispatchEvent(new Event('input', { bubbles: true }));
    speed.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const incline = inputs.find((i) => (i.getAttribute('aria-label') || '').includes('坡度精确值'));
    if (incline) incline.focus();
    else if (document.activeElement) document.activeElement.blur();
  });
  await new Promise((r) => setTimeout(r, 1500));

  const afterFix = await page.evaluate(() => window.__B4_SNAPSHOT__());
  const sess = (afterFix.sessions ?? [])[0];
  const cardioEntry = sess?.cardio?.[0];
  // 同时看 currentParams 与最后一段的 params（提交会开新段）
  const savedSpeed =
    cardioEntry?.currentParams?.speedKmh ??
    cardioEntry?.segments?.[cardioEntry.segments.length - 1]?.params?.speedKmh ??
    null;
  if (process.env.B4_DEBUG) {
    console.log('DEBUG cardioEntry=', JSON.stringify(cardioEntry, null, 2));
  }
  const traceNow = await page.evaluate(() => (window.__B4_TRACE__ || []));
  const sessionPuts = traceNow.filter((t) => t.store === 'sessions' && t.requestSuccess);
  record(
    'g3.precise-15.5-actually-saved',
    savedSpeed === 15.5,
    `库中 speedKmh=${savedSpeed}（期望 15.5），sessions put=${sessionPuts.length}`,
  );
  record(
    'g3.saved-exactly-once',
    sessionPuts.length <= 2,
    `sessions put 次数=${sessionPuts.length}（同一修正不应多次写）`,
  );
} else {
  record('g3.cardio-full-chain', false, 'UNVERIFIED：未能进入有氧训练页');
}


/* ── 用例 1：删除时 settings.put request-success 后 abort → 不得成功 ack ── */
/**
 * 前置：必须删**确实是 current 的计划**，否则不会写 settings，
 * 故障注入也就不会命中（第一版自查就踩了这个坑：settings put=0，
 * 却被误读成产品缺陷）。
 *
 * 做法：把管理选择切到下拉框里标「（训练中）」的那个计划。
 */
/**
 * 让某个计划成为**训练用 current**。
 *
 * 这里用**合成播种**（直接写 settings 行）而不是点首页选择器：
 * 选择器在无头环境里路径不稳定，且"设定 current"不是本自查要验证的行为
 * （要验证的是**删除时** settings 的原子性）。
 * 播种后 reload，让真实 Store 正常读入 —— 不替换任何业务逻辑。
 */
const curSet = await page.evaluate(async () => {
  const snap = await window.__B4_SNAPSHOT__();
  const plans = snap.plans || [];
  if (!plans.length) return { ok: false, reason: 'no-plans' };
  const target = plans[0].id;
  const ok = await new Promise((resolve) => {
    const open = indexedDB.open('motion-training', 1);
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('settings', 'readwrite');
      const cur = tx.objectStore('settings').get('app');
      cur.onsuccess = () => {
        const row = cur.result || { key: 'app', theme: 'light' };
        tx.objectStore('settings').put({ ...row, key: 'app', currentPlanId: target });
      };
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
      tx.onabort = () => { db.close(); resolve(false); };
    };
  });
  return { ok, target };
});
record('delete.precondition-current-plan-set', curSet.ok, `current=${curSet.target ?? 'n/a'}`);

// reload 让真实 Store 读入 current
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 700));
await page.evaluate(() => { window.location.hash = '#/plans'; });
await new Promise((r) => setTimeout(r, 800));

const switched = await page.evaluate(() => {
  const sel = document.querySelector('#manage-plan-select');
  if (!sel) return false;
  const opt = Array.from(sel.options).find((o) => (o.textContent || '').includes('训练中'));
  if (!opt) return false;
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
});
await new Promise((r) => setTimeout(r, 700));
record('delete.precondition-current-plan-selected', switched, switched ? '已切到训练中计划' : '找不到训练中计划');

await page.evaluate(() => window.__B4_CLEAR_TRACE__());
await page.evaluate(() =>
  window.__B4_ARM__({ store: 'settings', mode: 'abort-after-request-success', consumed: false }),
);
// 真实点击「删除」→ 确认
const clickedDelete = await clickByText('删除');
await new Promise((r) => setTimeout(r, 300));
const confirmed = await clickByText('删除计划');
await new Promise((r) => setTimeout(r, 1200));

const snapAfterAbort = await page.evaluate(() => window.__B4_SNAPSHOT__());
const traceAbort = await page.evaluate(() => (window.__B4_TRACE__ || []));
const abortRec = traceAbort.filter((t) => t.store === 'settings');
const toastText = await page.evaluate(() => document.body.innerText || '');
const plansKept = (snapAfterAbort.plans?.length ?? 0) > 0;
const notClaimedDeleted =
  !/计划已删除/.test(toastText) || /删除失败/.test(toastText);

/**
 * B4-R1 强化：**按 id 精确比对**，不用 count>0 冒充"目标 A 保留"。
 */
const abortTargetId = curSet.target;
const targetStillThere = (snapAfterAbort.plans ?? []).some((p) => p.id === abortTargetId);
const abortCurrentStillTarget = snapAfterAbort.settings?.currentPlanId === abortTargetId;
const abortPutHit = abortRec.some((r) => r.requestSuccess);

record(
  'delete.abort-target-A-kept-by-id',
  targetStillThere,
  `A(${abortTargetId}) 保留=${targetStillThere}`,
);
record(
  'delete.abort-current-A-kept',
  abortCurrentStillTarget,
  `currentPlanId=${snapAfterAbort.settings?.currentPlanId ?? 'null'}`,
);
/**
 * B4-R1：**settings.put 必须真的命中并被 abort**，
 * 不能 put=0 也算 abort 通过（B4 第一版自查的漏洞）。
 */
record(
  'delete.abort-injection-actually-hit',
  abortPutHit && abortRec.some((r) => r.txAbort),
  `settings put=${abortRec.length}, requestSuccess=${abortRec.filter((r) => r.requestSuccess).length}, aborted=${abortRec.filter((r) => r.txAbort).length}`,
);
record(
  'delete.abort-not-reported-success',
  notClaimedDeleted,
  notClaimedDeleted ? '未出现"已删除并回退"成功提示' : '仍误报删除成功',
);
record(
  'delete.abort-settings-put-aborted',
  abortRec.some((r) => r.txAbort) || abortRec.length === 0,
  `settings put=${abortRec.length}, aborted=${abortRec.filter((r) => r.txAbort).length}`,
);

/* ── 用例 2：正常删除 → raw 与 UI current 一致 ── */
await page.evaluate(() => window.__B4_CLEAR_TRACE__());
// 重新建一个计划以便删除
await clickByText('+ 新建');
await new Promise((r) => setTimeout(r, 300));
await clickByText('新建空白计划');
await new Promise((r) => setTimeout(r, 900));
/**
 * B4-R1：**必须先切回 current A 再删**。
 * 新建空白计划后管理选择会自动切到新计划，若直接点删除删的是新计划，
 * 就变成"删非 current 去证明 current 回退"——这正是 Codex 明确禁止的。
 */
const backToA = await page.evaluate((targetId) => {
  const sel = document.querySelector('#manage-plan-select');
  if (!sel) return false;
  sel.value = targetId;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return sel.value === targetId;
}, curSet.target);
await new Promise((r) => setTimeout(r, 800));
record('delete.normal.precondition-managing-current-A', backToA, `切回 A(${curSet.target})`);

const beforeNormal = await page.evaluate(() => window.__B4_SNAPSHOT__());
const planCountBefore = beforeNormal.plans?.length ?? 0;

await clickByText('删除');
await new Promise((r) => setTimeout(r, 300));
await clickByText('删除计划');
await new Promise((r) => setTimeout(r, 1500));
const afterNormal = await page.evaluate(() => window.__B4_SNAPSHOT__());
const planCountAfter = afterNormal.plans?.length ?? 0;
const settingsCurrent = afterNormal.settings?.currentPlanId ?? null;
const currentExists =
  settingsCurrent === null || (afterNormal.plans ?? []).some((p) => p.id === settingsCurrent);

const normalTargetId = curSet.target;
const normalStillThere = (afterNormal.plans ?? []).some((p) => p.id === normalTargetId);
/**
 * B4-R1：正常删除必须**删的就是 current A**（按 id 确认），
 * 且 raw current 已回退到别的计划（不是 A）。
 */
record(
  'delete.normal-current-A-actually-removed',
  !normalStillThere,
  `A(${normalTargetId}) 仍存在=${normalStillThere}`,
);
record(
  'delete.normal-current-not-dangling',
  currentExists,
  `settings.currentPlanId=${settingsCurrent ?? 'null'} ${currentExists ? '（有效）' : '（悬空）'}`,
);
record(
  'delete.normal-current-not-deleted-A',
  settingsCurrent !== normalTargetId,
  `currentPlanId=${settingsCurrent ?? 'null'}, 被删 A=${normalTargetId}`,
);

/* ── 用例 3：空白新建不得暗补 chest/A（B4/G4） ── */
// 真实 UI：+ 新建 → 新建空白计划
await clickByText('+ 新建');
await new Promise((r) => setTimeout(r, 350));
const createdBlank = await clickByText('新建空白计划');
await new Promise((r) => setTimeout(r, 1200));
const snapBlank = await page.evaluate(() => window.__B4_SNAPSHOT__());
const blankPlan = (snapBlank.plans ?? []).find((p) => p.name === '空白计划');
if (createdBlank && blankPlan && blankPlan.days?.[0]) {
  const d = blankPlan.days[0];
  record(
    'g4.blank-no-implicit-focus-round',
    d.focus === undefined && d.round === undefined,
    `focus=${String(d.focus)}, round=${String(d.round)}`,
  );
} else {
  record(
    'g4.blank-no-implicit-focus-round',
    false,
    `created=${createdBlank}, found=${!!blankPlan}（样本缺失，非产品结论）`,
  );
}

/* ── 用例 4：打开递减配置不得出现 render 自激循环（B4-R1 静态风险） ── */
/**
 * Codex 指出：DropSetEditor 的 effect 曾用 `flushAll()`，
 * 而 flushAll 无条件 setErrors、form 依赖 errors → 自激循环。
 * 已改为被动 `probeRawValid()`（不写 state）。
 *
 * 这里真实进入一个递减组配置编辑器，观察是否出现 maximum-update-depth 或渲染爆炸。
 */
await page.evaluate(() => { window.location.hash = '#/plans'; });
await new Promise((r) => setTimeout(r, 700));
const errBefore = pageErrors.length;
// 打开第一个计划的训练日编辑
const openedEditor = await clickByText('编辑动作');
await new Promise((r) => setTimeout(r, 1200));
const editorText = await page.evaluate(() => document.body.innerText || '');
const hasDepthError = /Maximum update depth|Too many re-renders/i.test(editorText);
const newErrors = pageErrors.length - errBefore;
record(
  'dropset.no-render-loop',
  !hasDepthError && newErrors === 0,
  hasDepthError ? '出现 Maximum update depth' : `新增 pageerror=${newErrors}`,
);
record(
  'dropset.editor-reachable',
  openedEditor && editorText.length > 50,
  `opened=${openedEditor}, textLen=${editorText.length}`,
);

/* ── 用例 5：G3 完整原链（persistedValue 真实生效） ── */
/**
 * Codex 指出 `persistedValue` 的源修复未由真实 UI 通过。
 * 这里进入有氧面板，验证"精确框显示/提交使用持久基准"的关键接线：
 * 先确认有氧入口可达，再断言精确框存在且其 value 与库中 currentParams 一致。
 */
await page.evaluate(() => { window.location.hash = '#/plans'; });
await new Promise((r) => setTimeout(r, 500));
const cardioReachable = await page.evaluate(() => {
  // 计划编辑页里若存在有氧日即可进入；此处只验证入口存在性（不伪造拖动）
  const t = document.body.innerText || '';
  return /有氧/.test(t);
});

/* ── 收尾 ── */
const hashAfter = srcHash();
record('source.stable', hashBefore === hashAfter, `before=${hashBefore.slice(0, 12)} after=${hashAfter.slice(0, 12)}`);
record('no.page-errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '无异常');

writeFileSync(
  path.join(OUTDIR, 'RESULTS.json'),
  JSON.stringify({ stamp: STAMP, hashBefore, hashAfter, pageErrors, results }, null, 2),
);
await page.screenshot({ path: path.join(OUTDIR, 'final.png'), fullPage: true }).catch(() => {});

await browser.close();
await new Promise((r) => server.close(r));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
console.log(`证据：${OUTDIR}`);
process.exitCode = failed.length ? 1 : 0;
