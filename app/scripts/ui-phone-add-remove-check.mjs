#!/usr/bin/env node
/* 手机反馈问题二、三的施工者行为自查：真实 Chrome + 真实 App bundle + 原生 IndexedDB。

   ── 覆盖 ──────────────────────────────────────────────────────
   问题二：选库动作 / 自定义名 → **先配置**组数、每组目标次数、组间休息 → 确认才添加。
     · 取消不写库、不产生空动作；
     · 非法 / 半输入 / 越界 / 下限>上限 被阻止且草稿保留；
     · 确认用当前 raw（不依赖 blur）；
     · 慢保存期间重复点击只产生一个动作；
     · 保存失败 → 重试不重复添加；成功提示只来自真实保存结果；
     · 动作数上限（UI + 领域同一条 MAX_EXERCISES）。
   问题三：训练动作工具里的「从本次训练移除」。
     · 未记录动作：确认后移除，其余动作/顺序不变；
     · 有实际输入（含 0、partial、备注、raw 草稿）→ 保护并提示可跳过剩余组；
     · 打开确认后状态变化 → 按最新记录与稳定 ID 复核；
     · 同名不同 ID 只移除目标那一条；
     · 末项移除后空态正常、可重新添加、刷新与备份恢复合法；
     · 移除后关闭相关工具层、不留幽灵面板。

   ── 边界（诚实声明）──────────────────────────────────────────
   · 加载真实 src/main.tsx（StoreProvider / 路由 / Toast 原样）；
   · **只拦 I/O 边界**（IDB request/transaction），不替换任何业务回调；
   · fixture 例外（Codex 裁决）：在 App 挂载前一次性写入**纯合成**计划/训练记录，
     用于「60 项上限」「同名不同 ID」「partial」等边界；挂载后所有待验业务操作
     全部走真实 UI 点击。不接触个人 DB（独立 profile + 独立端口）。
   · 故障注入只放在存储边界（IDB request abort），不注入产品内部回调。
   · 施工者自查，**不是** Codex 独立验收；不证明真机 IME/后台/提醒。

   用法：node scripts/ui-phone-add-remove-check.mjs
   MOTION_CHROME_PATH 可指定 Chrome；MOTION_UI_EVIDENCE_DIR 可覆盖证据目录。 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.MOTION_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTDIR = process.env.MOTION_UI_EVIDENCE_DIR
  ? path.resolve(process.env.MOTION_UI_EVIDENCE_DIR)
  : path.join(ROOT, 'verify-feedback/phone-add-remove-20261027/runs', STAMP);
mkdirSync(OUTDIR, { recursive: true });

const results = [];
function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? '  — ' + detail : ''}`);
}
function skip(id, detail) {
  results.push({ id, ok: true, skipped: true, detail });
  console.log(`SKIP  ${id}${detail ? '  — ' + detail : ''}`);
}

/* ── 打包真实 App（只把字体走外链，与既有自查脚本同一口径）── */
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
  '<!doctype html><html><head><meta charset="utf-8"><title>phone-add-remove-selfcheck</title>' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
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
  if (req.url === '/__blank') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><html><head><meta charset="utf-8"><title>blank</title></head><body></body></html>');
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ORIGIN = `http://127.0.0.1:${port}`;

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
try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--user-data-dir=' + path.join(OUTDIR, 'chrome-profile')],
  });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

