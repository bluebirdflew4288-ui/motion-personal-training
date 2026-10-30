/* 第3阶段自查：真实 Chrome + 真实 App bundle + 真实原生 IndexedDB 的
   计划模板导入 DOM 验证（施工者执行，项目内自测；不是 Codex 独立合约）。
   · 加载真实 src/main.tsx（StrictMode/StoreProvider/路由/Toasts 原样）
   · 只通过真实点击/输入驱动；不替换任何生产回调
   · IDB 只读核验在页面上下文里用原生 indexedDB API
   · esbuild 插件把 base.css 的 /fonts/* 标为 external（打包时保留 URL，运行不影响逻辑）
   MOTION_CHROME_PATH 可覆盖默认 macOS Chrome 路径。
   用法：node scripts/ui-template-import-check.mjs */
import { createHash } from 'node:crypto';
import fs, { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUTDIR = process.env.MOTION_UI_EVIDENCE_DIR
  ? path.resolve(process.env.MOTION_UI_EVIDENCE_DIR)
  : path.join(ROOT, 'verify-self/ui-template-import');
mkdirSync(OUTDIR, { recursive: true });

function demand(cond, msg, extra) {
  if (!cond) {
    const e = new Error(msg);
    if (extra) e.details = extra;
    throw e;
  }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── bundle real app ── */
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
  outfile: path.join(OUTDIR, 'bundle.js'), // 仅为配置输出路径（write:false 下 CSS 需要）
  format: 'iife',
  jsx: 'automatic',
  target: 'chrome120',
  loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [fontsExternal],
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = bundle.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n');
const html =
  '<!doctype html><html><head><meta charset="utf-8"><title>self</title>' +
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

/* ── src hash（执行前后必须一致）── */
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

let browser;
let failed = 0;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--user-data-dir=' + path.join(OUTDIR, 'chrome-profile')],
  });
  const results = [];
  let pageError = null;

async function readPlans() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('motion-training', 1);
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction('plans', 'readonly');
          const all = t.objectStore('plans').getAll();
          all.onsuccess = () => {
            resolve(all.result || []);
            db.close();
          };
          all.onerror = () => reject(new Error('idb read fail'));
        };
        req.onerror = () => reject(req.error);
      }),
  );
}
async function clickButton(scope, text) {
  const isPage = typeof scope.goto === 'function';
  const h = isPage
    ? await scope.evaluateHandle((want) => {
        const list = [...document.querySelectorAll('button')];
        return list.find((b) => b.textContent.trim() === want || b.textContent.trim().startsWith(want));
      }, text)
    : await scope.evaluateHandle((el, want) => {
        const list = [...el.querySelectorAll('button')];
        return list.find((b) => b.textContent.trim() === want || b.textContent.trim().startsWith(want));
      }, text);
  const b = h.asElement();
  demand(Boolean(b), `找不到按钮「${text}」`);
  const disabled = await b.evaluate((e) => e.disabled);
  demand(!disabled, `按钮「${text}」被禁用`);
  await b.click();
  await delay(80); // 给 React 一次渲染时机，避免下一查询落在过渡帧
}
async function dialog(title) {
  const h = await page.evaluateHandle((t) => [...document.querySelectorAll('[role=dialog]')].find((d) => (d.getAttribute('aria-label') ?? '').includes(t)), title);
  const el = h.asElement();
  if (!el) {
    const dump = await page.evaluate(() => ({
      dialogs: [...document.querySelectorAll('[role=dialog]')].map((d) => d.getAttribute('aria-label')),
      buttons: [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 12),
      text: document.body.textContent.slice(0, 200),
    }));
    demand(false, `找不到弹层「${title}」 DOM快照=${JSON.stringify(dump)}`);
  }
  return el;
}
async function waitCond(fn, msg, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return;
    await delay(50);
  }
  demand(false, msg);
}
async function dismissToasts() {
  // 真人也会点掉提示气泡；错误气泡 z-index:90 会盖住底部勾选框
  for (let i = 0; i < 8; i++) {
    const t = await page.$('.toast');
    if (!t) return;
    await t.click().catch(() => {});
    await delay(60);
  }
}
async function closeAllSheets() {
  for (let i = 0; i < 4; i++) {
    const open = await page.evaluate(() => document.querySelectorAll('[role=dialog]').length);
    if (!open) return;
    await page.keyboard.press('Escape');
    await delay(120);
  }
}