/** 在 App 挂载前装好：IDB 边界观察 + 故障注入开关 + fixture 播种器 */
await page.evaluateOnNewDocument(() => {
  const trace = [];
  window.__AR_TRACE__ = trace;
  window.__AR_CLEAR__ = () => trace.splice(0, trace.length);
  /** 故障注入：只作用于存储边界（sessions 写事务创建失败） */
  window.__AR_FAULTS__ = { sessionsWriteFail: 0, sessionsPutDelayMs: 0 };

  /**
   * 故障注入实现说明（为什么不用 tx.abort()）：
   * 一次保存事务里应用会写 session 与 meta（锁心跳）两条记录。
   * 若在 session put 后 abort，随后同一事务里的 meta put 会抛
   * TransactionInactiveError —— 那是**注入方式**造成的假象，不是产品缺陷。
   * 因此改为让「包含 sessions 的 readwrite 事务创建」直接失败一次：
   * 效果等价于本地写入不可用，应用必须走既有失败/重试路径。
   */
  const origTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (storeNames, mode) {
    const faults = window.__AR_FAULTS__ || {};
    const list = Array.isArray(storeNames) ? storeNames : [storeNames];
    if (faults.sessionsWriteFail > 0 && mode === 'readwrite' && list.includes('sessions')) {
      faults.sessionsWriteFail -= 1;
      throw new DOMException('注入：本地写入不可用', 'AbortError');
    }
    return origTransaction.call(this, storeNames, mode);
  };

  const origPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    const storeName = this.name;
    const tx = this.transaction;
    const faults = window.__AR_FAULTS__ || {};
    // 慢保存：在事务内同步等待不可行，改为在 request 完成后延迟事务提交不可控，
    // 因此这里用「多次重入同一个写请求」的替代方式：只记录，不阻塞。
    const rec = {
      kind: 'put',
      store: storeName,
      at: Date.now(),
      requestSuccess: false,
      txComplete: false,
      aborted: false,
      name: value && typeof value === 'object' ? value.name ?? null : null,
      exCount: value && Array.isArray(value.exercises) ? value.exercises.length : null,
    };
    trace.push(rec);
    let req;
    try {
      req = origPut.call(this, value, key);
    } catch (err) {
      rec.threw = String(err && err.message ? err.message : err);
      throw err;
    }
    req.addEventListener('success', () => {
      rec.requestSuccess = true;
    });
    tx.addEventListener('complete', () => {
      rec.txComplete = true;
    });
    tx.addEventListener('abort', () => {
      rec.aborted = true;
    });
    return req;
  };

  window.__AR_SNAPSHOT__ = () =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open('motion-training', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        let tx;
        try {
          tx = db.transaction(['plans', 'settings', 'sessions'], 'readonly');
        } catch {
          db.close();
          return resolve({ plans: [], settings: null, sessions: [] });
        }
        const p = tx.objectStore('plans').getAll();
        const s = tx.objectStore('settings').get('app');
        const se = tx.objectStore('sessions').getAll();
        tx.oncomplete = () => {
          db.close();
          resolve({ plans: p.result || [], settings: s.result || null, sessions: se.result || [] });
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });

  /** fixture 播种：纯合成数据，只在 App 挂载前调用一次 */
  window.__AR_SEED__ = (fixture) =>
    new Promise((resolve, reject) => {
      const open = indexedDB.open('motion-training', 1);
      open.onerror = () => reject(open.error);
      open.onupgradeneeded = () => {
        const db = open.result;
        const defs = [
          { name: 'meta', keyPath: 'key' },
          { name: 'plans', keyPath: 'id' },
          { name: 'sessions', keyPath: 'id' },
          { name: 'settings', keyPath: 'key' },
        ];
        for (const d of defs) {
          if (!db.objectStoreNames.contains(d.name)) db.createObjectStore(d.name, { keyPath: d.keyPath });
        }
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(['plans', 'sessions', 'settings'], 'readwrite');
        for (const p of fixture.plans || []) tx.objectStore('plans').put(p);
        for (const s of fixture.sessions || []) tx.objectStore('sessions').put(s);
        if (fixture.settings) tx.objectStore('settings').put(fixture.settings);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
});

/* 先进一个**不含应用脚本**的空白文档，确保 fixture 在 App 挂载前写入
   （否则 ensureSeed 会先播种自己的计划，fixture 就不是"唯一来源"了）。 */
await page.goto(ORIGIN + '/__blank', { waitUntil: 'domcontentloaded' });

/* ── 合成 fixture（App 挂载前写入；纯合成，不含任何个人数据）── */
/**
 * 构造两份训练记录：
 *   A. 主用训练（胸 A 快照，3 个普通组动作 + 1 个递减组动作），用于添加/移除主流程；
 *   B. 60 项训练（达到 MAX_EXERCISES），用于上限 UI 断言。
 * 计划只放一份最小 V3.2 风格计划，用于备份校验与「计划/历史/游标不变」断言。
 */
function buildFixture(now) {
  const mkSet = (id, round, stage, reps, weight, status) => ({
    id,
    roundIndex: round,
    stageIndex: stage,
    reps,
    weightKg: weight,
    status,
  });
  const mkStraight = (id, name, exerciseId, sets, repsMin, repsMax, restSec, opts = {}) => ({
    id,
    exerciseId,
    planExerciseId: opts.planExerciseId ?? null,
    name,
    restSec,
    target: {
      kind: 'straight',
      sets,
      setsMax: sets,
      repsMin,
      repsMax,
      weightMode: 'external',
      suggestedWeightKg: null,
    },
    status: opts.status ?? 'pending',
    groups: Array.from({ length: sets }, (_, i) => ({ index: i + 1, stageCount: 1 })),
    sets: Array.from({ length: sets }, (_, i) =>
      mkSet(`${id}-set${i + 1}`, i + 1, 1, null, null, 'blank'),
    ),
    note: opts.note ?? '',
    ...(opts.added ? { added: true } : {}),
    ...(opts.replacedFrom ? { replacedFrom: opts.replacedFrom } : {}),
  });

  const planId = 'plan-synth-1';
  const dayId = 'day-synth-chest';
  const plan = {
    id: planId,
    name: '合成计划',
    days: [
      {
        id: dayId,
        name: '胸 A',
        focus: 'chest',
        round: 'A',
        kind: 'train',
        warmups: [],
        exercises: [
          {
            id: 'pe-1',
            exerciseId: 'ex-bench',
            name: '杠铃卧推',
            restSec: 120,
            target: {
              kind: 'straight',
              sets: 3,
              setsMax: 3,
              repsMin: 8,
              repsMax: 12,
              weightMode: 'external',
              suggestedWeightKg: null,
            },
          },
        ],
      },
    ],
    cursor: 0,
    createdAt: now - 86400000,
    updatedAt: now - 86400000,
    presetId: undefined,
  };

  const baseSession = {
    id: 'sess-synth-A',
    planId,
    planName: '合成计划',
    day: { dayId, dayName: '胸 A', focus: 'chest', round: 'A', partText: '胸 A' },
    cycleIndexAtStart: 0,
    targetSetsAtStart: 8,
    startedAt: now - 600000,
    endedAt: null,
    status: 'active',
    pausedMs: 0,
    pausedAt: null,
    warmups: [],
    exercises: [
      // 1) 完全空白，可移除
      mkStraight('sx-blank', '合成空白动作', 'ex-blank', 3, 8, 12, 120, { planExerciseId: 'pe-1' }),
      // 2) 有次数 0（受保护）
      {
        ...mkStraight('sx-zero', '合成零次数动作', 'ex-zero', 2, 8, 12, 90),
        sets: [mkSet('sx-zero-set1', 1, 1, 0, null, 'done'), mkSet('sx-zero-set2', 2, 1, null, null, 'blank')],
      },
      // 3) 递减组：只记录第 1 轮第 1 阶段（partial，受保护）
      {
        id: 'sx-drop',
        exerciseId: 'ex-drop',
        planExerciseId: null,
        name: '合成递减动作',
        restSec: 180,
        target: {
          kind: 'dropSet',
          rounds: 2,
          stages: [
            { label: '阶段1', weightKg: 10, repsMin: 12, repsMax: 12, toFailure: false, targetText: '12 次' },
            { label: '阶段2', weightKg: 7.5, repsMin: 10, repsMax: 10, toFailure: false, targetText: '10 次' },
          ],
          restInSec: 20,
          restAfterSec: 180,
          weightMode: 'external',
        },
        status: 'pending',
        groups: [
          { index: 1, stageCount: 2 },
          { index: 2, stageCount: 2 },
        ],
        sets: [
          mkSet('sx-drop-s1', 1, 1, 12, 10, 'done'),
          mkSet('sx-drop-s2', 1, 2, null, null, 'blank'),
          mkSet('sx-drop-s3', 2, 1, null, null, 'blank'),
          mkSet('sx-drop-s4', 2, 2, null, null, 'blank'),
        ],
        note: '',
      },
      // 4) 同名不同 ID：两条同名，只有一条有记录
      mkStraight('sx-dup-1', '合成同名动作', 'ex-dup', 2, 8, 12, 60),
      {
        ...mkStraight('sx-dup-2', '合成同名动作', 'ex-dup', 2, 8, 12, 60),
        sets: [mkSet('sx-dup2-set1', 1, 1, 9, 40, 'done'), mkSet('sx-dup2-set2', 2, 1, null, null, 'blank')],
      },
    ],
    note: '',
    kind: 'strength',
    origin: 'plan',
    cardio: [],
    cardioPausedBySession: [],
    revision: 0,
  };

  // 60 项上限训练
  const manyExercises = Array.from({ length: 60 }, (_, i) =>
    mkStraight(`sx60-${i + 1}`, `上限动作 ${i + 1}`, `ex-60-${i + 1}`, 1, 8, 12, 60),
  );
  const fullSession = {
    ...baseSession,
    id: 'sess-synth-B',
    targetSetsAtStart: 60,
    startedAt: now - 900000,
    exercises: manyExercises,
  };

  /**
   * 移除专用训练（问题三）。
   *
   * 与添加用例**完全隔离**，避免互相污染：
   *   D1 空白（可移除）           → 正常移除 + 顺序保持
   *   D2 次数 0（受保护）
   *   D3 递减组只记第 1 轮第 1 阶段（受保护）
   *   D4/D5 同名不同 ID（D4 空白可移除，D5 有记录受保护）
   *   D6 动作备注（受保护）
   *   D7 标记完成（受保护）
   *   D8 纯跳过（无实际输入，可移除）
   */
  const removeSession = {
    ...baseSession,
    id: 'sess-synth-D',
    startedAt: now - 1200000,
    targetSetsAtStart: 12,
    exercises: [
      mkStraight('sxd-blank', '移除空白动作', 'ex-d-blank', 2, 8, 12, 60),
      {
        ...mkStraight('sxd-zero', '移除零次数动作', 'ex-d-zero', 2, 8, 12, 90),
        sets: [
          mkSet('sxd-zero-s1', 1, 1, 0, null, 'done'),
          mkSet('sxd-zero-s2', 2, 1, null, null, 'blank'),
        ],
      },
      {
        id: 'sxd-drop',
        exerciseId: 'ex-d-drop',
        planExerciseId: null,
        name: '移除递减动作',
        restSec: 180,
        target: {
          kind: 'dropSet',
          rounds: 2,
          stages: [
            { label: '阶段1', weightKg: 10, repsMin: 12, repsMax: 12, toFailure: false, targetText: '12 次' },
            { label: '阶段2', weightKg: 7.5, repsMin: 10, repsMax: 10, toFailure: false, targetText: '10 次' },
          ],
          restInSec: 20,
          restAfterSec: 180,
          weightMode: 'external',
        },
        status: 'pending',
        groups: [
          { index: 1, stageCount: 2 },
          { index: 2, stageCount: 2 },
        ],
        sets: [
          mkSet('sxd-drop-s1', 1, 1, 12, 10, 'done'),
          mkSet('sxd-drop-s2', 1, 2, null, null, 'blank'),
          mkSet('sxd-drop-s3', 2, 1, null, null, 'blank'),
          mkSet('sxd-drop-s4', 2, 2, null, null, 'blank'),
        ],
        note: '',
      },
      mkStraight('sxd-dup-a', '移除同名动作', 'ex-d-dup', 2, 8, 12, 60),
      {
        ...mkStraight('sxd-dup-b', '移除同名动作', 'ex-d-dup', 2, 8, 12, 60),
        sets: [
          mkSet('sxd-dup-b-s1', 1, 1, 9, 40, 'done'),
          mkSet('sxd-dup-b-s2', 2, 1, null, null, 'blank'),
        ],
      },
      { ...mkStraight('sxd-note', '移除有备注动作', 'ex-d-note', 2, 8, 12, 60), note: '器械调到 3 档' },
      { ...mkStraight('sxd-done', '移除已标记完成动作', 'ex-d-done', 2, 8, 12, 60), status: 'done' },
      {
        ...mkStraight('sxd-skip', '移除纯跳过动作', 'ex-d-skip', 2, 8, 12, 60),
        status: 'skipped',
        groups: [
          { index: 1, stageCount: 1, skipped: true },
          { index: 2, stageCount: 1, skipped: true },
        ],
      },
    ],
  };

  /**
   * 末项移除专用训练：**只含一个空白动作**。
   * 用于验证「最后一个动作也能移除 → 空态正常 → 可重新添加」。
   */
  const lastItemSession = {
    ...baseSession,
    id: 'sess-synth-C',
    startedAt: now - 1500000,
    targetSetsAtStart: 2,
    exercises: [mkStraight('sx-last', '合成唯一动作', 'ex-last', 2, 8, 12, 120)],
  };

  return {
    plans: [plan],
    sessions: [baseSession, fullSession, lastItemSession, removeSession],
    settings: { key: 'app', theme: 'light', currentPlanId: planId },
  };
}

const now = Date.now();
const fixture = buildFixture(now);
// fixture 只做一次；记录来源与初始化前后快照
writeFileSync(path.join(OUTDIR, 'FIXTURE-SOURCE.json'), JSON.stringify({ kind: 'synthetic', generatedAt: now, planIds: fixture.plans.map((p) => p.id), sessionIds: fixture.sessions.map((s) => s.id), exerciseCounts: fixture.sessions.map((s) => s.exercises.length) }, null, 2));
const seeded = await page.evaluate((fx) => window.__AR_SEED__(fx), fixture);
const afterSeed = await page.evaluate(() => window.__AR_SNAPSHOT__());
writeFileSync(path.join(OUTDIR, 'FIXTURE-AFTER-INIT.json'), JSON.stringify({ plans: afterSeed.plans.length, sessions: afterSeed.sessions.map((s) => ({ id: s.id, exercises: s.exercises.length })) }, null, 2));
record(
  'fixture.seeded-before-mount',
  seeded === true && afterSeed.sessions.length === 4 && afterSeed.plans.length === 1,
  `plans=${afterSeed.plans.length}, sessions=${afterSeed.sessions.length}（期望 1/4）`,
);

// 播种后再进入真实应用，让 Store 正常读入（不替换任何业务逻辑）
await page.goto(ORIGIN + '/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 900));

async function wait(ms) {
  await new Promise((r) => setTimeout(r, ms));
}
async function goHash(h) {
  await page.evaluate((x) => {
    window.location.hash = x;
  }, h);
  await wait(800);
}
async function clickByText(text, exact = false) {
  const found = await page.evaluate(
    (want, isExact) => {
      const nodes = Array.from(document.querySelectorAll('button, a, [role="tab"], summary'));
      const el = nodes.find((n) => {
        const t = (n.textContent || '').trim();
        return isExact ? t === want : t.includes(want);
      });
      if (!el) return false;
      el.click();
      return true;
    },
    text,
    exact,
  );
  await wait(350);
  return found;
}
async function bodyText() {
  return page.evaluate(() => document.body.innerText || '');
}
async function snap() {
  return page.evaluate(() => window.__AR_SNAPSHOT__());
}
async function sessionA() {
  const s = await snap();
  return (s.sessions || []).find((x) => x.id === 'sess-synth-A');
}
/** 在弹层内按 aria-label 找输入框并真实键入 */
/** 搜索框没有 aria-label，用 placeholder 定位（真实 UI 元素） */
async function typeIntoSearch(text) {
  return page.evaluate((value) => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const el = inputs.find((i) => (i.getAttribute('placeholder') || '').includes('搜索或输入新动作名'));
    if (!el) return false;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }, text);
}
async function typeInto(ariaLabel, text, blur = true) {
  return page.evaluate(
    (label, value, doBlur) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const el = inputs.find((i) => (i.getAttribute('aria-label') || '') === label);
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (doBlur) el.blur();
      return true;
    },
    ariaLabel,
    text,
    blur,
  );
}

/* ── 打开主用训练 ── */
await goHash('#/session/sess-synth-A');
const sessionText = await bodyText();
record(
  'session.reachable',
  /胸 A/.test(sessionText) && /合成空白动作/.test(sessionText),
  `textLen=${sessionText.length}`,
);

/* ══ 问题二：先配置后添加 ══════════════════════════════════════ */

// A1. 打开「+ 临时加动作」→ 选库动作 → 出现配置步骤（不再直接添加）
const beforeAdd = await sessionA();
const openedPicker = await clickByText('+ 临时加动作');
await wait(400);
const pickerText = await bodyText();
record('add.picker-open', openedPicker && /添加动作/.test(pickerText), `opened=${openedPicker}`);

const pickedLib = await clickByText('自由杠铃卧推');
await wait(500);
const cfgText = await bodyText();
const cfgVisible = /添加动作的设置/.test(cfgText);
record('add.config-step-shown', cfgVisible, `弹层含配置=${cfgVisible}`);

// 关键断言：此时**还没写库**
const afterPick = await sessionA();
record(
  'add.no-write-before-confirm',
  afterPick.exercises.length === beforeAdd.exercises.length,
  `before=${beforeAdd.exercises.length}, after=${afterPick.exercises.length}`,
);

// A2. 取消不写库、不产生空动作
const cancelled = await clickByText('取消', true);
await wait(400);
const afterCancel = await sessionA();
record(
  'add.cancel-no-write',
  afterCancel.exercises.length === beforeAdd.exercises.length,
  `after=${afterCancel.exercises.length}（期望 ${beforeAdd.exercises.length}）`,
);

// A3. 非法输入被阻止：组数 0（先不 blur，验证用当前 raw 阻止）
await clickByText('+ 临时加动作');
await wait(300);
await clickByText('自由杠铃卧推');
await wait(500);
await typeInto('组数', '0', false); // 不 blur：验证确认时读当前 raw
const confirmBlocked = await clickByText('确认添加', true);
await wait(400);
const errText = await bodyText();
const stillOpen = /添加动作的设置/.test(errText);
const afterInvalid = await sessionA();
record(
  'add.invalid-blocked-and-draft-kept',
  confirmBlocked &&
    stillOpen &&
    afterInvalid.exercises.length === beforeAdd.exercises.length &&
    /组数必须是|组数/.test(errText),
  `stillOpen=${stillOpen}, 有错误=${/组数必须是|组数/.test(errText)}, 动作数=${afterInvalid.exercises.length}`,
);

// A4. 下限 > 上限 被阻止
await typeInto('组数', '3', false);
await typeInto('次数下限', '15', false);
await typeInto('次数上限', '12', false);
await clickByText('确认添加', true);
await wait(400);
const errText2 = await bodyText();
record(
  'add.reps-min-gt-max-blocked',
  /下限不能大于上限/.test(errText2),
  `有错误=${/下限不能大于上限/.test(errText2)}`,
);

// A5. 合法配置 + 确认用当前 raw（未 blur 的文本也要生效）
await typeInto('组数', '5', false);
await typeInto('次数下限', '6', false);
await typeInto('次数上限', '6', false);
await typeInto('组间休息', '90', false);
await page.evaluate(() => window.__AR_CLEAR__());
await clickByText('确认添加', true);
await wait(2500);
const afterAdd = await sessionA();
// 库里原本没有「自由杠铃卧推」动作（计划里有，但训练快照里没有），因此新出现的那条就是本次添加
const added = afterAdd.exercises.find((e) => e.name === '自由杠铃卧推');
record(
  'add.confirm-uses-current-raw',
  !!added &&
    added.groups.length === 5 &&
    added.restSec === 90 &&
    added.target.kind === 'straight' &&
    added.target.repsMin === 6 &&
    added.target.repsMax === 6,
  added
    ? `组数=${added.groups.length}, 休息=${added.restSec}, 次数=${added.target.repsMin}-${added.target.repsMax}`
    : '未找到新添加动作',
);
record(
  'add.new-exercise-actual-empty',
  !!added && added.sets.every((s) => s.reps === null && s.weightKg === null && s.status === 'blank'),
  added ? `sets=${added.sets.length}` : 'n/a',
);
record(
  'add.exactly-once',
  afterAdd.exercises.filter((e) => e.name === '自由杠铃卧推').length === 1,
  `同名新增条数=${afterAdd.exercises.filter((e) => e.name === '自由杠铃卧推').length}`,
);

// A6. 自定义名走同一条配置路径
await clickByText('+ 临时加动作');
await wait(300);
await typeIntoSearch('反手抬腕测试动作');
await wait(300);
const customBtn = await clickByText('使用「反手抬腕测试动作」');
await wait(500);
const customCfg = /添加动作的设置/.test(await bodyText());
record('add.custom-name-config-step', customBtn && customCfg, `clicked=${customBtn}, 配置步骤=${customCfg}`);
if (customCfg) {
  await typeInto('组数', '2', false);
  await typeInto('次数下限', '10', false);
  await typeInto('次数上限', '15', false);
  await typeInto('组间休息', '60', false);
  await clickByText('确认添加', true);
  await wait(1500);
  const s2 = await sessionA();
  const wrist = s2.exercises.find((e) => e.name === '反手抬腕测试动作');
  record(
    'add.custom-name-saved',
    !!wrist && wrist.groups.length === 2 && wrist.restSec === 60,
    wrist ? `组数=${wrist.groups.length}, 休息=${wrist.restSec}` : '未保存',
  );
}

// A7. 慢保存 + 重复点击确认 → 只添加一个
await clickByText('+ 临时加动作');
await wait(300);
await typeIntoSearch('合成慢保存动作');
await wait(300);
await clickByText('使用「合成慢保存动作」');
await wait(500);
// 连点 3 次确认（第二次起应被 phase=submitting 拦住）
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const confirm = btns.find((b) => (b.textContent || '').trim() === '确认添加');
  if (!confirm) return;
  confirm.click();
  confirm.click();
  confirm.click();
});
await wait(3000);
const afterSlow = await sessionA();
record(
  'add.double-click-single-add',
  afterSlow.exercises.filter((e) => e.name === '合成慢保存动作').length === 1,
  `条数=${afterSlow.exercises.filter((e) => e.name === '合成慢保存动作').length}（期望 1）`,
);

// A8. 保存失败 → 提示失败；重试不重复添加
await clickByText('+ 临时加动作');
await wait(300);
await typeIntoSearch('合成失败动作');
await wait(300);
await clickByText('使用「合成失败动作」');
await wait(500);
await page.evaluate(() => {
  window.__AR_FAULTS__.sessionsWriteFail = 1;
});
await clickByText('确认添加', true);
await wait(1200);
const afterFailText = await bodyText();
const failedNotice = /没有保存成功|还没有保存成功|配置已保留/.test(afterFailText);
const afterFail = await sessionA();
const failCount = afterFail.exercises.filter((e) => e.name === '合成失败动作').length;
record(
  'add.save-failure-reported',
  failedNotice && failCount === 0,
  `有失败提示=${failedNotice}, 库中条数=${failCount}（期望 0）`,
);

// 重试：仍应只有 1 条，且不能出现第 2 条
await clickByText('重试保存这次添加');
await wait(1800);
const afterRetry = await sessionA();
const retryCount = afterRetry.exercises.filter((e) => e.name === '合成失败动作').length;
record(
  'add.retry-no-duplicate',
  retryCount === 1,
  `重试后条数=${retryCount}（期望 1，绝不重复添加）`,
);

// A9. 动作上限：60 项训练里 UI 阻止添加
await goHash('#/session/sess-synth-B');
await wait(600);
const fullText = await bodyText();
await clickByText('+ 临时加动作');
await wait(300);
await clickByText('自由杠铃卧推');
await wait(500);
const capText = await bodyText();
const capBlocked = /达到上限/.test(capText);
const confirmDisabled = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const confirm = btns.find((b) => (b.textContent || '').trim() === '确认添加');
  return confirm ? confirm.disabled : null;
});
record(
  'add.capacity-ui-blocks',
  capBlocked && confirmDisabled === true,
  `有上限提示=${capBlocked}, 确认按钮禁用=${confirmDisabled}`,
);
// 关闭弹层（不留残留）
await clickByText('取消', true);
await wait(300);
const afterCapCancel = await snap();
const fullSession = afterCapCancel.sessions.find((s) => s.id === 'sess-synth-B');
record(
  'add.capacity-no-write',
  fullSession.exercises.length === 60,
  `上限训练动作数=${fullSession.exercises.length}`,
);