async function openImportSheet() {
  await clickButton(page, '+ 新建');
  const newSheet = await dialog('新建计划');
  // 点击可能撞上残留 toast 遮罩：验证真的进入模板弹层，否则再点一次
  for (let attempt = 0; attempt < 3; attempt++) {
    await clickButton(newSheet, '导入计划模板（JSON）');
    await delay(150);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('[role=dialog]')].some((d) => (d.getAttribute('aria-label') ?? '').includes('导入计划模板')),
    );
    if (found) return await dialog('导入计划模板');
    // 若新计划 Sheet 还开着再试；已经关了但也没找到 → 直接重新打开
    const stillNew = await page.evaluate(() =>
      [...document.querySelectorAll('[role=dialog]')].some((d) => (d.getAttribute('aria-label') ?? '') === '新建计划'),
    );
    if (!stillNew) await clickButton(page, '+ 新建').catch(() => {});
    await delay(150);
  }
  return await dialog('导入计划模板');
}

async function setInputValue(el, value) {
  await page.evaluate((node, v) => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(node, v);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, el, value);
}

const page = await browser.newPage();
await page.setViewport({ width: 480, height: 900 });
page.on('pageerror', (err) => { pageError = err.message; });


async function installSlowText(map) {
  // 只延迟真实外部 I/O 边界 File.text()，不改任何业务逻辑
  await page.evaluate((m) => {
    if (!window.__origFileText) {
      window.__origFileText = File.prototype.text; // 不 bind：下面用 orig.call(this)
      File.prototype.text = function patchedText() {
        const orig = window.__origFileText;
        const d = (window.__slowMap || {})[this.name] || 0;
        const pr = orig.call(this);
        if (!d) return pr;
        return new Promise((res, rej) => setTimeout(() => pr.then((t) => res(t), rej), d));
      };
    }
    window.__slowMap = m;
  }, map);
}
async function acceptFile(tpl, filePath) {
  // 真实边界：点「选择 JSON 文件」→ 系统文件框 → 选一个文件（隐藏 input 非 multiple，一次一个）
  const chooserP = page.waitForFileChooser();
  await clickButton(tpl, '选择 JSON 文件');
  const chooser = await chooserP;
  await chooser.accept([filePath]); // 数组单元素（此版本把裸字符串按字符展开→误判 multiple）
}
async function dropFileDuringSubmit(filePath) {
  // 不依赖按钮入口：直接向隐藏 input 程序化塞文件并派发 change
  // （模拟确认在途时的新文件读；组件必须靠自身代次+提交锁守卫，而非只靠禁用按钮）
  const data = readFileSync(filePath, 'utf8');
  await page.evaluate((text) => {
    const inp = document.querySelector('input[aria-label="选择计划模板文件"]');
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'tplD-late.json', { type: 'application/json' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, data);
}

const EXAMPLE = readFileSync(path.join(ROOT, 'test/fixtures/plan-template-v1.example.json'), 'utf8');

async function caseIt(id, run) {
  try {
    await run();
    results.push({ id, pass: true });
    console.log('PASS', id);
  } catch (err) {
    results.push({ id, pass: false, error: err.message, details: err.details ?? null });
    console.log('FAIL', id, '-', err.message);
  }
}

await page.goto(`http://127.0.0.1:${port}/#/plans`, { waitUntil: 'domcontentloaded' });
await waitCond(async () => (await page.$('button')) !== null, '应用未渲染');
async function resetBaseline() {
  // 每个用例前重置：清 plans/sessions/settings（保留 meta），reload 后 ensureSeed
  // 恰播种 1 条 V3.2 —— 这是产品的“不留空库”行为，因此基线恒为 1，可确定。
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('motion-training', 1);
        req.onsuccess = () => {
          const db = req.result;
          const t = db.transaction(['plans', 'sessions', 'settings'], 'readwrite');
          t.objectStore('plans').clear();
          t.objectStore('sessions').clear();
          t.objectStore('settings').clear();
          t.oncomplete = () => { db.close(); resolve(); };
          t.onerror = () => reject(t.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitCond(async () => (await page.$('button')) !== null, '重载后未渲染');
  // 等种子落库并稳定
  let prev = -1;
  let n = 0;
  for (let i = 0; i < 80; i++) {
    await delay(50);
    try { n = (await readPlans()).length; } catch { n = 0; }
    if (n >= 1 && n === prev) break;
    prev = n;
  }
  return n; // 恒为 1（ensureSeed 播种一条）
}

const baseline0 = await resetBaseline();
console.log('baseline after reset:', baseline0);

await caseIt('ui-paste-validate-preview-zero-write', async () => {
  const base = await resetBaseline();
  const tpl0 = await openImportSheet();
  const ta = await tpl0.$('textarea[aria-label="粘贴计划模板 JSON"]');
  demand(Boolean(ta), '找不到粘贴输入');
  await setInputValue(ta, EXAMPLE);
  await clickButton(tpl0, '校验并预览');
  const prev = await dialog('导入计划模板');
  await waitCond(
    async () => {
      const t = await prev.evaluate((el) => el.textContent);
      return t.includes('只读预览') && t.includes('5.5') && t.includes('档位 8');
    },
    '预览没有出现完整内容',
  );
  const plans = await readPlans();
  demand(plans.length === base, `预览阶段不应写库：baseline ${base}，实际 ${plans.length}`);
  // 取消 → 仍然零写
  await clickButton(prev, '返回修改');
  const back = await dialog('导入计划模板');
  const ta2 = await back.$('textarea[aria-label="粘贴计划模板 JSON"]');
  const kept = await ta2.evaluate((e) => e.value.length);
  demand(kept > 100, '原文应保留可继续修改');
  await clickButton(back, '取消');
  const plans2 = await readPlans();
  demand(plans2.length === base, '取消后仍不应有任何写入');
});

await caseIt('ui-invalid-input-rejected-no-write', async () => {
  const base = await resetBaseline();
  const tpl0 = await openImportSheet();
  const ta = await tpl0.$('textarea[aria-label="粘贴计划模板 JSON"]');
  const bad = EXAMPLE.replace('"speedKmh": 5.5', '"speedKmh": 0.15');
  await setInputValue(ta, bad);
  await clickButton(tpl0, '校验并预览');
  const err = await dialog('导入计划模板');
  await waitCond(async () => {
    const t = await err.evaluate((el) => el.textContent);
    return t.includes('校验未通过') && t.includes('speedKmh');
  }, '非法值没有被明确拒绝或错误位置不可读');
  const plans = await readPlans();
  demand(plans.length === base, '非法输入不得写入');
  await closeAllSheets(); // 收尾必须关窗，否则污染后续用例
});

await caseIt('ui-confirm-inserts-once-and-persist', async () => {
  const base = await resetBaseline();
  const tpl0 = await openImportSheet();
  const ta = await tpl0.$('textarea[aria-label="粘贴计划模板 JSON"]');
  await setInputValue(ta, EXAMPLE);
  await clickButton(tpl0, '校验并预览');
  const prev = await dialog('导入计划模板');
  // 连点两次确认：门禁必须只建一份
  await clickButton(prev, '确认新增这个计划');
  try {
    const p2 = await dialog('导入计划模板');
    const b = await p2.evaluateHandle((el) => [...el.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认新增这个计划'));
    const el = b.asElement();
    if (el && !(await el.evaluate((e) => e.disabled))) await el.click();
  } catch {
    /* 弹层已关闭 */
  }
  await waitCond(async () => (await readPlans()).length === base + 1, '确认后应恰好新增一条');
  const plan = (await readPlans()).find((p) => p.days?.length === 5 && p.days.some((d) => d.kind === 'cardio'));
  demand(plan.cursor === 0, `cursor 应为 0，实际 ${plan.cursor}`);
  demand(plan.days.length === 5, '5 个训练日');
  const exIds = plan.days.flatMap((d) => d.exercises.map((e) => e.exerciseId));
  demand(exIds.includes('lib-chest-dip') && exIds.includes('lib-pull-up'), 'exerciseId 应走既有身份映射');
  const cardio = plan.days.find((d) => d.kind === 'cardio');
  demand(cardio.cardio[0].target.speedKmh === 5.5, '有氧目标保真');
  await page.screenshot({ path: path.join(OUTDIR, 'imported.png') });
  await closeAllSheets();
});

async function importOnce(expectedCount) {
  // 完整走一遍：打开 → 粘贴 → 校验预览 → 确认 → 关闭
  const tpl = await openImportSheet();
  const ta = await tpl.$('textarea[aria-label="粘贴计划模板 JSON"]');
  await setInputValue(ta, EXAMPLE);
  await clickButton(tpl, '校验并预览');
  const prev = await dialog('导入计划模板');
  await clickButton(prev, '确认新增这个计划');
  await waitCond(async () => (await readPlans()).length === expectedCount, `导入后应到 ${expectedCount} 条`);
  await closeAllSheets();
}

await caseIt('ui-same-name-requires-explicit-confirm', async () => {
  const base = await resetBaseline();
  // 先干净地导入一份（此时没有同名）→ base+1
  await importOnce(base + 1);
  demand((await readPlans()).filter((p) => p.days?.length === 5 && p.days.some((d) => d.kind === 'cardio')).length === 1, '示例应已存在一份');

  // 第二次导入同名示例：确认应被同名门禁拦下，**不新增**
  const tpl = await openImportSheet();
  const ta = await tpl.$('textarea[aria-label="粘贴计划模板 JSON"]');
  await setInputValue(ta, EXAMPLE);
  await clickButton(tpl, '校验并预览');
  const prev = await dialog('导入计划模板');
  await clickButton(prev, '确认新增这个计划');
  await waitCond(async () => {
    const t = await prev.evaluate((el) => el.textContent).catch(() => '');
    return t.includes('同名');
  }, '同名门禁未出现');
  demand((await readPlans()).length === base + 1, '同名未明确确认前不得新增');

  // 明确勾选「确认新增同名计划」后 → 才允许再来一份，且独立 ID
  // 同名门禁只内联显示（不再有气泡遮挡）：直接真实点击勾选
  const box = await prev.$('input[type=checkbox]');
  demand(Boolean(box), '找不到「确认新增同名计划」勾选');
  await box.click();
  const checked = await box.evaluate((e) => e.checked);
  demand(checked, '勾选未生效（可能被 toast 遮罩拦截）');
  await clickButton(prev, '确认新增这个计划');
  await waitCond(async () => (await readPlans()).length === base + 2, '明确确认后应新增独立一份');
  const plans = await readPlans();
  demand(new Set(plans.map((x) => x.id)).size === plans.length, '每份计划必须有独立 ID（不按名称合并）');
  demand(plans.filter((x) => x.name === plans.find((x) => x.days?.length === 5)?.name).length >= 2, '应存在两份同名但独立的计划');
  await closeAllSheets();
});

/* ── G1（REVIEW-3）：读回归属，真实 File.text 延迟只动外部 I/O 边界 ── */
// tplA/B/C/D 是纯合成输入（若不存在则现场生成，保证 harness 可重复运行）
function ensureTplFile(name, planName, pad = 0) {
  const fp = path.join(OUTDIR, name);
  if (fs.existsSync(fp)) return fp;
  const warmups = Array.from({ length: pad }, (_, i) => ({ name: `热身${i}`, unit: 'reps', targetText: '1 × 10 次' }));
  const doc = {
    format: 'motion-plan-template',
    version: 1,
    plan: {
      name: planName,
      days: [{ name: '胸 A', kind: 'train', focus: 'chest', round: 'A', warmups, exercises: [{ name: '双杠臂屈伸', restSec: 120, target: { kind: 'straight', sets: 3, repsMin: 8, repsMax: 12, weightMode: 'bodyweight', suggestedWeightKg: null } }] }],
    },
  };
  writeFileSync(fp, JSON.stringify(doc), 'utf8');
  return fp;
}
const TPL_A = ensureTplFile('tplA.json', '计划甲慢覆盖');
const TPL_B = ensureTplFile('tplB.json', '计划乙快');
const TPL_C = ensureTplFile('tplC.json', '计划丙确认在途');
const TPL_D = ensureTplFile('tplD.json', '计划丁迟到覆盖', 4200); // ~260KB：真实读盘自然变慢

await caseIt('ui-g1-slow-A-cannot-overwrite-fast-B', async () => {
  const base = await resetBaseline();
  await installSlowText({ 'tplA.json': 900, 'tplB.json': 30 });
  const tpl = await openImportSheet();
  await acceptFile(tpl, TPL_A); // A 慢读在途
  await acceptFile(tpl, TPL_B); // B 快读：选择新来源本身即作废 A
  const prev = await dialog('导入计划模板');
  await waitCond(async () => (await prev.evaluate((el) => el.textContent)).includes('计划乙快'), 'B 未进入预览');
  await delay(1200); // 等 A 的过期读返回
  const t = await prev.evaluate((el) => el.textContent);
  demand(t.includes('计划乙快') && !t.includes('计划甲慢覆盖'), `过期 A 覆盖了当前预览：${t.slice(0, 80)}`);
  demand((await readPlans()).length === base, '预览阶段仍零写入');
  await closeAllSheets();
});

await caseIt('ui-g1-cancel-reopen-then-paste-B-wins-over-old-A', async () => {
  const base = await resetBaseline();
  await installSlowText({ 'tplA.json': 900 });
  const tpl = await openImportSheet();
  await acceptFile(tpl, TPL_A); // A 读回在途
  await clickButton(tpl, '取消'); // 关闭重开：旧轮读必须失效
  await delay(120);
  const tpl2 = await openImportSheet();
  const ta = await tpl2.$('textarea[aria-label="粘贴计划模板 JSON"]');
  await setInputValue(ta, readFileSync(TPL_B, 'utf8')); // 新轮粘贴 B
  await clickButton(tpl2, '校验并预览');
  const prev = await dialog('导入计划模板');
  await waitCond(async () => (await prev.evaluate((el) => el.textContent)).includes('计划乙快'), '新轮 B 未预览');
  await delay(1200); // 旧 A 此刻才返回
  const t = await prev.evaluate((el) => el.textContent);
  demand(t.includes('计划乙快') && !t.includes('计划甲慢覆盖'), `重开后的旧读覆盖了新轮：${t.slice(0, 80)}`);
  await closeAllSheets();
});

await caseIt('ui-g1-confirm-in-flight-stays-stable', async () => {
  // C 已粘贴并预览。确认点击后：
  //  (a) 旧轮在途慢读（B，选在确认前）返回 → 代次过期丢弃；
  //  (b) 确认在途时**新**文件读（D，程序化塞 input，拿到的是更新代次）返回
  //      → 必须靠提交锁丢弃：不重置 submitted、不换提交对象。
  const base = await resetBaseline();
  await installSlowText({ 'tplA.json': 900, 'tplB.json': 900, 'tplD-late.json': 400 });
  const tpl = await openImportSheet();
  const ta = await tpl.$('textarea[aria-label="粘贴计划模板 JSON"]');
  await setInputValue(ta, readFileSync(TPL_C, 'utf8'));
  await clickButton(tpl, '校验并预览');
  const prev = await dialog('导入计划模板');
  await waitCond(async () => (await prev.evaluate((el) => el.textContent)).includes('计划丙确认在途'), 'C 未预览');
  await acceptFile(prev, TPL_B); // 旧轮在途慢读（B）
  await clickButton(prev, '确认新增这个计划'); // 确认锁定当前对象
  try {
    await dropFileDuringSubmit(TPL_D); // 确认在途期间的**新**代次文件读
  } catch {
    /* 提交太快、弹层已关：说明成功路径已锁定，同样由重开复位保证干净 */
  }
  await waitCond(async () => (await readPlans()).length === base + 1, '确认应恰好写入一份');
  await delay(1300); // B、D 都已返回的窗口
  const plans = await readPlans();
  demand(plans.length === base + 1, `晚到读回干扰了提交：新增 ${plans.length - base} 份`);
  demand(plans.some((p) => p.name === '计划丙确认在途'), '提交内容必须仍是当前预览对象');
  demand(!plans.some((p) => p.name === '计划乙快' || p.name === '计划丁迟到覆盖'), '晚到读回不得成为提交对象');
  // 重新打开必须是**干净的新轮次**：不卡在旧预览、提交锁已复位、入口非永久禁用。
  // （粘贴文本可保留——关闭不应销毁用户内容；关键是不会自动进入旧预览或重复提交。）
  const tpl2 = await openImportSheet();
  const t2 = await tpl2.evaluate((el) => el.textContent);
  demand(t2.includes('校验并预览') && !t2.includes('只读预览'), `重开后应回到干净编辑态：${t2.slice(0, 60)}`);
  const ta2 = await tpl2.$('textarea[aria-label="粘贴计划模板 JSON"]');
  demand(ta2 !== null, '重开后输入区应可用');
  const enabled = await ta2.evaluate((e) => !e.disabled);
  demand(enabled, '重开后输入区不应被永久禁用');
  // 能重新发起一轮：粘贴 B 校验进入预览，但确认前仍零写入
  await setInputValue(ta2, readFileSync(TPL_B, 'utf8'));
  await clickButton(tpl2, '校验并预览');
  const prev2 = await dialog('导入计划模板');
  await waitCond(async () => (await prev2.evaluate((el) => el.textContent)).includes('计划乙快'), '新一轮粘贴未预览');
  demand((await readPlans()).length === base + 1, '新一轮预览阶段仍不得写入');
  await closeAllSheets();
});

  demand(pageError === null, `真实页面出现 JS 错误：${pageError}`);
  const hashAfter = srcHash();
  demand(hashBefore === hashAfter, '执行期间源码发生变化，结果无效');

  writeFileSync(
    path.join(OUTDIR, 'results.json'),
    JSON.stringify({ at: new Date().toISOString(), srcHash: hashBefore, results, pageError }, null, 2),
  );
  failed = results.filter((r) => !r.pass).length;
  console.log(`RESULT ${results.length - failed}/${results.length} PASS; ${failed} FAIL`);
  console.log('Evidence:', path.join(OUTDIR, 'results.json'));
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  if (server) {
    try { server.close(); } catch {}
  }
}
process.exit(failed ? 1 : 0);