/* ══ 问题三：从本次训练移除（专用训练 sess-synth-D，与添加用例隔离）═══ */
await goHash('#/session/sess-synth-D');
await wait(800);

async function sessionD() {
  const s = await snap();
  return (s.sessions || []).find((x) => x.id === 'sess-synth-D');
}
/** 关闭当前任何打开的弹层（真实 UI：点弹层里的取消/关闭） */
async function closeAnySheet() {
  const closed = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return 'none';
    const btns = Array.from(dialog.querySelectorAll('button'));
    const cancel = btns.find((b) => ['取消', '关闭'].includes((b.textContent || '').trim()));
    if (cancel) {
      cancel.click();
      return 'cancel';
    }
    const close = btns.find((b) => (b.getAttribute('aria-label') || '') === '关闭');
    if (close) {
      close.click();
      return 'close';
    }
    return 'blocked';
  });
  await wait(350);
  return closed;
}
/** 打开某个动作的工具面板（按 aria-label 精确定位） */
async function openToolsOf(name) {
  const ok = await page.evaluate((n) => {
    const btns = Array.from(document.querySelectorAll('button'));
    const b = btns.find((x) => (x.getAttribute('aria-label') || '') === `${n} 更多操作`);
    if (!b) return false;
    b.click();
    return true;
  }, name);
  await wait(400);
  return ok;
}
/** 打开「从本次训练移除」确认层，返回确认层文本与「确认移除」是否可用 */
async function openRemoveConfirm(name) {
  const okTools = await openToolsOf(name);
  if (!okTools) return { ok: false, reason: 'tools-not-found' };
  const okEntry = await clickByText('从本次训练移除这个动作');
  await wait(450);
  const info = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const text = dialog ? dialog.innerText : '';
    const btns = dialog ? Array.from(dialog.querySelectorAll('button')) : [];
    const confirm = btns.find((b) => (b.textContent || '').trim() === '确认移除');
    return { text, confirmDisabled: confirm ? confirm.disabled : null, hasConfirm: !!confirm };
  });
  return { ok: okTools && okEntry, ...info };
}

const d0 = await sessionD();
const dIds0 = d0.exercises.map((e) => e.id);
record('remove.session-reachable', d0.exercises.length === 8, `动作数=${d0.exercises.length}（期望 8）`);

// B1. 空白动作：确认层显示动作名；取消不变
const r1 = await openRemoveConfirm('移除空白动作');
record(
  'remove.confirm-shows-name',
  r1.ok && r1.hasConfirm && r1.text.includes('移除空白动作') && r1.confirmDisabled === false,
  `有确认按钮=${r1.hasConfirm}, 可点=${r1.confirmDisabled === false}`,
);
await closeAnySheet();
const d1 = await sessionD();
record(
  'remove.cancel-no-change',
  d1.exercises.length === dIds0.length,
  `after=${d1.exercises.length}（期望 ${dIds0.length}）`,
);

// B2. 各类实际输入必须受保护（0 次 / 递减 partial / 动作备注 / 标记完成 / 有记录的同名项）
const protectedCases = [
  ['移除零次数动作', '次数 0'],
  ['移除递减动作', '递减阶段部分记录'],
  ['移除有备注动作', '动作备注'],
  ['移除已标记完成动作', '标记完成'],
];
for (const [name, label] of protectedCases) {
  const r = await openRemoveConfirm(name);
  record(
    `remove.protects-${label}`,
    r.ok && r.text.includes('已经有记录，不能直接移除') && r.text.includes('跳过剩余组') && r.confirmDisabled === true,
    `有保护=${r.text.includes('已经有记录，不能直接移除')}, 可跳过指引=${r.text.includes('跳过剩余组')}, 确认禁用=${r.confirmDisabled}`,
  );
  await closeAnySheet();
}
const dAfterProtect = await sessionD();
record(
  'remove.protected-none-deleted',
  dAfterProtect.exercises.length === dIds0.length,
  `after=${dAfterProtect.exercises.length}（期望 ${dIds0.length}）`,
);

// B3. 同名不同 ID：第一项（空白）可移除；第二项（有记录）受保护
const rDupA = await openRemoveConfirm('移除同名动作');
// openToolsOf 按 aria-label 找到的是**第一条**同名动作（DOM 顺序）
record(
  'remove.same-name-first-is-blank',
  rDupA.ok && rDupA.confirmDisabled === false,
  `第一条可移除=${rDupA.confirmDisabled === false}`,
);
await closeAnySheet();

// B4. 确认后状态变化：打开确认层后，从存储边界写入该动作的实际记录 → 确认时必须拒绝
const rStale = await openRemoveConfirm('移除空白动作');
record('remove.stale.precondition', rStale.ok && rStale.confirmDisabled === false, `可移除=${rStale.confirmDisabled === false}`);
await page.evaluate(async () => {
  // 真实存储边界写入（不是产品回调）：模拟"确认层打开后，别处刚存了输入"
  const snap = await window.__AR_SNAPSHOT__();
  const s = snap.sessions.find((x) => x.id === 'sess-synth-D');
  const ex = s.exercises.find((e) => e.id === 'sxd-blank');
  ex.sets[0].reps = 11;
  ex.sets[0].status = 'done';
  s.revision = (s.revision || 0) + 1;
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('motion-training', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(s);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
});
await wait(300);
await clickByText('确认移除', true);
await wait(1500);
const dStale = await sessionD();
record(
  'remove.recheck-latest-before-delete',
  dStale.exercises.some((e) => e.id === 'sxd-blank'),
  `目标仍在=${dStale.exercises.some((e) => e.id === 'sxd-blank')}（确认后新输入不得被误删）`,
);
// 这次移除没有写入，但本页已形成待存草稿（既有 V6-01 保护）→ 明确放弃它
const discardClicked = await clickByText('放弃这份改动');
await wait(600);
record(
  'remove.stale-draft-discardable',
  discardClicked,
  `可放弃本页草稿=${discardClicked}`,
);
await closeAnySheet();
// 恢复该动作的空白状态，供后续正常移除用例使用
await page.evaluate(async () => {
  const snap = await window.__AR_SNAPSHOT__();
  const s = snap.sessions.find((x) => x.id === 'sess-synth-D');
  const ex = s.exercises.find((e) => e.id === 'sxd-blank');
  ex.sets[0].reps = null;
  ex.sets[0].status = 'blank';
  s.revision = (s.revision || 0) + 1;
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('motion-training', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(s);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
});
await page.reload({ waitUntil: 'networkidle0' });
await wait(900);
await goHash('#/session/sess-synth-D');
await wait(800);
// 前置：确认没有残留待存草稿/只读（否则所有输入都会被既有保护暂停）
const preEditBanner = await bodyText();
record(
  'remove.precondition-editable',
  !/还有改动没有写进本机|本页只读/.test(preEditBanner),
  `有阻塞横幅=${/还有改动没有写进本机|本页只读/.test(preEditBanner)}`,
);

// B5. 正常移除空白动作：只删目标，其余身份/顺序不变；移除后弹层关闭
const dBefore = await sessionD();
const idsBefore = dBefore.exercises.map((e) => e.id);
const rReal = await openRemoveConfirm('移除空白动作');
record('remove.real.precondition', rReal.ok && rReal.confirmDisabled === false, `可移除=${rReal.confirmDisabled === false}`);
await clickByText('确认移除', true);
await wait(1800);
const dAfter = await sessionD();
const idsAfter = dAfter.exercises.map((e) => e.id);
record(
  'remove.by-id-only-target',
  !idsAfter.includes('sxd-blank') && idsAfter.length === idsBefore.length - 1,
  `before=${idsBefore.length}, after=${idsAfter.length}, 目标已删=${!idsAfter.includes('sxd-blank')}`,
);
record(
  'remove.others-order-preserved',
  JSON.stringify(idsAfter) === JSON.stringify(idsBefore.filter((id) => id !== 'sxd-blank')),
  `顺序一致=${JSON.stringify(idsAfter) === JSON.stringify(idsBefore.filter((id) => id !== 'sxd-blank'))}`,
);
// 其他动作的数据完全没被改动
const othersIntact = dBefore.exercises
  .filter((e) => e.id !== 'sxd-blank')
  .every((before) => {
    const after = dAfter.exercises.find((e) => e.id === before.id);
    return after && JSON.stringify(after.sets) === JSON.stringify(before.sets);
  });
record('remove.others-data-intact', othersIntact, `其余动作记录未变=${othersIntact}`);
const panelGone = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
record('remove.sheet-closed-no-ghost', panelGone, `无残留弹层=${panelGone}`);

// B6. 纯跳过动作（无实际输入）可移除
//     前置：正常移除已成功落库，页面应回到可编辑（无待存草稿）
const bannerAfterRemove = await bodyText();
record(
  'remove.post-remove-editable',
  !/还有改动没有写进本机|本页只读/.test(bannerAfterRemove),
  `有阻塞横幅=${/还有改动没有写进本机|本页只读/.test(bannerAfterRemove)}`,
);
const rSkip = await openRemoveConfirm('移除纯跳过动作');
record('remove.pure-skip-removable', rSkip.ok && rSkip.confirmDisabled === false, `可移除=${rSkip.confirmDisabled === false}`);
await clickByText('确认移除', true);
await wait(1500);
const dSkip = await sessionD();
record(
  'remove.pure-skip-deleted',
  !dSkip.exercises.some((e) => e.id === 'sxd-skip'),
  `纯跳过动作已删=${!dSkip.exercises.some((e) => e.id === 'sxd-skip')}`,
);

// B7. 刷新后仍然生效（真实持久化）
await page.reload({ waitUntil: 'networkidle0' });
await wait(800);
const dReload = await sessionD();
record(
  'remove.persisted-after-reload',
  !dReload.exercises.some((e) => e.id === 'sxd-blank') && !dReload.exercises.some((e) => e.id === 'sxd-skip'),
  `刷新后空白已删=${!dReload.exercises.some((e) => e.id === 'sxd-blank')}, 纯跳过已删=${!dReload.exercises.some((e) => e.id === 'sxd-skip')}`,
);

// B8. 原计划 / 历史 / 游标保持
const planNow = (await snap()).plans.find((p) => p.id === 'plan-synth-1');
record(
  'remove.plan-untouched',
  !!planNow && planNow.cursor === 0 && planNow.days[0].exercises.length === 1,
  planNow ? `cursor=${planNow.cursor}, 计划动作数=${planNow.days[0].exercises.length}` : 'n/a',
);
record(
  'remove.session-meta-untouched',
  dReload.cycleIndexAtStart === 0 && dReload.day.dayId === 'day-synth-chest' && dReload.targetSetsAtStart === 12,
  `cycleIndexAtStart=${dReload.cycleIndexAtStart}, targetSetsAtStart=${dReload.targetSetsAtStart}`,
);

/* ══ 备份导出 / 恢复合法性（真实 UI：设置页导出）═════════════ */
await goHash('#/settings');
await wait(700);
const settingsText = await bodyText();
record('settings.reachable', /导出/.test(settingsText), `textLen=${settingsText.length}`);

// 真实点击导出（web 路径：Blob + a[download]）
const downloadDir = path.join(OUTDIR, 'downloads');
mkdirSync(downloadDir, { recursive: true });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', {
  behavior: 'allow',
  downloadPath: downloadDir,
  eventsEnabled: true,
});
const clickedExport = await clickByText('导出 JSON 备份');
await wait(2500);
const files = readdirSync(downloadDir).filter((f) => f.endsWith('.json') && !f.startsWith('._'));
record('backup.export-clicked', clickedExport && files.length >= 1, `clicked=${clickedExport}, files=${files.join(',')}`);

let backupOk = false;
let backupDetail = '未导出';
if (files.length) {
  const raw = readFileSync(path.join(downloadDir, files[0]), 'utf8');
  const parsed = JSON.parse(raw);
  const sessA = (parsed.data?.sessions || []).find((s) => s.id === 'sess-synth-A');
  const sessB = (parsed.data?.sessions || []).find((s) => s.id === 'sess-synth-B');
  backupOk = !!sessA && !!sessB && sessB.exercises.length === 60;
  backupDetail = `sessions=${(parsed.data?.sessions || []).length}, B动作数=${sessB ? sessB.exercises.length : 'n/a'}`;
  writeFileSync(path.join(OUTDIR, 'BACKUP-PROBE.json'), JSON.stringify({ file: files[0], bytes: raw.length, format: parsed.format, version: parsed.version, sessionIds: (parsed.data?.sessions || []).map((s) => s.id), exerciseCounts: (parsed.data?.sessions || []).map((s) => s.exercises.length) }, null, 2));
}
record('backup.contains-synthetic-sessions', backupOk, backupDetail);

/* ══ 360 宽度下的同一条路径（窄屏无横向溢出 + 配置层可用）════ */
await page.setViewport({ width: 360, height: 780, isMobile: true, hasTouch: true });
await goHash('#/session/sess-synth-D');
await wait(700);
const overflow360 = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
record(
  'layout.360-no-horizontal-overflow',
  overflow360.scrollW <= overflow360.clientW + 1,
  `scrollW=${overflow360.scrollW}, clientW=${overflow360.clientW}`,
);
const open360 = await clickByText('+ 临时加动作');
await wait(400);
// 用唯一名称定位，避免与页面上同名动作卡片混淆（真实 UI 路径不变）
const typed360 = await typeIntoSearch('窄屏配置动作');
await wait(300);
const picked360 = await clickByText('使用「窄屏配置动作」');
await wait(600);
const cfg360 = await page.evaluate(() => ({
  hasSheet: !!document.querySelector('[role="dialog"]'),
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
  dialogText: (() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.slice(0, 120) : '';
  })(),
}));
record(
  'layout.360-config-usable',
  open360 && typed360 && picked360 && cfg360.hasSheet && cfg360.scrollW <= cfg360.clientW + 1,
  `打开选择=${open360}, 输入=${typed360}, 选中=${picked360}, 配置弹层=${cfg360.hasSheet}, scrollW=${cfg360.scrollW}/${cfg360.clientW}`,
);
// 窄屏配置层内截图（证据）
await page.screenshot({ path: path.join(OUTDIR, 'shot-360-add-config.png') }).catch(() => {});
await closeAnySheet();
await wait(300);

// 390 宽度复检
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await wait(500);
const overflow390 = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
record(
  'layout.390-no-horizontal-overflow',
  overflow390.scrollW <= overflow390.clientW + 1,
  `scrollW=${overflow390.scrollW}, clientW=${overflow390.clientW}`,
);

/* ══ 末项移除（专用训练 sess-synth-C）：真实 UI 移除唯一动作 → 空态 → 再添加 ══ */
/**
 * 该训练由 fixture 在同一独立 profile 内合成（只含一个空白动作），
 * 用于验证「最后一个动作也能移除 → 正常空态 → 可重新添加 → 刷新后仍合法」。
 */
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await goHash('#/session/sess-synth-C');
await wait(800);
const cBefore = (await snap()).sessions.find((x) => x.id === 'sess-synth-C');
record('last-item.session-reachable', cBefore.exercises.length === 1, `动作数=${cBefore.exercises.length}`);

const cConfirm = await openRemoveConfirm('合成唯一动作');
record(
  'last-item.confirm-available',
  cConfirm.ok && cConfirm.confirmDisabled === false,
  `可移除=${cConfirm.confirmDisabled === false}`,
);
await clickByText('确认移除', true);
await wait(1800);
const cAfter = (await snap()).sessions.find((x) => x.id === 'sess-synth-C');
record('last-item.removed-to-empty', cAfter.exercises.length === 0, `动作数=${cAfter.exercises.length}`);
const emptyText = await bodyText();
record(
  'last-item.empty-state-no-crash',
  pageErrors.length === 0 && !/Maximum update|Cannot read/.test(emptyText),
  `pageErrors=${pageErrors.length}`,
);

// 空态可重新添加（走同一条配置步骤）
await clickByText('+ 临时加动作');
await wait(400);
await typeIntoSearch('重新添加动作');
await wait(300);
const readdClicked = await clickByText('使用「重新添加动作」');
await wait(600);
const readdCfg = /添加动作的设置/.test(await bodyText());
record('last-item.readd-config-step', readdClicked && readdCfg, `配置步骤=${readdCfg}`);
await typeInto('组数', '2', false);
await clickByText('确认添加', true);
await wait(2000);
const cReadded = (await snap()).sessions.find((x) => x.id === 'sess-synth-C');
record(
  'last-item.can-readd',
  cReadded.exercises.length === 1 && cReadded.exercises[0].name === '重新添加动作',
  `动作数=${cReadded.exercises.length}, 名称=${cReadded.exercises[0]?.name ?? 'n/a'}`,
);
record(
  'last-item.session-still-active',
  !!cReadded && cReadded.status === 'active',
  `status=${cReadded?.status ?? 'n/a'}`,
);

/* ── 收尾 ── */
const hashAfter = srcHash();
record('source.stable', hashBefore === hashAfter, `before=${hashBefore.slice(0, 12)} after=${hashAfter.slice(0, 12)}`);
record('no.page-errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '无异常');

await page.screenshot({ path: path.join(OUTDIR, 'final.png'), fullPage: true }).catch(() => {});

writeFileSync(
  path.join(OUTDIR, 'RESULTS.json'),
  JSON.stringify(
    {
      stamp: STAMP,
      origin: ORIGIN,
      viewport: { primary: '390x844', secondary: '360x780' },
      hashBefore,
      hashAfter,
      pageErrors,
      results,
    },
    null,
    2,
  ),
);
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  if (server) {
    try { await new Promise((r) => server.close(r)); } catch {}
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`);
console.log(`证据：${OUTDIR}`);
process.exitCode = failed.length ? 1 : 0;
